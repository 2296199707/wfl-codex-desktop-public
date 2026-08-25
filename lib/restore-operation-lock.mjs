import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INCOMPLETE_GRACE_MS = 5_000;
export const RESTORE_LOCK_UNVERIFIABLE_GRACE_MS = 60_000;
const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;
const MAX_FUTURE_MTIME_SKEW_MS = 5_000;

export class RestoreOperationLock {
  constructor(runtimeDirectory, {
    sourceDirectory,
    allowedScripts = ["restore-data-backup.mjs", "recover-data-restore.mjs"],
    incompleteGraceMs = DEFAULT_INCOMPLETE_GRACE_MS,
    unverifiableGraceMs = RESTORE_LOCK_UNVERIFIABLE_GRACE_MS,
    lockHeartbeatMs = DEFAULT_LOCK_HEARTBEAT_MS,
    readProcessStartTicks: processStartTicksReader = readProcessStartTicks,
    readProcessArguments: processArgumentsReader = readProcessArguments,
    touchHeartbeat = touchLockHeartbeat,
    onHeartbeatError = reportHeartbeatError,
    now = () => Date.now(),
    monotonicNow = () => performance.now(),
  } = {}) {
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.filePath = path.join(this.runtimeDirectory, "backup-restore.lock");
    this.sourceDirectory = path.resolve(sourceDirectory || path.dirname(this.runtimeDirectory));
    this.allowedScripts = new Set(allowedScripts.map((name) => path.resolve(
      this.sourceDirectory,
      "scripts",
      String(name),
    )));
    this.incompleteGraceMs = positiveDuration(incompleteGraceMs, DEFAULT_INCOMPLETE_GRACE_MS);
    this.unverifiableGraceMs = positiveDuration(
      unverifiableGraceMs,
      RESTORE_LOCK_UNVERIFIABLE_GRACE_MS,
    );
    this.lockHeartbeatMs = Math.min(
      positiveDuration(lockHeartbeatMs, DEFAULT_LOCK_HEARTBEAT_MS),
      Math.max(1, this.unverifiableGraceMs / 2),
    );
    this.readProcessStartTicks = processStartTicksReader;
    this.readProcessArguments = processArgumentsReader;
    this.touchHeartbeat = touchHeartbeat;
    this.onHeartbeatError = onHeartbeatError;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.futureMtimeObservation = null;
  }

  async acquire({
    operationId,
    backupId = null,
    workerMarker = true,
    waitForUnknownMs = 0,
  } = {}) {
    const startTicks = await this.readProcessStartTicks(process.pid);
    if (!/^\d+$/.test(startTicks || "")) throw lockError("无法确认备份恢复进程身份", "ERR_BACKUP_RESTORE_OWNER_UNKNOWN");
    const record = {
      schemaVersion: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      startTicks,
      operationId: requireOperationId(operationId),
      backupId: backupId === null ? null : String(backupId),
      workerMarker: Boolean(workerMarker),
      createdAt: this.now(),
    };

    await fs.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o755 });
    const unknownDeadline = Date.now() + nonNegativeDuration(waitForUnknownMs, 0);
    let collisionAttempts = 0;
    while (collisionAttempts < 3) {
      let handle = null;
      let identity = null;
      let stopHeartbeat = () => {};
      try {
        handle = await fs.open(this.filePath, "wx", 0o600);
        identity = await handle.stat();
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
        if (!await pathStillOwns(this.filePath, identity)) {
          throw lockError("备份恢复任务锁所有权已丢失", "ERR_BACKUP_RESTORE_LOCK_LOST");
        }
        stopHeartbeat = startLockHeartbeat(handle, this.lockHeartbeatMs, {
          touchHeartbeat: this.touchHeartbeat,
          onHeartbeatError: this.onHeartbeatError,
        });
        return {
          record,
          release: async () => {
            stopHeartbeat();
            await handle.close().catch(() => {});
            return removeOwnedPath(this.filePath, identity);
          },
        };
      } catch (error) {
        stopHeartbeat();
        await handle?.close().catch(() => {});
        if (identity) await removeOwnedPath(this.filePath, identity).catch(() => {});
        if (error.code !== "EEXIST") throw error;

        const observed = await this.read();
        if (!observed) {
          collisionAttempts += 1;
          continue;
        }
        const ownerState = await this.ownerState(observed);
        if (ownerState === "active") {
          throw lockError("另一个备份恢复任务仍在运行", "ERR_BACKUP_RESTORE_ACTIVE");
        }
        if (ownerState !== "inactive") {
          const remainingMs = unknownDeadline - Date.now();
          if (remainingMs > 0) {
            await delay(Math.min(250, remainingMs));
            continue;
          }
          throw lockError("无法安全确认上一个备份恢复任务是否结束", "ERR_BACKUP_RESTORE_OWNER_UNKNOWN");
        }
        await removeOwnedPath(this.filePath, observed.stat);
        collisionAttempts += 1;
      }
    }
    throw lockError("无法获取备份恢复任务锁", "ERR_BACKUP_RESTORE_LOCKED");
  }

  async inspect() {
    const observed = await this.read();
    if (!observed) return { state: "inactive", record: null };
    return { state: await this.ownerState(observed), record: observed.value };
  }

  async read() {
    let handle = null;
    try {
      handle = await fs.open(this.filePath, "r");
      const stat = await handle.stat();
      const raw = await handle.readFile("utf8");
      let value = null;
      try { value = JSON.parse(raw); } catch { /* An interrupted creator remains unknown during its grace period. */ }
      return { stat, value };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async ownerState({ stat, value }) {
    if (!validLock(value)) {
      return this.timestampWithinGrace(stat, this.incompleteGraceMs) ? "unknown" : "inactive";
    }

    let currentStartTicks;
    try {
      currentStartTicks = await this.readProcessStartTicks(value.pid);
    } catch {
      return this.unverifiableOwnerState(stat);
    }
    if (currentStartTicks === null) return "inactive";
    if (!/^\d+$/.test(currentStartTicks || "")) return this.unverifiableOwnerState(stat);
    if (currentStartTicks !== value.startTicks) return "inactive";

    let argumentsList;
    try {
      argumentsList = await this.readProcessArguments(value.pid);
    } catch {
      return this.unverifiableOwnerState(stat);
    }
    if (argumentsList === null) return "inactive";
    if (!Array.isArray(argumentsList)) return this.unverifiableOwnerState(stat);
    const ownsAllowedScript = argumentsList.some((argument) => {
      if (!argument || argument.startsWith("-")) return false;
      return this.allowedScripts.has(path.resolve(this.sourceDirectory, argument));
    });
    if (!ownsAllowedScript) return "inactive";
    if (value.workerMarker && !argumentsList.includes("--worker")) return "inactive";
    if (value.backupId && !argumentsList.includes(value.backupId)) return "inactive";
    this.clearFutureMtimeObservation(stat);
    return "active";
  }

  unverifiableOwnerState(stat) {
    return this.timestampWithinGrace(stat, this.unverifiableGraceMs) ? "unknown" : "inactive";
  }

  timestampWithinGrace(stat, graceMs) {
    const ageMs = this.now() - stat.mtimeMs;
    if (!Number.isFinite(ageMs)) return false;
    if (ageMs >= -MAX_FUTURE_MTIME_SKEW_MS) {
      this.clearFutureMtimeObservation(stat);
      return ageMs <= graceMs;
    }

    const identity = futureMtimeIdentity(stat);
    const observedAt = this.monotonicNow();
    if (!Number.isFinite(observedAt)) return false;
    if (this.futureMtimeObservation?.identity !== identity) {
      this.futureMtimeObservation = { identity, observedAt };
    }
    const elapsedMs = observedAt - this.futureMtimeObservation.observedAt;
    return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= graceMs;
  }

  clearFutureMtimeObservation(stat) {
    if (this.futureMtimeObservation?.identity === futureMtimeIdentity(stat)) {
      this.futureMtimeObservation = null;
    }
  }
}

export async function readProcessStartTicks(pid) {
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

function validLock(value) {
  return value?.schemaVersion === 1
    && typeof value.token === "string"
    && value.token.length > 0
    && Number.isSafeInteger(value.pid)
    && value.pid > 1
    && /^\d+$/.test(value.startTicks || "")
    && typeof value.operationId === "string"
    && value.operationId.length > 0
    && (value.backupId === null || typeof value.backupId === "string")
    && typeof value.workerMarker === "boolean"
    && Number.isFinite(value.createdAt)
    && value.createdAt > 0;
}

function futureMtimeIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.ctimeMs, stat.mtimeMs].join(":");
}

function requireOperationId(value) {
  const operationId = String(value || "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,158}[A-Za-z0-9])?$/.test(operationId)) {
    throw new TypeError("Invalid restore operation ID");
  }
  return operationId;
}

async function readProcessArguments(pid) {
  try {
    const commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.split("\0").filter(Boolean);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

function startLockHeartbeat(handle, intervalMs, { touchHeartbeat, onHeartbeatError }) {
  let stopped = false;
  let timer = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await touchHeartbeat(handle);
      } catch (error) {
        if (stopped) return;
        try { onHeartbeatError(error); } catch { /* Heartbeat retries must not depend on diagnostics. */ }
      }
      schedule();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function touchLockHeartbeat(handle) {
  const now = new Date();
  return handle.utimes(now, now);
}

function reportHeartbeatError(error) {
  const detail = error?.code ? `${error.code}: ${error.message}` : error?.message || String(error);
  process.stderr.write(`Backup restore lock heartbeat failed; retrying: ${detail}\n`);
}

function positiveDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function nonNegativeDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  return Boolean(current && current.dev === identity.dev && current.ino === identity.ino);
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lockError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
