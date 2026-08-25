function itemText(item) {
  if (item?.type !== "userMessage") return "";
  return stripCollaborationPreference((item.content || [])
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")).text;
}

export function stripCollaborationPreference(value) {
  const text = String(value || "");
  const match = /^<wfl_collaboration_preference strategy="(adaptive|required)">/.exec(text);
  if (!match) return { text, strategy: "off" };
  const boundary = "</wfl_collaboration_preference>\n\n";
  const index = text.indexOf(boundary);
  if (index < 0) return { text, strategy: "off" };
  return { text: text.slice(index + boundary.length), strategy: match[1] };
}

export function conversationDisplayText(value) {
  return stripCollaborationPreference(value).text.trim();
}

export function conversationDisplayTitle(thread, fallback = "未命名对话") {
  for (const value of [thread?.name, thread?.preview]) {
    const visible = conversationDisplayText(value);
    if (visible) return visible;
  }
  return fallback;
}

export function createPendingUserMessage(text, clientId, matchText = text) {
  return { text, matchText, clientId, turnId: null, createdAt: Date.now() };
}

export function bindPendingUserMessage(pending, turnId) {
  if (!pending || !turnId) return pending;
  return { ...pending, turnId };
}

export function matchesPendingUserMessage(pending, turnId, item) {
  if (!pending || item?.type !== "userMessage") return false;
  if (pending.turnId && pending.turnId !== turnId) return false;
  if (item.clientId && pending.clientId) return item.clientId === pending.clientId;
  return itemText(item) === (pending.matchText ?? pending.text);
}

export function reconcileClaudeUserMessage(messages, incoming) {
  const current = Array.isArray(messages) ? messages : [];
  if (!incoming || incoming.role !== "user") return [...current];
  const incomingIds = new Set(
    [incoming.id, incoming.clientMessageId].filter((value) => typeof value === "string" && value),
  );
  let index = current.findIndex((item) => (
    item?.role === "user"
    && [item.id, item.clientMessageId].some((value) => incomingIds.has(value))
  ));
  if (index === -1) {
    const lastIndex = current.length - 1;
    const last = current[lastIndex];
    if (
      last?._optimistic === true
      && last.role === "user"
      && last.content === incoming.content
    ) {
      index = lastIndex;
    }
  }
  if (index === -1) return [...current, { ...incoming, _optimistic: false }];
  const reconciled = [...current];
  reconciled[index] = {
    ...reconciled[index],
    ...incoming,
    _optimistic: false,
  };
  return reconciled;
}

function dedupeUserMessagesByClientId(items) {
  const deduplicated = [];
  const userMessageIndexes = new Map();
  for (const item of items || []) {
    const clientId = item?.type === "userMessage" && typeof item.clientId === "string"
      ? item.clientId
      : "";
    if (!clientId || !userMessageIndexes.has(clientId)) {
      if (clientId) userMessageIndexes.set(clientId, deduplicated.length);
      deduplicated.push(item);
      continue;
    }
    const index = userMessageIndexes.get(clientId);
    const previous = deduplicated[index];
    const merged = {
      ...mergeThreadItem(previous, item),
      id: previous.id || item.id,
      clientId,
    };
    if (
      Array.isArray(previous?.content)
      && Array.isArray(item?.content)
      && previous.content.length > item.content.length
    ) {
      merged.content = previous.content;
    }
    deduplicated[index] = merged;
  }
  return deduplicated;
}

function dedupeTransientAgentMessageAliases(items) {
  const current = Array.isArray(items) ? items : [];
  const groups = new Map();
  for (let index = 0; index < current.length; index += 1) {
    const item = current[index];
    if (
      item?.type !== "agentMessage"
      || typeof item.text !== "string"
      || !item.text
      || typeof item.id !== "string"
    ) continue;
    const live = item.id.startsWith("msg_");
    const snapshot = item._live !== true && /^item-\d+$/.test(item.id);
    if (!live && !snapshot) continue;
    const key = JSON.stringify([
      typeof item.phase === "string" ? item.phase : null,
      item.text,
    ]);
    const group = groups.get(key) || { live: [], snapshot: [] };
    group[live ? "live" : "snapshot"].push({ index, item });
    groups.set(key, group);
  }

  const replacements = new Map();
  const removals = new Set();
  for (const group of groups.values()) {
    // Equal occurrence counts are important: two intentional messages with
    // the same text must remain distinct. This only aliases the one-for-one
    // temporary snapshot/live projection used while a Turn is still running.
    if (!group.live.length || group.live.length !== group.snapshot.length) continue;
    for (let index = 0; index < group.live.length; index += 1) {
      const live = group.live[index];
      const snapshot = group.snapshot[index];
      const targetIndex = Math.min(live.index, snapshot.index);
      const removedIndex = Math.max(live.index, snapshot.index);
      const replacement = {
        ...mergeThreadItem(snapshot.item, live.item),
        id: live.item.id,
      };
      if (live.item._live === true) replacement._live = true;
      else delete replacement._live;
      replacements.set(targetIndex, replacement);
      removals.add(removedIndex);
    }
  }
  if (!removals.size) return current;
  return current.flatMap((item, index) => {
    if (removals.has(index)) return [];
    return [replacements.get(index) || item];
  });
}

function dedupeThreadMessages(items) {
  return dedupeTransientAgentMessageAliases(dedupeUserMessagesByClientId(items));
}

export function dedupeThreadItems(items) {
  return dedupeThreadMessages(items);
}

const TERMINAL_SUBAGENT_STATUSES = new Set([
  "completed",
  "errored",
  "interrupted",
  "shutdown",
  "notFound",
]);

export function normalizeSubagentStatus(value, fallback = "running") {
  const raw = typeof value === "object" ? value?.type : value;
  const normalized = String(raw || "").trim();
  if (["pendingInit", "pending_init", "queued", "starting"].includes(normalized)) return "pendingInit";
  if (["running", "inProgress", "in_progress", "started", "active"].includes(normalized)) return "running";
  if (["completed", "complete", "done", "success", "succeeded"].includes(normalized)) return "completed";
  if (["errored", "error", "failed", "failure", "blocked"].includes(normalized)) return "errored";
  if (["interrupted", "cancelled", "canceled", "stopped"].includes(normalized)) return "interrupted";
  if (["shutdown", "closed", "close"].includes(normalized)) return "shutdown";
  if (["notFound", "not_found", "missing"].includes(normalized)) return "notFound";
  return fallback;
}

export function terminalSubagentStatusForTurn(value) {
  const status = normalizeSubagentStatus(value, null);
  return ["completed", "errored", "interrupted"].includes(status) ? status : null;
}

export function settleSubagentStateForTurn(current, turnStatus, updatedAt = null) {
  if (!current || typeof current !== "object") return current;
  const terminalStatus = terminalSubagentStatusForTurn(turnStatus);
  const currentStatus = normalizeSubagentStatus(current.status, null);
  if (!terminalStatus || !["pendingInit", "running"].includes(currentStatus)) return current;
  const next = { ...current, status: terminalStatus };
  if (Number.isSafeInteger(updatedAt) && updatedAt >= 0) {
    next.updatedAt = Math.max(Number.isSafeInteger(current.updatedAt) ? current.updatedAt : 0, updatedAt);
  }
  return next;
}

export function mergeSubagentState(current, incoming) {
  if (!current) return incoming ? { ...incoming } : null;
  if (!incoming) return { ...current };
  const merged = { ...current, ...incoming };
  const currentStatus = normalizeSubagentStatus(current.status, null);
  const incomingStatus = normalizeSubagentStatus(incoming.status, null);
  if (incomingStatus) merged.status = incomingStatus;
  if (currentStatus && TERMINAL_SUBAGENT_STATUSES.has(currentStatus) && incomingStatus !== currentStatus) {
    merged.status = currentStatus;
    if (current.message != null) merged.message = current.message;
  }
  if (current.message && !incoming.message) merged.message = current.message;
  return merged;
}

function mergeSubagentStates(current, incoming) {
  const currentStates = current && typeof current === "object" ? current : {};
  const incomingStates = incoming && typeof incoming === "object" ? incoming : {};
  const merged = {};
  for (const agentId of new Set([...Object.keys(currentStates), ...Object.keys(incomingStates)])) {
    merged[agentId] = mergeSubagentState(currentStates[agentId], incomingStates[agentId]);
  }
  return merged;
}

export function mergeThreadItem(current, incoming, { authoritative = false } = {}) {
  if (!current) return incoming;
  if (!incoming) return current;
  const merged = { ...current, ...incoming };
  if (authoritative && !Object.hasOwn(incoming, "_live")) delete merged._live;

  // A delayed running snapshot must not shorten content that already streamed into the UI.
  if (!authoritative) {
    for (const field of ["text", "aggregatedOutput", "reasoningText", "summaryText", "diffOutput"]) {
      if (
        typeof current[field] === "string"
        && (typeof incoming[field] !== "string" || current[field].length > incoming[field].length)
      ) merged[field] = current[field];
    }
    if (current._progress && typeof current._progress === "object") {
      merged._progress = { ...current._progress, ...(incoming._progress || {}) };
    }
  }
  if (
    current.type === "fileChange"
    || incoming.type === "fileChange"
    || Array.isArray(current.changes)
    || Array.isArray(incoming.changes)
  ) {
    merged.changes = mergeFileChanges(current.changes, incoming.changes, { authoritative });
  }
  if (current.type === "collabAgentToolCall" || incoming.type === "collabAgentToolCall") {
    merged.agentsStates = mergeSubagentStates(current.agentsStates, incoming.agentsStates);
    const currentStatus = typeof current.status === "object" ? current.status?.type : current.status;
    const incomingStatus = typeof incoming.status === "object" ? incoming.status?.type : incoming.status;
    if (currentStatus && currentStatus !== "inProgress" && incomingStatus === "inProgress") {
      merged.status = current.status;
    }
  }
  return merged;
}

function mergeFileChanges(currentChanges, incomingChanges, { authoritative = false } = {}) {
  const current = Array.isArray(currentChanges) ? currentChanges : [];
  if (!Array.isArray(incomingChanges)) return [...current];
  const incoming = incomingChanges;
  if (authoritative) return incoming.map((change) => ({ ...change }));

  const changeKey = (change, index) => {
    const path = typeof change?.path === "string" ? change.path : "";
    const kind = typeof change?.kind === "string" ? change.kind : "";
    return path ? `${kind}\0${path}` : `index:${index}`;
  };
  const currentByKey = new Map(current.map((change, index) => [changeKey(change, index), change]));
  const incomingKeys = new Set();
  const merged = incoming.map((change, index) => {
    const key = changeKey(change, index);
    incomingKeys.add(key);
    const previous = currentByKey.get(key);
    if (!previous) return { ...change };
    const next = { ...previous, ...change };
    if (
      typeof previous.diff === "string"
      && (
        typeof change.diff !== "string"
        || previous.diff.length > change.diff.length
      )
    ) {
      next.diff = previous.diff;
    }
    return next;
  });
  for (let index = 0; index < current.length; index += 1) {
    const change = current[index];
    if (!incomingKeys.has(changeKey(change, index))) merged.push({ ...change });
  }
  return merged;
}

export function unifiedDiffStats(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function summarizeFileChanges(changes) {
  const entries = (Array.isArray(changes) ? changes : [])
    .filter((change) => change && typeof change === "object")
    .map((change) => ({
      ...change,
      path: typeof change.path === "string" && change.path ? change.path : "未命名文件",
      kind: typeof change.kind === "string" && change.kind ? change.kind : "update",
      stats: unifiedDiffStats(change.diff),
    }));
  return {
    files: entries,
    additions: entries.reduce((total, change) => total + change.stats.additions, 0),
    deletions: entries.reduce((total, change) => total + change.stats.deletions, 0),
  };
}

export function upsertThreadItem(items, incoming, { authoritative = false } = {}) {
  const current = Array.isArray(items) ? items : [];
  if (!incoming || typeof incoming !== "object") return [...current];
  let index = incoming.id
    ? current.findIndex((item) => item?.id === incoming.id)
    : -1;
  if (
    index === -1
    && incoming.type === "userMessage"
    && typeof incoming.clientId === "string"
    && incoming.clientId
  ) {
    index = current.findIndex((item) => (
      item?.type === "userMessage"
      && item.clientId === incoming.clientId
    ));
  }
  if (index === -1) return dedupeThreadMessages([...current, incoming]);
  const merged = mergeThreadItem(current[index], incoming, { authoritative });
  if (
    current[index]?.type === "userMessage"
    && incoming.type === "userMessage"
    && current[index].clientId
    && current[index].clientId === incoming.clientId
  ) {
    merged.id = current[index].id || incoming.id;
  }
  const result = [...current];
  result[index] = merged;
  return dedupeThreadMessages(result);
}

export function mergeTurn(current, incoming) {
  if (!current) return { ...incoming, items: [...(incoming.items || [])] };
  if (!incoming) return current;

  const currentItems = current.items || [];
  const incomingItems = incoming.items || [];
  const mergedTurn = { ...current, ...incoming };
  const currentStatus = typeof current.status === "object" ? current.status?.type : current.status;
  const incomingStatus = typeof incoming.status === "object" ? incoming.status?.type : incoming.status;
  const incomingIsTerminal = Boolean(incomingStatus && incomingStatus !== "inProgress");
  const incomingItemsAreAuthoritative = incomingIsTerminal && incoming.itemsView !== "summary";
  if (currentStatus !== "inProgress" && incomingStatus === "inProgress") {
    mergedTurn.status = current.status;
  }
  if (current.itemsView === "full" && incoming.itemsView !== "full") {
    mergedTurn.itemsView = "full";
  }
  if (!incomingItems.length) {
    const items = incoming.itemsView === "full" && incomingIsTerminal
      ? currentItems.filter((item) => (
          item?.id && TERMINAL_EVENT_PROJECTION_TYPES.has(item.type)
        ))
      : currentItems;
    return {
      ...mergedTurn,
      items,
    };
  }

  const currentById = new Map(currentItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const incomingById = new Map(incomingItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const incomingIds = new Set();
  let items;

  if (incoming.itemsView === "full") {
    items = incomingItems.map((item) => {
      if (!item?.id) return item;
      incomingIds.add(item.id);
      return mergeThreadItem(currentById.get(item.id), item, { authoritative: incomingItemsAreAuthoritative });
    });
    if (!incomingIsTerminal) {
      for (const item of currentItems) {
        if (!item?.id || !incomingIds.has(item.id)) items.push(item);
      }
    } else {
      // Full terminal snapshots are authoritative for native Turn items, but
      // these display records exist only in the live notification protocol.
      // Preserve them until canonical/history storage can project them too;
      // ordinary streamed assistant and tool items remain snapshot-owned.
      for (const item of currentItems) {
        if (
          item?.id
          && !incomingIds.has(item.id)
          && TERMINAL_EVENT_PROJECTION_TYPES.has(item.type)
        ) items.push(item);
      }
    }
  } else {
    const currentIds = new Set();
    items = currentItems.map((item) => {
      if (!item?.id) return item;
      currentIds.add(item.id);
      return mergeThreadItem(item, incomingById.get(item.id), { authoritative: incomingItemsAreAuthoritative });
    });
    for (const item of incomingItems) {
      if (!item?.id || !currentIds.has(item.id)) items.push(item);
    }
  }
  if (incomingStatus && incomingStatus !== "inProgress") {
    items = items.map((item) => item?.type === "contextCompaction"
      ? { ...item, _compactionComplete: true }
      : item);
  }
  return { ...mergedTurn, items: dedupeThreadMessages(items) };
}

const TERMINAL_EVENT_PROJECTION_TYPES = new Set([
  "modelReroute",
  "modelSafetyBuffering",
  "modelVerification",
  "turnModerationMetadata",
  "guardianApprovalReview",
  "guardianWarning",
  "executionEnvironmentStatus",
  "protocolEvent",
]);

export function mergeThread(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;

  const currentTurns = current.turns || [];
  const incomingTurns = incoming.turns || [];
  if (!incomingTurns.length) return { ...current, ...incoming, turns: currentTurns };

  const currentById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const incomingIds = new Set();
  const turns = incomingTurns.map((turn) => {
    incomingIds.add(turn.id);
    return mergeTurn(currentById.get(turn.id), turn);
  });
  for (const turn of currentTurns) {
    if (!incomingIds.has(turn.id)) turns.push(turn);
  }
  return { ...current, ...incoming, turns };
}

export function selectTurnWindow(turns, expanded, threshold = 12, recentCount = 8) {
  if (expanded || turns.length <= threshold) return { turns, hiddenCount: 0, collapsible: turns.length > threshold };
  const hiddenCount = Math.max(0, turns.length - recentCount);
  return { turns: turns.slice(hiddenCount), hiddenCount, collapsible: true };
}

export function normalizeTurnPage(data, sortDirection = "desc") {
  const turns = Array.isArray(data) ? [...data] : [];
  // Some canonical/snapshot providers return the requested `desc` page in
  // chronological order already. Use the turn timestamps when available so
  // refreshes cannot place the newest turn above older history merely because
  // one provider ignored the sortDirection hint.
  const chronological = orderTurnsChronologically(turns);
  const allHaveTime = turns.every((turn) => turnTime(turn) !== null);
  const allHaveUuidV7 = turns.every((turn) => uuidV7Identifier(turn?.id));
  if (turns.length > 1 && (allHaveTime || allHaveUuidV7)) return chronological;
  return sortDirection === "desc" ? turns.reverse() : turns;
}

export function normalizeThreadItemPage(data, sortDirection = "desc", turnId = null) {
  const entries = Array.isArray(data)
    ? data.filter((entry) => (
      entry
      && typeof entry === "object"
      && entry.item
      && typeof entry.item === "object"
      && typeof entry.turnId === "string"
      && (!turnId || entry.turnId === turnId)
    ))
    : [];
  return sortDirection === "desc" ? [...entries].reverse() : [...entries];
}

export function mergeLoadedItemPage(
  currentItems,
  incomingEntries,
  { prepend = false, replace = false, preserveUnseen = false, authoritative = false } = {},
) {
  const current = Array.isArray(currentItems) ? currentItems : [];
  const incoming = Array.isArray(incomingEntries)
    ? incomingEntries.map((entry) => entry?.item).filter((item) => item && typeof item === "object")
    : [];
  const incomingById = new Map(incoming.filter((item) => item.id).map((item) => [item.id, item]));
  const currentById = new Map(current.filter((item) => item.id).map((item) => [item.id, item]));
  const canonicalIncoming = incoming.map((item) =>
    item.id ? mergeThreadItem(currentById.get(item.id), item, { authoritative }) : item);
  if (replace) {
    const incomingIds = new Set(incoming.filter((item) => item.id).map((item) => item.id));
    if (preserveUnseen) {
      const firstOverlap = current.findIndex((item) => item?.id && incomingIds.has(item.id));
      if (firstOverlap >= 0) {
        const prefix = current.slice(0, firstOverlap)
          .filter((item) => !item?.id || !incomingIds.has(item.id));
        const suffix = current.slice(firstOverlap)
          .filter((item) => !item?.id || !incomingIds.has(item.id));
        return dedupeThreadMessages([...prefix, ...canonicalIncoming, ...suffix]);
      }
      const persisted = current.filter((item) => item?._live !== true);
      const live = current.filter((item) => item?._live === true);
      return dedupeThreadMessages([...persisted, ...canonicalIncoming, ...live]);
    }
    const unpersisted = authoritative ? [] : current.filter((item) => (
      item?.id
      && !incomingIds.has(item.id)
      && item._live === true
    ));
    return dedupeThreadMessages([...canonicalIncoming, ...unpersisted]);
  }
  const currentIds = new Set(current.filter((item) => item?.id).map((item) => item.id));
  const mergedCurrent = current.map((item) =>
    item?.id ? mergeThreadItem(item, incomingById.get(item.id), { authoritative }) : item);
  const unseen = canonicalIncoming.filter((item) => !item?.id || !currentIds.has(item.id));
  return dedupeThreadMessages(
    prepend ? [...unseen, ...mergedCurrent] : [...mergedCurrent, ...unseen],
  );
}

export function mergeLoadedTurnPage(
  currentTurns,
  incomingTurns,
  { prepend = false, chronological = false } = {},
) {
  const incomingById = new Map(incomingTurns.filter((turn) => turn?.id).map((turn) => [turn.id, turn]));
  const currentIds = new Set(currentTurns.filter((turn) => turn?.id).map((turn) => turn.id));
  const current = currentTurns.map((turn) => mergeTurn(turn, incomingById.get(turn?.id)));
  const unseen = incomingTurns.filter((turn) => !turn?.id || !currentIds.has(turn.id));
  const merged = prepend ? [...unseen, ...current] : [...current, ...unseen];
  return chronological ? orderTurnsChronologically(merged) : merged;
}

export function orderTurnsChronologically(turns) {
  const ordered = (Array.isArray(turns) ? turns : []).map((turn, index) => ({ turn, index }));
  if (ordered.length < 2) return ordered.map((entry) => entry.turn);
  const allHaveTime = ordered.every((entry) => turnTime(entry.turn) !== null);
  const allHaveUuidV7 = ordered.every((entry) => uuidV7Identifier(entry.turn?.id));
  if (!allHaveTime && !allHaveUuidV7) return ordered.map((entry) => entry.turn);
  ordered.sort((left, right) => {
    // A native Turn UUIDv7 records when the Turn was created. Event times can
    // instead describe when another runtime observed or calibrated that Turn,
    // so an older rescue Turn discovered later must not become the latest Turn.
    if (allHaveUuidV7) {
      const difference = left.turn.id.localeCompare(right.turn.id);
      if (difference) return difference;
    }
    if (allHaveTime) {
      const difference = turnTime(left.turn) - turnTime(right.turn);
      if (difference) return difference;
    }
    return left.index - right.index;
  });
  return ordered.map((entry) => entry.turn);
}

function turnTime(turn) {
  const userMessage = (Array.isArray(turn?.items) ? turn.items : [])
    .find((item) => item?.type === "userMessage");
  for (const value of [
    userMessage?._eventAt,
    userMessage?.createdAt,
    userMessage?.startedAt,
    userMessage?.timestamp,
  ]) {
    const normalized = normalizedTime(value);
    if (normalized !== null) return normalized;
  }
  for (const value of [
    turn?._eventAt,
    turn?.createdAt,
    turn?.startedAt,
    turn?.timestamp,
    turn?._displayCreatedAt,
  ]) {
    const normalized = normalizedTime(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function normalizedTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number < 1_000_000_000_000 ? number * 1_000 : number;
}

function uuidV7Identifier(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function mergeRecentTurnPage(
  currentTurns,
  incomingTurns,
  currentCursor = null,
  incomingCursor = null,
) {
  const incomingIds = new Set(incomingTurns.map((turn) => turn?.id).filter(Boolean));
  const preservesCachedEarlierTurns = currentTurns.some(
    (turn) => turn?.id && !incomingIds.has(turn.id),
  );
  const firstOverlap = currentTurns.findIndex((turn) => turn?.id && incomingIds.has(turn.id));
  let turns;
  if (firstOverlap >= 0) {
    const currentById = new Map(
      currentTurns.filter((turn) => turn?.id).map((turn) => [turn.id, turn]),
    );
    const prefix = currentTurns.slice(0, firstOverlap)
      .filter((turn) => !turn?.id || !incomingIds.has(turn.id));
    const suffix = currentTurns.slice(firstOverlap)
      .filter((turn) => !turn?.id || !incomingIds.has(turn.id));
    const canonicalIncoming = incomingTurns.map((turn) =>
      turn?.id ? mergeTurn(currentById.get(turn.id), turn) : turn);
    turns = [...prefix, ...canonicalIncoming, ...suffix];
  } else {
    turns = mergeLoadedTurnPage(currentTurns, incomingTurns);
  }
  return {
    turns: orderTurnsChronologically(turns),
    nextCursor: preservesCachedEarlierTurns ? currentCursor : incomingCursor,
    preservesCachedEarlierTurns,
  };
}

export function sortThreadsWithPins(threads, pinnedIds) {
  return [...threads].sort((left, right) => {
    const pinOrder = Number(pinnedIds.has(right.id)) - Number(pinnedIds.has(left.id));
    return pinOrder || right.updatedAt - left.updatedAt;
  });
}

export function findThreadBranches(threads, activeThread) {
  if (!activeThread?.sessionId) return [];
  return threads
    .filter((thread) => thread.sessionId === activeThread.sessionId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function createThreadRecoveryRecord(thread) {
  if (
    typeof thread?.id !== "string" ||
    !thread.id.trim() ||
    thread.id.length > 256 ||
    typeof thread?.cwd !== "string" ||
    !thread.cwd.trim() ||
    thread.cwd.length > 4096
  ) {
    return null;
  }
  return { id: thread.id, cwd: thread.cwd };
}

export function parseThreadRecoveryRecord(value) {
  try {
    return createThreadRecoveryRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
