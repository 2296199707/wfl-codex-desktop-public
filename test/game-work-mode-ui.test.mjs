import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [appHtml, app, editorHtml, editorScript, editorCss] = await Promise.all([
  fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
]);

test("main map workspace controls the same explicit game-mode lease", () => {
  for (const id of ["mapGameWorkModeToggle", "mapGameWorkModeState", "mapGameWorkModeDetail"]) {
    assert.equal((appHtml.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1);
    assert.match(app, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(appHtml, /普通对话仍可直接读取图片/u);
  assert.match(app, /createGameWorkModeCommand/u);
  assert.match(app, /function toggleMapGameWorkMode/u);
  assert.match(editorScript, /parseGameWorkModeCommand/u);
  assert.match(editorScript, /function handleGameWorkModeCommand/u);
  assert.match(editorScript, /sendGameWorkModeSignal\("disable"\)[\s\S]*?sendMapEditorTabClosed\(\)/u);
  assert.match(app, /signal\.action === "closed"[\s\S]*?state\.gameWorkModeLeases\.delete\(key\)/u);
});

test("toolbox exposes independent image isolation and game-tool switches", () => {
  for (const id of ["imageContextIsolationToggle", "imageContextIsolationState", "imageContextIsolationDetail"]) {
    assert.equal((appHtml.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1);
    assert.match(app, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(appHtml, /title="工具中心"/u);
  assert.match(appHtml, /aria-label="打开工具中心"/u);
  assert.match(appHtml, /允许 AI 使用游戏工具/u);
  assert.match(appHtml, /隔离上下文图片/u);
  assert.match(app, /function toggleImageContextIsolation/u);
  assert.match(app, /function imageContextIsolationStorageKey/u);
  assert.match(app, /state\.imageContextIsolationEnabled === true \|\| gameWorkModeEnabled/u);
});

test("map editor exposes a default-off responsive game work mode switch", () => {
  for (const id of ["gameWorkModeControl", "gameWorkModeToggle", "gameWorkModeState"]) {
    assert.equal((editorHtml.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1);
    assert.match(editorScript, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(editorHtml, /id="gameWorkModeToggle"[^>]*type="checkbox"[^>]*role="switch"[^>]*disabled/u);
  assert.match(editorHtml, /游戏工作模式/u);
  assert.match(editorCss, /\.game-work-mode-control/u);
  assert.match(editorCss, /@media \(max-width: 420px\)[\s\S]*?\.game-work-mode-label/u);
});

test("editor mode is bound to its opening host, Codex thread, project, and map window", () => {
  const credentials = editorScript.slice(
    editorScript.indexOf("function mapSessionCredentials"),
    editorScript.indexOf("async function fetchMapSession"),
  );
  for (const fragmentField of ["host", "project", "thread"]) {
    assert.match(credentials, new RegExp(`fragment\\.get\\("${fragmentField}"\\)`, "u"));
  }
  assert.match(editorScript, /new BroadcastChannel\(gameWorkModeChannelName\(state\.credentials\.hostWindowId\)\)/u);
  assert.match(editorScript, /GAME_WORK_MODE_HEARTBEAT_MS/u);
  assert.match(editorScript, /window\.addEventListener\("pagehide"[\s\S]*?shutdownGameWorkMode\(\)/u);
  assert.match(editorScript, /sendGameWorkModeSignal\("disable"\)/u);

  const open = app.slice(
    app.indexOf("async function openMapEditorEntry"),
    app.indexOf("function currentCodexMapThread"),
  );
  assert.match(open, /host: CLIENT_WINDOW_ID/u);
  assert.match(open, /project: project\.path/u);
  assert.match(open, /state\.mapEditorGameBindings\.set\(editorInstanceId/u);
  const receive = app.slice(
    app.indexOf("function handleGameWorkModeSignal"),
    app.indexOf("function imageIsolationEnabledForActiveConversation"),
  );
  assert.match(receive, /binding\.sessionId !== signal\?\.sessionId/u);
  assert.match(receive, /binding\.threadId !== signal\?\.threadId/u);
  assert.match(receive, /binding\.projectPath !== signal\?\.projectPath/u);
});

test("ordinary chats keep full images while only active Codex game mode isolates repeats", () => {
  assert.equal((app.match(/prepareConversationImageContext\(/gu) || []).length, 3);
  assert.equal((app.match(/isolationEnabled: false/gu) || []).length, 0);
  assert.equal((app.match(/const imageIsolationEnabled = imageIsolationEnabledForActiveConversation\(\)/gu) || []).length, 4);
  assert.equal((app.match(/isolationEnabled: imageIsolationEnabled,/gu) || []).length, 3);
  assert.match(app, /summarizeMapConversationImageDelivery\([\s\S]{0,120}\{ isolationEnabled: imageIsolationEnabled \}/u);
  assert.doesNotMatch(app, /summarizeMapConversationImageDelivery\([\s\S]{0,120}\{ isolationEnabled \}/u);
  const isolation = app.slice(
    app.indexOf("function imageIsolationEnabledForActiveConversation"),
    app.indexOf("function scheduleGameWorkModeLeaseExpiry"),
  );
  assert.match(isolation, /runtime: state\.runtime/u);
  assert.match(isolation, /threadId: state\.activeThread\?\.id/u);
  assert.match(isolation, /projectPath: state\.currentProject\?\.path/u);
  const attachments = app.slice(
    app.indexOf("function renderAttachmentList"),
    app.indexOf("async function toggleImageGenerationMode"),
  );
  assert.match(attachments, /const imageIsolationEnabled = imageIsolationEnabledForActiveConversation\(\)/u);
  assert.match(attachments, /const resend = imageIsolationEnabled && attachment\.mediaType/u);
});
