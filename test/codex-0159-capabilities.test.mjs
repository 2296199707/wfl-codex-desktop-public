import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { codexRuntimeSupports } from "../lib/codex-runtime-capabilities.mjs";
import { normalizeCodexReasoningEffort } from "../lib/codex-policy.mjs";
import { normalizeThreadItemPage, mergeLoadedItemPage } from "../public/thread-state.js";

const [server, app] = await Promise.all([
  fs.readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
]);

function implementation(source, name, globals = {}) {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0];
  assert.ok(declaration, `missing ${name}`);
  return vm.runInNewContext(`(${declaration})`, globals);
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const capabilities = { detected: true, itemAnchors: true, mcpServerFilter: true, mcpResourceTarget: true };
const protocolGlobals = {
  httpError,
  codexRuntimeSupports,
  CODEX_RUNTIME_CAPABILITIES: capabilities,
  codexRuntimeFeatureUnavailable: () => Object.assign(new Error("unavailable"), { code: "ERR_CODEX_RUNTIME_FEATURE_UNAVAILABLE" }),
};
const identifier = implementation(server, "normalizeCodexLifecycleThreadId", { httpError });
const dimension = implementation(server, "normalizeTerminalDimension", { httpError });
const string = implementation(server, "boundedCodexMcpRpcString", { httpError });
const normalizeMcpThread = implementation(server, "normalizeOptionalCodexMcpThreadId", {
  ...protocolGlobals, boundedCodexMcpRpcString: string, isImportedThreadId: (value) => value.startsWith("import-"),
});

test("item anchors require a visible turn, preserve opaque paging, and respect runtime detection", () => {
  const normalize = implementation(server, "normalizeCodexThreadItemsListParams", {
    ...protocolGlobals,
    normalizeCodexLifecycleThreadId: identifier,
    normalizeTerminalDimension: dimension,
    normalizeCodexSearchCursor: (value) => value ?? null,
    CODEX_THREAD_ITEMS_PAGE_MAX: 100,
  });
  const anchor = normalize({ threadId: "thread", turnId: "turn", cursor: { type: "item", itemId: "item" } });
  assert.deepEqual(plain(anchor.cursor), { type: "item", itemId: "item" });
  assert.equal(normalize({ threadId: "thread", cursor: "opaque-next" }).cursor, "opaque-next");
  assert.throws(() => normalize({ threadId: "thread", cursor: anchor.cursor }), /轮次/);
  capabilities.itemAnchors = false;
  try {
    assert.throws(() => normalize({ threadId: "thread", turnId: "turn", cursor: anchor.cursor }), { code: "ERR_CODEX_RUNTIME_FEATURE_UNAVAILABLE" });
    assert.equal(normalize({ threadId: "thread", cursor: "old-next" }).cursor, "old-next");
  } finally {
    capabilities.itemAnchors = true;
  }
});

test("item page results retain native timings while filtering other turns", () => {
  const sanitize = implementation(server, "sanitizeCodexThreadItemsListResult", {
    httpError, Buffer, CODEX_THREAD_ITEMS_RESULT_BYTES_MAX: 1024 * 1024,
    normalizeCodexResponseCursor: (value) => value ?? null,
  });
  const result = sanitize({ data: [
    { turnId: "turn", item: { id: "item", type: "commandExecution" }, startedAtMs: 100, completedAtMs: 200 },
    { turnId: "other", item: { id: "other" } },
  ] }, { limit: 10, turnId: "turn" });
  assert.deepEqual(plain(result.data), [
    { turnId: "turn", item: { id: "item", type: "commandExecution" }, startedAtMs: 100, completedAtMs: 200 },
  ]);
  const merged = mergeLoadedItemPage([], normalizeThreadItemPage(result.data));
  assert.equal(merged[0].startedAtMs, 100);
  assert.equal(merged[0].completedAtMs, 200);
});

test("MCP single-server status and explicit resource targets retain the thread connection", () => {
  const globals = {
    ...protocolGlobals, CODEX_MCP_LIST_LIMIT: 100, boundedCodexMcpRpcString: string,
    normalizeOptionalCodexMcpThreadId: normalizeMcpThread,
    normalizeCodexMcpServerName: (name) => string(name, 256, "MCP server"),
  };
  const status = implementation(server, "normalizeCodexMcpStatusParams", globals);
  assert.deepEqual(plain(status({ serverName: "lookup", threadId: "thread" })), {
    serverName: "lookup", threadId: "thread", limit: 50,
  });
  const resource = implementation(server, "normalizeCodexMcpResourceReadParams", globals);
  assert.deepEqual(plain(resource({ server: "lookup", uri: "ui://widget", threadId: "thread",
    target: { connectorId: "connector", linkId: null } })), {
    server: "lookup", uri: "ui://widget", threadId: "thread", target: { connectorId: "connector", linkId: null },
  });
  assert.throws(() => resource({ server: "lookup", uri: "ui://widget", target: { connectorId: "connector" } }), /目标无效/);
  assert.throws(() => status({ serverName: "lookup", threadId: "import-snapshot" }), /迁移快照/);
});

test("collaboration settings save numeric efforts without a removed WFL strategy dependency", async () => {
  const writes = [];
  const elements = {
    collaborationSettingsSaveButton: { disabled: false }, collaborationSettingsError: { textContent: "" },
    collaborationSubagentEnabledInput: { checked: true }, collaborationSubagentEffortInput: { value: "42" },
    collaborationSubagentModelInput: { value: "" }, collaborationThreadsInput: { value: "4" },
    collaborationDepthInput: { value: "3" }, collaborationPresetInput: { value: "" },
  };
  const state = { runtime: "codex", models: [], codexPolicy: { collaborationModes: [] }, config: {} };
  const save = implementation(app, "saveCollaborationSettings", {
    state, elements, COLLABORATION_THREAD_LIMITS: new Set([4]), COLLABORATION_DEPTH_LIMITS: new Set([3]),
    validCodexReasoningEffort: implementation(app, "validCodexReasoningEffort"),
    rpc: async (method, params) => { writes.push({ method, ...params }); },
    sessionStorage: { removeItem() {} }, renderCollaborationSettings() {}, renderIntelligenceControl() {},
    showIntelligenceEffortView() {}, toast() {},
  });
  await save();
  assert.equal(elements.collaborationSettingsError.textContent, "");
  assert.equal(elements.collaborationSettingsSaveButton.disabled, false);
  assert.equal(writes.find((entry) => entry.keyPath === "agents.default_subagent_reasoning_effort")?.value, "42");
  assert.equal(writes.length, 5);
  const validate = implementation(server, "validateWritableConfigValue", { normalizeCodexReasoningEffort });
  assert.doesNotThrow(() => validate("agents.default_subagent_reasoning_effort", "42"));
});

test("browser history continues from its oldest native item without changing active turn state", async () => {
  for (const [itemAnchors, imported, expected] of [
    [true, false, { type: "item", itemId: "b" }], [false, false, "opaque"], [true, true, "opaque"],
  ]) {
    const turn = { id: "turn", status: "inProgress", items: [{ id: "b", type: "agentMessage", text: "live" }], itemsView: "summary" };
    const state = { activeThread: { id: "thread", imported, turns: [turn] }, threadItemPages: new Map([
      ["thread:turn", { nextCursor: "opaque", oldestItemId: "b" }],
    ]), threadItemHydrationGeneration: 1, activeTurnId: "turn" };
    const requests = [];
    const load = implementation(app, "loadTurnItemsPage", {
      state, elements: { messageStage: { scrollHeight: 100, scrollTop: 0 } }, THREAD_ITEMS_PAGE_LIMIT: 50,
      threadItemPageKey: (threadId, turnId) => `${threadId}:${turnId}`,
      codexRuntimeFeatureAvailable: () => itemAnchors, normalizeThreadItemPage, mergeLoadedItemPage,
      turnStatusType: (value) => value.status, updateConversationLoadProgress() {},
      rpc: async (method, params) => {
        requests.push(params);
        return { data: [{ turnId: "turn", item: { id: "a", type: "userMessage", content: [] } }], nextCursor: null };
      },
    });
    assert.equal(await load("thread", "turn", { render: false }), true);
    assert.deepEqual(plain(requests[0].cursor), expected);
    assert.deepEqual(turn.items.map((item) => item.id), ["a", "b"]);
    assert.equal(state.activeTurnId, "turn");
    assert.equal(turn.status, "inProgress");
    assert.equal(state.threadItemPages.get("thread:turn").oldestItemId, "a");
  }
});

test("MCP inspector ignores a response after its conversation has changed", async () => {
  const pending = Promise.withResolvers();
  const inventory = { name: "lookup", tools: {} };
  const state = { activeThread: null, codexExtensions: { mcpStatuses: [inventory] } };
  const elements = {
    codexMcpInspector: { hidden: true }, codexMcpResourceOutput: {}, codexMcpToolOutput: {},
    codexMcpInspectorStatus: { textContent: "unchanged" },
  };
  const requests = [];
  const open = implementation(app, "openCodexMcpInspector", {
    state, elements, refreshIcons() {}, renderCodexMcpInspector() {},
    codexRuntimeFeatureAvailable: () => true,
    rpc: async (method, params) => { requests.push(params); return pending.promise; },
  });
  const result = open("lookup");
  assert.equal(requests[0].serverName, "lookup");
  state.activeThread = { id: "other" };
  pending.resolve({ data: [{ name: "lookup", toolsError: "old connection" }] });
  await result;
  assert.equal(state.codexExtensions.mcpStatuses[0], inventory);
  assert.equal(elements.codexMcpInspectorStatus.textContent, "unchanged");
});
