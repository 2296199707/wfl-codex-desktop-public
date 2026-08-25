import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTiledPatchImpact } from "../lib/map-ai-diff.mjs";

test("Tiled impact receipt is bounded and contains heat/object/resource summaries", () => {
  const document = {
    layers: [
      { id: 1, name: "Decor", type: "tilelayer", width: 4, height: 4, data: Array(16).fill(0) },
      { id: 2, name: "NPCs", type: "objectgroup", objects: [{ id: 7, x: 10, y: 12, width: 4, height: 8 }] },
    ],
  };
  const patch = {
    operations: [
      { op: "set-tiles", layerId: 1, cells: [{ x: 1, y: 2, gid: 3 }, { x: 2, y: 2, gid: 3 }] },
      { op: "update-object", layerId: 2, objectId: 7, changes: { x: 20, image: "../images/npc.png" } },
    ],
  };
  const result = summarizeTiledPatchImpact(document, patch, { maxHeat: 1 });
  assert.equal(result.version, "wfl-tiled-diff-v1");
  assert.equal(result.heatmap.length, 1);
  assert.equal(result.truncated.heatmap, true);
  assert.equal(result.objects[0].objectId, 7);
  assert.deepEqual(result.resources, [{ kind: "image", path: "../images/npc.png" }]);
});
