import assert from "node:assert/strict";
import test from "node:test";
import {
  TiledFillWorkerClient,
  createFillRequest,
} from "../public/map-editor/tiled-fill-worker-client.js";

test("snapshots decoded layers into transferable unsigned blocks", () => {
  const request = createFillRequest({
    type: "tilelayer",
    chunks: [{ x: -2, y: 3, width: 2, height: 1, data: [0x8000_0001, 2] }],
  }, -2, 3, 4, 123);
  assert.equal(request.blocks[0].kind, "chunk");
  assert.equal(request.blocks[0].data instanceof Uint32Array, true);
  assert.deepEqual([...request.blocks[0].data], [0x8000_0001, 2]);
  assert.equal(request.maxCells, 123);
});

test("returns compact addresses together with stable block descriptors", async () => {
  const worker = new FakeWorker();
  const timers = new ManualTimers();
  const client = new TiledFillWorkerClient({
    workerFactory: () => worker,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const pending = client.fill({
    type: "tilelayer",
    width: 2,
    height: 1,
    data: [1, 1],
  }, 0, 0, 2);
  assert.equal(worker.messages[0].message.type, "fill");
  assert.equal(worker.messages[0].transfer.length, 1);
  worker.emit("message", {
    type: "result",
    id: worker.messages[0].message.id,
    result: {
      addresses: Int32Array.of(0, 0, 0, 1),
      target: 1,
      replacement: 2,
      count: 2,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 0 },
    },
  });
  const result = await pending;
  assert.deepEqual(result.blocks, [{ kind: "data", x: 0, y: 0, width: 2, height: 1 }]);
  assert.deepEqual([...result.addresses], [0, 0, 0, 1]);
  assert.equal(timers.size, 0);
  client.destroy();
});

test("rejects malformed result counts and recreates the Worker after cancellation", async () => {
  const workers = [];
  const client = new TiledFillWorkerClient({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const invalid = client.fill({ type: "tilelayer", width: 1, height: 1, data: [1] }, 0, 0, 2);
  workers[0].emit("message", {
    type: "result",
    id: workers[0].messages[0].message.id,
    result: { addresses: Int32Array.of(0, 0), target: 1, replacement: 2, count: 2, bounds: null },
  });
  await assert.rejects(invalid, (error) => error.code === "fill-worker-failed");

  const controller = new AbortController();
  const canceled = client.fill({ type: "tilelayer", width: 1, height: 1, data: [1] }, 0, 0, 2, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(canceled, (error) => error.name === "AbortError");
  assert.equal(workers[0].terminated, true);
  const next = client.fill({ type: "tilelayer", width: 1, height: 1, data: [1] }, 0, 0, 2);
  assert.equal(workers.length, 3);
  client.destroy();
  await assert.rejects(next, (error) => error.name === "AbortError");
});

test("crash, message decoding failure, and postMessage failure reject only browser work and rebuild", async () => {
  const workers = [];
  const client = new TiledFillWorkerClient({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const layer = { type: "tilelayer", width: 1, height: 1, data: [1] };

  const crashed = client.fill(layer, 0, 0, 2);
  workers[0].emit("error", { message: "out of memory" });
  await assert.rejects(crashed, (error) => error.code === "fill-worker-out-of-memory"
    && /保存仍可继续/u.test(error.message));
  assert.equal(workers[0].terminated, true);

  const unreadable = client.fill(layer, 0, 0, 2);
  workers[1].emit("messageerror");
  await assert.rejects(unreadable, (error) => error.code === "fill-worker-failed");
  assert.equal(workers[1].terminated, true);

  const unsent = client.fill(layer, 0, 0, 2);
  workers[2].postMessageError = new Error("clone failed");
  // The task above was already sent; fail a newly rebuilt Worker explicitly.
  client.cancelAll();
  await assert.rejects(unsent, (error) => error.name === "AbortError");
  workers[3] = new FakeWorker();
  workers[3].postMessageError = new Error("clone failed");
  const throwingClient = new TiledFillWorkerClient({ workerFactory: () => workers[3] });
  await assert.rejects(throwingClient.fill(layer, 0, 0, 2), (error) => error.code === "fill-worker-failed"
    && /clone failed/u.test(error.message));
  assert.equal(workers[3].terminated, true);

  const recovered = client.fill(layer, 0, 0, 2);
  assert.equal(workers.length >= 4, true);
  client.destroy();
  await assert.rejects(recovered, (error) => error.name === "AbortError");
});

test("timeout terminates all requests on the stuck Worker, clears timers, and permits recreation", async () => {
  const workers = [];
  const timers = new ManualTimers();
  const client = new TiledFillWorkerClient({
    timeoutMs: 25,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const layer = { type: "tilelayer", width: 1, height: 1, data: [1] };
  const first = client.fill(layer, 0, 0, 2);
  const second = client.fill(layer, 0, 0, 3);
  assert.equal(timers.size, 2);
  timers.fireNext();
  await assert.rejects(first, (error) => error.code === "fill-worker-timeout");
  await assert.rejects(second, (error) => error.code === "fill-worker-timeout");
  assert.equal(timers.size, 0);
  assert.equal(workers[0].terminated, true);
  const recovered = client.fill(layer, 0, 0, 2);
  assert.equal(workers.length, 2);
  client.destroy();
  await assert.rejects(recovered, (error) => error.name === "AbortError");
});

test("unavailable Worker is reported without preventing a later retry", async () => {
  let attempts = 0;
  const worker = new FakeWorker();
  const client = new TiledFillWorkerClient({ workerFactory: () => {
    attempts += 1;
    if (attempts === 1) throw new Error("module workers blocked");
    return worker;
  } });
  const layer = { type: "tilelayer", width: 1, height: 1, data: [1] };
  await assert.rejects(client.fill(layer, 0, 0, 2), (error) => error.code === "fill-worker-unavailable"
    && /保存仍可继续/u.test(error.message));
  const recovered = client.fill(layer, 0, 0, 2);
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

  postMessage(message, transfer = []) {
    if (this.postMessageError) throw this.postMessageError;
    this.messages.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

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
