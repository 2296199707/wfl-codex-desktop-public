import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openImageProjectAnchor } from "./image-project-anchor.mjs";
import { inspectMapFile } from "./map-file-sessions.mjs";
import { inspectTiledWorldInChild } from "./map-save-sessions.mjs";
import {
  createTiledWorld,
  serializeTiledWorld,
  worldMapReference,
} from "../public/map-editor/tiled-world.js";

const DEFAULT_MAX_WORLD_BYTES = 64 * 1024 * 1024;
const MAX_WORLD_MAPS = 100_000;
const MAX_WORLD_PATTERNS = 1_000;

export class MapProjectWorldCreateError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectWorldCreateError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function createTiledWorldFile(input = {}, options = {}) {
  const projectPath = normalizeProjectPath(input.projectPath);
  const relativePath = normalizeRelativePath(input.relativePath, ".world", "World 保存路径");
  const document = createTiledWorldDocument({ ...input, relativePath });
  const content = Buffer.from(serializeTiledWorld(document, { sourcePath: relativePath }), "utf8");
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_WORLD_BYTES, "maxBytes");
  if (content.length > maxBytes) {
    throw createError(413, "map-project-world-size-limit", "新 World 超过管理员设置的文件上限");
  }
  const anchor = await openImageProjectAnchor(projectPath).catch((error) => {
    throw translateAnchorError(error);
  });
  let target = null;
  let temporaryPath = null;
  let temporaryHandle = null;
  let published = false;
  try {
    target = await anchor.resolveTarget(path.join(projectPath, ...relativePath.split("/")), {
      createParents: true,
      directoryMode: 0o750,
    }).catch((error) => {
      throw translateAnchorError(error);
    });
    temporaryPath = path.join(
      target.directory,
      `.${target.basename}.wfl-new-world-${crypto.randomBytes(8).toString("hex")}`,
    );
    temporaryHandle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o640,
    );
    await temporaryHandle.writeFile(content);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;

    const validateCandidate = typeof options.validateCandidate === "function"
      ? options.validateCandidate
      : inspectTiledWorldInChild;
    let validation;
    try {
      validation = await validateCandidate({
        candidatePath: childAccessiblePath(temporaryPath),
        sourcePath: relativePath,
        projectPath,
        memoryMb: positiveInteger(options.validationMemoryMb, 256, "validationMemoryMb"),
        timeoutMs: positiveInteger(options.validationTimeoutMs, 60_000, "validationTimeoutMs"),
      });
    } catch (error) {
      throw createError(
        error?.statusCode === 413 ? 413 : 422,
        "map-project-world-validation-failed",
        error?.message || "新 World 未通过 Tiled 校验",
        error,
      );
    }
    const expectedVersion = crypto.createHash("sha256").update(content).digest("hex");
    if (validation?.version !== expectedVersion) {
      throw createError(422, "map-project-world-validation-version", "新 World 校验结果与候选内容不一致");
    }
    await anchor.assertIdentity().catch((error) => {
      throw translateAnchorError(error);
    });
    try {
      await fs.link(temporaryPath, target.targetPath);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw createError(409, "map-project-world-exists", "目标 World 已经存在，未覆盖任何文件", error);
      }
      throw error;
    }
    await syncDirectory(target.directory);
    const inspected = await inspectMapFile(target.targetPath);
    if (inspected.version !== expectedVersion || inspected.fingerprint.size !== content.length) {
      throw createError(409, "map-project-world-post-publish", "新 World 发布后发生变化，已停止创建");
    }
    published = false;
    await fs.unlink(temporaryPath).catch(() => {});
    temporaryPath = null;
    await syncDirectory(target.directory).catch(() => {});
    return Object.freeze({
      relativePath,
      version: inspected.version,
      size: inspected.fingerprint.size,
      modifiedAt: inspected.fingerprint.mtimeMs,
      mapCount: document.maps.length,
      patternCount: document.patterns.length,
      onlyShowAdjacentMaps: document.onlyShowAdjacentMaps === true,
      diagnostics: Object.freeze([...(validation?.diagnostics || [])]),
    });
  } catch (error) {
    if (published && target && temporaryPath) {
      await rollbackPublishedTarget(target.targetPath, temporaryPath).catch(() => {});
    }
    if (error instanceof MapProjectWorldCreateError) throw error;
    throw fileError(error);
  } finally {
    await temporaryHandle?.close().catch(() => {});
    if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await target?.close().catch(() => {});
    await anchor.close().catch(() => {});
  }
}

export function createTiledWorldDocument(input = {}) {
  const relativePath = normalizeRelativePath(input.relativePath, ".world", "World 保存路径");
  const mapInputs = input.maps === undefined ? [] : input.maps;
  const patterns = input.patterns === undefined ? [] : input.patterns;
  if (!Array.isArray(mapInputs) || mapInputs.length > MAX_WORLD_MAPS) {
    throw createError(400, "invalid-map-project-world-maps", `World maps 必须是最多 ${MAX_WORLD_MAPS} 项的数组`);
  }
  if (!Array.isArray(patterns) || patterns.length > MAX_WORLD_PATTERNS) {
    throw createError(400, "invalid-map-project-world-patterns", `World patterns 必须是最多 ${MAX_WORLD_PATTERNS} 项的数组`);
  }
  const maps = mapInputs.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw createError(400, "invalid-map-project-world-map", `World maps[${index}] 无效`);
    }
    const mapPath = normalizeRelativePath(entry.path, ".tmj", `World maps[${index}] 地图`);
    return {
      fileName: worldMapReference(relativePath, mapPath),
      x: safeInteger(entry.x, `maps[${index}].x`),
      y: safeInteger(entry.y, `maps[${index}].y`),
      width: positiveSafeInteger(entry.width, `maps[${index}].width`),
      height: positiveSafeInteger(entry.height, `maps[${index}].height`),
    };
  });
  try {
    return createTiledWorld({
      maps,
      patterns,
      onlyShowAdjacentMaps: input.onlyShowAdjacentMaps === true,
    });
  } catch (error) {
    throw createError(400, "invalid-map-project-world", error.message || "World 参数无效", error);
  }
}

function normalizeProjectPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw createError(400, "invalid-map-project", "地图工程路径无效");
  }
  return path.resolve(value);
}

function normalizeRelativePath(value, extension, label) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 4096
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) throw createError(400, "invalid-map-project-world-path", `${label}必须使用工程相对路径`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw createError(400, "invalid-map-project-world-path", `${label}路径无效`);
  }
  const normalized = segments.join("/");
  if (path.posix.extname(normalized).toLowerCase() !== extension) {
    throw createError(400, "invalid-map-project-world-path", `${label}必须使用 ${extension} 扩展名`);
  }
  return normalized;
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw createError(400, "invalid-map-project-world-number", `${label}必须是整数`);
  return number;
}

function positiveSafeInteger(value, label) {
  const number = safeInteger(value, label);
  if (number <= 0) throw createError(400, "invalid-map-project-world-number", `${label}必须是正整数`);
  return number;
}

async function rollbackPublishedTarget(targetPath, temporaryPath) {
  const [targetStat, temporaryStat] = await Promise.all([fs.lstat(targetPath), fs.lstat(temporaryPath)]);
  if (targetStat.dev === temporaryStat.dev && targetStat.ino === temporaryStat.ino) await fs.unlink(targetPath);
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function translateAnchorError(error) {
  if (error?.code === "IMAGE_PROJECT_CHANGED") {
    return createError(409, "map-project-changed", "地图工程目录在创建 World 期间发生变化", error);
  }
  if (error?.code === "IMAGE_PROJECT_SYMLINK" || error?.code === "ENOTDIR") {
    return createError(403, "map-project-world-symlink", "新 World 路径不能包含符号链接", error);
  }
  if (error?.statusCode) return createError(error.statusCode, "invalid-map-project-world-path", "新 World 路径无效", error);
  return error;
}

function fileError(error) {
  if (error?.code === "EEXIST") return createError(409, "map-project-world-exists", "目标 World 已经存在，未覆盖任何文件", error);
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return createError(403, "map-project-world-forbidden", "没有权限在地图工程中创建 World", error);
  }
  if (error?.code === "ELOOP") return createError(403, "map-project-world-symlink", "新 World 路径不能包含符号链接", error);
  return createError(500, "map-project-world-io-error", "无法原子创建 World 文件", error);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function childAccessiblePath(candidatePath) {
  const prefix = "/proc/self/fd/";
  return candidatePath.startsWith(prefix)
    ? `/proc/${process.pid}/fd/${candidatePath.slice(prefix.length)}`
    : candidatePath;
}

function createError(statusCode, code, message, cause = null) {
  return new MapProjectWorldCreateError(statusCode, code, message, cause);
}
