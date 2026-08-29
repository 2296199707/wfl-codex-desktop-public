import {
  applyTiledAiPatch,
  parseTiledAiPatch,
  previewTiledAiPatch,
  tiledAiPatchContext,
} from "./tiled-ai-patch.js?v=0.44.65";

const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const STATUSES = new Set(["pending", "applied", "discarded"]);
const PUBLIC_FIELDS = new Set([
  "id",
  "status",
  "mapSessionId",
  "mapVersion",
  "editorInstanceId",
  "mapPath",
  "editorStateId",
  "collaborationPolicyRevision",
  "patch",
  "patchBytes",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "appliedAt",
  "discardedAt",
  "source",
]);
const PRIVATE_FIELDS = new Set([
  "userId",
  "browserSessionId",
  "threadId",
  "projectPath",
  "lease",
  "leaseId",
  "leaseToken",
  "token",
]);
const MAX_LIST_LIMIT = 500;

export class MapAiProposalClientError extends Error {
  constructor(message, { code = "MAP_AI_PROPOSAL_CLIENT_ERROR", status = 0 } = {}) {
    super(message);
    this.name = "MapAiProposalClientError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Normalize the deliberately small proposal shape exposed to a map editor.
 * Unknown fields are rejected so an accidental server-side leak never becomes
 * application state, telemetry, or rendered UI data.
 */
export function normalizeMapAiProposal(value) {
  const source = record(value, "地图 AI 补丁提案响应不正确");
  for (const key of Object.keys(source)) {
    if (PRIVATE_FIELDS.has(key)) throw clientError("private-field", "地图 AI 补丁提案包含不应公开的会话信息");
    if (!PUBLIC_FIELDS.has(key)) throw clientError("unknown-field", `地图 AI 补丁提案包含未知字段 ${key}`);
  }
  const id = proposalId(source.id);
  const status = String(source.status || "");
  if (!STATUSES.has(status)) throw clientError("invalid-status", "地图 AI 补丁提案状态无效");
  const mapSessionId = opaqueId(source.mapSessionId, "地图会话标识");
  const editorInstanceId = opaqueId(source.editorInstanceId, "编辑器窗口标识");
  const context = tiledAiPatchContext({
    mapPath: source.mapPath,
    mapVersion: source.mapVersion,
    editorStateId: source.editorStateId,
  });
  const patch = normalizePatch(source.patch, status, context);
  const sourceInfo = normalizeSourceInfo(source.source);
  const patchBytes = nonNegativeInteger(source.patchBytes, "补丁字节数");
  if (status === "discarded" && (patch !== null || patchBytes !== 0)) {
    throw clientError("discarded-patch-retained", "已丢弃提案不应继续返回补丁内容");
  }
  if (status !== "discarded" && (patch === null || patchBytes <= 0)) {
    throw clientError("missing-patch", "地图 AI 补丁提案缺少补丁内容");
  }
  const createdAt = timestamp(source.createdAt, "创建时间");
  const updatedAt = timestamp(source.updatedAt, "更新时间");
  const expiresAt = timestamp(source.expiresAt, "过期时间");
  if (updatedAt < createdAt || expiresAt <= createdAt) {
    throw clientError("invalid-timestamps", "地图 AI 补丁提案时间信息无效");
  }
  const appliedAt = optionalTimestamp(source.appliedAt, "应用时间");
  const discardedAt = optionalTimestamp(source.discardedAt, "丢弃时间");
  if (status === "applied" && appliedAt === null) throw clientError("missing-applied-at", "已应用提案缺少应用时间");
  if (status === "discarded" && discardedAt === null) throw clientError("missing-discarded-at", "已丢弃提案缺少丢弃时间");
  return deepFreeze({
    id,
    status,
    mapSessionId,
    mapVersion: context.mapVersion,
    editorInstanceId,
    mapPath: context.mapPath,
    editorStateId: context.editorStateId,
    collaborationPolicyRevision: nonNegativeInteger(Number(source.collaborationPolicyRevision ?? 0), "协同策略版本"),
    patch,
    patchBytes,
    createdAt,
    updatedAt,
    expiresAt,
    appliedAt,
    discardedAt,
    ...(sourceInfo ? { source: sourceInfo } : {}),
  });
}

export function normalizeMapAiProposalList(value) {
  const source = record(value, "地图 AI 补丁提案列表响应不正确");
  assertResponseKeys(source, ["proposals"]);
  if (!Array.isArray(source.proposals) || source.proposals.length > MAX_LIST_LIMIT) {
    throw clientError("invalid-list", "地图 AI 补丁提案列表数量无效");
  }
  const proposals = source.proposals.map(normalizeMapAiProposal);
  if (new Set(proposals.map((entry) => entry.id)).size !== proposals.length) {
    throw clientError("duplicate-proposal", "地图 AI 补丁提案列表包含重复标识");
  }
  return Object.freeze(proposals);
}

export function mapAiProposalCompatibility(proposalValue, current = {}, { now = Date.now() } = {}) {
  const proposal = normalizeMapAiProposal(proposalValue);
  let context;
  try {
    context = tiledAiPatchContext(current);
  } catch (error) {
    return compatibility(false, "invalid-current-context", error.message);
  }
  if (proposal.status !== "pending") return compatibility(false, "not-pending", "补丁提案已不再等待处理");
  if (!Number.isSafeInteger(now) || now <= 0) return compatibility(false, "invalid-time", "当前时间无效");
  if (proposal.expiresAt <= now) return compatibility(false, "expired", "补丁提案已过期");
  if (current.mapSessionId != null && proposal.mapSessionId !== String(current.mapSessionId)) {
    return compatibility(false, "map-session-mismatch", "补丁提案不属于当前地图会话");
  }
  if (current.editorInstanceId != null && proposal.editorInstanceId !== String(current.editorInstanceId)) {
    return compatibility(false, "editor-instance-mismatch", "补丁提案不属于当前编辑器窗口");
  }
  if (proposal.mapPath !== context.mapPath) return compatibility(false, "map-path-mismatch", "补丁提案不属于当前地图路径");
  if (proposal.mapVersion !== context.mapVersion) return compatibility(false, "map-version-mismatch", "地图服务端版本已经变化，请让 AI 重新提案");
  if (proposal.editorStateId !== context.editorStateId) {
    return compatibility(false, "editor-state-mismatch", "地图本地编辑状态已经变化，请让 AI 重新提案");
  }
  if (proposal.collaborationPolicyRevision !== Number(current.collaborationPolicyRevision ?? 0)) {
    return compatibility(false, "collaboration-policy-mismatch", "协同策略已经变化，请让 AI 重新提案");
  }
  return compatibility(true, "compatible", "补丁提案与当前地图状态匹配");
}

/**
 * Adapter over the existing Tiled patch API. It intentionally has no save
 * callback: apply() only creates the normal local undo entry.
 */
export function createMapAiProposalPatchAdapter({
  parse = parseTiledAiPatch,
  preview = previewTiledAiPatch,
  apply = applyTiledAiPatch,
  prepare = async () => ({ fillResults: [], tileCellCount: 0 }),
  now = Date.now,
} = {}) {
  if (![parse, preview, apply, prepare, now].every((entry) => typeof entry === "function")) {
    throw new TypeError("地图 AI 补丁适配器依赖必须是函数");
  }
  return Object.freeze({
    async previewProposal({ proposal: proposalValue, document, context, loadedTilesets = [], signal } = {}) {
      const proposal = normalizeMapAiProposal(proposalValue);
      requireCompatibility(proposal, context, now());
      const normalizedPatch = parse(JSON.stringify(proposal.patch), patchContext(context));
      const previewResult = preview(document, normalizedPatch, { loadedTilesets });
      const preparedFills = await prepare(document, normalizedPatch, { signal });
      if (
        Number.isSafeInteger(preparedFills?.tileCellCount)
        && preparedFills.tileCellCount >= Number(previewResult?.tileCellCount || 0)
      ) previewResult.tileCellCount = preparedFills.tileCellCount;
      return deepFreeze({ proposal, normalizedPatch, preview: previewResult, preparedFills });
    },
    async applyProposal({ prepared, editor, context, loadedTilesets = [] } = {}) {
      const proposal = normalizeMapAiProposal(prepared?.proposal);
      requireCompatibility(proposal, context, now());
      // Reparse the immutable server proposal and revalidate against the live
      // editor state. Never trust a prior preview after local state changes.
      const normalizedPatch = parse(JSON.stringify(proposal.patch), patchContext(context));
      preview(editor?.document, normalizedPatch, { loadedTilesets });
      return apply(editor, normalizedPatch, {
        loadedTilesets,
        fillResults: prepared.preparedFills?.fillResults || [],
      });
    },
  });
}

export function createMapAiProposalClient({
  sessionId,
  editorInstanceId,
  leaseId = "",
  editorStateId = 0,
  fetchImpl = globalThis.fetch,
  origin = globalThis.location?.origin || "http://localhost",
} = {}) {
  const normalizedSessionId = opaqueId(sessionId, "地图会话标识");
  const normalizedEditorId = opaqueId(editorInstanceId, "编辑器窗口标识");
  let currentLeaseId = leaseId == null || leaseId === "" ? "" : leaseToken(leaseId);
  let currentEditorStateId = nonNegativeInteger(Number(editorStateId), "地图编辑状态标识");
  let currentCollaborationPolicyRevision = 0;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const base = new URL(`/api/maps/sessions/${encodeURIComponent(normalizedSessionId)}/ai-proposals`, origin);

  async function request(pathname = "", { method = "GET", action = "", json } = {}) {
    const url = new URL(`${base.pathname}${pathname}`, base);
    const headers = {
      "X-Codex-Desktop-Editor-Instance": normalizedEditorId,
      "X-Codex-Desktop-Editor-State": String(currentEditorStateId),
      "X-WFL-Map-Collaboration-Policy-Revision": String(currentCollaborationPolicyRevision),
      ...(currentLeaseId ? { "X-Codex-Desktop-Map-AI-Lease": currentLeaseId } : {}),
    };
    if (action) headers["X-Codex-Desktop-Action"] = action;
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    const response = await fetchImpl(url, { method, cache: "no-store", credentials: "same-origin", headers, body });
    if (!response?.ok) throw await responseError(response);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw clientError("invalid-response", "地图 AI 补丁提案响应不是有效 JSON");
    }
  }

  return Object.freeze({
    setLease(nextLeaseId, nextEditorStateId = currentEditorStateId) {
      currentLeaseId = nextLeaseId == null || nextLeaseId === "" ? "" : leaseToken(nextLeaseId);
      currentEditorStateId = nonNegativeInteger(Number(nextEditorStateId), "地图编辑状态标识");
    },
    clearLease() {
      currentLeaseId = "";
    },
    setEditorState(nextEditorStateId) {
      currentEditorStateId = nonNegativeInteger(Number(nextEditorStateId), "地图编辑状态标识");
    },
    setCollaborationPolicyRevision(nextRevision) {
      currentCollaborationPolicyRevision = nonNegativeInteger(Number(nextRevision), "协同策略版本");
    },
    async list({ limit = 100, includeFinal = false } = {}) {
      const normalizedLimit = boundedInteger(limit, 1, MAX_LIST_LIMIT, "列表数量");
      const query = new URL(base);
      query.searchParams.set("limit", String(normalizedLimit));
      if (includeFinal === true) query.searchParams.set("includeFinal", "true");
      const response = await request(query.search);
      return normalizeMapAiProposalList(response);
    },
    async get(id) {
      const response = await request(`/${encodeURIComponent(proposalId(id))}`);
      return normalizeProposalResponse(response);
    },
    async discard(id) {
      const normalizedId = proposalId(id);
      const response = await request(`/${encodeURIComponent(normalizedId)}`, {
        method: "DELETE",
        action: "map-ai-proposal-discard",
      });
      return normalizeProposalResponse(response);
    },
    async acknowledge(id) {
      const normalizedId = proposalId(id);
      const response = await request(`/${encodeURIComponent(normalizedId)}/acknowledge`, {
        method: "POST",
        action: "map-ai-proposal-acknowledge",
        json: { confirmation: normalizedId },
      });
      return normalizeProposalResponse(response);
    },
  });
}

function normalizeProposalResponse(value) {
  const source = record(value, "地图 AI 补丁提案响应不正确");
  assertResponseKeys(source, ["proposal"]);
  return normalizeMapAiProposal(source.proposal);
}

function normalizeSourceInfo(value) {
  if (value == null) return null;
  const source = record(value, "地图 AI 提案来源信息不正确");
  const keys = Object.keys(source);
  if (keys.some((key) => !["threadId", "label"].includes(key))) {
    throw clientError("source-field", "地图 AI 提案来源信息包含未知字段");
  }
  const threadId = source.threadId == null ? null : opaqueId(source.threadId, "来源对话标识");
  const label = source.label == null ? "" : String(source.label);
  if (label.length > 200 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw clientError("source-label", "地图 AI 提案来源名称无效");
  }
  if (!threadId && !label) throw clientError("source-empty", "地图 AI 提案来源信息为空");
  return deepFreeze({ ...(threadId ? { threadId } : {}), ...(label ? { label } : {}) });
}

function normalizePatch(value, status, context) {
  if (value == null) return null;
  if (status === "discarded") throw clientError("discarded-patch-retained", "已丢弃提案不应继续返回补丁内容");
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw clientError("invalid-patch", "地图 AI 补丁提案无法读取");
  }
  try {
    return parseTiledAiPatch(serialized, context);
  } catch (error) {
    throw clientError(error.code || "invalid-patch", error.message);
  }
}

function patchContext(value = {}) {
  return tiledAiPatchContext({
    mapPath: value.mapPath,
    mapVersion: value.mapVersion,
    editorStateId: value.editorStateId,
  });
}

function requireCompatibility(proposal, context, now) {
  const result = mapAiProposalCompatibility(proposal, context, { now });
  if (!result.matches) throw clientError(result.code, result.message);
  return result;
}

function compatibility(matches, code, message) { return Object.freeze({ matches, code, message }); }

function assertResponseKeys(value, allowed) {
  const keys = Object.keys(value);
  if (keys.some((key) => PRIVATE_FIELDS.has(key))) {
    throw clientError("private-field", "地图 AI 响应包含不应公开的会话信息");
  }
  if (keys.some((key) => !allowed.includes(key))) {
    throw clientError("unknown-response-field", "地图 AI 响应包含未知字段");
  }
}

async function responseError(response) {
  let value = {};
  try {
    value = await response?.json?.() || {};
  } catch {
    value = {};
  }
  const nested = value && typeof value.error === "object" ? value.error : null;
  const message = nested?.message || (typeof value.error === "string" ? value.error : null) || "地图 AI 补丁提案请求失败";
  return new MapAiProposalClientError(message, {
    code: nested?.code || value.code || "MAP_AI_PROPOSAL_REQUEST_FAILED",
    status: Number(response?.status) || 0,
  });
}

function proposalId(value) {
  const id = String(value || "").trim();
  if (!PROPOSAL_ID_PATTERN.test(id)) throw clientError("invalid-proposal-id", "地图 AI 补丁提案标识无效");
  return id;
}

function leaseToken(value) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(token)) {
    throw clientError("invalid-lease", "地图 AI 临时授权标识无效");
  }
  return token;
}

function opaqueId(value, label) {
  const id = String(value || "").trim();
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) throw clientError("invalid-context-id", `${label}无效`);
  return id;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw clientError("invalid-number", `${label}无效`);
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label}必须在 ${minimum}-${maximum} 之间`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw clientError("invalid-timestamp", `${label}无效`);
  return value;
}

function optionalTimestamp(value, label) { return value == null ? null : timestamp(value, label); }

function record(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw clientError("invalid-response", message);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clientError(code, message) {
  return new MapAiProposalClientError(message, { code: `MAP_AI_PROPOSAL_${String(code).toUpperCase().replaceAll("-", "_")}` });
}
