import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTileRandomSeed,
  normalizeTileStamp,
  paletteTileStamp,
  singleTileStamp,
  tileShapeCells,
  tileStampWrites,
  transformTileStamp,
} from "../public/map-editor/tile-tool-model.js";
import { TILED_FLIP_FLAGS } from "../public/map-editor/tiled-render-model.js";

function palette(localId, overrides = {}) {
  return {
    gid: 101 + localId,
    localId,
    firstgid: 101,
    tileCount: 11,
    columns: 4,
    layoutKind: "atlas",
    tilesetKey: "tiles/terrain.tsj#101",
    ...overrides,
  };
}

test("creates rectangular multi-cell stamps from one atlas without crossing its partial last row", () => {
  const stamp = paletteTileStamp(palette(1), palette(10));
  assert.deepEqual(stamp, {
    width: 2,
    height: 3,
    cells: [
      { x: 0, y: 0, gid: 102 },
      { x: 1, y: 0, gid: 103 },
      { x: 0, y: 1, gid: 106 },
      { x: 1, y: 1, gid: 107 },
      { x: 0, y: 2, gid: 110 },
      { x: 1, y: 2, gid: 111 },
    ],
  });
  assert.throws(
    () => paletteTileStamp(palette(0), palette(4, { tilesetKey: "tiles/props.tsj#201", firstgid: 201, gid: 205 })),
    (error) => error.code === "stamp-cross-tileset",
  );
  assert.throws(
    () => paletteTileStamp(
      palette(0, { layoutKind: "collection", columns: 0 }),
      palette(1, { layoutKind: "collection", columns: 0 }),
    ),
    (error) => error.code === "stamp-collection-grid",
  );
});

test("keeps empty cells in a stamp when an atlas selection includes unused slots", () => {
  const stamp = paletteTileStamp(palette(7), palette(10));
  assert.deepEqual(stamp.cells.map(({ gid }) => gid), [107, 108, 111, 0]);
});

test("rasterizes lines and outline or filled rectangles deterministically", () => {
  assert.deepEqual(tileShapeCells("line", { x: 0, y: 0 }, { x: 3, y: 2 }), [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 2 },
  ]);
  assert.equal(tileShapeCells("rectangle", { x: 0, y: 0 }, { x: 3, y: 2 }).length, 10);
  assert.equal(tileShapeCells("rectangle", { x: 0, y: 0 }, { x: 3, y: 2 }, { filled: true }).length, 12);
});

test("rasterizes outlined and filled ellipses inside their requested grid bounds", () => {
  const outline = tileShapeCells("ellipse", { x: -2, y: 3 }, { x: 3, y: 8 });
  const filled = tileShapeCells("ellipse", { x: -2, y: 3 }, { x: 3, y: 8 }, { filled: true });
  assert.ok(outline.length > 0);
  assert.ok(filled.length > outline.length);
  assert.ok([...outline, ...filled].every(({ x, y }) => x >= -2 && x <= 3 && y >= 3 && y <= 8));
  assert.deepEqual(tileShapeCells("ellipse", { x: 4, y: 4 }, { x: 4, y: 4 }), [{ x: 4, y: 4 }]);
});

test("applies a complete stamp at shape anchors, deduplicates overlap, and supports erasing", () => {
  const stamp = normalizeTileStamp({
    width: 2,
    height: 1,
    cells: [{ x: 0, y: 0, gid: 7 }, { x: 1, y: 0, gid: 8 }],
  });
  assert.deepEqual(tileStampWrites(stamp, [{ x: 2, y: 3 }, { x: 3, y: 3 }]), [
    { x: 2, y: 3, gid: 7 },
    { x: 3, y: 3, gid: 7 },
    { x: 4, y: 3, gid: 8 },
  ]);
  assert.deepEqual(tileStampWrites(singleTileStamp(9), [{ x: -1, y: -2 }], { erase: true }), [
    { x: -1, y: -2, gid: 0 },
  ]);
});

test("flips and rotates complete stamps while composing Tiled GID transforms", () => {
  const stamp = normalizeTileStamp({
    width: 2,
    height: 2,
    cells: [
      { x: 0, y: 0, gid: 1 },
      { x: 1, y: 0, gid: 2 },
      { x: 0, y: 1, gid: 3 },
      { x: 1, y: 1, gid: 4 },
    ],
  });
  const horizontal = transformTileStamp(stamp, "flip-horizontal");
  assert.deepEqual(horizontal.cells.map(({ gid }) => gid), [
    (2 | TILED_FLIP_FLAGS.horizontal) >>> 0,
    (1 | TILED_FLIP_FLAGS.horizontal) >>> 0,
    (4 | TILED_FLIP_FLAGS.horizontal) >>> 0,
    (3 | TILED_FLIP_FLAGS.horizontal) >>> 0,
  ]);
  assert.deepEqual(
    transformTileStamp(horizontal, "flip-horizontal").cells.map(({ gid }) => gid),
    [1, 2, 3, 4],
  );

  const clockwise = transformTileStamp(stamp, "rotate-clockwise");
  const clockwiseFlags = (TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0;
  assert.deepEqual(clockwise.cells.map(({ gid }) => gid), [
    (3 | clockwiseFlags) >>> 0,
    (1 | clockwiseFlags) >>> 0,
    (4 | clockwiseFlags) >>> 0,
    (2 | clockwiseFlags) >>> 0,
  ]);
  assert.deepEqual(
    transformTileStamp(clockwise, "rotate-counterclockwise").cells.map(({ gid }) => gid),
    [1, 2, 3, 4],
  );
  assert.deepEqual(transformTileStamp(stamp, "flip-diagonal").cells.map(({ gid }) => gid), [
    (1 | TILED_FLIP_FLAGS.diagonal) >>> 0,
    (3 | TILED_FLIP_FLAGS.diagonal) >>> 0,
    (2 | TILED_FLIP_FLAGS.diagonal) >>> 0,
    (4 | TILED_FLIP_FLAGS.diagonal) >>> 0,
  ]);
});

test("swaps non-square stamp dimensions and restricts unsupported hexagonal transforms", () => {
  const stamp = normalizeTileStamp({
    width: 2,
    height: 1,
    cells: [{ x: 0, y: 0, gid: 7 }, { x: 1, y: 0, gid: 8 }],
  });
  assert.deepEqual(
    transformTileStamp(stamp, "rotate-clockwise"),
    normalizeTileStamp({
      width: 1,
      height: 2,
      cells: [
        { x: 0, y: 0, gid: (7 | TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0 },
        { x: 0, y: 1, gid: (8 | TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0 },
      ],
    }),
  );
  assert.doesNotThrow(() => transformTileStamp(stamp, "flip-horizontal", { hexagonal: true }));
  assert.throws(
    () => transformTileStamp(stamp, "rotate-clockwise", { hexagonal: true }),
    (error) => error.code === "hex-stamp-transform-unsupported",
  );
});

test("uses a coordinate-stable seed and tile probability for random stamp writes", () => {
  const stamp = normalizeTileStamp({
    width: 3,
    height: 1,
    cells: [
      { x: 0, y: 0, gid: 11 },
      { x: 1, y: 0, gid: 12 },
      { x: 2, y: 0, gid: 13 },
    ],
  });
  const anchors = Array.from({ length: 24 }, (_, x) => ({ x, y: x % 3 }));
  const first = tileStampWrites(stamp, anchors, { random: true, seed: 0xdecafbad });
  const second = tileStampWrites(stamp, [...anchors].reverse(), { random: true, seed: 0xdecafbad });
  const byPosition = (writes) => Object.fromEntries(writes.map(({ x, y, gid }) => [`${x},${y}`, gid]));
  assert.deepEqual(byPosition(first), byPosition(second));
  assert.ok(new Set(first.map(({ gid }) => gid)).size > 1);
  assert.ok(first.every(({ x, y }) => y === x % 3));
  assert.deepEqual(
    new Set(tileStampWrites(stamp, anchors, {
      random: true,
      seed: 42,
      weights: { 11: 0, 12: 5, 13: 0 },
    }).map(({ gid }) => gid)),
    new Set([12]),
  );
  assert.equal(normalizeTileRandomSeed(0xffff_ffff), 0xffff_ffff);
  assert.throws(() => normalizeTileRandomSeed(-1), (error) => error.code === "invalid-random-seed");
});
