import { relativeTiledProjectReference } from "./tiled-document.js?v=0.44.60-beta";
import { nextTiledTilesetFirstGid } from "./tiled-tileset-model.js?v=0.44.60-beta";

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Plan an undoable image-layer application without mutating the map. Images
 * generated from a selection are placed on a separate layer over the exact
 * logical selection/outpaint canvas; the source layer is never rewritten.
 */
export function planPublishedMapImageLayer({
  mapPath,
  published,
  job,
  selectionTarget = null,
  name = null,
} = {}) {
  const asset = publishedImage(published);
  const target = selectionTarget?.target?.world
    ? normalizedTargetCanvas(selectionTarget.target.world, asset)
    : null;
  const baseName = cleanName(name)
    || pathBase(asset.relativePath).replace(/\.[^.]+$/u, "")
    || "AI 图片";
  return Object.freeze({
    layer: Object.freeze({
      type: "imagelayer",
      name: baseName,
      image: relativeTiledProjectReference(mapPath, asset.relativePath),
      opacity: 1,
      visible: true,
      x: target ? target.x : 0,
      y: target ? target.y : 0,
      properties: provenanceProperties(job, asset, target, "image-layer"),
    }),
    sourceLayerId: Number.isSafeInteger(selectionTarget?.layer?.id)
      ? selectionTarget.layer.id
      : null,
    target: target ? Object.freeze({ ...target }) : null,
  });
}

export function planPublishedMapImageLayerReplacement({
  mapPath,
  published,
  job,
  layer,
} = {}) {
  const asset = publishedImage(published);
  if (!layer || layer.type !== "imagelayer" || !Number.isSafeInteger(layer.id)) {
    throw applyError("MAP_IMAGE_REPLACE_LAYER_INVALID", "请选择一个可编辑的图片层进行替换");
  }
  if (layer.locked === true) throw applyError("MAP_IMAGE_REPLACE_LAYER_LOCKED", "当前图片层已锁定");
  const generatedPropertyNames = new Set([
    "wfl.imageApplicationId",
    "wfl.imageJobId",
    "wfl.imageSha256",
    "wfl.imageOperation",
    "wfl.imageTargetWidth",
    "wfl.imageTargetHeight",
  ]);
  const retainedProperties = Array.isArray(layer.properties)
    ? layer.properties.filter((property) => !generatedPropertyNames.has(property?.name))
    : [];
  return Object.freeze({
    layerId: layer.id,
    changes: Object.freeze({
      image: relativeTiledProjectReference(mapPath, asset.relativePath),
      properties: Object.freeze([
        ...retainedProperties.map((property) => Object.freeze(structuredClone(property))),
        ...provenanceProperties(job, asset, null, "image-layer-replace"),
      ]),
    }),
  });
}

/**
 * Build a valid embedded Tiled tileset draft whose atlas remains an external
 * project image. This is offered only when the candidate aligns exactly to
 * the current map tile size; users can later move the definition to a TSJ.
 */
export function planPublishedMapTilesetDraft({
  mapPath,
  published,
  job,
  document,
  existingTilesets = [],
  name = null,
} = {}) {
  const asset = publishedImage(published);
  const tileWidth = positiveInteger(document?.tilewidth, "地图瓦片宽度");
  const tileHeight = positiveInteger(document?.tileheight, "地图瓦片高度");
  if (asset.width % tileWidth !== 0 || asset.height % tileHeight !== 0) {
    throw applyError(
      "MAP_IMAGE_TILESET_ALIGNMENT",
      `候选尺寸 ${asset.width}×${asset.height} 不能按当前 ${tileWidth}×${tileHeight} 瓦片完整切分`,
    );
  }
  const columns = asset.width / tileWidth;
  const rows = asset.height / tileHeight;
  const tileCount = columns * rows;
  if (!Number.isSafeInteger(tileCount) || tileCount < 1) {
    throw applyError("MAP_IMAGE_TILESET_CAPACITY", "候选图片不能形成有效的瓦片图集");
  }
  const firstgid = nextTiledTilesetFirstGid(
    currentTilesetRanges(document, existingTilesets),
    tileCount - 1,
  );
  const label = cleanName(name)
    || pathBase(asset.relativePath).replace(/\.[^.]+$/u, "")
    || "AI 瓦片集";
  return Object.freeze({
    reference: Object.freeze({
      firstgid,
      type: "tileset",
      name: label,
      tilewidth: tileWidth,
      tileheight: tileHeight,
      tilecount: tileCount,
      columns,
      margin: 0,
      spacing: 0,
      image: relativeTiledProjectReference(mapPath, asset.relativePath),
      imagewidth: asset.width,
      imageheight: asset.height,
      properties: provenanceProperties(job, asset, null, "tileset-draft"),
    }),
    firstgid,
    lastgid: firstgid + tileCount - 1,
    tileCount,
  });
}

/**
 * Represent a standalone image as a standards-only Tiled tile object. Unlike
 * an image layer, the resulting object can persist width, height, and rotation
 * without private WFL transform fields.
 */
export function planPublishedMapTileObject({
  mapPath,
  published,
  job,
  document,
  existingTilesets = [],
  selectionTarget = null,
  name = null,
} = {}) {
  const asset = publishedImage(published);
  const firstgid = nextTiledTilesetFirstGid(currentTilesetRanges(document, existingTilesets), 0);
  const label = cleanName(name)
    || pathBase(asset.relativePath).replace(/\.[^.]+$/u, "")
    || "AI 图片对象";
  const target = selectionTarget?.target?.world
    ? normalizedTargetCanvas(selectionTarget.target.world, asset)
    : { x: 0, y: 0, width: asset.width, height: asset.height };
  return Object.freeze({
    tileset: Object.freeze({
      firstgid,
      type: "tileset",
      name: `${label} · 单图`,
      tilewidth: asset.width,
      tileheight: asset.height,
      tilecount: 1,
      columns: 0,
      objectalignment: "topleft",
      tiles: Object.freeze([Object.freeze({
        id: 0,
        image: relativeTiledProjectReference(mapPath, asset.relativePath),
        imagewidth: asset.width,
        imageheight: asset.height,
      })]),
    }),
    layer: Object.freeze({
      type: "objectgroup",
      name: `${label} · 对象`,
      draworder: "topdown",
      opacity: 1,
      visible: true,
      objects: Object.freeze([]),
    }),
    object: Object.freeze({
      gid: firstgid,
      name: label,
      rotation: 0,
      visible: true,
      width: target.width,
      height: target.height,
      x: target.x,
      y: target.y,
      properties: provenanceProperties(job, asset, target, "tile-object"),
    }),
    firstgid,
    target: Object.freeze({ ...target }),
  });
}

export function publishedMapImageApplicationId(job, published, kind) {
  const jobId = String(job?.id || "").trim();
  const sha256 = String(published?.sha256 || "").trim().toLowerCase();
  if (!jobId || !SHA256.test(sha256)
    || !["image-layer", "image-layer-replace", "tile-object", "tileset-draft"].includes(kind)) return null;
  return `${kind}:${jobId}:${sha256}`;
}

export function tiledValueHasMapImageApplication(value, applicationId) {
  if (!applicationId || !value || typeof value !== "object") return false;
  return Array.isArray(value.properties) && value.properties.some((property) => (
    property?.name === "wfl.imageApplicationId"
    && property?.type === "string"
    && property?.value === applicationId
  ));
}

export function validatePublishedMapImageGrant(published, granted) {
  const expected = publishedImage(published);
  const actual = publishedImage({
    relativePath: granted?.path,
    width: granted?.width,
    height: granted?.height,
    sha256: granted?.sha256,
    format: granted?.format,
    mediaType: granted?.mediaType,
    size: granted?.size,
  });
  const expectedFormat = String(expected.format || "").toLowerCase();
  const actualFormat = String(actual.format || "").toLowerCase();
  if (actual.relativePath !== expected.relativePath
    || actual.sha256 !== expected.sha256
    || actual.width !== expected.width
    || actual.height !== expected.height
    || !expectedFormat
    || actualFormat !== expectedFormat) {
    throw applyError(
      "MAP_IMAGE_PUBLISHED_RESOURCE_CHANGED",
      "已发布图片在应用前发生变化，请重新生成或发布候选",
    );
  }
  return Object.freeze(actual);
}

function provenanceProperties(job, asset, target, kind) {
  const operation = String(job?.result?.operation || job?.request?.operation || "generate");
  const applicationId = publishedMapImageApplicationId(job, asset, kind);
  const properties = [
    { name: "wfl.imageApplicationId", type: "string", value: applicationId || "" },
    { name: "wfl.imageJobId", type: "string", value: String(job?.id || "") },
    { name: "wfl.imageSha256", type: "string", value: asset.sha256 },
    { name: "wfl.imageOperation", type: "string", value: operation },
  ];
  if (target) {
    properties.push(
      { name: "wfl.imageTargetWidth", type: "int", value: target.width },
      { name: "wfl.imageTargetHeight", type: "int", value: target.height },
    );
  }
  return properties;
}

function currentTilesetRanges(document, existingTilesets) {
  const ranges = [];
  const seenFirstGids = new Set();
  for (const entry of Array.isArray(existingTilesets) ? existingTilesets : []) {
    if (!Number.isSafeInteger(entry?.firstgid) || !Number.isSafeInteger(entry?.maxLocalId)) continue;
    ranges.push(entry);
    seenFirstGids.add(entry.firstgid);
  }
  for (const reference of Array.isArray(document?.tilesets) ? document.tilesets : []) {
    if (!Number.isSafeInteger(reference?.firstgid) || seenFirstGids.has(reference.firstgid)) continue;
    // Fresh AI drafts are embedded and carry a validated tilecount. Existing
    // external TSJ ranges come from the loaded viewer entries above.
    if (reference?.source !== undefined || !Number.isSafeInteger(reference?.tilecount) || reference.tilecount < 1) continue;
    ranges.push({
      firstgid: reference.firstgid,
      maxLocalId: reference.tilecount - 1,
      definition: reference,
    });
    seenFirstGids.add(reference.firstgid);
  }
  return ranges;
}

function publishedImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw applyError("MAP_IMAGE_NOT_PUBLISHED", "必须先明确发布候选图片");
  }
  const relativePath = String(value.relativePath || "").trim();
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw applyError("MAP_IMAGE_PUBLISHED_PATH_INVALID", "已发布图片路径不是安全的工程相对路径");
  }
  if (!/\.(?:png|jpe?g|webp)$/iu.test(relativePath)) {
    throw applyError("MAP_IMAGE_PUBLISHED_FORMAT_INVALID", "已发布素材不是可用的地图图片");
  }
  const width = positiveInteger(value.width, "已发布图片宽度");
  const height = positiveInteger(value.height, "已发布图片高度");
  const sha256 = String(value.sha256 || "").trim().toLowerCase();
  if (!SHA256.test(sha256)) throw applyError("MAP_IMAGE_PUBLISHED_HASH_INVALID", "已发布图片缺少有效哈希");
  return { ...value, relativePath, width, height, sha256 };
}

function normalizedTargetCanvas(target, asset) {
  const x = finiteInteger(target.x, "选区 X");
  const y = finiteInteger(target.y, "选区 Y");
  const width = positiveInteger(target.width, "选区宽度");
  const height = positiveInteger(target.height, "选区高度");
  if (asset.width !== width || asset.height !== height) {
    throw applyError(
      "MAP_IMAGE_TARGET_SIZE_MISMATCH",
      `候选实际尺寸 ${asset.width}×${asset.height} 与地图目标 ${width}×${height} 不一致，未应用`,
    );
  }
  return { x, y, width, height };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw applyError("MAP_IMAGE_DIMENSION_INVALID", `${label}无效`);
  }
  return number;
}

function finiteInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw applyError("MAP_IMAGE_COORDINATE_INVALID", `${label}无效`);
  return number;
}

function cleanName(value) {
  return typeof value === "string" ? value.trim().slice(0, 255) : "";
}

function pathBase(value) {
  return String(value || "").split("/").at(-1) || "";
}

function applyError(code, message) {
  const error = new Error(message);
  error.name = "MapImageApplyError";
  error.code = code;
  return error;
}
