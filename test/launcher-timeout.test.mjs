import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const updateAppPath = fileURLToPath(new URL("../scripts/update-app.mjs", import.meta.url));
const sources = {
  release: await fs.readFile(new URL("../scripts/release.mjs", import.meta.url), "utf8"),
  appUpdate: await fs.readFile(new URL("../scripts/update-app.mjs", import.meta.url), "utf8"),
  codexUpdate: await fs.readFile(new URL("../scripts/update-codex.mjs", import.meta.url), "utf8"),
  rollback: await fs.readFile(new URL("../scripts/rollback.mjs", import.meta.url), "utf8"),
  server: await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8"),
};

test("every maintenance launcher has an independent hard deadline", () => {
  for (const [name, source] of Object.entries({
    release: sources.release,
    appUpdate: sources.appUpdate,
    codexUpdate: sources.codexUpdate,
    rollback: sources.rollback,
  })) {
    assert.match(source, /const MAINTENANCE_LAUNCH_TIMEOUT_MS = boundedLauncherDuration/);
    const launchStart = source.indexOf('await run("systemd-run"');
    const launchEnd = source.indexOf("launched = true", launchStart);
    assert.notEqual(launchStart, -1, `${name} systemd launcher was not found`);
    assert.match(
      source.slice(launchStart, launchEnd),
      /timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS/,
      `${name} systemd launcher is not bounded`,
    );
    assert.match(source, /child\.kill\("SIGTERM"\)/);
    assert.match(source, /child\.kill\("SIGKILL"\)/);
  }

  const codexEnableStart = sources.codexUpdate.indexOf('await run("systemctl", ["enable"');
  const codexLaunchStart = sources.codexUpdate.indexOf('await run("systemd-run"');
  assert.match(
    sources.codexUpdate.slice(codexEnableStart, codexLaunchStart),
    /timeoutMs: MAINTENANCE_LAUNCH_TIMEOUT_MS/,
  );

  const serverLauncherStart = sources.server.indexOf("function launchDeploymentWorker");
  const serverLauncherEnd = sources.server.indexOf("function assertOperationRequest", serverLauncherStart);
  const serverLauncher = sources.server.slice(serverLauncherStart, serverLauncherEnd);
  assert.match(serverLauncher, /DEPLOYMENT_LAUNCH_TIMEOUT_MS/);
  assert.match(serverLauncher, /detached: true/);
  assert.match(serverLauncher, /SIGTERM/);
  assert.match(serverLauncher, /SIGKILL/);
  assert.match(serverLauncher, /processGroup: true/);

  const restoreStart = sources.server.indexOf("async function launchBackupRestoreWorker");
  const restoreEnd = sources.server.indexOf("async function writeBackupRestoreStatus", restoreStart);
  assert.match(
    sources.server.slice(restoreStart, restoreEnd),
    /runChild\("systemd-run",[\s\S]*?timeoutMs: DEPLOYMENT_LAUNCH_TIMEOUT_MS/,
  );
});

test("a stuck systemd-run is terminated and cannot retain the maintenance reservation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-timeout-"));
  const sourceDirectory = path.join(root, "source");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const binaryDirectory = path.join(root, "bin");
  const signalLog = path.join(root, "signals.log");
  const pidFile = path.join(root, "systemd-run.pid");
  let launcher = null;
  let stuckPid = null;
  t.after(async () => {
    launcher?.kill("SIGKILL");
    if (stuckPid) {
      try {
        process.kill(stuckPid, "SIGKILL");
      } catch {
        // The timeout path should already have reaped the process.
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    fs.mkdir(sourceDirectory, { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(binaryDirectory, { recursive: true }),
  ]);
  await fs.writeFile(path.join(sourceDirectory, "VERSION"), "0.0.0\n");
  const fakeSystemdRun = path.join(binaryDirectory, "systemd-run");
  await fs.writeFile(fakeSystemdRun, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'fs.writeFileSync(process.env.STUCK_PID_FILE, String(process.pid));',
    'fs.appendFileSync(process.env.STUCK_SIGNAL_LOG, "started\\n");',
    'process.on("SIGTERM", () => {',
    '  fs.appendFileSync(process.env.STUCK_SIGNAL_LOG, "SIGTERM\\n");',
    "});",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), { mode: 0o755 });

  const startedAt = Date.now();
  const launcherEnvironment = {
    ...process.env,
    PATH: `${binaryDirectory}:${process.env.PATH || ""}`,
    CODEX_DESKTOP_SOURCE_DIR: sourceDirectory,
    CODEX_DESKTOP_STATE_DIR: stateDirectory,
    CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
    CODEX_DESKTOP_RUNNING_VERSION: "0.0.0",
    CODEX_DESKTOP_LAUNCH_TIMEOUT_MS: "500",
    CODEX_DESKTOP_LAUNCH_KILL_GRACE_MS: "100",
    STUCK_PID_FILE: pidFile,
    STUCK_SIGNAL_LOG: signalLog,
  };
  delete launcherEnvironment.NODE_TEST_CONTEXT;
  launcher = spawn(process.execPath, [updateAppPath], {
    cwd: sourceDirectory,
    env: launcherEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await collectProcess(launcher, 3_000);
  assert.equal(result.code, 1);
  assert.ok(Date.now() - startedAt < 2_500, "launcher did not reject within its hard deadline");

  stuckPid = Number(await fs.readFile(pidFile, "utf8"));
  assert.match(await fs.readFile(signalLog, "utf8"), /SIGTERM/);
  await waitForProcessExit(stuckPid);

  const status = JSON.parse(await fs.readFile(path.join(stateDirectory, "app-update-status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.equal(status.phase, "failed");
  assert.equal(status.detail, "无法启动后台安全同步任务");
  await assert.rejects(
    fs.access(path.join(runtimeDirectory, "maintenance-reservation.json")),
    { code: "ENOENT" },
  );
});

function collectProcess(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`launcher did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => finish(null, { code, signal, stdout, stderr }));
  });
}

async function waitForProcessExit(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`stuck systemd-run process ${pid} survived SIGKILL`);
}
