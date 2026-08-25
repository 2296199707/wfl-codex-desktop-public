import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const AI_PROVIDER_TEST_LIMITS = Object.freeze({
  maxPromptCharacters: 32_000,
  defaultOutputTokens: 512,
  timeoutMs: 60_000,
  // A compaction output item is opaque encrypted context and can be roughly
  // 20 MB according to the Responses API documentation. Keep the transport
  // limit above that size while retaining the smaller human-readable result
  // limit below.
  maxResponseBytes: 32 * 1024 * 1024,
  maxResultCharacters: 128 * 1024,
  maxCompactionCharacters: 32 * 1024 * 1024,
  maxTools: 32,
  maxToolCalls: 64,
  maxAgentRounds: 16,
  maxSuiteCases: 6,
  maxSuiteRequests: 7,
  maxInputItems: 64,
  maxInputCharacters: 32 * 1024 * 1024,
  maxStreamEvents: 4_096,
  maxToolSchemaCharacters: 32_000,
  maxToolResultCharacters: 32_000,
});

export const AI_PROVIDER_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESPONSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_LIMIT_BYTES = AI_PROVIDER_TEST_LIMITS.maxInputCharacters + 256 * 1024;
const RESPONSE_LIMIT_BYTES = AI_PROVIDER_TEST_LIMITS.maxResponseBytes + 256 * 1024;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const SOCKET_TIMEOUT_MS = AI_PROVIDER_TEST_LIMITS.timeoutMs
  * Math.max(AI_PROVIDER_TEST_LIMITS.maxAgentRounds, AI_PROVIDER_TEST_LIMITS.maxSuiteRequests)
  + 20_000;

export class AiProviderTestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "AiProviderTestError";
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = message;
  }
}

export function normalizeAiProviderTestInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_INPUT", "AI 真实测试参数无效");
  }
  const allowed = new Set([
    "providerId",
    "model",
    "prompt",
    "maxOutputTokens",
    "reasoningEffort",
    "contextManagement",
    "previousResponseId",
    "store",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_INPUT", "AI 真实测试参数包含未知字段");
  }
  const providerId = value.providerId == null ? null : String(value.providerId).trim();
  if (providerId !== null && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_INPUT", "供应商 ID 格式不正确");
  }
  const model = value.model == null ? null : String(value.model).trim();
  if (model !== null && model && !MODEL_ID_PATTERN.test(model)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_INPUT", "模型 ID 格式不正确");
  }
  if (typeof value.prompt !== "string") {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_INPUT", "测试提示词必须是文本");
  }
  const prompt = value.prompt.trim();
  if (!prompt || prompt.length > AI_PROVIDER_TEST_LIMITS.maxPromptCharacters) {
    throw new AiProviderTestError(
      400,
      "INVALID_AI_PROVIDER_TEST_INPUT",
      `测试提示词必须为 1-${AI_PROVIDER_TEST_LIMITS.maxPromptCharacters} 个字符`,
    );
  }
  const maxOutputTokens = value.maxOutputTokens == null
    ? AI_PROVIDER_TEST_LIMITS.defaultOutputTokens
    : Number(value.maxOutputTokens);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new AiProviderTestError(
      400,
      "INVALID_AI_PROVIDER_TEST_INPUT",
      "最大输出 Token 数必须为正整数；具体可用范围由供应商和模型决定",
    );
  }
  return {
    providerId,
    model: model || null,
    prompt,
    maxOutputTokens,
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort, "INVALID_AI_PROVIDER_TEST_INPUT"),
    contextManagement: normalizeContextManagement(value.contextManagement, "INVALID_AI_PROVIDER_TEST_INPUT"),
    previousResponseId: normalizePreviousResponseId(value.previousResponseId, "INVALID_AI_PROVIDER_TEST_INPUT"),
    store: normalizeStore(value.store, "INVALID_AI_PROVIDER_TEST_INPUT"),
  };
}

export function normalizeAiProviderRequestInput(value = {}) {
  const base = normalizeCommonInput(value, new Set([
    "providerId",
    "model",
    "prompt",
    "input",
    "maxOutputTokens",
    "reasoningEffort",
    "tools",
    "toolChoice",
    "jsonSchema",
    "stream",
    "contextManagement",
    "previousResponseId",
    "store",
  ]), "AI_PROVIDER_REQUEST", { requirePrompt: false });
  const rawInput = Object.hasOwn(value, "input") ? value.input : value.prompt;
  if (rawInput == null) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "详细请求必须提供 prompt 或 input");
  }
  return {
    ...base,
    input: normalizeResponsesInput(rawInput),
    tools: normalizeFunctionTools(value.tools, { allowMock: false }),
    toolChoice: normalizeToolChoice(value.toolChoice),
    jsonSchema: normalizeJsonSchema(value.jsonSchema),
    stream: value.stream === true,
    contextManagement: normalizeContextManagement(value.contextManagement, "INVALID_AI_PROVIDER_REQUEST_INPUT"),
    previousResponseId: normalizePreviousResponseId(value.previousResponseId, "INVALID_AI_PROVIDER_REQUEST_INPUT"),
    store: normalizeStore(value.store, "INVALID_AI_PROVIDER_REQUEST_INPUT"),
  };
}

export function normalizeAiProviderAgentTestInput(value = {}) {
  const base = normalizeCommonInput(value, new Set([
    "providerId",
    "model",
    "prompt",
    "maxOutputTokens",
    "reasoningEffort",
    "tools",
    "maxRounds",
    "maxToolCalls",
    "contextManagement",
    "previousResponseId",
    "store",
  ]), "AI_PROVIDER_AGENT_TEST");
  const maxRounds = boundedInteger(
    value.maxRounds,
    1,
    AI_PROVIDER_TEST_LIMITS.maxAgentRounds,
    AI_PROVIDER_TEST_LIMITS.maxAgentRounds,
    "最大工具轮数",
  );
  const maxToolCalls = boundedInteger(
    value.maxToolCalls,
    1,
    AI_PROVIDER_TEST_LIMITS.maxToolCalls,
    AI_PROVIDER_TEST_LIMITS.maxToolCalls,
    "最大工具调用次数",
  );
  return {
    ...base,
    tools: normalizeFunctionTools(value.tools, { allowMock: true }),
    maxRounds,
    maxToolCalls,
    contextManagement: normalizeContextManagement(value.contextManagement, "INVALID_AI_PROVIDER_AGENT_TEST_INPUT"),
    previousResponseId: normalizePreviousResponseId(value.previousResponseId, "INVALID_AI_PROVIDER_AGENT_TEST_INPUT"),
    store: normalizeStore(value.store, "INVALID_AI_PROVIDER_AGENT_TEST_INPUT"),
  };
}

export function normalizeAiProviderModelsInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_MODELS_INPUT", "模型查询参数无效");
  }
  if (Object.keys(value).some((key) => key !== "providerId")) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_MODELS_INPUT", "模型查询参数包含未知字段");
  }
  const providerId = value.providerId == null ? null : String(value.providerId).trim();
  if (providerId !== null && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_MODELS_INPUT", "供应商 ID 格式不正确");
  }
  return { providerId: providerId || null };
}

export function normalizeAiProviderSuiteInput(value = {}) {
  const base = normalizeCommonInput(value, new Set([
    "providerId",
    "model",
    "maxOutputTokens",
    "reasoningEffort",
    "cases",
    "contextManagement",
    "previousResponseId",
    "store",
  ]), "AI_PROVIDER_SUITE", { requirePrompt: false });
  const cases = value.cases == null
    ? ["text", "stream", "structured", "tool_call", "tool_result", "error"]
    : value.cases;
  const allowedCases = new Set(["text", "stream", "structured", "tool_call", "tool_result", "error"]);
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > AI_PROVIDER_TEST_LIMITS.maxSuiteCases) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_SUITE_INPUT", `测试套件必须包含 1-${AI_PROVIDER_TEST_LIMITS.maxSuiteCases} 项`);
  }
  if (new Set(cases).size !== cases.length || cases.some((name) => !allowedCases.has(name))) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_SUITE_INPUT", "测试套件项目无效或重复");
  }
  const requestCount = cases.reduce((total, name) => total + (name === "tool_result" ? 2 : 1), 0);
  if (requestCount > AI_PROVIDER_TEST_LIMITS.maxSuiteRequests) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_SUITE_INPUT", `测试套件最多发起 ${AI_PROVIDER_TEST_LIMITS.maxSuiteRequests} 次请求`);
  }
  return {
    ...base,
    cases,
    contextManagement: normalizeContextManagement(value.contextManagement, "INVALID_AI_PROVIDER_SUITE_INPUT"),
    previousResponseId: normalizePreviousResponseId(value.previousResponseId, "INVALID_AI_PROVIDER_SUITE_INPUT"),
    store: normalizeStore(value.store, "INVALID_AI_PROVIDER_SUITE_INPUT"),
  };
}

export async function requestAiProviderTest({
  profile,
  input,
  fetchImpl = fetch,
  timeoutMs = AI_PROVIDER_TEST_LIMITS.timeoutMs,
} = {}) {
  const normalized = normalizeAiProviderTestInput(input);
  return stripInternalResponse(await requestResponsesOnce({
    profile,
    model: normalized.model,
    requestInput: normalized.prompt,
    maxOutputTokens: normalized.maxOutputTokens,
    reasoningEffort: normalized.reasoningEffort,
    contextManagement: normalized.contextManagement,
    previousResponseId: normalized.previousResponseId,
    store: normalized.store,
    fetchImpl,
    timeoutMs,
    requireText: true,
  }));
}

export async function requestAiProviderRequest({
  profile,
  input,
  fetchImpl = fetch,
  timeoutMs = AI_PROVIDER_TEST_LIMITS.timeoutMs,
} = {}) {
  const normalized = normalizeAiProviderRequestInput(input);
  return stripInternalResponse(await requestResponsesOnce({
    profile,
    model: normalized.model,
    requestInput: normalized.input,
    maxOutputTokens: normalized.maxOutputTokens,
    reasoningEffort: normalized.reasoningEffort,
    tools: normalized.tools,
    toolChoice: normalized.toolChoice,
    jsonSchema: normalized.jsonSchema,
    stream: normalized.stream,
    contextManagement: normalized.contextManagement,
    previousResponseId: normalized.previousResponseId,
    store: normalized.store,
    fetchImpl,
    timeoutMs,
    requireText: false,
  }));
}

export async function requestAiProviderAgentTest({
  profile,
  input,
  fetchImpl = fetch,
  timeoutMs = AI_PROVIDER_TEST_LIMITS.timeoutMs,
} = {}) {
  const normalized = normalizeAiProviderAgentTestInput(input);
  assertProviderProfile(profile);
  const model = normalized.model || profile.model;
  assertModel(model);
  const requestTools = normalized.tools.map(stripMockToolFields);
  const toolByName = new Map(normalized.tools.map((tool) => [tool.name, tool]));
  const startedAt = Date.now();
  const responses = [];
  const toolCalls = [];
  let totalUsage = null;
  let requestInput = normalized.prompt;
  let continuationInput = null;
  let previousResponseId = normalized.previousResponseId;
  let lastResponse = null;

  for (let round = 1; round <= normalized.maxRounds; round += 1) {
    const result = await requestResponsesOnce({
      profile,
      model,
      requestInput,
      maxOutputTokens: normalized.maxOutputTokens,
      reasoningEffort: normalized.reasoningEffort,
      tools: requestTools,
      toolChoice: requestTools.length ? "auto" : null,
      contextManagement: normalized.contextManagement,
      previousResponseId,
      store: normalized.store,
      fetchImpl,
      timeoutMs,
      requireText: false,
    });
    lastResponse = result;
    totalUsage = addUsage(totalUsage, result.usage);
    responses.push({
      round,
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      requestId: result.requestId,
      status: result.status || null,
      ok: result.ok,
      ...(result.responseId ? { responseId: result.responseId } : {}),
      text: result.text || null,
      maxOutputTokens: result.maxOutputTokens ?? normalized.maxOutputTokens,
      ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.incompleteDetails ? { incompleteDetails: result.incompleteDetails } : {}),
      toolCalls: result.toolCalls || [],
      ...(Array.isArray(result.outputItems) && result.outputItems.length
        ? { outputItems: result.outputItems }
        : {}),
      usage: result.usage,
      ...(result.error ? { error: result.error } : {}),
    });
    if (!result.ok) {
      return agentResult(profile, model, {
        lastResponse,
        totalUsage,
        startedAt,
        responses,
        toolCalls,
        error: result.error || "供应商 Agent 测试失败",
      });
    }
    if (!result.toolCalls?.length) {
      return agentResult(profile, model, {
        lastResponse,
        totalUsage,
        startedAt,
        responses,
        toolCalls,
      });
    }

    const toolOutputs = [];
    for (const call of result.toolCalls) {
      if (toolCalls.length >= normalized.maxToolCalls) {
        return agentResult(profile, model, {
          lastResponse,
          totalUsage,
          startedAt,
          responses,
          toolCalls,
          error: `已达到最大工具调用次数（${normalized.maxToolCalls}）`,
        });
      }
      const definition = toolByName.get(call.name);
      const execution = executeVirtualTool(definition, call.arguments);
      let output = JSON.stringify(execution.ok ? execution.result : { error: execution.error });
      output = redactSecret(output || "null", profile.apiKey);
      toolCalls.push({
        round,
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        ok: execution.ok,
        schemaValid: execution.schemaValid,
        ...(execution.ok ? { result: JSON.parse(output) } : { error: JSON.parse(output).error }),
      });
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output,
      });
    }
    if (round >= normalized.maxRounds) {
      return agentResult(profile, model, {
        lastResponse,
        totalUsage,
        startedAt,
        responses,
        toolCalls,
        error: `已达到最大工具轮数（${normalized.maxRounds}）`,
      });
    }
    // With previous_response_id the API already owns the preceding output;
    // send only the tool results. In stateless mode append the complete
    // output, including any opaque compaction item, as required by the API.
    if (previousResponseId && result.responseId) {
      requestInput = toolOutputs;
      previousResponseId = result.responseId;
    } else {
      continuationInput ||= [{
        role: "user",
        content: [{ type: "input_text", text: normalized.prompt }],
      }];
      continuationInput = [
        ...continuationInput,
        ...result.rawOutput,
        ...toolOutputs,
      ];
      requestInput = continuationInput;
      previousResponseId = null;
    }
  }

  return agentResult(profile, model, {
    lastResponse,
    totalUsage,
    startedAt,
    responses,
    toolCalls,
    error: "AI 供应商 Agent 测试未完成",
  });
}

export async function requestAiProviderRunSuite({
  profile,
  input,
  fetchImpl = fetch,
  timeoutMs = AI_PROVIDER_TEST_LIMITS.timeoutMs,
} = {}) {
  const normalized = normalizeAiProviderSuiteInput(input);
  assertProviderProfile(profile);
  const model = normalized.model || profile.model;
  assertModel(model);
  const suiteRequestOptions = {
    contextManagement: normalized.contextManagement,
    previousResponseId: normalized.previousResponseId,
    store: normalized.store,
  };
  const startedAt = Date.now();
  let requestCount = 0;
  let totalUsage = null;
  let lastResult = null;
  const cases = [];
  for (const name of normalized.cases) {
    const caseStartedAt = Date.now();
    let result = null;
    let ok = false;
    let error = null;
    try {
      if (name === "text") {
        requestCount += 1;
        result = await requestAiProviderRequest({
          profile,
          input: {
            model,
            ...suiteRequestOptions,
            prompt: "WFL suite text test: reply with a short success message.",
            maxOutputTokens: normalized.maxOutputTokens,
            reasoningEffort: normalized.reasoningEffort,
          },
          fetchImpl,
          timeoutMs,
        });
        ok = result.ok === true && Boolean(result.text);
      } else if (name === "stream") {
        requestCount += 1;
        result = await requestAiProviderRequest({
          profile,
          input: {
            model,
            ...suiteRequestOptions,
            prompt: "WFL suite stream test: reply with a short success message.",
            stream: true,
            maxOutputTokens: normalized.maxOutputTokens,
            reasoningEffort: normalized.reasoningEffort,
          },
          fetchImpl,
          timeoutMs,
        });
        ok = result.ok === true && result.streamed === true;
      } else if (name === "structured") {
        requestCount += 1;
        result = await requestAiProviderRequest({
          profile,
          input: {
            model,
            ...suiteRequestOptions,
            prompt: "WFL suite structured test: return JSON with ok=true.",
            maxOutputTokens: normalized.maxOutputTokens,
            reasoningEffort: normalized.reasoningEffort,
            jsonSchema: {
              name: "suite_output",
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
            },
          },
          fetchImpl,
          timeoutMs,
        });
        ok = result.ok === true && result.structuredValid === true;
      } else if (name === "tool_call") {
        requestCount += 1;
        result = await requestAiProviderRequest({
          profile,
          input: {
            model,
            ...suiteRequestOptions,
            prompt: "WFL suite tool test: call suite_lookup once.",
            maxOutputTokens: normalized.maxOutputTokens,
            reasoningEffort: normalized.reasoningEffort,
            tools: [{
              name: "suite_lookup",
              description: "returns a fixed suite value",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            }],
            toolChoice: "required",
          },
          fetchImpl,
          timeoutMs,
        });
        ok = result.ok === true && result.toolCalls?.length > 0;
      } else if (name === "tool_result") {
        requestCount += 2;
        result = await requestAiProviderAgentTest({
          profile,
          input: {
            model,
            ...suiteRequestOptions,
            prompt: "WFL suite tool result test: call suite_lookup and then report its value.",
            maxOutputTokens: normalized.maxOutputTokens,
            reasoningEffort: normalized.reasoningEffort,
            maxRounds: 2,
            maxToolCalls: 1,
            tools: [{
              name: "suite_lookup",
              builtin: "fixed",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              mockResult: { value: "suite-ok" },
            }],
          },
          fetchImpl,
          timeoutMs,
        });
        ok = result.ok === true && result.rounds >= 2 && result.toolCalls?.length > 0;
      } else if (name === "error") {
        requestCount += 1;
        result = await requestAiProviderRequest({
          profile,
          input: {
            model: "wfl-suite-invalid-model",
            ...suiteRequestOptions,
            prompt: "WFL suite expected error test.",
            maxOutputTokens: normalized.maxOutputTokens,
            reasoningEffort: normalized.reasoningEffort,
          },
          fetchImpl,
          timeoutMs,
        });
        ok = result.ok === false;
      }
    } catch (caught) {
      error = boundedErrorMessage(caught);
      ok = false;
    }
    lastResult = result || lastResult;
    totalUsage = addUsage(totalUsage, result?.usage);
    cases.push({
      name,
      ok,
      requestCount: name === "tool_result" ? 2 : 1,
      latencyMs: Math.max(0, Date.now() - caseStartedAt),
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    });
  }
  return {
    providerId: profile.id,
    providerName: redactSecret(String(profile.name || profile.id).slice(0, 64), profile.apiKey),
    model: redactSecret(model, profile.apiKey),
    httpStatus: Number.isInteger(lastResult?.httpStatus) ? lastResult.httpStatus : null,
    latencyMs: Math.max(0, Date.now() - startedAt),
    requestId: redactSecret(lastResult?.requestId || "", profile.apiKey) || null,
    usage: totalUsage,
    maxOutputTokens: normalized.maxOutputTokens,
    ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
    ...(lastResult?.status ? { status: lastResult.status } : {}),
    ...(lastResult?.truncated ? { truncated: true } : {}),
    ...(lastResult?.incompleteDetails ? { incompleteDetails: lastResult.incompleteDetails } : {}),
    ok: cases.every((entry) => entry.ok),
    mode: "suite",
    cases,
    requestCount,
    maxRequests: AI_PROVIDER_TEST_LIMITS.maxSuiteRequests,
  };
}

function parseJsonText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeCommonInput(value, allowed, codePrefix, { requirePrompt = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderTestError(400, `INVALID_${codePrefix}_INPUT`, "AI 供应商测试参数无效");
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AiProviderTestError(400, `INVALID_${codePrefix}_INPUT`, "AI 供应商测试参数包含未知字段");
  }
  const providerId = value.providerId == null ? null : String(value.providerId).trim();
  if (providerId !== null && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new AiProviderTestError(400, `INVALID_${codePrefix}_INPUT`, "供应商 ID 格式不正确");
  }
  const model = value.model == null ? null : String(value.model).trim();
  if (model !== null && model && !MODEL_ID_PATTERN.test(model)) {
    throw new AiProviderTestError(400, `INVALID_${codePrefix}_INPUT`, "模型 ID 格式不正确");
  }
  if (requirePrompt && typeof value.prompt !== "string") {
    throw new AiProviderTestError(400, `INVALID_${codePrefix}_INPUT`, "测试提示词必须是文本");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : null;
  if ((requirePrompt || prompt !== null) && (!prompt || prompt.length > AI_PROVIDER_TEST_LIMITS.maxPromptCharacters)) {
    throw new AiProviderTestError(
      400,
      `INVALID_${codePrefix}_INPUT`,
      `测试提示词必须为 1-${AI_PROVIDER_TEST_LIMITS.maxPromptCharacters} 个字符`,
    );
  }
  return {
    providerId,
    model: model || null,
    ...(prompt !== null ? { prompt } : {}),
    maxOutputTokens: normalizeOutputTokens(value.maxOutputTokens, `INVALID_${codePrefix}_INPUT`),
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort, `INVALID_${codePrefix}_INPUT`),
  };
}

function normalizeReasoningEffort(value, code) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !AI_PROVIDER_REASONING_EFFORTS.includes(value)) {
    throw new AiProviderTestError(
      400,
      code,
      `推理强度必须是 ${AI_PROVIDER_REASONING_EFFORTS.join("、")} 之一`,
    );
  }
  return value;
}

function normalizeContextManagement(value, code) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length < 1) {
    throw new AiProviderTestError(400, code, "contextManagement 必须是至少包含一项的数组");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AiProviderTestError(400, code, "contextManagement 项必须是对象");
    }
    const allowed = new Set(["type", "compactThreshold"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new AiProviderTestError(400, code, "contextManagement 项包含未知字段");
    }
    if (entry.type !== "compaction") {
      throw new AiProviderTestError(400, code, "当前 Responses API 只支持 compaction 类型");
    }
    const normalized = { type: "compaction" };
    if (entry.compactThreshold != null) {
      const threshold = Number(entry.compactThreshold);
      if (!Number.isSafeInteger(threshold) || threshold < 1_000) {
        throw new AiProviderTestError(400, code, "compactThreshold 必须是不小于 1000 的整数");
      }
      normalized.compactThreshold = threshold;
    }
    return normalized;
  });
}

function normalizePreviousResponseId(value, code) {
  if (value == null || value === "") return null;
  const id = String(value).trim();
  if (!RESPONSE_ID_PATTERN.test(id)) {
    throw new AiProviderTestError(400, code, "previousResponseId 格式不正确");
  }
  return id;
}

function normalizeStore(value, code) {
  if (value == null) return null;
  if (typeof value !== "boolean") {
    throw new AiProviderTestError(400, code, "store 必须是布尔值");
  }
  return value;
}

function boundedInteger(value, min, max, defaultValue, label, code = "INVALID_AI_PROVIDER_TEST_INPUT") {
  const number = value == null ? defaultValue : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AiProviderTestError(400, code, `${label}必须为 ${min}-${max} 的整数`);
  }
  return number;
}

function normalizeOutputTokens(value, code) {
  const number = value == null ? AI_PROVIDER_TEST_LIMITS.defaultOutputTokens : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AiProviderTestError(
      400,
      code,
      "最大输出 Token 数必须为正整数；具体可用范围由供应商和模型决定",
    );
  }
  return number;
}

function normalizeResponsesInput(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > AI_PROVIDER_TEST_LIMITS.maxPromptCharacters) {
      throw new AiProviderTestError(
        400,
        "INVALID_AI_PROVIDER_REQUEST_INPUT",
        `请求输入必须为 1-${AI_PROVIDER_TEST_LIMITS.maxPromptCharacters} 个字符`,
      );
    }
    return text;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > AI_PROVIDER_TEST_LIMITS.maxInputItems) {
    throw new AiProviderTestError(
      400,
      "INVALID_AI_PROVIDER_REQUEST_INPUT",
      `input 必须是文本或 1-${AI_PROVIDER_TEST_LIMITS.maxInputItems} 个输入项`,
    );
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input 无法序列化");
  }
  if (Buffer.byteLength(encoded || "", "utf8") > AI_PROVIDER_TEST_LIMITS.maxInputCharacters) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input 超过安全大小限制");
  }
  return value.map(normalizeResponsesInputItem);
}

function normalizeResponsesInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input 输入项必须是对象");
  }
  if (item.type === "compaction") {
    const id = String(item.id || "").trim();
    const encryptedContent = item.encrypted_content;
    if (
      (id && !RESPONSE_ID_PATTERN.test(id))
      || typeof encryptedContent !== "string"
      || !encryptedContent
      || Buffer.byteLength(encryptedContent, "utf8") > AI_PROVIDER_TEST_LIMITS.maxCompactionCharacters
    ) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "compaction 输入项无效或过大");
    }
    return {
      type: "compaction",
      ...(id ? { id } : {}),
      encrypted_content: encryptedContent,
    };
  }
  if (item.type === "function_call_output") {
    const callId = String(item.call_id || "").trim();
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null);
    if (!callId || callId.length > 128 || !output || output.length > AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "function_call_output 输入项无效");
    }
    return { type: "function_call_output", call_id: callId, output };
  }
  if (item.type === "function_call") {
    const callId = String(item.call_id || item.id || "").trim();
    const name = String(item.name || "").trim();
    const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
    if (!callId || callId.length > 128 || !TOOL_NAME_PATTERN.test(name) || args.length > AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "function_call 输入项无效");
    }
    return {
      type: "function_call",
      ...(item.id ? { id: String(item.id).slice(0, 128) } : {}),
      call_id: callId,
      name,
      arguments: args,
    };
  }
  const role = String(item.role || "").trim();
  if (!["user", "assistant", "system", "developer"].includes(role)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input role 无效");
  }
  const content = normalizeResponsesContent(item.content);
  return { role, content };
}

function normalizeResponsesContent(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > AI_PROVIDER_TEST_LIMITS.maxPromptCharacters) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input content 文本无效");
    }
    return text;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input content 必须是文本或内容数组");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input content 项无效");
    }
    const type = String(entry.type || "input_text").trim();
    if (!["input_text", "output_text", "text"].includes(type) || typeof entry.text !== "string") {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "当前只支持文本 content");
    }
    const text = entry.text.trim();
    if (!text || text.length > AI_PROVIDER_TEST_LIMITS.maxPromptCharacters) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "input content 文本无效");
    }
    return { type, text };
  });
}

function normalizeFunctionTools(value, { allowMock = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > AI_PROVIDER_TEST_LIMITS.maxTools) {
    throw new AiProviderTestError(
      400,
      allowMock ? "INVALID_AI_PROVIDER_AGENT_TEST_INPUT" : "INVALID_AI_PROVIDER_REQUEST_INPUT",
      `工具数量必须为 0-${AI_PROVIDER_TEST_LIMITS.maxTools} 个`,
    );
  }
  const names = new Set();
  return value.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "工具定义必须是对象");
    }
    const allowed = new Set(["type", "name", "description", "parameters", "strict"]);
    if (allowMock) {
      allowed.add("mockResult");
      allowed.add("mockError");
      allowed.add("builtin");
    }
    if (Object.keys(tool).some((key) => !allowed.has(key))) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "工具定义包含未知字段");
    }
    if (tool.type != null && tool.type !== "function") {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "当前只支持 function 工具");
    }
    const name = String(tool.name || "").trim();
    if (!TOOL_NAME_PATTERN.test(name) || names.has(name)) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "工具名称无效或重复");
    }
    names.add(name);
    const description = tool.description == null ? "" : String(tool.description).trim();
    if (description.length > 1_000) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "工具描述过长");
    }
    const parameters = tool.parameters == null
      ? { type: "object", properties: {}, additionalProperties: false }
      : tool.parameters;
    assertJsonObject(parameters, "工具参数 Schema 必须是对象");
    assertJsonSize(parameters, "工具参数 Schema");
    const normalized = {
      type: "function",
      name,
      ...(description ? { description } : {}),
      parameters,
      strict: tool.strict !== false,
    };
    if (allowMock) {
      const builtin = tool.builtin == null ? "fixed" : String(tool.builtin).trim();
      if (!["fixed", "calculator", "query", "failure"].includes(builtin)) {
        throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "内置虚拟工具类型无效");
      }
      normalized.builtin = builtin;
      if (Object.hasOwn(tool, "mockError")) {
        const mockError = String(tool.mockError || "").trim();
        if (!mockError || mockError.length > AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters) {
          throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", "工具模拟错误信息无效");
        }
        normalized.mockError = mockError;
      }
      if (Object.hasOwn(tool, "mockResult")) {
        assertJsonSize(tool.mockResult, "工具模拟结果", AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters);
        normalized.mockResult = tool.mockResult;
      }
    }
    return normalized;
  });
}

function normalizeToolChoice(value) {
  if (value == null || value === "") return null;
  if (!["auto", "required", "none"].includes(value)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "工具选择必须是 auto、required 或 none");
  }
  return value;
}

function normalizeJsonSchema(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "结构化输出 Schema 必须是对象");
  }
  const allowed = new Set(["name", "schema", "strict"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "结构化输出 Schema 包含未知字段");
  }
  const name = String(value.name || "output").trim();
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_REQUEST_INPUT", "结构化输出名称无效");
  }
  assertJsonObject(value.schema, "结构化输出 Schema 必须是对象");
  assertJsonSize(value.schema, "结构化输出 Schema");
  return { name, schema: value.schema, strict: value.strict !== false };
}

function assertJsonObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", message);
  }
}

function assertJsonSize(value, label, limit = AI_PROVIDER_TEST_LIMITS.maxToolSchemaCharacters) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", `${label}无法序列化`);
  }
  if (Buffer.byteLength(encoded || "", "utf8") > limit) {
    throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TOOL", `${label}超过安全大小限制`);
  }
}

function stripMockToolFields(tool) {
  const {
    mockResult: _mockResult,
    mockError: _mockError,
    builtin: _builtin,
    ...requestTool
  } = tool;
  return requestTool;
}

function assertModel(model) {
  if (!model || !MODEL_ID_PATTERN.test(model)) {
    throw new AiProviderTestError(400, "AI_PROVIDER_MODEL_REQUIRED", "请先配置有效的供应商模型 ID");
  }
}

async function requestResponsesOnce({
  profile,
  model: requestedModel,
  requestInput,
  maxOutputTokens,
  reasoningEffort = null,
  tools = [],
  toolChoice = null,
  jsonSchema = null,
  stream = false,
  contextManagement = null,
  previousResponseId = null,
  store = null,
  fetchImpl = fetch,
  timeoutMs = AI_PROVIDER_TEST_LIMITS.timeoutMs,
  requireText = false,
} = {}) {
  assertProviderProfile(profile);
  const model = requestedModel || profile.model;
  assertModel(model);
  const endpoint = responsesEndpoint(profile.baseUrl);
  const body = {
    model,
    input: requestInput,
    max_output_tokens: maxOutputTokens,
  };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  if (stream) body.stream = true;
  if (Array.isArray(contextManagement) && contextManagement.length) {
    body.context_management = contextManagement.map((entry) => ({
      type: entry.type,
      ...(Number.isSafeInteger(entry.compactThreshold)
        ? { compact_threshold: entry.compactThreshold }
        : {}),
    }));
  }
  if (previousResponseId) body.previous_response_id = previousResponseId;
  if (typeof store === "boolean") body.store = store;
  if (tools.length) body.tools = tools;
  if (toolChoice && tools.length) body.tool_choice = toolChoice;
  if (jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: jsonSchema.name,
        strict: jsonSchema.strict,
        schema: jsonSchema.schema,
      },
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || AI_PROVIDER_TEST_LIMITS.timeoutMs));
  const startedAt = Date.now();
  try {
    const headers = {
      Accept: stream ? "text/event-stream" : "application/json",
      "Content-Type": "application/json",
    };
    if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new AiProviderTestError(504, "AI_PROVIDER_TEST_TIMEOUT", "供应商真实测试超时，请稍后重试");
      }
      throw new AiProviderTestError(502, "AI_PROVIDER_UNREACHABLE", "无法连接 AI 供应商，请检查地址和网络");
    }
    let raw = null;
    let streamed = null;
    let streamProtocolInvalid = false;
    try {
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
      if (stream && response.ok && contentType.includes("text/event-stream")) {
        streamed = await readResponsesStream(response, AI_PROVIDER_TEST_LIMITS.maxResponseBytes);
      } else {
        streamProtocolInvalid = stream && response.ok;
        raw = await readBoundedBody(response, AI_PROVIDER_TEST_LIMITS.maxResponseBytes);
      }
    } catch (error) {
      if (error instanceof AiProviderTestError) throw error;
      throw new AiProviderTestError(502, "AI_PROVIDER_RESPONSE_INVALID", "供应商响应无法读取");
    }
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const requestId = safeRequestId(response.headers?.get?.("x-request-id"));
    if (streamProtocolInvalid) {
      return resultWithRawOutput(resultBase(profile, model, response.status, latencyMs, requestId, {
        ok: false,
        error: "供应商没有返回 Responses SSE 流",
        maxOutputTokens,
      }), []);
    }
    let payload = streamed?.payload || {};
    try {
      if (!streamed) payload = raw ? JSON.parse(raw) : {};
    } catch {
      return resultWithRawOutput(resultBase(profile, model, response.status, latencyMs, requestId, {
        ok: false,
        error: "供应商返回了无效 JSON 响应",
        maxOutputTokens,
      }), []);
    }
    if (!response.ok) {
      return resultWithRawOutput(resultBase(profile, model, response.status, latencyMs, requestId, {
        ok: false,
        error: upstreamStatusMessage(response.status),
        usage: normalizeUsage(payload?.usage),
        maxOutputTokens,
      }), []);
    }
    const output = Array.isArray(streamed?.outputOverride)
      ? streamed.outputOverride
      : Array.isArray(payload?.output) ? payload.output : [];
    const text = redactSecret(streamed?.textOverride ?? extractResponseText(payload), profile.apiKey);
    const toolCalls = extractFunctionCalls(output, profile.apiKey);
    const status = typeof payload?.status === "string" ? payload.status.slice(0, 64) : null;
    const statusLower = String(status || "").toLowerCase();
    const incompleteDetails = normalizeIncompleteDetails(payload?.incomplete_details, profile.apiKey);
    const failed = ["failed", "cancelled", "canceled", "incomplete"].includes(statusLower)
      || Boolean(incompleteDetails);
    const truncated = text.length > AI_PROVIDER_TEST_LIMITS.maxResultCharacters
      || statusLower === "incomplete"
      || incompleteDetails?.reason === "max_output_tokens";
    let structuredValid = null;
    let structuredError = null;
    if (jsonSchema) {
      const parsed = parseJsonText(text);
      if (parsed === null) {
        structuredValid = false;
        structuredError = "供应商没有返回有效 JSON 结构化结果";
      } else {
        const schemaCheck = validateJsonSchema(jsonSchema.schema, parsed);
        structuredValid = schemaCheck.valid;
        if (!schemaCheck.valid) structuredError = `结构化结果不符合 Schema：${schemaCheck.error}`;
      }
    }
    const base = resultBase(profile, model, response.status, latencyMs, requestId, {
      ok: Boolean(!failed && (!requireText || text || toolCalls.length) && (!jsonSchema || structuredValid === true)),
      text: text.slice(0, AI_PROVIDER_TEST_LIMITS.maxResultCharacters),
      truncated,
      maxOutputTokens,
      responseId: responseIdFromPayload(payload),
      reasoningEffort,
      incompleteDetails,
      usage: normalizeUsage(payload?.usage),
      status,
      toolCalls,
      outputItems: normalizeOutputItems(output, profile.apiKey),
      ...(structuredValid !== null ? { structuredValid } : {}),
      ...(structuredError ? { error: structuredError } : {}),
      ...(failed && !structuredError ? {
        error: statusLower === "incomplete" || incompleteDetails ? "供应商响应未完整完成" : "供应商响应失败",
      } : {}),
      ...(requireText && !text && !toolCalls.length && !failed ? { error: "供应商响应中没有可读文本" } : {}),
      ...(stream ? { streamed: true, streamEvents: streamed?.eventCount || 0 } : {}),
    });
    return resultWithRawOutput(base, sanitizeContinuationOutput(output, profile.apiKey));
  } finally {
    clearTimeout(timer);
  }
}

function resultWithRawOutput(result, rawOutput) {
  return { ...result, rawOutput };
}

function executeVirtualTool(definition, args) {
  if (!definition) return { ok: false, schemaValid: false, error: "测试工具未配置" };
  const schemaCheck = validateJsonSchema(definition.parameters, args);
  if (!schemaCheck.valid) {
    return { ok: false, schemaValid: false, error: `工具参数 Schema 校验失败：${schemaCheck.error}` };
  }
  if (definition.mockError) {
    return { ok: false, schemaValid: true, error: definition.mockError };
  }
  if (definition.builtin === "failure") {
    return { ok: false, schemaValid: true, error: "这是一次预期的模拟工具失败" };
  }
  if (definition.builtin === "calculator") {
    try {
      return { ok: true, schemaValid: true, result: { value: calculateExpression(args?.expression) } };
    } catch (error) {
      return { ok: false, schemaValid: true, error: String(error.message || "计算表达式无效").slice(0, 500) };
    }
  }
  if (definition.builtin === "query") {
    const key = typeof args?.key === "string" ? args.key : "";
    const data = definition.mockResult;
    if (!data || typeof data !== "object" || Array.isArray(data) || !key || !Object.hasOwn(data, key)) {
      return { ok: false, schemaValid: true, error: "固定查询没有找到对应 key" };
    }
    return { ok: true, schemaValid: true, result: data[key] };
  }
  return {
    ok: true,
    schemaValid: true,
    result: Object.hasOwn(definition, "mockResult") ? definition.mockResult : { ok: true },
  };
}

function validateJsonSchema(schema, value, path = "$", depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 12) {
    return { valid: false, error: `${path} Schema 无效` };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameJsonValue(entry, value))) {
    return { valid: false, error: `${path} 不在 enum 范围内` };
  }
  if (Object.hasOwn(schema, "const") && !sameJsonValue(schema.const, value)) {
    return { valid: false, error: `${path} 不匹配 const` };
  }
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: `${path} 必须是 object` };
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key !== "string" || !Object.hasOwn(value, key)) return { valid: false, error: `${path}.${key} 必填` };
    }
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) return { valid: false, error: `${path}.${key} 不允许` };
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const result = validateJsonSchema(child, value[key], `${path}.${key}`, depth + 1);
      if (!result.valid) return result;
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return { valid: false, error: `${path} 必须是 array` };
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return { valid: false, error: `${path} 项数过少` };
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return { valid: false, error: `${path} 项数过多` };
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const result = validateJsonSchema(schema.items, value[index], `${path}[${index}]`, depth + 1);
        if (!result.valid) return result;
      }
    }
  } else if (type === "string") {
    if (typeof value !== "string") return { valid: false, error: `${path} 必须是 string` };
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return { valid: false, error: `${path} 太短` };
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return { valid: false, error: `${path} 太长` };
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isSafeInteger(value))) {
      return { valid: false, error: `${path} 必须是 ${type}` };
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return { valid: false, error: `${path} 小于 minimum` };
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return { valid: false, error: `${path} 大于 maximum` };
  } else if (type === "boolean" && typeof value !== "boolean") {
    return { valid: false, error: `${path} 必须是 boolean` };
  } else if (type === "null" && value !== null) {
    return { valid: false, error: `${path} 必须是 null` };
  }
  for (const branchKey of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[branchKey])) continue;
    const matches = schema[branchKey].filter((branch) => validateJsonSchema(branch, value, path, depth + 1).valid).length;
    if ((branchKey === "anyOf" && matches < 1) || (branchKey === "oneOf" && matches !== 1)) {
      return { valid: false, error: `${path} 不匹配 ${branchKey}` };
    }
  }
  return { valid: true, error: null };
}

function sameJsonValue(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function calculateExpression(expression) {
  const source = String(expression || "").trim();
  if (!source || source.length > 200) throw new Error("计算表达式长度无效");
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    const number = source.slice(cursor).match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
    if (number) {
      tokens.push(Number(number[0]));
      cursor += number[0].length;
      continue;
    }
    if (["+", "-", "*", "/", "(", ")"].includes(source[cursor])) {
      tokens.push(source[cursor]);
      cursor += 1;
      continue;
    }
    throw new Error("计算表达式包含不支持的字符");
  }
  let index = 0;
  const parseExpression = () => {
    let value = parseTerm();
    while (["+", "-"].includes(tokens[index])) {
      const operator = tokens[index++];
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (["*", "/"].includes(tokens[index])) {
      const operator = tokens[index++];
      const right = parseFactor();
      if (operator === "/" && right === 0) throw new Error("不能除以 0");
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  const parseFactor = () => {
    if (tokens[index] === "+") {
      index += 1;
      return parseFactor();
    }
    if (tokens[index] === "-") {
      index += 1;
      return -parseFactor();
    }
    if (tokens[index] === "(") {
      index += 1;
      const value = parseExpression();
      if (tokens[index++] !== ")") throw new Error("括号不匹配");
      return value;
    }
    const value = tokens[index++];
    if (typeof value !== "number") throw new Error("表达式不完整");
    return value;
  };
  const result = parseExpression();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error("计算表达式无效");
  return Number(result.toFixed(12));
}

function stripInternalResponse(result) {
  const { rawOutput: _rawOutput, ...publicResult } = result;
  return publicResult;
}

function agentResult(profile, model, {
  lastResponse,
  totalUsage,
  startedAt,
  responses,
  toolCalls,
  error = null,
}) {
  const result = resultBase(profile, model, lastResponse?.httpStatus, Math.max(0, Date.now() - startedAt), lastResponse?.requestId, {
    ok: !error && lastResponse?.ok === true,
    text: lastResponse?.text || "",
    truncated: lastResponse?.truncated === true,
    maxOutputTokens: lastResponse?.maxOutputTokens,
    reasoningEffort: lastResponse?.reasoningEffort,
    incompleteDetails: lastResponse?.incompleteDetails || null,
    usage: totalUsage,
    status: lastResponse?.status || null,
    ...(error ? { error } : {}),
  });
  return {
    ...result,
    mode: "agent",
    rounds: responses.length,
    toolCalls,
    responses,
  };
}

function addUsage(previous, next) {
  if (!previous && !next) return null;
  const result = { ...(previous || {}) };
  for (const [key, value] of Object.entries(next || {})) {
    if (Number.isSafeInteger(value) && value >= 0) result[key] = (result[key] || 0) + value;
  }
  return Object.keys(result).length ? result : null;
}

function extractFunctionCalls(output, secret) {
  return output
    .filter((item) => item?.type === "function_call")
    .slice(0, AI_PROVIDER_TEST_LIMITS.maxTools)
    .map((item, index) => {
      const callId = redactSecret(String(item.call_id || item.id || `call-${index + 1}`).slice(0, 128), secret);
      const name = redactSecret(String(item.name || "").slice(0, 64), secret);
      const encodedArguments = redactSecret(
        typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        secret,
      ).slice(0, AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters);
      let args = encodedArguments;
      try {
        args = JSON.parse(encodedArguments);
      } catch {
        // Keep malformed tool arguments visible as text for diagnostics.
      }
      return { callId, name, arguments: args };
    });
}

function normalizeOutputItems(output, secret) {
  return output.slice(0, AI_PROVIDER_TEST_LIMITS.maxTools * 4).map((item) => {
    const type = String(item?.type || "unknown").slice(0, 64);
    const normalized = { type };
    if (item?.id) {
      const idLimit = type === "compaction" ? 256 : 128;
      normalized.id = redactSecret(String(item.id).slice(0, idLimit), secret);
    }
    if (item?.role) normalized.role = String(item.role).slice(0, 32);
    if (type === "compaction" && typeof item?.encrypted_content === "string") {
      normalized.encrypted_content = redactSecret(item.encrypted_content, secret)
        .slice(0, AI_PROVIDER_TEST_LIMITS.maxCompactionCharacters);
    }
    if (type === "function_call") {
      normalized.callId = redactSecret(String(item.call_id || item.id || "").slice(0, 128), secret) || null;
      normalized.name = redactSecret(String(item.name || "").slice(0, 64), secret);
      normalized.arguments = redactSecret(
        typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        secret,
      ).slice(0, AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters);
    }
    if (Array.isArray(item?.content)) {
      normalized.content = item.content.slice(0, 16).map((content) => ({
        type: String(content?.type || "unknown").slice(0, 64),
        ...(typeof content?.text === "string"
          ? { text: redactSecret(content.text, secret).slice(0, AI_PROVIDER_TEST_LIMITS.maxResultCharacters) }
          : {}),
      }));
    }
    return normalized;
  });
}

function sanitizeContinuationOutput(output, secret) {
  return output.slice(0, AI_PROVIDER_TEST_LIMITS.maxTools * 4).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (item.type === "compaction" && typeof item.encrypted_content === "string") {
      return [{
        type: "compaction",
        ...(item.id ? { id: String(item.id).slice(0, 256) } : {}),
        encrypted_content: redactSecret(item.encrypted_content, secret)
          .slice(0, AI_PROVIDER_TEST_LIMITS.maxCompactionCharacters),
      }];
    }
    if (item.type === "function_call") {
      return [{
        type: "function_call",
        ...(item.id ? { id: String(item.id).slice(0, 128) } : {}),
        call_id: String(item.call_id || item.id || "").slice(0, 128),
        name: String(item.name || "").slice(0, 64),
        arguments: redactSecret(
          typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          secret,
        ).slice(0, AI_PROVIDER_TEST_LIMITS.maxToolResultCharacters),
      }];
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      return [{
        type: "message",
        ...(item.id ? { id: String(item.id).slice(0, 128) } : {}),
        role: String(item.role || "assistant").slice(0, 32),
        content: item.content.slice(0, 16).flatMap((content) => (
          typeof content?.text === "string"
            ? [{ type: String(content.type || "output_text").slice(0, 64), text: redactSecret(content.text, secret).slice(0, AI_PROVIDER_TEST_LIMITS.maxResultCharacters) }]
            : []
        )),
      }];
    }
    if (item.type === "reasoning") {
      return [{
        type: "reasoning",
        ...(item.id ? { id: String(item.id).slice(0, 128) } : {}),
        ...(Array.isArray(item.summary) ? {
          summary: item.summary.slice(0, 16).map((summary) => ({
            type: String(summary?.type || "summary_text").slice(0, 64),
            ...(typeof summary?.text === "string"
              ? { text: redactSecret(summary.text, secret).slice(0, AI_PROVIDER_TEST_LIMITS.maxResultCharacters) }
              : {}),
          })),
        } : {}),
        ...(typeof item.encrypted_content === "string" ? {
          encrypted_content: redactSecret(item.encrypted_content, secret).slice(0, AI_PROVIDER_TEST_LIMITS.maxCompactionCharacters),
        } : {}),
      }];
    }
    return [];
  });
}

export class AiProviderTestToolService {
  constructor({
    directory,
    userId,
    uid = null,
    gid = null,
    capabilities,
    list,
    test,
    request = null,
    agentTest = null,
    models = null,
    suite = null,
  }) {
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.capabilities = capabilities;
    this.list = list;
    this.testHandler = test;
    this.requestHandler = request || test;
    this.agentTestHandler = agentTest || request || test;
    this.modelsHandler = models;
    this.suiteHandler = suite;
    this.server = null;
    this.sockets = new Set();
    this.userDirectory = path.join(this.directory, `u-${crypto.createHash("sha256").update(this.userId).digest("hex").slice(0, 12)}`);
    const identity = crypto
      .createHash("sha256")
      .update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`)
      .digest("hex")
      .slice(0, 12);
    this.socketPath = path.join(this.userDirectory, `s-${identity}.sock`);
    if (Buffer.byteLength(this.socketPath) > UNIX_SOCKET_PATH_MAX_BYTES) {
      throw new Error(`AI 供应商测试工具 socket 路径超过 ${UNIX_SOCKET_PATH_MAX_BYTES} 字节限制`);
    }
  }

  async start() {
    if (this.server) return this.socketPath;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    const directoryStat = await fs.lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("AI 供应商测试工具 socket 目录不安全");
    }
    await fs.chmod(this.directory, 0o711);
    await fs.mkdir(this.userDirectory, { recursive: true, mode: 0o700 });
    const userDirectoryStat = await fs.lstat(this.userDirectory);
    if (!userDirectoryStat.isDirectory() || userDirectoryStat.isSymbolicLink()) {
      throw new Error("AI 供应商测试用户 socket 目录不安全");
    }
    await fs.chmod(this.userDirectory, 0o700);
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    const server = net.createServer((socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      await fs.chmod(this.socketPath, 0o600);
      if (this.uid !== null && this.gid !== null) await fs.chown(this.socketPath, this.uid, this.gid);
      return this.socketPath;
    } catch (error) {
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      await fs.unlink(this.socketPath).catch(() => {});
      throw error;
    }
  }

  async capabilitiesSnapshot() {
    try {
      const value = typeof this.capabilities === "function" ? await this.capabilities() : this.capabilities;
      return value && typeof value === "object" && value.enabled === true
        ? { enabled: true }
        : { enabled: false };
    } catch {
      return { enabled: false };
    }
  }

  async listProviders() {
    if (!(await this.capabilitiesSnapshot()).enabled) {
      throw new AiProviderTestError(403, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商真实测试插件未授权");
    }
    const providers = await this.list();
    return Array.isArray(providers) ? providers.slice(0, 100) : [];
  }

  async test(input) {
    if (!(await this.capabilitiesSnapshot()).enabled) {
      throw new AiProviderTestError(403, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商真实测试插件未授权");
    }
    return this.testHandler(normalizeAiProviderTestInput(input));
  }

  async request(input) {
    if (!(await this.capabilitiesSnapshot()).enabled) {
      throw new AiProviderTestError(403, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商真实测试插件未授权");
    }
    if (typeof this.requestHandler !== "function") {
      throw new AiProviderTestError(503, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商详细请求工具当前不可用");
    }
    return this.requestHandler(normalizeAiProviderRequestInput(input));
  }

  async agentTest(input) {
    if (!(await this.capabilitiesSnapshot()).enabled) {
      throw new AiProviderTestError(403, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商真实测试插件未授权");
    }
    if (typeof this.agentTestHandler !== "function") {
      throw new AiProviderTestError(503, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商 Agent 测试工具当前不可用");
    }
    return this.agentTestHandler(normalizeAiProviderAgentTestInput(input));
  }

  async models(input) {
    if (!(await this.capabilitiesSnapshot()).enabled) {
      throw new AiProviderTestError(403, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商真实测试插件未授权");
    }
    if (typeof this.modelsHandler !== "function") {
      throw new AiProviderTestError(503, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商模型查询工具当前不可用");
    }
    return this.modelsHandler(normalizeAiProviderModelsInput(input));
  }

  async suite(input) {
    if (!(await this.capabilitiesSnapshot()).enabled) {
      throw new AiProviderTestError(403, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商真实测试插件未授权");
    }
    if (typeof this.suiteHandler !== "function") {
      throw new AiProviderTestError(503, "AI_PROVIDER_TEST_UNAVAILABLE", "AI 供应商测试套件当前不可用");
    }
    return this.suiteHandler(normalizeAiProviderSuiteInput(input));
  }

  handleSocket(socket) {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    let buffer = "";
    let settled = false;
    const close = () => {
      this.sockets.delete(socket);
      if (!socket.destroyed) socket.destroy();
    };
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", close);
    socket.on("timeout", () => {
      if (settled) return;
      settled = true;
      void this.respond(socket, { ok: false, error: "AI 供应商真实测试超时", statusCode: 504 }).finally(close);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) {
        settled = true;
        void this.respond(socket, { ok: false, error: "AI 供应商测试请求过大", statusCode: 413 }).finally(close);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      settled = true;
      void this.executeRequest(buffer.slice(0, newline).trim())
        .then((result) => this.respond(socket, { ok: true, result }))
        .catch((error) => this.respond(socket, {
          ok: false,
          error: boundedErrorMessage(error),
          statusCode: Number(error?.statusCode) || 500,
        }))
        .finally(close);
    });
  }

  async executeRequest(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_REQUEST", "AI 供应商测试请求不是有效 JSON");
    }
    if (!request || typeof request !== "object" || Array.isArray(request) || request.version !== 1) {
      throw new AiProviderTestError(400, "INVALID_AI_PROVIDER_TEST_REQUEST", "AI 供应商测试请求无效");
    }
    if (request.action === "capabilities") return this.capabilitiesSnapshot();
    if (request.action === "list") return this.listProviders();
    if (request.action === "test") return this.test(request.input);
    if (request.action === "request") return this.request(request.input);
    if (request.action === "agent_test") return this.agentTest(request.input);
    if (request.action === "models") return this.models(request.input);
    if (request.action === "suite") return this.suite(request.input);
    throw new AiProviderTestError(400, "UNKNOWN_AI_PROVIDER_TEST_ACTION", "未知的 AI 供应商测试操作");
  }

  async respond(socket, value) {
    if (socket.destroyed || !socket.writable) return;
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload) > RESPONSE_LIMIT_BYTES) {
      socket.end(`${JSON.stringify({ ok: false, error: "AI 供应商测试响应过大", statusCode: 502 })}\n`);
      return;
    }
    await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function assertProviderProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new AiProviderTestError(404, "AI_PROVIDER_NOT_FOUND", "AI 供应商不存在");
  }
  if (typeof profile.id !== "string" || !PROVIDER_ID_PATTERN.test(profile.id)) {
    throw new AiProviderTestError(404, "AI_PROVIDER_NOT_FOUND", "AI 供应商不存在");
  }
}

function responsesEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || "").trim());
  } catch {
    throw new AiProviderTestError(502, "AI_PROVIDER_URL_INVALID", "供应商地址无效");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new AiProviderTestError(502, "AI_PROVIDER_URL_INVALID", "供应商地址无效");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
  return url.href;
}

function resultBase(profile, model, httpStatus, latencyMs, requestId, value = {}) {
  return {
    providerId: profile.id,
    providerName: redactSecret(String(profile.name || profile.id).slice(0, 64), profile.apiKey),
    model: redactSecret(model, profile.apiKey),
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    latencyMs,
    requestId: redactSecret(requestId || "", profile.apiKey) || null,
    ...(value.responseId ? { responseId: redactSecret(value.responseId, profile.apiKey) } : {}),
    usage: value.usage || null,
    ok: value.ok === true,
    ...(Number.isSafeInteger(value.maxOutputTokens) ? { maxOutputTokens: value.maxOutputTokens } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: String(value.reasoningEffort).slice(0, 16) } : {}),
    ...(value.status ? { status: String(value.status).slice(0, 64) } : {}),
    ...(value.streamed === true ? { streamed: true } : {}),
    ...(Number.isInteger(value.streamEvents) ? { streamEvents: value.streamEvents } : {}),
    ...(typeof value.structuredValid === "boolean" ? { structuredValid: value.structuredValid } : {}),
    ...(value.incompleteDetails ? { incompleteDetails: value.incompleteDetails } : {}),
    ...(value.text ? { text: value.text } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(Array.isArray(value.toolCalls) ? { toolCalls: value.toolCalls } : {}),
    ...(Array.isArray(value.outputItems) ? { outputItems: value.outputItems } : {}),
    ...(value.error ? { error: redactSecret(String(value.error), profile.apiKey) } : {}),
  };
}

function responseIdFromPayload(payload) {
  const id = typeof payload?.id === "string" ? payload.id.trim() : "";
  return RESPONSE_ID_PATTERN.test(id) ? id : null;
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  const parts = [];
  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (typeof item?.text === "string") parts.push(item.text);
      if (!Array.isArray(item?.content)) continue;
      for (const content of item.content) {
        if (["output_text", "text"].includes(content?.type) && typeof content.text === "string") {
          parts.push(content.text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  for (const [source, target] of [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["total_tokens", "totalTokens"],
  ]) {
    const number = Number(value[source]);
    if (Number.isSafeInteger(number) && number >= 0) usage[target] = number;
  }
  const cached = Number(value.input_tokens_details?.cached_tokens);
  if (Number.isSafeInteger(cached) && cached >= 0) usage.cachedInputTokens = cached;
  const reasoning = Number(value.output_tokens_details?.reasoning_tokens);
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length ? usage : null;
}

function normalizeIncompleteDetails(value, secret = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reason = typeof value.reason === "string"
    ? redactSecret(value.reason.trim(), secret).slice(0, 64)
    : "";
  return reason ? { reason } : null;
}

function upstreamStatusMessage(status) {
  if (status === 401 || status === 403) return "供应商拒绝了请求，请检查 API Key 或权限";
  if (status === 429) return "供应商限流或额度不足";
  if (status >= 400 && status < 500) return `供应商请求被拒绝（HTTP ${status}）`;
  return `供应商暂时不可用（HTTP ${status}）`;
}

function safeRequestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
}

function redactSecret(value, secret) {
  const text = String(value || "");
  if (!secret) return text;
  return text.split(String(secret)).join("[REDACTED]");
}

async function readResponsesStream(response, limit) {
  const decoder = new TextDecoder();
  const items = new Map();
  const order = [];
  let buffer = "";
  let total = 0;
  let eventCount = 0;
  let text = "";
  let finalResponse = null;
  let terminalEvent = null;
  let doneMarker = false;

  const upsertItem = (item, itemKey = null) => {
    if (!item || typeof item !== "object") return;
    const key = String(itemKey || item.id || item.call_id || `item-${order.length + 1}`);
    if (!items.has(key)) order.push(key);
    items.set(key, { ...(items.get(key) || {}), ...item });
  };
  const findItemKey = (itemId) => order.find((key) => key === String(itemId)) || null;
  const applyEvent = (event) => {
    eventCount += 1;
    if (eventCount > AI_PROVIDER_TEST_LIMITS.maxStreamEvents) {
      throw new AiProviderTestError(502, "AI_PROVIDER_STREAM_TOO_LARGE", "供应商流式事件数量超过安全限制");
    }
    const type = String(event?.type || "");
    if (type === "response.output_text.delta") {
      text += String(event.delta || "");
      return;
    }
    if (type === "response.output_text.done" && !text) {
      text = String(event.text || "");
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      upsertItem(event.item);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const key = findItemKey(event.item_id) || String(event.item_id || `item-${order.length + 1}`);
      const current = items.get(key) || { type: "function_call", id: event.item_id };
      upsertItem({ ...current, type: "function_call", arguments: `${current.arguments || ""}${event.delta || ""}` }, key);
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const key = findItemKey(event.item_id) || String(event.item_id || `item-${order.length + 1}`);
      const current = items.get(key) || { type: "function_call", id: event.item_id };
      upsertItem({ ...current, type: "function_call", arguments: event.arguments || current.arguments || "{}" }, key);
      return;
    }
    if (["response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"].includes(type)) {
      if (event.response && typeof event.response === "object") finalResponse = event.response;
      if (type === "response.failed" && !finalResponse) finalResponse = { status: "failed" };
      if (["response.completed", "response.incomplete", "response.failed"].includes(type)) terminalEvent = type;
    }
  };
  const consumeBlock = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    if (data === "[DONE]") {
      doneMarker = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new AiProviderTestError(502, "AI_PROVIDER_STREAM_INVALID", "供应商返回了无效流式事件");
    }
    applyEvent(event);
  };

  if (!response.body) throw new AiProviderTestError(502, "AI_PROVIDER_STREAM_INVALID", "供应商没有返回流式内容");
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new AiProviderTestError(502, "AI_PROVIDER_RESPONSE_TOO_LARGE", "供应商响应超过安全大小限制");
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      consumeBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeBlock(buffer);
  if (!terminalEvent && !doneMarker) {
    throw new AiProviderTestError(502, "AI_PROVIDER_STREAM_INCOMPLETE", "供应商流式响应意外中断");
  }
  const payload = finalResponse && typeof finalResponse === "object" ? { ...finalResponse } : {};
  const output = Array.isArray(payload.output) && payload.output.length
    ? payload.output
    : order.map((key) => items.get(key)).filter(Boolean);
  if (!Array.isArray(payload.output) || !payload.output.length) payload.output = output;
  if (text && typeof payload.output_text !== "string") payload.output_text = text;
  return { payload, outputOverride: output, textOverride: text, eventCount };
}

async function readBoundedBody(response, limit) {
  const chunks = [];
  let total = 0;
  if (!response.body) return "";
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) {
      throw new AiProviderTestError(502, "AI_PROVIDER_RESPONSE_TOO_LARGE", "供应商响应超过安全大小限制");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function boundedErrorMessage(error) {
  const message = String(error?.publicMessage || error?.message || "AI 供应商测试失败").trim();
  return (message || "AI 供应商测试失败").slice(0, 2_000);
}
