import { tiledLayerEntries } from "./tiled-document.js?v=0.44.64";
import { tiledTileRegionBounds } from "./tiled-render-model.js?v=0.44.64";

export const MAP_SELECTION_IMAGE_TARGET_SCHEMA = "wfl.map-selection-image-target.v1";

const PURPOSES = new Set(["layer-image", "tileset", "prop"]);
const MASK_MODES = new Set(["strict", "soft"]);
const PRESERVE_MODES = new Set(["exact", "seamless"]);
const EXPANSION_UNITS = new Set(["tile", "world"]);
const EDITABLE_LAYER_TYPES = new Set(["group", "imagelayer", "objectgroup", "tilelayer"]);

export class MapSelectionImageTargetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MapSelectionImageTargetError";
    this.code = code;
    this.statusCode = code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT" ? 409 : 400;
    Object.assign(this, details);
  }
}

/**
 * Build the provider-independent target for an image task originating from a
 * snapped map selection. Provider canvas negotiation belongs downstream in
 * image-canvas-plan.mjs; this module only describes the logical map canvas.
 */
export function createMapSelectionImageTarget({
  document,
  layerId,
  selection,
  mapVersion,
  expectedMapVersion,
  editorStateId = null,
  purpose = "layer-image",
  expansion = null,
  maskMode = "strict",
  preserveSource = "exact",
  limits = null,
} = {}) {
  validateMap(document);
  const version = normalizeVersion(mapVersion);
  if (expectedMapVersion != null && version !== normalizeVersion(expectedMapVersion)) {
    throw targetError(
      "MAP_IMAGE_SELECTION_VERSION_CONFLICT",
      "地图版本已变化，请重新选择区域",
      { mapVersion: version, expectedMapVersion: String(expectedMapVersion) },
    );
  }
  const stateId = normalizeEditorStateId(editorStateId);
  const normalizedPurpose = enumValue(purpose, PURPOSES, "MAP_IMAGE_SELECTION_PURPOSE_INVALID", "目标用途无效");
  const normalizedMaskMode = enumValue(maskMode, MASK_MODES, "MAP_IMAGE_SELECTION_MASK_MODE_INVALID", "蒙版模式无效");
  const normalizedPreserveSource = enumValue(
    preserveSource,
    PRESERVE_MODES,
    "MAP_IMAGE_SELECTION_PRESERVE_MODE_INVALID",
    "原图保留模式无效",
  );
  const entry = requireLayer(document, layerId);
  const tile = normalizeTileSelection(selection);
  validateSelectionRange(document, entry.layer, tile);

  const normalizedLimits = normalizeLimits(limits);
  validateTileSize(tile, normalizedLimits, "选区");
  const layerOffset = layerPixelOffset(entry);
  const mapTile = {
    x: safeAdd(tile.x, entry.layer.type === "tilelayer" ? integer(entry.layer.x, 0) : 0, "MAP_IMAGE_SELECTION_RANGE_INVALID"),
    y: safeAdd(tile.y, entry.layer.type === "tilelayer" ? integer(entry.layer.y, 0) : 0, "MAP_IMAGE_SELECTION_RANGE_INVALID"),
    width: tile.width,
    height: tile.height,
  };
  const world = projectedTileRect(document, mapTile, layerOffset);
  validateSuppliedWorld(selection, world);
  validateWorldSize(world, normalizedLimits, "选区");

  const normalizedExpansion = normalizeExpansion(expansion);
  let targetTile = null;
  let targetMapTile = null;
  let targetWorld;
  let worldExpansion;
  if (normalizedExpansion.unit === "tile") {
    targetTile = expandRect(tile, normalizedExpansion.sides);
    validateTileSize(targetTile, normalizedLimits, "扩图目标");
    targetMapTile = expandRect(mapTile, normalizedExpansion.sides);
    targetWorld = projectedTileRect(document, targetMapTile, layerOffset);
    worldExpansion = rectExpansion(world, targetWorld);
  } else {
    worldExpansion = normalizedExpansion.sides;
    targetWorld = expandRect(world, worldExpansion);
  }
  validateWorldSize(targetWorld, normalizedLimits, "扩图目标");

  const target = {
    schema: MAP_SELECTION_IMAGE_TARGET_SCHEMA,
    purpose: normalizedPurpose,
    map: {
      version,
      editorStateId: stateId,
      orientation: String(document.orientation || "orthogonal"),
      infinite: document.infinite === true,
      tileSize: { width: document.tilewidth, height: document.tileheight },
    },
    layer: {
      id: entry.layer.id,
      type: entry.layer.type,
      name: typeof entry.layer.name === "string" ? entry.layer.name : "",
      path: [...entry.ancestors, entry.layer].map((layer) => layer.id),
    },
    selection: {
      tile: tileRect("layer", tile),
      mapTile: tileRect("map", mapTile),
      world,
    },
    expansion: {
      unit: normalizedExpansion.unit,
      tile: normalizedExpansion.unit === "tile" ? { ...normalizedExpansion.sides } : null,
      world: { ...worldExpansion },
    },
    target: {
      tile: targetTile ? tileRect("layer", targetTile) : null,
      mapTile: targetMapTile ? tileRect("map", targetMapTile) : null,
      world: targetWorld,
      sourceOffset: {
        x: world.x - targetWorld.x,
        y: world.y - targetWorld.y,
      },
    },
    policies: {
      maskMode: normalizedMaskMode,
      preserveSource: normalizedPreserveSource,
    },
    logicalCanvas: {
      width: targetWorld.width,
      height: targetWorld.height,
    },
  };
  return deepFreeze(target);
}

/**
 * Rebuild an untrusted serialized target against the current document. All
 * derived coordinates are discarded and calculated again from Tiled data.
 */
export function parseMapSelectionImageTarget(value, {
  document,
  currentMapVersion,
  currentEditorStateId = null,
  limits = null,
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw targetError("MAP_IMAGE_SELECTION_TARGET_INVALID", "地图选区图片目标必须是对象");
  }
  if (value.schema !== MAP_SELECTION_IMAGE_TARGET_SCHEMA) {
    throw targetError("MAP_IMAGE_SELECTION_SCHEMA_INVALID", "地图选区图片目标版本不受支持");
  }
  const version = normalizeVersion(value.map?.version);
  if (currentMapVersion != null && version !== normalizeVersion(currentMapVersion)) {
    throw targetError(
      "MAP_IMAGE_SELECTION_VERSION_CONFLICT",
      "地图版本已变化，请重新选择区域",
      { mapVersion: version, expectedMapVersion: String(currentMapVersion) },
    );
  }
  const serializedStateId = normalizeEditorStateId(value.map?.editorStateId);
  if (currentEditorStateId != null && serializedStateId !== normalizeEditorStateId(currentEditorStateId)) {
    throw targetError(
      "MAP_IMAGE_SELECTION_VERSION_CONFLICT",
      "地图编辑状态已变化，请重新选择区域",
      { editorStateId: serializedStateId, expectedEditorStateId: currentEditorStateId },
    );
  }
  const expansionUnit = value.expansion?.unit || "tile";
  const expansion = {
    unit: expansionUnit,
    ...((expansionUnit === "world" ? value.expansion?.world : value.expansion?.tile) || {}),
  };
  return createMapSelectionImageTarget({
    document,
    layerId: value.layer?.id,
    selection: {
      ...(value.selection?.tile || {}),
      world: value.selection?.world,
    },
    mapVersion: version,
    expectedMapVersion: currentMapVersion,
    editorStateId: serializedStateId,
    purpose: value.purpose,
    expansion,
    maskMode: value.policies?.maskMode,
    preserveSource: value.policies?.preserveSource,
    limits,
  });
}

function validateMap(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.type !== "map") {
    throw targetError("MAP_IMAGE_SELECTION_MAP_INVALID", "图片选区必须来自有效的 Tiled 地图");
  }
  for (const [key, label] of [["tilewidth", "瓦片宽度"], ["tileheight", "瓦片高度"]]) {
    if (!Number.isSafeInteger(document[key]) || document[key] < 1) {
      throw targetError("MAP_IMAGE_SELECTION_MAP_INVALID", `${label}无效`);
    }
  }
}

function requireLayer(document, layerId) {
  const id = Number(layerId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw targetError("MAP_IMAGE_SELECTION_LAYER_INVALID", "地图图层标识无效");
  }
  for (const entry of tiledLayerEntries(document)) {
    if (entry.layer?.id !== id) continue;
    if (!EDITABLE_LAYER_TYPES.has(entry.layer.type)) {
      throw targetError("MAP_IMAGE_SELECTION_LAYER_INVALID", "当前图层不能作为图片任务目标");
    }
    const ancestors = [];
    let parent = entry.parent;
    while (parent?.layer) {
      ancestors.unshift(parent.layer);
      parent = parent.parent;
    }
    return { layer: entry.layer, ancestors };
  }
  throw targetError("MAP_IMAGE_SELECTION_LAYER_NOT_FOUND", "地图图层不存在");
}

function normalizeTileSelection(selection) {
  const source = selection?.tile && typeof selection.tile === "object" ? selection.tile : selection;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw targetError("MAP_IMAGE_SELECTION_RANGE_INVALID", "地图选区无效");
  }
  let startColumn;
  let endColumn;
  let startRow;
  let endRow;
  if ([source.startColumn, source.endColumn, source.startRow, source.endRow].every(Number.isSafeInteger)) {
    startColumn = Math.min(source.startColumn, source.endColumn);
    endColumn = Math.max(source.startColumn, source.endColumn);
    startRow = Math.min(source.startRow, source.endRow);
    endRow = Math.max(source.startRow, source.endRow);
  } else if (
    Number.isSafeInteger(source.x)
    && Number.isSafeInteger(source.y)
    && Number.isSafeInteger(source.width)
    && Number.isSafeInteger(source.height)
    && source.width > 0
    && source.height > 0
  ) {
    startColumn = source.x;
    startRow = source.y;
    endColumn = safeAdd(source.x, source.width - 1, "MAP_IMAGE_SELECTION_RANGE_INVALID");
    endRow = safeAdd(source.y, source.height - 1, "MAP_IMAGE_SELECTION_RANGE_INVALID");
  } else {
    throw targetError("MAP_IMAGE_SELECTION_RANGE_INVALID", "选区必须包含有效的瓦片行列范围");
  }
  const width = safeAdd(endColumn - startColumn, 1, "MAP_IMAGE_SELECTION_RANGE_INVALID");
  const height = safeAdd(endRow - startRow, 1, "MAP_IMAGE_SELECTION_RANGE_INVALID");
  return { x: startColumn, y: startRow, width, height };
}

function validateSelectionRange(document, layer, tile) {
  let bounds = null;
  if (layer.type === "tilelayer" && !Array.isArray(layer.chunks)) {
    bounds = {
      x: integer(layer.startx, 0),
      y: integer(layer.starty, 0),
      width: integer(layer.width, 0),
      height: integer(layer.height, 0),
    };
  } else if (document.infinite !== true && layer.type !== "tilelayer") {
    bounds = { x: 0, y: 0, width: integer(document.width, 0), height: integer(document.height, 0) };
  }
  if (!bounds || bounds.width < 1 || bounds.height < 1) return;
  if (
    tile.x < bounds.x
    || tile.y < bounds.y
    || tile.x + tile.width > bounds.x + bounds.width
    || tile.y + tile.height > bounds.y + bounds.height
  ) {
    throw targetError("MAP_IMAGE_SELECTION_OUT_OF_RANGE", "选区超出当前图层可用范围", { bounds });
  }
}

function layerPixelOffset(entry) {
  let x = 0;
  let y = 0;
  for (const layer of [...entry.ancestors, entry.layer]) {
    x += finite(layer.offsetx, 0);
    y += finite(layer.offsety, 0);
    if (["group", "imagelayer", "objectgroup"].includes(layer.type)) {
      x += finite(layer.x, 0);
      y += finite(layer.y, 0);
    }
  }
  return { x, y };
}

function projectedTileRect(document, tile, offset) {
  const projected = tiledTileRegionBounds(document, tile.x, tile.y, tile.width, tile.height);
  return outerPixelRect({
    x: projected.x + offset.x,
    y: projected.y + offset.y,
    width: projected.width,
    height: projected.height,
  });
}

function validateSuppliedWorld(selection, expected) {
  const supplied = selection?.world || (
    [selection?.startColumn, selection?.endColumn, selection?.startRow, selection?.endRow].every(Number.isSafeInteger)
      && [selection?.x, selection?.y, selection?.width, selection?.height].every(Number.isFinite)
      ? selection
      : null
  );
  if (!supplied) return;
  const normalized = outerPixelRect(supplied);
  if (["x", "y", "width", "height"].some((key) => normalized[key] !== expected[key])) {
    throw targetError(
      "MAP_IMAGE_SELECTION_COORDINATE_MISMATCH",
      "选区的瓦片坐标与世界坐标不一致，请重新选择区域",
      { expectedWorld: expected, suppliedWorld: normalized },
    );
  }
}

function normalizeExpansion(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const unit = enumValue(source.unit || "tile", EXPANSION_UNITS, "MAP_IMAGE_SELECTION_EXPANSION_INVALID", "扩图单位无效");
  const nested = source[unit] && typeof source[unit] === "object" ? source[unit] : source;
  const sides = Object.fromEntries(["top", "right", "bottom", "left"].map((side) => {
    const amount = nested[side] == null ? 0 : Number(nested[side]);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw targetError("MAP_IMAGE_SELECTION_EXPANSION_INVALID", `扩图 ${side} 必须是非负整数`);
    }
    return [side, amount];
  }));
  return { unit, sides };
}

function expandRect(rect, sides) {
  const x = safeAdd(rect.x, -sides.left, "MAP_IMAGE_SELECTION_SIZE_INVALID");
  const y = safeAdd(rect.y, -sides.top, "MAP_IMAGE_SELECTION_SIZE_INVALID");
  const width = safeAdd(safeAdd(rect.width, sides.left, "MAP_IMAGE_SELECTION_SIZE_INVALID"), sides.right, "MAP_IMAGE_SELECTION_SIZE_INVALID");
  const height = safeAdd(safeAdd(rect.height, sides.top, "MAP_IMAGE_SELECTION_SIZE_INVALID"), sides.bottom, "MAP_IMAGE_SELECTION_SIZE_INVALID");
  return { x, y, width, height };
}

function rectExpansion(source, target) {
  const sides = {
    top: source.y - target.y,
    right: target.x + target.width - source.x - source.width,
    bottom: target.y + target.height - source.y - source.height,
    left: source.x - target.x,
  };
  if (Object.values(sides).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw targetError("MAP_IMAGE_SELECTION_SIZE_INVALID", "无法把瓦片扩图范围转换为有效的世界画布");
  }
  return sides;
}

function tileRect(space, rect) {
  return {
    space,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    startColumn: rect.x,
    endColumn: rect.x + rect.width - 1,
    startRow: rect.y,
    endRow: rect.y + rect.height - 1,
  };
}

function outerPixelRect(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw targetError("MAP_IMAGE_SELECTION_WORLD_INVALID", "选区世界坐标无效");
  }
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.ceil(x + width);
  const bottom = Math.ceil(y + height);
  if (![left, top, right, bottom].every(Number.isSafeInteger) || right <= left || bottom <= top) {
    throw targetError("MAP_IMAGE_SELECTION_WORLD_INVALID", "选区世界坐标超出安全范围");
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeLimits(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw targetError("MAP_IMAGE_SELECTION_LIMITS_INVALID", "地图图片选区限制无效");
  }
  const normalized = {};
  for (const key of ["maxTileWidth", "maxTileHeight", "maxWorldWidth", "maxWorldHeight", "maxWorldPixels"]) {
    if (value[key] == null) continue;
    const limit = Number(value[key]);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw targetError("MAP_IMAGE_SELECTION_LIMITS_INVALID", `${key} 必须是正整数`);
    }
    normalized[key] = limit;
  }
  return normalized;
}

function validateTileSize(rect, limits, label) {
  if (!Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height) || rect.width < 1 || rect.height < 1) {
    throw targetError("MAP_IMAGE_SELECTION_SIZE_INVALID", `${label}瓦片尺寸无效`);
  }
  if ((limits?.maxTileWidth && rect.width > limits.maxTileWidth) || (limits?.maxTileHeight && rect.height > limits.maxTileHeight)) {
    throw targetError("MAP_IMAGE_SELECTION_SIZE_LIMIT", `${label}超过管理员设置的瓦片尺寸上限`);
  }
}

function validateWorldSize(rect, limits, label) {
  if (!Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height) || rect.width < 1 || rect.height < 1) {
    throw targetError("MAP_IMAGE_SELECTION_SIZE_INVALID", `${label}画布尺寸无效`);
  }
  if ((limits?.maxWorldWidth && rect.width > limits.maxWorldWidth) || (limits?.maxWorldHeight && rect.height > limits.maxWorldHeight)) {
    throw targetError("MAP_IMAGE_SELECTION_SIZE_LIMIT", `${label}超过管理员设置的画布边长上限`);
  }
  if (limits?.maxWorldPixels && rect.width > Math.floor(limits.maxWorldPixels / rect.height)) {
    throw targetError("MAP_IMAGE_SELECTION_SIZE_LIMIT", `${label}超过管理员设置的画布像素上限`);
  }
}

function normalizeVersion(value) {
  const version = String(value || "");
  if (!/^[a-f0-9]{64}$/u.test(version)) {
    throw targetError("MAP_IMAGE_SELECTION_VERSION_INVALID", "地图版本无效");
  }
  return version;
}

function normalizeEditorStateId(value) {
  if (value == null) return null;
  const stateId = Number(value);
  if (!Number.isSafeInteger(stateId) || stateId < 0) {
    throw targetError("MAP_IMAGE_SELECTION_VERSION_INVALID", "地图编辑状态版本无效");
  }
  return stateId;
}

function enumValue(value, allowed, code, message) {
  const normalized = String(value || "");
  if (!allowed.has(normalized)) throw targetError(code, message);
  return normalized;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeAdd(left, right, code) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw targetError(code, "地图选区数值超出安全范围");
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function targetError(code, message, details = {}) {
  return new MapSelectionImageTargetError(code, message, details);
}
