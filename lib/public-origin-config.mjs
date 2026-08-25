import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const PUBLIC_ORIGIN_CONFIG_VERSION = 1;
export const DEFAULT_PREVIEW_SLOT_COUNT = 4;
export const MAX_PREVIEW_SLOT_COUNT = 16;
export const PREVIEW_ISOLATION_MODES = new Set(["pool", "session"]);

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PREVIEW_HOST = /^preview-([1-9][0-9]{0,2})\.(.+)$/i;

export class PublicOriginConfigStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
  } = {}) {
    this.stateDirectory = path.resolve(stateDirectory);
    this.filePath = path.join(this.stateDirectory, "public-origin.json");
    this.now = now;
    this.randomBytes = randomBytes;
    this.data = null;
    this.loadError = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = false } = {}) {
    let loaded = null;
    try {
      loaded = await readJson(this.filePath);
      this.data = loaded ? normalizeStoredConfig(loaded) : emptyConfig();
    } catch (error) {
      // A damaged or old config must never prevent the main site from
      // starting. Keep the file untouched and stay in the sandbox fallback.
      this.loadError = error;
      this.data = emptyConfig();
    }
    if (writeOnInitialize && !loaded) await this.write();
    return this;
  }

  snapshot() {
    return cloneConfig(this.data || emptyConfig());
  }

  candidates({
    configuredOrigin = null,
    accessState = null,
    forwardedHost = null,
    forwardedProtocol = null,
    requestHost = null,
    requestProtocol = null,
    trustedProxy = false,
  } = {}) {
    const candidates = [];
    const add = (origin, source, confidence) => {
      try {
        const normalized = normalizePublicOrigin(origin, { allowLoopback: true });
        if (candidates.some((entry) => entry.origin === normalized)) return;
        candidates.push({ origin: normalized, source, confidence, requiresOwnerConfirmation: true });
      } catch {
        // Candidate discovery is best-effort; invalid proxy state must not stop boot.
      }
    };

    if (configuredOrigin) add(configuredOrigin, "explicit-config", "explicit");
    if (accessState?.hostname) {
      const protocol = accessState.protocol || "https";
      add(`${protocol}://${accessState.hostname}`, "access-state", "high");
    }
    if (trustedProxy && forwardedHost) {
      add(`${forwardedProtocol || "https"}://${forwardedHost}`, "trusted-forwarded-host", "high");
    }
    if (requestHost) {
      add(`${requestProtocol || "https"}://${requestHost}`, "request-host", trustedProxy ? "medium" : "low");
    }
    return candidates;
  }

  async confirm({
    publicOrigin,
    previewBaseDomain = null,
    previewOrigins = null,
    slotCount = DEFAULT_PREVIEW_SLOT_COUNT,
    isolation = "pool",
    confirmedBy,
    source = "owner",
  } = {}) {
    const normalizedOrigin = normalizePublicOrigin(publicOrigin, { allowLoopback: false });
    const normalizedSlotCount = normalizeSlotCount(slotCount);
    const normalizedIsolation = normalizePreviewIsolation(isolation);
    const baseDomain = normalizePreviewBaseDomain(
      previewBaseDomain || new URL(normalizedOrigin).hostname,
    );
    const expected = previewOriginCandidates({
      publicOrigin: normalizedOrigin,
      previewBaseDomain: baseDomain,
      slotCount: normalizedSlotCount,
      isolation: normalizedIsolation,
    });
    const normalizedOrigins = previewOrigins === null
      ? expected
      : normalizePreviewOrigins(previewOrigins, { baseDomain, expectedCount: normalizedSlotCount });
    if (normalizedOrigins.length !== normalizedSlotCount) {
      throw originError(400, "预览域名数量必须与槽位数量一致");
    }
    const next = {
      version: PUBLIC_ORIGIN_CONFIG_VERSION,
      mode: "confirmed",
      publicOrigin: normalizedOrigin,
      previewBaseDomain: baseDomain,
      previewOrigins: normalizedOrigins,
      slotCount: normalizedSlotCount,
      isolation: normalizedIsolation,
      confirmedBy: normalizeActor(confirmedBy),
      confirmedAt: this.now(),
      source: normalizeSource(source),
      disabledBy: null,
      disabledAt: null,
      disabledReason: null,
    };
    this.data = next;
    await this.write();
    return this.snapshot();
  }

  async disable({ actor = null, reason = "owner-disabled" } = {}) {
    this.data = {
      ...emptyConfig(),
      disabledBy: normalizeActor(actor),
      disabledAt: this.now(),
      disabledReason: normalizeReason(reason),
    };
    await this.write();
    return this.snapshot();
  }

  async write() {
    if (!this.data) this.data = emptyConfig();
    const content = `${JSON.stringify(this.data, null, 2)}\n`;
    const temporary = `${this.filePath}.${process.pid}.${this.randomBytes(5).toString("hex")}.tmp`;
    const task = this.writeQueue.then(async () => {
      await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    this.writeQueue = task.catch(() => {});
    try {
      await task;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw new Error(`无法保存公开 Origin 配置: ${error.message}`);
    }
  }
}

export function emptyConfig() {
  return {
    version: PUBLIC_ORIGIN_CONFIG_VERSION,
    mode: "unconfigured",
    publicOrigin: null,
    previewBaseDomain: null,
      previewOrigins: [],
      slotCount: 0,
      isolation: "pool",
      confirmedBy: null,
    confirmedAt: null,
    source: null,
    disabledBy: null,
    disabledAt: null,
    disabledReason: null,
  };
}

export function normalizePublicOrigin(value, { allowLoopback = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 512) throw originError(400, "公开 Origin 不正确");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw originError(400, "公开 Origin 必须是完整的 http(s) 地址");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = LOOPBACK_HOSTS.has(hostname) || isPrivateIp(hostname);
  if (parsed.protocol !== "https:" && !(allowLoopback && parsed.protocol === "http:" && loopback)) {
    throw originError(400, "公网 Origin 必须使用 HTTPS；HTTP 只允许回环地址");
  }
  if (!HOSTNAME.test(hostname) && !isIpAddress(hostname)) throw originError(400, "公开 Origin 的主机名不正确");
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw originError(400, "公开 Origin 不能包含凭据、路径、查询或片段");
  }
  if (!allowLoopback && loopback) throw originError(400, "公网 Origin 不能使用本机或私有地址");
  const port = parsed.port && !((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80"))
    ? `:${parsed.port}`
    : "";
  return `${parsed.protocol}//${hostname}${port}`;
}

export function normalizePreviewBaseDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.length > 253 || domain.includes("*") || !HOSTNAME.test(domain) || isIpAddress(domain)) {
    throw originError(400, "预览基础域名不正确");
  }
  return domain;
}

export function normalizePreviewOrigins(values, { baseDomain, expectedCount = null } = {}) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_PREVIEW_SLOT_COUNT) {
    throw originError(400, "预览 Origin 列表不正确");
  }
  const normalizedBase = normalizePreviewBaseDomain(baseDomain);
  const origins = values.map((value) => {
    const origin = normalizePublicOrigin(value, { allowLoopback: false });
    const host = new URL(origin).hostname;
    const match = PREVIEW_HOST.exec(host);
    if (!match || match[2] !== normalizedBase) throw originError(400, "预览 Origin 必须属于已确认的基础域名");
    return origin;
  });
  const unique = [...new Set(origins)];
  if (unique.length !== origins.length) throw originError(400, "预览 Origin 不能重复");
  if (expectedCount !== null && unique.length !== expectedCount) throw originError(400, "预览 Origin 数量不匹配");
  return unique;
}

export function previewOriginCandidates({ publicOrigin, previewBaseDomain = null, slotCount = DEFAULT_PREVIEW_SLOT_COUNT } = {}) {
  const normalizedOrigin = normalizePublicOrigin(publicOrigin, { allowLoopback: false });
  const baseDomain = normalizePreviewBaseDomain(previewBaseDomain || new URL(normalizedOrigin).hostname);
  const count = normalizeSlotCount(slotCount);
  return Array.from({ length: count }, (_unused, index) => `https://preview-${index + 1}.${baseDomain}`);
}

export function previewOriginSlot(value, { configuredOrigins = [] } = {}) {
  const origin = normalizePublicOrigin(value, { allowLoopback: false });
  const index = configuredOrigins.findIndex((candidate) => normalizePublicOrigin(candidate) === origin);
  if (index === -1) throw originError(404, "预览 Origin 不在本机已确认的域名池中");
  return { origin, slot: index + 1 };
}

export function normalizePreviewIsolation(value) {
  const isolation = String(value || "pool").trim().toLowerCase();
  if (!PREVIEW_ISOLATION_MODES.has(isolation)) throw originError(400, "预览隔离模式不正确");
  return isolation;
}

export function previewSessionOrigin({ previewBaseDomain, randomBytes = crypto.randomBytes } = {}) {
  const baseDomain = normalizePreviewBaseDomain(previewBaseDomain);
  return `https://preview-session-${randomBytes(12).toString("hex")}.${baseDomain}`;
}

export function isConfiguredPreviewOrigin(config, value) {
  if (config?.mode !== "confirmed") return false;
  let origin;
  try {
    origin = normalizePublicOrigin(value, { allowLoopback: false });
  } catch {
    return false;
  }
  if (config.isolation !== "session") return config.previewOrigins.includes(origin);
  const baseDomain = normalizePreviewBaseDomain(config.previewBaseDomain);
  const host = new URL(origin).hostname;
  return host.endsWith(`.${baseDomain}`)
    && /^preview-session-[0-9a-f]{24}\./i.test(host);
}

export function normalizeSlotCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PREVIEW_SLOT_COUNT) {
    throw originError(400, `预览槽位数量必须在 1-${MAX_PREVIEW_SLOT_COUNT} 之间`);
  }
  return count;
}

function normalizeStoredConfig(value) {
  if (value?.version !== PUBLIC_ORIGIN_CONFIG_VERSION) throw new Error("公开 Origin 配置版本不兼容");
  if (value.mode === "unconfigured") return emptyConfig();
  if (value.mode !== "confirmed") throw new Error("公开 Origin 配置模式不正确");
  const publicOrigin = normalizePublicOrigin(value.publicOrigin, { allowLoopback: false });
  const slotCount = normalizeSlotCount(value.slotCount);
  const previewBaseDomain = normalizePreviewBaseDomain(value.previewBaseDomain || new URL(publicOrigin).hostname);
  const previewOrigins = normalizePreviewOrigins(value.previewOrigins, {
    baseDomain: previewBaseDomain,
    expectedCount: slotCount,
  });
  const isolation = normalizePreviewIsolation(value.isolation);
  return {
    ...emptyConfig(),
    mode: "confirmed",
    publicOrigin,
    previewBaseDomain,
    previewOrigins,
    slotCount,
    isolation,
    confirmedBy: normalizeActor(value.confirmedBy),
    confirmedAt: normalizeTimestamp(value.confirmedAt, "confirmedAt"),
    source: normalizeSource(value.source),
  };
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeActor(value) {
  if (value === null || value === undefined || value === "") return null;
  const actor = String(value);
  if (actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw originError(400, "确认账号标识不正确");
  return actor;
}

function normalizeSource(value) {
  const source = String(value || "owner");
  if (!["owner", "access-state", "trusted-forwarded-host", "explicit-config"].includes(source)) {
    throw originError(400, "公开 Origin 配置来源不正确");
  }
  return source;
}

function normalizeReason(value) {
  const reason = String(value || "owner-disabled");
  if (reason.length > 256 || /[\u0000-\u001f\u007f]/.test(reason)) throw originError(400, "停用原因不正确");
  return reason;
}

function normalizeTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`invalid ${label}`);
  return timestamp;
}

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`无法读取公开 Origin 配置: ${error.message}`);
  }
}

function isIpAddress(value) {
  return net.isIP(stripIpBrackets(value)) > 0 || /^[0-9.]+$/.test(value);
}

function isPrivateIp(value) {
  const normalized = stripIpBrackets(String(value || "")).toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 100 && b >= 64 && b <= 127
      || a === 127
      || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 0 || b === 168)
      || a >= 224;
  }
  if (family !== 6) return false;
  // IPv4-mapped IPv6 literals can be rendered in hexadecimal by URL. Treat
  // the whole mapped range as non-public rather than risk accepting a private
  // address after normalization.
  if (normalized.startsWith("::ffff:")) return true;
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^(?:fe[89ab])/.test(normalized)
    || normalized.startsWith("ff");
}

function stripIpBrackets(value) {
  const normalized = String(value || "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function originError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
