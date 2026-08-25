/**
 * Deterministic, side-effect-free risk and approval policy for managed map AI.
 *
 * This module intentionally does not read files, inspect system load, call a
 * model, or grant an authorization lease. It only classifies an already
 * parsed map operation and maps that classification to the user's selected
 * map approval policy. File, version, project, runtime, and transaction
 * validation remain authoritative hard gates in the caller.
 */

export const MAP_AI_RISK_RULE_VERSION = "map-risk-v1";

export const MAP_AI_APPROVAL_POLICIES = Object.freeze([
  "ask_each",
  "ai_review",
  "full_authorization",
]);

export const MAP_AI_RISK_LEVELS = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
]);

const KNOWN_OPERATIONS = new Set([
  "set-tiles",
  "fill-region",
  "update-layer",
  "add-object",
  "update-object",
  "remove-object",
]);

const CRITICAL_OBJECT_WORDS = Object.freeze([
  "collision",
  "spawn",
  "teleport",
  "portal",
  "exit",
  "trigger",
  "checkpoint",
  "interactive",
]);

const HARD_BLOCKS = Object.freeze({
  authorization: "authorization_mismatch",
  protected: "protected_target",
  version: "base_version_mismatch",
  idempotency: "idempotency_invalid",
  path: "unsafe_path",
  tiled: "tiled_validation_failed",
  runtime: "runtime_incompatible",
  transaction: "transaction_not_ready",
  unsupported: "unsupported_operation",
});

/**
 * Classify a map task and decide whether the selected map approval policy can
 * proceed. Callers should pass results from their authoritative validators in
 * `gates`; omitted gates default to passing so this remains useful for a
 * pure risk preview. A write path should always provide every gate result.
 */
export function assessMapAiTask({
  approvalPolicy = "ask_each",
  operations = [],
  targetMapPaths = [],
  targetFiles = [],
  tileCellCount = null,
  ordinaryObjectCount = null,
  mapCount = null,
  sharedTilesetReplacement = false,
  mapResizeOrOrientation = false,
  layerStructureChange = false,
  assetPublication = false,
  sourceDeletion = false,
  previewOnly = false,
  gates = {},
} = {}) {
  const normalizedPolicy = normalizeApprovalPolicy(approvalPolicy);
  const normalizedOperations = normalizeOperations(operations);
  const normalizedTargetMapPaths = normalizeStringList(targetMapPaths ?? [], "targetMapPaths");
  const normalizedTargetFiles = normalizeStringList(targetFiles ?? [], "targetFiles");
  const normalizedGates = gates && typeof gates === "object" && !Array.isArray(gates) ? gates : {};
  const derived = deriveCounts({
    operations: normalizedOperations,
    tileCellCount,
    ordinaryObjectCount,
  });
  const hardBlocks = collectHardBlocks({
    gates: normalizedGates,
    operations: normalizedOperations,
    targetMapPaths: normalizedTargetMapPaths,
    targetFiles: normalizedTargetFiles,
    mapCount,
  });
  const classification = classifyRisk({
    operations: normalizedOperations,
    targetMapPaths: normalizedTargetMapPaths,
    targetFiles: normalizedTargetFiles,
    tileCellCount: derived.tileCellCount,
    ordinaryObjectCount: derived.ordinaryObjectCount,
    mapCount,
    sharedTilesetReplacement,
    mapResizeOrOrientation,
    layerStructureChange,
    assetPublication,
    sourceDeletion,
    previewOnly,
  });
  const decision = decideApproval({
    approvalPolicy: normalizedPolicy,
    riskLevel: classification.riskLevel,
    hardBlocks,
    operationCount: normalizedOperations.length,
  });

  return Object.freeze({
    ruleVersion: MAP_AI_RISK_RULE_VERSION,
    approvalPolicy: normalizedPolicy,
    riskLevel: classification.riskLevel,
    reasonCodes: Object.freeze(classification.reasonCodes),
    hardBlocks: Object.freeze(hardBlocks),
    tileCellCount: derived.tileCellCount,
    ordinaryObjectCount: derived.ordinaryObjectCount,
    operationCount: normalizedOperations.length,
    decision: Object.freeze(decision),
  });
}

export function classifyMapAiRisk(input = {}) {
  const result = assessMapAiTask({ ...input, approvalPolicy: "full_authorization" });
  return Object.freeze({
    ruleVersion: result.ruleVersion,
    riskLevel: result.riskLevel,
    reasonCodes: result.reasonCodes,
    hardBlocks: result.hardBlocks,
    tileCellCount: result.tileCellCount,
    ordinaryObjectCount: result.ordinaryObjectCount,
    operationCount: result.operationCount,
  });
}

export function decideMapAiApproval({
  approvalPolicy = "ask_each",
  riskLevel = "read_only",
  hardBlocks = [],
  operationCount = 0,
} = {}) {
  return Object.freeze(decideApproval({
    approvalPolicy: normalizeApprovalPolicy(approvalPolicy),
    riskLevel: normalizeRiskLevel(riskLevel),
    hardBlocks: normalizeStringList(hardBlocks, "hardBlocks"),
    operationCount: normalizeNonNegativeInteger(operationCount, "operationCount"),
  }));
}

function classifyRisk({
  operations,
  targetMapPaths,
  targetFiles,
  tileCellCount,
  ordinaryObjectCount,
  mapCount,
  sharedTilesetReplacement,
  mapResizeOrOrientation,
  layerStructureChange,
  assetPublication,
  sourceDeletion,
  previewOnly,
}) {
  if (previewOnly || operations.length === 0) {
    return { riskLevel: "read_only", reasonCodes: ["read_only"] };
  }

  const reasons = new Set();
  let risk = "low";
  if (tileCellCount > 256) {
    risk = maxRisk(risk, tileCellCount > 4_096 ? "high" : "medium");
    reasons.add(tileCellCount > 4_096 ? "tile_cells_over_4096" : "tile_cells_over_256");
  }
  if (ordinaryObjectCount > 16) {
    risk = maxRisk(risk, ordinaryObjectCount > 64 ? "high" : "medium");
    reasons.add(ordinaryObjectCount > 64 ? "objects_over_64" : "objects_over_16");
  }
  if (targetMapPaths.length > 1 || (Number.isSafeInteger(mapCount) && mapCount > 1)) {
    risk = "high";
    reasons.add("cross_map_transaction");
  }
  if (targetFiles.length > 1) {
    risk = maxRisk(risk, "medium");
    reasons.add("multiple_files");
  }
  if (targetFiles.some((file) => /\.tsj$/iu.test(file))) {
    risk = maxRisk(risk, "medium");
    reasons.add("external_tileset_reference");
  }
  if (sharedTilesetReplacement) {
    risk = "high";
    reasons.add("shared_tileset_replacement");
  }
  if (mapResizeOrOrientation) {
    risk = "high";
    reasons.add("map_geometry_change");
  }
  if (layerStructureChange) {
    risk = "high";
    reasons.add("layer_structure_change");
  }
  if (assetPublication) {
    risk = "high";
    reasons.add("asset_publication");
  }
  if (sourceDeletion) {
    risk = "high";
    reasons.add("source_deletion");
  }

  for (const operation of operations) {
    const opRisk = operationRisk(operation);
    risk = maxRisk(risk, opRisk.level);
    for (const reason of opRisk.reasons) reasons.add(reason);
  }

  if (reasons.size === 0) reasons.add("ordinary_map_edit");
  return { riskLevel: risk, reasonCodes: [...reasons].sort() };
}

function operationRisk(operation) {
  const reasons = new Set();
  if (operation.op === "fill-region") {
    const cells = integerOrNull(operation.cellCount ?? operation.estimatedCells ?? operation.maxCells);
    if (cells === null) {
      reasons.add("fill_size_unknown");
      return { level: "medium", reasons };
    }
    if (cells > 4_096) {
      reasons.add("fill_cells_over_4096");
      return { level: "high", reasons };
    }
    if (cells > 256) {
      reasons.add("fill_cells_over_256");
      return { level: "medium", reasons };
    }
  }
  if (operation.op === "update-layer") {
    const changes = operation.changes && typeof operation.changes === "object" ? operation.changes : {};
    if (Object.hasOwn(changes, "name")) {
      reasons.add("layer_rename");
      return { level: "high", reasons };
    }
  }
  if (["add-object", "update-object", "remove-object"].includes(operation.op)) {
    const type = operation.object?.type ?? operation.changes?.type ?? operation.objectType ?? "";
    if (isCriticalObjectType(type)) {
      reasons.add("runtime_critical_object");
      return { level: "medium", reasons };
    }
  }
  return { level: "low", reasons };
}

function collectHardBlocks({ gates, operations, targetMapPaths, targetFiles, mapCount }) {
  const blocks = new Set();
  if (gates.authorization === false) blocks.add(HARD_BLOCKS.authorization);
  if (gates.protected === false || gates.protectedTarget === true) blocks.add(HARD_BLOCKS.protected);
  if (gates.version === false || gates.baseVersion === false) blocks.add(HARD_BLOCKS.version);
  if (gates.idempotency === false) blocks.add(HARD_BLOCKS.idempotency);
  if (gates.path === false || hasUnsafeReference([...targetMapPaths, ...targetFiles])) blocks.add(HARD_BLOCKS.path);
  if (gates.tiled === false) blocks.add(HARD_BLOCKS.tiled);
  if (gates.runtime === false) blocks.add(HARD_BLOCKS.runtime);
  if (gates.transaction === false) blocks.add(HARD_BLOCKS.transaction);
  if (!Array.isArray(operations)) blocks.add(HARD_BLOCKS.unsupported);
  if (Number.isSafeInteger(mapCount) && mapCount < 1) blocks.add(HARD_BLOCKS.authorization);
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!KNOWN_OPERATIONS.has(operation.op)) blocks.add(HARD_BLOCKS.unsupported);
  }
  return [...blocks].sort();
}

function decideApproval({ approvalPolicy, riskLevel, hardBlocks, operationCount }) {
  if (hardBlocks.length) {
    return { status: "blocked", requiresUser: false, approvalUnit: "none", operationCount };
  }
  if (riskLevel === "read_only") {
    return { status: "allow", requiresUser: false, approvalUnit: "none", operationCount };
  }
  if (approvalPolicy === "full_authorization") {
    return { status: "allow", requiresUser: false, approvalUnit: "task", operationCount };
  }
  if (approvalPolicy === "ask_each") {
    return { status: "requires_user_approval", requiresUser: true, approvalUnit: "operation", operationCount };
  }
  if (riskLevel === "low") {
    return { status: "allow", requiresUser: false, approvalUnit: "batch", operationCount };
  }
  return {
    status: "requires_user_approval",
    requiresUser: true,
    approvalUnit: riskLevel === "high" ? "operation" : "batch",
    operationCount,
  };
}

function deriveCounts({ operations, tileCellCount, ordinaryObjectCount }) {
  const tiles = tileCellCount == null
    ? operations.reduce((sum, operation) => sum + (operation.op === "set-tiles" ? arrayLength(operation.cells) : 0), 0)
    : normalizeNonNegativeInteger(tileCellCount, "tileCellCount");
  const objects = ordinaryObjectCount == null
    ? operations.reduce((sum, operation) => sum + (["add-object", "update-object", "remove-object"].includes(operation.op) ? 1 : 0), 0)
    : normalizeNonNegativeInteger(ordinaryObjectCount, "ordinaryObjectCount");
  return { tileCellCount: tiles, ordinaryObjectCount: objects };
}

function normalizeOperations(value) {
  if (!Array.isArray(value)) throw new TypeError("operations must be an array");
  return value.map((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation) || typeof operation.op !== "string") {
      throw new TypeError("each map operation must contain op");
    }
    return operation;
  });
}

function normalizeApprovalPolicy(value) {
  if (!MAP_AI_APPROVAL_POLICIES.includes(value)) throw new TypeError("invalid map approval policy");
  return value;
}

function normalizeRiskLevel(value) {
  if (!MAP_AI_RISK_LEVELS.includes(value)) throw new TypeError("invalid map risk level");
  return value;
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new TypeError(`${label} must be an array of strings`);
  return value;
}

function normalizeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function maxRisk(left, right) {
  const order = new Map(MAP_AI_RISK_LEVELS.map((level, index) => [level, index]));
  return order.get(right) > order.get(left) ? right : left;
}

function isCriticalObjectType(value) {
  const type = String(value || "").toLowerCase();
  return CRITICAL_OBJECT_WORDS.some((word) => type.includes(word));
}

function hasUnsafeReference(values) {
  return values.some((value) => typeof value === "string" && (
    value.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^(?:data|blob|https?|file):/iu.test(value)
    || value.split(/[\\/]/u).includes("..")
  ));
}
