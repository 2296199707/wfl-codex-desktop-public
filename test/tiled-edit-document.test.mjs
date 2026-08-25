import assert from "node:assert/strict";
import test from "node:test";
import { TiledEditDocument, TiledEditError } from "../public/map-editor/tiled-edit-document.js";

function finiteMap() {
  return {
    type: "map",
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    nextobjectid: 2,
    layers: [
      { id: 1, name: "Ground", type: "tilelayer", width: 3, height: 2, data: [0, 0, 0, 0, 0, 0], unknownLayer: { keep: true } },
      { id: 2, name: "Objects", type: "objectgroup", objects: [{ id: 1, name: "Start", point: true, x: 0, y: 0 }] },
    ],
    tilesets: [],
    unknownRoot: { keep: [1, 2, 3] },
  };
}

test("commits one structured history entry per tile stroke", () => {
  const editor = new TiledEditDocument(finiteMap());
  const stroke = editor.beginTileStroke(1, { kind: "brush" });
  stroke.set(0, 0, 1);
  stroke.set(1, 0, 2);
  stroke.set(0, 0, 2);
  assert.equal(stroke.commit(), true);
  assert.deepEqual(editor.layerById(1).data, [2, 2, 0, 0, 0, 0]);
  assert.equal(editor.undoStack.length, 1);
  assert.deepEqual(editor.undoStack[0].changes, [
    { x: 0, y: 0, before: 0, after: 2 },
    { x: 1, y: 0, before: 0, after: 2 },
  ]);
  assert.equal(editor.dirty, true);

  assert.equal(editor.undo(), true);
  assert.deepEqual(editor.layerById(1).data, [0, 0, 0, 0, 0, 0]);
  assert.equal(editor.dirty, false);
  assert.equal(editor.redo(), true);
  assert.deepEqual(editor.layerById(1).data, [2, 2, 0, 0, 0, 0]);
  editor.markSaved();
  assert.equal(editor.dirty, false);
});

test("records an explicit random seed on the undoable tile operation", () => {
  const editor = new TiledEditDocument(finiteMap());
  const stroke = editor.beginTileStroke(1, { kind: "random-brush", seed: 0xdecafbad });
  stroke.set(0, 0, 2);
  stroke.commit();
  assert.equal(editor.undoStack[0].seed, 0xdecafbad);
  editor.undo();
  editor.redo();
  assert.equal(editor.undoStack[0].seed, 0xdecafbad);
  assert.throws(
    () => editor.beginTileStroke(1, { seed: -1 }),
    (error) => error.code === "invalid-random-seed",
  );
});

test("creates and removes infinite-map chunks through undo and redo", () => {
  const document = finiteMap();
  document.infinite = true;
  document.width = 0;
  document.height = 0;
  document.layers[0] = { id: 1, name: "World", type: "tilelayer", chunks: [] };
  const editor = new TiledEditDocument(document, { chunkWidth: 4, chunkHeight: 4 });
  const stroke = editor.beginTileStroke(1);
  stroke.set(-1, -1, 7);
  stroke.commit();
  assert.deepEqual(editor.layerById(1).chunks.map(({ x, y, width, height }) => ({ x, y, width, height })), [
    { x: -4, y: -4, width: 4, height: 4 },
  ]);
  assert.equal(editor.layerById(1).chunks[0].data[15], 7);
  editor.undo();
  assert.deepEqual(editor.layerById(1).chunks, []);
  editor.redo();
  assert.equal(editor.layerById(1).chunks[0].data[15], 7);
});

test("fills one contiguous tile region as one history entry", () => {
  const document = finiteMap();
  document.layers[0].data = [1, 1, 0, 1, 0, 0];
  const editor = new TiledEditDocument(document);
  assert.equal(editor.fillTileRegion(1, 0, 0, 2), true);
  assert.deepEqual(editor.layerById(1).data, [2, 2, 0, 2, 0, 0]);
  assert.equal(editor.undoStack.length, 1);
  editor.undo();
  assert.deepEqual(editor.layerById(1).data, [1, 1, 0, 1, 0, 0]);
});

test("commits a compact Worker fill and replays typed-array history", () => {
  const document = finiteMap();
  document.layers[0].data = [1, 1, 0, 1, 0, 0];
  const editor = new TiledEditDocument(document);
  const result = {
    addresses: Int32Array.of(0, 0, 0, 1, 0, 3),
    blocks: [{ kind: "data", x: 0, y: 0, width: 3, height: 2 }],
    target: 1,
    replacement: 2,
    count: 3,
    bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
  assert.equal(editor.applyTileFillResult(1, result, { expectedStateId: 0 }), true);
  assert.deepEqual(editor.layerById(1).data, [2, 2, 0, 2, 0, 0]);
  assert.equal(editor.undoStack[0].type, "tile-fill-compact");
  assert.equal(editor.undoStack[0].addresses instanceof Int32Array, true);
  assert.equal(Object.hasOwn(editor.undoStack[0], "changes"), false);
  editor.undo();
  assert.deepEqual(editor.layerById(1).data, [1, 1, 0, 1, 0, 0]);
  editor.redo();
  assert.deepEqual(editor.layerById(1).data, [2, 2, 0, 2, 0, 0]);
});

test("resolves compact fill chunks by geometry after array reorder", () => {
  const document = finiteMap();
  document.infinite = true;
  document.width = 0;
  document.height = 0;
  document.layers[0] = {
    id: 1,
    name: "World",
    type: "tilelayer",
    chunks: [
      { x: 0, y: 0, width: 2, height: 1, data: [1, 1] },
      { x: 2, y: 0, width: 2, height: 1, data: [1, 0] },
    ],
  };
  const editor = new TiledEditDocument(document);
  const result = {
    addresses: Int32Array.of(0, 0, 0, 1, 1, 0),
    blocks: [
      { kind: "chunk", x: 0, y: 0, width: 2, height: 1 },
      { kind: "chunk", x: 2, y: 0, width: 2, height: 1 },
    ],
    target: 1,
    replacement: 5,
    count: 3,
    bounds: { minX: 0, minY: 0, maxX: 2, maxY: 0 },
  };
  editor.layerById(1).chunks.reverse();
  assert.equal(editor.applyTileFillResult(1, result, { expectedStateId: 0 }), true);
  assert.deepEqual(editor.layerById(1).chunks.find((chunk) => chunk.x === 0).data, [5, 5]);
  assert.deepEqual(editor.layerById(1).chunks.find((chunk) => chunk.x === 2).data, [5, 0]);
  editor.undo();
  assert.deepEqual(editor.layerById(1).chunks.find((chunk) => chunk.x === 0).data, [1, 1]);
});

test("rejects stale, duplicate, and dimension-mismatched compact fill results atomically", () => {
  const editor = new TiledEditDocument(finiteMap());
  const base = {
    addresses: Int32Array.of(0, 0),
    blocks: [{ kind: "data", x: 0, y: 0, width: 3, height: 2 }],
    target: 0,
    replacement: 2,
    count: 1,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  const stroke = editor.beginTileStroke(1);
  stroke.set(2, 1, 7);
  stroke.commit();
  assert.throws(
    () => editor.applyTileFillResult(1, base, { expectedStateId: 0 }),
    (error) => error.code === "fill-result-stale",
  );
  assert.equal(editor.layerById(1).data[0], 0);

  assert.throws(
    () => editor.applyTileFillResult(1, {
      ...base,
      addresses: Int32Array.of(0, 0, 0, 0),
      count: 2,
    }, { expectedStateId: editor.headStateId }),
    (error) => error.code === "invalid-fill-result",
  );
  assert.equal(editor.layerById(1).data[0], 0);

  assert.throws(
    () => editor.applyTileFillResult(1, {
      ...base,
      blocks: [{ kind: "data", x: 0, y: 0, width: 2, height: 3 }],
    }, { expectedStateId: editor.headStateId }),
    (error) => error.code === "fill-result-stale",
  );
  assert.equal(editor.layerById(1).data[0], 0);
});

test("samples encoded tile values without creating history or requiring an unlocked layer", () => {
  const document = finiteMap();
  document.layers[0].data = [0x8000_0001, 2, 0, 0, 0, 0];
  document.layers[0].locked = true;
  const editor = new TiledEditDocument(document);
  assert.equal(editor.tileAt(1, 0, 0), 0x8000_0001);
  assert.equal(editor.tileAt(1, 1, 0), 2);
  assert.equal(editor.tileAt(1, 8, 8), null);
  assert.equal(editor.undoStack.length, 0);
});

test("preserves unknown data while editing layers and objects", () => {
  const source = finiteMap();
  const editor = new TiledEditDocument(source);
  editor.updateLayer(1, { name: "Terrain", visible: false });
  const added = editor.addObject(2, { class: "Portal", name: "Door", x: 16, y: 32, width: 16, height: 16 });
  assert.equal(added.id, 2);
  editor.updateObject(2, added.id, { x: 48, properties: [{ name: "target", type: "string", value: "Town" }] });
  assert.equal(editor.layerById(2).objects[1].x, 48);
  editor.removeObject(2, 1);
  assert.deepEqual(editor.document.unknownRoot, source.unknownRoot);
  assert.deepEqual(editor.layerById(1).unknownLayer, source.layers[0].unknownLayer);

  editor.undo();
  assert.equal(editor.layerById(2).objects[0].id, 1);
  editor.undo();
  assert.equal(editor.layerById(2).objects[1].x, 16);
  editor.undo();
  assert.equal(editor.layerById(2).objects.length, 1);
  editor.undo();
  assert.equal(editor.layerById(1).name, "Ground");
});

test("undoes and redoes fields that were absent before an update", () => {
  const editor = new TiledEditDocument(finiteMap());
  assert.equal(Object.hasOwn(editor.layerById(2).objects[0], "properties"), false);
  editor.updateObject(2, 1, { properties: [{ name: "solid", type: "bool", value: true }] });
  assert.equal(editor.layerById(2).objects[0].properties[0].value, true);
  assert.deepEqual(editor.undoStack[0].beforeMissing, ["properties"]);
  editor.undo();
  assert.equal(Object.hasOwn(editor.layerById(2).objects[0], "properties"), false);
  editor.redo();
  assert.equal(editor.layerById(2).objects[0].properties[0].name, "solid");
  editor.updateObject(2, 1, { properties: undefined });
  assert.equal(Object.hasOwn(editor.layerById(2).objects[0], "properties"), false);
  editor.undo();
  assert.equal(editor.layerById(2).objects[0].properties[0].value, true);
});

test("duplicates objects with a new ID while preserving forward-compatible fields", () => {
  const source = finiteMap();
  source.layers[1].objects[0].futureObjectData = { keep: [1, 2] };
  const editor = new TiledEditDocument(source);
  const duplicate = editor.duplicateObject(2, 1, { x: 16, y: 32 });
  assert.equal(duplicate.id, 2);
  assert.equal(duplicate.x, 16);
  assert.equal(duplicate.y, 32);
  assert.deepEqual(duplicate.futureObjectData, { keep: [1, 2] });
  assert.equal(editor.document.nextobjectid, 3);
  editor.undo();
  assert.equal(editor.layerById(2).objects.length, 1);
  assert.equal(editor.document.nextobjectid, 2);
  editor.redo();
  assert.equal(editor.layerById(2).objects[1].id, 2);
});

test("moves one or more objects through stable Tiled array order with undo and redo", () => {
  const source = finiteMap();
  source.layers[1].objects.push(
    { id: 2, name: "Middle", x: 16, y: 0, width: 8, height: 8 },
    { id: 3, name: "Front", x: 32, y: 0, width: 8, height: 8 },
  );
  source.nextobjectid = 4;
  const editor = new TiledEditDocument(source);
  assert.equal(editor.moveObjects(2, [1, 2], "front"), true);
  assert.deepEqual(editor.layerById(2).objects.map(({ id }) => id), [3, 1, 2]);
  editor.undo();
  assert.deepEqual(editor.layerById(2).objects.map(({ id }) => id), [1, 2, 3]);
  editor.redo();
  assert.deepEqual(editor.layerById(2).objects.map(({ id }) => id), [3, 1, 2]);
  assert.equal(editor.moveObjects(2, [1, 2], "backward"), true);
  assert.deepEqual(editor.layerById(2).objects.map(({ id }) => id), [1, 2, 3]);
  assert.equal(editor.moveObjects(2, [1, 2], "back"), false);
  assert.throws(
    () => editor.moveObjects(2, [99], "front"),
    (error) => error.code === "object-not-found",
  );
});

test("allows visibility and unlock changes on a locked layer", () => {
  const source = finiteMap();
  source.layers[0].locked = true;
  const editor = new TiledEditDocument(source);
  assert.equal(editor.updateLayer(1, { visible: false }), true);
  assert.equal(editor.updateLayer(1, { locked: false }), true);
  assert.equal(editor.layerById(1).locked, false);
  assert.throws(
    () => {
      editor.updateLayer(1, { locked: true });
      editor.updateLayer(1, { name: "Blocked" });
    },
    (error) => error.code === "layer-locked",
  );
});

test("rejects locked, encoded, and out-of-range tile edits", () => {
  const document = finiteMap();
  document.layers[0].locked = true;
  const locked = new TiledEditDocument(document);
  assert.throws(
    () => locked.beginTileStroke(1),
    (error) => error instanceof TiledEditError && error.code === "layer-locked",
  );

  document.layers[0] = { id: 1, name: "Encoded", type: "tilelayer", width: 1, height: 1, data: "AAAAAA==", encoding: "base64" };
  const encoded = new TiledEditDocument(document);
  assert.throws(
    () => encoded.beginTileStroke(1),
    (error) => error.code === "encoded-tile-layer",
  );

  const finite = new TiledEditDocument(finiteMap());
  const stroke = finite.beginTileStroke(1);
  assert.throws(() => stroke.set(5, 5, 1), (error) => error.code === "tile-outside-layer");
  stroke.cancel();
});

test("clears redo history when a new branch is committed", () => {
  const editor = new TiledEditDocument(finiteMap());
  let stroke = editor.beginTileStroke(1);
  stroke.set(0, 0, 1);
  stroke.commit();
  editor.undo();
  assert.equal(editor.canRedo, true);
  stroke = editor.beginTileStroke(1);
  stroke.set(2, 1, 2);
  stroke.commit();
  assert.equal(editor.canRedo, false);
  assert.equal(editor.layerById(1).data[0], 0);
  assert.equal(editor.layerById(1).data[5], 2);
});

test("marks an immutable saved state while newer edits remain dirty", () => {
  const editor = new TiledEditDocument(finiteMap());
  editor.updateLayer(1, { name: "Terrain" });
  const submittedStateId = editor.headStateId;
  editor.updateLayer(1, { opacity: 0.5 });
  editor.markSaved(submittedStateId);
  assert.equal(editor.dirty, true);
  editor.undo();
  assert.equal(editor.headStateId, submittedStateId);
  assert.equal(editor.dirty, false);
  editor.redo();
  assert.equal(editor.dirty, true);
});

test("groups a mixed atomic batch into one undo entry and rolls failures back", () => {
  const source = finiteMap();
  const editor = new TiledEditDocument(source);
  const committed = editor.runBatch("AI 地图补丁", () => {
    const stroke = editor.beginTileStroke(1, { label: "修改瓦片" });
    stroke.set(0, 0, 2);
    stroke.set(1, 0, 1);
    stroke.commit();
    editor.updateLayer(1, { name: "Terrain" });
    editor.updateObject(2, 1, { name: "Player Start" });
  });
  assert.equal(committed.changed, true);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.deepEqual(editor.undoStack[0].layerIds, [1, 2]);
  assert.deepEqual(editor.layerById(1).data.slice(0, 2), [2, 1]);
  assert.equal(editor.layerById(1).name, "Terrain");
  assert.equal(editor.layerById(2).objects[0].name, "Player Start");
  editor.undo();
  assert.deepEqual(editor.exportDocument(), source);
  editor.redo();
  assert.equal(editor.layerById(1).name, "Terrain");
  assert.equal(editor.layerById(2).objects[0].name, "Player Start");

  const beforeFailure = editor.exportDocument();
  assert.throws(
    () => editor.runBatch("失败补丁", () => {
      editor.updateLayer(1, { visible: false });
      editor.updateObject(2, 999, { name: "Missing" });
    }),
    (error) => error.code === "object-not-found",
  );
  assert.deepEqual(editor.exportDocument(), beforeFailure);
  assert.equal(editor.undoStack.length, 1);
});

test("groups a completed gesture and its derived edit into one undo step", () => {
  const editor = new TiledEditDocument(finiteMap());
  let stroke = editor.beginTileStroke(1, { label: "绘制瓦片" });
  stroke.set(0, 0, 1);
  stroke.commit();
  stroke = editor.beginTileStroke(1, { label: "AutoMap" });
  stroke.set(1, 0, 2);
  stroke.commit();
  const grouped = editor.groupRecentHistory(2, "绘制瓦片 + AutoMap", { seed: 42 });
  assert.equal(editor.undoStack.length, 1);
  assert.equal(grouped.type, "batch");
  assert.equal(grouped.seed, 42);
  assert.deepEqual(editor.layerById(1).data, [1, 2, 0, 0, 0, 0]);
  editor.undo();
  assert.deepEqual(editor.layerById(1).data, [0, 0, 0, 0, 0, 0]);
  editor.redo();
  assert.deepEqual(editor.layerById(1).data, [1, 2, 0, 0, 0, 0]);
});

test("adds and removes external tileset references through undoable structural history", () => {
  const source = finiteMap();
  source.tilesets = [{ firstgid: 1, source: "../tiles/terrain.tsj" }];
  const editor = new TiledEditDocument(source);
  const added = editor.addTileset({
    firstgid: 20,
    source: "../tiles/props.tsj",
    futureReferenceField: { keep: true },
  });
  assert.deepEqual(added.futureReferenceField, { keep: true });
  assert.deepEqual(editor.document.tilesets.map((entry) => entry.firstgid), [1, 20]);
  assert.equal(editor.undoStack[0].type, "tileset-structure");
  assert.equal(editor.undoStack[0].structural, true);
  assert.equal(editor.undoStack[0].reloadTilesets, true);

  editor.undo();
  assert.deepEqual(editor.document.tilesets, source.tilesets);
  editor.redo();
  assert.equal(editor.document.tilesets[1].source, "../tiles/props.tsj");
  assert.deepEqual(editor.document.unknownRoot, source.unknownRoot);

  editor.removeTileset("../tiles/props.tsj");
  assert.equal(editor.document.tilesets.length, 1);
  editor.undo();
  assert.equal(editor.document.tilesets[1].source, "../tiles/props.tsj");
  editor.redo();
  assert.equal(editor.document.tilesets.length, 1);
});

test("rejects duplicate and malformed new tileset references", () => {
  const source = finiteMap();
  source.tilesets = [{ firstgid: 1, source: "../tiles/terrain.tsj" }];
  const editor = new TiledEditDocument(source);
  assert.throws(
    () => editor.addTileset({ firstgid: 10, source: "../tiles/terrain.tsj" }),
    (error) => error.code === "duplicate-tileset-source",
  );
  for (const reference of [
    { firstgid: 0, source: "../tiles/props.tsj" },
    { firstgid: 10, source: "https://example.test/props.tsj" },
    { firstgid: 10, source: "..\\tiles\\props.tsj" },
    { firstgid: 10, source: "../tiles/props.png" },
  ]) {
    assert.throws(() => editor.addTileset(reference), (error) => (
      error.code === "invalid-tileset-firstgid" || error.code === "invalid-tileset-source"
    ));
  }
});

test("creates finite and infinite layers with Tiled-compatible defaults", () => {
  const finite = new TiledEditDocument(finiteMap());
  const tile = finite.createLayer("tilelayer", { name: "Details", futureField: { keep: true } });
  assert.equal(tile.id, 3);
  assert.equal(tile.width, 3);
  assert.equal(tile.height, 2);
  assert.deepEqual(tile.data, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(tile.futureField, { keep: true });
  assert.equal(finite.document.nextlayerid, 4);
  assert.equal(finite.undoStack[0].structural, true);
  finite.undo();
  assert.equal(finite.layerById(3), null);
  assert.equal(Object.hasOwn(finite.document, "nextlayerid"), false);
  finite.redo();
  assert.equal(finite.layerById(3).name, "Details");

  const source = finiteMap();
  source.infinite = true;
  source.width = 0;
  source.height = 0;
  const infinite = new TiledEditDocument(source);
  const world = infinite.createLayer("tilelayer", { name: "Infinite Details" });
  assert.deepEqual(world.chunks, []);
  assert.equal(world.width, 0);
  assert.equal(world.height, 0);
  assert.equal(Object.hasOwn(world, "data"), false);
});

test("adds nested groups while recursively assigning unique layer and object IDs", () => {
  const editor = new TiledEditDocument(finiteMap());
  const added = editor.addLayer({
    id: 1,
    type: "group",
    name: "Imported",
    unknownGroup: ["keep"],
    layers: [
      {
        id: 2,
        type: "objectgroup",
        name: "Imported Objects",
        objects: [
          {
            id: 1,
            name: "A",
            properties: [{ name: "target", type: "object", value: 2 }],
          },
          { id: 2, name: "B", futureObject: { keep: true } },
        ],
      },
      { id: 3, type: "imagelayer", name: "Backdrop", image: "../art/world.png", futureLayer: 7 },
    ],
  });
  assert.deepEqual([added.id, added.layers[0].id, added.layers[1].id], [3, 4, 5]);
  assert.deepEqual(added.layers[0].objects.map((object) => object.id), [2, 3]);
  assert.equal(added.layers[0].objects[0].properties[0].value, 3);
  assert.equal(editor.document.nextlayerid, 6);
  assert.equal(editor.document.nextobjectid, 4);
  assert.deepEqual(added.unknownGroup, ["keep"]);
  assert.deepEqual(added.layers[0].objects[1].futureObject, { keep: true });
  assert.equal(added.layers[1].futureLayer, 7);
});

test("duplicates, moves, and removes layers across root and group containers", () => {
  const editor = new TiledEditDocument(finiteMap());
  const group = editor.createLayer("group", { name: "Folder", index: 0 });
  const duplicate = editor.duplicateLayer(1, { parentId: group.id });
  assert.notEqual(duplicate.id, 1);
  assert.equal(editor.layerById(group.id).layers[0].name, "Ground");
  assert.deepEqual(editor.layerById(duplicate.id).unknownLayer, { keep: true });

  const moved = editor.moveLayer(2, { parentId: group.id, index: 0 });
  assert.equal(moved.id, 2);
  assert.deepEqual(editor.document.layers.map((layer) => layer.id), [group.id, 1]);
  assert.deepEqual(editor.layerById(group.id).layers.map((layer) => layer.id), [2, duplicate.id]);
  assert.equal(editor.moveLayer(2, { parentId: group.id, index: 0 }), false);

  const removed = editor.removeLayer(duplicate.id);
  assert.equal(removed.id, duplicate.id);
  assert.equal(editor.layerById(duplicate.id), null);
  editor.undo();
  assert.equal(editor.layerById(duplicate.id).name, "Ground");
  editor.undo();
  assert.equal(editor.document.layers.some((layer) => layer.id === 2), true);
  editor.redo();
  assert.equal(editor.layerById(group.id).layers[0].id, 2);
});

test("moves multiple layer roots atomically across groups and restores exact positions", () => {
  const source = finiteMap();
  source.layers.push({ id: 3, name: "Details", type: "objectgroup", objects: [] });
  source.nextlayerid = 4;
  const editor = new TiledEditDocument(source);
  const group = editor.createLayer("group", { name: "Folder", index: 1 });
  const historyBeforeMove = editor.undoStack.length;

  const moved = editor.moveLayers([1, 3], {
    parentId: group.id,
    index: 0,
    label: "整理多个图层",
  });
  assert.deepEqual(moved.map((layer) => layer.id), [1, 3]);
  assert.deepEqual(editor.document.layers.map((layer) => layer.id), [group.id, 2]);
  assert.deepEqual(editor.layerById(group.id).layers.map((layer) => layer.id), [1, 3]);
  assert.equal(editor.undoStack.length, historyBeforeMove + 1);
  assert.equal(editor.undoStack.at(-1).operation, "move-many");

  editor.undo();
  assert.deepEqual(editor.document.layers.map((layer) => layer.id), [1, group.id, 2, 3]);
  assert.deepEqual(editor.layerById(group.id).layers, []);
  editor.redo();
  assert.deepEqual(editor.document.layers.map((layer) => layer.id), [group.id, 2]);
  assert.deepEqual(editor.layerById(group.id).layers.map((layer) => layer.id), [1, 3]);

  const historyBeforeNoop = editor.undoStack.length;
  assert.equal(editor.moveLayers([1, 3], { parentId: group.id, index: 2 }), false);
  assert.equal(editor.undoStack.length, historyBeforeNoop);
});

test("normalizes descendants when a selected group is moved", () => {
  const source = finiteMap();
  source.layers.unshift({
    id: 8,
    name: "Group",
    type: "group",
    layers: [{ id: 9, name: "Nested", type: "objectgroup", objects: [] }],
  });
  source.nextlayerid = 10;
  const editor = new TiledEditDocument(source);
  const result = editor.moveLayers([9, 8], { parentId: null, index: source.layers.length });
  assert.deepEqual(result.map((layer) => layer.id), [8]);
  assert.equal(editor.layerById(8).layers[0].id, 9);
  assert.throws(
    () => editor.moveLayers([8], { parentId: 9, index: 0 }),
    (error) => error.code === "layer-cycle",
  );
});

test("rejects locked structural edits and group cycles", () => {
  const source = finiteMap();
  source.layers.unshift({
    id: 9,
    name: "Locked Folder",
    type: "group",
    locked: true,
    layers: [{ id: 10, name: "Child", type: "group", layers: [] }],
  });
  source.nextlayerid = 11;
  const editor = new TiledEditDocument(source);
  assert.throws(() => editor.createLayer("objectgroup", { parentId: 9 }), (error) => error.code === "layer-locked");
  assert.throws(() => editor.removeLayer(10), (error) => error.code === "layer-locked");
  assert.throws(() => editor.moveLayer(9, { parentId: 10 }), (error) => error.code === "layer-locked");

  editor.updateLayer(9, { locked: false });
  assert.throws(() => editor.moveLayer(9, { parentId: 10 }), (error) => error.code === "layer-cycle");
});

test("groups structural changes into one batch history entry", () => {
  const source = finiteMap();
  const editor = new TiledEditDocument(source);
  const result = editor.runBatch("整理图层", () => {
    const group = editor.createLayer("group", { name: "World" });
    editor.moveLayer(1, { parentId: group.id });
    editor.createLayer("imagelayer", { parentId: group.id, image: "../art/background.png" });
  });
  assert.equal(result.changed, true);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.equal(editor.undoStack[0].structural, true);
  editor.undo();
  assert.deepEqual(editor.exportDocument(), source);
  editor.redo();
  assert.equal(editor.document.layers.at(-1).type, "group");
  assert.equal(editor.document.layers.at(-1).layers.length, 2);

  const beforeFailure = editor.exportDocument();
  const historyLength = editor.undoStack.length;
  assert.throws(
    () => editor.runBatch("失败的结构调整", () => {
      const temporary = editor.createLayer("group", { name: "Temporary" });
      editor.moveLayer(2, { parentId: temporary.id });
      editor.updateObject(999, 999, { name: "Missing" });
    }),
    (error) => error.code === "layer-not-found",
  );
  assert.deepEqual(editor.exportDocument(), beforeFailure);
  assert.equal(editor.undoStack.length, historyLength);
});

test("structural move history does not snapshot unrelated large tile data", () => {
  const source = finiteMap();
  source.width = 20_000;
  source.height = 1;
  source.layers[0].width = 20_000;
  source.layers[0].height = 1;
  source.layers[0].data = Array(20_000).fill(987_654_321);
  source.layers.push({ id: 3, name: "Folder", type: "group", layers: [] });
  source.nextlayerid = 4;
  const editor = new TiledEditDocument(source);
  editor.moveLayer(2, { parentId: 3 });
  const entry = editor.undoStack[0];
  assert.equal(entry.type, "layer-structure");
  assert.equal(entry.operation, "move");
  assert.equal(entry.structural, true);
  assert.equal(Object.hasOwn(entry, "before"), false);
  assert.equal(Object.hasOwn(entry, "after"), false);
  assert.equal(Object.hasOwn(entry, "layers"), false);
  assert.equal(Object.hasOwn(entry, "layer"), false);
  assert.equal(JSON.stringify(entry).includes("987654321"), false);
  editor.undo();
  assert.equal(editor.document.layers[1].id, 2);
  editor.redo();
  assert.equal(editor.layerById(3).layers[0].id, 2);
});
