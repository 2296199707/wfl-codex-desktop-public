import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearMapRenderAssetCache,
  MapRenderAssetCache,
  mapRenderCacheKind,
} from "../lib/map-render-cache.mjs";

test("keeps tile and image caches separate and trims each exact byte budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-cache-"));
  try {
    const source = path.join(root, "source");
    const cacheRoot = path.join(root, "cache");
    await fs.mkdir(source);
    const firstTile = path.join(source, "first.tmj");
    const secondTile = path.join(source, "second.tsj");
    const image = path.join(source, "terrain.png");
    await Promise.all([
      fs.writeFile(firstTile, "aaaa"),
      fs.writeFile(secondTile, "bbbb"),
      fs.writeFile(image, "image"),
    ]);
    const cache = new MapRenderAssetCache(cacheRoot, {
      tileBytes: 6,
      imageBytes: 6,
      idleMs: 60_000,
    });
    assert.equal((await cache.read(firstTile, "tile")).toString(), "aaaa");
    assert.equal((await cache.read(secondTile, "tile")).toString(), "bbbb");
    assert.equal((await cache.read(image, "image")).toString(), "image");
    assert.equal((await fs.readdir(path.join(cacheRoot, "tile"))).length, 1);
    assert.equal((await fs.readdir(path.join(cacheRoot, "image"))).length, 1);
    assert.equal(mapRenderCacheKind("maps/world.tmj"), "tile");
    assert.equal(mapRenderCacheKind("images/world.webp"), "image");
    assert.equal(mapRenderCacheKind("audio/theme.ogg"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not serve stale source bytes and removes idle cache entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-cache-fresh-"));
  let now = Date.now();
  try {
    const source = path.join(root, "world.tmj");
    const other = path.join(root, "other.tmj");
    const cacheRoot = path.join(root, "cache");
    await fs.writeFile(source, "old");
    await fs.writeFile(other, "next");
    const cache = new MapRenderAssetCache(cacheRoot, {
      tileBytes: 1024,
      imageBytes: 0,
      idleMs: 1_000,
      now: () => now,
    });
    assert.equal((await cache.read(source, "tile")).toString(), "old");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(source, "new");
    assert.equal((await cache.read(source, "tile")).toString(), "new");
    now += 2_000;
    assert.equal((await cache.read(other, "tile")).toString(), "next");
    assert.equal((await fs.readdir(path.join(cacheRoot, "tile"))).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("serializes shared cache writes across worker instances", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-cache-concurrent-"));
  try {
    const source = path.join(root, "source");
    const cacheRoot = path.join(root, "cache");
    await fs.mkdir(source);
    const first = path.join(source, "first.tmj");
    const second = path.join(source, "second.tmj");
    await Promise.all([fs.writeFile(first, "aaaa"), fs.writeFile(second, "bbbb")]);
    const left = new MapRenderAssetCache(cacheRoot, { tileBytes: 6, imageBytes: 0 });
    const right = new MapRenderAssetCache(cacheRoot, { tileBytes: 6, imageBytes: 0 });
    const bodies = await Promise.all([left.read(first, "tile"), right.read(second, "tile")]);
    assert.deepEqual(bodies.map((body) => body.toString()).sort(), ["aaaa", "bbbb"]);
    const files = await fs.readdir(path.join(cacheRoot, "tile"), { withFileTypes: true });
    assert.equal(files.filter((entry) => entry.isFile()).length, 1);
    assert.equal(files.some((entry) => entry.isDirectory()), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clears both cache buckets under their shared locks without deleting sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-cache-clear-"));
  try {
    const source = path.join(root, "source");
    const cacheRoot = path.join(root, "cache");
    const tile = path.join(source, "world.tmj");
    const image = path.join(source, "terrain.png");
    await fs.mkdir(source);
    await Promise.all([fs.writeFile(tile, "tile"), fs.writeFile(image, "image")]);
    const cache = new MapRenderAssetCache(cacheRoot, { tileBytes: 10, imageBytes: 10 });
    await Promise.all([cache.resolve(tile, "tile"), cache.resolve(image, "image")]);

    assert.deepEqual(await clearMapRenderAssetCache(cacheRoot), { files: 2, bytes: 9 });
    assert.deepEqual(await fs.readdir(cacheRoot), []);
    assert.equal(await fs.readFile(tile, "utf8"), "tile");
    assert.equal(await fs.readFile(image, "utf8"), "image");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
