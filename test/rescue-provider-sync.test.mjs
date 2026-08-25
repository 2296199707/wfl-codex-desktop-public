import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";
import { managedProviderId, ProviderStore } from "../lib/provider-store.mjs";
import { publishRescueCredentialMirror } from "../lib/rescue-credential-mirror.mjs";

const projectDirectory = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");

test("the rescue runtime reloads a managed provider key before resuming and sending", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-provider-sync-"));
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const homeDirectory = path.join(root, "home");
  const project = path.join(root, "project");
  const binDirectory = path.join(root, "bin");
  let child = null;
  try {
    await Promise.all([
      fs.mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
      fs.mkdir(project, { recursive: true }),
      fs.mkdir(binDirectory, { recursive: true }),
    ]);
    const store = await new ProviderStore(stateDirectory).initialize();
    const futurePluginState = `${JSON.stringify({ version: 999, future: { opaque: true } }, null, 2)}\n`;
    await fs.writeFile(path.join(stateDirectory, "plugins.json"), futurePluginState, { mode: 0o600 });
    const profile = await store.create({
      name: "Rescue managed API",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-smoke",
      apiKey: "rescue-provider-secret",
    });
    await store.setActive(profile.id);
    await fs.writeFile(
      path.join(homeDirectory, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "main-only-token" } }),
      { mode: 0o600 },
    );
    const rescueAuth = createAuthRecord("owner", "owner-password-1234");
    const rescueAuthPath = path.join(runtimeDirectory, "rescue-auth", "test", "auth.json");
    const rescueMirrorPath = path.join(runtimeDirectory, "rescue-credentials", "current.json");
    await publishRescueCredentialMirror({
      mirrorPath: rescueMirrorPath,
      source: {
        userId: "u-0000000000000000",
        username: "owner",
        role: "owner",
        status: "active",
        password: rescueAuth,
      },
    });
    await writeAuth(rescueAuthPath, rescueAuth);

    const shim = path.join(binDirectory, "codex");
    await fs.writeFile(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
      { mode: 0o755 },
    );
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        HOME: homeDirectory,
        PATH: `${binDirectory}:${process.env.PATH}`,
        HOST: "127.0.0.1",
        PORT: String(port),
        CODEX_DESKTOP_RESCUE_MODE: "1",
        CODEX_DESKTOP_PROJECT_ROOT: root,
        CODEX_DESKTOP_DEFAULT_PROJECT: project,
        CODEX_DESKTOP_AUTH_FILE: rescueAuthPath,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_SOURCE_DIR: projectDirectory,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_MULTI_USER_ROOT: path.join(root, "users"),
        CODEX_DESKTOP_OWNER_CODEX_HOME: path.join(homeDirectory, ".codex"),
        CODEX_DESKTOP_RESCUE_CODEX_HOME: path.join(runtimeDirectory, "rescue-codex-homes", "test"),
        CODEX_DESKTOP_RESCUE_AUTH_FILE: rescueAuthPath,
        CODEX_DESKTOP_RESCUE_CREDENTIAL_MIRROR: rescueMirrorPath,
        CODEX_DESKTOP_RELEASE_DISABLED: "1",
        CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
        FAKE_CODEX_PROJECT: project,
        FAKE_CODEX_CONFIG_MODEL_PROVIDER: managedProviderId(profile.id),
        FAKE_CODEX_REQUIRE_PROVIDER_KEY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(child);
    const sharedMainSessionToken = (await fs.readFile(path.join(stateDirectory, "session-token"), "utf8")).trim();
    const sharedSessionAttempt = await fetch(`${baseUrl}/api/projects`, {
      headers: { Cookie: `codex_desktop_auth=${sharedMainSessionToken}` },
    });
    assert.equal(sharedSessionAttempt.status, 401);
    assert.equal(await fs.readFile(path.join(stateDirectory, "plugins.json"), "utf8"), futurePluginState);
    const rescueCodexHome = path.join(runtimeDirectory, "rescue-codex-homes", "test");
    await assert.rejects(() => fs.access(path.join(rescueCodexHome, "auth.json")), { code: "ENOENT" });
    assert.notEqual(
      await fs.realpath(path.join(rescueCodexHome, "sessions")),
      await fs.realpath(path.join(homeDirectory, ".codex", "sessions")),
    );
    const rescueStore = await new ProviderStore(path.join(runtimeDirectory, "rescue-provider")).initialize();
    assert.equal(rescueStore.snapshot().activeId, profile.id);
    assert.equal(rescueStore.getActiveProfile().apiKey, "rescue-provider-secret");

    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/rescue/ws`, {
      headers: {
        Authorization: `Basic ${Buffer.from("owner:owner-password-1234").toString("base64")}`,
        Origin: baseUrl,
      },
    });
    await waitForOpen(socket);
    const started = await rpc(socket, 1, "thread/start", {
      cwd: project,
      model: "gpt-smoke",
      ephemeral: false,
    });
    assert.equal(started.type, "rpc/result");
    assert.equal(started.result.thread.modelProvider, managedProviderId(profile.id));

    const turn = await rpc(socket, 2, "turn/start", {
      threadId: started.result.thread.id,
      cwd: project,
      model: "gpt-smoke",
      effort: "medium",
      clientUserMessageId: "rescue-provider-sync-message",
      _wflThreadLeaseOwnerId: "rescue-provider-sync-window",
      input: [{ type: "text", text: "Continue through the rescue provider", text_elements: [] }],
    });
    assert.equal(turn.type, "rpc/result");
    assert.equal(turn.result.turn.status, "inProgress");
    socket.close();
  } finally {
    if (child) await stop(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function rpc(socket, requestId, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "rpc", requestId, method, params }));
  });
}

function waitForServer(processHandle) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Rescue server did not start: ${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes("WFL Codex Desktop Rescue v")) return;
      clearTimeout(timer);
      processHandle.stdout.off("data", onData);
      processHandle.stderr.off("data", onData);
      resolve();
    };
    processHandle.stdout.on("data", onData);
    processHandle.stderr.on("data", onData);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Rescue server exited early (${code}): ${output}`));
    });
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });
}

function stop(processHandle) {
  if (processHandle.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      resolve();
    }, 2_000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    processHandle.kill("SIGTERM");
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
