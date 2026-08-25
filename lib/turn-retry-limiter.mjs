import { classifyProviderFailure } from "./provider-failure.mjs";

const PROGRESS_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
]);

export class TurnRetryLimiter {
  constructor({ maxRetries = 5 } = {}) {
    this.maxRetries = maxRetries;
    this.turns = new Map();
    this.activeTurnByThread = new Map();
  }

  observe(notification = {}) {
    const method = notification.method;
    const params = notification.params || {};
    const identity = this.identity(params);

    if (method === "turn/started") {
      if (identity.threadId && identity.turnId) {
        this.activeTurnByThread.set(identity.threadId, identity.turnId);
        this.turns.delete(turnKey(identity));
      }
      return { action: "pass", ...identity };
    }

    if (method === "turn/completed") {
      this.clear(identity);
      return { action: "pass", ...identity };
    }

    if (PROGRESS_METHODS.has(method)) {
      this.reset(identity);
      return { action: "pass", ...identity };
    }

    if (method !== "error" || params.willRetry !== true || !identity.threadId || !identity.turnId) {
      if (method === "error" && params.willRetry !== true) this.clear(identity);
      return { action: "pass", ...identity };
    }

    const failure = classifyProviderFailure(notification);
    const failureKind = failure.kind;
    const retryable = failure.retryable === true;
    const key = turnKey(identity);
    const state = this.turns.get(key) || { retries: 0, limited: false, failureKind };
    state.retries += 1;
    state.failureKind = failureKind;
    if (state.limited) {
      return { action: "suppress", retries: state.retries, failureKind, ...identity };
    }
    // Codex can mark the first quota/authentication error as `willRetry`.
    // Do not replay failures that are not explicitly transient: repeating
    // them only duplicates the official error and can consume more quota.
    if (!retryable) {
      state.limited = true;
      this.turns.set(key, state);
      return { action: "limit", retries: state.retries, failureKind, ...identity };
    }
    if (state.retries < this.maxRetries) {
      this.turns.set(key, state);
      return { action: "pass", retries: state.retries, failureKind, ...identity };
    }

    state.limited = true;
    this.turns.set(key, state);
    return { action: "limit", retries: state.retries, failureKind, ...identity };
  }

  identity(params = {}) {
    const threadId = stringId(params.threadId || params.thread?.id);
    const directTurnId = stringId(params.turnId || params.turn?.id);
    return {
      threadId,
      turnId: directTurnId || (threadId ? this.activeTurnByThread.get(threadId) || null : null),
    };
  }

  reset(identity) {
    if (!identity.threadId || !identity.turnId) return;
    const key = turnKey(identity);
    const state = this.turns.get(key);
    if (state && !state.limited) this.turns.delete(key);
  }

  clear(identity) {
    if (!identity.threadId) return;
    const turnId = identity.turnId || this.activeTurnByThread.get(identity.threadId);
    if (turnId) this.turns.delete(turnKey({ threadId: identity.threadId, turnId }));
    if (!turnId || this.activeTurnByThread.get(identity.threadId) === turnId) {
      this.activeTurnByThread.delete(identity.threadId);
    }
  }
}

function turnKey({ threadId, turnId }) {
  return `${threadId}\u0000${turnId}`;
}

function stringId(value) {
  return typeof value === "string" && value ? value : null;
}
