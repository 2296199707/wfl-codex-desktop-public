import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

function harness(fetchImpl) {
  const state = {
    account: { id: "owner" }, runtime: "codex", activeProviderId: "provider-a",
    editingProviderId: "provider-a", providers: [{ id: "provider-a", name: "Provider A" }],
    providerModelCatalogs: {}, providerModelQueries: {}, providerModelCatalogStatus: {},
    models: [{ model: "existing-model", isDefault: true }], selectedModel: "existing-model",
  };
  const elements = Object.fromEntries([
    "intelligenceModelRefresh", "intelligenceModelsRefreshButton", "intelligenceModelsStatus",
    "intelligenceEffortView", "intelligenceModelView", "codexWorkspaceView",
    "claudePermissionView", "claudeWorkspaceView", "claudeExecutionView", "collaborationSettingsView",
    "providerModelsRefreshButton", "providerFormError", "imageApiProviderInput",
  ].map((name) => [name, { textContent: "", value: "", hidden: false, disabled: false }]));
  const renders = { providers: [], images: 0, models: [] };
  const context = vm.createContext({
    state, elements, Date, console,
    fetchWithTimeout: fetchImpl,
    readApiJson: async (response) => {
      if (response.error) throw new Error(response.error);
      return response;
    },
    renderProviderModelOptions: (id) => renders.providers.push(id),
    renderImageModelOptions: () => { renders.images += 1; },
    populateModelSelects: () => renders.models.push(state.models.map((model) => model.model)),
    requestAnimationFrame: () => {},
    toast: () => {},
  });
  for (const name of [
    "currentProviderModelCatalogId", "mergeDiscoveredProviderModels", "fetchProviderModelCatalog",
    "renderProviderModelRefresh", "resetProviderModelCatalogs", "queryProviderModels",
    "showIntelligenceModelView",
  ]) {
    const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0];
    assert.ok(declaration, `missing ${name}`);
    vm.runInContext(declaration, context);
  }
  return { state, elements, renders, context };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("opening the model picker re-queries the provider and discovers new models without changing selection", async () => {
  const requests = [];
  const { state, context, renders, elements } = harness(async (url, options) => {
    requests.push({ url, options });
    return { models: requests.length === 1 ? ["existing-model"] : ["existing-model", "gpt-6.1-sol"] };
  });
  context.showIntelligenceModelView();
  await state.providerModelQueries["provider-a"].promise;
  context.showIntelligenceModelView();
  await state.providerModelQueries["provider-a"].promise;
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url, options }) => url === "/api/providers/provider-a/models"
    && options.method === "POST" && options.cache === "no-store"));
  assert.ok(renders.models.at(-1).includes("gpt-6.1-sol"));
  assert.equal(state.selectedModel, "existing-model");
  assert.match(elements.intelligenceModelsStatus.textContent, /2 个模型.*已刷新/);
  state.runtime = "claude";
  context.showIntelligenceModelView();
  context.renderProviderModelRefresh();
  assert.equal(requests.length, 2);
  assert.equal(elements.intelligenceModelRefresh.hidden, true);
});

test("concurrent queries share a request and an old supplier reply cannot overwrite the current editor", async () => {
  const waiting = deferred();
  let calls = 0;
  const { state, context, renders, elements } = harness(() => { calls += 1; return waiting.promise; });
  const first = context.fetchProviderModelCatalog("provider-a");
  const second = context.fetchProviderModelCatalog("provider-a");
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(elements.intelligenceModelsRefreshButton.disabled, true);
  state.activeProviderId = "provider-b";
  state.editingProviderId = "provider-b";
  elements.imageApiProviderInput.value = "provider-b";
  waiting.resolve({ models: ["a-only-model"] });
  await first;
  assert.equal(renders.providers.length, 0);
  assert.equal(renders.models.length, 0);
  assert.equal(renders.images, 0);
  assert.deepEqual(state.providerModelCatalogs["provider-a"], ["a-only-model"]);
  assert.equal(elements.intelligenceModelsRefreshButton.disabled, false);
});

test("failed refresh keeps the prior catalog, reports failure, and can be retried while preserving an unlisted selection", async () => {
  let fail = false;
  const { state, context, elements } = harness(async () => fail
    ? { error: "供应商模型查询超时" }
    : { models: ["gpt-6.1-sol"] });
  await context.queryProviderModels("provider-a", "models", { announce: false });
  state.selectedModel = "gpt-6.1-sol";
  fail = true;
  await context.queryProviderModels("provider-a", "models", { announce: false });
  assert.deepEqual(state.providerModelCatalogs["provider-a"], ["gpt-6.1-sol"]);
  assert.match(elements.intelligenceModelsStatus.textContent, /刷新失败.*保留上次目录/);
  assert.equal(elements.intelligenceModelsRefreshButton.disabled, false);
  fail = false;
  await context.queryProviderModels("provider-a", "models", { announce: false });
  assert.doesNotMatch(elements.intelligenceModelsStatus.textContent, /刷新失败/);
  context.fetchWithTimeout = async () => ({ models: ["new-model"] });
  await context.queryProviderModels("provider-a", "models", { announce: false });
  assert.equal(state.selectedModel, "gpt-6.1-sol");
  assert.ok(state.models.some((model) => model.model === "gpt-6.1-sol"));
  assert.deepEqual(state.providerModelCatalogs["provider-a"], ["new-model"]);
});

test("configuration invalidation and account changes discard older responses", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const { state, context } = harness(() => (++calls === 1 ? first.promise : second.promise));
  const old = context.fetchProviderModelCatalog("provider-a");
  delete state.providerModelQueries["provider-a"];
  const fresh = context.fetchProviderModelCatalog("provider-a");
  second.resolve({ models: ["new-configuration-model"] });
  await fresh;
  first.resolve({ models: ["old-configuration-model"] });
  assert.equal(await old, null);
  assert.deepEqual(state.providerModelCatalogs["provider-a"], ["new-configuration-model"]);
  const waiting = deferred();
  context.fetchWithTimeout = () => waiting.promise;
  const previousAccount = context.fetchProviderModelCatalog("provider-a");
  state.account = { id: "another-user" };
  context.resetProviderModelCatalogs();
  waiting.resolve({ models: ["previous-user-model"] });
  assert.equal(await previousAccount, null);
  assert.equal(Object.keys(state.providerModelCatalogs).length, 0);
  assert.equal(state.models.some((model) => model.providerCatalog), false);
});
