import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGE_SIZE = 200;
const DEFAULT_MAX_SEARCH_ENTRIES = 20_000;
const DEFAULT_MAX_SEARCH_RESULTS = 5_000;
const NATURAL_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts"]);
const HIDDEN_NAMES = new Set([
  ".git",
  ".codex-desktop",
  ".codex-runtime",
  ".codex-uploads",
  ".codex-trash",
  "node_modules",
]);

export const MAP_PROJECT_RESOURCE_KINDS = Object.freeze([
  "map",
  "world",
  "tileset",
  "project",
  "template",
  "character",
  "image",
  "audio",
  "html",
  "stylesheet",
  "script",
  "automapping",
  "other",
]);

export class MapProjectCatalogError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectCatalogError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class MapProjectCatalog {
  constructor(options = {}) {
    this.defaultPageSize = positiveInteger(options.defaultPageSize, DEFAULT_PAGE_SIZE, "defaultPageSize");
    this.maxPageSize = positiveInteger(options.maxPageSize, DEFAULT_MAX_PAGE_SIZE, "maxPageSize");
    this.maxSearchEntries = positiveInteger(
      options.maxSearchEntries,
      DEFAULT_MAX_SEARCH_ENTRIES,
      "maxSearchEntries",
    );
    this.maxSearchResults = positiveInteger(
      options.maxSearchResults,
      DEFAULT_MAX_SEARCH_RESULTS,
      "maxSearchResults",
    );
    if (this.defaultPageSize > this.maxPageSize) {
      throw new TypeError("defaultPageSize must not exceed maxPageSize");
    }
  }

  async list(input = {}) {
    const context = await normalizeContext(input);
    const directory = normalizeRelativePath(input.directory, { allowRoot: true });
    assertBrowsableDirectory(context, directory);
    const kinds = normalizeKinds(input.kinds);
    const limit = pageSize(input.limit, this.defaultPageSize, this.maxPageSize);
    const after = decodeCursor(input.cursor, { scope: "tree", directory, kinds });
    const directoryPath = await requireSafePath(context.projectPath, directory, "directory");
    const entries = [];
    let dirents;
    try {
      dirents = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw fileError(error, "无法读取地图项目目录");
    }
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name) || dirent.isSymbolicLink()) continue;
      const relativePath = directory ? `${directory}/${dirent.name}` : dirent.name;
      const isDirectory = dirent.isDirectory();
      if (!isDirectory && !dirent.isFile()) continue;
      if (!pathVisibleInContext(context, relativePath, isDirectory)) continue;
      const kind = isDirectory ? "directory" : resourceKind(relativePath);
      if (!isDirectory && kinds.length && !kinds.includes(kind)) continue;
      const stat = await safeEntryStat(directoryPath, dirent);
      if (!stat) continue;
      entries.push(projectEntry(relativePath, kind, stat));
    }
    entries.sort(compareEntries);
    const start = after ? firstAfter(entries, after) : 0;
    const page = entries.slice(start, start + limit);
    const hasMore = start + page.length < entries.length;
    return Object.freeze({
      directory,
      kinds: Object.freeze(kinds),
      entries: Object.freeze(page),
      nextCursor: hasMore
        ? encodeCursor({ scope: "tree", directory, kinds, after: entryCursor(page.at(-1)) })
        : null,
    });
  }

  async search(input = {}) {
    const context = await normalizeContext(input);
    const query = normalizeQuery(input.query);
    const kinds = normalizeKinds(input.kinds);
    const limit = pageSize(input.limit, this.defaultPageSize, this.maxPageSize);
    const after = decodeCursor(input.cursor, { scope: "search", query, kinds });
    const { entries, scanned, truncated } = await scanSearch(context, query, kinds, {
      maxEntries: this.maxSearchEntries,
      maxResults: this.maxSearchResults,
    });
    entries.sort(compareEntries);
    const start = after ? firstAfter(entries, after) : 0;
    const page = entries.slice(start, start + limit);
    const hasMore = start + page.length < entries.length;
    return Object.freeze({
      query,
      kinds: Object.freeze(kinds),
      entries: Object.freeze(page),
      nextCursor: hasMore
        ? encodeCursor({ scope: "search", query, kinds, after: entryCursor(page.at(-1)) })
        : null,
      scanned,
      truncated,
    });
  }
}

async function scanSearch(context, query, kinds, limits) {
  const entries = [];
  let scanned = 0;
  let truncated = false;
  const roots = compactRoots(context.resourceRoots);
  const pending = [...roots].sort(compareText).reverse();
  const projectFile = context.projectFile;
  if (projectFile && !roots.some((root) => isWithinRelativeRoot(root, projectFile))) {
    pending.push(projectFile);
  }
  while (pending.length) {
    if (scanned >= limits.maxEntries || entries.length >= limits.maxResults) {
      truncated = true;
      break;
    }
    const relativePath = pending.pop();
    let stat;
    try {
      stat = await safeRelativeStat(context.projectPath, relativePath);
    } catch (error) {
      if (error?.statusCode === 404) continue;
      throw error;
    }
    if (!stat) continue;
    scanned += 1;
    if (stat.isDirectory()) {
      let dirents;
      try {
        dirents = await fs.readdir(path.join(context.projectPath, ...relativeSegments(relativePath)), {
          withFileTypes: true,
        });
      } catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
        throw fileError(error, "无法搜索地图项目目录");
      }
      const children = dirents
        .filter((entry) => !isHiddenName(entry.name) && !entry.isSymbolicLink())
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => (relativePath ? `${relativePath}/${entry.name}` : entry.name))
        .sort(compareText)
        .reverse();
      pending.push(...children);
    }
    const kind = stat.isDirectory() ? "directory" : resourceKind(relativePath);
    if (kind !== "directory" && kinds.length && !kinds.includes(kind)) continue;
    if (relativePath.toLocaleLowerCase("zh-CN").includes(query)) {
      entries.push(projectEntry(relativePath, kind, stat));
    }
  }
  return { entries, scanned, truncated };
}

async function normalizeContext(input) {
  const projectPath = await resolveProjectRoot(input.projectPath);
  const resourceRoots = normalizeRoots(input.resourceRoots);
  const projectFile = input.projectFile == null ? null : normalizeRelativePath(input.projectFile);
  return Object.freeze({ projectPath, resourceRoots, projectFile });
}

async function resolveProjectRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw catalogError(400, "invalid-map-project-catalog-root", "地图项目目录无效");
  }
  try {
    const resolved = path.resolve(value);
    const [realPath, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== resolved) {
      throw catalogError(403, "map-project-catalog-symlink", "地图项目目录不能是符号链接");
    }
    return realPath;
  } catch (error) {
    if (error instanceof MapProjectCatalogError) throw error;
    throw fileError(error, "地图项目目录不存在", "invalid-map-project-catalog-root");
  }
}

function normalizeRoots(value) {
  if (!Array.isArray(value) || value.length > 128) {
    throw catalogError(400, "invalid-map-project-roots", "地图项目 folders 范围无效");
  }
  const roots = value.map((entry) => normalizeRelativePath(entry, { allowRoot: true }));
  return Object.freeze(compactRoots(roots));
}

function compactRoots(roots) {
  const sorted = [...new Set(roots)].sort((left, right) => (
    left.split("/").length - right.split("/").length || compareText(left, right)
  ));
  return sorted.filter((candidate, index) => (
    !sorted.slice(0, index).some((root) => isWithinRelativeRoot(root, candidate))
  ));
}

function assertBrowsableDirectory(context, directory) {
  if (directory === "") return;
  if (!pathVisibleInContext(context, directory, true)) {
    throw catalogError(403, "map-project-directory-outside-folders", "目录不在 Tiled 项目的 folders 范围内");
  }
}

function pathVisibleInContext(context, relativePath, isDirectory) {
  if (context.resourceRoots.some((root) => (
    isWithinRelativeRoot(root, relativePath) || (isDirectory && isAncestorRelativePath(relativePath, root))
  ))) return true;
  return Boolean(context.projectFile && (
    relativePath === context.projectFile
    || (isDirectory && isAncestorRelativePath(relativePath, context.projectFile))
  ));
}

async function requireSafePath(projectPath, relativePath, expectedType) {
  const candidate = path.join(projectPath, ...relativeSegments(relativePath));
  let current = projectPath;
  for (const segment of relativeSegments(relativePath)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      throw fileError(error, "地图项目资源不存在");
    }
    if (stat.isSymbolicLink()) {
      throw catalogError(403, "map-project-resource-symlink", "符号链接不能作为地图项目资源");
    }
  }
  let realPath;
  try {
    realPath = await fs.realpath(candidate);
  } catch (error) {
    throw fileError(error, "地图项目资源不存在");
  }
  if (realPath !== candidate || !isWithin(projectPath, realPath)) {
    throw catalogError(403, "map-project-resource-symlink", "符号链接不能作为地图项目资源");
  }
  const stat = await fs.stat(realPath);
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw catalogError(400, "map-project-resource-not-directory", "地图项目目录无效");
  }
  return realPath;
}

async function safeRelativeStat(projectPath, relativePath) {
  try {
    const targetPath = await requireSafePath(projectPath, relativePath, null);
    return fs.stat(targetPath);
  } catch (error) {
    if (error?.statusCode === 404) return null;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function safeEntryStat(directoryPath, dirent) {
  try {
    const stat = await fs.lstat(path.join(directoryPath, dirent.name));
    if (stat.isSymbolicLink()) return null;
    if (dirent.isDirectory() !== stat.isDirectory() || dirent.isFile() !== stat.isFile()) return null;
    return stat;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fileError(error, "无法读取地图项目资源信息");
  }
}

function projectEntry(relativePath, kind, stat) {
  return Object.freeze({
    path: relativePath,
    name: path.posix.basename(relativePath),
    kind,
    size: kind === "directory" ? null : stat.size,
    modifiedAt: stat.mtimeMs,
  });
}

function resourceKind(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const name = path.posix.basename(relativePath).toLowerCase();
  if (extension === ".tmj") return "map";
  if (extension === ".world") return "world";
  if (extension === ".tsj") return "tileset";
  if (extension === ".tiled-project") return "project";
  if (extension === ".tx") return "template";
  if (name.endsWith(".character.json")) return "character";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".css") return "stylesheet";
  if (SCRIPT_EXTENSIONS.has(extension)) return "script";
  if (name === "rules.txt") return "automapping";
  return "other";
}

function normalizeKinds(value) {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  if (!raw.length || raw.length > MAP_PROJECT_RESOURCE_KINDS.length) {
    throw catalogError(400, "invalid-map-project-kinds", "地图项目资源分类筛选无效");
  }
  const kinds = [...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))].sort(compareText);
  if (!kinds.length || kinds.some((kind) => !MAP_PROJECT_RESOURCE_KINDS.includes(kind))) {
    throw catalogError(400, "invalid-map-project-kinds", "地图项目资源分类筛选无效");
  }
  return kinds;
}

function normalizeQuery(value) {
  if (typeof value !== "string") {
    throw catalogError(400, "invalid-map-project-query", "地图项目搜索词无效");
  }
  const query = value.trim().toLocaleLowerCase("zh-CN");
  if (query.length < 2 || query.length > 100) {
    throw catalogError(400, "invalid-map-project-query", "地图项目搜索词必须包含 2 到 100 个字符");
  }
  return query;
}

function normalizeRelativePath(value, options = {}) {
  if (options.allowRoot && (value === undefined || value === null || value === "" || value === ".")) return "";
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) throw catalogError(400, "invalid-map-project-path", "地图项目资源必须使用工程相对路径");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isHiddenName(segment))) {
    throw catalogError(400, "invalid-map-project-path", "地图项目资源路径无效");
  }
  return segments.join("/");
}

function compareEntries(left, right) {
  if (left.kind === "directory" && right.kind !== "directory") return -1;
  if (left.kind !== "directory" && right.kind === "directory") return 1;
  return compareText(left.name, right.name) || compareText(left.path, right.path);
}

function entryCursor(entry) {
  return Object.freeze({ directory: entry.kind === "directory", name: entry.name, path: entry.path });
}

function compareEntryCursor(entry, cursor) {
  if ((entry.kind === "directory") !== cursor.directory) return entry.kind === "directory" ? -1 : 1;
  return compareText(entry.name, cursor.name) || compareText(entry.path, cursor.path);
}

function firstAfter(entries, cursor) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareEntryCursor(entries[middle], cursor) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(value, expected) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || !/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw catalogError(400, "invalid-map-project-cursor", "地图项目分页游标无效");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      decoded?.v !== 1
      || decoded.scope !== expected.scope
      || decoded.directory !== expected.directory
      || decoded.query !== expected.query
      || JSON.stringify(decoded.kinds) !== JSON.stringify(expected.kinds)
      || typeof decoded.after?.directory !== "boolean"
      || typeof decoded.after?.name !== "string"
      || typeof decoded.after?.path !== "string"
    ) throw new Error("cursor context mismatch");
    return decoded.after;
  } catch (error) {
    throw catalogError(400, "invalid-map-project-cursor", "地图项目分页游标无效", error);
  }
}

function pageSize(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw catalogError(400, "invalid-map-project-limit", `地图项目分页数量必须在 1 到 ${maximum} 之间`);
  }
  return value;
}

function relativeSegments(value) {
  return value ? value.split("/") : [];
}

function isWithinRelativeRoot(root, candidate) {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}

function isAncestorRelativePath(candidate, descendant) {
  return candidate === "" || descendant.startsWith(`${candidate}/`);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isHiddenName(value) {
  return typeof value === "string" && (value.startsWith(".") || HIDDEN_NAMES.has(value));
}

function compareText(left, right) {
  return NATURAL_COLLATOR.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function fileError(error, message, code = "map-project-resource-not-found") {
  if (error instanceof MapProjectCatalogError) return error;
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return catalogError(404, code, message, error);
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return catalogError(403, "map-project-resource-forbidden", "没有权限读取地图项目资源", error);
  }
  return catalogError(500, "map-project-catalog-io-error", message, error);
}

function catalogError(statusCode, code, message, cause = null) {
  return new MapProjectCatalogError(statusCode, code, message, cause);
}
