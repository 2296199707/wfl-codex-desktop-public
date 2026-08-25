#!/usr/bin/env node
import net from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
const SOCKET_TIMEOUT_MS = 70_000;
const RESPONSE_LIMIT_BYTES = 768 * 1024;
const socketPath = process.argv.slice(2).find((value) => value && !value.startsWith("--")) || process.env.WFL_MAP_AI_MANAGED_SOCKET;

const TOOLS = [
  ["inspect_project", "读取已授权 Tiled 工程的受限资源清单，不返回绝对路径或图片字节。", schema()],
  ["get_project_context", "读取已授权工程的设计资源摘要；工程授权不要求重复填写地图路径或版本。", schema()],
  ["read_project_resource", "读取已授权工程中的 UTF-8 文本资源；不会读取图片、音频或返回绝对路径。", schema({ resourcePath: { type: "string", minLength: 1, maxLength: 4_096 }, maxBytes: { type: "integer", minimum: 1, maximum: 512 * 1024 } }, ["resourcePath"])],
  ["get_map_context", "读取已授权地图的尺寸、图层摘要、版本和引用摘要，不返回完整瓦片数据。", schema()],
  ["read_map_region", "读取已授权地图指定的小范围结构化区域，最多 512×512；不会读取图片字节。", schema({ region: { type: "object", additionalProperties: false, properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer", minimum: 1, maximum: 512 }, height: { type: "integer", minimum: 1, maximum: 512 } }, required: ["x", "y", "width", "height"] } }, ["region"])],
  ["validate_map", "校验已授权地图的 Tiled 结构和工程引用，返回有限诊断。", schema()],
  ["request_map_preview", "为已授权地图创建受限预览任务；不会自动向对话注入图片。", schema()],
  ["list_map_revisions", "列出已授权地图的受限修订历史，只返回版本摘要。", schema()],
  ["restore_map_revision", "恢复一个已授权的历史地图修订；恢复会创建新的地图版本，不删除历史。", schema({ revisionId: idSchema("修订 ID"), expectedCurrentVersion: hashSchema("当前地图版本 SHA-256") }, ["revisionId", "expectedCurrentVersion"])],
  ["propose_tiled_patch", "为关闭编辑器时的托管工作流提出结构化 Tiled 补丁；不会直接写入地图。", schema({ patch: { type: "object" } }, ["patch"])],
  ["apply_tiled_patch", "创建受批准策略约束的持久化地图任务；不会绕过批准、版本校验或原子保存。", schema({ patch: { type: "object", description: "单地图 wfl-tiled-patch 或覆盖全部授权地图的 wfl-multi-map-patch" }, clientOperationId: idSchema("幂等操作 ID") }, ["patch", "clientOperationId"])],
  ["propose_project_patch", "为整个工程提出跨地图、World、Tileset、角色和图片资源的候选事务；不会直接写入工程。", schema({ patch: resourcePatchSchema() }, ["patch"])],
  ["apply_project_patch", "创建整个工程的多资源原子事务；AI 只能提交服务端候选 ID，不能提交路径或文件字节。", schema({ patch: resourcePatchSchema(), clientOperationId: idSchema("幂等操作 ID") }, ["patch", "clientOperationId"])],
  ["propose_tiled_resource_patch", "预览一组已由服务端暂存的 Tiled/图片资源候选；不会直接写入工程。", schema({ patch: resourcePatchSchema() }, ["patch"])],
  ["apply_tiled_resource_patch", "创建受批准策略约束的多资源原子事务；AI 只能提交候选 ID，不能提交路径或图片字节。", schema({ patch: resourcePatchSchema(), clientOperationId: idSchema("幂等操作 ID") }, ["patch", "clientOperationId"])],
].map(([name, description, inputSchema]) => ({ name, title: name, description, inputSchema }));

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let index;
  while ((index = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, index).trim();
    inputBuffer = inputBuffer.slice(index + 1);
    if (line) void handleLine(line);
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
        // The managed tool surface is static for the lifetime of this small
        // adapter. Authorization changes affect execution, not the schema, so
        // clients do not need to reconnect merely because a grant changed.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wfl-map-ai-managed", title: "WFL 托管地图 AI", version: "1.0.0" },
        instructions: "这是独立的无编辑器工程 AI 工具。每次调用都需要显式托管授权；工程级授权不要求重复填写对话、地图路径或版本，服务端会在调用边界实时校验工程和资源。写入只创建持久化任务，路径、版本、引用和原子保存安全规则仍然有效。普通对话不会自动收到图片字节。",
      });
      return;
    }
    if (message.method === "ping") { writeResult(message.id, {}); return; }
    if (message.method === "tools/list") { writeResult(message.id, { tools: TOOLS }); return; }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const definition = TOOLS.find((tool) => tool.name === name);
      if (!definition) { writeResult(message.id, toolError("UNKNOWN_MAP_AI_MANAGED_TOOL", "未知的托管地图 AI 工具")); return; }
      const args = validateArguments(name, message.params?.arguments);
      const result = await requestService({ version: 1, action: name, ...args });
      if (result?.ok === false) {
        writeResult(message.id, toolError(result.error?.code || "MAP_AI_MANAGED_TOOL_ERROR", result.error?.message || "托管地图 AI 调用失败", result.error));
        return;
      }
      writeResult(message.id, { content: [{ type: "text", text: `${name}：\n${JSON.stringify(result.result, null, 2)}` }], structuredContent: result.result, isError: false });
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError(error.code || "MAP_AI_MANAGED_TOOL_ERROR", error.message || "托管地图 AI 调用失败", error));
    else writeError(message.id, -32603, String(error?.message || "Internal error"));
  }
}

function schema(extra = {}, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      authorizationId: idSchema("托管授权 ID"),
      threadId: idSchema("兼容旧地图授权的对话 ID；工程授权可省略"),
      projectFingerprint: hashSchema("兼容旧地图授权的工程指纹；工程授权可省略"),
      mapPath: { type: "string", minLength: 1, maxLength: 4_096, description: "兼容旧地图授权的工程相对 .tmj 路径" },
      mapVersion: hashSchema("兼容旧地图授权的地图版本 SHA-256"),
      ...extra,
    },
    required: ["authorizationId", ...required],
  };
}
function idSchema(description) { return { type: "string", minLength: 1, maxLength: 512, description }; }
function hashSchema(description) { return { type: "string", pattern: "^[a-fA-F0-9]{64}$", description }; }
function resourcePatchSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: {
      format: { const: "wfl-tiled-resource-patch" }, version: { const: 1 }, summary: { type: "string", maxLength: 2_000 },
      files: { type: "array", minItems: 1, maxItems: 256, items: { type: "object", additionalProperties: false, properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 }, baseVersion: { anyOf: [{ type: "null" }, hashSchema("资源基础版本 SHA-256")] }, candidateId: idSchema("服务端候选 ID"), size: { type: "integer", minimum: 1 }, sha256: hashSchema("候选 SHA-256"),
      }, required: ["path", "baseVersion", "candidateId"] } },
    }, required: ["format", "version", "files"],
  };
}
function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("托管地图 AI 参数必须是对象");
  const definition = TOOLS.find((tool) => tool.name === name);
  const allowed = new Set(Object.keys(definition.inputSchema.properties));
  for (const key of Object.keys(args)) if (!allowed.has(key) || /(?:token|lease|projectPath|absolutePath|image|base64)/iu.test(key)) throw new Error(`托管地图 AI 工具不接受参数 ${key}`);
  for (const key of definition.inputSchema.required) if (args[key] === undefined) throw new Error(`缺少参数 ${key}`);
  if (name === "restore_map_revision" && !/^[a-f0-9]{64}$/iu.test(String(args.expectedCurrentVersion || ""))) {
    throw new Error("expectedCurrentVersion 必须是 SHA-256");
  }
  return structuredClone(args);
}
function requestService(payload) {
  if (!socketPath) return Promise.reject(new Error("托管地图 AI 工具服务未配置 socket"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    let buffer = "";
    const done = (error, value) => { socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once("error", (error) => done(error));
    socket.once("timeout", () => done(new Error("托管地图 AI 工具服务超时")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > RESPONSE_LIMIT_BYTES) return done(new Error("托管地图 AI 响应过大"));
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      try { done(null, JSON.parse(buffer.slice(0, index))); } catch { done(new Error("托管地图 AI 响应无效")); }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
  });
}
function toolError(code, message, details = {}) {
  return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: { code, message, ...(details.reason ? { reason: details.reason } : {}) }, isError: true };
}
function writeResult(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function writeError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
