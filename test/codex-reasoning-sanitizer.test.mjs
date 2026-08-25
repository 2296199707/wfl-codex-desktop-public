import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isPathOpenByPid,
  sanitizeSessionFile,
  sanitizeThreadReasoningContent,
  sessionFileContainsPlaintextReasoning,
  sessionFileForThread,
} from "../lib/codex-reasoning-sanitizer.mjs";

function makeSessionLine(type, payload) {
  return `${JSON.stringify({ timestamp: "2026-08-01T00:00:00.000Z", type, payload })}\n`;
}

function buildSessionFixture(directory, threadId) {
  const sessionDirectory = path.join(directory, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const file = path.join(sessionDirectory, `rollout-2026-08-01T00-00-00-${threadId}.jsonl`);
  const lines = [
    makeSessionLine("session_meta", { session_id: threadId }),
    makeSessionLine("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<instructions>" }] }),
    makeSessionLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }),
    makeSessionLine("response_item", {
      type: "reasoning",
      id: "rs_plaintext",
      summary: [],
      content: [{ type: "reasoning_text", text: "think step by step" }],
    }),
    makeSessionLine("response_item", { type: "reasoning", id: "rs_encrypted", summary: [], encrypted_content: "enc" }),
    makeSessionLine("response_item", { type: "function_call_output", call_id: "call_1", output: "ok" }),
  ];
  fs.writeFileSync(file, lines.join(""), { mode: 0o600 });
  return file;
}

test("sanitize removes plaintext reasoning content and preserves other lines", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wfl-sanitize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const threadId = "019fAAAA-BBBB-CCCC-DDDD-EEEEFFFFFFFF";
  const file = buildSessionFixture(directory, threadId);
  const originalBytes = fs.readFileSync(file);
  assert.equal(await sessionFileContainsPlaintextReasoning(file), true);

  const result = await sanitizeSessionFile(file, { backupDirectory: path.join(directory, "backups") });
  assert.equal(result.sanitized, true);
  assert.equal(result.reasoningItemsCleaned, 1);
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), originalBytes.toString("utf8"));

  const after = fs.readFileSync(file, "utf8");
  assert.equal(await sessionFileContainsPlaintextReasoning(file), false);
  const events = after.trim().split("\n").map((line) => JSON.parse(line));
  const reasoning = events.find((event) => event.payload?.id === "rs_plaintext");
  assert.deepEqual(reasoning.payload.content, []);
  const encrypted = events.find((event) => event.payload?.id === "rs_encrypted");
  assert.equal(encrypted.payload.encrypted_content, "enc");
  const output = events.find((event) => event.payload?.type === "function_call_output");
  assert.equal(output.payload.output, "ok");
  assert.equal(events.length, 6);
});

test("dry run does not write the file", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wfl-sanitize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const threadId = "019fBBBB-CCCC-DDDD-EEEE-FFFF00000000";
  const file = buildSessionFixture(directory, threadId);
  const before = fs.readFileSync(file);
  const result = await sanitizeSessionFile(file, { dryRun: true });
  assert.equal(result.sanitized, true);
  assert.equal(result.dryRun, true);
  assert.equal(fs.readFileSync(file).toString("utf8"), before.toString("utf8"));
});

test("sessionFileForThread finds the matching rollout", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wfl-sanitize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const threadId = "019fCCCC-DDDD-EEEE-FFFF-111122223333";
  const file = buildSessionFixture(directory, threadId);
  const found = await sessionFileForThread(path.join(directory, "sessions"), threadId);
  assert.equal(found, file);
  const missing = await sessionFileForThread(path.join(directory, "sessions"), "019fDDDD-0000-0000-0000-000000000000");
  assert.equal(missing, null);
});

test("isPathOpenByPid detects a held session file", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wfl-sanitize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const threadId = "019fDDDD-EEEE-FFFF-AAAA-222233334444";
  const file = buildSessionFixture(directory, threadId);
  const handle = fs.openSync(file, "a");
  t.after(() => fs.closeSync(handle));
  assert.equal(isPathOpenByPid(file, process.pid), true);
  assert.equal(isPathOpenByPid(file, 1), false);
});

test("sanitizeThreadReasoningContent reports locked threads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wfl-sanitize-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const threadId = "019fEEEE-FFFF-BBBB-AAAA-333344445555";
  const file = buildSessionFixture(directory, threadId);
  const handle = fs.openSync(file, "a");
  t.after(() => fs.closeSync(handle));
  const result = await sanitizeThreadReasoningContent({
    codexHome: directory,
    threadId,
    bridgePid: process.pid,
  });
  assert.equal(result.locked, true);
  assert.equal(result.sanitized, false);
});
