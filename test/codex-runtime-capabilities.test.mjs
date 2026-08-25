import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  codexVersionAtLeast,
  codexRuntimeCapabilities,
  codexRuntimeFeatureMethods,
  codexRuntimeSupports,
} from "../lib/codex-runtime-capabilities.mjs";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

test("Codex 0.146 keeps core chat while disabling 0.147-only runtime features", async () => {
  const client = await readClientMethods("0.146.0");
  const capabilities = codexRuntimeCapabilities({
    version: "codex-cli 0.146.0",
    clientRequests: client.methods,
  });
  assert.deepEqual(capabilities, {
    version: "0.146.0",
    detected: true,
    conversationSections: false,
    sectionPositionSort: false,
    pluginSearch: false,
    cursorMigration: true,
  });
  assert.equal(codexRuntimeSupports(capabilities, "conversationSections"), false);
});

test("Codex 0.149 enables only features backed by its detected protocol methods", async () => {
  const client = await readClientMethods("0.149.0");
  const capabilities = codexRuntimeCapabilities({
    version: "0.149.0",
    clientRequests: client.methods,
  });
  assert.equal(capabilities.conversationSections, true);
  assert.equal(capabilities.sectionPositionSort, true);
  assert.equal(capabilities.pluginSearch, true);
  assert.equal(capabilities.cursorMigration, true);
});

test("unknown or incomplete future protocol surfaces fail closed for optional features", async () => {
  const methods = codexRuntimeFeatureMethods();
  const incomplete = codexRuntimeCapabilities({
    version: "codex-cli 0.999.0",
    clientRequests: [
      ...methods.conversationSections.slice(1),
      ...methods.cursorMigration,
    ],
  });
  assert.equal(incomplete.conversationSections, false);
  assert.equal(incomplete.pluginSearch, false);
  assert.equal(incomplete.cursorMigration, true);
  assert.equal(codexRuntimeCapabilities({ version: "0.999.0" }).detected, false);
});

test("Codex version range checks allow newer runtimes without accepting unsupported older baselines", () => {
  assert.equal(codexVersionAtLeast("codex-cli 0.150.0", "0.149.0"), true);
  assert.equal(codexVersionAtLeast("codex-cli 0.149.0", "codex-cli 0.149.0"), true);
  assert.equal(codexVersionAtLeast("codex-cli 0.146.0", "0.149.0"), false);
  assert.equal(codexVersionAtLeast("not-codex", "0.149.0"), false);
});

async function readClientMethods(version) {
  return JSON.parse(await fs.readFile(
    new URL(`codex-app-server-${version}-client-methods.json`, fixtureRoot),
    "utf8",
  ));
}
