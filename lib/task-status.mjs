const ACTIVE_STATES = new Set(["queued", "running", "waiting", "stopping", "uncertain"]);
const GLOBAL_TASK_KEY = "\u0000global";
const MAX_TRACKED_TASKS = 512;
const FINISHED_RETENTION_MS = 60 * 60 * 1000;

export class TaskStatusTracker {
  constructor(now = () => Date.now(), { allowSyntheticThreadActive = true } = {}) {
    this.now = now;
    this.allowSyntheticThreadActive = allowSyntheticThreadActive;
    this.states = new Map();
    // Keep permission bindings private; task snapshots are exposed to the
    // browser and must not carry execution capability details.
    this.executionContexts = new Map();
    // Thread settings outlive an individual Turn. They are kept separately
    // so the next Turn can inherit a thread-level policy without exposing it
    // through browser task snapshots.
    this.threadExecutionContexts = new Map();
    this.threadByTurnId = new Map();
    this.approvalThreadById = new Map();
    this.lastTaskKey = null;
  }

  snapshot(threadId = null) {
    this.prune();
    const activeTasks = [...this.states.values()].filter((state) => ACTIVE_STATES.has(state.status)).length;
    if (threadId) {
      const state = this.states.get(threadId) || this.createState("idle", "idle", threadId);
      return { ...state, activeTasks, observedAt: this.now() };
    }
    const last = this.states.get(this.lastTaskKey);
    const active = ACTIVE_STATES.has(last?.status)
      ? last
      : [...this.states.values()]
        .filter((state) => ACTIVE_STATES.has(state.status))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const latest = active || this.states.get(this.lastTaskKey) || this.createState("idle", "idle", null);
    return { ...latest, activeTasks, observedAt: this.now() };
  }

  list({ limit = 100 } = {}) {
    this.prune();
    const boundedLimit = Math.max(1, Math.min(512, Number(limit) || 100));
    const threadStates = [...this.states.values()]
      .filter((state) => typeof state.threadId === "string" && state.threadId)
      .sort((left, right) => (
        Number(ACTIVE_STATES.has(right.status)) - Number(ACTIVE_STATES.has(left.status))
        || right.updatedAt - left.updatedAt
      ));
    const activeTasks = threadStates.filter((state) => ACTIVE_STATES.has(state.status)).length;
    const tasks = threadStates
      .slice(0, boundedLimit)
      .map((state) => ({ ...state }));
    return {
      tasks,
      activeTasks,
      observedAt: this.now(),
    };
  }

  hasActiveTasks() {
    return [...this.states.values()].some((state) => ACTIVE_STATES.has(state.status));
  }

  hasOtherActiveTasks(threadId) {
    return [...this.states.values()].some((state) => (
      ACTIVE_STATES.has(state.status)
      && state.threadId !== threadId
    ));
  }

  threadIsActive(threadId) {
    return ACTIVE_STATES.has(this.states.get(threadId)?.status);
  }

  uncertainThreadIds() {
    return [...this.states.values()]
      .filter((state) => state.status === "uncertain" && state.threadId)
      .map((state) => state.threadId);
  }

  submissionIsUncertain(threadId, clientSubmissionId) {
    const state = this.states.get(threadId);
    return Boolean(
      state?.status === "uncertain"
      && validClientSubmissionId(clientSubmissionId)
      && state.clientSubmissionId === clientSubmissionId
    );
  }

  submissionIsQueued(threadId, clientSubmissionId) {
    const state = this.states.get(threadId);
    return Boolean(
      state?.status === "queued"
      && validClientSubmissionId(clientSubmissionId)
      && state.clientSubmissionId === clientSubmissionId
    );
  }

  moveThread(previousThreadId, nextThreadId) {
    if (
      typeof previousThreadId !== "string"
      || !previousThreadId
      || typeof nextThreadId !== "string"
      || !nextThreadId
      || previousThreadId === nextThreadId
    ) return false;
    const state = this.states.get(previousThreadId);
    if (!state) return false;
    this.states.delete(previousThreadId);
    this.states.set(nextThreadId, { ...state, threadId: nextThreadId, updatedAt: this.now() });
    const context = this.executionContexts.get(previousThreadId);
    if (context) {
      this.executionContexts.delete(previousThreadId);
      this.executionContexts.set(nextThreadId, context);
    }
    const threadContext = this.threadExecutionContexts.get(previousThreadId);
    if (threadContext) {
      this.threadExecutionContexts.delete(previousThreadId);
      this.threadExecutionContexts.set(nextThreadId, threadContext);
    }
    for (const [turnId, key] of this.threadByTurnId) {
      if (key === previousThreadId) this.threadByTurnId.set(turnId, nextThreadId);
    }
    for (const [approvalId, key] of this.approvalThreadById) {
      if (key === previousThreadId) this.approvalThreadById.set(approvalId, nextThreadId);
    }
    if (this.lastTaskKey === previousThreadId) this.lastTaskKey = nextThreadId;
    return true;
  }

  start({
    threadId = null,
    turnId = null,
    cwd = null,
    clientSubmissionId = null,
  } = {}) {
    const timestamp = this.now();
    const key = this.taskKey(threadId, turnId);
    const queuedAt = this.states.get(key)?.status === "queued"
      ? this.states.get(key).queuedAt
      : null;
    this.clearApprovals(key);
    this.clearTurnIds(key);
    this.executionContexts.delete(key);
    this.states.set(key, {
      status: "running",
      phase: "starting",
      threadId: this.publicThreadId(key),
      turnId,
      cwd: validCwd(cwd),
      clientSubmissionId: validClientSubmissionId(clientSubmissionId)
        ? clientSubmissionId
        : null,
      queuedAt: Number.isFinite(queuedAt) ? queuedAt : null,
      startedAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    });
    if (turnId) this.threadByTurnId.set(turnId, key);
    this.lastTaskKey = key;
    this.prune();
  }

  queued({
    threadId = null,
    cwd = null,
    clientSubmissionId = null,
  } = {}) {
    const timestamp = this.now();
    const key = this.taskKey(threadId, null);
    const current = this.states.get(key);
    if (
      current?.status === "queued"
      && validClientSubmissionId(clientSubmissionId)
      && current.clientSubmissionId === clientSubmissionId
    ) return false;
    this.clearApprovals(key);
    this.clearTurnIds(key);
    this.executionContexts.delete(key);
    this.states.set(key, {
      status: "queued",
      phase: "queued",
      threadId: this.publicThreadId(key),
      turnId: null,
      cwd: validCwd(cwd),
      clientSubmissionId: validClientSubmissionId(clientSubmissionId)
        ? clientSubmissionId
        : null,
      queuedAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      finishedAt: null,
    });
    this.lastTaskKey = key;
    this.prune();
    return true;
  }

  started({ threadId = null, turn = null, cwd = null } = {}) {
    const key = this.taskKey(threadId, turn?.id);
    const current = this.states.get(key);
    // A replayed turn/started for the same already-terminal Turn must not
    // resurrect a completed/interrupted task after reconnect or pagination
    // recovery. A genuinely new Turn has a different ID and still starts.
    if (
      current
      && !ACTIVE_STATES.has(current.status)
      && current.turnId
      && turn?.id
      && current.turnId === turn.id
    ) return;
    // Once an interrupt has been issued, the tracked Turn identity is the
    // fence for every later completion, reconciliation and watchdog event.
    // A replayed/newer turn/started notification must not replace it while
    // the old Turn is still stopping, or the original interrupt can never
    // converge to a terminal state.
    if (current?.status === "stopping") {
      if (turn?.id && current.turnId && turn.id !== current.turnId) return;
      if (turn?.id && (!current.turnId || current.turnId === turn.id)) {
        this.threadByTurnId.set(turn.id, key);
      }
      this.update(key, {
        status: "stopping",
        phase: "stopping",
        threadId: this.publicThreadId(key),
        turnId: current.turnId || turn?.id || null,
        cwd: validCwd(cwd) || current.cwd,
      });
      return;
    }
    // A delayed turn/started from an older Turn must not replace the identity
    // of the Turn that is currently tracked for this Thread.
    if (
      current
      && ACTIVE_STATES.has(current.status)
      && current.turnId
      && turn?.id
      && current.turnId !== turn.id
    ) return;
    if (!current || !ACTIVE_STATES.has(current.status)) {
      this.start({ threadId, turnId: turn?.id || null, cwd });
    }
    if (turn?.id) this.threadByTurnId.set(turn.id, key);
    this.update(key, {
      status: "running",
      phase: "working",
      threadId: this.publicThreadId(key),
      turnId: turn?.id || this.states.get(key)?.turnId,
      cwd: validCwd(cwd) || this.states.get(key)?.cwd,
    });
  }

  stopping({ threadId = null, turnId = null } = {}) {
    const key = this.activeKey(threadId, turnId);
    if (!key) return;
    this.update(key, { status: "stopping", phase: "stopping", turnId });
  }

  interruptFailed({ threadId = null, turnId = null } = {}) {
    const key = this.taskKey(threadId, turnId);
    const state = this.states.get(key);
    if (state?.status !== "stopping") return;
    if (turnId && state.turnId && turnId !== state.turnId) return;
    this.update(key, { status: "running", phase: "working" });
  }

  setExecutionContext({ threadId = null, turnId = null, context = null } = {}) {
    const key = this.taskKey(threadId, turnId);
    const state = this.states.get(key);
    if (!state || !ACTIVE_STATES.has(state.status)) return false;
    if (turnId && state.turnId && state.turnId !== turnId) return false;
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      this.executionContexts.delete(key);
      return false;
    }
    const snapshot = { ...context };
    this.executionContexts.set(key, snapshot);
    if (state.threadId) this.threadExecutionContexts.set(state.threadId, { ...snapshot });
    return true;
  }

  executionContext({ threadId = null, turnId = null } = {}) {
    const key = this.activeKey(threadId, turnId);
    if (!key) return null;
    const context = this.executionContexts.get(key);
    return context ? { ...context } : null;
  }

  setThreadExecutionContext({ threadId = null, context = null } = {}) {
    if (typeof threadId !== "string" || !threadId) return false;
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      this.threadExecutionContexts.delete(threadId);
      return false;
    }
    this.threadExecutionContexts.set(threadId, { ...context });
    while (this.threadExecutionContexts.size > MAX_TRACKED_TASKS) {
      this.threadExecutionContexts.delete(this.threadExecutionContexts.keys().next().value);
    }
    return true;
  }

  threadExecutionContext({ threadId = null } = {}) {
    if (typeof threadId !== "string" || !threadId) return null;
    const context = this.threadExecutionContexts.get(threadId);
    return context ? { ...context } : null;
  }

  clearThreadExecutionContext(threadId = null) {
    if (typeof threadId !== "string" || !threadId) return false;
    return this.threadExecutionContexts.delete(threadId);
  }

  clearThreadExecutionContexts(threadId = null) {
    if (typeof threadId !== "string" || !threadId) return false;
    const keys = new Set([threadId]);
    const state = this.states.get(threadId);
    if (state?.threadId) keys.add(state.threadId);
    for (const [key, candidate] of this.states) {
      if (candidate.threadId === threadId) keys.add(key);
    }
    let cleared = false;
    for (const key of keys) {
      cleared = this.executionContexts.delete(key) || cleared;
      this.clearApprovals(key);
      this.clearTurnIds(key);
    }
    for (const [turnId, key] of this.threadByTurnId) {
      if (keys.has(key)) {
        this.threadByTurnId.delete(turnId);
        cleared = true;
      }
    }
    cleared = this.threadExecutionContexts.delete(threadId) || cleared;
    return cleared;
  }

  notification({ method, params = {} } = {}) {
    if (method === "thread/status/changed") {
      const status = typeof params.status === "object" ? params.status.type : params.status;
      if (status === "active") {
        const key = this.taskKey(params.threadId, null);
        if (!ACTIVE_STATES.has(this.states.get(key)?.status)) {
          // Main and rescue runtimes disable synthesis because a freshly
          // started app-server can replay an old persisted "active" status.
          // Tests and standalone consumers retain the legacy recovery mode.
          if (!this.allowSyntheticThreadActive) return;
          this.start({ threadId: params.threadId });
        }
        if (this.states.get(key)?.status === "stopping") return;
        const waiting = Array.isArray(params.status?.activeFlags)
          && params.status.activeFlags.some((flag) =>
            ["waitingOnApproval", "waitingOnUserInput"].includes(flag));
        this.update(key, {
          status: waiting ? "waiting" : "running",
          phase: waiting ? "approval" : "working",
        });
        return;
      }
      if (status === "systemError") {
        if (this.states.get(this.taskKey(params.threadId, null))?.turnId) return;
        this.finish("failed", params.threadId, null);
        return;
      }
      if (["idle", "notLoaded"].includes(status)) {
        if (this.states.get(this.taskKey(params.threadId, null))?.turnId) return;
        this.finish("completed", params.threadId, null);
        return;
      }
    }
    if (method === "thread/closed") {
      // A closed/unloaded Thread notification can be delayed across a
      // reconnect. It is not evidence that an identified Turn completed.
      if (this.states.get(this.taskKey(params.threadId, null))?.turnId) return;
      this.finish("completed", params.threadId, null);
      return;
    }
    if (method === "turn/started") {
      this.started({ threadId: params.threadId, turn: params.turn });
      return;
    }
    if (method === "turn/completed") {
      this.finish(turnResultStatus(params.turn), params.threadId, params.turn?.id);
      return;
    }
    if (method === "item/started") {
      const key = this.activeKey(params.threadId, params.turnId);
      if (!key) return;
      this.update(key, { phase: itemPhase(params.item?.type, params.item) });
      return;
    }
    if (method === "item/agentMessage/delta") {
      const key = this.activeKey(params.threadId, params.turnId);
      if (!key) return;
      this.update(key, { phase: "responding" });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const key = this.activeKey(params.threadId, params.turnId);
      if (!key) return;
      this.update(key, { phase: "command" });
      return;
    }
    if (method === "thread/compacted") {
      const key = this.activeKey(params.threadId, params.turnId);
      if (!key) return;
      this.update(key, { phase: "compacting" });
      return;
    }
    if (method === "error" && !params.willRetry) {
      this.finish("failed", params.threadId, params.turnId);
    }
  }

  serverRequest(request = {}) {
    const key = this.activeKey(request.params?.threadId, request.params?.turnId);
    if (!key) return;
    this.approvalThreadById.set(String(request.id), key);
    this.update(key, { status: "waiting", phase: "approval" });
  }

  serverResponse(id) {
    const approvalId = String(id);
    const key = this.approvalThreadById.get(approvalId);
    if (!key) return;
    this.approvalThreadById.delete(approvalId);
    const waitingForSameTask = [...this.approvalThreadById.values()].some((candidate) => candidate === key);
    if (this.states.get(key)?.status === "waiting" && !waitingForSameTask) {
      this.update(key, { status: "running", phase: "working" });
    }
  }

  bridgeStatus(status) {
    if (status === "offline") {
      for (const [key, state] of [...this.states]) {
        if (!ACTIVE_STATES.has(state.status)) continue;
        if (state.status === "queued") {
          this.clearApprovals(key);
          this.update(key, { phase: "reconnecting" });
          continue;
        }
        if (state.status === "uncertain") {
          this.clearApprovals(key);
          this.update(key, { phase: "reconnecting" });
          continue;
        }
        this.finish("failed", state.threadId, state.turnId);
      }
      return;
    }
    if (status !== "starting") return;
    for (const [key, state] of this.states) {
      if (ACTIVE_STATES.has(state.status)) this.update(key, { phase: "reconnecting" });
    }
  }

  fail({ threadId = null, turnId = null } = {}) {
    this.finish("failed", threadId, turnId);
  }

  deliveryUnknown({
    threadId = null,
    turnId = null,
    clientSubmissionId = null,
  } = {}) {
    const key = this.activeKey(threadId, turnId) || this.taskKey(threadId, turnId);
    const state = this.states.get(key);
    if (!state) {
      this.start({ threadId, turnId, clientSubmissionId });
    }
    const current = this.states.get(key);
    // Keep an in-flight interrupt fenced to its original Turn. Converting it
    // to `uncertain` would disable the interrupt watchdog and leave the task
    // active forever when the original completion notification is delayed.
    if (current?.status === "stopping") {
      this.update(key, {
        phase: "reconciling",
        turnId: current.turnId || turnId || null,
        clientSubmissionId: validClientSubmissionId(clientSubmissionId)
          ? clientSubmissionId
          : current.clientSubmissionId,
      });
      return;
    }
    this.update(key, {
      status: "uncertain",
      phase: "reconciling",
      turnId: turnId || this.states.get(key)?.turnId,
      clientSubmissionId: validClientSubmissionId(clientSubmissionId)
        ? clientSubmissionId
        : this.states.get(key)?.clientSubmissionId,
    });
  }

  finish(status, threadId, turnId) {
    const key = this.activeKey(threadId, turnId);
    if (!key) return false;
    this.clearApprovals(key);
    const timestamp = this.now();
    this.states.set(key, {
      ...this.states.get(key),
      status,
      phase: status,
      threadId: this.publicThreadId(key),
      turnId: turnId || this.states.get(key)?.turnId || null,
      updatedAt: timestamp,
      finishedAt: timestamp,
    });
    this.executionContexts.delete(key);
    this.clearTurnIds(key);
    this.lastTaskKey = key;
    this.prune();
    return true;
  }

  update(key, values) {
    const current = this.states.get(key) || this.createState("idle", "idle", this.publicThreadId(key));
    this.states.delete(key);
    this.states.set(key, {
      ...current,
      ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)),
      updatedAt: this.now(),
    });
    this.lastTaskKey = key;
  }

  taskKey(threadId, turnId) {
    if (typeof threadId === "string" && threadId) return threadId;
    if (typeof turnId === "string" && this.threadByTurnId.has(turnId)) return this.threadByTurnId.get(turnId);
    return GLOBAL_TASK_KEY;
  }

  activeKey(threadId, turnId) {
    if (typeof turnId === "string" && turnId) {
      const mapped = this.threadByTurnId.get(turnId);
      const mappedState = this.states.get(mapped);
      const threadMatches = !(typeof threadId === "string" && threadId) || mapped === threadId;
      if (
        mapped
        && threadMatches
        && ACTIVE_STATES.has(mappedState?.status)
        && (!mappedState.turnId || mappedState.turnId === turnId)
      ) return mapped;
    }

    const key = typeof threadId === "string" && threadId ? threadId : GLOBAL_TASK_KEY;
    const state = this.states.get(key);
    if (!ACTIVE_STATES.has(state?.status)) return null;
    if (typeof turnId === "string" && turnId && state.turnId && state.turnId !== turnId) return null;
    return key;
  }

  publicThreadId(key) {
    return key === GLOBAL_TASK_KEY ? null : key;
  }

  clearApprovals(key) {
    for (const [id, approvalKey] of this.approvalThreadById) {
      if (approvalKey === key) this.approvalThreadById.delete(id);
    }
  }

  clearTurnIds(key) {
    for (const [turnId, taskKey] of this.threadByTurnId) {
      if (taskKey === key) this.threadByTurnId.delete(turnId);
    }
  }

  prune() {
    const expiry = this.now() - FINISHED_RETENTION_MS;
    for (const [key, state] of this.states) {
      if (!ACTIVE_STATES.has(state.status) && state.updatedAt < expiry) this.deleteState(key);
    }
    if (this.states.size <= MAX_TRACKED_TASKS) return;
    for (const [key, state] of this.states) {
      if (ACTIVE_STATES.has(state.status)) continue;
      this.deleteState(key);
      if (this.states.size <= MAX_TRACKED_TASKS) break;
    }
  }

  deleteState(key) {
    this.states.delete(key);
    this.executionContexts.delete(key);
    this.clearTurnIds(key);
    this.clearApprovals(key);
    if (this.lastTaskKey === key) this.lastTaskKey = null;
  }

  createState(status, phase, threadId) {
    const timestamp = this.now();
    return {
      status,
      phase,
      threadId,
      turnId: null,
      cwd: null,
      clientSubmissionId: null,
      queuedAt: null,
      startedAt: null,
      updatedAt: timestamp,
      finishedAt: null,
    };
  }
}

function validCwd(value) {
  return typeof value === "string" && value && !/[\r\n\0]/.test(value)
    ? value.slice(0, 4_096)
    : null;
}

function validClientSubmissionId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000\r\n]/.test(value);
}

function itemPhase(type, item = null) {
  return {
    reasoning: "thinking",
    agentMessage: "responding",
    commandExecution: "command",
    fileChange: "fileChange",
    mcpToolCall: "tool",
    collabAgentToolCall: "collaboration",
    subAgentActivity: "collaboration",
    webSearch: "webSearch",
    imageGeneration: "imageGeneration",
    contextCompaction: "compacting",
    plan: "planning",
  }[type] || "working";
}

function turnResultStatus(turn) {
  const status = typeof turn?.status === "object" ? turn.status.type : turn?.status;
  if (["failed", "error"].includes(status)) return "failed";
  if (["interrupted", "cancelled", "canceled"].includes(status)) return "interrupted";
  return "completed";
}
