import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OpsRollbackStore } from "../lib/ops-rollback-store.mjs";

const actorId = "u-0123456789abcdef";

test("rollback guard is default-off, expires, and consumes one confirmation attempt", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rollback-guard-");
  let now = 1_000;
  try {
    const store = await new OpsRollbackStore(directory, { now: () => now, ttlMs: 60_000 }).initialize();
    assert.deepEqual(store.status(actorId), { enabled: false, expiresAt: null, prepared: false, targetVersion: null });
    await assert.rejects(store.prepare(actorId, "0.20.0", "0.20.0"), /未开启/);
    await store.enable(actorId);
    await assert.rejects(store.prepare(actorId, "0.20.0", "v0.20.0"), /完整输入/);
    const prepared = await store.prepare(actorId, "0.20.0", "0.20.0");
    assert.match(prepared.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(store.status(actorId).prepared, true);
    await assert.rejects(store.consume(actorId, "0.19.0", prepared.nonce), /已失效/);
    assert.equal(store.status(actorId).enabled, false);
    await assert.rejects(store.consume(actorId, "0.20.0", prepared.nonce), /未开启/);

    await store.enable(actorId);
    now += 60_001;
    assert.equal(store.status(actorId).enabled, false);
    const text = await fs.readFile(path.join(directory, "ops-rollback-guard.json"), "utf8");
    assert.doesNotMatch(text, new RegExp(prepared.nonce));
    assert.equal((await fs.stat(path.join(directory, "ops-rollback-guard.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("valid rollback confirmation succeeds exactly once", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rollback-once-");
  try {
    const store = await new OpsRollbackStore(directory).initialize();
    await store.enable(actorId);
    const prepared = await store.prepare(actorId, "0.20.0", "0.20.0");
    assert.deepEqual(await store.consume(actorId, "0.20.0", prepared.nonce), { targetVersion: "0.20.0" });
    await assert.rejects(store.consume(actorId, "0.20.0", prepared.nonce), /未开启/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
