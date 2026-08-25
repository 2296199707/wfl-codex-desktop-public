import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageExecutionQueue } from "../lib/image-execution-queue.mjs";
import { ImageExecutionSettingsStore } from "../lib/image-execution-settings.mjs";

async function withQueue(operation, runner) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-queue-"));
  const settingsStore = await new ImageExecutionSettingsStore(root).initialize();
  const queue = new ImageExecutionQueue({ settingsStore, runner });
  try {
    await operation({ queue, settingsStore });
  } finally {
    await queue.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function input(userId, marker) {
  return {
    identity: { userId, browserSessionId: `browser-${userId}` },
    payload: { marker, imageApi: { apiKey: `secret-${marker}` } },
  };
}

function sessionInput(userId, browserSessionId, marker) {
  return {
    identity: { userId, browserSessionId },
    payload: { marker, imageApi: { apiKey: `secret-${marker}` } },
  };
}

function nonBrowserInput(userId, marker) {
  return {
    identity: { userId, credentialKind: "non-browser" },
    payload: { marker, imageApi: { apiKey: `secret-${marker}` } },
  };
}

async function waitFor(predicate, label = "condition") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("image queue runs FIFO at the frozen default concurrency and queues overflow", async () => {
  const started = [];
  const releases = [];
  await withQueue(async ({ queue }) => {
    const first = queue.enqueue(input("user-a", "first"));
    const second = queue.enqueue(input("user-b", "second"));
    const third = queue.enqueue(input("user-c", "third"));
    await waitFor(() => started.length === 1, "first image task");
    assert.deepEqual(started, ["first"]);
    assert.equal(queue.status().queueLength, 2);
    releases.shift()({ files: [] });
    await waitFor(() => started.length === 2, "second image task");
    releases.shift()({ files: [] });
    await waitFor(() => started.length === 3, "third image task");
    releases.shift()({ files: [] });
    await Promise.all([first.promise, second.promise, third.promise]);
    assert.deepEqual(started, ["first", "second", "third"]);
  }, (job) => new Promise((resolve) => {
    started.push(job.payload.marker);
    releases.push(resolve);
  }));
});

test("queued image jobs retain their admission settings after an administrator changes preset", async () => {
  const started = [];
  const releases = [];
  await withQueue(async ({ queue, settingsStore }) => {
    const oldRunning = queue.enqueue(input("user-a", "old-running"));
    const oldQueued = queue.enqueue(input("user-b", "old-queued"));
    await waitFor(() => started.length === 1, "old running task");
    await settingsStore.applyPreset("performance");
    const newTask = queue.enqueue(input("user-c", "new-task"));
    assert.notEqual(oldQueued.job.settingsRevision, newTask.job.settingsRevision);
    releases.shift()({ files: [] });
    await waitFor(() => started.length === 3, "old queued and new tasks");
    assert.deepEqual(started, ["old-running:1", "old-queued:1", "new-task:4"]);
    assert.equal(queue.snapshot(oldQueued.id).status, "preparing");
    assert.equal(queue.snapshot(newTask.id).status, "preparing");
    releases.shift()({ files: [] });
    releases.shift()({ files: [] });
    await Promise.all([oldRunning.promise, oldQueued.promise, newTask.promise]);
  }, (job) => new Promise((resolve) => {
    started.push(`${job.payload.marker}:${job.settings.config.worker.concurrency}`);
    releases.push(resolve);
  }));
});

test("AbortSignal cancels queued and running image jobs without retrying", async () => {
  let calls = 0;
  await withQueue(async ({ queue }) => {
    const runningAbort = new AbortController();
    const queuedAbort = new AbortController();
    const running = queue.enqueue(input("user-a", "running"), { signal: runningAbort.signal });
    await waitFor(() => queue.snapshot(running.id).status === "preparing", "running task");
    const queued = queue.enqueue(input("user-b", "queued"), { signal: queuedAbort.signal });
    queuedAbort.abort();
    await assert.rejects(queued.promise, (error) => error.code === "IMAGE_TASK_CANCELED");
    assert.equal(queue.snapshot(queued.id).status, "canceled");
    runningAbort.abort();
    await assert.rejects(running.promise, (error) => error.code === "IMAGE_TASK_CANCELED");
    assert.equal(calls, 1);
  }, (_job, { signal }) => new Promise((_resolve, reject) => {
    calls += 1;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("canceled"), {
      code: "IMAGE_TASK_CANCELED",
    })), { once: true });
  }));
});

test("browser session cancellation is exact, aborts its runner, and is idempotent", async () => {
  const started = [];
  const releases = new Map();
  const aborted = [];
  await withQueue(async ({ queue }) => {
    const targetRunning = queue.enqueue(sessionInput("user-a", "browser-window-a", "target-running"));
    await waitFor(() => started.includes("target-running"), "target browser task");
    const targetQueued = queue.enqueue(sessionInput("user-a", "browser-window-a", "target-queued"));
    const otherWindow = queue.enqueue(sessionInput("user-a", "browser-window-b", "other-window"));
    const runningRejected = assert.rejects(
      targetRunning.promise,
      (error) => error.code === "IMAGE_TASK_CANCELED",
    );
    const queuedRejected = assert.rejects(
      targetQueued.promise,
      (error) => error.code === "IMAGE_TASK_CANCELED",
    );

    const canceled = queue.cancelForSession({
      userId: "user-a",
      browserSessionId: "browser-window-a",
    });
    assert.equal(canceled.canceled, 2);
    assert.deepEqual(canceled.jobs.map((job) => job.id).sort(), [targetRunning.id, targetQueued.id].sort());
    assert.deepEqual(canceled.jobs.map((job) => job.identity), [
      { userId: "user-a", credentialKind: "browser" },
      { userId: "user-a", credentialKind: "browser" },
    ]);
    assert.equal(queue.cancelForSession({
      userId: "user-a",
      browserSessionId: "browser-window-a",
    }).canceled, 0);

    await Promise.all([runningRejected, queuedRejected]);
    assert.deepEqual(aborted, ["target-running"]);
    await waitFor(() => started.includes("other-window"), "other browser window task");
    assert.notEqual(queue.snapshot(otherWindow.id).status, "canceled");
    releases.get("other-window")({ files: [] });
    await otherWindow.promise;
  }, (job, { signal }) => new Promise((resolve, reject) => {
    started.push(job.payload.marker);
    releases.set(job.payload.marker, resolve);
    signal.addEventListener("abort", () => {
      aborted.push(job.payload.marker);
      reject(Object.assign(new Error("canceled"), { code: "IMAGE_TASK_CANCELED" }));
    }, { once: true });
  }));
});

test("browser logout does not cancel MCP or other non-browser credential tasks", async () => {
  const signals = new Map();
  const releases = new Map();
  await withQueue(async ({ queue, settingsStore }) => {
    await settingsStore.updateCustom({ worker: {
      concurrency: 2,
      perUserConcurrency: 2,
      memoryMb: 512,
      totalMemoryMb: 1_024,
    } });
    const browser = queue.enqueue(sessionInput("user-a", "browser-window-a", "browser"));
    const mcp = queue.enqueue(nonBrowserInput("user-a", "mcp"));
    const browserRejected = assert.rejects(browser.promise, (error) => error.code === "IMAGE_TASK_CANCELED");
    await waitFor(() => signals.size === 2, "browser and MCP tasks");

    const canceled = queue.cancelForSession({
      userId: "user-a",
      browserSessionId: "browser-window-a",
    });
    assert.equal(canceled.canceled, 1);
    await browserRejected;
    assert.equal(signals.get("browser").aborted, true);
    assert.equal(signals.get("mcp").aborted, false);
    assert.deepEqual(queue.snapshot(mcp.id).identity, {
      userId: "user-a",
      credentialKind: "non-browser",
    });
    releases.get("mcp")({ files: [] });
    await mcp.promise;
  }, (job, { signal }) => new Promise((resolve, reject) => {
    signals.set(job.payload.marker, signal);
    releases.set(job.payload.marker, resolve);
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("canceled"), { code: "IMAGE_TASK_CANCELED" }));
    }, { once: true });
  }));
});

test("image queue public records omit browser session and operation identifiers", async () => {
  await withQueue(async ({ queue }) => {
    const admitted = queue.enqueue({
      identity: {
        userId: "user-a",
        browserSessionId: "sensitive-browser-session",
        clientOperationId: "sensitive-client-operation",
      },
      payload: { marker: "privacy" },
    });
    assert.deepEqual(admitted.job.identity, { userId: "user-a", credentialKind: "browser" });
    assert.deepEqual(queue.snapshot(admitted.id).identity, { userId: "user-a", credentialKind: "browser" });
    assert.deepEqual(queue.list({ userId: "user-a" })[0].identity, {
      userId: "user-a",
      credentialKind: "browser",
    });
    const canceled = queue.cancelForIdentity({
      userId: "user-a",
      browserSessionId: "sensitive-browser-session",
      clientOperationId: "sensitive-client-operation",
    });
    assert.equal(canceled.canceled, 1);
    await assert.rejects(admitted.promise, (error) => error.code === "IMAGE_TASK_CANCELED");
    assert.equal(queue.cancelForIdentity({
      userId: "user-a",
      browserSessionId: "sensitive-browser-session",
      clientOperationId: "sensitive-client-operation",
    }).canceled, 0);
  }, async () => ({ files: [] }));
});

test("image queue applies manual total and per-user concurrency without automatic changes", async () => {
  const active = new Set();
  const maximums = [];
  const releases = [];
  await withQueue(async ({ queue, settingsStore }) => {
    await settingsStore.updateCustom({ worker: {
      concurrency: 2,
      perUserConcurrency: 1,
      memoryMb: 512,
      totalMemoryMb: 1_024,
    } });
    const first = queue.enqueue(input("user-a", "a1"));
    const sameUser = queue.enqueue(input("user-a", "a2"));
    const otherUser = queue.enqueue(input("user-b", "b1"));
    await waitFor(() => active.size === 1, "first user task");
    assert.deepEqual([...active], ["a1"]);
    releases.shift()();
    await waitFor(() => active.has("a2"), "second same-user task");
    await waitFor(() => active.has("b1"), "other user task");
    assert.equal(Math.max(...maximums), 2);
    while (releases.length) releases.shift()();
    await Promise.all([first.promise, sameUser.promise, otherUser.promise]);
  }, (job) => new Promise((resolve) => {
    active.add(job.payload.marker);
    maximums.push(active.size);
    releases.push(() => {
      active.delete(job.payload.marker);
      resolve({ files: [] });
    });
  }));
});

test("image queue rejects binary IPC payloads", async () => {
  await withQueue(async ({ queue }) => {
    assert.throws(
      () => queue.enqueue({ identity: { userId: "user-a" }, payload: { image: Buffer.from("bytes") } }),
      (error) => error.code === "INVALID_IMAGE_TASK_PAYLOAD",
    );
  }, async () => ({ files: [] }));
});

test("image queue awaits asynchronous partial and usage consumers before settling", async () => {
  let releaseConsumer;
  const consumerGate = new Promise((resolve) => { releaseConsumer = resolve; });
  let consumerStarted = false;
  await withQueue(async ({ queue }) => {
    const admitted = queue.enqueue(input("user-a", "events"), {
      onEvent: async (event) => {
        assert.equal(event.type, "usage");
        consumerStarted = true;
        await consumerGate;
      },
    });
    await waitFor(() => consumerStarted, "usage consumer");
    assert.equal(queue.snapshot(admitted.id).status, "preparing");
    let settled = false;
    admitted.promise.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseConsumer();
    await admitted.promise;
    assert.equal(queue.snapshot(admitted.id).status, "succeeded");
  }, async (_job, { onEvent }) => {
    await onEvent({ type: "usage", usage: { totalTokens: 1 } });
    return { files: [] };
  });
});

test("image queue keeps a committed runner result successful when cancellation races its return", async () => {
  await withQueue(async ({ queue }) => {
    const controller = new AbortController();
    const admitted = queue.enqueue(input("user-a", "commit-race"), { signal: controller.signal });
    await waitFor(() => queue.snapshot(admitted.id).status === "committing", "committing phase");
    controller.abort();
    const result = await admitted.promise;
    assert.equal(result.committed, true);
    assert.equal(queue.snapshot(admitted.id).status, "succeeded");
  }, async (_job, { signal, onEvent }) => {
    await onEvent({ type: "phase", phase: "committing" });
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ committed: true, files: [] }), { once: true });
    });
  });
});
