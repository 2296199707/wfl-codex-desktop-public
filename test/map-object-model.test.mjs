import assert from "node:assert/strict";
import test from "node:test";

import {
  TILED_COLLISION_SHAPES,
  TILED_OBJECT_SHAPES,
  createTiledMapObject,
  insertTiledObjectVertex,
  planTiledObjectArrangement,
  planTiledObjectResize,
  planTiledObjectRotation,
  removeTiledObjectVertex,
  suggestedTiledObjectVertex,
  tiledObjectPropertyValue,
  tiledObjectSemantic,
  tiledObjectShape,
  tiledPortalReference,
  tiledSpawnIdentifier,
  updateTiledObjectVertex,
} from "../public/map-editor/map-object-model.js";

const RECT = { x: 10, y: 20, width: 30, height: 40 };

test("creates all eight Tiled object shapes without private transform fields", () => {
  assert.deepEqual(TILED_OBJECT_SHAPES, [
    "rectangle", "point", "ellipse", "capsule", "polygon", "polyline", "tile", "text",
  ]);
  for (const shape of TILED_OBJECT_SHAPES) {
    const object = createTiledMapObject({
      shape,
      rect: RECT,
      ...(shape === "tile" ? { gid: 7, tileAlignment: "bottomleft" } : {}),
    });
    assert.equal(tiledObjectShape(object), shape);
    assert.equal(Object.hasOwn(object, "scale"), false);
    assert.equal(Object.hasOwn(object, "scaleX"), false);
    assert.equal(Object.hasOwn(object, "scaleY"), false);
  }
});

test("uses standard shape fields and Tiled tile-object alignment", () => {
  assert.deepEqual(createTiledMapObject({ shape: "point", rect: RECT }), {
    class: "Object", height: 0, name: "Point", point: true, rotation: 0,
    type: "", visible: true, width: 0, x: 10, y: 20,
  });
  const polygon = createTiledMapObject({ shape: "polygon", rect: RECT });
  assert.deepEqual(polygon.polygon, [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 },
  ]);
  assert.equal(polygon.width, 0);
  assert.equal(polygon.height, 0);
  const polyline = createTiledMapObject({ shape: "polyline", rect: RECT });
  assert.deepEqual(polyline.polyline, [{ x: 0, y: 0 }, { x: 30, y: 40 }]);
  const tile = createTiledMapObject({ shape: "tile", rect: RECT, gid: 7, tileAlignment: "center" });
  assert.equal(tile.x, 25);
  assert.equal(tile.y, 40);
  assert.equal(tile.gid, 7);
  assert.equal(tile.width, 30);
  assert.equal(tile.height, 40);
});

test("creates full text defaults and game semantic presets using standard Tiled fields", () => {
  const textObject = createTiledMapObject({ shape: "text", rect: RECT });
  assert.deepEqual(textObject.text, {
    bold: false,
    color: "#ff000000",
    fontfamily: "sans-serif",
    halign: "left",
    italic: false,
    kerning: true,
    pixelsize: 16,
    strikeout: false,
    text: "Text",
    underline: false,
    valign: "top",
    wrap: true,
  });

  const spawn = createTiledMapObject({ shape: "rectangle", semantic: "spawn", rect: RECT });
  assert.equal(tiledObjectShape(spawn), "point");
  assert.equal(spawn.class, "SpawnPoint");
  assert.deepEqual(spawn.properties, [{ name: "spawnId", type: "string", value: "" }]);

  const portal = createTiledMapObject({ shape: "ellipse", semantic: "portal", rect: RECT });
  assert.equal(portal.ellipse, true);
  assert.deepEqual(portal.properties, [
    { name: "targetMap", type: "string", value: "" },
    { name: "targetSpawn", type: "string", value: "" },
  ]);
});

test("restricts collision shapes and rejects invalid tile object inputs", () => {
  assert.deepEqual(TILED_COLLISION_SHAPES, ["rectangle", "ellipse", "capsule", "polygon", "polyline"]);
  for (const shape of TILED_COLLISION_SHAPES) {
    const collision = createTiledMapObject({ shape, semantic: "collision", rect: RECT });
    assert.equal(collision.class, "Collision");
    assert.equal(collision.type, "collision");
  }
  assert.throws(
    () => createTiledMapObject({ shape: "text", semantic: "collision", rect: RECT }),
    (error) => error.code === "invalid-collision-shape",
  );
  assert.throws(
    () => createTiledMapObject({ shape: "tile", rect: RECT }),
    (error) => error.code === "tile-gid-required",
  );
  assert.throws(
    () => createTiledMapObject({ shape: "tile", rect: RECT, gid: 1, tileAlignment: "outside" }),
    (error) => error.code === "invalid-tile-alignment",
  );
});

test("plans alignment and equal-gap distribution from actual object bounds", () => {
  const records = [
    { id: 1, x: 10, y: 20, bounds: { x: 8, y: 18, width: 12, height: 10 } },
    { id: 2, x: 40, y: 30, bounds: { x: 40, y: 30, width: 20, height: 20 } },
    { id: 3, x: 90, y: 60, bounds: { x: 88, y: 58, width: 12, height: 10 } },
  ];
  assert.deepEqual(planTiledObjectArrangement(records, "left"), [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 8, y: 30 },
    { id: 3, x: 10, y: 60 },
  ]);
  assert.deepEqual(planTiledObjectArrangement(records, "bottom"), [
    { id: 1, x: 10, y: 60 },
    { id: 2, x: 40, y: 48 },
    { id: 3, x: 90, y: 60 },
  ]);
  assert.deepEqual(planTiledObjectArrangement(records, "distribute-x"), [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 44, y: 30 },
    { id: 3, x: 90, y: 60 },
  ]);
  assert.throws(
    () => planTiledObjectArrangement(records.slice(0, 2), "distribute-y"),
    (error) => error.code === "object-arrangement-count",
  );
});

test("updates, inserts, and removes relative Tiled polygon and polyline vertices", () => {
  const polygon = createTiledMapObject({ shape: "polygon", rect: RECT });
  assert.deepEqual(updateTiledObjectVertex(polygon, 1, { x: 34.5, y: -2 }).polygon[1], { x: 34.5, y: -2 });
  const suggestedPolygon = suggestedTiledObjectVertex(polygon);
  assert.deepEqual(suggestedPolygon, { index: 4, point: { x: 0, y: 20 } });
  const inserted = insertTiledObjectVertex(polygon, suggestedPolygon.index, suggestedPolygon.point);
  assert.equal(inserted.polygon.length, 5);
  assert.equal(removeTiledObjectVertex({ ...polygon, polygon: inserted.polygon }, 4).polygon.length, 4);
  assert.throws(
    () => removeTiledObjectVertex({ polygon: polygon.polygon.slice(0, 3) }, 1),
    (error) => error.code === "object-vertex-minimum",
  );

  const polyline = createTiledMapObject({ shape: "polyline", rect: RECT });
  assert.deepEqual(suggestedTiledObjectVertex(polyline), { index: 2, point: { x: 60, y: 80 } });
  assert.throws(
    () => removeTiledObjectVertex(polyline, 0),
    (error) => error.code === "object-vertex-minimum",
  );
});

test("plans standard-field resize and rotation for mixed object selections", () => {
  const objects = [
    { id: 1, x: 10, y: 20, width: 20, height: 10, rotation: 0 },
    { id: 2, x: 40, y: 40, width: 0, height: 0, polygon: [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 10 }] },
  ];
  assert.deepEqual(planTiledObjectResize(
    objects,
    { x: 10, y: 20, width: 40, height: 30 },
    { x: 5, y: 10, width: 80, height: 60 },
  ), [
    { id: 1, changes: { x: 5, y: 10, width: 40, height: 20 } },
    {
      id: 2,
      changes: {
        x: 65,
        y: 50,
        polygon: [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 20 }],
      },
    },
  ]);
  const rotated = planTiledObjectRotation(objects, { x: 10, y: 20 }, 90);
  assert.deepEqual(rotated[0], { id: 1, changes: { x: 10, y: 20, rotation: 90 } });
  assert.ok(Math.abs(rotated[1].changes.x + 10) < 1e-9);
  assert.equal(rotated[1].changes.y, 50);
  assert.equal(rotated[1].changes.rotation, 90);
  assert.equal(Object.hasOwn(rotated[0].changes, "scaleX"), false);
});

test("recognizes generic Tiled game semantics and compatible portal properties", () => {
  const spawn = createTiledMapObject({ shape: "point", semantic: "spawn", rect: RECT });
  spawn.name = "north";
  spawn.properties[0].value = "north-gate";
  assert.equal(tiledObjectSemantic(spawn), "spawn");
  assert.equal(tiledSpawnIdentifier(spawn), "north-gate");
  assert.equal(tiledObjectPropertyValue(spawn, "spawnId"), "north-gate");

  const portal = {
    class: "Portal",
    properties: [
      { name: "destination", type: "file", value: "maps/cave.tmj" },
      { name: "destinationSpawn", type: "string", value: "entrance" },
      { name: "futurePortalField", type: "string", value: "keep" },
    ],
  };
  assert.equal(tiledObjectSemantic(portal), "portal");
  assert.deepEqual(tiledPortalReference(portal), { targetMap: "maps/cave.tmj", targetSpawn: "entrance" });
  assert.equal(tiledObjectSemantic({ type: "solid-wall" }), "collision");
  assert.equal(tiledObjectSemantic({ class: "Collision" }), "collision");
});
