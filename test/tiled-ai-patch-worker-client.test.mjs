import assert from "node:assert/strict";
import test from "node:test";
import { TiledAiPatchWorkerClient } from "../public/map-editor/tiled-ai-patch-worker-client.js";

test("returns transferred compact AI fill preparations", async () => {
  const worker = new FakeWorker();
  const timers = new ManualTimers();
  const client = new TiledAiPatchWorkerClient({
    workerFactory: () => worker,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const pending = client.prepare({ type: "map", layers: [] }, { operations: [] });
  worker.emit("message", {
    type: "result",
    id: worker.messages[0].id,
    prepared: {
      fillResults: [{
        operationIndex: 1,
        result: { addresses: Int32Array.of(0, 0), count: 1 },
      }],
      tileCellCount: 1,
    },
  });
  const result = await pending;
  assert.equal(result.fillResults[0].operationIndex, 1);
  assert.deepEqual([...result.fillResults[0].result.addresses], [0, 0]);
  assert.equal(timers.size, 0);
  client.destroy();
});

test("cancellation terminates the AI patch Worker and permits recreation", async () => {
  const workers = [];
  const client = new TiledAiPatchWorkerClient({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const controller = new AbortController();
  const first = client.prepare({ layers: [] }, { operations: [] }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.equal(workers[0].terminated, true);
  const second = client.prepare({ layers: [] }, { operations: [] });
  assert.equal(workers.length, 2);
  client.destroy();
  await assert.rejects(second, (error) => error.name === "AbortError");
});

test("AI patch Worker crash, messageerror, malformed output, and send failure are isolated and rebuildable", async () => {
  const workers = [];
  const client = new TiledAiPatchWorkerClient({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const first = client.prepare({ layers: [] }, { operations: [] });
  workers[0].emit("error", { message: "memory limit exceeded" });
  await assert.rejects(first, (error) => error.code === "ai-patch-worker-out-of-memory"
    && /补丁未应用/u.test(error.message));
  const second = client.prepare({ layers: [] }, { operations: [] });
  workers[1].emit("messageerror");
  await assert.rejects(second, (error) => error.code === "ai-patch-worker-failed");
  const third = client.prepare({ layers: [] }, { operations: [] });
  workers[2].emit("message", {
    type: "result",
    id: workers[2].messages[0].id,
    prepared: { fillResults: [{ operationIndex: 0, result: { addresses: [], count: 0 } }], tileCellCount: 0 },
  });
  await assert.rejects(third, (error) => error.code === "ai-patch-worker-failed");
  const sendWorker = new FakeWorker();
  sendWorker.postMessageError = new Error("clone failed");
  const sendClient = new TiledAiPatchWorkerClient({ workerFactory: () => sendWorker });
  await assert.rejects(sendClient.prepare({ layers: [] }, { operations: [] }), (error) => error.code === "ai-patch-worker-failed");
  assert.equal(sendWorker.terminated, true);
  assert.equal(workers.every((worker) => worker.terminated), true);
});

test("AI patch timeout clears all work on the stuck Worker and recreates it", async () => {
  const workers = [];
  const timers = new ManualTimers();
  const client = new TiledAiPatchWorkerClient({
    timeoutMs: 25,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = client.prepare({ layers: [] }, { operations: [] });
  const second = client.prepare({ layers: [] }, { operations: [] });
  timers.fireNext();
  await assert.rejects(first, (error) => error.code === "ai-patch-worker-timeout");
  await assert.rejects(second, (error) => error.code === "ai-patch-worker-timeout");
  assert.equal(timers.size, 0);
  const recovered = client.prepare({ layers: [] }, { operations: [] });
  assert.equal(workers.length, 2);
  client.destroy();
  await assert.rejects(recovered, (error) => error.name === "AbortError");
});

test("unavailable AI patch Worker reports isolation and allows retry", async () => {
  let attempts = 0;
  const client = new TiledAiPatchWorkerClient({ workerFactory: () => {
    attempts += 1;
    if (attempts === 1) return null;
    return new FakeWorker();
  } });
  await assert.rejects(client.prepare({ layers: [] }, { operations: [] }), (error) => error.code === "ai-patch-worker-unavailable"
    && /保存仍可继续/u.test(error.message));
  const recovered = client.prepare({ layers: [] }, { operations: [] });
  assert.equal(attempts, 2);
  client.destroy();
  await assert.rejects(recovered, (error) => error.name === "AbortError");
});

class FakeWorker {
  constructor() {
    this.messages = [];
    this.listeners = new Map();
    this.terminated = false;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  postMessage(message) {
    if (this.postMessageError) throw this.postMessageError;
    this.messages.push(message);
  }
  terminate() { this.terminated = true; }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({
      data,
      message: data?.message,
      preventDefault() {},
    });
  }
}

class ManualTimers {
  constructor() {
    this.timers = new Map();
    this.nextId = 1;
    this.setTimeout = (callback, delay) => {
      const id = this.nextId++;
      this.timers.set(id, { callback, delay });
      return id;
    };
    this.clearTimeout = (id) => this.timers.delete(id);
  }

  get size() { return this.timers.size; }
  fireNext() {
    const [id, timer] = this.timers.entries().next().value || [];
    if (!timer) throw new Error("No pending timer");
    this.timers.delete(id);
    timer.callback();
  }
}
