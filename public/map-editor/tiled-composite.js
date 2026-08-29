import {
  relativeTiledProjectReference,
  resolveTiledProjectReference,
} from "./tiled-document.js?v=0.44.64";

export class TiledCompositeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TiledCompositeError";
    this.code = code;
  }
}

/**
 * Build a standalone map document from selected root layers. The document
 * keeps the original map's rendering semantics and unknown fields, while
 * removing unselected layers. Import code can later remap IDs in one undo
 * operation without changing this reusable source asset.
 */
export function createCompositeMapDocument(document, selectedLayerIds = [], options = {}) {
  if (!isRecord(document) || document.type !== "map" || !Array.isArray(document.layers)) {
    throw compositeError("TILED_COMPOSITE_MAP_INVALID", "组合素材源必须是 Tiled map 文档");
  }
  const ids = new Set(selectedLayerIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
  if (!ids.size) throw compositeError("TILED_COMPOSITE_SELECTION_EMPTY", "至少选择一个图层才能保存组合素材");
  const selected = selectRootLayers(document.layers, ids);
  if (!selected.length) throw compositeError("TILED_COMPOSITE_SELECTION_EMPTY", "选择的图层不存在或已被包含");
  const result = cloneJsonValue(document);
  result.layers = selected;
  if (options.sourcePath && options.targetPath && options.sourcePath !== options.targetPath) {
    rewriteCompositeReferences(result, options.sourcePath, options.targetPath);
  }
  return result;
}

export function compositeDependencies(document, sourcePath) {
  if (!isRecord(document) || document.type !== "map") {
    throw compositeError("TILED_COMPOSITE_MAP_INVALID", "组合素材源必须是 Tiled map 文档");
  }
  const dependencies = new Set();
  const addReference = (value) => {
    if (typeof value !== "string" || !value || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return;
    try {
      dependencies.add(resolveTiledProjectReference(sourcePath, value));
    } catch {
      // Keep invalid references in the map for the normal Tiled validator;
      // this helper only reports safe project-relative dependencies.
    }
  };
  for (const tileset of Array.isArray(document.tilesets) ? document.tilesets : []) {
    if (typeof tileset?.source === "string") addReference(tileset.source);
    collectTilesetImages(tileset, addReference);
  }
  collectLayerDependencies(document.layers, addReference);
  return Object.freeze([...dependencies].sort(compareText));
}

export function remapCompositeLayerGids(document, remap) {
  if (!isRecord(document) || !Array.isArray(document.layers) || typeof remap !== "function") {
    throw compositeError("TILED_COMPOSITE_REMAP_INVALID", "组合素材 GID 重映射参数无效");
  }
  const result = cloneJsonValue(document);
  remapLayerTree(result.layers, remap);
  return result;
}

export function relocateCompositeMapDocument(document, { sourcePath, targetPath } = {}) {
  if (!isRecord(document) || document.type !== "map" || !sourcePath || !targetPath) {
    throw compositeError("TILED_COMPOSITE_RELOCATE_INVALID", "组合素材相对路径重写参数无效");
  }
  const result = cloneJsonValue(document);
  if (sourcePath !== targetPath) rewriteCompositeReferences(result, sourcePath, targetPath);
  return result;
}

function remapLayerTree(layers, remap) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer?.type === "tilelayer") {
      if (Array.isArray(layer.data)) layer.data = layer.data.map((gid) => remap(Number(gid) >>> 0));
      for (const chunk of Array.isArray(layer.chunks) ? layer.chunks : []) {
        if (Array.isArray(chunk?.data)) chunk.data = chunk.data.map((gid) => remap(Number(gid) >>> 0));
      }
    }
    for (const object of Array.isArray(layer?.objects) ? layer.objects : []) {
      if (Number.isSafeInteger(object?.gid)) object.gid = remap(Number(object.gid) >>> 0);
    }
    remapLayerTree(layer?.layers, remap);
  }
}

function selectRootLayers(layers, ids, ancestorSelected = false) {
  const result = [];
  for (const layer of layers) {
    if (!isRecord(layer)) continue;
    const selected = ids.has(Number(layer.id));
    if (selected && !ancestorSelected) result.push(cloneJsonValue(layer));
    else if (!selected && !ancestorSelected && layer.type === "group" && Array.isArray(layer.layers)) {
      // Selecting a child without its parent creates a small group preserving
      // the child hierarchy, rather than silently exporting unrelated siblings.
      const children = selectRootLayers(layer.layers, ids, false);
      if (children.length) result.push({ ...cloneJsonValue(layer), layers: children });
    }
  }
  return result;
}

function collectLayerDependencies(layers, addReference) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer?.type === "imagelayer") addReference(layer.image);
    for (const object of Array.isArray(layer?.objects) ? layer.objects : []) {
      addReference(object?.template);
      for (const property of Array.isArray(object?.properties) ? object.properties : []) {
        if (String(property?.type || "").toLowerCase() === "file") addReference(property.value);
      }
    }
    collectLayerDependencies(layer?.layers, addReference);
  }
}

function collectTilesetImages(tileset, addReference) {
  if (!tileset || typeof tileset !== "object") return;
  addReference(tileset.image);
  for (const tile of Array.isArray(tileset.tiles) ? tileset.tiles : []) addReference(tile?.image);
}

function rewriteCompositeReferences(document, sourcePath, targetPath) {
  const rewrite = (value) => {
    if (typeof value !== "string" || !value || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
    try {
      return relativeTiledProjectReference(
        targetPath,
        resolveTiledProjectReference(sourcePath, value),
      );
    } catch {
      return value;
    }
  };
  rewriteFileProperties(document.properties, rewrite);
  for (const tileset of Array.isArray(document.tilesets) ? document.tilesets : []) {
    if (typeof tileset?.source === "string") tileset.source = rewrite(tileset.source);
    if (typeof tileset?.image === "string") tileset.image = rewrite(tileset.image);
    rewriteFileProperties(tileset?.properties, rewrite);
    for (const tile of Array.isArray(tileset?.tiles) ? tileset.tiles : []) {
      if (typeof tile?.image === "string") tile.image = rewrite(tile.image);
      rewriteFileProperties(tile?.properties, rewrite);
    }
  }
  rewriteLayerReferences(document.layers, rewrite);
}

function rewriteLayerReferences(layers, rewrite) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (layer?.type === "imagelayer" && typeof layer.image === "string") layer.image = rewrite(layer.image);
    rewriteFileProperties(layer?.properties, rewrite);
    for (const object of Array.isArray(layer?.objects) ? layer.objects : []) {
      if (typeof object?.template === "string") object.template = rewrite(object.template);
      rewriteFileProperties(object?.properties, rewrite);
    }
    rewriteLayerReferences(layer?.layers, rewrite);
  }
}

function rewriteFileProperties(value, rewrite) {
  if (Array.isArray(value)) {
    for (const item of value) rewriteFileProperties(item, rewrite);
    return;
  }
  if (!isRecord(value)) return;
  if (String(value.type || "").toLowerCase() === "file" && typeof value.value === "string") {
    value.value = rewrite(value.value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "value" || String(value.type || "").toLowerCase() !== "file") rewriteFileProperties(child, rewrite);
  }
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return structuredClone(value);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function compositeError(code, message) {
  return new TiledCompositeError(code, message);
}
