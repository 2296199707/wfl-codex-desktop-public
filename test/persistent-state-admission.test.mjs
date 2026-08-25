import assert from "node:assert/strict";
import test from "node:test";
import { PersistentStateAdmission } from "../lib/persistent-state-admission.mjs";

test("registers an operation before awaiting the drain read", async () => {
  let resolveRead;
  const admission = new PersistentStateAdmission({
    drainStore: { read: () => new Promise((resolve) => { resolveRead = resolve; }) },
  });
  const pending = admission.begin();
  assert.equal(admission.idle, false);
  assert.deepEqual(admission.snapshot(), { active: 1, orphaned: 0, oldestOrphanedAt: null });
  resolveRead({ active: false });
  const operation = await pending;
  operation.release();
  assert.equal(admission.idle, true);
});

test("rejects and releases a new write after draining begins", async () => {
  const admission = new PersistentStateAdmission({
    drainStore: { read: async () => ({ active: true }) },
  });
  await assert.rejects(admission.begin(), (error) => error.code === "ERR_MAINTENANCE_DRAIN_ACTIVE");
  assert.equal(admission.idle, true);
});

test("a delayed handler can explicitly release its orphan before the grace period", async () => {
  const admission = new PersistentStateAdmission({
    drainStore: { read: async () => ({ active: false }) },
    orphanGraceMs: 50,
    orphanMaxMs: 100,
    orphanRecheckMs: 5,
  });
  const operation = await admission.begin();
  operation.orphan();
  assert.equal(admission.snapshot().orphaned, 1);
  operation.release();
  await delay(60);
  assert.equal(admission.idle, true);
});

test("an orphan whose handler never completes is automatically bounded", async () => {
  let reaped = null;
  const admission = new PersistentStateAdmission({
    drainStore: { read: async () => ({ active: false }) },
    orphanGraceMs: 10,
    orphanMaxMs: 50,
    orphanRecheckMs: 5,
    canReapOrphan: async () => true,
    onOrphanReaped: (value) => { reaped = value; },
  });
  const operation = await admission.begin();
  operation.orphan();
  await waitFor(() => reaped !== null);
  assert.equal(admission.idle, true);
  assert.equal(reaped.forced, false);
  assert.ok(reaped.ageMs >= 10);
});

test("a stuck background task holds an orphan only until the hard limit", async () => {
  let reaped = null;
  const admission = new PersistentStateAdmission({
    drainStore: { read: async () => ({ active: false }) },
    orphanGraceMs: 10,
    orphanMaxMs: 35,
    orphanRecheckMs: 5,
    canReapOrphan: async () => false,
    onOrphanReaped: (value) => { reaped = value; },
  });
  const operation = await admission.begin();
  operation.orphan();
  await waitFor(() => reaped !== null);
  assert.equal(admission.idle, true);
  assert.equal(reaped.forced, true);
  assert.ok(reaped.ageMs >= 35);
});

test("a failing background probe cannot make an orphan permanent", async () => {
  const admission = new PersistentStateAdmission({
    drainStore: { read: async () => ({ active: false }) },
    orphanGraceMs: 10,
    orphanMaxMs: 30,
    orphanRecheckMs: 5,
    canReapOrphan: async () => { throw new Error("probe failed"); },
  });
  const operation = await admission.begin();
  operation.orphan();
  await waitFor(() => admission.idle);
  assert.equal(admission.idle, true);
});

test("owner recovery clears only orphaned admissions after background work is idle", async () => {
  let backgroundIdle = false;
  const admission = new PersistentStateAdmission({
    drainStore: { read: async () => ({ active: false }) },
    orphanGraceMs: 100,
    orphanMaxMs: 200,
    canReapOrphan: async () => backgroundIdle,
  });
  const active = await admission.begin();
  const orphan = await admission.begin();
  orphan.orphan();
  assert.equal(await admission.clearOrphans(), 0);
  backgroundIdle = true;
  assert.equal(await admission.clearOrphans(), 1);
  assert.deepEqual(admission.snapshot(), { active: 1, orphaned: 0, oldestOrphanedAt: null });
  active.release();
  assert.equal(admission.idle, true);
});

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for admission state");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
