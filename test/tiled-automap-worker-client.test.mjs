import assert from "node:assert/strict";
import test from "node:test";
import { TiledAutomapWorkerClient } from "../public/map-editor/tiled-automap-worker-client.js";

test("resolves structured Automapping Worker previews", async () => {
  const worker = new FakeWorker();
  const timers = new ManualTimers();
  const client = new TiledAutomapWorkerClient({
    workerFactory: () => worker,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const pending = client.preview({ type: "map" }, [{ rules: [], options: {} }], { seed: 42 });
  assert.equal(worker.messages[0].type, "preview");
  assert.equal(worker.messages[0].options.seed, 42);
  worker.emit("message", { type: "result", id: worker.messages[0].id, preview: validPreview() });
  assert.deepEqual(await pending, validPreview());
  assert.equal(timers.size, 0);
  client.destroy();
});

test("aborting terminates the active worker and rejects all queued previews", async () => {
  const workers = [];
  const client = new TiledAutomapWorkerClient({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const controller = new AbortController();
  const first = client.preview({ type: "map" }, [], { seed: 1, signal: controller.signal });
  const second = client.preview({ type: "map" }, [], { seed: 2 });
  controller.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");
  await assert.rejects(second, (error) => error.name === "AbortError");
  assert.equal(workers[0].terminated, true);
  const third = client.preview({ type: "map" }, [], { seed: 3 });
  assert.equal(workers.length, 2);
  client.destroy();
  await assert.rejects(third, (error) => error.name === "AbortError");
});

test("crash, messageerror, malformed output, and send failure terminate and rebuild Automapping Worker", async () => {
  const workers = [];
  const client = new TiledAutomapWorkerClient({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const first = client.preview({ type: "map" }, []);
  workers[0].emit("error", { message: "Worker crashed" });
  await assert.rejects(first, (error) => error.code === "automap-worker-failed"
    && /保存仍可继续/u.test(error.message));
  const second = client.preview({ type: "map" }, []);
  workers[1].emit("messageerror");
  await assert.rejects(second, (error) => error.code === "automap-worker-failed");
  const third = client.preview({ type: "map" }, []);
  workers[2].emit("message", { type: "result", id: workers[2].messages[0].id, preview: { changes: [] } });
  await assert.rejects(third, (error) => error.code === "automap-worker-failed");
  const fourth = client.preview({ type: "map" }, []);
  workers[3].postMessageError = new Error("clone failed");
  client.cancelAll();
  await assert.rejects(fourth, (error) => error.name === "AbortError");
  const sendWorker = new FakeWorker();
  sendWorker.postMessageError = new Error("clone failed");
  const sendClient = new TiledAutomapWorkerClient({ workerFactory: () => sendWorker });
  await assert.rejects(sendClient.preview({ type: "map" }, []), (error) => error.code === "automap-worker-failed");
  assert.equal(sendWorker.terminated, true);
  assert.equal(workers.slice(0, 3).every((worker) => worker.terminated), true);
});

test("Automapping timeout rejects co-located work, clears timers, and recreates the Worker", async () => {
  const workers = [];
  const timers = new ManualTimers();
  const client = new TiledAutomapWorkerClient({
    timeoutMs: 25,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = client.preview({ type: "map" }, []);
  const second = client.preview({ type: "map" }, []);
  timers.fireNext();
  await assert.rejects(first, (error) => error.code === "automap-worker-timeout");
  await assert.rejects(second, (error) => error.code === "automap-worker-timeout");
  assert.equal(timers.size, 0);
  const recovered = client.preview({ type: "map" }, []);
  assert.equal(workers.length, 2);
  client.destroy();
  await assert.rejects(recovered, (error) => error.name === "AbortError");
});

test("unavailable Automapping Worker leaves later operations retryable", async () => {
  let attempts = 0;
  const client = new TiledAutomapWorkerClient({ workerFactory: () => {
    attempts += 1;
    if (attempts === 1) throw new Error("unsupported");
    return new FakeWorker();
  } });
  await assert.rejects(client.preview({ type: "map" }, []), (error) => error.code === "automap-worker-unavailable");
  const recovered = client.preview({ type: "map" }, []);
  assert.equal(attempts, 2);
  client.destroy();
  await assert.rejects(recovered, (error) => error.name === "AbortError");
});

function validPreview() {
  return {
    seed: 42,
    changes: [],
    additions: [],
    matches: [],
    stats: { ruleMaps: 0, rules: 0, candidates: 0, matches: 0, changes: 0, addedLayers: 0 },
  };
}

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

  terminate() {
    this.terminated = true;
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ data, message: data?.message, preventDefault() {} });
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
