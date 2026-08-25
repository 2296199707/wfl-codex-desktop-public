import assert from "node:assert/strict";
import test from "node:test";
import { findTiledFillRegion } from "../public/map-editor/tiled-fill.js";

test("finds a bounded finite Flood Fill region while retaining full Tiled GIDs", () => {
  const flipped = 0x8000_0001;
  const result = findTiledFillRegion({
    blocks: [{ x: 0, y: 0, width: 3, height: 2, data: Uint32Array.from([
      flipped, flipped, 0,
      flipped, 0, 0,
    ]) }],
    x: 0,
    y: 0,
    replacement: 7,
    maxCells: 10,
  });
  assert.equal(result.target, flipped);
  assert.equal(result.replacement, 7);
  assert.equal(result.count, 3);
  assert.deepEqual(result.bounds, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  assert.deepEqual(new Set(addressPairs(result.addresses)), new Set(["0:0", "0:1", "0:3"]));
});

test("crosses adjacent infinite-map chunks but never creates cells outside existing chunks", () => {
  const result = findTiledFillRegion({
    blocks: [
      { x: -2, y: 0, width: 2, height: 2, data: Uint32Array.from([1, 1, 0, 1]) },
      { x: 0, y: 0, width: 2, height: 2, data: Uint32Array.from([1, 0, 1, 0]) },
    ],
    x: -1,
    y: 0,
    replacement: 9,
  });
  assert.equal(result.count, 5);
  assert.deepEqual(result.bounds, { minX: -2, minY: 0, maxX: 0, maxY: 1 });
  assert.deepEqual(new Set(addressPairs(result.addresses)), new Set([
    "0:0", "0:1", "0:3", "1:0", "1:2",
  ]));
});

test("returns an empty compact result when the replacement already matches", () => {
  const result = findTiledFillRegion({
    blocks: [{ x: 0, y: 0, width: 1, height: 1, data: Uint32Array.of(2) }],
    x: 0,
    y: 0,
    replacement: 2,
  });
  assert.equal(result.count, 0);
  assert.equal(result.bounds, null);
  assert.equal(result.addresses.length, 0);
});

test("enforces the explicit cell limit and rejects ambiguous overlapping chunks", () => {
  assert.throws(
    () => findTiledFillRegion({
      blocks: [{ x: 0, y: 0, width: 3, height: 1, data: Uint32Array.of(1, 1, 1) }],
      x: 0,
      y: 0,
      replacement: 2,
      maxCells: 2,
    }),
    (error) => error.code === "fill-capacity",
  );
  assert.throws(
    () => findTiledFillRegion({
      blocks: [
        { x: 0, y: 0, width: 2, height: 1, data: Uint32Array.of(1, 1) },
        { x: 1, y: 0, width: 2, height: 1, data: Uint32Array.of(1, 1) },
      ],
      x: 1,
      y: 0,
      replacement: 2,
    }),
    (error) => error.code === "invalid-fill-layer",
  );
});

function addressPairs(addresses) {
  const pairs = [];
  for (let index = 0; index < addresses.length; index += 2) {
    pairs.push(`${addresses[index]}:${addresses[index + 1]}`);
  }
  return pairs;
}
