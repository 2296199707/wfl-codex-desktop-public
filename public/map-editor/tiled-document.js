const MAP_KIND = "map";
const TILESET_KIND = "tileset";
const KNOWN_LAYER_TYPES = new Set([
  "group",
  "imagelayer",
  "objectgroup",
  "tilelayer",
]);
const KNOWN_LAYER_BLEND_MODES = new Set([
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
]);
const KNOWN_MAP_ORIENTATIONS = new Set([
  "orthogonal",
  "isometric",
  "staggered",
  "hexagonal",
  "oblique",
]);

export const TILED_COMPATIBILITY_BASELINE = "1.12.2";

export const TILED_SUPPORT_LEVELS = Object.freeze({
  full: "full",
  partial: "partial",
  preserveOnly: "preserve-only",
  planned: "planned",
  conditional: "conditional",
  notApplicable: "not-applicable",
});

export const TILED_DOCUMENT_KINDS = Object.freeze({
  map: MAP_KIND,
  tileset: TILESET_KIND,
});

export class TiledDocumentError extends Error {
  constructor(message, diagnostics = [], options = {}) {
    super(message, options);
    this.name = "TiledDocumentError";
    this.diagnostics = diagnostics;
  }
}

export function parseTiledDocument(source, options = {}) {
  let text;
  try {
    text = decodeSource(source);
  } catch (cause) {
    const diagnostics = [issue("error", "invalid-utf8", "$", "Tiled JSON 必须使用有效的 UTF-8 编码")];
    throw new TiledDocumentError(diagnostics[0].message, diagnostics, { cause });
  }

  let document;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (cause) {
    const diagnostics = [issue("error", "invalid-json", "$", `无法解析 Tiled JSON：${cause.message}`)];
    throw new TiledDocumentError(diagnostics[0].message, diagnostics, { cause });
  }

  const diagnostics = validateTiledDocument(document, options);
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length) {
    throw new TiledDocumentError(
      `Tiled 文档校验失败：${errors[0].message}`,
      diagnostics,
    );
  }

  return {
    kind: detectTiledDocumentKind(document),
    document,
    diagnostics,
    sourcePath: options.sourcePath ? normalizeTiledProjectPath(options.sourcePath) : null,
  };
}

export function serializeTiledDocument(value, options = {}) {
  const document = parsedDocumentValue(value);
  const diagnostics = validateTiledDocument(document, {
    expectedKind: options.expectedKind || value?.kind,
    sourcePath: options.sourcePath || value?.sourcePath,
  });
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length) {
    throw new TiledDocumentError(
      `Tiled 文档校验失败：${errors[0].message}`,
      diagnostics,
    );
  }

  const spacing = Number.isInteger(options.space)
    ? Math.max(0, Math.min(8, options.space))
    : 2;
  const serialized = JSON.stringify(document, null, spacing);
  return options.trailingNewline === false ? serialized : `${serialized}\n`;
}

export function cloneTiledDocument(value) {
  const document = parsedDocumentValue(value);
  return JSON.parse(JSON.stringify(document));
}

export function detectTiledDocumentKind(document) {
  if (!isRecord(document)) return null;
  if (document.type === MAP_KIND) return MAP_KIND;
  if (document.type === TILESET_KIND) return TILESET_KIND;
  return null;
}

export function validateTiledDocument(document, options = {}) {
  const diagnostics = [];
  if (!isRecord(document)) {
    diagnostics.push(issue("error", "invalid-root", "$", "Tiled 文档根节点必须是 JSON 对象"));
    return diagnostics;
  }

  const kind = detectTiledDocumentKind(document);
  if (!kind) {
    diagnostics.push(issue("error", "unknown-document-kind", "$.type", "Tiled 文档 type 必须是 map 或 tileset"));
    return diagnostics;
  }
  if (options.expectedKind && kind !== options.expectedKind) {
    diagnostics.push(issue(
      "error",
      "unexpected-document-kind",
      "$.type",
      `预期 ${options.expectedKind} 文档，实际为 ${kind}`,
    ));
  }

  let sourcePath = null;
  if (options.sourcePath) {
    try {
      sourcePath = normalizeTiledProjectPath(options.sourcePath);
    } catch (error) {
      diagnostics.push(issue("error", "invalid-source-path", "$", error.message));
    }
  }

  validateProperties(document.properties, "$.properties", sourcePath, diagnostics);
  if (kind === MAP_KIND) validateMap(document, sourcePath, diagnostics);
  else validateTileset(document, "$", sourcePath, diagnostics);
  diagnostics.push(...tiledCompatibilityDiagnostics(document));
  return diagnostics;
}

export function tiledCompatibilityDiagnostics(value) {
  const document = parsedDocumentValue(value);
  if (!isRecord(document)) return [];
  const diagnostics = [];
  const kind = detectTiledDocumentKind(document);

  collectPropertyCompatibilityDiagnostics(document.properties, "$.properties", diagnostics);
  if (kind === MAP_KIND) {
    collectLayerCompatibilityDiagnostics(document.layers, "$.layers", diagnostics);
    for (let index = 0; index < (document.tilesets || []).length; index += 1) {
      const tileset = document.tilesets[index];
      if (isRecord(tileset) && !("source" in tileset)) {
        collectTilesetCompatibilityDiagnostics(tileset, `$.tilesets[${index}]`, diagnostics);
      }
    }
  } else if (kind === TILESET_KIND) {
    collectTilesetCompatibilityDiagnostics(document, "$", diagnostics, { includeRootProperties: false });
  }
  return diagnostics;
}

export function* tiledLayerEntries(document) {
  if (!isRecord(document) || !Array.isArray(document.layers)) return;
  yield* walkLayers(document.layers, "$.layers", null);
}

export function collectTiledReferences(value, options = {}) {
  const document = parsedDocumentValue(value);
  const sourcePath = options.sourcePath || value?.sourcePath
    ? normalizeTiledProjectPath(options.sourcePath || value.sourcePath)
    : null;
  const references = [];
  const push = (kind, reference, jsonPath) => {
    if (typeof reference !== "string") return;
    let resolvedPath = null;
    let error = null;
    try {
      if (sourcePath) resolvedPath = resolveTiledProjectReference(sourcePath, reference);
      else validateReferenceText(reference);
    } catch (caught) {
      error = caught.message;
    }
    references.push({ kind, reference, jsonPath, resolvedPath, error });
  };

  collectProperties(document.properties, "$.properties", push);
  if (detectTiledDocumentKind(document) === MAP_KIND) {
    collectLayerReferences(document.layers, "$.layers", push);
    for (let index = 0; index < (document.tilesets || []).length; index += 1) {
      const tileset = document.tilesets[index];
      if (!isRecord(tileset)) continue;
      const tilesetPath = `$.tilesets[${index}]`;
      if ("source" in tileset) push("tileset", tileset.source, `${tilesetPath}.source`);
      else collectTilesetReferences(tileset, tilesetPath, push);
    }
  } else {
    collectTilesetReferences(document, "$", push);
  }
  return references;
}

export function normalizeTiledProjectPath(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError("工程路径必须是非空相对路径");
  }
  return normalizeProjectSegments(value, { allowParent: false });
}

export function resolveTiledProjectReference(documentPath, reference) {
  const normalizedDocument = normalizeTiledProjectPath(documentPath);
  validateReferenceText(reference);
  const directorySegments = normalizedDocument.split("/").slice(0, -1);
  const referenceSegments = reference.replaceAll("\\", "/").split("/");
  const resolved = [...directorySegments];
  for (const segment of referenceSegments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) throw new TypeError("Tiled 资源路径不能离开工程目录");
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  if (!resolved.length) throw new TypeError("Tiled 资源路径必须指向工程内文件");
  return resolved.join("/");
}

export function relativeTiledProjectReference(sourcePath, targetProjectPath) {
  const normalizedSource = normalizeTiledReferenceInputPath(sourcePath, "Tiled 文档路径");
  const normalizedTarget = normalizeTiledReferenceInputPath(targetProjectPath, "目标资源路径");
  if (!/\.(?:tmj|tsj|world)$/iu.test(normalizedSource)) {
    throw new TypeError("Tiled 文档路径必须指向 .tmj、.tsj 或 .world 文件");
  }

  const sourceDirectory = normalizedSource.split("/").slice(0, -1);
  const targetSegments = normalizedTarget.split("/");
  let commonLength = 0;
  while (
    commonLength < sourceDirectory.length
    && commonLength < targetSegments.length
    && sourceDirectory[commonLength] === targetSegments[commonLength]
  ) {
    commonLength += 1;
  }

  const reference = [
    ...Array(sourceDirectory.length - commonLength).fill(".."),
    ...targetSegments.slice(commonLength),
  ].join("/");
  if (resolveTiledProjectReference(normalizedSource, reference) !== normalizedTarget) {
    throw new TypeError("无法生成安全的 Tiled 工程相对引用");
  }
  return reference;
}

function normalizeTiledReferenceInputPath(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new TypeError(`${label}必须是非空工程相对路径`);
  }
  if (value.includes("\\")) throw new TypeError(`${label}必须使用 POSIX 路径分隔符`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label}包含无效控制字符`);
  if (value.endsWith("/")) throw new TypeError(`${label}必须指向文件，不能指向目录`);
  return normalizeTiledProjectPath(value);
}

function validateMap(document, sourcePath, diagnostics) {
  validateNonNegativeInteger(document.width, "$.width", diagnostics);
  validateNonNegativeInteger(document.height, "$.height", diagnostics);
  validatePositiveInteger(document.tilewidth, "$.tilewidth", diagnostics);
  validatePositiveInteger(document.tileheight, "$.tileheight", diagnostics);
  validateMapProjection(document, diagnostics);
  if (!Array.isArray(document.layers)) {
    diagnostics.push(issue("error", "invalid-layers", "$.layers", "Tiled 地图 layers 必须是数组"));
  } else {
    validateLayers(document.layers, "$.layers", sourcePath, diagnostics);
  }
  if (!Array.isArray(document.tilesets)) {
    diagnostics.push(issue("error", "invalid-tilesets", "$.tilesets", "Tiled 地图 tilesets 必须是数组"));
    return;
  }
  for (let index = 0; index < document.tilesets.length; index += 1) {
    const tileset = document.tilesets[index];
    const jsonPath = `$.tilesets[${index}]`;
    if (!isRecord(tileset)) {
      diagnostics.push(issue("error", "invalid-tileset", jsonPath, "瓦片集条目必须是对象"));
      continue;
    }
    validatePositiveInteger(tileset.firstgid, `${jsonPath}.firstgid`, diagnostics);
    if ("source" in tileset) validateReference(tileset.source, `${jsonPath}.source`, sourcePath, diagnostics);
    else validateTileset(tileset, jsonPath, sourcePath, diagnostics, { embedded: true });
  }
}

function validateMapProjection(document, diagnostics) {
  if (typeof document.orientation !== "string" || !document.orientation) return;
  if (!KNOWN_MAP_ORIENTATIONS.has(document.orientation)) {
    diagnostics.push(issue(
      "warning",
      "unknown-map-orientation",
      "$.orientation",
      `保留未识别的地图方向 ${document.orientation}，查看器按正交坐标显示`,
    ));
    return;
  }
  if (["staggered", "hexagonal"].includes(document.orientation)) {
    if (!["x", "y"].includes(document.staggeraxis)) {
      diagnostics.push(issue("error", "invalid-stagger-axis", "$.staggeraxis", "交错或六边形地图 staggeraxis 必须是 x 或 y"));
    }
    if (!["odd", "even"].includes(document.staggerindex)) {
      diagnostics.push(issue("error", "invalid-stagger-index", "$.staggerindex", "交错或六边形地图 staggerindex 必须是 odd 或 even"));
    }
  }
  if (document.orientation === "hexagonal") {
    validateNonNegativeInteger(document.hexsidelength, "$.hexsidelength", diagnostics);
    const maximum = document.staggeraxis === "x" ? Number(document.tilewidth) : Number(document.tileheight);
    if (Number.isSafeInteger(document.hexsidelength) && Number.isFinite(maximum) && document.hexsidelength > maximum) {
      diagnostics.push(issue("error", "invalid-hex-side-length", "$.hexsidelength", "六边形边长不能超过交错轴对应的瓦片尺寸"));
    }
  }
  if (document.orientation === "oblique") {
    const skewX = document.skewx === undefined ? 0 : document.skewx;
    const skewY = document.skewy === undefined ? 0 : document.skewy;
    if (!Number.isSafeInteger(skewX)) diagnostics.push(issue("error", "invalid-oblique-skew", "$.skewx", "oblique 地图 skewx 必须是整数"));
    if (!Number.isSafeInteger(skewY)) diagnostics.push(issue("error", "invalid-oblique-skew", "$.skewy", "oblique 地图 skewy 必须是整数"));
    const determinant = 1 - Number(skewX) / Number(document.tileheight) * Number(skewY) / Number(document.tilewidth);
    if (Number.isFinite(determinant) && Math.abs(determinant) < Number.EPSILON) {
      diagnostics.push(issue("error", "singular-oblique-projection", "$.orientation", "oblique 地图投影不可逆"));
    }
  }
}

function validateTileset(tileset, jsonPath, sourcePath, diagnostics, options = {}) {
  if (!options.embedded && tileset.type !== TILESET_KIND) {
    diagnostics.push(issue("error", "invalid-tileset-type", `${jsonPath}.type`, "外部瓦片集 type 必须是 tileset"));
  }
  validateProperties(tileset.properties, `${jsonPath}.properties`, sourcePath, diagnostics);
  if ("tilewidth" in tileset) validatePositiveInteger(tileset.tilewidth, `${jsonPath}.tilewidth`, diagnostics);
  if ("tileheight" in tileset) validatePositiveInteger(tileset.tileheight, `${jsonPath}.tileheight`, diagnostics);
  if ("margin" in tileset) validateNonNegativeInteger(tileset.margin, `${jsonPath}.margin`, diagnostics);
  if ("spacing" in tileset) validateNonNegativeInteger(tileset.spacing, `${jsonPath}.spacing`, diagnostics);
  if ("tilecount" in tileset) validateNonNegativeInteger(tileset.tilecount, `${jsonPath}.tilecount`, diagnostics);
  if ("columns" in tileset) validateNonNegativeInteger(tileset.columns, `${jsonPath}.columns`, diagnostics);
  if ("imagewidth" in tileset) validatePositiveInteger(tileset.imagewidth, `${jsonPath}.imagewidth`, diagnostics);
  if ("imageheight" in tileset) validatePositiveInteger(tileset.imageheight, `${jsonPath}.imageheight`, diagnostics);
  if ("image" in tileset) validateImageReference(tileset.image, `${jsonPath}.image`, sourcePath, diagnostics);
  if (tileset.tiles === undefined) return;
  if (!Array.isArray(tileset.tiles)) {
    diagnostics.push(issue("error", "invalid-tiles", `${jsonPath}.tiles`, "瓦片集 tiles 必须是数组"));
    return;
  }
  const tileIds = new Map();
  for (let index = 0; index < tileset.tiles.length; index += 1) {
    const tile = tileset.tiles[index];
    const tilePath = `${jsonPath}.tiles[${index}]`;
    if (!isRecord(tile)) {
      diagnostics.push(issue("error", "invalid-tile", tilePath, "瓦片定义必须是对象"));
      continue;
    }
    validateNonNegativeInteger(tile.id, `${tilePath}.id`, diagnostics);
    if (Number.isSafeInteger(tile.id) && tile.id >= 0) {
      const previousPath = tileIds.get(tile.id);
      if (previousPath) {
        diagnostics.push(issue(
          "error",
          "duplicate-tile-id",
          `${tilePath}.id`,
          `瓦片 ID ${tile.id} 与 ${previousPath} 重复`,
        ));
      } else {
        tileIds.set(tile.id, `${tilePath}.id`);
      }
    }
    validateProperties(tile.properties, `${tilePath}.properties`, sourcePath, diagnostics);
    if ("image" in tile) {
      validateImageReference(tile.image, `${tilePath}.image`, sourcePath, diagnostics);
      if ("imagewidth" in tile) validatePositiveInteger(tile.imagewidth, `${tilePath}.imagewidth`, diagnostics);
      if ("imageheight" in tile) validatePositiveInteger(tile.imageheight, `${tilePath}.imageheight`, diagnostics);
    }
    if (tile.animation !== undefined) validateTileAnimation(tile.animation, `${tilePath}.animation`, diagnostics);
    if (tile.objectgroup !== undefined) {
      validateLayer(tile.objectgroup, `${tilePath}.objectgroup`, sourcePath, diagnostics);
    }
  }
}

function validateTileAnimation(animation, jsonPath, diagnostics) {
  if (!Array.isArray(animation) || !animation.length) {
    diagnostics.push(issue("error", "invalid-tile-animation", jsonPath, "瓦片动画必须是非空数组"));
    return;
  }
  for (let index = 0; index < animation.length; index += 1) {
    const frame = animation[index];
    const framePath = `${jsonPath}[${index}]`;
    if (!isRecord(frame)) {
      diagnostics.push(issue("error", "invalid-animation-frame", framePath, "瓦片动画帧必须是对象"));
      continue;
    }
    validateNonNegativeInteger(frame.tileid, `${framePath}.tileid`, diagnostics);
    validatePositiveInteger(frame.duration, `${framePath}.duration`, diagnostics);
  }
}

function validateLayers(layers, jsonPath, sourcePath, diagnostics) {
  for (let index = 0; index < layers.length; index += 1) {
    validateLayer(layers[index], `${jsonPath}[${index}]`, sourcePath, diagnostics);
  }
}

function validateLayer(layer, jsonPath, sourcePath, diagnostics) {
  if (!isRecord(layer)) {
    diagnostics.push(issue("error", "invalid-layer", jsonPath, "图层必须是对象"));
    return;
  }
  if (typeof layer.type !== "string" || !layer.type) {
    diagnostics.push(issue("error", "missing-layer-type", `${jsonPath}.type`, "图层必须声明 type"));
  } else if (!KNOWN_LAYER_TYPES.has(layer.type)) {
    diagnostics.push(issue("warning", "unknown-layer-type", `${jsonPath}.type`, `保留未识别的图层类型 ${layer.type}`));
  }
  validateProperties(layer.properties, `${jsonPath}.properties`, sourcePath, diagnostics);

  if (layer.type === "group") {
    if (!Array.isArray(layer.layers)) {
      diagnostics.push(issue("error", "invalid-group-layers", `${jsonPath}.layers`, "分组图层 layers 必须是数组"));
    } else {
      validateLayers(layer.layers, `${jsonPath}.layers`, sourcePath, diagnostics);
    }
  } else if (layer.type === "imagelayer") {
    validateImageReference(layer.image, `${jsonPath}.image`, sourcePath, diagnostics);
  } else if (layer.type === "objectgroup") {
    if (!Array.isArray(layer.objects)) {
      diagnostics.push(issue("error", "invalid-objects", `${jsonPath}.objects`, "对象层 objects 必须是数组"));
    } else {
      for (let index = 0; index < layer.objects.length; index += 1) {
        const object = layer.objects[index];
        const objectPath = `${jsonPath}.objects[${index}]`;
        if (!isRecord(object)) {
          diagnostics.push(issue("error", "invalid-object", objectPath, "地图对象必须是对象"));
          continue;
        }
        validateProperties(object.properties, `${objectPath}.properties`, sourcePath, diagnostics);
        if ("template" in object) validateReference(object.template, `${objectPath}.template`, sourcePath, diagnostics);
      }
    }
  } else if (layer.type === "tilelayer") {
    const finiteData = Array.isArray(layer.data);
    const chunkData = Array.isArray(layer.chunks);
    if (!finiteData && !chunkData && typeof layer.data !== "string") {
      diagnostics.push(issue("error", "missing-tile-data", jsonPath, "瓦片层必须包含 data 或 chunks"));
    }
    if (chunkData) {
      for (let index = 0; index < layer.chunks.length; index += 1) {
        const chunk = layer.chunks[index];
        const chunkPath = `${jsonPath}.chunks[${index}]`;
        if (!isRecord(chunk) || (!Array.isArray(chunk.data) && typeof chunk.data !== "string")) {
          diagnostics.push(issue("error", "invalid-tile-chunk", chunkPath, "无限地图分块必须包含瓦片 data"));
        }
      }
    }
  }

  if (layer.type !== "group" && Array.isArray(layer.layers)) {
    validateLayers(layer.layers, `${jsonPath}.layers`, sourcePath, diagnostics);
  }
}

function collectLayerCompatibilityDiagnostics(layers, jsonPath, diagnostics) {
  if (!Array.isArray(layers)) return;
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (!isRecord(layer)) continue;
    const layerPath = `${jsonPath}[${index}]`;
    collectPropertyCompatibilityDiagnostics(layer.properties, `${layerPath}.properties`, diagnostics);
    if (layer.mode && !KNOWN_LAYER_BLEND_MODES.has(layer.mode)) {
      diagnostics.push(compatibilityIssue(
        "layer-blend-mode",
        `${layerPath}.mode`,
        `图层 ${layer.name || layer.id || index + 1} 的 mode=${layer.mode} 已保留；当前查看器将按 normal 显示`,
        { render: TILED_SUPPORT_LEVELS.preserveOnly, edit: TILED_SUPPORT_LEVELS.preserveOnly },
      ));
    }
    if (layer.type === "imagelayer" && layer.transparentcolor !== undefined) {
      diagnostics.push(compatibilityIssue(
        "image-layer-transparent-color",
        `${layerPath}.transparentcolor`,
        `图像层 ${layer.name || layer.id || index + 1} 的 transparentcolor 已保留；当前查看器尚未应用透明色`,
        { render: TILED_SUPPORT_LEVELS.preserveOnly, edit: TILED_SUPPORT_LEVELS.preserveOnly },
      ));
    }
    if (layer.type === "objectgroup" && Array.isArray(layer.objects)) {
      for (let objectIndex = 0; objectIndex < layer.objects.length; objectIndex += 1) {
        collectObjectCompatibilityDiagnostics(
          layer.objects[objectIndex],
          `${layerPath}.objects[${objectIndex}]`,
          diagnostics,
        );
      }
    }
    collectLayerCompatibilityDiagnostics(layer.layers, `${layerPath}.layers`, diagnostics);
  }
}

function collectObjectCompatibilityDiagnostics(object, jsonPath, diagnostics) {
  if (!isRecord(object)) return;
  collectPropertyCompatibilityDiagnostics(object.properties, `${jsonPath}.properties`, diagnostics);
  if (object.template !== undefined) {
    diagnostics.push(compatibilityIssue(
      "object-template-instance",
      `${jsonPath}.template`,
      `对象 ${object.name || object.id || "未命名"} 的模板引用已保留；当前查看器尚未解析模板继承`,
      { render: TILED_SUPPORT_LEVELS.preserveOnly, edit: TILED_SUPPORT_LEVELS.preserveOnly },
    ));
  }
}

function collectTilesetCompatibilityDiagnostics(tileset, jsonPath, diagnostics, options = {}) {
  if (!isRecord(tileset)) return;
  if (options.includeRootProperties !== false) {
    collectPropertyCompatibilityDiagnostics(tileset.properties, `${jsonPath}.properties`, diagnostics);
  }
  if (Array.isArray(tileset.wangsets) && tileset.wangsets.length) {
    diagnostics.push(compatibilityIssue(
      "tileset-wang-sets",
      `${jsonPath}.wangsets`,
      "Terrain/Wang Set、颜色、wangid 和 Terrain Brush 可编辑；颜色自定义属性等高级字段当前原样保留",
      { render: TILED_SUPPORT_LEVELS.notApplicable, edit: TILED_SUPPORT_LEVELS.partial },
    ));
  }
  if (Array.isArray(tileset.terrains) && tileset.terrains.length) {
    diagnostics.push(compatibilityIssue(
      "tileset-legacy-terrains",
      `${jsonPath}.terrains`,
      "瓦片集旧版 Terrain 数据已保留；当前编辑器尚未提供 Terrain 绘制和编辑",
      { render: TILED_SUPPORT_LEVELS.notApplicable, edit: TILED_SUPPORT_LEVELS.preserveOnly },
    ));
  }
  for (let index = 0; index < (tileset.tiles || []).length; index += 1) {
    const tile = tileset.tiles[index];
    if (!isRecord(tile)) continue;
    const tilePath = `${jsonPath}.tiles[${index}]`;
    collectPropertyCompatibilityDiagnostics(tile.properties, `${tilePath}.properties`, diagnostics);
    if (isRecord(tile.objectgroup)) {
      diagnostics.push(compatibilityIssue(
        "tile-collision-object-group",
        `${tilePath}.objectgroup`,
        `瓦片 ${tile.id ?? index} 的碰撞几何可编辑；对象自定义属性和图层级高级字段当前原样保留`,
        { render: TILED_SUPPORT_LEVELS.notApplicable, edit: TILED_SUPPORT_LEVELS.partial },
      ));
      collectPropertyCompatibilityDiagnostics(tile.objectgroup.properties, `${tilePath}.objectgroup.properties`, diagnostics);
    }
  }
}

function collectPropertyCompatibilityDiagnostics(properties, jsonPath, diagnostics) {
  if (!Array.isArray(properties)) return;
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];
    if (!isRecord(property)) continue;
    if (property.type === "list") {
      diagnostics.push(compatibilityIssue(
        "list-property",
        `${jsonPath}[${index}]`,
        `List 属性 ${property.name || index + 1} 已保留；当前属性面板尚未提供列表编辑器`,
        { render: TILED_SUPPORT_LEVELS.notApplicable, edit: TILED_SUPPORT_LEVELS.preserveOnly },
      ));
    }
  }
}

function compatibilityIssue(feature, path, message, support) {
  return {
    severity: "warning",
    code: "tiled-feature-preserved-only",
    feature,
    path,
    message,
    support: {
      parse: TILED_SUPPORT_LEVELS.full,
      render: TILED_SUPPORT_LEVELS.notApplicable,
      edit: TILED_SUPPORT_LEVELS.preserveOnly,
      save: TILED_SUPPORT_LEVELS.full,
      ...support,
    },
  };
}

function validateProperties(properties, jsonPath, sourcePath, diagnostics) {
  if (properties === undefined) return;
  if (!Array.isArray(properties)) {
    diagnostics.push(issue("error", "invalid-properties", jsonPath, "Tiled properties 必须是数组"));
    return;
  }
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];
    const propertyPath = `${jsonPath}[${index}]`;
    if (!isRecord(property)) {
      diagnostics.push(issue("error", "invalid-property", propertyPath, "Tiled 属性必须是对象"));
      continue;
    }
    if (property.type === "file") {
      validateReference(property.value, `${propertyPath}.value`, sourcePath, diagnostics);
    }
  }
}

function validateImageReference(reference, jsonPath, sourcePath, diagnostics) {
  if (typeof reference === "string" && /^data:/iu.test(reference)) {
    diagnostics.push(issue("error", "embedded-image", jsonPath, "图片必须使用工程相对路径，不能嵌入 Base64 或 data URI"));
    return;
  }
  validateReference(reference, jsonPath, sourcePath, diagnostics);
}

function validateReference(reference, jsonPath, sourcePath, diagnostics) {
  try {
    validateReferenceText(reference);
    if (sourcePath) resolveTiledProjectReference(sourcePath, reference);
  } catch (error) {
    diagnostics.push(issue("error", "invalid-reference", jsonPath, error.message));
  }
}

function validateReferenceText(reference) {
  if (typeof reference !== "string" || !reference || reference !== reference.trim()) {
    throw new TypeError("Tiled 资源引用必须是非空相对路径");
  }
  if (/[\u0000-\u001f\u007f]/u.test(reference)) throw new TypeError("Tiled 资源路径包含无效控制字符");
  const normalized = reference.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("//")
    || /^[a-z]:\//iu.test(normalized)
    || /^[a-z][a-z0-9+.-]*:/iu.test(normalized)
  ) {
    throw new TypeError("Tiled 资源必须使用工程相对路径");
  }
}

function normalizeProjectSegments(value, options) {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("//")
    || /^[a-z]:\//iu.test(normalized)
    || /^[a-z][a-z0-9+.-]*:/iu.test(normalized)
  ) throw new TypeError("工程路径必须是相对路径");
  const result = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!options.allowParent || !result.length) throw new TypeError("工程路径不能离开工程目录");
      result.pop();
    } else {
      result.push(segment);
    }
  }
  if (!result.length) throw new TypeError("工程路径必须指向文件");
  return result.join("/");
}

function* walkLayers(layers, jsonPath, parent) {
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    const path = `${jsonPath}[${index}]`;
    if (!isRecord(layer)) continue;
    const entry = { layer, path, parent };
    yield entry;
    if (Array.isArray(layer.layers)) yield* walkLayers(layer.layers, `${path}.layers`, entry);
  }
}

function collectLayerReferences(layers, jsonPath, push) {
  if (!Array.isArray(layers)) return;
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (!isRecord(layer)) continue;
    const layerPath = `${jsonPath}[${index}]`;
    collectProperties(layer.properties, `${layerPath}.properties`, push);
    if (layer.type === "imagelayer") push("image", layer.image, `${layerPath}.image`);
    if (Array.isArray(layer.objects)) {
      for (let objectIndex = 0; objectIndex < layer.objects.length; objectIndex += 1) {
        const object = layer.objects[objectIndex];
        if (!isRecord(object)) continue;
        const objectPath = `${layerPath}.objects[${objectIndex}]`;
        collectProperties(object.properties, `${objectPath}.properties`, push);
        if ("template" in object) push("template", object.template, `${objectPath}.template`);
      }
    }
    collectLayerReferences(layer.layers, `${layerPath}.layers`, push);
  }
}

function collectTilesetReferences(tileset, jsonPath, push) {
  collectProperties(tileset.properties, `${jsonPath}.properties`, push);
  if ("image" in tileset) push("image", tileset.image, `${jsonPath}.image`);
  if (!Array.isArray(tileset.tiles)) return;
  for (let index = 0; index < tileset.tiles.length; index += 1) {
    const tile = tileset.tiles[index];
    if (!isRecord(tile)) continue;
    const tilePath = `${jsonPath}.tiles[${index}]`;
    collectProperties(tile.properties, `${tilePath}.properties`, push);
    if ("image" in tile) push("image", tile.image, `${tilePath}.image`);
    if (isRecord(tile.objectgroup)) {
      collectLayerReferences([tile.objectgroup], `${tilePath}.objectgroup`, push);
    }
  }
}

function collectProperties(properties, jsonPath, push) {
  if (!Array.isArray(properties)) return;
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];
    if (isRecord(property) && property.type === "file") {
      push("file-property", property.value, `${jsonPath}[${index}].value`);
    }
  }
}

function validatePositiveInteger(value, jsonPath, diagnostics) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    diagnostics.push(issue("error", "invalid-positive-integer", jsonPath, `${jsonPath} 必须是正整数`));
  }
}

function validateNonNegativeInteger(value, jsonPath, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 0) {
    diagnostics.push(issue("error", "invalid-non-negative-integer", jsonPath, `${jsonPath} 必须是非负整数`));
  }
}

function decodeSource(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (source instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(source));
  throw new TypeError("Tiled 文档源必须是字符串、Uint8Array 或 ArrayBuffer");
}

function parsedDocumentValue(value) {
  if (isRecord(value) && isRecord(value.document) && typeof value.kind === "string") return value.document;
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(severity, code, path, message) {
  return { severity, code, path, message };
}
