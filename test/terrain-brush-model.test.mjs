import assert from "node:assert/strict";
import test from "node:test";
import { planTerrainBrush } from "../public/map-editor/terrain-brush-model.js";
import { decodeGlobalTileId } from "../public/map-editor/tiled-render-model.js";

const edgeCandidates = [
  { gid: 10, wangid: [0, 1, 0, 1, 0, 1, 0, 1], probability: 1 },
  { gid: 11, wangid: [0, 0, 0, 0, 0, 1, 0, 0], probability: 1 },
  { gid: 12, wangid: [0, 0, 0, 0, 0, 0, 0, 1], probability: 1 },
  { gid: 13, wangid: [0, 1, 0, 0, 0, 0, 0, 0], probability: 1 },
  { gid: 14, wangid: [0, 0, 0, 1, 0, 0, 0, 0], probability: 1 },
];

test("plans an exact edge Terrain stroke across the center and four shared neighbors", () => {
  const result = planTerrainBrush({
    point: { x: 4, y: 7 },
    color: 1,
    type: "edge",
    candidates: edgeCandidates,
    readGid: () => 0,
    wangIdForGid: () => null,
    seed: 77,
  });
  assert.equal(result.affected, 5);
  assert.equal(result.approximate, 0);
  assert.deepEqual(result.writes.map(({ x, y, gid }) => ({ x, y, gid })), [
    { x: 4, y: 6, gid: 11 },
    { x: 3, y: 7, gid: 14 },
    { x: 4, y: 7, gid: 10 },
    { x: 5, y: 7, gid: 12 },
    { x: 4, y: 8, gid: 13 },
  ]);
});

test("clears existing Terrain cells without erasing unrelated neighbor tiles", () => {
  const cells = new Map([
    ["4,6", 11], ["3,7", 14], ["4,7", 10], ["5,7", 12], ["4,8", 13],
    ["3,6", 999],
  ]);
  const byGid = new Map(edgeCandidates.map((candidate) => [candidate.gid, candidate.wangid]));
  const result = planTerrainBrush({
    point: { x: 4, y: 7 },
    color: 0,
    type: "edge",
    candidates: edgeCandidates,
    readGid: (x, y) => cells.get(`${x},${y}`) || 0,
    wangIdForGid: (encoded) => byGid.get(decodeGlobalTileId(encoded).gid) || null,
    seed: 77,
  });
  assert.deepEqual(result.writes.map(({ x, y, gid }) => ({ x, y, gid })), [
    { x: 4, y: 6, gid: 0 },
    { x: 3, y: 7, gid: 0 },
    { x: 4, y: 7, gid: 0 },
    { x: 5, y: 7, gid: 0 },
    { x: 4, y: 8, gid: 0 },
  ]);
  assert.equal(cells.get("3,6"), 999);
});

test("reports nearest-match writes and keeps weighted selection deterministic per seed and coordinate", () => {
  const candidates = [
    { gid: 20, wangid: [0, 1, 0, 1, 0, 1, 0, 1], probability: 1 },
    { gid: 21, wangid: [0, 1, 0, 1, 0, 1, 0, 1], probability: 3 },
  ];
  const options = {
    point: { x: -2, y: 5 },
    color: 1,
    type: "edge",
    candidates,
    readGid: () => 0,
    wangIdForGid: () => null,
    seed: 1234,
  };
  const first = planTerrainBrush(options);
  const second = planTerrainBrush(options);
  assert.deepEqual(first, second);
  assert.equal(first.approximate, 4);
  assert.ok([20, 21].includes(first.writes.find(({ x, y }) => x === -2 && y === 5).gid));
});

test("rejects malformed Terrain candidates, disallowed positions, and automatic invalid seeds", () => {
  assert.throws(
    () => planTerrainBrush({ point: { x: 0, y: 0 }, color: 1, type: "edge", candidates: [{ gid: 1, wangid: [1, 0, 0, 0, 0, 0, 0, 0] }], readGid: () => 0 }),
    (error) => error.code === "terrain-type-conflict",
  );
  assert.throws(
    () => planTerrainBrush({ point: { x: 0, y: 0 }, color: 1, type: "mixed", candidates: [], readGid: () => 0 }),
    (error) => error.code === "terrain-candidates-empty",
  );
  assert.throws(
    () => planTerrainBrush({ point: { x: 0, y: 0 }, color: 1, type: "mixed", candidates: [{ gid: 1, wangid: Array(8).fill(1) }], readGid: () => 0, seed: -1 }),
    (error) => error.code === "invalid-terrain-seed",
  );
});
