import { MAX_RELEASE_DRAIN_MS } from "./release-drain.mjs";

const DEFAULT_LEASE_TTL_MS = 20_000;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;
const DEFAULT_MAX_DRAIN_MS = 30_000;

export async function waitForIdleDrain({
  drainStore,
  version,
  fetchReadiness,
  isCancellationRequested = async () => false,
  onWaiting = async () => {},
  timeoutMs = 10 * 60 * 1000,
  pollIntervalMs = 1_000,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
  maxDrainMs = DEFAULT_MAX_DRAIN_MS,
  allowLegacyProtocol = false,
  forceTask = false,
} = {}) {
  if (!drainStore || typeof drainStore.begin !== "function") throw new TypeError("A drain store is required");
  if (typeof fetchReadiness !== "function") throw new TypeError("A readiness probe is required");
  validateDuration(timeoutMs, "maintenance wait timeout");
  validateDuration(pollIntervalMs, "maintenance poll interval");
  validateDuration(leaseTtlMs, "maintenance lease TTL");
  validateDuration(renewIntervalMs, "maintenance lease renewal interval");
  validateDuration(maxDrainMs, "maintenance drain hard limit");
  if (maxDrainMs > MAX_RELEASE_DRAIN_MS) {
    throw new RangeError(`Maintenance drain hard limit cannot exceed ${MAX_RELEASE_DRAIN_MS}ms`);
  }
  if (renewIntervalMs >= leaseTtlMs) throw new RangeError("Maintenance lease renewal must be shorter than its TTL");

  const deadline = Date.now() + timeoutMs;
  let lastWaitingUpdate = 0;
  while (Date.now() < deadline) {
    if (await isCancellationRequested()) throw cancellationError();
    let readiness = null;
    try {
      readiness = await fetchReadiness();
      assertReadinessProtocol(readiness, { allowLegacyProtocol });
    } catch (error) {
      if (error?.code === "ERR_TASK_DRAIN_UNSUPPORTED") throw error;
      // A transient backend probe failure must never close task admission.
    }

    if (
      (forceTask || readiness?.taskIdle === true)
      && persistentStateIsIdle(readiness)
      && readiness.draining === false
    ) {
      let lease = null;
      try {
        lease = await drainStore.begin(version, { ttlMs: Math.min(leaseTtlMs, maxDrainMs) });
      } catch (error) {
        if (!["ERR_RELEASE_DRAIN_ACTIVE", "ERR_RELEASE_DRAIN_LOCKED"].includes(error.code)) throw error;
      }
      if (lease) {
        try {
          const confirmed = await fetchReadiness();
          assertReadinessProtocol(confirmed, { allowLegacyProtocol });
          if (
            (forceTask || confirmed?.taskIdle === true)
            && persistentStateIsIdle(confirmed)
            && confirmed.draining === true
            && readinessProtocol(confirmed) === readinessProtocol(readiness)
          ) {
            if (await isCancellationRequested()) throw cancellationError();
            const controller = createLeaseController(drainStore, lease, {
              leaseTtlMs,
              renewIntervalMs,
              deadlineAt: lease.startedAt + maxDrainMs,
              legacyProtocol: readinessProtocol(confirmed) === "legacy",
              forceTask,
            });
            lease = null;
            return controller;
          }
        } finally {
          if (lease) await drainStore.clear(lease.token).catch(() => {});
        }
      }
    }

    if (Date.now() - lastWaitingUpdate >= 5_000) {
      lastWaitingUpdate = Date.now();
      await onWaiting();
    }
    await delay(pollIntervalMs);
  }
  throw new Error("Timed out waiting for a safe maintenance window; task admission remained open");
}

function assertReadinessProtocol(readiness, { allowLegacyProtocol }) {
  const protocol = readinessProtocol(readiness);
  if (protocol === "current" || (allowLegacyProtocol && protocol === "legacy")) return;
  const error = new Error("Active backend does not support safe task and persistent-state draining");
  error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
  throw error;
}

function readinessProtocol(readiness) {
  if (typeof readiness?.taskIdle !== "boolean" || typeof readiness.draining !== "boolean") return null;
  if (typeof readiness.maintenanceIdle === "boolean") return "current";
  return readiness.legacyProtocol === true ? "legacy" : null;
}

function persistentStateIsIdle(readiness) {
  const protocol = readinessProtocol(readiness);
  return protocol === "current" ? readiness.maintenanceIdle === true : protocol === "legacy";
}

function createLeaseController(drainStore, lease, {
  leaseTtlMs,
  renewIntervalMs,
  deadlineAt,
  legacyProtocol,
  forceTask,
}) {
  let active = true;
  let renewalError = null;
  let renewal = Promise.resolve();
  const renew = () => {
    if (!active) return renewal;
    renewal = renewal.then(async () => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw deadlineError();
      const result = await drainStore.renew(lease.token, {
        ttlMs: Math.max(1, Math.min(leaseTtlMs, remainingMs)),
      });
      if (!result) throw new Error("Maintenance drain lease was lost");
      lease = result;
    }).catch((error) => {
      renewalError = error;
    });
    return renewal;
  };
  const timer = setInterval(renew, renewIntervalMs);
  timer.unref?.();

  return {
    get token() {
      return lease.token;
    },
    get expiresAt() {
      return lease.expiresAt;
    },
    get deadlineAt() {
      return deadlineAt;
    },
    get legacyProtocol() {
      return legacyProtocol;
    },
    get forceTask() {
      return forceTask;
    },
    async assertActive() {
      await renew();
      if (renewalError) throw renewalError;
      return true;
    },
    async release() {
      if (!active) return false;
      active = false;
      clearInterval(timer);
      await renewal;
      return drainStore.clear(lease.token);
    },
  };
}

function deadlineError() {
  const error = new Error("Maintenance drain hard deadline expired");
  error.code = "ERR_MAINTENANCE_DRAIN_DEADLINE";
  return error;
}

export function cancellationError() {
  const error = new Error("Maintenance operation was cancelled by the owner");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  return error;
}

function validateDuration(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid ${label}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
