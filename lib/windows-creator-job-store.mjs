import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const MAX_RECORDS = 2_000;

export class WindowsCreatorJobStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.storePath = path.join(stateDirectory, "windows-creator-jobs.json");
    this.now = now;
    this.jobs = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    this.jobs = await this.readStore();
    if (writeOnInitialize) await this.interruptActive("服务重启，任务未自动重放");
    return this;
  }

  async interruptActive(summary, { userId = null, deviceId = null } = {}) {
    return this.mutate(async () => {
      const normalizedUserId = userId === null ? null : opaqueId(userId, "userId");
      const normalizedDeviceId = deviceId === null ? null : opaqueId(deviceId, "deviceId");
      const interruptedAt = this.now();
      let changed = 0;
      for (const job of this.jobs) {
        if (!ACTIVE_STATUSES.has(job.status)) continue;
        if (normalizedUserId && job.userId !== normalizedUserId) continue;
        if (normalizedDeviceId && job.deviceId !== normalizedDeviceId) continue;
        job.status = "interrupted";
        job.updatedAt = interruptedAt;
        job.completedAt = interruptedAt;
        job.result = { summary: boundedText(summary, "Job 摘要", 1, 500), outputPath: null };
        changed += 1;
      }
      if (changed) await this.writeStore();
      return changed;
    });
  }

  snapshot(userId) {
    const normalizedUserId = opaqueId(userId, "userId");
    return {
      jobs: this.jobs.filter((job) => job.userId === normalizedUserId).map(publicJob),
    };
  }

  async begin(context, request) {
    return this.mutate(async () => {
      const normalizedContext = normalizeContext(context);
      const normalizedRequest = normalizeRequest(request);
      const requestHash = stableHash(normalizedRequest);
      const existing = this.jobs.find((job) => sameJobKey(job, normalizedContext, normalizedRequest.jobId));
      if (existing) {
        if (existing.requestHash !== requestHash) throw jobError(409, "相同 Job ID 已用于不同任务");
        return { created: false, job: publicJob(existing) };
      }
      const now = this.now();
      const job = {
        ...normalizedContext,
        jobId: normalizedRequest.jobId,
        kind: normalizedRequest.kind,
        workspacePath: normalizedRequest.workspacePath,
        requestHash,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        result: null,
      };
      this.jobs.unshift(job);
      this.prune();
      await this.writeStore();
      return { created: true, job: publicJob(job) };
    });
  }

  async markRunning(context, jobId) {
    return this.transition(context, jobId, (job) => {
      if (job.status !== "queued") return false;
      job.status = "running";
      job.startedAt = this.now();
      job.updatedAt = job.startedAt;
      return true;
    });
  }

  async finish(context, jobId, { status, summary, outputPath = null }) {
    if (!new Set(["succeeded", "failed", "canceled"]).has(status)) throw jobError(400, "Job 终态不正确");
    const result = {
      summary: boundedText(summary, "Job 摘要", 1, 500),
      outputPath: outputPath === null ? null : relativePath(outputPath),
    };
    return this.transition(context, jobId, (job) => {
      if (FINAL_STATUSES.has(job.status)) return false;
      const now = this.now();
      job.status = status;
      job.result = result;
      job.updatedAt = now;
      job.completedAt = now;
      return true;
    });
  }

  async transition(context, jobId, update) {
    return this.mutate(async () => {
      const normalizedContext = normalizeContext(context);
      const normalizedJobId = opaqueId(jobId, "jobId");
      const job = this.jobs.find((entry) => sameJobKey(entry, normalizedContext, normalizedJobId));
      if (!job) return { accepted: false, job: null };
      if (!sameExecutionContext(job, normalizedContext)) return { accepted: false, job: publicJob(job) };
      const accepted = update(job);
      if (accepted) await this.writeStore();
      return { accepted, job: publicJob(job) };
    });
  }

  prune() {
    if (this.jobs.length <= MAX_RECORDS) return;
    const active = this.jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    const final = this.jobs.filter((job) => !ACTIVE_STATUSES.has(job.status));
    this.jobs = [...active, ...final.slice(0, Math.max(0, MAX_RECORDS - active.length))];
  }

  async readStore() {
    try {
      const value = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (value?.version !== STORE_VERSION || !Array.isArray(value.jobs)) throw new Error("unsupported state format");
      return value.jobs.map(normalizeStoredJob);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取 Creator Job 状态: ${error.message}`);
      return [];
    }
  }

  async writeStore() {
    const content = `${JSON.stringify({ version: STORE_VERSION, jobs: this.jobs }, null, 2)}\n`;
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, this.storePath);
    await fs.chmod(this.storePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }
}

function publicJob(job) {
  return {
    userId: job.userId,
    deviceId: job.deviceId,
    deviceEpoch: job.deviceEpoch,
    threadId: job.threadId,
    leaseEpoch: job.leaseEpoch,
    jobId: job.jobId,
    kind: job.kind,
    workspacePath: job.workspacePath,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result ? { ...job.result } : null,
  };
}

function normalizeStoredJob(value) {
  const status = String(value?.status || "");
  if (!ACTIVE_STATUSES.has(status) && !FINAL_STATUSES.has(status)) throw new Error("invalid job status");
  const requestHash = String(value?.requestHash || "");
  if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("invalid job request hash");
  return {
    ...normalizeContext(value),
    jobId: opaqueId(value?.jobId, "jobId"),
    kind: boundedText(value?.kind, "Job 类型", 1, 80),
    workspacePath: relativePath(value?.workspacePath, true),
    requestHash,
    status,
    createdAt: timestamp(value?.createdAt, "createdAt"),
    updatedAt: timestamp(value?.updatedAt, "updatedAt"),
    startedAt: nullableTimestamp(value?.startedAt, "startedAt"),
    completedAt: nullableTimestamp(value?.completedAt, "completedAt"),
    result: value?.result === null ? null : normalizeResult(value?.result),
  };
}

function normalizeContext(value) {
  const deviceEpoch = Number(value?.deviceEpoch);
  const leaseEpoch = Number(value?.leaseEpoch);
  if (!Number.isSafeInteger(deviceEpoch) || deviceEpoch < 1 || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
    throw jobError(400, "设备 Job 上下文不正确");
  }
  return {
    userId: opaqueId(value?.userId, "userId"),
    deviceId: opaqueId(value?.deviceId, "deviceId"),
    deviceEpoch,
    threadId: opaqueId(value?.threadId, "threadId"),
    leaseEpoch,
  };
}

function normalizeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw jobError(400, "Job 请求不正确");
  return {
    jobId: opaqueId(value.jobId, "jobId"),
    kind: boundedText(value.kind, "Job 类型", 1, 80),
    workspacePath: relativePath(value.workspacePath, true),
    spec: canonicalValue(value.spec),
  };
}

function normalizeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid job result");
  return {
    summary: boundedText(value.summary, "Job 摘要", 1, 500),
    outputPath: value.outputPath === null ? null : relativePath(value.outputPath),
  };
}

function sameJobKey(job, context, jobId) {
  return job.userId === context.userId && job.deviceId === context.deviceId && job.jobId === jobId;
}

function sameExecutionContext(job, context) {
  return job.deviceEpoch === context.deviceEpoch
    && job.threadId === context.threadId
    && job.leaseEpoch === context.leaseEpoch;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalValue(value, depth = 0) {
  if (depth > 20) throw jobError(400, "Job 规格嵌套过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value, "Job 规格文本", 0, 100_000);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jobError(400, "Job 规格数字不正确");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw jobError(400, "Job 规格数组过大");
    return value.map((entry) => canonicalValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") throw jobError(400, "Job 规格值不正确");
  const keys = Object.keys(value).sort();
  if (keys.length > 1_000) throw jobError(400, "Job 规格字段过多");
  return Object.fromEntries(keys.map((key) => [boundedText(key, "Job 规格字段", 1, 100), canonicalValue(value[key], depth + 1)]));
}

function relativePath(value, allowRoot = false) {
  const input = String(value ?? "").trim().replaceAll("\\", "/");
  if (allowRoot && (input === "" || input === ".")) return ".";
  const segments = input.split("/");
  if (!input || input.length > 512 || input.startsWith("/") || /^[A-Za-z]:/.test(input)
      || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f:*?"<>|]/.test(segment))) {
    throw jobError(400, "Job 工作区路径不正确");
  }
  return segments.join("/");
}

function opaqueId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw jobError(400, `${label} 不正确`);
  return id;
}

function boundedText(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\u0000")) {
    throw jobError(400, `${label}不正确`);
  }
  return value;
}

function timestamp(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid ${label}`);
  return number;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function jobError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
