import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapAiToolService } from "../lib/map-ai-tool-service.mjs";

const IDS = { threadId: "thread-1", mapSessionId: "map-session-1", editorInstanceId: "editor-1", editorStateId: 0 };
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-tool-"));
  const service = new MapAiToolService({ directory, userId: "user-1", ...options });
  const socketPath = await service.start();
  return { service, socketPath, async close() { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
function request(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); socket.setEncoding("utf8"); let buffer = "";
    socket.once("error", reject); socket.on("data", (chunk) => { buffer += chunk; const index = buffer.indexOf("\n"); if (index >= 0) resolve(JSON.parse(buffer.slice(0, index))); });
    socket.once("connect", () => socket.end(`${JSON.stringify(value)}\n`));
  });
}

function jsonLineReader(stream) {
  let buffer = "";
  const values = [];
  const waiters = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else values.push(value);
    }
  });
  return () => {
    if (values.length) return Promise.resolve(values.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

test("context request resolves an exact bound context and returns metadata only", async (t) => {
  let resolved;
  const f = await fixture({ resolveContext(input, operation) { resolved = { input, operation }; return { lease: "private" }; }, getContext() { return { mapPath: "maps/world.tmj", orientation: "orthogonal", width: 10, height: 8 }; } });
  t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS });
  assert.equal(response.ok, true); assert.equal(response.result.context.width, 10); assert.equal(resolved.operation, "get_map_context"); assert.equal(resolved.input.userId, "user-1");
});

test("all four public context identifiers are mandatory", async (t) => {
  const f = await fixture({ resolveContext() { throw new Error("must not run"); } }); t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", threadId: IDS.threadId });
  assert.equal(response.ok, false); assert.equal(response.error.code, "INVALID_MAP_AI_ARGUMENTS");
});

test("lease, token, project and image parameters are rejected", async (t) => {
  const f = await fixture({ resolveContext() { throw new Error("must not run"); } }); t.after(() => f.close());
  for (const forbidden of ["leaseId", "token", "projectPath", "imageBytes"]) {
    const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS, [forbidden]: "secret" });
    assert.equal(response.error.code, "INVALID_MAP_AI_ARGUMENTS");
  }
});

test("ambiguous context fails closed with selection_required", async (t) => {
  const f = await fixture({ resolveContext() { return null; }, getContext() { throw new Error("must not run"); } }); t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS });
  assert.equal(response.error.code, "MAP_AI_CONTEXT_SELECTION_REQUIRED"); assert.equal(response.error.reason, "selection_required");
});

test("multiple resolver matches fail closed instead of choosing the newest", async (t) => {
  const f = await fixture({ resolveContext() { return [{ id: 1 }, { id: 2 }]; }, getContext() { throw new Error("must not run"); } }); t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS });
  assert.equal(response.error.reason, "selection_required");
});

test("proposal calls injected handler and never writes a map", async (t) => {
  const patch = { format: "wfl-tiled-patch", version: 1, base: { mapPath: "maps/world.tmj", mapVersion: "a".repeat(64), editorStateId: 0 }, summary: "add tree", operations: [] };
  const f = await fixture({ resolveContext() { return { exact: true }; }, proposePatch(context, input) { assert.equal(context.exact, true); assert.deepEqual(input.patch, patch); return { id: "p".repeat(32), status: "pending", patch }; } }); t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "propose_tiled_patch", ...IDS, patch });
  assert.equal(response.ok, true); assert.equal(response.result.proposal.status, "pending");
});

test("public handler results reject absolute paths and secrets", async (t) => {
  const f = await fixture({ resolveContext() { return {}; }, getContext() { return { projectPath: "/srv/private" }; } }); t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS });
  assert.equal(response.ok, false); assert.equal(response.error.code, "MAP_AI_PRIVATE_FIELD"); assert.doesNotMatch(JSON.stringify(response), /srv\/private/u);
});

test("provider and filesystem errors cannot expose absolute paths through MCP", async (t) => {
  const f = await fixture({
    resolveContext() { return {}; },
    getContext() {
      const error = new Error("ENOENT: no such file or directory, open '/srv/private/game/maps/world.tmj'");
      error.code = "ENOENT";
      throw error;
    },
  });
  t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "ENOENT");
  assert.doesNotMatch(JSON.stringify(response), /srv\/private|world\.tmj/u);
  assert.match(response.error.message, /地图编辑器/u);
});

test("unconfigured service returns disabled instead of inventing capability", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const response = await request(f.socketPath, { version: 1, action: "get_map_context", ...IDS });
  assert.equal(response.error.code, "MAP_AI_DISABLED");
});

test("service execution deadline aborts handlers before a late proposal side effect", async (t) => {
  let proposed = false;
  let observedAbort = false;
  const f = await fixture({
    requestTimeoutMs: 25,
    resolveContext() { return { exact: true }; },
    async proposePatch(context, input, { signal } = {}) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200);
        signal?.addEventListener("abort", () => {
          observedAbort = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal?.aborted) return { status: "aborted" };
      proposed = true;
      return { status: "pending" };
    },
  });
  t.after(() => f.close());
  const response = await request(f.socketPath, {
    version: 1,
    action: "propose_tiled_patch",
    ...IDS,
    patch: { format: "wfl-tiled-patch", version: 1, base: {}, operations: [] },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "MAP_AI_TOOL_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(observedAbort, true);
  assert.equal(proposed, false);
});

test("MCP keeps a stable tool catalog without an explicit active authorization", async (t) => {
  const f = await fixture({ capabilities: () => ({ operations: [] }) });
  t.after(() => f.close());
  const child = spawn(process.execPath, [path.resolve("scripts/map-ai-mcp.mjs"), f.socketPath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const read = jsonLineReader(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const initialized = (await read()).result;
  assert.equal(initialized.capabilities.tools.listChanged, false);
  assert.equal(typeof initialized.instructions, "string");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  assert.deepEqual((await read()).result.tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);
});

test("MCP exposes the stable safe schemas", async (t) => {
  const f = await fixture({ capabilities: () => ({ operations: ["get_map_context", "propose_tiled_patch"] }) });
  t.after(() => f.close());
  const child = spawn(process.execPath, [path.resolve("scripts/map-ai-mcp.mjs"), f.socketPath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const read = jsonLineReader(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const tools = (await read()).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);
  for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties, false); for (const key of ["threadId", "mapSessionId", "editorInstanceId", "editorStateId"]) assert.ok(tool.inputSchema.required.includes(key)); assert.doesNotMatch(JSON.stringify(tool), /leaseId|leaseToken|projectPath|imageBytes/u); }
});

test("long-lived MCP keeps its catalog stable and revoked calls fail closed", async (t) => {
  let operations = [];
  let resolvedCalls = 0;
  const f = await fixture({
    capabilities: () => ({ operations: [...operations] }),
    resolveContext() { resolvedCalls += 1; return {}; },
    getContext() { return { mapPath: "maps/world.tmj" }; },
  });
  t.after(() => f.close());
  const child = spawn(process.execPath, [path.resolve("scripts/map-ai-mcp.mjs"), f.socketPath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const read = jsonLineReader(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  assert.equal((await read()).result.capabilities.tools.listChanged, false);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  assert.deepEqual((await read()).result.tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);

  operations = ["get_map_context"];
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
  assert.deepEqual((await read()).result.tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);

  operations = [];
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })}\n`);
  assert.deepEqual((await read()).result.tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_map_context", arguments: IDS } })}\n`);
  const revoked = (await read()).result;
  assert.equal(revoked.isError, true);
  assert.equal(revoked.structuredContent.code, "MAP_AI_OPERATION_UNAVAILABLE");
  assert.equal(resolvedCalls, 0);
});

test("real MCP adapter calls the private socket and returns a bounded proposal receipt", async (t) => {
  let receivedPatch = null;
  const f = await fixture({
    capabilities: () => ({ operations: ["get_map_context", "propose_tiled_patch"] }),
    resolveContext(input, operation) {
      assert.equal(input.threadId, IDS.threadId);
      return { operation };
    },
    getContext() {
      return {
        mapSessionId: IDS.mapSessionId,
        mapPath: "maps/world.tmj",
        mapVersion: "a".repeat(64),
        editorInstanceId: IDS.editorInstanceId,
        editorStateId: IDS.editorStateId,
        writable: true,
      };
    },
    proposePatch(context, input) {
      assert.equal(context.operation, "propose_tiled_patch");
      receivedPatch = input.patch;
      return {
        id: "p".repeat(32),
        status: "pending",
        summary: input.patch.summary,
        patchBytes: JSON.stringify(input.patch).length,
        mapPath: "maps/world.tmj",
        mapVersion: "a".repeat(64),
        editorStateId: IDS.editorStateId,
        createdAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
      };
    },
  });
  t.after(() => f.close());
  const child = spawn(process.execPath, [path.resolve("scripts/map-ai-mcp.mjs"), "--socket", f.socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const read = jsonLineReader(child.stdout);

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  assert.equal((await read()).result.serverInfo.name, "wfl-map-ai");

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_map_context", arguments: IDS },
  })}\n`);
  const contextResult = (await read()).result;
  assert.equal(contextResult.isError, false);
  assert.equal(contextResult.structuredContent.context.mapPath, "maps/world.tmj");

  const patch = {
    format: "wfl-tiled-patch",
    version: 1,
    base: { mapPath: "maps/world.tmj", mapVersion: "a".repeat(64), editorStateId: IDS.editorStateId },
    summary: "add one tree",
    operations: [],
  };
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "propose_tiled_patch", arguments: { ...IDS, patch } },
  })}\n`);
  const proposalResult = (await read()).result;
  assert.equal(proposalResult.isError, false);
  assert.deepEqual(receivedPatch, patch);
  assert.equal(proposalResult.structuredContent.proposal.summary, patch.summary);
  assert.equal(Object.hasOwn(proposalResult.structuredContent.proposal, "patch"), false);
  assert.doesNotMatch(JSON.stringify(proposalResult), /leaseId|leaseToken|projectPath|browserSessionId|\/tmp\//u);
});

function readWithTimeout(read, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP notification timed out")), timeoutMs);
    void read().then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
