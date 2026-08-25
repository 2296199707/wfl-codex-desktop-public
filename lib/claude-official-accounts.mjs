import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeOfficialProxy,
  normalizeOfficialProxyHealth,
  publicOfficialProxy,
} from "./official-proxy.mjs";

const STORE_VERSION = 1;
const MAX_ACCOUNTS = 10;
const ACCOUNT_ID_PATTERN = /^ca-[a-f0-9]{16}$/;
const CREDENTIAL_STATUSES = new Set(["unknown", "valid", "invalid"]);
const QUOTA_STATUSES = new Set(["allowed", "allowed_warning", "rejected", "unknown"]);
const QUOTA_WINDOW_TYPES = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);

/**
 * Durable metadata for Claude official-account slots.
 *
 * Claude's own credentials remain inside each slot's private
 * `CLAUDE_CONFIG_DIR`; WFL never parses or copies them into the browser or its
 * metadata store. The encrypted store contains only labels, public account
 * identity, health, and optional proxy configuration.
 */
export class ClaudeOfficialAccountStore {
  constructor(directory, {
    legacyConfigDirectory,
    uid = null,
    gid = null,
    now = () => Date.now(),
  } = {}) {
    if (!directory || !legacyConfigDirectory) {
      throw new Error("Claude official account directories are required");
    }
    this.directory = path.resolve(directory);
    this.accountsDirectory = path.join(this.directory, "official-accounts");
    this.legacyConfigDirectory = path.resolve(legacyConfigDirectory);
    this.keyPath = path.join(this.directory, "official-accounts.key");
    this.storePath = path.join(this.directory, "official-accounts.enc.json");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.now = now;
    this.key = null;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await this.ensurePrivateDirectory(this.directory);
    await this.ensurePrivateDirectory(this.accountsDirectory);
    this.key = await loadOrCreateKey(this.keyPath, { uid: this.uid, gid: this.gid });
    this.data = await this.readStore();
    for (const account of this.data.accounts) {
      await this.ensureAccountDirectory(account);
    }
    return this;
  }

  snapshot() {
    this.assertInitialized();
    return {
      activeId: this.data.activeId,
      accounts: this.data.accounts
        .map((account) => publicAccount(account, account.id === this.data.activeId))
        .sort((left, right) => Number(right.active) - Number(left.active)
          || (right.lastUsedAt || 0) - (left.lastUsedAt || 0)),
    };
  }

  has(id) {
    this.assertInitialized();
    return this.data.accounts.some((account) => account.id === String(id || ""));
  }

  activeId() {
    this.assertInitialized();
    return this.data.activeId;
  }

  activeAccount() {
    this.assertInitialized();
    const account = this.data.accounts.find((entry) => entry.id === this.data.activeId);
    return account ? publicAccount(account, true) : null;
  }

  get(id) {
    this.assertInitialized();
    const account = this.data.accounts.find((entry) => entry.id === String(id || ""));
    return account ? publicAccount(account, account.id === this.data.activeId) : null;
  }

  configDirectory(id) {
    const account = this.requireAccount(id);
    return account.legacy
      ? this.legacyConfigDirectory
      : path.join(this.accountsDirectory, account.id, "config");
  }

  privateProxy(id) {
    const account = this.requireAccount(id);
    return account.proxy ? { ...account.proxy.config } : null;
  }

  async create({ label = null } = {}) {
    return this.mutate(async () => {
      if (this.data.accounts.length >= MAX_ACCOUNTS) {
        throw storeError(409, `最多保存 ${MAX_ACCOUNTS} 个 Claude 官方账号`);
      }
      const timestamp = this.now();
      const account = {
        id: `ca-${crypto.randomBytes(8).toString("hex")}`,
        label: normalizeLabel(label) || `Claude 账号 ${this.data.accounts.length + 1}`,
        email: null,
        subscriptionType: null,
        legacy: false,
        credentialStatus: "unknown",
        credentialStatusUpdatedAt: null,
        lastCheckedAt: null,
        lastErrorCode: null,
        quota: null,
        proxy: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastUsedAt: null,
      };
      await this.ensureAccountDirectory(account);
      this.data.accounts.push(account);
      if (!this.data.activeId) this.data.activeId = account.id;
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async ensureLegacy(status) {
    return this.mutate(async () => {
      const normalized = normalizeAuthStatus(status);
      if (!normalized.loggedIn) return null;
      let account = this.data.accounts.find((entry) => entry.legacy) || null;
      const timestamp = this.now();
      if (!account) {
        if (this.data.accounts.length >= MAX_ACCOUNTS) {
          throw storeError(409, `最多保存 ${MAX_ACCOUNTS} 个 Claude 官方账号`);
        }
        account = {
          id: `ca-${crypto.randomBytes(8).toString("hex")}`,
          label: "原有 Claude 账号",
          email: normalized.email,
          subscriptionType: normalized.subscriptionType,
          legacy: true,
          credentialStatus: "valid",
          credentialStatusUpdatedAt: timestamp,
          lastCheckedAt: timestamp,
          lastErrorCode: null,
          quota: null,
          proxy: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUsedAt: timestamp,
        };
        this.data.accounts.push(account);
      } else {
        applyAuthStatus(account, normalized, timestamp);
      }
      this.data.activeId ||= account.id;
      await this.ensureAccountDirectory(account);
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async recordStatus(id, status, { markInvalid = true } = {}) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      const normalized = normalizeAuthStatus(status);
      const timestamp = this.now();
      account.lastCheckedAt = timestamp;
      account.updatedAt = timestamp;
      if (normalized.loggedIn) {
        applyAuthStatus(account, normalized, timestamp);
      } else if (markInvalid) {
        account.credentialStatus = "invalid";
        account.credentialStatusUpdatedAt = timestamp;
        account.lastErrorCode = "logged-out";
      }
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async markInvalid(id, code = "invalid") {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      const timestamp = this.now();
      account.credentialStatus = "invalid";
      account.credentialStatusUpdatedAt = timestamp;
      account.lastCheckedAt = timestamp;
      account.lastErrorCode = normalizeErrorCode(code);
      account.updatedAt = timestamp;
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async activate(id) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      if (account.credentialStatus !== "valid") {
        throw storeError(409, "此 Claude 登录已失效，请先重新登录");
      }
      const timestamp = this.now();
      account.lastUsedAt = timestamp;
      account.updatedAt = timestamp;
      this.data.activeId = account.id;
      await this.writeStore();
      return publicAccount(account, true);
    });
  }

  async rename(id, label) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      const normalized = normalizeLabel(label);
      if (!normalized) throw storeError(400, "Claude 账号名称无效");
      account.label = normalized;
      account.updatedAt = this.now();
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      const index = this.data.accounts.findIndex((entry) => entry.id === account.id);
      const previousActiveId = this.data.activeId;
      let quarantine = null;
      if (!account.legacy) {
        const accountRoot = path.resolve(this.accountsDirectory, account.id);
        if (path.dirname(accountRoot) !== this.accountsDirectory) {
          throw storeError(500, "Claude 官方账号目录无效");
        }
        try {
          const stat = await fs.lstat(accountRoot);
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw storeError(500, "Claude 官方账号目录不安全");
          }
          quarantine = path.join(
            this.accountsDirectory,
            `.delete-${account.id}-${crypto.randomBytes(6).toString("hex")}`,
          );
          await fs.rename(accountRoot, quarantine);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      this.data.accounts.splice(index, 1);
      if (this.data.activeId === account.id) {
        this.data.activeId = this.data.accounts.find((entry) => entry.credentialStatus === "valid")?.id
          || this.data.accounts[0]?.id
          || null;
      }
      try {
        await this.writeStore();
      } catch (error) {
        this.data.accounts.splice(index, 0, account);
        this.data.activeId = previousActiveId;
        if (quarantine) {
          await fs.rename(quarantine, path.join(this.accountsDirectory, account.id)).catch(() => {});
        }
        throw error;
      }
      if (quarantine) await fs.rm(quarantine, { recursive: true, force: true });
      return {
        removedId: account.id,
        ...this.snapshot(),
      };
    });
  }

  async setProxy(id, proxy, health = null) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      account.proxy = proxy == null ? null : {
        config: normalizeOfficialProxy(proxy),
        health: normalizeOfficialProxyHealth(health),
      };
      account.updatedAt = this.now();
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async recordProxyHealth(id, health) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      if (!account.proxy) return null;
      account.proxy.health = normalizeOfficialProxyHealth(health);
      account.updatedAt = this.now();
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  async recordQuota(id, sample) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      const normalized = normalizeQuotaSample(sample, this.now());
      if (!normalized) return publicAccount(account, account.id === this.data.activeId);
      const previous = normalizeQuota(account.quota);
      const windows = new Map((previous?.windows || []).map((entry) => [entry.type, entry]));
      if (normalized.window) windows.set(normalized.window.type, normalized.window);
      account.quota = {
        source: "rate_limit_event",
        status: normalized.status,
        windows: [...windows.values()]
          .sort((left, right) => quotaWindowRank(left.type) - quotaWindowRank(right.type))
          .slice(0, QUOTA_WINDOW_TYPES.size),
        updatedAt: normalized.observedAt,
      };
      account.updatedAt = this.now();
      await this.writeStore();
      return publicAccount(account, account.id === this.data.activeId);
    });
  }

  requireAccount(id) {
    this.assertInitialized();
    const account = this.data.accounts.find((entry) => entry.id === String(id || ""));
    if (!account) throw storeError(404, "Claude 官方账号不存在");
    return account;
  }

  async ensureAccountDirectory(account) {
    const target = account.legacy
      ? this.legacyConfigDirectory
      : path.join(this.accountsDirectory, account.id, "config");
    await this.ensurePrivateDirectory(target);
    return target;
  }

  async ensurePrivateDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Claude official account directory is unsafe");
    }
    if (this.uid !== null && this.gid !== null && (stat.uid !== this.uid || stat.gid !== this.gid)) {
      await fs.chown(directory, this.uid, this.gid);
    }
    await fs.chmod(directory, 0o700);
  }

  async readStore() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (envelope.version !== STORE_VERSION) throw new Error("Unsupported Claude official account store");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const value = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(value.accounts)) throw new Error("Invalid Claude official account store");
      const accounts = value.accounts.map(normalizeStoredAccount);
      const activeId = ACCOUNT_ID_PATTERN.test(String(value.activeId || ""))
        && accounts.some((account) => account.id === value.activeId)
        ? value.activeId
        : null;
      return { version: STORE_VERSION, activeId, accounts };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`无法读取 Claude 官方账号存储: ${error.message}`);
      }
      const data = { version: STORE_VERSION, activeId: null, accounts: [] };
      this.data = data;
      await this.writeStore();
      return data;
    }
  }

  async writeStore() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.data), "utf8"),
      cipher.final(),
    ]);
    const envelope = {
      version: STORE_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporary = `${this.storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
      if (this.uid !== null && this.gid !== null) await fs.chown(temporary, this.uid, this.gid);
      await fs.rename(temporary, this.storePath);
      await fs.chmod(this.storePath, 0o600);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.key || !this.data) throw new Error("Claude official account store is not initialized");
  }
}

function normalizeStoredAccount(value) {
  if (!value || !ACCOUNT_ID_PATTERN.test(String(value.id || ""))) {
    throw new Error("Invalid Claude official account");
  }
  return {
    id: value.id,
    label: normalizeLabel(value.label) || "Claude 账号",
    email: boundedText(value.email, 320),
    subscriptionType: boundedText(value.subscriptionType, 64),
    legacy: value.legacy === true,
    credentialStatus: CREDENTIAL_STATUSES.has(value.credentialStatus)
      ? value.credentialStatus
      : "unknown",
    credentialStatusUpdatedAt: timestamp(value.credentialStatusUpdatedAt),
    lastCheckedAt: timestamp(value.lastCheckedAt),
    lastErrorCode: normalizeErrorCode(value.lastErrorCode),
    quota: normalizeQuota(value.quota),
    proxy: normalizeStoredProxy(value.proxy),
    createdAt: timestamp(value.createdAt) || Date.now(),
    updatedAt: timestamp(value.updatedAt) || Date.now(),
    lastUsedAt: timestamp(value.lastUsedAt),
  };
}

function publicAccount(account, active) {
  const quota = normalizeQuota(account.quota);
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    subscriptionType: account.subscriptionType,
    active,
    legacy: account.legacy,
    credentialStatus: account.credentialStatus,
    credentialStatusUpdatedAt: account.credentialStatusUpdatedAt,
    lastCheckedAt: account.lastCheckedAt,
    lastErrorCode: account.lastErrorCode,
    quota: quota
      ? { ...quota, windows: quota.windows.map((entry) => ({ ...entry })) }
      : null,
    quotaAvailable: Boolean(quota?.windows.length),
    proxy: account.proxy ? publicOfficialProxy(account.proxy) : null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt,
  };
}

function normalizeAuthStatus(value) {
  return {
    loggedIn: value?.loggedIn === true,
    email: boundedText(value?.email, 320),
    subscriptionType: boundedText(value?.subscriptionType, 64),
  };
}

function applyAuthStatus(account, status, timestampValue) {
  account.email = status.email || account.email;
  account.subscriptionType = status.subscriptionType || account.subscriptionType;
  account.credentialStatus = "valid";
  account.credentialStatusUpdatedAt = timestampValue;
  account.lastCheckedAt = timestampValue;
  account.lastErrorCode = null;
  account.updatedAt = timestampValue;
  account.lastUsedAt ||= timestampValue;
}

function normalizeStoredProxy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return {
      config: normalizeOfficialProxy(value.config || value),
      health: normalizeOfficialProxyHealth(value.health),
    };
  } catch {
    return null;
  }
}

function normalizeQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Array.isArray(value.windows)) {
    const windows = value.windows
      .map(normalizeQuotaWindow)
      .filter(Boolean)
      .sort((left, right) => quotaWindowRank(left.type) - quotaWindowRank(right.type))
      .slice(0, QUOTA_WINDOW_TYPES.size);
    const updatedAt = timestamp(value.updatedAt);
    if (!windows.length && !updatedAt) return null;
    return {
      source: value.source === "rate_limit_event" ? value.source : "unknown",
      status: QUOTA_STATUSES.has(value.status) ? value.status : "unknown",
      windows,
      updatedAt,
    };
  }
  // Migrate the unused v1 placeholder shape without inventing a current
  // upstream window. Existing records remain visible as legacy evidence.
  const usedPercent = Number(value.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  const legacyType = QUOTA_WINDOW_TYPES.has(value.window) ? value.window : null;
  return {
    source: "unknown",
    status: "unknown",
    windows: legacyType
      ? [{
        type: legacyType,
        utilization: Math.max(0, Math.min(1, usedPercent / 100)),
        resetsAt: rateLimitTimestamp(value.resetsAt),
        observedAt: timestamp(value.updatedAt) || Date.now(),
      }]
      : [],
    updatedAt: timestamp(value.updatedAt),
  };
}

function normalizeQuotaSample(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = QUOTA_STATUSES.has(value.status) ? value.status : "unknown";
  const type = QUOTA_WINDOW_TYPES.has(value.type) ? value.type : null;
  const utilization = Number(value.utilization);
  const resetsAt = rateLimitTimestamp(value.resetsAt);
  const observedAt = timestamp(value.observedAt) || now;
  const window = type
    ? {
      type,
      utilization: Number.isFinite(utilization)
        ? Math.max(0, Math.min(1, utilization))
        : null,
      resetsAt,
      observedAt,
    }
    : null;
  return window || status !== "unknown" ? { status, window, observedAt } : null;
}

function normalizeQuotaWindow(value) {
  if (!value || typeof value !== "object" || !QUOTA_WINDOW_TYPES.has(value.type)) return null;
  const utilization = Number(value.utilization);
  return {
    type: value.type,
    utilization: Number.isFinite(utilization)
      ? Math.max(0, Math.min(1, utilization))
      : null,
    resetsAt: rateLimitTimestamp(value.resetsAt),
    observedAt: timestamp(value.observedAt),
  };
}

function quotaWindowRank(type) {
  return [
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_overage_included",
    "overage",
  ].indexOf(type);
}

function rateLimitTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 1_000_000_000_000 ? number * 1_000 : number;
  return Number.isSafeInteger(Math.round(milliseconds)) ? Math.round(milliseconds) : null;
}

function normalizeLabel(value) {
  return boundedText(value, 64);
}

function normalizeErrorCode(value) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(code) ? code : null;
}

function boundedText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum && !/[\0\r\n]/.test(text) ? text : null;
}

function timestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function loadOrCreateKey(keyPath, { uid = null, gid = null } = {}) {
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid Claude official account key");
    await fs.chmod(keyPath, 0o600);
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = crypto.randomBytes(32);
    try {
      await fs.writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
      if (uid !== null && gid !== null) await fs.chown(keyPath, uid, gid);
      return key;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      return fs.readFile(keyPath);
    }
  }
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
