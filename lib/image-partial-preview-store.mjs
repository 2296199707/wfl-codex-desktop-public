import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { publishImageFileBatch } from "./image-atomic-save.mjs";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTHORIZATION_NONCE_PATTERN = /^[a-f0-9]{64}$/;
const FILE_PATTERN = /^partial-[a-f0-9]{48}\.(?:png|jpe?g|webp)$/;
const FORMAT_MEDIA_TYPES = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);
const FORMAT_EXTENSIONS = new Map([
  ["png", new Set([".png"])],
  ["jpeg", new Set([".jpg", ".jpeg"])],
  ["webp", new Set([".webp"])],
]);

export class ImagePartialPreviewStore {
  constructor(rootDirectory, {
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    now = () => Date.now(),
  } = {}) {
    if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
      throw previewError(400, "INVALID_PARTIAL_PREVIEW_ROOT", "图片临时预览目录必须是绝对路径");
    }
    const resolved = path.resolve(rootDirectory);
    if (resolved === path.parse(resolved).root) {
      throw previewError(400, "INVALID_PARTIAL_PREVIEW_ROOT", "图片临时预览目录范围过大");
    }
    this.rootDirectory = resolved;
    this.ttlMs = positiveInteger(ttlMs, "ttlMs");
    this.maxEntries = positiveInteger(maxEntries, "maxEntries");
    this.maxBytes = positiveInteger(maxBytes, "maxBytes");
    this.maxFileBytes = positiveInteger(maxFileBytes, "maxFileBytes");
    if (this.maxFileBytes > this.maxBytes) {
      throw previewError(400, "INVALID_PARTIAL_PREVIEW_LIMIT", "单个图片预览上限不能大于总容量");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.now = now;
    this.entries = new Map();
    this.totalBytes = 0;
    this.initialized = false;
    this.closed = false;
    this.mutationQueue = Promise.resolve();
  }

  async initialize() {
    if (this.closed) throw previewError(503, "PARTIAL_PREVIEW_STORE_CLOSED", "图片临时预览存储已关闭");
    if (this.initialized) return this;
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.rootDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw previewError(500, "UNSAFE_PARTIAL_PREVIEW_ROOT", "图片临时预览目录不安全");
    }
    await fs.chmod(this.rootDirectory, 0o700);
    for (const name of await fs.readdir(this.rootDirectory)) {
      if (!FILE_PATTERN.test(name)) continue;
      const candidate = path.join(this.rootDirectory, name);
      const candidateStat = await fs.lstat(candidate).catch(() => null);
      if (!candidateStat?.isFile() || candidateStat.isSymbolicLink()) continue;
      await safeUnlinkKnown(candidate, candidateStat.dev, candidateStat.ino);
    }
    this.initialized = true;
    return this;
  }

  async stage(input) {
    this.assertAvailable();
    const normalized = normalizeStageInput(input, this.maxFileBytes);
    return this.mutate(async () => {
      this.assertAvailable();
      await this.pruneExpiredInternal(this.now());
      await this.makeCapacity(normalized.expected.size);

      const target = await this.publishRandomTarget(normalized);
      let handle;
      try {
        handle = await openNoFollow(target.path);
        const stat = await handle.stat();
        assertStoredFile(stat, normalized.expected);
        if (stat.dev !== target.dev || stat.ino !== target.ino) {
          throw previewError(410, "PARTIAL_PREVIEW_REPLACED", "图片临时预览已失效");
        }
        await verifyStoredDigest(handle, normalized.expected);
        await verifyStoredMetadata(handle, normalized.expected);
        await handle.close();
        handle = null;

        const token = this.allocateToken();
        const createdAt = this.now();
        const record = {
          token,
          path: target.path,
          userId: normalized.userId,
          browserSessionId: normalized.browserSessionId,
          windowId: normalized.windowId,
          operationId: normalized.operationId,
          createdAt,
          expiresAt: createdAt + this.ttlMs,
          dev: stat.dev,
          ino: stat.ino,
          metadata: Object.freeze({ ...normalized.expected }),
        };
        this.entries.set(token, record);
        this.totalBytes += record.metadata.size;
        return publicStage(record);
      } catch (error) {
        await handle?.close().catch(() => {});
        if (target.dev !== null && target.ino !== null) {
          await safeUnlinkKnown(target.path, target.dev, target.ino).catch(() => {});
        }
        throw error;
      }
    });
  }

  async open(token, identity) {
    this.assertAvailable();
    const normalizedToken = normalizeToken(token);
    const normalizedIdentity = normalizeIdentity(identity);
    await this.prune();
    this.assertAvailable();
    const record = this.entries.get(normalizedToken);
    if (!record || !sameIdentity(record, normalizedIdentity)) throw notFoundError();

    let handle;
    try {
      handle = await openNoFollow(record.path);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== record.dev || stat.ino !== record.ino || stat.size !== record.metadata.size) {
        throw previewError(410, "PARTIAL_PREVIEW_REPLACED", "图片临时预览已失效");
      }
      return {
        handle,
        metadata: publicMetadata(record),
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.discardRecord(record);
      if (error?.code === "PARTIAL_PREVIEW_REPLACED") throw error;
      throw previewError(410, "PARTIAL_PREVIEW_UNAVAILABLE", "图片临时预览已失效");
    }
  }

  async prune() {
    if (!this.initialized || this.closed) return;
    await this.mutate(() => this.pruneExpiredInternal(this.now()));
  }

  status() {
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.mutate(async () => {
      for (const record of [...this.entries.values()]) await this.discardRecord(record);
    });
  }

  assertAvailable() {
    if (!this.initialized) throw previewError(503, "PARTIAL_PREVIEW_STORE_UNINITIALIZED", "图片临时预览存储尚未初始化");
    if (this.closed) throw previewError(503, "PARTIAL_PREVIEW_STORE_CLOSED", "图片临时预览存储已关闭");
  }

  mutate(operation) {
    const task = this.mutationQueue.then(operation, operation);
    this.mutationQueue = task.catch(() => {});
    return task;
  }

  async makeCapacity(incomingBytes) {
    while (this.entries.size >= this.maxEntries || this.totalBytes + incomingBytes > this.maxBytes) {
      const oldest = this.entries.values().next().value;
      if (!oldest) throw previewError(413, "PARTIAL_PREVIEW_CAPACITY_EXCEEDED", "图片临时预览容量不足");
      await this.discardRecord(oldest);
    }
  }

  async pruneExpiredInternal(now) {
    for (const record of [...this.entries.values()]) {
      if (record.expiresAt <= now) await this.discardRecord(record);
    }
  }

  async discardRecord(record) {
    if (this.entries.get(record.token) !== record) return;
    this.entries.delete(record.token);
    this.totalBytes = Math.max(0, this.totalBytes - record.metadata.size);
    await safeUnlinkKnown(record.path, record.dev, record.ino);
  }

  async publishRandomTarget(normalized) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const extension = normalized.expected.format === "jpeg" ? "jpg" : normalized.expected.format;
      const filename = `partial-${crypto.randomBytes(24).toString("hex")}.${extension}`;
      const targetPath = path.join(this.rootDirectory, filename);
      try {
        const [published] = await publishImageFileBatch({
          outputs: [{
            sourcePath: normalized.sourcePath,
            targetPath,
            expected: normalized.expected,
            mode: 0o600,
          }],
          maxBytesPerFile: this.maxFileBytes,
          maxTotalBytes: this.maxFileBytes,
        });
        const stat = await fs.lstat(targetPath);
        return { path: published.path, dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if (error?.code !== "IMAGE_OUTPUT_EXISTS") throw error;
      }
    }
    throw previewError(503, "PARTIAL_PREVIEW_PATH_UNAVAILABLE", "无法分配图片临时预览路径");
  }

  allocateToken() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
      if (!this.entries.has(token)) return token;
    }
    throw previewError(503, "PARTIAL_PREVIEW_TOKEN_UNAVAILABLE", "无法分配图片临时预览令牌");
  }
}

function normalizeStageInput(value, maxFileBytes) {
  if (!isRecord(value)) throw invalidInput("图片临时预览参数无效");
  const allowed = new Set([
    "sourcePath", "expected", "userId", "browserSessionId", "windowId", "operationId",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidInput("图片临时预览不接受额外数据");
  }
  const identity = normalizeIdentity(value);
  if (typeof value.sourcePath !== "string" || !path.isAbsolute(value.sourcePath)) {
    throw invalidInput("图片临时预览源路径必须是绝对路径");
  }
  const sourcePath = path.resolve(value.sourcePath);
  if (sourcePath !== value.sourcePath || sourcePath === path.parse(sourcePath).root || /[\u0000\r\n]/.test(sourcePath)) {
    throw invalidInput("图片临时预览源路径无效");
  }
  const expected = normalizeExpected(value.expected, maxFileBytes);
  if (!FORMAT_EXTENSIONS.get(expected.format).has(path.extname(sourcePath).toLowerCase())) {
    throw invalidInput("图片临时预览源路径扩展名与格式不一致");
  }
  return { sourcePath, expected, ...identity };
}

function normalizeExpected(value, maxFileBytes) {
  if (!isRecord(value)) throw invalidInput("图片临时预览元数据无效");
  const allowed = new Set(["size", "sha256", "format", "width", "height", "mediaType"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || Object.keys(value).length !== allowed.size) {
    throw invalidInput("图片临时预览元数据字段无效");
  }
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxFileBytes) {
    throw previewError(413, "PARTIAL_PREVIEW_TOO_LARGE", "图片临时预览超过单文件容量");
  }
  const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalidInput("图片临时预览摘要无效");
  if (!FORMAT_MEDIA_TYPES.has(value.format) || value.mediaType !== FORMAT_MEDIA_TYPES.get(value.format)) {
    throw invalidInput("图片临时预览格式无效");
  }
  for (const dimension of [value.width, value.height]) {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 32_768) {
      throw invalidInput("图片临时预览尺寸无效");
    }
  }
  return {
    size: value.size,
    sha256,
    format: value.format,
    width: value.width,
    height: value.height,
    mediaType: value.mediaType,
  };
}

function normalizeIdentity(value) {
  if (!isRecord(value)) throw invalidInput("图片临时预览身份无效");
  return {
    userId: boundedIdentity(value.userId, "userId"),
    browserSessionId: boundedIdentity(value.browserSessionId, "browserSessionId"),
    windowId: authorizationNonce(value.windowId, "windowId"),
    operationId: authorizationNonce(value.operationId, "operationId"),
  };
}

function authorizationNonce(value, name) {
  if (typeof value !== "string" || !AUTHORIZATION_NONCE_PATTERN.test(value)) {
    throw invalidInput(`图片临时预览 ${name} 无效`);
  }
  return value;
}

function boundedIdentity(value, name) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw invalidInput(`图片临时预览 ${name} 无效`);
  }
  return value;
}

function normalizeToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) throw invalidInput("图片临时预览令牌无效");
  return value;
}

async function openNoFollow(filename) {
  try {
    return await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw previewError(410, "PARTIAL_PREVIEW_REPLACED", "图片临时预览已失效");
    }
    throw error;
  }
}

function assertStoredFile(stat, expected) {
  if (!stat.isFile() || stat.size !== expected.size) {
    throw previewError(409, "PARTIAL_PREVIEW_FILE_MISMATCH", "图片临时预览文件校验失败");
  }
}

async function verifyStoredDigest(handle, expected) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expected.size));
  let offset = 0;
  while (offset < expected.size) {
    const length = Math.min(buffer.length, expected.size - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (!bytesRead) break;
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== expected.size || digest.digest("hex") !== expected.sha256) {
    throw previewError(409, "PARTIAL_PREVIEW_DIGEST_MISMATCH", "图片临时预览摘要校验失败");
  }
}

async function verifyStoredMetadata(handle, expected) {
  const detected = expected.format === "png"
    ? await inspectPngHeader(handle)
    : expected.format === "jpeg"
      ? await inspectJpegHeader(handle, expected.size)
      : await inspectWebpHeader(handle);
  if (
    detected.format !== expected.format
    || detected.width !== expected.width
    || detected.height !== expected.height
    || FORMAT_MEDIA_TYPES.get(detected.format) !== expected.mediaType
  ) throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览元数据与文件不一致");
}

async function inspectPngHeader(handle) {
  const header = await readAt(handle, 24, 0);
  if (
    !header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || header.readUInt32BE(8) !== 13
    || header.subarray(12, 16).toString("ascii") !== "IHDR"
  ) throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览 PNG 头无效");
  return { format: "png", width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

async function inspectWebpHeader(handle) {
  const header = await readAt(handle, 30, 0);
  if (header.subarray(0, 4).toString("ascii") !== "RIFF" || header.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览 WebP 头无效");
  }
  const chunk = header.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      format: "webp",
      width: 1 + readUInt24LE(header, 24),
      height: 1 + readUInt24LE(header, 27),
    };
  }
  if (chunk === "VP8L" && header[20] === 0x2f) {
    return {
      format: "webp",
      width: 1 + header[21] + ((header[22] & 0x3f) << 8),
      height: 1 + ((header[22] & 0xc0) >> 6) + (header[23] << 2) + ((header[24] & 0x0f) << 10),
    };
  }
  if (chunk === "VP8 " && header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a) {
    return {
      format: "webp",
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览 WebP 头无效");
}

async function inspectJpegHeader(handle, size) {
  const signature = await readAt(handle, 2, 0);
  if (signature[0] !== 0xff || signature[1] !== 0xd8) {
    throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览 JPEG 头无效");
  }
  let offset = 2;
  while (offset < size) {
    let markerByte = (await readAt(handle, 1, offset))[0];
    if (markerByte !== 0xff) throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览 JPEG 段无效");
    while (markerByte === 0xff) {
      offset += 1;
      markerByte = (await readAt(handle, 1, offset))[0];
    }
    const marker = markerByte;
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = (await readAt(handle, 2, offset)).readUInt16BE(0);
    if (segmentLength < 2 || offset + segmentLength > size) break;
    if (isJpegSofMarker(marker)) {
      const frame = await readAt(handle, 7, offset);
      return { format: "jpeg", width: frame.readUInt16BE(5), height: frame.readUInt16BE(3) };
    }
    offset += segmentLength;
  }
  throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览 JPEG 尺寸无效");
}

function isJpegSofMarker(marker) {
  return (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker));
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw previewError(409, "PARTIAL_PREVIEW_METADATA_MISMATCH", "图片临时预览文件头不完整");
    offset += bytesRead;
  }
  return buffer;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

async function safeUnlinkKnown(filename, dev, ino) {
  let current;
  try {
    current = await fs.lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== dev || current.ino !== ino) return false;
  await fs.unlink(filename);
  return true;
}

function publicStage(record) {
  return { token: record.token, metadata: publicMetadata(record) };
}

function publicMetadata(record) {
  return {
    ...record.metadata,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function sameIdentity(record, identity) {
  return record.userId === identity.userId
    && record.browserSessionId === identity.browserSessionId
    && record.windowId === identity.windowId
    && record.operationId === identity.operationId;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw previewError(400, "INVALID_PARTIAL_PREVIEW_LIMIT", `${name} 必须是正整数`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidInput(message) {
  return previewError(400, "INVALID_PARTIAL_PREVIEW", message);
}

function notFoundError() {
  return previewError(404, "PARTIAL_PREVIEW_NOT_FOUND", "图片临时预览不存在");
}

function previewError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

export const IMAGE_PARTIAL_PREVIEW_DEFAULTS = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxBytes: DEFAULT_MAX_BYTES,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
});
