import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 15_000;
const REQUEST_COUNT = 128;
const PADDING_BYTES = 64 * 1024;
const TOTAL_PADDING_BYTES = REQUEST_COUNT * PADDING_BYTES;

let backend = null;
let client = null;
let directory = null;
let memoryTimer = null;
let stoppedAppServerPid = null;

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-app-server-stdin-backpressure-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "probe-project");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const runtimeDirectory = path.join(directory, "runtime");
  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
  ]);

  const port = await reservePort();
  assert.notEqual(port, 4321, "stdin diagnostic must exclude frozen rescue port 4321");
  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "App Server stdin backpressure probe",
    baseUrl: "https://stdin-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "stdin-backpressure-probe-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  backend = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: homeDirectory,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
      CODEX_DESKTOP_AUTH_FILE: path.join(directory, "missing-auth.json"),
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: defaultProject,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_MULTI_USER_ROOT: path.join(directory, "users"),
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: "/bin/false",
      FAKE_CODEX_PROJECT: defaultProject,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(backend, "WFL Codex Desktop v");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForDeepReady(baseUrl);

  const probeClient = await connectProbeClient(
    `ws://127.0.0.1:${port}/ws`,
    baseUrl,
  );
  client = probeClient.socket;
  const control = await probeClient.rpc("thread/list", { limit: 1 });
  assert.equal(Array.isArray(control.data), true);
  const childPid = fakeAppServerPid(backend.pid);
  assert.ok(Number.isInteger(childPid), "temporary fake App Server child was not found");
  process.kill(childPid, "SIGSTOP");
  stoppedAppServerPid = childPid;
  await delay(100);

  const memory = {
    backend: initialMemory(backend.pid),
    ...(childPid ? { fakeAppServer: initialMemory(childPid) } : {}),
  };
  memoryTimer = setInterval(() => sampleMemory(memory), 10);
  memoryTimer.unref();

  const padding = "x".repeat(PADDING_BYTES);
  const sendStartedAt = performance.now();
  const sends = [];
  for (let index = 0; index < REQUEST_COUNT; index += 1) {
    sends.push(probeClient.sendRpc(`stdin-${index}-${randomUUID()}`, "thread/list", {
      limit: 1,
      diagnosticPadding: padding,
    }));
  }
  await Promise.all(sends);
  const sendCompletedAt = performance.now();
  await delay(750);
  sampleMemory(memory);
  clearInterval(memoryTimer);
  memoryTimer = null;

  const readinessStartedAt = performance.now();
  const readinessResponse = await fetch(`${baseUrl}/internal/codex-ready`);
  const readiness = await readinessResponse.json();
  const readinessMs = performance.now() - readinessStartedAt;
  assert.equal(backend.exitCode, null);
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal(probeClient.untrackedResultCount(), 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "random-port-main-backend-to-paused-fake-app-server-stdin",
      requestCount: REQUEST_COUNT,
      paddingBytesPerRequest: PADDING_BYTES,
      maximumPaddingBytes: TOTAL_PADDING_BYTES,
      productionRequests: 0,
      frozenRescuePortTouched: false,
    },
    control: {
      initialThreadListSucceeded: Array.isArray(control.data),
      stopSignal: "SIGSTOP",
      fakeAppServerPidObserved: childPid,
    },
    writes: {
      requestsSent: REQUEST_COUNT,
      sendLoopMs: Number((sendCompletedAt - sendStartedAt).toFixed(3)),
      rpcResultsWhilePaused: probeClient.untrackedResultCount(),
      noRpcResultsObserved: probeClient.untrackedResultCount() === 0,
    },
    processMemory: snapshotMemory(memory),
    readinessWhileStdinBlocked: {
      httpStatus: readinessResponse.status,
      responseMs: Number(readinessMs.toFixed(3)),
      codexReady: readiness.codexReady,
      threadListReady: readiness.threadListReady,
    },
    currentControls: {
      stdinWriteReturnObserved: false,
      drainAwaited: false,
      pendingRequestLimit: null,
      pendingByteLimit: null,
      readinessDetectsBlockedStdin: false,
      targetMet: false,
    },
  }, null, 2)}\n`);
} finally {
  if (memoryTimer) clearInterval(memoryTimer);
  if (client) await closeWebSocket(client).catch(() => {});
  if (stoppedAppServerPid) {
    try {
      process.kill(stoppedAppServerPid, "SIGCONT");
    } catch {
      // The temporary process may already have exited.
    }
  }
  if (backend) await stopProcess(backend).catch(() => {});
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

async function connectProbeClient(url, origin) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  const pending = new Map();
  let untrackedResults = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message?.type === "bridge/status" && message.payload?.status === "ready") {
      readyResolve();
      return;
    }
    if (!["rpc/result", "rpc/error"].includes(message?.type)) return;
    const waiter = pending.get(String(message.requestId));
    if (!waiter) {
      untrackedResults += 1;
      return;
    }
    pending.delete(String(message.requestId));
    if (message.type === "rpc/error") waiter.reject(new Error(message.message || "RPC failed"));
    else waiter.resolve(message.result);
  });
  socket.once("error", (error) => {
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  await withTimeout(ready, "stdin probe client did not observe bridge ready");
  return {
    socket,
    rpc(method, params) {
      const requestId = `control-${randomUUID()}`;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ type: "rpc", requestId, method, params }));
      });
    },
    sendRpc(requestId, method, params) {
      return new Promise((resolve, reject) => {
        socket.send(
          JSON.stringify({ type: "rpc", requestId, method, params }),
          (error) => error ? reject(error) : resolve(),
        );
      });
    },
    untrackedResultCount: () => untrackedResults,
  };
}

function initialMemory(pid) {
  const rssBytes = processRssBytes(pid);
  return {
    pid,
    baselineRssBytes: rssBytes,
    latestRssBytes: rssBytes,
    peakRssBytes: rssBytes,
  };
}

function sampleMemory(memory) {
  for (const value of Object.values(memory)) {
    const rssBytes = processRssBytes(value.pid);
    if (!Number.isFinite(rssBytes)) continue;
    value.latestRssBytes = rssBytes;
    value.peakRssBytes = Math.max(value.peakRssBytes, rssBytes);
  }
}

function snapshotMemory(memory) {
  return Object.fromEntries(Object.entries(memory).map(([name, value]) => [
    name,
    {
      baselineRssBytes: value.baselineRssBytes,
      afterWritesRssBytes: value.latestRssBytes,
      peakRssBytes: value.peakRssBytes,
      afterWritesDeltaBytes: value.latestRssBytes - value.baselineRssBytes,
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

function fakeAppServerPid(pid) {
  try {
    const children = fsSync.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    for (const rawPid of children.split(/\s+/).filter(Boolean)) {
      const childPid = Number(rawPid);
      const commandLine = fsSync.readFileSync(`/proc/${childPid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (commandLine.includes("fake-codex-app-server.mjs")) return childPid;
    }
    return null;
  } catch {
    return null;
  }
}

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Server did not start: ${output}`)),
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
      reject(new Error(`Server exited early (${code}): ${output}`));
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

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function closeWebSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
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
