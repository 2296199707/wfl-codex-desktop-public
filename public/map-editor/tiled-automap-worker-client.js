const DEFAULT_TIMEOUT_MS = 120_000;

export class TiledAutomapWorkerClient {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || new URL("./tiled-automap-worker.js?v=0.44.56-beta", import.meta.url);
    this.workerFactory = options.workerFactory || ((url) => new Worker(url, { type: "module", name: "wfl-tiled-automap" }));
    this.timeoutMs = timeoutMilliseconds(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.scheduleTimeout = options.setTimeout || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout || ((timer) => globalThis.clearTimeout(timer));
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  preview(document, compiled, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    let worker;
    try {
      worker = this.requireWorker();
    } catch (error) {
      return Promise.reject(workerUnavailableError(error));
    }
    const id = `automap-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.cancelAll(abortError());
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      const pending = { resolve, reject, signal, abort, timer: null };
      this.pending.set(id, pending);
      pending.timer = this.scheduleTimeout(() => {
        this.failWorker(worker, workerError(
          `Automapping Worker 超过 ${this.timeoutMs}ms 未完成；本次计算已停止，地图编辑和保存仍可继续`,
          "automap-worker-timeout",
        ));
      }, this.timeoutMs);
      try {
        const { signal: omitted, ...workerOptions } = options;
        worker.postMessage({ type: "preview", id, document, compiled, options: workerOptions });
      } catch (error) {
        this.failWorker(worker, workerError(
          `无法向 Automapping Worker 发送任务：${error?.message || "未知错误"}；地图编辑和保存仍可继续`,
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
    this.cancelAll(abortError("Automapping Worker 已关闭"));
  }

  requireWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(this.workerUrl);
    if (!worker || typeof worker.postMessage !== "function" || typeof worker.addEventListener !== "function") {
      try { worker?.terminate?.(); } catch {}
      throw new TypeError("浏览器没有返回可用的 Automapping Worker");
    }
    worker.addEventListener("message", (event) => {
      if (this.worker === worker) this.handleMessage(worker, event.data);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      this.failWorker(worker, workerRuntimeError(event));
    });
    worker.addEventListener?.("messageerror", () => {
      this.failWorker(worker, workerError(
        "Automapping Worker 返回了无法读取的数据；本次计算已停止，地图编辑和保存仍可继续",
      ));
    });
    this.worker = worker;
    return worker;
  }

  handleMessage(worker, message) {
    if (!message || typeof message.id !== "string") return;
    if (message.type === "result") {
      try {
        this.settle(message.id, "resolve", normalizePreview(message.preview));
      } catch (error) {
        this.failWorker(worker, error);
      }
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.error?.message || "Automapping Worker 执行失败");
      error.name = message.error?.name || "Error";
      error.code = message.error?.code || null;
      error.details = message.error?.details || null;
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

function abortError(message = "Automapping 已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function normalizePreview(value) {
  if (
    !value
    || !Array.isArray(value.changes)
    || !Array.isArray(value.additions)
    || !Array.isArray(value.matches)
    || !value.stats
    || typeof value.stats !== "object"
  ) throw workerError("Automapping Worker 结果格式无效");
  for (const key of ["ruleMaps", "rules", "candidates", "matches", "changes", "addedLayers"]) {
    if (!Number.isSafeInteger(value.stats[key]) || value.stats[key] < 0) {
      throw workerError("Automapping Worker 统计结果无效");
    }
  }
  if (value.stats.changes !== value.changes.length || value.stats.addedLayers !== value.additions.length) {
    throw workerError("Automapping Worker 结果数量不一致");
  }
  return value;
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
    `浏览器无法启动 Automapping Worker：${error?.message || "未知错误"}；地图编辑和保存仍可继续`,
    "automap-worker-unavailable",
  );
}

function workerRuntimeError(event) {
  const detail = String(event?.message || "").trim();
  const outOfMemory = /out of memory|memory limit|内存/iu.test(detail);
  return workerError(
    outOfMemory
      ? "Automapping Worker 内存不足并已停止；本次派生结果未应用，基础编辑、地图保存仍可继续"
      : `Automapping Worker 意外停止${detail ? `：${detail}` : ""}；本次派生结果未应用，基础编辑、地图保存仍可继续`,
    outOfMemory ? "automap-worker-out-of-memory" : "automap-worker-failed",
  );
}

function workerError(message, code = "automap-worker-failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}
