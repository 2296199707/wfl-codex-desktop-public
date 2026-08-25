import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderFailure,
  normalizeProviderFailureKind,
  providerFailureLabel,
} from "../lib/provider-failure.mjs";

test("classifies structured Codex provider failures before message fallbacks", () => {
  assert.deepEqual(
    classifyProviderFailure({
      params: { error: { message: "try later", codexErrorInfo: "usageLimitExceeded" } },
    }),
    {
      kind: "quota",
      statusCode: null,
      retryable: false,
      unlimitedRetryEligible: false,
    },
  );
  assert.equal(classifyProviderFailure({
    params: { error: { codexErrorInfo: "unauthorized" } },
  }).kind, "authentication");
  assert.equal(classifyProviderFailure({
    params: {
      error: {
        codexErrorInfo: {
          responseStreamConnectionFailed: { httpStatusCode: null },
        },
      },
    },
  }).kind, "connectivity");
  assert.equal(classifyProviderFailure({
    statusCode: 429,
    error: { codexErrorInfo: "workspace_owner_credits_depleted" },
  }).kind, "quota");
});

test("HTTP status takes precedence and only connectivity permits unlimited retry", () => {
  assert.deepEqual(
    classifyProviderFailure({
      error: {
        message: "quota text must not override the status",
        codexErrorInfo: {
          responseStreamConnectionFailed: { httpStatusCode: 401 },
        },
      },
    }),
    {
      kind: "authentication",
      statusCode: 401,
      retryable: false,
      unlimitedRetryEligible: false,
    },
  );
  assert.deepEqual(classifyProviderFailure({ statusCode: 429 }), {
    kind: "rate-limit",
    statusCode: 429,
    retryable: true,
    unlimitedRetryEligible: false,
  });
  assert.deepEqual(classifyProviderFailure({ statusCode: 503 }), {
    kind: "connectivity",
    statusCode: 503,
    retryable: true,
    unlimitedRetryEligible: true,
  });
});

test("unknown failures never inherit automatic retry eligibility", () => {
  assert.deepEqual(
    classifyProviderFailure({
      error: {
        message: "provider returned an unexplained result",
        codexErrorInfo: { responseTooManyFailedAttempts: {} },
      },
    }),
    {
      kind: "unknown",
      statusCode: null,
      retryable: false,
      unlimitedRetryEligible: false,
    },
  );
  assert.equal(normalizeProviderFailureKind("credentials"), null);
  assert.equal(providerFailureLabel("rate-limit"), "请求限流");
});

test("keeps Codex model-capacity failures out of connectivity failover", () => {
  assert.deepEqual(classifyProviderFailure({
    params: {
      error: {
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      },
    },
  }), {
    kind: "capacity",
    statusCode: null,
    retryable: true,
    unlimitedRetryEligible: false,
  });
  assert.equal(classifyProviderFailure({
    error: { message: "模型容量已满，请稍后重试" },
  }).kind, "capacity");
  assert.deepEqual(classifyProviderFailure({
    statusCode: 503,
    error: { message: "Selected model is at capacity. Please retry the same model later." },
  }), {
    kind: "capacity",
    statusCode: 503,
    retryable: true,
    unlimitedRetryEligible: false,
  });
  assert.equal(providerFailureLabel("capacity"), "模型容量不足");
});
