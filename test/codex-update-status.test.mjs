import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexUpdateStatusStore,
  codexUpdateIsActive,
} from "../lib/codex-update-status.mjs";

test("Codex update status persists only bounded version and phase metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-update-status-"));
  const now = 1_700_000_000_000;
  const store = new CodexUpdateStatusStore(directory, { now: () => now });
  try {
    assert.equal((await store.read()).phase, "idle");
    const written = await store.write({
      status: "running",
      phase: "draining",
      beforeVersion: "codex-cli 0.144.6",
      detail: `Official update\n${"x".repeat(300)}`,
      startedAt: now - 1000,
      error: "private\nline",
    });
    assert.equal(written.detail.length, 240);
    assert.equal(written.detail.includes("\n"), false);
    assert.equal(written.error, "private line");
    assert.equal(codexUpdateIsActive(written, now), true);
    assert.equal(codexUpdateIsActive(written, now + 34 * 60 * 1000), true);
    assert.equal(codexUpdateIsActive(written, now + 36 * 60 * 1000), false);
    assert.equal((await fs.stat(path.join(directory, "codex-update-status.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Codex update status ignores corrupt state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-update-status-corrupt-"));
  const store = new CodexUpdateStatusStore(directory);
  try {
    await fs.writeFile(path.join(directory, "codex-update-status.json"), "not-json");
    assert.equal((await store.read()).status, "idle");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a recovered Codex update is a terminal outcome", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-update-recovered-"));
  const now = 1_700_000_000_000;
  const store = new CodexUpdateStatusStore(directory, { now: () => now });
  try {
    const recovered = await store.write({
      status: "recovered",
      phase: "recovered",
      beforeVersion: "codex-cli 0.146.0",
      recoveredVersion: "codex-cli 0.146.0",
      startedAt: now - 10_000,
      completedAt: now,
    });
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.recoveredVersion, "codex-cli 0.146.0");
    assert.equal(codexUpdateIsActive(recovered, now), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
