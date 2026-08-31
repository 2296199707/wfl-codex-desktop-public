#!/usr/bin/env node
import net from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
const CAPABILITY_POLL_INTERVAL_MS = 3_000;
const TOOL_TIMEOUT_MS = 130_000;
const socketPath = parseSocketPath(process.argv.slice(2));
let buffer = "";
let initialized = false;
let capabilityFingerprint = null;
let capabilityPoll = null;
let capabilityPollRunning = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handleLine(line);
    newline = buffer.indexOf("\n");
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "notifications/initialized") {
      initialized = true;
      startCapabilityPolling();
    }
    return;
  }
  try {
    if (message.method === "initialize") {
      const capabilities = await requestBroker({ version: 1, action: "capabilities" })
        .catch(() => ({ enabled: false, activeCount: 0 }));
      capabilityFingerprint = fingerprintCapabilities(capabilities);
      writeResult(message.id, {
        protocolVersion: supportedProtocolVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: "wfl-temporary-ssh",
          title: "WFL 临时 SSH 接管",
          version: "1.2.0",
        },
        instructions: "仅在管理员已启用 WFL 临时 SSH 插件且存在活动授权时使用；授权会自动过期或被管理员撤销。不要读取、传递或记录 SSH 密码和私钥。",
      });
      startCapabilityPolling();
      return;
    }
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    if (message.method === "tools/list") {
      const capabilities = await requestBroker({ version: 1, action: "capabilities" });
      capabilityFingerprint = fingerprintCapabilities(capabilities);
      writeResult(message.id, { tools: capabilities.enabled ? toolDefinitions() : [] });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (name !== "list_temporary_ssh_access" && name !== "run_temporary_ssh_command") {
        writeResult(message.id, toolError("未知的临时 SSH 工具"));
        return;
      }
      const capabilities = await requestBroker({ version: 1, action: "capabilities" });
      if (!capabilities.enabled) {
        writeResult(message.id, toolError("临时 SSH 插件未安装、启用或当前账号不是管理员"));
        return;
      }
      if (name === "list_temporary_ssh_access") {
        const accesses = await requestBroker({ version: 1, action: "list" });
        writeResult(message.id, {
          content: [{
            type: "text",
            text: accesses.length
              ? accesses.map((access) => `${access.target} · ${access.id} · 到期 ${new Date(access.expiresAt).toISOString()}`).join("\n")
              : "当前没有活动的临时 SSH 授权。",
          }],
          structuredContent: { accesses },
          isError: false,
        });
        return;
      }
      const argumentsValue = message.params?.arguments;
      const result = await requestBroker({
        version: 1,
        action: "execute",
        accessId: argumentsValue?.accessId,
        command: argumentsValue?.command,
        timeoutMs: argumentsValue?.timeoutMs,
      });
      writeResult(message.id, {
        content: [{ type: "text", text: formatCommandResult(result) }],
        structuredContent: result,
        isError: false,
      });
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError(error?.message));
    else writeError(message.id, -32603, String(error?.message || "Internal error").slice(0, 2_000));
  }
}

function startCapabilityPolling() {
  if (capabilityPoll) return;
  capabilityPoll = setInterval(() => void pollCapabilities(), CAPABILITY_POLL_INTERVAL_MS);
  capabilityPoll.unref?.();
}

async function pollCapabilities() {
  if (!initialized || capabilityPollRunning) return;
  capabilityPollRunning = true;
  try {
    const capabilities = await requestBroker({ version: 1, action: "capabilities" });
    const nextFingerprint = fingerprintCapabilities(capabilities);
    if (capabilityFingerprint !== null && nextFingerprint !== capabilityFingerprint) {
      capabilityFingerprint = nextFingerprint;
      writeNotification("notifications/tools/list_changed", {});
      return;
    }
    capabilityFingerprint = nextFingerprint;
  } catch {
    // The next successful poll refreshes the advertised tools.
  } finally {
    capabilityPollRunning = false;
  }
}

function toolDefinitions() {
  return [
    {
      name: "list_temporary_ssh_access",
      title: "列出活动临时 SSH 授权",
      description: "列出当前管理员账号可使用的临时 SSH 授权。先调用此工具获得 accessId；授权不会返回密码、私钥或本机凭据路径。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "run_temporary_ssh_command",
      title: "执行临时 SSH 命令",
      description: "在管理员通过 WFL 临时 SSH 插件创建的活动授权上执行一条非交互式远程命令。授权过期或被撤销后立即失效。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accessId: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^ssh-[a-f0-9]{16}$",
            description: "list_temporary_ssh_access 返回的临时授权 ID。",
          },
          command: {
            type: "string",
            minLength: 1,
            maxLength: 32768,
            description: "要在远程服务器执行的非交互式命令；不能包含换行或控制字符。",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1000,
            maximum: 120000,
            description: "可选命令超时时间，默认 60000 毫秒。",
          },
        },
        required: ["accessId", "command"],
      },
    },
  ];
}

function formatCommandResult(result) {
  return [
    `目标：${result.target || result.id}`,
    `退出码：${result.exitCode === null ? "未返回" : result.exitCode}`,
    result.stdout ? `标准输出：\n${result.stdout}` : null,
    result.stderr ? `错误输出：\n${result.stderr}` : null,
    result.truncated ? "输出已达到上限，远程命令已中止。" : null,
  ].filter(Boolean).join("\n");
}

function requestBroker(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(TOOL_TIMEOUT_MS);
    let responseBuffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      responseBuffer += chunk;
      if (Buffer.byteLength(responseBuffer) > 2 * 1024 * 1024) {
        finish(new Error("临时 SSH 工具响应过大"));
        return;
      }
      const newline = responseBuffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(responseBuffer.slice(0, newline));
      } catch {
        finish(new Error("临时 SSH 工具返回了无效响应"));
        return;
      }
      if (!response?.ok) finish(Object.assign(new Error(String(response?.error || "临时 SSH 工具调用失败")), {
        statusCode: Number(response?.statusCode) || 500,
      }));
      else finish(null, response.result);
    });
    socket.on("timeout", () => finish(new Error("临时 SSH 工具调用超时")));
    socket.on("error", () => finish(new Error("临时 SSH 服务当前不可用")));
    socket.on("end", () => {
      if (!settled) finish(new Error("临时 SSH 服务提前断开"));
    });
  });
}

function toolError(message) {
  const text = String(message || "临时 SSH 工具调用失败").slice(0, 2_000);
  return {
    content: [{ type: "text", text }],
    structuredContent: { error: text },
    isError: true,
  };
}

function fingerprintCapabilities(value) {
  return JSON.stringify(value || { enabled: false, activeCount: 0 });
}

function supportedProtocolVersion(value) {
  return ["2024-11-05", "2025-03-26", PROTOCOL_VERSION].includes(value)
    ? value
    : PROTOCOL_VERSION;
}

function parseSocketPath(args) {
  const index = args.indexOf("--socket");
  const value = index === -1 ? "" : String(args[index + 1] || "");
  if (!value.startsWith("/") || value.length > 4_096 || /[\u0000\r\n]/.test(value)) {
    process.stderr.write("WFL temporary SSH MCP requires an absolute --socket path\n");
    process.exit(2);
  }
  return value;
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function writeNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
