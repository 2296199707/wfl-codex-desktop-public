import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket, { WebSocketServer } from "ws";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 25_000;
const THREAD_ID = "thread_smoke_001";
const LEGACY_REPEAT_PROMPT = "Historical question 16";

let browser = null;
let context = null;
let child = null;
let proxy = null;
let directory = null;

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-pending-legacy-collision-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "collision-project");
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

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "Pending collision diagnostic provider",
    baseUrl: "https://pending-collision.example.test/v1",
    model: "gpt-smoke",
    apiKey: "pending-collision-diagnostic-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const [backendPort, proxyPort] = await reserveDistinctPorts(2);
  assert.notEqual(backendPort, 4321, "diagnostic backend must exclude the frozen rescue port");
  assert.notEqual(proxyPort, 4321, "diagnostic proxy must exclude the frozen rescue port");
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;

  child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: homeDirectory,
      HOST: "127.0.0.1",
      PORT: String(backendPort),
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
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(backendBaseUrl);

  proxy = await createCollisionProxy({
    listenPort: proxyPort,
    upstreamPort: backendPort,
  });

  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route("**/app.js*", instrumentApplicationState);
  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(proxyBaseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  const threadRow = page.locator(
    ".thread-row",
    { hasText: "Browser recovery smoke test" },
  ).first();
  await threadRow.waitFor();
  await threadRow.evaluate((node) => node.click());
  await page.locator("#messageList").getByText(
    "The authoritative conversation was restored.",
    { exact: true },
  ).waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  const legacyItemVisibleBeforeSend = await page.evaluate((expectedText) => (
    globalThis.__wflPendingCollisionState?.activeThread?.turns?.some((turn) =>
      (turn.items || []).some((item) => (
        item?.type === "userMessage"
        && !item.clientId
        && (item.content || []).some((part) => part?.type === "text" && part.text === expectedText)
      )))
  ), LEGACY_REPEAT_PROMPT);
  assert.equal(legacyItemVisibleBeforeSend, true);

  proxy.arm();
  await page.locator("#promptInput").fill(LEGACY_REPEAT_PROMPT);
  await page.locator("#sendButton").click();
  await proxy.waitForFirstHeldTurnStart();
  await page.waitForFunction(() => (
    globalThis.__wflPendingCollisionState?.pendingTurnRequest
    && globalThis.__wflPendingCollisionState?.pendingUserMessage
  ));

  const beforeReconnect = await pendingSnapshot(page);
  assert.equal(beforeReconnect.pendingUserMessagePresent, true);
  assert.equal(beforeReconnect.pendingTurnRequestPresent, true);
  assert.equal(beforeReconnect.pendingDomNodeCount, 1);
  const pendingClientId = beforeReconnect.pendingClientId;
  assert.ok(pendingClientId);

  const injected = await emitUnrelatedTurn(backendBaseUrl, defaultProject);
  assert.equal(injected.eventSequenceAdvanced, true);

  proxy.resume();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await proxy.waitForSecondHeldTurnStart();
  const afterRefreshBeforeExecution = await pendingSnapshot(page);
  assert.equal(afterRefreshBeforeExecution.pendingUserMessagePresent, false);
  assert.equal(afterRefreshBeforeExecution.pendingTurnRequestPresent, true);
  assert.equal(afterRefreshBeforeExecution.pendingDomNodeCount, 0);
  assert.equal(proxy.forwardedProbeTurnStarts, 0);
  assert.equal(proxy.threadTurnsListRequests >= 1, true);

  proxy.releaseSecondTurnStart();
  await page.waitForFunction((expectedClientId) => (
    !globalThis.__wflPendingCollisionState?.pendingTurnRequest
    && globalThis.__wflPendingCollisionState?.activeThread?.turns?.some((turn) =>
      (turn.items || []).some((item) => item?.clientId === expectedClientId))
  ), pendingClientId);
  const afterAuthoritativeArrival = await pendingSnapshot(page, pendingClientId);

  assert.equal(afterAuthoritativeArrival.pendingTurnRequestPresent, false);
  assert.equal(afterAuthoritativeArrival.authoritativeClientItemPresent, true);
  assert.equal(proxy.forwardedProbeTurnStarts, 1);
  assert.equal(pageErrors.length, 0);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "isolated-browser-random-port-same-epoch-gap-proxy",
      appServer: "fake-codex-app-server",
      productionRequests: 0,
      frozenRescuePortTouched: false,
      formalChecksModified: false,
      recordedContent: false,
    },
    scenario: {
      name: "unbound-pending-collides-with-legacy-same-text",
      legacyItemWithoutClientIdPresent: legacyItemVisibleBeforeSend,
      browserTurnStartAttempts: proxy.turnStartAttempts,
      appServerTurnStartsBeforeCollisionObserved: 0,
      recentTurnsRefreshObserved: proxy.threadTurnsListRequests >= 1,
      beforeReconnect: withoutClientId(beforeReconnect),
      afterRefreshBeforeExecution: withoutClientId(afterRefreshBeforeExecution),
      afterAuthoritativeArrival: withoutClientId(afterAuthoritativeArrival),
    },
    classification: {
      textFallbackMatchedDifferentHistoricalSubmission: true,
      pendingClearedWhileRpcStillOutstanding: true,
      pendingClearedBeforeAppServerExecution: true,
      firstIncorrectLayer: "browser-store-refresh-settlement",
      authoritativeMessageEventuallyReturns: true,
      stableSubmissionIdentityRequired: true,
      targetMet: false,
    },
  }, null, 2)}\n`);
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await proxy?.close().catch(() => {});
  await stopProcess(child).catch(() => {});
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

function withoutClientId(snapshot) {
  const {
    pendingClientId: _pendingClientId,
    ...safe
  } = snapshot;
  return safe;
}

async function pendingSnapshot(page, expectedClientId = null) {
  return page.evaluate((clientId) => {
    const debugState = globalThis.__wflPendingCollisionState;
    const pending = debugState?.pendingUserMessage || null;
    return {
      pendingUserMessagePresent: Boolean(pending),
      pendingTurnRequestPresent: Boolean(debugState?.pendingTurnRequest),
      pendingDomNodeCount: [...document.getElementById("messageList").children]
        .filter((node) => node.dataset.transcriptKey?.includes(":pending:")).length,
      pendingClientId: pending?.clientId
        || debugState?.pendingTurnRequest?.params?.clientUserMessageId
        || null,
      authoritativeClientItemPresent: Boolean(
        clientId
        && debugState?.activeThread?.turns?.some((turn) =>
          (turn.items || []).some((item) => item?.clientId === clientId)),
      ),
    };
  }, expectedClientId);
}

async function instrumentApplicationState(route) {
  const response = await route.fetch();
  const source = await response.text();
  const stateNeedle = "const state = {";
  assert.equal(source.includes(stateNeedle), true, "diagnostic state anchor is missing");
  const instrumented = source.replace(
    stateNeedle,
    "const state = globalThis.__wflPendingCollisionState = {",
  );
  await route.fulfill({ response, body: instrumented });
}

async function createCollisionProxy({ listenPort, upstreamPort }) {
  const clients = new Set();
  const upstreams = new Set();
  let armed = false;
  let blocked = false;
  let firstHeldResolve;
  let secondHeldResolve;
  let secondHeld = null;
  let turnStartAttempts = 0;
  let forwardedProbeTurnStarts = 0;
  let threadTurnsListRequests = 0;
  const firstHeld = new Promise((resolve) => {
    firstHeldResolve = resolve;
  });
  const secondHeldPromise = new Promise((resolve) => {
    secondHeldResolve = resolve;
  });

  const server = http.createServer((request, response) => {
    const upstreamRequest = http.request({
      hostname: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.on("error", () => {
      if (!response.headersSent) response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("Diagnostic backend unavailable");
    });
    request.pipe(upstreamRequest);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (blocked) {
      socket.destroy();
      return;
    }
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${request.url}`, {
      headers: forwardedWebSocketHeaders(request.headers),
    });
    upstreams.add(upstream);
    const buffered = [];
    const bufferMessage = (data, isBinary) => buffered.push([data, isBinary]);
    upstream.on("message", bufferMessage);

    upstream.once("open", () => {
      if (blocked) {
        upstream.terminate();
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        clients.add(client);
        upstream.off("message", bufferMessage);
        const forwardUpstream = (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        };
        upstream.on("message", forwardUpstream);
        for (const [data, isBinary] of buffered) forwardUpstream(data, isBinary);

        client.on("message", (data, isBinary) => {
          let message = null;
          try {
            message = JSON.parse(data.toString());
          } catch {
            // Opaque frames are forwarded without recording.
          }
          if (message?.type === "rpc" && message.method === "thread/turns/list") {
            threadTurnsListRequests += 1;
          }
          if (armed && message?.type === "rpc" && message.method === "turn/start") {
            turnStartAttempts += 1;
            if (turnStartAttempts === 1) {
              blocked = true;
              firstHeldResolve();
              setTimeout(() => {
                if (client.readyState === WebSocket.OPEN) client.terminate();
                if (upstream.readyState === WebSocket.OPEN) upstream.terminate();
              }, 0);
              return;
            }
            if (turnStartAttempts === 2) {
              secondHeld = { upstream, data, isBinary };
              secondHeldResolve();
              return;
            }
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });

        const closeClient = () => {
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.terminate();
          }
        };
        upstream.once("close", closeClient);
        upstream.once("error", closeClient);
        client.once("close", () => {
          clients.delete(client);
          upstream.off("message", forwardUpstream);
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.terminate();
          }
        });
      });
    });
    upstream.once("error", () => {
      upstreams.delete(upstream);
      socket.destroy();
    });
    upstream.once("close", () => upstreams.delete(upstream));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolve);
  });

  return {
    get forwardedProbeTurnStarts() {
      return forwardedProbeTurnStarts;
    },
    get threadTurnsListRequests() {
      return threadTurnsListRequests;
    },
    get turnStartAttempts() {
      return turnStartAttempts;
    },
    arm() {
      armed = true;
    },
    resume() {
      blocked = false;
    },
    waitForFirstHeldTurnStart() {
      return firstHeld;
    },
    waitForSecondHeldTurnStart() {
      return secondHeldPromise;
    },
    releaseSecondTurnStart() {
      assert.ok(secondHeld, "second turn/start is not held");
      const held = secondHeld;
      secondHeld = null;
      forwardedProbeTurnStarts += 1;
      held.upstream.send(held.data, { binary: held.isBinary });
    },
    async close() {
      blocked = true;
      for (const client of clients) client.terminate();
      for (const upstream of upstreams) upstream.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function emitUnrelatedTurn(baseUrl, cwd) {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Origin: baseUrl },
  });
  const observer = observeJsonSocket(socket);
  try {
    await waitForSocketOpen(socket);
    const ready = await observer.waitFor(
      (message) => message?.type === "bridge/status" && message.payload?.status === "ready",
      "direct diagnostic bridge ready",
    );
    const initialSequence = Number.isSafeInteger(ready.payload?.eventSequence)
      ? ready.payload.eventSequence
      : 0;
    const requestId = `pending-collision-${randomUUID()}`;
    socket.send(JSON.stringify({
      type: "rpc",
      requestId,
      method: "turn/start",
      params: {
        threadId: "thread_smoke_parallel",
        clientUserMessageId: `pending-collision-${randomUUID()}`,
        input: [{ type: "text", text: "finish concurrent task" }],
        cwd,
        model: "gpt-smoke",
        effort: "medium",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    }));
    const response = await observer.waitFor(
      (message) => (
        (message?.type === "rpc/result" || message?.type === "rpc/error")
        && String(message.requestId) === requestId
      ),
      "direct diagnostic turn/start",
    );
    if (response.type === "rpc/error") throw new Error("Unable to advance diagnostic sequence");
    const completed = await observer.waitFor(
      (message) => (
        message?.type === "codex/notification"
        && message.payload?.method === "turn/completed"
        && message.payload?.params?.threadId === "thread_smoke_parallel"
      ),
      "direct diagnostic turn completion",
    );
    return {
      eventSequenceAdvanced: (
        Number.isSafeInteger(completed.eventSequence)
        && completed.eventSequence > initialSequence
      ),
    };
  } finally {
    await closeProbeSocket(socket);
  }
}

function observeJsonSocket(socket) {
  const messages = [];
  const waiters = new Set();
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  return {
    waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}`));
          }, PROBE_TIMEOUT_MS),
        };
        waiters.add(waiter);
      });
    },
  };
}

function waitForSocketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out opening diagnostic WebSocket")),
      PROBE_TIMEOUT_MS,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function closeProbeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.close(1000, "Diagnostic complete");
  await Promise.race([closed, delay(1_000)]);
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

function forwardedWebSocketHeaders(headers) {
  const forwarded = {};
  for (const name of [
    "authorization",
    "cookie",
    "origin",
    "user-agent",
    "x-forwarded-for",
    "x-forwarded-proto",
  ]) {
    if (headers[name] !== undefined) forwarded[name] = headers[name];
  }
  if (headers.host) forwarded.host = headers.host;
  return forwarded;
}

async function waitForCodexConnection(page) {
  await page.waitForFunction(
    () => document.getElementById("connectionText")?.textContent === "Codex 已连接",
  );
}

function reserveDistinctPorts(count) {
  return Promise.all(Array.from({ length: count }, () => getFreePort()))
    .then((ports) => (
      new Set(ports).size === count ? ports : reserveDistinctPorts(count)
    ));
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

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Backend did not start: ${output}`)),
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
      reject(new Error(`Backend exited early (${code}): ${output}`));
    });
  });
}

async function waitForDeepReady(url) {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/internal/codex-ready`);
      const data = await response.json();
      if (response.ok && data.codexReady === true && data.threadListReady === true) return;
    } catch {
      // The isolated fake App Server may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Backend did not become ready: ${url}`);
}

async function stopProcess(processHandle) {
  if (
    !processHandle
    || processHandle.exitCode !== null
    || processHandle.signalCode !== null
  ) return;
  const exited = new Promise((resolve) => processHandle.once("exit", resolve));
  processHandle.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
