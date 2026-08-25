import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapAiManagedToolService } from "../lib/map-ai-managed-tool-service.mjs";

async function call(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, index)));
    });
  });
}

test("managed map tool keeps a stable capability surface and delegates opaque authorization", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-managed-tool-"));
  const calls = [];
  const service = new MapAiManagedToolService({
    directory,
    userId: "user-1",
    capabilities: () => ({ operations: ["inspect_project", "list_map_revisions", "restore_map_revision", "apply_tiled_patch"] }),
    execute: async (input) => { calls.push(input); return { operation: input.action, mapPath: "maps/world.tmj", mapVersion: input.mapVersion }; },
  });
  await service.start();
  try {
    const initialize = await call(service.socketPath, { version: 1, action: "capabilities" });
    assert.deepEqual(initialize.result.operations, ["inspect_project", "apply_tiled_patch", "list_map_revisions", "restore_map_revision"]);
    const result = await call(service.socketPath, {
      version: 1,
      action: "inspect_project",
      authorizationId: "auth-1",
      threadId: "thread-1",
      projectFingerprint: "a".repeat(64),
      mapPath: "maps/world.tmj",
      mapVersion: "b".repeat(64),
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].userId, "user-1");
    assert.equal(calls[0].authorizationId, "auth-1");
    const proposal = await call(service.socketPath, {
      version: 1,
      action: "propose_tiled_patch",
      authorizationId: "auth-1",
      threadId: "thread-1",
      projectFingerprint: "a".repeat(64),
      mapPath: "maps/world.tmj",
      mapVersion: "b".repeat(64),
      patch: { format: "wfl-tiled-patch", version: 1, operations: [] },
    });
    assert.equal(proposal.ok, true);
    assert.equal(calls[1].action, "propose_tiled_patch");
    assert.equal(Object.hasOwn(calls[1], "clientOperationId"), false);
    const applyWithoutId = await call(service.socketPath, {
      version: 1,
      action: "apply_tiled_patch",
      authorizationId: "auth-1",
      threadId: "thread-1",
      projectFingerprint: "a".repeat(64),
      mapPath: "maps/world.tmj",
      mapVersion: "b".repeat(64),
      patch: { format: "wfl-tiled-patch", version: 1, operations: [] },
    });
    assert.equal(applyWithoutId.ok, false);
    assert.equal(applyWithoutId.error.code, "INVALID_MAP_AI_MANAGED_ARGUMENTS");
    const forbidden = await call(service.socketPath, {
      version: 1,
      action: "inspect_project",
      authorizationId: "auth-1",
      threadId: "thread-1",
      projectFingerprint: "a".repeat(64),
      mapPath: "maps/world.tmj",
      mapVersion: "b".repeat(64),
      projectPath: "/private/project",
    });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error.code, "INVALID_MAP_AI_MANAGED_ARGUMENTS");
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("managed map tool keeps its Unix socket usable in a deeply nested runtime directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-mmt-"));
  const directory = path.join(root, "r".repeat(25), "runtime", "map-ai-managed-tools");
  const service = new MapAiManagedToolService({
    directory,
    userId: "user-with-a-long-runtime-path",
    capabilities: () => ({ operations: ["inspect_project"] }),
    execute: async () => ({ ok: true }),
  });
  assert.ok(service.socketPath.length <= 107, `socket path is ${service.socketPath.length} bytes`);
  await service.start();
  try {
    const response = await call(service.socketPath, { version: 1, action: "capabilities" });
    assert.deepEqual(response.result.operations, ["inspect_project"]);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
