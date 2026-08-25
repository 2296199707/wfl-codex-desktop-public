import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openImageProjectAnchor } from "./image-project-anchor.mjs";
import { inspectMapFile } from "./map-file-sessions.mjs";
import { MapResourceCatalog } from "./map-resource-catalog.mjs";
import { inspectTiledTilesetInChild } from "./map-save-sessions.mjs";

const TILESET_KINDS = new Set(["atlas", "collection"]);
const TARGET_VERSIONS = new Set(["1.12.2"]);
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 1_000_000;
const MAX_COLLECTION_IMAGES = 100_000;
const MAX_LOCAL_TILE_ID = 0x0fff_ffff;

export class MapProjectTilesetCreateError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectTilesetCreateError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function createTiledTilesetFile(input = {}, options = {}) {
  const projectPath = normalizeProjectPath(input.projectPath);
  const relativePath = normalizeRelativePath(input.relativePath, ".tsj", "瓦片集保存路径");
  const kind = enumValue(input.kind, TILESET_KINDS, "瓦片集类型");
  const imagePaths = normalizeImagePaths(input, kind);
  const inspectResource = typeof options.inspectResource === "function"
    ? options.inspectResource
    : (request) => new MapResourceCatalog().inspect(request);
  const resources = [];
  for (const resourcePath of imagePaths) {
    resources.push(await inspectTilesetImage(inspectResource, {
      projectPath,
      resourcePath,
      includeHash: true,
    }));
  }
  const document = createTiledTilesetDocument({ ...input, relativePath, kind }, resources);
  const content = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  if (content.length > maxBytes) {
    throw createError(413, "map-project-tileset-size-limit", "新瓦片集超过管理员设置的文件上限");
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
      `.${target.basename}.wfl-new-tileset-${crypto.randomBytes(8).toString("hex")}`,
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
      : inspectTiledTilesetInChild;
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
        "map-project-tileset-validation-failed",
        error?.message || "新瓦片集未通过 Tiled 校验",
        error,
      );
    }
    const expectedVersion = crypto.createHash("sha256").update(content).digest("hex");
    if (validation?.version !== expectedVersion) {
      throw createError(422, "map-project-tileset-validation-version", "新瓦片集校验结果与候选内容不一致");
    }
    await assertImagesUnchanged(inspectResource, projectPath, resources);
    await anchor.assertIdentity().catch((error) => {
      throw translateAnchorError(error);
    });
    try {
      await fs.link(temporaryPath, target.targetPath);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw createError(409, "map-project-tileset-exists", "目标瓦片集已经存在，未覆盖任何文件", error);
      }
      throw error;
    }
    await syncDirectory(target.directory);
    const inspected = await inspectMapFile(target.targetPath);
    if (inspected.version !== expectedVersion || inspected.fingerprint.size !== content.length) {
      throw createError(409, "map-project-tileset-post-publish", "新瓦片集发布后发生变化，已停止创建");
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
      kind,
      name: document.name,
      tilewidth: document.tilewidth,
      tileheight: document.tileheight,
      tilecount: document.tilecount,
      columns: document.columns,
      imageCount: resources.length,
      imagePaths: Object.freeze([...imagePaths]),
      diagnostics: Object.freeze([...(validation?.diagnostics || [])]),
    });
  } catch (error) {
    if (published && target && temporaryPath) {
      await rollbackPublishedTarget(target.targetPath, temporaryPath).catch(() => {});
    }
    if (error instanceof MapProjectTilesetCreateError) throw error;
    throw fileError(error);
  } finally {
    await temporaryHandle?.close().catch(() => {});
    if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await target?.close().catch(() => {});
    await anchor.close().catch(() => {});
  }
}

export function createTiledTilesetDocument(input = {}, imageResources = []) {
  const relativePath = normalizeRelativePath(input.relativePath, ".tsj", "瓦片集保存路径");
  const kind = enumValue(input.kind, TILESET_KINDS, "瓦片集类型");
  const name = normalizeName(input.name, "瓦片集名称");
  const targetVersion = enumValue(input.targetVersion ?? "1.12.2", TARGET_VERSIONS, "Tiled 目标版本");
  if (!Array.isArray(imageResources)) {
    throw createError(400, "invalid-map-project-tileset-images", "瓦片集图片清单无效");
  }
  const resources = imageResources.map((entry, index) => normalizeImageResource(entry, index));
  if (kind === "atlas") return createAtlasDocument(input, resources, { relativePath, name, targetVersion });
  return createCollectionDocument(input, resources, { relativePath, name, targetVersion });
}

function createAtlasDocument(input, resources, common) {
  if (resources.length !== 1) {
    throw createError(400, "invalid-map-project-atlas-image", "图集瓦片集必须选择一张图片");
  }
  const image = resources[0];
  const tilewidth = boundedInteger(input.tilewidth, 1, MAX_DIMENSION, "瓦片宽度");
  const tileheight = boundedInteger(input.tileheight, 1, MAX_DIMENSION, "瓦片高度");
  const margin = boundedInteger(input.margin ?? 0, 0, MAX_DIMENSION, "图集边距");
  const spacing = boundedInteger(input.spacing ?? 0, 0, MAX_DIMENSION, "瓦片间距");
  const columns = frameCount(image.width, tilewidth, margin, spacing);
  const rows = frameCount(image.height, tileheight, margin, spacing);
  const tilecount = safeTileCount(columns, rows);
  if (!tilecount) {
    throw createError(400, "map-project-atlas-image-too-small", "图集图片无法容纳一个完整瓦片");
  }
  const transparentcolor = normalizeColor(input.transparentcolor);
  return {
    columns,
    image: relativeReference(common.relativePath, image.path),
    imageheight: image.height,
    imagewidth: image.width,
    margin,
    name: common.name,
    spacing,
    tilecount,
    tiledversion: common.targetVersion,
    tileheight,
    tilewidth,
    ...(transparentcolor ? { transparentcolor } : {}),
    type: "tileset",
    version: "1.12",
  };
}

function createCollectionDocument(input, resources, common) {
  if (!resources.length || resources.length > MAX_COLLECTION_IMAGES) {
    throw createError(
      400,
      "invalid-map-project-collection-images",
      `图片集合必须选择 1 到 ${MAX_COLLECTION_IMAGES} 张图片`,
    );
  }
  if (resources.length - 1 > MAX_LOCAL_TILE_ID) {
    throw createError(400, "map-project-tileset-id-limit", "图片集合的瓦片 ID 超出 Tiled 范围");
  }
  const tilewidth = Math.max(...resources.map((entry) => entry.width));
  const tileheight = Math.max(...resources.map((entry) => entry.height));
  return {
    columns: 0,
    margin: 0,
    name: common.name,
    spacing: 0,
    tilecount: resources.length,
    tiledversion: common.targetVersion,
    tileheight,
    tiles: resources.map((image, id) => ({
      id,
      image: relativeReference(common.relativePath, image.path),
      imageheight: image.height,
      imagewidth: image.width,
    })),
    tilewidth,
    type: "tileset",
    version: "1.12",
  };
}

function normalizeImagePaths(input, kind) {
  const source = kind === "atlas" ? [input.image] : input.images;
  if (!Array.isArray(source)) {
    throw createError(400, "invalid-map-project-tileset-images", "瓦片集图片清单无效");
  }
  if ((kind === "atlas" && source.length !== 1) || (kind === "collection" && !source.length)) {
    throw createError(400, "invalid-map-project-tileset-images", "瓦片集图片数量无效");
  }
  if (source.length > MAX_COLLECTION_IMAGES) {
    throw createError(400, "invalid-map-project-tileset-images", "瓦片集图片数量超过上限");
  }
  const paths = source.map((entry, index) => normalizeImagePath(entry, `图片 ${index + 1}`));
  if (new Set(paths).size !== paths.length) {
    throw createError(400, "duplicate-map-project-tileset-image", "瓦片集图片清单不能包含重复路径");
  }
  return paths;
}

async function inspectTilesetImage(inspectResource, input) {
  let resource;
  try {
    resource = await inspectResource(input);
  } catch (error) {
    if (error instanceof MapProjectTilesetCreateError) throw error;
    throw createError(
      Number.isSafeInteger(error?.statusCode) ? error.statusCode : 422,
      "map-project-tileset-image-invalid",
      error?.message || "无法读取瓦片集图片",
      error,
    );
  }
  if (resource?.kind !== "image" || resource.path !== input.resourcePath) {
    throw createError(415, "map-project-tileset-image-invalid", "瓦片集依赖必须是受支持的工程图片");
  }
  return normalizeImageResource(resource, 0);
}

async function assertImagesUnchanged(inspectResource, projectPath, resources) {
  for (const expected of resources) {
    const current = await inspectTilesetImage(inspectResource, {
      projectPath,
      resourcePath: expected.path,
      includeHash: true,
    });
    if (
      current.width !== expected.width
      || current.height !== expected.height
      || (expected.sha256 && current.sha256 !== expected.sha256)
    ) {
      throw createError(409, "map-project-tileset-image-changed", `图片 ${expected.path} 在创建期间发生变化`);
    }
  }
}

function normalizeImageResource(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createError(400, "invalid-map-project-tileset-image", `图片 ${index + 1} 元数据无效`);
  }
  const resourcePath = normalizeImagePath(value.path, `图片 ${index + 1}`);
  const width = boundedInteger(value.width, 1, MAX_DIMENSION, `图片 ${index + 1} 宽度`);
  const height = boundedInteger(value.height, 1, MAX_DIMENSION, `图片 ${index + 1} 高度`);
  const sha256 = value.sha256 == null ? null : String(value.sha256).toLowerCase();
  if (sha256 !== null && !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw createError(400, "invalid-map-project-tileset-image", `图片 ${index + 1} 哈希无效`);
  }
  return Object.freeze({ path: resourcePath, width, height, sha256 });
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
  ) throw createError(400, "invalid-map-project-tileset-path", `${label}必须使用工程相对路径`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw createError(400, "invalid-map-project-tileset-path", `${label}路径无效`);
  }
  const normalized = segments.join("/");
  if (path.posix.extname(normalized).toLowerCase() !== extension) {
    throw createError(400, "invalid-map-project-tileset-path", `${label}必须使用 ${extension} 扩展名`);
  }
  return normalized;
}

function normalizeImagePath(value, label) {
  if (typeof value !== "string") {
    throw createError(400, "invalid-map-project-tileset-image-path", `${label}路径无效`);
  }
  const extension = path.posix.extname(value).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw createError(415, "invalid-map-project-tileset-image-path", `${label}必须是 PNG、JPEG 或 WebP`);
  }
  return normalizeRelativePath(value, extension, label);
}

function relativeReference(sourcePath, targetPath) {
  const relative = path.posix.relative(path.posix.dirname(sourcePath), targetPath);
  if (!relative || path.posix.isAbsolute(relative)) {
    throw createError(400, "invalid-map-project-tileset-reference", "无法生成瓦片集图片相对路径");
  }
  return relative;
}

function frameCount(imageSize, tileSize, margin, spacing) {
  const available = imageSize - margin * 2;
  if (available < tileSize) return 0;
  return Math.floor((available + spacing) / (tileSize + spacing));
}

function safeTileCount(columns, rows) {
  const value = columns * rows;
  if (!Number.isSafeInteger(value) || value - 1 > MAX_LOCAL_TILE_ID) {
    throw createError(400, "map-project-tileset-id-limit", "图集瓦片数量超出 Tiled 本地 ID 范围");
  }
  return value;
}

function normalizeName(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw createError(400, "invalid-map-project-tileset-name", `${label}无效`);
  }
  return value.trim();
}

function normalizeColor(value) {
  if (value === undefined || value === null || value === "") return null;
  const color = String(value).trim();
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color)) {
    throw createError(400, "invalid-map-project-tileset-color", "透明色必须是 #RRGGBB 或 #RRGGBBAA");
  }
  return color.toLowerCase();
}

function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw createError(400, "invalid-map-project-tileset-option", `${label}无效`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw createError(
      400,
      "invalid-map-project-tileset-number",
      `${label}必须是 ${minimum} 到 ${maximum} 之间的整数`,
    );
  }
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
    return createError(409, "map-project-changed", "地图工程目录在创建瓦片集期间发生变化", error);
  }
  if (error?.code === "IMAGE_PROJECT_SYMLINK" || error?.code === "ENOTDIR") {
    return createError(403, "map-project-tileset-symlink", "新瓦片集路径不能包含符号链接", error);
  }
  if (error?.statusCode) {
    return createError(error.statusCode, "invalid-map-project-tileset-path", "新瓦片集路径无效", error);
  }
  return error;
}

function fileError(error) {
  if (error?.code === "EEXIST") {
    return createError(409, "map-project-tileset-exists", "目标瓦片集已经存在，未覆盖任何文件", error);
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return createError(403, "map-project-tileset-forbidden", "没有权限在地图工程中创建瓦片集", error);
  }
  if (error?.code === "ELOOP") {
    return createError(403, "map-project-tileset-symlink", "新瓦片集路径不能包含符号链接", error);
  }
  return createError(500, "map-project-tileset-io-error", "无法原子创建瓦片集文件", error);
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
  return new MapProjectTilesetCreateError(statusCode, code, message, cause);
}
