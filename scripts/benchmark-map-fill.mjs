#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import { findTiledFillRegion } from "../public/map-editor/tiled-fill.js";

const options = parseArguments(process.argv.slice(2));
if (options.confirmCandidateBenchmark !== "yes") {
  throw new Error("该性能基准只能在开发/候选服务器运行；请显式传入 --confirm-candidate-benchmark yes");
}
const cells = options.width * options.height;
if (!Number.isSafeInteger(cells) || cells <= 0 || cells > options.maxCells) {
  throw new Error(`基准地图 ${options.width}×${options.height} 超过显式上限 ${options.maxCells} 格`);
}

const samples = [];
for (let iteration = 0; iteration < options.iterations; iteration += 1) {
  const data = new Uint32Array(cells);
  data.fill(1);
  const beforeMemory = process.memoryUsage();
  const startedAt = performance.now();
  const result = findTiledFillRegion({
    blocks: [{ x: 0, y: 0, width: options.width, height: options.height, data }],
    x: 0,
    y: 0,
    replacement: 2,
    maxCells: options.maxCells,
  });
  const foundAt = performance.now();
  const editor = new TiledEditDocument({
    type: "map",
    width: options.width,
    height: options.height,
    tilewidth: 16,
    tileheight: 16,
    layers: [{
      id: 1,
      name: "Benchmark",
      type: "tilelayer",
      width: options.width,
      height: options.height,
      data: Array.from(data),
    }],
    tilesets: [],
  });
  result.blocks = [{ kind: "data", x: 0, y: 0, width: options.width, height: options.height }];
  editor.applyTileFillResult(1, result, { expectedStateId: 0 });
  const committedAt = performance.now();
  editor.undo();
  const undoneAt = performance.now();
  editor.redo();
  const finishedAt = performance.now();
  const afterMemory = process.memoryUsage();
  samples.push({
    iteration: iteration + 1,
    cells: result.count,
    findMs: round(foundAt - startedAt),
    commitMs: round(committedAt - foundAt),
    undoMs: round(undoneAt - committedAt),
    redoMs: round(finishedAt - undoneAt),
    totalMs: round(finishedAt - startedAt),
    rssDeltaBytes: afterMemory.rss - beforeMemory.rss,
    heapUsedDeltaBytes: afterMemory.heapUsed - beforeMemory.heapUsed,
    arrayBuffersDeltaBytes: afterMemory.arrayBuffers - beforeMemory.arrayBuffers,
  });
}

const totals = samples.map((sample) => sample.totalMs).sort((left, right) => left - right);
process.stdout.write(`${JSON.stringify({
  benchmark: "wfl-map-fill",
  policy: "manual-candidate-only",
  width: options.width,
  height: options.height,
  cells,
  iterations: options.iterations,
  medianTotalMs: totals[Math.floor(totals.length / 2)],
  samples,
}, null, 2)}\n`);

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`未知或缺值参数：${key}`);
    values.set(key.slice(2), args[index + 1]);
    index += 1;
  }
  const width = requiredBoundedInteger(values, "width", 1, 100_000);
  const height = requiredBoundedInteger(values, "height", 1, 100_000);
  const maxCells = requiredBoundedInteger(values, "max-cells", 1, 100_000_000);
  const iterations = requiredBoundedInteger(values, "iterations", 1, 20);
  const confirmCandidateBenchmark = values.get("confirm-candidate-benchmark");
  const known = new Set(["width", "height", "max-cells", "iterations", "confirm-candidate-benchmark"]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`未知参数：--${key}`);
  }
  return { width, height, maxCells, iterations, confirmCandidateBenchmark };
}

function requiredBoundedInteger(values, label, minimum, maximum) {
  if (!values.has(label)) throw new Error(`缺少必填参数：--${label}`);
  const number = Number(values.get(label));
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return number;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
