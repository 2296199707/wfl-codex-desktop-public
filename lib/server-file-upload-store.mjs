import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  inspectServerFilePath,
  normalizeServerFileName,
  normalizeServerFilePath,
  serverFileEntry,
} from "./server-file-manager.mjs";

const STORE_VERSION = 1;
const UPLOAD_ID_PATTERN = /^sfu-[A-Za-z0-9-]{20,96}$/u;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_UPLOADS = 32;
const DEFAULT_MAX_UPLOADS_PER_OWNER = 8;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const SERVER_FILE_UPLOAD_CHUNK_BYTES = DEFAULT_CHUNK_BYTES;
export const SERVER_FILE_UPLOAD_MAX_BYTES = DEFAULT_MAX_BYTES;
export const SERVER_FILE_UPLOAD_TTL_MS = DEFAULT_TTL_MS;

export class ServerFileUploadError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "ServerFileUploadError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function parseServerFileUploadRange(value) {
  if (typeof value !== "string") {
    throw uploadError(400, "SERVER_FILE_UPLOAD_RANGE_INVALID", "上传分块范围无效");
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/u.exec(value.trim());
  if (!match) {
    throw uploadError(400, "SERVER_FILE_UPLOAD_RANGE_INVALID", "上传分块范围无效");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(total)
    || start < 0
    || end < start
    || total < 1
    || end >= total
  ) {
    throw uploadError(400, "SERVER_FILE_UPLOAD_RANGE_INVALID", "上传分块范围无效");
  }
  return { start, end, total, length: end - start + 1 };
}

export class ServerFileUploadStore {
  constructor({
    temporaryRoot,
    maxBytes = DEFAULT_MAX_BYTES,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    maxUploads = DEFAULT_MAX_UPLOADS,
    maxUploadsPerOwner = DEFAULT_MAX_UPLOADS_PER_OWNER,
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
  } = {}) {
    if (typeof temporaryRoot !== "string" || !path.isAbsolute(temporaryRoot)) {
      throw new TypeError("temporaryRoot must be absolute");
    }
    this.temporaryRoot = path.resolve(temporaryRoot);
    this.uploadsDirectory = path.join(this.temporaryRoot, "uploads");
    this.indexPath = path.join(this.temporaryRoot, "index.json");
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    this.chunkBytes = positiveInteger(chunkBytes, DEFAULT_CHUNK_BYTES);
    this.maxUploads = positiveInteger(maxUploads, DEFAULT_MAX_UPLOADS);
    this.maxUploadsPerOwner = positiveInteger(maxUploadsPerOwner, DEFAULT_MAX_UPLOADS_PER_OWNER);
    this.ttlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS);
    this.now = typeof now === "function" ? now : Date.now;
    this.uploads = new Map();
    this.busyUploads = new Set();
    this.writeQueue = Promise.resolve();
    this.startQueue = Promise.resolve();
    this.prunePromise = null;
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.uploadsDirectory, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.temporaryRoot);
    const uploadsStat = await fs.lstat(this.uploadsDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TypeError("temporaryRoot must be a real directory");
    }
    if (!uploadsStat.isDirectory() || uploadsStat.isSymbolicLink()) {
      throw new TypeError("uploadsDirectory must be a real directory");
    }
    await Promise.all([
      fs.chmod(this.temporaryRoot, 0o700),
      fs.chmod(this.uploadsDirectory, 0o700),
    ]);

    const index = await readJson(this.indexPath, { version: STORE_VERSION, uploads: [] });
    validateIndex(index);
    const staleDirectories = [];
    let changed = false;
    for (const raw of index.uploads) {
      const upload = deserializeUpload(raw, this);
      const payloadStat = await fs.lstat(upload.filePath).catch(() => null);
      if (upload.status === "complete") {
        if (upload.entry && !payloadStat) {
          this.uploads.set(upload.id, upload);
        } else if (payloadStat?.isFile() && !payloadStat.isSymbolicLink()) {
          this.uploads.set(upload.id, upload);
        } else {
          this.uploads.set(upload.id, upload);
        }
        continue;
      }
      if (!payloadStat?.isFile() || payloadStat.isSymbolicLink()) {
        staleDirectories.push(upload.directory);
        changed = true;
        continue;
      }
      if (payloadStat.size > upload.uploadedBytes) {
        await fs.truncate(upload.filePath, upload.uploadedBytes);
      } else if (payloadStat.size < upload.uploadedBytes) {
        staleDirectories.push(upload.directory);
        changed = true;
        continue;
      }
      this.uploads.set(upload.id, upload);
    }

    const knownDirectories = new Set([...this.uploads.values()].map((upload) => path.basename(upload.directory)));
    const directoryEntries = await fs.readdir(this.uploadsDirectory, { withFileTypes: true });
    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || knownDirectories.has(entry.name)) continue;
      staleDirectories.push(path.join(this.uploadsDirectory, entry.name));
      changed = true;
    }
    await Promise.all(staleDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    this.initialized = true;
    if (changed && writeOnInitialize) await this.persist();
    await this.pruneExpired();
    return this;
  }

  start(input = {}) {
    const operation = this.startQueue.then(
      () => this.startUnlocked(input),
      () => this.startUnlocked(input),
    );
    this.startQueue = operation.catch(() => {});
    return operation;
  }

  async startUnlocked({ ownerId, parentPath, name, totalBytes, clientUploadId = null } = {}) {
    this.assertInitialized();
    await this.pruneExpired();
    const owner = normalizeOwnerId(ownerId);
    const parent = await inspectServerFilePath(parentPath);
    if (!parent.stat.isDirectory()) {
      throw uploadError(400, "SERVER_FILE_NOT_DIRECTORY", "目标位置不是文件夹");
    }
    const filename = normalizeServerFileName(name);
    const bytes = boundedInteger(totalBytes, this.maxBytes, "SERVER_FILE_UPLOAD_SIZE_INVALID", "上传文件大小无效");
    const clientId = normalizeClientUploadId(clientUploadId);
    const targetPath = path.join(parent.path, filename);
    const existingClientUpload = clientId
      ? [...this.uploads.values()].find((upload) => upload.ownerId === owner && upload.clientUploadId === clientId)
      : null;
    if (existingClientUpload) {
      if (
        existingClientUpload.targetPath !== targetPath
        || existingClientUpload.totalBytes !== bytes
        || existingClientUpload.name !== filename
      ) {
        throw uploadError(409, "SERVER_FILE_UPLOAD_ID_CONFLICT", "客户端上传编号已经绑定到另一个文件");
      }
      await this.recover(existingClientUpload);
      if (this.uploads.has(existingClientUpload.id)) {
        if (existingClientUpload.status === "complete") {
          const currentTarget = await inspectServerFilePath(targetPath, { allowMissing: true });
          if (currentTarget.exists) {
            if (!currentTarget.stat.isFile()) {
              throw uploadError(409, "SERVER_FILE_ALREADY_EXISTS", "同名文件或文件夹已存在");
            }
            return publicUpload(existingClientUpload);
          }
          this.uploads.delete(existingClientUpload.id);
          await fs.rm(existingClientUpload.directory, { recursive: true, force: true });
          await this.persist();
        } else if (existingClientUpload.status === "conflict") {
          const currentTarget = await inspectServerFilePath(targetPath, { allowMissing: true });
          if (currentTarget.exists) {
            throw uploadError(409, "SERVER_FILE_ALREADY_EXISTS", "同名文件或文件夹已存在");
          }
          this.uploads.delete(existingClientUpload.id);
          await fs.rm(existingClientUpload.directory, { recursive: true, force: true });
          await this.persist();
        } else {
          return publicUpload(existingClientUpload);
        }
      }
    }
    const destination = await inspectServerFilePath(targetPath, { allowMissing: true });
    if (destination.exists) {
      throw uploadError(409, "SERVER_FILE_ALREADY_EXISTS", "同名文件或文件夹已存在");
    }
    this.assertCapacity(owner);

    const id = `sfu-${crypto.randomUUID()}`;
    const directory = path.join(this.uploadsDirectory, id);
    const filePath = path.join(directory, "payload");
    const createdAt = this.now();
    const upload = {
      id,
      ownerId: owner,
      clientUploadId: clientId,
      parentPath: parent.path,
      targetPath,
      name: filename,
      totalBytes: bytes,
      uploadedBytes: 0,
      chunkBytes: this.chunkBytes,
      status: "uploading",
      contentHash: null,
      entry: null,
      directory,
      filePath,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      await fs.writeFile(filePath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      this.uploads.set(id, upload);
      await this.persist();
      if (bytes === 0) {
        this.busyUploads.add(id);
        try {
          await this.finish(upload);
        } finally {
          this.busyUploads.delete(id);
        }
      }
      return publicUpload(upload);
    } catch (error) {
      this.uploads.delete(id);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async status({ uploadId, ownerId } = {}) {
    this.assertInitialized();
    await this.pruneExpired();
    const upload = this.require(uploadId, ownerId);
    await this.recover(upload);
    return publicUpload(upload);
  }

  async append({ uploadId, ownerId, range, source } = {}) {
    this.assertInitialized();
    await this.pruneExpired();
    const upload = this.require(uploadId, ownerId);
    await this.recover(upload);
    if (upload.status === "complete") {
      return { ...publicUpload(upload), idempotent: true };
    }
    if (upload.status === "conflict") {
      throw uploadError(409, "SERVER_FILE_UPLOAD_CONFLICT", "上传目标已被其他文件占用，请重新选择目标名称");
    }
    if (this.busyUploads.has(upload.id)) {
      throw uploadError(409, "SERVER_FILE_UPLOAD_BUSY", "同一个文件已有上传分块正在处理");
    }
    const parsedRange = typeof range === "string" ? parseServerFileUploadRange(range) : range;
    validateRange(parsedRange, upload, this.chunkBytes);
    const body = Buffer.isBuffer(source) ? source : await collectBytes(source, parsedRange.length);
    if (body.length !== parsedRange.length) {
      throw uploadError(400, "SERVER_FILE_UPLOAD_CHUNK_SIZE", "上传分块长度与声明不一致");
    }

    this.busyUploads.add(upload.id);
    let handle = null;
    let committed = false;
    try {
      handle = await fs.open(upload.filePath, "r+");
      await writeAll(handle, body, parsedRange.start);
      await handle.sync();
      await handle.close();
      handle = null;
      upload.uploadedBytes = parsedRange.end + 1;
      upload.updatedAt = this.now();
      await this.persist();
      committed = true;
      if (upload.uploadedBytes === upload.totalBytes) await this.finish(upload);
      return publicUpload(upload);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (!committed) {
        await fs.truncate(upload.filePath, upload.uploadedBytes).catch(() => {});
      }
      throw error;
    } finally {
      this.busyUploads.delete(upload.id);
    }
  }

  async pruneExpired() {
    if (this.prunePromise) return this.prunePromise;
    this.prunePromise = this.pruneExpiredUnlocked().finally(() => {
      this.prunePromise = null;
    });
    return this.prunePromise;
  }

  async pruneExpiredUnlocked() {
    if (!this.initialized) return;
    const now = this.now();
    const expired = [...this.uploads.values()].filter((upload) => (
      upload.expiresAt <= now && !this.busyUploads.has(upload.id)
    ));
    if (!expired.length) return;
    for (const upload of expired) this.uploads.delete(upload.id);
    await Promise.all(expired.map((upload) => fs.rm(upload.directory, { recursive: true, force: true })));
    await this.persist();
  }

  require(uploadId, ownerId) {
    const id = String(uploadId || "");
    const upload = this.uploads.get(id);
    if (!upload || !UPLOAD_ID_PATTERN.test(id)) {
      throw uploadError(404, "SERVER_FILE_UPLOAD_NOT_FOUND", "上传会话不存在或已过期");
    }
    if (upload.ownerId !== normalizeOwnerId(ownerId)) {
      throw uploadError(404, "SERVER_FILE_UPLOAD_NOT_FOUND", "上传会话不存在或已过期");
    }
    if (upload.expiresAt <= this.now()) {
      throw uploadError(404, "SERVER_FILE_UPLOAD_NOT_FOUND", "上传会话不存在或已过期");
    }
    return upload;
  }

  assertCapacity(ownerId) {
    const active = [...this.uploads.values()].filter((upload) => upload.status !== "complete");
    if (active.length >= this.maxUploads) {
      throw uploadError(429, "SERVER_FILE_UPLOAD_CAPACITY", "服务器正在处理的上传数量已达到上限，请稍后重试");
    }
    const owned = active.filter((upload) => upload.ownerId === ownerId).length;
    if (owned >= this.maxUploadsPerOwner) {
      throw uploadError(429, "SERVER_FILE_UPLOAD_OWNER_CAPACITY", "当前账号正在处理的上传数量已达到上限");
    }
  }

  async recover(upload) {
    if (upload.status !== "finalizing" || this.busyUploads.has(upload.id)) return;
    this.busyUploads.add(upload.id);
    try {
      const target = await inspectServerFilePath(upload.targetPath, { allowMissing: true });
      if (target.exists) {
        if (
          target.stat.isFile()
          && !target.stat.isSymbolicLink()
          && upload.contentHash
          && (await hashFile(target.path)) === upload.contentHash
        ) {
          upload.status = "complete";
          upload.entry = serverFileEntry(target.path, target.stat);
          upload.updatedAt = this.now();
          await this.persist();
          await fs.rm(upload.directory, { recursive: true, force: true });
          return;
        }
        upload.status = "conflict";
        upload.updatedAt = this.now();
        await this.persist();
        return;
      }
      const payloadStat = await fs.stat(upload.filePath).catch(() => null);
      if (!payloadStat?.isFile() || payloadStat.size !== upload.totalBytes) {
        this.uploads.delete(upload.id);
        await fs.rm(upload.directory, { recursive: true, force: true });
        await this.persist();
        return;
      }
      upload.status = "uploading";
      upload.contentHash = null;
      upload.updatedAt = this.now();
      await this.persist();
      await this.finish(upload);
    } finally {
      this.busyUploads.delete(upload.id);
    }
  }

  async finish(upload) {
    if (upload.status === "complete") return;
    if (upload.uploadedBytes !== upload.totalBytes) {
      throw uploadError(409, "SERVER_FILE_UPLOAD_INCOMPLETE", "上传内容尚未完整");
    }
    upload.contentHash = await hashFile(upload.filePath);
    upload.status = "finalizing";
    upload.updatedAt = this.now();
    await this.persist();
    await this.materialize(upload);
    const stat = await fs.lstat(upload.targetPath);
    upload.status = "complete";
    upload.entry = serverFileEntry(upload.targetPath, stat);
    upload.updatedAt = this.now();
    await this.persist();
    await fs.rm(upload.directory, { recursive: true, force: true });
  }

  async materialize(upload) {
    const parent = await inspectServerFilePath(upload.parentPath);
    if (!parent.stat.isDirectory()) {
      throw uploadError(404, "SERVER_FILE_UPLOAD_PARENT_NOT_FOUND", "上传目标文件夹不存在");
    }
    const destination = await inspectServerFilePath(upload.targetPath, { allowMissing: true });
    if (destination.exists) {
      throw uploadError(409, "SERVER_FILE_ALREADY_EXISTS", "同名文件或文件夹已存在");
    }
    const temporary = path.join(parent.path, `.${upload.id}.wfl-upload`);
    await fs.rm(temporary, { force: true }).catch(() => {});
    try {
      await fs.copyFile(upload.filePath, temporary, fsConstants.COPYFILE_EXCL);
      await fs.chmod(temporary, 0o644);
      try {
        await fs.link(temporary, upload.targetPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw uploadError(409, "SERVER_FILE_ALREADY_EXISTS", "同名文件或文件夹已存在");
        }
        throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async persist() {
    const snapshot = {
      version: STORE_VERSION,
      uploads: [...this.uploads.values()].map(serializeUpload),
    };
    const operation = () => writeJsonAtomic(this.indexPath, snapshot);
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => {});
    await queued;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Server file upload store is not initialized");
  }
}

function serializeUpload(upload) {
  return {
    id: upload.id,
    ownerId: upload.ownerId,
    clientUploadId: upload.clientUploadId,
    parentPath: upload.parentPath,
    targetPath: upload.targetPath,
    name: upload.name,
    totalBytes: upload.totalBytes,
    uploadedBytes: upload.uploadedBytes,
    chunkBytes: upload.chunkBytes,
    status: upload.status,
    contentHash: upload.contentHash,
    entry: upload.entry,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
    expiresAt: upload.expiresAt,
  };
}

function deserializeUpload(value, store) {
  if (!value || typeof value !== "object" || !UPLOAD_ID_PATTERN.test(String(value.id || ""))) {
    throw new TypeError("invalid server file upload record");
  }
  const id = String(value.id);
  const targetPath = normalizeServerFilePath(value.targetPath);
  const parentPath = normalizeServerFilePath(value.parentPath);
  const name = normalizeServerFileName(value.name);
  if (path.dirname(targetPath) !== parentPath || path.basename(targetPath) !== name) {
    throw new TypeError("invalid server file upload target");
  }
  const totalBytes = boundedInteger(value.totalBytes, store.maxBytes, "SERVER_FILE_UPLOAD_SIZE_INVALID", "上传文件大小无效");
  const uploadedBytes = Number(value.uploadedBytes);
  if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0 || uploadedBytes > totalBytes) {
    throw new TypeError("invalid server file upload offset");
  }
  const status = ["uploading", "finalizing", "complete", "conflict"].includes(value.status)
    ? value.status
    : "uploading";
  const directory = path.join(store.uploadsDirectory, id);
  return {
    id,
    ownerId: normalizeOwnerId(value.ownerId),
    clientUploadId: normalizeClientUploadId(value.clientUploadId),
    parentPath,
    targetPath,
    name,
    totalBytes,
    uploadedBytes,
    chunkBytes: positiveInteger(value.chunkBytes, store.chunkBytes),
    status,
    contentHash: typeof value.contentHash === "string" ? value.contentHash : null,
    entry: value.entry && typeof value.entry === "object" ? value.entry : null,
    directory,
    filePath: path.join(directory, "payload"),
    createdAt: boundedTimestamp(value.createdAt),
    updatedAt: boundedTimestamp(value.updatedAt),
    expiresAt: boundedTimestamp(value.expiresAt),
  };
}

function publicUpload(upload) {
  return {
    uploadId: upload.id,
    clientUploadId: upload.clientUploadId,
    path: upload.targetPath,
    name: upload.name,
    totalBytes: upload.totalBytes,
    uploadedBytes: upload.uploadedBytes,
    offset: upload.uploadedBytes,
    chunkBytes: upload.chunkBytes,
    status: upload.status,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
    expiresAt: upload.expiresAt,
    ...(upload.status === "complete" && upload.entry ? { entry: upload.entry } : {}),
  };
}

function validateIndex(value) {
  if (!value || value.version !== STORE_VERSION || !Array.isArray(value.uploads)) {
    throw new TypeError("server file upload index is invalid");
  }
}

function validateRange(range, upload, chunkBytes) {
  if (
    !range
    || !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || !Number.isSafeInteger(range.total)
    || range.total !== upload.totalBytes
    || range.start !== upload.uploadedBytes
    || range.end < range.start
    || range.end >= upload.totalBytes
    || range.length > chunkBytes
  ) {
    const error = uploadError(409, "SERVER_FILE_UPLOAD_OFFSET_CONFLICT", `请从服务器记录的 ${upload.uploadedBytes} 字节继续上传`);
    error.currentOffset = upload.uploadedBytes;
    throw error;
  }
}

function normalizeOwnerId(value) {
  const owner = String(value || "");
  if (!owner || owner.length > 256 || /[\u0000-\u001f\u007f]/u.test(owner)) {
    throw uploadError(403, "SERVER_FILE_UPLOAD_OWNER_INVALID", "上传账号无效");
  }
  return owner;
}

function normalizeClientUploadId(value) {
  if (value === undefined || value === null || value === "") return null;
  const clientId = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(clientId)) {
    throw uploadError(400, "SERVER_FILE_UPLOAD_CLIENT_ID_INVALID", "客户端上传编号无效");
  }
  return clientId;
}

function boundedInteger(value, maximum, code, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw uploadError(number > maximum ? 413 : 400, code, message);
  }
  return number;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function boundedTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : Date.now();
}

async function collectBytes(source, expectedLength) {
  const chunks = [];
  let length = 0;
  for await (const value of source || []) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > expectedLength) throw uploadError(413, "SERVER_FILE_UPLOAD_CHUNK_TOO_LARGE", "上传分块超过声明长度");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!result.bytesWritten) throw new Error("上传分块写入失败");
    offset += result.bytesWritten;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    let position = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function uploadError(statusCode, code, message) {
  return new ServerFileUploadError(statusCode, code, message);
}
