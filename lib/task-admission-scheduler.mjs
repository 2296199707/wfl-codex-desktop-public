const DEFAULT_ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "stopping",
  "uncertain",
]);

export class FairTaskAdmissionScheduler {
  constructor({
    activeTasks = () => [],
    admissionOpen = () => true,
    maxActive = 6,
    maxActivePerProject = 2,
    maxQueued = 32,
    waitTimeoutMs = 90_000,
    reservationTtlMs = null,
    rejectWhenFull = false,
    capacityError = null,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof activeTasks !== "function") throw new TypeError("activeTasks must be a function");
    if (typeof admissionOpen !== "function") throw new TypeError("admissionOpen must be a function");
    this.activeTasks = activeTasks;
    this.admissionOpen = admissionOpen;
    this.maxActive = positiveIntegerSource(maxActive, "maxActive");
    this.maxActivePerProject = positiveIntegerSource(maxActivePerProject, "maxActivePerProject");
    this.maxQueued = positiveInteger(maxQueued, "maxQueued");
    this.waitTimeoutMs = positiveInteger(waitTimeoutMs, "waitTimeoutMs");
    this.reservationTtlMs = reservationTtlMs === null ? null : positiveInteger(reservationTtlMs, "reservationTtlMs");
    this.rejectWhenFull = rejectWhenFull === true;
    this.capacityError = typeof capacityError === "function" ? capacityError : null;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.reservations = new Map();
    this.queues = new Map();
    this.queuedCount = 0;
    this.nextPermitId = 1;
    this.lastGrantedProject = null;
    this.maintenance = false;
  }

  async run(metadata, operation) {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const permit = await this.acquire(metadata);
    try {
      return await operation(permit);
    } finally {
      this.release(permit);
    }
  }

  acquire(metadata = {}) {
    const normalized = normalizeMetadata(metadata);
    if (normalized.replay) {
      return Promise.resolve({
        id: null,
        taskKey: normalized.taskKey,
        projectKey: normalized.projectKey,
        reserved: false,
        replay: true,
      });
    }
    if (!this.maintenance && this.admissionOpen() && this.canAdmit(normalized)) {
      return Promise.resolve(this.grant(normalized));
    }
    if (!this.maintenance && this.admissionOpen() && this.rejectWhenFull) {
      const snapshot = this.snapshot();
      return Promise.reject(this.capacityError?.(snapshot, normalized) || admissionError(
        "ERR_TASK_ADMISSION_CAPACITY_REACHED",
        "当前账号的任务并发数已达到上限",
        429,
      ));
    }
    if (this.queuedCount >= this.maxQueued) {
      return Promise.reject(admissionError(
        "ERR_TASK_ADMISSION_QUEUE_FULL",
        "当前账号的任务等待队列已满，请稍后重试",
        429,
      ));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        ...normalized,
        resolve,
        reject,
        timer: null,
        settled: false,
      };
      let queue = this.queues.get(entry.projectKey);
      if (!queue) {
        queue = [];
        this.queues.set(entry.projectKey, queue);
      }
      queue.push(entry);
      this.queuedCount += 1;
      entry.timer = this.setTimer(() => {
        if (!this.removeQueuedEntry(entry)) return;
        const error = admissionError(
          "ERR_TASK_ADMISSION_TIMEOUT",
          "等待任务执行名额超时；任务尚未发送，请稍后重试",
          503,
        );
        entry.onRejected?.(error);
        reject(error);
      }, this.waitTimeoutMs);
      entry.timer?.unref?.();
      entry.onQueued?.(this.snapshot());
      this.drain();
    });
  }

  release(permit) {
    if (!permit?.reserved || !permit.id) return false;
    const stored = this.reservations.get(permit.id);
    if (stored?.timer) this.clearTimer(stored.timer);
    const released = this.reservations.delete(permit.id);
    if (released) this.drain();
    return released;
  }

  hasPermit(permit) {
    return Boolean(permit?.id && this.reservations.get(permit.id) === permit);
  }

  hasConflict({ taskKey = null, projectKey = null, ignoreTaskKeys = [] } = {}) {
    const normalizedTaskKey = safeKey(taskKey);
    const normalizedProjectKey = safeKey(projectKey);
    const ignoredTaskKeys = new Set(
      (Array.isArray(ignoreTaskKeys) ? ignoreTaskKeys : [ignoreTaskKeys])
        .map((value) => safeKey(value))
        .filter(Boolean),
    );
    if (!normalizedTaskKey && !normalizedProjectKey) return false;
    const matches = (entry) => Boolean(
      entry
      && !ignoredTaskKeys.has(entry.taskKey)
      && (
        (normalizedTaskKey && entry.taskKey === normalizedTaskKey)
        || (normalizedProjectKey && entry.projectKey === normalizedProjectKey)
      )
    );
    if (this.activeEntries().some(matches)) return true;
    if ([...this.reservations.values()].some(matches)) return true;
    return [...this.queues.values()].some((queue) => queue.some(matches));
  }

  rekey(permit, taskKey, projectKey = null) {
    if (!this.hasPermit(permit)) return false;
    const normalizedTaskKey = safeKey(taskKey);
    if (!normalizedTaskKey) return false;
    permit.taskKey = normalizedTaskKey;
    permit.projectKey = safeKey(projectKey) || `thread:${normalizedTaskKey}`;
    return true;
  }

  capacityChanged() {
    this.drain();
  }

  cancel(taskKey, message = "排队任务已由用户取消") {
    const normalizedTaskKey = safeKey(taskKey);
    if (!normalizedTaskKey) return 0;
    const matches = [];
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (entry.taskKey === normalizedTaskKey) matches.push(entry);
      }
    }
    for (const entry of matches) {
      if (!this.removeQueuedEntry(entry)) continue;
      const error = admissionError(
        "ERR_TASK_ADMISSION_CANCELLED",
        message,
        409,
      );
      entry.onRejected?.(error);
      entry.reject(error);
    }
    if (matches.length) this.drain();
    return matches.length;
  }

  async runExclusiveFor(taskKey, operation) {
    if (typeof taskKey !== "string" || !taskKey || typeof operation !== "function") {
      throw new TypeError("runExclusiveFor requires a task key and operation");
    }
    if (
      this.maintenance
      || this.queuedCount > 0
      || this.reservations.size > 0
      || this.activeEntries().some((entry) => entry.taskKey !== taskKey)
    ) {
      return { executed: false, result: null };
    }
    this.maintenance = true;
    try {
      if (
        this.queuedCount > 0
        || this.reservations.size > 0
        || this.activeEntries().some((entry) => entry.taskKey !== taskKey)
      ) {
        return { executed: false, result: null };
      }
      return { executed: true, result: await operation() };
    } finally {
      this.maintenance = false;
      this.drain();
    }
  }

  snapshot() {
    const usage = this.usage();
    const maxActive = resolvePositiveInteger(this.maxActive, "maxActive");
    const maxActivePerProject = resolvePositiveInteger(this.maxActivePerProject, "maxActivePerProject");
    return {
      active: usage.total,
      reserved: this.reservations.size,
      queued: this.queuedCount,
      maxActive,
      maxActivePerProject,
      maxQueued: this.maxQueued,
      admissionOpen: !this.maintenance && this.admissionOpen(),
    };
  }

  canAdmit(metadata) {
    const usage = this.usage();
    return usage.total < resolvePositiveInteger(this.maxActive, "maxActive")
      && (usage.byProject.get(metadata.projectKey) || 0) < resolvePositiveInteger(this.maxActivePerProject, "maxActivePerProject");
  }

  grant(metadata) {
    const id = `task-admission-${this.nextPermitId++}`;
    const permit = {
      id,
      taskKey: metadata.taskKey,
      projectKey: metadata.projectKey,
      reserved: true,
      replay: false,
      timer: null,
    };
    if (this.reservationTtlMs !== null) {
      permit.timer = this.setTimer(() => {
        permit.timer = null;
        if (this.reservations.delete(id)) this.drain();
      }, this.reservationTtlMs);
      permit.timer?.unref?.();
    }
    this.reservations.set(id, permit);
    this.lastGrantedProject = metadata.projectKey;
    metadata.onAdmitted?.(this.snapshot());
    return permit;
  }

  drain() {
    if (this.maintenance || !this.admissionOpen() || this.queuedCount === 0) return;
    let granted = true;
    while (granted && this.queuedCount > 0 && !this.maintenance && this.admissionOpen()) {
      granted = false;
      const projects = [...this.queues.keys()];
      if (!projects.length) return;
      const lastIndex = this.lastGrantedProject === null
        ? -1
        : projects.indexOf(this.lastGrantedProject);
      for (let offset = 1; offset <= projects.length; offset += 1) {
        const projectKey = projects[(lastIndex + offset + projects.length) % projects.length];
        const queue = this.queues.get(projectKey);
        const entry = queue?.[0];
        if (!entry || !this.canAdmit(entry)) continue;
        queue.shift();
        this.queuedCount -= 1;
        if (!queue.length) this.queues.delete(projectKey);
        entry.settled = true;
        if (entry.timer) this.clearTimer(entry.timer);
        entry.resolve(this.grant(entry));
        granted = true;
        break;
      }
    }
  }

  usage() {
    const entries = this.activeEntries();
    const byTask = new Map(entries.map((entry) => [entry.taskKey, entry]));
    for (const permit of this.reservations.values()) {
      if (!byTask.has(permit.taskKey)) byTask.set(permit.taskKey, permit);
    }
    const byProject = new Map();
    for (const entry of byTask.values()) {
      byProject.set(entry.projectKey, (byProject.get(entry.projectKey) || 0) + 1);
    }
    return { total: byTask.size, byProject };
  }

  activeEntries() {
    const entries = [];
    for (const task of this.activeTasks() || []) {
      const status = String(task?.status || "");
      if (status && !DEFAULT_ACTIVE_STATUSES.has(status)) continue;
      const taskKey = safeKey(task?.taskKey || task?.threadId);
      if (!taskKey) continue;
      entries.push({
        taskKey,
        projectKey: safeKey(task?.projectKey || task?.cwd) || `thread:${taskKey}`,
      });
    }
    return entries;
  }

  removeQueuedEntry(entry) {
    if (entry.settled) return false;
    const queue = this.queues.get(entry.projectKey);
    const index = queue?.indexOf(entry) ?? -1;
    if (index < 0) return false;
    queue.splice(index, 1);
    if (!queue.length) this.queues.delete(entry.projectKey);
    this.queuedCount = Math.max(0, this.queuedCount - 1);
    entry.settled = true;
    if (entry.timer) this.clearTimer(entry.timer);
    return true;
  }
}

function normalizeMetadata(metadata) {
  const taskKey = safeKey(metadata.taskKey);
  if (!taskKey) throw new TypeError("Task admission requires a task key");
  return {
    taskKey,
    projectKey: safeKey(metadata.projectKey) || `thread:${taskKey}`,
    replay: metadata.replay === true,
    onQueued: typeof metadata.onQueued === "function" ? metadata.onQueued : null,
    onAdmitted: typeof metadata.onAdmitted === "function" ? metadata.onAdmitted : null,
    onRejected: typeof metadata.onRejected === "function" ? metadata.onRejected : null,
  };
}

function safeKey(value) {
  return typeof value === "string" && value && !/[\u0000\r\n]/.test(value)
    ? value.slice(0, 4_096)
    : null;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function positiveIntegerSource(value, name) {
  if (typeof value === "function") return value;
  return positiveInteger(value, name);
}

function resolvePositiveInteger(source, name) {
  return positiveInteger(typeof source === "function" ? source() : source, name);
}

function admissionError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
