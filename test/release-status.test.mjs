import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseStatusStore } from "../lib/release-status.mjs";

test("release status starts idle and persists bounded public progress", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-status-"));
  const store = new ReleaseStatusStore(directory, { now: () => 1_700_000_000_000 });
  try {
    const idle = await store.read();
    assert.equal(idle.status, "idle");
    assert.equal(idle.phase, "idle");
    assert.equal(idle.version, null);

    const written = await store.write({
      status: "running",
      phase: "testing",
      version: "0.9.0",
      candidateId: "candidate-v0.9.0-aaaaaaaaaaaa-1700000000000",
      commitSha: "a".repeat(40),
      treeHash: "b".repeat(40),
      detail: `Running tests\n${"x".repeat(300)}`,
      startedAt: 1_699_999_999_000,
      error: "secret\nsecond line",
    });
    assert.equal(written.phase, "testing");
    assert.equal(written.commitSha, "a".repeat(40));
    assert.equal(written.treeHash, "b".repeat(40));
    assert.equal(written.detail.includes("\n"), false);
    assert.equal(written.detail.length, 240);
    assert.equal(written.error, "secret second line");
    assert.equal((await fs.stat(path.join(directory, "release-status.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await store.read(), written);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("release status ignores corrupt or unsupported persisted fields", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-status-corrupt-"));
  const store = new ReleaseStatusStore(directory, { now: () => 1_700_000_000_000 });
  try {
    await fs.writeFile(path.join(directory, "release-status.json"), "not-json");
    assert.equal((await store.read()).phase, "idle");
    await fs.writeFile(path.join(directory, "release-status.json"), JSON.stringify({ phase: "private-step", error: 42 }));
    const normalized = await store.read();
    assert.equal(normalized.phase, "idle");
    assert.equal(normalized.error, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
