import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireMaintenanceOperationLock } from "../lib/operation-lock.mjs";
import {
  RESTORE_LOCK_UNVERIFIABLE_GRACE_MS,
  RestoreOperationLock,
} from "../lib/restore-operation-lock.mjs";
import { assertRestoreDataServicesInactive } from "../lib/restore-service-state.mjs";
import {
  createRestoreTargetValidator,
  RestoreSwapJournal,
} from "../lib/restore-swap-journal.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || projectDirectory);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"),
);
const projectRoot = path.resolve(process.env.CODEX_DESKTOP_PROJECT_ROOT || path.dirname(sourceDirectory));
const usersRoot = path.resolve(process.env.CODEX_DESKTOP_MULTI_USER_ROOT || "/srv/wfl-users");
const ownerCodexHome = path.resolve(
  process.env.CODEX_DESKTOP_OWNER_CODEX_HOME || path.join(process.env.HOME || "/root", ".codex"),
);
const RECOVERY_LOCK_WAIT_MS = RESTORE_LOCK_UNVERIFIABLE_GRACE_MS + 5_000;
const RECOVERY_TRANSACTION_TIMEOUT_MS = boundedDuration(
  process.env.CODEX_DESKTOP_RESTORE_RECOVERY_TIMEOUT_MS || 80_000,
  { min: 10, max: 80_000 },
);
const RECOVERY_RETRY_MS = boundedDuration(
  process.env.CODEX_DESKTOP_RESTORE_RECOVERY_RETRY_MS || 2_000,
  { min: 5, max: 10_000 },
);
const RETRYABLE_RECOVERY_ERRORS = new Set([
  "ERR_BACKUP_RESTORE_ACTIVE",
  "ERR_BACKUP_RESTORE_LOCKED",
  "ERR_BACKUP_RESTORE_LOCK_LOST",
  "ERR_BACKUP_RESTORE_OWNER_UNKNOWN",
  "ERR_MAINTENANCE_CONFLICT",
  "ERR_RESTORE_DATA_SERVICE_ACTIVE",
  "ERR_RESTORE_DATA_SERVICE_UNKNOWN",
  "ERR_RESTORE_HANDOFF_INCOMPLETE",
  "ERR_RESTORE_HANDOFF_MISMATCH",
  "ERR_RESTORE_JOURNAL_MISSING",
  "ERR_RESTORE_JOURNAL_OWNER",
]);
const lockStore = new RestoreOperationLock(runtimeDirectory, { sourceDirectory });
const journal = new RestoreSwapJournal(runtimeDirectory, {
  isAllowedTarget: createRestoreTargetValidator({
    stateDirectory,
    usersRoot,
    ownerCodexHome,
    projectRoot,
    sourceDirectory,
  }),
});

try {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });
  await recoverPendingRestore();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function recoverPendingRestore() {
  const deadline = Date.now() + RECOVERY_TRANSACTION_TIMEOUT_MS;
  while (true) {
    const pending = await journal.read();
    if (!pending) return;
    try {
      await recoverOrValidate(pending, { deadline });
      return;
    } catch (error) {
      const remainingMs = deadline - Date.now();
      if (!RETRYABLE_RECOVERY_ERRORS.has(error.code) || remainingMs <= 0) throw error;
      process.stderr.write(`Restore recovery temporarily blocked (${error.code}); retrying in the same startup transaction.\n`);
      await delay(Math.min(RECOVERY_RETRY_MS, remainingMs));
    }
  }
}

async function recoverOrValidate(pending, { deadline }) {
  const recoveryOperationId = `restore-recovery-${process.pid}-${Date.now()}`;
  let lock = null;
  try {
    lock = await acquireMaintenanceOperationLock(runtimeDirectory, {
      operationKind: "restore",
      operationId: recoveryOperationId,
      ownerCommand: "scripts/recover-data-restore.mjs",
      lockPath: lockStore.filePath,
      acquireLock: () => lockStore.acquire({
        operationId: recoveryOperationId,
        backupId: pending.backupId,
        workerMarker: false,
        waitForUnknownMs: Math.min(
          RECOVERY_LOCK_WAIT_MS,
          Math.max(0, deadline - Date.now()),
        ),
      }),
    });
  } catch (error) {
    if (error.code !== "ERR_BACKUP_RESTORE_ACTIVE") throw error;
    await validateActiveWorkerHandoff(pending);
    return;
  }

  try {
    const current = await journal.read();
    if (!current) return;
    const consistency = await journal.inspectConsistency();
    const preferredComplete = current.desiredGeneration === "new"
      ? consistency.newComplete
      : consistency.oldComplete;
    if (!preferredComplete) await assertRestoreDataServicesInactive();
    await journal.claim({
      ownerPid: process.pid,
      ownerStartTicks: lock.record.startTicks,
    });
    await journal.recoverConsistentGeneration({
      preferredGeneration: current.desiredGeneration,
    });
  } finally {
    await lock.release().catch(() => {});
  }
}

async function validateActiveWorkerHandoff(pending) {
  const inspected = await lockStore.inspect();
  const owner = inspected.record;
  if (inspected.state !== "active"
    || owner?.operationId !== pending.operationId
    || owner?.backupId !== pending.backupId
    || owner?.pid !== pending.ownerPid
    || owner?.startTicks !== pending.ownerStartTicks) {
    throw recoveryError("活动恢复任务身份与交换日志不一致", "ERR_RESTORE_HANDOFF_MISMATCH");
  }
  const consistency = await journal.inspectConsistency();
  const complete = pending.desiredGeneration === "new"
    ? consistency.newComplete
    : consistency.oldComplete;
  if (!complete) {
    throw recoveryError("活动恢复任务尚未形成完整数据，拒绝启动后端", "ERR_RESTORE_HANDOFF_INCOMPLETE");
  }
}

function recoveryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedDuration(value, { min, max }) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < min || duration > max) {
    throw new RangeError(`Restore recovery duration must be between ${min}ms and ${max}ms`);
  }
  return duration;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
