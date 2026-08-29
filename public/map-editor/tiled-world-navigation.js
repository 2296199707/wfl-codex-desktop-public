import {
  normalizeTiledProjectPath,
  resolveTiledProjectReference,
} from "./tiled-document.js?v=0.44.64";
import {
  mapPixelBounds,
  tiledObjectScreenBounds,
} from "./tiled-render-model.js?v=0.44.64";
import {
  adjacentWorldMapIndexes,
  resolveWorldMapReference,
} from "./tiled-world.js?v=0.44.64";

const TARGET_MAP_PROPERTIES = new Set(["destination", "destinationmap", "targetmap"]);
const TARGET_SPAWN_PROPERTIES = new Set(["destinationspawn", "targetspawn"]);

export function planWorldMapPreviews(world, { sourcePath, selectedFileName = null } = {}) {
  const maps = Array.isArray(world?.maps) ? world.maps : [];
  const selectedIndex = maps.findIndex((entry) => entry?.fileName === selectedFileName);
  const visibleIndexes = world?.onlyShowAdjacentMaps === true && selectedIndex >= 0
    ? new Set([selectedIndex, ...adjacentWorldMapIndexes(world, selectedIndex)])
    : new Set(maps.map((_entry, index) => index));
  const plan = [];
  for (const [index, entry] of maps.entries()) {
    if (!visibleIndexes.has(index) || !entry?.fileName) continue;
    plan.push(Object.freeze({
      fileName: entry.fileName,
      mapPath: resolveWorldMapReference(sourcePath, entry.fileName),
      mode: index === selectedIndex ? "full" : "preview",
    }));
  }
  return Object.freeze(plan);
}

export function collectWorldMapNavigation(document, { mapPath } = {}) {
  const normalizedMapPath = normalizeTiledProjectPath(mapPath);
  const bounds = mapPixelBounds(document);
  const spawns = [];
  const portals = [];
  visitObjects(document?.layers, (object, offsetX, offsetY, layer) => {
    const properties = propertyMap(object?.properties);
    const semanticType = String(object?.class || object?.type || "").trim().toLowerCase();
    const spawnId = textValue(properties.get("spawnid"))
      || (isSpawnObject(semanticType, properties) ? textValue(object?.name) : "");
    const position = objectPosition(document, object, offsetX, offsetY);
    if (isSpawnObject(semanticType, properties)) {
      spawns.push(Object.freeze({
        id: spawnId,
        objectId: safeObjectId(object?.id),
        objectName: textValue(object?.name),
        layerId: safeObjectId(layer?.id),
        x: position.x,
        y: position.y,
      }));
    }
    if (isPortalObject(semanticType, properties)) {
      portals.push(Object.freeze({
        objectId: safeObjectId(object?.id),
        objectName: textValue(object?.name),
        layerId: safeObjectId(layer?.id),
        targetMap: firstPropertyValue(properties, TARGET_MAP_PROPERTIES),
        targetSpawn: firstPropertyValue(properties, TARGET_SPAWN_PROPERTIES),
        x: position.x,
        y: position.y,
      }));
    }
  });
  return Object.freeze({
    mapPath: normalizedMapPath,
    bounds: Object.freeze({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }),
    spawns: Object.freeze(spawns),
    portals: Object.freeze(portals),
  });
}

export function validateWorldPortalReferences(world, summaries, { sourcePath } = {}) {
  const maps = Array.isArray(world?.maps) ? world.maps : [];
  const worldMaps = new Map();
  for (const entry of maps) {
    if (!entry?.fileName) continue;
    const mapPath = resolveWorldMapReference(sourcePath, entry.fileName);
    worldMaps.set(mapPath, entry);
  }
  const summaryByPath = normalizeSummaries(summaries);
  const diagnostics = [];
  const links = [];

  for (const [mapPath, entry] of worldMaps) {
    const summary = summaryByPath.get(mapPath);
    if (!summary) {
      diagnostics.push(issue(
        "warning",
        "world-map-navigation-unchecked",
        mapPath,
        null,
        `尚未读取 ${mapPath} 的传送引用`,
      ));
      continue;
    }
    const spawnIds = new Map();
    for (const spawn of summary.spawns || []) {
      if (!spawn.id) {
        diagnostics.push(issue(
          "warning",
          "world-spawn-id-missing",
          mapPath,
          spawn.objectId,
          `${mapPath} 的出生点 ${objectLabel(spawn)} 没有 spawnId 或名称`,
        ));
        continue;
      }
      if (spawnIds.has(spawn.id)) {
        diagnostics.push(issue(
          "error",
          "world-spawn-id-duplicate",
          mapPath,
          spawn.objectId,
          `${mapPath} 存在重复出生点 ${spawn.id}`,
        ));
      } else {
        spawnIds.set(spawn.id, spawn);
      }
    }
    for (const portal of summary.portals || []) {
      if (!portal.targetMap) {
        diagnostics.push(issue(
          "error",
          "world-portal-target-map-missing",
          mapPath,
          portal.objectId,
          `${mapPath} 的传送点 ${objectLabel(portal)} 没有 targetMap`,
        ));
        continue;
      }
      const targetMapPath = resolvePortalTargetMap(mapPath, portal.targetMap, worldMaps);
      if (!targetMapPath || !worldMaps.has(targetMapPath)) {
        diagnostics.push(issue(
          "error",
          "world-portal-target-map-not-found",
          mapPath,
          portal.objectId,
          `${mapPath} 的传送点 ${objectLabel(portal)} 指向 World 外或不存在的地图 ${portal.targetMap}`,
        ));
        continue;
      }
      const targetSummary = summaryByPath.get(targetMapPath);
      if (!targetSummary) {
        diagnostics.push(issue(
          "warning",
          "world-portal-target-unchecked",
          mapPath,
          portal.objectId,
          `${mapPath} 的传送点 ${objectLabel(portal)} 尚未检查目标地图 ${targetMapPath}`,
        ));
        continue;
      }
      if (!portal.targetSpawn) {
        diagnostics.push(issue(
          "warning",
          "world-portal-target-spawn-missing",
          mapPath,
          portal.objectId,
          `${mapPath} 的传送点 ${objectLabel(portal)} 没有 targetSpawn`,
        ));
        continue;
      }
      const targetSpawn = (targetSummary.spawns || []).find((spawn) => spawn.id === portal.targetSpawn);
      if (!targetSpawn) {
        diagnostics.push(issue(
          "error",
          "world-portal-target-spawn-not-found",
          mapPath,
          portal.objectId,
          `${mapPath} 的传送点 ${objectLabel(portal)} 在 ${targetMapPath} 中找不到出生点 ${portal.targetSpawn}`,
        ));
        continue;
      }
      links.push(Object.freeze({
        sourceMapPath: mapPath,
        sourceObjectId: portal.objectId,
        source: worldPoint(entry, summary.bounds, portal),
        targetMapPath,
        targetSpawn: portal.targetSpawn,
        target: worldPoint(worldMaps.get(targetMapPath), targetSummary.bounds, targetSpawn),
      }));
    }
  }

  return Object.freeze({
    checkedMapCount: summaryByPath.size,
    worldMapCount: worldMaps.size,
    portalCount: [...summaryByPath.values()].reduce(
      (total, summary) => total + (summary.portals?.length || 0),
      0,
    ),
    validLinkCount: links.length,
    errorCount: diagnostics.filter((entry) => entry.severity === "error").length,
    warningCount: diagnostics.filter((entry) => entry.severity === "warning").length,
    diagnostics: Object.freeze(diagnostics),
    links: Object.freeze(links),
  });
}

function visitObjects(layers, visitor, parentOffsetX = 0, parentOffsetY = 0) {
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    const coordinateX = ["group", "objectgroup", "imagelayer"].includes(layer.type)
      ? finiteNumber(layer.x)
      : 0;
    const coordinateY = ["group", "objectgroup", "imagelayer"].includes(layer.type)
      ? finiteNumber(layer.y)
      : 0;
    const offsetX = parentOffsetX + coordinateX + finiteNumber(layer.offsetx);
    const offsetY = parentOffsetY + coordinateY + finiteNumber(layer.offsety);
    if (layer.type === "objectgroup" && Array.isArray(layer.objects)) {
      for (const object of layer.objects) visitor(object, offsetX, offsetY, layer);
    }
    visitObjects(layer.layers, visitor, offsetX, offsetY);
  }
}

function propertyMap(properties) {
  const result = new Map();
  for (const property of Array.isArray(properties) ? properties : []) {
    const name = String(property?.name || "").trim().toLowerCase();
    if (name && !result.has(name)) result.set(name, property?.value);
  }
  return result;
}

function isSpawnObject(semanticType, properties) {
  return semanticType === "spawn" || semanticType === "spawnpoint" || properties.has("spawnid");
}

function isPortalObject(semanticType, properties) {
  return semanticType === "portal"
    || [...TARGET_MAP_PROPERTIES].some((name) => properties.has(name))
    || [...TARGET_SPAWN_PROPERTIES].some((name) => properties.has(name));
}

function firstPropertyValue(properties, names) {
  for (const name of names) {
    const value = textValue(properties.get(name));
    if (value) return value;
  }
  return "";
}

function objectPosition(document, object, offsetX, offsetY) {
  const bounds = tiledObjectScreenBounds(document, object, { pointTolerance: 1 });
  return {
    x: offsetX + bounds.x + bounds.width / 2,
    y: offsetY + bounds.y + bounds.height / 2,
  };
}

function resolvePortalTargetMap(sourceMapPath, rawTarget, worldMaps) {
  const target = String(rawTarget || "").trim().replaceAll("\\", "/");
  if (!target || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return null;
  const candidates = [];
  try { candidates.push(resolveTiledProjectReference(sourceMapPath, target)); } catch {}
  try { candidates.push(normalizeTiledProjectPath(target)); } catch {}
  return candidates.find((candidate) => worldMaps.has(candidate)) || candidates[0] || null;
}

function normalizeSummaries(value) {
  const entries = value instanceof Map
    ? value.entries()
    : (Array.isArray(value) ? value.map((summary) => [summary?.mapPath, summary]) : []);
  const result = new Map();
  for (const [key, summary] of entries) {
    if (!summary || typeof summary !== "object") continue;
    try {
      const mapPath = normalizeTiledProjectPath(summary.mapPath || key);
      result.set(mapPath, summary);
    } catch {}
  }
  return result;
}

function worldPoint(worldMap, bounds, point) {
  const width = positiveNumber(bounds?.width, worldMap.width);
  const height = positiveNumber(bounds?.height, worldMap.height);
  return Object.freeze({
    x: worldMap.x + (finiteNumber(point?.x) - finiteNumber(bounds?.x)) / width * worldMap.width,
    y: worldMap.y + (finiteNumber(point?.y) - finiteNumber(bounds?.y)) / height * worldMap.height,
  });
}

function issue(severity, code, mapPath, objectId, message) {
  return Object.freeze({ severity, code, mapPath, objectId, message });
}

function objectLabel(value) {
  return value?.objectName || (value?.objectId == null ? "未命名对象" : `#${value.objectId}`);
}

function safeObjectId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Math.max(1, finiteNumber(fallback));
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
