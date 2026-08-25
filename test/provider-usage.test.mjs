import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProviderUsage,
  ProviderUsageCache,
  providerUsageEndpoint,
} from "../lib/provider-usage.mjs";

test("selects known provider usage endpoints without exposing credentials", () => {
  assert.deepEqual(providerUsageEndpoint({ baseUrl: "https://opencode.ai/zen/go/v1" }), {
    adapter: "opencode-usage",
    url: "https://opencode.ai/zen/go/v1/usage",
  });
  assert.deepEqual(providerUsageEndpoint({ baseUrl: "https://speed.ai-pixel.online" }), {
    adapter: "gateway-usage",
    url: "https://speed.ai-pixel.online/v1/usage",
  });
  assert.deepEqual(providerUsageEndpoint({ baseUrl: "https://api.deepseek.com/v1" }), {
    adapter: "deepseek-balance",
    url: "https://api.deepseek.com/user/balance",
  });
  assert.deepEqual(providerUsageEndpoint({ baseUrl: "https://example.test/v1" }), {
    adapter: "generic-usage",
    url: "https://example.test/v1/usage",
  });
});

test("normalizes OpenCode rolling and weekly limits", () => {
  const result = normalizeProviderUsage({
    usage: {
      rolling: { status: "ok", percent: 25, resetsAt: "2026-08-14T14:01:13.417Z" },
      weekly: { status: "ok", percent: 40, resetsAt: "2026-08-17T00:00:00.417Z" },
    },
  }, "opencode-usage");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
  })), [
    { label: "5 小时", usedPercent: 25, resetsAt: "2026-08-14T14:01:13.417Z" },
    { label: "7 天", usedPercent: 40, resetsAt: "2026-08-17T00:00:00.417Z" },
  ]);
});

test("normalizes five-hour, weekly, and monthly aliases with used/limit values", () => {
  const result = normalizeProviderUsage({
    rate_limits: {
      five_hour: { used: 25, limit: 100, reset_at: 1_786_731_600 },
      seven_day: { utilization: 0.4, resets_at: "2026-08-17T00:00:00.000Z" },
      monthly: { usedPercent: 12 },
    },
  }, "opencode-usage");
  assert.deepEqual(result.windows.map((window) => ({
    label: window.label,
    usedPercent: window.usedPercent,
  })), [
    { label: "5 小时", usedPercent: 25 },
    { label: "7 天", usedPercent: 40 },
    { label: "本月", usedPercent: 12 },
  ]);
  assert.equal(result.windows[0].resetsAt, "2026-08-14T18:20:00.000Z");
});

test("normalizes gateway wallet and DeepSeek balance responses", () => {
  const gateway = normalizeProviderUsage({
    isValid: true,
    mode: "unrestricted",
    planName: "钱包余额",
    balance: 13.9013,
    remaining: 13.9013,
    unit: "USD",
    usage: {
      today: { requests: 4, actual_cost: 0.12 },
      total: { requests: 20, actual_cost: 1.25 },
    },
  }, "gateway-usage");
  assert.deepEqual(gateway.balance, {
    amount: 13.9013,
    remaining: 13.9013,
    currency: "USD",
    granted: null,
    toppedUp: null,
  });
  assert.deepEqual(gateway.usage, {
    todayRequests: 4,
    todayCost: 0.12,
    totalRequests: 20,
    totalCost: 1.25,
  });

  const deepseek = normalizeProviderUsage({
    is_available: true,
    balance_infos: [{
      currency: "CNY",
      total_balance: "26.81",
      granted_balance: "0.00",
      topped_up_balance: "26.81",
    }],
  }, "deepseek-balance");
  assert.equal(deepseek.status, "ok");
  assert.equal(deepseek.balance.amount, 26.81);
  assert.equal(deepseek.balance.currency, "CNY");
});

test("caches provider usage, refreshes on demand, and never returns the API key", async () => {
  let calls = 0;
  const secret = "provider-usage-secret";
  const cache = new ProviderUsageCache({
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      return new Response(JSON.stringify({
        balance: 8.5,
        remaining: 8.5,
        unit: "USD",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    now: (() => {
      let value = 1_000;
      return () => value++;
    })(),
  });
  const profile = {
    id: "p-123456789abc",
    name: "Test provider",
    baseUrl: "https://example.test/v1",
    apiKey: secret,
  };

  const first = await cache.query(profile);
  const second = await cache.query(profile);
  const forced = await cache.query(profile, { force: true });
  assert.equal(calls, 2);
  assert.equal(first.balance.amount, 8.5);
  assert.equal(second.balance.amount, 8.5);
  assert.equal(forced.balance.amount, 8.5);
  assert.doesNotMatch(JSON.stringify(first), /provider-usage-secret/u);
});

test("marks an unrecognized provider response as unsupported", async () => {
  const cache = new ProviderUsageCache({
    fetchImpl: async () => new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  });
  const result = await cache.query({
    id: "p-123456789abc",
    name: "Unknown provider",
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
  });
  assert.equal(result.status, "unsupported");
  assert.match(result.message, /未提供/);
});
