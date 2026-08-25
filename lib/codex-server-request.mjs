const MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";
const MCP_ACTIONS = new Set(["accept", "decline", "cancel"]);
const COMMAND_APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const FILE_APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const MAX_SAFE_JSON_BYTES = 256 * 1024;
const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;
const BROWSER_SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  MCP_ELICITATION_METHOD,
  "item/permissions/requestApproval",
]);
const KNOWN_SERVER_REQUEST_METHODS = new Set([
  ...BROWSER_SERVER_REQUEST_METHODS,
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
]);

export function codexServerRequestDisposition(method) {
  if (method === "currentTime/read") return "internal";
  if (BROWSER_SERVER_REQUEST_METHODS.has(method)) return "browser";
  return "reject";
}

export function isKnownCodexServerRequest(method) {
  return KNOWN_SERVER_REQUEST_METHODS.has(method);
}

export function codexServerRequestAutoResolutionMs(payload) {
  if (payload?.method !== "item/tool/requestUserInput") return null;
  const value = payload.params?.autoResolutionMs;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(MAX_AUTO_RESOLUTION_MS, Math.max(MIN_AUTO_RESOLUTION_MS, value));
}

export function internalCodexServerRequestResponse(payload, { now = Date.now } = {}) {
  if (payload?.method !== "currentTime/read") return null;
  return { currentTimeAt: Math.floor(now() / 1000) };
}

export function isCodexMcpElicitation(payload) {
  return payload?.method === MCP_ELICITATION_METHOD;
}

export function codexMcpElicitationBrowserRequest(payload) {
  if (!isCodexMcpElicitation(payload) || payload.params?.mode !== "url") return null;
  const authUrl = typeof payload.params.url === "string" ? payload.params.url.trim() : "";
  if (!authUrl) return null;
  return {
    userFacingId: String(payload.id ?? ""),
    authUrl,
  };
}

export function publicCodexMcpElicitation(payload, { browser = null, browserError = null } = {}) {
  if (!isCodexMcpElicitation(payload)) return payload;
  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const safeParams = {
    threadId: boundedString(params.threadId, 256),
    turnId: boundedString(params.turnId, 256) || null,
    serverName: boundedString(params.serverName, 256) || "MCP",
    mode: ["form", "openai/form", "url"].includes(params.mode) ? params.mode : "unknown",
    message: boundedString(params.message, 8_000) || "MCP 服务器请求输入",
  };
  if (typeof params.elicitationId === "string") {
    safeParams.elicitationId = boundedString(params.elicitationId, 256);
  }
  if (params.mode !== "url") {
    safeParams.requestedSchema = boundedJsonClone(params.requestedSchema);
  }
  if (browser?.active) safeParams.browser = browser;
  else if (browserError) safeParams.browserError = boundedString(browserError, 1_000);
  return { id: payload.id, method: MCP_ELICITATION_METHOD, params: safeParams };
}

export function publicCodexServerRequest(payload, { browser = null, browserError = null } = {}) {
  if (!BROWSER_SERVER_REQUEST_METHODS.has(payload?.method)) return null;
  if (isCodexMcpElicitation(payload)) {
    return publicCodexMcpElicitation(payload, { browser, browserError });
  }
  return {
    id: payload.id,
    method: payload.method,
    params: publicInteractiveRequestParams(payload.method, payload.params),
  };
}

export function normalizeCodexServerRequestResponse(method, result, requestParams = {}) {
  if (method === MCP_ELICITATION_METHOD) {
    const action = typeof result?.action === "string" ? result.action : "";
    if (!MCP_ACTIONS.has(action)) throw new Error("MCP 请求响应操作无效");
    if (action !== "accept") return { action, content: null };
    if (!result.content || typeof result.content !== "object" || Array.isArray(result.content)) {
      throw new Error("MCP 表单提交内容必须是对象");
    }
    return { action, content: boundedJsonClone(result.content) };
  }
  if (method === "item/commandExecution/requestApproval") {
    return normalizeCommandApprovalResponse(result, requestParams);
  }
  if (method === "item/fileChange/requestApproval") {
    const decision = typeof result?.decision === "string" ? result.decision : "";
    if (!FILE_APPROVAL_DECISIONS.has(decision)) throw new Error("文件修改审批决定无效");
    return { decision };
  }
  if (method === "item/permissions/requestApproval") {
    const scope = result?.scope;
    if (!["turn", "session"].includes(scope)) throw new Error("权限批准范围无效");
    const response = {
      permissions: normalizeGrantedPermissionProfile(result?.permissions, requestParams.permissions),
      scope,
    };
    if (result?.strictAutoReview !== undefined) {
      if (typeof result.strictAutoReview !== "boolean") throw new Error("权限自动审查选项无效");
      response.strictAutoReview = result.strictAutoReview;
    }
    return response;
  }
  return boundedJsonClone(result);
}

export function rejectedCodexServerRequest(method) {
  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      error: {
        code: -32601,
        message: "WFL Codex Web Workspace does not use externally managed ChatGPT tokens.",
      },
    };
  }
  if (method === "attestation/generate") {
    return {
      error: {
        code: -32601,
        message: "Client attestation was not enabled during initialization.",
      },
    };
  }
  if (!isKnownCodexServerRequest(method) || method === "currentTime/read") {
    return {
      error: {
        code: -32601,
        message: "Unsupported Codex server request.",
      },
    };
  }
  return { result: safeCodexServerRequestRejection(method) };
}

export function safeCodexServerRequestRejection(method) {
  if (method === MCP_ELICITATION_METHOD) return { action: "cancel", content: null };
  if (method === "item/tool/call") {
    return {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "当前 WFL Codex Web Workspace 未启用此动态工具。",
      }],
    };
  }
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    return { decision: "decline" };
  }
  if (["applyPatchApproval", "execCommandApproval"].includes(method)) {
    return { decision: { denied: { rejection: "当前客户端未启用此旧版请求。" } } };
  }
  return { decision: "decline" };
}

function boundedString(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function publicInteractiveRequestParams(method, value) {
  const params = boundedJsonClone(value);
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  if (method === "item/commandExecution/requestApproval") {
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
        .slice(0, 16)
        .filter(isCommandApprovalDecision)
      : null;
    return {
      ...params,
      ...(availableDecisions ? { availableDecisions } : {}),
      approvalId: boundedNullableString(params.approvalId, 256),
      reason: boundedNullableString(params.reason, 8_000),
      command: boundedNullableString(params.command, 64_000),
      cwd: boundedNullableString(params.cwd, 4_096),
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      ...params,
      reason: boundedNullableString(params.reason, 8_000),
      grantRoot: boundedNullableString(params.grantRoot, 4_096),
    };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      ...params,
      cwd: boundedString(params.cwd, 4_096),
      reason: boundedNullableString(params.reason, 8_000),
      permissions: normalizeRequestedPermissionProfile(params.permissions),
    };
  }
  return params;
}

function normalizeCommandApprovalResponse(result, requestParams) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("命令审批响应无效");
  }
  const decision = boundedJsonClone(result.decision);
  if (!isCommandApprovalDecision(decision)) throw new Error("命令审批决定无效");
  const available = Array.isArray(requestParams?.availableDecisions)
    ? requestParams.availableDecisions.filter(isCommandApprovalDecision)
    : null;
  if (available?.length && !available.some((entry) => sameJson(entry, decision))) {
    throw new Error("该命令审批决定未由 Codex 提供");
  }
  return { decision };
}

function isCommandApprovalDecision(value) {
  if (typeof value === "string") return COMMAND_APPROVAL_DECISIONS.has(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 1) return false;
  if (value.acceptWithExecpolicyAmendment) {
    const amendment = value.acceptWithExecpolicyAmendment.execpolicy_amendment;
    return Array.isArray(amendment)
      && amendment.length <= 64
      && amendment.every((entry) => typeof entry === "string" && entry.length <= 8_000);
  }
  const amendment = value.applyNetworkPolicyAmendment?.network_policy_amendment;
  return Boolean(
    amendment
    && typeof amendment === "object"
    && !Array.isArray(amendment)
    && typeof amendment.host === "string"
    && amendment.host.length <= 1_024
    && ["allow", "deny"].includes(amendment.action),
  );
}

function normalizeRequestedPermissionProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { network: null, fileSystem: null };
  }
  return {
    network: value.network == null ? null : boundedJsonClone(value.network),
    fileSystem: value.fileSystem == null ? null : boundedJsonClone(value.fileSystem),
  };
}

function normalizeGrantedPermissionProfile(value, requested) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("批准的权限格式无效");
  const allowedKeys = new Set(["network", "fileSystem"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("批准的权限包含未知字段");
  const result = {};
  if (value.network !== undefined) {
    if (!requested?.network || !value.network || typeof value.network !== "object" || Array.isArray(value.network)) {
      throw new Error("不能批准 Codex 未请求的网络权限");
    }
    if (Object.keys(value.network).some((key) => key !== "enabled")) {
      throw new Error("批准的网络权限包含未知字段");
    }
    if (value.network.enabled !== requested.network.enabled) {
      throw new Error("批准的网络权限超出 Codex 请求范围");
    }
    result.network = { enabled: value.network.enabled };
  }
  if (value.fileSystem !== undefined) {
    result.fileSystem = normalizeGrantedFileSystem(value.fileSystem, requested?.fileSystem);
  }
  return result;
}

function normalizeGrantedFileSystem(value, requested) {
  if (!requested || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("不能批准 Codex 未请求的文件权限");
  }
  const allowedKeys = new Set(["read", "write", "globScanMaxDepth", "entries"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("批准的文件权限包含未知字段");
  }
  const result = {};
  for (const key of ["read", "write"]) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || !Array.isArray(requested[key])) {
      throw new Error("批准的文件路径格式无效");
    }
    const requestedPaths = new Set(requested[key]);
    if (value[key].some((entry) => typeof entry !== "string" || !requestedPaths.has(entry))) {
      throw new Error("批准的文件路径超出 Codex 请求范围");
    }
    result[key] = [...new Set(value[key])];
  }
  if (value.globScanMaxDepth !== undefined) {
    if (
      !Number.isSafeInteger(value.globScanMaxDepth)
      || !Number.isSafeInteger(requested.globScanMaxDepth)
      || value.globScanMaxDepth < 1
      || value.globScanMaxDepth > requested.globScanMaxDepth
    ) {
      throw new Error("批准的文件扫描深度超出 Codex 请求范围");
    }
    result.globScanMaxDepth = value.globScanMaxDepth;
  }
  if (value.entries !== undefined) {
    if (!Array.isArray(value.entries) || !Array.isArray(requested.entries)) {
      throw new Error("批准的文件权限条目格式无效");
    }
    const requestedEntries = new Set(requested.entries.map(stableJson));
    if (value.entries.some((entry) => !requestedEntries.has(stableJson(entry)))) {
      throw new Error("批准的文件权限条目超出 Codex 请求范围");
    }
    result.entries = boundedJsonClone(value.entries);
  }
  return result;
}

function boundedNullableString(value, limit) {
  if (value == null) return null;
  return boundedString(value, limit);
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function boundedJsonClone(value) {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_SAFE_JSON_BYTES) {
    throw new Error("MCP 表单内容过大");
  }
  return JSON.parse(text);
}
