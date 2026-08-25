import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reserveMaintenanceOperation } from "../lib/operation-lock.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const restoreScript = path.join(projectDirectory, "scripts", "restore-data-backup.mjs");
const restoreSource = await fs.readFile(restoreScript, "utf8");
const backupId = "b-20260101T000000Z-deadbeef";
const outerRecoveryStart = restoreSource.indexOf("} catch (error) {\n  if (restoreLock) {");
const outerFinallyStart = restoreSource.indexOf("} finally {", outerRecoveryStart);

test("restore rollback stop is fenced by the hard deadline and otherwise fails forward", () => {
  const recovery = restoreSource.slice(
    outerRecoveryStart,
    outerFinallyStart,
  );
  const rollbackGate = recovery.indexOf("await canRollbackWithinDrain");
  const rollbackStop = recovery.indexOf('await run("systemctl", ["stop", unit]');
  const failForward = recovery.indexOf('preferredGeneration = "new"', rollbackStop);
  const durableRecovery = recovery.indexOf("await recoverJournalGeneration", failForward);
  const compensatingStart = recovery.indexOf('await run("systemctl", ["start", unit]', durableRecovery);
  assert.ok(rollbackGate >= 0 && rollbackGate < rollbackStop);
  assert.ok(rollbackStop < failForward && failForward < durableRecovery && durableRecovery < compensatingStart);
  assert.match(restoreSource, /timeoutMs: stopTimeoutMs/);
  assert.match(restoreSource, /timeoutMs: recoveryStopTimeoutMs/);
  assert.match(restoreSource, /timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS/);
});

test("restore swaps and rollback recovery are persisted through the durable journal", () => {
  const switching = restoreSource.slice(
    restoreSource.indexOf("await commitRestoreDecision()"),
    outerRecoveryStart,
  );
  const recovery = restoreSource.slice(
    outerRecoveryStart,
    outerFinallyStart,
  );
  const journalCreate = switching.indexOf("await swapJournal.create");
  const stop = switching.indexOf('await run("systemctl", ["stop", unit]', journalCreate);
  const moveOld = switching.indexOf("await swapJournal.moveOriginalAside", stop);
  const activateNew = switching.indexOf("await swapJournal.activateReplacement", moveOld);
  assert.ok(journalCreate >= 0 && journalCreate < stop);
  assert.ok(stop < moveOld && moveOld < activateNew);
  assert.match(recovery, /swapJournal\.setDesiredGeneration\(preferredGeneration\)/);
  assert.match(recovery, /recoverJournalGeneration\(preferredGeneration\)/);
  assert.match(recovery, /preserveRecoveryArtifacts = true/);
  assert.match(recovery, /swapJournal\.clear\(pendingJournal\.operationId\)/);
  assert.doesNotMatch(restoreSource, /await fs\.rename\(entry\.(?:target|replacement|previous)/);
});

test("restore terminal status is durable before its swap journal is cleared", () => {
  const normal = restoreSource.slice(
    restoreSource.indexOf('await swapJournal.setPhase("verified")'),
    outerRecoveryStart,
  );
  const normalTerminal = normal.indexOf('await update("completed"');
  const normalClear = normal.indexOf("await swapJournal.clear(operationId)", normalTerminal);
  assert.ok(normalTerminal >= 0 && normalTerminal < normalClear);

  const failureTerminal = restoreSource.indexOf('await update("failed", detail', outerRecoveryStart);
  const failureClear = restoreSource.indexOf(
    "await swapJournal.clear(pendingJournal.operationId)",
    failureTerminal,
  );
  assert.ok(failureTerminal >= 0 && failureTerminal < failureClear);

  const recoveryGate = restoreSource.indexOf("async function recoverJournalGeneration");
  const inactiveFence = restoreSource.indexOf("await assertRestoreDataServicesInactive()", recoveryGate);
  const journalRecovery = restoreSource.indexOf(
    "return swapJournal.recoverConsistentGeneration({ preferredGeneration })",
    recoveryGate,
  );
  assert.ok(recoveryGate >= 0 && recoveryGate < inactiveFence && inactiveFence < journalRecovery);
});

test("restore checks orphan and legacy data services before drain, commit, and rename", () => {
  const switching = restoreSource.slice(
    restoreSource.indexOf("activePort = Number"),
    outerRecoveryStart,
  );
  const firstPeerCheck = switching.indexOf(
    "await assertRestoreDataServicesInactive({ allowedActiveUnits: [unit] })",
  );
  const drain = switching.indexOf("await waitForIdleDrain", firstPeerCheck);
  const secondPeerCheck = switching.indexOf(
    "await assertRestoreDataServicesInactive({ allowedActiveUnits: [unit] })",
    firstPeerCheck + 1,
  );
  const commit = switching.indexOf("await commitRestoreDecision()", secondPeerCheck);
  const stop = switching.indexOf('await run("systemctl", ["stop", unit]', commit);
  const allStopped = switching.indexOf("await assertRestoreDataServicesInactive()", stop);
  const rename = switching.indexOf("await swapJournal.moveOriginalAside(index)", allStopped);
  assert.ok(firstPeerCheck >= 0 && firstPeerCheck < drain);
  assert.ok(drain < secondPeerCheck && secondPeerCheck < commit);
  assert.ok(commit < stop && stop < allStopped && allStopped < rename);
});

test("a restarted restore consumes a still-live reservation before reclaiming its stale lock", async () => {
  await fixture(async ({ environment, lockPath, operationId, runtimeDirectory }) => {
    await writeStaleLock(lockPath, operationId);
    await writeTerminalStatus(runtimeDirectory, operationId, "completed");
    const reservation = await reserveMaintenanceOperation(runtimeDirectory, {
      operationKind: "restore",
      operationId,
      ownerCommand: "test/restore-lock.test.mjs",
    });

    const result = await runRestore({
      ...environment,
      CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN: reservation.record.token,
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(
      fs.access(path.join(runtimeDirectory, "maintenance-reservation.json")),
      (error) => error.code === "ENOENT",
    );
    assert.equal(JSON.parse(await fs.readFile(
      path.join(runtimeDirectory, "backup-restore-status.json"),
      "utf8",
    )).status, "completed");
  });
});

test("a systemd restart resumes only from matching stale evidence after reservation consumption", async () => {
  await fixture(async ({ environment, lockPath, operationId, runtimeDirectory }) => {
    await writeStaleLock(lockPath, operationId);
    await writeTerminalStatus(runtimeDirectory, operationId, "failed");
    const result = await runRestore({
      ...environment,
      CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN: "already-consumed-reservation",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await fs.readFile(
      path.join(runtimeDirectory, "backup-restore-status.json"),
      "utf8",
    )).status, "failed");
  });
});

test("a post-cleanup systemd restart preserves an exact terminal status without other evidence", async () => {
  await fixture(async ({ environment, lockPath, operationId, runtimeDirectory }) => {
    await writeTerminalStatus(runtimeDirectory, operationId, "completed");
    const result = await runRestore({
      ...environment,
      CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN: "already-consumed-reservation",
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.access(lockPath), (error) => error.code === "ENOENT");
    const status = JSON.parse(await fs.readFile(
      path.join(runtimeDirectory, "backup-restore-status.json"),
      "utf8",
    ));
    assert.equal(status.status, "completed");
    assert.equal(status.detail, "terminal restore");
    await assert.rejects(
      fs.access(environment.CODEX_DESKTOP_BACKUP_DIR),
      (error) => error.code === "ENOENT",
    );
  });
});

test("a failed restart lock acquisition never overwrites the exact terminal status", async () => {
  await fixture(async ({ environment, lockPath, operationId, runtimeDirectory }) => {
    await writeTerminalStatus(runtimeDirectory, operationId, "completed");
    await fs.writeFile(lockPath, "{}\n", { mode: 0o600 });
    const result = await runRestore({
      ...environment,
      CODEX_DESKTOP_MAINTENANCE_RESERVATION_TOKEN: "already-consumed-reservation",
    });
    assert.equal(result.code, 2);
    const status = JSON.parse(await fs.readFile(
      path.join(runtimeDirectory, "backup-restore-status.json"),
      "utf8",
    ));
    assert.equal(status.status, "completed");
    assert.equal(status.detail, "terminal restore");
    assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), {});
  });
});

test("an active restore worker lock cannot be replaced", async () => {
  await fixture(async ({ runtimeDirectory, environment, lockPath }) => {
    const owner = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000)", restoreScript, backupId, "--worker",
    ], { cwd: projectDirectory, stdio: "ignore" });
    await childStarted(owner);
    try {
      const record = await lockRecord(owner.pid);
      await fs.writeFile(lockPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

      const result = await runRestore(environment);
      assert.equal(result.code, 2);
      assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, record.token);
    } finally {
      owner.kill("SIGKILL");
      await childExited(owner);
    }
  });
});

test("a restore lock is reclaimed after its exact owner exits", async () => {
  await fixture(async ({ environment, lockPath }) => {
    const owner = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000)", restoreScript, backupId, "--worker",
    ], { cwd: projectDirectory, stdio: "ignore" });
    await childStarted(owner);
    const record = await lockRecord(owner.pid);
    await fs.writeFile(lockPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    owner.kill("SIGKILL");
    await childExited(owner);

    const result = await runRestore(environment);
    assert.equal(result.code, 2);
    await assert.rejects(fs.access(lockPath), (error) => error.code === "ENOENT");
  });
});

test("a fresh unverifiable restore lock fails closed", async () => {
  await fixture(async ({ environment, lockPath }) => {
    await fs.writeFile(lockPath, "{}\n", { mode: 0o600 });
    const result = await runRestore(environment);
    assert.equal(result.code, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), {});
  });
});

async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-lock-"));
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  const backupDirectory = path.join(root, "backups");
  const operationId = `restore-lock-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await fs.mkdir(runtimeDirectory, { recursive: true });
  try {
    await operation({
      runtimeDirectory,
      lockPath: path.join(runtimeDirectory, "backup-restore.lock"),
      operationId,
      environment: {
        ...process.env,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_BACKUP_DIR: backupDirectory,
        CODEX_DESKTOP_SOURCE_DIR: projectDirectory,
        CODEX_DESKTOP_OPERATION_ID: operationId,
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeStaleLock(lockPath, operationId) {
  await fs.writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    token: `stale-restore-${crypto.randomUUID()}`,
    pid: 2_147_483_647,
    startTicks: "1",
    operationId,
    backupId,
    workerMarker: true,
    createdAt: Date.now(),
  })}\n`, { mode: 0o600 });
}

async function writeTerminalStatus(runtimeDirectory, operationId, status) {
  await fs.writeFile(path.join(runtimeDirectory, "backup-restore-status.json"), `${JSON.stringify({
    status,
    phase: status,
    backupId,
    operationId,
    unit: operationId,
    detail: "terminal restore",
    startedAt: Date.now() - 100,
    updatedAt: Date.now(),
    completedAt: Date.now(),
    error: status === "failed" ? "expected failure" : null,
  })}\n`, { mode: 0o600 });
}

async function lockRecord(pid) {
  return {
    schemaVersion: 1,
    token: `owner-${pid}`,
    pid,
    startTicks: await processStartTicks(pid),
    operationId: `restore-owner-${pid}`,
    backupId,
    workerMarker: true,
    createdAt: Date.now(),
  };
}

async function processStartTicks(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  assert.notEqual(commandEnd, -1);
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  assert.match(fields[19], /^\d+$/);
  return fields[19];
}

function childStarted(child) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function childExited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function runRestore(environment) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [restoreScript, backupId, "--worker"], {
      cwd: projectDirectory,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
