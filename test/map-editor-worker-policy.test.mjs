import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [script, editDocument, packageSource] = await Promise.all([
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/tiled-edit-document.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/package-source.mjs", import.meta.url), "utf8"),
]);

test("interactive fill, While Drawing, and AI fill use explicit browser Workers", () => {
  assert.match(script, /new TiledFillWorkerClient\(\)/u);
  assert.match(script, /new TiledAiPatchWorkerClient\(\)/u);
  assert.match(script, /state\.aiProposalPatchWorkerClient = new TiledAiPatchWorkerClient\(\)/u);
  assert.match(script, /state\.autoMapGestureWorkerClient = new TiledAutomapWorkerClient\(\)/u);
  const fillStart = script.indexOf("async function fillTileRegion");
  const fill = script.slice(fillStart, script.indexOf("function beginObject", fillStart));
  assert.match(fill, /state\.fillWorkerClient\.fill\(/u);
  assert.match(fill, /maxCells: 1_000_000/u);
  assert.match(fill, /applyTileFillResult/u);
  assert.doesNotMatch(fill, /\.fillTileRegion\(/u);
  const whileDrawing = script.slice(
    script.indexOf("async function applyAutoMapForGesture"),
    script.indexOf("function autoMapGestureRegion"),
  );
  assert.match(whileDrawing, /autoMapGestureWorkerClient\.preview/u);
  assert.doesNotMatch(whileDrawing, /previewTiledAutomapping/u);
  assert.doesNotMatch(script, /import[\s\S]*?previewTiledAutomapping[\s\S]*?from "\.\/tiled-automap/u);
  assert.match(script, /aiProposalPatchWorkerClient\.prepare/u);
});

test("compact fill history and all Worker modules are release-package assets", () => {
  assert.match(editDocument, /type: "tile-fill-compact"/u);
  assert.match(editDocument, /entry\.type === "tile-fill-compact"/u);
  for (const asset of [
    "public/map-editor/tiled-fill.js",
    "public/map-editor/tiled-fill-worker.js",
    "public/map-editor/tiled-fill-worker-client.js",
    "public/map-editor/tiled-automap-worker.js",
    "public/map-editor/tiled-automap-worker-client.js",
    "public/map-editor/tiled-ai-patch-worker.js",
    "public/map-editor/tiled-ai-patch-worker-client.js",
  ]) assert.match(packageSource, new RegExp(`"${asset.replaceAll("/", "\\/")}"`, "u"));
});

test("save and autosave wait for active fill-derived operations", () => {
  const save = script.slice(script.indexOf("async function saveMap"), script.indexOf("function showAiPatchDialog"));
  assert.match(save, /state\.fillPending \|\| state\.autoMapGesturePending/u);
  const autoSave = script.slice(script.indexOf("function updateAutoSaveTimer"), script.indexOf("function clearAutoSaveTimer"));
  assert.match(autoSave, /state\.fillPending/u);
  assert.match(autoSave, /state\.autoMapGesturePending/u);
});

test("map image task cards expose only bounded provider diagnostics", () => {
  const start = script.indexOf("function mapImageJobDiagnostic");
  const end = script.indexOf("function renderMapImageCandidate", start);
  const diagnostic = script.slice(start, end);
  assert.match(diagnostic, /requestedSize/u);
  assert.match(diagnostic, /providerSize/u);
  assert.match(diagnostic, /sourceSize/u);
  assert.match(diagnostic, /supportedSizes/u);
  assert.match(diagnostic, /providerRequestId/u);
  assert.doesNotMatch(diagnostic, /innerHTML|sourcePath|absolutePath|base64/u);
});
