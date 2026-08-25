/**
 * Host-side delivery queue for settlements produced by the official DeepSeek
 * continuation manager.
 *
 * This is transport glue only. The DeepSeek runtime remains the authority for
 * child identity, continuation, persistence, and settlement creation. The
 * queue only preserves ordering while the external Codex parent is temporarily
 * busy or its app-server is reconnecting.
 */
export class ThirdPartySubagentSettlementQueue {
  constructor({ deliver, onError = null } = {}) {
    if (typeof deliver !== "function") throw new TypeError("settlement deliverer is required");
    this.deliver = deliver;
    this.onError = typeof onError === "function" ? onError : () => {};
    this.pending = new Map();
    this.running = new Map();
  }

  enqueue(parentThreadId, settlement) {
    if (typeof parentThreadId !== "string" || !parentThreadId) return false;
    const entries = this.pending.get(parentThreadId) || [];
    entries.push(settlement);
    this.pending.set(parentThreadId, entries);
    void this.flush(parentThreadId);
    return true;
  }

  notify(parentThreadId) {
    if (typeof parentThreadId !== "string" || !parentThreadId) return;
    void this.flush(parentThreadId);
  }

  notifyAll() {
    for (const parentThreadId of this.pending.keys()) void this.flush(parentThreadId);
  }

  async flush(parentThreadId) {
    const existing = this.running.get(parentThreadId);
    if (existing) return existing;
    const operation = (async () => {
      const entries = this.pending.get(parentThreadId);
      if (!entries) return;
      while (entries.length) {
        let outcome;
        try {
          outcome = await this.deliver(entries[0]);
        } catch (error) {
          this.onError(error, entries[0]);
          // A rejected delivery is not a reason to reorder later settlements.
          // Keep the failed item pending so the next authoritative parent
          // notification can retry it; the deliverer can explicitly return
          // `drop` for an unrecoverable/unknown delivery.
          break;
        }
        if (outcome === "defer" || outcome === false || outcome == null) break;
        const settled = entries.shift();
        if (outcome !== "delivered" && outcome !== true) {
          this.onError(
            Object.assign(new Error("third-party subagent settlement was dropped"), {
              code: "SUBAGENT_SETTLEMENT_DROPPED",
            }),
            settled,
          );
        }
      }
      if (!entries.length) this.pending.delete(parentThreadId);
    })().finally(() => {
      if (this.running.get(parentThreadId) === operation) this.running.delete(parentThreadId);
    });
    this.running.set(parentThreadId, operation);
    return operation;
  }

  clear() {
    this.pending.clear();
    this.running.clear();
  }
}
