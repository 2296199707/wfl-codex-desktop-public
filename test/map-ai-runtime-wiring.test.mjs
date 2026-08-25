import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return server.slice(from, to);
}

test("Codex runtime injects one private wfl_map_ai MCP adapter outside rescue mode", () => {
  const override = sourceBetween("function codexMapAiMcpOverride", "function codexPersistentSshMcpOverride");
  assert.match(override, /mcp_servers\.wfl_map_ai/u);
  assert.match(override, /scripts|scriptPath/u);
  assert.match(override, /socketPath/u);
  assert.match(override, /required = false/u);
  assert.doesNotMatch(override, /lease|token|projectPath|userId|browserSession/iu);

  const initialize = sourceBetween("async initialize() {", "getConversationSidecar() {");
  assert.match(initialize, /if \(!RESCUE_MODE && CODEX_ENABLED\)/u);
  assert.match(initialize, /new MapAiToolService\(/u);
  assert.match(initialize, /authorizedOperationsForUser/u);
  assert.match(initialize, /map-ai-tools/u);
  assert.match(initialize, /scripts["', ]+,["', ]+"map-ai-mcp\.mjs"/u);
  assert.match(initialize, /this\.mapAiTool\?\.close\(\)/u);
  assert.match(server, /mapAiPatchWorkerRunner/u);
  assert.match(server, /map-ai-patches/u);

  const bridgeStart = sourceBetween("class CodexBridge", "class UserRuntime");
  assert.match(bridgeStart, /codexMapAiMcpOverride\(this\.mapAiTool\)/u);
  assert.match(bridgeStart, /this\.mapAiTool = mapAiTool/u);
});

test("Codex runtime injects a separate headless managed map MCP adapter", () => {
  const override = sourceBetween("function codexMapAiManagedMcpOverride", "function codexPersistentSshMcpOverride");
  assert.match(override, /mcp_servers\.wfl_map_ai_managed/u);
  assert.match(override, /required = false/u);
  assert.doesNotMatch(override, /lease|token|projectPath|userId|browserSession/iu);
  const initialize = sourceBetween("async initialize() {", "getConversationSidecar() {");
  assert.match(initialize, /new MapAiManagedToolService\(/u);
  assert.match(initialize, /map-ai-managed-tools/u);
  assert.match(initialize, /map-ai-managed-mcp\.mjs/u);
  const bridgeStart = sourceBetween("class CodexBridge", "class UserRuntime");
  assert.match(bridgeStart, /codexMapAiManagedMcpOverride\(this\.mapAiManagedTool\)/u);
});

test("each tool call revalidates the live lease, map, project, thread and editor state", () => {
  const validation = sourceBetween("async function validateMapAiToolLiveContext", "async function getMapAiToolContextForRuntime");
  assert.match(validation, /mapFileSessions\.context/u);
  assert.match(validation, /assertMapAiLeaseIdentity/u);
  assert.match(validation, /resolveResourceTarget/u);
  assert.match(validation, /assertWritableMapContext/u);
  assert.match(validation, /inspectMapFile/u);
  assert.match(validation, /assertMapAiThreadProject/u);
  assert.match(validation, /resolveMapAiToolContextForRuntime/u);
  assert.match(validation, /editorStateId/u);
  assert.match(validation, /MAP_AI_MAP_VERSION_CONFLICT/u);
});

test("proposal tool stores the full patch only in the editor inbox and returns a bounded receipt", () => {
  const proposal = sourceBetween("async function proposeMapAiPatchForRuntime", "function mapImageJobLimits");
  assert.match(proposal, /mapAiProposals\.create/u);
  assert.match(proposal, /patch: input\?\.patch/u);
  const returned = proposal.slice(proposal.lastIndexOf("return {"));
  for (const field of ["id", "status", "summary", "patchBytes", "mapPath", "mapVersion", "editorStateId", "risk", "createdAt", "expiresAt"]) {
    assert.match(returned, new RegExp(`\\b${field}:`, "u"));
  }
  assert.doesNotMatch(returned, /\bpatch:/u);
  assert.doesNotMatch(returned, /projectPath|browserSessionId|lease|token/iu);
});

test("managed map task state is persistent and isolated from the map executor", () => {
  const initialize = sourceBetween("const mapAiManagedTasks =", "const mapResourceCatalog =");
  assert.match(initialize, /MapAiManagedTaskStore/u);
  assert.match(initialize, /STATE_DIR/u);
  assert.match(initialize, /writeOnInitialize: BACKEND_PRIMARY_AT_START/u);
  assert.doesNotMatch(initialize, /apply|writeFile|mapSaveSessions/u);
  const release = sourceBetween("async function releaseMapBrowserSessionResources", "function scheduleMapBrowserSessionResourceRelease");
  assert.match(release, /mapAiManagedTasks\?\.cancelForBrowserSession/u);
  assert.doesNotMatch(release, /mapAiResourceCandidates\?\.deleteForUser/u);
});

test("headless managed authorization and task routes stay separate from editor leases", async () => {
  const managed = sourceBetween('app.post("/api/map-ai/managed-authorizations"', 'app.post("/api/maps/sessions/:sessionId/ai-leases"');
  for (const marker of ["mapAiManagedAuthorizations", "createMapAiApprovalSnapshot", "assertMapAiThreadProject", "inspectMapFile"]) {
    assert.match(managed, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "u"));
  }
  assert.match(managed, /authorityMode: "managed"/u);
  assert.doesNotMatch(managed, /mapAiAccess\.grantLease/u);
  assert.doesNotMatch(managed, /editorInstanceId/u);
  assert.doesNotMatch(managed, /leaseId|leaseToken/u);
  const tasks = sourceBetween('app.post("/api/map-ai/managed-tasks"', 'app.get("/api/map-ai/managed-tasks"');
  assert.match(tasks, /mapAiManagedAuthorizations\.taskContract/u);
  assert.match(tasks, /mapAiManagedTasks\.create/u);
  assert.match(tasks, /inspected\.version/u);
  assert.match(tasks, /body\.request/u);
  assert.doesNotMatch(tasks, /mapSaveSessions\.commit|fs\.writeFile/u);
  const events = sourceBetween('app.get("/api/map-ai/managed-tasks/:taskId/events"', 'app.post("/api/map-ai/managed-tasks/:taskId/action"');
  assert.match(events, /mapAiManagedTasks\.eventsSince/u);
  assert.match(events, /after: request\.query\.after/u);
  const revoke = sourceBetween('app.delete("/api/map-ai/managed-authorizations/:authorizationId"', 'app.post("/api/map-ai/managed-tasks"');
  assert.match(revoke, /mapAiManagedAuthorizations\.revoke/u);
  assert.match(revoke, /mapAiManagedTasks\?\.cancelForAuthorization/u);
  const audit = sourceBetween('app.get("/api/map-ai/managed-authorizations/:authorizationId/audit"', 'app.delete("/api/map-ai/managed-authorizations/:authorizationId"');
  assert.match(audit, /mapAiManagedAuthorizations\.audit/u);
  assert.match(audit, /managedMapAiIdentity/u);
  assert.match(audit, /Cache-Control/u);
  const editor = await fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8");
  assert.match(editor, /response\?\.snapshotRequired && response\.snapshot/u);
  assert.match(editor, /never let a stale event replay overwrite a terminal state/u);
});

test("managed task actions persist before scheduling background execution", () => {
  const actions = sourceBetween('app.post("/api/map-ai/managed-tasks/:taskId/action"', 'app.post("/api/maps/sessions/:sessionId/ai-leases"');
  assert.match(actions, /await mapAiManagedTasks\.transition/u);
  assert.match(actions, /scheduleMapAiManagedTaskExecution/u);
  assert.doesNotMatch(actions, /await mapAiManagedTaskExecutor\.execute/u);
  assert.match(server, /setImmediate\(\(\) =>/u);
});

test("managed map patch execution is delegated to a private worker and closed with render workers", () => {
  const initialize = sourceBetween("const mapAiManagedTaskExecutor", "const mapProjectResourceWriter");
  assert.match(server, /createMapAiPatchWorkerRunner/u);
  assert.match(initialize, /patchWorker:/u);
  assert.match(server, /useSystemd: !MAP_AI_PATCH_WORKER_DIRECT_TEST_MODE/u);
  const close = sourceBetween("async function closeMapRenderSystem", "function requireImageExecutionOps");
  assert.match(close, /mapAiPatchWorkerRunner\?\.close/u);
});

test("runtime destruction and process shutdown close the map AI socket", () => {
  const destroy = sourceBetween("destroy(reason =", "if (CODEX_ENABLED) await prepareCodexExecutable");
  assert.match(destroy, /this\.mapAiTool\?\.close\(\)/u);
  assert.match(destroy, /this\.mapAiTool = null/u);
  const shutdown = sourceBetween("function shutdown()", "process.on(\"SIGINT\", shutdown)");
  assert.match(shutdown, /runtime\.mapAiTool\?\.close\(\)/u);
});
