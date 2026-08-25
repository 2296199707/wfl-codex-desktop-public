import assert from "node:assert/strict";
import test from "node:test";
import { publicCodexNotification } from "../lib/codex-notification.mjs";

test("normalizes trusted Codex model notifications without accepting extra fields", () => {
  const buffering = publicCodexNotification({
    method: "model/safetyBuffering/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      model: "gpt-5.6",
      useCases: ["cyber"],
      reasons: ["transient review"],
      showBufferingUi: true,
      fasterModel: "gpt-5.6-mini",
      authorization: "must-not-reach-browser",
    },
  });
  assert.deepEqual(buffering, {
    method: "model/safetyBuffering/updated",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      model: "gpt-5.6",
      useCases: ["cyber"],
      reasons: ["transient review"],
      showBufferingUi: true,
      fasterModel: "gpt-5.6-mini",
    },
    _wflSource: "codex-app-server",
  });

  const verification = publicCodexNotification({
    method: "model/verification",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      verifications: [
        "trustedAccessForCyber",
        "browserClaimsVerified",
        "trustedAccessForCyber",
      ],
    },
  });
  assert.deepEqual(verification.params.verifications, ["trustedAccessForCyber"]);
  assert.equal(verification._wflSource, "codex-app-server");
});

test("normalizes the 0.149 strict-review notification without exposing extra fields", () => {
  const result = publicCodexNotification({
    method: "autoApprovalReview/strictReviewRequired",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      startedAtMs: 123,
      authorization: "must-not-reach-browser",
    },
  });
  assert.deepEqual(result, {
    method: "autoApprovalReview/strictReviewRequired",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      startedAtMs: 123,
    },
    _wflSource: "codex-app-server",
  });
  assert.throws(
    () => publicCodexNotification({
      method: "autoApprovalReview/strictReviewRequired",
      params: { threadId: "thread_1", turnId: "turn_1", startedAtMs: -1 },
    }),
    /startedAtMs is invalid/,
  );
});

test("rejects malformed trusted model notifications", () => {
  assert.throws(
    () => publicCodexNotification({
      method: "model/verification",
      params: { threadId: "", turnId: "turn_1", verifications: [] },
    }),
    /threadId is invalid/,
  );
  assert.equal(publicCodexNotification(null), null);
  assert.equal(publicCodexNotification({ method: "../event", params: {} }), null);
});

test("unknown Codex notifications are bounded and redact secret-shaped fields", () => {
  const result = publicCodexNotification({
    method: "future/newEvent",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      apiKey: "secret",
      nested: {
        password: "hidden",
        detail: "x".repeat(20_000),
      },
    },
  }, new Set(["warning"]));

  assert.equal(result._wflUnknown, true);
  assert.equal(result._wflSource, "codex-app-server");
  assert.equal(result.params.apiKey, "[已隐藏]");
  assert.equal(result.params.nested.password, "[已隐藏]");
  assert.ok(result.params.nested.detail.length <= 8_192);
  assert.equal(result.params._wflTruncated, true);
});

test("reviewed notifications keep their native payload shape", () => {
  const params = {
    threadId: "thread_1",
    turnId: "turn_1",
    item: { type: "agentMessage", text: "complete" },
  };
  const result = publicCodexNotification(
    { method: "item/completed", params },
    new Set(["item/completed"]),
  );
  assert.equal(result.params, params);
  assert.equal(result._wflSource, undefined);
});

test("normalizes Guardian warnings and unstable auto-review events as trusted read-only data", () => {
  const warning = publicCodexNotification({
    method: "guardianWarning",
    params: {
      threadId: "thread_1",
      message: "Review this action",
      password: "must-not-reach-browser",
    },
  });
  assert.deepEqual(warning, {
    method: "guardianWarning",
    params: {
      threadId: "thread_1",
      message: "Review this action",
    },
    _wflSource: "codex-app-server",
  });

  const completed = publicCodexNotification({
    method: "item/autoApprovalReview/completed",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      startedAtMs: 100,
      completedAtMs: 220,
      reviewId: "review_1",
      targetItemId: "item_1",
      decisionSource: "agent",
      review: {
        status: "denied",
        riskLevel: "critical",
        userAuthorization: "low",
        rationale: "The command crosses the current permission boundary.",
        token: "must-not-reach-browser",
      },
      action: {
        type: "command",
        source: "unifiedExec",
        command: "sudo systemctl restart example",
        cwd: "/srv/project",
        authorization: "must-not-reach-browser",
      },
      event: {
        credentials: "must-not-reach-browser",
      },
    },
  });
  assert.deepEqual(completed, {
    method: "item/autoApprovalReview/completed",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      startedAtMs: 100,
      reviewId: "review_1",
      targetItemId: "item_1",
      review: {
        status: "denied",
        riskLevel: "critical",
        userAuthorization: "low",
        rationale: "The command crosses the current permission boundary.",
      },
      action: {
        type: "command",
        source: "unifiedExec",
        command: "sudo systemctl restart example",
        cwd: "/srv/project",
      },
      completedAtMs: 220,
      decisionSource: "agent",
    },
    _wflSource: "codex-app-server",
  });
  assert.equal(JSON.stringify(completed).includes("must-not-reach-browser"), false);
});

test("bounds Guardian action details and validates required review identity", () => {
  const started = publicCodexNotification({
    method: "item/autoApprovalReview/started",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      startedAtMs: 100,
      reviewId: "review_1",
      targetItemId: null,
      review: {
        status: "inProgress",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
      },
      action: {
        type: "networkAccess",
        target: "https://example.test/private",
        host: "example.test",
        protocol: "https",
        port: 443,
        apiKey: "must-not-reach-browser",
      },
    },
  });
  assert.equal(started.params.action.type, "networkAccess");
  assert.equal(started.params.action.host, "example.test");
  assert.equal(started.params.action.port, 443);
  assert.equal(started.params.action.apiKey, undefined);
  assert.throws(
    () => publicCodexNotification({
      method: "item/autoApprovalReview/started",
      params: {
        threadId: "thread_1",
        turnId: "",
        startedAtMs: 100,
        reviewId: "review_1",
      },
    }),
    /turnId is invalid/,
  );
});

test("normalizes execution-environment lifecycle without exposing connection details", () => {
  const connected = publicCodexNotification({
    method: "thread/environment/connected",
    params: {
      threadId: "thread_1",
      environmentId: "devbox",
      execServerUrl: "wss://secret.example.test",
    },
  });
  assert.deepEqual(connected, {
    method: "thread/environment/connected",
    params: {
      threadId: "thread_1",
      environmentId: "devbox",
    },
    _wflSource: "codex-app-server",
  });
});
