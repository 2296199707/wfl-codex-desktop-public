import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TemporarySshToolService } from "../lib/persistent-ssh-tool-service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSource = await fs.readFile(path.join(root, "server.mjs"), "utf8");

test("WFL website runtime wires temporary SSH through its private MCP adapter", () => {
  assert.match(serverSource, /new TemporarySshToolService\(/);
  assert.match(serverSource, /codexTemporarySshMcpOverride\(this\.temporarySshTool\)/);
  assert.match(serverSource, /mcp_servers\.wfl_temporary_ssh/);
  assert.match(serverSource, /scripts["', ]+,?["', ]+"temporary-ssh-mcp\.mjs"/);
  assert.match(serverSource, /pluginStore\.isAuthorized\("secure-ssh-access", this\.user\)/);
  assert.match(serverSource, /\["owner", "admin"\]\.includes\(this\.user\.role\)/);
});

test("WFL temporary SSH MCP exposes only the live administrator capability", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-temporary-ssh-tool-"));
  let enabled = true;
  const calls = [];
  const service = new TemporarySshToolService({
    directory,
    userId: "owner-test",
    capabilities: () => ({ enabled, activeCount: enabled ? 1 : 0 }),
    list: () => enabled ? [{
      id: "ssh-0123456789abcdef",
      target: "root@example.com:22",
      authMode: "public-key",
      expiresAt: Date.parse("2026-08-31T12:00:00.000Z"),
    }] : [],
    execute: async (input) => {
      calls.push(input);
      return {
        id: input.accessId,
        target: "root@example.com:22",
        exitCode: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
      };
    },
  });
  let child = null;
  try {
    await service.start();
    assert.equal((await fs.stat(service.socketPath)).mode & 0o777, 0o600);
    child = spawn(process.execPath, [
      path.join(root, "scripts", "temporary-ssh-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => child?.kill());
    const rpc = mcpClient(child);

    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "wfl-temporary-ssh");

    const listedTools = await rpc.request("tools/list", {});
    assert.deepEqual(listedTools.tools.map((tool) => tool.name), [
      "list_temporary_ssh_access",
      "run_temporary_ssh_command",
    ]);
    const runTool = listedTools.tools.find((tool) => tool.name === "run_temporary_ssh_command");
    assert.equal(runTool.inputSchema.properties.accessId.pattern, "^ssh-[a-f0-9]{16}$");
    assert.equal(runTool.inputSchema.properties.timeoutMs.maximum, 120000);

    const accesses = await rpc.request("tools/call", {
      name: "list_temporary_ssh_access",
      arguments: {},
    });
    assert.equal(accesses.isError, false);
    assert.equal(accesses.structuredContent.accesses[0].id, "ssh-0123456789abcdef");

    const result = await rpc.request("tools/call", {
      name: "run_temporary_ssh_command",
      arguments: {
        accessId: "ssh-0123456789abcdef",
        command: "uname -a",
      },
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /ok/);
    assert.deepEqual(calls, [{
      serverId: undefined,
      accessId: "ssh-0123456789abcdef",
      command: "uname -a",
      timeoutMs: undefined,
    }]);

    enabled = false;
    const hiddenTools = await rpc.request("tools/list", {});
    assert.deepEqual(hiddenTools.tools, []);
    const denied = await rpc.request("tools/call", {
      name: "run_temporary_ssh_command",
      arguments: { accessId: "ssh-0123456789abcdef", command: "id" },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.structuredContent.error, /管理员/);
  } finally {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function mcpClient(child) {
  let buffer = "";
  const pending = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) pending.shift()?.(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });
  child.once("error", (error) => {
    while (pending.length) pending.shift()(null, error);
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        pending.push((value, error) => error ? reject(error) : resolve(value.result));
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: pending.length,
          method,
          params,
        })}\n`);
      });
    },
  };
}
