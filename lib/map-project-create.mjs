import crypto from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeflate } from "node:zlib";
import { openImageProjectAnchor } from "./image-project-anchor.mjs";
import { inspectMapFile } from "./map-file-sessions.mjs";
import { inspectTiledMapInChild } from "./map-save-sessions.mjs";

const ORIENTATIONS = new Set(["orthogonal", "isometric", "staggered", "hexagonal", "oblique"]);
const RENDER_ORDERS = new Set(["right-down", "right-up", "left-down", "left-up"]);
const TARGET_VERSIONS = new Set(["1.12.2"]);
const MAX_DIMENSION = 1_000_000;
const DEFAULT_MAX_TILE_BYTES = 4 * 1024 * 1024 * 1024;
const ZERO_CHUNK = Buffer.alloc(1024 * 1024);

export class MapProjectCreateError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectCreateError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function createTiledMap(input = {}, options = {}) {
  const projectPath = normalizeProjectPath(input.projectPath);
  const relativePath = normalizeMapPath(input.relativePath);
  const document = await createTiledMapDocument(input, {
    maxTileBytes: positiveInteger(options.maxTileBytes, DEFAULT_MAX_TILE_BYTES, "maxTileBytes"),
  });
  const content = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
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
      `.${target.basename}.wfl-new-${crypto.randomBytes(8).toString("hex")}`,
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
      : inspectTiledMapInChild;
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
        "map-project-create-validation-failed",
        error?.message || "新地图未通过 Tiled 校验",
        error,
      );
    }
    const expectedVersion = crypto.createHash("sha256").update(content).digest("hex");
    if (validation?.version !== expectedVersion) {
      throw createError(422, "map-project-create-validation-version", "新地图校验结果与候选内容不一致");
    }
    await anchor.assertIdentity().catch((error) => {
      throw translateAnchorError(error);
    });
    try {
      await fs.link(temporaryPath, target.targetPath);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw createError(409, "map-project-map-exists", "目标地图已经存在，未覆盖任何文件", error);
      }
      throw error;
    }
    await syncDirectory(target.directory);
    const inspected = await inspectMapFile(target.targetPath);
    if (inspected.version !== expectedVersion || inspected.fingerprint.size !== content.length) {
      throw createError(409, "map-project-create-post-publish", "新地图发布后发生变化，已停止创建");
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
      orientation: document.orientation,
      infinite: document.infinite,
      width: document.width,
      height: document.height,
      tilewidth: document.tilewidth,
      tileheight: document.tileheight,
      tilesetCount: document.tilesets.length,
      diagnostics: Object.freeze([...(validation?.diagnostics || [])]),
    });
  } catch (error) {
    if (published && target && temporaryPath) {
      await rollbackPublishedTarget(target.targetPath, temporaryPath).catch(() => {});
    }
    if (error instanceof MapProjectCreateError) throw error;
    throw fileError(error);
  } finally {
    await temporaryHandle?.close().catch(() => {});
    if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await target?.close().catch(() => {});
    await anchor.close().catch(() => {});
  }
}

export async function createTiledMapDocument(input = {}, options = {}) {
  const relativePath = normalizeMapPath(input.relativePath);
  const orientation = enumValue(input.orientation, ORIENTATIONS, "地图方向");
  const targetVersion = enumValue(input.targetVersion ?? "1.12.2", TARGET_VERSIONS, "Tiled 目标版本");
  const infinite = input.infinite === true;
  const tilewidth = boundedInteger(input.tilewidth, 1, MAX_DIMENSION, "瓦片宽度");
  const tileheight = boundedInteger(input.tileheight, 1, MAX_DIMENSION, "瓦片高度");
  const width = infinite ? 0 : boundedInteger(input.width, 1, MAX_DIMENSION, "地图宽度");
  const height = infinite ? 0 : boundedInteger(input.height, 1, MAX_DIMENSION, "地图高度");
  const renderorder = enumValue(input.renderorder ?? "right-down", RENDER_ORDERS, "渲染顺序");
  const initialLayerName = normalizeName(input.initialLayerName ?? "Ground", "初始图层名称");
  const tilesetPaths = normalizeTilesets(input.tilesets);
  const layer = {
    id: 1,
    name: initialLayerName,
    opacity: 1,
    type: "tilelayer",
    visible: true,
    x: 0,
    y: 0,
    ...(infinite
      ? { chunks: [], height: 0, width: 0 }
      : {
          compression: "zlib",
          data: await encodeZeroTileData(
            width,
            height,
            positiveInteger(options.maxTileBytes, DEFAULT_MAX_TILE_BYTES, "maxTileBytes"),
          ),
          encoding: "base64",
          height,
          width,
        }),
  };
  const document = {
    compressionlevel: -1,
    height,
    infinite,
    layers: [layer],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation,
    renderorder,
    tiledversion: targetVersion,
    tileheight,
    tilesets: tilesetPaths.map((tilesetPath) => ({
      firstgid: 1,
      source: relativeReference(relativePath, tilesetPath),
    })),
    tilewidth,
    type: "map",
    version: "1.12",
    width,
  };
  const backgroundcolor = normalizeColor(input.backgroundcolor);
  if (backgroundcolor) document.backgroundcolor = backgroundcolor;
  if (["staggered", "hexagonal"].includes(orientation)) {
    document.staggeraxis = enumValue(input.staggeraxis ?? "y", new Set(["x", "y"]), "交错轴");
    document.staggerindex = enumValue(input.staggerindex ?? "odd", new Set(["odd", "even"]), "交错索引");
  }
  if (orientation === "hexagonal") {
    const maximum = document.staggeraxis === "x" ? tilewidth : tileheight;
    document.hexsidelength = boundedInteger(input.hexsidelength ?? Math.floor(maximum / 2), 0, maximum, "六边形边长");
  }
  if (orientation === "oblique") {
    document.skewx = boundedInteger(input.skewx ?? 0, -MAX_DIMENSION, MAX_DIMENSION, "oblique skewx");
    document.skewy = boundedInteger(input.skewy ?? 0, -MAX_DIMENSION, MAX_DIMENSION, "oblique skewy");
    const determinant = 1 - document.skewx / tileheight * document.skewy / tilewidth;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) {
      throw createError(400, "invalid-map-project-oblique", "oblique 投影参数不可逆");
    }
  }
  return document;
}

async function encodeZeroTileData(width, height, maxTileBytes) {
  const cells = width * height;
  const bytes = cells * 4;
  if (!Number.isSafeInteger(cells) || !Number.isSafeInteger(bytes) || bytes > maxTileBytes) {
    throw createError(413, "map-project-create-cell-limit", "初始地图瓦片数据超过管理员设置的地图文件上限");
  }
  const compressor = createDeflate();
  const output = [];
  compressor.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const completed = once(compressor, "end");
  let remaining = bytes;
  while (remaining > 0) {
    const length = Math.min(remaining, ZERO_CHUNK.length);
    if (!compressor.write(ZERO_CHUNK.subarray(0, length))) await once(compressor, "drain");
    remaining -= length;
  }
  compressor.end();
  await completed;
  return Buffer.concat(output).toString("base64");
}

function normalizeTilesets(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1) {
    throw createError(400, "invalid-map-project-tilesets", "新建地图最多选择一个外部瓦片集");
  }
  const result = [];
  for (const entry of value) {
    const tilesetPath = normalizeRelativePath(entry, ".tsj", "外部瓦片集");
    if (!result.includes(tilesetPath)) result.push(tilesetPath);
  }
  return result;
}

function normalizeProjectPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw createError(400, "invalid-map-project", "地图工程路径无效");
  }
  return path.resolve(value);
}

function normalizeMapPath(value) {
  return normalizeRelativePath(value, ".tmj", "地图保存路径");
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
  ) throw createError(400, "invalid-map-project-create-path", `${label}必须使用工程相对路径`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw createError(400, "invalid-map-project-create-path", `${label}路径无效`);
  }
  const normalized = segments.join("/");
  if (path.posix.extname(normalized).toLowerCase() !== extension) {
    throw createError(400, "invalid-map-project-create-path", `${label}必须使用 ${extension} 扩展名`);
  }
  return normalized;
}

function relativeReference(sourcePath, targetPath) {
  const from = path.posix.dirname(sourcePath);
  const relative = path.posix.relative(from, targetPath);
  if (!relative || path.posix.isAbsolute(relative)) {
    throw createError(400, "invalid-map-project-tileset-reference", "无法生成外部瓦片集相对路径");
  }
  return relative;
}

function normalizeName(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw createError(400, "invalid-map-project-create-name", `${label}无效`);
  }
  return value.trim();
}

function normalizeColor(value) {
  if (value === undefined || value === null || value === "") return null;
  const color = String(value).trim();
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color)) {
    throw createError(400, "invalid-map-project-color", "地图背景色必须是 #RRGGBB 或 #RRGGBBAA");
  }
  return color.toLowerCase();
}

function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw createError(400, "invalid-map-project-create-option", `${label}无效`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw createError(400, "invalid-map-project-create-number", `${label}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

async function rollbackPublishedTarget(targetPath, temporaryPath) {
  const [targetStat, temporaryStat] = await Promise.all([fs.lstat(targetPath), fs.lstat(temporaryPath)]);
  if (targetStat.dev === temporaryStat.dev && targetStat.ino === temporaryStat.ino) {
    await fs.unlink(targetPath);
  }
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
    return createError(409, "map-project-changed", "地图工程目录在创建过程中发生变化", error);
  }
  if (error?.code === "IMAGE_PROJECT_SYMLINK") {
    return createError(403, "map-project-create-symlink", "新地图路径不能包含符号链接", error);
  }
  if (error?.code === "ENOTDIR") {
    return createError(403, "map-project-create-symlink", "新地图路径不能包含符号链接或非目录节点", error);
  }
  if (error?.statusCode) {
    return createError(error.statusCode, "invalid-map-project-create-path", "新地图路径无效", error);
  }
  return error;
}

function fileError(error) {
  if (error?.code === "EEXIST") return createError(409, "map-project-map-exists", "目标地图已经存在，未覆盖任何文件", error);
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return createError(403, "map-project-create-forbidden", "没有权限在地图工程中创建文件", error);
  }
  if (error?.code === "ELOOP") return createError(403, "map-project-create-symlink", "新地图路径不能包含符号链接", error);
  return createError(500, "map-project-create-io-error", "无法原子创建地图文件", error);
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
  return new MapProjectCreateError(statusCode, code, message, cause);
}
