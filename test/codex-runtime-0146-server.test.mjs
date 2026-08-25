import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fakeCodex = path.join(repositoryRoot, "test", "fixtures", "fake-codex-app-server.mjs");
const fakeClaude = path.join(repositoryRoot, "test", "fixtures", "fake-claude-control.mjs");

test("Codex 0.146 keeps core conversations usable and rejects only 0.147 optional RPCs", {
  timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-0146-server-"));
  await fs.chmod(root, 0o755);
  const bin = path.join(root, "bin");
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "workspace");
  const state = path.join(root, "state");
  const runtime = path.join(root, "runtime");
  const users = path.join(root, "users");
  const trace = path.join(root, "app-server-trace.ndjson");
  const authFile = path.join(root, "auth.json");
  await Promise.all([
    fs.mkdir(bin, { recursive: true }),
    fs.mkdir(project, { recursive: true }),
    fs.mkdir(runtime, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(bin, "codex"),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`,
    { mode: 0o755 },
  );
  await writeAuth(authFile, createAuthRecord("owner", "owner-password-1234"));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: project,
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: state,
      CODEX_DESKTOP_SOURCE_DIR: repositoryRoot,
      CODEX_DESKTOP_RUNTIME_DIR: runtime,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_MULTI_USER_ROOT: users,
      CODEX_DESKTOP_MULTI_USER_TEST_MODE: "1",
      CODEX_DESKTOP_RELEASE_DISABLED: "0",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "0",
      CODEX_DESKTOP_CLAUDE_BIN: path.join(bin, "claude"),
      FAKE_CODEX_PROJECT: project,
      FAKE_CODEX_PROTOCOL_VERSION: "0.146.0",
      FAKE_CODEX_DIAGNOSTIC_TRACE_FILE: trace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopProcess(child);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForOutput(child, "WFL Codex Desktop v");

  const authorization = `Basic ${Buffer.from("owner:owner-password-1234").toString("base64")}`;
  const login = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  t.after(() => socket.close());
  const statusPromise = waitForMessage(socket, (message) => message.type === "bridge/status");
  await waitForOpen(socket);
  const status = await statusPromise;
  assert.deepEqual(status.payload.runtimeCapabilities, {
    version: "0.146.0",
    detected: true,
    conversationSections: false,
    sectionPositionSort: false,
    pluginSearch: false,
    cursorMigration: true,
  });

  const listed = await rpc(socket, 1, "thread/list", {
    cwd: project,
    archived: false,
    limit: 20,
    sortKey: "section_position",
    sortDirection: "asc",
    modelProviders: [],
  });
  assert.equal(listed.type, "rpc/result", JSON.stringify(listed));
  assert.ok(Array.isArray(listed.result.data));

  const started = await rpc(socket, 2, "thread/start", {
    cwd: project,
    model: "gpt-smoke",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  assert.equal(started.type, "rpc/result", JSON.stringify(started));
  const threadId = started.result.thread.id;

  const turn = await rpc(socket, 3, "turn/start", {
    threadId,
    cwd: project,
    model: "gpt-smoke",
    effort: "medium",
    clientUserMessageId: "codex-0146-message-001",
    _wflThreadLeaseOwnerId: "codex-0146-window-001",
    input: [{ type: "text", text: "verify Codex 0.146 core chat", text_elements: [] }],
  });
  assert.equal(turn.type, "rpc/result", JSON.stringify(turn));
  assert.ok(turn.result.turn.id);

  const section = await rpc(socket, 4, "threadSection/list", { limit: 20 });
  assert.equal(section.type, "rpc/error");
  assert.equal(section.code, "ERR_CODEX_RUNTIME_FEATURE_UNAVAILABLE");
  assert.equal(section.details.installedVersion, "0.146.0");

  const plugins = await rpc(socket, 5, "plugin/search", {
    searchTerm: "github",
    scope: "global",
    cwds: [project],
    limit: 20,
  });
  assert.equal(plugins.type, "rpc/error");
  assert.equal(plugins.code, "ERR_CODEX_RUNTIME_FEATURE_UNAVAILABLE");

  const traceRows = (await fs.readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const upstreamList = traceRows.find((row) => row.direction === "in" && row.method === "thread/list");
  assert.ok(upstreamList);
  const upstreamMethods = new Set(traceRows.filter((row) => row.direction === "in").map((row) => row.method));
  assert.equal(upstreamMethods.has("threadSection/list"), false);
  assert.equal(upstreamMethods.has("plugin/search"), false);
});

function rpc(socket, requestId, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), 5_000);
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

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket notification timed out")), 5_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
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

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${output}`));
    });
  });
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
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
