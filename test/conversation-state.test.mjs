import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationState,
  completedTurnStateIsComplete,
  reduceConversationNotification,
  replaceConversationThread,
  selectConversationThread,
  turnHasRenderableAssistantMessage,
} from "../public/conversation-state.js";

const scopeA = { accountId: "user-a", projectId: "/srv/a" };
const scopeB = { accountId: "user-a", projectId: "/srv/b" };

test("history recovery atomically replaces a complete Thread", () => {
  let state = createConversationState();
  state = replaceConversationThread(state, scopeA, {
    id: "thread-1",
    turns: [{ id: "turn-old", status: "completed", items: [{ id: "old" }] }],
  });
  state = replaceConversationThread(state, scopeA, {
    id: "thread-1",
    turns: [{ id: "turn-new", status: "completed", items: [{ id: "new" }] }],
  });
  assert.deepEqual(
    selectConversationThread(state, scopeA, "thread-1").turns.map((turn) => turn.id),
    ["turn-new"],
  );
});

test("project and Thread partitions cannot overwrite each other", () => {
  let state = createConversationState();
  state = replaceConversationThread(state, scopeA, { id: "same", name: "A", turns: [] });
  state = replaceConversationThread(state, scopeB, { id: "same", name: "B", turns: [] });
  assert.equal(selectConversationThread(state, scopeA, "same").name, "A");
  assert.equal(selectConversationThread(state, scopeB, "same").name, "B");
});

test("background notifications update only their explicit Thread", () => {
  let state = createConversationState();
  state = replaceConversationThread(state, scopeA, { id: "active", turns: [] });
  state = replaceConversationThread(state, scopeA, { id: "background", turns: [] });
  state = reduceConversationNotification(state, scopeA, {
    method: "turn/started",
    params: {
      threadId: "background",
      turn: { id: "turn-bg", status: "inProgress", items: [] },
    },
  });
  assert.equal(selectConversationThread(state, scopeA, "active").turns.length, 0);
  assert.equal(selectConversationThread(state, scopeA, "background").turns[0].id, "turn-bg");
});

test("completed Items remain authoritative when a terminal Turn carries only an assistant summary", () => {
  let state = createConversationState();
  state = reduceConversationNotification(state, scopeA, {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "user-1",
        type: "userMessage",
        content: [{ type: "text", text: "keep the user message" }],
      },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-1", type: "commandExecution", status: "inProgress", aggregatedOutput: "partial" },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-1", type: "commandExecution", status: "completed", aggregatedOutput: "final" },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "assistant-1", type: "agentMessage", status: "completed", text: "final" },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ id: "assistant-1", type: "agentMessage", text: "official summary" }],
      },
    },
  });
  const turn = selectConversationThread(state, scopeA, "thread-1").turns[0];
  assert.equal(turn.status, "completed");
  assert.deepEqual(turn.items.map((item) => item.id), ["user-1", "item-1", "assistant-1"]);
  assert.equal(turn.items.find((item) => item.id === "user-1").content[0].text, "keep the user message");
  assert.equal(turn.items.find((item) => item.id === "item-1").aggregatedOutput, "final");
  assert.equal(turn.items.find((item) => item.id === "assistant-1").text, "official summary");
});

test("official Item and Turn event times survive terminal snapshots as display metadata", () => {
  let state = createConversationState();
  state = reduceConversationNotification(state, scopeA, {
    method: "turn/started",
    params: {
      threadId: "thread-time",
      startedAtMs: 1_800_000_000_000,
      turn: { id: "turn-time", status: "inProgress", items: [] },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/started",
    params: {
      threadId: "thread-time",
      turnId: "turn-time",
      startedAtMs: 1_800_000_001_000,
      item: { id: "user-time", type: "userMessage", content: [{ type: "text", text: "hello" }] },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/completed",
    params: {
      threadId: "thread-time",
      turnId: "turn-time",
      completedAtMs: 1_800_000_002_000,
      item: { id: "user-time", type: "userMessage", content: [{ type: "text", text: "hello" }] },
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "turn/completed",
    params: {
      threadId: "thread-time",
      completedAtMs: 1_800_000_003_000,
      turn: { id: "turn-time", status: "completed", items: [] },
    },
  });

  const turn = selectConversationThread(state, scopeA, "thread-time").turns[0];
  assert.equal(turn.startedAtMs, 1_800_000_000_000);
  assert.equal(turn.completedAtMs, 1_800_000_003_000);
  assert.deepEqual(turn.items.map((item) => item.id), ["user-time"]);
  assert.equal(turn.items[0].startedAtMs, 1_800_000_001_000);
  assert.equal(turn.items[0].completedAtMs, 1_800_000_002_000);
});

test("late stream events cannot mutate a completed Turn snapshot", () => {
  let state = replaceConversationThread(createConversationState(), scopeA, {
    id: "thread-terminal",
    turns: [{
      id: "turn-terminal",
      status: "completed",
      items: [{ id: "assistant-terminal", type: "agentMessage", text: "final" }],
    }],
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-terminal",
      turnId: "turn-terminal",
      itemId: "assistant-terminal",
      delta: "-late",
    },
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "thread-terminal",
      turnId: "turn-terminal",
      itemId: "late-file",
      changes: [{ path: "late.txt" }],
    },
  });
  const turn = selectConversationThread(state, scopeA, "thread-terminal").turns[0];
  assert.equal(turn.items[0].text, "final");
  assert.equal(turn.items.some((item) => item.id === "late-file"), false);
});

test("a replayed turn/started event cannot reopen a terminal Turn", () => {
  let state = replaceConversationThread(createConversationState(), scopeA, {
    id: "thread-replay-fence",
    turns: [{ id: "turn-replay-fence", status: "interrupted", items: [] }],
  });
  state = reduceConversationNotification(state, scopeA, {
    method: "turn/started",
    params: {
      threadId: "thread-replay-fence",
      turn: { id: "turn-replay-fence", status: "inProgress", items: [] },
    },
  });
  const turn = selectConversationThread(state, scopeA, "thread-replay-fence").turns[0];
  assert.equal(turn.status, "interrupted");
});

test("terminal Turn snapshots retain trusted non-Item protocol notices", () => {
  const scope = { accountId: "account-a", projectId: "/srv/a" };
  let state = replaceConversationThread(createConversationState(), scope, {
    id: "thread-a",
    turns: [{ id: "turn-a", status: "inProgress", items: [] }],
  });
  state = reduceConversationNotification(state, scope, {
    method: "model/verification",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      verifications: ["trustedAccessForCyber"],
    },
  });
  state = reduceConversationNotification(state, scope, {
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: { id: "turn-a", status: "completed", items: [] },
    },
  });
  const turn = selectConversationThread(state, scope, "thread-a").turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0].type, "modelVerification");
  assert.equal(turn.items[0]._trustedSource, true);
});

test("terminal completion is incomplete until the rendered Turn has an assistant reply", () => {
  const params = {
    threadId: "thread-reply-recovery",
    turn: {
      id: "turn-reply-recovery",
      status: "completed",
      items: [{ id: "user-1", type: "userMessage" }],
    },
  };
  const userAndToolOnly = {
    id: params.turn.id,
    status: "completed",
    items: [
      { id: "user-1", type: "userMessage" },
      { id: "tool-1", type: "commandExecution", status: "completed" },
    ],
  };
  assert.equal(turnHasRenderableAssistantMessage(userAndToolOnly), false);
  assert.equal(completedTurnStateIsComplete(params, userAndToolOnly), false);

  const withReply = {
    ...userAndToolOnly,
    items: [...userAndToolOnly.items, {
      id: "assistant-1",
      type: "agentMessage",
      text: "已完成",
    }],
  };
  assert.equal(turnHasRenderableAssistantMessage(withReply), true);
  assert.equal(completedTurnStateIsComplete(params, withReply), true);
});

test("assistant delta recovery preserves a live reply when item delivery is reordered", () => {
  let state = createConversationState();
  state = reduceConversationNotification(state, scopeA, {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-delta-recovery",
      turnId: "turn-delta-recovery",
      itemId: "assistant-delta",
      delta: "先到的回复",
    },
  });
  const turn = selectConversationThread(state, scopeA, "thread-delta-recovery").turns[0];
  assert.equal(turn.status, "inProgress");
  assert.deepEqual(turn.items, [{
    id: "assistant-delta",
    type: "agentMessage",
    status: "inProgress",
    _live: true,
    text: "先到的回复",
  }]);
});
