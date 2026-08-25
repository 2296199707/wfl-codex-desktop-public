import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MapAiManagedTaskStore,
  MapAiManagedTaskError,
} from "../lib/map-ai-managed-task-store.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const IDENTITY = { userId: "u-1", browserSessionId: "browser-1" };

function authority(overrides = {}) {
  return {
    authorityMode: "managed",
    threadId: "thread-1",
    projectPath: "/srv/projects/wflgame",
    mapSessionId: "map-session-1",
    mapPath: "maps/world.tmj",
    baseVersion: HASH_A,
    targetFiles: ["maps/world.tmj"],
    allowedOps: ["set-tiles", "update-object"],
    protectedTargets: ["maps/collision.tmj"],
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function approval(policy = "ai_review") {
  return {
    version: 1,
    policy,
    source: "map_selection",
    riskRuleVersion: "map-risk-v1",
    userConfirmed: true,
  };
}

function createInput(overrides = {}) {
  return {
    identity: IDENTITY,
    authority: authority(),
    approvalSnapshot: approval(),
    settingsSnapshot: { worker: { concurrency: 1 } },
    clientOperationId: "operation-1",
    request: { operations: [{ op: "set-tiles", cells: [1, 2] }] },
    planSummary: { operationCount: 1, tileCellCount: 2, ordinaryObjectCount: 0 },
    ...overrides,
  };
}

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-task-"));
  const store = await new MapAiManagedTaskStore(directory, options).initialize();
  return { directory, store };
}

test("persists an immutable managed contract and idempotently reuses the same operation", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput());
  assert.equal(created.created, true);
  assert.equal(created.task.status, "queued");
  assert.equal(created.task.approvalPolicy, "ai_review");
  assert.equal(created.task.riskRuleVersion, "map-risk-v1");
  assert.equal(created.task.planAvailable, true);
  assert.deepEqual(created.task.targetFiles, ["maps/world.tmj"]);
  const again = await f.store.create(createInput());
  assert.equal(again.created, false);
  assert.equal(again.task.id, created.task.id);
  await assert.rejects(
    f.store.create(createInput({ request: { operations: [{ op: "remove-object", id: 4 }] } })),
    (error) => error instanceof MapAiManagedTaskError && error.code === "MAP_AI_TASK_OPERATION_CONFLICT",
  );
  await assert.rejects(
    f.store.create(createInput({ clientOperationId: "operation-private", request: { projectPath: "/srv/private" } })),
    (error) => error instanceof MapAiManagedTaskError && error.code === "MAP_AI_TASK_PLAN_INVALID",
  );
  await assert.rejects(
    Promise.resolve().then(() => f.store.snapshot({ taskId: created.task.id, identity: { userId: "u-2", browserSessionId: "browser-1" } })),
    (error) => error.code === "MAP_AI_TASK_NOT_FOUND",
  );
});

test("checkpoint commits advance only the recorded version and conflicts fail closed", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput());
  const started = await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-1", phase: "started",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "start",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  assert.equal(started.status, "running");
  const committed = await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-1", phase: "committed",
    baseVersion: HASH_A, targetVersion: HASH_B, operationCount: 1, summary: "saved",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  assert.equal(committed.currentVersion, HASH_B);
  assert.equal(committed.status, "queued");
  await assert.rejects(
    f.store.recordCheckpoint({
      identity: IDENTITY, taskId: created.task.id, batchId: "batch-2", phase: "started",
      baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "stale",
      risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
    }),
    (error) => error.code === "MAP_AI_TASK_VERSION_CONFLICT",
  );
  assert.equal(f.store.snapshot({ taskId: created.task.id, identity: IDENTITY }).status, "conflict");
});

test("pause is an after-current-batch boundary", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization") }));
  await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-pause", phase: "started",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "running",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  const requested = await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "pause" });
  assert.equal(requested.status, "running");
  assert.equal(requested.pauseRequested, true);
  const committed = await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-pause", phase: "committed",
    baseVersion: HASH_A, targetVersion: HASH_B, operationCount: 1, nextOperationIndex: 1, summary: "saved",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  assert.equal(committed.status, "paused");
  assert.equal(committed.currentVersion, HASH_B);
  assert.equal(committed.pauseRequested, true);
});

test("task diff endpoint returns the bounded structured impact receipt", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput());
  await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-diff", phase: "awaiting_approval",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "review",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
    diff: { version: "wfl-tiled-diff-v1", bounds: { x: 1, y: 2, width: 3, height: 4 }, heatmap: [{ layerId: 1, x: 1, y: 2 }], truncated: { heatmap: false } },
    validation: { stage: "candidate-preview" },
  });
  const receipt = f.store.diff({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(receipt.diff.version, "wfl-tiled-diff-v1");
  assert.deepEqual(receipt.diff.bounds, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(receipt.baseVersion, HASH_A);
});

test("restart interrupts active work and requires explicit confirmation before resume", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput());
  await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "pause" });
  await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume", confirmation: created.task.id });
  await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-running", phase: "started",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "running",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  const restarted = await new MapAiManagedTaskStore(f.directory).initialize();
  const interrupted = restarted.snapshot({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.error.code, "MAP_AI_TASK_RESTARTED_UNKNOWN_COMMIT");
  await assert.rejects(
    restarted.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume" }),
    (error) => error.code === "MAP_AI_TASK_RESTART_CONFIRMATION_REQUIRED",
  );
  const resumed = await restarted.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume", confirmation: created.task.id });
  assert.equal(resumed.status, "queued");
});

test("restart rejects a late checkpoint from the interrupted worker", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput());
  await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-interrupted-late", phase: "started",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "worker started",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });

  const restarted = await new MapAiManagedTaskStore(f.directory).initialize();
  const interrupted = restarted.snapshot({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(interrupted.status, "interrupted");

  await assert.rejects(
    restarted.recordCheckpoint({
      identity: IDENTITY, taskId: created.task.id, batchId: "batch-interrupted-late", phase: "committed",
      baseVersion: HASH_A, targetVersion: HASH_B, operationCount: 1, nextOperationIndex: 1,
      summary: "迟到提交不得写入", risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
    }),
    (error) => error.code === "MAP_AI_TASK_RESTART_CONFIRMATION_REQUIRED",
  );
  const unchanged = restarted.snapshot({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(unchanged.status, "interrupted");
  assert.equal(unchanged.currentVersion, HASH_A);
  assert.equal(unchanged.checkpoints.at(-1).phase, "started");
});

test("restart preserves a cancellation request as terminal", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization") }));
  await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-cancel-restart", phase: "started",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "running",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  const requested = await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "cancel" });
  assert.equal(requested.status, "cancel_requested");
  const restarted = await new MapAiManagedTaskStore(f.directory).initialize();
  const canceled = restarted.snapshot({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(canceled.status, "canceled");
  await assert.rejects(
    restarted.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume", confirmation: created.task.id }),
    (error) => error.code === "MAP_AI_TASK_NOT_RESUMABLE" || error.code === "MAP_AI_TASK_FINAL",
  );
});

test("takeover and cancel stop future batches without corrupting a committed one", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization") }));
  await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "takeover" });
  const taken = f.store.snapshot({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(taken.controlMode, "human");
  assert.equal(taken.status, "paused");
  const canceled = await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "cancel" });
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.checkpointSeq, 0);
});

test("authorization cancellation can target only the old Thread after transfer", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const oldTask = await f.store.create(createInput({
    clientOperationId: "transfer-old-task",
    authority: authority({ managedAuthorizationId: "auth-transfer", threadId: "thread-1" }),
  }));
  const newTask = await f.store.create(createInput({
    clientOperationId: "transfer-new-task",
    authority: authority({ managedAuthorizationId: "auth-transfer", threadId: "thread-2" }),
  }));
  const result = await f.store.cancelForAuthorization({
    authorizationId: "auth-transfer",
    threadId: "thread-1",
    reason: "handoff",
  });
  assert.equal(result.canceled, 1);
  assert.equal(f.store.snapshot({ taskId: oldTask.task.id, identity: IDENTITY }).status, "canceled");
  assert.equal(f.store.snapshot({ taskId: newTask.task.id, identity: IDENTITY }).status, "queued");
});

test("a late committed checkpoint after cancellation stays terminal and cannot be resumed", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization") }));
  await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-late", phase: "started",
    baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "已经进入原子批次",
    risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  const canceled = await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "cancel" });
  assert.equal(canceled.status, "cancel_requested");

  const late = await f.store.recordCheckpoint({
    identity: IDENTITY, taskId: created.task.id, batchId: "batch-late", phase: "committed",
    baseVersion: HASH_A, targetVersion: HASH_B, operationCount: 1, nextOperationIndex: 1,
    summary: "已经在撤销边界前原子提交", risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
  });
  assert.equal(late.status, "canceled");
  assert.equal(late.currentVersion, HASH_B);
  assert.equal(late.nextOperationIndex, 1);
  await assert.rejects(
    f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume" }),
    (error) => error.code === "MAP_AI_TASK_NOT_RESUMABLE" || error.code === "MAP_AI_TASK_FINAL",
  );
  await assert.rejects(
    f.store.recordCheckpoint({
      identity: IDENTITY, taskId: created.task.id, batchId: "batch-late-2", phase: "started",
      baseVersion: HASH_B, targetVersion: HASH_B, operationCount: 1, summary: "不得复活",
      risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] },
    }),
    (error) => error.code === "MAP_AI_TASK_FINAL",
  );
  const restored = await new MapAiManagedTaskStore(f.directory).initialize();
  const persisted = restored.snapshot({ taskId: created.task.id, identity: IDENTITY });
  assert.equal(persisted.status, "canceled");
  assert.equal(persisted.currentVersion, HASH_B);
  assert.equal(persisted.nextOperationIndex, 1);
});

test("late success or a new started checkpoint cannot override cancellation or takeover", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const canceled = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization"), clientOperationId: "late-success-cancel" }));
  await f.store.recordCheckpoint({ identity: IDENTITY, taskId: canceled.task.id, batchId: "batch-cancel-boundary", phase: "started", baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "started", risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] } });
  await f.store.transition({ identity: IDENTITY, taskId: canceled.task.id, action: "cancel" });
  const lateSuccess = await f.store.succeed({ identity: IDENTITY, taskId: canceled.task.id, summary: "late" });
  assert.equal(lateSuccess.status, "canceled");
  assert.equal(lateSuccess.error.code, "MAP_AI_TASK_CANCELLED");
  await assert.rejects(
    f.store.recordCheckpoint({ identity: IDENTITY, taskId: canceled.task.id, batchId: "batch-cancel-new", phase: "started", baseVersion: HASH_A, targetVersion: HASH_A, operationCount: 1, summary: "must not start", risk: { ruleVersion: "map-risk-v1", riskLevel: "low", reasonCodes: [], hardBlocks: [] } }),
    (error) => error.code === "MAP_AI_TASK_FINAL",
  );

  const taken = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization"), clientOperationId: "late-success-takeover" }));
  await f.store.transition({ identity: IDENTITY, taskId: taken.task.id, action: "takeover" });
  const takeoverSuccess = await f.store.succeed({ identity: IDENTITY, taskId: taken.task.id, summary: "late" });
  assert.equal(takeoverSuccess.status, "paused");
  assert.equal(takeoverSuccess.controlMode, "human");
});

test("event replay reports a bounded gap and terminal snapshot for reconnect recovery", async (t) => {
  const f = await fixture({ maxEvents: 8 }); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(createInput({ approvalSnapshot: approval("full_authorization") }));
  // Generate enough durable lifecycle events to evict the first event. Event
  // sequence numbers remain monotonic even though the in-memory tail is bounded.
  await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "pause" });
  await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume", confirmation: created.task.id });
  for (let index = 0; index < 6; index += 1) {
    await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "pause" }).catch(() => {});
    await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "resume", confirmation: created.task.id }).catch(() => {});
  }
  const current = f.store.snapshot({ taskId: created.task.id, identity: IDENTITY });
  await f.store.transition({ identity: IDENTITY, taskId: created.task.id, action: "cancel" });
  const replay = f.store.eventsSince({ taskId: created.task.id, identity: IDENTITY, after: 0, limit: 3 });
  assert.equal(replay.gap, true);
  assert.equal(replay.resyncRequired, true);
  assert.equal(replay.snapshotRequired, true);
  assert.equal(replay.hasMore, true);
  assert.equal(replay.events.length, 3);
  assert.equal(replay.nextAfter, replay.events.at(-1).seq);
  assert.equal(replay.snapshot.status, "canceled");
  assert.equal(replay.snapshot.id, current.id);
  const resumed = f.store.eventsSince({ taskId: created.task.id, identity: IDENTITY, after: replay.nextAfter, limit: 100 });
  assert.equal(resumed.events.some((event) => event.type === "canceled" || event.type === "cancel-requested"), true);
  assert.equal(resumed.latestEventSeq >= replay.nextAfter, true);
});
