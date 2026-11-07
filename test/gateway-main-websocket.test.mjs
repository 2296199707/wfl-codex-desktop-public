import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

test("main gateway preserves window identity through an upstream switch", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-main-gateway-identity-"));
  const [firstPort, secondPort, gatewayPort, unusedPortA, unusedPortB] = await Promise.all(
    Array.from({ length: 5 }, () => reservePort()),
  );
  const activePortFile = path.join(directory, "active-port");
  await fs.writeFile(activePortFile, `${firstPort}\n`);
  const first = await startUpstream(firstPort, "first");
  const second = await startUpstream(secondPort, "second");
  const gateway = spawn(process.execPath, [new URL("../gateway.mjs", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(gatewayPort),
      CODEX_DESKTOP_UPSTREAM_PORTS: `${firstPort},${secondPort}`,
      CODEX_DESKTOP_UPSTREAM_PORT: String(firstPort),
      CODEX_DESKTOP_ACTIVE_PORT_FILE: activePortFile,
      CODEX_DESKTOP_RESCUE_PORTS: `${unusedPortA},${unusedPortB}`,
      CODEX_DESKTOP_RESCUE_PORT: String(unusedPortA),
      CODEX_DESKTOP_GATEWAY_TEST_MODE: "1",
      CODEX_DESKTOP_RESCUE_ACTIVE_PORT_FILE: path.join(directory, "unused-rescue-port"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const socketPath = "/ws?windowId=window-main-gateway&generation=9";
  let socket = null;
  t.after(async () => {
    socket?.terminate();
    gateway.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => gateway.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await Promise.all([first.stop(), second.stop()]);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await waitForOutput(gateway, "WFL Codex Gateway:");
  socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}${socketPath}`, {
    headers: { Origin: `http://127.0.0.1:${gatewayPort}` },
  });
  const firstReady = waitForMessage(socket, (message) => message.backend === "first");
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  assert.equal((await firstReady).path, socketPath);

  const starting = waitForMessage(
    socket,
    (message) => message.type === "bridge/status" && message.payload?.status === "starting",
  );
  const secondReady = waitForMessage(socket, (message) => message.backend === "second");
  await fs.writeFile(activePortFile, `${secondPort}\n`);
  await starting;
  assert.equal((await secondReady).path, socketPath);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("SSH gateway forwards terminal frames but closes on a switch without reconnecting or replaying input", { timeout: 10_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-gateway-"));
  const [firstPort, secondPort, gatewayPort, unusedPortA, unusedPortB] = await Promise.all(Array.from({ length: 5 }, () => reservePort()));
  const activePortFile = path.join(directory, "active-port");
  await fs.writeFile(activePortFile, `${firstPort}\n`);
  const first = await startUpstream(firstPort, "first");
  const second = await startUpstream(secondPort, "second");
  const gateway = spawn(process.execPath, [new URL("../gateway.mjs", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(gatewayPort),
      CODEX_DESKTOP_UPSTREAM_PORTS: `${firstPort},${secondPort}`,
      CODEX_DESKTOP_UPSTREAM_PORT: String(firstPort), CODEX_DESKTOP_ACTIVE_PORT_FILE: activePortFile,
      CODEX_DESKTOP_RESCUE_PORTS: `${unusedPortA},${unusedPortB}`, CODEX_DESKTOP_RESCUE_PORT: String(unusedPortA),
      CODEX_DESKTOP_GATEWAY_TEST_MODE: "1", CODEX_DESKTOP_RESCUE_ACTIVE_PORT_FILE: path.join(directory, "unused-rescue-port"),
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let socket;
  t.after(async () => {
    socket?.terminate();
    gateway.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => gateway.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await Promise.all([first.stop(), second.stop()]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await waitForOutput(gateway, "WFL Codex Gateway:");
  socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ssh/ws`, { headers: { Origin: `http://127.0.0.1:${gatewayPort}` } });
  const ready = waitForMessage(socket, (message) => message.backend === "first");
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  assert.equal((await ready).path, "/ssh/ws");
  const input = JSON.stringify({ type: "input", data: "one-terminal-command\n" });
  const binary = Buffer.from([0, 255, 3, 27]);
  const received = new Promise((resolve) => first.clients.values().next().value.once("message", (data) => resolve(data.toString())));
  socket.send(input);
  assert.equal(await received, input);
  const output = new Promise((resolve) => socket.once("message", (raw, isBinary) => resolve({ raw, isBinary })));
  first.clients.values().next().value.send(binary);
  assert.deepEqual(await output, { raw: binary, isBinary: true });
  const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  await fs.writeFile(activePortFile, `${secondPort}\n`);
  assert.equal(await closed, 1012);
  assert.equal(second.clients.size, 0);
  assert.deepEqual(first.messages.map(({ data }) => data.toString()), [input]);
});

async function startUpstream(port, backend) {
  const server = http.createServer((_request, response) => response.writeHead(404).end());
  const webSocketServer = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const messages = [];
  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      clients.add(client);
      client.once("close", () => clients.delete(client));
      client.on("message", (data, binary) => messages.push({ data, binary }));
      client.send(JSON.stringify({ backend, path: request.url }));
    });
  });
  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  return {
    clients, messages,
    async stop() {
      for (const client of clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => webSocketServer.close(resolve)),
        new Promise((resolve) => server.close(resolve)),
      ]);
    },
  };
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for main gateway message")), 8_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error("Main gateway closed the browser socket"));
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => reject(new Error(`Gateway exited early (${code})`)));
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
