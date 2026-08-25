const {
  Application,
  CanvasTextMetrics,
  ColorBurnBlend,
  ColorDodgeBlend,
  Container,
  DarkenBlend,
  DifferenceBlend,
  ExclusionBlend,
  Graphics,
  HardLightBlend,
  LightenBlend,
  Matrix,
  OverlayBlend,
  Rectangle,
  SoftLightBlend,
  Sprite,
  Text,
  TextStyle,
  Texture,
  TilingSprite,
} = globalThis.PIXI;
import {
  parseTiledDocument,
  resolveTiledProjectReference,
} from "./tiled-document.js?v=0.44.55";
import { decodeTiledTileLayer } from "./tiled-tile-codec.js?v=0.44.55";
import {
  tiledObjectSemantic,
  tiledPortalReference,
  tiledSpawnIdentifier,
} from "./map-object-model.js?v=0.44.55";
import {
  TiledTilesetError,
  tiledTilesetLayout,
  validateTiledImageSize,
  validateTiledTilesetRanges,
} from "./tiled-tileset-model.js?v=0.44.55";
import {
  decodeGlobalTileId,
  mapPixelBounds,
  parseTiledColor,
  spriteTransformForTile,
  tiledAnimationFrameAt,
  tiledObjectAlignment,
  tiledAlignmentOffset,
  tiledEffectiveParallaxFactor,
  tiledLayerDisplayProperties,
  tiledObjectContainsPoint,
  tiledObjectBounds,
  tiledObjectOpacity,
  tiledObjectsInDrawOrder,
  tiledObjectScreenBounds,
  tiledPixelToScreen,
  tiledPixelTransform,
  tiledParallaxOffset,
  tiledScreenToTile,
  tiledScreenToPixel,
  tiledTilePolygon,
  tiledTileLayerSpriteLayout,
  tiledTileObjectSpriteLayout,
  tiledTileRegionBounds,
  tiledTileRenderPosition,
  tiledTextLayout,
  tiledVisibleTileRange,
  textGraphemes,
  tileLayerCellsInRange,
  tileLayerCellsInRenderOrder,
  tilesetForGlobalId,
} from "./tiled-render-model.js?v=0.44.55";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const OBJECT_COLOR = 0xf6c453;
const COLLISION_COLOR = 0xef6a67;
const SPAWN_COLOR = 0x62d88a;
const PORTAL_COLOR = 0x58b8e8;
const GRID_COLOR = 0xffffff;
const TILE_VIEW_BUFFER = 4;
const TILE_SELECTION_OVERLAY_LIMIT = 5_000;
const AI_PATCH_OVERLAY_LIMIT = 5_000;
const AUTOMAP_OVERLAY_LIMIT = 20_000;
const ADVANCED_BLEND_FILTERS = Object.freeze({
  overlay: OverlayBlend,
  darken: DarkenBlend,
  lighten: LightenBlend,
  "color-dodge": ColorDodgeBlend,
  "color-burn": ColorBurnBlend,
  "hard-light": HardLightBlend,
  "soft-light": SoftLightBlend,
  difference: DifferenceBlend,
  exclusion: ExclusionBlend,
});

export class TiledPixiViewer {
  constructor(options) {
    this.host = options.host;
    this.document = options.document;
    this.sourcePath = options.sourcePath;
    this.loadResourceText = options.loadResourceText;
    this.loadResourceBlob = options.loadResourceBlob;
    this.onCoordinate = options.onCoordinate || (() => {});
    this.onTransform = options.onTransform || (() => {});
    this.onWarning = options.onWarning || (() => {});
    this.renderOptions = {
      preference: options.preference || "webgl",
      antialias: options.antialias !== false,
      resolution: positiveNumber(options.resolution, 1),
      background: options.background || "#171918",
      interactive: options.interactive !== false,
      autoFit: options.autoFit !== false,
      animate: options.animate !== false,
      initialView: options.initialView || null,
    };
    this.bounds = mapPixelBounds(this.document);
    this.layerViews = [];
    this.texturePromises = new Map();
    this.resourceTextures = new Set();
    this.objectUrls = new Set();
    this.frameTextures = new Set();
    this.layerFilters = new Set();
    this.animatedSprites = new Set();
    this.warningKeys = new Set();
    this.animationTimeMs = 0;
    this.pointers = new Map();
    this.gridVisible = true;
    this.interactionMode = "select";
    this.interactionHandlers = {};
    this.selectionRect = null;
    this.aiPatchPreview = null;
    this.aiImpactPreview = null;
    this.automapPreview = null;
    this.vertexOverlay = null;
    this.transformOverlay = null;
    this.layerRebuildPromise = null;
    this.layerRefreshPromises = new Set();
    this.destroyed = false;
  }

  async initialize() {
    try {
      const mapBackground = parseTiledColor(this.document.backgroundcolor);
      this.app = new Application();
      await this.app.init({
        resizeTo: this.host,
        preference: this.renderOptions.preference,
        antialias: this.renderOptions.antialias,
        autoDensity: false,
        resolution: this.renderOptions.resolution,
        background: mapBackground?.color ?? this.renderOptions.background,
        backgroundAlpha: mapBackground?.alpha ?? 1,
        useBackBuffer: true,
        hello: false,
      });
      this.app.canvas.className = "map-canvas";
      this.app.canvas.setAttribute("aria-label", "地图画布");
      this.app.canvas.tabIndex = 0;
      this.host.replaceChildren(this.app.canvas);

      this.world = new Container({ label: "Tiled map" });
      this.mapLayers = new Container({ label: "Map layers" });
      this.grid = new Graphics({ label: "Grid" });
      this.aiPatchOverlay = new Graphics({ label: "AI patch preview" });
      this.selection = new Graphics({ label: "Selection" });
      this.world.addChild(this.mapLayers, this.grid, this.aiPatchOverlay, this.selection);
      this.app.stage.addChild(this.world);

      this.tilesets = await this.loadTilesets();
      this.bounds = this.calculateMapBounds(this.tilesets);
      this.tileOverscan = this.calculateTileOverscan();
      await this.renderLayers(this.document.layers, this.mapLayers, 0);
      if (this.renderOptions.interactive) {
        this.bindViewportControls();
        this.resizeObserver = new ResizeObserver(() => this.transformChanged());
        this.resizeObserver.observe(this.host);
      }
      if (this.renderOptions.animate) {
        this.animationTicker = (ticker) => {
          this.animationTimeMs += ticker.deltaMS;
          this.updateAnimatedSprites();
        };
        this.app.ticker.add(this.animationTicker);
      }
      if (this.renderOptions.autoFit) this.fit();
      else this.setRenderView(this.renderOptions.initialView || { scale: 1, offsetX: 0, offsetY: 0 });
      return this;
    } catch (error) {
      try {
        this.destroy();
      } catch {
        this.host.replaceChildren();
      }
      throw error;
    }
  }

  setLayerVisible(key, visible) {
    const view = this.layerViews.find((entry) => entry.key === key);
    if (!view) return;
    view.container.visible = visible;
    this.refreshVisibleTileLayers();
  }

  setGridVisible(visible) {
    this.gridVisible = Boolean(visible);
    this.redrawGrid();
  }

  setInteractionMode(mode, handlers = {}) {
    this.interactionMode = typeof mode === "string" && mode ? mode : "select";
    this.interactionHandlers = handlers;
    if (this.app?.canvas) this.app.canvas.dataset.tool = this.interactionMode;
  }

  tilePaletteCount() {
    return this.tilesets.reduce((total, tileset) => (
      total + (tileset.layoutKind === "atlas" ? tileset.tileCount : tileset.paletteLocalIds.length)
    ), 0);
  }

  tilePaletteEntries(options = {}) {
    let offset = Math.max(0, Number.isSafeInteger(options.offset) ? options.offset : 0);
    let remaining = Math.max(0, Number.isSafeInteger(options.limit) ? options.limit : 200);
    const entries = [];
    for (const tileset of this.tilesets) {
      if (!remaining) break;
      const count = tileset.layoutKind === "atlas" ? tileset.tileCount : tileset.paletteLocalIds.length;
      if (offset >= count) {
        offset -= count;
        continue;
      }
      const end = Math.min(count, offset + remaining);
      for (let index = offset; index < end; index += 1) {
        const localId = tileset.layoutKind === "atlas" ? index : tileset.paletteLocalIds[index];
        const tile = tileset.textureForLocalId(localId);
        if (!tile) continue;
        entries.push({
          gid: tileset.firstgid + localId,
          localId,
          firstgid: tileset.firstgid,
          tileCount: tileset.tileCount,
          columns: tileset.columns,
          layoutKind: tileset.layoutKind,
          tilesetKey: `${tileset.ownerPath}#${tileset.firstgid}`,
          tilesetName: tileset.definition.name || `Tileset ${tileset.index + 1}`,
          probability: tileset.tileDefinitions.get(localId)?.probability ?? 1,
          ...tile,
        });
      }
      remaining -= end - offset;
      offset = 0;
    }
    return entries;
  }

  terrainPaletteEntries() {
    const entries = [];
    for (const tileset of this.tilesets) {
      for (const [setIndex, source] of (tileset.definition.wangsets || []).entries()) {
        const type = ["corner", "edge", "mixed"].includes(source?.type) ? source.type : "mixed";
        const colors = (Array.isArray(source?.colors) ? source.colors : []).map((color, index) => Object.freeze({
          index: index + 1,
          name: String(color?.name || `Terrain ${index + 1}`),
          color: /^#[a-f0-9]{6}$/iu.test(color?.color) ? color.color : "#808080",
          probability: Number.isFinite(color?.probability) && color.probability >= 0 ? color.probability : 1,
          tile: Number.isSafeInteger(color?.tile) ? color.tile : -1,
        }));
        const wangIdByLocalId = new Map();
        const candidates = [];
        for (const wangtile of Array.isArray(source?.wangtiles) ? source.wangtiles : []) {
          const localId = wangtile?.tileid;
          const wangid = wangtile?.wangid;
          if (!Number.isSafeInteger(localId) || localId < 0 || !Array.isArray(wangid) || wangid.length !== 8) continue;
          if (wangid.some((value) => !Number.isSafeInteger(value) || value < 0 || value > colors.length)) continue;
          if (!tileset.textureForLocalId(localId)) continue;
          const normalizedWangId = Object.freeze([...wangid]);
          const probability = tileset.tileDefinitions.get(localId)?.probability;
          wangIdByLocalId.set(localId, normalizedWangId);
          candidates.push(Object.freeze({
            gid: tileset.firstgid + localId,
            localId,
            wangid: normalizedWangId,
            probability: Number.isFinite(probability) && probability >= 0 ? probability : 1,
          }));
        }
        if (!colors.length || !candidates.length) continue;
        entries.push(Object.freeze({
          key: `${tileset.ownerPath}#${tileset.firstgid}#${setIndex}`,
          name: String(source.name || `Terrain ${setIndex + 1}`),
          className: String(source.class || ""),
          type,
          tilesetName: tileset.definition.name || `Tileset ${tileset.index + 1}`,
          firstgid: tileset.firstgid,
          maxLocalId: tileset.maxLocalId,
          colors: Object.freeze(colors),
          candidates: Object.freeze(candidates),
          wangIdByLocalId,
        }));
      }
    }
    return Object.freeze(entries);
  }

  tileProbability(encodedGid) {
    const tileset = tilesetForGlobalId(this.tilesets, encodedGid);
    if (!tileset) return 1;
    const localId = decodeGlobalTileId(encodedGid).gid - tileset.firstgid;
    const value = tileset.tileDefinitions.get(localId)?.probability;
    const probability = Number(value);
    return value === undefined || !Number.isFinite(probability) || probability < 0 ? 1 : probability;
  }

  pointForLayer(layerId, point) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view) return null;
    let offsetX = 0;
    let offsetY = 0;
    let current = view.container;
    while (current && current !== this.mapLayers) {
      offsetX += current.position.x;
      offsetY += current.position.y;
      current = current.parent;
    }
    const local = { x: point.x - offsetX, y: point.y - offsetY };
    return view.layer.type === "objectgroup"
      ? tiledScreenToPixel(this.document, local.x, local.y)
      : local;
  }

  objectAtPoint(layerId, point) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    const offset = this.layerWorldOffset(layerId);
    if (!view || !offset || view.layer.type !== "objectgroup") return null;
    const screenLocal = { x: point.x - offset.x, y: point.y - offset.y };
    const local = tiledScreenToPixel(this.document, screenLocal.x, screenLocal.y);
    const tolerance = 6 / Math.max(MIN_ZOOM, this.world.scale.x || 1);
    return tiledObjectsInDrawOrder(view.layer).reverse().find((object) => {
      if (object?.point) {
        const origin = tiledPixelToScreen(this.document, object.x, object.y);
        return Math.hypot(screenLocal.x - origin.x, screenLocal.y - origin.y) <= tolerance;
      }
      if (object?.gid || object?.text) {
        const bounds = tiledObjectScreenBounds(this.document, object, {
          alignment: this.tileObjectAlignment(object),
        });
        return screenLocal.x >= bounds.x - tolerance
          && screenLocal.x <= bounds.x + bounds.width + tolerance
          && screenLocal.y >= bounds.y - tolerance
          && screenLocal.y <= bounds.y + bounds.height + tolerance;
      }
      return tiledObjectContainsPoint(object, local, { tolerance });
    }) || null;
  }

  objectWorldBounds(layerId, object, changes = {}) {
    const offset = this.layerWorldOffset(layerId);
    if (!offset || !object) return null;
    const bounds = tiledObjectScreenBounds(this.document, { ...object, ...changes }, {
      pointTolerance: 6 / Math.max(MIN_ZOOM, this.world.scale.x || 1),
      alignment: this.tileObjectAlignment(object),
    });
    return { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y };
  }

  objectLocalBounds(object, changes = {}) {
    const value = { ...object, ...changes };
    const width = Math.max(0, Number(value.width || 0));
    const height = Math.max(0, Number(value.height || 0));
    if (value.gid) {
      const alignment = this.tileObjectAlignment(value);
      const offset = tiledAlignmentOffset(width, height, alignment);
      return { x: Number(value.x || 0) - offset.x, y: Number(value.y || 0) - offset.y, width, height };
    }
    if (value.text) return { x: Number(value.x || 0), y: Number(value.y || 0), width, height };
    return tiledObjectBounds(value, { pointTolerance: 0.5 });
  }

  setAiPatchPreview(patch = null) {
    this.aiPatchPreview = patch && Array.isArray(patch.operations) ? patch : null;
    this.redrawAiPatchPreview();
  }

  setAiImpactPreview(impact = null) {
    this.aiImpactPreview = impact && Array.isArray(impact.heatmap) ? impact : null;
    this.redrawAiPatchPreview();
  }

  setAutomapPreview(preview = null) {
    this.automapPreview = preview && Array.isArray(preview.changes) ? preview : null;
    this.redrawAiPatchPreview();
  }

  redrawAiPatchPreview() {
    if (!this.aiPatchOverlay) return;
    this.aiPatchOverlay.clear();
    if (!this.aiPatchPreview && !this.automapPreview && !this.aiImpactPreview) return;
    const scale = this.world.scale.x || 1;
    let rendered = 0;
    const drawRect = (bounds, destructive = false) => {
      if (!bounds || rendered >= AI_PATCH_OVERLAY_LIMIT) return;
      const color = destructive ? 0xef6a67 : 0xf6c453;
      this.aiPatchOverlay
        .rect(bounds.x, bounds.y, Math.max(1, bounds.width), Math.max(1, bounds.height))
        .fill({ color, alpha: 0.2 })
        .stroke({ color, alpha: 0.95, width: 2 / scale });
      rendered += 1;
    };
    for (const change of this.automapPreview?.changes || []) {
      if (rendered >= AUTOMAP_OVERLAY_LIMIT) break;
      const view = this.layerViews.find((entry) => (
        entry.layer.id === change.layerId
        || (change.layerId == null && entry.layer.name === change.layerName)
      ));
      const offset = view ? this.layerWorldOffset(view.layer.id) : { x: 0, y: 0 };
      if (view && (!offset || view.layer.type !== "tilelayer")) continue;
      const layerX = Number(view?.layer.x || 0);
      const layerY = Number(view?.layer.y || 0);
      const polygon = tiledTilePolygon(this.document, change.x + layerX, change.y + layerY)
        .map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
      if (!polygon.length) continue;
      const color = change.after ? 0x55d6be : 0xef6a67;
      this.aiPatchOverlay
        .poly(polygon.flatMap((point) => [point.x, point.y]))
        .fill({ color, alpha: 0.24 })
        .stroke({ color, alpha: 0.95, width: 1.5 / scale });
      rendered += 1;
    }
    if (!this.aiPatchPreview) return;
    for (const operation of this.aiPatchPreview.operations) {
      if (rendered >= AI_PATCH_OVERLAY_LIMIT) break;
      const view = this.layerViews.find((entry) => entry.layer.id === operation.layerId);
      const offset = this.layerWorldOffset(operation.layerId);
      if (!view || !offset) continue;
      if (operation.op === "set-tiles" || operation.op === "fill-region") {
        const cells = operation.op === "set-tiles"
          ? operation.cells || []
          : [{ x: operation.x, y: operation.y }];
        const layerX = Number(view.layer.x || 0);
        const layerY = Number(view.layer.y || 0);
        for (const cell of cells) {
          if (rendered >= AI_PATCH_OVERLAY_LIMIT) break;
          const polygon = tiledTilePolygon(this.document, cell.x + layerX, cell.y + layerY)
            .map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
          if (!polygon.length) continue;
          this.aiPatchOverlay
            .poly(polygon.flatMap((point) => [point.x, point.y]))
            .fill({ color: 0xf6c453, alpha: 0.2 })
            .stroke({ color: 0xf6c453, alpha: 0.95, width: 1.5 / scale });
          rendered += 1;
        }
        continue;
      }
      if (view.layer.type !== "objectgroup") continue;
      if (operation.op === "add-object") {
        drawRect(this.objectWorldBounds(operation.layerId, operation.object));
        continue;
      }
      const object = view.layer.objects?.find((entry) => entry.id === operation.objectId);
      if (!object) continue;
      drawRect(
        this.objectWorldBounds(operation.layerId, object, operation.changes || {}),
        operation.op === "remove-object",
      );
    }
  }

  setObjectVertexOverlay(layerId, object, options = {}) {
    const points = options.points || object?.polygon || object?.polyline;
    this.vertexOverlay = object && Array.isArray(points)
      ? {
          layerId,
          object,
          points: points.map((point) => ({ x: Number(point.x || 0), y: Number(point.y || 0) })),
          activeIndex: Number.isSafeInteger(options.activeIndex) ? options.activeIndex : null,
        }
      : null;
    this.redrawSelection();
  }

  objectVertexAtPoint(layerId, object, point, points = null) {
    const vertices = this.objectVertexWorldPoints(layerId, object, points);
    const tolerance = 9 / Math.max(MIN_ZOOM, this.world.scale.x || 1);
    let match = null;
    for (const [index, vertex] of vertices.entries()) {
      const distance = Math.hypot(point.x - vertex.x, point.y - vertex.y);
      if (distance <= tolerance && (!match || distance < match.distance)) match = { index, distance };
    }
    return match?.index ?? null;
  }

  objectPointFromWorld(layerId, object, point) {
    const absolute = this.pointForLayer(layerId, point);
    if (!absolute || !object) return null;
    const deltaX = absolute.x - Number(object.x || 0);
    const deltaY = absolute.y - Number(object.y || 0);
    const angle = -Number(object.rotation || 0) * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return {
      x: deltaX * cosine - deltaY * sine,
      y: deltaX * sine + deltaY * cosine,
    };
  }

  objectVertexWorldPoints(layerId, object, points = null) {
    const offset = this.layerWorldOffset(layerId);
    const vertices = points || object?.polygon || object?.polyline;
    if (!offset || !object || !Array.isArray(vertices)) return [];
    const angle = Number(object.rotation || 0) * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return vertices.map((point) => {
      const x = Number(point.x || 0);
      const y = Number(point.y || 0);
      const projected = tiledPixelToScreen(
        this.document,
        Number(object.x || 0) + x * cosine - y * sine,
        Number(object.y || 0) + x * sine + y * cosine,
      );
      return { x: projected.x + offset.x, y: projected.y + offset.y };
    });
  }

  setObjectTransformOverlay(layerId, rect, options = {}) {
    this.transformOverlay = Number.isSafeInteger(layerId) && rect
      ? { layerId, rect: { ...rect }, activeHandle: options.activeHandle || null }
      : null;
    this.redrawSelection();
  }

  objectTransformHandleAtPoint(point) {
    if (!this.transformOverlay) return null;
    const handles = this.objectTransformHandlePoints(this.transformOverlay.layerId, this.transformOverlay.rect);
    const tolerance = 10 / Math.max(MIN_ZOOM, this.world.scale.x || 1);
    let match = null;
    for (const [handle, position] of Object.entries(handles)) {
      const distance = Math.hypot(point.x - position.x, point.y - position.y);
      if (distance <= tolerance && (!match || distance < match.distance)) match = { handle, distance };
    }
    return match?.handle || null;
  }

  objectCoordinatePointWorld(layerId, point) {
    const offset = this.layerWorldOffset(layerId);
    if (!offset) return null;
    const projected = tiledPixelToScreen(this.document, Number(point?.x || 0), Number(point?.y || 0));
    return { x: projected.x + offset.x, y: projected.y + offset.y };
  }

  objectTransformHandlePoints(layerId, rect) {
    const left = Number(rect.x || 0);
    const top = Number(rect.y || 0);
    const right = left + Number(rect.width || 0);
    const bottom = top + Number(rect.height || 0);
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const local = {
      nw: { x: left, y: top },
      n: { x: centerX, y: top },
      ne: { x: right, y: top },
      e: { x: right, y: centerY },
      se: { x: right, y: bottom },
      s: { x: centerX, y: bottom },
      sw: { x: left, y: bottom },
      w: { x: left, y: centerY },
      rotate: { x: centerX, y: top - 20 },
    };
    return Object.fromEntries(Object.entries(local).map(([name, point]) => [
      name,
      this.objectCoordinatePointWorld(layerId, point),
    ]));
  }

  objectsInWorldRect(layerId, rect, options = {}) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view || view.layer.type !== "objectgroup" || !rect) return [];
    const left = Number(rect.x);
    const top = Number(rect.y);
    const right = left + Number(rect.width);
    const bottom = top + Number(rect.height);
    if (![left, top, right, bottom].every(Number.isFinite)) return [];
    return (view.layer.objects || []).filter((object) => {
      if (!object || object.visible === false) return false;
      const bounds = this.objectWorldBounds(layerId, object);
      if (!bounds) return false;
      const objectRight = bounds.x + bounds.width;
      const objectBottom = bounds.y + bounds.height;
      if (options.contains === true) {
        return bounds.x >= left && bounds.y >= top && objectRight <= right && objectBottom <= bottom;
      }
      return objectRight >= left && bounds.x <= right && objectBottom >= top && bounds.y <= bottom;
    });
  }

  imageLayerAtPoint(point) {
    if (!point) return null;
    return [...this.layerViews].reverse().find((view) => {
      if (view.layer.type !== "imagelayer" || !this.layerIsVisible(view)) return false;
      const bounds = this.imageLayerWorldBounds(view.layer.id);
      return bounds
        && point.x >= bounds.x
        && point.x <= bounds.x + bounds.width
        && point.y >= bounds.y
        && point.y <= bounds.y + bounds.height;
    }) || null;
  }

  imageLayerWorldBounds(layerId, changes = null) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view || view.layer.type !== "imagelayer" || !view.imageSize) return null;
    const current = this.containerWorldOffset(view.container);
    if (!changes) {
      return {
        x: current.x,
        y: current.y,
        width: view.imageSize.width,
        height: view.imageSize.height,
      };
    }
    const parent = {
      x: current.x - Number(view.container.position?.x || 0),
      y: current.y - Number(view.container.position?.y || 0),
    };
    const position = this.layerPosition(view, changes ? { ...view.layer, ...changes } : view.layer);
    return {
      x: parent.x + position.x,
      y: parent.y + position.y,
      width: view.imageSize.width,
      height: view.imageSize.height,
    };
  }

  previewImageLayerPosition(layerId, position = null) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view || view.layer.type !== "imagelayer") return null;
    this.applyLayerPosition(view, position ? { ...view.layer, ...position } : view.layer);
    this.updateRepeatedImageLayer(view);
    return this.imageLayerWorldBounds(layerId, position);
  }

  previewObjectPosition(layerId, objectId, position = null) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    const object = view?.layer.objects?.find((entry) => entry?.id === objectId);
    const node = view?.container.children.find((child) => child.__tiledObjectId === objectId);
    if (!object || !node) return;
    this.applyObjectNodeTransform(node, object, position || object);
  }

  previewObjectTransform(layerId, objectId, changes = null) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    const object = view?.layer.objects?.find((entry) => entry?.id === objectId);
    const node = view?.container.children.find((child) => child.__tiledObjectId === objectId);
    if (!object || !node) return;
    const value = changes ? { ...object, ...changes } : object;
    this.applyObjectNodeTransform(node, object, value);
    const content = node.children[0];
    if (!content) return;
    content.rotation = Number(value.rotation || 0) * Math.PI / 180;
    let scaleX = 1;
    let scaleY = 1;
    if (changes && ["width", "height", "polygon", "polyline"].some((field) => Object.hasOwn(changes, field))) {
      const before = this.objectLocalBounds({ ...object, rotation: 0 });
      const after = this.objectLocalBounds({ ...value, rotation: 0 });
      scaleX = before.width > 0 ? after.width / before.width : 1;
      scaleY = before.height > 0 ? after.height / before.height : 1;
    }
    content.scale.set(scaleX, scaleY);
  }

  syncLayerProperties(layerId, { refreshVisibleTiles = true } = {}) {
    if (this.destroyed) return;
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view) return;
    const { layer, container } = view;
    container.label = layer.name || `Layer ${layer.id || ""}`.trim();
    container.visible = layer.visible !== false;
    this.applyLayerDisplayProperties(layer, container);
    this.recalculateLayerParallaxFactors();
    this.updateLayerParallaxPositions();
    this.updateRepeatedImageLayers();
    if (refreshVisibleTiles) this.refreshVisibleTileLayers();
  }

  layerWorldOffset(layerId) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view) return null;
    let x = 0;
    let y = 0;
    let current = view.container;
    while (current && current !== this.mapLayers) {
      x += current.position.x;
      y += current.position.y;
      current = current.parent;
    }
    return { x, y };
  }

  tileCoordinatesForLayer(layerId, point) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    const local = this.pointForLayer(layerId, point);
    if (!view || !local || view.layer.type !== "tilelayer") return null;
    const coordinates = tiledScreenToTile(this.document, local.x, local.y);
    return {
      x: Math.floor(coordinates.x) - Number(view.layer.x || 0),
      y: Math.floor(coordinates.y) - Number(view.layer.y || 0),
    };
  }

  tileRegionWorldBounds(layerId, startColumn, startRow, endColumn, endRow) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    const offset = this.layerWorldOffset(layerId);
    if (!view || !offset || view.layer.type !== "tilelayer") return null;
    const bounds = tiledTileRegionBounds(
      this.document,
      startColumn + Number(view.layer.x || 0),
      startRow + Number(view.layer.y || 0),
      endColumn - startColumn + 1,
      endRow - startRow + 1,
    );
    return { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y };
  }

  objectCoordinateRectWorldBounds(layerId, rect) {
    const offset = this.layerWorldOffset(layerId);
    if (!offset || !rect) return null;
    const bounds = tiledObjectScreenBounds(this.document, rect);
    return { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y };
  }

  tileObjectAlignment(object) {
    if (!object?.gid) return null;
    const tileset = tilesetForGlobalId(this.tilesets, object.gid);
    return tiledObjectAlignment(this.document, tileset);
  }

  calculateMapBounds(tilesets = this.tilesets) {
    return mapPixelBounds(this.document, {
      tileObjectAlignment: (object) => tiledObjectAlignment(
        this.document,
        tilesetForGlobalId(tilesets || [], object?.gid),
      ),
    });
  }

  async refreshLayer(layerId) {
    const rebuild = this.layerRebuildPromise;
    if (rebuild) await rebuild;
    const refresh = this.performLayerRefresh(layerId);
    this.layerRefreshPromises.add(refresh);
    try {
      await refresh;
    } finally {
      this.layerRefreshPromises.delete(refresh);
    }
  }

  async performLayerRefresh(layerId) {
    const view = this.layerViews.find((entry) => entry.layer.id === layerId);
    if (!view || view.layer.type === "group") return;
    this.syncLayerProperties(layerId);
    this.unregisterAnimatedSprites(view.container);
    for (const child of view.container.removeChildren()) child.destroy({ children: true });
    view.repeatSprite = null;
    if (view.layer.type === "tilelayer") await this.renderTileLayer(view);
    else if (view.layer.type === "objectgroup") await this.renderObjectLayer(view.layer, view.container);
    else if (view.layer.type === "imagelayer") await this.renderImageLayer(view.layer, view.container, view);
  }

  async rebuildLayers({ reloadTilesets = false } = {}) {
    const previous = this.layerRebuildPromise;
    const run = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => this.performLayerRebuild({ reloadTilesets: Boolean(reloadTilesets) }));
    this.layerRebuildPromise = run;
    try {
      return await run;
    } finally {
      if (this.layerRebuildPromise === run) this.layerRebuildPromise = null;
    }
  }

  async performLayerRebuild({ reloadTilesets }) {
    if (this.layerRefreshPromises.size) {
      await Promise.allSettled([...this.layerRefreshPromises]);
    }
    if (this.destroyed || !this.app || !this.world || !this.mapLayers) {
      throw new Error("地图查看器尚未就绪或已关闭");
    }

    const previousFrameTextures = new Set(this.frameTextures);
    const previousMapLayers = this.mapLayers;
    const previousLayerViews = this.layerViews;
    const nextMapLayers = new Container({ label: "Map layers" });
    const nextLayerViews = [];
    let nextTilesets = this.tilesets;
    let nextTileOverscan = this.tileOverscan;
    let previousLayerIndex = -1;
    let committed = false;

    try {
      if (reloadTilesets) nextTilesets = await this.loadTilesets();
      nextTileOverscan = this.calculateTileOverscan(nextTilesets);
      await this.renderLayers(this.document.layers, nextMapLayers, 0, {
        views: nextLayerViews,
        tilesets: nextTilesets,
        overscan: nextTileOverscan,
        updateCount: false,
      });
      if (this.destroyed || !this.app || !previousMapLayers.parent) {
        throw new Error("地图查看器已关闭");
      }

      previousLayerIndex = this.world.getChildIndex(previousMapLayers);
      this.world.addChildAt(nextMapLayers, previousLayerIndex);
      this.world.removeChild(previousMapLayers);
      this.mapLayers = nextMapLayers;
      this.layerViews = nextLayerViews;
      this.tilesets = nextTilesets;
      this.tileOverscan = nextTileOverscan;
      this.bounds = this.calculateMapBounds(nextTilesets);
      committed = true;

      this.unregisterAnimatedSprites(previousMapLayers);
      for (const view of previousLayerViews) this.disposeLayerBlendFilter(view.container);
      previousMapLayers.destroy({
        children: true,
        texture: false,
        textureSource: false,
      });
      if (reloadTilesets) this.destroyFrameTextures(previousFrameTextures);
      this.refreshVisibleTileLayers();
      this.redrawGrid();
      this.redrawAiPatchPreview();
      this.redrawSelection();
      this.app?.renderer?.render(this.app.stage);
      return {
        layerCount: this.layerViews.length,
        renderedTileCount: this.layerViews.reduce(
          (total, view) => total + Number(view.tileSpriteCount || 0),
          0,
        ),
        reloadedTilesets: reloadTilesets,
      };
    } finally {
      if (!committed) {
        this.unregisterAnimatedSprites(nextMapLayers);
        for (const view of nextLayerViews) this.disposeLayerBlendFilter(view.container);
        if (nextMapLayers.parent) nextMapLayers.parent.removeChild(nextMapLayers);
        if (
          !this.destroyed
          && this.world
          && !previousMapLayers.parent
          && previousLayerIndex >= 0
        ) {
          this.world.addChildAt(
            previousMapLayers,
            Math.min(previousLayerIndex, this.world.children.length),
          );
        }
        nextMapLayers.destroy({
          children: true,
          texture: false,
          textureSource: false,
        });
        this.layerViews = previousLayerViews;
        if (reloadTilesets) {
          this.destroyFrameTextures(
            new Set([...this.frameTextures].filter((texture) => !previousFrameTextures.has(texture))),
          );
        }
        this.updateRenderedTileCount();
      }
    }
    for (const point of this.aiImpactPreview?.heatmap || []) {
      if (rendered >= AI_PATCH_OVERLAY_LIMIT) break;
      const view = this.layerViews.find((entry) => entry.layer.id === point.layerId);
      const offset = point.layerId == null ? { x: 0, y: 0 } : this.layerWorldOffset(point.layerId);
      if (!offset) continue;
      const layerX = Number(view?.layer.x || 0);
      const layerY = Number(view?.layer.y || 0);
      if (view?.layer.type === "tilelayer" && ["tile", "fill-anchor"].includes(point.kind)) {
        const polygon = tiledTilePolygon(this.document, Number(point.x) + layerX, Number(point.y) + layerY)
          .map((entry) => ({ x: entry.x + offset.x, y: entry.y + offset.y }));
        if (polygon.length) this.aiPatchOverlay.poly(polygon.flatMap((entry) => [entry.x, entry.y])).fill({ color: 0x58b8e8, alpha: 0.16 }).stroke({ color: 0x58b8e8, alpha: 0.8, width: 1 / scale });
      } else {
        this.aiPatchOverlay.circle(Number(point.x) + offset.x, Number(point.y) + offset.y, Math.max(4, 7 / scale)).fill({ color: 0x58b8e8, alpha: 0.32 }).stroke({ color: 0x58b8e8, alpha: 0.9, width: 1 / scale });
      }
      rendered += 1;
    }
  }

  destroyFrameTextures(textures) {
    for (const texture of textures) {
      this.frameTextures.delete(texture);
      try { texture.destroy(false); } catch {}
    }
  }

  setSelectionRect(rect) {
    this.selectionRect = rect ? { ...rect } : null;
    this.redrawSelection();
  }

  /**
   * Extract one map-world rectangle without the editor grid/selection overlay.
   * The returned canvas is in logical map pixels; callers can encode it as a
   * temporary image input without exposing a project path or data URL.
   */
  captureWorldRect(rect, { resolution = 1 } = {}) {
    if (!this.app?.renderer?.extract || !this.mapLayers) throw new Error("地图渲染器尚未准备好");
    const x = Number(rect?.x);
    const y = Number(rect?.y);
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    if (![x, y, width, height].every(Number.isFinite)
      || !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0) {
      throw new Error("地图截图区域无效");
    }
    const normalizedResolution = Number.isFinite(resolution) && resolution > 0 ? resolution : 1;
    const tileViews = this.layerViews.filter((view) => view.decodedLayer);
    try {
      for (const view of tileViews) {
        this.renderVisibleTileLayer(view, {
          force: true,
          updateCount: false,
          requiredRange: this.tileRangeForWorldRect(view, { x, y, width, height }, this.tileOverscan + TILE_VIEW_BUFFER),
        });
      }
      const extracted = this.app.renderer.extract.canvas({
        target: this.mapLayers,
        frame: new Rectangle(x, y, width, height),
        resolution: normalizedResolution,
        clearColor: [0, 0, 0, 0],
      });
      const expectedWidth = Math.max(1, Math.round(width * normalizedResolution));
      const expectedHeight = Math.max(1, Math.round(height * normalizedResolution));
      if (extracted.width === expectedWidth && extracted.height === expectedHeight) return extracted;
      const exact = document.createElement("canvas");
      exact.width = expectedWidth;
      exact.height = expectedHeight;
      exact.getContext("2d")?.drawImage(extracted, 0, 0, expectedWidth, expectedHeight);
      return exact;
    } finally {
      for (const view of tileViews) {
        this.renderVisibleTileLayer(view, { force: true, updateCount: false });
      }
      this.updateRenderedTileCount();
    }
  }

  zoomBy(factor) {
    this.zoomAt({ x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 }, factor);
  }

  panByScreen(x, y) {
    if (!this.world) return;
    this.world.position.x += Number(x) || 0;
    this.world.position.y += Number(y) || 0;
    this.transformChanged();
  }

  viewportCenterWorldPoint() {
    return this.toWorld({
      x: Math.max(1, this.host.clientWidth) / 2,
      y: Math.max(1, this.host.clientHeight) / 2,
    });
  }

  fit(padding = 64) {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const inset = Math.max(0, Number(padding) || 0);
    const scale = clamp(Math.min(
      Math.max(1, width - inset) / Math.max(1, this.bounds.width),
      Math.max(1, height - inset) / Math.max(1, this.bounds.height),
    ), MIN_ZOOM, MAX_ZOOM);
    this.world.scale.set(scale);
    this.world.position.set(
      (width - this.bounds.width * scale) / 2 - this.bounds.x * scale,
      (height - this.bounds.height * scale) / 2 - this.bounds.y * scale,
    );
    this.transformChanged();
  }

  setRenderView({ scale = 1, offsetX = 0, offsetY = 0 } = {}) {
    const normalizedScale = clamp(positiveNumber(scale, 1), MIN_ZOOM, MAX_ZOOM);
    this.world.scale.set(normalizedScale);
    this.world.position.set(
      -this.bounds.x * normalizedScale - Number(offsetX || 0),
      -this.bounds.y * normalizedScale - Number(offsetY || 0),
    );
    this.transformChanged();
  }

  renderView() {
    const scale = positiveNumber(this.world?.scale?.x, 1);
    return Object.freeze({
      scale,
      offsetX: -this.bounds.x * scale - Number(this.world?.position?.x || 0),
      offsetY: -this.bounds.y * scale - Number(this.world?.position?.y || 0),
    });
  }

  setAnimationTime(timeMs) {
    this.animationTimeMs = Math.max(0, Number(timeMs) || 0);
    this.updateAnimatedSprites();
    this.app?.renderer?.render(this.app.stage);
  }

  updateAnimatedSprites() {
    for (const entry of this.animatedSprites) {
      const frame = tiledAnimationFrameAt(entry.frames, this.animationTimeMs);
      if (frame) entry.sprite.texture = frame.texture;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.cancelPointerInteractions();
    if (this.boundWindowInteractionBlur) window.removeEventListener("blur", this.boundWindowInteractionBlur);
    if (this.boundInteractionVisibility) document.removeEventListener("visibilitychange", this.boundInteractionVisibility);
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    if (this.animationTicker) this.app?.ticker?.remove(this.animationTicker);
    this.animatedSprites.clear();
    for (const filter of this.layerFilters) {
      try { filter.destroy(); } catch {}
    }
    this.layerFilters.clear();
    const app = this.app;
    this.app = null;
    try {
      app?.destroy(true, { children: true, texture: false, textureSource: false });
    } catch {
      this.host.replaceChildren();
    }
    for (const texture of this.frameTextures) {
      try { texture.destroy(false); } catch {}
    }
    this.frameTextures.clear();
    for (const texture of this.resourceTextures) {
      try { texture.destroy(true); } catch {}
    }
    this.resourceTextures.clear();
    this.texturePromises.clear();
    this.warningKeys.clear();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  async loadTilesets() {
    const loaded = [];
    for (let index = 0; index < this.document.tilesets.length; index += 1) {
      const reference = this.document.tilesets[index];
      let definition = reference;
      let ownerPath = this.sourcePath;
      if (reference.source) {
        ownerPath = resolveTiledProjectReference(this.sourcePath, reference.source);
        const parsed = parseTiledDocument(await this.loadResourceText(ownerPath), {
          expectedKind: "tileset",
          sourcePath: ownerPath,
        });
        for (const warning of parsed.diagnostics) this.onWarning(warning.message);
        definition = parsed.document;
      }
      loaded.push(await this.prepareTileset({
        firstgid: reference.firstgid,
        definition,
        ownerPath,
        index,
      }));
    }
    return validateTiledTilesetRanges(loaded);
  }

  async prepareTileset(entry) {
    const textures = new Map();
    const tileDefinitions = new Map();
    let baseTexture = null;
    if (entry.definition.image) {
      const imagePath = resolveTiledProjectReference(entry.ownerPath, entry.definition.image);
      baseTexture = await this.textureForResource(imagePath);
    }
    const layout = tiledTilesetLayout(entry.definition, {
      image: baseTexture ? { width: baseTexture.width, height: baseTexture.height } : null,
      label: entry.ownerPath,
    });
    const { tileWidth, tileHeight, margin, spacing } = layout;
    const textureForLocalId = (localId) => {
      if (!Number.isSafeInteger(localId) || localId < 0) return null;
      const existing = textures.get(localId);
      if (existing) return existing;
      if (!baseTexture || layout.kind !== "atlas" || localId >= layout.tileCount) return null;
      const frame = new Rectangle(
        margin + (localId % layout.columns) * (tileWidth + spacing),
        margin + Math.floor(localId / layout.columns) * (tileHeight + spacing),
        tileWidth,
        tileHeight,
      );
      const texture = new Texture({ source: baseTexture.source, frame });
      this.frameTextures.add(texture);
      const tile = { texture, width: tileWidth, height: tileHeight };
      textures.set(localId, tile);
      return tile;
    };

    if (Array.isArray(entry.definition.tiles)) {
      for (const tile of entry.definition.tiles) {
        if (!Number.isInteger(tile?.id)) continue;
        tileDefinitions.set(tile.id, tile);
        if (tile.image) {
          const imagePath = resolveTiledProjectReference(entry.ownerPath, tile.image);
          const texture = await this.textureForResource(imagePath);
          const imageSize = validateTiledImageSize(tile, {
            width: texture.width,
            height: texture.height,
          }, { label: `${entry.definition.name || entry.ownerPath} 瓦片 ${tile.id}` });
          textures.set(tile.id, {
            texture,
            width: imageSize.width,
            height: imageSize.height,
          });
        }
      }
      for (const tile of entry.definition.tiles) {
        if (!Number.isInteger(tile?.id) || !Array.isArray(tile.animation) || !tile.animation.length) continue;
        const animation = tile.animation.map((frame) => {
          const source = textureForLocalId(frame?.tileid);
          const duration = frame?.duration;
          if (!Number.isSafeInteger(duration) || duration <= 0) {
            throw new TiledTilesetError(
              "invalid-animation-duration",
              `${entry.definition.name || entry.ownerPath} 动画瓦片 ${tile.id} 的帧时长必须是正整数`,
            );
          }
          return source ? { texture: source.texture, duration } : null;
        }).filter(Boolean);
        if (animation.length !== tile.animation.length) {
          throw new TiledTilesetError(
            "missing-animation-frame",
            `${entry.definition.name || entry.ownerPath} 动画瓦片 ${tile.id} 引用了不可渲染的帧`,
          );
        }
        const first = textureForLocalId(tile.id) || textureForLocalId(tile.animation[0].tileid);
        if (first) textures.set(tile.id, { ...first, animation });
      }
    }

    const paletteLocalIds = layout.kind === "collection"
      ? [...textures.keys()].sort((left, right) => left - right)
      : null;

    return {
      ...entry,
      textures,
      tileDefinitions,
      tileWidth,
      tileHeight,
      columns: layout.columns,
      layoutKind: layout.kind,
      tileCount: layout.tileCount,
      maxLocalId: layout.maxLocalId,
      availableLocalIds: layout.kind === "collection" ? new Set(paletteLocalIds) : null,
      paletteLocalIds,
      textureForLocalId,
      tileOffsetX: layout.tileOffsetX,
      tileOffsetY: layout.tileOffsetY,
    };
  }

  async textureForResource(resourcePath) {
    if (!this.texturePromises.has(resourcePath)) {
      this.texturePromises.set(resourcePath, this.createResourceTexture(resourcePath));
    }
    return this.texturePromises.get(resourcePath);
  }

  async createResourceTexture(resourcePath) {
    const blob = await this.loadResourceBlob(resourcePath);
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.add(objectUrl);
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    if (typeof image.decode === "function") await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`无法解码地图图片 ${resourcePath}`));
    });
    const texture = Texture.from(image);
    if (this.destroyed) {
      texture.destroy(true);
      throw new Error("地图查看器已关闭");
    }
    this.resourceTextures.add(texture);
    return texture;
  }

  async renderLayers(layers, parent, depth, options = {}) {
    const views = options.views || this.layerViews;
    const tilesets = options.tilesets || this.tilesets;
    const overscan = options.overscan ?? this.tileOverscan;
    const updateCount = options.updateCount !== false;
    for (let index = 0; index < layers.length; index += 1) {
      const layer = layers[index];
      const container = new Container({ label: layer.name || `Layer ${layer.id || index + 1}` });
      container.visible = layer.visible !== false;
      this.applyLayerDisplayProperties(layer, container);
      parent.addChild(container);
      const effectiveParallax = tiledEffectiveParallaxFactor(layer, {
        x: options.parentParallaxX ?? 1,
        y: options.parentParallaxY ?? 1,
      });
      const key = `${depth}:${index}:${layer.id ?? "unknown"}`;
      const view = {
        key,
        layer,
        container,
        depth,
        decodedLayer: null,
        renderedRange: null,
        tileSpriteCount: 0,
        effectiveParallax,
        imageSize: null,
        repeatSprite: null,
      };
      views.push(view);
      this.applyLayerPosition(view);

      if (layer.type === "group") {
        await this.renderLayers(layer.layers || [], container, depth + 1, {
          ...options,
          parentParallaxX: effectiveParallax.x,
          parentParallaxY: effectiveParallax.y,
        });
      } else if (layer.type === "tilelayer") {
        await this.renderTileLayer(view, { tilesets, overscan, updateCount });
      } else if (layer.type === "objectgroup") {
        await this.renderObjectLayer(layer, container, { tilesets });
      } else if (layer.type === "imagelayer") {
        await this.renderImageLayer(layer, container, view);
      } else {
        this.onWarning(`未识别的图层类型 ${layer.type} 已保留但未渲染`);
      }
    }
  }

  async renderTileLayer(view, {
    tilesets = this.tilesets,
    overscan = this.tileOverscan,
    updateCount = true,
  } = {}) {
    view.decodedLayer = await decodeTiledTileLayer(view.layer);
    view.renderedRange = null;
    view.container.sortableChildren = this.document.orientation !== "orthogonal";
    this.renderVisibleTileLayer(view, {
      force: true,
      tilesets,
      overscan,
      updateCount,
    });
  }

  renderVisibleTileLayer(view, {
    force = false,
    updateCount = true,
    tilesets = this.tilesets,
    overscan = this.tileOverscan,
    requiredRange = null,
  } = {}) {
    if (this.destroyed || !view?.decodedLayer || view.layer.type !== "tilelayer") return;
    const visible = this.layerIsVisible(view);
    const targetRange = visible ? (requiredRange || this.visibleTileRange(view, overscan)) : null;
    if (
      !force
      && visible
      && view.renderedRange
      && tileRangeContains(view.renderedRange, targetRange)
    ) return;
    if (!force && !visible && view.renderedRange === null && view.tileSpriteCount === 0) return;

    this.unregisterAnimatedSprites(view.container);
    for (const child of view.container.removeChildren()) child.destroy({ children: true });
    view.tileSpriteCount = 0;
    view.renderedRange = visible
      ? (requiredRange || this.visibleTileRange(view, overscan + TILE_VIEW_BUFFER))
      : null;
    if (!visible) {
      if (updateCount) this.updateRenderedTileCount();
      return;
    }

    const cells = this.document.orientation === "orthogonal"
      ? tileLayerCellsInRenderOrder(view.decodedLayer, view.renderedRange, this.document.renderorder)
      : tileLayerCellsInRange(view.decodedLayer, view.renderedRange);
    for (const cell of cells) {
      const decoded = decodeGlobalTileId(cell.encodedGid);
      const tileset = tilesetForGlobalId(tilesets, decoded.gid);
      if (!tileset) {
        this.warnOnce(`missing-tileset:${decoded.gid}`, `瓦片 GID ${decoded.gid} 没有匹配的瓦片集`);
        continue;
      }
      const tile = tileset.textureForLocalId(decoded.gid - tileset.firstgid);
      if (!tile) {
        this.warnOnce(`missing-tile:${decoded.gid}`, `瓦片 GID ${decoded.gid} 没有可渲染图片`);
        continue;
      }
      const sprite = new Sprite({ texture: tile.texture });
      const transform = spriteTransformForTile(decoded, {
        hexagonal: this.document.orientation === "hexagonal",
      });
      const renderPosition = tiledTileRenderPosition(
        this.document,
        cell.column + Number(view.layer.x || 0),
        cell.row + Number(view.layer.y || 0),
      );
      const layout = tiledTileLayerSpriteLayout(this.document, tileset, tile, renderPosition);
      sprite.anchor.set(0.5);
      sprite.position.set(layout.x, layout.y);
      if (view.container.sortableChildren) sprite.zIndex = renderPosition.y;
      sprite.rotation = transform.rotation;
      sprite.scale.set(layout.scaleX * transform.scaleX, layout.scaleY * transform.scaleY);
      view.container.addChild(sprite);
      this.registerAnimatedSprite(sprite, tile);
      view.tileSpriteCount += 1;
    }
    if (updateCount) this.updateRenderedTileCount();
  }

  refreshVisibleTileLayers() {
    if (this.destroyed) return;
    for (const view of this.layerViews) {
      if (view.decodedLayer) this.renderVisibleTileLayer(view, { updateCount: false });
    }
    this.updateRenderedTileCount();
  }

  visibleTileRange(view, padding = 0) {
    const scale = Math.max(Number.EPSILON, Number(this.world?.scale?.x) || 1);
    const offset = this.containerWorldOffset(view.container);
    const width = Math.max(1, this.host.clientWidth || this.app?.screen?.width || 1);
    const height = Math.max(1, this.host.clientHeight || this.app?.screen?.height || 1);
    const left = -Number(this.world?.position?.x || 0) / scale - offset.x;
    const top = -Number(this.world?.position?.y || 0) / scale - offset.y;
    const range = tiledVisibleTileRange(this.document, {
      left,
      top,
      right: left + width / scale,
      bottom: top + height / scale,
    }, padding);
    const layerX = Number(view.layer.x || 0);
    const layerY = Number(view.layer.y || 0);
    return {
      startColumn: range.startColumn - layerX,
      endColumn: range.endColumn - layerX,
      startRow: range.startRow - layerY,
      endRow: range.endRow - layerY,
    };
  }

  tileRangeForWorldRect(view, rect, padding = 0) {
    const offset = this.containerWorldOffset(view.container);
    const range = tiledVisibleTileRange(this.document, {
      left: rect.x - offset.x,
      top: rect.y - offset.y,
      right: rect.x + rect.width - offset.x,
      bottom: rect.y + rect.height - offset.y,
    }, padding);
    const layerX = Number(view.layer.x || 0);
    const layerY = Number(view.layer.y || 0);
    return {
      startColumn: range.startColumn - layerX,
      endColumn: range.endColumn - layerX,
      startRow: range.startRow - layerY,
      endRow: range.endRow - layerY,
    };
  }

  containerWorldOffset(container) {
    let x = 0;
    let y = 0;
    let current = container;
    while (current && current !== this.mapLayers) {
      x += Number(current.position?.x || 0);
      y += Number(current.position?.y || 0);
      current = current.parent;
    }
    return { x, y };
  }

  layerIsVisible(view) {
    let current = view.container;
    while (current && current !== this.mapLayers) {
      if (current.visible === false) return false;
      current = current.parent;
    }
    return true;
  }

  calculateTileOverscan(tilesets = this.tilesets) {
    const mapTileWidth = positiveNumber(this.document.tilewidth, 1);
    const mapTileHeight = positiveNumber(this.document.tileheight, 1);
    let padding = 2;
    for (const tileset of tilesets) {
      let maximumWidth = positiveNumber(tileset.tileWidth, mapTileWidth);
      let maximumHeight = positiveNumber(tileset.tileHeight, mapTileHeight);
      for (const tile of tileset.textures.values()) {
        maximumWidth = Math.max(maximumWidth, positiveNumber(tile.width, maximumWidth));
        maximumHeight = Math.max(maximumHeight, positiveNumber(tile.height, maximumHeight));
      }
      padding = Math.max(
        padding,
        Math.ceil((maximumWidth + Math.abs(Number(tileset.tileOffsetX || 0))) / mapTileWidth),
        Math.ceil((maximumHeight + Math.abs(Number(tileset.tileOffsetY || 0))) / mapTileHeight),
      );
    }
    return padding;
  }

  updateRenderedTileCount() {
    if (!this.app?.canvas) return;
    const count = this.layerViews.reduce((total, view) => total + Number(view.tileSpriteCount || 0), 0);
    this.app.canvas.dataset.renderedTiles = String(count);
  }

  warnOnce(key, message) {
    if (this.warningKeys.has(key)) return;
    this.warningKeys.add(key);
    this.onWarning(message);
  }

  viewportWorldRect() {
    const scale = Math.max(Number.EPSILON, Number(this.world?.scale?.x) || 1);
    const width = Math.max(1, this.host.clientWidth || this.app?.screen?.width || 1);
    const height = Math.max(1, this.host.clientHeight || this.app?.screen?.height || 1);
    const left = -Number(this.world?.position?.x || 0) / scale;
    const top = -Number(this.world?.position?.y || 0) / scale;
    return { left, top, width: width / scale, height: height / scale };
  }

  layerPosition(view, layer = view?.layer) {
    if (!view?.container || !view.layer) return;
    let x = Number(layer.offsetx || 0);
    let y = Number(layer.offsety || 0);
    if (["group", "objectgroup", "imagelayer"].includes(layer.type)) {
      x += Number(layer.x || 0);
      y += Number(layer.y || 0);
    }
    if (layer.type !== "group") {
      const viewport = this.viewportWorldRect();
      const offset = tiledParallaxOffset(this.document, view.effectiveParallax, {
        x: viewport.left + viewport.width / 2,
        y: viewport.top + viewport.height / 2,
      });
      x += offset.x;
      y += offset.y;
    }
    return { x, y };
  }

  applyLayerPosition(view, layer = view?.layer) {
    const position = this.layerPosition(view, layer);
    if (position) view.container.position.set(position.x, position.y);
  }

  updateLayerParallaxPositions() {
    for (const view of this.layerViews) this.applyLayerPosition(view);
  }

  recalculateLayerParallaxFactors(views = this.layerViews) {
    const byContainer = new Map(views.map((view) => [view.container, view]));
    for (const view of views) {
      const parentFactor = byContainer.get(view.container.parent)?.effectiveParallax || { x: 1, y: 1 };
      view.effectiveParallax = tiledEffectiveParallaxFactor(view.layer, parentFactor);
    }
  }

  updateRepeatedImageLayers() {
    for (const view of this.layerViews) this.updateRepeatedImageLayer(view);
  }

  updateRepeatedImageLayer(view) {
    const sprite = view?.repeatSprite;
    if (!sprite) return;
    const viewport = this.viewportWorldRect();
    const offset = this.containerWorldOffset(view.container);
    const repeatX = view.layer.repeatx === true;
    const repeatY = view.layer.repeaty === true;
    const startX = repeatX ? viewport.left - offset.x : 0;
    const startY = repeatY ? viewport.top - offset.y : 0;
    sprite.position.set(startX, startY);
    sprite.width = repeatX ? viewport.width : sprite.texture.width;
    sprite.height = repeatY ? viewport.height : sprite.texture.height;
    sprite.tilePosition.set(-startX, -startY);
  }

  applyLayerDisplayProperties(layer, container) {
    const display = tiledLayerDisplayProperties(layer);
    container.tint = display.tint;
    const BlendFilter = ADVANCED_BLEND_FILTERS[display.blendMode];
    if (BlendFilter) {
      if (container.__tiledBlendFilterMode !== display.blendMode) {
        this.disposeLayerBlendFilter(container);
        container.__tiledBlendFilter = new BlendFilter();
        container.__tiledBlendFilterMode = display.blendMode;
        this.layerFilters?.add(container.__tiledBlendFilter);
      }
      container.__tiledBlendFilter.resources.blendUniforms.uniforms.uBlend = display.alpha;
      container.filters = [container.__tiledBlendFilter];
      container.alpha = 1;
      container.blendMode = "normal";
    } else {
      this.disposeLayerBlendFilter(container);
      container.filters = null;
      container.alpha = display.alpha;
      container.blendMode = display.blendMode;
    }
    if (display.unsupportedBlendMode) {
      this.warnOnce(
        `unsupported-blend-mode:${display.unsupportedBlendMode}`,
        `图层 ${layer.name || layer.id} 的混合模式 ${display.unsupportedBlendMode} 无法渲染，已按 normal 显示`,
      );
    }
  }

  disposeLayerBlendFilter(container) {
    const filter = container?.__tiledBlendFilter;
    if (!filter) return;
    this.layerFilters?.delete(filter);
    try { filter.destroy(); } catch {}
    container.__tiledBlendFilter = null;
    container.__tiledBlendFilterMode = null;
  }

  async renderObjectLayer(layer, container, { tilesets = this.tilesets } = {}) {
    const color = parseTiledColor(layer.color) || { color: OBJECT_COLOR, alpha: 1 };
    const orderedObjects = tiledObjectsInDrawOrder(layer);
    this.renderLocalPortalLinks(orderedObjects, container);
    for (const object of orderedObjects) {
      if (object.visible === false) continue;
      const node = new Container({ label: object.name || object.class || object.type || `Object ${object.id}` });
      node.__tiledObjectId = object.id;
      node.alpha = tiledObjectOpacity(object);
      this.applyObjectNodeTransform(node, object, object);
      container.addChild(node);
      const content = new Container();
      content.rotation = Number(object.rotation || 0) * Math.PI / 180;
      node.addChild(content);
      if (object.gid) {
        this.renderTileObject(object, content, { tilesets });
        continue;
      }
      const graphics = new Graphics();
      const semantic = tiledObjectSemantic(object);
      const layerCollision = /collision|solid|wall/iu.test(String(layer.class || ""));
      const strokeColor = semantic === "collision" || layerCollision
        ? COLLISION_COLOR
        : semantic === "spawn"
          ? SPAWN_COLOR
          : semantic === "portal"
            ? PORTAL_COLOR
            : color.color;
      const fill = { color: strokeColor, alpha: Math.min(0.22, color.alpha) };
      const stroke = { color: strokeColor, alpha: Math.max(0.75, color.alpha), width: 1.5 };
      const width = Math.max(0, Number(object.width || 0));
      const height = Math.max(0, Number(object.height || 0));
      if (Array.isArray(object.polygon)) {
        graphics.poly(object.polygon.flatMap((point) => [Number(point.x || 0), Number(point.y || 0)])).fill(fill).stroke(stroke);
      } else if (Array.isArray(object.polyline)) {
        const points = object.polyline;
        if (points.length) {
          graphics.moveTo(Number(points[0].x || 0), Number(points[0].y || 0));
          for (const point of points.slice(1)) graphics.lineTo(Number(point.x || 0), Number(point.y || 0));
          graphics.stroke(stroke);
        }
      } else if (object.ellipse) {
        graphics.ellipse(width / 2, height / 2, width / 2, height / 2).fill(fill).stroke(stroke);
      } else if (object.point) {
        graphics.circle(0, 0, 4).fill({ color: strokeColor, alpha: 0.9 }).stroke({ color: 0xffffff, width: 1 });
      } else if (object.capsule === true) {
        graphics.roundRect(0, 0, Math.max(1, width), Math.max(1, height), Math.min(width, height) / 2).fill(fill).stroke(stroke);
      } else {
        graphics.rect(0, 0, Math.max(1, width), Math.max(1, height)).fill(fill).stroke(stroke);
      }
      content.addChild(graphics);
      if (object.text?.text) {
        this.renderTextObject(object, content);
      }
    }
  }

  renderLocalPortalLinks(objects, container) {
    const spawns = new Map();
    for (const object of objects) {
      const identifier = tiledSpawnIdentifier(object);
      if (identifier && !spawns.has(identifier)) spawns.set(identifier, object);
    }
    const links = [];
    for (const portal of objects) {
      const reference = tiledPortalReference(portal);
      if (!reference?.targetSpawn) continue;
      let targetMap = this.sourcePath;
      if (reference.targetMap) {
        try {
          targetMap = resolveTiledProjectReference(this.sourcePath, reference.targetMap);
        } catch {
          continue;
        }
      }
      if (targetMap !== this.sourcePath) continue;
      const spawn = spawns.get(reference.targetSpawn);
      if (!spawn) continue;
      links.push({ start: this.semanticObjectAnchor(portal), end: this.semanticObjectAnchor(spawn) });
    }
    if (!links.length) return;
    const graphics = new Graphics({ label: "Local portal links" });
    for (const { start, end } of links) {
      graphics.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({
        color: PORTAL_COLOR,
        alpha: 0.72,
        width: 1.5,
      });
      graphics.circle(end.x, end.y, 3).fill({ color: SPAWN_COLOR, alpha: 0.9 });
    }
    container.addChild(graphics);
  }

  semanticObjectAnchor(object) {
    const semantic = tiledObjectSemantic(object);
    const x = Number(object?.x || 0) + (semantic === "portal" && !object?.point ? Number(object?.width || 0) / 2 : 0);
    const y = Number(object?.y || 0) + (semantic === "portal" && !object?.point ? Number(object?.height || 0) / 2 : 0);
    return tiledPixelToScreen(this.document, x, y);
  }

  renderTextObject(object, container) {
    const width = Math.max(0, Number(object.width || 0));
    const height = Math.max(0, Number(object.height || 0));
    if (!width || !height) return;
    const text = object.text;
    const color = parseTiledColor(text.color) || { color: 0x000000, alpha: 1 };
    const baseStyle = {
      fill: color,
      fontFamily: text.fontfamily || "sans-serif",
      fontSize: positiveNumber(text.pixelsize, 16),
      fontStyle: text.italic === true ? "italic" : "normal",
      fontWeight: text.bold === true ? "bold" : "normal",
      lineHeight: positiveNumber(text.pixelsize, 16),
    };
    const textStyle = typeof TextStyle === "function" ? new TextStyle(baseStyle) : baseStyle;
    const measureKerned = (value) => {
      if (CanvasTextMetrics?.measureText) return CanvasTextMetrics.measureText(value, textStyle).width;
      return textGraphemes(value).length * baseStyle.fontSize * 0.6;
    };
    const measure = text.kerning === false
      ? (value) => textGraphemes(value).reduce((total, grapheme) => total + measureKerned(grapheme), 0)
      : measureKerned;
    const layout = tiledTextLayout(text, width, height, measure);
    const textContainer = new Container({ label: `Text ${object.id || ""}`.trim() });
    const clip = new Graphics({ label: "Text clip" });
    clip.rect(0, 0, width, height).fill({ color: 0xffffff, alpha: 1 });
    textContainer.addChild(clip);
    textContainer.mask = clip;
    container.addChild(textContainer);

    for (const line of layout.lines) {
      const drawnWidth = line.justified ? width : line.width;
      if (line.text) {
        if (line.justified) {
          this.renderJustifiedTextLine(
            textContainer,
            line,
            width,
            baseStyle,
            measure,
            layout.format.kerning,
          );
        } else if (layout.format.kerning) {
          this.addTextRun(textContainer, line.text, line.x, line.y, baseStyle);
        } else {
          this.renderUnkernedTextRun(textContainer, line.text, line.x, line.y, baseStyle, measureKerned);
        }
      }
      if ((layout.format.underline || layout.format.strikeout) && drawnWidth > 0) {
        const decoration = new Graphics({ label: "Text decoration" });
        const stroke = {
          color: color.color,
          alpha: color.alpha,
          width: Math.max(1, layout.format.pixelSize / 14),
        };
        if (layout.format.underline) {
          const y = line.y + layout.format.pixelSize * 0.9;
          decoration.moveTo(line.x, y).lineTo(line.x + drawnWidth, y).stroke(stroke);
        }
        if (layout.format.strikeout) {
          const y = line.y + layout.format.pixelSize * 0.55;
          decoration.moveTo(line.x, y).lineTo(line.x + drawnWidth, y).stroke(stroke);
        }
        textContainer.addChild(decoration);
      }
    }
  }

  renderJustifiedTextLine(container, line, width, style, measure, kerning) {
    const words = line.text.match(/\S+/gu) || [];
    if (words.length < 2) {
      this.addTextRun(container, line.text, 0, line.y, style);
      return;
    }
    const contentWidth = words.reduce((total, word) => total + measure(word), 0);
    const gap = Math.max(0, (width - contentWidth) / (words.length - 1));
    let x = 0;
    for (const word of words) {
      if (kerning) this.addTextRun(container, word, x, line.y, style);
      else this.renderUnkernedTextRun(container, word, x, line.y, style, measure);
      x += measure(word) + gap;
    }
  }

  renderUnkernedTextRun(container, value, startX, y, style, measure) {
    let x = startX;
    for (const grapheme of textGraphemes(value)) {
      this.addTextRun(container, grapheme, x, y, style);
      x += measure(grapheme);
    }
  }

  addTextRun(container, value, x, y, style) {
    const node = new Text({ text: value, style });
    node.position.set(x, y);
    container.addChild(node);
    return node;
  }

  applyObjectNodeTransform(node, object, position) {
    const x = Number(position?.x || 0);
    const y = Number(position?.y || 0);
    const projectShape = ["isometric", "oblique"].includes(this.document.orientation)
      && !object?.gid
      && !object?.text
      && !object?.point;
    if (projectShape) {
      const transform = tiledPixelTransform(this.document, x, y);
      node.setFromMatrix(new Matrix(
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.tx,
        transform.ty,
      ));
      return;
    }
    const origin = tiledPixelToScreen(this.document, x, y);
    node.setFromMatrix(new Matrix(1, 0, 0, 1, origin.x, origin.y));
  }

  renderTileObject(object, container, { tilesets = this.tilesets } = {}) {
    const decoded = decodeGlobalTileId(object.gid);
    const tileset = tilesetForGlobalId(tilesets, decoded.gid);
    const tile = tileset?.textureForLocalId(decoded.gid - tileset.firstgid);
    if (!tile) return;
    const transform = spriteTransformForTile(decoded, {
      hexagonal: this.document.orientation === "hexagonal",
    });
    const layout = tiledTileObjectSpriteLayout(this.document, tileset, tile, object);
    const sprite = new Sprite({ texture: tile.texture });
    sprite.anchor.set(0.5);
    sprite.position.set(layout.x, layout.y);
    sprite.scale.set(layout.scaleX * transform.scaleX, layout.scaleY * transform.scaleY);
    sprite.rotation = transform.rotation;
    container.addChild(sprite);
    this.registerAnimatedSprite(sprite, tile);
  }

  registerAnimatedSprite(sprite, tile) {
    if (!Array.isArray(tile?.animation) || !tile.animation.length) return;
    this.animatedSprites.add({ sprite, frames: tile.animation });
    const frame = tiledAnimationFrameAt(tile.animation, this.animationTimeMs);
    if (frame) sprite.texture = frame.texture;
  }

  unregisterAnimatedSprites(container) {
    for (const entry of this.animatedSprites) {
      let current = entry.sprite;
      while (current && current !== container) current = current.parent;
      if (current === container) this.animatedSprites.delete(entry);
    }
  }

  async renderImageLayer(layer, container, view = null) {
    const imagePath = resolveTiledProjectReference(this.sourcePath, layer.image);
    const texture = await this.textureForResource(imagePath);
    const sprite = layer.repeatx || layer.repeaty
      ? new TilingSprite({ texture, width: texture.width, height: texture.height })
      : new Sprite({ texture });
    container.addChild(sprite);
    if (view) view.imageSize = { width: texture.width, height: texture.height };
    if (view && (layer.repeatx || layer.repeaty)) {
      view.repeatSprite = sprite;
      this.updateRepeatedImageLayer(view);
    }
  }

  bindViewportControls() {
    const canvas = this.app.canvas;
    canvas.style.touchAction = "none";
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomAt(this.screenPoint(event), Math.exp(-event.deltaY * 0.001));
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => {
      try { canvas.setPointerCapture(event.pointerId); } catch {}
      const screen = this.screenPoint(event);
      const action = this.interactionMode === "hand" || event.button !== 0 ? "pan" : "tool";
      this.pointers.set(event.pointerId, { screen, action });
      if (this.pointers.size > 1) {
        if ([...this.pointers.values()].some((pointer) => pointer.action === "tool")) {
          this.interactionHandlers.cancel?.();
        }
        for (const pointer of this.pointers.values()) pointer.action = "pinch";
      } else if (action === "tool") {
        this.interactionHandlers.pointerDown?.({
          point: this.toWorld(screen),
          pointerType: event.pointerType,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        });
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      const current = this.screenPoint(event);
      const pointer = this.pointers.get(event.pointerId);
      if (pointer) {
        const previous = pointer.screen;
        const before = [...this.pointers.values()].map((entry) => entry.screen);
        pointer.screen = current;
        const after = [...this.pointers.values()].map((entry) => entry.screen);
        if (after.length === 1) {
          if (pointer.action === "pan") {
            this.world.position.x += current.x - previous.x;
            this.world.position.y += current.y - previous.y;
            this.transformChanged();
          } else if (pointer.action === "tool") {
            this.interactionHandlers.pointerMove?.({ point: this.toWorld(current), pointerType: event.pointerType });
          }
        } else if (after.length === 2 && before.length === 2) {
          const oldMidpoint = midpoint(before[0], before[1]);
          const newMidpoint = midpoint(after[0], after[1]);
          const oldDistance = distance(before[0], before[1]);
          const newDistance = distance(after[0], after[1]);
          const worldPoint = this.toWorld(oldMidpoint);
          const scale = clamp(this.world.scale.x * (newDistance / Math.max(1, oldDistance)), MIN_ZOOM, MAX_ZOOM);
          this.world.scale.set(scale);
          this.world.position.set(
            newMidpoint.x - worldPoint.x * scale,
            newMidpoint.y - worldPoint.y * scale,
          );
          this.transformChanged();
        }
      }
      const world = this.toWorld(current);
      this.onCoordinate(world);
    });
    const release = (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (pointer?.action === "tool") {
        this.interactionHandlers.pointerUp?.({ point: this.toWorld(pointer.screen), pointerType: event.pointerType });
      }
      this.pointers.delete(event.pointerId);
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (pointer?.action === "tool") this.interactionHandlers.cancel?.();
      this.pointers.delete(event.pointerId);
    });
    canvas.addEventListener("lostpointercapture", (event) => {
      if (this.pointers.has(event.pointerId)) this.cancelPointerInteractions();
    });
    canvas.addEventListener("pointerleave", (event) => {
      const tracked = this.pointers.has(event.pointerId);
      const captured = typeof canvas.hasPointerCapture === "function" && canvas.hasPointerCapture(event.pointerId);
      if (tracked && !captured) this.cancelPointerInteractions();
      else if (!tracked) this.onCoordinate(null);
    });
    this.boundWindowInteractionBlur = () => this.cancelPointerInteractions();
    this.boundInteractionVisibility = () => {
      if (document.visibilityState === "hidden") this.cancelPointerInteractions();
    };
    window.addEventListener("blur", this.boundWindowInteractionBlur);
    document.addEventListener("visibilitychange", this.boundInteractionVisibility);
  }

  cancelPointerInteractions() {
    if (!this.pointers.size) return false;
    const canvas = this.app?.canvas;
    const pointerIds = [...this.pointers.keys()];
    const cancelTool = [...this.pointers.values()].some((pointer) => pointer.action === "tool");
    this.pointers.clear();
    for (const pointerId of pointerIds) {
      try {
        if (canvas?.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
      } catch {}
    }
    if (cancelTool) this.interactionHandlers.cancel?.();
    this.onCoordinate(null);
    return true;
  }

  zoomAt(screen, factor) {
    const worldPoint = this.toWorld(screen);
    const scale = clamp(this.world.scale.x * factor, MIN_ZOOM, MAX_ZOOM);
    this.world.scale.set(scale);
    this.world.position.set(
      screen.x - worldPoint.x * scale,
      screen.y - worldPoint.y * scale,
    );
    this.transformChanged();
  }

  transformChanged() {
    if (this.destroyed || !this.world) return;
    this.updateLayerParallaxPositions();
    this.updateRepeatedImageLayers();
    this.refreshVisibleTileLayers();
    this.redrawGrid();
    this.redrawAiPatchPreview();
    this.redrawSelection();
    this.onTransform({ zoom: this.world.scale.x, ...this.renderView() });
  }

  redrawGrid() {
    if (!this.grid) return;
    this.grid.clear();
    if (!this.gridVisible) return;
    const scale = this.world.scale.x || 1;
    const left = -this.world.position.x / scale;
    const top = -this.world.position.y / scale;
    const right = left + this.host.clientWidth / scale;
    const bottom = top + this.host.clientHeight / scale;
    const range = tiledVisibleTileRange(this.document, { left, top, right, bottom }, 2);
    if (["hexagonal", "staggered"].includes(this.document.orientation)) {
      for (let row = range.startRow; row <= range.endRow; row += 1) {
        for (let column = range.startColumn; column <= range.endColumn; column += 1) {
          const polygon = tiledTilePolygon(this.document, column, row);
          if (!polygon.length) continue;
          this.grid.moveTo(polygon[0].x, polygon[0].y);
          for (const point of polygon.slice(1)) this.grid.lineTo(point.x, point.y);
          this.grid.closePath();
        }
      }
    } else {
      for (let column = range.startColumn; column <= range.endColumn + 1; column += 1) {
        const start = tiledTilePolygon(this.document, column, range.startRow)[0];
        const end = tiledTilePolygon(this.document, column, range.endRow + 1)[0];
        this.grid.moveTo(start.x, start.y).lineTo(end.x, end.y);
      }
      for (let row = range.startRow; row <= range.endRow + 1; row += 1) {
        const start = tiledTilePolygon(this.document, range.startColumn, row)[0];
        const end = tiledTilePolygon(this.document, range.endColumn + 1, row)[0];
        this.grid.moveTo(start.x, start.y).lineTo(end.x, end.y);
      }
    }
    this.grid.stroke({ color: GRID_COLOR, alpha: 0.12, width: 1 / scale });
  }

  redrawSelection() {
    if (!this.selection) return;
    this.selection.clear();
    const scale = this.world.scale.x || 1;
    const tileSelection = this.selectionRect?.kind === "tile-cells" && Array.isArray(this.selectionRect.cells)
      ? this.selectionRect
      : null;
    if (tileSelection && tileSelection.cells.length <= TILE_SELECTION_OVERLAY_LIMIT) {
      const view = this.layerViews.find((entry) => entry.layer.id === tileSelection.layerId);
      const offset = this.layerWorldOffset(tileSelection.layerId);
      if (view && offset) {
        const layerX = Number(view.layer.x || 0);
        const layerY = Number(view.layer.y || 0);
        for (const cell of tileSelection.cells) {
          const polygon = tiledTilePolygon(this.document, cell.x + layerX, cell.y + layerY)
            .map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
          if (!polygon.length) continue;
          this.selection
            .poly(polygon.flatMap((point) => [point.x, point.y]))
            .fill({ color: 0x5fca84, alpha: 0.16 })
            .stroke({ color: 0x79d99a, alpha: 0.9, width: 1 / scale });
        }
      }
    } else if (this.selectionRect) {
      this.selection
        .rect(
          this.selectionRect.x,
          this.selectionRect.y,
          Math.max(1, this.selectionRect.width),
          Math.max(1, this.selectionRect.height),
        )
        .fill({ color: 0x5fca84, alpha: 0.12 })
        .stroke({ color: 0x79d99a, alpha: 1, width: 2 / scale });
    }
    if (this.vertexOverlay) {
      const vertices = this.objectVertexWorldPoints(
        this.vertexOverlay.layerId,
        this.vertexOverlay.object,
        this.vertexOverlay.points,
      );
      const radius = 5 / scale;
      for (const [index, vertex] of vertices.entries()) {
        this.selection.circle(vertex.x, vertex.y, radius).fill({
          color: index === this.vertexOverlay.activeIndex ? 0xf6c453 : 0x79d99a,
          alpha: 1,
        }).stroke({ color: 0x101411, alpha: 1, width: 1.5 / scale });
      }
    }
    if (this.transformOverlay) {
      const handles = this.objectTransformHandlePoints(this.transformOverlay.layerId, this.transformOverlay.rect);
      const corners = [handles.nw, handles.ne, handles.se, handles.sw];
      if (corners.every(Boolean)) {
        this.selection.moveTo(corners[0].x, corners[0].y);
        for (const corner of corners.slice(1)) this.selection.lineTo(corner.x, corner.y);
        this.selection.closePath().stroke({ color: 0x79d99a, alpha: 1, width: 1.5 / scale });
        this.selection.moveTo(handles.n.x, handles.n.y).lineTo(handles.rotate.x, handles.rotate.y).stroke({
          color: 0x79d99a,
          alpha: 1,
          width: 1.5 / scale,
        });
      }
      const radius = 4.5 / scale;
      for (const [handle, point] of Object.entries(handles)) {
        if (!point) continue;
        const active = handle === this.transformOverlay.activeHandle;
        if (handle === "rotate") {
          this.selection.circle(point.x, point.y, radius + 0.5 / scale).fill({
            color: active ? 0xf6c453 : 0x171b18,
            alpha: 1,
          }).stroke({ color: 0x79d99a, alpha: 1, width: 1.5 / scale });
        } else {
          this.selection.rect(point.x - radius, point.y - radius, radius * 2, radius * 2).fill({
            color: active ? 0xf6c453 : 0xf4f7f5,
            alpha: 1,
          }).stroke({ color: 0x355c42, alpha: 1, width: 1 / scale });
        }
      }
    }
  }

  screenPoint(event) {
    const bounds = this.app.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  screenToWorld(screen) {
    return this.toWorld(screen);
  }

  worldToScreen(point) {
    const scale = this.world.scale.x || 1;
    return {
      x: Number(point?.x || 0) * scale + this.world.position.x,
      y: Number(point?.y || 0) * scale + this.world.position.y,
    };
  }

  toWorld(screen) {
    const scale = this.world.scale.x || 1;
    return {
      x: (screen.x - this.world.position.x) / scale,
      y: (screen.y - this.world.position.y) / scale,
    };
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function tileRangeContains(outer, inner) {
  if (!outer || !inner) return false;
  if (tileRangeIsEmpty(inner)) return tileRangeIsEmpty(outer);
  if (tileRangeIsEmpty(outer)) return false;
  return outer.startColumn <= inner.startColumn
    && outer.endColumn >= inner.endColumn
    && outer.startRow <= inner.startRow
    && outer.endRow >= inner.endRow;
}

function tileRangeIsEmpty(range) {
  return range.startColumn > range.endColumn || range.startRow > range.endRow;
}

function midpoint(left, right) {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
