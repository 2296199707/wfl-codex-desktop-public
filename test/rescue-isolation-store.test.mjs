import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RescueReferenceStore } from "../lib/rescue-reference-store.mjs";
import { RescueThreadRegistry } from "../lib/rescue-thread-registry.mjs";

test("rescue references persist as read-only, hashed records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-reference-store-"));
  try {
    const store = await new RescueReferenceStore(directory, { now: () => 1_756_000_000_000 }).initialize();
    const created = await store.create({
      sourceThreadId: "main-thread-1",
      sourceTitle: "主站工程审查",
      sourceCwd: null,
      sourceVersion: "0.43.79-beta",
      turns: [
        { turnId: "turn-1", ordinal: 0, text: "用户：检查部署" },
        { turnId: "turn-2", ordinal: 1, text: "Codex：已完成只读检查" },
      ],
    });
    assert.equal(created.readOnly, true);
    assert.equal(created.messageCount, 2);
    assert.equal(created.source.cwd, "未指定工程");
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.read(created.id)).content[0].text, "用户：检查部署");

    const filename = path.join(directory, "rescue-references-v1", `${created.id}.json`);
    const record = JSON.parse(await fs.readFile(filename, "utf8"));
    record.content[0].text = "被篡改";
    await fs.writeFile(filename, JSON.stringify(record));
    assert.equal((await store.list()).length, 0);
    await assert.rejects(() => store.read(created.id), /主站只读引用校验失败/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rescue thread registry survives restart and does not trust arbitrary ids", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-thread-registry-"));
  try {
    const first = await new RescueThreadRegistry(directory).initialize();
    await first.add("rescue-thread-1");
    await first.addMany(["rescue-thread-2", "", "main-site-thread"]);
    assert.equal(first.has("rescue-thread-1"), true);
    assert.equal(first.has("unknown-thread"), false);

    const second = await new RescueThreadRegistry(directory).initialize();
    assert.deepEqual(second.snapshot(), ["rescue-thread-1", "rescue-thread-2", "main-site-thread"]);
    await second.remove("rescue-thread-1");
    assert.equal(second.has("rescue-thread-1"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
