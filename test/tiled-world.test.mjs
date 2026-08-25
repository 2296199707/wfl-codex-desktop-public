import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  TiledWorldEditDocument,
  adjacentWorldMapIndexes,
  createTiledWorld,
  parseTiledWorld,
  resolveWorldMapReference,
  serializeTiledWorld,
  worldBounds,
  worldMapAtPoint,
  worldMapReference,
  worldMapsAdjacent,
} from "../public/map-editor/tiled-world.js";

const fixtureUrl = new URL("fixtures/tiled/worlds/game.world", import.meta.url);

test("round-trips the Tiled 1.12.2 World fixture without losing unknown fields", async () => {
  const source = await fs.readFile(fixtureUrl, "utf8");
  const parsed = parseTiledWorld(source, { sourcePath: "worlds/game.world" });
  parsed.document.futureWorldField = { retained: true };
  parsed.document.maps[0].futureMapField = "kept";
  const reparsed = parseTiledWorld(serializeTiledWorld(parsed), { sourcePath: "worlds/game.world" });
  assert.deepEqual(reparsed.document.futureWorldField, { retained: true });
  assert.equal(reparsed.document.maps[0].futureMapField, "kept");
  assert.equal(resolveWorldMapReference("worlds/game.world", "../maps/world.tmj"), "maps/world.tmj");
  assert.equal(worldMapReference("worlds/game.world", "maps/world.tmj"), "../maps/world.tmj");
});

test("edits explicit World maps with independent undo and dirty state", async () => {
  const source = await fs.readFile(fixtureUrl, "utf8");
  const editor = new TiledWorldEditDocument(parseTiledWorld(source, {
    sourcePath: "worlds/game.world",
  }).document, { sourcePath: "worlds/game.world" });
  const pattern = structuredClone(editor.document.patterns);
  editor.addMap({ fileName: "../maps/castle.tmj", x: -64, y: 0, width: 64, height: 64 });
  editor.moveMap("../maps/castle.tmj", { x: -32, y: 16 });
  editor.resizeMap("../maps/castle.tmj", { width: 96, height: 80 });
  editor.setOnlyShowAdjacentMaps(false);
  assert.equal(editor.dirty, true);
  assert.equal(editor.document.maps.at(-1).x, -32);
  assert.deepEqual(editor.document.patterns, pattern);
  assert.equal(editor.undo(), true);
  assert.equal(editor.document.onlyShowAdjacentMaps, true);
  assert.equal(editor.redo(), true);
  editor.markSaved();
  assert.equal(editor.dirty, false);
  editor.removeMap("../maps/castle.tmj");
  assert.equal(editor.document.maps.some((entry) => entry.fileName.includes("castle")), false);
});

test("computes World bounds, hit testing, and edge adjacency without loading maps", () => {
  const document = createTiledWorld({ maps: [
    { fileName: "maps/a.tmj", x: -32, y: 0, width: 32, height: 32 },
    { fileName: "maps/b.tmj", x: 0, y: 0, width: 32, height: 32 },
    { fileName: "maps/c.tmj", x: 64, y: 0, width: 32, height: 32 },
  ] });
  assert.deepEqual(worldBounds(document), { x: -32, y: 0, width: 128, height: 32 });
  assert.equal(worldMapAtPoint(document, 4, 4)?.index, 1);
  assert.equal(worldMapsAdjacent(document.maps[0], document.maps[1]), true);
  assert.equal(worldMapsAdjacent(document.maps[1], document.maps[2]), false);
  assert.deepEqual(adjacentWorldMapIndexes(document, 1), [0]);
});

test("computes large World bounds without spreading map arrays into function arguments", () => {
  const maps = Array.from({ length: 20_000 }, (_, index) => ({
    fileName: `maps/map-${index}.tmj`,
    x: index - 10_000,
    y: 10_000 - index,
    width: 2,
    height: 3,
  }));
  assert.deepEqual(worldBounds(createTiledWorld({ maps })), {
    x: -10_000,
    y: -9_999,
    width: 20_001,
    height: 20_002,
  });
});

test("rejects unsafe references, duplicate maps, invalid patterns, and invalid sizes", () => {
  assert.throws(() => parseTiledWorld(JSON.stringify({
    type: "world",
    maps: [{ fileName: "../../outside.tmj", x: 0, y: 0, width: 1, height: 1 }],
  }), { sourcePath: "worlds/game.world" }), /不能离开工程目录/u);
  assert.throws(() => parseTiledWorld(JSON.stringify({
    type: "world",
    maps: [
      { fileName: "../maps/a.tmj", x: 0, y: 0, width: 1, height: 1 },
      { fileName: "../maps/a.tmj", x: 1, y: 0, width: 1, height: 1 },
    ],
    patterns: [{ regexp: "[", multiplierX: 1, multiplierY: 1, offsetX: 0, offsetY: 0, mapWidth: 1, mapHeight: 1 }],
  }), { sourcePath: "worlds/game.world" }), /重复引用|regexp/u);
});
