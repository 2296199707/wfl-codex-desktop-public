import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { ReleaseCandidateStore } from "../lib/release-candidate-store.mjs";

test("release candidates bind source identity and preserve terminal history", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-release-candidates-");
  let now = 1_700_000_000_000;
  const store = new ReleaseCandidateStore(directory, { now: () => now });
  const identity = {
    id: `candidate-v0.37.7-${"a".repeat(12)}-${now}`,
    version: "0.37.7",
    commitSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    detail: "准备候选版本",
  };
  try {
    const created = await store.create(identity);
    assert.equal(created.phase, "preparing");
    assert.equal(created.status, "running");
    assert.equal((await store.read()).updatedAt, now);
    await assert.rejects(store.create({ ...identity, id: `${identity.id.slice(0, -1)}1` }), {
      code: "ERR_RELEASE_CANDIDATE_ACTIVE",
    });

    now += 100;
    const awaiting = await store.update(identity.id, {
      phase: "awaiting-approval",
      checks: {
        fullSuite: { status: "passed", command: "npm run check", completedAt: now },
        browser: { status: "passed", command: "npm run test:browser", completedAt: now },
        deployment: { status: "passed", summary: "gateway and Codex ready", completedAt: now },
      },
    }, { expectedPhases: ["preparing"] });
    assert.equal(awaiting.status, "awaiting-approval");
    assert.equal((await store.read()).updatedAt, now);
    await assert.rejects(store.update(identity.id, { phase: "stable" }, { expectedPhases: ["testing"] }), {
      code: "ERR_RELEASE_CANDIDATE_STALE",
    });

    now += 100;
    const discarded = await store.discard(identity.id, { reason: "实际验证未通过", discardedBy: "owner" });
    assert.equal(discarded.phase, "discarded");
    assert.equal(discarded.discardedBy, "owner");
    assert.equal((await store.read()).updatedAt, now);

    const rollbackBound = await store.update(identity.id, {
      phase: "discarding",
      rollbackUnit: "wfl-codex-rollback-v0-37-6-1700000000000-abcd1234",
      rollbackTargetVersion: "0.37.6",
    });
    assert.equal(rollbackBound.rollbackTargetVersion, "0.37.6");
    assert.equal(rollbackBound.rollbackUnit, "wfl-codex-rollback-v0-37-6-1700000000000-abcd1234");
    await store.update(identity.id, { phase: "discarded" }, { expectedPhases: ["discarding"] });

    now += 100;
    const next = await store.create({
      ...identity,
      id: `candidate-v0.37.7-${"c".repeat(12)}-${now}`,
      commitSha: "c".repeat(40),
      treeHash: "d".repeat(40),
    });
    const snapshot = await store.read();
    assert.equal(snapshot.currentId, next.id);
    assert.equal(snapshot.updatedAt, now);
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.id), [next.id, identity.id]);
    assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid release candidate identity is rejected", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-release-candidates-invalid-");
  try {
    const store = new ReleaseCandidateStore(directory);
    await assert.rejects(store.create({
      id: "candidate-vnext",
      version: "next",
      commitSha: "not-a-commit",
      treeHash: "not-a-tree",
    }), /identity is invalid/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("concurrent candidate updates are serialized without losing fields", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-release-candidates-concurrent-");
  const firstStore = new ReleaseCandidateStore(directory);
  const secondStore = new ReleaseCandidateStore(directory);
  const identity = {
    id: `candidate-v0.37.7-${"e".repeat(12)}-${Date.now()}`,
    version: "0.37.7",
    commitSha: "e".repeat(40),
    treeHash: "f".repeat(40),
  };
  try {
    await firstStore.create(identity);
    await Promise.all([
      firstStore.update(identity.id, { previousVersion: "0.37.6" }),
      secondStore.update(identity.id, { rollbackTargetVersion: "0.37.6" }),
    ]);
    const candidate = await firstStore.current();
    assert.equal(candidate.previousVersion, "0.37.6");
    assert.equal(candidate.rollbackTargetVersion, "0.37.6");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
