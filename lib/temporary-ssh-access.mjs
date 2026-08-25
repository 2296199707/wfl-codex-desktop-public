import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { SshPasswordControl } from "./ssh-password-control.mjs";
import { TemporarySshConnector } from "./temporary-ssh-connector.mjs";
import {
  ensurePrivateSshSocketDirectory,
  isExpectedTemporarySshControlPath,
  temporarySshControlDirectory,
  temporarySshControlPath,
} from "./temporary-ssh-paths.mjs";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const ALLOWED_TTL_MINUTES = new Set([30, 60, 120]);
const MAX_ACTIVE_ACCESS = 5;

export class TemporarySshAccessService {
  constructor(runtimeDirectory, {
    now = () => Date.now(),
    connector = new TemporarySshConnector(),
    keyGenerator = generateKeyPair,
    passwordControl = new SshPasswordControl(),
    ttlMs = DEFAULT_TTL_MS,
    controlDirectory = temporarySshControlDirectory(runtimeDirectory),
  } = {}) {
    this.directory = path.join(runtimeDirectory, "plugin-data", "secure-ssh-access");
    this.controlDirectory = path.resolve(controlDirectory);
    this.now = now;
    this.connector = connector;
    this.keyGenerator = keyGenerator;
    this.passwordControl = passwordControl;
    this.ttlMs = ttlMs;
    this.records = new Map();
    this.expiryTimers = new Map();
    this.operation = Promise.resolve();
    this.pendingOperationCount = 0;
    this.primary = false;
  }

  async initialize({ primary = true } = {}) {
    this.primary = primary === true;
    if (this.primary) {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.chmod(this.directory, 0o700);
    }
    await this.loadRecords({ primary: this.primary });
    return this;
  }

  async activatePrimary() {
    return this.queueOperation(() => this.activatePrimaryNow());
  }

  async activatePrimaryNow() {
    if (this.primary) return this;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    for (const id of this.expiryTimers.keys()) this.clearExpiry(id);
    this.records.clear();
    await this.loadRecords({ primary: true, deferCleanup: true });
    this.primary = true;
    return this;
  }

  async loadRecords({ primary, deferCleanup = false }) {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (!primary && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = normalizeStoredRecord(
          JSON.parse(await fs.readFile(path.join(this.directory, entry.name), "utf8")),
          this.directory,
          this.controlDirectory,
        );
        if (!primary) {
          this.records.set(record.id, record);
        } else if (deferCleanup) {
          this.records.set(record.id, record);
          this.scheduleExpiry(record);
        } else if (record.expiresAt <= this.now()) {
          await this.stopPasswordControl(record);
          await this.removeLocalFiles(record);
        } else if (record.authMode === "password-control" && !await this.passwordControl.check({
          target: pickTarget(record),
          controlPath: record.controlPath,
        })) {
          await this.removeLocalFiles(record);
        } else {
          this.records.set(record.id, record);
          this.scheduleExpiry(record);
        }
      } catch {
        if (!primary) continue;
        const id = entry.name.slice(0, -".json".length);
        if (/^ssh-[a-f0-9]{16}$/.test(id)) {
          await Promise.all([
            fs.rm(path.join(this.directory, id), { force: true }),
            fs.rm(path.join(this.directory, `${id}.pub`), { force: true }),
            fs.rm(path.join(this.directory, `${id}.known_hosts`), { force: true }),
            fs.rm(path.join(this.directory, `${id}.ctl`), { force: true }),
            fs.rm(path.join(this.directory, `${id}.ctl.askpass`), { force: true }),
            fs.rm(temporarySshControlPath(this.controlDirectory, id), { force: true }),
            fs.rm(`${temporarySshControlPath(this.controlDirectory, id)}.askpass`, { force: true }),
          ]);
        }
        await fs.rm(path.join(this.directory, entry.name), { force: true });
      }
    }
  }

  snapshot() {
    return [...this.records.values()]
      .filter((record) => record.expiresAt > this.now())
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => publicRecord(record));
  }

  get pendingOperations() {
    return this.pendingOperationCount;
  }

  get busy() {
    return this.pendingOperationCount > 0;
  }

  async authorize(input) {
    return this.queueOperation(() => this.authorizeNow(input));
  }

  async authorizeNow(input) {
    this.assertPrimary();
    await this.removeExpiredLocalRecords();
    if (this.records.size >= MAX_ACTIVE_ACCESS) throw accessError(409, "最多保留 5 个临时 SSH 授权");
    const target = normalizeTarget(input);
    let password = String(input?.password || "");
    if (!password || password.length > 1024 || /[\r\n\0]/.test(password)) {
      throw accessError(400, "SSH 密码格式不正确");
    }

    const id = `ssh-${crypto.randomBytes(8).toString("hex")}`;
    const marker = `wfl-temporary-access-${id}`;
    const createdAt = this.now();
    const expiresAt = createdAt + requestedTtlMs(input?.durationMinutes, this.ttlMs);
    let keyPair;
    let installed;
    let authMode = "public-key";
    let controlPath = "";
    let knownHostsPath = "";
    try {
      keyPair = await this.keyGenerator(this.directory, id, marker);
      const keyParts = keyPair.publicKey.trim().split(/\s+/);
      if (keyParts.length < 2 || keyParts[0] !== "ssh-ed25519") throw new Error("Invalid generated key");
      const expiry = formatOpenSshExpiry(expiresAt);
      const authorizedKeyLine = [
        `expiry-time="${expiry}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding`,
        keyParts[0],
        keyParts[1],
        marker,
      ].join(" ");
      const privateKey = await fs.readFile(keyPair.privateKeyPath, "utf8");
      try {
        installed = await this.connector.install({
          target,
          password,
          authorizedKeyLine,
          marker,
          privateKey,
        });
      } catch (error) {
        if (!validHostKeyResponse(error.passwordFallback)) throw error;
        authMode = "password-control";
        installed = error.passwordFallback;
      }
      knownHostsPath = `${keyPair.privateKeyPath}.known_hosts`;
      await writeKnownHosts(knownHostsPath, target, installed);
      if (authMode === "password-control") {
        await ensurePrivateSshSocketDirectory(this.controlDirectory);
        controlPath = temporarySshControlPath(this.controlDirectory, id);
        await this.passwordControl.start({ target, password, knownHostsPath, controlPath, expiresAt });
        await Promise.all([
          fs.rm(keyPair.privateKeyPath, { force: true }),
          fs.rm(keyPair.publicKeyPath, { force: true }),
        ]);
      }
      password = "";
      if (!validHostKeyResponse(installed)) {
        throw new Error("Invalid SSH host key response");
      }
      const record = {
        id,
        ...target,
        authMode,
        marker,
        knownHostsPath,
        ...(authMode === "public-key" ? {
          privateKeyPath: keyPair.privateKeyPath,
          publicKeyPath: keyPair.publicKeyPath,
        } : { controlPath }),
        hostKeyFingerprint: installed.hostKeyFingerprint,
        createdAt,
        expiresAt,
      };
      await this.persist(record);
      this.records.set(id, record);
      this.scheduleExpiry(record);
      return publicRecord(record);
    } catch (error) {
      password = "";
      if (authMode === "password-control" && controlPath) {
        await this.passwordControl.stop({ target, controlPath }).catch(() => {});
      } else if (installed && keyPair) {
        const privateKey = await fs.readFile(keyPair.privateKeyPath, "utf8").catch(() => "");
        if (privateKey) {
          await this.connector.remove({
            target,
            privateKey,
            marker,
            expectedFingerprint: installed.hostKeyFingerprint,
          }).catch(() => {});
        }
      }
      if (keyPair) await removeKeyPair(keyPair);
      if (knownHostsPath) await fs.rm(knownHostsPath, { force: true });
      await Promise.all([
        fs.rm(path.join(this.directory, `${id}.json`), { force: true }),
        fs.rm(path.join(this.directory, `${id}.json.${process.pid}.tmp`), { force: true }),
      ]);
      if (error.statusCode) throw error;
      throw accessError(500, "无法生成临时 SSH 密钥");
    }
  }

  async revoke(id) {
    return this.queueOperation(() => this.revokeNow(id));
  }

  async revokeNow(id) {
    this.assertPrimary();
    const record = this.records.get(String(id));
    if (!record) throw accessError(404, "临时 SSH 授权不存在或已经到期");
    if (record.authMode === "password-control") {
      await this.stopPasswordControl(record);
    } else if (record.expiresAt > this.now()) {
      const privateKey = await fs.readFile(record.privateKeyPath, "utf8");
      await this.connector.remove({
        target: pickTarget(record),
        privateKey,
        marker: record.marker,
        expectedFingerprint: record.hostKeyFingerprint,
      });
    }
    await this.removeLocalFiles(record);
    this.records.delete(record.id);
    this.clearExpiry(record.id);
    return { removed: true, id: record.id };
  }

  async persist(record) {
    const destination = path.join(this.directory, `${record.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  }

  async removeExpiredLocalRecords() {
    for (const record of this.records.values()) {
      if (record.expiresAt > this.now()) continue;
      await this.stopPasswordControl(record);
      await this.removeLocalFiles(record);
      this.records.delete(record.id);
      this.clearExpiry(record.id);
    }
  }

  scheduleExpiry(record) {
    this.clearExpiry(record.id);
    const delay = Math.max(1, Math.min(record.expiresAt - this.now(), 2_147_483_647));
    const timer = setTimeout(() => {
      this.queueOperation(() => this.expireNow(record.id)).catch(() => {});
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(record.id, timer);
  }

  clearExpiry(id) {
    clearTimeout(this.expiryTimers.get(id));
    this.expiryTimers.delete(id);
  }

  async expireNow(id) {
    const record = this.records.get(id);
    if (!record || record.expiresAt > this.now()) return;
    await this.stopPasswordControl(record);
    await this.removeLocalFiles(record);
    this.records.delete(id);
    this.clearExpiry(id);
  }

  async stopPasswordControl(record) {
    if (record.authMode !== "password-control") return;
    await this.passwordControl.stop({
      target: pickTarget(record),
      controlPath: record.controlPath,
    }).catch(() => {});
  }

  async removeLocalFiles(record) {
    const filenames = [
      record.privateKeyPath,
      record.publicKeyPath,
      record.knownHostsPath,
      record.controlPath,
      record.controlPath ? `${record.controlPath}.askpass` : "",
      path.join(this.directory, `${record.id}.json`),
    ].filter(Boolean);
    await Promise.all(filenames.map((filename) => fs.rm(filename, { force: true })));
  }

  assertPrimary() {
    if (!this.primary) throw accessError(503, "SSH 授权服务正在等待后端切换");
  }

  queueOperation(operation) {
    this.pendingOperationCount += 1;
    const task = this.operation
      .then(operation, operation)
      .finally(() => {
        this.pendingOperationCount = Math.max(0, this.pendingOperationCount - 1);
      });
    this.operation = task.catch(() => {});
    return task;
  }
}

async function generateKeyPair(directory, id, marker) {
  const privateKeyPath = path.join(directory, id);
  const publicKeyPath = `${privateKeyPath}.pub`;
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", marker, "-f", privateKeyPath]);
  await Promise.all([fs.chmod(privateKeyPath, 0o600), fs.chmod(publicKeyPath, 0o600)]);
  return {
    privateKeyPath,
    publicKeyPath,
    publicKey: await fs.readFile(publicKeyPath, "utf8"),
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

function normalizeTarget(input) {
  const host = String(input?.host || "").trim().toLowerCase();
  const username = String(input?.username || "root").trim();
  const port = Number(input?.port || 22);
  if (!validHost(host)) throw accessError(400, "SSH 主机地址格式不正确");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw accessError(400, "SSH 端口必须为 1-65535");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) throw accessError(400, "SSH 用户名格式不正确");
  return { host, port, username };
}

function requestedTtlMs(value, defaultTtlMs) {
  if (value === undefined || value === null || value === "") return defaultTtlMs;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || !ALLOWED_TTL_MINUTES.has(minutes)) {
    throw accessError(400, "SSH 临时授权时长必须为 30、60 或 120 分钟");
  }
  return minutes * 60 * 1000;
}

function validHost(value) {
  if (net.isIP(value)) return true;
  if (!value || value.length > 253 || value.includes("..")) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function normalizeStoredRecord(value, directory, controlDirectory) {
  if (!/^ssh-[a-f0-9]{16}$/.test(String(value?.id))) throw new Error("Invalid SSH access ID");
  const target = normalizeTarget(value);
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  const marker = String(value.marker || "");
  const authMode = value.authMode === "password-control" ? "password-control" : "public-key";
  const privateKeyPath = String(value.privateKeyPath || "");
  const publicKeyPath = String(value.publicKeyPath || "");
  const knownHostsPath = String(value.knownHostsPath || "");
  const controlPath = String(value.controlPath || "");
  const hostKeyFingerprint = String(value.hostKeyFingerprint || "");
  if (marker !== `wfl-temporary-access-${value.id}`) throw new Error("Invalid SSH marker");
  if (
    !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt
    || expiresAt - createdAt > 120 * 60 * 1000
  ) throw new Error("Invalid SSH expiry");
  const basePath = path.join(directory, value.id);
  if (knownHostsPath !== `${basePath}.known_hosts`) throw new Error("Invalid SSH known-hosts path");
  if (authMode === "public-key" && (privateKeyPath !== basePath || publicKeyPath !== `${basePath}.pub`)) {
    throw new Error("Invalid SSH key path");
  }
  if (authMode === "password-control" && !isExpectedTemporarySshControlPath({
    candidate: controlPath,
    controlDirectory,
    dataDirectory: directory,
    id: value.id,
  })) {
    throw new Error("Invalid SSH control path");
  }
  if (!/^SHA256:[A-Za-z0-9+/]{20,64}$/.test(hostKeyFingerprint)) throw new Error("Invalid host fingerprint");
  return {
    id: value.id,
    ...target,
    authMode,
    marker,
    knownHostsPath,
    ...(authMode === "public-key" ? { privateKeyPath, publicKeyPath } : { controlPath }),
    hostKeyFingerprint,
    createdAt,
    expiresAt,
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    host: record.host,
    port: record.port,
    username: record.username,
    authMode: record.authMode,
    hostKeyFingerprint: record.hostKeyFingerprint,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function pickTarget(record) {
  return { host: record.host, port: record.port, username: record.username };
}

function formatOpenSshExpiry(timestamp) {
  const value = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return value.replace("T", "");
}

function knownHostName(host, port) {
  return port === 22 && net.isIP(host) !== 6 ? host : `[${host}]:${port}`;
}

function validHostKeyResponse(value) {
  return /^SHA256:[A-Za-z0-9+/]{20,64}$/.test(String(value?.hostKeyFingerprint || ""))
    && /^(?:ssh-|ecdsa-sha2-|sk-)[A-Za-z0-9@._+-]+ [A-Za-z0-9+/=]+$/.test(String(value?.hostKey || ""));
}

async function writeKnownHosts(filename, target, installed) {
  if (!validHostKeyResponse(installed)) throw new Error("Invalid SSH host key response");
  await fs.writeFile(
    filename,
    `${knownHostName(target.host, target.port)} ${installed.hostKey}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

async function removeKeyPair(keyPair) {
  await Promise.all([
    fs.rm(keyPair.privateKeyPath, { force: true }),
    fs.rm(keyPair.publicKeyPath, { force: true }),
    fs.rm(`${keyPair.privateKeyPath}.known_hosts`, { force: true }),
  ]);
}

function accessError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
