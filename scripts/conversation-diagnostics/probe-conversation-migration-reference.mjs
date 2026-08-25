import assert from "node:assert/strict";

const PHASES = Object.freeze([
  "observe",
  "identity-and-lease",
  "shadow-reducer-and-index",
  "submission-ledger",
  "event-log-and-ack",
  "canonical-store-and-renderer",
  "remove-full-history-dedup",
]);
const ROLLBACK_COMPONENTS = Object.freeze([
  "renderer",
  "ack",
  "submission",
  "index",
  "dedup",
]);
const BASE_TABLES = new Set(["legacy_state"]);
const RESCUE_FINGERPRINT = "rescue-window:1.0:4321";
const JSONL_FINGERPRINT = "codex-jsonl:read-only-authority";

class InjectedMigrationCrash extends Error {
  constructor(point, committed) {
    super(`injected migration crash at ${point}`);
    this.name = "InjectedMigrationCrash";
    this.point = point;
    this.committed = committed;
  }
}

class MigrationReference {
  constructor() {
    this.state = {
      completedPhases: new Set(),
      phaseApplyCount: new Map(),
      schemaVersion: 1,
      tables: new Set(BASE_TABLES),
      telemetry: {
        recorderDefaultOff: true,
        behaviorChanged: false,
      },
      identity: {
        windowInstanceId: false,
        reentrantLease: false,
        submitIntentGuard: false,
        imeComposition: false,
        classifiedRetryErrors: false,
      },
      shadow: {
        reducerEnabled: false,
        renders: false,
        indexEnabled: false,
        indexAuthority: false,
        indexFallback: "official-read",
      },
      submission: {
        ledgerEnabled: false,
        mode: "legacy-rpc",
        ledger: new Map(),
      },
      events: {
        logEnabled: false,
        appendEnabled: false,
        ackProtocolEnabled: false,
        acceptNewAck: false,
        generation: null,
        rows: [],
        waves: new Set(),
      },
      ui: {
        renderer: "legacy",
        canonicalStoreEnabled: false,
        legacyRendererAvailable: true,
        legacyRendererReadOnlyFallback: false,
      },
      history: {
        fullReadDeduplicatorEnabled: true,
        ledgerCheckedFirst: false,
      },
      compatibility: {
        protocolVersion: 1,
        oldClientBroadcast: true,
      },
      source: {
        jsonlFingerprint: JSONL_FINGERPRINT,
        mutated: false,
      },
      rescue: {
        fingerprint: RESCUE_FINGERPRINT,
        operations: 0,
      },
      access: {
        administratorConversationAllowed: true,
      },
      release: {
        activeBackend: "old",
        oldBackendRunning: true,
        candidateBackendRunning: false,
        candidateReady: false,
      },
      ordinaryServerChecks: {
        compatibilityChecks: 1,
        readinessChecks: 1,
        completeSuites: 0,
        browserSmokeTests: 0,
        loadStressTests: 0,
      },
    };
    assertInvariants(this.state);
  }

  advance(phase, { crashAt = null } = {}) {
    const expectedIndex = PHASES.indexOf(phase);
    assert.ok(expectedIndex >= 0);
    if (this.state.completedPhases.has(phase)) {
      return { status: "already-committed", phase };
    }
    for (let index = 0; index < expectedIndex; index += 1) {
      assert.ok(
        this.state.completedPhases.has(PHASES[index]),
        `phase ${phase} requires ${PHASES[index]}`,
      );
    }
    if (crashAt === "before-transaction") {
      throw new InjectedMigrationCrash(crashAt, false);
    }
    const draft = structuredClone(this.state);
    applyPhase(draft, phase);
    assertInvariants(draft);
    if (crashAt === "after-draft-before-commit") {
      throw new InjectedMigrationCrash(crashAt, false);
    }
    draft.completedPhases.add(phase);
    draft.phaseApplyCount.set(
      phase,
      (draft.phaseApplyCount.get(phase) || 0) + 1,
    );
    this.state = draft;
    assertInvariants(this.state);
    if (crashAt === "after-commit") {
      throw new InjectedMigrationCrash(crashAt, true);
    }
    return { status: "committed", phase };
  }

  advanceThrough(phase = PHASES.at(-1)) {
    const target = PHASES.indexOf(phase);
    for (let index = 0; index <= target; index += 1) {
      this.advance(PHASES[index]);
    }
    return this;
  }

  enableWave(wave) {
    assert.ok(this.state.events.ackProtocolEnabled);
    const order = ["owner", "admin", "account"];
    const index = order.indexOf(wave);
    assert.ok(index >= 0);
    for (let previous = 0; previous < index; previous += 1) {
      assert.ok(this.state.events.waves.has(order[previous]));
    }
    this.state.events.waves.add(wave);
    assertInvariants(this.state);
  }

  negotiate(client) {
    const protocolVersion = Number(client.protocolVersion) || 1;
    const waveEnabled = client.role === "owner"
      ? this.state.events.waves.has("owner")
      : client.role === "admin"
        ? this.state.events.waves.has("admin")
        : this.state.events.waves.has("account");
    const eventLog = (
      this.state.events.ackProtocolEnabled
      && this.state.events.acceptNewAck
      && protocolVersion >= 2
      && waveEnabled
    );
    return eventLog
      ? { mode: "event-log", canAck: true, canAdvanceRetention: true }
      : { mode: "legacy-broadcast", canAck: false, canAdvanceRetention: false };
  }

  acknowledge(client, cursor) {
    const negotiated = this.negotiate(client);
    if (!negotiated.canAck) {
      return { accepted: false, reason: "client-not-ack-capable" };
    }
    return { accepted: true, cursor };
  }

  attemptSubmission(submissionId, providerId) {
    const existing = this.state.submission.ledger.get(submissionId);
    if (existing) {
      return {
        executed: false,
        state: existing.state,
        providerId: existing.providerId,
      };
    }
    if (!this.state.submission.ledgerEnabled) {
      return { executed: true, state: "legacy-untracked", providerId };
    }
    const record = {
      submissionId,
      state: "sent",
      providerId,
      executions: 1,
      payloadRetained: true,
    };
    this.state.submission.ledger.set(submissionId, record);
    return { executed: true, state: record.state, providerId };
  }

  rollback(component) {
    assert.ok(ROLLBACK_COMPONENTS.includes(component));
    if (component === "renderer") {
      this.state.ui.renderer = "legacy";
      this.state.ui.legacyRendererReadOnlyFallback = true;
    } else if (component === "ack") {
      this.state.events.ackProtocolEnabled = false;
      this.state.events.acceptNewAck = false;
      this.state.compatibility.oldClientBroadcast = true;
    } else if (component === "submission") {
      this.state.submission.ledgerEnabled = false;
      this.state.submission.mode = "legacy-rpc-with-ledger-guard";
    } else if (component === "index") {
      this.state.shadow.indexEnabled = false;
      this.state.shadow.indexFallback = "official-read";
    } else if (component === "dedup") {
      this.state.history.fullReadDeduplicatorEnabled = true;
    }
    assertInvariants(this.state);
  }

  snapshot() {
    return structuredClone(this.state);
  }
}

function applyPhase(state, phase) {
  if (phase === "observe") {
    state.telemetry.recorderDefaultOff = true;
    state.telemetry.behaviorChanged = false;
    return;
  }
  if (phase === "identity-and-lease") {
    state.identity.windowInstanceId = true;
    state.identity.reentrantLease = true;
    state.identity.submitIntentGuard = true;
    state.identity.imeComposition = true;
    state.identity.classifiedRetryErrors = true;
    return;
  }
  if (phase === "shadow-reducer-and-index") {
    state.shadow.reducerEnabled = true;
    state.shadow.renders = false;
    state.shadow.indexEnabled = true;
    state.shadow.indexAuthority = false;
    state.tables.add("history_index_metadata");
    state.schemaVersion += 1;
    return;
  }
  if (phase === "submission-ledger") {
    state.submission.ledgerEnabled = true;
    state.submission.mode = "ledger-first";
    state.tables.add("submission_ledger");
    state.tables.add("encrypted_outbox");
    state.schemaVersion += 1;
    if (!state.submission.ledger.has("submission-unknown")) {
      state.submission.ledger.set("submission-unknown", {
        submissionId: "submission-unknown",
        state: "unknown",
        providerId: "provider-a",
        executions: 1,
        payloadRetained: true,
      });
    }
    return;
  }
  if (phase === "event-log-and-ack") {
    state.events.logEnabled = true;
    state.events.appendEnabled = true;
    state.events.ackProtocolEnabled = true;
    state.events.acceptNewAck = true;
    state.events.generation = "migration-event-log-1";
    state.compatibility.protocolVersion = 2;
    state.tables.add("event_log");
    state.tables.add("event_source_map");
    state.tables.add("window_ack_lease");
    state.schemaVersion += 1;
    return;
  }
  if (phase === "canonical-store-and-renderer") {
    state.ui.canonicalStoreEnabled = true;
    state.ui.renderer = "canonical";
    state.ui.legacyRendererAvailable = true;
    state.ui.legacyRendererReadOnlyFallback = true;
    return;
  }
  if (phase === "remove-full-history-dedup") {
    state.history.ledgerCheckedFirst = true;
    state.history.fullReadDeduplicatorEnabled = false;
  }
}

function assertInvariants(state) {
  assert.equal(state.rescue.fingerprint, RESCUE_FINGERPRINT);
  assert.equal(state.rescue.operations, 0);
  assert.equal(state.source.jsonlFingerprint, JSONL_FINGERPRINT);
  assert.equal(state.source.mutated, false);
  assert.equal(state.access.administratorConversationAllowed, true);
  assert.equal(state.release.oldBackendRunning, true);
  assert.equal(state.ordinaryServerChecks.completeSuites, 0);
  assert.equal(state.ordinaryServerChecks.browserSmokeTests, 0);
  assert.equal(state.ordinaryServerChecks.loadStressTests, 0);
  for (const table of BASE_TABLES) assert.ok(state.tables.has(table));
  const unknown = state.submission.ledger.get("submission-unknown");
  if (unknown) {
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.providerId, "provider-a");
    assert.equal(unknown.executions, 1);
  }
  if (state.events.ackProtocolEnabled) {
    assert.equal(state.events.logEnabled, true);
    assert.equal(state.events.appendEnabled, true);
  }
  if (state.ui.renderer === "canonical") {
    assert.equal(state.ui.canonicalStoreEnabled, true);
    assert.equal(state.ui.legacyRendererAvailable, true);
  }
  if (!state.history.fullReadDeduplicatorEnabled) {
    assert.equal(state.history.ledgerCheckedFirst, true);
    assert.equal(state.submission.ledger.has("submission-unknown"), true);
  }
}

function assertPreCommitCrashRollsBack(phase, crashAt) {
  const reference = new MigrationReference();
  const phaseIndex = PHASES.indexOf(phase);
  if (phaseIndex > 0) reference.advanceThrough(PHASES[phaseIndex - 1]);
  const before = reference.snapshot();
  assert.throws(
    () => reference.advance(phase, { crashAt }),
    (error) => (
      error instanceof InjectedMigrationCrash
      && error.point === crashAt
      && error.committed === false
    ),
  );
  assert.deepEqual(reference.snapshot(), before);
  assert.equal(reference.advance(phase).status, "committed");
  assert.equal(reference.state.phaseApplyCount.get(phase), 1);
  assertInvariants(reference.state);
}

function assertPostCommitCrashRecovers(phase) {
  const reference = new MigrationReference();
  const phaseIndex = PHASES.indexOf(phase);
  if (phaseIndex > 0) reference.advanceThrough(PHASES[phaseIndex - 1]);
  assert.throws(
    () => reference.advance(phase, { crashAt: "after-commit" }),
    (error) => (
      error instanceof InjectedMigrationCrash
      && error.committed === true
    ),
  );
  const committed = reference.snapshot();
  assert.ok(committed.completedPhases.has(phase));
  assert.equal(reference.advance(phase).status, "already-committed");
  assert.deepEqual(reference.snapshot(), committed);
  assert.equal(reference.state.phaseApplyCount.get(phase), 1);
  assertInvariants(reference.state);
}

function deploymentFailureScenario(faultAt) {
  const reference = new MigrationReference();
  const state = reference.state;
  state.release.candidateBackendRunning = true;
  if (faultAt === "after-candidate-start") {
    return assertOldBackendPreserved(reference, faultAt);
  }
  if (faultAt === "compatibility-failed") {
    state.release.candidateBackendRunning = false;
    return assertOldBackendPreserved(reference, faultAt);
  }
  state.release.candidateReady = true;
  if (faultAt === "before-traffic-switch") {
    return assertOldBackendPreserved(reference, faultAt);
  }
  assert.equal(faultAt, "after-traffic-switch");
  state.release.activeBackend = "candidate";
  assert.equal(state.release.oldBackendRunning, true);
  state.release.activeBackend = "old";
  state.release.candidateBackendRunning = false;
  state.release.candidateReady = false;
  return assertOldBackendPreserved(reference, faultAt);
}

function assertOldBackendPreserved(reference, faultAt) {
  assert.equal(reference.state.release.activeBackend, "old");
  assert.equal(reference.state.release.oldBackendRunning, true);
  assert.equal(reference.state.access.administratorConversationAllowed, true);
  assertInvariants(reference.state);
  return { faultAt, activeBackend: reference.state.release.activeBackend };
}

function* permutations(values, prefix = []) {
  if (!values.length) {
    yield prefix;
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    yield* permutations(
      [...values.slice(0, index), ...values.slice(index + 1)],
      [...prefix, values[index]],
    );
  }
}

let preCommitCrashCases = 0;
let postCommitCrashCases = 0;
for (const phase of PHASES) {
  for (const crashAt of [
    "before-transaction",
    "after-draft-before-commit",
  ]) {
    assertPreCommitCrashRollsBack(phase, crashAt);
    preCommitCrashCases += 1;
  }
  assertPostCommitCrashRecovers(phase);
  postCommitCrashCases += 1;
}

const waveReference = new MigrationReference().advanceThrough(
  "event-log-and-ack",
);
const clients = {
  ownerOld: { role: "owner", protocolVersion: 1 },
  ownerNew: { role: "owner", protocolVersion: 2 },
  adminNew: { role: "admin", protocolVersion: 2 },
  accountNew: { role: "account", protocolVersion: 2 },
};
waveReference.enableWave("owner");
assert.deepEqual(waveReference.negotiate(clients.ownerOld), {
  mode: "legacy-broadcast",
  canAck: false,
  canAdvanceRetention: false,
});
assert.equal(waveReference.negotiate(clients.ownerNew).mode, "event-log");
assert.equal(waveReference.negotiate(clients.adminNew).mode, "legacy-broadcast");
assert.equal(
  waveReference.acknowledge(clients.ownerOld, 10).accepted,
  false,
);
assert.equal(
  waveReference.acknowledge(clients.ownerNew, 10).accepted,
  true,
);
waveReference.enableWave("admin");
assert.equal(waveReference.negotiate(clients.adminNew).mode, "event-log");
assert.equal(waveReference.negotiate(clients.accountNew).mode, "legacy-broadcast");
waveReference.enableWave("account");
assert.equal(waveReference.negotiate(clients.accountNew).mode, "event-log");

let rollbackPermutations = 0;
let rollbackTransitions = 0;
for (const order of permutations([...ROLLBACK_COMPONENTS])) {
  const reference = new MigrationReference().advanceThrough();
  const tablesBefore = new Set(reference.state.tables);
  const ledgerBefore = structuredClone(reference.state.submission.ledger);
  for (const component of order) {
    reference.rollback(component);
    rollbackTransitions += 1;
    assert.deepEqual(reference.state.submission.ledger, ledgerBefore);
    for (const table of tablesBefore) assert.ok(reference.state.tables.has(table));
    const result = reference.attemptSubmission(
      "submission-unknown",
      "provider-b",
    );
    assert.equal(result.executed, false);
    assert.equal(result.state, "unknown");
    assert.equal(result.providerId, "provider-a");
    assertInvariants(reference.state);
  }
  assert.equal(reference.state.ui.renderer, "legacy");
  assert.equal(reference.state.events.logEnabled, true);
  assert.equal(reference.state.events.appendEnabled, true);
  assert.equal(reference.state.events.acceptNewAck, false);
  assert.equal(reference.state.shadow.indexFallback, "official-read");
  assert.equal(reference.state.history.fullReadDeduplicatorEnabled, true);
  assert.equal(
    reference.state.submission.mode,
    "legacy-rpc-with-ledger-guard",
  );
  rollbackPermutations += 1;
}

const deploymentFaults = [
  "after-candidate-start",
  "compatibility-failed",
  "before-traffic-switch",
  "after-traffic-switch",
].map(deploymentFailureScenario);

const finalReference = new MigrationReference().advanceThrough();
assert.equal(finalReference.state.completedPhases.size, PHASES.length);
assert.equal(finalReference.state.phaseApplyCount.size, PHASES.length);
assert.equal(
  [...finalReference.state.phaseApplyCount.values()]
    .every((count) => count === 1),
  true,
);
assertInvariants(finalReference.state);

console.log(JSON.stringify({
  ok: true,
  phases: {
    ordered: PHASES,
    committedExactlyOnce: PHASES.length,
    preCommitCrashCases,
    postCommitCrashCases,
  },
  protocolWaves: {
    ownerFirst: true,
    adminSecond: true,
    accountLast: true,
    oldClientMode: waveReference.negotiate(clients.ownerOld).mode,
    oldClientAckRejected: true,
    oldClientAdvancesRetention: false,
    newClientMode: waveReference.negotiate(clients.ownerNew).mode,
  },
  rollback: {
    components: ROLLBACK_COMPONENTS,
    permutations: rollbackPermutations,
    transitions: rollbackTransitions,
    schemaTablesDeleted: 0,
    ledgerRecordsDeleted: 0,
    unknownSubmissionReplays: 0,
    eventLogStoppedDuringAckRollback: false,
  },
  deployment: {
    faultCases: deploymentFaults.length,
    activeOldBackendPreserved: deploymentFaults.every(
      (entry) => entry.activeBackend === "old",
    ),
    administratorConversationAccessPreserved: true,
  },
  protection: {
    jsonlMutations: finalReference.state.source.mutated ? 1 : 0,
    rescueOperations: finalReference.state.rescue.operations,
    rescueFingerprint: finalReference.state.rescue.fingerprint,
    ordinaryServerCompleteSuites:
      finalReference.state.ordinaryServerChecks.completeSuites,
    ordinaryServerBrowserSmokeTests:
      finalReference.state.ordinaryServerChecks.browserSmokeTests,
    ordinaryServerLoadStressTests:
      finalReference.state.ordinaryServerChecks.loadStressTests,
  },
  limits: {
    productionMigrationImplemented: false,
    executesCurrentReleaseScripts: false,
    readsProductionState: false,
    validatesRealDatabaseMigrations: false,
    validatesRealOldClients: false,
    candidateReleaseValidated: false,
    ownerDecisionStillRequired: true,
  },
}, null, 2));
