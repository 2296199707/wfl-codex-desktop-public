import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAP_AI_RISK_RULE_VERSION } from "./map-ai-risk.mjs";
import { normalizeProtectedTargets } from "./map-ai-protected-targets.mjs";
import {
  collaborationPolicyProtectedTargets,
  publicCollaborationPolicy,
  collaborationPolicySnapshot,
  normalizeCollaborationPolicyInput,
} from "./map-collaboration-policy-store.mjs";

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AUTHORIZATIONS = 10_000;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_MAPS = 128;
const MAX_FILES = 512;
const MAX_OPS = 64;
const MAX_BUDGET_BYTES = 64 * 1024;
const MAX_AUDIT_EVENTS = 128;
const SHA256 = /^[a-f0-9]{64}$/iu;
const AUTHORITY_MODE = "managed";

export const MAP_AI_MANAGED_AUTHORIZATION_STORE_VERSION = STORE_VERSION;
export const MAP_AI_MANAGED_AUTHORITY_MODE = AUTHORITY_MODE;
export const MAP_AI_MANAGED_OPERATIONS = Object.freeze([
  "inspect_project",
  "get_project_context",
  "read_project_resource",
  "propose_project_patch",
  "apply_project_patch",
  "get_map_context",
  "read_map_region",
  "propose_tiled_patch",
  "apply_tiled_patch",
  "propose_tiled_resource_patch",
  "apply_tiled_resource_patch",
  "validate_map",
  "request_map_preview",
  "list_map_revisions",
  "restore_map_revision",
]);

const OPERATION_SET = new Set(MAP_AI_MANAGED_OPERATIONS);
const PROJECT_ONLY_OPERATIONS = new Set([
  "inspect_project",
  "get_project_context",
  "read_project_resource",
  "propose_project_patch",
  "apply_project_patch",
]);

export class MapAiManagedAuthorizationError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapAiManagedAuthorizationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Persistent authorization contracts for headless map-AI work.
 *
 * This is intentionally separate from MapAiAccessStore: an editor lease is
 * bound to an editorInstanceId and may not be upgraded into a headless write
 * grant. This store contains no bearer token and no file handle; callers must
 * still re-resolve the project/map and validate the current hash before every
 * operation.
 */
export class MapAiManagedAuthorizationStore {
  constructor(stateDirectory, options = {}) {
    if (!stateDirectory || typeof stateDirectory !== "string") throw new TypeError("stateDirectory is required");
    this.filePath = path.join(path.resolve(stateDirectory), "map-ai-managed-authorizations.json");
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
    this.defaultTtlMs = normalizeTtl(options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxAuthorizations = boundedInteger(options.maxAuthorizations, MAX_AUTHORIZATIONS, 1, 100_000, "maxAuthorizations");
    this.authorizations = new Map();
    this.operationKeys = new Map();
    this.writeQueue = Promise.resolve();
    this.mutationDepth = 0;
    this.expiryPersistScheduled = false;
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700);
    const loaded = await readState(this.filePath, { maxAuthorizations: this.maxAuthorizations });
    this.authorizations = loaded.authorizations;
    this.operationKeys = new Map();
    for (const authorization of this.authorizations.values()) this.operationKeys.set(authorization.operationKey, authorization.id);
    const pruned = this.pruneExpired();
    this.initialized = true;
    if (writeOnInitialize && (loaded.normalized || pruned > 0 || !await fileExists(this.filePath))) await this.write();
    return this;
  }

  snapshot({ authorizationId, identity } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    return publicAuthorization(this.requireAuthorizationRecord(authorizationId, identity));
  }

  /** Return a bounded, redacted audit view for the owner of one grant. */
  async audit({ authorizationId, identity } = {}) {
    this.assertInitialized();
    return this.mutate(async () => {
      const expired = this.pruneExpired();
      if (expired) await this.write();
      const entry = this.requireAuthorizationAuditRecord(authorizationId, identity);
      return publicAuthorizationAudit(entry);
    });
  }

  /** Internal-only contract lookup for the task creator/executor. */
  taskContract({ authorizationId, identity } = {}) {
    this.assertInitialized();
    const entry = this.requireAuthorization(authorizationId, identity);
    return Object.freeze({
      id: entry.id,
      identity: { ...entry.identity },
      scope: structuredClone(entry.scope),
      allowedOps: [...entry.allowedOps],
      protectedTargets: [...entry.protectedTargets],
      collaborationPolicy: entry.collaborationPolicy ? structuredClone(entry.collaborationPolicy) : null,
      budget: { ...entry.budget },
      approvalSnapshot: { ...entry.approvalSnapshot },
      expiresAt: entry.expiresAt,
    });
  }

  /**
   * Resolve a headless MCP call by user plus opaque authorization id. The
   * authorization id is intentionally required; unlike an editor lease this
   * path does not depend on a browser session remaining open. The returned
   * contract is still re-checked for expiry/revocation and never exposes the
   * project path to the caller.
   */
  toolContract({ authorizationId, userId } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const entry = this.requireAuthorizationForUser(authorizationId, userId);
    return Object.freeze({
      id: entry.id,
      identity: { ...entry.identity },
      scope: structuredClone(entry.scope),
      allowedOps: [...entry.allowedOps],
      protectedTargets: [...entry.protectedTargets],
      collaborationPolicy: entry.collaborationPolicy ? structuredClone(entry.collaborationPolicy) : null,
      budget: { ...entry.budget },
      approvalSnapshot: { ...entry.approvalSnapshot },
      expiresAt: entry.expiresAt,
    });
  }

  list({ identity, threadId = null, limit = 100 } = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const normalizedIdentity = normalizeIdentity(identity);
    const normalizedThread = threadId == null ? null : boundedText(threadId, "threadId", 1, MAX_ID_LENGTH);
    const size = boundedInteger(limit, 100, 1, 500, "limit");
    return [...this.authorizations.values()]
      .filter((entry) => sameIdentity(entry.identity, normalizedIdentity))
      .filter((entry) => normalizedThread === null || entry.scope.projectWide === true || entry.scope.threadId === normalizedThread)
      .sort((left, right) => right.createdAt - left.createdAt || compareText(right.id, left.id))
      .slice(0, size)
      .map(publicAuthorization);
  }

  authorizedOperationsForUser(userId) {
    this.assertInitialized();
    const normalizedUserId = boundedText(userId, "userId", 1, MAX_ID_LENGTH);
    this.pruneExpired();
    const operations = new Set();
    for (const entry of this.authorizations.values()) {
      if (entry.identity.userId !== normalizedUserId || entry.revokedAt !== null) continue;
      for (const operation of entry.allowedOps) operations.add(operation);
    }
    return [...operations].sort(compareText);
  }

  async create(input = {}) {
    this.assertInitialized();
    const normalized = normalizeCreateInput(input, this.now(), this.defaultTtlMs);
    return this.mutate(async () => {
      this.pruneExpired();
      const existingId = this.operationKeys.get(normalized.operationKey);
      if (existingId) {
        const existing = this.authorizations.get(existingId);
        if (existing && existing.requestHash === normalized.requestHash) {
          return { created: false, authorization: publicAuthorization(existing) };
        }
        throw authError(409, "MAP_AI_MANAGED_AUTH_OPERATION_CONFLICT", "托管授权幂等标识已用于不同范围或策略");
      }
      this.evictFinalCapacity();
      if (this.authorizations.size >= this.maxAuthorizations) {
        throw authError(429, "MAP_AI_MANAGED_AUTH_CAPACITY", "托管授权数量已达到上限");
      }
      const now = this.now();
      const authorization = {
        id: this.createId(),
        identity: normalized.identity,
        scope: normalized.scope,
        allowedOps: normalized.allowedOps,
        protectedTargets: normalized.protectedTargets,
        collaborationPolicy: normalized.collaborationPolicy,
        budget: normalized.budget,
        approvalSnapshot: normalized.approvalSnapshot,
        clientOperationId: normalized.clientOperationId,
        operationKey: normalized.operationKey,
        requestHash: normalized.requestHash,
        createdAt: now,
        updatedAt: now,
        expiresAt: normalized.expiresAt,
        revokedAt: null,
        revokedReason: null,
        audit: [{ at: now, type: "created", reason: null }],
      };
      this.authorizations.set(authorization.id, authorization);
      this.operationKeys.set(authorization.operationKey, authorization.id);
      await this.write();
      return { created: true, authorization: publicAuthorization(authorization) };
    });
  }

  /** Resolve exactly one headless grant; zero or multiple matches fail closed. */
  resolveForTool(input = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const identity = normalizeIdentity(input.identity);
    const scope = normalizeToolScope(input);
    const operation = normalizeOperation(input.operation);
    const matches = [...this.authorizations.values()].filter((entry) => (
      sameIdentity(entry.identity, identity)
      && sameToolScope(entry.scope, scope)
      && entry.allowedOps.includes(operation)
      && entry.revokedAt === null
    ));
    if (!matches.length) throw authError(404, "MAP_AI_MANAGED_AUTH_NOT_FOUND", "没有匹配当前对话、工程、地图和操作的托管授权");
    if (matches.length !== 1) throw authError(409, "MAP_AI_MANAGED_AUTH_SELECTION_REQUIRED", "存在多个匹配的托管授权，请明确选择后重试");
    return publicAuthorization(matches[0]);
  }

  async revoke({ authorizationId, identity, reason = "用户撤销托管授权" } = {}) {
    this.assertInitialized();
    const normalizedIdentity = normalizeIdentity(identity);
    const normalizedReason = boundedText(reason, "reason", 1, 2_000);
    return this.mutate(async () => {
      const authorization = this.requireAuthorizationRecord(authorizationId, normalizedIdentity);
      if (authorization.revokedAt !== null) return publicAuthorization(authorization);
      authorization.revokedAt = this.now();
      authorization.updatedAt = authorization.revokedAt;
      authorization.revokedReason = normalizedReason;
      appendAuthorizationAudit(authorization, "revoked", normalizedReason, authorization.revokedAt);
      await this.write();
      return publicAuthorization(authorization);
    });
  }

  /** Explicitly hand one grant to another Thread in the same project scope. */
  async transferThread({ authorizationId, identity, targetThreadId, expectedThreadId = null, reason = "用户显式转交托管授权" } = {}) {
    this.assertInitialized();
    const normalizedIdentity = normalizeIdentity(identity);
    const nextThreadId = boundedText(targetThreadId, "targetThreadId", 1, MAX_ID_LENGTH);
    const expected = expectedThreadId == null ? null : boundedText(expectedThreadId, "expectedThreadId", 1, MAX_ID_LENGTH);
    const normalizedReason = boundedText(reason, "reason", 1, 2_000);
    return this.mutate(async () => {
      const authorization = this.requireAuthorization(authorizationId, normalizedIdentity);
      if (expected !== null && authorization.scope.threadId !== expected) {
        throw authError(409, "MAP_AI_MANAGED_AUTH_TRANSFER_CONFLICT", "托管授权已被其他转交请求更新，请重新读取当前 Thread");
      }
      if (authorization.scope.threadId === nextThreadId) {
        throw authError(409, "MAP_AI_MANAGED_AUTH_TRANSFER_SAME_THREAD", "目标 Thread 与当前 Thread 相同");
      }
      const previousThreadId = authorization.scope.threadId;
      authorization.scope = Object.freeze({ ...authorization.scope, threadId: nextThreadId });
      authorization.updatedAt = this.now();
      appendAuthorizationAudit(
        authorization,
        "transferred",
        `${normalizedReason}：${previousThreadId} -> ${nextThreadId}`,
        authorization.updatedAt,
      );
      await this.write();
      return publicAuthorization(authorization);
    });
  }

  async revokeForBrowserSession({ userId, browserSessionId, reason = "浏览器会话已结束" } = {}) {
    const identity = normalizeIdentity({ userId, browserSessionId });
    return this.revokeMatching((entry) => sameIdentity(entry.identity, identity), reason);
  }

  async revokeForUser({ userId, reason = "用户访问已撤销" } = {}) {
    const normalizedUserId = boundedText(userId, "userId", 1, MAX_ID_LENGTH);
    return this.revokeMatching((entry) => entry.identity.userId === normalizedUserId, reason);
  }

  async revokeForThread({ userId, threadId, reason = "对话已切换或删除" } = {}) {
    const normalizedUserId = boundedText(userId, "userId", 1, MAX_ID_LENGTH);
    const normalizedThreadId = boundedText(threadId, "threadId", 1, MAX_ID_LENGTH);
    return this.revokeMatching((entry) => entry.identity.userId === normalizedUserId
      && !entry.scope.projectWide
      && entry.scope.threadId === normalizedThreadId, reason);
  }

  pruneExpired() {
    const now = this.now();
    let count = 0;
    for (const [id, entry] of this.authorizations) {
      if (entry.expiresAt <= now) {
        // Keep a bounded expired record for owner-visible audit and task
        // history.  It is no longer resolvable for tools, but deleting it
        // made expiry indistinguishable from a missing grant.
        if (entry.revokedAt === null) {
          entry.revokedAt = entry.expiresAt;
          entry.updatedAt = Math.max(entry.updatedAt, entry.expiresAt);
          entry.revokedReason = "托管授权已过期";
          appendAuthorizationAudit(entry, "expired", entry.revokedReason, entry.expiresAt);
          count += 1;
        }
        if (this.operationKeys.get(entry.operationKey) === id) this.operationKeys.delete(entry.operationKey);
      }
    }
    if (count && this.mutationDepth === 0) this.scheduleExpiryPersistence();
    return count;
  }

  scheduleExpiryPersistence() {
    if (this.expiryPersistScheduled || !this.initialized) return;
    this.expiryPersistScheduled = true;
    const operation = this.writeQueue.then(() => this.write(), () => this.write());
    this.writeQueue = operation.catch(() => {});
    void operation.finally(() => { this.expiryPersistScheduled = false; });
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.${this.randomBytes(6).toString("hex")}.tmp`;
    const state = {
      version: STORE_VERSION,
      authorizations: [...this.authorizations.values()].map(storedAuthorization),
    };
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async revokeMatching(predicate, reason) {
    this.assertInitialized();
    const normalizedReason = boundedText(reason, "reason", 1, 2_000);
    return this.mutate(async () => {
      const now = this.now();
      let revoked = 0;
      for (const entry of this.authorizations.values()) {
        if (entry.revokedAt !== null || !predicate(entry)) continue;
        entry.revokedAt = now;
        entry.updatedAt = now;
        entry.revokedReason = normalizedReason;
        appendAuthorizationAudit(entry, "revoked", normalizedReason, now);
        revoked += 1;
      }
      if (revoked) await this.write();
      return { revoked };
    });
  }

  requireAuthorization(authorizationId, identity) {
    const entry = this.requireAuthorizationRecord(authorizationId, identity);
    if (entry.revokedAt !== null) {
      throw authError(404, "MAP_AI_MANAGED_AUTH_NOT_FOUND", "托管授权不存在或已过期");
    }
    return entry;
  }

  requireAuthorizationRecord(authorizationId, identity) {
    const id = boundedText(authorizationId, "authorizationId", 1, MAX_ID_LENGTH);
    const normalizedIdentity = normalizeIdentity(identity);
    const entry = this.authorizations.get(id);
    if (!entry || !sameIdentity(entry.identity, normalizedIdentity) || entry.expiresAt <= this.now()) {
      throw authError(404, "MAP_AI_MANAGED_AUTH_NOT_FOUND", "托管授权不存在或已过期");
    }
    return entry;
  }

  requireAuthorizationAuditRecord(authorizationId, identity) {
    const id = boundedText(authorizationId, "authorizationId", 1, MAX_ID_LENGTH);
    const normalizedIdentity = normalizeIdentity(identity);
    const entry = this.authorizations.get(id);
    if (!entry || !sameIdentity(entry.identity, normalizedIdentity)) {
      throw authError(404, "MAP_AI_MANAGED_AUTH_NOT_FOUND", "托管授权不存在或已过期");
    }
    return entry;
  }

  requireAuthorizationForUser(authorizationId, userId) {
    const id = boundedText(authorizationId, "authorizationId", 1, MAX_ID_LENGTH);
    const normalizedUserId = boundedText(userId, "userId", 1, MAX_ID_LENGTH);
    const entry = this.authorizations.get(id);
    if (!entry || entry.identity.userId !== normalizedUserId || entry.expiresAt <= this.now() || entry.revokedAt !== null) {
      throw authError(404, "MAP_AI_MANAGED_AUTH_NOT_FOUND", "托管授权不存在、已撤销或已过期");
    }
    return entry;
  }

  createId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.randomBytes(24).toString("base64url");
      if (!this.authorizations.has(id)) return id;
    }
    throw authError(503, "MAP_AI_MANAGED_AUTH_ID_UNAVAILABLE", "无法创建托管授权标识");
  }

  evictFinalCapacity() {
    while (this.authorizations.size >= this.maxAuthorizations) {
      const candidate = [...this.authorizations.values()]
        .filter((entry) => entry.revokedAt !== null)
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!candidate) return;
      this.authorizations.delete(candidate.id);
      if (this.operationKeys.get(candidate.operationKey) === candidate.id) this.operationKeys.delete(candidate.operationKey);
    }
  }

  mutate(operation) {
    const run = async () => {
      this.mutationDepth += 1;
      try {
        return await operation();
      } finally {
        this.mutationDepth -= 1;
      }
    };
    const task = this.writeQueue.then(run, run);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Map AI managed authorization store is not initialized");
  }
}

function normalizeCreateInput(input, now, defaultTtlMs) {
  const identity = normalizeIdentity(input.identity);
  const scope = normalizeScope(input.scope);
  const allowedOps = normalizeOperations(input.allowedOps);
  if (!scope.projectWide && allowedOps.some((operation) => PROJECT_ONLY_OPERATIONS.has(operation))) {
    throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", "工程级托管操作必须使用整个工程授权");
  }
  const collaborationPolicy = input.collaborationPolicy == null
    ? null
    : collaborationPolicySnapshot(normalizeCollaborationPolicyInput(input.collaborationPolicy));
  const explicitProtectedTargets = normalizeProtectedTargets(input.protectedTargets ?? []);
  const policyProtectedTargets = collaborationPolicy
    ? collaborationPolicyProtectedTargets(collaborationPolicy, collaborationPolicy.mapPath)
    : [];
  const protectedTargets = normalizeProtectedTargets([...explicitProtectedTargets, ...policyProtectedTargets]);
  const budget = normalizeBudget(input.budget);
  const approvalSnapshot = normalizeApprovalSnapshot(input.approvalSnapshot);
  const clientOperationId = boundedText(input.clientOperationId, "clientOperationId", 1, MAX_ID_LENGTH);
  const ttlMs = normalizeTtl(input.ttlMs ?? defaultTtlMs);
  const expiresAt = Math.min(Number(input.expiresAt || now + ttlMs), now + ttlMs);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw authError(409, "MAP_AI_MANAGED_AUTH_EXPIRED", "托管授权已过期");
  const operationKey = `${identity.userId}\0${identity.browserSessionId}\0${clientOperationId}`;
  const requestHash = sha256(JSON.stringify({ scope, allowedOps, protectedTargets, collaborationPolicy, budget, approvalSnapshot }));
  return { identity, scope, allowedOps, protectedTargets, collaborationPolicy, budget, approvalSnapshot, clientOperationId, operationKey, requestHash, expiresAt };
}

function normalizeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", "托管授权范围无效");
  if (value.authorityMode !== AUTHORITY_MODE) throw authError(403, "MAP_AI_MANAGED_SCOPE_INVALID", "托管授权必须使用 managed authorityMode");
  const projectPath = normalizeAbsolutePath(value.projectPath, "projectPath");
  const projectWide = value.projectWide === true || value.scopeKind === "project";
  const scopeKind = projectWide ? "project" : "map";
  const threadId = projectWide ? null : boundedText(value.threadId, "threadId", 1, MAX_ID_LENGTH);
  if (projectWide) {
    return Object.freeze({
      authorityMode: AUTHORITY_MODE,
      scopeKind,
      projectWide: true,
      threadId: null,
      projectPath,
      projectFingerprint: sha256(projectPath),
      mapPaths: Object.freeze([]),
      mapVersions: Object.freeze({}),
      targetFiles: Object.freeze([]),
      targetFileVersions: Object.freeze({}),
    });
  }
  const mapPaths = normalizeRelativePaths(value.mapPaths ?? [value.mapPath], "mapPaths", MAX_MAPS);
  if (!mapPaths.length) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", "托管授权至少需要一张地图");
  const mapVersions = {};
  for (const mapPath of mapPaths) {
    const valueHash = value.mapVersions?.[mapPath];
    if (!SHA256.test(String(valueHash || "").toLowerCase())) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", `缺少地图 ${mapPath} 的基础版本`);
    mapVersions[mapPath] = String(valueHash).toLowerCase();
  }
    const projectFingerprint = sha256(projectPath);
  const sortedMapPaths = [...new Set(mapPaths)].sort();
  const sortedMapVersions = Object.fromEntries(sortedMapPaths.map((mapPath) => [mapPath, mapVersions[mapPath]]));
  const targetFiles = normalizeRelativePaths(value.targetFiles ?? sortedMapPaths, "targetFiles", MAX_FILES);
  if (!targetFiles.length) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", "托管授权至少需要一个目标资源");
  const targetFileVersions = normalizeResourceVersionMap(
    value.targetFileVersions ?? Object.fromEntries(targetFiles.map((target) => [target, mapVersions[target] ?? null])),
    targetFiles,
  );
  return Object.freeze({
    authorityMode: AUTHORITY_MODE,
    scopeKind,
    projectWide: false,
    threadId,
    projectPath,
    projectFingerprint,
    mapPaths: Object.freeze(sortedMapPaths),
    mapVersions: Object.freeze(sortedMapVersions),
    targetFiles: Object.freeze([...new Set(targetFiles)].sort()),
    targetFileVersions: Object.freeze({ ...targetFileVersions }),
  });
}

function normalizeToolScope(value) {
  if (value?.projectWide === true || value?.scopeKind === "project" || value?.mapPath == null) {
    return normalizeScope({
      authorityMode: AUTHORITY_MODE,
      scopeKind: "project",
      projectWide: true,
      projectPath: value.projectPath,
    });
  }
  const scope = normalizeScope({
    authorityMode: AUTHORITY_MODE,
    projectPath: value.projectPath,
    threadId: value.threadId,
    mapPaths: [value.mapPath],
    mapVersions: { [value.mapPath]: value.mapVersion },
  });
  return scope;
}

function sameToolScope(left, right) {
  if (left.projectWide || right.projectWide) {
    return left.projectWide === right.projectWide
      && left.projectFingerprint === right.projectFingerprint;
  }
  return left.threadId === right.threadId
    && left.projectFingerprint === right.projectFingerprint
    && left.mapPaths.length === 1
    && right.mapPaths.length === 1
    && left.mapPaths[0] === right.mapPaths[0]
    && left.mapVersions[left.mapPaths[0]] === right.mapVersions[right.mapPaths[0]];
}

function normalizeApprovalSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || value.userConfirmed !== true) {
    throw authError(400, "MAP_AI_MANAGED_APPROVAL_INVALID", "托管授权必须包含已确认的批准策略快照");
  }
  if (!["ask_each", "ai_review", "full_authorization"].includes(value.policy)) {
    throw authError(400, "MAP_AI_MANAGED_APPROVAL_INVALID", "地图批准策略无效");
  }
  return Object.freeze({
    version: 1,
    policy: value.policy,
    source: boundedText(value.source || "map_selection", "approval.source", 1, 100),
    riskRuleVersion: boundedText(value.riskRuleVersion || MAP_AI_RISK_RULE_VERSION, "approval.riskRuleVersion", 1, 100),
    userConfirmed: true,
  });
}

function normalizeBudget(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw authError(400, "MAP_AI_MANAGED_BUDGET_INVALID", "托管任务预算无效");
  return Object.freeze({
    maxBatches: boundedInteger(value.maxBatches, 100, 1, 10_000, "budget.maxBatches"),
    maxOperations: boundedInteger(value.maxOperations, 100_000, 1, 10_000_000, "budget.maxOperations"),
    maxTileCells: boundedInteger(value.maxTileCells, 10_000_000, 1, 100_000_000, "budget.maxTileCells"),
    maxObjectOperations: boundedInteger(value.maxObjectOperations, 1_000_000, 1, 10_000_000, "budget.maxObjectOperations"),
  });
}

function normalizeOperations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OPS) throw authError(400, "MAP_AI_MANAGED_OPS_INVALID", "托管操作清单无效");
  const result = [...new Set(value.map(normalizeOperation))];
  if (result.length !== value.length) throw authError(400, "MAP_AI_MANAGED_OPS_INVALID", "托管操作清单不能重复");
  return Object.freeze(result.sort());
}

function normalizeOperation(value) {
  const operation = boundedText(value, "operation", 1, 100);
  if (!OPERATION_SET.has(operation)) throw authError(400, "MAP_AI_MANAGED_OPERATION_INVALID", `不支持托管操作 ${operation}`);
  return operation;
}

function normalizeRelativePaths(value, label, max) {
  if (!Array.isArray(value) || value.length > max) throw authError(400, "MAP_AI_MANAGED_PATHS_INVALID", `${label}无效`);
  return value.filter((entry) => entry !== null && entry !== undefined && entry !== "").map((entry) => normalizeRelativePath(entry, label));
}

function normalizeResourceVersionMap(value, paths) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", "targetFileVersions 无效");
  const output = {};
  for (const resourcePath of paths) {
    if (value[resourcePath] === null) {
      output[resourcePath] = null;
      continue;
    }
    const hash = String(value[resourcePath] || "").toLowerCase();
    if (!SHA256.test(hash)) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", `缺少资源 ${resourcePath} 的基础版本`);
    output[resourcePath] = hash;
  }
  return output;
}

function normalizeRelativePath(value, label) {
  const text = boundedText(value, label, 1, MAX_PATH_LENGTH).replaceAll("\\", "/");
  const normalized = path.posix.normalize(text);
  if (text.startsWith("/") || /^[a-z]:\//iu.test(text) || text.split("/").includes("..") || normalized === "." || normalized.startsWith("../")) {
    throw authError(400, "MAP_AI_MANAGED_PATHS_INVALID", `${label}必须是工程相对路径`);
  }
  return normalized;
}

function normalizeAbsolutePath(value, label) {
  const text = boundedText(value, label, 1, MAX_PATH_LENGTH);
  if (!path.isAbsolute(text) || text.includes("\0")) throw authError(400, "MAP_AI_MANAGED_SCOPE_INVALID", `${label}必须是绝对路径`);
  return path.resolve(text);
}

function normalizeIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw authError(400, "MAP_AI_MANAGED_IDENTITY_INVALID", "托管授权身份无效");
  return Object.freeze({
    userId: boundedText(value.userId, "userId", 1, MAX_ID_LENGTH),
    browserSessionId: boundedText(value.browserSessionId, "browserSessionId", 1, MAX_ID_LENGTH),
  });
}

function sameIdentity(left, right) { return left.userId === right.userId && left.browserSessionId === right.browserSessionId; }

function publicAuthorization(entry) {
  return {
    id: entry.id,
    authorityMode: AUTHORITY_MODE,
    scopeKind: entry.scope.scopeKind || (entry.scope.projectWide ? "project" : "map"),
    projectWide: entry.scope.projectWide === true,
    threadId: entry.scope.threadId,
    projectFingerprint: entry.scope.projectFingerprint,
    mapPaths: [...entry.scope.mapPaths],
    mapVersions: { ...entry.scope.mapVersions },
    targetFiles: [...(entry.scope.targetFiles || entry.scope.mapPaths)],
    targetFileVersions: { ...(entry.scope.targetFileVersions || entry.scope.mapVersions) },
    allowedOps: [...entry.allowedOps],
    protectedTargets: [...entry.protectedTargets],
    collaborationPolicy: entry.collaborationPolicy ? publicCollaborationPolicy(entry.collaborationPolicy) : null,
    budget: { ...entry.budget },
    approvalPolicy: entry.approvalSnapshot.policy,
    riskRuleVersion: entry.approvalSnapshot.riskRuleVersion,
    clientOperationId: entry.clientOperationId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    revokedAt: entry.revokedAt,
    revokedReason: entry.revokedReason,
  };
}

function publicAuthorizationAudit(entry) {
  const authorization = publicAuthorization(entry);
  return {
    authorization,
    audit: Array.isArray(entry.audit)
      ? entry.audit.slice(-MAX_AUDIT_EVENTS).map((event) => ({
        at: event.at,
        type: event.type,
        ...(event.reason ? { reason: event.reason } : {}),
      }))
      : [],
  };
}

function appendAuthorizationAudit(entry, type, reason, at) {
  const audit = Array.isArray(entry.audit) ? entry.audit : [];
  audit.push({ at, type, ...(reason ? { reason: String(reason).slice(0, 2_000) } : {}) });
  entry.audit = audit.slice(-MAX_AUDIT_EVENTS);
}

function storedAuthorization(entry) {
  return {
    id: entry.id,
    identity: entry.identity,
    scope: entry.scope,
    allowedOps: entry.allowedOps,
    protectedTargets: entry.protectedTargets,
    collaborationPolicy: entry.collaborationPolicy,
    budget: entry.budget,
    approvalSnapshot: entry.approvalSnapshot,
    clientOperationId: entry.clientOperationId,
    operationKey: entry.operationKey,
    requestHash: entry.requestHash,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    revokedAt: entry.revokedAt,
    revokedReason: entry.revokedReason,
    audit: Array.isArray(entry.audit) ? entry.audit.slice(-MAX_AUDIT_EVENTS) : [],
  };
}

async function readState(filePath, { maxAuthorizations }) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.authorizations)) return { authorizations: new Map(), normalized: true };
    const authorizations = new Map();
    let normalized = raw.authorizations.length > maxAuthorizations;
    for (const value of raw.authorizations.slice(-maxAuthorizations)) {
      try {
        const entry = restoreAuthorization(value);
        if (authorizations.has(entry.id)) normalized = true;
        authorizations.set(entry.id, entry);
      } catch { normalized = true; }
    }
    return { authorizations, normalized };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { authorizations: new Map(), normalized: true };
    throw error;
  }
}

function restoreAuthorization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid authorization");
  const normalized = normalizeCreateInput({
    identity: value.identity,
    scope: value.scope,
    allowedOps: value.allowedOps,
    protectedTargets: value.protectedTargets,
    collaborationPolicy: value.collaborationPolicy,
    budget: value.budget,
    approvalSnapshot: value.approvalSnapshot,
    clientOperationId: value.clientOperationId,
    expiresAt: value.expiresAt,
    ttlMs: Math.max(MIN_TTL_MS, Number(value.expiresAt) - Number(value.createdAt)),
  }, Number(value.createdAt), DEFAULT_TTL_MS);
  const id = boundedText(value.id, "authorizationId", 1, MAX_ID_LENGTH);
  const createdAt = boundedTimestamp(value.createdAt, "createdAt");
  const updatedAt = boundedTimestamp(value.updatedAt, "updatedAt");
  const expiresAt = boundedTimestamp(value.expiresAt, "expiresAt");
  if (updatedAt < createdAt || expiresAt <= createdAt) throw new Error("invalid authorization timestamps");
  const revokedAt = value.revokedAt == null ? null : boundedTimestamp(value.revokedAt, "revokedAt");
  const revokedReason = value.revokedReason == null ? null : boundedText(value.revokedReason, "revokedReason", 1, 2_000);
  const audit = restoreAuthorizationAudit(value.audit, createdAt, updatedAt, revokedAt, revokedReason);
  return {
    id,
    identity: normalized.identity,
    scope: normalized.scope,
    allowedOps: normalized.allowedOps,
    protectedTargets: normalized.protectedTargets,
    collaborationPolicy: normalized.collaborationPolicy,
    budget: normalized.budget,
    approvalSnapshot: normalized.approvalSnapshot,
    clientOperationId: normalized.clientOperationId,
    operationKey: normalized.operationKey,
    requestHash: normalized.requestHash,
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt,
    revokedReason,
    audit,
  };
}

function restoreAuthorizationAudit(value, createdAt, updatedAt, revokedAt, revokedReason) {
  const events = Array.isArray(value) ? value : [{ at: createdAt, type: "created" }];
  const normalized = [];
  for (const event of events.slice(-MAX_AUDIT_EVENTS)) {
    if (!event || typeof event !== "object") continue;
    const at = Number(event.at);
    const type = String(event.type || "");
    if (!Number.isSafeInteger(at) || at < createdAt || at > updatedAt || !["created", "transferred", "revoked", "expired"].includes(type)) continue;
    normalized.push({ at, type, ...(event.reason ? { reason: String(event.reason).slice(0, 2_000) } : {}) });
  }
  if (!normalized.some((event) => event.type === "created")) normalized.unshift({ at: createdAt, type: "created" });
  if (revokedAt) {
    const type = revokedReason === "托管授权已过期" ? "expired" : "revoked";
    if (!normalized.some((event) => event.type === type)) normalized.push({ at: revokedAt, type, ...(revokedReason ? { reason: revokedReason } : {}) });
  }
  return normalized.slice(-MAX_AUDIT_EVENTS);
}

function normalizeTtl(value) {
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) throw authError(400, "MAP_AI_MANAGED_TTL_INVALID", "托管授权有效期无效");
  return ttl;
}

function boundedText(value, label, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw authError(400, "MAP_AI_MANAGED_ARGUMENT_INVALID", `${label}无效`);
  return value;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw authError(400, "MAP_AI_MANAGED_ARGUMENT_INVALID", `${label}无效`);
  return number;
}

function boundedTimestamp(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw authError(400, "MAP_AI_MANAGED_ARGUMENT_INVALID", `${label}无效`);
  return number;
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function authError(statusCode, code, message) { return new MapAiManagedAuthorizationError(statusCode, code, message); }
function fileExists(filePath) { return fs.access(filePath).then(() => true, () => false); }
