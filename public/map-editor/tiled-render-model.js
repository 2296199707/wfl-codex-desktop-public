export const TILED_FLIP_FLAGS = Object.freeze({
  horizontal: 0x80000000,
  vertical: 0x40000000,
  diagonal: 0x20000000,
  rotatedHex120: 0x10000000,
});

const ALL_FLIP_FLAGS = (
  TILED_FLIP_FLAGS.horizontal
  | TILED_FLIP_FLAGS.vertical
  | TILED_FLIP_FLAGS.diagonal
  | TILED_FLIP_FLAGS.rotatedHex120
) >>> 0;

export function decodeGlobalTileId(value) {
  const encoded = Number(value) >>> 0;
  return {
    gid: (encoded & ~ALL_FLIP_FLAGS) >>> 0,
    horizontal: Boolean(encoded & TILED_FLIP_FLAGS.horizontal),
    vertical: Boolean(encoded & TILED_FLIP_FLAGS.vertical),
    diagonal: Boolean(encoded & TILED_FLIP_FLAGS.diagonal),
    rotatedHex120: Boolean(encoded & TILED_FLIP_FLAGS.rotatedHex120),
  };
}

export function spriteTransformForTile(value, options = {}) {
  const decoded = typeof value === "number" ? decodeGlobalTileId(value) : value;
  if (options.hexagonal) {
    return {
      rotation: (decoded.diagonal ? Math.PI / 3 : 0) + (decoded.rotatedHex120 ? Math.PI * 2 / 3 : 0),
      scaleX: decoded.horizontal ? -1 : 1,
      scaleY: decoded.vertical ? -1 : 1,
    };
  }
  if (!decoded.diagonal) {
    return {
      rotation: 0,
      scaleX: decoded.horizontal ? -1 : 1,
      scaleY: decoded.vertical ? -1 : 1,
    };
  }
  if (decoded.horizontal && decoded.vertical) {
    return { rotation: Math.PI / 2, scaleX: -1, scaleY: 1 };
  }
  if (decoded.horizontal) return { rotation: Math.PI / 2, scaleX: 1, scaleY: 1 };
  if (decoded.vertical) return { rotation: -Math.PI / 2, scaleX: 1, scaleY: 1 };
  return { rotation: Math.PI / 2, scaleX: 1, scaleY: -1 };
}

export function tilesetForGlobalId(tilesets, encodedGid) {
  const { gid } = decodeGlobalTileId(encodedGid);
  if (!gid) return null;
  let selected = null;
  for (const tileset of tilesets) {
    if (!Number.isInteger(tileset?.firstgid) || tileset.firstgid > gid) continue;
    if (Number.isInteger(tileset.lastgid) && tileset.lastgid < gid) continue;
    if (!selected || tileset.firstgid > selected.firstgid) selected = tileset;
  }
  return selected;
}

export function* tileLayerCells(layer) {
  yield* tileLayerCellsInRange(layer);
}

export function* tileLayerCellsInRange(layer, range = null) {
  if (!layer || typeof layer !== "object") return;
  const bounds = normalizeCellRange(range);
  if (Array.isArray(layer.chunks)) {
    for (const chunk of layer.chunks) {
      yield* tileBlockCells(chunk, bounds);
    }
    return;
  }
  if (!Array.isArray(layer.data) || !Number.isInteger(layer.width) || layer.width <= 0) return;
  yield* tileBlockCells({
    data: layer.data,
    width: layer.width,
    x: layer.startx,
    y: layer.starty,
  }, bounds);
}

const TILED_RENDER_ORDERS = new Set([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);
const TILED_OBJECT_ALIGNMENTS = new Set([
  "topleft",
  "top",
  "topright",
  "left",
  "center",
  "right",
  "bottomleft",
  "bottom",
  "bottomright",
]);

export const TILED_LAYER_BLEND_MODES = Object.freeze([
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

const TILED_LAYER_BLEND_MODE_SET = new Set(TILED_LAYER_BLEND_MODES);

export function* tileLayerCellsInRenderOrder(layer, range = null, renderOrder = "right-down") {
  const normalizedOrder = TILED_RENDER_ORDERS.has(renderOrder) ? renderOrder : "right-down";
  const cells = [...tileLayerCellsInRange(layer, range)];
  const columnDirection = normalizedOrder.startsWith("right-") ? 1 : -1;
  const rowDirection = normalizedOrder.endsWith("-down") ? 1 : -1;
  cells.sort((left, right) => (
    (left.row - right.row) * rowDirection
    || (left.column - right.column) * columnDirection
  ));
  yield* cells;
}

export function parseTiledColor(value) {
  if (typeof value !== "string" || !/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/iu.test(value)) return null;
  const body = value.slice(1);
  if (body.length === 8) {
    return {
      color: Number.parseInt(body.slice(2), 16),
      alpha: Number.parseInt(body.slice(0, 2), 16) / 255,
    };
  }
  return { color: Number.parseInt(body, 16), alpha: 1 };
}

export function tiledLayerDisplayProperties(layer) {
  const tint = parseTiledColor(layer?.tintcolor);
  const requestedBlendMode = typeof layer?.mode === "string" && layer.mode ? layer.mode : "normal";
  return {
    alpha: clampUnit(layer?.opacity, 1) * (tint?.alpha ?? 1),
    tint: tint?.color ?? 0xffffff,
    blendMode: TILED_LAYER_BLEND_MODE_SET.has(requestedBlendMode) ? requestedBlendMode : "normal",
    unsupportedBlendMode: TILED_LAYER_BLEND_MODE_SET.has(requestedBlendMode) ? null : requestedBlendMode,
  };
}

export function tiledObjectOpacity(object) {
  return clampUnit(object?.opacity, 1);
}

export function tiledObjectsInDrawOrder(layer) {
  const objects = Array.isArray(layer?.objects) ? layer.objects : [];
  if (layer?.draworder === "index") return [...objects];
  return objects
    .map((object, index) => ({ object, index }))
    .sort((left, right) => (
      finiteNumber(left.object?.y, 0) - finiteNumber(right.object?.y, 0)
      || left.index - right.index
    ))
    .map(({ object }) => object);
}

export function tiledTextLayout(text, objectWidth, objectHeight, measureText) {
  const width = Math.max(0, finiteNumber(objectWidth, 0));
  const height = Math.max(0, finiteNumber(objectHeight, 0));
  const pixelSize = positiveNumber(text?.pixelsize, 16);
  const lineHeight = pixelSize;
  const format = {
    bold: text?.bold === true,
    color: text?.color || "#000000",
    fontFamily: typeof text?.fontfamily === "string" && text.fontfamily.trim()
      ? text.fontfamily.trim()
      : "sans-serif",
    halign: ["left", "center", "right", "justify"].includes(text?.halign) ? text.halign : "left",
    italic: text?.italic === true,
    kerning: text?.kerning !== false,
    pixelSize,
    strikeout: text?.strikeout === true,
    underline: text?.underline === true,
    valign: ["top", "center", "bottom"].includes(text?.valign) ? text.valign : "top",
    wrap: text?.wrap === true,
  };
  const measure = typeof measureText === "function"
    ? (value) => Math.max(0, finiteNumber(measureText(String(value)), 0))
    : (value) => textGraphemes(String(value)).length * pixelSize * 0.6;
  const paragraphs = String(text?.text ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const rawLines = [];
  for (const paragraph of paragraphs) {
    const lines = format.wrap ? wrapTiledTextParagraph(paragraph, width, measure) : [paragraph];
    for (let index = 0; index < lines.length; index += 1) {
      rawLines.push({ text: lines[index], lastInParagraph: index === lines.length - 1 });
    }
  }
  const totalHeight = rawLines.length * lineHeight;
  const startY = format.valign === "bottom"
    ? height - totalHeight
    : format.valign === "center" ? (height - totalHeight) / 2 : 0;
  const lines = rawLines.map((line, index) => {
    const lineWidth = measure(line.text);
    const justified = format.halign === "justify"
      && format.wrap
      && !line.lastInParagraph
      && /\S\s+\S/u.test(line.text);
    const x = format.halign === "right"
      ? width - lineWidth
      : format.halign === "center" ? (width - lineWidth) / 2 : 0;
    return {
      ...line,
      justified,
      width: lineWidth,
      x,
      y: startY + index * lineHeight,
    };
  });
  return { format, height, lineHeight, lines, totalHeight, width };
}

export function textGraphemes(value) {
  return Array.from(String(value ?? ""));
}

function wrapTiledTextParagraph(paragraph, width, measure) {
  if (!paragraph) return [""];
  if (width <= 0) return [paragraph];
  const tokens = paragraph.match(/\s+|\S+/gu) || [paragraph];
  const lines = [];
  let line = "";
  let whitespace = "";

  const pushLine = () => {
    lines.push(line.replace(/\s+$/gu, ""));
    line = "";
    whitespace = "";
  };

  for (const token of tokens) {
    if (/^\s+$/u.test(token)) {
      if (line) whitespace += token;
      continue;
    }
    const candidate = `${line}${whitespace}${token}`;
    if (line && measure(candidate) > width) pushLine();
    const prefix = line ? whitespace : "";
    whitespace = "";
    if (measure(`${prefix}${token}`) <= width) {
      line += `${prefix}${token}`;
      continue;
    }
    if (line) pushLine();
    let segment = "";
    for (const grapheme of textGraphemes(token)) {
      if (segment && measure(`${segment}${grapheme}`) > width) {
        lines.push(segment);
        segment = grapheme;
      } else {
        segment += grapheme;
      }
    }
    line = segment;
  }
  if (line || !lines.length) pushLine();
  return lines;
}

export function tiledEffectiveParallaxFactor(layer, parentFactor = { x: 1, y: 1 }) {
  return {
    x: finiteNumber(parentFactor?.x, 1) * finiteNumber(layer?.parallaxx, 1),
    y: finiteNumber(parentFactor?.y, 1) * finiteNumber(layer?.parallaxy, 1),
  };
}

export function tiledParallaxOffset(document, effectiveFactor, viewportCenter) {
  const centerX = finiteNumber(viewportCenter?.x, 0) + finiteNumber(document?.parallaxoriginx, 0);
  const centerY = finiteNumber(viewportCenter?.y, 0) + finiteNumber(document?.parallaxoriginy, 0);
  return {
    x: (1 - finiteNumber(effectiveFactor?.x, 1)) * centerX,
    y: (1 - finiteNumber(effectiveFactor?.y, 1)) * centerY,
  };
}

export function tiledObjectAlignment(document, tileset) {
  const definition = tileset?.definition || tileset;
  const value = definition?.objectalignment;
  if (TILED_OBJECT_ALIGNMENTS.has(value)) return value;
  return document?.orientation === "isometric" ? "bottom" : "bottomleft";
}

export function tiledAlignmentOffset(widthValue, heightValue, alignment) {
  const width = Math.max(0, finiteNumber(widthValue, 0));
  const height = Math.max(0, finiteNumber(heightValue, 0));
  const horizontal = alignment.endsWith("right") || alignment === "right"
    ? 1
    : alignment === "top" || alignment === "center" || alignment === "bottom"
      ? 0.5
      : 0;
  const vertical = alignment.startsWith("bottom") || alignment === "bottom"
    ? 1
    : alignment === "left" || alignment === "center" || alignment === "right"
      ? 0.5
      : 0;
  return { x: width * horizontal, y: height * vertical };
}

export function tiledTileLayerSpriteLayout(document, tileset, tile, renderPosition) {
  const definition = tileset?.definition || tileset;
  const targetWidth = definition?.tilerendersize === "grid"
    ? positiveNumber(document?.tilewidth, tile?.width)
    : positiveNumber(tile?.width, document?.tilewidth);
  const targetHeight = definition?.tilerendersize === "grid"
    ? positiveNumber(document?.tileheight, tile?.height)
    : positiveNumber(tile?.height, document?.tileheight);
  const scale = tiledTileScale(definition, tile, targetWidth, targetHeight);
  return {
    x: finiteNumber(renderPosition?.x, 0) + targetWidth / 2 + finiteNumber(tileset?.tileOffsetX, 0) * scale.x,
    y: finiteNumber(renderPosition?.y, 0) - targetHeight / 2 + finiteNumber(tileset?.tileOffsetY, 0) * scale.y,
    scaleX: scale.x,
    scaleY: scale.y,
    targetWidth,
    targetHeight,
  };
}

export function tiledTileObjectSpriteLayout(document, tileset, tile, object) {
  const definition = tileset?.definition || tileset;
  const targetWidth = positiveNumber(object?.width, tile?.width);
  const targetHeight = positiveNumber(object?.height, tile?.height);
  const alignment = tiledObjectAlignment(document, definition);
  const alignmentOffset = tiledAlignmentOffset(targetWidth, targetHeight, alignment);
  const scale = tiledTileScale(definition, tile, targetWidth, targetHeight);
  return {
    x: targetWidth / 2 - alignmentOffset.x + finiteNumber(tileset?.tileOffsetX, 0) * scale.x,
    y: targetHeight / 2 - alignmentOffset.y + finiteNumber(tileset?.tileOffsetY, 0) * scale.y,
    scaleX: scale.x,
    scaleY: scale.y,
    targetWidth,
    targetHeight,
    alignment,
  };
}

function tiledTileScale(definition, tile, targetWidth, targetHeight) {
  let x = targetWidth / positiveNumber(tile?.width, targetWidth);
  let y = targetHeight / positiveNumber(tile?.height, targetHeight);
  if (definition?.fillmode === "preserve-aspect-fit") {
    x = y = Math.min(x, y);
  }
  return { x, y };
}

function clampUnit(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function* tileBlockCells(block, range) {
  if (!block || !Array.isArray(block.data) || !Number.isInteger(block.width) || block.width <= 0) return;
  const originColumn = Number(block.x || 0);
  const originRow = Number(block.y || 0);
  const rowCount = Math.ceil(block.data.length / block.width);
  let startColumn = originColumn;
  let endColumn = originColumn + block.width - 1;
  let startRow = originRow;
  let endRow = originRow + rowCount - 1;
  if (range) {
    startColumn = Math.max(startColumn, range.startColumn);
    endColumn = Math.min(endColumn, range.endColumn);
    startRow = Math.max(startRow, range.startRow);
    endRow = Math.min(endRow, range.endRow);
  }
  if (startColumn > endColumn || startRow > endRow) return;
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      const index = (row - originRow) * block.width + column - originColumn;
      if (index < 0 || index >= block.data.length) continue;
      const encodedGid = Number(block.data[index]) >>> 0;
      if (encodedGid) yield { encodedGid, column, row };
    }
  }
}

function normalizeCellRange(value) {
  if (!value) return null;
  const range = {
    startColumn: Math.floor(Number(value.startColumn)),
    endColumn: Math.floor(Number(value.endColumn)),
    startRow: Math.floor(Number(value.startRow)),
    endRow: Math.floor(Number(value.endRow)),
  };
  if (!Object.values(range).every(Number.isFinite)) return null;
  return range;
}

export function tiledTileToScreen(document, columnValue, rowValue) {
  const projection = tiledProjection(document);
  const column = finiteNumber(columnValue, 0);
  const row = finiteNumber(rowValue, 0);
  if (projection.orientation === "isometric") {
    return {
      x: (column - row) * projection.tileWidth / 2 + projection.originX,
      y: (column + row) * projection.tileHeight / 2,
    };
  }
  if (projection.orientation === "oblique") {
    return {
      x: column * projection.tileWidth + row * projection.skewX,
      y: row * projection.tileHeight + column * projection.skewY,
    };
  }
  if (projection.staggered) {
    if (projection.staggerX) {
      return {
        x: column * projection.columnWidth,
        y: row * (projection.tileHeight + projection.sideLengthY)
          + (isStaggeredIndex(column, projection.staggerEven) ? projection.rowHeight : 0),
      };
    }
    return {
      x: column * (projection.tileWidth + projection.sideLengthX)
        + (isStaggeredIndex(row, projection.staggerEven) ? projection.columnWidth : 0),
      y: row * projection.rowHeight,
    };
  }
  return { x: column * projection.tileWidth, y: row * projection.tileHeight };
}

export function tiledScreenToTile(document, xValue, yValue) {
  const projection = tiledProjection(document);
  let x = finiteNumber(xValue, 0);
  let y = finiteNumber(yValue, 0);
  if (projection.orientation === "isometric") {
    x -= projection.originX;
    const diagonalY = y / projection.tileHeight;
    const diagonalX = x / projection.tileWidth;
    return { x: diagonalY + diagonalX, y: diagonalY - diagonalX };
  }
  if (projection.orientation === "oblique") {
    const determinant = 1 - projection.shearX * projection.shearY;
    if (Math.abs(determinant) < Number.EPSILON) return { x: 0, y: 0 };
    const pixelX = (x - projection.shearX * y) / determinant;
    const pixelY = (y - projection.shearY * x) / determinant;
    return { x: pixelX / projection.tileWidth, y: pixelY / projection.tileHeight };
  }
  if (projection.staggered) return staggeredScreenToTile(projection, x, y);
  return { x: x / projection.tileWidth, y: y / projection.tileHeight };
}

export function tiledPixelToScreen(document, xValue, yValue) {
  const projection = tiledProjection(document);
  const x = finiteNumber(xValue, 0);
  const y = finiteNumber(yValue, 0);
  if (projection.orientation === "isometric") {
    const tileX = x / projection.tileHeight;
    const tileY = y / projection.tileHeight;
    return {
      x: (tileX - tileY) * projection.tileWidth / 2 + projection.originX,
      y: (tileX + tileY) * projection.tileHeight / 2,
    };
  }
  if (projection.orientation === "oblique") {
    return {
      x: x + projection.shearX * y,
      y: y + projection.shearY * x,
    };
  }
  return { x, y };
}

export function tiledScreenToPixel(document, xValue, yValue) {
  const projection = tiledProjection(document);
  let x = finiteNumber(xValue, 0);
  let y = finiteNumber(yValue, 0);
  if (projection.orientation === "isometric") {
    x -= projection.originX;
    const tileY = y / projection.tileHeight;
    const tileX = x / projection.tileWidth;
    return {
      x: (tileY + tileX) * projection.tileHeight,
      y: (tileY - tileX) * projection.tileHeight,
    };
  }
  if (projection.orientation === "oblique") {
    const determinant = 1 - projection.shearX * projection.shearY;
    if (Math.abs(determinant) < Number.EPSILON) return { x: 0, y: 0 };
    return {
      x: (x - projection.shearX * y) / determinant,
      y: (y - projection.shearY * x) / determinant,
    };
  }
  return { x, y };
}

export function tiledPixelTransform(document, xValue = 0, yValue = 0) {
  const origin = tiledPixelToScreen(document, xValue, yValue);
  const horizontal = tiledPixelToScreen(document, Number(xValue) + 1, yValue);
  const vertical = tiledPixelToScreen(document, xValue, Number(yValue) + 1);
  return {
    a: horizontal.x - origin.x,
    b: horizontal.y - origin.y,
    c: vertical.x - origin.x,
    d: vertical.y - origin.y,
    tx: origin.x,
    ty: origin.y,
  };
}

export function tiledTileRenderPosition(document, column, row) {
  const projection = tiledProjection(document);
  if (projection.orientation === "isometric") {
    const origin = tiledTileToScreen(document, column, row);
    return { x: origin.x - projection.tileWidth / 2, y: origin.y + projection.tileHeight };
  }
  if (projection.orientation === "oblique") return tiledTileToScreen(document, column, Number(row) + 1);
  const origin = tiledTileToScreen(document, column, row);
  return { x: origin.x, y: origin.y + projection.tileHeight };
}

export function tiledTilePolygon(document, column, row) {
  const projection = tiledProjection(document);
  const origin = tiledTileToScreen(document, column, row);
  if (projection.orientation === "isometric") {
    return [
      origin,
      { x: origin.x + projection.tileWidth / 2, y: origin.y + projection.tileHeight / 2 },
      { x: origin.x, y: origin.y + projection.tileHeight },
      { x: origin.x - projection.tileWidth / 2, y: origin.y + projection.tileHeight / 2 },
    ];
  }
  if (projection.staggered) {
    return [
      { x: origin.x, y: origin.y + projection.rowHeight },
      { x: origin.x, y: origin.y + projection.sideOffsetY },
      { x: origin.x + projection.sideOffsetX, y: origin.y },
      { x: origin.x + projection.columnWidth, y: origin.y },
      { x: origin.x + projection.tileWidth, y: origin.y + projection.sideOffsetY },
      { x: origin.x + projection.tileWidth, y: origin.y + projection.rowHeight },
      { x: origin.x + projection.columnWidth, y: origin.y + projection.tileHeight },
      { x: origin.x + projection.sideOffsetX, y: origin.y + projection.tileHeight },
    ].filter((point, index, points) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  }
  return [
    tiledTileToScreen(document, column, row),
    tiledTileToScreen(document, Number(column) + 1, row),
    tiledTileToScreen(document, Number(column) + 1, Number(row) + 1),
    tiledTileToScreen(document, column, Number(row) + 1),
  ];
}

export function tiledTileRegionBounds(document, xValue, yValue, widthValue, heightValue) {
  const projection = tiledProjection(document);
  const x = finiteNumber(xValue, 0);
  const y = finiteNumber(yValue, 0);
  const width = Math.max(0, finiteNumber(widthValue, 0));
  const height = Math.max(0, finiteNumber(heightValue, 0));
  if (projection.staggered && width > 0 && height > 0) {
    const topLeft = tiledTileToScreen(document, x, y);
    if (projection.staggerX) {
      if (width > 1 && isStaggeredIndex(x, projection.staggerEven)) topLeft.y -= projection.rowHeight;
      return {
        x: topLeft.x,
        y: topLeft.y,
        width: width * projection.columnWidth + projection.sideOffsetX,
        height: height * (projection.tileHeight + projection.sideLengthY)
          + (width > 1 ? projection.rowHeight : 0),
      };
    }
    if (height > 1 && isStaggeredIndex(y, projection.staggerEven)) topLeft.x -= projection.columnWidth;
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: width * (projection.tileWidth + projection.sideLengthX)
        + (height > 1 ? projection.columnWidth : 0),
      height: height * projection.rowHeight + projection.sideOffsetY,
    };
  }
  return pointsBounds([
    tiledTileToScreen(document, x, y),
    tiledTileToScreen(document, x + width, y),
    tiledTileToScreen(document, x + width, y + height),
    tiledTileToScreen(document, x, y + height),
  ]);
}

export function tiledVisibleTileRange(document, screenRect, padding = 2) {
  const points = [
    tiledScreenToTile(document, screenRect.left, screenRect.top),
    tiledScreenToTile(document, screenRect.right, screenRect.top),
    tiledScreenToTile(document, screenRect.right, screenRect.bottom),
    tiledScreenToTile(document, screenRect.left, screenRect.bottom),
  ];
  const inset = Math.max(0, Math.ceil(Number(padding) || 0));
  let startColumn = Math.floor(Math.min(...points.map((point) => point.x))) - inset;
  let endColumn = Math.ceil(Math.max(...points.map((point) => point.x))) + inset;
  let startRow = Math.floor(Math.min(...points.map((point) => point.y))) - inset;
  let endRow = Math.ceil(Math.max(...points.map((point) => point.y))) + inset;
  if (!document?.infinite) {
    startColumn = Math.max(0, startColumn);
    startRow = Math.max(0, startRow);
    endColumn = Math.min(Math.max(0, Number(document?.width) - 1), endColumn);
    endRow = Math.min(Math.max(0, Number(document?.height) - 1), endRow);
  }
  return { startColumn, endColumn, startRow, endRow };
}

export function mapPixelBounds(document, options = {}) {
  const tileWidth = positiveNumber(document?.tilewidth, 1);
  const tileHeight = positiveNumber(document?.tileheight, 1);
  let minX = 0;
  let minY = 0;
  let maxX = tileWidth;
  let maxY = tileHeight;
  let initialized = false;

  const include = (left, top, right, bottom) => {
    if (![left, top, right, bottom].every(Number.isFinite)) return;
    if (!initialized) {
      minX = left;
      minY = top;
      maxX = right;
      maxY = bottom;
      initialized = true;
      return;
    }
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
  };

  if (!document?.infinite && Number(document?.width) > 0 && Number(document?.height) > 0) {
    const bounds = tiledTileRegionBounds(document, 0, 0, document.width, document.height);
    include(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height);
  }

  const visit = (layers, parentOffsetX = 0, parentOffsetY = 0) => {
    if (!Array.isArray(layers)) return;
    for (const layer of layers) {
      if (!layer || typeof layer !== "object") continue;
      const coordinateX = ["group", "objectgroup", "imagelayer"].includes(layer.type) ? Number(layer.x || 0) : 0;
      const coordinateY = ["group", "objectgroup", "imagelayer"].includes(layer.type) ? Number(layer.y || 0) : 0;
      const offsetX = parentOffsetX + Number(layer.offsetx || 0) + coordinateX;
      const offsetY = parentOffsetY + Number(layer.offsety || 0) + coordinateY;
      if (layer.type === "tilelayer") {
        const regions = Array.isArray(layer.chunks)
          ? layer.chunks
          : [{ x: Number(layer.startx || 0), y: Number(layer.starty || 0), width: layer.width, height: layer.height }];
        for (const region of regions) {
          const bounds = tiledTileRegionBounds(
            document,
            Number(region.x || 0) + Number(layer.x || 0),
            Number(region.y || 0) + Number(layer.y || 0),
            Number(region.width || 0),
            Number(region.height || 0),
          );
          include(offsetX + bounds.x, offsetY + bounds.y, offsetX + bounds.x + bounds.width, offsetY + bounds.y + bounds.height);
        }
      } else if (layer.type === "objectgroup" && Array.isArray(layer.objects)) {
        for (const object of layer.objects) {
          const alignment = typeof options.tileObjectAlignment === "function"
            ? options.tileObjectAlignment(object)
            : object?.gid
              ? tiledObjectAlignment(document, tilesetForGlobalId(document?.tilesets || [], object.gid))
              : null;
          const projected = tiledObjectScreenBounds(document, object, { alignment });
          include(offsetX + projected.x, offsetY + projected.y, offsetX + projected.x + projected.width, offsetY + projected.y + projected.height);
        }
      }
      visit(layer.layers, offsetX, offsetY);
    }
  };
  visit(document?.layers);

  if (!initialized) return { x: 0, y: 0, width: tileWidth, height: tileHeight };
  return {
    x: minX,
    y: minY,
    width: Math.max(tileWidth, maxX - minX),
    height: Math.max(tileHeight, maxY - minY),
  };
}

function tiledProjection(document) {
  const tileWidth = positiveNumber(document?.tilewidth, 1);
  const tileHeight = positiveNumber(document?.tileheight, 1);
  const orientation = ["orthogonal", "isometric", "staggered", "hexagonal", "oblique"].includes(document?.orientation)
    ? document.orientation
    : "orthogonal";
  const staggered = orientation === "staggered" || orientation === "hexagonal";
  const staggerX = document?.staggeraxis === "x";
  const staggerEven = document?.staggerindex === "even";
  const rawSideLength = orientation === "hexagonal" ? Math.max(0, finiteNumber(document?.hexsidelength, 0)) : 0;
  const sideLengthX = staggerX ? Math.min(tileWidth, rawSideLength) : 0;
  const sideLengthY = staggerX ? 0 : Math.min(tileHeight, rawSideLength);
  const sideOffsetX = (tileWidth - sideLengthX) / 2;
  const sideOffsetY = (tileHeight - sideLengthY) / 2;
  return {
    orientation,
    tileWidth,
    tileHeight,
    originX: positiveNumber(document?.height, 0) * tileWidth / 2,
    skewX: finiteNumber(document?.skewx, 0),
    skewY: finiteNumber(document?.skewy, 0),
    shearX: finiteNumber(document?.skewx, 0) / tileHeight,
    shearY: finiteNumber(document?.skewy, 0) / tileWidth,
    staggered,
    staggerX,
    staggerEven,
    sideLengthX,
    sideLengthY,
    sideOffsetX,
    sideOffsetY,
    columnWidth: sideOffsetX + sideLengthX,
    rowHeight: sideOffsetY + sideLengthY,
  };
}

function staggeredScreenToTile(projection, xValue, yValue) {
  let x = xValue;
  let y = yValue;
  if (projection.staggerX) x -= projection.staggerEven ? projection.tileWidth : projection.sideOffsetX;
  else y -= projection.staggerEven ? projection.tileHeight : projection.sideOffsetY;
  let referenceX = Math.floor(x / (projection.columnWidth * 2));
  let referenceY = Math.floor(y / (projection.rowHeight * 2));
  const relativeX = x - referenceX * projection.columnWidth * 2;
  const relativeY = y - referenceY * projection.rowHeight * 2;
  if (projection.staggerX) referenceX *= 2;
  else referenceY *= 2;
  if (projection.staggerEven) {
    if (projection.staggerX) referenceX += 1;
    else referenceY += 1;
  }
  const centers = projection.staggerX
    ? [
      [projection.sideLengthX / 2, projection.tileHeight / 2],
      [projection.sideLengthX / 2 + projection.columnWidth, projection.tileHeight / 2 - projection.rowHeight],
      [projection.sideLengthX / 2 + projection.columnWidth, projection.tileHeight / 2 + projection.rowHeight],
      [projection.sideLengthX / 2 + projection.columnWidth * 2, projection.tileHeight / 2],
    ]
    : [
      [projection.tileWidth / 2, projection.sideLengthY / 2],
      [projection.tileWidth / 2 - projection.columnWidth, projection.sideLengthY / 2 + projection.rowHeight],
      [projection.tileWidth / 2 + projection.columnWidth, projection.sideLengthY / 2 + projection.rowHeight],
      [projection.tileWidth / 2, projection.sideLengthY / 2 + projection.rowHeight * 2],
    ];
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < centers.length; index += 1) {
    const deltaX = centers[index][0] - relativeX;
    const deltaY = centers[index][1] - relativeY;
    const distance = deltaX ** 2 + deltaY ** 2;
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  const offsets = projection.staggerX
    ? [[0, 0], [1, -1], [1, 0], [2, 0]]
    : [[0, 0], [-1, 1], [0, 1], [0, 2]];
  return { x: referenceX + offsets[nearest][0], y: referenceY + offsets[nearest][1] };
}

function isStaggeredIndex(value, staggerEven) {
  const odd = ((Math.trunc(value) % 2) + 2) % 2 === 1;
  return odd !== staggerEven;
}

function pointsBounds(points) {
  const xValues = points.map((point) => point.x).filter(Number.isFinite);
  const yValues = points.map((point) => point.y).filter(Number.isFinite);
  if (!xValues.length || !yValues.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...xValues);
  const top = Math.min(...yValues);
  const right = Math.max(...xValues);
  const bottom = Math.max(...yValues);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function tiledAnimationFrameAt(frames, timeMs) {
  if (!Array.isArray(frames) || !frames.length) return null;
  const durations = frames.map((frame) => {
    const duration = Number(frame?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 100;
  });
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  let position = ((Number(timeMs) || 0) % total + total) % total;
  for (let index = 0; index < frames.length; index += 1) {
    if (position < durations[index]) return frames[index];
    position -= durations[index];
  }
  return frames.at(-1);
}

export function tiledObjectBounds(object, options = {}) {
  const tolerance = positiveNumber(options.pointTolerance, 5);
  const originX = Number(object?.x || 0);
  const originY = Number(object?.y || 0);
  const points = objectShapePoints(object, tolerance);
  const angle = Number(object?.rotation || 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const transformed = points.map((point) => ({
    x: originX + point.x * cosine - point.y * sine,
    y: originY + point.x * sine + point.y * cosine,
  }));
  const left = Math.min(...transformed.map((point) => point.x));
  const top = Math.min(...transformed.map((point) => point.y));
  const right = Math.max(...transformed.map((point) => point.x));
  const bottom = Math.max(...transformed.map((point) => point.y));
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function tiledObjectScreenBounds(document, object, options = {}) {
  const origin = tiledPixelToScreen(document, Number(object?.x || 0), Number(object?.y || 0));
  const width = Math.max(1, Number(object?.width || 0));
  const height = Math.max(1, Number(object?.height || 0));
  if (object?.point) {
    const tolerance = positiveNumber(options.pointTolerance, 5);
    return { x: origin.x - tolerance, y: origin.y - tolerance, width: tolerance * 2, height: tolerance * 2 };
  }
  if (object?.gid) {
    const alignment = options.alignment
      || (document?.orientation === "isometric" ? "bottom" : "bottomleft");
    const offset = tiledAlignmentOffset(width, height, alignment);
    return { x: origin.x - offset.x, y: origin.y - offset.y, width, height };
  }
  if (object?.text) return { x: origin.x, y: origin.y, width, height };
  const bounds = tiledObjectBounds(object, options);
  return pointsBounds([
    tiledPixelToScreen(document, bounds.x, bounds.y),
    tiledPixelToScreen(document, bounds.x + bounds.width, bounds.y),
    tiledPixelToScreen(document, bounds.x + bounds.width, bounds.y + bounds.height),
    tiledPixelToScreen(document, bounds.x, bounds.y + bounds.height),
  ]);
}

export function tiledObjectContainsPoint(object, point, options = {}) {
  if (!object || object.visible === false || !point) return false;
  const tolerance = positiveNumber(options.tolerance, 5);
  const angle = -Number(object.rotation || 0) * Math.PI / 180;
  const deltaX = Number(point.x) - Number(object.x || 0);
  const deltaY = Number(point.y) - Number(object.y || 0);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const local = {
    x: deltaX * cosine - deltaY * sine,
    y: deltaX * sine + deltaY * cosine,
  };

  if (object.point) return Math.hypot(local.x, local.y) <= tolerance;
  if (Array.isArray(object.polygon)) return pointInPolygon(local, object.polygon);
  if (Array.isArray(object.polyline)) return pointNearPolyline(local, object.polyline, tolerance);

  const width = Math.max(0, Number(object.width || 0));
  const height = Math.max(0, Number(object.height || 0));
  if (object.gid) {
    return local.x >= -tolerance
      && local.x <= width + tolerance
      && local.y >= -height - tolerance
      && local.y <= tolerance;
  }
  if (object.ellipse && width > 0 && height > 0) {
    const normalizedX = (local.x - width / 2) / (width / 2);
    const normalizedY = (local.y - height / 2) / (height / 2);
    return normalizedX ** 2 + normalizedY ** 2 <= 1;
  }
  return local.x >= -tolerance
    && local.x <= width + tolerance
    && local.y >= -tolerance
    && local.y <= height + tolerance;
}

function objectShapePoints(object, tolerance) {
  if (object?.point) {
    return [
      { x: -tolerance, y: -tolerance },
      { x: tolerance, y: tolerance },
    ];
  }
  const shape = Array.isArray(object?.polygon)
    ? object.polygon
    : Array.isArray(object?.polyline) ? object.polyline : null;
  if (shape?.length) {
    const left = Math.min(...shape.map((point) => Number(point.x || 0)));
    const top = Math.min(...shape.map((point) => Number(point.y || 0)));
    const right = Math.max(...shape.map((point) => Number(point.x || 0)));
    const bottom = Math.max(...shape.map((point) => Number(point.y || 0)));
    return rectanglePoints(left, top, right, bottom);
  }
  const width = Math.max(1, Number(object?.width || 0));
  const height = Math.max(1, Number(object?.height || 0));
  return object?.gid
    ? rectanglePoints(0, -height, width, 0)
    : rectanglePoints(0, 0, width, height);
}

function rectanglePoints(left, top, right, bottom) {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentX = Number(polygon[index]?.x || 0);
    const currentY = Number(polygon[index]?.y || 0);
    const previousX = Number(polygon[previous]?.x || 0);
    const previousY = Number(polygon[previous]?.y || 0);
    const crosses = (currentY > point.y) !== (previousY > point.y)
      && point.x < (previousX - currentX) * (point.y - currentY) / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointNearPolyline(point, polyline, tolerance) {
  if (polyline.length === 1) {
    return Math.hypot(point.x - Number(polyline[0].x || 0), point.y - Number(polyline[0].y || 0)) <= tolerance;
  }
  for (let index = 1; index < polyline.length; index += 1) {
    if (distanceToSegment(point, polyline[index - 1], polyline[index]) <= tolerance) return true;
  }
  return false;
}

function distanceToSegment(point, start, end) {
  const startX = Number(start?.x || 0);
  const startY = Number(start?.y || 0);
  const deltaX = Number(end?.x || 0) - startX;
  const deltaY = Number(end?.y || 0) - startY;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (!lengthSquared) return Math.hypot(point.x - startX, point.y - startY);
  const ratio = Math.max(0, Math.min(1, ((point.x - startX) * deltaX + (point.y - startY) * deltaY) / lengthSquared));
  return Math.hypot(point.x - (startX + ratio * deltaX), point.y - (startY + ratio * deltaY));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
