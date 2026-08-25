import assert from "node:assert/strict";
import test from "node:test";
import {
  compactTiledTemplateInstance,
  createTiledTemplateDocument,
  createTiledTileObjectTemplateDocument,
  materializeTiledTemplate,
  mergeTiledTemplateObject,
  parseTiledTemplate,
  refreshTiledTemplateInstance,
  templateObjectBounds,
  unbindTiledTemplate,
} from "../public/map-editor/tiled-template.js";

const template = parseTiledTemplate({
  type: "template",
  object: {
    id: 1,
    name: "Portal",
    class: "Portal",
    x: 0,
    y: 0,
    width: 16,
    height: 20,
    visible: true,
    properties: [
      { name: "targetMap", type: "file", value: "../maps/world.tmj" },
      { name: "targetSpawn", type: "string", value: "Arrival" },
    ],
    futureObjectField: { keep: true },
  },
}, { sourcePath: "templates/portal.tx" });

test("parses a Tiled template without dropping unknown fields", () => {
  assert.equal(template.sourcePath, "templates/portal.tx");
  assert.equal(template.object.class, "Portal");
  assert.deepEqual(template.object.futureObjectField, { keep: true });
  assert.equal(Object.isFrozen(template.object), true);
  assert.throws(
    () => parseTiledTemplate({ type: "map", object: {} }),
    (error) => error.code === "TILED_TEMPLATE_INVALID",
  );
});

test("compacts inherited values and refreshes only non-overridden template defaults", () => {
  const effective = materializeTiledTemplate(template, {
    name: "Custom portal",
    properties: [{ name: "targetSpawn", type: "string", value: "Exit" }],
  }, {
    id: 8,
    x: 40,
    y: 50,
    targetPath: "maps/world.tmj",
  });
  const compact = compactTiledTemplateInstance(template, effective);
  assert.deepEqual(compact, {
    id: 8,
    x: 40,
    y: 50,
    template: "../templates/portal.tx",
    name: "Custom portal",
    properties: [{ name: "targetSpawn", type: "string", value: "Exit" }],
  });
  const next = parseTiledTemplate({
    type: "template",
    object: {
      ...structuredClone(template.object),
      width: 24,
      name: "Updated default",
      properties: [
        { name: "targetMap", type: "file", value: "../maps/next.tmj" },
        { name: "targetSpawn", type: "string", value: "Arrival" },
      ],
    },
  }, { sourcePath: "templates/portal.tx" });
  const refreshed = refreshTiledTemplateInstance(template, next, effective, {
    targetPath: "maps/world.tmj",
    templatePath: "templates/portal.tx",
  });
  assert.equal(refreshed.width, 24);
  assert.equal(refreshed.name, "Custom portal");
  assert.deepEqual(refreshed.properties, [
    { name: "targetMap", type: "file", value: "../maps/next.tmj" },
    { name: "targetSpawn", type: "string", value: "Exit" },
  ]);
});

test("materializes template defaults and rewrites template references for a map", () => {
  const instance = materializeTiledTemplate(template, {
    properties: [{ name: "targetSpawn", type: "string", value: "Exit" }],
    futureOverride: 4,
  }, {
    id: 7,
    x: 32,
    y: 48,
    targetPath: "maps/world.tmj",
  });
  assert.equal(instance.id, 7);
  assert.equal(instance.template, "../templates/portal.tx");
  assert.equal(instance.x, 32);
  assert.deepEqual(instance.properties, [
    { name: "targetMap", type: "file", value: "../maps/world.tmj" },
    { name: "targetSpawn", type: "string", value: "Exit" },
  ]);
  assert.deepEqual(instance.futureObjectField, { keep: true });
  assert.equal(instance.futureOverride, 4);
  assert.deepEqual(templateObjectBounds(template), { x: 0, y: 0, width: 16, height: 20 });
});

test("supports unbinding and rejects malformed property overrides", () => {
  const unbound = unbindTiledTemplate(template, { x: 10 }, { id: 3 });
  assert.equal(Object.hasOwn(unbound, "template"), false);
  assert.equal(unbound.id, 3);
  assert.throws(
    () => mergeTiledTemplateObject(template.object, { properties: "invalid" }),
    (error) => error.code === "TILED_TEMPLATE_PROPERTIES_INVALID",
  );
});

test("creates a standalone template and rewrites nested file properties relative to the .tx file", () => {
  const document = createTiledTemplateDocument({
    id: 48,
    name: "Exit",
    x: 320,
    y: 96,
    width: 20,
    height: 30,
    template: "../templates/old.tx",
    properties: [
      { name: "target", type: "file", value: "next/world.tmj", future: true },
      {
        name: "settings",
        type: "class",
        value: {
          soundtrack: { type: "file", value: "../audio/forest.ogg", futureNested: 2 },
        },
      },
    ],
    futureObjectField: { keep: true },
  }, {
    sourcePath: "maps/forest.tmj",
    templatePath: "templates/objects/exit.tx",
  });
  assert.equal(document.type, "template");
  assert.equal(document.object.id, 1);
  assert.equal(Object.hasOwn(document.object, "x"), false);
  assert.equal(Object.hasOwn(document.object, "y"), false);
  assert.equal(Object.hasOwn(document.object, "template"), false);
  assert.equal(document.object.properties[0].value, "../../maps/next/world.tmj");
  assert.equal(document.object.properties[1].value.soundtrack.value, "../../audio/forest.ogg");
  assert.deepEqual(document.object.futureObjectField, { keep: true });
  assert.equal(document.object.properties[0].future, true);
});

test("creates an external-TSJ tile object template with a local GID and preserved flip flags", () => {
  const document = createTiledTileObjectTemplateDocument({
    id: 17,
    name: "Flipped tree",
    gid: (0x8000_0000 | 106) >>> 0,
    x: 64,
    y: 80,
    visible: true,
    futureObjectField: { keep: true },
  }, {
    sourcePath: "maps/forest.tmj",
    templatePath: "templates/props/tree.tx",
    sourceTileset: {
      firstgid: 100,
      maxLocalId: 31,
      sourcePath: "tiles/forest.tsj",
      definition: { type: "tileset", name: "Forest", tilecount: 32 },
    },
  });
  assert.equal(document.type, "template");
  assert.equal(document.object.gid, (0x8000_0000 | 7) >>> 0);
  assert.equal(document.object.id, 1);
  assert.equal(Object.hasOwn(document.object, "x"), false);
  assert.equal(Object.hasOwn(document.object, "y"), false);
  assert.deepEqual(document.tileset, { firstgid: 1, source: "../../tiles/forest.tsj" });
  assert.deepEqual(document.object.futureObjectField, { keep: true });
});

test("embeds a tile object template tileset without dropping forward-compatible fields", () => {
  const document = createTiledTileObjectTemplateDocument({
    id: 3,
    gid: 5,
    x: 8,
    y: 16,
  }, {
    sourcePath: "maps/room.tmj",
    templatePath: "templates/crate.tx",
    sourceTileset: {
      firstgid: 4,
      maxLocalId: 2,
      definition: {
        type: "tileset",
        name: "Embedded",
        tilewidth: 16,
        tileheight: 16,
        tilecount: 3,
        futureTilesetField: { keep: true },
      },
    },
  });
  assert.equal(document.object.gid, 2);
  assert.equal(document.tileset.firstgid, 1);
  assert.equal(document.tileset.name, "Embedded");
  assert.deepEqual(document.tileset.futureTilesetField, { keep: true });
  assert.throws(
    () => createTiledTileObjectTemplateDocument({ id: 1, gid: 8 }, {
      sourcePath: "maps/room.tmj",
      templatePath: "templates/bad.tx",
      sourceTileset: { firstgid: 4, maxLocalId: 2, definition: { type: "tileset" } },
    }),
    (error) => error.code === "TILED_TEMPLATE_TILE_GID_UNMAPPED",
  );
});
