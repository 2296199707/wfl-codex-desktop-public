import assert from "node:assert/strict";
import test from "node:test";
import {
  TiledAiPatchError,
  applyTiledAiPatch,
  buildTiledAiPrompt,
  parseTiledAiPatch,
  prepareTiledAiPatchFills,
  previewTiledAiPatch,
  tiledAiPatchContext,
} from "../public/map-editor/tiled-ai-patch.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";

const MAP_VERSION = "a".repeat(64);
const BASE = Object.freeze({
  mapPath: "maps/world.tmj",
  mapVersion: MAP_VERSION,
  editorStateId: 0,
});

function mapDocument() {
  return {
    type: "map",
    orientation: "orthogonal",
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    nextobjectid: 3,
    layers: [
      {
        id: 1,
        name: "Ground",
        type: "tilelayer",
        width: 3,
        height: 2,
        data: [1, 1, 0, 0, 0, 0],
        unknownLayer: { preserve: true },
      },
      {
        id: 2,
        name: "Objects",
        type: "objectgroup",
        objects: [
          { id: 1, name: "Start", point: true, x: 0, y: 0, unknownObject: "keep" },
          { id: 2, name: "Portal", x: 16, y: 0, width: 16, height: 16 },
        ],
      },
    ],
    tilesets: [{ firstgid: 1, name: "Terrain", tilecount: 4, columns: 2, tilewidth: 16, tileheight: 16 }],
    unknownRoot: { preserve: [1, 2, 3] },
  };
}

function patch(operations, overrides = {}) {
  return {
    format: "wfl-tiled-patch",
    version: 1,
    base: { ...BASE },
    summary: "更新测试地图",
    operations,
    ...overrides,
  };
}

function parse(value, expected = BASE) {
  return parseTiledAiPatch(JSON.stringify(value), expected);
}

function assertPatchCode(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof TiledAiPatchError && error.code === code,
  );
}

test("builds an explicit prompt from bounded metadata without map contents or credentials", () => {
  const document = mapDocument();
  document.largeMetadata = "/srv/private/project session=secret-token";
  document.layers[0].data = [3_141_592_653, 1, 0, 0, 0, 0];
  const prompt = buildTiledAiPrompt({
    document,
    ...BASE,
    activeLayerId: 1,
    selectedGid: null,
    loadedTilesets: [{
      firstgid: 1,
      definition: { name: "Loaded terrain", tilecount: 4, columns: 2, tilewidth: 16, tileheight: 16 },
      textures: new Map([[0, {}], [1, {}], [2, {}], [3, {}]]),
    }],
  });

  assert.match(prompt, /wfl-tiled-patch/u);
  assert.match(prompt, /"mapPath": "maps\/world\.tmj"/u);
  assert.match(prompt, /"selectedGid": null/u);
  assert.match(prompt, /"lastgid": 4/u);
  assert.doesNotMatch(prompt, /3_?141_?592_?653/u);
  assert.doesNotMatch(prompt, /\/srv\/private/u);
  assert.doesNotMatch(prompt, /secret-token/u);
  assert.doesNotMatch(prompt, /sessionId|editorInstanceId|authorization/iu);
});

test("adds explicit non-secret MCP context only after map AI authorization", () => {
  const prompt = buildTiledAiPrompt({
    document: mapDocument(),
    ...BASE,
    toolContext: {
      threadId: "thread-1",
      mapSessionId: "map-session-1",
      editorInstanceId: "editor-window-1",
      editorStateId: BASE.editorStateId,
    },
  });
  assert.match(prompt, /"threadId": "thread-1"/u);
  assert.match(prompt, /"mapSessionId": "map-session-1"/u);
  assert.match(prompt, /"editorInstanceId": "editor-window-1"/u);
  assert.match(prompt, /propose_tiled_patch/u);
  assert.doesNotMatch(prompt, /leaseId|leaseToken|projectPath|secret-token|\/srv\/private/iu);

  assert.throws(
    () => buildTiledAiPrompt({
      document: mapDocument(),
      ...BASE,
      toolContext: {
        threadId: "thread-1",
        mapSessionId: "map-session-1",
        editorInstanceId: "editor-window-1",
        editorStateId: 1,
      },
    }),
    (error) => error.code === "invalid-tool-context",
  );
  assert.throws(
    () => buildTiledAiPrompt({
      document: mapDocument(),
      ...BASE,
      toolContext: {
        threadId: "thread-1",
        mapSessionId: "map-session-1",
        editorInstanceId: "editor-window-1",
        editorStateId: 0,
        leaseId: "must-not-enter-the-prompt",
      },
    }),
    (error) => error.code === "invalid-tool-context",
  );
});

test("normalizes patch primitives and binds patches to path, file version, and local editor state", () => {
  const normalized = parse(patch([
    { op: "set-tiles", layerId: "1", cells: [{ x: "0", y: "1", gid: "2" }] },
    { op: "add-object", layerId: 2, object: { id: "9", name: "Spawn", point: true, x: 8, y: 8 } },
  ]));
  assert.deepEqual(normalized.operations[0], {
    op: "set-tiles",
    layerId: 1,
    cells: [{ x: 0, y: 1, gid: 2 }],
  });
  assert.equal(normalized.operations[1].object.id, 9);
  assert.deepEqual(tiledAiPatchContext({ ...BASE, mapPath: "maps/./world.tmj" }), BASE);

  assertPatchCode(
    () => parse(patch([], { operations: [{ op: "remove-object", layerId: 2, objectId: 1 }], base: { ...BASE, mapPath: "maps/other.tmj" } })),
    "map-path-mismatch",
  );
  assertPatchCode(
    () => parse(patch([], { operations: [{ op: "remove-object", layerId: 2, objectId: 1 }], base: { ...BASE, mapVersion: "b".repeat(64) } })),
    "map-version-mismatch",
  );
  assertPatchCode(
    () => parse(patch([], { operations: [{ op: "remove-object", layerId: 2, objectId: 1 }], base: { ...BASE, editorStateId: 1 } })),
    "editor-state-mismatch",
  );
  assertPatchCode(
    () => tiledAiPatchContext({ ...BASE, mapPath: "/srv/project/maps/world.tmj" }),
    "invalid-map-path",
  );
});

test("rejects embedded or escaping resources, dangerous keys, protected fields, and invalid Tiled field types", () => {
  assertPatchCode(
    () => parse(patch([{ op: "add-object", layerId: 2, object: { image: "data:image/png;base64,AA==", x: 0, y: 0 } }])),
    "embedded-resource",
  );
  assertPatchCode(
    () => parse(patch([{ op: "add-object", layerId: 2, object: { template: "/etc/object.tx", x: 0, y: 0 } }])),
    "invalid-resource-reference",
  );
  assertPatchCode(
    () => parse(patch([{ op: "update-object", layerId: 2, objectId: 1, changes: {
      properties: [{ name: "source", type: "file", value: "../../outside.tmj" }],
    } }])),
    "invalid-resource-reference",
  );
  const dangerousSource = JSON.stringify(patch([{ op: "update-object", layerId: 2, objectId: 1, changes: {} }]))
    .replace('"changes":{}', '"changes":{"__proto__":{"polluted":true}}');
  assertPatchCode(() => parseTiledAiPatch(dangerousSource, BASE), "unsafe-key");
  assertPatchCode(
    () => parse(patch([{ op: "update-layer", layerId: 1, changes: { data: [0, 0, 0, 0, 0, 0] } }])),
    "protected-layer-field",
  );
  assertPatchCode(
    () => parse(patch([{ op: "update-layer", layerId: 1, changes: { width: 99 } }])),
    "protected-layer-field",
  );
  assertPatchCode(
    () => parse(patch([{ op: "update-layer", layerId: 1, changes: { visible: "false" } }])),
    "invalid-field-type",
  );
  assertPatchCode(
    () => parse(patch([{ op: "update-object", layerId: 2, objectId: 1, changes: { x: "16" } }])),
    "invalid-field-type",
  );
});

test("previews semantic failures without modifying the document", () => {
  const document = mapDocument();
  const before = structuredClone(document);

  const locked = structuredClone(document);
  locked.layers[0].locked = true;
  assertPatchCode(
    () => previewTiledAiPatch(locked, patch([{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 2 }] }])),
    "layer-locked",
  );

  const encoded = structuredClone(document);
  encoded.layers[0].data = "AAAAAA==";
  encoded.layers[0].encoding = "base64";
  assertPatchCode(
    () => previewTiledAiPatch(encoded, patch([{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 2 }] }])),
    "encoded-tile-layer",
  );

  assertPatchCode(
    () => previewTiledAiPatch(document, patch([{ op: "set-tiles", layerId: 1, cells: [{ x: 9, y: 0, gid: 2 }] }])),
    "tile-outside-layer",
  );
  assertPatchCode(
    () => previewTiledAiPatch(document, patch([{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 99 }] }])),
    "unknown-gid",
  );
  assertPatchCode(
    () => previewTiledAiPatch(document, patch([{ op: "add-object", layerId: 2, object: { id: 2, x: 0, y: 0 } }])),
    "duplicate-object-id",
  );
  assert.deepEqual(document, before);
});

test("applies a mixed patch as one undoable edit while preserving unknown Tiled fields", () => {
  const source = mapDocument();
  const editor = new TiledEditDocument(source);
  const normalized = parse(patch([
    { op: "set-tiles", layerId: 1, cells: [{ x: 2, y: 1, gid: 3 }] },
    { op: "update-layer", layerId: 1, changes: { name: "Terrain", opacity: 0.75 } },
    { op: "add-object", layerId: 2, object: { id: 8, name: "Exit", x: 32, y: 16, width: 16, height: 16 } },
    { op: "update-object", layerId: 2, objectId: 1, changes: { name: "Player Start" } },
    { op: "remove-object", layerId: 2, objectId: 2 },
  ]));
  const preview = previewTiledAiPatch(editor.document, normalized);
  assert.equal(preview.operationCount, 5);
  assert.equal(preview.tileCellCount, 1);

  const result = applyTiledAiPatch(editor, normalized);
  assert.equal(result.changed, true);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.deepEqual(editor.undoStack[0].layerIds, [1, 2]);
  assert.equal(editor.layerById(1).data[5], 3);
  assert.equal(editor.layerById(1).name, "Terrain");
  assert.equal(editor.layerById(2).objects.find((object) => object.id === 1).name, "Player Start");
  assert.equal(editor.layerById(2).objects.find((object) => object.id === 8).name, "Exit");
  assert.equal(editor.document.nextobjectid, 9);
  assert.deepEqual(editor.document.unknownRoot, source.unknownRoot);
  assert.deepEqual(editor.layerById(1).unknownLayer, source.layers[0].unknownLayer);
  assert.equal(editor.layerById(2).objects.find((object) => object.id === 1).unknownObject, "keep");

  assert.equal(editor.undo(), true);
  assert.deepEqual(editor.exportDocument(), source);
  assert.equal(editor.redo(), true);
  assert.equal(editor.layerById(1).data[5], 3);
});

test("precomputes sequential AI fill regions and applies them as one compact undo entry", () => {
  const source = mapDocument();
  source.layers[0].data = [1, 1, 0, 1, 0, 0];
  const normalized = parse(patch([
    { op: "set-tiles", layerId: 1, cells: [{ x: 2, y: 0, gid: 1 }] },
    { op: "fill-region", layerId: 1, x: 0, y: 0, gid: 2 },
    { op: "fill-region", layerId: 1, x: 1, y: 1, gid: 3 },
  ]));
  const prepared = prepareTiledAiPatchFills(source, normalized);
  assert.equal(prepared.fillResults.length, 2);
  assert.equal(prepared.fillResults[0].operationIndex, 1);
  assert.equal(prepared.fillResults[0].result.count, 4);
  assert.equal(prepared.fillResults[1].result.count, 2);
  assert.equal(prepared.tileCellCount, 7);
  assert.deepEqual(source.layers[0].data, [1, 1, 0, 1, 0, 0]);

  const editor = new TiledEditDocument(source);
  const result = applyTiledAiPatch(editor, normalized, { fillResults: prepared.fillResults });
  assert.equal(result.changed, true);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].type, "batch");
  assert.equal(editor.undoStack[0].entries.filter((entry) => entry.type === "tile-fill-compact").length, 2);
  assert.deepEqual(editor.layerById(1).data, [2, 2, 2, 2, 3, 3]);
  editor.undo();
  assert.deepEqual(editor.layerById(1).data, [1, 1, 0, 1, 0, 0]);
  editor.redo();
  assert.deepEqual(editor.layerById(1).data, [2, 2, 2, 2, 3, 3]);
});

test("requires complete Worker fill results and rolls back if one is stale", () => {
  const source = mapDocument();
  const normalized = parse(patch([
    { op: "fill-region", layerId: 1, x: 0, y: 0, gid: 2 },
  ]));
  assert.throws(
    () => applyTiledAiPatch(new TiledEditDocument(source), normalized),
    (error) => error.code === "fill-precompute-required",
  );
  const prepared = prepareTiledAiPatchFills(source, normalized);
  const editor = new TiledEditDocument(source);
  editor.layerById(1).data[0] = 3;
  assert.throws(
    () => applyTiledAiPatch(editor, normalized, { fillResults: prepared.fillResults }),
    (error) => error.code === "fill-result-stale",
  );
  assert.deepEqual(editor.layerById(1).data, [3, 1, 0, 0, 0, 0]);
  assert.equal(editor.undoStack.length, 0);
});

test("rolls the entire patch back when a later editor command fails", () => {
  const source = mapDocument();
  const editor = new TiledEditDocument(source);
  const normalized = parse(patch([
    { op: "set-tiles", layerId: 1, cells: [{ x: 2, y: 1, gid: 2 }] },
    { op: "update-object", layerId: 2, objectId: 1, changes: { name: "Changed" } },
  ]));
  editor.updateObject = () => {
    const error = new Error("injected editor failure");
    error.code = "injected-failure";
    throw error;
  };

  assert.throws(() => applyTiledAiPatch(editor, normalized), (error) => error.code === "injected-failure");
  assert.deepEqual(editor.exportDocument(), source);
  assert.equal(editor.undoStack.length, 0);
  assert.equal(editor.dirty, false);
});
