import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const doctor = await fs.readFile(new URL("../scripts/server-doctor.mjs", import.meta.url), "utf8");

test("server doctor reports the durable deployment recovery circuit breaker", () => {
  assert.match(doctor, /Deployment recovery circuit breaker/);
  assert.match(doctor, /deployment-recovery-failure\.json/);
  assert.match(doctor, /failure\?\.status !== "failed"/);
  assert.match(doctor, /\["codex", "topology"\]\.includes/);
});
