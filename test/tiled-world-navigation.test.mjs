import assert from "node:assert/strict";
import test from "node:test";
import {
  collectWorldMapNavigation,
  planWorldMapPreviews,
  validateWorldPortalReferences,
} from "../public/map-editor/tiled-world-navigation.js";

test("plans full current-map and lightweight adjacent previews from World policy", () => {
  const world = {
    type: "world",
    onlyShowAdjacentMaps: true,
    maps: [
      { fileName: "../maps/a.tmj", x: 0, y: 0, width: 64, height: 64 },
      { fileName: "../maps/b.tmj", x: 64, y: 0, width: 64, height: 64 },
      { fileName: "../maps/c.tmj", x: 256, y: 0, width: 64, height: 64 },
    ],
  };
  assert.deepEqual(planWorldMapPreviews(world, {
    sourcePath: "worlds/main.world",
    selectedFileName: "../maps/a.tmj",
  }), [
    { fileName: "../maps/a.tmj", mapPath: "maps/a.tmj", mode: "full" },
    { fileName: "../maps/b.tmj", mapPath: "maps/b.tmj", mode: "preview" },
  ]);
  world.onlyShowAdjacentMaps = false;
  assert.deepEqual(planWorldMapPreviews(world, {
    sourcePath: "worlds/main.world",
    selectedFileName: "../maps/a.tmj",
  }).map(({ mapPath, mode }) => [mapPath, mode]), [
    ["maps/a.tmj", "full"],
    ["maps/b.tmj", "preview"],
    ["maps/c.tmj", "preview"],
  ]);
});

test("collects nested SpawnPoint and Portal objects with compatible property names", () => {
  const summary = collectWorldMapNavigation(mapDocument([
    {
      id: 1,
      type: "group",
      x: 4,
      y: 8,
      layers: [{
        id: 2,
        type: "objectgroup",
        offsetx: 2,
        offsety: 3,
        objects: [
          {
            id: 7,
            class: "SpawnPoint",
            name: "TownGate",
            x: 10,
            y: 20,
            point: true,
            properties: [{ name: "spawnId", type: "string", value: "gate" }],
          },
          {
            id: 8,
            type: "Portal",
            name: "ToTown",
            x: 30,
            y: 40,
            width: 10,
            height: 20,
            properties: [
              { name: "destination", type: "file", value: "town.tmj" },
              { name: "destinationSpawn", type: "string", value: "entry" },
            ],
          },
        ],
      }],
    },
  ]), { mapPath: "maps/forest.tmj" });
  assert.equal(summary.spawns[0].id, "gate");
  assert.deepEqual({ x: summary.spawns[0].x, y: summary.spawns[0].y }, { x: 16, y: 31 });
  assert.equal(summary.portals[0].targetMap, "town.tmj");
  assert.equal(summary.portals[0].targetSpawn, "entry");
  assert.deepEqual({ x: summary.portals[0].x, y: summary.portals[0].y }, { x: 41, y: 61 });
});

test("validates targetMap and targetSpawn across World maps and returns drawable links", () => {
  const world = {
    type: "world",
    maps: [
      { fileName: "../maps/forest.tmj", x: 0, y: 0, width: 64, height: 64 },
      { fileName: "../maps/town.tmj", x: 64, y: 0, width: 64, height: 64 },
    ],
  };
  const forest = collectWorldMapNavigation(mapDocument([{
    id: 1,
    type: "objectgroup",
    objects: [
      portal(1, "town.tmj", "entry"),
      portal(2, "missing.tmj", "entry"),
      portal(3, "town.tmj", "missing"),
      portal(4, "town.tmj", ""),
    ],
  }]), { mapPath: "maps/forest.tmj" });
  const town = collectWorldMapNavigation(mapDocument([{
    id: 2,
    type: "objectgroup",
    objects: [{
      id: 10,
      class: "SpawnPoint",
      name: "Entry",
      x: 32,
      y: 32,
      point: true,
      properties: [{ name: "spawnId", type: "string", value: "entry" }],
    }],
  }]), { mapPath: "maps/town.tmj" });
  const result = validateWorldPortalReferences(
    world,
    new Map([[forest.mapPath, forest], [town.mapPath, town]]),
    { sourcePath: "worlds/main.world" },
  );
  assert.equal(result.portalCount, 4);
  assert.equal(result.validLinkCount, 1);
  assert.equal(result.errorCount, 2);
  assert.equal(result.warningCount, 1);
  assert.deepEqual(result.diagnostics.map(({ code }) => code).sort(), [
    "world-portal-target-map-not-found",
    "world-portal-target-spawn-missing",
    "world-portal-target-spawn-not-found",
  ]);
  assert.equal(result.links[0].sourceMapPath, "maps/forest.tmj");
  assert.equal(result.links[0].targetMapPath, "maps/town.tmj");
  assert.equal(result.links[0].targetSpawn, "entry");
  assert.ok(result.links[0].source.x < result.links[0].target.x);
});

test("reports duplicate spawn IDs and maps that were not inspected", () => {
  const world = {
    type: "world",
    maps: [
      { fileName: "../maps/a.tmj", x: 0, y: 0, width: 32, height: 32 },
      { fileName: "../maps/b.tmj", x: 32, y: 0, width: 32, height: 32 },
    ],
  };
  const summary = collectWorldMapNavigation(mapDocument([{
    id: 1,
    type: "objectgroup",
    objects: [
      spawn(1, "same"),
      spawn(2, "same"),
    ],
  }]), { mapPath: "maps/a.tmj" });
  const result = validateWorldPortalReferences(world, [summary], { sourcePath: "worlds/main.world" });
  assert.deepEqual(result.diagnostics.map(({ code }) => code).sort(), [
    "world-map-navigation-unchecked",
    "world-spawn-id-duplicate",
  ]);
});

function mapDocument(layers) {
  return {
    type: "map",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 4,
    height: 4,
    tilewidth: 16,
    tileheight: 16,
    layers,
    tilesets: [],
  };
}

function portal(id, targetMap, targetSpawn) {
  return {
    id,
    class: "Portal",
    name: `Portal ${id}`,
    x: 16,
    y: 16,
    width: 16,
    height: 16,
    properties: [
      { name: "targetMap", type: "string", value: targetMap },
      { name: "targetSpawn", type: "string", value: targetSpawn },
    ],
  };
}

function spawn(id, spawnId) {
  return {
    id,
    class: "SpawnPoint",
    name: `Spawn ${id}`,
    x: 8,
    y: 8,
    point: true,
    properties: [{ name: "spawnId", type: "string", value: spawnId }],
  };
}
