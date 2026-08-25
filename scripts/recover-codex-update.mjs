import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitCodexInstallRollback,
  completeCodexInstallRecovery,
  parseCodexVersion,
  readCodexInstallRecovery,
  restoreCodexInstallRecovery,
  verifyCodexInstallRecoverySelection,
} from "../lib/codex-install-recovery.mjs";
import { inspectCodexInstallation } from "../lib/codex-prerequisite.mjs";
import { CodexUpdateStatusStore } from "../lib/codex-update-status.mjs";
import {
  acquireOperationLock,
  inspectOperationLock,
  readProcessStartTicks,
} from "../lib/operation-lock.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || projectDirectory);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"),
);
const lockPath = path.join(runtimeDirectory, "codex-install-recovery.lock");
const codexUpdateLockPath = path.join(runtimeDirectory, "codex-update.lock");
const lockOptions = {
  ownerCommand: "scripts/recover-codex-update.mjs",
  acceptedCommands: ["scripts/recover-codex-update.mjs"],
  conflictMessage: "Another Codex installation recovery is already running",
};
const codexUpdateLockOptions = {
  ownerCommand: "scripts/update-codex.mjs",
  acceptedCommands: ["scripts/update-codex.mjs"],
  requiredArguments: ["--worker"],
};
const statusStore = new CodexUpdateStatusStore(stateDirectory);

const pending = await readCodexInstallRecovery(runtimeDirectory);
if (!pending) {
  console.log("No interrupted Codex installation requires recovery.");
} else {
  const lock = await acquireOperationLock(lockPath, {
    ...lockOptions,
    operationId: pending.operationId,
  });
  try {
    const latest = await readCodexInstallRecovery(runtimeDirectory);
    if (!latest) {
      console.log("Codex installation recovery was already completed.");
    } else if (await verifyActiveUpdateHandoff(latest)) {
      console.log("Active Codex update handoff verified; installation recovery remains armed.");
    } else if (latest.state === "decision-pending") {
      const verified = await inspectSelectedInstallation(latest);
      if (verified.appServerReady !== true) {
        throw new Error("Pending Codex CLI no longer passes app-server verification");
      }
      if (parseCodexVersion(verified.version) !== latest.afterVersion) {
        throw new Error("Pending Codex CLI version does not match the recovery journal");
      }
      await statusStore.write({
        status: "completed",
        phase: "completed",
        beforeVersion: `codex-cli ${latest.beforeVersion}`,
        afterVersion: verified.version,
        detail: "新版 Codex 正在使用，等待所有者决定保留或恢复上一版",
        completedAt: Date.now(),
        error: null,
      });
      console.log(`Preserved pending Codex ${latest.afterVersion} for an owner decision.`);
    } else if (latest.state === "update-committed") {
      const verified = await inspectSelectedInstallation(latest);
      if (verified.appServerReady !== true) {
        throw new Error("Committed Codex CLI no longer passes app-server verification");
      }
      if (parseCodexVersion(verified.version) !== latest.afterVersion) {
        throw new Error("Committed Codex CLI version does not match the recovery journal");
      }
      await statusStore.write({
        status: "completed",
        phase: "completed",
        beforeVersion: `codex-cli ${latest.beforeVersion}`,
        afterVersion: verified.version,
        detail: "Codex 升级已提交，已完成中断清理并复验 CLI",
        completedAt: Date.now(),
        error: null,
      });
      await completeCodexInstallRecovery(runtimeDirectory);
      console.log(`Completed interrupted Codex update cleanup at ${verified.version}.`);
    } else {
      if (latest.state !== "rollback-committed") {
        await restoreCodexInstallRecovery({ runtimeDirectory });
        if (!await commitCodexInstallRollback(runtimeDirectory)) {
          throw new Error("Codex rollback recovery journal disappeared before cleanup");
        }
      }
      const verified = await inspectSelectedInstallation(latest);
      if (parseCodexVersion(verified.version) !== latest.beforeVersion || verified.appServerReady !== true) {
        throw new Error("Recovered Codex CLI verification did not match the recovery journal");
      }
      await statusStore.write({
        status: "recovered",
        phase: "recovered",
        beforeVersion: `codex-cli ${latest.beforeVersion}`,
        detail: `升级未生效，已安全恢复并复验 codex-cli ${latest.beforeVersion}，可以重试`,
        recoveredVersion: `codex-cli ${latest.beforeVersion}`,
        completedAt: Date.now(),
        error: null,
      });
      await completeCodexInstallRecovery(runtimeDirectory);
      console.log(`Recovered Codex CLI ${latest.beforeVersion}.`);
    }
  } finally {
    await lock.release();
  }
}

async function verifyActiveUpdateHandoff(journal) {
  if (journal.state !== "prepared") return false;
  const initial = await inspectCodexUpdateLock();
  if (initial.state === "inactive") return false;
  if (initial.state === "unknown") {
    throw new Error("Cannot verify the Codex update lock owner during installation recovery");
  }
  if (!activeUpdateOwnsJournal(initial, journal.operationId)) {
    throw new Error("An active Codex update does not own the prepared installation recovery journal");
  }

  let verificationError = null;
  let verifiedVersion = null;
  try {
    const verified = await inspectSelectedInstallation(journal);
    if (verified.appServerReady !== true) {
      throw new Error("The active Codex update does not provide app-server");
    }
    verifiedVersion = parseCodexVersion(verified.version);
    if (verifiedVersion === journal.beforeVersion) {
      throw new Error("The active Codex update has not installed a changed CLI");
    }
  } catch (error) {
    verificationError = error;
  }

  const confirmed = await inspectCodexUpdateLock();
  if (confirmed.state === "inactive") {
    if (await initialUpdateOwnerIsInactive(initial, confirmed)) return false;
    throw new Error("The Codex update lock changed while its CLI handoff was being verified");
  }
  if (confirmed.state === "unknown") {
    throw new Error("The Codex update lock became unverifiable during CLI handoff");
  }
  if (
    !activeUpdateOwnsJournal(confirmed, journal.operationId)
    || !sameUpdateOwner(initial, confirmed)
  ) {
    throw new Error("The Codex update owner changed during CLI handoff");
  }
  if (verificationError) {
    throw new Error(`Active Codex update handoff verification failed: ${verificationError.message}`);
  }
  return verifiedVersion !== null;
}

async function inspectSelectedInstallation(journal) {
  const verified = await inspectCodexInstallation({ command: journal.commandPath });
  await verifyCodexInstallRecoverySelection(journal, verified.version);
  return verified;
}

function inspectCodexUpdateLock() {
  return inspectOperationLock(codexUpdateLockPath, codexUpdateLockOptions);
}

function activeUpdateOwnsJournal(observed, operationId) {
  return observed.state === "active"
    && observed.record?.legacy !== true
    && observed.record?.operationId === operationId
    && observed.record?.ownerCommand === codexUpdateLockOptions.ownerCommand;
}

function sameUpdateOwner(initial, confirmed) {
  return initial.record?.token === confirmed.record?.token
    && initial.record?.pid === confirmed.record?.pid
    && initial.record?.startTicks === confirmed.record?.startTicks
    && initial.identity?.dev === confirmed.identity?.dev
    && initial.identity?.ino === confirmed.identity?.ino;
}

async function initialUpdateOwnerIsInactive(initial, confirmed) {
  if (sameUpdateOwner(initial, confirmed)) return true;
  if (confirmed.identity) return false;
  const currentStartTicks = await readProcessStartTicks(initial.record.pid);
  if (currentStartTicks === undefined) {
    throw new Error("Cannot recheck the Codex update owner process identity");
  }
  return currentStartTicks === null || currentStartTicks !== initial.record.startTicks;
}
