import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCodexExperimentalBrowserParams,
  codexExperimentalCapabilityPolicySnapshot,
} from "../lib/codex-experimental-policy.mjs";

test("keeps execution environments and dynamic tools server-gated by default", () => {
  const policy = codexExperimentalCapabilityPolicySnapshot();
  assert.equal(policy.executionEnvironments.enabled, false);
  assert.equal(policy.executionEnvironments.defaultEnabled, false);
  assert.equal(policy.executionEnvironments.administratorRequired, true);
  assert.equal(policy.executionEnvironments.credentialSurface, "server-only");
  assert.equal(policy.dynamicTools.enabled, false);
  assert.equal(policy.dynamicTools.defaultEnabled, false);
  assert.equal(policy.dynamicTools.permission, "codexDynamicTools");
  assert.equal(policy.dynamicTools.schemaLimitBytes, 128 * 1024);
  assert.equal(policy.dynamicTools.callTimeoutMs, 30_000);
  assert.equal(policy.dynamicTools.outputLimitBytes, 256 * 1024);
  assert.equal(policy.guardianOverride.browserMode, "read-only");
  assert.equal(policy.guardianOverride.enabled, false);
  assert.equal(policy.guardianOverride.defaultEnabled, false);
  assert.equal(policy.elicitationCounter.reason, "native-app-server-requests-are-in-band");
});

test("rejects browser-supplied experimental execution surfaces", () => {
  assert.doesNotThrow(() => assertCodexExperimentalBrowserParams("thread/start", {
    cwd: "/srv/project",
    model: "gpt-5.6",
  }));
  for (const [method, params, pattern] of [
    ["thread/start", { dynamicTools: [] }, /动态工具默认关闭/],
    ["thread/start", { environments: [] }, /执行环境尚未开放/],
    ["thread/start", { selectedCapabilityRoots: [] }, /能力根目录/],
    ["thread/start", { experimentalRawEvents: false }, /原始实验事件/],
    ["thread/start", { mockExperimentalField: "" }, /测试实验字段/],
    ["turn/start", { environments: [] }, /执行环境尚未开放/],
  ]) {
    assert.throws(() => assertCodexExperimentalBrowserParams(method, params), pattern);
  }
});

test("does not apply thread-only policy to unrelated RPCs", () => {
  assert.doesNotThrow(() => assertCodexExperimentalBrowserParams("thread/read", {
    environments: [{ environmentId: "forged" }],
  }));
});
