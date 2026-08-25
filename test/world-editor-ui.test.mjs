import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, script, css] = await Promise.all([
  fs.readFile(new URL("../public/world-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/world-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/world-editor.css", import.meta.url), "utf8"),
]);

test("World editor exposes boundary, map, history, pattern, and adjacent controls", () => {
  for (const id of [
    "worldCanvas", "saveButton", "undoButton", "redoButton", "addMapButton", "removeMapButton",
    "openMapButton", "mapList", "mapInspectorForm", "mapX", "mapY", "mapWidth", "mapHeight",
    "adjacentMapsToggle", "patternsInput", "applyPatternsButton", "addMapDialog", "closeDialog",
    "navigationCheckButton", "navigationState", "navigationList", "navigationCount",
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(script, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(script, /new TiledWorldEditDocument/u);
  assert.match(script, /worldMapAtPoint/u);
  assert.match(script, /adjacentWorldMapIndexes/u);
  assert.match(script, /editor\.moveMap/u);
  assert.match(script, /editor\.resizeMap/u);
  assert.match(script, /editor\.replacePatterns/u);
  assert.match(script, /planWorldMapPreviews/u);
  assert.match(script, /collectWorldMapNavigation/u);
  assert.match(script, /validateWorldPortalReferences/u);
  assert.match(script, /releaseMapPreviews/u);
});

test("World editor uses dedicated World APIs and isolated read-only map previews", () => {
  assert.match(script, /\/api\/map-worlds\/sessions/u);
  assert.match(script, /\/api\/map-worlds\/save-sessions/u);
  assert.match(script, /\/api\/maps\/sessions/u);
  assert.match(script, /map-session-close/u);
  assert.match(script, /map-world-save-start/u);
  assert.match(script, /map-world-save-chunk/u);
  assert.match(script, /map-world-save-commit/u);
  assert.doesNotMatch(script, /ai-leases|image-jobs|render-jobs|game-work-mode/u);
});

test("World navigation checks are explicit and previews release resources outside the plan", () => {
  assert.match(script, /navigationCheckButton\.addEventListener\("click"/u);
  assert.match(script, /mode: "inspect"/u);
  assert.match(script, /current\.mode === "full" && next\.mode === "preview"/u);
  assert.match(script, /state\.mapPreviews\.delete/u);
  assert.match(script, /destroyPreviewCanvas/u);
  assert.match(script, /drawNavigationLinks/u);
});

test("World editor has responsive fixed-format panels and canvas dimensions", () => {
  assert.match(css, /grid-template-columns: 250px minmax\(260px, 1fr\) 280px/u);
  assert.match(css, /#worldCanvas \{[^}]*width: 100%[^}]*height: 100%/u);
  assert.match(css, /@media \(max-width: 600px\)/u);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/u);
});

test("World editor verifies the opening account before loading and clears cached map pixels on change", () => {
  assert.match(script, /createMapAccountSessionGuard/u);
  assert.match(script, /if \(!state\.credentials\.accountId\) throw new Error/u);
  assert.ok(script.indexOf("await state.accountSessionGuard.check()") < script.indexOf("await loadWorld()"));
  const invalidation = script.slice(
    script.indexOf("function invalidateWorldAccountSession"),
    script.indexOf("function accountSessionEndedNotice"),
  );
  assert.match(invalidation, /releaseSessions\(\{ keepalive: true \}\)/u);
  assert.match(invalidation, /destroyPreviewCanvas/u);
  assert.match(invalidation, /state\.mapPreviews\.clear\(\)/u);
  assert.match(invalidation, /state\.editor = null/u);
  assert.match(invalidation, /state\.parsed = null/u);
  assert.match(invalidation, /worldCanvas\.width = 1/u);
  assert.match(invalidation, /document\.body\.replaceChildren/u);
});
