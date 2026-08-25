import assert from "node:assert/strict";
import test from "node:test";
import { parseLauncherResult } from "../lib/launcher-result.mjs";

test("parses a structured launcher result after the systemd unit banner", () => {
  assert.deepEqual(
    parseLauncherResult('Running as unit: example.service\n{"ok":true,"status":"queued"}\n'),
    { ok: true, status: "queued" },
  );
});

test("rejects missing or invalid structured launcher output", () => {
  assert.throws(() => parseLauncherResult("Running as unit: example.service\n"), /Missing launcher result/);
  assert.throws(() => parseLauncherResult("banner\n{invalid}\n"), SyntaxError);
});
