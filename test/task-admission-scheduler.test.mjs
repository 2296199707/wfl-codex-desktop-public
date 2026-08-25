import assert from "node:assert/strict";
import test from "node:test";
import { FairTaskAdmissionScheduler } from "../lib/task-admission-scheduler.mjs";

test("admits at least three projects concurrently while enforcing the per-project cap", async () => {
  const releases = new Map();
  let queued = 0;
  const scheduler = new FairTaskAdmissionScheduler({
    maxActive: 3,
    maxActivePerProject: 1,
    maxQueued: 8,
  });
  const run = (taskKey, projectKey) => scheduler.run({
    taskKey,
    projectKey,
    onQueued: () => { queued += 1; },
  }, () => new Promise((resolve) => releases.set(taskKey, resolve)));

  const first = run("thread-a", "project-a");
  const second = run("thread-b", "project-b");
  const third = run("thread-c", "project-c");
  const fourth = run("thread-a-2", "project-a");
  await tick();

  assert.equal(scheduler.snapshot().active, 3);
  assert.equal(scheduler.snapshot().queued, 1);
  assert.equal(queued, 1);

  releases.get("thread-b")("b");
  await tick();
  assert.equal(scheduler.snapshot().active, 2);
  assert.equal(scheduler.snapshot().queued, 1);

  releases.get("thread-a")("a");
  await tick();
  assert.equal(releases.has("thread-a-2"), true);
  assert.equal(scheduler.snapshot().active, 2);
  assert.equal(scheduler.snapshot().queued, 0);

  releases.get("thread-c")("c");
  releases.get("thread-a-2")("a2");
  assert.deepEqual(await Promise.all([first, second, third, fourth]), ["a", "b", "c", "a2"]);
});

test("round-robins projects instead of draining one project backlog first", async () => {
  let releaseFirst;
  const order = [];
  const scheduler = new FairTaskAdmissionScheduler({
    maxActive: 1,
    maxActivePerProject: 1,
    maxQueued: 8,
  });
  const first = scheduler.run(
    { taskKey: "a-1", projectKey: "project-a" },
    () => new Promise((resolve) => {
      order.push("a-1");
      releaseFirst = resolve;
    }),
  );
  await tick();
  const secondA = scheduler.run(
    { taskKey: "a-2", projectKey: "project-a" },
    async () => { order.push("a-2"); },
  );
  const firstB = scheduler.run(
    { taskKey: "b-1", projectKey: "project-b" },
    async () => { order.push("b-1"); },
  );
  await tick();

  releaseFirst();
  await Promise.all([first, secondA, firstB]);
  assert.deepEqual(order, ["a-1", "b-1", "a-2"]);
});

test("bounds the queue and reports a task as unsent when admission times out", async () => {
  let releaseFirst;
  const rejected = [];
  const scheduler = new FairTaskAdmissionScheduler({
    maxActive: 1,
    maxActivePerProject: 1,
    maxQueued: 1,
    waitTimeoutMs: 20,
    setTimer: (callback, delay) => ({ handle: setTimeout(callback, delay) }),
    clearTimer: (timer) => clearTimeout(timer.handle),
  });
  const first = scheduler.run(
    { taskKey: "active", projectKey: "project-a" },
    () => new Promise((resolve) => { releaseFirst = resolve; }),
  );
  await tick();
  const timedOut = scheduler.run({
    taskKey: "queued",
    projectKey: "project-b",
    onRejected: (error) => rejected.push(error.code),
  }, async () => {});
  await assert.rejects(
    scheduler.run(
      { taskKey: "overflow", projectKey: "project-c" },
      async () => {},
    ),
    (error) => error.code === "ERR_TASK_ADMISSION_QUEUE_FULL" && error.status === 429,
  );
  await assert.rejects(
    timedOut,
    (error) => error.code === "ERR_TASK_ADMISSION_TIMEOUT" && error.status === 503,
  );
  assert.deepEqual(rejected, ["ERR_TASK_ADMISSION_TIMEOUT"]);
  releaseFirst();
  await first;
});

test("holds new admissions behind an exclusive bridge recovery fence", async () => {
  const active = [{ threadId: "target-thread", cwd: "project-a", status: "stopping" }];
  let releaseRecovery;
  const scheduler = new FairTaskAdmissionScheduler({
    activeTasks: () => active,
    maxActive: 3,
    maxActivePerProject: 2,
    maxQueued: 8,
  });
  const recovery = scheduler.runExclusiveFor(
    "target-thread",
    () => new Promise((resolve) => { releaseRecovery = resolve; }),
  );
  await tick();
  let started = false;
  const queued = scheduler.run(
    { taskKey: "next-thread", projectKey: "project-b" },
    async () => { started = true; },
  );
  await tick();
  assert.equal(started, false);
  assert.equal(scheduler.snapshot().queued, 1);

  active.length = 0;
  releaseRecovery("restarted");
  const [exclusive] = await Promise.all([recovery, queued]);
  assert.deepEqual(exclusive, { executed: true, result: "restarted" });
  assert.equal(started, true);
});

test("finds conflicts in active, reserved, and queued task scopes", async () => {
  const active = [{ threadId: "active-thread", cwd: "/workspace/a", status: "running" }];
  let releaseActive;
  const scheduler = new FairTaskAdmissionScheduler({
    activeTasks: () => active,
    maxActive: 2,
    maxActivePerProject: 1,
    maxQueued: 4,
  });
  const running = scheduler.run(
    { taskKey: "reserved-thread", projectKey: "/workspace/reserved" },
    () => new Promise((resolve) => { releaseActive = resolve; }),
  );
  await tick();

  assert.equal(scheduler.hasConflict({ projectKey: "/workspace/a" }), true);
  assert.equal(scheduler.hasConflict({ taskKey: "reserved-thread" }), true);
  assert.equal(scheduler.hasConflict({ projectKey: "/workspace/other" }), false);

  const queued = scheduler.run({
    taskKey: "queued-thread",
    projectKey: "/workspace/queued",
  }, async () => {});
  assert.equal(scheduler.hasConflict({ projectKey: "/workspace/queued" }), true);

  releaseActive();
  await Promise.all([running, queued]);
  assert.equal(scheduler.hasConflict({ projectKey: "/workspace/queued" }), false);
});

test("cancels only the requested queued thread before it is sent", async () => {
  let releaseFirst;
  const scheduler = new FairTaskAdmissionScheduler({
    maxActive: 1,
    maxActivePerProject: 1,
    maxQueued: 4,
  });
  const first = scheduler.run(
    { taskKey: "active", projectKey: "project-a" },
    () => new Promise((resolve) => { releaseFirst = resolve; }),
  );
  await tick();
  const queuedA = scheduler.run(
    { taskKey: "queued-a", projectKey: "project-b" },
    async () => "should-not-run",
  );
  const queuedB = scheduler.run(
    { taskKey: "queued-b", projectKey: "project-c" },
    async () => "ran-b",
  );
  await tick();

  assert.equal(scheduler.cancel("queued-a"), 1);
  await assert.rejects(
    queuedA,
    (error) => error.code === "ERR_TASK_ADMISSION_CANCELLED",
  );
  assert.equal(scheduler.snapshot().queued, 1);
  releaseFirst();
  await first;
  assert.equal(await queuedB, "ran-b");
});

test("dynamic hard limits atomically reject the ninth unique thread without queueing", async () => {
  const active = Array.from({ length: 7 }, (_, index) => ({
    threadId: `active-${index + 1}`,
    cwd: "project",
    status: "running",
  }));
  let limit = 8;
  let releaseLast;
  const scheduler = new FairTaskAdmissionScheduler({
    activeTasks: () => active,
    maxActive: () => limit,
    maxActivePerProject: () => limit,
    maxQueued: 4,
    rejectWhenFull: true,
    capacityError: (snapshot) => Object.assign(new Error("8/8"), {
      code: "ERR_USER_THREAD_LIMIT_REACHED",
      details: { current: snapshot.active, limit: snapshot.maxActive },
    }),
  });
  const eighth = scheduler.run(
    { taskKey: "thread-8", projectKey: "project" },
    () => new Promise((resolve) => { releaseLast = resolve; }),
  );
  await tick();
  await assert.rejects(
    scheduler.run({ taskKey: "thread-9", projectKey: "project" }, async () => {}),
    (error) => error.code === "ERR_USER_THREAD_LIMIT_REACHED"
      && error.details.current === 8
      && error.details.limit === 8,
  );
  assert.equal(scheduler.snapshot().queued, 0);

  limit = 10;
  scheduler.capacityChanged();
  assert.equal(await scheduler.run({ taskKey: "thread-9", projectKey: "project" }, async () => "started"), "started");
  limit = 4;
  scheduler.capacityChanged();
  assert.equal(active.length, 7);
  releaseLast();
  await eighth;
});

test("two independent user schedulers do not share thread IDs or capacity", async () => {
  const activeA = Array.from({ length: 8 }, (_, index) => ({ threadId: `same-${index}`, status: "running" }));
  const activeB = Array.from({ length: 7 }, (_, index) => ({ threadId: `same-${index}`, status: "running" }));
  const options = (activeTasks) => ({
    activeTasks: () => activeTasks,
    maxActive: 8,
    maxActivePerProject: 8,
    maxQueued: 1,
    rejectWhenFull: true,
  });
  const userA = new FairTaskAdmissionScheduler(options(activeA));
  const userB = new FairTaskAdmissionScheduler(options(activeB));
  await assert.rejects(userA.run({ taskKey: "new", projectKey: "p" }, async () => {}), /并发数已达到上限/);
  assert.equal(await userB.run({ taskKey: "new", projectKey: "p" }, async () => "ok"), "ok");
});

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
