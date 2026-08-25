/**
 * Tiled object template helpers.
 *
 * A .tx file stores one object and uses the template file's directory as the
 * base for file properties.  These helpers keep the source JSON untouched,
 * merge template defaults with instance overrides, and rewrite only the
 * explicitly relative file references when an instance crosses directories.
 */

export class TiledTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TiledTemplateError";
    this.code = code;
  }
}

const PROPERTY_TYPES = new Set([
  "bool", "color", "file", "float", "int", "object", "string", "class", "enum", "list",
]);

export function parseTiledTemplate(document, { sourcePath = "" } = {}) {
  if (!isRecord(document) || document.type !== "template" || !isRecord(document.object)) {
    throw templateError("TILED_TEMPLATE_INVALID", "Tiled 模板必须包含 type=template 和 object");
  }
  const object = cloneJsonValue(document.object);
  if (!Number.isSafeInteger(object.id) || object.id < 1) {
    throw templateError("TILED_TEMPLATE_OBJECT_ID_INVALID", "Tiled 模板对象 ID 无效");
  }
  if (object.template !== undefined && typeof object.template !== "string") {
    throw templateError("TILED_TEMPLATE_REFERENCE_INVALID", "Tiled 模板继承引用必须是字符串");
  }
  validateProperties(object.properties, "object.properties");
  const tileset = document.tileset === undefined
    ? null
    : normalizeParsedTemplateTileset(document.tileset);
  return Object.freeze({
    type: "template",
    sourcePath: normalizeTemplatePath(sourcePath),
    object: freezeJson(object),
    tileset: tileset ? freezeJson(tileset) : null,
    raw: freezeJson(cloneJsonValue(document)),
  });
}

export function materializeTiledTemplate(template, override = {}, options = {}) {
  const normalized = normalizeTemplate(template);
  if (!isRecord(override)) throw templateError("TILED_TEMPLATE_OVERRIDE_INVALID", "模板实例覆盖值必须是对象");
  const merged = mergeTiledTemplateObject(normalized.object, override);
  const id = Number.isSafeInteger(options.id) && options.id > 0 ? options.id : merged.id;
  const x = options.x === undefined ? merged.x : finiteNumber(options.x, "x");
  const y = options.y === undefined ? merged.y : finiteNumber(options.y, "y");
  merged.id = id;
  merged.x = x;
  merged.y = y;
  if (options.templatePath || normalized.sourcePath) {
    const sourcePath = normalizeTemplatePath(options.templatePath || normalized.sourcePath);
    const targetPath = normalizeRelativeDocumentPath(options.targetPath || "");
    merged.template = relativeReference(targetPath, sourcePath);
  }
  return cloneJsonValue(merged);
}

export function mergeTiledTemplateObject(templateObject, override = {}) {
  if (!isRecord(templateObject) || !isRecord(override)) {
    throw templateError("TILED_TEMPLATE_OBJECT_INVALID", "模板对象和实例覆盖值必须是对象");
  }
  const merged = cloneJsonValue(templateObject);
  for (const [key, value] of Object.entries(override)) {
    if (key === "id") continue;
    if (key === "properties") {
      merged.properties = mergeProperties(merged.properties, value);
      continue;
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = { ...cloneJsonValue(merged[key]), ...cloneJsonValue(value) };
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

export function unbindTiledTemplate(template, override = {}, options = {}) {
  const materialized = materializeTiledTemplate(template, override, options);
  delete materialized.template;
  return materialized;
}

/**
 * Convert a map object into a standalone Tiled .tx document.
 *
 * Tiled template objects have their own stable id (1) and do not carry the
 * instance position or template back-reference. File properties are stored
 * relative to the template file, so references are rewritten through the
 * project-relative path rather than string concatenation.
 */
export function createTiledTemplateDocument(object, {
  sourcePath = "",
  templatePath = "",
  tileset = undefined,
} = {}) {
  if (!isRecord(object)) throw templateError("TILED_TEMPLATE_OBJECT_INVALID", "要保存的模板对象无效");
  const normalizedTemplatePath = normalizeTemplatePath(templatePath);
  const normalizedSourcePath = normalizeRelativeDocumentPath(sourcePath);
  if (!normalizedTemplatePath) {
    throw templateError("TILED_TEMPLATE_PATH_REQUIRED", "保存模板需要工程相对 .tx 路径");
  }
  const templateObject = cloneJsonValue(object);
  delete templateObject.template;
  delete templateObject.x;
  delete templateObject.y;
  // A template's object id is local to the .tx file and must be stable.
  templateObject.id = 1;
  rewriteFileProperties(templateObject, normalizedSourcePath, normalizedTemplatePath);
  const document = { type: "template", object: templateObject };
  if (tileset !== undefined) {
    document.tileset = normalizeTemplateTileset(tileset);
  }
  // Validate the generated document before handing it to a transport layer.
  parseTiledTemplate(document, { sourcePath: normalizedTemplatePath });
  return document;
}

/**
 * Build a standalone Tiled template document for a tile object.  Tiled stores
 * the tileset on the template root and expects the object's GID to be local
 * to that tileset (the firstgid is therefore always 1 in a .tx file).  Flip
 * flags remain in the upper four bits and are copied unchanged.
 */
export function createTiledTileObjectTemplateDocument(object, {
  sourcePath = "",
  templatePath = "",
  sourceTileset = null,
} = {}) {
  if (!isRecord(object) || !Number.isSafeInteger(Number(object.gid)) || Number(object.gid) <= 0) {
    throw templateError("TILED_TEMPLATE_TILE_OBJECT_INVALID", "瓦片对象必须包含有效的 gid");
  }
  if (!isRecord(sourceTileset) || !Number.isSafeInteger(sourceTileset.firstgid) || sourceTileset.firstgid < 1) {
    throw templateError("TILED_TEMPLATE_TILESET_INVALID", "瓦片对象缺少有效的来源瓦片集");
  }
  if (!Number.isSafeInteger(sourceTileset.maxLocalId) || sourceTileset.maxLocalId < 0) {
    throw templateError("TILED_TEMPLATE_TILESET_RANGE_INVALID", "来源瓦片集缺少有效的瓦片范围");
  }
  const encoded = Number(object.gid) >>> 0;
  const flags = encoded & 0xf000_0000;
  const globalGid = encoded & 0x0fff_ffff;
  const localId = globalGid - sourceTileset.firstgid;
  if (localId < 0 || localId > sourceTileset.maxLocalId) {
    throw templateError("TILED_TEMPLATE_TILE_GID_UNMAPPED", "瓦片对象 gid 不属于来源瓦片集范围");
  }
  const templateObject = cloneJsonValue(object);
  templateObject.gid = (flags | (localId + 1)) >>> 0;
  const definition = sourceTileset.definition || sourceTileset;
  const sourceTilesetPath = typeof sourceTileset.sourcePath === "string" && sourceTileset.sourcePath
    ? sourceTileset.sourcePath
    : null;
  const templateTileset = sourceTilesetPath
    ? {
      firstgid: 1,
      source: relativeReference(
        normalizeTemplatePath(templatePath),
        normalizeRelativeDocumentPath(sourceTilesetPath),
      ),
    }
    : {
      ...cloneJsonValue(definition),
      firstgid: 1,
    };
  return createTiledTemplateDocument(templateObject, {
    sourcePath,
    templatePath,
    tileset: templateTileset,
  });
}

export function serializeTiledTemplateDocument(object, options = {}) {
  return `${JSON.stringify(createTiledTemplateDocument(object, options), null, 2)}\n`;
}

export function compactTiledTemplateInstance(template, effectiveObject, options = {}) {
  const normalized = normalizeTemplate(template);
  if (!isRecord(effectiveObject)) {
    throw templateError("TILED_TEMPLATE_OBJECT_INVALID", "模板实例对象无效");
  }
  const compact = {};
  for (const key of ["id", "x", "y"]) {
    if (effectiveObject[key] !== undefined) compact[key] = cloneJsonValue(effectiveObject[key]);
  }
  const reference = options.templateReference || effectiveObject.template;
  if (typeof reference === "string" && reference) compact.template = reference;
  for (const [key, value] of Object.entries(effectiveObject)) {
    if (["id", "x", "y", "template", "properties"].includes(key)) continue;
    if (!jsonEqual(value, normalized.object[key])) compact[key] = cloneJsonValue(value);
  }
  const properties = compactTemplateProperties(normalized.object.properties, effectiveObject.properties);
  if (properties.length) compact.properties = properties;
  return compact;
}

export function refreshTiledTemplateInstance(previousTemplate, nextTemplate, effectiveObject, options = {}) {
  const overrides = compactTiledTemplateInstance(previousTemplate, effectiveObject, options);
  return materializeTiledTemplate(nextTemplate, overrides, {
    id: effectiveObject.id,
    x: effectiveObject.x,
    y: effectiveObject.y,
    targetPath: options.targetPath,
    templatePath: options.templatePath,
  });
}

function compactTemplateProperties(templateProperties, effectiveProperties) {
  const defaults = new Map((Array.isArray(templateProperties) ? templateProperties : [])
    .filter((property) => isRecord(property) && typeof property.name === "string")
    .map((property) => [property.name, property]));
  const result = [];
  for (const property of Array.isArray(effectiveProperties) ? effectiveProperties : []) {
    if (!isRecord(property) || typeof property.name !== "string") continue;
    if (!jsonEqual(defaults.get(property.name), property)) result.push(cloneJsonValue(property));
  }
  return result;
}

function rewriteFileProperties(value, sourcePath, templatePath) {
  if (Array.isArray(value)) {
    for (const item of value) rewriteFileProperties(item, sourcePath, templatePath);
    return;
  }
  if (!isRecord(value)) return;
  if (String(value.type || "").toLowerCase() === "file" && typeof value.value === "string") {
    value.value = rewriteFileReference(value.value, sourcePath, templatePath);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "value" || String(value.type || "").toLowerCase() !== "file") {
      rewriteFileProperties(child, sourcePath, templatePath);
    }
  }
}

function rewriteFileReference(value, sourcePath, templatePath) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || (segment.startsWith(".") && segment !== "." && segment !== ".."))) {
    // Keep a malformed value intact; the server-side project validator will
    // report it instead of silently changing user data.
    return value;
  }
  const sourceDirectory = sourcePath ? sourcePath.split("/").slice(0, -1).join("/") : "";
  const templateDirectory = templatePath.split("/").slice(0, -1).join("/");
  const absoluteSegments = [...(sourceDirectory ? sourceDirectory.split("/") : []), ...segments];
  const compact = [];
  for (const segment of absoluteSegments) {
    if (segment === "..") {
      if (!compact.length) return value;
      compact.pop();
    }
    else if (segment !== ".") compact.push(segment);
  }
  if (!compact.length || compact.some((segment) => segment.startsWith("."))) return value;
  const targetSegments = templateDirectory ? templateDirectory.split("/") : [];
  let common = 0;
  while (common < targetSegments.length && common < compact.length && targetSegments[common] === compact[common]) common += 1;
  const up = targetSegments.slice(common).map(() => "..");
  const down = compact.slice(common);
  return [...up, ...down].join("/") || compact.at(-1);
}

export function templateObjectBounds(template, override = {}) {
  const object = materializeTiledTemplate(template, override);
  return Object.freeze({
    x: finiteNumber(object.x, "x"),
    y: finiteNumber(object.y, "y"),
    width: Math.max(0, finiteNumber(object.width, "width")),
    height: Math.max(0, finiteNumber(object.height, "height")),
  });
}

function normalizeTemplate(value) {
  if (value?.type === "template" && value.object) return value;
  return parseTiledTemplate(value);
}

function normalizeTemplateTileset(value) {
  if (!isRecord(value)) throw templateError("TILED_TEMPLATE_TILESET_INVALID", "模板瓦片集必须是对象");
  const result = cloneJsonValue(value);
  if (!Number.isSafeInteger(result.firstgid) || result.firstgid < 1) {
    result.firstgid = 1;
  }
  if (result.source !== undefined && (typeof result.source !== "string" || !result.source
    || result.source.startsWith("/") || result.source.includes("\\")
    || /^[a-z][a-z0-9+.-]*:/iu.test(result.source))) {
    throw templateError("TILED_TEMPLATE_TILESET_SOURCE_INVALID", "模板瓦片集 source 必须是工程相对引用");
  }
  return result;
}

function normalizeParsedTemplateTileset(value) {
  if (!isRecord(value)) throw templateError("TILED_TEMPLATE_TILESET_INVALID", "模板瓦片集必须是对象");
  const result = cloneJsonValue(value);
  if (!Number.isSafeInteger(result.firstgid) || result.firstgid < 1 || result.firstgid > 0x0fff_ffff) {
    throw templateError("TILED_TEMPLATE_TILESET_FIRSTGID_INVALID", "模板瓦片集 firstgid 无效");
  }
  if (result.source !== undefined && (typeof result.source !== "string" || !result.source
    || result.source.startsWith("/") || result.source.includes("\\")
    || /^[a-z][a-z0-9+.-]*:/iu.test(result.source))) {
    throw templateError("TILED_TEMPLATE_TILESET_SOURCE_INVALID", "模板瓦片集 source 必须是工程相对引用");
  }
  return result;
}

function mergeProperties(templateProperties, overrideProperties) {
  const base = Array.isArray(templateProperties) ? cloneJsonValue(templateProperties) : [];
  if (overrideProperties === undefined) return base;
  if (!Array.isArray(overrideProperties)) {
    throw templateError("TILED_TEMPLATE_PROPERTIES_INVALID", "模板属性覆盖值必须是数组");
  }
  const byName = new Map(base.map((property, index) => [String(property?.name || `#${index}`), index]));
  for (const property of overrideProperties) {
    if (!isRecord(property) || typeof property.name !== "string" || !property.name) {
      throw templateError("TILED_TEMPLATE_PROPERTY_INVALID", "模板属性覆盖项无效");
    }
    const index = byName.get(property.name);
    if (index === undefined) {
      byName.set(property.name, base.length);
      base.push(cloneJsonValue(property));
    } else {
      base[index] = { ...base[index], ...cloneJsonValue(property) };
    }
  }
  return base;
}

function validateProperties(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw templateError("TILED_TEMPLATE_PROPERTIES_INVALID", `${label} 必须是数组`);
  for (const [index, property] of value.entries()) {
    if (!isRecord(property) || typeof property.name !== "string" || !property.name) {
      throw templateError("TILED_TEMPLATE_PROPERTY_INVALID", `${label}[${index}] 无效`);
    }
    if (property.type !== undefined && !PROPERTY_TYPES.has(String(property.type).toLowerCase())) {
      throw templateError("TILED_TEMPLATE_PROPERTY_TYPE_INVALID", `${label}[${index}] 类型无效`);
    }
  }
}

function relativeReference(targetPath, sourcePath) {
  if (!sourcePath) throw templateError("TILED_TEMPLATE_PATH_REQUIRED", "模板实例需要模板工程相对路径");
  const targetDirectory = targetPath ? targetPath.split("/").slice(0, -1).join("/") : "";
  const targetSegments = targetDirectory ? targetDirectory.split("/") : [];
  const sourceSegments = sourcePath.split("/");
  let common = 0;
  while (common < targetSegments.length && common < sourceSegments.length - 1
    && targetSegments[common] === sourceSegments[common]) common += 1;
  const up = targetSegments.slice(common).map(() => "..");
  const down = sourceSegments.slice(common);
  return [...up, ...down].join("/") || sourceSegments.at(-1);
}

function normalizeTemplatePath(value) {
  if (value === "") return "";
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw templateError("TILED_TEMPLATE_PATH_INVALID", "模板路径必须使用工程相对路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw templateError("TILED_TEMPLATE_PATH_INVALID", "模板路径不能包含越界或隐藏路径");
  }
  if (!value.toLowerCase().endsWith(".tx")) {
    throw templateError("TILED_TEMPLATE_PATH_INVALID", "模板路径必须以 .tx 结尾");
  }
  return segments.join("/");
}

function normalizeRelativeDocumentPath(value) {
  if (value === "") return "";
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw templateError("TILED_TEMPLATE_PATH_INVALID", "地图文档路径必须使用工程相对路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw templateError("TILED_TEMPLATE_PATH_INVALID", "地图文档路径不能包含越界或隐藏路径");
  }
  return segments.join("/");
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw templateError("TILED_TEMPLATE_NUMBER_INVALID", `${label} 必须是有限数字`);
  return number;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeJson(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) value.forEach(freezeJson);
  else Object.values(value).forEach(freezeJson);
  return Object.freeze(value);
}

function templateError(code, message) {
  return new TiledTemplateError(code, message);
}
