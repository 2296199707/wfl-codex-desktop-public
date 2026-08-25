import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_PROFILES = 20;
const DEFAULT_MODEL = "sonnet";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

export class ClaudeStore {
  constructor(directory) {
    this.directory = directory;
    this.keyPath = path.join(directory, "store.key");
    this.storePath = path.join(directory, "profiles.enc.json");
    this.key = null;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    this.key = await loadOrCreateKey(this.keyPath);
    this.data = await this.readStore();
    return this;
  }

  snapshot() {
    this.assertInitialized();
    return {
      activeId: this.data.activeId,
      profiles: this.data.profiles.map(publicProfile),
    };
  }

  getProfile(id) {
    this.assertInitialized();
    const profile = this.data.profiles.find((entry) => entry.id === id);
    return profile ? { ...profile } : null;
  }

  getActiveProfile() {
    return this.data?.activeId ? this.getProfile(this.data.activeId) : null;
  }

  async create(input = {}) {
    return this.mutate(async () => {
      if (this.data.profiles.length >= MAX_PROFILES) throw storeError(400, "最多保存 20 个 Claude API 供应商");
      const profile = normalizeProfile(input);
      profile.id = `c-${crypto.randomBytes(6).toString("hex")}`;
      this.data.profiles.push(profile);
      if (!this.data.activeId) this.data.activeId = profile.id;
      await this.writeStore();
      return publicProfile(profile);
    });
  }

  async update(id, input = {}) {
    return this.mutate(async () => {
      const index = this.data.profiles.findIndex((entry) => entry.id === id);
      if (index === -1) throw storeError(404, "Claude API 供应商不存在");
      const profile = normalizeProfile(input, this.data.profiles[index]);
      profile.id = id;
      this.data.profiles[index] = profile;
      await this.writeStore();
      return publicProfile(profile);
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      const index = this.data.profiles.findIndex((entry) => entry.id === id);
      if (index === -1) throw storeError(404, "Claude API 供应商不存在");
      this.data.profiles.splice(index, 1);
      if (this.data.activeId === id) this.data.activeId = this.data.profiles[0]?.id || null;
      await this.writeStore();
    });
  }

  async setActive(id) {
    return this.mutate(async () => {
      if (id !== null && !this.data.profiles.some((entry) => entry.id === id)) {
        throw storeError(404, "Claude API 供应商不存在");
      }
      this.data.activeId = id;
      await this.writeStore();
    });
  }

  async readStore() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (envelope.version !== STORE_VERSION) throw new Error("Unsupported Claude store version");
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
      const data = JSON.parse(plaintext.toString("utf8"));
      const profiles = Array.isArray(data.profiles) ? data.profiles.map((profile) => normalizeStoredProfile(profile)) : [];
      return {
        version: STORE_VERSION,
        activeId: typeof data.activeId === "string" && profiles.some((profile) => profile.id === data.activeId)
          ? data.activeId
          : null,
        profiles,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取 Claude API 配置: ${error.message}`);
      const data = { version: STORE_VERSION, activeId: null, profiles: [] };
      this.data = data;
      await this.writeStore();
      return data;
    }
  }

  async writeStore() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.data), "utf8"), cipher.final()]);
    const envelope = {
      version: STORE_VERSION,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporaryPath = `${this.storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, this.storePath);
    await fs.chmod(this.storePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.data || !this.key) throw new Error("Claude store is not initialized");
  }
}

export function publicClaudeProfile(profile) {
  return publicProfile(profile);
}

function normalizeProfile(input, previous = null) {
  const name = boundedText(input.name, 64) || previous?.name || "Claude API";
  const baseUrl = normalizeUrl(input.baseUrl || input.base_url || previous?.baseUrl || DEFAULT_BASE_URL);
  const model = boundedText(input.model, 128) || previous?.model || DEFAULT_MODEL;
  const apiKey = input.apiKey === undefined ? previous?.apiKey || "" : boundedText(input.apiKey, 4096) || "";
  return { id: previous?.id || null, name, baseUrl, model, apiKey };
}

function normalizeStoredProfile(input) {
  const profile = normalizeProfile(input);
  const id = /^c-[a-f0-9]{12}$/.test(String(input?.id || "")) ? input.id : `c-${crypto.randomBytes(6).toString("hex")}`;
  return { ...profile, id };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    configured: Boolean(profile.apiKey),
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("invalid");
    return url.href.replace(/\/$/, "");
  } catch {
    throw storeError(400, "Claude Base URL 必须是有效的 http(s) 地址");
  }
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

async function loadOrCreateKey(keyPath) {
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid Claude store key");
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = crypto.randomBytes(32);
    await fs.writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
    return key;
  }
}

function storeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
