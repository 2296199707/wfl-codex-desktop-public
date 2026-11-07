import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import ssh2 from "ssh2";
import { TemporarySshConnector } from "./temporary-ssh-connector.mjs";
import { WebSshFiles } from "./web-ssh-files.mjs";

const TICKET_TTL_MS = 30_000;
const OUTPUT_WINDOW_BYTES = 256 * 1024;

export class WebSshService {
  constructor(stateDirectory, {
    connector = new TemporarySshConnector({ timeoutMs: 30_000 }),
    resolvePersistent,
    ownerAllowed = async () => true,
    sessionAllowed = async () => true,
    resumeGraceMs = 5 * 60_000,
    now = () => Date.now(),
  } = {}) {
    this.directory = path.join(stateDirectory, "plugin-data", "web-ssh");
    this.storePath = path.join(this.directory, "connections.json");
    this.keyPath = path.join(this.directory, "master.key");
    this.connector = connector;
    this.resolvePersistent = resolvePersistent;
    this.ownerAllowed = ownerAllowed;
    this.sessionAllowed = sessionAllowed;
    this.now = now;
    this.resumeGraceMs = resumeGraceMs;
    this.data = { version: 1, targets: [], grants: [] };
    this.key = null;
    this.operation = Promise.resolve();
    this.tickets = new Map();
    this.sessions = new Set();
    this.fileSessions = new Map();
    this.resumeSessions = new Map();
    this.downloadTickets = new Map();
    this.sockets = new Set();
    this.sweeping = false;
    this.closed = false;
  }

  async initialize() {
    await this.reload().catch((error) => { this.loadError = error; });
    this.timer = setInterval(() => void this.sweep(), 5_000);
    this.timer.unref();
    return this;
  }

  async reload() {
    try {
      const data = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.targets) || !Array.isArray(data.grants)) {
        throw sshError(503, "网页 SSH 配置损坏，请检查备份");
      }
      this.key = await fs.readFile(this.keyPath);
      if (this.key.length !== 32) throw sshError(503, "网页 SSH 加密密钥无效");
      this.data = data;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const storeExists = await fs.stat(this.storePath).then(() => true, () => false);
      if (storeExists) throw sshError(503, "网页 SSH 加密密钥缺失，请恢复备份");
      this.data = { version: 1, targets: [], grants: [] };
    }
  }

  async mutate(operation) {
    const pending = this.operation.then(async () => {
      await this.reload();
      const data = { ...this.data, targets: [...this.data.targets], grants: [...this.data.grants] };
      const result = await operation(data);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!this.key) {
        try {
          await fs.writeFile(this.keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        this.key = await fs.readFile(this.keyPath);
      }
      const temporary = `${this.storePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(data)}\n`, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, this.storePath);
        this.data = data;
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
    this.operation = pending.catch(() => {});
    return pending;
  }

  async ensureKey() {
    if (this.key) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(this.keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    this.key = await fs.readFile(this.keyPath);
    if (this.key.length !== 32) throw sshError(503, "网页 SSH 加密密钥无效");
  }

  async snapshot(ownerId) {
    await this.reload();
    return {
      targets: this.data.targets.filter((target) => target.ownerId === ownerId).map(publicTarget),
      grants: this.data.grants.filter((grant) => grant.ownerId === ownerId).map((grant) => ({
        id: grant.id, name: grant.name, reference: grant.reference,
        mode: grant.mode || "key",
        createdAt: grant.createdAt, expiresAt: grant.expiresAt,
        expired: Boolean(grant.expiresAt && grant.expiresAt <= this.now()),
      })),
    };
  }

  async saveTarget(ownerId, input) {
    const target = normalizeWebSshTarget(input);
    const credentials = normalizeCredentials(input);
    const expectedFingerprint = normalizeFingerprint(input.hostKeyFingerprint);
    if (!expectedFingerprint) throw sshError(400, "请先确认服务器主机指纹");
    let connection;
    try {
      connection = await this.connector.connect({ ...target, ...credentials, expectedFingerprint });
      return await this.mutate(async (data) => {
        await this.ensureKey();
        const record = {
          ...target, id: `wssh-${crypto.randomBytes(12).toString("hex")}`, ownerId,
          hostKeyFingerprint: expectedFingerprint, createdAt: this.now(),
          authMode: credentials.privateKey ? "private-key" : "password",
        };
        record.credentials = this.encrypt(record.id, credentials);
        data.targets.push(record);
        return publicTarget(record);
      });
    } catch (error) {
      throw error.statusCode ? error : sshError(424, connectionError(error));
    } finally {
      connection?.client.end();
      credentials.password = "";
      credentials.privateKey = "";
      credentials.passphrase = "";
    }
  }

  async deleteTarget(ownerId, id) {
    await this.mutate((data) => {
      const target = data.targets.find((entry) => entry.id === id && entry.ownerId === ownerId);
      if (!target) throw sshError(404, "SSH 服务器不存在");
      data.targets = data.targets.filter((entry) => entry !== target);
      data.grants = data.grants.filter((grant) => grant.ownerId !== ownerId
        || grant.reference.kind !== "saved" || grant.reference.id !== id);
    });
    for (const session of this.sessions) {
      if (session.context.ownerId === ownerId && session.context.reference.kind === "saved"
        && session.context.reference.id === id) session.close("SSH 服务器已删除");
    }
  }

  async createGrant(ownerId, input) {
    const mode = input.mode ?? "key";
    if (!["key", "link"].includes(mode)) throw sshError(400, "SSH 分享方式无效");
    const reference = normalizeReference(input.reference);
    const target = await this.resolveTarget(ownerId, reference);
    const name = String(input.name || target.name || "SSH 访问").trim();
    if (!name || name.length > 120) throw sshError(400, "访问密钥名称无效");
    const accessKey = mode === "link" ? crypto.randomBytes(48).toString("base64url")
      : String(input.accessKey || crypto.randomBytes(32).toString("base64url")).trim();
    if (accessKey.length < 8 || accessKey.length > 512 || /[\x00-\x1f\x7f]/u.test(accessKey)) {
      throw sshError(400, "访问密钥需要至少 8 个字符，建议使用自动生成的随机密钥");
    }
    const duration = mode === "link" ? 0 : input.expiresInSeconds === undefined ? 86400 : Number(input.expiresInSeconds);
    if (!Number.isSafeInteger(duration) || duration < 0
      || !Number.isSafeInteger(this.now() + duration * 1000)) throw sshError(400, "访问密钥有效期无效");
    return this.mutate(async (data) => {
      if (reference.kind === "saved" && !data.targets.some((entry) => entry.id === reference.id && entry.ownerId === ownerId)) {
        throw sshError(404, "SSH 服务器已删除");
      }
      await this.ensureKey();
      const digest = this.keyDigest(accessKey);
      if (data.grants.some((grant) => grant.digest === digest)) throw sshError(409, "这个访问密钥已经使用，请换一个");
      const grant = {
        id: `ssh-access-${crypto.randomBytes(12).toString("hex")}`, ownerId, reference, name, mode,
        digest, createdAt: this.now(), expiresAt: duration ? this.now() + duration * 1000 : null,
      };
      if (mode === "link") grant.linkSecret = this.encrypt(grant.id, { accessKey });
      data.grants.push(grant);
      return { grant: { id: grant.id, name, reference, mode, expiresAt: grant.expiresAt }, accessKey };
    });
  }

  async readDirectLink(ownerId, id) {
    await this.reload();
    const grant = this.data.grants.find((entry) => entry.id === id && entry.ownerId === ownerId && entry.mode === "link");
    if (!grant) throw sshError(404, "SSH 直达链接不存在或已撤销");
    return { accessKey: this.decrypt(grant.id, grant.linkSecret).accessKey };
  }

  async revokeGrant(ownerId, id) {
    await this.mutate((data) => {
      const grant = data.grants.find((entry) => entry.id === id && entry.ownerId === ownerId);
      if (!grant) throw sshError(404, "访问密钥不存在");
      data.grants = data.grants.filter((entry) => entry !== grant);
    });
    for (const session of this.sessions) {
      if (session.context.grantId === id) session.close("访问密钥已撤销");
    }
    for (const [ticket, context] of this.tickets) {
      if (context.grantId === id) this.tickets.delete(ticket);
    }
  }

  async issueOwnerTicket(ownerId, reference, authSession = null) {
    if (!await this.ownerAllowed(ownerId)) throw sshError(403, "没有网页 SSH 管理权限");
    const normalized = normalizeReference(reference);
    const target = await this.resolveTarget(ownerId, normalized);
    return this.issueTicket({ ownerId, reference: normalized, authSession }, target);
  }

  async issueAccessTicket(accessKey, { mode } = {}) {
    await this.reload();
    const secret = String(accessKey || "").trim();
    const digest = this.key && secret && secret.length <= 512 ? this.keyDigest(secret) : null;
    const grant = digest ? this.data.grants.find((entry) => entry.digest === digest) : null;
    if (!grant || (mode && (grant.mode || "key") !== mode) || (grant.expiresAt && grant.expiresAt <= this.now())
      || !await this.ownerAllowed(grant.ownerId)) throw sshError(403,
      mode === "link" ? "直达链接无效或已撤销" : "访问密钥无效、已到期或已撤销");
    const target = await this.resolveTarget(grant.ownerId, grant.reference);
    return this.issueTicket({ ownerId: grant.ownerId, reference: grant.reference, grantId: grant.id }, target);
  }

  issueTicket(context, target) {
    if (this.closed) throw sshError(503, "SSH 服务正在重启，请稍后重连");
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { ...context, expiresAt: this.now() + TICKET_TTL_MS });
    return { ticket, target: publicTarget(target) };
  }

  async consumeTicket(ticket) {
    const context = this.tickets.get(String(ticket || ""));
    this.tickets.delete(String(ticket || ""));
    if (!context || context.expiresAt <= this.now()) throw sshError(403, "连接票据已失效，请重新登录 SSH");
    await this.reload();
    if (!await this.contextAllowed(context)) throw sshError(403, "SSH 访问授权已失效");
    return context;
  }

  async contextAllowed(context) {
    if (!await this.ownerAllowed(context.ownerId)) return false;
    if (context.authSession && !await this.sessionAllowed(context.authSession)) return false;
    if (context.grantId) {
      const grant = this.data.grants.find((entry) => entry.id === context.grantId
        && entry.ownerId === context.ownerId);
      if (!grant || (grant.expiresAt && grant.expiresAt <= this.now())
        || grant.reference.kind !== context.reference.kind || grant.reference.id !== context.reference.id) return false;
    }
    if (context.reference.kind === "saved") {
      return this.data.targets.some((entry) => entry.ownerId === context.ownerId && entry.id === context.reference.id);
    }
    try {
      await this.resolveTarget(context.ownerId, context.reference);
    } catch (error) {
      if ([404, 409].includes(error.statusCode)) return false;
      throw error;
    }
    return true;
  }

  async resolveTarget(ownerId, reference) {
    if (reference.kind === "persistent") {
      if (!this.resolvePersistent) throw sshError(404, "持久 SSH 服务器不可用");
      const target = await this.resolvePersistent(ownerId, reference.id);
      if (target.authMode === "public-key") throw sshError(409, "AI 专用公钥禁用了交互终端，请在网页 SSH 中单独添加此服务器的密码或私钥");
      return target;
    }
    await this.reload();
    const target = this.data.targets.find((entry) => entry.ownerId === ownerId && entry.id === reference.id);
    if (!target) throw sshError(404, "SSH 服务器不存在");
    return target;
  }

  async connectContext(context) {
    const target = await this.resolveTarget(context.ownerId, context.reference);
    if (context.reference.kind === "persistent") return target.connect();
    const credentials = this.decrypt(target.id, target.credentials);
    try {
      return await this.connector.connect({ ...target, ...credentials, expectedFingerprint: target.hostKeyFingerprint,
        keepaliveInterval: 15_000, keepaliveCountMax: 6 });
    } finally {
      credentials.password = "";
      credentials.privateKey = "";
      credentials.passphrase = "";
    }
  }

  accept(socket, { onAuthenticated = () => {} } = {}) {
    if (this.closed) { socket.close(1012, "SSH service restarting"); return; }
    let session = null;
    let authenticating = false;
    const deadline = setTimeout(() => socket.close(1008, "SSH authentication required"), 10_000);
    deadline.unref();
    this.sockets.add(socket);
    socket.on("error", () => session?.detach(socket));
    socket.on("pong", () => { socket.isAlive = true; });
    socket.once("close", () => { clearTimeout(deadline); this.sockets.delete(socket); session?.detach(socket); });
    socket.on("message", (raw, binary) => {
      void (async () => {
        if (binary) throw sshError(400, "SSH 输入格式无效");
        const message = JSON.parse(raw.toString());
        if (!session) {
          if (authenticating || !["authenticate", "resume"].includes(message.type)) return;
          authenticating = true;
          if (message.type === "resume") {
            const resumed = await this.findResumeSession(message.resumeToken);
            if (socket.readyState !== 1) return;
            clearTimeout(deadline);
            resumed.attach(socket, message.cols, message.rows);
            session = resumed;
            onAuthenticated(resumed.context);
            return;
          }
          const context = await this.consumeTicket(message.ticket);
          clearTimeout(deadline);
          if (socket.readyState !== 1) return;
          onAuthenticated(context);
          session = this.openSession(socket, context, message.cols, message.rows);
          return;
        }
        if (session.socket === socket) session.input(message);
      })().catch((error) => {
        sendControl(socket, { type: "error", statusCode: error.statusCode,
          message: error.statusCode ? error.message : "SSH 连接或输入失败" });
        if (session) session.close();
        else socket.close(1008, "SSH authentication failed");
      });
    });
  }

  openSession(socket, context, cols, rows) {
    const session = {
      socket, context, client: null, channel: null, pendingBytes: 0, closed: false,
      files: null, fileToken: null, resumeToken: null, detachedAt: null, detachedOutput: [],
      cols: normalizeDimension(cols, 80), rows: normalizeDimension(rows, 24),
      close: (message = null) => {
        if (session.closed) return;
        session.closed = true;
        this.sessions.delete(session);
        this.fileSessions.delete(session.fileToken);
        this.resumeSessions.delete(session.resumeToken);
        for (const [ticket, download] of this.downloadTickets) {
          if (download.session === session) this.downloadTickets.delete(ticket);
        }
        session.files?.close();
        const attached = session.socket;
        session.socket = null;
        if (message && attached) sendControl(attached, { type: "error", terminalClosed: true, message });
        session.channel?.end();
        session.client?.end();
        if (attached?.readyState === 1) attached.close(1000, "SSH disconnected");
      },
      detach: (attached) => {
        if (session.closed || session.socket !== attached) return;
        if (!session.resumeToken) { session.close(); return; }
        session.socket = null;
        session.detachedAt = this.now();
        session.pendingBytes = 0;
        session.channel?.pause();
        session.channel?.stderr?.pause();
      },
      attach: (attached, newCols, newRows) => {
        if (session.closed || this.closed) throw sshError(403, "原终端已结束，请重新登录 SSH");
        if (session.socket?.readyState === 1) throw sshError(409, "原连接仍在释放，请稍后重试恢复");
        session.socket = attached;
        session.detachedAt = null;
        session.cols = normalizeDimension(newCols, session.cols);
        session.rows = normalizeDimension(newRows, session.rows);
        session.channel.setWindow(session.rows, session.cols, 0, 0);
        sendControl(attached, { type: "ready", resumed: true,
          fileToken: session.fileToken, resumeToken: session.resumeToken, resumeGraceMs: this.resumeGraceMs });
        for (const bytes of session.detachedOutput) session.output(bytes);
        session.detachedOutput = [];
        if (session.pendingBytes < OUTPUT_WINDOW_BYTES) {
          session.channel.resume();
          session.channel.stderr?.resume();
        }
      },
      output: (chunk) => {
        if (session.closed) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!session.socket || session.socket.readyState !== 1) {
          session.detachedOutput.push(bytes);
          session.channel.pause();
          session.channel.stderr?.pause();
          return;
        }
        const attached = session.socket;
        session.pendingBytes += bytes.length;
        attached.send(bytes, { binary: true }, (sendError) => { if (sendError) session.detach(attached); });
        if (session.pendingBytes >= OUTPUT_WINDOW_BYTES) {
          session.channel.pause();
          session.channel.stderr?.pause();
        }
      },
      input: (message) => {
        if (session.closed) return;
        if (message.type === "disconnect") {
          session.close();
        } else if (message.type === "resize") {
          session.cols = normalizeDimension(message.cols, session.cols);
          session.rows = normalizeDimension(message.rows, session.rows);
          session.channel?.setWindow(session.rows, session.cols, 0, 0);
        } else if (message.type === "input" && session.channel) {
          if (typeof message.data !== "string" || Buffer.byteLength(message.data) > 64 * 1024) {
            throw sshError(400, "单次终端输入过大，请分段粘贴");
          }
          session.channel.write(message.data);
        } else if (message.type === "ack" && Number.isSafeInteger(message.bytes)
          && message.bytes > 0 && message.bytes <= session.pendingBytes) {
          session.pendingBytes -= message.bytes;
          if (session.pendingBytes < OUTPUT_WINDOW_BYTES) {
            session.channel?.resume();
            session.channel?.stderr?.resume();
          }
        }
      },
    };
    this.sessions.add(session);
    void (async () => {
      const connection = await this.connectContext(context);
      session.client = connection.client;
      if (session.closed || socket.readyState !== 1) { connection.client.end(); return; }
      connection.client.on("error", (error) => session.close(connectionError(error)));
      connection.client.once("close", () => session.close());
      await this.reload();
      if (session.closed || socket.readyState !== 1) { connection.client.end(); return; }
      if (!await this.contextAllowed(context)) { session.close("SSH 访问授权已失效"); return; }
      connection.client.shell({ term: "xterm-256color", cols: session.cols, rows: session.rows }, (error, channel) => {
        if (error) { session.close("服务器无法创建交互式终端"); return; }
        session.channel = channel;
        if (session.closed) { channel.end(); return; }
        channel.on("data", session.output);
        channel.stderr?.on("data", session.output);
        channel.on("error", () => session.close("SSH 终端连接中断"));
        channel.on("exit", (code, signal) => {
          if (session.socket) sendControl(session.socket, { type: "exit", code, signal });
        });
        channel.once("close", () => session.close());
        session.files = new WebSshFiles(connection.client);
        session.fileToken = crypto.randomBytes(32).toString("base64url");
        this.fileSessions.set(session.fileToken, session);
        session.resumeToken = crypto.randomBytes(32).toString("base64url");
        this.resumeSessions.set(session.resumeToken, session);
        sendControl(socket, { type: "ready", fileToken: session.fileToken,
          resumeToken: session.resumeToken, resumeGraceMs: this.resumeGraceMs });
      });
    })().catch((error) => session.close(connectionError(error)));
    return session;
  }

  async findResumeSession(token) {
    const session = typeof token === "string" ? this.resumeSessions.get(token) : null;
    if (!session || session.closed || this.closed
      || (session.detachedAt !== null && this.now() - session.detachedAt >= this.resumeGraceMs)) {
      throw sshError(403, "原终端已结束或恢复期限已过，请重新登录 SSH");
    }
    await this.reload();
    if (!await this.contextAllowed(session.context) || session.closed) throw sshError(403, "SSH 访问授权已失效");
    if (session.socket?.readyState === 1) throw sshError(409, "原连接仍在释放，请稍后重试恢复");
    return session;
  }

  async authorizeFiles(token) {
    const session = typeof token === "string" ? this.fileSessions.get(token) : null;
    if (this.closed || !session || session.closed
      || (session.detachedAt !== null && this.now() - session.detachedAt >= this.resumeGraceMs)) {
      throw sshError(403, "文件会话无效，请先连接 SSH 终端");
    }
    await this.reload();
    if (!await this.contextAllowed(session.context) || session.closed || this.closed) {
      throw sshError(403, "SSH 文件访问授权已失效");
    }
    return session;
  }

  async withFiles(token, operation, options) {
    const session = await this.authorizeFiles(token);
    return session.files.run(operation, options);
  }

  async disconnectResume(token) {
    const session = typeof token === "string" ? this.resumeSessions.get(token) : null;
    if (!session || session.closed) return;
    await this.reload();
    if (!await this.contextAllowed(session.context)) throw sshError(403, "SSH 访问授权已失效");
    session.close();
  }

  async issueDownload(token, remotePath) {
    const session = await this.authorizeFiles(token);
    const description = await session.files.run((remote) => remote.describe(remotePath));
    if (session.closed) throw sshError(410, "SSH 会话已关闭");
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.downloadTickets.set(ticket, { session, path: remotePath, expiresAt: this.now() + TICKET_TTL_MS });
    return { ticket, name: description.name };
  }

  async useDownload(ticket, operation, options) {
    const download = this.downloadTickets.get(ticket);
    this.downloadTickets.delete(ticket);
    if (!download || download.expiresAt <= this.now()) throw sshError(403, "下载链接已失效，请重新点击下载");
    const session = await this.authorizeFiles(download.session.fileToken);
    return session.files.run((remote) => operation(remote, download.path), options);
  }

  async sweep() {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      for (const [ticket, context] of this.tickets) {
        if (context.expiresAt <= this.now()) this.tickets.delete(ticket);
      }
      for (const [ticket, download] of this.downloadTickets) {
        if (download.expiresAt <= this.now()) this.downloadTickets.delete(ticket);
      }
      if (!this.sessions.size) return;
      await this.reload();
      for (const session of this.sessions) {
        if (!await this.contextAllowed(session.context)) session.close("SSH 访问授权已失效");
        else if (!session.socket) {
          if (this.now() - session.detachedAt >= this.resumeGraceMs) session.close();
        }
        else if (session.socket.isAlive === false) session.socket.terminate();
        else {
          session.socket.isAlive = false;
          session.socket.ping();
        }
      }
    } catch {
      for (const session of this.sessions) session.close("无法验证 SSH 授权，请重新连接");
    } finally {
      this.sweeping = false;
    }
  }

  encrypt(id, credentials) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`web-ssh:${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") };
  }

  decrypt(id, encrypted) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(encrypted.iv, "base64"));
      decipher.setAAD(Buffer.from(`web-ssh:${id}`));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8"));
    } catch {
      throw sshError(503, "无法解密服务器凭据，请检查备份");
    }
  }

  keyDigest(secret) {
    return crypto.createHmac("sha256", this.key).update(secret).digest("hex");
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.tickets.clear();
    this.downloadTickets.clear();
    for (const session of this.sessions) session.close("SSH 服务正在重启，请重新连接");
    for (const socket of this.sockets) socket.close(1012, "SSH service restarting");
  }
}

export function normalizeWebSshTarget(input) {
  const host = String(input.host || "").trim().replace(/^\[|\]$/gu, "");
  const port = Number(input.port ?? 22);
  const username = String(input.username || "").trim();
  const name = String(input.name || host).trim();
  if ((!net.isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(host))
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !username || username.length > 128 || /[\x00-\x20\x7f]/u.test(username)
    || !name || name.length > 120) throw sshError(400, "服务器名称、地址、端口或用户名无效");
  return { name, host, port, username };
}

export async function inspectWebSshHostKey(input, { timeoutMs = 15_000 } = {}) {
  const target = normalizeWebSshTarget({ ...input, username: "wfl-host-key-check" });
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let fingerprint = null;
    const timer = setTimeout(() => { client.destroy(); reject(sshError(504, "读取服务器主机指纹超时")); }, timeoutMs);
    client.on("error", (error) => {
      clearTimeout(timer);
      if (!fingerprint) reject(sshError(424, connectionError(error)));
    });
    client.connect({
      host: target.host, port: target.port, username: target.username, readyTimeout: timeoutMs,
      hostVerifier: (key) => {
        fingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
        clearTimeout(timer);
        resolve({ hostKeyFingerprint: fingerprint });
        return false;
      },
    });
  });
}

function normalizeCredentials(input) {
  const password = String(input.password || "");
  const privateKey = String(input.privateKey || "");
  const passphrase = String(input.passphrase || "");
  if ((!password && !privateKey) || (password && privateKey) || privateKey.length > 65536
    || password.length > 4096 || passphrase.length > 4096) throw sshError(400, "请填写密码或私钥中的一种");
  return { password, privateKey, passphrase };
}

function normalizeFingerprint(value) {
  const fingerprint = String(value || "");
  if (fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(fingerprint)) throw sshError(400, "主机指纹格式无效");
  return fingerprint;
}

function normalizeReference(value) {
  if (!["saved", "persistent"].includes(value?.kind) || typeof value.id !== "string"
    || !/^[A-Za-z0-9-]{1,120}$/u.test(value.id)) throw sshError(400, "请选择 SSH 服务器");
  return { kind: value.kind, id: value.id };
}

function publicTarget(target) {
  return Object.fromEntries(["id", "name", "host", "port", "username", "hostKeyFingerprint", "authMode", "createdAt"]
    .filter((field) => target[field] !== undefined).map((field) => [field, target[field]]));
}

function normalizeDimension(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

function sendControl(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function connectionError(error) {
  if (error.statusCode) return error.message;
  if (error.level === "client-authentication") return "SSH 认证失败，请检查服务器账号、密码或私钥";
  if (error.level === "host-verification") return "SSH 主机指纹不匹配，请由管理员核实服务器身份";
  if (error.message === "Host denied (verification failed)") return "SSH 主机指纹不匹配，请由管理员核实服务器身份";
  if (["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code)) return "SSH 连接超时或网络不可达";
  if (error.code === "ECONNREFUSED") return "目标服务器拒绝 SSH 连接，请检查端口";
  if (error.code === "ENOTFOUND") return "无法解析目标服务器地址";
  return "无法连接 SSH 服务器，请检查地址、端口和认证设置";
}

function sshError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
