import assert from "node:assert/strict";
import test from "node:test";
import {
  createMapAiApprovalSnapshot,
  resolveMapAiApprovalPolicy,
  suggestMapAiApprovalPolicy,
} from "../lib/map-ai-approval-policy.mjs";

test("conversation approval settings only produce map-policy suggestions", () => {
  assert.equal(suggestMapAiApprovalPolicy({
    conversationApprovalPolicy: "on-request",
    conversationApprovalsReviewer: "user",
  }).policy, "ask_each");
  assert.equal(suggestMapAiApprovalPolicy({
    conversationApprovalPolicy: "on-request",
    conversationApprovalsReviewer: "auto_review",
  }).policy, "ai_review");
  assert.equal(suggestMapAiApprovalPolicy({ conversationApprovalPolicy: "never" }).policy, "full_authorization");
  assert.equal(suggestMapAiApprovalPolicy({ conversationApprovalPolicy: "untrusted" }).policy, "ask_each");
});

test("explicit map selection overrides a conversation suggestion without changing conversation policy", () => {
  const resolved = resolveMapAiApprovalPolicy({
    mapApprovalPolicy: "full_authorization",
    conversationApprovalPolicy: "on-request",
    conversationApprovalsReviewer: "user",
  });
  assert.equal(resolved.policy, "full_authorization");
  assert.equal(resolved.suggestedPolicy, "ask_each");
  assert.equal(resolved.source, "map_selection");
  assert.equal(resolved.requiresExplicitConfirmation, true);
});

test("a policy snapshot cannot be created without explicit user confirmation", () => {
  assert.throws(
    () => createMapAiApprovalSnapshot({ mapApprovalPolicy: "full_authorization" }),
    /explicit user confirmation/u,
  );
  const snapshot = createMapAiApprovalSnapshot({
    mapApprovalPolicy: "ai_review",
    userConfirmed: true,
    conversationApprovalPolicy: "never",
  });
  assert.deepEqual(snapshot, {
    version: 1,
    policy: "ai_review",
    source: "map_selection",
    conversationApprovalPolicy: "never",
    conversationApprovalsReviewer: null,
    userConfirmed: true,
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test("changing conversation settings later cannot mutate an existing snapshot", () => {
  const snapshot = createMapAiApprovalSnapshot({
    userConfirmed: true,
    conversationApprovalPolicy: "on-request",
    conversationApprovalsReviewer: "auto_review",
  });
  const later = suggestMapAiApprovalPolicy({ conversationApprovalPolicy: "never" });
  assert.equal(snapshot.policy, "ai_review");
  assert.equal(later.policy, "full_authorization");
});

