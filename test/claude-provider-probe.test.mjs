import assert from "node:assert/strict";
import test from "node:test";
import { probeClaudeProvider } from "../lib/claude-provider-probe.mjs";

test("Claude provider probe uses Anthropic headers and discovers bounded model IDs", async () => {
  let observedUrl = null;
  let observedOptions = null;
  const result = await probeClaudeProvider({
    baseUrl: "https://api.example.test/gateway/",
    apiKey: "claude-provider-secret",
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return new Response(JSON.stringify({
        data: [
          { id: "claude-sonnet-4-6" },
          { id: "claude-haiku-4-5" },
          { id: "claude-sonnet-4-6" },
          { id: "invalid model" },
        ],
      }), { status: 200 });
    },
  });

  assert.equal(observedUrl, "https://api.example.test/gateway/v1/models");
  assert.equal(observedOptions.method, "GET");
  assert.equal(observedOptions.redirect, "error");
  assert.equal(observedOptions.headers["anthropic-version"], "2023-06-01");
  assert.equal(observedOptions.headers["x-api-key"], "claude-provider-secret");
  assert.deepEqual(result.models, ["claude-haiku-4-5", "claude-sonnet-4-6"]);
  assert.equal(result.ok, true);
  assert.equal(result.discovery, "available");
  assert.doesNotMatch(JSON.stringify(result), /claude-provider-secret/);
});

test("Claude provider probe keeps manual model fallback when discovery is unsupported", async () => {
  const result = await probeClaudeProvider({
    baseUrl: "https://api.example.test/v1",
    apiKey: "claude-provider-secret",
    fetchImpl: async () => new Response("", { status: 404 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reachable, true);
  assert.equal(result.discovery, "unsupported");
  assert.deepEqual(result.models, []);
  assert.match(result.message, /手动填写模型/);
});

test("Claude provider probe classifies upstream failures without relaying response bodies", async () => {
  const authentication = await probeClaudeProvider({
    baseUrl: "https://api.example.test",
    apiKey: "claude-provider-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "bad claude-provider-secret" },
    }), { status: 401 }),
  });
  const rateLimit = await probeClaudeProvider({
    baseUrl: "https://api.example.test",
    apiKey: "claude-provider-secret",
    fetchImpl: async () => new Response("quota for claude-provider-secret", { status: 429 }),
  });

  assert.equal(authentication.category, "authentication");
  assert.equal(authentication.authenticated, false);
  assert.equal(rateLimit.category, "rate_limit");
  assert.doesNotMatch(JSON.stringify([authentication, rateLimit]), /claude-provider-secret/);
});

test("Claude provider probe classifies network failures and rejects unsafe URLs", async () => {
  const dns = await probeClaudeProvider({
    baseUrl: "https://api.example.test",
    apiKey: "claude-provider-secret",
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ENOTFOUND" };
      throw error;
    },
  });
  const unsafe = await probeClaudeProvider({
    baseUrl: "http://private.example.test",
    apiKey: "claude-provider-secret",
  });

  assert.equal(dns.category, "dns");
  assert.equal(dns.message, "无法解析供应商域名");
  assert.equal(unsafe.category, "configuration");
  assert.equal(unsafe.reachable, false);
});
