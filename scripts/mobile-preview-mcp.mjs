#!/usr/bin/env node
import net from "node:net";

const socketPath = process.argv.slice(2).find((value) => value && !value.startsWith("--"))
  || process.env.WFL_MOBILE_PREVIEW_SOCKET;
const PROTOCOL_VERSION = "2025-06-18";
const TOOLS = [
  tool("mobile_preview_start", "启动当前移动 App 的 Flutter Web 预览。"),
  tool("mobile_preview_status", "读取移动 App 预览状态、地址和错误。"),
  tool("mobile_preview_restart", "同步最新源码并重启移动 App 的 Flutter Web 预览。"),
  tool("mobile_preview_logs", "读取最近的 Flutter Web 预览日志，用于定位编译错误。"),
  tool("mobile_preview_screenshot", "以 390×844 手机视口截图当前 Flutter Web 预览。"),
  tool("mobile_preview_click", "点击当前 AI 预览会话中的指定坐标，并返回操作后的截图。", {
    x: { type: "number", minimum: 0, maximum: 389, description: "横向坐标。" },
    y: { type: "number", minimum: 0, maximum: 843, description: "纵向坐标。" },
  }, ["x", "y"]),
  tool("mobile_preview_type", "向当前焦点输入文字，并返回操作后的截图。", {
    text: { type: "string", maxLength: 2000, description: "要输入的文字。" },
    clear: { type: "boolean", description: "输入前是否清空当前字段。" },
  }, ["text"]),
  tool("mobile_preview_scroll", "滚动当前 AI 预览会话，并返回操作后的截图。", {
    deltaX: { type: "number", minimum: -5000, maximum: 5000, description: "横向滚动量。" },
    deltaY: { type: "number", minimum: -5000, maximum: 5000, description: "纵向滚动量。" },
  }, ["deltaY"]),
];

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
  try { message = JSON.parse(line); } catch { writeError(null, -32700, "Parse error"); return; }
  if (!message || typeof message !== "object") { writeError(null, -32600, "Invalid Request"); return; }
  if (!Object.hasOwn(message, "id")) return;
  try {
    if (message.method === "initialize") {
      writeResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wfl-mobile-preview", title: "WFL 移动 App 预览", version: "1.0.0" },
        instructions: "移动预览工具绑定当前移动 App 工程。AI 可以启动、增量重建、截图，并在同一个 390×844 浏览器会话中点击、输入和滚动；不会连接真实 SSH、API 或供应商。",
      });
      return;
    }
    if (message.method === "ping") { writeResult(message.id, {}); return; }
    if (message.method === "tools/list") { writeResult(message.id, { tools: TOOLS }); return; }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (!TOOLS.some((entry) => entry.name === name)) {
        writeResult(message.id, toolError("UNKNOWN_MOBILE_PREVIEW_TOOL", "未知移动预览工具"));
        return;
      }
      const args = message.params?.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        writeResult(message.id, toolError("INVALID_MOBILE_PREVIEW_ARGUMENTS", "移动预览工具参数无效"));
        return;
      }
      const result = await requestService({ version: 1, action: name, arguments: args });
      if (result?.ok === false) {
        writeResult(message.id, toolError("MOBILE_PREVIEW_TOOL_ERROR", result.error || "移动预览工具调用失败", result.error));
        return;
      }
      writeResult(message.id, formatResult(result.result));
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError("MOBILE_PREVIEW_TOOL_ERROR", error.message || "移动预览工具调用失败", error));
    else writeError(message.id, -32603, String(error?.message || "Internal error"));
  }
}

function formatResult(result) {
  const screenshot = result?.screenshot;
  const structuredContent = screenshot ? { ...result, screenshot: { ...screenshot, data: undefined } } : result;
  const content = [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }];
  if (screenshot?.data && screenshot?.mimeType) {
    content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
  }
  return { content, structuredContent, isError: false };
}

function tool(name, description, properties = {}, required = []) {
  return {
    name,
    title: name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) },
  };
}

function requestService(request) {
  if (!socketPath) return Promise.reject(new Error("移动预览工具 socket 未配置"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(60_000);
    let buffer = "";
    const done = (error, value) => {
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once("error", (error) => done(error));
    socket.once("timeout", () => done(new Error("移动预览工具服务超时")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { done(null, JSON.parse(buffer.slice(0, newline))); }
      catch { done(new Error("移动预览工具响应无效")); }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
  });
}

function toolError(code, message, details = null) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, code, message, ...(details ? { details: String(details) } : {}) },
    isError: true,
  };
}

function writeResult(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function writeError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
