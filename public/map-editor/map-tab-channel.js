export const MAP_EDITOR_TAB_SIGNAL_TYPE = "wfl/map-editor-tab/v1";

const ACTIONS = new Set([
  "state",
  "closed",
  "focus-request",
  "close-request",
  "open-request",
  "workspace-request",
  "snapshot",
  "close-command",
]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;

export function createMapEditorTabSignal(action, input = {}) {
  if (!ACTIONS.has(action)) throw new TypeError("Invalid map editor tab action");
  const value = {
    type: MAP_EDITOR_TAB_SIGNAL_TYPE,
    action,
    hostWindowId: boundedIdentifier(input.hostWindowId, "hostWindowId"),
    sentAt: finiteTimestamp(input.sentAt),
  };
  if (action === "snapshot") {
    value.tabs = Object.freeze(normalizeTabs(input.tabs));
    return Object.freeze(value);
  }
  if (["focus-request", "close-request", "close-command"].includes(action)) {
    value.editorInstanceId = boundedIdentifier(input.editorInstanceId, "editorInstanceId");
    value.targetEditorInstanceId = boundedIdentifier(input.targetEditorInstanceId, "targetEditorInstanceId");
    return Object.freeze(value);
  }
  if (action === "open-request") {
    value.editorInstanceId = boundedIdentifier(input.editorInstanceId, "editorInstanceId");
    value.sessionId = boundedText(input.sessionId, 256, "sessionId");
    value.projectPath = boundedProjectPath(input.projectPath);
    value.relativePath = boundedRelativeMapPath(input.relativePath);
    value.dirty = input.dirty === true;
    value.focused = input.focused === true;
    value.projectSessionId = input.projectSessionId == null
      ? null
      : boundedProjectSessionId(input.projectSessionId);
    value.targetRelativePath = boundedRelativeMapPath(input.targetRelativePath);
    return Object.freeze(value);
  }
  value.editorInstanceId = boundedIdentifier(input.editorInstanceId, "editorInstanceId");
  value.sessionId = boundedText(input.sessionId, 256, "sessionId");
  value.projectPath = boundedProjectPath(input.projectPath);
  value.relativePath = boundedRelativeMapPath(input.relativePath);
  value.dirty = input.dirty === true;
  value.focused = input.focused === true;
  return Object.freeze(value);
}

export function parseMapEditorTabSignal(value, { hostWindowId } = {}) {
  if (!value || value.type !== MAP_EDITOR_TAB_SIGNAL_TYPE || !ACTIONS.has(value.action)) return null;
  try {
    const parsed = createMapEditorTabSignal(value.action, value);
    if (hostWindowId && parsed.hostWindowId !== hostWindowId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeTabs(value) {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError("Invalid map editor tab snapshot");
  return value.map((tab) => Object.freeze({
    editorInstanceId: boundedIdentifier(tab?.editorInstanceId, "editorInstanceId"),
    projectPath: boundedProjectPath(tab?.projectPath),
    relativePath: boundedRelativeMapPath(tab?.relativePath),
    dirty: tab?.dirty === true,
    active: tab?.active === true,
  }));
}

function boundedIdentifier(value, name) {
  const text = typeof value === "string" ? value : "";
  if (!IDENTIFIER.test(text)) throw new TypeError(`Invalid ${name}`);
  return text;
}

function boundedText(value, maximum, name) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > maximum || text.includes("\0")) throw new TypeError(`Invalid ${name}`);
  return text;
}

function boundedProjectPath(value) {
  const projectPath = boundedText(value, 4096, "projectPath");
  if (!projectPath.startsWith("/")) throw new TypeError("Invalid projectPath");
  return projectPath;
}

function boundedRelativeMapPath(value) {
  const relativePath = boundedText(value, 4096, "relativePath");
  if (relativePath.startsWith("/") || relativePath.includes("\\") || !relativePath.toLowerCase().endsWith(".tmj")) {
    throw new TypeError("Invalid relativePath");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new TypeError("Invalid relativePath");
  }
  return segments.join("/");
}

function boundedProjectSessionId(value) {
  const sessionId = boundedText(value, 128, "projectSessionId");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(sessionId)) throw new TypeError("Invalid projectSessionId");
  return sessionId;
}

function finiteTimestamp(value) {
  const timestamp = value === undefined ? Date.now() : Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError("Invalid sentAt");
  return timestamp;
}
