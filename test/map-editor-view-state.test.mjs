import assert from "node:assert/strict";
import test from "node:test";
import {
  createMapEditorViewState,
  mapEditorViewStorageKey,
  parseMapEditorViewState,
} from "../public/map-editor/map-editor-view-state.js";

test("stores bounded map view state under an account and map scoped key", () => {
  const key = mapEditorViewStorageKey({
    accountId: "account-1",
    projectPath: "/srv/projects/game one",
    relativePath: "maps/world.tmj",
  });
  assert.match(key, /^wfl-map-editor-view-v1:account-1:/u);
  assert.match(key, /game%20one/u);
  const view = createMapEditorViewState({
    scale: 2.5,
    offsetX: 120,
    offsetY: -44,
    activeLayerId: 7,
    detailTab: "tiles",
    activeTool: "brush",
    gridVisible: false,
    layerPanelOpen: true,
    guidesVisible: true,
    guideUnit: "tile",
    guides: [{
      id: "guide-1",
      orientation: "vertical",
      position: 48,
      unit: "tile",
      locked: true,
      visible: true,
    }],
    imageSnapEnabled: true,
    imageSnapUnit: "tile",
    imageSnapStep: 2,
    tileRandomEnabled: true,
    tileRandomSeed: 42,
    tileSelectionMode: "subtract",
    autoMapWhileDrawing: true,
    autoMapSeed: 99,
  }, 5_000);
  assert.deepEqual(parseMapEditorViewState(view), view);
});

test("migrates version one view state without inventing map document fields", () => {
  const migrated = parseMapEditorViewState({
    version: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    activeLayerId: null,
    detailTab: "properties",
    activeTool: "select",
    gridVisible: true,
    layerPanelOpen: false,
    updatedAt: 100,
  });
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.guides, []);
  assert.equal(migrated.imageSnapEnabled, false);
  assert.equal(migrated.tileRandomEnabled, false);
  assert.equal(migrated.tileRandomSeed, 1);
  assert.equal(migrated.tileSelectionMode, "replace");
  assert.equal(migrated.autoMapWhileDrawing, false);
  assert.equal(migrated.autoMapSeed, 1);
});

test("restores stage 6 tile tools without changing the view-state format", () => {
  for (const activeTool of ["tile-select", "sample", "tile-line", "tile-rectangle", "tile-ellipse", "tile-magic", "tile-same", "vertex"]) {
    const view = createMapEditorViewState({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      activeTool,
    }, 200);
    assert.equal(parseMapEditorViewState(view).activeTool, activeTool);
    assert.equal(view.version, 3);
  }
});

test("rejects cross-scope paths and corrupt or unbounded local state", () => {
  assert.throws(() => mapEditorViewStorageKey({
    accountId: "account-1",
    projectPath: "/srv/projects/game",
    relativePath: "../other.tmj",
  }));
  assert.equal(parseMapEditorViewState({
    version: 1,
    scale: 99,
    offsetX: 0,
    offsetY: 0,
    updatedAt: 1,
  }), null);
  assert.equal(parseMapEditorViewState({ version: 4 }), null);
});
