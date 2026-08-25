import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertProtectedTargetsUnchanged,
  findProtectedOperationViolations,
  normalizeProtectedTarget,
} from "./map-ai-protected-targets.mjs";

/**
 * User/project/map collaboration policy.
 *
 * This state deliberately lives beside the map, not inside Tiled JSON.  It is
 * a collaboration contract for WFL only and is never consumed by a game
 * runtime.  A policy is immutable for a task after it is snapshotted; a new
 * policy revision therefore affects only newly-created tasks/saves.
 */
export const MAP_COLLABORATION_POLICY_SCHEMA = "wfl.map-collaboration-policy.v1";
export const MAP_COLLABORATION_POLICY_STORE_VERSION = 1;
export const MAP_COLLABORATION_OWNERSHIPS = Object.freeze(["human", "ai", "shared", "locked"]);
const OWNERSHIP_SET = new Set(MAP_COLLABORATION_OWNERSHIPS);
const MAX_POLICIES = 10_000;
const MAX_TARGETS = 256;
const MAX_ID = 512;
const MAX_PATH = 4_096;
const SHA256 = /^[a-f0-9]{64}$/iu;

export class MapCollaborationPolicyError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapCollaborationPolicyError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeCollaborationPolicyInput(value = {}, { requireIdentity = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyError(400, "MAP_COLLABORATION_POLICY_INVALID", "协同策略必须是对象");
  }
  const userId = requireIdentity ? boundedText(value.userId, "userId") : optionalText(value.userId);
  const projectPath = normalizeAbsolutePath(value.projectPath, "projectPath");
  const projectFingerprint = SHA256.test(String(value.projectFingerprint || ""))
    ? String(value.projectFingerprint).toLowerCase()
    : sha256(projectPath);
  const mapPath = normalizeRelativePath(value.mapPath, "mapPath");
  const mapVersion = value.mapVersion == null || value.mapVersion === ""
    ? null
    : normalizeHash(value.mapVersion, "mapVersion");
  const revision = boundedInteger(value.revision, 0, 0, Number.MAX_SAFE_INTEGER, "revision");
  const targets = normalizePolicyTargets(value.targets ?? [
    ...(Array.isArray(value.humanOwned) ? value.humanOwned.map((target) => ({ ...target, ownership: "human" })) : []),
    ...(Array.isArray(value.aiOwned) ? value.aiOwned.map((target) => ({ ...target, ownership: "ai" })) : []),
    ...(Array.isArray(value.shared) ? value.shared.map((target) => ({ ...target, ownership: "shared" })) : []),
    ...(Array.isArray(value.locked) ? value.locked.map((target) => ({ ...target, ownership: "locked" })) : []),
    ...(Array.isArray(value.protectedFiles) ? value.protectedFiles.map((target) => ({
      ...(typeof target === "string" ? { kind: "file", path: target } : target),
      ownership: "locked",
    })) : []),
  ]);
  const policy = {
    schema: MAP_COLLABORATION_POLICY_SCHEMA,
    ...(userId ? { userId } : {}),
    projectPath,
    projectFingerprint,
    mapPath,
    ...(mapVersion ? { mapVersion } : {}),
    revision,
    targets,
  };
  return Object.freeze(policy);
}

export function normalizeCollaborationTarget(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyError(400, "MAP_COLLABORATION_TARGET_INVALID", `targets[${index}] 必须是对象`);
  }
  const ownership = String(value.ownership || "").trim().toLowerCase();
  if (!OWNERSHIP_SET.has(ownership)) {
    throw policyError(400, "MAP_COLLABORATION_TARGET_INVALID", `targets[${index}].ownership 无效`);
  }
  const base = normalizeProtectedTarget({
    ...value,
    ...(value.kind === "file" && value.path == null ? { path: value.mapPath } : {}),
  }, index);
  return Object.freeze({ ...base, ownership });
}

export function normalizePolicyTargets(value) {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) {
    throw policyError(400, "MAP_COLLABORATION_TARGET_INVALID", "协同目标数量无效");
  }
  const unique = new Map();
  for (const [index, entry] of value.entries()) {
    const target = normalizeCollaborationTarget(entry, index);
    unique.set(stableJson(target), target);
  }
  return Object.freeze([...unique.values()]);
}

/** Return the server-enforced AI deny-list from one policy snapshot. */
export function collaborationPolicyProtectedTargets(policy, mapPath) {
  const normalized = normalizeCollaborationPolicyInput(policy);
  const current = normalizePathForCompare(mapPath);
  return Object.freeze(normalized.targets
    .filter((target) => target.ownership === "human" || target.ownership === "locked")
    .filter((target) => !target.mapPath || normalizePathForCompare(target.mapPath) === current)
    .map(({ ownership: _ownership, ...target }) => target));
}

/**
 * Validate one AI patch against a policy.  Human/locked/protected targets are
 * hard denies.  AI/shared targets remain explicit metadata: shared regions
 * use the normal risk/approval rules, while AI-owned regions are available as
 * the default writable area for future scoped planners.
 */
export function findCollaborationOperationViolations(document, patch, policy, mapPath) {
  const normalized = normalizeCollaborationPolicyInput(policy);
  return findProtectedOperationViolations(
    document,
    patch,
    collaborationPolicyProtectedTargets(normalized, mapPath),
    mapPath,
  ).map((entry) => ({
    ...entry,
    code: entry.target?.kind === "file" ? "MAP_COLLABORATION_PROTECTED_FILE" : "MAP_COLLABORATION_HUMAN_OWNED",
  }));
}

export function assertCollaborationPolicyUnchanged(before, after, policy, mapPath) {
  const protectedTargets = collaborationPolicyProtectedTargets(policy, mapPath);
  return assertProtectedTargetsUnchanged(before, after, protectedTargets, mapPath);
}

export function collaborationPolicySnapshot(policy) {
  const normalized = normalizeCollaborationPolicyInput(policy);
  return Object.freeze({
    schema: normalized.schema,
    projectPath: normalized.projectPath,
    projectFingerprint: normalized.projectFingerprint,
    mapPath: normalized.mapPath,
    ...(normalized.mapVersion ? { mapVersion: normalized.mapVersion } : {}),
    revision: normalized.revision,
    targets: normalized.targets.map((target) => ({ ...target })),
    humanOwned: normalized.targets.filter((target) => target.ownership === "human").map(stripOwnership),
    aiOwned: normalized.targets.filter((target) => target.ownership === "ai").map(stripOwnership),
    shared: normalized.targets.filter((target) => target.ownership === "shared").map(stripOwnership),
    locked: normalized.targets.filter((target) => target.ownership === "locked").map(stripOwnership),
    protectedFiles: normalized.targets
      .filter((target) => target.ownership === "locked" && target.kind === "file")
      .map((target) => target.path),
  });
}

export function publicCollaborationPolicy(policy) {
  const { projectPath: _projectPath, ...snapshot } = collaborationPolicySnapshot(policy);
  return snapshot;
}

export class MapCollaborationPolicyStore {
  constructor(stateDirectory, options = {}) {
    if (!stateDirectory || typeof stateDirectory !== "string") throw new TypeError("stateDirectory is required");
    this.filePath = path.join(path.resolve(stateDirectory), "map-collaboration-policies.json");
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
    this.maxPolicies = boundedInteger(options.maxPolicies, MAX_POLICIES, 1, 100_000, "maxPolicies");
    this.policies = new Map();
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700);
    const loaded = await readState(this.filePath, this.maxPolicies);
    this.policies = loaded.policies;
    this.initialized = true;
    if (writeOnInitialize && (loaded.normalized || !await fileExists(this.filePath))) await this.write();
    return this;
  }

  get(input = {}) {
    this.assertInitialized();
    const key = policyKey(input);
    const policy = this.policies.get(key);
    return policy ? publicPolicy(policy) : publicPolicy(emptyPolicy(input));
  }

  async set(input = {}) {
    this.assertInitialized();
    const expectedRevision = boundedInteger(input.expectedRevision, 0, 0, Number.MAX_SAFE_INTEGER, "expectedRevision");
    const requested = normalizeCollaborationPolicyInput({
      ...input,
      revision: 0,
    }, { requireIdentity: true });
    const key = policyKey(requested);
    return this.mutate(async () => {
      const current = this.policies.get(key) || emptyPolicy(requested);
      if (current.revision !== expectedRevision) {
        throw policyError(409, "MAP_COLLABORATION_POLICY_CONFLICT", "协同策略已经变化，请重新读取后保存");
      }
      const next = {
        ...requested,
        revision: current.revision + 1,
        updatedAt: this.now(),
        createdAt: current.createdAt || this.now(),
      };
      this.policies.set(key, next);
      this.evict();
      await this.write();
      return publicPolicy(next);
    });
  }

  snapshot(input = {}) {
    this.assertInitialized();
    return this.get(input);
  }

  /** Internal snapshot used by authorization/task creation; never send this
   * object directly to a browser because it contains the absolute project
   * path. */
  contract(input = {}) {
    this.assertInitialized();
    const key = policyKey(input);
    const policy = this.policies.get(key) || emptyPolicy(input);
    return collaborationPolicySnapshot(policy);
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.${this.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      version: MAP_COLLABORATION_POLICY_STORE_VERSION,
      policies: [...this.policies.values()].map(storedPolicy),
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  evict() {
    while (this.policies.size > this.maxPolicies) {
      const oldest = [...this.policies.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))[0];
      if (!oldest) break;
      this.policies.delete(policyKey(oldest));
    }
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Map collaboration policy store is not initialized");
  }
}

function emptyPolicy(input) {
  const normalized = normalizeCollaborationPolicyInput({ ...input, revision: 0 });
  return {
    ...normalized,
    createdAt: null,
    updatedAt: null,
    humanOwned: [],
    aiOwned: [],
    shared: [],
    locked: [],
    protectedFiles: [],
  };
}

function publicPolicy(policy) {
  const snapshot = publicCollaborationPolicy(policy);
  return {
    ...snapshot,
    ...(policy.userId ? { userId: policy.userId } : {}),
    createdAt: policy.createdAt || null,
    updatedAt: policy.updatedAt || null,
  };
}

function storedPolicy(policy) {
  return {
    ...collaborationPolicySnapshot(policy),
    userId: policy.userId,
    projectPath: policy.projectPath,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function policyKey(value) {
  const normalized = normalizeCollaborationPolicyInput(value);
  return `${String(value.userId || normalized.userId || "")}\0${normalized.projectFingerprint}\0${normalized.mapPath}`;
}

async function readState(filePath, maxPolicies) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!raw || raw.version !== MAP_COLLABORATION_POLICY_STORE_VERSION || !Array.isArray(raw.policies)) {
      return { policies: new Map(), normalized: true };
    }
    const policies = new Map();
    let normalized = raw.policies.length > maxPolicies;
    for (const value of raw.policies.slice(-maxPolicies)) {
      try {
        const policy = normalizeCollaborationPolicyInput(value, { requireIdentity: true });
        const restored = {
          ...policy,
          projectPath: normalizeAbsolutePath(value.projectPath || "", "projectPath"),
          createdAt: positiveTimestamp(value.createdAt),
          updatedAt: positiveTimestamp(value.updatedAt),
        };
        if (restored.updatedAt < restored.createdAt) throw new Error("invalid timestamps");
        policies.set(policyKey(restored), restored);
      } catch {
        normalized = true;
      }
    }
    return { policies, normalized };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { policies: new Map(), normalized: true };
    throw error;
  }
}

function normalizeAbsolutePath(value, label) {
  const text = boundedText(value, label);
  if (!path.isAbsolute(text) || text.includes("\0")) throw policyError(400, "MAP_COLLABORATION_POLICY_INVALID", `${label}必须是绝对路径`);
  return path.resolve(text);
}

function normalizeRelativePath(value, label) {
  const text = boundedText(value, label).replaceAll("\\", "/");
  const normalized = path.posix.normalize(text);
  if (text.startsWith("/") || /^[a-z]:\//iu.test(text) || text.split("/").includes("..") || normalized === "." || normalized.startsWith("../")) {
    throw policyError(400, "MAP_COLLABORATION_POLICY_INVALID", `${label}必须是工程相对路径`);
  }
  return normalized;
}

function normalizeHash(value, label) {
  const text = String(value || "").toLowerCase();
  if (!SHA256.test(text)) throw policyError(400, "MAP_COLLABORATION_POLICY_INVALID", `${label}必须是 SHA-256`);
  return text;
}

function boundedText(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > (label === "projectPath" || label === "mapPath" ? MAX_PATH : MAX_ID) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw policyError(400, "MAP_COLLABORATION_POLICY_INVALID", `${label}无效`);
  }
  return value;
}

function optionalText(value) { return value == null || value === "" ? null : boundedText(value, "userId"); }
function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw policyError(400, "MAP_COLLABORATION_POLICY_INVALID", `${label}无效`);
  return number;
}
function positiveTimestamp(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid timestamp");
  return number;
}
function stripOwnership(target) { const { ownership: _ownership, ...rest } = target; return rest; }
function stableJson(value) { return JSON.stringify(value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry); }
function normalizePathForCompare(value) { return String(value || "").replaceAll("\\", "/").replace(/^\.\//u, ""); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function policyError(statusCode, code, message) { return new MapCollaborationPolicyError(statusCode, code, message); }
function fileExists(filePath) { return fs.access(filePath).then(() => true, () => false); }
