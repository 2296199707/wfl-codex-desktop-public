import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createAuthRecord,
  generatePassword,
  loadAuth,
  verifyAuthCredentials,
  verifyBasicAuth,
  writeAuth,
} from "../lib/auth.mjs";

test("creates and verifies a password record without storing the password", () => {
  const record = createAuthRecord("codex", "correct-horse-battery-staple");
  assert.equal(Object.hasOwn(record, "password"), false);
  const valid = `Basic ${Buffer.from("codex:correct-horse-battery-staple").toString("base64")}`;
  const invalid = `Basic ${Buffer.from("codex:wrong-password-value").toString("base64")}`;
  assert.equal(verifyBasicAuth(valid, record), true);
  assert.equal(verifyBasicAuth(invalid, record), false);
  assert.equal(verifyAuthCredentials("codex", "correct-horse-battery-staple", record), true);
  assert.equal(verifyAuthCredentials("codex", "wrong-password-value", record), false);
});

test("writes authentication records with private file permissions", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-codex-auth-test-");
  const file = path.join(directory, "auth.json");
  try {
    const record = createAuthRecord("codex", generatePassword());
    await writeAuth(file, record);
    assert.deepEqual(await loadAuth(file), record);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
