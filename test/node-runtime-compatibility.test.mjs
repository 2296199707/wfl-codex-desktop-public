import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNodeEngineCompatible,
  nodeVersionSatisfiesMinimum,
  parseMinimumNodeEngine,
  parseNodeVersion,
} from "../lib/node-runtime-compatibility.mjs";

test("Node runtime compatibility accepts the release's explicit minimum", () => {
  assert.deepEqual(parseMinimumNodeEngine(">=22"), [22, 0, 0]);
  assert.deepEqual(parseMinimumNodeEngine(">=22.3.1"), [22, 3, 1]);
  assert.deepEqual(parseNodeVersion("v22.23.1"), [22, 23, 1]);
  assert.equal(nodeVersionSatisfiesMinimum([22, 0, 0], [22, 0, 0]), true);
  assert.equal(nodeVersionSatisfiesMinimum([23, 0, 0], [22, 99, 99]), true);
  assert.equal(nodeVersionSatisfiesMinimum([21, 99, 99], [22, 0, 0]), false);
  assert.equal(
    assertNodeEngineCompatible(">=22", { currentVersion: "22.0.0" }).required,
    ">=22",
  );
});

test("Node runtime compatibility rejects an old server without mutating it", () => {
  assert.throws(
    () => assertNodeEngineCompatible(">=22", { currentVersion: "20.19.4" }),
    (error) => error.code === "ERR_NODE_RUNTIME_TOO_OLD"
      && /旧主站保持运行/.test(error.message),
  );
});

test("Node runtime compatibility rejects ambiguous engine declarations", () => {
  for (const required of [null, "", "^22", ">=20 || >=22", "22.x"]) {
    assert.throws(
      () => parseMinimumNodeEngine(required),
      (error) => error.code === "ERR_NODE_ENGINE_INVALID",
    );
  }
});
