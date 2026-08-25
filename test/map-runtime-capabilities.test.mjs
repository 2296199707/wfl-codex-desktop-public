import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertMapPatchRuntimeCompatible,
  inspectMapRuntimeCapabilities,
} from "../lib/map-runtime-capabilities.mjs";

async function fixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-runtime-capabilities-"));
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "systems"), { recursive: true });
  await fs.writeFile(path.join(root, "scripts", "check-tiled-maps.mjs"), `
    const REQUIRED_LAYERS = ['Ground', 'Collision', 'Decor'];
    const VALID_LAYER_TYPES = new Set(['tilelayer', 'objectgroup', 'imagelayer', 'group']);
    // mapId musicId backgroundAsset
  `);
  await fs.writeFile(path.join(root, "src", "systems", "TiledMapProtocol.ts"), `
    const STANDARD_LAYER_TYPES = new Set(['tilelayer', 'objectgroup', 'imagelayer', 'group']);
    export function tiledLayer() {}
  `);
  await fs.writeFile(path.join(root, "src", "systems", "TiledMapAssets.ts"), `
    export function renderTiledImageLayers() {}
    function groupChildren() {}
  `);
  return root;
}

function mapWithLayers() {
  return {
    type: "map",
    layers: [
      { id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] },
      { id: 2, name: "NPCs", type: "objectgroup", objects: [{ id: 1, name: "merchant", x: 0, y: 0, properties: [{ name: "npcId", value: "npc.merchant" }, { name: "dialogueId", value: "dialogue.merchant" }] }] },
    ],
  };
}

test("runtime capability inspection reports wflgame's conservative Tiled boundary", async () => {
  const root = await fixtureProject();
  try {
    const capabilities = await inspectMapRuntimeCapabilities({ projectPath: root, mapPath: "maps/world.tmj" });
    assert.equal(capabilities.version, "wflgame-runtime-v1");
    assert.equal(capabilities.layers.tilelayer.parsed, true);
    assert.equal(capabilities.layers.tilelayer.rendered, false);
    assert.equal(capabilities.layers.imagelayer.rendered, true);
    assert.equal(capabilities.resources.externalTilesets, false);
    assert.ok(capabilities.notes.some((entry) => entry.includes("不保证渲染 tilelayer")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime guard rejects tile edits and missing business fields before a task is queued", async () => {
  const root = await fixtureProject();
  try {
    const capabilities = await inspectMapRuntimeCapabilities({ projectPath: root });
    const document = mapWithLayers();
    assert.throws(
      () => assertMapPatchRuntimeCompatible(document, { operations: [{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 1 }] }] }, capabilities),
      (error) => error.code === "RUNTIME_LAYER_UNSUPPORTED",
    );
    assert.throws(
      () => assertMapPatchRuntimeCompatible(document, { operations: [{ op: "add-object", layerId: 2, object: { id: 2, x: 0, y: 0, properties: [] } }] }, capabilities),
      (error) => error.code === "RUNTIME_REQUIRED_PROPERTY_MISSING",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime inspection recognizes the Phaser tile-layer renderer instead of rejecting supported edits", async () => {
  const root = await fixtureProject();
  try {
    await fs.writeFile(path.join(root, "src", "systems", "TiledMapAssets.ts"), `
      export function renderTiledTileLayers() {}
      const display = tilemap.createLayer(0, tilesets);
      tilemap.addTilesetImage('Ground', key);
      export function renderTiledImageLayers() {}
    `);
    const capabilities = await inspectMapRuntimeCapabilities({ projectPath: root });
    assert.equal(capabilities.layers.tilelayer.rendered, true);
    assert.doesNotThrow(() => assertMapPatchRuntimeCompatible(
      mapWithLayers(),
      { operations: [{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 1 }] }] },
      capabilities,
    ));
    assert.equal(capabilities.notes.some((entry) => entry.includes("不保证渲染 tilelayer")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
