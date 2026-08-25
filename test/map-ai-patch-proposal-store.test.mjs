import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapAiPatchProposalStore } from "../lib/map-ai-patch-proposal-store.mjs";

const BASE = Object.freeze({
  mapPath: "maps/world.tmj",
  mapVersion: "a".repeat(64),
  editorStateId: 7,
});
const CONTEXT = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-1",
  threadId: "thread-1",
  projectPath: "/srv/projects/game",
  mapSessionId: "map-session-1",
  editorInstanceId: "map-window-1",
  ...BASE,
  collaborationPolicyRevision: 0,
});

function patch(operations = [{ op: "set-tiles", layerId: 1, cells: [{ x: 0, y: 0, gid: 1 }] }], overrides = {}) {
  return {
    format: "wfl-tiled-patch",
    version: 1,
    base: { ...BASE },
    summary: "更新出生点附近地块",
    operations,
    ...overrides,
  };
}

async function withStore(operation, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-proposals-"));
  try {
    const store = await new MapAiPatchProposalStore(directory, options).initialize();
    return await operation(store, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("creates a parser-validated proposal and keeps absolute project identity private", async () => {
  await withStore(async (store) => {
    const proposal = await store.create({
      ...CONTEXT,
      patchSource: JSON.stringify(patch([
        { op: "set-tiles", layerId: "1", cells: [{ x: "2", y: "3", gid: "4" }] },
      ])),
    });
    assert.match(proposal.id, /^[A-Za-z0-9_-]{32}$/u);
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.risk.ruleVersion, "map-risk-v1");
    assert.equal(proposal.risk.riskLevel, "low");
    assert.equal(proposal.risk.operationCount, 1);
    assert.deepEqual(proposal.patch.operations[0], {
      op: "set-tiles",
      layerId: 1,
      cells: [{ x: 2, y: 3, gid: 4 }],
    });
    const serialized = JSON.stringify(proposal);
    assert.doesNotMatch(serialized, /\/srv\/projects|projectPath|user-1|browser-1|thread-1/u);
    assert.equal(store.list(CONTEXT).length, 1);
    assert.deepEqual(store.get({ ...CONTEXT, proposalId: proposal.id }), proposal);
  });
});

test("strictly isolates proposals across every bound context field", async () => {
  await withStore(async (store) => {
    const proposal = await store.create({ ...CONTEXT, patch: patch() });
    for (const override of [
      { userId: "user-2" },
      { browserSessionId: "browser-2" },
      { threadId: "thread-2" },
      { projectPath: "/srv/projects/other" },
      { mapSessionId: "map-session-2" },
      { mapVersion: "b".repeat(64) },
      { editorInstanceId: "map-window-2" },
      { mapPath: "maps/other.tmj" },
      { editorStateId: 8 },
      { collaborationPolicyRevision: 1 },
    ]) {
      assert.throws(
        () => store.get({ ...CONTEXT, ...override, proposalId: proposal.id }),
        (error) => error.code === "MAP_AI_PROPOSAL_NOT_FOUND" && error.statusCode === 404,
      );
      assert.deepEqual(store.list({ ...CONTEXT, ...override }), []);
    }
  });
});

test("binds proposal inbox entries to the collaboration policy revision", async () => {
  await withStore(async (store) => {
    const proposal = await store.create({ ...CONTEXT, collaborationPolicyRevision: 3, patch: patch() });
    assert.equal(proposal.collaborationPolicyRevision, 3);
    assert.equal(store.list({ ...CONTEXT, collaborationPolicyRevision: 3 }).length, 1);
    assert.deepEqual(store.list({ ...CONTEXT, collaborationPolicyRevision: 4 }), []);
    assert.throws(
      () => store.get({ ...CONTEXT, collaborationPolicyRevision: 4, proposalId: proposal.id }),
      (error) => error.code === "MAP_AI_PROPOSAL_NOT_FOUND",
    );
  });
});

test("proposal risk metadata is derived from the canonical patch and survives restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-proposal-risk-"));
  try {
    const first = await new MapAiPatchProposalStore(root).initialize();
    const created = await first.create({
      ...CONTEXT,
      patch: patch(Array.from({ length: 65 }, (_, index) => ({
        op: "update-object",
        layerId: 2,
        objectId: index + 1,
        changes: { x: index * 16 },
      }))),
    });
    assert.equal(created.risk.ruleVersion, "map-risk-v1");
    assert.equal(created.risk.riskLevel, "high");
    assert.equal(created.risk.ordinaryObjectCount, 65);
    const restored = await new MapAiPatchProposalStore(root).initialize();
    assert.deepEqual(restored.get({ ...CONTEXT, proposalId: created.id }).risk, created.risk);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects patch base mismatch, embedded resources, and non-patch payloads through the shared parser", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.create({ ...CONTEXT, patch: patch([], { base: { ...BASE, editorStateId: 8 }, operations: [{ op: "remove-object", layerId: 2, objectId: 1 }] }) }),
      (error) => error.code === "MAP_AI_PROPOSAL_PATCH_INVALID" && /本地编辑|状态/u.test(error.message),
    );
    await assert.rejects(
      store.create({
        ...CONTEXT,
        patch: patch([{ op: "add-object", layerId: 2, object: { image: "data:image/png;base64,AAAA", x: 0, y: 0 } }]),
      }),
      (error) => error.code === "MAP_AI_PROPOSAL_PATCH_INVALID" && /不能嵌入/u.test(error.message),
    );
    await assert.rejects(
      store.create({ ...CONTEXT, patch: { type: "map", layers: [] } }),
      (error) => error.code === "MAP_AI_PROPOSAL_PATCH_INVALID",
    );
  });
});

test("requires explicit applied confirmation and supports idempotent apply or discard", async () => {
  await withStore(async (store) => {
    const appliedCandidate = await store.create({ ...CONTEXT, patch: patch() });
    await assert.rejects(
      store.markApplied({ ...CONTEXT, proposalId: appliedCandidate.id, confirmation: "wrong" }),
      (error) => error.code === "MAP_AI_PROPOSAL_CONFIRMATION_REQUIRED",
    );
    const applied = await store.markApplied({
      ...CONTEXT,
      proposalId: appliedCandidate.id,
      confirmation: appliedCandidate.id,
    });
    assert.equal(applied.status, "applied");
    assert.ok(applied.appliedAt);
    assert.deepEqual(await store.markApplied({
      ...CONTEXT,
      proposalId: appliedCandidate.id,
      confirmation: appliedCandidate.id,
    }), applied);
    await assert.rejects(
      store.discard({ ...CONTEXT, proposalId: appliedCandidate.id }),
      (error) => error.code === "MAP_AI_PROPOSAL_ALREADY_APPLIED",
    );

    const discardedCandidate = await store.create({ ...CONTEXT, patch: patch([], {
      operations: [{ op: "remove-object", layerId: 2, objectId: 1 }],
    }) });
    const discarded = await store.discard({ ...CONTEXT, proposalId: discardedCandidate.id });
    assert.equal(discarded.status, "discarded");
    assert.equal(discarded.patch, null);
    assert.equal(discarded.patchBytes, 0);
    assert.deepEqual(await store.discard({ ...CONTEXT, proposalId: discardedCandidate.id }), discarded);
    await assert.rejects(
      store.markApplied({ ...CONTEXT, proposalId: discardedCandidate.id, confirmation: discardedCandidate.id }),
      (error) => error.code === "MAP_AI_PROPOSAL_DISCARDED",
    );
    assert.deepEqual(store.list(CONTEXT), []);
    assert.equal(store.list({ ...CONTEXT, includeFinal: true }).length, 2);
  });
});

test("persists atomically, restores proposals, and never modifies the bound tmj", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-proposal-persist-"));
  const stateDirectory = path.join(root, "state");
  const projectPath = path.join(root, "project");
  const mapFile = path.join(projectPath, BASE.mapPath);
  const original = '{"type":"map","layers":[]}\n';
  try {
    await fs.mkdir(path.dirname(mapFile), { recursive: true });
    await fs.writeFile(mapFile, original);
    const context = { ...CONTEXT, projectPath };
    const first = await new MapAiPatchProposalStore(stateDirectory).initialize();
    const created = await first.create({ ...context, patch: patch() });
    await first.markApplied({ ...context, proposalId: created.id, confirmation: created.id });
    assert.equal(await fs.readFile(mapFile, "utf8"), original);

    const restored = await new MapAiPatchProposalStore(stateDirectory).initialize();
    const snapshot = restored.get({ ...context, proposalId: created.id });
    assert.equal(snapshot.status, "applied");
    assert.equal(await fs.readFile(mapFile, "utf8"), original);
    const stateStat = await fs.stat(path.join(stateDirectory, "map-ai-patch-proposals.json"));
    assert.equal(stateStat.mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(stateDirectory)).sort(), ["map-ai-patch-proposals.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("enforces TTL, per-context count, total count, and patch byte limits", async () => {
  let now = 10_000;
  await withStore(async (store) => {
    const first = await store.create({ ...CONTEXT, patch: patch() });
    await assert.rejects(
      store.create({ ...CONTEXT, patch: patch([], { operations: [{ op: "remove-object", layerId: 2, objectId: 1 }] }) }),
      (error) => error.code === "MAP_AI_CONTEXT_PROPOSAL_LIMIT" && error.statusCode === 429,
    );
    now += 1_001;
    assert.throws(
      () => store.get({ ...CONTEXT, proposalId: first.id }),
      (error) => error.code === "MAP_AI_PROPOSAL_NOT_FOUND",
    );
    assert.equal((await store.create({ ...CONTEXT, patch: patch() })).status, "pending");
  }, { now: () => now, ttlMs: 1_000, maxProposals: 2, maxProposalsPerContext: 1 });

  await withStore(async (store) => {
    const cells = Array.from({ length: 80 }, (_, index) => ({ x: index, y: 0, gid: 1 }));
    await assert.rejects(
      store.create({ ...CONTEXT, patch: patch([{ op: "set-tiles", layerId: 1, cells }]) }),
      (error) => error.code === "MAP_AI_PROPOSAL_PATCH_TOO_LARGE" && error.statusCode === 413,
    );
  }, { maxPatchBytes: 1_024 });

  await withStore(async (store) => {
    await store.create({ ...CONTEXT, patch: patch() });
    await store.create({ ...CONTEXT, threadId: "thread-2", patch: patch() });
    await assert.rejects(
      store.create({ ...CONTEXT, threadId: "thread-3", patch: patch() }),
      (error) => error.code === "MAP_AI_PROPOSAL_LIMIT" && error.statusCode === 503,
    );
  }, { maxProposals: 2, maxProposalsPerContext: 2 });
});
