import assert from "node:assert/strict";
import test from "node:test";
import {
  planTiledTilesetReuse,
  remapGlobalTileId,
} from "../public/map-editor/tiled-gid-reuse.js";
import { TILED_FLIP_FLAGS } from "../public/map-editor/tiled-render-model.js";

const sourceTilesets = [
  { firstgid: 1, maxLocalId: 3, ownerPath: "tiles/terrain.tsj" },
  { firstgid: 20, maxLocalId: 1, ownerPath: "tiles/props.tsj" },
];

test("reuses matching TSJ firstgid and allocates only missing ranges", () => {
  const plan = planTiledTilesetReuse({
    sourceMapPath: "maps/source.tmj",
    targetMapPath: "maps/target.tmj",
    sourceTilesets,
    targetTilesets: [{ firstgid: 10, maxLocalId: 3, ownerPath: "tiles/terrain.tsj" }],
  });
  assert.deepEqual(plan.reused, [{ sourcePath: "tiles/terrain.tsj", firstgid: 10, maxLocalId: 3 }]);
  assert.deepEqual(plan.additions, [{
    reference: { firstgid: 14, source: "../tiles/props.tsj" },
    sourcePath: "tiles/props.tsj",
    requiresResourceCopy: false,
  }]);
  assert.deepEqual(plan.dependencyPaths, ["tiles/terrain.tsj", "tiles/props.tsj"]);
  assert.equal(plan.remapGlobalTileId(1), 10);
  assert.equal(plan.remapGlobalTileId(20), 14);
});

test("preserves Tiled flip flags while remapping a stamp and leaves empty cells empty", () => {
  const plan = planTiledTilesetReuse({
    sourceMapPath: "maps/source.tmj",
    targetMapPath: "maps/target.tmj",
    sourceTilesets,
    targetTilesets: [],
  });
  const encoded = (20 | TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0;
  assert.equal(plan.remapGlobalTileId(encoded), (5 | TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0);
  assert.deepEqual(plan.remapTileStamp({
    width: 2,
    height: 1,
    cells: [{ x: 0, y: 0, gid: 0 }, { x: 1, y: 0, gid: encoded }],
  }).cells.map((cell) => cell.gid), [0, (5 | TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0]);
});

test("rejects a target TSJ whose local ID range cannot represent the source", () => {
  assert.throws(
    () => planTiledTilesetReuse({
      sourceMapPath: "maps/source.tmj",
      targetMapPath: "maps/target.tmj",
      sourceTilesets: [{ firstgid: 1, maxLocalId: 7, ownerPath: "tiles/terrain.tsj" }],
      targetTilesets: [{ firstgid: 10, maxLocalId: 3, ownerPath: "tiles/terrain.tsj" }],
    }),
    (error) => error.code === "TILED_GID_LAYOUT_MISMATCH",
  );
});

test("does not silently pass through an unmapped non-empty GID", () => {
  assert.throws(
    () => remapGlobalTileId(99, [{ sourceFirstgid: 1, targetFirstgid: 4, maxLocalId: 2 }]),
    (error) => error.code === "TILED_GID_UNMAPPED",
  );
  assert.equal(remapGlobalTileId(99, [], { allowUnmapped: true }), 99);
});

test("reuses a tile-template TSJ and converts its local GID to the map range", () => {
  const plan = planTiledTilesetReuse({
    sourceMapPath: "templates/props/tree.tx",
    targetMapPath: "maps/target.tmj",
    sourceTilesets: [{
      firstgid: 1,
      maxLocalId: 31,
      sourcePath: "tiles/forest.tsj",
    }],
    targetTilesets: [{
      firstgid: 100,
      maxLocalId: 31,
      sourcePath: "tiles/forest.tsj",
    }],
  });
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.remapGlobalTileId((0x4000_0000 | 7) >>> 0), (0x4000_0000 | 106) >>> 0);
});
