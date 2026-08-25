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
  assert.match(app, /entry\.id === request\.threadId && entry\.cwd === binding\.projectPath/u);
  assert.match(app, /await selectThread\(thread\)/u);
  assert.match(app, /await sendPrompt\(\)/u);
  assert.match(app, /await interruptTurn\(\)/u);
  assert.match(app, /state\.mapConversationOperations\.get\(request\.operationId\)/u);
});

test("conversation snapshots omit image bytes, map documents, and tool outputs", () => {
  const projection = app.slice(
    app.indexOf("function mapConversationMessages"),
    app.indexOf("function mapConversationAvailability"),
  );
  assert.match(projection, /item\?\.type === "userMessage"/u);
  assert.match(projection, /item\?\.type === "agentMessage"/u);
  assert.doesNotMatch(projection, /mcpToolCall|commandExecution|reasoning|fileChange|generatedImage|result|data:image|base64/u);
  assert.match(projection, /\.slice\(-80\)/u);
  assert.match(app, /messages: mapConversationMessages\(binding\.threadId\)/u);
});

test("same-project switch revokes the old game lease and requires map AI re-handshake", () => {
  const hostSwitch = app.slice(
    app.indexOf("async function switchMapConversationThread"),
    app.indexOf("async function sendMapConversationMessage"),
  );
  assert.match(hostSwitch, /revokeMapBindingGameWorkMode\(binding\)/u);
  assert.match(hostSwitch, /state\.imageContextLedger\.clear\(\)/u);
  assert.match(hostSwitch, /旧游戏模式和地图 AI 授权需重新握手/u);
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
