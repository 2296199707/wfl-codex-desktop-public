export const MAP_ACCOUNT_SESSION_CHECK_MS = 15_000;

/**
 * Keep an editor window bound to the account that opened it. A successful
 * response proving another account (or no authenticated account) invalidates
 * the window. Network and server failures are deliberately inconclusive: an
 * outage must not discard unsaved local edits.
 */
export class MapAccountSessionGuard {
  constructor({
    accountId,
    fetchImpl = globalThis.fetch,
    windowRef = globalThis.window,
    documentRef = globalThis.document,
    intervalMs = MAP_ACCOUNT_SESSION_CHECK_MS,
    onInvalidated = () => {},
  } = {}) {
    this.accountId = normalizeAccountId(accountId);
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 300_000) {
      throw new TypeError("intervalMs must be between 5000 and 300000");
    }
    if (typeof onInvalidated !== "function") throw new TypeError("onInvalidated must be a function");
    this.fetchImpl = fetchImpl;
    this.windowRef = windowRef;
    this.documentRef = documentRef;
    this.intervalMs = intervalMs;
    this.onInvalidated = onInvalidated;
    this.timer = null;
    this.request = null;
    this.controller = null;
    this.started = false;
    this.stopped = false;
    this.invalidated = false;
    this.boundCheck = () => { void this.check(); };
    this.boundVisibility = () => {
      if (this.documentRef?.visibilityState === "visible") void this.check();
    };
  }

  get enabled() {
    return Boolean(this.accountId);
  }

  async check() {
    if (!this.enabled || this.stopped || this.invalidated) return "disabled";
    if (this.request) return this.request;
    this.controller = new AbortController();
    const request = this.checkUnlocked(this.controller.signal);
    this.request = request;
    try {
      return await request;
    } finally {
      if (this.request === request) this.request = null;
      this.controller = null;
    }
  }

  start() {
    if (!this.enabled || this.started || this.stopped || this.invalidated) return false;
    this.started = true;
    this.windowRef?.addEventListener?.("focus", this.boundCheck);
    this.windowRef?.addEventListener?.("pageshow", this.boundCheck);
    this.documentRef?.addEventListener?.("visibilitychange", this.boundVisibility);
    this.timer = setInterval(this.boundCheck, this.intervalMs);
    this.timer?.unref?.();
    return true;
  }

  stop() {
    if (this.stopped) return false;
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.windowRef?.removeEventListener?.("focus", this.boundCheck);
    this.windowRef?.removeEventListener?.("pageshow", this.boundCheck);
    this.documentRef?.removeEventListener?.("visibilitychange", this.boundVisibility);
    return true;
  }

  async checkUnlocked(signal) {
    try {
      const url = `/api/account?summary=1&_=${Date.now()}`;
      const response = await this.fetchImpl(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        this.invalidate("signed-out");
        return "invalidated";
      }
      if (!response.ok) return "unavailable";
      const data = await response.json();
      const currentAccountId = normalizeAccountId(data?.user?.id);
      if (!currentAccountId || currentAccountId !== this.accountId) {
        this.invalidate("account-changed");
        return "invalidated";
      }
      return "current";
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") return "stopped";
      return "unavailable";
    }
  }

  invalidate(reason) {
    if (this.invalidated || this.stopped) return false;
    this.invalidated = true;
    clearInterval(this.timer);
    this.timer = null;
    this.windowRef?.removeEventListener?.("focus", this.boundCheck);
    this.windowRef?.removeEventListener?.("pageshow", this.boundCheck);
    this.documentRef?.removeEventListener?.("visibilitychange", this.boundVisibility);
    this.onInvalidated(Object.freeze({ reason, accountId: this.accountId }));
    return true;
  }
}

export function createMapAccountSessionGuard(options) {
  return new MapAccountSessionGuard(options);
}

function normalizeAccountId(value) {
  const accountId = typeof value === "string" ? value : "";
  if (!accountId || accountId.length > 256 || accountId.includes("\0")) return null;
  return accountId;
}
