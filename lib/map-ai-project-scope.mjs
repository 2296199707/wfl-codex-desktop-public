import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const SKIP_NAMES = new Set([".git", ".codex-desktop", ".codex-runtime", ".codex-uploads", ".codex-trash", "node_modules"]);

export class MapAiProjectScopeError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapAiProjectScopeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Bounded, symlink-free project view used by project-wide managed AI.
 * It intentionally returns relative paths only. The caller still performs
 * the account/share authorization before invoking this module.
 */
export async function listMapAiProjectResources({ projectPath, limit = DEFAULT_MAX_ENTRIES } = {}) {
  const root = await resolveProjectRoot(projectPath);
  const maximum = boundedInteger(limit, DEFAULT_MAX_ENTRIES, 1, DEFAULT_MAX_ENTRIES);
  const entries = [];
  const pending = [{ absolutePath: root, relativePath: "" }];
  let truncated = false;
  while (pending.length) {
    const current = pending.pop();
    let dirents;
    try {
      dirents = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) continue;
      throw projectError(500, "MAP_AI_PROJECT_SCAN_FAILED", "无法读取工程资源", error);
    }
    dirents.sort((left, right) => compareText(right.name, left.name));
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name) || dirent.isSymbolicLink()) continue;
      const relativePath = current.relativePath ? `${current.relativePath}/${dirent.name}` : dirent.name;
      const absolutePath = path.join(current.absolutePath, dirent.name);
      if (dirent.isDirectory()) {
        pending.push({ absolutePath, relativePath });
        continue;
      }
      if (!dirent.isFile()) continue;
      if (entries.length >= maximum) {
        truncated = true;
        break;
      }
      const stat = await fs.lstat(absolutePath).catch(() => null);
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
      entries.push({
        path: relativePath,
        name: dirent.name,
        kind: projectResourceKind(relativePath),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
    if (truncated) break;
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  return Object.freeze({
    resources: Object.freeze(entries),
    resourceCount: entries.length,
    truncated,
  });
}

export async function inspectMapAiProjectResource({
  projectPath,
  relativePath,
  includeHash = true,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const root = await resolveProjectRoot(projectPath);
  const normalizedPath = normalizeRelativePath(relativePath);
  const targetPath = await safeProjectPath(root, normalizedPath);
  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) throw projectError(400, "MAP_AI_PROJECT_RESOURCE_INVALID", "工程资源路径不是文件");
  if (stat.size > boundedInteger(maxBytes, DEFAULT_MAX_BYTES, 1, 2 * 1024 * 1024 * 1024)) {
    throw projectError(413, "MAP_AI_PROJECT_RESOURCE_TOO_LARGE", "工程资源超过托管读取上限");
  }
  const result = {
    path: normalizedPath,
    name: path.posix.basename(normalizedPath),
    kind: projectResourceKind(normalizedPath),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  };
  if (includeHash) result.version = await hashFile(targetPath, stat.size);
  return Object.freeze(result);
}

export async function readMapAiProjectResource({
  projectPath,
  relativePath,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const metadata = await inspectMapAiProjectResource({ projectPath, relativePath, includeHash: true, maxBytes });
  if (["image", "audio"].includes(metadata.kind)) {
    throw projectError(415, "MAP_AI_PROJECT_RESOURCE_BINARY", "图片和音频不能通过文本工具读取");
  }
  const root = await resolveProjectRoot(projectPath);
  const targetPath = await safeProjectPath(root, metadata.path);
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(targetPath));
  } catch (error) {
    if (error instanceof MapAiProjectScopeError) throw error;
    throw projectError(415, "MAP_AI_PROJECT_RESOURCE_UTF8", "工程资源不是有效的 UTF-8 文本", error);
  }
  return Object.freeze({ ...metadata, content });
}

export function projectResourceKind(relativePath) {
  const normalized = String(relativePath || "").toLowerCase();
  const extension = path.posix.extname(normalized);
  const name = path.posix.basename(normalized);
  if (extension === ".tmj") return "map";
  if (extension === ".world") return "world";
  if (extension === ".tsj") return "tileset";
  if (extension === ".tiled-project") return "project";
  if (extension === ".tx") return "template";
  if (name.endsWith(".character.json")) return "character";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (name === "rules.txt") return "automapping";
  return "other";
}

export function normalizeMapAiProjectResourcePath(value) {
  return normalizeRelativePath(value);
}

async function resolveProjectRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw projectError(400, "MAP_AI_PROJECT_SCOPE_INVALID", "工程路径无效");
  }
  const resolved = path.resolve(value);
  const [realPath, stat] = await Promise.all([
    fs.realpath(resolved).catch((error) => { throw projectError(404, "MAP_AI_PROJECT_NOT_FOUND", "工程不存在", error); }),
    fs.lstat(resolved).catch((error) => { throw projectError(404, "MAP_AI_PROJECT_NOT_FOUND", "工程不存在", error); }),
  ]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== resolved) {
    throw projectError(403, "MAP_AI_PROJECT_SYMLINK", "工程不能通过符号链接访问");
  }
  return realPath;
}

async function safeProjectPath(root, relativePath) {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw projectError(403, "MAP_AI_PROJECT_RESOURCE_OUTSIDE", "资源不在授权工程内");
  }
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => { throw projectError(404, "MAP_AI_PROJECT_RESOURCE_NOT_FOUND", "工程资源不存在", error); });
    if (stat.isSymbolicLink()) throw projectError(403, "MAP_AI_PROJECT_RESOURCE_SYMLINK", "工程资源不能是符号链接");
  }
  const realPath = await fs.realpath(candidate).catch((error) => { throw projectError(404, "MAP_AI_PROJECT_RESOURCE_NOT_FOUND", "工程资源不存在", error); });
  if (realPath !== candidate || !isWithin(root, realPath)) {
    throw projectError(403, "MAP_AI_PROJECT_RESOURCE_SYMLINK", "工程资源不能通过符号链接访问");
  }
  return realPath;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw projectError(400, "MAP_AI_PROJECT_RESOURCE_PATH_INVALID", "工程资源必须使用相对路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isHiddenName(segment))) {
    throw projectError(400, "MAP_AI_PROJECT_RESOURCE_PATH_INVALID", "工程资源路径无效");
  }
  return segments.join("/");
}

async function hashFile(targetPath, size) {
  const handle = await fs.open(targetPath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(1, size)));
  let offset = 0;
  try {
    while (offset < size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!result.bytesRead) throw projectError(409, "MAP_AI_PROJECT_RESOURCE_CHANGED", "工程资源在读取时发生变化");
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isHiddenName(value) {
  return typeof value === "string" && (value.startsWith(".") || SKIP_NAMES.has(value));
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw projectError(400, "MAP_AI_PROJECT_LIMIT_INVALID", "工程资源读取上限无效");
  return number;
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function projectError(statusCode, code, message, cause = null) { return new MapAiProjectScopeError(statusCode, code, message, cause); }
