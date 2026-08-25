import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapAiManagedAuthorizationStore } from "../lib/map-ai-managed-authorization-store.mjs";
import { MapAiManagedTaskStore } from "../lib/map-ai-managed-task-store.mjs";
import { MapAiManagedTaskExecutor } from "../lib/map-ai-managed-task-executor.mjs";
import { createMapAiPatchWorkerRunner } from "../lib/map-ai-patch-worker-runner.mjs";
import { MapSaveSessionStore } from "../lib/map-save-sessions.mjs";
import { MapRevisionStore } from "../lib/map-revision-store.mjs";
import { collaborationPolicySnapshot } from "../lib/map-collaboration-policy-store.mjs";
import { MapProjectResourceWriter } from "../lib/map-project-resource-write.mjs";
import { MapAiResourceCandidateStore } from "../lib/map-ai-resource-candidate-store.mjs";

const IDENTITY = { userId: "u-1", browserSessionId: "browser-1" };
const policy = { version: 1, policy: "full_authorization", source: "test", riskRuleVersion: "map-risk-v1", userConfirmed: true };
const hashBytes = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("managed executor validates a patch and commits through the chunked atomic save path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const mapRelative = "maps/world.tmj";
  const mapPath = path.join(project, mapRelative);
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  const initial = `${JSON.stringify({
    type: "map", version: "1.10", tiledversion: "1.10.2", orientation: "orthogonal",
    renderorder: "right-down", infinite: false, width: 1, height: 1, tilewidth: 16, tileheight: 16,
    nextlayerid: 2, nextobjectid: 1,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [],
  }, null, 2)}\n`;
  await fs.writeFile(mapPath, initial);
  const baseVersion = crypto.createHash("sha256").update(initial).digest("hex");
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-1", projectPath: project, mapPaths: [mapRelative], mapVersions: { [mapRelative]: baseVersion } },
    allowedOps: ["apply_tiled_patch"], protectedTargets: [], budget: {}, approvalSnapshot: policy,
    clientOperationId: "auth-1",
  });
  const patch = {
    format: "wfl-tiled-patch", version: 1,
    base: { mapPath: mapRelative, mapVersion: baseVersion, editorStateId: 0 },
    summary: "隐藏地面层", operations: [{ op: "update-layer", layerId: 1, changes: { visible: false } }],
  };
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: { authorityMode: "managed", managedAuthorizationId: authorization.authorization.id, threadId: "thread-1", projectPath: project, mapPath: mapRelative, baseVersion, targetFiles: [mapRelative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: authorization.authorization.expiresAt },
    approvalSnapshot: policy, settingsSnapshot: {}, clientOperationId: "task-1", request: patch,
    planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  const saveSessions = new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves"), chunkBytes: 32 });
  const patchWorker = createMapAiPatchWorkerRunner({ runtimeDirectory: path.join(root, "map-ai-workers") });
  t.after(() => patchWorker.close());
  const revisionStore = await new MapRevisionStore(path.join(root, "state"), { temporaryRoot: path.join(root, "revision-temp") }).initialize();
  const executor = new MapAiManagedTaskExecutor({ taskStore, authorizationStore: authStore, saveSessions, patchWorker, revisionStore });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const saved = JSON.parse(await fs.readFile(mapPath, "utf8"));
  assert.equal(saved.layers[0].visible, false);
  assert.notEqual(result.currentVersion, baseVersion);
  assert.equal(revisionStore.list({ projectPath: project, relativePath: mapRelative }).length, 1);
});

test("a Thread transfer race settles the old task as canceled", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-transfer-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const relative = "maps/world.tmj";
  const baseVersion = "a".repeat(64);
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-old", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: baseVersion } },
    allowedOps: ["apply_tiled_patch"],
    approvalSnapshot: policy,
    clientOperationId: "auth-transfer-race",
  });
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: { authorityMode: "managed", managedAuthorizationId: authorization.authorization.id, threadId: "thread-old", projectPath: project, mapPath: relative, baseVersion, targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: authorization.authorization.expiresAt },
    approvalSnapshot: policy,
    clientOperationId: "task-transfer-race",
    request: { format: "wfl-tiled-patch", version: 1, base: { mapPath: relative, mapVersion: baseVersion, editorStateId: 0 }, summary: "handoff", operations: [] },
    planSummary: { operationCount: 0, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  await authStore.transferThread({ authorizationId: authorization.authorization.id, identity: IDENTITY, targetThreadId: "thread-new" });
  const executor = new MapAiManagedTaskExecutor({
    taskStore,
    authorizationStore: authStore,
    saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }),
  });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "canceled");
  assert.equal(result.error.code, "MAP_AI_TASK_CANCELLED");
});

test("an in-flight task promise cannot be joined by another identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-identity-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game"); const relative = "world.tmj";
  await fs.mkdir(project, { recursive: true });
  const source = JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [] });
  const target = path.join(project, relative); await fs.writeFile(target, source);
  const hash = hashBytes(Buffer.from(source));
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const auth = await authStore.create({ identity: IDENTITY, scope: { authorityMode: "managed", threadId: "thread-identity", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: hash } }, allowedOps: ["apply_tiled_patch"], approvalSnapshot: policy, clientOperationId: "auth-identity" });
  const task = await taskStore.create({ identity: IDENTITY, authority: { authorityMode: "managed", managedAuthorizationId: auth.authorization.id, threadId: "thread-identity", projectPath: project, mapPath: relative, baseVersion: hash, targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: auth.authorization.expiresAt }, approvalSnapshot: policy, clientOperationId: "task-identity", request: { format: "wfl-tiled-patch", version: 1, base: { mapPath: relative, mapVersion: hash, editorStateId: 0 }, summary: "identity", operations: [{ op: "update-layer", layerId: 1, changes: { visible: false } }] }, planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = new MapAiManagedTaskExecutor({ taskStore, authorizationStore: authStore, saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }), authorize: async () => gate });
  const first = executor.execute({ taskId: task.task.id, identity: IDENTITY });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    executor.execute({ taskId: task.task.id, identity: { userId: "u-2", browserSessionId: "browser-2" } }),
    (error) => error.code === "MAP_AI_TASK_NOT_FOUND",
  );
  release();
  const result = await first;
  assert.equal(result.status, "succeeded", JSON.stringify(result));
});

test("managed executor stops at the fixed approval gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-approval-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game"); const relative = "world.tmj"; const target = path.join(project, relative);
  await fs.mkdir(project, { recursive: true });
  const initial = JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [] });
  await fs.writeFile(target, initial); const hash = crypto.createHash("sha256").update(initial).digest("hex");
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const auth = await authStore.create({ identity: IDENTITY, scope: { authorityMode: "managed", threadId: "thread-1", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: hash } }, allowedOps: ["apply_tiled_patch"], approvalSnapshot: { ...policy, policy: "ai_review" }, clientOperationId: "auth-1" });
  const task = await taskStore.create({ identity: IDENTITY, authority: { authorityMode: "managed", managedAuthorizationId: auth.authorization.id, threadId: "thread-1", projectPath: project, mapPath: relative, baseVersion: hash, targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: auth.authorization.expiresAt }, approvalSnapshot: { ...policy, policy: "ai_review" }, clientOperationId: "task-1", request: { format: "wfl-tiled-patch", version: 1, base: { mapPath: relative, mapVersion: hash, editorStateId: 0 }, summary: "rename", operations: [{ op: "update-layer", layerId: 1, changes: { name: "Changed" } }] }, planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 } });
  const executor = new MapAiManagedTaskExecutor({ taskStore, authorizationStore: authStore, saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }) });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(JSON.parse(await fs.readFile(target, "utf8")).layers[0].name, "Ground");
});

test("live authorization allows a running batch to finish after an after-current-batch pause", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-pause-live-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const relative = "world.tmj";
  await fs.mkdir(project, { recursive: true });
  const source = JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [] });
  const target = path.join(project, relative);
  await fs.writeFile(target, source);
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const auth = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-pause", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: hash } },
    allowedOps: ["apply_tiled_patch"], protectedTargets: [], budget: {}, approvalSnapshot: policy, clientOperationId: "auth-pause-live",
  });
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: { authorityMode: "managed", managedAuthorizationId: auth.authorization.id, threadId: "thread-pause", projectPath: project, mapPath: relative, baseVersion: hash, targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: auth.authorization.expiresAt },
    approvalSnapshot: policy, settingsSnapshot: {}, clientOperationId: "task-pause-live",
    request: { format: "wfl-tiled-patch", version: 1, base: { mapPath: relative, mapVersion: hash, editorStateId: 0 }, summary: "pause", operations: [{ op: "update-layer", layerId: 1, changes: { visible: false } }] },
    planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  await taskStore.recordCheckpoint({
    identity: IDENTITY, taskId: task.task.id, batchId: "batch-live", phase: "started", baseVersion: hash, targetVersion: hash,
    operationCount: 1, summary: "running", risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  await taskStore.transition({ identity: IDENTITY, taskId: task.task.id, action: "pause" });
  const executor = new MapAiManagedTaskExecutor({ taskStore, authorizationStore: authStore, saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }) });
  await assert.doesNotReject(() => executor.authorizeLive({
    taskId: task.task.id,
    identity: IDENTITY,
    authority: authStore.taskContract({ authorizationId: auth.authorization.id, identity: IDENTITY }),
    context: { targetPath: target },
  }));
});

test("ask_each advances one committed operation at a time", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-each-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game"); const relative = "world.tmj"; const target = path.join(project, relative);
  await fs.mkdir(project, { recursive: true });
  const initial = JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [] });
  await fs.writeFile(target, initial); const hash = crypto.createHash("sha256").update(initial).digest("hex");
  const eachPolicy = { ...policy, policy: "ask_each" };
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const auth = await authStore.create({ identity: IDENTITY, scope: { authorityMode: "managed", threadId: "thread-1", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: hash } }, allowedOps: ["apply_tiled_patch"], approvalSnapshot: eachPolicy, clientOperationId: "auth-each" });
  const patch = { format: "wfl-tiled-patch", version: 1, base: { mapPath: relative, mapVersion: hash, editorStateId: 0 }, summary: "two changes", operations: [
    { op: "update-layer", layerId: 1, changes: { visible: false } },
    { op: "update-layer", layerId: 1, changes: { opacity: 0.5 } },
  ] };
  const task = await taskStore.create({ identity: IDENTITY, authority: { authorityMode: "managed", managedAuthorizationId: auth.authorization.id, threadId: "thread-1", projectPath: project, mapPath: relative, baseVersion: hash, targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: auth.authorization.expiresAt }, approvalSnapshot: eachPolicy, clientOperationId: "task-each", request: patch, planSummary: { operationCount: 2, tileCellCount: 0, ordinaryObjectCount: 0 } });
  const executor = new MapAiManagedTaskExecutor({ taskStore, authorizationStore: authStore, saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves"), chunkBytes: 32 }) });
  let current = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(current.status, "awaiting_approval"); assert.equal(current.nextOperationIndex, 0);
  await taskStore.transition({ identity: IDENTITY, taskId: task.task.id, action: "approve", approvalId: "op-0" });
  current = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(current.status, "queued"); assert.equal(current.nextOperationIndex, 1);
  assert.equal(JSON.parse(await fs.readFile(target, "utf8")).layers[0].visible, false);
  current = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(current.status, "awaiting_approval");
  await taskStore.transition({ identity: IDENTITY, taskId: task.task.id, action: "approve", approvalId: "op-1" });
  current = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  if (current.status === "running") {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = taskStore.snapshot({ taskId: task.task.id, identity: IDENTITY });
      if (["succeeded", "failed", "conflict"].includes(current.status)) break;
    }
  }
  assert.equal(current.status, "succeeded", JSON.stringify(current));
  const saved = JSON.parse(await fs.readFile(target, "utf8"));
  assert.equal(saved.layers[0].opacity, 0.5);
});

test("managed executor stores a bounded checkpoint receipt for a large patch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-bounded-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game"); const relative = "world.tmj"; const target = path.join(project, relative);
  await fs.mkdir(project, { recursive: true });
  const initial = JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 200, height: 200, tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 200, height: 200, data: Array(40_000).fill(0) }], tilesets: [] });
  await fs.writeFile(target, initial); const hash = crypto.createHash("sha256").update(initial).digest("hex");
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const boundedPolicy = { ...policy, policy: "full_authorization" };
  const auth = await authStore.create({ identity: IDENTITY, scope: { authorityMode: "managed", threadId: "thread-1", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: hash } }, allowedOps: ["apply_tiled_patch"], approvalSnapshot: boundedPolicy, clientOperationId: "auth-bounded" });
  const operations = Array.from({ length: 100 }, (_, operationIndex) => ({
    op: "set-tiles", layerId: 1,
    cells: [{ x: operationIndex % 200, y: Math.floor(operationIndex / 200), gid: 0 }],
  }));
  const task = await taskStore.create({ identity: IDENTITY, authority: { authorityMode: "managed", managedAuthorizationId: auth.authorization.id, threadId: "thread-1", projectPath: project, mapPath: relative, baseVersion: hash, targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: auth.authorization.expiresAt }, approvalSnapshot: boundedPolicy, clientOperationId: "task-bounded", request: { format: "wfl-tiled-patch", version: 1, base: { mapPath: relative, mapVersion: hash, editorStateId: 0 }, summary: "large tile patch", operations }, planSummary: { operationCount: operations.length, tileCellCount: operations.length, ordinaryObjectCount: 0 } });
  const executor = new MapAiManagedTaskExecutor({ taskStore, authorizationStore: authStore, saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }) });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.ok(JSON.stringify(result.checkpoints).length < 64 * 1024);
  assert.equal(result.checkpoints.at(-1).diff.truncated, true);
  assert.equal(result.checkpoints.at(-1).diff.impact.version, "wfl-tiled-diff-v1");
});

test("managed executor rechecks policy targets when an older authorization lacks expanded protected targets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-executor-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const relative = "world.tmj";
  const target = path.join(project, relative);
  await fs.mkdir(project, { recursive: true });
  const initial = JSON.stringify({
    type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
    tilewidth: 16, tileheight: 16,
    layers: [{ id: 1, name: "Human", type: "tilelayer", width: 1, height: 1, data: [0] }],
    tilesets: [],
  });
  await fs.writeFile(target, initial);
  const hash = crypto.createHash("sha256").update(initial).digest("hex");
  const collaborationPolicy = collaborationPolicySnapshot({
    projectPath: project,
    mapPath: relative,
    revision: 4,
    targets: [{ kind: "layer", mapPath: relative, layerId: 1, ownership: "human" }],
  });
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-1", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: hash } },
    allowedOps: ["apply_tiled_patch"],
    // Simulate a persisted pre-expansion authorization: the executor must use
    // collaborationPolicy itself, not only the derived protectedTargets list.
    protectedTargets: [],
    collaborationPolicy,
    budget: {},
    approvalSnapshot: policy,
    clientOperationId: "auth-policy-legacy",
  });
  const patch = {
    format: "wfl-tiled-patch", version: 1,
    base: { mapPath: relative, mapVersion: hash, editorStateId: 0 },
    summary: "touch human layer",
    operations: [{ op: "update-layer", layerId: 1, changes: { visible: false } }],
  };
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: {
      authorityMode: "managed", managedAuthorizationId: authorization.authorization.id,
      threadId: "thread-1", projectPath: project, mapPath: relative, baseVersion: hash,
      targetFiles: [relative], allowedOps: ["apply_tiled_patch"], protectedTargets: [],
      collaborationPolicy, expiresAt: authorization.authorization.expiresAt,
    },
    approvalSnapshot: policy, settingsSnapshot: {}, clientOperationId: "task-policy-legacy",
    request: patch, planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  const executor = new MapAiManagedTaskExecutor({
    taskStore,
    authorizationStore: authStore,
    saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }),
  });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "failed");
  assert.ok(["MAP_COLLABORATION_HUMAN_OWNED", "MAP_AI_PROTECTED_OPERATION"].includes(result.error.code));
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), JSON.parse(initial));
});

test("managed revision restore cannot replace a protected human layer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-restore-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const relative = "world.tmj";
  const target = path.join(project, relative);
  await fs.mkdir(project, { recursive: true });
  const document = (visible) => JSON.stringify({
    type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
    tilewidth: 16, tileheight: 16,
    layers: [{ id: 1, name: "Human", type: "tilelayer", width: 1, height: 1, visible, data: [0] }],
    tilesets: [],
  });
  const historical = Buffer.from(document(true));
  await fs.writeFile(target, historical);
  const historicalVersion = crypto.createHash("sha256").update(historical).digest("hex");
  const revisionStore = await new MapRevisionStore(path.join(root, "state"), { temporaryRoot: path.join(root, "revision-temp") }).initialize();
  const staged = await revisionStore.stageCurrent({ projectPath: project, relativePath: relative, targetPath: target, expectedVersion: historicalVersion });
  const revision = await revisionStore.commitStaged(staged);
  const current = Buffer.from(document(false));
  await fs.writeFile(target, current);
  const currentVersion = crypto.createHash("sha256").update(current).digest("hex");
  const collaborationPolicy = collaborationPolicySnapshot({
    projectPath: project,
    mapPath: relative,
    revision: 1,
    targets: [{ kind: "layer", mapPath: relative, layerId: 1, ownership: "human" }],
  });
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-restore", projectPath: project, mapPaths: [relative], mapVersions: { [relative]: currentVersion } },
    allowedOps: ["restore_map_revision"],
    protectedTargets: [],
    collaborationPolicy,
    approvalSnapshot: policy,
    clientOperationId: "auth-restore-policy",
  });
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: {
      authorityMode: "managed", managedAuthorizationId: authorization.authorization.id,
      threadId: "thread-restore", projectPath: project, mapPath: relative, baseVersion: currentVersion,
      targetFiles: [relative], allowedOps: ["restore_map_revision"], protectedTargets: [],
      collaborationPolicy, expiresAt: authorization.authorization.expiresAt,
    },
    approvalSnapshot: policy,
    settingsSnapshot: { restoreRevisionId: revision.id },
    clientOperationId: "task-restore-policy",
    request: { format: "wfl-map-revision-restore", version: 1, revisionId: revision.id },
    planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  const executor = new MapAiManagedTaskExecutor({
    taskStore,
    authorizationStore: authStore,
    saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }),
    projectResourceWriter: new MapProjectResourceWriter({ candidateRoots: [path.join(root, "saves")] }),
    revisionStore,
  });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MAP_AI_PROTECTED_TARGET_CHANGED");
  assert.deepEqual(await fs.readFile(target), current);
});

test("managed executor publishes an explicit multi-map plan as one atomic transaction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-multi-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  await fs.mkdir(path.join(project, "maps"), { recursive: true });
  const makeMap = (name) => JSON.stringify({
    type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
    tilewidth: 16, tileheight: 16, layers: [{ id: 1, name, type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [],
  });
  const paths = ["maps/a.tmj", "maps/b.tmj"];
  const sources = [makeMap("A"), makeMap("B")];
  await Promise.all(paths.map((relative, index) => fs.writeFile(path.join(project, relative), sources[index])));
  const versions = Object.fromEntries(paths.map((relative, index) => [relative, crypto.createHash("sha256").update(sources[index]).digest("hex")]));
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-multi", projectPath: project, mapPaths: paths, mapVersions: versions },
    allowedOps: ["apply_tiled_patch"], approvalSnapshot: policy, clientOperationId: "auth-multi",
  });
  const maps = paths.map((mapPath, index) => ({
    mapPath,
    patch: {
      format: "wfl-tiled-patch", version: 1,
      base: { mapPath, mapVersion: versions[mapPath], editorStateId: 0 },
      summary: `rename-${index}`,
      operations: [{ op: "update-layer", layerId: 1, changes: { name: `Changed ${index}` } }],
    },
  }));
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: { authorityMode: "managed", managedAuthorizationId: authorization.authorization.id, threadId: "thread-multi", projectPath: project, mapPath: paths[0], baseVersion: versions[paths[0]], mapPaths: paths, mapVersions: versions, targetFiles: paths, targetFileVersions: versions, allowedOps: ["apply_tiled_patch"], protectedTargets: [], expiresAt: authorization.authorization.expiresAt },
    approvalSnapshot: policy, settingsSnapshot: {}, clientOperationId: "task-multi", request: { format: "wfl-multi-map-patch", version: 1, summary: "rename both maps", maps }, planSummary: { operationCount: 2, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  const saves = new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves"), chunkBytes: 32 });
  const executor = new MapAiManagedTaskExecutor({
    taskStore, authorizationStore: authStore, saveSessions: saves,
    projectResourceWriter: new MapProjectResourceWriter({ candidateRoots: [path.join(root, "saves")] }),
  });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(JSON.parse(await fs.readFile(path.join(project, paths[0]), "utf8")).layers[0].name, "Changed 0");
  assert.equal(JSON.parse(await fs.readFile(path.join(project, paths[1]), "utf8")).layers[0].name, "Changed 1");
  assert.equal(result.currentVersions[paths[0]], hashBytes(await fs.readFile(path.join(project, paths[0]))));
  assert.equal(result.currentVersions[paths[1]], hashBytes(await fs.readFile(path.join(project, paths[1]))));
});

test("managed executor publishes Tiled resource candidates as one atomic transaction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-resource-executor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const mapRelative = "maps/world.tmj";
  const templateRelative = "templates/tree.tx";
  const mapPath = path.join(project, mapRelative);
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.mkdir(path.join(project, "templates"), { recursive: true });
  const map = JSON.stringify({ type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1, tilewidth: 16, tileheight: 16, layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [0] }], tilesets: [] });
  await fs.writeFile(mapPath, map);
  const mapVersion = hashBytes(Buffer.from(map));
  const candidateRoot = path.join(root, "candidate-source");
  await fs.mkdir(candidateRoot, { recursive: true });
  const candidateMapPath = path.join(candidateRoot, "world.tmj");
  const candidateTemplatePath = path.join(candidateRoot, "tree.tx");
  const templateSource = JSON.stringify({ type: "template", object: { id: 1, name: "Tree", width: 16, height: 16 } });
  await fs.writeFile(candidateMapPath, map);
  await fs.writeFile(candidateTemplatePath, templateSource);
  const candidateStore = await new MapAiResourceCandidateStore({ temporaryRoot: path.join(root, "resource-candidates"), sourceRoots: [candidateRoot] }).initialize();
  const mapCandidate = await candidateStore.register({ userId: IDENTITY.userId, projectPath: project, threadId: "thread-resource", relativePath: mapRelative, baseVersion: mapVersion, sourcePath: candidateMapPath });
  const templateCandidate = await candidateStore.register({ userId: IDENTITY.userId, projectPath: project, threadId: "thread-resource", relativePath: templateRelative, baseVersion: null, sourcePath: candidateTemplatePath });
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", threadId: "thread-resource", projectPath: project, mapPaths: [mapRelative], mapVersions: { [mapRelative]: mapVersion }, targetFiles: [mapRelative, templateRelative], targetFileVersions: { [mapRelative]: mapVersion, [templateRelative]: null } },
    allowedOps: ["apply_tiled_resource_patch"], approvalSnapshot: policy, clientOperationId: "auth-resource",
  });
  const request = { format: "wfl-tiled-resource-patch", version: 1, summary: "publish map resources", files: [
    { path: mapRelative, baseVersion: mapVersion, candidateId: mapCandidate.candidateId },
    { path: templateRelative, baseVersion: null, candidateId: templateCandidate.candidateId },
  ] };
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: { authorityMode: "managed", managedAuthorizationId: authorization.authorization.id, threadId: "thread-resource", projectPath: project, mapPath: mapRelative, baseVersion: mapVersion, mapPaths: [mapRelative], mapVersions: { [mapRelative]: mapVersion }, targetFiles: [mapRelative, templateRelative], targetFileVersions: { [mapRelative]: mapVersion, [templateRelative]: null }, allowedOps: ["apply_tiled_resource_patch"], protectedTargets: [], expiresAt: authorization.authorization.expiresAt },
    approvalSnapshot: policy, settingsSnapshot: {}, clientOperationId: "task-resource", request,
    planSummary: { operationCount: 2, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  const executor = new MapAiManagedTaskExecutor({
    taskStore, authorizationStore: authStore,
    saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }),
    projectResourceWriter: new MapProjectResourceWriter({ candidateRoots: [path.join(root, "resource-candidates")] }),
    resourceCandidateStore: candidateStore,
  });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(project, templateRelative), "utf8"), templateSource);
  assert.equal(hashBytes(await fs.readFile(mapPath)), mapVersion);
});

test("project-wide resource tasks can publish a new resource without a primary map", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-project-resource-executor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "game");
  const relativePath = "templates/tree.tx";
  await fs.mkdir(path.join(project, "templates"), { recursive: true });
  const candidateRoot = path.join(root, "candidate-source");
  await fs.mkdir(candidateRoot, { recursive: true });
  const candidatePath = path.join(candidateRoot, "tree.tx");
  const source = JSON.stringify({ type: "template", object: { id: 1, name: "Tree", width: 16, height: 16 } });
  await fs.writeFile(candidatePath, source);
  const candidateStore = await new MapAiResourceCandidateStore({
    temporaryRoot: path.join(root, "resource-candidates"),
    sourceRoots: [candidateRoot],
  }).initialize();
  const candidate = await candidateStore.register({
    userId: IDENTITY.userId,
    projectPath: project,
    threadId: "upload-thread",
    relativePath,
    baseVersion: null,
    sourcePath: candidatePath,
  });
  const candidateVersion = candidate.sha256;
  const authStore = await new MapAiManagedAuthorizationStore(path.join(root, "state")).initialize();
  const taskStore = await new MapAiManagedTaskStore(path.join(root, "state")).initialize();
  const authorization = await authStore.create({
    identity: IDENTITY,
    scope: { authorityMode: "managed", scopeKind: "project", projectWide: true, projectPath: project },
    allowedOps: ["apply_project_patch"],
    approvalSnapshot: policy,
    clientOperationId: "auth-project-resource-only",
  });
  const request = {
    format: "wfl-tiled-resource-patch",
    version: 1,
    summary: "publish a project template",
    files: [{ path: relativePath, baseVersion: null, candidateId: candidate.candidateId }],
  };
  const task = await taskStore.create({
    identity: IDENTITY,
    authority: {
      authorityMode: "managed",
      scopeKind: "project",
      projectWide: true,
      managedAuthorizationId: authorization.authorization.id,
      projectPath: project,
      mapPath: relativePath,
      baseVersion: candidateVersion,
      mapPaths: [relativePath],
      mapVersions: { [relativePath]: candidateVersion },
      targetFiles: [relativePath],
      targetFileVersions: { [relativePath]: null },
      allowedOps: ["apply_project_patch"],
      protectedTargets: [],
      expiresAt: authorization.authorization.expiresAt,
    },
    approvalSnapshot: policy,
    settingsSnapshot: {},
    clientOperationId: "task-project-resource-only",
    request,
    planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
  });
  const executor = new MapAiManagedTaskExecutor({
    taskStore,
    authorizationStore: authStore,
    saveSessions: new MapSaveSessionStore({ temporaryRoot: path.join(root, "saves") }),
    projectResourceWriter: new MapProjectResourceWriter({ candidateRoots: [path.join(root, "resource-candidates")] }),
    resourceCandidateStore: candidateStore,
  });
  const result = await executor.execute({ taskId: task.task.id, identity: IDENTITY });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(project, relativePath), "utf8"), source);
  assert.equal(result.currentVersions[relativePath], candidateVersion);
});
