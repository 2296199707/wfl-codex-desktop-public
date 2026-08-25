import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareRescueVersions, rescueVersionIsNewer } from "../lib/rescue-component.mjs";

const rescueUpdateScript = fileURLToPath(new URL("../scripts/update-rescue.mjs", import.meta.url));

test("rescue update help and invalid arguments never launch an update worker", async () => {
  const help = await runProcess(process.execPath, [rescueUpdateScript, "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node scripts\/update-rescue\.mjs/);
  const invalid = await runProcess(process.execPath, [rescueUpdateScript, "--unknown"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Unknown rescue update argument/);
});

test("manual rescue update atomically replaces the fixed 4321 rescue slot", async () => {
  const fixture = await createFixture();
  try {
    fixture.rescueServer = await startJsonServer(fixture.rescuePort, () => ({
      ok: true,
      rescueMode: true,
      version: "1.1.8",
      codexReady: true,
      threadListReady: true,
      runtimeBundleReady: true,
      codeModeHostReady: true,
    }));
    fixture.gatewayServer = await startJsonServer(fixture.gatewayPort, () => ({
      ok: true,
      connectionPolicyVersion: 5,
      rescueFallback: false,
      rescueChannelIsolated: true,
      rescueUpstreamPort: fixture.rescuePort,
    }));

    await runWorker(fixture);

    assert.equal(await fs.realpath(fixture.rescueDirectory), fixture.releaseDirectory);
    await assert.rejects(fs.access(path.join(fixture.runtimeDirectory, "rescue-active-port")), { code: "ENOENT" });
    assert.equal(
      await fs.realpath(path.join(fixture.releaseDirectory, "node_modules")),
      path.join(process.cwd(), "node_modules"),
    );
    const status = JSON.parse(await fs.readFile(path.join(fixture.runtimeDirectory, "rescue-update.json"), "utf8"));
    assert.equal(status.status, "completed");
    assert.equal(status.version, "1.1.8");
    assert.equal(status.previousVersion, "1.1.7");
    assert.equal(status.activePort, 4321);
    const calls = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(calls, /enable --now wfl-codex-desktop-rescue@4321\.service/);
    assert.match(calls, /disable --now wfl-codex-desktop-rescue@4321\.service/);
    assert.match(calls, /daemon-reload/);
    const installedUnit = await fs.readFile(fixture.rescueUnitPath, "utf8");
    assert.match(installedUnit, /Restart=on-failure/);
    assert.match(installedUnit, /StartLimitBurst=5/);
  } finally {
    await fixture.close();
  }
});

test("manual rescue update rejects a non-increasing component version", async () => {
  const fixture = await createFixture({ activeRescueVersion: "1.1.8" });
  try {
    await assert.rejects(
      () => runWorker(fixture, { expectFailure: true }),
      /Rescue component version must increase: current 1\.1\.8, candidate 1\.1\.8/,
    );
    assert.equal(await fs.realpath(fixture.rescueDirectory), fixture.oldRescueDirectory);
    const status = JSON.parse(await fs.readFile(path.join(fixture.runtimeDirectory, "rescue-update.json"), "utf8"));
    assert.equal(status.status, "failed");
  } finally {
    await fixture.close();
  }
});

test("rescue update accepts a validated candidate-suffixed main release", async () => {
  const fixture = await createFixture({ releaseName: "v0.37.7-deadbeefcafe" });
  try {
    fixture.activeServer = await startJsonServer(fixture.activePort, () => ({
      ok: true,
      taskIdle: true,
      maintenanceIdle: true,
      draining: false,
    }));
    fixture.rescueServer = await startJsonServer(fixture.rescuePort, () => ({
      ok: true,
      rescueMode: true,
      version: "1.1.8",
      codexReady: true,
      threadListReady: true,
      runtimeBundleReady: true,
      codeModeHostReady: true,
    }));
    fixture.gatewayServer = await startJsonServer(fixture.gatewayPort, async () => ({
      ok: true,
      connectionPolicyVersion: 5,
      rescueFallback: false,
      rescueChannelIsolated: true,
      rescueUpstreamPort: fixture.rescuePort,
    }));
    await runWorker(fixture);
    assert.equal(await fs.realpath(fixture.rescueDirectory), fixture.releaseDirectory);
    const status = JSON.parse(await fs.readFile(path.join(fixture.runtimeDirectory, "rescue-update.json"), "utf8"));
    assert.equal(status.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("rescue component versions use semantic ordering", () => {
  assert.equal(compareRescueVersions("1.2.0", "1.1.99"), 1);
  assert.equal(compareRescueVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(rescueVersionIsNewer("1.2.0", "1.2.0-beta.10"), true);
  assert.throws(() => rescueVersionIsNewer("version-two", "1.1.8"), /semantic versioning/);
});

test("manual rescue update restores the old directory when candidate readiness fails", async () => {
  const fixture = await createFixture();
  try {
    fixture.activeServer = await startJsonServer(fixture.activePort, () => ({
      ok: true,
      taskIdle: true,
      maintenanceIdle: true,
      draining: false,
    }));
    fixture.gatewayServer = await startJsonServer(fixture.gatewayPort, () => ({
      ok: true,
      connectionPolicyVersion: 5,
      rescueFallback: false,
      rescueChannelIsolated: true,
      rescueUpstreamPort: fixture.rescuePort,
    }));
    await assert.rejects(() => runWorker(fixture, { expectFailure: true }), /did not become ready/);
    assert.equal(await fs.realpath(fixture.rescueDirectory), fixture.oldRescueDirectory);
    const calls = await fs.readFile(fixture.systemctlLog, "utf8");
    assert.match(calls, /disable --now wfl-codex-desktop-rescue@4321\.service/);
    const status = JSON.parse(await fs.readFile(path.join(fixture.runtimeDirectory, "rescue-update.json"), "utf8"));
    assert.equal(status.status, "failed");
  } finally {
    await fixture.close();
  }
});

async function createFixture({
  candidateRescueVersion = "1.1.8",
  activeRescueVersion = "1.1.7",
  releaseName = "v0.37.7",
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-update-"));
  const runtimeDirectory = path.join(directory, "runtime");
  const releaseDirectory = path.join(runtimeDirectory, "releases", releaseName);
  const oldRescueDirectory = path.join(directory, "old-rescue");
  const activePort = await getFreePort();
  const rescuePort = await getFreePort();
  const gatewayPort = await getFreePort();
  const rescueDirectory = path.join(runtimeDirectory, "rescue-slots", "4321");
  const systemctlLog = path.join(directory, "systemctl.log");
  const systemctl = path.join(directory, "systemctl.cjs");
  const rescueUnitPath = path.join(directory, "wfl-codex-desktop-rescue@.service");
  await Promise.all([
    fs.mkdir(path.join(runtimeDirectory, "slots"), { recursive: true }),
    fs.mkdir(path.join(runtimeDirectory, "rescue-slots"), { recursive: true }),
    fs.mkdir(releaseDirectory, { recursive: true }),
    fs.mkdir(oldRescueDirectory, { recursive: true }),
  ]);
  await seedRelease(releaseDirectory, candidateRescueVersion);
  await seedRescueIdentity(oldRescueDirectory, activeRescueVersion);
  await Promise.all([
    fs.writeFile(path.join(runtimeDirectory, "active-port"), "4318\n"),
    fs.writeFile(path.join(runtimeDirectory, "deployment.json"), JSON.stringify({
      sourceDirectory: directory,
      projectRoot: directory,
      defaultProject: path.join(directory, "workspace"),
      stateDirectory: path.join(directory, "state"),
      runtimeDirectory,
      nodeBinary: process.execPath,
      serviceHome: directory,
      usersRoot: path.join(directory, "users"),
      ownerCodexHome: path.join(directory, "codex-home"),
      candidateReleasesEnabled: false,
    })),
    fs.writeFile(rescueUnitPath, "legacy rescue unit\n"),
    fs.symlink(releaseDirectory, path.join(runtimeDirectory, "slots", "4318"), "dir"),
    fs.symlink(oldRescueDirectory, rescueDirectory, "dir"),
    fs.writeFile(systemctl, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(systemctlLog)}, process.argv.slice(2).join(' ') + '\\n');`,
      "",
    ].join("\n"), { mode: 0o700 }),
  ]);
  return {
    directory,
    runtimeDirectory,
    releaseDirectory,
    oldRescueDirectory,
    rescueDirectory,
    activePort,
    rescuePort,
    gatewayPort,
    systemctl,
    systemctlLog,
    rescueUnitPath,
    activeServer: null,
    rescueServer: null,
    gatewayServer: null,
    async close() {
      await Promise.all([
        closeServer(this.activeServer),
        closeServer(this.rescueServer),
        closeServer(this.gatewayServer),
      ]);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function seedRelease(directory, rescueVersion) {
  const assets = [
    "server.mjs",
    "lib/rescue-plugin-store.mjs",
    "lib/rescue-chat-snapshot.mjs",
    "lib/rescue-reference-store.mjs",
    "lib/rescue-thread-registry.mjs",
    "lib/service-units.mjs",
    "lib/thread-write-lease.mjs",
    "public/rescue.html",
    "public/rescue.css",
    "public/rescue.js",
    "public/i18n.js",
    "scripts/update-rescue.mjs",
    "systemd/wfl-codex-desktop-rescue@.service.template",
  ];
  await Promise.all(assets.map(async (relativePath) => {
    const filename = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, relativePath.endsWith("wfl-codex-desktop-rescue@.service.template")
      ? [
        "[Unit]",
        "StartLimitIntervalSec=120s",
        "StartLimitBurst=5",
        "[Service]",
        "WorkingDirectory={{RUNTIME_DIR}}/rescue-slots/4321",
        "Environment=HOME={{SERVICE_HOME}}",
        "Environment=PATH={{SERVICE_PATH}}",
        "Environment=CODEX_DESKTOP_STATE_DIR={{STATE_DIR}}",
        "Environment=CODEX_DESKTOP_RUNTIME_DIR={{RUNTIME_DIR}}",
        "Environment=PORT=4321",
        "Environment=CODEX_DESKTOP_RESCUE_MODE=1",
        "ExecStart={{NODE_BIN}} {{RUNTIME_DIR}}/rescue-slots/4321/server.mjs",
        "Restart=on-failure",
        "RestartSec=5s",
        "",
      ].join("\n")
      : "fixture\n");
  }));
  await Promise.all([
    fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "wfl-codex-desktop", version: "0.37.7" })),
    fs.writeFile(path.join(directory, ".codex-package.json"), JSON.stringify({
      format: 2,
      name: "wfl-codex-desktop",
      version: "0.37.7",
      rescueVersion,
      capabilities: ["deployment-recovery-v1", "owner-rescue-v3"],
    })),
  ]);
}

async function seedRescueIdentity(directory, rescueVersion) {
  await Promise.all([
    fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "wfl-codex-desktop-rescue",
      version: rescueVersion,
    })),
    fs.writeFile(path.join(directory, ".codex-package.json"), JSON.stringify({
      format: 2,
      name: "wfl-codex-desktop-rescue",
      version: rescueVersion,
      rescueVersion,
      capabilities: ["owner-rescue-v3"],
    })),
  ]);
}

function runWorker(fixture, { expectFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      new URL("../scripts/update-rescue.mjs", import.meta.url).pathname,
      "--worker",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_DESKTOP_RUNTIME_DIR: fixture.runtimeDirectory,
        CODEX_DESKTOP_RESCUE_TEST_MODE: "1",
        CODEX_DESKTOP_RESCUE_PORT: String(fixture.rescuePort),
        CODEX_DESKTOP_GATEWAY_PORT: String(fixture.gatewayPort),
        CODEX_DESKTOP_SYSTEMCTL: fixture.systemctl,
        CODEX_DESKTOP_RESCUE_UNIT_PATH: fixture.rescueUnitPath,
        CODEX_DESKTOP_RESCUE_READY_TIMEOUT_MS: "500",
        CODEX_DESKTOP_RESCUE_SWITCH_SETTLE_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && !expectFailure) resolve(output);
      else if (code !== 0 && expectFailure) reject(new Error(output.trim()));
      else reject(new Error(`unexpected update exit ${code}: ${output}`));
    });
  });
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function startJsonServer(port, payload) {
  const server = http.createServer(async (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(await payload()));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
