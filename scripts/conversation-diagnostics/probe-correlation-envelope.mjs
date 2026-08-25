import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = 2;
const SEED = 202643001;
const RUNS = 512;
const REQUIRED_EVENT_PATH = [
  "app-server:out",
  "backend:in",
  "backend:out",
  "gateway:in",
  "gateway:out",
  "browser:in",
  "store:local",
  "dom:local",
];
const ALLOWED_LAYERS = new Set([
  "browser",
  "gateway",
  "backend",
  "app-server",
  "store",
  "dom",
]);
const ALLOWED_DIRECTIONS = new Set(["in", "out", "local"]);
const SENSITIVE_ID_NAMES = new Set([
  "accountId",
  "clientInstanceId",
  "windowNonce",
  "windowInstanceId",
  "checkpointSlotId",
  "runtimeEpoch",
  "eventLogGeneration",
  "threadId",
  "turnId",
  "itemId",
  "clientSubmissionId",
]);
const SENSITIVE_RAW_MARKERS = [
  "account-private-",
  "client-private-",
  "window-nonce-private-",
  "window-private-",
  "checkpoint-slot-private-",
  "runtime-epoch-private-",
  "event-log-generation-private-",
  "thread-private-",
  "turn-private-",
  "item-private-",
  "submission-private-",
  "prompt-private-",
  "reply-private-",
  "sk-private-",
  "session=private-",
  "Bearer private-",
  "tool-output-private-",
  "diff-private-",
];

function main() {
  const digestKey = randomBytes(32);
  const recorder = new CorrelationRecorder({
    captureId: deterministicUuid(SEED, "capture"),
    digestKey,
    startedAtUnixMs: 1_785_450_000_000,
  });
  const traces = [];

  for (let run = 0; run < RUNS; run += 1) {
    const scenario = buildScenario(run);
    traces.push(recordScenario(recorder, scenario));
  }

  validateCapture(recorder.records, traces);
  validateFaultDetection(recorder.records, traces[0]);
  validatePrivacy(recorder.records, SENSITIVE_RAW_MARKERS);
  const fileEvidence = verifyPrivateNdjson(recorder.records, digestKey);

  console.log(JSON.stringify({
    ok: true,
    probe: "conversation-correlation-envelope",
    productionCodeExercised: false,
    externalNetworkAccessed: false,
    rescueWindowAccessed: false,
    schemaVersion: SCHEMA_VERSION,
    seed: SEED,
    runs: RUNS,
    records: recorder.records.length,
    eventPathRecords: RUNS * REQUIRED_EVENT_PATH.length,
    lifecycleRecords: recorder.records.length
      - (RUNS * REQUIRED_EVENT_PATH.length),
    generations: {
      browserDocuments: RUNS * 2,
      browserSockets: RUNS * 2,
      gatewayConnections: RUNS * 2,
      gatewayUpstreams: RUNS * 3,
      backendConnections: RUNS * 3,
      appServerInstances: RUNS * 2,
    },
    privacy: {
      rawSensitiveIdsPresent: false,
      rawPromptReplyCredentialsOrDiffPresent: false,
      digestAlgorithm: "hmac-sha256",
      digestKeyId: recorder.digestKeyId,
      keyPersistedAfterProbe: false,
    },
    faultDetection: {
      missingLayerDetected: true,
      duplicateLayerSequenceDetected: true,
      parentConnectionMismatchDetected: true,
    },
    fileEvidence,
    boundaries: {
      outputContainsMetadataOnly: true,
      productionLoggingHookInstalled: false,
      formalInstallOrUpdateHook: false,
    },
  }, null, 2));
}

class CorrelationRecorder {
  constructor({ captureId, digestKey: key, startedAtUnixMs }) {
    this.captureId = captureId;
    this.digestKey = key;
    this.digestKeyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    this.startedAtUnixMs = startedAtUnixMs;
    this.monotonicTick = 0;
    this.layerSequences = new Map();
    this.records = [];
  }

  record({
    traceId,
    layer,
    direction,
    kind,
    connections = {},
    identifiers = {},
    method = null,
    payload = null,
    upstreamEventSequence = null,
    eventCursor = null,
    deliveryKind = null,
    rpcId = null,
    close = null,
    queue = null,
  }) {
    assert.equal(ALLOWED_LAYERS.has(layer), true);
    assert.equal(ALLOWED_DIRECTIONS.has(direction), true);
    const layerSequence = (this.layerSequences.get(layer) || 0) + 1;
    this.layerSequences.set(layer, layerSequence);
    this.monotonicTick += 1;

    const record = {
      schemaVersion: SCHEMA_VERSION,
      captureId: this.captureId,
      traceId,
      layer,
      direction,
      kind,
      layerSequence,
      atMonoMs: this.monotonicTick / 10,
      atUnixMs: this.startedAtUnixMs + this.monotonicTick,
      digestAlgorithm: "hmac-sha256",
      digestKeyId: this.digestKeyId,
      ...sanitizeConnections(connections),
      ...this.digestIdentifiers(identifiers),
    };

    if (method) record.method = validateMethod(method);
    if (payload !== null) {
      const serialized = stableSerialize(payload);
      record.payloadBytes = Buffer.byteLength(serialized);
      record.payloadDigest = hmacDigest(
        this.digestKey,
        "payload",
        serialized,
      );
    }
    if (Number.isSafeInteger(upstreamEventSequence)) {
      record.upstreamEventSequence = upstreamEventSequence;
    }
    if (Number.isSafeInteger(eventCursor)) record.eventCursor = eventCursor;
    if (deliveryKind) {
      assert.equal(["full", "skip", "barrier"].includes(deliveryKind), true);
      record.deliveryKind = deliveryKind;
    }
    if (rpcId !== null) {
      record.rpcIdDigest = hmacDigest(this.digestKey, "rpcId", String(rpcId));
    }
    if (close) {
      record.closeCode = validateCloseCode(close.code);
      record.closeReasonClass = validateCloseReasonClass(close.reasonClass);
      record.wasClean = close.wasClean === true;
      record.connectionLifetimeMs = validateNonNegativeNumber(
        close.connectionLifetimeMs,
      );
      record.visibility = close.visibility === "hidden" ? "hidden" : "visible";
      record.online = close.online === true;
    }
    if (queue) {
      record.queueMessages = validateNonNegativeInteger(queue.messages);
      record.queueBytes = validateNonNegativeInteger(queue.bytes);
      record.bufferedAmount = validateNonNegativeInteger(queue.bufferedAmount);
      record.drainWaitMs = validateNonNegativeNumber(queue.drainWaitMs);
    }
    this.records.push(Object.freeze(record));
    return record;
  }

  digestIdentifiers(identifiers) {
    const result = {};
    for (const [name, value] of Object.entries(identifiers)) {
      assert.equal(SENSITIVE_ID_NAMES.has(name), true);
      if (value === null || value === undefined || value === "") continue;
      result[`${name}Digest`] = hmacDigest(
        this.digestKey,
        name,
        String(value),
      );
    }
    return result;
  }
}

function buildScenario(run) {
  const seed = `${SEED}:${run}`;
  const ids = {
    accountId: `account-private-${seed}`,
    clientInstanceId: `client-private-${seed}`,
    windowNonce: `window-nonce-private-${seed}`,
    windowInstanceId: `window-private-${seed}`,
    checkpointSlotId: `checkpoint-slot-private-${seed}`,
    runtimeEpoch: `runtime-epoch-private-${seed}`,
    eventLogGeneration: `event-log-generation-private-${seed}`,
    threadId: `thread-private-${seed}`,
    turnId: `turn-private-${seed}`,
    itemId: `item-private-${seed}`,
    clientSubmissionId: `submission-private-${seed}`,
  };
  const privateContent = {
    prompt: `prompt-private-${seed}`,
    reply: `reply-private-${seed}`,
    apiKey: `sk-private-${seed}`,
    cookie: `session=private-${seed}`,
    authorization: `Bearer private-${seed}`,
    toolOutput: `tool-output-private-${seed}`,
    diff: `diff-private-${seed}`,
  };
  return {
    run,
    traceId: deterministicUuid(seed, "trace"),
    identifiers: ids,
    privateContent,
    eventPayload: {
      method: "item/completed",
      params: {
        threadId: ids.threadId,
        turnId: ids.turnId,
        item: {
          id: ids.itemId,
          type: "agentMessage",
          text: privateContent.reply,
        },
        privacyFixture: privateContent,
      },
    },
    connections: {
      browserSocketId: deterministicUuid(seed, "browser-socket-1"),
      gatewayConnectionId: deterministicUuid(seed, "gateway-connection-1"),
      gatewayUpstreamId: deterministicUuid(seed, "gateway-upstream-1"),
      backendConnectionId: deterministicUuid(seed, "backend-connection-1"),
      appServerInstanceId: deterministicUuid(seed, "app-server-1"),
    },
    reconnect: {
      gatewayUpstreamId: deterministicUuid(seed, "gateway-upstream-2"),
      backendConnectionId: deterministicUuid(seed, "backend-connection-2"),
      appServerInstanceId: deterministicUuid(seed, "app-server-2"),
      runtimeEpoch: `runtime-epoch-private-${seed}-next`,
    },
    reload: {
      browserSocketId: deterministicUuid(seed, "browser-socket-2"),
      gatewayConnectionId: deterministicUuid(seed, "gateway-connection-2"),
      gatewayUpstreamId: deterministicUuid(seed, "gateway-upstream-3"),
      backendConnectionId: deterministicUuid(seed, "backend-connection-3"),
      windowNonce: `window-nonce-private-${seed}-reload`,
      windowInstanceId: `window-private-${seed}-reload`,
      checkpointSlotId: `checkpoint-slot-private-${seed}-reload`,
    },
  };
}

function recordScenario(capture, scenario) {
  const {
    traceId,
    identifiers,
    connections,
    eventPayload,
    reconnect,
    reload,
  } = scenario;
  const commonIdentifiers = { ...identifiers };
  const lifecycle = [];
  lifecycle.push(capture.record({
    traceId,
    layer: "browser",
    direction: "local",
    kind: "socket/open",
    connections,
    identifiers: commonIdentifiers,
  }));
  lifecycle.push(capture.record({
    traceId,
    layer: "gateway",
    direction: "in",
    kind: "socket/open",
    connections,
    identifiers: commonIdentifiers,
  }));
  lifecycle.push(capture.record({
    traceId,
    layer: "backend",
    direction: "in",
    kind: "socket/open",
    connections,
    identifiers: commonIdentifiers,
  }));

  const eventPath = [];
  for (const [layer, direction] of REQUIRED_EVENT_PATH.map((entry) => (
    entry.split(":")
  ))) {
    const isProjection = layer === "store" || layer === "dom";
    eventPath.push(capture.record({
      traceId,
      layer,
      direction,
      kind: isProjection ? "projection/apply" : "event/transfer",
      connections,
      identifiers: commonIdentifiers,
      method: "item/completed",
      payload: isProjection ? null : eventPayload,
      upstreamEventSequence: 41,
      eventCursor: 1_000 + scenario.run,
      deliveryKind: "full",
      queue: layer === "gateway" || layer === "backend"
        ? { messages: 1, bytes: 512, bufferedAmount: 0, drainWaitMs: 0 }
        : null,
    }));
  }

  lifecycle.push(capture.record({
    traceId,
    layer: "gateway",
    direction: "local",
    kind: "upstream/close",
    connections,
    identifiers: commonIdentifiers,
    close: {
      code: 1012,
      reasonClass: "backend-switch",
      wasClean: true,
      connectionLifetimeMs: 25_000,
      visibility: "visible",
      online: true,
    },
  }));
  const reconnectedConnections = {
    ...connections,
    gatewayUpstreamId: reconnect.gatewayUpstreamId,
    backendConnectionId: reconnect.backendConnectionId,
    appServerInstanceId: reconnect.appServerInstanceId,
  };
  lifecycle.push(capture.record({
    traceId,
    layer: "gateway",
    direction: "out",
    kind: "upstream/open",
    connections: reconnectedConnections,
    identifiers: {
      ...commonIdentifiers,
      runtimeEpoch: reconnect.runtimeEpoch,
    },
  }));
  lifecycle.push(capture.record({
    traceId,
    layer: "backend",
    direction: "in",
    kind: "socket/open",
    connections: reconnectedConnections,
    identifiers: {
      ...commonIdentifiers,
      runtimeEpoch: reconnect.runtimeEpoch,
    },
  }));

  lifecycle.push(capture.record({
    traceId,
    layer: "browser",
    direction: "local",
    kind: "document/reload",
    connections,
    identifiers: commonIdentifiers,
  }));
  const reloadedConnections = {
    browserSocketId: reload.browserSocketId,
    gatewayConnectionId: reload.gatewayConnectionId,
    gatewayUpstreamId: reload.gatewayUpstreamId,
    backendConnectionId: reload.backendConnectionId,
    appServerInstanceId: reconnect.appServerInstanceId,
  };
  const reloadedIdentifiers = {
    ...commonIdentifiers,
    windowNonce: reload.windowNonce,
    windowInstanceId: reload.windowInstanceId,
    checkpointSlotId: reload.checkpointSlotId,
    runtimeEpoch: reconnect.runtimeEpoch,
  };
  lifecycle.push(capture.record({
    traceId,
    layer: "browser",
    direction: "local",
    kind: "socket/open",
    connections: reloadedConnections,
    identifiers: reloadedIdentifiers,
  }));
  lifecycle.push(capture.record({
    traceId,
    layer: "gateway",
    direction: "in",
    kind: "socket/open",
    connections: reloadedConnections,
    identifiers: reloadedIdentifiers,
  }));
  lifecycle.push(capture.record({
    traceId,
    layer: "backend",
    direction: "in",
    kind: "socket/open",
    connections: reloadedConnections,
    identifiers: reloadedIdentifiers,
  }));

  return {
    traceId,
    eventPath,
    lifecycle,
    connections,
    reconnectedConnections,
    reloadedConnections,
    identifiers,
    reloadedIdentifiers,
  };
}

function validateCapture(records, tracesToValidate) {
  assertMonotonicLayerSequences(records);
  for (const trace of tracesToValidate) {
    assertEventPath(trace.eventPath);
    assertConnectionGraph(trace);
    assertReloadIdentity(trace);
  }
}

function assertMonotonicLayerSequences(records) {
  const last = new Map();
  for (const record of records) {
    const previous = last.get(record.layer) || 0;
    assert.equal(record.layerSequence, previous + 1);
    last.set(record.layer, record.layerSequence);
  }
}

function assertEventPath(eventPath) {
  assert.deepEqual(
    eventPath.map((record) => `${record.layer}:${record.direction}`),
    REQUIRED_EVENT_PATH,
  );
  const transportRecords = eventPath.filter((record) => (
    !["store", "dom"].includes(record.layer)
  ));
  assert.equal(
    new Set(transportRecords.map((record) => record.payloadDigest)).size,
    1,
  );
  for (const field of [
    "accountIdDigest",
    "threadIdDigest",
    "turnIdDigest",
    "itemIdDigest",
    "runtimeEpochDigest",
  ]) {
    assert.equal(new Set(eventPath.map((record) => record[field])).size, 1);
  }
  assert.equal(
    new Set(eventPath.map((record) => record.upstreamEventSequence)).size,
    1,
  );
  assert.equal(new Set(eventPath.map((record) => record.eventCursor)).size, 1);
}

function assertConnectionGraph(trace) {
  assert.equal(
    trace.connections.gatewayConnectionId,
    trace.reconnectedConnections.gatewayConnectionId,
  );
  assert.notEqual(
    trace.connections.gatewayUpstreamId,
    trace.reconnectedConnections.gatewayUpstreamId,
  );
  assert.notEqual(
    trace.connections.backendConnectionId,
    trace.reconnectedConnections.backendConnectionId,
  );
  assert.notEqual(
    trace.reconnectedConnections.gatewayConnectionId,
    trace.reloadedConnections.gatewayConnectionId,
  );
}

function assertReloadIdentity(trace) {
  assert.equal(
    trace.identifiers.clientInstanceId,
    trace.reloadedIdentifiers.clientInstanceId,
  );
  assert.notEqual(
    trace.identifiers.windowNonce,
    trace.reloadedIdentifiers.windowNonce,
  );
  assert.notEqual(
    trace.identifiers.windowInstanceId,
    trace.reloadedIdentifiers.windowInstanceId,
  );
  assert.notEqual(
    trace.identifiers.checkpointSlotId,
    trace.reloadedIdentifiers.checkpointSlotId,
  );
}

function validateFaultDetection(records, trace) {
  assert.throws(
    () => assertEventPath(
      trace.eventPath.filter((record) => (
        !(record.layer === "gateway" && record.direction === "out")
      )),
    ),
  );

  const duplicateSequence = records.map((record) => ({ ...record }));
  const browserIndexes = duplicateSequence
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.layer === "browser")
    .slice(0, 2);
  duplicateSequence[browserIndexes[1].index].layerSequence =
    duplicateSequence[browserIndexes[0].index].layerSequence;
  assert.throws(() => assertMonotonicLayerSequences(duplicateSequence));

  const mismatchedTrace = structuredClone(trace);
  mismatchedTrace.reconnectedConnections.gatewayConnectionId =
    deterministicUuid(SEED, "mismatched-parent");
  assert.throws(() => assertConnectionGraph(mismatchedTrace));
}

function validatePrivacy(records, rawMarkers) {
  const serialized = records.map((record) => JSON.stringify(record)).join("\n");
  for (const marker of rawMarkers) {
    assert.equal(
      serialized.includes(marker),
      false,
      `raw sensitive value leaked: ${marker}`,
    );
  }
  for (const record of records) {
    for (const field of Object.keys(record)) {
      assert.equal(SENSITIVE_ID_NAMES.has(field), false);
    }
    assert.equal(Object.hasOwn(record, "payload"), false);
    assert.equal(Object.hasOwn(record, "params"), false);
    assert.equal(Object.hasOwn(record, "text"), false);
    assert.equal(Object.hasOwn(record, "content"), false);
  }
}

function verifyPrivateNdjson(records, key) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "wfl-correlation-envelope-"),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const tracePath = path.join(temporaryRoot, "trace.ndjson");
  const keyPath = path.join(temporaryRoot, "digest.key");
  try {
    writeExclusive(tracePath, records.map((record) => (
      JSON.stringify(record)
    )).join("\n") + "\n");
    writeExclusive(keyPath, key);
    assert.equal(fs.statSync(tracePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    const parsed = fs.readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(parsed.length, records.length);
    return {
      traceMode: "0600",
      keyMode: "0600",
      ndjsonRowsRoundTripped: parsed.length,
      temporaryFilesRemoved: true,
    };
  } finally {
    const resolved = path.resolve(temporaryRoot);
    const prefix = path.join(
      fs.realpathSync(os.tmpdir()),
      "wfl-correlation-envelope-",
    );
    assert.equal(resolved.startsWith(prefix), true);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function writeExclusive(targetPath, data) {
  const descriptor = fs.openSync(targetPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sanitizeConnections(connections) {
  const result = {};
  for (const name of [
    "browserSocketId",
    "gatewayConnectionId",
    "gatewayUpstreamId",
    "backendConnectionId",
    "appServerInstanceId",
  ]) {
    const value = connections[name];
    if (value === null || value === undefined || value === "") continue;
    assert.match(String(value), /^[0-9a-f-]{36}$/);
    result[name] = String(value);
  }
  return result;
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
  )).join(",")}}`;
}

function hmacDigest(key, namespace, value) {
  return createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex");
}

function deterministicUuid(seed, label) {
  const digest = createHash("sha256")
    .update(String(seed))
    .update("\0")
    .update(label)
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function validateMethod(method) {
  const value = String(method);
  assert.match(value, /^[a-zA-Z][a-zA-Z0-9_/-]{0,127}$/);
  return value;
}

function validateCloseCode(value) {
  assert.equal(Number.isInteger(value), true);
  assert.ok(value >= 1000 && value <= 4999);
  return value;
}

function validateCloseReasonClass(value) {
  assert.equal([
    "normal",
    "browser-offline",
    "backend-switch",
    "heartbeat-timeout",
    "authentication",
    "network",
    "unknown",
  ].includes(value), true);
  return value;
}

function validateNonNegativeInteger(value) {
  assert.equal(Number.isSafeInteger(value), true);
  assert.ok(value >= 0);
  return value;
}

function validateNonNegativeNumber(value) {
  assert.equal(Number.isFinite(value), true);
  assert.ok(value >= 0);
  return Math.round(value * 1000) / 1000;
}

main();
