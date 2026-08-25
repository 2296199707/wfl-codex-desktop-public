import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_AI_RISK_RULE_VERSION,
  assessMapAiTask,
  classifyMapAiRisk,
  decideMapAiApproval,
} from "../lib/map-ai-risk.mjs";

function tiles(count = 1) {
  return { op: "set-tiles", layerId: 1, cells: Array.from({ length: count }, (_, index) => ({ x: index, y: 0, gid: 1 })) };
}

function objectOperation(type = "decoration") {
  return { op: "update-object", layerId: 2, objectId: 1, changes: { type } };
}

test("read-only work is always allowed and never asks for approval", () => {
  for (const approvalPolicy of ["ask_each", "ai_review", "full_authorization"]) {
    const result = assessMapAiTask({ approvalPolicy, previewOnly: true });
    assert.equal(result.ruleVersion, MAP_AI_RISK_RULE_VERSION);
    assert.equal(result.riskLevel, "read_only");
    assert.equal(result.decision.status, "allow");
    assert.equal(result.decision.requiresUser, false);
  }
});

test("ask_each creates one approval unit per operation", () => {
  const result = assessMapAiTask({
    approvalPolicy: "ask_each",
    operations: [tiles(), objectOperation()],
  });
  assert.equal(result.riskLevel, "low");
  assert.equal(result.decision.status, "requires_user_approval");
  assert.equal(result.decision.approvalUnit, "operation");
  assert.equal(result.decision.operationCount, 2);
});

test("ai_review uses fixed risk bands and does not let the model choose the level", () => {
  const low = assessMapAiTask({ approvalPolicy: "ai_review", operations: [tiles(256)] });
  const medium = assessMapAiTask({ approvalPolicy: "ai_review", operations: [tiles(257)] });
  const high = assessMapAiTask({ approvalPolicy: "ai_review", operations: [tiles(4_097)] });
  assert.deepEqual([low.riskLevel, medium.riskLevel, high.riskLevel], ["low", "medium", "high"]);
  assert.equal(low.decision.status, "allow");
  assert.equal(low.decision.approvalUnit, "batch");
  assert.equal(medium.decision.status, "requires_user_approval");
  assert.equal(medium.decision.approvalUnit, "batch");
  assert.equal(high.decision.status, "requires_user_approval");
  assert.equal(high.decision.approvalUnit, "operation");
});

test("full authorization skips risk prompts but remains bounded by hard gates", () => {
  const allowed = assessMapAiTask({
    approvalPolicy: "full_authorization",
    operations: [tiles(4_097)],
  });
  assert.equal(allowed.riskLevel, "high");
  assert.equal(allowed.decision.status, "allow");
  assert.equal(allowed.decision.requiresUser, false);

  const blocked = assessMapAiTask({
    approvalPolicy: "full_authorization",
    operations: [tiles(1)],
    gates: { authorization: false },
  });
  assert.equal(blocked.decision.status, "blocked");
  assert.deepEqual(blocked.hardBlocks, ["authorization_mismatch"]);
});

test("fixed thresholds and semantic operations are deterministic", () => {
  const atLow = classifyMapAiRisk({ operations: [tiles(256)] });
  const atMedium = classifyMapAiRisk({ operations: [tiles(4_096)] });
  const aboveMedium = classifyMapAiRisk({ operations: [tiles(4_097)] });
  const critical = classifyMapAiRisk({ operations: [objectOperation("teleport")] });
  const crossMap = classifyMapAiRisk({ operations: [tiles(1)], targetMapPaths: ["maps/a.tmj", "maps/b.tmj"] });
  assert.equal(atLow.riskLevel, "low");
  assert.equal(atMedium.riskLevel, "medium");
  assert.equal(aboveMedium.riskLevel, "high");
  assert.equal(critical.riskLevel, "medium");
  assert.equal(crossMap.riskLevel, "high");
  assert.deepEqual(classifyMapAiRisk({ operations: [tiles(257)] }), classifyMapAiRisk({ operations: [tiles(257)] }));
});

test("external references, layer structure and publication are classified without system inspection", () => {
  const result = assessMapAiTask({
    approvalPolicy: "ai_review",
    operations: [tiles(1)],
    targetFiles: ["maps/world.tmj", "tilesets/terrain.tsj"],
    layerStructureChange: true,
    assetPublication: true,
  });
  assert.equal(result.riskLevel, "high");
  assert.ok(result.reasonCodes.includes("layer_structure_change"));
  assert.ok(result.reasonCodes.includes("asset_publication"));
  assert.ok(result.reasonCodes.includes("external_tileset_reference"));
});

test("unknown operations and unsafe references are hard blocked for every policy", () => {
  for (const approvalPolicy of ["ask_each", "ai_review", "full_authorization"]) {
    const result = assessMapAiTask({
      approvalPolicy,
      operations: [{ op: "replace-entire-map" }],
      targetFiles: ["../outside.tmj"],
    });
    assert.equal(result.decision.status, "blocked");
    assert.ok(result.hardBlocks.includes("unsupported_operation"));
    assert.ok(result.hardBlocks.includes("unsafe_path"));
  }
});

test("approval policy and risk inputs reject invalid values", () => {
  assert.throws(() => assessMapAiTask({ approvalPolicy: "auto" }), /invalid map approval policy/u);
  assert.throws(() => decideMapAiApproval({ riskLevel: "critical" }), /invalid map risk level/u);
  assert.throws(() => assessMapAiTask({ operations: [{ bad: true }] }), /each map operation must contain op/u);
});
