import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPendingUserMessage,
  conversationDisplayText,
  conversationDisplayTitle,
  createThreadRecoveryRecord,
  createPendingUserMessage,
  matchesPendingUserMessage,
  mergeRecentTurnPage,
  mergeLoadedTurnPage,
  mergeLoadedItemPage,
  mergeSubagentState,
  mergeThreadItem,
  mergeThread,
  mergeTurn,
  normalizeSubagentStatus,
  normalizeThreadItemPage,
  normalizeTurnPage,
  parseThreadRecoveryRecord,
  reconcileClaudeUserMessage,
  selectTurnWindow,
  settleSubagentStateForTurn,
  summarizeFileChanges,
  sortThreadsWithPins,
  terminalSubagentStatusForTurn,
  unifiedDiffStats,
  upsertThreadItem,
  findThreadBranches,
} from "../public/thread-state.js";

const userItem = (id, text, clientId = null) => ({
  type: "userMessage",
  id,
  clientId,
  content: [{ type: "text", text, text_elements: [] }],
});

test("conversation display values hide collaboration preference metadata", () => {
  const prefixed = [
    '<wfl_collaboration_preference strategy="adaptive">',
    "server-owned preference",
    "</wfl_collaboration_preference>",
    "",
    "修一下",
  ].join("\n");
  assert.equal(conversationDisplayText(prefixed), "修一下");
  assert.equal(conversationDisplayTitle({ name: null, preview: prefixed }), "修一下");
  assert.equal(conversationDisplayTitle({ name: "自定义标题", preview: prefixed }), "自定义标题");
  assert.equal(conversationDisplayTitle(null, "后备标题"), "后备标题");
});

test("an empty turn update preserves items already shown", () => {
  const existing = {
    id: "turn-1",
    status: "inProgress",
    items: [userItem("user-1", "keep me"), { type: "agentMessage", id: "agent-1", text: "partial" }],
  };
  const merged = mergeTurn(existing, { id: "turn-1", status: "completed", items: [] });

  assert.equal(merged.status, "completed");
  assert.deepEqual(merged.items, existing.items);
});

test("a partial turn update merges items by ID without dropping siblings", () => {
  const existing = {
    id: "turn-1",
    items: [userItem("user-1", "question"), { type: "agentMessage", id: "agent-1", text: "part" }],
  };
  const merged = mergeTurn(existing, {
    id: "turn-1",
    items: [{ type: "agentMessage", id: "agent-1", text: "complete", phase: "final" }],
  });

  assert.deepEqual(merged.items.map((item) => item.id), ["user-1", "agent-1"]);
  assert.equal(merged.items[1].text, "complete");
  assert.equal(merged.items[1].phase, "final");
});

test("a full turn snapshot restores canonical item order", () => {
  const existing = {
    id: "turn-1",
    items: [{ type: "agentMessage", id: "agent-1", text: "complete" }],
  };
  const merged = mergeTurn(existing, {
    id: "turn-1",
    itemsView: "full",
    items: [userItem("user-1", "question"), { type: "agentMessage", id: "agent-1", text: "complete" }],
  });

  assert.deepEqual(merged.items.map((item) => item.id), ["user-1", "agent-1"]);
});

test("a terminal full turn snapshot removes stale live-only items", () => {
  const merged = mergeTurn({
    id: "turn-terminal-full",
    status: "inProgress",
    items: [
      userItem("user-live", "question", "client-terminal"),
      { id: "agent-live", type: "agentMessage", text: "duplicated partial partial", _live: true },
    ],
  }, {
    id: "turn-terminal-full",
    status: "completed",
    itemsView: "full",
    items: [
      userItem("user-persisted", "question", "client-terminal"),
      { id: "agent-persisted", type: "agentMessage", text: "final" },
    ],
  });

  assert.deepEqual(merged.items.map((item) => item.id), ["user-persisted", "agent-persisted"]);
  assert.equal(merged.items[1].text, "final");
});

test("a terminal full snapshot preserves notification-only event projections", () => {
  const merged = mergeTurn({
    id: "turn-terminal-events",
    status: "inProgress",
    itemsView: "full",
    items: [
      { id: "agent-live", type: "agentMessage", text: "stale partial", _live: true },
      { id: "guardian-live", type: "guardianApprovalReview", status: "denied", _live: true },
      { id: "reroute-live", type: "modelReroute", toModel: "gpt-safe", _live: true },
      { id: "protocol-live", type: "protocolEvent", method: "future/safeEvent", _live: true },
    ],
  }, {
    id: "turn-terminal-events",
    status: "completed",
    itemsView: "full",
    items: [{ id: "agent-final", type: "agentMessage", text: "final" }],
  });

  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["agent-final", "guardian-live", "reroute-live", "protocol-live"],
  );
});

test("a terminal full snapshot with an empty item list removes stale streamed items", () => {
  const merged = mergeTurn({
    id: "turn-terminal-empty",
    status: "inProgress",
    items: [
      userItem("user-1", "question", "client-1"),
      { id: "agent-1", type: "agentMessage", text: "streamed reply", _live: true },
      { id: "cmd-1", type: "commandExecution", command: "npm test", aggregatedOutput: "ok", _live: true },
    ],
  }, {
    id: "turn-terminal-empty",
    status: "completed",
    itemsView: "full",
    items: [],
  });

  assert.deepEqual(merged.items, []);
  assert.equal(merged.status, "completed");
});

test("an in-progress snapshot aliases its one-for-one native live assistant message", () => {
  const merged = mergeTurn({
    id: "turn-streaming-alias",
    status: "inProgress",
    items: [
      userItem("user-live", "question", "client-streaming-alias"),
      {
        id: "msg_native_stream",
        type: "agentMessage",
        phase: "commentary",
        text: "same progress update",
        _live: true,
      },
    ],
  }, {
    id: "turn-streaming-alias",
    status: "inProgress",
    itemsView: "full",
    items: [
      userItem("user-snapshot", "question", "client-streaming-alias"),
      {
        id: "item-3515",
        type: "agentMessage",
        phase: "commentary",
        text: "same progress update",
      },
    ],
  });

  assert.deepEqual(merged.items.map((item) => item.id), ["user-snapshot", "msg_native_stream"]);
  assert.equal(merged.items[1]._live, true);
});

test("transient assistant aliasing preserves ambiguous repeated messages", () => {
  const merged = mergeTurn({
    id: "turn-repeated-assistant",
    status: "inProgress",
    items: [
      {
        id: "msg_native_first",
        type: "agentMessage",
        phase: "commentary",
        text: "intentional repeat",
        _live: true,
      },
      {
        id: "msg_native_second",
        type: "agentMessage",
        phase: "commentary",
        text: "intentional repeat",
        _live: true,
      },
    ],
  }, {
    id: "turn-repeated-assistant",
    status: "inProgress",
    itemsView: "full",
    items: [{
      id: "item-4000",
      type: "agentMessage",
      phase: "commentary",
      text: "intentional repeat",
    }],
  });

  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["item-4000", "msg_native_first", "msg_native_second"],
  );
});

test("transient assistant aliasing never removes non-assistant displays", () => {
  const protectedItems = [
    userItem("user-visible", "same visible text"),
    { id: "plan-visible", type: "plan", text: "same visible text", _live: true },
    { id: "reasoning-visible", type: "reasoning", text: "same visible text", _live: true },
    { id: "tool-visible", type: "commandExecution", aggregatedOutput: "same visible text", _live: true },
    {
      id: "file-visible",
      type: "fileChange",
      changes: [{ path: "visible.js", kind: "update", diff: "+same visible text" }],
      _live: true,
    },
  ];
  const merged = mergeTurn({
    id: "turn-protected-displays",
    status: "inProgress",
    items: protectedItems,
  }, {
    id: "turn-protected-displays",
    status: "inProgress",
    itemsView: "full",
    items: [{
      id: "item-duplicate-looking-plan",
      type: "plan",
      text: "same visible text",
    }],
  });

  for (const item of protectedItems) {
    assert.ok(merged.items.some((candidate) => candidate.id === item.id));
  }
  assert.ok(merged.items.some((item) => item.id === "item-duplicate-looking-plan"));
});

test("an authoritative completed item replaces corrupted longer streamed content", () => {
  const merged = mergeThreadItem(
    { id: "agent-1", type: "agentMessage", text: "hellohello", aggregatedOutput: "oneone" },
    { id: "agent-1", type: "agentMessage", text: "hello", aggregatedOutput: "one" },
    { authoritative: true },
  );

  assert.equal(merged.text, "hello");
  assert.equal(merged.aggregatedOutput, "one");
});

test("a summary file-change snapshot cannot erase a complete streamed diff", () => {
  const completeDiff = [
    "--- a/public/app.js",
    "+++ b/public/app.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const merged = mergeThreadItem(
    {
      id: "change-1",
      type: "fileChange",
      changes: [{ path: "public/app.js", kind: "update", diff: completeDiff }],
    },
    {
      id: "change-1",
      type: "fileChange",
      changes: [{ path: "public/app.js", kind: "update", diff: "" }],
    },
  );

  assert.equal(merged.changes[0].diff, completeDiff);
});

test("an authoritative completed file-change item can replace its streamed diff", () => {
  const canonicalDiff = [
    "--- a/public/app.js",
    "+++ b/public/app.js",
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");
  const merged = mergeThreadItem(
    {
      id: "change-1",
      type: "fileChange",
      changes: [{
        path: "public/app.js",
        kind: "update",
        diff: `${canonicalDiff}\n+stale streamed tail`,
      }],
    },
    {
      id: "change-1",
      type: "fileChange",
      changes: [{ path: "public/app.js", kind: "update", diff: canonicalDiff }],
    },
    { authoritative: true },
  );

  assert.equal(merged.changes[0].diff, canonicalDiff);
});

test("unified diff statistics ignore file headers", () => {
  assert.deepEqual(unifiedDiffStats([
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,2 +1,3 @@",
    " same",
    "-removed",
    "+added",
    "+another",
  ].join("\n")), { additions: 2, deletions: 1 });
});

test("file-change summaries total additions and deletions across files", () => {
  const summary = summarizeFileChanges([
    {
      path: "one.txt",
      kind: "update",
      diff: "--- a/one.txt\n+++ b/one.txt\n-old\n+new",
    },
    {
      path: "two.txt",
      kind: "add",
      diff: "--- /dev/null\n+++ b/two.txt\n+first\n+second",
    },
  ]);

  assert.deepEqual(
    summary.files.map((change) => [change.path, change.kind, change.stats]),
    [
      ["one.txt", "update", { additions: 1, deletions: 1 }],
      ["two.txt", "add", { additions: 2, deletions: 0 }],
    ],
  );
  assert.equal(summary.additions, 3);
  assert.equal(summary.deletions, 1);
});

test("a recent summary cannot downgrade an already complete item snapshot", () => {
  const merged = mergeTurn({
    id: "turn-1",
    status: "completed",
    itemsView: "full",
    items: [{ id: "item-1", type: "agentMessage", text: "complete" }],
  }, {
    id: "turn-1",
    status: "completed",
    itemsView: "summary",
    items: [{ id: "item-1", type: "agentMessage", text: "summary" }],
  });

  assert.equal(merged.itemsView, "full");
  assert.equal(merged.items[0].text, "complete");
});

test("a delayed snapshot cannot regress a completed turn to in progress", () => {
  const merged = mergeTurn(
    { id: "turn-1", status: "completed", items: [] },
    { id: "turn-1", status: "inProgress", items: [] },
  );

  assert.equal(merged.status, "completed");
});

test("object turn statuses keep terminal state and expose Ultra turns as active", () => {
  const active = mergeTurn(
    { id: "turn-ultra", status: { type: "inProgress" }, items: [] },
    { id: "turn-ultra", status: { type: "inProgress" }, items: [] },
  );
  assert.deepEqual(active.status, { type: "inProgress" });

  const terminal = mergeTurn(
    { id: "turn-ultra", status: { type: "interrupted" }, items: [] },
    { id: "turn-ultra", status: { type: "inProgress" }, items: [] },
  );
  assert.deepEqual(terminal.status, { type: "interrupted" });
});

test("delayed collaboration events cannot regress terminal subagent states", () => {
  const merged = mergeThreadItem(
    {
      id: "collab-1",
      type: "collabAgentToolCall",
      status: "completed",
      agentsStates: {
        "agent-1": { status: "completed", message: "Final result" },
        "agent-2": { status: "errored", message: "Final error" },
      },
    },
    {
      id: "collab-1",
      type: "collabAgentToolCall",
      status: "inProgress",
      agentsStates: {
        "agent-1": { status: "running", message: null },
        "agent-2": { status: "pendingInit", message: null },
        "agent-3": { status: "running", message: "New agent" },
      },
    },
  );

  assert.equal(merged.status, "completed");
  assert.deepEqual(merged.agentsStates["agent-1"], { status: "completed", message: "Final result" });
  assert.deepEqual(merged.agentsStates["agent-2"], { status: "errored", message: "Final error" });
  assert.deepEqual(merged.agentsStates["agent-3"], { status: "running", message: "New agent" });
  assert.deepEqual(
    mergeSubagentState({ status: "running" }, { status: "completed", message: "Done" }),
    { status: "completed", message: "Done" },
  );
});

test("collaboration status aliases normalize terminal completion instead of showing a stale runner", () => {
  assert.equal(normalizeSubagentStatus({ type: "inProgress" }), "running");
  assert.equal(normalizeSubagentStatus("pending_init"), "pendingInit");
  assert.equal(normalizeSubagentStatus("done"), "completed");
  assert.equal(normalizeSubagentStatus("failed"), "errored");
  assert.equal(normalizeSubagentStatus("cancelled"), "interrupted");
  assert.deepEqual(
    mergeSubagentState(
      { status: "completed", message: "Finished" },
      { status: { type: "inProgress" }, message: null },
    ),
    { status: "completed", message: "Finished" },
  );
});

test("a terminal parent turn settles activity-only subagents", () => {
  assert.equal(terminalSubagentStatusForTurn({ type: "completed" }), "completed");
  assert.equal(terminalSubagentStatusForTurn("failed"), "errored");
  assert.equal(terminalSubagentStatusForTurn("cancelled"), "interrupted");
  assert.equal(terminalSubagentStatusForTurn("inProgress"), null);

  assert.deepEqual(
    settleSubagentStateForTurn(
      { status: "running", message: null, updatedAt: 100 },
      { type: "completed" },
      120,
    ),
    { status: "completed", message: null, updatedAt: 120 },
  );
  assert.deepEqual(
    settleSubagentStateForTurn(
      { status: "pendingInit", message: "Starting", updatedAt: 130 },
      "failed",
      120,
    ),
    { status: "errored", message: "Starting", updatedAt: 130 },
  );
  const terminal = { status: "shutdown", message: "Closed", updatedAt: 140 };
  assert.equal(settleSubagentStateForTurn(terminal, "completed", 150), terminal);
});

test("a delayed thread snapshot cannot erase a newer local turn", () => {
  const current = { id: "thread-1", turns: [{ id: "turn-new", status: "inProgress", items: [] }] };
  const incoming = { id: "thread-1", turns: [{ id: "turn-old", status: "completed", items: [] }] };
  const merged = mergeThread(current, incoming);

  assert.deepEqual(merged.turns.map((turn) => turn.id), ["turn-old", "turn-new"]);
});

test("a completed turn clears a stale in-progress compaction marker after switching threads", () => {
  const merged = mergeTurn(
    {
      id: "turn-compaction",
      status: "inProgress",
      items: [{ id: "item-compaction", type: "contextCompaction", _compactionComplete: false }],
    },
    {
      id: "turn-compaction",
      status: "completed",
      items: [{ id: "item-compaction", type: "contextCompaction" }],
    },
  );
  assert.equal(merged.items[0]._compactionComplete, true);
});

test("pending user messages settle only against the matching authoritative item", () => {
  let pending = createPendingUserMessage("same text", "client-1");
  assert.ok(Number.isFinite(pending.createdAt));
  pending = bindPendingUserMessage(pending, "turn-2");

  assert.equal(matchesPendingUserMessage(pending, "turn-1", userItem("user-1", "same text", "client-1")), false);
  assert.equal(matchesPendingUserMessage(pending, "turn-2", userItem("user-2", "same text", "client-other")), false);
  assert.equal(matchesPendingUserMessage(pending, "turn-2", userItem("user-3", "same text", "client-1")), true);
});

test("pending messages with attachment labels can settle against canonical text", () => {
  const pending = bindPendingUserMessage(
    createPendingUserMessage(
      "inspect this\n[图片] screenshot.png",
      "client-attachment",
      "inspect this",
    ),
    "turn-attachment",
  );

  assert.equal(
    matchesPendingUserMessage(
      { ...pending, clientId: null },
      "turn-attachment",
      userItem("user-attachment", "inspect this"),
    ),
    true,
  );
});

test("pending messages settle against canonical user text with a collaboration prefix", () => {
  const pending = createPendingUserMessage("visible task", "client-collaboration", "visible task");
  const prefixed = [
    '<wfl_collaboration_preference strategy="adaptive">',
    "server-owned preference",
    "</wfl_collaboration_preference>",
    "",
    "visible task",
  ].join("\n");
  assert.equal(matchesPendingUserMessage(pending, "turn-1", {
    type: "userMessage",
    content: [{ type: "text", text: prefixed }],
  }), true);
});

test("turn merges collapse duplicate user items with one client message ID", () => {
  const merged = mergeTurn({
    id: "turn-duplicate-user",
    status: "inProgress",
    items: [userItem("user-live", "same prompt", "client-same")],
  }, {
    id: "turn-duplicate-user",
    status: "completed",
    itemsView: "full",
    items: [
      {
        ...userItem("user-persisted", "same prompt", "client-same"),
        content: [
          { type: "text", text: "same prompt" },
          { type: "localImage", path: "/workspace/image.png" },
        ],
      },
      { id: "agent-persisted", type: "agentMessage", text: "done" },
    ],
  });

  assert.deepEqual(merged.items.map((item) => item.id), ["user-persisted", "agent-persisted"]);
  assert.equal(merged.items[0].content.length, 2);
});

test("live item upserts collapse user messages that share one client ID", () => {
  const merged = upsertThreadItem([
    userItem("user-live", "same prompt", "client-same"),
  ], {
    ...userItem("user-persisted", "same prompt", "client-same"),
    content: [
      { type: "text", text: "same prompt" },
      { type: "localImage", path: "/workspace/image.png" },
    ],
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "user-live");
  assert.equal(merged[0].content.length, 2);
});

test("Claude canonical user events replace only their matching optimistic message", () => {
  const optimistic = {
    id: "client-1",
    role: "user",
    content: "same prompt",
    _optimistic: true,
  };
  const reconciled = reconcileClaudeUserMessage([optimistic], {
    id: "server-1",
    clientMessageId: "client-1",
    role: "user",
    content: "same prompt",
  });
  const repeated = reconcileClaudeUserMessage(reconciled, {
    id: "server-2",
    clientMessageId: "client-2",
    role: "user",
    content: "same prompt",
  });

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "server-1");
  assert.equal(reconciled[0]._optimistic, false);
  assert.equal(repeated.length, 2);
});

test("long threads expose only recent turns until history is expanded", () => {
  const turns = Array.from({ length: 15 }, (_, index) => ({ id: `turn-${index + 1}` }));
  const collapsed = selectTurnWindow(turns, false, 12, 8);
  const expanded = selectTurnWindow(turns, true, 12, 8);

  assert.equal(collapsed.collapsible, true);
  assert.equal(collapsed.hiddenCount, 7);
  assert.deepEqual(collapsed.turns.map((turn) => turn.id), [
    "turn-8",
    "turn-9",
    "turn-10",
    "turn-11",
    "turn-12",
    "turn-13",
    "turn-14",
    "turn-15",
  ]);
  assert.equal(expanded.hiddenCount, 0);
  assert.equal(expanded.turns.length, 15);
});

test("paginated turns normalize newest-first pages and merge older history without duplicates", () => {
  const current = [
    { id: "turn-3", status: "inProgress", items: [] },
    { id: "turn-4", status: "completed", items: [] },
  ];
  const older = normalizeTurnPage([
    { id: "turn-2", status: "completed", items: [] },
    { id: "turn-1", status: "completed", items: [] },
  ]);
  assert.deepEqual(older.map((turn) => turn.id), ["turn-1", "turn-2"]);
  const merged = mergeLoadedTurnPage(current, [
    ...older,
    { id: "turn-3", status: "completed", items: [] },
  ], { prepend: true });
  assert.deepEqual(merged.map((turn) => turn.id), ["turn-1", "turn-2", "turn-3", "turn-4"]);
  assert.equal(merged[2].status, "completed");
});

test("turn normalization trusts timestamps when a canonical page ignores desc ordering", () => {
  const page = normalizeTurnPage([
    { id: "turn-new", startedAt: 200, status: "completed", items: [] },
    { id: "turn-old", startedAt: 100, status: "completed", items: [] },
  ]);
  assert.deepEqual(page.map((turn) => turn.id), ["turn-old", "turn-new"]);
});

test("turn normalization prefers the visible user-message time over stale turn metadata", () => {
  const page = normalizeTurnPage([
    {
      id: "019fbe0c-ee38-75a2-b1b8-c054da157160",
      startedAt: 100,
      items: [{ type: "userMessage", createdAt: "2026-08-01T15:59:07.503Z", content: [] }],
    },
    {
      id: "019fbe09-a835-7cc2-8439-13004a938f2b",
      startedAt: 200,
      items: [{ type: "userMessage", createdAt: "2026-08-01T15:55:31.813Z", content: [] }],
    },
  ]);
  assert.deepEqual(page.map((turn) => turn.id), [
    "019fbe09-a835-7cc2-8439-13004a938f2b",
    "019fbe0c-ee38-75a2-b1b8-c054da157160",
  ]);
});

test("turn normalization uses UUIDv7 chronology when turn timestamps are absent", () => {
  const page = normalizeTurnPage([
    { id: "019fbe09-a835-7cc2-8439-13004a938f2b", items: [] },
    { id: "019fbe0c-ee38-75a2-b1b8-c054da157160", items: [] },
  ]);
  assert.deepEqual(page.map((turn) => turn.id), [
    "019fbe09-a835-7cc2-8439-13004a938f2b",
    "019fbe0c-ee38-75a2-b1b8-c054da157160",
  ]);
});

test("Turn UUIDv7 creation order wins over a later rescue observation time", () => {
  const older = "019fbe7e-c0eb-7603-b1e0-0f43a64231c9";
  const newer = "019fbe82-0f32-7900-b32d-39063b717ded";
  const page = normalizeTurnPage([
    { id: older, _eventAt: 3_000, items: [] },
    { id: newer, _eventAt: 2_000, items: [] },
  ]);
  assert.deepEqual(page.map((turn) => turn.id), [older, newer]);
});

test("search-loaded Turns keep their original chronology instead of appearing as the latest reply", () => {
  const current = [
    { id: "turn-90", startedAt: 90, status: "completed", items: [] },
    { id: "turn-100", startedAt: 100, status: "completed", items: [] },
  ];
  const withSearchHit = mergeLoadedTurnPage(current, [
    { id: "turn-10", startedAt: 10, status: "completed", items: [] },
  ], { chronological: true });
  assert.deepEqual(withSearchHit.map((turn) => turn.id), ["turn-10", "turn-90", "turn-100"]);

  const withHistoryPage = mergeLoadedTurnPage(withSearchHit, [
    { id: "turn-80", startedAt: 80, status: "completed", items: [] },
  ], { prepend: true, chronological: true });
  assert.deepEqual(
    withHistoryPage.map((turn) => turn.id),
    ["turn-10", "turn-80", "turn-90", "turn-100"],
  );
});

test("recent turn refresh preserves cached older history and its exhausted cursor", () => {
  const result = mergeRecentTurnPage([
    { id: "turn-1", status: "completed", items: [{ id: "old-item" }] },
    { id: "turn-2", status: "inProgress", items: [{ id: "streamed-item", _live: true }] },
  ], [
    { id: "turn-2", status: "completed", items: [], itemsView: "summary" },
    { id: "turn-3", status: "completed", items: [] },
  ], null, "server-older-cursor");

  assert.equal(result.preservesCachedEarlierTurns, true);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.turns.map((turn) => turn.id), ["turn-1", "turn-2", "turn-3"]);
  assert.equal(result.turns[1].status, "completed");
  assert.deepEqual(result.turns[1].items.map((item) => item.id), ["streamed-item"]);
});

test("recent turn refresh adopts the server cursor when no earlier cache exists", () => {
  const result = mergeRecentTurnPage([
    { id: "turn-2", status: "inProgress", items: [] },
  ], [
    { id: "turn-2", status: "completed", items: [] },
    { id: "turn-3", status: "completed", items: [] },
  ], null, "server-older-cursor");

  assert.equal(result.preservesCachedEarlierTurns, false);
  assert.equal(result.nextCursor, "server-older-cursor");
  assert.deepEqual(result.turns.map((turn) => turn.id), ["turn-2", "turn-3"]);
});

test("recent turn refresh restores canonical order when the cache only has the newest turn", () => {
  const result = mergeRecentTurnPage([
    { id: "turn-3", status: "inProgress", items: [{ id: "streamed", _live: true }] },
  ], [
    { id: "turn-2", status: "completed", items: [] },
    { id: "turn-3", status: "completed", items: [], itemsView: "summary" },
  ]);

  assert.deepEqual(result.turns.map((turn) => turn.id), ["turn-2", "turn-3"]);
  assert.equal(result.turns[1].status, "completed");
  assert.deepEqual(result.turns[1].items.map((item) => item.id), ["streamed"]);
});

test("paginated thread items normalize chronological order and never duplicate page boundaries", () => {
  const newestFirst = normalizeThreadItemPage([
    { turnId: "turn-1", item: { id: "item-4", type: "agentMessage", text: "four" } },
    { turnId: "turn-1", item: { id: "item-3", type: "agentMessage", text: "three" } },
    { turnId: "other-turn", item: { id: "wrong-turn", type: "agentMessage", text: "skip" } },
  ], "desc", "turn-1");
  assert.deepEqual(newestFirst.map((entry) => entry.item.id), ["item-3", "item-4"]);

  const latest = mergeLoadedItemPage(
    [{ id: "summary-only", type: "agentMessage", text: "summary" }],
    newestFirst,
    { replace: true },
  );
  const earlier = normalizeThreadItemPage([
    { turnId: "turn-1", item: { id: "item-3", type: "agentMessage", text: "three complete" } },
    { turnId: "turn-1", item: { id: "item-2", type: "userMessage", content: [] } },
  ], "desc", "turn-1");
  const merged = mergeLoadedItemPage(latest, earlier, { prepend: true });

  assert.deepEqual(merged.map((item) => item.id), ["item-2", "item-3", "item-4"]);
  assert.equal(merged[1].text, "three complete");
});

test("first persisted item page preserves live streamed items that are not stored yet", () => {
  const merged = mergeLoadedItemPage([
    { id: "summary", type: "agentMessage", text: "summary" },
    { id: "streaming", type: "agentMessage", text: "partial", _live: true },
  ], [
    { turnId: "turn-1", item: { id: "persisted", type: "userMessage", content: [] } },
  ], { replace: true });

  assert.deepEqual(merged.map((item) => item.id), ["persisted", "streaming"]);
});

test("a terminal persisted item page removes stale live output", () => {
  const merged = mergeLoadedItemPage([
    { id: "persisted", type: "agentMessage", text: "wrong wrong", _live: true },
    { id: "ghost", type: "agentMessage", text: "ghost", _live: true },
  ], [
    { turnId: "turn-1", item: { id: "persisted", type: "agentMessage", text: "right" } },
  ], { replace: true, authoritative: true });

  assert.deepEqual(merged, [{ id: "persisted", type: "agentMessage", text: "right" }]);
});

test("latest persisted item refresh keeps a cached older prefix in chronological order", () => {
  const merged = mergeLoadedItemPage([
    { id: "item-1", type: "userMessage", content: [] },
    { id: "item-2", type: "agentMessage", text: "older" },
    { id: "item-3", type: "agentMessage", text: "stale" },
    { id: "item-live", type: "agentMessage", text: "streaming", _live: true },
  ], [
    { turnId: "turn-1", item: { id: "item-3", type: "agentMessage", text: "fresh" } },
    { turnId: "turn-1", item: { id: "item-4", type: "agentMessage", text: "newest" } },
  ], { replace: true, preserveUnseen: true });

  assert.deepEqual(
    merged.map((item) => item.id),
    ["item-1", "item-2", "item-3", "item-4", "item-live"],
  );
  assert.equal(merged[2].text, "fresh");
});

test("paginated item refresh collapses duplicate canonical user messages by client ID", () => {
  const merged = mergeLoadedItemPage([
    userItem("user-summary", "same prompt", "client-same"),
  ], [
    {
      turnId: "turn-1",
      item: userItem("user-page", "same prompt", "client-same"),
    },
  ], { replace: true, preserveUnseen: true });

  assert.deepEqual(merged.map((item) => item.id), ["user-summary"]);
});

test("pinned threads sort first and branches stay within one session tree", () => {
  const threads = [
    { id: "main-a", sessionId: "session-a", forkedFromId: null, createdAt: 1, updatedAt: 30 },
    { id: "branch-a", sessionId: "session-a", forkedFromId: "main-a", createdAt: 2, updatedAt: 20 },
    { id: "main-b", sessionId: "session-b", createdAt: 3, updatedAt: 40 },
  ];

  assert.deepEqual(sortThreadsWithPins(threads, new Set(["branch-a"])).map((thread) => thread.id), [
    "branch-a",
    "main-b",
    "main-a",
  ]);
  assert.deepEqual(findThreadBranches(threads, threads[0]).map((thread) => thread.id), ["main-a", "branch-a"]);
});

test("thread recovery stores only a validated thread ID and project path", () => {
  const thread = { id: "thread-123", cwd: "/srv/example", turns: [{ id: "turn-secret" }] };
  const recovery = createThreadRecoveryRecord(thread);

  assert.deepEqual(recovery, { id: "thread-123", cwd: "/srv/example" });
  assert.deepEqual(parseThreadRecoveryRecord(JSON.stringify(recovery)), recovery);
  assert.equal(parseThreadRecoveryRecord('{"id":"thread-123"}'), null);
  assert.equal(parseThreadRecoveryRecord("not-json"), null);
  assert.equal(Object.hasOwn(recovery, "turns"), false);
});
