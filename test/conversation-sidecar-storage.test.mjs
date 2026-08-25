import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationSidecarClient } from "../lib/conversation-sidecar-client.mjs";
import { ConversationSidecarStorage } from "../lib/conversation-sidecar-storage.mjs";

const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const CURRENT_GID = typeof process.getgid === "function" ? process.getgid() : 0;

test("Sidecar schema removes superseded event replay and submission tables", (t) => {
  const fixture = storageFixture(t, "wfl-sidecar-ledger-migration-");
  fixture.storage.stateDatabase.exec(`
    CREATE TABLE submissions(submission_id TEXT PRIMARY KEY, payload BLOB);
    CREATE TABLE submission_transitions(transition_id INTEGER PRIMARY KEY);
    CREATE TABLE operation_ledger(operation_id TEXT PRIMARY KEY);
    CREATE TABLE migration_journal(migration_id TEXT PRIMARY KEY);
    CREATE TABLE event_state(account_id TEXT PRIMARY KEY);
    CREATE TABLE event_log(event_id INTEGER PRIMARY KEY);
    CREATE TABLE event_contents(content_id TEXT PRIMARY KEY);
    CREATE TABLE source_mappings(source_key TEXT PRIMARY KEY);
    CREATE TABLE ack_leases(lease_id TEXT PRIMARY KEY);
  `);
  fixture.storage.close();

  const reopened = openStorage(fixture.directory);
  t.after(() => reopened.close());
  const obsolete = reopened.stateDatabase.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'submissions', 'submission_transitions', 'operation_ledger', 'migration_journal',
      'event_state', 'event_log', 'event_contents', 'source_mappings', 'ack_leases'
    )
  `).all();
  assert.deepEqual(obsolete, []);
  assert.equal(reopened.health().schemaVersion, 2);
});

test("history indexing excludes partial lines, resumes the active Turn, and detects replacement", (t) => {
  const fixture = storageFixture(t, "wfl-sidecar-history-");
  const source = path.join(fixture.root, "rollout.jsonl");
  const initialLines = [
    historyLine("turn_context", { turn_id: "turn-1" }),
    historyLine("response_item", { id: "item-1", role: "assistant" }),
    historyLine("event_msg", {
      type: "user_message",
      message: { client_id: "client-1" },
    }),
    historyLine("turn_context", { turn_id: "turn-2" }),
  ];
  const partial = historyLine("response_item", {
    id: "item-2",
    role: "assistant",
  });
  fs.writeFileSync(source, `${initialLines.join("\n")}\n${partial}`, { mode: 0o600 });

  const first = fixture.storage.indexHistory({ sourcePath: source });
  assert.equal(first.rebuildReason, "new-source");
  assert.equal(first.rowsIndexed, 4);
  assert.equal(first.trailingBytes, Buffer.byteLength(partial));
  let turns = fixture.storage.historyTurns({ sourceKey: first.sourceKey, limit: 10 });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].itemCount, 0);
  assert.equal(turns[1].itemCount, 1);
  assert.equal(turns[1].userCount, 1);

  const appended = historyLine("response_item", {
    id: "item-3",
    role: "assistant",
  });
  fs.appendFileSync(source, `\n${appended}\n`);
  const second = fixture.storage.indexHistory({ sourcePath: source });
  assert.equal(second.rebuildReason, null);
  assert.equal(second.rowsIndexed, 2);
  assert.equal(second.trailingBytes, 0);
  turns = fixture.storage.historyTurns({ sourceKey: first.sourceKey, limit: 10 });
  assert.equal(turns[0].itemCount, 2);

  fs.writeFileSync(source, `${historyLine("turn_context", { turn_id: "turn-3" })}\n`, {
    mode: 0o600,
  });
  const truncated = fixture.storage.indexHistory({ sourcePath: source });
  assert.equal(truncated.rebuildReason, "source-truncated");
  assert.equal(truncated.indexedTurns, 1);

  const replacement = path.join(fixture.root, "replacement.jsonl");
  fs.writeFileSync(
    replacement,
    `${historyLine("turn_context", { turn_id: "turn-4" })}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(replacement, source);
  const replaced = fixture.storage.indexHistory({ sourcePath: source });
  assert.equal(replaced.rebuildReason, "inode-changed");
  assert.equal(replaced.indexedTurns, 1);

  const fd = fs.openSync(source, "r+");
  fs.writeSync(fd, Buffer.from("["), 0, 1, 0);
  fs.closeSync(fd);
  const headChanged = fixture.storage.indexHistory({ sourcePath: source });
  assert.equal(headChanged.rebuildReason, "head-prefix-changed");
});

test("history indexing skips oversized payload parsing without losing later page boundaries", (t) => {
  const fixture = storageFixture(t, "wfl-sidecar-history-oversized-");
  const source = path.join(fixture.root, "rollout.jsonl");
  const oversized = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", output: "x".repeat(11 * 1024 * 1024) },
  });
  fs.writeFileSync(source, [
    historyLine("turn_context", { turn_id: "turn-large" }),
    oversized,
    historyLine("response_item", { id: "item-after-large", role: "assistant" }),
    historyLine("turn_context", { turn_id: "turn-next" }),
    historyLine("response_item", { id: "item-next", role: "assistant" }),
  ].join("\n") + "\n", { mode: 0o600 });

  const indexed = fixture.storage.indexHistory({ sourcePath: source });
  assert.equal(indexed.oversizedRecords, 1);
  assert.equal(indexed.trailingBytes, 0);
  assert.equal(indexed.indexedRecords, 5);
  const first = fixture.storage.historyTurns({ sourceKey: indexed.sourceKey, limit: 1 });
  const second = fixture.storage.historyTurns({
    sourceKey: indexed.sourceKey,
    limit: 1,
    before: first[0].turnOrdinal,
  });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].turnIdDigest, second[0].turnIdDigest);
  assert.equal(first[0].itemCount, 1);
  assert.equal(second[0].itemCount, 1);
});

test("history identities expose stable response IDs without treating event previews as messages", (t) => {
  const fixture = storageFixture(t, "wfl-sidecar-history-identities-");
  const source = path.join(fixture.root, "rollout.jsonl");
  const text = "one canonical assistant reply";
  fs.writeFileSync(source, [
    historyLine("turn_context", { turn_id: "turn-1" }),
    historyLine("event_msg", { type: "agent_message", message: text, phase: "commentary" }),
    historyLine("response_item", {
      type: "message",
      id: "msg-stable-1",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    }),
  ].join("\n") + "\n", { mode: 0o600 });

  const result = fixture.storage.historyMessageIdentities({
    sourcePath: source,
    turnIds: ["turn-1"],
  });
  assert.equal(result.truncated, false);
  assert.ok(result.scannedBytes > 0);
  assert.equal(result.scannedBytes, fs.statSync(source).size);
  assert.equal(result.indexedRecords, 3);
  assert.deepEqual(result.messages.map((message) => ({
    turnId: message.turnId,
    itemId: message.itemId,
    phase: message.phase,
  })), [{
    turnId: "turn-1",
    itemId: "msg-stable-1",
    phase: "commentary",
  }]);
  assert.match(result.messages[0].fingerprint, /^[a-f0-9]{64}$/);
});

test("history mode accepts read-only native files behind a private owner boundary", (t) => {
  const fixture = storageFixture(t, "wfl-sidecar-history-native-mode-");
  const source = path.join(fixture.root, "rollout.jsonl");
  fs.writeFileSync(
    source,
    `${historyLine("turn_context", { turn_id: "turn-1" })}\n`,
    { mode: 0o644 },
  );
  assert.equal(fixture.storage.indexHistory({ sourcePath: source }).indexedTurns, 1);
  assert.equal(fs.statSync(source).mode & 0o777, 0o644);
});

test("history ownership and writable-mode failures are reported without repairing the source", (t) => {
  const fixture = storageFixture(t, "wfl-sidecar-history-mode-");
  const source = path.join(fixture.root, "rollout.jsonl");
  fs.writeFileSync(
    source,
    `${historyLine("turn_context", { turn_id: "turn-1" })}\n`,
    { mode: 0o660 },
  );
  fs.chmodSync(source, 0o660);
  assert.throws(
    () => fixture.storage.indexHistory({ sourcePath: source }),
    { code: "ERR_HISTORY_MODE" },
  );
  assert.equal(fs.statSync(source).mode & 0o777, 0o660);
});

test("per-user worker restart recovers the history index and a stopped worker does not block its peer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfl-sidecar-clients-"));
  fs.chmodSync(root, 0o700);
  const clientA = new ConversationSidecarClient({
    stateDirectory: path.join(root, "account-a"),
    accountId: "a",
    uid: CURRENT_UID,
    gid: CURRENT_GID,
    requestTimeoutMs: 1_000,
  });
  const clientB = new ConversationSidecarClient({
    stateDirectory: path.join(root, "account-b"),
    accountId: "b",
    uid: CURRENT_UID,
    gid: CURRENT_GID,
    requestTimeoutMs: 1_000,
  });
  t.after(async () => {
    try {
      if (clientA.child?.pid) process.kill(clientA.child.pid, "SIGCONT");
    } catch {}
    await Promise.allSettled([clientA.close(), clientB.close()]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await clientA.health()).ok, true);
  assert.equal((await clientB.health()).ok, true);
  const historySource = path.join(root, "account-a-history.jsonl");
  fs.writeFileSync(historySource, `${historyLine("response_item", {
    type: "message",
    role: "assistant",
    id: "message-persisted",
    turn_id: "turn-persisted",
  })}\n`, { mode: 0o600 });
  const indexed = await clientA.request("indexHistory", {
    sourcePath: historySource,
    expectedUid: CURRENT_UID,
    expectedGid: CURRENT_GID,
  });
  assert.equal(indexed.indexedRecords, 1);
  const firstPid = clientA.child.pid;
  process.kill(firstPid, "SIGKILL");
  await waitFor(() => clientA.child === null);
  const recovered = await clientA.request("indexHistory", {
    sourcePath: historySource,
    expectedUid: CURRENT_UID,
    expectedGid: CURRENT_GID,
  });
  assert.equal(recovered.indexedRecords, 1);
  assert.equal(recovered.rowsIndexed, 0);
  assert.notEqual(clientA.child.pid, firstPid);

  const stoppedPid = clientA.child.pid;
  process.kill(stoppedPid, "SIGSTOP");
  const stalled = clientA.request("health", {}, { timeoutMs: 250 });
  const peerStartedAt = Date.now();
  assert.equal((await clientB.health()).ok, true);
  assert.ok(Date.now() - peerStartedAt < 750);
  await assert.rejects(stalled, { code: "ERR_SIDECAR_TIMEOUT" });
  await waitFor(() => clientA.child === null);
  assert.equal((await clientA.health()).ok, true);
});

function storageFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, "state");
  fs.mkdirSync(directory, { mode: 0o700 });
  const storage = openStorage(directory);
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, storage };
}

function openStorage(directory) {
  return new ConversationSidecarStorage({
    stateDirectory: directory,
    accountId: "u1",
    expectedUid: CURRENT_UID,
    expectedGid: CURRENT_GID,
  }).initialize();
}

function historyLine(type, payload) {
  return JSON.stringify({ timestamp: "2026-07-31T00:00:00.000Z", type, payload });
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true before timeout");
}
