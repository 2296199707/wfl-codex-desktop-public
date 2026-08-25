import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { ReleaseStatusStore } from "../lib/release-status.mjs";

const appUpdatePath = fileURLToPath(new URL("../scripts/update-app.mjs", import.meta.url));
const codexUpdatePath = fileURLToPath(new URL("../scripts/update-codex.mjs", import.meta.url));

test("application update reclaims a lock whose pid belongs to an unrelated process", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const operationId = `app-update-lock-test-${Date.now()}`;
    const lockPath = path.join(runtimeDirectory, "app-update.lock");
    await fs.writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
    await new DeploymentCancelStore(runtimeDirectory).requestCancel(operationId);

    const result = await runWorker(appUpdatePath, { runtimeDirectory, stateDirectory, operationId });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Another application update is already running/);
    const status = JSON.parse(await fs.readFile(path.join(stateDirectory, "app-update-status.json"), "utf8"));
    assert.match(status.detail, /所有者取消/);
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  });
});

test("Codex update reclaims a lock whose pid belongs to an unrelated process", async () => {
  await withDirectories(async ({ runtimeDirectory, stateDirectory }) => {
    const operationId = `codex-update-lock-test-${Date.now()}`;
    const lockPath = path.join(runtimeDirectory, "codex-update.lock");
    await fs.writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
    await new DeploymentCancelStore(runtimeDirectory).requestCancel(operationId);

    const result = await runWorker(codexUpdatePath, { runtimeDirectory, stateDirectory, operationId });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /Another Codex update is already running/);
    const status = JSON.parse(await fs.readFile(path.join(stateDirectory, "codex-update-status.json"), "utf8"));
    assert.match(status.error, /cancelled by the owner/i);
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  });
});

test("application update ignores a stale raw release phase after lock and unit are inactive", async () => {
  await withDirectories(async ({ root, runtimeDirectory, stateDirectory }) => {
    const sourceDirectory = path.join(root, "source");
    const systemctlCommand = path.join(root, "systemctl-stub.cjs");
    await fs.mkdir(sourceDirectory);
    await fs.writeFile(path.join(sourceDirectory, "VERSION"), "0.0.0\n");
    await fs.writeFile(systemctlCommand, "#!/usr/bin/env node\nprocess.exit(4);\n", { mode: 0o700 });
    const staleNow = Date.now() - 60_000;
    await new ReleaseStatusStore(stateDirectory, { now: () => staleNow }).write({
      status: "running",
      phase: "testing",
      version: "0.0.1",
      unit: `wfl-codex-stale-release-${Date.now()}`,
      startedAt: staleNow - 60_000,
    });

    const result = await runWorker(appUpdatePath, {
      runtimeDirectory,
      stateDirectory,
      sourceDirectory,
      systemctlCommand,
      operationId: `app-update-stale-release-${Date.now()}`,
    });
    assert.equal(result.code, 1);
    const status = JSON.parse(await fs.readFile(path.join(stateDirectory, "app-update-status.json"), "utf8"));
    assert.equal(status.phase, "failed");
    assert.doesNotMatch(status.error || "", /网页版本正在发布/);
  });
});

async function withDirectories(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "update-lock-"));
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  await fs.mkdir(runtimeDirectory, { recursive: true });
  try {
    await operation({ root, runtimeDirectory, stateDirectory });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runWorker(script, {
  runtimeDirectory,
  stateDirectory,
  sourceDirectory = null,
  systemctlCommand = null,
  operationId,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--worker"], {
      env: {
        ...process.env,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_OPERATION_ID: operationId,
        ...(sourceDirectory ? { CODEX_DESKTOP_SOURCE_DIR: sourceDirectory } : {}),
        ...(systemctlCommand ? { CODEX_DESKTOP_SYSTEMCTL: systemctlCommand } : {}),
      },
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
