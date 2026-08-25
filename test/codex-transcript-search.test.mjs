import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isCodexTranscriptSearchCursor,
  searchCodexTranscriptOccurrences,
} from "../lib/codex-transcript-search.mjs";

test("native transcript search finds user and agent messages with stable turn cursors", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-search-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "07", "31");
  await fs.mkdir(sessions, { recursive: true });
  const threadId = "019fb920-785e-7de2-987c-4535ac37bc27";
  const transcript = path.join(sessions, `rollout-test-${threadId}.jsonl`);
  const entries = [
    { type: "session_meta", payload: { session_id: threadId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "needle hidden" }] } },
    { type: "event_msg", payload: { type: "user_message", message: '<wfl_collaboration_preference strategy="adaptive">legacy preference</wfl_collaboration_preference>\n\nfirst needle from user' } },
    { type: "event_msg", payload: { type: "agent_message", message: "agent needle reply", phase: "final_answer" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
    { type: "event_msg", payload: { type: "user_message", message: "another needle" } },
  ];
  await fs.writeFile(transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const first = await searchCodexTranscriptOccurrences({
    codexHome: root,
    filePath: transcript,
    threadId,
    searchTerm: "needle",
    limit: 2,
  });
  assert.equal(first.data.length, 2);
  assert.equal(first.data[0].turnId, "turn-1");
  assert.equal(first.data[0].itemType, "userMessage");
  assert.equal(first.data[0].itemOrdinal, 0);
  assert.deepEqual(JSON.parse(first.data[0].turnCursor), { turnId: "turn-1", includeAnchor: true });
  assert.equal(first.data[1].itemType, "agentMessage");
  assert.equal(first.data[1].itemOrdinal, 1);
  assert.equal(first.nextCursor, "wfl-native-search-v1-2");
  assert.equal(isCodexTranscriptSearchCursor(first.nextCursor), true);

  const second = await searchCodexTranscriptOccurrences({
    codexHome: root,
    filePath: transcript,
    threadId,
    searchTerm: "needle",
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.equal(second.data.length, 1);
  assert.equal(second.data[0].turnId, "turn-2");
  assert.equal(second.nextCursor, null);

  const promptOnly = await searchCodexTranscriptOccurrences({
    codexHome: root,
    filePath: transcript,
    threadId,
    searchTerm: "same-level user preference",
    limit: 2,
  });
  assert.deepEqual(promptOnly.data, []);
});

test("native transcript search rejects files outside the account sessions directory", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-search-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-search-outside-"));
  context.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const transcript = path.join(outside, "rollout.jsonl");
  await fs.writeFile(transcript, `${JSON.stringify({ type: "session_meta", payload: { session_id: "thread-1" } })}\n`);
  await assert.rejects(
    searchCodexTranscriptOccurrences({
      codexHome: root,
      filePath: transcript,
      threadId: "thread-1",
      searchTerm: "needle",
    }),
    /不在账号会话目录/,
  );
});

test("native transcript search hides the collaboration prefix and searches only the user task", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-search-prompt-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const threadId = "thread-collaboration-search";
  const transcript = path.join(sessions, "rollout.jsonl");
  const task = "inspect only the visible task marker";
  const message = `<wfl_collaboration_preference strategy="adaptive">legacy preference</wfl_collaboration_preference>\n\n${task}`;
  await fs.writeFile(transcript, [
    { type: "session_meta", payload: { session_id: threadId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "user_message", message } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const visible = await searchCodexTranscriptOccurrences({
    codexHome: root,
    filePath: transcript,
    threadId,
    searchTerm: "visible task marker",
  });
  assert.equal(visible.data.length, 1);
  assert.doesNotMatch(visible.data[0].snippet, /wfl_collaboration_preference/);

  const hidden = await searchCodexTranscriptOccurrences({
    codexHome: root,
    filePath: transcript,
    threadId,
    searchTerm: "same-level user preference",
  });
  assert.equal(hidden.data.length, 0);
});
