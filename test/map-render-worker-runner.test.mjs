import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import {
  commitMapRenderOutputs,
  createMapRenderWorkerRunner,
  processTreeRssBytes,
  verifyWorkerOutputs,
} from "../lib/map-render-worker-runner.mjs";
import { MAP_RENDER_PRESETS } from "../lib/map-render-settings.mjs";

test("daemon preserves base64url task ids that begin with dash or underscore", async () => {
  const workerPath = path.resolve(new URL("../scripts/map-render-worker.mjs", import.meta.url).pathname);
  const child = spawn(process.execPath, [workerPath, "--daemon"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = [];
  output.on("line", (line) => lines.push(JSON.parse(line)));
  try {
    child.stdin.write(`${JSON.stringify({ id: "-base64url-task", inputPath: "" })}\n`);
    child.stdin.write(`${JSON.stringify({ id: "_base64url-task", inputPath: "" })}\n`);
    await waitFor(() => lines.length === 2, "daemon responses");
    assert.deepEqual(lines.map(({ id, ok }) => ({ id, ok })), [
      { id: "-base64url-task", ok: false },
      { id: "_base64url-task", ok: false },
    ]);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    output.close();
  }
});

test("commits verified worker files as one new project directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-commit-"));
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const staging = path.join(root, "staging");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.join(staging, "tiles"), { recursive: true });
    const mapSource = "{}\n";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(path.join(staging, "tiles", "tile.png"), "rendered");
    const fileHash = crypto.createHash("sha256").update("rendered").digest("hex");
    const job = jobFixture(projectPath, targetPath, crypto.createHash("sha256").update(mapSource).digest("hex"));
    const result = await commitMapRenderOutputs(job, {
      summary: "done",
      files: [{ path: "tiles/tile.png", size: 8, sha256: fileHash, mediaType: "image/png" }],
    }, staging);
    assert.match(result.outputDirectory, /^exports\/maps\/world-map-panorama-/u);
    assert.equal(await fs.readFile(path.join(projectPath, result.outputDirectory, "tiles", "tile.png"), "utf8"), "rendered");
    assert.equal((await fs.stat(path.join(projectPath, result.outputDirectory, "tiles", "tile.png"))).mode & 0o777, 0o640);
    assert.equal((await fs.stat(path.join(projectPath, result.outputDirectory))).mode & 0o777, 0o750);
    assert.equal((await fs.stat(path.join(projectPath, result.outputDirectory, "tiles"))).mode & 0o777, 0o750);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not turn a committed output into a failed task when its notification throws", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-notify-"));
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const staging = path.join(root, "staging");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(staging);
    const mapSource = "{}\n";
    const output = "rendered";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(path.join(staging, "map.png"), output);
    const errors = [];
    const result = await commitMapRenderOutputs(
      jobFixture(projectPath, targetPath, crypto.createHash("sha256").update(mapSource).digest("hex")),
      {
        summary: "done",
        files: [{
          path: "map.png",
          size: Buffer.byteLength(output),
          sha256: crypto.createHash("sha256").update(output).digest("hex"),
          mediaType: "image/png",
        }],
      },
      staging,
      {
        onCommitted: async () => { throw new Error("accounting unavailable"); },
        onCommitError: async (error) => errors.push(error.message),
      },
    );
    assert.equal(await fs.readFile(path.join(projectPath, result.outputDirectory, "map.png"), "utf8"), output);
    assert.deepEqual(errors, ["accounting unavailable"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects undeclared or modified staging output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-verify-"));
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "map.png"), "image");
    const hash = crypto.createHash("sha256").update("image").digest("hex");
    await assert.rejects(
      verifyWorkerOutputs(root, [{ path: "map.png", size: 5, sha256: "0".repeat(64) }]),
      (error) => error.code === "worker-manifest-invalid",
    );
    await fs.writeFile(path.join(root, "extra.png"), "extra");
    await assert.rejects(
      verifyWorkerOutputs(root, [{ path: "map.png", size: 5, sha256: hash }]),
      (error) => error.code === "worker-manifest-invalid",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("kills only the worker whose sampled process tree exceeds its task budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-runner-"));
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const mapSource = "{}\n";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(fakeWorker, "setInterval(() => {}, 1000);\n");
    const job = jobFixture(projectPath, targetPath, crypto.createHash("sha256").update(mapSource).digest("hex"));
    const runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      pollMs: 25,
      processTreeMemory: async () => 300 * 1024 * 1024,
      commitOutputs: async () => assert.fail("over-budget worker must not commit"),
    });
    await assert.rejects(
      runner(job, {}),
      (error) => error.code === "memory-budget-exceeded",
    );
    assert.equal(await fs.readdir(runtimeDirectory).then((entries) => entries.length), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fails an over-budget preview capture without exposing a temporary image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-preview-capture-memory-"));
  let runner;
  try {
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.writeFile(fakeWorker, "setInterval(() => {}, 1000);\n");
    runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      pollMs: 25,
      processTreeMemory: async () => 300 * 1024 * 1024,
      commitOutputs: async () => assert.fail("over-budget preview capture must not commit"),
    });
    await assert.rejects(
      runner(previewCaptureFixture()),
      (error) => error.code === "memory-budget-exceeded",
    );
    assert.equal(runner.status().workerCount, 0);
    assert.deepEqual(await fs.readdir(runtimeDirectory), []);
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("samples the current Linux process without reading unrelated memory into Node", async () => {
  const bytes = await processTreeRssBytes(process.pid);
  if (process.platform === "linux") assert.ok(bytes > 0);
  else assert.equal(bytes, 0);
});

test("ignores a memory sample that resolves after the worker has exited", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-late-sample-"));
  let runner;
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-worker.mjs");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const mapSource = "{}\n";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(fakeWorker, [
      "import crypto from 'node:crypto';",
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "import readline from 'node:readline';",
      "for await (const line of readline.createInterface({ input: process.stdin })) {",
      "  const request = JSON.parse(line);",
      "  const input = JSON.parse(await fs.readFile(request.inputPath, 'utf8'));",
      "  await fs.mkdir(input.outputDirectory, { recursive: true });",
      "  const content = 'ok';",
      "  await fs.writeFile(path.join(input.outputDirectory, 'map.png'), content);",
      "  await new Promise((resolve) => setTimeout(resolve, 60));",
      "  const result = { summary: 'done', files: [{ path: 'map.png', size: 2, sha256: crypto.createHash('sha256').update(content).digest('hex'), mediaType: 'image/png' }] };",
      "  console.log(JSON.stringify({ id: request.id, ok: true, result }));",
      "}",
    ].join("\n"));
    let resolveSample;
    const sampled = new Promise((resolve) => { resolveSample = resolve; });
    let sampleStarted;
    const sampleWasStarted = new Promise((resolve) => { sampleStarted = resolve; });
    runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      pollMs: 25,
      processTreeMemory: async () => {
        sampleStarted();
        return sampled;
      },
      commitOutputs: async (_job, workerResult) => ({
        summary: workerResult.summary,
        outputDirectory: "exports/maps/result",
        files: workerResult.files,
      }),
    });
    const run = runner(jobFixture(
      projectPath,
      targetPath,
      crypto.createHash("sha256").update(mapSource).digest("hex"),
    ));
    await sampleWasStarted;
    const result = await run;
    resolveSample(300 * 1024 * 1024);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.summary, "done");
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cancels only the active worker task, cleans its staging directory, and accepts the next task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-cancel-"));
  let runner;
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-daemon.mjs");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const mapSource = "{}\n";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(fakeWorker, daemonWorkerSource());
    runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      commitOutputs: async (job, workerResult) => ({
        summary: workerResult.summary,
        outputDirectory: `exports/maps/${job.id}`,
        files: workerResult.files,
      }),
    });
    const version = crypto.createHash("sha256").update(mapSource).digest("hex");
    const canceledJob = jobFixture(projectPath, targetPath, version);
    canceledJob.spec = { delayMs: 5_000 };
    canceledJob.settings.config.worker.taskTimeoutMs = 10_000;
    const controller = new AbortController();
    const canceledRun = runner(canceledJob, { signal: controller.signal });
    await waitFor(() => runner.status().workerCount === 1, "active worker");
    controller.abort();
    await assert.rejects(canceledRun, (error) => error.code === "ABORT_ERR");
    assert.equal(runner.status().workerCount, 0);
    await assert.rejects(
      fs.stat(path.join(runtimeDirectory, canceledJob.id)),
      (error) => error.code === "ENOENT",
    );

    const nextJob = jobFixture(projectPath, targetPath, version);
    nextJob.id = "renderjob0000000000000002";
    const result = await runner(nextJob);
    assert.equal(result.outputDirectory, `exports/maps/${nextJob.id}`);
    assert.equal(result.files[0].path, "map.png");
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps the task timeout active through output verification and commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-total-timeout-"));
  let runner;
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-daemon.mjs");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const mapSource = "{}\n";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(fakeWorker, daemonWorkerSource());
    let commitStarted = false;
    runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      commitOutputs: async (_job, _workerResult, _outputDirectory, { signal }) => {
        commitStarted = true;
        await new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const job = jobFixture(
      projectPath,
      targetPath,
      crypto.createHash("sha256").update(mapSource).digest("hex"),
    );
    job.settings = structuredClone(job.settings);
    job.settings.config.worker.taskTimeoutMs = 1_000;
    const startedAt = Date.now();
    await assert.rejects(runner(job), (error) => error.code === "render-timeout");
    assert.equal(commitStarted, true);
    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal((await fs.readdir(runtimeDirectory)).includes(job.id), false);
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reuses an idle worker with the same memory budget until manual reconfiguration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-pool-"));
  let runner;
  try {
    const projectPath = path.join(root, "project");
    const targetPath = path.join(projectPath, "maps", "world.tmj");
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-daemon.mjs");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const mapSource = "{}\n";
    await fs.writeFile(targetPath, mapSource);
    await fs.writeFile(fakeWorker, daemonWorkerSource());
    runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      commitOutputs: async (_job, workerResult) => ({
        summary: workerResult.summary,
        outputDirectory: "exports/maps/result",
        files: workerResult.files,
      }),
    });
    const fixture = jobFixture(
      projectPath,
      targetPath,
      crypto.createHash("sha256").update(mapSource).digest("hex"),
    );
    const quickRecycle = structuredClone(fixture.settings);
    quickRecycle.config.worker.idleRecycleMs = 1_000;
    const first = await runner({ ...fixture, id: "renderjob0000000000000001", settings: quickRecycle });
    assert.equal(runner.status().workerCount, 1);
    assert.equal(runner.status().idleWorkerCount, 1);
    const second = await runner({ ...fixture, id: "renderjob0000000000000002", settings: quickRecycle });
    assert.equal(second.summary, first.summary);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(runner.status().workerCount, 0);
    const thirdRun = runner({
      ...fixture,
      id: "renderjob0000000000000003",
      spec: { ...fixture.spec, delayMs: 75 },
      settings: quickRecycle,
    });
    while (runner.status().workerCount === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    runner.reconcile({ config: { worker: { enabled: false, memoryMb: 256 } } });
    await thirdRun;
    assert.equal(runner.status().workerCount, 0);
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("returns preview screenshots as disposable temporary leases without committing project output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-preview-capture-runner-"));
  let runner;
  try {
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const fakeWorker = path.join(root, "fake-daemon.mjs");
    await fs.writeFile(fakeWorker, daemonWorkerSource());
    let commits = 0;
    runner = createMapRenderWorkerRunner({
      runtimeDirectory,
      workerPath: fakeWorker,
      commitOutputs: async () => {
        commits += 1;
        throw new Error("preview capture must not commit output");
      },
    });
    const lease = await runner(previewCaptureFixture());
    assert.equal(commits, 0);
    assert.equal(lease.mediaType, "image/png");
    assert.equal(await fs.readFile(lease.filePath, "utf8"), "ok");
    assert.equal(path.basename(lease.filePath), "screenshot.png");
    const taskDirectory = path.dirname(path.dirname(lease.filePath));
    await lease.dispose();
    await lease.dispose();
    await assert.rejects(fs.stat(taskDirectory), (error) => error.code === "ENOENT");
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clears only the dedicated render cache and preserves task directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-cache-clear-"));
  let runner;
  try {
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const activeInput = path.join(runtimeDirectory, "active-task", "input.json");
    const cacheFile = path.join(runtimeDirectory, ".cache", "image", "cached.bin");
    await fs.mkdir(path.dirname(activeInput), { recursive: true });
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(activeInput, "task");
    await fs.writeFile(cacheFile, "cache");
    runner = createMapRenderWorkerRunner({ runtimeDirectory });
    const cleared = await runner.clearCache();
    assert.deepEqual(cleared, { files: 1, bytes: 5, activeWorkers: 0 });
    assert.equal(await fs.readFile(activeInput, "utf8"), "task");
    assert.deepEqual(await fs.readdir(path.join(runtimeDirectory, ".cache")), []);
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovers only dead or stale render task directories from the shared runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-recovery-"));
  let runner;
  try {
    const runtimeDirectory = path.join(root, "runtime", "map-render");
    const deadTask = path.join(runtimeDirectory, "dead-task");
    const liveTask = path.join(runtimeDirectory, "live-task");
    const recentLegacyTask = path.join(runtimeDirectory, "recent-legacy-task");
    const staleLegacyTask = path.join(runtimeDirectory, "stale-legacy-task");
    const cacheFile = path.join(runtimeDirectory, ".cache", "image", "cached.bin");
    await Promise.all([
      fs.mkdir(deadTask, { recursive: true }),
      fs.mkdir(liveTask, { recursive: true }),
      fs.mkdir(recentLegacyTask, { recursive: true }),
      fs.mkdir(staleLegacyTask, { recursive: true }),
      fs.mkdir(path.dirname(cacheFile), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(deadTask, ".wfl-render-owner.json"), `${JSON.stringify({ pid: 2_147_483_647 })}\n`),
      fs.writeFile(path.join(liveTask, ".wfl-render-owner.json"), `${JSON.stringify({ pid: process.pid })}\n`),
      fs.writeFile(cacheFile, "cache"),
    ]);
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    await fs.utimes(staleLegacyTask, staleTime, staleTime);

    runner = createMapRenderWorkerRunner({ runtimeDirectory });
    await runner.initialize();

    await assert.rejects(fs.stat(deadTask), (error) => error.code === "ENOENT");
    await assert.rejects(fs.stat(staleLegacyTask), (error) => error.code === "ENOENT");
    assert.equal((await fs.stat(liveTask)).isDirectory(), true);
    assert.equal((await fs.stat(recentLegacyTask)).isDirectory(), true);
    assert.equal(await fs.readFile(cacheFile, "utf8"), "cache");
  } finally {
    await runner?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function jobFixture(projectPath, targetPath, version) {
  return {
    id: "renderjob0000000000000001",
    identity: {
      userId: "user-1",
      browserSessionId: "browser-1",
      editorInstanceId: "editor-window-0001",
    },
    mapContext: {
      projectPath,
      targetPath,
      relativePath: "maps/world.tmj",
      version,
    },
    kind: "map-panorama",
    outputRoot: "exports/maps",
    spec: { scale: 1 },
    settings: {
      version: 1,
      revision: 1,
      preset: "stable",
      config: {
        ...structuredClone(MAP_RENDER_PRESETS.stable),
        worker: { ...MAP_RENDER_PRESETS.stable.worker, memoryMb: 256, taskTimeoutMs: 2_000 },
      },
    },
  };
}

function previewCaptureFixture() {
  return {
    id: "previewcapture000000000001",
    identity: {
      userId: "user-1",
      browserSessionId: "browser-1",
      editorInstanceId: "project-preview-capture",
    },
    kind: "preview-capture",
    capture: {
      url: "http://127.0.0.1:3000/preview/token/game/index.html",
      requestOrigin: "http://127.0.0.1:3000",
      config: { mode: "unconfigured", previewOrigins: [] },
      width: 640,
      height: 480,
      fullPage: false,
    },
    settings: {
      version: 1,
      revision: 1,
      preset: "stable",
      config: {
        ...structuredClone(MAP_RENDER_PRESETS.stable),
        worker: { ...MAP_RENDER_PRESETS.stable.worker, memoryMb: 256, taskTimeoutMs: 2_000 },
      },
    },
  };
}

function daemonWorkerSource() {
  return [
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import readline from 'node:readline';",
    "for await (const line of readline.createInterface({ input: process.stdin })) {",
    "  const request = JSON.parse(line);",
    "  const input = JSON.parse(await fs.readFile(request.inputPath, 'utf8'));",
    "  await fs.mkdir(input.outputDirectory, { recursive: true });",
    "  if (input.spec?.delayMs) await new Promise((resolve) => setTimeout(resolve, input.spec.delayMs));",
    "  const content = 'ok';",
    "  const filename = input.kind === 'preview-capture' ? 'screenshot.png' : 'map.png';",
    "  await fs.writeFile(path.join(input.outputDirectory, filename), content);",
    "  const result = { summary: String(process.pid), files: [{ path: filename, size: 2, sha256: crypto.createHash('sha256').update(content).digest('hex'), mediaType: 'image/png' }] };",
    "  console.log(JSON.stringify({ id: request.id, ok: true, result }));",
    "}",
  ].join("\n");
}

async function waitFor(predicate, message = "condition") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
