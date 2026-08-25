import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppUpdateStatusStore } from "../lib/app-update-status.mjs";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { ReleaseStatusStore } from "../lib/release-status.mjs";
import {
  acquireMaintenanceOperationLock,
  acquireOperationLock,
  reserveMaintenanceOperation,
} from "../lib/operation-lock.mjs";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const admissionOwnerFixture = fileURLToPath(new URL("fixtures/maintenance-admission-owner.mjs", import.meta.url));
const legacyAppParentFixture = fileURLToPath(new URL("fixtures/legacy-app-update-parent.mjs", import.meta.url));
const ownerFixture = fileURLToPath(new URL("fixtures/maintenance-lock-owner.mjs", import.meta.url));
const releaseScript = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const rollbackScript = fileURLToPath(new URL("../scripts/rollback.mjs", import.meta.url));
const appUpdateScript = fileURLToPath(new URL("../scripts/update-app.mjs", import.meta.url));

test("an application update blocks a different rollback before either can stage a deployment", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const owner = await startOwner(runtimeDirectory, "app-update", "app-owner-a");
    try {
      const result = await runNode(rollbackScript, ["--worker", "--version", "0.0.0"], {
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: "rollback-b",
      });
      assert.equal(result.code, 1);
      await assert.rejects(fs.access(path.join(runtimeDirectory, "release.lock")), { code: "ENOENT" });
    } finally {
      await stopOwner(owner);
    }
  });
});

test("a Codex update blocks a different release before either can stage a deployment", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const owner = await startOwner(runtimeDirectory, "codex-update", "codex-owner-a");
    try {
      const result = await runNode(releaseScript, ["--worker"], {
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: "release-b",
        CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1",
      });
      assert.equal(result.code, 1);
      await assert.rejects(fs.access(path.join(runtimeDirectory, "release.lock")), { code: "ENOENT" });
    } finally {
      await stopOwner(owner);
    }
  });
});

test("only a release may join its application-update parent operation", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const operationId = "nested-app-release";
    const owner = await startOwner(runtimeDirectory, "app-update", operationId);
    try {
      await new DeploymentCancelStore(runtimeDirectory).requestCancel(operationId);
      const release = await runNode(releaseScript, ["--worker"], {
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: operationId,
        CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1",
        CODEX_DESKTOP_LOCAL_CANDIDATE: "1",
        CODEX_DESKTOP_PACKAGE_SOURCE: "1",
        CODEX_DESKTOP_CANDIDATE_COMMIT: "0000000000000000000000000000000000000000",
      });
      assert.equal(release.code, 1, JSON.stringify(release));
      const releaseStatus = await new ReleaseStatusStore(stateDirectory).read();
      assert.equal(releaseStatus.phase, "failed", JSON.stringify({ release, releaseStatus }));
      assert.match(releaseStatus.error, /cancelled by the owner/i);

      const rollback = await runNode(rollbackScript, ["--worker", "--version", "0.0.0"], {
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: operationId,
      });
      assert.equal(rollback.code, 1);
      await assert.rejects(fs.access(path.join(runtimeDirectory, "release.lock")), { code: "ENOENT" });
    } finally {
      await stopOwner(owner);
    }
  });
});

test("a release accepts only its exact legacy application-update parent during first upgrade", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const operationId = `wfl-codex-app-update-${Date.now()}`;
    await new AppUpdateStatusStore(stateDirectory).write({
      status: "running",
      phase: "deploying",
      unit: operationId,
      detail: "legacy parent is starting the target release",
      startedAt: Date.now(),
    });
    await new DeploymentCancelStore(runtimeDirectory).requestCancel(operationId);
    const result = await runNode(legacyAppParentFixture, [
      runtimeDirectory,
      stateDirectory,
      operationId,
      "scripts/update-app.mjs",
      "--worker",
    ], {
      CODEX_DESKTOP_LOCAL_CANDIDATE: "1",
      CODEX_DESKTOP_PACKAGE_SOURCE: "1",
      CODEX_DESKTOP_CANDIDATE_COMMIT: "0000000000000000000000000000000000000000",
    });
    assert.equal(result.code, 1, JSON.stringify(result));
    const status = await new ReleaseStatusStore(stateDirectory).read();
    assert.equal(status.unit, operationId, JSON.stringify({ result, status }));
    assert.equal(status.phase, "failed");
    assert.match(status.error, /cancelled by the owner/i);
  });
});

test("a restore lock participates in the same maintenance conflict set", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const owner = await startOwner(runtimeDirectory, "restore", "restore-owner-a");
    try {
      const result = await runNode(releaseScript, ["--worker"], {
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: "release-during-restore",
        CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1",
      });
      assert.equal(result.code, 1);
      await assert.rejects(fs.access(path.join(runtimeDirectory, "release.lock")), { code: "ENOENT" });
    } finally {
      await stopOwner(owner);
    }
  });
});

test("a launch reservation is handed only to its matching worker", async () => {
  await withDirectories(async ({ runtimeDirectory }) => {
    const operationId = "reservation-owner";
    const reservation = await reserveMaintenanceOperation(runtimeDirectory, {
      operationKind: "release",
      operationId,
      ownerCommand: "test/maintenance-admission.test.mjs",
    });
    await assert.rejects(
      reserveMaintenanceOperation(runtimeDirectory, {
        operationKind: "codex-update",
        operationId: "reservation-loser",
        ownerCommand: "test/maintenance-admission.test.mjs",
      }),
      (error) => error.code === "ERR_MAINTENANCE_CONFLICT",
    );

    const lockPath = path.join(runtimeDirectory, "release.lock");
    const lockOptions = {
      ownerCommand: "test/maintenance-admission.test.mjs",
      acceptedCommands: ["test/maintenance-admission.test.mjs"],
    };
    const lock = await acquireMaintenanceOperationLock(runtimeDirectory, {
      operationKind: "release",
      operationId,
      ownerCommand: "test/maintenance-admission.test.mjs",
      reservationToken: reservation.record.token,
      lockPath,
      lockOptions,
      acquireLock: () => acquireOperationLock(lockPath, { ...lockOptions, operationId }),
    });
    await assert.rejects(fs.access(path.join(runtimeDirectory, "maintenance-reservation.json")), { code: "ENOENT" });
    await lock.release();
  });
});

test("a server-owned admission lock excludes CLI maintenance launchers", async () => {
  await withDirectories(async ({ runtimeDirectory }) => {
    const owner = await startAdmissionOwner(runtimeDirectory, "server-admission-owner");
    try {
      await assert.rejects(
        reserveMaintenanceOperation(runtimeDirectory, {
          operationKind: "release",
          operationId: "cli-reservation-loser",
          ownerCommand: "test/maintenance-admission.test.mjs",
          admissionWaitMs: 100,
        }),
        (error) => error.code === "ERR_MAINTENANCE_CONFLICT",
      );
      await assert.rejects(
        fs.access(path.join(runtimeDirectory, "maintenance-reservation.json")),
        { code: "ENOENT" },
      );
    } finally {
      await stopOwner(owner);
    }
  });
});

test("a losing worker cannot overwrite the active winner status", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const winner = "app-update-winner";
    const owner = await startOwner(runtimeDirectory, "app-update", winner);
    const store = new AppUpdateStatusStore(stateDirectory);
    try {
      await store.write({
        status: "running",
        phase: "checking",
        unit: winner,
        detail: "winner is active",
        startedAt: Date.now(),
      });
      const result = await runNode(appUpdateScript, ["--worker"], {
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: "app-update-loser",
      });
      assert.equal(result.code, 1);
      const status = await store.read();
      assert.equal(status.unit, winner);
      assert.equal(status.phase, "checking");
      assert.equal(status.detail, "winner is active");
    } finally {
      await stopOwner(owner);
    }
  });
});

test("two same-type launchers preserve the winner's queued status", async () => {
  await withDirectories(async ({ root, runtimeDirectory, stateDirectory }) => {
    const sourceDirectory = path.join(root, "source");
    const binaryDirectory = path.join(root, "bin");
    await fs.mkdir(sourceDirectory);
    await fs.mkdir(binaryDirectory);
    await fs.writeFile(path.join(sourceDirectory, "VERSION"), "0.0.0\n");
    const systemdRun = path.join(binaryDirectory, "systemd-run");
    const systemdRunLog = path.join(root, "systemd-run.log");
    await fs.writeFile(systemdRun, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.SYSTEMD_RUN_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "setTimeout(() => process.exit(0), 200);",
      "",
    ].join("\n"), { mode: 0o700 });
    const environment = {
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: sourceDirectory,
      SYSTEMD_RUN_LOG: systemdRunLog,
      PATH: `${binaryDirectory}:${process.env.PATH}`,
    };
    const results = await Promise.all([
      runNode(appUpdateScript, [], environment),
      runNode(appUpdateScript, [], environment),
    ]);
    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code !== 0);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const invocation = JSON.parse((await fs.readFile(systemdRunLog, "utf8")).trim());
    const launchedUnit = invocation.find((argument) => argument.startsWith("--unit=")).slice(7);
    const status = await new AppUpdateStatusStore(stateDirectory).read();
    assert.equal(status.phase, "queued");
    assert.equal(status.unit, launchedUnit);
  });
});

async function withDirectories(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-admission-"));
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  await fs.mkdir(runtimeDirectory, { recursive: true });
  try {
    await operation({ root, runtimeDirectory, stateDirectory });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function startOwner(runtimeDirectory, operationKind, operationId) {
  const definition = {
    "app-update": { marker: "scripts/update-app.mjs", file: "app-update.lock" },
    "codex-update": { marker: "scripts/update-codex.mjs", file: "codex-update.lock" },
    release: { marker: "scripts/release.mjs", file: "release.lock" },
    restore: { marker: "scripts/restore-data-backup.mjs", file: "backup-restore.lock" },
  }[operationKind];
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    ownerFixture, runtimeDirectory, operationKind, operationId, definition.marker, "--worker",
  ], { cwd: projectDirectory, env: environment, stdio: "ignore" });
  child.once("error", () => {});
  const lockPath = path.join(runtimeDirectory, definition.file);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`lock owner exited early (${child.exitCode})`);
    try {
      const record = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (record.operationId === operationId && record.pid === child.pid) return child;
    } catch {
      // The child publishes a complete record atomically; wait until it appears.
    }
    await delay(10);
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  throw new Error("lock owner did not start");
}

async function startAdmissionOwner(runtimeDirectory, operationId) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    admissionOwnerFixture, runtimeDirectory, operationId, "server.mjs",
  ], { cwd: projectDirectory, env: environment, stdio: "ignore" });
  child.once("error", () => {});
  const lockPath = path.join(runtimeDirectory, "maintenance-admission.lock");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`admission owner exited early (${child.exitCode})`);
    try {
      const record = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (record.operationId === operationId && record.pid === child.pid) return child;
    } catch {
      // Wait for the admission record to be exposed.
    }
    await delay(10);
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  throw new Error("admission owner did not start");
}

async function stopOwner(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runNode(script, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env, ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [script, ...arguments_], {
      cwd: projectDirectory,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
