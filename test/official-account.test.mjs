import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OfficialAccountActions,
  officialCredentialFailureState,
  readCodexChatGptAccount,
  sanitizeOfficialAccount,
  sanitizeOfficialRateLimits,
  sanitizeOfficialUsage,
  sanitizeOfficialWorkspaceMessages,
} from "../lib/official-account.mjs";

test("official credential health ignores auxiliary and partial authentication failures", () => {
  assert.deepEqual(officialCredentialFailureState(0, {
    usageAuthenticationFailed: false,
    rateLimitAuthenticationFailed: false,
  }), {
    credentialInvalid: false,
    failureCount: 0,
    markInvalid: false,
  });
  assert.deepEqual(officialCredentialFailureState(1, {
    usageAuthenticationFailed: true,
    rateLimitAuthenticationFailed: false,
  }), {
    credentialInvalid: false,
    failureCount: 0,
    markInvalid: false,
  });
  assert.deepEqual(officialCredentialFailureState(0, {
    usageAuthenticationFailed: true,
    rateLimitAuthenticationFailed: true,
  }), {
    credentialInvalid: true,
    failureCount: 1,
    markInvalid: false,
  });
  assert.deepEqual(officialCredentialFailureState(1, {
    usageAuthenticationFailed: true,
    rateLimitAuthenticationFailed: true,
  }), {
    credentialInvalid: true,
    failureCount: 2,
    markInvalid: true,
  });
});

test("official device login retains private login IDs only in bounded server state", () => {
  let now = 1_000;
  const actions = new OfficialAccountActions({ now: () => now });
  const pending = actions.rememberLogin("user-1", {
    type: "chatgptDeviceCode",
    loginId: "private-login-id",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/deviceauth",
  });

  assert.deepEqual(pending, {
    type: "chatgptDeviceCode",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/deviceauth",
    expiresAt: 901_000,
  });
  assert.doesNotMatch(JSON.stringify(pending), /private-login-id/);
  assert.deepEqual(actions.takeLogin("user-1"), { loginId: "private-login-id", type: "chatgptDeviceCode" });
  assert.equal(actions.pendingLogin("user-1"), null);

  assert.throws(() => actions.rememberLogin("user-1", {
    type: "chatgptDeviceCode",
    loginId: "private-login-id",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://openai.example.test/deviceauth",
  }), /无效响应/);

  actions.rememberLogin("user-1", {
    type: "chatgptDeviceCode",
    loginId: "private-login-id-2",
    userCode: "NEXT-CODE",
    verificationUrl: "https://chatgpt.com/device",
  });
  now += 15 * 60 * 1000 + 1;
  assert.equal(actions.pendingLogin("user-1"), null);
});

test("official server OAuth keeps the login ID and authorization URL private", () => {
  const actions = new OfficialAccountActions({ now: () => 2_000 });
  const pending = actions.rememberLogin("user-1", {
    type: "chatgpt",
    loginId: "private-oauth-login-id",
    authUrl: "https://auth.openai.com/oauth/authorize?private=secret",
  });

  assert.deepEqual(pending, { type: "chatgpt", expiresAt: 902_000 });
  assert.doesNotMatch(JSON.stringify(pending), /login-id|authUrl|authorize|secret/i);
  assert.deepEqual(actions.pendingLogin("user-1"), pending);
  assert.deepEqual(actions.discardLogin("user-1", "private-oauth-login-id"), {
    loginId: "private-oauth-login-id",
    type: "chatgpt",
  });
  assert.equal(actions.pendingLogin("user-1"), null);
});

test("official server OAuth exposes only sanitized per-account proxy state", () => {
  const actions = new OfficialAccountActions({ now: () => 3_000 });
  const pending = actions.rememberLogin("user-1", {
    type: "chatgpt",
    loginId: "private-proxy-login-id",
  }, {
    proxy: {
      protocol: "socks5",
      host: "residential.example.test",
      port: 1080,
      username: "proxy-user",
      password: "proxy-password",
      label: "Residential",
    },
    proxyHealth: {
      status: "ready",
      checkedAt: 2_900,
      latencyMs: 18,
      exitIp: "8.8.8.8",
    },
    restoreProxy: null,
  });

  assert.equal(pending.proxy.protocol, "socks5");
  assert.equal(pending.proxy.hasAuthentication, true);
  assert.equal(pending.proxy.health.exitIp, "8.8.8.8");
  assert.doesNotMatch(JSON.stringify(pending), /proxy-user|proxy-password|private-proxy-login-id/);
  const completed = actions.completeLogin("user-1", { loginId: "private-proxy-login-id", success: true });
  assert.equal(completed.proxySelection.proxy.username, "proxy-user");
  assert.equal(completed.proxySelection.proxy.password, "proxy-password");
  assert.equal(actions.pendingLogin("user-1"), null);
});

test("official login completions are isolated by account generation", () => {
  const actions = new OfficialAccountActions({ now: () => 4_000 });
  const original = { epoch: "epoch-original", accountId: "account-original" };
  const current = { epoch: "epoch-current", accountId: "account-current" };
  actions.rememberLogin("user-1", {
    type: "chatgpt",
    loginId: "private-login-id",
  }, { accountContext: original });

  assert.equal(actions.pendingLogin("user-1", current), null);
  assert.equal(actions.completeLogin("user-1", {
    loginId: "private-login-id",
    success: true,
  }, current), false);
  assert.notEqual(actions.pendingLogin("user-1", original), null);
  assert.equal(actions.completeLogin("user-1", {
    loginId: "private-login-id",
    success: true,
  }, original).loginId, "private-login-id");
});

test("official reset confirmations are exact, short-lived, and one use", () => {
  let now = 5_000;
  const actions = new OfficialAccountActions({ now: () => now });
  const limits = {
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{ id: "private-credit-id", status: "available" }],
    },
  };
  const prepared = actions.prepareReset("user-1", limits);
  assert.equal(prepared.confirmationPhrase, "确认重置");
  assert.equal(prepared.availableCount, 1);
  assert.doesNotMatch(JSON.stringify(prepared), /private-credit-id|idempotency/i);
  assert.throws(
    () => actions.consumeReset("user-1", prepared.nonce, "确认"),
    /确认重置/,
  );
  const consumed = actions.consumeReset("user-1", prepared.nonce, "确认重置");
  assert.equal(consumed.creditId, "private-credit-id");
  assert.match(consumed.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.throws(
    () => actions.consumeReset("user-1", prepared.nonce, "确认重置"),
    /已过期/,
  );

  const expiring = actions.prepareReset("user-1", limits);
  now += 2 * 60 * 1000 + 1;
  assert.throws(
    () => actions.consumeReset("user-1", expiring.nonce, "确认重置"),
    /已过期/,
  );
  assert.throws(
    () => actions.prepareReset("user-1", { rateLimitResetCredits: { availableCount: 0 } }),
    /没有可用/,
  );
});

test("official reset confirmations cannot cross an account generation", () => {
  const actions = new OfficialAccountActions({ now: () => 6_000 });
  const limits = {
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{ id: "private-credit-id", status: "available" }],
    },
  };
  const prepared = actions.prepareReset("user-1", limits, {
    accountContext: { epoch: "epoch-original", accountId: "account-original" },
  });
  assert.throws(
    () => actions.consumeReset("user-1", prepared.nonce, "确认重置", {
      accountContext: { epoch: "epoch-current", accountId: "account-current" },
    }),
    /账号已切换/,
  );
  assert.throws(
    () => actions.consumeReset("user-1", prepared.nonce, "确认重置", {
      accountContext: { epoch: "epoch-original", accountId: "account-original" },
    }),
    /已过期/,
  );
});

test("official account query exposes only sanitized bounded fields", () => {
  assert.deepEqual(sanitizeOfficialAccount({
    account: { type: "chatgpt", email: "user@example.test", planType: "plus", accessToken: "secret" },
    requiresOpenaiAuth: true,
  }), {
    account: { type: "chatgpt", email: "user@example.test", planType: "plus" },
    requiresOpenaiAuth: true,
  });

  assert.deepEqual(sanitizeOfficialUsage({
    summary: {
      lifetimeTokens: 123,
      currentStreakDays: null,
      longestStreakDays: 7,
      peakDailyTokens: -1,
      longestRunningTurnSec: 60,
    },
    dailyUsageBuckets: [{ startDate: "2026-01-01", tokens: 99 }],
  }), {
    lifetimeTokens: 123,
    currentStreakDays: null,
    longestStreakDays: 7,
    peakDailyTokens: null,
    longestRunningTurnSec: 60,
  });

  const sanitized = sanitizeOfficialRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        planType: "plus",
        primary: { usedPercent: 140, resetsAt: 2_000_000_000, windowDurationMins: 300 },
        secondary: null,
      },
    },
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{ id: "private-credit-id", title: "Reset", status: "available" }],
    },
  });
  assert.equal(sanitized.buckets[0].primary.usedPercent, 100);
  assert.equal(sanitized.resetCredits.availableCount, 1);
  assert.doesNotMatch(JSON.stringify(sanitized), /private-credit-id/);
});

test("official workspace messages are bounded, classified, redacted, and marked unread", () => {
  const sanitized = sanitizeOfficialWorkspaceMessages({
    featureEnabled: true,
    ignoredSecret: "server-private-value",
    messages: [{
      messageId: "quota-1",
      messageType: "headline",
      messageBody: "Usage limit reached. api key: sk-proj-abcdefghijklmnopqrstuvwxyz",
      createdAt: 2_000,
      archivedAt: null,
      accessToken: "must-not-pass-through",
    }, {
      messageId: "gho_upstreamsecret1234567890",
      messageType: "announcement",
      messageBody: "Proxy socks5://alice:private-password@proxy.example.test cookie=session-secret",
      createdAt: 1_500,
      archivedAt: null,
    }, {
      messageId: "plan-1",
      messageType: "announcement",
      messageBody: "Your workspace subscription plan changed. Bearer opaque-private-token-value",
      createdAt: 1_000,
      archivedAt: null,
    }, {
      messageId: "archived-1",
      messageType: "announcement",
      messageBody: "This archived announcement must not be displayed.",
      createdAt: 3_000,
      archivedAt: 3_100,
    }, {
      messageId: "quota-1",
      messageType: "announcement",
      messageBody: "Duplicate must not be displayed.",
      createdAt: 4_000,
      archivedAt: null,
    }],
  }, { seenMessageIds: ["plan-1"] });

  assert.equal(sanitized.featureEnabled, true);
  assert.equal(sanitized.unreadCount, 2);
  assert.deepEqual(sanitized.messages.map((message) => ({
    id: message.messageId,
    category: message.category,
    unread: message.unread,
  })), [
    { id: "quota-1", category: "quota", unread: true },
    {
      id: `message-${crypto.createHash("sha256").update("gho_upstreamsecret1234567890").digest("hex").slice(0, 24)}`,
      category: "announcement",
      unread: true,
    },
    { id: "plan-1", category: "plan", unread: false },
  ]);
  assert.match(sanitized.messages[0].messageBody, /\[已隐藏(?:密钥|凭据)?\]/);
  assert.match(sanitized.messages[1].messageBody, /socks5:\/\/\[已隐藏认证\]@proxy\.example\.test/);
  assert.match(sanitized.messages[1].messageBody, /cookie=\[已隐藏\]/);
  assert.match(sanitized.messages[2].messageBody, /Bearer \[已隐藏\]/);
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /server-private|must-not-pass|sk-proj|opaque-private|upstreamsecret|private-password|session-secret|archived announcement|Duplicate/,
  );

  const bounded = sanitizeOfficialWorkspaceMessages({
    featureEnabled: "yes",
    messages: Array.from({ length: 40 }, (_, index) => ({
      messageId: `message-${index}`,
      messageType: "unknown-new-type",
      messageBody: `Account security notice ${index}`,
      createdAt: index + 1,
      archivedAt: null,
    })),
  });
  assert.equal(bounded.featureEnabled, false);
  assert.equal(bounded.messages.length, 32);
  assert.equal(bounded.messages[0].category, "account");
  assert.equal(bounded.messages[0].messageType, "unknown");
});

test("protected Codex auth provides a bounded ChatGPT account fallback", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-fallback-"));
  const now = 1_900_000_000_000;
  const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const idToken = token({
    iss: "https://auth.openai.com",
    exp: Math.floor(now / 1_000) + 3_600,
    email: "user@example.test",
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
  });
  const accessToken = token({
    iss: "https://auth.openai.com",
    exp: Math.floor(now / 1_000) + 3_600,
  });
  const authPath = path.join(codexHome, "auth.json");
  try {
    await fs.writeFile(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: accessToken },
    }), { mode: 0o600 });
    const stat = await fs.stat(authPath);
    assert.deepEqual(await readCodexChatGptAccount(codexHome, {
      uid: stat.uid,
      gid: stat.gid,
      now,
    }), {
      type: "chatgpt",
      email: "user@example.test",
      planType: "plus",
    });

    const expiredIdToken = token({
      iss: "https://auth.openai.com",
      exp: Math.floor(now / 1_000) - 3_600,
      email: "user@example.test",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });
    await fs.writeFile(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: expiredIdToken, access_token: accessToken, refresh_token: "refresh-token" },
    }), { mode: 0o600 });
    assert.deepEqual(await readCodexChatGptAccount(codexHome, {
      uid: stat.uid,
      gid: stat.gid,
      now,
    }), {
      type: "chatgpt",
      email: "user@example.test",
      planType: "plus",
    });

    await fs.chmod(authPath, 0o644);
    assert.equal(await readCodexChatGptAccount(codexHome, {
      uid: stat.uid,
      gid: stat.gid,
      now,
    }), null);
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});
