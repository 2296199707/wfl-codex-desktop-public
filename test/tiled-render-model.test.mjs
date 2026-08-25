import assert from "node:assert/strict";
import test from "node:test";
import {
  TILED_FLIP_FLAGS,
  decodeGlobalTileId,
  mapPixelBounds,
  parseTiledColor,
  tiledAnimationFrameAt,
  tiledEffectiveParallaxFactor,
  spriteTransformForTile,
  tiledObjectBounds,
  tiledObjectAlignment,
  tiledObjectContainsPoint,
  tiledObjectOpacity,
  tiledObjectScreenBounds,
  tiledObjectsInDrawOrder,
  tiledPixelToScreen,
  tiledPixelTransform,
  tiledParallaxOffset,
  tiledScreenToPixel,
  tiledScreenToTile,
  tiledTilePolygon,
  tiledTileLayerSpriteLayout,
  tiledTileObjectSpriteLayout,
  tiledTileRegionBounds,
  tiledTileRenderPosition,
  tiledTextLayout,
  tiledTileToScreen,
  tiledLayerDisplayProperties,
  TILED_LAYER_BLEND_MODES,
  tiledVisibleTileRange,
  tileLayerCells,
  tileLayerCellsInRange,
  tileLayerCellsInRenderOrder,
  tilesetForGlobalId,
} from "../public/map-editor/tiled-render-model.js";

test("decodes Tiled global IDs and selects the matching tileset", () => {
  const encoded = (42 | TILED_FLIP_FLAGS.horizontal | TILED_FLIP_FLAGS.diagonal) >>> 0;
  assert.deepEqual(decodeGlobalTileId(encoded), {
    gid: 42,
    horizontal: true,
    vertical: false,
    diagonal: true,
    rotatedHex120: false,
  });
  assert.equal(tilesetForGlobalId([{ firstgid: 1 }, { firstgid: 40 }, { firstgid: 80 }], encoded).firstgid, 40);
  assert.equal(tilesetForGlobalId([{ firstgid: 1 }], 0), null);
  assert.deepEqual(spriteTransformForTile(encoded), { rotation: Math.PI / 2, scaleX: 1, scaleY: 1 });
  assert.deepEqual(spriteTransformForTile({
    diagonal: true,
    horizontal: true,
    rotatedHex120: true,
    vertical: false,
  }, { hexagonal: true }), {
    rotation: Math.PI,
    scaleX: -1,
    scaleY: 1,
  });
});

test("projects and reverses orthogonal, isometric, and oblique coordinates", () => {
  const orthogonal = projectionMap("orthogonal", { tilewidth: 32, tileheight: 16 });
  assert.deepEqual(tiledTileToScreen(orthogonal, 2, 3), { x: 64, y: 48 });
  assert.deepEqual(tiledScreenToTile(orthogonal, 72, 52), { x: 2.25, y: 3.25 });
  assert.deepEqual(tiledTileRenderPosition(orthogonal, 2, 3), { x: 64, y: 64 });

  const isometric = projectionMap("isometric", { width: 4, height: 3, tilewidth: 64, tileheight: 32 });
  assert.deepEqual(tiledTileToScreen(isometric, 0, 0), { x: 96, y: 0 });
  assert.deepEqual(tiledTileToScreen(isometric, 2, 1), { x: 128, y: 48 });
  assert.deepEqual(tiledScreenToTile(isometric, 128, 48), { x: 2, y: 1 });
  assert.deepEqual(tiledTileRenderPosition(isometric, 0, 0), { x: 64, y: 32 });
  assert.deepEqual(tiledTilePolygon(isometric, 0, 0), [
    { x: 96, y: 0 },
    { x: 128, y: 16 },
    { x: 96, y: 32 },
    { x: 64, y: 16 },
  ]);
  const projectedPixel = tiledPixelToScreen(isometric, 48, 16);
  assert.deepEqual(tiledScreenToPixel(isometric, projectedPixel.x, projectedPixel.y), { x: 48, y: 16 });
  assert.deepEqual(tiledPixelTransform(isometric), {
    a: 1,
    b: 0.5,
    c: -1,
    d: 0.5,
    tx: 96,
    ty: 0,
  });

  const oblique = projectionMap("oblique", { tilewidth: 32, tileheight: 16, skewx: 8, skewy: 4 });
  assert.deepEqual(tiledTileToScreen(oblique, 2, 3), { x: 88, y: 56 });
  assert.deepEqual(tiledScreenToTile(oblique, 88, 56), { x: 2, y: 3 });
  assert.deepEqual(tiledTileRenderPosition(oblique, 2, 3), { x: 96, y: 72 });
  const obliquePixel = tiledPixelToScreen(oblique, 64, 48);
  assert.deepEqual(tiledScreenToPixel(oblique, obliquePixel.x, obliquePixel.y), { x: 64, y: 48 });
});

test("projects and hit-tests staggered and hexagonal cells", () => {
  const staggered = projectionMap("staggered", {
    tilewidth: 64,
    tileheight: 32,
    staggeraxis: "y",
    staggerindex: "odd",
  });
  assert.deepEqual(tiledTileToScreen(staggered, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(tiledTileToScreen(staggered, 0, 1), { x: 32, y: 16 });
  assert.deepEqual(tiledScreenToTile(staggered, 64, 32), { x: 0, y: 1 });
  assert.deepEqual(tiledTilePolygon(staggered, 0, 1), [
    { x: 32, y: 32 },
    { x: 64, y: 16 },
    { x: 96, y: 32 },
    { x: 64, y: 48 },
  ]);

  const hexagonal = projectionMap("hexagonal", {
    tilewidth: 64,
    tileheight: 56,
    hexsidelength: 20,
    staggeraxis: "x",
    staggerindex: "even",
  });
  assert.deepEqual(tiledTileToScreen(hexagonal, 0, 0), { x: 0, y: 28 });
  assert.deepEqual(tiledTileToScreen(hexagonal, 1, 0), { x: 42, y: 0 });
  assert.deepEqual(tiledScreenToTile(hexagonal, 32, 56), { x: 0, y: 0 });
  assert.deepEqual(tiledTileRegionBounds(hexagonal, 0, 0, 3, 2), {
    x: 0,
    y: 0,
    width: 148,
    height: 140,
  });
});

test("derives bounded visible tile ranges for projected finite maps", () => {
  const map = projectionMap("isometric", { width: 8, height: 6, tilewidth: 64, tileheight: 32 });
  assert.deepEqual(tiledVisibleTileRange(map, {
    left: 0,
    top: 0,
    right: 448,
    bottom: 224,
  }, 0), {
    startColumn: 0,
    endColumn: 7,
    startRow: 0,
    endRow: 5,
  });
});

test("iterates finite and infinite tile layer cells without allocating a second map", () => {
  assert.deepEqual([...tileLayerCells({ width: 3, data: [0, 1, 0, 2, 0, 3] })], [
    { encodedGid: 1, column: 1, row: 0 },
    { encodedGid: 2, column: 0, row: 1 },
    { encodedGid: 3, column: 2, row: 1 },
  ]);
  assert.deepEqual([...tileLayerCells({ chunks: [{ x: -2, y: 4, width: 2, data: [1, 0, 0, 2] }] })], [
    { encodedGid: 1, column: -2, row: 4 },
    { encodedGid: 2, column: -1, row: 5 },
  ]);
});

test("iterates orthogonal cells in all four Tiled render orders", () => {
  const finite = { width: 2, data: [1, 2, 3, 4] };
  const coordinates = (order) => [...tileLayerCellsInRenderOrder(finite, null, order)]
    .map(({ column, row }) => `${column},${row}`);
  assert.deepEqual(coordinates("right-down"), ["0,0", "1,0", "0,1", "1,1"]);
  assert.deepEqual(coordinates("left-down"), ["1,0", "0,0", "1,1", "0,1"]);
  assert.deepEqual(coordinates("right-up"), ["0,1", "1,1", "0,0", "1,0"]);
  assert.deepEqual(coordinates("left-up"), ["1,1", "0,1", "1,0", "0,0"]);

  const chunks = {
    chunks: [
      { x: 2, y: 0, width: 1, data: [3, 6] },
      { x: 0, y: 0, width: 2, data: [1, 2, 4, 5] },
    ],
  };
  assert.deepEqual(
    [...tileLayerCellsInRenderOrder(chunks, null, "right-down")].map(({ encodedGid }) => encodedGid),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    [...tileLayerCellsInRenderOrder(chunks, null, "left-up")].map(({ encodedGid }) => encodedGid),
    [6, 5, 4, 3, 2, 1],
  );
});

test("parses Tiled colors with alpha first instead of CSS alpha last", () => {
  assert.deepEqual(parseTiledColor("#1b2430"), { color: 0x1b2430, alpha: 1 });
  assert.deepEqual(parseTiledColor("#801b2430"), { color: 0x1b2430, alpha: 128 / 255 });
  assert.deepEqual(parseTiledColor("#1b243080"), { color: 0x243080, alpha: 27 / 255 });
  assert.equal(parseTiledColor("#123456789"), null);
  assert.equal(parseTiledColor("transparent"), null);
});

test("maps all Tiled layer blend, tint, and object opacity values deterministically", () => {
  assert.equal(TILED_LAYER_BLEND_MODES.length, 13);
  for (const mode of TILED_LAYER_BLEND_MODES) {
    assert.equal(tiledLayerDisplayProperties({ mode }).blendMode, mode);
  }
  assert.deepEqual(tiledLayerDisplayProperties({
    mode: "future-mode",
    opacity: 0.5,
    tintcolor: "#804080c0",
  }), {
    alpha: 0.5 * 128 / 255,
    tint: 0x4080c0,
    blendMode: "normal",
    unsupportedBlendMode: "future-mode",
  });
  assert.equal(tiledObjectOpacity({ opacity: -1 }), 0);
  assert.equal(tiledObjectOpacity({ opacity: 2 }), 1);
  assert.equal(tiledObjectOpacity({}), 1);
});

test("multiplies nested Tiled parallax factors and offsets from the viewport center", () => {
  const groupFactor = tiledEffectiveParallaxFactor({ parallaxx: 0.5, parallaxy: 2 });
  assert.deepEqual(groupFactor, { x: 0.5, y: 2 });
  const childFactor = tiledEffectiveParallaxFactor({ parallaxx: 0.25, parallaxy: 0.5 }, groupFactor);
  assert.deepEqual(childFactor, { x: 0.125, y: 1 });
  assert.deepEqual(tiledParallaxOffset(
    { parallaxoriginx: 32, parallaxoriginy: -16 },
    childFactor,
    { x: 128, y: 80 },
  ), { x: 140, y: 0 });
});

test("lays out tileset grid rendering and aligned tile objects with aspect fit", () => {
  const map = projectionMap("orthogonal", { tilewidth: 32, tileheight: 16 });
  const tileset = {
    definition: {
      tilerendersize: "grid",
      fillmode: "preserve-aspect-fit",
      objectalignment: "topright",
    },
    tileOffsetX: 2,
    tileOffsetY: -1,
  };
  const tile = { width: 16, height: 16 };
  assert.deepEqual(tiledTileLayerSpriteLayout(map, tileset, tile, { x: 64, y: 48 }), {
    x: 82,
    y: 39,
    scaleX: 1,
    scaleY: 1,
    targetWidth: 32,
    targetHeight: 16,
  });
  assert.equal(tiledObjectAlignment(map, tileset), "topright");
  assert.deepEqual(tiledTileObjectSpriteLayout(map, tileset, tile, {
    width: 64,
    height: 32,
  }), {
    x: -28,
    y: 14,
    scaleX: 2,
    scaleY: 2,
    targetWidth: 64,
    targetHeight: 32,
    alignment: "topright",
  });
  assert.equal(tiledObjectAlignment({ orientation: "orthogonal" }, {}), "bottomleft");
  assert.equal(tiledObjectAlignment({ orientation: "isometric" }, {}), "bottom");
});

test("lays out wrapped Tiled text within its strict object box", () => {
  const layout = tiledTextLayout({
    bold: true,
    halign: "center",
    italic: true,
    kerning: false,
    pixelsize: 10,
    strikeout: true,
    text: "AA BB CCCCC",
    underline: true,
    valign: "bottom",
    wrap: true,
  }, 40, 50, (value) => value.length * 10);
  assert.deepEqual(layout.lines.map(({ text, width, x, y }) => ({ text, width, x, y })), [
    { text: "AA", width: 20, x: 10, y: 10 },
    { text: "BB", width: 20, x: 10, y: 20 },
    { text: "CCCC", width: 40, x: 0, y: 30 },
    { text: "C", width: 10, x: 15, y: 40 },
  ]);
  assert.equal(layout.format.bold, true);
  assert.equal(layout.format.italic, true);
  assert.equal(layout.format.kerning, false);
  assert.equal(layout.format.underline, true);
  assert.equal(layout.format.strikeout, true);

  const justified = tiledTextLayout({
    halign: "justify",
    pixelsize: 10,
    text: "A B C D",
    wrap: true,
  }, 50, 40, (value) => value.length * 10);
  assert.deepEqual(justified.lines.map(({ text, justified: active }) => [text, active]), [
    ["A B C", true],
    ["D", false],
  ]);
});

test("reads only viewport cells from large finite and chunked tile layers", () => {
  let finiteReads = 0;
  const finiteData = new Proxy(new Array(1_000_000), {
    get(target, property, receiver) {
      if (/^\d+$/u.test(String(property))) finiteReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  finiteData[20_010] = 7;
  finiteData[29_019] = 8;
  assert.deepEqual([...tileLayerCellsInRange({ width: 1_000, data: finiteData }, {
    startColumn: 10,
    endColumn: 19,
    startRow: 20,
    endRow: 29,
  })], [
    { encodedGid: 7, column: 10, row: 20 },
    { encodedGid: 8, column: 19, row: 29 },
  ]);
  assert.equal(finiteReads, 100);

  const chunks = {
    chunks: [
      { x: -4, y: -3, width: 4, data: [1, 0, 0, 0, 0, 2, 0, 0] },
      { x: 20, y: 20, width: 2, data: [3, 4, 5, 6] },
    ],
  };
  assert.deepEqual([...tileLayerCellsInRange(chunks, {
    startColumn: -3,
    endColumn: -2,
    startRow: -2,
    endRow: -2,
  })], [
    { encodedGid: 2, column: -3, row: -2 },
  ]);
});

test("selects deterministic Tiled animation frames at exact render times", () => {
  const frames = [
    { tileid: 0, duration: 100 },
    { tileid: 1, duration: 200 },
    { tileid: 2, duration: 50 },
  ];
  assert.equal(tiledAnimationFrameAt(frames, 0).tileid, 0);
  assert.equal(tiledAnimationFrameAt(frames, 99).tileid, 0);
  assert.equal(tiledAnimationFrameAt(frames, 100).tileid, 1);
  assert.equal(tiledAnimationFrameAt(frames, 299).tileid, 1);
  assert.equal(tiledAnimationFrameAt(frames, 300).tileid, 2);
  assert.equal(tiledAnimationFrameAt(frames, 350).tileid, 0);
  assert.equal(tiledAnimationFrameAt(frames, -1).tileid, 2);
  assert.equal(tiledAnimationFrameAt([], 0), null);
});

test("derives finite and chunked map bounds", () => {
  assert.deepEqual(mapPixelBounds({ width: 4, height: 3, tilewidth: 16, tileheight: 8, layers: [] }), {
    x: 0,
    y: 0,
    width: 64,
    height: 24,
  });
  assert.deepEqual(mapPixelBounds({
    infinite: true,
    width: 0,
    height: 0,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ type: "tilelayer", chunks: [{ x: -2, y: 1, width: 4, height: 3, data: [] }] }],
  }), {
    x: -32,
    y: 16,
    width: 64,
    height: 48,
  });
  assert.deepEqual(mapPixelBounds(projectionMap("isometric", {
    width: 4,
    height: 3,
    tilewidth: 64,
    tileheight: 32,
  })), {
    x: 0,
    y: 0,
    width: 224,
    height: 112,
  });
});

function projectionMap(orientation, changes = {}) {
  return {
    height: 4,
    infinite: false,
    layers: [],
    orientation,
    tileheight: 16,
    tilewidth: 16,
    width: 4,
    ...changes,
  };
}

test("hit-tests rotated Tiled object shapes and derives selection bounds", () => {
  const rectangle = { x: 10, y: 20, width: 20, height: 10, rotation: 90 };
  assert.equal(tiledObjectContainsPoint(rectangle, { x: 5, y: 30 }, { tolerance: 0.01 }), true);
  assert.equal(tiledObjectContainsPoint(rectangle, { x: 20, y: 30 }, { tolerance: 0.01 }), false);
  const bounds = tiledObjectBounds(rectangle);
  assert.ok(Math.abs(bounds.x) < 1e-9);
  assert.equal(bounds.y, 20);
  assert.ok(Math.abs(bounds.width - 10) < 1e-9);
  assert.equal(bounds.height, 20);

  const polygon = { x: 40, y: 30, polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 15 }] };
  assert.equal(tiledObjectContainsPoint(polygon, { x: 50, y: 35 }), true);
  assert.equal(tiledObjectContainsPoint(polygon, { x: 58, y: 43 }), false);
  const line = { x: 0, y: 0, polyline: [{ x: 0, y: 0 }, { x: 20, y: 0 }] };
  assert.equal(tiledObjectContainsPoint(line, { x: 10, y: 2 }, { tolerance: 3 }), true);
  assert.equal(tiledObjectContainsPoint(line, { x: 10, y: 5 }, { tolerance: 3 }), false);
  assert.equal(tiledObjectContainsPoint({ x: 8, y: 8, point: true }, { x: 10, y: 10 }), true);
  assert.equal(tiledObjectContainsPoint({ x: 8, y: 16, width: 8, height: 8, gid: 1 }, { x: 12, y: 12 }), true);

  const isometric = projectionMap("isometric", { width: 4, height: 3, tilewidth: 64, tileheight: 32 });
  assert.deepEqual(tiledObjectScreenBounds(isometric, { x: 0, y: 0, width: 32, height: 32 }), {
    x: 64,
    y: 0,
    width: 64,
    height: 32,
  });
  assert.deepEqual(tiledObjectScreenBounds(isometric, { gid: 1, x: 32, y: 32, width: 32, height: 32 }), {
    x: 80,
    y: 0,
    width: 32,
    height: 32,
  });
  assert.deepEqual(tiledObjectScreenBounds(isometric, { point: true, x: 8, y: 8 }, { pointTolerance: 4 }), {
    x: 92,
    y: 4,
    width: 8,
    height: 8,
  });
});

test("uses Tiled object-layer draworder for rendering and hit priority", () => {
  const objects = [
    { id: 1, y: 40 },
    { id: 2, y: 10 },
    { id: 3, y: 40 },
  ];
  assert.deepEqual(
    tiledObjectsInDrawOrder({ draworder: "topdown", objects }).map(({ id }) => id),
    [2, 1, 3],
  );
  assert.deepEqual(
    tiledObjectsInDrawOrder({ draworder: "index", objects }).map(({ id }) => id),
    [1, 2, 3],
  );
  assert.deepEqual(
    tiledObjectsInDrawOrder({ objects }).map(({ id }) => id),
    [2, 1, 3],
  );
  assert.deepEqual(objects.map(({ id }) => id), [1, 2, 3]);
});
