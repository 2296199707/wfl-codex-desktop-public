/**
 * Canonical protected-target contract shared by the browser preview, the
 * isolated patch worker, and the server-side commit path.
 *
 * A legacy string is treated as { kind: "file", path: string }.  Structured
 * targets are intentionally map-relative and contain no absolute paths.
 */
import path from "node:path";

const MAX_TARGETS = 256;
const MAX_PATH = 4_096;
const SEMANTIC_WORDS = new Set(["collision", "spawn", "teleport", "portal", "exit", "trigger", "checkpoint", "interactive"]);

export function normalizeProtectedTargets(value = []) {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", "protectedTargets 无效");
  const unique = new Map();
  for (const [index, entry] of value.entries()) {
    const normalized = normalizeProtectedTarget(entry, index);
    unique.set(stableJson(normalized), normalized);
  }
  return Object.freeze([...unique.values()]);
}

export function normalizeProtectedTarget(value, index = 0) {
  if (typeof value === "string") return Object.freeze({ kind: "file", path: normalizeRelativePath(value, `protectedTargets[${index}]`) });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", `protectedTargets[${index}] 必须是字符串或对象`);
  const kind = String(value.kind || "").trim().toLowerCase();
  if (kind === "file") return Object.freeze({ kind, path: normalizeRelativePath(value.path ?? value.mapPath, `protectedTargets[${index}].path`) });
  const mapPath = normalizeRelativePath(value.mapPath, `protectedTargets[${index}].mapPath`);
  if (kind === "layer") return Object.freeze({ kind, mapPath, layerId: positiveId(value.layerId, index, "layerId") });
  if (kind === "object") return Object.freeze({ kind, mapPath, layerId: positiveId(value.layerId, index, "layerId"), objectId: positiveId(value.objectId, index, "objectId") });
  if (kind === "region") return Object.freeze({ kind, mapPath, layerId: positiveId(value.layerId, index, "layerId"), rect: normalizeRect(value.rect, index) });
  if (kind === "semantic") {
    const role = String(value.role || "").trim().toLowerCase();
    if (!SEMANTIC_WORDS.has(role)) throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", `protectedTargets[${index}].role 不受支持`);
    return Object.freeze({ kind, mapPath, layerId: value.layerId == null ? null : positiveId(value.layerId, index, "layerId"), role });
  }
  throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", `protectedTargets[${index}].kind 不受支持`);
}

/** Return operation-level violations before a worker or save is started. */
export function findProtectedOperationViolations(document, patch, targets, mapPath) {
  const normalized = normalizeProtectedTargets(targets);
  const currentMap = normalizePathForCompare(mapPath);
  const layers = flattenLayers(document?.layers);
  const violations = [];
  for (const [index, operation] of (patch?.operations || []).entries()) {
    const layer = layers.find((entry) => entry.id === Number(operation?.layerId));
    for (const target of normalized) {
      if (target.kind === "file" && normalizePathForCompare(target.path) === currentMap) violations.push(violation(index, target, "受保护地图文件"));
      if (!layer || (target.mapPath && normalizePathForCompare(target.mapPath) !== currentMap)) continue;
      if (target.kind === "layer" && target.layerId === layer.id) violations.push(violation(index, target, `受保护图层 ${layer.name || layer.id}`));
      if (target.kind === "object" && target.layerId === layer.id && operationTargetsObject(operation, target.objectId)) violations.push(violation(index, target, `受保护对象 #${target.objectId}`));
      if (target.kind === "region" && target.layerId === layer.id && operationTouchesRegion(operation, layer, target.rect)) violations.push(violation(index, target, "受保护区域"));
      if (target.kind === "semantic" && target.layerId != null && target.layerId !== layer.id) continue;
      if (target.kind === "semantic" && operationTouchesSemantic(operation, layer, target.role)) violations.push(violation(index, target, `受保护语义对象 ${target.role}`));
    }
  }
  return violations;
}

/**
 * Compare protected portions of two parsed maps. This is the final anti-
 * bypass check: moving/renaming an object cannot evade a protected target.
 */
export function assertProtectedTargetsUnchanged(before, after, targets, mapPath) {
  const normalized = normalizeProtectedTargets(targets);
  const currentMap = normalizePathForCompare(mapPath);
  const beforeLayers = flattenLayers(before?.layers);
  const afterLayers = flattenLayers(after?.layers);
  for (const target of normalized) {
    if (target.kind === "file" && normalizePathForCompare(target.path) === currentMap) {
      if (stableJson(before) !== stableJson(after)) throw protectedError("MAP_AI_PROTECTED_TARGET_CHANGED", "AI 候选修改了受保护地图文件");
      continue;
    }
    if (target.mapPath && normalizePathForCompare(target.mapPath) !== currentMap) continue;
    if (target.kind === "layer") {
      const left = beforeLayers.find((entry) => entry.id === target.layerId);
      const right = afterLayers.find((entry) => entry.id === target.layerId);
      if (stableJson(left) !== stableJson(right)) throw protectedError("MAP_AI_PROTECTED_TARGET_CHANGED", `AI 候选修改了受保护图层 ${target.layerId}`);
    } else if (target.kind === "object") {
      const left = findObject(beforeLayers, target.layerId, target.objectId);
      const right = findObject(afterLayers, target.layerId, target.objectId);
      if (stableJson(left) !== stableJson(right)) throw protectedError("MAP_AI_PROTECTED_TARGET_CHANGED", `AI 候选修改了受保护对象 ${target.objectId}`);
    } else if (target.kind === "region") {
      if (regionSnapshot(beforeLayers, target) !== regionSnapshot(afterLayers, target)) throw protectedError("MAP_AI_PROTECTED_TARGET_CHANGED", "AI 候选修改了受保护区域");
    } else if (target.kind === "semantic") {
      const left = semanticObjects(beforeLayers, target);
      const right = semanticObjects(afterLayers, target);
      if (stableJson(left) !== stableJson(right)) throw protectedError("MAP_AI_PROTECTED_TARGET_CHANGED", `AI 候选修改了受保护语义对象 ${target.role}`);
    }
  }
  return true;
}

export function protectedTargetErrorCode(error) { return error?.code === "MAP_AI_PROTECTED_TARGET_CHANGED" || error?.code === "MAP_AI_PROTECTED_OPERATION"; }

function operationTargetsObject(operation, objectId) {
  if (["update-object", "remove-object"].includes(operation?.op)) return Number(operation.objectId) === objectId;
  return operation?.op === "add-object" && Number(operation.object?.id) === objectId;
}

function operationTouchesRegion(operation, layer, rect) {
  if (operation?.op === "set-tiles") return operation.cells.some((cell) => pointInRect(cell.x, cell.y, rect));
  if (operation?.op === "fill-region") return pointInRect(operation.x, operation.y, rect);
  if (!["add-object", "update-object", "remove-object"].includes(operation?.op)) return false;
  const object = operation.object || findObject([layer], layer.id, operation.objectId);
  if (!object) return false;
  const x = Number(operation.changes?.x ?? object.x ?? 0); const y = Number(operation.changes?.y ?? object.y ?? 0);
  return pointInRect(x, y, rect) || pointInRect(object.x, object.y, rect);
}

function operationTouchesSemantic(operation, layer, role) {
  const current = operation.op === "add-object" ? operation.object : findObject([layer], layer.id, operation.objectId);
  if (!current) return false;
  return semanticObjectMatches(current, role) || semanticObjectMatches({ ...current, ...(operation.changes || {}) }, role);
}

function regionSnapshot(layers, target) {
  const layer = layers.find((entry) => entry.id === target.layerId);
  if (!layer) return "missing-layer";
  const values = [];
  for (let y = target.rect.y; y < target.rect.y + target.rect.height; y += 1) for (let x = target.rect.x; x < target.rect.x + target.rect.width; x += 1) values.push(`${x},${y}:${tileAt(layer, x, y)}`);
  const objects = (layer.objects || [])
    .filter((object) => pointInRect(object.x, object.y, target.rect))
    .map((object) => ({ id: object.id, object }))
    .sort((a, b) => a.id - b.id);
  return `${values.join("|")}#${stableJson(objects)}`;
}

function tileAt(layer, x, y) {
  if (Array.isArray(layer.data) && x >= 0 && y >= 0 && x < layer.width && y < layer.height) return Number(layer.data[y * layer.width + x]) >>> 0;
  const chunk = (layer.chunks || []).find((entry) => x >= entry.x && y >= entry.y && x < entry.x + entry.width && y < entry.y + entry.height);
  return chunk ? Number(chunk.data[(y - chunk.y) * chunk.width + (x - chunk.x)]) >>> 0 : 0;
}

function semanticObjects(layers, target) {
  return layers.filter((layer) => target.layerId == null || layer.id === target.layerId).flatMap((layer) => (layer.objects || []).filter((object) => semanticObjectMatches(object, target.role)).map((object) => ({ layerId: layer.id, object })));
}
function semanticObjectMatches(object, role) {
  const text = [object?.class, object?.type, object?.name, ...(Array.isArray(object?.properties) ? object.properties.flatMap((entry) => [entry?.name, entry?.value]) : [])].join(" ").toLowerCase();
  return text.split(/[^a-z0-9_]+/u).includes(role) || text.includes(role);
}
function findObject(layers, layerId, objectId) { return layers.find((layer) => layer.id === layerId)?.objects?.find((object) => Number(object?.id) === objectId) || null; }
function flattenLayers(layers, parentId = null) { return (Array.isArray(layers) ? layers : []).flatMap((layer) => [{ ...layer, parentId }, ...flattenLayers(layer.layers, layer.id)]); }
function pointInRect(x, y, rect) { return Number(x) >= rect.x && Number(x) < rect.x + rect.width && Number(y) >= rect.y && Number(y) < rect.y + rect.height; }
function normalizeRect(value, index) { if (!value || !Number.isSafeInteger(Number(value.x)) || !Number.isSafeInteger(Number(value.y)) || !Number.isSafeInteger(Number(value.width)) || !Number.isSafeInteger(Number(value.height)) || Number(value.width) <= 0 || Number(value.height) <= 0) throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", `protectedTargets[${index}].rect 无效`); return Object.freeze({ x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) }); }
function positiveId(value, index, label) { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", `protectedTargets[${index}].${label} 无效`); return id; }
function normalizeRelativePath(value, label) { const text = String(value || "").replaceAll("\\", "/"); const normalized = path.posix.normalize(text); if (!text || text.includes("\0") || text.startsWith("/") || /^[a-z]:\//iu.test(text) || text.split("/").includes("..") || normalized === "." || normalized.startsWith("../") || normalized.length > MAX_PATH) throw protectedError("MAP_AI_PROTECTED_TARGET_INVALID", `${label} 必须是工程相对路径`); return normalized; }
function normalizePathForCompare(value) { return String(value || "").replaceAll("\\", "/").replace(/^\.\//u, ""); }
function stableJson(value) { return JSON.stringify(value === undefined ? null : value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry); }
function violation(index, target, message) { return { index, target, message }; }
function protectedError(code, message) { return Object.assign(new Error(message), { code, statusCode: 400 }); }
