import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 130_000;
const REQUEST_LIMIT_BYTES = 96 * 1024;
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export class PersistentSshToolService {
  constructor({
    directory,
    userId,
    uid = null,
    gid = null,
    list,
    execute,
  }) {
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.list = list;
    this.execute = execute;
    this.server = null;
    this.sockets = new Set();
    const identity = crypto
      .createHash("sha256")
      .update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`)
      .digest("hex")
      .slice(0, 24);
    // sockaddr_un only leaves 107 bytes for a pathname on Linux. User ids can
    // already be recovered through the owning service instance, so including
    // them in the filename only makes otherwise valid runtime directories
    // fail after listen() with a misleading ENOENT during chmod(). Keep the
    // unpredictable identity while using the same bounded filename length for
    // every user.
    this.socketPath = path.join(this.directory, `s-${identity}.sock`);
  }

  async start() {
    if (this.server) return this.socketPath;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    const directoryStat = await fs.lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Persistent SSH tool socket directory is unsafe");
    }
    await fs.chmod(this.directory, 0o711);
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });

    const server = net.createServer((socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      await fs.chmod(this.socketPath, 0o600);
      if (this.uid !== null && this.gid !== null) {
        await fs.chown(this.socketPath, this.uid, this.gid);
      }
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
    let settled = false;
    const close = () => {
      this.sockets.delete(socket);
      if (!socket.destroyed) socket.destroy();
    };
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", close);
    socket.on("timeout", () => {
      if (settled) return;
      settled = true;
      void this.respond(socket, { ok: false, error: "SSH 工具调用超时" }).finally(close);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) {
        settled = true;
        void this.respond(socket, { ok: false, error: "SSH 工具请求过大" }).finally(close);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      settled = true;
      void this.executeRequest(buffer.slice(0, newline).trim())
        .then((result) => this.respond(socket, { ok: true, result }))
        .catch((error) => this.respond(socket, {
          ok: false,
          error: boundedErrorMessage(error),
          statusCode: Number(error?.statusCode) || 500,
        }))
        .finally(close);
    });
  }

  async executeRequest(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error("SSH 工具请求不是有效 JSON");
    }
    if (!request || typeof request !== "object" || Array.isArray(request) || request.version !== 1) {
      throw new Error("SSH 工具请求无效");
    }
    if (request.action === "list") return this.list();
    if (request.action === "execute") {
      return this.execute({
        serverId: request.serverId,
        command: request.command,
        timeoutMs: request.timeoutMs,
      });
    }
    throw new Error("未知的 SSH 工具操作");
  }

  async respond(socket, value) {
    if (socket.destroyed || !socket.writable) return;
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload) > RESPONSE_LIMIT_BYTES) {
      socket.end(`${JSON.stringify({ ok: false, error: "SSH 工具响应过大" })}\n`);
      return;
    }
    await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    }
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function boundedErrorMessage(error) {
  const message = String(error?.message || "SSH 工具调用失败").trim();
  return (message || "SSH 工具调用失败").slice(0, 2_000);
}
