const DEFAULT_SCOPE = "default";
const TURN_NOTIFICATION_ITEM_TYPES = new Set([
  "hookRun",
  "modelReroute",
  "modelSafetyBuffering",
  "modelVerification",
  "turnModerationMetadata",
  "guardianApprovalReview",
]);

export function turnHasRenderableAssistantMessage(turn) {
  return Array.isArray(turn?.items) && turn.items.some((item) => (
    item?.type === "agentMessage"
    && typeof item.id === "string"
    && item.id
    && typeof item.text === "string"
    && item.text.length > 0
  ));
}

export function completedTurnStateIsComplete(params, turn) {
  const notificationTurn = params?.turn;
  const expectedTurnId = params?.turnId || notificationTurn?.id;
  return Boolean(
    notificationTurn?.id
    && notificationTurn.id === expectedTurnId
    && Array.isArray(notificationTurn.items)
    && turn?.id
    && turn.id === expectedTurnId
    && !runningStatus(turn.status)
    && Array.isArray(turn.items)
    && turn.items.some((item) => item?.type === "userMessage")
    && turnHasRenderableAssistantMessage(turn)
  );
}

export function createConversationState() {
  return {
    revision: 0,
    scopes: new Map(),
  };
}

export function conversationScopeKey({ accountId, projectId } = {}) {
  return `${identifier(accountId) || DEFAULT_SCOPE}\0${identifier(projectId) || DEFAULT_SCOPE}`;
}

export function replaceConversationThread(current, scope, thread) {
  if (!thread?.id) return current;
  const state = cloneState(current);
  const partition = mutablePartition(state, scope);
  partition.threads.set(thread.id, normalizeThread(thread));
  state.revision += 1;
  return state;
}

export function removeConversationThread(current, scope, threadId) {
  if (!identifier(threadId)) return current;
  const key = conversationScopeKey(scope);
  const existing = current?.scopes?.get(key);
  if (!existing?.threads?.has(threadId)) return current;
  const state = cloneState(current);
  const partition = mutablePartition(state, scope);
  partition.threads.delete(threadId);
  state.revision += 1;
  return state;
}

export function reduceConversationNotification(current, scope, notification) {
  const method = identifier(notification?.method);
  const params = object(notification?.params);
  const threadId = identifier(params.threadId || params.thread?.id);
  if (!method || !threadId) return current;
  if (method === "thread/deleted") return removeConversationThread(current, scope, threadId);

  const state = cloneState(current);
  const partition = mutablePartition(state, scope);
  const previous = partition.threads.get(threadId);
  const thread = normalizeThread(previous || params.thread || { id: threadId, turns: [] });
  partition.threads.set(threadId, thread);

  if (method === "thread/name/updated") thread.name = params.name;
  else if (method === "turn/started") upsertTurn(thread, {
    ...params.turn,
    ...(Number.isFinite(params.startedAtMs) ? { startedAtMs: params.startedAtMs } : {}),
  }, { authoritative: true });
  else if (method === "turn/completed") completeTurn(thread, {
    ...(params.turn || {
      id: params.turnId,
      status: "completed",
    }),
    ...(Number.isFinite(params.completedAtMs) ? { completedAtMs: params.completedAtMs } : {}),
  });
  else if (method === "item/started" || method === "item/completed") {
    const turn = ensureTurn(thread, params.turnId);
    const eventTime = method === "item/completed" ? params.completedAtMs : params.startedAtMs;
    const previousItem = turn?.items?.find((item) => item.id === params.item?.id);
    const startedAtMs = method === "item/started" ? eventTime : previousItem?.startedAtMs;
    const completedAtMs = method === "item/completed" ? eventTime : previousItem?.completedAtMs;
    upsertItem(turn, {
      ...params.item,
      _live: true,
      ...(Number.isFinite(eventTime) ? { timestamp: eventTime } : {}),
      ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
      ...(Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
      ...(params.item?.type === "contextCompaction"
        ? { _compactionComplete: method === "item/completed" }
        : {}),
    }, {
      authoritative: method === "item/completed",
      terminal: method === "item/completed",
    });
  } else if (method === "item/agentMessage/delta") {
    appendItemText(thread, params, "agentMessage", "text");
  } else if (method === "item/commandExecution/outputDelta") {
    appendItemText(thread, params, "commandExecution", "aggregatedOutput");
  } else if (method === "item/plan/delta") {
    appendItemText(thread, params, "plan", "text");
  } else if (method === "item/fileChange/outputDelta") {
    appendItemText(thread, params, "fileChange", "aggregatedOutput");
  } else if (method === "item/fileChange/patchUpdated") {
    const turn = streamingTurn(thread, params.turnId);
    const item = ensureItem(turn, params.itemId, "fileChange");
    if (item) item.changes = Array.isArray(params.changes) ? params.changes.map(copyObject) : [];
  } else if (method === "turn/plan/updated") {
    const turn = streamingTurn(thread, params.turnId);
    const item = ensureItem(turn, `turn-plan-${params.turnId}`, "plan");
    if (item) {
      item.text = [
        params.explanation,
        ...(Array.isArray(params.plan) ? params.plan.map((step) => (
          `- [${step.status || "pending"}] ${step.step || step.text || ""}`
        )) : []),
      ].filter(Boolean).join("\n");
    }
  } else if (method === "turn/diff/updated") {
    const turn = streamingTurn(thread, params.turnId);
    if (turn) turn._diff = typeof params.diff === "string" ? params.diff : "";
  } else if ([
    "item/reasoning/summaryPartAdded",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
  ].includes(method)) {
    updateReasoningItem(thread, method, params);
  } else if (method === "item/commandExecution/terminalInteraction") {
    const turn = streamingTurn(thread, params.turnId);
    const item = ensureItem(turn, params.itemId, "commandExecution");
    if (item) {
      item.command ||= "交互式终端";
      item.aggregatedOutput = `${item.aggregatedOutput || ""}\n[已向终端 ${params.processId || ""} 发送输入]`.trim();
    }
  } else if (method === "item/mcpToolCall/progress") {
    const turn = streamingTurn(thread, params.turnId);
    const item = ensureItem(turn, params.itemId, "mcpToolCall");
    if (item) item._progress = `${item._progress || ""}${item._progress ? "\n" : ""}${params.message || ""}`;
  } else if (method === "hook/started" || method === "hook/completed") {
    const run = object(params.run);
    upsertLiveItem(thread, params.turnId, {
      id: `hook-${run.id || run.runId || params.turnId}`,
      type: "hookRun",
      run,
      name: run.name || run.hookName,
      eventName: run.eventName || run.event,
      output: run.output,
      message: run.message || run.error,
      status: method.endsWith("/completed") ? run.status || "completed" : "inProgress",
    });
  } else if (method === "model/rerouted") {
    upsertLiveItem(thread, params.turnId, {
      id: `model-reroute-${params.turnId}`,
      type: "modelReroute",
      fromModel: params.fromModel,
      toModel: params.toModel,
      reason: params.reason,
      _trustedSource: true,
    });
  } else if (method === "model/safetyBuffering/updated") {
    upsertLiveItem(thread, params.turnId, {
      id: `model-safety-buffering-${params.turnId}`,
      type: "modelSafetyBuffering",
      model: params.model,
      useCases: Array.isArray(params.useCases) ? [...params.useCases] : [],
      reasons: Array.isArray(params.reasons) ? [...params.reasons] : [],
      showBufferingUi: params.showBufferingUi === true,
      fasterModel: identifier(params.fasterModel),
      status: params.showBufferingUi === true ? "inProgress" : "completed",
      _trustedSource: true,
    });
  } else if (method === "model/verification") {
    upsertLiveItem(thread, params.turnId, {
      id: `model-verification-${params.turnId}`,
      type: "modelVerification",
      verifications: Array.isArray(params.verifications) ? params.verifications.map(copyObject) : [],
      status: "required",
      _trustedSource: true,
    });
  } else if (method === "turn/moderationMetadata") {
    upsertLiveItem(thread, params.turnId, {
      id: `turn-moderation-${params.turnId}`,
      type: "turnModerationMetadata",
      metadata: params.metadata,
      status: "received",
      _trustedSource: true,
    });
  } else if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    upsertLiveItem(thread, params.turnId, {
      id: `guardian-review-${params.reviewId}`,
      type: "guardianApprovalReview",
      reviewId: params.reviewId,
      targetItemId: params.targetItemId,
      startedAtMs: params.startedAtMs,
      completedAtMs: params.completedAtMs || null,
      decisionSource: params.decisionSource || null,
      review: object(params.review),
      action: params.action || { type: "unknown" },
      status: params.review?.status || (method.endsWith("/completed") ? "aborted" : "inProgress"),
      _trustedSource: true,
    });
  } else if (method === "error" && params.willRetry !== true) {
    const turnId = identifier(params.turnId || params.turn?.id);
    if (turnId) {
      const turn = ensureTurn(thread, turnId);
      turn.status = "failed";
      turn.error = params.error || null;
    }
  }

  state.revision += 1;
  return state;
}

export function selectConversationThread(state, scope, threadId) {
  return state?.scopes
    ?.get(conversationScopeKey(scope))
    ?.threads
    ?.get(threadId) || null;
}

export function listConversationThreads(state, scope) {
  return [...(state?.scopes?.get(conversationScopeKey(scope))?.threads?.values() || [])]
    .map(normalizeThread);
}

function cloneState(current) {
  return {
    revision: Number.isSafeInteger(current?.revision) ? current.revision : 0,
    scopes: new Map(current?.scopes || []),
  };
}

function mutablePartition(state, scope) {
  const key = conversationScopeKey(scope);
  const previous = state.scopes.get(key);
  const partition = { threads: new Map(previous?.threads || []) };
  state.scopes.set(key, partition);
  return partition;
}

function normalizeThread(value) {
  const thread = copyObject(value);
  thread.turns = Array.isArray(value?.turns)
    ? value.turns.map(normalizeTurn)
    : [];
  return thread;
}

function normalizeTurn(value) {
  const turn = copyObject(value);
  turn.items = Array.isArray(value?.items) ? value.items.map(copyObject) : [];
  return turn;
}

function upsertTurn(thread, incoming, { authoritative = false, terminal = false } = {}) {
  if (!incoming?.id) return null;
  const index = thread.turns.findIndex((turn) => turn.id === incoming.id);
  const previous = index === -1 ? null : thread.turns[index];
  let turn;
  if (authoritative) {
    turn = normalizeTurn(incoming);
    // A native Turn ID is immutable. A delayed/replayed turn/started event
    // must not reopen a Turn that has already reached a terminal state.
    if (!terminal && previous && !runningStatus(previous.status) && runningStatus(turn.status)) {
      turn.status = previous.status;
    }
    if (terminal && previous) {
      const officialIds = new Set(turn.items.map((item) => item.id));
      const notifications = previous.items.filter((item) => (
        item?._trustedSource === true
        && TURN_NOTIFICATION_ITEM_TYPES.has(item.type)
        && !officialIds.has(item.id)
      ));
      if (notifications.length) turn.items.push(...notifications.map(copyObject));
    }
  } else {
    turn = normalizeTurn({ ...previous, ...incoming });
  }
  if (terminal && runningStatus(turn.status)) turn.status = "completed";
  if (index === -1) thread.turns.push(turn);
  else thread.turns[index] = turn;
  return turn;
}

function completeTurn(thread, incoming) {
  if (!incoming?.id) return null;
  const index = thread.turns.findIndex((turn) => turn.id === incoming.id);
  if (index === -1) {
    return upsertTurn(thread, incoming, { authoritative: true, terminal: true });
  }
  const previous = thread.turns[index];
  const summaryItems = Array.isArray(incoming.items) ? incoming.items : [];
  const turn = normalizeTurn({
    ...previous,
    ...incoming,
    items: previous.items,
  });
  for (const item of summaryItems) {
    // Codex 0.146 sends only a terminal summary here, not a complete Turn.
    // Merge the summary into the matching completed Item and retain every
    // authoritative item/completed result already observed for this Turn.
    upsertItem(turn, item, { terminal: true });
  }
  if (runningStatus(turn.status)) turn.status = "completed";
  thread.turns[index] = turn;
  return turn;
}

function ensureTurn(thread, turnId) {
  const id = identifier(turnId);
  if (!id) return null;
  let turn = thread.turns.find((entry) => entry.id === id);
  if (!turn) {
    turn = { id, status: "inProgress", items: [] };
    thread.turns.push(turn);
  }
  return turn;
}

function streamingTurn(thread, turnId) {
  const id = identifier(turnId);
  if (!id) return null;
  const existing = thread.turns.find((entry) => entry.id === id);
  if (existing && !runningStatus(existing.status)) return null;
  return existing || ensureTurn(thread, id);
}

function upsertItem(turn, incoming, { authoritative = false, terminal = false } = {}) {
  if (!turn || !incoming?.id) return null;
  const index = turn.items.findIndex((item) => item.id === incoming.id);
  const previous = index === -1 ? null : turn.items[index];
  const item = copyObject(authoritative ? incoming : { ...previous, ...incoming });
  if (terminal && runningStatus(item.status)) item.status = "completed";
  if (index === -1) turn.items.push(item);
  else turn.items[index] = item;
  return item;
}

function ensureItem(turn, itemId, type) {
  const id = identifier(itemId);
  if (!turn || !id) return null;
  let item = turn.items.find((entry) => entry.id === id);
  if (!item) {
    item = { id, type, status: "inProgress" };
    turn.items.push(item);
  }
  return item;
}

function appendItemText(thread, params, type, field) {
  const turn = streamingTurn(thread, params.turnId);
  const item = ensureItem(turn, params.itemId, type);
  if (!item) return;
  item._live = true;
  item[field] = `${item[field] || ""}${typeof params.delta === "string" ? params.delta : ""}`;
}

function updateReasoningItem(thread, method, params) {
  const turn = streamingTurn(thread, params.turnId);
  const item = ensureItem(turn, params.itemId, "reasoning");
  if (!item) return;
  item._live = true;
  if (!Array.isArray(item.summary)) item.summary = [];
  if (method === "item/reasoning/summaryPartAdded") {
    const index = Math.max(0, Number(params.summaryIndex) || 0);
    while (item.summary.length <= index) item.summary.push("");
  } else if (method === "item/reasoning/summaryTextDelta") {
    const index = Math.max(0, Number(params.summaryIndex) || 0);
    while (item.summary.length <= index) item.summary.push("");
    item.summary[index] = `${item.summary[index] || ""}${params.delta || ""}`;
  } else {
    item._reasoningText = `${item._reasoningText || ""}${params.delta || ""}`;
  }
}

function upsertLiveItem(thread, turnId, item) {
  const turn = streamingTurn(thread, turnId);
  if (!turn || !item?.id) return null;
  return upsertItem(turn, {
    threadId: thread.id,
    turnId,
    _live: true,
    ...item,
  });
}

function runningStatus(value) {
  const status = typeof value === "object" ? value?.type : value;
  return !status || ["inProgress", "running", "started"].includes(status);
}

function identifier(value) {
  return typeof value === "string" && value ? value : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function copyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
