export const MAP_CONVERSATION_REQUEST_TYPE = "wfl/map-conversation-request/v1";
export const MAP_CONVERSATION_SNAPSHOT_TYPE = "wfl/map-conversation-snapshot/v1";
export const MAP_CONVERSATION_RESULT_TYPE = "wfl/map-conversation-result/v1";

const REQUEST_ACTIONS = new Set([
  "snapshot-request",
  "send",
  "switch-thread",
  "interrupt",
  "focus-main",
]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,255}$/u;
const MAX_PROJECT_PATH = 4_096;
const MAX_THREAD_ID = 1_024;
const MAX_MESSAGE_TEXT = 12_000;
const MAX_SEND_TEXT = 32_000;
const MAX_THREADS = 100;
const MAX_MESSAGES = 80;
const MAX_ATTACHMENTS = 16;

export function createMapConversationRequest(action, input = {}, now = Date.now()) {
  if (!REQUEST_ACTIONS.has(action)) throw new TypeError("Invalid map conversation action");
  const request = {
    type: MAP_CONVERSATION_REQUEST_TYPE,
    action,
    hostWindowId: boundedIdentifier(input.hostWindowId, "hostWindowId"),
    editorInstanceId: boundedIdentifier(input.editorInstanceId, "editorInstanceId"),
    sessionId: boundedText(input.sessionId, 256, "sessionId"),
    projectPath: boundedProjectPath(input.projectPath),
    requestId: optionalIdentifier(input.requestId) || generatedRequestId(now),
    sentAt: finiteTimestamp(input.sentAt ?? now),
  };
  if (action === "send") {
    request.operationId = boundedIdentifier(input.operationId, "operationId");
    request.threadId = boundedText(input.threadId, MAX_THREAD_ID, "threadId");
    request.text = boundedText(input.text, MAX_SEND_TEXT, "text").trim();
    if (!request.text) throw new TypeError("Invalid text");
  } else if (["switch-thread", "interrupt"].includes(action)) {
    request.threadId = boundedText(input.threadId, MAX_THREAD_ID, "threadId");
  }
  return Object.freeze(request);
}

export function parseMapConversationRequest(value, expected = {}) {
  if (!value || value.type !== MAP_CONVERSATION_REQUEST_TYPE || !REQUEST_ACTIONS.has(value.action)) return null;
  try {
    const parsed = createMapConversationRequest(value.action, value, value.sentAt);
    return bindingMatches(parsed, expected) ? parsed : null;
  } catch {
    return null;
  }
}

export function createMapConversationSnapshot(input = {}, now = Date.now()) {
  const snapshot = {
    type: MAP_CONVERSATION_SNAPSHOT_TYPE,
    hostWindowId: boundedIdentifier(input.hostWindowId, "hostWindowId"),
    editorInstanceId: boundedIdentifier(input.editorInstanceId, "editorInstanceId"),
    sessionId: boundedText(input.sessionId, 256, "sessionId"),
    projectPath: boundedProjectPath(input.projectPath),
    requestId: optionalIdentifier(input.requestId),
    revision: nonnegativeInteger(input.revision, "revision"),
    sentAt: finiteTimestamp(input.sentAt ?? now),
    runtime: input.runtime === "codex" ? "codex" : "unavailable",
    boundThreadId: optionalText(input.boundThreadId, MAX_THREAD_ID),
    activeThreadId: optionalText(input.activeThreadId, MAX_THREAD_ID),
    threads: Object.freeze(normalizeThreads(input.threads)),
    messages: Object.freeze(normalizeMessages(input.messages)),
    conversation: Object.freeze(normalizeConversation(input.conversation)),
    imageDelivery: Object.freeze(normalizeImageDelivery(input.imageDelivery)),
  };
  return Object.freeze(snapshot);
}

export function parseMapConversationSnapshot(value, expected = {}) {
  if (!value || value.type !== MAP_CONVERSATION_SNAPSHOT_TYPE) return null;
  try {
    const parsed = createMapConversationSnapshot(value, value.sentAt);
    return bindingMatches(parsed, expected) ? parsed : null;
  } catch {
    return null;
  }
}

export function createMapConversationResult(input = {}, now = Date.now()) {
  const result = {
    type: MAP_CONVERSATION_RESULT_TYPE,
    hostWindowId: boundedIdentifier(input.hostWindowId, "hostWindowId"),
    editorInstanceId: boundedIdentifier(input.editorInstanceId, "editorInstanceId"),
    sessionId: boundedText(input.sessionId, 256, "sessionId"),
    projectPath: boundedProjectPath(input.projectPath),
    requestId: boundedIdentifier(input.requestId, "requestId"),
    action: REQUEST_ACTIONS.has(input.action) ? input.action : invalid("action"),
    ok: input.ok === true,
    message: optionalText(input.message, 1_000),
    threadId: optionalText(input.threadId, MAX_THREAD_ID),
    sentAt: finiteTimestamp(input.sentAt ?? now),
  };
  return Object.freeze(result);
}

export function parseMapConversationResult(value, expected = {}) {
  if (!value || value.type !== MAP_CONVERSATION_RESULT_TYPE) return null;
  try {
    const parsed = createMapConversationResult(value, value.sentAt);
    return bindingMatches(parsed, expected) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeThreads(value) {
  if (!Array.isArray(value) || value.length > MAX_THREADS) throw new TypeError("Invalid threads");
  const seen = new Set();
  const threads = [];
  for (const entry of value) {
    const id = boundedText(entry?.id, MAX_THREAD_ID, "thread.id");
    if (seen.has(id)) continue;
    seen.add(id);
    threads.push(Object.freeze({
      id,
      title: boundedDisplayText(entry?.title || "未命名对话", 300),
      preview: optionalDisplayText(entry?.preview, 500),
      updatedAt: finiteTimestamp(entry?.updatedAt ?? 0),
      status: normalizeThreadStatus(entry?.status),
      model: optionalDisplayText(entry?.model, 160),
      provider: optionalDisplayText(entry?.provider, 160),
    }));
  }
  return threads;
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) throw new TypeError("Invalid messages");
  return value.map((entry, index) => Object.freeze({
    id: optionalText(entry?.id, 1_024) || `message-${index}`,
    turnId: optionalText(entry?.turnId, MAX_THREAD_ID),
    role: entry?.role === "user" ? "user" : entry?.role === "agent" ? "agent" : invalid("message.role"),
    text: optionalDisplayText(entry?.text, MAX_MESSAGE_TEXT),
    attachments: Object.freeze(normalizeAttachments(entry?.attachments)),
    createdAt: finiteTimestamp(entry?.createdAt ?? 0),
    streaming: entry?.streaming === true,
  }));
}

function normalizeAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new TypeError("Invalid attachments");
  return value.map((entry) => Object.freeze({
    kind: entry?.kind === "image" ? "image" : "file",
    name: boundedDisplayText(entry?.name || (entry?.kind === "image" ? "图片" : "文件"), 300),
  }));
}

function normalizeConversation(value) {
  const source = value && typeof value === "object" ? value : {};
  const status = new Set(["ready", "running", "waiting", "switching", "disconnected", "unavailable"])
    .has(source.status) ? source.status : "unavailable";
  return {
    status,
    label: boundedDisplayText(source.label || "对话不可用", 300),
    canSend: source.canSend === true,
    canInterrupt: source.canInterrupt === true,
    activeTurnId: optionalText(source.activeTurnId, MAX_THREAD_ID),
    mainComposerBlocked: source.mainComposerBlocked === true,
    imageIsolationEnabled: source.imageIsolationEnabled === true,
  };
}

function normalizeImageDelivery(value) {
  const source = value && typeof value === "object" ? value : {};
  const mode = new Set(["none", "full", "reference", "mixed"])
    .has(source.mode) ? source.mode : "none";
  return {
    mode,
    fullCount: boundedCount(source.fullCount),
    referenceCount: boundedCount(source.referenceCount),
    label: boundedDisplayText(source.label || "本回合没有发送图片", 500),
    updatedAt: finiteTimestamp(source.updatedAt ?? 0),
  };
}

function normalizeThreadStatus(value) {
  const status = typeof value === "string" ? value : value?.type;
  return new Set(["idle", "running", "waiting", "stopping", "failed", "notLoaded"])
    .has(status) ? status : "idle";
}

function bindingMatches(value, expected) {
  for (const field of ["hostWindowId", "editorInstanceId", "sessionId", "projectPath"]) {
    if (expected[field] && value[field] !== expected[field]) return false;
  }
  return true;
}

function boundedIdentifier(value, name) {
  const text = typeof value === "string" ? value : "";
  if (!IDENTIFIER.test(text)) throw new TypeError(`Invalid ${name}`);
  return text;
}

function optionalIdentifier(value) {
  if (value == null || value === "") return null;
  return boundedIdentifier(value, "identifier");
}

function boundedText(value, maximum, name) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > maximum || text.includes("\0")) throw new TypeError(`Invalid ${name}`);
  return text;
}

function optionalText(value, maximum) {
  if (value == null || value === "") return null;
  return boundedText(value, maximum, "text");
}

function boundedDisplayText(value, maximum) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .slice(0, maximum);
  if (!text) throw new TypeError("Invalid display text");
  return text;
}

function optionalDisplayText(value, maximum) {
  if (value == null || value === "") return "";
  return boundedDisplayText(value, maximum);
}

function boundedProjectPath(value) {
  const projectPath = boundedText(value, MAX_PROJECT_PATH, "projectPath");
  if (!projectPath.startsWith("/") || projectPath.includes("\0")) throw new TypeError("Invalid projectPath");
  return projectPath;
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError("Invalid timestamp");
  return timestamp;
}

function nonnegativeInteger(value, name) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`Invalid ${name}`);
  return number;
}

function boundedCount(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0 || number > 1_000) throw new TypeError("Invalid count");
  return number;
}

function generatedRequestId(now) {
  return `request-${Math.floor(Number(now) || Date.now())}-${Math.random().toString(16).slice(2, 14)}`;
}

function invalid(name) {
  throw new TypeError(`Invalid ${name}`);
}
