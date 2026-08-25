import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const ACTIVE_STATUSES = new Set(["queued", "running", "canceling"]);
const FINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const PREVIEW_CAPTURE_KIND = "preview-capture";
const MAP_SCREENSHOT_KINDS = new Set(["map-screenshot", "game-screenshot"]);
const SCREENSHOT_KINDS = new Set([...MAP_SCREENSHOT_KINDS, PREVIEW_CAPTURE_KIND]);
const RENDER_KINDS = new Set([
  ...MAP_SCREENSHOT_KINDS,
  "map-panorama",
  "map-tiles",
  "map-animation",
  "map-video",
  "map-batch",
]);
const RESERVED_OUTPUT_SEGMENTS = new Set([
  ".git",
  ".codex-desktop",
  ".codex-runtime",
  ".codex-uploads",
  ".codex-trash",
]);
const MAX_RECORDS = 2_000;
const MAX_BROWSER_DIMENSION = 32_767;

export class MapRenderJobStore extends EventEmitter {
  constructor(stateDirectory, {
    settingsStore,
    runner,
    authorize = async () => {},
    now = () => Date.now(),
  } = {}) {
    super();
    if (!settingsStore?.snapshot || !settingsStore?.taskSnapshot) {
      throw new TypeError("Map render settings store is required");
    }
    if (typeof runner !== "function") throw new TypeError("Map render runner is required");
    this.filePath = path.join(path.resolve(stateDirectory), "map-render-jobs.json");
    this.settingsStore = settingsStore;
    this.runner = runner;
    this.authorize = authorize;
    this.now = now;
    this.jobs = [];
    this.previewCaptures = [];
    this.running = new Map();
    this.writeQueue = Promise.resolve();
    this.pumping = false;
    this.pumpRequested = false;
    this.closed = false;
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.jobs = await this.readStore();
    const interruptedAt = this.now();
    let changed = false;
    for (const job of this.jobs) {
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      job.status = "interrupted";
      job.updatedAt = interruptedAt;
      job.completedAt = interruptedAt;
      job.error = { code: "server-restarted", message: "服务重启，渲染任务未自动重放" };
      changed = true;
    }
    if (writeOnInitialize && (changed || !await fileExists(this.filePath))) await this.writeStore();
    return this;
  }

  async begin(input) {
    if (this.closed) throw jobError(503, "地图渲染队列已关闭");
    const identity = normalizeIdentity(input?.identity);
    const mapContext = normalizeMapContext(input?.mapContext);
    const request = normalizeRenderRequest(input?.request);
    const requestHash = stableHash({ mapContext, request });
    const result = await this.mutate(async () => {
      const existing = this.jobs.find((job) => (
        job.identity.userId === identity.userId
        && job.identity.browserSessionId === identity.browserSessionId
        && job.clientOperationId === request.clientOperationId
      ));
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw jobError(409, "相同地图渲染操作编号已用于不同任务");
        }
        return { created: false, job: publicJob(existing) };
      }
      const settings = this.settingsStore.snapshot();
      if (!settings.acceptNewTasks) throw jobError(503, "管理员已暂停接收新的地图渲染任务");
      if (!settings.config.worker.enabled) throw jobError(503, "地图 Render Worker 当前已由管理员关闭");
      const taskSettings = this.settingsStore.taskSnapshot();
      this.assertQueueCapacity(taskSettings.config.worker.queueLimit);
      const createdAt = this.now();
      const job = {
        id: crypto.randomBytes(18).toString("base64url"),
        identity,
        mapContext,
        clientOperationId: request.clientOperationId,
        requestHash,
        kind: request.kind,
        outputRoot: request.outputRoot,
        spec: request.spec,
        settings: structuredClone(taskSettings),
        status: "queued",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
      };
      this.jobs.push(job);
      this.prune();
      await this.writeStore();
      return { created: true, job: publicJob(job) };
    });
    this.emitChange();
    this.kick();
    return result;
  }

  capturePreview(input, { signal } = {}) {
    if (this.closed) throw jobError(503, "地图渲染队列已关闭");
    const settings = this.settingsStore.snapshot();
    if (!settings.acceptNewTasks) throw jobError(503, "管理员已暂停接收新的地图渲染任务");
    if (!settings.config.worker.enabled) throw jobError(503, "地图 Render Worker 当前已由管理员关闭");
    const identity = normalizeIdentity(input?.identity);
    const capture = normalizePreviewCapture(input?.capture);
    this.assertQueueCapacity(settings.config.worker.queueLimit);
    const createdAt = this.now();
    const job = {
      id: crypto.randomBytes(18).toString("base64url"),
      identity,
      kind: PREVIEW_CAPTURE_KIND,
      capture,
      settings: structuredClone(this.settingsStore.taskSnapshot()),
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      signal,
      abortListener: null,
      settled: false,
      resolve: null,
      reject: null,
    };
    const result = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.abortListener = () => this.abortPreviewCapture(job);
    this.previewCaptures.push(job);
    if (signal?.aborted) job.abortListener();
    else signal?.addEventListener("abort", job.abortListener, { once: true });
    this.emitChange();
    this.kick();
    return result;
  }

  snapshot(input) {
    const identity = normalizeIdentity(input?.identity);
    const job = this.requireJob(input?.jobId, identity);
    return publicJob(job);
  }

  list(input) {
    const identity = normalizeIdentity(input?.identity);
    const limit = boundedInteger(input?.limit, 100, 1, 500);
    return this.jobs
      .filter((job) => sameIdentity(job.identity, identity))
      .slice(-limit)
      .reverse()
      .map(publicJob);
  }

  outputFile(input) {
    const identity = normalizeIdentity(input?.identity);
    const job = this.requireJob(input?.jobId, identity);
    if (job.status !== "succeeded" || !job.result) {
      throw jobError(409, "地图渲染任务尚未成功完成");
    }
    const requestedPath = String(input?.filePath || "");
    if (!requestedPath) throw jobError(400, "地图渲染输出文件路径不正确");
    const filePath = normalizeOutputRoot(requestedPath);
    const file = job.result.files.find((entry) => entry.path === filePath);
    if (!file) throw jobError(404, "地图渲染输出文件不存在");
    return {
      projectPath: job.mapContext.projectPath,
      outputDirectory: job.result.outputDirectory,
      file: { ...file },
    };
  }

  outputDirectory(input) {
    const identity = normalizeIdentity(input?.identity);
    const job = this.requireJob(input?.jobId, identity);
    if (job.status !== "succeeded" || !job.result) {
      throw jobError(409, "地图渲染任务尚未成功完成");
    }
    return {
      projectPath: job.mapContext.projectPath,
      outputDirectory: job.result.outputDirectory,
    };
  }

  async cancel(input) {
    const identity = normalizeIdentity(input?.identity);
    const result = await this.mutate(async () => {
      const job = this.requireJob(input?.jobId, identity);
      if (FINAL_STATUSES.has(job.status)) return { accepted: false, job: publicJob(job) };
      if (job.status === "queued") {
        const now = this.now();
        job.status = "canceled";
        job.updatedAt = now;
        job.completedAt = now;
        job.error = { code: "user-canceled", message: "用户取消了地图渲染任务" };
        await this.writeStore();
        return { accepted: true, job: publicJob(job) };
      }
      if (job.status === "running") {
        job.status = "canceling";
        job.updatedAt = this.now();
        await this.writeStore();
        return { accepted: true, job: publicJob(job) };
      }
      return { accepted: false, job: publicJob(job) };
    });
    if (result.accepted) this.running.get(String(input?.jobId || ""))?.abortController.abort();
    this.emitChange();
    this.kick();
    return result;
  }

  async cancelForBrowserSession({ userId, browserSessionId } = {}) {
    const browser = normalizeBrowserIdentity({ userId, browserSessionId });
    const jobs = this.jobs.filter((job) => (
      sameBrowser(job.identity, browser) && ACTIVE_STATUSES.has(job.status)
    ));
    const previews = this.previewCaptures.filter((job) => (
      sameBrowser(job.identity, browser) && !job.settled
    ));
    for (const job of jobs) await this.cancel({ jobId: job.id, identity: job.identity });
    for (const job of previews) this.abortPreviewCapture(job);
    return Object.freeze({ canceled: jobs.length + previews.length });
  }

  async cancelForUser({ userId } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    const jobs = this.jobs.filter((job) => (
      job.identity.userId === normalizedUserId && ACTIVE_STATUSES.has(job.status)
    ));
    const previews = this.previewCaptures.filter((job) => (
      job.identity.userId === normalizedUserId && !job.settled
    ));
    for (const job of jobs) await this.cancel({ jobId: job.id, identity: job.identity });
    for (const job of previews) this.abortPreviewCapture(job);
    return Object.freeze({ canceled: jobs.length + previews.length });
  }

  status() {
    const settings = this.settingsStore.snapshot();
    const workerStatus = typeof this.runner.status === "function" ? this.runner.status() : null;
    return {
      enabled: settings.config.worker.enabled,
      accepting: settings.acceptNewTasks,
      preset: settings.preset,
      settingsRevision: settings.revision,
      workerCount: Number.isSafeInteger(workerStatus?.workerCount)
        ? workerStatus.workerCount
        : this.running.size,
      queueLength: this.jobs.filter((job) => job.status === "queued").length
        + this.previewCaptures.filter((job) => job.status === "queued").length,
      running: this.running.size,
      screenshotRunning: this.runningScreenshotCount(),
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
        const settings = this.settingsStore.snapshot();
        if (!settings.config.worker.enabled) break;
        while (true) {
          const next = this.nextQueuedTask();
          if (!next) break;
          const worker = next.job.settings.config.worker;
          if (this.running.size >= worker.renderConcurrency) break;
          if (SCREENSHOT_KINDS.has(next.job.kind) && this.runningScreenshotCount() >= worker.screenshotConcurrency) {
            break;
          }
          if (next.transient) {
            this.launchPreviewCapture(next.job);
            continue;
          }
          const started = await this.markRunning(next.job.id);
          if (!started) continue;
          this.launch(started);
        }
      } while (this.pumpRequested);
    } finally {
      this.pumping = false;
      if (this.pumpRequested) this.kick();
    }
  }

  async markRunning(jobId) {
    return this.mutate(async () => {
      const job = this.jobs.find((entry) => entry.id === jobId);
      if (!job || job.status !== "queued") return null;
      const now = this.now();
      job.status = "running";
      job.startedAt = now;
      job.updatedAt = now;
      await this.writeStore();
      this.emitChange();
      return job;
    });
  }

  launch(job) {
    const abortController = new AbortController();
    this.running.set(job.id, { abortController, job });
    void (async () => {
      try {
        await this.authorize(internalJob(job));
        const result = await this.runner(internalJob(job), { signal: abortController.signal });
        if (abortController.signal.aborted) throw canceledJobError();
        await this.finish(job.id, {
          status: "succeeded",
          result: normalizeResult(result),
        });
      } catch (error) {
        const canceled = abortController.signal.aborted;
        await this.finish(job.id, {
          status: canceled ? "canceled" : "failed",
          error: {
            code: boundedText(canceled ? "user-canceled" : (error?.code || "render-failed"), 1, 100),
            message: boundedText(
              canceled ? "用户取消了地图渲染任务" : (error?.message || "地图渲染失败"),
              1,
              1_000,
            ),
          },
        });
      } finally {
        this.running.delete(job.id);
        this.emitChange();
        this.kick();
      }
    })();
  }

  async finish(jobId, update) {
    await this.mutate(async () => {
      const job = this.jobs.find((entry) => entry.id === jobId);
      if (!job || FINAL_STATUSES.has(job.status)) return;
      const now = this.now();
      job.status = update.status;
      job.updatedAt = now;
      job.completedAt = now;
      job.result = update.result || null;
      job.error = update.error || null;
      await this.writeStore();
    });
  }

  async close(message = "服务关闭，地图渲染任务已中断") {
    this.closed = true;
    for (const running of this.running.values()) running.abortController.abort();
    for (const job of [...this.previewCaptures]) {
      this.settlePreviewCapture(job, previewCaptureError(
        Object.assign(new Error("服务关闭，项目截图任务已中断"), { code: "service-stopped" }),
      ));
    }
    await this.mutate(async () => {
      const now = this.now();
      let changed = false;
      for (const job of this.jobs) {
        if (!ACTIVE_STATUSES.has(job.status)) continue;
        job.status = "interrupted";
        job.updatedAt = now;
        job.completedAt = now;
        job.error = { code: "service-stopped", message: boundedText(message, 1, 1_000) };
        changed = true;
      }
      if (changed) await this.writeStore();
    });
    this.emitChange();
  }

  runningScreenshotCount() {
    let count = 0;
    for (const running of this.running.values()) {
      if (SCREENSHOT_KINDS.has(running.job?.kind)) count += 1;
    }
    return count;
  }

  assertQueueCapacity(limit) {
    const maximum = boundedInteger(limit, 128, 1, 100_000);
    const queued = this.jobs.filter((job) => job.status === "queued").length
      + this.previewCaptures.filter((job) => job.status === "queued").length;
    if (queued >= maximum) throw jobError(429, "地图渲染排队任务已达到管理员设置的上限");
  }

  nextQueuedTask() {
    const persistent = this.jobs.find((job) => job.status === "queued") || null;
    const transient = this.previewCaptures.find((job) => job.status === "queued") || null;
    if (!persistent) return transient ? { job: transient, transient: true } : null;
    if (!transient) return { job: persistent, transient: false };
    return transient.createdAt < persistent.createdAt
      ? { job: transient, transient: true }
      : { job: persistent, transient: false };
  }

  launchPreviewCapture(job) {
    if (job.status !== "queued" || job.settled) return;
    const abortController = new AbortController();
    const now = this.now();
    job.status = "running";
    job.startedAt = now;
    job.updatedAt = now;
    this.running.set(job.id, { abortController, job });
    this.emitChange();
    void (async () => {
      let result = null;
      let failure = null;
      try {
        result = await this.runner(internalPreviewCapture(job), { signal: abortController.signal });
        if (abortController.signal.aborted) throw canceledPreviewCaptureError();
      } catch (error) {
        failure = previewCaptureError(error);
      } finally {
        this.running.delete(job.id);
        job.completedAt = this.now();
        job.updatedAt = job.completedAt;
        job.status = failure ? "failed" : "succeeded";
        this.settlePreviewCapture(job, failure, result);
        this.emitChange();
        this.kick();
      }
    })();
  }

  abortPreviewCapture(job) {
    if (job.settled) return;
    if (job.status === "running") {
      this.running.get(job.id)?.abortController.abort();
      return;
    }
    this.settlePreviewCapture(job, previewCaptureError(canceledPreviewCaptureError()));
    this.emitChange();
    this.kick();
  }

  settlePreviewCapture(job, error = null, result = null) {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener("abort", job.abortListener);
    const index = this.previewCaptures.indexOf(job);
    if (index >= 0) this.previewCaptures.splice(index, 1);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  requireJob(jobId, identity) {
    const id = String(jobId || "");
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job || !sameIdentity(job.identity, identity)) throw jobError(404, "地图渲染任务不存在");
    return job;
  }

  prune() {
    if (this.jobs.length <= MAX_RECORDS) return;
    const active = this.jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    const final = this.jobs.filter((job) => !ACTIVE_STATUSES.has(job.status));
    this.jobs = [...final.slice(Math.max(0, final.length - (MAX_RECORDS - active.length))), ...active];
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async readStore() {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (raw?.version !== STORE_VERSION || !Array.isArray(raw.jobs)) throw new Error("unsupported state format");
      return raw.jobs.map(normalizeStoredJob);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`无法读取地图渲染任务状态: ${error.message}`);
    }
  }

  async writeStore() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: STORE_VERSION, jobs: this.jobs }, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  emitChange() {
    this.emit("change", this.status());
  }
}

export function normalizeRenderRequest(value) {
  if (!isRecord(value)) throw jobError(400, "地图渲染请求不正确");
  const kind = String(value.kind || "");
  if (!RENDER_KINDS.has(kind)) throw jobError(400, "地图渲染任务类型不正确");
  const clientOperationId = String(value.clientOperationId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(clientOperationId)) {
    throw jobError(400, "地图渲染操作编号不正确");
  }
  if (value.spec !== undefined && !isRecord(value.spec)) {
    throw jobError(400, "地图渲染参数必须是对象");
  }
  return {
    kind,
    clientOperationId,
    outputRoot: normalizeOutputRoot(value.outputRoot),
    spec: canonicalValue(value.spec ?? {}),
  };
}

function normalizeIdentity(value) {
  return {
    userId: opaqueId(value?.userId, "userId"),
    browserSessionId: opaqueId(value?.browserSessionId, "browserSessionId"),
    editorInstanceId: opaqueId(value?.editorInstanceId, "editorInstanceId"),
  };
}

function normalizeMapContext(value) {
  const projectPath = absolutePath(value?.projectPath, "projectPath");
  const targetPath = absolutePath(value?.targetPath, "targetPath");
  const relative = path.relative(projectPath, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw jobError(400, "地图渲染文件不属于当前工程");
  }
  const version = String(value?.version || "");
  if (!/^[a-f0-9]{64}$/u.test(version)) throw jobError(400, "地图渲染版本不正确");
  return {
    mapSessionId: opaqueId(value?.mapSessionId, "mapSessionId"),
    projectPath,
    targetPath,
    relativePath: relative.split(path.sep).join("/"),
    version,
    writable: value?.writable === true,
  };
}

function normalizeStoredJob(value) {
  const status = String(value?.status || "");
  if (!ACTIVE_STATUSES.has(status) && !FINAL_STATUSES.has(status)) throw new Error("invalid job status");
  const id = String(value?.id || "");
  if (!/^[A-Za-z0-9_-]{20,64}$/u.test(id)) throw new Error("invalid job id");
  const requestHash = String(value?.requestHash || "");
  if (!/^[a-f0-9]{64}$/u.test(requestHash)) throw new Error("invalid request hash");
  return {
    id,
    identity: normalizeIdentity(value?.identity),
    mapContext: normalizeMapContext(value?.mapContext),
    clientOperationId: opaqueId(value?.clientOperationId, "clientOperationId"),
    requestHash,
    kind: normalizeRenderRequest({
      kind: value?.kind,
      clientOperationId: value?.clientOperationId,
      outputRoot: value?.outputRoot,
      spec: value?.spec,
    }).kind,
    outputRoot: normalizeOutputRoot(value?.outputRoot),
    spec: canonicalValue(value?.spec ?? {}),
    settings: canonicalValue(value?.settings || {}),
    status,
    createdAt: timestamp(value?.createdAt, "createdAt"),
    updatedAt: timestamp(value?.updatedAt, "updatedAt"),
    startedAt: nullableTimestamp(value?.startedAt, "startedAt"),
    completedAt: nullableTimestamp(value?.completedAt, "completedAt"),
    result: value?.result === null ? null : normalizeResult(value?.result),
    error: value?.error === null ? null : normalizeError(value?.error),
  };
}

function normalizeResult(value) {
  if (!isRecord(value)) throw jobError(500, "Render Worker 返回结果不正确");
  const files = Array.isArray(value.files) ? value.files.map((file) => ({
    path: normalizeOutputFile(file?.path),
    size: boundedInteger(file?.size, null, 0, Number.MAX_SAFE_INTEGER),
    sha256: hashValue(file?.sha256),
    mediaType: boundedText(file?.mediaType || "application/octet-stream", 1, 200),
  })) : [];
  if (!files.length || files.length > 100_000) throw jobError(500, "Render Worker 输出文件清单不正确");
  return {
    summary: boundedText(value.summary || "地图渲染完成", 1, 1_000),
    outputDirectory: normalizeOutputRoot(value.outputDirectory),
    files,
  };
}

function normalizeError(value) {
  if (!isRecord(value)) throw new Error("invalid job error");
  return {
    code: boundedText(value.code, 1, 100),
    message: boundedText(value.message, 1, 1_000),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    mapSessionId: job.mapContext.mapSessionId,
    mapPath: job.mapContext.relativePath,
    mapVersion: job.mapContext.version,
    kind: job.kind,
    outputRoot: job.outputRoot,
    spec: structuredClone(job.spec),
    settings: structuredClone(job.settings),
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result ? structuredClone(job.result) : null,
    error: job.error ? { ...job.error } : null,
  };
}

function internalJob(job) {
  return structuredClone(job);
}

function internalPreviewCapture(job) {
  return {
    id: job.id,
    identity: structuredClone(job.identity),
    kind: PREVIEW_CAPTURE_KIND,
    capture: structuredClone(job.capture),
    settings: structuredClone(job.settings),
  };
}

function normalizePreviewCapture(value) {
  if (!isRecord(value)) throw jobError(400, "项目截图请求不正确");
  const capture = {
    url: boundedText(value.url, 1, 8_192),
    requestOrigin: boundedText(value.requestOrigin, 1, 512),
    config: canonicalValue(value.config || {}),
    fullPage: value.fullPage === true,
  };
  if (value.width !== undefined) {
    capture.width = previewCaptureDimension(value.width, 320, MAX_BROWSER_DIMENSION, "宽度");
  }
  if (value.height !== undefined) {
    capture.height = previewCaptureDimension(value.height, 240, MAX_BROWSER_DIMENSION, "高度");
  }
  return capture;
}

function previewCaptureDimension(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw jobError(400, `项目截图${label}必须是 ${minimum}-${maximum} 的整数`);
  }
  return number;
}

function previewCaptureError(error) {
  if (error?.statusCode) return error;
  const code = boundedErrorCode(error?.code || "preview-capture-failed");
  const unavailable = code === "preview-capture-unavailable";
  const aborted = code === "ABORT_ERR";
  const stopped = code === "service-stopped";
  return Object.assign(new Error(
    unavailable
      ? (error?.message || "截图组件尚未安装，请先运行安装向导")
      : stopped
        ? (error?.message || "服务关闭，项目截图任务已中断")
        : `项目截图失败：${error?.message || "Render Worker 执行失败"}`,
  ), {
    code,
    statusCode: unavailable || stopped ? 503 : (aborted ? 499 : 502),
  });
}

function canceledJobError() {
  return Object.assign(new Error("用户取消了地图渲染任务"), { code: "user-canceled" });
}

function canceledPreviewCaptureError() {
  return Object.assign(new Error("项目截图请求已取消"), { code: "ABORT_ERR" });
}

function boundedErrorCode(value) {
  const code = String(value || "preview-capture-failed");
  return /^[A-Za-z0-9._-]{1,100}$/u.test(code) ? code : "preview-capture-failed";
}

function normalizeOutputRoot(value) {
  const input = String(value || "map-exports").trim().replaceAll("\\", "/");
  const segments = input.split("/");
  if (
    !input
    || input.length > 512
    || input.startsWith("/")
    || /^[A-Za-z]:/u.test(input)
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || RESERVED_OUTPUT_SEGMENTS.has(segment)
      || segment.startsWith(".codex-")
      || /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment)
    ))
  ) throw jobError(400, "地图渲染输出目录不正确");
  return segments.join("/");
}

function normalizeOutputFile(value) {
  const normalized = normalizeOutputRoot(value);
  if (normalized === "map-exports") throw jobError(500, "Render Worker 输出文件路径不正确");
  return normalized;
}

function canonicalValue(value, depth = 0) {
  if (depth > 20) throw jobError(400, "地图渲染参数嵌套过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value, 0, 100_000);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jobError(400, "地图渲染数字参数不正确");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw jobError(400, "地图渲染参数数组过大");
    return value.map((entry) => canonicalValue(entry, depth + 1));
  }
  if (!isRecord(value)) throw jobError(400, "地图渲染参数值不正确");
  const keys = Object.keys(value).sort();
  if (keys.length > 1_000) throw jobError(400, "地图渲染参数字段过多");
  return Object.fromEntries(keys.map((key) => [
    boundedText(key, 1, 100),
    canonicalValue(value[key], depth + 1),
  ]));
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function sameIdentity(left, right) {
  return left.userId === right.userId
    && left.browserSessionId === right.browserSessionId
    && left.editorInstanceId === right.editorInstanceId;
}

function sameBrowser(left, right) {
  return left.userId === right.userId && left.browserSessionId === right.browserSessionId;
}

function normalizeBrowserIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || !browserSessionId) throw jobError(400, "地图渲染身份不正确");
  return Object.freeze({ userId, browserSessionId });
}

function normalizeUserId(value) {
  const userId = String(value || "");
  if (!userId) throw jobError(400, "地图渲染身份不正确");
  return userId;
}

function opaqueId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw jobError(400, `${label} 不正确`);
  return id;
}

function absolutePath(value, label) {
  const input = String(value || "");
  if (!path.isAbsolute(input) || input.includes("\u0000")) throw jobError(400, `${label} 不正确`);
  return path.resolve(input);
}

function timestamp(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid ${label}`);
  return number;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (Number.isSafeInteger(number) && number >= minimum && number <= maximum) return number;
  if (fallback !== null) return fallback;
  throw jobError(500, "Render Worker 输出大小不正确");
}

function boundedText(value, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\u0000")) {
    throw jobError(400, "地图渲染文本参数不正确");
  }
  return value;
}

function hashValue(value) {
  const hash = String(value || "");
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw jobError(500, "Render Worker 输出哈希不正确");
  return hash;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

function jobError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
