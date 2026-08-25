import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 60 * 60 * 1000;
const MAX_USERS = 10_000;
const MAX_LEASES = 10_000;
const MAX_ID_LENGTH = 512;
const MAP_VERSION_PATTERN = /^[a-f0-9]{64}$/u;

// The first slice deliberately exposes metadata and patch proposal only. No
// operation here grants image bytes, direct file writes, or conversation access.
export const MAP_AI_OPERATIONS = Object.freeze([
  "get_map_context",
  "propose_tiled_patch",
]);
const OPERATION_SET = new Set(MAP_AI_OPERATIONS);

export class MapAiAccessError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapAiAccessError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Persistent user opt-in and short-lived, context-bound map AI grants.
 *
 * Callers must pass every identity/context field on each check; a lease is
 * never a project-wide or user-wide capability. Stored lease tokens are
 * hashed at rest.
 */
export class MapAiAccessStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    randomBytes = (size) => crypto.randomBytes(size),
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  } = {}) {
    if (!stateDirectory || typeof stateDirectory !== "string") {
      throw new TypeError("stateDirectory is required");
    }
    this.filePath = path.join(path.resolve(stateDirectory), "map-ai-access.json");
    this.now = typeof now === "function" ? now : Date.now;
    this.randomBytes = typeof randomBytes === "function" ? randomBytes : crypto.randomBytes;
    this.defaultLeaseTtlMs = normalizeTtl(leaseTtlMs);
    this.enabledUsers = new Map();
    this.leases = new Map(); // token hash -> lease
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700);
    const loaded = await readState(this.filePath);
    this.enabledUsers = loaded.users;
    this.leases = loaded.leases;
    const pruned = this.pruneExpired();
    this.initialized = true;
    if (writeOnInitialize || loaded.normalized || pruned > 0) await this.write();
    return this;
  }

  snapshot({ userId = null } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    if (userId !== null) {
      const id = normalizeId(userId, "用户 ID");
      return { mapAiToolsEnabled: this.isEnabled(id) };
    }
    return {
      version: STORE_VERSION,
      enabledUsers: [...this.enabledUsers.entries()]
        .filter(([, enabled]) => enabled === true)
        .map(([id]) => id),
      activeLeases: this.leases.size,
    };
  }

  isEnabled(userId) {
    this.assertInitialized();
    return this.enabledUsers.get(normalizeId(userId, "用户 ID")) === true;
  }

  /**
   * Return only the operation names currently granted to one user. This is
   * intentionally the entire MCP catalog surface: no lease or map identity is
   * exposed, and callers must still resolve one exact live context per call.
   */
  authorizedOperationsForUser({ userId } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    if (!this.isEnabled(normalizedUserId)) return [];
    const granted = new Set();
    for (const lease of this.leases.values()) {
      if (lease.userId !== normalizedUserId) continue;
      for (const operation of lease.allowedOps) granted.add(operation);
    }
    return MAP_AI_OPERATIONS.filter((operation) => granted.has(operation));
  }

  async setEnabled({ userId, enabled } = {}) {
    this.assertInitialized();
    const id = normalizeId(userId, "用户 ID");
    if (typeof enabled !== "boolean") throw accessError(400, "MAP_AI_SETTING_INVALID", "地图 AI 工具开关必须是布尔值");
    return this.mutate(async () => {
      if (enabled && !this.enabledUsers.has(id) && this.enabledUsers.size >= MAX_USERS) {
        throw accessError(503, "MAP_AI_USER_LIMIT", "地图 AI 用户设置数量已达到上限");
      }
      this.enabledUsers.set(id, enabled);
      // Turning the user switch off immediately invalidates every outstanding
      // lease; it must never merely affect future leases.
      let revoked = 0;
      if (!enabled) {
        for (const [hash, lease] of this.leases) {
          if (lease.userId !== id) continue;
          this.leases.delete(hash);
          revoked += 1;
        }
      }
      await this.write();
      return { userId: id, mapAiToolsEnabled: enabled, revokedLeases: revoked };
    });
  }

  async grantLease(input = {}) {
    this.assertInitialized();
    const context = normalizeLeaseContext(input);
    const ttlMs = normalizeTtl(input.ttlMs ?? this.defaultLeaseTtlMs);
    return this.mutate(async () => {
      this.pruneExpired();
      if (!this.isEnabled(context.userId)) {
        throw accessError(403, "MAP_AI_TOOLS_DISABLED", "当前用户尚未启用地图 AI 工具");
      }
      if (this.leases.size >= MAX_LEASES) {
        throw accessError(503, "MAP_AI_LEASE_LIMIT", "地图 AI 临时授权数量已达到上限");
      }
      const leaseId = this.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(leaseId);
      const now = this.now();
      const lease = {
        ...context,
        tokenHash,
        grantedAt: now,
        expiresAt: now + ttlMs,
      };
      this.leases.set(tokenHash, lease);
      await this.write();
      return { leaseId, ...publicLease(lease) };
    });
  }

  requireLease({ leaseId, operation, ...context } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const token = normalizeToken(leaseId);
    const lease = this.leases.get(hashToken(token));
    if (!lease) throw accessError(404, "MAP_AI_LEASE_NOT_FOUND", "地图 AI 临时授权不存在或已过期");
    const normalized = normalizeLeaseContext(context, { requireOperations: false });
    if (!sameContext(lease, normalized)) {
      throw accessError(409, "MAP_AI_LEASE_CONTEXT_MISMATCH", "地图 AI 临时授权不属于当前对话、地图或编辑器窗口");
    }
    if (!this.isEnabled(normalized.userId)) {
      throw accessError(403, "MAP_AI_TOOLS_DISABLED", "当前用户已关闭地图 AI 工具");
    }
    const op = normalizeOperation(operation);
    if (!lease.allowedOps.includes(op)) {
      throw accessError(403, "MAP_AI_OPERATION_NOT_AUTHORIZED", `临时授权不包含操作 ${op}`);
    }
    return publicLease(lease);
  }

  /**
   * Resolve a bearer token for an internal adapter.  This method is never used
   * as a public response: callers must still run requireLease() with the live
   * request context and operation before doing any work.
   */
  contextForLease({ leaseId } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const token = normalizeToken(leaseId);
    const lease = this.leases.get(hashToken(token));
    if (!lease) throw accessError(404, "MAP_AI_LEASE_NOT_FOUND", "地图 AI 临时授权不存在或已过期");
    const { tokenHash: _tokenHash, ...context } = lease;
    return Object.freeze({ ...context, allowedOps: [...lease.allowedOps] });
  }

  /**
   * Resolve the one lease an MCP tool call explicitly names without putting
   * the bearer token in model-visible arguments.  The four public identifiers
   * intentionally do not include browserSessionId, projectPath or mapVersion;
   * those remain private fields recovered from the matching lease and must be
   * revalidated against the live map session by the host callback.
   *
   * Never choose the newest lease.  Zero and multiple matches both fail
   * closed so one conversation cannot drift to another map window.
   */
  resolveToolContext({
    userId,
    threadId,
    mapSessionId,
    editorInstanceId,
    editorStateId,
    operation,
  } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    const normalizedThreadId = normalizeId(threadId, "对话 ID");
    const normalizedMapSessionId = normalizeId(mapSessionId, "地图会话 ID");
    const normalizedEditorInstanceId = normalizeId(editorInstanceId, "地图编辑器窗口 ID");
    const normalizedEditorStateId = normalizeEditorStateId(editorStateId);
    const normalizedOperation = normalizeOperation(operation);
    if (!this.isEnabled(normalizedUserId)) {
      throw accessError(403, "MAP_AI_TOOLS_DISABLED", "当前用户尚未启用地图 AI 工具");
    }
    const matches = [];
    for (const lease of this.leases.values()) {
      if (
        lease.userId !== normalizedUserId
        || lease.threadId !== normalizedThreadId
        || lease.mapSessionId !== normalizedMapSessionId
        || lease.editorInstanceId !== normalizedEditorInstanceId
        || lease.editorStateId !== normalizedEditorStateId
        || !lease.allowedOps.includes(normalizedOperation)
      ) continue;
      const { tokenHash: _tokenHash, ...context } = lease;
      matches.push(Object.freeze({ ...context, allowedOps: [...lease.allowedOps] }));
    }
    if (matches.length === 0) {
      throw accessError(404, "MAP_AI_LEASE_NOT_FOUND", "没有与当前对话、地图和编辑器状态匹配的地图 AI 临时授权");
    }
    if (matches.length !== 1) {
      throw accessError(409, "MAP_AI_CONTEXT_SELECTION_REQUIRED", "存在多个匹配的地图 AI 临时授权，请在地图编辑器中重新授权");
    }
    return matches[0];
  }

  async revokeLease({ leaseId, userId = null } = {}) {
    this.assertInitialized();
    const token = normalizeToken(leaseId);
    const tokenHash = hashToken(token);
    return this.mutate(async () => {
      const lease = this.leases.get(tokenHash);
      if (!lease) return { revoked: false };
      if (userId !== null && lease.userId !== normalizeId(userId, "用户 ID")) {
        throw accessError(404, "MAP_AI_LEASE_NOT_FOUND", "地图 AI 临时授权不存在或已过期");
      }
      this.leases.delete(tokenHash);
      await this.write();
      return { revoked: true, lease: publicLease(lease) };
    });
  }

  async revokeForContext(context = {}) {
    this.assertInitialized();
    const normalized = normalizeLeaseContext(context, { requireOperations: false });
    return this.mutate(async () => {
      let revoked = 0;
      for (const [hash, lease] of this.leases) {
        if (sameContext(lease, normalized)) {
          this.leases.delete(hash);
          revoked += 1;
        }
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  async revokeForBrowserSession({ userId, browserSessionId } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    const normalizedBrowserSessionId = normalizeId(browserSessionId, "浏览器会话 ID");
    return this.mutate(async () => {
      let revoked = 0;
      for (const [hash, lease] of this.leases) {
        if (lease.userId !== normalizedUserId || lease.browserSessionId !== normalizedBrowserSessionId) continue;
        this.leases.delete(hash);
        revoked += 1;
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  async revokeForUser({ userId } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    return this.mutate(async () => {
      let revoked = 0;
      for (const [hash, lease] of this.leases) {
        if (lease.userId !== normalizedUserId) continue;
        this.leases.delete(hash);
        revoked += 1;
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  async revokeForMapSession({ userId, browserSessionId, mapSessionId } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    const normalizedBrowserSessionId = normalizeId(browserSessionId, "浏览器会话 ID");
    const normalizedMapSessionId = normalizeId(mapSessionId, "地图会话 ID");
    return this.mutate(async () => {
      let revoked = 0;
      for (const [hash, lease] of this.leases) {
        if (
          lease.userId !== normalizedUserId
          || lease.browserSessionId !== normalizedBrowserSessionId
          || lease.mapSessionId !== normalizedMapSessionId
        ) continue;
        this.leases.delete(hash);
        revoked += 1;
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  async revokeForThread({ userId, threadId } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    const normalizedThreadId = normalizeId(threadId, "对话 ID");
    return this.mutate(async () => {
      let revoked = 0;
      for (const [hash, lease] of this.leases) {
        if (lease.userId !== normalizedUserId || lease.threadId !== normalizedThreadId) continue;
        this.leases.delete(hash);
        revoked += 1;
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  async revokeForEditorWindow({ userId, browserSessionId, editorInstanceId } = {}) {
    this.assertInitialized();
    const normalizedUserId = normalizeId(userId, "用户 ID");
    const normalizedBrowserSessionId = normalizeId(browserSessionId, "浏览器会话 ID");
    const normalizedEditorInstanceId = normalizeId(editorInstanceId, "地图编辑器窗口 ID");
    return this.mutate(async () => {
      let revoked = 0;
      for (const [hash, lease] of this.leases) {
        if (
          lease.userId !== normalizedUserId
          || lease.browserSessionId !== normalizedBrowserSessionId
          || lease.editorInstanceId !== normalizedEditorInstanceId
        ) continue;
        this.leases.delete(hash);
        revoked += 1;
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  pruneExpired() {
    const now = this.now();
    let pruned = 0;
    for (const [hash, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(hash);
        pruned += 1;
      }
    }
    return pruned;
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const state = {
      version: STORE_VERSION,
      users: Object.fromEntries(this.enabledUsers),
      leases: [...this.leases.values()].map((lease) => ({ ...lease })),
    };
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Map AI access store is not initialized");
  }
}

function publicLease(lease) {
  return {
    userId: lease.userId,
    browserSessionId: lease.browserSessionId,
    threadId: lease.threadId,
    projectPath: lease.projectPath,
    mapSessionId: lease.mapSessionId,
    mapVersion: lease.mapVersion,
    editorInstanceId: lease.editorInstanceId,
    editorStateId: lease.editorStateId,
    allowedOps: [...lease.allowedOps],
    grantedAt: lease.grantedAt,
    expiresAt: lease.expiresAt,
  };
}

function normalizeLeaseContext(value = {}, { requireOperations = true } = {}) {
  const userId = normalizeId(value.userId, "用户 ID");
  const browserSessionId = normalizeId(value.browserSessionId, "浏览器会话 ID");
  const threadId = normalizeId(value.threadId, "对话 ID");
  const projectPath = normalizeProjectPath(value.projectPath);
  const mapSessionId = normalizeId(value.mapSessionId, "地图会话 ID");
  const mapVersion = String(value.mapVersion || "").toLowerCase();
  if (!MAP_VERSION_PATTERN.test(mapVersion)) throw accessError(400, "MAP_AI_CONTEXT_INVALID", "地图版本必须是 SHA-256");
  const editorInstanceId = normalizeId(value.editorInstanceId, "地图编辑器窗口 ID");
  const editorStateId = normalizeEditorStateId(value.editorStateId);
  const allowedOps = requireOperations ? normalizeOperations(value.allowedOps) : null;
  return Object.freeze({
    userId,
    browserSessionId,
    threadId,
    projectPath,
    mapSessionId,
    mapVersion,
    editorInstanceId,
    editorStateId,
    ...(allowedOps ? { allowedOps } : {}),
  });
}

function normalizeOperations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAP_AI_OPERATIONS.length) {
    throw accessError(400, "MAP_AI_OPERATIONS_INVALID", "地图 AI 授权操作清单无效");
  }
  const operations = [...new Set(value.map(normalizeOperation))];
  if (operations.length !== value.length) throw accessError(400, "MAP_AI_OPERATIONS_INVALID", "地图 AI 授权操作不能重复");
  return Object.freeze(operations.sort());
}

function normalizeOperation(value) {
  const operation = String(value || "").trim();
  if (!OPERATION_SET.has(operation)) throw accessError(400, "MAP_AI_OPERATION_INVALID", `不支持地图 AI 操作 ${operation || "(empty)"}`);
  return operation;
}

function normalizeId(value, label) {
  const id = String(value || "").trim();
  if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw accessError(400, "MAP_AI_CONTEXT_INVALID", `${label}无效`);
  }
  return id;
}

function normalizeProjectPath(value) {
  const projectPath = String(value || "");
  if (!projectPath || projectPath.length > 4_096 || !path.isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw accessError(400, "MAP_AI_CONTEXT_INVALID", "工程路径必须是绝对路径");
  }
  return path.resolve(projectPath);
}

function normalizeToken(value) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(token)) throw accessError(400, "MAP_AI_LEASE_INVALID", "地图 AI 临时授权标识无效");
  return token;
}

function normalizeEditorStateId(value) {
  const stateId = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (!Number.isSafeInteger(stateId) || stateId < 0) {
    throw accessError(400, "MAP_AI_CONTEXT_INVALID", "地图编辑状态标识无效");
  }
  return stateId;
}

function normalizeTtl(value) {
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) {
    throw accessError(400, "MAP_AI_LEASE_TTL_INVALID", "地图 AI 临时授权有效期超出允许范围");
  }
  return ttl;
}

function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

function sameContext(left, right) {
  return left.userId === right.userId
    && left.browserSessionId === right.browserSessionId
    && left.threadId === right.threadId
    && left.projectPath === right.projectPath
    && left.mapSessionId === right.mapSessionId
    && left.mapVersion === right.mapVersion
    && left.editorInstanceId === right.editorInstanceId
    && left.editorStateId === right.editorStateId;
}

async function readState(filePath) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (
      !raw
      || raw.version !== STORE_VERSION
      || !raw.users
      || typeof raw.users !== "object"
      || Array.isArray(raw.users)
      || !Array.isArray(raw.leases)
    ) return emptyState(true);
    let normalized = false;
    const users = new Map();
    for (const [userId, enabled] of Object.entries(raw.users)) {
      try { users.set(normalizeId(userId, "用户 ID"), enabled === true); } catch { normalized = true; /* drop malformed records */ }
    }
    const leases = new Map();
    if (raw.leases.length > MAX_LEASES) normalized = true;
    for (const value of raw.leases.slice(0, MAX_LEASES)) {
      try {
        const context = normalizeLeaseContext(value);
        const tokenHash = String(value.tokenHash || "");
        const grantedAt = Number(value.grantedAt);
        const expiresAt = Number(value.expiresAt);
        if (!/^[a-f0-9]{64}$/u.test(tokenHash) || !Number.isSafeInteger(grantedAt) || grantedAt <= 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= grantedAt) {
          normalized = true;
          continue;
        }
        leases.set(tokenHash, { ...context, tokenHash, grantedAt, expiresAt });
      } catch { normalized = true; /* drop malformed records */ }
    }
    return { users, leases, normalized };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return emptyState(true);
    throw error;
  }
}

function emptyState(normalized) { return { users: new Map(), leases: new Map(), normalized }; }

function accessError(statusCode, code, message) { return new MapAiAccessError(statusCode, code, message); }

export const MAP_AI_ACCESS_DEFAULTS = Object.freeze({
  enabled: false,
  leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  minLeaseTtlMs: MIN_LEASE_TTL_MS,
  maxLeaseTtlMs: MAX_LEASE_TTL_MS,
});
