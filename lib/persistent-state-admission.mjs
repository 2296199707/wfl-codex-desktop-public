const DEFAULT_ORPHAN_GRACE_MS = 30_000;
const DEFAULT_ORPHAN_MAX_MS = 10 * 60 * 1000;
const DEFAULT_ORPHAN_RECHECK_MS = 1_000;

export class PersistentStateAdmission {
  constructor({
    drainStore,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
    orphanMaxMs = DEFAULT_ORPHAN_MAX_MS,
    orphanRecheckMs = DEFAULT_ORPHAN_RECHECK_MS,
    canReapOrphan = async () => true,
    onOrphanReaped = () => {},
    blockedMessage = "Maintenance is draining persistent state",
    now = () => Date.now(),
  } = {}) {
    if (!drainStore || typeof drainStore.read !== "function") throw new TypeError("A drain store is required");
    validateDuration(orphanGraceMs, "orphan grace period");
    validateDuration(orphanMaxMs, "orphan maximum lifetime");
    validateDuration(orphanRecheckMs, "orphan recheck interval");
    if (orphanMaxMs < orphanGraceMs) throw new RangeError("Orphan maximum lifetime cannot be shorter than its grace period");
    if (typeof canReapOrphan !== "function") throw new TypeError("canReapOrphan must be a function");
    this.drainStore = drainStore;
    this.orphanGraceMs = orphanGraceMs;
    this.orphanMaxMs = orphanMaxMs;
    this.orphanRecheckMs = orphanRecheckMs;
    this.canReapOrphan = canReapOrphan;
    this.onOrphanReaped = onOrphanReaped;
    this.blockedMessage = blockedMessage;
    this.now = now;
    this.sequence = 0;
    this.operations = new Map();
  }

  get idle() {
    return this.operations.size === 0;
  }

  snapshot() {
    const values = [...this.operations.values()];
    const orphans = values.filter((operation) => operation.orphanedAt !== null);
    return {
      active: values.length,
      orphaned: orphans.length,
      oldestOrphanedAt: orphans.length ? Math.min(...orphans.map((operation) => operation.orphanedAt)) : null,
    };
  }

  async begin({ allowDuringDrain = false } = {}) {
    const operation = {
      id: `persistent-${process.pid}-${++this.sequence}`,
      startedAt: this.now(),
      orphanedAt: null,
      timer: null,
      released: false,
    };
    this.operations.set(operation.id, operation);
    const handle = this.handle(operation);
    if (allowDuringDrain) return handle;
    try {
      const drain = await this.drainStore.read();
      if (drain.active) throw drainActiveError(this.blockedMessage);
      return handle;
    } catch (error) {
      handle.release();
      throw error;
    }
  }

  async clearOrphans({ requireBackgroundIdle = true } = {}) {
    const orphans = [...this.operations.values()].filter((operation) => operation.orphanedAt !== null);
    if (!orphans.length) return 0;
    if (requireBackgroundIdle && !await this.canReapOrphan()) return 0;
    let cleared = 0;
    for (const operation of orphans) {
      if (this.release(operation)) cleared += 1;
    }
    return cleared;
  }

  handle(operation) {
    return Object.freeze({
      id: operation.id,
      release: () => this.release(operation),
      orphan: () => this.orphan(operation),
    });
  }

  release(operation) {
    if (operation.released) return false;
    operation.released = true;
    clearTimeout(operation.timer);
    operation.timer = null;
    this.operations.delete(operation.id);
    return true;
  }

  orphan(operation) {
    if (operation.released || operation.orphanedAt !== null) return false;
    operation.orphanedAt = this.now();
    this.scheduleOrphanCheck(operation, this.orphanGraceMs);
    return true;
  }

  scheduleOrphanCheck(operation, delayMs) {
    clearTimeout(operation.timer);
    operation.timer = setTimeout(() => {
      this.reapOrphan(operation).catch(() => {
        if (!operation.released) this.scheduleOrphanCheck(operation, this.orphanRecheckMs);
      });
    }, Math.max(1, delayMs));
    operation.timer.unref?.();
  }

  async reapOrphan(operation) {
    if (operation.released || operation.orphanedAt === null) return;
    const ageMs = Math.max(0, this.now() - operation.orphanedAt);
    if (ageMs < this.orphanGraceMs) {
      this.scheduleOrphanCheck(operation, this.orphanGraceMs - ageMs);
      return;
    }
    let backgroundIdle = false;
    try {
      backgroundIdle = await this.canReapOrphan();
    } catch {
      // The hard lifetime still bounds an orphan when a background probe fails.
    }
    if (backgroundIdle || ageMs >= this.orphanMaxMs) {
      const forced = !backgroundIdle;
      this.release(operation);
      try {
        await this.onOrphanReaped({ id: operation.id, ageMs, forced });
      } catch {
        // Admission recovery must not depend on logging availability.
      }
      return;
    }
    const remainingMs = Math.max(1, this.orphanMaxMs - ageMs);
    this.scheduleOrphanCheck(operation, Math.min(this.orphanRecheckMs, remainingMs));
  }
}

function drainActiveError(message) {
  const error = new Error(message);
  error.code = "ERR_MAINTENANCE_DRAIN_ACTIVE";
  error.statusCode = 503;
  return error;
}

function validateDuration(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid ${label}`);
}
