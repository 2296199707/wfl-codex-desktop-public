import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAP_CONVERSATION_BINDING_STORE_VERSION = 1;

const DEFAULT_MAX_BINDINGS = 10_000;
const MAX_USER_ID = 256;
const MAX_THREAD_ID = 1_024;
const MAX_PROJECT_PATH = 4_096;

/**
 * Persistent one-to-one map between an account's project and its editing
 * conversation.  Conversation contents stay in Codex; this store only keeps
 * the routing decision needed by map editor windows.
 */
export class MapConversationBindingStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    randomBytes = (size) => crypto.randomBytes(size),
    maxBindings = DEFAULT_MAX_BINDINGS,
  } = {}) {
    if (!stateDirectory || typeof stateDirectory !== "string") {
      throw new TypeError("stateDirectory is required");
    }
    this.filePath = path.join(path.resolve(stateDirectory), "map-conversation-bindings.json");
    this.now = typeof now === "function" ? now : Date.now;
    this.randomBytes = typeof randomBytes === "function" ? randomBytes : crypto.randomBytes;
    this.maxBindings = positiveInteger(maxBindings, DEFAULT_MAX_BINDINGS, "maxBindings");
    this.bindings = new Map();
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700);
    const loaded = await readState(this.filePath, this.maxBindings);
    this.bindings = loaded.bindings;
    this.initialized = true;
    if (writeOnInitialize && (loaded.normalized || !await fileExists(this.filePath))) {
      await this.write();
    }
    return this;
  }

  get({ userId, projectPath } = {}) {
    this.assertInitialized();
    const key = bindingKey(userId, projectPath);
    const binding = this.bindings.get(key);
    return binding ? publicBinding(binding) : null;
  }

  async set({ userId, projectPath, threadId = null, expectedRevision = 0 } = {}) {
    this.assertInitialized();
    const normalized = normalizeBinding({ userId, projectPath, threadId });
    const expected = normalizeRevision(expectedRevision);
    return this.mutate(async () => {
      const previousBindings = new Map(this.bindings);
      const key = bindingKey(normalized.userId, normalized.projectPath);
      const current = this.bindings.get(key) || null;
      const currentRevision = current?.revision || 0;
      if (currentRevision !== expected) {
        throw bindingError(409, "MAP_CONVERSATION_BINDING_CONFLICT", "工程绑定已经变化，请刷新后重试");
      }
      assertThreadAvailableForProject(this.bindings, normalized);
      const timestamp = this.now();
      const next = {
        ...normalized,
        revision: currentRevision + 1,
        createdAt: current?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      this.bindings.set(key, next);
      this.evict();
      try {
        await this.write();
        return publicBinding(next);
      } catch (error) {
        this.bindings = previousBindings;
        throw error;
      }
    });
  }

  /** Move a binding after the server materializes or replaces a Thread. */
  async replaceThread({ userId, previousThreadId, nextThreadId, projectPath = null } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeUserId(userId);
    const previous = normalizeThreadId(previousThreadId);
    const next = normalizeThreadId(nextThreadId);
    const normalizedProjectPath = projectPath == null || projectPath === ""
      ? null
      : normalizeProjectPath(projectPath);
    return this.mutate(async () => {
      const previousBindings = new Map(this.bindings);
      const matches = [...this.bindings.values()].filter((binding) => (
        binding.userId === normalizedUserId
        && binding.threadId === previous
        && (!normalizedProjectPath || binding.projectPath === normalizedProjectPath)
      ));
      if (!matches.length) return [];
      for (const binding of matches) {
        assertThreadAvailableForProject(this.bindings, {
          userId: normalizedUserId,
          projectPath: binding.projectPath,
          threadId: next,
        });
      }
      const timestamp = this.now();
      const replaced = [];
      for (const binding of matches) {
        const updated = {
          ...binding,
          threadId: next,
          revision: binding.revision + 1,
          updatedAt: timestamp,
        };
        this.bindings.set(bindingKey(binding.userId, binding.projectPath), updated);
        replaced.push(publicBinding(updated));
      }
      try {
        await this.write();
        return replaced;
      } catch (error) {
        this.bindings = previousBindings;
        throw error;
      }
    });
  }

  /** Invalidate a deleted Thread without allowing stale clients to win. */
  async removeForThread({ userId, threadId } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeUserId(userId);
    const normalizedThreadId = normalizeThreadId(threadId);
    return this.mutate(async () => {
      const previousBindings = new Map(this.bindings);
      const matches = [...this.bindings.values()].filter((binding) => (
        binding.userId === normalizedUserId && binding.threadId === normalizedThreadId
      ));
      if (!matches.length) return [];
      const timestamp = this.now();
      const removed = [];
      for (const binding of matches) {
        const updated = {
          ...binding,
          threadId: null,
          revision: binding.revision + 1,
          updatedAt: timestamp,
        };
        this.bindings.set(bindingKey(binding.userId, binding.projectPath), updated);
        removed.push(publicBinding(updated));
      }
      try {
        await this.write();
        return removed;
      } catch (error) {
        this.bindings = previousBindings;
        throw error;
      }
    });
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.${this.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      version: MAP_CONVERSATION_BINDING_STORE_VERSION,
      bindings: [...this.bindings.values()].map(storedBinding),
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  evict() {
    while (this.bindings.size > this.maxBindings) {
      const oldest = [...this.bindings.values()]
        .sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0))[0];
      if (!oldest) break;
      this.bindings.delete(bindingKey(oldest.userId, oldest.projectPath));
    }
  }

  mutate(operation) {
    this.assertInitialized();
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Map conversation binding store is not initialized");
  }
}

function assertThreadAvailableForProject(bindings, candidate) {
  if (!candidate.threadId) return;
  const conflict = [...bindings.values()].find((binding) => (
    binding.userId === candidate.userId
    && binding.threadId === candidate.threadId
    && binding.projectPath !== candidate.projectPath
  ));
  if (conflict) {
    throw bindingError(409, "MAP_CONVERSATION_THREAD_ALREADY_BOUND", "这个对话已经绑定到另一个工程");
  }
}

function normalizeBinding({ userId, projectPath, threadId = null } = {}) {
  return {
    userId: normalizeUserId(userId),
    projectPath: normalizeProjectPath(projectPath),
    threadId: threadId == null || threadId === "" ? null : normalizeThreadId(threadId),
  };
}

function normalizeUserId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_USER_ID || /[\0\r\n]/.test(text)) {
    throw bindingError(400, "MAP_CONVERSATION_BINDING_INVALID", "用户 ID 无效");
  }
  return text;
}

function normalizeProjectPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_PROJECT_PATH || !path.isAbsolute(text) || text.includes("\0")) {
    throw bindingError(400, "MAP_CONVERSATION_BINDING_INVALID", "工程路径无效");
  }
  return path.resolve(text);
}

function normalizeThreadId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_THREAD_ID || /[\0\r\n]/.test(text)) {
    throw bindingError(400, "MAP_CONVERSATION_BINDING_INVALID", "对话 ID 无效");
  }
  return text;
}

function normalizeRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw bindingError(400, "MAP_CONVERSATION_BINDING_INVALID", "工程绑定修订号无效");
  }
  return revision;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function bindingKey(userId, projectPath) {
  return `${normalizeUserId(userId)}\0${normalizeProjectPath(projectPath)}`;
}

function publicBinding(binding) {
  return {
    projectPath: binding.projectPath,
    threadId: binding.threadId,
    revision: binding.revision,
    updatedAt: binding.updatedAt,
  };
}

function storedBinding(binding) {
  return {
    userId: binding.userId,
    projectPath: binding.projectPath,
    threadId: binding.threadId,
    revision: binding.revision,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function bindingError(statusCode, code, message) {
  const error = new Error(message);
  error.name = "MapConversationBindingError";
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function readState(filePath, maxBindings) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!raw || raw.version !== MAP_CONVERSATION_BINDING_STORE_VERSION || !Array.isArray(raw.bindings)) {
      return { bindings: new Map(), normalized: true };
    }
    const bindings = new Map();
    let normalized = raw.bindings.length > maxBindings;
    for (const value of raw.bindings.slice(-maxBindings)) {
      try {
        const binding = normalizeBinding(value);
        const revision = normalizeRevision(value.revision);
        const createdAt = normalizeTimestamp(value.createdAt);
        const updatedAt = normalizeTimestamp(value.updatedAt);
        if (!createdAt || !updatedAt || updatedAt < createdAt || revision < 1) throw new Error("invalid binding metadata");
        const restored = { ...binding, revision, createdAt, updatedAt };
        bindings.set(bindingKey(restored.userId, restored.projectPath), restored);
      } catch {
        normalized = true;
      }
    }
    return { bindings, normalized };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { bindings: new Map(), normalized: true };
    }
    throw error;
  }
}
