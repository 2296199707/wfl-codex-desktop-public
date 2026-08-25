import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { BackendAuthorityStore } from "../lib/backend-authority.mjs";
import { deploymentOperationUnit } from "../lib/deployment-operation.mjs";
import { reconcileDeploymentRecoveryStatus } from "../lib/deployment-recovery-status.mjs";
import { DEPLOYMENT_RECOVERY_RESERVE_MS } from "../lib/deployment-watchdog.mjs";
import {
  acquireOperationLock,
  inspectOperationLock,
  reclaimOperationLockForRecovery,
  RELEASE_LOCK_ACCEPTED_COMMANDS,
} from "../lib/operation-lock.mjs";
import { MAX_RELEASE_DRAIN_MS, ReleaseDrainStore } from "../lib/release-drain.mjs";
import {
  CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS,
  CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
  IMAGE_EXECUTION_PACKAGE_ASSETS,
  IMAGE_EXECUTION_PACKAGE_CAPABILITY,
  MAP_EDITOR_PACKAGE_ASSETS,
  MAP_EDITOR_PACKAGE_CAPABILITY,
  MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS,
} from "../lib/package-source.mjs";
import { assertReleaseVersionMetadata } from "../lib/release-version-metadata.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDir = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(projectDir, ".codex-desktop"),
);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  validateDeployArguments({ help: true });
  console.log([
    "Usage: node scripts/deploy.mjs [--prepare-only] [--version VERSION]",
    "       node scripts/deploy.mjs --preflight [--version VERSION]",
    "       node scripts/deploy.mjs --stage --operation-id ID [--version VERSION]",
    "       node scripts/deploy.mjs --activate-staged --operation-id ID [--defer-finalize]",
    "       node scripts/deploy.mjs --discard-staged --operation-id ID",
    "       node scripts/deploy.mjs --recover-staged [--operation-id ID]",
    "       node scripts/deploy.mjs --finalize-staged --operation-id ID",
  ].join("\n"));
  process.exit(0);
}
validateDeployArguments();

const runtimeDir = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"),
);
const releasesDir = path.join(runtimeDir, "releases");
const slotsDir = path.join(runtimeDir, "slots");
const backupDir = path.resolve(
  process.env.CODEX_DESKTOP_BACKUP_DIR || path.join(projectDir, "backups"),
);
const activePortFile = path.join(runtimeDir, "active-port");
const deploymentLock = path.join(runtimeDir, "deploy.lock");
const deploymentRecoveryLock = path.join(runtimeDir, "deployment-recovery.lock");
const preparedDeploymentFile = path.join(runtimeDir, "prepared-deployment.json");
const backendHost = process.env.CODEX_DESKTOP_UPSTREAM_HOST || "127.0.0.1";
const gatewayPort = Number(process.env.CODEX_DESKTOP_GATEWAY_PORT || 4317);
const backendPorts = parsePorts(process.env.CODEX_DESKTOP_UPSTREAM_PORTS || "4318,4319");
const systemctl = process.env.CODEX_DESKTOP_SYSTEMCTL || "systemctl";
const readinessTimeoutMs = Number(process.env.CODEX_DESKTOP_READY_TIMEOUT_MS || 180_000);
const activationReadyTimeoutMs = boundedDuration(
  process.env.CODEX_DESKTOP_ACTIVATION_READY_TIMEOUT_MS || 12_000,
  "activation readiness timeout",
  { min: 500, max: 15_000 },
);
const activationGatewayTimeoutMs = boundedDuration(
  process.env.CODEX_DESKTOP_ACTIVATION_GATEWAY_TIMEOUT_MS || 5_000,
  "activation gateway timeout",
  { min: 500, max: 10_000 },
);
const systemctlTimeoutMs = boundedDuration(
  process.env.CODEX_DESKTOP_SYSTEMCTL_TIMEOUT_MS || 10_000,
  "systemctl timeout",
  { min: 500, max: 30_000 },
);
const MAX_DRAIN_DEADLINE_FUTURE_MS = MAX_RELEASE_DRAIN_MS;
const DRAIN_RECOVERY_MARGIN_MS = 1_000;
const DRAIN_COMPLETION_RESERVE_MS = DEPLOYMENT_RECOVERY_RESERVE_MS;
// The backend settles one Codex Turn for up to 15 seconds during auth handoff.
// Keep one second for the HTTP response and journal flush; the old 5-second
// client timeout could abort a healthy handoff before writer transfer.
const AUTH_HANDOFF_REQUEST_BUDGET_MS = 16_000;
const ACTIVATION_JOURNAL_BUDGET_MS = 3_000;
const RECOVERY_SYSTEMCTL_TIMEOUT_MS = 1_500;
// Codex thread-list recovery can legitimately take longer than the short
// activation RPC. Use the same bounded deep-readiness window for rollback and
// recovery, otherwise a healthy old backend is reported as failed mid-handoff.
const RECOVERY_READY_TIMEOUT_MS = Number.isFinite(readinessTimeoutMs)
  ? Math.min(Math.max(readinessTimeoutMs, 30_000), 180_000)
  : 180_000;
const RECOVERY_GATEWAY_TIMEOUT_MS = 3_000;
const RECOVERY_GATE_TIMEOUT_MS = 95_000;
const RECOVERY_LOCK_WAIT_MS = 15_000;
const prepareOnly = process.argv.includes("--prepare-only");
const preflightOnly = process.argv.includes("--preflight");
const stageOnly = process.argv.includes("--stage");
const activateStaged = process.argv.includes("--activate-staged");
const discardStaged = process.argv.includes("--discard-staged");
const recoverStaged = process.argv.includes("--recover-staged");
const finalizeStaged = process.argv.includes("--finalize-staged");
const deferFinalize = process.argv.includes("--defer-finalize");
let operationId = optionValue("--operation-id");
const requestedVersion = optionValue("--version");
const version = requestedVersion || (await fs.readFile(path.join(projectDir, "VERSION"), "utf8")).trim();
const candidateSourceCommit = validGitHash(process.env.CODEX_DESKTOP_CANDIDATE_COMMIT)
  ? process.env.CODEX_DESKTOP_CANDIDATE_COMMIT.toLowerCase()
  : null;
const cancelStore = new DeploymentCancelStore(runtimeDir);
const drainStore = new ReleaseDrainStore(runtimeDir);
const backendAuthorityStore = new BackendAuthorityStore(runtimeDir);
const deploymentLockOptions = {
  ownerCommand: "scripts/deploy.mjs",
  acceptedCommands: ["scripts/deploy.mjs"],
  conflictMessage: "Another deployment is already running",
};

if (!validVersion(version)) {
  throw new Error(`Invalid release version: ${version}`);
}
if ([prepareOnly, preflightOnly, stageOnly, activateStaged, discardStaged, recoverStaged, finalizeStaged].filter(Boolean).length > 1) {
  throw new Error("Choose only one deployment mode");
}
if (deferFinalize && !activateStaged) {
  throw new Error("--defer-finalize requires --activate-staged");
}
if ((stageOnly || activateStaged || discardStaged || finalizeStaged) && !validOperationId(operationId)) {
  throw new Error("Staged deployment operations require a valid --operation-id");
}

await fs.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
if (recoverStaged && !operationId) {
  const identity = await readPreparedDeploymentHeader();
  operationId = identity?.operationId || null;
}
let lock = null;
let recoveryGuard = null;
let stagingDirectory;

try {
  recoveryGuard = recoverStaged ? await prepareRecoveryGuard() : null;
  if (recoveryGuard?.deferred) {
    console.log(recoveryGuard.message);
  } else {
    lock = await acquireOperationLock(deploymentLock, {
      ...deploymentLockOptions,
      operationId,
      handoffToken: validWatchToken(process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN)
        ? process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN
        : null,
      ...(recoverStaged ? { acquireWaitMs: RECOVERY_LOCK_WAIT_MS } : {}),
    });
    await Promise.all([
      fs.mkdir(releasesDir, { recursive: true, mode: 0o755 }),
      fs.mkdir(slotsDir, { recursive: true, mode: 0o755 }),
    ]);
    if (preflightOnly) {
      await assertDeploymentPreflight();
    } else if (recoverStaged) {
      await runPreparedDeploymentRecovery();
    } else if (discardStaged) {
      await discardPreparedDeployment();
    } else if (finalizeStaged) {
      await finalizePreparedDeployment();
    } else if (activateStaged) {
      await activatePreparedDeployment();
    } else {
      await assertNoPreparedDeployment();
      const releaseDirectory = await prepareRelease(version);
      const requiresCodexRuntimeBundle = await releaseRequiresCodexRuntimeBundle(releaseDirectory);
      const activePort = await readActivePort({ allowMissing: true });
      const candidatePort = activePort === null ? backendPorts[0] : backendPorts.find((port) => port !== activePort);
      const slotPath = path.join(slotsDir, String(candidatePort));
      const previousSlotTarget = await readLink(slotPath);

      if (stageOnly) {
        if (activePort === null) throw new Error("Staged deployment requires an active backend");
        await stageCandidate({
          activePort,
          candidatePort,
          previousSlotTarget,
          releaseDirectory,
          slotPath,
          requiresCodexRuntimeBundle,
        });
      } else {
        await replaceSymlink(slotPath, releaseDirectory);
        if (prepareOnly) {
          console.log(`Prepared v${version} in backend slot ${candidatePort}.`);
          process.exitCode = 0;
        } else {
          await deployCandidate({
            activePort,
            candidatePort,
            previousSlotTarget,
            slotPath,
            requiresCodexRuntimeBundle,
          });
        }
      }
    }
  }
} finally {
  if (stagingDirectory) await fs.rm(stagingDirectory, { recursive: true, force: true });
  await lock?.release();
  await recoveryGuard?.lock?.release();
}

async function assertDeploymentPreflight() {
  if (await exists(preparedDeploymentFile)) {
    throw new Error("Deployment preflight found an unfinished staged deployment");
  }
  const releaseDirectory = await resolveReusableRelease(version);
  const activePort = await readActivePort();
  if (activePort === null) throw new Error("Deployment preflight requires an active backend");
  const activeTarget = await fs.realpath(path.join(slotsDir, String(activePort)));
  if (activeTarget !== releaseDirectory) {
    throw new Error("Deployment preflight release is not selected by the active backend");
  }
  await waitForGateway(activePort, 5_000);
  console.log(`Deployment preflight passed for v${version} on backend ${activePort}.`);
}

async function prepareRecoveryGuard() {
  if (!await exists(preparedDeploymentFile)) return null;
  const prepared = await readPreparedDeployment();
  const sameOperation = validOperationId(operationId) && prepared.operationId === operationId;
  const trustedWatchdog = sameOperation
    && prepared.schemaVersion >= 3
    && validWatchToken(process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN)
    && prepared.watchToken === process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN;
  if (trustedWatchdog) {
    await assertPreparedDeploymentWatchdogAttestation(prepared, { requireActive: false });
  }
  const ownerState = await preparedDeploymentOwnerState(prepared);
  if (
    sameOperation
    && prepared.schemaVersion >= 3
    && validWatchToken(process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN)
    && prepared.watchToken !== process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN
    && ownerState !== "unknown"
  ) {
    throw new Error("The active staged deployment recovery watchdog identity does not match");
  }
  if (ownerState === "active") {
    if (trustedWatchdog && await verifiedRecoveryOwnerExited(prepared)) {
      // The watchdog has already fenced the original systemd operation.  The
      // operation lock may still contain the killed deploy child, so the
      // recovery worker is allowed to use the explicit takeover path below.
    } else if (process.env.CODEX_DESKTOP_RECOVERY_DEFER_IF_ACTIVE === "1") {
      return {
        deferred: true,
        message: "The staged deployment is still owned by its live release worker; recovery is deferred.",
      };
    } else {
      throw new Error("The staged deployment is still owned by an active maintenance operation");
    }
  } else if (ownerState === "unknown" && trustedWatchdog) {
    if (!await verifiedRecoveryOwnerExited(prepared)) {
      throw new Error("Cannot safely take over the staged deployment while its owner state is unknown");
    }
  }

  const recoveryOperationId = prepared.operationId;
  try {
    const lock = await acquireOperationLock(deploymentRecoveryLock, {
      ownerCommand: "scripts/deploy.mjs",
      acceptedCommands: ["scripts/deploy.mjs"],
      operationId: recoveryOperationId,
      conflictMessage: "Another deployment recovery is already running",
      acquireWaitMs: Math.min(500, RECOVERY_LOCK_WAIT_MS),
    });
    try {
      if (trustedWatchdog) {
        await reclaimDeploymentLockForRecovery(prepared);
      }
      return { lock };
    } catch (error) {
      await lock.release().catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error.code !== "ERR_OPERATION_LOCKED") throw error;
    const observed = await inspectOperationLock(deploymentRecoveryLock, {
      ownerCommand: "scripts/deploy.mjs",
      acceptedCommands: ["scripts/deploy.mjs"],
      expectedOperationId: recoveryOperationId,
    });
    if (observed.state === "active" && observed.record?.operationId === recoveryOperationId) {
      return {
        deferred: true,
        message: `Deployment recovery for ${recoveryOperationId} is already being handled by another worker.`,
      };
    }
    throw error;
  }
}

async function reclaimDeploymentLockForRecovery(prepared) {
  const observed = await inspectOperationLock(deploymentLock, deploymentLockOptions);
  if (!observed.identity) return false;
  if (observed.record?.operationId !== prepared.operationId) {
    throw new Error("Deployment recovery found a lock owned by another operation");
  }
  const reclaimed = await reclaimOperationLockForRecovery(deploymentLock, {
    ownerCommand: deploymentLockOptions.ownerCommand,
    acceptedCommands: deploymentLockOptions.acceptedCommands,
    conflictMessage: deploymentLockOptions.conflictMessage,
    expectedOperationId: prepared.operationId,
    recoveryToken: prepared.watchToken,
    verifyOwnerExit: async ({ record }) => {
      // The staged, activation, and finalization commands are separate
      // deploy workers.  The operation-scoped watchdog token is the durable
      // handoff identity; the manifest worker fingerprint is only a liveness
      // hint and may legitimately refer to the preceding phase after a crash.
      if (
        !record
        || record.operationId !== prepared.operationId
        || record.handoffToken !== prepared.watchToken
      ) return false;
      const currentStartTicks = await readProcessStartTicks(record.pid);
      return currentStartTicks === null
        || (currentStartTicks !== undefined && currentStartTicks !== record.startTicks);
    },
  }).catch((error) => {
    if (error.code === "ERR_OPERATION_LOCKED") throw error;
    throw new Error(`Deployment recovery could not take over the stale deployment lock: ${error.message}`);
  });
  if (reclaimed) return true;

  const latest = await inspectOperationLock(deploymentLock, deploymentLockOptions);
  if (
    latest.identity
    && latest.record?.operationId === prepared.operationId
    && latest.state !== "inactive"
  ) {
    throw new Error("Deployment recovery could not prove that the staged deployment worker exited");
  }
  return false;
}

async function runPreparedDeploymentRecovery() {
  let prepared = null;
  try {
    if (!await exists(preparedDeploymentFile)) {
      console.log("No interrupted deployment requires recovery.");
      return;
    }
    prepared = await readPreparedDeployment();
    const recoveryOwner = lock?.record && lock.record.pid === process.pid
      ? { pid: lock.record.pid, startTicks: lock.record.startTicks }
      : null;
    const outcome = await recoverPreparedDeployment(prepared, { recoveryOwner });
    if (outcome) {
      await reconcileDeploymentRecoveryStatus({
        stateDirectory: stateDir,
        operationId: outcome.operationId || prepared.operationId,
        version: outcome.version || prepared.version,
        outcome: outcome.outcome,
        selectedPort: outcome.selectedPort,
        detail: outcome.detail,
      });
    }
  } catch (error) {
    const identity = prepared || await readPreparedDeploymentHeader().catch(() => null);
    if (identity?.operationId) {
      await reconcileDeploymentRecoveryStatus({
        stateDirectory: stateDir,
        operationId: identity.operationId,
        version: identity.version,
        outcome: "failed",
        error: error.message,
        detail: "中断部署恢复失败，已保留恢复清单等待下一次接管",
      }).catch(() => {});
    }
    throw error;
  }
}

async function verifyBackendRecoveryGates() {
  for (const unit of [
    "wfl-codex-desktop-restore-recovery.service",
    "wfl-codex-desktop-codex-recovery.service",
  ]) {
    await run(systemctl, ["start", unit], { timeoutMs: RECOVERY_GATE_TIMEOUT_MS });
  }
}

async function stageCandidate({
  activePort,
  candidatePort,
  previousSlotTarget,
  releaseDirectory,
  slotPath,
  requiresCodexRuntimeBundle,
}) {
  const candidateUnit = `wfl-codex-desktop-backend@${candidatePort}.service`;
  const owner = await deploymentOwnerFingerprint();
  const deploymentWorkerStartTicks = await readProcessStartTicks(process.pid);
  if (!/^\d+$/.test(deploymentWorkerStartTicks || "")) {
    throw new Error("Cannot identify the deployment worker that owns the staged deployment");
  }
  const prepared = {
    schemaVersion: 4,
    stageState: "preparing",
    operationId,
    ownerPid: owner.pid,
    ownerStartTicks: owner.startTicks,
    deploymentWorkerPid: process.pid,
    deploymentWorkerStartTicks,
    version,
    releaseDirectory,
    activePort,
    candidatePort,
    watchToken: deploymentWatchToken(),
    activationMode: "standby-handoff",
    previousSlotTarget,
    preparedAt: Date.now(),
  };
  let slotUpdated = false;
  try {
    await verifyBackendRecoveryGates();
    await waitForGateway(activePort, 5_000);
    await writePreparedDeployment(prepared);
    await run(systemctl, ["stop", candidateUnit]);
    await run(systemctl, ["disable", candidateUnit]);
    await replaceSymlink(slotPath, releaseDirectory);
    slotUpdated = true;
    await run(systemctl, ["start", candidateUnit], { timeoutMs: systemctlTimeoutMs });
    const standby = await waitForStandby(
      candidatePort,
      version,
      readinessTimeoutMs,
      { requireCodexRuntimeBundle: requiresCodexRuntimeBundle },
    );
    const oldBackend = await inspectBackendIdentity(activePort).catch(() => null);
    const writerAuthority = await backendAuthorityStore.read();
    await writePreparedDeployment({
      ...prepared,
      stageState: "ready",
      candidateBackendInstanceId: standby.backendInstanceId,
      oldBackendInstanceId: oldBackend?.backendInstanceId || null,
      previousWriterEpoch: writerAuthority?.writerEpoch || null,
      stagedAt: Date.now(),
    });
    console.log(
      `Prepared v${version} as standby backend ${candidatePort}; active backend ${activePort} was not changed.`,
    );
  } catch (error) {
    await run(systemctl, ["stop", candidateUnit], { allowFailure: true });
    await run(systemctl, ["disable", candidateUnit], { allowFailure: true });
    if (slotUpdated) await restoreSymlink(slotPath, previousSlotTarget).catch(() => {});
    await removePreparedDeployment({ force: true }).catch(() => {});
    throw new Error(`Candidate staging aborted; the active backend was not changed: ${error.message}`);
  }
}

async function activatePreparedDeployment() {
  let prepared = await readPreparedDeployment();
  if (prepared.operationId !== operationId) throw new Error("Prepared deployment belongs to another operation");
  if (prepared.version !== version) throw new Error(`Prepared deployment is v${prepared.version}, expected v${version}`);
  if (prepared.stageState !== "ready") throw new Error("Prepared deployment is not ready for activation");
  if (prepared.schemaVersion >= 3 && prepared.watchToken !== deploymentWatchToken()) {
    throw new Error("Prepared deployment watchdog identity changed before activation");
  }
  const activePort = await readActivePort();
  if (activePort !== prepared.activePort) throw new Error("Active backend changed after candidate staging");
  const expectedCandidate = backendPorts.find((port) => port !== activePort);
  if (prepared.candidatePort !== expectedCandidate) throw new Error("Prepared candidate port is no longer valid");

  const slotPath = path.join(slotsDir, String(prepared.candidatePort));
  const releaseDirectory = preparedReleaseDirectory(prepared);
  const { packageManifest } = await verifyReleaseDirectory(releaseDirectory, version);
  await fs.access(path.join(releaseDirectory, "node_modules"));
  const slotTarget = await readLink(slotPath);
  if (resolveLink(slotPath, slotTarget) !== releaseDirectory) {
    throw new Error("Prepared candidate slot no longer selects the verified release");
  }
  await assertPreparedDeploymentWatchdogActive(prepared);
  // The staged worker and the activation worker are separate processes.  The
  // manifest must follow that ownership transition before any destructive
  // activation step, otherwise the watchdog can mistake a live activation
  // worker for the already-exited staging worker and start recovery early.
  prepared = await claimPreparedDeploymentWorker(prepared);
  const forceActivation = process.env.CODEX_DESKTOP_FORCE_ACTIVATION === "1";
  if (
    process.env.CODEX_DESKTOP_LEGACY_EXCLUSIVE_ACTIVATION === "1"
    && process.env.CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED !== "1"
  ) {
    throw new Error(
      "Exclusive legacy activation requires explicit CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED=1 confirmation",
    );
  }

  let activationRecord = prepared;
  const persistActivationState = async (update) => {
    activationRecord = { ...activationRecord, ...update };
    await writePreparedDeployment(activationRecord);
  };
  try {
    await deployCandidate({
      activePort,
      candidatePort: prepared.candidatePort,
      previousSlotTarget: prepared.previousSlotTarget,
      slotPath,
      activationMode: prepared.activationMode,
      candidateBackendInstanceId: prepared.candidateBackendInstanceId,
      oldBackendInstanceId: prepared.oldBackendInstanceId,
      previousWriterEpoch: prepared.previousWriterEpoch,
      requiresCodexRuntimeBundle: packageManifest.capabilities?.includes(
        CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
      ) === true,
      fenceDrain: !forceActivation,
      forceActivation,
      onActivationState: persistActivationState,
      onSwitched: deferFinalize
        ? () => persistActivationState({
          stageState: "activated",
          ...(forceActivation ? { forcedActivation: true } : {}),
          activatedAt: Date.now(),
        })
        : () => finalizeDeploymentManifest(process.env.CODEX_DESKTOP_DRAIN_TOKEN),
    });
  } catch (error) {
    if (error.preservePreparedDeployment) {
      await writePreparedDeployment({
        ...activationRecord,
        stageState: "recovery-required",
        ...(forceActivation
          ? { forcedActivation: true }
          : {
            ...activationDeadlines(),
            drainToken: process.env.CODEX_DESKTOP_DRAIN_TOKEN,
          }),
        recoveryRequiredAt: Date.now(),
      }).catch(() => {});
    } else {
      await removePreparedDeployment({ force: true }).catch(() => {});
    }
    throw error;
  }
}

async function finalizePreparedDeployment() {
  let prepared = await readPreparedDeployment();
  if (prepared.operationId !== operationId) throw new Error("Prepared deployment belongs to another operation");
  if (prepared.version !== version) throw new Error(`Prepared deployment is v${prepared.version}, expected v${version}`);
  if (![3, 4].includes(prepared.schemaVersion) || prepared.stageState !== "activated") {
    throw new Error("Prepared deployment has not completed deferred activation");
  }
  if (prepared.watchToken !== deploymentWatchToken()) {
    throw new Error("Prepared deployment watchdog identity changed before finalization");
  }
  const owner = await deploymentOwnerFingerprint();
  if (owner.pid !== prepared.ownerPid || owner.startTicks !== prepared.ownerStartTicks) {
    throw new Error("Only the verified deployment owner can finalize activation");
  }
  prepared = await claimPreparedDeploymentWorker(prepared);
  const activePort = await readActivePort();
  if (activePort !== prepared.candidatePort) {
    throw new Error("Cannot finalize activation because the candidate backend is not selected");
  }
  const slotPath = path.join(slotsDir, String(prepared.candidatePort));
  const releaseDirectory = preparedReleaseDirectory(prepared);
  if (resolveLink(slotPath, await readLink(slotPath)) !== releaseDirectory) {
    throw new Error("Cannot finalize activation because the candidate slot changed");
  }
  await verifyReleaseDirectory(releaseDirectory, version);
  await waitForCandidate(prepared.candidatePort, version, RECOVERY_READY_TIMEOUT_MS);
  await waitForGateway(prepared.candidatePort, RECOVERY_GATEWAY_TIMEOUT_MS);
  await finalizeDeploymentManifest(prepared.drainToken);
  console.log(`Finalized deferred deployment of v${version} on backend ${prepared.candidatePort}.`);
}

async function finalizeDeploymentManifest(drainToken) {
  await removePreparedDeployment();
  if (validDrainToken(drainToken)) await drainStore.clear(drainToken).catch(() => {});
}

async function discardPreparedDeployment() {
  let prepared;
  try {
    prepared = await readPreparedDeployment();
  } catch (error) {
    if (error.message === "No staged deployment is available") {
      console.log("No staged deployment is available; cleanup is already complete.");
      return;
    }
    throw error;
  }
  if (prepared.operationId !== operationId) throw new Error("Prepared deployment belongs to another operation");
  if (prepared.version !== version) throw new Error(`Prepared deployment is v${prepared.version}, expected v${version}`);
  if (destructiveDeploymentState(prepared.stageState) || prepared.stageState === "recovery-required") {
    throw new Error("A committed deployment requiring recovery cannot be discarded automatically");
  }
  if (await cancelStore.getDecision(operationId) === "commit") {
    throw new Error("A deployment cannot be discarded after activation was committed");
  }
  const activePort = await readActivePort();
  if (activePort !== prepared.activePort) throw new Error("Cannot discard a candidate after the active backend changed");

  const candidateUnit = `wfl-codex-desktop-backend@${prepared.candidatePort}.service`;
  const slotPath = path.join(slotsDir, String(prepared.candidatePort));
  await run(systemctl, ["stop", candidateUnit], { allowFailure: true });
  await run(systemctl, ["disable", candidateUnit], { allowFailure: true });
  await restoreSymlink(slotPath, prepared.previousSlotTarget);
  await removePreparedDeployment();
  console.log(`Discarded staged v${prepared.version} from backend ${prepared.candidatePort}.`);
}

async function deployCandidate(options) {
  if (options.activationMode === "stop-first") return deployLegacyCandidate(options);
  return deployStandbyCandidate(options);
}

async function deployStandbyCandidate({
  activePort,
  candidatePort,
  previousSlotTarget,
  slotPath,
  fenceDrain = false,
  forceActivation = false,
  candidateBackendInstanceId = null,
  oldBackendInstanceId = null,
  previousWriterEpoch = null,
  requiresCodexRuntimeBundle = false,
  onActivationState = null,
  onSwitched = null,
}) {
  const candidateUnit = `wfl-codex-desktop-backend@${candidatePort}.service`;
  const oldUnit = activePort === null ? null : `wfl-codex-desktop-backend@${activePort}.service`;
  let writerTransferred = false;
  let candidateSelected = false;
  let candidatePrimary = false;
  let gatewayConfirmed = false;
  let oldRetired = false;
  let authHandoffPrepared = false;
  let activationRecord = {};
  const persist = async (stageState, update = {}) => {
    activationRecord = { ...activationRecord, ...update, stageState, activationMode: "standby-handoff" };
    if (onActivationState) await onActivationState(activationRecord);
  };

  try {
    if (activePort !== null && (fenceDrain || forceActivation)) {
      await assertIndependentActivationWorker(oldUnit);
    }
    if (fenceDrain) {
      await renewDrainFence();
    } else if (!forceActivation && activePort !== null) {
      await waitForGateway(activePort, 5_000);
      throw new Error("Replacing an active backend requires a staged standby activation");
    }

    let standby;
    try {
      standby = await waitForStandby(
        candidatePort,
        version,
        Math.min(readinessTimeoutMs, 2_000),
        { requireCodexRuntimeBundle: requiresCodexRuntimeBundle },
      );
    } catch {
      await run(systemctl, ["restart", candidateUnit], { timeoutMs: systemctlTimeoutMs });
      standby = await waitForStandby(
        candidatePort,
        version,
        readinessTimeoutMs,
        { requireCodexRuntimeBundle: requiresCodexRuntimeBundle },
      );
    }
    if (candidateBackendInstanceId && standby.backendInstanceId !== candidateBackendInstanceId) {
      await persist("ready", {
        candidateBackendInstanceId: standby.backendInstanceId,
        candidateRestartedAfterStage: true,
      });
    }
    candidateBackendInstanceId = standby.backendInstanceId;

    if (fenceDrain) {
      assertActivationDeadline(activationPreHandoffMinimumRemaining());
      await commitActivationDecision();
      await renewDrainFence({ throughDeadline: true });
      activationRecord = {
        ...activationDeadlines(),
        drainToken: process.env.CODEX_DESKTOP_DRAIN_TOKEN,
        activationCommittedAt: Date.now(),
      };
    } else if (forceActivation && activePort !== null) {
      await commitActivationDecision();
      activationRecord = { forcedActivation: true, activationCommittedAt: Date.now() };
    }
    await persist("transferring-writer", {
      candidateBackendInstanceId,
      oldBackendInstanceId,
    });
    if (fenceDrain) assertActivationDeadline();

    if (activePort !== null) {
      if (fenceDrain) assertActivationDeadline(activationPreHandoffMinimumRemaining());
      const handoff = await prepareBackendAuthHandoff(activePort);
      authHandoffPrepared = handoff.supported === true;
      await persist("transferring-writer", {
        authHandoffPrepared,
        authHandoffPreparedAt: authHandoffPrepared ? Date.now() : null,
      });
    }

    if (fenceDrain) assertActivationDeadline(activationWriterTransferMinimumRemaining());

    const currentAuthority = await backendAuthorityStore.read();
    if (
      previousWriterEpoch !== null
      && currentAuthority
      && currentAuthority.writerEpoch !== previousWriterEpoch
      && currentAuthority.port !== activePort
    ) {
      throw new Error("Writer authority changed to another backend after candidate staging");
    }
    const candidateAuthority = await backendAuthorityStore.claim({
      backendInstanceId: candidateBackendInstanceId,
      port: candidatePort,
      ...(currentAuthority ? { expectedWriterEpoch: currentAuthority.writerEpoch } : {}),
    });
    writerTransferred = true;
    await persist("writer-transferred", {
      previousWriterAuthority: currentAuthority,
      writerEpoch: candidateAuthority.writerEpoch,
      writerTransferredAt: Date.now(),
    });

    // Keep the gateway on the verified previous backend while the candidate
    // expands from its lightweight standby into the full application. Writer
    // authority fences old writes; the public selector moves only after the
    // candidate has passed deep readiness, so HTTP and WebSocket clients never
    // get routed to the standby shell.
    await activateBackend(candidatePort, candidateBackendInstanceId);
    await persist("candidate-starting", { candidateActivationRequestedAt: Date.now() });
    await waitForCandidate(
      candidatePort,
      version,
      fenceDrain ? activationReadinessBudget() : readinessTimeoutMs,
    );
    candidatePrimary = true;
    await persist("candidate-starting", { candidateReadyAt: Date.now() });
    await atomicWrite(
      activePortFile,
      `${candidatePort}\n`,
      0o644,
      fenceDrain ? () => assertActivationDeadline() : undefined,
    );
    candidateSelected = true;
    await persist("candidate-selected", { candidateSelectedAt: Date.now() });
    await confirmBackendPrimary(candidatePort, candidateBackendInstanceId);
    const primaryIdentity = await inspectBackendIdentity(candidatePort);
    await persist("primary-ready", {
      candidateBackendInstanceId: primaryIdentity.backendInstanceId,
      writerEpoch: primaryIdentity.writerEpoch,
      candidateReadyAt: Date.now(),
    });

    await run(systemctl, ["enable", "--no-reload", candidateUnit], {
      timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
    });
    await run(systemctl, ["enable", "--no-reload", "wfl-codex-desktop-gateway.service"], {
      timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
    });
    await run(systemctl, ["daemon-reload"], {
      timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
    });
    if (activePort === null) {
      await run(systemctl, ["start", "wfl-codex-desktop-gateway.service"]);
    }
    await waitForGateway(candidatePort, fenceDrain ? activationGatewayBudget() : 10_000);
    gatewayConfirmed = true;
    await persist("gateway-confirmed", { gatewayConfirmedAt: Date.now() });

    if (oldUnit) {
      await persist("retiring-old", { oldBackendRetireStartedAt: Date.now() });
      await run(systemctl, ["stop", oldUnit], {
        timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
      });
      await run(systemctl, ["disable", "--no-reload", oldUnit], {
        timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
      });
      oldRetired = true;
    } else {
      await run(systemctl, ["disable", "wfl-codex-desktop.service"], { allowFailure: true });
    }
    await persist("activated", { oldBackendRetiredAt: Date.now(), activatedAt: Date.now() });
    if (onSwitched) await onSwitched();
    console.log(`Deployed v${version}: backend ${activePort ?? "none"} -> ${candidatePort}.`);
  } catch (error) {
    if (authHandoffPrepared && !writerTransferred && activePort !== null) {
      await resumeBackendAuthHandoff(activePort).catch((resumeError) => {
        console.error(`Unable to resume previous backend authentication: ${resumeError.message}`);
      });
    }
    if (oldRetired) {
      throw activationRecoveryRequired(
        error,
        `candidate ${candidatePort} is authoritative but deployment finalization did not complete`,
      );
    }
    if (!writerTransferred) {
      await run(systemctl, ["stop", candidateUnit], { allowFailure: true });
      await run(systemctl, ["disable", candidateUnit], { allowFailure: true });
      await restoreSymlink(slotPath, previousSlotTarget).catch(() => {});
      if (activePort !== null) {
        await waitForCandidate(activePort, null, RECOVERY_READY_TIMEOUT_MS);
        await waitForGateway(activePort, RECOVERY_GATEWAY_TIMEOUT_MS);
      }
      throw new Error(`Deployment aborted before writer transfer; the previous backend remains active: ${error.message}`);
    }

    try {
      await rollbackStandbyHandoff({
        activePort,
        candidatePort,
        candidateUnit,
        oldUnit,
        oldBackendInstanceId,
        candidateSelected,
        candidatePrimary,
        gatewayConfirmed,
        slotPath,
        previousSlotTarget,
      });
    } catch (recoveryError) {
      if (candidatePrimary && oldUnit) {
        try {
          const recovered = await recoverStandbyCandidate({
            candidatePort,
            candidateUnit,
            oldUnit,
          });
          await persist("activated", {
            candidateBackendInstanceId: recovered.backendInstanceId,
            writerEpoch: recovered.writerEpoch,
            recoveryTarget: "candidate",
            recoveredAt: Date.now(),
            activatedAt: Date.now(),
          });
          if (onSwitched) await onSwitched();
          console.log(
            `Deployed v${version}: previous-backend recovery was unavailable, so verified backend ${candidatePort} remains active.`,
          );
          return;
        } catch (candidateRecoveryError) {
          throw activationRecoveryRequired(
            error,
            `standby handoff rollback failed: ${recoveryError.message}; `
            + `candidate recovery failed: ${candidateRecoveryError.message}`,
          );
        }
      }
      throw activationRecoveryRequired(error, `standby handoff rollback failed: ${recoveryError.message}`);
    }
    throw new Error(`Deployment aborted; the previous backend remained available: ${error.message}`);
  }
}

async function deployLegacyCandidate({
  activePort,
  candidatePort,
  previousSlotTarget,
  slotPath,
  fenceDrain = false,
  forceActivation = false,
  onActivationState = null,
  onSwitched = null,
}) {
  const candidateUnit = `wfl-codex-desktop-backend@${candidatePort}.service`;
  const oldUnit = activePort === null ? null : `wfl-codex-desktop-backend@${activePort}.service`;
  let switched = false;
  let oldStopAttempted = false;
  try {
    if (activePort !== null && (fenceDrain || forceActivation)) {
      await assertIndependentActivationWorker(oldUnit);
    }
    if (fenceDrain) {
      await renewDrainFence();
    } else if (!forceActivation && activePort !== null) {
      await waitForGateway(activePort, 5_000);
    }
    if (!fenceDrain && !forceActivation && activePort !== null) {
      throw new Error("Replacing an active backend requires a staged stop-first activation");
    }
    if (fenceDrain) {
      await commitActivationDecision();
      await renewDrainFence({ throughDeadline: true });
      const deadlines = activationDeadlines();
      if (onActivationState) {
        await onActivationState({
          stageState: "stopping-old",
          activationMode: "stop-first",
          activationCommittedAt: Date.now(),
          ...deadlines,
          drainToken: process.env.CODEX_DESKTOP_DRAIN_TOKEN,
        });
      }
      assertActivationDeadline();
      oldStopAttempted = true;
      await run(systemctl, ["stop", oldUnit], { timeoutMs: activationProtectedSystemctlBudget() });
      if (onActivationState) {
        await onActivationState({
          stageState: "old-stopped",
          activationMode: "stop-first",
          activationCommittedAt: Date.now(),
          oldBackendStoppedAt: Date.now(),
          ...deadlines,
          drainToken: process.env.CODEX_DESKTOP_DRAIN_TOKEN,
        });
      }
      await renewDrainFence({ throughDeadline: true });
      assertActivationDeadline();
      await atomicWrite(
        activePortFile,
        `${candidatePort}\n`,
        0o644,
        () => assertActivationDeadline(),
      );
      switched = true;
      if (onActivationState) {
        await onActivationState({
          stageState: "activating",
          activationMode: "stop-first",
          activationCommittedAt: Date.now(),
          oldBackendStoppedAt: Date.now(),
          candidateSelectedAt: Date.now(),
          ...deadlines,
          drainToken: process.env.CODEX_DESKTOP_DRAIN_TOKEN,
        });
      }
    }
    if (forceActivation && activePort !== null) {
      await commitActivationDecision();
      if (onActivationState) {
        await onActivationState({
          stageState: "stopping-old",
          activationMode: "stop-first",
          forcedActivation: true,
          activationCommittedAt: Date.now(),
        });
      }
      oldStopAttempted = true;
      await run(systemctl, ["stop", oldUnit], { timeoutMs: systemctlTimeoutMs });
      if (onActivationState) {
        await onActivationState({
          stageState: "old-stopped",
          activationMode: "stop-first",
          forcedActivation: true,
          activationCommittedAt: Date.now(),
          oldBackendStoppedAt: Date.now(),
        });
      }
      await atomicWrite(activePortFile, `${candidatePort}\n`, 0o644);
      switched = true;
      if (onActivationState) {
        await onActivationState({
          stageState: "activating",
          activationMode: "stop-first",
          forcedActivation: true,
          activationCommittedAt: Date.now(),
          oldBackendStoppedAt: Date.now(),
          candidateSelectedAt: Date.now(),
        });
      }
    }
    await run(systemctl, ["restart", candidateUnit], {
      timeoutMs: fenceDrain ? activationProtectedSystemctlBudget() : systemctlTimeoutMs,
    });
    await waitForCandidate(
      candidatePort,
      version,
      fenceDrain ? activationReadinessBudget() : readinessTimeoutMs,
    );
    await run(systemctl, ["enable", "--no-reload", candidateUnit], {
      timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
    });
    if (oldUnit) {
      await run(systemctl, ["disable", "--no-reload", oldUnit], {
        timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
      });
    }
    await run(systemctl, ["enable", "--no-reload", "wfl-codex-desktop-gateway.service"], {
      timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
    });
    await run(systemctl, ["daemon-reload"], {
      timeoutMs: fenceDrain ? activationCompletionSystemctlBudget() : systemctlTimeoutMs,
    });

    if (!fenceDrain && !forceActivation) {
      await atomicWrite(activePortFile, `${candidatePort}\n`, 0o644);
      switched = true;
    }
    if (activePort === null) {
      await run(systemctl, ["start", "wfl-codex-desktop-gateway.service"]);
    }
    await waitForGateway(candidatePort, fenceDrain ? activationGatewayBudget() : 10_000);
    if (onSwitched) await onSwitched();

    if (activePort !== null) {
      // The previous unit was synchronously stopped and disabled before candidate startup.
    } else {
      await run(systemctl, ["disable", "wfl-codex-desktop.service"], { allowFailure: true });
    }
    console.log(`Deployed v${version}: backend ${activePort ?? "none"} -> ${candidatePort}.`);
  } catch (error) {
    if (!fenceDrain && !forceActivation && switched && activePort === null) {
      await fs.rm(activePortFile, { force: true }).catch(() => {});
      await run(systemctl, ["start", "wfl-codex-desktop.service"], { allowFailure: true });
    }
    if ((!fenceDrain && !forceActivation) || activePort === null) {
      await run(systemctl, ["stop", candidateUnit], { allowFailure: true });
      await run(systemctl, ["disable", candidateUnit], { allowFailure: true });
      await restoreSymlink(slotPath, previousSlotTarget).catch(() => {});
      throw new Error(`Deployment aborted; the previous backend remains active: ${error.message}`);
    }

    if (!oldStopAttempted) {
      try {
        const candidateStopped = await run(systemctl, ["stop", candidateUnit], {
          allowFailure: true,
          timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
        });
        const candidateDisabled = await run(systemctl, ["disable", candidateUnit], {
          allowFailure: true,
          timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
        });
        if (!candidateStopped || !candidateDisabled) {
          throw new Error("the staged candidate service state is unknown");
        }
        await waitForCandidate(activePort, null, RECOVERY_READY_TIMEOUT_MS);
        await waitForGateway(activePort, RECOVERY_GATEWAY_TIMEOUT_MS);
        await restoreSymlink(slotPath, previousSlotTarget);
      } catch (verificationError) {
        throw activationRecoveryRequired(
          error,
          `pre-stop cleanup could not be verified: ${verificationError.message}`,
        );
      }
      throw new Error(`Deployment aborted before stopping the previous backend: ${error.message}`);
    }

    let previousRecoveryError = null;
    try {
      await restoreSelectedBackend({
        selectedPort: activePort,
        selectedUnit: oldUnit,
        stoppedPort: candidatePort,
        stoppedUnit: candidateUnit,
        expectedVersion: null,
      });
    } catch (recoveryError) {
      previousRecoveryError = recoveryError;
    }
    if (!previousRecoveryError) {
      try {
        await restoreSymlink(slotPath, previousSlotTarget);
      } catch (slotError) {
        throw activationRecoveryRequired(error, `candidate slot rollback failed: ${slotError.message}`);
      }
      throw new Error(`Deployment aborted; the previous backend was restored: ${error.message}`);
    }

    try {
      await restoreSelectedBackend({
        selectedPort: candidatePort,
        selectedUnit: candidateUnit,
        stoppedPort: activePort,
        stoppedUnit: oldUnit,
        expectedVersion: version,
      });
      if (onSwitched) await onSwitched();
      console.log(
        `Deployed v${version}: the previous backend failed recovery, so verified backend ${candidatePort} remains active.`,
      );
      return;
    } catch (recoveryError) {
      throw activationRecoveryRequired(
        error,
        `neither backend could be recovered (old: ${previousRecoveryError.message}; candidate: ${recoveryError.message})`,
      );
    }
  }
}

async function activateBackend(port, expectedBackendInstanceId) {
  const response = await fetch(`http://${backendHost}:${port}/internal/activate-primary`, {
    method: "POST",
    headers: { Host: `${backendHost}:${port}` },
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(5_000, activationReadyTimeoutMs)),
  });
  const data = await response.json().catch(() => null);
  if (
    !response.ok
    || !data?.ok
    || data.backendInstanceId !== expectedBackendInstanceId
    || data.transitioning !== true
  ) {
    throw new Error(`Candidate standby refused activation: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function prepareBackendAuthHandoff(port) {
  const endpoint = `http://${backendHost}:${port}/internal/auth-handoff/prepare`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Host: `${backendHost}:${port}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(AUTH_HANDOFF_REQUEST_BUDGET_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || /operation was aborted|timed? out/iu.test(String(error?.message || ""))) {
      throw new Error(`Previous backend auth handoff timed out after ${AUTH_HANDOFF_REQUEST_BUDGET_MS}ms`);
    }
    throw error;
  }
  if (response.status === 404 || legacyAuthHandoffLoginRedirect(response, endpoint)) {
    console.warn(`Previous backend ${port} does not support auth handoff; continuing with legacy overlap protection.`);
    return { supported: false };
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || data.fenced !== true) {
    throw new Error(`Previous backend refused auth handoff: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return { supported: true, ...data };
}

function legacyAuthHandoffLoginRedirect(response, endpoint) {
  if (![301, 302, 303, 307, 308].includes(response.status)) return false;
  const location = response.headers.get("location");
  if (!location) return false;
  try {
    const target = new URL(location, endpoint);
    return target.pathname === "/login.html"
      && target.searchParams.get("next") === "/internal/auth-handoff/prepare";
  } catch {
    return false;
  }
}

async function resumeBackendAuthHandoff(port) {
  const response = await fetch(`http://${backendHost}:${port}/internal/activate-primary`, {
    method: "POST",
    headers: { Host: `${backendHost}:${port}` },
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(5_000, activationReadyTimeoutMs)),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Previous backend refused auth resume: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function recoverBackendPrimary(port, expectedBackendInstanceId, recoveryOperationId = operationId) {
  if (!validOperationId(recoveryOperationId)) {
    throw new Error("Backend recovery requires a verified deployment operation identity");
  }
  const response = await fetch(`http://${backendHost}:${port}/internal/recover-primary`, {
    method: "POST",
    headers: {
      Host: `${backendHost}:${port}`,
      "X-WFL-Deployment-Recovery": recoveryOperationId,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(5_000, activationReadyTimeoutMs)),
  });
  const data = await response.json().catch(() => null);
  if (
    !response.ok
    || !data?.ok
    || data.primary !== true
    || !validBackendInstanceId(data.backendInstanceId)
    || !Number.isSafeInteger(data.writerEpoch)
    || data.writerEpoch < 1
    || data.backendInstanceId !== expectedBackendInstanceId
  ) {
    throw new Error(`Backend recovery refused writer authority: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function confirmBackendPrimary(port, expectedBackendInstanceId = null) {
  const response = await fetch(`http://${backendHost}:${port}/internal/activate-primary`, {
    method: "POST",
    headers: { Host: `${backendHost}:${port}` },
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(5_000, activationReadyTimeoutMs)),
  });
  const data = await response.json().catch(() => null);
  if (
    !response.ok
    || !data?.ok
    || data.primary !== true
    || !validBackendInstanceId(data.backendInstanceId)
    || !Number.isSafeInteger(data.writerEpoch)
    || data.writerEpoch < 1
    || (expectedBackendInstanceId && data.backendInstanceId !== expectedBackendInstanceId)
  ) {
    throw new Error(`Backend did not confirm primary authority: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function rollbackStandbyHandoff({
  activePort,
  candidatePort,
  candidateUnit,
  oldUnit,
  oldBackendInstanceId,
  slotPath,
  previousSlotTarget,
}) {
  if (activePort === null) {
    await run(systemctl, ["stop", candidateUnit], {
      allowFailure: true,
      timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
    });
    await fs.rm(activePortFile, { force: true });
    await restoreSymlink(slotPath, previousSlotTarget);
    return;
  }

  let oldIdentity = validBackendInstanceId(oldBackendInstanceId)
    ? { backendInstanceId: oldBackendInstanceId }
    : await inspectBackendIdentity(activePort).catch(() => null);
  if (validBackendInstanceId(oldIdentity?.backendInstanceId)) {
    const currentAuthority = await backendAuthorityStore.read();
    await backendAuthorityStore.claim({
      backendInstanceId: oldIdentity.backendInstanceId,
      port: activePort,
      ...(currentAuthority ? { expectedWriterEpoch: currentAuthority.writerEpoch } : {}),
    });
  } else {
    oldIdentity = null;
  }
  const selectedPort = await readActivePort({ allowMissing: true }).catch(() => null);
  if (selectedPort !== activePort) await atomicWrite(activePortFile, `${activePort}\n`, 0o644);
  if (oldIdentity) await confirmBackendPrimary(activePort);
  try {
    await waitForCandidate(activePort, null, RECOVERY_READY_TIMEOUT_MS);
  } catch {
    await run(systemctl, ["restart", oldUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    await waitForCandidate(activePort, null, RECOVERY_READY_TIMEOUT_MS);
  }
  await waitForGateway(activePort, RECOVERY_GATEWAY_TIMEOUT_MS);
  const stopped = await run(systemctl, ["stop", candidateUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  if (!stopped) throw new Error(`candidate backend ${candidatePort} could not be stopped after rollback`);
  await run(systemctl, ["disable", "--no-reload", candidateUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await restoreSymlink(slotPath, previousSlotTarget);
}

async function recoverStandbyCandidate({ candidatePort, candidateUnit, oldUnit }) {
  const identity = await inspectBackendIdentity(candidatePort);
  const currentAuthority = await backendAuthorityStore.read();
  const authority = await backendAuthorityStore.claim({
    backendInstanceId: identity.backendInstanceId,
    port: candidatePort,
    ...(currentAuthority ? { expectedWriterEpoch: currentAuthority.writerEpoch } : {}),
  });
  const selectedPort = await readActivePort({ allowMissing: true }).catch(() => null);
  if (selectedPort !== candidatePort) await atomicWrite(activePortFile, `${candidatePort}\n`, 0o644);
  await confirmBackendPrimary(candidatePort);
  await waitForCandidate(candidatePort, version, RECOVERY_READY_TIMEOUT_MS);
  await waitForGateway(candidatePort, RECOVERY_GATEWAY_TIMEOUT_MS);
  await run(systemctl, ["enable", "--no-reload", candidateUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["stop", oldUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  await assertRecoveredBackend(candidatePort, version);
  await run(systemctl, ["disable", "--no-reload", oldUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  return { ...identity, writerEpoch: authority.writerEpoch };
}

async function restoreSelectedBackend({
  selectedPort,
  selectedUnit,
  stoppedPort,
  stoppedUnit,
  expectedVersion,
}) {
  // Validate the recovery target before retiring the service that may still
  // be serving traffic.  This is the last-resort path for the legacy
  // stop-first protocol, so it must obey the same no-two-stopped invariant.
  await run(systemctl, ["start", selectedUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  if (!await candidateIsReady(selectedPort, expectedVersion)) {
    await run(systemctl, ["restart", selectedUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    await waitForCandidate(selectedPort, expectedVersion, RECOVERY_READY_TIMEOUT_MS);
  }
  const currentSelection = await readActivePort({ allowMissing: true }).catch(() => null);
  if (currentSelection !== selectedPort) await atomicWrite(activePortFile, `${selectedPort}\n`);
  await waitForCandidate(selectedPort, expectedVersion, RECOVERY_READY_TIMEOUT_MS);
  await waitForGateway(selectedPort, RECOVERY_GATEWAY_TIMEOUT_MS);
  const stopped = await run(systemctl, ["stop", stoppedUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  if (!stopped) throw new Error(`backend ${stoppedPort} could not be stopped`);
  await assertRecoveredBackend(selectedPort, expectedVersion);
  await run(systemctl, ["enable", "--no-reload", selectedUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["disable", "--no-reload", stoppedUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["daemon-reload"], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
}

function activationRecoveryRequired(cause, recoveryReason) {
  const error = new Error(
    `Deployment activation requires recovery; the prevalidated candidate and staged manifest were preserved `
    + `because ${recoveryReason}: ${cause.message}`,
  );
  error.code = "ERR_ACTIVATION_RECOVERY_REQUIRED";
  error.preservePreparedDeployment = true;
  return error;
}

async function commitActivationDecision() {
  const result = await cancelStore.commit(operationId);
  if (result.accepted && result.decision === "commit") return;
  const error = new Error("Maintenance operation was cancelled before backend activation");
  error.code = "ERR_MAINTENANCE_CANCELLED";
  throw error;
}

async function renewDrainFence({ throughDeadline = false } = {}) {
  const token = process.env.CODEX_DESKTOP_DRAIN_TOKEN;
  if (!token) throw new Error("Deployment drain token is required for staged activation");
  const deadlineAt = drainDeadlineAt();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw drainDeadlineError();
  const configuredTtlMs = Number(process.env.CODEX_DESKTOP_DRAIN_TTL_MS || 30_000);
  if (!Number.isFinite(configuredTtlMs) || configuredTtlMs < 1_000 || configuredTtlMs > 5 * 60 * 1000) {
    throw new Error("Invalid deployment drain lease TTL");
  }
  const ttlMs = throughDeadline ? remainingMs : configuredTtlMs;
  if (!await drainStore.renew(token, { ttlMs: Math.max(1, Math.min(ttlMs, remainingMs)) })) {
    throw new Error("Deployment drain lease is expired or owned by another operation");
  }
}

function assertActivationDeadline(minimumRemainingMs = 0) {
  if (!activateStaged) return;
  if (activationDeadlineAt() - Date.now() <= minimumRemainingMs) throw drainDeadlineError();
}

function activationGatewayBudget() {
  const remainingMs = activationDeadlineAt() - Date.now() - DRAIN_RECOVERY_MARGIN_MS;
  if (remainingMs <= 0) throw drainDeadlineError();
  return Math.max(1, Math.min(3_000, activationGatewayTimeoutMs, remainingMs));
}

function activationProtectedSystemctlBudget() {
  const remainingMs = activationDeadlineAt() - Date.now();
  if (remainingMs <= 0) throw drainDeadlineError();
  return Math.max(1, Math.min(systemctlTimeoutMs, RECOVERY_SYSTEMCTL_TIMEOUT_MS, remainingMs));
}

function activationCompletionSystemctlBudget() {
  const remainingMs = activationDeadlineAt() - Date.now() - RECOVERY_GATEWAY_TIMEOUT_MS - DRAIN_RECOVERY_MARGIN_MS;
  if (remainingMs <= 0) throw drainDeadlineError();
  return Math.max(1, Math.min(systemctlTimeoutMs, RECOVERY_SYSTEMCTL_TIMEOUT_MS, remainingMs));
}

function activationReadinessBudget() {
  const remainingMs = activationDeadlineAt() - Date.now();
  if (remainingMs <= 0) throw drainDeadlineError();
  return Math.max(1, Math.min(activationReadyTimeoutMs, remainingMs));
}

function activationWriterTransferMinimumRemaining() {
  return activationReadyTimeoutMs
    + Math.min(3_000, activationGatewayTimeoutMs)
    + ACTIVATION_JOURNAL_BUDGET_MS
    + DRAIN_RECOVERY_MARGIN_MS;
}

function activationPreHandoffMinimumRemaining() {
  return AUTH_HANDOFF_REQUEST_BUDGET_MS + activationWriterTransferMinimumRemaining();
}

function activationDeadlineAt() {
  return drainDeadlineAt() - DRAIN_COMPLETION_RESERVE_MS;
}

function activationDeadlines() {
  const hardDeadlineAt = drainDeadlineAt();
  const recoveryDeadlineAt = hardDeadlineAt - DRAIN_COMPLETION_RESERVE_MS;
  if (recoveryDeadlineAt <= Date.now()) throw drainDeadlineError();
  return { recoveryDeadlineAt, drainDeadlineAt: hardDeadlineAt };
}

function drainDeadlineAt() {
  const value = Number(process.env.CODEX_DESKTOP_DRAIN_DEADLINE_AT);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Deployment drain hard deadline is required for staged activation");
  }
  if (value - Date.now() > MAX_DRAIN_DEADLINE_FUTURE_MS) {
    throw new Error("Deployment drain hard deadline exceeds the allowed activation window");
  }
  return value;
}

function drainDeadlineError() {
  const error = new Error("Deployment drain hard deadline expired before backend activation");
  error.code = "ERR_MAINTENANCE_DRAIN_DEADLINE";
  return error;
}

async function assertNoPreparedDeployment() {
  if (!await exists(preparedDeploymentFile)) return;
  const prepared = await readPreparedDeployment();
  const ownerState = await preparedDeploymentOwnerState(prepared);
  if (ownerState === "active") {
    throw new Error("A staged deployment is still owned by an active maintenance operation");
  }
  if (ownerState !== "inactive") {
    throw new Error("Cannot safely recover the staged deployment because its owner state is unknown");
  }
  await recoverAbandonedPreparedDeployment(prepared);
}

async function recoverPreparedDeployment(existingPrepared = null, { recoveryOwner = null } = {}) {
  if (!await exists(preparedDeploymentFile)) {
    console.log("No interrupted deployment requires recovery.");
    return null;
  }
  const prepared = existingPrepared || await readPreparedDeployment();
  const ownerState = await preparedDeploymentOwnerState(prepared, { ignoreLockOwner: recoveryOwner });
  const sameOperation = validOperationId(operationId) && prepared.operationId === operationId;
  const trustedWatchdog = sameOperation
    && prepared.schemaVersion >= 3
    && validWatchToken(process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN)
    && prepared.watchToken === process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN;
  if (ownerState === "active" && !sameOperation) {
    throw new Error("The staged deployment is still owned by an active maintenance operation");
  }
  if (ownerState === "active") {
    if (!trustedWatchdog || !await verifiedRecoveryOwnerExited(prepared, { ignoreLockOwner: recoveryOwner })) {
      throw new Error("The staged deployment is still owned by an active maintenance operation");
    }
  }
  if (ownerState === "unknown" && !trustedWatchdog) {
    throw new Error("Cannot recover the staged deployment because its owner state is unknown");
  }
  if (ownerState === "unknown" && trustedWatchdog
    && !await verifiedRecoveryOwnerExited(prepared, { ignoreLockOwner: recoveryOwner })) {
    throw new Error("Cannot safely recover the staged deployment while its owner state is unknown");
  }
  return recoverAbandonedPreparedDeployment(prepared);
}

async function readPreparedDeploymentHeader() {
  try {
    const stat = await fs.lstat(preparedDeploymentFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) {
      throw new Error("Deployment manifest has an unsafe file type or size");
    }
    const value = JSON.parse(await fs.readFile(preparedDeploymentFile, "utf8"));
    return {
      operationId: validOperationId(value?.operationId) ? value.operationId : null,
      version: validVersion(value?.version) ? value.version : null,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readPreparedDeployment() {
  let value;
  try {
    value = JSON.parse(await fs.readFile(preparedDeploymentFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("No staged deployment is available");
    throw new Error(`Cannot read staged deployment: ${error.message}`);
  }
  if (
    ![1, 2, 3, 4].includes(value?.schemaVersion)
    || !validOperationId(value.operationId)
    || !validVersion(value.version)
    || (
      value.schemaVersion >= 2
      && ![
        "preparing",
        "ready",
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
      ].includes(value.stageState)
    )
    || !backendPorts.includes(value.activePort)
    || !backendPorts.includes(value.candidatePort)
    || value.activePort === value.candidatePort
    || !(value.previousSlotTarget === null || typeof value.previousSlotTarget === "string")
    || !(value.forcedActivation === undefined || value.forcedActivation === true)
    || (value.forcedActivation === true && !destructiveDeploymentState(value.stageState))
    || !(value.recoveryTarget === undefined || ["old", "candidate"].includes(value.recoveryTarget))
    || !(
      value.recoveryMode === undefined
      || [
        "restart-old",
        "restart-candidate",
        "restart-gateway-old",
        "restart-gateway-candidate",
        "cleanup-old",
        "cleanup-candidate",
      ].includes(value.recoveryMode)
    )
  ) {
    throw new Error("Staged deployment manifest is invalid");
  }
  if (value.releaseDirectory !== undefined && !isValidReleaseDirectory(value.releaseDirectory, value.version)) {
    throw new Error("Staged deployment release directory is invalid");
  }
  if (
    value.schemaVersion >= 2
    && (!Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 1 || !/^\d+$/.test(value.ownerStartTicks))
  ) {
    throw new Error("Staged deployment owner fingerprint is invalid");
  }
  if (
    value.schemaVersion >= 4
    && (!Number.isSafeInteger(value.deploymentWorkerPid) || value.deploymentWorkerPid <= 1
      || !/^\d+$/.test(value.deploymentWorkerStartTicks || ""))
  ) {
    throw new Error("Staged deployment worker fingerprint is invalid");
  }
  if (
    value.schemaVersion >= 3
    && (
      !validWatchToken(value.watchToken)
      || !["stop-first", "standby-handoff"].includes(value.activationMode)
      || (value.schemaVersion === 3 && value.activationMode !== "stop-first")
      || (value.schemaVersion === 4 && value.activationMode !== "standby-handoff")
      || (
        value.schemaVersion === 4
        && value.stageState !== "preparing"
        && !validBackendInstanceId(value.candidateBackendInstanceId)
      )
      || (
        destructiveDeploymentState(value.stageState)
        && value.forcedActivation !== true
        && (
          !Number.isSafeInteger(value.recoveryDeadlineAt)
          || value.recoveryDeadlineAt <= 0
          || !Number.isSafeInteger(value.drainDeadlineAt)
          || value.drainDeadlineAt <= value.recoveryDeadlineAt
          || value.drainDeadlineAt - value.recoveryDeadlineAt < DRAIN_COMPLETION_RESERVE_MS
          || value.drainDeadlineAt - value.recoveryDeadlineAt > MAX_DRAIN_DEADLINE_FUTURE_MS
          || !validDrainToken(value.drainToken)
        )
      )
    )
  ) {
    throw new Error("Staged deployment activation capabilities are invalid");
  }
  if (value.previousSlotTarget !== null) {
    const previous = resolveLink(path.join(slotsDir, String(value.candidatePort)), value.previousSlotTarget);
    if (!isInside(releasesDir, previous)) throw new Error("Staged deployment previous slot is invalid");
  }
  return value.schemaVersion === 1 ? { ...value, stageState: "ready" } : value;
}

function writePreparedDeployment(value) {
  return atomicWrite(preparedDeploymentFile, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function removePreparedDeployment({ force = false } = {}) {
  try {
    await fs.unlink(preparedDeploymentFile);
    await syncDirectory(path.dirname(preparedDeploymentFile));
  } catch (error) {
    if (force && error.code === "ENOENT") return false;
    throw error;
  }
  return true;
}

async function recoverAbandonedPreparedDeployment(prepared) {
  const activePort = await readActivePort({ allowMissing: true });
  if (activePort !== null && activePort !== prepared.activePort && activePort !== prepared.candidatePort) {
    throw new Error("Cannot safely recover the staged deployment because the active backend is unknown");
  }

  const candidateUnit = `wfl-codex-desktop-backend@${prepared.candidatePort}.service`;
  const slotPath = path.join(slotsDir, String(prepared.candidatePort));
  const slotState = await preparedCandidateSlotState(prepared, slotPath);

  // A timed-out owner may have already committed the candidate and then
  // disappeared while finalizing.  Reuse that healthy primary in place.  In
  // particular, do not stop it just to test whether the old backend can be
  // restarted; the candidate is the last known-good service in this state.
  if (
    activePort === prepared.candidatePort
    && slotState === "staged"
    && await candidateIsReady(prepared.candidatePort, prepared.version)
  ) {
    return recoverHealthySelectedCandidate(prepared, { candidateUnit, slotPath, slotState });
  }

  // The authentication handoff intentionally makes the selected old backend
  // fail deep Codex readiness before writer authority moves. If the release
  // worker exits in that window, the manifest may already have advanced from
  // "transferring-writer" to "writer-transferred" or "recovery-required";
  // the auth-handoff marker itself may also not have reached durable storage.
  // Whenever the old backend is still selected in a destructive state, restore
  // its authority and app-server before any readiness decision. Otherwise
  // recovery mistakes the fence for a broken backend and leaves the recovery
  // target marked restart-old without making the old backend writable again.
  if (
    activePort === prepared.activePort
    && destructiveDeploymentState(prepared.stageState)
    && prepared.recoveryTarget !== "candidate"
  ) {
    // Persist the takeover decision, then let the common old-backend recovery
    // path run. That path also records a candidate fallback if the old
    // backend cannot be restarted or verified.
    prepared = await persistRecoveryPhase(prepared, "old", "restart-old");
  }

  if (activePort === prepared.activePort && !destructiveDeploymentState(prepared.stageState)) {
    return cleanupPreparedCandidateWhileOldActive(prepared, { candidateUnit, slotPath, slotState });
  }

  if (prepared.recoveryTarget === "candidate") {
    if (slotState !== "staged" || !destructiveDeploymentState(prepared.stageState)) {
      throw new Error("Cannot resume candidate recovery from a non-destructive deployment state");
    }
    if (["cleanup-candidate", "restart-gateway-candidate"].includes(prepared.recoveryMode)) {
      return cleanupPreparedCandidateAfterActivation(prepared, { candidateUnit });
    } else {
      return restorePreparedCandidateBackend(prepared, { candidateUnit });
    }
  }

  if (
    activePort === prepared.activePort
    && destructiveDeploymentState(prepared.stageState)
    && prepared.recoveryMode !== "restart-old"
  ) {
    try {
      await waitForCandidate(prepared.activePort, null, RECOVERY_READY_TIMEOUT_MS);
    } catch (error) {
      await writePreparedDeployment({
        ...prepared,
        recoveryTarget: "old",
        recoveryMode: "restart-old",
        recoveryTargetUpdatedAt: Date.now(),
      });
      throw new Error(`The selected previous backend requires a bounded restart: ${error.message}`);
    }
    const gatewayReady = await ensureRecoveryGateway(prepared, "old");
    const cleanupReady = await persistRecoveryPhase(gatewayReady, "old", "cleanup-old");
    return cleanupPreparedCandidateWhileOldActive(
      cleanupReady,
      { candidateUnit, slotPath, slotState },
      { verifyOldBackend: false },
    );
  }

  const reason = activePort === null
    ? "the backend selector was missing"
    : activePort === prepared.activePort
      ? "the previous backend was still selected"
      : "activation stopped before the candidate was committed";
  let oldRecoveryError = null;
  try {
    return await restorePreparedOldBackend(
      prepared,
      { candidateUnit, slotPath, slotState },
      reason,
    );
  } catch (error) {
    oldRecoveryError = error;
  }

  if (
    oldRecoveryError.backendRestored
    || slotState !== "staged"
    || !destructiveDeploymentState(prepared.stageState)
  ) throw oldRecoveryError;

  const candidateRecovery = {
    ...prepared,
    recoveryTarget: "candidate",
    recoveryMode: "restart-candidate",
    recoveryTargetUpdatedAt: Date.now(),
  };
  await writePreparedDeployment(candidateRecovery);

  try {
    return await restorePreparedCandidateBackend(candidateRecovery, { candidateUnit });
  } catch (candidateError) {
    throw new Error(
      `Neither deployment backend could be recovered (old: ${oldRecoveryError.message}; `
      + `candidate: ${candidateError.message})`,
    );
  }
}

async function cleanupPreparedCandidateWhileOldActive(
  prepared,
  { candidateUnit, slotPath, slotState },
  { verifyOldBackend = true } = {},
) {
  const oldUnit = `wfl-codex-desktop-backend@${prepared.activePort}.service`;
  // Prove the selected old backend can serve before stopping the standby.
  // This keeps the old service available even when recovery is interrupted
  // between the two systemd operations.
  await run(systemctl, ["start", oldUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  let oldAuthority = await grantRecoveryAuthority(prepared, "old");
  await activateGrantedRecoveryBackend(prepared.activePort, oldAuthority, prepared.operationId);
  if (verifyOldBackend && !await candidateIsReady(prepared.activePort, null)) {
    await run(systemctl, ["restart", oldUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    oldAuthority = await grantRecoveryAuthority(prepared, "old");
    await activateGrantedRecoveryBackend(prepared.activePort, oldAuthority, prepared.operationId);
    await waitForCandidate(prepared.activePort, null, RECOVERY_READY_TIMEOUT_MS);
  }
  const gatewayReady = verifyOldBackend
    ? await ensureRecoveryGateway(prepared, "old")
    : prepared;
  const cleanupReady = await persistRecoveryPhase(gatewayReady, "old", "cleanup-old");

  const candidateStopped = await run(systemctl, ["stop", candidateUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  if (!candidateStopped) throw new Error("Cannot clean the staged candidate while its service state is unknown");
  try {
    await assertRecoveredBackend(prepared.activePort, null);
  } catch (oldHealthError) {
    const candidateRecovery = {
      ...cleanupReady,
      recoveryTarget: "candidate",
      recoveryMode: "restart-candidate",
      recoveryTargetUpdatedAt: Date.now(),
    };
    await writePreparedDeployment(candidateRecovery);
    try {
      await restorePreparedCandidateBackend(
        candidateRecovery,
        { candidateUnit },
      );
      return {
        outcome: "candidate",
        operationId: prepared.operationId,
        version: prepared.version,
        selectedPort: prepared.candidatePort,
        detail: `旧后端复验失败后已接管健康候选后端 ${prepared.candidatePort}`,
      };
    } catch (candidateRecoveryError) {
      throw new Error(
        `Neither deployment backend could be verified after cleanup (old: ${oldHealthError.message}; `
        + `candidate: ${candidateRecoveryError.message})`,
      );
    }
  }
  // Claiming the epoch fences the old process until it reloads the authority.
  // Even the fast cleanup path must complete that handshake; a shallow
  // readiness response can otherwise make the deployment look recovered while
  // every write still returns 503 from the fenced backend.
  await run(systemctl, ["enable", "--no-reload", oldUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["disable", "--no-reload", candidateUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["daemon-reload"], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  if (slotState === "staged") await restoreSymlink(slotPath, prepared.previousSlotTarget);
  await removePreparedDeployment();
  if (validDrainToken(cleanupReady.drainToken)) await drainStore.clear(cleanupReady.drainToken).catch(() => {});
  console.log(
    `Discarded interrupted pre-switch v${prepared.version}; active backend ${prepared.activePort} was verified.`,
  );
  return {
    outcome: "failed",
    operationId: prepared.operationId,
    version: prepared.version,
    selectedPort: prepared.activePort,
    detail: `发布未完成，已恢复旧后端 ${prepared.activePort}`,
  };
}

async function restorePreparedOldBackend(
  prepared,
  { candidateUnit, slotPath, slotState },
  reason,
  { fallbackToCandidate = true } = {},
) {
  const oldUnit = `wfl-codex-desktop-backend@${prepared.activePort}.service`;
  // Start and validate the old backend while the currently selected backend
  // is still serving.  Recovery must never stop the candidate first and then
  // discover that the previous backend cannot come back.
  await run(systemctl, ["start", oldUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  let oldAuthority = await grantRecoveryAuthority(prepared, "old");
  await activateGrantedRecoveryBackend(prepared.activePort, oldAuthority, prepared.operationId);
  if (!await candidateIsReady(prepared.activePort, null)) {
    await run(systemctl, ["restart", oldUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    oldAuthority = await grantRecoveryAuthority(prepared, "old");
    await activateGrantedRecoveryBackend(prepared.activePort, oldAuthority, prepared.operationId);
    await waitForCandidate(prepared.activePort, null, RECOVERY_READY_TIMEOUT_MS);
  }
  const selectedPort = await readActivePort({ allowMissing: true }).catch(() => null);
  if (selectedPort !== prepared.activePort) await atomicWrite(activePortFile, `${prepared.activePort}\n`);
  await confirmBackendPrimary(prepared.activePort, oldAuthority?.backendInstanceId);
  let cleanupReady;
  try {
    const gatewayReady = await ensureRecoveryGateway(prepared, "old");
    cleanupReady = await persistRecoveryPhase(gatewayReady, "old", "cleanup-old");
    const candidateStopped = await run(systemctl, ["stop", candidateUnit], {
      allowFailure: true,
      timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
    });
    if (!candidateStopped) throw new Error("Cannot restore the previous backend while the candidate may still be active");
    try {
      await assertRecoveredBackend(prepared.activePort, null);
    } catch (oldHealthError) {
      if (!fallbackToCandidate) throw oldHealthError;
      const candidateRecovery = {
        ...cleanupReady,
        recoveryTarget: "candidate",
        recoveryMode: "restart-candidate",
        recoveryTargetUpdatedAt: Date.now(),
      };
      await writePreparedDeployment(candidateRecovery);
      try {
        return await restorePreparedCandidateBackend(
          candidateRecovery,
          { candidateUnit },
        );
      } catch (candidateRecoveryError) {
        throw new Error(
          `Neither deployment backend could be verified after old-backend recovery (old: ${oldHealthError.message}; `
          + `candidate: ${candidateRecoveryError.message})`,
        );
      }
    }
    await run(systemctl, ["enable", "--no-reload", oldUnit], {
      timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
    });
    await run(systemctl, ["disable", "--no-reload", candidateUnit], {
      timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
    });
    await run(systemctl, ["daemon-reload"], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    if (slotState === "staged") await restoreSymlink(slotPath, prepared.previousSlotTarget);
    await removePreparedDeployment();
  } catch (error) {
    error.backendRestored = true;
    throw error;
  }
  if (validDrainToken(cleanupReady.drainToken)) await drainStore.clear(cleanupReady.drainToken).catch(() => {});
  console.log(`Recovered failed staged v${prepared.version}; backend ${prepared.activePort} was restored (${reason}).`);
  return {
    outcome: "failed",
    operationId: prepared.operationId,
    version: prepared.version,
    selectedPort: prepared.activePort,
    detail: `发布未完成，已自动恢复旧后端 ${prepared.activePort}`,
  };
}

async function restorePreparedCandidateBackend(
  prepared,
  { candidateUnit },
) {
  const oldUnit = `wfl-codex-desktop-backend@${prepared.activePort}.service`;
  // Bring the candidate to deep readiness before changing the selector or
  // fencing the old backend.  A failed candidate start therefore leaves the
  // old service and gateway untouched.
  await run(systemctl, ["start", candidateUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  let candidateAuthority = await grantRecoveryAuthority(prepared, "candidate");
  await activateGrantedRecoveryBackend(prepared.candidatePort, candidateAuthority, prepared.operationId);
  if (!await candidateIsReady(prepared.candidatePort, prepared.version)) {
    await run(systemctl, ["restart", candidateUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    candidateAuthority = await grantRecoveryAuthority(prepared, "candidate");
    await activateGrantedRecoveryBackend(prepared.candidatePort, candidateAuthority, prepared.operationId);
    await waitForCandidate(prepared.candidatePort, prepared.version, RECOVERY_READY_TIMEOUT_MS);
  }
  const selectedPort = await readActivePort({ allowMissing: true }).catch(() => null);
  if (selectedPort !== prepared.candidatePort) await atomicWrite(activePortFile, `${prepared.candidatePort}\n`);
  await confirmBackendPrimary(prepared.candidatePort, candidateAuthority?.backendInstanceId);
  if (!await candidateIsReady(prepared.candidatePort, prepared.version)) {
    await run(systemctl, ["restart", candidateUnit], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
    await waitForCandidate(prepared.candidatePort, prepared.version, RECOVERY_READY_TIMEOUT_MS);
  }
  const gatewayReady = await ensureRecoveryGateway(prepared, "candidate");
  const cleanupReady = await persistRecoveryPhase(gatewayReady, "candidate", "cleanup-candidate");
  const oldStopped = await run(systemctl, ["stop", oldUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  if (!oldStopped) throw new Error("the previous backend could not be fenced");
  try {
    await assertRecoveredBackend(prepared.candidatePort, prepared.version);
  } catch (candidateHealthError) {
    const oldRecovery = {
      ...cleanupReady,
      recoveryTarget: "old",
      recoveryMode: "restart-old",
      recoveryTargetUpdatedAt: Date.now(),
    };
    await writePreparedDeployment(oldRecovery);
    try {
      await restorePreparedOldBackend(
        oldRecovery,
        {
          candidateUnit,
          slotPath: path.join(slotsDir, String(prepared.candidatePort)),
          slotState: "staged",
        },
        "candidate failed after takeover",
        { fallbackToCandidate: false },
      );
      return {
        outcome: "failed",
        operationId: prepared.operationId,
        version: prepared.version,
        selectedPort: prepared.activePort,
        detail: `候选后端复验失败，已恢复旧后端 ${prepared.activePort}`,
      };
    } catch (oldRecoveryError) {
      throw new Error(
        `Neither deployment backend could be verified after candidate recovery (candidate: ${candidateHealthError.message}; `
        + `old: ${oldRecoveryError.message})`,
      );
    }
  }
  await run(systemctl, ["enable", "--no-reload", candidateUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["disable", "--no-reload", oldUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await run(systemctl, ["daemon-reload"], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  await removePreparedDeployment();
  if (validDrainToken(cleanupReady.drainToken)) await drainStore.clear(cleanupReady.drainToken).catch(() => {});
  console.log(
    `Recovered interrupted staged v${prepared.version}; old backend recovery failed, so backend `
    + `${prepared.candidatePort} remains active.`,
  );
  return {
    outcome: "candidate",
    operationId: prepared.operationId,
    version: prepared.version,
    selectedPort: prepared.candidatePort,
    detail: `候选后端 ${prepared.candidatePort} 已健康接管，旧后端未能恢复`,
  };
}

async function cleanupPreparedCandidateAfterActivation(prepared, { candidateUnit }) {
  const slotPath = path.join(slotsDir, String(prepared.candidatePort));
  const slotState = await preparedCandidateSlotState(prepared, slotPath);
  return recoverHealthySelectedCandidate(prepared, { candidateUnit, slotPath, slotState });
}

async function recoverHealthySelectedCandidate(prepared, { candidateUnit, slotPath, slotState }) {
  const oldUnit = `wfl-codex-desktop-backend@${prepared.activePort}.service`;
  const selectedPort = await readActivePort({ allowMissing: true });
  if (selectedPort !== prepared.candidatePort) {
    throw new Error("the healthy recovered candidate is no longer selected");
  }
  const candidateAuthority = await grantRecoveryAuthority(prepared, "candidate");
  await activateGrantedRecoveryBackend(prepared.candidatePort, candidateAuthority, prepared.operationId);
  await waitForCandidate(prepared.candidatePort, prepared.version, RECOVERY_READY_TIMEOUT_MS);
  const gatewayReady = await ensureRecoveryGateway(prepared, "candidate");
  const cleanupReady = await persistRecoveryPhase(gatewayReady, "candidate", "cleanup-candidate");

  // The candidate and gateway are now verified.  Only this point may retire
  // the previous backend, so a failure cannot leave the selector without a
  // ready service behind it.
  await run(systemctl, ["enable", "--no-reload", candidateUnit], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  const oldStopped = await run(systemctl, ["stop", oldUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  if (!oldStopped) throw new Error("the previous backend could not be fenced during candidate takeover");
  try {
    await assertRecoveredBackend(prepared.candidatePort, prepared.version);
  } catch (candidateHealthError) {
    const oldRecovery = {
      ...cleanupReady,
      recoveryTarget: "old",
      recoveryMode: "restart-old",
      recoveryTargetUpdatedAt: Date.now(),
    };
    await writePreparedDeployment(oldRecovery);
    try {
      await restorePreparedOldBackend(
        oldRecovery,
        { candidateUnit, slotPath, slotState },
        "candidate failed after takeover",
        { fallbackToCandidate: false },
      );
      return {
        outcome: "failed",
        operationId: prepared.operationId,
        version: prepared.version,
        selectedPort: prepared.activePort,
        detail: `候选后端复验失败，已恢复旧后端 ${prepared.activePort}`,
      };
    } catch (oldRecoveryError) {
      throw new Error(
        `Neither deployment backend could be verified after candidate takeover (candidate: ${candidateHealthError.message}; `
        + `old: ${oldRecoveryError.message})`,
      );
    }
  }
  const oldDisabled = await run(systemctl, ["disable", oldUnit], {
    allowFailure: true,
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  if (!oldDisabled) throw new Error("the previous backend could not be disabled during candidate takeover");
  await run(systemctl, ["daemon-reload"], { timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS });
  await removePreparedDeployment();
  if (validDrainToken(cleanupReady.drainToken)) await drainStore.clear(cleanupReady.drainToken).catch(() => {});
  console.log(`Completed interrupted cleanup for recovered backend ${prepared.candidatePort}.`);
  return {
    outcome: "candidate",
    operationId: prepared.operationId,
    version: prepared.version,
    selectedPort: prepared.candidatePort,
    detail: `已完成候选后端 ${prepared.candidatePort} 的中断清理`,
  };
}

async function ensureRecoveryGateway(prepared, target) {
  const selectedPort = target === "candidate" ? prepared.candidatePort : prepared.activePort;
  const gatewayMode = `restart-gateway-${target}`;
  let current = prepared;
  if (await gatewayIsReady(selectedPort)) return current;
  if (prepared.recoveryMode !== gatewayMode) current = await persistRecoveryPhase(prepared, target, gatewayMode);
  await run(systemctl, ["restart", "wfl-codex-desktop-gateway.service"], {
    timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS,
  });
  await waitForGateway(selectedPort, RECOVERY_GATEWAY_TIMEOUT_MS);
  return current;
}

async function grantRecoveryAuthority(prepared, target) {
  if (prepared.schemaVersion < 4) return null;
  const port = target === "candidate" ? prepared.candidatePort : prepared.activePort;
  const preferredBackendInstanceId = target === "candidate"
    ? prepared.candidateBackendInstanceId
    : prepared.oldBackendInstanceId;
  let identity = await inspectBackendIdentity(port).catch(() => null);
  if (!validBackendInstanceId(identity?.backendInstanceId) && validBackendInstanceId(preferredBackendInstanceId)) {
    identity = { backendInstanceId: preferredBackendInstanceId, standby: false };
  }
  if (!validBackendInstanceId(identity?.backendInstanceId)) {
    throw new Error(`Cannot identify the ${target} backend while restoring writer authority`);
  }
  const currentAuthority = await backendAuthorityStore.read();
  const authority = await backendAuthorityStore.claim({
    backendInstanceId: identity.backendInstanceId,
    port,
    ...(currentAuthority ? { expectedWriterEpoch: currentAuthority.writerEpoch } : {}),
  });
  return { ...identity, writerEpoch: authority.writerEpoch };
}

async function activateGrantedRecoveryBackend(port, identity, recoveryOperationId = operationId) {
  if (!identity) return;
  if (identity.standby === true) {
    await activateBackend(port, identity.backendInstanceId);
    await waitForCandidate(port, null, RECOVERY_READY_TIMEOUT_MS);
  } else if (await readActivePort({ allowMissing: true }) !== port) {
    await recoverBackendPrimary(port, identity.backendInstanceId, recoveryOperationId);
  } else {
    await confirmBackendPrimary(port, identity.backendInstanceId);
  }
}

async function persistRecoveryPhase(prepared, target, mode) {
  if (prepared.recoveryTarget === target && prepared.recoveryMode === mode) return prepared;
  const updated = {
    ...prepared,
    recoveryTarget: target,
    recoveryMode: mode,
    recoveryTargetUpdatedAt: Date.now(),
  };
  await writePreparedDeployment(updated);
  return updated;
}

async function candidateIsReady(port, expectedVersion) {
  try {
    await waitForCandidate(port, expectedVersion, 500);
    return true;
  } catch {
    return false;
  }
}

async function assertRecoveredBackend(port, expectedVersion) {
  await waitForCandidate(port, expectedVersion, RECOVERY_READY_TIMEOUT_MS);
  await waitForGateway(port, RECOVERY_GATEWAY_TIMEOUT_MS);
}

async function gatewayIsReady(expectedPort) {
  try {
    await waitForGateway(expectedPort, 500);
    return true;
  } catch {
    return false;
  }
}

function releaseDirectoryForVersion(releaseVersion) {
  const suffix = candidateSourceCommit ? `-${candidateSourceCommit.slice(0, 12)}` : "";
  return path.join(releasesDir, `v${releaseVersion}${suffix}`);
}

function preparedReleaseDirectory(prepared) {
  const releaseDirectory = prepared.releaseDirectory || releaseDirectoryForVersion(prepared.version);
  if (!isValidReleaseDirectory(releaseDirectory, prepared.version)) {
    throw new Error("Prepared release directory is invalid");
  }
  return path.resolve(releaseDirectory);
}

function isValidReleaseDirectory(value, expectedVersion) {
  if (typeof value !== "string") return false;
  const resolved = path.resolve(value);
  if (!isInside(releasesDir, resolved)) return false;
  const expectedPrefix = `v${expectedVersion}`;
  return path.basename(resolved) === expectedPrefix
    || path.basename(resolved).startsWith(`${expectedPrefix}-`);
}

function validGitHash(value) {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(String(value || ""));
}

async function preparedCandidateSlotState(prepared, slotPath) {
  const currentTarget = resolveLink(slotPath, await readLink(slotPath));
  const stagedTarget = preparedReleaseDirectory(prepared);
  const previousTarget = resolveLink(slotPath, prepared.previousSlotTarget);
  if (currentTarget === stagedTarget) return "staged";
  if (currentTarget === previousTarget) return "restored";
  throw new Error("Cannot safely recover the staged deployment because the candidate slot changed");
}

async function deploymentOwnerFingerprint() {
  const pid = process.ppid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Cannot identify the maintenance operation that owns this deployment");
  }
  const startTicks = await readProcessStartTicks(pid);
  if (startTicks === null) throw new Error("Cannot identify the maintenance operation that owns this deployment");
  return { pid, startTicks };
}

async function claimPreparedDeploymentWorker(prepared) {
  if (prepared.schemaVersion < 4) return prepared;
  const startTicks = await readProcessStartTicks(process.pid);
  if (!/^\d+$/.test(startTicks || "")) {
    throw new Error("Cannot identify the deployment worker that owns the staged deployment");
  }
  if (
    prepared.deploymentWorkerPid === process.pid
    && prepared.deploymentWorkerStartTicks === startTicks
  ) return prepared;
  const claimed = {
    ...prepared,
    deploymentWorkerPid: process.pid,
    deploymentWorkerStartTicks: startTicks,
    deploymentWorkerClaimedAt: Date.now(),
  };
  await writePreparedDeployment(claimed);
  return claimed;
}

async function assertIndependentActivationWorker(activeUnit) {
  let cgroup;
  try {
    cgroup = await fs.readFile("/proc/self/cgroup", "utf8");
  } catch (error) {
    throw new Error(`Cannot verify the independent deployment worker: ${error.message}`);
  }
  const belongsToActiveBackend = cgroup.split(/\r?\n/).some((line) => {
    const cgroupPath = line.split(":", 3)[2] || "";
    return cgroupPath.split("/").includes(activeUnit);
  });
  if (belongsToActiveBackend) {
    throw new Error("Deployment activation requires a controller outside the active backend systemd unit");
  }
}

async function assertPreparedDeploymentWatchdogActive(prepared) {
  return assertPreparedDeploymentWatchdogAttestation(prepared, { requireActive: true });
}

async function assertPreparedDeploymentWatchdogAttestation(prepared, { requireActive = true } = {}) {
  if (process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TEST_MODE === "1") return;
  const readyFile = path.join(runtimeDir, "deployment-watchdogs", `${prepared.operationId}.json`);
  const requirement = requireActive ? "an active recovery watchdog" : "a recovery watchdog attestation";
  let ready;
  try {
    const stat = await fs.lstat(readyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) {
      throw new Error("unsafe watchdog handshake file");
    }
    ready = JSON.parse(await fs.readFile(readyFile, "utf8"));
  } catch (error) {
    throw new Error(`Deployment recovery requires ${requirement}: ${error.message}`);
  }
  if (
    ready?.schemaVersion !== 1
    || ready.token !== prepared.watchToken
    || ready.operationId !== prepared.operationId
    || ready.ownerPid !== prepared.ownerPid
    || ready.ownerStartTicks !== prepared.ownerStartTicks
    || !Number.isSafeInteger(ready.watcherPid)
    || ready.watcherPid <= 1
    || !/^\d+$/.test(ready.watcherStartTicks || "")
  ) {
    throw new Error("Deployment activation requires a verified recovery watchdog");
  }
  if (!requireActive) return;
  if (await processFingerprintState(ready.watcherPid, ready.watcherStartTicks) !== "active") {
    throw new Error("Deployment activation recovery watchdog is no longer running");
  }
  let cgroup;
  try {
    cgroup = await fs.readFile(`/proc/${ready.watcherPid}/cgroup`, "utf8");
  } catch (error) {
    throw new Error(`Cannot verify the deployment recovery watchdog cgroup: ${error.message}`);
  }
  const isolated = cgroup.split(/\r?\n/).some((line) => {
    const cgroupPath = line.split(":", 3)[2] || "";
    return cgroupPath.split("/").some(
      (segment) => /^wfl-codex-deployment-watch-[A-Za-z0-9._-]+\.service$/.test(segment),
    );
  });
  if (!isolated) throw new Error("Deployment recovery watchdog is not isolated in its systemd unit");
}

async function preparedDeploymentOwnerState(prepared, { ignoreLockOwner = null } = {}) {
  const workerState = await preparedDeploymentWorkerState(prepared);
  if (prepared.schemaVersion >= 2) {
    const processState = await processFingerprintState(prepared.ownerPid, prepared.ownerStartTicks);
    if (processState === "active" || workerState === "active") return "active";
    const unit = deploymentOperationUnit(prepared.operationId);
    const unitState = unit ? await systemdUnitState(unit) : "inactive";
    if (unitState === "active") return "active";
    const lockState = await preparedOperationLockState(prepared.operationId, { ignoreLockOwner });
    if (lockState === "active") return "active";
    if (
      processState === "unknown"
      || workerState === "unknown"
      || unitState === "unknown"
      || lockState === "unknown"
    ) return "unknown";
    if (
      (lockState === "inactive" || lockState === null)
      && processState === "inactive"
      && workerState !== "active"
      && unitState === "inactive"
    ) return "inactive";
    return "unknown";
  }

  const unit = deploymentOperationUnit(prepared.operationId);
  return unit ? systemdUnitState(unit) : "unknown";
}

async function verifiedRecoveryOwnerExited(prepared, { ignoreLockOwner = null } = {}) {
  const processState = await processFingerprintState(prepared.ownerPid, prepared.ownerStartTicks);
  if (processState === "active") return false;
  const unit = deploymentOperationUnit(prepared.operationId);
  if (unit && await systemdUnitState(unit) !== "inactive") return false;
  const workerState = await preparedDeploymentWorkerState(prepared);
  if (workerState !== null && workerState !== "inactive") return false;
  const lockState = await preparedOperationLockState(prepared.operationId, { ignoreLockOwner });
  if (lockState === "active" || lockState === "unknown") return false;
  return true;
}

async function preparedDeploymentWorkerState(prepared) {
  if (
    prepared.schemaVersion < 4
    || !Number.isSafeInteger(prepared.deploymentWorkerPid)
    || prepared.deploymentWorkerPid <= 1
    || !/^\d+$/.test(prepared.deploymentWorkerStartTicks || "")
  ) return null;
  return processFingerprintState(prepared.deploymentWorkerPid, prepared.deploymentWorkerStartTicks);
}

async function preparedOperationLockState(preparedOperationId, { ignoreLockOwner = null } = {}) {
  const definition = preparedOperationLockDefinition(preparedOperationId);
  if (!definition) return null;
  try {
    const observed = await inspectOperationLock(definition.filePath, {
      ...definition.options,
      expectedOperationId: preparedOperationId,
    });
    if (
      ignoreLockOwner
      && observed.record?.pid === ignoreLockOwner.pid
      && observed.record?.startTicks === ignoreLockOwner.startTicks
    ) return "inactive";
    return observed.state;
  } catch {
    return "unknown";
  }
}

function preparedOperationLockDefinition(preparedOperationId) {
  if (/^wfl-codex-(?:release|rollback)-/.test(preparedOperationId)) {
    return {
      filePath: path.join(runtimeDir, "release.lock"),
      options: {
        acceptedCommands: RELEASE_LOCK_ACCEPTED_COMMANDS,
        requiredArguments: ["--worker"],
      },
    };
  }
  if (/^wfl-codex-app-update-/.test(preparedOperationId)) {
    return {
      filePath: path.join(runtimeDir, "app-update.lock"),
      options: {
        acceptedCommands: ["scripts/update-app.mjs"],
        requiredArguments: ["--worker"],
      },
    };
  }
  if (/^wfl-codex-update-/.test(preparedOperationId)) {
    return {
      filePath: path.join(runtimeDir, "codex-update.lock"),
      options: {
        acceptedCommands: ["scripts/update-codex.mjs"],
        requiredArguments: ["--worker"],
      },
    };
  }
  return null;
}

async function processFingerprintState(pid, expectedStartTicks) {
  try {
    const currentStartTicks = await readProcessStartTicks(pid);
    return currentStartTicks === expectedStartTicks ? "active" : "inactive";
  } catch {
    return "unknown";
  }
}

async function readProcessStartTicks(pid) {
  let stat;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) throw new Error(`Cannot parse process ${pid} identity`);
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  if (fields[0] === "Z") return null;
  const startTicks = fields[19];
  if (!/^\d+$/.test(startTicks || "")) throw new Error(`Cannot parse process ${pid} start time`);
  return startTicks;
}

async function systemdUnitState(unit) {
  const result = await capture(systemctl, ["is-active", unit]);
  const state = result.stdout.trim();
  if (["active", "activating", "reloading", "deactivating"].includes(state)) return "active";
  if (["inactive", "failed", "unknown"].includes(state) && [0, 3, 4].includes(result.code)) return "inactive";
  return "unknown";
}

async function prepareRelease(releaseVersion) {
  const reusableRelease = await resolveReusableRelease(releaseVersion);
  if (reusableRelease) return reusableRelease;

  const releaseDirectory = releaseDirectoryForVersion(releaseVersion);
  if (await exists(releaseDirectory)) {
    await verifyReleaseDirectory(releaseDirectory, releaseVersion);
    await fs.access(path.join(releaseDirectory, "node_modules"));
    return releaseDirectory;
  }

  const candidateSuffix = candidateSourceCommit ? `-${candidateSourceCommit.slice(0, 12)}` : "";
  const archiveName = `wfl-codex-desktop-v${releaseVersion}${candidateSuffix}.tar.gz`;
  const archivePath = path.join(backupDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  await verifyChecksum(archivePath, checksumPath);

  stagingDirectory = path.join(runtimeDir, `.staging-v${releaseVersion}-${process.pid}`);
  await fs.rm(stagingDirectory, { recursive: true, force: true });
  await fs.mkdir(stagingDirectory, { recursive: true, mode: 0o755 });
  await run("tar", [
    "--extract",
    "--gzip",
    "--file",
    archivePath,
    "--directory",
    stagingDirectory,
    "--strip-components=1",
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  await fs.symlink(path.join(projectDir, "node_modules"), path.join(stagingDirectory, "node_modules"));
  await verifyReleaseDirectory(stagingDirectory, releaseVersion);
  await fs.rename(stagingDirectory, releaseDirectory);
  stagingDirectory = null;
  return releaseDirectory;
}

async function resolveReusableRelease(releaseVersion) {
  const activeReleaseDirectory = await activeReleaseDirectoryForVersion(releaseVersion);
  if (!activeReleaseDirectory) return null;
  await verifyReleaseDirectory(activeReleaseDirectory, releaseVersion);
  await fs.access(path.join(activeReleaseDirectory, "node_modules"));
  return activeReleaseDirectory;
}

async function activeReleaseDirectoryForVersion(releaseVersion) {
  const activePort = await readActivePort({ allowMissing: true });
  if (activePort === null) return null;
  let activeReleaseDirectory;
  try {
    activeReleaseDirectory = await fs.realpath(path.join(slotsDir, String(activePort)));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!isValidReleaseDirectory(activeReleaseDirectory, releaseVersion)) return null;
  if (
    candidateSourceCommit
    && path.basename(activeReleaseDirectory) !== `v${releaseVersion}-${candidateSourceCommit.slice(0, 12)}`
  ) {
    return null;
  }
  return path.resolve(activeReleaseDirectory);
}

async function verifyReleaseDirectory(directory, expectedVersion) {
  const [packageJson, packageManifest] = await Promise.all([
    fs.readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(directory, ".codex-package.json"), "utf8").then(JSON.parse),
  ]);
  if (
    packageJson.version !== expectedVersion
    || packageManifest.version !== expectedVersion
    || packageManifest.name !== packageJson.name
  ) {
    throw new Error(`Release package is v${packageJson.version}, expected v${expectedVersion}`);
  }
  await assertReleaseVersionMetadata(directory, { expectedVersion });
  if (candidateSourceCommit && packageManifest.sourceCommit !== candidateSourceCommit) {
    throw new Error(`Release package source is ${packageManifest.sourceCommit || "unknown"}, expected ${candidateSourceCommit}`);
  }
  const runtimeAssets = [
    fs.access(path.join(directory, "server.mjs")),
    fs.access(path.join(directory, "public", "index.html")),
    fs.access(path.join(directory, "public", "ops.html")),
  ];
  const controlAssets = packageManifest.capabilities?.includes("deployment-recovery-v1") ? [
    "lib/backup-center.mjs",
    "lib/codex-install-recovery.mjs",
    "lib/deployment-cancel.mjs",
    "lib/deployment-operation.mjs",
    "lib/deployment-recovery-status.mjs",
    "lib/deployment-watchdog.mjs",
    "lib/maintenance-drain.mjs",
    "lib/operation-lock.mjs",
    "lib/persistent-state-admission.mjs",
    "lib/release-version-metadata.mjs",
    "lib/restore-operation-lock.mjs",
    "lib/restore-service-state.mjs",
    "lib/restore-swap-journal.mjs",
    "lib/workspace-migration.mjs",
    "public/users.html",
    "public/users.css",
    "public/users.js",
    "scripts/recover-codex-update.mjs",
    "scripts/recover-interrupted-deployment.mjs",
    "scripts/recover-data-restore.mjs",
    "scripts/restore-data-backup.mjs",
    "scripts/watch-deployment.mjs",
    "systemd/wfl-codex-desktop-codex-recovery.service",
    "systemd/wfl-codex-desktop-codex-recovery.service.template",
    "systemd/wfl-codex-desktop-deployment-recovery.service",
    "systemd/wfl-codex-desktop-deployment-recovery.service.template",
    "systemd/wfl-codex-desktop-restore-recovery.service",
    "systemd/wfl-codex-desktop-restore-recovery.service.template",
  ].map((relativePath) => fs.access(path.join(directory, relativePath))) : [];
  const standbyAssets = packageManifest.capabilities?.includes("main-standby-handoff-v1") ? [
    "lib/backend-authority.mjs",
    "scripts/backend-entry.mjs",
    "systemd/wfl-codex-desktop-backend@.service",
    "systemd/wfl-codex-desktop-backend@.service.template",
  ].map((relativePath) => fs.access(path.join(directory, relativePath))) : [];
  const codexRuntimeBundleAssets = packageManifest.capabilities?.includes(CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY)
    ? CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
    : [];
  const imageExecutionAssets = packageManifest.capabilities?.includes(IMAGE_EXECUTION_PACKAGE_CAPABILITY)
    ? IMAGE_EXECUTION_PACKAGE_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
    : [];
  const mapEditorAssets = packageManifest.capabilities?.includes(MAP_EDITOR_PACKAGE_CAPABILITY)
    ? MAP_EDITOR_PACKAGE_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
    : [];
  const mapEditorDependencies = packageManifest.capabilities?.includes(MAP_EDITOR_PACKAGE_CAPABILITY)
    ? MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS.map((relativePath) => fs.access(path.join(directory, relativePath)))
    : [];
  // Main-site deployments deliberately do not validate or depend on rescue
  // assets. The independently frozen rescue component has its own explicit
  // update path and must remain outside ordinary release activation.
  await Promise.all([
    ...runtimeAssets,
    ...controlAssets,
    ...standbyAssets,
    ...codexRuntimeBundleAssets,
    ...imageExecutionAssets,
    ...mapEditorAssets,
    ...mapEditorDependencies,
  ]);
  return { packageJson, packageManifest };
}

async function releaseRequiresCodexRuntimeBundle(directory) {
  const packageManifest = JSON.parse(
    await fs.readFile(path.join(directory, ".codex-package.json"), "utf8"),
  );
  return packageManifest.capabilities?.includes(CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY) === true;
}

async function verifyChecksum(archivePath, checksumPath) {
  const archiveBytes = await fs.readFile(archivePath);
  const digest = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  let checksumText;
  try {
    checksumText = await fs.readFile(checksumPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A process can be terminated after the archive rename and before the
    // sidecar rename.  The archive was already copied and fsynced by the
    // publisher; recover the missing sidecar without accepting a stale or
    // mismatched checksum.  The link publication is no-overwrite so a
    // concurrent deploy/backup process wins deterministically and is read
    // back below.
    await publishMissingChecksum(checksumPath, `${digest}  ${path.basename(archivePath)}\n`);
    checksumText = await fs.readFile(checksumPath, "utf8");
  }
  const checksum = checksumText.trim().split(/\s+/, 1)[0];
  if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error("Invalid release checksum file");
  if (digest.toLowerCase() !== checksum.toLowerCase()) throw new Error("Release archive checksum mismatch");
}

async function publishMissingChecksum(destination, content) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(content);
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      // Hard-linking the fully synced temporary file is an atomic no-overwrite
      // publication on the same filesystem.  It avoids leaving a partially
      // written checksum if this recovery process is interrupted.
      await fs.link(temporary, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await syncDirectory(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function waitForCandidate(port, expectedVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    try {
      const requestTimeoutMs = Math.max(1, Math.min(2_000, deadline - Date.now()));
      const response = await fetch(`http://${backendHost}:${port}/internal/codex-ready`, {
        headers: { Host: `${backendHost}:${port}` },
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const data = await response.json();
      lastStatus = JSON.stringify(data);
      if (
        response.ok &&
        (expectedVersion === null || data.version === expectedVersion) &&
        data.codexReady === true &&
        data.threadListReady === true &&
        data.runtimeBundleReady === true &&
        data.codeModeHostReady === true &&
        typeof data.codexTarget === "string" &&
        data.codexTarget.length > 0 &&
        /^[a-f0-9]{64}$/iu.test(data.codexRuntimeSha256 || "") &&
        /^[a-f0-9]{64}$/iu.test(data.codexCodeModeHostSha256 || "")
      ) return;
    } catch (error) {
      lastStatus = error.message;
    }
    if (Date.now() < deadline) await delay(Math.min(500, deadline - Date.now()));
  }
  const label = expectedVersion === null ? "backend" : `candidate v${expectedVersion}`;
  throw new Error(`${label} on port ${port} was not ready: ${lastStatus}`);
}

async function waitForStandby(
  port,
  expectedVersion,
  timeoutMs,
  { requireCodexRuntimeBundle = false } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    try {
      const requestTimeoutMs = Math.max(1, Math.min(2_000, deadline - Date.now()));
      const response = await fetch(`http://${backendHost}:${port}/internal/standby-ready`, {
        headers: { Host: `${backendHost}:${port}` },
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const data = await response.json();
      lastStatus = JSON.stringify(data);
      if (
        response.ok
        && data.ok === true
        && data.version === expectedVersion
        && data.port === port
        && data.standby === true
        && data.primary === false
        && validBackendInstanceId(data.backendInstanceId)
        && (!requireCodexRuntimeBundle || (
          data.runtimeBundleRequired === true
          && data.runtimeBundleReady === true
          && data.codeModeHostReady === true
          && typeof data.codexVersion === "string"
          && data.codexVersion.length > 0
          && typeof data.codexTarget === "string"
          && data.codexTarget.length > 0
          && /^[a-f0-9]{64}$/iu.test(data.codexRuntimeSha256 || "")
          && /^[a-f0-9]{64}$/iu.test(data.codexCodeModeHostSha256 || "")
        ))
      ) return data;
    } catch (error) {
      lastStatus = error.message;
    }
    if (Date.now() < deadline) await delay(Math.min(250, deadline - Date.now()));
  }
  throw new Error(`candidate standby v${expectedVersion} on port ${port} was not ready: ${lastStatus}`);
}

async function inspectBackendIdentity(port) {
  const response = await fetch(`http://${backendHost}:${port}/internal/backend-identity`, {
    headers: { Host: `${backendHost}:${port}` },
    cache: "no-store",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Backend identity probe returned HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.ok || !validBackendInstanceId(data.backendInstanceId)) {
    throw new Error("Backend identity probe returned an invalid identity");
  }
  return data;
}

async function waitForGateway(expectedPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    try {
      const requestTimeoutMs = Math.max(1, Math.min(2_000, deadline - Date.now()));
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/internal/gateway-ready`, {
        headers: { Host: `127.0.0.1:${gatewayPort}` },
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const data = await response.json();
      lastStatus = JSON.stringify(data);
      if (response.ok && data.ok === true && data.upstreamPort === expectedPort) return;
    } catch (error) {
      lastStatus = error.message;
    }
    if (Date.now() < deadline) await delay(Math.min(250, deadline - Date.now()));
  }
  throw new Error(`Stable gateway did not select backend ${expectedPort}: ${lastStatus}`);
}

async function readActivePort({ allowMissing = false } = {}) {
  try {
    const port = Number((await fs.readFile(activePortFile, "utf8")).trim());
    if (!backendPorts.includes(port)) throw new Error(`Invalid active backend port: ${port}`);
    return port;
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return null;
    throw error;
  }
}

async function replaceSymlink(destination, target) {
  const temporary = path.join(slotsDir, `.${path.basename(destination)}-${process.pid}`);
  await fs.rm(temporary, { force: true });
  await fs.symlink(target, temporary);
  await fs.rename(temporary, destination);
  await syncDirectory(path.dirname(destination));
}

async function restoreSymlink(destination, previousTarget) {
  if (previousTarget === null) {
    await fs.rm(destination, { force: true });
    await syncDirectory(path.dirname(destination));
    return;
  }
  await replaceSymlink(destination, previousTarget);
}

async function readLink(candidate) {
  try {
    return await fs.readlink(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(destination, content, mode = 0o644, beforeCommit = null) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (beforeCommit) await beforeCommit();
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveLink(slotPath, target) {
  if (typeof target !== "string" || !target) return null;
  return path.resolve(path.dirname(slotPath), target);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function run(command, args, {
  allowFailure = false,
  timeoutMs = command === systemctl ? systemctlTimeoutMs : null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectDir, stdio: "inherit" });
    let settled = false;
    let timedOut = false;
    const timeoutError = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
    const finish = (error, value = undefined) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGKILL");
      // Wait for close so a timed-out systemctl child has been reaped before
      // recovery makes another topology decision.
    }, timeoutMs);
    timeout?.unref?.();
    child.on("error", (error) => {
      if (timedOut) finish(allowFailure ? null : timeoutError, false);
      else if (allowFailure) finish(null, false);
      else finish(error);
    });
    child.on("close", (code) => {
      if (timedOut) finish(allowFailure ? null : timeoutError, false);
      else if (code === 0 || allowFailure) finish(null, code === 0);
      else finish(new Error(`${command} ${args.join(" ")} exited with status ${code}`));
    });
  });
}

function capture(command, args, { timeoutMs = command === systemctl ? systemctlTimeoutMs : null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout });
    }, timeoutMs);
    timeout?.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1024) stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ code: null, stdout: "" });
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve({ code, stdout });
      }
    });
  });
}

function boundedDuration(value, label, { min, max }) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < min || duration > max) {
    throw new Error(`Invalid ${label}`);
  }
  return duration;
}

function parsePorts(value) {
  const ports = [...new Set(String(value).split(",").map(Number))];
  if (ports.length !== 2 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Exactly two valid backend ports are required");
  }
  return ports;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return process.argv[index + 1];
}

function validateDeployArguments({ help = false } = {}) {
  const args = process.argv.slice(2);
  const valueOptions = new Set(["--operation-id", "--version"]);
  const flagOptions = new Set([
    "--prepare-only",
    "--preflight",
    "--stage",
    "--activate-staged",
    "--discard-staged",
    "--recover-staged",
    "--finalize-staged",
    "--defer-finalize",
  ]);
  if (help) {
    if (args.length !== 1 || !["--help", "-h"].includes(args[0])) {
      throw new Error("Deployment help cannot be combined with another action");
    }
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      continue;
    }
    if (!flagOptions.has(argument)) throw new Error(`Unknown deployment argument: ${argument}`);
  }
}

function validOperationId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value);
}

function deploymentWatchToken() {
  const token = process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN || "";
  if (!validWatchToken(token)) throw new Error("A verified deployment recovery watchdog is required");
  return token;
}

function validWatchToken(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function validDrainToken(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= 128;
}

function validBackendInstanceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function destructiveDeploymentState(value) {
  return [
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
  ].includes(value);
}

function validVersion(value) {
  return typeof value === "string"
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function exists(candidate) {
  return fs.access(candidate).then(() => true, () => false);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
