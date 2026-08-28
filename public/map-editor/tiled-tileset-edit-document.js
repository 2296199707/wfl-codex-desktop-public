import {
  cloneTiledDocument,
  validateTiledDocument,
} from "./tiled-document.js?v=0.44.63-beta";
import {
  createTiledMapObject,
  TILED_COLLISION_SHAPES,
  tiledObjectShape,
} from "./map-object-model.js?v=0.44.63-beta";

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_LOCAL_TILE_ID = 0x0fff_ffff;
const OBJECT_ALIGNMENTS = new Set([
  "unspecified", "topleft", "top", "topright", "left", "center", "right",
  "bottomleft", "bottom", "bottomright",
]);
const TILE_RENDER_SIZES = new Set(["tile", "grid"]);
const FILL_MODES = new Set(["stretch", "preserve-aspect-fit"]);
const GRID_ORIENTATIONS = new Set(["orthogonal", "isometric"]);
const PROPERTY_TYPES = new Set(["string", "int", "float", "bool", "color", "file", "object", "class"]);
const WANG_SET_TYPES = new Set(["corner", "edge", "mixed"]);

export class TiledTilesetEditError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message);
    this.name = "TiledTilesetEditError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export class TiledTilesetEditDocument {
  constructor(document, { sourcePath = null, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
    const diagnostics = validateTiledDocument(document, { expectedKind: "tileset", sourcePath });
    const error = diagnostics.find((entry) => entry.severity === "error");
    if (error) throw tilesetError("invalid-tileset", error.message, diagnostics);
    this.document = cloneTiledDocument(document);
    this.sourcePath = sourcePath || null;
    this.historyLimit = positiveInteger(historyLimit, "historyLimit");
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
  get kind() { return typeof this.document.image === "string" ? "atlas" : "collection"; }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return Object.freeze({
      dirty: this.dirty,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      headStateId: this.headStateId,
      savedStateId: this.savedStateId,
      kind: this.kind,
    });
  }

  exportDocument() { return cloneTiledDocument(this.document); }

  tileDefinition(id) {
    const normalizedId = this.assertTileId(id);
    const tile = explicitTileById(this.document, normalizedId);
    return cloneTiledDocument(tile || { id: normalizedId });
  }

  setIdentity({ name, className } = {}, { label = "修改瓦片集名称" } = {}) {
    const nextName = requiredString(name, "name");
    const nextClass = optionalString(className, "className");
    return this.commit(label, (document) => {
      document.name = nextName;
      assignOptional(document, "class", nextClass);
    });
  }

  setAtlasGrid(input = {}, { label = "修改图集网格" } = {}) {
    if (this.kind !== "atlas") throw tilesetError("not-atlas", "当前瓦片集不是单图图集");
    const tilewidth = positiveInteger(input.tilewidth, "tilewidth");
    const tileheight = positiveInteger(input.tileheight, "tileheight");
    const margin = nonNegativeInteger(input.margin, "margin");
    const spacing = nonNegativeInteger(input.spacing, "spacing");
    const imagewidth = positiveInteger(this.document.imagewidth, "imagewidth");
    const imageheight = positiveInteger(this.document.imageheight, "imageheight");
    const columns = frameCount(imagewidth, tilewidth, margin, spacing);
    const rows = frameCount(imageheight, tileheight, margin, spacing);
    const tilecount = columns * rows;
    if (!tilecount) throw tilesetError("atlas-grid-empty", "当前网格无法从图集中切出完整瓦片");
    const highestTileId = highestExplicitTileId(this.document.tiles);
    if (highestTileId >= tilecount) {
      throw tilesetError("atlas-grid-truncates-tiles", `网格只有 ${tilecount} 格，但瓦片 ${highestTileId} 仍包含数据`);
    }
    const transparentcolor = normalizeColor(input.transparentcolor);
    return this.commit(label, (document) => {
      Object.assign(document, { tilewidth, tileheight, margin, spacing, columns, tilecount });
      assignOptional(document, "transparentcolor", transparentcolor);
    });
  }

  setRendering(input = {}, { label = "修改瓦片集渲染属性" } = {}) {
    const objectalignment = enumValue(input.objectalignment, OBJECT_ALIGNMENTS, "objectalignment", "unspecified");
    const tilerendersize = enumValue(input.tilerendersize, TILE_RENDER_SIZES, "tilerendersize", "tile");
    const fillmode = enumValue(input.fillmode, FILL_MODES, "fillmode", "stretch");
    const tileoffset = {
      x: integer(input.tileoffsetX ?? 0, "tileoffset.x"),
      y: integer(input.tileoffsetY ?? 0, "tileoffset.y"),
    };
    const gridOrientation = enumValue(input.gridOrientation, GRID_ORIENTATIONS, "grid.orientation", "orthogonal");
    const gridWidth = positiveInteger(input.gridWidth ?? this.document.tilewidth, "grid.width");
    const gridHeight = positiveInteger(input.gridHeight ?? this.document.tileheight, "grid.height");
    const transformations = normalizeTransformations(input.transformations);
    return this.commit(label, (document) => {
      assignOptional(document, "objectalignment", objectalignment === "unspecified" ? null : objectalignment);
      assignOptional(document, "tilerendersize", tilerendersize === "tile" ? null : tilerendersize);
      assignOptional(document, "fillmode", fillmode === "stretch" ? null : fillmode);
      assignOptional(document, "tileoffset", tileoffset.x || tileoffset.y ? tileoffset : null);
      const defaultGrid = gridOrientation === "orthogonal"
        && gridWidth === document.tilewidth
        && gridHeight === document.tileheight;
      assignOptional(document, "grid", defaultGrid ? null : {
        orientation: gridOrientation,
        width: gridWidth,
        height: gridHeight,
      });
      assignOptional(document, "transformations", hasTransformations(transformations) ? transformations : null);
    });
  }

  setTileMetadata(id, input = {}, { label = "修改瓦片属性" } = {}) {
    const normalizedId = this.assertTileId(id);
    const className = optionalString(input.className, "className");
    const probability = input.probability == null || input.probability === ""
      ? null
      : nonNegativeNumber(input.probability, "probability");
    return this.commit(label, (document) => {
      const tile = ensureExplicitTile(document, normalizedId);
      assignOptional(tile, "class", className);
      assignOptional(tile, "probability", probability);
      cleanupExplicitTile(document, tile, this.kind);
    });
  }

  setTileProperties(id, properties, { label = "修改瓦片自定义属性" } = {}) {
    const normalizedId = this.assertTileId(id);
    const normalizedProperties = normalizeProperties(properties);
    return this.commit(label, (document) => {
      const tile = ensureExplicitTile(document, normalizedId);
      assignOptional(tile, "properties", normalizedProperties.length ? normalizedProperties : null);
      cleanupExplicitTile(document, tile, this.kind);
    });
  }

  setTileAnimation(id, frames, { label = "修改瓦片动画" } = {}) {
    const normalizedId = this.assertTileId(id);
    const animation = normalizeAnimation(frames, (frameId) => this.assertTileId(frameId));
    return this.commit(label, (document) => {
      const tile = ensureExplicitTile(document, normalizedId);
      assignOptional(tile, "animation", animation.length ? animation : null);
      cleanupExplicitTile(document, tile, this.kind);
    });
  }

  setTileCollisions(id, objects, { label = "修改瓦片碰撞" } = {}) {
    const normalizedId = this.assertTileId(id);
    const collisions = normalizeCollisionObjects(objects);
    return this.commit(label, (document) => {
      const tile = ensureExplicitTile(document, normalizedId);
      if (!collisions.length) {
        delete tile.objectgroup;
      } else {
        const previous = tile.objectgroup && typeof tile.objectgroup === "object"
          ? cloneTiledDocument(tile.objectgroup)
          : collisionObjectGroup();
        previous.objects = collisions;
        tile.objectgroup = previous;
      }
      cleanupExplicitTile(document, tile, this.kind);
    });
  }

  addTileCollision(id, input = {}, { label = "添加瓦片碰撞" } = {}) {
    const normalizedId = this.assertTileId(id);
    const tile = explicitTileById(this.document, normalizedId);
    const objects = cloneTiledDocument(tile?.objectgroup?.objects || []);
    const width = nonNegativeNumber(input.width ?? this.document.tilewidth, "collision.width");
    const height = nonNegativeNumber(input.height ?? this.document.tileheight, "collision.height");
    const object = createTiledMapObject({
      shape: collisionShape(input.shape),
      semantic: "collision",
      rect: {
        x: finiteNumber(input.x ?? 0, "collision.x"),
        y: finiteNumber(input.y ?? 0, "collision.y"),
        width,
        height,
      },
    });
    object.id = firstFreeObjectId(objects);
    if (input.name != null) object.name = plainString(input.name, "collision.name");
    if (input.className != null) assignOptional(object, "class", optionalString(input.className, "collision.className"));
    objects.push(object);
    this.setTileCollisions(normalizedId, objects, { label });
    return cloneTiledDocument(object);
  }

  updateTileCollision(tileIdValue, objectIdValue, input = {}, { label = "修改瓦片碰撞" } = {}) {
    const normalizedTileId = this.assertTileId(tileIdValue);
    const objectId = positiveInteger(objectIdValue, "collision.id");
    const tile = explicitTileById(this.document, normalizedTileId);
    const objects = cloneTiledDocument(tile?.objectgroup?.objects || []);
    const object = objects.find((entry) => entry?.id === objectId);
    if (!object) throw tilesetError("collision-not-found", `碰撞对象 ${objectId} 不存在`);
    if (input.shape != null) applyCollisionShape(object, collisionShape(input.shape), input.points);
    if (input.x != null) object.x = finiteNumber(input.x, "collision.x");
    if (input.y != null) object.y = finiteNumber(input.y, "collision.y");
    if (input.width != null) object.width = nonNegativeNumber(input.width, "collision.width");
    if (input.height != null) object.height = nonNegativeNumber(input.height, "collision.height");
    if (input.rotation != null) object.rotation = finiteNumber(input.rotation, "collision.rotation");
    if (input.name != null) object.name = plainString(input.name, "collision.name");
    if (input.className != null) assignOptional(object, "class", optionalString(input.className, "collision.className"));
    this.setTileCollisions(normalizedTileId, objects, { label });
    return cloneTiledDocument(object);
  }

  removeTileCollision(tileIdValue, objectIdValue, { label = "删除瓦片碰撞" } = {}) {
    const normalizedTileId = this.assertTileId(tileIdValue);
    const objectId = positiveInteger(objectIdValue, "collision.id");
    const tile = explicitTileById(this.document, normalizedTileId);
    const objects = cloneTiledDocument(tile?.objectgroup?.objects || []);
    const next = objects.filter((entry) => entry?.id !== objectId);
    if (next.length === objects.length) return false;
    return this.setTileCollisions(normalizedTileId, next, { label });
  }

  addWangSet(input = {}, { label = "添加 Terrain/Wang Set" } = {}) {
    const name = requiredString(input.name ?? nextWangSetName(this.document.wangsets), "wangset.name");
    const type = enumValue(input.type, WANG_SET_TYPES, "wangset.type", "mixed");
    assertUniqueWangSetName(this.document.wangsets, name);
    const wangset = {
      name,
      type,
      tile: optionalRepresentativeTile(input.tile, (value) => this.assertTileId(value)),
      colors: [],
      wangtiles: [],
    };
    this.commit(label, (document) => {
      if (!Array.isArray(document.wangsets)) document.wangsets = [];
      document.wangsets.push(wangset);
    });
    return (this.document.wangsets || []).length - 1;
  }

  updateWangSet(indexValue, input = {}, { label = "修改 Terrain/Wang Set" } = {}) {
    const index = wangSetIndex(this.document, indexValue);
    const current = this.document.wangsets[index];
    const name = input.name == null ? current.name : requiredString(input.name, "wangset.name");
    const type = input.type == null ? current.type || "mixed" : enumValue(input.type, WANG_SET_TYPES, "wangset.type", "mixed");
    const className = input.className == null ? current.class || null : optionalString(input.className, "wangset.className");
    const tile = input.tile == null
      ? Number.isSafeInteger(current.tile) ? current.tile : -1
      : optionalRepresentativeTile(input.tile, (value) => this.assertTileId(value));
    assertUniqueWangSetName(this.document.wangsets, name, index);
    assertWangTypeCompatible(current.wangtiles, type);
    return this.commit(label, (document) => {
      const wangset = document.wangsets[index];
      wangset.name = name;
      wangset.type = type;
      wangset.tile = tile;
      assignOptional(wangset, "class", className);
    });
  }

  removeWangSet(indexValue, { label = "删除 Terrain/Wang Set" } = {}) {
    const index = wangSetIndex(this.document, indexValue);
    return this.commit(label, (document) => {
      document.wangsets.splice(index, 1);
      if (!document.wangsets.length) delete document.wangsets;
    });
  }

  addWangColor(setIndexValue, input = {}, { label = "添加 Terrain 颜色" } = {}) {
    const setIndex = wangSetIndex(this.document, setIndexValue);
    const wangset = this.document.wangsets[setIndex];
    const name = requiredString(input.name ?? nextWangColorName(wangset.colors), "wangcolor.name");
    assertUniqueWangColorName(wangset.colors, name);
    const color = wangColor(input.color ?? "#808080");
    const probability = nonNegativeNumber(input.probability ?? 1, "wangcolor.probability");
    const tile = optionalRepresentativeTile(input.tile, (value) => this.assertTileId(value));
    this.commit(label, (document) => {
      const target = document.wangsets[setIndex];
      if (!Array.isArray(target.colors)) target.colors = [];
      target.colors.push({ color, name, probability, tile });
    });
    return (this.document.wangsets[setIndex].colors || []).length;
  }

  updateWangColor(setIndexValue, colorIndexValue, input = {}, { label = "修改 Terrain 颜色" } = {}) {
    const setIndex = wangSetIndex(this.document, setIndexValue);
    const wangset = this.document.wangsets[setIndex];
    const colorIndex = wangColorIndex(wangset, colorIndexValue);
    const current = wangset.colors[colorIndex - 1];
    const name = input.name == null ? current.name : requiredString(input.name, "wangcolor.name");
    assertUniqueWangColorName(wangset.colors, name, colorIndex - 1);
    const color = input.color == null ? current.color : wangColor(input.color);
    const probability = input.probability == null
      ? nonNegativeNumber(current.probability ?? 1, "wangcolor.probability")
      : nonNegativeNumber(input.probability, "wangcolor.probability");
    const tile = input.tile == null
      ? Number.isSafeInteger(current.tile) ? current.tile : -1
      : optionalRepresentativeTile(input.tile, (value) => this.assertTileId(value));
    return this.commit(label, (document) => {
      const target = document.wangsets[setIndex].colors[colorIndex - 1];
      Object.assign(target, { name, color, probability, tile });
    });
  }

  removeWangColor(setIndexValue, colorIndexValue, { label = "删除 Terrain 颜色" } = {}) {
    const setIndex = wangSetIndex(this.document, setIndexValue);
    const wangset = this.document.wangsets[setIndex];
    const colorIndex = wangColorIndex(wangset, colorIndexValue);
    return this.commit(label, (document) => {
      const target = document.wangsets[setIndex];
      target.colors.splice(colorIndex - 1, 1);
      for (const wangtile of target.wangtiles || []) {
        wangtile.wangid = (wangtile.wangid || []).map((value) => (
          value === colorIndex ? 0 : value > colorIndex ? value - 1 : value
        ));
      }
    });
  }

  setTileWangId(setIndexValue, tileIdValue, wangIdValue, { label = "修改瓦片 Terrain 边角" } = {}) {
    const setIndex = wangSetIndex(this.document, setIndexValue);
    const tileid = this.assertTileId(tileIdValue);
    const wangset = this.document.wangsets[setIndex];
    const wangid = normalizeWangId(wangIdValue, wangset.colors?.length || 0, wangset.type || "mixed");
    return this.commit(label, (document) => {
      const target = document.wangsets[setIndex];
      if (!Array.isArray(target.wangtiles)) target.wangtiles = [];
      const existing = target.wangtiles.find((entry) => entry?.tileid === tileid);
      if (wangid.every((value) => value === 0)) {
        target.wangtiles = target.wangtiles.filter((entry) => entry?.tileid !== tileid);
      } else if (existing) {
        existing.wangid = wangid;
      } else {
        target.wangtiles.push({ tileid, wangid });
        target.wangtiles.sort((left, right) => left.tileid - right.tileid);
      }
    });
  }

  assertTileId(value) {
    const id = tileId(value);
    if (this.kind === "atlas") {
      if (id >= nonNegativeInteger(this.document.tilecount, "tilecount")) {
        throw tilesetError("tile-not-found", `瓦片 ID ${id} 超出图集范围`);
      }
    } else if (!explicitTileById(this.document, id)) {
      throw tilesetError("tile-not-found", `集合瓦片 ID ${id} 不存在`);
    }
    return id;
  }

  addCollectionTile(input = {}, { label = "添加集合图片" } = {}) {
    if (this.kind !== "collection") throw tilesetError("not-image-collection", "当前瓦片集不是图片集合");
    const used = new Set((this.document.tiles || []).map((tile) => tile?.id));
    const id = input.id == null ? firstFreeTileId(used) : tileId(input.id);
    if (used.has(id)) throw tilesetError("duplicate-tile-id", `瓦片 ID ${id} 已存在`);
    const tile = {
      id,
      image: tiledReference(input.image, "image"),
      imagewidth: positiveInteger(input.imagewidth, "imagewidth"),
      imageheight: positiveInteger(input.imageheight, "imageheight"),
    };
    if ((this.document.tiles || []).some((entry) => entry?.image === tile.image)) {
      throw tilesetError("duplicate-tile-image", `图片 ${tile.image} 已经在当前集合中`);
    }
    this.commit(label, (document) => {
      if (!Array.isArray(document.tiles)) document.tiles = [];
      document.tiles.push(tile);
      document.tilecount = document.tiles.length;
      document.columns = 0;
      document.tilewidth = Math.max(Number(document.tilewidth) || 0, tile.imagewidth);
      document.tileheight = Math.max(Number(document.tileheight) || 0, tile.imageheight);
    });
    return cloneTiledDocument(tile);
  }

  removeCollectionTiles(ids, { label = "移除集合图片" } = {}) {
    if (this.kind !== "collection") throw tilesetError("not-image-collection", "当前瓦片集不是图片集合");
    const selected = new Set(Array.from(ids || [], tileId));
    if (!selected.size) return false;
    const existing = this.document.tiles || [];
    if (!existing.some((tile) => selected.has(tile.id))) return false;
    if (existing.every((tile) => selected.has(tile.id))) {
      throw tilesetError("empty-image-collection", "图片集合至少需要保留一个瓦片");
    }
    return this.commit(label, (document) => {
      document.tiles = (document.tiles || []).filter((tile) => !selected.has(tile.id));
      document.tilecount = document.tiles.length;
      document.columns = 0;
      document.tilewidth = Math.max(1, ...document.tiles.map((tile) => Number(tile.imagewidth) || 0));
      document.tileheight = Math.max(1, ...document.tiles.map((tile) => Number(tile.imageheight) || 0));
    });
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.document = cloneTiledDocument(entry.before);
    this.redoStack.push(entry);
    this.headStateId = entry.beforeStateId;
    this.emit("undo", entry);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.document = cloneTiledDocument(entry.after);
    this.undoStack.push(entry);
    this.headStateId = entry.afterStateId;
    this.emit("redo", entry);
    return true;
  }

  markSaved(stateId = this.headStateId) {
    if (!Number.isSafeInteger(stateId) || stateId < 0) throw new TypeError("stateId must be a non-negative integer");
    this.savedStateId = stateId;
    this.emit("saved", null);
  }

  commit(label, mutation) {
    const before = cloneTiledDocument(this.document);
    mutation(this.document);
    const diagnostics = validateTiledDocument(this.document, {
      expectedKind: "tileset",
      sourcePath: this.sourcePath,
    });
    const error = diagnostics.find((entry) => entry.severity === "error");
    if (error) {
      this.document = before;
      throw tilesetError("invalid-tileset-edit", error.message, diagnostics);
    }
    const after = cloneTiledDocument(this.document);
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const entry = Object.freeze({
      type: "tileset-edit",
      label: String(label || "编辑瓦片集"),
      before,
      after,
      beforeStateId: this.headStateId,
      afterStateId: this.nextStateId++,
    });
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
}

function frameCount(imageSize, tileSize, margin, spacing) {
  const available = imageSize - (margin * 2);
  return available < tileSize ? 0 : Math.floor((available + spacing) / (tileSize + spacing));
}

function highestExplicitTileId(tiles) {
  return Math.max(-1, ...(Array.isArray(tiles) ? tiles.map((tile) => Number(tile?.id) || 0) : []));
}

function firstFreeTileId(used) {
  for (let id = 0; id <= MAX_LOCAL_TILE_ID; id += 1) if (!used.has(id)) return id;
  throw tilesetError("tile-id-limit", "图片集合没有可用的本地瓦片 ID");
}

function explicitTileById(document, id) {
  return (Array.isArray(document.tiles) ? document.tiles : []).find((tile) => tile?.id === id) || null;
}

function ensureExplicitTile(document, id) {
  const existing = explicitTileById(document, id);
  if (existing) return existing;
  if (!Array.isArray(document.tiles)) document.tiles = [];
  const tile = { id };
  document.tiles.push(tile);
  document.tiles.sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0));
  return tile;
}

function cleanupExplicitTile(document, tile, kind) {
  if (kind !== "atlas") return;
  if (Object.keys(tile).some((key) => key !== "id")) return;
  document.tiles = (document.tiles || []).filter((entry) => entry !== tile);
  if (!document.tiles.length) delete document.tiles;
}

function normalizeProperties(properties) {
  if (!Array.isArray(properties)) throw new TypeError("properties must be an array");
  const names = new Set();
  return cloneTiledDocument(properties).map((property, index) => {
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      throw new TypeError(`properties[${index}] must be an object`);
    }
    const name = requiredString(property.name, `properties[${index}].name`);
    if (names.has(name)) throw tilesetError("duplicate-property-name", `属性 ${name} 重复`);
    names.add(name);
    const type = String(property.type || "string");
    if (!PROPERTY_TYPES.has(type) && type !== "list") {
      throw tilesetError("unsupported-property-type", `暂不能编辑 ${type} 类型属性`);
    }
    const normalized = { ...property, name, type };
    if (type === "string" || type === "color" || type === "file") normalized.value = String(property.value ?? "");
    else if (type === "bool") normalized.value = property.value === true;
    else if (type === "int") normalized.value = integer(property.value, `${name}.value`);
    else if (type === "object") normalized.value = nonNegativeInteger(property.value, `${name}.value`);
    else if (type === "float") normalized.value = finiteNumber(property.value, `${name}.value`);
    else if (type === "class" && (!property.value || typeof property.value !== "object" || Array.isArray(property.value))) {
      throw new TypeError(`${name}.value must be an object`);
    } else if (type === "list" && !Array.isArray(property.value)) {
      throw new TypeError(`${name}.value must be an array`);
    }
    return normalized;
  });
}

function normalizeAnimation(frames, assertFrameId) {
  if (frames == null) return [];
  if (!Array.isArray(frames)) throw new TypeError("animation must be an array");
  return frames.map((frame, index) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new TypeError(`animation[${index}] must be an object`);
    }
    return {
      ...cloneTiledDocument(frame),
      tileid: assertFrameId(frame.tileid),
      duration: positiveInteger(frame.duration, `animation[${index}].duration`),
    };
  });
}

function normalizeCollisionObjects(objects) {
  if (!Array.isArray(objects)) throw new TypeError("collision objects must be an array");
  const ids = new Set();
  return cloneTiledDocument(objects).map((object, index) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      throw new TypeError(`collision[${index}] must be an object`);
    }
    const id = positiveInteger(object.id, `collision[${index}].id`);
    if (ids.has(id)) throw tilesetError("duplicate-collision-id", `碰撞对象 ID ${id} 重复`);
    ids.add(id);
    collisionShape(tiledObjectShape(object));
    return object;
  });
}

function wangSetIndex(document, value) {
  const index = nonNegativeInteger(value, "wangset index");
  if (!Array.isArray(document.wangsets) || index >= document.wangsets.length) {
    throw tilesetError("wangset-not-found", `Terrain/Wang Set ${index + 1} 不存在`);
  }
  return index;
}

function wangColorIndex(wangset, value) {
  const index = positiveInteger(value, "wang color index");
  if (!Array.isArray(wangset.colors) || index > wangset.colors.length) {
    throw tilesetError("wangcolor-not-found", `Terrain 颜色 ${index} 不存在`);
  }
  return index;
}

function optionalRepresentativeTile(value, assertTile) {
  if (value == null || value === "" || Number(value) === -1) return -1;
  return assertTile(value);
}

function nextWangSetName(wangsets) {
  const names = new Set((wangsets || []).map((entry) => entry?.name));
  let index = 1;
  while (names.has(`Terrain ${index}`)) index += 1;
  return `Terrain ${index}`;
}

function nextWangColorName(colors) {
  const names = new Set((colors || []).map((entry) => entry?.name));
  let index = 1;
  while (names.has(`Terrain ${index}`)) index += 1;
  return `Terrain ${index}`;
}

function assertUniqueWangSetName(wangsets, name, exceptIndex = -1) {
  if ((wangsets || []).some((entry, index) => index !== exceptIndex && entry?.name === name)) {
    throw tilesetError("duplicate-wangset-name", `Terrain/Wang Set 名称 ${name} 重复`);
  }
}

function assertUniqueWangColorName(colors, name, exceptIndex = -1) {
  if ((colors || []).some((entry, index) => index !== exceptIndex && entry?.name === name)) {
    throw tilesetError("duplicate-wangcolor-name", `Terrain 颜色名称 ${name} 重复`);
  }
}

function wangColor(value) {
  const color = String(value || "").trim().toLowerCase();
  if (!/^#[a-f0-9]{6}$/u.test(color)) throw new TypeError("wang color must be #RRGGBB");
  return color;
}

function assertWangTypeCompatible(wangtiles, type) {
  for (const wangtile of wangtiles || []) normalizeWangId(wangtile?.wangid, Number.MAX_SAFE_INTEGER, type);
}

function normalizeWangId(value, colorCount, type) {
  if (!Array.isArray(value) || value.length !== 8) throw new TypeError("wangid must contain exactly 8 values");
  const wangid = value.map((entry, index) => {
    const color = nonNegativeInteger(entry, `wangid[${index}]`);
    if (color > colorCount) throw tilesetError("wangcolor-not-found", `wangid[${index}] 引用了不存在的颜色 ${color}`);
    return color;
  });
  if (type === "corner" && wangid.some((color, index) => index % 2 === 1 && color !== 0)) {
    throw tilesetError("wangset-type-conflict", "Corner Terrain 不能包含边颜色");
  }
  if (type === "edge" && wangid.some((color, index) => index % 2 === 0 && color !== 0)) {
    throw tilesetError("wangset-type-conflict", "Edge Terrain 不能包含角颜色");
  }
  return wangid;
}

function collisionObjectGroup() {
  return {
    draworder: "index",
    id: 1,
    name: "Collision",
    objects: [],
    opacity: 1,
    type: "objectgroup",
    visible: true,
    x: 0,
    y: 0,
  };
}

function firstFreeObjectId(objects) {
  const id = Math.max(0, ...objects.map((object) => Number.isSafeInteger(object?.id) ? object.id : 0)) + 1;
  if (!Number.isSafeInteger(id)) throw tilesetError("collision-id-limit", "碰撞对象没有可用 ID");
  return id;
}

function collisionShape(value) {
  const shape = String(value || "rectangle");
  if (!TILED_COLLISION_SHAPES.includes(shape)) throw tilesetError("invalid-collision-shape", `不支持的碰撞形状：${shape}`);
  return shape;
}

function applyCollisionShape(object, shape, pointsInput) {
  for (const key of ["ellipse", "capsule", "point", "polygon", "polyline", "gid", "text"]) delete object[key];
  if (shape === "ellipse") object.ellipse = true;
  else if (shape === "capsule") object.capsule = true;
  else if (shape === "polygon" || shape === "polyline") {
    const minimum = shape === "polygon" ? 3 : 2;
    const fallback = shape === "polygon"
      ? [{ x: 0, y: 0 }, { x: Number(object.width || 0), y: 0 }, { x: Number(object.width || 0), y: Number(object.height || 0) }]
      : [{ x: 0, y: 0 }, { x: Number(object.width || 0), y: Number(object.height || 0) }];
    const input = pointsInput == null ? fallback : pointsInput;
    if (!Array.isArray(input) || input.length < minimum) throw tilesetError("collision-point-count", `${shape === "polygon" ? "多边形" : "折线"}至少需要 ${minimum} 个点`);
    object[shape] = input.map((point, index) => ({
      x: finiteNumber(point?.x, `${shape}[${index}].x`),
      y: finiteNumber(point?.y, `${shape}[${index}].y`),
    }));
    object.width = 0;
    object.height = 0;
  }
}

function tileId(value) {
  const id = nonNegativeInteger(value, "tile id");
  if (id > MAX_LOCAL_TILE_ID) throw tilesetError("tile-id-limit", "瓦片 ID 超出 Tiled GID 范围");
  return id;
}

function normalizeTransformations(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    hflip: input.hflip === true,
    vflip: input.vflip === true,
    rotate: input.rotate === true,
    preferuntransformed: input.preferuntransformed === true,
  };
}

function hasTransformations(value) {
  return value.hflip || value.vflip || value.rotate || value.preferuntransformed;
}

function assignOptional(target, key, value) {
  if (value === null || value === undefined || value === "") delete target[key];
  else target[key] = value;
}

function normalizeColor(value) {
  const color = String(value || "").trim().toLowerCase();
  if (!color) return null;
  if (!/^#(?:[a-f0-9]{6}|[a-f0-9]{8})$/u.test(color)) throw new TypeError("transparentcolor must be #RRGGBB or #AARRGGBB");
  return color;
}

function tiledReference(value, name) {
  const reference = requiredString(value, name);
  if (reference.includes("\\") || reference.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(reference)) {
    throw new TypeError(`${name} must be a relative Tiled reference`);
  }
  const segments = reference.split("/");
  if (segments.some((segment) => !segment || segment === ".")) throw new TypeError(`${name} must be a relative Tiled reference`);
  return segments.join("/");
}

function enumValue(value, allowed, name, fallback) {
  const normalized = String(value || fallback);
  if (!allowed.has(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.includes("\0")) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalString(value, name) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (normalized.includes("\0")) throw new TypeError(`${name} is invalid`);
  return normalized || null;
}

function plainString(value, name) {
  const normalized = String(value ?? "").trim();
  if (normalized.includes("\0")) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be an integer`);
  return number;
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be a finite number`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = finiteNumber(value, name);
  if (number < 0) throw new TypeError(`${name} must be non-negative`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = integer(value, name);
  if (number < 0) throw new TypeError(`${name} must be non-negative`);
  return number;
}

function positiveInteger(value, name) {
  const number = integer(value, name);
  if (number <= 0) throw new TypeError(`${name} must be positive`);
  return number;
}

function tilesetError(code, message, diagnostics = []) {
  return new TiledTilesetEditError(code, message, diagnostics);
}
