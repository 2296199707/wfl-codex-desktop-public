import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { planTiledTilesetImport } from "../public/map-editor/tiled-tileset-import.js";

const definition = {
  type: "tileset",
  name: "Terrain",
  tilewidth: 16,
  tileheight: 16,
  tilecount: 4,
  columns: 2,
  image: "../images/terrain.png",
  imagewidth: 32,
  imageheight: 32,
};

test("plans a safe TSJ reference with dependencies and next firstgid", () => {
  const result = planTiledTilesetImport({
    mapPath: "maps/world.tmj",
    resourcePath: "tiles/terrain.tsj",
    definition,
    dependencies: [{ path: "images/terrain.png", width: 32, height: 32 }],
    existingTilesets: [{ firstgid: 1, maxLocalId: 7 }],
  });
  assert.deepEqual(result.reference, { firstgid: 9, source: "../tiles/terrain.tsj" });
  assert.deepEqual(result.dependencyPaths, ["tiles/terrain.tsj", "images/terrain.png"]);
  assert.deepEqual(result.layout, {
    kind: "atlas", tileWidth: 16, tileHeight: 16, tileCount: 4, maxLocalId: 3,
  });
  assert.equal(result.reusedExisting, false);
});

test("reuses an already referenced external TSJ instead of allocating a second GID range", () => {
  const result = planTiledTilesetImport({
    mapPath: "maps/world.tmj",
    resourcePath: "tiles/terrain.tsj",
    definition,
    existingTilesets: [{
      firstgid: 40,
      maxLocalId: 3,
      ownerPath: "tiles/terrain.tsj",
    }],
  });
  assert.equal(result.firstgid, 40);
  assert.equal(result.reusedExisting, true);
  assert.deepEqual(result.reference, { firstgid: 40, source: "../tiles/terrain.tsj" });
});

test("uses catalog image dimensions and rejects missing atlas dimensions", () => {
  const withoutDeclaredDimensions = { ...definition };
  delete withoutDeclaredDimensions.imagewidth;
  delete withoutDeclaredDimensions.imageheight;
  assert.doesNotThrow(() => planTiledTilesetImport({
    mapPath: "maps/world.tmj",
    resourcePath: "tiles/terrain.tsj",
    definition: withoutDeclaredDimensions,
    dependencies: [{ path: "images/terrain.png", width: 32, height: 32 }],
  }));
  assert.throws(
    () => planTiledTilesetImport({
      mapPath: "maps/world.tmj",
      resourcePath: "tiles/terrain.tsj",
      definition: withoutDeclaredDimensions,
    }),
    (error) => error.code === "missing-image-size",
  );
});

test("keeps all existing ranges and rejects unsafe paths", () => {
  assert.throws(
    () => planTiledTilesetImport({
      mapPath: "maps/world.tmj",
      resourcePath: "../tiles/terrain.tsj",
      definition,
    }),
    (error) => error.code === "TILED_IMPORT_PATH_INVALID",
  );
  assert.throws(
    () => planTiledTilesetImport({
      mapPath: "maps/world.tmj",
      resourcePath: "tiles/terrain.tsj",
      definition,
      existingTilesets: [{ firstgid: 0x0fff_fffe, maxLocalId: 1 }],
    }),
    (error) => error.code === "tileset-gid-space-exhausted",
  );
});

test("map editor wires the TSJ picker through dependency authorization and palette reload", async () => {
  const [html, source] = await Promise.all([
    fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  ]);
  for (const id of [
    "addTilesetButton",
    "tilesetAssetDialog",
    "tilesetAssetList",
    "importTilesetButton",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"));
    assert.match(source, new RegExp(`\\b${id}\\b`, "u"));
  }
  assert.match(source, /expectedKind:\s*"tileset"/u);
  assert.match(source, /state\.editor\.addTileset\(plan\.reference/u);
  assert.match(source, /scheduleLayerTreeRebuild\(state\.activeLayerId, \{ reloadTilesets: true \}\)/u);
  assert.match(source, /renderTilePalette\(\)/u);
});
