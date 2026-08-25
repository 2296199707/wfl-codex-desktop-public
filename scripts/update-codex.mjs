import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCodexInstallation } from "../lib/codex-prerequisite.mjs";
import {
  assertCodexActivationAllowed,
  inspectCodexProtocolCompatibility,
} from "../lib/codex-compatibility.mjs";
import {
  commitCodexInstallRecovery,
  commitCodexInstallRollback,
  completeCodexInstallRecovery,
  holdCodexInstallRecoveryForDecision,
  prepareCodexInstallRecovery,
  readCodexInstallRecovery,
  restoreCodexInstallRecovery,
  verifyCodexInstallRecoverySelection,
} from "../lib/codex-install-recovery.mjs";
import { installCodexUsernsProfile } from "../lib/codex-userns-profile.mjs";
import { inspectPackageSource, PACKAGE_MANIFEST_NAME } from "../lib/package-source.mjs";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { startDeploymentWatchdog } from "../lib/deployment-watchdog.mjs";
import { waitForIdleDrain } from "../lib/maintenance-drain.mjs";
import {
  acquireMaintenanceOperationLock,
  cancelMaintenanceReservation,
  operationLockState,
  reserveMaintenanceOperation,
  statusTimestampIsFresh,
} from "../lib/operation-lock.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";
import {
  ACTIVE_CODEX_UPDATE_PHASES,
  CodexUpdateStatusStore,
} from "../lib/codex-update-status.mjs";
import { deploymentRecoveryStatusIsTerminal } from "../lib/deployment-recovery-status.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDir = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"),
);
const stateDir = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(projectDir, ".codex-desktop"),
);
const appVersion = process.env.CODEX_DESKTOP_APP_VERSION
  || JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8")).version;
const codexCommand = process.env.CODEX_DESKTOP_CODEX_BIN || "codex";
// Forced activation is the owner's default. Set CODEX_DESKTOP_FORCE_UPDATE=0
// for a one-off drain that waits for active tasks to finish.
const forceUpdate = process.env.CODEX_DESKTOP_FORCE_UPDATE !== "0";
const gatewayPort = parsePort(process.env.CODEX_DESKTOP_GATEWAY_PORT || "4317", "gateway port");
const backendPorts = parsePorts(process.env.CODEX_DESKTOP_UPSTREAM_PORTS || "4318,4319");
const lockPath = path.join(runtimeDir, "codex-update.lock");
const statusStore = new CodexUpdateStatusStore(stateDir);
const drainStore = new ReleaseDrainStore(runtimeDir);
const cancelStore = new DeploymentCancelStore(runtimeDir);
const codexRecoveryUnit = "wfl-codex-desktop-codex-recovery.service";
const deploymentRecoveryUnit = "wfl-codex-desktop-deployment-recovery.service";
const KNOWN_LEGACY_DRAIN_VERSIONS = new Set(["0.37.0", "0.37.1"]);
const MAINTENANCE_LAUNCH_TIMEOUT_MS = boundedLauncherDuration(
  process.env.CODEX_DESKTOP_LAUNCH_TIMEOUT_MS,
  12_000,
  50,
);
const CHILD_TERMINATION_GRACE_MS = boundedLauncherDuration(
  process.env.CODEX_DESKTOP_LAUNCH_KILL_GRACE_MS,
  1_000,
  10,
);
const SYSTEMCTL_PROBE_TIMEOUT_MS = 5_000;
const codexUpdateLockOptions = {
  ownerCommand: "scripts/update-codex.mjs",
  acceptedCommands: ["scripts/update-codex.mjs"],
  requiredArguments: ["--worker"],
  conflictMessage: "Another Codex update is already running",
};

validateVersion(appVersion);

try {
  if (process.argv.includes("--status")) console.log(JSON.stringify(await statusStore.read(), null, 2));
  else if (process.argv.includes("--worker")) await runWorker();
  else if (process.argv.includes("--keep-pending")) await launchDecisionWorker("keep");
  else if (process.argv.includes("--rollback-pending")) await launchDecisionWorker("rollback");
  else await launchWorker();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function launchWorker() {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const unit = `wfl-codex-update-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const reservation = await reserveMaintenanceOperation(runtimeDir, {
    operationKind: "codex-update",
    operationId: unit,
    ownerCommand: "scripts/update-codex.mjs",
  });
  let launched = false;
  try {
    const current = await statusStore.read();
    if (ACTIVE_CODEX_UPDATE_PHASES.has(current.phase) && await updateIsStillRunning(current)) {
      throw new Error(`Codex update is already ${current.phase}`);
    }
    if (ACTIVE_CODEX_UPDATE_PHASES.has(current.phase)) {
      await statusStore.write({
        status: "failed",
        phase: "failed",
        detail: "上次 Codex 升级任务已异常退出，可以重新尝试",
        completedAt: Date.now(),
        error: "Stale Codex update state was cleared",
      });
    }

    await cancelStore.clear(unit);
    await statusStore.write({
      status: "running",
      phase: "queued",
      beforeVersion: null,
      afterVersion: null,
      detail: "等待官方 Codex 升级任务启动",
      unit,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    });
    await run("systemctl", ["enable", codexRecoveryUnit, deploymentRecoveryUnit], {
      timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS,
    });
    await run("systemd-run", [
      `--unit=${unit}`,
      "--description=WFL Codex official CLI update",
      `--property=WorkingDirectory=${projectDir}`,
      "--property=RuntimeMaxSec=30min",
      `--property=OnFailure=${deploymentRecoveryUnit}`,
      `--setenv=HOME=${process.env.HOME || "/root"}`,
      `--setenv=PATH=${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      `--setenv=CODEX_DESKTOP_STATE_DIR=${stateDir}`,
      `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDir}`,
      `--setenv=CODEX_DESKTOP_OPERATION_ID=${unit}`,
      `--setenv=CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN=${reservation.record.token}`,
      `--setenv=CODEX_DESKTOP_APP_VERSION=${appVersion}`,
      `--setenv=CODEX_DESKTOP_CODEX_BIN=${codexCommand}`,
      `--setenv=CODEX_DESKTOP_GATEWAY_PORT=${gatewayPort}`,
      `--setenv=CODEX_DESKTOP_UPSTREAM_PORTS=${backendPorts.join(",")}`,
      ...(process.env.CODEX_DESKTOP_CODEX_DRAIN_TIMEOUT_MS
        ? [`--setenv=CODEX_DESKTOP_CODEX_DRAIN_TIMEOUT_MS=${process.env.CODEX_DESKTOP_CODEX_DRAIN_TIMEOUT_MS}`]
        : []),
      `--setenv=CODEX_DESKTOP_FORCE_UPDATE=${forceUpdate ? "1" : "0"}`,
      ...(process.env.CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED === "1"
        ? ["--setenv=CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1"]
        : []),
      "--collect",
      "--no-block",
      process.execPath,
      path.join(projectDir, "scripts", "update-codex.mjs"),
      "--worker",
    ], { timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS });
    launched = true;
    console.log(JSON.stringify({ ok: true, unit, status: "queued" }));
  } catch (error) {
    const current = await statusStore.read().catch(() => null);
    if (current?.unit === unit) await fail("无法启动后台 Codex 升级任务", error, { unit });
    throw error;
  } finally {
    if (!launched) await reservation.cancel().catch(() => {});
  }
}

async function launchDecisionWorker(decision) {
  const pending = await readCodexInstallRecovery(runtimeDir);
  if (pending?.state !== "decision-pending") {
    throw new Error("No Codex update is waiting for an owner decision");
  }
  const unit = `wfl-codex-update-decision-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const reservation = await reserveMaintenanceOperation(runtimeDir, {
    operationKind: "codex-update",
    operationId: unit,
    ownerCommand: "scripts/update-codex.mjs",
  });
  let launched = false;
  try {
    await statusStore.write({
      status: "running",
      phase: "queued",
      beforeVersion: decision === "rollback"
        ? `codex-cli ${pending.afterVersion}`
        : `codex-cli ${pending.beforeVersion}`,
      afterVersion: decision === "rollback"
        ? `codex-cli ${pending.beforeVersion}`
        : `codex-cli ${pending.afterVersion}`,
      detail: decision === "keep" ? "正在确认保留新版 Codex" : "正在准备恢复上一版 Codex",
      unit,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    });
    await run("systemctl", ["enable", codexRecoveryUnit, deploymentRecoveryUnit], {
      timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS,
    });
    await run("systemd-run", [
      `--unit=${unit}`,
      "--description=WFL Codex owner update decision",
      `--property=WorkingDirectory=${projectDir}`,
      "--property=RuntimeMaxSec=30min",
      `--property=OnFailure=${deploymentRecoveryUnit}`,
      `--setenv=HOME=${process.env.HOME || "/root"}`,
      `--setenv=PATH=${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      `--setenv=CODEX_DESKTOP_STATE_DIR=${stateDir}`,
      `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDir}`,
      `--setenv=CODEX_DESKTOP_OPERATION_ID=${unit}`,
      `--setenv=CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN=${reservation.record.token}`,
      `--setenv=CODEX_DESKTOP_APP_VERSION=${appVersion}`,
      `--setenv=CODEX_DESKTOP_CODEX_BIN=${codexCommand}`,
      `--setenv=CODEX_DESKTOP_GATEWAY_PORT=${gatewayPort}`,
      `--setenv=CODEX_DESKTOP_UPSTREAM_PORTS=${backendPorts.join(",")}`,
      "--collect",
      "--no-block",
      process.execPath,
      path.join(projectDir, "scripts", "update-codex.mjs"),
      "--worker",
      `--decision=${decision}`,
    ], { timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS });
    launched = true;
    console.log(JSON.stringify({ ok: true, unit, status: "queued" }));
  } finally {
    if (!launched) await reservation.cancel().catch(() => {});
  }
}

async function runWorker() {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const startedAt = Date.now();
  const operationId = process.env.CODEX_DESKTOP_OPERATION_ID || `codex-update-${process.pid}-${startedAt}`;
  process.env.CODEX_DESKTOP_OPERATION_ID = operationId;
  const reservationToken = process.env.CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN || null;
  let lock = null;
  try {
    lock = await acquireMaintenanceOperationLock(runtimeDir, {
      operationKind: "codex-update",
      operationId,
      ownerCommand: "scripts/update-codex.mjs",
      reservationToken,
      lockPath,
      lockOptions: codexUpdateLockOptions,
    });
  } catch (error) {
    if (reservationToken) {
      const queued = await statusStore.read().catch(() => null);
      if (queued?.unit === operationId) {
        await fail("Codex 升级任务未能取得独占执行窗口", error, {
          unit: operationId,
          startedAt,
        });
      }
      await cancelMaintenanceReservation(runtimeDir, {
        operationId,
        reservationToken,
        ownerCommand: "scripts/update-codex.mjs",
      }).catch(() => {});
    }
    throw error;
  }
  const pendingDecision = process.argv
    .find((argument) => argument.startsWith("--decision="))
    ?.slice("--decision=".length) || null;
  if (pendingDecision) {
    try {
      await runPendingDecision(pendingDecision, { operationId, startedAt });
    } finally {
      await cancelStore.clear(operationId).catch(() => {});
      await lock?.release();
    }
    return;
  }
  let beforeVersion = null;
  let drainLease = null;
  let installRecoveryPrepared = false;
  let installRecoveryJournal = null;
  let candidateStaged = false;
  let deploymentWatchdog = null;
  let compatibilityDecisionRequired = false;
  try {
    await assertNotCancelled(operationId);
    await update("checking", "检查应用版本和官方 Codex 安装", { startedAt });
    await verifyUpdateSource();
    await update("checking", "预检当前主站 release、网关和蓝绿恢复资产", { startedAt });
    await run(process.execPath, [
      path.join(projectDir, "scripts", "deploy.mjs"),
      "--preflight", "--version", appVersion,
    ]);
    const before = await inspectCodexInstallation({ command: codexCommand });
    beforeVersion = before.version;
    await update("checking", "创建官方 Codex CLI 离线恢复副本", { beforeVersion });
    installRecoveryJournal = await prepareCodexInstallRecovery({
      runtimeDirectory: runtimeDir,
      operationId,
      command: codexCommand,
      versionOutput: before.version,
      appVersion,
    });
    installRecoveryPrepared = true;

    await assertNotCancelled(operationId);
    await update("updating", "正在更新官方 Codex，当前对话服务保持开放", { beforeVersion });
    await run(codexCommand, ["update"]);

    await update("verifying", "验证更新后的 Codex CLI 与 app-server", { beforeVersion });
    const after = await inspectCodexInstallation({
      command: codexCommand,
      requireRuntimeBundle: true,
    });
    await verifyCodexInstallRecoverySelection(installRecoveryJournal, after.version);
    await installCodexUsernsProfile({ command: codexCommand });
    await update("verifying", "检查新版 Codex 协议是否已经完成安全审查", {
      beforeVersion,
      afterVersion: after.version,
    });
    const compatibility = await inspectCodexProtocolCompatibility({
      command: codexCommand,
      installedVersion: after.version,
      projectDirectory: projectDir,
    });
    assertCodexActivationAllowed(compatibility);
    compatibilityDecisionRequired = before.version !== after.version
      && compatibility.decisionRequired === true;
    if (before.version === after.version) {
      if (!await commitCodexInstallRecovery(runtimeDir, after.version)) {
        throw new Error("Codex installation recovery journal disappeared before update completion");
      }
      await complete({
        beforeVersion,
        afterVersion: after.version,
        detail: `${after.version} 已是当前可用版本`,
        startedAt,
      });
      try {
        await completeCodexInstallRecovery(runtimeDir);
        installRecoveryPrepared = false;
      } catch (cleanupError) {
        console.error(`Codex update cleanup remains recoverable: ${cleanupError.message}`);
      }
      return;
    }

    await assertNotCancelled(operationId);
    await update("deploying", "在备用后端启动并验证新版 Codex，当前对话继续可用", {
      beforeVersion,
      afterVersion: after.version,
    });
    deploymentWatchdog = await startDeploymentWatchdog({
      sourceDirectory: projectDir,
      runtimeDirectory: runtimeDir,
      operationId,
    });
    await deploymentWatchdog.assertActive();
    await run(process.execPath, [
      path.join(projectDir, "scripts", "deploy.mjs"),
      "--stage", "--operation-id", operationId, "--version", appVersion,
    ], {
      env: { ...process.env, CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token },
    });
    candidateStaged = true;
    await deploymentWatchdog.assertActive();
    if (forceUpdate) {
      await update("forcing", "不等待运行中的对话，立即切换 Codex 后端；中断任务将在新版本重连", {
        beforeVersion,
        afterVersion: after.version,
      });
      await assertNotCancelled(operationId);
      await deploymentWatchdog.assertActive();
      await run(process.execPath, [
        path.join(projectDir, "scripts", "deploy.mjs"),
        "--activate-staged", "--defer-finalize",
        "--operation-id", operationId, "--version", appVersion,
      ], {
        env: {
          ...process.env,
          CODEX_DESKTOP_FORCE_ACTIVATION: "1",
          CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token,
        },
        timeoutMs: activationForceTimeout(),
      });
    } else {
      const drainPort = await readActivePortForDrain();
      const drainProtocol = await inspectTaskDrainProtocol(drainPort);
      await update("waiting", "等待对话自然结束，期间仍可继续发送消息", {
        beforeVersion,
        afterVersion: after.version,
      });
      drainLease = await waitForIdleDrain({
        drainStore,
        version: appVersion,
        fetchReadiness: () => fetchTaskReadiness(drainPort, drainProtocol),
        allowLegacyProtocol: drainProtocol === "legacy",
        isCancellationRequested: () => cancelStore.isCancellationRequested(operationId),
        onWaiting: () => update("waiting", "仍在等待安全切换窗口，对话服务保持开放", {
          beforeVersion,
          afterVersion: after.version,
        }),
        timeoutMs: codexDrainTimeout(),
        maxDrainMs: 60_000,
      });
      await update("draining", "已确认任务空闲，正在短时切换新版 Codex 后端", {
        beforeVersion,
        afterVersion: after.version,
      });
      await assertNotCancelled(operationId);
      await drainLease.assertActive();
      await deploymentWatchdog.assertActive();
      await run(process.execPath, [
        path.join(projectDir, "scripts", "deploy.mjs"),
        "--activate-staged", "--defer-finalize",
        "--operation-id", operationId, "--version", appVersion,
      ], {
        env: {
          ...process.env,
          CODEX_DESKTOP_DRAIN_TOKEN: drainLease.token,
          CODEX_DESKTOP_DRAIN_TTL_MS: "20000",
          CODEX_DESKTOP_DRAIN_DEADLINE_AT: String(drainLease.deadlineAt),
          CODEX_DESKTOP_LEGACY_EXCLUSIVE_ACTIVATION: drainLease.legacyProtocol ? "1" : "0",
          CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token,
        },
        timeoutMs: remainingDrainMs(drainLease),
      });
    }
    await update("verifying", "新版 Codex 后端已验证，正在提交可恢复安装状态", {
      beforeVersion,
      afterVersion: after.version,
    });
    await deploymentWatchdog.assertActive();
    if (drainLease) await drainLease.assertActive();
    const activePort = await verifyDeployment(after);
    const recoveryOutcome = compatibilityDecisionRequired
      ? await holdCodexInstallRecoveryForDecision(runtimeDir, after.version)
      : await commitCodexInstallRecovery(runtimeDir, after.version);
    if (!recoveryOutcome) {
      throw new Error("Codex installation recovery journal disappeared before activation finalization");
    }
    if (drainLease) await drainLease.assertActive();
    await deploymentWatchdog.assertActive();
    await run(process.execPath, [
      path.join(projectDir, "scripts", "deploy.mjs"),
      "--finalize-staged", "--operation-id", operationId, "--version", appVersion,
    ], {
      env: {
        ...process.env,
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token,
      },
      timeoutMs: drainLease ? remainingDrainMs(drainLease) : activationForceTimeout(),
    });
    candidateStaged = false;
    const completedDrain = drainLease;
    drainLease = null;
    if (completedDrain) await completedDrain.release().catch(() => {});

    await complete({
      beforeVersion,
      afterVersion: after.version,
      detail: compatibilityDecisionRequired
        ? `${before.version} -> ${after.version}，活动后端 ${activePort}；请决定保留或恢复上一版`
        : `${before.version} -> ${after.version}，活动后端 ${activePort}`,
      startedAt,
    });
    if (compatibilityDecisionRequired) {
      installRecoveryPrepared = false;
    } else {
      try {
        await completeCodexInstallRecovery(runtimeDir);
        installRecoveryPrepared = false;
      } catch (cleanupError) {
        console.error(`Codex update cleanup remains recoverable: ${cleanupError.message}`);
      }
    }
  } catch (error) {
    const cancelled = error.code === "ERR_MAINTENANCE_CANCELLED";
    let recoveryError = null;
    let topologyRecoveryPending = false;
    if (installRecoveryPrepared) {
      try {
        await update("verifying", "升级未完成，正在离线恢复原 Codex CLI", { beforeVersion });
        const restored = await restoreCodexInstallRecovery({ runtimeDirectory: runtimeDir });
        if (restored.journal?.state !== "update-committed") {
          if (!await commitCodexInstallRollback(runtimeDir)) {
            throw new Error("Codex rollback recovery journal disappeared before cleanup");
          }
        }
      } catch (caught) {
        recoveryError = caught;
      }
    }
    if (candidateStaged) {
      const cleanupEnvironment = {
        ...process.env,
        ...(deploymentWatchdog ? { CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token } : {}),
      };
      try {
        await run(process.execPath, [
          path.join(projectDir, "scripts", "deploy.mjs"),
          "--discard-staged", "--operation-id", operationId, "--version", appVersion,
        ], { env: cleanupEnvironment });
        candidateStaged = false;
      } catch (discardError) {
        if (deploymentWatchdog) {
          // The watchdog is the sole topology recovery owner once activation
          // has committed. The update worker must exit and release its lock so
          // the watchdog can prove owner exit before taking over the manifest.
          topologyRecoveryPending = true;
        } else {
          try {
            await run(process.execPath, [
              path.join(projectDir, "scripts", "deploy.mjs"),
              "--recover-staged", "--operation-id", operationId, "--version", appVersion,
            ], { env: cleanupEnvironment });
            candidateStaged = false;
          } catch (topologyError) {
            recoveryError = combineErrors(recoveryError || discardError, topologyError);
          }
        }
      }
    }
    if (drainLease) {
      await drainLease.release().catch(() => {});
      drainLease = null;
    }
    if (recoveryError) {
      error = new Error(`${error.message}; offline Codex recovery is pending: ${recoveryError.message}`);
    }
    const recoveryStatus = await statusStore.read().catch(() => null);
    if (!deploymentRecoveryStatusIsTerminal(recoveryStatus, operationId, startedAt)) {
      await fail(
        cancelled
          ? "Codex 升级已由所有者取消，当前活动后端保持运行"
          : topologyRecoveryPending
            ? "Codex 升级未完成，恢复看门程序将在当前任务退出后接管后端恢复"
            : "Codex 升级失败，当前活动后端保持运行",
        error,
        { beforeVersion, startedAt },
      );
    }
    if (installRecoveryPrepared && !recoveryError && !candidateStaged) {
      try {
        await completeCodexInstallRecovery(runtimeDir);
        installRecoveryPrepared = false;
      } catch (cleanupError) {
        console.error(`Codex rollback cleanup remains recoverable: ${cleanupError.message}`);
      }
    }
    throw error;
  } finally {
    if (drainLease) await drainLease.release().catch(() => {});
    await cancelStore.clear(operationId).catch(() => {});
    await lock?.release();
  }
}

async function runPendingDecision(decision, { operationId, startedAt }) {
  if (!["keep", "rollback"].includes(decision)) throw new Error("Invalid Codex update decision");
  const pending = await readCodexInstallRecovery(runtimeDir);
  if (pending?.state !== "decision-pending") {
    throw new Error("No Codex update is waiting for an owner decision");
  }
  const previousVersion = `codex-cli ${pending.beforeVersion}`;
  const selectedVersion = `codex-cli ${pending.afterVersion}`;
  let candidateStaged = false;
  let deploymentWatchdog = null;
  let topologyRecoveryPending = false;
  try {
    await update("verifying", "确认当前 Codex 安装与待决定版本", {
      beforeVersion: previousVersion,
      afterVersion: selectedVersion,
      startedAt,
    });
    const selected = await inspectCodexInstallation({
      command: codexCommand,
      requireRuntimeBundle: true,
    });
    await verifyCodexInstallRecoverySelection(pending, selected.version);
    if (selected.version !== selectedVersion || selected.appServerReady !== true) {
      throw new Error("Selected Codex installation no longer matches the pending owner decision");
    }

    if (decision === "keep") {
      if (!await commitCodexInstallRecovery(runtimeDir, selected.version)) {
        throw new Error("Codex installation recovery journal disappeared before keep confirmation");
      }
      await complete({
        beforeVersion: previousVersion,
        afterVersion: selected.version,
        detail: `${selected.version} 已由所有者确认保留`,
        startedAt,
      });
      try {
        await completeCodexInstallRecovery(runtimeDir);
      } catch (cleanupError) {
        console.error(`Codex keep cleanup remains recoverable: ${cleanupError.message}`);
      }
      return;
    }

    await update("updating", "正在离线恢复上一版 Codex CLI", {
      beforeVersion: selectedVersion,
      afterVersion: previousVersion,
      startedAt,
    });
    const restoredResult = await restoreCodexInstallRecovery({ runtimeDirectory: runtimeDir });
    if (!restoredResult.journal) throw new Error("Codex rollback recovery journal disappeared");
    const restored = await inspectCodexInstallation({
      command: codexCommand,
      requireRuntimeBundle: true,
    });
    await verifyCodexInstallRecoverySelection(restoredResult.journal, restored.version);
    if (restored.version !== previousVersion || restored.appServerReady !== true) {
      throw new Error("Restored Codex CLI did not pass verification");
    }
    await installCodexUsernsProfile({ command: codexCommand });

    await update("deploying", "在备用后端验证上一版 Codex，当前对话继续可用", {
      beforeVersion: selectedVersion,
      afterVersion: previousVersion,
      startedAt,
    });
    deploymentWatchdog = await startDeploymentWatchdog({
      sourceDirectory: projectDir,
      runtimeDirectory: runtimeDir,
      operationId,
    });
    await deploymentWatchdog.assertActive();
    await run(process.execPath, [
      path.join(projectDir, "scripts", "deploy.mjs"),
      "--stage", "--operation-id", operationId, "--version", appVersion,
    ], {
      env: { ...process.env, CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token },
    });
    candidateStaged = true;
    await deploymentWatchdog.assertActive();
    await update("forcing", "正在切换到上一版 Codex 后端；中断任务将在恢复后重连", {
      beforeVersion: selectedVersion,
      afterVersion: previousVersion,
      startedAt,
    });
    await run(process.execPath, [
      path.join(projectDir, "scripts", "deploy.mjs"),
      "--activate-staged", "--defer-finalize",
      "--operation-id", operationId, "--version", appVersion,
    ], {
      env: {
        ...process.env,
        CODEX_DESKTOP_FORCE_ACTIVATION: "1",
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token,
      },
      timeoutMs: activationForceTimeout(),
    });
    await deploymentWatchdog.assertActive();
    const activePort = await verifyDeployment(restored);
    if (!await commitCodexInstallRollback(runtimeDir)) {
      throw new Error("Codex rollback recovery journal disappeared before finalization");
    }
    await run(process.execPath, [
      path.join(projectDir, "scripts", "deploy.mjs"),
      "--finalize-staged", "--operation-id", operationId, "--version", appVersion,
    ], {
      env: { ...process.env, CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token },
      timeoutMs: activationForceTimeout(),
    });
    candidateStaged = false;
    await complete({
      beforeVersion: selectedVersion,
      afterVersion: restored.version,
      detail: `${selectedVersion} -> ${restored.version}，已恢复上一版，活动后端 ${activePort}`,
      startedAt,
    });
    try {
      await completeCodexInstallRecovery(runtimeDir);
    } catch (cleanupError) {
      console.error(`Codex rollback cleanup remains recoverable: ${cleanupError.message}`);
    }
  } catch (error) {
    if (candidateStaged) {
      const environment = {
        ...process.env,
        ...(deploymentWatchdog ? { CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token } : {}),
      };
      if (deploymentWatchdog) {
        topologyRecoveryPending = true;
      } else {
        await run(process.execPath, [
          path.join(projectDir, "scripts", "deploy.mjs"),
          "--recover-staged", "--operation-id", operationId, "--version", appVersion,
        ], { env: environment }).catch(() => {});
      }
    }
    const recoveryStatus = await statusStore.read().catch(() => null);
    if (!deploymentRecoveryStatusIsTerminal(recoveryStatus, operationId, startedAt)) {
      await fail(
        topologyRecoveryPending
          ? "恢复上一版 Codex 未完成，恢复看门程序将在当前任务退出后接管后端恢复"
          : decision === "keep" ? "无法确认保留新版 Codex" : "恢复上一版 Codex 未完成",
        error,
        { beforeVersion: selectedVersion, afterVersion: previousVersion, startedAt },
      );
    }
    throw error;
  }
}

async function readActivePortForDrain() {
  let activePort;
  try {
    activePort = Number((await fs.readFile(path.join(runtimeDir, "active-port"), "utf8")).trim());
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Cannot verify active tasks because the active backend record is missing");
    }
    throw error;
  }
  if (!backendPorts.includes(activePort)) throw new Error("Invalid active backend before Codex update");

  return activePort;
}

function codexDrainTimeout() {
  const timeoutMs = Number(process.env.CODEX_DESKTOP_CODEX_DRAIN_TIMEOUT_MS || 10 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 20 * 60 * 1000) {
    throw new Error("Invalid Codex task drain timeout");
  }
  return timeoutMs;
}

async function inspectTaskDrainProtocol(activePort) {
  const readiness = await fetchTaskReadinessResponse(activePort);
  if (typeof readiness.maintenanceIdle === "boolean") return "current";
  const active = await fetchJson(`http://127.0.0.1:${activePort}/internal/codex-ready`, 3_000);
  if (!KNOWN_LEGACY_DRAIN_VERSIONS.has(active.version)) {
    const error = new Error("Active backend does not support a recognized safe drain protocol");
    error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
    throw error;
  }
  if (process.env.CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED === "1") return "legacy";
  const confirmationError = new Error(
    "Legacy backend activation requires explicit CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1 confirmation",
  );
  confirmationError.code = "ERR_LEGACY_DRAIN_CONFIRMATION_REQUIRED";
  throw confirmationError;
}

async function fetchTaskReadiness(activePort, protocol = "current") {
  const data = await fetchTaskReadinessResponse(activePort);
  if (protocol === "current" && typeof data.maintenanceIdle === "boolean") return data;
  if (protocol === "legacy" && typeof data.maintenanceIdle !== "boolean") {
    return { ...data, legacyProtocol: true };
  }
  const error = new Error("Active backend task drain protocol changed during Codex update");
  error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
  throw error;
}

async function fetchTaskReadinessResponse(activePort) {
  const response = await fetch(`http://127.0.0.1:${activePort}/internal/task-ready`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    const error = new Error("Active backend does not support safe task draining");
    error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
    throw error;
  }
  const data = await response.json();
  if (typeof data?.taskIdle === "boolean" && typeof data?.draining === "boolean") return data;
  const error = new Error("Active backend does not support safe task draining");
  error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
  throw error;
}

async function assertNotCancelled(operationId) {
  if (!await cancelStore.isCancellationRequested(operationId)) return;
  const error = new Error("Maintenance operation was cancelled by the owner");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  throw error;
}

async function verifyUpdateSource() {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
  if (packageJson.version !== appVersion) throw new Error("Running application and update source versions do not match");
  if (await pathExists(path.join(projectDir, PACKAGE_MANIFEST_NAME))) {
    const source = await inspectPackageSource(projectDir);
    if (source.version !== appVersion) {
      throw new Error("Codex update package source does not match the running application");
    }
    const activePort = Number((await fs.readFile(path.join(runtimeDir, "active-port"), "utf8")).trim());
    if (!backendPorts.includes(activePort)) throw new Error("Invalid active backend before Codex update");
    const [activeRelease, updateSource] = await Promise.all([
      fs.realpath(path.join(runtimeDir, "slots", String(activePort))),
      fs.realpath(projectDir),
    ]);
    if (activeRelease !== updateSource) {
      throw new Error("Codex update package source is not the active verified release");
    }
    return;
  }
  const status = (await capture("git", ["status", "--porcelain", "--untracked-files=all"])).trim();
  if (status) throw new Error("Codex update source has uncommitted files");
  const head = (await capture("git", ["rev-parse", "HEAD"])).trim();
  const tag = (await capture("git", ["rev-parse", `v${appVersion}^{commit}`])).trim();
  const upstream = (await capture("git", ["rev-parse", "@{upstream}"])).trim();
  if (head !== tag || head !== upstream) throw new Error("Codex update source is not the pushed application release");
}

async function verifyDeployment(expectedRuntime = null) {
  const activePort = Number((await fs.readFile(path.join(runtimeDir, "active-port"), "utf8")).trim());
  if (!backendPorts.includes(activePort)) throw new Error("Invalid active backend after Codex update");
  const gateway = await fetchJson(`http://127.0.0.1:${gatewayPort}/internal/gateway-ready`, 5_000);
  if (gateway.ok !== true || gateway.upstreamPort !== activePort) throw new Error("Stable gateway verification failed");
  const codex = await fetchJson(`http://127.0.0.1:${activePort}/internal/codex-ready`, 8_000);
  if (
    codex.version !== appVersion
    || codex.threadListReady !== true
    || codex.runtimeBundleReady !== true
    || codex.codeModeHostReady !== true
    || (
      expectedRuntime !== null
      && (
        codex.codexVersion !== expectedRuntime.runtimeBundleVersion
        || codex.codexTarget !== expectedRuntime.runtimeBundleTarget
        || codex.codexRuntimeSha256 !== expectedRuntime.runtimeBundleSha256
        || codex.codexCodeModeHostSha256 !== expectedRuntime.runtimeBundleCodeModeHostSha256
      )
    )
  ) {
    throw new Error("Updated Codex deep verification failed");
  }
  return activePort;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return data;
}

async function update(phase, detail, extra = {}) {
  await statusStore.write({
    status: "running",
    phase,
    detail,
    completedAt: null,
    error: null,
    ...(process.env.CODEX_DESKTOP_OPERATION_ID ? { unit: process.env.CODEX_DESKTOP_OPERATION_ID } : {}),
    ...extra,
  });
}

async function complete({ beforeVersion, afterVersion, detail, startedAt }) {
  await statusStore.write({
    status: "completed",
    phase: "completed",
    beforeVersion,
    afterVersion,
    detail,
    startedAt,
    completedAt: Date.now(),
    error: null,
  });
}

async function fail(detail, error, extra = {}) {
  await statusStore.write({
    status: "failed",
    phase: "failed",
    detail,
    completedAt: Date.now(),
    error: error.message,
    ...extra,
  });
}

async function updateIsStillRunning(current) {
  if (statusTimestampIsFresh(current)) return true;
  if (await operationLockState(lockPath, codexUpdateLockOptions) !== "inactive") return true;
  if (!current.unit) return false;
  return commandSucceeds("systemctl", ["is-active", "--quiet", current.unit]);
}

function run(command, args, { env = process.env, timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectDir, env, stdio: "inherit" });
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const timeoutError = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve();
    };
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(timeoutError);
      }, CHILD_TERMINATION_GRACE_MS);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeout?.unref?.();
    child.on("error", (error) => finish(timedOut ? timeoutError : error));
    child.on("exit", (code) => {
      if (timedOut) finish(timeoutError);
      else if (code === 0) finish();
      else finish(new Error(`${command} ${args.join(" ")} exited with status ${code}`));
    });
  });
}

function remainingDrainMs(drainLease) {
  return Math.max(1, drainLease.deadlineAt - Date.now());
}

function activationForceTimeout() {
  const timeoutMs = Number(process.env.CODEX_DESKTOP_FORCE_ACTIVATION_TIMEOUT_MS || 90_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 5 * 60 * 1000) {
    throw new Error("Invalid forced activation timeout");
  }
  return timeoutMs;
}

function combineErrors(first, second) {
  return new Error(`${first.message}; ${second.message}`);
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

function commandSucceeds(command, args, { timeoutMs = SYSTEMCTL_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectDir, stdio: "ignore" });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    timeout.unref?.();
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

function boundedLauncherDuration(value, maximum, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return maximum;
  return Math.min(maximum, Math.floor(parsed));
}

function validateVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid application version: ${value}`);
  }
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label}`);
  return port;
}

function parsePorts(value) {
  const ports = [...new Set(String(value).split(",").map((port) => parsePort(port, "backend port")))];
  if (ports.length !== 2) throw new Error("Exactly two backend ports are required");
  return ports;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathExists(candidate) {
  return fs.access(candidate).then(() => true, () => false);
}
