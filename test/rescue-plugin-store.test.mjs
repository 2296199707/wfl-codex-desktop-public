import assert from "node:assert/strict";
import test from "node:test";
import { createRescuePluginStore } from "../lib/rescue-plugin-store.mjs";

test("rescue plugin isolation exposes no main-site plugin state", async () => {
  const store = createRescuePluginStore();
  assert.deepEqual(store.snapshot().plugins, []);
  assert.equal(store.snapshot().rescueIsolated, true);
  assert.equal(store.isEnabled("future-plugin"), false);
  assert.equal(store.isAuthorized("future-plugin", { role: "owner" }), false);
  assert.throws(() => store.install("future-plugin"), /不提供插件管理/);
});
