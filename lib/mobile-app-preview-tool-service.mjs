import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const REQUEST_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const ACTIONS = new Set([
  "mobile_preview_start",
  "mobile_preview_status",
  "mobile_preview_restart",
  "mobile_preview_logs",
  "mobile_preview_screenshot",
  "mobile_preview_click",
  "mobile_preview_type",
  "mobile_preview_scroll",
]);

export class MobileAppPreviewToolService {
  constructor({ directory, userId, uid = null, gid = null, start, status, restart, logs, screenshot, click, type, scroll } = {}) {
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.handlers = { start, status, restart, logs, screenshot, click, type, scroll };
    this.server = null;
    this.sockets = new Set();
    const identity = crypto.createHash("sha256")
      .update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`)
      .digest("hex").slice(0, 24);
    this.socketPath = path.join(this.directory, `mp-${identity}.sock`);
  }

  async start() {
    if (this.server) return this.socketPath;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("移动预览工具 socket 目录不安全");
    await fs.chmod(this.directory, 0o711);
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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
    socket.setTimeout(REQUEST_TIMEOUT_MS);
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
    socket.on("timeout", () => finish(() => this.respond(socket, errorResponse("移动预览工具调用超时"))));
    socket.on("data", (chunk) => {
      if (accepted || finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) {
        finish(() => this.respond(socket, errorResponse("移动预览工具请求过大")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      accepted = true;
      socket.setTimeout(0);
      void this.executeWithTimeout(buffer.slice(0, newline).trim())
        .then((result) => finish(() => this.respond(socket, { version: 1, ok: true, result })))
        .catch((error) => finish(() => this.respond(socket, errorResponse(error.message || "移动预览工具调用失败"))));
    });
  }

  async executeWithTimeout(line) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("移动预览工具调用超时")), REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.execute(line, { signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(line) {
    let request;
    try { request = JSON.parse(line); } catch { throw new Error("移动预览工具请求不是有效 JSON"); }
    if (!request || typeof request !== "object" || Array.isArray(request) || request.version !== 1) {
      throw new Error("移动预览工具请求无效");
    }
    if (Object.keys(request).some((key) => !["version", "action", "arguments"].includes(key))) {
      throw new Error("移动预览工具不接受额外参数");
    }
    if (!ACTIONS.has(request.action)) throw new Error("未知移动预览工具操作");
    const handler = this.handlers[request.action.replace("mobile_preview_", "")];
    if (typeof handler !== "function") throw new Error("移动预览工具当前不可用");
    return handler(validateArguments(request.action, request.arguments));
  }

  async respond(socket, value) {
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload) > RESPONSE_LIMIT_BYTES) {
      socket.end(`${JSON.stringify(errorResponse("移动预览工具响应过大"))}\n`);
      return;
    }
    if (!socket.destroyed && socket.writable) await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function validateArguments(action, value) {
  const input = value === undefined ? {} : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("移动预览工具参数无效");
  const keys = Object.keys(input);
  if (action === "mobile_preview_click") {
    if (keys.some((key) => !["x", "y"].includes(key))) throw new Error("点击参数包含未知字段");
    if (!boundedNumber(input.x, 0, 389) || !boundedNumber(input.y, 0, 843)) throw new Error("点击坐标超出 390×844 预览范围");
    return { x: input.x, y: input.y };
  }
  if (action === "mobile_preview_type") {
    if (keys.some((key) => !["text", "clear"].includes(key))) throw new Error("输入参数包含未知字段");
    if (typeof input.text !== "string" || input.text.length > 2_000) throw new Error("输入文字必须是不超过 2000 字符的字符串");
    if (input.clear !== undefined && typeof input.clear !== "boolean") throw new Error("clear 必须是布尔值");
    return { text: input.text, clear: input.clear === true };
  }
  if (action === "mobile_preview_scroll") {
    if (keys.some((key) => !["deltaX", "deltaY"].includes(key))) throw new Error("滚动参数包含未知字段");
    if (!boundedNumber(input.deltaY, -5_000, 5_000) || input.deltaY === 0) throw new Error("deltaY 必须是 -5000 到 5000 之间的非零数值");
    if (input.deltaX !== undefined && !boundedNumber(input.deltaX, -5_000, 5_000)) throw new Error("deltaX 必须是 -5000 到 5000 之间的数值");
    return { deltaX: input.deltaX || 0, deltaY: input.deltaY };
  }
  if (keys.length) throw new Error("该移动预览工具不接受参数");
  return {};
}

function boundedNumber(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function errorResponse(message) {
  return { version: 1, ok: false, error: String(message || "移动预览工具调用失败").slice(0, 2_000) };
}
