import assert from "node:assert/strict";
import test from "node:test";
import {
  createMapAssetLibrary,
  mapAssetDependencySummary,
  parseMapAssetLibrary,
  searchMapAssets,
  serializeMapAssetLibrary,
  setMapAssetFavorite,
  touchMapAsset,
  upsertMapAsset,
} from "../public/map-editor/map-asset-library.js";

test("indexes project images, TSJ, templates and composite maps with search and dependencies", () => {
  let library = createMapAssetLibrary({ projectPath: "/srv/project" });
  library = upsertMapAsset(library, {
    path: "images/grass.png", name: "Grass", kind: "image", width: 32, height: 32, tags: ["植物"],
  }, 10);
  library = upsertMapAsset(library, {
    path: "tiles/terrain.tsj", name: "Terrain", kind: "tileset",
    dependencies: ["images/grass.png", "images/grass.png"],
  }, 11);
  library = upsertMapAsset(library, {
    path: "templates/portal.tx", name: "Portal", kind: "template", tags: ["传送点"],
  }, 12);
  library = upsertMapAsset(library, {
    path: "composites/pond.tmj", name: "Pond", kind: "composite-map",
    dependencies: ["images/grass.png", "tiles/terrain.tsj"],
  }, 13);
  library = setMapAssetFavorite(library, "templates/portal.tx", true, 14);
  library = touchMapAsset(library, "images/grass.png", 15);
  assert.deepEqual(searchMapAssets(library, "植物").map((entry) => entry.path), ["images/grass.png"]);
  assert.deepEqual(searchMapAssets(library, "", { favoritesOnly: true }).map((entry) => entry.path), ["templates/portal.tx"]);
  assert.deepEqual(searchMapAssets(library, "", { kinds: ["template", "composite-map"] }).map((entry) => entry.path), [
    "composites/pond.tmj", "templates/portal.tx",
  ]);
  assert.deepEqual(mapAssetDependencySummary(library.entries.get("tiles/terrain.tsj")), {
    count: 1,
    paths: ["images/grass.png"],
    text: "1 个依赖",
  });
  const restored = parseMapAssetLibrary(serializeMapAssetLibrary(library));
  assert.equal(restored.entries.get("templates/portal.tx").favorite, true);
  assert.equal(restored.entries.get("images/grass.png").lastUsedAt, 15);
});

test("rejects unsafe asset paths and missing favorite targets", () => {
  assert.throws(
    () => upsertMapAsset(createMapAssetLibrary(), { path: "../escape.png", kind: "image" }),
    (error) => error.code === "MAP_ASSET_INVALID",
  );
  assert.throws(
    () => setMapAssetFavorite(createMapAssetLibrary(), "missing.png", true),
    (error) => error.code === "MAP_ASSET_NOT_FOUND",
  );
});
