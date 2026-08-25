import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { deploymentOperationUnit } from "../lib/deployment-operation.mjs";
import { DEPLOYMENT_RECOVERY_RESERVE_MS } from "../lib/deployment-watchdog.mjs";
import { inspectOperationLock } from "../lib/operation-lock.mjs";
import { MAX_RELEASE_DRAIN_MS, ReleaseDrainStore } from "../lib/release-drain.mjs";

const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || path.dirname(path.dirname(new URL(import.meta.url).pathname)));
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const systemctlCommand = process.env.CODEX_DESKTOP_SYSTEMCTL || "systemctl";
const procRoot = path.resolve(process.env.CODEX_DESKTOP_WATCH_PROC_ROOT || "/proc");
const operationId = process.env.CODEX_DESKTOP_WATCH_OPERATION_ID || "";
const ownerPid = Number(process.env.CODEX_DESKTOP_WATCH_OWNER_PID);
const ownerStartTicks = process.env.CODEX_DESKTOP_WATCH_OWNER_START_TICKS || "";
const ownerUnit = process.env.CODEX_DESKTOP_WATCH_OWNER_UNIT || "";
const readyFile = path.resolve(process.env.CODEX_DESKTOP_WATCH_READY_FILE || "");
const token = process.env.CODEX_DESKTOP_WATCH_TOKEN || "";
const manifestFile = path.join(runtimeDirectory, "prepared-deployment.json");
const deploymentLockFile = path.join(runtimeDirectory, "deploy.lock");
const failureFile = path.join(runtimeDirectory, "deployment-recovery-failure.json");
const destructiveStates = new Set([
  "stopping-old",
  "old-stopped",
  "activating",
  "transferring-writer",
  "writer-transferred",
  "candidate-selected",
  "candidate-starting",
  "primary-ready",
  "gateway-confirmed",
  "retiring-old",
  "recovery-required",
  "activated",
]);
const drainStore = new ReleaseDrainStore(runtimeDirectory);
const OWNER_STATUS_TIMEOUT_MS = 500;
const OWNER_KILL_TIMEOUT_MS = 1_000;
const OWNER_TERMINATION_TIMEOUT_MS = 1_000;
const CODEX_RECOVERY_TIMEOUT_MS = 30_000;
const TOPOLOGY_RECOVERY_TIMEOUT_MS = 14_000;
const RECOVERY_FINISH_MARGIN_MS = 500;

try {
  await validateConfiguration();
  const watcherStartTicks = await readRealProcessStartTicks(process.pid);
  if (watcherStartTicks === null) throw new Error("Cannot identify the deployment watchdog process");
  await atomicWrite(readyFile, {
    schemaVersion: 1,
    token,
    operationId,
    ownerPid,
    ownerStartTicks,
    ownerUnit,
    watcherPid: process.pid,
    watcherStartTicks,
    readyAt: Date.now(),
  });
  await watch();
  await removeOwnedReadyFile();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}

async function watch() {
  let observedManifest = false;
  let monotonicDeadline = null;
  let committedDeadlines = null;
  let observedDrainToken = null;
  while (true) {
    const [ownerActive, manifest] = await Promise.all([
      verifiedOwnerIsActive(),
      readManifest(),
    ]);
    if (manifest && manifest.operationId !== operationId) {
      throw new Error("Deployment watchdog observed a manifest owned by another operation");
    }
    if (manifest && (
      ![3, 4].includes(manifest.schemaVersion)
      || manifest.watchToken !== token
      || manifest.ownerPid !== ownerPid
      || manifest.ownerStartTicks !== ownerStartTicks
      || (manifest.schemaVersion === 3 && manifest.activationMode !== "stop-first")
      || (manifest.schemaVersion === 4 && manifest.activationMode !== "standby-handoff")
      || !(manifest.forcedActivation === undefined || (
        manifest.forcedActivation === true
        && destructiveStates.has(manifest.stageState)
      ))
    )) {
      throw new Error("Deployment watchdog manifest identity does not match its verified owner");
    }
    const deploymentWorkerActive = manifest
      ? await verifiedDeploymentWorkerIsActive(manifest)
      : false;
    const deploymentLockActive = manifest
      ? await verifiedDeploymentLockIsActive()
      : false;
    const operationActive = ownerActive || deploymentWorkerActive || deploymentLockActive;
    if (manifest) observedManifest = true;
    if (observedManifest && !manifest) {
      if (observedDrainToken) await drainStore.clear(observedDrainToken).catch(() => {});
      return;
    }
    if (!manifest && !operationActive) return;

    if (manifest && !operationActive) {
      await recover(destructiveStates.has(manifest.stageState) ? manifest.drainDeadlineAt : null);
      return;
    }
    if (
      manifest
      && destructiveStates.has(manifest.stageState)
      && manifest.forcedActivation !== true
    ) {
      const recoveryDeadlineAt = Number(manifest.recoveryDeadlineAt);
      const drainDeadlineAt = Number(manifest.drainDeadlineAt);
      if (
        !Number.isSafeInteger(recoveryDeadlineAt)
        || recoveryDeadlineAt <= 0
        || !Number.isSafeInteger(drainDeadlineAt)
        || drainDeadlineAt <= recoveryDeadlineAt
        || drainDeadlineAt - recoveryDeadlineAt < DEPLOYMENT_RECOVERY_RESERVE_MS
        || drainDeadlineAt - recoveryDeadlineAt > MAX_RELEASE_DRAIN_MS
      ) {
        throw new Error("Committed deployment manifest has invalid recovery deadlines");
      }
      if (typeof manifest.drainToken !== "string" || manifest.drainToken.length < 16) {
        throw new Error("Committed deployment manifest has no drain identity");
      }
      if (
        committedDeadlines
        && (
          committedDeadlines.recoveryDeadlineAt !== recoveryDeadlineAt
          || committedDeadlines.drainDeadlineAt !== drainDeadlineAt
        )
      ) {
        throw new Error("Committed deployment deadlines changed after activation");
      }
      observedDrainToken = manifest.drainToken;
      if (monotonicDeadline === null) {
        const remainingDrainMs = drainDeadlineAt - Date.now();
        if (remainingDrainMs > MAX_RELEASE_DRAIN_MS + 500) {
          throw new Error("Deployment drain deadline exceeds the hard limit");
        }
        committedDeadlines = { recoveryDeadlineAt, drainDeadlineAt };
        monotonicDeadline = performance.now()
          + Math.max(0, Math.min(MAX_RELEASE_DRAIN_MS, recoveryDeadlineAt - Date.now()));
      }
      if (performance.now() >= monotonicDeadline) {
        await terminateOwner(drainDeadlineAt);
        await recover(drainDeadlineAt);
        return;
      }
    }
    await delay(100);
  }
}

async function terminateOwner(drainDeadlineAt) {
  if (!await verifiedOwnerIsActive()) return;
  if (deploymentOperationUnit(operationId) !== ownerUnit) throw new Error("Deployment owner unit identity changed");
  const processState = await processFingerprintState(ownerPid, ownerStartTicks);
  if (processState === "active" && !await processBelongsToUnit(ownerPid, ownerUnit)) {
    throw new Error("Deployment owner process is not in the verified systemd unit cgroup");
  }
  const active = await systemdUnitIsActive(ownerUnit, OWNER_STATUS_TIMEOUT_MS);
  if (!active) throw new Error("Deployment owner unit is not active at deadline takeover");
  const takeoverDeadline = Number.isSafeInteger(drainDeadlineAt)
    ? drainDeadlineAt - TOPOLOGY_RECOVERY_TIMEOUT_MS - RECOVERY_FINISH_MARGIN_MS
    : Date.now() + OWNER_STATUS_TIMEOUT_MS + OWNER_KILL_TIMEOUT_MS + OWNER_TERMINATION_TIMEOUT_MS;
  const killed = await run(
    systemctlCommand,
    ["kill", "--kill-who=all", "--signal=SIGKILL", ownerUnit],
    { allowFailure: true, timeoutMs: boundedRemaining(takeoverDeadline, OWNER_KILL_TIMEOUT_MS) },
  );
  if (!killed) throw new Error("Could not terminate the verified deployment owner unit");
  const deadline = Math.min(Date.now() + OWNER_TERMINATION_TIMEOUT_MS, takeoverDeadline);
  while (Date.now() < deadline) {
    const [processActive, unitActive] = await Promise.all([
      verifiedOwnerIsActive(),
      systemdUnitIsActive(ownerUnit, OWNER_STATUS_TIMEOUT_MS),
    ]);
    if (!processActive && !unitActive) return;
    await delay(50);
  }
  throw new Error("Timed out terminating the stuck deployment owner");
}

async function recover(drainDeadlineAt = null) {
  const errors = [];
  try {
    await run(process.execPath, [
      path.join(sourceDirectory, "scripts", "recover-codex-update.mjs"),
    ], {
      timeoutMs: CODEX_RECOVERY_TIMEOUT_MS,
    });
  } catch (error) {
    errors.push(`codex: ${error.message}`);
  }
  const beforeDrainDeadline = Number.isSafeInteger(Number(drainDeadlineAt))
    && Number(drainDeadlineAt) - Date.now() > RECOVERY_FINISH_MARGIN_MS;
  const timeoutMs = beforeDrainDeadline
    ? boundedRemaining(Number(drainDeadlineAt) - RECOVERY_FINISH_MARGIN_MS, TOPOLOGY_RECOVERY_TIMEOUT_MS)
    : TOPOLOGY_RECOVERY_TIMEOUT_MS;
  try {
    await run(process.execPath, [
      path.join(sourceDirectory, "scripts", "deploy.mjs"),
      "--recover-staged",
      "--operation-id",
      operationId,
    ], {
      timeoutMs,
      environment: {
        ...process.env,
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: token,
      },
    });
  } catch (error) {
    errors.push(`topology: ${error.message}`);
  }
  if (errors.length > 0) {
    await atomicWrite(failureFile, {
      schemaVersion: 1,
      status: "failed",
      failedAt: Date.now(),
      errors: errors.map((message) => ({
        stage: message.startsWith("codex:") ? "codex" : "topology",
        message: message.replace(/^(?:codex|topology):\s*/, ""),
      })),
    });
    throw new Error(errors.join("; "));
  }
  await fs.rm(failureFile, { force: true });
}

async function readManifest() {
  try {
    const stat = await fs.lstat(manifestFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) {
      throw new Error("Deployment manifest has an unsafe file type or size");
    }
    return JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function processFingerprintState(pid, expectedStartTicks) {
  try {
    const stat = await fs.readFile(path.join(procRoot, String(pid), "stat"), "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) throw new Error("Invalid process identity");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return "inactive";
    return fields[19] === expectedStartTicks ? "active" : "inactive";
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return "inactive";
    return "unknown";
  }
}

async function readRealProcessStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) throw new Error("Invalid process identity");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    return /^\d+$/.test(fields[19] || "") ? fields[19] : null;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

async function readProcessStartTicksFromRoot(pid) {
  try {
    const stat = await fs.readFile(path.join(procRoot, String(pid), "stat"), "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    return /^\d+$/.test(fields[19] || "") ? fields[19] : undefined;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    return undefined;
  }
}

async function readProcessArgumentsFromRoot(pid) {
  try {
    const stat = await fs.readFile(path.join(procRoot, String(pid), "stat"), "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    const commandLine = await fs.readFile(path.join(procRoot, String(pid), "cmdline"), "utf8");
    return commandLine.split("\0").filter(Boolean);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    return undefined;
  }
}

async function verifiedOwnerIsActive() {
  const processState = await processFingerprintState(ownerPid, ownerStartTicks);
  if (processState === "active") return true;
  const unitState = await systemdUnitState(ownerUnit, OWNER_STATUS_TIMEOUT_MS);
  if (unitState === "active") return true;
  if (unitState === "inactive") return false;
  throw new Error("Deployment watchdog cannot verify its owner state");
}

async function verifiedDeploymentWorkerIsActive(manifest) {
  if (manifest.schemaVersion < 4) return false;
  if (manifest.deploymentWorkerPid === undefined && manifest.deploymentWorkerStartTicks === undefined) {
    // Schema 4 manifests written by an older release did not persist the
    // child fingerprint.  The deploy recovery guard still checks their lock;
    // new manifests always take this stronger process-level path.
    return false;
  }
  if (
    !Number.isSafeInteger(manifest.deploymentWorkerPid)
    || manifest.deploymentWorkerPid <= 1
    || !/^\d+$/.test(manifest.deploymentWorkerStartTicks || "")
  ) {
    throw new Error("Deployment watchdog manifest has no valid deployment worker identity");
  }
  const state = await processFingerprintState(
    manifest.deploymentWorkerPid,
    manifest.deploymentWorkerStartTicks,
  );
  if (state === "unknown") throw new Error("Deployment watchdog cannot verify its deployment worker state");
  return state === "active";
}

async function verifiedDeploymentLockIsActive() {
  const observed = await inspectOperationLock(deploymentLockFile, {
    ownerCommand: "scripts/deploy.mjs",
    acceptedCommands: ["scripts/deploy.mjs"],
    expectedOperationId: operationId,
    readProcessStartTicks: (pid) => readProcessStartTicksFromRoot(pid),
    readProcessArguments: (pid) => readProcessArgumentsFromRoot(pid),
  });
  if (!observed.identity) return false;
  if (
    observed.record
    && observed.record.legacy !== true
    && observed.record.operationId
    && observed.record.operationId !== operationId
  ) {
    throw new Error("Deployment watchdog observed a lock owned by another operation");
  }
  if (
    observed.state === "active"
    && observed.record?.handoffToken
    && observed.record.handoffToken !== token
  ) {
    throw new Error("Deployment watchdog lock handoff token does not match its operation");
  }
  if (observed.state === "unknown") {
    throw new Error("Deployment watchdog cannot verify its deployment lock state");
  }
  return observed.state === "active";
}

async function processBelongsToUnit(pid, unit) {
  const value = await fs.readFile(path.join(procRoot, String(pid), "cgroup"), "utf8");
  return value.split(/\r?\n/).some((line) => {
    const cgroupPath = line.split(":", 3)[2] || "";
    return cgroupPath.split("/").includes(unit);
  });
}

async function systemdUnitIsActive(unit, timeoutMs = OWNER_STATUS_TIMEOUT_MS) {
  return await systemdUnitState(unit, timeoutMs) === "active";
}

async function systemdUnitState(unit, timeoutMs = OWNER_STATUS_TIMEOUT_MS) {
  const result = await capture(systemctlCommand, ["is-active", unit], { timeoutMs });
  const state = result.stdout.trim();
  if (result.code === 0 && ["active", "activating", "reloading", "deactivating"].includes(state)) {
    return "active";
  }
  if ([3, 4].includes(result.code) && ["inactive", "failed", "unknown"].includes(state)) {
    return "inactive";
  }
  return "unknown";
}

async function atomicWrite(destination, value) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

async function removeOwnedReadyFile() {
  try {
    const current = JSON.parse(await fs.readFile(readyFile, "utf8"));
    if (current?.token === token) await fs.rm(readyFile, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function run(command, args, {
  allowFailure = false,
  timeoutMs = 10_000,
  environment = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sourceDirectory, env: environment, stdio: "inherit" });
    let settled = false;
    let timedOut = false;
    let forceFinishTimer = null;
    const timeoutError = new Error(`${command} timed out after ${timeoutMs}ms`);
    const finish = (error, value = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGKILL");
      // Wait for close so a killed deploy worker has been reaped before a
      // second recovery worker is allowed to inspect its operation lock.
      forceFinishTimer = setTimeout(() => finish(allowFailure ? null : timeoutError, false), 1_000);
      forceFinishTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      if (timedOut) finish(allowFailure ? null : timeoutError, false);
      else if (allowFailure) finish(null, false);
      else finish(error);
    });
    child.on("close", (code) => {
      if (timedOut) finish(allowFailure ? null : timeoutError, false);
      else if (code === 0 || allowFailure) finish(null, code === 0);
      else finish(new Error(`${command} exited with status ${code}`));
    });
  });
}

function capture(command, args, { timeoutMs = 3_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: sourceDirectory, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_024) stdout += chunk;
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: "" });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

async function validateConfiguration() {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(operationId)) {
    throw new Error("Invalid deployment watchdog operation ID");
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !/^\d+$/.test(ownerStartTicks)) {
    throw new Error("Invalid deployment watchdog owner fingerprint");
  }
  if (!token || !path.isAbsolute(readyFile) || !pathIsInside(runtimeDirectory, readyFile)) {
    throw new Error("Invalid deployment watchdog handshake configuration");
  }
  if (deploymentOperationUnit(operationId) !== ownerUnit) {
    throw new Error("Invalid deployment watchdog owner unit");
  }
  const processState = await processFingerprintState(ownerPid, ownerStartTicks);
  if (processState === "active") {
    if (!await processBelongsToUnit(ownerPid, ownerUnit)) {
      throw new Error("Deployment watchdog owner cgroup does not match its unit");
    }
    if (!await systemdUnitIsActive(ownerUnit, OWNER_STATUS_TIMEOUT_MS)) {
      throw new Error("Deployment watchdog owner unit is not active");
    }
  } else if (processState === "unknown" && await systemdUnitState(ownerUnit) === "unknown") {
    throw new Error("Deployment watchdog cannot verify its owner during startup");
  }
}

function boundedRemaining(deadline, maximum) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error("Deployment recovery takeover exhausted its hard deadline");
  return Math.max(1, Math.min(maximum, remaining));
}

function pathIsInside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
