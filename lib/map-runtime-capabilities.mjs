import fs from "node:fs/promises";
import path from "node:path";

export const MAP_RUNTIME_CAPABILITY_VERSION = "wflgame-runtime-v1";

const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const LAYER_TYPES = Object.freeze(["tilelayer", "objectgroup", "imagelayer", "group"]);
const BUSINESS_LAYERS = Object.freeze([
  "Ground", "Collision", "Decor", "SpawnPoints", "Exits", "NPCs", "Enemies",
  "Chests", "QuestTriggers", "Secrets", "CameraBounds",
]);
const REQUIRED_MAP_PROPERTIES = Object.freeze(["mapId", "musicId", "backgroundAsset"]);
const REQUIRED_OBJECT_PROPERTIES = Object.freeze({
  SpawnPoints: ["spawnId", "spawnType", "facing"],
  Exits: ["exitId", "targetMap", "targetSpawn", "transition"],
  NPCs: ["npcId", "dialogueId"],
  // The checker uses object.name as the business key for Enemies.
  Enemies: ["name", "enemyId", "spawnGroup", "respawn"],
  Chests: ["chestId", "rewardId"],
  QuestTriggers: ["triggerId", "questId"],
  Secrets: ["secretId", "rewardId"],
});
const REQUIRED_OBJECT_SHAPES = Object.freeze({
  SpawnPoints: "point",
  NPCs: "point",
  Enemies: "point",
  Chests: "point",
  Secrets: "point",
  Ground: "rectangle",
  Collision: "rectangle",
  Decor: "rectangle",
  Exits: "rectangle",
  QuestTriggers: "rectangle",
  CameraBounds: "rectangle",
});

export class MapRuntimeCapabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MapRuntimeCapabilityError";
    this.code = code;
    this.statusCode = Number.isSafeInteger(details.statusCode) ? details.statusCode : 422;
    Object.assign(this, details);
  }
}

/**
 * Read-only, bounded inspection of a game project. This intentionally uses
 * source markers rather than executing the project's scripts or importing its
 * runtime. The result is a compatibility contract, not a trust decision.
 */
export async function inspectMapRuntimeCapabilities({ projectPath, mapPath = null, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES } = {}) {
  const root = await safeProjectRoot(projectPath);
  const files = await readMarkers(root, [
    "scripts/check-tiled-maps.mjs",
    "src/systems/TiledMapProtocol.ts",
    "src/systems/TiledMapAssets.ts",
    "package.json",
  ], maxSourceBytes);
  const checker = files.get("scripts/check-tiled-maps.mjs") || "";
  const protocol = files.get("src/systems/TiledMapProtocol.ts") || "";
  const assets = files.get("src/systems/TiledMapAssets.ts") || "";
  const hasChecker = files.has("scripts/check-tiled-maps.mjs");
  const hasProtocol = files.has("src/systems/TiledMapProtocol.ts");
  const hasAssets = files.has("src/systems/TiledMapAssets.ts");
  const checkerLayers = extractStringArray(checker, "VALID_LAYER_TYPES")
    .filter((value) => LAYER_TYPES.includes(value));
  const protocolLayers = LAYER_TYPES.filter((value) => protocol.includes(`'${value}'`));
  const requiredLayers = extractStringArray(checker, "REQUIRED_LAYERS");
  const requiredProperties = extractMapPropertyNames(checker);
  // A parser declaration alone is not enough to claim runtime support.  The
  // wflgame Phaser adapter renders tile layers by resolving tileset images and
  // creating a Phaser TilemapLayer.  Keep this evidence-based so a project
  // that only defines the Tiled data types remains read-only for tile edits.
  const tileLayerRenderer = hasAssets
    && /renderTiledTileLayers|tileLayersRendered/u.test(assets)
    && /createLayer\s*\(/u.test(assets)
    && /addTilesetImage\s*\(/u.test(assets);
  const layerTypes = {};
  for (const type of LAYER_TYPES) {
    const parsed = hasProtocol && (protocolLayers.includes(type) || checkerLayers.includes(type));
    const rendered = type === "imagelayer"
      ? hasAssets && /renderTiledImageLayers|renderTiledMapBackdrop/u.test(assets)
      : type === "group"
        ? hasAssets && /groupChildren|isGroupLayer/u.test(assets)
        : type === "objectgroup"
          ? hasProtocol && /tiledObjects|tiledLayer/u.test(protocol)
          : type === "tilelayer"
            ? tileLayerRenderer
            : false;
    layerTypes[type] = Object.freeze({ parsed, rendered, writable: parsed && type !== "group" });
  }
  const externalTsj = hasAssets && /\.tsj|source\??:/u.test(assets) && /resolve.*source|load.*tsj/u.test(assets);
  const world = false;
  const result = {
    version: MAP_RUNTIME_CAPABILITY_VERSION,
    detected: hasChecker || hasProtocol || hasAssets,
    projectType: hasProtocol || hasAssets ? "phaser-tiled" : "unknown",
    mapPath: normalizeRelative(mapPath),
    validation: {
      checkerPresent: hasChecker,
      command: hasChecker ? "node scripts/check-tiled-maps.mjs" : null,
      sourceFiles: Object.freeze([...files.keys()]),
    },
    layers: Object.freeze(layerTypes),
    resources: Object.freeze({
      projectRelativeImages: true,
      externalTilesets: Boolean(externalTsj),
      worldFiles: world,
      templates: false,
      audio: true,
    }),
    requiredLayers: Object.freeze(requiredLayers.length ? requiredLayers : [...BUSINESS_LAYERS]),
    requiredMapProperties: Object.freeze(requiredProperties.length ? requiredProperties : [...REQUIRED_MAP_PROPERTIES]),
    requiredObjectProperties: Object.freeze({ ...REQUIRED_OBJECT_PROPERTIES }),
    requiredObjectShapes: Object.freeze({ ...REQUIRED_OBJECT_SHAPES }),
    notes: Object.freeze([
      "浏览器 Tiled 预览成功不代表 Phaser 游戏运行时兼容。",
      ...(layerTypes.tilelayer?.rendered === false ? ["当前运行时仅解析 tilelayer，不保证渲染 tilelayer。"] : []),
      ...(externalTsj ? [] : ["当前运行时未检测到外部 .tsj 加载支持。"]),
      "未识别字段仍由地图编辑器保留，但不自动视为运行时可消费。",
    ]),
  };
  return Object.freeze(result);
}

/**
 * Enforce the runtime contract against a structured patch before any task is
 * queued. The caller must pass the already parsed current map and normalized
 * patch, so no file or model access occurs here.
 */
export function assertMapPatchRuntimeCompatible(document, patch, capabilities) {
  if (!capabilities?.detected) return;
  const layers = new Map(flattenLayers(document?.layers).map(({ layer }) => [layer.id, layer]));
  for (const [index, operation] of (patch?.operations || []).entries()) {
    const layer = layers.get(operation.layerId);
    if (!layer) continue;
    const layerCapability = capabilities.layers?.[layer.type];
    if (!layerCapability?.parsed) throw runtimeError("RUNTIME_LAYER_UNSUPPORTED", `运行时不支持图层类型 ${layer.type}`, { operationIndex: index, layerType: layer.type });
    if (layer.type === "tilelayer" && layerCapability.rendered !== true) {
      throw runtimeError("RUNTIME_LAYER_UNSUPPORTED", "当前游戏运行时不会渲染 tilelayer，不能通过托管 AI 写入瓦片层", { operationIndex: index, layerId: layer.id, layerType: layer.type });
    }
    if (["add-object", "update-object"].includes(operation.op)) {
      const object = operation.op === "add-object" ? operation.object : findObject(layer, operation.objectId);
      const candidate = operation.op === "add-object" ? object : { ...object, ...operation.changes };
      assertBusinessProperties(layer, candidate, capabilities, index);
      assertResourceReferences(candidate, capabilities, index);
    }
    if (operation.op === "update-layer") assertResourceReferences(operation.changes, capabilities, index);
  }
}

function assertBusinessProperties(layer, object, capabilities, index) {
  const shape = capabilities.requiredObjectShapes?.[layer.name];
  if (shape === "point" && (!Number.isFinite(object?.x) || !Number.isFinite(object?.y))) {
    throw runtimeError("RUNTIME_REQUIRED_PROPERTY_MISSING", `运行时业务层 ${layer.name} 对象必须包含有效坐标`, { operationIndex: index, layerName: layer.name, property: "x/y" });
  }
  if (shape === "rectangle" && (!Number.isFinite(object?.x) || !Number.isFinite(object?.y)
    || !Number.isFinite(object?.width) || object.width <= 0
    || !Number.isFinite(object?.height) || object.height <= 0)) {
    throw runtimeError("RUNTIME_REQUIRED_PROPERTY_MISSING", `运行时业务层 ${layer.name} 对象必须是有效矩形`, { operationIndex: index, layerName: layer.name, property: "x/y/width/height" });
  }
  const required = capabilities.requiredObjectProperties?.[layer.name];
  if (!required?.length) return;
  const properties = new Map((Array.isArray(object?.properties) ? object.properties : []).map((entry) => [entry?.name, entry?.value]));
  // Enforce only fields that the game checker declares for the layer. This
  // avoids treating arbitrary Tiled object layers as business objects.
  for (const key of required) {
    const value = key === "name" ? object?.name : properties.get(key);
    if (typeof value !== "string" || !value.trim()) {
      throw runtimeError("RUNTIME_REQUIRED_PROPERTY_MISSING", `运行时业务层 ${layer.name} 缺少必需字段 ${key}`, { operationIndex: index, layerName: layer.name, property: key });
    }
  }
}

function assertResourceReferences(value, capabilities, index) {
  walk(value, (key, reference) => {
    if (typeof reference !== "string" || !reference.trim()) return;
    const normalized = reference.replaceAll("\\", "/").toLowerCase();
    if (key === "source" && normalized.endsWith(".tsj") && capabilities.resources?.externalTilesets !== true) {
      throw runtimeError("RUNTIME_RESOURCE_UNSUPPORTED", "当前游戏运行时不支持外部 .tsj 瓦片集", { operationIndex: index, resourceType: "tsj" });
    }
    if ((key === "template" || normalized.endsWith(".tx")) && capabilities.resources?.templates !== true) {
      throw runtimeError("RUNTIME_RESOURCE_UNSUPPORTED", "当前游戏运行时不支持 Tiled 模板资源", { operationIndex: index, resourceType: "template" });
    }
    if ((key === "world" || normalized.endsWith(".world")) && capabilities.resources?.worldFiles !== true) {
      throw runtimeError("RUNTIME_RESOURCE_UNSUPPORTED", "当前游戏运行时不支持 .world 世界文件", { operationIndex: index, resourceType: "world" });
    }
    if ((key === "image" || key === "file") && (reference.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(reference))) {
      throw runtimeError("RUNTIME_RESOURCE_UNSUPPORTED", "运行时资源必须是工程相对路径", { operationIndex: index, resourceType: "image" });
    }
  });
}

function runtimeError(code, message, details) { return new MapRuntimeCapabilityError(code, message, details); }

async function safeProjectRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw runtimeError("RUNTIME_PROJECT_INVALID", "运行时工程路径无效");
  const resolved = path.resolve(value);
  const [real, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw runtimeError("RUNTIME_PROJECT_INVALID", "运行时工程目录不安全");
  return resolved;
}

async function readMarkers(root, names, maxBytes) {
  const result = new Map();
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_SOURCE_BYTES;
  for (const name of names) {
    const target = path.join(root, ...name.split("/"));
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > limit) continue;
    try { result.set(name, await fs.readFile(target, "utf8")); } catch {}
  }
  return result;
}

function extractStringArray(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "u").exec(source);
  return match ? [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((entry) => entry[1]) : [];
}

function extractMapPropertyNames(source) {
  const result = [];
  for (const key of ["mapId", "musicId", "backgroundAsset"]) if (source.includes(`'${key}'`)) result.push(key);
  return result;
}

function normalizeRelative(value) {
  if (value == null) return null;
  const text = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  return text.startsWith("/") || text.split("/").includes("..") ? null : text;
}

function flattenLayers(layers, output = []) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    output.push({ layer });
    if (layer?.type === "group") flattenLayers(layer.layers, output);
  }
  return output;
}

function findObject(layer, objectId) {
  const object = Array.isArray(layer?.objects) ? layer.objects.find((entry) => entry?.id === objectId) : null;
  if (!object) throw runtimeError("RUNTIME_OBJECT_NOT_FOUND", `运行时校验找不到对象 ${objectId}`);
  return object;
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const entry of value) walk(entry, visit); return; }
  for (const [key, entry] of Object.entries(value)) {
    visit(key, entry);
    walk(entry, visit);
  }
}
