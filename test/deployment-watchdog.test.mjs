import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEPLOYMENT_RECOVERY_RESERVE_MS,
  startDeploymentWatchdog,
} from "../lib/deployment-watchdog.mjs";

const watcherScript = fileURLToPath(new URL("../scripts/watch-deployment.mjs", import.meta.url));
const watcherSource = await fs.readFile(watcherScript, "utf8");
const watchdogLauncherSource = await fs.readFile(
  new URL("../lib/deployment-watchdog.mjs", import.meta.url),
  "utf8",
);
const deploymentRecoveryUnit = await fs.readFile(
  new URL("../systemd/wfl-codex-desktop-deployment-recovery.service.template", import.meta.url),
  "utf8",
);
const operationId = "wfl-codex-app-update-123456";
const ownerUnit = `${operationId}.service`;
const ownerPid = 4242;
const ownerStartTicks = "987654";
const deploymentWorkerPid = 4343;
const deploymentWorkerStartTicks = "876543";
const watchToken = "12345678-1234-4123-8123-123456789abc";

test("watchdog bounds the Codex gate and reserves eighteen seconds for topology recovery", () => {
  assert.match(watcherSource, /OWNER_STATUS_TIMEOUT_MS = 500/);
  assert.match(watcherSource, /OWNER_KILL_TIMEOUT_MS = 1_000/);
  assert.match(watcherSource, /OWNER_TERMINATION_TIMEOUT_MS = 1_000/);
  assert.match(watcherSource, /CODEX_RECOVERY_TIMEOUT_MS = 30_000/);
  assert.match(watcherSource, /TOPOLOGY_RECOVERY_TIMEOUT_MS = 14_000/);
  assert.match(watcherSource, /MAX_RELEASE_DRAIN_MS/);
  assert.match(watcherSource, /remainingDrainMs > MAX_RELEASE_DRAIN_MS \+ 500/);
  assert.match(watcherSource, /drainDeadlineAt - TOPOLOGY_RECOVERY_TIMEOUT_MS - RECOVERY_FINISH_MARGIN_MS/);
  assert.match(watcherSource, /boundedRemaining\(takeoverDeadline, OWNER_KILL_TIMEOUT_MS\)/);
});

test("deployment recovery workers do not automatically restart after a deterministic failure", () => {
  assert.doesNotMatch(watchdogLauncherSource, /--property=Restart=/);
  assert.doesNotMatch(watchdogLauncherSource, /--property=RestartSec=/);
  assert.match(deploymentRecoveryUnit, /StartLimitIntervalSec=120s/);
  assert.match(deploymentRecoveryUnit, /StartLimitBurst=45/);
  assert.doesNotMatch(deploymentRecoveryUnit, /^Restart=/m);
  assert.doesNotMatch(deploymentRecoveryUnit, /^RestartSec=/m);
});

test("deployment failure restores Codex before recovering backend topology", () => {
  const execStarts = deploymentRecoveryUnit
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ExecStart="));

  assert.match(deploymentRecoveryUnit, /Type=oneshot/);
  assert.match(deploymentRecoveryUnit, /TimeoutStartSec=45s/);
  assert.deepEqual(execStarts, [
    "ExecStart={{NODE_BIN}} {{SOURCE_DIR}}/scripts/recover-interrupted-deployment.mjs",
  ]);
  assert.ok(!execStarts[0].startsWith("ExecStart=-"));
});

test("watchdog launch refuses to stage without a ready handshake", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-watchdog-launch-"));
  try {
    const noHandshake = path.join(root, "no-handshake.cjs");
    await fs.writeFile(noHandshake, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    await assert.rejects(
      startDeploymentWatchdog({
        sourceDirectory: process.cwd(),
        runtimeDirectory: root,
        operationId,
        systemdRunCommand: noHandshake,
        startTimeoutMs: 50,
      }),
      /did not become ready/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("watchdog launch bounds a stuck systemd-run command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-watchdog-launch-timeout-"));
  try {
    const stuckLauncher = path.join(root, "stuck-launcher.cjs");
    await fs.writeFile(stuckLauncher, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
    const startedAt = Date.now();
    await assert.rejects(
      startDeploymentWatchdog({
        sourceDirectory: process.cwd(),
        runtimeDirectory: root,
        operationId,
        systemdRunCommand: stuckLauncher,
        startTimeoutMs: 50,
        launcherTimeoutMs: 50,
      }),
      /timed out after 50ms/,
    );
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("watchdog accepts Codex owner-decision operation units", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-watchdog-decision-"));
  try {
    const noHandshake = path.join(root, "no-handshake.cjs");
    await fs.writeFile(noHandshake, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    await assert.rejects(
      startDeploymentWatchdog({
        sourceDirectory: process.cwd(),
        runtimeDirectory: root,
        operationId: "wfl-codex-update-decision-123456-abcdef12",
        systemdRunCommand: noHandshake,
        startTimeoutMs: 50,
      }),
      /did not become ready/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("owner exit recovers once and a restarted watchdog is idempotent", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await delay(200);
    await fixture.deactivateOwner();
    const first = await watcher.done;
    assert.equal(first.code, 0, first.stderr);
    const firstRecovery = (await fs.readFile(fixture.recoveryLog, "utf8")).trim();
    assert.equal(firstRecovery.split(/\r?\n/).length, 2);
    assert.equal(firstRecovery, `codex\ntopology:${watchToken}`);
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });

    const restarted = fixture.spawn();
    const second = await restarted.done;
    assert.equal(second.code, 0, second.stderr);
    assert.equal((await fs.readFile(fixture.recoveryLog, "utf8")).trim().split(/\r?\n/).length, 2);
  });
});

test("legacy schema 3 stop-first manifest remains recoverable", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({
      schemaVersion: 3,
      activationMode: "stop-first",
      stageState: "ready",
    });
    await fixture.deactivateOwner();

    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fs.readFile(fixture.recoveryLog, "utf8")).trim(), `codex\ntopology:${watchToken}`);
  });
});

test("an unreadable owner process still recovers after its verified systemd unit stops", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await fixture.makeOwnerUnverifiable();
    await fixture.deactivateOwnerUnit();

    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fs.readFile(fixture.recoveryLog, "utf8")).trim(), `codex\ntopology:${watchToken}`);
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });
  });
});

test("a zombie owner process is treated as exited before watchdog recovery", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await fixture.makeOwnerZombie();

    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fs.readFile(fixture.recoveryLog, "utf8")).trim(), `codex\ntopology:${watchToken}`);
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });
  });
});

test("deadline takeover kills the verified owner unit before recovery", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    const recoveryDeadlineAt = Date.now() + 250;
    await fixture.writeManifest({
      stageState: "old-stopped",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + DEPLOYMENT_RECOVERY_RESERVE_MS,
      drainToken: "drain-token-1234567890",
    });
    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    const systemctlLog = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(systemctlLog, new RegExp(`kill --kill-who=all --signal=SIGKILL ${ownerUnit.replaceAll(".", "\\.")}`));
    assert.match(await fs.readFile(fixture.recoveryLog, "utf8"), /codex\ntopology:/);
  });
});

test("normal manifest removal disarms the watchdog without recovery", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await delay(200);
    await fs.rm(fixture.manifestFile);
    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.access(fixture.recoveryLog), { code: "ENOENT" });
  });
});

test("owner loss keeps a deferred activated deployment recoverable", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    const recoveryDeadlineAt = Date.now() + 5_000;
    await fixture.writeManifest({
      stageState: "activated",
      recoveryDeadlineAt,
      drainDeadlineAt: recoveryDeadlineAt + DEPLOYMENT_RECOVERY_RESERVE_MS,
      drainToken: "drain-token-1234567890",
    });
    await fixture.deactivateOwner();
    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(await fs.readFile(fixture.recoveryLog, "utf8"), /codex\ntopology:/);
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });
  });
});

test("watchdog waits for the deploy worker after the release owner exits", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.setDeploymentWorkerActive(true);
    await fixture.writeManifest({
      stageState: "writer-transferred",
      forcedActivation: true,
      deploymentWorkerPid,
      deploymentWorkerStartTicks,
    });
    await fixture.deactivateOwner();
    await delay(250);
    await assert.rejects(fs.access(fixture.recoveryLog), { code: "ENOENT" });

    await fixture.setDeploymentWorkerActive(false);
    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(await fs.readFile(fixture.recoveryLog, "utf8"), /topology:/);
  });
});

test("watchdog waits for an active deploy lock before the worker fingerprint is committed", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await fixture.setDeploymentLockActive(true);
    await fixture.deactivateOwner();
    await delay(250);
    await assert.rejects(fs.access(fixture.recoveryLog), { code: "ENOENT" });

    await fixture.setDeploymentLockActive(false);
    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(await fs.readFile(fixture.recoveryLog, "utf8"), /topology:/);
  });
});

test("owner loss recovers a forced deferred activation without a drain deadline", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({
      stageState: "activated",
      forcedActivation: true,
    });
    await fixture.deactivateOwner();
    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(await fs.readFile(fixture.recoveryLog, "utf8"), /codex\ntopology:/);
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });
  });
});

test("successful recovery preserves Codex-before-topology ordering", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await fixture.deactivateOwner();

    const result = await watcher.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      (await fs.readFile(fixture.recoveryLog, "utf8")).trim(),
      `codex\ntopology:${watchToken}`,
    );
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });
  });
});

test("failed Codex installation recovery still allows backend topology recovery", async () => {
  await withFixture(async (fixture) => {
    fixture.failCodexRecovery();
    const watcher = await fixture.start();
    await fixture.writeManifest({ stageState: "ready" });
    await fixture.deactivateOwner();

    const result = await watcher.done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /codex:.*exited with status 23/);
    assert.equal(
      await fs.readFile(fixture.recoveryLog, "utf8"),
      `codex\ntopology:${watchToken}\n`,
    );
    await assert.rejects(fs.access(fixture.manifestFile), { code: "ENOENT" });
    const failure = JSON.parse(await fs.readFile(fixture.failureFile, "utf8"));
    assert.equal(failure.status, "failed");
    assert.equal(failure.errors[0].stage, "codex");
    assert.match(failure.errors[0].message, /exited with status 23/);
  });
});

test("operation mismatch is rejected without touching either backend", async () => {
  await withFixture(async (fixture) => {
    const watcher = await fixture.start();
    await fixture.writeManifest({ operationId: "wfl-codex-app-update-999999", stageState: "ready" });
    const result = await watcher.done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /manifest owned by another operation/);
    await assert.rejects(fs.access(fixture.recoveryLog), { code: "ENOENT" });
  });
});

async function withFixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-watchdog-"));
  const sourceDirectory = path.join(root, "source");
  const runtimeDirectory = path.join(root, "runtime");
  const procRoot = path.join(root, "proc");
  const ownerDirectory = path.join(procRoot, String(ownerPid));
  const deploymentWorkerDirectory = path.join(procRoot, String(deploymentWorkerPid));
  const readyFile = path.join(runtimeDirectory, "watch-ready.json");
  const manifestFile = path.join(runtimeDirectory, "prepared-deployment.json");
  const failureFile = path.join(runtimeDirectory, "deployment-recovery-failure.json");
  const systemctlState = path.join(root, "systemctl.state");
  const systemctlLog = path.join(root, "systemctl.log");
  const recoveryLog = path.join(root, "recovery.log");
  const fakeSystemctl = path.join(root, "systemctl.cjs");
  try {
    await fs.mkdir(path.join(sourceDirectory, "scripts"), { recursive: true });
    await fs.mkdir(ownerDirectory, { recursive: true });
    await fs.writeFile(path.join(ownerDirectory, "stat"), processStat(ownerPid, ownerStartTicks));
    await fs.writeFile(path.join(ownerDirectory, "cgroup"), `0::/system.slice/${ownerUnit}\n`);
    await fs.writeFile(systemctlState, "active\n");
    await fs.writeFile(fakeSystemctl, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, `${args.join(' ')}\\n`);",
      "if (args[0] === 'is-active') {",
      "  const state = fs.readFileSync(process.env.FAKE_SYSTEMCTL_STATE, 'utf8').trim();",
      "  if (state === 'active') { process.stdout.write('active\\n'); process.exit(0); }",
      "  process.stdout.write('inactive\\n'); process.exit(3);",
      "}",
      "if (args[0] === 'kill') {",
      "  fs.writeFileSync(process.env.FAKE_SYSTEMCTL_STATE, 'inactive\\n');",
      "  fs.rmSync(process.env.FAKE_OWNER_DIRECTORY, { recursive: true, force: true });",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o700 });
    await fs.writeFile(path.join(sourceDirectory, "scripts", "deploy.mjs"), [
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "await fs.appendFile(process.env.FAKE_RECOVERY_LOG, `topology:${process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN || ''}\\n`);",
      "await fs.rm(path.join(process.env.CODEX_DESKTOP_RUNTIME_DIR, 'prepared-deployment.json'), { force: true });",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(sourceDirectory, "scripts", "recover-codex-update.mjs"), [
      "import fs from 'node:fs/promises';",
      "await fs.appendFile(process.env.FAKE_RECOVERY_LOG, 'codex\\n');",
      "if (process.env.FAKE_CODEX_RECOVERY_FAIL === '1') process.exit(23);",
      "",
    ].join("\n"));

    const environment = {
      ...process.env,
      CODEX_DESKTOP_SOURCE_DIR: sourceDirectory,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_SYSTEMCTL: fakeSystemctl,
      CODEX_DESKTOP_WATCH_PROC_ROOT: procRoot,
      CODEX_DESKTOP_WATCH_OPERATION_ID: operationId,
      CODEX_DESKTOP_WATCH_OWNER_PID: String(ownerPid),
      CODEX_DESKTOP_WATCH_OWNER_START_TICKS: ownerStartTicks,
      CODEX_DESKTOP_WATCH_OWNER_UNIT: ownerUnit,
      CODEX_DESKTOP_WATCH_READY_FILE: readyFile,
      CODEX_DESKTOP_WATCH_TOKEN: watchToken,
      FAKE_SYSTEMCTL_STATE: systemctlState,
      FAKE_SYSTEMCTL_LOG: systemctlLog,
      FAKE_OWNER_DIRECTORY: ownerDirectory,
      FAKE_RECOVERY_LOG: recoveryLog,
    };
    const spawnWatcher = () => spawnAndCollect(process.execPath, [watcherScript], environment);
    await operation({
      manifestFile,
      failureFile,
      recoveryLog,
      systemctlLog,
      spawn: spawnWatcher,
      failCodexRecovery() {
        environment.FAKE_CODEX_RECOVERY_FAIL = "1";
      },
      async start() {
        const child = spawnWatcher();
        await waitForFile(readyFile);
        return child;
      },
      async deactivateOwner() {
        await fs.writeFile(systemctlState, "inactive\n");
        await fs.rm(ownerDirectory, { recursive: true, force: true });
      },
      async deactivateOwnerUnit() {
        await fs.writeFile(systemctlState, "inactive\n");
      },
      async setDeploymentWorkerActive(active) {
        if (active) {
          await fs.mkdir(deploymentWorkerDirectory, { recursive: true });
          await fs.writeFile(
            path.join(deploymentWorkerDirectory, "stat"),
            processStat(deploymentWorkerPid, deploymentWorkerStartTicks),
          );
        } else {
          await fs.rm(deploymentWorkerDirectory, { recursive: true, force: true });
        }
      },
      async setDeploymentLockActive(active) {
        const lockPath = path.join(runtimeDirectory, "deploy.lock");
        if (!active) {
          await fs.rm(lockPath, { force: true });
          await fs.rm(deploymentWorkerDirectory, { recursive: true, force: true });
          return;
        }
        await fs.mkdir(deploymentWorkerDirectory, { recursive: true });
        await fs.writeFile(
          path.join(deploymentWorkerDirectory, "stat"),
          processStat(deploymentWorkerPid, deploymentWorkerStartTicks),
        );
        await fs.writeFile(
          path.join(deploymentWorkerDirectory, "cmdline"),
          `${process.execPath}\0${sourceDirectory}/scripts/deploy.mjs\0--activate-staged\0--operation-id\0${operationId}\0`,
        );
        await fs.writeFile(lockPath, `${JSON.stringify({
          schemaVersion: 1,
          token: "deployment-lock-token-123456",
          handoffToken: watchToken,
          pid: deploymentWorkerPid,
          startTicks: deploymentWorkerStartTicks,
          operationId,
          ownerCommand: "scripts/deploy.mjs",
          createdAt: Date.now(),
        })}\n`, { mode: 0o600 });
      },
      async makeOwnerUnverifiable() {
        await fs.rm(ownerDirectory, { recursive: true, force: true });
        await fs.mkdir(path.join(ownerDirectory, "stat"), { recursive: true });
      },
      async makeOwnerZombie() {
        await fs.writeFile(path.join(ownerDirectory, "stat"), processStat(ownerPid, ownerStartTicks, "Z"));
        await fs.writeFile(systemctlState, "inactive\n");
      },
      async writeManifest(update) {
        await fs.mkdir(runtimeDirectory, { recursive: true });
        await fs.writeFile(manifestFile, `${JSON.stringify({
          schemaVersion: 4,
          operationId,
          ownerPid,
          ownerStartTicks,
          watchToken,
          activationMode: "standby-handoff",
          ...update,
        })}\n`, { mode: 0o600 });
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function spawnAndCollect(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    child,
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
  };
}

function processStat(pid, startTicks, state = "S") {
  return `${pid} (watch-owner) ${[state, ...Array(18).fill("0"), startTicks].join(" ")}\n`;
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.stat(filePath).then(() => true, () => false)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
