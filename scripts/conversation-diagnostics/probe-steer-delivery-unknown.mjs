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
const INITIAL_PROMPT = "hold account quota inspection";
const STEER_PROMPT = "diagnose steer delivery unknown";
const scenarios = [
  {
    name: "same-epoch-memory-dedup",
    restartBackend: false,
    historyVisible: false,
    expectedBrowserSteers: 2,
    expectSteerResult: true,
  },
  {
    name: "cross-epoch-history-visible",
    restartBackend: true,
    historyVisible: true,
    expectedBrowserSteers: 2,
    expectSteerResult: true,
  },
  {
    name: "cross-epoch-history-not-visible",
    restartBackend: true,
    historyVisible: false,
    expectedBrowserSteers: 2,
    expectSteerResult: false,
    manualResubmit: true,
  },
  {
    name: "page-reload-after-steer-result-loss",
    restartBackend: false,
    historyVisible: false,
    expectedBrowserSteers: 1,
    expectSteerResult: false,
    reloadAfterDrop: true,
  },
];

let browser = null;
let rootDirectory = null;
const liveChildren = new Set();
const liveProxies = new Set();

try {
  rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-steer-delivery-unknown-"));
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));

  assert.equal(results[0].appServerSteerCount, 1);
  assert.equal(results[1].appServerSteerCount, 1);
  assert.equal(results[2].steerRejectedAfterRestart, true);
  assert.equal(results[2].steerTextRestoredAsOrdinaryInput, true);
  assert.equal(results[2].manualResubmitBecameNewTurn, true);
  assert.equal(results[3].browserSteerCount, 1);
  assert.equal(results[3].steerTextRestoredAfterReload, false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "isolated-browser-random-port-steer-result-fault",
      appServer: "fake-codex-app-server",
      productionRequests: 0,
      frozenRescuePortTouched: false,
      formalChecksModified: false,
      capturedContent: false,
    },
    scenarios: results,
    classification: {
      sameEpochSteerRetryUsesStableClientId: true,
      sameEpochSafetySource: "in-memory-turn-deduplicator",
      crossEpochHistoryCanReconcileSteer: true,
      crossEpochHistoryMissBecomesOrdinaryRejection: true,
      rejectedUnknownSteerRestoredAsOrdinaryInput: true,
      manualResubmitChangesSteerIntoNewTurn: true,
      reloadDropsPendingSteerAndFrozenInput: true,
      durableSteerSubmissionLedgerPresent: false,
      targetMet: false,
    },
  }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
  for (const proxy of liveProxies) await proxy.close().catch(() => {});
  for (const child of liveChildren) await stopProcess(child).catch(() => {});
  if (rootDirectory) await fs.rm(rootDirectory, { recursive: true, force: true });
}

async function runScenario(scenario) {
  const traceId = randomUUID();
  const directory = path.join(rootDirectory, scenario.name);
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "steer-project");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const runtimeDirectory = path.join(directory, "runtime");
  const traceFile = path.join(directory, "app-server-trace.ndjson");
  const turnStateFile = path.join(directory, "persisted-turns.json");

  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.writeFile(traceFile, "", { mode: 0o600 }),
    fs.writeFile(turnStateFile, "[]\n", { mode: 0o600 }),
  ]);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "Steer delivery diagnostic provider",
    baseUrl: "https://steer-delivery.example.test/v1",
    model: "gpt-smoke",
    apiKey: "steer-delivery-diagnostic-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const [backendPort, proxyPort] = await reserveDistinctPorts(2);
  assert.notEqual(backendPort, 4321);
  assert.notEqual(proxyPort, 4321);
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
  const commonEnvironment = {
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
    FAKE_CODEX_DIAGNOSTIC_TRACE_FILE: traceFile,
    FAKE_CODEX_DIAGNOSTIC_TRACE_ID: traceId,
    FAKE_CODEX_DIAGNOSTIC_TURN_STATE_FILE: turnStateFile,
    FAKE_CODEX_DIAGNOSTIC_TURN_PERSIST_STATUS: "inProgress",
    NODE_ENV: "test",
  };

  let backend = await startBackend(commonEnvironment, "boot1", false, backendBaseUrl);
  let restartPromise = null;
  const proxy = await createSteerFaultProxy({
    listenPort: proxyPort,
    upstreamPort: backendPort,
    onFirstResultDropped: () => {
      if (!scenario.restartBackend || restartPromise) return;
      restartPromise = (async () => {
        await stopProcess(backend);
        backend = await startBackend(
          commonEnvironment,
          "boot2",
          scenario.historyVisible,
          backendBaseUrl,
        );
      })();
    },
  });
  liveProxies.add(proxy);

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(proxyBaseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    const threadRow = page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).first();
    await threadRow.waitFor();
    await threadRow.evaluate((node) => node.click());
    await page.locator("#messageList").getByText(
      "The authoritative conversation was restored.",
      { exact: true },
    ).waitFor();
    await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
    await page.locator("#promptInput").fill(INITIAL_PROMPT);
    await page.locator("#sendButton").click();
    await page.locator("#stopTurnButton").waitFor({ state: "visible" });
    await waitFor(
      () => proxy.rpcRequests.some((entry) => entry.method === "turn/start"),
      "initial turn/start was not observed",
    );

    await page.locator("#promptInput").fill(STEER_PROMPT);
    await page.locator("#sendButton").click();
    await proxy.waitForFirstResultDrop();

    let steerTextRestoredAsOrdinaryInput = null;
    let manualResubmitBecameNewTurn = null;
    let steerTextRestoredAfterReload = null;
    if (scenario.reloadAfterDrop) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForCodexConnection(page);
      await delay(2_500);
      steerTextRestoredAfterReload = await page.locator("#promptInput").inputValue() === STEER_PROMPT;
    } else if (scenario.restartBackend) {
      await waitFor(() => Boolean(restartPromise), "backend restart was not scheduled");
      await restartPromise;
      await waitFor(
        () => uniqueReadyEpochs(proxy.bridgeStatuses).length >= 2,
        "browser did not observe the restarted runtime Epoch",
      );
      await waitForCodexConnection(page);
    }

    if (scenario.expectSteerResult) {
      await waitFor(
        () => (
          proxy.steerRequests.length >= scenario.expectedBrowserSteers
          && proxy.forwardedSteerResults.length >= 1
        ),
        `${scenario.name} did not reconcile the Steer`,
      );
    } else if (scenario.manualResubmit) {
      await waitFor(
        () => (
          proxy.steerRequests.length >= scenario.expectedBrowserSteers
          && proxy.forwardedSteerErrors.length >= 1
        ),
        `${scenario.name} did not reject the unresolved Steer`,
      );
      await page.waitForFunction((expectedPrompt) => (
        document.getElementById("promptInput")?.value === expectedPrompt
        && !document.getElementById("sendButton")?.disabled
      ), STEER_PROMPT);
      steerTextRestoredAsOrdinaryInput = true;
      const turnStartsBeforeManual = proxy.rpcRequests.filter((entry) => entry.method === "turn/start").length;
      await page.locator("#sendButton").click();
      await waitFor(
        () => proxy.rpcRequests.filter((entry) => entry.method === "turn/start").length > turnStartsBeforeManual,
        "restored Steer was not resubmitted as a new Turn",
      );
      manualResubmitBecameNewTurn = true;
    } else {
      await delay(2_500);
      assert.equal(proxy.steerRequests.length, scenario.expectedBrowserSteers);
    }

    const traceSource = await fs.readFile(traceFile, "utf8");
    const persistedSource = await fs.readFile(turnStateFile, "utf8");
    assert.equal(traceSource.includes(INITIAL_PROMPT), false);
    assert.equal(traceSource.includes(STEER_PROMPT), false);
    assert.equal(persistedSource.includes(INITIAL_PROMPT), false);
    assert.equal(persistedSource.includes(STEER_PROMPT), false);
    const trace = parseNdjson(traceSource);
    const appServerSteers = trace.filter((entry) => (
      entry.direction === "in" && entry.method === "turn/steer"
    ));
    const browserSteers = proxy.steerRequests.slice(0, scenario.expectedBrowserSteers);
    const steerClientIds = new Set(browserSteers.map((entry) => entry.clientId));
    const runtimeEpochs = uniqueReadyEpochs(proxy.bridgeStatuses);
    const turnStartRequests = proxy.rpcRequests.filter((entry) => entry.method === "turn/start");

    assert.equal(browserSteers.length, scenario.expectedBrowserSteers);
    assert.equal(steerClientIds.size, 1);
    assert.equal(appServerSteers.length, 1);
    assert.equal(proxy.droppedSteerResults.length, 1);
    assert.equal(pageErrors.length, 0);
    if (scenario.expectSteerResult) assert.equal(proxy.forwardedSteerResults.length >= 1, true);
    if (scenario.manualResubmit) assert.equal(proxy.forwardedSteerErrors.length >= 1, true);
    if (scenario.restartBackend) assert.equal(runtimeEpochs.length >= 2, true);
    else assert.equal(runtimeEpochs.length, 1);

    return {
      name: scenario.name,
      backendRestarted: scenario.restartBackend,
      persistedHistoryVisibleAfterRestart: scenario.historyVisible,
      browserSteerCount: browserSteers.length,
      sameSteerClientId: steerClientIds.size === 1,
      appServerSteerCount: appServerSteers.length,
      readyRuntimeEpochCount: runtimeEpochs.length,
      sameRuntimeEpoch: runtimeEpochs.length === 1,
      runtimeEpochChanged: runtimeEpochs.length >= 2,
      firstSteerResultDroppedAfterExecution: proxy.droppedSteerResults.length === 1,
      secondSteerResultForwarded: proxy.forwardedSteerResults.length >= 1,
      steerRejectedAfterRestart: proxy.forwardedSteerErrors.length >= 1,
      steerTextRestoredAsOrdinaryInput,
      manualResubmitBecameNewTurn,
      pageReloadedBeforeRetry: scenario.reloadAfterDrop === true,
      steerTextRestoredAfterReload,
      totalBrowserTurnStartCount: turnStartRequests.length,
    };
  } finally {
    await context.close().catch(() => {});
    await proxy.close().catch(() => {});
    liveProxies.delete(proxy);
    await stopProcess(backend).catch(() => {});
  }
}

async function startBackend(environment, bootId, historyVisible, baseUrl) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...environment,
      FAKE_CODEX_DIAGNOSTIC_TURN_ID_PREFIX: bootId,
      FAKE_CODEX_DIAGNOSTIC_TURN_STATE_VISIBLE: historyVisible ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);
  return child;
}

async function createSteerFaultProxy({ listenPort, upstreamPort, onFirstResultDropped }) {
  const steerRequests = [];
  const droppedSteerResults = [];
  const forwardedSteerResults = [];
  const forwardedSteerErrors = [];
  const rpcRequests = [];
  const bridgeStatuses = [];
  const clients = new Set();
  const upstreams = new Set();
  let socketCounter = 0;
  let faultArmed = true;
  let firstDropResolve;
  const firstDrop = new Promise((resolve) => {
    firstDropResolve = resolve;
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
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${request.url}`, {
      headers: forwardedWebSocketHeaders(request.headers),
    });
    upstreams.add(upstream);
    const buffered = [];
    const bufferMessage = (data, isBinary) => buffered.push([data, isBinary]);
    upstream.on("message", bufferMessage);
    upstream.once("open", () => {
      wss.handleUpgrade(request, socket, head, (client) => {
        const socketId = `steer-fault-ws-${++socketCounter}`;
        clients.add(client);
        upstream.off("message", bufferMessage);
        const methodsByRequestId = new Map();

        const forwardUpstream = (data, isBinary) => {
          let message = null;
          try {
            message = JSON.parse(data.toString());
          } catch {
            // Preserve opaque frames without recording them.
          }
          if (message?.type === "bridge/status") {
            bridgeStatuses.push({
              socketId,
              status: message.payload?.status || null,
              runtimeEpoch: message.payload?.runtimeEpoch || null,
            });
          }
          const method = message?.requestId == null
            ? null
            : methodsByRequestId.get(String(message.requestId)) || null;
          if (faultArmed && method === "turn/steer" && message?.type === "rpc/result") {
            faultArmed = false;
            const record = {
              socketId,
              requestId: String(message.requestId),
            };
            droppedSteerResults.push(record);
            onFirstResultDropped();
            firstDropResolve(record);
            client.terminate();
            if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "Injected Steer result loss");
            return;
          }
          if (method === "turn/steer" && message?.type === "rpc/result") {
            forwardedSteerResults.push({
              socketId,
              requestId: String(message.requestId),
              turnId: message.result?.turn?.id || null,
            });
          }
          if (method === "turn/steer" && message?.type === "rpc/error") {
            forwardedSteerErrors.push({
              socketId,
              requestId: String(message.requestId),
              messageClass: "ordinary-rpc-error",
            });
          }
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        };
        upstream.on("message", forwardUpstream);
        for (const [data, isBinary] of buffered) forwardUpstream(data, isBinary);

        client.on("message", (data, isBinary) => {
          let message = null;
          try {
            message = JSON.parse(data.toString());
          } catch {
            // Preserve opaque frames without recording them.
          }
          if (message?.type === "rpc" && message.requestId != null) {
            methodsByRequestId.set(String(message.requestId), message.method || null);
            const record = {
              socketId,
              requestId: String(message.requestId),
              method: message.method || null,
              threadId: message.params?.threadId || null,
              turnId: message.params?.expectedTurnId || null,
              clientId: message.params?.clientUserMessageId || null,
            };
            rpcRequests.push(record);
            if (message.method === "turn/steer") steerRequests.push(record);
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        const closeClient = () => {
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close(1012, "Diagnostic upstream changed");
          }
        };
        upstream.once("close", closeClient);
        upstream.once("error", closeClient);
        client.once("close", () => {
          clients.delete(client);
          upstream.off("message", forwardUpstream);
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.close();
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
    steerRequests,
    droppedSteerResults,
    forwardedSteerResults,
    forwardedSteerErrors,
    rpcRequests,
    bridgeStatuses,
    waitForFirstResultDrop: () => firstDrop,
    async close() {
      for (const client of clients) client.terminate();
      for (const upstream of upstreams) upstream.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function forwardedWebSocketHeaders(headers) {
  const forwarded = {};
  for (const name of ["authorization", "cookie", "origin", "user-agent", "x-forwarded-for", "x-forwarded-proto"]) {
    if (headers[name] !== undefined) forwarded[name] = headers[name];
  }
  if (headers.host) forwarded.host = headers.host;
  return forwarded;
}

function uniqueReadyEpochs(statuses) {
  return [...new Set(
    statuses
      .filter((entry) => entry.status === "ready" && entry.runtimeEpoch)
      .map((entry) => entry.runtimeEpoch),
  )];
}

function parseNdjson(source) {
  return source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForCodexConnection(page) {
  await page.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex 已连接");
}

function reserveDistinctPorts(count) {
  return Promise.all(Array.from({ length: count }, () => getFreePort()))
    .then((ports) => new Set(ports).size === count ? ports : reserveDistinctPorts(count));
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

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Backend did not start: ${output}`)), PROBE_TIMEOUT_MS);
    const collect = (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      child.stdout.off("data", collect);
      child.stderr.off("data", collect);
      resolve();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited early (${code}): ${output}`));
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

async function waitFor(predicate, message, timeoutMs = PROBE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
