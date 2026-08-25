const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;
const APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);
const HTTP_AUTH_MODES = new Set(["oauth", "chatgpt"]);
const ENV_SOURCES = new Set(["local", "remote"]);
const KNOWN_CONFIG_KEYS = new Set([
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
  "experimental_environment",
  "url",
  "auth",
  "bearer_token_env_var",
  "http_headers",
  "env_http_headers",
  "oauth_resource",
  "scopes",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "enabled",
  "required",
  "enabled_tools",
  "disabled_tools",
  "default_tools_approval_mode",
  "tools",
]);

export function normalizeCodexMcpServerName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error("MCP 名称需为 1–64 位字母、数字、下划线或连字符，并以字母或数字开头");
  }
  return name;
}

export function userCodexMcpServers(configRead) {
  const layers = Array.isArray(configRead?.layers) ? configRead.layers : [];
  const userLayer = layers.find((layer) => (
    layer?.name?.type === "user"
    && layer.name.profile == null
    && isRecord(layer.config)
  ));
  const value = userLayer?.config?.mcp_servers;
  return {
    servers: isRecord(value) ? structuredClone(value) : {},
    version: typeof userLayer?.version === "string" ? userLayer.version : null,
    filePath: typeof userLayer?.name?.file === "string" ? userLayer.name.file : null,
  };
}

export function publicCodexMcpServerConfig(name, nativeConfig) {
  const config = isRecord(nativeConfig) ? nativeConfig : {};
  const transport = typeof config.command === "string"
    ? "stdio"
    : typeof config.url === "string" ? "http" : "invalid";
  return {
    name: normalizeCodexMcpServerName(name),
    transport,
    command: stringOrEmpty(config.command),
    args: stringArray(config.args, { limit: 64, itemLimit: 2_048, label: "MCP 参数" }),
    cwd: stringOrEmpty(config.cwd),
    env: maskedSecretEntries(config.env, ENV_NAME_PATTERN),
    envVars: publicEnvVars(config.env_vars),
    experimentalEnvironment: ["local", "remote"].includes(config.experimental_environment)
      ? config.experimental_environment
      : null,
    url: stringOrEmpty(config.url),
    auth: HTTP_AUTH_MODES.has(config.auth) ? config.auth : "oauth",
    bearerTokenEnvVar: ENV_NAME_PATTERN.test(config.bearer_token_env_var || "")
      ? config.bearer_token_env_var
      : "",
    httpHeaders: maskedSecretEntries(config.http_headers, HEADER_NAME_PATTERN),
    envHttpHeaders: publicStringEntries(config.env_http_headers, HEADER_NAME_PATTERN, ENV_NAME_PATTERN),
    oauthResource: stringOrEmpty(config.oauth_resource),
    scopes: stringArray(config.scopes, { limit: 64, itemLimit: 256, label: "OAuth scopes" }),
    startupTimeoutSec: boundedExistingNumber(config.startup_timeout_sec, 10),
    toolTimeoutSec: boundedExistingNumber(config.tool_timeout_sec, 60),
    enabled: config.enabled !== false,
    required: config.required === true,
    enabledTools: stringArray(config.enabled_tools, { limit: 256, itemLimit: 256, label: "工具白名单" }),
    disabledTools: stringArray(config.disabled_tools, { limit: 256, itemLimit: 256, label: "工具黑名单" }),
    defaultToolsApprovalMode: APPROVAL_MODES.has(config.default_tools_approval_mode)
      ? config.default_tools_approval_mode
      : "auto",
    toolApprovals: publicToolApprovals(config.tools),
  };
}

export function normalizeCodexMcpServerDraft(draft, existingNative = {}) {
  if (!isRecord(draft)) throw new Error("MCP 配置无效");
  const existing = isRecord(existingNative) ? existingNative : {};
  const transport = draft.transport === "http" ? "http" : draft.transport === "stdio" ? "stdio" : null;
  if (!transport) throw new Error("请选择 STDIO 或 Streamable HTTP");

  const preserved = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !KNOWN_CONFIG_KEYS.has(key)),
  );
  const common = {
    ...preserved,
    enabled: booleanValue(draft.enabled, true),
    required: booleanValue(draft.required, false),
    startup_timeout_sec: boundedNumber(draft.startupTimeoutSec, 1, 300, 10, "启动超时"),
    tool_timeout_sec: boundedNumber(draft.toolTimeoutSec, 1, 3_600, 60, "工具超时"),
    default_tools_approval_mode: approvalMode(draft.defaultToolsApprovalMode),
  };
  const enabledTools = toolNameArray(draft.enabledTools, "工具白名单");
  const disabledTools = toolNameArray(draft.disabledTools, "工具黑名单");
  const tools = normalizeToolApprovals(draft.toolApprovals);
  if (enabledTools.length) common.enabled_tools = enabledTools;
  if (disabledTools.length) common.disabled_tools = disabledTools;
  if (Object.keys(tools).length) common.tools = tools;

  if (transport === "stdio") {
    const command = boundedString(draft.command, 1, 2_048, "STDIO 启动命令");
    const args = stringArray(draft.args, { limit: 64, itemLimit: 2_048, label: "MCP 参数" });
    const cwd = optionalBoundedString(draft.cwd, 4_096, "MCP 工作目录");
    const env = normalizeSecretEntries(draft.env, existing.env, ENV_NAME_PATTERN, "环境变量");
    const envVars = normalizeEnvVars(draft.envVars);
    const experimentalEnvironment = draft.experimentalEnvironment == null || draft.experimentalEnvironment === ""
      ? null
      : String(draft.experimentalEnvironment);
    if (experimentalEnvironment && !["local", "remote"].includes(experimentalEnvironment)) {
      throw new Error("STDIO 运行环境无效");
    }
    return compactObject({
      ...common,
      command,
      args: args.length ? args : undefined,
      cwd: cwd || undefined,
      env: Object.keys(env).length ? env : undefined,
      env_vars: envVars.length ? envVars : undefined,
      experimental_environment: experimentalEnvironment || undefined,
    });
  }

  const url = normalizeHttpUrl(draft.url);
  const auth = draft.auth == null || draft.auth === "" ? "oauth" : String(draft.auth);
  if (!HTTP_AUTH_MODES.has(auth)) throw new Error("HTTP 认证模式无效");
  const bearerTokenEnvVar = optionalEnvName(draft.bearerTokenEnvVar, "Bearer Token 环境变量");
  const httpHeaders = normalizeSecretEntries(
    draft.httpHeaders,
    existing.http_headers,
    HEADER_NAME_PATTERN,
    "HTTP 请求头",
  );
  const envHttpHeaders = normalizeStringEntries(
    draft.envHttpHeaders,
    HEADER_NAME_PATTERN,
    ENV_NAME_PATTERN,
    "环境请求头",
  );
  const oauthResource = optionalBoundedString(draft.oauthResource, 2_048, "OAuth resource");
  const scopes = stringArray(draft.scopes, { limit: 64, itemLimit: 256, label: "OAuth scopes" });
  return compactObject({
    ...common,
    url,
    auth,
    bearer_token_env_var: bearerTokenEnvVar || undefined,
    http_headers: Object.keys(httpHeaders).length ? httpHeaders : undefined,
    env_http_headers: Object.keys(envHttpHeaders).length ? envHttpHeaders : undefined,
    oauth_resource: oauthResource || undefined,
    scopes: scopes.length ? scopes : undefined,
  });
}

export function redactCodexMcpSecretsFromConfigRead(configRead) {
  if (!isRecord(configRead)) return configRead;
  const redacted = structuredClone(configRead);
  redactConfigMcpSecrets(redacted.config);
  for (const layer of Array.isArray(redacted.layers) ? redacted.layers : []) {
    redactConfigMcpSecrets(layer?.config);
  }
  return redacted;
}

function redactConfigMcpSecrets(config) {
  if (!isRecord(config?.mcp_servers)) return;
  for (const server of Object.values(config.mcp_servers)) {
    if (!isRecord(server)) continue;
    for (const key of ["env", "http_headers"]) {
      if (!isRecord(server[key])) continue;
      server[key] = Object.fromEntries(
        Object.keys(server[key]).slice(0, 128).map((name) => [name, "__configured__"]),
      );
    }
  }
}

function publicEnvVars(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((entry) => {
    if (typeof entry === "string" && ENV_NAME_PATTERN.test(entry)) {
      return [{ name: entry, source: "local" }];
    }
    if (!isRecord(entry) || !ENV_NAME_PATTERN.test(entry.name || "")) return [];
    return [{ name: entry.name, source: ENV_SOURCES.has(entry.source) ? entry.source : "local" }];
  });
}

function normalizeEnvVars(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error("环境变量转发列表无效");
  const output = [];
  for (const entry of value) {
    const candidate = typeof entry === "string" ? { name: entry, source: "local" } : entry;
    if (!isRecord(candidate) || !ENV_NAME_PATTERN.test(candidate.name || "")) {
      throw new Error("环境变量转发名称无效");
    }
    const source = candidate.source == null ? "local" : String(candidate.source);
    if (!ENV_SOURCES.has(source)) throw new Error("环境变量来源无效");
    const normalized = source === "local" ? candidate.name : { name: candidate.name, source };
    const key = typeof normalized === "string" ? `local:${normalized}` : `${normalized.source}:${normalized.name}`;
    if (!output.some((item) => (
      (typeof item === "string" ? `local:${item}` : `${item.source}:${item.name}`) === key
    ))) output.push(normalized);
  }
  return output;
}

function maskedSecretEntries(value, namePattern) {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((name) => namePattern.test(name))
    .sort()
    .slice(0, 128)
    .map((name) => ({ name, configured: true }));
}

function publicStringEntries(value, keyPattern, valuePattern) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([name, entryValue]) => keyPattern.test(name) && valuePattern.test(entryValue || ""))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 128)
    .map(([name, entryValue]) => ({ name, value: entryValue }));
}

function normalizeSecretEntries(value, existing, namePattern, label) {
  if (value == null) return {};
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${label}列表无效`);
  const existingMap = isRecord(existing) ? existing : {};
  const output = {};
  for (const entry of value) {
    if (!isRecord(entry) || !namePattern.test(entry.name || "")) throw new Error(`${label}名称无效`);
    const name = entry.name;
    if (Object.hasOwn(output, name)) throw new Error(`${label}名称重复：${name}`);
    if (entry.keep === true || entry.value == null || entry.value === "") {
      if (typeof existingMap[name] !== "string") throw new Error(`${label} ${name} 尚未设置值`);
      output[name] = existingMap[name];
      continue;
    }
    output[name] = boundedString(entry.value, 1, 8_192, `${label} ${name}`);
  }
  return output;
}

function normalizeStringEntries(value, keyPattern, valuePattern, label) {
  if (value == null) return {};
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${label}列表无效`);
  const output = {};
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !keyPattern.test(entry.name || "")
      || !valuePattern.test(entry.value || "")
    ) throw new Error(`${label}内容无效`);
    if (Object.hasOwn(output, entry.name)) throw new Error(`${label}名称重复：${entry.name}`);
    output[entry.name] = entry.value;
  }
  return output;
}

function publicToolApprovals(value) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([name, config]) => TOOL_NAME_PATTERN.test(name) && APPROVAL_MODES.has(config?.approval_mode))
    .slice(0, 256)
    .map(([name, config]) => ({ name, approvalMode: config.approval_mode }));
}

function normalizeToolApprovals(value) {
  if (value == null) return {};
  if (!Array.isArray(value) || value.length > 256) throw new Error("单工具审批策略无效");
  const output = {};
  for (const entry of value) {
    if (!isRecord(entry) || !TOOL_NAME_PATTERN.test(entry.name || "")) {
      throw new Error("单工具审批策略的工具名称无效");
    }
    if (Object.hasOwn(output, entry.name)) throw new Error(`工具审批策略重复：${entry.name}`);
    output[entry.name] = { approval_mode: approvalMode(entry.approvalMode) };
  }
  return output;
}

function toolNameArray(value, label) {
  const values = stringArray(value, { limit: 256, itemLimit: 256, label });
  if (values.some((entry) => !TOOL_NAME_PATTERN.test(entry))) throw new Error(`${label}包含无效工具名称`);
  return values;
}

function stringArray(value, { limit, itemLimit, label }) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}无效`);
  const output = [];
  for (const item of value) {
    const normalized = boundedString(item, 1, itemLimit, label);
    if (!output.includes(normalized)) output.push(normalized);
  }
  return output;
}

function normalizeHttpUrl(value) {
  const raw = boundedString(value, 1, 2_048, "MCP HTTP 地址");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP HTTP 地址无效");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("MCP HTTP 地址必须使用 http/https，且不能在 URL 中包含账号或密码");
  }
  return url.toString();
}

function optionalEnvName(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "";
  if (!ENV_NAME_PATTERN.test(normalized)) throw new Error(`${label}无效`);
  return normalized;
}

function approvalMode(value) {
  const normalized = value == null || value === "" ? "auto" : String(value);
  if (!APPROVAL_MODES.has(normalized)) throw new Error("工具审批模式无效");
  return normalized;
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value, minimum, maximum, fallback, label) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}必须是 ${minimum}–${maximum} 的整数`);
  }
  return number;
}

function boundedExistingNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionalBoundedString(value, maximum, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? boundedString(normalized, 1, maximum, label) : "";
}

function boundedString(value, minimum, maximum, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000\r\n]/.test(normalized) && label !== "MCP 参数"
  ) throw new Error(`${label}无效`);
  return normalized;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
