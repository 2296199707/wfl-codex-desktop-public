import {
  MAP_AI_APPROVAL_POLICIES,
} from "./map-ai-risk.mjs";

export const MAP_AI_APPROVAL_POLICY_DEFAULT = "ask_each";

/**
 * Map approval is deliberately separate from Codex command/file approval.
 * Conversation settings only provide a safe UI suggestion; a managed map
 * task still requires an explicit user confirmation before a snapshot exists.
 */
export function suggestMapAiApprovalPolicy({
  conversationApprovalPolicy = null,
  conversationApprovalsReviewer = null,
} = {}) {
  const normalizedPolicy = typeof conversationApprovalPolicy === "string"
    ? conversationApprovalPolicy
    : null;
  const normalizedReviewer = typeof conversationApprovalsReviewer === "string"
    ? conversationApprovalsReviewer
    : null;

  if (normalizedPolicy === "never") {
    return Object.freeze({
      policy: "full_authorization",
      source: "conversation_suggestion",
      requiresExplicitConfirmation: true,
      reason: "conversation_never_prefers_fewer_prompts",
    });
  }
  if (normalizedPolicy === "on-request" && normalizedReviewer === "auto_review") {
    return Object.freeze({
      policy: "ai_review",
      source: "conversation_suggestion",
      requiresExplicitConfirmation: true,
      reason: "conversation_auto_review_prefers_reviewed_batches",
    });
  }
  return Object.freeze({
    policy: "ask_each",
    source: normalizedPolicy || normalizedReviewer ? "conversation_suggestion" : "safe_default",
    requiresExplicitConfirmation: true,
    reason: normalizedPolicy === "untrusted"
      ? "conversation_untrusted_requires_user_confirmation"
      : "safe_default_requires_user_confirmation",
  });
}

/**
 * Resolve a UI selection without granting access. The returned object is a
 * proposal for a task contract; callers must pass `userConfirmed: true` to
 * createMapAiApprovalSnapshot before direct_apply can be enabled.
 */
export function resolveMapAiApprovalPolicy({
  mapApprovalPolicy = null,
  conversationApprovalPolicy = null,
  conversationApprovalsReviewer = null,
} = {}) {
  const explicit = mapApprovalPolicy !== null && mapApprovalPolicy !== undefined;
  const suggestion = suggestMapAiApprovalPolicy({
    conversationApprovalPolicy,
    conversationApprovalsReviewer,
  });
  const policy = explicit ? normalizeMapApprovalPolicy(mapApprovalPolicy) : suggestion.policy;
  return Object.freeze({
    policy,
    source: explicit ? "map_selection" : suggestion.source,
    requiresExplicitConfirmation: true,
    suggestedPolicy: suggestion.policy,
    conversationApprovalPolicy: typeof conversationApprovalPolicy === "string" ? conversationApprovalPolicy : null,
    conversationApprovalsReviewer: typeof conversationApprovalsReviewer === "string" ? conversationApprovalsReviewer : null,
  });
}

/**
 * Create the immutable policy portion of a managed-task contract. This is
 * intentionally impossible to call without a user confirmation marker.
 */
export function createMapAiApprovalSnapshot({
  mapApprovalPolicy = null,
  userConfirmed = false,
  conversationApprovalPolicy = null,
  conversationApprovalsReviewer = null,
} = {}) {
  if (userConfirmed !== true) {
    throw new Error("managed map approval requires explicit user confirmation");
  }
  const resolved = resolveMapAiApprovalPolicy({
    mapApprovalPolicy,
    conversationApprovalPolicy,
    conversationApprovalsReviewer,
  });
  return Object.freeze({
    version: 1,
    policy: resolved.policy,
    source: resolved.source,
    conversationApprovalPolicy: resolved.conversationApprovalPolicy,
    conversationApprovalsReviewer: resolved.conversationApprovalsReviewer,
    userConfirmed: true,
  });
}

export function normalizeMapApprovalPolicy(value) {
  if (!MAP_AI_APPROVAL_POLICIES.includes(value)) throw new TypeError("invalid map approval policy");
  return value;
}
