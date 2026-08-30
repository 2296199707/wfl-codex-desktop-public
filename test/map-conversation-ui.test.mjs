import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, editor, app, css, viewer] = await Promise.all([
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/pixi-viewer.js", import.meta.url), "utf8"),
]);

const IDS = [
  "collaborationButton",
  "collaborationPanel",
  "conversationThreadSelect",
  "conversationContextState",
  "conversationActivityState",
  "conversationActivityList",
  "conversationMessageList",
  "conversationImageDelivery",
  "conversationComposer",
  "conversationInput",
  "sendConversationButton",
  "proposalTrayList",
  "taskTrayList",
  "openImageTasksButton",
  "openRenderTasksButton",
  "managedTaskDialog",
  "managedTaskRiskReceipt",
  "managedTaskDiffReceipt",
  "managedTaskApproveButton",
];

test("map editor exposes one responsive conversation, proposal, and task workspace", () => {
  for (const id of IDS) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(editor, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(css, /\.map-app\[data-collaboration-open="true"\] \.map-workspace/u);
  assert.match(css, /@media \(max-width: 1200px\)[\s\S]*?\.collaboration-panel/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.collaboration-panel/u);
  assert.match(css, /\.conversation-thread-control \.mini-icon-button[\s\S]*?height: 42px/u);
  assert.match(css, /\.collaboration-tabs button[\s\S]*?min-height: 44px/u);
  assert.match(css, /\.conversation-composer textarea[\s\S]*?font-size: 16px/u);
  assert.match(html, /任务结果留在候选区或导出目录，不会自动加入对话上下文/u);
});

test("editor mirror is a bounded view over the host's authoritative Codex thread", () => {
  assert.match(editor, /createMapConversationRequest/u);
  assert.match(editor, /parseMapConversationSnapshot/u);
  assert.match(editor, /parseMapConversationResult/u);
  assert.match(editor, /bindMapConversationThread\(snapshot\.boundThreadId\)/u);
  assert.match(editor, /sessionStorage\.setItem\(SESSION_STORAGE_KEY, JSON\.stringify\(state\.credentials\)\)/u);
  assert.match(editor, /sendMapConversationRequest\("send", \{/u);
  assert.match(editor, /operationId: crypto\.randomUUID\(\)/u);
  assert.doesNotMatch(editor, /rpc\("(?:thread|turn)\//u);

  assert.match(app, /channel\.addEventListener\("message", handleMapConversationRequest\)/u);
  assert.match(app, /binding\.sessionId !== request\.sessionId/u);
  assert.match(app, /binding\.projectPath !== request\.projectPath/u);
  assert.match(app, /conversationThreadById\(request\.threadId, binding\.projectPath\)/u);
  const requestHandler = app.slice(
    app.indexOf("async function handleMapConversationRequest"),
    app.indexOf("async function focusMapConversationMain"),
  );
  assert.doesNotMatch(requestHandler, /elements\.promptInput|sendPrompt\(/u);
  assert.match(requestHandler, /sendMapConversationMessage\(binding, request\)/u);
  assert.match(requestHandler, /interruptMapConversationTurn\(binding, request\)/u);
  const directSend = app.slice(
    app.indexOf("async function executeMapConversationSend"),
    app.indexOf("function mapConversationSendErrorResult"),
  );
  assert.match(directSend, /const method = steer \? "turn\/steer" : "turn\/start"/u);
  assert.match(directSend, /clientUserMessageId: request\.operationId/u);
  assert.match(directSend, /mapConversationRpcWithRetry\(method, params\)/u);
  const directInterrupt = app.slice(
    app.indexOf("async function interruptMapConversationTurn"),
    app.indexOf("function rememberMapConversationTaskStatus"),
  );
  assert.match(directInterrupt, /targetTurnId !== threadState\.activeTurnId/u);
  assert.match(directInterrupt, /mapConversationRpcWithRetry\("turn\/interrupt", \{/u);
  assert.match(directInterrupt, /threadId: targetThreadId,[\s\S]*?turnId: targetTurnId/u);
  assert.match(app, /state\.mapConversationOperations\.get\(request\.operationId\)/u);
  assert.match(app, /listConversationThreads\(/u);
  assert.match(app, /mapConversationMessages\(binding\.threadId, binding\.projectPath\)/u);
  assert.match(editor, /conversationThreadSelect\.addEventListener\("change"/u);
  assert.match(editor, /未绑定，仅查看/u);
  assert.match(editor, /async function unbindMapConversationThread/u);
  assert.match(editor, /expectedBoundThreadId: snapshot\.boundThreadId/u);
  assert.doesNotMatch(editor, /elements\.conversationThreadSelect\.disabled = true/u);
  assert.match(editor, /turnId: state\.conversationSnapshot\?\.conversation\?\.activeTurnId/u);
});

test("map editor treats the host snapshot as the only conversation binding authority", () => {
  assert.doesNotMatch(
    editor.slice(editor.indexOf("function mapSessionCredentials"), editor.indexOf("async function fetchMapSession")),
    /threadId: fragment\.get\("thread"\)/u,
  );
  assert.match(editor, /conversationBindingResolved: false/u);
  assert.match(editor, /state\.conversationBindingResolved = true/u);
  assert.match(editor, /mapConversationThreadId\(\)/u);
  assert.match(editor, /if \(!state\.conversationBindingResolved\) return null/u);
  assert.match(editor, /lease\.threadId === mapConversationThreadId\(\)/u);
});

test("a non-active bound thread hydrates through read/list without changing the main selection", () => {
  assert.match(app, /mapConversationHydrations: new Map\(\)/u);
  assert.match(app, /ensureMapConversationThreadHydrated\(binding\)/u);
  assert.match(app, /rpc\("thread\/read", \{[\s\S]*?includeTurns: false/u);
  assert.match(app, /rpc\("thread\/turns\/list", recentTurnsParams\(threadId\)/u);
  assert.match(app, /state\.conversationState = replaceConversationThread\(/u);
  assert.match(app, /mergeLoadedTurnPage\([\s\S]*?currentTurns,[\s\S]*?incomingTurns/u);
  assert.match(app, /record\.loaded = true[\s\S]*?thread\/turns\/list/u);
  assert.match(app, /record\.complete = false[\s\S]*?record\.status = "error"/u);
  assert.doesNotMatch(
    app.slice(app.indexOf("function ensureMapConversationThreadHydrated"), app.indexOf("async function handleMapConversationRequest")),
    /selectThread\(|thread\/resume/u,
  );
  assert.match(app, /request\.action === "hydrate-thread"/u);
  assert.match(editor, /sendMapConversationRequest\("hydrate-thread"/u);
  assert.match(editor, /refresh: true/u);
});

test("conversation snapshots omit image bytes, map documents, and tool outputs", () => {
  const projection = app.slice(
    app.indexOf("function mapConversationMessages"),
    app.indexOf("function mapConversationThreadState"),
  );
  assert.match(projection, /item\?\.type === "userMessage"/u);
  assert.match(projection, /item\?\.type === "agentMessage"/u);
  assert.doesNotMatch(projection, /mcpToolCall|commandExecution|reasoning|fileChange|generatedImage|result|data:image|base64/u);
  assert.match(projection, /\.slice\(-80\)/u);
  const activityProjection = app.slice(
    app.indexOf("function mapConversationActivities"),
    app.indexOf("function mapConversationLoading"),
  );
  assert.match(activityProjection, /mcpToolCall/u);
  assert.doesNotMatch(activityProjection, /aggregatedOutput|item\??\.command|commandText/u);
  assert.match(app, /messages: mapConversationMessages\(binding\.threadId, binding\.projectPath\)/u);
});

test("same-project switch revokes the old game lease and requires map AI re-handshake", () => {
  const hostSwitch = app.slice(
    app.indexOf("async function switchMapConversationThread"),
    app.indexOf("async function sendMapConversationMessage"),
  );
  assert.match(hostSwitch, /handleMapConversationBindingUpdate\(/u);
  assert.match(hostSwitch, /const projectBindings = \[\.\.\.state\.mapEditorGameBindings\.values\(\)\]/u);
  assert.match(hostSwitch, /projectBindings\.some\(/u);
  assert.match(app, /state\.imageContextLedger\.clear\(\)/u);
  assert.match(hostSwitch, /主界面当前对话保持不变，地图 AI 授权需重新握手/u);
  const editorSwitch = editor.slice(
    editor.indexOf("async function switchMapConversationThread"),
    editor.indexOf("function submitMapConversation"),
  );
  assert.match(editorSwitch, /sendGameWorkModeSignal\("disable"\)/u);
  assert.match(editorSwitch, /await disconnectMapAiLease\(\)/u);
  assert.match(editorSwitch, /if \(state\.mapAiLease\)/u);
});

test("proposal preview draws a bounded ghost overlay without applying the patch", () => {
  assert.match(viewer, /AI_PATCH_OVERLAY_LIMIT = 5_000/u);
  assert.match(viewer, /setAiPatchPreview\(patch = null\)/u);
  assert.match(viewer, /fill\(\{ color: 0xf6c453, alpha: 0\.2 \}\)/u);
  assert.match(viewer, /operation\.op === "remove-object"/u);
  const preview = editor.slice(
    editor.indexOf("async function previewMapAiProposal"),
    editor.indexOf("async function applyMapAiProposal"),
  );
  assert.match(preview, /state\.viewer\?\.setAiPatchPreview\(prepared\.normalizedPatch\)/u);
  assert.doesNotMatch(preview, /applyProposal|saveMap/u);
  assert.match(viewer, /setAiImpactPreview\(impact = null\)/u);
  assert.match(viewer, /aiImpactPreview\?\.heatmap/u);
});

test("task tray reuses candidate and render jobs without attaching results to chat", () => {
  assert.match(editor, /async function loadTaskTray\(\)/u);
  assert.match(editor, /refreshMapImageJobs\(\{ silent: true \}\)/u);
  assert.match(editor, /loadRenderJobs\(\{ quiet: true \}\)/u);
  assert.match(editor, /function taskTrayIsVisible\(\)/u);
  assert.match(editor, /\(!elements\.mapImageDialog\.open && !taskTrayIsVisible\(\)\)/u);
  assert.match(editor, /\(!taskTrayIsVisible\(\) && \(!elements\.exportDialog\.open/u);
  const tray = editor.slice(editor.indexOf("function renderTaskTray"), editor.indexOf("async function openRenderTaskDialog"));
  assert.doesNotMatch(tray, /conversationInput|sendMapConversationRequest|attachment|localImage/u);
});

test("managed task actions use a formal inspectable dialog instead of prompt", () => {
  const section = editor.slice(
    editor.indexOf("async function showManagedMapAiTaskActions"),
    editor.indexOf("async function openRenderTaskDialog"),
  );
  assert.match(section, /renderManagedTaskDialog\(task\)/u);
  assert.match(section, /managedTaskRiskReceipt/u);
  assert.match(section, /applyManagedTaskAction/u);
  assert.doesNotMatch(section, /window\.prompt/u);
  assert.match(html, /id="managedTaskDialog"[\s\S]*?id="managedTaskEventReceipt"/u);
});
