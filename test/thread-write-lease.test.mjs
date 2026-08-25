import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadWriteLeaseStore } from "../lib/thread-write-lease.mjs";

test("thread leases are shared across store instances and isolate unrelated threads", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "thread-lease-"));
  try {
    const main = await new ThreadWriteLeaseStore(directory).initialize();
    const rescue = await new ThreadWriteLeaseStore(directory).initialize();
    const lease = await main.acquire("thread-1", "main-window", { surface: "main" });
    await assert.rejects(
      () => rescue.acquire("thread-1", "rescue-window", { surface: "rescue" }),
      (error) => error.code === "ERR_THREAD_LEASE_CONFLICT" && /主窗口/.test(error.message),
    );
    const unrelated = await rescue.acquire("thread-2", "rescue-window", { surface: "rescue" });
    assert.equal((await main.inspect("thread-2")).token, unrelated.token);
    assert.equal(await main.release(lease), true);
    const takeover = await rescue.acquire("thread-1", "rescue-window", { surface: "rescue" });
    assert.equal(takeover.surface, "rescue");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the same browser receives independent child leases and stale leases are atomically reclaimed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "thread-lease-stale-"));
  let now = 1000;
  try {
    const first = await new ThreadWriteLeaseStore(directory, { ttlMs: 100, now: () => now }).initialize();
    const second = await new ThreadWriteLeaseStore(directory, { ttlMs: 100, now: () => now }).initialize();
    const lease = await first.acquire("thread-1", "browser-1", { surface: "main" });
    now = 1050;
    const child = await second.acquire("thread-1", "browser-1", { surface: "main" });
    assert.notEqual(child.token, lease.token);
    assert.equal(child.expiresAt, 1150);
    assert.equal((await first.inspect("thread-1")).references, 2);
    assert.equal(await second.release(child), true);
    assert.equal((await first.inspect("thread-1")).token, lease.token);
    now = 1200;
    const reclaimed = await second.acquire("thread-1", "browser-2", { surface: "rescue" });
    assert.notEqual(reclaimed.token, lease.token);
    assert.equal(await first.release(lease), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("releasing a same-owner short write cannot release the running turn lease", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "thread-lease-reentrant-"));
  try {
    const store = await new ThreadWriteLeaseStore(directory).initialize();
    const runningTurn = await store.acquire("thread-1", "window-1", { surface: "main" });
    const shortWrite = await store.acquire("thread-1", "window-1", { surface: "main" });

    assert.notEqual(shortWrite.token, runningTurn.token);
    assert.equal(await store.release(shortWrite), true);
    assert.equal((await store.inspect("thread-1")).token, runningTurn.token);
    await assert.rejects(
      () => store.acquire("thread-1", "window-2", { surface: "main" }),
      (error) => error.code === "ERR_THREAD_LEASE_CONFLICT",
    );

    assert.equal(await store.release(runningTurn), true);
    assert.equal(await store.inspect("thread-1"), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
