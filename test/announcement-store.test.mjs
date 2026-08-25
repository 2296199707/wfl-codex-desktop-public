import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnnouncementStore } from "../lib/announcement-store.mjs";

const announcementId = "123e4567-e89b-42d3-a456-426614174000";

test("announcement drafts remain private until an explicit publication", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-announcement-"));
  let now = 1_000;
  try {
    const store = await new AnnouncementStore(directory, {
      now: () => now++,
      createId: () => announcementId,
    }).initialize();
    assert.deepEqual(store.snapshot(), { published: null });
    const drafted = await store.saveDraft({ category: "update", title: "  版本 更新  ", body: "第一行\r\n第二行" });
    assert.equal(drafted.draft.title, "版本 更新");
    assert.equal(drafted.draft.body, "第一行\n第二行");
    assert.equal(store.snapshot().published, null);
    assert.equal(Object.hasOwn(store.snapshot(), "draft"), false);

    const published = await store.publish({ category: "maintenance", title: "维护通知", body: "今晚维护" });
    assert.deepEqual(published.published, {
      id: announcementId,
      category: "maintenance",
      title: "维护通知",
      body: "今晚维护",
      publishedAt: 1_001,
    });
    assert.equal((await fs.stat(path.join(directory, "announcement.json"))).mode & 0o777, 0o600);

    const reloaded = await new AnnouncementStore(directory).initialize();
    assert.deepEqual(reloaded.snapshot(), { published: published.published });
    const removed = await reloaded.unpublish();
    assert.equal(removed.published, null);
    assert.equal(removed.draft.title, "维护通知");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("announcement content is bounded and invalid persisted data is discarded", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-announcement-"));
  try {
    const store = await new AnnouncementStore(directory).initialize();
    await assert.rejects(store.saveDraft({ title: "", body: "content" }), /标题不能为空/);
    await assert.rejects(store.publish({ title: "title", body: "" }), /内容不能为空/);
    await assert.rejects(store.publish({ title: "x".repeat(81), body: "content" }), /80 个字符/);
    await assert.rejects(store.publish({ title: "title", body: "x".repeat(4_001) }), /4000 个字符/);

    await fs.writeFile(path.join(directory, "announcement.json"), '{"version":1,"published":{"id":"invalid"}}\n');
    const reloaded = await new AnnouncementStore(directory).initialize();
    assert.deepEqual(reloaded.snapshot({ includeDraft: true }), { published: null, draft: null });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
