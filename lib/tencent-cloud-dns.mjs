import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isBlockedAddress } from "./preview-capture-policy.mjs";

export const TENCENT_DNS_CONFIG_VERSION = 1;
export const TENCENT_DNS_ENDPOINT = "https://dnspod.tencentcloudapi.com/";
export const TENCENT_DNS_SERVICE = "dnspod";
export const TENCENT_DNS_API_VERSION = "2021-03-23";
export const TENCENT_DNS_REGIONS = new Set([
  "ap-guangzhou",
  "ap-shanghai",
  "ap-beijing",
  "ap-chengdu",
  "ap-hongkong",
  "ap-singapore",
  "ap-seoul",
  "ap-tokyo",
]);
export const TENCENT_SETUP_PHASES = new Set(["idle", "queued", "dns", "certificate", "proxy", "verifying", "completed", "failed"]);

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
const MAX_SECRET_LENGTH = 512;

export class TencentCloudCredentialStore {
  constructor(stateDirectory, { now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    this.stateDirectory = path.resolve(stateDirectory);
    this.filePath = path.join(this.stateDirectory, "tencent-cloud-dns.json");
    this.now = now;
    this.randomBytes = randomBytes;
    this.data = null;
    this.loadError = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = false } = {}) {
    try {
      const value = await readJson(this.filePath);
      this.data = value ? normalizeStoredCredentials(value) : emptyCredentials();
    } catch (error) {
      // A malformed credential file must fail closed and must never be replaced
      // automatically. Existing credentials remain untouched for recovery.
      this.loadError = error;
      this.data = emptyCredentials();
    }
    if (writeOnInitialize && !this.data) await this.write();
    return this;
  }

  snapshot() {
    const value = this.data || emptyCredentials();
    return {
      configured: Boolean(value.secretId && value.secretKey),
      provider: "tencent-cloud-dnspod",
      region: value.region,
      secretId: value.secretId ? maskSecretId(value.secretId) : null,
      zoneDomain: value.zoneDomain,
      targetType: value.targetType,
      target: value.target,
      certificateEmail: value.certificateEmail,
      updatedAt: value.updatedAt,
      loadError: this.loadError ? "credential file invalid; unchanged" : null,
    };
  }

  credentials() {
    const value = this.data || emptyCredentials();
    if (!value.secretId || !value.secretKey) throw tencentError(409, "请先保存腾讯云 DNSPod 密钥");
    return { ...value };
  }

  async save({ secretId, secretKey, region, zoneDomain, targetType, target, certificateEmail } = {}) {
    const previous = this.data || emptyCredentials();
    const next = normalizeCredentials({
      secretId: secretId || previous.secretId,
      secretKey: secretKey || previous.secretKey,
      region: region || previous.region,
      zoneDomain: zoneDomain || previous.zoneDomain,
      targetType: targetType || previous.targetType,
      target: target || previous.target,
      certificateEmail: certificateEmail || previous.certificateEmail,
    });
    this.data = { ...next, updatedAt: this.now() };
    await this.write();
    return this.snapshot();
  }

  async clear({ actor = null } = {}) {
    this.data = { ...emptyCredentials(), clearedBy: normalizeActor(actor), clearedAt: this.now() };
    await this.write();
    return this.snapshot();
  }

  async write() {
    if (!this.data) this.data = emptyCredentials();
    const temporary = `${this.filePath}.${process.pid}.${this.randomBytes(5).toString("hex")}.tmp`;
    const task = this.writeQueue.then(async () => {
      await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    this.writeQueue = task.catch(() => {});
    try {
      await task;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw new Error(`无法保存腾讯云 DNS 凭据: ${error.message}`);
    }
  }
}

export class TencentCloudDnsClient {
  constructor({ secretId, secretKey, region = "ap-guangzhou", endpoint = TENCENT_DNS_ENDPOINT, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.secretId = normalizeSecret(secretId, "SecretId");
    this.secretKey = normalizeSecret(secretKey, "SecretKey");
    this.region = normalizeRegion(region);
    this.endpoint = new URL(endpoint).toString();
    this.fetchImpl = fetchImpl;
    this.now = now;
    if (typeof this.fetchImpl !== "function") throw tencentError(500, "当前 Node 环境没有可用的 fetch");
  }

  async request(action, payload = {}) {
    const body = JSON.stringify(payload);
    const url = new URL(this.endpoint);
    const host = url.host;
    const timestamp = Math.floor(this.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
    const signedHeaders = "content-type;host";
    const canonicalRequest = [
      "POST",
      url.pathname || "/",
      "",
      canonicalHeaders,
      signedHeaders,
      sha256(body),
    ].join("\n");
    const credentialScope = `${date}/${TENCENT_DNS_SERVICE}/tc3_request`;
    const stringToSign = [
      "TC3-HMAC-SHA256",
      String(timestamp),
      credentialScope,
      sha256(canonicalRequest),
    ].join("\n");
    const secretDate = hmac(`TC3${this.secretKey}`, date);
    const secretService = hmac(secretDate, TENCENT_DNS_SERVICE);
    const secretSigning = hmac(secretService, "tc3_request");
    const signature = hmac(secretSigning, stringToSign).toString("hex");
    const authorization = `TC3-HMAC-SHA256 Credential=${this.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Host: host,
        "X-TC-Action": action,
        "X-TC-Version": TENCENT_DNS_API_VERSION,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Region": this.region,
        Authorization: authorization,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => null);
    const error = result?.Response?.Error;
    if (!response.ok || error) {
      const message = error?.Message || `Tencent Cloud DNSPod HTTP ${response.status}`;
      const failure = tencentError(response.ok ? 502 : response.status, message);
      failure.code = error?.Code || null;
      throw failure;
    }
    return result?.Response || {};
  }

  async listRecords({ zoneDomain, subDomain = null, recordType = null } = {}) {
    const params = { Domain: normalizeZoneDomain(zoneDomain), Limit: 3000, Offset: 0 };
    if (subDomain) params.Subdomain = normalizeSubDomain(subDomain);
    if (recordType) params.RecordType = normalizeRecordType(recordType);
    try {
      const result = await this.request("DescribeRecordList", params);
      return Array.isArray(result.RecordList) ? result.RecordList : [];
    } catch (error) {
      // DNSPod uses ResourceNotFound.NoDataOfRecord for a valid query with no
      // matching records. Treat it as an empty list so a subsequent CreateRecord
      // can add the desired entry; all other failures remain fail-closed.
      if (error?.code === "ResourceNotFound.NoDataOfRecord") return [];
      throw error;
    }
  }

  async upsertRecord({ zoneDomain, subDomain, recordType, value, ttl = 600, replaceExisting = false } = {}) {
    const domain = normalizeZoneDomain(zoneDomain);
    const normalizedSubDomain = normalizeSubDomain(subDomain);
    const normalizedType = normalizeRecordType(recordType);
    const normalizedValue = normalizeRecordValue(normalizedType, value);
    // DNSPod does not reliably support wildcard values in the Subdomain filter
    // and reports "no data" even when a wildcard record exists. Fetch the
    // bounded zone list for wildcard entries and match the returned Name field
    // locally; exact entries can continue using the narrower server filter.
    const records = await this.listRecords({
      zoneDomain: domain,
      subDomain: normalizedSubDomain.includes("*") ? null : normalizedSubDomain,
      recordType: normalizedType,
    });
    const matching = records.filter((record) => {
      const name = String(record?.Name ?? record?.SubDomain ?? "").trim().toLowerCase().replace(/\.$/, "");
      const line = normalizeRecordLine(record?.RecordLine ?? record?.Line);
      return line === "默认" && (!normalizedSubDomain.includes("*") || name === normalizedSubDomain);
    });
    if (matching.length > 1) throw tencentError(409, `DNSPod 中 ${normalizedSubDomain} 存在多个默认线路记录`);
    const existing = matching[0] || null;
    if (existing && normalizeRecordValue(normalizedType, existing.Value) === normalizedValue) {
      return { action: "unchanged", record: existing, previous: existing, createdRecordId: null };
    }
    if (existing && !replaceExisting) {
      throw tencentError(409, `${normalizedSubDomain} 已存在不同的 ${normalizedType} 记录；请先确认替换`);
    }
    if (existing) {
      const result = await this.request("ModifyRecord", {
        Domain: domain,
        SubDomain: normalizedSubDomain,
        RecordType: normalizedType,
        RecordLine: "默认",
        RecordId: Number(existing.RecordId),
        Value: normalizedValue,
        TTL: ttl,
      });
      return { action: "updated", recordId: result.RecordId || existing.RecordId, previous: existing, createdRecordId: null };
    }
    const result = await this.request("CreateRecord", {
      Domain: domain,
      SubDomain: normalizedSubDomain,
      RecordType: normalizedType,
      RecordLine: "默认",
      Value: normalizedValue,
      TTL: ttl,
    });
    return { action: "created", recordId: result.RecordId || null, previous: null, createdRecordId: result.RecordId || null };
  }

  async createTxt({ zoneDomain, subDomain, value, ttl = 600 } = {}) {
    return this.upsertRecord({
      zoneDomain,
      subDomain,
      recordType: "TXT",
      value,
      ttl,
      replaceExisting: false,
    });
  }

  async createTxtChallenge({ zoneDomain, subDomain, value, ttl = 600 } = {}) {
    const domain = normalizeZoneDomain(zoneDomain);
    const normalizedSubDomain = normalizeSubDomain(subDomain);
    const normalizedValue = normalizeRecordValue("TXT", value);
    const result = await this.request("CreateRecord", {
      Domain: domain,
      SubDomain: normalizedSubDomain,
      RecordType: "TXT",
      RecordLine: "默认",
      Value: normalizedValue,
      TTL: ttl,
    });
    const recordId = Number(result.RecordId);
    if (!Number.isSafeInteger(recordId) || recordId <= 0) throw tencentError(502, "DNSPod 未返回 TXT RecordId");
    return { action: "created", recordId };
  }

  async deleteTxt({ zoneDomain, subDomain, value } = {}) {
    const domain = normalizeZoneDomain(zoneDomain);
    const normalizedSubDomain = normalizeSubDomain(subDomain);
    const records = await this.listRecords({ zoneDomain: domain, subDomain: normalizedSubDomain, recordType: "TXT" });
    const target = records.find((record) => normalizeRecordValue("TXT", record.Value) === normalizeRecordValue("TXT", value));
    if (!target) return { action: "unchanged" };
    await this.request("DeleteRecord", { Domain: domain, RecordId: Number(target.RecordId) });
    return { action: "deleted", recordId: target.RecordId };
  }

  async deleteRecord({ zoneDomain, recordId } = {}) {
    const domain = normalizeZoneDomain(zoneDomain);
    const id = Number(recordId);
    if (!Number.isSafeInteger(id) || id <= 0) throw tencentError(400, "DNSPod RecordId 不正确");
    await this.request("DeleteRecord", { Domain: domain, RecordId: id });
    return { action: "deleted", recordId: id };
  }

  async restoreRecord({ zoneDomain, subDomain, recordType, previous, createdRecordId = null, ttl = 600 } = {}) {
    if (!previous) return this.deleteRecord({ zoneDomain, recordId: createdRecordId });
    return this.upsertRecord({
      zoneDomain,
      subDomain,
      recordType,
      value: previous.Value,
      ttl: previous.TTL || ttl,
      replaceExisting: true,
    });
  }
}

export class TencentCloudSetupStore {
  constructor(stateDirectory, { now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    this.stateDirectory = path.resolve(stateDirectory);
    this.filePath = path.join(this.stateDirectory, "tencent-cloud-setup.json");
    this.now = now;
    this.randomBytes = randomBytes;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = false } = {}) {
    try {
      this.data = normalizeSetup(await readJson(this.filePath));
    } catch {
      this.data = emptySetup();
    }
    if (writeOnInitialize && !this.data) await this.write();
    return this;
  }

  snapshot() {
    return cloneJson(this.data || emptySetup());
  }

  async begin({ id, actor, input } = {}) {
    const setupId = /^tencent-[a-z0-9-]{12,80}$/.test(String(id || ""))
      ? String(id)
      : `tencent-${Date.now()}-${this.randomBytes(4).toString("hex")}`;
    this.data = {
      ...emptySetup(),
      id: setupId,
      status: "running",
      phase: "queued",
      actor: normalizeActor(actor),
      input: sanitizeSetupInput(input),
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    await this.write();
    return this.snapshot();
  }

  async update(patch = {}) {
    this.data = normalizeSetup({ ...(this.data || emptySetup()), ...patch, updatedAt: this.now() });
    await this.write();
    return this.snapshot();
  }

  async write() {
    if (!this.data) this.data = emptySetup();
    const temporary = `${this.filePath}.${process.pid}.${this.randomBytes(5).toString("hex")}.tmp`;
    const task = this.writeQueue.then(async () => {
      await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    this.writeQueue = task.catch(() => {});
    try {
      await task;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export function buildPreviewDnsPlan({ publicOrigin, previewBaseDomain, previewOrigins = [], slotCount = 4, isolation = "pool", zoneDomain, targetType = "A", target, managePublicOrigin = false } = {}) {
  const normalizedZone = normalizeZoneDomain(zoneDomain);
  const normalizedType = normalizeRecordType(targetType);
  const normalizedTarget = normalizeRecordValue(normalizedType, target);
  const hosts = [];
  if (managePublicOrigin && publicOrigin) hosts.push(new URL(publicOrigin).hostname);
  if (isolation === "session") {
    if (!previewBaseDomain) throw tencentError(400, "每会话模式需要预览基础域名");
    const base = normalizeHostname(previewBaseDomain);
    if (base === normalizedZone) {
      throw tencentError(409, "每会话自动配置必须使用独立预览子域名，例如 preview.example.com；不会接管根域名的全部通配符子域");
    }
    hosts.push(`*.${base}`);
  } else if (Array.isArray(previewOrigins) && previewOrigins.length) {
    hosts.push(...previewOrigins.map((origin) => new URL(origin).hostname));
  } else if (previewBaseDomain) {
    const base = normalizeHostname(previewBaseDomain);
    for (let index = 1; index <= normalizeSlotCount(slotCount); index += 1) hosts.push(`preview-${index}.${base}`);
  }
  if (!hosts.length) throw tencentError(400, "没有可以配置的预览域名");
  return hosts.map((host) => ({
    host,
    subDomain: relativeSubDomain(host, normalizedZone),
    recordType: normalizedType,
    value: normalizedTarget,
    ttl: 600,
  }));
}

export function normalizeRegion(value) {
  const region = String(value || "ap-guangzhou").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(region) || !TENCENT_DNS_REGIONS.has(region)) {
    throw tencentError(400, "腾讯云地域不受支持");
  }
  return region;
}

export function normalizeZoneDomain(value) {
  return normalizeHostname(value, "DNSPod 根域名");
}

export function normalizeHostname(value, label = "域名") {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || !HOSTNAME.test(hostname) || hostname.includes("*")) throw tencentError(400, `${label}格式不正确`);
  return hostname;
}

export function normalizeSubDomain(value) {
  const subDomain = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!subDomain || subDomain.length > 253 || !/^(?:[a-z0-9_*](?:[a-z0-9_*-]{0,61}[a-z0-9_*])?\.)*[a-z0-9_*](?:[a-z0-9_*-]{0,61}[a-z0-9_*])?$/.test(subDomain)) {
    throw tencentError(400, "DNSPod 子域名格式不正确");
  }
  return subDomain;
}

export function normalizeRecordType(value) {
  const type = String(value || "A").trim().toUpperCase();
  if (!(type === "A" || type === "AAAA" || type === "CNAME" || type === "TXT")) throw tencentError(400, "DNS 记录类型不受支持");
  return type;
}

export function normalizeRecordValue(type, value) {
  const normalizedType = normalizeRecordType(type);
  const normalized = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 512) throw tencentError(400, "DNS 记录值不正确");
  if (normalizedType === "A" && (!IPV4.test(normalized) || normalized.split(".").some((part) => Number(part) > 255))) throw tencentError(400, "A 记录必须是 IPv4 地址");
  if (normalizedType === "AAAA" && (!IPV6.test(normalized) || !normalized.includes(":"))) throw tencentError(400, "AAAA 记录必须是 IPv6 地址");
  if ((normalizedType === "A" || normalizedType === "AAAA") && isBlockedAddress(normalized, { allowLoopback: false })) {
    throw tencentError(400, "公网 DNS 记录不能指向回环、私网、链路本地或组播地址");
  }
  if ((normalizedType === "CNAME") && (!HOSTNAME.test(normalized) || normalized.includes("*"))) throw tencentError(400, "CNAME 记录必须是主机名");
  return normalizedType === "TXT" ? String(value).trim() : normalized;
}

export function relativeSubDomain(host, zoneDomain) {
  const normalizedHost = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  const normalizedZone = normalizeZoneDomain(zoneDomain);
  const bare = normalizedHost.startsWith("*.") ? normalizedHost.slice(2) : normalizedHost;
  if (bare === normalizedZone) return "@";
  const suffix = `.${normalizedZone}`;
  if (!bare.endsWith(suffix)) throw tencentError(400, `${host} 不属于 DNSPod 根域名 ${normalizedZone}`);
  return `${normalizedHost.startsWith("*.") ? "*." : ""}${bare.slice(0, -suffix.length)}`;
}

export function tencentError(statusCode, message) {
  const error = new Error(String(message || "腾讯云 DNS 操作失败"));
  error.statusCode = statusCode;
  error.code = "TENCENT_DNS_ERROR";
  return error;
}

function normalizeCredentials(value) {
  return {
    version: TENCENT_DNS_CONFIG_VERSION,
    provider: "tencent-cloud-dnspod",
    secretId: normalizeSecret(value.secretId, "SecretId"),
    secretKey: normalizeSecret(value.secretKey, "SecretKey"),
    region: normalizeRegion(value.region),
    zoneDomain: normalizeZoneDomain(value.zoneDomain),
    targetType: normalizeRecordType(value.targetType),
    target: normalizeRecordValue(value.targetType, value.target),
    certificateEmail: normalizeEmail(value.certificateEmail),
    updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : null,
  };
}

function normalizeStoredCredentials(value) {
  return normalizeCredentials(value);
}

function emptyCredentials() {
  return {
    version: TENCENT_DNS_CONFIG_VERSION,
    provider: "tencent-cloud-dnspod",
    secretId: null,
    secretKey: null,
    region: "ap-guangzhou",
    zoneDomain: null,
    targetType: "A",
    target: null,
    certificateEmail: null,
    updatedAt: null,
  };
}

function normalizeSecret(value, label) {
  const secret = String(value || "").trim();
  if (!secret || secret.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(secret)) throw tencentError(400, `${label} 格式不正确`);
  return secret;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw tencentError(400, "证书邮箱格式不正确");
  return email;
}

function normalizeSlotCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw tencentError(400, "预览槽位必须是 1-16 的整数");
  return count;
}

function normalizeRecordLine(value) {
  return String(value || "").trim() || "默认";
}

function maskSecretId(value) {
  return value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 6)}***${value.slice(-4)}`;
}

function normalizeActor(value) {
  const actor = String(value || "").trim();
  return actor ? actor.slice(0, 128) : null;
}

function emptySetup() {
  return {
    id: null,
    status: "idle",
    phase: "idle",
    actor: null,
    input: null,
    detail: null,
    records: [],
    certificate: null,
    error: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

function normalizeSetup(value) {
  const status = ["idle", "running", "completed", "failed"].includes(value?.status) ? value.status : "idle";
  const phase = TENCENT_SETUP_PHASES.has(value?.phase) ? value.phase : "idle";
  return {
    ...emptySetup(),
    ...value,
    status,
    phase,
    id: value?.id && /^tencent-[a-z0-9-]{12,80}$/.test(value.id) ? value.id : null,
    actor: normalizeActor(value?.actor),
    input: value?.input ? sanitizeSetupInput(value.input) : null,
    detail: typeof value?.detail === "string" ? value.detail.slice(0, 512) : null,
    records: Array.isArray(value?.records) ? value.records.slice(0, 32).map((record) => ({
      host: typeof record?.host === "string" ? record.host.slice(0, 253) : null,
      action: typeof record?.action === "string" ? record.action.slice(0, 32) : null,
    })) : [],
    certificate: value?.certificate && typeof value.certificate === "object" ? {
      requested: Boolean(value.certificate.requested),
      certName: typeof value.certificate.certName === "string" ? value.certificate.certName.slice(0, 128) : null,
      path: typeof value.certificate.path === "string" ? value.certificate.path.slice(0, 512) : null,
    } : null,
    error: typeof value?.error === "string" ? value.error.slice(0, 512) : null,
    startedAt: Number.isSafeInteger(value?.startedAt) ? value.startedAt : null,
    updatedAt: Number.isSafeInteger(value?.updatedAt) ? value.updatedAt : null,
    completedAt: Number.isSafeInteger(value?.completedAt) ? value.completedAt : null,
  };
}

function sanitizeSetupInput(value) {
  if (!value || typeof value !== "object") return null;
  return {
    issueCertificate: value.issueCertificate === true,
    replaceExisting: value.replaceExisting === true,
    managePublicOrigin: value.managePublicOrigin === true,
    isolation: value.isolation === "session" ? "session" : "pool",
    zoneDomain: value.zoneDomain ? normalizeZoneDomain(value.zoneDomain) : null,
    targetType: value.targetType ? normalizeRecordType(value.targetType) : null,
    target: value.target ? normalizeRecordValue(value.targetType || "A", value.target) : null,
    certificateEmail: value.certificateEmail ? normalizeEmail(value.certificateEmail) : null,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function relativeSubDomainForRecord(host, zoneDomain) {
  return relativeSubDomain(host, zoneDomain);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
