import assert from "node:assert/strict";
import test from "node:test";
import {
  compositeDependencies,
  createCompositeMapDocument,
  relocateCompositeMapDocument,
  remapCompositeLayerGids,
} from "../public/map-editor/tiled-composite.js";

const document = {
  type: "map",
  orientation: "orthogonal",
  width: 10,
  height: 8,
  tilewidth: 16,
  tileheight: 16,
  tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
  layers: [
    { id: 1, type: "imagelayer", name: "Background", image: "../images/bg.png" },
    {
      id: 2,
      type: "group",
      name: "Village",
      layers: [
        {
          id: 3,
          type: "objectgroup",
          name: "Props",
          objects: [{ id: 9, template: "../templates/tree.tx", properties: [{ name: "icon", type: "file", value: "../images/tree.png" }] }],
        },
      ],
      futureGroupField: { keep: true },
    },
    { id: 4, type: "tilelayer", name: "Collision", data: [0], width: 1, height: 1 },
  ],
  futureMapField: { keep: true },
};

test("exports selected root layers as a reusable TMJ while preserving unknown fields", () => {
  const composite = createCompositeMapDocument(document, [2]);
  assert.deepEqual(composite.layers.map((layer) => layer.id), [2]);
  assert.deepEqual(composite.layers[0].futureGroupField, { keep: true });
  assert.deepEqual(composite.futureMapField, { keep: true });
  assert.equal(composite.tilesets[0].source, "../tiles/terrain.tsj");
  assert.throws(
    () => createCompositeMapDocument(document, []),
    (error) => error.code === "TILED_COMPOSITE_SELECTION_EMPTY",
  );
});

test("relocates a saved composite back into a target map without changing the source", () => {
  const saved = createCompositeMapDocument(document, [2], {
    sourcePath: "maps/world.tmj",
    targetPath: "maps/library/village.tmj",
  });
  const relocated = relocateCompositeMapDocument(saved, {
    sourcePath: "maps/library/village.tmj",
    targetPath: "maps/other.tmj",
  });
  assert.equal(relocated.tilesets[0].source, "../tiles/terrain.tsj");
  assert.equal(relocated.layers[0].layers[0].objects[0].template, "../templates/tree.tx");
  assert.equal(saved.layers[0].layers[0].objects[0].template, "../../templates/tree.tx");
});

test("remaps tile layers, chunks and tile objects without mutating the source", () => {
  const source = {
    type: "map",
    layers: [
      { id: 1, type: "tilelayer", data: [0, 1, 0x8000_0002] },
      { id: 2, type: "tilelayer", chunks: [{ x: 0, y: 0, width: 1, height: 1, data: [3] }] },
      { id: 3, type: "objectgroup", objects: [{ id: 1, gid: 4 }] },
    ],
  };
  const remapped = remapCompositeLayerGids(source, (value) => {
    if (!value) return 0;
    return (((value & 0x0fff_ffff) + 20) | (value & 0xf000_0000)) >>> 0;
  });
  assert.deepEqual(remapped.layers[0].data, [0, 21, 0x8000_0016]);
  assert.deepEqual(remapped.layers[1].chunks[0].data, [23]);
  assert.equal(remapped.layers[2].objects[0].gid, 24);
  assert.equal(source.layers[0].data[1], 1);
});

test("selecting a child keeps only that child in a copied group and reports project dependencies", () => {
  const composite = createCompositeMapDocument(document, [3], {
    sourcePath: "maps/world.tmj",
    targetPath: "assets/composites/village.tmj",
  });
  assert.equal(composite.layers.length, 1);
  assert.equal(composite.layers[0].type, "group");
  assert.deepEqual(composite.layers[0].layers.map((layer) => layer.id), [3]);
  assert.equal(composite.tilesets[0].source, "../../tiles/terrain.tsj");
  assert.equal(composite.layers[0].layers[0].objects[0].template, "../../templates/tree.tx");
  assert.equal(composite.layers[0].layers[0].objects[0].properties[0].value, "../../images/tree.png");
  assert.deepEqual(compositeDependencies(composite, "assets/composites/village.tmj"), [
    "images/tree.png",
    "templates/tree.tx",
    "tiles/terrain.tsj",
  ]);
});
