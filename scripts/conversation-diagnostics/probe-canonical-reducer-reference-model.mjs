import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import process from "node:process";
import { performance } from "node:perf_hooks";

const DEFAULT_RUNS = 4_096;
const DEFAULT_BASE_SEED = 0x4d303533;
const PROTECTED_SUBMISSION_STATES = new Set([
  "prepared",
  "sent",
  "unknown",
]);
const TERMINAL_TURN_STATES = new Set([
  "completed",
  "failed",
  "interrupted",
]);
const SUBMISSION_TRANSITIONS = new Map([
  ["prepared", new Set(["sent", "cancelled", "unknown"])],
  ["sent", new Set(["accepted", "rejected", "unknown"])],
  ["unknown", new Set(["accepted", "unresolved-abandoned"])],
  ["accepted", new Set(["terminal"])],
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

  shuffle(values) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.integer(0, index);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }
}

function freshMetrics() {
  return {
    actions: 0,
    randomizedLogicalItems: 0,
    canonicalItemsCreated: 0,
    sourceAliasesBound: 0,
    sourceAliasesReused: 0,
    projectionAliasesMerged: 0,
    clientSubmissionAliasesMerged: 0,
    officialIdAliasesMerged: 0,
    duplicateOrStaleRevisionsIgnored: 0,
    terminalItemRegressionsPrevented: 0,
    terminalTurnRegressionsPrevented: 0,
    ambiguousProjectionsPreserved: 0,
    contentRevisionConflictsPreserved: 0,
    calibrations: 0,
    protectedOptimisticItemsRetained: 0,
    ambiguousItemsRetained: 0,
    unprotectedItemsRemovedByTerminalFull: 0,
    stableFoldKeysRetained: 0,
    textEqualityComparisons: 0,
  };
}

function addMetrics(total, current) {
  for (const key of Object.keys(total)) total[key] += current[key];
}

class CanonicalConversationStore {
  constructor(metrics = freshMetrics()) {
    this.metrics = metrics;
    this.threads = new Map();
    this.turns = new Map();
    this.items = new Map();
    this.submissions = new Map();
    this.sourceAliases = new Map();
    this.officialIdIndex = new Map();
    this.clientSubmissionIndex = new Map();
    this.projectionIndex = new Map();
    this.foldState = new Map();
  }

  dispatch(action) {
    assert.ok(action && typeof action === "object");
    this.metrics.actions += 1;
    if (action.type === "thread/upsert") return this.#upsertThread(action);
    if (action.type === "turn/upsert") return this.#upsertTurn(action);
    if (action.type === "submission/prepare") return this.#prepareSubmission(action);
    if (action.type === "submission/state") return this.#transitionSubmission(action);
    if (action.type === "item/upsert") return this.#upsertItem(action);
    if (action.type === "calibration/full") return this.#applyFullCalibration(action);
    if (action.type === "view/fold") return this.#setFold(action);
    throw new Error(`Unsupported canonical action: ${action.type}`);
  }

  #upsertThread(action) {
    assert.equal(typeof action.threadId, "string");
    const current = this.threads.get(action.threadId);
    const next = current ?? {
      id: action.threadId,
      turnIds: new Set(),
      revision: 0,
    };
    next.revision = Math.max(next.revision, action.revision ?? 0);
    this.threads.set(action.threadId, next);
    return next;
  }

  #upsertTurn(action) {
    assert.equal(typeof action.threadId, "string");
    assert.equal(typeof action.turnId, "string");
    const thread = this.#upsertThread({
      type: "thread/upsert",
      threadId: action.threadId,
      revision: action.revision,
    });
    let turn = this.turns.get(action.turnId);
    if (!turn) {
      turn = {
        id: action.turnId,
        threadId: action.threadId,
        status: action.status ?? "inProgress",
        revision: action.revision ?? 0,
        itemIds: new Set(),
      };
      this.turns.set(action.turnId, turn);
      thread.turnIds.add(action.turnId);
      return turn;
    }
    assert.equal(turn.threadId, action.threadId);
    const incomingTerminal = TERMINAL_TURN_STATES.has(action.status);
    const existingTerminal = TERMINAL_TURN_STATES.has(turn.status);
    if (existingTerminal && !incomingTerminal) {
      this.metrics.terminalTurnRegressionsPrevented += 1;
      return turn;
    }
    const revision = action.revision ?? 0;
    if (revision >= turn.revision || incomingTerminal) {
      turn.status = action.status ?? turn.status;
      turn.revision = Math.max(turn.revision, revision);
    }
    return turn;
  }

  #prepareSubmission(action) {
    assert.equal(typeof action.clientSubmissionId, "string");
    const current = this.submissions.get(action.clientSubmissionId);
    if (current) {
      assert.equal(current.threadId, action.threadId);
      assert.equal(current.submissionType, action.submissionType);
      assert.equal(current.payloadDigest, action.payloadDigest);
      return current;
    }
    const submission = {
      id: action.clientSubmissionId,
      threadId: action.threadId,
      turnId: action.turnId ?? null,
      submissionType: action.submissionType,
      payloadDigest: action.payloadDigest,
      state: "prepared",
    };
    this.submissions.set(submission.id, submission);
    return submission;
  }

  #transitionSubmission(action) {
    const submission = this.submissions.get(action.clientSubmissionId);
    assert.ok(submission);
    if (submission.state === action.state) return submission;
    assert.ok(
      SUBMISSION_TRANSITIONS.get(submission.state)?.has(action.state),
      `invalid submission transition ${submission.state} -> ${action.state}`,
    );
    submission.state = action.state;
    if (action.turnId) submission.turnId = action.turnId;
    return submission;
  }

  #upsertItem(action) {
    validateItemAction(action);
    const turn = this.#upsertTurn({
      type: "turn/upsert",
      threadId: action.threadId,
      turnId: action.turnId,
      status: action.turnStatus ?? "inProgress",
      revision: action.turnRevision ?? 0,
    });
    const resolution = this.#resolveCanonicalId(action);
    let item = this.items.get(resolution.canonicalId);
    if (!item) {
      item = {
        id: resolution.canonicalId,
        threadId: action.threadId,
        turnId: action.turnId,
        role: action.role,
        itemType: action.itemType,
        revision: -1,
        terminal: false,
        contentDigest: null,
        contentConflict: false,
        clientSubmissionId: action.clientSubmissionId ?? null,
        projectionOrdinal: action.projectionOrdinal ?? null,
        ambiguousProjection: resolution.ambiguous,
        missingFromCalibration: false,
        sources: new Set(),
      };
      this.items.set(item.id, item);
      turn.itemIds.add(item.id);
      this.metrics.canonicalItemsCreated += 1;
      if (resolution.ambiguous) {
        this.metrics.ambiguousProjectionsPreserved += 1;
      }
    }
    assert.equal(item.threadId, action.threadId);
    assert.equal(item.turnId, action.turnId);
    assert.equal(item.role, action.role);
    assert.equal(item.itemType, action.itemType);
    item.ambiguousProjection ||= resolution.ambiguous;
    item.missingFromCalibration = false;
    if (action.clientSubmissionId) {
      item.clientSubmissionId ??= action.clientSubmissionId;
      assert.equal(item.clientSubmissionId, action.clientSubmissionId);
    }
    if (Number.isSafeInteger(action.projectionOrdinal)) {
      item.projectionOrdinal ??= action.projectionOrdinal;
    }

    const sourceKey = sourceAliasKey(action);
    if (item.sources.has(sourceKey)) {
      this.metrics.sourceAliasesReused += 1;
    } else {
      item.sources.add(sourceKey);
      this.metrics.sourceAliasesBound += 1;
    }
    this.sourceAliases.set(sourceKey, item.id);
    this.#bindIndexes(action, item.id);
    this.#mergeRevision(item, action);
    return item;
  }

  #resolveCanonicalId(action) {
    const sourceKey = sourceAliasKey(action);
    const bySource = this.sourceAliases.get(sourceKey);
    if (bySource) {
      return { canonicalId: bySource, ambiguous: false };
    }

    if (action.clientSubmissionId) {
      const clientKey = clientSubmissionKey(action);
      const byClient = this.clientSubmissionIndex.get(clientKey);
      if (byClient) {
        this.metrics.clientSubmissionAliasesMerged += 1;
        return { canonicalId: byClient, ambiguous: false };
      }
      return {
        canonicalId: `user:${action.turnId}:${action.clientSubmissionId}`,
        ambiguous: false,
      };
    }

    if (action.officialId) {
      const exactKey = officialIdKey(action);
      const byOfficialId = this.officialIdIndex.get(exactKey);
      if (byOfficialId) {
        this.metrics.officialIdAliasesMerged += 1;
        return { canonicalId: byOfficialId, ambiguous: false };
      }
    }

    if (Number.isSafeInteger(action.projectionOrdinal)) {
      const key = projectionKey(action);
      const byProjection = this.projectionIndex.get(key);
      if (byProjection) {
        this.metrics.projectionAliasesMerged += 1;
        return { canonicalId: byProjection, ambiguous: false };
      }
      return {
        canonicalId: `projection:${key}`,
        ambiguous: false,
      };
    }

    const candidates = [...new Set(action.candidateCanonicalIds ?? [])]
      .filter((candidate) => this.items.has(candidate));
    if (candidates.length === 1) {
      return { canonicalId: candidates[0], ambiguous: false };
    }
    if (candidates.length > 1) {
      return {
        canonicalId: `ambiguous:${action.turnId}:${action.sourceKind}:${action.sourceId}`,
        ambiguous: true,
      };
    }

    if (action.officialId) {
      return {
        canonicalId: `official:${action.turnId}:${action.officialId}`,
        ambiguous: false,
      };
    }
    return {
      canonicalId: `source:${action.turnId}:${action.sourceKind}:${action.sourceId}`,
      ambiguous: false,
    };
  }

  #bindIndexes(action, canonicalId) {
    if (action.officialId) {
      bindStableIndex(
        this.officialIdIndex,
        officialIdKey(action),
        canonicalId,
      );
    }
    if (action.clientSubmissionId) {
      bindStableIndex(
        this.clientSubmissionIndex,
        clientSubmissionKey(action),
        canonicalId,
      );
    }
    if (Number.isSafeInteger(action.projectionOrdinal)) {
      bindStableIndex(
        this.projectionIndex,
        projectionKey(action),
        canonicalId,
      );
    }
  }

  #mergeRevision(item, action) {
    const incomingRevision = action.revision;
    if (item.terminal && !action.terminal) {
      this.metrics.terminalItemRegressionsPrevented += 1;
      return;
    }
    if (incomingRevision < item.revision) {
      this.metrics.duplicateOrStaleRevisionsIgnored += 1;
      return;
    }
    if (
      incomingRevision === item.revision
      && item.contentDigest
      && item.contentDigest !== action.contentDigest
    ) {
      item.contentConflict = true;
      item.contentDigest = [item.contentDigest, action.contentDigest]
        .sort()[0];
      this.metrics.contentRevisionConflictsPreserved += 1;
    } else if (
      incomingRevision > item.revision
      || item.contentDigest === null
      || action.terminal
    ) {
      item.contentDigest = action.contentDigest;
    }
    item.revision = Math.max(item.revision, incomingRevision);
    item.terminal ||= action.terminal;
  }

  #applyFullCalibration(action) {
    assert.equal(action.completeness, "full");
    assert.equal(typeof action.threadId, "string");
    assert.equal(typeof action.turnId, "string");
    this.metrics.calibrations += 1;
    this.#upsertTurn({
      type: "turn/upsert",
      threadId: action.threadId,
      turnId: action.turnId,
      status: action.turnTerminal ? "completed" : "inProgress",
      revision: action.turnRevision,
    });
    const seen = new Set();
    for (const itemAction of action.items) {
      const item = this.#upsertItem({
        ...itemAction,
        type: "item/upsert",
        threadId: action.threadId,
        turnId: action.turnId,
      });
      seen.add(item.id);
    }
    if (!action.turnTerminal) return { seen, removed: [] };

    const turn = this.turns.get(action.turnId);
    const removed = [];
    for (const canonicalId of [...turn.itemIds]) {
      if (seen.has(canonicalId)) continue;
      const item = this.items.get(canonicalId);
      const submission = item.clientSubmissionId
        ? this.submissions.get(item.clientSubmissionId)
        : null;
      if (submission && PROTECTED_SUBMISSION_STATES.has(submission.state)) {
        item.missingFromCalibration = true;
        this.metrics.protectedOptimisticItemsRetained += 1;
        continue;
      }
      if (item.ambiguousProjection) {
        item.missingFromCalibration = true;
        this.metrics.ambiguousItemsRetained += 1;
        continue;
      }
      this.#removeItem(item);
      removed.push(canonicalId);
      this.metrics.unprotectedItemsRemovedByTerminalFull += 1;
    }
    return { seen, removed };
  }

  #removeItem(item) {
    this.items.delete(item.id);
    this.turns.get(item.turnId)?.itemIds.delete(item.id);
    for (const sourceKey of item.sources) this.sourceAliases.delete(sourceKey);
    deleteIndexValue(this.officialIdIndex, item.id);
    deleteIndexValue(this.clientSubmissionIndex, item.id);
    deleteIndexValue(this.projectionIndex, item.id);
    this.foldState.delete(item.id);
  }

  #setFold(action) {
    assert.ok(this.items.has(action.canonicalId));
    this.foldState.set(action.canonicalId, Boolean(action.expanded));
    return this.foldState.get(action.canonicalId);
  }

  itemProjection(turnId) {
    const turn = this.turns.get(turnId);
    if (!turn) return [];
    return [...turn.itemIds]
      .map((canonicalId) => this.items.get(canonicalId))
      .filter(Boolean)
      .sort((left, right) => (
        (left.projectionOrdinal ?? Number.MAX_SAFE_INTEGER)
        - (right.projectionOrdinal ?? Number.MAX_SAFE_INTEGER)
        || left.id.localeCompare(right.id)
      ))
      .map((item) => ({
        id: item.id,
        role: item.role,
        itemType: item.itemType,
        revision: item.revision,
        terminal: item.terminal,
        contentDigest: item.contentDigest,
        clientSubmissionId: item.clientSubmissionId,
        projectionOrdinal: item.projectionOrdinal,
        ambiguousProjection: item.ambiguousProjection,
        missingFromCalibration: item.missingFromCalibration,
        sourceCount: item.sources.size,
        expanded: this.foldState.get(item.id) ?? false,
      }));
  }
}

function validateItemAction(action) {
  assert.equal(typeof action.threadId, "string");
  assert.equal(typeof action.turnId, "string");
  assert.equal(typeof action.sourceKind, "string");
  assert.equal(typeof action.sourceId, "string");
  assert.ok(action.role === "user" || action.role === "assistant" || action.role === "tool");
  assert.equal(typeof action.itemType, "string");
  assert.ok(Number.isSafeInteger(action.revision) && action.revision >= 0);
  assert.equal(typeof action.terminal, "boolean");
  assert.equal(typeof action.contentDigest, "string");
}

function sourceAliasKey(action) {
  return `${action.turnId}\u0000${action.sourceKind}\u0000${action.sourceId}`;
}

function officialIdKey(action) {
  return `${action.turnId}\u0000${action.officialId}`;
}

function clientSubmissionKey(action) {
  return `${action.turnId}\u0000${action.clientSubmissionId}\u0000${action.role}`;
}

function projectionKey(action) {
  return [
    action.turnId,
    action.role,
    action.itemType,
    action.projectionOrdinal,
  ].join("\u0000");
}

function bindStableIndex(index, key, canonicalId) {
  const existing = index.get(key);
  assert.ok(!existing || existing === canonicalId);
  index.set(key, canonicalId);
}

function deleteIndexValue(index, canonicalId) {
  for (const [key, value] of index) {
    if (value === canonicalId) index.delete(key);
  }
}

function targetedCases() {
  const metrics = freshMetrics();
  const store = new CanonicalConversationStore(metrics);
  const threadId = "thread-targeted";
  const turnId = "turn-targeted";

  const completed = store.dispatch({
    type: "item/upsert",
    threadId,
    turnId,
    sourceKind: "live",
    sourceId: "msg-agent-1",
    officialId: "msg-agent-1",
    projectionOrdinal: 1,
    role: "assistant",
    itemType: "agentMessage",
    revision: 3,
    terminal: true,
    contentDigest: "digest-final-agent-1",
  });
  const stableKey = completed.id;
  store.dispatch({
    type: "view/fold",
    canonicalId: stableKey,
    expanded: true,
  });
  store.dispatch({
    type: "item/upsert",
    threadId,
    turnId,
    sourceKind: "snapshot",
    sourceId: "item-agent-1",
    officialId: "item-agent-1",
    projectionOrdinal: 1,
    role: "assistant",
    itemType: "agentMessage",
    revision: 3,
    terminal: true,
    contentDigest: "digest-final-agent-1",
  });
  store.dispatch({
    type: "item/upsert",
    threadId,
    turnId,
    sourceKind: "replay",
    sourceId: "msg-agent-1",
    officialId: "msg-agent-1",
    projectionOrdinal: 1,
    role: "assistant",
    itemType: "agentMessage",
    revision: 1,
    terminal: false,
    contentDigest: "digest-started-agent-1",
  });
  let projection = store.itemProjection(turnId);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].id, stableKey);
  assert.equal(projection[0].terminal, true);
  assert.equal(projection[0].expanded, true);
  assert.equal(projection[0].sourceCount, 3);
  metrics.stableFoldKeysRetained += 1;

  const firstSubmission = "submission-same-text-a";
  const secondSubmission = "submission-same-text-b";
  const thirdSubmission = "submission-same-text-c";
  for (const clientSubmissionId of [
    firstSubmission,
    secondSubmission,
    thirdSubmission,
  ]) {
    store.dispatch({
      type: "submission/prepare",
      clientSubmissionId,
      threadId,
      turnId,
      submissionType: "start",
      payloadDigest: "same-content-digest",
    });
    const optimistic = store.dispatch({
      type: "item/upsert",
      threadId,
      turnId,
      sourceKind: "optimistic",
      sourceId: clientSubmissionId,
      clientSubmissionId,
      role: "user",
      itemType: "userMessage",
      revision: 0,
      terminal: false,
      contentDigest: "same-content-digest",
    });
    const authoritative = store.dispatch({
      type: "item/upsert",
      threadId,
      turnId,
      sourceKind: "live",
      sourceId: `official-${clientSubmissionId}`,
      officialId: `official-${clientSubmissionId}`,
      clientSubmissionId,
      role: "user",
      itemType: "userMessage",
      revision: 1,
      terminal: true,
      contentDigest: "same-content-digest",
    });
    assert.equal(authoritative.id, optimistic.id);
  }
  projection = store.itemProjection(turnId);
  assert.equal(
    projection.filter((item) => item.clientSubmissionId).length,
    3,
    "same text under distinct submission IDs must remain distinct legal messages",
  );

  store.dispatch({
    type: "submission/state",
    clientSubmissionId: firstSubmission,
    state: "sent",
  });
  store.dispatch({
    type: "submission/state",
    clientSubmissionId: firstSubmission,
    state: "unknown",
  });
  store.dispatch({
    type: "submission/state",
    clientSubmissionId: thirdSubmission,
    state: "sent",
  });
  store.dispatch({
    type: "calibration/full",
    completeness: "full",
    threadId,
    turnId,
    turnTerminal: true,
    turnRevision: 5,
    items: [{
      sourceKind: "snapshot",
      sourceId: "legacy-user-same-text",
      officialId: "legacy-user-same-text",
      role: "user",
      itemType: "userMessage",
      revision: 2,
      terminal: true,
      contentDigest: "same-content-digest",
    }],
  });
  projection = store.itemProjection(turnId);
  for (const clientSubmissionId of [
    firstSubmission,
    secondSubmission,
    thirdSubmission,
  ]) {
    const item = projection.find(
      (candidate) => candidate.clientSubmissionId === clientSubmissionId,
    );
    assert.ok(item);
    assert.equal(item.missingFromCalibration, true);
  }
  assert.equal(metrics.textEqualityComparisons, 0);

  const ambiguousLeft = store.dispatch({
    type: "item/upsert",
    threadId,
    turnId: "turn-ambiguous",
    sourceKind: "live",
    sourceId: "ambiguous-left",
    officialId: "ambiguous-left",
    role: "assistant",
    itemType: "agentMessage",
    revision: 1,
    terminal: false,
    contentDigest: "ambiguous-content-a",
  });
  const ambiguousRight = store.dispatch({
    type: "item/upsert",
    threadId,
    turnId: "turn-ambiguous",
    sourceKind: "live",
    sourceId: "ambiguous-right",
    officialId: "ambiguous-right",
    role: "assistant",
    itemType: "agentMessage",
    revision: 1,
    terminal: false,
    contentDigest: "ambiguous-content-b",
  });
  const ambiguousIncoming = store.dispatch({
    type: "item/upsert",
    threadId,
    turnId: "turn-ambiguous",
    sourceKind: "snapshot",
    sourceId: "ambiguous-snapshot",
    candidateCanonicalIds: [ambiguousLeft.id, ambiguousRight.id],
    role: "assistant",
    itemType: "agentMessage",
    revision: 2,
    terminal: true,
    contentDigest: "ambiguous-content-final",
  });
  assert.equal(ambiguousIncoming.ambiguousProjection, true);
  store.dispatch({
    type: "calibration/full",
    completeness: "full",
    threadId,
    turnId: "turn-ambiguous",
    turnTerminal: true,
    turnRevision: 3,
    items: [],
  });
  assert.ok(store.items.has(ambiguousIncoming.id));
  assert.equal(store.itemProjection("turn-ambiguous").length, 1);

  return {
    metrics,
    assertions: {
      completedThenStartedRemainsTerminal: true,
      liveAndSnapshotIdentitySplitMapsToOneCanonicalKey: true,
      foldStateSurvivesSourceAliasMerge: true,
      sameTextDifferentSubmissionIdsRemainDistinct: true,
      preparedSentUnknownOptimisticItemsSurviveUnrelatedLegacyCalibration: true,
      ambiguousProjectionPreservedInsteadOfTextDeletion: true,
      allPathsUseOneDispatchReducer: true,
    },
  };
}

function propertyRun(seed, runIndex) {
  const random = new DeterministicRandom(seed);
  const metrics = freshMetrics();
  const store = new CanonicalConversationStore(metrics);
  const threadId = `thread-${runIndex}`;
  const turnId = `turn-${runIndex}`;
  const itemCount = random.integer(4, 10);
  metrics.randomizedLogicalItems = itemCount;
  const actions = [];

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const liveId = `msg-${runIndex}-${itemIndex}`;
    const snapshotId = `item-${runIndex}-${itemIndex}`;
    const ordinal = itemIndex;
    const finalDigest = `digest-final-${itemIndex % 3}`;
    const common = {
      type: "item/upsert",
      threadId,
      turnId,
      role: "assistant",
      itemType: "agentMessage",
      projectionOrdinal: ordinal,
    };
    const started = {
      ...common,
      sourceKind: "live",
      sourceId: liveId,
      officialId: liveId,
      revision: 1,
      terminal: false,
      contentDigest: `digest-started-${itemIndex}`,
    };
    const delta = {
      ...started,
      revision: 2,
      contentDigest: `digest-delta-${itemIndex}`,
    };
    const completed = {
      ...started,
      revision: 3,
      terminal: true,
      contentDigest: finalDigest,
    };
    const snapshot = {
      ...common,
      sourceKind: "snapshot",
      sourceId: snapshotId,
      officialId: snapshotId,
      revision: 3,
      terminal: true,
      contentDigest: finalDigest,
    };
    const jsonl = {
      ...common,
      sourceKind: "jsonl",
      sourceId: liveId,
      officialId: liveId,
      revision: 3,
      terminal: true,
      contentDigest: finalDigest,
    };
    actions.push(started, delta, completed, snapshot, jsonl);
    if (itemIndex % 2 === 0) actions.push({ ...delta });
  }
  actions.push({
    type: "turn/upsert",
    threadId,
    turnId,
    status: "completed",
    revision: 4,
  });
  actions.push({
    type: "turn/upsert",
    threadId,
    turnId,
    status: "inProgress",
    revision: 5,
  });

  for (const action of random.shuffle(actions)) store.dispatch(action);
  const projection = store.itemProjection(turnId);
  assert.equal(projection.length, itemCount);
  assert.equal(new Set(projection.map((item) => item.id)).size, itemCount);
  assert.ok(projection.every((item) => item.terminal));
  assert.ok(projection.every((item) => item.revision === 3));
  assert.ok(projection.every((item) => item.sourceCount === 3));
  assert.equal(store.turns.get(turnId).status, "completed");
  assert.equal(store.threads.size, 1);
  assert.equal(store.turns.size, 1);
  assert.equal(store.items.size, itemCount);
  assert.equal(metrics.textEqualityComparisons, 0);
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
const targeted = targetedCases();
const totals = freshMetrics();
addMetrics(totals, targeted.metrics);
const startedAt = performance.now();
for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const seed = (baseSeed + Math.imul(runIndex + 1, 0x9e3779b1)) >>> 0;
  try {
    addMetrics(totals, propertyRun(seed || 1, runIndex));
  } catch (error) {
    throw new Error(
      `canonical reducer fixed-seed run ${runIndex + 1}/${runs} (seed ${seed}) failed`,
      { cause: error },
    );
  }
}
const durationMs = performance.now() - startedAt;

assert.ok(totals.projectionAliasesMerged > 0);
assert.ok(totals.clientSubmissionAliasesMerged > 0);
assert.ok(totals.officialIdAliasesMerged > 0);
assert.ok(totals.terminalItemRegressionsPrevented > 0);
assert.ok(totals.terminalTurnRegressionsPrevented > 0);
assert.ok(totals.protectedOptimisticItemsRetained > 0);
assert.ok(totals.ambiguousProjectionsPreserved > 0);
assert.equal(totals.textEqualityComparisons, 0);

const fixedSeeds = {
  runs,
  baseSeed,
};
const invariants = {
  normalizedThreadTurnItemMaps: true,
  realtimeReplayAndSnapshotUseOneReducer: true,
  exactSourceReplayIdempotent: true,
  itemAndTurnTerminalStateMonotonic: true,
  liveAndSnapshotAliasesKeepStableCanonicalKey: true,
  sameTextIsNeverAnIdentityKey: true,
  distinctSubmissionIdsRemainDistinct: true,
  ambiguousProjectionIsPreserved: true,
  preparedSentUnknownOptimisticItemsSurviveCalibration: true,
  terminalFullMayRemoveOnlyUnprotectedUnambiguousItems: true,
};
const deterministicDigest = createHash("sha256")
  .update(JSON.stringify({
    fixedSeeds,
    targeted: targeted.assertions,
    coverage: totals,
    invariants,
  }))
  .digest("hex");

process.stdout.write(`${JSON.stringify({
  ok: true,
  probe: "canonical-reducer-reference-model",
  model: "offline-reference-only",
  fixedSeeds,
  deterministicDigest,
  targeted: targeted.assertions,
  coverage: totals,
  performance: {
    durationMs: Math.round(durationMs * 1_000) / 1_000,
    runsPerSecond: Math.round((runs / (durationMs / 1_000)) * 1_000) / 1_000,
  },
  invariants,
  boundaries: {
    productionCodeExercised: false,
    productionReducerImplemented: false,
    browserOrDomExercised: false,
    eventLogOrIndexedDbExercised: false,
    externalNetworkAccessed: false,
    rescueWindowAccessed: false,
    formalInstallOrUpdateHook: false,
    candidateImplementationValidated: false,
  },
}, null, 2)}\n`);
