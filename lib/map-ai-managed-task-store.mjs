import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAP_AI_APPROVAL_POLICIES, MAP_AI_RISK_RULE_VERSION } from "./map-ai-risk.mjs";
import { normalizeProtectedTargets } from "./map-ai-protected-targets.mjs";
import { collaborationPolicySnapshot, normalizeCollaborationPolicyInput, publicCollaborationPolicy } from "./map-collaboration-policy-store.mjs";

const STORE_VERSION = 1;
const DEFAULT_MAX_TASKS = 1_000;
const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_TEXT = 2_000;
const MAX_ID = 512;
const SHA256 = /^[a-f0-9]{64}$/iu;
const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_approval", "cancel_requested"]);
const RESUMABLE_STATUSES = new Set(["paused", "interrupted"]);
const FINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "conflict"]);
const STATUSES = new Set([
  ...ACTIVE_STATUSES,
  ...RESUMABLE_STATUSES,
  ...FINAL_STATUSES,
]);
const CHECKPOINT_PHASES = new Set(["started", "awaiting_approval", "committed", "failed"]);
const TRANSITIONS = new Set(["approve", "reject", "pause", "resume", "cancel", "takeover"]);
const RESOURCE_PATCH_FORMAT = "wfl-tiled-resource-patch";

export const MAP_AI_MANAGED_TASK_STORE_VERSION = STORE_VERSION;
export const MAP_AI_MANAGED_TASK_STATUSES = Object.freeze([...STATUSES]);

export class MapAiManagedTaskError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapAiManagedTaskError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Persistent state machine for managed map-AI work.
 *
 * This store deliberately has no map-file handle and no runner. It records a
 * versioned task contract and bounded checkpoints so a future executor can
 * use the existing map-save transaction without making browser state or a
 * process restart an implicit authorization to write.
 */
export class MapAiManagedTaskStore {
  constructor(stateDirectory, options = {}) {
    if (!stateDirectory || typeof stateDirectory !== "string") throw new TypeError("stateDirectory is required");
    this.filePath = path.join(path.resolve(stateDirectory), "map-ai-managed-tasks.json");
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.maxTasks = boundedInteger(options.maxTasks, DEFAULT_MAX_TASKS, 1, 100_000, "maxTasks");
    this.maxEvents = boundedInteger(options.maxEvents, DEFAULT_MAX_EVENTS, 8, 2_000, "maxEvents");
    this.ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 1_000, 7 * 24 * 60 * 60 * 1000, "ttlMs");
    this.tasks = new Map();
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700);
    const loaded = await readState(this.filePath, {
      maxTasks: this.maxTasks,
      maxEvents: this.maxEvents,
    });
    this.tasks = loaded.tasks;
    this.initialized = true;
    const now = this.now();
    let changed = loaded.normalized;
    for (const task of this.tasks.values()) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      // A cancellation is durable intent, not an unknown in-flight state.
      // Do not turn it into `interrupted` during restart, because that would
      // expose the explicit-resume path and let an already revoked task run
      // again after confirmation.
      if (task.status === "cancel_requested") {
        task.status = "canceled";
        task.completedAt = now;
        task.updatedAt = now;
        task.pauseRequested = true;
        task.error = {
          code: "MAP_AI_TASK_CANCELLED",
          message: "服务重启时保留了撤销请求，任务不会自动恢复",
        };
        appendEvent(task, "canceled", { reason: "server-restarted-after-cancel" }, this.maxEvents, now);
        changed = true;
        continue;
      }
      task.status = "interrupted";
      task.updatedAt = now;
      task.error = {
        code: "MAP_AI_TASK_RESTARTED_UNKNOWN_COMMIT",
        message: "服务重启，任务未自动重放；请先核对地图当前版本和批次状态",
      };
      appendEvent(task, "interrupted", { reason: "server-restarted-unknown-commit" }, this.maxEvents, now);
      changed = true;
    }
    if (writeOnInitialize && (changed || !await fileExists(this.filePath))) await this.write();
    return this;
  }

  async create(input = {}) {
    this.assertInitialized();
    const normalized = normalizeCreateInput(input, this.now(), this.ttlMs);
    return this.mutate(async () => {
      this.pruneExpired();
      const existing = [...this.tasks.values()].find((task) => (
        sameIdentity(task.identity, normalized.identity)
        && task.clientOperationId === normalized.clientOperationId
      ));
      if (existing) {
        if (existing.requestHash !== normalized.requestHash) {
          throw taskError(409, "MAP_AI_TASK_OPERATION_CONFLICT", "任务幂等标识已用于不同的托管计划");
        }
        return { created: false, task: publicTask(existing) };
      }
      this.evictFinalTasksForCapacity();
      if (this.tasks.size >= this.maxTasks) {
        throw taskError(429, "MAP_AI_TASK_CAPACITY", "地图 AI 托管任务已达到管理员设置的上限");
      }
      const now = this.now();
      const task = {
        id: crypto.randomBytes(24).toString("base64url"),
        identity: normalized.identity,
        authority: normalized.authority,
        approvalSnapshot: normalized.approvalSnapshot,
        settingsSnapshot: normalized.settingsSnapshot,
        clientOperationId: normalized.clientOperationId,
        requestHash: normalized.requestHash,
        plan: normalized.request,
        planSummary: normalized.planSummary,
        status: "queued",
        controlMode: "ai",
        currentVersion: normalized.authority.baseVersion,
        currentVersions: { ...normalized.authority.targetFileVersions },
        nextOperationIndex: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: normalized.expiresAt,
        startedAt: null,
        completedAt: null,
        pauseRequested: false,
        approvalOverride: false,
        checkpointSeq: 0,
        checkpoints: [],
        events: [],
        error: null,
      };
      appendEvent(task, "created", {
        policy: task.approvalSnapshot.policy,
        riskRuleVersion: task.approvalSnapshot.riskRuleVersion,
      }, this.maxEvents, now);
      this.tasks.set(task.id, task);
      await this.write();
      return { created: true, task: publicTask(task) };
    });
  }

  snapshot(input = {}) {
    this.assertInitialized();
    this.pruneExpired();
    return publicTask(this.requireTask(input.taskId, input.identity));
  }

  /** Internal executor view. Never return this object directly to a client. */
  executionContract(input = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const task = this.requireTask(input.taskId, input.identity);
    return Object.freeze({
      id: task.id,
      identity: { ...task.identity },
      authority: structuredClone(task.authority),
      approvalSnapshot: structuredClone(task.approvalSnapshot),
      settingsSnapshot: structuredClone(task.settingsSnapshot),
      plan: task.plan === null ? null : structuredClone(task.plan),
      planSummary: { ...task.planSummary },
      status: task.status,
      controlMode: task.controlMode,
      currentVersion: task.currentVersion,
      currentVersions: { ...(task.currentVersions || { [task.authority.mapPath]: task.currentVersion }) },
      nextOperationIndex: task.nextOperationIndex,
      pauseRequested: task.pauseRequested,
      approvalOverride: task.approvalOverride === true,
      expiresAt: task.expiresAt,
    });
  }

  eventsSince({ taskId, identity, after = 0, limit = 100 } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const task = this.requireTask(taskId, identity);
    const afterSeq = boundedInteger(after, 0, 0, 10_000_000, "after");
    const max = boundedInteger(limit, 100, 1, 500, "limit");
    const firstPersistedSeq = task.events[0]?.seq || 0;
    const latestPersistedSeq = task.events.at(-1)?.seq || 0;
    const gap = firstPersistedSeq > 0 && afterSeq < firstPersistedSeq - 1;
    const events = task.events
      .filter((event) => event.seq > afterSeq)
      .slice(0, max)
      .map((event) => ({ ...event, details: structuredClone(event.details) }));
    const nextAfter = events.at(-1)?.seq || afterSeq;
    const terminal = FINAL_STATUSES.has(task.status);
    return {
      taskId: task.id,
      checkpointSeq: task.checkpointSeq,
      oldestEventSeq: firstPersistedSeq,
      latestEventSeq: latestPersistedSeq,
      nextAfter,
      hasMore: nextAfter < latestPersistedSeq,
      gap,
      resyncRequired: gap,
      snapshotRequired: gap || terminal,
      // A gap or a terminal state must be recoverable without depending on a
      // second request racing task expiry.  The public snapshot is bounded
      // and never contains the private executable plan or filesystem paths.
      snapshot: gap || terminal ? publicTask(task) : null,
      events,
    };
  }

  /** Return only a bounded structured impact receipt, never the full plan. */
  diff({ taskId, identity, checkpointSeq = null } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const task = this.requireTask(taskId, identity);
    const checkpoints = task.checkpoints;
    const selected = checkpointSeq == null
      ? checkpoints.at(-1) || null
      : checkpoints.find((entry) => entry.seq === boundedInteger(checkpointSeq, 0, 0, 10_000_000, "checkpointSeq")) || null;
    if (!selected) {
      return { taskId: task.id, checkpointSeq: null, baseVersion: task.currentVersion, targetVersion: task.currentVersion, risk: null, diff: null, validation: null };
    }
    return {
      taskId: task.id,
      checkpointSeq: selected.seq,
      phase: selected.phase,
      baseVersion: selected.baseVersion,
      targetVersion: selected.targetVersion,
      risk: structuredClone(selected.risk),
      diff: structuredClone(selected.diff),
      validation: structuredClone(selected.validation),
    };
  }

  list(input = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const identity = normalizeIdentity(input.identity);
    const limit = boundedInteger(input.limit, 100, 1, 500, "limit");
    const threadId = input.threadId == null ? null : boundedText(input.threadId, "threadId", 1, MAX_ID);
    return [...this.tasks.values()]
      .filter((task) => sameIdentity(task.identity, identity))
      .filter((task) => threadId === null || task.authority.projectWide === true || task.authority.threadId === threadId)
      .sort((left, right) => right.createdAt - left.createdAt || compareText(right.id, left.id))
      .slice(0, limit)
      .map(publicTask);
  }

  async cancelForBrowserSession({ userId, browserSessionId } = {}) {
    const identity = normalizeIdentity({ userId, browserSessionId });
    const tasks = [...this.tasks.values()].filter((task) => sameIdentity(task.identity, identity) && !FINAL_STATUSES.has(task.status));
    for (const task of tasks) {
      await this.transition({ identity, taskId: task.id, action: "cancel" });
    }
    return Object.freeze({ canceled: tasks.length });
  }

  async cancelForUser({ userId } = {}) {
    const normalizedUserId = boundedText(userId, "userId", 1, MAX_ID);
    const tasks = [...this.tasks.values()].filter((task) => task.identity.userId === normalizedUserId && !FINAL_STATUSES.has(task.status));
    for (const task of tasks) {
      await this.transition({ identity: task.identity, taskId: task.id, action: "cancel" });
    }
    return Object.freeze({ canceled: tasks.length });
  }

  async cancelForAuthorization({ authorizationId, threadId = null, reason = "托管授权已撤销" } = {}) {
    const normalizedAuthorizationId = boundedText(authorizationId, "authorizationId", 1, MAX_ID);
    const normalizedThreadId = threadId == null ? null : boundedText(threadId, "threadId", 1, MAX_ID);
    const normalizedReason = boundedText(reason, "reason", 1, MAX_TEXT);
    const tasks = [...this.tasks.values()].filter((task) => (
      task.authority.managedAuthorizationId === normalizedAuthorizationId
      && (normalizedThreadId === null || task.authority.threadId === normalizedThreadId)
      && !FINAL_STATUSES.has(task.status)
    ));
    for (const task of tasks) {
      await this.transition({
        identity: task.identity,
        taskId: task.id,
        action: "cancel",
        reason: normalizedReason,
      });
    }
    return Object.freeze({ canceled: tasks.length });
  }

  async transition(input = {}) {
    this.assertInitialized();
    const identity = normalizeIdentity(input.identity);
    const action = boundedText(input.action, "action", 1, 32);
    if (!TRANSITIONS.has(action)) throw taskError(400, "MAP_AI_TASK_ACTION_INVALID", "托管任务操作无效");
    return this.mutate(async () => {
      this.pruneExpired();
      const task = this.requireTask(input.taskId, identity);
      const now = this.now();
      switch (action) {
        case "approve":
          if (task.status !== "awaiting_approval") throw taskError(409, "MAP_AI_TASK_NOT_AWAITING_APPROVAL", "当前任务没有等待中的批准卡");
          task.status = "running";
          task.pauseRequested = false;
          task.approvalOverride = true;
          task.startedAt ||= now;
          appendEvent(task, "approved", { approvalId: boundedText(input.approvalId || task.id, "approvalId", 1, MAX_ID) }, this.maxEvents, now);
          break;
        case "reject":
          if (!ACTIVE_STATUSES.has(task.status) && !RESUMABLE_STATUSES.has(task.status)) throw taskError(409, "MAP_AI_TASK_FINAL", "任务已经结束，不能拒绝");
          task.status = "canceled";
          task.completedAt = now;
          task.error = { code: "MAP_AI_TASK_REJECTED", message: boundedText(input.reason || "用户拒绝了当前地图 AI 批次", "reason", 1, MAX_TEXT) };
          appendEvent(task, "rejected", { reason: task.error.message }, this.maxEvents, now);
          break;
        case "pause":
          if (!ACTIVE_STATUSES.has(task.status)) throw taskError(409, "MAP_AI_TASK_NOT_ACTIVE", "当前任务不能暂停");
          task.pauseRequested = true;
          if (task.status === "queued" || task.status === "awaiting_approval") task.status = "paused";
          appendEvent(task, "pause-requested", { afterCurrentBatch: task.status === "running" }, this.maxEvents, now);
          break;
        case "resume":
          if (!RESUMABLE_STATUSES.has(task.status)) throw taskError(409, "MAP_AI_TASK_NOT_RESUMABLE", "当前任务不能恢复");
          if (task.status === "interrupted" && input.confirmation !== task.id) {
            throw taskError(400, "MAP_AI_TASK_RESTART_CONFIRMATION_REQUIRED", "恢复重启后任务前必须显式确认未知提交状态");
          }
          task.status = "queued";
          task.pauseRequested = false;
          task.approvalOverride = false;
          task.error = null;
          appendEvent(task, "resumed", { confirmedUnknownCommit: input.confirmation === task.id }, this.maxEvents, now);
          break;
        case "cancel":
          if (FINAL_STATUSES.has(task.status)) return publicTask(task);
          if (task.status === "running") {
            task.status = "cancel_requested";
            task.pauseRequested = true;
          } else {
            task.status = "canceled";
            task.completedAt = now;
          }
          if (input.errorCode || input.errorMessage) {
            task.error = {
              code: boundedText(input.errorCode || "MAP_AI_TASK_CANCELLED", "errorCode", 1, 100),
              message: boundedText(input.errorMessage || input.reason || "托管任务已取消", "errorMessage", 1, MAX_TEXT),
            };
          }
          appendEvent(task, "cancel-requested", { afterCurrentBatch: task.status === "cancel_requested" }, this.maxEvents, now);
          break;
        case "takeover":
          if (!ACTIVE_STATUSES.has(task.status) && !RESUMABLE_STATUSES.has(task.status)) throw taskError(409, "MAP_AI_TASK_NOT_TAKEOVERABLE", "当前任务不能接管");
          task.controlMode = "human";
          task.pauseRequested = true;
          task.approvalOverride = false;
          if (task.status !== "running") task.status = "paused";
          appendEvent(task, "human-takeover", { reason: boundedText(input.reason || "用户接管托管任务", "reason", 1, MAX_TEXT) }, this.maxEvents, now);
          break;
        default:
          throw taskError(400, "MAP_AI_TASK_ACTION_INVALID", "托管任务操作无效");
      }
      task.updatedAt = now;
      if (FINAL_STATUSES.has(task.status)) task.completedAt ||= now;
      await this.write();
      return publicTask(task);
    });
  }

  async recordCheckpoint(input = {}) {
    this.assertInitialized();
    const identity = normalizeIdentity(input.identity);
    return this.mutate(async () => {
      this.pruneExpired();
      const task = this.requireTask(input.taskId, identity);
      const checkpoint = normalizeCheckpoint(input, task);
      const existing = task.checkpoints.find((entry) => entry.batchId === checkpoint.batchId);
      // A late worker callback is allowed to persist the receipt of a batch
      // that was already published before cancellation/revocation became
      // visible.  It must never revive a terminal task, however.  In
      // particular, a committed checkpoint arriving after `cancel` used to
      // turn `canceled` back into `queued`, making a cancelled task resumable
      // and allowing the executor to schedule another batch.
      if (FINAL_STATUSES.has(task.status) && checkpoint.phase !== "committed") {
        if (existing && JSON.stringify({ ...existing, seq: undefined }) === JSON.stringify(checkpoint)) {
          return publicTask(task);
        }
        throw taskError(409, "MAP_AI_TASK_FINAL", "任务已经结束，不能追加新的检查点");
      }
      if (FINAL_STATUSES.has(task.status) && checkpoint.phase === "committed") {
        const latest = task.checkpoints.at(-1) || null;
        const isCurrentBatch = latest?.batchId === checkpoint.batchId
          && ["started", "committed"].includes(latest.phase);
        if (!isCurrentBatch) {
          throw taskError(409, "MAP_AI_TASK_FINAL", "任务已经结束，不能追加新的提交批次");
        }
      }
      // Cancellation and human takeover are hard admission boundaries for a
      // new batch.  A callback for the batch that was already started may
      // still report `committed` (the atomic save can finish), but a late
      // `started`/approval checkpoint must never move a canceled or taken-over
      // task back to `running`.
      if ((task.status === "cancel_requested" || task.controlMode === "human")
        && checkpoint.phase !== "committed") {
        if (existing && JSON.stringify({ ...existing, seq: undefined }) === JSON.stringify(checkpoint)) {
          return publicTask(task);
        }
        throw taskError(409, task.status === "cancel_requested" ? "MAP_AI_TASK_CANCELLED" : "MAP_AI_TASK_CONTROL_CHANGED", "托管任务已取消或被人工接管，不能启动新的批次");
      }
      if (task.status === "interrupted") {
        if (existing && JSON.stringify({ ...existing, seq: undefined }) === JSON.stringify(checkpoint)) {
          return publicTask(task);
        }
        throw taskError(409, "MAP_AI_TASK_RESTART_CONFIRMATION_REQUIRED", "服务重启后的任务必须先显式确认，不能接受迟到的批次回执");
      }
      if (task.status === "paused" && !(existing && existing.phase === "started" && checkpoint.phase === "committed")) {
        if (existing && JSON.stringify({ ...existing, seq: undefined }) === JSON.stringify(checkpoint)) {
          return publicTask(task);
        }
        throw taskError(409, "MAP_AI_TASK_NOT_ACTIVE", "已暂停的托管任务不能启动新的批次");
      }
      // A successful task has no in-flight work left.  Do not accept a new
      // committed receipt with a different batch, which could otherwise
      // mutate its durable version after completion.
      if (task.status === "succeeded" && !existing) {
        throw taskError(409, "MAP_AI_TASK_FINAL", "任务已经成功完成，不能追加新的批次");
      }
      if (existing) {
        if (JSON.stringify({ ...existing, seq: undefined }) === JSON.stringify(checkpoint)) {
          return publicTask(task);
        }
        if (existing.baseVersion !== checkpoint.baseVersion || checkpointPhaseRank(checkpoint.phase) <= checkpointPhaseRank(existing.phase)) {
          throw taskError(409, "MAP_AI_TASK_CHECKPOINT_CONFLICT", "批次检查点已存在不同内容");
        }
        task.checkpointSeq += 1;
        task.checkpoints = task.checkpoints.map((entry) => (
          entry.batchId === checkpoint.batchId ? { ...checkpoint, seq: task.checkpointSeq } : entry
        ));
        applyCheckpointState(task, checkpoint, this.now());
        task.updatedAt = this.now();
        appendEvent(task, "checkpoint", {
          batchId: checkpoint.batchId,
          phase: checkpoint.phase,
          seq: task.checkpointSeq,
          summary: boundedText(checkpoint.summary || "", "event.summary", 0, MAX_TEXT),
          operationCount: checkpoint.operationCount,
          targetVersion: checkpoint.targetVersion,
        }, this.maxEvents, task.updatedAt);
        await this.write();
        return publicTask(task);
      }
      if (checkpoint.baseVersion !== task.currentVersion) {
        task.status = "conflict";
        task.completedAt = this.now();
        task.updatedAt = task.completedAt;
        task.error = { code: "MAP_AI_TASK_VERSION_CONFLICT", message: "批次基础版本与任务当前版本不一致，任务已暂停" };
        appendEvent(task, "version-conflict", { batchId: checkpoint.batchId }, this.maxEvents, task.updatedAt);
        await this.write();
        throw taskError(409, "MAP_AI_TASK_VERSION_CONFLICT", task.error.message);
      }
      const currentVersions = task.currentVersions || { [task.authority.mapPath]: task.currentVersion };
      if (checkpoint.baseVersions) {
        for (const [resourcePath, version] of Object.entries(checkpoint.baseVersions)) {
          if (currentVersions[resourcePath] !== version) {
            task.status = "conflict";
            task.completedAt = this.now();
            task.updatedAt = task.completedAt;
            task.error = { code: "MAP_AI_TASK_VERSION_CONFLICT", message: `批次文件 ${resourcePath} 基础版本已变化，任务未继续执行` };
            appendEvent(task, "version-conflict", { batchId: checkpoint.batchId, resourcePath }, this.maxEvents, task.updatedAt);
            await this.write();
            throw taskError(409, "MAP_AI_TASK_VERSION_CONFLICT", task.error.message);
          }
        }
      }
      task.checkpointSeq += 1;
      const value = { ...checkpoint, seq: task.checkpointSeq };
      task.checkpoints.push(value);
      applyCheckpointState(task, checkpoint, this.now());
      task.updatedAt = this.now();
      appendEvent(task, "checkpoint", {
        batchId: checkpoint.batchId,
        phase: checkpoint.phase,
        seq: value.seq,
        summary: boundedText(checkpoint.summary || "", "event.summary", 0, MAX_TEXT),
        operationCount: checkpoint.operationCount,
        targetVersion: checkpoint.targetVersion,
      }, this.maxEvents, task.updatedAt);
      await this.write();
      return publicTask(task);
    });
  }

  async fail(input = {}) {
    this.assertInitialized();
    const identity = normalizeIdentity(input.identity);
    return this.mutate(async () => {
      const task = this.requireTask(input.taskId, identity);
      if (FINAL_STATUSES.has(task.status)) return publicTask(task);
      const now = this.now();
      // A worker may report an error after an owner has already requested
      // cancellation.  That is a cancelled task, not a failed one: keeping
      // it terminal prevents a late callback from reviving it and makes
      // authorization revocation auditable as a stop request.
      if (task.status === "cancel_requested") {
        task.status = "canceled";
        task.completedAt = now;
        task.updatedAt = now;
        task.pauseRequested = true;
        task.error = {
          code: "MAP_AI_TASK_CANCELLED",
          message: boundedText(input.message || "托管任务已取消；当前批次未继续执行", "message", 1, MAX_TEXT),
        };
        appendEvent(task, "canceled", { code: task.error.code }, this.maxEvents, now);
        await this.write();
        return publicTask(task);
      }
      // Human takeover is also a deliberate control boundary.  If the
      // current worker notices it while preparing a candidate, leave the
      // task paused for the human instead of turning it into an error.
      if (task.controlMode === "human") {
        task.status = "paused";
        task.updatedAt = now;
        task.pauseRequested = true;
        task.error = null;
        appendEvent(task, "paused", { reason: "human-takeover" }, this.maxEvents, now);
        await this.write();
        return publicTask(task);
      }
      if (task.status === "paused" || task.status === "interrupted") {
        return publicTask(task);
      }
      task.status = "failed";
      task.completedAt = now;
      task.updatedAt = now;
      task.error = {
        code: boundedText(input.code || "MAP_AI_TASK_FAILED", "code", 1, 100),
        message: boundedText(input.message || "地图 AI 托管任务失败；其他任务不受影响", "message", 1, MAX_TEXT),
      };
      appendEvent(task, "failed", { code: task.error.code }, this.maxEvents, now);
      await this.write();
      return publicTask(task);
    });
  }

  async succeed(input = {}) {
    this.assertInitialized();
    const identity = normalizeIdentity(input.identity);
    return this.mutate(async () => {
      const task = this.requireTask(input.taskId, identity);
      if (FINAL_STATUSES.has(task.status)) return publicTask(task);
      const now = this.now();
      // A late worker completion must not override a durable cancellation or
      // human takeover.  `recordCheckpoint(committed)` handles the one
      // allowed in-flight atomic boundary; this method only closes a task
      // after that checkpoint and therefore preserves the control decision.
      if (task.status === "cancel_requested") {
        task.status = "canceled";
        task.completedAt = now;
        task.updatedAt = now;
        task.pauseRequested = true;
        task.error = { code: "MAP_AI_TASK_CANCELLED", message: "托管任务已取消；迟到的完成回执未恢复任务" };
        appendEvent(task, "canceled", { reason: "late-success-after-cancel" }, this.maxEvents, now);
        await this.write();
        return publicTask(task);
      }
      if (task.controlMode === "human" || task.status === "paused" || task.status === "interrupted") {
        return publicTask(task);
      }
      task.status = "succeeded";
      task.completedAt = now;
      task.updatedAt = now;
      task.pauseRequested = false;
      task.error = null;
      appendEvent(task, "succeeded", {
        version: task.currentVersion,
        summary: boundedText(input.summary || "地图 AI 托管任务已完成", "summary", 1, MAX_TEXT),
      }, this.maxEvents, now);
      await this.write();
      return publicTask(task);
    });
  }

  async conflict(input = {}) {
    this.assertInitialized();
    const identity = normalizeIdentity(input.identity);
    return this.mutate(async () => {
      const task = this.requireTask(input.taskId, identity);
      if (FINAL_STATUSES.has(task.status)) return publicTask(task);
      const now = this.now();
      if (task.status === "cancel_requested") {
        task.status = "canceled";
        task.completedAt = now;
        task.updatedAt = now;
        task.pauseRequested = true;
        task.error = { code: "MAP_AI_TASK_CANCELLED", message: "托管任务已取消；迟到的冲突回执未恢复任务" };
        appendEvent(task, "canceled", { reason: "late-conflict-after-cancel" }, this.maxEvents, now);
        await this.write();
        return publicTask(task);
      }
      if (task.controlMode === "human" || task.status === "paused" || task.status === "interrupted") {
        return publicTask(task);
      }
      task.status = "conflict";
      task.completedAt = now;
      task.updatedAt = now;
      task.error = {
        code: boundedText(input.code || "MAP_AI_TASK_VERSION_CONFLICT", "code", 1, 100),
        message: boundedText(input.message || "地图版本已变化，托管任务未覆盖当前文件", "message", 1, MAX_TEXT),
      };
      appendEvent(task, "version-conflict", { code: task.error.code }, this.maxEvents, now);
      await this.write();
      return publicTask(task);
    });
  }

  pruneExpired() {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (task.expiresAt > now || ACTIVE_STATUSES.has(task.status)) continue;
      this.tasks.delete(id);
    }
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const state = { version: STORE_VERSION, tasks: [...this.tasks.values()].map(storedTask) };
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  requireTask(taskId, identity) {
    const id = boundedText(taskId, "taskId", 1, MAX_ID);
    const task = this.tasks.get(id);
    if (!task || !sameIdentity(task.identity, identity)) {
      throw taskError(404, "MAP_AI_TASK_NOT_FOUND", "地图 AI 托管任务不存在或已过期");
    }
    return task;
  }

  evictFinalTasksForCapacity() {
    while (this.tasks.size >= this.maxTasks) {
      const candidate = [...this.tasks.values()]
        .filter((task) => FINAL_STATUSES.has(task.status))
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!candidate) return;
      this.tasks.delete(candidate.id);
    }
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Map AI managed task store is not initialized");
  }
}

function checkpointPhaseRank(phase) {
  return { started: 1, awaiting_approval: 2, committed: 3, failed: 3 }[phase] || 0;
}

function applyCheckpointState(task, checkpoint, now) {
  if (checkpoint.phase === "started") {
    task.status = "running";
    task.startedAt ||= now;
  } else if (checkpoint.phase === "awaiting_approval") {
    task.status = "awaiting_approval";
  } else if (checkpoint.phase === "committed") {
    task.currentVersion = checkpoint.targetVersion;
    if (checkpoint.targetVersions) task.currentVersions = { ...(task.currentVersions || {}), ...checkpoint.targetVersions };
    if (checkpoint.nextOperationIndex !== null) task.nextOperationIndex = checkpoint.nextOperationIndex;
    // Cancellation is an after-current-batch boundary.  The current atomic
    // save may legitimately finish, but the task must become terminal rather
    // than entering `paused` (which would make a revoked/cancelled task
    // resumable).  Preserve all other terminal states as well.
    if (FINAL_STATUSES.has(task.status)) return;
    if (task.status === "cancel_requested") {
      task.status = "canceled";
      task.completedAt ||= now;
      task.pauseRequested = true;
      return;
    }
    if (task.approvalSnapshot.policy !== "full_authorization") task.approvalOverride = false;
    task.status = task.pauseRequested || task.controlMode === "human" ? "paused" : "queued";
  } else if (checkpoint.phase === "failed") {
    task.status = "failed";
    task.completedAt = now;
    task.error = checkpoint.error;
  }
}

function normalizeCreateInput(input, now, ttlMs) {
  const identity = normalizeIdentity(input.identity);
  const authority = normalizeAuthority(input.authority, now, ttlMs);
  const approvalSnapshot = normalizeApprovalSnapshot(input.approvalSnapshot);
  const request = boundedJson(input.request, "request", MAX_PLAN_BYTES);
  validateManagedPlan(request);
  const settingsSnapshot = boundedJson(input.settingsSnapshot ?? {}, "settingsSnapshot", 128 * 1024);
  validateManagedPlan(settingsSnapshot);
  const clientOperationId = boundedText(input.clientOperationId, "clientOperationId", 1, MAX_ID);
  const planSummary = {
    operationCount: boundedInteger(input.planSummary?.operationCount, 0, 0, 1_000_000, "operationCount"),
    tileCellCount: boundedInteger(input.planSummary?.tileCellCount, 0, 0, 100_000_000, "tileCellCount"),
    ordinaryObjectCount: boundedInteger(input.planSummary?.ordinaryObjectCount, 0, 0, 1_000_000, "ordinaryObjectCount"),
  };
  return {
    identity,
    authority,
    approvalSnapshot,
    settingsSnapshot,
    clientOperationId,
    request,
    requestHash: sha256(JSON.stringify(request)),
    planSummary,
    expiresAt: Math.min(authority.expiresAt, now + ttlMs),
  };
}

function validateManagedPlan(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw taskError(400, "MAP_AI_TASK_PLAN_INVALID", "托管计划无法序列化"); }
  if (/(?:"(?:leaseId|leaseToken|token|projectPath|absolutePath|sourcePath|imageBytes|base64|dataUrl|fileId)"\s*:|(?:data|blob|https?|file):)/iu.test(serialized)) {
    throw taskError(400, "MAP_AI_TASK_PLAN_INVALID", "托管计划包含私有路径、凭据或图片数据");
  }
  if (value?.format === RESOURCE_PATCH_FORMAT) validateManagedResourcePatch(value);
}

function validateManagedResourcePatch(value) {
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 256) {
    throw taskError(422, "MAP_AI_RESOURCE_PATCH_INVALID", "资源补丁必须是 wfl-tiled-resource-patch v1，并包含 1 到 256 个文件");
  }
  const seen = new Set();
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw taskError(422, "MAP_AI_RESOURCE_PATCH_INVALID", "资源补丁文件条目无效");
    const allowedKeys = new Set(["path", "baseVersion", "candidateId", "size", "sha256"]);
    if (Object.keys(file).some((key) => !allowedKeys.has(key))) {
      throw taskError(400, "MAP_AI_RESOURCE_PATCH_PRIVATE_DATA", "资源补丁文件条目包含未知或私有字段");
    }
    const relativePath = normalizeRelativePath(file.path || file.relativePath, "resource.path");
    if (!/(?:\.(?:tmj|tsj|tx|world|png|jpe?g|webp)|\.character\.json)$/iu.test(relativePath)) throw taskError(415, "MAP_AI_RESOURCE_PATCH_KIND_INVALID", `不支持资源类型 ${relativePath}`);
    if (seen.has(relativePath)) throw taskError(422, "MAP_AI_RESOURCE_PATCH_DUPLICATE", `资源补丁重复写入 ${relativePath}`);
    seen.add(relativePath);
    const baseVersion = file.baseVersion === null ? null : String(file.baseVersion || "").toLowerCase();
    if (baseVersion !== null && !SHA256.test(baseVersion)) throw taskError(422, "MAP_AI_RESOURCE_PATCH_VERSION_INVALID", `资源 ${relativePath} 基础版本哈希无效`);
    if (file.candidate !== undefined || file.candidatePath !== undefined || file.content !== undefined || file.bytes !== undefined) {
      throw taskError(400, "MAP_AI_RESOURCE_PATCH_PRIVATE_DATA", "资源补丁不能携带候选路径、文件内容或图片字节");
    }
    if (typeof file.candidateId !== "string" || !file.candidateId.trim()) throw taskError(422, "MAP_AI_RESOURCE_PATCH_CANDIDATE_INVALID", `资源 ${relativePath} 缺少受控候选标识`);
    if (file.size !== undefined && (!Number.isSafeInteger(Number(file.size)) || Number(file.size) <= 0)) {
      throw taskError(422, "MAP_AI_RESOURCE_PATCH_SIZE_INVALID", `资源 ${relativePath} 候选大小无效`);
    }
    if (file.sha256 !== undefined && !SHA256.test(String(file.sha256))) {
      throw taskError(422, "MAP_AI_RESOURCE_PATCH_HASH_INVALID", `资源 ${relativePath} 候选哈希无效`);
    }
  }
}

function normalizeAuthority(value, now, ttlMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskError(400, "MAP_AI_TASK_AUTHORITY_INVALID", "托管授权快照无效");
  if (value.authorityMode !== "managed") throw taskError(403, "MAP_AI_TASK_AUTHORITY_INVALID", "托管任务必须使用 managed authorityMode");
  const projectPath = boundedText(value.projectPath, "projectPath", 1, 4_096);
  if (!path.isAbsolute(projectPath)) throw taskError(400, "MAP_AI_TASK_AUTHORITY_INVALID", "托管授权缺少服务端工程定位");
  const projectWide = value.projectWide === true || value.scopeKind === "project";
  const threadId = projectWide ? null : boundedText(value.threadId, "threadId", 1, MAX_ID);
  const mapSessionId = value.mapSessionId == null || value.mapSessionId === ""
    ? null
    : boundedText(value.mapSessionId, "mapSessionId", 1, MAX_ID);
  const mapPath = normalizeRelativePath(value.mapPath, "mapPath");
  const baseVersion = normalizeHash(value.baseVersion, "baseVersion");
  const mapPaths = normalizeRelativeList(value.mapPaths ?? [mapPath], "mapPaths");
  if (!mapPaths.includes(mapPath)) mapPaths.unshift(mapPath);
  const mapVersions = normalizeVersionMap(value.mapVersions ?? { [mapPath]: baseVersion }, mapPaths, "mapVersions");
  if (mapVersions[mapPath] !== baseVersion) throw taskError(409, "MAP_AI_TASK_AUTHORITY_INVALID", "主地图版本与地图版本清单不一致");
  const targetFiles = normalizeRelativeList(value.targetFiles ?? mapPaths, "targetFiles");
  if (!targetFiles.includes(mapPath)) targetFiles.unshift(mapPath);
  const defaultTargetVersions = Object.fromEntries(targetFiles.map((resourcePath) => [resourcePath, mapVersions[resourcePath] ?? null]));
  const targetFileVersions = normalizeVersionMap(value.targetFileVersions ?? defaultTargetVersions, targetFiles, "targetFileVersions", true);
  const allowedOps = normalizeTextList(value.allowedOps ?? [], "allowedOps", 64);
  const protectedTargets = normalizeProtectedTargets(value.protectedTargets ?? []);
  const collaborationPolicy = value.collaborationPolicy == null
    ? null
    : collaborationPolicySnapshot(normalizeCollaborationPolicyInput(value.collaborationPolicy));
  const expiresAt = boundedTimestamp(value.expiresAt ?? now + ttlMs, "expiresAt");
  if (expiresAt <= now) throw taskError(409, "MAP_AI_TASK_AUTHORITY_EXPIRED", "托管授权已过期");
  return Object.freeze({
    authorityMode: "managed",
    scopeKind: projectWide ? "project" : "map",
    projectWide,
    threadId,
    projectPath,
    mapSessionId,
    managedAuthorizationId: value.managedAuthorizationId == null || value.managedAuthorizationId === ""
      ? null
      : boundedText(value.managedAuthorizationId, "managedAuthorizationId", 1, MAX_ID),
    mapPath,
    baseVersion,
    mapPaths: Object.freeze([...new Set(mapPaths)]),
    mapVersions: Object.freeze({ ...mapVersions }),
    targetFiles: Object.freeze([...new Set(targetFiles)]),
    targetFileVersions: Object.freeze({ ...targetFileVersions }),
    allowedOps: Object.freeze([...new Set(allowedOps)]),
    protectedTargets: Object.freeze([...new Set(protectedTargets)]),
    collaborationPolicy,
    expiresAt,
  });
}

function normalizeVersionMap(value, paths, label, allowNull = false) {
  if (typeof paths === "string" && label === undefined) {
    label = paths;
    paths = Object.keys(value || {});
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw taskError(400, "MAP_AI_TASK_AUTHORITY_INVALID", `${label}无效`);
  }
  const output = {};
  for (const resourcePath of paths) {
    if (allowNull && value[resourcePath] === null) {
      output[resourcePath] = null;
      continue;
    }
    const hash = String(value[resourcePath] || "").toLowerCase();
    if (!SHA256.test(hash)) throw taskError(400, "MAP_AI_TASK_AUTHORITY_INVALID", `缺少 ${resourcePath} 的基础版本`);
    output[resourcePath] = hash;
  }
  return output;
}

function normalizeApprovalSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || value.userConfirmed !== true) {
    throw taskError(400, "MAP_AI_TASK_APPROVAL_SNAPSHOT_INVALID", "托管任务必须包含已确认的批准策略快照");
  }
  if (!MAP_AI_APPROVAL_POLICIES.includes(value.policy)) throw taskError(400, "MAP_AI_TASK_APPROVAL_POLICY_INVALID", "地图批准策略无效");
  const riskRuleVersion = boundedText(value.riskRuleVersion || MAP_AI_RISK_RULE_VERSION, "riskRuleVersion", 1, 100);
  return Object.freeze({
    version: 1,
    policy: value.policy,
    source: boundedText(value.source || "map_selection", "source", 1, 100),
    riskRuleVersion,
    userConfirmed: true,
  });
}

function normalizeCheckpoint(input, task) {
  const phase = boundedText(input.phase, "phase", 1, 32);
  if (!CHECKPOINT_PHASES.has(phase)) throw taskError(400, "MAP_AI_TASK_CHECKPOINT_INVALID", "任务检查点阶段无效");
  const batchId = boundedText(input.batchId, "batchId", 1, MAX_ID);
  const baseVersion = normalizeHash(input.baseVersion, "checkpoint baseVersion");
  const targetVersion = normalizeHash(input.targetVersion ?? input.baseVersion, "checkpoint targetVersion");
  const operationCount = boundedInteger(input.operationCount, 0, 0, 1_000_000, "operationCount");
  const operationIndex = input.operationIndex == null
    ? null
    : boundedInteger(input.operationIndex, 0, 0, 1_000_000, "operationIndex");
  const nextOperationIndex = input.nextOperationIndex == null
    ? null
    : boundedInteger(input.nextOperationIndex, 0, 0, 1_000_000, "nextOperationIndex");
  const summary = boundedText(input.summary || "", "summary", 0, MAX_TEXT);
  const risk = normalizeRiskReceipt(input.risk);
  const diff = boundedJson(input.diff ?? {}, "checkpoint.diff", 64 * 1024);
  const validation = boundedJson(input.validation ?? {}, "checkpoint.validation", 32 * 1024);
  const value = {
    batchId, phase, baseVersion, targetVersion, operationCount,
    operationIndex, nextOperationIndex, summary, risk, diff, validation,
  };
  if (input.baseVersions !== undefined) value.baseVersions = normalizeVersionMap(input.baseVersions, "checkpoint.baseVersions", undefined, true);
  if (input.targetVersions !== undefined) value.targetVersions = normalizeVersionMap(input.targetVersions, "checkpoint.targetVersions");
  if (phase === "failed") value.error = normalizeError(input.error);
  return value;
}

function normalizeRiskReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskError(400, "MAP_AI_TASK_RISK_INVALID", "任务检查点缺少风险收据");
  const riskLevel = boundedText(value.riskLevel, "riskLevel", 1, 32);
  const ruleVersion = boundedText(value.ruleVersion, "ruleVersion", 1, 100);
  const reasonCodes = normalizeTextList(value.reasonCodes ?? [], "reasonCodes", 32);
  const hardBlocks = normalizeTextList(value.hardBlocks ?? [], "hardBlocks", 32);
  return Object.freeze({
    ruleVersion,
    riskLevel,
    reasonCodes: Object.freeze(reasonCodes),
    hardBlocks: Object.freeze(hardBlocks),
  });
}

function normalizeError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskError(400, "MAP_AI_TASK_ERROR_INVALID", "任务错误收据无效");
  return Object.freeze({
    code: boundedText(value.code || "MAP_AI_TASK_FAILED", "error.code", 1, 100),
    message: boundedText(value.message || "地图 AI 托管任务失败", "error.message", 1, MAX_TEXT),
  });
}

function publicTask(task) {
  const latestCheckpoint = task.checkpoints.at(-1) || null;
  const latestValidation = latestCheckpoint?.validation && typeof latestCheckpoint.validation === "object"
    ? structuredClone(latestCheckpoint.validation)
    : null;
  const currentOperation = latestCheckpoint?.operationIndex == null ? null : latestCheckpoint.operationIndex;
  return {
    id: task.id,
    status: task.status,
    controlMode: task.controlMode,
    authorityMode: task.authority.authorityMode,
    scopeKind: task.authority.scopeKind || (task.authority.projectWide ? "project" : "map"),
    projectWide: task.authority.projectWide === true,
    threadId: task.authority.threadId,
    mapSessionId: task.authority.mapSessionId,
    managedAuthorizationId: task.authority.managedAuthorizationId,
    mapPath: task.authority.mapPath,
    baseVersion: task.authority.baseVersion,
    currentVersion: task.currentVersion,
    currentVersions: { ...(task.currentVersions || { [task.authority.mapPath]: task.currentVersion }) },
    nextOperationIndex: task.nextOperationIndex,
    currentStage: FINAL_STATUSES.has(task.status) ? task.status : (latestCheckpoint?.phase || task.status),
    currentOperation,
    nextOperation: task.nextOperationIndex < task.planSummary.operationCount ? task.nextOperationIndex : null,
    workerStatus: latestValidation?.worker?.status || null,
    workerIsolation: latestValidation?.worker?.isolation || null,
    lastValidation: latestValidation,
    targetFiles: [...task.authority.targetFiles],
    targetFileVersions: { ...task.authority.targetFileVersions },
    mapPaths: [...(task.authority.mapPaths || [task.authority.mapPath])],
    mapVersions: { ...(task.authority.mapVersions || { [task.authority.mapPath]: task.authority.baseVersion }) },
    allowedOps: [...task.authority.allowedOps],
    protectedTargets: [...task.authority.protectedTargets],
    collaborationPolicy: task.authority.collaborationPolicy ? publicCollaborationPolicy(task.authority.collaborationPolicy) : null,
    approvalPolicy: task.approvalSnapshot.policy,
    riskRuleVersion: task.approvalSnapshot.riskRuleVersion,
    settingsSnapshot: structuredClone(task.settingsSnapshot),
    clientOperationId: task.clientOperationId,
    requestHash: task.requestHash,
    planAvailable: task.plan !== null,
    planSummary: { ...task.planSummary },
      pauseRequested: task.pauseRequested,
      approvalOverride: task.approvalOverride === true,
    checkpointSeq: task.checkpointSeq,
    checkpoints: task.checkpoints.map((entry) => structuredClone(entry)),
    events: task.events.map((entry) => ({ ...entry, details: entry.details ? structuredClone(entry.details) : {} })),
    error: task.error ? { ...task.error } : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
}

function storedTask(task) {
  return {
    id: task.id,
    identity: task.identity,
    authority: task.authority,
    approvalSnapshot: task.approvalSnapshot,
    settingsSnapshot: task.settingsSnapshot,
    clientOperationId: task.clientOperationId,
    requestHash: task.requestHash,
    plan: task.plan,
    planSummary: task.planSummary,
    status: task.status,
    controlMode: task.controlMode,
    currentVersion: task.currentVersion,
    currentVersions: task.currentVersions,
    nextOperationIndex: task.nextOperationIndex,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
      pauseRequested: task.pauseRequested,
      approvalOverride: task.approvalOverride === true,
    checkpointSeq: task.checkpointSeq,
    checkpoints: task.checkpoints,
    events: task.events,
    error: task.error,
  };
}

async function readState(filePath, { maxTasks, maxEvents }) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.tasks)) return { tasks: new Map(), normalized: true };
    const tasks = new Map();
    let normalized = raw.tasks.length > maxTasks;
    for (const value of raw.tasks.slice(-maxTasks)) {
      try {
        const task = restoreTask(value, maxEvents);
        if (tasks.has(task.id)) normalized = true;
        tasks.set(task.id, task);
      } catch { normalized = true; }
    }
    return { tasks, normalized };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { tasks: new Map(), normalized: true };
    throw error;
  }
}

function restoreTask(value, maxEvents) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !STATUSES.has(value.status)) throw new Error("invalid task");
  const identity = normalizeIdentity(value.identity);
  const authority = normalizeAuthority(value.authority, Number(value.createdAt) || Date.now(), DEFAULT_TTL_MS);
  const approvalSnapshot = normalizeApprovalSnapshot(value.approvalSnapshot);
  const settingsSnapshot = boundedJson(value.settingsSnapshot ?? {}, "settingsSnapshot", 128 * 1024);
  const clientOperationId = boundedText(value.clientOperationId, "clientOperationId", 1, MAX_ID);
  const requestHash = normalizeHash(value.requestHash, "requestHash");
  // Tasks created by the first state-layer prototype may only have a request
  // hash. Preserve those records as non-executable contracts rather than
  // deleting them during a restart; an executor must refuse until a plan is
  // explicitly reattached.
  const plan = value.plan === undefined ? null : boundedJson(value.plan, "plan", MAX_PLAN_BYTES);
  const planSummary = normalizePlanSummary(value.planSummary);
  const task = {
    id: boundedText(value.id, "taskId", 1, MAX_ID),
    identity,
    authority,
    approvalSnapshot,
    settingsSnapshot,
    clientOperationId,
    requestHash,
    plan,
    planSummary,
    status: value.status,
    controlMode: value.controlMode === "human" ? "human" : "ai",
    currentVersion: normalizeHash(value.currentVersion, "currentVersion"),
    currentVersions: normalizeVersionMap(value.currentVersions ?? { [authority.mapPath]: value.currentVersion }, "currentVersions", undefined, true),
    nextOperationIndex: boundedInteger(value.nextOperationIndex, 0, 0, 1_000_000, "nextOperationIndex"),
    createdAt: boundedTimestamp(value.createdAt, "createdAt"),
    updatedAt: boundedTimestamp(value.updatedAt, "updatedAt"),
    expiresAt: boundedTimestamp(value.expiresAt, "expiresAt"),
    startedAt: value.startedAt == null ? null : boundedTimestamp(value.startedAt, "startedAt"),
    completedAt: value.completedAt == null ? null : boundedTimestamp(value.completedAt, "completedAt"),
    pauseRequested: value.pauseRequested === true,
    approvalOverride: value.approvalOverride === true,
    checkpointSeq: boundedInteger(value.checkpointSeq, 0, 0, 10_000_000, "checkpointSeq"),
    checkpoints: Array.isArray(value.checkpoints) ? value.checkpoints.slice(-maxEvents).map((entry) => restoreCheckpoint(entry)) : [],
    events: Array.isArray(value.events) ? value.events.slice(-maxEvents).map((entry) => restoreEvent(entry)) : [],
    error: value.error == null ? null : normalizeError(value.error),
  };
  if (task.updatedAt < task.createdAt || task.expiresAt <= task.createdAt) throw new Error("invalid task timestamps");
  return task;
}

function restoreCheckpoint(value) {
  return Object.freeze({
    seq: boundedInteger(value.seq, 1, 1, 10_000_000, "checkpoint seq"),
    ...normalizeCheckpoint(value, { currentVersion: value.baseVersion }),
  });
}

function restoreEvent(value) {
  return Object.freeze({
    seq: boundedInteger(value.seq, 1, 1, 10_000_000, "event seq"),
    type: boundedText(value.type, "event.type", 1, 100),
    at: boundedTimestamp(value.at, "event.at"),
    details: boundedJson(value.details ?? {}, "event.details", 16 * 1024),
  });
}

function appendEvent(task, type, details, maxEvents, at) {
  const previous = task.events.at(-1)?.seq || 0;
  task.events.push({ seq: previous + 1, type, at, details: boundedJson(details ?? {}, "event.details", 16 * 1024) });
  if (task.events.length > maxEvents) task.events.splice(0, task.events.length - maxEvents);
}

function normalizePlanSummary(value = {}) {
  return {
    operationCount: boundedInteger(value.operationCount, 0, 0, 1_000_000, "operationCount"),
    tileCellCount: boundedInteger(value.tileCellCount, 0, 0, 100_000_000, "tileCellCount"),
    ordinaryObjectCount: boundedInteger(value.ordinaryObjectCount, 0, 0, 1_000_000, "ordinaryObjectCount"),
  };
}

function normalizeIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskError(400, "MAP_AI_TASK_IDENTITY_INVALID", "托管任务身份无效");
  return Object.freeze({
    userId: boundedText(value.userId, "userId", 1, MAX_ID),
    browserSessionId: boundedText(value.browserSessionId, "browserSessionId", 1, MAX_ID),
  });
}

function sameIdentity(left, right) {
  return left.userId === right.userId && left.browserSessionId === right.browserSessionId;
}

function normalizeRelativePath(value, label) {
  const text = boundedText(value, label, 1, 4_096).replaceAll("\\", "/");
  if (text.startsWith("/") || /^[a-z]:\//iu.test(text) || text.split("/").includes("..") || text.includes("\u0000")) {
    throw taskError(400, "MAP_AI_TASK_PATH_INVALID", `${label}必须是工程相对路径`);
  }
  const normalized = path.posix.normalize(text);
  if (!normalized || normalized === "." || normalized.startsWith("../")) throw taskError(400, "MAP_AI_TASK_PATH_INVALID", `${label}必须是工程相对路径`);
  return normalized;
}

function normalizeRelativeList(value, label) {
  if (!Array.isArray(value) || value.length > 256) throw taskError(400, "MAP_AI_TASK_PATH_INVALID", `${label}无效`);
  return value.map((entry) => normalizeRelativePath(entry, label));
}

function normalizeTextList(value, label, max) {
  if (!Array.isArray(value) || value.length > max) throw taskError(400, "MAP_AI_TASK_LIST_INVALID", `${label}无效`);
  return value.map((entry) => boundedText(entry, label, 1, 256));
}

function normalizeHash(value, label) {
  const text = boundedText(value, label, 64, 64).toLowerCase();
  if (!SHA256.test(text)) throw taskError(400, "MAP_AI_TASK_HASH_INVALID", `${label}必须是 SHA-256`);
  return text;
}

function boundedJson(value, label, limit) {
  let source;
  try { source = JSON.stringify(value); } catch { throw taskError(400, "MAP_AI_TASK_PAYLOAD_INVALID", `${label}无法序列化`); }
  if (!source || Buffer.byteLength(source) > limit) throw taskError(413, "MAP_AI_TASK_PAYLOAD_TOO_LARGE", `${label}超过限制`);
  return structuredClone(JSON.parse(source));
}

function boundedText(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw taskError(400, "MAP_AI_TASK_ARGUMENT_INVALID", `${label}无效`);
  }
  return value;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw taskError(400, "MAP_AI_TASK_ARGUMENT_INVALID", `${label}无效`);
  return number;
}

function boundedTimestamp(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw taskError(400, "MAP_AI_TASK_ARGUMENT_INVALID", `${label}无效`);
  return number;
}

function boundedTextOrNull(value, label) {
  return value == null ? null : boundedText(value, label, 0, MAX_TEXT);
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function taskError(statusCode, code, message) { return new MapAiManagedTaskError(statusCode, code, message); }
function fileExists(filePath) { return fs.access(filePath).then(() => true, () => false); }
