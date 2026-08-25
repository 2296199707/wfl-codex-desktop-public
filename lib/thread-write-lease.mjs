import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const LOCK_RETRY_LIMIT = 250;
const LOCK_RETRY_MS = 4;
const LOCK_STALE_MS = 10_000;

export class ThreadWriteLeaseStore {
  constructor(stateDirectory, { ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 50) throw new TypeError("Thread lease TTL must be at least 50ms");
    this.directory = path.join(path.resolve(stateDirectory), "thread-write-leases-v1");
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    return this;
  }

  async acquire(threadId, ownerId, details = {}) {
    validateId(threadId, "Thread id");
    validateId(ownerId, "Lease owner id");
    const leaseDirectory = this.#leaseDirectory(threadId);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await fs.mkdir(leaseDirectory, { mode: 0o700 });
        return await this.#withLock(leaseDirectory, async () => {
          const lease = this.#newHolder(threadId, ownerId, details);
          await this.#writeLease(leaseDirectory, storedLease(threadId, ownerId, [lease]));
          return lease;
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      try {
        return await this.#withLock(leaseDirectory, async () => {
          const current = await this.#readStoredLease(leaseDirectory);
          const holders = liveHolders(current, this.now());
          if (holders.length && current.ownerId !== ownerId) throw conflictError(publicLease(current, holders));
          const lease = this.#newHolder(threadId, ownerId, details);
          await this.#writeLease(leaseDirectory, storedLease(threadId, ownerId, [...holders, lease]));
          return lease;
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error("Unable to acquire thread write lease after repeated contention");
  }

  async renew(lease) {
    validateHolder(lease);
    const leaseDirectory = this.#leaseDirectory(lease.threadId);
    return this.#withLock(leaseDirectory, async () => {
      const current = await this.#readStoredLease(leaseDirectory);
      const holders = liveHolders(current, this.now());
      const index = holders.findIndex((holder) => holder.token === lease.token && holder.ownerId === lease.ownerId);
      if (index === -1) throw conflictError(publicLease(current, holders));
      const now = this.now();
      const renewed = { ...holders[index], renewedAt: now, expiresAt: now + this.ttlMs };
      holders[index] = renewed;
      await this.#writeLease(leaseDirectory, storedLease(lease.threadId, lease.ownerId, holders));
      return renewed;
    });
  }

  async release(lease) {
    validateHolder(lease);
    const leaseDirectory = this.#leaseDirectory(lease.threadId);
    try {
      return await this.#withLock(leaseDirectory, async () => {
        const current = await this.#readStoredLease(leaseDirectory);
        const holders = liveHolders(current, this.now());
        const remaining = holders.filter((holder) => holder.token !== lease.token);
        if (remaining.length === holders.length) return false;
        await this.#writeLease(
          leaseDirectory,
          storedLease(lease.threadId, current?.ownerId || lease.ownerId, remaining),
        );
        return true;
      });
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async inspect(threadId) {
    validateId(threadId, "Thread id");
    const directory = this.#leaseDirectory(threadId);
    const lease = await this.#readStoredLease(directory);
    const holders = liveHolders(lease, this.now());
    return publicLease(lease, holders);
  }

  #leaseDirectory(threadId) {
    return path.join(this.directory, crypto.createHash("sha256").update(threadId).digest("hex"));
  }

  #newHolder(threadId, ownerId, details) {
    const now = this.now();
    return {
      version: 2,
      threadId,
      ownerId,
      token: crypto.randomUUID(),
      surface: normalizeSurface(details.surface),
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  async #readStoredLease(directory) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, "lease.json"), "utf8"));
      if (validStoredLease(value)) return value;
      if (validHolder(value)) return storedLease(value.threadId, value.ownerId, [{ ...value, version: 2 }]);
      return null;
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EISDIR", "SyntaxError"].includes(error.code || error.name)) return null;
      throw error;
    }
  }

  async #writeLease(directory, lease) {
    const destination = path.join(directory, "lease.json");
    const temporary = path.join(directory, `.lease.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #withLock(directory, operation) {
    const lockDirectory = path.join(directory, ".lock");
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
      try {
        await fs.mkdir(lockDirectory, { mode: 0o700 });
        try {
          return await operation();
        } finally {
          await fs.rm(lockDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code === "ENOENT") throw error;
        if (error.code !== "EEXIST") throw error;
        const stat = await fs.stat(lockDirectory).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        } else {
          await delay(LOCK_RETRY_MS);
        }
      }
    }
    throw new Error("Unable to lock thread write lease after repeated contention");
  }
}

function conflictError(lease) {
  const surface = lease?.surface === "rescue"
    ? "备用窗口"
    : lease?.surface === "main"
      ? "主窗口"
      : lease?.surface === "background"
        ? "Codex 后台任务"
        : "另一个窗口";
  const error = new Error(`该对话正在由${surface}执行写入，请等待当前任务完成后重试`);
  error.code = "ERR_THREAD_LEASE_CONFLICT";
  error.lease = lease ? {
    surface: lease.surface,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  } : null;
  return error;
}

function normalizeSurface(value) {
  return ["main", "rescue", "background"].includes(value) ? value : "unknown";
}

function storedLease(threadId, ownerId, holders) {
  const normalized = holders.filter(validHolder);
  return {
    version: 2,
    threadId,
    ownerId,
    holders: normalized,
    acquiredAt: normalized.length ? Math.min(...normalized.map((holder) => holder.acquiredAt)) : null,
    renewedAt: normalized.length ? Math.max(...normalized.map((holder) => holder.renewedAt)) : null,
    expiresAt: normalized.length ? Math.max(...normalized.map((holder) => holder.expiresAt)) : null,
  };
}

function validStoredLease(value) {
  return Boolean(
    value
    && value.version === 2
    && typeof value.threadId === "string"
    && typeof value.ownerId === "string"
    && Array.isArray(value.holders)
    && value.holders.every((holder) => validHolder(holder))
    && value.holders.every((holder) => holder.threadId === value.threadId && holder.ownerId === value.ownerId),
  );
}

function validateHolder(lease) {
  if (!validHolder(lease)) throw new TypeError("Thread lease is invalid");
}

function validHolder(value) {
  return Boolean(
    value
    && [1, 2].includes(value.version)
    && typeof value.threadId === "string"
    && typeof value.ownerId === "string"
    && typeof value.token === "string"
    && Number.isFinite(value.acquiredAt)
    && Number.isFinite(value.expiresAt),
  );
}

function liveHolders(lease, now) {
  if (!validStoredLease(lease)) return [];
  return lease.holders.filter((holder) => holder.expiresAt > now);
}

function publicLease(lease, holders) {
  if (!validStoredLease(lease) || !holders.length) return null;
  const primary = holders[0];
  return {
    ...primary,
    references: holders.length,
    expiresAt: Math.max(...holders.map((holder) => holder.expiresAt)),
  };
}

function validateId(value, label) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
