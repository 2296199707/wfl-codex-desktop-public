import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MapAiManagedAuthorizationError,
  MapAiManagedAuthorizationStore,
} from "../lib/map-ai-managed-authorization-store.mjs";

const HASH_A = "a".repeat(64);
const IDENTITY = { userId: "u-1", browserSessionId: "browser-1" };

function input(overrides = {}) {
  return {
    identity: IDENTITY,
    scope: {
      authorityMode: "managed",
      threadId: "thread-1",
      projectPath: "/srv/projects/wflgame",
      mapPaths: ["maps/world.tmj"],
      mapVersions: { "maps/world.tmj": HASH_A },
    },
    allowedOps: ["get_map_context", "propose_tiled_patch"],
    protectedTargets: ["maps/collision.tmj"],
    budget: { maxBatches: 4, maxOperations: 20 },
    approvalSnapshot: {
      version: 1,
      policy: "ask_each",
      source: "map_selection",
      riskRuleVersion: "map-risk-v1",
      userConfirmed: true,
    },
    clientOperationId: "authorization-1",
    ttlMs: 60_000,
    ...overrides,
  };
}

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-auth-"));
  const store = await new MapAiManagedAuthorizationStore(directory, options).initialize();
  return { directory, store };
}

test("creates a separate headless authorization without an editor lease and persists it", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input());
  assert.equal(created.created, true);
  assert.equal(created.authorization.authorityMode, "managed");
  assert.equal(created.authorization.projectFingerprint.length, 64);
  assert.equal(Object.hasOwn(created.authorization, "projectPath"), false);
  assert.deepEqual(created.authorization.mapPaths, ["maps/world.tmj"]);
  assert.equal(created.authorization.approvalPolicy, "ask_each");
  const restored = await new MapAiManagedAuthorizationStore(f.directory).initialize();
  assert.equal(restored.snapshot({ authorizationId: created.authorization.id, identity: IDENTITY }).id, created.authorization.id);
  assert.deepEqual(restored.resolveForTool({
    identity: IDENTITY,
    threadId: "thread-1",
    projectPath: "/srv/projects/wflgame",
    mapPath: "maps/world.tmj",
    mapVersion: HASH_A,
    operation: "get_map_context",
  }).allowedOps, ["get_map_context", "propose_tiled_patch"]);
});

test("normalizes structured protected layers, objects, regions, and semantic targets", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input({
    clientOperationId: "authorization-structured",
    protectedTargets: [
      { kind: "layer", mapPath: "maps/world.tmj", layerId: 3 },
      { kind: "object", mapPath: "maps/world.tmj", layerId: 5, objectId: 42 },
      { kind: "region", mapPath: "maps/world.tmj", layerId: 1, rect: { x: 2, y: 3, width: 4, height: 5 } },
      { kind: "semantic", mapPath: "maps/world.tmj", role: "spawn" },
    ],
  }));
  assert.deepEqual(created.authorization.protectedTargets, [
    { kind: "layer", mapPath: "maps/world.tmj", layerId: 3 },
    { kind: "object", mapPath: "maps/world.tmj", layerId: 5, objectId: 42 },
    { kind: "region", mapPath: "maps/world.tmj", layerId: 1, rect: { x: 2, y: 3, width: 4, height: 5 } },
    { kind: "semantic", mapPath: "maps/world.tmj", layerId: null, role: "spawn" },
  ]);
});

test("idempotency and exact scope resolution fail closed", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input());
  const again = await f.store.create(input());
  assert.equal(again.created, false);
  assert.equal(again.authorization.id, created.authorization.id);
  await assert.rejects(
    f.store.create(input({ clientOperationId: "authorization-1", allowedOps: ["apply_tiled_patch"] })),
    (error) => error instanceof MapAiManagedAuthorizationError && error.code === "MAP_AI_MANAGED_AUTH_OPERATION_CONFLICT",
  );
  await assert.rejects(
    Promise.resolve().then(() => f.store.resolveForTool({
      identity: IDENTITY,
      threadId: "thread-other",
      projectPath: "/srv/projects/wflgame",
      mapPath: "maps/world.tmj",
      mapVersion: HASH_A,
      operation: "get_map_context",
    })),
    (error) => error.code === "MAP_AI_MANAGED_AUTH_NOT_FOUND",
  );
  await assert.rejects(
    Promise.resolve().then(() => f.store.resolveForTool({
      identity: IDENTITY,
      threadId: "thread-1",
      projectPath: "/srv/projects/wflgame",
      mapPath: "maps/world.tmj",
      mapVersion: HASH_A,
      operation: "apply_tiled_patch",
    })),
    (error) => error.code === "MAP_AI_MANAGED_AUTH_NOT_FOUND",
  );
});

test("revocation immediately invalidates tool resolution and is isolated by user/session", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input());
  const revoked = await f.store.revoke({ authorizationId: created.authorization.id, identity: IDENTITY, reason: "manual" });
  assert.equal(revoked.revokedReason, "manual");
  await assert.rejects(
    Promise.resolve().then(() => f.store.resolveForTool({
      identity: IDENTITY,
      threadId: "thread-1",
      projectPath: "/srv/projects/wflgame",
      mapPath: "maps/world.tmj",
      mapVersion: HASH_A,
      operation: "get_map_context",
    })),
    (error) => error.code === "MAP_AI_MANAGED_AUTH_NOT_FOUND",
  );
  const other = await f.store.create(input({
    identity: { userId: "u-2", browserSessionId: "browser-2" },
    clientOperationId: "authorization-other",
  }));
  assert.equal((await f.store.revokeForBrowserSession({ userId: "u-1", browserSessionId: "browser-1" })).revoked, 0);
  assert.equal(f.store.snapshot({ authorizationId: other.authorization.id, identity: { userId: "u-2", browserSessionId: "browser-2" } }).revokedAt, null);
});

test("explicit Thread transfer changes the live scope and leaves an audit record", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input({ clientOperationId: "authorization-transfer" }));
  const transferred = await f.store.transferThread({
    authorizationId: created.authorization.id,
    identity: IDENTITY,
    targetThreadId: "thread-2",
  });
  assert.equal(transferred.threadId, "thread-2");
  await assert.rejects(
    Promise.resolve().then(() => f.store.resolveForTool({
      identity: IDENTITY,
      threadId: "thread-1",
      projectPath: "/srv/projects/wflgame",
      mapPath: "maps/world.tmj",
      mapVersion: HASH_A,
      operation: "get_map_context",
    })),
    (error) => error.code === "MAP_AI_MANAGED_AUTH_NOT_FOUND",
  );
  assert.deepEqual(
    f.store.resolveForTool({
      identity: IDENTITY,
      threadId: "thread-2",
      projectPath: "/srv/projects/wflgame",
      mapPath: "maps/world.tmj",
      mapVersion: HASH_A,
      operation: "get_map_context",
    }).allowedOps,
    ["get_map_context", "propose_tiled_patch"],
  );
  const audit = await f.store.audit({ authorizationId: created.authorization.id, identity: IDENTITY });
  assert.equal(audit.audit.at(-1).type, "transferred");
  assert.match(audit.audit.at(-1).reason, /thread-1 -> thread-2/u);
});

test("Thread transfer uses an optimistic expected Thread guard", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input({ clientOperationId: "authorization-transfer-guard" }));
  await f.store.transferThread({
    authorizationId: created.authorization.id,
    identity: IDENTITY,
    targetThreadId: "thread-2",
    expectedThreadId: "thread-1",
  });
  await assert.rejects(
    f.store.transferThread({
      authorizationId: created.authorization.id,
      identity: IDENTITY,
      targetThreadId: "thread-3",
      expectedThreadId: "thread-1",
    }),
    (error) => error.code === "MAP_AI_MANAGED_AUTH_TRANSFER_CONFLICT",
  );
  assert.equal(f.store.snapshot({ authorizationId: created.authorization.id, identity: IDENTITY }).threadId, "thread-2");
});

test("Thread transfer audit survives authorization-store restart", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input({ clientOperationId: "authorization-transfer-restart" }));
  await f.store.transferThread({
    authorizationId: created.authorization.id,
    identity: IDENTITY,
    targetThreadId: "thread-2",
    expectedThreadId: "thread-1",
    reason: "restart audit",
  });
  const restarted = await new MapAiManagedAuthorizationStore(f.directory).initialize();
  const audit = await restarted.audit({ authorizationId: created.authorization.id, identity: IDENTITY });
  assert.equal(audit.authorization.threadId, "thread-2");
  assert.deepEqual(audit.audit.map(({ type }) => type), ["created", "transferred"]);
  assert.match(audit.audit.at(-1).reason, /restart audit/u);
});

test("authorization audit survives revocation and expiry without exposing scope paths", async (t) => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now }); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const created = await f.store.create(input({ ttlMs: 1_000, clientOperationId: "authorization-audit" }));
  let audit = await f.store.audit({ authorizationId: created.authorization.id, identity: IDENTITY });
  assert.deepEqual(audit.audit.map(({ type }) => type), ["created"]);
  assert.equal(Object.hasOwn(audit.authorization, "projectPath"), false);

  now += 500;
  await f.store.revoke({ authorizationId: created.authorization.id, identity: IDENTITY, reason: "manual stop" });
  audit = await f.store.audit({ authorizationId: created.authorization.id, identity: IDENTITY });
  assert.deepEqual(audit.audit.map(({ type }) => type), ["created", "revoked"]);
  assert.equal(audit.audit.at(-1).reason, "manual stop");

  const restored = await new MapAiManagedAuthorizationStore(f.directory, { now: () => now }).initialize();
  assert.deepEqual((await restored.audit({ authorizationId: created.authorization.id, identity: IDENTITY })).audit.map(({ type }) => type), ["created", "revoked"]);

  const expiring = await restored.create(input({ ttlMs: 1_000, clientOperationId: "authorization-expired" }));
  now += 2_000;
  const expired = await restored.audit({ authorizationId: expiring.authorization.id, identity: IDENTITY });
  assert.deepEqual(expired.audit.map(({ type }) => type), ["created", "expired"]);
  const restoredAfterExpiry = await new MapAiManagedAuthorizationStore(f.directory, { now: () => now }).initialize();
  assert.deepEqual((await restoredAfterExpiry.audit({ authorizationId: expiring.authorization.id, identity: IDENTITY })).audit.map(({ type }) => type), ["created", "expired"]);
  await assert.rejects(
    Promise.resolve().then(() => restored.resolveForTool({ identity: IDENTITY, threadId: "thread-1", projectPath: "/srv/projects/wflgame", mapPath: "maps/world.tmj", mapVersion: HASH_A, operation: "get_map_context" })),
    (error) => error.code === "MAP_AI_MANAGED_AUTH_NOT_FOUND",
  );
});

test("rejects editor-bound authority, unsafe paths, unknown operations, and unconfirmed policies", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  await assert.rejects(
    f.store.create(input({ scope: { ...input().scope, authorityMode: "editor" }, clientOperationId: "editor" })),
    (error) => error.code === "MAP_AI_MANAGED_SCOPE_INVALID",
  );
  await assert.rejects(
    f.store.create(input({ scope: { ...input().scope, mapPaths: ["../outside"], mapVersions: { "../outside": HASH_A } }, clientOperationId: "path" })),
    (error) => error.code === "MAP_AI_MANAGED_PATHS_INVALID",
  );
  await assert.rejects(
    f.store.create(input({ allowedOps: ["shell"], clientOperationId: "operation" })),
    (error) => error.code === "MAP_AI_MANAGED_OPERATION_INVALID",
  );
  await assert.rejects(
    f.store.create(input({ allowedOps: ["read_project_resource"], clientOperationId: "project-operation" })),
    (error) => error.code === "MAP_AI_MANAGED_SCOPE_INVALID",
  );
  await assert.rejects(
    f.store.create(input({ approvalSnapshot: { ...input().approvalSnapshot, userConfirmed: false }, clientOperationId: "unconfirmed" })),
    (error) => error.code === "MAP_AI_MANAGED_APPROVAL_INVALID",
  );
});

test("project-wide authorization is independent from Thread and map versions", async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.directory, { recursive: true, force: true }));
  const projectIdentity = { userId: IDENTITY.userId, browserSessionId: "managed:u-1" };
  const created = await f.store.create(input({
    identity: projectIdentity,
    clientOperationId: "authorization-project-wide",
    scope: {
      authorityMode: "managed",
      scopeKind: "project",
      projectWide: true,
      projectPath: "/srv/projects/wflgame",
    },
    allowedOps: ["get_project_context", "read_project_resource", "apply_project_patch"],
  }));
  assert.equal(created.authorization.projectWide, true);
  assert.equal(created.authorization.scopeKind, "project");
  assert.equal(created.authorization.threadId, null);
  assert.deepEqual(created.authorization.mapPaths, []);
  assert.deepEqual(created.authorization.mapVersions, {});
  const contract = f.store.toolContract({ authorizationId: created.authorization.id, userId: IDENTITY.userId });
  assert.equal(contract.scope.projectWide, true);
  assert.equal(contract.scope.threadId, null);
  assert.deepEqual(contract.scope.mapVersions, {});
  assert.deepEqual(f.store.list({ identity: projectIdentity, threadId: "any-thread" }).map((entry) => entry.id), [created.authorization.id]);
  assert.deepEqual(await f.store.revokeForThread({ userId: IDENTITY.userId, threadId: "any-thread" }), { revoked: 0 });
  assert.deepEqual(await f.store.revokeForBrowserSession({ userId: IDENTITY.userId, browserSessionId: IDENTITY.browserSessionId }), { revoked: 0 });
  assert.deepEqual(
    f.store.resolveForTool({
      identity: projectIdentity,
      projectPath: "/srv/projects/wflgame",
      mapPath: null,
      operation: "get_project_context",
    }).allowedOps,
    ["apply_project_patch", "get_project_context", "read_project_resource"],
  );
});
