import assert from "node:assert/strict";
import test from "node:test";
import { listProviderModels } from "../lib/provider-models.mjs";

test("queries the provider v1 models endpoint with a secret and returns bounded unique IDs", async () => {
  let observedUrl = null;
  let observedOptions = null;
  const models = await listProviderModels({
    baseUrl: "https://api.example.test/openai/v1/",
    apiKey: "provider-model-secret",
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "vendor-chat-2.0", object: "model" },
          { id: "vendor-chat-1.0", object: "model" },
          { id: "vendor-chat-2.0", object: "model" },
          { id: "invalid model", object: "model" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(observedUrl, "https://api.example.test/openai/v1/models");
  assert.equal(observedOptions.method, "GET");
  assert.equal(observedOptions.redirect, "error");
  assert.equal(observedOptions.headers.Authorization, "Bearer provider-model-secret");
  assert.deepEqual(models, ["vendor-chat-1.0", "vendor-chat-2.0"]);
});

test("provider model errors never relay upstream secrets", async () => {
  await assert.rejects(
    listProviderModels({
      baseUrl: "https://api.example.test/v1",
      apiKey: "provider-model-secret",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: "bad provider-model-secret" },
      }), { status: 401, headers: { "Content-Type": "application/json" } }),
    }),
    (error) => error.statusCode === 502 && !error.message.includes("provider-model-secret"),
  );
});

test("provider model queries reject invalid response shapes", async () => {
  await assert.rejects(
    listProviderModels({
      baseUrl: "https://api.example.test/v1",
      apiKey: "provider-model-secret",
      fetchImpl: async () => new Response(JSON.stringify({ models: ["vendor-chat"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    }),
    /返回格式不正确/,
  );
});
