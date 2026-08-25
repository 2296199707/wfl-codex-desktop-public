import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexFeedbackPreview,
  codexFeedbackAttachment,
  codexFeedbackUploadParams,
  normalizeCodexFeedbackDraft,
  redactCodexFeedbackText,
} from "../lib/codex-feedback.mjs";

test("normalizes explicit feedback without retaining credentials or local paths", () => {
  const draft = normalizeCodexFeedbackDraft({
    classification: "bug",
    reason: [
      "Login failed at /srv/private/project.",
      "api_key=sk-super-secret-value-123456",
      "Authorization: Bearer token-value-123456",
      "https://alice:password@example.test/path?token=secret-value",
    ].join("\n"),
    errorCode: "HTTP 401",
    includeDiagnostics: true,
  });
  assert.equal(draft.classification, "bug");
  assert.equal(draft.errorCode, "HTTP 401");
  assert.equal(draft.includeDiagnostics, true);
  assert.doesNotMatch(draft.reason, /super-secret|token-value|alice:password|\/srv\/private/);
  assert.match(draft.reason, /\[REDACTED\]/);
  assert.match(draft.reason, /\[PATH\]/);
});

test("builds a bounded diagnostic preview without logs, conversations, source, or commands", () => {
  const result = buildCodexFeedbackPreview({
    draft: {
      classification: "performance",
      reason: "The task status remained reconnecting.",
      errorCode: "WS 1006",
      includeDiagnostics: true,
    },
    appVersion: "0.39.33",
    codexVersion: "codex-cli 0.146.0",
    protocolBaseline: "codex-cli 0.146.0",
    now: Date.parse("2026-07-29T12:00:00Z"),
    nodeVersion: "v22.23.1",
    platform: "linux",
    arch: "x64",
    runtime: {
      codexReady: false,
      connectedClients: 2,
      taskCounts: { running: 3, failed: 1 },
      goalRecoveryWaiting: 4,
      multiUserEnabled: true,
      prompt: "must never appear",
      cwd: "/srv/private/project",
      command: "curl secret",
    },
  });
  assert.equal(result.preview.diagnostic.runtime.taskCounts.running, 3);
  assert.equal(result.preview.diagnostic.runtime.taskCounts.failed, 1);
  assert.equal(result.preview.uploadPolicy.includeNativeLogs, false);
  assert.equal(result.preview.uploadPolicy.includeConversation, false);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(result.copyText, /must never appear|\/srv\/private|curl secret/);
  const attachment = codexFeedbackAttachment(result.preview);
  assert.ok(Buffer.byteLength(attachment) < 32 * 1024);
});

test("produces strict native upload params with no thread or native logs", () => {
  const result = buildCodexFeedbackPreview({
    draft: {
      classification: "incorrect_result",
      reason: "The final status did not match the completed task.",
      errorCode: null,
      includeDiagnostics: false,
    },
    appVersion: "0.39.33",
    protocolBaseline: "codex-cli 0.146.0",
    runtime: {},
  });
  const params = codexFeedbackUploadParams(result.preview);
  assert.deepEqual(params.extraLogFiles, null);
  assert.equal(params.includeLogs, false);
  assert.equal(Object.hasOwn(params, "threadId"), false);
  assert.equal(Object.hasOwn(params, "conversation"), false);
  assert.equal(Object.hasOwn(params, "prompt"), false);
});

test("rejects unknown classifications and unsafe error codes", () => {
  assert.throws(
    () => normalizeCodexFeedbackDraft({ classification: "raw", reason: "Issue", includeDiagnostics: false }),
    /请选择反馈类型/,
  );
  assert.throws(
    () => normalizeCodexFeedbackDraft({
      classification: "bug",
      reason: "Issue",
      errorCode: "token=secret&password=secret",
      includeDiagnostics: false,
    }),
    /错误码/,
  );
  for (const errorCode of [
    "sk-error-code-secret-123456",
    "gho_errorcodesecret123456",
    "/srv/private/error.log",
    "019f99f5-f4e7-7ac3-b52c-caab9a7955f7",
  ]) {
    assert.throws(
      () => normalizeCodexFeedbackDraft({
        classification: "bug",
        reason: "Issue",
        errorCode,
        includeDiagnostics: false,
      }),
      /错误码/,
    );
  }
});

test("redacts token-shaped values, identifiers, and Windows paths", () => {
  const redacted = redactCodexFeedbackText(
    "cookie=session-secret gho_personalsecret123456 C:\\Users\\alice\\project 019f99f5-f4e7-7ac3-b52c-caab9a7955f7",
  );
  assert.doesNotMatch(redacted, /session-secret|personalsecret|Users|019f99f5/);
  assert.match(redacted, /\[REDACTED\].*\[PATH\].*\[ID\]/);
});
