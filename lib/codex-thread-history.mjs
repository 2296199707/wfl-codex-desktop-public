// Preserve the full-snapshot contract for internal readers without asking
// paginated Codex threads to use the deprecated full-history read endpoint.
export async function readCodexThreadHistory(request, params, options = {}, { now = Date.now } = {}) {
  const { timeoutMs = 120_000, onResponseObserved, ...requestOptions } = options;
  const deadline = now() + timeoutMs;
  let observed = null;
  let readReply = null;
  const invoke = async (method, requestParams) => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      const error = new Error("thread/read timed out");
      error.code = "ERR_CODEX_RPC_TIMEOUT";
      error.delivery = "unknown";
      error.deliveryUnknown = true;
      throw error;
    }
    observed = null;
    return request(method, requestParams, {
      ...requestOptions,
      timeoutMs: remaining,
      onResponseObserved: (message) => { observed = message; },
    });
  };

  let result;
  try {
    const metadata = await invoke("thread/read", { ...params, includeTurns: false });
    readReply = observed;
    if (metadata?.thread?.historyMode !== "paginated") {
      // Older app-servers/legacy rollouts retain their original read semantics.
      result = await invoke("thread/read", params);
      readReply = observed;
    } else {
      const turns = [];
      const cursors = new Set();
      let cursor = null;
      do {
        const page = await invoke("thread/turns/list", {
          threadId: params.threadId,
          cursor,
          limit: 100,
          sortDirection: "asc",
          // Official Codex still supports full items on individual turn pages.
          itemsView: "full",
        });
        if (!Array.isArray(page?.data) || page.data.some((turn) => (
          !turn || !Array.isArray(turn.items)
          || (turn.itemsView != null && turn.itemsView !== "full")
        ))) {
          throw historyPageError("Codex returned an incomplete full-history page");
        }
        turns.push(...page.data);
        cursor = page.nextCursor ?? null;
        if (cursor !== null) {
          if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
            throw historyPageError("Codex returned an invalid or repeated history cursor");
          }
          cursors.add(cursor);
        }
      } while (cursor !== null);
      result = { ...metadata, thread: { ...metadata.thread, turns } };
    }
  } catch (error) {
    // A transport failure is not an observed native rejection. Notify only
    // when the native transport actually delivered an error response.
    if (observed?.error && typeof onResponseObserved === "function") {
      onResponseObserved(observed);
    }
    throw error;
  }
  if (typeof onResponseObserved === "function") {
    onResponseObserved({ ...(readReply || {}), result });
  }
  return result;
}

function historyPageError(message) {
  const error = new Error(message);
  error.code = "ERR_CODEX_HISTORY_PAGE";
  return error;
}
