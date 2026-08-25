import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, script, css, viewer, packageSource] = await Promise.all([
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/pixi-viewer.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/package-source.mjs", import.meta.url), "utf8"),
]);

test("map editor exposes a manual Terrain Brush with set, color, and per-stroke seed", () => {
  for (const id of [
    "terrainBrushToolButton", "terrainBrushControls", "terrainSetSelect", "terrainColorSelect",
    "terrainBrushSeed", "terrainRandomizeSeedButton", "terrainBrushState",
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(script, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(script, /import \{ planTerrainBrush \} from "\.\/terrain-brush-model\.js(?:\?v=[^"]+)?"/u);
  assert.match(script, /kind: "terrain-brush"/u);
  assert.match(script, /seed: state\.terrainStrokePlan\.seed/u);
  assert.match(script, /设置变化只影响下一笔/u);
  assert.match(css, /\.terrain-brush-controls/u);
});

test("map editor exposes cross-map Stamp clipboard actions and GID remapping", () => {
  for (const id of ["copyTileStampButton", "pasteTileStampButton"]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(script, new RegExp(`\\b${id}\\b`, "u"));
  }
  assert.match(script, /planTiledTilesetReuse\(/u);
  assert.match(script, /plan\.remapTileStamp\(/u);
  assert.match(packageSource, /public\/map-editor\/tiled-gid-reuse\.js/u);
});

test("viewer exposes loaded external Wang sets without inventing missing candidates", () => {
  assert.match(viewer, /terrainPaletteEntries\(\)/u);
  assert.match(viewer, /wangIdByLocalId/u);
  assert.match(viewer, /if \(!colors\.length \|\| !candidates\.length\) continue/u);
  assert.match(packageSource, /public\/map-editor\/terrain-brush-model\.js/u);
});
