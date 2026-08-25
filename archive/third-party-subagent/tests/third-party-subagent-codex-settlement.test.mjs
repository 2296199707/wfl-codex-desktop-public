import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fakeCodex = path.join(repositoryRoot, "test", "fixtures", "fake-codex-app-server.mjs");
const fakeClaude = path.join(repositoryRoot, "test", "fixtures", "fake-claude-control.mjs");

test("third-party settlement reaches a busy parent through steer and an idle parent through start", {
  timeout: 90_000,
}, async (t) => {
  // Keep the fixture root short enough for every optional per-user Unix socket
  // the full WFL runtime starts during this host integration test.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wflsh-"));
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "workspace");
  const state = path.join(root, "state");
  const runtime = path.join(root, "runtime");
  const users = path.join(root, "users");
  const bin = path.join(root, "bin");
  const trace = path.join(root, "app-server-trace.ndjson");
  const authFile = path.join(root, "auth.json");
  await Promise.all([
    fs.mkdir(project, { recursive: true }),
    fs.mkdir(runtime, { recursive: true }),
    fs.mkdir(bin, { recursive: true }),
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

  let releaseDelayedModel;
  const delayedModel = new Promise((resolve) => { releaseDelayedModel = resolve; });
  let modelRequests = 0;
  const modelServer = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    modelRequests += 1;
    if (modelRequests === 2) await delayedModel;
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    const text = modelRequests === 1 ? "busy parent child settled" : "idle parent child settled";
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });

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
      CODEX_DESKTOP_MULTI_USER_ROOT: users,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "0",
      CODEX_DESKTOP_CLAUDE_BIN: path.join(bin, "claude"),
      FAKE_CODEX_PROJECT: project,
      FAKE_CODEX_DIAGNOSTIC_TRACE_FILE: trace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopProcess(child);
    await new Promise((resolve) => modelServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForOutput(child, "WFL Codex Desktop v");

  const authorization = `Basic ${Buffer.from("owner:owner-password-1234").toString("base64")}`;
  const login = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] || "";
  assert.ok(cookie);

  const provider = await requestJson(baseUrl, "/api/providers", {
    method: "POST",
    cookie,
    body: {
      name: "Local fake subagent provider",
      baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
      model: "fake-deepseek-model",
      apiKey: "fake-local-key",
    },
  });
  assert.equal(provider.response.status, 201, JSON.stringify(provider.data));
  const selected = await requestJson(baseUrl, "/api/providers/subagent", {
    method: "PUT",
    cookie,
    action: "provider-subagent-settings",
    body: { providerId: provider.data.profile.id, wireApi: "openai-completions" },
  });
  assert.equal(selected.response.status, 200, JSON.stringify(selected.data));

  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  t.after(() => socket.close());
  await waitForOpen(socket);
  await waitForMessage(socket, (message) => message.type === "bridge/status" && message.payload?.status === "ready");

  const parent = await rpc(socket, 1, "thread/start", {
    cwd: project,
    model: "gpt-smoke",
    sandbox: "workspace-write",
    approvalPolicy: "never",
  });
  assert.equal(parent.type, "rpc/result", JSON.stringify(parent));
  const threadId = parent.result.thread.id;

  const busy = await rpc(socket, 2, "turn/start", {
    threadId,
    cwd: project,
    model: "gpt-smoke",
    effort: "medium",
    clientUserMessageId: "busy-parent-message",
    _wflThreadLeaseOwnerId: "busy-parent-window",
    input: [{ type: "text", text: "keep busy parent active", text_elements: [] }],
  });
  assert.equal(busy.type, "rpc/result", JSON.stringify(busy));
  const busyTurnId = busy.result.turn.id;

  const endpoint = await findHarnessEndpoint(runtime);
  const mcp = spawn(process.execPath, [
    path.join(repositoryRoot, "scripts", "deepseek-harness-mcp.mjs"),
    "--socket",
    endpoint.socketPath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, WFL_DEEPSEEK_HARNESS_AUTH_TOKEN_FILE: endpoint.authTokenPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => mcp.kill("SIGTERM"));
  const mcpLines = collectLines(mcp.stdout);
  mcp.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "settlement-test", version: "1" } },
  })}\n`);
  assert.equal((await nextLine(mcpLines)).id, 1);

  const parentMeta = (turnId) => ({
    threadId,
    turnId,
    "x-codex-turn-metadata": {
      thread_id: threadId,
      turn_id: turnId,
      session_id: "fake-parent-session",
    },
  });
  mcp.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "subagent",
      arguments: { description: "busy child", prompt: "Return one short busy-parent result." },
      _meta: parentMeta(busyTurnId),
    },
  })}\n`);
  const busyChildResponse = await nextLine(mcpLines);
  assert.equal(busyChildResponse.id, 2);
  assert.equal(busyChildResponse.result.isError, false, JSON.stringify(busyChildResponse));
  assert.ok(busyChildResponse.result.structuredContent.childId);

  await waitForTrace(trace, (rows) => rows.some(
    (row) => row.direction === "in"
      && row.method === "turn/steer"
      && row.threadId === threadId
      && row.expectedTurnId === busyTurnId
      && /^wfl-third-party-subagent-/u.test(row.clientId || ""),
  ));

  const interrupted = await rpc(socket, 3, "turn/interrupt", {
    threadId,
    turnId: busyTurnId,
    _wflThreadLeaseOwnerId: "busy-parent-window",
  });
  assert.equal(interrupted.type, "rpc/result", JSON.stringify(interrupted));
  await waitForTrace(trace, (rows) => rows.some(
    (row) => row.direction === "out"
      && row.method === "turn/completed"
      && row.threadId === threadId
      && row.turnId === busyTurnId,
  ));

  const idle = await rpc(socket, 4, "turn/start", {
    threadId,
    cwd: project,
    model: "gpt-smoke",
    effort: "medium",
    clientUserMessageId: "idle-parent-message",
    _wflThreadLeaseOwnerId: "idle-parent-window",
    input: [{ type: "text", text: "complete with terminal summary only", text_elements: [] }],
  });
  assert.equal(idle.type, "rpc/result", JSON.stringify(idle));
  const idleTurnId = idle.result.turn.id;

  mcp.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "subagent",
      arguments: { description: "idle child", prompt: "Return one short idle-parent result." },
      _meta: parentMeta(idleTurnId),
    },
  })}\n`);
  const idleChildResponse = await nextLine(mcpLines);
  assert.equal(idleChildResponse.id, 3);
  assert.equal(idleChildResponse.result.isError, false, JSON.stringify(idleChildResponse));
  assert.ok(idleChildResponse.result.structuredContent.childId);

  await waitForTrace(trace, (rows) => rows.some(
    (row) => row.direction === "out"
      && row.method === "turn/completed"
      && row.threadId === threadId
      && row.turnId === idleTurnId,
  ));
  releaseDelayedModel();

  const settlementTurn = await waitForTrace(trace, (rows) => rows.find(
    (row) => row.direction === "in"
      && row.method === "turn/start"
      && row.threadId === threadId
      && /^wfl-third-party-subagent-/u.test(row.clientId || ""),
  ));
  assert.equal(settlementTurn.method, "turn/start");
  assert.equal(settlementTurn.threadId, threadId);

  const rows = await readTrace(trace);
  const settlementStarts = rows.filter(
    (row) => row.direction === "in"
      && row.method === "turn/start"
      && row.threadId === threadId
      && /^wfl-third-party-subagent-/u.test(row.clientId || ""),
  );
  assert.equal(settlementStarts.length, 1);
  assert.match(settlementStarts[0].clientId, /^wfl-third-party-subagent-/u);
  assert.equal(settlementStarts[0].cwd, project);
  assert.equal(settlementStarts[0].sandbox, "workspace-write");
  assert.equal(settlementStarts[0].approvalPolicy, "never");
  assert.ok(rows.some(
    (row) => row.direction === "out"
      && row.method === "turn/started"
      && row.threadId === threadId
      && row.turnId,
  ));
  assert.equal(modelRequests, 2);
});

function collectLines(stream) {
  const lines = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  return lines;
}

async function nextLine(lines) {
  for (let attempt = 0; attempt < 500 && !lines.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(lines.length, "MCP process did not return a response");
  return lines.shift();
}

async function findHarnessEndpoint(runtimeRoot) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const files = await walk(runtimeRoot);
    const socketPath = files.find((entry) => path.basename(entry).endsWith(".sock"));
    const authTokenPath = files.find((entry) => path.basename(entry).endsWith(".token"));
    if (socketPath && authTokenPath) return { socketPath, authTokenPath };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("WFL Harness socket was not created");
}

async function walk(root) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(target));
    else if (entry.isFile() || entry.isSocket()) result.push(target);
  }
  return result;
}

async function waitForTrace(file, predicate) {
  let lastRows = [];
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const rows = await readTrace(file);
    lastRows = rows;
    const found = predicate(rows);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the expected Codex trace: ${JSON.stringify(lastRows.slice(-12))}`);
}

async function readTrace(file) {
  try {
    const value = await fs.readFile(file, "utf8");
    return value.trim() ? value.trim().split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function requestJson(baseUrl, url, { method = "GET", cookie, action, body } = {}) {
  const headers = { Origin: baseUrl };
  if (cookie) headers.Cookie = cookie;
  if (action) headers["X-Codex-Desktop-Action"] = action;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: await response.json().catch(() => ({})) };
}

function rpc(socket, requestId, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket RPC timed out: ${method}`)), 10_000);
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
    const timer = setTimeout(() => reject(new Error("WebSocket notification timed out")), 10_000);
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
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });
}

async function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 20_000);
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
    }, 5_000);
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
