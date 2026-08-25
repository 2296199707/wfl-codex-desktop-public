import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { normalizeProviderFailureKind } from "./provider-failure.mjs";

const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
const STORE_VERSION = 1;
const DEFAULT_MAX_ROLLOUT_FILES = 512;
const DEFAULT_MAX_ROLLOUT_BYTES = 512 * 1024 * 1024;
const CONNECTIVITY_SUSPENSION_REASON = "provider-unavailable";
const MANUAL_PAUSE_STATES = new Set(["pausing", "paused"]);
const MANUAL_PAUSE_MODES = new Set(["after-turn", "immediate"]);
const PROVIDER_KINDS = new Set(["managed", "official", "default"]);
export const GOAL_RETRY_FREQUENCIES = Object.freeze(["fast", "balanced", "patient"]);
const GOAL_RETRY_FREQUENCY_SET = new Set(GOAL_RETRY_FREQUENCIES);
const CONNECTIVITY_RETRY_DELAYS_MS = Object.freeze({
  fast: Object.freeze([
    10_000,
    20_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
  ]),
  balanced: Object.freeze([
    15_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
  ]),
  patient: Object.freeze([
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    20 * 60_000,
    30 * 60_000,
  ]),
});

export function goalConnectivityRetryDelay(
  attempt,
  {
    frequency = "balanced",
    random = Math.random,
  } = {},
) {
  const delays = CONNECTIVITY_RETRY_DELAYS_MS[normalizeRetryFrequency(frequency)];
  const index = Math.min(
    delays.length - 1,
    Math.max(0, (positiveInteger(attempt) ?? 1) - 1),
  );
  const base = delays[index];
  const sample = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.max(1_000, Math.round(base * (0.9 + sample * 0.2)));
}

export class CodexGoalRecoveryStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(stateDirectory, "codex-goal-recovery.json");
    this.now = now;
    this.records = new Map();
    this.settings = normalizeRecoverySettings();
    this.bootstrappedAt = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await fsPromises.readFile(this.filePath, "utf8"));
      if (stored?.version !== STORE_VERSION) throw new SyntaxError("Unsupported Goal recovery store");
      this.bootstrappedAt = positiveInteger(stored.bootstrappedAt);
      this.settings = normalizeRecoverySettings(stored.settings);
      for (const value of Array.isArray(stored.records) ? stored.records : []) {
        const record = normalizeGoalRecord(value);
        if (record) this.records.set(record.threadId, record);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.records.clear();
      this.settings = normalizeRecoverySettings();
      this.bootstrappedAt = null;
    }
    return this;
  }

  settingsSnapshot() {
    return structuredClone(this.settings);
  }

  async updateSettings(value) {
    this.settings = normalizeRecoverySettings({ ...this.settings, ...value });
    await this.persist();
    return this.settingsSnapshot();
  }

  get(threadId) {
    validateThreadId(threadId);
    const record = this.records.get(threadId);
    return record ? structuredClone(record) : null;
  }

  snapshot() {
    return [...this.records.values()]
      .sort((left, right) => right.observedAt - left.observedAt)
      .map((record) => structuredClone(record));
  }

  needsBootstrap() {
    return this.bootstrappedAt === null;
  }

  async bootstrap(records) {
    if (!this.needsBootstrap()) return false;
    for (const value of Array.isArray(records) ? records : []) {
      const record = normalizeGoalRecord(value);
      if (!record || this.records.has(record.threadId)) continue;
      this.records.set(record.threadId, record);
    }
    this.bootstrappedAt = this.now();
    await this.persist();
    return true;
  }

  async upsert(goal, { observedAt = this.now() } = {}) {
    const record = normalizeGoalRecord({ ...goal, observedAt });
    if (!record) throw goalRecoveryError("Invalid Codex Goal snapshot");
    const current = this.records.get(record.threadId);
    if (current && current.observedAt > record.observedAt) return structuredClone(current);
    // Arrival order is not native revision order. A delayed old
    // thread/goal/updated notification must not downgrade a newer terminal
    // Goal back to active merely because it arrived later.
    if (
      current
      && Number.isSafeInteger(current.updatedAt)
      && Number.isSafeInteger(record.updatedAt)
      && record.updatedAt < current.updatedAt
    ) return structuredClone(current);
    this.records.set(record.threadId, preserveConnectivityRecovery(current, record, goal));
    await this.persist();
    return structuredClone(this.records.get(record.threadId));
  }

  async suspendForConnectivity(goal, {
    error = null,
    retryDelayMs = null,
    observedAt = this.now(),
  } = {}) {
    return this.suspendForFailure(goal, {
      failureKind: "connectivity",
      error,
      retryDelayMs,
      observedAt,
    });
  }

  async suspendForFailure(goal, {
    failureKind = "unknown",
    error = null,
    retryDelayMs = null,
    observedAt = this.now(),
  } = {}) {
    const current = this.records.get(goal?.threadId);
    const retryAttempts = Math.min(1_000_000, (current?.retryAttempts || 0) + 1);
    const normalizedFailureKind = normalizeProviderFailureKind(failureKind) || "unknown";
    const resumeWhenAvailable = normalizedFailureKind === "connectivity";
    return this.upsert({
      ...goal,
      resumeWhenAvailable,
      suspendedReason: resumeWhenAvailable ? CONNECTIVITY_SUSPENSION_REASON : null,
      failureKind: normalizedFailureKind,
      retryAttempts,
      nextRetryAt: !resumeWhenAvailable || retryDelayMs == null
        ? null
        : observedAt + Math.max(0, Number(retryDelayMs) || 0),
      lastError: normalizeLastError(error),
    }, { observedAt });
  }

  async clearConnectivitySuspension(threadId, { observedAt = this.now() } = {}) {
    validateThreadId(threadId);
    const current = this.records.get(threadId);
    if (!current?.resumeWhenAvailable) return current ? structuredClone(current) : null;
    return this.upsert({
      ...current,
      resumeWhenAvailable: false,
      suspendedReason: null,
      failureKind: null,
      retryAttempts: 0,
      nextRetryAt: null,
      lastError: null,
    }, { observedAt });
  }

  async rescheduleConnectivitySuspension(threadId, {
    retryDelayMs,
    observedAt = this.now(),
  } = {}) {
    validateThreadId(threadId);
    const current = this.records.get(threadId);
    if (!current?.resumeWhenAvailable) return current ? structuredClone(current) : null;
    return this.upsert({
      ...current,
      nextRetryAt: observedAt + Math.max(0, Number(retryDelayMs) || 0),
    }, { observedAt });
  }

  async beginManualPause(goal, {
    mode = "after-turn",
    pending = false,
    provider = null,
    observedAt = this.now(),
  } = {}) {
    if (!MANUAL_PAUSE_MODES.has(mode)) throw goalRecoveryError("Invalid manual Goal pause mode");
    const current = this.records.get(goal?.threadId);
    return this.upsert({
      ...goal,
      resumeWhenAvailable: false,
      suspendedReason: null,
      failureKind: null,
      retryAttempts: 0,
      nextRetryAt: null,
      lastError: null,
      manualPauseState: pending ? "pausing" : "paused",
      manualPauseMode: mode,
      manualPauseRequestedAt: observedAt,
      manualPausedAt: pending ? null : observedAt,
      manualResumedAt: current?.manualResumedAt ?? null,
      providerBefore: normalizeGoalProvider(provider),
      providerAfter: null,
      providerSwitchedAt: null,
    }, { observedAt });
  }

  async finishManualPause(threadId, { observedAt = this.now() } = {}) {
    validateThreadId(threadId);
    const current = this.records.get(threadId);
    if (!current || current.manualPauseState !== "pausing") {
      return current ? structuredClone(current) : null;
    }
    return this.upsert({
      ...current,
      status: "paused",
      manualPauseState: "paused",
      manualPausedAt: current.manualPausedAt || observedAt,
    }, { observedAt });
  }

  async recordManualProviderSwitch(threadId, provider, { observedAt = this.now() } = {}) {
    validateThreadId(threadId);
    const current = this.records.get(threadId);
    if (!current?.manualPauseState) return current ? structuredClone(current) : null;
    const normalizedProvider = normalizeGoalProvider(provider);
    if (!normalizedProvider || sameGoalProvider(current.providerBefore, normalizedProvider)) {
      return structuredClone(current);
    }
    return this.upsert({
      ...current,
      providerAfter: normalizedProvider,
      providerSwitchedAt: observedAt,
    }, { observedAt });
  }

  async finishManualResume(goal, {
    provider = null,
    observedAt = this.now(),
  } = {}) {
    const current = this.records.get(goal?.threadId);
    if (!current) return this.upsert(goal, { observedAt });
    const normalizedProvider = normalizeGoalProvider(provider);
    return this.upsert({
      ...goal,
      resumeWhenAvailable: false,
      suspendedReason: null,
      failureKind: null,
      retryAttempts: 0,
      nextRetryAt: null,
      lastError: null,
      manualPauseState: null,
      manualPauseMode: null,
      manualPauseRequestedAt: current.manualPauseRequestedAt ?? null,
      manualPausedAt: current.manualPausedAt ?? null,
      manualResumedAt: observedAt,
      providerBefore: current.providerBefore ?? null,
      providerAfter: current.providerAfter
        || (normalizedProvider && !sameGoalProvider(current.providerBefore, normalizedProvider)
          ? normalizedProvider
          : null),
      providerSwitchedAt: current.providerSwitchedAt
        || (normalizedProvider && !sameGoalProvider(current.providerBefore, normalizedProvider)
          ? observedAt
          : null),
    }, { observedAt });
  }

  async restoreRecord(threadId, record) {
    validateThreadId(threadId);
    if (record == null) {
      this.records.delete(threadId);
      await this.persist();
      return null;
    }
    const normalized = normalizeGoalRecord(record);
    if (!normalized || normalized.threadId !== threadId) {
      throw goalRecoveryError("Invalid Codex Goal recovery snapshot");
    }
    this.records.set(threadId, normalized);
    await this.persist();
    return structuredClone(normalized);
  }

  async remove(threadId) {
    validateThreadId(threadId);
    const removed = this.records.delete(threadId);
    if (removed) await this.persist();
    return removed;
  }

  flush() {
    return this.writeQueue;
  }

  async persist() {
    const content = `${JSON.stringify({
      version: STORE_VERSION,
      bootstrappedAt: this.bootstrappedAt,
      settings: this.settings,
      records: this.snapshot(),
    }, null, 2)}\n`;
    const queued = this.writeQueue.then(async () => {
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(temporary, content, { mode: 0o600 });
      await fsPromises.rename(temporary, this.filePath);
      await fsPromises.chmod(this.filePath, 0o600);
    });
    this.writeQueue = queued.catch(() => {});
    await queued;
  }
}

export async function scanCodexGoalRollouts(
  codexHome,
  {
    maxFiles = DEFAULT_MAX_ROLLOUT_FILES,
    maxBytes = DEFAULT_MAX_ROLLOUT_BYTES,
  } = {},
) {
  if (!path.isAbsolute(codexHome)) throw goalRecoveryError("Codex home must be absolute");
  const sessionsDirectory = path.join(path.resolve(codexHome), "sessions");
  const candidates = [];
  await collectRolloutFiles(sessionsDirectory, candidates, 0);
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const selected = [];
  let selectedBytes = 0;
  for (const file of candidates.slice(0, positiveBound(maxFiles, DEFAULT_MAX_ROLLOUT_FILES))) {
    if (selected.length && selectedBytes + file.size > positiveBound(maxBytes, DEFAULT_MAX_ROLLOUT_BYTES)) {
      continue;
    }
    selected.push(file);
    selectedBytes += file.size;
  }
  selected.sort((left, right) => left.modifiedAt - right.modifiedAt);

  const latestByThread = new Map();
  let eventSequence = 0;
  for (const file of selected) {
    const input = fs.createReadStream(file.filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes("thread_goal_") && !line.includes("thread/goal/")) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row?.type !== "event_msg" || !row.payload || typeof row.payload !== "object") continue;
        const eventType = row.payload.type;
        if (![
          "thread_goal_updated",
          "thread/goal/updated",
          "thread_goal_cleared",
          "thread/goal/cleared",
        ].includes(eventType)) {
          continue;
        }
        const threadId = String(row.payload.threadId || row.payload.goal?.threadId || "");
        if (!validThreadId(threadId)) continue;
        const observedAt = eventObservedAt(row.timestamp, file.modifiedAt, ++eventSequence);
        const current = latestByThread.get(threadId);
        if (current && compareObservedEvents(current, observedAt) >= 0) continue;
        if (eventType.endsWith("cleared")) {
          latestByThread.set(threadId, { threadId, goal: null, ...observedAt });
          continue;
        }
        const goal = normalizeGoalRecord({
          ...row.payload.goal,
          threadId,
          observedAt: observedAt.epochMs,
        });
        if (goal) latestByThread.set(threadId, { threadId, goal, ...observedAt });
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  return {
    records: [...latestByThread.values()]
      .filter((entry) => entry.goal)
      .map((entry) => entry.goal)
      .sort((left, right) => right.observedAt - left.observedAt),
    scannedFiles: selected.length,
    scannedBytes: selectedBytes,
    truncated: selected.length < candidates.length,
  };
}

export async function restoreCodexGoals(
  records,
  {
    request,
    onGoal = null,
    onFailure = null,
    canReactivateUsageLimited = null,
    isThreadRunning = null,
  } = {},
) {
  if (typeof request !== "function") throw goalRecoveryError("Goal recovery request function is required");
  const result = {
    checked: 0,
    restored: 0,
    reactivated: 0,
    resumed: 0,
    alreadyActive: 0,
    manuallyPaused: 0,
    inactive: 0,
    failed: 0,
  };

  for (const value of Array.isArray(records) ? records : []) {
    const stored = normalizeGoalRecord(value);
    if (!stored) continue;
    result.checked += 1;
    try {
      const read = await request("thread/goal/get", { threadId: stored.threadId });
      let goal = normalizeGoalRecord({
        ...read?.goal,
        observedAt: Date.now(),
      });
      if (goal && stored.manualPauseState && goal.status === "active") {
        const paused = await request("thread/goal/set", {
          threadId: stored.threadId,
          status: "paused",
        }, {
          operationKey: goalRecoveryOperationKey(stored, "preserve-manual-pause"),
        });
        goal = normalizeGoalRecord({
          ...paused?.goal,
          ...settledManualPauseMetadata(stored),
          observedAt: Date.now(),
        });
        if (!goal) throw goalRecoveryError("Codex did not preserve the manual Goal pause");
        result.manuallyPaused += 1;
      } else if (goal && stored.manualPauseState && goal.status === "paused") {
        goal = {
          ...goal,
          ...settledManualPauseMetadata(stored),
        };
      }
      if (
        goal
        && stored.resumeWhenAvailable
        && ["active", "paused"].includes(goal.status)
      ) {
        goal = { ...goal, ...connectivityRecoveryMetadata(stored) };
      }
      if (
        goal?.status === "usageLimited"
        && typeof canReactivateUsageLimited === "function"
        && await canReactivateUsageLimited(stored, goal)
      ) {
        const reactivated = await request("thread/goal/set", {
          threadId: stored.threadId,
          status: "active",
        }, {
          operationKey: goalRecoveryOperationKey(stored, "reactivate-usage-limited-goal"),
        });
        goal = normalizeGoalRecord({
          ...reactivated?.goal,
          observedAt: Date.now(),
        });
        if (!goal || goal.status !== "active") {
          throw goalRecoveryError("Codex did not reactivate the usage-limited Goal");
        }
        result.reactivated += 1;
      }
      if (!goal) {
        const restoreActive = stored.resumeWhenAvailable && stored.suspendedReason === CONNECTIVITY_SUSPENSION_REASON;
        const restored = await request("thread/goal/set", {
          threadId: stored.threadId,
          objective: stored.objective,
          status: restoreActive ? "active" : stored.status,
          tokenBudget: stored.tokenBudget,
        }, {
          operationKey: goalRecoveryOperationKey(stored, "restore-missing-goal"),
        });
        goal = normalizeGoalRecord({
          ...restored?.goal,
          ...(restoreActive ? connectivityRecoveryMetadata(stored) : {}),
          ...(stored.manualPauseState ? settledManualPauseMetadata(stored) : {}),
          observedAt: Date.now(),
        });
        if (!goal) throw goalRecoveryError("Codex did not return the restored Goal");
        result.restored += 1;
        if (restoreActive) result.reactivated += 1;
      } else if (
        goal.status === "paused"
        && stored.resumeWhenAvailable
        && stored.suspendedReason === CONNECTIVITY_SUSPENSION_REASON
      ) {
        const reactivated = await request("thread/goal/set", {
          threadId: stored.threadId,
          status: "active",
        }, {
          operationKey: goalRecoveryOperationKey(stored, "reactivate-connectivity-goal"),
        });
        goal = normalizeGoalRecord({
          ...reactivated?.goal,
          ...connectivityRecoveryMetadata(stored),
          observedAt: Date.now(),
        });
        if (!goal) throw goalRecoveryError("Codex did not return the reactivated Goal");
        result.reactivated += 1;
      }
      if (typeof onGoal === "function") await onGoal(goal);
      if (goal.status !== "active") {
        result.inactive += 1;
        continue;
      }

      const thread = await request("thread/read", {
        threadId: goal.threadId,
        includeTurns: false,
      });
      const running = typeof isThreadRunning === "function"
        ? await isThreadRunning(goal.threadId, thread?.thread || null)
        : thread?.thread?.status?.type === "active";
      if (running) {
        result.alreadyActive += 1;
        continue;
      }
      await request("thread/resume", {
        threadId: goal.threadId,
        excludeTurns: true,
      }, {
        operationKey: goalRecoveryOperationKey(stored, "resume-active-goal"),
      });
      result.resumed += 1;
    } catch (error) {
      result.failed += 1;
      if (typeof onFailure === "function") await onFailure(stored, error);
    }
  }
  return result;
}

function goalRecoveryOperationKey(record, action) {
  const generation = record.manualPauseRequestedAt
    || record.updatedAt
    || record.createdAt
    || record.observedAt
    || 0;
  return `${action}:${record.threadId}:${generation}`;
}

async function collectRolloutFiles(directory, output, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, output, depth + 1);
      continue;
    }
    if (!entry.isFile() || !/^rollout-.+\.jsonl$/.test(entry.name)) continue;
    const stat = await fsPromises.lstat(entryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    output.push({ filePath: entryPath, size: stat.size, modifiedAt: stat.mtimeMs });
  }
}

function normalizeGoalRecord(value) {
  if (!value || typeof value !== "object") return null;
  const threadId = String(value.threadId || "");
  const objective = typeof value.objective === "string" ? value.objective.trim() : "";
  const status = String(value.status || "");
  const tokenBudget = value.tokenBudget == null ? null : positiveInteger(value.tokenBudget);
  if (
    !validThreadId(threadId)
    || !objective
    || objective.length > 4_000
    || !GOAL_STATUSES.has(status)
    || (value.tokenBudget != null && tokenBudget === null)
  ) {
    return null;
  }
  const manualPause = normalizeManualPause(value, status);
  const activeFailure = ["active", "paused"].includes(status)
    ? normalizeProviderFailureKind(value.failureKind)
      || (value.resumeWhenAvailable === true ? "connectivity" : null)
    : null;
  const resumeWhenAvailable = activeFailure === "connectivity"
    && !manualPause?.manualPauseState
    && value.resumeWhenAvailable === true
    && ["active", "paused"].includes(status);
  return {
    threadId,
    objective,
    status,
    tokenBudget,
    tokensUsed: nonnegativeInteger(value.tokensUsed) ?? 0,
    timeUsedSeconds: nonnegativeInteger(value.timeUsedSeconds) ?? 0,
    createdAt: nonnegativeInteger(value.createdAt) ?? 0,
    updatedAt: nonnegativeInteger(value.updatedAt) ?? 0,
    observedAt: positiveInteger(value.observedAt) ?? Date.now(),
    resumeWhenAvailable,
    suspendedReason: resumeWhenAvailable && value.suspendedReason === CONNECTIVITY_SUSPENSION_REASON
      ? CONNECTIVITY_SUSPENSION_REASON
      : null,
    failureKind: activeFailure,
    retryAttempts: activeFailure ? nonnegativeInteger(value.retryAttempts) ?? 0 : 0,
    nextRetryAt: resumeWhenAvailable && value.nextRetryAt != null
      ? nonnegativeInteger(value.nextRetryAt)
      : null,
    lastError: activeFailure ? normalizeLastError(value.lastError) : null,
    ...(manualPause || {}),
  };
}

function preserveConnectivityRecovery(current, record, source) {
  let next = record;
  if (current?.failureKind && !["complete", "blocked", "usageLimited", "budgetLimited"].includes(record.status)) {
    const explicitlyUpdated = [
      "resumeWhenAvailable",
      "suspendedReason",
      "failureKind",
      "retryAttempts",
      "nextRetryAt",
      "lastError",
    ].some((key) => Object.hasOwn(source, key));
    if (!explicitlyUpdated) {
      next = {
        ...next,
        ...connectivityRecoveryMetadata(current),
      };
    }
  }
  if (
    current?.manualPauseState
    && !["complete", "blocked", "usageLimited", "budgetLimited"].includes(record.status)
    && !Object.hasOwn(source, "manualPauseState")
  ) {
    next = {
      ...next,
      ...manualPauseMetadata(current),
      resumeWhenAvailable: false,
      suspendedReason: null,
      failureKind: null,
      retryAttempts: 0,
      nextRetryAt: null,
      lastError: null,
    };
  }
  return next;
}

function normalizeManualPause(value, status) {
  const state = MANUAL_PAUSE_STATES.has(value.manualPauseState) ? value.manualPauseState : null;
  const mode = MANUAL_PAUSE_MODES.has(value.manualPauseMode) ? value.manualPauseMode : null;
  const requestedAt = nonnegativeInteger(value.manualPauseRequestedAt);
  const pausedAt = nonnegativeInteger(value.manualPausedAt);
  const resumedAt = nonnegativeInteger(value.manualResumedAt);
  const providerBefore = normalizeGoalProvider(value.providerBefore);
  const providerAfter = normalizeGoalProvider(value.providerAfter);
  const providerSwitchedAt = nonnegativeInteger(value.providerSwitchedAt);
  const hasAudit = requestedAt !== null
    || pausedAt !== null
    || resumedAt !== null
    || providerBefore !== null
    || providerAfter !== null
    || providerSwitchedAt !== null;
  if (!state && !hasAudit) return null;
  const activeState = state && ["active", "paused"].includes(status) ? state : null;
  return {
    manualPauseState: activeState,
    manualPauseMode: activeState ? mode || "after-turn" : null,
    manualPauseRequestedAt: requestedAt,
    manualPausedAt: pausedAt,
    manualResumedAt: resumedAt,
    providerBefore,
    providerAfter,
    providerSwitchedAt,
  };
}

function manualPauseMetadata(record) {
  return {
    manualPauseState: record.manualPauseState,
    manualPauseMode: record.manualPauseMode,
    manualPauseRequestedAt: record.manualPauseRequestedAt,
    manualPausedAt: record.manualPausedAt,
    manualResumedAt: record.manualResumedAt,
    providerBefore: record.providerBefore,
    providerAfter: record.providerAfter,
    providerSwitchedAt: record.providerSwitchedAt,
  };
}

function settledManualPauseMetadata(record) {
  return {
    ...manualPauseMetadata(record),
    manualPauseState: "paused",
    manualPausedAt: record.manualPausedAt || Date.now(),
    resumeWhenAvailable: false,
    suspendedReason: null,
    failureKind: null,
    retryAttempts: 0,
    nextRetryAt: null,
    lastError: null,
  };
}

function normalizeGoalProvider(value) {
  if (!value || typeof value !== "object" || !PROVIDER_KINDS.has(value.kind)) return null;
  const id = normalizeProviderText(value.id, 256);
  const label = normalizeProviderText(value.label, 256);
  if (!id || !label) return null;
  return {
    kind: value.kind,
    id,
    label,
    model: normalizeProviderText(value.model, 256),
    accountId: normalizeProviderText(value.accountId, 128),
    accountLabel: normalizeProviderText(value.accountLabel, 320),
    credentialStatus: ["valid", "invalid", "unknown"].includes(value.credentialStatus)
      ? value.credentialStatus
      : null,
    quotaUsedPercent: boundedPercent(value.quotaUsedPercent),
  };
}

function normalizeProviderText(value, limit) {
  if (value == null) return null;
  const text = String(value).trim();
  return text && text.length <= limit && !/[\r\n\0]/.test(text) ? text : null;
}

function boundedPercent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function sameGoalProvider(left, right) {
  return left?.kind === right?.kind
    && left?.id === right?.id
    && left?.accountId === right?.accountId
    && left?.model === right?.model;
}

function connectivityRecoveryMetadata(record) {
  return {
    resumeWhenAvailable: record.resumeWhenAvailable === true,
    suspendedReason: record.suspendedReason,
    failureKind: record.failureKind,
    retryAttempts: record.retryAttempts,
    nextRetryAt: record.nextRetryAt,
    lastError: record.lastError,
  };
}

function normalizeRecoverySettings(value = {}) {
  return {
    unlimitedRetry: value?.unlimitedRetry === true,
    retryFrequency: normalizeRetryFrequency(value?.retryFrequency),
  };
}

function normalizeRetryFrequency(value) {
  return GOAL_RETRY_FREQUENCY_SET.has(value) ? value : "balanced";
}

function normalizeLastError(value) {
  if (value == null) return null;
  const text = redactGoalRecoveryError(String(value)).trim();
  return text ? text.slice(0, 1_000) : null;
}

function redactGoalRecoveryError(value) {
  return String(value)
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s:@]+)(?::[^@\s/]*)?@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]",
    )
    .replace(
      /\b(?:sk|rk|pk|gh[opusr]|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi,
      "[REDACTED]",
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|cookie|authorization)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
}

function eventObservedAt(timestamp, modifiedAt, sequence) {
  const parsed = Date.parse(String(timestamp || ""));
  return {
    epochMs: Number.isFinite(parsed) ? parsed : Math.max(1, Math.trunc(modifiedAt)),
    sequence,
  };
}

function compareObservedEvents(left, right) {
  if (left.epochMs !== right.epochMs) return left.epochMs - right.epochMs;
  return left.sequence - right.sequence;
}

function positiveBound(value, fallback) {
  const parsed = positiveInteger(value);
  return parsed ?? fallback;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonnegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validateThreadId(threadId) {
  if (!validThreadId(threadId)) throw goalRecoveryError("Invalid Codex Goal thread ID");
}

function validThreadId(threadId) {
  return /^[A-Za-z0-9_-]{8,256}$/.test(String(threadId));
}

function goalRecoveryError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
