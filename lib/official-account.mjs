import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOfficialProxy, normalizeOfficialProxyHealth, publicOfficialProxy } from "./official-proxy.mjs";

const LOGIN_TTL_MS = 15 * 60 * 1000;
const RESET_TTL_MS = 2 * 60 * 1000;
const MAX_TEXT_LENGTH = 256;
const MAX_PENDING_USERS = 1_000;
const MAX_CODEX_AUTH_BYTES = 1024 * 1024;

export class OfficialAccountActions {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.logins = new Map();
    this.resets = new Map();
  }

  rememberLogin(userId, result, {
    proxy = undefined,
    proxyHealth = null,
    restoreProxy = undefined,
    accountContext = undefined,
  } = {}) {
    this.prune();
    const type = ["chatgpt", "chatgptDeviceCode"].includes(result?.type) ? result.type : null;
    if (!type) throw actionError(502, "官方登录返回了无效响应");
    const loginId = boundedText(result.loginId, 512);
    const userCode = type === "chatgptDeviceCode" ? boundedText(result.userCode, 64) : null;
    const verificationUrl = type === "chatgptDeviceCode" ? officialVerificationUrl(result.verificationUrl) : null;
    if (!loginId || (type === "chatgptDeviceCode" && (!userCode || !verificationUrl))) {
      throw actionError(502, "官方登录返回了无效响应");
    }
    const record = {
      type,
      loginId,
      userCode,
      verificationUrl,
      expiresAt: this.now() + LOGIN_TTL_MS,
      ...(accountContext !== undefined ? {
        accountContext: normalizeAccountContext(accountContext),
      } : {}),
      ...(proxy !== undefined ? {
        proxySelection: {
          proxy: proxy == null ? null : normalizeOfficialProxy(proxy),
          health: normalizeOfficialProxyHealth(proxyHealth),
          restoreProxy: restoreProxy == null ? null : normalizeOfficialProxy(restoreProxy),
        },
      } : {}),
    };
    this.logins.set(String(userId), record);
    trimOldest(this.logins);
    return publicLogin(record);
  }

  pendingLogin(userId, accountContext = undefined) {
    this.prune();
    const record = this.logins.get(String(userId));
    if (!record || !accountContextMatches(record.accountContext, accountContext)) return null;
    return publicLogin(record);
  }

  hasPendingLogins() {
    this.prune();
    return this.logins.size > 0;
  }

  takeLogin(userId) {
    this.prune();
    const key = String(userId);
    const record = this.logins.get(key);
    if (!record) throw actionError(404, "没有等待中的官方登录");
    this.logins.delete(key);
    return privateLogin(record);
  }

  discardLogin(userId, loginId = null, accountContext = undefined) {
    this.prune();
    const key = String(userId);
    const record = this.logins.get(key);
    if (
      !record
      || (loginId && record.loginId !== String(loginId))
      || !accountContextMatches(record.accountContext, accountContext)
    ) return null;
    this.logins.delete(key);
    return privateLogin(record);
  }

  completeLogin(userId, notification, accountContext = undefined) {
    const key = String(userId);
    const record = this.logins.get(key);
    if (!record) return false;
    if (notification?.loginId && notification.loginId !== record.loginId) return false;
    if (!accountContextMatches(record.accountContext, accountContext)) return false;
    this.logins.delete(key);
    return privateLogin(record);
  }

  prepareReset(userId, rateLimits, { accountContext = undefined } = {}) {
    this.prune();
    const summary = sanitizeResetCredits(rateLimits?.rateLimitResetCredits);
    if (!summary || summary.availableCount < 1) throw actionError(409, "当前没有可用的官方重置额度");
    const creditId = firstAvailableCreditId(rateLimits?.rateLimitResetCredits);
    const record = {
      nonce: crypto.randomBytes(24).toString("base64url"),
      creditId,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: this.now() + RESET_TTL_MS,
      ...(accountContext !== undefined ? {
        accountContext: normalizeAccountContext(accountContext),
      } : {}),
    };
    this.resets.set(String(userId), record);
    trimOldest(this.resets);
    return {
      nonce: record.nonce,
      expiresAt: record.expiresAt,
      confirmationPhrase: "确认重置",
      availableCount: summary.availableCount,
    };
  }

  consumeReset(userId, nonce, confirmation, { accountContext = undefined } = {}) {
    this.prune();
    const key = String(userId);
    const record = this.resets.get(key);
    if (!record || !safeEqual(record.nonce, nonce)) throw actionError(409, "重置确认已过期，请重新查询");
    if (!accountContextMatches(record.accountContext, accountContext)) {
      this.resets.delete(key);
      throw actionError(409, "官方账号已切换，请重新查询重置额度");
    }
    if (String(confirmation || "") !== "确认重置") throw actionError(400, "请输入“确认重置”完成复验");
    this.resets.delete(key);
    return {
      creditId: record.creditId,
      idempotencyKey: record.idempotencyKey,
    };
  }

  clear(userId) {
    const key = String(userId);
    this.logins.delete(key);
    this.resets.delete(key);
  }

  prune() {
    const now = this.now();
    for (const [userId, record] of this.logins) {
      if (record.expiresAt <= now) this.logins.delete(userId);
    }
    for (const [userId, record] of this.resets) {
      if (record.expiresAt <= now) this.resets.delete(userId);
    }
  }
}

export function sanitizeOfficialAccount(result) {
  const account = result?.account;
  if (!account || typeof account !== "object") {
    return { account: null, requiresOpenaiAuth: result?.requiresOpenaiAuth === true };
  }
  const type = ["apiKey", "chatgpt", "amazonBedrock"].includes(account.type) ? account.type : "unknown";
  return {
    account: {
      type,
      ...(type === "chatgpt" ? {
        email: nullableText(account.email, 320),
        planType: boundedText(account.planType, 64) || "unknown",
      } : {}),
    },
    requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
  };
}

export async function readCodexChatGptAccount(codexHome, {
  uid = null,
  gid = null,
  now = Date.now(),
} = {}) {
  if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) return null;
  let handle;
  try {
    handle = await fs.open(
      path.join(codexHome, "auth.json"),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.size < 2
      || stat.size > MAX_CODEX_AUTH_BYTES
      || (stat.mode & 0o777) !== 0o600
      || (Number.isInteger(uid) && stat.uid !== uid)
      || (Number.isInteger(gid) && stat.gid !== gid)
    ) return null;
    const auth = JSON.parse(await handle.readFile("utf8"));
    if (auth?.auth_mode !== "chatgpt") return null;
    const idToken = decodeJwtPayload(auth.tokens?.id_token);
    const accessToken = decodeJwtPayload(auth.tokens?.access_token);
    if (!openAiToken(idToken) || !validOpenAiToken(accessToken, now)) return null;
    const authClaims = accessToken["https://api.openai.com/auth"]
      || idToken["https://api.openai.com/auth"];
    return {
      type: "chatgpt",
      email: nullableText(idToken.email, 320),
      planType: boundedText(authClaims?.chatgpt_plan_type, 64) || "unknown",
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function sanitizeOfficialUsage(result) {
  if (!result?.summary || typeof result.summary !== "object") return null;
  return {
    lifetimeTokens: nullableSafeInteger(result.summary.lifetimeTokens),
    currentStreakDays: nullableSafeInteger(result.summary.currentStreakDays),
    longestStreakDays: nullableSafeInteger(result.summary.longestStreakDays),
    peakDailyTokens: nullableSafeInteger(result.summary.peakDailyTokens),
    longestRunningTurnSec: nullableSafeInteger(result.summary.longestRunningTurnSec),
  };
}

export function sanitizeOfficialRateLimits(result) {
  if (!result || typeof result !== "object") return null;
  const buckets = [];
  const byId = result.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    for (const [id, value] of Object.entries(byId).slice(0, 8)) {
      const bucket = sanitizeRateLimit(value, id);
      if (bucket) buckets.push(bucket);
    }
  }
  if (!buckets.length) {
    const bucket = sanitizeRateLimit(result.rateLimits, "codex");
    if (bucket) buckets.push(bucket);
  }
  return {
    buckets,
    resetCredits: sanitizeResetCredits(result.rateLimitResetCredits),
  };
}

export function officialCredentialFailureState(previousCount, {
  alreadyInvalid = false,
  usageAuthenticationFailed = false,
  rateLimitAuthenticationFailed = false,
} = {}) {
  const credentialInvalid = alreadyInvalid === true
    || (usageAuthenticationFailed === true && rateLimitAuthenticationFailed === true);
  const boundedPrevious = Number.isSafeInteger(previousCount) && previousCount > 0
    ? Math.min(previousCount, 1_000)
    : 0;
  const failureCount = credentialInvalid ? boundedPrevious + 1 : 0;
  return {
    credentialInvalid,
    failureCount,
    markInvalid: credentialInvalid && failureCount >= 2,
  };
}

export function sanitizeOfficialWorkspaceMessages(result, {
  seenMessageIds = [],
} = {}) {
  const seen = new Set(Array.isArray(seenMessageIds)
    ? seenMessageIds.filter((value) => typeof value === "string" && value.length <= 256)
    : []);
  const messages = [];
  const ids = new Set();
  for (const value of Array.isArray(result?.messages) ? result.messages.slice(0, 64) : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const messageId = safeWorkspaceMessageId(value.messageId);
    const messageBody = redactWorkspaceMessage(boundedText(value.messageBody, 4_000));
    const archivedAt = nullableTimestamp(value.archivedAt);
    if (!messageId || !messageBody || ids.has(messageId) || archivedAt !== null) continue;
    ids.add(messageId);
    const messageType = ["headline", "announcement"].includes(value.messageType)
      ? value.messageType
      : "unknown";
    messages.push({
      messageId,
      messageType,
      category: workspaceMessageCategory(messageBody, messageType),
      messageBody,
      createdAt: nullableTimestamp(value.createdAt),
      unread: !seen.has(messageId),
    });
    if (messages.length >= 32) break;
  }
  messages.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
  return {
    featureEnabled: result?.featureEnabled === true,
    messages,
    unreadCount: messages.filter((message) => message.unread).length,
  };
}

function sanitizeRateLimit(value, fallbackId) {
  if (!value || typeof value !== "object") return null;
  return {
    id: boundedText(value.limitId, 96) || boundedText(fallbackId, 96) || "codex",
    name: nullableText(value.limitName, 128),
    planType: nullableText(value.planType, 64),
    rateLimitReachedType: nullableText(value.rateLimitReachedType, 96),
    primary: sanitizeWindow(value.primary),
    secondary: sanitizeWindow(value.secondary),
    credits: value.credits && typeof value.credits === "object" ? {
      hasCredits: value.credits.hasCredits === true,
      unlimited: value.credits.unlimited === true,
      balance: nullableText(value.credits.balance, 64),
    } : null,
    individualLimit: value.individualLimit && typeof value.individualLimit === "object" ? {
      limit: nullableText(value.individualLimit.limit, 64),
      used: nullableText(value.individualLimit.used, 64),
      remainingPercent: boundedPercent(value.individualLimit.remainingPercent),
      resetsAt: nullableTimestamp(value.individualLimit.resetsAt),
    } : null,
  };
}

function workspaceMessageCategory(body, messageType) {
  if (/(?:credit|quota|usage[\s_-]*limit|rate[\s_-]*limit|额度|限额|用量)/i.test(body)) return "quota";
  if (/(?:plan|subscription|billing|workspace|套餐|订阅|账单|工作区)/i.test(body)) return "plan";
  if (/(?:account|login|security|administrator|账号|账户|登录|安全|管理员)/i.test(body)) return "account";
  return messageType === "headline" ? "notice" : "announcement";
}

function redactWorkspaceMessage(value) {
  if (!value) return null;
  return value
    .replace(
      /((?:https?|ssh|git|socks5h?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/)(?:[^/\s:@]+)(?::[^/\s@]*)?@/gi,
      "$1[已隐藏认证]@",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "$1 [已隐藏]")
    .replace(/\b(?:[srp]k-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9_]{8,})\b/gi, "[已隐藏凭据]")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g, "[已隐藏凭据]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, "[已隐藏令牌]")
    .replace(
      /((?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|token|secret|authorization|password|passwd|cookie)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[已隐藏]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|signature)=)[^&#\s]*/gi,
      "$1[已隐藏]",
    )
    .slice(0, 4_000);
}

function safeWorkspaceMessageId(value) {
  const raw = boundedText(value, 256);
  if (!raw) return null;
  if (
    /^[A-Za-z0-9._:-]{1,128}$/.test(raw)
    && redactWorkspaceMessage(raw) === raw
  ) return raw;
  return `message-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function sanitizeWindow(value) {
  if (!value || typeof value !== "object") return null;
  return {
    usedPercent: boundedPercent(value.usedPercent),
    resetsAt: nullableTimestamp(value.resetsAt),
    windowDurationMins: nullableSafeInteger(value.windowDurationMins),
  };
}

function sanitizeResetCredits(value) {
  if (!value || typeof value !== "object") return null;
  const availableCount = Math.max(0, nullableSafeInteger(value.availableCount) || 0);
  const credits = Array.isArray(value.credits)
    ? value.credits.slice(0, 8).map((credit) => ({
      title: nullableText(credit?.title, 128),
      description: nullableText(credit?.description, MAX_TEXT_LENGTH),
      resetType: nullableText(credit?.resetType, 64),
      status: nullableText(credit?.status, 32),
      grantedAt: nullableTimestamp(credit?.grantedAt),
      expiresAt: nullableTimestamp(credit?.expiresAt),
    }))
    : null;
  return { availableCount, credits };
}

function firstAvailableCreditId(value) {
  if (!Array.isArray(value?.credits)) return null;
  const credit = value.credits.find((entry) => entry?.status === "available" && boundedText(entry.id, 512));
  return credit ? boundedText(credit.id, 512) : null;
}

function officialVerificationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    const officialHost = hostname === "openai.com"
      || hostname.endsWith(".openai.com")
      || hostname === "chatgpt.com"
      || hostname.endsWith(".chatgpt.com");
    if (url.protocol !== "https:" || !officialHost || url.username || url.password) return null;
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function publicLogin(record) {
  return {
    type: record.type,
    ...(record.type === "chatgptDeviceCode" ? {
      userCode: record.userCode,
      verificationUrl: record.verificationUrl,
    } : {}),
    ...(record.proxySelection ? {
      proxy: record.proxySelection.proxy
        ? publicOfficialProxy({ config: record.proxySelection.proxy, health: record.proxySelection.health })
        : null,
    } : {}),
    expiresAt: record.expiresAt,
  };
}

function privateLogin(record) {
  return {
    loginId: record.loginId,
    type: record.type,
    ...(record.proxySelection ? {
      proxySelection: {
        proxy: record.proxySelection.proxy ? { ...record.proxySelection.proxy } : null,
        health: record.proxySelection.health ? { ...record.proxySelection.health } : null,
        restoreProxy: record.proxySelection.restoreProxy ? { ...record.proxySelection.restoreProxy } : null,
      },
    } : {}),
  };
}

function normalizeAccountContext(value) {
  const epoch = boundedText(value?.epoch, 128);
  const accountId = value?.accountId == null ? null : boundedText(value.accountId, 512);
  if (!epoch || (value?.accountId != null && !accountId)) {
    throw actionError(500, "官方账号操作上下文无效");
  }
  return { epoch, accountId };
}

function accountContextMatches(expected, actual) {
  if (!expected) return true;
  if (actual === undefined) return false;
  const epoch = boundedText(actual?.epoch, 128);
  const accountId = actual?.accountId == null ? null : boundedText(actual.accountId, 512);
  return Boolean(epoch)
    && epoch === expected.epoch
    && accountId === expected.accountId;
}

function boundedText(value, maximum = MAX_TEXT_LENGTH) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function nullableText(value, maximum) {
  return value === null || value === undefined ? null : boundedText(String(value), maximum);
}

function decodeJwtPayload(value) {
  if (typeof value !== "string" || value.length > 64 * 1024) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    if (decoded.length > 64 * 1024) return null;
    const payload = JSON.parse(decoded);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function validOpenAiToken(payload, now) {
  return openAiToken(payload)
    && Number.isSafeInteger(payload.exp)
    && payload.exp * 1_000 > now;
}

function openAiToken(payload) {
  return payload?.iss === "https://auth.openai.com";
}

function nullableSafeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nullableTimestamp(value) {
  const timestamp = nullableSafeInteger(value);
  return timestamp && timestamp <= 10_000_000_000 ? timestamp : null;
}

function boundedPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : null;
}

function safeEqual(expected, supplied) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(supplied || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function trimOldest(records) {
  while (records.size > MAX_PENDING_USERS) records.delete(records.keys().next().value);
}

function actionError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
