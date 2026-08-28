import { cloneTiledDocument } from "./tiled-document.js?v=0.44.63-beta";

const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_CHUNK_SIZE = 16;

export class TiledEditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TiledEditError";
    this.code = code;
  }
}

export class TiledEditDocument {
  constructor(document, options = {}) {
    this.document = cloneTiledDocument(document);
    this.historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, "historyLimit");
    this.chunkWidth = positiveInteger(options.chunkWidth, DEFAULT_CHUNK_SIZE, "chunkWidth");
    this.chunkHeight = positiveInteger(options.chunkHeight, DEFAULT_CHUNK_SIZE, "chunkHeight");
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.nextStateId = 1;
    this.headStateId = 0;
    this.savedStateId = 0;
    this.activeTransaction = null;
    this.activeBatch = null;
  }

  get dirty() {
    return this.headStateId !== this.savedStateId;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  snapshot() {
    return {
      dirty: this.dirty,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      headStateId: this.headStateId,
      savedStateId: this.savedStateId,
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  layerById(layerId) {
    return findLayer(this.document.layers, layerId)?.layer || null;
  }

  layerEntryById(layerId) {
    return findLayer(this.document.layers, layerId);
  }

  beginTileStroke(layerId, options = {}) {
    if (this.activeTransaction) throw editError("transaction-active", "已有地图编辑事务正在运行");
    const layer = this.requireTileLayer(layerId);
    const transaction = new TileStrokeTransaction(this, layer, {
      kind: options.kind || "tile-paint",
      label: options.label || "编辑瓦片",
      seed: optionalTileSeed(options.seed),
    });
    this.activeTransaction = transaction;
    return transaction;
  }

  tileAt(layerId, x, y) {
    const layer = this.layerById(layerId);
    if (!layer) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
    if (layer.type !== "tilelayer") throw editError("not-tile-layer", "当前图层不是瓦片层");
    if (typeof layer.data === "string" || layer.chunks?.some((chunk) => typeof chunk?.data === "string")) {
      throw editError("encoded-tile-layer", "编码瓦片层需要先按原编码方式解码后再取样");
    }
    const tile = readTile(layer, integerCoordinate(x, "x"), integerCoordinate(y, "y"));
    return tile.exists ? tile.value : null;
  }

  fillTileRegion(layerId, x, y, encodedGid, options = {}) {
    const layer = this.requireTileLayer(layerId);
    const column = integerCoordinate(x, "x");
    const row = integerCoordinate(y, "y");
    const replacement = Number(encodedGid) >>> 0;
    const initial = readTile(layer, column, row);
    if (!initial.exists) throw editError("tile-outside-layer", "填充起点位于可编辑图层范围外");
    if (initial.value === replacement) return false;

    const transaction = this.beginTileStroke(layerId, {
      kind: options.kind || "tile-fill",
      label: options.label || "填充瓦片",
    });
    const pending = [[column, row]];
    const visited = new Set();
    try {
      while (pending.length) {
        const [currentX, currentY] = pending.pop();
        const key = `${currentX},${currentY}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const current = readTile(layer, currentX, currentY);
        if (!current.exists || current.value !== initial.value) continue;
        transaction.set(currentX, currentY, replacement);
        pending.push(
          [currentX - 1, currentY],
          [currentX + 1, currentY],
          [currentX, currentY - 1],
          [currentX, currentY + 1],
        );
      }
      return transaction.commit();
    } catch (error) {
      transaction.cancel();
      throw error;
    }
  }

  /**
   * Atomically commit a compact Flood Fill result produced from a snapshot of
   * an existing decoded tile layer. The result addresses blocks by immutable
   * geometry instead of the current chunk-array order, so a stale or malformed
   * Worker response cannot silently write to another chunk.
   */
  applyTileFillResult(layerId, result, options = {}) {
    if (this.activeTransaction) throw editError("transaction-active", "请先结束当前地图编辑事务");
    const expectedStateId = options.expectedStateId;
    if (expectedStateId !== undefined) {
      if (!Number.isSafeInteger(expectedStateId) || expectedStateId < 0) {
        throw new TypeError("expectedStateId must be a non-negative safe integer");
      }
      if (this.headStateId !== expectedStateId) {
        throw editError("fill-result-stale", "地图状态已经变化，已丢弃旧的填充结果");
      }
    }
    const layer = this.requireTileLayer(layerId);
    const normalized = normalizeCompactFillResult(result);
    if (!normalized.count) return false;
    if (normalized.target === normalized.replacement) {
      throw editError("invalid-fill-result", "填充结果的原值和替换值不能相同");
    }
    const liveBlocks = resolveCompactFillBlocks(layer, normalized.blocks);
    const visited = liveBlocks.map((block) => new Uint8Array(block.data.length));
    const actualBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let index = 0; index < normalized.addresses.length; index += 2) {
      const blockIndex = normalized.addresses[index];
      const localIndex = normalized.addresses[index + 1];
      const block = liveBlocks[blockIndex];
      if (!block || localIndex < 0 || localIndex >= block.data.length) {
        throw editError("invalid-fill-result", "填充结果包含无效的瓦片地址");
      }
      if (visited[blockIndex][localIndex]) {
        throw editError("invalid-fill-result", "填充结果包含重复的瓦片地址");
      }
      visited[blockIndex][localIndex] = 1;
      if ((Number(block.data[localIndex]) >>> 0) !== normalized.target) {
        throw editError("fill-result-stale", "瓦片内容已经变化，已丢弃旧的填充结果");
      }
      const descriptor = normalized.blocks[blockIndex];
      const cellX = descriptor.x + localIndex % descriptor.width;
      const cellY = descriptor.y + Math.floor(localIndex / descriptor.width);
      actualBounds.minX = Math.min(actualBounds.minX, cellX);
      actualBounds.minY = Math.min(actualBounds.minY, cellY);
      actualBounds.maxX = Math.max(actualBounds.maxX, cellX);
      actualBounds.maxY = Math.max(actualBounds.maxY, cellY);
    }
    if (
      actualBounds.minX !== normalized.bounds.minX
      || actualBounds.minY !== normalized.bounds.minY
      || actualBounds.maxX !== normalized.bounds.maxX
      || actualBounds.maxY !== normalized.bounds.maxY
    ) {
      throw editError("invalid-fill-result", "填充结果范围与瓦片地址不一致");
    }
    for (let index = 0; index < normalized.addresses.length; index += 2) {
      liveBlocks[normalized.addresses[index]].data[normalized.addresses[index + 1]] = normalized.replacement;
    }
    this.commitEntry({
      type: "tile-fill-compact",
      kind: options.kind || "tile-fill",
      label: options.label || "填充瓦片",
      layerId: layer.id,
      addresses: normalized.addresses,
      blocks: normalized.blocks,
      target: normalized.target,
      replacement: normalized.replacement,
      count: normalized.count,
      bounds: normalized.bounds,
    });
    return true;
  }

  createLayer(type, options = {}) {
    const layerType = String(type || "").trim();
    if (!["tilelayer", "objectgroup", "imagelayer", "group"].includes(layerType)) {
      throw editError("unsupported-layer-type", `不支持创建 ${layerType || "空"} 类型的图层`);
    }
    const supplied = cloneJsonValue(options.layer || {});
    for (const [key, value] of Object.entries(options)) {
      if (["layer", "parentId", "parentLayerId", "index", "label"].includes(key)) continue;
      supplied[key] = cloneJsonValue(value);
    }
    const layer = {
      ...defaultLayer(this.document, layerType),
      ...supplied,
      type: layerType,
    };
    delete layer.id;
    return this.addLayer(layer, {
      parentId: layerParentOption(options, null),
      index: options.index,
      label: options.label || "新建图层",
    });
  }

  /**
   * Add a Tiled tileset reference as an undoable root-document operation.
   * The caller is responsible for validating the referenced TSJ and choosing
   * a non-overlapping firstgid (the viewer has the decoded range information).
   * Unknown fields on the reference are intentionally retained.
   */
  addTileset(value, options = {}) {
    this.assertStructuralEditReady();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("tileset value must be an object");
    }
    const reference = cloneJsonValue(value);
    if (!Number.isSafeInteger(reference.firstgid) || reference.firstgid < 1 || reference.firstgid > 0x0fff_ffff) {
      throw editError("invalid-tileset-firstgid", "瓦片集 firstgid 必须是有效的 Tiled GID");
    }
    if (reference.source !== undefined) validateTilesetSource(reference.source);
    if (reference.source === undefined && reference.type !== "tileset") {
      throw editError("invalid-tileset", "内嵌瓦片集必须包含 type=tileset");
    }
    if (!Array.isArray(this.document.tilesets)) this.document.tilesets = [];
    if (reference.source !== undefined && this.document.tilesets.some((entry) => entry?.source === reference.source)) {
      throw editError("duplicate-tileset-source", `瓦片集 ${reference.source} 已经被当前地图引用`);
    }
    const requestedIndex = options.index === undefined
      ? this.document.tilesets.findIndex((entry) => Number(entry?.firstgid) > reference.firstgid)
      : options.index;
    const index = insertionIndex(
      requestedIndex < 0 ? this.document.tilesets.length : requestedIndex,
      this.document.tilesets.length,
    );
    this.document.tilesets.splice(index, 0, reference);
    this.commitEntry({
      type: "tileset-structure",
      operation: "add",
      structural: true,
      reloadTilesets: true,
      label: options.label || "导入瓦片集",
      index,
      reference: cloneJsonValue(reference),
    });
    return cloneJsonValue(reference);
  }

  removeTileset(selector, options = {}) {
    this.assertStructuralEditReady();
    if (!Array.isArray(this.document.tilesets)) return false;
    const index = this.document.tilesets.findIndex((entry) => (
      (Number.isSafeInteger(selector) && entry?.firstgid === selector)
      || (typeof selector === "string" && entry?.source === selector)
      || (selector && typeof selector === "object" && entry === selector)
    ));
    if (index < 0) throw editError("tileset-not-found", "要删除的瓦片集不存在");
    const [reference] = this.document.tilesets.splice(index, 1);
    this.commitEntry({
      type: "tileset-structure",
      operation: "remove",
      structural: true,
      reloadTilesets: true,
      label: options.label || "移除瓦片集",
      index,
      reference: cloneJsonValue(reference),
    });
    return cloneJsonValue(reference);
  }

  addLayer(value, options = {}) {
    this.assertStructuralEditReady();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("layer value must be an object");
    }
    if (typeof value.type !== "string" || !value.type.trim()) {
      throw editError("invalid-layer", "图层必须包含有效的 type 字段");
    }
    const target = this.resolveLayerContainer(layerParentOption(options, null));
    const index = insertionIndex(options.index, target.layers.length);
    const beforeIds = captureIdCounters(this.document);
    const allocation = allocateLayerTreeIds(this.document, value);
    target.layers.splice(index, 0, allocation.layer);
    const afterIds = captureIdCounters(this.document);
    this.commitEntry({
      type: "layer-structure",
      operation: "add",
      structural: true,
      label: options.label || "添加图层",
      layerId: allocation.layer.id,
      parentId: target.parentId,
      index,
      layer: cloneJsonValue(allocation.layer),
      beforeIds,
      afterIds,
    });
    return cloneJsonValue(allocation.layer);
  }

  duplicateLayer(layerId, options = {}) {
    this.assertStructuralEditReady();
    const source = this.layerEntryById(layerId);
    if (!source) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
    const parentId = layerParentOption(options, source.parent?.id ?? null);
    const sameContainer = parentId === (source.parent?.id ?? null);
    const index = options.index === undefined && sameContainer ? source.index + 1 : options.index;
    return this.addLayer(source.layer, {
      parentId,
      index,
      label: options.label || "复制图层",
    });
  }

  removeLayer(layerId, options = {}) {
    this.assertStructuralEditReady();
    const entry = this.layerEntryById(layerId);
    if (!entry) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
    assertLayerTreeEditable(entry, "删除");
    const beforeIds = captureIdCounters(this.document);
    const [removed] = entry.siblings.splice(entry.index, 1);
    const afterIds = captureIdCounters(this.document);
    this.commitEntry({
      type: "layer-structure",
      operation: "remove",
      structural: true,
      label: options.label || "删除图层",
      layerId,
      parentId: entry.parent?.id ?? null,
      index: entry.index,
      layer: cloneJsonValue(removed),
      beforeIds,
      afterIds,
    });
    return cloneJsonValue(removed);
  }

  moveLayer(layerId, options = {}) {
    this.assertStructuralEditReady();
    const entry = this.layerEntryById(layerId);
    if (!entry) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
    assertLayerTreeEditable(entry, "移动");
    const parentId = layerParentOption(options, entry.parent?.id ?? null);
    if (parentId === layerId || layerContainsId(entry.layer, parentId)) {
      throw editError("layer-cycle", "不能把分组图层移动到自身或其子图层中");
    }
    const target = this.resolveLayerContainer(parentId);
    const sameContainer = target.layers === entry.siblings;
    const targetLength = target.layers.length - (sameContainer ? 1 : 0);
    const index = insertionIndex(options.index, targetLength, sameContainer ? entry.index : targetLength);
    if (sameContainer && index === entry.index) return false;
    const beforeIds = captureIdCounters(this.document);
    const fromParentId = entry.parent?.id ?? null;
    const fromIndex = entry.index;
    const [layer] = entry.siblings.splice(entry.index, 1);
    target.layers.splice(index, 0, layer);
    const afterIds = captureIdCounters(this.document);
    this.commitEntry({
      type: "layer-structure",
      operation: "move",
      structural: true,
      label: options.label || "移动图层",
      layerId,
      fromParentId,
      fromIndex,
      toParentId: target.parentId,
      toIndex: index,
      beforeIds,
      afterIds,
    });
    return cloneJsonValue(layer);
  }

  moveLayers(layerIds, options = {}) {
    this.assertStructuralEditReady();
    const requestedIds = [...new Set(Array.isArray(layerIds) ? layerIds : [])];
    if (!requestedIds.length || requestedIds.some((layerId) => !Number.isSafeInteger(layerId))) {
      throw editError("invalid-layer-selection", "批量移动必须包含有效的图层 ID");
    }
    const requested = new Set(requestedIds);
    const order = flattenedLayerIds(this.document.layers);
    const entries = requestedIds.map((layerId) => {
      const entry = this.layerEntryById(layerId);
      if (!entry) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
      return entry;
    });
    const roots = entries
      .filter((entry) => !entry.ancestors.some((ancestor) => requested.has(ancestor?.id)))
      .sort((left, right) => order.indexOf(left.layer.id) - order.indexOf(right.layer.id));
    for (const entry of roots) assertLayerTreeEditable(entry, "移动");

    const parentId = layerParentOption(options, null);
    for (const entry of roots) {
      if (parentId === entry.layer.id || layerContainsId(entry.layer, parentId)) {
        throw editError("layer-cycle", "不能把分组图层移动到自身或其子图层中");
      }
    }
    const target = this.resolveLayerContainer(parentId);
    const requestedIndex = insertionIndex(options.index, target.layers.length);
    const from = roots.map((entry) => ({
      layerId: entry.layer.id,
      parentId: entry.parent?.id ?? null,
      index: entry.index,
    }));
    const beforeTree = layerTreeIdSignature(this.document.layers);
    const moved = new Map();
    for (const entry of roots) {
      const current = this.layerEntryById(entry.layer.id);
      const [layer] = current.siblings.splice(current.index, 1);
      moved.set(layer.id, layer);
    }
    const removedBeforeTarget = from.filter((entry) => (
      entry.parentId === target.parentId && entry.index < requestedIndex
    )).length;
    const toIndex = requestedIndex - removedBeforeTarget;
    target.layers.splice(toIndex, 0, ...roots.map((entry) => moved.get(entry.layer.id)));
    if (beforeTree === layerTreeIdSignature(this.document.layers)) return false;

    const beforeIds = captureIdCounters(this.document);
    const afterIds = captureIdCounters(this.document);
    this.commitEntry({
      type: "layer-structure",
      operation: "move-many",
      structural: true,
      label: options.label || `移动 ${roots.length} 个图层`,
      layerId: roots[0].layer.id,
      layerIds: roots.map((entry) => entry.layer.id),
      from,
      toParentId: target.parentId,
      toIndex,
      beforeIds,
      afterIds,
    });
    return roots.map((entry) => cloneJsonValue(moved.get(entry.layer.id)));
  }

  updateLayer(layerId, changes, options = {}) {
    const layer = this.layerById(layerId);
    if (!layer) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
    const before = {};
    const after = {};
    const beforeMissing = [];
    const afterMissing = [];
    const entries = Object.entries(changes || {});
    if (layer.locked === true && entries.some(([key]) => !["locked", "visible"].includes(key))) {
      throw editError("layer-locked", `图层 ${layer.name || layerId} 已锁定`);
    }
    for (const [key, value] of entries) {
      if (["id", "type", "layers", "data", "chunks", "objects"].includes(key)) {
        throw editError("protected-layer-field", `不能通过属性操作修改图层字段 ${key}`);
      }
      if (Object.hasOwn(layer, key)) before[key] = cloneJsonValue(layer[key]);
      else beforeMissing.push(key);
      if (value === undefined) afterMissing.push(key);
      else after[key] = cloneJsonValue(value);
    }
    if (!entries.length || fieldChangesEqual(before, beforeMissing, after, afterMissing)) return false;
    applyFieldChanges(layer, after, afterMissing);
    this.commitEntry({
      type: "layer-update",
      label: options.label || "修改图层",
      layerId,
      before,
      beforeMissing,
      after,
      afterMissing,
    });
    return true;
  }

  addObject(layerId, value, options = {}) {
    const layer = this.requireObjectLayer(layerId);
    const previousNextObjectId = nextObjectId(this.document);
    const object = cloneJsonValue(value || {});
    if (!Number.isInteger(object.id) || object.id <= 0) object.id = previousNextObjectId;
    if (objectWithId(this.document.layers, object.id)) {
      throw editError("duplicate-object-id", `对象 ID ${object.id} 已存在`);
    }
    const nextId = Math.max(previousNextObjectId, object.id + 1);
    this.document.nextobjectid = nextId;
    const index = layer.objects.length;
    layer.objects.push(object);
    this.commitEntry({
      type: "object-add",
      label: options.label || "添加对象",
      layerId,
      index,
      object: cloneJsonValue(object),
      previousNextObjectId,
      nextObjectId: nextId,
    });
    return cloneJsonValue(object);
  }

  duplicateObject(layerId, objectId, changes = {}, options = {}) {
    const layer = this.requireObjectLayer(layerId);
    const source = layer.objects.find((entry) => entry?.id === objectId);
    if (!source) throw editError("object-not-found", `对象 ${objectId} 不存在`);
    const duplicate = cloneJsonValue(source);
    delete duplicate.id;
    Object.assign(duplicate, cloneJsonValue(changes || {}));
    return this.addObject(layerId, duplicate, { label: options.label || "复制对象" });
  }

  updateObject(layerId, objectId, changes, options = {}) {
    const layer = this.requireObjectLayer(layerId);
    const object = layer.objects.find((entry) => entry?.id === objectId);
    if (!object) throw editError("object-not-found", `对象 ${objectId} 不存在`);
    const before = {};
    const after = {};
    const beforeMissing = [];
    const afterMissing = [];
    for (const [key, value] of Object.entries(changes || {})) {
      if (key === "id") throw editError("protected-object-field", "不能修改对象 ID");
      if (Object.hasOwn(object, key)) before[key] = cloneJsonValue(object[key]);
      else beforeMissing.push(key);
      if (value === undefined) afterMissing.push(key);
      else after[key] = cloneJsonValue(value);
    }
    if (!Object.keys(changes || {}).length || fieldChangesEqual(before, beforeMissing, after, afterMissing)) return false;
    applyFieldChanges(object, after, afterMissing);
    this.commitEntry({
      type: "object-update",
      label: options.label || "修改对象",
      layerId,
      objectId,
      before,
      beforeMissing,
      after,
      afterMissing,
    });
    return true;
  }

  moveObjects(layerId, objectIds, direction, options = {}) {
    const layer = this.requireObjectLayer(layerId);
    const selected = new Set((Array.isArray(objectIds) ? objectIds : []).map(Number));
    if (!selected.size || [...selected].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw editError("invalid-object-selection", "对象顺序操作需要有效的对象 ID");
    }
    const before = layer.objects.map((object) => object?.id);
    if ([...selected].some((id) => !before.includes(id))) {
      throw editError("object-not-found", "对象顺序操作包含不存在的对象");
    }
    const after = [...before];
    if (direction === "front") {
      after.splice(0, after.length, ...after.filter((id) => !selected.has(id)), ...after.filter((id) => selected.has(id)));
    } else if (direction === "back") {
      after.splice(0, after.length, ...after.filter((id) => selected.has(id)), ...after.filter((id) => !selected.has(id)));
    } else if (direction === "forward") {
      for (let index = after.length - 2; index >= 0; index -= 1) {
        if (selected.has(after[index]) && !selected.has(after[index + 1])) {
          [after[index], after[index + 1]] = [after[index + 1], after[index]];
        }
      }
    } else if (direction === "backward") {
      for (let index = 1; index < after.length; index += 1) {
        if (selected.has(after[index]) && !selected.has(after[index - 1])) {
          [after[index], after[index - 1]] = [after[index - 1], after[index]];
        }
      }
    } else {
      throw editError("invalid-object-order", `不支持的对象顺序操作：${String(direction || "")}`);
    }
    if (before.every((id, index) => id === after[index])) return false;
    reorderObjects(layer, after);
    this.commitEntry({
      type: "object-order",
      label: options.label || "调整对象顺序",
      layerId,
      before,
      after,
    });
    return true;
  }

  removeObject(layerId, objectId, options = {}) {
    const layer = this.requireObjectLayer(layerId);
    const index = layer.objects.findIndex((entry) => entry?.id === objectId);
    if (index < 0) throw editError("object-not-found", `对象 ${objectId} 不存在`);
    const [object] = layer.objects.splice(index, 1);
    this.commitEntry({
      type: "object-remove",
      label: options.label || "删除对象",
      layerId,
      index,
      object: cloneJsonValue(object),
    });
    return cloneJsonValue(object);
  }

  undo() {
    if (this.activeTransaction) throw editError("transaction-active", "请先结束当前地图编辑事务");
    if (this.activeBatch) throw editError("batch-active", "地图批量编辑尚未结束");
    const entry = this.undoStack.pop();
    if (!entry) return false;
    applyHistoryEntry(this.document, entry, false, this);
    this.redoStack.push(entry);
    this.headStateId = entry.beforeStateId;
    this.emit("undo", entry);
    return true;
  }

  redo() {
    if (this.activeTransaction) throw editError("transaction-active", "请先结束当前地图编辑事务");
    if (this.activeBatch) throw editError("batch-active", "地图批量编辑尚未结束");
    const entry = this.redoStack.pop();
    if (!entry) return false;
    applyHistoryEntry(this.document, entry, true, this);
    this.undoStack.push(entry);
    this.headStateId = entry.afterStateId;
    this.emit("redo", entry);
    return true;
  }

  markSaved(stateId = this.headStateId) {
    if (this.activeBatch) throw editError("batch-active", "地图批量编辑尚未结束");
    if (!Number.isSafeInteger(stateId) || stateId < 0) throw new TypeError("stateId must be a non-negative safe integer");
    this.savedStateId = stateId;
    this.emit("saved", null);
  }

  reset(document) {
    if (this.activeBatch) throw editError("batch-active", "地图批量编辑尚未结束");
    if (this.activeTransaction) this.activeTransaction.cancel();
    this.document = cloneTiledDocument(document);
    this.undoStack = [];
    this.redoStack = [];
    this.nextStateId = 1;
    this.headStateId = 0;
    this.savedStateId = 0;
    this.emit("reset", null);
  }

  exportDocument() {
    return cloneTiledDocument(this.document);
  }

  runBatch(label, operation) {
    if (this.activeTransaction) throw editError("transaction-active", "请先结束当前地图编辑事务");
    if (this.activeBatch) throw editError("batch-active", "不能嵌套地图批量编辑");
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const batch = {
      label: String(label || "批量编辑地图"),
      entries: [],
      beforeStateId: this.headStateId,
    };
    this.activeBatch = batch;
    let result;
    try {
      result = operation(this);
      if (result && typeof result.then === "function") {
        throw new TypeError("Tiled edit batches must be synchronous");
      }
      if (this.activeTransaction) {
        throw editError("transaction-active", "地图批量编辑留下了未结束的瓦片事务");
      }
    } catch (error) {
      if (this.activeTransaction) this.activeTransaction.cancel();
      for (const entry of [...batch.entries].reverse()) {
        applyHistoryEntry(this.document, entry, false, this);
      }
      this.activeBatch = null;
      throw error;
    }
    this.activeBatch = null;
    if (!batch.entries.length) return { changed: false, entry: null, result };
      const committed = {
        type: "batch",
        label: batch.label,
        entries: batch.entries,
        structural: batch.entries.some((entry) => entry.structural === true),
        reloadTilesets: batch.entries.some((entry) => entry.reloadTilesets === true),
        layerIds: [...new Set(batch.entries.map((entry) => entry.layerId).filter(Number.isSafeInteger))],
      beforeStateId: batch.beforeStateId,
      afterStateId: this.nextStateId++,
    };
    this.undoStack.push(committed);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.headStateId = committed.afterStateId;
    this.emit("commit", committed);
    return { changed: true, entry: committed, result };
  }

  /**
   * Replace the most recent contiguous history entries with one batch without
   * changing the document. This is used when a user gesture is followed by a
   * synchronous derived edit (for example AutoMap While Drawing) so undo still
   * represents the gesture as one operation.
   */
  groupRecentHistory(count, label, metadata = {}) {
    if (this.activeTransaction) throw editError("transaction-active", "请先结束当前地图编辑事务");
    if (this.activeBatch) throw editError("batch-active", "地图批量编辑尚未结束");
    if (!Number.isSafeInteger(count) || count < 2 || count > this.undoStack.length) {
      throw editError("invalid-history-group", "合并历史需要至少两个连续的撤销项");
    }
    const entries = this.undoStack.slice(-count);
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].afterStateId !== entries[index].beforeStateId) {
        throw editError("noncontiguous-history-group", "只能合并连续的地图历史项");
      }
    }
    const grouped = {
      ...cloneJsonValue(metadata),
      type: "batch",
      label: String(label || "组合地图编辑"),
      entries,
      structural: entries.some((entry) => entry.structural === true),
      reloadTilesets: entries.some((entry) => entry.reloadTilesets === true),
      layerIds: [...new Set(entries.flatMap((entry) => (
        Array.isArray(entry.layerIds) ? entry.layerIds : [entry.layerId]
      )).filter(Number.isSafeInteger))],
      beforeStateId: entries[0].beforeStateId,
      afterStateId: entries.at(-1).afterStateId,
    };
    this.undoStack.splice(this.undoStack.length - count, count, grouped);
    this.emit("group", grouped);
    return grouped;
  }

  requireLayer(layerId) {
    const layer = this.layerById(layerId);
    if (!layer) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
    if (layer.locked === true) throw editError("layer-locked", `图层 ${layer.name || layerId} 已锁定`);
    return layer;
  }

  assertStructuralEditReady() {
    if (this.activeTransaction) throw editError("transaction-active", "请先结束当前地图编辑事务");
  }

  resolveLayerContainer(parentId) {
    if (parentId === null || parentId === undefined) {
      if (!Array.isArray(this.document.layers)) this.document.layers = [];
      return { layers: this.document.layers, parentId: null };
    }
    const entry = this.layerEntryById(parentId);
    if (!entry) throw editError("layer-not-found", `父图层 ${parentId} 不存在`);
    if (entry.layer.type !== "group" || !Array.isArray(entry.layer.layers)) {
      throw editError("not-group-layer", `图层 ${parentId} 不是分组图层`);
    }
    assertLayerEntryEditable(entry, "修改");
    return { layers: entry.layer.layers, parentId: entry.layer.id };
  }

  requireTileLayer(layerId) {
    const layer = this.requireLayer(layerId);
    if (layer.type !== "tilelayer") throw editError("not-tile-layer", "当前图层不是瓦片层");
    if (typeof layer.data === "string" || layer.chunks?.some((chunk) => typeof chunk?.data === "string")) {
      throw editError("encoded-tile-layer", "编码瓦片层需要先按原编码方式解码后再编辑");
    }
    return layer;
  }

  requireObjectLayer(layerId) {
    const layer = this.requireLayer(layerId);
    if (layer.type !== "objectgroup" || !Array.isArray(layer.objects)) {
      throw editError("not-object-layer", "当前图层不是对象层");
    }
    return layer;
  }

  commitEntry(entry) {
    if (this.activeBatch) {
      this.activeBatch.entries.push(entry);
      return entry;
    }
    const committed = {
      ...entry,
      beforeStateId: this.headStateId,
      afterStateId: this.nextStateId++,
    };
    this.undoStack.push(committed);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.headStateId = committed.afterStateId;
    this.emit("commit", committed);
    return committed;
  }

  finishTransaction(transaction) {
    if (this.activeTransaction === transaction) this.activeTransaction = null;
  }

  emit(action, entry) {
    const event = { action, entry, document: this.document, ...this.snapshot() };
    for (const listener of this.listeners) listener(event);
  }
}

class TileStrokeTransaction {
  constructor(owner, layer, options) {
    this.owner = owner;
    this.layer = layer;
    this.kind = options.kind;
    this.label = options.label;
    this.seed = options.seed;
    this.changes = new Map();
    this.createdChunks = new Map();
    this.closed = false;
  }

  set(x, y, encodedGid) {
    this.assertOpen();
    const column = integerCoordinate(x, "x");
    const row = integerCoordinate(y, "y");
    const after = Number(encodedGid) >>> 0;
    const key = `${column},${row}`;
    const existing = this.changes.get(key);
    const beforeRead = readTile(this.layer, column, row);
    if (!beforeRead.exists && after === 0) return false;
    const write = writeTile(this.layer, column, row, after, this.owner);
    if (write.createdChunk) this.createdChunks.set(write.createdChunk.key, write.createdChunk);
    const before = existing ? existing.before : beforeRead.value;
    if (before === after) this.changes.delete(key);
    else this.changes.set(key, { x: column, y: row, before, after });
    return beforeRead.value !== after;
  }

  commit() {
    this.assertOpen();
    this.closed = true;
    this.owner.finishTransaction(this);
    if (!this.changes.size) {
      this.removeUnusedCreatedChunks();
      return false;
    }
    this.owner.commitEntry({
      type: "tile-cells",
      kind: this.kind,
      label: this.label,
      layerId: this.layer.id,
      changes: [...this.changes.values()].map(cloneJsonValue),
      createdChunks: [...this.createdChunks.values()].map(cloneJsonValue),
      ...(this.seed === null ? {} : { seed: this.seed }),
    });
    return true;
  }

  cancel() {
    if (this.closed) return false;
    for (const change of [...this.changes.values()].reverse()) {
      writeTile(this.layer, change.x, change.y, change.before, this.owner, { create: false });
    }
    this.removeCreatedChunks();
    this.closed = true;
    this.owner.finishTransaction(this);
    this.owner.emit("cancel", null);
    return true;
  }

  removeUnusedCreatedChunks() {
    for (const descriptor of this.createdChunks.values()) {
      const chunk = chunkByOrigin(this.layer, descriptor.x, descriptor.y);
      if (chunk?.data.every((value) => Number(value) === 0)) removeChunk(this.layer, descriptor.x, descriptor.y);
    }
  }

  removeCreatedChunks() {
    for (const descriptor of this.createdChunks.values()) removeChunk(this.layer, descriptor.x, descriptor.y);
  }

  assertOpen() {
    if (this.closed) throw editError("transaction-closed", "地图编辑事务已结束");
  }
}

function optionalTileSeed(value) {
  if (value === undefined || value === null) return null;
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw editError("invalid-random-seed", "随机 Seed 必须是 0 到 4294967295 的整数");
  }
  return seed >>> 0;
}

function applyHistoryEntry(document, entry, forward, owner) {
  if (entry.type === "batch") {
    const entries = forward ? entry.entries : [...entry.entries].reverse();
    for (const child of entries) applyHistoryEntry(document, child, forward, owner);
    return;
  }
  if (entry.type === "layer-structure") {
    applyLayerStructureEntry(document, entry, forward);
    return;
  }
  if (entry.type === "tileset-structure") {
    if (!Array.isArray(document.tilesets)) document.tilesets = [];
    const insert = (entry.operation === "add" && forward)
      || (entry.operation === "remove" && !forward);
    if (insert) {
      document.tilesets.splice(entry.index, 0, cloneJsonValue(entry.reference));
    } else {
      const index = document.tilesets.findIndex((candidate) => (
        candidate?.source === entry.reference?.source
        && candidate?.firstgid === entry.reference?.firstgid
      ));
      if (index >= 0) document.tilesets.splice(index, 1);
    }
    return;
  }
  if (entry.type === "tile-cells") {
    const layer = findLayer(document.layers, entry.layerId)?.layer;
    if (!layer) throw editError("layer-not-found", `图层 ${entry.layerId} 不存在`);
    if (forward) {
      for (const descriptor of entry.createdChunks) ensureChunk(layer, descriptor.x, descriptor.y, descriptor.width, descriptor.height);
      for (const change of entry.changes) writeTile(layer, change.x, change.y, change.after, owner);
    } else {
      for (const change of [...entry.changes].reverse()) writeTile(layer, change.x, change.y, change.before, owner, { create: false });
      for (const descriptor of entry.createdChunks) removeChunk(layer, descriptor.x, descriptor.y);
    }
    return;
  }
  if (entry.type === "tile-fill-compact") {
    const layer = findLayer(document.layers, entry.layerId)?.layer;
    if (!layer) throw editError("layer-not-found", `图层 ${entry.layerId} 不存在`);
    const blocks = resolveCompactFillBlocks(layer, entry.blocks);
    const value = forward ? entry.replacement : entry.target;
    for (let index = 0; index < entry.addresses.length; index += 2) {
      const block = blocks[entry.addresses[index]];
      const localIndex = entry.addresses[index + 1];
      if (!block || localIndex < 0 || localIndex >= block.data.length) {
        throw editError("invalid-history-entry", "紧凑填充历史包含无效的瓦片地址");
      }
      block.data[localIndex] = value;
    }
    return;
  }

  const layer = findLayer(document.layers, entry.layerId)?.layer;
  if (!layer) throw editError("layer-not-found", `图层 ${entry.layerId} 不存在`);
  if (entry.type === "layer-update") {
    applyFieldChanges(
      layer,
      forward ? entry.after : entry.before,
      forward ? entry.afterMissing : entry.beforeMissing,
    );
  } else if (entry.type === "object-add") {
    if (forward) {
      layer.objects.splice(entry.index, 0, cloneJsonValue(entry.object));
      document.nextobjectid = entry.nextObjectId;
    } else {
      const index = layer.objects.findIndex((object) => object?.id === entry.object.id);
      if (index >= 0) layer.objects.splice(index, 1);
      document.nextobjectid = entry.previousNextObjectId;
    }
  } else if (entry.type === "object-remove") {
    if (forward) {
      const index = layer.objects.findIndex((object) => object?.id === entry.object.id);
      if (index >= 0) layer.objects.splice(index, 1);
    } else {
      layer.objects.splice(entry.index, 0, cloneJsonValue(entry.object));
    }
  } else if (entry.type === "object-update") {
    const object = layer.objects.find((candidate) => candidate?.id === entry.objectId);
    if (!object) throw editError("object-not-found", `对象 ${entry.objectId} 不存在`);
    applyFieldChanges(
      object,
      forward ? entry.after : entry.before,
      forward ? entry.afterMissing : entry.beforeMissing,
    );
  } else if (entry.type === "object-order") {
    reorderObjects(layer, forward ? entry.after : entry.before);
  }
}

function reorderObjects(layer, orderedIds) {
  const byId = new Map(layer.objects.map((object) => [object?.id, object]));
  if (orderedIds.length !== layer.objects.length || orderedIds.some((id) => !byId.has(id))) {
    throw editError("object-order-conflict", "对象集合已变化，不能应用原有顺序");
  }
  layer.objects.splice(0, layer.objects.length, ...orderedIds.map((id) => byId.get(id)));
}

function readTile(layer, x, y) {
  if (Array.isArray(layer.data)) {
    const startX = Number(layer.startx || 0);
    const startY = Number(layer.starty || 0);
    const width = Number(layer.width || 0);
    const height = Number(layer.height || 0);
    if (x < startX || y < startY || x >= startX + width || y >= startY + height) {
      return { exists: false, value: 0 };
    }
    return { exists: true, value: Number(layer.data[(y - startY) * width + x - startX]) >>> 0 };
  }
  if (Array.isArray(layer.chunks)) {
    const chunk = layer.chunks.find((candidate) => (
      x >= candidate.x && y >= candidate.y && x < candidate.x + candidate.width && y < candidate.y + candidate.height
    ));
    if (!chunk) return { exists: false, value: 0 };
    return { exists: true, value: Number(chunk.data[(y - chunk.y) * chunk.width + x - chunk.x]) >>> 0 };
  }
  return { exists: false, value: 0 };
}

function writeTile(layer, x, y, value, owner, options = {}) {
  if (Array.isArray(layer.data)) {
    const startX = Number(layer.startx || 0);
    const startY = Number(layer.starty || 0);
    const width = Number(layer.width || 0);
    const height = Number(layer.height || 0);
    if (x < startX || y < startY || x >= startX + width || y >= startY + height) {
      throw editError("tile-outside-layer", "瓦片坐标位于有限图层范围外");
    }
    layer.data[(y - startY) * width + x - startX] = value >>> 0;
    return { createdChunk: null };
  }
  if (!Array.isArray(layer.chunks)) throw editError("invalid-tile-layer", "瓦片层没有可编辑数据");
  let chunk = layer.chunks.find((candidate) => (
    x >= candidate.x && y >= candidate.y && x < candidate.x + candidate.width && y < candidate.y + candidate.height
  ));
  let createdChunk = null;
  if (!chunk) {
    if (options.create === false) return { createdChunk: null };
    const originX = Math.floor(x / owner.chunkWidth) * owner.chunkWidth;
    const originY = Math.floor(y / owner.chunkHeight) * owner.chunkHeight;
    chunk = ensureChunk(layer, originX, originY, owner.chunkWidth, owner.chunkHeight);
    createdChunk = {
      key: `${originX},${originY}`,
      x: originX,
      y: originY,
      width: owner.chunkWidth,
      height: owner.chunkHeight,
    };
  }
  chunk.data[(y - chunk.y) * chunk.width + x - chunk.x] = value >>> 0;
  return { createdChunk };
}

function normalizeCompactFillResult(result) {
  if (!result || !(result.addresses instanceof Int32Array) || result.addresses.length % 2 !== 0) {
    throw editError("invalid-fill-result", "填充结果格式无效");
  }
  const count = Number(result.count);
  if (!Number.isSafeInteger(count) || count < 0 || result.addresses.length !== count * 2) {
    throw editError("invalid-fill-result", "填充结果数量不一致");
  }
  const target = compactFillGid(result.target, "填充原值");
  const replacement = compactFillGid(result.replacement, "填充替换值");
  if (!Array.isArray(result.blocks) || !result.blocks.length) {
    throw editError("invalid-fill-result", "填充结果缺少瓦片块定位信息");
  }
  const blocks = Object.freeze(result.blocks.map((value, index) => {
    const kind = value?.kind;
    if (kind !== "data" && kind !== "chunk") {
      throw editError("invalid-fill-result", `填充块 ${index + 1} 类型无效`);
    }
    const x = compactFillInteger(value.x, `填充块 ${index + 1} x`);
    const y = compactFillInteger(value.y, `填充块 ${index + 1} y`);
    const width = compactFillPositiveInteger(value.width, `填充块 ${index + 1} width`);
    const height = compactFillPositiveInteger(value.height, `填充块 ${index + 1} height`);
    const cells = width * height;
    if (!Number.isSafeInteger(cells) || cells > 0x3fff_ffff) {
      throw editError("invalid-fill-result", `填充块 ${index + 1} 尺寸超过安全范围`);
    }
    return Object.freeze({ kind, x, y, width, height });
  }));
  let bounds = null;
  if (result.bounds != null) {
    const minX = compactFillInteger(result.bounds?.minX, "填充范围 minX");
    const minY = compactFillInteger(result.bounds?.minY, "填充范围 minY");
    const maxX = compactFillInteger(result.bounds?.maxX, "填充范围 maxX");
    const maxY = compactFillInteger(result.bounds?.maxY, "填充范围 maxY");
    if (minX > maxX || minY > maxY || count === 0) {
      throw editError("invalid-fill-result", "填充范围无效");
    }
    bounds = Object.freeze({ minX, minY, maxX, maxY });
  } else if (count !== 0) {
    throw editError("invalid-fill-result", "非空填充结果缺少范围");
  }
  return Object.freeze({
    addresses: result.addresses.slice(),
    blocks,
    target,
    replacement,
    count,
    bounds,
  });
}

function resolveCompactFillBlocks(layer, descriptors) {
  const finite = Array.isArray(layer.data);
  if (finite && (descriptors.length !== 1 || descriptors[0].kind !== "data")) {
    throw editError("fill-result-stale", "有限地图的填充块结构已经变化");
  }
  if (!finite && !Array.isArray(layer.chunks)) {
    throw editError("invalid-tile-layer", "瓦片层没有可编辑数据");
  }
  const usedChunks = new Set();
  return descriptors.map((descriptor) => {
    let block;
    if (descriptor.kind === "data") {
      if (!finite) throw editError("fill-result-stale", "瓦片层结构已经变化");
      block = layer;
    } else {
      if (finite) throw editError("fill-result-stale", "瓦片层结构已经变化");
      const matches = layer.chunks.filter((chunk) => chunk.x === descriptor.x && chunk.y === descriptor.y);
      if (matches.length > 1) throw editError("fill-result-stale", "无限地图包含重复原点的瓦片块");
      [block] = matches;
      const key = `${descriptor.x},${descriptor.y}`;
      if (usedChunks.has(key)) throw editError("invalid-fill-result", "填充结果重复引用同一瓦片块");
      usedChunks.add(key);
    }
    const blockX = Number(descriptor.kind === "chunk" ? block?.x : block?.startx ?? 0);
    const blockY = Number(descriptor.kind === "chunk" ? block?.y : block?.starty ?? 0);
    if (
      !block
      || blockX !== descriptor.x
      || blockY !== descriptor.y
      || Number(block.width) !== descriptor.width
      || Number(block.height) !== descriptor.height
      || !Array.isArray(block.data)
      || block.data.length !== descriptor.width * descriptor.height
    ) {
      throw editError("fill-result-stale", "瓦片块结构已经变化，已丢弃旧的填充结果");
    }
    return block;
  });
}

function compactFillGid(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw editError("invalid-fill-result", `${label}不是有效的 Tiled GID`);
  }
  return number >>> 0;
}

function compactFillInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw editError("invalid-fill-result", `${label} 必须是安全整数`);
  return number;
}

function compactFillPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw editError("invalid-fill-result", `${label} 必须是正整数`);
  }
  return number;
}

function ensureChunk(layer, x, y, width, height) {
  const existing = chunkByOrigin(layer, x, y);
  if (existing) return existing;
  const chunk = { data: Array(width * height).fill(0), height, width, x, y };
  layer.chunks.push(chunk);
  layer.chunks.sort((left, right) => left.y - right.y || left.x - right.x);
  return chunk;
}

function chunkByOrigin(layer, x, y) {
  return layer.chunks?.find((chunk) => chunk.x === x && chunk.y === y) || null;
}

function removeChunk(layer, x, y) {
  const index = layer.chunks?.findIndex((chunk) => chunk.x === x && chunk.y === y) ?? -1;
  if (index >= 0) layer.chunks.splice(index, 1);
}

function findLayer(layers, layerId, parent = null, ancestors = []) {
  if (!Array.isArray(layers)) return null;
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (layer?.id === layerId) return { layer, parent, index, siblings: layers, ancestors };
    const nested = findLayer(layer?.layers, layerId, layer, [...ancestors, layer]);
    if (nested) return nested;
  }
  return null;
}

function defaultLayer(document, type) {
  const common = {
    name: type === "group" ? "新建分组" : "新建图层",
    opacity: 1,
    type,
    visible: true,
    x: 0,
    y: 0,
  };
  if (type === "tilelayer") {
    if (document.infinite === true) {
      return { ...common, chunks: [], height: 0, width: 0 };
    }
    const width = nonNegativeInteger(document.width);
    const height = nonNegativeInteger(document.height);
    return { ...common, data: Array(width * height).fill(0), height, width };
  }
  if (type === "objectgroup") return { ...common, draworder: "topdown", objects: [] };
  if (type === "imagelayer") return { ...common, image: "" };
  return { ...common, layers: [] };
}

function allocateLayerTreeIds(document, value) {
  const layer = cloneJsonValue(value);
  let layerId = nextLayerId(document);
  let objectId = nextAvailableObjectId(document);
  const objectIdMap = new Map();
  const visit = (candidate) => {
    candidate.id = layerId;
    layerId += 1;
    if (Array.isArray(candidate.objects)) {
      for (const object of candidate.objects) {
        if (!object || typeof object !== "object") continue;
        const oldId = object.id;
        object.id = objectId;
        if (Number.isSafeInteger(oldId) && oldId > 0) objectIdMap.set(oldId, objectId);
        objectId += 1;
      }
    }
    if (Array.isArray(candidate.layers)) {
      for (const child of candidate.layers) {
        if (child && typeof child === "object" && !Array.isArray(child)) visit(child);
      }
    }
  };
  visit(layer);
  rewriteObjectReferences(layer, objectIdMap);
  document.nextlayerid = layerId;
  document.nextobjectid = objectId;
  return { layer };
}

function rewriteObjectReferences(layer, idMap) {
  const rewriteProperties = (properties) => {
    if (!Array.isArray(properties)) return;
    for (const property of properties) {
      if (property?.type === "object" && idMap.has(property.value)) property.value = idMap.get(property.value);
    }
  };
  rewriteProperties(layer?.properties);
  for (const object of layer?.objects || []) rewriteProperties(object?.properties);
  for (const child of layer?.layers || []) rewriteObjectReferences(child, idMap);
}

function captureIdCounters(document) {
  return {
    hasNextLayerId: Object.hasOwn(document, "nextlayerid"),
    nextLayerId: document.nextlayerid,
    hasNextObjectId: Object.hasOwn(document, "nextobjectid"),
    nextObjectId: document.nextobjectid,
  };
}

function applyIdCounters(document, state) {
  if (state.hasNextLayerId) document.nextlayerid = state.nextLayerId;
  else delete document.nextlayerid;
  if (state.hasNextObjectId) document.nextobjectid = state.nextObjectId;
  else delete document.nextobjectid;
}

function applyLayerStructureEntry(document, entry, forward) {
  if (entry.operation === "add") {
    if (forward) {
      const layers = layerContainerByParentId(document, entry.parentId);
      layers.splice(entry.index, 0, cloneJsonValue(entry.layer));
    } else {
      removeHistoryLayer(document, entry.layerId);
    }
  } else if (entry.operation === "remove") {
    if (forward) {
      removeHistoryLayer(document, entry.layerId);
    } else {
      const layers = layerContainerByParentId(document, entry.parentId);
      layers.splice(entry.index, 0, cloneJsonValue(entry.layer));
    }
  } else if (entry.operation === "move") {
    const destinationParentId = forward ? entry.toParentId : entry.fromParentId;
    const destinationIndex = forward ? entry.toIndex : entry.fromIndex;
    const found = findLayer(document.layers, entry.layerId);
    if (!found) throw editError("layer-not-found", `图层 ${entry.layerId} 不存在`);
    const [layer] = found.siblings.splice(found.index, 1);
    const destination = layerContainerByParentId(document, destinationParentId);
    destination.splice(destinationIndex, 0, layer);
  } else if (entry.operation === "move-many") {
    const moved = new Map();
    for (const layerId of entry.layerIds) {
      const layer = removeHistoryLayer(document, layerId);
      moved.set(layerId, layer);
    }
    if (forward) {
      const destination = layerContainerByParentId(document, entry.toParentId);
      destination.splice(entry.toIndex, 0, ...entry.layerIds.map((layerId) => moved.get(layerId)));
    } else {
      const restorations = [...entry.from].sort((left, right) => left.index - right.index);
      for (const source of restorations) {
        const destination = layerContainerByParentId(document, source.parentId);
        destination.splice(source.index, 0, moved.get(source.layerId));
      }
    }
  } else {
    throw editError("invalid-history-entry", `未知图层结构操作 ${entry.operation}`);
  }
  applyIdCounters(document, forward ? entry.afterIds : entry.beforeIds);
}

function layerContainerByParentId(document, parentId) {
  if (parentId === null || parentId === undefined) {
    if (!Array.isArray(document.layers)) document.layers = [];
    return document.layers;
  }
  const parent = findLayer(document.layers, parentId)?.layer;
  if (!parent || parent.type !== "group" || !Array.isArray(parent.layers)) {
    throw editError("layer-not-found", `父图层 ${parentId} 不存在`);
  }
  return parent.layers;
}

function removeHistoryLayer(document, layerId) {
  const found = findLayer(document.layers, layerId);
  if (!found) throw editError("layer-not-found", `图层 ${layerId} 不存在`);
  return found.siblings.splice(found.index, 1)[0];
}

function flattenedLayerIds(layers, output = []) {
  if (!Array.isArray(layers)) return output;
  for (const layer of layers) {
    if (Number.isSafeInteger(layer?.id)) output.push(layer.id);
    flattenedLayerIds(layer?.layers, output);
  }
  return output;
}

function layerTreeIdSignature(layers) {
  if (!Array.isArray(layers)) return "[]";
  return JSON.stringify(layers.map((layer) => [layer?.id, layerTreeIdSignature(layer?.layers)]));
}

function nextLayerId(document) {
  let maximum = 0;
  visitLayers(document.layers, (layer) => {
    if (Number.isSafeInteger(layer?.id) && layer.id > maximum) maximum = layer.id;
  });
  const declared = Number.isSafeInteger(document.nextlayerid) && document.nextlayerid > 0
    ? document.nextlayerid
    : 1;
  return Math.max(declared, maximum + 1);
}

function nextAvailableObjectId(document) {
  let maximum = 0;
  visitLayers(document.layers, (layer) => {
    for (const object of layer?.objects || []) {
      if (Number.isSafeInteger(object?.id) && object.id > maximum) maximum = object.id;
    }
  });
  return Math.max(nextObjectId(document), maximum + 1);
}

function visitLayers(layers, visitor) {
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    visitor(layer);
    visitLayers(layer?.layers, visitor);
  }
}

function layerParentOption(options, fallback) {
  if (Object.hasOwn(options, "parentId")) return options.parentId;
  if (Object.hasOwn(options, "parentLayerId")) return options.parentLayerId;
  return fallback;
}

function insertionIndex(value, length, fallback = length) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw editError("invalid-layer-index", `图层位置必须是 0 到 ${length} 之间的整数`);
  }
  return value;
}

function validateTilesetSource(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 2_048
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith("/")
    || value.startsWith("//")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    || value.split("/").some((segment) => !segment || segment === ".")
    || !value.toLowerCase().endsWith(".tsj")
  ) {
    throw editError("invalid-tileset-source", "外部瓦片集必须使用有效的相对 .tsj 路径");
  }
  return value;
}

function layerContainsId(layer, layerId) {
  if (layerId === null || layerId === undefined || !Array.isArray(layer?.layers)) return false;
  return layer.layers.some((child) => child?.id === layerId || layerContainsId(child, layerId));
}

function assertLayerEntryEditable(entry, operation) {
  const locked = [...(entry.ancestors || []), entry.layer].find((layer) => layer?.locked === true);
  if (locked) throw editError("layer-locked", `${operation}失败：图层 ${locked.name || locked.id} 已锁定`);
}

function assertLayerTreeEditable(entry, operation) {
  assertLayerEntryEditable(entry, operation);
  let locked = null;
  visitLayers(entry.layer.layers, (layer) => {
    if (!locked && layer?.locked === true) locked = layer;
  });
  if (locked) throw editError("layer-locked", `${operation}失败：子图层 ${locked.name || locked.id} 已锁定`);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function objectWithId(layers, objectId) {
  if (!Array.isArray(layers)) return null;
  for (const layer of layers) {
    const object = layer?.objects?.find((candidate) => candidate?.id === objectId);
    if (object) return object;
    const nested = objectWithId(layer?.layers, objectId);
    if (nested) return nested;
  }
  return null;
}

function nextObjectId(document) {
  return Number.isInteger(document.nextobjectid) && document.nextobjectid > 0 ? document.nextobjectid : 1;
}

function integerCoordinate(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw editError("invalid-tile-coordinate", `${name} 必须是整数瓦片坐标`);
  return number;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldChangesEqual(left, leftMissing, right, rightMissing) {
  return jsonEqual(left, right)
    && jsonEqual([...leftMissing].sort(), [...rightMissing].sort());
}

function applyFieldChanges(target, values, missing = []) {
  for (const key of missing || []) delete target[key];
  Object.assign(target, cloneJsonValue(values || {}));
}

function editError(code, message) {
  return new TiledEditError(code, message);
}
