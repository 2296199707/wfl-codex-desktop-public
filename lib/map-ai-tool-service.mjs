import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const REQUEST_LIMIT_BYTES = 256 * 1024;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ID_LENGTH = 512;
const OPERATIONS = new Set(["get_map_context", "propose_tiled_patch"]);
const CONTROL_OPERATIONS = new Set(["capabilities"]);
const FORBIDDEN_KEYS = new Set([
  "leaseId", "leaseToken", "token", "projectPath", "absolutePath", "sourcePath",
  "sourcePaths", "image", "imageBytes", "base64", "dataUrl", "fileId",
]);

export class MapAiToolError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = "MapAiToolError";
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Local, context-bound map AI RPC service. The host injects capabilities,
 * resolveContext, getContext and proposePatch; this class never reads or
 * writes a .tmj file.
 */
export class MapAiToolService {
  constructor({
    directory,
    userId,
    uid = null,
    gid = null,
    resolveContext = null,
    capabilities = null,
    getContext = null,
    proposePatch = null,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    enabled = true,
  } = {}) {
    if (!directory || typeof directory !== "string") throw new TypeError("directory is required");
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.resolveContext = typeof resolveContext === "function" ? resolveContext : null;
    this.capabilities = typeof capabilities === "function" ? capabilities : null;
    this.getContext = typeof getContext === "function" ? getContext : null;
    this.proposePatch = typeof proposePatch === "function" ? proposePatch : null;
    this.enabled = enabled !== false;
    this.requestTimeoutMs = Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : REQUEST_TIMEOUT_MS;
    this.server = null;
    this.sockets = new Set();
    const identity = crypto.createHash("sha256").update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`).digest("hex").slice(0, 24);
    // Keep the Unix socket pathname below sockaddr_un's 107-byte limit even
    // when the per-release runtime directory is deeply nested.
    this.socketPath = path.join(this.directory, `ma-${identity}.sock`);
  }

  async start() {
    if (this.server) return this.socketPath;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Map AI tool socket directory is unsafe");
    await fs.chmod(this.directory, 0o711);
    // MCP adapters half-close their write side after sending the one-line
    // request. Keep the server write side open until the bounded async handler
    // has returned its response; otherwise only same-tick callbacks work.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, resolve); });
      await fs.chmod(this.socketPath, 0o600);
      if (this.uid !== null && this.gid !== null) await fs.chown(this.socketPath, this.uid, this.gid);
      return this.socketPath;
    } catch (error) {
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      await fs.unlink(this.socketPath).catch(() => {});
      throw error;
    }
  }

  handleSocket(socket) {
    this.sockets.add(socket); socket.setEncoding("utf8"); socket.setTimeout(this.requestTimeoutMs);
    let buffer = ""; let accepted = false; let finished = false;
    const finish = (fn) => { if (finished) return; finished = true; void fn().finally(() => { this.sockets.delete(socket); socket.destroy(); }); };
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("timeout", () => finish(() => this.respond(socket, errorResponse(new MapAiToolError(504, "MAP_AI_TOOL_TIMEOUT", "地图 AI 工具调用超时")))));
    socket.on("data", (chunk) => {
      if (accepted || finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) return finish(() => this.respond(socket, errorResponse(new MapAiToolError(413, "MAP_AI_TOOL_REQUEST_TOO_LARGE", "地图 AI 工具请求过大"))));
      const newline = buffer.indexOf("\n"); if (newline < 0) return;
      accepted = true; socket.setTimeout(0);
      const line = buffer.slice(0, newline).trim();
      void this.executeWithTimeout(line).then((result) => finish(() => this.respond(socket, { version: 1, ok: true, result }))).catch((error) => finish(() => this.respond(socket, errorResponse(error))));
    });
  }

  async executeWithTimeout(line) {
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new MapAiToolError(504, "MAP_AI_TOOL_TIMEOUT", "地图 AI 工具调用超时");
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        this.execute(line, { signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(line, { signal = null } = {}) {
    let request;
    try { request = JSON.parse(line); } catch { throw new MapAiToolError(400, "INVALID_MAP_AI_REQUEST", "地图 AI 请求不是有效 JSON"); }
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new MapAiToolError(400, "INVALID_MAP_AI_REQUEST", "地图 AI 请求无效");
    if (request.version !== 1 || (!OPERATIONS.has(request.action) && !CONTROL_OPERATIONS.has(request.action))) throw new MapAiToolError(400, "INVALID_MAP_AI_REQUEST", "地图 AI 请求操作无效");
    if (request.action === "capabilities") {
      if (Object.keys(request).some((key) => !["version", "action"].includes(key))) {
        throw new MapAiToolError(400, "INVALID_MAP_AI_ARGUMENTS", "地图 AI 能力查询不接受上下文参数");
      }
      const value = this.enabled && this.capabilities
        ? await this.capabilities({ userId: this.userId }, { signal })
        : null;
      throwIfAborted(signal);
      return normalizeCapabilities(value);
    }
    const input = validateInput(request);
    if (!this.enabled || !this.resolveContext) throw new MapAiToolError(409, "MAP_AI_DISABLED", "地图 AI 工具当前未启用");
    throwIfAborted(signal);
    const resolved = await this.resolveContext({ ...input, userId: this.userId }, input.action, { signal });
    throwIfAborted(signal);
    const matches = Array.isArray(resolved) ? resolved : resolved?.matches;
    if (matches !== undefined && (!Array.isArray(matches) || matches.length !== 1)) {
      throw new MapAiToolError(409, "MAP_AI_CONTEXT_SELECTION_REQUIRED", "无法唯一确定地图 AI 上下文", { reason: "selection_required" });
    }
    const context = matches ? matches[0] : resolved;
    if (!context) throw new MapAiToolError(409, "MAP_AI_CONTEXT_SELECTION_REQUIRED", "无法唯一确定地图 AI 上下文", { reason: "selection_required" });
    if (input.action === "get_map_context") {
      if (!this.getContext) throw new MapAiToolError(409, "MAP_AI_DISABLED", "地图上下文服务当前未启用");
      const value = await this.getContext(context, input, { signal });
      throwIfAborted(signal);
      return { operation: input.action, context: publicValue(value, "context") };
    }
    if (!this.proposePatch) throw new MapAiToolError(409, "MAP_AI_DISABLED", "地图补丁服务当前未启用");
    const proposal = await this.proposePatch(context, input, { signal });
    throwIfAborted(signal);
    return { operation: input.action, proposal: publicValue(proposal, "proposal") };
  }

  async respond(socket, value) {
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload) > RESPONSE_LIMIT_BYTES) return socket.end(JSON.stringify(errorResponse(new MapAiToolError(413, "MAP_AI_TOOL_RESPONSE_TOO_LARGE", "地图 AI 工具响应过大"))) + "\n");
    if (!socket.destroyed && socket.writable) await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    const server = this.server; this.server = null;
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await fs.unlink(this.socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function normalizeCapabilities(value) {
  const requested = Array.isArray(value) ? value : value?.operations;
  const operations = OPERATIONS_LIST.filter((operation) => requested?.includes(operation));
  return Object.freeze({
    enabled: operations.length > 0,
    operations,
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new MapAiToolError(504, "MAP_AI_TOOL_TIMEOUT", "地图 AI 工具调用超时");
}

function validateInput(request) {
  const allowed = new Set(["version", "action", "threadId", "mapSessionId", "editorInstanceId", "editorStateId", "patch"]);
  for (const key of Object.keys(request)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) throw new MapAiToolError(400, "INVALID_MAP_AI_ARGUMENTS", `地图 AI 工具不接受参数 ${key}`);
  }
  for (const key of ["threadId", "mapSessionId", "editorInstanceId"]) boundedId(request[key], key);
  if (!Number.isSafeInteger(request.editorStateId) || request.editorStateId < 0) throw new MapAiToolError(400, "INVALID_MAP_AI_ARGUMENTS", "editorStateId无效");
  if (request.action === "propose_tiled_patch" && (request.patch === undefined || request.patch === null)) throw new MapAiToolError(400, "INVALID_MAP_AI_PATCH", "必须提供结构化 Tiled 补丁");
  if (request.patch !== undefined) validatePatchPayload(request.patch);
  return { action: request.action, threadId: request.threadId, mapSessionId: request.mapSessionId, editorInstanceId: request.editorInstanceId, editorStateId: request.editorStateId, patch: request.patch };
}

function validatePatchPayload(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new MapAiToolError(400, "INVALID_MAP_AI_PATCH", "结构化 Tiled 补丁无法序列化"); }
  if (!serialized || Buffer.byteLength(serialized) > REQUEST_LIMIT_BYTES / 2) throw new MapAiToolError(413, "MAP_AI_PATCH_TOO_LARGE", "结构化 Tiled 补丁过大");
  if (/(?:"(?:leaseToken|token|projectPath|absolutePath|imageBytes|base64|dataUrl)"\s*:|(?:data|blob|https?|file):)/iu.test(serialized)) {
    throw new MapAiToolError(400, "INVALID_MAP_AI_PATCH", "结构化 Tiled 补丁包含不允许的私有路径、凭据或图片数据");
  }
}

function boundedId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) throw new MapAiToolError(400, "INVALID_MAP_AI_ARGUMENTS", `${label}无效`);
}

function publicValue(value, label) {
  const seen = new WeakSet();
  const clean = (input, key = "") => {
    if (FORBIDDEN_KEYS.has(key) || /(?:token|secret|credential|password|absolute)/iu.test(key)) throw new MapAiToolError(500, "MAP_AI_PRIVATE_FIELD", `${label}包含不应公开的字段`);
    if (typeof input === "string") {
      if (input.startsWith("/") || /^(?:data|blob|https?|file):/iu.test(input)) throw new MapAiToolError(500, "MAP_AI_PRIVATE_FIELD", `${label}包含私有路径或图片数据`);
      return input.length > 16_384 ? input.slice(0, 16_384) : input;
    }
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) throw new MapAiToolError(500, "MAP_AI_PRIVATE_FIELD", `${label}结构无效`); seen.add(input);
    if (Array.isArray(input)) { if (input.length > 2_000) throw new MapAiToolError(500, "MAP_AI_RESPONSE_TOO_LARGE", `${label}列表过大`); return input.map((item) => clean(item)); }
    const out = {}; for (const [key, item] of Object.entries(input)) out[key] = clean(item, key); return out;
  };
  return clean(value);
}

function errorResponse(error) {
  return { version: 1, ok: false, error: { code: error?.code || "MAP_AI_TOOL_ERROR", message: safeErrorMessage(error), status: Number.isInteger(error?.statusCode) ? error.statusCode : 500, retryable: error?.retryable === true, ...(error?.reason ? { reason: error.reason } : {}) } };
}

function safeErrorMessage(error) {
  const message = String(error?.message || "地图 AI 工具调用失败").slice(0, 2_000);
  if (
    /(?:^|[\s'"(])\/(?:[^\s'"()]+\/?)+/u.test(message)
    || /(?:^|[\s'"(])[A-Za-z]:[\\/]/u.test(message)
    || /(?:data|blob|file):|base64|(?:lease|bearer|secret|token)\s*[=:]/iu.test(message)
  ) return "地图 AI 工具调用失败；请在地图编辑器中检查授权和地图状态";
  return message;
}

const OPERATIONS_LIST = Object.freeze([...OPERATIONS]);
export const MAP_AI_TOOL_OPERATIONS = OPERATIONS_LIST;
