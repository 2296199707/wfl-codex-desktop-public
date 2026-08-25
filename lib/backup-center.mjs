import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const STORE_VERSION = 1;
const BACKUP_MAGIC = Buffer.from("WFLBACKUP1\0", "ascii");
const HEADER_BYTES = 32;
const IV_OFFSET = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BACKUP_ID_PATTERN = /^b-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, intervalHours: 24, retentionCount: 7, lastScheduledAt: null });

export class BackupCenter {
  constructor(directory, {
    stateDirectory,
    version,
    now = () => Date.now(),
    keyPath = path.join(stateDirectory, "backup-recovery.key"),
  } = {}) {
    this.directory = path.resolve(directory);
    this.stateDirectory = path.resolve(stateDirectory);
    this.version = String(version || "");
    this.now = now;
    this.keyPath = path.resolve(keyPath);
    this.indexPath = path.join(this.directory, "index.json");
    this.settingsPath = path.join(this.stateDirectory, "backup-settings.json");
    this.index = null;
    this.settings = null;
    this.key = null;
    this.busy = false;
  }

  async initialize({ writeOnInitialize = true } = {}) {
    if (writeOnInitialize) {
      await Promise.all([
        fs.mkdir(this.directory, { recursive: true, mode: 0o700 }),
        fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 }),
      ]);
      await Promise.all([fs.chmod(this.directory, 0o700), fs.chmod(this.stateDirectory, 0o700)]);
    }
    this.key = await loadOrCreateKey(this.keyPath, { writeOnInitialize });
    this.index = await readJson(this.indexPath, { version: STORE_VERSION, backups: [] });
    this.settings = normalizeSettings(await readJson(this.settingsPath, DEFAULT_SETTINGS));
    validateIndex(this.index);
    if (writeOnInitialize) await this.removeOrphans();
    return this;
  }

  snapshot() {
    this.assertInitialized();
    return {
      busy: this.busy,
      keyConfigured: this.key?.length === 32,
      settings: structuredClone(this.settings),
      backups: this.index.backups.map(publicBackup).sort((left, right) => right.createdAt - left.createdAt),
    };
  }

  async updateSettings(input = {}) {
    this.assertInitialized();
    this.settings = normalizeSettings({ ...this.settings, ...input });
    await writeJsonAtomic(this.settingsPath, this.settings);
    return structuredClone(this.settings);
  }

  scheduledBackupDue() {
    this.assertInitialized();
    if (!this.settings.enabled || this.busy) return false;
    const last = Number(this.settings.lastScheduledAt) || 0;
    return this.now() - last >= this.settings.intervalHours * 60 * 60 * 1000;
  }

  async create({ sources, kind = "manual", summary = {}, hostId = null } = {}) {
    this.assertInitialized();
    if (this.busy) throw backupError(409, "已有备份任务正在执行");
    this.busy = true;
    const createdAt = this.now();
    const id = createBackupId(createdAt);
    const temporaryDirectory = path.join(this.directory, `.tmp-${id}`);
    const tarPath = path.join(temporaryDirectory, `${id}.tar.gz`);
    const archivePath = this.archivePath(id);
    try {
      const normalizedSources = await normalizeSources(sources);
      if (!normalizedSources.length) throw backupError(400, "没有可备份的数据目录");
      const manifest = {
        version: STORE_VERSION,
        id,
        appVersion: this.version,
        createdAt,
        kind: kind === "scheduled" ? "scheduled" : "manual",
        hostId: cleanText(hostId, 128),
        sources: normalizedSources,
        summary: normalizeSummary(summary),
      };
      await fs.mkdir(path.join(temporaryDirectory, ".wfl-backup"), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(temporaryDirectory, ".wfl-backup", "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      const tarArgs = [
        "--create", "--gzip", `--file=${tarPath}`, "--numeric-owner",
        "--exclude=sessions.json", "--exclude=*/sessions.json",
        "--exclude=session-token", "--exclude=*/session-token",
        "--directory", temporaryDirectory, ".wfl-backup",
      ];
      for (const source of normalizedSources) tarArgs.push("--directory", "/", source.path.slice(1));
      await run("tar", tarArgs);
      await encryptFile(tarPath, archivePath, this.key);
      const [stat, sha256] = await Promise.all([fs.stat(archivePath), digestFile(archivePath)]);
      const backup = {
        id,
        version: this.version,
        kind: manifest.kind,
        createdAt,
        sizeBytes: stat.size,
        sha256,
        verifiedAt: null,
        summary: manifest.summary,
      };
      this.index.backups.push(backup);
      if (manifest.kind === "scheduled") this.settings.lastScheduledAt = createdAt;
      await Promise.all([
        writeJsonAtomic(this.indexPath, this.index),
        writeJsonAtomic(this.settingsPath, this.settings),
      ]);
      const verified = await this.verify(id);
      await this.applyRetention();
      return verified.backup;
    } finally {
      this.busy = false;
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async verify(id) {
    this.assertInitialized();
    const backup = this.requireBackup(id);
    const archivePath = this.archivePath(id);
    const digest = await digestFile(archivePath).catch(() => null);
    if (!digest || !safeEqualText(digest, backup.sha256)) throw backupError(409, "备份文件校验失败");
    const temporary = path.join(this.directory, `.verify-${id}-${crypto.randomBytes(4).toString("hex")}.tar.gz`);
    try {
      await decryptFile(archivePath, temporary, this.key);
      const manifest = await readManifest(temporary);
      validateManifest(manifest, id);
      backup.verifiedAt = this.now();
      await writeJsonAtomic(this.indexPath, this.index);
      return { backup: publicBackup(backup), manifest: publicManifest(manifest) };
    } catch (error) {
      if (error.statusCode) throw error;
      throw backupError(409, `备份内容校验失败：${error.message}`);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async stageForRestore(id, destination) {
    this.assertInitialized();
    await this.verify(id);
    const root = path.resolve(destination);
    const tarPath = `${root}.tar.gz`;
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await decryptFile(this.archivePath(id), tarPath, this.key);
      await run("tar", ["--extract", "--gzip", `--file=${tarPath}`, `--directory=${root}`, "--numeric-owner"]);
      const manifest = JSON.parse(await fs.readFile(path.join(root, ".wfl-backup", "manifest.json"), "utf8"));
      validateManifest(manifest, id);
      return { root, manifest };
    } finally {
      await fs.rm(tarPath, { force: true });
    }
  }

  async delete(id) {
    this.assertInitialized();
    const index = this.index.backups.findIndex((entry) => entry.id === id);
    if (index === -1) throw backupError(404, "备份不存在");
    this.index.backups.splice(index, 1);
    await Promise.all([fs.rm(this.archivePath(id), { force: true }), writeJsonAtomic(this.indexPath, this.index)]);
  }

  archivePath(id) {
    if (!BACKUP_ID_PATTERN.test(String(id || ""))) throw backupError(400, "备份编号无效");
    return path.join(this.directory, `${id}.wflbackup`);
  }

  exportRecoveryKey() {
    this.assertInitialized();
    return `WFL-RECOVERY-KEY-1:${this.key.toString("base64url")}\n`;
  }

  requireBackup(id) {
    if (!BACKUP_ID_PATTERN.test(String(id || ""))) throw backupError(400, "备份编号无效");
    const backup = this.index.backups.find((entry) => entry.id === id);
    if (!backup) throw backupError(404, "备份不存在");
    return backup;
  }

  async applyRetention() {
    const order = new Map(this.index.backups.map((entry, index) => [entry.id, index]));
    const ordered = [...this.index.backups].sort((left, right) => (
      (right.createdAt - left.createdAt) || (order.get(right.id) - order.get(left.id))
    ));
    const removed = ordered.slice(this.settings.retentionCount);
    if (!removed.length) return;
    const removedIds = new Set(removed.map((entry) => entry.id));
    this.index.backups = this.index.backups.filter((entry) => !removedIds.has(entry.id));
    await Promise.all([
      ...removed.map((entry) => fs.rm(this.archivePath(entry.id), { force: true })),
      writeJsonAtomic(this.indexPath, this.index),
    ]);
  }

  async removeOrphans() {
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const known = new Set(this.index.backups.map((backup) => `${backup.id}.wflbackup`));
    await Promise.all(entries.flatMap((entry) => {
      if (entry.name.startsWith(".tmp-") || entry.name.startsWith(".verify-")) {
        return [fs.rm(path.join(this.directory, entry.name), { recursive: true, force: true })];
      }
      if (entry.isFile() && entry.name.endsWith(".wflbackup") && !known.has(entry.name)) {
        return [fs.rm(path.join(this.directory, entry.name), { force: true })];
      }
      return [];
    }));
    const missing = [];
    for (const backup of this.index.backups) {
      try { await fs.access(this.archivePath(backup.id)); } catch { missing.push(backup.id); }
    }
    if (missing.length) {
      const ids = new Set(missing);
      this.index.backups = this.index.backups.filter((backup) => !ids.has(backup.id));
      await writeJsonAtomic(this.indexPath, this.index);
    }
  }

  assertInitialized() {
    if (!this.index || !this.settings || !this.key) throw new Error("Backup center is not initialized");
  }
}

async function normalizeSources(sources) {
  if (!Array.isArray(sources)) throw backupError(400, "备份范围无效");
  const normalized = [];
  for (const input of sources) {
    const sourcePath = path.resolve(String(input?.path || ""));
    if (sourcePath === "/" || !path.isAbsolute(sourcePath)) throw backupError(400, "备份目录无效");
    let stat;
    try { stat = await fs.lstat(sourcePath); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw backupError(400, "备份范围必须是真实目录");
    const realPath = await fs.realpath(sourcePath);
    if (realPath !== sourcePath) throw backupError(400, "备份目录不能经过符号链接");
    normalized.push({ path: sourcePath, kind: cleanText(input?.kind, 32) || "data" });
  }
  normalized.sort((left, right) => left.path.length - right.path.length);
  return normalized.filter((entry, index, list) => !list.slice(0, index).some((parent) => isWithin(parent.path, entry.path)));
}

function normalizeSummary(value) {
  return {
    users: boundedInteger(value?.users, 0, 1_000_000),
    projects: boundedInteger(value?.projects, 0, 1_000_000),
    scopes: Array.isArray(value?.scopes) ? value.scopes.map((entry) => cleanText(entry, 32)).filter(Boolean).slice(0, 16) : [],
  };
}

function normalizeSettings(value) {
  const intervalHours = [24, 168].includes(Number(value?.intervalHours)) ? Number(value.intervalHours) : 24;
  const retentionCount = boundedInteger(value?.retentionCount, 1, 30, 7);
  const lastScheduledAt = Number.isFinite(Number(value?.lastScheduledAt)) ? Math.max(0, Math.round(Number(value.lastScheduledAt))) : null;
  return { enabled: value?.enabled === true, intervalHours, retentionCount, lastScheduledAt };
}

function validateIndex(index) {
  if (index?.version !== STORE_VERSION || !Array.isArray(index.backups)) throw new Error("Invalid backup index");
  for (const backup of index.backups) {
    if (!BACKUP_ID_PATTERN.test(backup.id) || !/^[a-f0-9]{64}$/.test(backup.sha256) || !Number.isSafeInteger(backup.sizeBytes)) {
      throw new Error("Invalid backup record");
    }
  }
}

function validateManifest(manifest, expectedId) {
  if (manifest?.version !== STORE_VERSION || manifest.id !== expectedId || !Array.isArray(manifest.sources)) {
    throw new Error("Invalid backup manifest");
  }
  for (const source of manifest.sources) {
    if (!path.isAbsolute(source?.path) || source.path === "/" || source.path.includes("\0")) throw new Error("Invalid backup source");
  }
}

function publicBackup(backup) {
  return {
    id: backup.id,
    version: cleanText(backup.version, 32),
    kind: backup.kind === "scheduled" ? "scheduled" : "manual",
    createdAt: backup.createdAt,
    sizeBytes: backup.sizeBytes,
    sha256: backup.sha256,
    verifiedAt: Number.isFinite(backup.verifiedAt) ? backup.verifiedAt : null,
    summary: normalizeSummary(backup.summary),
  };
}

function publicManifest(manifest) {
  return {
    id: manifest.id,
    appVersion: cleanText(manifest.appVersion, 32),
    createdAt: manifest.createdAt,
    kind: manifest.kind,
    hostId: cleanText(manifest.hostId, 128),
    sourceCount: manifest.sources.length,
    summary: normalizeSummary(manifest.summary),
  };
}

async function loadOrCreateKey(filePath, { writeOnInitialize = true } = {}) {
  try {
    const value = (await fs.readFile(filePath, "utf8")).trim();
    const key = Buffer.from(value, "base64url");
    if (key.length !== 32) throw new Error("Invalid backup recovery key");
    if (writeOnInitialize) await fs.chmod(filePath, 0o600);
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!writeOnInitialize) throw new Error("Backup recovery key is missing during standby initialization");
    const key = crypto.randomBytes(32);
    await fs.writeFile(filePath, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  }
}

async function encryptFile(input, output, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  BACKUP_MAGIC.copy(header);
  iv.copy(header, IV_OFFSET);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  await fs.writeFile(output, header, { mode: 0o600, flag: "wx" });
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: "a", mode: 0o600 }));
  await fs.appendFile(output, cipher.getAuthTag());
}

async function decryptFile(input, output, key) {
  const handle = await fs.open(input, "r");
  let stat;
  let header;
  let tag;
  try {
    stat = await handle.stat();
    if (stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error("Backup file is truncated");
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("Backup format is not supported");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(IV_OFFSET, IV_OFFSET + IV_BYTES));
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(input, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    createWriteStream(output, { mode: 0o600, flags: "wx" }),
  );
}

async function readManifest(tarPath) {
  const output = await capture("tar", ["--extract", "--gzip", "--to-stdout", `--file=${tarPath}`, ".wfl-backup/manifest.json"]);
  return JSON.parse(output);
}

async function digestFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with status ${code}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with status ${code}`)));
  });
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function createBackupId(now) {
  return `b-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedInteger(value, minimum, maximum, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/[\r\n\0]+/g, " ").trim().slice(0, limit) : null;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function backupError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
