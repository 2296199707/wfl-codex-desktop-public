import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { MAP_RENDER_PRESETS } from "../lib/map-render-settings.mjs";

const TILE_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQAgMAAAAKbpXKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAJUExURVjJguCzS////z0BPQEAAAABYktHRAJmC3xkAAAAB3RJTUUH6ggJDQgI+KkHZgAAABBjYU52AAAAEAAAABAAAAAAAAAAAEvxwwcAAAARSURBVAjXY2AAglAgYBgcDADQWxVBziqxsQAAAABJRU5ErkJggg==",
  "base64",
);

test("isolated worker renders exact panoramas, tiles, deterministic frames, and video", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "project");
  const mapPath = path.join(projectPath, "maps", "world.tmj");
  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(path.join(projectPath, "tiles"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "images"), { recursive: true }),
  ]);
  await fs.writeFile(path.join(projectPath, "index.html"), [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>Game render target</title>",
    "<style>html,body{width:100%;height:100%;margin:0;background:#2d7f62}main{width:80px;height:40px;background:#e6b94a}</style>",
    "<main></main>",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectPath, "images", "terrain.png"), TILE_IMAGE);
  await fs.writeFile(path.join(projectPath, "tiles", "world.tsj"), `${JSON.stringify({
    columns: 2,
    image: "../images/terrain.png",
    imageheight: 16,
    imagewidth: 32,
    name: "Terrain",
    tilecount: 2,
    tileheight: 16,
    tilewidth: 16,
    tiles: [{
      id: 0,
      animation: [{ tileid: 0, duration: 400 }, { tileid: 1, duration: 400 }],
    }],
    type: "tileset",
  })}\n`);
  const mapSource = `${JSON.stringify({
    type: "map",
    backgroundcolor: "#ff123456",
    width: 2,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 2, height: 1, data: [1, 1] }],
    tilesets: [{ firstgid: 1, source: "../tiles/world.tsj" }],
  })}\n`;
  await fs.writeFile(mapPath, mapSource);
  const expectedVersion = crypto.createHash("sha256").update(mapSource).digest("hex");

  const screenshot = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "map-screenshot",
    spec: { width: 96, height: 64, format: "webp", mode: "fit", timeMs: 0 },
  }, "screenshot");
  const webp = await fs.readFile(path.join(screenshot.outputDirectory, "screenshot.webp"));
  assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP");
  assert.deepEqual(
    [...(await sharp(webp).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer())],
    [0x12, 0x34, 0x56, 0xff],
  );
  assert.deepEqual(screenshot.result.files.map(({ path: file, mediaType }) => [file, mediaType]), [
    ["screenshot.webp", "image/webp"],
  ]);

  const gameScreenshot = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "game-screenshot",
    spec: { entry: "index.html", width: 160, height: 90, fullPage: false },
  }, "game-screenshot");
  assert.deepEqual(
    await pngDimensions(path.join(gameScreenshot.outputDirectory, "game-screenshot.png")),
    { width: 160, height: 90 },
  );
  assert.deepEqual(gameScreenshot.result.files.map((file) => file.path), ["game-screenshot.png"]);

  const panorama = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "map-panorama",
    spec: { scale: 2, format: "png" },
  }, "panorama");
  assert.deepEqual(await pngDimensions(path.join(panorama.outputDirectory, "panorama.png")), { width: 64, height: 32 });
  assert.equal(panorama.result.files.length, 1);

  const tiles = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "map-tiles",
    spec: { scale: 2, width: 40, height: 20, format: "png" },
  }, "tiles");
  const tileManifest = JSON.parse(await fs.readFile(path.join(tiles.outputDirectory, "tiles", "manifest.json"), "utf8"));
  assert.deepEqual({ columns: tileManifest.columns, rows: tileManifest.rows }, { columns: 2, rows: 2 });
  assert.equal(tiles.result.files.length, 5);

  const animation = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "map-animation",
    spec: { width: 320, height: 240, fps: 2, durationMs: 1_000, format: "png" },
  }, "animation");
  const firstFrame = await fs.readFile(path.join(animation.outputDirectory, "frames", "frame-000000.png"));
  const secondFrame = await fs.readFile(path.join(animation.outputDirectory, "frames", "frame-000001.png"));
  assert.notEqual(crypto.createHash("sha256").update(firstFrame).digest("hex"), crypto.createHash("sha256").update(secondFrame).digest("hex"));
  assert.equal(animation.result.files.length, 3);

  const video = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "map-video",
    spec: { width: 320, height: 240, fps: 2, durationMs: 1_000, codec: "libvpx-vp9", crf: 18 },
  }, "video");
  assert.ok((await fs.stat(path.join(video.outputDirectory, "animation.webm"))).size > 100);
  assert.equal(video.result.files.length, 1);

  await assert.rejects(
    runWorker(root, {
      projectPath,
      targetPath: mapPath,
      mapPath: "maps/world.tmj",
      expectedVersion,
      kind: "map-batch",
      spec: { tasks: [{ kind: "map-screenshot", name: "invalid", spec: "use-defaults" }] },
    }, "batch-invalid-spec"),
    /批量渲染第 1 项参数必须是对象/u,
  );

  const batch = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/world.tmj",
    expectedVersion,
    kind: "map-batch",
    spec: {
      tasks: [
        { kind: "map-screenshot", name: "shot", spec: {} },
        { kind: "map-panorama", name: "full-map", spec: {} },
      ],
    },
  }, "batch");
  assert.deepEqual(batch.result.files.map((file) => file.path), [
    "full-map/panorama.png",
    "shot/screenshot.png",
  ]);
  assert.deepEqual(await pngDimensions(path.join(batch.outputDirectory, "shot", "screenshot.png")), {
    width: MAP_RENDER_PRESETS.stable.preview.width,
    height: MAP_RENDER_PRESETS.stable.preview.height,
  });
  assert.deepEqual(await pngDimensions(path.join(batch.outputDirectory, "full-map", "panorama.png")), {
    width: 32,
    height: 16,
  });

  await assert.rejects(
    runWorker(root, {
      projectPath,
      targetPath: mapPath,
      mapPath: "maps/world.tmj",
      expectedVersion,
      kind: "map-screenshot",
      spec: { width: 32_768, height: 64, format: "png" },
    }, "no-downgrade"),
    /截图宽度不正确/u,
  );
  assert.deepEqual(await fs.readdir(path.join(root, "task-no-downgrade", "output")), []);
});

test("isolated worker captures a browser project preview into a temporary PNG manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-preview-capture-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previewServer = http.createServer((request, response) => {
    if (request.url === "/preview/test-token/game/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><style>html,body{margin:0;background:#2d7f62}</style><title>Worker capture</title>");
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    previewServer.once("error", reject);
    previewServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => previewServer.close(resolve)));
  const address = previewServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(
    runWorker(root, {
      kind: "preview-capture",
      capture: {
        url: `${origin}/preview/test-token/game/index.html`,
        requestOrigin: origin,
        config: { mode: "unconfigured", previewOrigins: [] },
        width: 12,
        height: 99,
        fullPage: false,
      },
    }, "preview-capture-invalid"),
    /项目截图宽度必须是 320-32767 的整数；参数未自动调整/u,
  );
  const capture = await runWorker(root, {
    kind: "preview-capture",
    capture: {
      url: `${origin}/preview/test-token/game/index.html`,
      requestOrigin: origin,
      config: { mode: "unconfigured", previewOrigins: [] },
      width: 400,
      height: 300,
      fullPage: false,
    },
  }, "preview-capture");
  assert.deepEqual(
    await pngDimensions(path.join(capture.outputDirectory, "screenshot.png")),
    { width: 400, height: 300 },
  );
  assert.deepEqual(capture.result.files.map((file) => file.path), ["screenshot.png"]);
  assert.equal(capture.result.files[0].mediaType, "image/png");
});

test("isolated worker applies Tiled advanced blend mode and tint alpha", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-semantics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "project");
  const mapPath = path.join(projectPath, "maps", "blend.tmj");
  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(path.join(projectPath, "images"), { recursive: true }),
  ]);
  const pixels = Buffer.alloc(32 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = (y * 32 + x) * 4;
      const color = x < 16 ? [100, 150, 200] : [200, 100, 50];
      pixels.set([...color, 255], offset);
    }
  }
  await sharp(pixels, { raw: { width: 32, height: 16, channels: 4 } })
    .png()
    .toFile(path.join(projectPath, "images", "layers.png"));
  const mapSource = `${JSON.stringify({
    type: "map",
    orientation: "orthogonal",
    renderorder: "right-down",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [
      { id: 1, name: "Base", type: "tilelayer", width: 1, height: 1, data: [1] },
      {
        id: 2,
        name: "Blend",
        type: "tilelayer",
        width: 1,
        height: 1,
        data: [2],
        mode: "difference",
        tintcolor: "#80ffffff",
      },
    ],
    tilesets: [{
      firstgid: 1,
      columns: 2,
      image: "../images/layers.png",
      imageheight: 16,
      imagewidth: 32,
      name: "Layers",
      tilecount: 2,
      tileheight: 16,
      tilewidth: 16,
    }],
  })}\n`;
  await fs.writeFile(mapPath, mapSource);
  const expectedVersion = crypto.createHash("sha256").update(mapSource).digest("hex");
  const screenshot = await runWorker(root, {
    projectPath,
    targetPath: mapPath,
    mapPath: "maps/blend.tmj",
    expectedVersion,
    kind: "map-screenshot",
    spec: { width: 16, height: 16, format: "png", mode: "scale", scale: 1 },
  }, "blend-semantics");
  const center = await sharp(path.join(screenshot.outputDirectory, "screenshot.png"))
    .ensureAlpha()
    .extract({ left: 8, top: 8, width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.deepEqual([...center], [100, 100, 175, 255]);

  const patternPixels = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = (y * 8 + x) * 4;
      const color = x < 4 ? [220, 40, 40] : [40, 210, 90];
      patternPixels.set([...color, 255], offset);
    }
  }
  await sharp(patternPixels, { raw: { width: 8, height: 8, channels: 4 } })
    .png()
    .toFile(path.join(projectPath, "images", "pattern.png"));
  const repeatSource = `${JSON.stringify({
    type: "map",
    orientation: "orthogonal",
    renderorder: "right-down",
    backgroundcolor: "#ff010203",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [{
      id: 1,
      name: "Parallax pattern",
      type: "imagelayer",
      image: "../images/pattern.png",
      repeatx: true,
      repeaty: true,
      parallaxx: 0.5,
      parallaxy: 1,
    }],
    tilesets: [],
  })}\n`;
  const repeatMapPath = path.join(projectPath, "maps", "repeat.tmj");
  await fs.writeFile(repeatMapPath, repeatSource);
  const repeat = await runWorker(root, {
    projectPath,
    targetPath: repeatMapPath,
    mapPath: "maps/repeat.tmj",
    expectedVersion: crypto.createHash("sha256").update(repeatSource).digest("hex"),
    kind: "map-screenshot",
    spec: { width: 16, height: 16, format: "png", mode: "scale", scale: 1 },
  }, "repeat-parallax-semantics");
  const repeatedRow = await sharp(path.join(repeat.outputDirectory, "screenshot.png"))
    .ensureAlpha()
    .extract({ left: 0, top: 2, width: 16, height: 1 })
    .raw()
    .toBuffer();
  const repeatedPixel = (x) => [...repeatedRow.subarray(x * 4, x * 4 + 4)];
  assert.deepEqual(repeatedPixel(2), [40, 210, 90, 255]);
  assert.deepEqual(repeatedPixel(6), [220, 40, 40, 255]);
  assert.deepEqual(repeatedPixel(10), [40, 210, 90, 255]);
  assert.deepEqual(repeatedPixel(14), [220, 40, 40, 255]);

  const objectSource = `${JSON.stringify({
    type: "map",
    orientation: "orthogonal",
    renderorder: "right-down",
    backgroundcolor: "#ff010203",
    width: 4,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    layers: [{
      id: 1,
      name: "Objects",
      type: "objectgroup",
      objects: [{ id: 1, gid: 1, x: 64, y: 0, width: 64, height: 32 }],
    }],
    tilesets: [{
      firstgid: 1,
      columns: 2,
      image: "../images/layers.png",
      imageheight: 16,
      imagewidth: 32,
      name: "Objects",
      objectalignment: "topright",
      fillmode: "preserve-aspect-fit",
      tilecount: 2,
      tileheight: 16,
      tilewidth: 16,
    }],
  })}\n`;
  const objectMapPath = path.join(projectPath, "maps", "tile-object.tmj");
  await fs.writeFile(objectMapPath, objectSource);
  const objectRender = await runWorker(root, {
    projectPath,
    targetPath: objectMapPath,
    mapPath: "maps/tile-object.tmj",
    expectedVersion: crypto.createHash("sha256").update(objectSource).digest("hex"),
    kind: "map-screenshot",
    spec: { width: 64, height: 32, format: "png", mode: "scale", scale: 1 },
  }, "tile-object-semantics");
  const objectRow = await sharp(path.join(objectRender.outputDirectory, "screenshot.png"))
    .ensureAlpha()
    .extract({ left: 0, top: 16, width: 64, height: 1 })
    .raw()
    .toBuffer();
  const objectPixel = (x) => [...objectRow.subarray(x * 4, x * 4 + 4)];
  assert.deepEqual(objectPixel(8), [1, 2, 3, 255]);
  assert.deepEqual(objectPixel(24), [100, 150, 200, 255]);
  assert.deepEqual(objectPixel(40), [100, 150, 200, 255]);
  assert.deepEqual(objectPixel(56), [1, 2, 3, 255]);

  const textSource = `${JSON.stringify({
    type: "map",
    orientation: "orthogonal",
    renderorder: "right-down",
    backgroundcolor: "#ff010203",
    width: 6,
    height: 3,
    tilewidth: 16,
    tileheight: 16,
    layers: [{
      id: 1,
      name: "Labels",
      type: "objectgroup",
      objects: [{
        height: 32,
        id: 1,
        text: {
          bold: true,
          color: "#ffff0000",
          fontfamily: "sans-serif",
          halign: "right",
          italic: true,
          kerning: false,
          pixelsize: 16,
          strikeout: true,
          text: "AV",
          underline: true,
          valign: "bottom",
          wrap: true,
        },
        width: 64,
        x: 8,
        y: 8,
      }],
    }],
    tilesets: [],
  })}\n`;
  const textMapPath = path.join(projectPath, "maps", "text-object.tmj");
  await fs.writeFile(textMapPath, textSource);
  const textRender = await runWorker(root, {
    projectPath,
    targetPath: textMapPath,
    mapPath: "maps/text-object.tmj",
    expectedVersion: crypto.createHash("sha256").update(textSource).digest("hex"),
    kind: "map-screenshot",
    spec: { width: 96, height: 48, format: "png", mode: "scale", scale: 1 },
  }, "text-object-semantics");
  const { data: textPixels, info: textInfo } = await sharp(
    path.join(textRender.outputDirectory, "screenshot.png"),
  ).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const redCoordinates = [];
  for (let y = 0; y < textInfo.height; y += 1) {
    for (let x = 0; x < textInfo.width; x += 1) {
      const offset = (y * textInfo.width + x) * 4;
      const [red, green, blue, alpha] = textPixels.subarray(offset, offset + 4);
      if (alpha > 0 && red > 140 && red > green * 2 && red > blue * 2) redCoordinates.push({ x, y });
    }
  }
  assert.ok(redCoordinates.length > 20, `expected rendered red text, received ${redCoordinates.length} pixels`);
  assert.ok(Math.min(...redCoordinates.map(({ x }) => x)) >= 45, "right-aligned text escaped into the left half");
  assert.ok(Math.min(...redCoordinates.map(({ y }) => y)) >= 20, "bottom-aligned text escaped into the top half");
  assert.ok(Math.max(...redCoordinates.map(({ x }) => x)) < 72, "text escaped past the object width");
  assert.ok(Math.max(...redCoordinates.map(({ y }) => y)) < 40, "text escaped past the object height");
});

async function runWorker(root, common, name) {
  const taskDirectory = path.join(root, `task-${name}`);
  const outputDirectory = path.join(taskDirectory, "output");
  await fs.mkdir(taskDirectory, { recursive: false, mode: 0o700 });
  const inputPath = path.join(taskDirectory, "input.json");
  await fs.writeFile(inputPath, `${JSON.stringify({
    jobId: `render-${name}-0001`,
    taskDirectory,
    outputDirectory,
    settings: {
      version: 1,
      revision: 1,
      preset: "stable",
      config: MAP_RENDER_PRESETS.stable,
    },
    ...common,
  })}\n`, { mode: 0o600 });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/map-render-worker.mjs", inputPath], {
      cwd: path.resolve(new URL("..", import.meta.url).pathname),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
  return { result, outputDirectory };
}

async function pngDimensions(filename) {
  const source = await fs.readFile(filename);
  assert.equal(source.subarray(1, 4).toString("ascii"), "PNG");
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
}
