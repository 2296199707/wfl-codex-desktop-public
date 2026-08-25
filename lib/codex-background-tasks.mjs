import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_TASKS = 100;
const MAX_RUNS = 50;
const MAX_PROMPT_LENGTH = 40_000;
const MAX_NAME_LENGTH = 96;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPT_COUNTER = 1_000_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set(["starting", "running", "cancelling", "uncertain"]);
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
const VALID_SANDBOXES = new Set(["read-only", "workspace-write"]);
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const VALID_WORKSPACE_MODES = new Set(["local", "worktree"]);
const VALID_DESTINATIONS = new Set(["newThread", "existingThread"]);
const VALID_SCHEDULE_KINDS = new Set(["manual", "once", "interval", "daily", "weekly", "rrule"]);

export class CodexBackgroundTaskStore {
  constructor({
    stateDirectory,
    projectRoot,
    projectRoots = null,
    uid = null,
    gid = null,
    now = () => Date.now(),
    maxTasks = MAX_TASKS,
    maxRuns = MAX_RUNS,
    durableSubmissions = false,
  } = {}) {
    this.stateDirectory = path.resolve(requiredString(stateDirectory, "Background task state directory"));
    this.projectRoots = [...new Set((projectRoots?.length ? projectRoots : [projectRoot])
      .map((value) => path.resolve(requiredString(value, "Background task project root"))))];
    this.projectRoot = this.projectRoots[0];
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.now = now;
    this.maxTasks = boundedInteger(maxTasks, 1, MAX_TASKS, MAX_TASKS);
    this.maxRuns = boundedInteger(maxRuns, 1, MAX_RUNS, MAX_RUNS);
    this.durableSubmissions = durableSubmissions === true;
    this.filePath = path.join(this.stateDirectory, "codex-background-tasks.json");
    this.tasks = new Map();
    this.operationQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this;
    await ensurePrivateDirectory(this.stateDirectory, this.uid, this.gid);
    let parsed = null;
    try {
      parsed = await readPrivateJson(this.filePath, {
        uid: this.uid,
        gid: this.gid,
        maxBytes: MAX_FILE_BYTES,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of Array.isArray(parsed?.tasks) ? parsed.tasks : []) {
      const task = normalizeStoredTask(entry, {
        projectRoots: this.projectRoots,
        maxRuns: this.maxRuns,
        now: this.now(),
      });
      if (task) this.tasks.set(task.id, task);
    }
    await this.recoverInterrupted();
    this.initialized = true;
    return this;
  }

  list({ projectPath = null, includeHistory = false } = {}) {
    this.assertInitialized();
    const project = projectPath ? path.resolve(projectPath) : null;
    return [...this.tasks.values()]
      .filter((task) => !project || task.projectPath === project)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((task) => publicTask(task, { includeHistory }));
  }

  get(id, { includePrompt = false, includeHistory = true } = {}) {
    this.assertInitialized();
    const task = this.tasks.get(normalizeId(id));
    return task ? publicTask(task, { includePrompt, includeHistory }) : null;
  }

  privateTask(id) {
    this.assertInitialized();
    const task = this.tasks.get(normalizeId(id));
    return task ? structuredClone(task) : null;
  }

  due(at = this.now()) {
    this.assertInitialized();
    return [...this.tasks.values()]
      .filter((task) => (
        task.enabled
        && task.status === "queued"
        && Number.isFinite(task.nextRunAt)
        && task.nextRunAt <= at
      ))
      .sort((left, right) => left.nextRunAt - right.nextRunAt || left.createdAt - right.createdAt)
      .map((task) => publicTask(task, { includeHistory: false }));
  }

  nextWakeAt() {
    this.assertInitialized();
    const next = [...this.tasks.values()]
      .filter((task) => task.enabled && task.status === "queued" && Number.isFinite(task.nextRunAt))
      .reduce((value, task) => Math.min(value, task.nextRunAt), Number.POSITIVE_INFINITY);
    return Number.isFinite(next) ? next : null;
  }

  activeCount() {
    this.assertInitialized();
    return [...this.tasks.values()].filter((task) => ACTIVE_STATUSES.has(task.status)).length;
  }

  unresolved() {
    this.assertInitialized();
    return [...this.tasks.values()]
      .filter((task) => (
        task.status === "uncertain"
        || (
          task.status === "cancelling"
          && Boolean(task.deliveryStage)
          && !task.currentTurnId
        )
      ))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((task) => publicTask(task, { includeHistory: false }));
  }

  summary() {
    this.assertInitialized();
    const records = [...this.tasks.values()];
    return {
      total: records.length,
      queued: records.filter((task) => task.status === "queued").length,
      active: records.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      paused: records.filter((task) => task.status === "paused").length,
      failed: records.filter((task) => task.status === "failed").length,
      scheduled: records.filter((task) => task.schedule.kind !== "manual").length,
      nextRunAt: this.nextWakeAt(),
    };
  }

  async create(input = {}) {
    return this.queue(async () => {
      this.assertInitialized();
      if (this.tasks.size >= this.maxTasks) {
        this.pruneCompleted();
      }
      if (this.tasks.size >= this.maxTasks) {
        throw storeError(409, `Codex 后台任务已达到 ${this.maxTasks} 个上限`);
      }
      const now = this.now();
      const projectPath = normalizeProjectPath(input.projectPath, this.projectRoots);
      const prompt = normalizePrompt(input.prompt);
      const destination = normalizeEnum(input.destination, VALID_DESTINATIONS, "newThread");
      const threadId = destination === "existingThread"
        ? normalizeThreadId(input.threadId, { required: true })
        : null;
      const schedule = normalizeSchedule(input.schedule, now);
      const runNow = input.runNow !== false;
      const firstRunAt = schedule.kind === "manual"
        ? now
        : runNow
          ? now
          : schedule.nextRunAt;
      const task = {
        version: STORE_VERSION,
        id: `cbg_${crypto.randomUUID()}`,
        name: normalizeName(input.name || prompt.slice(0, MAX_NAME_LENGTH)),
        prompt,
        promptPreview: safePreview(prompt),
        projectPath,
        destination,
        targetThreadId: threadId,
        workspaceMode: destination === "existingThread"
          ? "local"
          : normalizeEnum(input.workspaceMode, VALID_WORKSPACE_MODES, "local"),
        baseRef: normalizeBaseRef(input.baseRef),
        includeUncommitted: input.includeUncommitted === true,
        model: normalizeOptionalString(input.model, 256),
        effort: normalizeEnum(input.effort, VALID_EFFORTS, "medium"),
        sandbox: normalizeEnum(input.sandbox, VALID_SANDBOXES, "workspace-write"),
        approvalPolicy: normalizeEnum(input.approvalPolicy, VALID_APPROVAL_POLICIES, "never"),
        schedule,
        enabled: true,
        permissionSuspended: false,
        status: "queued",
        attempts: 0,
        maxAttempts: boundedInteger(input.maxAttempts, 1, 20, 3),
        infiniteRetry: input.infiniteRetry === true,
        retryBackoff: normalizeRetryBackoff(input.retryBackoff),
        nextRunAt: firstRunAt,
        currentRunId: null,
        currentThreadId: null,
        currentTurnId: null,
        currentWorktreeId: null,
        deliveryStage: null,
        cancelRequested: false,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        completedAt: null,
        runs: [],
      };
      this.tasks.set(task.id, task);
      await this.persist();
      return publicTask(task, { includeHistory: true });
    });
  }

  async markStarting(id) {
    return this.mutate(id, (task) => {
      if (task.status !== "queued" || !task.enabled) {
        throw storeError(409, "Codex 后台任务当前不能启动");
      }
      const now = this.now();
      const run = {
        id: `run_${crypto.randomUUID()}`,
        status: "starting",
        attempt: Math.min(MAX_ATTEMPT_COUNTER, task.attempts + 1),
        threadId: null,
        turnId: null,
        worktreeId: null,
        deliveryStage: "preparing",
        startedAt: now,
        completedAt: null,
        error: null,
      };
      task.status = "starting";
      task.attempts = Math.min(MAX_ATTEMPT_COUNTER, task.attempts + 1);
      task.currentRunId = run.id;
      task.currentThreadId = null;
      task.currentTurnId = null;
      task.currentWorktreeId = null;
      task.deliveryStage = "preparing";
      task.cancelRequested = false;
      task.lastError = null;
      task.lastRunAt = now;
      task.completedAt = null;
      task.runs.unshift(run);
      task.runs = task.runs.slice(0, this.maxRuns);
    });
  }

  async markRunning(id, { threadId, turnId, worktreeId = null } = {}) {
    return this.mutate(id, (task) => {
      if (!ACTIVE_STATUSES.has(task.status)) {
        throw storeError(409, "Codex 后台任务尚未进入启动状态");
      }
      const run = currentRun(task);
      const normalizedThreadId = normalizeThreadId(threadId, { required: true });
      const normalizedTurnId = normalizeTurnId(turnId);
      task.status = task.cancelRequested ? "cancelling" : "running";
      task.currentThreadId = normalizedThreadId;
      task.currentTurnId = normalizedTurnId;
      task.currentWorktreeId = normalizeOptionalId(worktreeId, "wt_");
      task.deliveryStage = "running";
      run.status = task.cancelRequested ? "cancelling" : "running";
      run.threadId = normalizedThreadId;
      run.turnId = normalizedTurnId;
      run.worktreeId = task.currentWorktreeId;
      run.deliveryStage = "running";
      run.error = null;
    });
  }

  async markRunResources(id, {
    threadId = null,
    worktreeId = null,
    deliveryStage = null,
  } = {}) {
    return this.mutate(id, (task) => {
      if (!ACTIVE_STATUSES.has(task.status)) {
        throw storeError(409, "Codex 后台任务没有可绑定的运行");
      }
      const run = currentRun(task);
      if (threadId) {
        const normalizedThreadId = normalizeThreadId(threadId, { required: true });
        task.currentThreadId = normalizedThreadId;
        run.threadId = normalizedThreadId;
      }
      if (worktreeId) {
        const normalizedWorktreeId = normalizeOptionalId(worktreeId, "wt_");
        task.currentWorktreeId = normalizedWorktreeId;
        run.worktreeId = normalizedWorktreeId;
      }
      if (deliveryStage) {
        const normalizedStage = normalizeDeliveryStage(deliveryStage);
        task.deliveryStage = normalizedStage;
        run.deliveryStage = normalizedStage;
      }
    });
  }

  async markDeliveryUnknown(id, {
    stage,
    threadId = null,
    turnId = null,
    worktreeId = null,
    error = "Codex 提交交付状态待确认",
  } = {}) {
    return this.mutate(id, (task) => {
      if (!ACTIVE_STATUSES.has(task.status)) {
        throw storeError(409, "Codex 后台任务当前不能进入待确认状态");
      }
      const run = currentRun(task);
      const normalizedStage = normalizeDeliveryStage(stage);
      const message = normalizeError(error);
      task.status = "uncertain";
      task.deliveryStage = normalizedStage;
      task.currentThreadId = normalizeThreadId(
        threadId || task.currentThreadId,
        { required: false },
      );
      task.currentTurnId = normalizeTurnId(turnId || task.currentTurnId);
      task.currentWorktreeId = normalizeOptionalId(
        worktreeId || task.currentWorktreeId,
        "wt_",
      );
      task.lastError = message;
      task.completedAt = null;
      task.nextRunAt = null;
      run.status = "uncertain";
      run.deliveryStage = normalizedStage;
      run.threadId = task.currentThreadId;
      run.turnId = task.currentTurnId;
      run.worktreeId = task.currentWorktreeId;
      run.completedAt = null;
      run.error = message;
    });
  }

  async markTurnId(id, turnId) {
    return this.mutate(id, (task) => {
      if (!ACTIVE_STATUSES.has(task.status)) throw storeError(409, "Codex 后台任务没有运行中的轮次");
      const normalized = normalizeTurnId(turnId);
      task.currentTurnId = normalized;
      currentRun(task).turnId = normalized;
    });
  }

  async complete(id, { threadId = null, turnId = null } = {}) {
    return this.mutate(id, (task) => {
      if (!ACTIVE_STATUSES.has(task.status)) {
        if (task.status === "completed") return;
        throw storeError(409, "Codex 后台任务当前不能标记完成");
      }
      const now = this.now();
      const run = currentRun(task);
      run.status = task.cancelRequested ? "cancelled" : "completed";
      run.threadId = normalizeThreadId(threadId || task.currentThreadId, { required: false });
      run.turnId = normalizeTurnId(turnId || task.currentTurnId);
      run.completedAt = now;
      task.status = run.status;
      task.completedAt = now;
      task.lastError = null;
      task.currentRunId = null;
      task.currentThreadId = null;
      task.currentTurnId = null;
      task.currentWorktreeId = null;
      task.deliveryStage = null;
      task.cancelRequested = false;
      task.attempts = 0;
      scheduleNextRun(task, now);
    });
  }

  async fail(id, error, {
    retryable = true,
    allowInfiniteRetry = true,
    threadId = null,
    turnId = null,
  } = {}) {
    return this.mutate(id, (task) => {
      if (!ACTIVE_STATUSES.has(task.status) && task.status !== "queued") {
        if (task.status === "failed") return;
        throw storeError(409, "Codex 后台任务当前不能标记失败");
      }
      const now = this.now();
      const message = normalizeError(error);
      const run = task.currentRunId ? currentRun(task) : null;
      if (run) {
        run.status = task.cancelRequested ? "cancelled" : "failed";
        run.threadId = normalizeThreadId(threadId || task.currentThreadId, { required: false });
        run.turnId = normalizeTurnId(turnId || task.currentTurnId);
        run.completedAt = now;
        run.error = message;
      }
      task.lastError = message;
      task.completedAt = now;
      task.currentRunId = null;
      task.currentThreadId = null;
      task.currentTurnId = null;
      task.currentWorktreeId = null;
      task.deliveryStage = null;
      const cancelled = task.cancelRequested;
      task.cancelRequested = false;
      if (cancelled) {
        task.status = "cancelled";
        task.nextRunAt = null;
      } else if (
        retryable
        && task.enabled
        && ((allowInfiniteRetry && task.infiniteRetry) || task.attempts < task.maxAttempts)
      ) {
        task.status = "queued";
        task.nextRunAt = now + retryDelay(task.retryBackoff, task.attempts, task.id);
      } else if (
        task.enabled
        && !["manual", "once"].includes(task.schedule.kind)
        && Number.isFinite(nextScheduledAt(task.schedule, now, { afterRun: true }))
      ) {
        task.status = "queued";
        task.attempts = 0;
        task.nextRunAt = nextScheduledAt(task.schedule, now, { afterRun: true });
      } else {
        task.status = "failed";
        task.nextRunAt = null;
      }
    });
  }

  async requestCancel(id) {
    return this.mutate(id, (task) => {
      if (task.status === "queued") {
        task.status = "cancelled";
        task.nextRunAt = null;
        task.completedAt = this.now();
        task.cancelRequested = false;
        return;
      }
      if (!ACTIVE_STATUSES.has(task.status)) {
        throw storeError(409, "Codex 后台任务当前没有可终止的运行");
      }
      task.status = "cancelling";
      task.cancelRequested = true;
      if (task.currentRunId) currentRun(task).status = "cancelling";
    });
  }

  async pause(id) {
    return this.mutate(id, (task) => {
      if (ACTIVE_STATUSES.has(task.status)) {
        throw storeError(409, "运行中的任务请先终止，再暂停后续调度");
      }
      task.enabled = false;
      task.permissionSuspended = false;
      task.status = "paused";
      task.nextRunAt = null;
      task.cancelRequested = false;
    });
  }

  async resume(id, { runNow = false } = {}) {
    return this.mutate(id, (task) => {
      if (ACTIVE_STATUSES.has(task.status)) throw storeError(409, "Codex 后台任务仍在运行");
      const now = this.now();
      task.enabled = true;
      task.permissionSuspended = false;
      task.status = "queued";
      task.attempts = 0;
      task.lastError = null;
      task.completedAt = null;
      task.cancelRequested = false;
      task.nextRunAt = runNow
        ? now
        : nextScheduledAt(task.schedule, now, { afterRun: false }) ?? now;
    });
  }

  async retry(id) {
    return this.resume(id, { runNow: true });
  }

  async updateSchedule(id, input) {
    return this.mutate(id, (task) => {
      if (ACTIVE_STATUSES.has(task.status)) throw storeError(409, "运行中的任务不能热切换调度设置");
      const now = this.now();
      task.schedule = normalizeSchedule(input, now);
      task.enabled = true;
      task.permissionSuspended = false;
      task.status = "queued";
      task.attempts = 0;
      task.completedAt = null;
      task.nextRunAt = task.schedule.kind === "manual"
        ? now
        : task.schedule.nextRunAt;
    });
  }

  async updateRetry(id, input = {}) {
    return this.mutate(id, (task) => {
      task.infiniteRetry = input.infiniteRetry === true;
      task.maxAttempts = boundedInteger(input.maxAttempts, 1, 20, task.maxAttempts);
      task.retryBackoff = normalizeRetryBackoff(input.retryBackoff ?? task.retryBackoff);
    });
  }

  async setPermissionEnabled(enabled) {
    return this.queue(async () => {
      this.assertInitialized();
      const allowed = enabled === true;
      const now = this.now();
      let changed = false;
      for (const task of this.tasks.values()) {
        if (!allowed && !task.permissionSuspended && task.enabled) {
          task.permissionSuspended = true;
          task.enabled = false;
          if (task.status === "queued") {
            task.status = "paused";
            task.nextRunAt = null;
          }
          task.updatedAt = now;
          changed = true;
        } else if (allowed && task.permissionSuspended) {
          task.permissionSuspended = false;
          task.enabled = true;
          if (!ACTIVE_STATUSES.has(task.status)) {
            task.status = "queued";
            task.completedAt = null;
            task.nextRunAt = task.attempts > 0 && task.lastError
              ? now
              : task.schedule.kind === "once" && task.schedule.at > now
                ? task.schedule.at
                : nextScheduledAt(task.schedule, now, { afterRun: false }) ?? now;
          }
          task.updatedAt = now;
          changed = true;
        }
      }
      if (changed) await this.persist();
      return changed;
    });
  }

  async wakeRetrying() {
    return this.queue(async () => {
      this.assertInitialized();
      const now = this.now();
      let changed = 0;
      for (const task of this.tasks.values()) {
        if (
          task.enabled
          && task.status === "queued"
          && task.attempts > 0
          && task.lastError
          && Number.isFinite(task.nextRunAt)
          && task.nextRunAt > now
        ) {
          task.nextRunAt = now;
          task.updatedAt = now;
          changed += 1;
        }
      }
      if (changed) await this.persist();
      return changed;
    });
  }

  async remove(id) {
    return this.queue(async () => {
      this.assertInitialized();
      const normalized = normalizeId(id);
      const task = this.tasks.get(normalized);
      if (!task) throw storeError(404, "Codex 后台任务不存在");
      if (ACTIVE_STATUSES.has(task.status)) throw storeError(409, "请先终止运行中的 Codex 后台任务");
      this.tasks.delete(normalized);
      await this.persist();
      return true;
    });
  }

  async recoverInterrupted() {
    let changed = false;
    const now = this.now();
    for (const task of this.tasks.values()) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      const run = task.currentRunId
        ? task.runs.find((entry) => entry.id === task.currentRunId)
        : null;
      if (this.durableSubmissions && run) {
        const deliveryStage = task.currentTurnId || task.currentThreadId
          || task.destination === "existingThread"
          ? "turn"
          : "thread";
        run.status = "uncertain";
        run.deliveryStage = deliveryStage;
        run.completedAt = null;
        run.error = "服务器重启时任务状态待权威确认";
        task.status = "uncertain";
        task.deliveryStage = deliveryStage;
        task.nextRunAt = null;
        task.lastError = "服务器重启时任务状态待权威确认";
        task.updatedAt = now;
        changed = true;
        continue;
      }
      if (run) {
        run.status = "interrupted";
        run.completedAt = now;
        run.error = "服务器重启时任务仍在运行，已进入恢复队列";
      }
      task.status = task.enabled ? "queued" : "paused";
      task.nextRunAt = task.enabled ? now : null;
      task.currentRunId = null;
      task.currentThreadId = null;
      task.currentTurnId = null;
      task.currentWorktreeId = null;
      task.deliveryStage = null;
      task.cancelRequested = false;
      task.lastError = "服务器重启时任务仍在运行，已进入恢复队列";
      task.updatedAt = now;
      changed = true;
    }
    if (changed) await this.persist();
  }

  async mutate(id, callback) {
    return this.queue(async () => {
      this.assertInitialized();
      const task = this.tasks.get(normalizeId(id));
      if (!task) throw storeError(404, "Codex 后台任务不存在");
      callback(task);
      task.updatedAt = this.now();
      await this.persist();
      return publicTask(task, { includeHistory: true });
    });
  }

  pruneCompleted() {
    const candidates = [...this.tasks.values()]
      .filter((task) => TERMINAL_STATUSES.has(task.status) && task.schedule.kind === "manual")
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.tasks.size >= this.maxTasks && candidates.length) {
      this.tasks.delete(candidates.shift().id);
    }
  }

  async persist() {
    const payload = {
      version: STORE_VERSION,
      tasks: [...this.tasks.values()].sort((left, right) => left.createdAt - right.createdAt),
    };
    await writePrivateJson(this.filePath, payload, { uid: this.uid, gid: this.gid });
  }

  queue(callback) {
    const operation = this.operationQueue.then(callback, callback);
    this.operationQueue = operation.catch(() => {});
    return operation;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Codex background task store is not initialized");
  }
}

export function normalizeCodexBackgroundSchedule(input, now = Date.now()) {
  return normalizeSchedule(input, now);
}

export function nextCodexBackgroundRunAt(schedule, now = Date.now()) {
  return nextScheduledAt(normalizeSchedule(schedule, now), now, { afterRun: true });
}

function normalizeSchedule(input, now) {
  const source = input && typeof input === "object" ? input : {};
  const kind = normalizeEnum(source.kind, VALID_SCHEDULE_KINDS, "manual");
  if (kind === "manual") return { kind, nextRunAt: now };
  if (kind === "once") {
    const at = normalizeTimestamp(source.at ?? source.nextRunAt, now, { allowPast: false });
    return { kind, at, nextRunAt: at };
  }
  if (kind === "interval") {
    const intervalMs = source.intervalMs === undefined || source.intervalMs === null
      ? 60 * 60 * 1000
      : boundedInteger(source.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, null);
    const startAt = normalizeTimestamp(source.startAt, now, { fallback: now + intervalMs });
    return { kind, intervalMs, startAt, nextRunAt: Math.max(now, startAt) };
  }
  if (kind === "daily") {
    const time = normalizeClock(source.time?.value || source.time);
    const nextRunAt = nextDailyAt(now, time);
    return { kind, time, nextRunAt };
  }
  if (kind === "weekly") {
    const time = normalizeClock(source.time?.value || source.time);
    const weekdays = normalizeWeekdays(source.weekdays);
    const nextRunAt = nextWeeklyAt(now, time, weekdays);
    return { kind, time, weekdays, nextRunAt };
  }
  const rrule = parseRRule(source.rrule);
  const startAt = normalizeTimestamp(source.startAt, now, { fallback: now });
  const nextRunAt = nextRRuleAt(rrule, Math.max(now - 1, startAt - 1), startAt);
  if (!Number.isFinite(nextRunAt)) throw storeError(400, "RRULE 没有可执行的下一次时间");
  return { kind, rrule: rrule.raw, startAt, nextRunAt };
}

function nextScheduledAt(schedule, now, { afterRun = true } = {}) {
  if (!schedule || schedule.kind === "manual" || schedule.kind === "once") return null;
  if (schedule.kind === "interval") {
    const base = afterRun ? now : Math.max(now - 1, schedule.startAt - 1);
    if (base < schedule.startAt) return schedule.startAt;
    const elapsed = Math.max(0, base - schedule.startAt);
    return schedule.startAt + (Math.floor(elapsed / schedule.intervalMs) + 1) * schedule.intervalMs;
  }
  if (schedule.kind === "daily") return nextDailyAt(now, schedule.time, { strict: afterRun });
  if (schedule.kind === "weekly") return nextWeeklyAt(now, schedule.time, schedule.weekdays, { strict: afterRun });
  if (schedule.kind === "rrule") {
    return nextRRuleAt(parseRRule(schedule.rrule), now, schedule.startAt);
  }
  return null;
}

function scheduleNextRun(task, now) {
  const nextRunAt = nextScheduledAt(task.schedule, now, { afterRun: true });
  if (Number.isFinite(nextRunAt) && task.enabled) {
    task.status = "queued";
    task.nextRunAt = nextRunAt;
    task.completedAt = null;
  } else {
    task.nextRunAt = null;
  }
}

function parseRRule(value) {
  const text = requiredString(value, "RRULE").trim().toUpperCase();
  const body = text.startsWith("RRULE:") ? text.slice(6) : text;
  if (!body || body.length > 512) throw storeError(400, "RRULE 无效或过长");
  const fields = new Map();
  for (const segment of body.split(";")) {
    const [key, rawValue, ...extra] = segment.split("=");
    if (!key || rawValue === undefined || extra.length || fields.has(key)) {
      throw storeError(400, "RRULE 格式无效");
    }
    fields.set(key, rawValue);
  }
  const freq = fields.get("FREQ");
  if (!["MINUTELY", "HOURLY", "DAILY", "WEEKLY"].includes(freq)) {
    throw storeError(400, "RRULE 仅支持 MINUTELY、HOURLY、DAILY 和 WEEKLY");
  }
  for (const key of fields.keys()) {
    if (!["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL"].includes(key)) {
      throw storeError(400, `RRULE 字段 ${key} 暂不支持`);
    }
  }
  const interval = fields.has("INTERVAL")
    ? boundedInteger(fields.get("INTERVAL"), 1, 10_000, null)
    : 1;
  if (freq === "MINUTELY" && interval < 1) throw storeError(400, "RRULE 间隔无效");
  const byHour = fields.has("BYHOUR")
    ? parseIntegerList(fields.get("BYHOUR"), 0, 23, "BYHOUR")
    : [];
  const byMinute = fields.has("BYMINUTE")
    ? parseIntegerList(fields.get("BYMINUTE"), 0, 59, "BYMINUTE")
    : [];
  const byDay = fields.has("BYDAY") ? normalizeRRuleDays(fields.get("BYDAY")) : [];
  const count = fields.has("COUNT") ? boundedInteger(fields.get("COUNT"), 1, 100_000, null) : null;
  const until = fields.has("UNTIL") ? parseRRuleUntil(fields.get("UNTIL")) : null;
  return {
    raw: `RRULE:${body}`,
    freq,
    interval,
    byHour,
    byMinute,
    byDay,
    count,
    until,
  };
}

function nextRRuleAt(rule, after, startAt) {
  const anchor = ceilMinute(Number(startAt) || 0);
  const stepMs = rule.freq === "MINUTELY"
    ? rule.interval * 60_000
    : rule.freq === "HOURLY"
      ? rule.interval * 60 * 60_000
      : 60_000;
  let candidate = anchor;
  let occurrences = 0;
  const maxChecks = 3_000_000;
  for (let checks = 0; checks < maxChecks; checks += 1) {
    if (rule.until && candidate > rule.until) return null;
    if (candidate > anchor + MAX_FUTURE_MS) return null;
    if (matchesRRule(candidate, anchor, rule)) {
      occurrences += 1;
      if (rule.count && occurrences > rule.count) return null;
      if (candidate > after) return candidate;
    }
    candidate += stepMs;
  }
  throw storeError(400, "RRULE 计算范围过大，请缩短间隔或限制规则");
}

function matchesRRule(candidate, startAt, rule) {
  const date = new Date(candidate);
  if (rule.byHour.length && !rule.byHour.includes(date.getUTCHours())) return false;
  if (rule.byMinute.length && !rule.byMinute.includes(date.getUTCMinutes())) return false;
  if (rule.byDay.length && !rule.byDay.includes(date.getUTCDay())) return false;
  const elapsed = Math.max(0, candidate - startAt);
  if (rule.freq === "MINUTELY") return Math.floor(elapsed / 60_000) % rule.interval === 0;
  if (rule.freq === "HOURLY") return Math.floor(elapsed / (60 * 60_000)) % rule.interval === 0;
  if (rule.freq === "DAILY") return Math.floor(elapsed / (24 * 60 * 60_000)) % rule.interval === 0;
  const startWeek = utcWeekStart(startAt);
  const candidateWeek = utcWeekStart(candidate);
  return Math.floor((candidateWeek - startWeek) / (7 * 24 * 60 * 60_000)) % rule.interval === 0;
}

function nextDailyAt(now, clock, { strict = false } = {}) {
  const date = new Date(now);
  let candidate = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    clock.hour,
    clock.minute,
  );
  if (candidate < now || (strict && candidate === now)) candidate += 24 * 60 * 60_000;
  return candidate;
}

function nextWeeklyAt(now, clock, weekdays, { strict = false } = {}) {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDay = new Date(dayStart + offset * 24 * 60 * 60_000);
    if (!weekdays.includes(candidateDay.getUTCDay())) continue;
    const candidate = candidateDay.getTime() + clock.hour * 60 * 60_000 + clock.minute * 60_000;
    if (candidate > now || (!strict && candidate === now)) return candidate;
  }
  throw storeError(400, "无法计算每周任务的下一次时间");
}

function normalizeStoredTask(entry, { projectRoots, maxRuns, now }) {
  try {
    if (!entry || entry.version !== STORE_VERSION) return null;
    const id = normalizeId(entry.id);
    const projectPath = normalizeProjectPath(entry.projectPath, projectRoots);
    const prompt = normalizePrompt(entry.prompt);
    const schedule = normalizeSchedule(entry.schedule, Math.min(now, Number(entry.createdAt) || now));
    if (Number.isFinite(entry.schedule?.nextRunAt)) schedule.nextRunAt = Number(entry.schedule.nextRunAt);
    const status = [
      "queued", "starting", "running", "cancelling", "uncertain",
      "paused", "completed", "failed", "cancelled",
    ].includes(entry.status) ? entry.status : "failed";
    const runs = Array.isArray(entry.runs)
      ? entry.runs.slice(0, maxRuns).map(normalizeRun).filter(Boolean)
      : [];
    return {
      version: STORE_VERSION,
      id,
      name: normalizeName(entry.name),
      prompt,
      promptPreview: safePreview(prompt),
      projectPath,
      destination: normalizeEnum(entry.destination, VALID_DESTINATIONS, "newThread"),
      targetThreadId: normalizeThreadId(entry.targetThreadId, { required: false }),
      workspaceMode: normalizeEnum(entry.workspaceMode, VALID_WORKSPACE_MODES, "local"),
      baseRef: normalizeBaseRef(entry.baseRef),
      includeUncommitted: entry.includeUncommitted === true,
      model: normalizeOptionalString(entry.model, 256),
      effort: normalizeEnum(entry.effort, VALID_EFFORTS, "medium"),
      sandbox: normalizeEnum(entry.sandbox, VALID_SANDBOXES, "workspace-write"),
      approvalPolicy: normalizeEnum(entry.approvalPolicy, VALID_APPROVAL_POLICIES, "never"),
      schedule,
      enabled: entry.permissionSuspended === true ? false : entry.enabled !== false,
      permissionSuspended: entry.permissionSuspended === true,
      status,
      attempts: boundedInteger(entry.attempts, 0, MAX_ATTEMPT_COUNTER, 0),
      maxAttempts: boundedInteger(entry.maxAttempts, 1, 20, 3),
      infiniteRetry: entry.infiniteRetry === true,
      retryBackoff: normalizeRetryBackoff(entry.retryBackoff),
      nextRunAt: Number.isFinite(entry.nextRunAt) ? Number(entry.nextRunAt) : null,
      currentRunId: normalizeOptionalId(entry.currentRunId, "run_"),
      currentThreadId: normalizeThreadId(entry.currentThreadId, { required: false }),
      currentTurnId: normalizeTurnId(entry.currentTurnId),
      currentWorktreeId: normalizeOptionalId(entry.currentWorktreeId, "wt_"),
      deliveryStage: entry.deliveryStage ? normalizeDeliveryStage(entry.deliveryStage) : null,
      cancelRequested: entry.cancelRequested === true,
      lastError: entry.lastError ? normalizeError(entry.lastError) : null,
      createdAt: normalizePastTimestamp(entry.createdAt, now),
      updatedAt: normalizePastTimestamp(entry.updatedAt, now),
      lastRunAt: entry.lastRunAt ? normalizePastTimestamp(entry.lastRunAt, now) : null,
      completedAt: entry.completedAt ? normalizePastTimestamp(entry.completedAt, now) : null,
      runs,
    };
  } catch {
    return null;
  }
}

function normalizeRun(entry) {
  try {
    if (!entry || typeof entry !== "object") return null;
    return {
      id: normalizeOptionalId(entry.id, "run_"),
      status: [
        "starting", "running", "cancelling", "uncertain",
        "completed", "failed", "cancelled", "interrupted",
      ].includes(entry.status) ? entry.status : "failed",
      attempt: boundedInteger(entry.attempt, 1, MAX_ATTEMPT_COUNTER, 1),
      threadId: normalizeThreadId(entry.threadId, { required: false }),
      turnId: normalizeTurnId(entry.turnId),
      worktreeId: normalizeOptionalId(entry.worktreeId, "wt_"),
      deliveryStage: entry.deliveryStage ? normalizeDeliveryStage(entry.deliveryStage) : null,
      startedAt: Number(entry.startedAt) || Date.now(),
      completedAt: Number.isFinite(entry.completedAt) ? Number(entry.completedAt) : null,
      error: entry.error ? normalizeError(entry.error) : null,
    };
  } catch {
    return null;
  }
}

function publicTask(task, { includePrompt = false, includeHistory = false } = {}) {
  return {
    id: task.id,
    name: task.name,
    promptPreview: task.promptPreview,
    ...(includePrompt ? { prompt: task.prompt } : {}),
    projectPath: task.projectPath,
    destination: task.destination,
    targetThreadId: task.targetThreadId,
    workspaceMode: task.workspaceMode,
    baseRef: task.baseRef,
    includeUncommitted: task.includeUncommitted,
    model: task.model,
    effort: task.effort,
    sandbox: task.sandbox,
    approvalPolicy: task.approvalPolicy,
    schedule: structuredClone(task.schedule),
    enabled: task.enabled,
    permissionSuspended: task.permissionSuspended,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    infiniteRetry: task.infiniteRetry,
    retryBackoff: task.retryBackoff,
    nextRunAt: task.nextRunAt,
    currentRunId: task.currentRunId,
    currentThreadId: task.currentThreadId,
    currentTurnId: task.currentTurnId,
    currentWorktreeId: task.currentWorktreeId,
    deliveryStage: task.deliveryStage,
    cancelRequested: task.cancelRequested,
    lastError: task.lastError,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastRunAt: task.lastRunAt,
    completedAt: task.completedAt,
    ...(includeHistory ? { runs: structuredClone(task.runs) } : {}),
  };
}

function currentRun(task) {
  const run = task.runs.find((entry) => entry.id === task.currentRunId);
  if (!run) throw storeError(409, "Codex 后台任务运行记录缺失");
  return run;
}

function retryDelay(backoff, attempt, taskId) {
  const base = backoff === "fast" ? 15_000 : backoff === "patient" ? 5 * 60_000 : 60_000;
  const cap = backoff === "fast" ? 5 * 60_000 : backoff === "patient" ? 60 * 60_000 : 15 * 60_000;
  const exponent = Math.min(20, Math.max(0, attempt - 1));
  const bounded = Math.min(cap, base * (2 ** exponent));
  const digest = crypto.createHash("sha256").update(`${taskId}:${attempt}`).digest();
  const jitter = 0.85 + (digest.readUInt16BE(0) / 0xffff) * 0.3;
  return Math.max(1_000, Math.min(cap, Math.round(bounded * jitter)));
}

function normalizeDeliveryStage(value) {
  const stage = String(value || "");
  if (!["preparing", "thread", "turn", "running"].includes(stage)) {
    throw storeError(400, "Codex 后台任务交付阶段无效");
  }
  return stage;
}

function normalizeRetryBackoff(value) {
  return ["fast", "balanced", "patient"].includes(value) ? value : "balanced";
}

function normalizeProjectPath(value, projectRoots) {
  const candidate = path.resolve(requiredString(value, "Project path"));
  if (!projectRoots.some((root) => isPathInside(root, candidate))) throw storeError(403, "后台任务工程不属于当前账号");
  return candidate;
}

function normalizePrompt(value) {
  const prompt = requiredString(value, "Background task prompt").trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    throw storeError(400, `后台任务指令必须为 1-${MAX_PROMPT_LENGTH} 个字符`);
  }
  return prompt;
}

function normalizeName(value) {
  const name = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return "Codex 后台任务";
  return name.slice(0, MAX_NAME_LENGTH);
}

function safePreview(value) {
  return String(value)
    .replace(/(?:sk-[A-Za-z0-9_-]{10,}|(?:api[\s_-]?key|token|password)\s*[:=]\s*\S+)/gi, "[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizeThreadId(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw storeError(400, "后台任务缺少目标对话 ID");
    return null;
  }
  const result = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) throw storeError(400, "后台任务对话 ID 无效");
  return result;
}

function normalizeTurnId(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) throw storeError(400, "后台任务轮次 ID 无效");
  return result;
}

function normalizeId(value) {
  const result = String(value || "");
  if (!/^cbg_[0-9a-f-]{36}$/i.test(result)) throw storeError(400, "Codex 后台任务 ID 无效");
  return result;
}

function normalizeOptionalId(value, prefix) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value);
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{8,128}$`).test(result)) {
    throw storeError(400, "Codex 后台运行引用无效");
  }
  return result;
}

function normalizeBaseRef(value) {
  const result = String(value || "HEAD").trim();
  if (
    !result
    || result.length > 256
    || [...result].some((character) => character.charCodeAt(0) <= 32 || "~^:?*[\\".includes(character))
    || result.startsWith("-")
  ) {
    throw storeError(400, "Worktree 基础分支无效");
  }
  return result;
}

function normalizeClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || "09:00"));
  if (!match) throw storeError(400, "执行时间必须使用 HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw storeError(400, "执行时间无效");
  return { value: `${match[1]}:${match[2]}`, hour, minute };
}

function normalizeWeekdays(value) {
  const weekdays = [...new Set((Array.isArray(value) ? value : [1]).map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  if (!weekdays.length) throw storeError(400, "每周任务至少选择一天");
  return weekdays;
}

function normalizeRRuleDays(value) {
  const mapping = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const days = String(value || "").split(",").map((entry) => mapping[entry]);
  if (!days.length || days.some((entry) => !Number.isInteger(entry))) {
    throw storeError(400, "RRULE BYDAY 无效");
  }
  return [...new Set(days)];
}

function parseIntegerList(value, minimum, maximum, label) {
  const values = String(value || "").split(",").map(Number);
  if (!values.length || values.some((entry) => !Number.isInteger(entry) || entry < minimum || entry > maximum)) {
    throw storeError(400, `RRULE ${label} 无效`);
  }
  return [...new Set(values)];
}

function parseRRuleUntil(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value || ""));
  if (!match) throw storeError(400, "RRULE UNTIL 必须使用 UTC 时间");
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (!Number.isFinite(timestamp)) throw storeError(400, "RRULE UNTIL 无效");
  return timestamp;
}

function normalizeTimestamp(value, now, { fallback = null, allowPast = true } = {}) {
  const timestamp = value === undefined || value === null || value === ""
    ? fallback
    : typeof value === "string"
      ? Date.parse(value)
      : Number(value);
  if (!Number.isFinite(timestamp)) throw storeError(400, "后台任务时间无效");
  if (!allowPast && timestamp < now) throw storeError(400, "后台任务时间不能早于当前时间");
  if (timestamp > now + MAX_FUTURE_MS) throw storeError(400, "后台任务时间超出允许范围");
  return timestamp;
}

function normalizePastTimestamp(value, now) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 60_000 ? timestamp : now;
}

function normalizeError(error) {
  const message = String(error?.message || error || "Codex 后台任务失败")
    .replace(/(?:sk-[A-Za-z0-9_-]{10,}|(?:api[\s_-]?key|token|password)\s*[:=]\s*\S+)/gi, "[已隐藏]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (message || "Codex 后台任务失败").slice(0, 500);
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeOptionalString(value, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value).trim();
  if (!result || result.length > maximum || /[\0\r\n]/.test(result)) {
    throw storeError(400, "Codex 后台任务设置无效");
  }
  return result;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw storeError(400, `${label} is required`);
  return value;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= minimum && number <= maximum) return number;
  if (fallback !== null && fallback !== undefined) return fallback;
  throw storeError(400, "数值超出允许范围");
}

function utcWeekStart(timestamp) {
  const date = new Date(timestamp);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return dayStart - date.getUTCDay() * 24 * 60 * 60_000;
}

function ceilMinute(timestamp) {
  return Math.ceil(timestamp / 60_000) * 60_000;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readPrivateJson(filePath, { uid, gid, maxBytes }) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw storeError(400, "Codex 后台任务状态文件无效");
  }
  if (uid !== null && stat.uid !== uid) throw storeError(403, "Codex 后台任务状态文件属主无效");
  if (gid !== null && stat.gid !== gid) throw storeError(403, "Codex 后台任务状态文件属组无效");
  if ((stat.mode & 0o077) !== 0) throw storeError(403, "Codex 后台任务状态文件权限过宽");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writePrivateJson(filePath, value, { uid, gid }) {
  await ensurePrivateDirectory(path.dirname(filePath), uid, gid);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    if (uid !== null || gid !== null) await fs.chown(temporary, uid ?? -1, gid ?? -1);
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function ensurePrivateDirectory(directory, uid = null, gid = null) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw storeError(400, "Codex 后台任务目录无效");
  await fs.chmod(directory, 0o700);
  if ((uid !== null && stat.uid !== uid) || (gid !== null && stat.gid !== gid)) {
    await fs.chown(directory, uid ?? -1, gid ?? -1);
  }
}

function storeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
