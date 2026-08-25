import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { inspectImageBuffer } from "./image-file.mjs";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGE_SIZE = 200;
const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TILESET_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  [".png", "png"],
  [".jpg", "jpeg"],
  [".jpeg", "jpeg"],
  [".webp", "webp"],
]);

export class MapResourceCatalogError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapResourceCatalogError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class MapResourceCatalog {
  constructor(options = {}) {
    this.defaultPageSize = positiveInteger(options.defaultPageSize, DEFAULT_PAGE_SIZE, "defaultPageSize");
    this.maxPageSize = positiveInteger(options.maxPageSize, DEFAULT_MAX_PAGE_SIZE, "maxPageSize");
    if (this.defaultPageSize > this.maxPageSize) {
      throw new TypeError("defaultPageSize must not exceed maxPageSize");
    }
    this.maxImageBytes = positiveInteger(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES, "maxImageBytes");
    this.maxTilesetBytes = positiveInteger(
      options.maxTilesetBytes,
      DEFAULT_MAX_TILESET_BYTES,
      "maxTilesetBytes",
    );
    this.maxImageWidth = optionalPositiveInteger(options.maxImageWidth, "maxImageWidth");
    this.maxImageHeight = optionalPositiveInteger(options.maxImageHeight, "maxImageHeight");
    this.maxImagePixels = optionalPositiveInteger(options.maxImagePixels, "maxImagePixels");
  }

  async list(input = {}) {
    const projectRoot = await resolveProjectRoot(input.projectPath);
    const directory = normalizeRelativePath(input.directory, { allowRoot: true });
    const limit = pageSize(input.limit, this.defaultPageSize, this.maxPageSize);
    const after = decodeCursor(input.cursor, directory);
    const directoryPath = await requireSafePath(projectRoot, directory, "directory");
    let dirents;
    try {
      dirents = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw translateFileError(error, "无法读取地图素材目录");
    }

    const candidates = [];
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name) || dirent.isSymbolicLink()) continue;
      const kind = dirent.isDirectory()
        ? "directory"
        : dirent.isFile()
          ? resourceKind(dirent.name)
          : null;
      if (!kind) continue;
      const relativePath = directory ? `${directory}/${dirent.name}` : dirent.name;
      candidates.push({
        path: relativePath,
        name: dirent.name,
        kind,
        _sortKey: `${kind === "directory" ? "0" : "1"}\0${dirent.name}`,
      });
    }
    candidates.sort((left, right) => compareText(left._sortKey, right._sortKey));
    const start = after === null ? 0 : firstAfter(candidates, after);
    const page = [];
    let hasMore = false;
    for (let index = start; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      let stat;
      try {
        stat = await fs.lstat(path.join(directoryPath, candidate.name));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw translateFileError(error, "无法读取地图素材信息");
      }
      if (stat.isSymbolicLink()) continue;
      if ((candidate.kind === "directory" && !stat.isDirectory()) || (candidate.kind !== "directory" && !stat.isFile())) continue;
      if (page.length >= limit) {
        hasMore = true;
        break;
      }
      page.push({
        ...candidate,
        size: candidate.kind === "directory" ? null : stat.size,
        mtime: stat.mtimeMs,
      });
    }
    return {
      directory,
      entries: page.map(({ _sortKey, ...entry }) => entry),
      nextCursor: hasMore ? encodeCursor(directory, page.at(-1)._sortKey) : null,
    };
  }

  async inspect(input = {}) {
    const projectRoot = await resolveProjectRoot(input.projectPath);
    const resourcePath = normalizeRelativePath(input.resourcePath);
    const kind = resourceKind(resourcePath);
    if (!kind) throw catalogError(415, "map-resource-unsupported", "不支持这种地图素材文件");
    const targetPath = await requireSafePath(projectRoot, resourcePath, "file");
    const maxBytes = kind === "image" ? this.maxImageBytes : this.maxTilesetBytes;
    const opened = await openStableFile(targetPath, maxBytes);
    let inspected;
    if (kind === "image") {
      inspected = await inspectImage(opened.buffer, resourcePath, this);
    } else {
      const tileset = inspectTileset(opened.buffer);
      const dependencies = [];
      for (const dependencyPath of tilesetImageDependencies(tileset.document, resourcePath)) {
        if (resourceKind(dependencyPath) !== "image") {
          throw catalogError(415, "invalid-map-tileset-image", "瓦片集依赖必须是受支持的图片");
        }
        const dependency = await this.inspect({
          projectPath: projectRoot,
          resourcePath: dependencyPath,
          includeHash: input.includeHash === true,
        });
        if (dependency.kind !== "image") {
          throw catalogError(415, "invalid-map-tileset-image", "瓦片集依赖必须是受支持的图片");
        }
        dependencies.push(dependency);
      }
      inspected = {
        mediaType: "application/json",
        tiledType: "tileset",
        dependencies: Object.freeze(dependencies),
      };
    }
    const result = {
      path: resourcePath,
      name: path.posix.basename(resourcePath),
      kind,
      size: opened.stat.size,
      mtime: opened.stat.mtimeMs,
      ...inspected,
    };
    // Keep filesystem identity available to the in-memory asset index without
    // exposing device/inode details in the public resource contract.  Size and
    // mtime alone can be restored by a caller after rewriting a file, which
    // would otherwise let the cache return a stale content hash.
    Object.defineProperty(result, "_cacheIdentity", {
      value: cacheIdentity(opened.stat),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    // Hashing is opt-in because directory browsing and ordinary authorization
    // should not read every resource into memory solely to calculate identity.
    if (input.includeHash === true) {
      result.sha256 = crypto.createHash("sha256").update(opened.buffer).digest("hex");
    }
    return Object.freeze(result);
  }

  async grant(input = {}) {
    const resource = await this.inspect(input);
    if (input.expectedKind !== undefined && input.expectedKind !== resource.kind) {
      throw catalogError(415, "map-resource-kind-mismatch", "地图素材类型与请求不匹配");
    }
    return resource;
  }
}

export async function listMapResourceDirectory(input, options = {}) {
  return new MapResourceCatalog(options).list(input);
}

export async function inspectMapResource(input, options = {}) {
  return new MapResourceCatalog(options).inspect(input);
}

export async function grantMapResource(input, options = {}) {
  return new MapResourceCatalog(options).grant(input);
}

/**
 * Content-addressed metadata cache for map assets.
 *
 * The catalog remains the authority for path, type and size validation. This
 * layer only adds a bounded in-memory index keyed by project + relative path;
 * it never exposes absolute paths and invalidates entries when the internal
 * file identity (device/inode/ctime/mtime/size) changes. Tags are intentionally
 * user-managed metadata and are not persisted
 * to project files, so they cannot alter Tiled documents or bypass permissions.
 */
export class AssetCatalogStore {
  constructor(options = {}) {
    this.catalog = options.catalog instanceof MapResourceCatalog
      ? options.catalog
      : new MapResourceCatalog(options.catalogOptions || {});
    this.maxEntries = positiveInteger(options.maxEntries, 4096, "maxEntries");
    this.entries = new Map();
    this.tags = new Map();
  }

  async inspect(input = {}) {
    const projectPath = input.projectPath;
    const resourcePath = input.resourcePath;
    const key = cacheKey(projectPath, resourcePath);
    const cached = this.entries.get(key);
    // A validation pass lets us reuse a prior hash when the file identity has
    // not changed. The second pass is only needed on a miss or identity change
    // and requests content hashing explicitly.
    if (cached) {
      try {
        const current = await this.catalog.inspect({ projectPath, resourcePath });
        if (sameCacheIdentity(current._cacheIdentity, cached.identity)) {
          this.entries.delete(key);
          this.entries.set(key, cached);
          return withTags(cached.resource, this.tags.get(key));
        }
      } catch (error) {
        this.entries.delete(key);
        this.tags.delete(key);
        throw error;
      }
    }
    const resource = await this.catalog.inspect({ projectPath, resourcePath, includeHash: true });
    const record = Object.freeze({
      resource,
      identity: resource._cacheIdentity,
    });
    this.entries.delete(key);
    this.entries.set(key, record);
    this.evictIfNeeded();
    return withTags(resource, this.tags.get(key));
  }

  async hash(input = {}) {
    const resource = await this.inspect(input);
    return resource.sha256;
  }

  async grant(input = {}) {
    const resource = await this.inspect(input);
    if (input.expectedKind !== undefined && input.expectedKind !== resource.kind) {
      throw catalogError(415, "map-resource-kind-mismatch", "地图素材类型与请求不匹配");
    }
    return resource;
  }

  setTags(input = {}) {
    const key = cacheKey(input.projectPath, input.resourcePath);
    const cached = this.entries.get(key);
    if (!cached) {
      throw catalogError(404, "map-resource-not-indexed", "地图素材尚未建立内容索引");
    }
    const tags = normalizeTags(input.tags);
    if (!tags.length) this.tags.delete(key);
    else this.tags.set(key, Object.freeze(tags));
    return withTags(cached.resource, tags);
  }

  getTags(input = {}) {
    const key = cacheKey(input.projectPath, input.resourcePath);
    return Object.freeze([...(this.tags.get(key) || [])]);
  }

  clearProject(projectPath) {
    const prefix = `${String(projectPath || "")}\0`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of this.tags.keys()) if (key.startsWith(prefix)) this.tags.delete(key);
  }

  clear() {
    this.entries.clear();
    this.tags.clear();
  }

  evictIfNeeded() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
      // Keep tags only while their resource remains indexed; this prevents an
      // unbounded tag map when projects are browsed repeatedly.
      if (oldest) this.tags.delete(oldest);
    }
  }
}

async function resolveProjectRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw catalogError(400, "invalid-map-resource-project", "地图素材工程路径无效");
  }
  try {
    const realPath = await fs.realpath(path.resolve(value));
    const stat = await fs.stat(realPath);
    if (!stat.isDirectory()) throw catalogError(400, "invalid-map-resource-project", "地图素材工程路径不是目录");
    return realPath;
  } catch (error) {
    if (error instanceof MapResourceCatalogError) throw error;
    throw translateFileError(error, "地图素材工程不存在", "invalid-map-resource-project");
  }
}

function normalizeRelativePath(value, options = {}) {
  if (options.allowRoot && (value === undefined || value === null || value === "" || value === ".")) return "";
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    throw catalogError(400, "invalid-map-resource-path", "地图素材路径无效");
  }
  if (
    path.posix.isAbsolute(value)
    || value.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) throw catalogError(400, "invalid-map-resource-path", "地图素材路径必须是工程相对路径");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw catalogError(400, "invalid-map-resource-path", "地图素材路径无效");
  }
  if (segments.some(isHiddenName)) {
    throw catalogError(403, "map-resource-hidden", "隐藏路径不能作为地图素材");
  }
  return segments.join("/");
}

async function requireSafePath(projectRoot, relativePath, expectedType) {
  let currentPath = projectRoot;
  const segments = relativePath ? relativePath.split("/") : [];
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    let stat;
    try {
      stat = await fs.lstat(currentPath);
    } catch (error) {
      throw translateFileError(error, "地图素材不存在");
    }
    if (stat.isSymbolicLink()) {
      throw catalogError(403, "map-resource-symlink", "符号链接不能作为地图素材");
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw catalogError(404, "map-resource-not-found", "地图素材不存在");
    }
  }
  let canonical;
  try {
    canonical = await fs.realpath(currentPath);
  } catch (error) {
    throw translateFileError(error, "地图素材不存在");
  }
  if (canonical !== currentPath || !isWithin(projectRoot, canonical)) {
    throw catalogError(403, "map-resource-symlink", "符号链接不能作为地图素材");
  }
  const stat = await fs.stat(canonical);
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw catalogError(400, "map-resource-not-directory", "地图素材目录无效");
  }
  if (expectedType === "file" && !stat.isFile()) {
    throw catalogError(400, "map-resource-not-file", "地图素材路径不是文件");
  }
  return canonical;
}

async function openStableFile(targetPath, maxBytes) {
  let handle;
  try {
    handle = await fs.open(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile()) throw catalogError(400, "map-resource-not-file", "地图素材路径不是文件");
    if (before.size > maxBytes) throw catalogError(413, "map-resource-size-limit", "地图素材超过管理员设置的读取上限");
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || buffer.length !== before.size) {
      throw catalogError(409, "map-resource-changed", "地图素材在读取过程中发生变化，请重试");
    }
    return { buffer, stat: before };
  } catch (error) {
    if (error instanceof MapResourceCatalogError) throw error;
    if (error?.code === "ELOOP") throw catalogError(403, "map-resource-symlink", "符号链接不能作为地图素材");
    throw translateFileError(error, "无法读取地图素材");
  } finally {
    await handle?.close();
  }
}

async function inspectImage(buffer, resourcePath, catalog) {
  const expectedFormat = IMAGE_EXTENSIONS.get(path.posix.extname(resourcePath).toLowerCase());
  let inspected;
  try {
    // Keep directory browsing and explicit resource authorization bounded in the
    // main server. Full pixel decoding belongs to the isolated image/visual
    // worker; this pass validates the container, dimensions and byte budget.
    inspected = inspectImageBuffer(buffer, {
      maxBytes: catalog.maxImageBytes,
      allowedFormats: [expectedFormat],
      ...(catalog.maxImageWidth ? { maxWidth: catalog.maxImageWidth } : {}),
      ...(catalog.maxImageHeight ? { maxHeight: catalog.maxImageHeight } : {}),
      ...(catalog.maxImagePixels ? { maxPixels: catalog.maxImagePixels } : {}),
    });
  } catch (error) {
    throw catalogError(415, "invalid-map-image", "地图图片签名、尺寸或像素数据无效", error);
  }
  return {
    format: inspected.format,
    mediaType: inspected.mediaType,
    width: inspected.width,
    height: inspected.height,
  };
}

function inspectTileset(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw catalogError(415, "invalid-map-tileset-utf8", "瓦片集不是有效的 UTF-8 文本", error);
  }
  let document;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw catalogError(415, "invalid-map-tileset-json", "瓦片集不是有效的 JSON", error);
  }
  if (!document || typeof document !== "object" || Array.isArray(document) || document.type !== "tileset") {
    throw catalogError(415, "invalid-map-tileset", "瓦片集必须是 Tiled type=tileset JSON");
  }
  return { document };
}

function tilesetImageDependencies(document, tilesetPath) {
  const references = [];
  collectTilesetImageReference(references, document, "image");
  if (document.tiles !== undefined) {
    if (!Array.isArray(document.tiles)) {
      throw catalogError(415, "invalid-map-tileset", "瓦片集 tiles 必须是数组");
    }
    for (const tile of document.tiles) {
      if (!tile || typeof tile !== "object" || Array.isArray(tile)) {
        throw catalogError(415, "invalid-map-tileset", "瓦片集 tile 条目无效");
      }
      collectTilesetImageReference(references, tile, "image");
    }
  }
  const dependencies = references.map((reference) => resolveTilesetImageReference(tilesetPath, reference));
  return [...new Set(dependencies)];
}

function collectTilesetImageReference(target, owner, key) {
  if (!Object.hasOwn(owner, key)) return;
  const value = owner[key];
  if (typeof value !== "string" || !value) {
    throw catalogError(415, "invalid-map-tileset-image-reference", "瓦片集图片引用无效");
  }
  target.push(value);
}

function resolveTilesetImageReference(tilesetPath, reference) {
  if (
    reference.includes("\0")
    || reference.includes("\\")
    || /[\u0001-\u001f\u007f]/u.test(reference)
    || path.posix.isAbsolute(reference)
    || reference.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/iu.test(reference)
  ) {
    throw catalogError(400, "invalid-map-tileset-image-reference", "瓦片集图片必须使用工程内相对路径");
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(tilesetPath), reference));
  if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../")) {
    throw catalogError(400, "invalid-map-tileset-image-reference", "瓦片集图片路径不能逃逸工程目录");
  }
  try {
    return normalizeRelativePath(resolved);
  } catch (error) {
    if (error instanceof MapResourceCatalogError) {
      throw catalogError(error.statusCode, "invalid-map-tileset-image-reference", "瓦片集图片引用无效", error);
    }
    throw error;
  }
}

function resourceKind(value) {
  const extension = path.posix.extname(value).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === ".tsj") return "tileset";
  return null;
}

function isHiddenName(value) {
  return typeof value === "string" && value.startsWith(".");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function pageSize(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw catalogError(400, "invalid-map-resource-limit", `地图素材分页数量必须在 1 到 ${maximum} 之间`);
  }
  return value;
}

function encodeCursor(directory, after) {
  return Buffer.from(JSON.stringify({ v: 1, directory, after }), "utf8").toString("base64url");
}

function decodeCursor(value, directory) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048 || !/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw catalogError(400, "invalid-map-resource-cursor", "地图素材分页游标无效");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      decoded?.v !== 1
      || decoded.directory !== directory
      || typeof decoded.after !== "string"
      || !/^[01]\0[^/\0]+$/u.test(decoded.after)
    ) throw new Error("invalid cursor");
    return decoded.after;
  } catch (error) {
    throw catalogError(400, "invalid-map-resource-cursor", "地图素材分页游标无效", error);
  }
}

function firstAfter(entries, after) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareText(entries[middle]._sortKey, after) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function translateFileError(error, fallbackMessage, fallbackCode = "map-resource-not-found") {
  if (error instanceof MapResourceCatalogError) return error;
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return catalogError(404, fallbackCode, fallbackMessage, error);
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return catalogError(403, "map-resource-forbidden", "没有权限读取地图素材", error);
  }
  return catalogError(500, "map-resource-io-error", fallbackMessage, error);
}

function catalogError(statusCode, code, message, cause = null) {
  return new MapResourceCatalogError(statusCode, code, message, cause);
}

function cacheKey(projectPath, resourcePath) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw catalogError(400, "invalid-map-resource-project", "地图素材工程路径无效");
  }
  if (typeof resourcePath !== "string" || !resourcePath) {
    throw catalogError(400, "invalid-map-resource-path", "地图素材路径无效");
  }
  return `${projectPath}\0${resourcePath}`;
}

function cacheIdentity(stat) {
  return Object.freeze({
    dev: String(stat?.dev ?? ""),
    ino: String(stat?.ino ?? ""),
    ctime: Number(stat?.ctimeMs),
    mtime: Number(stat?.mtimeMs),
    size: Number(stat?.size),
  });
}

function sameCacheIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.ctime === right.ctime
    && left.mtime === right.mtime
    && left.size === right.size;
}

function normalizeTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw catalogError(400, "invalid-map-resource-tags", "地图素材标签清单无效");
  }
  const tags = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !/^[\p{L}\p{N}_:.-]{1,64}$/u.test(raw)) {
      throw catalogError(400, "invalid-map-resource-tags", "地图素材标签无效");
    }
    if (!tags.includes(raw)) tags.push(raw);
  }
  return tags;
}

function withTags(resource, tags) {
  if (!resource) return null;
  return Object.freeze({ ...resource, tags: Object.freeze([...(tags || [])]) });
}
