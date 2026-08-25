import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMapAiPatchWorkerRunner } from "../lib/map-ai-patch-worker-runner.mjs";

const MAP = `${JSON.stringify({
  type: "map", version: "1.10", orientation: "orthogonal", width: 2, height: 1,
  tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 2, height: 1, data: [0, 0] }], tilesets: [],
}, null, 2)}\n`;

test("map AI patch worker keeps parse/preview/candidate generation outside the caller", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const target = path.join(project, "maps", "world.tmj");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, MAP);
  const version = crypto.createHash("sha256").update(MAP).digest("hex");
  const runner = createMapAiPatchWorkerRunner({ runtimeDirectory: path.join(root, "runtime") });
  const plan = {
    format: "wfl-tiled-patch", version: 1,
    base: { mapPath: "maps/world.tmj", mapVersion: version, editorStateId: 0 },
    summary: "hide ground", operations: [{ op: "update-layer", layerId: 1, changes: { visible: false } }],
  };
  const preview = await runner({ id: "task-preview", mode: "preview", projectPath: project, targetPath: target, mapPath: "maps/world.tmj", expectedVersion: version, maxReadBytes: 1024 * 1024, plan });
  assert.equal(preview.preview.operationCount, 1);
  assert.equal(runner.status().workerCount, 0);
  const applied = await runner({ id: "task-apply", mode: "apply", projectPath: project, targetPath: target, mapPath: "maps/world.tmj", expectedVersion: version, maxReadBytes: 1024 * 1024, plan });
  assert.equal(applied.candidate.size > 0, true);
  assert.equal(await fs.readFile(path.join(applied.taskDirectory, "output", "candidate.tmj"), "utf8").then((source) => JSON.parse(source).layers[0].visible), false);
  await applied.dispose();
  assert.equal(await fs.stat(applied.taskDirectory).catch((error) => error.code), "ENOENT");
  await runner.close();
});

test("map AI patch worker rejects protected layers and protected objects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-worker-protected-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); const target = path.join(project, "world.tmj");
  const source = `${JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [
    { id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] },
    { id: 2, name: "Spawn", type: "objectgroup", objects: [{ id: 7, name: "Spawn", type: "spawn", x: 0, y: 0, width: 16, height: 16 }] },
  ], tilesets: [] }, null, 2)}\n`;
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(target, source);
  const version = crypto.createHash("sha256").update(source).digest("hex");
  const runner = createMapAiPatchWorkerRunner({ runtimeDirectory: path.join(root, "runtime") });
  const base = { mapPath: "world.tmj", mapVersion: version, editorStateId: 0 };
  const layerPlan = { format: "wfl-tiled-patch", version: 1, base, summary: "edit protected", operations: [{ op: "update-layer", layerId: 1, changes: { name: "Bypass" } }] };
  await assert.rejects(runner({ id: "protected-layer", mode: "preview", projectPath: project, targetPath: target, mapPath: "world.tmj", expectedVersion: version, maxReadBytes: 1024 * 1024, plan: layerPlan, protectedTargets: [{ kind: "layer", mapPath: "world.tmj", layerId: 1 }] }), (error) => error.code === "MAP_AI_PROTECTED_OPERATION");
  const objectPlan = { ...layerPlan, operations: [{ op: "update-object", layerId: 2, objectId: 7, changes: { name: "Moved" } }] };
  await assert.rejects(runner({ id: "protected-object", mode: "preview", projectPath: project, targetPath: target, mapPath: "world.tmj", expectedVersion: version, maxReadBytes: 1024 * 1024, plan: objectPlan, protectedTargets: [{ kind: "object", mapPath: "world.tmj", layerId: 2, objectId: 7 }] }), (error) => error.code === "MAP_AI_PROTECTED_OPERATION");
  await runner.close();
});

test("map AI patch worker does not inherit main-site secrets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-worker-env-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); const target = path.join(project, "world.tmj");
  const observed = path.join(root, "env.json");
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(target, MAP);
  const worker = path.join(root, "worker.mjs");
  await fs.writeFile(worker, `import fs from "node:fs/promises"; await fs.writeFile(${JSON.stringify(observed)}, JSON.stringify({ api: process.env.OPENAI_API_KEY, token: process.env.SESSION_TOKEN, home: process.env.HOME })); process.stdout.write(JSON.stringify({ ok: true, result: { preview: { operationCount: 0, tileCellCount: 0, ordinaryObjectCount: 0, entries: [] } } }));`);
  const previousApi = process.env.OPENAI_API_KEY; const previousToken = process.env.SESSION_TOKEN;
  process.env.OPENAI_API_KEY = "secret"; process.env.SESSION_TOKEN = "token";
  try {
    const runner = createMapAiPatchWorkerRunner({ runtimeDirectory: path.join(root, "runtime"), workerPath: worker });
    const version = crypto.createHash("sha256").update(MAP).digest("hex");
    await runner({ id: "task-env", mode: "preview", projectPath: project, targetPath: target, mapPath: "world.tmj", expectedVersion: version, maxReadBytes: 1024 * 1024, plan: { format: "wfl-tiled-patch", version: 1, base: { mapPath: "world.tmj", mapVersion: version, editorStateId: 0 }, operations: [] } });
    const value = JSON.parse(await fs.readFile(observed, "utf8"));
    assert.equal(value.api, undefined); assert.equal(value.token, undefined); assert.match(value.home, /task-env-/u);
    await runner.close();
  } finally {
    if (previousApi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousApi;
    if (previousToken === undefined) delete process.env.SESSION_TOKEN; else process.env.SESSION_TOKEN = previousToken;
  }
});

test("map AI patch worker enforces the current map version and memory budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-worker-budget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); const target = path.join(project, "world.tmj");
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(target, MAP);
  const runner = createMapAiPatchWorkerRunner({ runtimeDirectory: path.join(root, "runtime"), processTreeMemory: async () => 1024 * 1024 * 1024, pollMs: 25 });
  const plan = { format: "wfl-tiled-patch", version: 1, base: { mapPath: "world.tmj", mapVersion: "0".repeat(64), editorStateId: 0 }, summary: "x", operations: [] };
  await assert.rejects(runner({ id: "task-budget", mode: "preview", projectPath: project, targetPath: target, mapPath: "world.tmj", expectedVersion: "0".repeat(64), maxReadBytes: 1024 * 1024, plan, memoryMb: 256 }), (error) => ["MAP_AI_WORKER_MEMORY_LIMIT", "MAP_AI_MAP_VERSION_CONFLICT"].includes(error.code));
  assert.deepEqual(await fs.readdir(path.join(root, "runtime")), []);
  await runner.close();
});

async function workerFixture(t, workerSource, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-worker-fault-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); const target = path.join(project, "world.tmj");
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(target, MAP);
  const worker = path.join(root, "worker.mjs"); await fs.writeFile(worker, workerSource);
  const version = crypto.createHash("sha256").update(MAP).digest("hex");
  const runner = createMapAiPatchWorkerRunner({ runtimeDirectory: path.join(root, "runtime"), workerPath: worker, ...options });
  const job = { id: "fault-task", mode: "preview", projectPath: project, targetPath: target, mapPath: "world.tmj", expectedVersion: version, maxReadBytes: 1024 * 1024, plan: { format: "wfl-tiled-patch", version: 1, base: { mapPath: "world.tmj", mapVersion: version, editorStateId: 0 }, operations: [] } };
  return { root, runner, job };
}

test("map AI patch worker times out and removes its private task directory", async (t) => {
  const f = await workerFixture(t, "setInterval(() => {}, 1_000);", { timeoutMs: 1_000 });
  await assert.rejects(f.runner({ ...f.job, timeoutMs: 1_000 }), (error) => error.code === "MAP_AI_WORKER_TIMEOUT");
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), []);
  await f.runner.close();
});

test("map AI patch worker rejects oversized stdout and cleans up", async (t) => {
  const f = await workerFixture(t, "process.stdout.write(JSON.stringify({ ok: true, result: { preview: { operationCount: 0, tileCellCount: 0, ordinaryObjectCount: 0, entries: [] } } }) + 'x'.repeat(3 * 1024 * 1024));", { timeoutMs: 5_000 });
  await assert.rejects(f.runner({ ...f.job, timeoutMs: 5_000 }), (error) => error.code === "MAP_AI_WORKER_OUTPUT_LIMIT");
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), []);
  await f.runner.close();
});

test("map AI patch worker rejects a tampered candidate and a symlink", async (t) => {
  const tampered = await workerFixture(t, `import fs from 'node:fs/promises'; const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8')); await fs.writeFile(input.outputDirectory + '/candidate.tmj', 'tampered'); process.stdout.write(JSON.stringify({ ok: true, result: { candidate: { path: 'candidate.tmj', size: 8, sha256: '0'.repeat(64) } } }));`);
  await assert.rejects(tampered.runner({ ...tampered.job, mode: "apply" }), (error) => error.code === "MAP_AI_WORKER_RESULT_INVALID");
  assert.deepEqual(await fs.readdir(path.join(tampered.root, "runtime")), []);
  await tampered.runner.close();
  const symlink = await workerFixture(t, `import fs from 'node:fs/promises'; const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8')); await fs.symlink(input.targetPath, input.outputDirectory + '/candidate.tmj'); process.stdout.write(JSON.stringify({ ok: true, result: { candidate: { path: 'candidate.tmj', size: 1, sha256: '0'.repeat(64) } } }));`);
  await assert.rejects(symlink.runner({ ...symlink.job, mode: "apply" }), (error) => error.code === "MAP_AI_WORKER_RESULT_INVALID");
  assert.deepEqual(await fs.readdir(path.join(symlink.root, "runtime")), []);
  await symlink.runner.close();
});

test("map AI patch worker aborts and removes its task tree", async (t) => {
  const f = await workerFixture(t, "await new Promise(() => {});", { timeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = f.runner({ ...f.job, timeoutMs: 5_000 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error.code === "ABORT_ERR");
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), []);
  await f.runner.close();
});
