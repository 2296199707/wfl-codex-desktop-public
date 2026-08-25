import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const STORE_VERSION = 1;
const DEFAULT_MAX_REVISIONS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/iu;

export class MapRevisionStoreError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapRevisionStoreError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Immutable, bounded snapshots of map files.  The store never exposes an
 * absolute path and never replaces a project file itself.  Callers stage the
 * current file before a successful atomic save, then commit the staged blob;
 * restore callers materialize a blob and must still use the normal project
 * transaction writer with an exact current-version check.
 */
export class MapRevisionStore {
  constructor(stateDirectory, options = {}) {
    if (typeof stateDirectory !== "string" || !stateDirectory) throw new TypeError("stateDirectory is required");
    this.stateDirectory = path.resolve(stateDirectory);
    this.filePath = path.join(this.stateDirectory, "map-revisions.json");
    this.snapshotRoot = path.join(this.stateDirectory, "map-revisions");
    this.temporaryRoot = path.resolve(options.temporaryRoot || path.join(this.stateDirectory, "map-revision-temp"));
    this.maxRevisions = positiveInteger(options.maxRevisions, DEFAULT_MAX_REVISIONS, "maxRevisions");
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
    this.maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.revisions = new Map();
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.stateDirectory, 0o700);
    await fs.mkdir(this.snapshotRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.snapshotRoot, 0o700);
    await fs.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.temporaryRoot, 0o700);
    const loaded = await readState(this.filePath, this.maxRevisions, this.snapshotRoot);
    this.revisions = loaded.revisions;
    this.initialized = true;
    const changed = await this.prune({ persist: false });
    if (writeOnInitialize && (loaded.normalized || changed > 0 || !await exists(this.filePath))) await this.write();
    return this;
  }

  /** Stage an immutable copy of the current target before a save transaction. */
  async stageCurrent({ projectPath, relativePath, targetPath, expectedVersion = null, reason = "save", actor = null } = {}) {
    this.assertInitialized();
    const scope = normalizeScope(projectPath, relativePath);
    const source = await this.openSource(targetPath, scope, expectedVersion);
    const stagedPath = path.join(this.temporaryRoot, `before-${crypto.randomBytes(18).toString("hex")}.bin`);
    try {
      const copied = await copyAndHash(source.handle, stagedPath, source.stat);
      const after = await source.handle.stat();
      if (!sameFile(source.stat, after) || copied.size !== source.stat.size) {
        throw revisionError(409, "MAP_REVISION_SOURCE_CHANGED", "地图在修订快照期间发生变化，请重试");
      }
      if (expectedVersion && copied.version !== expectedVersion) {
        throw revisionError(409, "MAP_REVISION_VERSION_CONFLICT", "地图修订基础版本不匹配");
      }
      return Object.freeze({
        stagedPath,
        projectKey: scope.projectKey,
        projectPath: scope.projectPath,
        relativePath: scope.relativePath,
        version: copied.version,
        size: copied.size,
        modifiedAt: source.stat.mtimeMs,
        reason: normalizeReason(reason),
        actor: normalizeActor(actor),
      });
    } catch (error) {
      await fs.rm(stagedPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await source.handle.close().catch(() => {});
    }
  }

  /** Commit a previously staged snapshot after its owning save succeeded. */
  async commitStaged(staged) {
    this.assertInitialized();
    const value = normalizeStaged(staged);
    if (!isWithin(this.temporaryRoot, value.stagedPath)) {
      throw revisionError(403, "MAP_REVISION_STAGE_SCOPE", "地图修订暂存路径不属于受控临时目录");
    }
    const stagedStat = await fs.lstat(value.stagedPath).catch((error) => {
      throw revisionError(410, "MAP_REVISION_STAGE_MISSING", "地图修订暂存内容已不可用", error);
    });
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.size !== value.size) {
      throw revisionError(410, "MAP_REVISION_STAGE_INVALID", "地图修订暂存内容校验失败");
    }
    return this.mutate(async () => {
      const duplicate = [...this.revisions.values()].find((entry) => (
        entry.projectKey === value.projectKey
        && entry.relativePath === value.relativePath
        && entry.version === value.version
      ));
      if (duplicate) {
        await fs.rm(value.stagedPath, { force: true }).catch(() => {});
        return publicRevision(duplicate);
      }
      const revisionId = `maprev-${crypto.randomBytes(18).toString("base64url")}`;
      const blobDirectory = path.join(this.snapshotRoot, value.projectKey);
      await fs.mkdir(blobDirectory, { recursive: true, mode: 0o700 });
      const blobPath = path.join(blobDirectory, `${revisionId}.bin`);
      await fs.rename(value.stagedPath, blobPath);
      await fs.chmod(blobPath, 0o600);
      const revision = {
        id: revisionId,
        projectKey: value.projectKey,
        relativePath: value.relativePath,
        version: value.version,
        size: value.size,
        modifiedAt: value.modifiedAt,
        createdAt: this.now(),
        reason: value.reason,
        actor: value.actor,
        blobPath,
      };
      this.revisions.set(revision.id, revision);
      await this.prune({ persist: false });
      await this.write();
      return publicRevision(revision);
    }).catch(async (error) => {
      await fs.rm(value.stagedPath, { force: true }).catch(() => {});
      throw error;
    });
  }

  async disposeStaged(staged) {
    const filename = staged?.stagedPath || staged?.candidatePath;
    if (filename) await fs.rm(String(filename), { force: true }).catch(() => {});
  }

  list({ projectPath, relativePath, limit = 100 } = {}) {
    this.assertInitialized();
    const scope = normalizeScope(projectPath, relativePath);
    const size = boundedInteger(limit, 100, 1, 500);
    return [...this.revisions.values()]
      .filter((entry) => entry.projectKey === scope.projectKey && entry.relativePath === scope.relativePath)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .slice(0, size)
      .map(publicRevision);
  }

  get({ revisionId, projectPath, relativePath } = {}) {
    this.assertInitialized();
    const scope = normalizeScope(projectPath, relativePath);
    const entry = this.requireRevision(revisionId, scope);
    return publicRevision(entry);
  }

  /** Copy a historical blob into the controlled candidate directory. */
  async materialize({ revisionId, projectPath, relativePath } = {}) {
    this.assertInitialized();
    const scope = normalizeScope(projectPath, relativePath);
    const entry = this.requireRevision(revisionId, scope);
    if (!isWithin(this.snapshotRoot, entry.blobPath)) {
      throw revisionError(410, "MAP_REVISION_BLOB_SCOPE", "地图修订内容路径无效");
    }
    const stat = await fs.lstat(entry.blobPath).catch((error) => {
      throw revisionError(410, "MAP_REVISION_BLOB_MISSING", "地图修订内容已不可用", error);
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw revisionError(410, "MAP_REVISION_BLOB_INVALID", "地图修订内容校验失败");
    const candidatePath = path.join(this.temporaryRoot, `restore-${crypto.randomBytes(18).toString("hex")}.bin`);
    try {
      const copied = await copyFileAndHash(entry.blobPath, candidatePath);
      if (copied.size !== entry.size || copied.version !== entry.version) {
        await fs.rm(candidatePath, { force: true }).catch(() => {});
        throw revisionError(410, "MAP_REVISION_BLOB_HASH_MISMATCH", "地图修订内容校验失败");
      }
      await fs.chmod(candidatePath, 0o600);
    } catch (error) {
      await fs.rm(candidatePath, { force: true }).catch(() => {});
      throw error;
    }
    return Object.freeze({ candidatePath, revision: publicRevision(entry) });
  }

  async prune({ persist = true } = {}) {
    this.assertInitialized();
    const ordered = [...this.revisions.values()].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const keep = new Set();
    let bytes = 0;
    for (const entry of ordered) {
      if (keep.size >= this.maxRevisions || bytes + entry.size > this.maxBytes) continue;
      keep.add(entry.id);
      bytes += entry.size;
    }
    const removed = ordered.filter((entry) => !keep.has(entry.id));
    for (const entry of removed) {
      this.revisions.delete(entry.id);
      await fs.rm(entry.blobPath, { force: true }).catch(() => {});
    }
    if (removed.length && persist) await this.write();
    return removed.length;
  }

  snapshot() {
    this.assertInitialized();
    return Object.freeze({ count: this.revisions.size, bytes: [...this.revisions.values()].reduce((sum, entry) => sum + entry.size, 0) });
  }

  async clear() {
    this.assertInitialized();
    this.revisions.clear();
    await fs.rm(this.snapshotRoot, { recursive: true, force: true });
    await fs.mkdir(this.snapshotRoot, { recursive: true, mode: 0o700 });
    await this.write();
  }

  async write() {
    const payload = JSON.stringify({ version: STORE_VERSION, revisions: [...this.revisions.values()].map(serializeRevision) }, null, 2) + "\n";
    const temporary = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    await fs.writeFile(temporary, payload, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  mutate(operation) {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async openSource(targetPath, scope, expectedVersion) {
    if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) throw revisionError(400, "MAP_REVISION_TARGET_INVALID", "地图修订目标路径无效");
    const resolved = path.resolve(targetPath);
    const expectedTarget = path.resolve(scope.projectPath, ...scope.relativePath.split("/"));
    if (resolved !== expectedTarget) throw revisionError(403, "MAP_REVISION_SCOPE_MISMATCH", "地图修订目标不属于授权工程");
    let handle;
    try {
      const real = await fs.realpath(resolved);
      if (real !== resolved) throw revisionError(403, "MAP_REVISION_SYMLINK", "地图修订目标不能是符号链接");
      handle = await fs.open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxFileBytes) throw revisionError(413, "MAP_REVISION_SIZE_LIMIT", "地图修订超过管理员设置的大小上限");
      if (expectedVersion && !SHA256.test(expectedVersion)) throw revisionError(400, "MAP_REVISION_VERSION_INVALID", "地图修订基础版本无效");
      return { handle, stat };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof MapRevisionStoreError) throw error;
      throw revisionError(404, "MAP_REVISION_TARGET_NOT_FOUND", "地图修订目标不存在", error);
    }
  }

  requireRevision(revisionId, scope) {
    const entry = this.revisions.get(String(revisionId || ""));
    if (!entry || entry.projectKey !== scope.projectKey || entry.relativePath !== scope.relativePath) {
      throw revisionError(404, "MAP_REVISION_NOT_FOUND", "地图修订不存在");
    }
    return entry;
  }

  assertInitialized() { if (!this.initialized) throw new Error("MapRevisionStore is not initialized"); }
}

function normalizeStaged(value) {
  if (!value || typeof value !== "object" || typeof value.stagedPath !== "string" || !path.isAbsolute(value.stagedPath)) throw revisionError(400, "MAP_REVISION_STAGE_INVALID", "地图修订暂存无效");
  if (!SHA256.test(String(value.version || ""))) throw revisionError(400, "MAP_REVISION_VERSION_INVALID", "地图修订版本无效");
  if (!isSafeProjectKey(value.projectKey)) throw revisionError(400, "MAP_REVISION_PROJECT_INVALID", "地图工程标识无效");
  return {
    stagedPath: path.resolve(value.stagedPath), projectKey: String(value.projectKey || ""),
    projectPath: String(value.projectPath || ""), relativePath: normalizeRelative(value.relativePath),
    version: String(value.version).toLowerCase(), size: boundedInteger(value.size, 0, 1, Number.MAX_SAFE_INTEGER),
    modifiedAt: Number.isFinite(Number(value.modifiedAt)) ? Number(value.modifiedAt) : 0,
    reason: normalizeReason(value.reason), actor: normalizeActor(value.actor),
  };
}

function normalizeScope(projectPath, relativePath) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) throw revisionError(400, "MAP_REVISION_PROJECT_INVALID", "地图工程路径无效");
  return { projectPath: path.resolve(projectPath), projectKey: crypto.createHash("sha256").update(path.resolve(projectPath)).digest("hex"), relativePath: normalizeRelative(relativePath) };
}

function normalizeRelative(value) {
  const text = String(value || "").replaceAll("\\", "/");
  const normalized = path.posix.normalize(text);
  if (!text || text.startsWith("/") || text.split("/").includes("..") || normalized === "." || normalized.startsWith("../") || !normalized.endsWith(".tmj")) throw revisionError(400, "MAP_REVISION_PATH_INVALID", "修订路径必须是工程相对 .tmj 路径");
  return normalized;
}

function normalizeReason(value) { return String(value || "save").slice(0, 128); }
function normalizeActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actor = {};
  for (const key of ["userId", "browserSessionId", "taskId"]) if (value[key] != null) actor[key] = String(value[key]).slice(0, 256);
  return Object.keys(actor).length ? Object.freeze(actor) : null;
}
function publicRevision(value) { return Object.freeze({ id: value.id, relativePath: value.relativePath, version: value.version, size: value.size, modifiedAt: value.modifiedAt, createdAt: value.createdAt, reason: value.reason }); }
function serializeRevision(value) { return { ...value }; }
function revisionError(statusCode, code, message, cause = null) { return new MapRevisionStoreError(statusCode, code, message, cause); }
function positiveInteger(value, fallback, name) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`); return value; }
function boundedInteger(value, fallback, min, max) { const number = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) throw new TypeError("integer out of range"); return number; }
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function exists(filename) { return fs.access(filename).then(() => true, () => false); }
async function copyAndHash(handle, targetPath, sourceStat) {
  const output = await fs.open(targetPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  const hash = crypto.createHash("sha256");
  let size = 0;
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    while (size < sourceStat.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, sourceStat.size - size), size);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      await output.write(buffer.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
    await output.sync();
  } finally { await output.close(); }
  return { size, version: hash.digest("hex") };
}

async function readState(filename, maxRevisions, snapshotRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(filename, "utf8"));
    const values = Array.isArray(parsed?.revisions) ? parsed.revisions : [];
    const revisions = new Map();
    for (const value of values.slice(-maxRevisions)) {
      try {
        if (!value || typeof value.id !== "string" || !SHA256.test(value.version)) continue;
        const relativePath = normalizeRelative(value.relativePath);
        if (!path.isAbsolute(value.blobPath) || !isWithin(snapshotRoot, value.blobPath)) continue;
        const blobPath = path.resolve(value.blobPath);
        if (!isSafeProjectKey(value.projectKey) || path.dirname(blobPath) !== path.resolve(snapshotRoot, value.projectKey)) continue;
        revisions.set(value.id, { id: value.id, projectKey: String(value.projectKey || ""), relativePath, version: value.version.toLowerCase(), size: boundedInteger(value.size, 0, 1, Number.MAX_SAFE_INTEGER), modifiedAt: Number(value.modifiedAt) || 0, createdAt: Number(value.createdAt) || 0, reason: normalizeReason(value.reason), actor: normalizeActor(value.actor), blobPath });
      } catch { /* ignore malformed historical entry */ }
    }
    return { revisions, normalized: parsed?.version !== STORE_VERSION || revisions.size !== values.length };
  } catch (error) {
    if (error?.code === "ENOENT") return { revisions: new Map(), normalized: false };
    return { revisions: new Map(), normalized: true };
  }
}

function isWithin(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved !== base && (resolved.startsWith(`${base}${path.sep}`));
}

function isSafeProjectKey(value) { return /^[a-f0-9]{64}$/u.test(String(value || "")); }

async function copyFileAndHash(sourcePath, targetPath) {
  const input = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  const output = await fs.open(targetPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let size = 0;
  try {
    while (true) {
      const result = await input.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      await output.write(chunk);
      size += result.bytesRead;
    }
    await output.sync();
  } finally {
    await input.close().catch(() => {});
    await output.close().catch(() => {});
  }
  return { size, version: hash.digest("hex") };
}
