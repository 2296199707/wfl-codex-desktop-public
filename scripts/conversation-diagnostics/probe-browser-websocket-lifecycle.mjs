import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const FROZEN_HEARTBEAT_PERIODS = 3.8;

let browser = null;
let context = null;
let cdp = null;
let directory = null;
let gateway = null;
const backends = [];

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-browser-ws-lifecycle-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "smoke-project");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const runtimeDirectory = path.join(directory, "runtime");
  const activePortFile = path.join(runtimeDirectory, "active-port");
  const unusedChannelPortFile = path.join(runtimeDirectory, "diagnostic-unused-port");

  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
  ]);

  const [
    backendPortA,
    backendPortB,
    gatewayPort,
    unusedChannelPortA,
    unusedChannelPortB,
  ] = await reserveDistinctPorts(5);
  for (const port of [
    backendPortA,
    backendPortB,
    gatewayPort,
    unusedChannelPortA,
    unusedChannelPortB,
  ]) {
    assert.notEqual(port, 4321, "diagnostic lifecycle ports must exclude frozen rescue port 4321");
  }
  await Promise.all([
    writeSelectedPort(activePortFile, backendPortA),
    writeSelectedPort(unusedChannelPortFile, unusedChannelPortA),
  ]);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "Browser lifecycle probe provider",
    baseUrl: "https://lifecycle-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "browser-lifecycle-probe-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const commonBackendEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: homeDirectory,
    HOST: "127.0.0.1",
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
  };
  for (const port of [backendPortA, backendPortB]) {
    const child = spawnProcess("server.mjs", {
      ...commonBackendEnvironment,
      PORT: String(port),
    });
    backends.push(child);
    await waitForOutput(child, "WFL Codex Desktop v");
    await waitForDeepReady(`http://127.0.0.1:${port}`);
  }

  const gatewayEnvironment = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(gatewayPort),
    CODEX_DESKTOP_UPSTREAM_HOST: "127.0.0.1",
    CODEX_DESKTOP_UPSTREAM_PORTS: `${backendPortA},${backendPortB}`,
    CODEX_DESKTOP_UPSTREAM_PORT: String(backendPortA),
    CODEX_DESKTOP_ACTIVE_PORT_FILE: activePortFile,
    CODEX_DESKTOP_RESCUE_PORTS: `${unusedChannelPortA},${unusedChannelPortB}`,
    CODEX_DESKTOP_RESCUE_PORT: String(unusedChannelPortA),
    CODEX_DESKTOP_RESCUE_ACTIVE_PORT_FILE: unusedChannelPortFile,
    CODEX_DESKTOP_HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
    CODEX_DESKTOP_KEEP_ALIVE_TIMEOUT_MS: "10000",
  };
  gateway = spawnProcess("gateway.mjs", gatewayEnvironment);
  await waitForOutput(gateway, "WFL Codex Gateway:");
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  await waitForGatewayReady(gatewayBaseUrl, backendPortA);

  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(initializeLifecycleRecorder);
  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(gatewayBaseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  const firstSocket = await currentOpenSocket(page);
  assert.ok(firstSocket);

  const initialThreadRow = page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).first();
  await initialThreadRow.waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  const initialRecoveryStartedAt = Date.now();
  await initialThreadRow.evaluate((node) => node.click());
  await waitForLifecycleEvent(page, {
    type: "rpc/result",
    rpcMethod: "thread/resume",
    minAtUnixMs: initialRecoveryStartedAt,
  });
  await page.locator("#messageList").getByText(
    "The authoritative conversation was restored.",
    { exact: true },
  ).waitFor();
  const initialRecoveryCompletedAt = Date.now();

  const slotSwitchStartedAt = Date.now();
  await writeSelectedPort(activePortFile, backendPortB);
  await waitForLifecycleEvent(page, {
    type: "bridge/status",
    status: "starting",
    minAtUnixMs: slotSwitchStartedAt,
  });
  await waitForLifecycleEvent(page, {
    type: "bridge/status",
    status: "ready",
    minAtUnixMs: slotSwitchStartedAt,
  });
  await waitForGatewayReady(gatewayBaseUrl, backendPortB);
  await waitForLifecycleEvent(page, {
    type: "rpc/result",
    rpcMethod: "thread/resume",
    minAtUnixMs: slotSwitchStartedAt,
  });
  const afterSwitchSocket = await currentOpenSocket(page);
  assert.equal(afterSwitchSocket.id, firstSocket.id);
  assert.equal(
    await lifecycleEventCount(page, {
      type: "ws/close",
      socketId: firstSocket.id,
      minAtUnixMs: slotSwitchStartedAt,
    }),
    0,
  );
  const slotSwitchCompletedAt = Date.now();

  cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const freezeStartedAt = Date.now();
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await delay(Math.round(HEARTBEAT_INTERVAL_MS * FROZEN_HEARTBEAT_PERIODS));
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await waitForCodexConnection(page);
  const afterFreezeSocket = await currentOpenSocket(page);
  assert.equal(afterFreezeSocket.id, firstSocket.id);
  assert.equal(
    await lifecycleEventCount(page, {
      type: "ws/close",
      socketId: firstSocket.id,
      minAtUnixMs: freezeStartedAt,
    }),
    0,
  );
  const freezeCompletedAt = Date.now();

  const offlineStartedAt = Date.now();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
  const offlineEvent = await waitForLifecycleEvent(page, {
    type: "browser/offline",
    minAtUnixMs: offlineStartedAt,
  });
  await delay(250);
  const offlineCloseBeforeOnline = await findLifecycleEvent(page, {
    type: "ws/close",
    socketId: firstSocket.id,
    minAtUnixMs: offlineStartedAt,
  });
  const offlineSocketReadyState = await socketReadyState(page, firstSocket.id);

  const onlineStartedAt = Date.now();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "wifi",
  });
  const onlineEvent = await waitForLifecycleEvent(page, {
    type: "browser/online",
    minAtUnixMs: onlineStartedAt,
  });
  const afterOnlineSocket = await waitForNewOpenSocket(page, firstSocket.id);
  await waitForCodexConnection(page);
  const openSocketIdsAfterOnline = await openSocketIds(page);
  const offlineClose = offlineCloseBeforeOnline || await waitForOptionalLifecycleEvent(page, {
    type: "ws/close",
    socketId: firstSocket.id,
    minAtUnixMs: offlineStartedAt,
  }, 2_000);
  await delay(500);
  const onlineRecoveryCompletedAt = Date.now();

  const gatewayRestartStartedAt = Date.now();
  await stopProcess(gateway);
  gateway = null;
  const gatewayRestartClose = await waitForLifecycleEvent(page, {
    type: "ws/close",
    socketId: afterOnlineSocket.id,
    minAtUnixMs: gatewayRestartStartedAt,
  });
  assert.equal(gatewayRestartClose.code, 1012);
  assert.equal(gatewayRestartClose.reason, "Gateway restarting");

  gateway = spawnProcess("gateway.mjs", gatewayEnvironment);
  await waitForOutput(gateway, "WFL Codex Gateway:");
  await waitForGatewayReady(gatewayBaseUrl, backendPortB);
  const afterGatewayRestartSocket = await waitForNewOpenSocket(page, afterOnlineSocket.id);
  await waitForCodexConnection(page);
  await delay(500);
  const gatewayRestartCompletedAt = Date.now();

  const sameEpochGapStartedAt = Date.now();
  await stopProcess(gateway);
  gateway = null;
  const sameEpochGapClose = await waitForLifecycleEvent(page, {
    type: "ws/close",
    socketId: afterGatewayRestartSocket.id,
    minAtUnixMs: sameEpochGapStartedAt,
  });
  assert.equal(sameEpochGapClose.code, 1012);
  const injectedGap = await emitUnrelatedTurn(
    `http://127.0.0.1:${backendPortB}`,
    defaultProject,
  );

  gateway = spawnProcess("gateway.mjs", gatewayEnvironment);
  await waitForOutput(gateway, "WFL Codex Gateway:");
  await waitForGatewayReady(gatewayBaseUrl, backendPortB);
  const afterSameEpochGapSocket = await waitForNewOpenSocket(page, afterGatewayRestartSocket.id);
  await waitForLifecycleEvent(page, {
    type: "rpc/result",
    rpcMethod: "thread/turns/list",
    minAtUnixMs: sameEpochGapStartedAt,
  });
  await waitForCodexConnection(page);
  await delay(300);
  const sameEpochGapCompletedAt = Date.now();

  const errorPathStartedAt = Date.now();
  await page.evaluate(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    globalThis.__wflLifecycleErrorSocket = new WebSocket(
      `${protocol}//${location.host}/wfl-lifecycle-error-probe`,
    );
  });
  const diagnosticSocketError = await waitForLifecycleEvent(page, {
    type: "ws/error",
    socketRole: "diagnostic-error",
    minAtUnixMs: errorPathStartedAt,
  });
  const diagnosticSocketClose = await waitForLifecycleEvent(page, {
    type: "ws/close",
    socketRole: "diagnostic-error",
    minAtUnixMs: errorPathStartedAt,
  });
  assert.equal(diagnosticSocketClose.code, 1006);
  assert.equal(diagnosticSocketClose.reason, "");
  assert.equal(diagnosticSocketClose.wasClean, false);

  const events = await page.evaluate(() => structuredClone(window.__wflLifecycleProbe.events));
  const documentLifecycle = await page.evaluate(() => ({
    documentId: window.__wflLifecycleProbe.documentId,
    initializedEvents: window.__wflLifecycleProbe.events.filter(
      (entry) => entry.type === "browser/initialized",
    ).length,
    navigationEntries: performance.getEntriesByType("navigation").map((entry) => ({
      type: entry.type,
      startTime: entry.startTime,
      duration: entry.duration,
    })),
    location: location.href,
  }));

  const cachedReloadStorage = await page.evaluate(() => ({
    sessionKeys: Object.keys(sessionStorage),
    recoveryPresent: Boolean(localStorage.getItem("codexDesktop.activeThread")),
  }));
  assert.ok(cachedReloadStorage.sessionKeys.length > 0, "active thread must have a session cache before reload");
  assert.equal(cachedReloadStorage.recoveryPresent, true, "active thread must have a durable recovery pointer");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await delay(300);
  const cachedReloadEvents = await page.evaluate(() => structuredClone(window.__wflLifecycleProbe.events));
  const cachedReloadRecoveryToasts = recoveryToastEvents(cachedReloadEvents);
  const cachedReloadResumeRequests = rpcRequestEvents(cachedReloadEvents, "thread/resume");
  assert.equal(
    cachedReloadRecoveryToasts.length,
    0,
    "a reload with a valid active-thread snapshot must not claim it restored a missing conversation",
  );
  assert.equal(cachedReloadResumeRequests.length, 1);

  const recoveryPointerOnlyPage = await context.newPage();
  recoveryPointerOnlyPage.setDefaultTimeout(PROBE_TIMEOUT_MS);
  recoveryPointerOnlyPage.on("pageerror", (error) => pageErrors.push(error.message));
  await recoveryPointerOnlyPage.goto(gatewayBaseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(recoveryPointerOnlyPage);
  await recoveryPointerOnlyPage.locator(".toast", { hasText: "已恢复上次对话" }).waitFor();
  await recoveryPointerOnlyPage.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  const recoveryPointerOnlyEvents = await recoveryPointerOnlyPage.evaluate(
    () => structuredClone(window.__wflLifecycleProbe.events),
  );
  const recoveryPointerOnlyToasts = recoveryToastEvents(recoveryPointerOnlyEvents);
  const recoveryPointerOnlyResumeRequests = rpcRequestEvents(
    recoveryPointerOnlyEvents,
    "thread/resume",
  );
  assert.equal(recoveryPointerOnlyToasts.length, 1);
  assert.equal(recoveryPointerOnlyResumeRequests.length, 1);
  await recoveryPointerOnlyPage.close();
  assert.notEqual(initializedDocumentId(cachedReloadEvents), documentLifecycle.documentId);
  assert.notEqual(
    initializedDocumentId(recoveryPointerOnlyEvents),
    initializedDocumentId(cachedReloadEvents),
  );
  assert.equal(pageErrors.length, 1);
  assert.match(pageErrors[0], /close code must be either 1000.*1001/i);

  const sockets = summarizeSockets(events);
  const browserFieldCoverage = summarizeBrowserFieldCoverage(events, sockets);
  assert.equal(browserFieldCoverage.targetMet, true);
  const visibilityEvents = events.filter((entry) => entry.type === "browser/visibility");
  const readyBeforeSwitch = events.filter((entry) => (
    entry.type === "bridge/status"
    && entry.status === "ready"
    && entry.atUnixMs < slotSwitchStartedAt
  )).at(-1);
  const readyAfterSwitch = events.find((entry) => (
    entry.type === "bridge/status"
    && entry.status === "ready"
    && entry.atUnixMs >= slotSwitchStartedAt
  ));
  const result = {
    ok: true,
    environment: {
      transport: "isolated-chromium-random-port-gateway-two-main-backends",
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      productionRequests: 0,
      frozenRescuePortTouched: false,
      unusedChannelRequests: 0,
    },
    slotSwitch: {
      fromPort: backendPortA,
      toPort: backendPortB,
      browserSocketIdBefore: firstSocket.id,
      browserSocketIdAfter: afterSwitchSocket.id,
      startingObserved: true,
      readyObserved: true,
      runtimeEpochBefore: readyBeforeSwitch?.runtimeEpoch || null,
      runtimeEpochAfter: readyAfterSwitch?.runtimeEpoch || null,
      runtimeEpochChanged: Boolean(
        readyBeforeSwitch?.runtimeEpoch
        && readyAfterSwitch?.runtimeEpoch
        && readyBeforeSwitch.runtimeEpoch !== readyAfterSwitch.runtimeEpoch
      ),
      browserSocketClosed: false,
      targetMet: true,
    },
    frozenDocument: {
      heartbeatPeriods: FROZEN_HEARTBEAT_PERIODS,
      durationMs: Math.round(HEARTBEAT_INTERVAL_MS * FROZEN_HEARTBEAT_PERIODS),
      visibilityEvents,
      browserSocketIdBefore: firstSocket.id,
      browserSocketIdAfter: afterFreezeSocket.id,
      browserSocketClosed: false,
      targetMet: true,
    },
    offlineOnline: {
      offlineEvent,
      oldSocketReadyStateBeforeOnline: offlineSocketReadyState,
      closeObservedBeforeOnline: Boolean(offlineCloseBeforeOnline),
      close: offlineClose,
      onlineEvent,
      reconnectedSocketId: afterOnlineSocket.id,
      openSocketIdsAfterOnline,
      staleSocketStillOpenAfterOnline: openSocketIdsAfterOnline.includes(firstSocket.id),
      targetMet:
        offlineClose?.code === 1001
        && offlineClose?.reason === "Browser offline"
        && afterOnlineSocket.id !== firstSocket.id
        && !openSocketIdsAfterOnline.includes(firstSocket.id),
    },
    gatewayRestart: {
      close: gatewayRestartClose,
      reconnectedSocketId: afterGatewayRestartSocket.id,
      targetMet:
        gatewayRestartClose.code === 1012
        && afterGatewayRestartSocket.id !== afterOnlineSocket.id,
    },
    sameEpochSequenceAdvance: {
      close: sameEpochGapClose,
      reconnectedSocketId: afterSameEpochGapSocket.id,
      injectedGap,
      targetMet:
        sameEpochGapClose.code === 1012
        && afterSameEpochGapSocket.id !== afterGatewayRestartSocket.id,
    },
    diagnosticErrorPath: {
      error: diagnosticSocketError,
      close: diagnosticSocketClose,
      targetMet:
        diagnosticSocketError.socketId === diagnosticSocketClose.socketId
        && diagnosticSocketClose.code === 1006
        && diagnosticSocketClose.wasClean === false,
    },
    browserFieldCoverage,
    recoveryClassification: {
      initialThreadSelection: summarizeRecoveryPhase(
        events,
        initialRecoveryStartedAt,
        initialRecoveryCompletedAt,
      ),
      backendSlotSwitch: summarizeRecoveryPhase(
        events,
        slotSwitchStartedAt,
        slotSwitchCompletedAt,
      ),
      frozenDocument: summarizeRecoveryPhase(
        events,
        freezeStartedAt,
        freezeCompletedAt,
      ),
      offlineOnline: summarizeRecoveryPhase(
        events,
        offlineStartedAt,
        onlineRecoveryCompletedAt,
      ),
      gatewayRestart: summarizeRecoveryPhase(
        events,
        gatewayRestartStartedAt,
        gatewayRestartCompletedAt,
      ),
      sameEpochSequenceAdvance: summarizeRecoveryPhase(
        events,
        sameEpochGapStartedAt,
        sameEpochGapCompletedAt,
      ),
      cachedDocumentReload: {
        sessionKeysBeforeReload: cachedReloadStorage.sessionKeys,
        resumeRequests: cachedReloadResumeRequests.length,
        recoveryToasts: cachedReloadRecoveryToasts.length,
        documentId: initializedDocumentId(cachedReloadEvents),
        targetMet:
          cachedReloadResumeRequests.length === 1
          && cachedReloadRecoveryToasts.length === 0,
      },
      recoveryPointerOnlyReload: {
        newDocument: true,
        sessionKeysAtInitialization:
          initializedDocumentEvent(recoveryPointerOnlyEvents)?.sessionStorageKeys || [],
        recoveryPointerPresent:
          initializedDocumentEvent(recoveryPointerOnlyEvents)?.recoveryPointerPresent === true,
        resumeRequests: recoveryPointerOnlyResumeRequests.length,
        recoveryToasts: recoveryPointerOnlyToasts.map((entry) => entry.text),
        documentId: initializedDocumentId(recoveryPointerOnlyEvents),
        targetMet:
          initializedDocumentEvent(recoveryPointerOnlyEvents)?.sessionStorageKeys?.length === 0
          && initializedDocumentEvent(recoveryPointerOnlyEvents)?.recoveryPointerPresent === true
          && recoveryPointerOnlyResumeRequests.length === 1
          && recoveryPointerOnlyToasts.length === 1,
      },
    },
    documentLifecycle,
    pageErrors,
    sockets,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (cdp) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    }).catch(() => {});
    await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (gateway) await stopProcess(gateway).catch(() => {});
  await Promise.all(backends.map((child) => stopProcess(child).catch(() => {})));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

function initializeLifecycleRecorder() {
  const NativeWebSocket = window.WebSocket;
  const state = {
    documentId: crypto.randomUUID(),
    events: [],
    sockets: new Map(),
    socketRoles: new Map(),
    requests: new Map(),
    nextSocketId: 1,
  };
  const snapshot = (type, fields = {}) => {
    state.events.push({
      type,
      atMonoMs: Number(performance.now().toFixed(3)),
      atUnixMs: Date.now(),
      visibility: document.visibilityState,
      online: navigator.onLine,
      ...fields,
    });
  };
  function TrackingWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    const socketId = `browser-ws-${state.nextSocketId++}`;
    const requestedUrl = String(args[0] || "");
    let pathname = "";
    try {
      pathname = new URL(requestedUrl, location.href).pathname;
    } catch {
      // The native constructor reports malformed URLs.
    }
    const socketRole = pathname === "/ws"
      ? "application"
      : pathname === "/wfl-lifecycle-error-probe"
        ? "diagnostic-error"
        : "other";
    state.sockets.set(socketId, socket);
    state.socketRoles.set(socketId, socketRole);
    snapshot("ws/created", { socketId, socketRole });
    const nativeSend = socket.send.bind(socket);
    socket.send = (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message?.type === "rpc") {
          const requestId = String(message.requestId);
          state.requests.set(`${socketId}:${requestId}`, message.method || null);
          snapshot("rpc/request", {
            socketId,
            socketRole,
            requestId,
            rpcMethod: message.method || null,
            threadId: message.params?.threadId || null,
          });
        } else if (message?.type === "client/state") {
          snapshot("client/state", {
            socketId,
            socketRole,
            threadId: message.threadId || null,
            runtimeEpoch: message.codexRuntimeEpoch || null,
            eventSequence: Number.isSafeInteger(message.codexEventSequence)
              ? message.codexEventSequence
              : null,
          });
        }
      } catch {
        // Only protocol metadata is recorded.
      }
      return nativeSend(data);
    };
    socket.addEventListener("open", () => {
      snapshot("ws/open", { socketId, socketRole });
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "bridge/status") {
          snapshot("bridge/status", {
            socketId,
            socketRole,
            status: message.payload?.status || null,
            runtimeEpoch: message.payload?.runtimeEpoch || null,
            eventSequence: Number.isSafeInteger(message.payload?.eventSequence)
              ? message.payload.eventSequence
              : null,
          });
          return;
        }
        if (message?.type === "rpc/result" || message?.type === "rpc/error") {
          const requestId = String(message.requestId);
          const requestKey = `${socketId}:${requestId}`;
          snapshot(message.type, {
            socketId,
            socketRole,
            requestId,
            rpcMethod: state.requests.get(requestKey) || null,
          });
          state.requests.delete(requestKey);
        }
      } catch {
        // Only connection and RPC metadata are recorded.
      }
    });
    socket.addEventListener("error", () => {
      snapshot("ws/error", { socketId, socketRole });
    });
    socket.addEventListener("close", (event) => {
      snapshot("ws/close", {
        socketId,
        socketRole,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      state.sockets.delete(socketId);
      state.socketRoles.delete(socketId);
    });
    return socket;
  }
  TrackingWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(TrackingWebSocket, key, { value: NativeWebSocket[key] });
  }
  window.WebSocket = TrackingWebSocket;
  window.__wflLifecycleProbe = state;
  window.addEventListener("offline", () => snapshot("browser/offline"));
  window.addEventListener("online", () => snapshot("browser/online"));
  window.addEventListener("pagehide", (event) => snapshot("browser/pagehide", {
    persisted: event.persisted,
  }));
  window.addEventListener("pageshow", (event) => snapshot("browser/pageshow", {
    persisted: event.persisted,
  }));
  document.addEventListener("visibilitychange", () => snapshot("browser/visibility"));
  const installUiObservers = () => {
    const connectionText = document.getElementById("connectionText");
    if (connectionText) {
      const recordConnection = () => snapshot("ui/connection", {
        text: connectionText.textContent || "",
      });
      new MutationObserver(recordConnection).observe(connectionText, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      recordConnection();
    }
    const toastRegion = document.getElementById("toastRegion");
    if (toastRegion) {
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            const text = node.textContent?.trim();
            if (text) snapshot("ui/toast", { text });
          }
        }
      }).observe(toastRegion, { childList: true });
    }
    const messageList = document.getElementById("messageList");
    if (messageList) {
      new MutationObserver((mutations) => {
        snapshot("ui/messages-mutation", {
          mutationRecords: mutations.length,
          addedNodes: mutations.reduce((total, mutation) => total + mutation.addedNodes.length, 0),
          removedNodes: mutations.reduce((total, mutation) => total + mutation.removedNodes.length, 0),
          childElementCount: messageList.childElementCount,
        });
      }).observe(messageList, { childList: true });
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installUiObservers, { once: true });
  } else {
    installUiObservers();
  }
  let sessionStorageKeys = [];
  let recoveryPointerPresent = false;
  try {
    sessionStorageKeys = Object.keys(sessionStorage);
    recoveryPointerPresent = Boolean(localStorage.getItem("codexDesktop.activeThread"));
  } catch {
    // Sandboxed child frames do not expose same-origin storage.
  }
  snapshot("browser/initialized", {
    documentId: state.documentId,
    sessionStorageKeys,
    recoveryPointerPresent,
  });
}

async function emitUnrelatedTurn(baseUrl, cwd) {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Origin: baseUrl },
  });
  const observer = observeJsonSocket(socket);
  try {
    await waitForSocketOpen(socket);
    await observer.waitFor(
      (message) => message?.type === "bridge/status" && message.payload?.status === "ready",
      "direct diagnostic bridge ready",
    );
    const requestId = `sequence-gap-${randomUUID()}`;
    socket.send(JSON.stringify({
      type: "rpc",
      requestId,
      method: "turn/start",
      params: {
        threadId: "thread_smoke_parallel",
        clientUserMessageId: `sequence-gap-${randomUUID()}`,
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
    if (response.type === "rpc/error") {
      throw new Error(`Unable to inject same-epoch sequence gap: ${response.message}`);
    }
    const turnId = response.result?.turn?.id;
    assert.ok(turnId, "direct diagnostic turn/start must return a turn ID");
    await observer.waitFor(
      (message) => (
        message?.type === "codex/notification"
        && message.payload?.method === "turn/completed"
        && message.payload?.params?.threadId === "thread_smoke_parallel"
        && message.payload?.params?.turn?.id === turnId
      ),
      "direct diagnostic turn completion",
    );
    await observer.waitFor(
      (message) => (
        message?.type === "codex/notification"
        && message.payload?.method === "thread/status/changed"
        && message.payload?.params?.threadId === "thread_smoke_parallel"
        && message.payload?.params?.status?.type === "idle"
      ),
      "direct diagnostic thread idle",
    );
    const notifications = observer.messages.filter((message) => (
      message?.type === "codex/notification"
      && message.payload?.params?.threadId === "thread_smoke_parallel"
    ));
    return {
      threadId: "thread_smoke_parallel",
      turnId,
      notificationMethods: notifications.map((message) => message.payload.method),
      eventSequences: notifications
        .map((message) => message.eventSequence)
        .filter(Number.isSafeInteger),
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
    messages,
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

async function waitForSocketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out opening direct diagnostic WebSocket"));
    }, PROBE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

async function closeProbeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Diagnostic complete");
  else socket.terminate();
  await Promise.race([closed, delay(500)]);
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

async function currentOpenSocket(page) {
  return page.evaluate(() => {
    const entries = [...window.__wflLifecycleProbe.sockets.entries()].reverse();
    const match = entries.find(([socketId, socket]) => (
      window.__wflLifecycleProbe.socketRoles.get(socketId) === "application"
      && socket.readyState === WebSocket.OPEN
    ));
    return match ? { id: match[0], readyState: match[1].readyState } : null;
  });
}

async function openSocketIds(page) {
  return page.evaluate(() => (
    [...window.__wflLifecycleProbe.sockets.entries()]
      .filter(([socketId, socket]) => (
        window.__wflLifecycleProbe.socketRoles.get(socketId) === "application"
        && socket.readyState === WebSocket.OPEN
      ))
      .map(([socketId]) => socketId)
  ));
}

async function waitForNewOpenSocket(page, previousSocketId) {
  await page.waitForFunction((previousId) => (
    [...window.__wflLifecycleProbe.sockets.entries()].some(([socketId, socket]) => (
      socketId !== previousId
      && window.__wflLifecycleProbe.socketRoles.get(socketId) === "application"
      && socket.readyState === WebSocket.OPEN
    ))
  ), previousSocketId);
  const socket = await currentOpenSocket(page);
  assert.notEqual(socket?.id, previousSocketId);
  return socket;
}

async function socketReadyState(page, socketId) {
  return page.evaluate((id) => (
    window.__wflLifecycleProbe.sockets.get(id)?.readyState ?? WebSocket.CLOSED
  ), socketId);
}

async function waitForLifecycleEvent(page, matcher) {
  await page.waitForFunction((expected) => (
    window.__wflLifecycleProbe.events.some((entry) => (
      (!expected.type || entry.type === expected.type)
      && (!expected.status || entry.status === expected.status)
      && (!expected.socketId || entry.socketId === expected.socketId)
      && (!expected.socketRole || entry.socketRole === expected.socketRole)
      && (!expected.rpcMethod || entry.rpcMethod === expected.rpcMethod)
      && (!expected.minAtUnixMs || entry.atUnixMs >= expected.minAtUnixMs)
    ))
  ), matcher);
  return page.evaluate((expected) => structuredClone(
    window.__wflLifecycleProbe.events.find((entry) => (
      (!expected.type || entry.type === expected.type)
      && (!expected.status || entry.status === expected.status)
      && (!expected.socketId || entry.socketId === expected.socketId)
      && (!expected.socketRole || entry.socketRole === expected.socketRole)
      && (!expected.rpcMethod || entry.rpcMethod === expected.rpcMethod)
      && (!expected.minAtUnixMs || entry.atUnixMs >= expected.minAtUnixMs)
    )),
  ), matcher);
}

async function findLifecycleEvent(page, matcher) {
  return page.evaluate((expected) => {
    const entry = window.__wflLifecycleProbe.events.find((candidate) => (
      (!expected.type || candidate.type === expected.type)
      && (!expected.status || candidate.status === expected.status)
      && (!expected.socketId || candidate.socketId === expected.socketId)
      && (!expected.socketRole || candidate.socketRole === expected.socketRole)
      && (!expected.rpcMethod || candidate.rpcMethod === expected.rpcMethod)
      && (!expected.minAtUnixMs || candidate.atUnixMs >= expected.minAtUnixMs)
    ));
    return entry ? structuredClone(entry) : null;
  }, matcher);
}

async function waitForOptionalLifecycleEvent(page, matcher, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await findLifecycleEvent(page, matcher);
    if (entry) return entry;
    await delay(50);
  }
  return null;
}

function lifecycleEventCount(page, matcher) {
  return page.evaluate((expected) => (
    window.__wflLifecycleProbe.events.filter((entry) => (
      (!expected.type || entry.type === expected.type)
      && (!expected.status || entry.status === expected.status)
      && (!expected.socketId || entry.socketId === expected.socketId)
      && (!expected.socketRole || entry.socketRole === expected.socketRole)
      && (!expected.rpcMethod || entry.rpcMethod === expected.rpcMethod)
      && (!expected.minAtUnixMs || entry.atUnixMs >= expected.minAtUnixMs)
    )).length
  ), matcher);
}

function recoveryToastEvents(events) {
  return events.filter((entry) => (
    entry.type === "ui/toast"
    && entry.text === "已恢复上次对话"
  ));
}

function rpcRequestEvents(events, method) {
  return events.filter((entry) => (
    entry.type === "rpc/request"
    && entry.rpcMethod === method
  ));
}

function initializedDocumentId(events) {
  return initializedDocumentEvent(events)?.documentId || null;
}

function initializedDocumentEvent(events) {
  return events.find((entry) => entry.type === "browser/initialized") || null;
}

function summarizeRecoveryPhase(events, startedAt, completedAt) {
  const phaseEvents = events.filter((entry) => (
    entry.atUnixMs >= startedAt && entry.atUnixMs <= completedAt
  ));
  const requests = phaseEvents.filter((entry) => entry.type === "rpc/request");
  const results = phaseEvents.filter((entry) => (
    entry.type === "rpc/result" || entry.type === "rpc/error"
  ));
  const rpcRequests = countBy(requests, (entry) => entry.rpcMethod || "unknown");
  const rpcResults = countBy(results, (entry) => (
    `${entry.type === "rpc/error" ? "error:" : ""}${entry.rpcMethod || "unknown"}`
  ));
  const bridgeStatuses = phaseEvents
    .filter((entry) => entry.type === "bridge/status")
    .map((entry) => ({
      socketId: entry.socketId,
      status: entry.status,
      runtimeEpoch: entry.runtimeEpoch,
      eventSequence: entry.eventSequence,
    }));
  const messageMutations = phaseEvents.filter((entry) => entry.type === "ui/messages-mutation");
  return {
    durationMs: completedAt - startedAt,
    socketIds: [...new Set(phaseEvents.map((entry) => entry.socketId).filter(Boolean))],
    bridgeStatuses,
    runtimeEpochs: [...new Set(bridgeStatuses.map((entry) => entry.runtimeEpoch).filter(Boolean))],
    clientStateCount: phaseEvents.filter((entry) => entry.type === "client/state").length,
    rpcRequests,
    rpcResults,
    fullBootstrapObserved: [
      "model/list",
      "config/read",
      "collaboration/modes/list",
      "thread/list",
      "thread/loaded/list",
    ].some((method) => rpcRequests[method]),
    threadResumeObserved: Boolean(rpcRequests["thread/resume"]),
    recentTurnsRefreshObserved: Boolean(rpcRequests["thread/turns/list"]),
    messageListMutations: {
      callbacks: messageMutations.length,
      records: messageMutations.reduce((total, entry) => total + entry.mutationRecords, 0),
      addedNodes: messageMutations.reduce((total, entry) => total + entry.addedNodes, 0),
      removedNodes: messageMutations.reduce((total, entry) => total + entry.removedNodes, 0),
    },
    connectionLabels: phaseEvents
      .filter((entry) => entry.type === "ui/connection")
      .map((entry) => entry.text),
    toasts: phaseEvents
      .filter((entry) => entry.type === "ui/toast")
      .map((entry) => entry.text),
  };
}

function countBy(entries, keyFor) {
  const counts = {};
  for (const entry of entries) {
    const key = keyFor(entry);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeBrowserFieldCoverage(events, sockets) {
  const websocketEvents = events.filter((entry) => entry.type.startsWith("ws/"));
  const openEvents = websocketEvents.filter((entry) => entry.type === "ws/open");
  const errorEvents = websocketEvents.filter((entry) => entry.type === "ws/error");
  const closeEvents = websocketEvents.filter((entry) => entry.type === "ws/close");
  const allEnvelopeFieldsPresent = websocketEvents.every((entry) => (
    typeof entry.socketId === "string"
    && typeof entry.socketRole === "string"
    && Number.isFinite(entry.atMonoMs)
    && Number.isFinite(entry.atUnixMs)
    && typeof entry.visibility === "string"
    && typeof entry.online === "boolean"
  ));
  const allCloseFieldsPresent = closeEvents.every((entry) => (
    Number.isSafeInteger(entry.code)
    && typeof entry.reason === "string"
    && typeof entry.wasClean === "boolean"
  ));
  const applicationLifetimes = sockets
    .filter((socket) => socket.role === "application" && socket.closedAt !== null)
    .map((socket) => socket.lifetimeMs);
  const closeCodes = [...new Set(closeEvents.map((entry) => entry.code))].sort((a, b) => a - b);
  const visibilityStates = [...new Set(events.map((entry) => entry.visibility).filter(Boolean))];
  const onlineStates = [...new Set(events.map((entry) => entry.online).filter(
    (value) => typeof value === "boolean",
  ))].sort();
  return {
    openEvents: openEvents.length,
    errorEvents: errorEvents.length,
    closeEvents: closeEvents.length,
    closeCodes,
    visibilityStates,
    onlineStates,
    applicationLifetimesMs: applicationLifetimes,
    allEnvelopeFieldsPresent,
    allCloseFieldsPresent,
    targetMet:
      openEvents.some((entry) => entry.socketRole === "application")
      && errorEvents.some((entry) => entry.socketRole === "diagnostic-error")
      && closeEvents.some((entry) => entry.socketRole === "application" && entry.code === 1012)
      && closeEvents.some((entry) => entry.socketRole === "diagnostic-error" && entry.code === 1006)
      && visibilityStates.length >= 1
      && onlineStates.includes(false)
      && onlineStates.includes(true)
      && applicationLifetimes.length >= 1
      && applicationLifetimes.every((value) => Number.isFinite(value) && value >= 0)
      && allEnvelopeFieldsPresent
      && allCloseFieldsPresent,
  };
}

function summarizeSockets(events) {
  const byId = new Map();
  for (const event of events) {
    if (!event.socketId) continue;
    const current = byId.get(event.socketId) || {
      id: event.socketId,
      role: event.socketRole || null,
      createdAt: null,
      openedAt: null,
      closedAt: null,
      closeCode: null,
      closeReason: null,
      wasClean: null,
    };
    if (!current.role && event.socketRole) current.role = event.socketRole;
    if (event.type === "ws/created") current.createdAt = event.atUnixMs;
    if (event.type === "ws/open") current.openedAt = event.atUnixMs;
    if (event.type === "ws/close") {
      current.closedAt = event.atUnixMs;
      current.closeCode = event.code;
      current.closeReason = event.reason;
      current.wasClean = event.wasClean;
    }
    byId.set(event.socketId, current);
  }
  return [...byId.values()].map((socket) => ({
    ...socket,
    lifetimeMs: socket.openedAt && socket.closedAt
      ? socket.closedAt - socket.openedAt
      : null,
  }));
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

async function waitForCodexConnection(page) {
  await page.waitForFunction(() => (
    ["Codex 已连接", "Codex connected"].includes(
      document.getElementById("connectionText")?.textContent,
    )
  ));
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
