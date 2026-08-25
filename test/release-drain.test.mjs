import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";

async function withStore(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-drain-"));
  let now = 1_700_000_000_000;
  const store = new ReleaseDrainStore(directory, { now: () => now });
  try {
    await operation({ store, advance: (milliseconds) => (now += milliseconds) });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("an active release drain lease cannot be overwritten", async () => {
  await withStore(async ({ store }) => {
    const attempts = await Promise.allSettled([
      store.begin("1.2.3", { ttlMs: 1_000 }),
      store.begin("1.2.4", { ttlMs: 1_000 }),
    ]);
    const [winner] = attempts.filter((result) => result.status === "fulfilled");
    const [conflict] = attempts.filter((result) => result.status === "rejected");
    assert.ok(winner);
    assert.equal(conflict?.reason?.code, "ERR_RELEASE_DRAIN_ACTIVE");
    await assert.rejects(
      store.begin("1.2.5", { ttlMs: 1_000 }),
      (error) => error.code === "ERR_RELEASE_DRAIN_ACTIVE",
    );
    assert.deepEqual(await store.read(), {
      active: true,
      version: winner.value.version,
      startedAt: winner.value.startedAt,
      expiresAt: winner.value.expiresAt,
    });
  });
});

test("only the owner can renew an active release drain lease", async () => {
  await withStore(async ({ store, advance }) => {
    const lease = await store.begin("1.2.3", { ttlMs: 1_000 });
    advance(400);
    assert.equal(await store.renew("not-the-owner", { ttlMs: 2_000 }), false);
    const renewed = await store.renew(lease.token, { ttlMs: 2_000 });
    assert.equal(renewed.token, lease.token);
    assert.equal(renewed.startedAt, lease.startedAt);
    assert.equal(renewed.expiresAt, lease.startedAt + 2_400);
    assert.equal((await store.read()).expiresAt, renewed.expiresAt);
  });
});

test("an expired lease cannot be renewed and can be acquired by a new owner", async () => {
  await withStore(async ({ store, advance }) => {
    const expired = await store.begin("1.2.3", { ttlMs: 1_000 });
    advance(1_001);
    assert.equal(await store.renew(expired.token, { ttlMs: 1_000 }), false);
    const replacement = await store.begin("1.2.4", { ttlMs: 1_000 });
    assert.notEqual(replacement.token, expired.token);
    assert.equal((await store.read()).version, "1.2.4");
  });
});

test("rejects leases beyond one minute and permanently ignores legacy drains that could mute conversations for minutes", async () => {
  await withStore(async ({ store, advance }) => {
    await assert.rejects(
      store.begin("1.2.3", { ttlMs: 60_001 }),
      (error) => error instanceof RangeError,
    );
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(store.filePath, `${JSON.stringify({
      token: "legacy-long-drain",
      version: "1.2.2",
      startedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 35 * 60 * 1000,
    })}\n`, { mode: 0o600 });

    assert.equal((await store.read()).active, false);
    advance(35 * 60 * 1000 - 60_000);
    assert.equal((await store.read()).active, false);
    const replacement = await store.begin("1.2.3");
    assert.equal(replacement.version, "1.2.3");
  });
});

test("renewal cannot move a lease beyond its absolute sixty-second deadline", async () => {
  await withStore(async ({ store, advance }) => {
    const lease = await store.begin("1.2.3", { ttlMs: 20_000 });
    advance(15_000);
    const renewed = await store.renew(lease.token, { ttlMs: 45_000 });
    assert.equal(renewed.expiresAt, lease.startedAt + 60_000);
    advance(45_001);
    assert.equal((await store.read()).active, false);
    assert.equal(await store.renew(lease.token, { ttlMs: 1_000 }), false);
  });
});

test("a shorter parent renewal cannot reduce a lease already fenced through the hard deadline", async () => {
  await withStore(async ({ store, advance }) => {
    const lease = await store.begin("1.2.3", { ttlMs: 20_000 });
    advance(5_000);
    const committed = await store.renew(lease.token, { ttlMs: 55_000 });
    assert.equal(committed.expiresAt, lease.startedAt + 60_000);

    advance(1_000);
    const parentRenewal = await store.renew(lease.token, { ttlMs: 20_000 });
    assert.equal(parentRenewal.expiresAt, committed.expiresAt);
    assert.equal((await store.read()).expiresAt, committed.expiresAt);
  });
});

test("a fresh malformed drain fails closed briefly but cannot mute task admission forever", async () => {
  await withStore(async ({ store, advance }) => {
    const malformedAt = 1_700_000_000_000;
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(store.filePath, "{", { mode: 0o600 });
    await fs.utimes(store.filePath, new Date(malformedAt), new Date(malformedAt));

    assert.deepEqual(await store.read(), {
      active: true,
      version: null,
      startedAt: malformedAt,
      expiresAt: malformedAt + 60_000,
    });
    await assert.rejects(
      store.begin("1.2.3"),
      (error) => error.code === "ERR_RELEASE_DRAIN_ACTIVE",
    );

    advance(60_001);
    assert.equal((await store.read()).active, false);
    const replacement = await store.begin("1.2.3", { ttlMs: 1_000 });
    assert.equal(replacement.version, "1.2.3");
  });
});

test("clear only removes the lease owned by the supplied token", async () => {
  await withStore(async ({ store }) => {
    const lease = await store.begin("1.2.3", { ttlMs: 1_000 });
    assert.equal(await store.clear("not-the-owner"), false);
    assert.equal((await store.read()).active, true);
    assert.equal(await store.clear(lease.token), true);
    assert.equal(await store.clear(lease.token), false);
    assert.deepEqual(await store.read(), {
      active: false,
      version: null,
      startedAt: null,
      expiresAt: null,
    });
  });
});

test("a mutation lock left by a dead process is reclaimed", async () => {
  await withStore(async ({ store }) => {
    await fs.mkdir(path.dirname(store.mutationLockPath), { recursive: true });
    await fs.writeFile(store.mutationLockPath, `${JSON.stringify({
      schemaVersion: 1,
      token: "abandoned-lock",
      pid: 999_999_999,
      startTicks: "1",
      createdAt: Date.now() - 60_000,
    })}\n`, { mode: 0o600 });

    const lease = await store.begin("1.2.3", { ttlMs: 1_000 });
    assert.equal(lease.version, "1.2.3");
    await assert.rejects(fs.access(store.mutationLockPath), { code: "ENOENT" });
  });
});

test("an old incomplete mutation lock and recovery claim cannot block drain forever", async () => {
  await withStore(async ({ store }) => {
    await fs.mkdir(path.dirname(store.mutationLockPath), { recursive: true });
    await fs.writeFile(store.mutationLockPath, "{", { mode: 0o600 });
    await fs.writeFile(store.mutationRecoveryPath, "stale", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await Promise.all([
      fs.utimes(store.mutationLockPath, old, old),
      fs.utimes(store.mutationRecoveryPath, old, old),
    ]);

    const lease = await store.begin("1.2.3", { ttlMs: 1_000 });
    assert.equal(lease.version, "1.2.3");
    await assert.rejects(fs.access(store.mutationLockPath), { code: "ENOENT" });
    await assert.rejects(fs.access(store.mutationRecoveryPath), { code: "ENOENT" });
  });
});

test("future-dated mutation artifacts cannot block drain forever", async () => {
  await withStore(async ({ store }) => {
    await fs.mkdir(path.dirname(store.mutationLockPath), { recursive: true });
    await fs.writeFile(store.mutationLockPath, "{", { mode: 0o600 });
    await fs.writeFile(store.mutationRecoveryPath, "future", { mode: 0o600 });
    const future = new Date(Date.now() + 60_000);
    await Promise.all([
      fs.utimes(store.mutationLockPath, future, future),
      fs.utimes(store.mutationRecoveryPath, future, future),
    ]);

    const lease = await store.begin("1.2.3", { ttlMs: 1_000 });
    assert.equal(lease.version, "1.2.3");
    await assert.rejects(fs.access(store.mutationLockPath), { code: "ENOENT" });
    await assert.rejects(fs.access(store.mutationRecoveryPath), { code: "ENOENT" });
  });
});

test("an orphaned recovery claim without a lock is also reclaimed", async () => {
  await withStore(async ({ store }) => {
    await fs.mkdir(path.dirname(store.mutationRecoveryPath), { recursive: true });
    await fs.writeFile(store.mutationRecoveryPath, "stale", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(store.mutationRecoveryPath, old, old);

    const lease = await store.begin("1.2.3", { ttlMs: 1_000 });
    assert.equal(lease.version, "1.2.3");
    await assert.rejects(fs.access(store.mutationRecoveryPath), { code: "ENOENT" });
  });
});

test("stale recovery cleanup does not remove a replacement claim", async () => {
  await withStore(async ({ store }) => {
    await fs.mkdir(path.dirname(store.mutationRecoveryPath), { recursive: true });
    await fs.writeFile(store.mutationRecoveryPath, "stale", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(store.mutationRecoveryPath, old, old);

    const displacedPath = `${store.mutationRecoveryPath}.displaced`;
    const originalLstat = fs.lstat;
    let replaced = false;
    fs.lstat = async (filePath, ...args) => {
      const stat = await originalLstat(filePath, ...args);
      if (filePath === store.mutationRecoveryPath && !replaced) {
        replaced = true;
        await fs.rename(store.mutationRecoveryPath, displacedPath);
        await fs.writeFile(store.mutationRecoveryPath, "replacement", { mode: 0o600 });
      }
      return stat;
    };

    try {
      assert.equal(await store.recoveryClaimBlocksAcquisition(), true);
      assert.equal(await fs.readFile(store.mutationRecoveryPath, "utf8"), "replacement");
    } finally {
      fs.lstat = originalLstat;
    }
  });
});
