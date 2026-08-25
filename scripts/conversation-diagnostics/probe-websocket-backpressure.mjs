import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 20_000;
const FRAME_COUNT = 128;
const PAYLOAD_BYTES = 64 * 1024;
const TOTAL_PAYLOAD_BYTES = FRAME_COUNT * PAYLOAD_BYTES;

let directory = null;

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-websocket-backpressure-"));
  const direct = await runCase("direct-backend", false);
  const gateway = await runCase("through-gateway", true);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "random-port-main-backend-and-temporary-gateway",
      appServer: "bounded-fake-codex-app-server",
      maximumPayloadBytesPerCase: TOTAL_PAYLOAD_BYTES,
      productionRequests: 0,
      frozenRescuePortTouched: false,
      unusedChannelRequests: 0,
    },
    direct,
    gateway,
    currentControls: {
      perClientMessageLimit: null,
      perClientByteLimit: null,
      websocketSendCallbacks: false,
      bufferedAmountTelemetry: false,
      slowClientIsolationPolicy: false,
      targetMet: false,
    },
  }, null, 2)}\n`);
} finally {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

async function runCase(name, throughGateway) {
  const caseDirectory = path.join(directory, name);
  const projectRoot = path.join(caseDirectory, "projects");
  const defaultProject = path.join(projectRoot, "probe-project");
  const stateDirectory = path.join(caseDirectory, "state");
  const fakeBin = path.join(caseDirectory, "bin");
  const homeDirectory = path.join(caseDirectory, "home");
  const runtimeDirectory = path.join(caseDirectory, "runtime");
  const activePortFile = path.join(runtimeDirectory, "active-port");
  const unusedChannelPortFile = path.join(runtimeDirectory, "diagnostic-unused-port");
  const processes = [];
  const clients = [];
  let sampler = null;

  try {
    await Promise.all([
      fs.mkdir(defaultProject, { recursive: true }),
      fs.mkdir(fakeBin, { recursive: true }),
      fs.mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
      fs.mkdir(runtimeDirectory, { recursive: true }),
    ]);

    const [backendPort, gatewayPort, unusedChannelPortA, unusedChannelPortB] =
      await reserveDistinctPorts(4);
    for (const port of [backendPort, gatewayPort, unusedChannelPortA, unusedChannelPortB]) {
      assert.notEqual(port, 4321, "backpressure diagnostic must exclude frozen rescue port 4321");
    }
    await Promise.all([
      writeSelectedPort(activePortFile, backendPort),
      writeSelectedPort(unusedChannelPortFile, unusedChannelPortA),
    ]);

    const providerStore = await new ProviderStore(stateDirectory).initialize();
    const provider = await providerStore.create({
      name: `Backpressure probe ${name}`,
      baseUrl: "https://backpressure-provider.example.test/v1",
      model: "gpt-smoke",
      apiKey: "backpressure-probe-secret",
    });
    await providerStore.setActive(provider.id);

    const shim = path.join(fakeBin, "codex");
    await fs.writeFile(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
      { mode: 0o755 },
    );

    const backend = spawnProcess("server.mjs", {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: homeDirectory,
      HOST: "127.0.0.1",
      PORT: String(backendPort),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
      CODEX_DESKTOP_AUTH_FILE: path.join(caseDirectory, "missing-auth.json"),
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: defaultProject,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_MULTI_USER_ROOT: path.join(caseDirectory, "users"),
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: "/bin/false",
      FAKE_CODEX_PROJECT: defaultProject,
      NODE_ENV: "test",
    });
    processes.push(backend);
    await waitForOutput(backend, "WFL Codex Desktop v");
    await waitForDeepReady(`http://127.0.0.1:${backendPort}`);

    let targetPort = backendPort;
    let gateway = null;
    if (throughGateway) {
      gateway = spawnProcess("gateway.mjs", {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(gatewayPort),
        CODEX_DESKTOP_UPSTREAM_HOST: "127.0.0.1",
        CODEX_DESKTOP_UPSTREAM_PORTS: String(backendPort),
        CODEX_DESKTOP_UPSTREAM_PORT: String(backendPort),
        CODEX_DESKTOP_ACTIVE_PORT_FILE: activePortFile,
        CODEX_DESKTOP_RESCUE_PORTS: `${unusedChannelPortA},${unusedChannelPortB}`,
        CODEX_DESKTOP_RESCUE_PORT: String(unusedChannelPortA),
        CODEX_DESKTOP_RESCUE_ACTIVE_PORT_FILE: unusedChannelPortFile,
      });
      processes.push(gateway);
      await waitForOutput(gateway, "WFL Codex Gateway:");
      await waitForGatewayReady(`http://127.0.0.1:${gatewayPort}`, backendPort);
      targetPort = gatewayPort;
    }

    const probeId = `${name}-${randomUUID()}`;
    const targetUrl = `ws://127.0.0.1:${targetPort}/ws`;
    const origin = `http://127.0.0.1:${targetPort}`;
    const fast = await connectProbeClient(targetUrl, origin, probeId);
    const slow = await connectProbeClient(targetUrl, origin, probeId);
    clients.push(fast.socket, slow.socket);
    for (const client of [fast, slow]) {
      client.socket.send(JSON.stringify({
        type: "client/state",
        threadId: "thread_smoke_001",
        visible: true,
      }));
    }

    await delay(100);
    slow.socket._socket.pause();
    const processHandles = {
      backend,
      ...(gateway ? { gateway } : {}),
    };
    const memory = initialMemorySnapshot(processHandles);
    sampler = setInterval(() => sampleMemory(processHandles, memory), 10);
    sampler.unref();

    const startedAt = performance.now();
    fast.socket.send(JSON.stringify({
      type: "rpc",
      requestId: `backpressure-${probeId}`,
      method: "turn/start",
      params: {
        threadId: "thread_smoke_001",
        cwd: defaultProject,
        input: [{ type: "text", text: `measure websocket backpressure ${probeId}` }],
        clientUserMessageId: `client-${probeId}`,
        model: "gpt-smoke",
        approvalPolicy: "never",
      },
    }));

    await withTimeout(fast.completed, "fast client did not receive the bounded stream");
    const fastCompletedAt = performance.now();
    await delay(250);
    sampleMemory(processHandles, memory);
    const slowFramesBeforeResume = slow.frameCount();
    const memoryBeforeResume = snapshotMemory(memory);

    const resumedAt = performance.now();
    slow.socket._socket.resume();
    await withTimeout(slow.completed, "slow client did not drain after resuming");
    const slowCompletedAt = performance.now();
    sampleMemory(processHandles, memory);
    clearInterval(sampler);
    sampler = null;

    assert.equal(fast.frameCount(), FRAME_COUNT);
    assert.equal(fast.payloadBytes(), TOTAL_PAYLOAD_BYTES);
    assert.equal(slow.frameCount(), FRAME_COUNT);
    assert.equal(slow.payloadBytes(), TOTAL_PAYLOAD_BYTES);
    assert.equal(slowFramesBeforeResume, 0);

    return {
      transport: throughGateway ? "temporary-gateway-to-main-backend" : "direct-main-backend",
      frameCount: FRAME_COUNT,
      payloadBytesPerFrame: PAYLOAD_BYTES,
      totalPayloadBytes: TOTAL_PAYLOAD_BYTES,
      fastClient: {
        completionMs: Number((fastCompletedAt - startedAt).toFixed(3)),
        frames: fast.frameCount(),
        payloadBytes: fast.payloadBytes(),
      },
      pausedClient: {
        framesBeforeResume: slowFramesBeforeResume,
        completionAfterResumeMs: Number((slowCompletedAt - resumedAt).toFixed(3)),
        frames: slow.frameCount(),
        payloadBytes: slow.payloadBytes(),
      },
      processMemory: memoryBeforeResume,
      observation: {
        fastClientCompletedWhilePeerPaused: true,
        boundedProbeDrainedAfterResume: true,
        noConfiguredQueueOrByteBudget: true,
      },
    };
  } finally {
    if (sampler) clearInterval(sampler);
    for (const client of clients) await closeWebSocket(client).catch(() => {});
    for (const child of [...processes].reverse()) await stopProcess(child).catch(() => {});
  }
}

async function connectProbeClient(url, origin, probeId) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  let frameCount = 0;
  let payloadBytes = 0;
  let readySettled = false;
  let completedSettled = false;
  let readyResolve;
  let readyReject;
  let completedResolve;
  let completedReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const completed = new Promise((resolve, reject) => {
    completedResolve = resolve;
    completedReject = reject;
  });
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type === "bridge/status" && message.payload?.status === "ready") {
      readySettled = true;
      readyResolve();
      return;
    }
    if (
      message?.type === "rpc/error"
      && message.requestId === `backpressure-${probeId}`
      && !completedSettled
    ) {
      completedSettled = true;
      completedReject(new Error(`turn/start rejected: ${message.message || "unknown error"}`));
      return;
    }
    if (message?.type !== "codex/notification") return;
    const payload = message.payload || {};
    const marker = payload.params?.diagnosticProbe;
    if (marker?.kind !== "websocket-backpressure" || marker.id !== probeId) return;
    if (payload.method === "item/agentMessage/delta") {
      frameCount += 1;
      payloadBytes += Buffer.byteLength(payload.params?.delta || "");
    }
    if (payload.method === "item/completed") {
      completedSettled = true;
      completedResolve();
    }
  });
  socket.once("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    if (!completedSettled) {
      completedSettled = true;
      completedReject(error);
    }
  });
  socket.once("close", (code, reason) => {
    if (code === 1000 && reason.toString() === "diagnostic complete") return;
    const error = new Error(`Probe client closed early (${code} ${reason.toString()})`);
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    if (!completedSettled) {
      completedSettled = true;
      completedReject(error);
    }
  });
  await withTimeout(ready, "probe client did not observe bridge ready");
  return {
    socket,
    completed,
    frameCount: () => frameCount,
    payloadBytes: () => payloadBytes,
  };
}

function initialMemorySnapshot(processHandles) {
  const result = {};
  for (const [name, child] of Object.entries(processHandles)) {
    const rssBytes = processRssBytes(child.pid);
    result[name] = {
      pid: child.pid,
      baselineRssBytes: rssBytes,
      peakRssBytes: rssBytes,
      latestRssBytes: rssBytes,
    };
  }
  return result;
}

function sampleMemory(processHandles, memory) {
  for (const [name, child] of Object.entries(processHandles)) {
    const rssBytes = processRssBytes(child.pid);
    if (!Number.isFinite(rssBytes)) continue;
    memory[name].latestRssBytes = rssBytes;
    memory[name].peakRssBytes = Math.max(memory[name].peakRssBytes, rssBytes);
  }
}

function snapshotMemory(memory) {
  return Object.fromEntries(Object.entries(memory).map(([name, value]) => [
    name,
    {
      baselineRssBytes: value.baselineRssBytes,
      beforeResumeRssBytes: value.latestRssBytes,
      peakRssBytes: value.peakRssBytes,
      beforeResumeDeltaBytes: value.latestRssBytes - value.baselineRssBytes,
      peakDeltaBytes: value.peakRssBytes - value.baselineRssBytes,
    },
  ]));
}

function processRssBytes(pid) {
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function spawnProcess(script, environment) {
  return spawn(process.execPath, [script], {
    cwd: projectDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`${path.basename(processHandle.spawnargs[1])} did not start: ${output}`)),
      PROBE_TIMEOUT_MS,
    );
    const collect = (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      processHandle.stdout.off("data", collect);
      processHandle.stderr.off("data", collect);
      resolve();
    };
    processHandle.stdout.on("data", collect);
    processHandle.stderr.on("data", collect);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited early (${code}): ${output}`));
    });
  });
}

async function waitForDeepReady(url) {
  await waitFor(async () => {
    try {
      const response = await fetch(`${url}/internal/codex-ready`);
      const data = await response.json();
      return response.ok && data.codexReady === true && data.threadListReady === true;
    } catch {
      return false;
    }
  }, `backend did not become ready: ${url}`);
}

async function waitForGatewayReady(url, upstreamPort) {
  await waitFor(async () => {
    try {
      const response = await fetch(`${url}/internal/gateway-ready`);
      const data = await response.json();
      return response.ok
        && data.upstreamPort === upstreamPort
        && data.rescueChannelIsolated === true;
    } catch {
      return false;
    }
  }, `gateway did not select upstream ${upstreamPort}`);
}

async function waitFor(check, message, timeoutMs = PROBE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}

function withTimeout(promise, message, timeoutMs = PROBE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function reserveDistinctPorts(count) {
  const servers = [];
  const ports = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
      ports.push(server.address().port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function writeSelectedPort(file, port) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${port}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function closeWebSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  socket._socket?.resume();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1_000);
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "diagnostic complete");
    else socket.terminate();
  });
}

function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      finish();
    }, 3_000);
    processHandle.once("exit", finish);
    processHandle.kill("SIGTERM");
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
