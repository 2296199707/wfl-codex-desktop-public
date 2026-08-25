import crypto from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 128;

/**
 * Query provider-owned balance and quota endpoints without exposing provider
 * credentials to the browser.  Providers do not share one billing protocol,
 * so this module first selects a narrow endpoint family and then normalizes
 * the response shape.
 */
export class ProviderUsageCache {
  constructor({
    fetchImpl = fetch,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.ttlMs = Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async snapshot(profiles, { force = false } = {}) {
    const entries = Array.isArray(profiles) ? profiles.filter(Boolean) : [];
    const providers = await Promise.all(entries.map((profile) => this.query(profile, { force })));
    return {
      providers,
      updatedAt: this.now(),
    };
  }

  async query(profile, { force = false } = {}) {
    const cacheKey = providerCacheKey(profile);
    const cached = this.cache.get(cacheKey) || null;
    const now = this.now();
    if (!force && cached && now - cached.fetchedAt < this.ttlMs) {
      return publicProviderUsage(cached.value);
    }
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey);

    const request = this.fetchLive(profile)
      .then((value) => {
        const entry = {
          ...value,
          fetchedAt: this.now(),
          updatedAt: this.now(),
          stale: false,
        };
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, { fetchedAt: entry.fetchedAt, value: entry });
        this.trimCache();
        return publicProviderUsage(entry);
      })
      .catch((error) => {
        const failedAt = this.now();
        if (cached?.value?.status === "ok") {
          return publicProviderUsage({
            ...cached.value,
            status: "stale",
            stale: true,
            fetchedAt: failedAt,
            message: usageErrorMessage(error, "最近一次额度查询失败，显示缓存结果"),
          });
        }
        const entry = failureProviderUsage(profile, error, failedAt);
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, { fetchedAt: failedAt, value: entry });
        this.trimCache();
        return publicProviderUsage(entry);
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, request);
    return request;
  }

  async fetchLive(profile) {
    if (!profile?.id || !profile.apiKey) {
      return {
        providerId: profile?.id || null,
        providerName: profile?.name || "未命名供应商",
        status: "unavailable",
        adapter: "none",
        balance: null,
        windows: [],
        usage: null,
        planName: null,
        mode: null,
        isValid: false,
        stale: false,
        message: "API 密钥未配置",
      };
    }

    const endpoint = providerUsageEndpoint(profile);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${profile.apiKey}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
      const raw = await readBoundedBody(response, RESPONSE_LIMIT_BYTES);
      if (!response.ok) throw usageResponseError(response.status);
      const payload = parseJsonPayload(raw);
      return {
        providerId: profile.id,
        providerName: profile.name,
        ...normalizeProviderUsage(payload, endpoint.adapter),
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw usageError("额度查询超时，请稍后重试", "timeout");
      }
      if (error instanceof ProviderUsageError) throw error;
      throw usageError("供应商未提供可识别的额度接口", "unsupported");
    } finally {
      clearTimeout(timer);
    }
  }

  trimCache() {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }
}

export function providerUsageEndpoint(profile) {
  let base;
  try {
    base = new URL(String(profile?.baseUrl || "").trim());
  } catch {
    throw usageError("供应商地址无效", "invalid_provider");
  }
  const hostname = base.hostname.toLowerCase();
  if (isDeepSeekHost(hostname)) {
    return { adapter: "deepseek-balance", url: `${base.origin}/user/balance` };
  }
  if (hostname === "opencode.ai" && base.pathname.toLowerCase().includes("/zen/go")) {
    return { adapter: "opencode-usage", url: appendPath(base, "usage") };
  }
  if (isGatewayHost(hostname)) {
    if (!pathEndsInV1(base.pathname)) {
      base.pathname = `${base.pathname.replace(/\/+$/, "")}/v1`;
    }
    return { adapter: "gateway-usage", url: appendPath(base, "usage") };
  }
  return { adapter: "generic-usage", url: appendPath(base, "usage") };
}

export function normalizeProviderUsage(payload, adapter = "generic-usage") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw usageError("供应商额度接口返回格式不正确", "unsupported");
  }

  const windows = normalizeUsageWindows(payload);
  if (windows.length) {
    const limited = windows.some((window) => ["limited", "exhausted", "blocked"].includes(window.status));
    return {
      status: payload.isValid === false ? "invalid" : limited ? "limited" : "ok",
      adapter: adapter === "opencode-usage" ? adapter : "usage-windows",
      balance: null,
      windows,
      usage: null,
      planName: textValue(payload.planName || payload.plan?.name || payload.usage?.planName),
      mode: textValue(payload.mode),
      isValid: payload.isValid !== false,
      stale: false,
      message: payload.isValid === false ? "供应商凭据无效" : null,
    };
  }

  const deepSeekBalance = normalizeDeepSeekBalance(payload);
  if (deepSeekBalance) {
    return {
      status: payload.is_available === false ? "invalid" : "ok",
      adapter: "deepseek-balance",
      balance: deepSeekBalance,
      windows: [],
      usage: null,
      planName: null,
      mode: null,
      isValid: payload.is_available !== false,
      stale: false,
      message: payload.is_available === false ? "DeepSeek 余额不可用" : null,
    };
  }

  const gatewayBalance = normalizeGatewayBalance(payload);
  if (gatewayBalance) {
    return {
      status: payload.isValid === false ? "invalid" : "ok",
      adapter: adapter === "gateway-usage" ? adapter : "balance-usage",
      balance: gatewayBalance,
      windows: [],
      usage: normalizeUsageSummary(payload.usage),
      planName: textValue(payload.planName),
      mode: textValue(payload.mode),
      isValid: payload.isValid !== false,
      stale: false,
      message: payload.isValid === false ? "供应商凭据无效" : null,
    };
  }

  throw usageError("供应商未提供可识别的额度接口", "unsupported");
}

function normalizeUsageWindows(payload) {
  const nested = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data
    : null;
  const source = firstObjectValue([
    payload.usage,
    payload.rateLimits,
    payload.rate_limits,
    payload.limits,
    payload.quota,
    nested?.usage,
    nested?.rateLimits,
    nested?.rate_limits,
    nested?.limits,
    nested?.quota,
  ]);
  if (!source) return [];
  const windows = [];
  for (const [key, value] of Object.entries(source)) {
    const window = Array.isArray(value) ? value[0] : value;
    if (!window || typeof window !== "object" || Array.isArray(window)) continue;
    const percent = windowUsedPercent(window);
    if (percent == null) continue;
    windows.push({
      key: safeKey(key),
      label: usageWindowLabel(key, window.windowDurationMins ?? window.window_duration_mins ?? window.durationMins),
      usedPercent: percent,
      resetsAt: normalizeResetTime(window.resetsAt ?? window.resetAt ?? window.reset_at ?? window.resets_at),
      status: safeWindowStatus(window.status, percent),
    });
  }
  return windows.slice(0, 8);
}

function firstObjectValue(values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function windowUsedPercent(value) {
  const direct = value.percent
    ?? value.usedPercent
    ?? value.used_percent
    ?? value.usagePercent
    ?? value.usage_percent
    ?? value.utilization;
  let percent = finiteNumber(direct);
  if (percent != null && value.utilization === direct && percent >= 0 && percent <= 1) percent *= 100;
  if (percent == null) {
    const used = finiteNumber(value.used ?? value.consumed ?? value.usedAmount);
    const limit = finiteNumber(value.limit ?? value.max ?? value.total);
    const remaining = finiteNumber(value.remaining ?? value.left);
    if (used != null && limit > 0) percent = (used / limit) * 100;
    else if (remaining != null && limit > 0) percent = ((limit - remaining) / limit) * 100;
  }
  return finitePercent(percent);
}

function normalizeDeepSeekBalance(payload) {
  if (!Array.isArray(payload.balance_infos)) return null;
  const entry = payload.balance_infos.find((value) => value && typeof value === "object");
  if (!entry) return null;
  const amount = finiteNumber(entry.total_balance);
  if (amount == null) return null;
  return {
    amount,
    remaining: amount,
    currency: textValue(entry.currency) || "未知",
    granted: finiteNumber(entry.granted_balance),
    toppedUp: finiteNumber(entry.topped_up_balance),
  };
}

function normalizeGatewayBalance(payload) {
  const amount = finiteNumber(payload.balance);
  const remaining = finiteNumber(payload.remaining);
  if (amount == null && remaining == null) return null;
  return {
    amount: amount ?? remaining,
    remaining: remaining ?? amount,
    currency: textValue(payload.unit) || "未知",
    granted: null,
    toppedUp: null,
  };
}

function normalizeUsageSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const today = value.today && typeof value.today === "object" ? value.today : null;
  const total = value.total && typeof value.total === "object" ? value.total : null;
  if (!today && !total) return null;
  return {
    todayRequests: safeCount(today?.requests),
    todayCost: finiteNumber(today?.actual_cost ?? today?.cost),
    totalRequests: safeCount(total?.requests),
    totalCost: finiteNumber(total?.actual_cost ?? total?.cost),
  };
}

function failureProviderUsage(profile, error, timestamp) {
  const code = error instanceof ProviderUsageError ? error.code : "error";
  return {
    providerId: profile?.id || null,
    providerName: profile?.name || "未命名供应商",
    status: code === "unsupported" ? "unsupported" : "error",
    adapter: "none",
    balance: null,
    windows: [],
    usage: null,
    planName: null,
    mode: null,
    isValid: null,
    stale: false,
    message: usageErrorMessage(error, "额度查询失败"),
    fetchedAt: timestamp,
    updatedAt: timestamp,
  };
}

function publicProviderUsage(value) {
  return {
    providerId: value.providerId || null,
    providerName: value.providerName || "未命名供应商",
    status: value.status || "error",
    adapter: value.adapter || "none",
    balance: value.balance ? { ...value.balance } : null,
    windows: Array.isArray(value.windows) ? value.windows.map((window) => ({ ...window })) : [],
    usage: value.usage ? { ...value.usage } : null,
    planName: value.planName || null,
    mode: value.mode || null,
    isValid: value.isValid === true ? true : value.isValid === false ? false : null,
    stale: value.stale === true,
    message: value.message || null,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null,
  };
}

function providerCacheKey(profile) {
  const secretFingerprint = crypto.createHash("sha256")
    .update(String(profile?.apiKey || ""))
    .digest("hex")
    .slice(0, 16);
  return [profile?.id || "", profile?.baseUrl || "", secretFingerprint].join("|");
}

function appendPath(url, suffix) {
  const result = new URL(url.href);
  result.pathname = `${result.pathname.replace(/\/+$/, "")}/${suffix}`;
  return result.href;
}

function isDeepSeekHost(hostname) {
  return hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
}

function isGatewayHost(hostname) {
  return hostname === "wflapi.cloud"
    || hostname.endsWith(".wflapi.cloud")
    || hostname === "ai-pixel.online"
    || hostname.endsWith(".ai-pixel.online");
}

function pathEndsInV1(value) {
  return /(?:^|\/)v1$/u.test(String(value || "").replace(/\/+$/, ""));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePercent(value) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return Math.max(0, Math.min(100, number));
}

function safeCount(value) {
  const number = finiteNumber(value);
  return number == null || number < 0 ? null : Math.floor(number);
}

function textValue(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 120 ? text : null;
}

function safeKey(value) {
  const key = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(key) ? key : "window";
}

function safeWindowStatus(value, percent = null) {
  const status = String(value || "ok").trim().toLowerCase();
  if (percent != null && percent >= 100 && status === "ok") return "exhausted";
  return ["ok", "limited", "exhausted", "blocked"].includes(status) ? status : "ok";
}

function usageWindowLabel(key, durationMins) {
  const normalized = String(key || "").trim().toLowerCase().replaceAll("-", "_");
  if (["rolling", "five_hour", "five_hours", "5h", "5_hour"].includes(normalized)
    || Number(durationMins) === 5 * 60) return "5 小时";
  if (["weekly", "seven_day", "seven_days", "7d", "7_day"].includes(normalized)
    || Number(durationMins) === 7 * 24 * 60) return "7 天";
  if (["monthly", "month", "30d", "30_day"].includes(normalized)) return "本月";
  return textValue(key) || "额度";
}

function normalizeResetTime(value) {
  if (value == null || value === "") return null;
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp).toISOString();
}

async function readBoundedBody(response, limit) {
  const chunks = [];
  let total = 0;
  if (!response.body) return "";
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw usageError("供应商额度响应过大", "error");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseJsonPayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw usageError("供应商未提供可识别的额度接口", "unsupported");
  }
}

function usageResponseError(status) {
  if (status === 404) return usageError("供应商未提供可识别的额度接口", "unsupported");
  if (status === 401 || status === 403) return usageError("供应商拒绝额度查询，可能需要额外权限", "error");
  if (status === 429) return usageError("供应商额度查询受到限流", "error");
  if (status >= 500) return usageError("供应商额度服务暂时不可用", "error");
  return usageError("供应商额度查询失败", "error");
}

function usageError(message, code) {
  return new ProviderUsageError(message, code);
}

function usageErrorMessage(error, fallback) {
  return error instanceof ProviderUsageError ? error.message : fallback;
}

export class ProviderUsageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProviderUsageError";
    this.code = code;
  }
}
