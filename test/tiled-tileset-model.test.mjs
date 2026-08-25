import assert from "node:assert/strict";
import test from "node:test";
import {
  TILED_MAX_GLOBAL_ID,
  TiledTilesetError,
  nextTiledTilesetFirstGid,
  tiledTilesetLayout,
  validateTiledImageSize,
  validateTiledTilesetRanges,
} from "../public/map-editor/tiled-tileset-model.js";

function atlas(overrides = {}) {
  return {
    type: "tileset",
    name: "Terrain",
    image: "terrain.png",
    imagewidth: 35,
    imageheight: 35,
    tilewidth: 16,
    tileheight: 16,
    margin: 1,
    spacing: 1,
    columns: 2,
    tilecount: 3,
    tiles: [{ id: 2 }],
    ...overrides,
  };
}

function assertCode(operation, code) {
  assert.throws(operation, (error) => error instanceof TiledTilesetError && error.code === code);
}

test("derives atlas capacity from the decoded image without allocating declared overflow", () => {
  const layout = tiledTilesetLayout(atlas(), { image: { width: 35, height: 35 } });
  assert.deepEqual({
    kind: layout.kind,
    columns: layout.columns,
    rows: layout.rows,
    capacity: layout.capacity,
    tileCount: layout.tileCount,
    maxLocalId: layout.maxLocalId,
  }, {
    kind: "atlas",
    columns: 2,
    rows: 2,
    capacity: 4,
    tileCount: 3,
    maxLocalId: 2,
  });
  assert.deepEqual([...layout.explicitIds], [2]);

  assertCode(
    () => tiledTilesetLayout(atlas({ tilecount: 50_000_000 }), { image: { width: 35, height: 35 } }),
    "tileset-tilecount-overflow",
  );
  assertCode(
    () => tiledTilesetLayout(atlas({ columns: 1 }), { image: { width: 35, height: 35 } }),
    "tileset-columns-mismatch",
  );
  assertCode(
    () => tiledTilesetLayout(atlas({ imagewidth: 34 }), { image: { width: 35, height: 35 } }),
    "image-width-mismatch",
  );
  assertCode(
    () => tiledTilesetLayout(atlas({ tiles: [{ id: 3 }] }), { image: { width: 35, height: 35 } }),
    "tile-id-outside-atlas",
  );
  assertCode(
    () => tiledTilesetLayout(atlas({ tiles: [{ id: 2, probability: -0.5 }] }), { image: { width: 35, height: 35 } }),
    "invalid-tile-probability",
  );
  assertCode(
    () => tiledTilesetLayout(atlas({ tiles: [{ id: 2, probability: "0.5" }] }), { image: { width: 35, height: 35 } }),
    "invalid-tile-probability",
  );
});

test("accepts sparse image collections while rejecting invalid and duplicate tile IDs", () => {
  const layout = tiledTilesetLayout({
    type: "tileset",
    name: "Props",
    columns: 0,
    tilecount: 5,
    tilewidth: 32,
    tileheight: 48,
    tiles: [{ id: 0, image: "tree.png" }, { id: 4, image: "gate.png" }],
  });
  assert.equal(layout.kind, "collection");
  assert.equal(layout.tileCount, 5);
  assert.equal(layout.maxLocalId, 4);
  assert.deepEqual([...layout.explicitIds], [0, 4]);

  assertCode(
    () => tiledTilesetLayout({
      tilewidth: 16,
      tileheight: 16,
      tiles: [{ id: 1 }, { id: 1 }],
    }),
    "duplicate-tile-id",
  );
  assertCode(
    () => tiledTilesetLayout({ tilewidth: 16, tileheight: 16, tiles: [{ id: -1 }] }),
    "invalid-integer",
  );
  assertCode(
    () => tiledTilesetLayout({ tilewidth: 16, tileheight: 16, tilecount: 1, tiles: [{ id: 0 }, { id: 4 }] }),
    "collection-tilecount-mismatch",
  );
});

test("compares per-tile declared dimensions with decoded image dimensions", () => {
  assert.deepEqual(
    validateTiledImageSize({ imagewidth: 64, imageheight: 48 }, { width: 64, height: 48 }),
    { width: 64, height: 48 },
  );
  assertCode(
    () => validateTiledImageSize({ imageheight: 47 }, { width: 64, height: 48 }),
    "image-height-mismatch",
  );
});

test("sorts non-overlapping GID ranges and keeps them below Tiled flip flags", () => {
  const ranges = validateTiledTilesetRanges([
    { firstgid: 10, maxLocalId: 4, definition: { name: "Second" } },
    { firstgid: 1, maxLocalId: 3, definition: { name: "First" } },
  ]);
  assert.deepEqual(ranges.map(({ firstgid, lastgid }) => [firstgid, lastgid]), [[1, 4], [10, 14]]);

  assertCode(
    () => validateTiledTilesetRanges([
      { firstgid: 1, maxLocalId: 3 },
      { firstgid: 4, maxLocalId: 1 },
    ]),
    "tileset-gid-overlap",
  );
  assertCode(
    () => validateTiledTilesetRanges([
      { firstgid: 5, maxLocalId: -1, ownerPath: "empty-a.tsj" },
      { firstgid: 5, maxLocalId: -1, ownerPath: "empty-b.tsj" },
    ]),
    "duplicate-firstgid",
  );
  assert.equal(
    validateTiledTilesetRanges([{ firstgid: TILED_MAX_GLOBAL_ID, maxLocalId: 0 }])[0].lastgid,
    TILED_MAX_GLOBAL_ID,
  );
  assertCode(
    () => validateTiledTilesetRanges([{ firstgid: TILED_MAX_GLOBAL_ID, maxLocalId: 1 }]),
    "tileset-gid-flags-overlap",
  );
});

test("allocates a new GID range after existing tilesets without renumbering them", () => {
  const existing = [
    { firstgid: 1, maxLocalId: 3, definition: { name: "Terrain" } },
    { firstgid: 20, maxLocalId: 4, definition: { name: "Props" } },
  ];
  assert.equal(nextTiledTilesetFirstGid(existing, 9), 25);
  assert.equal(nextTiledTilesetFirstGid([], 0), 1);
  assert.equal(
    nextTiledTilesetFirstGid([{ firstgid: 1, maxLocalId: -1 }], 0),
    2,
  );
  assertCode(
    () => nextTiledTilesetFirstGid([
      { firstgid: TILED_MAX_GLOBAL_ID, maxLocalId: 0 },
    ], 0),
    "tileset-gid-space-exhausted",
  );
});
