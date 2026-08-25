import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AiProviderTestError,
  AiProviderTestToolService,
  requestAiProviderAgentTest,
  requestAiProviderRequest,
  requestAiProviderRunSuite,
  requestAiProviderTest,
} from "../lib/ai-provider-test-tool-service.mjs";
import { listProviderModels } from "../lib/provider-models.mjs";
import { startFakeResponsesProvider } from "./fixtures/fake-responses-provider.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);

const profile = {
  id: "p-0123456789ab",
  name: "Fake Provider",
  baseUrl: "https://provider.example/v1",
  model: "fake-model",
  apiKey: "sk-secret-provider-key",
};

test("AI provider test sends a Responses request and redacts provider secrets", async () => {
  let requestedUrl = null;
  let requestedBody = null;
  let requestedAuthorization = null;
  const result = await requestAiProviderTest({
    profile,
    input: {
      prompt: "reply with a short health check",
      maxOutputTokens: 100_000,
      reasoningEffort: "high",
    },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedBody = JSON.parse(options.body);
      requestedAuthorization = options.headers.Authorization;
      return new Response(JSON.stringify({
        output_text: `WFL online; ${profile.apiKey}`,
        usage: {
          input_tokens: 8,
          output_tokens: 5,
          total_tokens: 13,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_fake_1" },
      });
    },
  });

  assert.equal(requestedUrl, "https://provider.example/v1/responses");
  assert.deepEqual(requestedBody, {
    model: "fake-model",
    input: "reply with a short health check",
    max_output_tokens: 100_000,
    reasoning: { effort: "high" },
  });
  assert.equal(requestedAuthorization, `Bearer ${profile.apiKey}`);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, "apiKey"), false);
  assert.equal(result.providerName.includes(profile.apiKey), false);
  assert.equal(result.text.includes(profile.apiKey), false);
  assert.match(result.text, /WFL online/);
  assert.deepEqual(result.usage, {
    inputTokens: 8,
    outputTokens: 5,
    totalTokens: 13,
    cachedInputTokens: 2,
    reasoningTokens: 1,
  });
  assert.equal(result.requestId, "req_fake_1");
  assert.equal(result.maxOutputTokens, 100_000);
  assert.equal(result.reasoningEffort, "high");
});

test("AI provider reports when the output cap made a response incomplete", async () => {
  let requestedBody = null;
  const result = await requestAiProviderRequest({
    profile,
    input: { prompt: "write a long answer", maxOutputTokens: 32, reasoningEffort: "medium" },
    fetchImpl: async (_url, options) => {
      requestedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "partial answer",
        usage: { input_tokens: 4, output_tokens: 32, total_tokens: 36 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(requestedBody.reasoning, { effort: "medium" });
  assert.equal(result.ok, false);
  assert.equal(result.maxOutputTokens, 32);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.incompleteDetails, { reason: "max_output_tokens" });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 32, totalTokens: 36 });
});

test("AI provider test bounds input, rejects arbitrary HTTP URLs, and keeps upstream failures sanitized", async () => {
  await assert.rejects(
    requestAiProviderTest({
      profile: { ...profile, baseUrl: "http://provider.example/v1" },
      input: { prompt: "hello" },
      fetchImpl: async () => { throw new Error("must not fetch"); },
    }),
    (error) => error instanceof AiProviderTestError && error.code === "AI_PROVIDER_URL_INVALID",
  );
  await assert.rejects(
    requestAiProviderTest({
      profile,
      input: { prompt: "x".repeat(32_001) },
    }),
    /必须为 1-32000/,
  );

  const result = await requestAiProviderTest({
    profile,
    input: { prompt: "invalid key response" },
    fetchImpl: async () => new Response(JSON.stringify({ error: profile.apiKey }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.error.includes(profile.apiKey), false);
  assert.match(result.error, /拒绝/);
});

test("AI provider test turns an upstream timeout into a bounded public error", async () => {
  await assert.rejects(
    requestAiProviderTest({
      profile,
      input: { prompt: "timeout" },
      timeoutMs: 20,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    }),
    (error) => error instanceof AiProviderTestError && error.code === "AI_PROVIDER_TEST_TIMEOUT",
  );
});

test("Fake Responses Provider covers models, text, SSE, structured output, and tool calls", async (t) => {
  const fake = await startFakeResponsesProvider();
  t.after(() => fake.close());
  const localProfile = {
    ...profile,
    baseUrl: fake.baseUrl,
    apiKey: fake.apiKey,
  };

  const models = await listProviderModels({
    ...localProfile,
    responseLimitBytes: 512 * 1024,
  });
  assert.deepEqual(models, ["fake-model", "fake-reasoning"]);

  const text = await requestAiProviderRequest({
    profile: localProfile,
    input: { prompt: "text check", maxOutputTokens: 64, reasoningEffort: "low" },
  });
  assert.equal(text.ok, true);
  assert.equal(text.status, "completed");
  assert.match(text.text, /Fake Responses/);

  const stream = await requestAiProviderRequest({
    profile: localProfile,
    input: { prompt: "stream check", stream: true, maxOutputTokens: 64, reasoningEffort: "low" },
  });
  assert.equal(stream.ok, true);
  assert.equal(stream.streamed, true);
  assert.ok(stream.streamEvents >= 4);

  const structured = await requestAiProviderRequest({
    profile: localProfile,
    input: {
      prompt: "structured check",
      maxOutputTokens: 64,
      reasoningEffort: "low",
      jsonSchema: {
        name: "result",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" }, value: { type: "string" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
  });
  assert.equal(structured.ok, true);
  assert.equal(structured.structuredValid, true);

  const tool = await requestAiProviderRequest({
    profile: localProfile,
    input: {
      prompt: "call lookup",
      reasoningEffort: "low",
      tools: [{
        name: "lookup",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      toolChoice: "required",
    },
  });
  assert.equal(tool.ok, true);
  assert.equal(tool.toolCalls[0].name, "lookup");
  assert.deepEqual(tool.toolCalls[0].arguments, {});
  assert.equal(fake.requests.length, 4);
  assert.equal(fake.requests.every((entry) => entry.authorization === `Bearer ${fake.apiKey}`), true);
  assert.equal(fake.requests.every((entry) => entry.body.reasoning?.effort === "low"), true);
});

test("Fake Responses Provider exercises multi-round tool results and bounded failures", async (t) => {
  const fake = await startFakeResponsesProvider();
  t.after(() => fake.close());
  const localProfile = { ...profile, baseUrl: fake.baseUrl, apiKey: fake.apiKey };

  const agent = await requestAiProviderAgentTest({
    profile: localProfile,
    input: {
      prompt: "calculate and report the answer",
      reasoningEffort: "minimal",
      maxRounds: 3,
      maxToolCalls: 2,
      tools: [{
        name: "calc_value",
        builtin: "calculator",
        parameters: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
          additionalProperties: false,
        },
      }],
    },
  });
  assert.equal(agent.ok, true);
  assert.equal(agent.rounds, 2);
  assert.equal(agent.toolCalls[0].result.value, 14);
  assert.match(agent.text, /42/);
  assert.deepEqual(fake.requests[1].body.input.at(-1), {
    type: "function_call_output",
    call_id: "call_fake_1",
    output: '{"value":14}',
  });
  assert.equal(fake.requests.slice(0, 2).every((entry) => entry.body.reasoning?.effort === "minimal"), true);

  const failure = await requestAiProviderAgentTest({
    profile: localProfile,
    input: {
      prompt: "continue after failure",
      maxRounds: 2,
      maxToolCalls: 1,
      tools: [{
        name: "failure_tool",
        builtin: "failure",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
    },
  });
  assert.equal(failure.ok, true);
  assert.equal(failure.rounds, 2);
  assert.equal(failure.toolCalls[0].ok, false);
  assert.match(failure.text, /失败/);

  let invalidSchemaRequests = 0;
  const invalidSchema = await requestAiProviderAgentTest({
    profile: localProfile,
    input: {
      prompt: "validate arguments",
      maxRounds: 2,
      maxToolCalls: 1,
      tools: [{
        name: "needs_value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }],
    },
    fetchImpl: async () => {
      invalidSchemaRequests += 1;
      return new Response(JSON.stringify(invalidSchemaRequests === 1
        ? { output: [{ type: "function_call", call_id: "call_invalid", name: "needs_value", arguments: "{}" }] }
        : { output_text: "继续完成" }), { status: 200 });
    },
  });
  assert.equal(invalidSchema.ok, true);
  assert.equal(invalidSchema.toolCalls[0].schemaValid, false);
  assert.equal(invalidSchema.toolCalls[0].ok, false);
});

test("AI provider suite stays within its fixed request budget and reports each case", async (t) => {
  const fake = await startFakeResponsesProvider();
  t.after(() => fake.close());
  const result = await requestAiProviderRunSuite({
    profile: { ...profile, baseUrl: fake.baseUrl, apiKey: fake.apiKey },
    input: {
      maxOutputTokens: 64,
      reasoningEffort: "medium",
      cases: ["text", "stream", "structured", "tool_call", "tool_result", "error"],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.requestCount, 7);
  assert.equal(result.maxRequests, 7);
  assert.deepEqual(result.cases.map((entry) => entry.name), [
    "text", "stream", "structured", "tool_call", "tool_result", "error",
  ]);
  assert.equal(result.cases.every((entry) => entry.ok), true);
  assert.equal(fake.requests.length, 7);
  assert.equal(fake.requests.every((entry) => entry.body.max_output_tokens === 64), true);
  assert.equal(fake.requests.every((entry) => entry.body.reasoning?.effort === "medium"), true);
});

test("Fake Responses Provider errors stay bounded and secrets are redacted", async (t) => {
  const fake = await startFakeResponsesProvider();
  t.after(() => fake.close());
  const localProfile = { ...profile, baseUrl: fake.baseUrl, apiKey: fake.apiKey };
  for (const [model, status] of [["fake-401", 401], ["fake-429", 429]]) {
    const result = await requestAiProviderRequest({
      profile: localProfile,
      input: { model, prompt: "error check" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, status);
    assert.equal(JSON.stringify(result).includes(fake.apiKey), false);
  }

  const echoed = await requestAiProviderRequest({
    profile: localProfile,
    input: { prompt: "echo-secret" },
  });
  assert.equal(echoed.ok, true);
  assert.equal(JSON.stringify(echoed).includes(fake.apiKey), false);

  const nonStream = await requestAiProviderRequest({
    profile: localProfile,
    input: { prompt: "stream protocol", stream: true },
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "not an SSE response" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(nonStream.ok, false);
  assert.match(nonStream.error, /SSE/);

  const invalidJson = await requestAiProviderRequest({
    profile: localProfile,
    input: { model: "fake-invalid-json", prompt: "bad json" },
  });
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.error, /无效 JSON/);
  await assert.rejects(
    requestAiProviderRequest({ profile: localProfile, input: { model: "fake-oversized", prompt: "large" } }),
    /超过安全大小限制/,
  );
  await assert.rejects(
    requestAiProviderRequest({ profile: localProfile, input: { model: "fake-timeout", prompt: "timeout" }, timeoutMs: 20 }),
    (error) => error instanceof AiProviderTestError && error.code === "AI_PROVIDER_TEST_TIMEOUT",
  );
  await assert.rejects(
    requestAiProviderRequest({ profile: localProfile, input: { model: "fake-disconnect", prompt: "disconnect", stream: true } }),
    /响应|读取|中断|无法连接/,
  );
});

test("AI provider detailed request supports structured output and function tools", async () => {
  let requestedBody = null;
  const result = await requestAiProviderRequest({
    profile,
    input: {
      prompt: "return a status object",
      tools: [{
        name: "get_status",
        description: "read status",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      toolChoice: "auto",
      jsonSchema: {
        name: "status",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
    },
    fetchImpl: async (_url, options) => {
      requestedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output_text: '{"ok":true}',
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"ok":true}' }],
        }],
        status: "completed",
      }), { status: 200, headers: { "x-request-id": "req_detail_1" } });
    },
  });

  assert.equal(requestedBody.model, profile.model);
  assert.equal(requestedBody.tool_choice, "auto");
  assert.equal(requestedBody.tools[0].name, "get_status");
  assert.equal(Object.hasOwn(requestedBody.tools[0], "mockResult"), false);
  assert.deepEqual(requestedBody.text.format, {
    type: "json_schema",
    name: "status",
    strict: true,
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.text, '{"ok":true}');
});

test("AI provider detailed request forwards context management and round-trips compaction items", async (t) => {
  const fake = await startFakeResponsesProvider();
  t.after(() => fake.close());
  const localProfile = { ...profile, baseUrl: fake.baseUrl, apiKey: fake.apiKey };
  const first = await requestAiProviderRequest({
    profile: localProfile,
    input: {
      prompt: "start a long conversation",
      contextManagement: [{ type: "compaction", compactThreshold: 1000 }],
      previousResponseId: "resp_previous_1",
      store: false,
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.responseId, "resp_compaction_1");
  assert.deepEqual(fake.requests[0].body.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
  assert.equal(fake.requests[0].body.previous_response_id, "resp_previous_1");
  assert.equal(fake.requests[0].body.store, false);
  const compaction = first.outputItems.find((item) => item.type === "compaction");
  assert.deepEqual(compaction, {
    type: "compaction",
    id: "item_compaction_1",
    encrypted_content: "opaque-fake-encrypted-context",
  });

  const replay = await requestAiProviderRequest({
    profile: localProfile,
    input: {
      input: first.outputItems,
      contextManagement: [{ type: "compaction" }],
    },
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(fake.requests[1].body.input.find((item) => item.type === "compaction"), compaction);

  const stream = await requestAiProviderRequest({
    profile: localProfile,
    input: {
      prompt: "stream compaction",
      stream: true,
      contextManagement: [{ type: "compaction", compactThreshold: 1000 }],
    },
  });
  assert.equal(stream.ok, true);
  assert.equal(stream.outputItems.some((item) => item.type === "compaction"), true);
});

test("AI provider Agent continuation keeps compaction items in stateless input", async () => {
  const requests = [];
  const result = await requestAiProviderAgentTest({
    profile,
    input: {
      prompt: "call the tool and continue",
      contextManagement: [{ type: "compaction", compactThreshold: 1000 }],
      maxRounds: 2,
      maxToolCalls: 1,
      tools: [{
        name: "get_value",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        mockResult: { value: 7 },
      }],
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: "resp_agent_compaction_1",
          status: "completed",
          output: [
            { type: "compaction", id: "item_agent_compaction", encrypted_content: "opaque-agent-context" },
            { type: "function_call", id: "fc_agent_1", call_id: "call_agent_1", name: "get_value", arguments: "{}" },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "resp_agent_done", output_text: "完成：7" }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests[1].input.find((item) => item.type === "compaction"), {
    type: "compaction",
    id: "item_agent_compaction",
    encrypted_content: "opaque-agent-context",
  });
  assert.equal(result.responses[0].outputItems[0].type, "compaction");
});

test("AI provider agent test returns fixed tool results through a bounded loop", async () => {
  const requests = [];
  const result = await requestAiProviderAgentTest({
    profile,
    input: {
      prompt: "use get_value, then answer",
      maxRounds: 3,
      maxToolCalls: 2,
      tools: [{
        name: "get_value",
        parameters: { type: "object", properties: {} },
        mockResult: { value: 42 },
      }],
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "get_value", arguments: "{}" }],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        output_text: "The value is 42.",
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      }), { status: 200 });
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].tool_choice, "auto");
  assert.equal(Object.hasOwn(requests[0].tools[0], "mockResult"), false);
  assert.ok(Array.isArray(requests[1].input));
  assert.deepEqual(requests[1].input.at(-1), {
    type: "function_call_output",
    call_id: "call_1",
    output: '{"value":42}',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "agent");
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls[0].name, "get_value");
  assert.deepEqual(result.toolCalls[0].result, { value: 42 });
  assert.equal(result.text, "The value is 42.");
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 6, totalTokens: 17 });
});

test("AI provider plugin page exposes bounded request, Agent, suite, and history controls", async () => {
  const [html, app, styles] = await Promise.all([
    fs.readFile(path.join(root, "public", "index.html"), "utf8"),
    fs.readFile(path.join(root, "public", "app.js"), "utf8"),
    fs.readFile(path.join(root, "public", "styles.css"), "utf8"),
  ]);
  for (const id of [
    "aiProviderTestModeInput",
    "aiProviderTestModeHint",
    "aiProviderTestProviderInput",
    "aiProviderTestModelInput",
    "aiProviderTestModelsButton",
    "aiProviderTestMaxOutputInput",
    "aiProviderTestContextManagementInput",
    "aiProviderTestCompactThresholdInput",
    "aiProviderTestPreviousResponseIdInput",
    "aiProviderTestMaxRoundsInput",
    "aiProviderTestMaxToolCallsInput",
    "aiProviderTestReasoningInput",
    "aiProviderTestSaveButton",
    "aiProviderTestJsonSchemaInput",
    "aiProviderTestInputItemsInput",
    "aiProviderTestToolsInput",
    "aiProviderTestSuiteCasesInput",
    "aiProviderTestResult",
    "aiProviderTestHistory",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const endpoint of ["/models", "/request", "/agent-test", "/suite"]) assert.match(app, new RegExp(endpoint.replace("/", "\\/")));
  assert.match(app, /AI_PROVIDER_TEST_HISTORY_TTL_MS/);
  assert.match(styles, /\.ai-provider-test-grid/);
  assert.match(styles, /\.ai-provider-test-ai-note/);
  assert.match(styles, /\.ai-provider-test-history-item/);
  assert.match(html, /MCP 会同时暴露供应商列表、模型读取、基础测试、详细 Responses 请求、context_management\/compaction、Agent 工具循环和固定测试套件/);
  assert.match(html, /不是固定长度/);
  assert.match(html, /aiProviderTestMaxOutputInput[^>]*min="1"/);
  assert.doesNotMatch(html, /aiProviderTestMaxOutputInput[^>]*max="4096"/);
  assert.match(html, /aiProviderTestMaxRoundsInput/);
  assert.match(html, /aiProviderTestMaxToolCallsInput/);
  assert.match(html, /context_management/);
  assert.match(html, /compaction output item/);
  assert.match(app, /AI_PROVIDER_TEST_CONFIG_KEY/);
  assert.match(app, /incompleteDetails/);
});

test("AI provider test sockets are isolated per user and authorization is checked at call time", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ai-provider-isolation-"));
  const makeService = (userId) => new AiProviderTestToolService({
    directory,
    userId,
    capabilities: () => ({ enabled: true }),
    list: async () => [{ id: userId, name: userId, model: "fake-model", hasApiKey: true }],
    test: async () => ({ ok: true, text: userId }),
  });
  const first = makeService("user-a");
  const second = makeService("user-b");
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await first.start();
  await second.start();
  assert.notEqual(first.socketPath, second.socketPath);
  assert.notEqual(path.dirname(first.socketPath), path.dirname(second.socketPath));
  assert.equal((await fs.stat(path.dirname(first.socketPath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(second.socketPath))).mode & 0o777, 0o700);
  assert.deepEqual(await socketRequest(first.socketPath, { version: 1, action: "list" }), [
    { id: "user-a", name: "user-a", model: "fake-model", hasApiKey: true },
  ]);
  assert.deepEqual(await socketRequest(second.socketPath, { version: 1, action: "list" }), [
    { id: "user-b", name: "user-b", model: "fake-model", hasApiKey: true },
  ]);
});

test("AI provider socket paths stay within Linux Unix socket limits at the deployed root", () => {
  const service = new AiProviderTestToolService({
    directory: path.join(root, ".codex-runtime", "ai-provider-test-tools"),
    userId: "u-production-root-check",
    capabilities: () => ({ enabled: true }),
    list: async () => [],
    test: async () => ({ ok: true }),
  });
  assert.ok(Buffer.byteLength(service.socketPath) <= 107, service.socketPath);
});

test("AI provider MCP exposes only authorized tools over a private socket", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ai-provider-test-"));
  let enabled = true;
  const service = new AiProviderTestToolService({
    directory,
    userId: "u-ai-test",
    capabilities: () => ({ enabled }),
    list: async () => [{ id: profile.id, name: profile.name, model: profile.model, hasApiKey: true }],
    test: async (input) => ({
      providerId: profile.id,
      providerName: profile.name,
      model: input.model || profile.model,
      httpStatus: 200,
      latencyMs: 12,
      ok: true,
      text: "真实测试成功",
    }),
    request: async () => ({
      providerId: profile.id,
      providerName: profile.name,
      model: profile.model,
      httpStatus: 200,
      latencyMs: 9,
      ok: true,
      text: "详细请求成功",
    }),
    agentTest: async () => ({
      providerId: profile.id,
      providerName: profile.name,
      model: profile.model,
      httpStatus: 200,
      latencyMs: 18,
      ok: true,
      mode: "agent",
      rounds: 2,
      toolCalls: [{ name: "get_value", ok: true }],
      text: "Agent 测试成功",
    }),
    models: async () => ({
      providerId: profile.id,
      providerName: profile.name,
      configuredModel: profile.model,
      models: ["fake-model"],
    }),
    suite: async () => ({
      providerId: profile.id,
      providerName: profile.name,
      model: profile.model,
      ok: true,
      mode: "suite",
      cases: [{ name: "text", ok: true }],
      requestCount: 1,
      maxRequests: 7,
    }),
  });
  let child;
  try {
    await service.start();
    const stat = await fs.lstat(service.socketPath);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    child = spawn(process.execPath, [
      path.join(root, "scripts", "ai-provider-test-mcp.mjs"),
      "--socket",
      service.socketPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const rpc = mcpClient(child);
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "wfl-ai-provider-real-test");
    const listed = await rpc.request("tools/list", {});
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      "ai_provider_list",
      "ai_provider_test",
      "ai_provider_request",
      "ai_provider_models",
      "ai_provider_agent_test",
      "ai_provider_run_suite",
    ]);
    const requestTool = listed.tools.find((tool) => tool.name === "ai_provider_request");
    assert.deepEqual(requestTool.inputSchema.properties.reasoningEffort.enum, [
      "none", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    assert.match(requestTool.inputSchema.properties.maxOutputTokens.description, /不是保证输出长度/);
    assert.equal(Object.hasOwn(requestTool.inputSchema.properties.maxOutputTokens, "maximum"), false);
    assert.equal(requestTool.inputSchema.properties.contextManagement.items.properties.type.enum[0], "compaction");
    assert.equal(requestTool.inputSchema.properties.contextManagement.items.properties.compactThreshold.minimum, 1000);
    assert.equal(requestTool.inputSchema.properties.previousResponseId.type, "string");
    assert.match(JSON.stringify(requestTool.inputSchema.properties.input), /encrypted_content/);
    const agentTool = listed.tools.find((tool) => tool.name === "ai_provider_agent_test");
    assert.equal(agentTool.inputSchema.properties.maxRounds.maximum, 16);
    assert.equal(agentTool.inputSchema.properties.maxToolCalls.maximum, 64);
    const providers = await rpc.request("tools/call", { name: "ai_provider_list", arguments: {} });
    assert.equal(providers.isError, false);
    assert.equal(providers.structuredContent.providers[0].id, profile.id);
    const tested = await rpc.request("tools/call", {
      name: "ai_provider_test",
      arguments: { prompt: "hello", maxOutputTokens: 64 },
    });
    assert.equal(tested.isError, false);
    assert.match(tested.content[0].text, /真实测试成功/);
    const detailed = await rpc.request("tools/call", {
      name: "ai_provider_request",
      arguments: { prompt: "详细请求" },
    });
    assert.equal(detailed.isError, false);
    assert.match(detailed.content[0].text, /详细请求成功/);
    const models = await rpc.request("tools/call", {
      name: "ai_provider_models",
      arguments: {},
    });
    assert.equal(models.isError, false);
    assert.deepEqual(models.structuredContent.models, ["fake-model"]);
    const agent = await rpc.request("tools/call", {
      name: "ai_provider_agent_test",
      arguments: { prompt: "Agent 测试" },
    });
    assert.equal(agent.isError, false);
    assert.equal(agent.structuredContent.mode, "agent");
    const suite = await rpc.request("tools/call", {
      name: "ai_provider_run_suite",
      arguments: { cases: ["text"] },
    });
    assert.equal(suite.isError, false);
    assert.equal(suite.structuredContent.mode, "suite");

    enabled = false;
    const disabled = await rpc.request("tools/list", {});
    assert.deepEqual(disabled.tools, []);
    const rejected = await rpc.request("tools/call", {
      name: "ai_provider_test",
      arguments: { prompt: "must be rejected" },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /未安装、启用或授权/);
    rpc.close();
  } finally {
    child?.kill("SIGTERM");
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function mcpClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      if (!Object.hasOwn(message, "id")) continue;
      const request = pending.get(String(message.id));
      if (!request) continue;
      pending.delete(String(message.id));
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  child.on("exit", () => {
    for (const request of pending.values()) request.reject(new Error("MCP child exited"));
    pending.clear();
  });
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
  };
}

function socketRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) finish(new Error(response.error || "socket request failed"));
        else finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}
