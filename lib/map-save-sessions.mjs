import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMapFile } from "./map-file-sessions.mjs";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_MAX_SESSIONS_PER_BROWSER = 4;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_COMMIT_CONCURRENCY = 1;
const DEFAULT_VALIDATION_MEMORY_MB = 256;
const DEFAULT_VALIDATION_TIMEOUT_MS = 60_000;
const VALIDATOR_OUTPUT_LIMIT = 4 * 1024 * 1024;
const VALIDATOR_PATH = fileURLToPath(new URL("../scripts/validate-tiled-map.mjs", import.meta.url));

export class MapSaveSessionError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapSaveSessionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class MapSaveSessionStore {
  constructor(options = {}) {
    this.temporaryRoot = normalizeTemporaryRoot(options.temporaryRoot);
    this.chunkBytes = positiveInteger(options.chunkBytes, DEFAULT_CHUNK_BYTES, "chunkBytes");
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
    this.maxSessionsPerBrowser = positiveInteger(
      options.maxSessionsPerBrowser,
      DEFAULT_MAX_SESSIONS_PER_BROWSER,
      "maxSessionsPerBrowser",
    );
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
    this.validationMemoryMb = positiveInteger(
      options.validationMemoryMb,
      DEFAULT_VALIDATION_MEMORY_MB,
      "validationMemoryMb",
    );
    this.validationTimeoutMs = positiveInteger(
      options.validationTimeoutMs,
      DEFAULT_VALIDATION_TIMEOUT_MS,
      "validationTimeoutMs",
    );
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.validateCandidate = typeof options.validateCandidate === "function"
      ? options.validateCandidate
      : inspectTiledDocumentInChild;
    this.sessions = new Map();
    this.operationKeys = new Map();
    this.targetLocks = new Map();
    this.commitConcurrency = positiveInteger(
      options.commitConcurrency,
      DEFAULT_COMMIT_CONCURRENCY,
      "commitConcurrency",
    );
    this.commitQueue = new SnapshotConcurrencyQueue(this.commitConcurrency);
    this.beginQueue = Promise.resolve();
  }

  begin(input) {
    const operation = this.beginQueue.then(
      () => this.beginUnlocked(input),
      () => this.beginUnlocked(input),
    );
    this.beginQueue = operation.catch(() => {});
    return operation;
  }

  async beginUnlocked(input) {
    await this.pruneExpired();
    const identity = normalizeIdentity(input?.identity);
    const mapContext = normalizeMapContext(input?.mapContext);
    if (!mapContext.writable) throw saveError(403, "map-read-only", "当前地图会话是只读的");
    const expectedVersion = normalizeSha256(input?.expectedVersion, "地图基础版本");
    if (expectedVersion !== mapContext.version) {
      throw saveError(409, "map-version-conflict", "地图基础版本不匹配，请重新打开地图");
    }
    const totalBytes = Number(input?.totalBytes);
    const config = normalizeSessionConfig(input?.config, {
      chunkBytes: this.chunkBytes,
      maxBytes: this.maxBytes,
      validationMemoryMb: this.validationMemoryMb,
      validationTimeoutMs: this.validationTimeoutMs,
      commitConcurrency: this.commitConcurrency,
    });
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw saveError(400, "invalid-map-save-size", "地图保存字节数无效");
    }
    if (totalBytes > config.maxBytes) {
      throw saveError(413, "map-save-size-limit", "地图超过管理员设置的单次保存上限");
    }
    const totalHash = normalizeSha256(input?.totalHash, "地图内容哈希");
    const clientOperationId = normalizeOperationId(input?.clientOperationId);
    const operationKey = saveOperationKey(identity, mapContext.mapSessionId, clientOperationId);
    const existingId = this.operationKeys.get(operationKey);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && sameSaveRequest(existing, { expectedVersion, totalBytes, totalHash })) {
        return publicSaveSession(existing, this.commitQueue);
      }
      throw saveError(409, "map-save-operation-conflict", "保存操作标识已用于不同内容");
    }
    this.assertCapacity(identity);

    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, "save-"));
    await fs.chmod(directory, 0o700);
    const createdAt = this.now();
    const session = {
      id: crypto.randomBytes(24).toString("base64url"),
      identity,
      mapContext,
      expectedVersion,
      totalBytes,
      totalHash,
      clientOperationId,
      operationKey,
      chunkCount: Math.ceil(totalBytes / config.chunkBytes),
      chunks: new Map(),
      directory,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: "uploading",
      result: null,
      commitPromise: null,
      closeRequested: false,
      config: Object.freeze({ ...config, ttlMs: this.ttlMs }),
    };
    this.sessions.set(session.id, session);
    this.operationKeys.set(operationKey, session.id);
    return publicSaveSession(session, this.commitQueue);
  }

  async uploadChunk(input) {
    await this.pruneExpired();
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    if (session.result) return { saveId: session.id, committed: true, idempotent: true };
    if (session.status === "committing") {
      throw saveError(409, "map-save-committing", "地图保存正在提交，不能继续上传分块");
    }
    const index = Number(input?.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunkCount) {
      throw saveError(400, "invalid-map-save-chunk", "地图保存分块序号无效");
    }
    const expectedBytes = expectedChunkBytes(session, index);
    const contentLength = input?.contentLength === undefined || input?.contentLength === ""
      ? (bufferLength(input?.source) ?? expectedBytes)
      : Number(input.contentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
      throw saveError(400, "invalid-map-save-chunk-size", `地图保存分块 ${index} 长度不匹配`);
    }
    const declaredHash = normalizeSha256(input?.chunkHash, "地图分块哈希");
    const incomingPath = path.join(
      session.directory,
      `.incoming-${index}-${crypto.randomBytes(6).toString("hex")}`,
    );
    let handle;
    try {
      handle = await fs.open(incomingPath, "wx", 0o600);
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      for await (const value of byteSource(input?.source)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > expectedBytes) {
          throw saveError(413, "map-save-chunk-too-large", `地图保存分块 ${index} 超出固定长度`);
        }
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      if (bytes !== expectedBytes) {
        throw saveError(400, "invalid-map-save-chunk-size", `地图保存分块 ${index} 长度不匹配`);
      }
      const actualHash = hash.digest("hex");
      if (actualHash !== declaredHash) {
        throw saveError(422, "map-save-chunk-hash", `地图保存分块 ${index} 哈希校验失败`);
      }
      await handle.sync();
      await handle.close();
      handle = null;

      const finalPath = chunkPath(session, index);
      let idempotent = false;
      try {
        await fs.link(incomingPath, finalPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await hashFile(finalPath);
        if (existing.size !== expectedBytes || existing.hash !== actualHash) {
          throw saveError(409, "map-save-chunk-conflict", `地图保存分块 ${index} 已存在不同内容`);
        }
        idempotent = true;
      }
      session.chunks.set(index, { bytes, hash: actualHash });
      session.status = "uploading";
      return {
        saveId: session.id,
        index,
        bytes,
        hash: actualHash,
        uploadedChunks: session.chunks.size,
        chunkCount: session.chunkCount,
        idempotent,
      };
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(incomingPath, { force: true }).catch(() => {});
    }
  }

  async commit(input) {
    await this.pruneExpired();
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    if (session.result) return session.result;
    if (session.commitPromise) return session.commitPromise;
    session.status = "queued";
    session.commitPromise = this.commitQueue.run(() => this.withTargetLock(
      session.mapContext.targetPath,
      () => this.commitUnlocked(session, input?.authorize),
    ), session.config.commitConcurrency);
    try {
      return await session.commitPromise;
    } finally {
      session.commitPromise = null;
      if (session.closeRequested) {
        this.removeSession(session);
        await removeDirectory(session.directory);
        session.directory = null;
      } else if (!session.result && session.status !== "uploading") {
        session.status = "uploading";
      }
    }
  }

  /**
   * Materialize and validate a chunked map candidate without replacing the
   * target.  Project-level multi-file transactions use this hand-off to copy
   * the candidate into their own journaled staging directory.  The returned
   * path remains private to the server and is removed when the save session is
   * aborted, expires, or is cleared.
   */
  async prepareCandidate(input) {
    await this.pruneExpired();
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    if (session.result) throw saveError(409, "map-save-committed", "地图保存已经提交，不能再次生成候选");
    if (session.commitPromise || session.status === "committing" || session.status === "queued") {
      throw saveError(409, "map-save-committing", "地图保存正在提交，不能生成候选");
    }
    const context = session.mapContext;
    await input.authorize?.(context);
    await assertAllChunks(session);
    const before = await inspectMapFile(context.targetPath);
    if (before.version !== session.expectedVersion) {
      throw saveError(409, "map-version-conflict", "地图已被其他窗口或任务修改，当前候选未生成");
    }
    const targetStat = await fs.stat(context.targetPath);
    const candidatePath = path.join(
      session.directory,
      `.candidate-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
    );
    try {
      await assembleCandidate(session, candidatePath, targetStat);
      const validation = await this.validateCandidate({
        candidatePath,
        sourcePath: context.relativePath,
        projectPath: context.projectPath,
        expectedKind: context.documentKind,
        memoryMb: session.config.validationMemoryMb,
        timeoutMs: session.config.validationTimeoutMs,
      });
      const referenceDiagnostics = await validateCandidateReferences(
        context.projectPath,
        validation.references,
      );
      await input.authorize?.(context);
      const current = await inspectMapFile(context.targetPath);
      if (current.version !== session.expectedVersion) {
        throw saveError(409, "map-version-conflict", "地图在候选校验期间发生变化，当前候选不可用");
      }
      const fingerprint = await fs.stat(candidatePath);
      const totalHash = await hashFile(candidatePath);
      return Object.freeze({
        saveId: session.id,
        mapSessionId: context.mapSessionId,
        projectPath: context.projectPath,
        relativePath: context.relativePath,
        expectedVersion: session.expectedVersion,
        collaborationPolicyRevision: session.mapContext.collaborationPolicyRevision,
        documentKind: context.documentKind,
        candidatePath,
        size: fingerprint.size,
        sha256: totalHash.hash,
        diagnostics: Object.freeze([...(validation.diagnostics || []), ...referenceDiagnostics]),
        resources: Object.freeze([...(validation.resources || [])]),
        referenceCount: validation.references?.length || 0,
      });
    } catch (error) {
      await fs.rm(candidatePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Finalize a candidate after an owning project transaction has published it.
   * The project writer performs the filesystem transaction; this method only
   * re-checks the authoritative target and advances the save session state.
   * Keeping that distinction explicit prevents a project transaction from
   * accidentally being treated as a normal single-file commit.
   */
  async finalizeCandidate(input) {
    await this.pruneExpired();
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    if (session.result) return session.result;
    const candidate = input?.candidate;
    if (!candidate || candidate.saveId !== session.id || candidate.mapSessionId !== session.mapContext.mapSessionId) {
      throw saveError(400, "invalid-map-save-candidate", "地图候选与保存会话不匹配");
    }
    const published = input?.published;
    if (
      !published
      || published.relativePath !== session.mapContext.relativePath
      || published.version !== candidate.sha256
      || published.size !== candidate.size
    ) {
      throw saveError(409, "map-save-post-commit-conflict", "项目事务返回的地图发布结果与候选不一致");
    }
    const current = await inspectMapFile(session.mapContext.targetPath);
    if (
      current.version !== published.version
      || current.fingerprint.size !== published.size
      || published.version !== session.totalHash
      || published.size !== session.totalBytes
    ) {
      throw saveError(409, "map-save-post-commit-conflict", "项目事务提交后地图版本发生变化，请重新读取服务端版本");
    }
    session.status = "committed";
    session.resourcePaths = Object.freeze([...(candidate.resources || [])]);
    session.result = Object.freeze({
      saveId: session.id,
      mapSessionId: session.mapContext.mapSessionId,
      documentKind: session.mapContext.documentKind,
      version: published.version,
      size: published.size,
      modifiedAt: current.fingerprint.mtimeMs,
      committedAt: this.now(),
      diagnostics: [...(candidate.diagnostics || [])],
      referenceCount: Number.isSafeInteger(candidate.referenceCount)
        ? candidate.referenceCount
        : candidate.resources?.length || 0,
    });
    await removeDirectory(session.directory);
    session.directory = null;
    return session.result;
  }

  async abort(input) {
    await this.pruneExpired();
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    if (session.commitPromise && !session.result) {
      throw saveError(409, "map-save-committing", "地图保存正在提交，暂时不能放弃");
    }
    this.removeSession(session);
    await removeDirectory(session.directory);
    return true;
  }

  async closeForBrowserSession(input = {}) {
    await this.pruneExpired();
    const identity = normalizeBrowserIdentity(input);
    const directories = [];
    let closed = 0;
    let committing = 0;
    for (const session of [...this.sessions.values()]) {
      if (!sameBrowserIdentity(session.identity, identity)) continue;
      if (session.commitPromise) {
        session.closeRequested = true;
        committing += 1;
        continue;
      }
      this.removeSession(session);
      if (session.directory) directories.push(session.directory);
      closed += 1;
    }
    await Promise.all(directories.map(removeDirectory));
    return Object.freeze({ closed, committing });
  }

  async closeForUser(input = {}) {
    await this.pruneExpired();
    const userId = normalizeUserId(input.userId);
    const directories = [];
    let closed = 0;
    let committing = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.identity.userId !== userId) continue;
      if (session.commitPromise) {
        session.closeRequested = true;
        committing += 1;
        continue;
      }
      this.removeSession(session);
      if (session.directory) directories.push(session.directory);
      closed += 1;
    }
    await Promise.all(directories.map(removeDirectory));
    return Object.freeze({ closed, committing });
  }

  snapshot(input) {
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    return publicSaveSession(session, this.commitQueue);
  }

  status() {
    return {
      sessions: this.sessions.size,
      commitActive: this.commitQueue.active,
      commitQueued: this.commitQueue.pending.length,
      commitConcurrency: this.commitConcurrency,
    };
  }

  async clear() {
    const directories = [...this.sessions.values()].map((session) => session.directory);
    this.sessions.clear();
    this.operationKeys.clear();
    await Promise.all(directories.map(removeDirectory));
  }

  async pruneExpired() {
    const now = this.now();
    const expired = [];
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now && !session.commitPromise) {
        this.removeSession(session);
        expired.push(session.directory);
      }
    }
    await Promise.all(expired.map(removeDirectory));
  }

  requireSession(saveId, rawIdentity, expectedDocumentKind) {
    const id = String(saveId || "");
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      throw saveError(404, "map-save-session-not-found", "地图保存会话不存在或已过期");
    }
    const identity = normalizeIdentity(rawIdentity);
    if (!sameIdentity(session.identity, identity)) {
      throw saveError(404, "map-save-session-not-found", "地图保存会话不存在或已过期");
    }
    if (expectedDocumentKind !== undefined) {
      const kind = normalizeDocumentKind(expectedDocumentKind);
      if (session.mapContext.documentKind !== kind) {
        throw saveError(404, "map-save-session-not-found", "地图保存会话不存在或已过期");
      }
    }
    return session;
  }

  assertCapacity(identity) {
    this.evictCompletedForCapacity((session) => (
      session.identity.userId === identity.userId
      && session.identity.browserSessionId === identity.browserSessionId
    ), this.maxSessionsPerBrowser);
    this.evictCompletedForCapacity(() => true, this.maxSessions);
    if (this.sessions.size >= this.maxSessions) {
      throw saveError(429, "map-save-session-capacity", "地图保存会话已达到管理员设置的上限");
    }
    let browserSessions = 0;
    for (const session of this.sessions.values()) {
      if (
        session.identity.userId === identity.userId
        && session.identity.browserSessionId === identity.browserSessionId
      ) browserSessions += 1;
    }
    if (browserSessions >= this.maxSessionsPerBrowser) {
      throw saveError(429, "map-save-browser-capacity", "当前登录已达到管理员设置的地图保存会话上限");
    }
  }

  evictCompletedForCapacity(predicate, limit) {
    const matching = [...this.sessions.values()]
      .filter(predicate)
      .sort((left, right) => left.createdAt - right.createdAt);
    while (matching.length >= limit) {
      const index = matching.findIndex((session) => session.result !== null);
      if (index < 0) return;
      const [session] = matching.splice(index, 1);
      this.removeSession(session);
    }
  }

  removeSession(session) {
    this.sessions.delete(session.id);
    if (this.operationKeys.get(session.operationKey) === session.id) this.operationKeys.delete(session.operationKey);
  }

  async withTargetLock(targetPath, operation) {
    const previous = this.targetLocks.get(targetPath) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => (release = resolve));
    this.targetLocks.set(targetPath, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.targetLocks.get(targetPath) === current) this.targetLocks.delete(targetPath);
    }
  }

  async commitUnlocked(session, authorize) {
    session.status = "committing";
    const context = session.mapContext;
    const candidatePath = path.join(
      path.dirname(context.targetPath),
      `.${path.basename(context.targetPath)}.codex-map-save-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
    );
    try {
      await authorize?.(context);
      await assertAllChunks(session);
      const before = await inspectMapFile(context.targetPath);
      if (before.version !== session.expectedVersion) {
        throw saveError(409, "map-version-conflict", "地图已被其他窗口或任务修改，当前编辑未覆盖服务端文件");
      }
      const targetStat = await fs.stat(context.targetPath);
      await assembleCandidate(session, candidatePath, targetStat);
      const validation = await this.validateCandidate({
        candidatePath,
        sourcePath: context.relativePath,
        projectPath: context.projectPath,
        expectedKind: context.documentKind,
        memoryMb: session.config.validationMemoryMb,
        timeoutMs: session.config.validationTimeoutMs,
      });
      const referenceDiagnostics = await validateCandidateReferences(
        context.projectPath,
        validation.references,
      );
      await authorize?.(context);
      const current = await inspectMapFile(context.targetPath);
      if (current.version !== session.expectedVersion) {
        throw saveError(409, "map-version-conflict", "地图在保存校验期间发生变化，当前编辑未覆盖服务端文件");
      }
      const currentStat = await fs.stat(context.targetPath);
      await preserveFileMetadata(candidatePath, currentStat);
      await fs.rename(candidatePath, context.targetPath);
      await syncDirectory(path.dirname(context.targetPath));
      const saved = await inspectMapFile(context.targetPath);
      if (saved.version !== session.totalHash || saved.fingerprint.size !== session.totalBytes) {
        throw saveError(409, "map-save-post-commit-conflict", "地图提交后立即被其他任务修改，请重新读取服务端版本");
      }
      session.status = "committed";
      session.resourcePaths = Object.freeze([...(validation.resources || [])]);
      session.result = Object.freeze({
        saveId: session.id,
        mapSessionId: context.mapSessionId,
        documentKind: context.documentKind,
        version: saved.version,
        size: saved.fingerprint.size,
        modifiedAt: saved.fingerprint.mtimeMs,
        committedAt: this.now(),
        diagnostics: [...(validation.diagnostics || []), ...referenceDiagnostics],
        referenceCount: validation.references?.length || 0,
      });
      await removeDirectory(session.directory);
      session.directory = null;
      return session.result;
    } finally {
      await fs.rm(candidatePath, { force: true }).catch(() => {});
    }
  }

  resourcePaths(input) {
    const session = this.requireSession(input?.saveId, input?.identity, input?.documentKind);
    if (!session.result) throw saveError(409, "map-save-not-committed", "地图保存尚未提交");
    return [...(session.resourcePaths || [])];
  }
}

async function assembleCandidate(session, candidatePath, targetStat) {
  const handle = await fs.open(candidatePath, "wx", targetStat.mode & 0o777);
  const hash = crypto.createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    for (let index = 0; index < session.chunkCount; index += 1) {
      for await (const chunk of createReadStream(chunkPath(session, index))) {
        bytes += chunk.length;
        hash.update(chunk);
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          throw saveError(415, "invalid-map-utf8", "待保存地图不是有效的 UTF-8 文本");
        }
        await writeAll(handle, chunk);
      }
    }
    try {
      decoder.decode();
    } catch {
      throw saveError(415, "invalid-map-utf8", "待保存地图不是有效的 UTF-8 文本");
    }
    const actualHash = hash.digest("hex");
    if (bytes !== session.totalBytes || actualHash !== session.totalHash) {
      throw saveError(422, "map-save-total-hash", "地图完整内容哈希或长度校验失败");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertAllChunks(session) {
  for (let index = 0; index < session.chunkCount; index += 1) {
    let stat;
    try {
      stat = await fs.stat(chunkPath(session, index));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw saveError(409, "map-save-chunks-missing", `地图保存分块 ${index} 尚未上传`);
      }
      throw error;
    }
    if (!stat.isFile() || stat.size !== expectedChunkBytes(session, index)) {
      throw saveError(422, "map-save-chunk-invalid", `地图保存分块 ${index} 状态无效`);
    }
  }
}

export async function inspectTiledMapInChild(input) {
  return inspectTiledDocumentInChild({ ...input, expectedKind: "map" });
}

export async function inspectTiledTilesetInChild(input) {
  return inspectTiledDocumentInChild({ ...input, expectedKind: "tileset" });
}

export async function inspectTiledWorldInChild(input) {
  return inspectTiledDocumentInChild({ ...input, expectedKind: "world" });
}

export async function inspectTiledTemplateInChild(input) {
  return inspectTiledDocumentInChild({ ...input, expectedKind: "template" });
}

export async function inspectTiledDocumentInChild(input) {
  if (!["map", "tileset", "template", "world"].includes(input.expectedKind)) {
    throw new TypeError("expectedKind must be map, tileset, template, or world");
  }
  const args = [
    `--max-old-space-size=${input.memoryMb}`,
    VALIDATOR_PATH,
    input.candidatePath,
    input.sourcePath,
    input.projectPath || "",
    input.expectedKind,
  ];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = "";
  let overflow = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > VALIDATOR_OUTPUT_LIMIT) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (overflow) throw saveError(422, "map-validation-output-limit", "地图引用清单过大，校验任务已停止");
  if (result.code !== 0) {
    let message = stderr.trim();
    try {
      message = JSON.parse(message).error || message;
    } catch {
      // Keep bounded validator stderr when it is not JSON.
    }
    if (result.signal === "SIGKILL" && !message) message = "地图校验超过管理员设置的时间或内存预算";
    throw saveError(422, "map-validation-failed", message || "Tiled 地图校验失败");
  }
  try {
    return JSON.parse(stdout.toString("utf8"));
  } catch {
    throw saveError(500, "map-validation-response", "地图校验进程返回了无效结果");
  }
}

async function validateCandidateReferences(projectPath, references = []) {
  const projectRealPath = await fs.realpath(projectPath);
  const diagnostics = [];
  for (const reference of references || []) {
    if (!reference?.resolvedPath) continue;
    const candidate = path.resolve(projectPath, reference.resolvedPath);
    const relative = path.relative(projectPath, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw saveError(422, "map-resource-outside-project", `地图资源 ${reference.reference} 不属于当前工程`);
    }
    try {
      const [realPath, stat] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
      const realRelative = path.relative(projectRealPath, realPath);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative) || stat.isSymbolicLink()) {
        throw saveError(422, "map-resource-outside-project", `地图资源 ${reference.reference} 不能使用符号链接逃逸工程`);
      }
      if (!stat.isFile()) {
        throw saveError(422, "map-resource-not-file", `地图资源 ${reference.reference} 不是文件`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      diagnostics.push({
        severity: "warning",
        code: "missing-map-resource",
        path: reference.jsonPath,
        message: `地图资源 ${reference.reference} 当前不存在，引用已保留`,
      });
    }
  }
  return diagnostics;
}

async function preserveFileMetadata(candidatePath, targetStat) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : targetStat.uid;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : targetStat.gid;
  if (targetStat.uid !== currentUid || targetStat.gid !== currentGid) {
    await fs.chown(candidatePath, targetStat.uid, targetStat.gid);
  }
  await fs.chmod(candidatePath, targetStat.mode & 0o777);
  const handle = await fs.open(candidatePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { hash: hash.digest("hex"), size };
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw saveError(500, "map-save-write-stalled", "地图保存临时文件写入中断");
    offset += bytesWritten;
  }
}

function byteSource(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) return [source];
  if (source && typeof source[Symbol.asyncIterator] === "function") return source;
  throw saveError(400, "invalid-map-save-body", "地图保存分块请求体无效");
}

function bufferLength(source) {
  return Buffer.isBuffer(source) || source instanceof Uint8Array ? source.byteLength : undefined;
}

function chunkPath(session, index) {
  if (!session.directory) throw saveError(409, "map-save-committed", "地图保存已经提交");
  return path.join(session.directory, `chunk-${String(index).padStart(8, "0")}`);
}

function expectedChunkBytes(session, index) {
  if (index < session.chunkCount - 1) return session.config.chunkBytes;
  return session.totalBytes - index * session.config.chunkBytes;
}

function normalizeTemporaryRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("temporaryRoot must be an absolute path");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new TypeError("temporaryRoot cannot be a filesystem root");
  return resolved;
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  const editorInstanceId = String(value?.editorInstanceId || "");
  if (
    !userId || userId.length > 256
    || !browserSessionId || browserSessionId.length > 512
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(editorInstanceId)
  ) throw saveError(400, "invalid-map-save-identity", "地图保存会话身份无效");
  return Object.freeze({ userId, browserSessionId, editorInstanceId });
}

function normalizeBrowserIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || userId.length > 256 || !browserSessionId || browserSessionId.length > 512) {
    throw saveError(400, "invalid-map-save-identity", "地图保存会话身份无效");
  }
  return Object.freeze({ userId, browserSessionId });
}

function normalizeUserId(value) {
  const userId = String(value || "");
  if (!userId || userId.length > 256) {
    throw saveError(400, "invalid-map-save-identity", "地图保存会话身份无效");
  }
  return userId;
}

function sameBrowserIdentity(left, right) {
  return left.userId === right.userId && left.browserSessionId === right.browserSessionId;
}

function sameIdentity(left, right) {
  return left.userId === right.userId
    && left.browserSessionId === right.browserSessionId
    && left.editorInstanceId === right.editorInstanceId;
}

function normalizeMapContext(value) {
  const mapSessionId = String(value?.mapSessionId || "");
  const projectPath = String(value?.projectPath || "");
  const targetPath = String(value?.targetPath || "");
  const relativePath = String(value?.relativePath || "");
  const documentKind = normalizeDocumentKind(value?.documentKind);
  const expectedExtension = documentKind === "world"
    ? ".world"
    : documentKind === "tileset"
      ? ".tsj"
      : ".tmj";
  const version = normalizeSha256(value?.version, "地图会话版本");
  if (
    !mapSessionId
    || !path.isAbsolute(projectPath)
    || !path.isAbsolute(targetPath)
    || path.extname(targetPath).toLowerCase() !== expectedExtension
    || !relativePath
  ) throw saveError(400, "invalid-map-save-context", "地图保存上下文无效");
  const relative = path.relative(path.resolve(projectPath), path.resolve(targetPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw saveError(400, "invalid-map-save-context", "地图保存目标不属于当前工程");
  }
  return Object.freeze({
    mapSessionId,
    projectPath: path.resolve(projectPath),
    targetPath: path.resolve(targetPath),
    relativePath: relativePath.replaceAll("\\", "/"),
    documentKind,
    version,
    writable: value?.writable === true,
    collaborationPolicyRevision: value?.collaborationPolicyRevision == null
      ? null
      : normalizeNonNegativeInteger(value.collaborationPolicyRevision, "协同策略版本"),
  });
}

function normalizeSha256(value, label) {
  const hash = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw saveError(400, "invalid-map-save-hash", `${label}无效`);
  return hash;
}

function normalizeNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw saveError(400, "invalid-map-save-context", `${label}无效`);
  return number;
}

function normalizeDocumentKind(value) {
  const kind = value === undefined ? "map" : String(value);
  if (!["map", "world", "tileset"].includes(kind)) {
    throw saveError(400, "invalid-map-save-context", "地图保存文档类型无效");
  }
  return kind;
}

function normalizeOperationId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(id)) {
    throw saveError(400, "invalid-map-save-operation", "地图保存操作标识无效");
  }
  return id;
}

function saveOperationKey(identity, mapSessionId, clientOperationId) {
  return `${identity.userId}\0${identity.browserSessionId}\0${identity.editorInstanceId}\0${mapSessionId}\0${clientOperationId}`;
}

function sameSaveRequest(session, input) {
  return session.expectedVersion === input.expectedVersion
    && session.totalBytes === input.totalBytes
    && session.totalHash === input.totalHash;
}

function publicSaveSession(session, queue) {
  return {
    id: session.id,
    mapSessionId: session.mapContext.mapSessionId,
    documentKind: session.mapContext.documentKind,
    expectedVersion: session.expectedVersion,
    totalBytes: session.totalBytes,
    totalHash: session.totalHash,
    chunkCount: session.chunkCount,
    uploadedChunks: session.chunks.size,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    ...(session.mapContext.collaborationPolicyRevision == null ? {} : {
      collaborationPolicyRevision: session.mapContext.collaborationPolicyRevision,
    }),
    queuePosition: session.status === "queued" ? queue.pending.length : 0,
    config: session.config,
    ...(session.result ? { result: session.result } : {}),
  };
}

async function removeDirectory(directory) {
  if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function normalizeSessionConfig(value, fallback) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    chunkBytes: positiveInteger(input.chunkBytes, fallback.chunkBytes, "chunkBytes"),
    maxBytes: positiveInteger(input.maxBytes, fallback.maxBytes, "maxBytes"),
    validationMemoryMb: positiveInteger(
      input.validationMemoryMb,
      fallback.validationMemoryMb,
      "validationMemoryMb",
    ),
    validationTimeoutMs: positiveInteger(
      input.validationTimeoutMs,
      fallback.validationTimeoutMs,
      "validationTimeoutMs",
    ),
    commitConcurrency: positiveInteger(
      input.commitConcurrency,
      fallback.commitConcurrency,
      "commitConcurrency",
    ),
  };
}

function saveError(statusCode, code, message) {
  return new MapSaveSessionError(statusCode, code, message);
}

class SnapshotConcurrencyQueue {
  constructor(defaultLimit) {
    this.defaultLimit = defaultLimit;
    this.active = 0;
    this.pending = [];
  }

  run(operation, limit = this.defaultLimit) {
    return new Promise((resolve, reject) => {
      this.pending.push({ operation, resolve, reject, limit });
      this.drain();
    });
  }

  drain() {
    while (this.pending.length && this.active < this.pending[0].limit) {
      const task = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(task.operation)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
