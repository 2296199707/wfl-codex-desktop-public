import { relativeTiledProjectReference, resolveTiledProjectReference } from "./tiled-document.js?v=0.44.59-beta";
import {
  nextTiledTilesetFirstGid,
  tiledTilesetLayout,
} from "./tiled-tileset-model.js?v=0.44.59-beta";

/**
 * Plan a TSJ import without mutating the map. The caller must authorize the
 * TSJ first; dependency metadata is used only to validate the atlas layout.
 */
export function planTiledTilesetImport({
  mapPath,
  resourcePath,
  definition,
  dependencies = [],
  existingTilesets = [],
} = {}) {
  const sourcePath = normalizePath(resourcePath, "TSJ 路径");
  const ownerMapPath = normalizePath(mapPath, "地图路径");
  if (definition?.type !== "tileset") throw importError("TILED_IMPORT_DEFINITION_INVALID", "TSJ 必须是 type=tileset");
  const dependencyList = Array.isArray(dependencies) ? dependencies : [];
  const imagePath = definition.image
    ? resolveTiledProjectReference(sourcePath, definition.image)
    : null;
  const image = imagePath
    ? dependencyList.find((entry) => entry?.path === imagePath)
    : null;
  const imageDimensions = image && Number.isSafeInteger(Number(image.width)) && Number.isSafeInteger(Number(image.height))
    ? { width: Number(image.width), height: Number(image.height) }
    : definition.image
      && Number.isSafeInteger(Number(definition.imagewidth))
      && Number.isSafeInteger(Number(definition.imageheight))
      ? { width: Number(definition.imagewidth), height: Number(definition.imageheight) }
      : null;
  const layout = tiledTilesetLayout(definition, imageDimensions ? { image: imageDimensions } : {});
  const existing = findExistingTileset(existingTilesets, ownerMapPath, sourcePath);
  const firstgid = existing
    ? Number(existing.firstgid)
    : nextTiledTilesetFirstGid(existingTilesets, layout.maxLocalId);
  const dependencyPaths = [sourcePath, ...dependencyList.map((entry) => entry?.path)]
    .filter((entry, index, values) => typeof entry === "string" && values.indexOf(entry) === index);
  return Object.freeze({
    sourcePath,
    reference: Object.freeze({
      firstgid,
      source: relativeTiledProjectReference(ownerMapPath, sourcePath),
    }),
    firstgid,
    reusedExisting: Boolean(existing),
    maxLocalId: layout.maxLocalId,
    lastgid: firstgid + layout.maxLocalId,
    label: String(definition.name || sourcePath.split("/").at(-1) || "瓦片集"),
    dependencyPaths: Object.freeze(dependencyPaths),
    layout: Object.freeze({
      kind: layout.kind,
      tileWidth: layout.tileWidth,
      tileHeight: layout.tileHeight,
      tileCount: layout.tileCount,
      maxLocalId: layout.maxLocalId,
    }),
  });
}

function findExistingTileset(entries, mapPath, sourcePath) {
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => {
    if (!Number.isSafeInteger(entry?.firstgid)) return false;
    if (entry.ownerPath === sourcePath || entry.sourcePath === sourcePath) return true;
    if (typeof entry.source !== "string" || !entry.source) return false;
    try {
      return resolveTiledProjectReference(mapPath, entry.source) === sourcePath;
    } catch {
      return false;
    }
  }) || null;
}

function normalizePath(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\\")) {
    throw importError("TILED_IMPORT_PATH_INVALID", `${label}必须是 POSIX 工程相对路径`);
  }
  if (value.startsWith("/") || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw importError("TILED_IMPORT_PATH_INVALID", `${label}必须是工程内文件路径`);
  }
  return value;
}

function importError(code, message) {
  const error = new Error(message);
  error.name = "TiledTilesetImportError";
  error.code = code;
  error.statusCode = 400;
  return error;
}
