import { decodeGlobalTileId } from "./tiled-render-model.js?v=0.44.63-beta";

const SELECTION_MODES = new Set(["replace", "add", "subtract", "intersect"]);

export function rectangularTileSelection(start, end) {
  const first = tilePoint(start, "selection start");
  const last = tilePoint(end, "selection end");
  const left = Math.min(first.x, last.x);
  const right = Math.max(first.x, last.x);
  const top = Math.min(first.y, last.y);
  const bottom = Math.max(first.y, last.y);
  const cells = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) cells.push({ x, y });
  }
  return frozenCells(cells);
}

export function contiguousTileSelection(start, readTile, options = {}) {
  const first = tilePoint(start, "selection start");
  if (typeof readTile !== "function") throw new TypeError("readTile must be a function");
  const initial = normalizedRead(readTile(first.x, first.y));
  if (!initial.exists) return frozenCells([]);
  const baseOnly = options.baseGidOnly !== false;
  const matches = (value) => (
    baseOnly
      ? decodeGlobalTileId(value).gid === decodeGlobalTileId(initial.gid).gid
      : value === initial.gid
  );
  const pending = [first];
  const visited = new Set();
  const cells = [];
  while (pending.length) {
    const point = pending.pop();
    const key = tileKey(point);
    if (visited.has(key)) continue;
    visited.add(key);
    const current = normalizedRead(readTile(point.x, point.y));
    if (!current.exists || !matches(current.gid)) continue;
    cells.push(point);
    pending.push(
      { x: point.x - 1, y: point.y },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 },
      { x: point.x, y: point.y + 1 },
    );
  }
  return frozenCells(cells);
}

export function matchingTileSelection(entries, encodedGid, options = {}) {
  if (!entries || typeof entries[Symbol.iterator] !== "function") throw new TypeError("entries must be iterable");
  const target = normalizedGid(encodedGid);
  const baseOnly = options.baseGidOnly !== false;
  const targetValue = baseOnly ? decodeGlobalTileId(target).gid : target;
  const cells = [];
  for (const entry of entries) {
    const point = tilePoint(entry, "tile entry");
    const gid = normalizedGid(entry.gid);
    const value = baseOnly ? decodeGlobalTileId(gid).gid : gid;
    if (value === targetValue) cells.push(point);
  }
  return frozenCells(cells);
}

export function combineTileSelections(current, incoming, mode = "replace") {
  const operation = String(mode || "replace");
  if (!SELECTION_MODES.has(operation)) throw new TypeError(`Unsupported tile selection mode: ${operation}`);
  const before = cellMap(current);
  const next = cellMap(incoming);
  if (operation === "replace") return frozenCells(next.values());
  if (operation === "add") {
    for (const [key, point] of next) before.set(key, point);
    return frozenCells(before.values());
  }
  if (operation === "subtract") {
    for (const key of next.keys()) before.delete(key);
    return frozenCells(before.values());
  }
  return frozenCells([...before].filter(([key]) => next.has(key)).map(([, point]) => point));
}

export function tileSelectionBounds(cells) {
  const normalized = normalizeTileSelection(cells);
  if (!normalized.length) return null;
  const left = Math.min(...normalized.map(({ x }) => x));
  const right = Math.max(...normalized.map(({ x }) => x));
  const top = Math.min(...normalized.map(({ y }) => y));
  const bottom = Math.max(...normalized.map(({ y }) => y));
  return Object.freeze({
    startColumn: left,
    endColumn: right,
    startRow: top,
    endRow: bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  });
}

export function normalizeTileSelection(cells) {
  if (!cells || typeof cells[Symbol.iterator] !== "function") throw new TypeError("tile selection must be iterable");
  return frozenCells(cells);
}

function cellMap(cells) {
  const result = new Map();
  if (cells == null) return result;
  if (typeof cells[Symbol.iterator] !== "function") throw new TypeError("tile selection must be iterable");
  for (const value of cells) {
    const point = tilePoint(value, "tile selection cell");
    result.set(tileKey(point), point);
  }
  return result;
}

function frozenCells(cells) {
  const values = [...cellMap(cells).values()]
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((point) => Object.freeze({ ...point }));
  return Object.freeze(values);
}

function normalizedRead(value) {
  if (value === null || value === undefined) return { exists: false, gid: 0 };
  if (typeof value === "object") {
    return value.exists === false
      ? { exists: false, gid: 0 }
      : { exists: true, gid: normalizedGid(value.gid ?? value.value) };
  }
  return { exists: true, gid: normalizedGid(value) };
}

function normalizedGid(value) {
  const gid = Number(value);
  if (!Number.isSafeInteger(gid) || gid < 0 || gid > 0xffff_ffff) throw new TypeError("Invalid Tiled GID");
  return gid >>> 0;
}

function tilePoint(value, label) {
  if (!value || typeof value !== "object") throw new TypeError(`Invalid ${label}`);
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new TypeError(`Invalid ${label}`);
  return { x, y };
}

function tileKey(point) {
  return `${point.x},${point.y}`;
}
