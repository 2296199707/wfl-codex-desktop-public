import assert from "node:assert/strict";
import test from "node:test";
import {
  MapAiProposalClientError,
  createMapAiProposalClient,
  createMapAiProposalPatchAdapter,
  mapAiProposalCompatibility,
  normalizeMapAiProposal,
  normalizeMapAiProposalList,
} from "../public/map-editor/map-ai-proposals.js";

const CONTEXT = {
  mapPath: "maps/world.tmj",
  mapVersion: "a".repeat(64),
  editorStateId: 4,
};
const BASE = { ...CONTEXT };
const PROPOSAL_CONTEXT = { ...CONTEXT, collaborationPolicyRevision: 0 };
const PATCH = {
  format: "wfl-tiled-patch",
  version: 1,
  base: BASE,
  summary: "添一块草地",
  operations: [{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 1 }] }],
};

function proposal(overrides = {}) {
  const now = 1_700_000_000_000;
  return {
    id: "p".repeat(32),
    status: "pending",
    mapSessionId: "map-session-1",
    mapVersion: CONTEXT.mapVersion,
    editorInstanceId: "editor-1",
    mapPath: CONTEXT.mapPath,
    editorStateId: CONTEXT.editorStateId,
    patch: PATCH,
    patchBytes: JSON.stringify(PATCH).length,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    appliedAt: null,
    discardedAt: null,
    collaborationPolicyRevision: 0,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

test("normalizes public proposal and strips no private state into the client model", () => {
  const normalized = normalizeMapAiProposal(proposal({ source: { threadId: "thread-1", label: "森林地图讨论" } }));
  assert.equal(normalized.mapPath, CONTEXT.mapPath);
  assert.equal(normalized.patch.base.mapVersion, CONTEXT.mapVersion);
  assert(Object.isFrozen(normalized));
  assert(Object.isFrozen(normalized.patch));
  assert.equal(normalized.source.label, "森林地图讨论");
  assert.throws(
    () => normalizeMapAiProposal({ ...proposal(), projectPath: "/srv/project" }),
    (error) => error instanceof MapAiProposalClientError && error.code.endsWith("PRIVATE_FIELD"),
  );
  assert.throws(
    () => normalizeMapAiProposal({ ...proposal(), leaseToken: "secret" }),
    /不应公开/u,
  );
  assert.throws(() => normalizeMapAiProposal({ ...proposal(), source: { projectPath: "/srv/project" } }), /未知字段/u);
});

test("rejects malformed and discarded proposal payloads", () => {
  assert.throws(() => normalizeMapAiProposal({ ...proposal(), mapPath: "/srv/world.tmj" }), /工程相对路径/u);
  assert.throws(() => normalizeMapAiProposal({ ...proposal(), patch: { ...PATCH, base: { ...BASE, editorStateId: 9 } } }), (error) => error.code.endsWith("EDITOR_STATE_MISMATCH"));
  assert.throws(() => normalizeMapAiProposal({ ...proposal(), status: "discarded", patch: null, patchBytes: 1, discardedAt: 1_700_000_000_001 }), /丢弃提案/u);
});

test("checks map version and editor state before preview or apply", () => {
  const current = { ...CONTEXT, mapSessionId: "map-session-1", editorInstanceId: "editor-1" };
  assert.equal(mapAiProposalCompatibility(proposal(), current, { now: 1_700_000_000_001 }).matches, true);
  assert.equal(mapAiProposalCompatibility(proposal(), { ...current, mapVersion: "b".repeat(64) }, { now: 1_700_000_000_001 }).code, "map-version-mismatch");
  assert.equal(mapAiProposalCompatibility(proposal(), { ...current, editorStateId: 5 }, { now: 1_700_000_000_001 }).code, "editor-state-mismatch");
  assert.equal(mapAiProposalCompatibility(proposal({ expiresAt: 1_700_000_000_001 }), current, { now: 1_700_000_000_002 }).code, "expired");
  assert.equal(mapAiProposalCompatibility(proposal({ collaborationPolicyRevision: 2 }), { ...current, collaborationPolicyRevision: 1 }, { now: 1_700_000_000_001 }).code, "collaboration-policy-mismatch");
});

test("patch adapter previews and applies only through existing Tiled APIs", async () => {
  const calls = [];
  const adapter = createMapAiProposalPatchAdapter({
    now: () => 1_700_000_000_001,
    parse(source, expected) { calls.push(["parse", expected]); return JSON.parse(source); },
    preview(document, patch, options) { calls.push(["preview", document, patch, options]); return { operationCount: 1 }; },
    async prepare(document, patch) { calls.push(["prepare", document, patch]); return { fillResults: [], tileCellCount: 1 }; },
    apply(editor, patch, options) { calls.push(["apply", editor, patch, options]); return { changed: true }; },
  });
  const prepared = await adapter.previewProposal({ proposal: proposal(), document: { layers: [] }, context: { ...CONTEXT, mapSessionId: "map-session-1", editorInstanceId: "editor-1" } });
  assert.equal(prepared.preview.operationCount, 1);
  const result = await adapter.applyProposal({ prepared, editor: { document: { layers: [] } }, context: { ...CONTEXT, mapSessionId: "map-session-1", editorInstanceId: "editor-1" } });
  assert.equal(result.changed, true);
  assert.deepEqual(calls.map(([name]) => name), ["parse", "preview", "prepare", "parse", "preview", "apply"]);
});

test("client wraps list/get/discard/acknowledge endpoints and editor header", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "DELETE") return jsonResponse({ proposal: proposal({ status: "discarded", patch: null, patchBytes: 0, discardedAt: 1_700_000_000_001 }) });
    if (String(url).endsWith("/acknowledge")) return jsonResponse({ proposal: proposal({ status: "applied", appliedAt: 1_700_000_000_001 }) });
    if (String(url).endsWith("/" + "p".repeat(32))) return jsonResponse({ proposal: proposal() });
    return jsonResponse({ proposals: [proposal()] });
  };
  const client = createMapAiProposalClient({ sessionId: "map-session-1", editorInstanceId: "editor-1", fetchImpl });
  assert.equal((await client.list({ limit: 2 }))[0].id, "p".repeat(32));
  assert.equal((await client.get("p".repeat(32))).status, "pending");
  assert.equal((await client.discard("p".repeat(32))).status, "discarded");
  assert.equal((await client.acknowledge("p".repeat(32))).status, "applied");
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.options.headers["X-Codex-Desktop-Editor-Instance"], "editor-1");
    assert(!request.url.includes("leaseToken"));
  }
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[2].options.headers["X-Codex-Desktop-Action"], "map-ai-proposal-discard");
  assert.deepEqual(JSON.parse(requests[3].options.body), { confirmation: "p".repeat(32) });
});

test("list response has a strict shape and no private metadata", () => {
  assert.throws(() => normalizeMapAiProposalList({ proposals: [proposal({ threadId: "thread" })] }), /不应公开/u);
  assert.throws(() => normalizeMapAiProposalList({ proposals: [proposal()], browserSessionId: "secret" }), /响应包含未知字段|会话信息/u);
  assert.throws(() => normalizeMapAiProposalList({ proposals: [proposal(), proposal({ id: "q".repeat(32) })], extra: true }), /未知字段/u);
});
