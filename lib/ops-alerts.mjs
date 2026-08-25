import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_WEBHOOK_RESPONSE_BYTES = 32 * 1024;
const WEBHOOK_TIMEOUT_MS = 5_000;

export const OPS_ALERT_RULES = Object.freeze({
  disk_usage: {
    label: "磁盘空间不足",
    severity: "critical",
    source: "resource",
    threshold: true,
    defaults: { enabled: true, thresholdPercent: 90, consecutive: 3, cooldownMinutes: 60 },
  },
  memory_usage: {
    label: "内存持续过高",
    severity: "warning",
    source: "resource",
    threshold: true,
    defaults: { enabled: true, thresholdPercent: 90, consecutive: 6, cooldownMinutes: 60 },
  },
  codex_offline: {
    label: "Codex Runtime 离线",
    severity: "critical",
    source: "codex",
    threshold: false,
    defaults: { enabled: true, thresholdPercent: null, consecutive: 3, cooldownMinutes: 30 },
  },
  gateway_abnormal: {
    label: "入口网关异常",
    severity: "critical",
    source: "gateway",
    threshold: false,
    defaults: { enabled: true, thresholdPercent: null, consecutive: 3, cooldownMinutes: 30 },
  },
  release_failed: {
    label: "发布任务失败",
    severity: "critical",
    source: "deployment",
    threshold: false,
    defaults: { enabled: true, thresholdPercent: null, consecutive: 1, cooldownMinutes: 60 },
  },
});

export class OpsAlertStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    this.directory = path.resolve(directory);
    this.keyPath = path.join(this.directory, "ops-alerts.key");
    this.storePath = path.join(this.directory, "ops-alerts.enc.json");
    this.now = now;
    this.key = null;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    this.key = await loadOrCreateKey(this.keyPath);
    this.data = await this.readStore({ persistDefault: writeOnInitialize });
    return this;
  }

  activate() {
    return this.mutate(async () => {
      this.assertInitialized();
      this.data = await this.readStore({ persistDefault: true });
    });
  }

  settings() {
    this.assertInitialized();
    return structuredClone(this.data.settings);
  }

  webhookUrl() {
    this.assertInitialized();
    return this.data.settings.webhookUrl;
  }

  states() {
    this.assertInitialized();
    return structuredClone(this.data.states);
  }

  publicSettings() {
    this.assertInitialized();
    const webhookUrl = this.data.settings.webhookUrl;
    return {
      rules: Object.entries(OPS_ALERT_RULES).map(([id, definition]) => ({
        id,
        label: definition.label,
        severity: definition.severity,
        thresholdSupported: definition.threshold,
        ...this.data.settings.rules[id],
      })),
      webhook: {
        configured: Boolean(webhookUrl),
        host: webhookUrl ? new URL(webhookUrl).host : null,
      },
    };
  }

  updateSettings(input) {
    return this.mutate(async () => {
      this.assertInitialized();
      const current = this.data.settings;
      const rules = { ...current.rules };
      if (input?.rules && typeof input.rules === "object" && !Array.isArray(input.rules)) {
        for (const [id, value] of Object.entries(input.rules)) {
          if (!OPS_ALERT_RULES[id]) throw storeError(400, "包含未知的告警规则");
          rules[id] = normalizeRule(id, value, rules[id]);
        }
      }
      let webhookUrl = current.webhookUrl;
      if (Object.hasOwn(input || {}, "webhookUrl")) {
        webhookUrl = String(input.webhookUrl || "").trim();
        if (webhookUrl) webhookUrl = validateWebhookUrl(webhookUrl);
        else webhookUrl = null;
      }
      this.data.settings = { rules, webhookUrl, updatedAt: this.now() };
      await this.writeStore();
      return this.publicSettings();
    });
  }

  updateRuleState(id, value) {
    return this.mutate(async () => {
      this.assertInitialized();
      if (!OPS_ALERT_RULES[id]) throw new TypeError("Unknown operations alert rule");
      this.data.states[id] = normalizeState(value);
      await this.writeStore();
      return structuredClone(this.data.states[id]);
    });
  }

  async readStore({ persistDefault = true } = {}) {
    try {
      const envelope = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      const data = decryptEnvelope(envelope, this.key);
      return normalizeStore(data);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取告警配置: ${error.message}`);
      const data = defaultStore(this.now());
      if (persistDefault) {
        this.data = data;
        await this.writeStore();
      }
      return data;
    }
  }

  async writeStore() {
    const envelope = encryptEnvelope(this.data, this.key);
    const temporary = `${this.storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.storePath);
    await fs.chmod(this.storePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.data || !this.key) throw new Error("Operations alert store is not initialized");
  }
}

export class OpsAlertManager {
  constructor({ store, eventStore, notifier = new WebhookNotifier(), now = () => Date.now() } = {}) {
    if (!store || !eventStore) throw new TypeError("store and eventStore are required");
    this.store = store;
    this.eventStore = eventStore;
    this.notifier = notifier;
    this.now = now;
    this.runtime = Object.fromEntries(Object.keys(OPS_ALERT_RULES).map((id) => [id, { consecutive: 0, value: null }]));
    this.lastSignal = null;
  }

  snapshot() {
    const persistedStates = this.store.states();
    const settings = this.store.publicSettings();
    const rules = settings.rules.map((rule) => ({
      ...rule,
      active: Boolean(persistedStates[rule.id]?.active),
      openedAt: persistedStates[rule.id]?.openedAt || null,
      recoveredAt: persistedStates[rule.id]?.recoveredAt || null,
      lastNotificationAt: persistedStates[rule.id]?.lastNotificationAt || null,
      currentValue: this.runtime[rule.id]?.value ?? persistedStates[rule.id]?.lastValue ?? null,
      consecutiveCount: this.runtime[rule.id]?.consecutive || 0,
    }));
    return {
      active: rules.filter((rule) => rule.active).length,
      rules,
      webhook: settings.webhook,
    };
  }

  async configure(input) {
    await this.store.updateSettings(input);
    if (this.lastSignal) await this.evaluate(this.lastSignal);
    return this.snapshot();
  }

  async evaluate(signal) {
    this.lastSignal = normalizeSignal(signal);
    const settings = this.store.settings();
    for (const [id, definition] of Object.entries(OPS_ALERT_RULES)) {
      const rule = settings.rules[id];
      const result = evaluateRule(id, rule, this.lastSignal);
      const runtime = this.runtime[id];
      runtime.value = result.value;
      const state = this.store.states()[id] || defaultState();
      if (!rule.enabled) {
        runtime.consecutive = 0;
        if (state.active) await this.recover(id, definition, state, "规则已停用");
        continue;
      }
      if (result.violated) {
        runtime.consecutive = Math.min(rule.consecutive, runtime.consecutive + 1);
        if (!state.active && runtime.consecutive >= rule.consecutive) {
          await this.open(id, definition, state, result);
        } else if (state.active && this.now() - (state.lastNotificationAt || 0) >= rule.cooldownMinutes * 60_000) {
          await this.notify(id, definition, { ...state, lastValue: result.value }, "active");
        }
      } else {
        runtime.consecutive = 0;
        if (state.active) await this.recover(id, definition, state, result.detail);
      }
    }
    return this.snapshot();
  }

  async testWebhook() {
    const url = this.store.webhookUrl();
    if (!url) throw storeError(409, "尚未配置 Webhook");
    const host = new URL(url).host;
    try {
      await this.notifier.send(url, webhookPayload({
        ruleId: "webhook_test",
        label: "Webhook 测试",
        severity: "info",
        status: "test",
        at: this.now(),
        value: null,
      }));
      await this.eventStore.record({ type: "webhook.test", severity: "info", source: "alert", title: "Webhook 测试成功", detail: host });
      return { ok: true, host };
    } catch {
      await this.eventStore.record({ type: "webhook.failed", severity: "warning", source: "alert", title: "Webhook 测试失败", detail: host });
      throw storeError(502, "Webhook 请求失败，请检查地址和接收端状态");
    }
  }

  async open(id, definition, previous, result) {
    const now = this.now();
    const state = {
      ...previous,
      active: true,
      openedAt: now,
      recoveredAt: null,
      lastValue: result.value,
      lastNotificationAt: null,
    };
    await this.store.updateRuleState(id, state);
    await this.eventStore.record({
      type: "alert.triggered",
      severity: definition.severity,
      source: definition.source,
      title: definition.label,
      detail: result.detail,
    });
    await this.notify(id, definition, state, "triggered");
  }

  async recover(id, definition, previous, detail) {
    const state = {
      ...previous,
      active: false,
      recoveredAt: this.now(),
      lastNotificationAt: previous.lastNotificationAt || null,
    };
    await this.store.updateRuleState(id, state);
    await this.eventStore.record({
      type: "alert.recovered",
      severity: "info",
      source: definition.source,
      title: `${definition.label}已恢复`,
      detail: cleanDetail(detail),
    });
    await this.notify(id, definition, state, "recovered");
  }

  async notify(id, definition, state, status) {
    const url = this.store.webhookUrl();
    const attemptedAt = this.now();
    await this.store.updateRuleState(id, { ...state, lastNotificationAt: attemptedAt });
    if (!url) return;
    const host = new URL(url).host;
    try {
      await this.notifier.send(url, webhookPayload({
        ruleId: id,
        label: definition.label,
        severity: definition.severity,
        status,
        at: attemptedAt,
        value: state.lastValue,
      }));
    } catch {
      await this.eventStore.record({
        type: "webhook.failed",
        severity: "warning",
        source: "alert",
        title: "Webhook 通知失败",
        detail: host,
      });
    }
  }
}

export class WebhookNotifier {
  constructor({ lookup = dns.lookup, request = https.request, timeoutMs = WEBHOOK_TIMEOUT_MS } = {}) {
    this.lookup = lookup;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  async send(value, payload) {
    const url = new URL(validateWebhookUrl(value));
    const target = await resolvePublicWebhookTarget(url, this.lookup);
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > 16 * 1024) throw new Error("Webhook payload is too large");
    await new Promise((resolve, reject) => {
      const request = this.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "User-Agent": "WFL-Codex-Desktop-Ops/1",
        },
        timeout: this.timeoutMs,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      }, (response) => {
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.length;
          if (received > MAX_WEBHOOK_RESPONSE_BYTES) request.destroy(new Error("Webhook response is too large"));
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve();
          else reject(new Error("Webhook returned a non-success status"));
        });
      });
      request.on("timeout", () => request.destroy(new Error("Webhook timed out")));
      request.on("error", reject);
      request.end(body);
    });
  }
}

export async function resolvePublicWebhookTarget(value, lookup = dns.lookup) {
  const url = value instanceof URL ? value : new URL(validateWebhookUrl(value));
  const hostname = normalizedHostname(url.hostname);
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(results) || !results.length) throw new Error("Webhook host did not resolve");
  if (results.some((entry) => !isPublicAddress(entry.address, entry.family))) {
    throw new Error("Webhook host resolves to a private or reserved address");
  }
  return { address: results[0].address, family: results[0].family };
}

export function validateWebhookUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw storeError(400, "Webhook URL 格式不正确");
  }
  if (url.protocol !== "https:") throw storeError(400, "Webhook 仅支持 HTTPS");
  if (url.username || url.password || url.hash) throw storeError(400, "Webhook URL 不能包含账号、密码或片段");
  if (!url.hostname || url.hostname.length > 253 || url.toString().length > 2_048) throw storeError(400, "Webhook URL 格式不正确");
  const hostname = normalizedHostname(url.hostname);
  if (net.isIP(hostname) && !isPublicAddress(hostname, net.isIP(hostname))) {
    throw storeError(400, "Webhook 不能指向本机、内网或保留地址");
  }
  return url.toString();
}

export function isPublicAddress(address, family = net.isIP(address)) {
  if (![4, 6].includes(Number(family)) || !net.isIP(address)) return false;
  if (Number(family) === 6 && isIpv4MappedAddress(address)) return false;
  return !blockedAddresses.check(address, Number(family) === 4 ? "ipv4" : "ipv6");
}

const blockedAddresses = new net.BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
]) blockedAddresses.addSubnet(address, prefix, family);

function evaluateRule(id, rule, signal) {
  if (id === "disk_usage") {
    return { violated: signal.diskPercent >= rule.thresholdPercent, value: signal.diskPercent, detail: `磁盘使用率 ${signal.diskPercent.toFixed(1)}%` };
  }
  if (id === "memory_usage") {
    return { violated: signal.memoryPercent >= rule.thresholdPercent, value: signal.memoryPercent, detail: `内存使用率 ${signal.memoryPercent.toFixed(1)}%` };
  }
  if (id === "codex_offline") {
    const violated = signal.codexTotal > 0 && signal.codexReady === 0;
    return { violated, value: signal.codexReady, detail: violated ? `${signal.codexTotal} 个运行环境全部离线` : `${signal.codexReady} / ${signal.codexTotal} 个运行环境就绪` };
  }
  if (id === "gateway_abnormal") {
    const violated = !["healthy", "direct"].includes(signal.gatewayStatus);
    return { violated, value: signal.gatewayStatus, detail: `网关状态：${signal.gatewayStatus}` };
  }
  return { violated: signal.releaseFailed, value: signal.releaseFailed ? 1 : 0, detail: signal.releaseFailed ? "检测到失败的发布或更新任务" : "发布任务正常" };
}

function normalizeSignal(value) {
  return {
    diskPercent: clampPercent(value?.diskPercent),
    memoryPercent: clampPercent(value?.memoryPercent),
    codexReady: Math.max(0, Math.round(Number(value?.codexReady) || 0)),
    codexTotal: Math.max(0, Math.round(Number(value?.codexTotal) || 0)),
    gatewayStatus: ["healthy", "degraded", "offline", "direct"].includes(value?.gatewayStatus) ? value.gatewayStatus : "offline",
    releaseFailed: Boolean(value?.releaseFailed),
  };
}

function normalizeStore(value) {
  if (value?.version !== STORE_VERSION) throw new Error("Unsupported alert store version");
  const defaults = defaultStore(Date.now());
  const rules = {};
  for (const id of Object.keys(OPS_ALERT_RULES)) rules[id] = normalizeRule(id, value.settings?.rules?.[id], defaults.settings.rules[id]);
  const webhookUrl = value.settings?.webhookUrl ? validateWebhookUrl(value.settings.webhookUrl) : null;
  const states = {};
  for (const id of Object.keys(OPS_ALERT_RULES)) states[id] = normalizeState(value.states?.[id]);
  return { version: STORE_VERSION, settings: { rules, webhookUrl, updatedAt: Number(value.settings?.updatedAt) || Date.now() }, states };
}

function defaultStore(now) {
  return {
    version: STORE_VERSION,
    settings: {
      rules: Object.fromEntries(Object.entries(OPS_ALERT_RULES).map(([id, definition]) => [id, { ...definition.defaults }])),
      webhookUrl: null,
      updatedAt: now,
    },
    states: Object.fromEntries(Object.keys(OPS_ALERT_RULES).map((id) => [id, defaultState()])),
  };
}

function normalizeRule(id, value, fallback = OPS_ALERT_RULES[id].defaults) {
  const definition = OPS_ALERT_RULES[id];
  const thresholdPercent = definition.threshold
    ? Math.max(50, Math.min(99, Number(value?.thresholdPercent ?? fallback.thresholdPercent) || fallback.thresholdPercent))
    : null;
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : fallback.enabled,
    thresholdPercent,
    consecutive: Math.max(1, Math.min(60, Math.round(Number(value?.consecutive ?? fallback.consecutive) || fallback.consecutive))),
    cooldownMinutes: Math.max(5, Math.min(1_440, Math.round(Number(value?.cooldownMinutes ?? fallback.cooldownMinutes) || fallback.cooldownMinutes))),
  };
}

function defaultState() {
  return { active: false, openedAt: null, recoveredAt: null, lastNotificationAt: null, lastValue: null };
}

function normalizeState(value) {
  return {
    active: Boolean(value?.active),
    openedAt: finiteOrNull(value?.openedAt),
    recoveredAt: finiteOrNull(value?.recoveredAt),
    lastNotificationAt: finiteOrNull(value?.lastNotificationAt),
    lastValue: typeof value?.lastValue === "string" || Number.isFinite(value?.lastValue) ? value.lastValue : null,
  };
}

function webhookPayload({ ruleId, label, severity, status, at, value }) {
  return { version: 1, source: "wfl-codex-desktop", event: "ops.alert", ruleId, label, severity, status, at, value };
}

function encryptEnvelope(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: STORE_VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function decryptEnvelope(envelope, key) {
  if (envelope?.version !== STORE_VERSION) throw new Error("Unsupported alert store version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function loadOrCreateKey(keyPath) {
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid operations alert key");
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

function clampPercent(value) {
  return Math.round(Math.max(0, Math.min(100, Number(value) || 0)) * 10) / 10;
}

function normalizedHostname(value) {
  return String(value || "").replace(/^\[|\]$/g, "");
}

function isIpv4MappedAddress(value) {
  try {
    return normalizedHostname(new URL(`https://[${value}]/`).hostname).startsWith("::ffff:");
  } catch {
    return false;
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function cleanDetail(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 240) || null;
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
