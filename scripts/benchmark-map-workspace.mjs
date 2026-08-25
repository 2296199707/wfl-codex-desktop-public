#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { inspectDecodedImageBuffer, inspectImageBuffer } from "../lib/image-file.mjs";
import { MapResourceCatalog } from "../lib/map-resource-catalog.mjs";
import {
  createMapAssetLibrary,
  parseMapAssetLibrary,
  searchMapAssets,
  serializeMapAssetLibrary,
  sortedMapAssets,
} from "../public/map-editor/map-asset-library.js";
import {
  parseTiledDocument,
  serializeTiledDocument,
} from "../public/map-editor/tiled-document.js";
import {
  adjacentWorldMapIndexes,
  createTiledWorld,
  parseTiledWorld,
  serializeTiledWorld,
  worldBounds,
  worldMapAtPoint,
} from "../public/map-editor/tiled-world.js";

const HARD_LIMITS = Object.freeze({
  totalTileCells: 100_000_000,
  assetCount: 1_000_000,
  worldMapCount: 100_000,
  totalImagePixels: 268_435_456,
  resourceFileCount: 100_000,
  ioConcurrency: 64,
  iterations: 20,
});

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (options.confirmCandidateBenchmark !== "yes") {
  throw new Error("该性能基准只能在开发/候选服务器运行；请显式传入 --confirm-candidate-benchmark yes");
}

validateWorkload(options);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-workspace-benchmark-"));
const startedAt = performance.now();
const results = [];
try {
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const iterationRoot = path.join(temporaryRoot, `iteration-${iteration}`);
    await fs.mkdir(iterationRoot);
    results.push(await benchmarkMap(options, iteration));
    results.push(await benchmarkInfiniteMap(options, iteration));
    results.push(await benchmarkAssets(options, iteration));
    results.push(await benchmarkWorld(options, iteration));
    results.push(await benchmarkImage(options, iteration));
    results.push(await benchmarkResourcePaging(options, iteration, iterationRoot));
  }
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  benchmark: "wfl-map-workspace",
  policy: "manual-candidate-only",
  configuration: publicConfiguration(options),
  durationMs: round(performance.now() - startedAt),
  fileCount: options.resourceFileCount * options.iterations,
  results,
}, null, 2)}\n`);

async function benchmarkMap(input, iteration) {
  return measure("tiled-map-roundtrip", iteration, 0, async (sampleMemory) => {
    const cellsPerLayer = input.mapWidth * input.mapHeight;
    const layers = [];
    for (let layerIndex = 0; layerIndex < input.mapLayers; layerIndex += 1) {
      const data = new Array(cellsPerLayer);
      for (let index = 0; index < data.length; index += 1) data[index] = ((index + layerIndex) % 31) + 1;
      layers.push({
        id: layerIndex + 1,
        name: `Benchmark ${layerIndex + 1}`,
        type: "tilelayer",
        width: input.mapWidth,
        height: input.mapHeight,
        visible: true,
        opacity: 1,
        data,
      });
    }
    sampleMemory();
    const document = {
      type: "map",
      version: "1.12",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      renderorder: "right-down",
      width: input.mapWidth,
      height: input.mapHeight,
      tilewidth: 16,
      tileheight: 16,
      infinite: false,
      nextlayerid: input.mapLayers + 1,
      nextobjectid: 1,
      layers,
      tilesets: [],
    };
    const serialized = serializeTiledDocument(document, { trailingNewline: true });
    sampleMemory();
    const parsed = parseTiledDocument(serialized, { sourcePath: "benchmark/map.tmj" });
    if (parsed.document.layers.length !== input.mapLayers) throw new Error("地图往返后的图层数量不一致");
    if (parsed.document.layers.some((layer) => layer.data.length !== cellsPerLayer)) {
      throw new Error("地图往返后的图层数据长度不一致");
    }
    sampleMemory();
  });
}

async function benchmarkInfiniteMap(input, iteration) {
  return measure("tiled-infinite-chunks-roundtrip", iteration, 0, async (sampleMemory) => {
    const cellsPerChunk = input.infiniteChunkWidth * input.infiniteChunkHeight;
    const chunkColumns = Math.max(1, Math.ceil(Math.sqrt(input.infiniteChunkCount)));
    const chunks = new Array(input.infiniteChunkCount);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const data = new Array(cellsPerChunk);
      for (let index = 0; index < data.length; index += 1) data[index] = ((index + chunkIndex) % 31) + 1;
      chunks[chunkIndex] = {
        x: (chunkIndex % chunkColumns - Math.floor(chunkColumns / 2)) * input.infiniteChunkWidth,
        y: (Math.floor(chunkIndex / chunkColumns) - Math.floor(chunkColumns / 2)) * input.infiniteChunkHeight,
        width: input.infiniteChunkWidth,
        height: input.infiniteChunkHeight,
        data,
      };
    }
    sampleMemory();
    const document = {
      type: "map",
      version: "1.12",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      renderorder: "right-down",
      width: 0,
      height: 0,
      tilewidth: 16,
      tileheight: 16,
      infinite: true,
      nextlayerid: 2,
      nextobjectid: 1,
      layers: [{
        id: 1,
        name: "Infinite Benchmark",
        type: "tilelayer",
        width: 0,
        height: 0,
        startx: 0,
        starty: 0,
        chunks,
      }],
      tilesets: [],
    };
    const serialized = serializeTiledDocument(document, { trailingNewline: true });
    sampleMemory();
    const parsed = parseTiledDocument(serialized, { sourcePath: "benchmark/infinite.tmj" });
    const parsedChunks = parsed.document.layers[0]?.chunks;
    if (!Array.isArray(parsedChunks) || parsedChunks.length !== input.infiniteChunkCount) {
      throw new Error("无限地图往返后的分块数量不一致");
    }
    if (parsedChunks.some((chunk) => (
      chunk.width !== input.infiniteChunkWidth
      || chunk.height !== input.infiniteChunkHeight
      || chunk.data.length !== cellsPerChunk
    ))) throw new Error("无限地图往返后的分块尺寸或数据长度不一致");
    sampleMemory();
  });
}

async function benchmarkAssets(input, iteration) {
  return measure("asset-index-search-sort-roundtrip", iteration, 0, async (sampleMemory) => {
    const entries = new Array(input.assetCount);
    for (let index = 0; index < entries.length; index += 1) {
      const extension = index % 5 === 0 ? "tsj" : "png";
      entries[index] = {
        path: `assets/group-${String(index % 97).padStart(2, "0")}/plant-${String(index).padStart(7, "0")}.${extension}`,
        name: `plant-${String(index).padStart(7, "0")}.${extension}`,
        kind: extension === "tsj" ? "tileset" : "image",
        size: 128 + index,
        mtime: index,
        favorite: index % 101 === 0,
        lastUsedAt: index,
        tags: [index % 2 === 0 ? "plant" : "terrain", `group-${index % 97}`],
      };
    }
    sampleMemory();
    const library = createMapAssetLibrary({ projectPath: "benchmark", entries, updatedAt: 1 });
    sampleMemory();
    const matches = searchMapAssets(library, "plant", { sort: "recent" });
    const sorted = sortedMapAssets(library.entries.values(), { sort: "favorite" });
    if (matches.length !== input.assetCount || sorted.length !== input.assetCount) {
      throw new Error("素材库搜索或排序遗漏条目");
    }
    const serialized = serializeMapAssetLibrary(library);
    const parsed = parseMapAssetLibrary(serialized);
    if (parsed.entries.size !== input.assetCount) throw new Error("素材库往返后的条目数量不一致");
    sampleMemory();
  });
}

async function benchmarkWorld(input, iteration) {
  return measure("tiled-world-geometry-roundtrip", iteration, 0, async (sampleMemory) => {
    const maps = new Array(input.worldMapCount);
    for (let index = 0; index < maps.length; index += 1) {
      maps[index] = {
        fileName: `maps/map-${String(index).padStart(7, "0")}.tmj`,
        x: (index % input.worldColumns) * 256,
        y: Math.floor(index / input.worldColumns) * 256,
        width: 256,
        height: 256,
      };
    }
    const document = createTiledWorld({ maps, onlyShowAdjacentMaps: true });
    sampleMemory();
    const bounds = worldBounds(document);
    const selectedIndex = Math.floor(input.worldMapCount / 2);
    const selected = maps[selectedIndex];
    const hit = worldMapAtPoint(document, selected.x + 128, selected.y + 128);
    const adjacent = adjacentWorldMapIndexes(document, selectedIndex);
    if (hit?.index !== selectedIndex || adjacent.some((index) => index === selectedIndex)) {
      throw new Error("World 命中或邻接计算结果无效");
    }
    if (bounds.width <= 0 || bounds.height <= 0) throw new Error("World 边界无效");
    const serialized = serializeTiledWorld(document);
    const parsed = parseTiledWorld(serialized, { sourcePath: "benchmark/game.world" });
    if (parsed.document.maps.length !== input.worldMapCount) throw new Error("World 往返后的地图数量不一致");
    sampleMemory();
  });
}

async function benchmarkImage(input, iteration) {
  return measure("image-metadata-and-decode", iteration, 0, async (sampleMemory) => {
    const encoded = await sharp({
      create: {
        width: input.imageWidth,
        height: input.imageHeight,
        channels: 4,
        background: { r: 34, g: 96, b: 52, alpha: 0.75 },
      },
    }).png().toBuffer();
    sampleMemory();
    const imageOptions = {
      maxBytes: Math.max(encoded.length, 1),
      maxWidth: input.imageWidth,
      maxHeight: input.imageHeight,
      maxPixels: input.imageWidth * input.imageHeight,
      allowedFormats: ["png"],
    };
    const jobs = Array.from({ length: input.imageCount }, (_, index) => index);
    await mapWithConcurrency(jobs, input.ioConcurrency, async () => {
      const metadata = inspectImageBuffer(encoded, imageOptions);
      const decoded = await inspectDecodedImageBuffer(encoded, imageOptions);
      if (
        metadata.width !== input.imageWidth
        || metadata.height !== input.imageHeight
        || decoded.width !== input.imageWidth
        || decoded.height !== input.imageHeight
      ) throw new Error("图片检查返回的尺寸与实际尺寸不一致");
      sampleMemory();
    });
  });
}

async function benchmarkResourcePaging(input, iteration, iterationRoot) {
  return measure("resource-directory-pagination", iteration, input.resourceFileCount, async (sampleMemory) => {
    const resourceRoot = path.join(iterationRoot, "resources");
    await fs.mkdir(resourceRoot);
    const indexes = Array.from({ length: input.resourceFileCount }, (_, index) => index);
    await mapWithConcurrency(indexes, input.ioConcurrency, (index) => fs.writeFile(
      path.join(resourceRoot, `resource-${String(index).padStart(7, "0")}.png`),
      "",
    ));
    sampleMemory();
    const catalog = new MapResourceCatalog({
      defaultPageSize: input.resourcePageSize,
      maxPageSize: input.resourcePageSize,
    });
    let cursor = null;
    let count = 0;
    do {
      const page = await catalog.list({
        projectPath: resourceRoot,
        limit: input.resourcePageSize,
        ...(cursor ? { cursor } : {}),
      });
      count += page.entries.length;
      cursor = page.nextCursor;
      sampleMemory();
    } while (cursor);
    if (count !== input.resourceFileCount) throw new Error("资源目录分页遗漏文件");
  });
}

async function measure(name, iteration, fileCount, operation) {
  const before = memorySnapshot();
  let peak = before;
  const sampleMemory = () => {
    peak = maxMemory(peak, memorySnapshot());
  };
  const startedAt = performance.now();
  await operation(sampleMemory);
  sampleMemory();
  const after = memorySnapshot();
  return {
    name,
    iteration,
    durationMs: round(performance.now() - startedAt),
    fileCount,
    memory: {
      before,
      peak,
      after,
      delta: subtractMemory(after, before),
    },
  };
}

async function mapWithConcurrency(values, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

function parseArguments(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`未知或缺值参数：${key || "(空)"}\n${usage()}`);
    }
    const normalized = key.slice(2);
    if (values.has(normalized)) throw new Error(`参数重复：${key}`);
    values.set(normalized, value);
  }
  const requiredInteger = (key, maximum) => integerArgument(values, key, maximum);
  const known = new Set([
    "confirm-candidate-benchmark",
    "map-width", "map-height", "map-layers", "max-total-tile-cells",
    "infinite-chunk-width", "infinite-chunk-height", "infinite-chunk-count",
    "asset-count",
    "world-map-count", "world-columns",
    "image-width", "image-height", "image-count", "max-total-image-pixels",
    "resource-file-count", "max-resource-files", "resource-page-size",
    "io-concurrency", "iterations",
  ]);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`未知参数：--${key}\n${usage()}`);
  return {
    help: false,
    confirmCandidateBenchmark: values.get("confirm-candidate-benchmark"),
    mapWidth: requiredInteger("map-width", 100_000),
    mapHeight: requiredInteger("map-height", 100_000),
    mapLayers: requiredInteger("map-layers", 10_000),
    maxTotalTileCells: requiredInteger("max-total-tile-cells", HARD_LIMITS.totalTileCells),
    infiniteChunkWidth: requiredInteger("infinite-chunk-width", 100_000),
    infiniteChunkHeight: requiredInteger("infinite-chunk-height", 100_000),
    infiniteChunkCount: requiredInteger("infinite-chunk-count", 1_000_000),
    assetCount: requiredInteger("asset-count", HARD_LIMITS.assetCount),
    worldMapCount: requiredInteger("world-map-count", HARD_LIMITS.worldMapCount),
    worldColumns: requiredInteger("world-columns", HARD_LIMITS.worldMapCount),
    imageWidth: requiredInteger("image-width", 32_768),
    imageHeight: requiredInteger("image-height", 32_768),
    imageCount: requiredInteger("image-count", 10_000),
    maxTotalImagePixels: requiredInteger("max-total-image-pixels", HARD_LIMITS.totalImagePixels),
    resourceFileCount: requiredInteger("resource-file-count", HARD_LIMITS.resourceFileCount),
    maxResourceFiles: requiredInteger("max-resource-files", HARD_LIMITS.resourceFileCount),
    resourcePageSize: requiredInteger("resource-page-size", 200),
    ioConcurrency: requiredInteger("io-concurrency", HARD_LIMITS.ioConcurrency),
    iterations: requiredInteger("iterations", HARD_LIMITS.iterations),
  };
}

function integerArgument(values, key, maximum) {
  if (!values.has(key)) throw new Error(`缺少必填参数：--${key}\n${usage()}`);
  const number = Number(values.get(key));
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`--${key} 必须是 1-${maximum} 的整数`);
  }
  return number;
}

function validateWorkload(input) {
  const finiteTileCells = checkedProduct(input.mapWidth, input.mapHeight, input.mapLayers, "有限地图总格数");
  const infiniteTileCells = checkedProduct(
    input.infiniteChunkWidth,
    input.infiniteChunkHeight,
    input.infiniteChunkCount,
    "无限地图总格数",
  );
  const tileCells = checkedSum(finiteTileCells, infiniteTileCells, "地图总格数");
  if (tileCells > input.maxTotalTileCells) {
    throw new Error(`地图总格数 ${tileCells} 超过管理员显式上限 ${input.maxTotalTileCells}`);
  }
  const imagePixels = checkedProduct(input.imageWidth, input.imageHeight, input.imageCount, "图片总解码像素");
  if (imagePixels > input.maxTotalImagePixels) {
    throw new Error(`图片总解码像素 ${imagePixels} 超过管理员显式上限 ${input.maxTotalImagePixels}`);
  }
  if (input.resourceFileCount > input.maxResourceFiles) {
    throw new Error(`资源文件数 ${input.resourceFileCount} 超过管理员显式上限 ${input.maxResourceFiles}`);
  }
  if (input.worldColumns > input.worldMapCount) {
    throw new Error("--world-columns 不能超过 --world-map-count");
  }
}

function checkedProduct(...values) {
  const label = values.pop();
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result)) throw new Error(`${label}超过 JavaScript 安全整数范围`);
  }
  return result;
}

function checkedSum(...values) {
  const label = values.pop();
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) throw new Error(`${label}超过 JavaScript 安全整数范围`);
  }
  return result;
}

function publicConfiguration(input) {
  return {
    mapWidth: input.mapWidth,
    mapHeight: input.mapHeight,
    mapLayers: input.mapLayers,
    maxTotalTileCells: input.maxTotalTileCells,
    infiniteChunkWidth: input.infiniteChunkWidth,
    infiniteChunkHeight: input.infiniteChunkHeight,
    infiniteChunkCount: input.infiniteChunkCount,
    assetCount: input.assetCount,
    worldMapCount: input.worldMapCount,
    worldColumns: input.worldColumns,
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    imageCount: input.imageCount,
    maxTotalImagePixels: input.maxTotalImagePixels,
    resourceFileCount: input.resourceFileCount,
    maxResourceFiles: input.maxResourceFiles,
    resourcePageSize: input.resourcePageSize,
    ioConcurrency: input.ioConcurrency,
    iterations: input.iterations,
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function maxMemory(left, right) {
  return {
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    arrayBuffersBytes: Math.max(left.arrayBuffersBytes, right.arrayBuffersBytes),
  };
}

function subtractMemory(left, right) {
  return {
    rssBytes: left.rssBytes - right.rssBytes,
    heapUsedBytes: left.heapUsedBytes - right.heapUsedBytes,
    arrayBuffersBytes: left.arrayBuffersBytes - right.arrayBuffersBytes,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function usage() {
  return [
    "用法：node scripts/benchmark-map-workspace.mjs [全部显式参数]",
    "  --confirm-candidate-benchmark yes",
    "  --map-width N --map-height N --map-layers N --max-total-tile-cells N",
    "  --infinite-chunk-width N --infinite-chunk-height N --infinite-chunk-count N",
    "  --asset-count N",
    "  --world-map-count N --world-columns N",
    "  --image-width N --image-height N --image-count N --max-total-image-pixels N",
    "  --resource-file-count N --max-resource-files N --resource-page-size N",
    "  --io-concurrency N --iterations N",
    "所有规模、上限、分页和并发都由管理员手动给出；脚本不会自动调档或修改服务设置。",
  ].join("\n");
}
