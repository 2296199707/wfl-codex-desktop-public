import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import WebSocket, { WebSocketServer } from "ws";

const PROBE_TIMEOUT_MS = 15_000;
const CONTROLLED_RESTART_CODE = 1012;
const DELIBERATE_OFFLINE_CODE = 4001;

class ReplayReferenceServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.eventLogGeneration = "event-log-1";
    this.runtimeEpoch = "runtime-epoch-1";
    this.cursor = 0;
    this.rows = [];
    this.canonical = new Map();
    this.windows = new Map();
    this.connections = new Map();
    this.nextConnection = 0;
    this.nextWindow = 0;
    this.dropForConnections = new Set();
    this.staleCalibrationScenario = false;
    this.stats = {
      acceptedConnections: 0,
      hellos: 0,
      rangeReplays: 0,
      replayedEvents: 0,
      calibrations: 0,
      staleCalibrationResponses: 0,
      completedCalibrationResponses: 0,
      closeCodes: [],
    };
  }

  async start() {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server.on("connection", (socket) => this.#accept(socket));
    await once(this.server, "listening");
    this.port = this.server.address().port;
    assert.notEqual(this.port, 4321);
    return this;
  }

  url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  #accept(socket) {
    const connectionId = `server-connection-${++this.nextConnection}`;
    const connection = {
      connectionId,
      socket,
      windowNonce: null,
      windowInstanceId: null,
    };
    this.connections.set(connectionId, connection);
    this.stats.acceptedConnections += 1;
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      this.#handle(connection, message);
    });
    socket.on("close", (code) => {
      this.stats.closeCodes.push(code);
      this.connections.delete(connectionId);
      this.dropForConnections.delete(connectionId);
    });
  }

  #handle(connection, message) {
    if (message.type === "hello") {
      this.#hello(connection, message);
      return;
    }
    if (message.type === "replay") {
      this.stats.rangeReplays += 1;
      this.#deliverRange(
        connection,
        Math.max(1, Number(message.fromCursor) || 1),
      );
      return;
    }
    if (message.type === "calibrate") {
      this.stats.calibrations += 1;
      if (this.staleCalibrationScenario && this.stats.calibrations === 1) {
        this.#runStaleCalibration(connection, message);
      } else if (
        this.staleCalibrationScenario
        && this.stats.calibrations === 2
      ) {
        this.#runFencedCalibration(connection, message);
      } else {
        this.#sendCalibration(connection, message);
      }
    }
  }

  #hello(connection, message) {
    this.stats.hellos += 1;
    const nonce = String(message.windowNonce || "");
    let windowInstanceId = this.windows.get(nonce);
    if (!windowInstanceId) {
      windowInstanceId = `window-${++this.nextWindow}`;
      this.windows.set(nonce, windowInstanceId);
    }
    connection.windowNonce = nonce;
    connection.windowInstanceId = windowInstanceId;
    const clientGeneration = message.eventLogGeneration == null
      ? null
      : String(message.eventLogGeneration);
    const clientCursor = Math.max(0, Number(message.eventCursor) || 0);
    const emptySeedAllowed = (
      clientGeneration === null
      && clientCursor === 0
      && this.cursor === 0
    );
    const resyncRequired = !emptySeedAllowed && (
      clientGeneration !== this.eventLogGeneration
      || clientCursor > this.cursor
    );
    this.#send(connection, {
      type: "welcome",
      connectionId: connection.connectionId,
      windowInstanceId,
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      currentCursor: this.cursor,
      resyncRequired,
      reason: resyncRequired ? "generation-or-seed-incompatible" : null,
    });
    if (resyncRequired) return;
    this.#deliverRange(connection, clientCursor + 1);
  }

  #deliverRange(connection, fromCursor) {
    for (const row of this.rows) {
      if (row.eventCursor < fromCursor) continue;
      this.stats.replayedEvents += 1;
      this.#send(connection, { type: "event", ...row });
    }
    this.#send(connection, {
      type: "replayDone",
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      currentCursor: this.cursor,
    });
  }

  appendEntity(entityId, value, {
    dropForConnectionId = null,
  } = {}) {
    this.cursor += 1;
    const row = {
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      eventCursor: this.cursor,
      entityId,
      value,
    };
    this.rows.push(row);
    this.canonical.set(entityId, value);
    for (const connection of this.connections.values()) {
      if (
        connection.connectionId === dropForConnectionId
        || this.dropForConnections.has(connection.connectionId)
      ) {
        continue;
      }
      this.#send(connection, { type: "event", ...row });
    }
    return row;
  }

  rebuild(eventLogGeneration, runtimeEpoch) {
    this.eventLogGeneration = eventLogGeneration;
    this.runtimeEpoch = runtimeEpoch;
    this.cursor = 0;
    this.rows = [];
  }

  enableStaleCalibrationScenario() {
    this.staleCalibrationScenario = true;
  }

  currentConnectionId() {
    return [...this.connections.keys()].at(-1) || null;
  }

  closeAll(code = CONTROLLED_RESTART_CODE, reason = "reference restart") {
    for (const connection of this.connections.values()) {
      connection.socket.close(code, reason);
    }
  }

  sendResync(connection, reason) {
    this.#send(connection, {
      type: "resyncRequired",
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      currentCursor: this.cursor,
      reason,
    });
  }

  #runStaleCalibration(connection, message) {
    const stale = {
      type: "calibration",
      calibrationId: message.calibrationId,
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      baseCursor: Number(message.baseCursor) || 0,
      fenceCursor: this.cursor,
      entities: [...this.canonical].map(([entityId, value]) => ({
        entityId,
        value,
      })),
    };
    setTimeout(() => {
      this.rebuild("event-log-3", "runtime-epoch-3");
      this.sendResync(connection, "epoch-changed-during-calibration");
    }, 5);
    setTimeout(() => {
      this.stats.staleCalibrationResponses += 1;
      this.#send(connection, stale);
    }, 30);
  }

  #runFencedCalibration(connection, message) {
    setTimeout(() => {
      this.appendEntity("entity-7", "during-calibration");
    }, 5);
    setTimeout(() => {
      this.#sendCalibration(connection, message);
      this.appendEntity("entity-8", "after-calibration-fence");
    }, 15);
  }

  #sendCalibration(connection, message) {
    const response = {
      type: "calibration",
      calibrationId: message.calibrationId,
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      baseCursor: Number(message.baseCursor) || 0,
      fenceCursor: this.cursor,
      entities: [...this.canonical].map(([entityId, value]) => ({
        entityId,
        value,
      })),
    };
    this.stats.completedCalibrationResponses += 1;
    this.#send(connection, response);
  }

  #send(connection, message) {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(JSON.stringify(message));
  }

  snapshot() {
    return {
      eventLogGeneration: this.eventLogGeneration,
      runtimeEpoch: this.runtimeEpoch,
      cursor: this.cursor,
      canonical: [...this.canonical].sort(([left], [right]) =>
        left.localeCompare(right)),
      openConnections: [...this.connections.values()]
        .filter((connection) => connection.socket.readyState === WebSocket.OPEN)
        .length,
      stats: structuredClone(this.stats),
    };
  }

  async close() {
    if (!this.server) return;
    for (const connection of this.connections.values()) {
      connection.socket.terminate();
    }
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}

let browser = null;
let context = null;
let server = null;
let temporaryRoot = null;

try {
  temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "wfl-browser-reconnect-reference-"),
  );
  await fs.chmod(temporaryRoot, 0o700);
  server = await new ReplayReferenceServer().start();
  browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
  context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent("<!doctype html><meta charset=utf-8><title>reconnect reference</title>");
  await page.evaluate(({ url, deliberateOfflineCode }) => {
    const windowNonce = [...crypto.getRandomValues(new Uint32Array(4))]
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("-");
    const canonical = new Map();
    const bufferedEvents = new Map();
    const retiredGenerations = new Set();
    const sockets = new Map();
    let transportGeneration = 0;
    let activeGeneration = null;
    let activeSocket = null;
    let connectPromise = null;
    let autoReconnect = true;
    let replayInFlight = false;
    let calibrationToken = 0;
    let calibrationId = 0;
    const state = {
      windowNonce,
      windowInstanceId: null,
      connectionId: null,
      transportState: "idle",
      syncState: "idle",
      eventLogGeneration: null,
      runtimeEpoch: null,
      eventCursor: 0,
      metrics: {
        connectCalls: 0,
        socketsCreated: 0,
        socketsOpened: 0,
        singleFlightJoins: 0,
        generationsRetired: 0,
        staleFramesIgnored: 0,
        duplicateFramesIgnored: 0,
        gapsDetected: 0,
        replayRequests: 0,
        calibrationsStarted: 0,
        calibrationsDiscarded: 0,
        calibrationsCompleted: 0,
        eventsApplied: 0,
        closeCodes: [],
        threadResumeCalls: 0,
        fullBootstrapCalls: 0,
      },
    };

    function send(socket, message) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    }

    function scheduleReconnect() {
      if (!autoReconnect) return;
      setTimeout(() => {
        if (autoReconnect && activeGeneration === null) void connect();
      }, 20);
    }

    function handleEvent(frame) {
      if (
        frame.eventLogGeneration !== state.eventLogGeneration
        || frame.runtimeEpoch !== state.runtimeEpoch
      ) {
        beginCalibration({
          eventLogGeneration: frame.eventLogGeneration,
          runtimeEpoch: frame.runtimeEpoch,
          reason: "event-generation-mismatch",
        });
        return;
      }
      if (state.syncState === "calibrating") {
        bufferedEvents.set(frame.eventCursor, frame);
        return;
      }
      if (frame.eventCursor <= state.eventCursor) {
        state.metrics.duplicateFramesIgnored += 1;
        return;
      }
      if (frame.eventCursor > state.eventCursor + 1) {
        state.metrics.gapsDetected += 1;
        bufferedEvents.set(frame.eventCursor, frame);
        state.syncState = "gap";
        requestReplay();
        return;
      }
      applyEvent(frame);
    }

    function applyEvent(frame) {
      if (frame.eventCursor <= state.eventCursor) return;
      canonical.set(frame.entityId, frame.value);
      state.eventCursor = frame.eventCursor;
      state.metrics.eventsApplied += 1;
    }

    function requestReplay() {
      if (replayInFlight || !activeSocket) return;
      replayInFlight = true;
      state.metrics.replayRequests += 1;
      send(activeSocket, {
        type: "replay",
        fromCursor: state.eventCursor + 1,
      });
    }

    function handleReplayDone(frame) {
      if (
        frame.eventLogGeneration !== state.eventLogGeneration
        || frame.runtimeEpoch !== state.runtimeEpoch
      ) {
        beginCalibration(frame);
        return;
      }
      replayInFlight = false;
      for (const cursor of [...bufferedEvents.keys()]) {
        if (cursor <= state.eventCursor) bufferedEvents.delete(cursor);
      }
      const pending = [...bufferedEvents.values()]
        .sort((left, right) => left.eventCursor - right.eventCursor);
      for (const event of pending) {
        if (event.eventCursor === state.eventCursor + 1) {
          applyEvent(event);
          bufferedEvents.delete(event.eventCursor);
        }
      }
      if (bufferedEvents.size === 0) state.syncState = "live";
      else requestReplay();
    }

    function beginCalibration(metadata) {
      const nextGeneration = String(metadata.eventLogGeneration);
      const nextEpoch = String(metadata.runtimeEpoch);
      calibrationToken += 1;
      const token = calibrationToken;
      const id = `calibration-${++calibrationId}`;
      state.eventLogGeneration = nextGeneration;
      state.runtimeEpoch = nextEpoch;
      state.eventCursor = 0;
      state.syncState = "calibrating";
      bufferedEvents.clear();
      replayInFlight = false;
      state.metrics.calibrationsStarted += 1;
      send(activeSocket, {
        type: "calibrate",
        calibrationId: id,
        baseCursor: 0,
        eventLogGeneration: nextGeneration,
        runtimeEpoch: nextEpoch,
      });
      return { token, id };
    }

    async function handleCalibration(frame) {
      const token = calibrationToken;
      const expectedGeneration = state.eventLogGeneration;
      const expectedEpoch = state.runtimeEpoch;
      if (
        frame.eventLogGeneration !== expectedGeneration
        || frame.runtimeEpoch !== expectedEpoch
        || frame.calibrationId !== `calibration-${calibrationId}`
      ) {
        state.metrics.calibrationsDiscarded += 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (
        token !== calibrationToken
        || frame.eventLogGeneration !== state.eventLogGeneration
        || frame.runtimeEpoch !== state.runtimeEpoch
      ) {
        state.metrics.calibrationsDiscarded += 1;
        return;
      }
      canonical.clear();
      for (const entity of frame.entities) {
        canonical.set(entity.entityId, entity.value);
      }
      state.eventCursor = frame.fenceCursor;
      const buffered = [...bufferedEvents.values()]
        .filter((event) => (
          event.eventLogGeneration === state.eventLogGeneration
          && event.runtimeEpoch === state.runtimeEpoch
        ))
        .sort((left, right) => left.eventCursor - right.eventCursor);
      bufferedEvents.clear();
      for (const event of buffered) {
        if (event.eventCursor <= state.eventCursor) continue;
        if (event.eventCursor !== state.eventCursor + 1) {
          bufferedEvents.set(event.eventCursor, event);
          continue;
        }
        applyEvent(event);
      }
      if (bufferedEvents.size > 0) {
        state.syncState = "gap";
        requestReplay();
      } else {
        state.syncState = "live";
      }
      state.metrics.calibrationsCompleted += 1;
    }

    function handleFrame(generation, frame) {
      if (generation !== activeGeneration) {
        state.metrics.staleFramesIgnored += 1;
        return;
      }
      if (frame.type === "welcome") {
        state.connectionId = frame.connectionId;
        state.windowInstanceId = frame.windowInstanceId;
        if (frame.resyncRequired) {
          beginCalibration(frame);
          return;
        }
        state.eventLogGeneration = frame.eventLogGeneration;
        state.runtimeEpoch = frame.runtimeEpoch;
        state.syncState = "replaying";
        return;
      }
      if (frame.type === "resyncRequired") {
        beginCalibration(frame);
        return;
      }
      if (frame.type === "event") {
        handleEvent(frame);
        return;
      }
      if (frame.type === "replayDone") {
        handleReplayDone(frame);
        return;
      }
      if (frame.type === "calibration") {
        void handleCalibration(frame);
      }
    }

    function connect() {
      state.metrics.connectCalls += 1;
      if (connectPromise) {
        state.metrics.singleFlightJoins += 1;
        return connectPromise;
      }
      if (
        activeSocket
        && [WebSocket.CONNECTING, WebSocket.OPEN].includes(activeSocket.readyState)
      ) {
        return Promise.resolve();
      }
      const generation = ++transportGeneration;
      const socket = new WebSocket(url);
      state.metrics.socketsCreated += 1;
      sockets.set(generation, socket);
      activeGeneration = generation;
      activeSocket = socket;
      state.transportState = "connecting";
      const promise = new Promise((resolve, reject) => {
        socket.addEventListener("open", () => {
          if (generation !== activeGeneration) {
            resolve();
            return;
          }
          state.metrics.socketsOpened += 1;
          state.transportState = "open";
          send(socket, {
            type: "hello",
            windowNonce,
            windowInstanceId: state.windowInstanceId,
            eventLogGeneration: state.eventLogGeneration,
            eventCursor: state.eventCursor,
            runtimeEpoch: state.runtimeEpoch,
          });
          resolve();
        });
        socket.addEventListener("message", (event) => {
          let frame;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          handleFrame(generation, frame);
        });
        socket.addEventListener("close", (event) => {
          state.metrics.closeCodes.push(event.code);
          if (generation !== activeGeneration) return;
          activeGeneration = null;
          activeSocket = null;
          state.transportState = autoReconnect ? "reconnecting" : "offline";
          if (!retiredGenerations.has(generation)) scheduleReconnect();
        });
        socket.addEventListener("error", () => {
          if (generation === activeGeneration) state.transportState = "error";
        });
        setTimeout(() => {
          if (socket.readyState === WebSocket.CONNECTING) {
            reject(new Error("socket-open-timeout"));
          }
        }, 5_000);
      });
      connectPromise = promise.finally(() => {
        if (connectPromise === promise || connectPromise === wrapped) {
          connectPromise = null;
        }
      });
      const wrapped = connectPromise;
      return wrapped;
    }

    function retireActive(code = deliberateOfflineCode) {
      if (activeGeneration === null || !activeSocket) return null;
      const retired = activeGeneration;
      const socket = activeSocket;
      retiredGenerations.add(retired);
      state.metrics.generationsRetired += 1;
      activeGeneration = null;
      activeSocket = null;
      state.transportState = "offline";
      try {
        socket.close(code, "deliberate offline");
      } finally {
        state.syncState = state.syncState === "calibrating"
          ? "calibrating"
          : "transport-offline";
      }
      return retired;
    }

    async function goOffline() {
      autoReconnect = false;
      return retireActive();
    }

    async function goOnlineConcurrent(callCount) {
      autoReconnect = true;
      await Promise.all(
        Array.from({ length: callCount }, () => connect()),
      );
    }

    function snapshot() {
      return {
        ...state,
        metrics: structuredClone(state.metrics),
        activeGeneration,
        transportGeneration,
        canonical: [...canonical].sort(([left], [right]) =>
          left.localeCompare(right)),
        bufferedCursors: [...bufferedEvents.keys()].sort((left, right) => left - right),
        openSocketGenerations: [...sockets]
          .filter(([, socket]) => socket.readyState === WebSocket.OPEN)
          .map(([generation]) => generation),
      };
    }

    window.__reconnectReference = {
      connect,
      goOffline,
      goOnlineConcurrent,
      snapshot,
      injectFrame(generation, frame) {
        handleFrame(generation, frame);
      },
    };
  }, {
    url: server.url(),
    deliberateOfflineCode: DELIBERATE_OFFLINE_CODE,
  });

  await page.evaluate(() => window.__reconnectReference.connect());
  await waitForClient(page, (state) => (
    state.transportState === "open"
    && state.syncState === "live"
    && state.eventLogGeneration === "event-log-1"
  ));
  const initial = await clientSnapshot(page);
  assert.equal(initial.eventCursor, 0);
  assert.equal(initial.windowInstanceId, "window-1");

  server.appendEntity("entity-1", "initial-live");
  await waitForClient(page, (state) => (
    state.eventCursor === 1
    && state.canonical.length === 1
  ));

  const beforeOffline = await clientSnapshot(page);
  const retiredGeneration = await page.evaluate(
    () => window.__reconnectReference.goOffline(),
  );
  assert.equal(retiredGeneration, beforeOffline.activeGeneration);
  server.appendEntity("entity-2", "offline-2");
  server.appendEntity("entity-3", "offline-3");
  server.appendEntity("entity-4", "offline-4");
  await page.evaluate(({ generation }) => {
    window.__reconnectReference.injectFrame(generation, {
      type: "event",
      eventLogGeneration: "event-log-1",
      runtimeEpoch: "runtime-epoch-1",
      eventCursor: 999,
      entityId: "stale-entity",
      value: "must-not-apply",
    });
  }, { generation: retiredGeneration });
  await page.evaluate(
    () => window.__reconnectReference.goOnlineConcurrent(10),
  );
  await waitForClient(page, (state) => (
    state.transportState === "open"
    && state.syncState === "live"
    && state.eventCursor === 4
    && state.canonical.length === 4
  ));
  const afterOnline = await clientSnapshot(page);
  assert.equal(afterOnline.windowInstanceId, initial.windowInstanceId);
  assert.equal(afterOnline.openSocketGenerations.length, 1);
  assert.equal(afterOnline.metrics.singleFlightJoins, 9);
  assert.equal(afterOnline.metrics.staleFramesIgnored >= 1, true);
  assert.equal(
    afterOnline.canonical.some(([entityId]) => entityId === "stale-entity"),
    false,
  );
  assert.equal(afterOnline.metrics.calibrationsStarted, 0);
  assert.equal(afterOnline.metrics.threadResumeCalls, 0);

  const socketsBeforeRestart = afterOnline.metrics.socketsCreated;
  server.closeAll(CONTROLLED_RESTART_CODE, "controlled reference restart");
  await waitForClient(page, (state, expected) => (
    state.metrics.closeCodes.includes(1012)
    && state.metrics.socketsCreated === expected.socketsCreated
    && state.transportState === "open"
    && state.syncState === "live"
    && state.eventCursor === 4
  ), { socketsCreated: socketsBeforeRestart + 1 });
  const afterRestart = await clientSnapshot(page);
  assert.equal(afterRestart.metrics.calibrationsStarted, 0);
  assert.equal(afterRestart.metrics.replayRequests, 0);
  assert.equal(afterRestart.metrics.threadResumeCalls, 0);
  assert.equal(afterRestart.metrics.fullBootstrapCalls, 0);

  const gapConnectionId = server.currentConnectionId();
  server.appendEntity("entity-5", "gap-replayed", {
    dropForConnectionId: gapConnectionId,
  });
  server.appendEntity("entity-6", "after-gap");
  await waitForClient(page, (state) => (
    state.syncState === "live"
    && state.eventCursor === 6
    && state.canonical.length === 6
    && state.metrics.gapsDetected === 1
    && state.metrics.replayRequests === 1
  ));
  const afterGap = await clientSnapshot(page);
  assert.equal(afterGap.metrics.calibrationsStarted, 0);
  assert.deepEqual(
    afterGap.canonical.map(([entityId]) => entityId),
    ["entity-1", "entity-2", "entity-3", "entity-4", "entity-5", "entity-6"],
  );

  server.enableStaleCalibrationScenario();
  server.rebuild("event-log-2", "runtime-epoch-2");
  const socketsBeforeGenerationChange = afterGap.metrics.socketsCreated;
  server.closeAll(CONTROLLED_RESTART_CODE, "event log generation changed");
  await waitForClient(page, (state, expected) => (
    state.transportState === "open"
    && state.syncState === "live"
    && state.eventLogGeneration === "event-log-3"
    && state.runtimeEpoch === "runtime-epoch-3"
    && state.eventCursor === 2
    && state.canonical.length === 8
    && state.metrics.socketsCreated === expected.socketsCreated
    && state.metrics.calibrationsStarted === 2
    && state.metrics.calibrationsDiscarded === 1
    && state.metrics.calibrationsCompleted === 1
  ), { socketsCreated: socketsBeforeGenerationChange + 1 });
  const finalClient = await clientSnapshot(page);
  const finalServer = server.snapshot();
  assert.equal(finalClient.windowInstanceId, initial.windowInstanceId);
  assert.equal(finalClient.openSocketGenerations.length, 1);
  assert.equal(finalServer.openConnections, 1);
  assert.equal(finalClient.metrics.threadResumeCalls, 0);
  assert.equal(finalClient.metrics.fullBootstrapCalls, 0);
  assert.equal(finalClient.bufferedCursors.length, 0);
  assert.deepEqual(finalClient.canonical, finalServer.canonical);
  assert.equal(finalServer.stats.calibrations, 2);
  assert.equal(finalServer.stats.staleCalibrationResponses, 1);
  assert.equal(finalServer.stats.completedCalibrationResponses, 1);
  assert.deepEqual(pageErrors, []);

  console.log(JSON.stringify({
    ok: true,
    transport: {
      socketsCreated: finalClient.metrics.socketsCreated,
      socketsOpened: finalClient.metrics.socketsOpened,
      activeSocketCount: finalClient.openSocketGenerations.length,
      singleFlightJoins: finalClient.metrics.singleFlightJoins,
      generationsRetired: finalClient.metrics.generationsRetired,
      staleFramesIgnored: finalClient.metrics.staleFramesIgnored,
      browserCloseCodes: finalClient.metrics.closeCodes,
      serverCloseCodes: finalServer.stats.closeCodes,
      windowInstanceStable: finalClient.windowInstanceId === initial.windowInstanceId,
    },
    replay: {
      finalCursor: finalClient.eventCursor,
      liveReconnectReplayedEntities: 3,
      gapsDetected: finalClient.metrics.gapsDetected,
      rangeReplayRequests: finalClient.metrics.replayRequests,
      serverRangeReplays: finalServer.stats.rangeReplays,
      duplicateFramesIgnored: finalClient.metrics.duplicateFramesIgnored,
      threadResumeCalls: finalClient.metrics.threadResumeCalls,
      fullBootstrapCalls: finalClient.metrics.fullBootstrapCalls,
    },
    calibration: {
      eventLogGeneration: finalClient.eventLogGeneration,
      runtimeEpoch: finalClient.runtimeEpoch,
      started: finalClient.metrics.calibrationsStarted,
      discardedAsStale: finalClient.metrics.calibrationsDiscarded,
      completed: finalClient.metrics.calibrationsCompleted,
      bufferedAfterFence: finalClient.bufferedCursors.length,
      canonicalEntities: finalClient.canonical.length,
      clientMatchesServer: true,
    },
    protocol: {
      acceptedConnections: finalServer.stats.acceptedConnections,
      hellos: finalServer.stats.hellos,
      serverReplayedEvents: finalServer.stats.replayedEvents,
      applicationRpcMethods: ["hello", "replay", "calibrate"],
      reservedClientCloseCodesSent: 0,
    },
    limits: {
      readsProductionState: false,
      productionTransportImplemented: false,
      currentAppExecuted: false,
      usesRandomLoopbackPort: true,
      physicalMobileValidated: false,
      proxyTimeoutValidated: false,
      candidateReliabilityValidated: false,
    },
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function clientSnapshot(page) {
  return page.evaluate(() => window.__reconnectReference.snapshot());
}

async function waitForClient(page, predicate, expected = null) {
  await page.waitForFunction(({ source, expected }) => {
    const state = window.__reconnectReference?.snapshot();
    if (!state) return false;
    return Function(
      "state",
      "expected",
      `return (${source})(state, expected);`,
    )(state, expected);
  }, { source: predicate.toString(), expected });
}
