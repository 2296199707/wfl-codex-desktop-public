import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { startDeploymentWatchdog } from "../lib/deployment-watchdog.mjs";
import { waitForIdleDrain } from "../lib/maintenance-drain.mjs";
import {
  acquireMaintenanceOperationLock,
  cancelMaintenanceReservation,
  operationLockState,
  reclaimInactiveOperationLock,
  RELEASE_LOCK_ACCEPTED_COMMANDS,
  reserveMaintenanceOperation,
} from "../lib/operation-lock.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";
import { ReleaseCandidateStore } from "../lib/release-candidate-store.mjs";
import { verifyRollbackRelease } from "../lib/rollback-release.mjs";
import { ACTIVE_ROLLBACK_PHASES, RollbackStatusStore } from "../lib/rollback-status.mjs";
import { deploymentRecoveryStatusIsTerminal } from "../lib/deployment-recovery-status.mjs";

const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDirectory = path.resolve(process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"));
const stateDirectory = path.resolve(process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"));
const backupDirectory = path.resolve(
  process.env.CODEX_DESKTOP_BACKUP_DIR || path.join(sourceDirectory, "backups"),
);
const gatewayPort = Number(process.env.CODEX_DESKTOP_GATEWAY_PORT || 4317);
const backendPorts = parsePorts(process.env.CODEX_DESKTOP_UPSTREAM_PORTS || "4318,4319");
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
const targetVersion = optionValue("--version");
const statusStore = new RollbackStatusStore(stateDirectory);
const drainStore = new ReleaseDrainStore(runtimeDirectory);
const cancelStore = new DeploymentCancelStore(runtimeDirectory);
const lockPath = path.join(runtimeDirectory, "release.lock");
let currentVersion = null;
const releaseCandidateId = process.env.CODEX_DESKTOP_RELEASE_CANDIDATE_ID || null;
// Keep rollback consistent with the owner's default deployment policy. An
// explicit zero requests a one-off idle drain before activation.
const forceUpdate = process.env.CODEX_DESKTOP_FORCE_UPDATE !== "0";
const sharedReleaseLockOptions = {
  ownerCommand: "scripts/rollback.mjs",
  acceptedCommands: RELEASE_LOCK_ACCEPTED_COMMANDS,
  requiredArguments: ["--worker"],
  conflictMessage: "Another release, update, or rollback is already running",
};

try {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await statusStore.read(), null, 2));
  } else {
    if (!targetVersion) throw new Error("--version is required");
    validateVersion(targetVersion);
    if (process.argv.includes("--worker")) await runWorker();
    else await launchWorker();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function launchWorker() {
  const active = await readActiveBackendVersion();
  currentVersion = active.version;
  await verifyRollbackRelease(targetVersion, { runtimeDirectory, sourceDirectory, backupDirectory, stateSchema: 1 });
  const unit = `wfl-codex-rollback-v${targetVersion.replaceAll(".", "-")}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const reservation = await reserveMaintenanceOperation(runtimeDirectory, {
    operationKind: "rollback",
    operationId: unit,
    ownerCommand: "scripts/rollback.mjs",
  });
  let launched = false;
  try {
    await clearStaleReleaseLock();
    const current = await statusStore.read();
    if (ACTIVE_ROLLBACK_PHASES.has(current.phase) && await rollbackIsStillRunning(current)) {
      throw new Error("A rollback is already running");
    }
    if (ACTIVE_ROLLBACK_PHASES.has(current.phase)) {
      await statusStore.write({
        phase: "failed",
        detail: "上次手动回滚任务已异常退出，可以重新执行",
        completedAt: Date.now(),
        error: "Stale rollback state was cleared",
      });
    }
    await cancelStore.clear(unit);
    await statusStore.write({
      phase: "queued", fromVersion: currentVersion, targetVersion, candidateId: releaseCandidateId, unit,
      detail: "等待后台回滚任务启动", startedAt: Date.now(), completedAt: null, error: null,
    });
    await run("systemd-run", [
      `--unit=${unit}`,
      `--description=WFL Codex Desktop manual rollback to v${targetVersion}`,
      `--property=WorkingDirectory=${sourceDirectory}`,
      "--property=RuntimeMaxSec=20min",
      "--property=OnFailure=wfl-codex-desktop-deployment-recovery.service",
      `--setenv=PATH=${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      `--setenv=CODEX_DESKTOP_STATE_DIR=${stateDirectory}`,
      `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDirectory}`,
      `--setenv=CODEX_DESKTOP_BACKUP_DIR=${backupDirectory}`,
      `--setenv=CODEX_DESKTOP_GATEWAY_PORT=${gatewayPort}`,
      `--setenv=CODEX_DESKTOP_UPSTREAM_PORTS=${backendPorts.join(",")}`,
      `--setenv=CODEX_DESKTOP_OPERATION_ID=${unit}`,
      `--setenv=CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN=${reservation.record.token}`,
      ...(process.env.CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED === "1"
        ? ["--setenv=CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1"]
        : []),
      `--setenv=CODEX_DESKTOP_FORCE_UPDATE=${forceUpdate ? "1" : "0"}`,
      ...(releaseCandidateId
        ? [`--setenv=CODEX_DESKTOP_RELEASE_CANDIDATE_ID=${releaseCandidateId}`]
        : []),
      "--collect",
      "--no-block",
      process.execPath,
      path.join(sourceDirectory, "scripts", "rollback.mjs"),
      "--worker",
      "--version",
      targetVersion,
    ], { timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS });
    launched = true;
    console.log(JSON.stringify({ ok: true, status: "queued", unit, targetVersion }));
  } catch (error) {
    const current = await statusStore.read().catch(() => null);
    if (current?.unit === unit) {
      await statusStore.write({
        phase: "failed", candidateId: releaseCandidateId, detail: "无法启动后台回滚任务",
        completedAt: Date.now(), error: error.message,
      }).catch(() => {});
    }
    throw error;
  } finally {
    if (!launched) await reservation.cancel().catch(() => {});
  }
}

async function runWorker() {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });
  const startedAt = Date.now();
  const operationId = process.env.CODEX_DESKTOP_OPERATION_ID || `rollback-${process.pid}-${startedAt}`;
  process.env.CODEX_DESKTOP_OPERATION_ID = operationId;
  const reservationToken = process.env.CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN || null;
  let lock = null;
  try {
    lock = await acquireMaintenanceOperationLock(runtimeDirectory, {
      operationKind: "rollback",
      operationId,
      ownerCommand: "scripts/rollback.mjs",
      reservationToken,
      lockPath,
      lockOptions: sharedReleaseLockOptions,
    });
  } catch (error) {
    if (reservationToken) {
      const queued = await statusStore.read().catch(() => null);
      if (queued?.unit === operationId) {
        await statusStore.write({
          phase: "failed",
          fromVersion: currentVersion,
          targetVersion,
          candidateId: releaseCandidateId,
          unit: operationId,
          detail: "回滚任务未能取得安全执行窗口",
          completedAt: Date.now(),
          error: error.message,
        }).catch(() => {});
      }
      await cancelMaintenanceReservation(runtimeDirectory, {
        operationId,
        reservationToken,
        ownerCommand: "scripts/rollback.mjs",
      }).catch(() => {});
    }
    throw error;
  }
  let drainLease = null;
  let candidateStaged = false;
  let deploymentWatchdog = null;
  try {
    await assertNotCancelled(operationId);
    const active = await readActiveBackendVersion();
    currentVersion = active.version;
    await update("preflight", "复验本地版本、状态兼容性与 SHA-256");
    await verifyRollbackRelease(targetVersion, { runtimeDirectory, sourceDirectory, backupDirectory, stateSchema: 1 });
    if (targetVersion === currentVersion) throw new Error("Target version is already active");

    await update("backup", "回滚前备份当前版本");
    await run("npm", ["run", "backup"]);

    await assertNotCancelled(operationId);
    await update("deploying", "启动独立恢复看门进程，当前对话继续可用");
    deploymentWatchdog = await startDeploymentWatchdog({
      sourceDirectory,
      runtimeDirectory,
      operationId,
    });
    await deploymentWatchdog.assertActive();
    await update("deploying", "准备目标版本候选后端，当前对话继续可用");
    await run(process.execPath, [
      path.join(sourceDirectory, "scripts", "deploy.mjs"),
      "--stage", "--operation-id", operationId, "--version", targetVersion,
    ], {
      env: { ...process.env, CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token },
    });
    candidateStaged = true;
    await deploymentWatchdog.assertActive();

    if (forceUpdate) {
      await update("forcing", "不等待运行中的对话，立即执行回滚切换；中断任务将在后端恢复后重连");
      await assertNotCancelled(operationId);
      await deploymentWatchdog.assertActive();
      await run(process.execPath, [
        path.join(sourceDirectory, "scripts", "deploy.mjs"),
        "--activate-staged", "--defer-finalize", "--operation-id", operationId, "--version", targetVersion,
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
      await update("waiting", "等待对话自然结束，期间仍可继续发送消息");
      drainLease = await waitForIdleDrain({
        drainStore,
        version: targetVersion,
        fetchReadiness: () => fetchTaskReadiness(drainPort, drainProtocol),
        allowLegacyProtocol: drainProtocol === "legacy",
        isCancellationRequested: () => cancelStore.isCancellationRequested(operationId),
        onWaiting: () => update("waiting", "仍在等待安全回滚窗口，对话服务保持开放"),
        timeoutMs: rollbackDrainTimeout(),
        maxDrainMs: 60_000,
      });
      await update("draining", "已确认任务空闲，正在执行短时回滚切换");
      await assertNotCancelled(operationId);
      await drainLease.assertActive();
      await deploymentWatchdog.assertActive();
      await run(process.execPath, [
        path.join(sourceDirectory, "scripts", "deploy.mjs"),
        "--activate-staged", "--defer-finalize", "--operation-id", operationId, "--version", targetVersion,
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
    await update("verifying", "确认稳定网关已切换到目标版本");
    const activePort = await verifyGatewayVersion(targetVersion);
    await deploymentWatchdog.assertActive();
    await run(process.execPath, [
      path.join(sourceDirectory, "scripts", "deploy.mjs"),
      "--finalize-staged", "--operation-id", operationId, "--version", targetVersion,
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
    await statusStore.write({
      phase: "completed", fromVersion: currentVersion, targetVersion, candidateId: releaseCandidateId,
      detail: `手动回滚完成，活动后端 ${activePort}`, startedAt, completedAt: Date.now(), error: null,
    });
    await finishCandidateDiscard({ phase: "discarded", targetVersion });
  } catch (error) {
    if (drainLease) {
      await drainLease.release().catch(() => {});
      drainLease = null;
    }
    if (candidateStaged) {
      let topologyRecoveryPending = false;
      const cleanupEnvironment = {
        ...process.env,
        ...(deploymentWatchdog ? { CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: deploymentWatchdog.token } : {}),
      };
      try {
        await run(process.execPath, [
          path.join(sourceDirectory, "scripts", "deploy.mjs"),
          "--discard-staged", "--operation-id", operationId, "--version", targetVersion,
        ], { env: cleanupEnvironment });
        candidateStaged = false;
      } catch {
        if (deploymentWatchdog) {
          topologyRecoveryPending = true;
        } else {
          await run(process.execPath, [
            path.join(sourceDirectory, "scripts", "deploy.mjs"),
            "--recover-staged", "--operation-id", operationId, "--version", targetVersion,
          ], { env: cleanupEnvironment }).then(
            () => { candidateStaged = false; },
            () => {},
          );
        }
      }
      const recoveryStatus = await statusStore.read().catch(() => null);
      if (!deploymentRecoveryStatusIsTerminal(recoveryStatus, operationId, startedAt)) {
        await statusStore.write({
          phase: "failed", fromVersion: currentVersion, targetVersion, candidateId: releaseCandidateId,
          unit: operationId,
          detail: topologyRecoveryPending
            ? "回滚未完成，恢复看门程序将在当前任务退出后接管后端恢复"
            : error.code === "ERR_MAINTENANCE_CANCELLED"
              ? "手动回滚已由所有者取消，原活动后端保持运行"
              : "手动回滚失败，原活动后端保持不变",
          startedAt, completedAt: Date.now(), error: error.message,
        }).catch(() => {});
      }
    } else {
      const recoveryStatus = await statusStore.read().catch(() => null);
      if (!deploymentRecoveryStatusIsTerminal(recoveryStatus, operationId, startedAt)) {
        await statusStore.write({
          phase: "failed", fromVersion: currentVersion, targetVersion, candidateId: releaseCandidateId,
          unit: operationId,
          detail: error.code === "ERR_MAINTENANCE_CANCELLED"
            ? "手动回滚已由所有者取消，原活动后端保持运行"
            : "手动回滚失败，原活动后端保持不变",
          startedAt, completedAt: Date.now(), error: error.message,
        }).catch(() => {});
      }
    }
    await finishCandidateDiscard({ phase: "failed", targetVersion, error: error.message });
    throw error;
  } finally {
    if (drainLease) await drainLease.release().catch(() => {});
    await cancelStore.clear(operationId).catch(() => {});
    await lock?.release();
  }
}

async function finishCandidateDiscard({ phase, targetVersion, error = null }) {
  if (!releaseCandidateId) return;
  const store = new ReleaseCandidateStore(stateDirectory);
  try {
    await store.update(releaseCandidateId, {
      phase,
      detail: phase === "discarded"
        ? `候选已废弃，已恢复 v${targetVersion}`
        : "候选废弃回滚失败，当前运行版本需要人工复核",
      completedAt: Date.now(),
      error,
    }, { expectedPhases: ["discarding"] });
  } catch (updateError) {
    if (updateError.code === "ERR_RELEASE_CANDIDATE_STALE") {
      const latest = await store.current().catch(() => null);
      if (latest?.phase === "discarded" || latest?.phase === "failed") return latest;
    }
    // Candidate metadata is reconciled from rollback-status.json by the
    // server. A metadata race or transient write failure must not turn an
    // already completed deployment into a failed rollback.
    console.error(`Unable to finalize release candidate discard metadata: ${updateError.message}`);
  }
}

async function readActivePortForDrain() {
  const activePort = Number((await fs.readFile(path.join(runtimeDirectory, "active-port"), "utf8")).trim());
  if (!backendPorts.includes(activePort)) throw new Error("Invalid active backend before rollback drain");
  return activePort;
}

async function readActiveBackendVersion() {
  const activePort = await readActivePortForDrain();
  const response = await fetch(`http://127.0.0.1:${activePort}/internal/ready`, {
    headers: { Host: `127.0.0.1:${activePort}` },
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  const data = await response.json();
  if (!response.ok || data?.ok !== true || typeof data.version !== "string" || !data.version) {
    throw new Error("Active backend readiness did not return a valid running version");
  }
  return { port: activePort, version: data.version };
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
  const error = new Error(
    "Legacy backend rollback requires explicit CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1 confirmation",
  );
  error.code = "ERR_LEGACY_DRAIN_CONFIRMATION_REQUIRED";
  throw error;
}

async function fetchTaskReadiness(activePort, protocol = "current") {
  const data = await fetchTaskReadinessResponse(activePort);
  if (protocol === "current" && typeof data.maintenanceIdle === "boolean") return data;
  if (protocol === "legacy" && typeof data.maintenanceIdle !== "boolean") {
    return { ...data, legacyProtocol: true };
  }
  const error = new Error("Active backend task drain protocol changed during rollback");
  error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
  throw error;
}

async function fetchTaskReadinessResponse(activePort) {
  const response = await fetch(`http://127.0.0.1:${activePort}/internal/task-ready`, {
    headers: { Host: `127.0.0.1:${activePort}` },
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    const error = new Error("Active backend does not support safe task draining");
    error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
    throw error;
  }
  const data = await response.json();
  if (typeof data?.taskIdle !== "boolean" || typeof data?.draining !== "boolean") {
    const error = new Error("Active backend does not support safe task draining");
    error.code = "ERR_TASK_DRAIN_UNSUPPORTED";
    throw error;
  }
  return data;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return data;
}

function rollbackDrainTimeout() {
  const timeoutMs = Number(process.env.CODEX_DESKTOP_ROLLBACK_DRAIN_TIMEOUT_MS || 10 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 20 * 60 * 1000) {
    throw new Error("Invalid rollback task drain timeout");
  }
  return timeoutMs;
}

async function assertNotCancelled(operationId) {
  if (!await cancelStore.isCancellationRequested(operationId)) return;
  const error = new Error("Maintenance operation was cancelled by the owner");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  throw error;
}

async function verifyGatewayVersion(version) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/internal/gateway-ready`, {
        headers: { Host: `127.0.0.1:${gatewayPort}` }, cache: "no-store", signal: AbortSignal.timeout(2_000),
      });
      const gateway = await response.json();
      const selectedPort = await readActivePortForDrain();
      if (
        response.ok
        && gateway.ok === true
        && gateway.upstreamPort === selectedPort
        && Number.isInteger(gateway.upstreamPort)
      ) {
        const candidate = await fetch(`http://127.0.0.1:${gateway.upstreamPort}/internal/ready`, {
          headers: { Host: `127.0.0.1:${gateway.upstreamPort}` }, cache: "no-store", signal: AbortSignal.timeout(2_000),
        });
        const data = await candidate.json();
        if (candidate.ok && data.version === version) return gateway.upstreamPort;
      }
    } catch {
      // The gateway can briefly reconnect while selecting the verified candidate.
    }
    await delay(500);
  }
  throw new Error(`Gateway did not expose verified v${version}`);
}

async function update(phase, detail) {
  await statusStore.write({
    phase, fromVersion: currentVersion, targetVersion, candidateId: releaseCandidateId, detail,
    ...(process.env.CODEX_DESKTOP_OPERATION_ID ? { unit: process.env.CODEX_DESKTOP_OPERATION_ID } : {}),
  });
}

async function clearStaleReleaseLock() {
  const state = await operationLockState(lockPath, sharedReleaseLockOptions);
  if (state !== "inactive") {
    throw new Error("Another release, update, or rollback is already running");
  }
  await reclaimInactiveOperationLock(lockPath, sharedReleaseLockOptions);
}

async function rollbackIsStillRunning(current) {
  if (await operationLockState(lockPath, sharedReleaseLockOptions) !== "inactive") return true;
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/.test(String(current?.unit || ""))) return false;
  return systemdUnitMayBeActive(current.unit);
}

function systemdUnitMayBeActive(unit) {
  return new Promise((resolve) => {
    const child = spawn("systemctl", ["is-active", unit], { stdio: "ignore" });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(true);
    }, 5_000);
    timeout.unref?.();
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(true);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(![3, 4].includes(code));
    });
  });
}

function run(command, args, { env = process.env, timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sourceDirectory, env, stdio: "inherit" });
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const timeoutError = new Error(`${command} timed out after ${timeoutMs}ms`);
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
      else finish(new Error(`${command} exited with status ${code}`));
    });
  });
}

function boundedLauncherDuration(value, maximum, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return maximum;
  return Math.min(maximum, Math.floor(parsed));
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

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function validateVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("Invalid rollback version");
}

function parsePorts(value) {
  const ports = [...new Set(String(value).split(",").map(Number))];
  if (ports.length !== 2 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Exactly two valid backend ports are required");
  }
  return ports;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
