import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { RollbackStatusStore } from "../lib/rollback-status.mjs";

test("rollback status keeps the release candidate binding across writes and reads", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rollback-status-");
  try {
    const store = new RollbackStatusStore(directory, { now: () => 1_700_000_000_000 });
    await store.write({
      phase: "queued",
      targetVersion: "0.37.6",
      candidateId: `candidate-v0.37.7-${"a".repeat(12)}-1700000000000`,
    });
    await store.write({ phase: "verifying", detail: "候选回滚中" });
    const status = await store.read();
    assert.equal(status.candidateId, "candidate-v0.37.7-aaaaaaaaaaaa-1700000000000");
    assert.equal(status.targetVersion, "0.37.6");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
