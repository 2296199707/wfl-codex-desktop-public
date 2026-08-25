import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_APP_UPDATE_PHASES, AppUpdateStatusStore } from "../lib/app-update-status.mjs";
import { codexUpdateIsActive, CodexUpdateStatusStore } from "../lib/codex-update-status.mjs";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import {
  acquireMaintenanceOperationLock,
  cancelMaintenanceReservation,
  operationLockState,
  reserveMaintenanceOperation,
  RELEASE_LOCK_ACCEPTED_COMMANDS,
  statusTimestampIsFresh,
} from "../lib/operation-lock.mjs";
import {
  isNewerStableVersion,
  parseRemoteStableChannel,
  releaseVersionRelation,
  selectLatestStableTag,
} from "../lib/remote-release.mjs";
import { assertNodeEngineCompatible } from "../lib/node-runtime-compatibility.mjs";
import { ACTIVE_RELEASE_PHASES, ReleaseStatusStore } from "../lib/release-status.mjs";
import { deploymentRecoveryStatusIsTerminal } from "../lib/deployment-recovery-status.mjs";
import { readPlaywrightBrowsersPath } from "../lib/playwright-browser.mjs";
import { repairUpdateSource } from "../lib/update-source-repair.mjs";

const scriptSourceDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || scriptSourceDir);
const runtimeDir = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDir, ".codex-runtime"),
);
const stateDir = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDir, ".codex-desktop"),
);
const lockPath = path.join(runtimeDir, "app-update.lock");
const systemctlCommand = process.env.CODEX_DESKTOP_SYSTEMCTL || "systemctl";
const updateSourcesDir = path.join(runtimeDir, "update-sources");
const backupDirectory = path.resolve(
  process.env.CODEX_DESKTOP_BACKUP_DIR || path.join(sourceDir, "backups"),
);
const backendHost = process.env.CODEX_DESKTOP_UPSTREAM_HOST || "127.0.0.1";
const gatewayPort = Number(process.env.CODEX_DESKTOP_GATEWAY_PORT || 4317);
const backendPorts = parsePorts(process.env.CODEX_DESKTOP_UPSTREAM_PORTS || "4318,4319");
const statusStore = new AppUpdateStatusStore(stateDir);
const releaseStatusStore = new ReleaseStatusStore(stateDir);
const codexUpdateStatusStore = new CodexUpdateStatusStore(stateDir);
const cancelStore = new DeploymentCancelStore(runtimeDir);
const requestedRunningVersion = process.env.CODEX_DESKTOP_RUNNING_VERSION || null;
const retryPreparedSource = process.env.CODEX_DESKTOP_RETRY_PREPARED_SOURCE === "1";
// Forced activation is the owner's default. Set CODEX_DESKTOP_FORCE_UPDATE=0
// for a one-off drain that waits for active tasks to finish.
const forceUpdate = process.env.CODEX_DESKTOP_FORCE_UPDATE !== "0";
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
const appUpdateLockOptions = {
  ownerCommand: "scripts/update-app.mjs",
  acceptedCommands: ["scripts/update-app.mjs"],
  requiredArguments: ["--worker"],
  conflictMessage: "Another application update is already running",
};
const releaseConflictLockOptions = {
  ownerCommand: "scripts/release.mjs",
  acceptedCommands: RELEASE_LOCK_ACCEPTED_COMMANDS,
  requiredArguments: ["--worker"],
};
const codexConflictLockOptions = {
  ownerCommand: "scripts/update-codex.mjs",
  acceptedCommands: ["scripts/update-codex.mjs"],
  requiredArguments: ["--worker"],
};

try {
  if (process.argv.includes("--repair")) {
    if (process.argv.length !== 3) throw new Error("--repair 不能与其他更新参数同时使用");
    console.log(JSON.stringify(await repairUpdateSource({
      sourceDirectory: sourceDir,
      runtimeDirectory: runtimeDir,
      apply: true,
    }), null, 2));
  } else if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await statusStore.read(), null, 2));
  } else if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await inspectRemoteRelease(), null, 2));
  } else if (process.argv.includes("--worker")) {
    await runWorker();
  } else {
    await launchWorker();
    if (process.argv.includes("--wait")) await waitForUpdate();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function launchWorker() {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const sourceVersion = await readSourceVersion();
  const runningVersion = requestedRunningVersion || await readRunningVersion();
  const currentVersion = runningVersion || sourceVersion;
  const unit = `wfl-codex-app-update-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const reservation = await reserveMaintenanceOperation(runtimeDir, {
    operationKind: "app-update",
    operationId: unit,
    ownerCommand: "scripts/update-app.mjs",
  });
  let launched = false;
  try {
    const current = await statusStore.read();
    if (ACTIVE_APP_UPDATE_PHASES.has(current.phase) && await updateIsStillRunning(current)) {
      throw new Error(`Application update is already ${current.phase}`);
    }
    if (ACTIVE_APP_UPDATE_PHASES.has(current.phase)) {
      await statusStore.write({
        status: "failed",
        phase: "failed",
        detail: "上次同步任务已异常退出，可以重新执行",
        completedAt: Date.now(),
        error: "上次同步状态已清理",
      });
    }

    await cancelStore.clear(unit);
    await statusStore.write({
      status: "running",
      phase: "queued",
      currentVersion,
      runningVersion,
      sourceVersion,
      targetVersion: null,
      unit,
      detail: "等待后台安全同步任务启动",
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    });
    await run("systemd-run", [
      `--unit=${unit}`,
      "--description=WFL Codex Desktop safe application update",
      `--property=WorkingDirectory=${sourceDir}`,
      "--property=RuntimeMaxSec=35min",
      "--property=OnFailure=wfl-codex-desktop-deployment-recovery.service",
      `--setenv=HOME=${process.env.HOME || os.homedir()}`,
      `--setenv=PATH=${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      `--setenv=CODEX_DESKTOP_SOURCE_DIR=${sourceDir}`,
      `--setenv=CODEX_DESKTOP_STATE_DIR=${stateDir}`,
      `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDir}`,
      `--setenv=CODEX_DESKTOP_BACKUP_DIR=${backupDirectory}`,
      `--setenv=CODEX_DESKTOP_UPSTREAM_HOST=${backendHost}`,
      `--setenv=CODEX_DESKTOP_GATEWAY_PORT=${gatewayPort}`,
      `--setenv=CODEX_DESKTOP_UPSTREAM_PORTS=${backendPorts.join(",")}`,
      `--setenv=CODEX_DESKTOP_OPERATION_ID=${unit}`,
      `--setenv=CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN=${reservation.record.token}`,
      `--setenv=CODEX_DESKTOP_RUNNING_VERSION=${requestedRunningVersion || ""}`,
      `--setenv=CODEX_DESKTOP_RETRY_PREPARED_SOURCE=${retryPreparedSource ? "1" : "0"}`,
      `--setenv=CODEX_DESKTOP_FORCE_UPDATE=${forceUpdate ? "1" : "0"}`,
      "--collect",
      "--no-block",
      process.execPath,
      path.join(scriptSourceDir, "scripts", "update-app.mjs"),
      "--worker",
    ], { cwd: sourceDir, timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS });
    launched = true;
    console.log(JSON.stringify({ ok: true, unit, status: "queued" }));
  } catch (error) {
    const current = await statusStore.read().catch(() => null);
    if (current?.unit === unit) {
      await statusStore.write({
        status: "failed",
        phase: "failed",
        currentVersion,
        runningVersion,
        sourceVersion,
        unit,
        detail: "无法启动后台安全同步任务",
        completedAt: Date.now(),
        error: publicError(error),
      }).catch(() => {});
    }
    throw error;
  } finally {
    if (!launched) await reservation.cancel().catch(() => {});
  }
}

async function waitForUpdate() {
  const deadline = Date.now() + 36 * 60 * 1000;
  let lastPhase = null;
  while (Date.now() < deadline) {
    const status = await statusStore.read();
    if (status.phase !== lastPhase) {
      lastPhase = status.phase;
      console.log(`[${status.phase}] ${status.detail || "Application update"}`);
    }
    if (status.status === "completed") {
      console.log(JSON.stringify({ ok: true, version: status.targetVersion, status: "completed" }));
      return;
    }
    if (status.status === "failed") throw new Error(status.error || status.detail || "Application update failed");
    await delay(1_000);
  }
  throw new Error("Timed out waiting for the application update");
}

async function runWorker() {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const startedAt = Date.now();
  const operationId = process.env.CODEX_DESKTOP_OPERATION_ID || `app-update-${process.pid}-${startedAt}`;
  process.env.CODEX_DESKTOP_OPERATION_ID = operationId;
  const reservationToken = process.env.CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN || null;
  let lock = null;
  try {
    lock = await acquireMaintenanceOperationLock(runtimeDir, {
      operationKind: "app-update",
      operationId,
      ownerCommand: "scripts/update-app.mjs",
      reservationToken,
      lockPath,
      lockOptions: appUpdateLockOptions,
    });
  } catch (error) {
    if (reservationToken) {
      const queued = await statusStore.read().catch(() => null);
      if (queued?.unit === operationId) {
        await statusStore.write({
          status: "failed",
          phase: "failed",
          unit: operationId,
          detail: "安全同步任务未能取得独占执行窗口",
          completedAt: Date.now(),
          error: publicError(error),
        }).catch(() => {});
      }
      await cancelMaintenanceReservation(runtimeDir, {
        operationId,
        reservationToken,
        ownerCommand: "scripts/update-app.mjs",
      }).catch(() => {});
    }
    throw error;
  }
  let currentVersion = null;
  let runningVersion = null;
  let targetVersion = null;
  try {
    await assertNotCancelled(operationId);
    currentVersion = await readSourceVersion();
    runningVersion = requestedRunningVersion || await readRunningVersion();
    await assertNoConflictingOperations();
    await update("checking", "检查本地源码、分支和只读远程仓库", {
      currentVersion: runningVersion || currentVersion,
      runningVersion,
      sourceVersion: currentVersion,
      startedAt,
    });
    await update("repairing", "检查并隔离上一版 Flutter 生成物", { startedAt });
    const repair = await repairUpdateSource({
      sourceDirectory: sourceDir,
      runtimeDirectory: runtimeDir,
      apply: true,
    });
    if (repair.status === "repaired") {
      await update("repairing", `已隔离 ${repair.paths.length} 项旧 Flutter 生成物，保存在运行目录备份中`, { startedAt });
    }
    await verifyCleanSource();

    let target;
    if (retryPreparedSource) {
      target = await verifyPreparedSource(currentVersion);
      await update("checking", `重新验证已同步的稳定标签 v${currentVersion}`);
    } else {
      await update("fetching", "拉取远程稳定标签，不修改当前运行版本");
      await run("git", [
        "fetch", "--prune", "--tags", "origin",
        "refs/heads/stable:refs/remotes/origin/stable",
      ], { cwd: sourceDir });
      await assertNotCancelled(operationId);
      target = await latestFetchedRelease();
    }
    targetVersion = target.version;
    await update("checking", `验证稳定标签 v${targetVersion}`, { targetVersion });

    if (!isNewerStableVersion(targetVersion, currentVersion)) {
      if (targetVersion !== currentVersion || !runningVersion || runningVersion === currentVersion) {
        const localAhead = releaseVersionRelation(targetVersion, currentVersion) === "behind";
        await update("verifying", "确认当前活动后端和稳定网关状态");
        // The remote channel can legitimately lag a locally prepared stable
        // release. In that case targetVersion is the older remote tag, while
        // the active backend must still be checked against the version we
        // actually expect to be serving.
        const expectedVersion = runningVersion || currentVersion;
        const activePort = await verifyActiveDeployment(expectedVersion);
        await statusStore.write({
          status: "completed",
          phase: "completed",
          currentVersion: runningVersion || currentVersion,
          runningVersion,
          sourceVersion: currentVersion,
          targetVersion,
          detail: localAhead
            ? `本地 v${currentVersion} 领先远程稳定版 v${targetVersion}，未执行同步`
            : `当前源码和运行服务已是最新稳定版 v${currentVersion}`,
          startedAt,
          completedAt: Date.now(),
          error: null,
        });
        return;
      }
    }

    const targetCommit = (await capture("git", ["rev-parse", `${target.tag}^{commit}`], { cwd: sourceDir })).trim();
    const currentCommit = (await capture("git", ["rev-parse", "HEAD"], { cwd: sourceDir })).trim();
    if (!await commandSucceeds("git", ["merge-base", "--is-ancestor", targetCommit, "refs/remotes/origin/stable"], { cwd: sourceDir })) {
      throw new Error("目标版本标签不属于 origin/stable，已拒绝同步");
    }
    if (!await commandSucceeds("git", ["merge-base", "--is-ancestor", currentCommit, targetCommit], { cwd: sourceDir })) {
      throw new Error("本地源码无法快进到目标版本，需要人工检查分支历史");
    }

    await update("preparing", `在隔离目录准备 v${targetVersion}`, { targetVersion });
    const worktreeDir = await prepareWorktree(target, targetCommit);
    await assertTargetNodeCompatible(worktreeDir);
    await run("npm", ["ci"], { cwd: worktreeDir });

    await assertNotCancelled(operationId);
    await update("preparing", `准备 v${targetVersion} 的 Chromium 浏览器缓存`, { targetVersion });
    await run(process.execPath, [path.join(worktreeDir, "scripts", "ensure-playwright-browser.mjs"), "--install"], {
      cwd: worktreeDir,
      env: {
        ...isolatedCheckEnvironment(),
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDir,
      },
    });
    const playwrightBrowsersPath = await readPlaywrightBrowsersPath(runtimeDir);
    if (!playwrightBrowsersPath) throw new Error("Chromium browser cache path was not persisted");

    await assertNotCancelled(operationId);
    await update("testing", `快速检查 v${targetVersion} 与当前服务器环境`);
    await run("npm", ["run", "update:quick-check"], {
      cwd: worktreeDir,
      env: {
        ...isolatedCheckEnvironment(),
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
        CODEX_DESKTOP_QUICK_CHECK_OFFLINE: "1",
      },
    });

    await assertNotCancelled(operationId);
    if (currentVersion !== targetVersion) {
      await update("activating", `测试通过，准备 v${targetVersion} 控制源码`);
      await run("git", ["merge", "--ff-only", targetCommit], { cwd: sourceDir });
      currentVersion = await readSourceVersion();
      if (currentVersion !== targetVersion) throw new Error("本地源码版本与已验证标签不一致");
    } else {
      await update("activating", `v${targetVersion} 已同步，准备重新完成服务切换`);
    }

    await update("deploying", `通过备用后端部署 v${targetVersion}`, { currentVersion });
    await run(process.execPath, [path.join(worktreeDir, "scripts", "release.mjs"), "--worker"], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        CODEX_DESKTOP_SOURCE_DIR: sourceDir,
        CODEX_DESKTOP_STATE_DIR: stateDir,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDir,
        CODEX_DESKTOP_BACKUP_DIR: backupDirectory,
        CODEX_DESKTOP_PRECHECK_COMMIT: targetCommit,
        CODEX_DESKTOP_PRECHECK_KIND: "stable",
        CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1",
        CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN: "",
        CODEX_DESKTOP_FORCE_UPDATE: forceUpdate ? "1" : "0",
      },
    });

    const release = await releaseStatusStore.read();
    if (release.status !== "completed" || release.version !== targetVersion) {
      throw new Error("候选版本未通过最终发布验证");
    }
    await update("verifying", `确认 v${targetVersion} 已成为活动版本`);
    const activePort = await verifyActiveDeployment(targetVersion);
    await statusStore.write({
      status: "completed",
      phase: "completed",
      currentVersion: targetVersion,
      runningVersion: targetVersion,
      sourceVersion: currentVersion,
      targetVersion,
      detail: `已安全同步并发布 v${targetVersion}（活动后端 ${activePort}）`,
      startedAt,
      completedAt: Date.now(),
      error: null,
    });
  } catch (error) {
    console.error(error.stack || error.message);
    const recoveryStatus = await statusStore.read().catch(() => null);
    if (!deploymentRecoveryStatusIsTerminal(recoveryStatus, operationId, startedAt)) {
      await statusStore.write({
        status: "failed",
        phase: "failed",
        currentVersion: runningVersion || currentVersion,
        runningVersion,
        sourceVersion: currentVersion,
        targetVersion,
        detail: error.code === "ERR_MAINTENANCE_CANCELLED"
          ? "安全同步已由所有者取消，当前活动后端保持运行"
          : "安全同步未完成，当前活动后端保持不变",
        startedAt,
        completedAt: Date.now(),
        error: publicError(error),
      }).catch(() => {});
    }
    throw error;
  } finally {
    await cancelStore.clear(operationId).catch(() => {});
    await lock?.release();
  }
}

async function inspectRemoteRelease() {
  const sourceVersion = await readSourceVersion();
  const runningVersion = requestedRunningVersion || await readRunningVersion() || sourceVersion;
  const output = await capture("git", ["ls-remote", "origin", "refs/heads/stable", "refs/tags/v*"], {
    cwd: sourceDir,
    timeoutMs: 10_000,
  });
  const latest = parseRemoteStableChannel(output);
  if (!latest) throw new Error("远程 stable 分支与正式版本标签不一致");
  return {
    currentVersion: runningVersion,
    runningVersion,
    sourceVersion,
    sourcePending: sourceVersion !== runningVersion,
    version: latest.version,
    tag: latest.tag,
    updateAvailable: isNewerStableVersion(latest.version, sourceVersion),
    relation: releaseVersionRelation(latest.version, sourceVersion),
    runningRelation: releaseVersionRelation(latest.version, runningVersion),
  };
}

async function latestFetchedRelease() {
  const output = await capture("git", ["tag", "--list", "v*", "--merged", "refs/remotes/origin/stable"], {
    cwd: sourceDir,
  });
  const latest = selectLatestStableTag(output.split(/\r?\n/));
  if (!latest) throw new Error("origin/stable 中没有可用的稳定版本标签");
  const [tagCommit, stableCommit] = await Promise.all([
    capture("git", ["rev-parse", `${latest.tag}^{commit}`], { cwd: sourceDir }).then((value) => value.trim()),
    capture("git", ["rev-parse", "refs/remotes/origin/stable"], { cwd: sourceDir }).then((value) => value.trim()),
  ]);
  if (tagCommit !== stableCommit) throw new Error("origin/stable 与最新正式版本标签不一致");
  return latest;
}

async function verifyPreparedSource(currentVersion) {
  const tag = `v${currentVersion}`;
  const head = (await capture("git", ["rev-parse", "HEAD"], { cwd: sourceDir })).trim();
  const tagCommit = (await capture("git", ["rev-parse", `${tag}^{commit}`], { cwd: sourceDir })).trim();
  if (head !== tagCommit) throw new Error("已同步源码不再匹配稳定版本标签，已拒绝重试");
  if (!await commandSucceeds("git", ["merge-base", "--is-ancestor", head, "refs/remotes/origin/stable"], { cwd: sourceDir })) {
    throw new Error("已同步源码不属于 origin/stable，已拒绝重试");
  }
  return { tag, version: currentVersion };
}

async function prepareWorktree(target, targetCommit) {
  await fs.mkdir(updateSourcesDir, { recursive: true, mode: 0o755 });
  const worktreeDir = path.join(updateSourcesDir, target.tag);
  try {
    const existingCommit = (await capture("git", ["rev-parse", "HEAD"], { cwd: worktreeDir })).trim();
    const status = (await capture("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktreeDir })).trim();
    if (existingCommit !== targetCommit || status) {
      throw new Error(`已存在的 ${target.tag} 隔离目录与目标标签不一致`);
    }
    return worktreeDir;
  } catch (error) {
    if (error.message.includes("已存在的")) throw error;
    if (await exists(worktreeDir)) throw new Error(`无法验证已存在的 ${target.tag} 隔离目录`);
  }
  await run("git", ["worktree", "prune"], { cwd: sourceDir });
  await run("git", ["worktree", "add", "--detach", worktreeDir, target.tag], { cwd: sourceDir });
  return worktreeDir;
}

async function assertTargetNodeCompatible(directory) {
  const packageJson = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  return assertNodeEngineCompatible(packageJson?.engines?.node);
}

async function verifyCleanSource() {
  const status = (await capture("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: sourceDir })).trim();
  if (status) throw new Error("服务器源码目录存在未提交修改，已拒绝自动同步");
  const branch = (await capture("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: sourceDir })).trim();
  if (branch !== "stable") throw new Error(`服务器源码当前分支为 ${branch || "detached"}，必须是 stable`);
  const upstream = (await capture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: sourceDir })).trim();
  if (upstream !== "origin/stable") {
    throw new Error(`服务器源码上游为 ${upstream || "none"}，必须是 origin/stable`);
  }
}

async function assertNoConflictingOperations() {
  const [release, codexUpdate] = await Promise.all([
    releaseStatusStore.read(),
    codexUpdateStatusStore.read(),
  ]);
  if (
    ACTIVE_RELEASE_PHASES.has(release.phase)
    && await maintenanceStatusMayBeActive(
      release,
      path.join(runtimeDir, "release.lock"),
      releaseConflictLockOptions,
    )
  ) throw new Error("网页版本正在发布，请稍后再同步");
  if (
    codexUpdateIsActive(codexUpdate)
    && await maintenanceStatusMayBeActive(
      codexUpdate,
      path.join(runtimeDir, "codex-update.lock"),
      codexConflictLockOptions,
    )
  ) throw new Error("官方 Codex 正在升级，请稍后再同步");
}

async function readSourceVersion() {
  const value = (await fs.readFile(path.join(sourceDir, "VERSION"), "utf8")).trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("服务器源码版本格式无效");
  }
  return value;
}

async function readRunningVersion() {
  try {
    const activePort = Number((await fs.readFile(path.join(runtimeDir, "active-port"), "utf8")).trim());
    if (!backendPorts.includes(activePort)) return null;
    const response = await fetch(`http://${backendHost}:${activePort}/internal/codex-ready`, {
      headers: { Host: `${backendHost}:${activePort}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const data = await response.json();
    return response.ok && typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

async function verifyActiveDeployment(expectedVersion) {
  const deadline = Date.now() + 30_000;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    try {
      const activePort = await readActivePort();
      const gateway = await fetchJson(`http://127.0.0.1:${gatewayPort}/internal/gateway-ready`, 2_000);
      if (gateway.ok !== true || gateway.upstreamPort !== activePort) {
        throw new Error(`gateway selected ${gateway.upstreamPort}, active-port is ${activePort}`);
      }
      const ready = await fetchJson(`http://${backendHost}:${activePort}/internal/ready`, 2_000);
      if (ready.ok !== true || ready.version !== expectedVersion) {
        throw new Error(`active backend readiness is v${ready.version || "unknown"}`);
      }
      const codex = await fetchJson(`http://${backendHost}:${activePort}/internal/codex-ready`, 3_000);
      if (
        codex.ok !== true
        || codex.version !== expectedVersion
        || codex.codexReady !== true
        || codex.threadListReady !== true
        || codex.runtimeBundleReady !== true
        || codex.codeModeHostReady !== true
        || typeof codex.codexTarget !== "string"
        || !/^[a-f0-9]{64}$/iu.test(codex.codexRuntimeSha256 || "")
        || !/^[a-f0-9]{64}$/iu.test(codex.codexCodeModeHostSha256 || "")
      ) throw new Error("active backend Codex readiness is incomplete");
      return activePort;
    } catch (error) {
      lastStatus = error.message;
    }
    if (Date.now() < deadline) await delay(Math.min(500, deadline - Date.now()));
  }
  throw new Error(`活动后端未确认 v${expectedVersion}: ${lastStatus}`);
}

async function readActivePort() {
  const activePort = Number((await fs.readFile(path.join(runtimeDir, "active-port"), "utf8")).trim());
  if (!backendPorts.includes(activePort)) throw new Error(`Invalid active backend port: ${activePort}`);
  return activePort;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
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

async function assertNotCancelled(operationId) {
  if (!await cancelStore.isCancellationRequested(operationId)) return;
  const error = new Error("Maintenance operation was cancelled by the owner");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  throw error;
}

async function updateIsStillRunning(status) {
  return statusTimestampIsFresh(status)
    || await maintenanceStatusMayBeActive(status, lockPath, appUpdateLockOptions, { startupGrace: false });
}

async function maintenanceStatusMayBeActive(status, operationLockPath, lockOptions, { startupGrace = true } = {}) {
  const [lockState, unitState] = await Promise.all([
    operationLockState(operationLockPath, lockOptions),
    systemdUnitState(status?.unit),
  ]);
  if (lockState === "active" || unitState === "active") return true;
  if (lockState === "unknown" || unitState === "unknown") return true;
  return startupGrace && statusTimestampIsFresh(status);
}

function systemdUnitState(unit) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/.test(String(unit || ""))) return Promise.resolve("inactive");
  return new Promise((resolve) => {
    const child = spawn(systemctlCommand, ["is-active", "--quiet", unit], { cwd: sourceDir, stdio: "ignore" });
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(state);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish("unknown");
    }, 5_000);
    timeout.unref?.();
    child.on("error", () => finish("unknown"));
    child.on("exit", (code) => finish(code === 0 ? "active" : [3, 4].includes(code) ? "inactive" : "unknown"));
  });
}

function publicError(error) {
  const message = String(error?.message || "");
  const allowed = [
    "目标版本需要 Node.js",
    "目标版本声明了无法识别的 Node.js 要求",
    "服务器源码目录存在未提交修改",
    "本地源码无法快进",
    "目标版本标签不属于",
    "已同步源码不再匹配",
    "已同步源码不属于",
    "远程仓库没有可用",
    "origin/main 中没有可用",
    "官方 Codex 正在升级",
    "网页版本正在发布",
    "Timed out waiting for the active conversation task",
  ];
  return allowed.some((prefix) => message.startsWith(prefix))
    ? message.slice(0, 500)
    : "远程同步未完成，请检查服务器发布日志";
}

function isolatedCheckEnvironment() {
  const environment = { ...process.env };
  delete environment.CODEX_DESKTOP_SOURCE_DIR;
  delete environment.CODEX_DESKTOP_RUNNING_VERSION;
  delete environment.CODEX_DESKTOP_PRECHECK_COMMIT;
  delete environment.CODEX_DESKTOP_OPERATION_ID;
  delete environment.CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN;
  delete environment.CODEX_DESKTOP_CANCEL_DECISION_MANAGED;
  delete environment.CODEX_DESKTOP_DRAIN_TOKEN;
  delete environment.CODEX_DESKTOP_DRAIN_TTL_MS;
  delete environment.CODEX_DESKTOP_DRAIN_DEADLINE_AT;
  delete environment.CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED;
  delete environment.CODEX_DESKTOP_FORCE_UPDATE;
  delete environment.CODEX_DESKTOP_FORCE_ACTIVATION;
  return environment;
}

function run(command, args, { cwd = sourceDir, env = process.env, timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const timeoutError = new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`);
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
      else finish(new Error(`${path.basename(command)} exited with status ${code}`));
    });
  });
}

function boundedLauncherDuration(value, maximum, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return maximum;
  return Math.min(maximum, Math.floor(parsed));
}

function capture(command, args, { cwd = sourceDir, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with status ${code}`));
    });
  });
}

function commandSucceeds(command, args, { cwd = sourceDir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function exists(candidate) {
  return fs.access(candidate).then(() => true, () => false);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePorts(value) {
  const ports = [...new Set(String(value).split(",").map(Number))];
  if (ports.length !== 2 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("Exactly two valid backend ports are required");
  }
  return ports;
}
