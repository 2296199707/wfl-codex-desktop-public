import { createHash } from "node:crypto";

export function assistantMessageFingerprint({
  text,
  phase = null,
  role = "assistant",
  type = "agentMessage",
} = {}) {
  if (typeof text !== "string" || role !== "assistant") return null;
  const normalizedType = ["agentMessage", "message"].includes(type)
    ? "assistant-message"
    : null;
  if (!normalizedType) return null;
  return createHash("sha256").update(JSON.stringify([
    normalizedType,
    role,
    typeof phase === "string" ? phase : null,
    text,
  ])).digest("hex");
}

export function nativeResponseAssistantIdentity(value) {
  if (value?.type !== "response_item") return null;
  const payload = value.payload;
  if (payload?.type !== "message" || payload.role !== "assistant") return null;
  const itemId = safeIdentifier(payload.id);
  if (!itemId) return null;
  const text = (Array.isArray(payload.content) ? payload.content : [])
    .filter((entry) => entry?.type === "output_text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("");
  const fingerprint = assistantMessageFingerprint({
    text,
    phase: payload.phase,
    role: payload.role,
    type: payload.type,
  });
  if (!fingerprint) return null;
  return {
    itemId,
    turnId: safeIdentifier(payload.internal_chat_message_metadata_passthrough?.turn_id),
    fingerprint,
    phase: typeof payload.phase === "string" ? payload.phase : null,
  };
}

function safeIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\0\r\n]/.test(value)
    ? value
    : null;
}
