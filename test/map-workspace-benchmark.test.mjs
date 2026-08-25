import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workspaceBenchmark = path.join(repositoryRoot, "scripts", "benchmark-map-workspace.mjs");
const fillBenchmark = path.join(repositoryRoot, "scripts", "benchmark-map-fill.mjs");

const smallArguments = [
  "--map-width", "4",
  "--map-height", "3",
  "--map-layers", "2",
  "--max-total-tile-cells", "36",
  "--infinite-chunk-width", "2",
  "--infinite-chunk-height", "2",
  "--infinite-chunk-count", "3",
  "--asset-count", "8",
  "--world-map-count", "9",
  "--world-columns", "3",
  "--image-width", "8",
  "--image-height", "6",
  "--image-count", "2",
  "--max-total-image-pixels", "96",
  "--resource-file-count", "7",
  "--max-resource-files", "7",
  "--resource-page-size", "3",
  "--io-concurrency", "2",
  "--iterations", "1",
];

test("workspace benchmark refuses to run without explicit candidate confirmation", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [workspaceBenchmark, ...smallArguments], { cwd: repositoryRoot }),
    (error) => error.code === 1 && /confirm-candidate-benchmark yes/u.test(error.stderr),
  );
});

test("workspace benchmark uses only explicit manual parameters and reports bounded metrics", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    workspaceBenchmark,
    "--confirm-candidate-benchmark", "yes",
    ...smallArguments,
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.benchmark, "wfl-map-workspace");
  assert.equal(report.policy, "manual-candidate-only");
  assert.equal(report.configuration.mapWidth, 4);
  assert.equal(report.configuration.ioConcurrency, 2);
  assert.equal(report.fileCount, 7);
  assert.deepEqual(report.results.map((entry) => entry.name), [
    "tiled-map-roundtrip",
    "tiled-infinite-chunks-roundtrip",
    "asset-index-search-sort-roundtrip",
    "tiled-world-geometry-roundtrip",
    "image-metadata-and-decode",
    "resource-directory-pagination",
  ]);
  for (const result of report.results) {
    assert.equal(result.iteration, 1);
    assert.equal(typeof result.durationMs, "number");
    for (const section of ["before", "peak", "after", "delta"]) {
      assert.deepEqual(Object.keys(result.memory[section]), ["rssBytes", "heapUsedBytes", "arrayBuffersBytes"]);
    }
  }
});

test("workspace benchmark enforces the administrator-provided workload ceilings", async () => {
  const argumentsWithLowLimit = [...smallArguments];
  argumentsWithLowLimit[argumentsWithLowLimit.indexOf("--max-total-tile-cells") + 1] = "35";
  await assert.rejects(
    execFileAsync(process.execPath, [
      workspaceBenchmark,
      "--confirm-candidate-benchmark", "yes",
      ...argumentsWithLowLimit,
    ], { cwd: repositoryRoot }),
    (error) => error.code === 1 && /超过管理员显式上限/u.test(error.stderr),
  );
});

test("legacy fill benchmark also requires explicit candidate confirmation", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [fillBenchmark, "--width", "2", "--height", "2", "--max-cells", "4", "--iterations", "1"], {
      cwd: repositoryRoot,
    }),
    (error) => error.code === 1 && /confirm-candidate-benchmark yes/u.test(error.stderr),
  );
});

test("legacy fill benchmark requires every workload parameter and runs a confirmed small sample", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [fillBenchmark, "--confirm-candidate-benchmark", "yes", "--width", "2"], {
      cwd: repositoryRoot,
    }),
    (error) => error.code === 1 && /缺少必填参数/u.test(error.stderr),
  );
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fillBenchmark,
    "--confirm-candidate-benchmark", "yes",
    "--width", "2",
    "--height", "2",
    "--max-cells", "4",
    "--iterations", "1",
  ], { cwd: repositoryRoot });
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.policy, "manual-candidate-only");
  assert.equal(report.cells, 4);
  assert.equal(report.samples.length, 1);
});
