import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  planPublishedMapImageLayer,
  planPublishedMapImageLayerReplacement,
  planPublishedMapTileObject,
  planPublishedMapTilesetDraft,
  publishedMapImageApplicationId,
  tiledValueHasMapImageApplication,
  validatePublishedMapImageGrant,
} from "../public/map-editor/map-image-apply.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";

const sha256 = "a".repeat(64);
const job = {
  id: "map-job-1",
  request: { operation: "edit", prompt: "repair selected terrain" },
  result: { operation: "edit" },
};

function mapDocument() {
  return {
    type: "map",
    orientation: "orthogonal",
    width: 20,
    height: 12,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 2,
    layers: [{
      id: 1,
      type: "tilelayer",
      name: "Ground",
      width: 20,
      height: 12,
      data: Array(240).fill(0),
      futureLayerField: { keep: true },
    }],
    tilesets: [],
    futureMapField: { keep: [1, 2] },
  };
}

test("plans a published selection edit as an independent, exact-position image layer", () => {
  const selectionTarget = Object.freeze({
    layer: Object.freeze({ id: 1 }),
    target: Object.freeze({ world: Object.freeze({ x: 48, y: 32, width: 64, height: 48 }) }),
  });
  const published = {
    relativePath: "assets/generated/terrain-repair.png",
    width: 64,
    height: 48,
    sha256,
  };
  const plan = planPublishedMapImageLayer({
    mapPath: "maps/world.tmj",
    published,
    job,
    selectionTarget,
    name: "Terrain repair",
  });
  assert.equal(plan.layer.type, "imagelayer");
  assert.equal(plan.layer.image, "../assets/generated/terrain-repair.png");
  assert.deepEqual({ x: plan.layer.x, y: plan.layer.y }, { x: 48, y: 32 });
  assert.deepEqual(plan.target, { x: 48, y: 32, width: 64, height: 48 });
  assert.equal(plan.sourceLayerId, 1);
  assert.equal(selectionTarget.target.world.x, 48, "frozen selection target must not be mutated");

  const editor = new TiledEditDocument(mapDocument());
  const originalSource = structuredClone(editor.layerById(1));
  const applied = editor.addLayer(plan.layer, { parentId: null, index: 1, label: "应用 AI 图片候选" });
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "layer-structure");
  assert.deepEqual(editor.layerById(1), originalSource, "source tile layer remains untouched");
  assert.equal(editor.layerById(applied.id).image, "../assets/generated/terrain-repair.png");
  assert.equal(editor.dirty, true);
  assert.equal(tiledValueHasMapImageApplication(
    editor.layerById(applied.id),
    publishedMapImageApplicationId(job, published, "image-layer"),
  ), true);
  editor.undo();
  assert.equal(editor.layerById(applied.id), null);
  assert.deepEqual(editor.document.futureMapField, { keep: [1, 2] });
  editor.redo();
  assert.equal(editor.layerById(applied.id).x, 48);
});

test("refuses to place a selection candidate whose actual size differs from its logical target", () => {
  assert.throws(
    () => planPublishedMapImageLayer({
      mapPath: "maps/world.tmj",
      published: { relativePath: "assets/generated/wrong.png", width: 65, height: 48, sha256 },
      job,
      selectionTarget: { layer: { id: 1 }, target: { world: { x: 0, y: 0, width: 64, height: 48 } } },
    }),
    (error) => error.code === "MAP_IMAGE_TARGET_SIZE_MISMATCH" && /未应用/u.test(error.message),
  );
});

test("replaces only an image layer reference and provenance through one undoable update", () => {
  const document = mapDocument();
  document.nextlayerid = 3;
  document.layers.push({
    id: 2,
    type: "imagelayer",
    name: "Backdrop",
    image: "../assets/original.png",
    x: 37,
    y: -12,
    opacity: 0.75,
    parallaxx: 0.8,
    futureImageField: { keep: true },
    properties: [
      { name: "custom", type: "string", value: "keep" },
      { name: "wfl.imageJobId", type: "string", value: "old-job" },
    ],
  });
  const published = {
    relativePath: "assets/generated/new-backdrop.png",
    width: 128,
    height: 64,
    sha256,
  };
  const plan = planPublishedMapImageLayerReplacement({
    mapPath: "maps/world.tmj",
    published,
    job,
    layer: document.layers[1],
  });
  assert.equal(plan.layerId, 2);
  assert.equal(plan.changes.image, "../assets/generated/new-backdrop.png");
  assert.equal(plan.changes.properties.find((property) => property.name === "custom").value, "keep");
  assert.equal(plan.changes.properties.filter((property) => property.name === "wfl.imageJobId").length, 1);
  assert.equal(tiledValueHasMapImageApplication(
    { properties: plan.changes.properties },
    publishedMapImageApplicationId(job, published, "image-layer-replace"),
  ), true);

  const editor = new TiledEditDocument(document);
  editor.updateLayer(plan.layerId, plan.changes, { label: "替换图片层素材" });
  const replaced = editor.layerById(2);
  assert.equal(replaced.image, "../assets/generated/new-backdrop.png");
  assert.deepEqual(
    { x: replaced.x, y: replaced.y, opacity: replaced.opacity, parallaxx: replaced.parallaxx },
    { x: 37, y: -12, opacity: 0.75, parallaxx: 0.8 },
  );
  assert.deepEqual(replaced.futureImageField, { keep: true });
  assert.equal(editor.undoStack.at(-1).type, "layer-update");
  editor.undo();
  assert.equal(editor.layerById(2).image, "../assets/original.png");
  assert.deepEqual(editor.layerById(2).futureImageField, { keep: true });
  editor.redo();
  assert.equal(editor.layerById(2).image, "../assets/generated/new-backdrop.png");
  assert.throws(
    () => planPublishedMapImageLayerReplacement({
      mapPath: "maps/world.tmj",
      published,
      job,
      layer: { id: 3, type: "tilelayer" },
    }),
    (error) => error.code === "MAP_IMAGE_REPLACE_LAYER_INVALID",
  );
});

test("keeps world coordinates exact by applying nested-group selections at the map root", () => {
  const document = mapDocument();
  document.nextlayerid = 3;
  document.layers = [{
    id: 1,
    type: "group",
    name: "Shifted group",
    x: 80,
    y: 40,
    offsetx: 5,
    offsety: 7,
    layers: [{
      id: 2,
      type: "tilelayer",
      name: "Nested terrain",
      width: 20,
      height: 12,
      data: Array(240).fill(0),
    }],
  }];
  const plan = planPublishedMapImageLayer({
    mapPath: "maps/world.tmj",
    published: {
      relativePath: "assets/generated/nested-repair.png",
      width: 64,
      height: 48,
      sha256,
    },
    job,
    selectionTarget: {
      layer: { id: 2, path: [1, 2] },
      target: { world: { x: 117, y: 93, width: 64, height: 48 } },
    },
  });
  const editor = new TiledEditDocument(document);
  const applied = editor.addLayer(plan.layer, { parentId: null, label: "应用 AI 图片候选" });
  assert.equal(editor.document.layers.at(-1).id, applied.id);
  assert.deepEqual({ x: applied.x, y: applied.y }, { x: 117, y: 93 });
  assert.deepEqual({
    x: editor.layerById(1).x,
    y: editor.layerById(1).y,
    offsetx: editor.layerById(1).offsetx,
    offsety: editor.layerById(1).offsety,
  }, { x: 80, y: 40, offsetx: 5, offsety: 7 });
  assert.equal(editor.layerById(1).layers.some((layer) => layer.id === applied.id), false);
  editor.undo();
  assert.equal(editor.layerById(applied.id), null);
});

test("plans an aligned external-image tileset draft and commits it through tileset history", () => {
  const document = mapDocument();
  const tilesetJob = {
    id: "map-job-tileset",
    request: { operation: "generate", prompt: "Reusable 2D game tileset atlas asset" },
  };
  const published = {
    relativePath: "assets/generated/tilesets/forest.png",
    width: 64,
    height: 32,
    sha256,
  };
  const plan = planPublishedMapTilesetDraft({
    mapPath: "maps/world.tmj",
    published,
    job: tilesetJob,
    document,
    existingTilesets: [{ firstgid: 1, maxLocalId: 3, definition: { name: "Existing" } }],
  });
  assert.equal(plan.firstgid, 5);
  assert.equal(plan.lastgid, 12);
  assert.equal(plan.tileCount, 8);
  assert.deepEqual({
    type: plan.reference.type,
    image: plan.reference.image,
    tilewidth: plan.reference.tilewidth,
    tileheight: plan.reference.tileheight,
    columns: plan.reference.columns,
    tilecount: plan.reference.tilecount,
  }, {
    type: "tileset",
    image: "../assets/generated/tilesets/forest.png",
    tilewidth: 16,
    tileheight: 16,
    columns: 4,
    tilecount: 8,
  });

  const editor = new TiledEditDocument(document);
  editor.addTileset(plan.reference, { label: "应用 AI 瓦片集草稿" });
  assert.equal(editor.undoStack.at(-1).reloadTilesets, true);
  assert.equal(editor.document.tilesets[0].image, "../assets/generated/tilesets/forest.png");
  assert.equal(tiledValueHasMapImageApplication(
    editor.document.tilesets[0],
    publishedMapImageApplicationId(tilesetJob, published, "tileset-draft"),
  ), true);
  editor.undo();
  assert.deepEqual(editor.document.tilesets, []);
  assert.deepEqual(editor.document.futureMapField, { keep: [1, 2] });
});

test("converts a published image into a native scalable and rotatable Tiled tile object", () => {
  const document = mapDocument();
  const published = {
    relativePath: "assets/generated/props/tree.png",
    width: 48,
    height: 64,
    sha256,
  };
  const plan = planPublishedMapTileObject({
    mapPath: "maps/world.tmj",
    published,
    job,
    document,
    selectionTarget: { target: { world: { x: 80, y: 32, width: 48, height: 64 } } },
    name: "Tree",
  });
  assert.equal(plan.tileset.firstgid, 1);
  assert.equal(plan.tileset.objectalignment, "topleft");
  assert.equal(plan.tileset.columns, 0);
  assert.equal(plan.tileset.tiles[0].image, "../assets/generated/props/tree.png");
  assert.deepEqual({
    gid: plan.object.gid,
    x: plan.object.x,
    y: plan.object.y,
    width: plan.object.width,
    height: plan.object.height,
    rotation: plan.object.rotation,
  }, { gid: 1, x: 80, y: 32, width: 48, height: 64, rotation: 0 });

  const editor = new TiledEditDocument(document);
  const applied = editor.runBatch("创建可缩放图片对象", (owner) => {
    owner.addTileset(plan.tileset);
    const layer = owner.addLayer(plan.layer);
    const object = owner.addObject(layer.id, plan.object);
    return { layer, object };
  });
  assert.equal(applied.changed, true);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.equal(editor.document.tilesets[0].tiles[0].image, "../assets/generated/props/tree.png");
  const objectLayer = editor.layerById(applied.result.layer.id);
  assert.equal(objectLayer.objects[0].gid, 1);
  assert.equal(tiledValueHasMapImageApplication(
    objectLayer.objects[0],
    publishedMapImageApplicationId(job, published, "tile-object"),
  ), true);
  editor.updateObject(objectLayer.id, objectLayer.objects[0].id, {
    width: 96,
    height: 128,
    rotation: 30,
  });
  assert.deepEqual({
    width: objectLayer.objects[0].width,
    height: objectLayer.objects[0].height,
    rotation: objectLayer.objects[0].rotation,
  }, { width: 96, height: 128, rotation: 30 });
  editor.undo();
  assert.equal(objectLayer.objects[0].width, 48);
  editor.undo();
  assert.equal(editor.document.tilesets.length, 0);
  assert.equal(editor.layerById(objectLayer.id), null);
});

test("two serialized tileset candidates allocate non-overlapping GIDs from current drafts", () => {
  const document = mapDocument();
  const editor = new TiledEditDocument(document);
  const staleViewerRanges = [{ firstgid: 1, maxLocalId: 3, definition: { name: "Existing" } }];
  editor.document.tilesets.push({
    firstgid: 1,
    type: "tileset",
    name: "Existing",
    tilewidth: 16,
    tileheight: 16,
    tilecount: 4,
    columns: 2,
    image: "../assets/existing.png",
    imagewidth: 32,
    imageheight: 32,
  });
  const first = planPublishedMapTilesetDraft({
    mapPath: "maps/world.tmj",
    published: {
      relativePath: "assets/generated/tilesets/first.png", width: 32, height: 32, sha256: "b".repeat(64),
    },
    job: { id: "tileset-first", request: { operation: "generate", assetKind: "tileset" } },
    document: editor.document,
    existingTilesets: staleViewerRanges,
  });
  editor.addTileset(first.reference);
  const second = planPublishedMapTilesetDraft({
    mapPath: "maps/world.tmj",
    published: {
      relativePath: "assets/generated/tilesets/second.png", width: 64, height: 32, sha256: "c".repeat(64),
    },
    job: { id: "tileset-second", request: { operation: "generate", assetKind: "tileset" } },
    document: editor.document,
    // Deliberately stale: the first draft has not reached the viewer yet.
    existingTilesets: staleViewerRanges,
  });
  assert.deepEqual({ first: first.firstgid, firstLast: first.lastgid }, { first: 5, firstLast: 8 });
  assert.deepEqual({ second: second.firstgid, secondLast: second.lastgid }, { second: 9, secondLast: 16 });
  editor.addTileset(second.reference);
  assert.deepEqual(editor.document.tilesets.map(({ firstgid }) => firstgid), [1, 5, 9]);
});

test("tileset drafts require exact tile alignment", () => {
  assert.throws(
    () => planPublishedMapTilesetDraft({
      mapPath: "maps/world.tmj",
      published: { relativePath: "assets/generated/tilesets/forest.png", width: 65, height: 32, sha256 },
      job,
      document: mapDocument(),
    }),
    (error) => error.code === "MAP_IMAGE_TILESET_ALIGNMENT",
  );
});

test("terrain candidates remain external images and apply through the image-layer path", () => {
  const terrainJob = {
    id: "map-job-terrain",
    request: { operation: "generate", assetKind: "terrain", prompt: "periodic forest ground" },
  };
  const published = {
    relativePath: "assets/generated/terrain/forest.png",
    width: 1024,
    height: 1024,
    sha256,
  };
  const plan = planPublishedMapImageLayer({
    mapPath: "maps/world.tmj",
    published,
    job: terrainJob,
    name: "Forest terrain",
  });
  assert.equal(plan.layer.image, "../assets/generated/terrain/forest.png");
  assert.equal(plan.layer.type, "imagelayer");
  assert.equal(tiledValueHasMapImageApplication(
    plan.layer,
    publishedMapImageApplicationId(terrainJob, published, "image-layer"),
  ), true);
});

test("grant metadata must still identify the exact published candidate bytes", () => {
  const published = {
    relativePath: "assets/generated/terrain/forest.png",
    width: 1024,
    height: 1024,
    sha256,
    format: "png",
  };
  assert.deepEqual(validatePublishedMapImageGrant(published, {
    path: published.relativePath,
    kind: "image",
    width: published.width,
    height: published.height,
    sha256: published.sha256,
    format: published.format,
    mediaType: "image/png",
    size: 4096,
  }), {
    relativePath: published.relativePath,
    width: 1024,
    height: 1024,
    sha256,
    format: "png",
    mediaType: "image/png",
    size: 4096,
  });
  for (const changed of [
    { sha256: "d".repeat(64) },
    { width: 512 },
    { height: 512 },
    { format: "webp" },
    { path: "assets/generated/terrain/replaced.png" },
  ]) {
    assert.throws(
      () => validatePublishedMapImageGrant(published, {
        path: published.relativePath,
        width: published.width,
        height: published.height,
        sha256: published.sha256,
        format: published.format,
        ...changed,
      }),
      (error) => error.code === "MAP_IMAGE_PUBLISHED_RESOURCE_CHANGED",
    );
  }
});

test("map candidate UI requires publication before explicit local-first application", async () => {
  const [html, source, css, packageSource] = await Promise.all([
    fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../lib/package-source.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(html, /先发布工程文件，再明确加入图片层或瓦片集草稿/u);
  assert.match(source, /if \(published\?\.relativePath\) \{/u);
  assert.match(source, /data.*mapImageApply|dataset\.mapImageApply/u);
  assert.match(source, /await mapMutation\([\s\S]*?\/assets\/grant[\s\S]*?state\.editor\.addLayer/u);
  assert.match(source, /state\.editor\.addTileset\(plan\.reference/u);
  assert.match(source, /dataset\.mapImageApply = "image-layer-replace"/u);
  assert.match(source, /state\.editor\.updateLayer\(plan\.layerId, plan\.changes/u);
  assert.match(source, /function renderMapImageComparison\(job\)/u);
  assert.match(source, /\["side-by-side", "并排"\], \["overlay", "滑动叠加"\]/u);
  assert.match(source, /\["plant", "prop", "tileset", "terrain", "background"\]\.includes\(job\?\.request\?\.assetKind\)/u);
  assert.match(source, /return mapImageAssetPreset\(kind\)\.label/u);
  assert.match(source, /function setMapImageJobs[\s\S]*?job\.selectionTarget\?\.schema[\s\S]*?mapImageSelectionTargets\.set/u);
  assert.match(source, /job\?\.selectionTarget && state\.editor\?\.dirty/u);
  assert.doesNotMatch(source, /targetStateId !== state\.editor\?\.headStateId/u);
  assert.match(source, /mapImageApplyQueue[\s\S]*?performPublishedMapImageApplication/u);
  assert.match(source, /validatePublishedMapImageGrant\(published, granted\?\.resource\)/u);
  assert.match(source, /已进入撤销栈，尚未保存地图/u);
  const applyBody = source.slice(
    source.indexOf("async function applyPublishedMapImage"),
    source.indexOf("async function loadMapImagePreview"),
  );
  assert.doesNotMatch(applyBody, /saveMap\(/u);
  assert.match(css, /\.map-image-candidate-actions/u);
  assert.match(css, /\.map-image-comparison-viewport\.is-overlay/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.map-image-candidate-actions/u);
  assert.match(packageSource, /public\/map-editor\/map-image-apply\.js/u);
});
