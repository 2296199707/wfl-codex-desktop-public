import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, script, css] = await Promise.all([
  fs.readFile(new URL("../public/tileset-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/tileset-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/tileset-editor.css", import.meta.url), "utf8"),
]);

test("tileset editor exposes visual atlas, collection, history, and rendering controls", () => {
  for (const id of [
    "tilesetCanvas", "tileList", "saveButton", "undoButton", "redoButton", "fitButton",
    "identityForm", "tilesetName", "tilesetClass", "atlasForm", "tileWidth", "tileHeight",
    "tileMargin", "tileSpacing", "transparentEnabled", "transparentColor", "renderingForm",
    "objectAlignment", "tileRenderSize", "fillMode", "tileOffsetX", "tileOffsetY",
    "gridOrientation", "gridWidth", "gridHeight", "allowHFlip", "allowVFlip", "allowRotate",
    "preferUntransformed", "selectedTileId", "closeDialog",
    "addCollectionImageButton", "removeCollectionImageButton", "collectionImageDialog",
    "collectionImageForm", "collectionImageSearch", "collectionImageList", "collectionImageSubmitButton",
    "tileMetadataForm", "tileClass", "tileProbabilityEnabled", "tileProbability",
    "tilePropertiesSection", "tilePropertyRows", "addTilePropertyButton",
    "tileAnimationSection", "animationPreviewCanvas", "animationFrameRows", "addAnimationFrameButton",
    "tileCollisionSection", "newCollisionShape", "addCollisionButton", "collisionObjectRows",
    "wangSetSection", "addWangSetButton", "removeWangSetButton", "wangSetSelect", "wangSetForm",
    "wangSetName", "wangSetClass", "wangSetType", "wangSetTile", "wangColorRows",
    "addWangColorButton", "tileWangForm", "tileWangGrid", "applyTileWangButton",
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(script, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(script, /new TiledTilesetEditDocument/u);
  assert.match(script, /editor\.setAtlasGrid/u);
  assert.match(script, /editor\.setRendering/u);
  assert.match(script, /resolveTiledProjectReference/u);
  assert.match(script, /relativeTiledProjectReference/u);
  assert.match(script, /editor\.addCollectionTile/u);
  assert.match(script, /editor\.removeCollectionTiles/u);
  assert.match(script, /editor\.setTileMetadata/u);
  assert.match(script, /editor\.setTileProperties/u);
  assert.match(script, /editor\.setTileAnimation/u);
  assert.match(script, /editor\.addTileCollision/u);
  assert.match(script, /editor\.updateTileCollision/u);
  assert.match(script, /drawTileCollisionOverlay/u);
  assert.match(script, /renderAnimationPreviewFrame/u);
  assert.match(script, /editor\.addWangSet/u);
  assert.match(script, /editor\.addWangColor/u);
  assert.match(script, /editor\.setTileWangId/u);
  assert.match(script, /drawTileWangOverlay/u);
  assert.match(script, /new MapProjectWorkspaceClient/u);
  assert.match(script, /PAGE_SIZE = 200/u);
});

test("tileset editor uses dedicated versioned APIs and authenticated image blobs", () => {
  assert.match(script, /\/api\/map-tilesets\/sessions/u);
  assert.match(script, /\/api\/map-tilesets\/save-sessions/u);
  assert.match(script, /map-tileset-save-start/u);
  assert.match(script, /map-tileset-save-chunk/u);
  assert.match(script, /map-tileset-save-commit/u);
  assert.match(script, /URL\.createObjectURL\(await response\.blob\(\)\)/u);
  assert.match(script, /"X-Codex-Desktop-Editor-Instance"/u);
  assert.doesNotMatch(script, /\/api\/files\/write|data:image|base64/iu);
});

test("tileset editor keeps fixed responsive panels and touch-safe canvas dimensions", () => {
  assert.match(css, /grid-template-columns: 232px minmax\(280px, 1fr\) 300px/u);
  assert.match(css, /#tilesetCanvas \{[^}]*width: 100%[^}]*height: 100%[^}]*touch-action: none/u);
  assert.match(css, /@media \(max-width: 620px\)/u);
  assert.match(css, /\.animation-preview/u);
  assert.match(css, /\.collision-object-row/u);
  assert.match(css, /\.tile-wang-grid/u);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/u);
});

test("tileset editor verifies the opening account before loading and clears decoded images on change", () => {
  assert.match(script, /createMapAccountSessionGuard/u);
  assert.match(script, /if \(!state\.credentials\.accountId\) throw new Error/u);
  assert.ok(script.indexOf("await state.accountSessionGuard.check()") < script.indexOf("await loadTileset()"));
  const invalidation = script.slice(
    script.indexOf("function invalidateTilesetAccountSession"),
    script.indexOf("function accountSessionEndedNotice"),
  );
  assert.match(invalidation, /releaseSession\(\{ keepalive: true \}\)/u);
  assert.match(invalidation, /state\.imageRecords\.clear\(\)/u);
  assert.match(invalidation, /state\.editor = null/u);
  assert.match(invalidation, /state\.parsed = null/u);
  assert.match(invalidation, /tilesetCanvas\.width = 1/u);
  assert.match(invalidation, /animationPreviewCanvas\.width = 1/u);
  assert.match(invalidation, /document\.body\.replaceChildren/u);
});
