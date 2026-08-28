const DEFAULT_TIMEOUT_MS = 120_000;

export class TiledAiPatchWorkerClient {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || new URL("./tiled-ai-patch-worker.js?v=0.44.63-beta", import.meta.url);
    this.workerFactory = options.workerFactory || ((url) => new Worker(url, { type: "module", name: "wfl-tiled-ai-patch" }));
    this.timeoutMs = timeoutMilliseconds(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.scheduleTimeout = options.setTimeout || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout || ((timer) => globalThis.clearTimeout(timer));
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  prepare(document, patch, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    let worker;
    try {
      worker = this.requireWorker();
    } catch (error) {
      return Promise.reject(workerUnavailableError(error));
    }
    const id = `ai-patch-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const abort = () => this.cancelAll(abortError());
      if (signal) signal.addEventListener("abort", abort, { once: true });
      const pending = { resolve, reject, signal, abort, timer: null };
      this.pending.set(id, pending);
      pending.timer = this.scheduleTimeout(() => {
        this.failWorker(worker, workerError(
          `AI 地图补丁 Worker 超过 ${this.timeoutMs}ms 未完成；本次预计算已停止，地图编辑和保存仍可继续`,
          "ai-patch-worker-timeout",
        ));
      }, this.timeoutMs);
      try {
        worker.postMessage({ type: "prepare", id, document, patch });
      } catch (error) {
        this.failWorker(worker, workerError(
          `无法向 AI 地图补丁 Worker 发送任务：${error?.message || "未知错误"}；地图编辑和保存仍可继续`,
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
    this.cancelAll(abortError("AI 地图补丁 Worker 已关闭"));
  }

  requireWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(this.workerUrl);
    if (!worker || typeof worker.postMessage !== "function" || typeof worker.addEventListener !== "function") {
      try { worker?.terminate?.(); } catch {}
      throw new TypeError("浏览器没有返回可用的 AI 地图补丁 Worker");
    }
    worker.addEventListener("message", (event) => {
      if (this.worker === worker) this.handleMessage(worker, event.data);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      this.failWorker(worker, workerRuntimeError(event));
    });
    worker.addEventListener?.("messageerror", () => this.failWorker(worker, workerError(
      "AI 地图补丁 Worker 返回了无法读取的数据；本次预计算已停止，地图编辑和保存仍可继续",
    )));
    this.worker = worker;
    return worker;
  }

  handleMessage(worker, message) {
    if (!message || typeof message.id !== "string") return;
    if (message.type === "result") {
      try {
        this.settle(message.id, "resolve", normalizePrepared(message.prepared));
      } catch (error) {
        this.failWorker(worker, error);
      }
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.error?.message || "AI 地图补丁预计算失败");
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

function normalizePrepared(value) {
  if (!value || !Array.isArray(value.fillResults) || !Number.isSafeInteger(value.tileCellCount) || value.tileCellCount < 0) {
    throw workerError("AI 地图补丁 Worker 结果格式无效");
  }
  const seen = new Set();
  const fillResults = value.fillResults.map((entry) => {
    const operationIndex = Number(entry?.operationIndex);
    const result = entry?.result;
    if (!Number.isSafeInteger(operationIndex) || operationIndex < 0 || seen.has(operationIndex)) {
      throw workerError("AI 地图补丁 Worker 操作索引无效");
    }
    seen.add(operationIndex);
    if (!(result?.addresses instanceof Int32Array) || result.addresses.length !== Number(result.count) * 2) {
      throw workerError("AI 地图补丁 Worker 填充结果无效");
    }
    return Object.freeze({ operationIndex, result: Object.freeze(result) });
  });
  return Object.freeze({ fillResults: Object.freeze(fillResults), tileCellCount: value.tileCellCount });
}

function abortError(message = "AI 地图补丁预计算已取消") {
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
    `浏览器无法启动 AI 地图补丁 Worker：${error?.message || "未知错误"}；地图编辑和保存仍可继续`,
    "ai-patch-worker-unavailable",
  );
}

function workerRuntimeError(event) {
  const detail = String(event?.message || "").trim();
  const outOfMemory = /out of memory|memory limit|内存/iu.test(detail);
  return workerError(
    outOfMemory
      ? "AI 地图补丁 Worker 内存不足并已停止；补丁未应用，地图编辑和保存仍可继续"
      : `AI 地图补丁 Worker 意外停止${detail ? `：${detail}` : ""}；补丁未应用，地图编辑和保存仍可继续`,
    outOfMemory ? "ai-patch-worker-out-of-memory" : "ai-patch-worker-failed",
  );
}

function workerError(message, code = "ai-patch-worker-failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}
