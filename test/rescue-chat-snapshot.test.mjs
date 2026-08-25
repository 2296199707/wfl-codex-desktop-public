import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RescueChatSnapshotStore } from "../lib/rescue-chat-snapshot.mjs";

test("rescue chat snapshots preserve the last checksum-verified list and turns", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-snapshot-"));
  let now = 1_725_000_000_000;
  try {
    const store = await new RescueChatSnapshotStore(directory, { now: () => now }).initialize();
    await store.recordList({ data: [{ id: "thread-1", name: "Stable chat" }], nextCursor: null });
    now += 1_000;
    await store.recordThread({ id: "thread-1", name: "Stable chat", turns: [] });
    await store.recordTurns("thread-1", { data: [{ id: "turn-1", status: "completed" }], nextCursor: null });

    const list = await store.readList();
    assert.equal(list.data[0].name, "Stable chat");
    assert.deepEqual(list.rescueSnapshot, {
      fallback: true,
      readOnly: true,
      savedAt: 1_725_000_000_000,
    });
    const thread = await store.readThread("thread-1", { includeTurns: true });
    assert.equal(thread.thread.turns[0].id, "turn-1");
    assert.equal(thread.rescueSnapshot.savedAt, now);
    assert.equal((await store.readTurns("thread-1")).data[0].status, "completed");

    const files = await fs.readdir(path.join(directory, "rescue-chat-snapshots-v1"));
    const threadFile = files.find((name) => name.startsWith("thread-"));
    const filename = path.join(directory, "rescue-chat-snapshots-v1", threadFile);
    const envelope = JSON.parse(await fs.readFile(filename, "utf8"));
    envelope.payload.thread.name = "tampered";
    await fs.writeFile(filename, JSON.stringify(envelope));
    await assert.rejects(() => store.readThread("thread-1"), /校验失败/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid official responses never replace a valid rescue snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-snapshot-invalid-"));
  try {
    const store = await new RescueChatSnapshotStore(directory).initialize();
    await store.recordList({ data: [{ id: "thread-1" }] });
    await assert.rejects(() => store.recordList({ data: [{ name: "missing id" }] }), /Thread id/);
    assert.equal((await store.readList()).data[0].id, "thread-1");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rescue fallback lists stay isolated by project and archive scope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-snapshot-filter-"));
  try {
    const store = await new RescueChatSnapshotStore(directory).initialize();
    await store.recordList({
      data: [
        { id: "active-a", cwd: "/srv/a", archived: false },
        { id: "active-b", cwd: "/srv/b", archived: false },
        { id: "archived-a", cwd: "/srv/a", archived: true },
        { id: "sparse-a", cwd: "/srv/a" },
      ],
      nextCursor: "stale-cursor",
    });

    assert.deepEqual(
      (await store.readList({ cwd: "/srv/a" })).data.map((thread) => thread.id),
      ["active-a", "sparse-a"],
    );
    assert.deepEqual(
      (await store.readList({ cwd: "/srv/a", archived: true })).data.map((thread) => thread.id),
      ["archived-a"],
    );
    assert.equal((await store.readList({ cwd: "/srv/a" })).nextCursor, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
