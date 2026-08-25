/**
 * Bounded, model-independent impact summaries for Tiled patches.  This is a
 * review receipt, not a second copy of the map or patch: it contains layer
 * names, changed field names, small object anchors and a finite heatmap so the
 * editor can draw ghost/hotspot overlays without receiving tile/image bytes.
 */
export const MAP_AI_DIFF_VERSION = "wfl-tiled-diff-v1";

const MAX_LAYERS = 128;
const MAX_OBJECTS = 256;
const MAX_HEAT = 4_096;
const MAX_RESOURCES = 64;

export function summarizeTiledPatchImpact(document, patch, { maxHeat = MAX_HEAT } = {}) {
  const layersById = new Map(flattenLayers(document?.layers).map((layer) => [Number(layer.id), layer]));
  const layers = new Map();
  const objects = [];
  const heatmap = [];
  const resources = [];
  const resourceKeys = new Set();
  let globalBounds = null;
  let omittedHeat = 0;
  let omittedObjects = 0;
  let omittedLayers = 0;

  const layerReceipt = (layer) => {
    if (!layer) return null;
    const id = Number(layer.id);
    let receipt = layers.get(id);
    if (!receipt) {
      if (layers.size >= MAX_LAYERS) { omittedLayers += 1; return null; }
      receipt = { id, name: boundedText(layer.name || "", 200), type: boundedText(layer.type || "", 40), operationCount: 0, changedFields: new Set(), bounds: null };
      layers.set(id, receipt);
    }
    return receipt;
  };
  const addPoint = (layer, x, y, kind) => {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return;
    const point = { layerId: Number(layer?.id) || null, x: Number(x), y: Number(y), kind };
    globalBounds = expandBounds(globalBounds, point.x, point.y);
    const receipt = layerReceipt(layer);
    if (receipt) receipt.bounds = expandBounds(receipt.bounds, point.x, point.y);
    if (heatmap.length < maxHeat) heatmap.push(point); else omittedHeat += 1;
  };
  const addBox = (layer, x, y, width, height, kind) => {
    if (![x, y, width, height].every((value) => Number.isFinite(Number(value)))) return;
    const left = Number(x); const top = Number(y);
    const right = left + Math.max(0, Number(width)); const bottom = top + Math.max(0, Number(height));
    globalBounds = expandBounds(globalBounds, left, top);
    globalBounds = expandBounds(globalBounds, right, bottom);
    const receipt = layerReceipt(layer);
    if (receipt) {
      receipt.bounds = expandBounds(receipt.bounds, left, top);
      receipt.bounds = expandBounds(receipt.bounds, right, bottom);
    }
    // A rectangle is represented by its corners and center rather than every
    // cell, keeping fill/region receipts bounded for huge maps.
    addPoint(layer, left, top, kind);
    addPoint(layer, right, bottom, kind);
  };
  const addObject = (layer, object, action, changedFields = []) => {
    if (objects.length >= MAX_OBJECTS) { omittedObjects += 1; return; }
    const record = {
      layerId: Number(layer?.id) || null,
      layerName: boundedText(layer?.name || "", 200),
      objectId: Number.isSafeInteger(Number(object?.id)) ? Number(object.id) : null,
      action,
      changedFields: [...new Set(changedFields.map((value) => boundedText(value, 80)))].slice(0, 32),
    };
    const anchor = objectAnchor(object);
    if (anchor) record.anchor = anchor;
    objects.push(record);
    if (anchor) addBox(layer, anchor.x, anchor.y, anchor.width, anchor.height, `object-${action}`);
  };

  for (const operation of Array.isArray(patch?.operations) ? patch.operations : []) {
    const layer = layersById.get(Number(operation?.layerId));
    const receipt = layerReceipt(layer);
    if (receipt) {
      receipt.operationCount += 1;
      for (const key of Object.keys(operation?.changes || {})) receipt.changedFields.add(key);
      receipt.changedFields.add(String(operation?.op || "operation"));
    }
    if (operation?.op === "set-tiles") {
      for (const cell of Array.isArray(operation.cells) ? operation.cells : []) addPoint(layer, cell.x, cell.y, "tile");
    } else if (operation?.op === "fill-region") {
      addPoint(layer, operation.x, operation.y, "fill-anchor");
    } else if (operation?.op === "add-object") {
      addObject(layer, operation.object, "add", Object.keys(operation.object || {}));
    } else if (operation?.op === "update-object") {
      const before = findObject(layer, operation.objectId);
      const after = { ...(before || {}), ...(operation.changes || {}) };
      addObject(layer, after, "update", Object.keys(operation.changes || {}));
    } else if (operation?.op === "remove-object") {
      addObject(layer, findObject(layer, operation.objectId) || { id: operation.objectId }, "remove", ["object"]);
    }
    collectResourceReferences(operation, (key, value) => {
      const normalized = String(value).replaceAll("\\", "/");
      const identity = `${key}\0${normalized}`;
      if (resourceKeys.has(identity) || resources.length >= MAX_RESOURCES) return;
      resourceKeys.add(identity);
      resources.push({ kind: key, path: boundedText(normalized, 4_096) });
    });
  }

  return {
    version: MAP_AI_DIFF_VERSION,
    bounds: globalBounds ? normalizeBounds(globalBounds) : null,
    layers: [...layers.values()].map((entry) => ({ ...entry, changedFields: [...entry.changedFields].slice(0, 32), bounds: entry.bounds ? normalizeBounds(entry.bounds) : null })),
    objects,
    resources,
    heatmap,
    truncated: { layers: omittedLayers > 0, objects: omittedObjects > 0, heatmap: omittedHeat > 0 },
    omitted: { layers: omittedLayers, objects: omittedObjects, heatmap: omittedHeat },
  };
}

function flattenLayers(layers, output = []) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer && typeof layer === "object") output.push(layer);
    if (layer?.type === "group") flattenLayers(layer.layers, output);
  }
  return output;
}

function findObject(layer, id) {
  return Array.isArray(layer?.objects) ? layer.objects.find((object) => Number(object?.id) === Number(id)) || null : null;
}

function objectAnchor(object) {
  if (!Number.isFinite(Number(object?.x)) || !Number.isFinite(Number(object?.y))) return null;
  return { x: Number(object.x), y: Number(object.y), width: Number.isFinite(Number(object.width)) ? Number(object.width) : 0, height: Number.isFinite(Number(object.height)) ? Number(object.height) : 0 };
}

function expandBounds(bounds, x, y) {
  if (!bounds) return { minX: x, minY: y, maxX: x, maxY: y };
  return { minX: Math.min(bounds.minX, x), minY: Math.min(bounds.minY, y), maxX: Math.max(bounds.maxX, x), maxY: Math.max(bounds.maxY, y) };
}

function normalizeBounds(value) {
  return { x: value.minX, y: value.minY, width: Math.max(0, value.maxX - value.minX), height: Math.max(0, value.maxY - value.minY) };
}

function collectResourceReferences(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectResourceReferences(item, visit); return; }
  for (const [key, entry] of Object.entries(value)) {
    if (["image", "template", "source"].includes(key) && typeof entry === "string" && entry) visit(key, entry);
    if (key === "properties" && Array.isArray(entry)) for (const property of entry) if (property?.type === "file" && property.value) visit("file", property.value);
    collectResourceReferences(entry, visit);
  }
}

function boundedText(value, maximum) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}
