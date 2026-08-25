import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_NOW = 1_785_451_000_000;
const MAX_DURATION_MS = 10 * 60 * 1000;
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENTS_PER_COMPONENT = 4;
const MAX_LINE_BYTES = 8 * 1024;
const IDENTIFIER_NAMES = new Set([
  "accountId",
  "clientInstanceId",
  "windowNonce",
  "windowInstanceId",
  "checkpointSlotId",
  "runtimeEpoch",
  "eventLogGeneration",
  "rpcId",
  "threadId",
  "turnId",
  "itemId",
  "clientSubmissionId",
]);
const CONNECTION_NAMES = new Set([
  "browserSocketId",
  "gatewayConnectionId",
  "gatewayUpstreamId",
  "backendConnectionId",
  "appServerInstanceId",
]);
const ALLOWED_RECORD_KEYS = new Set([
  "channel",
  "layer",
  "direction",
  "kind",
  "traceId",
  "connections",
  "identifiers",
  "method",
  "payloadBytes",
  "closeCode",
  "closeReasonClass",
  "visibility",
  "online",
]);

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "wfl-shadow-recorder-lifecycle-"),
);
fs.chmodSync(temporaryRoot, 0o700);

async function main() {
  try {
    const disabled = verifyDisabledState();
    const invalidManifests = verifyInvalidManifests();
    const capacity = await verifyCapacityRotationAndOverflow();
    const expiry = await verifyExpiryAndManifestMutation();
    const receipts = await verifyBrowserReceiptAdmission();
    const componentIsolation = await verifyComponentIoIsolation();

    console.log(JSON.stringify({
      ok: true,
      probe: "conversation-shadow-recorder-lifecycle",
      productionCodeExercised: false,
      externalNetworkAccessed: false,
      rescueWindowAccessed: false,
      disabled,
      invalidManifests,
      capacity,
      expiry,
      receipts,
      componentIsolation,
      invariants: {
        defaultOffCreatesNoSegments: true,
        rescueAndVncRejectedBeforeWrite: true,
        onlyOwnerLocalManifestAccepted: true,
        manifestAndKeyMustBeRealOwnerMode0600Files: true,
        recordNeverThrowsIntoBusinessCaller: true,
        queueOverflowDropsTraceOnly: true,
        ioFailureSealsOnlyFailingComponent: true,
        captureNeverAutoRenews: true,
        rawContentAndStableIdsAbsent: true,
        formalInstallOrUpdateHook: false,
      },
      temporaryFilesRemoved: true,
    }, null, 2));
  } finally {
    assertTemporaryProbeRoot(temporaryRoot);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyDisabledState() {
  const captureRoot = scenarioPath("disabled");
  const loaded = loadCapture(captureRoot, BASE_NOW);
  assert.equal(loaded, null);
  assert.equal(fs.existsSync(path.join(captureRoot, "segments")), false);
  return {
    manifestPresent: false,
    recorderState: "disabled",
    segmentFilesCreated: 0,
  };
}

function verifyInvalidManifests() {
  const failures = [];
  const cases = [
    {
      name: "rescue-surface",
      mutate: (manifest) => {
        manifest.scope.surface = "rescue";
      },
    },
    {
      name: "wildcard-surface",
      mutate: (manifest) => {
        manifest.scope.surface = "*";
      },
    },
    {
      name: "vnc-surface",
      mutate: (manifest) => {
        manifest.scope.surface = "vnc";
      },
    },
    {
      name: "expired",
      mutate: (manifest) => {
        manifest.expiresAt = BASE_NOW - 1;
      },
    },
    {
      name: "duration-over-hard-limit",
      mutate: (manifest) => {
        manifest.expiresAt = manifest.issuedAt + MAX_DURATION_MS + 1;
        manifest.budgets.durationMs = MAX_DURATION_MS + 1;
      },
    },
    {
      name: "not-owner-local",
      mutate: (manifest) => {
        manifest.authorizedBy = "admin-ui";
      },
    },
    {
      name: "unknown-component",
      mutate: (manifest) => {
        manifest.components = ["gateway", "rescue"];
      },
    },
  ];

  for (const testCase of cases) {
    const prepared = prepareCapture(
      scenarioPath(`invalid-${testCase.name}`),
      testCase.mutate,
    );
    assert.throws(() => loadCapture(prepared.root, BASE_NOW));
    assert.equal(fs.existsSync(path.join(prepared.root, "segments")), false);
    failures.push(testCase.name);
  }

  const badMode = prepareCapture(scenarioPath("invalid-manifest-mode"));
  fs.chmodSync(badMode.manifestPath, 0o644);
  assert.throws(() => loadCapture(badMode.root, BASE_NOW));
  assert.equal(fs.existsSync(path.join(badMode.root, "segments")), false);
  failures.push("manifest-mode");

  const badKeyMode = prepareCapture(scenarioPath("invalid-key-mode"));
  fs.chmodSync(badKeyMode.keyPath, 0o644);
  assert.throws(() => loadCapture(badKeyMode.root, BASE_NOW));
  assert.equal(fs.existsSync(path.join(badKeyMode.root, "segments")), false);
  failures.push("key-mode");

  const symlinkKey = prepareCapture(scenarioPath("invalid-symlink-key"));
  const alternateKey = path.join(symlinkKey.root, "alternate.key");
  writeExclusive(alternateKey, randomBytes(32), 0o600);
  fs.unlinkSync(symlinkKey.keyPath);
  fs.symlinkSync(alternateKey, symlinkKey.keyPath);
  assert.throws(() => loadCapture(symlinkKey.root, BASE_NOW));
  assert.equal(fs.existsSync(path.join(symlinkKey.root, "segments")), false);
  failures.push("symlink-key");

  return {
    rejected: failures,
    rejectedBeforeSegmentCreation: failures.length,
  };
}

async function verifyCapacityRotationAndOverflow() {
  const prepared = prepareCapture(
    scenarioPath("capacity"),
    null,
    {
      durationMs: 5_000,
      segmentBytes: 4 * 1024,
      segmentsPerComponent: 4,
    },
  );
  const capture = loadCapture(prepared.root, BASE_NOW);
  const recorder = await ShadowRecorder.create(capture, "backend", {
    queueMessages: 24,
    queueBytes: 12 * 1024,
  });
  let businessEventsProcessed = 0;
  let recordCallsAccepted = 0;

  for (let batch = 0; batch < 64 && recorder.state === "active"; batch += 1) {
    for (let index = 0; index < 80; index += 1) {
      businessEventsProcessed += 1;
      if (recorder.record(makeRecord({
        accountId: capture.manifest.scope.targetUserId,
        sequence: (batch * 80) + index,
      }))) {
        recordCallsAccepted += 1;
      }
    }
    await recorder.flush(BASE_NOW + batch);
  }
  await recorder.close();

  assert.equal(recorder.state, "sealed");
  assert.equal(recorder.sealReason, "capacity");
  assert.ok(recorder.counters.queueDropped > 0);
  assert.ok(businessEventsProcessed > recordCallsAccepted);
  const fileEvidence = inspectSegments(recorder.componentRoot, {
    maximumBytes: capture.manifest.budgets.segmentBytes,
    rawMarkers: [
      "account-private-capacity",
      "thread-private-",
      "reply-private-",
      "sk-private-",
    ],
  });
  assert.equal(fileEvidence.files, 4);

  return {
    state: recorder.state,
    sealReason: recorder.sealReason,
    segmentFiles: fileEvidence.files,
    segmentMode: "0600",
    maximumSegmentBytes: fileEvidence.maximumObservedBytes,
    recordCallsAccepted,
    queueDropped: recorder.counters.queueDropped,
    capacityDropped: recorder.counters.capacityDropped,
    businessEventsProcessed,
    businessEventsInterrupted: 0,
    scaledProbeBudgets: true,
  };
}

async function verifyExpiryAndManifestMutation() {
  const expiringPrepared = prepareCapture(
    scenarioPath("expiry"),
    null,
    {
      durationMs: 1_000,
      segmentBytes: 16 * 1024,
      segmentsPerComponent: 2,
    },
  );
  const expiringCapture = loadCapture(expiringPrepared.root, BASE_NOW);
  const expiring = await ShadowRecorder.create(expiringCapture, "gateway");
  assert.equal(expiring.record(makeRecord({
    accountId: expiringCapture.manifest.scope.targetUserId,
    sequence: 1,
  })), true);
  await expiring.flush(BASE_NOW);
  await expiring.tick(expiringCapture.manifest.expiresAt + 1);
  assert.equal(expiring.state, "sealed");
  assert.equal(expiring.sealReason, "expired");
  assert.equal(expiring.record(makeRecord({
    accountId: expiringCapture.manifest.scope.targetUserId,
    sequence: 2,
  })), false);

  const mutationPrepared = prepareCapture(
    scenarioPath("manifest-mutation"),
    null,
    {
      durationMs: 5_000,
      segmentBytes: 16 * 1024,
      segmentsPerComponent: 2,
    },
  );
  const mutationCapture = loadCapture(mutationPrepared.root, BASE_NOW);
  const mutation = await ShadowRecorder.create(mutationCapture, "backend");
  assert.equal(mutation.record(makeRecord({
    accountId: mutationCapture.manifest.scope.targetUserId,
    sequence: 1,
  })), true);
  const changed = {
    ...mutationCapture.manifest,
    browserReceiptToken: "changed-token-must-seal",
  };
  fs.writeFileSync(
    mutationPrepared.manifestPath,
    `${JSON.stringify(changed, null, 2)}\n`,
  );
  fs.chmodSync(mutationPrepared.manifestPath, 0o600);
  await mutation.flush(BASE_NOW + 1);
  assert.equal(mutation.state, "sealed");
  assert.equal(mutation.sealReason, "manifest-changed");

  const keyPrepared = prepareCapture(
    scenarioPath("key-mutation"),
    null,
    {
      durationMs: 5_000,
      segmentBytes: 16 * 1024,
      segmentsPerComponent: 2,
    },
  );
  const keyCapture = loadCapture(keyPrepared.root, BASE_NOW);
  const keyMutation = await ShadowRecorder.create(keyCapture, "gateway");
  assert.equal(keyMutation.record(makeRecord({
    accountId: keyCapture.manifest.scope.targetUserId,
    sequence: 1,
  })), true);
  fs.writeFileSync(keyPrepared.keyPath, randomBytes(32));
  fs.chmodSync(keyPrepared.keyPath, 0o600);
  await keyMutation.flush(BASE_NOW + 1);
  assert.equal(keyMutation.state, "sealed");
  assert.equal(keyMutation.sealReason, "manifest-changed");

  const revokePrepared = prepareCapture(
    scenarioPath("explicit-revoke"),
    null,
    {
      durationMs: 5_000,
      segmentBytes: 16 * 1024,
      segmentsPerComponent: 2,
    },
  );
  const revokeCapture = loadCapture(revokePrepared.root, BASE_NOW);
  const revoked = await ShadowRecorder.create(revokeCapture, "backend");
  await revoked.revoke();
  assert.equal(revoked.state, "sealed");
  assert.equal(revoked.sealReason, "revoked");
  assert.equal(revoked.record(makeRecord({
    accountId: revokeCapture.manifest.scope.targetUserId,
    sequence: 1,
  })), false);

  return {
    expiredCapture: {
      state: expiring.state,
      sealReason: expiring.sealReason,
      postExpiryRecordAccepted: false,
      autoRenewed: false,
    },
    manifestMutation: {
      state: mutation.state,
      sealReason: mutation.sealReason,
      businessInterrupted: false,
    },
    keyMutation: {
      state: keyMutation.state,
      sealReason: keyMutation.sealReason,
      businessInterrupted: false,
    },
    explicitRevoke: {
      state: revoked.state,
      sealReason: revoked.sealReason,
      postRevokeRecordAccepted: false,
      businessInterrupted: false,
    },
  };
}

async function verifyBrowserReceiptAdmission() {
  const prepared = prepareCapture(
    scenarioPath("browser-receipts"),
    null,
    {
      durationMs: 5_000,
      segmentBytes: 32 * 1024,
      segmentsPerComponent: 2,
    },
  );
  const capture = loadCapture(prepared.root, BASE_NOW);
  const recorder = await ShadowRecorder.create(capture, "backend");
  const receipt = makeRecord({
    accountId: capture.manifest.scope.targetUserId,
    sequence: 1,
    layer: "browser",
  });
  const validContext = {
    captureId: capture.manifest.captureId,
    token: capture.manifest.browserReceiptToken,
    authenticatedUserId: capture.manifest.scope.targetUserId,
    channel: "main",
  };

  assert.equal(recorder.acceptBrowserReceipt(receipt, validContext), true);
  assert.equal(recorder.acceptBrowserReceipt(receipt, {
    ...validContext,
    token: "wrong-token",
  }), false);
  assert.equal(recorder.acceptBrowserReceipt(receipt, {
    ...validContext,
    authenticatedUserId: "other-user",
  }), false);
  assert.equal(recorder.acceptBrowserReceipt(receipt, {
    ...validContext,
    channel: "rescue",
  }), false);
  assert.equal(recorder.acceptBrowserReceipt(receipt, {
    ...validContext,
    channel: "vnc",
  }), false);
  assert.equal(recorder.acceptBrowserReceipt({
    ...receipt,
    prompt: "reply-private-must-not-be-recorded",
  }, validContext), false);
  await recorder.flush(BASE_NOW + 1);
  await recorder.close("probe-complete");

  const evidence = inspectSegments(recorder.componentRoot, {
    maximumBytes: capture.manifest.budgets.segmentBytes,
    rawMarkers: [
      capture.manifest.scope.targetUserId,
      capture.manifest.browserReceiptToken,
      "reply-private-must-not-be-recorded",
    ],
  });
  assert.equal(evidence.ndjsonRows, 1);

  return {
    accepted: 1,
    wrongTokenRejected: 1,
    crossAccountRejected: 1,
    rescueRejected: 1,
    vncRejected: 1,
    unknownContentFieldRejected: 1,
    rawReceiptTokenWritten: false,
    rawAccountIdWritten: false,
  };
}

async function verifyComponentIoIsolation() {
  const prepared = prepareCapture(
    scenarioPath("component-io"),
    null,
    {
      durationMs: 5_000,
      segmentBytes: 32 * 1024,
      segmentsPerComponent: 2,
    },
  );
  const capture = loadCapture(prepared.root, BASE_NOW);
  const gateway = await ShadowRecorder.create(capture, "gateway", {
    failFlushAt: 1,
  });
  const backend = await ShadowRecorder.create(capture, "backend");
  const record = makeRecord({
    accountId: capture.manifest.scope.targetUserId,
    sequence: 1,
  });
  assert.equal(gateway.record({ ...record, layer: "gateway" }), true);
  assert.equal(backend.record({ ...record, layer: "backend" }), true);
  let businessEventsProcessed = 0;
  businessEventsProcessed += 1;
  await Promise.all([
    gateway.flush(BASE_NOW + 1),
    backend.flush(BASE_NOW + 1),
  ]);
  businessEventsProcessed += 1;

  assert.equal(gateway.state, "sealed");
  assert.equal(gateway.sealReason, "io-error");
  assert.equal(backend.state, "active");
  assert.equal(backend.counters.written, 1);
  assert.equal(businessEventsProcessed, 2);
  await backend.close("probe-complete");

  return {
    gateway: {
      state: gateway.state,
      sealReason: gateway.sealReason,
    },
    backend: {
      stateBeforeClose: "active",
      rowsWritten: backend.counters.written,
    },
    businessEventsProcessed,
    businessEventsInterrupted: 0,
    readinessChanged: false,
    socketsClosed: 0,
  };
}

class ShadowRecorder {
  static async create(capture, component, options = {}) {
    assert.ok(capture);
    assert.equal(capture.manifest.components.includes(component), true);
    const recorder = new ShadowRecorder(capture, component, options);
    await fsp.mkdir(recorder.componentRoot, {
      recursive: true,
      mode: 0o700,
    });
    await fsp.chmod(recorder.componentRoot, 0o700);
    return recorder;
  }

  constructor(capture, component, {
    queueMessages = 1_024,
    queueBytes = 4 * 1024 * 1024,
    failFlushAt = null,
  } = {}) {
    this.capture = capture;
    this.component = component;
    this.state = "active";
    this.sealReason = null;
    this.queue = [];
    this.queueBytes = 0;
    this.queueMessageLimit = queueMessages;
    this.queueByteLimit = queueBytes;
    this.failFlushAt = failFlushAt;
    this.flushCalls = 0;
    this.sequence = 0;
    this.segmentOrdinal = 0;
    this.segmentBytes = 0;
    this.segmentHandle = null;
    this.componentProcessId = deterministicUuid(
      capture.manifest.captureId,
      `${component}-process`,
    );
    this.componentRoot = path.join(
      capture.root,
      "segments",
      `${component}-${this.componentProcessId}`,
    );
    this.counters = {
      accepted: 0,
      written: 0,
      queueDropped: 0,
      capacityDropped: 0,
      sealDropped: 0,
      invalidDropped: 0,
      receiptRejected: 0,
    };
  }

  record(input) {
    if (this.state !== "active") return false;
    try {
      const sanitized = sanitizeRecord(input, this);
      const line = `${JSON.stringify(sanitized)}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_LINE_BYTES) {
        this.counters.invalidDropped += 1;
        return false;
      }
      if (
        this.queue.length >= this.queueMessageLimit
        || this.queueBytes + bytes > this.queueByteLimit
      ) {
        this.counters.queueDropped += 1;
        return false;
      }
      this.queue.push({ line, bytes });
      this.queueBytes += bytes;
      this.counters.accepted += 1;
      return true;
    } catch {
      this.counters.invalidDropped += 1;
      return false;
    }
  }

  acceptBrowserReceipt(input, context) {
    const manifest = this.capture.manifest;
    if (
      this.state !== "active"
      || this.component !== "backend"
      || context?.captureId !== manifest.captureId
      || context?.token !== manifest.browserReceiptToken
      || context?.authenticatedUserId !== manifest.scope.targetUserId
      || context?.channel !== "main"
      || input?.layer !== "browser"
    ) {
      this.counters.receiptRejected += 1;
      return false;
    }
    return this.record(input);
  }

  async flush(now) {
    if (this.state !== "active") return;
    this.flushCalls += 1;
    if (now > this.capture.manifest.expiresAt) {
      await this.seal("expired");
      return;
    }
    if (!captureFilesUnchanged(this.capture)) {
      await this.seal("manifest-changed");
      return;
    }
    try {
      if (this.failFlushAt === this.flushCalls) {
        const error = new Error("injected recorder write failure");
        error.code = "EIO";
        throw error;
      }
      while (this.queue.length && this.state === "active") {
        const next = this.queue[0];
        if (!this.segmentHandle) await this.openNextSegment();
        if (
          this.segmentBytes > 0
          && this.segmentBytes + next.bytes
            > this.capture.manifest.budgets.segmentBytes
        ) {
          await this.rotateSegment();
          if (this.state !== "active") break;
        }
        if (next.bytes > this.capture.manifest.budgets.segmentBytes) {
          this.queue.shift();
          this.queueBytes -= next.bytes;
          this.counters.invalidDropped += 1;
          continue;
        }
        await this.segmentHandle.write(next.line);
        this.segmentBytes += next.bytes;
        this.queue.shift();
        this.queueBytes -= next.bytes;
        this.counters.written += 1;
      }
    } catch {
      await this.seal("io-error");
    }
  }

  async tick(now) {
    if (this.state !== "active") return;
    if (now > this.capture.manifest.expiresAt) {
      await this.seal("expired");
      return;
    }
    if (!captureFilesUnchanged(this.capture)) {
      await this.seal("manifest-changed");
    }
  }

  async revoke() {
    await this.seal("revoked");
  }

  async rotateSegment() {
    await this.closeSegment();
    if (
      this.segmentOrdinal
      >= this.capture.manifest.budgets.segmentsPerComponent
    ) {
      this.counters.capacityDropped += this.queue.length;
      this.queue = [];
      this.queueBytes = 0;
      await this.seal("capacity");
      return;
    }
    await this.openNextSegment();
  }

  async openNextSegment() {
    if (
      this.segmentOrdinal
      >= this.capture.manifest.budgets.segmentsPerComponent
    ) {
      this.counters.capacityDropped += this.queue.length;
      this.queue = [];
      this.queueBytes = 0;
      await this.seal("capacity");
      return;
    }
    this.segmentOrdinal += 1;
    const target = path.join(
      this.componentRoot,
      `${this.capture.manifest.captureId}-${this.component}-${String(
        this.segmentOrdinal,
      ).padStart(2, "0")}.ndjson`,
    );
    this.segmentHandle = await fsp.open(target, "wx", 0o600);
    await this.segmentHandle.chmod(0o600);
    this.segmentBytes = 0;
  }

  async closeSegment() {
    if (!this.segmentHandle) return;
    const handle = this.segmentHandle;
    this.segmentHandle = null;
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async seal(reason) {
    if (this.state !== "active") return;
    this.state = "sealed";
    this.sealReason = reason;
    await this.closeSegment();
    if (reason !== "capacity") {
      this.counters.sealDropped += this.queue.length;
      this.queue = [];
      this.queueBytes = 0;
    }
  }

  async close(reason = "process-exit") {
    if (this.state === "active") await this.seal(reason);
    else await this.closeSegment();
  }
}

function prepareCapture(
  root,
  mutateManifest = null,
  budgets = {
    durationMs: 5_000,
    segmentBytes: 32 * 1024,
    segmentsPerComponent: 2,
  },
) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const keyPath = path.join(root, "digest.key");
  const manifestPath = path.join(root, "capture.json");
  const key = randomBytes(32);
  const manifest = {
    schemaVersion: 1,
    captureId: deterministicUuid(root, "capture"),
    issuedAt: BASE_NOW,
    expiresAt: BASE_NOW + budgets.durationMs,
    authorizedBy: "owner-local",
    scope: {
      surface: "main",
      targetUserId: `account-private-${path.basename(root)}`,
    },
    browserReceiptToken: randomBytes(24).toString("base64url"),
    components: ["gateway", "backend"],
    budgets: { ...budgets },
  };
  mutateManifest?.(manifest);
  writeExclusive(keyPath, key, 0o600);
  writeExclusive(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  return { root, keyPath, manifestPath, manifest, key };
}

function loadCapture(root, now) {
  if (!fs.existsSync(root)) return null;
  const manifestPath = path.join(root, "capture.json");
  const keyPath = path.join(root, "digest.key");
  if (!fs.existsSync(manifestPath) && !fs.existsSync(keyPath)) return null;
  const rootStat = assertRealOwnedPath(root, "directory", 0o700);
  const manifestStat = assertRealOwnedPath(
    manifestPath,
    "file",
    0o600,
    rootStat,
  );
  const keyStat = assertRealOwnedPath(keyPath, "file", 0o600, rootStat);
  assert.equal(manifestStat.uid, keyStat.uid);
  assert.equal(manifestStat.gid, keyStat.gid);

  const manifestRaw = fs.readFileSync(manifestPath);
  const key = fs.readFileSync(keyPath);
  assert.equal(key.length, 32);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  validateManifest(manifest, now);
  const fingerprint = captureFingerprint(manifestRaw, key);
  return {
    root,
    manifestPath,
    keyPath,
    manifest,
    key,
    fingerprint,
  };
}

function validateManifest(manifest, now) {
  assert.equal(manifest?.schemaVersion, 1);
  assert.match(
    manifest.captureId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(manifest.authorizedBy, "owner-local");
  assert.equal(manifest.scope?.surface, "main");
  assert.match(manifest.scope?.targetUserId || "", /^[^\r\n\0]{1,256}$/);
  assert.match(
    manifest.browserReceiptToken || "",
    /^[A-Za-z0-9_-]{32,128}$/,
  );
  assert.equal(Number.isSafeInteger(manifest.issuedAt), true);
  assert.equal(Number.isSafeInteger(manifest.expiresAt), true);
  assert.ok(manifest.expiresAt > manifest.issuedAt);
  assert.ok(manifest.expiresAt > now);
  const duration = manifest.expiresAt - manifest.issuedAt;
  assert.ok(duration <= MAX_DURATION_MS);
  assert.equal(manifest.budgets?.durationMs, duration);
  assert.ok(
    Number.isSafeInteger(manifest.budgets.segmentBytes)
    && manifest.budgets.segmentBytes > 0
    && manifest.budgets.segmentBytes <= MAX_SEGMENT_BYTES,
  );
  assert.ok(
    Number.isSafeInteger(manifest.budgets.segmentsPerComponent)
    && manifest.budgets.segmentsPerComponent > 0
    && manifest.budgets.segmentsPerComponent
      <= MAX_SEGMENTS_PER_COMPONENT,
  );
  assert.ok(Array.isArray(manifest.components));
  assert.equal(new Set(manifest.components).size, manifest.components.length);
  assert.ok(manifest.components.length > 0);
  for (const component of manifest.components) {
    assert.equal(["gateway", "backend"].includes(component), true);
  }
}

function captureFilesUnchanged(capture) {
  try {
    assertRealOwnedPath(capture.root, "directory", 0o700);
    assertRealOwnedPath(capture.manifestPath, "file", 0o600);
    assertRealOwnedPath(capture.keyPath, "file", 0o600);
    const manifestRaw = fs.readFileSync(capture.manifestPath);
    const key = fs.readFileSync(capture.keyPath);
    return captureFingerprint(manifestRaw, key) === capture.fingerprint;
  } catch {
    return false;
  }
}

function sanitizeRecord(input, recorder) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  for (const key of Object.keys(input)) {
    assert.equal(ALLOWED_RECORD_KEYS.has(key), true);
  }
  assert.equal(input.channel, "main");
  assert.equal(
    ["browser", "gateway", "backend", "app-server", "store", "dom"]
      .includes(input.layer),
    true,
  );
  assert.equal(["in", "out", "local"].includes(input.direction), true);
  assert.match(input.kind, /^[a-z][a-z0-9_/-]{0,127}$/);
  assert.match(
    input.traceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  if (
    input.identifiers?.accountId
    && input.identifiers.accountId
      !== recorder.capture.manifest.scope.targetUserId
  ) {
    throw new Error("record belongs to another account");
  }
  recorder.sequence += 1;
  const output = {
    schemaVersion: 2,
    captureId: recorder.capture.manifest.captureId,
    component: recorder.component,
    componentProcessId: recorder.componentProcessId,
    componentSequence: recorder.sequence,
    traceId: input.traceId,
    layer: input.layer,
    direction: input.direction,
    kind: input.kind,
    atUnixMs: BASE_NOW + recorder.sequence,
    atMonoMs: recorder.sequence / 10,
    digestAlgorithm: "hmac-sha256",
    digestKeyId: createHash("sha256")
      .update(recorder.capture.key)
      .digest("hex")
      .slice(0, 16),
  };

  for (const [name, value] of Object.entries(input.connections || {})) {
    assert.equal(CONNECTION_NAMES.has(name), true);
    assert.match(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    output[name] = value;
  }
  for (const [name, value] of Object.entries(input.identifiers || {})) {
    assert.equal(IDENTIFIER_NAMES.has(name), true);
    output[`${name}Digest`] = hmacDigest(
      recorder.capture.key,
      name,
      String(value),
    );
  }
  if (input.method !== undefined) {
    assert.match(input.method, /^[A-Za-z][A-Za-z0-9_/-]{0,127}$/);
    output.method = input.method;
  }
  if (input.payloadBytes !== undefined) {
    assert.ok(
      Number.isSafeInteger(input.payloadBytes) && input.payloadBytes >= 0,
    );
    output.payloadBytes = input.payloadBytes;
  }
  if (input.closeCode !== undefined) {
    assert.ok(
      Number.isInteger(input.closeCode)
      && input.closeCode >= 1000
      && input.closeCode <= 4999,
    );
    output.closeCode = input.closeCode;
  }
  if (input.closeReasonClass !== undefined) {
    assert.equal([
      "normal",
      "browser-offline",
      "backend-switch",
      "heartbeat-timeout",
      "authentication",
      "network",
      "unknown",
    ].includes(input.closeReasonClass), true);
    output.closeReasonClass = input.closeReasonClass;
  }
  if (input.visibility !== undefined) {
    assert.equal(["visible", "hidden"].includes(input.visibility), true);
    output.visibility = input.visibility;
  }
  if (input.online !== undefined) output.online = input.online === true;
  return output;
}

function makeRecord({
  accountId,
  sequence,
  layer = "backend",
}) {
  const seed = `${accountId}:${sequence}:${layer}`;
  return {
    channel: "main",
    layer,
    direction: layer === "browser" ? "in" : "out",
    kind: "event/transfer",
    traceId: deterministicUuid(seed, "trace"),
    connections: {
      browserSocketId: deterministicUuid(seed, "browser-socket"),
      gatewayConnectionId: deterministicUuid(seed, "gateway-connection"),
      gatewayUpstreamId: deterministicUuid(seed, "gateway-upstream"),
      backendConnectionId: deterministicUuid(seed, "backend-connection"),
      appServerInstanceId: deterministicUuid(seed, "app-server"),
    },
    identifiers: {
      accountId,
      clientInstanceId: `client-private-${sequence}`,
      windowNonce: `window-nonce-private-${sequence}`,
      windowInstanceId: `window-private-${sequence}`,
      checkpointSlotId: `checkpoint-private-${sequence}`,
      runtimeEpoch: `runtime-private-${sequence}`,
      threadId: `thread-private-${sequence}`,
      turnId: `turn-private-${sequence}`,
      itemId: `item-private-${sequence}`,
      clientSubmissionId: `submission-private-${sequence}`,
    },
    method: "item/completed",
    payloadBytes: 512 + (sequence % 128),
  };
}

function inspectSegments(componentRoot, {
  maximumBytes,
  rawMarkers,
}) {
  const files = fs.existsSync(componentRoot)
    ? fs.readdirSync(componentRoot)
      .filter((name) => name.endsWith(".ndjson"))
      .sort()
    : [];
  let maximumObservedBytes = 0;
  let ndjsonRows = 0;
  for (const name of files) {
    const target = path.join(componentRoot, name);
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.ok(stat.size <= maximumBytes);
    maximumObservedBytes = Math.max(maximumObservedBytes, stat.size);
    const content = fs.readFileSync(target, "utf8");
    for (const marker of rawMarkers) {
      assert.equal(content.includes(marker), false);
    }
    const rows = content.trim() ? content.trim().split("\n") : [];
    for (const row of rows) JSON.parse(row);
    ndjsonRows += rows.length;
  }
  return {
    files: files.length,
    maximumObservedBytes,
    ndjsonRows,
  };
}

function assertRealOwnedPath(
  target,
  expectedKind,
  expectedMode,
  expectedOwner = null,
) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(
    expectedKind === "directory" ? stat.isDirectory() : stat.isFile(),
    true,
  );
  assert.equal(stat.mode & 0o777, expectedMode);
  if (expectedOwner) {
    assert.equal(stat.uid, expectedOwner.uid);
    assert.equal(stat.gid, expectedOwner.gid);
  }
  return stat;
}

function writeExclusive(target, data, mode) {
  const descriptor = fs.openSync(target, "wx", mode);
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(target, mode);
}

function captureFingerprint(manifestRaw, key) {
  return createHash("sha256")
    .update(manifestRaw)
    .update("\0")
    .update(key)
    .digest("hex");
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

function scenarioPath(name) {
  return path.join(temporaryRoot, name);
}

function assertTemporaryProbeRoot(root) {
  const resolved = path.resolve(root);
  const prefix = path.join(
    fs.realpathSync(os.tmpdir()),
    "wfl-shadow-recorder-lifecycle-",
  );
  assert.equal(resolved.startsWith(prefix), true);
  assert.notEqual(resolved, fs.realpathSync(os.tmpdir()));
}

await main();
