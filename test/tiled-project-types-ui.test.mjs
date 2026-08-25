import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, script, css, packageSource] = await Promise.all([
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/package-source.mjs", import.meta.url), "utf8"),
]);

test("map editor loads project Class/Enum definitions and exposes typed property controls", () => {
  assert.match(script, /api\/maps\/sessions\/.*project-source/u);
  assert.doesNotMatch(script, /api\/map-projects\/sessions\/.*project-source/u);
  assert.match(script, /parseTiledProjectTypes/u);
  assert.match(script, /tiledPropertyControl/u);
  assert.match(script, /propertyTypeNameControl/u);
  assert.match(script, /type === "enum"/u);
  assert.match(script, /type === "list"/u);
  assert.match(script, /propertyReferenceButton/u);
  assert.match(script, /jumpToObjectPropertyReference/u);
  assert.match(script, /openReferencedTiledDocument/u);
  assert.match(script, /showTemplateAssets/u);
  assert.match(script, /materializeTiledTemplate/u);
  assert.match(script, /project-assets/u);
  assert.match(html, /id="customProperties"/u);
  assert.match(html, /id="templateAssetDialog"/u);
  assert.match(html, /id="unbindTemplateButton"/u);
  assert.match(html, /id="assetLibraryDialog"/u);
  assert.match(script, /project-assets\/search/u);
  assert.match(css, /\.property-row \.property-type-name/u);
  assert.match(css, /\.property-row \.property-reference-button/u);
  assert.match(packageSource, /public\/map-editor\/tiled-template\.js/u);
  assert.match(packageSource, /public\/map-editor\/map-asset-library\.js/u);
  assert.match(packageSource, /public\/map-editor\/tiled-project-types\.js/u);
});
