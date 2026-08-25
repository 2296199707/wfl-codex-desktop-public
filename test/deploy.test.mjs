import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BackupCenter } from "../lib/backup-center.mjs";
import { BackendAuthorityStore } from "../lib/backend-authority.mjs";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { MultiUserStore } from "../lib/multi-user-store.mjs";
import { OpsRollbackStore } from "../lib/ops-rollback-store.mjs";
import {
  CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS,
  CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
  MAP_EDITOR_PACKAGE_ASSETS,
  MAP_EDITOR_PACKAGE_CAPABILITY,
  MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS,
} from "../lib/package-source.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";
import { TemporarySshAccessService } from "../lib/temporary-ssh-access.mjs";
import { WorkspaceMigrationCenter } from "../lib/workspace-migration.mjs";

const deployPath = fileURLToPath(new URL("../scripts/deploy.mjs", import.meta.url));
const deploy = await fs.readFile(new URL("../scripts/deploy.mjs", import.meta.url), "utf8");
const backup = await fs.readFile(new URL("../scripts/backup.mjs", import.meta.url), "utf8");
const archivePublisher = await fs.readFile(
  new URL("../lib/immutable-archive-publisher.mjs", import.meta.url),
  "utf8",
);
const release = await fs.readFile(new URL("../scripts/release.mjs", import.meta.url), "utf8");
const codexUpdate = await fs.readFile(new URL("../scripts/update-codex.mjs", import.meta.url), "utf8");
const appUpdate = await fs.readFile(new URL("../scripts/update-app.mjs", import.meta.url), "utf8");
const quickUpdateCheck = await fs.readFile(new URL("../scripts/quick-update-check.mjs", import.meta.url), "utf8");
const deploymentWatch = await fs.readFile(
  new URL("../scripts/watch-deployment.mjs", import.meta.url),
  "utf8",
);
const promoteCandidate = await fs.readFile(
  new URL("../scripts/promote-release-candidate.mjs", import.meta.url),
  "utf8",
);
const rollback = await fs.readFile(new URL("../scripts/rollback.mjs", import.meta.url), "utf8");
const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
const backendEntry = await fs.readFile(new URL("../scripts/backend-entry.mjs", import.meta.url), "utf8");
const runTests = await fs.readFile(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const gatewayUnit = await fs.readFile(
  new URL("../systemd/wfl-codex-desktop-gateway.service", import.meta.url),
  "utf8",
);
const backendUnit = await fs.readFile(
  new URL("../systemd/wfl-codex-desktop-backend@.service", import.meta.url),
  "utf8",
);
const recoveryCapabilityFiles = [
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
  "scripts/restore-data-backup.mjs",
  "scripts/recover-data-restore.mjs",
  "scripts/recover-codex-update.mjs",
  "scripts/recover-interrupted-deployment.mjs",
  "scripts/watch-deployment.mjs",
  "systemd/wfl-codex-desktop-deployment-recovery.service",
  "systemd/wfl-codex-desktop-deployment-recovery.service.template",
  "systemd/wfl-codex-desktop-codex-recovery.service",
  "systemd/wfl-codex-desktop-codex-recovery.service.template",
  "systemd/wfl-codex-desktop-restore-recovery.service",
  "systemd/wfl-codex-desktop-restore-recovery.service.template",
];
const fixtureReleaseFiles = [
  "package.json",
  "VERSION",
  "CHANGELOG.md",
  "server.mjs",
  "lib/backend-authority.mjs",
  "scripts/backend-entry.mjs",
  "systemd/wfl-codex-desktop-backend@.service",
  "systemd/wfl-codex-desktop-backend@.service.template",
  "public/index.html",
  "public/app.js",
  "public/ops.html",
  ...recoveryCapabilityFiles,
  ...CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS,
];
const restoreRecoveryUnit = await fs.readFile(
  new URL("../systemd/wfl-codex-desktop-restore-recovery.service", import.meta.url),
  "utf8",
);

test("deployment transfers a fenced standby before retiring the old backend", () => {
  const deployment = functionBlock("deployStandbyCandidate", "deployLegacyCandidate");
  assert.ok(deployment, "deployment function was not found");
  const commit = deployment.indexOf("commitActivationDecision");
  const writerTransfer = deployment.indexOf("backendAuthorityStore.claim");
  const activePortWrite = deployment.search(/atomicWrite\(\s*activePortFile/);
  const activateCandidate = deployment.indexOf("activateBackend(candidatePort");
  const waitCandidate = deployment.indexOf("waitForCandidate");
  const waitGateway = deployment.indexOf("waitForGateway(candidatePort");
  const stopOld = deployment.indexOf('["stop", oldUnit]');
  const disableOld = deployment.indexOf('["disable", "--no-reload", oldUnit]');
  assert.ok(commit < writerTransfer && writerTransfer < activePortWrite);
  assert.ok(activateCandidate < waitCandidate && waitCandidate < activePortWrite);
  assert.ok(waitCandidate < waitGateway && waitGateway < stopOld && stopOld < disableOld);
  assert.match(deployment, /waitForGateway\(candidatePort/);
  assert.doesNotMatch(deploy, /ensureActiveRescueService|enable", "--now", `wfl-codex-desktop-rescue@/);
  assert.match(deployment, /start", "wfl-codex-desktop-gateway\.service/);
  assert.match(deployment, /rollbackStandbyHandoff/);
  assert.match(deployment, /Deployment aborted; the previous backend remained available/);
  assert.match(deploy, /\/internal\/codex-ready/);
  assert.match(deploy, /data\.threadListReady === true/);
  assert.match(deploy, /CODEX_DESKTOP_READY_TIMEOUT_MS \|\| 180_000/);
  assert.match(deploy, /Math\.min\(2_000, deadline - Date\.now\(\)\)/);
  assert.match(server, /codexReadinessProbe\?\.child === child/);
  assert.match(server, /CODEX_READINESS_PROBE_TIMEOUT_MS/);
  assert.match(server, /backendIsSelectedAtStartup\(RELEASE_RUNTIME_DIR, PORT, \{/);
  assert.match(backendEntry, /startPrimary\(\{ allowUnselected: true \}\)/);
  assert.match(server, /BACKEND_PROMOTE_UNSELECTED/);
  assert.match(server, /allowUnselected: BACKEND_PROMOTE_UNSELECTED/);
  assert.match(server, /error\.code === "ENOENT"[\s\S]*?allowUnselected[\s\S]*?backendInstanceId[\s\S]*?writerEpoch/);
  assert.match(server, /Cannot verify bootstrap writer authority/);
  assert.match(server, /new BackendAuthorityStore\(runtimeDirectory\)\.assertCurrent\(\{/);
  const startupAuthorityCheck = server.indexOf("new BackendAuthorityStore(runtimeDirectory).assertCurrent({");
  const startupPromotionReturn = server.indexOf("return selected || allowUnselected;");
  assert.ok(
    startupAuthorityCheck >= 0
      && startupPromotionReturn >= 0
      && startupAuthorityCheck < startupPromotionReturn,
  );
  assert.match(deploy, /"public", "ops\.html"/);
  assert.match(deploy, /IMAGE_EXECUTION_PACKAGE_ASSETS/);
  assert.match(deploy, /IMAGE_EXECUTION_PACKAGE_CAPABILITY/);
  assert.match(deploy, /MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS/);
  assert.match(deploy, /CODEX_RUNTIME_BUNDLE_PACKAGE_ASSETS/);
  assert.doesNotMatch(deploy, /DEEPSEEK_HARNESS_SUBAGENT/);
  assert.doesNotMatch(release, /DEEPSEEK_HARNESS_SUBAGENT/);
  assert.match(deploy, /RECOVERY_SYSTEMCTL_TIMEOUT_MS = 1_500/);
  assert.match(deploy, /RECOVERY_READY_TIMEOUT_MS = 4_000/);
  assert.match(deploy, /RECOVERY_GATEWAY_TIMEOUT_MS = 3_000/);
});

test("abandoned recovery persists the candidate target before attempting fail-forward", () => {
  const recovery = functionBlock("recoverAbandonedPreparedDeployment", "cleanupPreparedCandidateWhileOldActive");
  assert.ok(recovery, "prepared deployment recovery function was not found");
  const persistCandidate = recovery.indexOf('recoveryTarget: "candidate"');
  const writeCandidate = recovery.indexOf("writePreparedDeployment(candidateRecovery)", persistCandidate);
  const restoreCandidate = recovery.indexOf("restorePreparedCandidateBackend(candidateRecovery", writeCandidate);
  assert.ok(persistCandidate >= 0 && persistCandidate < writeCandidate && writeCandidate < restoreCandidate);
  assert.match(recovery, /prepared\.recoveryTarget === "candidate"/);
  assert.match(recovery, /"cleanup-candidate", "restart-gateway-candidate"/);
  const oldRecovery = functionBlock("restorePreparedOldBackend", "restorePreparedCandidateBackend");
  const candidateRecovery = functionBlock("restorePreparedCandidateBackend", "cleanupPreparedCandidateAfterActivation");
  assert.ok(oldRecovery.indexOf('persistRecoveryPhase(gatewayReady, "old", "cleanup-old")') < oldRecovery.indexOf("removePreparedDeployment()"));
  assert.ok(candidateRecovery.indexOf('persistRecoveryPhase(gatewayReady, "candidate", "cleanup-candidate")') < candidateRecovery.indexOf("removePreparedDeployment()"));
});

test("an existing verified release is reusable before ignored archive artifacts are created", () => {
  const preparation = functionBlock("prepareRelease", "verifyReleaseDirectory");
  assert.ok(preparation, "release preparation function was not found");
  const existingRelease = preparation.indexOf("if (await exists(releaseDirectory))");
  const checksum = preparation.indexOf("await verifyChecksum(archivePath, checksumPath)");
  assert.ok(existingRelease >= 0 && existingRelease < checksum);
  assert.match(deploy, /candidateSourceCommit/);
  assert.match(deploy, /releaseDirectoryForVersion/);
  assert.match(deploy, /wfl-codex-desktop-v\$\{releaseVersion\}\$\{candidateSuffix\}\.tar\.gz/);
  assert.match(backup, /wfl-codex-desktop-v\$\{version\}\$\{candidateSuffix\}\.tar\.gz/);
});

test("a newly extracted release links shared dependencies before runtime verification", () => {
  const preparation = functionBlock("prepareRelease", "verifyReleaseDirectory");
  assert.ok(preparation, "release preparation function was not found");
  const extractArchive = preparation.indexOf('await run("tar", [');
  const linkDependencies = preparation.indexOf(
    'await fs.symlink(path.join(projectDir, "node_modules"), path.join(stagingDirectory, "node_modules"))',
    extractArchive,
  );
  const verifyStaging = preparation.indexOf(
    "await verifyReleaseDirectory(stagingDirectory, releaseVersion)",
    extractArchive,
  );
  const publishRelease = preparation.indexOf(
    "await fs.rename(stagingDirectory, releaseDirectory)",
    extractArchive,
  );
  assert.ok(
    extractArchive >= 0
      && extractArchive < linkDependencies
      && linkDependencies < verifyStaging
      && verifyStaging < publishRelease,
  );
  assert.match(deploy, /if \(stagingDirectory\) await fs\.rm\(stagingDirectory, \{ recursive: true, force: true \}\)/);
});

test("archive preparation verifies map runtime dependencies through the staging link", async () => {
  const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const releaseVersion = `0.0.0-prepare-order-${unique}`;
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-archive-prepare-"));
  const sourceRoot = path.join(fixtureRoot, `wfl-codex-desktop-v${releaseVersion}`);
  const runtimeDirectory = path.join(fixtureRoot, "runtime");
  const archivePath = path.join(
    process.cwd(),
    "backups",
    `wfl-codex-desktop-v${releaseVersion}.tar.gz`,
  );
  const checksumPath = `${archivePath}.sha256`;
  try {
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    const requiredFiles = new Set([
      "server.mjs",
      "public/index.html",
      "public/ops.html",
      ...MAP_EDITOR_PACKAGE_ASSETS,
    ]);
    for (const relativePath of requiredFiles) {
      const destination = path.join(sourceRoot, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, "archive preparation fixture\n");
    }
    await fs.writeFile(path.join(sourceRoot, "VERSION"), `${releaseVersion}\n`);
    await fs.writeFile(
      path.join(sourceRoot, "public", "app.js"),
      `const UI_VERSION = "${releaseVersion}";\nconst UI_VERSION_LABEL = "${releaseVersion}";\n`,
    );
    await fs.writeFile(
      path.join(sourceRoot, "public", "index.html"),
      `<html data-version="${releaseVersion}" data-asset-version="${releaseVersion}"></html>\n`,
    );
    await fs.writeFile(
      path.join(sourceRoot, "public", "character-editor", "character-editor.js"),
      "const imageStudio = import(`/image-studio.js?v=${encodeURIComponent(ASSET_VERSION)}`);\n",
    );
    await fs.writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify({
      name: packageJson.name,
      version: releaseVersion,
    })}\n`);
    await fs.writeFile(path.join(sourceRoot, ".codex-package.json"), `${JSON.stringify({
      format: 2,
      name: packageJson.name,
      version: releaseVersion,
      sourceCommit: "0".repeat(40),
      capabilities: [MAP_EDITOR_PACKAGE_CAPABILITY],
    })}\n`);
    await runProcess("tar", [
      "--create",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      fixtureRoot,
      path.basename(sourceRoot),
    ]);

    await runDeploy(["--prepare-only", "--version", releaseVersion], {
      ...process.env,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_UPSTREAM_PORTS: "4318,4319",
    });

    const releaseDirectory = path.join(runtimeDirectory, "releases", `v${releaseVersion}`);
    assert.equal(
      await fs.readlink(path.join(releaseDirectory, "node_modules")),
      path.join(process.cwd(), "node_modules"),
    );
    const repairedChecksum = await fs.readFile(checksumPath, "utf8");
    const digest = crypto.createHash("sha256").update(await fs.readFile(archivePath)).digest("hex");
    assert.equal(repairedChecksum.trim(), `${digest}  ${path.basename(archivePath)}`);
    for (const relativePath of MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS) {
      await fs.access(path.join(releaseDirectory, relativePath));
    }
    assert.deepEqual(
      (await fs.readdir(runtimeDirectory)).filter((name) => name.startsWith(`.staging-v${releaseVersion}-`)),
      [],
    );
  } finally {
    await Promise.all([
      fs.rm(fixtureRoot, { recursive: true, force: true }),
      fs.rm(archivePath, { force: true }),
      fs.rm(checksumPath, { force: true }),
    ]);
  }
});

test("same-version staging reuses the verified active commit-suffixed release", async () => {
  await withDeploymentFixture(async (fixture) => {
    const sourceCommit = "a".repeat(40);
    const activeRelease = path.join(
      fixture.runtimeDirectory,
      "releases",
      `v${packageJson.version}-${sourceCommit.slice(0, 12)}`,
    );
    await fs.rm(fixture.releaseDirectory, { recursive: true, force: true });
    await seedVerifiedRelease(activeRelease, { sourceCommit });
    await fs.symlink(activeRelease, fixture.bootstrapSlot);

    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);

    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    assert.equal(prepared.releaseDirectory, activeRelease);
    assert.equal(await fs.realpath(fixture.candidateSlot), activeRelease);
  });
});

test("deployment preflight verifies the selected release without changing topology", async () => {
  await withDeploymentFixture(async (fixture) => {
    const activeSlot = path.join(fixture.runtimeDirectory, "slots", String(fixture.activePort));
    await fs.symlink(fixture.releaseDirectory, activeSlot);
    const beforeCandidate = await fs.readlink(fixture.candidateSlot);
    const output = await fixture.run(["--preflight", "--version", packageJson.version]);
    assert.match(output, /Deployment preflight passed/);
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(activeSlot), fixture.releaseDirectory);
    assert.equal(await fs.readlink(fixture.candidateSlot), beforeCandidate);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const calls = await fs.readFile(fixture.systemctlLog, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert.equal(calls, "");
  });
});

test("staged deployment runs a lightweight standby without selecting or enabling it", () => {
  const recoveryGates = functionBlock("verifyBackendRecoveryGates", "stageCandidate");
  const stage = functionBlock("stageCandidate", "activatePreparedDeployment");
  const activate = functionBlock("activatePreparedDeployment", "deployCandidate");
  const deployment = functionBlock("deployStandbyCandidate", "deployLegacyCandidate");
  assert.ok(recoveryGates && stage && activate && deployment);
  const restoreGate = recoveryGates.indexOf('"wfl-codex-desktop-restore-recovery.service"');
  const codexGate = recoveryGates.indexOf('"wfl-codex-desktop-codex-recovery.service"');
  assert.ok(restoreGate >= 0 && restoreGate < codexGate);
  assert.match(recoveryGates, /\["start", unit\], \{ timeoutMs: RECOVERY_GATE_TIMEOUT_MS \}/);
  assert.match(deploy, /RECOVERY_GATE_TIMEOUT_MS = 95_000/);
  assert.ok(stage.indexOf("verifyBackendRecoveryGates") < stage.indexOf("writePreparedDeployment(prepared)"));
  assert.ok(stage.indexOf("verifyBackendRecoveryGates") < stage.indexOf("replaceSymlink"));
  assert.ok(stage.indexOf('stageState: "preparing"') < stage.indexOf("replaceSymlink"));
  assert.ok(stage.indexOf("writePreparedDeployment(prepared)") < stage.indexOf("replaceSymlink"));
  assert.doesNotMatch(stage, /\["restart", candidateUnit\]/);
  assert.match(stage, /\["start", candidateUnit\]/);
  assert.match(stage, /waitForStandby\(\s*candidatePort/);
  assert.doesNotMatch(stage, /waitForCandidate\(candidatePort/);
  assert.doesNotMatch(stage, /\["enable", candidateUnit\]/);
  assert.doesNotMatch(stage, /atomicWrite\(activePortFile/);
  assert.match(deploy, /function writePreparedDeployment[\s\S]*?0o600/);
  assert.match(activate, /prepared\.operationId !== operationId/);
  assert.match(activate, /activePort !== prepared\.activePort/);
  assert.match(activate, /assertPreparedDeploymentWatchdogActive\(prepared\)/);
  assert.match(deployment, /persist\("writer-transferred"/);
  assert.match(deployment, /persist\("candidate-selected"/);
  assert.match(deployment, /persist\("gateway-confirmed"/);
  assert.ok(deployment.indexOf("prepareBackendAuthHandoff(activePort)") < deployment.indexOf("backendAuthorityStore.claim"));
  assert.ok(deployment.indexOf("commitActivationDecision") < deployment.indexOf("backendAuthorityStore.claim"));
  assert.ok(deployment.indexOf("activateBackend(candidatePort") < deployment.indexOf("waitForCandidate"));
  assert.ok(deployment.indexOf("waitForCandidate") < deployment.search(/atomicWrite\(\s*activePortFile/));
  assert.ok(deployment.indexOf("waitForGateway(candidatePort") < deployment.indexOf('["stop", oldUnit]'));
  assert.ok(deployment.indexOf('["stop", oldUnit]') < deployment.indexOf('["disable", "--no-reload", oldUnit]'));
  assert.ok(
    deployment.indexOf('["daemon-reload"]')
    < deployment.indexOf('["stop", oldUnit]'),
  );
  assert.ok(deployment.indexOf("renewDrainFence") < deployment.indexOf("commitActivationDecision"));
  assert.match(deployment, /renewDrainFence\(\{ throughDeadline: true \}\)/);
  assert.ok(
    deployment.indexOf("assertActivationDeadline(activationPreHandoffMinimumRemaining())")
      < deployment.indexOf("prepareBackendAuthHandoff(activePort)"),
  );
  assert.ok(
    deployment.indexOf("prepareBackendAuthHandoff(activePort)")
      < deployment.indexOf("assertActivationDeadline(activationWriterTransferMinimumRemaining())"),
  );
  assert.ok(
    deployment.indexOf("assertActivationDeadline(activationWriterTransferMinimumRemaining())")
      < deployment.indexOf("backendAuthorityStore.claim"),
  );
  assert.match(deploy, /cancelStore\.commit\(operationId\)/);
  assert.match(deploy, /drainStore\.renew\(token, \{ ttlMs: Math\.max/);
  assert.match(deploy, /CODEX_DESKTOP_DRAIN_DEADLINE_AT/);
  const atomicWrite = deploy.slice(
    deploy.indexOf("async function atomicWrite"),
    deploy.indexOf("function resolveLink"),
  );
  assert.ok(atomicWrite.indexOf("handle.sync()") < atomicWrite.indexOf("await beforeCommit()"));
  assert.ok(atomicWrite.indexOf("await beforeCommit()") < atomicWrite.indexOf("fs.rename"));
  assert.match(deploy, /DRAIN_COMPLETION_RESERVE_MS = DEPLOYMENT_RECOVERY_RESERVE_MS/);
  assert.match(deploy, /return \{ recoveryDeadlineAt, drainDeadlineAt: hardDeadlineAt \}/);
  assert.match(deploy, /value\.drainDeadlineAt - value\.recoveryDeadlineAt < DRAIN_COMPLETION_RESERVE_MS/);
  const interruptedRecovery = functionBlock(
    "recoverAbandonedPreparedDeployment",
    "cleanupPreparedCandidateWhileOldActive",
  );
  const destructiveOldRecovery = interruptedRecovery.indexOf("destructiveDeploymentState(prepared.stageState)");
  assert.ok(
    destructiveOldRecovery < interruptedRecovery.indexOf("restorePreparedOldBackend("),
  );
  assert.match(deploy, /await syncDirectory\(path\.dirname\(destination\)\)/);
  assert.match(deploy, /restoreSymlink\(slotPath, previousSlotTarget\)/);
  assert.match(deploy, /process\.argv\.includes\("--discard-staged"\)/);
  assert.match(deploymentWatch, /!\[3, 4\]\.includes\(manifest\.schemaVersion\)/);
  assert.match(deploymentWatch, /manifest\.schemaVersion === 4 && manifest\.activationMode !== "standby-handoff"/);
  for (const state of [
    "transferring-writer",
    "writer-transferred",
    "candidate-selected",
    "candidate-starting",
    "primary-ready",
    "gateway-confirmed",
    "retiring-old",
  ]) {
    assert.match(deploymentWatch, new RegExp(`"${state}"`));
  }
});

test("local beta candidates reuse the detached checked release worker", () => {
  assert.match(release, /CODEX_DESKTOP_LOCAL_CANDIDATE/);
  assert.match(release, /verifyLocalCandidateArchive/);
  assert.match(release, /wfl-codex-desktop-v\$\{version\}-\$\{suffix\}\.tar\.gz/);
  assert.match(release, /main-standby-handoff-v1/);
  assert.match(release, /IMAGE_EXECUTION_PACKAGE_CAPABILITY/);
  assert.doesNotMatch(release, /DEEPSEEK_HARNESS_SUBAGENT/);
  assert.match(release, /MAP_EDITOR_PACKAGE_CAPABILITY/);
  assert.match(release, /"--setenv=CODEX_DESKTOP_LOCAL_CANDIDATE=1"/);
  assert.equal(
    (release.match(/candidateMode \|\| localCandidateMode \|\| verifiedPackagePrereleaseMode\) validateVersion\(version\)/g) || []).length,
    2,
  );
  assert.ok(
    release.indexOf("if (localCandidateMode) {", release.indexOf("if (packageSource) {"))
      < release.indexOf("inspectPackageSource(projectDir)", release.indexOf("if (packageSource) {")),
  );
  assert.match(release, /"--no-block"/);
  assert.doesNotMatch(release, /"--pipe"/);
});

test("stage starts standby and activation confirms the candidate before retiring the old backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);

    const preparedPath = path.join(fixture.runtimeDirectory, "prepared-deployment.json");
    const prepared = JSON.parse(await fs.readFile(preparedPath, "utf8"));
    assert.deepEqual({
      operationId: prepared.operationId,
      version: prepared.version,
      activePort: prepared.activePort,
      candidatePort: prepared.candidatePort,
      previousSlotTarget: prepared.previousSlotTarget,
    }, {
      operationId: fixture.operationId,
      version: packageJson.version,
      activePort: fixture.activePort,
      candidatePort: fixture.candidatePort,
      previousSlotTarget: fixture.previousSlotTarget,
    });
    assert.equal(prepared.schemaVersion, 4);
    assert.equal(prepared.stageState, "ready");
    assert.equal(prepared.activationMode, "standby-handoff");
    assert.equal(prepared.candidateBackendInstanceId, "backend-instance-candidate");
    assert.equal(prepared.watchToken, fixture.watchToken);
    assert.ok(prepared.ownerPid > 1);
    assert.match(prepared.ownerStartTicks, /^\d+$/);
    assert.equal((await fs.stat(preparedPath)).mode & 0o777, 0o600);
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    const stageLog = await fs.readFile(fixture.systemctlLog, "utf8");
    const restoreGateIndex = stageLog.indexOf("start wfl-codex-desktop-restore-recovery.service");
    const codexGateIndex = stageLog.indexOf("start wfl-codex-desktop-codex-recovery.service");
    const candidateStopIndex = stageLog.indexOf(`stop wfl-codex-desktop-backend@${fixture.candidatePort}.service`);
    assert.ok(
      restoreGateIndex >= 0
      && restoreGateIndex < codexGateIndex
      && codexGateIndex < candidateStopIndex,
    );
    assert.match(stageLog, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.match(stageLog, new RegExp(`(?:^|\\n)start wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.doesNotMatch(stageLog, new RegExp(`(?:^|\\n)restart wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.doesNotMatch(stageLog, /probe candidate-ready/);
    assert.doesNotMatch(stageLog, /selector candidate|primary candidate/);
    const candidateEnable = `enable --no-reload wfl-codex-desktop-backend@${fixture.candidatePort}.service`;
    const stagedEnableCount = stageLog.split(candidateEnable).length - 1;
    assert.equal(stagedEnableCount, 0);
    assert.doesNotMatch(stageLog, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));

    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    await fixture.run(
      ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      activationEnvironment(drain),
    );

    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    const candidateAuthority = await new BackendAuthorityStore(fixture.runtimeDirectory).read();
    assert.equal(candidateAuthority.backendInstanceId, "backend-instance-candidate");
    assert.equal(candidateAuthority.port, fixture.candidatePort);
    await assert.rejects(fs.access(preparedPath), { code: "ENOENT" });
    assert.equal((await new ReleaseDrainStore(fixture.runtimeDirectory).read()).active, false);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);
    const activationLog = await fs.readFile(fixture.systemctlLog, "utf8");
    const stopOldIndex = activationLog.indexOf(`stop wfl-codex-desktop-backend@${fixture.activePort}.service`);
    const disableOldIndex = activationLog.indexOf(`disable --no-reload wfl-codex-desktop-backend@${fixture.activePort}.service`);
    const selectorIndex = activationLog.indexOf("selector candidate");
    const primaryIndex = activationLog.indexOf("primary candidate");
    const readinessIndex = activationLog.indexOf("probe candidate-ready", primaryIndex);
    const reloadIndex = activationLog.indexOf("daemon-reload");
    assert.ok(primaryIndex !== -1 && primaryIndex < readinessIndex && readinessIndex < selectorIndex);
    assert.ok(readinessIndex < reloadIndex && reloadIndex < stopOldIndex && stopOldIndex < disableOldIndex);
    assert.match(activationLog, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.equal(activationLog.split(candidateEnable).length - 1, stagedEnableCount + 1);
  });
});

test("activation transfers the durable worker fingerprint before selector commit", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const staged = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    let duringActivation = null;

    await fixture.runPausedBeforeSelectorCommit(
      ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      {
        CODEX_DESKTOP_FORCE_ACTIVATION: "1",
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: fixture.watchToken,
      },
      50,
      async () => {
        duringActivation = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
      },
    );

    assert.ok(duringActivation);
    assert.notEqual(duringActivation.deploymentWorkerPid, staged.deploymentWorkerPid);
    assert.match(duringActivation.deploymentWorkerStartTicks, /^\d+$/);
    assert.equal(duringActivation.stageState, "candidate-starting");
  });
});

test("force activation switches without a task-drain lease", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.run(
      ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      {
        CODEX_DESKTOP_FORCE_ACTIVATION: "1",
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: fixture.watchToken,
      },
    );
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    assert.equal((await new ReleaseDrainStore(fixture.runtimeDirectory).read()).active, false);
    const activationLog = await fs.readFile(fixture.systemctlLog, "utf8");
    const stopOldIndex = activationLog.indexOf(`stop wfl-codex-desktop-backend@${fixture.activePort}.service`);
    const selectorIndex = activationLog.indexOf("selector candidate");
    assert.ok(selectorIndex >= 0 && selectorIndex < stopOldIndex);
  });
});

test("legacy active backends without auth handoff remain upgrade compatible", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.setAuthHandoffSupported(false);
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.run(
      ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      {
        CODEX_DESKTOP_FORCE_ACTIVATION: "1",
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: fixture.watchToken,
      },
    );
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
  });
});

test("interrupted pre-authority auth handoff resumes the old backend before readiness recovery", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.prepareActiveAuthHandoff();
    await fixture.abandonPrepared({
      stageState: "transferring-writer",
      forcedActivation: true,
      authHandoffPrepared: true,
      authHandoffPreparedAt: Date.now(),
    });

    await fixture.run([
      "--recover-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.ok(log.indexOf("auth handoff prepare") < log.indexOf("auth handoff resume"));
  });
});

test("interrupted writer transfer restores a fenced old backend before readiness recovery", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.prepareActiveAuthHandoff();
    const candidateAuthority = await new BackendAuthorityStore(fixture.runtimeDirectory).claim({
      backendInstanceId: "backend-instance-candidate",
      port: fixture.candidatePort,
    });
    await fixture.abandonPrepared({
      stageState: "writer-transferred",
      forcedActivation: true,
      writerEpoch: candidateAuthority.writerEpoch,
    });

    await fixture.run([
      "--recover-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    const recoveredAuthority = await new BackendAuthorityStore(fixture.runtimeDirectory).read();
    assert.equal(recoveredAuthority.backendInstanceId, "backend-instance-active");
    assert.equal(recoveredAuthority.writerEpoch, candidateAuthority.writerEpoch + 1);
    assert.equal(recoveredAuthority.port, fixture.activePort);
    assert.ok(Number.isSafeInteger(recoveredAuthority.grantedAt));
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.ok(log.indexOf("auth handoff prepare") < log.indexOf("auth handoff resume"));
  });
});

test("force activation can defer finalization without inventing a task-drain lease", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.run(
      [
        "--activate-staged", "--defer-finalize",
        "--operation-id", fixture.operationId, "--version", packageJson.version,
      ],
      {
        CODEX_DESKTOP_FORCE_ACTIVATION: "1",
        CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: fixture.watchToken,
      },
    );

    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    assert.equal(prepared.stageState, "activated");
    assert.equal(prepared.forcedActivation, true);
    assert.equal(prepared.recoveryDeadlineAt, undefined);
    assert.equal(prepared.drainDeadlineAt, undefined);
    assert.equal(prepared.drainToken, undefined);
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);

    await fixture.run([
      "--finalize-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
  });
});

test("activation refuses to stop a backend from an unisolated controller", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.writeFile(fixture.systemctlLog, "");

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          CODEX_DESKTOP_FORCE_ACTIVATION: "1",
          FAKE_DEPLOY_CGROUP_UNIT: `wfl-codex-desktop-backend@${fixture.activePort}.service`,
        },
      ),
      /requires a controller outside the active backend systemd unit/,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("activation refuses to stop the old backend without a live recovery watchdog", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.writeFile(fixture.systemctlLog, "");

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          CODEX_DESKTOP_FORCE_ACTIVATION: "1",
          CODEX_DESKTOP_DEPLOYMENT_WATCH_TEST_MODE: "0",
        },
      ),
      /requires an active recovery watchdog/,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await fs.access(fixture.preparedPath);
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("the recovery gate waits for a modeled 40 second start within the 90 second unit budget", async () => {
  await withDeploymentFixture(async (fixture) => {
    const startedAt = Date.now();
    await fixture.run(
      ["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version],
      {
        FAKE_SYSTEMCTL_DELAY_MATCH: "start wfl-codex-desktop-restore-recovery.service",
        FAKE_SYSTEMCTL_DELAY_MS: "400",
        FAKE_DEPLOY_LONG_TIMEOUT_SCALE: "0.01",
      },
    );
    assert.ok(Date.now() - startedAt >= 350);
  });
});

test("deferred activation keeps a durable recovery manifest until its verified owner finalizes", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    await fixture.run(
      [
        "--activate-staged", "--defer-finalize",
        "--operation-id", fixture.operationId,
        "--version", packageJson.version,
      ],
      activationEnvironment(drain),
    );

    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    assert.equal(prepared.stageState, "activated");
    assert.equal(prepared.activePort, fixture.activePort);
    assert.equal(prepared.candidatePort, fixture.candidatePort);
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);

    await assert.rejects(
      fixture.run(
        ["--finalize-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        { CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      ),
      /watchdog identity changed before finalization/,
    );
    assert.equal((await fs.stat(fixture.preparedPath)).isFile(), true);

    await fixture.run([
      "--finalize-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    assert.equal((await new ReleaseDrainStore(fixture.runtimeDirectory).read()).active, false);
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
  });
});

test("owner loss after deferred activation keeps a healthy candidate active", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    await fixture.run(
      [
        "--activate-staged", "--defer-finalize",
        "--operation-id", fixture.operationId,
        "--version", packageJson.version,
      ],
      activationEnvironment(drain),
    );
    await fixture.abandonPrepared();

    await fixture.run([
      "--recover-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);

    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    assert.equal((await new ReleaseDrainStore(fixture.runtimeDirectory).read()).active, false);
    const recoveredAuthority = await new BackendAuthorityStore(fixture.runtimeDirectory).read();
    assert.equal(recoveredAuthority.backendInstanceId, "backend-instance-candidate");
    assert.equal(recoveredAuthority.port, fixture.candidatePort);
  });
});

test("systemd recovery can take over from a stopped watchdog with a valid attestation", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.abandonPrepared();
    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    const watchdogDirectory = path.join(fixture.runtimeDirectory, "deployment-watchdogs");
    await fs.mkdir(watchdogDirectory, { recursive: true });
    await fs.writeFile(
      path.join(watchdogDirectory, `${fixture.operationId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        token: prepared.watchToken,
        operationId: prepared.operationId,
        ownerPid: prepared.ownerPid,
        ownerStartTicks: prepared.ownerStartTicks,
        watcherPid: 2_147_483_647,
        watcherStartTicks: "1",
      })}\n`,
      { mode: 0o600 },
    );

    await fixture.run(
      ["--recover-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      { CODEX_DESKTOP_DEPLOYMENT_WATCH_TEST_MODE: "0" },
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
  });
});

test("a legacy release without the recovery capability can stage and discard without new control assets", async () => {
  await withDeploymentFixture(async (fixture) => {
    const manifestPath = path.join(fixture.releaseDirectory, ".codex-package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.capabilities = [];
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await Promise.all(recoveryCapabilityFiles.map((relativePath) => (
      fs.rm(path.join(fixture.releaseDirectory, relativePath), { force: true })
    )));

    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);

    await fixture.run([
      "--discard-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
  });
});

test("a fresh install deploys and verifies its first backend without staging or draining", async () => {
  await withDeploymentFixture(async (fixture) => {
    const output = await fixture.run([
      "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.bootstrapSlot), fixture.releaseDirectory);
    assert.match(output, new RegExp(`backend none -> ${fixture.activePort}`));
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    await assert.rejects(
      fs.access(path.join(fixture.runtimeDirectory, "release-drain.json")),
      { code: "ENOENT" },
    );

    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`enable --no-reload wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.match(log, /start wfl-codex-desktop-gateway\.service/);
    assert.match(log, /disable wfl-codex-desktop\.service/);
  }, { bootstrap: true });
});

test("a failed activation fence restores the candidate slot without changing the active backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const lease = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        activationEnvironment({ token: `${lease.token}-wrong` }),
      ),
      /Deployment drain lease is expired or owned by another operation/,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(
      fs.access(path.join(fixture.runtimeDirectory, "prepared-deployment.json")),
      { code: "ENOENT" },
    );
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
  });
});

test("candidate readiness failure restores the previous backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.setCandidateHealthy(false);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          ...activationEnvironment(drain),
          CODEX_DESKTOP_ACTIVATION_READY_TIMEOUT_MS: "500",
        },
      ),
      /candidate .* was not ready/,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`start wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.match(log, /probe candidate-ready/);
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.doesNotMatch(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.match(log, /primary candidate/);
  });
});

test("candidate without a complete Codex runtime bundle is rejected before traffic switches", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.setCandidateRuntimeBundleReady(false);

    await assert.rejects(
      fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]),
      /was not ready/u,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, /auth handoff prepare|primary candidate|selector candidate/u);
  });
});

test("legacy release standby readiness remains compatible without runtime-bundle fields", async () => {
  await withDeploymentFixture(async (fixture) => {
    const manifestPath = path.join(fixture.releaseDirectory, ".codex-package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.capabilities = manifest.capabilities.filter(
      (capability) => capability !== CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
    );
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fixture.setCandidateRuntimeBundleReady(false);

    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    assert.equal(prepared.stageState, "ready");
    assert.equal(prepared.candidateBackendInstanceId, "backend-instance-candidate");
    await fixture.run([
      "--discard-staged", "--operation-id", fixture.operationId, "--version", packageJson.version,
    ]);
  });
});

test("standby initialization is byte-preserving when candidate readiness fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-standby-state-"));
  const stateDirectory = path.join(root, "state");
  const backupDirectory = path.join(root, "backups");
  const migrationDirectory = path.join(root, "migrations");
  const runtimeDirectory = path.join(root, "runtime");
  const projectDirectory = path.join(root, "projects");
  try {
    await fs.mkdir(projectDirectory, { recursive: true });
    const multiUserOptions = {
      legacyProjectRoot: projectDirectory,
      legacyDefaultProject: projectDirectory,
      legacyStateDirectory: stateDirectory,
      usersRoot: path.join(root, "users"),
      userStateRoot: path.join(stateDirectory, "user-state"),
    };
    await new MultiUserStore(stateDirectory, multiUserOptions).initialize();
    await new OpsRollbackStore(stateDirectory).initialize();
    await new BackupCenter(backupDirectory, {
      stateDirectory,
      version: packageJson.version,
    }).initialize();
    await new WorkspaceMigrationCenter(migrationDirectory, { version: packageJson.version }).initialize();
    await new TemporarySshAccessService(runtimeDirectory).initialize();

    await fs.mkdir(path.join(backupDirectory, ".tmp-active-backup"), { recursive: true });
    await fs.writeFile(path.join(backupDirectory, ".tmp-active-backup", "sentinel"), "backup-in-progress\n");
    await fs.mkdir(path.join(migrationDirectory, "staging", ".active-export"), { recursive: true });
    await fs.writeFile(path.join(migrationDirectory, "staging", ".active-export", "sentinel"), "export-in-progress\n");
    const sshDirectory = path.join(runtimeDirectory, "plugin-data", "secure-ssh-access");
    await fs.writeFile(path.join(sshDirectory, "ssh-0123456789abcdef.json"), "malformed-but-owned-by-primary\n");

    const before = await snapshotTree(root);
    await new MultiUserStore(stateDirectory, multiUserOptions).initialize({ writeOnInitialize: false });
    await new OpsRollbackStore(stateDirectory).initialize({ writeOnInitialize: false });
    await new BackupCenter(backupDirectory, {
      stateDirectory,
      version: packageJson.version,
    }).initialize({ writeOnInitialize: false });
    await new WorkspaceMigrationCenter(migrationDirectory, { version: packageJson.version })
      .initialize({ writeOnInitialize: false });
    await new TemporarySshAccessService(runtimeDirectory).initialize({ primary: false });
    const after = await snapshotTree(root);

    assert.deepEqual(after, before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a final cancellation decision prevents activation after candidate readiness", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    await new DeploymentCancelStore(fixture.runtimeDirectory).requestCancel(fixture.operationId);

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        activationEnvironment(drain),
      ),
      /Maintenance operation was cancelled before backend activation/,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(
      fs.access(path.join(fixture.runtimeDirectory, "prepared-deployment.json")),
      { code: "ENOENT" },
    );
  });
});

test("an expired hard drain deadline cannot change the active backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        activationEnvironment(drain, { deadlineAt: Date.now() - 1 }),
      ),
      /hard deadline expired/,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
  });
});

test("insufficient activation budget exits before auth handoff or writer transfer", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drainStore = new ReleaseDrainStore(fixture.runtimeDirectory);
    const drain = await drainStore.begin(packageJson.version, { ttlMs: 60_000 });
    const deadlineAt = Date.now() + 41_000;

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        activationEnvironment(drain, { deadlineAt }),
      ),
      /hard deadline expired/,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    const authority = await new BackendAuthorityStore(fixture.runtimeDirectory).read();
    assert.equal(authority, null);
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, /auth handoff prepare|primary candidate|selector candidate/);
    assert.equal((await drainStore.read()).active, true);
  });
});

test("a sixty-second window tolerates a near-five-second auth handoff and delayed candidate startup", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.setAuthHandoffDelay(4_800);
    await fixture.setCandidateReadyDelay(1_500);
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 60_000 });

    await fixture.run(
      ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      activationEnvironment(drain),
    );

    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.ok(log.indexOf("auth handoff prepare") < log.indexOf("primary candidate"));
    assert.ok(log.indexOf("primary candidate") < log.lastIndexOf("probe candidate-ready"));
  });
});

test("a hanging old-backend stop is bounded and restores the previous backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    const startedAt = Date.now();

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          ...activationEnvironment(drain),
          CODEX_DESKTOP_SYSTEMCTL_TIMEOUT_MS: "500",
          FAKE_SYSTEMCTL_HANG_MATCH: `stop wfl-codex-desktop-backend@${fixture.activePort}.service`,
        },
      ),
      /previous backend remained available/,
    );
    assert.ok(Date.now() - startedAt < 6_000);
    assert.equal(await fixture.readActivePort(), fixture.activePort);
  });
});

test("a failed gateway switch restores active-port before the hard drain deadline", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.setGatewayRejectCandidate(true);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    const deadlineAt = Date.now() + 55_000;

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        activationEnvironment(drain, { deadlineAt }),
      ),
      /previous backend remained available/,
    );
    const completedAt = Date.now();
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.ok((await fs.stat(fixture.activePortPath)).mtimeMs < deadlineAt);
    assert.ok(completedAt < deadlineAt);
    assert.equal((await new ReleaseDrainStore(fixture.runtimeDirectory).read()).active, true);
  });
});

test("a failed active-port rollback preserves the candidate for recovery", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.breakActivePortOnCandidateSelection();
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    const deadlineAt = Date.now() + 55_000;

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          ...activationEnvironment(drain, { deadlineAt }),
          CODEX_DESKTOP_ACTIVATION_GATEWAY_TIMEOUT_MS: "500",
        },
      ),
      /activation requires recovery|neither backend could be recovered/i,
    );
    const completedAt = Date.now();

    const activePortStat = await fs.lstat(fixture.activePortPath);
    assert.equal(activePortStat.isDirectory(), true);
    assert.ok(activePortStat.mtimeMs < deadlineAt);
    assert.ok(completedAt < deadlineAt);
    await assertCandidatePreservedForRecovery(fixture);
    await assert.rejects(
      fixture.run(["--discard-staged", "--operation-id", fixture.operationId, "--version", packageJson.version]),
      /requiring recovery cannot be discarded/,
    );
    await assertCandidatePreservedForRecovery(fixture);
  });
});

test("an unverifiable previous gateway reselects the candidate for recovery", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.recoverCandidateAfterPreviousGatewayFailure();
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    const deadlineAt = Date.now() + 55_000;

    await fixture.run(
      ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      {
        ...activationEnvironment(drain, { deadlineAt }),
        CODEX_DESKTOP_ACTIVATION_GATEWAY_TIMEOUT_MS: "500",
      },
    );
    const completedAt = Date.now();

    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    assert.ok((await fs.stat(fixture.activePortPath)).mtimeMs < deadlineAt);
    assert.ok(completedAt < deadlineAt);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
  });
});

test("failed candidate reselection preserves both backends for manual recovery", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.failAllGatewaysAfterCandidateSelection();
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    const deadlineAt = Date.now() + 55_000;

    await assert.rejects(
      fixture.run(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          ...activationEnvironment(drain, { deadlineAt }),
          CODEX_DESKTOP_ACTIVATION_GATEWAY_TIMEOUT_MS: "500",
        },
      ),
      /activation requires recovery|neither backend could be recovered/i,
    );
    const completedAt = Date.now();

    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    assert.ok((await fs.stat(fixture.activePortPath)).mtimeMs < deadlineAt);
    assert.ok(completedAt < deadlineAt);
    await assertCandidatePreservedForRecovery(fixture);
  });
});

test("an exhausted activation deadline still restores the previous backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.setGatewayRejectCandidate(true);
    const drain = await new ReleaseDrainStore(fixture.runtimeDirectory).begin(packageJson.version, { ttlMs: 30_000 });
    const deadlineAt = Date.now() + 20_000;

    await assert.rejects(
      fixture.runPausedAfterSwitch(
        ["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        {
          ...activationEnvironment(drain, { deadlineAt }),
          CODEX_DESKTOP_ACTIVATION_GATEWAY_TIMEOUT_MS: "500",
        },
        3_000,
      ),
      /hard deadline expired|previous backend was restored|previous backend remained available|operation was aborted due to timeout/i,
    );
    const completedAt = Date.now();

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.ok((await fs.stat(fixture.activePortPath)).mtimeMs < deadlineAt);
    assert.ok(completedAt < deadlineAt);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
  });
});

test("discard-staged cleans an inactive prepared candidate only for its owning operation", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await assert.rejects(
      fixture.run(["--discard-staged", "--operation-id", "another-operation", "--version", packageJson.version]),
      /Prepared deployment belongs to another operation/,
    );
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);

    await fixture.run(["--discard-staged", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(
      fs.access(path.join(fixture.runtimeDirectory, "prepared-deployment.json")),
      { code: "ENOENT" },
    );
  });
});

test("an active staged deployment cannot be reclaimed by another deployment", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await assert.rejects(
      fixture.run(
        ["--recover-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
        { CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      ),
      /recovery watchdog identity does not match/,
    );
    await assert.rejects(
      fixture.run(["--prepare-only", "--version", packageJson.version]),
      /still owned by an active maintenance operation/,
    );
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);
    await fs.access(fixture.preparedPath);
  });
});

test("a preparing deployment cannot be activated", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    prepared.stageState = "preparing";
    await fs.writeFile(fixture.preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });

    await assert.rejects(
      fixture.run(["--activate-staged", "--operation-id", fixture.operationId, "--version", packageJson.version]),
      /not ready for activation/,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await fs.access(fixture.preparedPath);
  });
});

test("a schema 2 manifest can never use pid 1 as its owner", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    prepared.ownerPid = 1;
    await fs.writeFile(fixture.preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });

    await assert.rejects(
      fixture.run(["--prepare-only", "--version", packageJson.version]),
      /owner fingerprint is invalid/,
    );
    await fs.access(fixture.preparedPath);
  });
});

test("a dead deploy lock is reclaimed before staging", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fs.writeFile(path.join(fixture.runtimeDirectory, "deploy.lock"), "2147483647\n");
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.access(fixture.preparedPath);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);
  });
});

test("an abandoned pre-switch candidate is stopped and its slot is restored", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.writeFile(fixture.systemctlLog, "");
    await fixture.abandonPrepared();

    await assert.rejects(
      fixture.run(["--prepare-only", "--version", "99.99.99"]),
      /ENOENT|no such file/i,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.doesNotMatch(log, new RegExp(`(?:stop|restart) wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.match(log, new RegExp(`enable --no-reload wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("an abandoned pre-switch candidate recovers an unavailable selected old backend before cleanup", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.writeFile(fixture.systemctlLog, "");
    await fixture.abandonPrepared();
    await fixture.setActiveHealthy(false);

    await assert.rejects(
      fixture.run(["--recover-staged", "--operation-id", fixture.operationId]),
      /backend on port .* was not ready/,
    );
    await fs.access(fixture.preparedPath);

    await fixture.setActiveHealthy(true);
    await fixture.run(["--recover-staged", "--operation-id", fixture.operationId]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`enable --no-reload wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.match(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.doesNotMatch(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("an abandoned preparing candidate is recoverable after its slot changes", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.abandonPrepared({ stageState: "preparing" });

    await assert.rejects(
      fixture.run(["--prepare-only", "--version", "99.99.99"]),
      /ENOENT|no such file/i,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
  });
});

test("a pre-stop owner loss verifies the selected old backend without restarting it", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.writeFile(fixture.systemctlLog, "");
    const recoveryDeadlineAt = Date.now() + 1_000;
    await fixture.abandonPrepared({
      stageState: "stopping-old",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + 18_000,
      drainToken: "drain-token-pre-stop-owner-loss",
    });

    await fixture.run(["--recover-staged", "--operation-id", fixture.operationId]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("a verified watchdog can recover while the stopped owner's proc identity is unreadable", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    const unreadableOwner = { FAKE_PROC_UNREADABLE_PID: String(prepared.ownerPid) };

    await assert.rejects(
      fixture.run(
        ["--recover-staged", "--operation-id", fixture.operationId],
        {
          ...unreadableOwner,
          CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ),
      /owner state is unknown/,
    );
    await fs.access(fixture.preparedPath);

    await fixture.run(
      ["--recover-staged", "--operation-id", fixture.operationId],
      unreadableOwner,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
  });
});

test("a persisted old restart phase probes before restarting a backend that already recovered", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const recoveryDeadlineAt = Date.now() + 1_000;
    await fixture.abandonPrepared({
      stageState: "old-stopped",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + 18_000,
      drainToken: "drain-token-old-restart-probe",
      recoveryTarget: "old",
      recoveryMode: "restart-old",
    });
    await fs.writeFile(fixture.systemctlLog, "");

    await fixture.run(["--recover-staged", "--operation-id", fixture.operationId]);

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("a persisted old gateway phase does not restart an already healthy gateway", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const recoveryDeadlineAt = Date.now() + 1_000;
    await fixture.abandonPrepared({
      stageState: "old-stopped",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + 18_000,
      drainToken: "drain-token-old-gateway-probe",
      recoveryTarget: "old",
      recoveryMode: "restart-gateway-old",
    });
    await fs.writeFile(fixture.systemctlLog, "");

    await fixture.run(["--recover-staged", "--operation-id", fixture.operationId]);

    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, /restart wfl-codex-desktop-gateway\.service/);
    assert.doesNotMatch(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("a failed old-backend recovery durably resumes from the candidate target", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const recoveryDeadlineAt = Date.now() + 1_000;
    await fixture.abandonPrepared({
      stageState: "old-stopped",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + 18_000,
      drainToken: "drain-token-durable-candidate-recovery",
      recoveryTarget: "old",
      recoveryMode: "restart-old",
    });
    await fixture.setActiveHealthy(false);
    await fixture.setCandidateHealthy(false);

    await assert.rejects(
      fixture.run(
        ["--recover-staged", "--operation-id", fixture.operationId],
        { FAKE_SYSTEMCTL_HANG_MATCH: "restart wfl-codex-desktop-backend@" },
      ),
      /Neither deployment backend could be recovered/,
    );
    const resumable = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    assert.equal(resumable.recoveryTarget, "candidate");
    assert.equal(resumable.recoveryMode, "restart-candidate");

    await fixture.setCandidateHealthy(true);
    await fs.writeFile(fixture.systemctlLog, "");
    await fixture.run(["--recover-staged", "--operation-id", fixture.operationId]);
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const resumedLog = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(
      resumedLog,
      new RegExp(`restart wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`),
    );
  });
});

test("candidate gateway and cleanup retries never restart healthy services", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const recoveryDeadlineAt = Date.now() + 1_000;
    await fixture.abandonPrepared({
      stageState: "activated",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + 18_000,
      drainToken: "drain-token-candidate-cleanup-retry",
      recoveryTarget: "candidate",
      recoveryMode: "restart-gateway-candidate",
    });
    await fs.writeFile(fixture.activePortPath, `${fixture.candidatePort}\n`);
    await fs.writeFile(fixture.systemctlLog, "");

    await fixture.run(["--recover-staged", "--operation-id", fixture.operationId]);

    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, /restart wfl-codex-desktop-gateway\.service/);
    assert.doesNotMatch(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
  });
});

test("failed pre-switch cleanup never restarts or enables the selected old backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fs.writeFile(fixture.systemctlLog, "");
    await fixture.abandonPrepared();

    const candidateUnit = `wfl-codex-desktop-backend@${fixture.candidatePort}.service`;
    await assert.rejects(
      fixture.run(
        ["--prepare-only", "--version", "99.99.99"],
        { FAKE_SYSTEMCTL_HANG_MATCH: `stop ${candidateUnit}` },
      ),
      /Cannot clean the staged candidate while its service state is unknown/,
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await fs.access(fixture.preparedPath);
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`(?:stop|restart) wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.doesNotMatch(log, new RegExp(`enable(?: --no-reload)? wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("an abandoned inconsistent post-switch selector reuses a healthy candidate first", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.abandonPrepared();
    await fs.writeFile(fixture.activePortPath, `${fixture.candidatePort}\n`);
    await fs.writeFile(fixture.systemctlLog, "");

    await assert.rejects(
      fixture.run(["--prepare-only", "--version", "99.99.99"]),
      /ENOENT|no such file/i,
    );
    assert.equal(await fixture.readActivePort(), fixture.candidatePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
  });
});

test("recovery rechecks the candidate after retiring the old backend and rolls back safely", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.abandonPrepared();
    await fs.writeFile(fixture.activePortPath, `${fixture.candidatePort}\n`);

    await fixture.run(
      ["--recover-staged", "--operation-id", fixture.operationId, "--version", packageJson.version],
      {
        FAKE_SYSTEMCTL_TRIGGER_UNIT: `wfl-codex-desktop-backend@${fixture.activePort}.service`,
        FAKE_SYSTEMCTL_MARK_HEALTH_AFTER_STOP: fixture.candidateFailureMarker,
      },
    );

    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
  });
});

test("an unhealthy post-switch candidate rolls back to a healthy old backend before cleanup", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.abandonPrepared();
    await fixture.setCandidateHealthy(false);
    await fs.writeFile(fixture.activePortPath, `${fixture.candidatePort}\n`);

    await assert.rejects(
      fixture.run(["--prepare-only", "--version", "99.99.99"]),
      /ENOENT|no such file/i,
    );
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.doesNotMatch(log, new RegExp(`restart wfl-codex-desktop-backend@${fixture.activePort}\\.service`));
    assert.match(log, new RegExp(`stop wfl-codex-desktop-backend@${fixture.candidatePort}\\.service`));
  });
});

test("a missing selector is recovered to the previous backend", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    await fixture.abandonPrepared();
    await fs.rm(fixture.activePortPath);

    await assert.rejects(fixture.run(["--prepare-only", "--version", "99.99.99"]), /ENOENT|no such file/i);
    assert.equal(await fixture.readActivePort(), fixture.activePort);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
  });
});

test("a legacy staged manifest is recovered only after its systemd unit is inactive", async () => {
  await withDeploymentFixture(async (fixture) => {
    await fixture.run(["--stage", "--operation-id", fixture.operationId, "--version", packageJson.version]);
    const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
    prepared.schemaVersion = 1;
    prepared.operationId = `wfl-codex-release-v0-0-0-${Date.now()}-deadbeef`;
    delete prepared.ownerPid;
    delete prepared.ownerStartTicks;
    await fs.writeFile(fixture.preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });

    await assert.rejects(
      fixture.run(
        ["--prepare-only", "--version", "99.99.99"],
        { FAKE_SYSTEMCTL_OPERATION_STATE: "inactive" },
      ),
      /ENOENT|no such file/i,
    );
    assert.equal(await fs.readlink(fixture.candidateSlot), fixture.previousSlotTarget);
    await assert.rejects(fs.access(fixture.preparedPath), { code: "ENOENT" });
    const log = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(log, new RegExp(`is-active ${prepared.operationId}\\.service`));
  });
});

test("systemd keeps the public gateway separate from loopback backend slots", () => {
  assert.match(gatewayUnit, /Environment=PORT=4317/);
  assert.match(gatewayUnit, /Environment=CODEX_DESKTOP_UPSTREAM_PORTS=4318,4319/);
  assert.match(gatewayUnit, /Restart=always/);
  assert.match(gatewayUnit, /Conflicts=wfl-codex-desktop\.service/);
  assert.match(backendUnit, /Environment=PORT=%i/);
  assert.match(backendUnit, /Environment=PATH=\/root\/\.local\/bin:\/root\/\.codex\/bin:/);
  assert.match(backendUnit, /CODEX_DESKTOP_STATE_DIR=\/srv\/wfl-codex-desktop\/\.codex-desktop/);
  assert.match(backendUnit, /CODEX_DESKTOP_SOURCE_DIR=\/srv\/wfl-codex-desktop/);
  assert.match(backendUnit, /CODEX_DESKTOP_RUNTIME_DIR=\/srv\/wfl-codex-desktop\/\.codex-runtime/);
  assert.match(backendUnit, /CODEX_DESKTOP_BACKEND_SOURCE_DIR=\/srv\/wfl-codex-desktop\/\.codex-runtime\/slots\/%i/);
  assert.match(backendUnit, /ExecStart=.*\/srv\/wfl-codex-desktop\/scripts\/backend-entry\.mjs/);
  assert.doesNotMatch(backendUnit, /ExecStart=.*slots\/%i\/server\.mjs/);
  assert.match(
    backendUnit,
    /^Requires=wfl-codex-desktop-restore-recovery\.service$/m,
  );
  assert.match(backendUnit, /^Wants=network-online\.target wfl-codex-desktop-codex-recovery\.service$/m);
  assert.match(
    backendUnit,
    /After=network-online\.target wfl-codex-desktop-restore-recovery\.service wfl-codex-desktop-codex-recovery\.service/,
  );
  assert.doesNotMatch(gatewayUnit, /Requires=wfl-codex-desktop-restore-recovery\.service/);
  assert.match(restoreRecoveryUnit, /Type=oneshot/);
  assert.match(restoreRecoveryUnit, /StartLimitIntervalSec=120s/);
  assert.match(restoreRecoveryUnit, /StartLimitBurst=45/);
  assert.match(restoreRecoveryUnit, /TimeoutStartSec=90s/);
  assert.doesNotMatch(restoreRecoveryUnit, /^Restart=/m);
  assert.match(restoreRecoveryUnit, /\[Install\][\s\S]*WantedBy=multi-user\.target/);
  assert.match(restoreRecoveryUnit, /scripts\/recover-data-restore\.mjs/);
});

test("checked releases run independently and preserve the deployment order", () => {
  assert.match(release, /systemd-run/);
  assert.match(release, /const forceUpdate = process\.env\.CODEX_DESKTOP_FORCE_UPDATE !== "0"/);
  assert.match(release, /"--no-block"/);
  assert.match(release, /"--collect"/);
  assert.match(release, /wfl-codex-release-v.*Date\.now\(\)/);
  assert.match(release, /process\.argv\.includes\("--wait"\)/);
  assert.match(release, /async function waitForRelease/);
  assert.match(release, /`--setenv=PATH=\$\{process\.env\.PATH/);
  const worker = release.match(/async function runWorker[\s\S]*?\n\}/)?.[0];
  assert.ok(worker, "release worker was not found");
  assert.ok(worker.indexOf("inspectCodexInstallation") < worker.indexOf('["run", "check"]'));
  assert.ok(worker.indexOf('["run", "check"]') < worker.indexOf("quick-update-check.mjs"));
  assert.ok(worker.indexOf("quick-update-check.mjs") < worker.indexOf("backup.mjs"));
  assert.match(release, /\["run", "check"\], \{ env: isolatedCheckEnvironment\(\) \}/);
  assert.match(
    worker,
    /run\(process\.execPath, \[path\.join\(projectDir, "scripts", "quick-update-check\.mjs"\)\]/,
  );
  assert.match(
    worker,
    /run\(process\.execPath, \[path\.join\(projectDir, "scripts", "backup\.mjs"\)\]\)/,
  );
  assert.doesNotMatch(worker, /npm", \["run", "update:quick-check"\]/);
  assert.doesNotMatch(worker, /npm", \["run", "backup"\]/);
  for (const variable of [
    "CODEX_DESKTOP_SOURCE_DIR",
    "CODEX_DESKTOP_OPERATION_ID",
    "CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN",
    "CODEX_DESKTOP_CANCEL_DECISION_MANAGED",
    "CODEX_DESKTOP_DRAIN_TOKEN",
    "CODEX_DESKTOP_DRAIN_TTL_MS",
    "CODEX_DESKTOP_DRAIN_DEADLINE_AT",
    "CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED",
  ]) {
    assert.match(release, new RegExp(`delete environment\\.${variable}`));
  }
  assert.ok(worker.indexOf('["run", "backup"]') < worker.indexOf('"--stage"'));
  assert.ok(worker.indexOf('"--stage"') < worker.indexOf("waitForIdleDrain"));
  assert.match(worker, /CODEX_DESKTOP_FORCE_ACTIVATION/);
  assert.ok(worker.indexOf("waitForIdleDrain") < worker.indexOf("CODEX_DESKTOP_DRAIN_TOKEN"));
  assert.ok(worker.indexOf('"install-service-units.mjs"') < worker.indexOf("installBackendUnit"));
  assert.doesNotMatch(worker, /ensureRescueService/);
  assert.ok(worker.indexOf('"--activate-staged"') < worker.indexOf("verifyDeployedRelease"));
  assert.ok(worker.indexOf('"--activate-staged"') < worker.indexOf("ensureGatewayConnectionPolicy"));
  assert.ok(worker.indexOf("ensureGatewayConnectionPolicy") < worker.indexOf("verifyDeployedRelease"));
  assert.match(worker, /"--activate-staged", "--defer-finalize"/);
  assert.ok(worker.indexOf("verifyDeployedRelease") < worker.indexOf('"--finalize-staged"'));
  assert.match(release, /advanceWorktreeSourceRefs/);
  assert.match(release, /targetCommit: sourceCommit/);
  assert.ok(worker.indexOf('"--finalize-staged"') < worker.indexOf("advanceWorktreeSourceRefs"));
  assert.match(release, /if \(!candidateMode\)/);
  assert.ok(worker.indexOf("installBackendUnit") < worker.indexOf('"--stage"'));
  assert.ok(worker.indexOf("activePortBeforeDeploy") < worker.indexOf('"--stage"'));
  assert.match(
    worker,
    /if \(activePortBeforeDeploy === null\)[\s\S]*?commitBootstrapDecision\(operationId\)[\s\S]*?"--operation-id", operationId[\s\S]*?\} else \{[\s\S]*?"--stage"/,
  );
  const bootstrapBranch = worker.slice(
    worker.indexOf("if (activePortBeforeDeploy === null)"),
    worker.indexOf("} else {", worker.indexOf("if (activePortBeforeDeploy === null)")),
  );
  assert.doesNotMatch(bootstrapBranch, /waitForIdleDrain|drainStore\.begin|--stage/);
  assert.match(release, /path\.join\("\/etc\/systemd\/system", name\)/);
  assert.match(release, /path\.join\(runtimeDir, "systemd", name\)/);
  assert.match(release, /"wfl-codex-desktop-restore-recovery\.service"/);
  assert.match(release, /"install-service-units\.mjs"\), "--main-only"/);
  assert.doesNotMatch(release, /"wfl-codex-desktop-rescue@\.service"/);
  assert.doesNotMatch(release, /"update-rescue\.mjs"/);
  assert.match(release, /\["enable", "wfl-codex-desktop-restore-recovery\.service"\]/);
  assert.doesNotMatch(release, /\["restart", "wfl-codex-desktop-rescue/);
  assert.match(release, /\["daemon-reload"\]/);
  assert.match(release, /rev-parse", "@\{upstream\}"/);
  assert.match(release, /\/internal\/gateway-ready/);
  assert.match(release, /requiredPolicyVersion = 8/);
  assert.match(release, /connectionPolicyVersion === requiredPolicyVersion/);
  assert.match(release, /gatewaySourceSha256 === expectedGatewaySourceSha256/);
  assert.doesNotMatch(release, /enable", "--now", `wfl-codex-desktop-rescue@/);
  assert.match(release, /"restart", "wfl-codex-desktop-gateway\.service"/);
  assert.match(release, /\/internal\/codex-ready/);
  assert.equal(packageJson.scripts.test, "node scripts/run-tests.mjs");
  assert.match(runTests, /spawn\(process\.execPath, \[filename\]/);
  assert.match(release, /\/internal\/task-ready/);
  assert.match(release, /Active backend does not support safe task draining/);
  assert.match(release, /CODEX_DESKTOP_DRAIN_TOKEN: drainLease\.token/);
  assert.match(release, /CODEX_DESKTOP_DRAIN_DEADLINE_AT: String\(drainLease\.deadlineAt\)/);
  assert.match(release, /maxDrainMs: 60_000/);
  assert.ok(worker.indexOf("ensureGatewayConnectionPolicy") < worker.indexOf("completedDrain.release"));
  assert.match(release, /"--discard-staged"/);
});

test("remote updates test an exact stable tag before fast-forwarding and deploying it", () => {
  assert.match(appUpdate, /refs\/heads\/stable:refs\/remotes\/origin\/stable/);
  assert.match(appUpdate, /refs\/remotes\/origin\/stable/);
  assert.doesNotMatch(appUpdate, /refs\/remotes\/origin\/main/);
  assert.match(appUpdate, /"worktree", "add", "--detach"/);
  const worker = appUpdate.match(/async function runWorker\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(worker, "application update worker was not found");
  assert.ok(worker.indexOf("assertTargetNodeCompatible") < worker.indexOf('["ci"]'));
  assert.ok(worker.indexOf('["ci"]') < worker.indexOf('["run", "update:quick-check"]'));
  assert.ok(worker.indexOf('["run", "update:quick-check"]') < worker.indexOf('["merge", "--ff-only"'));
  assert.doesNotMatch(worker, /\["run", "check"\]/);
  assert.ok(worker.indexOf('["merge", "--ff-only"') < worker.indexOf('"release.mjs"'));
  assert.match(appUpdate, /CODEX_DESKTOP_PRECHECK_COMMIT: targetCommit/);
  assert.match(worker, /\.\.\.isolatedCheckEnvironment\(\)/);
  assert.match(worker, /CODEX_DESKTOP_QUICK_CHECK_OFFLINE: "1"/);
  assert.doesNotMatch(quickUpdateCheck, /check\("rescue"|rescueUpstreamPort|\/internal\/ready/);
  for (const variable of [
    "CODEX_DESKTOP_SOURCE_DIR",
    "CODEX_DESKTOP_OPERATION_ID",
    "CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN",
    "CODEX_DESKTOP_CANCEL_DECISION_MANAGED",
    "CODEX_DESKTOP_DRAIN_TOKEN",
    "CODEX_DESKTOP_DRAIN_TTL_MS",
    "CODEX_DESKTOP_DRAIN_DEADLINE_AT",
    "CODEX_DESKTOP_LEGACY_DRAIN_CONFIRMED",
  ]) {
    assert.match(appUpdate, new RegExp(`delete environment\\.${variable}`));
  }
  assert.match(appUpdate, /CODEX_DESKTOP_RETRY_PREPARED_SOURCE/);
  assert.match(appUpdate, /verifyPreparedSource/);
  assert.match(appUpdate, /currentVersion !== targetVersion/);
  assert.match(appUpdate, /\(\?:-\[0-9A-Za-z\.\-\]\+\)\?/);
  assert.match(appUpdate, /releaseVersionRelation\(targetVersion, currentVersion\)/);
  assert.match(worker, /const expectedVersion = runningVersion \|\| currentVersion/);
  assert.match(worker, /verifyActiveDeployment\(expectedVersion\)/);
  assert.match(appUpdate, /currentVersion: runningVersion/);
  assert.match(appUpdate, /runningVersion,/);
  assert.match(appUpdate, /sourceVersion,/);
  assert.match(appUpdate, /sourcePending: sourceVersion !== runningVersion/);
  assert.match(appUpdate, /runningRelation: releaseVersionRelation\(latest\.version, runningVersion\)/);
  assert.doesNotMatch(appUpdate, /reset --hard|checkout -f/);
  assert.doesNotMatch(appUpdate, /\/usr\/bin\/npm/);
  assert.doesNotMatch(release, /\/usr\/bin\/npm/);
});

test("candidate promotion binds tested source and atomically advances only formal refs", () => {
  const captureSource = release.match(/function capture\(command, args, \{ timeoutMs = RELEASE_CAPTURE_TIMEOUT_MS \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(captureSource, "release command output capture was not found");
  assert.match(captureSource, /child\.once\("close"/);
  assert.match(release, /CODEX_DESKTOP_CANDIDATE_MODE/);
  assert.match(release, /CODEX_DESKTOP_FULL_RELEASE_CHECK/);
  assert.match(release, /fullReleaseCheck/);
  assert.match(release, /validateReleaseArguments/);
  assert.match(release, /Release help cannot be combined with another action/);
  assert.match(release, /Full repository\/browser suites run only in the primary candidate pipeline/);
  assert.match(release, /运行轻量兼容检查，不启动仓库测试或浏览器冒烟/);
  assert.match(
    release,
    /run\(process\.execPath, \[path\.join\(projectDir, "scripts", "quick-update-check\.mjs"\)\]/,
  );
  assert.match(release, /CODEX_DESKTOP_QUICK_CHECK_OFFLINE: "1"/);
  assert.match(release, /Candidate source tree changed after it was queued/);
  assert.match(release, /Candidate commit has not been pushed to its upstream branch/);
  assert.match(release, /candidateStore\.update\(candidateId/);
  assert.match(server, /reconcileDiscardingCandidate/);
  assert.match(server, /candidateDiscardLaunchInProgress/);
  assert.match(server, /rollbackUnit/);
  assert.match(server, /rollbackTargetVersion/);
  assert.match(backup, /Candidate backup source no longer matches its verified commit/);
  assert.match(promoteCandidate, /release\.candidateId !== value\.id/);
  assert.match(promoteCandidate, /actualValidationConfirmed/);
  assert.match(promoteCandidate, /"push",\s*"--atomic"/);
  assert.match(promoteCandidate, /refs\/heads\/stable/);
  assert.match(promoteCandidate, /refs\/tags\/\$\{tag\}/);
  assert.doesNotMatch(promoteCandidate, /--force|-f(?:"|')/);
});

test("release backups exclude browser artifacts, generated images, and private runtime state", () => {
  for (const excluded of [
    ".codex-desktop",
    ".codex-runtime",
    "archive",
    "generated-images",
    "node_modules",
    "backups",
    "test-results",
    "coverage",
  ]) {
    assert.match(backup, new RegExp(`--exclude=${excluded.replace(".", "\\.")}`));
  }
  assert.match(backup, /createPackageManifest/);
  assert.match(backup, /sourceCommit/);
  assert.match(backup, /--exclude=\.\/\.codex-package\.json/);
  assert.match(backup, /temporaryManifestDirectory/);
  assert.match(backup, /manifestCreatedAt/);
  assert.match(backup, /--sort=name/);
  assert.match(backup, /--mtime=@0/);
  assert.match(backup, /--numeric-owner/);
  assert.doesNotMatch(backup, /writeFile\(manifestPath/);
  assert.match(backup, /--exclude=\*\.recovery-backup-\*/);
  assert.match(backup, /--exclude=backups\/\*\.publish\.lock/);
});

test("release archive publication preserves the last verified pair during interruption", () => {
  assert.match(backup, /mkdtemp\(path\.join\(os\.tmpdir\(\), "wfl-codex-release-"\)\)/);
  assert.match(backup, /publishArchive\(temporaryArchive, archivePath, checksumPath, archiveName\)/);
  assert.match(backup, /publishImmutableArchive/);
  assert.match(archivePublisher, /await fs\.link\(temporaryArchive, destinationArchive\)/);
  assert.match(archivePublisher, /await fs\.link\(temporaryChecksum, destinationChecksum\)/);
  assert.match(archivePublisher, /assertArchiveDigest/);
  assert.match(archivePublisher, /Existing release checksum is not compatible with the immutable source/);
  assert.match(archivePublisher, /\.publish\.lock/);
  assert.match(backup, /--exclude=\*\.bak/);
  assert.doesNotMatch(backup, /fs\.rm\(archivePath, \{ force: true \}\)/);
  assert.doesNotMatch(backup, /fs\.rm\(checksumPath, \{ force: true \}\)/);
});

test("maintenance switches default to force mode with an explicit drain opt-out", () => {
  for (const source of [release, appUpdate, codexUpdate, rollback]) {
    assert.match(source, /const forceUpdate = process\.env\.CODEX_DESKTOP_FORCE_UPDATE !== "0"/);
  }
});

test("main release candidates require recovery assets without inspecting frozen rescue assets", () => {
  assert.match(deploy, /packageManifest\.capabilities\?\.includes\("deployment-recovery-v1"\)/);
  for (const relativePath of recoveryCapabilityFiles) {
    assert.match(deploy, new RegExp(`"${relativePath.replaceAll(".", "\\.")}"`));
  }
  assert.match(deploy, /packageManifest\.capabilities\?\.includes\("main-standby-handoff-v1"\)/);
  for (const relativePath of [
    "lib/backend-authority.mjs",
    "scripts/backend-entry.mjs",
    "systemd/wfl-codex-desktop-backend@.service",
    "systemd/wfl-codex-desktop-backend@.service.template",
  ]) {
    assert.match(deploy, new RegExp(`"${relativePath.replaceAll(".", "\\.")}"`));
  }
  for (const relativePath of [
    "public/rescue.html",
    "public/rescue.css",
    "public/rescue.js",
    "scripts/update-rescue.mjs",
    "systemd/wfl-codex-desktop-rescue@.service.template",
  ]) {
    assert.doesNotMatch(deploy, new RegExp(`"${relativePath.replaceAll(".", "\\.")}"`));
  }
});

test("data restore workers retry unverifiable orphan locks beyond their bounded grace", () => {
  assert.match(server, /--property=Restart=on-failure/);
  assert.match(server, /--property=RestartSec=2s/);
  assert.doesNotMatch(server, /--property=RestartPreventExitStatus=2/);
  assert.match(server, /--property=StartLimitIntervalSec=120s/);
  assert.match(server, /--property=StartLimitBurst=45/);
});

test("official Codex updates use the updater and activate through checked standby handoff", () => {
  assert.match(codexUpdate, /codexCommand, \["update"\]/);
  assert.match(codexUpdate, /systemd-run/);
  assert.match(codexUpdate, /"--no-block"/);
  assert.match(codexUpdate, /RuntimeMaxSec=30min/);
  const worker = codexUpdate.match(/async function runWorker[\s\S]*?\n\}/)?.[0];
  assert.ok(worker, "Codex update worker was not found");
  assert.ok(worker.indexOf("verifyUpdateSource") < worker.indexOf('codexCommand, ["update"]'));
  assert.ok(worker.indexOf('"--preflight"') < worker.indexOf('codexCommand, ["update"]'));
  assert.ok(worker.indexOf('codexCommand, ["update"]') < worker.indexOf('"--stage"'));
  assert.ok(worker.indexOf('"--stage"') < worker.indexOf("waitForIdleDrain"));
  assert.match(worker, /CODEX_DESKTOP_FORCE_ACTIVATION/);
  assert.ok(worker.indexOf("waitForIdleDrain") < worker.indexOf("CODEX_DESKTOP_DRAIN_TOKEN"));
  const stage = functionBlock("stageCandidate", "activatePreparedDeployment");
  assert.ok(stage.indexOf("verifyBackendRecoveryGates") < stage.indexOf("writePreparedDeployment(prepared)"));
  const activation = worker.indexOf('"--activate-staged"');
  const recoveryCommit = worker.indexOf("commitCodexInstallRecovery", activation);
  const finalization = worker.indexOf('"--finalize-staged"', activation);
  const stagedCompletion = worker.indexOf("candidateStaged = false", activation);
  const drainRelease = worker.indexOf("completedDrain.release", activation);
  const deepVerification = worker.indexOf("verifyDeployment", activation);
  assert.match(worker, /"--activate-staged", "--defer-finalize"/);
  assert.ok(activation < deepVerification && deepVerification < recoveryCommit && recoveryCommit < finalization);
  assert.ok(finalization < stagedCompletion && stagedCompletion < drainRelease);
  assert.match(codexUpdate, /"--version",\s+appVersion/);
  assert.match(codexUpdate, /ReleaseDrainStore/);
  assert.match(codexUpdate, /CODEX_DESKTOP_DRAIN_TOKEN: drainLease\.token/);
  assert.match(codexUpdate, /CODEX_DESKTOP_DRAIN_TTL_MS: "20000"/);
  assert.match(codexUpdate, /CODEX_DESKTOP_DRAIN_DEADLINE_AT: String\(drainLease\.deadlineAt\)/);
  assert.match(codexUpdate, /maxDrainMs: 60_000/);
  assert.ok(worker.indexOf("verifyDeployment") < worker.indexOf("completedDrain.release"));
  assert.match(codexUpdate, /CODEX_DESKTOP_CODEX_DRAIN_TIMEOUT_MS/);
  assert.match(codexUpdate, /CODEX_DESKTOP_UPSTREAM_PORTS/);
  assert.match(codexUpdate, /\/internal\/task-ready/);
  assert.match(codexUpdate, /waitForIdleDrain/);
  assert.match(codexUpdate, /drainLease\.assertActive/);
  assert.match(codexUpdate, /"--discard-staged"/);
  assert.match(codexUpdate, /\/internal\/gateway-ready/);
  assert.match(codexUpdate, /\/internal\/codex-ready/);
  assert.match(codexUpdate, /inspectPackageSource\(projectDir\)/);
  assert.match(codexUpdate, /Codex update package source is not the active verified release/);
  const codexLauncher = server.match(/function launchCodexUpdateWorker\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(codexLauncher, "Codex update launcher was not found");
  assert.match(codexLauncher, /sourceDirectory: APP_DIR/);
  assert.doesNotMatch(server, /请先结束当前对话任务再升级 Codex/);
  assert.match(
    server,
    /pendingTaskAdmissions === 0\s+&& !this\.taskStatus\.hasActiveTasks\(\)\s+&& !\(this\.backgroundTaskStore\?\.activeCount\(\) > 0\)/,
  );
  const turnAdmission = server.slice(
    server.indexOf('if (method === "turn/start")'),
    server.indexOf('if (method === "thread/compact/start")'),
  );
  assert.ok(turnAdmission.indexOf("withTaskAdmission") < turnAdmission.indexOf("releaseDrainStore.read"));
  assert.doesNotMatch(turnAdmission, /codexUpdateIsActive|codexUpdateLaunchInProgress/);
  const compactAdmission = server.match(/async function runContextCompaction[\s\S]*?\n\}/)?.[0];
  assert.ok(compactAdmission, "context compaction function was not found");
  assert.ok(compactAdmission.indexOf("withTaskAdmission") < compactAdmission.indexOf("releaseDrainStore.read"));
  assert.match(server, /parseLauncherResult\(stdout\)/);
});

test("manual rollback is an independent verified worker with no automatic fallback", () => {
  assert.match(rollback, /systemd-run/);
  assert.match(rollback, /verifyRollbackRelease/);
  assert.match(rollback, /ReleaseDrainStore/);
  const worker = rollback.match(/async function runWorker[\s\S]*?\n\}/)?.[0];
  assert.ok(worker, "rollback worker was not found");
  assert.ok(worker.indexOf('["run", "backup"]') < worker.indexOf('"--stage"'));
  assert.ok(worker.indexOf('"--stage"') < worker.indexOf("waitForIdleDrain"));
  assert.match(worker, /CODEX_DESKTOP_FORCE_ACTIVATION/);
  assert.ok(worker.indexOf("waitForIdleDrain") < worker.indexOf("CODEX_DESKTOP_DRAIN_TOKEN"));
  const stage = functionBlock("stageCandidate", "activatePreparedDeployment");
  assert.ok(stage.indexOf("verifyBackendRecoveryGates") < stage.indexOf("writePreparedDeployment(prepared)"));
  assert.ok(worker.indexOf('"--activate-staged"') < worker.indexOf("verifyGatewayVersion"));
  assert.match(worker, /"--activate-staged", "--defer-finalize"/);
  assert.match(rollback, /CODEX_DESKTOP_DRAIN_TOKEN: drainLease\.token/);
  assert.match(rollback, /CODEX_DESKTOP_DRAIN_DEADLINE_AT: String\(drainLease\.deadlineAt\)/);
  assert.match(rollback, /maxDrainMs: 60_000/);
  assert.ok(worker.indexOf("verifyGatewayVersion") < worker.indexOf('"--finalize-staged"'));
  assert.ok(worker.indexOf('"--finalize-staged"') < worker.indexOf("completedDrain.release"));
  assert.match(rollback, /"--discard-staged"/);
  assert.match(rollback, /async function launchWorker\(\)[\s\S]*?clearStaleReleaseLock\(\)/);
  assert.match(rollback, /operationLockState\(lockPath, sharedReleaseLockOptions\)/);
  assert.match(rollback, /reclaimInactiveOperationLock/);
  assert.match(rollback, /verifyGatewayVersion/);
  assert.doesNotMatch(rollback, /reset --hard|checkout -f|automatic rollback/i);
});

async function withDeploymentFixture(operation, { bootstrap = false } = {}) {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-staged-"));
  const systemctlLog = path.join(runtimeDirectory, "deployment-events.log");
  const servers = [];
  try {
    let activeHealthy = true;
    let activePrimary = !bootstrap;
    let activeAuthHandoffSupported = true;
    let activeAuthHandoffFenced = false;
    let authHandoffDelayMs = 0;
    let candidateReadyDelayMs = 0;
    let candidateActivatedAt = null;
    const activeBackendInstanceId = "backend-instance-active";
    const candidateBackendInstanceId = "backend-instance-candidate";
    const activeServer = http.createServer(async (request, response) => {
      if (request.url === "/internal/backend-identity") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          version: bootstrap ? packageJson.version : "0.0.0",
          port: activePort,
          backendInstanceId: activeBackendInstanceId,
          writerEpoch: 1,
          primary: activePrimary,
          selected: activePrimary,
          authoritative: activePrimary,
          standby: !activePrimary,
        }));
        return;
      }
      if (request.url === "/internal/standby-ready") {
        response.setHeader("Content-Type", "application/json");
        if (activePrimary) {
          response.writeHead(409).end(JSON.stringify({ ok: false, primary: true, standby: false }));
          return;
        }
        response.end(JSON.stringify({
          ok: true,
          version: packageJson.version,
          port: activePort,
          backendInstanceId: activeBackendInstanceId,
          primary: false,
          standby: true,
          runtimeBundleRequired: true,
          runtimeBundleReady: true,
          codeModeHostReady: true,
          codexVersion: "0.149.0",
          codexTarget: "x86_64-unknown-linux-musl",
          codexRuntimeSha256: "b".repeat(64),
          codexCodeModeHostSha256: "c".repeat(64),
        }));
        return;
      }
      if (request.url === "/internal/activate-primary" && request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        if (!bootstrap && !await isSelectedPort(activePort)) {
          response.writeHead(409).end(JSON.stringify({ ok: false, error: "Backend is not selected" }));
          return;
        }
        if (activeAuthHandoffFenced) {
          activeAuthHandoffFenced = false;
          await fs.appendFile(systemctlLog, "auth handoff resume\n");
        }
        if (!activePrimary) {
          activePrimary = true;
          response.writeHead(202).end(JSON.stringify({
            ok: true,
            version: packageJson.version,
            port: activePort,
            backendInstanceId: activeBackendInstanceId,
            writerEpoch: 1,
            transitioning: true,
          }));
          return;
        }
        response.end(JSON.stringify({
          ok: true,
          version: bootstrap ? packageJson.version : "0.0.0",
          backendInstanceId: activeBackendInstanceId,
          writerEpoch: 3,
          primary: true,
        }));
        return;
      }
      if (request.url === "/internal/recover-primary" && request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        activePrimary = true;
        if (activeAuthHandoffFenced) {
          activeAuthHandoffFenced = false;
          await fs.appendFile(systemctlLog, "auth handoff resume\n");
        }
        await fs.appendFile(systemctlLog, "recover primary active\n");
        response.end(JSON.stringify({
          ok: true,
          version: bootstrap ? packageJson.version : "0.0.0",
          port: activePort,
          backendInstanceId: activeBackendInstanceId,
          writerEpoch: 1,
          primary: true,
        }));
        return;
      }
      if (request.url === "/internal/auth-handoff/prepare" && request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        if (!activeAuthHandoffSupported) {
          response.writeHead(302, {
            Location: "/login.html?next=%2Finternal%2Fauth-handoff%2Fprepare",
          }).end();
          return;
        }
        activeAuthHandoffFenced = true;
        if (authHandoffDelayMs > 0) await delay(authHandoffDelayMs);
        await fs.appendFile(systemctlLog, "auth handoff prepare\n");
        response.end(JSON.stringify({ ok: true, fenced: true, runtimes: 1 }));
        return;
      }
      if (request.url === "/internal/codex-ready") {
        response.setHeader("Content-Type", "application/json");
        if (await fs.access(activeFailureMarker).then(() => true, () => false)) activeHealthy = false;
        if (!activeHealthy || activeAuthHandoffFenced) {
          response.writeHead(503).end(JSON.stringify({ codexReady: false, threadListReady: false }));
          return;
        }
        response.end(JSON.stringify({
          version: bootstrap ? packageJson.version : "0.0.0",
          codexReady: true,
          threadListReady: true,
          runtimeBundleReady: true,
          codeModeHostReady: true,
          codexTarget: "x86_64-unknown-linux-musl",
          codexRuntimeSha256: "b".repeat(64),
          codexCodeModeHostSha256: "c".repeat(64),
        }));
        return;
      }
      response.end("ok");
    });
    let candidateHealthy = true;
    let candidateRuntimeBundleReady = true;
    let candidatePrimary = false;
    const candidateServer = http.createServer(async (request, response) => {
      if (request.url === "/internal/activate-primary" && request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        if (candidatePrimary && !await isSelectedPort(candidatePort)) {
          response.writeHead(409).end(JSON.stringify({ ok: false, error: "Backend is not selected" }));
          return;
        }
        if (!candidatePrimary) {
          candidatePrimary = true;
          candidateActivatedAt = Date.now();
          await fs.appendFile(systemctlLog, "primary candidate\n");
          response.writeHead(202).end(JSON.stringify({
            ok: true,
            version: packageJson.version,
            port: candidatePort,
            backendInstanceId: candidateBackendInstanceId,
            writerEpoch: 1,
            transitioning: true,
          }));
          return;
        }
        response.end(JSON.stringify({
          ok: true,
          version: packageJson.version,
          backendInstanceId: candidateBackendInstanceId,
          writerEpoch: 1,
          primary: true,
        }));
        return;
      }
      if (request.url === "/internal/recover-primary" && request.method === "POST") {
        response.setHeader("Content-Type", "application/json");
        candidatePrimary = true;
        await fs.appendFile(systemctlLog, "recover primary candidate\n");
        response.end(JSON.stringify({
          ok: true,
          version: packageJson.version,
          port: candidatePort,
          backendInstanceId: candidateBackendInstanceId,
          writerEpoch: 1,
          primary: true,
        }));
        return;
      }
      if (request.url === "/internal/standby-ready") {
        response.setHeader("Content-Type", "application/json");
        if (candidatePrimary) {
          response.writeHead(409).end(JSON.stringify({ ok: false, primary: true, standby: false }));
          return;
        }
        response.end(JSON.stringify({
          ok: true,
          version: packageJson.version,
          port: candidatePort,
          backendInstanceId: candidateBackendInstanceId,
          primary: false,
          standby: true,
          runtimeBundleRequired: true,
          runtimeBundleReady: candidateRuntimeBundleReady,
          codeModeHostReady: candidateRuntimeBundleReady,
          codexVersion: "0.149.0",
          codexTarget: "x86_64-unknown-linux-musl",
          codexRuntimeSha256: "a".repeat(64),
          codexCodeModeHostSha256: "d".repeat(64),
        }));
        return;
      }
      if (request.url === "/internal/backend-identity") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          version: packageJson.version,
          port: candidatePort,
          backendInstanceId: candidateBackendInstanceId,
          writerEpoch: 1,
          primary: candidatePrimary,
          selected: candidatePrimary,
          authoritative: candidatePrimary,
          standby: !candidatePrimary,
        }));
        return;
      }
      if (request.url !== "/internal/codex-ready") {
        response.writeHead(404).end();
        return;
      }
      await fs.appendFile(systemctlLog, "probe candidate-ready\n");
      response.setHeader("Content-Type", "application/json");
      if (await fs.access(candidateFailureMarker).then(() => true, () => false)) candidateHealthy = false;
      if (
        !candidateHealthy
        || (candidateActivatedAt !== null && Date.now() - candidateActivatedAt < candidateReadyDelayMs)
      ) {
        response.writeHead(503).end(JSON.stringify({ codexReady: false, threadListReady: false }));
        return;
      }
      response.end(JSON.stringify({
        version: packageJson.version,
        codexReady: true,
        threadListReady: true,
        runtimeBundleReady: candidateRuntimeBundleReady,
        codeModeHostReady: candidateRuntimeBundleReady,
        codexTarget: "x86_64-unknown-linux-musl",
        codexRuntimeSha256: "a".repeat(64),
        codexCodeModeHostSha256: "d".repeat(64),
      }));
    });
    servers.push(activeServer, candidateServer);
    const activePort = await listen(activeServer);
    const candidatePort = await listen(candidateServer);
    const activePortPath = path.join(runtimeDirectory, "active-port");
    const preparedPath = path.join(runtimeDirectory, "prepared-deployment.json");
    const isSelectedPort = async (port) => (
      Number((await fs.readFile(activePortPath, "utf8").catch(() => "")).trim()) === port
    );
    const candidateFailureMarker = path.join(runtimeDirectory, "candidate-failed-after-stop");
    const activeFailureMarker = path.join(runtimeDirectory, "active-failed-after-stop");
    if (!bootstrap) await fs.writeFile(activePortPath, `${activePort}\n`);

    let gatewayRejectCandidate = false;
    let breakActivePortOnCandidate = false;
    let activePortBroken = false;
    let recoverCandidateAfterPreviousFailure = false;
    let failAllGatewaysAfterCandidate = false;
    let candidateSelectionObserved = false;
    let previousSelectionObservedAfterCandidate = false;
    const gatewayServer = http.createServer(async (request, response) => {
      if (request.url !== "/internal/gateway-ready") {
        response.writeHead(404).end();
        return;
      }
      if (activePortBroken) {
        response.writeHead(503).end();
        return;
      }
      const selectedPort = Number((await fs.readFile(activePortPath, "utf8")).trim());
      if (selectedPort === candidatePort) {
        candidateSelectionObserved = true;
        if (breakActivePortOnCandidate) {
          await fs.rm(activePortPath);
          await fs.mkdir(activePortPath);
          activePortBroken = true;
        }
      }
      if (failAllGatewaysAfterCandidate && candidateSelectionObserved) {
        response.writeHead(503).end();
        return;
      }
      if (recoverCandidateAfterPreviousFailure && candidateSelectionObserved) {
        if (selectedPort === activePort) {
          previousSelectionObservedAfterCandidate = true;
          response.writeHead(503).end();
          return;
        }
        if (!previousSelectionObservedAfterCandidate) {
          response.writeHead(503).end();
          return;
        }
      }
      const upstreamPort = gatewayRejectCandidate && selectedPort === candidatePort ? activePort : selectedPort;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, upstreamPort }));
    });
    servers.push(gatewayServer);
    const gatewayPort = await listen(gatewayServer);

    const fakeSystemctl = path.join(runtimeDirectory, "fake-systemctl.cjs");
    await fs.writeFile(fakeSystemctl, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, `${args.join(' ')}\\n`);",
      "if (process.env.FAKE_SYSTEMCTL_HANG_MATCH && args.join(' ').includes(process.env.FAKE_SYSTEMCTL_HANG_MATCH)) {",
      "  setInterval(() => {}, 1000);",
      "  return;",
      "}",
      "if (process.env.FAKE_SYSTEMCTL_DELAY_MATCH && args.join(' ').includes(process.env.FAKE_SYSTEMCTL_DELAY_MATCH)) {",
      "  setTimeout(() => {}, Number(process.env.FAKE_SYSTEMCTL_DELAY_MS || 0));",
      "  return;",
      "}",
      "if (args[0] === 'stop' && process.env.FAKE_SYSTEMCTL_TRIGGER_UNIT && args[1] === process.env.FAKE_SYSTEMCTL_TRIGGER_UNIT && process.env.FAKE_SYSTEMCTL_MARK_HEALTH_AFTER_STOP) {",
      "  fs.writeFileSync(process.env.FAKE_SYSTEMCTL_MARK_HEALTH_AFTER_STOP, 'failed\\n');",
      "}",
      "if (args[0] === 'is-active') {",
      "  const state = process.env.FAKE_SYSTEMCTL_OPERATION_STATE || 'unknown';",
      "  process.stdout.write(`${state}\\n`);",
      "  process.exit(state === 'active' ? 0 : state === 'unknown' ? 4 : 3);",
      "}",
      "",
    ].join("\n"), { mode: 0o700 });
    await fs.chmod(fakeSystemctl, 0o700);
    const selectorPauseHook = path.join(runtimeDirectory, "pause-selector-before-commit.cjs");
    await fs.writeFile(selectorPauseHook, [
      "const fs = require('node:fs');",
      "const originalOpen = fs.promises.open.bind(fs.promises);",
      "const originalReadFile = fs.promises.readFile.bind(fs.promises);",
      "const originalRename = fs.promises.rename.bind(fs.promises);",
      "const originalSetTimeout = global.setTimeout;",
      "const longTimeoutScale = Number(process.env.FAKE_DEPLOY_LONG_TIMEOUT_SCALE);",
      "if (Number.isFinite(longTimeoutScale) && longTimeoutScale > 0 && longTimeoutScale < 1) {",
      "  global.setTimeout = (callback, milliseconds, ...args) => originalSetTimeout(",
      "    callback,",
      "    Number(milliseconds) >= 30000 ? Math.max(1, Number(milliseconds) * longTimeoutScale) : milliseconds,",
      "    ...args,",
      "  );",
      "}",
      "fs.promises.readFile = async (candidate, ...args) => {",
      "  if (String(candidate) === '/proc/self/cgroup' && process.env.FAKE_DEPLOY_CGROUP_UNIT) {",
      "    return `0::/system.slice/${process.env.FAKE_DEPLOY_CGROUP_UNIT}\\n`;",
      "  }",
      "  const unreadablePid = process.env.FAKE_PROC_UNREADABLE_PID;",
      "  if (unreadablePid && String(candidate).startsWith(`/proc/${unreadablePid}/`)) {",
      "    const error = new Error('simulated unreadable proc identity');",
      "    error.code = 'EACCES';",
      "    throw error;",
      "  }",
      "  return originalReadFile(candidate, ...args);",
      "};",
      "fs.promises.rename = async (source, destination) => {",
      "  if (process.env.FAKE_SELECTOR_TRACE_DESTINATION === String(destination)) {",
      "    fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, 'selector candidate\\n');",
      "  }",
      "  return originalRename(source, destination);",
      "};",
      "fs.promises.open = async (candidate, ...args) => {",
      "  const handle = await originalOpen(candidate, ...args);",
      "  const destination = process.env.FAKE_SELECTOR_PAUSE_DESTINATION;",
      "  const marker = process.env.FAKE_SELECTOR_PAUSE_MARKER;",
      "  if (destination && marker && String(candidate).startsWith(`${destination}.`) && String(candidate).endsWith('.tmp')) {",
      "    const originalClose = handle.close.bind(handle);",
      "    handle.close = async () => {",
      "      const result = await originalClose();",
      "      fs.writeFileSync(marker, 'ready\\n', { mode: 0o600 });",
      "      process.kill(process.pid, 'SIGSTOP');",
      "      return result;",
      "    };",
      "  }",
      "  return handle;",
      "};",
      "",
    ].join("\n"), { mode: 0o600 });

    const releasesDirectory = path.join(runtimeDirectory, "releases");
    const slotsDirectory = path.join(runtimeDirectory, "slots");
    const previousSlotTarget = path.join(releasesDirectory, "v0.0.0");
    const releaseDirectory = path.join(releasesDirectory, `v${packageJson.version}`);
    const bootstrapSlot = path.join(slotsDirectory, String(activePort));
    const candidateSlot = path.join(slotsDirectory, String(candidatePort));
    await fs.mkdir(previousSlotTarget, { recursive: true });
    await fs.mkdir(slotsDirectory, { recursive: true });
    await seedVerifiedRelease(releaseDirectory);
    await fs.symlink(previousSlotTarget, candidateSlot);
    const operationId = `test-${Date.now()}-${candidatePort}`;
    const baseEnvironment = {
      ...process.env,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_UPSTREAM_HOST: "127.0.0.1",
      CODEX_DESKTOP_UPSTREAM_PORTS: `${activePort},${candidatePort}`,
      CODEX_DESKTOP_GATEWAY_PORT: String(gatewayPort),
      CODEX_DESKTOP_READY_TIMEOUT_MS: "2000",
      CODEX_DESKTOP_SYSTEMCTL: fakeSystemctl,
      CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN: "12345678-1234-4123-8123-123456789abc",
      CODEX_DESKTOP_DEPLOYMENT_WATCH_TEST_MODE: "1",
      FAKE_SYSTEMCTL_LOG: systemctlLog,
      FAKE_SELECTOR_TRACE_DESTINATION: activePortPath,
    };
    await operation({
      runtimeDirectory,
      activePortPath,
      preparedPath,
      activePort,
      candidatePort,
      bootstrapSlot,
      candidateSlot,
      candidateFailureMarker,
      activeFailureMarker,
      previousSlotTarget,
      releaseDirectory,
      operationId,
      watchToken: baseEnvironment.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN,
      systemctlLog,
      abandonPrepared: async (update = {}) => {
        const prepared = JSON.parse(await fs.readFile(preparedPath, "utf8"));
        prepared.ownerStartTicks = prepared.ownerStartTicks === "0" ? "1" : "0";
        Object.assign(prepared, update);
        await fs.writeFile(preparedPath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 });
      },
      setCandidateHealthy: async (healthy) => {
        candidateHealthy = healthy;
      },
      setCandidateRuntimeBundleReady: async (ready) => {
        candidateRuntimeBundleReady = ready;
      },
      setActiveHealthy: async (healthy) => {
        activeHealthy = healthy;
      },
      setAuthHandoffSupported: async (supported) => {
        activeAuthHandoffSupported = supported;
      },
      setAuthHandoffDelay: async (milliseconds) => {
        authHandoffDelayMs = milliseconds;
      },
      setCandidateReadyDelay: async (milliseconds) => {
        candidateReadyDelayMs = milliseconds;
      },
      prepareActiveAuthHandoff: async () => {
        const response = await fetch(`http://127.0.0.1:${activePort}/internal/auth-handoff/prepare`, {
          method: "POST",
        });
        assert.equal(response.status, 200);
      },
      setGatewayRejectCandidate: async (rejectCandidate) => {
        gatewayRejectCandidate = rejectCandidate;
      },
      breakActivePortOnCandidateSelection: async () => {
        breakActivePortOnCandidate = true;
        gatewayRejectCandidate = true;
      },
      recoverCandidateAfterPreviousGatewayFailure: async () => {
        recoverCandidateAfterPreviousFailure = true;
      },
      failAllGatewaysAfterCandidateSelection: async () => {
        failAllGatewaysAfterCandidate = true;
      },
      readActivePort: async () => Number((await fs.readFile(activePortPath, "utf8")).trim()),
      run: (arguments_, environment = {}) => runDeploy(
        arguments_,
        { ...baseEnvironment, ...environment },
        { preloadPath: selectorPauseHook },
      ),
      runPausedAfterSwitch: (arguments_, environment, pauseMs) => runDeploy(
        arguments_,
        { ...baseEnvironment, ...environment },
        {
          preloadPath: selectorPauseHook,
          pauseAfterSelection: { activePortPath, selectedPort: candidatePort, pauseMs },
        },
      ),
      runPausedBeforeSelectorCommit: async (arguments_, environment, pauseMs, onPaused) => {
        const markerPath = path.join(runtimeDirectory, "selector-before-commit.ready");
        await fs.rm(markerPath, { force: true });
        return runDeploy(
          arguments_,
          {
            ...baseEnvironment,
            ...environment,
            FAKE_SELECTOR_PAUSE_DESTINATION: activePortPath,
            FAKE_SELECTOR_PAUSE_MARKER: markerPath,
          },
          {
            preloadPath: selectorPauseHook,
            resumeAfterMarker: { markerPath, pauseMs, onPaused },
          },
        );
      },
    });
  } finally {
    await Promise.all(servers.map(close));
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
}

async function seedVerifiedRelease(directory, { sourceCommit = "0".repeat(40) } = {}) {
  for (const relativePath of fixtureReleaseFiles) {
    const destination = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(process.cwd(), relativePath), destination);
  }
  await fs.writeFile(path.join(directory, ".codex-package.json"), `${JSON.stringify({
    format: 2,
    name: packageJson.name,
    version: packageJson.version,
    sourceCommit,
    stateSchema: 1,
    minimumStateSchema: 1,
    capabilities: [
      "deployment-recovery-v1",
      "main-standby-handoff-v1",
      CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
    ],
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(directory, "node_modules"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function runDeploy(arguments_, environment, {
  pauseAfterSelection = null,
  preloadPath = null,
  resumeAfterMarker = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...(preloadPath ? ["--require", preloadPath] : []),
      deployPath,
      ...arguments_,
    ], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `deploy.mjs exited with status ${code}`));
    });
    if (pauseAfterSelection) {
      pauseChildAfterSelection(child, pauseAfterSelection, () => settled).catch((error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        reject(error);
      });
    }
    if (resumeAfterMarker) {
      resumeChildAfterMarker(child, resumeAfterMarker, () => settled).catch((error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        reject(error);
      });
    }
  });
}

function runProcess(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

async function pauseChildAfterSelection(child, { activePortPath, selectedPort, pauseMs }, isSettled) {
  const deadline = Date.now() + 5_000;
  while (!isSettled() && Date.now() < deadline) {
    const selected = Number((await fs.readFile(activePortPath, "utf8").catch(() => "")).trim());
    if (selected === selectedPort) {
      if (!child.kill("SIGSTOP")) throw new Error("Could not pause deployment after backend selection");
      await delay(pauseMs);
      if (!isSettled()) child.kill("SIGCONT");
      return;
    }
    await delay(10);
  }
  throw new Error("Deployment did not select the candidate before the pause deadline");
}

async function resumeChildAfterMarker(child, { markerPath, pauseMs, onPaused }, isSettled) {
  const deadline = Date.now() + 5_000;
  while (!isSettled() && Date.now() < deadline) {
    if (await fs.stat(markerPath).then(() => true, () => false)) {
      const observation = Promise.resolve().then(() => onPaused?.());
      await delay(pauseMs);
      await observation;
      if (!isSettled()) child.kill("SIGCONT");
      return;
    }
    await delay(10);
  }
  throw new Error("Deployment did not reach the selector commit pause point");
}

async function assertCandidatePreservedForRecovery(fixture) {
  const prepared = JSON.parse(await fs.readFile(fixture.preparedPath, "utf8"));
  assert.equal(prepared.schemaVersion, 4);
  assert.equal(prepared.stageState, "recovery-required");
  assert.ok(prepared.drainDeadlineAt - prepared.recoveryDeadlineAt >= 18_000);
  assert.equal(prepared.watchToken, fixture.watchToken);
  assert.equal(typeof prepared.drainToken, "string");
  assert.equal(prepared.activationMode, "standby-handoff");
  assert.equal(prepared.candidateBackendInstanceId, "backend-instance-candidate");
  assert.equal(await fs.readlink(fixture.candidateSlot), fixture.releaseDirectory);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function snapshotTree(root) {
  const snapshot = {};
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        pending.push(filename);
      } else if (entry.isSymbolicLink()) {
        snapshot[relative] = `link:${await fs.readlink(filename)}`;
      } else {
        snapshot[relative] = (await fs.readFile(filename)).toString("base64");
      }
    }
  }
  return snapshot;
}

function activationEnvironment(drain, { deadlineAt = Date.now() + 55_000 } = {}) {
  return {
    CODEX_DESKTOP_DRAIN_TOKEN: drain.token,
    CODEX_DESKTOP_DRAIN_TTL_MS: "20000",
    CODEX_DESKTOP_DRAIN_DEADLINE_AT: String(deadlineAt),
  };
}

function functionBlock(name, nextName) {
  const start = deploy.indexOf(`async function ${name}`);
  const end = deploy.indexOf(`async function ${nextName}`, start + 1);
  return start === -1 || end === -1 ? null : deploy.slice(start, end);
}
