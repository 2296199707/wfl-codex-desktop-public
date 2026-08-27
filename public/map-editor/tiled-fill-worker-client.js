const DEFAULT_MAX_CELLS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class TiledFillWorkerClient {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || new URL("./tiled-fill-worker.js?v=0.44.56-beta", import.meta.url);
    this.workerFactory = options.workerFactory || ((url) => new Worker(url, { type: "module", name: "wfl-tiled-fill" }));
    this.timeoutMs = timeoutMilliseconds(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.scheduleTimeout = options.setTimeout || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout || ((timer) => globalThis.clearTimeout(timer));
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  fill(layer, x, y, replacement, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    let worker;
    try {
      worker = this.requireWorker();
    } catch (error) {
      return Promise.reject(workerUnavailableError(error));
    }
    const id = `fill-${this.nextId++}`;
    const request = createFillRequest(layer, x, y, replacement, options.maxCells);
    const blocks = request.blocks.map(({ kind, x: blockX, y: blockY, width, height }) => Object.freeze({
      kind,
      x: blockX,
      y: blockY,
      width,
      height,
    }));
    return new Promise((resolve, reject) => {
      const abort = () => this.cancelAll(abortError());
      if (signal) signal.addEventListener("abort", abort, { once: true });
      const pending = {
        resolve,
        reject,
        signal,
        abort,
        blocks: Object.freeze(blocks),
        timer: null,
      };
      this.pending.set(id, pending);
      pending.timer = this.scheduleTimeout(() => {
        this.failWorker(worker, workerError(
          `填充 Worker 超过 ${this.timeoutMs}ms 未完成；本次填充已停止，地图编辑和保存仍可继续`,
          "fill-worker-timeout",
        ));
      }, this.timeoutMs);
      try {
        const transfer = request.blocks.map((block) => block.data.buffer);
        worker.postMessage({ type: "fill", id, request }, transfer);
      } catch (error) {
        this.failWorker(worker, workerError(
          `无法向填充 Worker 发送任务：${error?.message || "未知错误"}；地图编辑和保存仍可继续`,
        ));
      }
    });
  }

  cancelAll(reason = abortError()) {
    const worker = this.worker;
    this.worker = null;
    try { worker?.terminate(); } catch {}
    for (const id of [...this.pending.keys()]) this.settle(id, "reject", reason);
  }

  destroy() {
    this.cancelAll(abortError("填充 Worker 已关闭"));
  }

  requireWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(this.workerUrl);
    if (!worker || typeof worker.postMessage !== "function" || typeof worker.addEventListener !== "function") {
      try { worker?.terminate?.(); } catch {}
      throw new TypeError("浏览器没有返回可用的填充 Worker");
    }
    worker.addEventListener("message", (event) => {
      if (this.worker === worker) this.handleMessage(worker, event.data);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      this.failWorker(worker, workerRuntimeError(event, "填充"));
    });
    worker.addEventListener?.("messageerror", () => {
      this.failWorker(worker, workerError(
        "填充 Worker 返回了无法读取的数据；本次填充已停止，地图编辑和保存仍可继续",
      ));
    });
    this.worker = worker;
    return worker;
  }

  handleMessage(worker, message) {
    if (!message || typeof message.id !== "string") return;
    if (message.type === "result") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      try {
        this.settle(message.id, "resolve", normalizeResult(message.result, pending.blocks));
      } catch (error) {
        this.failWorker(worker, error);
      }
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.error?.message || "填充 Worker 执行失败");
      error.name = message.error?.name || "Error";
      error.code = message.error?.code || null;
      this.settle(message.id, "reject", error);
    }
  }

  settle(id, action, value) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer !== null) this.cancelTimeout(pending.timer);
    if (pending.signal) pending.signal.removeEventListener("abort", pending.abort);
    pending[action](value);
  }

  failWorker(worker, reason) {
    if (this.worker !== worker) return;
    this.cancelAll(reason);
  }
}

export function createFillRequest(layer, x, y, replacement, maxCells = DEFAULT_MAX_CELLS) {
  if (!layer || layer.type !== "tilelayer") throw new TypeError("A decoded Tiled tile layer is required");
  const blocks = [];
  if (Array.isArray(layer.data)) {
    blocks.push(blockSnapshot(layer, 0, layer.data, "data"));
  } else if (Array.isArray(layer.chunks)) {
    for (const chunk of layer.chunks) blocks.push(blockSnapshot(chunk, blocks.length, chunk?.data, "chunk"));
  } else {
    throw new TypeError("The Tiled tile layer is not decoded");
  }
  if (!blocks.length) throw new TypeError("The Tiled tile layer has no existing cells");
  return {
    blocks,
    x: safeInteger(x, "x"),
    y: safeInteger(y, "y"),
    replacement: tiledGid(replacement),
    maxCells: positiveInteger(maxCells, "maxCells"),
  };
}

function blockSnapshot(source, index, data, kind) {
  const width = positiveInteger(source?.width, `block ${index + 1} width`);
  const height = positiveInteger(source?.height, `block ${index + 1} height`);
  if (!Array.isArray(data) || data.length !== width * height) {
    throw new TypeError(`block ${index + 1} data does not match its dimensions`);
  }
  return {
    kind,
    x: safeInteger(kind === "chunk" ? source?.x : source?.startx ?? 0, `block ${index + 1} x`),
    y: safeInteger(kind === "chunk" ? source?.y : source?.starty ?? 0, `block ${index + 1} y`),
    width,
    height,
    data: Uint32Array.from(data, (entry) => tiledGid(entry)),
  };
}

function normalizeResult(value, blocks) {
  if (!value || !(value.addresses instanceof Int32Array) || value.addresses.length % 2 !== 0) {
    throw workerError("填充 Worker 结果格式无效");
  }
  const count = positiveOrZeroInteger(value.count, "count");
  if (value.addresses.length !== count * 2) throw workerError("填充 Worker 结果数量不一致");
  if (!Array.isArray(blocks) || !blocks.length) throw workerError("填充 Worker 缺少瓦片块定位信息");
  return Object.freeze({
    addresses: value.addresses,
    blocks,
    target: tiledGid(value.target),
    replacement: tiledGid(value.replacement),
    count,
    bounds: value.bounds && Object.freeze({
      minX: safeInteger(value.bounds.minX, "bounds.minX"),
      minY: safeInteger(value.bounds.minY, "bounds.minY"),
      maxX: safeInteger(value.bounds.maxX, "bounds.maxX"),
      maxY: safeInteger(value.bounds.maxY, "bounds.maxY"),
    }),
  });
}

function tiledGid(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffff_ffff) throw new TypeError("Invalid Tiled GID");
  return number >>> 0;
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${label} must be a safe integer`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function positiveOrZeroInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return number;
}

function abortError(message = "填充已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function timeoutMilliseconds(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3_600_000) {
    throw new TypeError("timeoutMs must be a positive integer no greater than 3600000");
  }
  return value;
}

function workerUnavailableError(error) {
  return workerError(
    `浏览器无法启动填充 Worker：${error?.message || "未知错误"}；地图编辑和保存仍可继续`,
    "fill-worker-unavailable",
  );
}

function workerRuntimeError(event, label) {
  const detail = String(event?.message || "").trim();
  const outOfMemory = /out of memory|memory limit|内存/iu.test(detail);
  return workerError(
    outOfMemory
      ? `${label} Worker 内存不足并已停止；本次操作未应用，地图编辑和保存仍可继续`
      : `${label} Worker 意外停止${detail ? `：${detail}` : ""}；本次操作未应用，地图编辑和保存仍可继续`,
    outOfMemory ? "fill-worker-out-of-memory" : "fill-worker-failed",
  );
}

function workerError(message, code = "fill-worker-failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}
