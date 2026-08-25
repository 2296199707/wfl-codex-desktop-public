// Conversation image context is intentionally an in-memory, bounded ledger.
// It is never persisted to localStorage/sessionStorage and therefore cannot
// turn image bytes (or data URLs) into long-lived browser state.

const SHA256 = /^[a-f0-9]{64}$/iu;
const MAX_CONTEXT_KEY_LENGTH = 4_096;
export const MAX_IMAGE_CONTEXT_KEYS = 128;
export const MAX_IMAGES_PER_CONTEXT = 64;

export function imageContextKey({ accountId = "legacy", runtime = "codex", projectPath = "", threadId = "", windowId = "" } = {}) {
  return [
    String(accountId || "legacy").slice(0, 256),
    String(runtime || "codex").slice(0, 64),
    String(windowId || "").slice(0, 512),
    String(projectPath || "").slice(0, 2_048),
    String(threadId || "draft").slice(0, 1_024),
  ]
    .join("\u001f");
}

export function imageAttachmentIdentity(attachment) {
  if (!attachment || typeof attachment !== "object" || typeof attachment.path !== "string" || !attachment.path) return null;
  const sha256 = String(attachment.sha256 || "").trim().toLowerCase();
  if (SHA256.test(sha256)) return `sha256:${sha256}`;
  // Paths, byte counts, and media types cannot prove content identity after a
  // project file is replaced in place. Images without an authoritative hash
  // are therefore always sent instead of risking a false context hit.
  return null;
}

export function prepareConversationImageContext(attachments, {
  ledger = new Map(),
  contextKey = "",
  projectPath = "",
  isolationEnabled = false,
} = {}) {
  if (!isolationEnabled) {
    return {
      attachments: (Array.isArray(attachments) ? attachments : []).map((attachment) => (
        attachment?.mediaType?.startsWith("image/")
          ? { ...attachment, forceResend: false }
          : attachment
      )),
      references: [],
      transaction: { contextKey: "", identities: [] },
    };
  }
  const sent = ledger instanceof Map && ledger.get(contextKey) instanceof Set
    ? ledger.get(contextKey)
    : new Set();
  const output = [];
  const references = [];
  const pendingIdentities = new Set();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment?.mediaType?.startsWith("image/")) {
      output.push(attachment);
      continue;
    }
    const identity = imageAttachmentIdentity(attachment);
    const includedThisTurn = identity ? pendingIdentities.has(identity) : false;
    if (!identity || attachment.forceResend === true || (!sent.has(identity) && !includedThisTurn)) {
      if (identity && !sent.has(identity)) pendingIdentities.add(identity);
      output.push({ ...attachment, forceResend: false });
      continue;
    }
    references.push(imageAttachmentMetadata(attachment, projectPath));
  }
  return {
    attachments: output,
    references,
    transaction: {
      contextKey: String(contextKey || "").slice(0, MAX_CONTEXT_KEY_LENGTH),
      identities: [...pendingIdentities].slice(0, MAX_IMAGES_PER_CONTEXT),
    },
  };
}

export function bindConversationImageContext(transaction, contextKey) {
  return {
    contextKey: String(contextKey || "").slice(0, MAX_CONTEXT_KEY_LENGTH),
    identities: Array.isArray(transaction?.identities)
      ? transaction.identities.slice(0, MAX_IMAGES_PER_CONTEXT)
      : [],
  };
}

export function commitConversationImageContext(ledger, transaction) {
  if (!(ledger instanceof Map) || !transaction?.contextKey || !Array.isArray(transaction.identities)) return;
  const identities = transaction.identities
    .filter((identity) => typeof identity === "string" && identity.length <= 1_200)
    .slice(0, MAX_IMAGES_PER_CONTEXT);
  if (!identities.length) return;
  const sent = ledger.get(transaction.contextKey) instanceof Set
    ? new Set(ledger.get(transaction.contextKey))
    : new Set();
  for (const identity of identities) sent.add(identity);
  while (sent.size > MAX_IMAGES_PER_CONTEXT) sent.delete(sent.values().next().value);
  // Delete/set refreshes insertion order so the outer Map acts as a bounded
  // least-recently-committed ledger without timers or persistent storage.
  ledger.delete(transaction.contextKey);
  ledger.set(transaction.contextKey, sent);
  while (ledger.size > MAX_IMAGE_CONTEXT_KEYS) ledger.delete(ledger.keys().next().value);
}

export function imageAttachmentMetadata(attachment, projectPath = "") {
  const absolute = String(attachment?.path || "").replaceAll("\\", "/");
  const root = String(projectPath || "").replaceAll("\\", "/").replace(/\/+$/u, "");
  let relative = absolute;
  if (root && (absolute === root || absolute.startsWith(`${root}/`))) relative = absolute.slice(root.length).replace(/^\/+/, "");
  if (!relative || relative.startsWith("/") || relative.includes("..")) relative = absolute.split("/").pop() || "image";
  const fields = [`图片引用：${relative}`];
  const sha256 = String(attachment?.sha256 || "").trim().toLowerCase();
  if (SHA256.test(sha256)) fields.push(`sha256=${sha256}`);
  const size = Number(attachment?.size);
  if (Number.isFinite(size) && size >= 0) fields.push(`bytes=${Math.floor(size)}`);
  const width = Number(attachment?.width);
  const height = Number(attachment?.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) fields.push(`尺寸=${Math.floor(width)}x${Math.floor(height)}`);
  fields.push("本轮未重新发送图片字节；如需再次查看，请在附件上点击“重新发送图片”。");
  return fields.join("，");
}
