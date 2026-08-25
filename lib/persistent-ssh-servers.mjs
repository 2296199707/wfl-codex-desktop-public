import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TemporarySshConnector } from "./temporary-ssh-connector.mjs";

const STORE_VERSION = 2;
const SUPPORTED_STORE_VERSIONS = new Set([1, STORE_VERSION]);
const MAX_SERVERS = 20;
const MAX_NAME_LENGTH = 80;
const MAX_COMMAND_LENGTH = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MASTER_KEY_BYTES = 32;
// Keep one authenticated connection per enabled profile for a bounded idle
// window.  This mirrors the temporary SSH password-control path and avoids a
// fresh SSH handshake for every MCP command while still releasing idle
// sockets.
const CONNECTION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAYS_MS = Object.freeze([300, 800]);
const RETRYABLE_CONNECT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_SOCKET_CLOSED",
]);
const KEY_ALGORITHMS = Object.freeze([
  { id: "ed25519", type: "ed25519", publicType: "ssh-ed25519" },
  { id: "rsa-3072", type: "rsa", publicType: "ssh-rsa" },
]);
const AUTH_MODES = new Set(["public-key", "password"]);

/**
 * Persistent SSH profiles deliberately live outside the browser and never
 * expose private key material to the Codex process. The MCP broker calls this
 * store through a per-runtime Unix socket.
 */
export class PersistentSshServerStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    connector = new TemporarySshConnector(),
    keyGenerator = generateKeyPair,
  } = {}) {
    this.stateDirectory = path.resolve(String(stateDirectory || ""));
    this.directory = path.join(this.stateDirectory, "plugin-data", "persistent-ssh-servers");
    this.storePath = path.join(this.directory, "servers.json");
    this.masterKeyPath = path.join(this.directory, "master.key");
    this.now = now;
    this.connector = connector;
    this.keyGenerator = keyGenerator;
    this.records = new Map();
    this.activeClients = new Map();
    this.connectionEntries = new Map();
    this.operation = Promise.resolve();
    this.pendingOperationCount = 0;
    this.loadError = null;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      this.loadError = new Error("持久 SSH 配置目录不安全");
      return this;
    }
    await fs.chmod(this.directory, 0o700);
    try {
      const storeStat = await ensurePrivateFile(this.storePath, { allowMissing: true });
      if (storeStat) {
        const parsed = JSON.parse(await fs.readFile(this.storePath, "utf8"));
        if (!SUPPORTED_STORE_VERSIONS.has(parsed?.version) || !Array.isArray(parsed.servers)) {
          throw new Error("持久 SSH 配置版本不受支持");
        }
        for (const value of parsed.servers) {
          const record = normalizeStoredServer(value);
          this.records.set(record.id, record);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.loadError = error;
        this.records.clear();
      }
    }
    try {
      const masterKeyStat = await ensurePrivateFile(this.masterKeyPath, { allowMissing: true });
      if (!masterKeyStat && this.records.size > 0) {
        throw new Error("持久 SSH 配置缺少主密钥");
      }
      if (masterKeyStat) {
        const masterKey = await fs.readFile(this.masterKeyPath);
        if (masterKey.length !== MASTER_KEY_BYTES) {
          throw new Error("持久 SSH 主密钥长度不正确");
        }
      }
    } catch (error) {
      this.loadError ||= error;
      this.records.clear();
    }
    return this;
  }

  get pendingOperations() {
    return this.pendingOperationCount;
  }

  get busy() {
    return this.pendingOperationCount > 0 || this.activeClients.size > 0;
  }

  snapshot({ enabledOnly = false, includePrivate = false } = {}) {
    if (enabledOnly && this.loadError) return [];
    return [...this.records.values()]
      .filter((record) => !enabledOnly || record.enabled === true)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => includePrivate ? { ...record } : publicServer(record));
  }

  publicServer(id) {
    const record = this.records.get(String(id || ""));
    if (!record) throw persistentSshError(404, "SSH 服务器不存在");
    return publicServer(record);
  }

  async create(input) {
    return this.queueOperation(() => this.createNow(input));
  }

  async createNow(input) {
    this.assertWritable();
    if (this.records.size >= MAX_SERVERS) {
      throw persistentSshError(409, `最多保存 ${MAX_SERVERS} 台持久 SSH 服务器`);
    }
    const target = normalizeTarget(input);
    const name = normalizeName(input?.name);
    const workingDirectory = normalizeWorkingDirectory(input?.workingDirectory);
    let password = normalizePassword(input?.password);
    const allowPasswordCompatibility = input?.allowPasswordCompatibility === true;
    const id = `pssh-${crypto.randomBytes(8).toString("hex")}`;
    const marker = `wfl-persistent-access-${id}`;
    const createdAt = this.now();
    let keyPair = null;
    let installed = false;
    let installedInfo = null;
    let selectedAlgorithm = null;
    let passwordFallback = null;
    try {
      for (const algorithm of KEY_ALGORITHMS) {
        try {
          keyPair = await this.keyGenerator(this.directory, id, marker, algorithm.id);
        } catch (error) {
          // If password authentication already succeeded, a local RSA/Ed25519
          // key-generation failure can still use the explicitly approved
          // password-compatible mode.
          if (passwordFallback && allowPasswordCompatibility) break;
          throw error;
        }
        const publicParts = String(keyPair.publicKey || "").trim().split(/\s+/);
        if (
          publicParts.length < 2
          || publicParts[0] !== algorithm.publicType
          || !/^[A-Za-z0-9+/=]+$/.test(publicParts[1])
        ) {
          await keyPair.cleanup?.().catch(() => {});
          keyPair = null;
          throw new Error(`生成的 ${algorithm.id} SSH 公钥格式不正确`);
        }
        const authorizedKeyLine = [
          "no-agent-forwarding",
          "no-port-forwarding",
          "no-X11-forwarding",
          "no-pty",
          publicParts[0],
          publicParts[1],
          marker,
        ].join(" ");
        try {
          installedInfo = await this.connector.install({
            target,
            password,
            authorizedKeyLine,
            marker,
            privateKey: keyPair.privateKey,
            expectedFingerprint: passwordFallback?.hostKeyFingerprint || null,
          });
          installed = true;
          selectedAlgorithm = algorithm;
          break;
        } catch (error) {
          await keyPair.cleanup?.().catch(() => {});
          keyPair = null;
          if (!validHostKeyResponse(error.passwordFallback)) throw error;
          passwordFallback = error.passwordFallback;
        }
      }

      let record;
      if (installed && keyPair && selectedAlgorithm) {
        const publicParts = String(keyPair.publicKey || "").trim().split(/\s+/);
        const encryptedPrivateKey = await this.encryptPrivateKey(id, keyPair.privateKey);
        record = normalizeStoredServer({
          id,
          name,
          host: target.host,
          port: target.port,
          username: target.username,
          workingDirectory,
          enabled: true,
          authMode: "public-key",
          keyAlgorithm: selectedAlgorithm.id,
          hostKeyFingerprint: installedInfo.hostKeyFingerprint,
          hostKey: installedInfo.hostKey,
          publicKey: `${publicParts[0]} ${publicParts[1]}`,
          marker,
          encryptedPrivateKey,
          createdAt,
          updatedAt: createdAt,
          lastTestAt: createdAt,
          lastUsedAt: null,
        });
      } else {
        if (!allowPasswordCompatibility || !validHostKeyResponse(passwordFallback)) {
          const error = persistentSshError(
            424,
            "目标服务器拒绝 ED25519 和 RSA-3072 公钥；请勾选允许加密保存密码的兼容模式后重试",
          );
          error.code = "ERR_PERSISTENT_SSH_PUBLIC_KEY_REJECTED";
          error.passwordCompatibilityAvailable = validHostKeyResponse(passwordFallback);
          throw error;
        }
        record = normalizeStoredServer({
          id,
          name,
          host: target.host,
          port: target.port,
          username: target.username,
          workingDirectory,
          enabled: true,
          authMode: "password",
          keyAlgorithm: null,
          hostKeyFingerprint: passwordFallback.hostKeyFingerprint,
          hostKey: passwordFallback.hostKey,
          publicKey: null,
          marker,
          encryptedPassword: await this.encryptPassword(id, password),
          encryptedPrivateKey: null,
          createdAt,
          updatedAt: createdAt,
          lastTestAt: createdAt,
          lastUsedAt: null,
        });
      }
      this.records.set(id, record);
      await this.writeStore();
      return publicServer(record);
    } catch (error) {
      this.records.delete(id);
      if (installed && keyPair?.privateKey) {
        await this.connector.remove({
          target,
          privateKey: keyPair.privateKey,
          marker,
          expectedFingerprint: installedInfo?.hostKeyFingerprint || null,
        }).catch(() => {});
      }
      if (error.statusCode) throw error;
      throw persistentSshError(424, "SSH 密码认证失败、主机不可达或服务器拒绝持久公钥");
    } finally {
      password = "";
      await keyPair?.cleanup?.().catch(() => {});
    }
  }

  async setEnabled(id, enabled) {
    return this.queueOperation(() => this.setEnabledNow(id, enabled));
  }

  async setEnabledNow(id, enabled) {
    this.assertWritable();
    const record = this.requireRecord(id);
    const desired = enabled === true;
    if (record.enabled === desired) return publicServer(record);
    const previous = record.enabled;
    record.enabled = desired;
    record.updatedAt = this.now();
    if (!desired) await this.disconnect(record.id);
    try {
      await this.writeStore();
    } catch (error) {
      record.enabled = previous;
      throw error;
    }
    return publicServer(record);
  }

  async test(id) {
    const record = this.requireEnabledRecord(id);
    const connection = await this.connectRecord(record);
    const entry = connection.entry;
    this.acquireConnection(entry, record.id, connection.client);
    try {
      if (!this.records.get(record.id)?.enabled) {
        throw persistentSshError(409, "此 SSH 服务器已关闭，AI 不能继续访问");
      }
      record.lastTestAt = this.now();
      record.updatedAt = record.lastTestAt;
      await this.queueOperation(() => this.writeStore());
      return {
        ok: true,
        id: record.id,
        hostKeyFingerprint: record.hostKeyFingerprint,
        testedAt: record.lastTestAt,
      };
    } finally {
      this.releaseConnection(entry, record.id, connection.client);
    }
  }

  async execute(id, command, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    const record = this.requireEnabledRecord(id);
    const normalizedCommand = normalizeCommand(command);
    const timeout = normalizeTimeout(timeoutMs);
    const connection = await this.connectRecord(record);
    const entry = connection.entry;
    this.acquireConnection(entry, record.id, connection.client);
    try {
      if (!this.records.get(record.id)?.enabled) {
        throw persistentSshError(409, "此 SSH 服务器已关闭，AI 不能继续访问");
      }
      const prefix = record.workingDirectory
        ? `cd -- ${shellQuote(record.workingDirectory)} && `
        : "";
      const result = await executeRemoteCommand(
        connection.client,
        `${prefix}${normalizedCommand}`,
        timeout,
        () => this.dropConnectionEntry(entry, { end: true }),
      );
      record.lastUsedAt = this.now();
      record.updatedAt = record.lastUsedAt;
      await this.queueOperation(() => this.writeStore()).catch(() => {});
      return {
        id: record.id,
        name: record.name,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      };
    } finally {
      this.releaseConnection(entry, record.id, connection.client);
    }
  }

  async revoke(id) {
    return this.queueOperation(() => this.revokeNow(id));
  }

  async revokeNow(id) {
    this.assertWritable();
    const record = this.requireRecord(id);
    await this.disconnect(record.id);
    if (record.authMode === "public-key") {
      const privateKey = await this.decryptPrivateKey(record);
      try {
        await this.connector.remove({
          target: pickTarget(record),
          privateKey,
          marker: record.marker,
          expectedFingerprint: record.hostKeyFingerprint,
        });
      } catch (error) {
        throw error.statusCode ? error : persistentSshError(424, "无法连接服务器撤销 SSH 公钥；配置仍保留");
      }
    }
    this.records.delete(record.id);
    await this.writeStore();
    return { revoked: true, id: record.id };
  }

  async disconnect(id) {
    const ids = id
      ? [String(id)]
      : [...new Set([
        ...this.connectionEntries.keys(),
        ...this.activeClients.keys(),
      ])];
    const clients = new Set();
    for (const profileId of ids) {
      const entry = this.connectionEntries.get(profileId);
      if (entry) {
        if (entry.client) clients.add(entry.client);
        this.dropConnectionEntry(entry, { end: true });
      }
      for (const client of this.activeClients.get(profileId) || []) {
        clients.add(client);
        try {
          client.end();
        } catch {
          // The profile is already being disabled/revoked. A broken client
          // should not make that safety switch fail.
        }
      }
      this.activeClients.delete(profileId);
    }
    return clients.size;
  }

  async disconnectAll() {
    return this.disconnect(null);
  }

  async close() {
    await this.disconnectAll();
  }

  requireEnabledRecord(id) {
    const record = this.records.get(String(id || ""));
    // Do not disclose whether a disabled ID exists to the AI broker.
    if (!record || record.enabled !== true) {
      throw persistentSshError(404, "SSH 服务器不可用");
    }
    return record;
  }

  requireRecord(id) {
    const record = this.records.get(String(id || ""));
    if (!record) throw persistentSshError(404, "SSH 服务器不存在");
    return record;
  }

  assertWritable() {
    if (this.loadError) throw persistentSshError(503, "持久 SSH 配置损坏，已停止写入，请先备份并修复配置");
  }

  async connectRecord(record) {
    const existing = this.connectionEntries.get(record.id);
    if (existing) {
      if (existing.promise) return existing.promise;
      if (!existing.closed && isUsableSshClient(existing.client)) {
        this.touchConnection(existing);
        return connectionResult(existing);
      }
      this.dropConnectionEntry(existing, { end: true });
    }

    const entry = {
      id: record.id,
      client: null,
      connection: null,
      promise: null,
      activeCount: 0,
      idleTimer: null,
      listeners: null,
      closed: false,
    };
    this.connectionEntries.set(record.id, entry);
    entry.promise = this.openConnection(record, entry)
      .then(() => connectionResult(entry))
      .finally(() => {
        entry.promise = null;
      });
    try {
      return await entry.promise;
    } catch (error) {
      this.dropConnectionEntry(entry, { end: true });
      throw error;
    }
  }

  async openConnection(record, entry) {
    let credentials = null;
    try {
      credentials = record.authMode === "password"
        ? { password: await this.decryptPassword(record) }
        : { privateKey: await this.decryptPrivateKey(record) };
      for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
        try {
          const connection = await this.connector.connect({
            ...pickTarget(record),
            ...credentials,
            expectedFingerprint: record.hostKeyFingerprint,
          });
          if (
            entry.closed
            || !this.records.get(record.id)?.enabled
          ) {
            connection.client.end();
            throw persistentSshError(404, "SSH 服务器不可用");
          }
          entry.client = connection.client;
          entry.connection = connection;
          this.attachConnectionListeners(entry);
          this.touchConnection(entry);
          return;
        } catch (error) {
          if (
            attempt + 1 >= MAX_CONNECT_ATTEMPTS
            || entry.closed
            || !isRetryableConnectError(error)
          ) throw error;
          await delay(CONNECT_RETRY_DELAYS_MS[attempt] || CONNECT_RETRY_DELAYS_MS.at(-1));
        }
      }
    } finally {
      if (credentials) {
        credentials.password = "";
        credentials.privateKey = "";
      }
    }
  }

  attachConnectionListeners(entry) {
    const client = entry.client;
    if (!client || typeof client.on !== "function") return;
    const onConnectionError = () => this.dropConnectionEntry(entry, { end: false });
    const onConnectionEnd = () => this.dropConnectionEntry(entry, { end: false });
    const onConnectionClose = () => this.dropConnectionEntry(entry, { end: false });
    entry.listeners = { onConnectionError, onConnectionEnd, onConnectionClose };
    client.on("error", onConnectionError);
    client.on("end", onConnectionEnd);
    client.on("close", onConnectionClose);
  }

  acquireConnection(entry, id, client) {
    if (!entry || entry.closed) return;
    entry.activeCount += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const active = this.activeClients.get(id) || new Set();
    active.add(client);
    this.activeClients.set(id, active);
  }

  releaseConnection(entry, id, client) {
    if (entry && entry.activeCount > 0) entry.activeCount -= 1;
    const active = this.activeClients.get(id);
    if (active && (!entry || entry.activeCount === 0)) {
      active.delete(client);
      if (!active.size) this.activeClients.delete(id);
    }
    if (entry && !entry.closed) this.touchConnection(entry);
  }

  touchConnection(entry) {
    if (!entry || entry.closed || !entry.client) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.closed) return;
      if (entry.activeCount > 0) {
        this.touchConnection(entry);
        return;
      }
      this.dropConnectionEntry(entry, { end: true });
    }, CONNECTION_IDLE_TIMEOUT_MS);
    entry.idleTimer.unref?.();
  }

  dropConnectionEntry(entry, { end = true } = {}) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.connectionEntries.get(entry.id) === entry) {
      this.connectionEntries.delete(entry.id);
    }
    const client = entry.client;
    const listeners = entry.listeners;
    if (client && listeners && typeof client.removeListener === "function") {
      client.removeListener("error", listeners.onConnectionError);
      client.removeListener("end", listeners.onConnectionEnd);
      client.removeListener("close", listeners.onConnectionClose);
    }
    entry.listeners = null;
    if (end && client) {
      try {
        client.end();
      } catch {
        // A connection that is already closing is safe to discard.
      }
    }
  }

  async encryptPrivateKey(id, privateKey) {
    const key = await this.masterKey(true);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const aad = Buffer.from(`wfl-persistent-ssh:${id}`);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(String(privateKey), "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  async decryptPrivateKey(record) {
    const encrypted = record.encryptedPrivateKey;
    if (
      encrypted?.algorithm !== "aes-256-gcm"
      || !encrypted.iv
      || !encrypted.tag
      || !encrypted.ciphertext
    ) throw persistentSshError(503, "SSH 私钥加密数据无效");
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        await this.masterKey(false),
        Buffer.from(encrypted.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(`wfl-persistent-ssh:${record.id}`));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw persistentSshError(503, "无法解密 SSH 私钥；请检查服务器密钥文件");
    }
  }

  async encryptPassword(id, password) {
    return this.encryptSecret(id, "password", password);
  }

  async decryptPassword(record) {
    const encrypted = record.encryptedPassword;
    if (!encrypted) throw persistentSshError(503, "SSH 密码加密数据无效");
    try {
      return await this.decryptSecret(record.id, "password", encrypted);
    } catch {
      throw persistentSshError(503, "无法解密 SSH 密码；请重新配置服务器");
    }
  }

  async encryptSecret(id, purpose, value) {
    const key = await this.masterKey(true);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`wfl-persistent-ssh:${purpose}:${id}`));
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  async decryptSecret(id, purpose, encrypted) {
    if (
      encrypted?.algorithm !== "aes-256-gcm"
      || !encrypted.iv
      || !encrypted.tag
      || !encrypted.ciphertext
    ) throw new Error("invalid encrypted secret");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      await this.masterKey(false),
      Buffer.from(encrypted.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`wfl-persistent-ssh:${purpose}:${id}`));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  async masterKey(create) {
    if (this._masterKey) return this._masterKey;
    let existingStat;
    try {
      existingStat = await ensurePrivateFile(this.masterKeyPath, { allowMissing: true });
    } catch (error) {
      throw persistentSshError(503, "持久 SSH 主密钥不可用");
    }
    if (existingStat) {
      try {
        const key = await fs.readFile(this.masterKeyPath);
        if (key.length !== MASTER_KEY_BYTES) throw new Error("invalid master key");
        this._masterKey = key;
        return key;
      } catch {
        throw persistentSshError(503, "持久 SSH 主密钥不可用");
      }
    }
    if (!create) throw persistentSshError(503, "持久 SSH 主密钥不可用");
    const key = crypto.randomBytes(MASTER_KEY_BYTES);
    try {
      await fs.writeFile(this.masterKeyPath, key, { mode: 0o600, flag: "wx" });
      await fs.chmod(this.masterKeyPath, 0o600);
      this._masterKey = key;
      return key;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") {
        throw persistentSshError(503, "持久 SSH 主密钥不可用");
      }
      try {
        await ensurePrivateFile(this.masterKeyPath);
        const existing = await fs.readFile(this.masterKeyPath);
        if (existing.length !== MASTER_KEY_BYTES) throw new Error("invalid master key");
        this._masterKey = existing;
        return existing;
      } catch {
        throw persistentSshError(503, "持久 SSH 主密钥不可用");
      }
    }
  }

  async writeStore() {
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({
      version: STORE_VERSION,
      servers: [...this.records.values()],
    }, null, 2);
    await fs.writeFile(temporary, `${payload}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.storePath);
  }

  async queueOperation(operation) {
    this.pendingOperationCount += 1;
    const run = this.operation.then(operation, operation);
    this.operation = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.pendingOperationCount -= 1;
    }
  }
}

function publicServer(record) {
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    port: record.port,
    username: record.username,
    workingDirectory: record.workingDirectory,
    enabled: record.enabled === true,
    authMode: record.authMode,
    keyAlgorithm: record.keyAlgorithm,
    hostKeyFingerprint: record.hostKeyFingerprint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastTestAt: record.lastTestAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function connectionResult(entry) {
  return {
    ...(entry.connection || {}),
    client: entry.client,
    pooled: true,
    entry,
  };
}

function isUsableSshClient(client) {
  return Boolean(client)
    && client.destroyed !== true
    && client.ended !== true
    && client._closing !== true;
}

function isRetryableConnectError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  if (/(?:authentication\s+(?:failed|failure)|auth(?:entication)?\s+failed|all configured authentication methods failed|permission denied|invalid user|host key|fingerprint|publickey|password\s+(?:is\s+)?incorrect)/i.test(message)) {
    return false;
  }
  if (RETRYABLE_CONNECT_CODES.has(code)) return true;
  if (error?.level === "client-socket") return true;
  if (!message) return false;
  return /(?:handshake|kex|socket|connection|timed?\s*out|timeout|reset|closed|aborted|refused|unreachable|unexpected end|no response|early eof)/i.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensurePrivateFile(filename, { allowMissing = false } = {}) {
  let stat;
  try {
    stat = await fs.lstat(filename);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("持久 SSH 私有文件类型不安全");
  }
  if ((stat.mode & 0o077) !== 0) {
    await fs.chmod(filename, 0o600);
  }
  return stat;
}

function normalizeStoredServer(value) {
  const id = String(value?.id || "");
  const name = normalizeName(value?.name);
  const target = normalizeTarget(value);
  const authMode = value?.authMode == null ? "public-key" : String(value.authMode);
  const workingDirectory = normalizeWorkingDirectory(value?.workingDirectory);
  const marker = String(value?.marker || "");
  const hostKeyFingerprint = String(value?.hostKeyFingerprint || "");
  const hostKey = String(value?.hostKey || "");
  const publicKey = value?.publicKey == null ? null : String(value.publicKey);
  const encryptedPrivateKey = value?.encryptedPrivateKey || null;
  const encryptedPassword = value?.encryptedPassword || null;
  const createdAt = Number(value?.createdAt);
  const updatedAt = Number(value?.updatedAt);
  const lastTestAt = value?.lastTestAt === null ? null : Number(value?.lastTestAt);
  const lastUsedAt = value?.lastUsedAt === null ? null : Number(value?.lastUsedAt);
  if (!/^pssh-[a-f0-9]{16}$/.test(id)) throw new Error("Invalid persistent SSH ID");
  if (!AUTH_MODES.has(authMode)) throw new Error("Invalid persistent SSH auth mode");
  if (!/^wfl-persistent-access-pssh-[a-f0-9]{16}$/.test(marker)) {
    throw new Error("Invalid persistent SSH marker");
  }
  if (!/^SHA256:[A-Za-z0-9+/]+$/.test(hostKeyFingerprint)) {
    throw new Error("Invalid persistent SSH host fingerprint");
  }
  if (!/^(?:ssh-|ecdsa-sha2-|sk-)[A-Za-z0-9@._+-]+ [A-Za-z0-9+/=]+$/.test(hostKey)) {
    throw new Error("Invalid persistent SSH host key");
  }
  let keyAlgorithm = value?.keyAlgorithm == null ? null : String(value.keyAlgorithm);
  if (authMode === "public-key") {
    if (!/^(?:ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+$/.test(publicKey || "")) {
      throw new Error("Invalid persistent SSH public key");
    }
    keyAlgorithm ||= publicKey.startsWith("ssh-rsa ") ? "rsa-3072" : "ed25519";
    if (!KEY_ALGORITHMS.some((algorithm) => algorithm.id === keyAlgorithm)) {
      throw new Error("Invalid persistent SSH key algorithm");
    }
    assertEncryptedPayload(encryptedPrivateKey, "Invalid persistent SSH encrypted key");
    if (encryptedPassword !== null) throw new Error("Unexpected persistent SSH password");
  } else {
    if (publicKey !== null || keyAlgorithm !== null || encryptedPrivateKey !== null) {
      throw new Error("Invalid persistent SSH password profile");
    }
    assertEncryptedPayload(encryptedPassword, "Invalid persistent SSH encrypted password");
  }
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error("Invalid persistent SSH timestamp");
  }
  if (lastTestAt !== null && (!Number.isFinite(lastTestAt) || lastTestAt <= 0)) {
    throw new Error("Invalid persistent SSH test timestamp");
  }
  if (lastUsedAt !== null && (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0)) {
    throw new Error("Invalid persistent SSH usage timestamp");
  }
  return {
    id,
    name,
    host: target.host,
    port: target.port,
    username: target.username,
    workingDirectory,
    enabled: value.enabled === true,
    authMode,
    keyAlgorithm,
    hostKeyFingerprint,
    hostKey,
    publicKey,
    marker,
    encryptedPrivateKey: authMode === "public-key" ? normalizeEncryptedPayload(encryptedPrivateKey) : null,
    encryptedPassword: authMode === "password" ? normalizeEncryptedPayload(encryptedPassword) : null,
    createdAt,
    updatedAt,
    lastTestAt,
    lastUsedAt,
  };
}

function assertEncryptedPayload(value, message) {
  if (
    !value
    || value.algorithm !== "aes-256-gcm"
    || !String(value.iv || "")
    || !String(value.tag || "")
    || !String(value.ciphertext || "")
  ) throw new Error(message);
}

function normalizeEncryptedPayload(value) {
  return {
    algorithm: "aes-256-gcm",
    iv: String(value.iv),
    tag: String(value.tag),
    ciphertext: String(value.ciphertext),
  };
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000\r\n]/.test(name)) {
    throw persistentSshError(400, "SSH 服务器名称不正确");
  }
  return name;
}

function normalizeTarget(value) {
  const host = String(value?.host || "").trim().toLowerCase();
  const port = Number(value?.port ?? 22);
  const username = String(value?.username || "").trim();
  if (
    !host
    || host.length > 253
    || /[\u0000\r\n/\\\s]/.test(host)
    || !/^[A-Za-z0-9.-]+$/.test(host)
    || host.startsWith(".")
    || host.endsWith(".")
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)
  ) throw persistentSshError(400, "SSH 服务器地址、端口或用户名不正确");
  return { host, port, username };
}

function normalizeWorkingDirectory(value) {
  const directory = String(value || "").trim();
  if (!directory) return null;
  if (
    directory.length > 1024
    || !directory.startsWith("/")
    || /[\u0000\r\n]/.test(directory)
    || directory.split("/").some((part) => part === "..")
  ) throw persistentSshError(400, "远程工作目录必须是安全的绝对路径");
  return directory.replace(/\/+$/, "") || "/";
}

function normalizePassword(value) {
  const password = String(value || "");
  if (!password || password.length > 1024 || /[\u0000\r\n]/.test(password)) {
    throw persistentSshError(400, "SSH 密码格式不正确");
  }
  return password;
}

function normalizeCommand(value) {
  const command = String(value || "").trim();
  if (!command || command.length > MAX_COMMAND_LENGTH || /[\u0000\r\n]/.test(command)) {
    throw persistentSshError(400, "远程命令不能为空，且不能包含换行或控制字符");
  }
  return command;
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(MAX_COMMAND_TIMEOUT_MS, Math.round(timeout)));
}

function pickTarget(record) {
  return {
    host: record.host,
    port: record.port,
    username: record.username,
  };
}

function executeRemoteCommand(client, command, timeoutMs, onConnectionFailure = null) {
  return new Promise((resolve, reject) => {
    let stream = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    const closeConnection = () => {
      try {
        onConnectionFailure?.();
      } catch {
        // Connection cleanup is best effort; the command result remains
        // governed by the original SSH operation error.
      }
    };
    const timer = setTimeout(() => {
      finish(reject, persistentSshError(504, "SSH 远程命令超时"));
      closeConnection();
      stream?.close();
    }, timeoutMs);
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const append = (target, chunk) => {
      if (settled) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        finish(resolve, {
          exitCode: null,
          signal: "OUTPUT_LIMIT",
          stdout,
          stderr,
          truncated: true,
        });
        closeConnection();
        stream?.close();
        return;
      }
      if (target === "stdout") stdout = `${stdout}${text}`;
      else stderr = `${stderr}${text}`;
    };
    client.exec(command, (error, remoteStream) => {
      if (error) {
        finish(reject, persistentSshError(502, "SSH 远程命令无法启动"));
        closeConnection();
        return;
      }
      stream = remoteStream;
      remoteStream.on("data", (chunk) => append("stdout", chunk));
      remoteStream.stderr.on("data", (chunk) => append("stderr", chunk));
      remoteStream.on("error", (streamError) => {
        finish(reject, persistentSshError(502, `SSH 远程命令连接中断：${streamError.message}`));
        closeConnection();
      });
      remoteStream.on("close", (code, signal) => {
        finish(resolve, { exitCode: code, signal: signal || null, stdout, stderr, truncated });
      });
    });
  });
}

async function generateKeyPair(directory, id, marker, algorithm = "ed25519") {
  const temporaryDirectory = await fs.mkdtemp(path.join(directory, ".key-"));
  const privateKeyPath = path.join(temporaryDirectory, id);
  try {
    const args = algorithm === "rsa-3072"
      ? ["-q", "-t", "rsa", "-b", "3072", "-N", "", "-C", marker, "-f", privateKeyPath]
      : ["-q", "-t", "ed25519", "-N", "", "-C", marker, "-f", privateKeyPath];
    await run("ssh-keygen", args);
    const [privateKey, publicKey] = await Promise.all([
      fs.readFile(privateKeyPath, "utf8"),
      fs.readFile(`${privateKeyPath}.pub`, "utf8"),
    ]);
    return {
      privateKey,
      publicKey,
      cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    if (error.code === "ENOENT") throw persistentSshError(503, "本机缺少 ssh-keygen");
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function validHostKeyResponse(value) {
  return /^SHA256:[A-Za-z0-9+/]{20,64}$/.test(String(value?.hostKeyFingerprint || ""))
    && /^(?:ssh-|ecdsa-sha2-|sk-)[A-Za-z0-9@._+-]+ [A-Za-z0-9+/=]+$/.test(String(value?.hostKey || ""));
}

function persistentSshError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
