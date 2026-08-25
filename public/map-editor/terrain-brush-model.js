import { decodeGlobalTileId } from "./tiled-render-model.js?v=0.44.55";

const TERRAIN_TYPES = new Set(["corner", "edge", "mixed"]);
const MAX_GID = 0x0fff_ffff;
const POSITION_LINKS = Object.freeze([
  [[0, 0, 0], [-1, 0, 2], [0, -1, 6], [-1, -1, 4]],
  [[0, 0, 1], [0, -1, 5]],
  [[0, 0, 2], [1, 0, 0], [0, -1, 4], [1, -1, 6]],
  [[0, 0, 3], [1, 0, 7]],
  [[0, 0, 4], [1, 0, 6], [0, 1, 2], [1, 1, 0]],
  [[0, 0, 5], [0, 1, 1]],
  [[0, 0, 6], [-1, 0, 4], [0, 1, 0], [-1, 1, 2]],
  [[0, 0, 7], [-1, 0, 3]],
]);

export class TerrainBrushError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TerrainBrushError";
    this.code = code;
  }
}

export function planTerrainBrush(input = {}) {
  const point = gridPoint(input.point);
  const color = nonNegativeInteger(input.color, "Terrain 颜色");
  const type = terrainType(input.type);
  const candidates = normalizeCandidates(input.candidates, type);
  const readGid = typeof input.readGid === "function" ? input.readGid : invalidReader;
  const wangIdForGid = typeof input.wangIdForGid === "function" ? input.wangIdForGid : () => null;
  const isCellEditable = typeof input.isCellEditable === "function" ? input.isCellEditable : () => true;
  const seed = normalizeSeed(input.seed ?? 0);
  const positions = type === "edge" ? [1, 3, 5, 7] : type === "corner" ? [0, 2, 4, 6] : [0, 1, 2, 3, 4, 5, 6, 7];
  const desiredByCell = new Map();

  const desiredCell = (x, y) => {
    if (!isCellEditable(x, y)) return null;
    const key = `${x},${y}`;
    let record = desiredByCell.get(key);
    if (!record) {
      const encodedGid = normalizedEncodedGid(readGid(x, y));
      const current = wangIdForGid(encodedGid);
      record = {
        x,
        y,
        currentGid: encodedGid,
        belongs: Array.isArray(current),
        wangid: Array.isArray(current) ? normalizeWangId(current, type, null) : Array(8).fill(0),
      };
      desiredByCell.set(key, record);
    }
    return record;
  };

  for (const position of positions) {
    for (const [dx, dy, linkedPosition] of POSITION_LINKS[position]) {
      const record = desiredCell(point.x + dx, point.y + dy);
      if (record) record.wangid[linkedPosition] = color;
    }
  }

  let approximate = 0;
  const writes = [];
  for (const record of desiredByCell.values()) {
    let gid = record.currentGid;
    let exact = true;
    if (record.wangid.every((value) => value === 0)) {
      if (record.belongs) gid = 0;
    } else {
      const selection = selectTerrainCandidate(candidates, record.wangid, seed, record.x, record.y);
      gid = selection.gid;
      exact = selection.exact;
      if (!exact) approximate += 1;
    }
    if ((gid >>> 0) !== (record.currentGid >>> 0)) {
      writes.push(Object.freeze({ x: record.x, y: record.y, gid: gid >>> 0, exact }));
    }
  }
  writes.sort((left, right) => left.y - right.y || left.x - right.x);
  return Object.freeze({
    writes: Object.freeze(writes),
    affected: desiredByCell.size,
    approximate,
    seed,
  });
}

function normalizeCandidates(value, type) {
  if (!Array.isArray(value) || !value.length) throw terrainError("terrain-candidates-empty", "当前 Terrain Set 没有可绘制的 wangtile");
  const candidates = value.map((candidate, index) => {
    const gid = baseGid(candidate?.gid, `wangtile ${index + 1} GID`);
    const wangid = normalizeWangId(candidate?.wangid, type);
    const probability = candidate?.probability === undefined ? 1 : nonNegativeNumber(candidate.probability, `wangtile ${index + 1} probability`);
    return Object.freeze({ gid, wangid, probability });
  });
  if (!candidates.some(({ probability }) => probability > 0)) {
    throw terrainError("terrain-probability-empty", "当前 Terrain Set 的全部候选 probability 都是 0");
  }
  return candidates;
}

function selectTerrainCandidate(candidates, desired, seed, x, y) {
  let bestScore = Number.POSITIVE_INFINITY;
  let best = [];
  for (const candidate of candidates) {
    if (candidate.probability <= 0) continue;
    const score = wangDistance(candidate.wangid, desired);
    if (score < bestScore) {
      bestScore = score;
      best = [candidate];
    } else if (score === bestScore) best.push(candidate);
  }
  if (!best.length) throw terrainError("terrain-candidates-empty", "当前 Terrain Set 没有 probability 大于 0 的候选");
  const total = best.reduce((sum, candidate) => sum + candidate.probability, 0);
  let target = coordinateRandom(seed, x, y) * total;
  for (const candidate of best) {
    target -= candidate.probability;
    if (target < 0) return { gid: candidate.gid, exact: bestScore === 0 };
  }
  return { gid: best.at(-1).gid, exact: bestScore === 0 };
}

function wangDistance(candidate, desired) {
  let score = 0;
  for (let index = 0; index < 8; index += 1) {
    if (candidate[index] === desired[index]) continue;
    if (candidate[index] && desired[index] && candidate[index] !== desired[index]) score += 100;
    else if (!candidate[index] && desired[index]) score += 20;
    else score += 5;
  }
  return score;
}

function normalizeWangId(value, type) {
  if (!Array.isArray(value) || value.length !== 8) throw terrainError("invalid-wangid", "wangid 必须包含 8 个边角值");
  const result = value.map((entry, index) => {
    const color = nonNegativeInteger(entry, `wangid[${index}]`);
    return color;
  });
  if (type === "edge" && result.some((color, index) => index % 2 === 0 && color)) {
    throw terrainError("terrain-type-conflict", "Edge Terrain 的角位置必须为空");
  }
  if (type === "corner" && result.some((color, index) => index % 2 === 1 && color)) {
    throw terrainError("terrain-type-conflict", "Corner Terrain 的边位置必须为空");
  }
  return result;
}

function terrainType(value) {
  const type = String(value || "mixed");
  if (!TERRAIN_TYPES.has(type)) throw terrainError("invalid-terrain-type", `不支持的 Terrain 类型：${type}`);
  return type;
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

function normalizeSeed(value) {
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw terrainError("invalid-terrain-seed", "Terrain seed 必须是 0 到 4294967295 的整数");
  return seed >>> 0;
}

function normalizedEncodedGid(value) {
  if (value === null || value === undefined) return 0;
  const gid = Number(value);
  if (!Number.isSafeInteger(gid) || gid < 0 || gid > 0xffff_ffff) throw terrainError("invalid-tile-gid", "地图瓦片 GID 无效");
  return gid >>> 0;
}

function baseGid(value, label) {
  const gid = decodeGlobalTileId(normalizedEncodedGid(value)).gid;
  if (gid <= 0 || gid > MAX_GID) throw terrainError("invalid-terrain-gid", `${label}无效`);
  return gid;
}

function gridPoint(value) {
  if (!value || typeof value !== "object") throw terrainError("invalid-terrain-point", "Terrain 画笔坐标无效");
  return { x: integer(value.x, "Terrain X"), y: integer(value.y, "Terrain Y") };
}

function nonNegativeInteger(value, label) {
  const number = integer(value, label);
  if (number < 0) throw terrainError("invalid-terrain-value", `${label}不能为负数`);
  return number;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw terrainError("invalid-terrain-value", `${label}必须是整数`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw terrainError("invalid-terrain-value", `${label}必须是非负数`);
  return number;
}

function invalidReader() {
  throw terrainError("terrain-reader-required", "Terrain Brush 缺少地图读取器");
}

function terrainError(code, message) {
  return new TerrainBrushError(code, message);
}
