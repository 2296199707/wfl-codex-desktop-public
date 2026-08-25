const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const RELEASED_STATUSES = new Set([404, 409]);
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

/**
 * Revoke a short-lived map AI lease without retrying permanent client errors.
 * A missing or conflicting lease is already unusable and therefore counts as
 * released. The caller owns all UI and decides whether to discard its local
 * credential before or after this bounded operation.
 */
export async function revokeMapAiLeaseWithRetry(revoke, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait = waitFor,
  onStatus = () => {},
} = {}) {
  if (typeof revoke !== "function") throw new TypeError("revoke must be a function");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError("maxAttempts must be an integer from 1 to 5");
  }
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new TypeError("retryDelaysMs must contain non-negative integers");
  }
  if (typeof wait !== "function" || typeof onStatus !== "function") {
    throw new TypeError("wait and onStatus must be functions");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    notify(onStatus, { phase: "attempt", attempt, maxAttempts });
    try {
      await revoke();
      const result = Object.freeze({ revoked: true, stale: false, attempts: attempt });
      notify(onStatus, { phase: "succeeded", ...result, maxAttempts });
      return result;
    } catch (error) {
      const status = Number(error?.status) || 0;
      if (RELEASED_STATUSES.has(status)) {
        const result = Object.freeze({ revoked: true, stale: true, attempts: attempt });
        notify(onStatus, { phase: "succeeded", ...result, maxAttempts });
        return result;
      }
      const retryable = status === 0 || RETRYABLE_STATUSES.has(status) || status >= 500;
      if (!retryable || attempt === maxAttempts) {
        const result = Object.freeze({
          revoked: false,
          stale: false,
          attempts: attempt,
          retryable,
          error,
        });
        notify(onStatus, { phase: "failed", ...result, maxAttempts });
        return result;
      }
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
      notify(onStatus, {
        phase: "retry-scheduled",
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error,
      });
      await wait(delayMs);
    }
  }
  throw new Error("unreachable map AI lease revoke state");
}

function waitFor(delayMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function notify(onStatus, status) {
  try {
    onStatus(Object.freeze(status));
  } catch {
    // Status rendering must never prevent a security-sensitive revocation.
  }
}
