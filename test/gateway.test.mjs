import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const gatewaySource = await fs.readFile(new URL("../gateway.mjs", import.meta.url), "utf8");

function assertGatewaySource() {
  assert.match(gatewaySource, /new http\.Agent\(\{ keepAlive: true/);
  assert.match(gatewaySource, /KEEP_ALIVE_TIMEOUT_MS[^\n]+120_000/);
  assert.match(gatewaySource, /server\.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS/);
  assert.match(gatewaySource, /endToEndHeaders\(request\.headers\)/);
  assert.match(gatewaySource, /endToEndHeaders\(upstreamResponse\.headers\)/);
  assert.match(gatewaySource, /client\.ping\(\)/);
  assert.match(gatewaySource, /upstream\.ping\(\)/);
  assert.match(gatewaySource, /client\.on\("pong"/);
  assert.match(gatewaySource, /upstream\.on\("pong"/);
  assert.match(gatewaySource, /const RESCUE_UPSTREAM_PORTS = new Set\(\[DEFAULT_RESCUE_UPSTREAM_PORT\]\)/);
  assert.match(gatewaySource, /CODEX_DESKTOP_RESCUE_PORT \|\| 4321/);
  assert.match(gatewaySource, /GATEWAY_TEST_MODE/);
  assert.doesNotMatch(gatewaySource, /CODEX_DESKTOP_RESCUE_ACTIVE_PORT_FILE|rescue-active-port/);
  assert.match(gatewaySource, /upstream\.codexDesktopChannel === "rescue"/);
  assert.match(gatewaySource, /rescueWebSocketPath\(request\.url\)/);
  assert.match(gatewaySource, /rescueFallback: false/);
  assert.match(gatewaySource, /Rescue upstream ports must be isolated from main upstream ports/);
  assert.match(gatewaySource, /"\/api\/claude\/official\/login\/browser\/vnc"/);
  assert.match(gatewaySource, /"\/api\/claude\/mcp\/oauth\/browser\/vnc"/);
  assert.doesNotMatch(gatewaySource, /fallbackAttempted/);
}

async function testGatewayIntegration() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-gateway-test-"));
  const firstUpstreamPort = await getFreePort();
  const secondUpstreamPort = await getFreePort();
  const firstRescueUpstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const activePortFile = path.join(directory, "active-port");
  await fs.writeFile(activePortFile, `${firstUpstreamPort}\n`);
  const firstUpstream = await startUpstream(firstUpstreamPort, "first");
  let firstRescueUpstream = await startUpstream(firstRescueUpstreamPort, "rescue-first");
  let secondUpstream;
  let socket;
  let deviceSocket;
  let rescueSocket;
  let vncSocket;
  let claudeVncSocket;
  const gateway = spawn(process.execPath, ["gateway.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(gatewayPort),
      CODEX_DESKTOP_UPSTREAM_PORTS: `${firstUpstreamPort},${secondUpstreamPort}`,
      CODEX_DESKTOP_UPSTREAM_PORT: String(firstUpstreamPort),
      CODEX_DESKTOP_ACTIVE_PORT_FILE: activePortFile,
      CODEX_DESKTOP_RESCUE_PORT: String(firstRescueUpstreamPort),
      CODEX_DESKTOP_GATEWAY_TEST_MODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForOutput(gateway, "WFL Codex Gateway:");
    const gatewayReady = await fetch(`http://127.0.0.1:${gatewayPort}/internal/gateway-ready`);
    const gatewayStatus = await gatewayReady.json();
    assert.equal(gatewayStatus.connectionPolicyVersion, 8);
    assert.equal(
      gatewayStatus.gatewaySourceSha256,
      crypto.createHash("sha256").update(gatewaySource).digest("hex"),
    );
    assert.equal(gatewayStatus.rescueUpstreamPort, firstRescueUpstreamPort);
    assert.deepEqual(gatewayStatus.rescueUpstreamPorts, [firstRescueUpstreamPort]);
    assert.equal(gatewayStatus.heartbeatIntervalMs, 25_000);
    assert.equal(gatewayStatus.keepAliveTimeoutMs, 120_000);
    assert.equal(gatewayStatus.rescueFallback, false);
    assert.equal(gatewayStatus.rescueChannelIsolated, true);
    const proxied = await fetch(`http://127.0.0.1:${gatewayPort}/probe`);
    assert.equal(proxied.status, 202);
    assert.equal(await proxied.text(), "first ready");
    assert.match(proxied.headers.get("keep-alive") || "", /timeout=120/);
    const rescueHttp = await fetch(`http://127.0.0.1:${gatewayPort}/rescue/api/probe`);
    assert.equal(await rescueHttp.text(), "rescue-first ready");
    const rescueAsset = await fetch(`http://127.0.0.1:${gatewayPort}/rescue/assets/rescue.css`);
    assert.equal(rescueAsset.status, 200);
    assert.equal(await rescueAsset.text(), "rescue asset ready");

    const rescueSocketPath = "/rescue/ws?windowId=window-rescue-gateway&generation=11";
    rescueSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}${rescueSocketPath}`, {
      headers: { Origin: `http://127.0.0.1:${gatewayPort}` },
    });
    const rescueReady = waitForMessage(
      rescueSocket,
      (message) => (
        message.type === "bridge/status"
        && message.payload?.backend === "rescue-first"
        && message.payload?.upstreamPath === "/ws?windowId=window-rescue-gateway&generation=11"
      ),
    );
    await new Promise((resolve, reject) => {
      rescueSocket.once("open", resolve);
      rescueSocket.once("error", reject);
    });
    await rescueReady;

    const delayed = await postChunkedJson(`http://127.0.0.1:${gatewayPort}/slow-echo`);
    assert.equal(delayed.statusCode, 424);
    assert.equal(delayed.headers["content-type"], "application/json");
    assert.equal(delayed.headers["x-hop-test"], undefined);
    assert.deepEqual(JSON.parse(delayed.body), {
      body: "first chunk + second chunk",
      requestHopHeader: null,
      transferEncoding: "chunked",
    });

    const mainSocketPath = "/ws?windowId=window-gateway-test&generation=7";
    socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}${mainSocketPath}`, {
      headers: { Origin: `http://127.0.0.1:${gatewayPort}` },
    });
    const initialReady = waitForMessage(
      socket,
      (message) =>
        message.type === "bridge/status" &&
        message.payload?.status === "ready" &&
        message.payload?.backend === "first" &&
        message.payload?.upstreamPath === mainSocketPath,
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await initialReady;

    deviceSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/device/ws`);
    const deviceReady = waitForMessage(
      deviceSocket,
      (message) => message.payload?.backend === "first" && message.payload?.upstreamPath === "/device/ws",
    );
    await new Promise((resolve, reject) => {
      deviceSocket.once("open", resolve);
      deviceSocket.once("error", reject);
    });
    await deviceReady;

    const vncMessages = [];
    vncSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/providers/official/login/browser/vnc`, {
      headers: { Origin: `http://127.0.0.1:${gatewayPort}` },
    });
    vncSocket.on("message", (data, isBinary) => vncMessages.push({ data: Buffer.from(data), isBinary }));
    const initialVncFrame = waitForRawMessage(vncSocket);
    await new Promise((resolve, reject) => {
      vncSocket.once("open", resolve);
      vncSocket.once("error", reject);
    });
    assert.deepEqual(await initialVncFrame, { data: Buffer.from([0x52, 0x46, 0x42, 0x00]), isBinary: true });
    const vncEcho = waitForRawMessage(vncSocket);
    vncSocket.send(Buffer.from([0x04, 0x01, 0x00, 0xff]));
    assert.deepEqual(await vncEcho, { data: Buffer.from([0x04, 0x01, 0x00, 0xff]), isBinary: true });

    const claudeVncMessages = [];
    claudeVncSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/claude/official/login/browser/vnc`, {
      headers: { Origin: `http://127.0.0.1:${gatewayPort}` },
    });
    claudeVncSocket.on("message", (data, isBinary) => claudeVncMessages.push({ data: Buffer.from(data), isBinary }));
    const initialClaudeVncFrame = waitForRawMessage(claudeVncSocket);
    await new Promise((resolve, reject) => {
      claudeVncSocket.once("open", resolve);
      claudeVncSocket.once("error", reject);
    });
    assert.deepEqual(await initialClaudeVncFrame, { data: Buffer.from([0x52, 0x46, 0x42, 0x00]), isBinary: true });
    const claudeVncEcho = waitForRawMessage(claudeVncSocket);
    claudeVncSocket.send(Buffer.from([0x04, 0x02, 0x00, 0xfe]));
    assert.deepEqual(await claudeVncEcho, { data: Buffer.from([0x04, 0x02, 0x00, 0xfe]), isBinary: true });

    secondUpstream = await startUpstream(secondUpstreamPort, "second");
    const switching = waitForMessage(
      socket,
      (message) => message.type === "bridge/status" && message.payload?.status === "starting",
    );
    const switched = waitForMessage(
      socket,
      (message) =>
        message.type === "bridge/status" &&
        message.payload?.status === "ready" &&
        message.payload?.backend === "second" &&
        message.payload?.upstreamPath === mainSocketPath,
    );
    const vncClosed = waitForClose(vncSocket);
    const claudeVncClosed = waitForClose(claudeVncSocket);
    const deviceClosed = waitForClose(deviceSocket);
    await fs.writeFile(activePortFile, `${secondUpstreamPort}\n`);
    await switching;
    await switched;
    assert.equal(await vncClosed, 1012);
    assert.equal(await claudeVncClosed, 1012);
    assert.equal(await deviceClosed, 1012);
    deviceSocket = null;
    assert.ok(vncMessages.every((message) => message.isBinary), "VNC bridge must not inject JSON status messages");
    assert.ok(claudeVncMessages.every((message) => message.isBinary), "Claude VNC bridge must not inject JSON status messages");
    vncSocket = null;
    claudeVncSocket = null;
    assert.equal(socket.readyState, WebSocket.OPEN);

    const proxiedAfterSwitch = await fetch(`http://127.0.0.1:${gatewayPort}/probe`);
    assert.equal(await proxiedAfterSwitch.text(), "second ready");

    assert.equal(rescueSocket.readyState, WebSocket.OPEN);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${gatewayPort}/rescue/api/projects`)).text(),
      "rescue-first ready",
    );
    assert.equal(
      await (await fetch(`http://127.0.0.1:${gatewayPort}/rescue/unknown-route`)).text(),
      "rescue-first ready",
    );

    await firstRescueUpstream.stop();
    const unavailableRescue = await fetch(`http://127.0.0.1:${gatewayPort}/rescue/api/projects`);
    assert.equal(unavailableRescue.status, 503);
    assert.match(await unavailableRescue.text(), /main service was not used/);
    firstRescueUpstream = await startUpstream(firstRescueUpstreamPort, "rescue-first");

    const starting = waitForMessage(
      socket,
      (message) => message.type === "bridge/status" && message.payload?.status === "starting",
    );
    await secondUpstream.stop();
    await starting;
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(rescueSocket.readyState, WebSocket.OPEN);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${gatewayPort}/rescue/api/projects`)).text(),
      "rescue-first ready",
    );

    const readyAgain = waitForMessage(
      socket,
      (message) =>
        message.type === "bridge/status" &&
        message.payload?.status === "ready" &&
        message.payload?.backend === "second",
    );
    secondUpstream = await startUpstream(secondUpstreamPort, "second");
    await readyAgain;
    assert.equal(socket.readyState, WebSocket.OPEN);
    await closeWebSocket(socket);
    socket = null;
    await closeWebSocket(rescueSocket);
    rescueSocket = null;
  } finally {
    socket?.terminate();
    deviceSocket?.terminate();
    rescueSocket?.terminate();
    vncSocket?.terminate();
    claudeVncSocket?.terminate();
    gateway.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => gateway.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await firstUpstream.stop();
    await secondUpstream?.stop();
    await firstRescueUpstream.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

try {
  assertGatewaySource();
  await testGatewayIntegration();
  console.log("Gateway source and integration checks passed");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}

function closeWebSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, 1000);
    socket.once("close", finish);
    socket.close();
  });
}

async function startUpstream(port, name) {
  const server = http.createServer(async (request, response) => {
    if (request.url === "/rescue/assets/rescue.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end("rescue asset ready");
      return;
    }
    if (request.url === "/slow-echo") {
      const body = await readBody(request);
      await new Promise((resolve) => setTimeout(resolve, 80));
      response.writeHead(424, {
        "Content-Type": "application/json",
        Connection: "keep-alive, x-hop-test",
        "Keep-Alive": "timeout=5",
        "X-Hop-Test": "remove-me",
      });
      response.end(JSON.stringify({
        body,
        requestHopHeader: request.headers["x-request-hop"] || null,
        transferEncoding: request.headers["transfer-encoding"] || null,
      }));
      return;
    }
    response.writeHead(202, { "Content-Type": "text/plain" });
    response.end(`${name} ready`);
  });
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (client, request) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    if ([
      "/api/providers/official/login/browser/vnc",
      "/api/claude/official/login/browser/vnc",
    ].includes(new URL(request.url || "/", "http://localhost").pathname)) {
      client.send(Buffer.from([0x52, 0x46, 0x42, 0x00]), { binary: true });
      client.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
      return;
    }
    client.send(JSON.stringify({
      type: "bridge/status",
      payload: { status: "ready", backend: name, upstreamPath: request.url },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const client of clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => wss.close(resolve)),
        new Promise((resolve) => server.close(resolve)),
      ]);
    },
  };
}

function postChunkedJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Connection: "x-request-hop",
        "X-Request-Hop": "remove-me",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.write("first chunk");
    request.end(" + second chunk");
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for gateway message")), 8000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error("Gateway closed the browser socket"));
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

function waitForRawMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for raw gateway message")), 8000);
    const onMessage = (data, isBinary) => finish(null, { data: Buffer.from(data), isBinary });
    const onClose = () => finish(new Error("Gateway closed before forwarding raw data"));
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function waitForClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(socket._closeCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for gateway to close VNC socket"));
    }, 8000);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitForOutput(child, text) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 5000);
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes(text)) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`Gateway exited early (${code})`)));
  });
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
