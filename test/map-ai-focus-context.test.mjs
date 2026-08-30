import assert from "node:assert/strict";
import test from "node:test";

import {
  createMapAiFocusContext,
  formatMapAiFocus,
  mapAiFocusSummary,
} from "../public/map-editor/map-ai-focus-context.js";

test("formats selected objects as an exact map and object target without absolute paths", () => {
  const context = createMapAiFocusContext({
    projectId: "game-project-00000001",
    projectName: "Forest",
    mapPath: "maps/forest.tmj",
    mapVersion: "A".repeat(64),
    editorStateId: 17,
    activeLayer: { id: 4, name: "Buildings", type: "objectgroup" },
    selectedObjects: [{ id: 22, name: "Gate", class: "building", x: 128, y: 96, width: 64, height: 48 }],
  });
  assert.equal(mapAiFocusSummary(context), "对象 #22");
  assert.deepEqual(context.target.objectIds, [22]);
  assert.equal(context.map.path, "maps/forest.tmj");
  const text = formatMapAiFocus(context);
  assert.match(text, /maps\/forest\.tmj/u);
  assert.match(text, /"id": 22/u);
  assert.doesNotMatch(text, /projectPath|\/srv\//u);
});

test("formats tile and image selections with bounded, machine-readable regions", () => {
  const tileContext = createMapAiFocusContext({
    mapPath: "maps/forest.tmj",
    activeLayer: { id: 2, name: "Ground", type: "tilelayer" },
    selection: { kind: "tile-cells", layerId: 2, startColumn: 3, startRow: 4, endColumn: 7, endRow: 8, cells: [{}, {}, {}] },
  });
  assert.equal(mapAiFocusSummary(tileContext), "瓦片区域 5 × 5");
  assert.deepEqual(tileContext.target.bounds, { startColumn: 3, startRow: 4, endColumn: 7, endRow: 8 });
  const imageContext = createMapAiFocusContext({
    mapPath: "maps/forest.tmj",
    selection: { kind: "image-layers", layerIds: [8, 9], x: 1, y: 2, width: 300, height: 200 },
  });
  assert.equal(mapAiFocusSummary(imageContext), "2 个图片层");
  assert.deepEqual(imageContext.target.layerIds, [8, 9]);
});

test("falls back to the active layer or map and rejects traversal paths", () => {
  assert.equal(createMapAiFocusContext({ mapPath: "../escape.tmj" }), null);
  const layerContext = createMapAiFocusContext({ mapPath: "maps/forest.tmj", activeLayer: { id: 3, name: "Ground", type: "tilelayer" } });
  assert.equal(mapAiFocusSummary(layerContext), "Ground");
  const mapContext = createMapAiFocusContext({ mapPath: "maps/forest.tmj" });
  assert.equal(mapAiFocusSummary(mapContext), "整张地图");
});
