import {
  relativeTiledProjectReference,
  resolveTiledProjectReference,
} from "./tiled-document.js?v=0.44.60-beta";

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_PATTERN_LENGTH = 512;

export class TiledWorldError extends Error {
  constructor(message, diagnostics = [], options = {}) {
    super(message, options);
    this.name = "TiledWorldError";
    this.diagnostics = diagnostics;
  }
}

export function parseTiledWorld(source, { sourcePath = null } = {}) {
  let document;
  try {
    const text = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
    document = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (cause) {
    const diagnostics = [issue("error", "invalid-world-json", "$", `无法解析 Tiled World JSON：${cause.message}`)];
    throw new TiledWorldError(diagnostics[0].message, diagnostics, { cause });
  }
  const diagnostics = validateTiledWorld(document, { sourcePath });
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length) throw new TiledWorldError(`Tiled World 校验失败：${errors[0].message}`, diagnostics);
  return Object.freeze({
    kind: "world",
    document,
    diagnostics: Object.freeze(diagnostics),
    sourcePath: sourcePath ? normalizeWorldPath(sourcePath) : null,
  });
}

export function serializeTiledWorld(value, { sourcePath = value?.sourcePath, space = 2, trailingNewline = true } = {}) {
  const document = worldDocumentValue(value);
  const diagnostics = validateTiledWorld(document, { sourcePath });
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length) throw new TiledWorldError(`Tiled World 校验失败：${errors[0].message}`, diagnostics);
  const serialized = JSON.stringify(document, null, Math.max(0, Math.min(8, Number.isInteger(space) ? space : 2)));
  return trailingNewline === false ? serialized : `${serialized}\n`;
}

export function validateTiledWorld(document, { sourcePath = null } = {}) {
  const diagnostics = [];
  if (!isRecord(document)) return [issue("error", "invalid-world-root", "$", "Tiled World 根节点必须是对象")];
  if (document.type !== "world") diagnostics.push(issue("error", "invalid-world-type", "$.type", "Tiled World type 必须是 world"));
  const worldPath = sourcePath == null ? null : safeWorldPath(sourcePath, diagnostics);
  if (document.maps !== undefined && !Array.isArray(document.maps)) {
    diagnostics.push(issue("error", "invalid-world-maps", "$.maps", "World maps 必须是数组"));
  }
  const names = new Set();
  for (const [index, map] of (Array.isArray(document.maps) ? document.maps : []).entries()) {
    const jsonPath = `$.maps[${index}]`;
    if (!isRecord(map)) {
      diagnostics.push(issue("error", "invalid-world-map", jsonPath, "World 地图条目必须是对象"));
      continue;
    }
    validateWorldMapReference(map.fileName, `${jsonPath}.fileName`, worldPath, diagnostics);
    for (const field of ["x", "y"]) validateInteger(map[field], `${jsonPath}.${field}`, diagnostics);
    for (const field of ["width", "height"]) validatePositiveInteger(map[field], `${jsonPath}.${field}`, diagnostics);
    if (typeof map.fileName === "string") {
      if (names.has(map.fileName)) diagnostics.push(issue("error", "duplicate-world-map", `${jsonPath}.fileName`, `World 重复引用 ${map.fileName}`));
      names.add(map.fileName);
    }
  }
  if (document.patterns !== undefined && !Array.isArray(document.patterns)) {
    diagnostics.push(issue("error", "invalid-world-patterns", "$.patterns", "World patterns 必须是数组"));
  }
  for (const [index, pattern] of (Array.isArray(document.patterns) ? document.patterns : []).entries()) {
    validateWorldPattern(pattern, `$.patterns[${index}]`, diagnostics);
  }
  if (document.onlyShowAdjacentMaps !== undefined && typeof document.onlyShowAdjacentMaps !== "boolean") {
    diagnostics.push(issue("error", "invalid-world-adjacent-mode", "$.onlyShowAdjacentMaps", "onlyShowAdjacentMaps 必须是布尔值"));
  }
  return diagnostics;
}

export function createTiledWorld({ maps = [], patterns = [], onlyShowAdjacentMaps = false, extra = {} } = {}) {
  const document = {
    ...cloneJson(extra),
    maps: maps.map((entry) => cloneJson(entry)),
    onlyShowAdjacentMaps: onlyShowAdjacentMaps === true,
    patterns: patterns.map((entry) => cloneJson(entry)),
    type: "world",
  };
  const diagnostics = validateTiledWorld(document);
  const error = diagnostics.find((entry) => entry.severity === "error");
  if (error) throw new TiledWorldError(error.message, diagnostics);
  return document;
}

export function worldBounds(value) {
  const maps = worldDocumentValue(value).maps || [];
  if (!maps.length) return Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
  // Do not spread every map into Math.min/Math.max. Large Worlds can exceed
  // the engine's function argument limit even though their bounds fit safely
  // in memory. A fixed-memory pass is deterministic for every map count.
  let left = maps[0].x;
  let top = maps[0].y;
  let right = maps[0].x + maps[0].width;
  let bottom = maps[0].y + maps[0].height;
  for (let index = 1; index < maps.length; index += 1) {
    const map = maps[index];
    left = Math.min(left, map.x);
    top = Math.min(top, map.y);
    right = Math.max(right, map.x + map.width);
    bottom = Math.max(bottom, map.y + map.height);
  }
  return Object.freeze({ x: left, y: top, width: right - left, height: bottom - top });
}

export function worldMapAtPoint(value, x, y) {
  const pointX = finiteNumber(x, "x");
  const pointY = finiteNumber(y, "y");
  const maps = worldDocumentValue(value).maps || [];
  for (let index = maps.length - 1; index >= 0; index -= 1) {
    const map = maps[index];
    if (pointX >= map.x && pointX < map.x + map.width && pointY >= map.y && pointY < map.y + map.height) {
      return Object.freeze({ index, map });
    }
  }
  return null;
}

export function worldMapsAdjacent(left, right) {
  const a = normalizedWorldRect(left);
  const b = normalizedWorldRect(right);
  const horizontalOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const touchingX = a.x + a.width === b.x || b.x + b.width === a.x;
  const touchingY = a.y + a.height === b.y || b.y + b.height === a.y;
  return (horizontalOverlap > 0 && verticalOverlap > 0)
    || (touchingX && verticalOverlap > 0)
    || (touchingY && horizontalOverlap > 0);
}

export function adjacentWorldMapIndexes(value, selectedIndex) {
  const maps = worldDocumentValue(value).maps || [];
  const index = Number(selectedIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= maps.length) return Object.freeze([]);
  const adjacent = [];
  for (let candidate = 0; candidate < maps.length; candidate += 1) {
    if (candidate !== index && worldMapsAdjacent(maps[index], maps[candidate])) adjacent.push(candidate);
  }
  return Object.freeze(adjacent);
}

export function resolveWorldMapReference(worldPath, fileName) {
  const resolved = resolveTiledProjectReference(normalizeWorldPath(worldPath), fileName);
  if (!resolved.toLowerCase().endsWith(".tmj")) throw new TypeError("World 地图引用必须指向 .tmj");
  return resolved;
}

export function worldMapReference(worldPath, mapPath) {
  const reference = relativeTiledProjectReference(normalizeWorldPath(worldPath), mapPath);
  resolveWorldMapReference(worldPath, reference);
  return reference;
}

export class TiledWorldEditDocument {
  constructor(document, { sourcePath = null, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
    const diagnostics = validateTiledWorld(document, { sourcePath });
    const error = diagnostics.find((entry) => entry.severity === "error");
    if (error) throw new TiledWorldError(error.message, diagnostics);
    this.document = cloneJson(document);
    this.sourcePath = sourcePath ? normalizeWorldPath(sourcePath) : null;
    this.historyLimit = positiveSafeInteger(historyLimit, "historyLimit");
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.nextStateId = 1;
    this.headStateId = 0;
    this.savedStateId = 0;
  }

  get dirty() { return this.headStateId !== this.savedStateId; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addMap(value, { index = this.document.maps.length, label = "添加地图" } = {}) {
    const entry = normalizeWorldMap(value, this.sourcePath);
    if (this.document.maps.some((map) => map.fileName === entry.fileName)) {
      throw new TiledWorldError(`World 已引用 ${entry.fileName}`);
    }
    const targetIndex = insertionIndex(index, this.document.maps.length);
    this.commit(label, (document) => document.maps.splice(targetIndex, 0, entry));
    return cloneJson(entry);
  }

  removeMap(selector, { label = "移除地图" } = {}) {
    const index = worldMapIndex(this.document, selector);
    if (index < 0) throw new TiledWorldError("要移除的 World 地图不存在");
    const removed = cloneJson(this.document.maps[index]);
    this.commit(label, (document) => document.maps.splice(index, 1));
    return removed;
  }

  moveMap(selector, { x, y, label = "移动地图" } = {}) {
    const index = worldMapIndex(this.document, selector);
    if (index < 0) throw new TiledWorldError("要移动的 World 地图不存在");
    const nextX = integer(x, "x");
    const nextY = integer(y, "y");
    if (this.document.maps[index].x === nextX && this.document.maps[index].y === nextY) return false;
    this.commit(label, (document) => Object.assign(document.maps[index], { x: nextX, y: nextY }));
    return true;
  }

  resizeMap(selector, { width, height, label = "调整地图边界" } = {}) {
    const index = worldMapIndex(this.document, selector);
    if (index < 0) throw new TiledWorldError("要调整的 World 地图不存在");
    const nextWidth = positiveSafeInteger(width, "width");
    const nextHeight = positiveSafeInteger(height, "height");
    if (this.document.maps[index].width === nextWidth && this.document.maps[index].height === nextHeight) return false;
    this.commit(label, (document) => Object.assign(document.maps[index], { width: nextWidth, height: nextHeight }));
    return true;
  }

  setOnlyShowAdjacentMaps(value, { label = "修改相邻地图模式" } = {}) {
    const enabled = value === true;
    if (this.document.onlyShowAdjacentMaps === enabled) return false;
    this.commit(label, (document) => { document.onlyShowAdjacentMaps = enabled; });
    return true;
  }

  replacePatterns(patterns, { label = "修改 World patterns" } = {}) {
    const next = Array.isArray(patterns) ? patterns.map((entry) => cloneJson(entry)) : null;
    if (!next) throw new TypeError("patterns must be an array");
    const candidate = { ...this.document, patterns: next };
    const error = validateTiledWorld(candidate, { sourcePath: this.sourcePath }).find((entry) => entry.severity === "error");
    if (error) throw new TiledWorldError(error.message, [error]);
    if (JSON.stringify(next) === JSON.stringify(this.document.patterns || [])) return false;
    this.commit(label, (document) => { document.patterns = next; });
    return true;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.document = cloneJson(entry.before);
    this.redoStack.push(entry);
    this.headStateId = entry.beforeStateId;
    this.emit("undo", entry);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.document = cloneJson(entry.after);
    this.undoStack.push(entry);
    this.headStateId = entry.afterStateId;
    this.emit("redo", entry);
    return true;
  }

  markSaved(stateId = this.headStateId) {
    if (!Number.isSafeInteger(stateId) || stateId < 0) throw new TypeError("stateId must be a non-negative safe integer");
    this.savedStateId = stateId;
    this.emit("saved", null);
  }

  exportDocument() { return cloneJson(this.document); }

  commit(label, mutation) {
    const before = cloneJson(this.document);
    mutation(this.document);
    const diagnostics = validateTiledWorld(this.document, { sourcePath: this.sourcePath });
    const error = diagnostics.find((entry) => entry.severity === "error");
    if (error) {
      this.document = before;
      throw new TiledWorldError(error.message, diagnostics);
    }
    const after = cloneJson(this.document);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const entry = {
      type: "world-edit",
      label: String(label || "编辑 World"),
      before,
      after,
      beforeStateId: this.headStateId,
      afterStateId: this.nextStateId++,
    };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.headStateId = entry.afterStateId;
    this.emit("commit", entry);
    return true;
  }

  emit(action, entry) {
    const event = Object.freeze({ action, entry, ...this.snapshot() });
    for (const listener of this.listeners) listener(event);
  }

  snapshot() {
    return Object.freeze({
      dirty: this.dirty,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      headStateId: this.headStateId,
      savedStateId: this.savedStateId,
    });
  }
}

function normalizeWorldMap(value, sourcePath) {
  const entry = cloneJson(value);
  if (!isRecord(entry)) throw new TypeError("World map must be an object");
  if (sourcePath) resolveWorldMapReference(sourcePath, entry.fileName);
  else if (typeof entry.fileName !== "string" || !entry.fileName.toLowerCase().endsWith(".tmj")) {
    throw new TiledWorldError("World 地图引用必须指向 .tmj");
  }
  entry.x = integer(entry.x, "x");
  entry.y = integer(entry.y, "y");
  entry.width = positiveSafeInteger(entry.width, "width");
  entry.height = positiveSafeInteger(entry.height, "height");
  return entry;
}

function validateWorldMapReference(value, jsonPath, worldPath, diagnostics) {
  if (typeof value !== "string" || !value || !value.toLowerCase().endsWith(".tmj")) {
    diagnostics.push(issue("error", "invalid-world-map-reference", jsonPath, "World fileName 必须指向 .tmj"));
    return;
  }
  if (!worldPath) return;
  try {
    resolveWorldMapReference(worldPath, value);
  } catch (error) {
    diagnostics.push(issue("error", "invalid-world-map-reference", jsonPath, error.message));
  }
}

function validateWorldPattern(pattern, jsonPath, diagnostics) {
  if (!isRecord(pattern)) {
    diagnostics.push(issue("error", "invalid-world-pattern", jsonPath, "World pattern 必须是对象"));
    return;
  }
  if (typeof pattern.regexp !== "string" || !pattern.regexp || pattern.regexp.length > MAX_PATTERN_LENGTH || pattern.regexp.includes("\0")) {
    diagnostics.push(issue("error", "invalid-world-pattern-regexp", `${jsonPath}.regexp`, `pattern regexp 必须是 1-${MAX_PATTERN_LENGTH} 个字符`));
  } else {
    try { new RegExp(pattern.regexp, "u"); } catch {
      diagnostics.push(issue("error", "invalid-world-pattern-regexp", `${jsonPath}.regexp`, "pattern regexp 语法无效"));
    }
  }
  for (const field of ["multiplierX", "multiplierY", "offsetX", "offsetY"]) {
    validateInteger(pattern[field], `${jsonPath}.${field}`, diagnostics);
  }
  for (const field of ["mapWidth", "mapHeight"]) {
    validatePositiveInteger(pattern[field], `${jsonPath}.${field}`, diagnostics);
  }
}

function safeWorldPath(value, diagnostics) {
  try { return normalizeWorldPath(value); } catch (error) {
    diagnostics.push(issue("error", "invalid-world-source-path", "$", error.message));
    return null;
  }
}

function normalizeWorldPath(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.startsWith("/") || text.includes("\\") || !text.toLowerCase().endsWith(".world")) {
    throw new TypeError("World 路径必须是工程相对 .world 文件");
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new TypeError("World 路径无效");
  }
  return segments.join("/");
}

function normalizedWorldRect(value) {
  return {
    x: integer(value?.x, "x"),
    y: integer(value?.y, "y"),
    width: positiveSafeInteger(value?.width, "width"),
    height: positiveSafeInteger(value?.height, "height"),
  };
}

function worldMapIndex(document, selector) {
  if (Number.isSafeInteger(selector)) return selector >= 0 && selector < document.maps.length ? selector : -1;
  if (typeof selector === "string") return document.maps.findIndex((entry) => entry.fileName === selector);
  return -1;
}

function worldDocumentValue(value) {
  const document = value?.kind === "world" ? value.document : value?.document?.type === "world" ? value.document : value;
  if (!isRecord(document)) throw new TypeError("Tiled World document must be an object");
  return document;
}

function insertionIndex(value, length) {
  if (value === undefined) return length;
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > length) throw new TypeError("index is outside the World maps array");
  return index;
}

function validateInteger(value, jsonPath, diagnostics) {
  if (!Number.isSafeInteger(value)) diagnostics.push(issue("error", "invalid-world-integer", jsonPath, `${jsonPath} 必须是整数`));
}

function validatePositiveInteger(value, jsonPath, diagnostics) {
  if (!Number.isSafeInteger(value) || value <= 0) diagnostics.push(issue("error", "invalid-world-size", jsonPath, `${jsonPath} 必须是正整数`));
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be a safe integer`);
  return number;
}

function positiveSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return number;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite`);
  return number;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(severity, code, path, message) {
  return Object.freeze({ severity, code, path, message });
}
