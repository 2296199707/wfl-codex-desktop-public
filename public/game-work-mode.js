export const GAME_WORK_MODE_CHANNEL_PREFIX = "wfl-game-work-mode-v1";
export const GAME_WORK_MODE_SIGNAL_TYPE = "wfl/game-work-mode/v1";
export const GAME_WORK_MODE_ACK_TYPE = "wfl/game-work-mode-ack/v1";
export const GAME_WORK_MODE_COMMAND_TYPE = "wfl/game-work-mode-command/v1";
export const GAME_WORK_MODE_HEARTBEAT_MS = 10_000;
export const GAME_WORK_MODE_LEASE_MS = 90_000;

const WINDOW_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_THREAD_ID_LENGTH = 1_024;
const MAX_PROJECT_PATH_LENGTH = 2_048;
const ACTIONS = new Set(["enable", "heartbeat", "disable"]);
const COMMAND_ACTIONS = new Set(["enable", "disable"]);

export function gameWorkModeChannelName(hostWindowId) {
  const host = boundedId(hostWindowId, WINDOW_ID);
  if (!host) throw new TypeError("Invalid game work mode host window");
  return `${GAME_WORK_MODE_CHANNEL_PREFIX}:${host}`;
}

export function createGameWorkModeSignal(input, now = Date.now()) {
  const action = ACTIONS.has(input?.action) ? input.action : null;
  const hostWindowId = boundedId(input?.hostWindowId, WINDOW_ID);
  const editorInstanceId = boundedId(input?.editorInstanceId, WINDOW_ID);
  const sessionId = boundedText(input?.sessionId, MAX_SESSION_ID_LENGTH);
  const threadId = boundedText(input?.threadId, MAX_THREAD_ID_LENGTH);
  const projectPath = boundedProjectPath(input?.projectPath);
  if (!action || !hostWindowId || !editorInstanceId || !sessionId || !threadId || !projectPath) {
    throw new TypeError("Incomplete game work mode binding");
  }
  const sentAt = finiteTimestamp(now);
  return Object.freeze({
    type: GAME_WORK_MODE_SIGNAL_TYPE,
    action,
    hostWindowId,
    editorInstanceId,
    sessionId,
    threadId,
    projectPath,
    sentAt,
    expiresAt: action === "disable" ? sentAt : sentAt + GAME_WORK_MODE_LEASE_MS,
  });
}

export function createGameWorkModeCommand(input, now = Date.now()) {
  const action = COMMAND_ACTIONS.has(input?.action) ? input.action : null;
  const hostWindowId = boundedId(input?.hostWindowId, WINDOW_ID);
  const editorInstanceId = boundedId(input?.editorInstanceId, WINDOW_ID);
  const sessionId = boundedText(input?.sessionId, MAX_SESSION_ID_LENGTH);
  const threadId = boundedText(input?.threadId, MAX_THREAD_ID_LENGTH);
  const projectPath = boundedProjectPath(input?.projectPath);
  if (!action || !hostWindowId || !editorInstanceId || !sessionId || !threadId || !projectPath) {
    throw new TypeError("Incomplete game work mode command");
  }
  return Object.freeze({
    type: GAME_WORK_MODE_COMMAND_TYPE,
    action,
    hostWindowId,
    editorInstanceId,
    sessionId,
    threadId,
    projectPath,
    sentAt: finiteTimestamp(now),
  });
}

export function parseGameWorkModeCommand(value, expected = {}) {
  if (value?.type !== GAME_WORK_MODE_COMMAND_TYPE) return null;
  try {
    const command = createGameWorkModeCommand(value, value.sentAt);
    for (const field of ["hostWindowId", "editorInstanceId", "sessionId", "threadId", "projectPath"]) {
      if (expected[field] && command[field] !== expected[field]) return null;
    }
    return command;
  } catch {
    return null;
  }
}

export function acceptGameWorkModeSignal(leases, value, {
  hostWindowId,
  now = Date.now(),
} = {}) {
  if (!(leases instanceof Map) || value?.type !== GAME_WORK_MODE_SIGNAL_TYPE) {
    return Object.freeze({ accepted: false, changed: false });
  }
  const expectedHost = boundedId(hostWindowId, WINDOW_ID);
  const action = ACTIONS.has(value.action) ? value.action : null;
  const signalHost = boundedId(value.hostWindowId, WINDOW_ID);
  const editorInstanceId = boundedId(value.editorInstanceId, WINDOW_ID);
  const sessionId = boundedText(value.sessionId, MAX_SESSION_ID_LENGTH);
  const threadId = boundedText(value.threadId, MAX_THREAD_ID_LENGTH);
  const projectPath = boundedProjectPath(value.projectPath);
  if (!expectedHost || signalHost !== expectedHost || !action || !editorInstanceId
    || !sessionId || !threadId || !projectPath) {
    return Object.freeze({ accepted: false, changed: false });
  }

  const key = leaseKey(sessionId, editorInstanceId);
  const previous = leases.get(key) || null;
  if (action === "disable") {
    const matches = Boolean(previous
      && previous.hostWindowId === signalHost
      && previous.threadId === threadId
      && previous.projectPath === projectPath);
    if (matches) leases.delete(key);
    return Object.freeze({ accepted: true, changed: matches, action, key });
  }

  const receivedAt = finiteTimestamp(now);
  const lease = Object.freeze({
    hostWindowId: signalHost,
    editorInstanceId,
    sessionId,
    threadId,
    projectPath,
    receivedAt,
    expiresAt: receivedAt + GAME_WORK_MODE_LEASE_MS,
  });
  const changed = !previous
    || previous.hostWindowId !== lease.hostWindowId
    || previous.threadId !== lease.threadId
    || previous.projectPath !== lease.projectPath;
  leases.set(key, lease);
  return Object.freeze({ accepted: true, changed, action, key, lease });
}

export function pruneGameWorkModeLeases(leases, now = Date.now()) {
  if (!(leases instanceof Map)) return 0;
  const timestamp = finiteTimestamp(now);
  let removed = 0;
  for (const [key, lease] of leases) {
    if (Number(lease?.expiresAt) > timestamp) continue;
    leases.delete(key);
    removed += 1;
  }
  return removed;
}

export function gameWorkModeIsolationEnabled(leases, {
  hostWindowId,
  runtime,
  threadId,
  projectPath,
  now = Date.now(),
} = {}) {
  pruneGameWorkModeLeases(leases, now);
  if (!(leases instanceof Map) || runtime !== "codex") return false;
  const host = boundedId(hostWindowId, WINDOW_ID);
  const thread = boundedText(threadId, MAX_THREAD_ID_LENGTH);
  const project = boundedProjectPath(projectPath);
  if (!host || !thread || !project) return false;
  for (const lease of leases.values()) {
    if (lease.hostWindowId === host
      && lease.threadId === thread
      && lease.projectPath === project
      && Number(lease.expiresAt) > Number(now)) return true;
  }
  return false;
}

function leaseKey(sessionId, editorInstanceId) {
  return `${sessionId}\u001f${editorInstanceId}`;
}

function boundedId(value, pattern) {
  const text = typeof value === "string" ? value : "";
  return pattern.test(text) ? text : null;
}

function boundedText(value, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) return null;
  return value;
}

function boundedProjectPath(value) {
  const projectPath = boundedText(value, MAX_PROJECT_PATH_LENGTH);
  return projectPath?.startsWith("/") ? projectPath : null;
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}
