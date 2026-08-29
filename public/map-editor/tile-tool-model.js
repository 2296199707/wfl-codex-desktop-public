import {
  TILED_FLIP_FLAGS,
  decodeGlobalTileId,
} from "./tiled-render-model.js?v=0.44.64";

const TILE_SHAPES = new Set(["line", "rectangle", "ellipse"]);
const TILE_STAMP_TRANSFORMS = new Set([
  "flip-horizontal",
  "flip-vertical",
  "flip-diagonal",
  "rotate-clockwise",
  "rotate-counterclockwise",
]);
const MAX_ENCODED_GID = 0xffff_ffff;
const STANDARD_TRANSFORM_FLAGS = Object.freeze([
  0,
  TILED_FLIP_FLAGS.horizontal,
  TILED_FLIP_FLAGS.vertical,
  (TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.vertical) >>> 0,
  TILED_FLIP_FLAGS.diagonal,
  (TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0,
  (TILED_FLIP_FLAGS.vertical | TILED_FLIP_FLAGS.diagonal) >>> 0,
  (TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.vertical | TILED_FLIP_FLAGS.diagonal) >>> 0,
]);
const HEX_TRANSFORM_FLAGS = Object.freeze(Array.from({ length: 16 }, (_, index) => (
  (index & 1 ? TILED_FLIP_FLAGS.horizontal : 0)
  | (index & 2 ? TILED_FLIP_FLAGS.vertical : 0)
  | (index & 4 ? TILED_FLIP_FLAGS.diagonal : 0)
  | (index & 8 ? TILED_FLIP_FLAGS.rotatedHex120 : 0)
) >>> 0).sort((left, right) => bitCount(left) - bitCount(right) || left - right));

export function singleTileStamp(encodedGid) {
  const gid = normalizedGid(encodedGid);
  return Object.freeze({
    width: 1,
    height: 1,
    cells: Object.freeze([Object.freeze({ x: 0, y: 0, gid })]),
  });
}

export function paletteTileStamp(anchor, target = anchor) {
  const first = paletteEntry(anchor, "起始瓦片");
  const last = paletteEntry(target, "结束瓦片");
  if (first.tilesetKey !== last.tilesetKey) {
    throw tileToolError("stamp-cross-tileset", "多格 Stamp 必须位于同一个瓦片集中");
  }
  if (first.layoutKind !== "atlas" || last.layoutKind !== "atlas") {
    if (first.localId === last.localId) return singleTileStamp(first.gid);
    throw tileToolError("stamp-collection-grid", "图片集合瓦片集没有固定网格，不能框选多格 Stamp");
  }
  if (first.columns !== last.columns || first.firstgid !== last.firstgid || first.tileCount !== last.tileCount) {
    throw tileToolError("stamp-layout-mismatch", "瓦片集布局已变化，请重新选择 Stamp");
  }
  const firstColumn = first.localId % first.columns;
  const firstRow = Math.floor(first.localId / first.columns);
  const lastColumn = last.localId % last.columns;
  const lastRow = Math.floor(last.localId / last.columns);
  const left = Math.min(firstColumn, lastColumn);
  const right = Math.max(firstColumn, lastColumn);
  const top = Math.min(firstRow, lastRow);
  const bottom = Math.max(firstRow, lastRow);
  const cells = [];
  for (let row = top; row <= bottom; row += 1) {
    for (let column = left; column <= right; column += 1) {
      const localId = row * first.columns + column;
      cells.push({
        x: column - left,
        y: row - top,
        gid: localId < first.tileCount ? first.firstgid + localId : 0,
      });
    }
  }
  return frozenStamp(right - left + 1, bottom - top + 1, cells);
}

export function tileShapeCells(kind, start, end, options = {}) {
  const shape = String(kind || "").replace(/^tile-/u, "");
  if (!TILE_SHAPES.has(shape)) throw tileToolError("invalid-tile-shape", `不支持的瓦片形状：${shape || "空"}`);
  const first = gridPoint(start, "起点");
  const last = gridPoint(end, "终点");
  if (shape === "line") return frozenPoints(gridLine(first, last));
  const left = Math.min(first.x, last.x);
  const right = Math.max(first.x, last.x);
  const top = Math.min(first.y, last.y);
  const bottom = Math.max(first.y, last.y);
  const filled = options.filled === true;
  const cells = [];
  if (shape === "rectangle") {
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (filled || x === left || x === right || y === top || y === bottom) cells.push({ x, y });
      }
    }
    return frozenPoints(cells);
  }

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = Math.max(0.5, (right - left + 1) / 2);
  const radiusY = Math.max(0.5, (bottom - top + 1) / 2);
  const inside = (x, y) => (
    ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2 <= 1
  );
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (!inside(x, y)) continue;
      if (filled || [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(([neighborX, neighborY]) => !inside(neighborX, neighborY))) cells.push({ x, y });
    }
  }
  return frozenPoints(cells.length ? cells : [{ x: first.x, y: first.y }]);
}

export function tileStampWrites(stamp, anchors, options = {}) {
  const normalized = normalizeTileStamp(stamp);
  if (!Array.isArray(anchors)) throw new TypeError("anchors must be an array");
  const writes = new Map();
  for (const anchor of anchors) {
    const point = gridPoint(anchor, "Stamp 位置");
    const cells = options.random === true
      ? [randomStampCell(normalized, point, options)]
      : normalized.cells;
    for (const cell of cells) {
      const write = {
        x: point.x + (options.random === true ? 0 : cell.x),
        y: point.y + (options.random === true ? 0 : cell.y),
        gid: options.erase === true ? 0 : cell.gid,
      };
      writes.set(`${write.x},${write.y}`, write);
    }
  }
  return frozenWrites([...writes.values()]);
}

export function transformTileStamp(stamp, operation, options = {}) {
  const normalized = normalizeTileStamp(stamp);
  const transform = String(operation || "");
  if (!TILE_STAMP_TRANSFORMS.has(transform)) {
    throw tileToolError("invalid-stamp-transform", `不支持的 Stamp 变换：${transform || "空"}`);
  }
  const hexagonal = options.hexagonal === true;
  if (hexagonal && !["flip-horizontal", "flip-vertical"].includes(transform)) {
    throw tileToolError("hex-stamp-transform-unsupported", "六边形地图的 Stamp 当前只支持水平和垂直翻转");
  }
  const swapsAxes = ["flip-diagonal", "rotate-clockwise", "rotate-counterclockwise"].includes(transform);
  const width = swapsAxes ? normalized.height : normalized.width;
  const height = swapsAxes ? normalized.width : normalized.height;
  const cells = normalized.cells.map((cell) => {
    const point = transformedStampPoint(cell, normalized, transform);
    return {
      ...point,
      gid: transformTileGid(cell.gid, transform, { hexagonal }),
    };
  }).sort((left, right) => left.y - right.y || left.x - right.x);
  return frozenStamp(width, height, cells);
}

export function normalizeTileRandomSeed(value) {
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_ENCODED_GID) {
    throw tileToolError("invalid-random-seed", "随机 Seed 必须是 0 到 4294967295 的整数");
  }
  return seed >>> 0;
}

export function normalizeTileStamp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tile stamp must be an object");
  }
  const width = positiveInteger(value.width, "Stamp 宽度");
  const height = positiveInteger(value.height, "Stamp 高度");
  if (!Array.isArray(value.cells) || value.cells.length !== width * height) {
    throw tileToolError("invalid-tile-stamp", "Stamp 必须包含完整的矩形瓦片数据");
  }
  const positions = new Set();
  const cells = value.cells.map((cell) => {
    const point = gridPoint(cell, "Stamp 单元");
    if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
      throw tileToolError("invalid-tile-stamp", "Stamp 单元超出矩形范围");
    }
    const key = `${point.x},${point.y}`;
    if (positions.has(key)) throw tileToolError("invalid-tile-stamp", "Stamp 包含重复单元");
    positions.add(key);
    return { ...point, gid: normalizedGid(cell.gid) };
  });
  return frozenStamp(width, height, cells);
}

function paletteEntry(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw tileToolError("invalid-palette-entry", `${label}无效`);
  }
  const layoutKind = value.layoutKind === "atlas" ? "atlas" : value.layoutKind === "collection" ? "collection" : "";
  const entry = {
    gid: normalizedGid(value.gid),
    localId: nonNegativeInteger(value.localId, `${label}本地 ID`),
    firstgid: positiveInteger(value.firstgid, `${label} firstgid`),
    tileCount: nonNegativeInteger(value.tileCount, `${label} tileCount`),
    columns: nonNegativeInteger(value.columns, `${label} columns`),
    layoutKind,
    tilesetKey: String(value.tilesetKey || ""),
  };
  if (!entry.tilesetKey || !entry.layoutKind || entry.gid !== entry.firstgid + entry.localId) {
    throw tileToolError("invalid-palette-entry", `${label}与瓦片集布局不一致`);
  }
  if (entry.layoutKind === "atlas" && (!entry.columns || entry.localId >= entry.tileCount)) {
    throw tileToolError("invalid-palette-entry", `${label}超出图集范围`);
  }
  return entry;
}

function gridLine(start, end) {
  const cells = [];
  let x = start.x;
  let y = start.y;
  const deltaX = Math.abs(end.x - x);
  const stepX = x < end.x ? 1 : -1;
  const deltaY = -Math.abs(end.y - y);
  const stepY = y < end.y ? 1 : -1;
  let error = deltaX + deltaY;
  while (true) {
    cells.push({ x, y });
    if (x === end.x && y === end.y) break;
    const doubled = error * 2;
    if (doubled >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubled <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
  return cells;
}

function transformedStampPoint(cell, stamp, operation) {
  if (operation === "flip-horizontal") return { x: stamp.width - 1 - cell.x, y: cell.y };
  if (operation === "flip-vertical") return { x: cell.x, y: stamp.height - 1 - cell.y };
  if (operation === "flip-diagonal") return { x: cell.y, y: cell.x };
  if (operation === "rotate-clockwise") return { x: stamp.height - 1 - cell.y, y: cell.x };
  return { x: cell.y, y: stamp.width - 1 - cell.x };
}

function transformTileGid(encodedGid, operation, options) {
  const decoded = decodeGlobalTileId(encodedGid);
  if (!decoded.gid) return 0;
  const outer = operationMatrix(operation);
  if (options.hexagonal) {
    return encodeTransformedGid(decoded.gid, multiplyMatrices(outer, hexTransformMatrix(decoded)), {
      candidates: HEX_TRANSFORM_FLAGS,
      hexagonal: true,
    });
  }
  const transformed = encodeTransformedGid(
    decoded.gid,
    multiplyMatrices(outer, standardTransformMatrix(decoded)),
    { candidates: STANDARD_TRANSFORM_FLAGS, hexagonal: false },
  );
  return (transformed | (decoded.rotatedHex120 ? TILED_FLIP_FLAGS.rotatedHex120 : 0)) >>> 0;
}

function encodeTransformedGid(baseGid, target, options) {
  for (const flags of options.candidates) {
    const decoded = decodeGlobalTileId((baseGid | flags) >>> 0);
    const candidate = options.hexagonal ? hexTransformMatrix(decoded) : standardTransformMatrix(decoded);
    if (sameMatrix(candidate, target)) return (baseGid | flags) >>> 0;
  }
  throw tileToolError("stamp-transform-unrepresentable", "Stamp 变换无法编码为 Tiled GID 标志");
}

function operationMatrix(operation) {
  if (operation === "flip-horizontal") return [-1, 0, 0, 1];
  if (operation === "flip-vertical") return [1, 0, 0, -1];
  if (operation === "flip-diagonal") return [0, 1, 1, 0];
  if (operation === "rotate-clockwise") return [0, -1, 1, 0];
  return [0, 1, -1, 0];
}

function standardTransformMatrix(decoded) {
  if (!decoded.diagonal) {
    return [decoded.horizontal ? -1 : 1, 0, 0, decoded.vertical ? -1 : 1];
  }
  if (decoded.horizontal && decoded.vertical) return [0, -1, -1, 0];
  if (decoded.horizontal) return [0, -1, 1, 0];
  if (decoded.vertical) return [0, 1, -1, 0];
  return [0, 1, 1, 0];
}

function hexTransformMatrix(decoded) {
  const angle = (decoded.diagonal ? Math.PI / 3 : 0) + (decoded.rotatedHex120 ? Math.PI * 2 / 3 : 0);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const scaleX = decoded.horizontal ? -1 : 1;
  const scaleY = decoded.vertical ? -1 : 1;
  return [cosine * scaleX, -sine * scaleY, sine * scaleX, cosine * scaleY];
}

function multiplyMatrices(left, right) {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
  ];
}

function sameMatrix(left, right) {
  return left.every((value, index) => Math.abs(value - right[index]) < 1e-9);
}

function randomStampCell(stamp, point, options) {
  const candidates = stamp.cells.filter((cell) => decodeGlobalTileId(cell.gid).gid > 0).map((cell) => ({
    cell,
    weight: tileRandomWeight(options.weights, cell.gid),
  })).filter(({ weight }) => weight > 0);
  if (!candidates.length) {
    throw tileToolError("random-stamp-empty", "随机 Stamp 至少需要一个 probability 大于 0 的非空瓦片");
  }
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let target = coordinateRandom(normalizeTileRandomSeed(options.seed ?? 0), point.x, point.y) * total;
  for (const candidate of candidates) {
    target -= candidate.weight;
    if (target < 0) return candidate.cell;
  }
  return candidates.at(-1).cell;
}

function tileRandomWeight(weights, encodedGid) {
  const baseGid = decodeGlobalTileId(encodedGid).gid;
  let value;
  if (typeof weights === "function") value = weights(baseGid, encodedGid);
  else if (weights instanceof Map) value = weights.get(baseGid);
  else if (weights && typeof weights === "object") value = weights[baseGid];
  if (value === undefined) return 1;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0) {
    throw tileToolError("invalid-tile-probability", `GID ${baseGid} 的 probability 必须是非负数`);
  }
  return weight;
}

function coordinateRandom(seed, x, y) {
  let value = seed >>> 0;
  value ^= Math.imul(x | 0, 0x9e3779b1);
  value ^= Math.imul(y | 0, 0x85ebca77);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function bitCount(value) {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function frozenStamp(width, height, cells) {
  return Object.freeze({
    width,
    height,
    cells: Object.freeze(cells.map((cell) => Object.freeze({ ...cell }))),
  });
}

function frozenPoints(points) {
  return Object.freeze(points.map((point) => Object.freeze({ ...point })));
}

function frozenWrites(writes) {
  return Object.freeze(writes.map((write) => Object.freeze({ ...write })));
}

function gridPoint(value, label) {
  if (!value || typeof value !== "object") throw tileToolError("invalid-grid-point", `${label}无效`);
  return {
    x: integer(value.x, `${label} X`),
    y: integer(value.y, `${label} Y`),
  };
}

function normalizedGid(value) {
  const gid = Number(value);
  if (!Number.isSafeInteger(gid) || gid < 0 || gid > MAX_ENCODED_GID) {
    throw tileToolError("invalid-tile-gid", "瓦片 GID 必须是 0 到 4294967295 的整数");
  }
  return gid >>> 0;
}

function positiveInteger(value, label) {
  const number = integer(value, label);
  if (number <= 0) throw tileToolError("invalid-tile-tool-value", `${label}必须是正整数`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = integer(value, label);
  if (number < 0) throw tileToolError("invalid-tile-tool-value", `${label}不能为负数`);
  return number;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw tileToolError("invalid-tile-tool-value", `${label}必须是整数`);
  return number;
}

function tileToolError(code, message) {
  return Object.assign(new Error(message), { code });
}
