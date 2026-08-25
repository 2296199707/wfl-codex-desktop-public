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
const FIXED_THREAD_ID = "thread_smoke_001";
const PROMPT = "diagnose turn delivery unknown";
const scenarios = [
  {
    name: "same-epoch-memory-dedup",
    restartBackend: false,
    persistedHistoryVisible: false,
    expectedAppServerStarts: 1,
  },
  {
    name: "cross-epoch-history-visible",
    restartBackend: true,
    persistedHistoryVisible: true,
    expectedAppServerStarts: 1,
  },
  {
    name: "cross-epoch-history-not-visible",
    restartBackend: true,
    persistedHistoryVisible: false,
    expectedAppServerStarts: 2,
  },
  {
    name: "rpc-error-after-accept-and-epoch-change",
    restartBackend: true,
    persistedHistoryVisible: false,
    replaceResultWithRpcError: true,
    manualResubmit: true,
    expectedAppServerStarts: 2,
    expectedSameClientSubmissionId: false,
  },
  {
    name: "page-reload-after-delivery-unknown",
    restartBackend: false,
    persistedHistoryVisible: false,
    reloadAfterDrop: true,
    expectedBrowserTurnStarts: 1,
    expectedAppServerStarts: 1,
    expectForwardedRetryResult: false,
  },
];

let browser = null;
let rootDirectory = null;
const liveChildren = new Set();
const liveProxies = new Set();

try {
  rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-turn-delivery-unknown-"));
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  assert.equal(results[0].sameRuntimeEpoch, true);
  assert.equal(results[1].runtimeEpochChanged, true);
  assert.equal(results[2].runtimeEpochChanged, true);
  assert.equal(results[0].appServerTurnStartCount, 1);
  assert.equal(results[1].appServerTurnStartCount, 1);
  assert.equal(results[2].appServerTurnStartCount, 2);
  assert.equal(results[3].runtimeEpochChanged, true);
  assert.equal(results[3].appServerTurnStartCount, 2);
  assert.equal(results[3].sameClientSubmissionId, false);
  assert.equal(results[4].browserTurnStartCount, 1);
  assert.equal(results[4].promptRestoredAfterReload, false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "isolated-browser-random-port-write-after-fault-proxy",
      appServer: "fake-codex-app-server",
      productionRequests: 0,
      frozenRescuePortTouched: false,
      formalChecksModified: false,
      capturedContent: false,
    },
    scenarios: results,
    classification: {
      deliveryUnknownRetryPreservesClientSubmissionId: true,
      sameProcessSafetySource: "in-memory-deduplicator",
      crossProcessSafetySourceWhenVisible: "thread/read full-history scan",
      durableSubmissionLedgerPresent: false,
      writeAcceptedButHistoryNotVisibleDuplicatesUpstreamTurnStart: true,
      ordinaryRpcErrorAfterAcceptClearsPending: true,
      manualResubmitAfterOrdinaryRpcErrorCreatesNewSubmission: true,
      pageReloadDropsInMemoryPendingSubmission: true,
      pageReloadRestoresFrozenInput: false,
      deliveryUnknownIsCurrentlyDecidable: false,
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
  const scenarioDirectory = path.join(rootDirectory, scenario.name);
  const projectRoot = path.join(scenarioDirectory, "projects");
  const defaultProject = path.join(projectRoot, "delivery-project");
  const stateDirectory = path.join(scenarioDirectory, "state");
  const fakeBin = path.join(scenarioDirectory, "bin");
  const homeDirectory = path.join(scenarioDirectory, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const runtimeDirectory = path.join(scenarioDirectory, "runtime");
  const appServerTraceFile = path.join(scenarioDirectory, "app-server-trace.ndjson");
  const persistedTurnFile = path.join(scenarioDirectory, "persisted-turns.json");

  await fs.mkdir(scenarioDirectory, { recursive: true });
  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.writeFile(appServerTraceFile, "", { mode: 0o600 }),
    fs.writeFile(persistedTurnFile, "[]\n", { mode: 0o600 }),
  ]);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "Delivery-unknown diagnostic provider",
    baseUrl: "https://delivery-unknown.example.test/v1",
    model: "gpt-smoke",
    apiKey: "delivery-unknown-diagnostic-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const [backendPort, proxyPort] = await reserveDistinctPorts(2);
  assert.notEqual(backendPort, 4321, "diagnostic backend port must exclude frozen rescue port 4321");
  assert.notEqual(proxyPort, 4321, "diagnostic proxy port must exclude frozen rescue port 4321");
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
    CODEX_DESKTOP_AUTH_FILE: path.join(scenarioDirectory, "missing-auth.json"),
    CODEX_DESKTOP_STATE_DIR: stateDirectory,
    CODEX_DESKTOP_SOURCE_DIR: defaultProject,
    CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
    CODEX_DESKTOP_MULTI_USER_ROOT: path.join(scenarioDirectory, "users"),
    CODEX_DESKTOP_RELEASE_DISABLED: "1",
    CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
    CODEX_DESKTOP_CLAUDE_BIN: "/bin/false",
    FAKE_CODEX_PROJECT: defaultProject,
    FAKE_CODEX_DIAGNOSTIC_TRACE_FILE: appServerTraceFile,
    FAKE_CODEX_DIAGNOSTIC_TRACE_ID: traceId,
    FAKE_CODEX_DIAGNOSTIC_TURN_STATE_FILE: persistedTurnFile,
    NODE_ENV: "test",
  };

  let backend = await startBackend(commonEnvironment, "boot1", false, backendBaseUrl);
  let restartPromise = null;
  const proxy = await createFaultProxy({
    listenPort: proxyPort,
    upstreamPort: backendPort,
    replaceFirstTurnResultWithRpcError: scenario.replaceResultWithRpcError === true,
    onFirstTurnResultDropped: () => {
      if (!scenario.restartBackend || restartPromise) return;
      restartPromise = (async () => {
        await stopProcess(backend);
        backend = await startBackend(
          commonEnvironment,
          "boot2",
          scenario.persistedHistoryVisible,
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

    await page.locator("#promptInput").fill(PROMPT);
    await page.locator("#sendButton").click();
    await proxy.waitForFirstTurnResultDrop();
    let promptRestoredAfterReload = null;
    if (scenario.reloadAfterDrop) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForCodexConnection(page);
      await delay(2_500);
      promptRestoredAfterReload = await page.locator("#promptInput").inputValue() === PROMPT;
    }
    if (scenario.restartBackend) {
      await waitFor(() => Boolean(restartPromise), "backend restart was not scheduled");
      await restartPromise;
    }
    if (scenario.manualResubmit) {
      await waitFor(
        () => proxy.injectedTurnErrors.length === 1,
        `${scenario.name} did not inject the ordinary RPC error`,
      );
      await waitFor(
        () => new Set(
          proxy.bridgeStatuses
            .filter((entry) => entry.status === "ready" && entry.runtimeEpoch)
            .map((entry) => entry.runtimeEpoch),
        ).size >= 2,
        `${scenario.name} did not reconnect to a new runtime Epoch`,
      );
      await waitForCodexConnection(page);
      await page.waitForFunction((expectedPrompt) => (
        document.getElementById("promptInput")?.value === expectedPrompt
        && !document.getElementById("sendButton")?.disabled
      ), PROMPT);
      await page.locator("#sendButton").click();
    }
    const expectedBrowserTurnStarts = scenario.expectedBrowserTurnStarts || 2;
    if (scenario.expectForwardedRetryResult === false) {
      assert.equal(proxy.turnRequests.length, expectedBrowserTurnStarts);
      assert.equal(proxy.forwardedTurnResults.length, 0);
    } else {
      await waitFor(
        () => (
          proxy.turnRequests.length >= expectedBrowserTurnStarts
          && proxy.forwardedTurnResults.length >= 1
        ),
        `${scenario.name} did not retry and receive the turn/start result`,
      );
    }

    const requests = proxy.turnRequests.slice(0, expectedBrowserTurnStarts);
    const clientSubmissionIds = requests.map((entry) => entry.clientSubmissionId);
    const clientSubmissionIdSet = new Set(clientSubmissionIds);
    const appServerTrace = await readNdjson(appServerTraceFile);
    const [traceSource, persistedTurnSource] = await Promise.all([
      fs.readFile(appServerTraceFile, "utf8"),
      fs.readFile(persistedTurnFile, "utf8"),
    ]);
    assert.equal(traceSource.includes(PROMPT), false);
    assert.equal(persistedTurnSource.includes(PROMPT), false);
    const appServerStarts = appServerTrace.filter((entry) => (
      entry.direction === "in"
      && entry.method === "turn/start"
      && clientSubmissionIdSet.has(entry.clientId)
    ));
    const appServerThreadReads = appServerTrace.filter((entry) => (
      entry.direction === "in" && entry.method === "thread/read"
    ));
    const runtimeEpochs = [...new Set(
      proxy.bridgeStatuses
        .filter((entry) => entry.status === "ready" && entry.runtimeEpoch)
        .map((entry) => entry.runtimeEpoch),
    )];
    const responseTurnIds = [
      proxy.droppedTurnResults[0]?.turnId || null,
      proxy.forwardedTurnResults.at(-1)?.turnId || null,
    ];

    assert.equal(requests.length, expectedBrowserTurnStarts);
    assert.equal(requests.every((entry) => entry.threadId === FIXED_THREAD_ID), true);
    const sameClientSubmissionId = clientSubmissionIdSet.size === 1;
    assert.equal(
      sameClientSubmissionId,
      scenario.expectedSameClientSubmissionId !== false,
    );
    assert.equal(appServerStarts.length, scenario.expectedAppServerStarts);
    assert.equal(proxy.droppedTurnResults.length, 1);
    assert.equal(
      proxy.forwardedTurnResults.length >= 1,
      scenario.expectForwardedRetryResult !== false,
    );
    assert.equal(pageErrors.length, 0);
    if (scenario.restartBackend) {
      assert.equal(runtimeEpochs.length >= 2, true);
    } else {
      assert.equal(runtimeEpochs.length, 1);
    }
    if (scenario.expectedAppServerStarts === 1 && scenario.expectForwardedRetryResult !== false) {
      assert.equal(responseTurnIds[0], responseTurnIds[1]);
    } else if (scenario.expectedAppServerStarts > 1) {
      assert.notEqual(responseTurnIds[0], responseTurnIds[1]);
    }

    return {
      name: scenario.name,
      backendRestarted: scenario.restartBackend,
      persistedHistoryVisibleAfterRestart: scenario.persistedHistoryVisible,
      browserTurnStartCount: requests.length,
      sameClientSubmissionId,
      appServerTurnStartCount: appServerStarts.length,
      appServerThreadReadCount: appServerThreadReads.length,
      responseTurnIds,
      readyRuntimeEpochCount: runtimeEpochs.length,
      sameRuntimeEpoch: runtimeEpochs.length === 1,
      runtimeEpochChanged: runtimeEpochs.length >= 2,
      firstResultDroppedAfterExecution: proxy.droppedTurnResults.length === 1,
      ordinaryRpcErrorInjectedAfterExecution: proxy.injectedTurnErrors.length === 1,
      manualResubmit: scenario.manualResubmit === true,
      pageReloadedBeforeRetry: scenario.reloadAfterDrop === true,
      promptRestoredAfterReload,
      secondResultForwarded: proxy.forwardedTurnResults.length >= 1,
      duplicateAppServerExecution: appServerStarts.length > 1,
      currentSafetyMechanism: scenario.reloadAfterDrop
        ? "page-memory-lost"
        : scenario.replaceResultWithRpcError
          ? "ordinary-error-clears-pending"
          : scenario.restartBackend
            ? scenario.persistedHistoryVisible ? "history-scan" : "none"
            : "memory-cache",
    };
  } finally {
    await context.close().catch(() => {});
    await proxy.close().catch(() => {});
    liveProxies.delete(proxy);
    await stopProcess(backend).catch(() => {});
  }
}

async function startBackend(commonEnvironment, bootId, historyVisible, baseUrl) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...commonEnvironment,
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

async function createFaultProxy({
  listenPort,
  upstreamPort,
  replaceFirstTurnResultWithRpcError,
  onFirstTurnResultDropped,
}) {
  const turnRequests = [];
  const bridgeStatuses = [];
  const droppedTurnResults = [];
  const forwardedTurnResults = [];
  const injectedTurnErrors = [];
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
        const socketId = `fault-ws-${++socketCounter}`;
        clients.add(client);
        upstream.off("message", bufferMessage);
        const methodsByRequestId = new Map();

        const forwardUpstream = (data, isBinary) => {
          let message = null;
          try {
            message = JSON.parse(data.toString());
          } catch {
            // The main conversation channel is JSON, but opaque frames still pass through.
          }
          if (message?.type === "bridge/status") {
            bridgeStatuses.push({
              socketId,
              status: message.payload?.status || null,
              runtimeEpoch: message.payload?.runtimeEpoch || null,
              eventSequence: Number.isSafeInteger(message.payload?.eventSequence)
                ? message.payload.eventSequence
                : null,
            });
          }
          const requestMethod = message?.requestId == null
            ? null
            : methodsByRequestId.get(String(message.requestId)) || null;
          if (
            faultArmed
            && requestMethod === "turn/start"
            && message?.type === "rpc/result"
          ) {
            faultArmed = false;
            const record = {
              socketId,
              requestId: String(message.requestId),
              turnId: message.result?.turn?.id || null,
            };
            droppedTurnResults.push(record);
            onFirstTurnResultDropped();
            firstDropResolve(record);
            if (replaceFirstTurnResultWithRpcError && client.readyState === WebSocket.OPEN) {
              const error = {
                socketId,
                requestId: String(message.requestId),
                messageClass: "ordinary-rpc-error",
              };
              injectedTurnErrors.push(error);
              client.send(JSON.stringify({
                type: "rpc/error",
                requestId: message.requestId,
                message: "服务正在更新，请稍后重试",
              }));
            }
            setTimeout(() => client.terminate(), replaceFirstTurnResultWithRpcError ? 25 : 0);
            if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "Injected result loss");
            return;
          }
          if (requestMethod === "turn/start" && message?.type === "rpc/result") {
            forwardedTurnResults.push({
              socketId,
              requestId: String(message.requestId),
              turnId: message.result?.turn?.id || null,
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
            if (message.method === "turn/start") {
              turnRequests.push({
                socketId,
                requestId: String(message.requestId),
                threadId: message.params?.threadId || null,
                clientSubmissionId: message.params?.clientUserMessageId || null,
              });
            }
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
    turnRequests,
    bridgeStatuses,
    droppedTurnResults,
    forwardedTurnResults,
    injectedTurnErrors,
    waitForFirstTurnResultDrop: () => firstDrop,
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

async function waitForCodexConnection(page) {
  await page.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex 已连接");
}

function reserveDistinctPorts(count) {
  return Promise.all(Array.from({ length: count }, () => getFreePort()))
    .then(async (ports) => {
      if (new Set(ports).size === count) return ports;
      return reserveDistinctPorts(count);
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

async function waitFor(predicate, errorMessage, timeoutMs = PROBE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(errorMessage);
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

async function readNdjson(file) {
  const source = await fs.readFile(file, "utf8");
  return source
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
