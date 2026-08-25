import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";

const rollbackPath = fileURLToPath(new URL("../scripts/rollback.mjs", import.meta.url));
const releasePath = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const rollbackSource = await fs.readFile(rollbackPath, "utf8");

test("rollback launcher clears stale active status only after worker and unit checks", () => {
  const launcher = rollbackSource.slice(
    rollbackSource.indexOf("async function launchWorker"),
    rollbackSource.indexOf("async function runWorker"),
  );
  assert.match(launcher, /ACTIVE_ROLLBACK_PHASES\.has\(current\.phase\) && await rollbackIsStillRunning\(current\)/);
  assert.ok(launcher.indexOf("rollbackIsStillRunning") < launcher.indexOf('phase: "failed"'));
  assert.match(rollbackSource, /async function rollbackIsStillRunning[\s\S]*?operationLockState/);
  assert.match(rollbackSource, /reclaimInactiveOperationLock/);
  assert.match(rollbackSource, /systemdUnitMayBeActive[\s\S]*?systemctl[\s\S]*?is-active/);
});

test("rollback worker reclaims a release lock whose owner exited", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const lockPath = path.join(runtimeDirectory, "release.lock");
    await fs.writeFile(lockPath, "2147483647\n", { mode: 0o600 });

    const result = await runRollbackWorker({ runtimeDirectory, stateDirectory });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Another release, update, or rollback is already running/);
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  });
});

test("rollback worker preserves a lock owned by a live release worker", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const owner = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000)", "scripts/release.mjs", "--worker",
    ], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      owner.once("spawn", resolve);
      owner.once("error", reject);
    });
    const lockPath = path.join(runtimeDirectory, "release.lock");
    try {
      await fs.writeFile(lockPath, `${owner.pid}\n`, { mode: 0o600 });
      const result = await runRollbackWorker({ runtimeDirectory, stateDirectory });
      assert.equal(result.code, 1);
      assert.equal((await fs.readFile(lockPath, "utf8")).trim(), String(owner.pid));
    } finally {
      owner.kill("SIGTERM");
      await new Promise((resolve) => owner.once("exit", resolve));
    }
  });
});

test("release worker reclaims a lock whose pid was reused by an unrelated process", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const lockPath = path.join(runtimeDirectory, "release.lock");
    const operationId = `release-lock-test-${Date.now()}`;
    await fs.writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
    await new DeploymentCancelStore(runtimeDirectory).requestCancel(operationId);

    const result = await runReleaseWorker({ runtimeDirectory, stateDirectory, operationId });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Another release is already running/);
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  });
});

test("release worker preserves a lock owned by a live rollback worker", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const owner = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000)", "scripts/rollback.mjs", "--worker",
    ], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      owner.once("spawn", resolve);
      owner.once("error", reject);
    });
    const lockPath = path.join(runtimeDirectory, "release.lock");
    try {
      await fs.writeFile(lockPath, `${owner.pid}\n`, { mode: 0o600 });
      const result = await runReleaseWorker({
        runtimeDirectory,
        stateDirectory,
        operationId: `release-lock-live-${Date.now()}`,
      });
      assert.equal(result.code, 1);
      assert.equal((await fs.readFile(lockPath, "utf8")).trim(), String(owner.pid));
    } finally {
      owner.kill("SIGTERM");
      await new Promise((resolve) => owner.once("exit", resolve));
    }
  });
});

async function withDirectories(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rollback-lock-"));
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  await fs.mkdir(runtimeDirectory, { recursive: true });
  try {
    await operation({ runtimeDirectory, stateDirectory });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runRollbackWorker({ runtimeDirectory, stateDirectory }) {
  return runWorker(rollbackPath, ["--worker", "--version", "0.0.0"], {
    ...process.env,
    CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
    CODEX_DESKTOP_STATE_DIR: stateDirectory,
  });
}

function runReleaseWorker({ runtimeDirectory, stateDirectory, operationId }) {
  return runWorker(releasePath, ["--worker"], {
    ...process.env,
    CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
    CODEX_DESKTOP_STATE_DIR: stateDirectory,
    CODEX_DESKTOP_OPERATION_ID: operationId,
    CODEX_DESKTOP_CANCEL_DECISION_MANAGED: "1",
    CODEX_DESKTOP_LOCAL_CANDIDATE: "1",
    CODEX_DESKTOP_PACKAGE_SOURCE: "1",
    CODEX_DESKTOP_CANDIDATE_COMMIT: "0000000000000000000000000000000000000000",
  });
}

function runWorker(script, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [script, ...arguments_], {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
