import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexBackgroundTaskStore,
  nextCodexBackgroundRunAt,
  normalizeCodexBackgroundSchedule,
} from "../lib/codex-background-tasks.mjs";

test("persists private account-scoped Codex background tasks and completes native runs", async (t) => {
  const fixture = await createFixture(t);
  let now = Date.UTC(2026, 6, 29, 8, 0, 0);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  const created = await store.create({
    name: "Quota report",
    prompt: "Report quota using token=secret-value without changing files.",
    projectPath: fixture.project,
    model: "gpt-test",
    effort: "high",
    schedule: { kind: "interval", intervalMs: 10 * 60_000, startAt: now + 10 * 60_000 },
    runNow: true,
  });
  assert.equal(created.status, "queued");
  assert.equal(created.nextRunAt, now);
  assert.equal(created.prompt, undefined);
  assert.doesNotMatch(created.promptPreview, /secret-value/);
  assert.equal(store.due(now).length, 1);

  const starting = await store.markStarting(created.id);
  assert.equal(starting.status, "starting");
  const running = await store.markRunning(created.id, {
    threadId: "thread_background_1",
    turnId: "turn_background_1",
  });
  assert.equal(running.status, "running");
  now += 5_000;
  const completed = await store.complete(created.id);
  assert.equal(completed.status, "queued");
  assert.equal(completed.runs[0].status, "completed");
  assert.equal(completed.runs[0].threadId, "thread_background_1");
  assert.equal(completed.nextRunAt, Date.UTC(2026, 6, 29, 8, 10, 0));

  const stat = await fs.stat(path.join(fixture.state, "codex-background-tasks.json"));
  assert.equal(stat.mode & 0o077, 0);
  const reloaded = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  assert.equal(reloaded.get(created.id, { includePrompt: true }).prompt.includes("Quota report"), false);
  assert.match(reloaded.get(created.id, { includePrompt: true }).prompt, /Report quota/);
  await assert.rejects(
    () => reloaded.create({
      prompt: "escape",
      projectPath: path.join(fixture.root, "outside"),
    }),
    /不属于当前账号/,
  );
});

test("supports once, interval, daily, weekly, and bounded RFC 5545 schedules", () => {
  const now = Date.UTC(2026, 6, 29, 8, 5, 30);
  const once = normalizeCodexBackgroundSchedule({
    kind: "once",
    at: Date.UTC(2026, 6, 29, 9, 0, 0),
  }, now);
  assert.equal(once.nextRunAt, Date.UTC(2026, 6, 29, 9, 0, 0));

  const interval = normalizeCodexBackgroundSchedule({
    kind: "interval",
    intervalMs: 5 * 60_000,
    startAt: Date.UTC(2026, 6, 29, 8, 10, 0),
  }, now);
  assert.equal(nextCodexBackgroundRunAt(interval, Date.UTC(2026, 6, 29, 8, 12, 0)), Date.UTC(2026, 6, 29, 8, 15, 0));

  const daily = normalizeCodexBackgroundSchedule({ kind: "daily", time: "08:00" }, now);
  assert.equal(daily.nextRunAt, Date.UTC(2026, 6, 30, 8, 0, 0));

  const weekly = normalizeCodexBackgroundSchedule({
    kind: "weekly",
    weekdays: [3, 5],
    time: "09:30",
  }, now);
  assert.equal(weekly.nextRunAt, Date.UTC(2026, 6, 29, 9, 30, 0));

  const rrule = normalizeCodexBackgroundSchedule({
    kind: "rrule",
    rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=15;COUNT=2",
    startAt: Date.UTC(2026, 6, 29, 8, 0, 0),
  }, now);
  assert.equal(rrule.nextRunAt, Date.UTC(2026, 6, 29, 9, 15, 0));
  assert.equal(
    nextCodexBackgroundRunAt(rrule, Date.UTC(2026, 6, 29, 9, 15, 0)),
    Date.UTC(2026, 6, 30, 9, 15, 0),
  );
  assert.equal(
    nextCodexBackgroundRunAt(rrule, Date.UTC(2026, 6, 30, 9, 15, 0)),
    null,
  );
  assert.throws(
    () => normalizeCodexBackgroundSchedule({ kind: "rrule", rrule: "FREQ=SECONDLY" }, now),
    /仅支持/,
  );
  assert.throws(
    () => normalizeCodexBackgroundSchedule({ kind: "interval", intervalMs: 1_000 }, now),
    /数值超出允许范围/,
  );
});

test("recovers interrupted runs, retries with bounded backoff, and keeps pause explicit", async (t) => {
  const fixture = await createFixture(t);
  let now = Date.UTC(2026, 6, 29, 12, 0, 0);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  const task = await store.create({
    prompt: "Run the background check",
    projectPath: fixture.project,
    maxAttempts: 2,
    retryBackoff: "fast",
  });
  await store.markStarting(task.id);
  await store.markRunning(task.id, {
    threadId: "thread_restart_test",
    turnId: "turn_restart_test",
  });

  now += 30_000;
  const recovered = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  assert.equal(recovered.get(task.id).status, "queued");
  assert.equal(recovered.get(task.id).runs[0].status, "interrupted");
  assert.equal(recovered.due(now).length, 1);

  await recovered.markStarting(task.id);
  await recovered.fail(task.id, new Error("API key=top-secret disconnected"));
  const retrying = recovered.get(task.id);
  assert.equal(retrying.status, "failed");
  assert.doesNotMatch(retrying.lastError, /top-secret/);

  await recovered.retry(task.id);
  assert.equal(recovered.get(task.id).status, "queued");
  await recovered.pause(task.id);
  assert.equal(recovered.get(task.id).status, "paused");
  assert.equal(recovered.nextWakeAt(), null);
  await recovered.resume(task.id);
  assert.equal(recovered.get(task.id).status, "queued");
  await recovered.requestCancel(task.id);
  assert.equal(recovered.get(task.id).status, "cancelled");
});

test("durable submissions preserve one run and its resources until delivery is reconciled", async (t) => {
  const fixture = await createFixture(t);
  let now = Date.UTC(2026, 6, 29, 12, 30, 0);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    durableSubmissions: true,
    now: () => now,
  }).initialize();
  const task = await store.create({
    prompt: "Do not replay this background side effect",
    projectPath: fixture.project,
  });
  const starting = await store.markStarting(task.id);
  const runId = starting.currentRunId;
  await store.markRunResources(task.id, {
    threadId: "thread_durable_background",
    worktreeId: "wt_durable_background",
    deliveryStage: "turn",
  });
  await store.markDeliveryUnknown(task.id, {
    stage: "turn",
    threadId: "thread_durable_background",
    error: new Error("turn/start response disconnected"),
  });

  const uncertain = store.get(task.id, { includeHistory: true });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.deliveryStage, "turn");
  assert.equal(uncertain.currentRunId, runId);
  assert.equal(uncertain.currentThreadId, "thread_durable_background");
  assert.equal(uncertain.currentWorktreeId, "wt_durable_background");
  assert.equal(uncertain.runs[0].status, "uncertain");
  assert.equal(store.due(now).length, 0);
  assert.equal(store.unresolved().length, 1);

  now += 30_000;
  const reloaded = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    durableSubmissions: true,
    now: () => now,
  }).initialize();
  const recovered = reloaded.get(task.id, { includeHistory: true });
  assert.equal(recovered.status, "uncertain");
  assert.equal(recovered.currentRunId, runId);
  assert.equal(recovered.currentThreadId, "thread_durable_background");
  assert.equal(recovered.currentWorktreeId, "wt_durable_background");
  assert.equal(recovered.runs.length, 1);
  assert.equal(recovered.runs[0].completedAt, null);

  await reloaded.markRunning(task.id, {
    threadId: "thread_durable_background",
    turnId: "turn_durable_background",
    worktreeId: "wt_durable_background",
  });
  assert.equal(reloaded.get(task.id).status, "running");
  await reloaded.complete(task.id);
  const completed = reloaded.get(task.id, { includeHistory: true });
  assert.equal(completed.status, "completed");
  assert.equal(completed.runs.length, 1);
  assert.equal(completed.runs[0].turnId, "turn_durable_background");
});

test("a cancellation waits for an uncertain Turn to reconcile before settling", async (t) => {
  const fixture = await createFixture(t);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    durableSubmissions: true,
  }).initialize();
  const task = await store.create({
    prompt: "Reconcile before interrupting this run",
    projectPath: fixture.project,
  });
  const starting = await store.markStarting(task.id);
  await store.markRunResources(task.id, {
    threadId: "thread_cancel_uncertain",
    deliveryStage: "turn",
  });
  await store.markDeliveryUnknown(task.id, {
    stage: "turn",
    threadId: "thread_cancel_uncertain",
  });
  const cancelling = await store.requestCancel(task.id);
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.currentRunId, starting.currentRunId);
  assert.equal(store.unresolved().length, 1);

  const reconciled = await store.markRunning(task.id, {
    threadId: "thread_cancel_uncertain",
    turnId: "turn_cancel_uncertain",
  });
  assert.equal(reconciled.status, "cancelling");
  assert.equal(reconciled.cancelRequested, true);
  const completed = await store.complete(task.id);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.runs[0].status, "cancelled");
});

test("infinite retry remains bounded by exponential backoff and can be switched off", async (t) => {
  const fixture = await createFixture(t);
  let now = Date.UTC(2026, 6, 29, 13, 0, 0);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  const task = await store.create({
    prompt: "Retry after temporary API or account disconnects",
    projectPath: fixture.project,
    maxAttempts: 1,
    infiniteRetry: true,
    retryBackoff: "fast",
  });

  let previousDelay = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await store.markStarting(task.id);
    await store.fail(task.id, new Error("API connection temporarily unavailable"), { retryable: true });
    const retrying = store.get(task.id);
    const delay = retrying.nextRunAt - now;
    assert.equal(retrying.status, "queued");
    assert.equal(retrying.infiniteRetry, true);
    assert.ok(delay >= 1_000 && delay <= 5 * 60_000);
    assert.ok(delay >= Math.min(previousDelay, Math.floor(5 * 60_000 * 0.85)));
    previousDelay = delay;
    now = retrying.nextRunAt;
  }

  await store.updateRetry(task.id, {
    infiniteRetry: false,
    maxAttempts: 1,
    retryBackoff: "patient",
  });
  await store.markStarting(task.id);
  await store.fail(task.id, new Error("API connection temporarily unavailable"), { retryable: true });
  const stopped = store.get(task.id);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.infiniteRetry, false);
  assert.equal(stopped.retryBackoff, "patient");
});

test("rate limits remain bounded even when connectivity infinite retry is enabled", async (t) => {
  const fixture = await createFixture(t);
  let now = Date.UTC(2026, 6, 29, 13, 30, 0);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  const task = await store.create({
    prompt: "Retry a bounded rate limit",
    projectPath: fixture.project,
    maxAttempts: 2,
    infiniteRetry: true,
    retryBackoff: "fast",
  });

  await store.markStarting(task.id);
  await store.fail(task.id, new Error("429 rate limited"), {
    retryable: true,
    allowInfiniteRetry: false,
  });
  assert.equal(store.get(task.id).status, "queued");
  now = store.get(task.id).nextRunAt;
  await store.markStarting(task.id);
  await store.fail(task.id, new Error("429 rate limited"), {
    retryable: true,
    allowInfiniteRetry: false,
  });
  assert.equal(store.get(task.id).status, "failed");
  assert.equal(store.get(task.id).infiniteRetry, true);
});

test("permission suspension preserves tasks and connectivity recovery wakes retry backoff", async (t) => {
  const fixture = await createFixture(t);
  let now = Date.UTC(2026, 6, 29, 14, 0, 0);
  const scheduledAt = now + 60 * 60_000;
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
    now: () => now,
  }).initialize();
  const task = await store.create({
    prompt: "Run after permission and account access return",
    projectPath: fixture.project,
    schedule: { kind: "once", at: scheduledAt },
    runNow: false,
    infiniteRetry: true,
  });

  assert.equal(await store.setPermissionEnabled(false), true);
  const suspended = store.get(task.id);
  assert.equal(suspended.status, "paused");
  assert.equal(suspended.permissionSuspended, true);
  assert.equal(suspended.nextRunAt, null);

  assert.equal(await store.setPermissionEnabled(true), true);
  const restored = store.get(task.id);
  assert.equal(restored.status, "queued");
  assert.equal(restored.permissionSuspended, false);
  assert.equal(restored.nextRunAt, scheduledAt);

  now = scheduledAt;
  await store.markStarting(task.id);
  await store.fail(task.id, new Error("provider connection temporarily unavailable"), { retryable: true });
  assert.ok(store.get(task.id).nextRunAt > now);
  assert.equal(await store.wakeRetrying(), 1);
  assert.equal(store.get(task.id).nextRunAt, now);
  assert.equal(store.due(now).length, 1);
});

test("cancellation requested during startup survives late native turn binding", async (t) => {
  const fixture = await createFixture(t);
  const store = await new CodexBackgroundTaskStore({
    stateDirectory: fixture.state,
    projectRoot: fixture.projects,
  }).initialize();
  const task = await store.create({
    prompt: "Do not leave an orphan turn when startup is cancelled",
    projectPath: fixture.project,
  });

  await store.markStarting(task.id);
  const cancelling = await store.requestCancel(task.id);
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.cancelRequested, true);

  const bound = await store.markRunning(task.id, {
    threadId: "thread_cancel_during_start",
    turnId: "turn_cancel_during_start",
  });
  assert.equal(bound.status, "cancelling");
  assert.equal(bound.runs[0].status, "cancelling");
  assert.equal(bound.currentThreadId, "thread_cancel_during_start");
  assert.equal(bound.currentTurnId, "turn_cancel_during_start");

  const completed = await store.complete(task.id);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.runs[0].status, "cancelled");
  assert.equal(completed.currentThreadId, null);
  assert.equal(completed.currentTurnId, null);
});

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-background-tasks-"));
  const state = path.join(root, "state");
  const projects = path.join(root, "projects");
  const project = path.join(projects, "sample");
  await fs.mkdir(project, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, state, projects, project };
}
