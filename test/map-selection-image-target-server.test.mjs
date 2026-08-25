import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAP_SELECTION_IMAGE_OPERATION_PURPOSES,
  validateMapSelectionImageTaskInChild,
  validateMapSelectionImageTaskContract,
} from "../lib/map-selection-image-target.mjs";
import { createMapSelectionImageTarget } from "../public/map-editor/map-selection-image-target.js";

const VERSION = "a".repeat(64);

function map({ orientation = "orthogonal", infinite = false } = {}) {
  return {
    type: "map",
    orientation,
    infinite,
    width: 20,
    height: 12,
    tilewidth: 32,
    tileheight: 16,
    tilesets: [],
    layers: [{
      id: 1,
      name: "World",
      type: "group",
      layers: [{
        id: 2,
        name: "Ground",
        type: "tilelayer",
        width: 20,
        height: 12,
        data: Array(240).fill(0),
      }],
    }],
  };
}

function target(options = {}) {
  return createMapSelectionImageTarget({
    document: map(options.map),
    layerId: 2,
    mapVersion: VERSION,
    editorStateId: 4,
    selection: options.selection || { x: 2, y: 2, width: 2, height: 2 },
    expansion: options.expansion || { unit: "tile", right: 1 },
    purpose: options.purpose || "layer-image",
    maskMode: options.maskMode || "strict",
    preserveSource: options.preserveSource || "exact",
  });
}

test("exports an explicit operation/target matrix", () => {
  assert.deepEqual(MAP_SELECTION_IMAGE_OPERATION_PURPOSES.generate, ["layer-image", "tileset", "prop"]);
  assert.deepEqual(MAP_SELECTION_IMAGE_OPERATION_PURPOSES.edit, ["layer-image", "tileset", "prop"]);
  assert.deepEqual(MAP_SELECTION_IMAGE_OPERATION_PURPOSES.outpaint, ["layer-image", "tileset"]);
});

test("rebuilds selection coordinates from the authoritative TMJ in a bounded child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-selection-child-"));
  const targetPath = path.join(root, "world.tmj");
  const source = Buffer.from(JSON.stringify(map()));
  const version = crypto.createHash("sha256").update(source).digest("hex");
  await fs.writeFile(targetPath, source);
  try {
    const serialized = createMapSelectionImageTarget({
      document: map(),
      layerId: 2,
      mapVersion: version,
      editorStateId: 4,
      selection: { x: 2, y: 2, width: 2, height: 2 },
      expansion: { unit: "tile", right: 1 },
    });
    const contract = await validateMapSelectionImageTaskInChild({
      targetPath,
      serializedTarget: serialized,
      currentMapVersion: version,
      currentEditorStateId: 4,
      operation: "outpaint",
      request: {
        operation: "outpaint",
        outpaint: serialized.expansion.world,
        preserveSource: "exact",
        alignmentPolicy: "reject",
      },
      maxMapBytes: 1024 * 1024,
    });
    assert.equal(contract.operation, "outpaint");
    assert.deepEqual(contract.target.layer.path, [1, 2]);

    const forged = structuredClone(serialized);
    forged.target.world.x += 32;
    await assert.rejects(validateMapSelectionImageTaskInChild({
      targetPath,
      serializedTarget: forged,
      currentMapVersion: version,
      currentEditorStateId: 4,
      operation: "outpaint",
      request: {
        operation: "outpaint",
        outpaint: forged.expansion.world,
        preserveSource: "exact",
        alignmentPolicy: "reject",
      },
      maxMapBytes: 1024 * 1024,
    }), (error) => error.code === "MAP_IMAGE_SELECTION_DERIVED_MISMATCH");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("binds outpaint target to map version, editor state, logical canvas, and policies", () => {
  const value = target({ preserveSource: "seamless" });
  const contract = validateMapSelectionImageTaskContract(value, {
    document: map(),
    currentMapVersion: VERSION,
    currentEditorStateId: 4,
    operation: "outpaint",
    blendMargin: 64,
    alignmentPolicy: "pad-and-crop",
  });
  assert.equal(contract.operation, "outpaint");
  assert.deepEqual(contract.policies, {
    maskMode: null,
    preserveSource: "seamless",
    blendMargin: 64,
    alignmentPolicy: "pad-and-crop",
  });
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(contract.target.logicalCanvas.width, contract.target.target.world.width);
});

test("rechecks derived coordinates and logical canvas instead of trusting client fields", () => {
  const value = structuredClone(target());
  value.target.world.x += 1;
  assert.throws(
    () => validateMapSelectionImageTaskContract(value, {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint",
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_DERIVED_MISMATCH",
  );
  const canvas = structuredClone(target());
  canvas.logicalCanvas.width += 1;
  assert.throws(
    () => validateMapSelectionImageTaskContract(canvas, {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint",
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_CANVAS_MISMATCH",
  );
});

test("detects stale map and editor-state versions", () => {
  const value = target();
  assert.throws(
    () => validateMapSelectionImageTaskContract(value, {
      document: map(), currentMapVersion: "b".repeat(64), currentEditorStateId: 4, operation: "outpaint",
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT" && error.statusCode === 409,
  );
  assert.throws(
    () => validateMapSelectionImageTaskContract(value, {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 5, operation: "outpaint",
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT" && error.statusCode === 409,
  );
});

test("supports isometric projection and world-unit expansion", () => {
  const source = createMapSelectionImageTarget({
    document: (() => {
      const value = { ...map({ orientation: "isometric", infinite: true }), tilewidth: 64, tileheight: 32 };
      value.layers[0].layers[0].chunks = [];
      return value;
    })(),
    layerId: 2,
    mapVersion: VERSION,
    editorStateId: 2,
    selection: { x: -1, y: 2, width: 2, height: 2 },
    expansion: { unit: "world", top: 3, right: 5, bottom: 7, left: 11 },
  });
  const isoDocument = (() => {
    const value = { ...map({ orientation: "isometric", infinite: true }), tilewidth: 64, tileheight: 32 };
    value.layers[0].layers[0].chunks = [];
    return value;
  })();
  const contract = validateMapSelectionImageTaskContract(source, {
    document: isoDocument,
    currentMapVersion: VERSION,
    currentEditorStateId: 2,
    operation: "outpaint",
  });
  assert.deepEqual(contract.target.expansion.world, { top: 3, right: 5, bottom: 7, left: 11 });
  assert.equal(contract.target.map.orientation, "isometric");
});

test("enforces operation/target and expansion combinations", () => {
  assert.throws(
    () => validateMapSelectionImageTaskContract(target({ purpose: "prop" }), {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 1,
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_OPERATION_TARGET_INVALID",
  );
  const noExpansion = target({ expansion: { unit: "tile" } });
  assert.throws(
    () => validateMapSelectionImageTaskContract(noExpansion, {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 1,
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_OPERATION_TARGET_INVALID",
  );
  assert.throws(
    () => validateMapSelectionImageTaskContract(target(), {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "edit",
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_OPERATION_TARGET_INVALID",
  );
});

test("validates strict/soft, exact/seamless, blend margin, and alignment policy", () => {
  const edit = target({ expansion: { unit: "tile" }, maskMode: "soft" });
  const editContract = validateMapSelectionImageTaskContract(edit, {
    document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "edit",
  });
  assert.equal(editContract.policies.maskMode, "soft");
  assert.throws(
    () => validateMapSelectionImageTaskContract(edit, {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "edit", maskMode: "strict",
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_POLICY_MISMATCH",
  );
  const seamless = target({ preserveSource: "seamless" });
  assert.throws(
    () => validateMapSelectionImageTaskContract(seamless, {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 513,
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_BLEND_MARGIN_INVALID",
  );
  assert.throws(
    () => validateMapSelectionImageTaskContract(target(), {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", alignmentPolicy: "auto", blendMargin: 1,
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_ALIGNMENT_POLICY_INVALID",
  );
});

test("rejects project-path, publication, provider-user, and absolute source injection", () => {
  for (const value of [
    { ...target(), projectPath: "/srv/game" },
    { ...target(), publishPath: "assets/out.png" },
    { ...target(), providerUser: "admin" },
  ]) {
    assert.throws(
      () => validateMapSelectionImageTaskContract(value, {
        document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 1,
      }),
      (error) => error.code === "MAP_IMAGE_SELECTION_PRIVILEGED_FIELD",
    );
  }
  assert.throws(
    () => validateMapSelectionImageTaskContract(target(), {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 1,
      request: { sourcePath: "/srv/game/source.png" },
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_SOURCE_PATH_INVALID",
  );
});

test("accepts safe project-relative source and mask paths", () => {
  assert.doesNotThrow(() => validateMapSelectionImageTaskContract(target(), {
    document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint",
    request: { sourcePath: "assets/maps/source.png", maskPath: "assets/maps/mask.png" },
  }));
});

test("applies explicit administrator logical-canvas limits", () => {
  assert.throws(
    () => validateMapSelectionImageTaskContract(target(), {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 1,
      limits: { maxWorldWidth: 32 },
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_SIZE_LIMIT",
  );
  assert.throws(
    () => validateMapSelectionImageTaskContract(target(), {
      document: map(), currentMapVersion: VERSION, currentEditorStateId: 4, operation: "outpaint", blendMargin: 1,
      expectedLogicalCanvas: { width: 1, height: 1 },
    }),
    (error) => error.code === "MAP_IMAGE_SELECTION_CANVAS_MISMATCH",
  );
});
