import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  authCredentialRevision,
  loadAuth,
  validateAuthRecord,
  writeAuth,
} from "./auth.mjs";

const MIRROR_VERSION = 1;
const STATUS_VERSION = 1;
const USER_ID_PATTERN = /^u-[a-f0-9]{16}$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/u;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 120_000;
const RETRY_DELAY_MS = 30_000;

export class RescueCredentialPublisher {
  constructor({
    mirrorPath,
    statusPath = `${mirrorPath}.status.json`,
    loadSource,
    now = () => Date.now(),
    retryDelayMs = RETRY_DELAY_MS,
  } = {}) {
    if (typeof mirrorPath !== "string" || !path.isAbsolute(mirrorPath)) {
      throw new Error("Rescue credential mirror path must be absolute");
    }
    if (typeof loadSource !== "function") throw new Error("Rescue credential source loader is required");
    this.mirrorPath = path.resolve(mirrorPath);
    this.statusPath = path.resolve(statusPath);
    this.lockPath = `${this.mirrorPath}.lock`;
    this.loadSource = loadSource;
    this.now = now;
    this.retryDelayMs = Math.max(1_000, Number(retryDelayMs) || RETRY_DELAY_MS);
    this.queue = Promise.resolve();
    this.retryTimer = null;
    this.closed = false;
    this.lastStatus = null;
  }

  async initialize() {
    await this.publish("startup");
    return this;
  }

  async publish(reason = "event") {
    if (this.closed) return this.lastStatus;
    const operation = this.queue.then(() => this.reconcile(reason));
    this.queue = operation.catch(() => {});
    try {
      return await operation;
    } catch (error) {
      this.lastStatus = await this.writeFailureStatus(reason, error);
      this.scheduleRetry();
      return this.lastStatus;
    }
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async reconcile(reason) {
    const result = await withFileLock(this.lockPath, async () => {
      const source = normalizeSource(await this.loadSource());
      const current = await loadRescueCredentialMirror(this.mirrorPath);
      if (current && sameCredentialProjection(current, source)) {
        return {
          version: STATUS_VERSION,
          state: "ready",
          reason,
          generation: current.generation,
          sourceRevision: sourceRevisionOf(current),
          updatedAt: this.now(),
          lastError: null,
        };
      }
      const sourceRevision = source.sourceRevision;
      const currentRevision = current ? sourceRevisionOf(current) : 0;
      if (current && Object.hasOwn(current, "sourceRevision") && sourceRevision < currentRevision) {
        return {
          version: STATUS_VERSION,
          state: "stale",
          reason,
          generation: current.generation,
          sourceRevision: currentRevision,
          updatedAt: this.now(),
          lastError: `Ignored stale rescue credential source revision ${sourceRevision}; current revision is ${currentRevision}`,
        };
      }
      if (current && Object.hasOwn(current, "sourceRevision") && sourceRevision === currentRevision) {
        throw new Error(`Rescue credential source revision ${sourceRevision} did not advance`);
      }
      const mirror = createRescueCredentialMirror({
        ...source,
        generation: current ? current.generation + 1 : 1,
        now: this.now,
      });
      await writeRescueCredentialMirror(this.mirrorPath, mirror);
      return {
        version: STATUS_VERSION,
        state: "ready",
        reason,
        generation: mirror.generation,
        sourceRevision: mirror.sourceRevision,
        updatedAt: this.now(),
        lastError: null,
      };
    });
    this.lastStatus = await writeStatus(this.statusPath, result);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    return this.lastStatus;
  }

  async writeFailureStatus(reason, error) {
    const current = await loadRescueCredentialMirror(this.mirrorPath).catch(() => null);
    return writeStatus(this.statusPath, {
      version: STATUS_VERSION,
      state: "pending",
      reason,
      generation: current?.generation || 0,
      sourceRevision: current ? sourceRevisionOf(current) : 0,
      updatedAt: this.now(),
      lastError: String(error?.message || error || "同步失败").slice(0, 500),
    });
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.publish("retry");
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }
}

export async function publishRescueCredentialMirror({
  mirrorPath,
  statusPath,
  source,
  now = () => Date.now(),
} = {}) {
  const publisher = new RescueCredentialPublisher({
    mirrorPath,
    statusPath,
    loadSource: async () => source,
    now,
  });
  try {
    await publisher.initialize();
    return publisher.lastStatus;
  } finally {
    publisher.close();
  }
}

export function createRescueCredentialMirror({
  userId,
  username,
  role = "owner",
  status = "active",
  password,
  generation,
  source = "main",
  sourceVersion = null,
  sourceRevision,
  now = () => Date.now(),
} = {}) {
  const normalized = normalizeSource({
    userId,
    username,
    role,
    status,
    password,
    source,
    sourceVersion,
    sourceRevision,
  });
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Invalid rescue credential generation");
  }
  const mirror = {
    version: MIRROR_VERSION,
    generation,
    userId: normalized.userId,
    username: normalized.username,
    role: normalized.role,
    status: normalized.status,
    password: { ...normalized.password },
    source: normalized.source,
    sourceVersion: normalized.sourceVersion,
    sourceRevision: normalized.sourceRevision,
    updatedAt: new Date(Number(now())).toISOString(),
  };
  return {
    ...mirror,
    digest: credentialDigest(mirror),
  };
}

export async function loadRescueCredentialMirror(filePath) {
  const value = await readPrivateJson(filePath);
  if (value === null) return null;
  validateRescueCredentialMirror(value);
  return value;
}

export async function writeRescueCredentialMirror(filePath, mirror) {
  validateRescueCredentialMirror(mirror);
  await writePrivateJsonAtomic(filePath, mirror);
  return mirror;
}

export async function synchronizeRescueAuth({ mirrorPath, authPath } = {}) {
  const mirror = await loadRescueCredentialMirror(mirrorPath);
  if (!mirror) throw new Error("Rescue credential mirror is not initialized");
  const current = await loadAuth(authPath);
  if (!sameAuthRecord(current, mirror.password) || current?.username !== mirror.username) {
    await writeAuth(authPath, {
      ...mirror.password,
      username: mirror.username,
    });
    return { mirror, changed: true };
  }
  return { mirror, changed: false };
}

export function validateRescueCredentialMirror(value) {
  if (
    !value
    || value.version !== MIRROR_VERSION
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || !USER_ID_PATTERN.test(value.userId)
    || !USERNAME_PATTERN.test(value.username)
    || value.role !== "owner"
    || !["active", "disabled"].includes(value.status)
    || value.source !== "main"
    || (value.sourceVersion !== null && typeof value.sourceVersion !== "string")
    || (
      Object.hasOwn(value, "sourceRevision")
      && (!Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0)
    )
  ) {
    throw new Error("Invalid rescue credential mirror");
  }
  validateAuthRecord(value.password);
  if (value.password.username !== undefined && value.password.username !== value.username) {
    throw new Error("Rescue credential username mismatch");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("Invalid rescue credential timestamp");
  }
  if (typeof value.digest !== "string" || value.digest !== credentialDigest(value)) {
    throw new Error("Invalid rescue credential digest");
  }
  return value;
}

export function normalizeRescueCredentialSource(source) {
  return normalizeSource(source);
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") throw new Error("Rescue credential source is missing");
  if (!USER_ID_PATTERN.test(String(source.userId || ""))) throw new Error("Invalid rescue credential user id");
  if (!USERNAME_PATTERN.test(String(source.username || ""))) throw new Error("Invalid rescue credential username");
  if (source.role !== "owner") throw new Error("Only the main owner can be mirrored to rescue");
  if (!["active", "disabled"].includes(source.status)) throw new Error("Invalid rescue credential status");
  validateAuthRecord(source.password);
  return {
    userId: String(source.userId),
    username: String(source.username),
    role: "owner",
    status: source.status,
    password: { ...source.password },
    source: "main",
    sourceVersion: source.sourceVersion === null || source.sourceVersion === undefined
      ? null
      : String(source.sourceVersion),
    sourceRevision: normalizeSourceRevision(source.sourceRevision, source.password),
  };
}

function sameCredentialProjection(left, right) {
  return left.userId === right.userId
    && left.username === right.username
    && left.role === right.role
    && left.status === right.status
    && sourceRevisionOf(left) === sourceRevisionOf(right)
    && sameAuthRecord(left.password, right.password);
}

function sameAuthRecord(left, right) {
  return Boolean(left && right)
    && left.version === right.version
    && left.username === right.username
    && left.salt === right.salt
    && left.hash === right.hash
    && authCredentialRevision(left) === authCredentialRevision(right);
}

function sourceRevisionOf(value) {
  return normalizeSourceRevision(value?.sourceRevision, value?.password);
}

function normalizeSourceRevision(value, password = null) {
  const candidate = value === undefined || value === null
    ? authCredentialRevision(password)
    : value;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error("Invalid rescue credential source revision");
  }
  return candidate;
}

function credentialDigest(value) {
  const canonicalValue = {
    version: value.version,
    generation: value.generation,
    userId: value.userId,
    username: value.username,
    role: value.role,
    status: value.status,
    password: value.password,
    source: value.source,
    sourceVersion: value.sourceVersion,
  };
  // Keep version-1 mirrors written before source revisions readable. They are
  // upgraded atomically on the next real credential change.
  if (Object.hasOwn(value, "sourceRevision")) canonicalValue.sourceRevision = value.sourceRevision;
  canonicalValue.updatedAt = value.updatedAt;
  const canonical = JSON.stringify(canonicalValue);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function withFileLock(lockPath, operation) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(lockPath), 0o700);
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        return await operation();
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS && await lockOwnerIsGone(lockPath)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for rescue credential mirror lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function lockOwnerIsGone(lockPath) {
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    // A truncated lock left by a crashed writer is reclaimable once its mtime
    // is stale; a live writer always writes and syncs the metadata first.
    return true;
  }
  const pid = Number(metadata?.pid);
  if (!Number.isInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code !== "EPERM";
  }
}

async function readPrivateJson(filePath) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Private rescue credential file has unsafe permissions: ${filePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writePrivateJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeStatus(filePath, value) {
  return writePrivateJsonAtomic(filePath, value).then(() => value);
}
