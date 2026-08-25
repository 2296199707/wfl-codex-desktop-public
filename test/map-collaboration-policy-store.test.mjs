import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MapCollaborationPolicyError,
  MapCollaborationPolicyStore,
  collaborationPolicyProtectedTargets,
  findCollaborationOperationViolations,
} from "../lib/map-collaboration-policy-store.mjs";

const PROJECT = "/srv/projects/wflgame";
const MAP = "maps/world.tmj";
const HASH = "a".repeat(64);
const DOCUMENT = {
  type: "map", version: "1.10", orientation: "orthogonal", width: 2, height: 1,
  tilewidth: 16, tileheight: 16,
  layers: [
    { id: 1, name: "Ground", type: "tilelayer", width: 2, height: 1, data: [0, 0] },
  ],
  tilesets: [],
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-policy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new MapCollaborationPolicyStore(directory).initialize();
}

test("stores isolated versioned ownership policy and rejects stale revision", async (t) => {
  const store = await fixture(t);
  const initial = store.get({ userId: "u-1", projectPath: PROJECT, mapPath: MAP });
  assert.equal(initial.revision, 0);
  assert.equal(Object.hasOwn(initial, "projectPath"), false);
  const saved = await store.set({
    userId: "u-1", projectPath: PROJECT, mapPath: MAP, mapVersion: HASH,
    expectedRevision: 0,
    humanOwned: [{ kind: "layer", mapPath: MAP, layerId: 1 }],
    aiOwned: [{ kind: "region", mapPath: MAP, layerId: 1, rect: { x: 1, y: 0, width: 1, height: 1 } }],
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.humanOwned[0].layerId, 1);
  assert.equal(saved.aiOwned[0].kind, "region");
  await assert.rejects(
    store.set({ userId: "u-1", projectPath: PROJECT, mapPath: MAP, expectedRevision: 0, humanOwned: [] }),
    (error) => error instanceof MapCollaborationPolicyError && error.code === "MAP_COLLABORATION_POLICY_CONFLICT",
  );
  const restored = await new MapCollaborationPolicyStore(store.filePath.replace(/\/map-collaboration-policies\.json$/u, "")).initialize();
  assert.equal(restored.get({ userId: "u-1", projectPath: PROJECT, mapPath: MAP }).revision, 1);
});

test("human and locked targets become hard AI denies while AI/shared remain metadata", () => {
  const policy = {
    projectPath: PROJECT,
    mapPath: MAP,
    targets: [
      { kind: "layer", mapPath: MAP, layerId: 1, ownership: "human" },
      { kind: "region", mapPath: MAP, layerId: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, ownership: "shared" },
    ],
  };
  assert.equal(collaborationPolicyProtectedTargets(policy, MAP).length, 1);
  const patch = {
    operations: [{ op: "update-layer", layerId: 1, changes: { name: "AI" } }],
  };
  const violations = findCollaborationOperationViolations(DOCUMENT, patch, policy, MAP);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "MAP_COLLABORATION_HUMAN_OWNED");
});

test("policy keys include user, project fingerprint and map path", async (t) => {
  const store = await fixture(t);
  await store.set({ userId: "u-1", projectPath: PROJECT, mapPath: MAP, expectedRevision: 0, shared: [] });
  await store.set({ userId: "u-2", projectPath: PROJECT, mapPath: MAP, expectedRevision: 0, shared: [] });
  await store.set({ userId: "u-1", projectPath: "/srv/projects/other", mapPath: MAP, expectedRevision: 0, shared: [] });
  assert.equal(store.get({ userId: "u-1", projectPath: PROJECT, mapPath: MAP }).revision, 1);
  assert.equal(store.get({ userId: "u-2", projectPath: PROJECT, mapPath: MAP }).revision, 1);
  assert.equal(store.get({ userId: "u-1", projectPath: "/srv/projects/other", mapPath: MAP }).revision, 1);
});

