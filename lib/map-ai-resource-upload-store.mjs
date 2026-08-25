import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_UPLOADS = 256;
const DEFAULT_MAX_UPLOADS_PER_BROWSER = 8;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const COMMIT_RECEIPT_PREFIX = ".commit-receipt-";
const COMMIT_RECEIPT_SCHEMA = "wfl.map-ai-resource-upload-commit.v1";
const EXTENSIONS = new Set([".tmj", ".tsj", ".tx", ".world", ".png", ".jpg", ".jpeg", ".webp"]);
const SHA256 = /^[a-f0-9]{64}$/iu;

/**
 * Chunked, browser-scoped staging for a managed map resource candidate.
 *
 * This store deliberately does not know how to publish a resource. It only
 * owns an upload until the caller validates it and copies it into the opaque
 * MapAiResourceCandidateStore. A session is bound to one editor window, map
 * version and relative destination so an upload cannot be replayed elsewhere.
 */
export class MapAiResourceUploadStore {
  constructor({
    temporaryRoot,
    authorizeSession = async () => {},
    now = Date.now,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxUploads = DEFAULT_MAX_UPLOADS,
    maxUploadsPerBrowser = DEFAULT_MAX_UPLOADS_PER_BROWSER,
    ttlMs = DEFAULT_TTL_MS,
  } = {}) {
    if (typeof temporaryRoot !== "string" || !path.isAbsolute(temporaryRoot)) throw new TypeError("temporaryRoot must be absolute");
    this.temporaryRoot = path.resolve(temporaryRoot);
    this.authorizeSession = typeof authorizeSession === "function" ? authorizeSession : async () => {};
    this.now = typeof now === "function" ? now : Date.now;
    this.chunkBytes = positiveInteger(chunkBytes, DEFAULT_CHUNK_BYTES);
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    this.maxUploads = positiveInteger(maxUploads, DEFAULT_MAX_UPLOADS);
    this.maxUploadsPerBrowser = positiveInteger(maxUploadsPerBrowser, DEFAULT_MAX_UPLOADS_PER_BROWSER);
    this.ttlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS);
    this.uploads = new Map();
    // A successful candidate registration is the durable success boundary of
    // the HTTP commit route. Keep a short-lived scoped receipt after the
    // browser staging payload has been removed so a lost response can be
    // retried without registering a second candidate.
    this.commitReceipts = new Map();
    this.rootRealPath = null;
    this.closed = false;
  }

  async initialize() {
    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.temporaryRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("temporaryRoot must be a real directory");
    await fs.chmod(this.temporaryRoot, 0o700);
    this.rootRealPath = await fs.realpath(this.temporaryRoot);
    await this.restoreCommitReceipts();
    return this;
  }

  async create({ identity, mapContext, editorStateId = 0, relativePath, baseVersion, totalBytes, totalHash, threadId } = {}) {
    this.assertReady();
    await this.pruneExpired();
    const normalizedIdentity = normalizeIdentity(identity);
    const context = normalizeMapContext(mapContext);
    const pathValue = normalizeRelativePath(relativePath);
    const version = normalizeBaseVersion(baseVersion);
    const bytes = boundedPositiveInteger(totalBytes, this.maxBytes, "MAP_AI_RESOURCE_UPLOAD_SIZE_INVALID", "资源候选大小无效");
    const hash = normalizeHash(totalHash, "资源候选哈希无效");
    const state = normalizeEditorStateId(editorStateId);
    const thread = normalizeThreadId(threadId);
    this.assertCapacity(normalizedIdentity);
    await this.authorizeSession({ purpose: "resource-upload-create", identity: normalizedIdentity, mapContext: context, editorStateId: state, relativePath: pathValue, baseVersion: version, totalBytes: bytes, threadId: thread });
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, "upload-"));
    await fs.chmod(directory, 0o700);
    const filePath = path.join(directory, "payload");
    let handle;
    try {
      handle = await fs.open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.close();
      handle = null;
      const createdAt = this.now();
      const upload = {
        id: crypto.randomBytes(24).toString("base64url"),
        identity: normalizedIdentity,
        mapContext: context,
        editorStateId: state,
        relativePath: pathValue,
        baseVersion: version,
        threadId: thread,
        totalBytes: bytes,
        totalHash: hash,
        chunkBytes: this.chunkBytes,
        chunkCount: Math.ceil(bytes / this.chunkBytes),
        nextIndex: 0,
        uploadedBytes: 0,
        directory,
        filePath,
        status: "uploading",
        busy: false,
        leases: 0,
        pendingRemoval: false,
        createdAt,
        updatedAt: createdAt,
        expiresAt: createdAt + this.ttlMs,
      };
      this.uploads.set(upload.id, upload);
      return publicUpload(upload);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async append({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId, index, source, contentLength, chunkHash } = {}) {
    this.assertReady();
    await this.pruneExpired();
    const upload = this.require({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId });
    if (upload.status !== "uploading") throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_FINALIZED", "资源候选上传已经完成");
    if (upload.busy) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_BUSY", "资源候选正在处理另一个分块");
    const chunkIndex = Number(index);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== upload.nextIndex || chunkIndex < 0 || chunkIndex >= upload.chunkCount) {
      throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHUNK_ORDER", `资源候选必须从分块 ${upload.nextIndex} 继续上传`);
    }
    const expected = Math.min(this.chunkBytes, upload.totalBytes - chunkIndex * this.chunkBytes);
    const declaredLength = contentLength === undefined || contentLength === "" ? null : Number(contentLength);
    if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength !== expected)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_CHUNK_SIZE", `资源候选分块 ${chunkIndex} 长度不匹配`);
    const expectedHash = normalizeHash(chunkHash, "资源候选分块哈希无效");
    upload.busy = true;
    let handle;
    let bytes = 0;
    const hash = crypto.createHash("sha256");
    try {
      handle = await this.openPayload(upload, fsConstants.O_WRONLY | fsConstants.O_APPEND, upload.uploadedBytes);
      for await (const value of byteSource(source)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > expected) throw uploadError(413, "MAP_AI_RESOURCE_UPLOAD_CHUNK_TOO_LARGE", "资源候选分块超过声明长度");
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      if (bytes !== expected) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_CHUNK_SIZE", `资源候选分块 ${chunkIndex} 长度不匹配`);
      const actualHash = hash.digest("hex");
      if (actualHash !== expectedHash) {
        await handle.truncate(upload.uploadedBytes);
        throw uploadError(422, "MAP_AI_RESOURCE_UPLOAD_CHUNK_HASH", `资源候选分块 ${chunkIndex} 哈希校验失败`);
      }
      await handle.sync();
      upload.nextIndex += 1;
      upload.uploadedBytes += bytes;
      upload.updatedAt = this.now();
      return { uploadId: upload.id, index: chunkIndex, bytes, hash: actualHash, uploadedBytes: upload.uploadedBytes, uploadedChunks: upload.nextIndex, chunkCount: upload.chunkCount };
    } catch (error) {
      if (handle) await handle.truncate(upload.uploadedBytes).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      upload.busy = false;
      await this.cleanupPending(upload);
    }
  }

  async finalize({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId, validate } = {}) {
    this.assertReady();
    await this.pruneExpired();
    const upload = this.require({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId });
    if (upload.status === "finalized") return publicUpload(upload);
    if (upload.busy) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_BUSY", "资源候选正在处理另一个分块");
    if (upload.nextIndex !== upload.chunkCount || upload.uploadedBytes !== upload.totalBytes) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_INCOMPLETE", "资源候选分块尚未上传完整");
    upload.busy = true;
    try {
      await this.authorizeSession({ purpose: "resource-upload-finalize", identity: upload.identity, mapContext: upload.mapContext, editorStateId: upload.editorStateId, relativePath: upload.relativePath, baseVersion: upload.baseVersion, totalBytes: upload.totalBytes, threadId: upload.threadId });
      const inspected = await this.inspectPayload(upload);
      if (inspected.sha256 !== upload.totalHash) throw uploadError(422, "MAP_AI_RESOURCE_UPLOAD_HASH", "资源候选完整哈希校验失败");
      await validate?.({ path: upload.filePath, relativePath: upload.relativePath, baseVersion: upload.baseVersion, size: inspected.size, sha256: inspected.sha256 });
      // Browser-close, logout and TTL cleanup may request removal while the
      // validator is running.  Do not turn that race into a finalized upload:
      // the caller must retry from a fresh candidate instead of publishing a
      // resource that the owning editor has already abandoned.
      if (upload.pendingRemoval) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CANCELED", "资源候选上传已被清理，请重新上传");
      upload.status = "finalized";
      upload.metadata = inspected;
      upload.updatedAt = this.now();
      return publicUpload(upload);
    } finally {
      upload.busy = false;
      await this.cleanupPending(upload);
    }
  }

  async openSource({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId } = {}) {
    this.assertReady();
    await this.pruneExpired();
    const upload = this.require({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId });
    if (upload.status !== "finalized" || !upload.metadata) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_NOT_READY", "资源候选尚未完成校验");
    upload.leases = (upload.leases || 0) + 1;
    upload.updatedAt = this.now();
    try {
      // Acquire the source lease before the asynchronous re-authorization.
      // Browser-close/TTL cleanup can run during that callback; the lease is
      // what keeps the private payload alive until the candidate store has
      // finished copying it.
      await this.authorizeSession({ purpose: "resource-upload-source", identity: upload.identity, mapContext: upload.mapContext, editorStateId: upload.editorStateId, relativePath: upload.relativePath, baseVersion: upload.baseVersion, totalBytes: upload.totalBytes, threadId: upload.threadId });
      const current = await this.inspectPayload(upload);
      if (this.uploads.get(upload.id) !== upload) {
        throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
      }
      if (current.sha256 !== upload.metadata.sha256 || current.size !== upload.metadata.size) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHANGED", "资源候选暂存内容已变化");
      const result = { metadata: publicUpload(upload) };
      Object.defineProperty(result, "sourcePath", { value: upload.filePath, enumerable: false, writable: false });
      let released = false;
      Object.defineProperty(result, "release", { value: async () => {
        if (released) return;
        released = true;
        upload.leases = Math.max(0, (upload.leases || 1) - 1);
        upload.updatedAt = this.now();
        await this.cleanupPending(upload);
      }, enumerable: false, writable: false });
      return Object.freeze(result);
    } catch (error) {
      upload.leases = Math.max(0, (upload.leases || 1) - 1);
      await this.cleanupPending(upload);
      throw error;
    }
  }

  async delete({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId } = {}) {
    const upload = this.require({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId });
    await this.remove(upload.id);
    return { deleted: true, uploadId: upload.id };
  }

  /**
   * Cleanup after a candidate has been copied into the opaque candidate
   * store.  This intentionally does not re-check the mutable map version:
   * the candidate registration already completed its own binding checks and
   * a later map edit must not turn a successful registration into a retry that
   * can create duplicates.  The upload id, browser identity and Thread are
   * still required so this is not a general-purpose delete primitive.
   */
  async releaseAfterCandidate({ uploadId, identity, threadId } = {}) {
    this.assertReady();
    const upload = this.uploads.get(String(uploadId || ""));
    const normalizedIdentity = normalizeIdentity(identity);
    if (!upload) return { deleted: false, uploadId: String(uploadId || "") };
    if (!sameIdentity(upload.identity, normalizedIdentity)) throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
    if (normalizeThreadId(threadId) !== upload.threadId) throw uploadError(403, "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH", "资源候选上传不属于当前对话");
    // This is called only after the opaque candidate store has already
    // copied the source.  A browser-close/user-cleanup race may have marked
    // the upload `aborted` while its source lease is still held; cleanup must
    // remain idempotent in that case and must not turn a successful candidate
    // registration into a failed HTTP response.
    if (upload.status !== "finalized" && !(upload.status === "aborted" && upload.pendingRemoval)) {
      throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_NOT_READY", "资源候选尚未完成校验");
    }
    await this.remove(upload.id);
    return { deleted: true, uploadId: upload.id };
  }

  async commitCandidate({ uploadId, identity, threadId, mapSessionId, mapVersion, editorStateId, candidate } = {}) {
    this.assertReady();
    const id = String(uploadId || "");
    const normalizedIdentity = normalizeIdentity(identity);
    const thread = normalizeThreadId(threadId);
    const existing = this.commitReceipts.get(id);
    if (existing) {
      if (!sameIdentity(existing.identity, normalizedIdentity) || existing.threadId !== thread) {
        throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
      }
      if (String(mapSessionId || "") !== existing.mapSessionId
        || String(mapVersion || "") !== existing.mapVersion
        || normalizeEditorStateId(editorStateId) !== existing.editorStateId) {
        throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CONTEXT_CONFLICT", "资源候选上传所属地图或编辑状态已变化");
      }
      return { committed: true, idempotent: true, uploadId: id, candidate: existing.candidate };
    }
    const upload = this.uploads.get(id);
    if (!upload) throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
    if (!sameIdentity(upload.identity, normalizedIdentity)) throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
    if (upload.threadId !== thread) throw uploadError(403, "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH", "资源候选上传不属于当前对话");
    if (String(mapSessionId || "") !== upload.mapContext.mapSessionId
      || String(mapVersion || "") !== upload.mapContext.version
      || normalizeEditorStateId(editorStateId) !== upload.editorStateId) {
      throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CONTEXT_CONFLICT", "资源候选上传所属地图或编辑状态已变化");
    }
    if (!candidate || typeof candidate !== "object" || typeof candidate.candidateId !== "string") {
      throw uploadError(500, "MAP_AI_RESOURCE_UPLOAD_CANDIDATE_INVALID", "资源候选注册结果无效");
    }
    // The candidate store is server-owned, but keep the upload commit
    // boundary self-checking as well.  A wiring mistake or a stale callback
    // must not let a candidate for another destination/version be attached
    // to this upload's durable receipt.
    const expectedSize = upload.metadata?.size ?? upload.totalBytes;
    const expectedHash = upload.metadata?.sha256 ?? upload.totalHash;
    if (candidate.path !== upload.relativePath
      || candidate.baseVersion !== upload.baseVersion
      || Number(candidate.size) !== expectedSize
      || String(candidate.sha256 || "").toLowerCase() !== expectedHash) {
      throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CANDIDATE_SCOPE_MISMATCH", "资源候选注册结果与上传范围不一致");
    }
    const receipt = Object.freeze({
      identity: normalizedIdentity,
      threadId: thread,
      mapSessionId: upload.mapContext.mapSessionId,
      mapVersion: upload.mapContext.version,
      editorStateId: upload.editorStateId,
      projectPath: upload.mapContext.projectPath,
      candidate: Object.freeze({ ...candidate }),
      expiresAt: this.now() + this.ttlMs,
    });
    await writeCommitReceipt(this.temporaryRoot, id, receipt);
    this.commitReceipts.set(id, receipt);
    await this.remove(id);
    return { committed: true, idempotent: false, uploadId: id, candidate: receipt.candidate };
  }

  committedCandidate({ uploadId, identity, threadId, mapSessionId, mapVersion, editorStateId, projectPath } = {}) {
    this.assertReady();
    const id = String(uploadId || "");
    const receipt = this.commitReceipts.get(id);
    if (!receipt || receipt.expiresAt <= this.now()) {
      if (receipt) this.commitReceipts.delete(id);
      return null;
    }
    const normalizedIdentity = normalizeIdentity(identity);
    if (!sameIdentity(receipt.identity, normalizedIdentity)) return null;
    if (normalizeThreadId(threadId) !== receipt.threadId) throw uploadError(403, "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH", "资源候选上传不属于当前对话");
    if (String(mapSessionId || "") !== receipt.mapSessionId
      || String(mapVersion || "") !== receipt.mapVersion
      || normalizeEditorStateId(editorStateId) !== receipt.editorStateId
      || path.resolve(String(projectPath || "")) !== receipt.projectPath) {
      throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CONTEXT_CONFLICT", "资源候选上传所属地图或编辑状态已变化");
    }
    return { committed: true, idempotent: true, uploadId: id, candidate: receipt.candidate };
  }

  forgetCommitReceipt({ uploadId, identity, threadId, mapSessionId, mapVersion, editorStateId } = {}) {
    this.assertReady();
    const id = String(uploadId || "");
    const receipt = this.commitReceipts.get(id);
    if (!receipt) return false;
    const normalizedIdentity = normalizeIdentity(identity);
    if (!sameIdentity(receipt.identity, normalizedIdentity) || normalizeThreadId(threadId) !== receipt.threadId) {
      throw uploadError(403, "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH", "资源候选上传不属于当前对话");
    }
    if (String(mapSessionId || "") !== receipt.mapSessionId
      || String(mapVersion || "") !== receipt.mapVersion
      || normalizeEditorStateId(editorStateId) !== receipt.editorStateId) {
      throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CONTEXT_CONFLICT", "资源候选上传所属地图或编辑状态已变化");
    }
    this.commitReceipts.delete(id);
    void fs.rm(commitReceiptPath(this.temporaryRoot, id), { force: true }).catch(() => {});
    return true;
  }

  async deleteForBrowserSession({ userId, browserSessionId } = {}) {
    const ids = [...this.uploads.values()].filter((entry) => entry.identity.userId === String(userId || "") && entry.identity.browserSessionId === String(browserSessionId || "")).map((entry) => entry.id);
    await Promise.all(ids.map((id) => this.remove(id)));
    for (const [id, receipt] of this.commitReceipts) {
      if (receipt.identity.userId === String(userId || "") && receipt.identity.browserSessionId === String(browserSessionId || "")) {
        this.commitReceipts.delete(id);
        await fs.rm(commitReceiptPath(this.temporaryRoot, id), { force: true }).catch(() => {});
      }
    }
    return Object.freeze({ deleted: ids.length });
  }

  async deleteForUser({ userId } = {}) {
    const ids = [...this.uploads.values()].filter((entry) => entry.identity.userId === String(userId || "")).map((entry) => entry.id);
    await Promise.all(ids.map((id) => this.remove(id)));
    for (const [id, receipt] of this.commitReceipts) {
      if (receipt.identity.userId === String(userId || "")) {
        this.commitReceipts.delete(id);
        await fs.rm(commitReceiptPath(this.temporaryRoot, id), { force: true }).catch(() => {});
      }
    }
    return Object.freeze({ deleted: ids.length });
  }

  async pruneExpired() {
    const now = this.now();
    for (const [id, receipt] of this.commitReceipts) {
      if (receipt.expiresAt <= now) {
        this.commitReceipts.delete(id);
        await fs.rm(commitReceiptPath(this.temporaryRoot, id), { force: true }).catch(() => {});
      }
    }
    const ids = [...this.uploads.values()].filter((entry) => entry.expiresAt <= now && !entry.busy).map((entry) => entry.id);
    await Promise.all(ids.map((id) => this.remove(id)));
    return ids.length;
  }

  async remove(id) {
    const upload = this.uploads.get(id);
    if (!upload) return false;
    if (upload.busy || (upload.leases || 0) > 0) {
      upload.pendingRemoval = true;
      upload.status = "aborted";
      upload.updatedAt = this.now();
      return true;
    }
    this.uploads.delete(id);
    await fs.rm(upload.directory, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async cleanupPending(upload) {
    if (!upload?.pendingRemoval || upload.busy || (upload.leases || 0) > 0) return false;
    upload.pendingRemoval = false;
    return this.remove(upload.id);
  }

  async close() {
    this.closed = true;
    const uploads = [...this.uploads.values()];
    this.uploads.clear();
    // Commit receipts are intentionally left on disk. A graceful restart
    // must still answer a retry for a commit whose HTTP response was lost.
    this.commitReceipts.clear();
    await Promise.all(uploads.map((entry) => fs.rm(entry.directory, { recursive: true, force: true }).catch(() => {})));
  }

  snapshot({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId } = {}) {
    return publicUpload(this.require({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId }));
  }

  status() {
    return { uploads: this.uploads.size, bytes: [...this.uploads.values()].reduce((sum, entry) => sum + entry.uploadedBytes, 0) };
  }

  assertReady() {
    if (this.closed || !this.rootRealPath) throw uploadError(503, "MAP_AI_RESOURCE_UPLOAD_CLOSED", "资源候选上传服务当前不可用");
  }

  async restoreCommitReceipts() {
    const entries = await fs.readdir(this.temporaryRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(COMMIT_RECEIPT_PREFIX) || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(COMMIT_RECEIPT_PREFIX.length, -5);
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(id)) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(this.temporaryRoot, entry.name), "utf8"));
        const receipt = normalizeCommitReceipt(value);
        if (receipt.expiresAt <= this.now()) {
          await fs.rm(path.join(this.temporaryRoot, entry.name), { force: true });
          continue;
        }
        this.commitReceipts.set(id, receipt);
      } catch {
        await fs.rm(path.join(this.temporaryRoot, entry.name), { force: true }).catch(() => {});
      }
    }
  }

  assertCapacity(identity) {
    if (this.uploads.size >= this.maxUploads) throw uploadError(429, "MAP_AI_RESOURCE_UPLOAD_CAPACITY", "资源候选上传已达到总数上限");
    const count = [...this.uploads.values()].filter((entry) => sameBrowser(entry.identity, identity)).length;
    if (count >= this.maxUploadsPerBrowser) throw uploadError(429, "MAP_AI_RESOURCE_UPLOAD_BROWSER_CAPACITY", "当前浏览器的资源候选上传已达到上限");
  }

  require({ uploadId, identity, mapSessionId, mapVersion, editorStateId, threadId } = {}) {
    const upload = this.uploads.get(String(uploadId || ""));
    const normalizedIdentity = normalizeIdentity(identity);
    if (!upload || upload.pendingRemoval || !sameIdentity(upload.identity, normalizedIdentity)) {
      throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
    }
    if (upload.expiresAt <= this.now() && !upload.busy) {
      void this.remove(upload.id).catch(() => {});
      throw uploadError(404, "MAP_AI_RESOURCE_UPLOAD_NOT_FOUND", "资源候选上传不存在或已过期");
    }
    if (String(mapSessionId || "") !== upload.mapContext.mapSessionId || String(mapVersion || "") !== upload.mapContext.version || normalizeEditorStateId(editorStateId) !== upload.editorStateId) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CONTEXT_CONFLICT", "资源候选上传所属地图或编辑状态已变化");
    // Thread binding is mandatory for every lifecycle operation.  A browser
    // window may own several uploads at once, but an upload must never be
    // readable, appendable, finalized or deleted by another conversation (or
    // by a request that omitted the conversation altogether).
    if (normalizeThreadId(threadId) !== upload.threadId) throw uploadError(403, "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH", "资源候选上传不属于当前对话");
    return upload;
  }

  async inspectPayload(upload) {
    await assertSafeDirectory(this.rootRealPath, upload.directory);
    const handle = await fs.open(upload.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== upload.totalBytes) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHANGED", "资源候选暂存文件已变化");
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.min(this.chunkBytes, Math.max(1, before.size)));
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!bytesRead) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHANGED", "资源候选暂存文件读取提前结束");
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHANGED", "资源候选暂存文件在读取期间发生变化");
      return { size: before.size, sha256: hash.digest("hex") };
    } finally { await handle.close(); }
  }

  async openPayload(upload, flags, expectedSize) {
    await assertSafeDirectory(this.rootRealPath, upload.directory);
    const handle = await fs.open(upload.filePath, flags | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize) { await handle.close(); throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHANGED", "资源候选暂存文件已变化"); }
    return handle;
  }
}

export class MapAiResourceUploadError extends Error {
  constructor(statusCode, code, message) { super(message); this.name = "MapAiResourceUploadError"; this.statusCode = statusCode; this.code = code; }
}

function publicUpload(entry) {
  return Object.freeze({
    uploadId: entry.id,
    path: entry.relativePath,
    baseVersion: entry.baseVersion,
    totalBytes: entry.totalBytes,
    totalHash: entry.totalHash,
    chunkBytes: entry.chunkBytes || undefined,
    chunkCount: entry.chunkCount,
    uploadedBytes: entry.uploadedBytes,
    uploadedChunks: entry.nextIndex,
    status: entry.status,
    metadata: entry.metadata ? { ...entry.metadata } : null,
    mapSessionId: entry.mapContext.mapSessionId,
    mapVersion: entry.mapContext.version,
    threadId: entry.threadId,
    editorStateId: entry.editorStateId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
  });
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  const editorInstanceId = String(value?.editorInstanceId || "");
  if (!userId || !browserSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(editorInstanceId)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_IDENTITY_INVALID", "资源候选上传身份无效");
  return { userId, browserSessionId, editorInstanceId };
}
function sameIdentity(left, right) { return left.userId === right.userId && left.browserSessionId === right.browserSessionId && left.editorInstanceId === right.editorInstanceId; }
function sameBrowser(left, right) { return left.userId === right.userId && left.browserSessionId === right.browserSessionId; }
function normalizeMapContext(value) {
  const mapSessionId = String(value?.mapSessionId || "");
  const version = String(value?.version || "").toLowerCase();
  const projectPath = String(value?.projectPath || "");
  if (!mapSessionId || !/^[a-f0-9]{64}$/u.test(version) || !path.isAbsolute(projectPath)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_CONTEXT_INVALID", "资源候选上传地图上下文无效");
  return Object.freeze({ mapSessionId, version, projectPath: path.resolve(projectPath) });
}
function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_PATH_INVALID", "资源候选路径必须是工程相对路径");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || !EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_PATH_INVALID", "资源候选路径无效或扩展名不受支持");
  return normalized;
}
function normalizeBaseVersion(value) { if (value === null) return null; const hash = String(value || "").toLowerCase(); if (!SHA256.test(hash)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_VERSION_INVALID", "资源候选基础版本必须是 SHA-256 或 null"); return hash; }
function normalizeHash(value, label) { const hash = String(value || "").toLowerCase(); if (!SHA256.test(hash)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_HASH_INVALID", label); return hash; }
function normalizeEditorStateId(value) { const id = value === undefined || value === null || value === "" ? 0 : Number(value); if (!Number.isSafeInteger(id) || id < 0) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_EDITOR_STATE_INVALID", "编辑状态标识无效"); return id; }
function normalizeThreadId(value) { const id = String(value || ""); if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_THREAD_INVALID", "资源候选对话标识无效"); return id; }
function positiveInteger(value, fallback) { const number = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError("positive integer required"); return number; }
function boundedPositiveInteger(value, maximum, code, message) { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw uploadError(400, code, message); if (number > maximum) throw uploadError(413, "MAP_AI_RESOURCE_UPLOAD_SIZE_LIMIT", "资源候选超过管理员设置的大小上限"); return number; }
function byteSource(source) { if (Buffer.isBuffer(source) || source instanceof Uint8Array) return [source]; if (source && typeof source[Symbol.asyncIterator] === "function") return source; throw uploadError(400, "MAP_AI_RESOURCE_UPLOAD_BODY_INVALID", "资源候选分块请求体无效"); }
async function writeAll(handle, value) { let offset = 0; while (offset < value.length) { const result = await handle.write(value, offset, value.length - offset); if (!result.bytesWritten) throw uploadError(500, "MAP_AI_RESOURCE_UPLOAD_WRITE_FAILED", "资源候选临时文件写入中断"); offset += result.bytesWritten; } }
async function assertSafeDirectory(root, directory) { const resolved = path.resolve(directory); if (!isWithin(root, resolved) || resolved === root) throw uploadError(403, "MAP_AI_RESOURCE_UPLOAD_PATH_INVALID", "资源候选临时目录无效"); const stat = await fs.lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw uploadError(409, "MAP_AI_RESOURCE_UPLOAD_CHANGED", "资源候选临时目录已变化"); }
function isWithin(root, candidate) { const relative = path.relative(root, candidate); return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function uploadError(statusCode, code, message) { return new MapAiResourceUploadError(statusCode, code, message); }

function commitReceiptPath(root, uploadId) {
  return path.join(root, `${COMMIT_RECEIPT_PREFIX}${String(uploadId)}.json`);
}

async function writeCommitReceipt(root, uploadId, receipt) {
  const value = {
    schema: COMMIT_RECEIPT_SCHEMA,
    identity: receipt.identity,
    threadId: receipt.threadId,
    mapSessionId: receipt.mapSessionId,
    mapVersion: receipt.mapVersion,
    editorStateId: receipt.editorStateId,
    projectPath: receipt.projectPath,
    candidate: receipt.candidate,
    expiresAt: receipt.expiresAt,
  };
  const temporary = `${commitReceiptPath(root, uploadId)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, commitReceiptPath(root, uploadId));
}

function normalizeCommitReceipt(value) {
  if (!value || value.schema !== COMMIT_RECEIPT_SCHEMA || !value.identity || typeof value.candidate?.candidateId !== "string") {
    throw new Error("invalid commit receipt");
  }
  const identity = normalizeIdentity(value.identity);
  const threadId = normalizeThreadId(value.threadId);
  const mapSessionId = String(value.mapSessionId || "");
  const mapVersion = String(value.mapVersion || "").toLowerCase();
  const editorStateId = normalizeEditorStateId(value.editorStateId);
  const rawProjectPath = String(value.projectPath || "");
  if (!path.isAbsolute(rawProjectPath) || rawProjectPath.includes("\0")) throw new Error("invalid commit receipt project");
  const projectPath = path.resolve(rawProjectPath);
  const expiresAt = Number(value.expiresAt);
  if (!mapSessionId || !SHA256.test(mapVersion) || !Number.isSafeInteger(expiresAt)) throw new Error("invalid commit receipt scope");
  const candidate = normalizeReceiptCandidate(value.candidate);
  return Object.freeze({
    identity,
    threadId,
    mapSessionId,
    mapVersion,
    editorStateId,
    projectPath,
    candidate,
    expiresAt,
  });
}

function normalizeReceiptCandidate(value) {
  const candidateId = String(value?.candidateId || "");
  const relativePath = String(value?.path || "");
  const size = Number(value?.size);
  const sha256 = String(value?.sha256 || "").toLowerCase();
  const baseVersion = value?.baseVersion === null ? null : String(value?.baseVersion || "").toLowerCase();
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(candidateId)
    || !relativePath
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/iu.test(relativePath)
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
    || (!EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()) && !relativePath.toLowerCase().endsWith(".character.json"))
    || !Number.isSafeInteger(size)
    || size <= 0
    || !SHA256.test(sha256)
    || (baseVersion !== null && !SHA256.test(baseVersion))) {
    throw new Error("invalid commit receipt candidate");
  }
  return Object.freeze({
    candidateId,
    path: relativePath,
    baseVersion,
    size,
    sha256,
    ...(typeof value.mediaType === "string" && value.mediaType.length <= 128 ? { mediaType: value.mediaType } : {}),
    ...(Number.isSafeInteger(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
    ...(Number.isSafeInteger(Number(value.updatedAt)) ? { updatedAt: Number(value.updatedAt) } : {}),
    ...(Number.isSafeInteger(Number(value.expiresAt)) ? { expiresAt: Number(value.expiresAt) } : {}),
  });
}
