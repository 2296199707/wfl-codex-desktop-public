import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackupCenter } from "../lib/backup-center.mjs";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { waitForIdleDrain } from "../lib/maintenance-drain.mjs";
import {
  acquireMaintenanceOperationLock,
  cancelMaintenanceReservation,
} from "../lib/operation-lock.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";
import { RestoreOperationLock } from "../lib/restore-operation-lock.mjs";
import {
  assertRestoreDataServicesInactive,
  systemdUnitIsActive,
} from "../lib/restore-service-state.mjs";
import {
  createRestoreTargetValidator,
  RestoreSwapJournal,
} from "../lib/restore-swap-journal.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDirectory = path.resolve(process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"));
const stateDirectory = path.resolve(process.env.CODEX_DESKTOP_STATE_DIR || path.join(projectDir, ".codex-desktop"));
const backupDirectory = path.resolve(process.env.CODEX_DESKTOP_BACKUP_DIR || path.join(runtimeDirectory, "data-backups"));
const projectRoot = path.resolve(process.env.CODEX_DESKTOP_PROJECT_ROOT || "/srv");
const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || projectDir);
const usersRoot = path.resolve(process.env.CODEX_DESKTOP_MULTI_USER_ROOT || "/srv/wfl-users");
const ownerCodexHome = path.resolve(process.env.CODEX_DESKTOP_OWNER_CODEX_HOME || path.join(process.env.HOME || "/root", ".codex"));
const statusPath = path.join(runtimeDirectory, "backup-restore-status.json");
const activePortPath = path.join(runtimeDirectory, "active-port");
const DRAIN_STOP_TIMEOUT_MS = 7_000;
const DRAIN_START_TIMEOUT_MS = 3_000;
const RECOVERY_SYSTEMCTL_TIMEOUT_MS = 7_000;
const DRAIN_RELEASE_RESERVE_MS = 1_000;
const DRAIN_STOPPED_ROLLBACK_RESERVE_MS = RECOVERY_SYSTEMCTL_TIMEOUT_MS + 2_000;
const DRAIN_POST_START_ROLLBACK_RESERVE_MS = (2 * RECOVERY_SYSTEMCTL_TIMEOUT_MS) + 2_000;
const DRAIN_ROLLBACK_DECISION_MARGIN_MS = 1_000;
const DRAIN_INITIAL_STOP_RESERVE_MS = DRAIN_START_TIMEOUT_MS + DRAIN_POST_START_ROLLBACK_RESERVE_MS;
const version = (await fs.readFile(path.join(projectDir, "VERSION"), "utf8")).trim();
const backupId = process.argv.slice(2).find((argument) => argument !== "--worker");
const drainStore = new ReleaseDrainStore(runtimeDirectory);
const cancelStore = new DeploymentCancelStore(runtimeDirectory);
const backupCenter = new BackupCenter(backupDirectory, { stateDirectory, version });
const isAllowedRestoreTarget = createRestoreTargetValidator({
  stateDirectory,
  usersRoot,
  ownerCodexHome,
  projectRoot,
  sourceDirectory,
});
const restoreLockStore = new RestoreOperationLock(runtimeDirectory, { sourceDirectory });
const swapJournal = new RestoreSwapJournal(runtimeDirectory, {
  isAllowedTarget: isAllowedRestoreTarget,
});

const operationId = process.env.CODEX_DESKTOP_OPERATION_ID || `backup-restore-${process.pid}-${Date.now()}`;
const reservationToken = process.env.CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN || null;
let restoreLock = null;
let drainLease = null;
let activePort = null;
let unit = null;
let backendStopped = false;
let preserveRecoveryArtifacts = false;
let backendReady = false;
const prepared = [];
const stagingDirectory = path.join(runtimeDirectory, `restore-staging-${backupId || "invalid"}`);

try {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });
  try {
    restoreLock = await acquireRestoreMaintenanceLock();
  } catch (error) {
    if (reservationToken) {
      const queued = await readStatus().catch(() => null);
      if (restoreStatusMatchesCurrentOperation(queued) && !restoreStatusIsTerminal(queued)) {
        await writeStatus({
          ...queued,
          status: "failed",
          phase: "failed",
          detail: "备份恢复任务未能取得独占执行窗口",
          updatedAt: Date.now(),
          completedAt: Date.now(),
          error: error.message,
        }).catch(() => {});
      }
      await cancelMaintenanceReservation(runtimeDirectory, {
        operationId,
        reservationToken,
        ownerCommand: "scripts/restore-data-backup.mjs",
      }).catch(() => {});
    }
    throw error;
  }
  const alreadyTerminal = await operationAlreadyTerminalWithoutJournal();
  const resumed = alreadyTerminal ? null : await recoverPendingSwap();
  if (alreadyTerminal) {
    // A restarted transient worker may arrive after the durable operation already finished.
  } else if (resumed?.sameOperation) {
    if (resumed.generation !== "new") {
      const error = new Error("上次恢复中断后只能保留原数据，本次备份没有生效");
      error.code = "ERR_BACKUP_RESTORE_RECOVERED_OLD";
      await update("failed", "备份恢复中断后已保留原数据，本次备份没有生效", {
        status: "failed", completedAt: Date.now(), error: error.message,
      });
      await finalizeRecoveredSwap(resumed);
      throw error;
    }
    await update("completed", "备份恢复已自动续接完成，请重新登录", {
      status: "completed", completedAt: Date.now(), error: null,
    });
    await finalizeRecoveredSwap(resumed);
  } else {
    if (resumed) {
      await update("preparing", "上一个中断的数据恢复已修复，正在准备当前备份");
      await finalizeRecoveredSwap(resumed);
    }
    await backupCenter.initialize();
    backupCenter.requireBackup(backupId);
    await update("preparing", "正在校验并解密备份", { startedAt: Date.now(), backupId });
    const staged = await backupCenter.stageForRestore(backupId, stagingDirectory);
    const currentHostId = await machineIdHash();
    if (!staged.manifest.hostId || staged.manifest.hostId !== currentHostId) {
      throw new Error("此备份不属于当前服务器，不能使用同机恢复");
    }
    if (staged.manifest.appVersion !== version) {
      throw new Error(`备份版本 v${staged.manifest.appVersion || "unknown"} 与当前 v${version} 不一致`);
    }
    const sources = validateRestoreSources(staged.manifest.sources);
    await update("preparing", "正在准备可回退的数据目录");
    for (const source of sources) {
      const stagedSource = path.join(stagingDirectory, source.path.slice(1));
      const suffix = `.wfl-restore-${crypto.randomBytes(5).toString("hex")}`;
      const replacement = `${source.path}${suffix}.new`;
      const previous = `${source.path}${suffix}.old`;
      await fs.access(stagedSource);
      await run("cp", ["-a", stagedSource, replacement]);
      prepared.push({ target: source.path, replacement, previous, originalExisted: false });
    }

    activePort = Number((await fs.readFile(activePortPath, "utf8")).trim());
    if (![4318, 4319].includes(activePort)) throw new Error("活动后端端口无效");
    unit = `wfl-codex-desktop-backend@${activePort}.service`;
    await assertRestoreDataServicesInactive({ allowedActiveUnits: [unit] });
    await update("waiting", "等待对话自然结束，期间仍可继续发送消息");
    drainLease = await waitForIdleDrain({
      drainStore,
      version,
      fetchReadiness: () => fetchTaskReadiness(activePort),
      isCancellationRequested: () => cancelStore.isCancellationRequested(operationId),
      onWaiting: () => update("waiting", "仍在等待安全恢复窗口，对话服务保持开放"),
      timeoutMs: restoreDrainTimeout(),
    });
    await assertRestoreDataServicesInactive({ allowedActiveUnits: [unit] });
    await update("draining", "已确认任务空闲，正在短时切换备份数据");
    await assertNotCancelled();
    await drainLease.assertActive();
    await commitRestoreDecision();
    await update("switching", "正在切换备份数据，网页会短暂重连");
    await drainLease.assertActive();

    for (const entry of prepared) entry.originalExisted = await exists(entry.target);
    await swapJournal.create({
      operationId,
      unit,
      backupId,
      ownerPid: process.pid,
      ownerStartTicks: restoreLock.record.startTicks,
      entries: prepared,
    });
    await swapJournal.setPhase("stopping");
    const stopTimeoutMs = drainSystemctlBudget(
      drainLease,
      DRAIN_STOP_TIMEOUT_MS,
      DRAIN_INITIAL_STOP_RESERVE_MS,
    );
    backendStopped = true;
    await run("systemctl", ["stop", unit], { timeoutMs: stopTimeoutMs });
    await drainLease.assertActive();
    await assertRestoreDataServicesInactive();
    for (let index = 0; index < prepared.length; index += 1) {
      await drainLease.assertActive();
      await swapJournal.moveOriginalAside(index);
      await swapJournal.activateReplacement(index);
      await drainLease.assertActive();
    }
    await swapJournal.setPhase("starting");
    await run("systemctl", ["start", unit], {
      timeoutMs: drainSystemctlBudget(
        drainLease,
        DRAIN_START_TIMEOUT_MS,
        DRAIN_POST_START_ROLLBACK_RESERVE_MS + DRAIN_ROLLBACK_DECISION_MARGIN_MS,
      ),
    });
    backendStopped = false;
    await drainLease.assertActive();
    await waitForReady(activePort, remainingDrainMs(
      drainLease,
      DRAIN_POST_START_ROLLBACK_RESERVE_MS + DRAIN_ROLLBACK_DECISION_MARGIN_MS,
    ));
    backendReady = true;
    await drainLease.assertActive();
    await swapJournal.setPhase("verified");
    const completedJournal = await swapJournal.read();
    await update("completed", "备份恢复完成，请重新登录", {
      status: "completed", completedAt: Date.now(), error: null,
    });
    await swapJournal.clear(operationId);
    await cleanupJournalArtifacts(completedJournal);
    if (drainLease) await drainLease.release().catch(() => {});
    drainLease = null;
  }
} catch (error) {
  if (restoreLock) {
    let recoveryError = null;
    let failForward = false;
    let dataConsistent = true;
    let pendingJournal = null;
    let recoveredJournal = null;
    try {
      pendingJournal = await swapJournal.read();
      if (pendingJournal) {
        dataConsistent = false;
        preserveRecoveryArtifacts = true;
        unit = pendingJournal.unit;
        activePort = portFromBackendUnit(unit);
        await swapJournal.claim({
          ownerPid: process.pid,
          ownerStartTicks: restoreLock.record.startTicks,
        });
        const requiredBudgetMs = backendStopped
          ? DRAIN_STOPPED_ROLLBACK_RESERVE_MS
          : DRAIN_POST_START_ROLLBACK_RESERVE_MS;
        const rollbackAllowed = await canRollbackWithinDrain(drainLease, requiredBudgetMs);
        let preferredGeneration = rollbackAllowed ? "old" : "new";
        failForward = !rollbackAllowed;
        const consistency = await swapJournal.inspectConsistency();

        if (!generationIsComplete(consistency, preferredGeneration) && !backendStopped) {
          if (preferredGeneration !== "old") {
            throw new Error("后端仍在运行，超过回退期限后拒绝修改恢复目录");
          }
          try {
            const recoveryStopTimeoutMs = drainSystemctlBudget(
              drainLease,
              RECOVERY_SYSTEMCTL_TIMEOUT_MS,
              DRAIN_STOPPED_ROLLBACK_RESERVE_MS,
            );
            backendStopped = true;
            await run("systemctl", ["stop", unit], { timeoutMs: recoveryStopTimeoutMs });
          } catch (stopError) {
            recoveryError ||= stopError;
            if (consistency.newComplete) {
              preferredGeneration = "new";
              failForward = true;
            } else if (!consistency.oldComplete) {
              throw stopError;
            }
          }
        }
        if (!generationIsComplete(consistency, preferredGeneration)) {
          await assertRestoreDataServicesInactive();
        }

        await swapJournal.setDesiredGeneration(preferredGeneration);
        const recovered = await recoverJournalGeneration(preferredGeneration);
        dataConsistent = true;
        await swapJournal.setPhase("starting");
        await run("systemctl", ["start", unit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
        backendStopped = false;
        const readinessTimeoutMs = await recoveryReadinessTimeout();
        await waitForReady(activePort, readinessTimeoutMs);
        backendReady = true;
        await swapJournal.setPhase("verified");
        recoveredJournal = recovered.journal;
      }
    } catch (restoreError) {
      recoveryError ||= restoreError;
      preserveRecoveryArtifacts = Boolean(pendingJournal) || preserveRecoveryArtifacts;
      if (pendingJournal) {
        const consistency = await swapJournal.inspectConsistency().catch(() => null);
        dataConsistent = Boolean(consistency?.newComplete || consistency?.oldComplete);
      } else {
        dataConsistent = !backendStopped;
      }
    }
    if (drainLease) await drainLease.release().catch(() => {});
    drainLease = null;
    const detail = !dataConsistent
      ? "备份恢复未能形成一致数据，已保留恢复副本并保持后端停止"
      : !backendReady && pendingJournal
        ? "备份数据已恢复一致，后端尚未通过就绪检查，正在自动重试"
      : failForward
        ? "备份恢复未能在安全回退期限内确认，已保留新数据并避免迟到回切"
        : recoveryError
          ? "备份恢复失败，自动回退未完整完成"
          : "备份恢复失败，原数据已保留";
    const recoveryDetail = failForward ? "fail-forward after rollback deadline" : "rollback";
    let terminalStatusWritten = false;
    try {
      await update("failed", detail, {
        status: "failed",
        completedAt: Date.now(),
        error: recoveryError ? `${error.message}; ${recoveryDetail}: ${recoveryError.message}` : error.message,
      });
      terminalStatusWritten = true;
    } catch {
      // Keep the journal so systemd can retry until both data and status are durable.
    }
    if (terminalStatusWritten && pendingJournal && dataConsistent && backendReady && recoveredJournal) {
      try {
        await swapJournal.clear(pendingJournal.operationId);
        preserveRecoveryArtifacts = false;
        await cleanupJournalArtifacts(recoveredJournal);
      } catch (cleanupError) {
        recoveryError ||= cleanupError;
      }
    }
    process.exitCode = (!pendingJournal || (
      terminalStatusWritten
      && dataConsistent
      && backendReady
      && !preserveRecoveryArtifacts
    )) ? 2 : 1;
  } else {
    process.exitCode = 2;
  }
  console.error(error.message);
} finally {
  if (restoreLock) {
    if (drainLease) await drainLease.release().catch(() => {});
    await cancelStore.clear(operationId).catch(() => {});
    await Promise.all([
      fs.rm(stagingDirectory, { recursive: true, force: true }),
      ...(preserveRecoveryArtifacts
        ? []
        : prepared.flatMap((entry) => [
          fs.rm(entry.replacement, { recursive: true, force: true }),
          fs.rm(entry.previous, { recursive: true, force: true }),
        ])),
    ]);
    await restoreLock.release().catch(() => {});
  }
}

async function acquireRestoreMaintenanceLock() {
  const acquire = (token) => acquireMaintenanceOperationLock(runtimeDirectory, {
    operationKind: "restore",
    operationId,
    ownerCommand: "scripts/restore-data-backup.mjs",
    reservationToken: token,
    lockPath: restoreLockStore.filePath,
    acquireLock: () => restoreLockStore.acquire({
      operationId,
      backupId: backupId || null,
      workerMarker: process.argv.includes("--worker"),
    }),
  });

  try {
    return await acquire(reservationToken);
  } catch (error) {
    if (
      !reservationToken
      || error.code !== "ERR_MAINTENANCE_RESERVATION"
      || !await hasRestoreRestartEvidence()
    ) throw error;
    return acquire(null);
  }
}

async function hasRestoreRestartEvidence() {
  const pending = await swapJournal.read();
  if (pending?.operationId === operationId && pending.backupId === backupId) return true;
  const observed = await restoreLockStore.inspect();
  if (observed.state === "inactive"
    && observed.record?.operationId === operationId
    && observed.record?.backupId === backupId
    && observed.record?.workerMarker === true) return true;
  return restoreStatusIsTerminal(await readStatus());
}

async function operationAlreadyTerminalWithoutJournal() {
  if (await swapJournal.read()) return false;
  return restoreStatusIsTerminal(await readStatus());
}

function restoreStatusMatchesCurrentOperation(status) {
  return status?.operationId === operationId
    && status?.unit === operationId
    && status?.backupId === backupId;
}

function restoreStatusIsTerminal(status) {
  return restoreStatusMatchesCurrentOperation(status)
    && ["completed", "failed"].includes(status?.status);
}

async function recoverPendingSwap() {
  const pending = await swapJournal.read();
  if (!pending) return null;
  const sameOperation = pending.operationId === operationId && pending.backupId === backupId;
  unit = pending.unit;
  activePort = portFromBackendUnit(unit);
  preserveRecoveryArtifacts = true;
  await update("recovering", sameOperation
    ? "检测到上次恢复被中断，正在自动续接"
    : "正在先完成上一个中断的数据恢复");
  await swapJournal.claim({
    ownerPid: process.pid,
    ownerStartTicks: restoreLock.record.startTicks,
  });

  const consistency = await swapJournal.inspectConsistency();
  const preferredGeneration = pending.desiredGeneration;
  if (!generationIsComplete(consistency, preferredGeneration)) {
    if (await systemdUnitIsActive(unit)) {
      await update("waiting", "等待当前对话空闲后修复中断的数据恢复");
      drainLease = await waitForIdleDrain({
        drainStore,
        version,
        fetchReadiness: () => fetchTaskReadiness(activePort),
        onWaiting: () => update("waiting", "仍在等待安全恢复窗口，对话服务保持开放"),
        timeoutMs: restoreDrainTimeout(),
      });
      await update("draining", "已确认任务空闲，正在修复中断的数据恢复");
      await drainLease.assertActive();
      await swapJournal.setPhase("stopping");
      const stopTimeoutMs = drainSystemctlBudget(
        drainLease,
        DRAIN_STOP_TIMEOUT_MS,
        DRAIN_INITIAL_STOP_RESERVE_MS,
      );
      backendStopped = true;
      await run("systemctl", ["stop", unit], { timeoutMs: stopTimeoutMs });
      await drainLease.assertActive();
      await assertRestoreDataServicesInactive();
    } else {
      backendStopped = true;
      await assertRestoreDataServicesInactive();
    }
  }

  const recovered = await recoverJournalGeneration(preferredGeneration);
  await swapJournal.setPhase("starting");
  await run("systemctl", ["start", unit], {
    timeoutMs: drainLease
      ? drainSystemctlBudget(drainLease, DRAIN_START_TIMEOUT_MS, DRAIN_RELEASE_RESERVE_MS)
      : RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  backendStopped = false;
  await waitForReady(activePort, await recoveryReadinessTimeout());
  backendReady = true;
  await swapJournal.setPhase("verified");
  if (drainLease) await drainLease.release().catch(() => {});
  drainLease = null;
  return {
    sameOperation,
    generation: recovered.generation,
    operationId: pending.operationId,
    journal: recovered.journal,
  };
}

async function finalizeRecoveredSwap(recovered) {
  await swapJournal.clear(recovered.operationId);
  preserveRecoveryArtifacts = false;
  await cleanupJournalArtifacts(recovered.journal);
}

async function recoverJournalGeneration(preferredGeneration) {
  const current = await swapJournal.inspectConsistency();
  if (!generationIsComplete(current, preferredGeneration)) {
    await assertRestoreDataServicesInactive();
  }
  return swapJournal.recoverConsistentGeneration({ preferredGeneration });
}

function generationIsComplete(consistency, generation) {
  return generation === "new" ? consistency.newComplete : consistency.oldComplete;
}

function portFromBackendUnit(value) {
  const match = /^wfl-codex-desktop-backend@(4318|4319)\.service$/.exec(String(value || ""));
  if (!match) throw new Error("恢复日志中的后端服务无效");
  return Number(match[1]);
}

async function cleanupJournalArtifacts(journal) {
  if (!journal?.entries) return;
  await Promise.all(journal.entries.flatMap((entry) => [
    fs.rm(entry.replacement, { recursive: true, force: true }),
    fs.rm(entry.previous, { recursive: true, force: true }),
  ]));
}

async function recoveryReadinessTimeout() {
  if (!drainLease) return restoreRecoveryReadyTimeout();
  try {
    return remainingDrainMs(drainLease, DRAIN_RELEASE_RESERVE_MS);
  } catch {
    await drainLease.release().catch(() => {});
    drainLease = null;
    return restoreRecoveryReadyTimeout();
  }
}

function restoreRecoveryReadyTimeout() {
  const timeoutMs = Number(process.env.CODEX_DESKTOP_RESTORE_RECOVERY_READY_TIMEOUT_MS || 90_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > 90_000) {
    throw new Error("备份恢复就绪检查时间配置无效");
  }
  return timeoutMs;
}

function validateRestoreSources(sources) {
  if (!Array.isArray(sources) || !sources.length) throw new Error("备份恢复范围为空");
  return sources.map((source) => {
    const target = path.resolve(String(source?.path || ""));
    if (!isAllowedRestoreTarget(target)) throw new Error(`备份包含当前服务器不允许恢复的目录：${target}`);
    return { path: target, kind: source.kind };
  });
}

async function fetchTaskReadiness(port) {
  const response = await fetch(`http://127.0.0.1:${port}/internal/task-ready`, {
    headers: { Host: `127.0.0.1:${port}` }, signal: AbortSignal.timeout(2500), cache: "no-store",
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    const error = new Error("活动后端不支持安全任务排空");
    error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
    throw error;
  }
  const data = await response.json();
  if (typeof data?.taskIdle !== "boolean") {
    const error = new Error("活动后端不支持安全任务排空");
    error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
    throw error;
  }
  return data;
}

function restoreDrainTimeout() {
  const timeoutMs = Number(process.env.CODEX_DESKTOP_RESTORE_DRAIN_TIMEOUT_MS || 10 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 20 * 60 * 1000) {
    throw new Error("备份恢复等待时间配置无效");
  }
  return timeoutMs;
}

async function assertNotCancelled() {
  if (!await cancelStore.isCancellationRequested(operationId)) return;
  const error = new Error("Maintenance operation was cancelled by the owner");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  throw error;
}

async function commitRestoreDecision() {
  const decision = await cancelStore.commit(operationId);
  if (decision.accepted && decision.decision === "commit") return;
  const error = new Error("Maintenance operation was cancelled before data restore");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  throw error;
}

async function canRollbackWithinDrain(lease, requiredBudgetMs) {
  if (!lease || lease.deadlineAt - Date.now() <= requiredBudgetMs) return false;
  try {
    await lease.assertActive();
  } catch {
    return false;
  }
  return lease.deadlineAt - Date.now() > requiredBudgetMs;
}

async function waitForReady(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const requestTimeoutMs = Math.max(1, Math.min(2_500, deadline - Date.now()));
      const response = await fetch(`http://127.0.0.1:${port}/internal/ready`, {
        headers: { Host: `127.0.0.1:${port}` }, signal: AbortSignal.timeout(requestTimeoutMs), cache: "no-store",
      });
      const data = await response.json();
      if (response.ok && data.ok === true && data.version === version) return;
    } catch {
      // Retry until systemd has restarted the backend.
    }
    await delay(Math.max(1, Math.min(1_000, deadline - Date.now())));
  }
  throw new Error("恢复后的后端未通过启动检查");
}

async function machineIdHash() {
  const value = (await fs.readFile("/etc/machine-id", "utf8")).trim();
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new Error("服务器 machine-id 无效");
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function update(phase, detail, patch = {}) {
  const current = await readStatus();
  await writeStatus({
    status: patch.status || "running",
    phase,
    backupId,
    operationId,
    unit: operationId,
    detail,
    startedAt: current.startedAt || patch.startedAt || Date.now(),
    updatedAt: Date.now(),
    completedAt: patch.completedAt ?? null,
    error: patch.error ?? null,
  });
}

async function readStatus() {
  try { return JSON.parse(await fs.readFile(statusPath, "utf8")); } catch { return {}; }
}

async function writeStatus(value) {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temporary, "w", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, statusPath);
    await syncDirectory(runtimeDirectory);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function run(command, args, { timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout?.unref?.();
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

function drainSystemctlBudget(lease, timeoutMs, reserveMs) {
  const availableMs = remainingDrainMs(lease, reserveMs);
  if (availableMs < timeoutMs) throw restoreDrainDeadlineError();
  return timeoutMs;
}

function remainingDrainMs(lease, reserveMs = 0) {
  const remainingMs = lease.deadlineAt - Date.now() - reserveMs;
  if (remainingMs <= 0) throw restoreDrainDeadlineError();
  return remainingMs;
}

function restoreDrainDeadlineError() {
  const error = new Error("备份恢复未能在短时切换期限内完成");
  error.code = "ERR_MAINTENANCE_DRAIN_DEADLINE";
  return error;
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(value) { try { await fs.access(value); return true; } catch { return false; } }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
