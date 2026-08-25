import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MUTATION_LOCK_WAIT_MS = 2_000;
const INCOMPLETE_LOCK_STALE_MS = 5_000;
const UNVERIFIABLE_LOCK_STALE_MS = 2 * 60 * 1000;
const RECOVERY_CLAIM_STALE_MS = 30_000;
const CLOCK_SKEW_TOLERANCE_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 20_000;
export const MAX_RELEASE_DRAIN_MS = 60_000;
const MAX_LEASE_TTL_MS = MAX_RELEASE_DRAIN_MS;
const CORRUPT_LEASE = Symbol("corrupt release drain lease");

export class ReleaseDrainStore {
  constructor(runtimeDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(runtimeDirectory, "release-drain.json");
    this.mutationLockPath = path.join(runtimeDirectory, "release-drain.mutation.lock");
    this.mutationRecoveryPath = `${this.mutationLockPath}.recovery`;
    this.now = now;
  }

  async read() {
    const value = await readValue(this.filePath);
    if (!value) return empty();
    const active = leaseIsActive(value, this.now());
    if (value[CORRUPT_LEASE]) {
      return {
        active,
        version: null,
        startedAt: value.modifiedAt,
        expiresAt: value.modifiedAt + MAX_LEASE_TTL_MS,
      };
    }
    return {
      active,
      version: cleanVersion(value?.version),
      startedAt: finite(value?.startedAt),
      expiresAt: finite(value?.expiresAt),
    };
  }

  async begin(version, { ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
    validateTtl(ttlMs);
    return this.withMutationLock(async () => {
      const startedAt = this.now();
      const current = await readValue(this.filePath);
      if (leaseIsActive(current, startedAt)) {
        const error = new Error("A release drain lease is already active");
        error.code = "ERR_RELEASE_DRAIN_ACTIVE";
        throw error;
      }
      const value = {
        token: crypto.randomUUID(),
        version: cleanVersion(version),
        startedAt,
        deadlineAt: startedAt + MAX_LEASE_TTL_MS,
        expiresAt: startedAt + Math.min(ttlMs, MAX_LEASE_TTL_MS),
      };
      await writeValue(this.filePath, value);
      return value;
    });
  }

  async renew(token, { ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
    validateTtl(ttlMs);
    if (!validToken(token)) return false;
    return this.withMutationLock(async () => {
      const renewedAt = this.now();
      const current = await readValue(this.filePath);
      if (current?.token !== token || !leaseIsActive(current, renewedAt)) return false;
      const deadlineAt = leaseDeadlineAt(current);
      if (!deadlineAt || deadlineAt <= renewedAt) return false;
      const value = {
        ...current,
        deadlineAt,
        expiresAt: Math.min(
          Math.max(current.expiresAt, renewedAt + ttlMs),
          deadlineAt,
        ),
      };
      await writeValue(this.filePath, value);
      return value;
    });
  }

  async clear(token) {
    if (!validToken(token)) return false;
    return this.withMutationLock(async () => {
      const value = await readValue(this.filePath);
      if (value?.token !== token) return false;
      await fs.rm(this.filePath, { force: true });
      return true;
    });
  }

  async withMutationLock(operation) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
    const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;
    let lock = null;
    let identity = null;
    while (!lock && Date.now() < deadline) {
      if (await this.recoveryClaimBlocksAcquisition()) {
        await delay(10);
        continue;
      }
      try {
        const candidate = await fs.open(this.mutationLockPath, "wx", 0o600);
        let candidateIdentity = null;
        try {
          candidateIdentity = await candidate.stat();
          const startTicks = await readProcessStartTicks(process.pid);
          if (!/^\d+$/.test(startTicks || "")) {
            const error = new Error("Cannot verify release drain lock ownership");
            error.code = "ERR_RELEASE_DRAIN_OWNER_UNKNOWN";
            throw error;
          }
          const record = {
            schemaVersion: 1,
            token: crypto.randomUUID(),
            pid: process.pid,
            startTicks,
            createdAt: Date.now(),
          };
          await candidate.writeFile(`${JSON.stringify(record)}\n`);
          await candidate.sync();
          if (!await pathStillOwns(this.mutationLockPath, candidateIdentity)) {
            throw lockLostError();
          }
          if (await exists(this.mutationRecoveryPath)) {
            throw lockLostError();
          }
          lock = candidate;
          identity = candidateIdentity;
        } catch (error) {
          await candidate.close().catch(() => {});
          await removeOwnedPath(this.mutationLockPath, candidateIdentity);
          if (error.code !== "ERR_RELEASE_DRAIN_LOCK_LOST") throw error;
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await this.reclaimAbandonedMutationLock().catch(() => false);
        await delay(10);
      }
    }
    if (!lock) {
      const timeout = new Error("Timed out acquiring the release drain mutation lock");
      timeout.code = "ERR_RELEASE_DRAIN_LOCKED";
      throw timeout;
    }
    try {
      return await operation();
    } finally {
      await lock.close().catch(() => {});
      await removeOwnedPath(this.mutationLockPath, identity);
    }
  }

  async reclaimAbandonedMutationLock() {
    if (await this.recoveryClaimBlocksAcquisition()) return false;

    const observed = await readMutationLock(this.mutationLockPath);
    if (!observed || !await mutationLockIsAbandoned(observed)) return false;
    try {
      await fs.link(this.mutationLockPath, this.mutationRecoveryPath);
    } catch (error) {
      if (["EEXIST", "ENOENT"].includes(error.code)) return false;
      throw error;
    }

    try {
      await fs.utimes(this.mutationRecoveryPath, new Date(), new Date()).catch(() => {});
      const claimed = await lstatOrNull(this.mutationRecoveryPath);
      const current = await readMutationLock(this.mutationLockPath);
      if (!claimed || !current || !sameFile(claimed, observed.stat) || !sameFile(current.stat, observed.stat)) {
        return false;
      }
      if (validMutationLock(current.value) && !await mutationLockIsAbandoned(current)) return false;
      await fs.unlink(this.mutationLockPath);
      return true;
    } finally {
      await fs.rm(this.mutationRecoveryPath, { force: true }).catch(() => {});
    }
  }

  async recoveryClaimBlocksAcquisition() {
    const recovery = await lstatOrNull(this.mutationRecoveryPath);
    if (!recovery) return false;
    const age = Date.now() - recovery.mtimeMs;
    if (age >= -CLOCK_SKEW_TOLERANCE_MS && age <= RECOVERY_CLAIM_STALE_MS) return true;
    await removeOwnedPath(this.mutationRecoveryPath, recovery).catch(() => false);
    return Boolean(await lstatOrNull(this.mutationRecoveryPath));
  }
}

async function readMutationLock(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const raw = await handle.readFile("utf8");
    let value = null;
    try {
      value = JSON.parse(raw);
    } catch {
      // An interrupted creator is reclaimed only after a short grace period.
    }
    return { stat, value };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function mutationLockIsAbandoned({ stat, value }) {
  const age = Date.now() - stat.mtimeMs;
  if (!validMutationLock(value)) {
    return age < -CLOCK_SKEW_TOLERANCE_MS || age > INCOMPLETE_LOCK_STALE_MS;
  }
  const startTicks = await readProcessStartTicks(value.pid).catch(() => undefined);
  if (startTicks === undefined) {
    return age < -CLOCK_SKEW_TOLERANCE_MS || age > UNVERIFIABLE_LOCK_STALE_MS;
  }
  return startTicks === null || startTicks !== value.startTicks;
}

function validMutationLock(value) {
  return value?.schemaVersion === 1
    && typeof value.token === "string"
    && value.token.length > 0
    && Number.isSafeInteger(value.pid)
    && value.pid > 1
    && /^\d+$/.test(value.startTicks || "")
    && Number.isFinite(value.createdAt)
    && value.createdAt > 0;
}

async function readProcessStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) throw new Error("Invalid process stat");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || "") ? fields[19] : undefined;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

async function removeOwnedPath(filePath, identity) {
  if (!identity || !await pathStillOwns(filePath, identity)) return false;
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function pathStillOwns(filePath, identity) {
  const current = await lstatOrNull(filePath);
  return Boolean(current && sameFile(current, identity));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(filePath) {
  return Boolean(await lstatOrNull(filePath));
}

function lockLostError() {
  const error = new Error("Release drain mutation lock ownership was lost");
  error.code = "ERR_RELEASE_DRAIN_LOCK_LOST";
  return error;
}

async function readValue(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const stat = await fs.lstat(filePath);
      return { [CORRUPT_LEASE]: true, modifiedAt: stat.mtimeMs };
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeValue(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function leaseIsActive(value, now) {
  if (value?.[CORRUPT_LEASE]) {
    const modifiedAt = finite(value.modifiedAt);
    return modifiedAt !== null
      && modifiedAt <= now
      && now - modifiedAt < MAX_LEASE_TTL_MS;
  }
  const startedAt = finite(value?.startedAt);
  const deadlineAt = leaseDeadlineAt(value);
  return validToken(value?.token)
    && startedAt !== null
    && startedAt <= now
    && deadlineAt !== null
    && Number.isFinite(value?.expiresAt)
    && value.expiresAt > now
    && value.expiresAt <= deadlineAt
    && value.expiresAt - startedAt <= MAX_LEASE_TTL_MS;
}

function leaseDeadlineAt(value) {
  const startedAt = finite(value?.startedAt);
  if (startedAt === null) return null;
  const hardLimit = startedAt + MAX_LEASE_TTL_MS;
  const stored = finite(value?.deadlineAt);
  return stored === null ? hardLimit : Math.min(stored, hardLimit);
}

function validToken(value) {
  return typeof value === "string" && value.length > 0;
}

function validateTtl(value) {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LEASE_TTL_MS) {
    throw new RangeError(`Release drain TTL must be between 1 and ${MAX_LEASE_TTL_MS} milliseconds`);
  }
}

function empty() {
  return { active: false, version: null, startedAt: null, expiresAt: null };
}

function cleanVersion(value) {
  if (typeof value !== "string") return null;
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value : null;
}

function finite(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
