const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*$/;
const SECRET_KEY_PATTERN = /(?:authorization|cookie|password|secret|token|credential|api[_-]?key)/i;
const MODEL_VERIFICATIONS = new Set(["trustedAccessForCyber"]);
const GUARDIAN_REVIEW_STATUSES = new Set(["inProgress", "approved", "denied", "timedOut", "aborted"]);
const GUARDIAN_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const GUARDIAN_USER_AUTHORIZATIONS = new Set(["unknown", "low", "medium", "high"]);
const GUARDIAN_ACTION_TYPES = new Set([
  "command",
  "execve",
  "applyPatch",
  "networkAccess",
  "mcpToolCall",
  "requestPermissions",
]);
const MAX_UNKNOWN_NOTIFICATION_BYTES = 64 * 1024;

export const CODEX_MODEL_NOTIFICATION_METHODS = new Set([
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "autoApprovalReview/strictReviewRequired",
  "turn/moderationMetadata",
  "guardianWarning",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "thread/environment/connected",
  "thread/environment/disconnected",
]);

export function publicCodexNotification(rawPayload, knownMethods = new Set()) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const method = boundedIdentifier(rawPayload.method, 256);
  if (!method || !METHOD_PATTERN.test(method)) return null;
  const params = plainObject(rawPayload.params) ? rawPayload.params : {};

  if (method === "model/rerouted") {
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      turnId: requiredIdentifier(params.turnId, "turnId"),
      fromModel: boundedText(params.fromModel, 256),
      toModel: boundedText(params.toModel, 256),
      reason: boundedText(params.reason, 256),
    });
  }

  if (method === "model/safetyBuffering/updated") {
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      turnId: requiredIdentifier(params.turnId, "turnId"),
      model: boundedText(params.model, 256),
      useCases: boundedStringArray(params.useCases, 16, 400),
      reasons: boundedStringArray(params.reasons, 16, 400),
      showBufferingUi: params.showBufferingUi === true,
      fasterModel: params.fasterModel == null ? null : boundedText(params.fasterModel, 256),
    });
  }

  if (method === "model/verification") {
    const verifications = Array.isArray(params.verifications)
      ? [...new Set(params.verifications.filter((value) => MODEL_VERIFICATIONS.has(value)))]
      : [];
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      turnId: requiredIdentifier(params.turnId, "turnId"),
      verifications,
    });
  }

  if (method === "autoApprovalReview/strictReviewRequired") {
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      turnId: requiredIdentifier(params.turnId, "turnId"),
      startedAtMs: requiredNonnegativeInteger(params.startedAtMs, "startedAtMs"),
    });
  }

  if (method === "turn/moderationMetadata") {
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      turnId: requiredIdentifier(params.turnId, "turnId"),
      metadata: boundedPublicValue(params.metadata),
    });
  }

  if (method === "guardianWarning") {
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      message: boundedText(params.message, 4_000) || "Codex Guardian 发出安全警告",
    });
  }

  if (method === "item/autoApprovalReview/started") {
    return trustedNotification(method, publicGuardianReviewNotification(params, false));
  }

  if (method === "item/autoApprovalReview/completed") {
    return trustedNotification(method, publicGuardianReviewNotification(params, true));
  }

  if (method === "thread/environment/connected" || method === "thread/environment/disconnected") {
    return trustedNotification(method, {
      threadId: requiredIdentifier(params.threadId, "threadId"),
      environmentId: requiredIdentifier(params.environmentId, "environmentId"),
    });
  }

  if (knownMethods.has(method)) return { method, params };

  const publicParams = boundedPublicValue(params);
  return {
    method,
    params: plainObject(publicParams) ? publicParams : {},
    _wflUnknown: true,
    _wflSource: "codex-app-server",
  };
}

function trustedNotification(method, params) {
  return {
    method,
    params,
    _wflSource: "codex-app-server",
  };
}

function publicGuardianReviewNotification(params, completed) {
  const result = {
    threadId: requiredIdentifier(params.threadId, "threadId"),
    turnId: requiredIdentifier(params.turnId, "turnId"),
    startedAtMs: requiredNonnegativeInteger(params.startedAtMs, "startedAtMs"),
    reviewId: requiredIdentifier(params.reviewId, "reviewId"),
    targetItemId: params.targetItemId == null
      ? null
      : requiredIdentifier(params.targetItemId, "targetItemId"),
    review: publicGuardianReview(params.review),
    action: publicGuardianAction(params.action),
  };
  if (completed) {
    result.completedAtMs = requiredNonnegativeInteger(params.completedAtMs, "completedAtMs");
    result.decisionSource = params.decisionSource === "agent" ? "agent" : null;
  }
  return result;
}

function publicGuardianReview(value) {
  const review = plainObject(value) ? value : {};
  return {
    status: GUARDIAN_REVIEW_STATUSES.has(review.status) ? review.status : "aborted",
    riskLevel: GUARDIAN_RISK_LEVELS.has(review.riskLevel) ? review.riskLevel : null,
    userAuthorization: GUARDIAN_USER_AUTHORIZATIONS.has(review.userAuthorization)
      ? review.userAuthorization
      : null,
    rationale: review.rationale == null ? null : boundedText(review.rationale, 8_000),
  };
}

function publicGuardianAction(value) {
  const action = plainObject(value) ? value : {};
  const type = GUARDIAN_ACTION_TYPES.has(action.type) ? action.type : "unknown";
  if (type === "command") {
    return {
      type,
      source: ["shell", "unifiedExec"].includes(action.source) ? action.source : null,
      command: boundedText(action.command, 16_000),
      cwd: boundedText(action.cwd, 4_096),
    };
  }
  if (type === "execve") {
    return {
      type,
      source: ["shell", "unifiedExec"].includes(action.source) ? action.source : null,
      program: boundedText(action.program, 4_096),
      argv: boundedStringArray(action.argv, 64, 2_048),
      cwd: boundedText(action.cwd, 4_096),
    };
  }
  if (type === "applyPatch") {
    return {
      type,
      cwd: boundedText(action.cwd, 4_096),
      files: boundedStringArray(action.files, 256, 4_096),
    };
  }
  if (type === "networkAccess") {
    return {
      type,
      target: boundedText(action.target, 2_048),
      host: boundedText(action.host, 1_024),
      protocol: boundedText(action.protocol, 64),
      port: Number.isInteger(action.port) && action.port >= 0 && action.port <= 65_535
        ? action.port
        : null,
    };
  }
  if (type === "mcpToolCall") {
    return {
      type,
      server: boundedText(action.server, 256),
      toolName: boundedText(action.toolName, 256),
      connectorId: action.connectorId == null ? null : boundedText(action.connectorId, 256),
      connectorName: action.connectorName == null ? null : boundedText(action.connectorName, 256),
      toolTitle: action.toolTitle == null ? null : boundedText(action.toolTitle, 512),
    };
  }
  if (type === "requestPermissions") {
    return {
      type,
      reason: action.reason == null ? null : boundedText(action.reason, 8_000),
      permissions: boundedPublicValue(action.permissions),
    };
  }
  return { type };
}

function requiredIdentifier(value, name) {
  const normalized = boundedIdentifier(value, 256);
  if (!normalized) throw new Error(`Codex ${name} is invalid`);
  return normalized;
}

function requiredNonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Codex ${name} is invalid`);
  return value;
}

function boundedIdentifier(value, limit) {
  if (typeof value !== "string" || !value || value.length > limit || /[\r\n\0]/.test(value)) return null;
  return value;
}

function boundedText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").slice(0, limit);
}

function boundedStringArray(value, limit, stringLimit) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .filter((entry) => typeof entry === "string")
    .map((entry) => boundedText(entry, stringLimit));
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedPublicValue(value) {
  const budget = { bytes: 0, entries: 0, truncated: false };
  const sanitized = visitPublicValue(value, budget, 0);
  if (budget.truncated && plainObject(sanitized)) sanitized._wflTruncated = true;
  return sanitized;
}

function visitPublicValue(value, budget, depth) {
  if (budget.truncated) return null;
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return consumeText(value, budget);
  if (depth >= 6 || budget.entries >= 512) {
    budget.truncated = true;
    return "[内容已截断]";
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const entry of value.slice(0, 128)) {
      budget.entries += 1;
      result.push(visitPublicValue(entry, budget, depth + 1));
      if (budget.truncated) break;
    }
    if (value.length > result.length) budget.truncated = true;
    return result;
  }
  if (!plainObject(value)) return String(value).slice(0, 256);
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 128)) {
    budget.entries += 1;
    const safeKey = String(key).slice(0, 256);
    result[safeKey] = SECRET_KEY_PATTERN.test(safeKey)
      ? "[已隐藏]"
      : visitPublicValue(entry, budget, depth + 1);
    if (budget.truncated) break;
  }
  if (Object.keys(value).length > Object.keys(result).length) budget.truncated = true;
  return result;
}

function consumeText(value, budget) {
  const remaining = Math.max(0, MAX_UNKNOWN_NOTIFICATION_BYTES - budget.bytes);
  if (!remaining) {
    budget.truncated = true;
    return "";
  }
  const candidate = value.replace(/\0/g, "").slice(0, Math.min(8_192, remaining));
  budget.bytes += Buffer.byteLength(candidate);
  if (candidate.length < value.length || budget.bytes >= MAX_UNKNOWN_NOTIFICATION_BYTES) {
    budget.truncated = true;
  }
  return candidate;
}
