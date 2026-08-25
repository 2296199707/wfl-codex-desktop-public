import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repository = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const fakeClaude = path.join(repository, "test", "fixtures", "fake-claude-control.mjs");

test("real Codex app-server can service thread/read while a map AI MCP call is pending", {
  timeout: 30_000,
}, async (t) => {
  const codexExecutable = process.env.CODEX_DESKTOP_CODEX_BIN || "codex";
  if (!await codexAppServerAvailable(codexExecutable)) {
    t.skip(`Codex app-server is unavailable: ${codexExecutable}`);
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-reentrant-"));
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "game");
  const mapPath = path.join(project, "maps", "world.tmj");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const codexHome = path.join(root, "codex-home");
  const usersRoot = path.join(root, "users");
  const bin = path.join(root, "bin");
  const authFile = path.join(root, "auth.json");
  const username = "owner";
  const password = "map-ai-reentrant-owner";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const editorInstanceId = "map-ai-reentrant-editor";
  const originalMap = `${JSON.stringify({
    type: "map",
    version: "1.10",
    tiledversion: "1.10.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 2,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 2, height: 2, data: [0, 0, 0, 0] }],
    tilesets: [],
  }, null, 2)}\n`;

  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(usersRoot, { recursive: true }),
    fs.mkdir(bin, { recursive: true }),
  ]);
  await fs.writeFile(mapPath, originalMap);
  await writeAuth(authFile, createAuthRecord(username, password));
  const claudeShim = path.join(bin, "claude");
  await fs.writeFile(claudeShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: project,
      CODEX_DESKTOP_MULTI_USER_ROOT: usersRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: repository,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "0",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_BIN: codexExecutable,
      CODEX_DESKTOP_CLAUDE_BIN: claudeShim,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverOutput = [];
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => serverOutput.push(chunk));
  server.stderr.on("data", (chunk) => serverOutput.push(chunk));
  t.after(async () => {
    await stopProcess(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForServer(server, serverOutput, "WFL Codex Desktop v");

  const enabled = await requestJson(baseUrl, "/api/account/map-ai", {
    method: "PUT",
    authorization,
    action: "map-ai-setting",
    body: { enabled: true },
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.data));

  const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/ws`, authorization);
  t.after(() => socket.close());
  const started = await websocketRpc(socket, "thread/start", { cwd: project }, 10_000);
  assert.equal(started.type, "rpc/result", started.message || JSON.stringify(started));
  const threadId = started.result?.thread?.id;
  assert.equal(typeof threadId, "string");
  assert.ok(threadId.length > 0);

  const opened = await requestJson(baseUrl, "/api/maps/sessions", {
    method: "POST",
    authorization,
    action: "map-session-open",
    body: { project, path: mapPath, editorInstanceId },
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  const session = opened.data.session;
  const expectedVersion = crypto.createHash("sha256").update(originalMap).digest("hex");
  assert.equal(session.version, expectedVersion);

  const granted = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-leases`, {
    method: "POST",
    authorization,
    action: "map-ai-lease-grant",
    editorInstanceId,
    body: {
      threadId,
      editorStateId: 0,
      allowedOps: ["get_map_context"],
    },
  });
  assert.equal(granted.response.status, 201, JSON.stringify(granted.data));

  const toolContext = {
    threadId,
    mapSessionId: session.id,
    editorInstanceId,
    editorStateId: 0,
  };
  const calledAt = Date.now();
  const toolCall = await websocketRpc(socket, "mcpServer/tool/call", {
    threadId,
    server: "wfl_map_ai",
    tool: "get_map_context",
    arguments: toolContext,
  }, 8_000);
  const elapsedMs = Date.now() - calledAt;

  assert.equal(toolCall.type, "rpc/result", [
    toolCall.message || JSON.stringify(toolCall),
    `elapsedMs=${elapsedMs}`,
    serverOutput.join("").slice(-4_000),
  ].join("\n"));
  assert.equal(toolCall.result?.isError, false, JSON.stringify(toolCall));
  assert.deepEqual(toolCall.result?.structuredContent?.context, {
    mapSessionId: session.id,
    mapPath: "maps/world.tmj",
    mapVersion: expectedVersion,
    writable: true,
    editorInstanceId,
    editorStateId: 0,
    leaseExpiresAt: granted.data.lease.expiresAt,
  });
  assert.ok(elapsedMs < 8_000, `Reentrant MCP call took ${elapsedMs}ms`);
  assert.equal(await fs.readFile(mapPath, "utf8"), originalMap);
});

function codexAppServerAvailable(executable) {
  return new Promise((resolve) => {
    const child = spawn(executable, ["app-server", "--help"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function requestJson(baseUrl, pathname, {
  method = "GET",
  authorization = null,
  action = null,
  body = undefined,
  editorInstanceId = null,
} = {}) {
  const headers = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  if (method !== "GET") headers.Origin = baseUrl;
  if (action) headers["X-Codex-Desktop-Action"] = action;
  if (editorInstanceId) headers["X-Codex-Desktop-Editor-Instance"] = editorInstanceId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  return { response, data };
}

function openWebSocket(url, authorization) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket did not open"));
    }, 8_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

let nextRequestId = 1;
function websocketRpc(socket, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = `map-ai-reentrant-${nextRequestId++}`;
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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

function waitForServer(processHandle, output, marker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output.join("")}`)), 10_000);
    const inspect = () => {
      if (!output.join("").includes(marker)) return;
      clearTimeout(timer);
      processHandle.stdout.off("data", inspect);
      processHandle.stderr.off("data", inspect);
      resolve();
    };
    processHandle.stdout.on("data", inspect);
    processHandle.stderr.on("data", inspect);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before readiness (${code ?? signal}): ${output.join("")}`));
    });
    inspect();
  });
}

function stopProcess(processHandle) {
  return new Promise((resolve) => {
    if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      resolve();
    }, 5_000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    processHandle.kill("SIGTERM");
  });
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
