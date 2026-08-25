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
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 15_000;
const SNAPSHOT_PROMPT = "trace five layer identity";
const SNAPSHOT_MARKER = "FIVE_LAYER_TRACE";
const NOTIFICATION_PROMPT = "trace duplicate notification identity";
const NOTIFICATION_MARKER = "DUPLICATE_NOTIFICATION_TRACE";
const DOUBLE_SUBMISSION_PROMPT = "duplicate after unloaded resume";

let browser = null;
let child = null;
let directory = null;

try {
  const traceId = randomUUID();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-five-layer-turn-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "trace-project");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const runtimeDirectory = path.join(directory, "runtime");
  const appServerTraceFile = path.join(directory, "app-server-trace.ndjson");

  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.writeFile(appServerTraceFile, "", { mode: 0o600 }),
  ]);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "Five-layer trace provider",
    baseUrl: "https://five-layer-trace.example.test/v1",
    model: "gpt-smoke",
    apiKey: "five-layer-trace-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const port = await getFreePort();
  assert.notEqual(port, 4321, "random diagnostic port must exclude frozen rescue port 4321");
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
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
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: "/bin/false",
      FAKE_CODEX_PROJECT: defaultProject,
      FAKE_CODEX_DIAGNOSTIC_TRACE_FILE: appServerTraceFile,
      FAKE_CODEX_DIAGNOSTIC_TRACE_ID: traceId,
      FAKE_CODEX_REPEAT_RESUME_DELAY_MS: "1200",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);

  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route("**/app.js*", instrumentApplicationSource);
  await context.addInitScript(initializeFiveLayerRecorder, traceId);
  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  await page.locator("#newThreadButton").click();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.evaluate(() => {
    window.__fiveLayerTrace.events = [];
    window.__fiveLayerTrace.domMutations = [];
  });
  await page.locator("#promptInput").fill(SNAPSHOT_PROMPT);
  await page.locator("#sendButton").click();

  await page.waitForFunction(() => window.__fiveLayerTrace.events.some((entry) => (
    entry.direction === "out" && entry.method === "turn/start"
  )));
  const submission = await page.evaluate(() => structuredClone(
    window.__fiveLayerTrace.events.find((entry) => (
      entry.direction === "out" && entry.method === "turn/start"
    )),
  ));
  assert.ok(submission.threadId);
  assert.ok(submission.clientId);

  await page.waitForFunction(() => window.__fiveLayerTrace.events.some((entry) => (
    entry.layer === "browser-receive"
    && entry.method === "item/agentMessage/delta"
  )));
  const firstDelta = await page.evaluate(() => structuredClone(
    window.__fiveLayerTrace.events.find((entry) => (
      entry.layer === "browser-receive"
      && entry.method === "item/agentMessage/delta"
    )),
  ));
  assert.equal(firstDelta.threadId, submission.threadId);
  assert.ok(firstDelta.turnId);
  assert.ok(firstDelta.itemId);
  await page.getByText("FIVE_LAYER_TRACE_COMPLETE", { exact: true }).waitFor();

  const beforeRunningSnapshot = await captureBrowserStage(page, firstDelta.turnId, SNAPSHOT_MARKER);
  assert.deepEqual(agentIds(beforeRunningSnapshot), [firstDelta.itemId]);
  assert.equal(beforeRunningSnapshot.dom.markerNodes, 1);

  const snapshotResultsBefore = await browserRpcResultCount(page, "thread/turns/list");
  await page.evaluate(async () => {
    const debugState = globalThis.__wflFiveLayerState;
    await globalThis.__wflFiveLayerRefreshRecentTurns(debugState.activeThread.id);
  });
  await waitForBrowserRpcResultCount(page, "thread/turns/list", snapshotResultsBefore + 1);
  const afterRunningSnapshot = await captureBrowserStage(page, firstDelta.turnId, SNAPSHOT_MARKER);

  const runningAgentIds = agentIds(afterRunningSnapshot);
  assert.equal(runningAgentIds.length, 2);
  assert.ok(runningAgentIds.includes(firstDelta.itemId));
  const snapshotAgentId = runningAgentIds.find((itemId) => itemId !== firstDelta.itemId);
  assert.ok(snapshotAgentId);
  assert.equal(afterRunningSnapshot.dom.markerNodes, 2);

  await page.waitForFunction(({ turnId }) => window.__fiveLayerTrace.events.some((entry) => (
    entry.layer === "browser-receive"
    && entry.method === "turn/completed"
    && entry.turnId === turnId
  )), { turnId: firstDelta.turnId });
  await waitForBrowserRpcResultCount(page, "thread/turns/list", snapshotResultsBefore + 2);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  const afterTerminalSnapshot = await captureBrowserStage(page, firstDelta.turnId, SNAPSHOT_MARKER);
  assert.deepEqual(agentIds(afterTerminalSnapshot), [snapshotAgentId]);
  assert.equal(afterTerminalSnapshot.dom.markerNodes, 1);

  const browserTrace = await page.evaluate(() => structuredClone(window.__fiveLayerTrace));
  const appServerTrace = await readNdjson(appServerTraceFile);
  const rawEvents = relevantNotificationKeys(appServerTrace, firstDelta.turnId);
  const receivedEvents = relevantNotificationKeys(browserTrace.events, firstDelta.turnId);
  assert.deepEqual(receivedEvents, rawEvents);

  const appServerSnapshots = relevantSnapshotProjections(appServerTrace, firstDelta.turnId);
  const browserSnapshots = relevantSnapshotProjections(browserTrace.events, firstDelta.turnId);
  assert.equal(appServerSnapshots.length >= 2, true);
  assert.deepEqual(browserSnapshots, appServerSnapshots);

  await page.locator("#newThreadButton").click();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.evaluate(() => {
    window.__fiveLayerTrace.events = [];
    window.__fiveLayerTrace.domMutations = [];
  });
  await page.locator("#promptInput").fill(NOTIFICATION_PROMPT);
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => window.__fiveLayerTrace.events.filter((entry) => (
    entry.layer === "browser-receive"
    && entry.method === "item/agentMessage/delta"
  )).length >= 2);
  const notificationDeltas = await page.evaluate(() => structuredClone(
    window.__fiveLayerTrace.events.filter((entry) => (
      entry.layer === "browser-receive"
      && entry.method === "item/agentMessage/delta"
    )),
  ));
  assert.equal(notificationDeltas.length, 2);
  assert.equal(new Set(notificationDeltas.map((entry) => entry.turnId)).size, 1);
  assert.equal(new Set(notificationDeltas.map((entry) => entry.itemId)).size, 1);
  const notificationTurnId = notificationDeltas[0].turnId;
  const notificationItemId = notificationDeltas[0].itemId;
  await page.waitForFunction(({ turnId, marker }) => {
    const turn = globalThis.__wflFiveLayerState.activeThread?.turns?.find(
      (entry) => entry.id === turnId,
    );
    const item = turn?.items?.find((entry) => entry.type === "agentMessage");
    return typeof item?.text === "string" && item.text.split(marker).length - 1 === 2;
  }, { turnId: notificationTurnId, marker: NOTIFICATION_MARKER });
  const notificationRunning = await captureBrowserStage(
    page,
    notificationTurnId,
    NOTIFICATION_MARKER,
  );
  assert.deepEqual(agentIds(notificationRunning), [notificationItemId]);
  assert.equal(markerOccurrencesInAgentItems(notificationRunning), 2);
  assert.equal(notificationRunning.dom.markerNodes, 1);
  assert.equal(markerOccurrencesInDom(notificationRunning), 2);

  await page.evaluate(() => {
    globalThis.__wflFiveLayerRenderMessages(true);
    globalThis.__wflFiveLayerRenderMessages(true);
  });
  const notificationAfterDomRerender = await captureBrowserStage(
    page,
    notificationTurnId,
    NOTIFICATION_MARKER,
  );
  assert.deepEqual(notificationAfterDomRerender, notificationRunning);

  await page.waitForFunction(({ turnId }) => window.__fiveLayerTrace.events.some((entry) => (
    entry.layer === "browser-receive"
    && entry.method === "turn/completed"
    && entry.turnId === turnId
  )), { turnId: notificationTurnId });
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  const notificationTerminal = await captureBrowserStage(
    page,
    notificationTurnId,
    NOTIFICATION_MARKER,
  );
  assert.deepEqual(agentIds(notificationTerminal), [notificationItemId]);
  assert.equal(markerOccurrencesInAgentItems(notificationTerminal), 2);
  assert.equal(notificationTerminal.dom.markerNodes, 1);
  assert.equal(markerOccurrencesInDom(notificationTerminal), 2);

  const notificationBrowserTrace = await page.evaluate(
    () => structuredClone(window.__fiveLayerTrace),
  );
  const notificationAppServerTrace = await readNdjson(appServerTraceFile);
  const notificationRawEvents = relevantNotificationKeys(
    notificationAppServerTrace,
    notificationTurnId,
  );
  const notificationReceivedEvents = relevantNotificationKeys(
    notificationBrowserTrace.events,
    notificationTurnId,
  );
  assert.deepEqual(notificationReceivedEvents, notificationRawEvents);
  assert.equal(
    notificationRawEvents.filter((entry) => entry.method === "item/agentMessage/delta").length,
    2,
  );

  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("complete then unload current thread");
  await page.locator("#sendButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "visible" });
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.evaluate(() => {
    window.__fiveLayerTrace.events = [];
    window.__fiveLayerTrace.domMutations = [];
  });
  await page.locator("#promptInput").fill(DOUBLE_SUBMISSION_PROMPT);
  await dispatchClickAndEnter(page);
  await page.waitForFunction((prompt) => window.__fiveLayerTrace.events.filter((entry) => (
    entry.layer === "browser-transport"
    && entry.direction === "out"
    && entry.method === "turn/start"
    && entry.prompt === prompt
  )).length >= 2, DOUBLE_SUBMISSION_PROMPT);
  const doubleSubmissionStarts = await page.evaluate((prompt) => structuredClone(
    window.__fiveLayerTrace.events.filter((entry) => (
      entry.layer === "browser-transport"
      && entry.direction === "out"
      && entry.method === "turn/start"
      && entry.prompt === prompt
    )),
  ), DOUBLE_SUBMISSION_PROMPT);
  assert.equal(doubleSubmissionStarts.length, 2);
  assert.equal(new Set(doubleSubmissionStarts.map((entry) => entry.clientId)).size, 2);
  assert.equal(new Set(doubleSubmissionStarts.map((entry) => entry.threadId)).size, 1);
  await page.waitForFunction(() => window.__fiveLayerTrace.events.filter((entry) => (
    entry.layer === "browser-transport"
    && entry.direction === "in"
    && entry.method === "turn/start"
  )).length >= 2);
  await page.waitForTimeout(250);
  const doubleSubmissionResponses = await page.evaluate(() => structuredClone(
    window.__fiveLayerTrace.events.filter((entry) => (
      entry.layer === "browser-transport"
      && entry.direction === "in"
      && entry.method === "turn/start"
    )),
  ));
  const doubleSubmissionStage = await captureDoubleSubmissionStage(
    page,
    DOUBLE_SUBMISSION_PROMPT,
  );
  assert.equal(doubleSubmissionResponses.length, 2);
  assert.equal(
    doubleSubmissionStage.storeTurns,
    doubleSubmissionStage.storeUserItems,
    `double-submission Store mismatch: ${JSON.stringify(doubleSubmissionStage)}`,
  );
  assert.equal(
    doubleSubmissionStage.storeUserItems,
    doubleSubmissionStage.domUserNodes,
    `double-submission DOM mismatch: ${JSON.stringify(doubleSubmissionStage)}`,
  );

  const finalAppServerTrace = await readNdjson(appServerTraceFile);
  const doubleSubmissionRawRequests = finalAppServerTrace.filter((entry) => (
    entry.direction === "in"
    && entry.method === "turn/start"
    && doubleSubmissionStarts.some((start) => start.clientId === entry.clientId)
  ));
  assert.equal(
    new Set(doubleSubmissionRawRequests.map((entry) => entry.clientId)).size,
    doubleSubmissionRawRequests.length,
  );
  assert.deepEqual(pageErrors, []);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "isolated-browser-random-port-main-backend",
      appServer: "fake-codex-app-server",
      browserSourceInstrumentation: "temporary in-memory module export",
      productionRequests: 0,
      frozenRescuePortTouched: false,
      formalChecksModified: false,
    },
    traceId,
    identity: {
      threadId: submission.threadId,
      turnId: firstDelta.turnId,
      clientSubmissionId: submission.clientId,
      liveAgentItemId: firstDelta.itemId,
      snapshotAgentItemId: snapshotAgentId,
    },
    eventPath: {
      appServerRaw: rawEvents,
      browserReceived: receivedEvents,
      exactOrderAndIdentityMatch: true,
    },
    snapshots: {
      appServer: appServerSnapshots,
      browserTransport: browserSnapshots,
      exactProjectionMatch: true,
    },
    storeAndDom: {
      beforeRunningSnapshot,
      afterRunningSnapshot,
      afterTerminalSnapshot,
    },
    classification: {
      persistentSourceDuplicate: false,
      duplicateNotification: false,
      firstDuplicateLayer: "browser-store-running-snapshot-merge",
      duplicateDomNodesAfterStoreMerge: 2,
      terminalFullSnapshotRemovesDuplicate: true,
      stableCrossProjectionIdentityMissing: true,
      targetMet: false,
    },
    duplicateOriginMatrix: {
      doubleTurnStart: {
        browserTurnStartRequests: doubleSubmissionStarts.map((entry) => ({
          threadId: entry.threadId,
          clientSubmissionId: entry.clientId,
        })),
        appServerTurnStartRequests: doubleSubmissionRawRequests.map((entry) => ({
          threadId: entry.threadId,
          clientSubmissionId: entry.clientId,
        })),
        browserResponses: doubleSubmissionResponses.map((entry) => ({
          error: entry.error === true,
          turnId: entry.turnId,
        })),
        storeTurns: doubleSubmissionStage.storeTurns,
        storeUserItems: doubleSubmissionStage.storeUserItems,
        domUserNodes: doubleSubmissionStage.domUserNodes,
        firstDuplicateAttemptLayer: "browser-transport-outbound",
      },
      duplicateNotification: {
        rawDeltaNotifications: notificationRawEvents.filter(
          (entry) => entry.method === "item/agentMessage/delta",
        ).length,
        browserDeltaNotifications: notificationReceivedEvents.filter(
          (entry) => entry.method === "item/agentMessage/delta",
        ).length,
        storeAgentItems: agentIds(notificationRunning).length,
        storeMarkerOccurrences: markerOccurrencesInAgentItems(notificationRunning),
        domAgentNodes: notificationRunning.dom.markerNodes,
        domMarkerOccurrences: markerOccurrencesInDom(notificationRunning),
        firstDuplicateLayer: "app-server-notification-stream",
      },
      runningSnapshotMerge: {
        rawDeltaNotifications: rawEvents.filter(
          (entry) => entry.method === "item/agentMessage/delta",
        ).length,
        browserDeltaNotifications: receivedEvents.filter(
          (entry) => entry.method === "item/agentMessage/delta",
        ).length,
        storeAgentItemsBeforeSnapshot: agentIds(beforeRunningSnapshot).length,
        storeAgentItemsAfterSnapshot: agentIds(afterRunningSnapshot).length,
        domAgentNodesAfterSnapshot: afterRunningSnapshot.dom.markerNodes,
        firstDuplicateLayer: "browser-store-running-snapshot-merge",
      },
      repeatedDomRender: {
        forcedFullRenders: 2,
        storeAgentItemsBefore: agentIds(notificationRunning).length,
        storeAgentItemsAfter: agentIds(notificationAfterDomRerender).length,
        domAgentNodesBefore: notificationRunning.dom.markerNodes,
        domAgentNodesAfter: notificationAfterDomRerender.dom.markerNodes,
        domMarkerOccurrencesBefore: markerOccurrencesInDom(notificationRunning),
        domMarkerOccurrencesAfter: markerOccurrencesInDom(notificationAfterDomRerender),
        independentDomDuplicate: false,
      },
      classifierComplete: true,
    },
  }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

function initializeFiveLayerRecorder(traceId) {
  const NativeWebSocket = window.WebSocket;
  const recorder = {
    traceId,
    events: [],
    domMutations: [],
    requests: new Map(),
  };
  const record = (entry) => {
    recorder.events.push({
      schemaVersion: 1,
      traceId,
      atUnixMs: Date.now(),
      ...entry,
    });
  };
  const projection = (result) => {
    const turns = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.initialTurnsPage?.data)
        ? result.initialTurnsPage.data
        : [];
    return turns.map((turn) => ({
      turnId: turn?.id || null,
      status: typeof turn?.status === "object" ? turn.status?.type || null : turn?.status || null,
      itemIds: Array.isArray(turn?.items) ? turn.items.map((item) => item?.id || null) : [],
      itemTypes: Array.isArray(turn?.items) ? turn.items.map((item) => item?.type || null) : [],
    }));
  };
  function TrackingWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    const nativeSend = socket.send.bind(socket);
    socket.send = (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message?.type === "rpc") {
          const requestId = String(message.requestId);
          recorder.requests.set(requestId, message.method || null);
          record({
            layer: "browser-transport",
            direction: "out",
            rpcId: requestId,
            method: message.method || null,
            threadId: message.params?.threadId || null,
            turnId: message.params?.turnId || null,
            itemId: null,
            clientId: message.params?.clientUserMessageId || null,
            prompt: Array.isArray(message.params?.input)
              ? message.params.input.find((item) => item?.type === "text")?.text || null
              : null,
            projection: [],
          });
        }
      } catch {
        // The probe records protocol metadata only.
      }
      return nativeSend(data);
    };
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === "codex/notification") {
        const payload = message.payload || {};
        const params = payload.params || {};
        record({
          layer: "browser-receive",
          direction: "in",
          rpcId: null,
          method: payload.method || null,
          threadId: params.threadId || params.turn?.threadId || null,
          turnId: params.turnId || params.turn?.id || null,
          itemId: params.itemId || params.item?.id || null,
          itemType: params.item?.type || null,
          clientId: params.item?.clientId || null,
          runtimeEpoch: message.runtimeEpoch || null,
          eventSequence: Number.isSafeInteger(message.eventSequence) ? message.eventSequence : null,
          projection: [],
        });
        return;
      }
      if (message?.type === "rpc/result" || message?.type === "rpc/error") {
        const requestId = String(message.requestId);
        record({
          layer: "browser-transport",
          direction: "in",
          rpcId: requestId,
          method: recorder.requests.get(requestId) || null,
          threadId: message.result?.thread?.id || null,
          turnId: message.result?.turn?.id || null,
          itemId: null,
          clientId: null,
          projection: projection(message.result),
          error: message.type === "rpc/error",
        });
        recorder.requests.delete(requestId);
      }
    });
    return socket;
  }
  TrackingWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(TrackingWebSocket, key, { value: NativeWebSocket[key] });
  }
  window.WebSocket = TrackingWebSocket;
  window.__fiveLayerTrace = recorder;

  const observeDom = () => {
    const list = document.getElementById("messageList");
    if (!list) return;
    new MutationObserver((mutations) => {
      recorder.domMutations.push({
        atUnixMs: Date.now(),
        records: mutations.length,
        addedNodes: mutations.reduce((total, mutation) => total + mutation.addedNodes.length, 0),
        removedNodes: mutations.reduce((total, mutation) => total + mutation.removedNodes.length, 0),
      });
    }).observe(list, { childList: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeDom, { once: true });
  } else {
    observeDom();
  }
}

async function captureBrowserStage(page, turnId, marker) {
  return page.evaluate(({ expectedTurnId, marker }) => {
    const debugState = globalThis.__wflFiveLayerState;
    const thread = debugState.activeThread;
    const turn = thread?.turns?.find((entry) => entry.id === expectedTurnId);
    const items = (turn?.items || []).map((item) => ({
      id: item?.id || null,
      type: item?.type || null,
      status: typeof item?.status === "object" ? item.status?.type || null : item?.status || null,
      clientId: item?.clientId || null,
      live: item?._live === true,
      textLength: typeof item?.text === "string" ? item.text.length : 0,
      markerOccurrences: typeof item?.text === "string" ? item.text.split(marker).length - 1 : 0,
    }));
    const nodes = [...document.getElementById("messageList").children]
      .filter((node) => node.dataset.transcriptKey?.includes(`turn:${expectedTurnId}:`))
      .map((node) => ({
        key: node.dataset.transcriptKey || null,
        textLength: node.textContent?.length || 0,
        markerOccurrences: (node.textContent || "").split(marker).length - 1,
      }));
    return {
      threadId: thread?.id || null,
      turnId: turn?.id || null,
      turnStatus: typeof turn?.status === "object" ? turn.status?.type || null : turn?.status || null,
      activeTurnId: debugState.activeTurnId || null,
      codexActiveTurnId: debugState.codexActiveTurnId || null,
      items,
      dom: {
        nodes,
        markerNodes: nodes.filter((node) => node.markerOccurrences > 0).length,
      },
    };
  }, { expectedTurnId: turnId, marker });
}

async function instrumentApplicationSource(route) {
  const response = await route.fetch();
  const source = await response.text();
  const stateNeedle = "const state = {";
  const refreshNeedle = "\nfunction createClientMessageId() {";
  assert.equal(source.includes(stateNeedle), true, "diagnostic state instrumentation anchor is missing");
  assert.equal(source.includes(refreshNeedle), true, "diagnostic refresh instrumentation anchor is missing");
  const instrumented = source
    .replace(stateNeedle, "const state = globalThis.__wflFiveLayerState = {")
    .replace(
      refreshNeedle,
      "\nglobalThis.__wflFiveLayerRefreshRecentTurns = refreshRecentTurns;\n"
      + "globalThis.__wflFiveLayerRenderMessages = renderMessages;\n"
      + "function createClientMessageId() {",
    );
  await route.fulfill({ response, body: instrumented });
}

function agentIds(stage) {
  return stage.items.filter((item) => item.type === "agentMessage").map((item) => item.id);
}

function markerOccurrencesInAgentItems(stage) {
  return stage.items
    .filter((item) => item.type === "agentMessage")
    .reduce((total, item) => total + item.markerOccurrences, 0);
}

function markerOccurrencesInDom(stage) {
  return stage.dom.nodes.reduce((total, node) => total + node.markerOccurrences, 0);
}

async function captureDoubleSubmissionStage(page, prompt) {
  return page.evaluate((expectedPrompt) => {
    const state = globalThis.__wflFiveLayerState;
    const matchingTurns = (state.activeThread?.turns || []).filter((turn) => (
      (turn.items || []).some((item) => (
        item.type === "userMessage"
        && item.content?.some((content) => (
          content.type === "text" && content.text === expectedPrompt
        ))
      ))
    ));
    return {
      threadId: state.activeThread?.id || null,
      turnIds: matchingTurns.map((turn) => turn.id),
      storeTurns: matchingTurns.length,
      storeUserItems: matchingTurns.reduce((total, turn) => (
        total + (turn.items || []).filter((item) => (
          item.type === "userMessage"
          && item.content?.some((content) => (
            content.type === "text" && content.text === expectedPrompt
          ))
        )).length
      ), 0),
      domUserNodes: [...document.querySelectorAll("#messageList .message.user .message-text")]
        .filter((node) => node.textContent === expectedPrompt).length,
    };
  }, prompt);
}

async function dispatchClickAndEnter(page) {
  await page.evaluate(() => {
    document.getElementById("sendButton").click();
    document.getElementById("promptInput").dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter",
    }));
  });
}

function relevantNotificationKeys(rows, turnId) {
  return rows
    .filter((row) => (
      row.direction === "out" || row.layer === "browser-receive"
    ))
    .filter((row) => row.turnId === turnId)
    .filter((row) => [
      "turn/started",
      "hook/started",
      "hook/completed",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ].includes(row.method))
    .map((row) => ({
      method: row.method,
      turnId: row.turnId,
      itemId: row.itemId || null,
      itemType: row.itemType || null,
    }));
}

function relevantSnapshotProjections(rows, turnId) {
  return rows
    .filter((row) => row.direction === "in" || row.direction === "out")
    .filter((row) => row.method === "thread/turns/list")
    .map((row) => row.projection?.find((turn) => turn.turnId === turnId) || null)
    .filter(Boolean);
}

async function browserRpcResultCount(page, method) {
  return page.evaluate((expectedMethod) => window.__fiveLayerTrace.events.filter((entry) => (
    entry.layer === "browser-transport"
    && entry.direction === "in"
    && entry.method === expectedMethod
    && entry.error !== true
  )).length, method);
}

async function waitForBrowserRpcResultCount(page, method, count) {
  await page.waitForFunction(({ expectedMethod, expectedCount }) => (
    window.__fiveLayerTrace.events.filter((entry) => (
      entry.layer === "browser-transport"
      && entry.direction === "in"
      && entry.method === expectedMethod
      && entry.error !== true
    )).length >= expectedCount
  ), { expectedMethod: method, expectedCount: count });
}

async function readNdjson(file) {
  const source = await fs.readFile(file, "utf8");
  return source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForCodexConnection(page) {
  await page.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex 已连接");
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
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8_000);
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
    processHandle.once("exit", (code) => reject(new Error(`Server exited early (${code}): ${output}`)));
  });
}

async function waitForDeepReady(url) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/internal/codex-ready`);
      const data = await response.json();
      if (response.ok && data.codexReady === true && data.threadListReady === true) return;
    } catch {
      // The isolated fake bridge may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The isolated fake Codex bridge did not become ready");
}
