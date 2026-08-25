import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyTiledAutomappingPreview,
  compileTiledAutomappingRuleMap,
  loadTiledAutomappingRules,
  parseTiledAutomappingRulesList,
  previewTiledAutomapping,
} from "../public/map-editor/tiled-automap.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import { planTiledTilesetReuse } from "../public/map-editor/tiled-gid-reuse.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tiled", "automapping");

test("rules.txt parsing preserves order, filters map names, and confines nested paths", async () => {
  const entries = parseTiledAutomappingRulesList(`
# ignored
[town*]
rules/town.tmj
[scene*]
nested/common.txt
[*]
base.tmj
`, {
    sourcePath: "automapping/rules.txt",
    targetMapPath: "maps/scene-01.tmj",
  });
  assert.deepEqual(entries.map(({ path, kind, filter, applies }) => ({ path, kind, filter, applies })), [
    { path: "automapping/rules/town.tmj", kind: "map", filter: "town*", applies: false },
    { path: "automapping/nested/common.txt", kind: "list", filter: "scene*", applies: true },
    { path: "automapping/base.tmj", kind: "map", filter: "*", applies: true },
  ]);
  assert.throws(
    () => parseTiledAutomappingRulesList("../../outside.tmj", {
      sourcePath: "rules.txt",
      targetMapPath: "maps/scene.tmj",
    }),
    (error) => error.code === "TILED_AUTOMAP_RULE_PATH_OUTSIDE_PROJECT",
  );
});

test("nested rules lists retain repeated includes, reject active cycles, and obey cancellation", async () => {
  const files = new Map([
    ["rules.txt", "a.txt\na.txt\nmap.tmj\n"],
    ["a.txt", "nested.tmj\n"],
  ]);
  const loaded = await loadTiledAutomappingRules({
    rulesPath: "rules.txt",
    targetMapPath: "maps/scene.tmj",
    loadText: async (relativePath) => files.get(relativePath),
  });
  assert.deepEqual(loaded.entries.map(({ path }) => path), ["nested.tmj", "nested.tmj", "map.tmj"]);

  await assert.rejects(
    loadTiledAutomappingRules({
      rulesPath: "rules.txt",
      targetMapPath: "maps/scene.tmj",
      loadText: async (relativePath) => relativePath === "rules.txt" ? "a.txt" : "rules.txt",
    }),
    (error) => error.code === "TILED_AUTOMAP_RULE_LIST_CYCLE",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadTiledAutomappingRules({
      rulesPath: "rules.txt",
      targetMapPath: "maps/scene.tmj",
      signal: controller.signal,
      loadText: async () => "map.tmj",
    }),
    (error) => error.name === "AbortError",
  );
});

test("modern tile rules preview without mutation and apply as one undoable edit", async () => {
  const ruleMap = JSON.parse(await fs.readFile(path.join(fixtureRoot, "basic.tmj"), "utf8"));
  const compiled = compileTiledAutomappingRuleMap(ruleMap, { rulePath: "automapping/basic.tmj" });
  assert.equal(compiled.rules.length, 1);
  const target = mapDocument({
    layers: [
      tileLayer(1, "Ground", [1, 1, 0, 1], 4),
      tileLayer(2, "Decor", [0, 0, 0, 0], 4),
    ],
    width: 4,
  });
  const untouched = structuredClone(target);
  const preview = previewTiledAutomapping(target, compiled, {
    targetPath: "maps/scene.tmj",
    seed: 7,
  });
  assert.deepEqual(target, untouched);
  assert.deepEqual(preview.changes.map(({ layerName, x, y, before, after }) => (
    { layerName, x, y, before, after }
  )), [
    { layerName: "Decor", x: 1, y: 0, before: 0, after: 2 },
    { layerName: "Decor", x: 2, y: 0, before: 0, after: 2 },
  ]);
  assert.equal(preview.stats.matches, 3);
  const editor = new TiledEditDocument(target);
  const applied = applyTiledAutomappingPreview(editor, preview);
  assert.equal(applied.changed, true);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.equal(editor.undoStack[0].entries[0].seed, 7);
  assert.deepEqual(editor.layerById(2).data, [0, 2, 2, 0]);
  editor.undo();
  assert.deepEqual(editor.layerById(2).data, [0, 0, 0, 0]);
  editor.redo();
  assert.deepEqual(editor.layerById(2).data, [0, 2, 2, 0]);
});

test("missing output layers are created only on explicit apply and remain undoable", async () => {
  const ruleMap = JSON.parse(await fs.readFile(path.join(fixtureRoot, "basic.tmj"), "utf8"));
  const compiled = compileTiledAutomappingRuleMap(ruleMap, { rulePath: "automapping/basic.tmj" });
  const target = mapDocument({ layers: [tileLayer(1, "Ground", [1, 0], 2)], width: 2 });
  const preview = previewTiledAutomapping(target, compiled, { seed: 1 });
  assert.equal(target.layers.length, 1);
  assert.equal(preview.additions.length, 1);
  assert.equal(preview.additions[0].layer.name, "Decor");
  const editor = new TiledEditDocument(target);
  applyTiledAutomappingPreview(editor, preview);
  assert.equal(editor.document.layers.length, 2);
  assert.deepEqual(editor.document.layers[1].data, [0, 2]);
  editor.undo();
  assert.equal(editor.document.layers.length, 1);
  editor.redo();
  assert.deepEqual(editor.document.layers[1].data, [0, 2]);
});

test("canonical external TSJ mapping remaps rule GIDs to the target map firstgid", () => {
  const definition = {
    type: "tileset",
    name: "Terrain",
    tilecount: 2,
    columns: 2,
    tilewidth: 16,
    tileheight: 16,
  };
  const rule = mapDocument({
    layers: [
      tileLayer(1, "input_Ground", [1, 0], 2),
      tileLayer(2, "output_Decor", [0, 2], 2),
    ],
    width: 2,
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
  });
  const reuse = planTiledTilesetReuse({
    sourceMapPath: "automapping/basic.tmj",
    targetMapPath: "maps/scene.tmj",
    sourceTilesets: [{
      reference: rule.tilesets[0],
      definition,
      firstgid: 1,
      maxLocalId: 1,
      sourcePath: "tiles/terrain.tsj",
    }],
    targetTilesets: [{
      reference: { firstgid: 100, source: "../tiles/terrain.tsj" },
      definition,
      firstgid: 100,
      maxLocalId: 1,
      sourcePath: "tiles/terrain.tsj",
    }],
  });
  const compiled = compileTiledAutomappingRuleMap(rule, {
    rulePath: "automapping/basic.tmj",
    remapGid: reuse.remapGlobalTileId,
  });
  const target = mapDocument({
    layers: [
      tileLayer(1, "Ground", [100, 0], 2),
      tileLayer(2, "Decor", [0, 0], 2),
    ],
    width: 2,
    tilesets: [{ firstgid: 100, source: "../tiles/terrain.tsj" }],
  });
  const preview = previewTiledAutomapping(target, compiled, { seed: 9 });
  assert.deepEqual(preview.changes.map(({ layerName, x, after }) => ({ layerName, x, after })), [
    { layerName: "Decor", x: 1, after: 101 },
  ]);
});

test("tileset additions join AutoMap changes in the same undo group", () => {
  const target = mapDocument({
    layers: [tileLayer(1, "Decor", [0], 1)],
    width: 1,
    tilesets: [],
  });
  const editor = new TiledEditDocument(target);
  const preview = {
    seed: 3,
    additions: [],
    changes: [{ layerId: 1, layerName: "Decor", x: 0, y: 0, before: 0, after: 2 }],
  };
  const tileset = {
    firstgid: 1,
    type: "tileset",
    name: "Generated",
    tilecount: 2,
    columns: 2,
    tilewidth: 16,
    tileheight: 16,
  };
  applyTiledAutomappingPreview(editor, preview, { tilesetAdditions: [tileset] });
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.equal(editor.document.tilesets.length, 1);
  assert.deepEqual(editor.layerById(1).data, [2]);
  editor.undo();
  assert.equal(editor.document.tilesets.length, 0);
  assert.deepEqual(editor.layerById(1).data, [0]);
  editor.redo();
  assert.equal(editor.document.tilesets.length, 1);
  assert.deepEqual(editor.layerById(1).data, [2]);
});

test("seeded random outputs are repeatable and unsupported semantics fail explicitly", () => {
  const rule = mapDocument({
    layers: [
      tileLayer(1, "input_Ground", [1, 0], 2),
      tileLayer(2, "output1_Decor", [0, 2], 2, [{ name: "Probability", type: "float", value: 1 }]),
      tileLayer(3, "output2_Decor", [0, 3], 2, [{ name: "Probability", type: "float", value: 3 }]),
    ],
    width: 2,
    tilesets: [{ firstgid: 1, type: "tileset", name: "Rule", tilecount: 3, columns: 3, tilewidth: 16, tileheight: 16 }],
  });
  const compiled = compileTiledAutomappingRuleMap(rule, { rulePath: "automapping/random.tmj" });
  const target = mapDocument({
    layers: [tileLayer(1, "Ground", [1, 1, 1, 1], 4), tileLayer(2, "Decor", [0, 0, 0, 0], 4)],
    width: 4,
  });
  const first = previewTiledAutomapping(target, compiled, { seed: 1234 });
  const second = previewTiledAutomapping(target, compiled, { seed: 1234 });
  assert.deepEqual(first.changes, second.changes);
  assert.notDeepEqual(
    previewTiledAutomapping(target, compiled, { seed: 1235 }).changes,
    first.changes,
  );

  const legacy = structuredClone(rule);
  legacy.layers.push(tileLayer(4, "regions", [1, 0], 2));
  assert.throws(
    () => compileTiledAutomappingRuleMap(legacy, { rulePath: "automapping/legacy.tmj" }),
    (error) => error.code === "TILED_AUTOMAP_LEGACY_REGIONS_UNSUPPORTED",
  );
  const hexagonal = structuredClone(rule);
  hexagonal.orientation = "hexagonal";
  assert.throws(
    () => compileTiledAutomappingRuleMap(hexagonal, { rulePath: "automapping/hex.tmj" }),
    (error) => error.code === "TILED_AUTOMAP_ORIENTATION_UNSUPPORTED",
  );
});

test("inputnot and Empty special tiles follow Tiled matching and erase semantics", () => {
  const rule = mapDocument({
    layers: [
      tileLayer(1, "inputnot_Ground", [1, 0], 2),
      tileLayer(2, "output_Decor", [0, 101], 2),
    ],
    width: 2,
    tilesets: [{
      firstgid: 1,
      type: "tileset",
      name: "Rule",
      tilecount: 101,
      columns: 101,
      tilewidth: 16,
      tileheight: 16,
      tiles: [{
        id: 100,
        properties: [{ name: "MatchType", type: "string", value: "Empty" }],
      }],
    }],
  });
  const compiled = compileTiledAutomappingRuleMap(rule, { rulePath: "automapping/not-empty.tmj" });
  const target = mapDocument({
    layers: [
      tileLayer(1, "Ground", [1, 2, 0], 3),
      tileLayer(2, "Decor", [3, 3, 3], 3),
    ],
    width: 3,
  });
  const preview = previewTiledAutomapping(target, compiled, { seed: 1 });
  assert.deepEqual(preview.changes.map(({ x, after }) => ({ x, after })), [
    { x: 2, after: 0 },
  ]);
});

test("MatchInOrder lets later rules observe earlier output while concurrent matching does not", () => {
  const layers = [
    tileLayer(1, "input_Ground", [1, 0, 2], 3),
    tileLayer(2, "output_Ground", [2, 0, 0], 3),
    tileLayer(3, "output_Decor", [0, 0, 3], 3),
  ];
  const concurrentRuleMap = mapDocument({ layers, width: 3 });
  const orderedRuleMap = structuredClone(concurrentRuleMap);
  orderedRuleMap.properties = [{ name: "MatchInOrder", type: "bool", value: true }];
  const target = mapDocument({
    layers: [tileLayer(1, "Ground", [1], 1), tileLayer(2, "Decor", [0], 1)],
    width: 1,
  });
  const concurrent = previewTiledAutomapping(
    target,
    compileTiledAutomappingRuleMap(concurrentRuleMap, { rulePath: "automapping/concurrent.tmj" }),
    { seed: 5 },
  );
  assert.deepEqual(concurrent.changes.map(({ layerName, after }) => ({ layerName, after })), [
    { layerName: "Ground", after: 2 },
  ]);
  const ordered = previewTiledAutomapping(
    target,
    compileTiledAutomappingRuleMap(orderedRuleMap, { rulePath: "automapping/ordered.tmj" }),
    { seed: 5 },
  );
  assert.deepEqual(ordered.changes.map(({ layerName, after }) => ({ layerName, after })), [
    { layerName: "Decor", after: 3 },
    { layerName: "Ground", after: 2 },
  ]);
});

test("preview enforces candidate and change limits and observes AbortSignal", async () => {
  const ruleMap = JSON.parse(await fs.readFile(path.join(fixtureRoot, "basic.tmj"), "utf8"));
  const compiled = compileTiledAutomappingRuleMap(ruleMap, { rulePath: "automapping/basic.tmj" });
  const target = mapDocument({
    layers: [tileLayer(1, "Ground", new Array(64).fill(1), 64), tileLayer(2, "Decor", new Array(64).fill(0), 64)],
    width: 64,
  });
  assert.throws(
    () => previewTiledAutomapping(target, compiled, { maxCandidates: 4 }),
    (error) => error.code === "TILED_AUTOMAP_CANDIDATE_LIMIT",
  );
  assert.throws(
    () => previewTiledAutomapping(target, compiled, { maxChanges: 4 }),
    (error) => error.code === "TILED_AUTOMAP_CHANGE_LIMIT",
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => previewTiledAutomapping(target, compiled, { signal: controller.signal }),
    (error) => error.name === "AbortError",
  );
});

function mapDocument({ layers, width, tilesets = null }) {
  return {
    type: "map",
    version: "1.12",
    tiledversion: "1.12.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: Math.max(0, ...layers.map(({ id }) => id)) + 1,
    nextobjectid: 1,
    layers,
    tilesets: tilesets || [{ firstgid: 1, type: "tileset", name: "Target", tilecount: 3, columns: 3, tilewidth: 16, tileheight: 16 }],
  };
}

function tileLayer(id, name, data, width, properties = undefined) {
  return {
    id,
    name,
    type: "tilelayer",
    width,
    height: 1,
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
    data,
    ...(properties ? { properties } : {}),
  };
}
