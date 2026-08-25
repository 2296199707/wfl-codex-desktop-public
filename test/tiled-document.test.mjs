import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TiledDocumentError,
  cloneTiledDocument,
  collectTiledReferences,
  parseTiledDocument,
  relativeTiledProjectReference,
  resolveTiledProjectReference,
  serializeTiledDocument,
  tiledLayerEntries,
  validateTiledDocument,
} from "../public/map-editor/tiled-document.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(testDirectory, "fixtures", "tiled");

async function fixture(...segments) {
  return fs.readFile(path.join(fixtureDirectory, ...segments), "utf8");
}

test("round-trips Tiled maps without dropping unknown fields", async () => {
  const source = await fixture("maps", "world.tmj");
  const parsed = parseTiledDocument(source, {
    expectedKind: "map",
    sourcePath: "maps/world.tmj",
  });

  assert.equal(parsed.kind, "map");
  assert.deepEqual(parsed.diagnostics.map(({ feature }) => feature), []);
  assert.equal(parsed.document.wflUnknownRoot.nested[2].three, true);
  assert.equal(parsed.document.layers[0].wflUnknownLayerField.keep, true);

  const serialized = serializeTiledDocument(parsed);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), JSON.parse(source));
});

test("models groups, gameplay objects, collisions, and external references", async () => {
  const map = parseTiledDocument(await fixture("maps", "world.tmj"), {
    sourcePath: "maps/world.tmj",
  });
  const layers = [...tiledLayerEntries(map.document)];
  assert.deepEqual(layers.map(({ layer }) => layer.name), [
    "Ground",
    "Gameplay",
    "Backdrop",
    "Collision",
    "CollisionIntGrid",
  ]);
  assert.equal(layers.at(-1).parent.layer.name, "Collision");

  const references = collectTiledReferences(map);
  assert.deepEqual(
    references.map(({ kind, resolvedPath }) => [kind, resolvedPath]),
    [
      ["file-property", "maps/town.tmj"],
      ["image", "images/background.png"],
      ["tileset", "tiles/world.tsj"],
    ],
  );

  const tileset = parseTiledDocument(await fixture("tiles", "world.tsj"), {
    expectedKind: "tileset",
    sourcePath: "tiles/world.tsj",
  });
  assert.equal(tileset.document.tiles[0].objectgroup.objects[0].type, "collision");
  assert.equal(tileset.document.wflUnknownTilesetField, "preserve-me");
  assert.equal(collectTiledReferences(tileset)[0].resolvedPath, "images/terrain.png");
});

test("clones documents before editing and leaves the parsed source untouched", async () => {
  const parsed = parseTiledDocument(await fixture("maps", "world.tmj"), {
    sourcePath: "maps/world.tmj",
  });
  const editable = cloneTiledDocument(parsed);
  editable.layers[0].name = "Edited";
  editable.wflUnknownRoot.nested.push("new-value");
  assert.equal(parsed.document.layers[0].name, "Ground");
  assert.equal(parsed.document.wflUnknownRoot.nested.length, 3);
});

test("rejects embedded and escaping resources while accepting project-relative parents", () => {
  assert.equal(
    resolveTiledProjectReference("maps/region/world.tmj", "../../tiles/world.tsj"),
    "tiles/world.tsj",
  );
  assert.throws(
    () => resolveTiledProjectReference("maps/world.tmj", "../../secret.png"),
    /不能离开工程目录/,
  );

  const embeddedImage = {
    type: "map",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ id: 1, name: "Image", type: "imagelayer", image: "data:image/png;base64,AA==" }],
    tilesets: [],
  };
  const diagnostics = validateTiledDocument(embeddedImage, { sourcePath: "maps/world.tmj" });
  assert.equal(diagnostics.some(({ code }) => code === "embedded-image"), true);
  assert.throws(
    () => parseTiledDocument(JSON.stringify(embeddedImage), { sourcePath: "maps/world.tmj" }),
    (error) => error instanceof TiledDocumentError && error.diagnostics.some(({ code }) => code === "embedded-image"),
  );
});

test("creates safe POSIX Tiled references from project-relative file paths", () => {
  assert.equal(
    relativeTiledProjectReference("maps/region/world.tmj", "assets/terrain/grass.png"),
    "../../assets/terrain/grass.png",
  );
  assert.equal(
    relativeTiledProjectReference("maps/world.tmj", "maps/background.png"),
    "background.png",
  );
  assert.equal(
    relativeTiledProjectReference("tiles/world.tsj", "images/terrain.png"),
    "../images/terrain.png",
  );
  assert.equal(
    resolveTiledProjectReference(
      "maps/region/world.tmj",
      relativeTiledProjectReference("maps/region/world.tmj", "assets/terrain/grass.png"),
    ),
    "assets/terrain/grass.png",
  );
});

test("rejects unsafe or directory paths when creating Tiled references", () => {
  for (const [sourcePath, targetPath] of [
    ["/maps/world.tmj", "assets/grass.png"],
    ["maps/world.tmj", "https://example.test/grass.png"],
    ["maps/world.tmj", "data:image/png;base64,AA=="],
    ["../maps/world.tmj", "assets/grass.png"],
    ["maps/world.tmj", "../assets/grass.png"],
    ["maps/world.tmj", "assets/"],
    ["maps/", "assets/grass.png"],
    ["maps\\world.tmj", "assets/grass.png"],
    ["maps/world.json", "assets/grass.png"],
  ]) {
    assert.throws(() => relativeTiledProjectReference(sourcePath, targetPath), TypeError);
  }
});

test("preserves forward-compatible layer data and reports it as a warning", () => {
  const document = {
    type: "map",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ id: 1, name: "Future", type: "futurelayer", futurePayload: { value: 42 } }],
    tilesets: [],
  };
  const parsed = parseTiledDocument(JSON.stringify(document), { sourcePath: "future.tmj" });
  assert.equal(parsed.diagnostics[0].code, "unknown-layer-type");
  assert.equal(parsed.document.layers[0].futurePayload.value, 42);
  assert.equal(JSON.parse(serializeTiledDocument(parsed)).layers[0].futurePayload.value, 42);
});

test("validates projected map parameters while preserving future orientations", async () => {
  const source = JSON.parse(await fixture("maps", "world.tmj"));
  source.orientation = "future-grid";
  let diagnostics = validateTiledDocument(source, { expectedKind: "map", sourcePath: "maps/world.tmj" });
  assert.equal(diagnostics.some((entry) => entry.code === "unknown-map-orientation" && entry.severity === "warning"), true);
  assert.equal(diagnostics.some((entry) => entry.severity === "error"), false);

  source.orientation = "hexagonal";
  source.staggeraxis = "z";
  source.staggerindex = "middle";
  source.hexsidelength = source.tilewidth + 1;
  diagnostics = validateTiledDocument(source, { expectedKind: "map", sourcePath: "maps/world.tmj" });
  assert.deepEqual(
    diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code),
    ["invalid-stagger-axis", "invalid-stagger-index", "invalid-hex-side-length"],
  );

  source.orientation = "oblique";
  source.skewx = source.tileheight;
  source.skewy = source.tilewidth;
  diagnostics = validateTiledDocument(source, { expectedKind: "map", sourcePath: "maps/world.tmj" });
  assert.equal(diagnostics.some((entry) => entry.code === "singular-oblique-projection"), true);
});

test("rejects duplicate tileset IDs, unsafe integers, and malformed animation frames", () => {
  const tileset = {
    type: "tileset",
    tilewidth: 16,
    tileheight: 16,
    tilecount: 2,
    columns: 2,
    tiles: [
      { id: 1, animation: [{ tileid: 0, duration: 100 }] },
      { id: 1, animation: [{ tileid: -1, duration: 0 }] },
    ],
  };
  let diagnostics = validateTiledDocument(tileset, { expectedKind: "tileset", sourcePath: "tiles/world.tsj" });
  assert.deepEqual(
    diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code),
    ["duplicate-tile-id", "invalid-non-negative-integer", "invalid-positive-integer"],
  );

  tileset.tiles = [];
  tileset.tilecount = Number.MAX_SAFE_INTEGER + 1;
  diagnostics = validateTiledDocument(tileset, { expectedKind: "tileset", sourcePath: "tiles/world.tsj" });
  assert.equal(diagnostics.some((entry) => entry.path === "$.tilecount" && entry.severity === "error"), true);
});
