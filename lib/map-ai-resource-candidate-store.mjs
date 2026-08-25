import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CANDIDATES = 4_096;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/iu;
const EXTENSIONS = new Set([".tmj", ".tsj", ".tx", ".world", ".json", ".png", ".jpg", ".jpeg", ".webp"]);
const CANDIDATE_DIRECTORY_PREFIX = "resource-";
const CANDIDATE_MANIFEST = ".map-ai-resource-candidate.json";
const CANDIDATE_SCHEMA = "wfl.map-ai-resource-candidate.v1";

/**
 * Server-owned resource candidates for headless map-AI tasks.
 *
 * A candidate is copied into a private directory before it receives an opaque
 * id.  Public callers only see the id and bounded metadata; the executor gets
 * a non-enumerable candidatePath after it has re-checked the user/project/
 * thread/path/version binding.  This keeps absolute paths, file handles and
 * arbitrary path mapping out of MCP and task contracts.
 */
export class MapAiResourceCandidateStore {
  constructor({
    temporaryRoot,
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxCandidateBytes = DEFAULT_MAX_CANDIDATE_BYTES,
    sourceRoots = [],
  } = {}) {
    if (!temporaryRoot || typeof temporaryRoot !== "string") throw new TypeError("temporaryRoot is required");
    this.temporaryRoot = path.resolve(temporaryRoot);
    this.now = typeof now === "function" ? now : Date.now;
    this.ttlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS, 1_000, 7 * 24 * 60 * 60 * 1000);
    this.maxCandidates = positiveInteger(maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 100_000);
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES, 1, 16 * 1024 * 1024 * 1024);
    this.maxCandidateBytes = positiveInteger(maxCandidateBytes, DEFAULT_MAX_CANDIDATE_BYTES, 1, this.maxBytes);
    this.sourceRoots = (Array.isArray(sourceRoots) ? sourceRoots : []).map((entry) => {
      if (typeof entry !== "string" || !path.isAbsolute(entry) || entry.includes("\0")) throw new TypeError("sourceRoots must contain absolute paths");
      return path.resolve(entry);
    });
    this.candidates = new Map();
    // Commit retries can arrive after the browser upload staging entry has
    // already been cleaned. Keep a scoped operation receipt for the lifetime
    // of this candidate store so a lost HTTP response cannot register a
    // second candidate for the same bytes. The receipt never crosses user,
    // project, Thread, or target-path bindings.
    this.registrationOperations = new Map();
    this.totalBytes = 0;
    this.registerQueue = Promise.resolve();
    this.rootRealPath = null;
    this.initialized = false;
    this.closed = false;
  }

  async initialize() {
    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.temporaryRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("temporaryRoot must be a real directory");
    await fs.chmod(this.temporaryRoot, 0o700);
    this.rootRealPath = await fs.realpath(this.temporaryRoot);
    await this.restorePersistedCandidates();
    const roots = [];
    for (const root of this.sourceRoots) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await assertNoSymlink(root);
      const stat = await fs.lstat(root);
      if (!stat.isDirectory()) throw new TypeError("sourceRoots must contain real directories");
      roots.push(await fs.realpath(root));
    }
    this.sourceRoots = Object.freeze(roots);
    this.initialized = true;
    return this;
  }

  /** Copy a trusted staged file into this store and return its opaque id. */
  async register({ userId, projectPath, threadId, relativePath, baseVersion, sourcePath, size, sha256: expectedSha256, idempotencyKey = null } = {}) {
    this.assertReady();
    const run = async () => {
      await this.pruneExpired();
      const binding = normalizeBinding({ userId, projectPath, threadId, relativePath, baseVersion });
      const operationKey = idempotencyKey == null || idempotencyKey === ""
        ? null
        : registrationScopeKey(binding, idempotencyKey);
      if (operationKey) {
        const existingId = this.registrationOperations.get(operationKey);
        const existing = existingId ? this.candidates.get(existingId) : null;
        if (existing && registrationMatches(existing, binding, size, expectedSha256)) {
          return publicCandidate(existing);
        }
        if (existingId && !existing) this.registrationOperations.delete(operationKey);
        if (existing && !registrationMatches(existing, binding, size, expectedSha256)) {
          throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_OPERATION_CONFLICT", "资源候选提交请求 ID 已用于不同资源");
        }
      }
      const source = await this.inspectSource(sourcePath);
      if (size !== undefined && Number(size) !== source.size) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选文件大小与声明不一致");
      if (expectedSha256 !== undefined && String(expectedSha256).toLowerCase() !== source.sha256) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选文件哈希与声明不一致");
      if (this.candidates.size >= this.maxCandidates || this.totalBytes + source.size > this.maxBytes) {
        throw candidateError(429, "MAP_AI_RESOURCE_CANDIDATE_CAPACITY", "地图 AI 资源候选已达到管理员上限");
      }
      const id = this.createId();
      const directory = await fs.mkdtemp(path.join(this.temporaryRoot, "resource-"));
      await fs.chmod(directory, 0o700);
      const destination = path.join(directory, `payload${path.extname(binding.relativePath).toLowerCase()}`);
      try {
        await copyOwnedFile(source.path, destination, source.size);
        const copiedSha256 = await hashFile(destination);
        if (copiedSha256 !== source.sha256) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选文件在复制后发生变化");
        const createdAt = this.now();
        const entry = {
          id,
          userId: binding.userId,
          projectPath: binding.projectPath,
          threadId: binding.threadId,
          relativePath: binding.relativePath,
          baseVersion: binding.baseVersion,
          size: source.size,
          sha256: source.sha256,
          mediaType: mediaTypeForPath(binding.relativePath),
          createdAt,
          updatedAt: createdAt,
          expiresAt: createdAt + this.ttlMs,
          leases: 0,
          pendingRemoval: false,
          directory,
          path: destination,
          registrationOperationKey: operationKey,
        };
        await writeCandidateManifest(directory, entry);
        this.candidates.set(id, entry);
        if (operationKey) this.registrationOperations.set(operationKey, id);
        this.totalBytes += entry.size;
        return publicCandidate(entry);
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    };
    const operation = this.registerQueue.then(run, run);
    this.registerQueue = operation.catch(() => {});
    return operation;
  }

  /** Return a previously registered candidate for a scoped commit retry. */
  lookupRegistration({ userId, projectPath, threadId, idempotencyKey } = {}) {
    this.assertReady();
    if (idempotencyKey == null || idempotencyKey === "") return null;
    const binding = normalizeRegistrationScope({ userId, projectPath, threadId, idempotencyKey });
    const operationKey = registrationScopeKey(binding, idempotencyKey);
    const id = this.registrationOperations.get(operationKey);
    const entry = id ? this.candidates.get(id) : null;
    if (!entry || entry.expiresAt <= this.now()) {
      if (id) this.registrationOperations.delete(operationKey);
      if (entry) void this.remove(entry.id).catch(() => {});
      return null;
    }
    entry.updatedAt = this.now();
    return publicCandidate(entry);
  }

  /** Find a durable candidate after a process restart and a lost HTTP response. */
  findRegistration({ userId, projectPath, threadId, idempotencyKey } = {}) {
    this.assertReady();
    if (idempotencyKey == null || idempotencyKey === "") return null;
    const scope = normalizeRegistrationScope({ userId, projectPath, threadId, idempotencyKey });
    const entry = [...this.candidates.values()].find((candidate) => (
      candidate.registrationOperationKey === registrationScopeKey(scope, idempotencyKey)
    ));
    if (entry && entry.expiresAt <= this.now()) {
      void this.remove(entry.id).catch(() => {});
      return null;
    }
    return entry ? publicCandidate(entry) : null;
  }

  /** Resolve one candidate for a managed task; absolute path is private. */
  async resolve({ candidateId, userId, projectPath, threadId, relativePath, baseVersion, projectWide = false } = {}) {
    this.assertReady();
    await this.pruneExpired();
    const id = normalizeId(candidateId);
    const entry = this.candidates.get(id);
    if (!entry || entry.expiresAt <= this.now()) throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND", "资源候选不存在或已过期");
    const binding = normalizeBinding({ userId, projectPath, threadId, relativePath, baseVersion, projectWide });
    if (entry.userId !== binding.userId
      || entry.projectPath !== binding.projectPath
      || (!binding.projectWide && entry.threadId !== binding.threadId)
      || entry.relativePath !== binding.relativePath
      || entry.baseVersion !== binding.baseVersion) {
      throw candidateError(403, "MAP_AI_RESOURCE_CANDIDATE_SCOPE_MISMATCH", "资源候选不属于当前用户、工程、Thread 或版本");
    }
    let current;
    try {
      current = await this.inspectStored(entry.path);
    } catch (error) {
      // Cleanup may remove the payload between the initial lookup and the
      // content check. Normalize that race to the public candidate-not-found
      // contract instead of leaking an internal source-path error.
      if (this.candidates.get(id) !== entry || entry.pendingRemoval === true) {
        throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND", "资源候选不存在或已过期");
      }
      throw error;
    }
    // TTL cleanup (or an explicit user/session cleanup) can run while the
    // content hash is being checked.  Do not hand out a private path after
    // that cleanup has removed this exact entry from the live index.
    if (this.candidates.get(id) !== entry || entry.pendingRemoval === true) {
      throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND", "资源候选不存在或已过期");
    }
    if (current.size !== entry.size || current.sha256 !== entry.sha256) {
      await this.remove(id);
      throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "资源候选暂存内容已变化");
    }
    entry.updatedAt = this.now();
    entry.leases = (entry.leases || 0) + 1;
    const descriptor = { metadata: publicCandidate(entry) };
    Object.defineProperty(descriptor, "candidatePath", { value: entry.path, enumerable: false, writable: false });
    let released = false;
    Object.defineProperty(descriptor, "release", { value: async () => {
      if (released) return;
      released = true;
      entry.leases = Math.max(0, (entry.leases || 1) - 1);
      entry.updatedAt = this.now();
      if (entry.pendingRemoval && entry.leases === 0) await this.cleanupEntry(entry);
    }, enumerable: false, writable: false });
    return Object.freeze(descriptor);
  }

  snapshot({ candidateId, userId } = {}) {
    this.assertReady();
    void this.pruneExpired().catch(() => {});
    const entry = this.candidates.get(normalizeId(candidateId));
    if (!entry || entry.expiresAt <= this.now() || entry.userId !== normalizeUserId(userId)) throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND", "资源候选不存在或已过期");
    return publicCandidate(entry);
  }

  async remove(candidateId) {
    const id = normalizeId(candidateId);
    const entry = this.candidates.get(id);
    if (!entry) return false;
    this.candidates.delete(id);
    if (entry.registrationOperationKey) {
      const mapped = this.registrationOperations.get(entry.registrationOperationKey);
      if (mapped === id) this.registrationOperations.delete(entry.registrationOperationKey);
    }
    entry.pendingRemoval = true;
    if (entry.leases > 0) return true;
    await this.cleanupEntry(entry);
    return true;
  }

  async cleanupEntry(entry) {
    if (!entry || entry.cleaned) return;
    entry.cleaned = true;
    this.totalBytes = Math.max(0, this.totalBytes - entry.size);
    await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => {});
  }

  async deleteForUser({ userId } = {}) {
    const normalized = normalizeUserId(userId);
    const entries = [...this.candidates.values()].filter((entry) => entry.userId === normalized);
    await Promise.all(entries.map((entry) => this.remove(entry.id)));
    return Object.freeze({ deleted: entries.length });
  }

  async pruneExpired() {
    this.assertReady();
    const cutoff = this.now();
    const entries = [...this.candidates.values()].filter((entry) => entry.expiresAt <= cutoff);
    await Promise.all(entries.map((entry) => this.remove(entry.id)));
    return entries.length;
  }

  status() {
    return {
      candidates: this.candidates.size,
      bytes: this.totalBytes,
    };
  }

  async close() {
    this.closed = true;
    const entries = [...this.candidates.values()];
    this.candidates.clear();
    this.registrationOperations.clear();
    // Candidates created by a managed resource commit carry an upload-scoped
    // operation key. Keep those private directories across a graceful
    // backend stop: the next process can answer a lost HTTP response without
    // registering a second opaque candidate. Unkeyed preview candidates are
    // still ephemeral and are removed on shutdown.
    await Promise.all(entries
      .filter((entry) => !entry.registrationOperationKey)
      .map((entry) => this.cleanupEntry(entry)));
    this.totalBytes = 0;
  }

  async inspectSource(sourcePath) {
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || sourcePath.includes("\0")) throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_INVALID", "候选来源无效");
    const resolved = path.resolve(sourcePath);
    if (resolved === this.temporaryRoot || isWithinAbsolute(this.temporaryRoot, resolved)) {
      // A candidate can never be registered from its own destination tree.
      throw candidateError(403, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_INVALID", "候选来源目录无效");
    }
    if (this.sourceRoots.length && !this.sourceRoots.some((root) => isWithinAbsolute(root, resolved))) {
      throw candidateError(403, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_OUTSIDE_ROOT", "候选来源不在受控暂存目录");
    }
    await assertNoSymlink(resolved);
    const stat = await fs.lstat(resolved).catch((error) => { throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_NOT_FOUND", "候选来源不存在", error); });
    if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxCandidateBytes) throw candidateError(413, "MAP_AI_RESOURCE_CANDIDATE_SIZE_LIMIT", "候选文件大小无效或超过上限");
    const sha256 = await hashFile(resolved);
    return { path: resolved, size: stat.size, sha256 };
  }

  async inspectStored(candidatePath) {
    const resolved = path.resolve(String(candidatePath || ""));
    if (!isWithinAbsolute(this.temporaryRoot, resolved) || resolved === this.temporaryRoot) {
      throw candidateError(403, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_INVALID", "候选暂存路径无效");
    }
    await assertNoSymlink(resolved);
    const stat = await fs.lstat(resolved).catch((error) => { throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND", "资源候选不存在", error); });
    if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxCandidateBytes) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选暂存内容无效");
    return { path: resolved, size: stat.size, sha256: await hashFile(resolved) };
  }

  async restorePersistedCandidates() {
    const entries = await fs.readdir(this.temporaryRoot, { withFileTypes: true });
    for (const directoryEntry of entries) {
      if (!directoryEntry.isDirectory() || !directoryEntry.name.startsWith(CANDIDATE_DIRECTORY_PREFIX)) continue;
      const directory = path.join(this.temporaryRoot, directoryEntry.name);
      const manifestPath = path.join(directory, CANDIDATE_MANIFEST);
      let manifest;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        const entry = await restoreManifestEntry(manifest, directory, this.now());
        if (entry.expiresAt <= this.now()) {
          await fs.rm(directory, { recursive: true, force: true });
          continue;
        }
        if (this.candidates.has(entry.id) || this.totalBytes + entry.size > this.maxBytes || this.candidates.size >= this.maxCandidates) {
          await fs.rm(directory, { recursive: true, force: true });
          continue;
        }
        this.candidates.set(entry.id, entry);
        this.totalBytes += entry.size;
        if (entry.registrationOperationKey) this.registrationOperations.set(entry.registrationOperationKey, entry.id);
      } catch {
        // The directory is private service state. An incomplete or tampered
        // candidate must never become a resolvable path after restart.
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  createId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = crypto.randomBytes(24).toString("base64url");
      if (!this.candidates.has(id)) return id;
    }
    throw candidateError(503, "MAP_AI_RESOURCE_CANDIDATE_ID_UNAVAILABLE", "无法创建资源候选标识");
  }

  evictExpiredForCapacity() {
    const now = this.now();
    for (const [id, entry] of this.candidates) {
      if (entry.expiresAt <= now) {
        void this.remove(id);
      }
    }
  }

  assertReady() {
    if (this.closed || !this.initialized || !this.rootRealPath) throw candidateError(503, "MAP_AI_RESOURCE_CANDIDATE_STORE_CLOSED", "资源候选服务当前不可用");
  }
}

export class MapAiResourceCandidateError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapAiResourceCandidateError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function publicCandidate(entry) {
  return Object.freeze({
    candidateId: entry.id,
    path: entry.relativePath,
    baseVersion: entry.baseVersion,
    size: entry.size,
    sha256: entry.sha256,
    mediaType: entry.mediaType,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
  });
}

function normalizeBinding({ userId, projectPath, threadId, relativePath, baseVersion, projectWide = false }) {
  const normalizedUserId = normalizeUserId(userId);
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath) || projectPath.includes("\0")) throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_BINDING_INVALID", "工程绑定无效");
  const project = path.resolve(projectPath);
  const thread = projectWide ? null : boundedText(threadId, "threadId");
  const resource = normalizeRelativePath(relativePath);
  const version = baseVersion === null ? null : String(baseVersion || "").toLowerCase();
  if (version !== null && !SHA256.test(version)) throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_VERSION_INVALID", "候选基础版本必须是 SHA-256 或 null");
  return { userId: normalizedUserId, projectPath: project, threadId: thread, projectWide: projectWide === true, relativePath: resource, baseVersion: version };
}

function normalizeRegistrationScope({ userId, projectPath, threadId, idempotencyKey }) {
  const normalizedUserId = normalizeUserId(userId);
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_BINDING_INVALID", "工程绑定无效");
  }
  return {
    userId: normalizedUserId,
    projectPath: path.resolve(projectPath),
    threadId: boundedText(threadId, "threadId"),
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
  };
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "");
  if (!key || key.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(key)) {
    throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_OPERATION_INVALID", "资源候选提交请求 ID 无效");
  }
  return key;
}

function registrationScopeKey(binding, idempotencyKey) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  return `${binding.userId}\0${binding.projectPath}\0${binding.threadId}\0${key}`;
}

function registrationMatches(entry, binding, size, expectedSha256) {
  if (entry.userId !== binding.userId
    || entry.projectPath !== binding.projectPath
    || entry.threadId !== binding.threadId
    || entry.relativePath !== binding.relativePath
    || entry.baseVersion !== binding.baseVersion) return false;
  if (size !== undefined && Number(size) !== entry.size) return false;
  if (expectedSha256 !== undefined && String(expectedSha256).toLowerCase() !== entry.sha256) return false;
  return size !== undefined || expectedSha256 !== undefined;
}

async function writeCandidateManifest(directory, entry) {
  const manifest = {
    schema: CANDIDATE_SCHEMA,
    id: entry.id,
    userId: entry.userId,
    projectPath: entry.projectPath,
    threadId: entry.threadId,
    relativePath: entry.relativePath,
    baseVersion: entry.baseVersion,
    size: entry.size,
    sha256: entry.sha256,
    mediaType: entry.mediaType,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    registrationOperationKey: entry.registrationOperationKey || null,
  };
  const temporary = path.join(directory, `${CANDIDATE_MANIFEST}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.rename(temporary, path.join(directory, CANDIDATE_MANIFEST));
}

async function restoreManifestEntry(value, directory, now) {
  if (!value || value.schema !== CANDIDATE_SCHEMA) throw new Error("invalid candidate manifest");
  const id = normalizeId(value.id);
  const binding = normalizeBinding({
    userId: value.userId,
    projectPath: value.projectPath,
    threadId: value.threadId,
    relativePath: value.relativePath,
    baseVersion: value.baseVersion,
  });
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("invalid candidate size");
  const sha256 = normalizeHash(value.sha256);
  const expiresAt = Number(value.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error("expired candidate");
  const payload = path.join(directory, `payload${path.extname(binding.relativePath).toLowerCase()}`);
  await assertNoSymlink(directory);
  const inspected = await fs.lstat(payload);
  if (!inspected.isFile() || inspected.size !== size || await hashFile(payload) !== sha256) throw new Error("candidate payload changed");
  return {
    id,
    ...binding,
    size,
    sha256,
    mediaType: mediaTypeForPath(binding.relativePath),
    createdAt: Number(value.createdAt) || now,
    updatedAt: Number(value.updatedAt) || now,
    expiresAt,
    leases: 0,
    pendingRemoval: false,
    directory,
    path: payload,
    registrationOperationKey: value.registrationOperationKey ? String(value.registrationOperationKey) : null,
  };
}

function normalizeHash(value) {
  const hash = String(value || "").toLowerCase();
  if (!SHA256.test(hash)) throw new Error("invalid candidate hash");
  return hash;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_PATH_INVALID", "候选资源路径必须是工程相对路径");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_PATH_INVALID", "候选资源路径无效");
  const normalized = path.posix.normalize(value);
  if (!EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) throw candidateError(415, "MAP_AI_RESOURCE_CANDIDATE_KIND_INVALID", "候选资源类型不受支持");
  return normalized;
}

function normalizeUserId(value) { return boundedText(value, "userId"); }
function normalizeId(value) { return boundedText(value, "candidateId"); }
function boundedText(value, label) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw candidateError(400, "MAP_AI_RESOURCE_CANDIDATE_ARGUMENT_INVALID", `${label}无效`);
  return value;
}
function positiveInteger(value, fallback, min, max) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new TypeError("invalid candidate store limit");
  return number;
}
function mediaTypeForPath(value) {
  const extension = path.posix.extname(value).toLowerCase();
  return extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "application/json";
}
function isWithinAbsolute(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function assertNoSymlink(target) {
  const entries = [];
  let current = path.resolve(target);
  while (true) {
    entries.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const entry of entries.reverse()) {
    const stat = await fs.lstat(entry).catch((error) => { throw candidateError(404, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_NOT_FOUND", "候选来源不存在", error); });
    if (stat.isSymbolicLink()) throw candidateError(403, "MAP_AI_RESOURCE_CANDIDATE_SOURCE_SYMLINK", "候选来源不能包含符号链接");
  }
}
async function copyOwnedFile(source, destination, expectedSize) {
  const sourceHandle = await fs.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let output;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size !== expectedSize) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选来源在复制前发生变化");
    output = await fs.open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let copied = 0;
    while (copied < expectedSize) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, expectedSize - copied), copied);
      if (!bytesRead) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选来源在复制期间发生变化");
      await output.write(buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
    await output.sync();
    const after = await fs.lstat(source);
    if (!sameIdentity(before, after) || after.size !== expectedSize) throw candidateError(409, "MAP_AI_RESOURCE_CANDIDATE_CHANGED", "候选来源在复制期间发生变化");
  } finally {
    await output?.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
}
async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function candidateError(statusCode, code, message, cause = null) { return new MapAiResourceCandidateError(statusCode, code, message, cause); }
