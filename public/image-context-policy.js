// Image results must explicitly declare where they belong before a caller can
// attach them. Missing or unknown scopes fail closed so a new caller cannot
// accidentally place map or visual-review images in a conversation.

const CONTEXT_SCOPES = new Set(["conversation", "map-editor", "character-editor", "visual-review"]);
const MAX_REPORT_SUMMARY = 2_000;
const MAX_REPORT_TAGS = 16;
const MAX_REPORT_ISSUES = 32;
const MAX_REPORT_RECOMMENDATIONS = 16;

export function normalizeImageContextScope(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error("必须明确指定图片上下文作用域");
  }
  const scope = String(value || "").trim().toLowerCase();
  if (!CONTEXT_SCOPES.has(scope)) throw new Error(`图片上下文作用域无效：${scope}`);
  return scope;
}

export function imageContextPolicy(value) {
  const scope = normalizeImageContextScope(value);
  if (scope === "map-editor") {
    return {
      scope,
      allowConversationAttachment: false,
      destination: "map-candidate",
      actionLabel: "加入地图候选",
    };
  }
  if (scope === "character-editor") {
    return {
      scope,
      allowConversationAttachment: false,
      destination: "character-candidate",
      actionLabel: "加入角色候选",
    };
  }
  if (scope === "visual-review") {
    return {
      scope,
      allowConversationAttachment: false,
      destination: "visual-review-report",
      actionLabel: "保存审查报告",
    };
  }
  return {
    scope: "conversation",
    allowConversationAttachment: true,
    destination: "conversation",
    actionLabel: "加入对话",
  };
}

// Keep generated-image bookkeeping small enough to carry through UI state and
// prompts without implicitly loading the image into the conversation. The path
// is a project-file reference; no bytes, data URL, or provider payload is
// copied here.
export function imageOutputMetadataReference(output, scope) {
  let policy;
  try {
    policy = imageContextPolicy(scope);
  } catch {
    return null;
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const path = cleanString(output.path);
  const mediaType = cleanString(output.mediaType || output.format);
  if (
    !path
    || /^(?:data|blob|https?|file):/iu.test(path)
    || !mediaType.startsWith("image/")
  ) return null;
  const reference = {
    context: policy.scope,
    destination: policy.destination,
    name: cleanString(output.name) || basename(path),
    path,
    mediaType,
    size: finiteNonnegative(output.size) ? Number(output.size) : 0,
  };
  for (const key of ["width", "height"]) {
    if (finitePositive(output[key])) reference[key] = Number(output[key]);
  }
  const sha256 = cleanString(output.sha256, 128).toLowerCase();
  if (/^[a-f0-9]{64}$/u.test(sha256)) reference.sha256 = sha256;
  const operation = cleanString(output.operation, 32).toLowerCase();
  if (operation) reference.operation = operation;
  return reference;
}

// A complete localImage attachment is an explicit user action. Callers that
// only received a provider result should use imageOutputMetadataReference().
export function imageOutputConversationAttachment(output, scope, options = {}) {
  if (options?.userSelected !== true) return null;
  const reference = imageOutputMetadataReference(output, scope);
  if (!reference) return null;
  if (reference.destination !== "conversation") return null;
  const attachment = {
    name: reference.name,
    path: reference.path,
    mediaType: reference.mediaType,
    size: reference.size,
  };
  for (const key of ["width", "height"]) {
    if (reference[key] !== undefined) attachment[key] = reference[key];
  }
  if (reference.sha256) attachment.sha256 = reference.sha256;
  return attachment;
}

// Visual review is intentionally an allow-list serializer. Never forward raw
// image bytes, data URLs, source paths, provider payloads, or arbitrary fields
// to a conversation-facing result.
export function sanitizeVisualReviewReport(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const report = {
    summary: safeReviewText(source.summary, MAX_REPORT_SUMMARY),
    tags: uniqueReviewStrings(source.tags, MAX_REPORT_TAGS, 128),
    issues: Array.isArray(source.issues)
      ? source.issues.slice(0, MAX_REPORT_ISSUES).map(sanitizeIssue).filter(Boolean)
      : [],
    scores: sanitizeScores(source.scores),
    recommendations: uniqueReviewStrings(source.recommendations, MAX_REPORT_RECOMMENDATIONS, 500),
  };
  return report;
}

function sanitizeIssue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const issue = {
    code: safeReviewText(value.code, 128),
    severity: safeReviewText(value.severity, 32),
    message: safeReviewText(value.message, 1_000),
  };
  if (finiteNumber(value.confidence)) issue.confidence = clamp(Number(value.confidence), 0, 1);
  const region = value.region;
  if (region && typeof region === "object" && !Array.isArray(region)) {
    const candidate = {};
    for (const key of ["x", "y", "width", "height"]) {
      if (finiteNumber(region[key])) candidate[key] = Math.max(0, Number(region[key]));
    }
    if (Object.keys(candidate).length) issue.region = candidate;
  }
  return Object.values(issue).some(Boolean) ? issue : null;
}

function sanitizeScores(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const scores = {};
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(key) || !finiteNumber(raw)) continue;
    scores[key] = clamp(Number(raw), 0, 1);
  }
  return scores;
}

function uniqueReviewStrings(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => safeReviewText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function safeReviewText(value, limit) {
  return cleanString(value, limit)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/_=-]*/giu, "[已移除图片数据]")
    .replace(/\bbase64\s*:\s*[a-z0-9+/_=-]{16,}/giu, "[已移除图片数据]")
    .replace(/\b(?:rawProviderResponse|providerResponse|providerPayload|providerRaw|providerOutput)\s*[:=]\s*[^\s,;]+/giu, "[已移除供应商原始内容]")
    .replace(/\bsk-[a-z0-9_-]{12,}/giu, "[已移除密钥]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'`<>]+\\)*[^\\\s"'`<>]+/gu, "[已移除绝对路径]")
    .replace(/(^|[\s("'`])\/(?:[^\s"'`<>/]+\/)*[^\s"'`<>/]+/gu, "$1[已移除绝对路径]")
    .replace(/\b[a-z0-9+/_-]{80,}={0,2}\b/giu, "[已移除图片数据]")
    .trim();
}

function cleanString(value, limit = 512) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit);
}

function basename(value) {
  return String(value).replaceAll("\\", "/").split("/").pop() || "图片";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteNonnegative(value) {
  return (typeof value === "number" || typeof value === "string")
    && Number.isFinite(Number(value))
    && Number(value) >= 0;
}

function finitePositive(value) {
  return finiteNumber(value) && Number(value) > 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
