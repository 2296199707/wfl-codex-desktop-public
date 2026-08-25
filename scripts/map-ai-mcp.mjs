#!/usr/bin/env node
import net from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
// The host service enforces a 60 second execution deadline.  Keep the adapter
// transport deadline slightly longer so callers receive the host's structured
// timeout and the adapter never gives up while a proposal could still commit.
const SOCKET_TIMEOUT_MS = 70_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const socketPath = process.argv.slice(2).find((value) => value && !value.startsWith("--")) || process.env.WFL_MAP_AI_SOCKET;
const TOOLS = [
  {
    name: "get_map_context",
    title: "读取当前地图上下文",
    description: "读取当前已授权地图窗口的有限元数据。不会读取图片字节、完整瓦片数据或绝对路径。必须显式提供 threadId、mapSessionId、editorInstanceId 和 editorStateId。",
    inputSchema: schema(),
  },
  {
    name: "propose_tiled_patch",
    title: "提出 Tiled 地图补丁",
    description: "为当前地图窗口提交结构化 Tiled 补丁提案，供编辑器预览和用户确认；不会直接写入 .tmj。必须显式提供上下文标识。",
    inputSchema: schema({ patch: { type: "object", description: "结构化 Tiled 补丁对象。" } }, ["patch"]),
  },
];

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let index;
  while ((index = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, index).trim(); inputBuffer = inputBuffer.slice(index + 1);
    if (line) void handleLine(line);
  }
});

async function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { writeError(null, -32700, "Parse error"); return; }
  if (!message || typeof message !== "object") { writeError(null, -32600, "Invalid Request"); return; }
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "notifications/initialized") {
      // Tool definitions are intentionally stable for the lifetime of this
      // adapter. Authorization is checked at call time, so opening or
      // revoking a map lease never makes a client cache an empty catalog.
    }
    return;
  }
  try {
    if (message.method === "initialize") {
      const capabilities = await requestCapabilities().catch(() => closedCapabilities());
      const instructions = mapAiInstructions(capabilities);
      writeResult(message.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "wfl-map-ai", title: "WFL 地图 AI", version: "1.1.0" }, ...(instructions ? { instructions } : {}) });
      return;
    }
    if (message.method === "ping") { writeResult(message.id, {}); return; }
    if (message.method === "tools/list") {
      const capabilities = await requestCapabilities().catch(() => closedCapabilities());
      writeResult(message.id, { tools: toolDefinitions(capabilities) });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (!TOOLS.some((tool) => tool.name === name)) { writeResult(message.id, toolError("UNKNOWN_MAP_AI_TOOL", "未知的地图 AI 工具")); return; }
      const capabilities = await requestCapabilities();
      if (!capabilities.enabled || !capabilities.operations.includes(name)) {
        writeResult(message.id, toolError("MAP_AI_OPERATION_UNAVAILABLE", "当前对话没有这个地图 AI 操作的有效显式授权"));
        return;
      }
      const args = validateArguments(name, message.params?.arguments);
      if (!socketPath) throw new Error("地图 AI 工具服务未配置 socket");
      const result = await requestService({ version: 1, action: name, ...args });
      if (result?.ok === false) { writeResult(message.id, toolError(result.error?.code || "MAP_AI_TOOL_ERROR", result.error?.message || "地图 AI 工具调用失败", result.error)); return; }
      writeResult(message.id, { content: [{ type: "text", text: formatResult(name, result.result) }], structuredContent: result.result, isError: false });
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError(error.code || "MAP_AI_TOOL_ERROR", error.message || "地图 AI 工具调用失败", error));
    else writeError(message.id, -32603, String(error?.message || "Internal error"));
  }
}

function closedCapabilities() { return { enabled: false, operations: [] }; }
function normalizeCapabilities(value) {
  const operations = TOOLS.map((tool) => tool.name)
    .filter((operation) => value?.enabled === true && value?.operations?.includes(operation));
  return { enabled: operations.length > 0, operations };
}
function toolDefinitions(capabilities) {
  // Keep the MCP catalog stable even before a user grants a map lease. The
  // host still checks the live authorization on every call and returns a
  // structured MAP_AI_OPERATION_UNAVAILABLE response. Hiding tools made a
  // long-lived Codex session cache an empty catalog and prevented the model
  // from discovering map capabilities after the editor was opened.
  void capabilities;
  return TOOLS;
}
function mapAiInstructions(capabilities) {
  const operations = normalizeCapabilities(capabilities).operations;
  const state = operations.length ? "当前已有显式地图授权；" : "当前尚未有显式地图授权，调用会返回结构化授权错误；";
  return `${state}地图 AI 工具目录保持稳定。工具只能读取受限元数据和提交待确认的结构化补丁，不会自动保存地图、读取图片字节或向对话注入提示词。`;
}

function schema(extra = {}, required = []) {
  const properties = { threadId: idSchema("对话 ID"), mapSessionId: idSchema("地图会话 ID"), editorInstanceId: idSchema("编辑器窗口 ID"), editorStateId: { type: "integer", minimum: 0, description: "编辑器状态 ID" }, ...extra };
  return { type: "object", additionalProperties: false, properties, required: ["threadId", "mapSessionId", "editorInstanceId", "editorStateId", ...required] };
}
function idSchema(description) { return { type: "string", minLength: 1, maxLength: 512, description }; }
function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("地图 AI 工具参数必须是对象");
  const allowed = new Set(["threadId", "mapSessionId", "editorInstanceId", "editorStateId", ...(name === "propose_tiled_patch" ? ["patch"] : [])]);
  for (const key of Object.keys(args)) if (!allowed.has(key) || /(?:token|lease|projectPath|absolutePath|image|base64)/iu.test(key)) throw new Error(`地图 AI 工具不接受参数 ${key}`);
  for (const key of ["threadId", "mapSessionId", "editorInstanceId"]) if (typeof args[key] !== "string" || !args[key].trim() || args[key].length > 512) throw new Error(`${key}无效`);
  if (!Number.isSafeInteger(args.editorStateId) || args.editorStateId < 0) throw new Error("editorStateId无效");
  if (name === "propose_tiled_patch" && (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch))) throw new Error("patch 必须是结构化对象");
  return structuredClone(args);
}
function requestService(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); socket.setEncoding("utf8"); socket.setTimeout(SOCKET_TIMEOUT_MS); let buffer = "";
    const done = (error, value) => { socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once("error", (error) => done(error)); socket.once("timeout", () => done(new Error("地图 AI 工具服务超时")));
    socket.on("data", (chunk) => { buffer += chunk; if (Buffer.byteLength(buffer) > RESPONSE_LIMIT_BYTES) return done(new Error("地图 AI 工具响应过大")); const index = buffer.indexOf("\n"); if (index === -1) return; try { done(null, JSON.parse(buffer.slice(0, index))); } catch { done(new Error("地图 AI 工具响应无效")); } });
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
  });
}
async function requestCapabilities() {
  const response = await requestService({ version: 1, action: "capabilities" });
  if (response?.ok !== true) throw new Error(response?.error?.message || "地图 AI 能力查询失败");
  return normalizeCapabilities(response.result);
}
function formatResult(name, value) { return `${name === "get_map_context" ? "地图上下文" : "地图补丁提案"}：\n${JSON.stringify(value, null, 2)}`; }
function toolError(code, message, details = {}) { return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: { code, message, ...(details.reason ? { reason: details.reason } : {}) }, isError: true }; }
function writeResult(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function writeError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
