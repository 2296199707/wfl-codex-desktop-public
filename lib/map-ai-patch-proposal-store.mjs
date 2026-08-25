import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseTiledAiPatch,
  tiledAiPatchContext,
} from "../public/map-editor/tiled-ai-patch.js";
import { assessMapAiTask } from "./map-ai-risk.mjs";

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PROPOSALS = 1_000;
const DEFAULT_MAX_PROPOSALS_PER_CONTEXT = 100;
const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_ID_LENGTH = 512;
const MAX_LIST_LIMIT = 500;
const STATUS = new Set(["pending", "applied", "discarded"]);

export class MapAiPatchProposalError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapAiPatchProposalError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * A persistent proposal inbox. It validates and stores structured Tiled patch
 * proposals, but deliberately has no map-file handle and no method that writes
 * or saves a .tmj document.
 */
export class MapAiPatchProposalStore {
  constructor(stateDirectory, options = {}) {
    if (!stateDirectory || typeof stateDirectory !== "string") throw new TypeError("stateDirectory is required");
    this.filePath = path.join(path.resolve(stateDirectory), "map-ai-patch-proposals.json");
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === "function"
      ? options.randomBytes
      : (size) => crypto.randomBytes(size);
    this.ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, "ttlMs");
    this.maxProposals = boundedInteger(options.maxProposals, DEFAULT_MAX_PROPOSALS, 1, 100_000, "maxProposals");
    this.maxProposalsPerContext = boundedInteger(
      options.maxProposalsPerContext,
      DEFAULT_MAX_PROPOSALS_PER_CONTEXT,
      1,
      this.maxProposals,
      "maxProposalsPerContext",
    );
    this.maxPatchBytes = boundedInteger(
      options.maxPatchBytes,
      DEFAULT_MAX_PATCH_BYTES,
      1_024,
      16 * 1024 * 1024,
      "maxPatchBytes",
    );
    this.proposals = new Map();
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700);
    const loaded = await readState(this.filePath, {
      maxProposals: this.maxProposals,
      maxPatchBytes: this.maxPatchBytes,
    });
    this.proposals = loaded.proposals;
    this.initialized = true;
    const pruned = this.pruneExpired();
    if (writeOnInitialize || loaded.normalized || pruned > 0) await this.write();
    return this;
  }

  async create(input = {}) {
    this.assertInitialized();
    const context = normalizeContext(input);
    const patch = normalizePatchInput(input, context, this.maxPatchBytes);
    return this.mutate(async () => {
      this.pruneExpired();
      if (this.proposals.size >= this.maxProposals) {
        throw proposalError(503, "MAP_AI_PROPOSAL_LIMIT", "地图 AI 补丁提案数量已达到上限");
      }
      const contextCount = [...this.proposals.values()].filter((entry) => sameContext(entry, context)).length;
      if (contextCount >= this.maxProposalsPerContext) {
        throw proposalError(429, "MAP_AI_CONTEXT_PROPOSAL_LIMIT", "当前地图窗口的补丁提案数量已达到上限");
      }
      const now = this.now();
      const proposal = {
        id: this.createProposalId(),
        ...context,
        patch: patch.value,
        patchBytes: patch.bytes,
        risk: riskAssessmentForPatch(patch.value, context.mapPath),
        status: "pending",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.ttlMs,
        appliedAt: null,
        discardedAt: null,
      };
      this.proposals.set(proposal.id, proposal);
      await this.write();
      return publicProposal(proposal);
    });
  }

  get(input = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const context = normalizeContext(input);
    const proposal = this.requireProposal(input.proposalId, context);
    return publicProposal(proposal);
  }

  list(input = {}) {
    this.assertInitialized();
    this.pruneExpired();
    const context = normalizeContext(input);
    const limit = boundedInteger(input.limit, 100, 1, MAX_LIST_LIMIT, "limit");
    const includeFinal = input.includeFinal === true;
    return [...this.proposals.values()]
      .filter((proposal) => sameContext(proposal, context))
      .filter((proposal) => includeFinal || proposal.status === "pending")
      .sort((left, right) => right.createdAt - left.createdAt || compareText(right.id, left.id))
      .slice(0, limit)
      .map(publicProposal);
  }

  async discard(input = {}) {
    this.assertInitialized();
    const context = normalizeContext(input);
    const proposalId = normalizeProposalId(input.proposalId);
    return this.mutate(async () => {
      this.pruneExpired();
      const proposal = this.requireProposal(proposalId, context);
      if (proposal.status === "applied") {
        throw proposalError(409, "MAP_AI_PROPOSAL_ALREADY_APPLIED", "已应用的地图补丁提案不能丢弃");
      }
      if (proposal.status === "discarded") return publicProposal(proposal);
      const now = this.now();
      proposal.status = "discarded";
      proposal.discardedAt = now;
      proposal.updatedAt = now;
      // A discarded proposal no longer needs to retain its patch body. Keep a
      // bounded tombstone for idempotence and audit without retaining content.
      proposal.patch = null;
      proposal.patchBytes = 0;
      await this.write();
      return publicProposal(proposal);
    });
  }

  async markApplied(input = {}) {
    this.assertInitialized();
    const context = normalizeContext(input);
    const proposalId = normalizeProposalId(input.proposalId);
    if (String(input.confirmation || "") !== proposalId) {
      throw proposalError(400, "MAP_AI_PROPOSAL_CONFIRMATION_REQUIRED", "必须显式确认后才能标记地图补丁提案已应用");
    }
    return this.mutate(async () => {
      this.pruneExpired();
      const proposal = this.requireProposal(proposalId, context);
      if (proposal.status === "discarded") {
        throw proposalError(409, "MAP_AI_PROPOSAL_DISCARDED", "已丢弃的地图补丁提案不能标记为已应用");
      }
      if (proposal.status === "applied") return publicProposal(proposal);
      const now = this.now();
      proposal.status = "applied";
      proposal.appliedAt = now;
      proposal.updatedAt = now;
      await this.write();
      return publicProposal(proposal);
    });
  }

  pruneExpired() {
    const now = this.now();
    let pruned = 0;
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) {
        this.proposals.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }

  requireProposal(proposalId, context) {
    const id = normalizeProposalId(proposalId);
    const proposal = this.proposals.get(id);
    // Do not reveal whether a proposal exists across another user, browser,
    // thread, project, map session, map version, or editor window.
    if (!proposal || !sameContext(proposal, context)) {
      throw proposalError(404, "MAP_AI_PROPOSAL_NOT_FOUND", "地图 AI 补丁提案不存在或已过期");
    }
    return proposal;
  }

  createProposalId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.randomBytes(24).toString("base64url");
      if (!this.proposals.has(id)) return id;
    }
    throw proposalError(503, "MAP_AI_PROPOSAL_ID_UNAVAILABLE", "无法创建地图 AI 补丁提案标识");
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const state = {
      version: STORE_VERSION,
      proposals: [...this.proposals.values()].map(storedProposal),
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
    if (!this.initialized) throw new Error("Map AI patch proposal store is not initialized");
  }
}

function normalizeContext(value = {}) {
  const userId = normalizeId(value.userId, "用户 ID");
  const browserSessionId = normalizeId(value.browserSessionId, "浏览器会话 ID");
  const threadId = normalizeId(value.threadId, "对话 ID");
  const projectPath = normalizeProjectPath(value.projectPath);
  const mapSessionId = normalizeId(value.mapSessionId, "地图会话 ID");
  const editorInstanceId = normalizeId(value.editorInstanceId, "地图编辑器窗口 ID");
  let patchContext;
  try {
    patchContext = tiledAiPatchContext({
      mapPath: value.mapPath,
      mapVersion: value.mapVersion,
      editorStateId: value.editorStateId,
    });
  } catch (error) {
    throw proposalError(400, "MAP_AI_PROPOSAL_CONTEXT_INVALID", error.message);
  }
  return Object.freeze({
    userId,
    browserSessionId,
    threadId,
    projectPath,
    mapSessionId,
    mapVersion: patchContext.mapVersion,
    editorInstanceId,
    mapPath: patchContext.mapPath,
    editorStateId: patchContext.editorStateId,
    collaborationPolicyRevision: normalizePolicyRevision(value.collaborationPolicyRevision),
  });
}

function normalizePatchInput(input, context, maxPatchBytes) {
  const hasSource = typeof input.patchSource === "string";
  const hasObject = input.patch !== undefined;
  if (hasSource === hasObject) {
    throw proposalError(400, "MAP_AI_PROPOSAL_PATCH_INVALID", "必须且只能提供 patchSource 或 patch");
  }
  let source;
  try {
    source = hasSource ? input.patchSource : JSON.stringify(input.patch);
  } catch {
    throw proposalError(400, "MAP_AI_PROPOSAL_PATCH_INVALID", "地图 AI 补丁提案无法序列化");
  }
  const sourceBytes = Buffer.byteLength(source || "", "utf8");
  if (!sourceBytes || sourceBytes > maxPatchBytes) {
    throw proposalError(413, "MAP_AI_PROPOSAL_PATCH_TOO_LARGE", `地图 AI 补丁提案不能超过 ${maxPatchBytes} 字节`);
  }
  let normalized;
  try {
    normalized = parseTiledAiPatch(source, {
      mapPath: context.mapPath,
      mapVersion: context.mapVersion,
      editorStateId: context.editorStateId,
    });
  } catch (error) {
    throw proposalError(400, "MAP_AI_PROPOSAL_PATCH_INVALID", error.message);
  }
  const canonical = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > maxPatchBytes) {
    throw proposalError(413, "MAP_AI_PROPOSAL_PATCH_TOO_LARGE", `地图 AI 补丁提案不能超过 ${maxPatchBytes} 字节`);
  }
  return { value: normalized, bytes };
}

function publicProposal(proposal) {
  return {
    id: proposal.id,
    status: proposal.status,
    mapSessionId: proposal.mapSessionId,
    mapVersion: proposal.mapVersion,
    editorInstanceId: proposal.editorInstanceId,
    mapPath: proposal.mapPath,
    editorStateId: proposal.editorStateId,
    collaborationPolicyRevision: proposal.collaborationPolicyRevision,
    patch: proposal.patch ? structuredClone(proposal.patch) : null,
    patchBytes: proposal.patchBytes,
    risk: proposal.risk ? structuredClone(proposal.risk) : null,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    expiresAt: proposal.expiresAt,
    appliedAt: proposal.appliedAt,
    discardedAt: proposal.discardedAt,
  };
}

function storedProposal(proposal) {
  return {
    id: proposal.id,
    userId: proposal.userId,
    browserSessionId: proposal.browserSessionId,
    threadId: proposal.threadId,
    projectPath: proposal.projectPath,
    mapSessionId: proposal.mapSessionId,
    mapVersion: proposal.mapVersion,
    editorInstanceId: proposal.editorInstanceId,
    mapPath: proposal.mapPath,
    editorStateId: proposal.editorStateId,
    collaborationPolicyRevision: proposal.collaborationPolicyRevision,
    patch: proposal.patch,
    patchBytes: proposal.patchBytes,
    risk: proposal.risk,
    status: proposal.status,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    expiresAt: proposal.expiresAt,
    appliedAt: proposal.appliedAt,
    discardedAt: proposal.discardedAt,
  };
}

function restoreProposal(value, maxPatchBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid proposal");
  const id = normalizeProposalId(value.id);
  const context = normalizeContext(value);
  const status = String(value.status || "");
  if (!STATUS.has(status)) throw new Error("invalid status");
  let patch = null;
  let patchBytes = 0;
  if (status !== "discarded") {
    const normalized = normalizePatchInput({ patch: value.patch }, context, maxPatchBytes);
    patch = normalized.value;
    patchBytes = normalized.bytes;
  }
  const risk = patch ? riskAssessmentForPatch(patch, context.mapPath) : null;
  const createdAt = positiveTimestamp(value.createdAt);
  const updatedAt = positiveTimestamp(value.updatedAt);
  const expiresAt = positiveTimestamp(value.expiresAt);
  if (updatedAt < createdAt || expiresAt <= createdAt) throw new Error("invalid timestamps");
  const appliedAt = value.appliedAt == null ? null : positiveTimestamp(value.appliedAt);
  const discardedAt = value.discardedAt == null ? null : positiveTimestamp(value.discardedAt);
  if (status === "applied" && appliedAt === null) throw new Error("missing appliedAt");
  if (status === "discarded" && discardedAt === null) throw new Error("missing discardedAt");
  return {
    id,
    ...context,
    patch,
    patchBytes,
    risk,
    status,
    createdAt,
    updatedAt,
    expiresAt,
    appliedAt,
    discardedAt,
  };
}

function riskAssessmentForPatch(patch, mapPath) {
  const assessment = assessMapAiTask({
    approvalPolicy: "ask_each",
    operations: patch.operations,
    targetMapPaths: [mapPath],
    targetFiles: [mapPath],
  });
  return {
    ruleVersion: assessment.ruleVersion,
    riskLevel: assessment.riskLevel,
    reasonCodes: [...assessment.reasonCodes],
    hardBlocks: [...assessment.hardBlocks],
    tileCellCount: assessment.tileCellCount,
    ordinaryObjectCount: assessment.ordinaryObjectCount,
    operationCount: assessment.operationCount,
  };
}

async function readState(filePath, { maxProposals, maxPatchBytes }) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.proposals)) {
      return { proposals: new Map(), normalized: true };
    }
    let normalized = raw.proposals.length > maxProposals;
    const proposals = new Map();
    for (const value of raw.proposals.slice(-maxProposals)) {
      try {
        const proposal = restoreProposal(value, maxPatchBytes);
        if (proposals.has(proposal.id)) normalized = true;
        proposals.set(proposal.id, proposal);
      } catch { normalized = true; }
    }
    return { proposals, normalized };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { proposals: new Map(), normalized: true };
    throw error;
  }
}

function sameContext(left, right) {
  return left.userId === right.userId
    && left.browserSessionId === right.browserSessionId
    && left.threadId === right.threadId
    && left.projectPath === right.projectPath
    && left.mapSessionId === right.mapSessionId
    && left.mapVersion === right.mapVersion
    && left.editorInstanceId === right.editorInstanceId
    && left.mapPath === right.mapPath
    && left.editorStateId === right.editorStateId
    && left.collaborationPolicyRevision === right.collaborationPolicyRevision;
}

function normalizeProjectPath(value) {
  const projectPath = String(value || "");
  if (!projectPath || projectPath.length > 4_096 || !path.isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw proposalError(400, "MAP_AI_PROPOSAL_CONTEXT_INVALID", "工程路径必须是绝对路径");
  }
  return path.resolve(projectPath);
}

function normalizeId(value, label) {
  const id = String(value || "").trim();
  if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw proposalError(400, "MAP_AI_PROPOSAL_CONTEXT_INVALID", `${label}无效`);
  }
  return id;
}

function normalizeProposalId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{32}$/u.test(id)) {
    throw proposalError(400, "MAP_AI_PROPOSAL_ID_INVALID", "地图 AI 补丁提案标识无效");
  }
  return id;
}

function positiveTimestamp(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid timestamp");
  return number;
}

function normalizePolicyRevision(value) {
  const revision = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw proposalError(400, "MAP_AI_PROPOSAL_CONTEXT_INVALID", "协同策略版本无效");
  }
  return revision;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function proposalError(statusCode, code, message) { return new MapAiPatchProposalError(statusCode, code, message); }

export const MAP_AI_PATCH_PROPOSAL_DEFAULTS = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  minTtlMs: MIN_TTL_MS,
  maxTtlMs: MAX_TTL_MS,
  maxProposals: DEFAULT_MAX_PROPOSALS,
  maxProposalsPerContext: DEFAULT_MAX_PROPOSALS_PER_CONTEXT,
  maxPatchBytes: DEFAULT_MAX_PATCH_BYTES,
});
