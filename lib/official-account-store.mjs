import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeOfficialProxy,
  normalizeOfficialProxyHealth,
  publicOfficialProxy,
} from "./official-proxy.mjs";

const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const AUTH_SLOT_VERSION = 1;
const AUTH_SLOT_DIRECTORY = "official-account-auth-v2";
const LEGACY_STORE_BACKUP = "official-accounts.v1.enc.readonly.json";
const MAX_ACCOUNTS = 10;
const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_SEEN_WORKSPACE_MESSAGES = 256;
const MAX_CREDITS_NUDGE_RECORDS = 32;
const ACCOUNT_ID_PATTERN = /^oa-[a-f0-9]{16}$/;
const CREDENTIAL_STATUSES = new Set(["unknown", "valid", "invalid"]);
const CREDITS_NUDGE_TYPES = new Set(["credits", "usage_limit"]);
const CREDITS_NUDGE_STATUSES = new Set(["sent", "failed"]);

export class OfficialAccountStore {
  constructor(directory, {
    codexHome,
    uid = null,
    gid = null,
    now = () => Date.now(),
  } = {}) {
    this.directory = path.resolve(directory);
    this.codexHome = path.resolve(codexHome);
    this.authPath = path.join(this.codexHome, "auth.json");
    this.keyPath = path.join(this.directory, "official-accounts.key");
    this.storePath = path.join(this.directory, "official-accounts.enc.json");
    this.authSlotDirectory = path.join(this.directory, AUTH_SLOT_DIRECTORY);
    this.legacyStoreBackupPath = path.join(this.directory, LEGACY_STORE_BACKUP);
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.now = now;
    this.key = null;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    if (this.uid !== null && this.gid !== null) await fs.chown(this.directory, this.uid, this.gid);
    await ensurePrivateDirectory(this.authSlotDirectory, { uid: this.uid, gid: this.gid });
    this.key = await loadOrCreateKey(this.keyPath);
    const loaded = await this.readStore();
    this.data = loaded.data;
    if (loaded.legacy) {
      await this.backupLegacyStore();
      for (const [accountId, auth] of loaded.legacyAuth) await this.writeSlotAuth(accountId, auth);
      await this.writeStore();
    } else if (loaded.created || loaded.needsWrite) {
      await this.writeStore();
    }
    await this.captureActive().catch(() => null);
    return this;
  }

  snapshot() {
    this.assertInitialized();
    return {
      activeId: this.data.activeId,
      accounts: this.data.accounts
        .map((account) => publicAccount(account, account.id === this.data.activeId))
        .sort((left, right) => Number(right.active) - Number(left.active) || right.lastUsedAt - left.lastUsedAt),
    };
  }

  async captureActive({
    account = null,
    rateLimits = null,
    credentialStatus = null,
    proxy = undefined,
    proxyHealth = undefined,
  } = {}) {
    return this.mutate(async () => {
      const auth = await readProtectedAuth(this.authPath, { uid: this.uid, gid: this.gid });
      if (!auth) return null;
      const metadata = accountMetadata(auth, account);
      if (!metadata) return null;
      let stored = this.data.accounts.find((entry) => entry.fingerprint === metadata.fingerprint);
      const timestamp = this.now();
      const nextCredentialStatus = CREDENTIAL_STATUSES.has(credentialStatus) ? credentialStatus : null;
      if (!stored) {
        if (this.data.accounts.length >= MAX_ACCOUNTS) {
          throw storeError(409, `最多保存 ${MAX_ACCOUNTS} 个官方账号`);
        }
        stored = {
          id: `oa-${crypto.randomBytes(8).toString("hex")}`,
          fingerprint: metadata.fingerprint,
          email: metadata.email,
          planType: metadata.planType,
          weekly: weeklyWindow(rateLimits),
          proxy: storedOfficialProxy(proxy, proxyHealth),
          workspaceMessages: emptyWorkspaceMessageState(),
          credentialStatus: nextCredentialStatus || "unknown",
          credentialStatusUpdatedAt: nextCredentialStatus ? timestamp : null,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUsedAt: timestamp,
        };
        await this.writeSlotAuth(stored.id, auth);
        this.data.accounts.push(stored);
      } else {
        stored.email = metadata.email || stored.email;
        stored.planType = metadata.planType || stored.planType;
        await this.writeSlotAuth(stored.id, auth);
        if (rateLimits) stored.weekly = weeklyWindow(rateLimits);
        if (proxy !== undefined) stored.proxy = storedOfficialProxy(proxy, proxyHealth);
        if (nextCredentialStatus) {
          stored.credentialStatus = nextCredentialStatus;
          stored.credentialStatusUpdatedAt = timestamp;
        }
        stored.updatedAt = timestamp;
        stored.lastUsedAt = timestamp;
      }
      this.data.activeId = stored.id;
      await this.writeStore();
      return publicAccount(stored, true);
    });
  }

  async activate(id) {
    return this.mutate(async () => {
      const target = this.requireAccount(id);
      if (target.credentialStatus === "invalid") {
        throw storeError(409, "此账号登录已失效，请重新登录后再切换");
      }
      await this.captureCurrentWithoutQueue();
      const targetAuth = await this.readSlotAuth(target.id, target.fingerprint);
      await this.writeActiveAuth(targetAuth);
      const timestamp = this.now();
      target.lastUsedAt = timestamp;
      target.updatedAt = timestamp;
      this.data.activeId = target.id;
      await this.writeStore();
      return publicAccount(target, true);
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      const index = this.data.accounts.findIndex((entry) => entry.id === id);
      if (index === -1) throw storeError(404, "官方账号不存在");
      const wasActive = this.data.activeId === id;
      let next = null;
      if (wasActive) {
        next = [...this.data.accounts]
          .filter((account) => account.id !== id && account.credentialStatus !== "invalid")
          .sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0] || null;
        if (next) {
          const nextAuth = await this.readSlotAuth(next.id, next.fingerprint);
          await this.writeActiveAuth(nextAuth);
          next.lastUsedAt = this.now();
          next.updatedAt = next.lastUsedAt;
          this.data.activeId = next.id;
        } else {
          await this.removeActiveAuth();
          this.data.activeId = null;
        }
      }
      this.data.accounts.splice(index, 1);
      await this.writeStore();
      await this.removeSlotAuth(id);
      return {
        removedActive: wasActive,
        activeAccount: next ? publicAccount(next, true) : null,
      };
    });
  }

  async recordRateLimits(rateLimits) {
    return this.mutate(async () => {
      const active = this.data.accounts.find((entry) => entry.id === this.data.activeId);
      if (!active) return null;
      active.weekly = weeklyWindow(rateLimits);
      active.updatedAt = this.now();
      await this.writeStore();
      return publicAccount(active, true);
    });
  }

  async setProxy(id, proxy, health = null) {
    return this.mutate(async () => {
      const account = this.requireAccount(id);
      account.proxy = storedOfficialProxy(proxy, health);
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

  privateProxy(id = this.data.activeId) {
    this.assertInitialized();
    if (!id) return null;
    const account = this.requireAccount(id);
    return account.proxy ? { ...account.proxy.config } : null;
  }

  proxyHealth(id = this.data.activeId) {
    this.assertInitialized();
    if (!id) return null;
    const account = this.requireAccount(id);
    return account.proxy?.health ? { ...account.proxy.health } : null;
  }

  nextAccountIdAfterRemoval(id) {
    this.assertInitialized();
    if (this.data.activeId !== String(id || "")) return this.data.activeId;
    return [...this.data.accounts]
      .filter((account) => account.id !== id && account.credentialStatus !== "invalid")
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0]?.id || null;
  }

  async markActiveInvalid() {
    return this.mutate(async () => {
      const active = this.data.accounts.find((entry) => entry.id === this.data.activeId);
      if (!active) return null;
      if (active.credentialStatus !== "invalid") {
        const timestamp = this.now();
        active.credentialStatus = "invalid";
        active.credentialStatusUpdatedAt = timestamp;
        active.updatedAt = timestamp;
        await this.writeStore();
      }
      return publicAccount(active, true);
    });
  }

  workspaceMessageState(accountId = this.data.activeId) {
    this.assertInitialized();
    const account = this.data.accounts.find((entry) => entry.id === accountId);
    const state = account?.workspaceMessages || emptyWorkspaceMessageState();
    return {
      seenMessageIds: state.seen.map((entry) => entry.id),
      nudges: state.nudges.map((entry) => ({ ...entry })),
    };
  }

  async acknowledgeWorkspaceMessages(messageIds, { accountId = this.data.activeId } = {}) {
    const ids = normalizeWorkspaceMessageIds(messageIds);
    return this.mutate(async () => {
      if (!accountId || this.data.activeId !== accountId) throw storeError(409, "活动官方账号已经切换，请刷新后重试");
      const active = this.data.accounts.find((entry) => entry.id === accountId);
      if (!active) throw storeError(409, "当前没有活动的官方账号");
      const timestamp = this.now();
      const seen = new Map(active.workspaceMessages.seen.map((entry) => [entry.id, entry]));
      for (const id of ids) seen.set(id, { id, seenAt: timestamp });
      active.workspaceMessages.seen = [...seen.values()]
        .sort((left, right) => right.seenAt - left.seenAt)
        .slice(0, MAX_SEEN_WORKSPACE_MESSAGES);
      active.updatedAt = timestamp;
      await this.writeStore();
      return this.workspaceMessageState();
    });
  }

  creditsNudgeCooldown(creditType, cooldownMs, { accountId = this.data.activeId } = {}) {
    this.assertInitialized();
    const type = normalizeCreditsNudgeType(creditType);
    const duration = Number(cooldownMs);
    if (!Number.isFinite(duration) || duration < 0) throw new Error("Invalid credits nudge cooldown");
    if (!accountId || this.data.activeId !== accountId) throw storeError(409, "活动官方账号已经切换，请刷新后重试");
    const active = this.data.accounts.find((entry) => entry.id === accountId);
    if (!active) throw storeError(409, "当前没有活动的官方账号");
    const last = active?.workspaceMessages?.nudges
      .find((entry) => entry.creditType === type && entry.status === "sent") || null;
    const retryAfterMs = last ? Math.max(0, last.at + Math.floor(duration) - this.now()) : 0;
    return {
      allowed: retryAfterMs === 0,
      retryAfterMs,
      last: last ? { ...last } : null,
    };
  }

  async recordCreditsNudge(creditType, status, { accountId = this.data.activeId } = {}) {
    const type = normalizeCreditsNudgeType(creditType);
    if (!CREDITS_NUDGE_STATUSES.has(status)) throw new Error("Invalid credits nudge status");
    return this.mutate(async () => {
      if (!accountId) throw storeError(409, "当前没有活动的官方账号");
      const active = this.data.accounts.find((entry) => entry.id === accountId);
      if (!active) throw storeError(409, "官方账号已被移除");
      const record = { creditType: type, status, at: this.now() };
      active.workspaceMessages.nudges = [record, ...active.workspaceMessages.nudges]
        .slice(0, MAX_CREDITS_NUDGE_RECORDS);
      active.updatedAt = record.at;
      await this.writeStore();
      return { ...record };
    });
  }

  requireAccount(id) {
    const account = this.data.accounts.find((entry) => entry.id === String(id || ""));
    if (!account) throw storeError(404, "官方账号不存在");
    return account;
  }

  async captureCurrentWithoutQueue() {
    const auth = await readProtectedAuth(this.authPath, { uid: this.uid, gid: this.gid });
    if (!auth) return;
    const metadata = accountMetadata(auth);
    if (!metadata) return;
    const current = this.data.accounts.find((entry) => entry.fingerprint === metadata.fingerprint);
    if (!current) return;
    await this.writeSlotAuth(current.id, auth);
    current.email = metadata.email || current.email;
    current.planType = metadata.planType || current.planType;
    current.updatedAt = this.now();
  }

  async writeActiveAuth(auth) {
    await fs.mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      this.codexHome,
      `.auth.json.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (this.uid !== null && this.gid !== null) await fs.chown(temporaryPath, this.uid, this.gid);
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.authPath);
      if (this.uid !== null && this.gid !== null) await fs.chown(this.authPath, this.uid, this.gid);
      await fs.chmod(this.authPath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async removeActiveAuth() {
    try {
      const stat = await fs.lstat(this.authPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Codex auth path is not a regular file");
      await fs.unlink(this.authPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async writeSlotAuth(accountId, auth) {
    const metadata = accountMetadata(auth);
    if (!metadata) throw new Error("Invalid official account credentials");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(slotAdditionalData(accountId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(auth), "utf8"),
      cipher.final(),
    ]);
    const envelope = {
      version: AUTH_SLOT_VERSION,
      accountId,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const slotPath = this.slotAuthPath(accountId);
    const temporaryPath = `${slotPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
      if (this.uid !== null && this.gid !== null) await fs.chown(temporaryPath, this.uid, this.gid);
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, slotPath);
      if (this.uid !== null && this.gid !== null) await fs.chown(slotPath, this.uid, this.gid);
      await fs.chmod(slotPath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async readSlotAuth(accountId, expectedFingerprint = null) {
    const slotPath = this.slotAuthPath(accountId);
    let handle;
    try {
      handle = await fs.open(slotPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (
        !stat.isFile()
        || stat.size < 2
        || stat.size > MAX_AUTH_BYTES * 2
        || (stat.mode & 0o777) !== 0o600
        || (this.uid !== null && stat.uid !== this.uid)
        || (this.gid !== null && stat.gid !== this.gid)
      ) throw new Error("Official account auth slot permissions are invalid");
      const envelope = JSON.parse(await handle.readFile("utf8"));
      if (envelope.version !== AUTH_SLOT_VERSION || envelope.accountId !== accountId) {
        throw new Error("Official account auth slot version is invalid");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(slotAdditionalData(accountId));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const auth = JSON.parse(plaintext.toString("utf8"));
      const metadata = accountMetadata(auth);
      if (!metadata || (expectedFingerprint && metadata.fingerprint !== expectedFingerprint)) {
        throw new Error("Official account auth slot identity does not match");
      }
      return auth;
    } catch (error) {
      throw new Error(`无法读取官方账号独立凭据: ${error.message}`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async removeSlotAuth(accountId) {
    const slotPath = this.slotAuthPath(accountId);
    try {
      const stat = await fs.lstat(slotPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Official account auth slot is not a regular file");
      await fs.unlink(slotPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  slotAuthPath(accountId) {
    if (!ACCOUNT_ID_PATTERN.test(String(accountId || ""))) throw new Error("Invalid official account id");
    return path.join(this.authSlotDirectory, `${accountId}.enc.json`);
  }

  async backupLegacyStore() {
    try {
      await fs.copyFile(this.storePath, this.legacyStoreBackupPath, fsConstants.COPYFILE_EXCL);
      if (this.uid !== null && this.gid !== null) {
        await fs.chown(this.legacyStoreBackupPath, this.uid, this.gid);
      }
      await fs.chmod(this.legacyStoreBackupPath, 0o400);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  async readStore() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (![LEGACY_STORE_VERSION, STORE_VERSION].includes(envelope.version)) {
        throw new Error("Unsupported official account store version");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const value = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(value.accounts)) throw new Error("Invalid official account store");
      const legacyAuth = new Map();
      const accounts = [];
      let needsWrite = false;
      for (const entry of value.accounts) {
        let auth = null;
        let isolatedCredentialFailure = false;
        if (envelope.version === LEGACY_STORE_VERSION) {
          auth = entry?.auth;
        } else {
          try {
            auth = await this.readSlotAuth(entry?.id, entry?.fingerprint);
          } catch {
            isolatedCredentialFailure = true;
            needsWrite = true;
          }
        }
        const account = normalizeStoredAccount(entry, auth, { allowMissingCredentials: isolatedCredentialFailure });
        if (isolatedCredentialFailure) {
          account.credentialStatus = "invalid";
          account.credentialStatusUpdatedAt = this.now();
          account.updatedAt = account.credentialStatusUpdatedAt;
        }
        accounts.push(account);
        if (envelope.version === LEGACY_STORE_VERSION) legacyAuth.set(account.id, auth);
      }
      const activeId = ACCOUNT_ID_PATTERN.test(String(value.activeId || ""))
        && accounts.some((account) => account.id === value.activeId)
        ? value.activeId
        : null;
      return {
        data: { version: STORE_VERSION, activeId, accounts },
        legacyAuth,
        legacy: envelope.version === LEGACY_STORE_VERSION,
        needsWrite,
        created: false,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取官方账号存储: ${error.message}`);
      const data = { version: STORE_VERSION, activeId: null, accounts: [] };
      return { data, legacyAuth: new Map(), legacy: false, needsWrite: false, created: true };
    }
  }

  async writeStore() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({
        ...this.data,
        accounts: this.data.accounts.map(storedAccountRecord),
      }), "utf8"),
      cipher.final(),
    ]);
    const envelope = {
      version: STORE_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporaryPath = `${this.storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, this.storePath);
      await fs.chmod(this.storePath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.key || !this.data) throw new Error("Official account store is not initialized");
  }
}

export function accountMetadata(auth, account = null) {
  if (!auth || auth.auth_mode !== "chatgpt" || !auth.tokens || typeof auth.tokens !== "object") return null;
  const idToken = decodeJwtPayload(auth.tokens.id_token);
  const accessToken = decodeJwtPayload(auth.tokens.access_token);
  if (!openAiPayload(idToken) && !openAiPayload(accessToken)) return null;
  const idAuth = idToken?.["https://api.openai.com/auth"];
  const accessAuth = accessToken?.["https://api.openai.com/auth"];
  const stableId = [
    accessAuth?.chatgpt_account_id,
    idAuth?.chatgpt_account_id,
    accessAuth?.chatgpt_user_id,
    idAuth?.chatgpt_user_id,
    accessToken?.sub,
    idToken?.sub,
    idToken?.email,
  ].find((value) => boundedText(value, 512));
  if (!stableId) return null;
  return {
    fingerprint: crypto.createHash("sha256").update(String(stableId)).digest("base64url"),
    email: boundedText(account?.email, 320) || boundedText(idToken?.email, 320),
    planType: boundedText(account?.planType, 64)
      || boundedText(accessAuth?.chatgpt_plan_type, 64)
      || boundedText(idAuth?.chatgpt_plan_type, 64)
      || "unknown",
  };
}

async function readProtectedAuth(authPath, { uid = null, gid = null } = {}) {
  let handle;
  try {
    handle = await fs.open(authPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.size < 2
      || stat.size > MAX_AUTH_BYTES
      || (stat.mode & 0o777) !== 0o600
      || (uid !== null && stat.uid !== uid)
      || (gid !== null && stat.gid !== gid)
    ) return null;
    const value = JSON.parse(await handle.readFile("utf8"));
    return accountMetadata(value) ? value : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function loadOrCreateKey(keyPath) {
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid official account store key");
    await fs.chmod(keyPath, 0o600);
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = crypto.randomBytes(32);
    try {
      await fs.writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
      return key;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      return fs.readFile(keyPath);
    }
  }
}

function normalizeStoredAccount(value, auth, { allowMissingCredentials = false } = {}) {
  if (!value || !ACCOUNT_ID_PATTERN.test(String(value.id || ""))) throw new Error("Invalid official account");
  const metadata = accountMetadata(auth);
  const storedFingerprint = boundedText(value.fingerprint, 128);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(storedFingerprint || "")
    || (metadata && metadata.fingerprint !== storedFingerprint)
    || (!metadata && !allowMissingCredentials)
  ) throw new Error("Invalid official account credentials");
  return {
    id: value.id,
    fingerprint: metadata?.fingerprint || storedFingerprint,
    email: boundedText(value.email, 320) || metadata?.email,
    planType: boundedText(value.planType, 64) || metadata?.planType || "unknown",
    weekly: normalizeWeekly(value.weekly),
    proxy: normalizeStoredOfficialProxy(value.proxy),
    workspaceMessages: normalizeWorkspaceMessageState(value.workspaceMessages),
    credentialStatus: CREDENTIAL_STATUSES.has(value.credentialStatus) ? value.credentialStatus : "unknown",
    credentialStatusUpdatedAt: timestamp(value.credentialStatusUpdatedAt),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    lastUsedAt: timestamp(value.lastUsedAt),
  };
}

function storedAccountRecord(account) {
  return {
    id: account.id,
    fingerprint: account.fingerprint,
    email: account.email,
    planType: account.planType,
    weekly: account.weekly,
    proxy: account.proxy,
    workspaceMessages: account.workspaceMessages,
    credentialStatus: account.credentialStatus,
    credentialStatusUpdatedAt: account.credentialStatusUpdatedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt,
  };
}

function slotAdditionalData(accountId) {
  return Buffer.from(`wfl-codex-official-account:${accountId}:v${AUTH_SLOT_VERSION}`, "utf8");
}

async function ensurePrivateDirectory(directory, { uid = null, gid = null } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Official account auth slot directory is invalid");
  if (uid !== null && gid !== null) await fs.chown(directory, uid, gid);
  await fs.chmod(directory, 0o700);
}

function publicAccount(account, active) {
  return {
    id: account.id,
    email: account.email,
    planType: account.planType,
    active,
    weekly: account.weekly ? { ...account.weekly } : null,
    proxy: account.proxy ? publicOfficialProxy(account.proxy) : null,
    credentialStatus: account.credentialStatus,
    credentialStatusUpdatedAt: account.credentialStatusUpdatedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt,
  };
}

function emptyWorkspaceMessageState() {
  return { seen: [], nudges: [] };
}

function normalizeWorkspaceMessageState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyWorkspaceMessageState();
  const seen = [];
  const seenIds = new Set();
  for (const entry of Array.isArray(value.seen) ? value.seen : []) {
    const id = boundedText(entry?.id, 256);
    const seenAt = timestamp(entry?.seenAt);
    if (!id || seenAt === null || seenIds.has(id)) continue;
    seenIds.add(id);
    seen.push({ id, seenAt });
    if (seen.length >= MAX_SEEN_WORKSPACE_MESSAGES) break;
  }
  const nudges = [];
  for (const entry of Array.isArray(value.nudges) ? value.nudges : []) {
    if (!CREDITS_NUDGE_TYPES.has(entry?.creditType) || !CREDITS_NUDGE_STATUSES.has(entry?.status)) continue;
    const at = timestamp(entry.at);
    if (at === null) continue;
    nudges.push({ creditType: entry.creditType, status: entry.status, at });
    if (nudges.length >= MAX_CREDITS_NUDGE_RECORDS) break;
  }
  return {
    seen: seen.sort((left, right) => right.seenAt - left.seenAt),
    nudges: nudges.sort((left, right) => right.at - left.at),
  };
}

function normalizeWorkspaceMessageIds(value) {
  if (!Array.isArray(value) || value.length > 64) throw storeError(400, "工作区消息确认范围无效");
  const ids = [...new Set(value.map((entry) => boundedText(entry, 256)).filter(Boolean))];
  if (ids.length !== value.length) throw storeError(400, "工作区消息编号无效");
  return ids;
}

function normalizeCreditsNudgeType(value) {
  if (!CREDITS_NUDGE_TYPES.has(value)) throw storeError(400, "额度提醒类型无效");
  return value;
}

function storedOfficialProxy(value, health = undefined) {
  if (value == null) return null;
  return {
    config: normalizeOfficialProxy(value),
    health: health === undefined ? null : normalizeOfficialProxyHealth(health),
  };
}

function normalizeStoredOfficialProxy(value) {
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

function weeklyWindow(rateLimits) {
  const candidates = [];
  for (const bucket of rateLimits?.buckets || []) {
    if (bucket?.primary) candidates.push(bucket.primary);
    if (bucket?.secondary) candidates.push(bucket.secondary);
  }
  const exact = candidates.find((window) => window.windowDurationMins === 7 * 24 * 60);
  const longer = candidates
    .filter((window) => Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins >= 24 * 60)
    .sort((left, right) => right.windowDurationMins - left.windowDurationMins)[0];
  return normalizeWeekly(exact || longer || null);
}

function normalizeWeekly(value) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = boundedPercent(value.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    resetsAt: timestamp(value.resetsAt, { seconds: true }),
    windowDurationMins: safeInteger(value.windowDurationMins),
  };
}

function decodeJwtPayload(value) {
  if (typeof value !== "string" || value.length > 64 * 1024) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function openAiPayload(value) {
  return value?.iss === "https://auth.openai.com";
}

function boundedText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : null;
}

function boundedPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : null;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function timestamp(value, { seconds = false } = {}) {
  const number = safeInteger(value);
  if (number === null) return null;
  return seconds && number > 10_000_000_000 ? null : number;
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
