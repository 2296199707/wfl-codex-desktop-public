import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RecoveryStore } from "../lib/recovery-store.mjs";

test("persists only bounded lightweight recovery metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-recovery-store-"));
  let now = 1000;
  try {
    const store = await new RecoveryStore(directory, { limit: 2, now: () => now++ }).initialize();
    await store.remember({ threadId: "thread_0001", cwd: "/srv/first", status: "remembered" });
    await store.remember({ threadId: "thread_0002", cwd: "/srv/second", status: "recovered" });
    await store.remember({ threadId: "thread_0003", cwd: "/srv/third", status: "failed" });

    assert.deepEqual(store.snapshot().map((record) => record.threadId), ["thread_0003", "thread_0002"]);
    const storedText = await fs.readFile(path.join(directory, "thread-recovery.json"), "utf8");
    assert.doesNotMatch(storedText, /message|prompt|turns/i);
    assert.equal((await fs.stat(path.join(directory, "thread-recovery.json"))).mode & 0o777, 0o600);

    const reloaded = await new RecoveryStore(directory).initialize();
    assert.deepEqual(reloaded.snapshot(), store.snapshot());
    assert.equal(await reloaded.remove("thread_0002"), true);
    assert.equal(await reloaded.remove("thread_9999"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid recovery metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-recovery-store-"));
  try {
    const store = await new RecoveryStore(directory).initialize();
    await assert.rejects(
      store.remember({ threadId: "bad", cwd: "/srv/project", status: "remembered" }),
      /thread ID/,
    );
    await assert.rejects(
      store.remember({ threadId: "thread_0001", cwd: "relative", status: "remembered" }),
      /project path/,
    );
    await assert.rejects(
      store.remember({ threadId: "thread_0001", cwd: "/srv/project", status: "unknown" }),
      /status/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
