import { normalizeMapGuides } from "./map-guide-controller.js?v=0.44.65";

export const MAP_EDITOR_VIEW_STATE_VERSION = 3;

const STORAGE_PREFIX = "wfl-map-editor-view-v1";
const DETAIL_TABS = new Set(["tiles", "properties"]);
const TILE_SELECTION_MODES = new Set(["replace", "add", "subtract", "intersect"]);
const TOOLS = new Set([
  "select",
  "tile-select",
  "hand",
  "sample",
  "brush",
  "eraser",
  "fill",
  "tile-line",
  "tile-rectangle",
  "tile-ellipse",
  "tile-magic",
  "tile-same",
  "object",
  "collision",
  "vertex",
]);

export function mapEditorViewStorageKey({ accountId, projectPath, relativePath } = {}) {
  const account = boundedText(accountId, 256, "accountId");
  const project = boundedText(projectPath, 4096, "projectPath");
  const mapPath = boundedText(relativePath, 4096, "relativePath");
  if (!project.startsWith("/") || mapPath.startsWith("/") || !mapPath.toLowerCase().endsWith(".tmj")) {
    throw new TypeError("Invalid map editor view scope");
  }
  const segments = mapPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new TypeError("Invalid map editor view scope");
  }
  return `${STORAGE_PREFIX}:${encodeURIComponent(account)}:${encodeURIComponent(project)}:${encodeURIComponent(mapPath)}`;
}

export function createMapEditorViewState(input = {}, now = Date.now()) {
  const scale = boundedNumber(input.scale, 0.1, 8, "scale");
  const offsetX = boundedNumber(input.offsetX, -1_000_000_000, 1_000_000_000, "offsetX");
  const offsetY = boundedNumber(input.offsetY, -1_000_000_000, 1_000_000_000, "offsetY");
  const activeLayerId = input.activeLayerId == null ? null : boundedInteger(input.activeLayerId, "activeLayerId");
  const detailTab = DETAIL_TABS.has(input.detailTab) ? input.detailTab : "properties";
  const activeTool = TOOLS.has(input.activeTool) ? input.activeTool : "select";
  const updatedAt = Number(now);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) throw new TypeError("Invalid updatedAt");
  return Object.freeze({
    version: MAP_EDITOR_VIEW_STATE_VERSION,
    scale,
    offsetX,
    offsetY,
    activeLayerId,
    detailTab,
    activeTool,
    gridVisible: input.gridVisible !== false,
    layerPanelOpen: input.layerPanelOpen === true,
    guidesVisible: input.guidesVisible !== false,
    guideUnit: input.guideUnit === "tile" ? "tile" : "pixel",
    guides: normalizeMapGuides(input.guides),
    imageSnapEnabled: input.imageSnapEnabled === true,
    imageSnapUnit: input.imageSnapUnit === "tile" ? "tile" : "pixel",
    imageSnapStep: boundedOptionalInteger(input.imageSnapStep, 1, 1024, 1, "imageSnapStep"),
    tileRandomEnabled: input.tileRandomEnabled === true,
    tileRandomSeed: boundedOptionalInteger(input.tileRandomSeed, 0, 0xffff_ffff, 1, "tileRandomSeed"),
    tileSelectionMode: TILE_SELECTION_MODES.has(input.tileSelectionMode) ? input.tileSelectionMode : "replace",
    autoMapWhileDrawing: input.autoMapWhileDrawing === true,
    autoMapSeed: boundedOptionalInteger(input.autoMapSeed, 0, 0xffff_ffff, 1, "autoMapSeed"),
    updatedAt,
  });
}

export function parseMapEditorViewState(value) {
  if (!value || ![1, 2, MAP_EDITOR_VIEW_STATE_VERSION].includes(value.version)) return null;
  try {
    return createMapEditorViewState(value, value.updatedAt);
  } catch {
    return null;
  }
}

function boundedText(value, maximum, name) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > maximum || text.includes("\0")) throw new TypeError(`Invalid ${name}`);
  return text;
}

function boundedNumber(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new TypeError(`Invalid ${name}`);
  return number;
}

function boundedInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`Invalid ${name}`);
  return number;
}

function boundedOptionalInteger(value, minimum, maximum, fallback, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Invalid ${name}`);
  }
  return number;
}
