import assert from "node:assert/strict";
import test from "node:test";
import {
  combineTileSelections,
  contiguousTileSelection,
  matchingTileSelection,
  rectangularTileSelection,
  tileSelectionBounds,
} from "../public/map-editor/tile-selection-model.js";

test("creates stable inclusive rectangular tile selections", () => {
  const cells = rectangularTileSelection({ x: 2, y: 3 }, { x: 0, y: 1 });
  assert.equal(cells.length, 9);
  assert.deepEqual(cells[0], { x: 0, y: 1 });
  assert.deepEqual(cells.at(-1), { x: 2, y: 3 });
  assert.deepEqual(tileSelectionBounds(cells), {
    startColumn: 0,
    endColumn: 2,
    startRow: 1,
    endRow: 3,
    width: 3,
    height: 3,
  });
});

test("selects one four-connected tile region while ignoring Tiled flip flags by default", () => {
  const horizontal = 0x8000_0000;
  const values = [
    1, (1 | horizontal) >>> 0, 0, 1,
    1, 2, 0, 1,
    0, 2, 2, 1,
  ];
  const read = (x, y) => (
    x < 0 || y < 0 || x >= 4 || y >= 3 ? null : values[y * 4 + x]
  );
  assert.deepEqual(contiguousTileSelection({ x: 0, y: 0 }, read), [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]);
  assert.deepEqual(contiguousTileSelection({ x: 0, y: 0 }, read, { baseGidOnly: false }), [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
  ]);
});

test("selects every matching tile from finite or chunk-derived iterable entries", () => {
  const cells = matchingTileSelection([
    { x: -1, y: 0, gid: 7 },
    { x: 0, y: 0, gid: 8 },
    { x: 1, y: 0, gid: 0x4000_0007 },
    { x: 2, y: 0, gid: 7 },
  ], 7);
  assert.deepEqual(cells, [
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ]);
});

test("combines tile selections through replace, add, subtract, and intersection", () => {
  const current = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const incoming = [{ x: 1, y: 0 }, { x: 2, y: 0 }];
  assert.deepEqual(combineTileSelections(current, incoming, "replace"), incoming);
  assert.deepEqual(combineTileSelections(current, incoming, "add"), [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
  ]);
  assert.deepEqual(combineTileSelections(current, incoming, "subtract"), [{ x: 0, y: 0 }]);
  assert.deepEqual(combineTileSelections(current, incoming, "intersect"), [{ x: 1, y: 0 }]);
  assert.equal(tileSelectionBounds([]), null);
});
