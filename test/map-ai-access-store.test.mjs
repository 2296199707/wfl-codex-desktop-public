import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAP_AI_OPERATIONS,
  MapAiAccessStore,
} from "../lib/map-ai-access-store.mjs";

const CONTEXT = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-1",
  threadId: "thread-1",
  projectPath: "/srv/projects/game",
  mapSessionId: "map-session-1",
  mapVersion: "a".repeat(64),
  editorInstanceId: "map-window-1",
  editorStateId: 0,
  allowedOps: MAP_AI_OPERATIONS,
});

async function withStore(operation, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-access-"));
  try {
    const store = await new MapAiAccessStore(directory, options).initialize();
    return await operation(store, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("map AI is disabled by default and the user setting persists", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-access-"));
  try {
    const first = await new MapAiAccessStore(directory).initialize();
    assert.equal(first.isEnabled(CONTEXT.userId), false);
    await assert.rejects(
      first.grantLease(CONTEXT),
      (error) => error.code === "MAP_AI_TOOLS_DISABLED" && error.statusCode === 403,
    );
    await first.setEnabled({ userId: CONTEXT.userId, enabled: true });
    const restored = await new MapAiAccessStore(directory).initialize();
    assert.equal(restored.isEnabled(CONTEXT.userId), true);
    assert.deepEqual(restored.snapshot({ userId: CONTEXT.userId }), { mapAiToolsEnabled: true });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("lease binds every identity/context field and authorizes only listed operations", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    const granted = await store.grantLease({ ...CONTEXT, ttlMs: 5_000 });
    assert.match(granted.leaseId, /^[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(granted.allowedOps, [...MAP_AI_OPERATIONS].sort());
    assert.equal(Object.hasOwn(granted, "tokenHash"), false);
    const { allowedOps: _allowedOps, ...leaseContext } = CONTEXT;
    assert.equal(
      store.requireLease({ ...leaseContext, leaseId: granted.leaseId, operation: "get_map_context" }).threadId,
      CONTEXT.threadId,
    );
    assert.throws(
      () => store.requireLease({ ...CONTEXT, leaseId: granted.leaseId, operation: "unknown_operation" }),
      (error) => error.code === "MAP_AI_OPERATION_INVALID",
    );
    assert.throws(
      () => store.requireLease({ ...leaseContext, leaseId: granted.leaseId, operation: "get_map_context", threadId: "other-thread" }),
      (error) => error.code === "MAP_AI_LEASE_CONTEXT_MISMATCH" && error.statusCode === 409,
    );
    assert.throws(
      () => store.requireLease({ ...leaseContext, leaseId: granted.leaseId, operation: "get_map_context", mapVersion: "b".repeat(64) }),
      (error) => error.code === "MAP_AI_LEASE_CONTEXT_MISMATCH",
    );
  });
});

test("persisted leases remain usable after restart without storing the bearer token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-access-"));
  try {
    const first = await new MapAiAccessStore(directory).initialize();
    await first.setEnabled({ userId: CONTEXT.userId, enabled: true });
    const granted = await first.grantLease({ ...CONTEXT, allowedOps: ["propose_tiled_patch"], ttlMs: 5_000 });
    const raw = await fs.readFile(path.join(directory, "map-ai-access.json"), "utf8");
    assert.doesNotMatch(raw, new RegExp(granted.leaseId, "u"));
    assert.match(raw, /tokenHash/u);
    const restored = await new MapAiAccessStore(directory).initialize();
    assert.deepEqual(
      restored.requireLease({ ...CONTEXT, leaseId: granted.leaseId, operation: "propose_tiled_patch" }),
      { ...CONTEXT, allowedOps: ["propose_tiled_patch"], grantedAt: granted.grantedAt, expiresAt: granted.expiresAt },
    );
    assert.throws(
      () => restored.requireLease({ ...CONTEXT, leaseId: granted.leaseId, operation: "get_map_context" }),
      (error) => error.code === "MAP_AI_OPERATION_NOT_AUTHORIZED" && error.statusCode === 403,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("expiry, explicit revoke, and disabling the user invalidate leases", async () => {
  let now = 1_000_000;
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    const first = await store.grantLease({ ...CONTEXT, ttlMs: 1_000 });
    now += 1_001;
    assert.throws(
      () => store.requireLease({ ...CONTEXT, leaseId: first.leaseId, operation: "get_map_context" }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND" && error.statusCode === 404,
    );
    const second = await store.grantLease({ ...CONTEXT, ttlMs: 5_000 });
    const revoked = await store.revokeLease({ leaseId: second.leaseId, userId: CONTEXT.userId });
    assert.equal(revoked.revoked, true);
    assert.deepEqual(revoked.lease, Object.fromEntries(
      Object.entries(second).filter(([key]) => key !== "leaseId"),
    ));
    assert.throws(
      () => store.requireLease({ ...CONTEXT, leaseId: second.leaseId, operation: "get_map_context" }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND",
    );
    const third = await store.grantLease({ ...CONTEXT, ttlMs: 5_000 });
    const disabled = await store.setEnabled({ userId: CONTEXT.userId, enabled: false });
    assert.equal(disabled.revokedLeases, 1);
    assert.throws(
      () => store.requireLease({ ...CONTEXT, leaseId: third.leaseId, operation: "get_map_context" }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND" || error.code === "MAP_AI_TOOLS_DISABLED",
    );
  }, { now: () => now });
});

test("browser-session and editor-window revocation remove only matching leases", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    const first = await store.grantLease(CONTEXT);
    const second = await store.grantLease({ ...CONTEXT, editorInstanceId: "map-window-2" });
    const other = await store.grantLease({ ...CONTEXT, browserSessionId: "browser-2" });
    assert.deepEqual(
      await store.revokeForEditorWindow({
        userId: CONTEXT.userId,
        browserSessionId: CONTEXT.browserSessionId,
        editorInstanceId: CONTEXT.editorInstanceId,
      }),
      { revoked: 1 },
    );
    assert.throws(
      () => store.requireLease({ ...CONTEXT, leaseId: first.leaseId, operation: "get_map_context" }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND",
    );
    assert.doesNotThrow(() => store.requireLease({ ...CONTEXT, editorInstanceId: "map-window-2", leaseId: second.leaseId, operation: "get_map_context" }));
    assert.deepEqual(
      await store.revokeForBrowserSession({ userId: CONTEXT.userId, browserSessionId: "browser-2" }),
      { revoked: 1 },
    );
    assert.throws(
      () => store.requireLease({ ...CONTEXT, browserSessionId: "browser-2", leaseId: other.leaseId, operation: "get_map_context" }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND",
    );
  });
});

test("resolves only the exact editor state and supports scoped lifecycle revocation", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    const first = await store.grantLease({ ...CONTEXT, editorStateId: 4 });
    const second = await store.grantLease({
      ...CONTEXT,
      mapSessionId: "map-session-2",
      editorInstanceId: "map-window-2",
      editorStateId: 5,
    });
    const resolved = store.contextForLease({ leaseId: first.leaseId });
    assert.equal(resolved.editorStateId, 4);
    assert.equal(Object.hasOwn(resolved, "tokenHash"), false);
    assert.throws(
      () => store.requireLease({
        ...CONTEXT,
        editorStateId: 5,
        leaseId: first.leaseId,
        operation: "get_map_context",
      }),
      (error) => error.code === "MAP_AI_LEASE_CONTEXT_MISMATCH",
    );
    assert.deepEqual(
      await store.revokeForMapSession({
        userId: CONTEXT.userId,
        browserSessionId: CONTEXT.browserSessionId,
        mapSessionId: "map-session-2",
      }),
      { revoked: 1 },
    );
    assert.doesNotThrow(() => store.requireLease({
      ...CONTEXT,
      editorStateId: 4,
      leaseId: first.leaseId,
      operation: "get_map_context",
    }));
    assert.deepEqual(await store.revokeForThread({ userId: CONTEXT.userId, threadId: CONTEXT.threadId }), { revoked: 1 });
    assert.deepEqual(await store.revokeForUser({ userId: CONTEXT.userId }), { revoked: 0 });
  });
});

test("tool context resolution requires one exact explicit lease and never returns token material", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    await store.grantLease({ ...CONTEXT, editorStateId: 7 });
    const resolved = store.resolveToolContext({
      userId: CONTEXT.userId,
      threadId: CONTEXT.threadId,
      mapSessionId: CONTEXT.mapSessionId,
      editorInstanceId: CONTEXT.editorInstanceId,
      editorStateId: 7,
      operation: "get_map_context",
    });
    assert.equal(resolved.mapVersion, CONTEXT.mapVersion);
    assert.equal(resolved.browserSessionId, CONTEXT.browserSessionId);
    assert.equal(Object.hasOwn(resolved, "tokenHash"), false);
    assert.equal(Object.hasOwn(resolved, "leaseId"), false);
    assert.throws(
      () => store.resolveToolContext({
        userId: CONTEXT.userId,
        threadId: CONTEXT.threadId,
        mapSessionId: CONTEXT.mapSessionId,
        editorInstanceId: CONTEXT.editorInstanceId,
        editorStateId: 8,
        operation: "get_map_context",
      }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND" && error.statusCode === 404,
    );
  });
});

test("tool context resolution fails closed when duplicate leases match", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    await store.grantLease(CONTEXT);
    await store.grantLease(CONTEXT);
    assert.throws(
      () => store.resolveToolContext({
        userId: CONTEXT.userId,
        threadId: CONTEXT.threadId,
        mapSessionId: CONTEXT.mapSessionId,
        editorInstanceId: CONTEXT.editorInstanceId,
        editorStateId: CONTEXT.editorStateId,
        operation: "propose_tiled_patch",
      }),
      (error) => error.code === "MAP_AI_CONTEXT_SELECTION_REQUIRED" && error.statusCode === 409,
    );
  });
});

test("MCP catalog operations are empty by default and follow only active leases for one user", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-access-"));
  let now = 1_700_000_000_000;
  const store = await new MapAiAccessStore(directory, { now: () => now }).initialize();
  try {
    assert.deepEqual(store.authorizedOperationsForUser({ userId: CONTEXT.userId }), []);
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    assert.deepEqual(store.authorizedOperationsForUser({ userId: CONTEXT.userId }), []);

    const first = await store.grantLease({
      ...CONTEXT,
      allowedOps: ["get_map_context"],
      ttlMs: 1_000,
    });
    assert.deepEqual(store.authorizedOperationsForUser({ userId: CONTEXT.userId }), ["get_map_context"]);
    assert.deepEqual(store.authorizedOperationsForUser({ userId: "another-user" }), []);

    await store.grantLease({
      ...CONTEXT,
      threadId: "thread-2",
      editorInstanceId: "map-window-2",
      allowedOps: ["propose_tiled_patch"],
      ttlMs: 5_000,
    });
    assert.deepEqual(store.authorizedOperationsForUser({ userId: CONTEXT.userId }), [
      "get_map_context",
      "propose_tiled_patch",
    ]);

    await store.revokeLease({ leaseId: first.leaseId, userId: CONTEXT.userId });
    assert.deepEqual(store.authorizedOperationsForUser({ userId: CONTEXT.userId }), ["propose_tiled_patch"]);
    now += 5_001;
    assert.deepEqual(store.authorizedOperationsForUser({ userId: CONTEXT.userId }), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("tool context resolution enforces the user switch and operation grant", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    await store.grantLease({ ...CONTEXT, allowedOps: ["get_map_context"] });
    assert.throws(
      () => store.resolveToolContext({
        userId: CONTEXT.userId,
        threadId: CONTEXT.threadId,
        mapSessionId: CONTEXT.mapSessionId,
        editorInstanceId: CONTEXT.editorInstanceId,
        editorStateId: CONTEXT.editorStateId,
        operation: "propose_tiled_patch",
      }),
      (error) => error.code === "MAP_AI_LEASE_NOT_FOUND",
    );
    await store.setEnabled({ userId: CONTEXT.userId, enabled: false });
    assert.throws(
      () => store.resolveToolContext({
        userId: CONTEXT.userId,
        threadId: CONTEXT.threadId,
        mapSessionId: CONTEXT.mapSessionId,
        editorInstanceId: CONTEXT.editorInstanceId,
        editorStateId: CONTEXT.editorStateId,
        operation: "get_map_context",
      }),
      (error) => error.code === "MAP_AI_TOOLS_DISABLED" && error.statusCode === 403,
    );
  });
});

test("rejects invalid context and out-of-range lease duration", async () => {
  await withStore(async (store) => {
    await store.setEnabled({ userId: CONTEXT.userId, enabled: true });
    await assert.rejects(
      store.grantLease({ ...CONTEXT, mapVersion: "not-a-hash" }),
      (error) => error.code === "MAP_AI_CONTEXT_INVALID" && error.statusCode === 400,
    );
    await assert.rejects(
      store.grantLease({ ...CONTEXT, allowedOps: ["read_image_bytes"] }),
      (error) => error.code === "MAP_AI_OPERATION_INVALID" && error.statusCode === 400,
    );
    await assert.rejects(
      store.grantLease({ ...CONTEXT, ttlMs: 1 }),
      (error) => error.code === "MAP_AI_LEASE_TTL_INVALID" && error.statusCode === 400,
    );
  });
});
