import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsHostAgent } from "../companion/windows-host/src/agent.mjs";
import {
  deviceWebSocketUrl,
  normalizeServerUrl,
  publicHostConfig,
  readHostConfig,
  writeHostConfig,
} from "../companion/windows-host/src/config.mjs";

test("Windows Host config requires TLS remotely and never exposes its device token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-host-agent-"));
  const configPath = path.join(directory, "windows-host.json");
  try {
    assert.throws(() => normalizeServerUrl("http://desktop.example.test"), /HTTPS/);
    assert.equal(normalizeServerUrl("http://127.0.0.1:4317/"), "http://127.0.0.1:4317");
    assert.equal(deviceWebSocketUrl("https://desktop.example.test"), "wss://desktop.example.test/device/ws");
    const token = `wfl_device_${Buffer.alloc(32, 7).toString("base64url")}`;
    await writeHostConfig({
      version: 1,
      serverUrl: "https://desktop.example.test",
      deviceId: "device-test",
      token,
      deviceName: "Test PC",
      workspaceRoot: directory,
      projects: [{ id: "default", name: "Test", path: directory }],
    }, configPath);
    const config = await readHostConfig(configPath);
    assert.equal(config.token, token);
    assert.equal(Object.hasOwn(publicHostConfig(config), "token"), false);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(writeHostConfig({
      version: 1,
      serverUrl: "https://desktop.example.test",
      deviceId: "device-test",
      token,
      deviceName: "Test PC",
      workspaceRoot: "",
      projects: [{ id: "default", name: "Test", path: directory }],
    }, configPath), /explicit|absolute/i);
    await assert.rejects(writeHostConfig({
      version: 1,
      serverUrl: "https://desktop.example.test",
      deviceId: "device-test",
      token,
      deviceName: "Test PC",
      workspaceRoot: directory,
      projects: [{ id: "default", name: "Test", path: "relative-project" }],
    }, configPath), /absolute/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Windows Host sends credentials only inside the socket and rejects revoked lease reuse", async () => {
  FakeWebSocket.instances.length = 0;
  const token = `wfl_device_${Buffer.alloc(32, 9).toString("base64url")}`;
  const config = {
    version: 1,
    serverUrl: "https://desktop.example.test",
    deviceId: "device-test",
    token,
    deviceName: "Test PC",
    workspaceRoot: "/workspace",
    projects: [{ id: "default", name: "Test", path: "/workspace" }],
  };
  const codexHost = {
    async capabilities() { return { available: true, appServer: true, version: "0.146.0" }; },
    async call(method) { return { method, status: "idle" }; },
    async close() {},
  };
  const creatorHost = {
    async initialize() {},
    capabilities() { return { available: true, workspaceConfigured: true, tools: [] }; },
    async call() { return {}; },
    cancel() { return { canceled: false }; },
  };
  const agent = await new WindowsHostAgent(config, {
    WebSocketImpl: FakeWebSocket,
    codexHost,
    creatorHost,
  }).initialize();
  agent.start();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://desktop.example.test/device/ws");
  assert.doesNotMatch(socket.url, new RegExp(token));
  socket.open();
  assert.equal(JSON.parse(socket.sent[0]).token, token);

  socket.message({
    type: "authenticated",
    device: { id: "device-test", userId: "user-test", epoch: 1 },
    authorizedPlugins: ["windows-codex-remote"],
    heartbeatIntervalMs: 15_000,
  });
  await tick();
  const context = {
    userId: "user-test",
    deviceId: "device-test",
    deviceEpoch: 1,
    threadId: "thread-test",
    leaseEpoch: 1,
  };
  socket.message({
    type: "call",
    callId: "call-1",
    pluginId: "windows-codex-remote",
    method: "codex.thread.resume",
    params: { projectId: "default", threadId: "thread-test" },
    context,
  });
  await tick();
  const completed = socket.sent.map(JSON.parse).find((message) => message.callId === "call-1");
  assert.equal(completed.ok, true);

  socket.message({ type: "leaseRevoked", context, reason: "released" });
  await tick();
  socket.message({
    type: "call",
    callId: "call-stale",
    pluginId: "windows-codex-remote",
    method: "codex.thread.read",
    params: { projectId: "default", threadId: "thread-test" },
    context,
  });
  await tick();
  const stale = socket.sent.map(JSON.parse).find((message) => message.callId === "call-stale");
  assert.equal(stale.ok, false);
  assert.match(stale.error.message, /revoked/);
  socket.message({
    type: "call",
    callId: "call-new-lease",
    pluginId: "windows-codex-remote",
    method: "codex.thread.read",
    params: { projectId: "default", threadId: "thread-test" },
    context: { ...context, leaseEpoch: 2 },
  });
  await tick();
  const current = socket.sent.map(JSON.parse).find((message) => message.callId === "call-new-lease");
  assert.equal(current.ok, true);
  await agent.stop();
});

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value) {
    this.emit("message", { data: JSON.stringify(value) });
  }

  send(value) {
    this.sent.push(value);
  }

  close(code = 1000, reason = "") {
    if (this.readyState > 1) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
