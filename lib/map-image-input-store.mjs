import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDecodedImageBuffer } from "./image-file.mjs";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_INPUTS = 128;
const DEFAULT_MAX_INPUTS_PER_BROWSER = 8;
const DEFAULT_MAX_WIDTH = 16_384;
const DEFAULT_MAX_HEIGHT = 16_384;
const DEFAULT_MAX_PIXELS = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const INPUT_KINDS = new Set(["source", "mask"]);
const SOURCE_MEDIA_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

/**
 * Temporary image inputs captured by the map editor. Inputs live outside the
 * project and are bound to one browser window, map session/version, and editor
 * state. They can only become provider inputs; this store never publishes them.
 */
export class MapImageInputStore {
  constructor({
    temporaryRoot,
    authorizeSession = async () => {},
    now = () => Date.now(),
    chunkBytes = DEFAULT_CHUNK_BYTES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxInputs = DEFAULT_MAX_INPUTS,
    maxInputsPerBrowser = DEFAULT_MAX_INPUTS_PER_BROWSER,
    maxWidth = DEFAULT_MAX_WIDTH,
    maxHeight = DEFAULT_MAX_HEIGHT,
    maxPixels = DEFAULT_MAX_PIXELS,
    ttlMs = DEFAULT_TTL_MS,
    cleanupIntervalMs = null,
  } = {}) {
    this.temporaryRoot = normalizeTemporaryRoot(temporaryRoot);
    this.authorizeSession = typeof authorizeSession === "function" ? authorizeSession : async () => {};
    this.now = typeof now === "function" ? now : Date.now;
    this.chunkBytes = positiveInteger(chunkBytes, "chunkBytes");
    this.maxBytes = positiveInteger(maxBytes, "maxBytes");
    this.maxInputs = positiveInteger(maxInputs, "maxInputs");
    this.maxInputsPerBrowser = positiveInteger(maxInputsPerBrowser, "maxInputsPerBrowser");
    this.maxWidth = positiveInteger(maxWidth, "maxWidth");
    this.maxHeight = positiveInteger(maxHeight, "maxHeight");
    this.maxPixels = positiveInteger(maxPixels, "maxPixels");
    this.ttlMs = positiveInteger(ttlMs, "ttlMs");
    this.cleanupIntervalMs = cleanupIntervalMs == null
      ? Math.max(1_000, Math.min(60_000, Math.floor(this.ttlMs / 2)))
      : positiveInteger(cleanupIntervalMs, "cleanupIntervalMs");
    this.sessions = new Map();
    this.rootRealPath = null;
    this.cleanupTimer = null;
    this.closed = false;
  }

  async initialize() {
    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.temporaryRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TypeError("temporaryRoot must be a real directory");
    }
    await fs.chmod(this.temporaryRoot, 0o700);
    this.rootRealPath = await fs.realpath(this.temporaryRoot);
    this.cleanupTimer = setInterval(() => {
      void this.pruneExpired().catch(() => {});
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
    return this;
  }

  async create(input) {
    this.assertReady();
    await this.pruneExpired();
    const identity = normalizeIdentity(input?.identity);
    const mapContext = normalizeMapContext(input?.mapContext);
    const editorStateId = normalizeEditorStateId(input?.editorStateId);
    if (!mapContext.writable) {
      throw inputError(403, "MAP_IMAGE_INPUT_READ_ONLY", "只读地图不能创建临时图片输入");
    }
    this.assertCapacity(identity);
    const projectRealPath = await fs.realpath(mapContext.projectPath).catch(() => path.resolve(mapContext.projectPath));
    if (isSameOrWithin(projectRealPath, this.rootRealPath)) {
      throw inputError(500, "MAP_IMAGE_INPUT_ROOT_UNSAFE", "地图图片临时目录不能位于工程内");
    }
    const kind = normalizeKind(input?.kind);
    const mediaType = normalizeMediaType(input?.mediaType, kind);
    const totalBytes = boundedPositiveInteger(input?.totalBytes, this.maxBytes, "MAP_IMAGE_INPUT_SIZE_INVALID", "图片输入大小无效");
    const totalHash = normalizeHash(input?.totalHash, "图片输入哈希无效");
    const expectedWidth = optionalDimension(input?.width, "图片输入宽度无效");
    const expectedHeight = optionalDimension(input?.height, "图片输入高度无效");
    if ((expectedWidth == null) !== (expectedHeight == null)) {
      throw inputError(400, "MAP_IMAGE_INPUT_DIMENSIONS_INVALID", "图片输入宽高必须同时提供");
    }
    if (expectedWidth > this.maxWidth || expectedHeight > this.maxHeight || expectedWidth * expectedHeight > this.maxPixels) {
      throw inputError(413, "MAP_IMAGE_INPUT_DIMENSIONS_LIMIT", "图片输入尺寸超过管理员设置的上限");
    }
    await this.authorizeSession({
      purpose: "input-create",
      identity,
      mapContext,
      mapVersion: mapContext.version,
      editorStateId,
      kind,
      totalBytes,
    });

    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, "input-"));
    try {
      await fs.chmod(directory, 0o700);
      await this.assertSafeDirectory(directory);
      const filePath = path.join(directory, "payload");
      const handle = await fs.open(filePath, "wx", 0o600);
      const stat = await handle.stat();
      await handle.close();
      const createdAt = this.now();
      const session = {
        id: crypto.randomBytes(24).toString("base64url"),
        identity,
        mapContext,
        editorStateId,
        kind,
        mediaType,
        expectedFormat: SOURCE_MEDIA_TYPES.get(mediaType),
        totalBytes,
        totalHash,
        expectedWidth,
        expectedHeight,
        chunkBytes: this.chunkBytes,
        chunkCount: Math.ceil(totalBytes / this.chunkBytes),
        nextIndex: 0,
        uploadedBytes: 0,
        directory,
        filePath,
        fileIdentity: { dev: stat.dev, ino: stat.ino },
        status: "uploading",
        metadata: null,
        busy: false,
        claimed: false,
        retained: 0,
        deleteRequested: false,
        createdAt,
        updatedAt: createdAt,
        expiresAt: createdAt + this.ttlMs,
      };
      this.sessions.set(session.id, session);
      return publicInput(session);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async append(input) {
    this.assertReady();
    await this.pruneExpired();
    const session = this.requireSession(input);
    if (session.status !== "uploading") {
      throw inputError(409, "MAP_IMAGE_INPUT_FINALIZED", "图片输入已经完成上传");
    }
    const index = Number(input?.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunkCount) {
      throw inputError(400, "MAP_IMAGE_INPUT_CHUNK_INVALID", "图片输入分块序号无效");
    }
    if (index !== session.nextIndex) {
      throw inputError(409, "MAP_IMAGE_INPUT_CHUNK_ORDER", `图片输入必须从分块 ${session.nextIndex} 继续上传`);
    }
    if (session.busy) throw inputError(409, "MAP_IMAGE_INPUT_BUSY", "图片输入正在处理另一个分块");
    const expectedBytes = expectedChunkBytes(session, index);
    const contentLength = input?.contentLength == null
      ? byteLength(input?.source)
      : Number(input.contentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
      throw inputError(400, "MAP_IMAGE_INPUT_CHUNK_SIZE", `图片输入分块 ${index} 长度不匹配`);
    }
    const chunkHash = normalizeHash(input?.chunkHash, "图片输入分块哈希无效");
    session.busy = true;
    let handle;
    try {
      handle = await this.openPayload(session, fsConstants.O_WRONLY | fsConstants.O_APPEND);
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      for await (const value of byteSource(input?.source)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > expectedBytes) {
          throw inputError(413, "MAP_IMAGE_INPUT_CHUNK_TOO_LARGE", `图片输入分块 ${index} 超出固定长度`);
        }
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      if (bytes !== expectedBytes) {
        throw inputError(400, "MAP_IMAGE_INPUT_CHUNK_SIZE", `图片输入分块 ${index} 长度不匹配`);
      }
      const actualHash = hash.digest("hex");
      if (actualHash !== chunkHash) {
        await handle.truncate(session.uploadedBytes);
        throw inputError(422, "MAP_IMAGE_INPUT_CHUNK_HASH", `图片输入分块 ${index} 哈希校验失败`);
      }
      await handle.sync();
      session.nextIndex += 1;
      session.uploadedBytes += bytes;
      session.updatedAt = this.now();
      return {
        inputId: session.id,
        index,
        bytes,
        hash: actualHash,
        uploadedBytes: session.uploadedBytes,
        uploadedChunks: session.nextIndex,
        chunkCount: session.chunkCount,
      };
    } catch (error) {
      if (handle) await handle.truncate(session.uploadedBytes).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      session.busy = false;
      await this.removeIfDeleteRequested(session);
    }
  }

  async snapshot(input) {
    this.assertReady();
    await this.pruneExpired();
    return publicInput(this.requireSession(input));
  }

  async finalize(input) {
    this.assertReady();
    await this.pruneExpired();
    const session = this.requireSession(input);
    if (session.status === "finalized") return publicInput(session);
    if (session.busy) throw inputError(409, "MAP_IMAGE_INPUT_BUSY", "图片输入正在处理另一个分块");
    if (session.nextIndex !== session.chunkCount || session.uploadedBytes !== session.totalBytes) {
      throw inputError(409, "MAP_IMAGE_INPUT_INCOMPLETE", "图片输入分块尚未上传完整");
    }
    session.busy = true;
    let authorization;
    let handle;
    try {
      authorization = await this.authorizeSession({
        purpose: "input-finalize",
        inputId: session.id,
        identity: session.identity,
        mapContext: session.mapContext,
        mapVersion: session.mapContext.version,
        editorStateId: session.editorStateId,
        kind: session.kind,
        totalBytes: session.totalBytes,
      });
      handle = await this.openPayload(session, fsConstants.O_RDONLY, session.totalBytes);
      const bytes = await handle.readFile();
      const hash = sha256(bytes);
      if (hash !== session.totalHash) {
        throw inputError(422, "MAP_IMAGE_INPUT_HASH", "图片输入完整哈希校验失败");
      }
      let inspected;
      try {
        inspected = await inspectDecodedImageBuffer(bytes, {
          maxBytes: this.maxBytes,
          maxWidth: this.maxWidth,
          maxHeight: this.maxHeight,
          maxPixels: this.maxPixels,
          allowedFormats: session.kind === "mask" ? ["png"] : ["png", "jpeg", "webp"],
        });
      } catch (error) {
        throw inputError(422, "MAP_IMAGE_INPUT_IMAGE_INVALID", `图片输入内容无效: ${error.message}`);
      }
      if (inspected.format !== session.expectedFormat || inspected.mediaType !== session.mediaType) {
        throw inputError(422, "MAP_IMAGE_INPUT_MEDIA_TYPE", "图片输入声明类型与实际格式不一致");
      }
      if (
        (session.expectedWidth != null && inspected.width !== session.expectedWidth)
        || (session.expectedHeight != null && inspected.height !== session.expectedHeight)
      ) throw inputError(422, "MAP_IMAGE_INPUT_DIMENSIONS", "图片输入声明尺寸与实际尺寸不一致");
      session.metadata = Object.freeze({ ...inspected, sha256: hash });
      session.status = "finalized";
      session.updatedAt = this.now();
      return publicInput(session);
    } finally {
      await handle?.close().catch(() => {});
      await Promise.resolve(authorization?.release?.()).catch(() => {});
      session.busy = false;
      await this.removeIfDeleteRequested(session);
    }
  }

  async snapshot(input) {
    this.assertReady();
    await this.pruneExpired();
    return publicInput(this.requireSession(input));
  }

  /** Open a finalized input for controlled preview without disclosing its path. */
  async read(input) {
    const authorized = await this.authorize({ ...input, purpose: input?.purpose || "input-read" });
    let handle;
    try {
      handle = await this.openPayload(authorized.session, fsConstants.O_RDONLY, authorized.session.totalBytes);
      return {
        handle,
        metadata: authorized.metadata,
        release: authorized.release,
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      await authorized.release();
      throw error;
    }
  }

  /**
   * Internal execution authorization. `absolutePath` and `release` are
   * intentionally non-enumerable so an HTTP JSON response cannot leak them.
   */
  async authorize(input) {
    this.assertReady();
    await this.pruneExpired();
    const session = this.requireSession(input);
    if (session.status !== "finalized" || !session.metadata) {
      throw inputError(409, "MAP_IMAGE_INPUT_NOT_READY", "图片输入尚未完成校验");
    }
    const purpose = normalizePurpose(input?.purpose || "input-execute");
    let authorization;
    try {
      authorization = await this.authorizeSession({
        purpose,
        inputId: session.id,
        identity: session.identity,
        mapContext: session.mapContext,
        mapVersion: session.mapContext.version,
        editorStateId: session.editorStateId,
        kind: session.kind,
        totalBytes: session.totalBytes,
        sha256: session.metadata.sha256,
      });
      const handle = await this.openPayload(session, fsConstants.O_RDONLY, session.totalBytes);
      await handle.close();
      const descriptor = {
        metadata: publicInput(session),
      };
      Object.defineProperties(descriptor, {
        absolutePath: { value: session.filePath, enumerable: false, writable: false },
        session: { value: session, enumerable: false, writable: false },
        release: {
          value: onceAsync(async () => Promise.resolve(authorization?.release?.())),
          enumerable: false,
          writable: false,
        },
      });
      return Object.freeze(descriptor);
    } catch (error) {
      await Promise.resolve(authorization?.release?.()).catch(() => {});
      throw error;
    }
  }

  /** Claim a finalized input for one Worker operation. Claims are exclusive. */
  async claim(input) {
    this.assertReady();
    if (input?.signal?.aborted) throw inputError(499, "MAP_IMAGE_INPUT_CANCELED", "地图图片任务已取消");
    await this.pruneExpired();
    const session = this.requireSession(input);
    if (session.status !== "finalized" || !session.metadata) {
      throw inputError(409, "MAP_IMAGE_INPUT_NOT_READY", "图片输入尚未完成校验");
    }
    if (session.claimed) throw inputError(409, "MAP_IMAGE_INPUT_CLAIMED", "图片输入已被另一个 Worker 任务占用");
    const purpose = normalizePurpose(input?.purpose || "input-claim");
    // Set synchronously before awaiting the authorization callback so a second
    // concurrent claim cannot pass the check above.
    session.claimed = true;
    let authorization;
    try {
      authorization = await this.authorizeSession({
        purpose,
        inputId: session.id,
        identity: session.identity,
        mapContext: session.mapContext,
        mapVersion: session.mapContext.version,
        editorStateId: session.editorStateId,
        kind: session.kind,
        totalBytes: session.totalBytes,
        sha256: session.metadata.sha256,
      });
      await (await this.openPayload(session, fsConstants.O_RDONLY, session.totalBytes)).close();
      const descriptor = { metadata: publicInput(session) };
      let abortListener = null;
      const release = onceAsync(async () => {
        if (abortListener) input.signal?.removeEventListener("abort", abortListener);
        session.claimed = false;
        await Promise.resolve(authorization?.release?.());
        await this.removeIfDeleteRequested(session);
      });
      Object.defineProperties(descriptor, {
        absolutePath: { value: session.filePath, enumerable: false, writable: false },
        session: { value: session, enumerable: false, writable: false },
        release: {
          value: release,
          enumerable: false,
          writable: false,
        },
      });
      if (input?.signal) {
        abortListener = () => { void release().catch(() => {}); };
        input.signal.addEventListener("abort", abortListener, { once: true });
        if (input.signal.aborted) void release().catch(() => {});
      }
      return Object.freeze(descriptor);
    } catch (error) {
      session.claimed = false;
      await Promise.resolve(authorization?.release?.()).catch(() => {});
      await this.removeIfDeleteRequested(session);
      throw error;
    }
  }

  /**
   * Pin a finalized input for the lifetime of a queued map-image job.
   * Unlike claim(), retain() is deliberately shareable: the short staging
   * operation may take an exclusive claim later, while this reference keeps
   * TTL cleanup and user DELETE from removing the input in the queue.
   */
  async retain(input) {
    this.assertReady();
    if (input?.signal?.aborted) throw inputError(499, "MAP_IMAGE_INPUT_CANCELED", "地图图片任务已取消");
    await this.pruneExpired();
    const session = this.requireSession(input);
    if (session.status !== "finalized" || !session.metadata) {
      throw inputError(409, "MAP_IMAGE_INPUT_NOT_READY", "图片输入尚未完成校验");
    }
    const purpose = normalizePurpose(input?.purpose || "input-retain");
    let authorization;
    session.retained += 1;
    let released = false;
    let abortListener = null;
    const release = async () => {
      if (released) return;
      released = true;
      if (abortListener) input.signal?.removeEventListener("abort", abortListener);
      session.retained = Math.max(0, session.retained - 1);
      await Promise.resolve(authorization?.release?.());
      await this.removeIfDeleteRequested(session);
    };
    try {
      authorization = await this.authorizeSession({
        purpose,
        inputId: session.id,
        identity: session.identity,
        mapContext: session.mapContext,
        mapVersion: session.mapContext.version,
        editorStateId: session.editorStateId,
        kind: session.kind,
        totalBytes: session.totalBytes,
        sha256: session.metadata.sha256,
      });
      // Check the file while the reference is being acquired. The subsequent
      // stageTo call performs its own inode/hash check before Worker use.
      await (await this.openPayload(session, fsConstants.O_RDONLY, session.totalBytes)).close();
      const descriptor = { metadata: publicInput(session) };
      Object.defineProperty(descriptor, "release", {
        value: onceAsync(release),
        enumerable: false,
        writable: false,
      });
      if (input?.signal) {
        abortListener = () => { void release().catch(() => {}); };
        input.signal.addEventListener("abort", abortListener, { once: true });
        if (input.signal.aborted) void release().catch(() => {});
      }
      return Object.freeze(descriptor);
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  }

  /**
   * Copy a finalized input into a caller-owned Worker input directory. The
   * destination is intentionally not returned: callers already know the path
   * they supplied, while HTTP-facing objects must not expose absolute paths.
   */
  async stageTo(input) {
    this.assertReady();
    const destinationPath = normalizeDestinationPath(input?.destinationPath);
    const sessionContext = this.requireSession(input);
    if (isSameOrWithin(sessionContext.mapContext.projectPath, destinationPath)) {
      throw inputError(400, "MAP_IMAGE_INPUT_DESTINATION_PROJECT", "Worker 暂存目标不能位于地图工程内");
    }
    const maxBytes = input?.maxBytes == null
      ? this.maxBytes
      : boundedPositiveInteger(input.maxBytes, this.maxBytes, "MAP_IMAGE_INPUT_STAGE_LIMIT", "Worker 暂存大小上限无效");
    if (sessionContext.totalBytes > maxBytes) {
      throw inputError(413, "MAP_IMAGE_INPUT_STAGE_LIMIT", "图片输入超过 Worker 暂存大小上限");
    }
    const lease = await this.claim({ ...input, purpose: input?.purpose || "input-stage" });
    let sourceHandle;
    let temporaryHandle;
    const temporaryPath = `${destinationPath}.tmp-${crypto.randomBytes(12).toString("hex")}`;
    try {
      const parent = path.dirname(destinationPath);
      await assertDestinationDirectory(parent);
      await fs.lstat(destinationPath).then(
        () => { throw inputError(409, "MAP_IMAGE_INPUT_DESTINATION_EXISTS", "Worker 暂存目标已存在"); },
        (error) => { if (error.code !== "ENOENT") throw error; },
      );
      sourceHandle = await this.openPayload(sessionContext, fsConstants.O_RDONLY, sessionContext.totalBytes);
      temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
      const sourceStat = await sourceHandle.stat();
      const digest = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, maxBytes));
      let copied = 0;
      while (copied < sessionContext.totalBytes) {
        assertSignal(input?.signal);
        const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, sessionContext.totalBytes - copied), copied);
        if (!bytesRead) throw inputError(409, "MAP_IMAGE_INPUT_CHANGED", "图片输入读取提前结束");
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        await writeAll(temporaryHandle, chunk);
        copied += bytesRead;
      }
      const finalSourceStat = await sourceHandle.stat();
      const actualHash = digest.digest("hex");
      assertSignal(input?.signal);
      if (
        finalSourceStat.dev !== sourceStat.dev
        || finalSourceStat.ino !== sourceStat.ino
        || finalSourceStat.size !== sessionContext.totalBytes
        || actualHash !== sessionContext.metadata.sha256
      ) throw inputError(409, "MAP_IMAGE_INPUT_CHANGED", "图片输入在 Worker 暂存期间发生变化");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = null;
      // link+unlink refuses to overwrite an existing destination, including a
      // symlink, unlike rename which would silently replace it.
      await fs.link(temporaryPath, destinationPath);
      await fs.unlink(temporaryPath);
      return {
        inputId: sessionContext.id,
        kind: sessionContext.kind,
        mediaType: sessionContext.mediaType,
        bytes: sessionContext.totalBytes,
        sha256: actualHash,
        staged: true,
      };
    } finally {
      await sourceHandle?.close().catch(() => {});
      await temporaryHandle?.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      await lease.release().catch(() => {});
    }
  }

  async delete(input) {
    this.assertReady();
    await this.pruneExpired();
    const session = this.requireSession(input);
    if (session.busy || session.claimed || session.retained > 0) throw inputError(409, "MAP_IMAGE_INPUT_CLAIMED", "图片输入正在使用中");
    const authorization = await this.authorizeSession({
      purpose: "input-delete",
      inputId: session.id,
      identity: session.identity,
      mapContext: session.mapContext,
      mapVersion: session.mapContext.version,
      editorStateId: session.editorStateId,
      kind: session.kind,
    });
    try {
      this.sessions.delete(session.id);
      await this.removeDirectory(session.directory);
      return { deleted: true, inputId: session.id };
    } finally {
      await Promise.resolve(authorization?.release?.()).catch(() => {});
    }
  }

  async deleteForBrowserSession(input = {}) {
    this.assertReady();
    await this.pruneExpired();
    const identity = normalizeBrowserIdentity(input);
    const removals = [];
    let deleted = 0;
    let retained = 0;
    for (const session of [...this.sessions.values()]) {
      if (!sameBrowser(session.identity, identity)) continue;
      if (session.busy || session.claimed || session.retained > 0) {
        session.deleteRequested = true;
        session.expiresAt = 0;
        retained += 1;
        continue;
      }
      this.sessions.delete(session.id);
      removals.push(this.removeDirectory(session.directory));
      deleted += 1;
    }
    await Promise.allSettled(removals);
    return Object.freeze({ deleted, retained });
  }

  async deleteForUser(input = {}) {
    this.assertReady();
    await this.pruneExpired();
    const userId = normalizeUserId(input.userId);
    const removals = [];
    let deleted = 0;
    let retained = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.identity.userId !== userId) continue;
      if (session.busy || session.claimed || session.retained > 0) {
        session.deleteRequested = true;
        session.expiresAt = 0;
        retained += 1;
        continue;
      }
      this.sessions.delete(session.id);
      removals.push(this.removeDirectory(session.directory));
      deleted += 1;
    }
    await Promise.allSettled(removals);
    return Object.freeze({ deleted, retained });
  }

  async pruneExpired() {
    const now = this.now();
    const expired = [];
    for (const session of this.sessions.values()) {
      if (session.busy || session.claimed || session.retained > 0 || session.expiresAt > now) continue;
      this.sessions.delete(session.id);
      expired.push(this.removeDirectory(session.directory));
    }
    await Promise.allSettled(expired);
    return expired.length;
  }

  async removeIfDeleteRequested(session) {
    if (
      !session?.deleteRequested
      || this.sessions.get(session.id) !== session
      || session.busy
      || session.claimed
      || session.retained > 0
    ) return false;
    this.sessions.delete(session.id);
    await this.removeDirectory(session.directory);
    return true;
  }

  status() {
    const values = [...this.sessions.values()];
    return {
      inputs: values.length,
      uploading: values.filter((entry) => entry.status === "uploading").length,
      finalized: values.filter((entry) => entry.status === "finalized").length,
      claimed: values.filter((entry) => entry.claimed).length,
      retained: values.reduce((total, entry) => total + entry.retained, 0),
      bytes: values.reduce((total, entry) => total + entry.uploadedBytes, 0),
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    const directories = [...this.sessions.values()].map((session) => session.directory);
    this.sessions.clear();
    return Promise.allSettled(directories.map((directory) => this.removeDirectory(directory)));
  }

  assertReady() {
    if (this.closed) throw inputError(503, "MAP_IMAGE_INPUT_STORE_CLOSED", "地图图片输入服务已关闭");
    if (!this.rootRealPath) throw new TypeError("MapImageInputStore must be initialized before use");
  }

  assertCapacity(identity) {
    if (this.sessions.size >= this.maxInputs) {
      throw inputError(429, "MAP_IMAGE_INPUT_CAPACITY", "地图图片临时输入已达到总数上限");
    }
    const browserInputs = [...this.sessions.values()].filter((entry) => sameBrowser(entry.identity, identity)).length;
    if (browserInputs >= this.maxInputsPerBrowser) {
      throw inputError(429, "MAP_IMAGE_INPUT_BROWSER_CAPACITY", "当前浏览器的地图图片临时输入已达到上限");
    }
  }

  requireSession(input) {
    const id = String(input?.inputId || input?.id || "");
    const identity = normalizeIdentity(input?.identity);
    const session = this.sessions.get(id);
    if (!session || !sameIdentity(session.identity, identity)) {
      throw inputError(404, "MAP_IMAGE_INPUT_NOT_FOUND", "地图图片输入不存在");
    }
    const mapSessionId = String(input?.mapSessionId || input?.mapContext?.mapSessionId || "");
    const mapVersion = String(input?.mapVersion || input?.mapContext?.version || "");
    const editorStateId = normalizeEditorStateId(input?.editorStateId);
    if (
      mapSessionId !== session.mapContext.mapSessionId
      || mapVersion !== session.mapContext.version
      || editorStateId !== session.editorStateId
    ) throw inputError(409, "MAP_IMAGE_INPUT_CONTEXT_CONFLICT", "地图或编辑状态已变化，请重新上传图片输入");
    return session;
  }

  async assertSafeDirectory(directory) {
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw inputError(409, "MAP_IMAGE_INPUT_CHANGED", "图片输入临时目录已变化");
    }
    const real = await fs.realpath(directory);
    if (!isStrictlyWithin(this.rootRealPath, real)) {
      throw inputError(409, "MAP_IMAGE_INPUT_CHANGED", "图片输入临时目录已离开受控范围");
    }
  }

  async openPayload(session, flags, expectedSize = session.uploadedBytes) {
    await this.assertSafeDirectory(session.directory);
    let handle;
    try {
      handle = await fs.open(session.filePath, flags | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (
        !stat.isFile()
        || stat.dev !== session.fileIdentity.dev
        || stat.ino !== session.fileIdentity.ino
        || stat.size !== expectedSize
      ) throw inputError(409, "MAP_IMAGE_INPUT_CHANGED", "图片输入暂存文件已变化");
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === "ELOOP") {
        throw inputError(409, "MAP_IMAGE_INPUT_CHANGED", "图片输入暂存文件不能是符号链接");
      }
      throw error;
    }
  }

  async removeDirectory(directory) {
    if (!this.rootRealPath || !isStrictlyWithin(this.rootRealPath, path.resolve(directory))) return;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export class MapImageInputError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapImageInputError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function publicInput(session) {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    mapSessionId: session.mapContext.mapSessionId,
    mapVersion: session.mapContext.version,
    editorStateId: session.editorStateId,
    mediaType: session.mediaType,
    totalBytes: session.totalBytes,
    totalHash: session.totalHash,
    chunkBytes: session.chunkBytes,
    chunkCount: session.chunkCount,
    uploadedBytes: session.uploadedBytes,
    uploadedChunks: session.nextIndex,
    width: session.metadata?.width ?? session.expectedWidth,
    height: session.metadata?.height ?? session.expectedHeight,
    sha256: session.metadata?.sha256 ?? null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function normalizeTemporaryRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("temporaryRoot must be an absolute path");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new TypeError("temporaryRoot cannot be a filesystem root");
  return resolved;
}

function normalizeDestinationPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw inputError(400, "MAP_IMAGE_INPUT_DESTINATION_INVALID", "Worker 暂存目标必须是绝对路径");
  }
  const destination = path.resolve(value);
  if (destination === path.parse(destination).root || destination.endsWith(`${path.sep}.`)) {
    throw inputError(400, "MAP_IMAGE_INPUT_DESTINATION_INVALID", "Worker 暂存目标无效");
  }
  return destination;
}

async function assertDestinationDirectory(directory) {
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw inputError(400, "MAP_IMAGE_INPUT_DESTINATION_INVALID", "Worker 暂存目录必须是已存在的真实目录");
  }
  const real = await fs.realpath(directory);
  if (real === path.parse(real).root) {
    throw inputError(400, "MAP_IMAGE_INPUT_DESTINATION_INVALID", "Worker 暂存目录无效");
  }
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  const editorInstanceId = String(value?.editorInstanceId || "");
  if (
    !userId || userId.length > 256
    || !browserSessionId || browserSessionId.length > 512
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(editorInstanceId)
  ) throw inputError(400, "MAP_IMAGE_INPUT_IDENTITY_INVALID", "地图图片输入身份无效");
  return Object.freeze({ userId, browserSessionId, editorInstanceId });
}

function normalizeMapContext(value) {
  const mapSessionId = String(value?.mapSessionId || value?.sessionId || "");
  const version = String(value?.version || "");
  const rawProjectPath = String(value?.projectPath || "");
  const projectPath = path.resolve(rawProjectPath || ".");
  const targetPath = value?.targetPath ? path.resolve(String(value.targetPath)) : null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(mapSessionId)) {
    throw inputError(400, "MAP_IMAGE_INPUT_MAP_SESSION_INVALID", "地图会话标识无效");
  }
  if (!/^[a-f0-9]{64}$/u.test(version)) {
    throw inputError(400, "MAP_IMAGE_INPUT_MAP_VERSION_INVALID", "地图版本无效");
  }
  if (!path.isAbsolute(rawProjectPath) || projectPath === path.parse(projectPath).root) {
    throw inputError(400, "MAP_IMAGE_INPUT_PROJECT_INVALID", "地图工程路径无效");
  }
  if (targetPath && !isStrictlyWithin(projectPath, targetPath)) {
    throw inputError(400, "MAP_IMAGE_INPUT_TARGET_INVALID", "地图文件必须位于当前工程内");
  }
  return Object.freeze({ mapSessionId, version, projectPath, targetPath, writable: value?.writable === true });
}

function normalizeEditorStateId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw inputError(400, "MAP_IMAGE_INPUT_EDITOR_STATE_INVALID", "地图编辑状态标识无效");
  }
  return number;
}

function normalizeKind(value) {
  const kind = String(value || "");
  if (!INPUT_KINDS.has(kind)) throw inputError(400, "MAP_IMAGE_INPUT_KIND_INVALID", "图片输入类型必须是 source 或 mask");
  return kind;
}

function normalizeMediaType(value, kind) {
  const mediaType = String(value || "").trim().toLowerCase();
  if (!SOURCE_MEDIA_TYPES.has(mediaType) || (kind === "mask" && mediaType !== "image/png")) {
    throw inputError(400, "MAP_IMAGE_INPUT_MEDIA_TYPE_INVALID", kind === "mask" ? "蒙版输入必须是 PNG" : "图片输入格式不受支持");
  }
  return mediaType;
}

function normalizePurpose(value) {
  const purpose = String(value || "");
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(purpose)) {
    throw inputError(400, "MAP_IMAGE_INPUT_PURPOSE_INVALID", "图片输入授权用途无效");
  }
  return purpose;
}

function normalizeHash(value, message) {
  const hash = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw inputError(400, "MAP_IMAGE_INPUT_HASH_INVALID", message);
  return hash;
}

function optionalDimension(value, message) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw inputError(400, "MAP_IMAGE_INPUT_DIMENSIONS_INVALID", message);
  }
  return number;
}

function boundedPositiveInteger(value, maximum, code, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw inputError(400, code, message);
  if (number > maximum) throw inputError(413, "MAP_IMAGE_INPUT_SIZE_LIMIT", "图片输入超过管理员设置的大小上限");
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function expectedChunkBytes(session, index) {
  return Math.min(session.chunkBytes, session.totalBytes - (index * session.chunkBytes));
}

function byteSource(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) return [source];
  if (source && typeof source[Symbol.asyncIterator] === "function") return source;
  throw inputError(400, "MAP_IMAGE_INPUT_BODY_INVALID", "图片输入分块请求体无效");
}

function byteLength(source) {
  return Buffer.isBuffer(source) || source instanceof Uint8Array ? source.byteLength : undefined;
}

function assertSignal(signal) {
  if (signal?.aborted) throw inputError(499, "MAP_IMAGE_INPUT_CANCELED", "地图图片任务已取消");
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw inputError(500, "MAP_IMAGE_INPUT_WRITE_STALLED", "图片输入写入中断");
    offset += bytesWritten;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left, right) {
  return left.userId === right.userId
    && left.browserSessionId === right.browserSessionId
    && left.editorInstanceId === right.editorInstanceId;
}

function normalizeBrowserIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || !browserSessionId) {
    throw inputError(400, "MAP_IMAGE_INPUT_IDENTITY_INVALID", "地图图片输入身份无效");
  }
  return Object.freeze({ userId, browserSessionId });
}

function normalizeUserId(value) {
  const userId = String(value || "");
  if (!userId) {
    throw inputError(400, "MAP_IMAGE_INPUT_IDENTITY_INVALID", "地图图片输入身份无效");
  }
  return userId;
}

function sameBrowser(left, right) {
  return left.userId === right.userId && left.browserSessionId === right.browserSessionId;
}

function isStrictlyWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSameOrWithin(root, candidate) {
  return path.resolve(root) === path.resolve(candidate) || isStrictlyWithin(path.resolve(root), path.resolve(candidate));
}

function onceAsync(fn) {
  let promise = null;
  return () => {
    promise ||= Promise.resolve().then(fn);
    return promise;
  };
}

function inputError(statusCode, code, message) {
  return new MapImageInputError(statusCode, code, message);
}
