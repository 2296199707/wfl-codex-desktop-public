import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { parseTiledDocument, serializeTiledDocument } from "../public/map-editor/tiled-document.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import {
  TILED_OBJECT_SHAPES,
  tiledObjectSemantic,
  tiledObjectShape,
} from "../public/map-editor/map-object-model.js";

const FIXTURE = new URL("./fixtures/tiled/maps/tiled-1.12.2-objects.tmj", import.meta.url);

test("round-trips the stage 5 object fixture while preserving Tiled and unknown fields", async () => {
  const source = await fs.readFile(FIXTURE);
  const parsed = parseTiledDocument(source, {
    expectedKind: "map",
    sourcePath: "maps/tiled-1.12.2-objects.tmj",
  });
  assert.deepEqual(parsed.diagnostics.filter(({ severity }) => severity === "error"), []);
  const objects = parsed.document.layers[0].objects;
  assert.deepEqual(objects.slice(0, 8).map(tiledObjectShape), TILED_OBJECT_SHAPES);
  assert.deepEqual(objects.slice(8).map(tiledObjectSemantic), ["spawn", "portal"]);
  assert.deepEqual(parsed.document.wflUnknownRootField, ["keep", 5]);
  assert.deepEqual(objects[0].wflUnknownObjectField, { keep: true });

  const serialized = serializeTiledDocument(parsed.document);
  const reparsed = parseTiledDocument(serialized, {
    expectedKind: "map",
    sourcePath: "maps/tiled-1.12.2-objects.tmj",
  });
  assert.deepEqual(reparsed.document, parsed.document);
});

test("edits object geometry, text, gid, order, and references through reversible history", async () => {
  const parsed = parseTiledDocument(await fs.readFile(FIXTURE), {
    expectedKind: "map",
    sourcePath: "maps/tiled-1.12.2-objects.tmj",
  });
  const editor = new TiledEditDocument(parsed.document);
  const before = editor.exportDocument();
  editor.runBatch("完整对象编辑", () => {
    editor.updateObject(1, 5, { polygon: [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 12, y: 24 }] });
    editor.updateObject(1, 7, { gid: 1, width: 48, height: 32, rotation: 45 });
    editor.updateObject(1, 8, { text: { ...editor.layerById(1).objects[7].text, text: "Edited" }, opacity: 0.75 });
    editor.updateObject(1, 10, {
      properties: [{ name: "targetMap", type: "file", value: "other.tmj" }, { name: "targetSpawn", type: "string", value: "entry" }],
    });
    editor.moveObjects(1, [9, 10], "back");
  });
  assert.equal(editor.undoStack.length, 1);
  assert.deepEqual(editor.layerById(1).objects.slice(0, 2).map(({ id }) => id), [9, 10]);
  assert.equal(editor.layerById(1).objects.find(({ id }) => id === 8).text.text, "Edited");
  editor.undo();
  assert.deepEqual(editor.exportDocument(), before);
  editor.redo();
  assert.equal(editor.layerById(1).objects.find(({ id }) => id === 7).rotation, 45);
});
