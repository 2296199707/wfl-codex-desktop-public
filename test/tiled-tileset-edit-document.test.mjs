import assert from "node:assert/strict";
import test from "node:test";
import { serializeTiledDocument } from "../public/map-editor/tiled-document.js";
import { TiledTilesetEditDocument } from "../public/map-editor/tiled-tileset-edit-document.js";

test("edits atlas grid losslessly with atomic undo and redo", () => {
  const editor = new TiledTilesetEditDocument(atlasFixture(), { sourcePath: "tiles/terrain.tsj" });
  assert.equal(editor.kind, "atlas");
  assert.equal(editor.setIdentity({ name: "Terrain HD", className: "GroundTiles" }), true);
  assert.equal(editor.setAtlasGrid({ tilewidth: 14, tileheight: 14, margin: 1, spacing: 1, transparentcolor: "#FF00FF" }), true);
  assert.equal(editor.document.columns, 4);
  assert.equal(editor.document.tilecount, 8);
  assert.equal(editor.document.transparentcolor, "#ff00ff");
  assert.deepEqual(editor.document.wflUnknown, { nested: [1, 2, 3] });
  assert.equal(editor.dirty, true);
  assert.equal(editor.undo(), true);
  assert.equal(editor.document.tilewidth, 16);
  assert.equal(editor.undo(), true);
  assert.equal(editor.document.name, "Terrain");
  assert.equal(editor.redo(), true);
  assert.equal(editor.document.name, "Terrain HD");
  assert.doesNotThrow(() => serializeTiledDocument(editor.exportDocument(), {
    expectedKind: "tileset",
    sourcePath: "tiles/terrain.tsj",
  }));
});

test("rejects an atlas grid that would orphan explicit tile metadata", () => {
  const fixture = atlasFixture();
  fixture.tiles = [{ id: 7, probability: 0.25 }];
  const editor = new TiledTilesetEditDocument(fixture);
  assert.throws(
    () => editor.setAtlasGrid({ tilewidth: 32, tileheight: 16, margin: 0, spacing: 0 }),
    (error) => error.code === "atlas-grid-truncates-tiles",
  );
  assert.equal(editor.document.tilewidth, 16);
  assert.equal(editor.dirty, false);
});

test("edits global rendering fields without replacing unrelated data", () => {
  const editor = new TiledTilesetEditDocument(atlasFixture());
  editor.setRendering({
    objectalignment: "bottomright",
    tilerendersize: "grid",
    fillmode: "preserve-aspect-fit",
    tileoffsetX: -3,
    tileoffsetY: 5,
    gridOrientation: "isometric",
    gridWidth: 32,
    gridHeight: 16,
    transformations: { hflip: true, rotate: true },
  });
  assert.deepEqual(editor.document.tileoffset, { x: -3, y: 5 });
  assert.deepEqual(editor.document.transformations, {
    hflip: true,
    vflip: false,
    rotate: true,
    preferuntransformed: false,
  });
  assert.deepEqual(editor.document.wflUnknown, { nested: [1, 2, 3] });
  editor.setRendering({
    objectalignment: "unspecified",
    tilerendersize: "tile",
    fillmode: "stretch",
    tileoffsetX: 0,
    tileoffsetY: 0,
    gridOrientation: "orthogonal",
    gridWidth: 16,
    gridHeight: 16,
    transformations: {},
  });
  for (const key of ["objectalignment", "tilerendersize", "fillmode", "tileoffset", "grid", "transformations"]) {
    assert.equal(Object.hasOwn(editor.document, key), false);
  }
});

test("image collection allocates unused IDs and never renumbers survivors", () => {
  const editor = new TiledTilesetEditDocument(collectionFixture());
  assert.equal(editor.kind, "collection");
  const added = editor.addCollectionTile({ image: "../images/bush.png", imagewidth: 21, imageheight: 29 });
  assert.equal(added.id, 1);
  assert.deepEqual(editor.document.tiles.map(({ id }) => id), [0, 2, 1]);
  assert.equal(editor.removeCollectionTiles([0, 9]), true);
  assert.deepEqual(editor.document.tiles.map(({ id }) => id), [2, 1]);
  assert.equal(editor.document.tilecount, 2);
  assert.equal(editor.document.tilewidth, 24);
  assert.equal(editor.document.tileheight, 29);
  assert.equal(editor.undo(), true);
  assert.deepEqual(editor.document.tiles.map(({ id }) => id), [0, 2, 1]);
  assert.deepEqual(editor.document.wflUnknown, { keep: true });
  assert.throws(
    () => editor.addCollectionTile({ image: "../images/rock.png", imagewidth: 24, imageheight: 20 }),
    (error) => error.code === "duplicate-tile-image",
  );
  assert.throws(
    () => editor.removeCollectionTiles([0, 1, 2]),
    (error) => error.code === "empty-image-collection",
  );
});

test("edits tile class, probability, and typed properties without materializing empty atlas tiles", () => {
  const editor = new TiledTilesetEditDocument(atlasFixture(), { sourcePath: "tiles/terrain.tsj" });
  editor.setTileMetadata(3, { className: "Ground", probability: 0.375 });
  editor.setTileProperties(3, [
    { name: "walkCost", type: "int", value: 2, wflUnknownPropertyField: "keep" },
    { name: "slippery", type: "bool", value: true },
    { name: "material", type: "string", value: "grass" },
  ]);
  assert.deepEqual(editor.tileDefinition(3), {
    id: 3,
    class: "Ground",
    probability: 0.375,
    properties: [
      { name: "walkCost", type: "int", value: 2, wflUnknownPropertyField: "keep" },
      { name: "slippery", type: "bool", value: true },
      { name: "material", type: "string", value: "grass" },
    ],
  });
  assert.throws(
    () => editor.setTileProperties(3, [
      { name: "same", type: "string", value: "a" },
      { name: "same", type: "int", value: 1 },
    ]),
    (error) => error.code === "duplicate-property-name",
  );
  assert.throws(
    () => editor.setTileMetadata(3, { probability: -1 }),
    /probability must be non-negative/u,
  );
  editor.setTileProperties(3, []);
  editor.setTileMetadata(3, { className: "", probability: "" });
  assert.equal(editor.document.tiles, undefined);
  assert.deepEqual(editor.tileDefinition(3), { id: 3 });
  assert.equal(editor.undo(), true);
  assert.equal(editor.tileDefinition(3).class, "Ground");
});

test("edits deterministic tile animation with valid atlas and collection frame IDs", () => {
  const atlasEditor = new TiledTilesetEditDocument(atlasFixture());
  atlasEditor.setTileAnimation(0, [
    { tileid: 0, duration: 80, wflUnknownFrameField: true },
    { tileid: 1, duration: 120 },
  ]);
  assert.deepEqual(atlasEditor.tileDefinition(0).animation, [
    { tileid: 0, duration: 80, wflUnknownFrameField: true },
    { tileid: 1, duration: 120 },
  ]);
  assert.throws(
    () => atlasEditor.setTileAnimation(0, [{ tileid: 8, duration: 100 }]),
    (error) => error.code === "tile-not-found",
  );
  assert.throws(
    () => atlasEditor.setTileAnimation(0, [{ tileid: 1, duration: 0 }]),
    /must be positive/u,
  );
  atlasEditor.setTileAnimation(0, []);
  assert.equal(atlasEditor.document.tiles, undefined);

  const collectionEditor = new TiledTilesetEditDocument(collectionFixture());
  collectionEditor.setTileAnimation(0, [{ tileid: 2, duration: 150 }]);
  assert.deepEqual(collectionEditor.tileDefinition(0).animation, [{ tileid: 2, duration: 150 }]);
  assert.throws(
    () => collectionEditor.setTileAnimation(0, [{ tileid: 1, duration: 150 }]),
    (error) => error.code === "tile-not-found",
  );
});

test("creates, updates, and removes multi-shape tile collision while preserving group fields", () => {
  const fixture = atlasFixture();
  fixture.tiles = [{
    id: 1,
    wflUnknownTileField: { keep: true },
    objectgroup: {
      draworder: "index",
      id: 9,
      name: "Hitbox",
      objects: [],
      opacity: 1,
      type: "objectgroup",
      visible: true,
      x: 0,
      y: 0,
      wflUnknownGroupField: "keep",
    },
  }];
  const editor = new TiledTilesetEditDocument(fixture);
  const rectangle = editor.addTileCollision(1, { shape: "rectangle", x: 1, y: 2, width: 12, height: 9 });
  const capsule = editor.addTileCollision(1, { shape: "capsule", x: 3, y: 4, width: 7, height: 12 });
  assert.equal(rectangle.id, 1);
  assert.equal(capsule.id, 2);
  assert.equal(editor.tileDefinition(1).objectgroup.wflUnknownGroupField, "keep");
  assert.equal(editor.tileDefinition(1).objectgroup.objects[1].capsule, true);
  editor.updateTileCollision(1, rectangle.id, {
    shape: "polygon",
    x: 2,
    y: 3,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 8 }],
  });
  const polygon = editor.tileDefinition(1).objectgroup.objects[0];
  assert.deepEqual(polygon.polygon, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 8 }]);
  assert.equal(polygon.width, 0);
  assert.equal(editor.removeTileCollision(1, capsule.id), true);
  assert.equal(editor.removeTileCollision(1, rectangle.id), true);
  assert.equal(editor.tileDefinition(1).objectgroup, undefined);
  assert.deepEqual(editor.tileDefinition(1).wflUnknownTileField, { keep: true });
  assert.equal(editor.undo(), true);
  assert.equal(editor.tileDefinition(1).objectgroup.objects.length, 1);
});

test("edits Wang sets, stable color references, and eight-position tile assignments", () => {
  const fixture = atlasFixture();
  fixture.wflUnknownRoot = "keep";
  const editor = new TiledTilesetEditDocument(fixture);
  const setIndex = editor.addWangSet({ name: "Ground", type: "mixed", tile: 0 });
  assert.equal(setIndex, 0);
  const grass = editor.addWangColor(setIndex, { name: "Grass", color: "#4F8F3A", probability: 1, tile: 0 });
  const dirt = editor.addWangColor(setIndex, { name: "Dirt", color: "#9A6338", probability: 0.5, tile: 1 });
  assert.equal(grass, 1);
  assert.equal(dirt, 2);
  editor.setTileWangId(setIndex, 3, [1, 2, 1, 2, 1, 2, 1, 2]);
  assert.deepEqual(editor.document.wangsets[0].wangtiles, [{
    tileid: 3,
    wangid: [1, 2, 1, 2, 1, 2, 1, 2],
  }]);
  assert.throws(
    () => editor.updateWangSet(setIndex, { type: "edge" }),
    (error) => error.code === "wangset-type-conflict",
  );
  editor.updateWangColor(setIndex, 2, { name: "Dry Dirt", probability: 0.25, tile: -1 });
  assert.deepEqual(editor.document.wangsets[0].colors[1], {
    name: "Dry Dirt",
    color: "#9a6338",
    probability: 0.25,
    tile: -1,
  });
  editor.removeWangColor(setIndex, 1);
  assert.deepEqual(editor.document.wangsets[0].wangtiles[0].wangid, [0, 1, 0, 1, 0, 1, 0, 1]);
  editor.updateWangSet(setIndex, { type: "edge", className: "RoadTerrain", tile: -1 });
  assert.equal(editor.document.wangsets[0].class, "RoadTerrain");
  assert.equal(editor.document.wangsets[0].tile, -1);
  assert.equal(editor.document.wflUnknownRoot, "keep");
  assert.equal(editor.undo(), true);
  assert.equal(editor.document.wangsets[0].type, "mixed");
  editor.setTileWangId(setIndex, 3, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(editor.document.wangsets[0].wangtiles, []);
  assert.equal(editor.removeWangSet(setIndex), true);
  assert.equal(editor.document.wangsets, undefined);
});

function atlasFixture() {
  return {
    type: "tileset",
    version: "1.12",
    tiledversion: "1.12.2",
    name: "Terrain",
    tilewidth: 16,
    tileheight: 16,
    columns: 4,
    tilecount: 8,
    margin: 0,
    spacing: 0,
    image: "../images/terrain.png",
    imagewidth: 64,
    imageheight: 32,
    wflUnknown: { nested: [1, 2, 3] },
  };
}

function collectionFixture() {
  return {
    type: "tileset",
    version: "1.12",
    tiledversion: "1.12.2",
    name: "Props",
    tilewidth: 24,
    tileheight: 32,
    columns: 0,
    tilecount: 2,
    tiles: [
      { id: 0, image: "../images/tree.png", imagewidth: 18, imageheight: 32 },
      { id: 2, image: "../images/rock.png", imagewidth: 24, imageheight: 20 },
    ],
    wflUnknown: { keep: true },
  };
}
