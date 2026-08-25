import assert from "node:assert/strict";
import process from "node:process";

const DEFAULT_RUNS = 10_000;
const DEFAULT_BASE_SEED = 0x46314638;
const THREADS = Object.freeze(["thread-a", "thread-b", "thread-c"]);
const MANDATORY_FAULTS = Object.freeze([
  "drop",
  "duplicate",
  "reorder",
  "delay",
  "disconnect",
  "restart",
]);

function parsePositiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== "--runs" && name !== "--seed") {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

class DeterministicRandom {
  constructor(seed) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  integer(minimum, maximum) {
    return minimum + Math.floor(this.next() * (maximum - minimum + 1));
  }

  chance(probability) {
    return this.next() < probability;
  }

  pick(values) {
    return values[this.integer(0, values.length - 1)];
  }

  shuffle(values) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.integer(0, index);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }
}

function cloneEntityMap(source) {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function entityProjection(entities) {
  return [...entities]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId, entity]) => ({
      entityId,
      revision: entity.revision,
      terminal: entity.terminal,
    }));
}

class ReferenceEventServer {
  constructor(metrics) {
    this.metrics = metrics;
    this.eventLogGeneration = 1;
    this.runtimeEpoch = 1;
    this.upstreamSequence = 0;
    this.eventCursor = 0;
    this.rows = [];
    this.sourceToCursor = new Map();
    this.entities = new Map();
    this.windowLeases = new Map();
    this.zeroCursorRequiresCalibration = false;
  }

  restartAppServer() {
    this.runtimeEpoch += 1;
    this.upstreamSequence = 0;
    this.metrics.appServerRestarts += 1;
  }

  rebuildEventLog() {
    this.zeroCursorRequiresCalibration = this.entities.size > 0;
    this.eventLogGeneration += 1;
    this.eventCursor = 0;
    this.rows = [];
    this.sourceToCursor = new Map();
    this.metrics.eventLogRebuilds += 1;
  }

  registerWindow(windowInstanceId, checkpoint) {
    const compatible = Boolean(
      checkpoint
      && checkpoint.eventLogGeneration === this.eventLogGeneration
      && checkpoint.eventCursor >= 0
      && checkpoint.eventCursor <= this.eventCursor,
    );
    this.windowLeases.set(windowInstanceId, {
      eventLogGeneration: this.eventLogGeneration,
      ackCursor: compatible ? checkpoint.eventCursor : 0,
    });
    return {
      compatible,
      seedCursor: compatible ? checkpoint.eventCursor : 0,
      resyncRequired: !compatible && (
        Boolean(checkpoint)
        || this.zeroCursorRequiresCalibration
      ),
    };
  }

  acknowledge(windowInstanceId, generation, cursor) {
    const lease = this.windowLeases.get(windowInstanceId);
    assert.ok(lease, "ACK window lease must exist");
    assert.equal(generation, lease.eventLogGeneration);
    assert.equal(generation, this.eventLogGeneration);
    assert.ok(cursor >= lease.ackCursor, "ACK cursor must be monotonic");
    assert.ok(cursor <= this.eventCursor, "ACK cannot pass the committed cursor");
    lease.ackCursor = cursor;
  }

  ingest({ entityId, revision, terminal }) {
    this.upstreamSequence += 1;
    const sourceId = `${this.runtimeEpoch}:${this.upstreamSequence}`;
    const existingCursor = this.sourceToCursor.get(sourceId);
    if (existingCursor !== undefined) {
      return this.rows[existingCursor - 1];
    }

    const existing = this.entities.get(entityId);
    if (existing) {
      if (revision < existing.revision) {
        this.metrics.sourceStaleRevisionsNormalized += 1;
      }
      if (existing.terminal && !terminal) {
        this.metrics.sourceTerminalRegressionsNormalized += 1;
      }
    }
    const entity = {
      revision: Math.max(existing?.revision ?? 0, revision),
      terminal: Boolean(existing?.terminal || terminal),
    };
    this.entities.set(entityId, entity);

    this.eventCursor += 1;
    const row = Object.freeze({
      eventLogGeneration: this.eventLogGeneration,
      eventCursor: this.eventCursor,
      runtimeEpoch: this.runtimeEpoch,
      upstreamEventSequence: this.upstreamSequence,
      sourceId,
      entityId,
      revision: entity.revision,
      terminal: entity.terminal,
    });
    this.rows.push(row);
    this.sourceToCursor.set(sourceId, row.eventCursor);
    this.metrics.committedEvents += 1;
    return row;
  }

  replayFrom(cursor) {
    return this.rows.slice(cursor);
  }

  calibration() {
    return {
      eventLogGeneration: this.eventLogGeneration,
      fenceCursor: this.eventCursor,
      entities: cloneEntityMap(this.entities),
    };
  }
}

class ReferenceClient {
  constructor({ server, metrics, windowInstanceId, checkpoint = null }) {
    this.server = server;
    this.metrics = metrics;
    this.windowInstanceId = windowInstanceId;
    this.connected = true;
    this.gapDetected = false;
    this.entities = checkpoint ? cloneEntityMap(checkpoint.entities) : new Map();
    this.durableCheckpoint = checkpoint;
    const registration = server.registerWindow(windowInstanceId, checkpoint);
    this.eventLogGeneration = server.eventLogGeneration;
    this.appliedCursor = registration.seedCursor;
    this.durableCursor = registration.seedCursor;
    this.resyncRequired = registration.resyncRequired;
    if (registration.resyncRequired) {
      this.entities = new Map();
      this.appliedCursor = 0;
      this.durableCursor = 0;
      this.gapDetected = true;
      if (checkpoint) {
        this.metrics.incompatibleCheckpoints += 1;
      } else {
        this.metrics.emptySeedsRequiringCalibration += 1;
      }
    }
  }

  receive(row) {
    if (!this.connected) return;
    if (row.eventLogGeneration < this.eventLogGeneration) {
      this.metrics.staleGenerationFramesIgnored += 1;
      return;
    }
    if (row.eventLogGeneration > this.eventLogGeneration) {
      this.gapDetected = true;
      this.metrics.generationMismatches += 1;
      return;
    }
    if (row.eventCursor <= this.appliedCursor) {
      this.metrics.duplicateFramesIgnored += 1;
      return;
    }
    if (row.eventCursor !== this.appliedCursor + 1) {
      this.gapDetected = true;
      this.metrics.cursorGapsDetected += 1;
      return;
    }
    this.#apply(row);
  }

  #apply(row) {
    const existing = this.entities.get(row.entityId);
    if (existing && row.revision < existing.revision) {
      this.metrics.staleEntityRevisionsIgnored += 1;
    } else if (existing?.terminal && !row.terminal) {
      this.metrics.terminalRegressionsPrevented += 1;
    } else {
      this.entities.set(row.entityId, {
        revision: Math.max(existing?.revision ?? 0, row.revision),
        terminal: Boolean(existing?.terminal || row.terminal),
      });
    }
    this.appliedCursor = row.eventCursor;
    this.metrics.appliedEvents += 1;
  }

  checkpoint() {
    if (this.eventLogGeneration !== this.server.eventLogGeneration) {
      this.metrics.ackGenerationRejected += 1;
      this.gapDetected = true;
      this.recover();
      return this.durableCheckpoint;
    }
    this.durableCursor = this.appliedCursor;
    this.durableCheckpoint = Object.freeze({
      eventLogGeneration: this.eventLogGeneration,
      eventCursor: this.durableCursor,
      entities: cloneEntityMap(this.entities),
    });
    this.server.acknowledge(
      this.windowInstanceId,
      this.eventLogGeneration,
      this.durableCursor,
    );
    this.metrics.checkpoints += 1;
    return this.durableCheckpoint;
  }

  recover() {
    this.connected = true;
    if (
      this.resyncRequired
      || this.eventLogGeneration !== this.server.eventLogGeneration
    ) {
      const calibration = this.server.calibration();
      this.eventLogGeneration = calibration.eventLogGeneration;
      this.appliedCursor = calibration.fenceCursor;
      this.entities = cloneEntityMap(calibration.entities);
      this.server.windowLeases.set(this.windowInstanceId, {
        eventLogGeneration: this.eventLogGeneration,
        ackCursor: 0,
      });
      this.metrics.authoritativeCalibrations += 1;
    } else {
      const replay = this.server.replayFrom(this.appliedCursor);
      for (const row of replay) {
        this.receive(row);
        this.metrics.replayedEnvelopes += 1;
      }
    }
    this.resyncRequired = false;
    this.gapDetected = false;
    this.checkpoint();
  }
}

class DeliveryFaults {
  constructor({ random, client, metrics, mandatoryFault }) {
    this.random = random;
    this.client = client;
    this.metrics = metrics;
    this.mandatoryFault = mandatoryFault;
    this.mandatoryApplied = false;
    this.delayed = [];
    this.reorderHeld = null;
    this.disconnectRemaining = 0;
  }

  beforeIngest(server, eventIndex) {
    const mandatory = !this.mandatoryApplied && this.mandatoryFault === "restart";
    if (mandatory || this.random.chance(0.018)) {
      this.mandatoryApplied ||= mandatory;
      this.metrics.faults.restart += 1;
      if (eventIndex > 0 && this.random.chance(0.18)) {
        server.rebuildEventLog();
      } else {
        server.restartAppServer();
      }
    }
  }

  deliver(row) {
    if (this.disconnectRemaining > 0) {
      this.disconnectRemaining -= 1;
      if (this.disconnectRemaining === 0) this.client.recover();
      return;
    }

    const mandatory = !this.mandatoryApplied ? this.mandatoryFault : null;
    if (mandatory === "disconnect" || this.random.chance(0.015)) {
      this.mandatoryApplied ||= mandatory === "disconnect";
      this.metrics.faults.disconnect += 1;
      this.client.connected = false;
      this.disconnectRemaining = this.random.integer(1, 4);
      return;
    }

    if (mandatory === "drop" || this.random.chance(0.02)) {
      this.mandatoryApplied ||= mandatory === "drop";
      this.metrics.faults.drop += 1;
      return;
    }

    let copies = [row];
    if (mandatory === "duplicate" || this.random.chance(0.025)) {
      this.mandatoryApplied ||= mandatory === "duplicate";
      this.metrics.faults.duplicate += 1;
      copies = [row, row];
    }

    if (mandatory === "delay" || this.random.chance(0.025)) {
      this.mandatoryApplied ||= mandatory === "delay";
      this.metrics.faults.delay += 1;
      this.delayed.push(...copies);
      return;
    }

    if (mandatory === "reorder" || this.random.chance(0.02)) {
      this.mandatoryApplied ||= mandatory === "reorder";
      this.metrics.faults.reorder += 1;
      if (this.reorderHeld) {
        for (const copy of copies) this.client.receive(copy);
        this.client.receive(this.reorderHeld);
        this.reorderHeld = null;
      } else {
        this.reorderHeld = copies[0];
        for (const copy of copies.slice(1)) this.client.receive(copy);
      }
      return;
    }

    for (const copy of copies) this.client.receive(copy);
    if (this.random.chance(0.08)) this.flushOneDelayed();
  }

  flushOneDelayed() {
    if (this.delayed.length === 0) return;
    const index = this.random.integer(0, this.delayed.length - 1);
    const [row] = this.delayed.splice(index, 1);
    this.client.receive(row);
  }

  finish() {
    if (this.reorderHeld) {
      this.client.receive(this.reorderHeld);
      this.reorderHeld = null;
    }
    for (const row of this.random.shuffle(this.delayed)) {
      this.client.receive(row);
    }
    this.delayed = [];
    this.disconnectRemaining = 0;
    this.client.recover();
  }
}

class SubmissionLedgerModel {
  constructor(metrics) {
    this.metrics = metrics;
    this.records = new Map();
    this.upstreamExecutions = new Map();
  }

  prepare(submissionId, providerId) {
    const existing = this.records.get(submissionId);
    if (existing) return existing;
    const record = {
      submissionId,
      providerId,
      state: "prepared",
      executionCount: 0,
    };
    this.records.set(submissionId, record);
    return record;
  }

  deliver(record, outcome) {
    assert.equal(record.state, "prepared");
    if (outcome === "before-write") {
      this.metrics.submissions.safePreparedRetries += 1;
      return this.deliver(record, "accepted");
    }

    record.state = "sent";
    if (outcome === "explicit-rejection") {
      record.state = "rejected";
      this.metrics.submissions.explicitRejections += 1;
      return record;
    }

    const executionCount = (this.upstreamExecutions.get(record.submissionId) ?? 0) + 1;
    this.upstreamExecutions.set(record.submissionId, executionCount);
    record.executionCount = executionCount;
    if (outcome === "accepted") {
      record.state = "accepted";
      this.metrics.submissions.accepted += 1;
    } else if (outcome === "result-lost-index-visible") {
      record.state = "unknown";
      this.metrics.submissions.unknownEntered += 1;
      record.state = "accepted";
      this.metrics.submissions.unknownResolved += 1;
    } else {
      assert.equal(outcome, "result-lost-index-hidden");
      record.state = "unknown";
      this.metrics.submissions.unknownEntered += 1;
      this.metrics.submissions.unknownPreserved += 1;
    }
    return record;
  }

  switchProvider(record, nextProviderId) {
    assert.notEqual(nextProviderId, record.providerId);
    if (record.state === "unknown" || record.state === "sent") {
      this.metrics.submissions.providerSwitchesBlockedReplay += 1;
      return false;
    }
    return true;
  }

  verify() {
    for (const record of this.records.values()) {
      assert.ok(record.executionCount <= 1, "one submission ID must not execute twice");
      if (record.state === "unknown") {
        assert.equal(record.executionCount, 1);
      }
      if (record.state === "rejected") {
        assert.equal(record.executionCount, 0);
      }
    }
  }
}

function freshMetrics() {
  return {
    committedEvents: 0,
    appliedEvents: 0,
    replayedEnvelopes: 0,
    duplicateFramesIgnored: 0,
    staleGenerationFramesIgnored: 0,
    staleEntityRevisionsIgnored: 0,
    terminalRegressionsPrevented: 0,
    sourceStaleRevisionsNormalized: 0,
    sourceTerminalRegressionsNormalized: 0,
    cursorGapsDetected: 0,
    generationMismatches: 0,
    ackGenerationRejected: 0,
    authoritativeCalibrations: 0,
    appServerRestarts: 0,
    eventLogRebuilds: 0,
    checkpoints: 0,
    reloads: 0,
    incompatibleCheckpoints: 0,
    emptySeedsRequiringCalibration: 0,
    faults: {
      drop: 0,
      duplicate: 0,
      reorder: 0,
      delay: 0,
      disconnect: 0,
      restart: 0,
    },
    submissions: {
      accepted: 0,
      explicitRejections: 0,
      safePreparedRetries: 0,
      unknownEntered: 0,
      unknownResolved: 0,
      unknownPreserved: 0,
      providerSwitchesBlockedReplay: 0,
    },
  };
}

function addMetrics(total, current) {
  for (const key of [
    "committedEvents",
    "appliedEvents",
    "replayedEnvelopes",
    "duplicateFramesIgnored",
    "staleGenerationFramesIgnored",
    "staleEntityRevisionsIgnored",
    "terminalRegressionsPrevented",
    "sourceStaleRevisionsNormalized",
    "sourceTerminalRegressionsNormalized",
    "cursorGapsDetected",
    "generationMismatches",
    "ackGenerationRejected",
    "authoritativeCalibrations",
    "appServerRestarts",
    "eventLogRebuilds",
    "checkpoints",
    "reloads",
    "incompatibleCheckpoints",
    "emptySeedsRequiringCalibration",
  ]) {
    total[key] += current[key];
  }
  for (const key of Object.keys(total.faults)) {
    total.faults[key] += current.faults[key];
  }
  for (const key of Object.keys(total.submissions)) {
    total.submissions[key] += current.submissions[key];
  }
}

function runScenario(seed, runIndex) {
  const random = new DeterministicRandom(seed);
  const metrics = freshMetrics();
  const server = new ReferenceEventServer(metrics);
  let windowCounter = 1;
  let client = new ReferenceClient({
    server,
    metrics,
    windowInstanceId: `window-${runIndex}-${windowCounter}`,
  });
  const faults = new DeliveryFaults({
    random,
    client,
    metrics,
    mandatoryFault: MANDATORY_FAULTS[runIndex % MANDATORY_FAULTS.length],
  });

  const itemCount = random.integer(4, 9);
  let eventIndex = 0;
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const threadId = random.pick(THREADS);
    const entityId = `${threadId}:item-${itemIndex}`;
    const revisions = random.integer(2, 5);
    for (let revision = 1; revision <= revisions; revision += 1) {
      faults.beforeIngest(server, eventIndex);
      const row = server.ingest({
        entityId,
        revision,
        terminal: revision === revisions,
      });
      faults.deliver(row);
      eventIndex += 1;

      if (client.gapDetected && random.chance(0.55)) client.recover();
      if (random.chance(0.08)) client.checkpoint();
      if (random.chance(0.012)) {
        const checkpoint = client.durableCheckpoint;
        const previousWindow = client.windowInstanceId;
        windowCounter += 1;
        client = new ReferenceClient({
          server,
          metrics,
          windowInstanceId: `window-${runIndex}-${windowCounter}`,
          checkpoint,
        });
        faults.client = client;
        metrics.reloads += 1;
        assert.notEqual(client.windowInstanceId, previousWindow);
        client.recover();
      }
    }
    if (random.chance(0.24)) {
      faults.beforeIngest(server, eventIndex);
      const lateStarted = server.ingest({
        entityId,
        revision: 1,
        terminal: false,
      });
      faults.deliver(lateStarted);
      eventIndex += 1;
      if (client.gapDetected && random.chance(0.55)) client.recover();
    }
  }
  faults.finish();

  assert.deepEqual(
    entityProjection(client.entities),
    entityProjection(server.entities),
    "client canonical Store must converge to the committed server projection",
  );
  assert.equal(client.appliedCursor, server.eventCursor);
  assert.equal(client.durableCursor, server.eventCursor);
  assert.equal(client.eventLogGeneration, server.eventLogGeneration);
  assert.equal(
    new Set(entityProjection(client.entities).map((entity) => entity.entityId)).size,
    client.entities.size,
    "canonical Store must contain one row per entity ID",
  );
  for (const entity of client.entities.values()) {
    assert.equal(entity.terminal, true, "all generated items must converge to terminal");
  }

  const ledger = new SubmissionLedgerModel(metrics);
  const outcomes = [
    "before-write",
    "accepted",
    "explicit-rejection",
    "result-lost-index-visible",
    "result-lost-index-hidden",
  ];
  for (let submissionIndex = 0; submissionIndex < 3; submissionIndex += 1) {
    const submissionId = `submission-${runIndex}-${submissionIndex}`;
    const providerId = `provider-${random.integer(1, 2)}`;
    const record = ledger.prepare(submissionId, providerId);
    const outcome = outcomes[(runIndex + submissionIndex) % outcomes.length];
    ledger.deliver(record, outcome);
    if (record.state === "unknown") {
      const switched = ledger.switchProvider(
        record,
        providerId === "provider-1" ? "provider-2" : "provider-1",
      );
      assert.equal(switched, false);
      assert.equal(record.executionCount, 1);
    }
  }
  ledger.verify();

  assert.equal(faults.mandatoryApplied, true);
  return metrics;
}

const args = parseArgs(process.argv.slice(2));
const runs = parsePositiveInteger(args.runs, DEFAULT_RUNS, "--runs", 100_000);
const baseSeed = parsePositiveInteger(
  args.seed,
  DEFAULT_BASE_SEED,
  "--seed",
  0xffff_ffff,
);
const totals = freshMetrics();

for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const seed = (baseSeed + Math.imul(runIndex + 1, 0x9e3779b1)) >>> 0;
  try {
    addMetrics(totals, runScenario(seed || 1, runIndex));
  } catch (error) {
    throw new Error(
      `fixed-seed run ${runIndex + 1}/${runs} (seed ${seed}) failed`,
      { cause: error },
    );
  }
}

for (const fault of MANDATORY_FAULTS) {
  assert.ok(totals.faults[fault] > 0, `${fault} must be injected`);
}
assert.ok(totals.cursorGapsDetected > 0);
assert.ok(totals.duplicateFramesIgnored > 0);
assert.ok(totals.authoritativeCalibrations > 0);
assert.ok(totals.appServerRestarts > 0);
assert.ok(totals.eventLogRebuilds > 0);
assert.ok(totals.ackGenerationRejected > 0);
assert.ok(totals.sourceStaleRevisionsNormalized > 0);
assert.ok(totals.sourceTerminalRegressionsNormalized > 0);
assert.ok(totals.submissions.unknownPreserved > 0);
assert.equal(
  totals.submissions.providerSwitchesBlockedReplay,
  totals.submissions.unknownPreserved,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  probe: "conversation-fault-matrix",
  model: "offline-reference-only",
  fixedSeeds: {
    runs,
    baseSeed,
  },
  coverage: totals,
  invariants: {
    committedCursorContinuousWithinGeneration: true,
    gapFramesNotAppliedBeforeReplay: true,
    duplicateAndLateFramesIdempotent: true,
    canonicalEntityTerminalStateMonotonic: true,
    disconnectRecoveryConverges: true,
    appServerSequenceResetDoesNotResetEventCursor: true,
    eventLogGenerationChangeForcesCalibration: true,
    reloadCreatesNewWindowLeaseFromDurableSeed: true,
    acceptedSubmissionExecutedAtMostOnce: true,
    sentUnknownNeverAutoReplayedAcrossProvider: true,
    explicitRejectionHasNoExecution: true,
  },
  boundaries: {
    productionCodeExercised: false,
    externalNetworkAccessed: false,
    browserOrIndexedDbExercised: false,
    sqliteOrSidecarExercised: false,
    rescueWindowAccessed: false,
    formalInstallOrUpdateHook: false,
    candidateImplementationValidated: false,
  },
}, null, 2)}\n`);
