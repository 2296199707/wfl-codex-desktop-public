import assert from "node:assert/strict";
import test from "node:test";

import { revokeMapAiLeaseWithRetry } from "../public/map-editor/map-ai-lease-revoke.js";

function failure(status, message = `status ${status}`) {
  return Object.assign(new Error(message), { status });
}

test("map AI lease revoke retries transient failures and reports bounded progress", async () => {
  const statuses = [];
  const delays = [];
  let calls = 0;
  const result = await revokeMapAiLeaseWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw failure(calls === 1 ? 503 : 429);
  }, {
    retryDelaysMs: [11, 22],
    wait: async (delay) => delays.push(delay),
    onStatus: (status) => statuses.push(status),
  });

  assert.deepEqual(result, { revoked: true, stale: false, attempts: 3 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [11, 22]);
  assert.deepEqual(statuses.map(({ phase, attempt, nextAttempt }) => ({ phase, attempt, nextAttempt })), [
    { phase: "attempt", attempt: 1, nextAttempt: undefined },
    { phase: "retry-scheduled", attempt: 1, nextAttempt: 2 },
    { phase: "attempt", attempt: 2, nextAttempt: undefined },
    { phase: "retry-scheduled", attempt: 2, nextAttempt: 3 },
    { phase: "attempt", attempt: 3, nextAttempt: undefined },
    { phase: "succeeded", attempt: undefined, nextAttempt: undefined },
  ]);
});

test("map AI lease revoke stops after three failed transient attempts", async () => {
  let calls = 0;
  const lastError = failure(502, "upstream unavailable");
  const result = await revokeMapAiLeaseWithRetry(async () => {
    calls += 1;
    throw lastError;
  }, { wait: async () => {} });

  assert.equal(calls, 3);
  assert.equal(result.revoked, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.retryable, true);
  assert.equal(result.error, lastError);
});

test("map AI lease revoke treats an absent lease as released without retry", async () => {
  let calls = 0;
  const result = await revokeMapAiLeaseWithRetry(async () => {
    calls += 1;
    throw failure(404);
  }, { wait: async () => assert.fail("must not wait") });

  assert.deepEqual(result, { revoked: true, stale: true, attempts: 1 });
  assert.equal(calls, 1);
});

test("map AI lease revoke never retries permanent authorization errors", async () => {
  let calls = 0;
  const result = await revokeMapAiLeaseWithRetry(async () => {
    calls += 1;
    throw failure(403, "forbidden");
  }, { wait: async () => assert.fail("must not wait") });

  assert.equal(calls, 1);
  assert.equal(result.revoked, false);
  assert.equal(result.retryable, false);
  assert.equal(result.attempts, 1);
});
