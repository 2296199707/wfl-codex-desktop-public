import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCodexMcpServerDraft,
  normalizeCodexMcpServerName,
  publicCodexMcpServerConfig,
  redactCodexMcpSecretsFromConfigRead,
  userCodexMcpServers,
} from "../lib/codex-mcp-config.mjs";

test("Codex MCP configuration supports native stdio and redacts stored environment values", () => {
  const native = normalizeCodexMcpServerDraft({
    transport: "stdio",
    command: "npx",
    args: ["-y", "@example/mcp"],
    cwd: "/srv/project",
    env: [{ name: "PRIVATE_TOKEN", value: "secret-value" }],
    envVars: [{ name: "FORWARDED_TOKEN", source: "local" }],
    enabled: true,
    required: false,
    startupTimeoutSec: 20,
    toolTimeoutSec: 90,
    enabledTools: ["read"],
    disabledTools: ["delete"],
    defaultToolsApprovalMode: "prompt",
    toolApprovals: [{ name: "read", approvalMode: "approve" }],
  });
  assert.equal(native.command, "npx");
  assert.equal(native.env.PRIVATE_TOKEN, "secret-value");
  assert.deepEqual(native.tools.read, { approval_mode: "approve" });

  const publicConfig = publicCodexMcpServerConfig("docs", native);
  assert.deepEqual(publicConfig.env, [{ name: "PRIVATE_TOKEN", configured: true }]);
  assert.equal(JSON.stringify(publicConfig).includes("secret-value"), false);
});

test("Codex MCP HTTP edits preserve masked secrets and expose non-secret policy", () => {
  const existing = {
    url: "https://mcp.example.test/api",
    http_headers: { Authorization: "Bearer private" },
  };
  const native = normalizeCodexMcpServerDraft({
    transport: "http",
    url: "https://mcp.example.test/api",
    auth: "oauth",
    bearerTokenEnvVar: "MCP_BEARER",
    httpHeaders: [{ name: "Authorization", keep: true }],
    envHttpHeaders: [{ name: "X-Region", value: "MCP_REGION" }],
    oauthResource: "https://mcp.example.test/",
    scopes: ["tools.read"],
    enabled: false,
    required: true,
    startupTimeoutSec: 15,
    toolTimeoutSec: 120,
    defaultToolsApprovalMode: "writes",
  }, existing);
  assert.equal(native.http_headers.Authorization, "Bearer private");
  assert.equal(native.env_http_headers["X-Region"], "MCP_REGION");
  assert.equal(native.enabled, false);
  assert.equal(native.required, true);
});

test("Codex MCP configuration rejects unsafe names, URLs, and missing masked values", () => {
  assert.throws(() => normalizeCodexMcpServerName("bad.name"), /名称/);
  assert.throws(() => normalizeCodexMcpServerDraft({
    transport: "http",
    url: "file:///tmp/socket",
  }), /http\/https/);
  assert.throws(() => normalizeCodexMcpServerDraft({
    transport: "stdio",
    command: "node",
    env: [{ name: "TOKEN", keep: true }],
  }), /尚未设置值/);
});

test("Codex MCP configuration selects only the base user config layer", () => {
  const result = userCodexMcpServers({
    layers: [{
      name: { type: "project", dotCodexFolder: "/srv/project/.codex" },
      version: "project",
      config: { mcp_servers: { project: { command: "node" } } },
    }, {
      name: { type: "user", file: "/home/user/.codex/config.toml", profile: null },
      version: "user-v1",
      config: { mcp_servers: { account: { url: "https://mcp.example.test" } } },
    }],
  });
  assert.deepEqual(Object.keys(result.servers), ["account"]);
  assert.equal(result.version, "user-v1");
  assert.equal(result.filePath, "/home/user/.codex/config.toml");
});

test("generic browser config reads redact MCP environment and static header values in every layer", () => {
  const source = {
    config: {
      model: "gpt-test",
      mcp_servers: {
        private: {
          command: "node",
          env: { PRIVATE_TOKEN: "top-secret" },
          http_headers: { Authorization: "Bearer private" },
        },
      },
    },
    layers: [{
      name: { type: "user", file: "/home/user/.codex/config.toml", profile: null },
      version: "v1",
      config: {
        mcp_servers: {
          private: {
            env: { PRIVATE_TOKEN: "layer-secret" },
            http_headers: { Authorization: "layer-private" },
          },
        },
      },
    }],
  };
  const result = redactCodexMcpSecretsFromConfigRead(source);
  assert.equal(result.config.model, "gpt-test");
  assert.equal(result.config.mcp_servers.private.env.PRIVATE_TOKEN, "__configured__");
  assert.equal(result.layers[0].config.mcp_servers.private.http_headers.Authorization, "__configured__");
  assert.match(JSON.stringify(source), /top-secret/);
  assert.doesNotMatch(JSON.stringify(result), /top-secret|layer-secret|Bearer private|layer-private/);
});
