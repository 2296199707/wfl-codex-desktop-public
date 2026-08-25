#!/usr/bin/env node
import net from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
const socketPath = parseSocketPath(process.argv.slice(2));
let buffer = "";

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
  if (!Object.hasOwn(message, "id")) return;
  try {
    if (message.method === "initialize") {
      writeResult(message.id, {
        protocolVersion: supportedProtocolVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "wfl-persistent-ssh",
          title: "WFL 持久 SSH",
          version: "1.1.1",
        },
        instructions: "只使用当前账号已启用的 SSH 服务器；服务器关闭后不要尝试绕过开关或读取其凭据。",
      });
      return;
    }
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    if (message.method === "tools/list") {
      writeResult(message.id, { tools: [listToolDefinition(), executeToolDefinition()] });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (name === "list_ssh_servers") {
        const result = await requestBroker({ version: 1, action: "list" });
        writeResult(message.id, {
          content: [{
            type: "text",
            text: result.length
              ? result.map((server) => `${server.name} · ${server.id}`).join("\n")
              : "当前没有已启用的 SSH 服务器。",
          }],
          structuredContent: { servers: result },
          isError: false,
        });
        return;
      }
      if (name === "run_ssh_command") {
        const result = await requestBroker({
          version: 1,
          action: "execute",
          serverId: message.params?.arguments?.serverId,
          command: message.params?.arguments?.command,
          timeoutMs: message.params?.arguments?.timeoutMs,
        });
        writeResult(message.id, {
          content: [{
            type: "text",
            text: [
              `服务器：${result.name || result.id}`,
              `退出码：${result.exitCode === null ? "未返回" : result.exitCode}`,
              result.stdout ? `标准输出：\n${result.stdout}` : null,
              result.stderr ? `错误输出：\n${result.stderr}` : null,
              result.truncated ? "输出已达到安全上限并中止。" : null,
            ].filter(Boolean).join("\n"),
          }],
          structuredContent: result,
          isError: false,
        });
        return;
      }
      writeResult(message.id, toolError("未知的持久 SSH 工具"));
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError(error.message));
    else writeError(message.id, -32603, String(error?.message || "Internal error").slice(0, 2_000));
  }
}

function listToolDefinition() {
  return {
    name: "list_ssh_servers",
    title: "列出已启用 SSH 服务器",
    description: "列出当前账号已启用的持久 SSH 服务器。关闭的服务器不会出现在结果中，也不能通过本工具访问。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  };
}

function executeToolDefinition() {
  return {
    name: "run_ssh_command",
    title: "运行远程 SSH 命令",
    description: "在用户已启用的持久 SSH 服务器上运行一条非交互式命令。服务器 ID 必须来自 list_ssh_servers；不能绕过关闭开关。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        serverId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "list_ssh_servers 返回的内部服务器 ID。",
        },
        command: {
          type: "string",
          minLength: 1,
          maxLength: 32768,
          description: "单行非交互式远程命令；不要包含换行或控制字符。",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "可选超时时间，默认 60000 毫秒。",
        },
      },
      required: ["serverId", "command"],
    },
  };
}

function requestBroker(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(130_000);
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
        finish(new Error("SSH 工具响应过大"));
        return;
      }
      const newline = responseBuffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(responseBuffer.slice(0, newline));
      } catch {
        finish(new Error("SSH 工具返回了无效响应"));
        return;
      }
      if (!response?.ok) finish(new Error(String(response?.error || "SSH 工具调用失败")));
      else finish(null, response.result);
    });
    socket.on("timeout", () => finish(new Error("SSH 工具调用超时")));
    socket.on("error", () => finish(new Error("持久 SSH 服务当前不可用")));
    socket.on("end", () => {
      if (!settled) finish(new Error("持久 SSH 服务提前断开"));
    });
  });
}

function toolError(message) {
  return {
    content: [{ type: "text", text: String(message || "SSH 工具调用失败").slice(0, 2_000) }],
    isError: true,
  };
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
    process.stderr.write("WFL persistent SSH MCP requires an absolute --socket path\n");
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
