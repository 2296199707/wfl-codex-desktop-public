import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateSessionToken } from "../lib/session-token.mjs";

test("session tokens persist across service restarts with private permissions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-token-"));
  try {
    const first = await loadOrCreateSessionToken(directory);
    const second = await loadOrCreateSessionToken(directory);
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await fs.stat(path.join(directory, "session-token"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
