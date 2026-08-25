import assert from "node:assert/strict";
import test from "node:test";
import { TurnRetryLimiter } from "../lib/turn-retry-limiter.mjs";

function retry(threadId = "thread-1", turnId = "turn-1", message = "API unavailable") {
  return {
    method: "error",
    params: { threadId, turnId, willRetry: true, error: { message } },
  };
}

test("limits each turn after five consecutive retryable API errors", () => {
  const limiter = new TurnRetryLimiter({ maxRetries: 5 });
  limiter.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });

  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.deepEqual(limiter.observe(retry()), {
      action: "pass",
      retries: attempt,
      failureKind: "connectivity",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  }
  assert.equal(limiter.observe(retry()).action, "limit");
  assert.equal(limiter.observe(retry()).action, "suppress");
});

test("progress resets consecutive failures and turn counters stay isolated", () => {
  const limiter = new TurnRetryLimiter({ maxRetries: 5 });
  limiter.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  limiter.observe(retry());
  limiter.observe(retry());
  limiter.observe({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", delta: "connected" },
  });
  assert.equal(limiter.observe(retry()).retries, 1);

  for (let attempt = 1; attempt <= 5; attempt += 1) limiter.observe(retry("thread-2", "turn-2"));
  assert.equal(limiter.observe(retry()).action, "pass");
  assert.equal(limiter.observe(retry("thread-2", "turn-2")).action, "suppress");
});

test("uses the active turn when retry notifications omit turnId", () => {
  const limiter = new TurnRetryLimiter({ maxRetries: 2 });
  limiter.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  assert.equal(limiter.observe(retry("thread-1", null)).action, "pass");
  const limited = limiter.observe(retry("thread-1", null));
  assert.equal(limited.action, "limit");
  assert.equal(limited.turnId, "turn-1");

  limiter.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  assert.equal(limiter.observe(retry("thread-1", null)).action, "pass");
});

test("retries only transient failures and stops quota/authentication immediately", () => {
  const limiter = new TurnRetryLimiter({ maxRetries: 2 });
  for (const [index, [failureMessage, expectedKind]] of [
    ["Request timed out while connecting to the API", "connectivity"],
    ["429 rate limit exceeded", "rate-limit"],
    ["Selected model is at capacity", "capacity"],
    ["401 invalid API key", "authentication"],
  ].entries()) {
    const threadId = `thread-error-${index}`;
    const turnId = `turn-error-${index}`;
    limiter.observe({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    const first = limiter.observe(retry(threadId, turnId, failureMessage));
    assert.equal(first.action, expectedKind === "authentication" ? "limit" : "pass");
    assert.equal(first.failureKind, expectedKind);
    const limited = limiter.observe(retry(threadId, turnId, failureMessage));
    assert.equal(limited.action, expectedKind === "authentication" ? "suppress" : "limit");
    assert.equal(limited.failureKind, expectedKind);
    assert.equal(limited.threadId, threadId);
    assert.equal(limited.turnId, turnId);
  }
});

test("does not retry Codex semantic usage-limit errors wrapped in HTTP 429", () => {
  const limiter = new TurnRetryLimiter({ maxRetries: 5 });
  const threadId = "thread-usage-limit";
  const turnId = "turn-usage-limit";
  limiter.observe({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
  const notification = {
    method: "error",
    params: {
      threadId,
      turnId,
      willRetry: true,
      error: {
        httpStatusCode: 429,
        codexErrorInfo: "usageLimitExceeded",
        message: "usage limit exceeded",
      },
    },
  };
  const limited = limiter.observe(notification);
  assert.equal(limited.action, "limit");
  assert.equal(limited.failureKind, "quota");
  assert.equal(limiter.observe(notification).action, "suppress");
});
