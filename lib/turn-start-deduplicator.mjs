export class TurnStartDeduplicator {
  constructor(request, { ttlMs = 10 * 60 * 1000, maxEntries = 512, now = Date.now } = {}) {
    this.request = request;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  run(
    params,
    startTurn,
    {
      allowRecoverableReadFailure = false,
      allowUnmaterializedReadFailure = false,
      skipRead = false,
    } = {},
  ) {
    const key = turnStartKey(params);
    if (!key) return startTurn();

    this.prune();
    const cached = this.entries.get(key);
    if (cached) return cached.promise;

    const entry = {
      createdAt: this.now(),
      settled: false,
      promise: null,
    };
    entry.promise = this.resolve(params, startTurn, {
      allowRecoverableReadFailure,
      allowUnmaterializedReadFailure,
      skipRead,
    })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      })
      .finally(() => {
        entry.settled = true;
        this.prune();
      });
    this.entries.set(key, entry);
    this.prune();
    return entry.promise;
  }

  async resolve(
    params,
    startTurn,
    {
      allowRecoverableReadFailure = false,
      allowUnmaterializedReadFailure = false,
      skipRead = false,
    } = {},
  ) {
    // A caller may skip this read only after proving that the Thread is an
    // unmaterialized shell. Keep the read as the default for every ordinary
    // submission because it is the duplicate-delivery safeguard.
    if (skipRead) return startTurn();
    let snapshot;
    try {
      snapshot = await this.request("thread/read", {
        threadId: params.threadId,
        includeTurns: true,
      });
    } catch (error) {
      if (
        isUnmaterializedThreadError(error)
        || (allowUnmaterializedReadFailure && isCodexUnmaterializedReadError(error))
        || (allowRecoverableReadFailure && isRecoverableTurnStartHandoffError(error))
      ) return startTurn();
      throw error;
    }
    const existingTurn = findTurnByClientMessageId(snapshot?.thread, params.clientUserMessageId);
    if (existingTurn) return { turn: existingTurn };
    return startTurn();
  }

  prune() {
    const expiry = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.createdAt <= expiry) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) break;
    }
  }
}

export class ThreadStartDeduplicator {
  constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 256, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  run(clientRequestId, startThread) {
    if (typeof clientRequestId !== "string" || !clientRequestId) return startThread();

    this.prune();
    const cached = this.entries.get(clientRequestId);
    if (cached) return cached.promise;

    const entry = {
      createdAt: this.now(),
      settled: false,
      promise: null,
    };
    entry.promise = Promise.resolve()
      .then(startThread)
      .catch((error) => {
        if (this.entries.get(clientRequestId) === entry) this.entries.delete(clientRequestId);
        throw error;
      })
      .finally(() => {
        entry.settled = true;
        this.prune();
      });
    this.entries.set(clientRequestId, entry);
    this.prune();
    return entry.promise;
  }

  prune() {
    const expiry = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.createdAt <= expiry) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) break;
    }
  }
}

export function findTurnByClientMessageId(thread, clientMessageId) {
  if (!clientMessageId) return null;
  return (thread?.turns || []).find((turn) =>
    (turn.items || []).some((item) => item.type === "userMessage" && item.clientId === clientMessageId),
  ) || null;
}

/**
 * A rejected turn/start can be retried only when the app-server explicitly
 * identifies a stale native Thread handoff.  Transport timeouts and
 * disconnects deliberately do not match: their delivery is unknown.
 */
export function isRecoverableTurnStartHandoffError(error) {
  if (!error || error.delivery === "unknown" || error.deliveryUnknown === true) return false;
  const code = String(error.code || "").toLowerCase();
  const codexError = error.codexError && typeof error.codexError === "object"
    ? error.codexError
    : null;
  const text = [
    error.message,
    error.details?.message,
    codexError?.code,
    codexError?.type,
    codexError?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(thread[_ -]?not[_ -]?loaded|thread[_ -]?unavailable|stale[_ -]?subscription|interrupted[_ -]?handoff)/i.test(code)) {
    return true;
  }
  return (
    /thread\s+(?:is\s+)?(?:not[_ -]?loaded|unavailable)/i.test(text)
    || /(?:not[_ -]?loaded|unavailable)\s+thread/i.test(text)
    || /stale\s+(?:thread\s+)?subscription/i.test(text)
    || /subscription\s+(?:is\s+)?stale/i.test(text)
    || /interrupted\s+(?:backend\s+)?handoff/i.test(text)
    || /(?:backend|writer)\s+handoff\s+(?:was\s+)?interrupted/i.test(text)
  );
}

function turnStartKey(params) {
  if (typeof params?.threadId !== "string" || typeof params?.clientUserMessageId !== "string") return null;
  if (!params.threadId || !params.clientUserMessageId) return null;
  return `${params.threadId}\u0000${params.clientUserMessageId}`;
}

function isUnmaterializedThreadError(error) {
  const message = String(error?.message || "");
  return /thread .*not materialized yet/i.test(message)
    && /before first user message/i.test(message);
}

function isCodexUnmaterializedReadError(error) {
  return /no rollout found for thread id|rollout(?: file| record)? (?:was )?not found|thread(?: is)? not (?:loaded|found)/i.test(
    String(error?.message || ""),
  );
}
