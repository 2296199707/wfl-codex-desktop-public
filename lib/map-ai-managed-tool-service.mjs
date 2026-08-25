import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const REQUEST_LIMIT_BYTES = 512 * 1024;
const RESPONSE_LIMIT_BYTES = 768 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ID_LENGTH = 512;
const OPERATIONS = Object.freeze([
  "inspect_project",
  "get_project_context",
  "read_project_resource",
  "propose_project_patch",
  "apply_project_patch",
  "get_map_context",
  "read_map_region",
  "propose_tiled_patch",
  "apply_tiled_patch",
  "propose_tiled_resource_patch",
  "apply_tiled_resource_patch",
  "validate_map",
  "request_map_preview",
  "list_map_revisions",
  "restore_map_revision",
]);

const FORBIDDEN_KEYS = new Set([
  "leaseId", "leaseToken", "token", "projectPath", "absolutePath", "sourcePath",
  "sourcePaths", "image", "imageBytes", "base64", "dataUrl", "fileId",
]);

export class MapAiManagedToolError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = "MapAiManagedToolError";
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Headless map-AI MCP transport. It deliberately has a different request
 * contract from the editor lease service: no mapSessionId, editor instance,
 * lease token, file handle, or absolute path is accepted. The host callback is
 * the authority and must re-check the persisted managed authorization on every
 * call.
 */
export class MapAiManagedToolService {
  constructor({
    directory,
    userId,
    uid = null,
    gid = null,
    capabilities = null,
    execute = null,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    enabled = true,
  } = {}) {
    if (!directory || typeof directory !== "string") throw new TypeError("directory is required");
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.capabilities = typeof capabilities === "function" ? capabilities : null;
    this.executeOperation = typeof execute === "function" ? execute : null;
    this.enabled = enabled !== false;
    this.requestTimeoutMs = Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : REQUEST_TIMEOUT_MS;
    this.server = null;
    this.sockets = new Set();
    const identity = crypto.createHash("sha256")
      .update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`)
      .digest("hex").slice(0, 24);
    // Linux sockaddr_un leaves only 107 bytes for a pathname. Runtime
    // directories may already be long (browser tests and per-release
    // deployments commonly nest them under a temporary directory), so keep
    // the filename short while retaining an unpredictable per-process id.
    this.socketPath = path.join(this.directory, `mm-${identity}.sock`);
  }

  async start() {
    if (this.server) return this.socketPath;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("托管地图 AI socket 目录不安全");
    await fs.chmod(this.directory, 0o711);
    const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, resolve);
      });
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
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(this.requestTimeoutMs);
    let buffer = "";
    let accepted = false;
    let finished = false;
    const finish = (fn) => {
      if (finished) return;
      finished = true;
      void fn().finally(() => {
        this.sockets.delete(socket);
        socket.destroy();
      });
    };
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("timeout", () => finish(() => this.respond(socket, errorResponse(
      new MapAiManagedToolError(504, "MAP_AI_MANAGED_TOOL_TIMEOUT", "托管地图 AI 工具调用超时"),
    ))));
    socket.on("data", (chunk) => {
      if (accepted || finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) {
        finish(() => this.respond(socket, errorResponse(new MapAiManagedToolError(
          413, "MAP_AI_MANAGED_TOOL_REQUEST_TOO_LARGE", "托管地图 AI 请求过大",
        ))));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      accepted = true;
      socket.setTimeout(0);
      void this.executeWithTimeout(buffer.slice(0, newline).trim())
        .then((result) => finish(() => this.respond(socket, { version: 1, ok: true, result })))
        .catch((error) => finish(() => this.respond(socket, errorResponse(error))));
    });
  }

  async executeWithTimeout(line) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new MapAiManagedToolError(504, "MAP_AI_MANAGED_TOOL_TIMEOUT", "托管地图 AI 工具调用超时");
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.execute(line, { signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(line, { signal = null } = {}) {
    let request;
    try { request = JSON.parse(line); } catch { throw managedError(400, "INVALID_MAP_AI_MANAGED_REQUEST", "托管地图 AI 请求不是有效 JSON"); }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw managedError(400, "INVALID_MAP_AI_MANAGED_REQUEST", "托管地图 AI 请求无效");
    }
    if (request.version !== 1 || !["capabilities", ...OPERATIONS].includes(request.action)) {
      throw managedError(400, "INVALID_MAP_AI_MANAGED_REQUEST", "托管地图 AI 请求操作无效");
    }
    if (request.action === "capabilities") {
      if (Object.keys(request).some((key) => !["version", "action"].includes(key))) {
        throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", "能力查询不接受上下文参数");
      }
      const value = this.enabled && this.capabilities
        ? await this.capabilities({ userId: this.userId }, { signal })
        : null;
      return normalizeCapabilities(value);
    }
    const input = validateInput(request);
    if (!this.enabled || !this.executeOperation) {
      throw managedError(409, "MAP_AI_MANAGED_DISABLED", "托管地图 AI 工具当前未启用");
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : managedError(504, "MAP_AI_MANAGED_TOOL_TIMEOUT", "托管地图 AI 工具调用超时");
    const result = await this.executeOperation({ ...input, userId: this.userId }, { signal });
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : managedError(504, "MAP_AI_MANAGED_TOOL_TIMEOUT", "托管地图 AI 工具调用超时");
    return publicValue(result, "托管地图 AI 结果");
  }

  async respond(socket, value) {
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload) > RESPONSE_LIMIT_BYTES) {
      return socket.end(JSON.stringify(errorResponse(new MapAiManagedToolError(
        413, "MAP_AI_MANAGED_TOOL_RESPONSE_TOO_LARGE", "托管地图 AI 响应过大",
      ))) + "\n");
    }
    if (!socket.destroyed && socket.writable) await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await fs.unlink(this.socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function validateInput(request) {
  const allowed = new Set([
    "version", "action", "authorizationId", "threadId", "projectFingerprint",
    "mapPath", "mapVersion", "region", "layerIds", "patch", "clientOperationId",
    "resourcePath", "maxBytes", "planSummary", "taskId", "after", "limit", "revisionId", "expectedCurrentVersion",
  ]);
  for (const key of Object.keys(request)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) {
      throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", `托管地图 AI 工具不接受参数 ${key}`);
    }
  }
  for (const key of ["authorizationId", "threadId", "projectFingerprint", "mapPath", "mapVersion", "resourcePath"]) {
    if (request[key] !== undefined) boundedId(request[key], key);
  }
  if (request.projectFingerprint !== undefined && !/^[a-f0-9]{64}$/iu.test(request.projectFingerprint)) {
    throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", "工程指纹无效");
  }
  if (request.mapVersion !== undefined && !/^[a-f0-9]{64}$/iu.test(request.mapVersion)) {
    throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", "地图版本无效");
  }
  if (request.maxBytes !== undefined
    && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 512 * 1024)) {
    throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", "工程资源读取上限无效");
  }
  if (request.region !== undefined) validateRegion(request.region);
  if (request.layerIds !== undefined) {
    if (!Array.isArray(request.layerIds) || request.layerIds.length > 128) throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", "图层筛选无效");
    request.layerIds.forEach((id) => { if (!Number.isSafeInteger(id) || id < 0) throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", "图层 ID 无效"); });
  }
  if (["propose_tiled_patch", "apply_tiled_patch", "propose_tiled_resource_patch", "apply_tiled_resource_patch", "propose_project_patch", "apply_project_patch"].includes(request.action)) {
    if (!request.patch || typeof request.patch !== "object" || Array.isArray(request.patch)) throw managedError(400, "INVALID_MAP_AI_MANAGED_PATCH", "必须提供结构化 Tiled 补丁");
    validateBoundedJson(request.patch, "patch", REQUEST_LIMIT_BYTES / 2);
    // A proposal is a read-only preview and is not persisted as a task, so it
    // has no idempotency key.  Apply operations create a durable task and
    // therefore require the explicit client operation id exposed by their
    // MCP schema.  Keeping this distinction here prevents the proposal
    // schema and the transport validator from disagreeing.
    if (["apply_tiled_patch", "apply_tiled_resource_patch", "apply_project_patch"].includes(request.action)) {
      boundedId(request.clientOperationId, "clientOperationId");
    }
  }
  if (request.taskId !== undefined) boundedId(request.taskId, "taskId");
  return structuredClone(request);
}

function validateRegion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw managedError(400, "INVALID_MAP_AI_REGION", "地图区域无效");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(value[key]) || (key === "width" || key === "height" ? value[key] < 1 : Math.abs(value[key]) > 1_000_000)) throw managedError(400, "INVALID_MAP_AI_REGION", "地图区域无效");
  }
  if (value.width > 512 || value.height > 512) throw managedError(413, "MAP_AI_REGION_TOO_LARGE", "地图区域最大为 512×512");
}

function validateBoundedJson(value, label, maxBytes) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw managedError(400, "INVALID_MAP_AI_MANAGED_PATCH", `${label}无法序列化`); }
  if (!serialized || Buffer.byteLength(serialized) > maxBytes || /(?:data|blob|https?|file):/iu.test(serialized)) throw managedError(400, "INVALID_MAP_AI_MANAGED_PATCH", `${label}包含不允许的图片数据或路径`);
}

function boundedId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) throw managedError(400, "INVALID_MAP_AI_MANAGED_ARGUMENTS", `${label}无效`);
}

function normalizeCapabilities(value) {
  const requested = Array.isArray(value) ? value : value?.operations;
  const operations = OPERATIONS.filter((operation) => requested?.includes(operation));
  return Object.freeze({ enabled: operations.length > 0, operations });
}

function publicValue(value, label) {
  const seen = new WeakSet();
  const clean = (input, key = "") => {
    if (FORBIDDEN_KEYS.has(key) || /(?:token|secret|credential|password|absolute|projectpath)/iu.test(key)) throw managedError(500, "MAP_AI_MANAGED_PRIVATE_FIELD", `${label}包含不应公开的字段`);
    if (typeof input === "string") {
      // Authorized text resources are data, not transport metadata. A source
      // file may legitimately begin with `/` or contain a URL, so leave the
      // bounded content field intact while keeping private metadata guarded.
      if (key === "content") return input;
      if (input.startsWith("/") || /^(?:data|blob|https?|file):/iu.test(input)) throw managedError(500, "MAP_AI_MANAGED_PRIVATE_FIELD", `${label}包含私有路径或图片数据`);
      return input.length > 16_384 ? input.slice(0, 16_384) : input;
    }
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) throw managedError(500, "MAP_AI_MANAGED_PRIVATE_FIELD", `${label}结构无效`);
    seen.add(input);
    if (Array.isArray(input)) {
      if (input.length > 4_000) throw managedError(500, "MAP_AI_MANAGED_RESPONSE_TOO_LARGE", `${label}列表过大`);
      return input.map((item) => clean(item));
    }
    const out = {};
    for (const [entryKey, item] of Object.entries(input)) out[entryKey] = clean(item, entryKey);
    return out;
  };
  return clean(value);
}

function managedError(statusCode, code, message) { return new MapAiManagedToolError(statusCode, code, message); }
function errorResponse(error) {
  return {
    version: 1,
    ok: false,
    error: {
      code: error?.code || "MAP_AI_MANAGED_TOOL_ERROR",
      message: String(error?.message || "托管地图 AI 工具调用失败").slice(0, 2_000),
      status: Number.isInteger(error?.statusCode) ? error.statusCode : 500,
      retryable: error?.retryable === true,
      ...(error?.reason ? { reason: error.reason } : {}),
    },
  };
}

export const MAP_AI_MANAGED_TOOL_OPERATIONS = OPERATIONS;
