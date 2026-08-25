import assert from "node:assert/strict";
import test from "node:test";
import {
  codexMcpElicitationBrowserRequest,
  codexServerRequestDisposition,
  codexServerRequestAutoResolutionMs,
  internalCodexServerRequestResponse,
  isKnownCodexServerRequest,
  normalizeCodexServerRequestResponse,
  publicCodexServerRequest,
  publicCodexMcpElicitation,
  rejectedCodexServerRequest,
  safeCodexServerRequestRejection,
} from "../lib/codex-server-request.mjs";

test("bounds optional request-user-input auto resolution", () => {
  const request = (autoResolutionMs) => ({
    method: "item/tool/requestUserInput",
    params: { autoResolutionMs },
  });
  assert.equal(codexServerRequestAutoResolutionMs(request(60_000)), 60_000);
  assert.equal(codexServerRequestAutoResolutionMs(request(120_000)), 120_000);
  assert.equal(codexServerRequestAutoResolutionMs(request(1)), 60_000);
  assert.equal(codexServerRequestAutoResolutionMs(request(999_999)), 240_000);
  assert.equal(codexServerRequestAutoResolutionMs(request(null)), null);
  assert.equal(codexServerRequestAutoResolutionMs({ method: "item/tool/call", params: {} }), null);
});

test("keeps MCP OAuth URLs on the server and exposes only the isolated browser", () => {
  const request = {
    id: "mcp-1",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "url",
      message: "Sign in",
      elicitationId: "upstream-1",
      url: "https://login.example.test/oauth?secret=hidden",
    },
  };
  assert.deepEqual(codexMcpElicitationBrowserRequest(request), {
    userFacingId: "mcp-1",
    authUrl: "https://login.example.test/oauth?secret=hidden",
  });
  const safe = publicCodexMcpElicitation(request, {
    browser: { active: true, host: "login.example.test" },
  });
  assert.equal(safe.params.url, undefined);
  assert.equal(JSON.stringify(safe).includes("secret=hidden"), false);
  assert.equal(safe.params.browser.active, true);
});

test("routes only reviewed interactive server requests to the browser", () => {
  assert.equal(codexServerRequestDisposition("item/tool/requestUserInput"), "browser");
  assert.equal(codexServerRequestDisposition("item/permissions/requestApproval"), "browser");
  assert.equal(codexServerRequestDisposition("currentTime/read"), "internal");
  assert.equal(codexServerRequestDisposition("item/tool/call"), "reject");
  assert.equal(codexServerRequestDisposition("future/unknown"), "reject");
  assert.equal(isKnownCodexServerRequest("attestation/generate"), true);
  assert.equal(isKnownCodexServerRequest("future/unknown"), false);
});

test("answers current time internally with whole Unix seconds", () => {
  assert.deepEqual(
    internalCodexServerRequestResponse(
      { method: "currentTime/read", params: { threadId: "thread-1" } },
      { now: () => 1_752_345_678_999 },
    ),
    { currentTimeAt: 1_752_345_678 },
  );
  assert.equal(internalCodexServerRequestResponse({ method: "future/unknown" }), null);
});

test("bounds reviewed browser request payloads and refuses non-browser requests", () => {
  const request = publicCodexServerRequest({
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      questions: [{ id: "q1", question: "Continue?", options: null }],
    },
  });
  assert.deepEqual(request, {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      questions: [{ id: "q1", question: "Continue?", options: null }],
    },
  });
  assert.equal(publicCodexServerRequest({ id: 8, method: "item/tool/call", params: {} }), null);
  assert.throws(
    () => publicCodexServerRequest({
      id: 9,
      method: "item/tool/requestUserInput",
      params: { value: "x".repeat(300_000) },
    }),
    /过大/,
  );
});

test("uses protocol-shaped safe rejections for dynamic and legacy requests", () => {
  assert.deepEqual(safeCodexServerRequestRejection("item/tool/call"), {
    success: false,
    contentItems: [{ type: "inputText", text: "当前 WFL Codex Web Workspace 未启用此动态工具。" }],
  });
  assert.deepEqual(
    safeCodexServerRequestRejection("item/permissions/requestApproval"),
    { permissions: {}, scope: "turn" },
  );
  assert.deepEqual(
    safeCodexServerRequestRejection("execCommandApproval"),
    { decision: { denied: { rejection: "当前客户端未启用此旧版请求。" } } },
  );
  assert.deepEqual(rejectedCodexServerRequest("account/chatgptAuthTokens/refresh"), {
    error: {
      code: -32601,
      message: "WFL Codex Web Workspace does not use externally managed ChatGPT tokens.",
    },
  });
  assert.deepEqual(rejectedCodexServerRequest("future/unknown"), {
    error: {
      code: -32601,
      message: "Unsupported Codex server request.",
    },
  });
});

test("normalizes MCP elicitation responses to action and content", () => {
  assert.deepEqual(
    normalizeCodexServerRequestResponse("mcpServer/elicitation/request", {
      action: "accept",
      content: { region: "cn", retries: 2 },
    }),
    { action: "accept", content: { region: "cn", retries: 2 } },
  );
  assert.deepEqual(
    normalizeCodexServerRequestResponse("mcpServer/elicitation/request", {
      action: "decline",
      content: { ignored: true },
    }),
    { action: "decline", content: null },
  );
  assert.throws(
    () => normalizeCodexServerRequestResponse("mcpServer/elicitation/request", { decision: "accept" }),
    /操作无效/,
  );
});

test("honors command decisions exposed by Codex and preserves callback identity", () => {
  const request = publicCodexServerRequest({
    id: "request-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      approvalId: "callback-1",
      command: "npm test",
      cwd: "/srv/project",
      availableDecisions: ["decline", "accept"],
    },
  });
  assert.equal(request.params.approvalId, "callback-1");
  assert.deepEqual(request.params.availableDecisions, ["decline", "accept"]);
  assert.deepEqual(
    normalizeCodexServerRequestResponse(
      request.method,
      { decision: "accept" },
      request.params,
    ),
    { decision: "accept" },
  );
  assert.throws(
    () => normalizeCodexServerRequestResponse(
      request.method,
      { decision: "acceptForSession" },
      request.params,
    ),
    /未由 Codex 提供/,
  );
});

test("permission grants cannot exceed the paths and network access requested by Codex", () => {
  const params = {
    permissions: {
      network: { enabled: true },
      fileSystem: {
        read: ["/srv/project/input.txt"],
        write: ["/srv/project/output.txt"],
        entries: [],
      },
    },
  };
  assert.deepEqual(
    normalizeCodexServerRequestResponse(
      "item/permissions/requestApproval",
      {
        permissions: {
          network: { enabled: true },
          fileSystem: { write: ["/srv/project/output.txt"] },
        },
        scope: "session",
        strictAutoReview: true,
      },
      params,
    ),
    {
      permissions: {
        network: { enabled: true },
        fileSystem: { write: ["/srv/project/output.txt"] },
      },
      scope: "session",
      strictAutoReview: true,
    },
  );
  assert.throws(
    () => normalizeCodexServerRequestResponse(
      "item/permissions/requestApproval",
      {
        permissions: { fileSystem: { write: ["/etc/passwd"] } },
        scope: "turn",
      },
      params,
    ),
    /超出 Codex 请求范围/,
  );
});
