import crypto from "node:crypto";

export const CODEX_FEEDBACK_ATTACHMENT_MAX_BYTES = 32 * 1024;
export const CODEX_FEEDBACK_PREVIEW_TTL_MS = 10 * 60 * 1000;

export const CODEX_FEEDBACK_CLASSIFICATIONS = Object.freeze({
  bug: "功能异常",
  incorrect_result: "结果不正确",
  performance: "性能或稳定性",
  feature_request: "功能建议",
  other: "其他反馈",
});

const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/ -]{0,79}$/;

export function normalizeCodexFeedbackDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw feedbackError(400, "反馈内容不正确");
  }
  const classification = String(value.classification || "");
  if (!Object.hasOwn(CODEX_FEEDBACK_CLASSIFICATIONS, classification)) {
    throw feedbackError(400, "请选择反馈类型");
  }
  const rawReason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!rawReason || rawReason.length > 2_000) {
    throw feedbackError(400, "请用 1 到 2000 个字符说明问题");
  }
  const reason = redactCodexFeedbackText(rawReason)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  if (!reason) throw feedbackError(400, "反馈说明脱敏后为空");
  const errorCode = value.errorCode == null || value.errorCode === ""
    ? null
    : String(value.errorCode).trim();
  if (
    errorCode !== null
    && (
      !ERROR_CODE_PATTERN.test(errorCode)
      || redactCodexFeedbackText(errorCode) !== errorCode
    )
  ) {
    throw feedbackError(400, "错误码只能包含字母、数字、点、冒号、斜杠、横线和空格");
  }
  return {
    classification,
    classificationLabel: CODEX_FEEDBACK_CLASSIFICATIONS[classification],
    reason,
    errorCode,
    includeDiagnostics: value.includeDiagnostics === true,
  };
}

export function buildCodexFeedbackPreview({
  draft,
  appVersion,
  codexVersion = null,
  protocolBaseline,
  runtime,
  now = Date.now(),
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
}) {
  const normalized = normalizeCodexFeedbackDraft(draft);
  const diagnostic = normalized.includeDiagnostics
    ? {
        format: "wfl-codex-safe-diagnostics-v1",
        generatedAt: new Date(now).toISOString(),
        versions: {
          app: boundedText(appVersion, 40),
          codex: boundedText(codexVersion, 80),
          protocol: boundedText(protocolBaseline, 80),
          node: boundedText(nodeVersion, 40),
        },
        system: {
          platform: boundedText(platform, 40),
          arch: boundedText(arch, 40),
        },
        runtime: normalizeFeedbackRuntime(runtime),
        issue: {
          classification: normalized.classification,
          errorCode: normalized.errorCode,
        },
        privacy: {
          rawLogsIncluded: false,
          conversationIncluded: false,
          promptOrReplyIncluded: false,
          projectFilesIncluded: false,
          commandContentsIncluded: false,
          credentialsIncluded: false,
          attachmentCount: 1,
          attachmentMaxBytes: CODEX_FEEDBACK_ATTACHMENT_MAX_BYTES,
          sourceWindowMinutes: 0,
        },
      }
    : null;
  const preview = {
    classification: normalized.classification,
    classificationLabel: normalized.classificationLabel,
    reason: normalized.reason,
    errorCode: normalized.errorCode,
    includeDiagnostics: normalized.includeDiagnostics,
    diagnostic,
    uploadPolicy: {
      includeNativeLogs: false,
      includeConversation: false,
      extraLogFiles: diagnostic ? 1 : 0,
      requiresExplicitConfirmation: true,
    },
  };
  const copyText = formatCodexFeedbackPreview(preview);
  return {
    draft: normalized,
    preview,
    copyText,
    digest: crypto.createHash("sha256").update(copyText).digest("hex"),
  };
}

export function formatCodexFeedbackPreview(preview) {
  const lines = [
    `类型：${preview.classificationLabel}`,
    `错误码：${preview.errorCode || "未提供"}`,
    `说明：${preview.reason}`,
    `原生日志：不上传`,
    `对话、提示词与回复：不上传`,
    `项目源码与命令内容：不上传`,
    `脱敏诊断摘要：${preview.includeDiagnostics ? "1 个，最多 32 KiB" : "不上传"}`,
  ];
  if (preview.diagnostic) {
    lines.push("", "诊断预览：", JSON.stringify(preview.diagnostic, null, 2));
  }
  return lines.join("\n");
}

export function codexFeedbackUploadParams(preview, attachmentPath = null) {
  if (!preview || typeof preview !== "object") throw feedbackError(400, "反馈预览不存在");
  const tags = {
    source: "wfl-codex-desktop",
    app_version: boundedTag(preview.diagnostic?.versions?.app),
    codex_version: boundedTag(preview.diagnostic?.versions?.codex),
    error_code: boundedTag(preview.errorCode),
  };
  return {
    classification: preview.classification,
    reason: preview.errorCode
      ? `[${preview.errorCode}] ${preview.reason}`
      : preview.reason,
    includeLogs: false,
    extraLogFiles: attachmentPath ? [attachmentPath] : null,
    tags: Object.fromEntries(Object.entries(tags).filter(([, value]) => value)),
  };
}

export function codexFeedbackAttachment(preview) {
  if (!preview?.diagnostic) return null;
  const content = `${JSON.stringify(preview.diagnostic, null, 2)}\n`;
  if (Buffer.byteLength(content) > CODEX_FEEDBACK_ATTACHMENT_MAX_BYTES) {
    throw feedbackError(413, "脱敏诊断摘要超过大小限制");
  }
  return content;
}

export function redactCodexFeedbackText(value) {
  return String(value || "")
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s:@]+)(?::[^@\s/]*)?@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]",
    )
    .replace(/\b(?:[srp]k-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9_]{8,})\b/gi, "[REDACTED]")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
      "[REDACTED]",
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|cookie|authorization)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|signature)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[ID]")
    .replace(/(^|[\s("'`])(?:\/(?:[^/\s"'`]+\/)*[^/\s"'`]*)/g, "$1[PATH]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`]*/g, "[PATH]")
    .replace(/(^|[\s("'`])~\/[^\s"'`]*/g, "$1[PATH]");
}

function normalizeFeedbackRuntime(value) {
  const taskCounts = {};
  for (const status of ["running", "waiting", "stopping", "completed", "failed", "interrupted"]) {
    const count = Number(value?.taskCounts?.[status]);
    taskCounts[status] = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }
  return {
    codexReady: value?.codexReady === true,
    connectedClients: boundedInteger(value?.connectedClients, 0, 128),
    taskCounts,
    goalRecoveryWaiting: boundedInteger(value?.goalRecoveryWaiting, 0, 512),
    multiUserEnabled: value?.multiUserEnabled === true,
  };
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : minimum;
}

function boundedText(value, maximum) {
  if (value == null) return null;
  const text = String(value).replace(/[\r\n\t]+/g, " ").trim();
  return text ? text.slice(0, maximum) : null;
}

function boundedTag(value) {
  const text = boundedText(value, 80);
  return text && /^[A-Za-z0-9._:/ -]+$/.test(text) ? text : null;
}

function feedbackError(status, message) {
  return Object.assign(new Error(message), { status });
}
