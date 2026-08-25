import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const ACTIVE_STATUSES = new Set([
  "queued", "preparing", "provider", "postprocessing", "committing", "canceling",
]);
const RUNNING_STATUSES = new Set(["preparing", "provider", "postprocessing", "committing", "canceling"]);
const FINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const WORKER_PHASES = new Set(["preparing", "provider", "postprocessing", "committing"]);
const MAX_RECORDS = 2_000;

export class ImageExecutionQueue extends EventEmitter {
  constructor({ settingsStore, runner, now = () => Date.now() } = {}) {
    super();
    if (!settingsStore?.snapshot || !settingsStore?.taskSnapshot) {
      throw new TypeError("Image execution settings store is required");
    }
    if (typeof runner !== "function") throw new TypeError("Image worker runner is required");
    this.settingsStore = settingsStore;
    this.runner = runner;
    this.now = now;
    this.jobs = [];
    this.running = new Map();
    this.pumping = false;
    this.pumpRequested = false;
    this.closed = false;
  }

  enqueue(input, { signal = null, onEvent = null } = {}) {
    if (this.closed) throw queueError(503, "IMAGE_QUEUE_CLOSED", "图片执行队列已关闭");
    assertAbortSignal(signal);
    if (signal?.aborted) throw canceledError();
    const identity = normalizeIdentity(input?.identity);
    const payload = cloneJsonPayload(input?.payload);
    const current = this.settingsStore.snapshot();
    if (!current.acceptNewTasks) {
      throw queueError(503, "IMAGE_QUEUE_PAUSED", "管理员已暂停接收新的图片任务");
    }
    if (current.config?.worker?.enabled !== true) {
      throw queueError(503, "IMAGE_WORKER_DISABLED", "图片 Worker 当前已由管理员关闭");
    }
    const settings = this.settingsStore.taskSnapshot();
    this.assertQueueCapacity(identity.userId, settings.config.worker);
    const createdAt = this.now();
    let resolveResult;
    let rejectResult;
    const promise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const job = {
      id: crypto.randomBytes(18).toString("hex"),
      identity,
      payload: deepFreeze(payload),
      settings,
      status: "queued",
      phase: "queued",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      error: null,
      result: null,
      signal,
      abortListener: null,
      onEvent: typeof onEvent === "function" ? onEvent : null,
      resolveResult,
      rejectResult,
      settled: false,
    };
    job.abortListener = () => this.abortJob(job);
    signal?.addEventListener("abort", job.abortListener, { once: true });
    this.jobs.push(job);
    this.prune();
    this.emitChange(job);
    this.kick();
    return { id: job.id, job: publicJob(job), promise };
  }

  cancel(jobId, { userId = null } = {}) {
    const job = this.requireJob(jobId, userId);
    if (FINAL_STATUSES.has(job.status)) return { accepted: false, job: publicJob(job) };
    return { accepted: this.abortJob(job), job: publicJob(job) };
  }

  cancelForIdentity(identity) {
    const normalized = normalizeIdentity(identity);
    return this.cancelMatching((job) => sameIdentity(job.identity, normalized));
  }

  cancelForSession({ userId, browserSessionId } = {}) {
    const normalized = normalizeIdentity({
      userId,
      browserSessionId,
      credentialKind: "browser",
    });
    return this.cancelMatching((job) => (
      job.identity.userId === normalized.userId
      && job.identity.credentialKind === "browser"
      && job.identity.browserSessionId === normalized.browserSessionId
    ));
  }

  snapshot(jobId, { userId = null } = {}) {
    return publicJob(this.requireJob(jobId, userId));
  }

  list({ userId = null } = {}) {
    return this.jobs
      .filter((job) => userId == null || job.identity.userId === String(userId))
      .map(publicJob);
  }

  status() {
    const settings = this.settingsStore.snapshot();
    return {
      enabled: settings.config.worker.enabled,
      accepting: settings.acceptNewTasks,
      preset: settings.preset,
      settingsRevision: settings.revision,
      workerCount: this.running.size,
      queueLength: this.jobs.filter((job) => job.status === "queued").length,
      running: this.running.size,
      reservedMemoryMb: this.reservedMemoryMb(),
    };
  }

  kick() {
    if (this.closed) return;
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    queueMicrotask(() => void this.pump());
  }

  async pump() {
    if (this.closed || this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpRequested = false;
        while (true) {
          const job = this.jobs.find((entry) => entry.status === "queued");
          if (!job || !this.canStart(job)) break;
          this.launch(job);
        }
      } while (this.pumpRequested);
    } finally {
      this.pumping = false;
      if (this.pumpRequested && !this.closed) this.kick();
    }
  }

  canStart(job) {
    const worker = job.settings.config.worker;
    if (this.running.size >= worker.concurrency) return false;
    if (this.runningForUser(job.identity.userId) >= worker.perUserConcurrency) return false;
    return this.reservedMemoryMb() + worker.memoryMb <= worker.totalMemoryMb;
  }

  launch(job) {
    if (job.status !== "queued" || job.settled) return;
    const controller = new AbortController();
    const startedAt = this.now();
    job.status = "preparing";
    job.phase = "preparing";
    job.startedAt = startedAt;
    job.updatedAt = startedAt;
    const running = { controller, job, completion: null };
    this.running.set(job.id, running);
    this.emitChange(job);
    running.completion = (async () => {
      try {
        const result = await this.runner(internalJob(job), {
          signal: controller.signal,
          onEvent: (event) => this.handleRunnerEvent(job, event),
        });
        this.settle(job, { status: "succeeded", result });
      } catch (error) {
        const canceled = controller.signal.aborted || error?.code === "IMAGE_TASK_CANCELED";
        this.settle(job, {
          status: canceled ? "canceled" : "failed",
          error: canceled ? canceledError() : error,
        });
      } finally {
        this.running.delete(job.id);
        this.emitChange(job);
        this.kick();
      }
    })();
  }

  handleRunnerEvent(job, event) {
    if (!event || typeof event !== "object" || job.settled) return undefined;
    if (event.type === "phase" && WORKER_PHASES.has(event.phase)) {
      job.phase = event.phase;
      job.status = event.phase;
      job.updatedAt = this.now();
      this.emitChange(job);
    }
    if (job.onEvent) {
      try {
        return Promise.resolve(job.onEvent(structuredClone(event)));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return undefined;
  }

  abortJob(job) {
    if (job.settled || FINAL_STATUSES.has(job.status) || job.status === "canceling") return false;
    if (job.status === "queued") {
      this.settle(job, { status: "canceled", error: canceledError() });
      this.emitChange(job);
      this.kick();
      return true;
    }
    job.status = "canceling";
    job.phase = "canceling";
    job.updatedAt = this.now();
    this.running.get(job.id)?.controller.abort();
    this.emitChange(job);
    return true;
  }

  cancelMatching(predicate) {
    const jobs = [];
    for (const job of this.jobs) {
      if (!predicate(job) || !this.abortJob(job)) continue;
      jobs.push(publicJob(job));
    }
    return { canceled: jobs.length, jobs };
  }

  settle(job, { status, result = null, error = null }) {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener("abort", job.abortListener);
    const completedAt = this.now();
    job.status = status;
    job.phase = status;
    job.updatedAt = completedAt;
    job.completedAt = completedAt;
    job.error = error ? publicError(error) : null;
    job.result = status === "succeeded" ? publicResult(result) : null;
    job.payload = null;
    job.onEvent = null;
    if (status === "succeeded") job.resolveResult(result);
    else job.rejectResult(error || queueError(500, "IMAGE_TASK_FAILED", "图片任务执行失败"));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs) {
      if (job.status === "queued") {
        this.settle(job, {
          status: "interrupted",
          error: queueError(503, "IMAGE_QUEUE_CLOSED", "服务关闭，图片任务已中断"),
        });
      }
    }
    for (const running of this.running.values()) {
      running.job.status = "canceling";
      running.job.phase = "canceling";
      running.controller.abort();
    }
    await Promise.allSettled([...this.running.values()].map((entry) => entry.completion));
    this.emitChange();
  }

  assertQueueCapacity(userId, worker) {
    const queued = this.jobs.filter((job) => job.status === "queued");
    if (queued.length >= worker.queueLimit) {
      throw queueError(429, "IMAGE_QUEUE_FULL", "图片执行排队任务已达到管理员设置的上限");
    }
    if (queued.filter((job) => job.identity.userId === userId).length >= worker.perUserQueueLimit) {
      throw queueError(429, "IMAGE_USER_QUEUE_FULL", "当前账号的图片排队任务已达到管理员设置的上限");
    }
  }

  runningForUser(userId) {
    let count = 0;
    for (const entry of this.running.values()) {
      if (entry.job.identity.userId === userId) count += 1;
    }
    return count;
  }

  reservedMemoryMb() {
    let total = 0;
    for (const entry of this.running.values()) total += entry.job.settings.config.worker.memoryMb;
    return total;
  }

  requireJob(jobId, userId) {
    const id = String(jobId || "");
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job || (userId != null && job.identity.userId !== String(userId))) {
      throw queueError(404, "IMAGE_JOB_NOT_FOUND", "图片任务不存在");
    }
    return job;
  }

  prune() {
    if (this.jobs.length <= MAX_RECORDS) return;
    const active = this.jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    const final = this.jobs.filter((job) => !ACTIVE_STATUSES.has(job.status));
    this.jobs = [...final.slice(Math.max(0, final.length - (MAX_RECORDS - active.length))), ...active];
  }

  emitChange(job = null) {
    this.emit("change", { job: job ? publicJob(job) : null, status: this.status() });
  }
}

function internalJob(job) {
  return {
    id: job.id,
    identity: structuredClone(job.identity),
    payload: job.payload,
    settings: job.settings,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    identity: publicIdentity(job.identity),
    status: job.status,
    phase: job.phase,
    settingsRevision: job.settings.revision,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    error: job.error ? structuredClone(job.error) : null,
    result: job.result ? structuredClone(job.result) : null,
  };
}

function publicResult(result) {
  if (!result || typeof result !== "object") return null;
  const files = Array.isArray(result.files)
    ? result.files.map((file) => ({
        path: boundedText(file?.path, 1_024),
        size: Number.isSafeInteger(file?.size) ? file.size : null,
        sha256: /^[a-f0-9]{64}$/u.test(file?.sha256 || "") ? file.sha256 : null,
        mediaType: boundedText(file?.mediaType, 100),
      }))
    : [];
  return { files };
}

function publicError(error) {
  const result = {
    code: boundedText(error?.code || "IMAGE_TASK_FAILED", 100) || "IMAGE_TASK_FAILED",
    message: boundedText(error?.message || "图片任务执行失败", 1_000) || "图片任务执行失败",
    statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 500,
    retryable: error?.retryable === true,
  };
  for (const field of ["providerRequestId", "requestId", "type"]) {
    const value = boundedText(error?.[field], 200);
    if (value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) result[field] = value;
  }
  for (const field of ["stage", "operation", "reason"]) {
    const value = boundedText(error?.[field], 100);
    if (value && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) result[field] = value;
  }
  const model = boundedText(error?.model, 200);
  if (model && !/[\u0000-\u001f\u007f]/u.test(model)) result.model = model;
  for (const field of ["requestedSize", "providerSize", "sourceSize"]) {
    const value = boundedText(error?.[field], 32);
    if (value && /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value)) result[field] = value;
  }
  if (["strict", "soft"].includes(error?.maskMode)) result.maskMode = error.maskMode;
  if (["exact", "seamless"].includes(error?.preserveSource)) result.preserveSource = error.preserveSource;
  if (["reject", "pad-and-crop", "rescale-and-crop"].includes(error?.alignmentPolicy)) {
    result.alignmentPolicy = error.alignmentPolicy;
  }
  if (typeof error?.customSize === "boolean") result.customSize = error.customSize;
  if (Array.isArray(error?.supportedSizes)) {
    result.supportedSizes = [...new Set(error.supportedSizes
      .map((value) => boundedText(value, 32))
      .filter((value) => /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value || "")))]
      .slice(0, 64);
  }
  for (const field of ["requestedFormat", "actualFormat", "outputFormat"]) {
    if (["png", "jpeg", "webp"].includes(error?.[field])) result[field] = error[field];
  }
  if (Number.isSafeInteger(error?.providerStatusCode) && error.providerStatusCode >= 400 && error.providerStatusCode <= 599) {
    result.providerStatusCode = error.providerStatusCode;
  }
  for (const field of ["requestedWidth", "requestedHeight", "actualWidth", "actualHeight"]) {
    if (Number.isSafeInteger(error?.[field]) && error[field] >= 1 && error[field] <= 100_000) result[field] = error[field];
  }
  for (const field of ["requestedCount", "actualCount"]) {
    if (Number.isSafeInteger(error?.[field]) && error[field] >= 0 && error[field] <= 10_000) result[field] = error[field];
  }
  if (Number.isSafeInteger(error?.outputCompression) && error.outputCompression >= 0 && error.outputCompression <= 100) {
    result.outputCompression = error.outputCompression;
  }
  if (error?.moderationDetails && typeof error.moderationDetails === "object") {
    result.moderationDetails = structuredClone(error.moderationDetails);
  }
  return result;
}

function normalizeIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw queueError(400, "INVALID_IMAGE_IDENTITY", "图片任务身份无效");
  }
  const userId = boundedText(value.userId, 200);
  if (!userId) throw queueError(400, "INVALID_IMAGE_IDENTITY", "图片任务必须指定用户");
  const browserSessionId = boundedText(value.browserSessionId, 200) || null;
  const inferredCredentialKind = browserSessionId ? "browser" : "non-browser";
  const credentialKind = boundedText(value.credentialKind, 32) || inferredCredentialKind;
  if (!new Set(["browser", "non-browser"]).has(credentialKind) || credentialKind !== inferredCredentialKind) {
    throw queueError(400, "INVALID_IMAGE_IDENTITY", "图片任务凭据类型与浏览器会话不匹配");
  }
  return {
    userId,
    credentialKind,
    browserSessionId,
    clientOperationId: boundedText(value.clientOperationId, 200) || null,
  };
}

function sameIdentity(left, right) {
  return left.userId === right.userId
    && left.credentialKind === right.credentialKind
    && left.browserSessionId === right.browserSessionId
    && left.clientOperationId === right.clientOperationId;
}

function publicIdentity(identity) {
  return {
    userId: identity.userId,
    credentialKind: identity.credentialKind,
  };
}

function cloneJsonPayload(value) {
  validateJsonValue(value, new Set());
  return structuredClone(value);
}

function validateJsonValue(value, ancestors) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || value instanceof Uint8Array) {
    throw queueError(400, "INVALID_IMAGE_TASK_PAYLOAD", "图片任务只能通过任务目录传递图片字节");
  }
  if (ancestors.has(value)) throw queueError(400, "INVALID_IMAGE_TASK_PAYLOAD", "图片任务参数不能循环引用");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validateJsonValue(child, ancestors);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw queueError(400, "INVALID_IMAGE_TASK_PAYLOAD", "图片任务参数必须是普通 JSON 对象");
    }
    for (const child of Object.values(value)) validateJsonValue(child, ancestors);
  }
  ancestors.delete(value);
}

function assertAbortSignal(value) {
  if (value == null) return;
  if (
    typeof value !== "object"
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function"
  ) throw queueError(400, "INVALID_ABORT_SIGNAL", "图片任务取消信号无效");
}

function canceledError() {
  return queueError(499, "IMAGE_TASK_CANCELED", "图片任务已取消");
}

function queueError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, retryable: false });
}

function boundedText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maximum) : null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const IMAGE_EXECUTION_ACTIVE_STATUSES = deepFreeze([...ACTIVE_STATUSES]);
export const IMAGE_EXECUTION_RUNNING_STATUSES = deepFreeze([...RUNNING_STATUSES]);
