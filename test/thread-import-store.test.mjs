import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  importedModelItems,
  importedTurns,
  parseThreadImport,
  ThreadImportStore,
} from "../lib/thread-import-store.mjs";

test("parses structured exports without trusting their thread ID or project path", () => {
  const transcript = parseThreadImport(Buffer.from(JSON.stringify({
    id: "untrusted-thread",
    cwd: "/untrusted/project",
    name: "Round trip",
    turns: [{
      id: "untrusted-turn",
      items: [
        { type: "user", text: "Question" },
        { type: "reasoning", text: "Summary" },
        { type: "assistant", text: "Answer" },
        { type: "unsupported", text: "Ignored" },
      ],
    }],
  })), { filename: "conversation.json" });

  assert.equal(transcript.name, "Round trip");
  assert.deepEqual(transcript.turns[0].items.map((item) => item.type), ["user", "reasoning", "assistant"]);
  assert.equal(Object.hasOwn(transcript, "id"), false);
  assert.equal(Object.hasOwn(transcript, "cwd"), false);
  assert.deepEqual(importedModelItems(transcript).map((item) => item.role), ["user", "assistant"]);
  assert.deepEqual(importedTurns({ id: "import_test", createdAt: 100, ...transcript })[0].items.map((item) => item.type), [
    "userMessage",
    "reasoning",
    "agentMessage",
  ]);
});

test("parses the existing Markdown export format", () => {
  const transcript = parseThreadImport(Buffer.from([
    "# Markdown conversation",
    "",
    "Thread ID: old-thread-id",
    "",
    "## 用户",
    "",
    "First question",
    "",
    "## Codex",
    "",
    "First answer",
    "",
    "## 用户",
    "",
    "Second question",
    "",
    "## Codex",
    "",
    "Second answer",
  ].join("\n")), { filename: "conversation.md" });

  assert.equal(transcript.name, "Markdown conversation");
  assert.equal(transcript.turns.length, 2);
  assert.deepEqual(transcript.turns.map((turn) => turn.items.map((item) => item.type)), [
    ["user", "assistant"],
    ["user", "assistant"],
  ]);
});

test("rejects empty, oversized, and non-conversation imports", () => {
  assert.throws(() => parseThreadImport(Buffer.alloc(0), { filename: "empty.md" }), /文件为空/);
  assert.throws(() => parseThreadImport(Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "large.md" }), /不能超过 5 MB/);
  assert.throws(() => parseThreadImport(Buffer.from('{"turns":[]}'), { filename: "empty.json" }), /没有可导入/);
  assert.throws(() => parseThreadImport(Buffer.from("not an export"), { filename: "plain.md" }), /没有可导入/);
});

test("persists imported transcripts separately from the lightweight index", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-thread-import-store-");
  try {
    const store = await new ThreadImportStore(directory, { now: () => 1_800_000_000_000 }).initialize();
    const record = await store.create({
      name: "Stored import",
      cwd: "/srv/example",
      codexThreadId: "official-thread-1",
      turns: [{ items: [{ type: "user", text: "Stored question" }, { type: "assistant", text: "Stored answer" }] }],
    });
    assert.match(record.id, /^import_[a-f0-9]{32}$/);
    assert.equal(record.materialized, false);

    const index = await fs.readFile(path.join(directory, "thread-imports", "index.json"), "utf8");
    assert.match(index, /Stored question/);
    assert.doesNotMatch(index, /Stored answer/);
    const restored = await new ThreadImportStore(directory).initialize();
    assert.equal((await restored.read(record.id)).turns[0].items[1].text, "Stored answer");

    const updated = await restored.update(record.id, {
      codexThreadId: "official-thread-2",
      materialized: true,
      convertedAt: 1_800_000_100,
      archived: true,
    });
    assert.equal(updated.codexThreadId, "official-thread-2");
    assert.equal(updated.materialized, true);
    assert.equal(updated.convertedAt, 1_800_000_100);
    assert.equal(updated.archived, true);
    await assert.rejects(restored.update(record.id, { name: "Changed snapshot" }), /只读恢复副本/);
    await assert.rejects(restored.remove(record.id), /只读恢复副本/);
    assert.equal((await restored.read(record.id)).turns[0].items[1].text, "Stored answer");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("trusted workspace migrations preserve timestamps beyond interactive record limits", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-thread-workspace-");
  try {
    const store = await new ThreadImportStore(directory).initialize();
    const turns = [{ items: [{ type: "user", text: "migrated question" }, { type: "assistant", text: "migrated answer" }] }];
    for (let index = 0; index < 100; index += 1) {
      await store.create({ name: `Imported ${index}`, cwd: "/srv/project", turns, codexThreadId: `thread-${index}` });
    }
    await assert.rejects(
      store.create({ name: "Interactive overflow", cwd: "/srv/project", turns, codexThreadId: "overflow" }),
      /100 个/,
    );
    const longTurns = Array.from({ length: 1_001 }, (_, index) => ({
      items: [{ type: index % 2 ? "assistant" : "user", text: `migrated message ${index}` }],
    }));
    const migrated = await store.createMigration({
      name: "Workspace migration",
      cwd: "/srv/project",
      turns: longTurns,
      codexThreadId: "workspace-placeholder",
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      archived: true,
    });
    assert.equal(migrated.createdAt, 1_700_000_000);
    assert.equal(migrated.updatedAt, 1_700_000_100);
    assert.equal(migrated.archived, true);
    assert.equal(store.snapshot().length, 101);
    assert.equal((await store.read(migrated.id)).turns.length, 1_001);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
