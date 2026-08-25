export const TILED_MAX_GLOBAL_ID = 0x0fff_ffff;

const TILED_MAX_INTEGER = 0x7fff_ffff;

export class TiledTilesetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TiledTilesetError";
    this.code = code;
    this.details = details;
  }
}

export function tiledTilesetLayout(definition, options = {}) {
  const label = tilesetLabel(definition, options.label);
  if (!isRecord(definition)) throw tilesetError("invalid-tileset", `${label}定义必须是对象`);

  const tileWidth = positiveInteger(definition.tilewidth, `${label} tilewidth`);
  const tileHeight = positiveInteger(definition.tileheight, `${label} tileheight`);
  const margin = optionalNonNegativeInteger(definition.margin, 0, `${label} margin`);
  const spacing = optionalNonNegativeInteger(definition.spacing, 0, `${label} spacing`);
  const tileOffsetX = optionalInteger(definition.tileoffset?.x, 0, `${label} tileoffset.x`);
  const tileOffsetY = optionalInteger(definition.tileoffset?.y, 0, `${label} tileoffset.y`);
  const tiles = tileEntries(definition, label);
  const explicitIds = new Set();
  let highestExplicitId = -1;

  for (const [index, tile] of tiles.entries()) {
    if (!isRecord(tile)) throw tilesetError("invalid-tile", `${label} tiles[${index}] 必须是对象`);
    const tileId = nonNegativeInteger(tile.id, `${label} tiles[${index}].id`, TILED_MAX_GLOBAL_ID);
    if (explicitIds.has(tileId)) {
      throw tilesetError("duplicate-tile-id", `${label}包含重复的瓦片 ID ${tileId}`, { tileId });
    }
    explicitIds.add(tileId);
    highestExplicitId = Math.max(highestExplicitId, tileId);
    if (tile.probability !== undefined) {
      const probability = tile.probability;
      if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0) {
        throw tilesetError(
          "invalid-tile-probability",
          `${label}瓦片 ${tileId} 的 probability 必须是非负数`,
          { tileId, probability: tile.probability },
        );
      }
    }
  }

  if (definition.image) {
    const actualImage = actualImageSize(options.image, `${label}图集`);
    assertDeclaredImageSize(definition, actualImage, `${label}图集`);
    const columns = frameCount(actualImage.width, tileWidth, margin, spacing);
    const rows = frameCount(actualImage.height, tileHeight, margin, spacing);
    const capacity = safeProduct(columns, rows, `${label}图集帧容量`);
    if (!capacity) {
      throw tilesetError("tileset-image-too-small", `${label}图集无法容纳一个完整瓦片`);
    }
    if (definition.columns !== undefined) {
      const declaredColumns = positiveInteger(definition.columns, `${label} columns`);
      if (declaredColumns !== columns) {
        throw tilesetError(
          "tileset-columns-mismatch",
          `${label}声明 ${declaredColumns} 列，但图片实际可容纳 ${columns} 列`,
          { declaredColumns, actualColumns: columns },
        );
      }
    }
    const tileCount = definition.tilecount === undefined
      ? capacity
      : positiveInteger(definition.tilecount, `${label} tilecount`);
    if (tileCount > capacity) {
      throw tilesetError(
        "tileset-tilecount-overflow",
        `${label}声明 ${tileCount} 个瓦片，但图片最多容纳 ${capacity} 个`,
        { tileCount, capacity },
      );
    }
    if (highestExplicitId >= tileCount) {
      throw tilesetError(
        "tile-id-outside-atlas",
        `${label}瓦片 ID ${highestExplicitId} 超出图集范围 0-${tileCount - 1}`,
        { tileId: highestExplicitId, tileCount },
      );
    }
    return {
      kind: "atlas",
      tileWidth,
      tileHeight,
      margin,
      spacing,
      tileOffsetX,
      tileOffsetY,
      imageWidth: actualImage.width,
      imageHeight: actualImage.height,
      columns,
      rows,
      capacity,
      tileCount,
      explicitIds,
      maxLocalId: tileCount - 1,
    };
  }

  if (definition.columns !== undefined) {
    const columns = nonNegativeInteger(definition.columns, `${label} columns`);
    if (columns !== 0) {
      throw tilesetError("invalid-collection-columns", `${label}是图片集合，columns 必须为 0`);
    }
  }
  const tileCount = definition.tilecount === undefined
    ? explicitIds.size
    : nonNegativeInteger(definition.tilecount, `${label} tilecount`);
  if (tileCount < explicitIds.size) {
    throw tilesetError(
      "collection-tilecount-mismatch",
      `${label}声明 ${tileCount} 个瓦片，但 tiles 中至少有 ${explicitIds.size} 个唯一 ID`,
      { tileCount, actualTileCount: explicitIds.size },
    );
  }
  return {
    kind: "collection",
    tileWidth,
    tileHeight,
    margin,
    spacing,
    tileOffsetX,
    tileOffsetY,
    columns: 0,
    rows: 0,
    capacity: tileCount,
    tileCount,
    explicitIds,
    maxLocalId: highestExplicitId,
  };
}

export function validateTiledImageSize(definition, image, options = {}) {
  const label = options.label || "瓦片图片";
  const actual = actualImageSize(image, label);
  assertDeclaredImageSize(definition, actual, label);
  return actual;
}

export function validateTiledTilesetRanges(entries) {
  if (!Array.isArray(entries)) throw tilesetError("invalid-tileset-ranges", "瓦片集列表必须是数组");
  const sorted = entries.map((entry, index) => {
    const label = tilesetLabel(entry?.definition, entry?.ownerPath || `瓦片集 ${index + 1}`);
    const firstgid = positiveInteger(entry?.firstgid, `${label} firstgid`, TILED_MAX_GLOBAL_ID);
    const maxLocalId = integerInRange(entry?.maxLocalId, -1, TILED_MAX_GLOBAL_ID, `${label}最大本地 ID`);
    const lastgid = maxLocalId < 0 ? firstgid - 1 : firstgid + maxLocalId;
    if (!Number.isSafeInteger(lastgid) || lastgid > TILED_MAX_GLOBAL_ID) {
      throw tilesetError(
        "tileset-gid-flags-overlap",
        `${label}的最高 GID 会进入 Tiled 翻转标志位`,
        { firstgid, maxLocalId },
      );
    }
    return { ...entry, firstgid, maxLocalId, lastgid, label };
  }).sort((left, right) => left.firstgid - right.firstgid);

  const seenFirstGids = new Map();
  let previous = null;
  for (const entry of sorted) {
    const duplicate = seenFirstGids.get(entry.firstgid);
    if (duplicate) {
      throw tilesetError(
        "duplicate-firstgid",
        `${entry.label}与${duplicate.label}使用了相同的 firstgid ${entry.firstgid}`,
      );
    }
    seenFirstGids.set(entry.firstgid, entry);
    if (previous && previous.lastgid >= previous.firstgid && entry.firstgid <= previous.lastgid) {
      throw tilesetError(
        "tileset-gid-overlap",
        `${entry.label}的 firstgid ${entry.firstgid} 与${previous.label}的 GID ${previous.firstgid}-${previous.lastgid} 重叠`,
        { firstgid: entry.firstgid, previousFirstgid: previous.firstgid, previousLastgid: previous.lastgid },
      );
    }
    if (entry.lastgid >= entry.firstgid) previous = entry;
  }
  return sorted.map(({ label: _label, ...entry }) => entry);
}

/**
 * Allocate a stable firstgid for a newly imported tileset without moving any
 * existing range.  Tiled reserves the upper four bits of a global tile id for
 * flip flags, so a new range must remain below TILED_MAX_GLOBAL_ID.
 */
export function nextTiledTilesetFirstGid(entries, maxLocalId) {
  const normalizedMaxLocalId = integerInRange(
    maxLocalId,
    -1,
    TILED_MAX_GLOBAL_ID,
    "新瓦片集最大本地 ID",
  );
  const ranges = validateTiledTilesetRanges(entries);
  let highestReservedId = 0;
  for (const range of ranges) {
    highestReservedId = Math.max(
      highestReservedId,
      range.firstgid,
      range.lastgid,
    );
  }
  const firstgid = highestReservedId + 1;
  const lastgid = normalizedMaxLocalId < 0
    ? firstgid - 1
    : firstgid + normalizedMaxLocalId;
  if (
    !Number.isSafeInteger(firstgid)
    || firstgid > TILED_MAX_GLOBAL_ID
    || !Number.isSafeInteger(lastgid)
    || lastgid > TILED_MAX_GLOBAL_ID
  ) {
    throw tilesetError(
      "tileset-gid-space-exhausted",
      "没有足够的 Tiled GID 空间导入这个瓦片集",
      { firstgid, maxLocalId: normalizedMaxLocalId },
    );
  }
  validateTiledTilesetRanges([
    ...ranges,
    {
      firstgid,
      maxLocalId: normalizedMaxLocalId,
      definition: { name: "新瓦片集" },
    },
  ]);
  return firstgid;
}

function tileEntries(definition, label) {
  if (definition.tiles === undefined) return [];
  if (!Array.isArray(definition.tiles)) throw tilesetError("invalid-tiles", `${label} tiles 必须是数组`);
  return definition.tiles;
}

function assertDeclaredImageSize(definition, actual, label) {
  if (definition.imagewidth !== undefined) {
    const declaredWidth = positiveInteger(definition.imagewidth, `${label} imagewidth`);
    if (declaredWidth !== actual.width) {
      throw tilesetError(
        "image-width-mismatch",
        `${label}声明宽度 ${declaredWidth}，实际图片宽度为 ${actual.width}`,
        { declaredWidth, actualWidth: actual.width },
      );
    }
  }
  if (definition.imageheight !== undefined) {
    const declaredHeight = positiveInteger(definition.imageheight, `${label} imageheight`);
    if (declaredHeight !== actual.height) {
      throw tilesetError(
        "image-height-mismatch",
        `${label}声明高度 ${declaredHeight}，实际图片高度为 ${actual.height}`,
        { declaredHeight, actualHeight: actual.height },
      );
    }
  }
}

function actualImageSize(image, label) {
  if (!isRecord(image)) throw tilesetError("missing-image-size", `${label}的实际尺寸缺失`);
  return {
    width: positiveInteger(image.width, `${label}实际宽度`),
    height: positiveInteger(image.height, `${label}实际高度`),
  };
}

function frameCount(imageSize, tileSize, margin, spacing) {
  const drawable = imageSize - margin * 2;
  if (drawable < tileSize) return 0;
  return Math.floor((drawable + spacing) / (tileSize + spacing));
}

function safeProduct(left, right, label) {
  const product = left * right;
  if (!Number.isSafeInteger(product)) throw tilesetError("integer-overflow", `${label}超出安全整数范围`);
  return product;
}

function optionalInteger(value, fallback, label) {
  return value === undefined ? fallback : integerInRange(value, -TILED_MAX_INTEGER, TILED_MAX_INTEGER, label);
}

function optionalNonNegativeInteger(value, fallback, label) {
  return value === undefined ? fallback : nonNegativeInteger(value, label);
}

function positiveInteger(value, label, maximum = TILED_MAX_INTEGER) {
  return integerInRange(value, 1, maximum, label);
}

function nonNegativeInteger(value, label, maximum = TILED_MAX_INTEGER) {
  return integerInRange(value, 0, maximum, label);
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw tilesetError("invalid-integer", `${label}必须是 ${minimum}-${maximum} 的整数`);
  }
  return value;
}

function tilesetLabel(definition, fallback) {
  const name = typeof definition?.name === "string" ? definition.name.trim() : "";
  return `${name || fallback || "瓦片集"} `;
}

function tilesetError(code, message, details) {
  return new TiledTilesetError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
