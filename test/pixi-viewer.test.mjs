import assert from "node:assert/strict";
import test from "node:test";

test("renders a tile sprite from both its Tiled column and row", async (context) => {
  const originalPixi = globalThis.PIXI;
  const sprites = [];
  const texts = [];
  class Container {
    constructor(options = {}) {
      this.label = options.label || "";
      this.children = [];
      this.position = point();
      this.scale = point();
      this.alpha = 1;
    }

    addChild(...children) { this.children.push(...children); }

    setFromMatrix(matrix) { this.matrix = matrix; }
  }
  class Graphics {
    constructor() { this.commands = []; }

    command(name, args) { this.commands.push([name, ...args]); return this; }

    roundRect(...args) { return this.command("roundRect", args); }

    rect(...args) { return this.command("rect", args); }

    circle(...args) { return this.command("circle", args); }

    ellipse(...args) { return this.command("ellipse", args); }

    poly(...args) { return this.command("poly", args); }

    moveTo(...args) { return this.command("moveTo", args); }

    lineTo(...args) { return this.command("lineTo", args); }

    fill(...args) { return this.command("fill", args); }

    stroke(...args) { return this.command("stroke", args); }
  }
  class Matrix {
    constructor(...values) { this.values = values; }
  }
  class Sprite {
    constructor(options = {}) {
      this.texture = options.texture;
      this.anchor = point();
      this.position = point();
      this.scale = point();
      sprites.push(this);
    }

    destroy() { this.destroyed = true; }
  }
  class Text {
    constructor(options = {}) {
      this.text = options.text || "";
      this.style = options.style || {};
      this.position = point();
      texts.push(this);
    }
  }
  class TextStyle {
    constructor(style = {}) { Object.assign(this, style); }
  }
  globalThis.PIXI = {
    Application: class {},
    CanvasTextMetrics: {
      measureText(value) { return { width: String(value).length * 8 }; },
    },
    Container,
    Graphics,
    Matrix,
    Rectangle: class {},
    Sprite,
    Text,
    TextStyle,
    Texture: class {},
  };
  context.after(() => {
    if (originalPixi === undefined) delete globalThis.PIXI;
    else globalThis.PIXI = originalPixi;
  });

  const { TiledPixiViewer } = await import("../public/map-editor/pixi-viewer.js");
  const mapLayers = {};
  const container = {
    children: [],
    parent: mapLayers,
    visible: true,
    addChild(child) { this.children.push(child); },
    removeChildren() {
      const removed = this.children;
      this.children = [];
      return removed;
    },
  };
  const viewer = Object.assign(Object.create(TiledPixiViewer.prototype), {
    destroyed: false,
    document: {
      type: "map",
      orientation: "orthogonal",
      renderorder: "right-down",
      width: 4,
      height: 4,
      tilewidth: 32,
      tileheight: 16,
    },
    mapLayers,
    app: { canvas: { dataset: {} } },
    layerViews: [],
    animatedSprites: new Set(),
    warningKeys: new Set(),
    onWarning() {},
    visibleTileRange: () => ({
      startColumn: 0,
      endColumn: 3,
      startRow: 0,
      endRow: 3,
    }),
  });
  const view = {
    key: "0:0:1",
    layer: { type: "tilelayer", x: 0, y: 0 },
    decodedLayer: {
      width: 4,
      data: [
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 1, 0,
      ],
    },
    container,
    renderedRange: null,
    tileSpriteCount: 0,
  };
  viewer.layerViews.push(view);
  const tilesets = [{
    firstgid: 1,
    lastgid: 1,
    tileOffsetX: 0,
    tileOffsetY: 0,
    textureForLocalId: () => ({ texture: {}, width: 32, height: 16 }),
  }];
  viewer.tilesets = tilesets;
  viewer.tileOverscan = 0;

  viewer.renderVisibleTileLayer(view, { force: true, tilesets, overscan: 0 });

  assert.equal(sprites.length, 1);
  assert.deepEqual({ x: sprites[0].position.x, y: sprites[0].position.y }, { x: 80, y: 56 });
  assert.equal(view.tileSpriteCount, 1);

  viewer.document.renderorder = "left-up";
  view.decodedLayer = { width: 2, data: [1, 2, 3, 4] };
  view.renderedRange = null;
  sprites.length = 0;
  viewer.renderVisibleTileLayer(view, {
    force: true,
    tilesets: [{
      ...tilesets[0],
      lastgid: 4,
      textureForLocalId: (localId) => ({ texture: { localId }, width: 32, height: 16 }),
    }],
    overscan: 0,
  });
  assert.deepEqual(sprites.map(({ texture }) => texture.localId), [3, 2, 1, 0]);

  view.decodedLayer = { width: 100, height: 100, data: new Array(10_000).fill(1) };
  view.renderedRange = null;
  viewer.renderVisibleTileLayer(view, { force: true, tilesets, overscan: 0 });
  assert.equal(view.tileSpriteCount, 16);
  assert.equal(container.children.length, 16);
  const visibleSprites = [...container.children];
  viewer.setLayerVisible(view.key, false);
  assert.equal(view.tileSpriteCount, 0);
  assert.equal(container.children.length, 0);
  assert.equal(visibleSprites.every((sprite) => sprite.destroyed === true), true);
  viewer.setLayerVisible(view.key, true);
  assert.equal(view.tileSpriteCount, 16);
  assert.equal(container.children.length, 16);

  const objectLayer = new Container();
  await viewer.renderObjectLayer({
    id: 9,
    name: "Collision",
    type: "objectgroup",
    objects: [{ id: 10, x: 2, y: 3, width: 20, height: 10, capsule: true, opacity: 0.25 }],
  }, objectLayer);
  const objectNode = objectLayer.children[0];
  const objectGraphics = objectNode.children[0].children[0];
  assert.equal(objectNode.alpha, 0.25);
  assert.deepEqual(objectGraphics.commands[0], ["roundRect", 0, 0, 20, 10, 5]);

  const portalLayer = new Container();
  await viewer.renderObjectLayer({
    id: 10,
    name: "Gameplay",
    type: "objectgroup",
    objects: [
      {
        class: "SpawnPoint", id: 20, name: "North", point: true, x: 8, y: 12,
        properties: [{ name: "spawnId", type: "string", value: "north" }],
      },
      {
        class: "Portal", id: 21, name: "Door", x: 32, y: 24, width: 16, height: 8,
        properties: [
          { name: "targetMap", type: "file", value: "" },
          { name: "targetSpawn", type: "string", value: "north" },
        ],
      },
    ],
  }, portalLayer);
  assert.deepEqual(portalLayer.children[0].commands.slice(0, 3), [
    ["moveTo", 40, 28],
    ["lineTo", 8, 12],
    ["stroke", { color: 0x58b8e8, alpha: 0.72, width: 1.5 }],
  ]);

  const tileObjectContainer = new Container();
  viewer.renderTileObject({ gid: 1, width: 64, height: 32 }, tileObjectContainer, {
    tilesets: [{
      firstgid: 1,
      lastgid: 1,
      tileOffsetX: 2,
      tileOffsetY: -1,
      definition: { objectalignment: "topright", fillmode: "preserve-aspect-fit" },
      textureForLocalId: () => ({ texture: {}, width: 16, height: 16 }),
    }],
  });
  const tileObjectSprite = tileObjectContainer.children[0];
  assert.deepEqual({ x: tileObjectSprite.anchor.x, y: tileObjectSprite.anchor.y }, { x: 0.5, y: 0.5 });
  assert.deepEqual({ x: tileObjectSprite.position.x, y: tileObjectSprite.position.y }, { x: -28, y: 14 });
  assert.deepEqual({ x: tileObjectSprite.scale.x, y: tileObjectSprite.scale.y }, { x: 2, y: 2 });

  const textObjectLayer = new Container();
  await viewer.renderObjectLayer({
    id: 11,
    name: "Labels",
    type: "objectgroup",
    objects: [{
      height: 48,
      id: 12,
      text: {
        bold: true,
        color: "#80ff0000",
        halign: "right",
        italic: true,
        kerning: false,
        pixelsize: 16,
        strikeout: true,
        text: "AB",
        underline: true,
        valign: "bottom",
      },
      width: 48,
      x: 0,
      y: 0,
    }],
  }, textObjectLayer);
  const textContent = textObjectLayer.children[0].children[0].children[1];
  assert.equal(textContent.mask, textContent.children[0]);
  assert.deepEqual(textContent.children[0].commands[0], ["rect", 0, 0, 48, 48]);
  assert.deepEqual(texts.map((entry) => [entry.text, entry.position.x, entry.position.y]), [
    ["A", 32, 32],
    ["B", 40, 32],
  ]);
  assert.equal(texts[0].style.fontWeight, "bold");
  assert.equal(texts[0].style.fontStyle, "italic");
  assert.deepEqual(texts[0].style.fill, { color: 0xff0000, alpha: 128 / 255 });
  const decorationCommands = textContent.children.at(-1).commands;
  assert.equal(decorationCommands.filter(([command]) => command === "stroke").length, 2);

  const imageContainer = new Container();
  imageContainer.parent = mapLayers;
  imageContainer.position.set(12, 23);
  const imageView = {
    layer: { id: 20, name: "Backdrop", type: "imagelayer", x: 10, y: 20, offsetx: 2, offsety: 3 },
    container: imageContainer,
    effectiveParallax: { x: 1, y: 1 },
    imageSize: { width: 32, height: 16 },
  };
  viewer.layerViews.push(imageView);
  viewer.world = { position: point(), scale: { x: 1 } };
  viewer.host = { clientWidth: 320, clientHeight: 200 };
  assert.deepEqual(viewer.imageLayerWorldBounds(20), { x: 12, y: 23, width: 32, height: 16 });
  assert.equal(viewer.imageLayerAtPoint({ x: 20, y: 30 }), imageView);
  assert.equal(viewer.imageLayerAtPoint({ x: 50, y: 30 }), null);
  assert.deepEqual(viewer.previewImageLayerPosition(20, { x: 30, y: 40 }), {
    x: 32,
    y: 43,
    width: 32,
    height: 16,
  });
  assert.deepEqual(viewer.imageLayerWorldBounds(20), { x: 32, y: 43, width: 32, height: 16 });
  viewer.previewImageLayerPosition(20);
  assert.deepEqual(viewer.imageLayerWorldBounds(20), { x: 12, y: 23, width: 32, height: 16 });
});

function point() {
  return {
    x: 0,
    y: 0,
    set(x, y = x) {
      this.x = x;
      this.y = y;
    },
  };
}
