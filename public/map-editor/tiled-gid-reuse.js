import {
  relativeTiledProjectReference,
  resolveTiledProjectReference,
} from "./tiled-document.js?v=0.44.59-beta";
import { normalizeTileStamp } from "./tile-tool-model.js?v=0.44.59-beta";
import {
  nextTiledTilesetFirstGid,
  validateTiledTilesetRanges,
} from "./tiled-tileset-model.js?v=0.44.59-beta";
import { decodeGlobalTileId } from "./tiled-render-model.js?v=0.44.59-beta";

/**
 * Plan reusing the tilesets (and the GIDs in a stamp) from one map in another
 * map.  Existing external TSJ references are matched by their canonical
 * project path.  A matched reference keeps its target firstgid; a missing
 * reference receives a new, non-overlapping firstgid without changing any
 * existing range.  This is deliberately a pure plan: callers still perform
 * the authenticated resource copy/grant and the atomic map edit.
 */
export function planTiledTilesetReuse({
  sourceMapPath,
  targetMapPath,
  sourceTilesets = [],
  targetTilesets = [],
  sourceProjectId = null,
  targetProjectId = null,
} = {}) {
  const sourceDocumentPath = sourcePath(sourceMapPath, "源地图或模板路径");
  const targetDocumentPath = mapPath(targetMapPath, "目标地图路径");
  if (!Array.isArray(sourceTilesets) || !Array.isArray(targetTilesets)) {
    throw gidReuseError("TILED_GID_TILESSETS_INVALID", "源和目标瓦片集必须是数组");
  }

  const targetRanges = validateTiledTilesetRanges(targetTilesets.map((entry, index) => rangeInput(entry, index, "目标")));
  const targetBySource = new Map();
  for (const entry of targetTilesets) {
    const path = externalSourcePath(targetDocumentPath, entry);
    if (path) targetBySource.set(path, entry);
  }

  const ranges = [...targetRanges];
  const additions = [];
  const mappings = [];
  const reused = [];
  const dependencies = new Set();

  for (const [index, entry] of sourceTilesets.entries()) {
    const normalized = rangeInput(entry, index, "源");
    const sourcePath = externalSourcePath(sourceDocumentPath, entry);
    if (sourcePath) dependencies.add(sourcePath);
    const existing = sourcePath ? targetBySource.get(sourcePath) : null;
    const sourceMaxLocalId = normalized.maxLocalId;
    if (existing) {
      const targetMaxLocalId = rangeInput(existing, index, "目标").maxLocalId;
      if (targetMaxLocalId < sourceMaxLocalId) {
        throw gidReuseError(
          "TILED_GID_LAYOUT_MISMATCH",
          `目标地图中的 ${sourcePath} 瓦片范围不足，不能安全复用 GID`,
          { sourcePath, sourceMaxLocalId, targetMaxLocalId },
        );
      }
      const targetFirstgid = positiveFirstgid(existing.firstgid, "目标瓦片集 firstgid");
      mappings.push(mapping(normalized.firstgid, targetFirstgid, sourceMaxLocalId, sourcePath, true));
      reused.push(Object.freeze({ sourcePath, firstgid: targetFirstgid, maxLocalId: targetMaxLocalId }));
      continue;
    }

    const firstgid = nextTiledTilesetFirstGid(ranges, sourceMaxLocalId);
    const embeddedDefinition = entry.definition
      || (entry.reference && !entry.reference.source ? entry.reference : null);
    if (!sourcePath && !embeddedDefinition) {
      throw gidReuseError("TILED_GID_EMBEDDED_DEFINITION_MISSING", "内嵌瓦片集缺少完整定义，不能安全复制");
    }
    const reference = sourcePath
      ? { firstgid, source: relativeTiledProjectReference(targetDocumentPath, sourcePath) }
      : { firstgid, ...cloneJsonValue(embeddedDefinition) };
    reference.firstgid = firstgid;
    const addedRange = { firstgid, maxLocalId: sourceMaxLocalId, definition: entry.definition || { name: "复用瓦片集" } };
    ranges.push(addedRange);
    additions.push(Object.freeze({
      reference: Object.freeze(cloneJsonValue(reference)),
      sourcePath,
      requiresResourceCopy: Boolean(sourcePath && sourceProjectId && targetProjectId && sourceProjectId !== targetProjectId),
    }));
    mappings.push(mapping(normalized.firstgid, firstgid, sourceMaxLocalId, sourcePath, false));
  }

  validateTiledTilesetRanges(ranges);
  return Object.freeze({
    additions: Object.freeze(additions),
    reused: Object.freeze(reused),
    mappings: Object.freeze(mappings),
    dependencyPaths: Object.freeze([...dependencies]),
    remapGlobalTileId(encodedGid, options = {}) {
      return remapGlobalTileId(encodedGid, mappings, options);
    },
    remapTileStamp(stamp, options = {}) {
      const normalized = normalizeTileStamp(stamp);
      return Object.freeze({
        ...normalized,
        cells: Object.freeze(normalized.cells.map((cell) => ({
          ...cell,
          gid: remapGlobalTileId(cell.gid, mappings, options),
        }))),
      });
    },
  });
}

export function remapGlobalTileId(encodedGid, mappings, options = {}) {
  const value = Number(encodedGid) >>> 0;
  const decoded = decodeGlobalTileId(value);
  if (!decoded.gid) return 0;
  if (!Array.isArray(mappings)) throw gidReuseError("TILED_GID_MAPPINGS_INVALID", "GID 映射必须是数组");
  const match = mappings.find((entry) => (
    decoded.gid >= entry.sourceFirstgid
    && decoded.gid <= entry.sourceFirstgid + entry.maxLocalId
  ));
  if (!match) {
    if (options.allowUnmapped === true) return value;
    throw gidReuseError("TILED_GID_UNMAPPED", `GID ${decoded.gid} 不属于可复用的瓦片集范围`, { gid: decoded.gid });
  }
  const localId = decoded.gid - match.sourceFirstgid;
  return (match.targetFirstgid + localId | (value & 0xf000_0000)) >>> 0;
}

function mapping(sourceFirstgid, targetFirstgid, maxLocalId, sourcePath, reused) {
  return Object.freeze({ sourceFirstgid, targetFirstgid, maxLocalId, sourcePath: sourcePath || null, reused });
}

function externalSourcePath(mapPathValue, entry) {
  const reference = entry?.reference || entry;
  if (typeof entry?.ownerPath === "string" && entry.ownerPath) return entry.ownerPath;
  if (typeof entry?.sourcePath === "string" && entry.sourcePath) return entry.sourcePath;
  if (typeof reference?.source !== "string" || !reference.source) return null;
  return resolveTiledProjectReference(mapPathValue, reference.source);
}

function rangeInput(entry, index, role) {
  const value = entry?.reference || entry;
  const firstgid = positiveFirstgid(value?.firstgid, `${role}瓦片集 ${index + 1} firstgid`);
  const maxLocalId = Number.isSafeInteger(entry?.maxLocalId)
    ? entry.maxLocalId
    : Number.isSafeInteger(entry?.layout?.maxLocalId)
      ? entry.layout.maxLocalId
      : Number.isSafeInteger(entry?.definition?.tilecount)
        ? entry.definition.tilecount - 1
        : Number.isSafeInteger(value?.maxLocalId)
          ? value.maxLocalId
          : null;
  if (!Number.isSafeInteger(maxLocalId) || maxLocalId < -1) {
    throw gidReuseError("TILED_GID_RANGE_INVALID", `${role}瓦片集 ${index + 1} 缺少有效的 maxLocalId`);
  }
  return { firstgid, maxLocalId };
}

function positiveFirstgid(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x0fff_ffff) {
    throw gidReuseError("TILED_GID_FIRSTGID_INVALID", `${label}必须是 1 到 268435455 的整数`);
  }
  return value;
}

function mapPath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || !value.toLowerCase().endsWith(".tmj")) {
    throw gidReuseError("TILED_GID_MAP_PATH_INVALID", `${label}必须是工程内 .tmj 路径`);
  }
  return value;
}

function sourcePath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/")
    || !/\.(?:tmj|tx)$/iu.test(value)) {
    throw gidReuseError("TILED_GID_SOURCE_PATH_INVALID", `${label}必须是工程内 .tmj 或 .tx 路径`);
  }
  return value;
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function gidReuseError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "TiledGidReuseError";
  error.code = code;
  error.statusCode = 400;
  error.details = details;
  return error;
}
