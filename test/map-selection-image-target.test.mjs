import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_SELECTION_IMAGE_TARGET_SCHEMA,
  createMapSelectionImageTarget,
  parseMapSelectionImageTarget,
} from "../public/map-editor/map-selection-image-target.js";

const VERSION = "a".repeat(64);

function orthogonalMap() {
  return {
    type: "map",
    orientation: "orthogonal",
    infinite: false,
    width: 20,
    height: 12,
    tilewidth: 32,
    tileheight: 16,
    tilesets: [],
    layers: [{
      id: 1,
      name: "World",
      type: "group",
      x: 4,
      y: 5,
      offsetx: 3,
      offsety: 2,
      layers: [{
        id: 2,
        name: "Ground",
        type: "tilelayer",
        x: 2,
        y: 1,
        offsetx: 5,
        offsety: 7,
        width: 20,
        height: 12,
        data: Array(240).fill(0),
      }],
    }],
  };
}

test("normalizes a snapped tile selection and derives a logical outpaint canvas", () => {
  const target = createMapSelectionImageTarget({
    document: orthogonalMap(),
    layerId: 2,
    mapVersion: VERSION,
    editorStateId: 7,
    purpose: "layer-image",
    selection: {
      startColumn: 4, endColumn: 2, startRow: 3, endRow: 2,
      x: 140, y: 62, width: 96, height: 32,
    },
    expansion: { unit: "tile", top: 1, right: 2, bottom: 1, left: 1 },
    maskMode: "soft",
    preserveSource: "seamless",
  });

  assert.equal(target.schema, MAP_SELECTION_IMAGE_TARGET_SCHEMA);
  assert.deepEqual(target.layer, { id: 2, type: "tilelayer", name: "Ground", path: [1, 2] });
  assert.deepEqual(target.selection.tile, {
    space: "layer", x: 2, y: 2, width: 3, height: 2,
    startColumn: 2, endColumn: 4, startRow: 2, endRow: 3,
  });
  assert.deepEqual(target.selection.mapTile, {
    space: "map", x: 4, y: 3, width: 3, height: 2,
    startColumn: 4, endColumn: 6, startRow: 3, endRow: 4,
  });
  assert.deepEqual(target.selection.world, { x: 140, y: 62, width: 96, height: 32 });
  assert.deepEqual(target.expansion.tile, { top: 1, right: 2, bottom: 1, left: 1 });
  assert.deepEqual(target.expansion.world, { top: 16, right: 64, bottom: 16, left: 32 });
  assert.deepEqual(target.target.world, { x: 108, y: 46, width: 192, height: 64 });
  assert.deepEqual(target.target.mapTile, {
    space: "map", x: 3, y: 2, width: 6, height: 4,
    startColumn: 3, endColumn: 8, startRow: 2, endRow: 5,
  });
  assert.deepEqual(target.target.sourceOffset, { x: 32, y: 16 });
  assert.deepEqual(target.logicalCanvas, { width: 192, height: 64 });
  assert.deepEqual(target.policies, { maskMode: "soft", preserveSource: "seamless" });
  assert.equal(Object.isFrozen(target.selection.tile), true);
});

test("uses outward integer world bounds for projected maps", () => {
  const document = {
    type: "map",
    orientation: "isometric",
    infinite: true,
    width: 10,
    height: 8,
    tilewidth: 64,
    tileheight: 32,
    tilesets: [],
    layers: [{ id: 9, name: "Iso", type: "tilelayer", chunks: [], offsetx: 0.5 }],
  };
  const target = createMapSelectionImageTarget({
    document,
    layerId: 9,
    mapVersion: VERSION,
    purpose: "tileset",
    selection: { x: -1, y: 2, width: 2, height: 3 },
    expansion: { unit: "tile", left: 1 },
  });

  assert.deepEqual(target.selection.world, { x: 64, y: 16, width: 161, height: 80 });
  assert.deepEqual(target.target.tile, {
    space: "layer", x: -2, y: 2, width: 3, height: 3,
    startColumn: -2, endColumn: 0, startRow: 2, endRow: 4,
  });
  assert.equal(target.logicalCanvas.width, target.target.world.width);
  assert.equal(target.logicalCanvas.height, target.target.world.height);
});

test("supports pixel-side expansion while keeping the source tile range", () => {
  const target = createMapSelectionImageTarget({
    document: orthogonalMap(),
    layerId: 2,
    mapVersion: VERSION,
    purpose: "prop",
    selection: { x: 2, y: 2, width: 1, height: 1 },
    expansion: { unit: "world", top: 12, right: 24, bottom: 4, left: 8 },
  });
  assert.equal(target.target.tile, null);
  assert.equal(target.target.mapTile, null);
  assert.deepEqual(target.expansion.tile, null);
  assert.deepEqual(target.expansion.world, { top: 12, right: 24, bottom: 4, left: 8 });
  assert.deepEqual(target.target.sourceOffset, { x: 8, y: 12 });
  assert.deepEqual(target.logicalCanvas, { width: 64, height: 32 });
});

test("rebuilds serialized targets from authoritative Tiled coordinates", () => {
  const original = createMapSelectionImageTarget({
    document: orthogonalMap(),
    layerId: 2,
    mapVersion: VERSION,
    editorStateId: 3,
    selection: { x: 1, y: 1, width: 2, height: 2 },
    expansion: { unit: "world", right: 10 },
  });
  const untrusted = structuredClone(original);
  untrusted.target.world.x = 999_999;
  untrusted.logicalCanvas.width = 1;
  const parsed = parseMapSelectionImageTarget(untrusted, {
    document: orthogonalMap(),
    currentMapVersion: VERSION,
    currentEditorStateId: 3,
  });
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed.target.world.x, 999_999);
});

test("rejects stale file or editor versions", () => {
  const input = {
    document: orthogonalMap(),
    layerId: 2,
    mapVersion: VERSION,
    selection: { x: 1, y: 1, width: 1, height: 1 },
  };
  assert.throws(
    () => createMapSelectionImageTarget({ ...input, expectedMapVersion: "b".repeat(64) }),
    (error) => error.code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT" && error.statusCode === 409,
  );
  const target = createMapSelectionImageTarget({ ...input, editorStateId: 4 });
  assert.throws(
    () => parseMapSelectionImageTarget(target, {
      document: orthogonalMap(),
      currentMapVersion: VERSION,
      currentEditorStateId: 5,
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT",
  );
});

test("rejects out-of-layer selections and inconsistent world coordinates", () => {
  const input = { document: orthogonalMap(), layerId: 2, mapVersion: VERSION };
  assert.throws(
    () => createMapSelectionImageTarget({ ...input, selection: { x: 19, y: 0, width: 2, height: 1 } }),
    (error) => error.code === "MAP_IMAGE_SELECTION_OUT_OF_RANGE",
  );
  assert.throws(
    () => createMapSelectionImageTarget({
      ...input,
      selection: {
        startColumn: 1, endColumn: 1, startRow: 1, endRow: 1,
        x: 0, y: 0, width: 32, height: 16,
      },
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_COORDINATE_MISMATCH",
  );
});

test("applies only explicit administrator size limits", () => {
  const input = {
    document: orthogonalMap(),
    layerId: 2,
    mapVersion: VERSION,
    selection: { x: 0, y: 0, width: 3, height: 2 },
  };
  assert.doesNotThrow(() => createMapSelectionImageTarget(input));
  assert.throws(
    () => createMapSelectionImageTarget({ ...input, limits: { maxWorldWidth: 95 } }),
    (error) => error.code === "MAP_IMAGE_SELECTION_SIZE_LIMIT",
  );
  assert.throws(
    () => createMapSelectionImageTarget({ ...input, limits: { maxWorldPixels: 3_000 } }),
    (error) => error.code === "MAP_IMAGE_SELECTION_SIZE_LIMIT",
  );
});

test("rejects invalid purpose, policies, expansion, layer, and map versions", () => {
  const input = {
    document: orthogonalMap(), layerId: 2, mapVersion: VERSION,
    selection: { x: 1, y: 1, width: 1, height: 1 },
  };
  for (const patch of [
    { purpose: "background" },
    { maskMode: "automatic" },
    { preserveSource: "maybe" },
    { expansion: { unit: "tile", left: -1 } },
    { expansion: { unit: "meters" } },
    { layerId: 999 },
    { mapVersion: "not-a-hash" },
  ]) {
    assert.throws(() => createMapSelectionImageTarget({ ...input, ...patch }), MapSelectionImageTargetErrorLike);
  }
});

test("does not silently reinterpret an invalid serialized expansion unit", () => {
  const target = structuredClone(createMapSelectionImageTarget({
    document: orthogonalMap(),
    layerId: 2,
    mapVersion: VERSION,
    selection: { x: 1, y: 1, width: 1, height: 1 },
  }));
  target.expansion.unit = "automatic";
  assert.throws(
    () => parseMapSelectionImageTarget(target, {
      document: orthogonalMap(),
      currentMapVersion: VERSION,
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_EXPANSION_INVALID",
  );
});

function MapSelectionImageTargetErrorLike(error) {
  return error?.name === "MapSelectionImageTargetError" && /^MAP_IMAGE_SELECTION_/u.test(error.code);
}
