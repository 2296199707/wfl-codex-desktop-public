import { tiledAlignmentOffset } from "./tiled-render-model.js?v=0.44.61-beta";

export const TILED_OBJECT_SHAPES = Object.freeze([
  "rectangle",
  "point",
  "ellipse",
  "capsule",
  "polygon",
  "polyline",
  "tile",
  "text",
]);

export const TILED_COLLISION_SHAPES = Object.freeze([
  "rectangle",
  "ellipse",
  "capsule",
  "polygon",
  "polyline",
]);

const SHAPE_NAMES = Object.freeze({
  rectangle: "Rectangle",
  point: "Point",
  ellipse: "Ellipse",
  capsule: "Capsule",
  polygon: "Polygon",
  polyline: "Polyline",
  tile: "Tile",
  text: "Text",
});

const SHAPE_LABELS = Object.freeze({
  rectangle: "矩形",
  point: "点",
  ellipse: "椭圆",
  capsule: "胶囊",
  polygon: "多边形",
  polyline: "折线",
  tile: "瓦片对象",
  text: "文字对象",
});

const TILE_ALIGNMENTS = new Set([
  "topleft", "top", "topright",
  "left", "center", "right",
  "bottomleft", "bottom", "bottomright",
]);

export function createTiledMapObject({
  shape = "rectangle",
  semantic = "object",
  rect,
  gid = null,
  tileAlignment = "bottomleft",
} = {}) {
  const normalizedShape = objectShape(shape);
  const normalizedSemantic = objectSemantic(semantic);
  const bounds = objectRect(rect);
  const effectiveShape = normalizedSemantic === "spawn" ? "point" : normalizedShape;
  if (normalizedSemantic === "collision" && !TILED_COLLISION_SHAPES.includes(effectiveShape)) {
    throw objectError("invalid-collision-shape", "碰撞对象只支持矩形、椭圆、胶囊、多边形或折线");
  }

  const object = {
    height: bounds.height,
    name: SHAPE_NAMES[effectiveShape],
    rotation: 0,
    visible: true,
    width: bounds.width,
    x: bounds.x,
    y: bounds.y,
  };
  applyShape(object, effectiveShape, bounds, { gid, tileAlignment });
  applySemantic(object, normalizedSemantic);
  return object;
}

export function tiledObjectShape(object) {
  if (object?.gid) return "tile";
  if (object?.text && typeof object.text === "object") return "text";
  if (Array.isArray(object?.polygon)) return "polygon";
  if (Array.isArray(object?.polyline)) return "polyline";
  if (object?.ellipse === true) return "ellipse";
  if (object?.capsule === true) return "capsule";
  if (object?.point === true) return "point";
  return "rectangle";
}

export function tiledObjectShapeLabel(object) {
  return SHAPE_LABELS[tiledObjectShape(object)];
}

export function tiledObjectSemantic(object) {
  const marker = `${object?.class || ""} ${object?.type || ""}`.trim().toLowerCase();
  const tokens = marker.split(/[^a-z0-9]+/u).filter(Boolean);
  if (tokens.some((token) => token === "spawn" || token === "spawnpoint")) return "spawn";
  if (tokens.includes("portal")) return "portal";
  if (tokens.some((token) => ["collision", "solid", "wall"].includes(token))) return "collision";
  return "object";
}

export function tiledObjectPropertyValue(object, names) {
  const expected = new Set((Array.isArray(names) ? names : [names]).map((name) => String(name).toLowerCase()));
  const property = (Array.isArray(object?.properties) ? object.properties : []).find((entry) => (
    expected.has(String(entry?.name || "").toLowerCase())
  ));
  return property?.value;
}

export function tiledPortalReference(object) {
  if (tiledObjectSemantic(object) !== "portal") return null;
  return {
    targetMap: String(tiledObjectPropertyValue(object, ["targetMap", "destination"]) || ""),
    targetSpawn: String(tiledObjectPropertyValue(object, ["targetSpawn", "destinationSpawn"]) || ""),
  };
}

export function tiledSpawnIdentifier(object) {
  if (tiledObjectSemantic(object) !== "spawn") return "";
  return String(tiledObjectPropertyValue(object, "spawnId") || object?.name || "");
}

export function planTiledObjectArrangement(records, action) {
  const entries = (Array.isArray(records) ? records : []).map((record) => arrangementRecord(record));
  const minimum = String(action).startsWith("distribute-") ? 3 : 2;
  if (entries.length < minimum) {
    throw objectError("object-arrangement-count", `该排列操作至少需要 ${minimum} 个对象`);
  }
  const changes = new Map(entries.map((entry) => [entry.id, { id: entry.id, x: entry.x, y: entry.y }]));
  const left = Math.min(...entries.map((entry) => entry.bounds.x));
  const right = Math.max(...entries.map((entry) => entry.bounds.x + entry.bounds.width));
  const top = Math.min(...entries.map((entry) => entry.bounds.y));
  const bottom = Math.max(...entries.map((entry) => entry.bounds.y + entry.bounds.height));

  if (["left", "center-x", "right"].includes(action)) {
    const target = action === "left" ? left : action === "right" ? right : (left + right) / 2;
    for (const entry of entries) {
      const current = action === "left"
        ? entry.bounds.x
        : action === "right"
          ? entry.bounds.x + entry.bounds.width
          : entry.bounds.x + entry.bounds.width / 2;
      changes.get(entry.id).x += target - current;
    }
  } else if (["top", "center-y", "bottom"].includes(action)) {
    const target = action === "top" ? top : action === "bottom" ? bottom : (top + bottom) / 2;
    for (const entry of entries) {
      const current = action === "top"
        ? entry.bounds.y
        : action === "bottom"
          ? entry.bounds.y + entry.bounds.height
          : entry.bounds.y + entry.bounds.height / 2;
      changes.get(entry.id).y += target - current;
    }
  } else if (action === "distribute-x") {
    const sorted = [...entries].sort((a, b) => a.bounds.x - b.bounds.x || a.id - b.id);
    const width = sorted.reduce((total, entry) => total + entry.bounds.width, 0);
    const gap = (right - left - width) / (sorted.length - 1);
    let position = left;
    for (const entry of sorted) {
      changes.get(entry.id).x += position - entry.bounds.x;
      position += entry.bounds.width + gap;
    }
  } else if (action === "distribute-y") {
    const sorted = [...entries].sort((a, b) => a.bounds.y - b.bounds.y || a.id - b.id);
    const height = sorted.reduce((total, entry) => total + entry.bounds.height, 0);
    const gap = (bottom - top - height) / (sorted.length - 1);
    let position = top;
    for (const entry of sorted) {
      changes.get(entry.id).y += position - entry.bounds.y;
      position += entry.bounds.height + gap;
    }
  } else {
    throw objectError("invalid-object-arrangement", `不支持的对象排列操作：${String(action || "")}`);
  }
  return entries.map((entry) => changes.get(entry.id));
}

export function updateTiledObjectVertex(object, index, point) {
  const { field, points } = objectVertexData(object);
  const vertexIndex = vertexArrayIndex(index, points.length, false);
  points[vertexIndex] = objectPoint(point);
  return { [field]: points };
}

export function insertTiledObjectVertex(object, index, point) {
  const { field, points } = objectVertexData(object);
  const vertexIndex = vertexArrayIndex(index, points.length, true);
  points.splice(vertexIndex, 0, objectPoint(point));
  return { [field]: points };
}

export function removeTiledObjectVertex(object, index) {
  const { field, points } = objectVertexData(object);
  const minimum = field === "polygon" ? 3 : 2;
  if (points.length <= minimum) {
    throw objectError("object-vertex-minimum", `${field === "polygon" ? "多边形" : "折线"}至少需要 ${minimum} 个顶点`);
  }
  points.splice(vertexArrayIndex(index, points.length, false), 1);
  return { [field]: points };
}

export function suggestedTiledObjectVertex(object) {
  const { field, points } = objectVertexData(object);
  const last = points.at(-1);
  if (field === "polygon") {
    const first = points[0];
    return {
      index: points.length,
      point: { x: (last.x + first.x) / 2, y: (last.y + first.y) / 2 },
    };
  }
  const previous = points.at(-2) || { x: last.x - 16, y: last.y };
  return {
    index: points.length,
    point: { x: last.x + (last.x - previous.x), y: last.y + (last.y - previous.y) },
  };
}

export function planTiledObjectResize(objects, sourceBounds, targetBounds) {
  const source = transformBounds(sourceBounds, "原对象选区");
  const target = transformBounds(targetBounds, "目标对象选区");
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    throw objectError("invalid-object-resize-bounds", "对象缩放选区的宽高必须大于 0");
  }
  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  return transformObjects(objects, (object) => {
    const changes = {
      x: target.x + (Number(object.x || 0) - source.x) * scaleX,
      y: target.y + (Number(object.y || 0) - source.y) * scaleY,
    };
    if (Number(object.width || 0) > 0) changes.width = Number(object.width) * scaleX;
    if (Number(object.height || 0) > 0) changes.height = Number(object.height) * scaleY;
    if (Array.isArray(object.polygon)) {
      changes.polygon = object.polygon.map((point) => ({ x: Number(point.x || 0) * scaleX, y: Number(point.y || 0) * scaleY }));
    }
    if (Array.isArray(object.polyline)) {
      changes.polyline = object.polyline.map((point) => ({ x: Number(point.x || 0) * scaleX, y: Number(point.y || 0) * scaleY }));
    }
    return changes;
  });
}

export function planTiledObjectRotation(objects, center, deltaDegrees) {
  const origin = objectPoint(center);
  const delta = Number(deltaDegrees);
  if (!Number.isFinite(delta)) throw objectError("invalid-object-rotation", "对象旋转角度无效");
  const radians = delta * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return transformObjects(objects, (object) => {
    const offsetX = Number(object.x || 0) - origin.x;
    const offsetY = Number(object.y || 0) - origin.y;
    return {
      x: origin.x + offsetX * cosine - offsetY * sine,
      y: origin.y + offsetX * sine + offsetY * cosine,
      rotation: Number(object.rotation || 0) + delta,
    };
  });
}

function applyShape(object, shape, bounds, { gid, tileAlignment }) {
  if (shape === "point") {
    object.width = 0;
    object.height = 0;
    object.point = true;
    return;
  }
  if (shape === "ellipse") {
    object.ellipse = true;
    return;
  }
  if (shape === "capsule") {
    object.capsule = true;
    return;
  }
  if (shape === "polygon") {
    object.width = 0;
    object.height = 0;
    object.polygon = rectanglePoints(bounds.width, bounds.height);
    return;
  }
  if (shape === "polyline") {
    object.width = 0;
    object.height = 0;
    object.polyline = [
      { x: 0, y: 0 },
      { x: bounds.width, y: bounds.height },
    ];
    return;
  }
  if (shape === "tile") {
    const encodedGid = Number(gid);
    if (!Number.isSafeInteger(encodedGid) || encodedGid <= 0 || encodedGid > 0xffffffff) {
      throw objectError("tile-gid-required", "请先在瓦片面板选择一个瓦片");
    }
    if (!TILE_ALIGNMENTS.has(tileAlignment)) {
      throw objectError("invalid-tile-alignment", "瓦片对象的对齐方式无效");
    }
    const offset = tiledAlignmentOffset(bounds.width, bounds.height, tileAlignment);
    object.gid = encodedGid >>> 0;
    object.x = bounds.x + offset.x;
    object.y = bounds.y + offset.y;
    return;
  }
  if (shape === "text") {
    object.text = {
      bold: false,
      color: "#ff000000",
      fontfamily: "sans-serif",
      halign: "left",
      italic: false,
      kerning: true,
      pixelsize: 16,
      strikeout: false,
      text: "Text",
      underline: false,
      valign: "top",
      wrap: true,
    };
  }
}

function applySemantic(object, semantic) {
  if (semantic === "spawn") {
    object.class = "SpawnPoint";
    object.name = "Spawn";
    object.type = "spawn";
    object.properties = [{ name: "spawnId", type: "string", value: "" }];
    return;
  }
  if (semantic === "portal") {
    object.class = "Portal";
    object.name = "Portal";
    object.type = "portal";
    object.properties = [
      { name: "targetMap", type: "string", value: "" },
      { name: "targetSpawn", type: "string", value: "" },
    ];
    return;
  }
  if (semantic === "collision") {
    object.class = "Collision";
    object.name = "Collision";
    object.type = "collision";
    return;
  }
  object.class = "Object";
  object.type = "";
}

function rectanglePoints(width, height) {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

function objectShape(value) {
  if (!TILED_OBJECT_SHAPES.includes(value)) {
    throw objectError("invalid-object-shape", `不支持的 Tiled 对象形状：${String(value || "")}`);
  }
  return value;
}

function objectSemantic(value) {
  if (!["object", "spawn", "portal", "collision"].includes(value)) {
    throw objectError("invalid-object-semantic", `不支持的对象用途：${String(value || "")}`);
  }
  return value;
}

function objectRect(value) {
  const rect = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (!Object.values(rect).every(Number.isFinite) || rect.width < 0 || rect.height < 0) {
    throw objectError("invalid-object-bounds", "对象边界必须是有效的非负数值");
  }
  return rect;
}

function arrangementRecord(value) {
  const id = Number(value?.id);
  const x = Number(value?.x);
  const y = Number(value?.y);
  const bounds = objectRect(value?.bounds);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw objectError("invalid-object-arrangement-record", "对象排列记录无效");
  }
  return { id, x, y, bounds };
}

function transformBounds(value, label) {
  try {
    return objectRect(value);
  } catch {
    throw objectError("invalid-object-transform-bounds", `${label}无效`);
  }
}

function transformObjects(values, planner) {
  if (!Array.isArray(values) || !values.length) {
    throw objectError("invalid-object-transform-selection", "对象变换需要至少一个对象");
  }
  return values.map((value) => {
    const id = Number(value?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw objectError("invalid-object-transform-record", "对象变换记录无效");
    return { id, changes: planner(value) };
  });
}

function objectVertexData(object) {
  const field = Array.isArray(object?.polygon) ? "polygon" : Array.isArray(object?.polyline) ? "polyline" : null;
  if (!field) throw objectError("object-has-no-vertices", "当前对象不是多边形或折线");
  const points = object[field].map((point) => objectPoint(point));
  const minimum = field === "polygon" ? 3 : 2;
  if (points.length < minimum) throw objectError("object-vertex-minimum", `${field} 顶点数量无效`);
  return { field, points };
}

function objectPoint(value) {
  const point = { x: Number(value?.x), y: Number(value?.y) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw objectError("invalid-object-vertex", "对象顶点坐标必须是有效数字");
  }
  return point;
}

function vertexArrayIndex(value, length, allowEnd) {
  const index = Number(value);
  const maximum = allowEnd ? length : length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw objectError("invalid-object-vertex-index", "对象顶点索引无效");
  }
  return index;
}

function objectError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
