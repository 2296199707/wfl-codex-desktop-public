#!/usr/bin/env node
import net from "node:net";
import { AI_PROVIDER_TEST_LIMITS } from "../lib/ai-provider-test-tool-service.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const CAPABILITY_POLL_INTERVAL_MS = 3_000;
const TOOL_TIMEOUT_MS = AI_PROVIDER_TEST_LIMITS.timeoutMs
  * Math.max(AI_PROVIDER_TEST_LIMITS.maxAgentRounds, AI_PROVIDER_TEST_LIMITS.maxSuiteRequests)
  + 20_000;
const BROKER_RESPONSE_LIMIT_BYTES = AI_PROVIDER_TEST_LIMITS.maxResponseBytes + 256 * 1024;
const socketPath = parseSocketPath(process.argv.slice(2));
let buffer = "";
let initialized = false;
let capabilityFingerprint = null;
let capabilityPoll = null;
let capabilityPollRunning = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handleLine(line);
    newline = buffer.indexOf("\n");
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "notifications/initialized") {
      initialized = true;
      startCapabilityPolling();
    }
    return;
  }
  try {
    if (message.method === "initialize") {
      const capabilities = await requestBroker({ version: 1, action: "capabilities" }).catch(() => ({ enabled: false }));
      capabilityFingerprint = fingerprintCapabilities(capabilities);
      writeResult(message.id, {
        protocolVersion: supportedProtocolVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: "wfl-ai-provider-real-test",
          title: "WFL AI 供应商真实测试",
          version: "0.1.0",
        },
        instructions: "只调用 WFL 供应商中心中已配置且已授权的 AI 供应商；不会接收任意 URL，不会返回或记录 API Key。每次测试都会真实消耗供应商额度。",
      });
      startCapabilityPolling();
      return;
    }
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    if (message.method === "tools/list") {
      const capabilities = await requestBroker({ version: 1, action: "capabilities" });
      capabilityFingerprint = fingerprintCapabilities(capabilities);
      writeResult(message.id, { tools: capabilities.enabled ? toolDefinitions() : [] });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const actions = {
        ai_provider_test: "test",
        ai_provider_request: "request",
        ai_provider_agent_test: "agent_test",
        ai_provider_models: "models",
        ai_provider_run_suite: "suite",
      };
      if (name !== "ai_provider_list" && !Object.hasOwn(actions, name)) {
        writeResult(message.id, toolError("未知的 AI 供应商真实测试工具"));
        return;
      }
      const capabilities = await requestBroker({ version: 1, action: "capabilities" });
      if (!capabilities.enabled) {
        writeResult(message.id, toolError("AI 供应商真实测试插件未安装、启用或授权"));
        return;
      }
      if (name === "ai_provider_list") {
        const providers = await requestBroker({ version: 1, action: "list" });
        writeResult(message.id, {
          content: [{
            type: "text",
            text: providers.length
              ? providers.map((provider) => `${provider.name} · ${provider.id}${provider.model ? ` · ${provider.model}` : ""}`).join("\n")
              : "当前没有可用于真实测试的 API 供应商。",
          }],
          structuredContent: { providers },
          isError: false,
        });
        return;
      }
      const result = await requestBroker({
        version: 1,
        action: actions[name],
        input: message.params?.arguments,
      });
      if (name === "ai_provider_models") {
        writeResult(message.id, {
          content: [{
            type: "text",
            text: result?.models?.length
              ? `供应商：${result.providerName || result.providerId}\n模型：\n${result.models.join("\n")}`
              : "供应商没有返回可用模型。",
          }],
          structuredContent: result,
          isError: !Array.isArray(result?.models),
        });
        return;
      }
      if (name === "ai_provider_run_suite") {
        writeResult(message.id, {
          content: [{ type: "text", text: formatSuiteResult(result) }],
          structuredContent: result,
          isError: result?.ok !== true,
        });
        return;
      }
      writeResult(message.id, {
        content: [{ type: "text", text: formatTestResult(result) }],
        structuredContent: result,
        isError: result?.ok !== true,
      });
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError(error?.message));
    else writeError(message.id, -32603, String(error?.message || "Internal error").slice(0, 2_000));
  }
}

function startCapabilityPolling() {
  if (capabilityPoll) return;
  capabilityPoll = setInterval(() => void pollCapabilities(), CAPABILITY_POLL_INTERVAL_MS);
  capabilityPoll.unref?.();
}

async function pollCapabilities() {
  if (!initialized || capabilityPollRunning) return;
  capabilityPollRunning = true;
  try {
    const capabilities = await requestBroker({ version: 1, action: "capabilities" });
    const nextFingerprint = fingerprintCapabilities(capabilities);
    if (capabilityFingerprint !== null && nextFingerprint !== capabilityFingerprint) {
      capabilityFingerprint = nextFingerprint;
      writeNotification("notifications/tools/list_changed", {});
      return;
    }
    capabilityFingerprint = nextFingerprint;
  } catch {
    // The next successful poll will refresh the advertised capabilities.
  } finally {
    capabilityPollRunning = false;
  }
}

function toolDefinitions() {
  return [
    {
      name: "ai_provider_list",
      title: "列出可测试 AI 供应商",
      description: "列出当前 WFL 账号已配置、已授权且不含 API Key 的供应商信息。先调用此工具选择 providerId。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "ai_provider_test",
      title: "真实测试 AI 供应商",
      description: "向 WFL 供应商中心中已配置的 AI 供应商发起一次真实 Responses API 请求。只使用已登记供应商，不接受 URL；会真实消耗额度，绝不返回 API Key。providerId 省略时使用当前活动供应商。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          providerId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "ai_provider_list 返回的供应商 ID；省略时使用当前活动供应商。",
          },
          model: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
            description: "可选模型 ID；省略时使用供应商已保存的模型。",
          },
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: AI_PROVIDER_TEST_LIMITS.maxPromptCharacters,
            description: "要发送给真实供应商的测试提示词。",
          },
          maxOutputTokens: {
            type: "integer",
            minimum: 1,
            description: "可选输出 Token 上限，默认 512；不是保证输出长度，且可能包含推理 Token。具体可用范围由供应商和模型决定。",
          },
          reasoningEffort: reasoningEffortSchema(),
          contextManagement: contextManagementSchema(),
          previousResponseId: previousResponseIdSchema(),
          store: { type: "boolean", description: "是否将 Responses 保存到供应商端；不指定时使用供应商默认值。" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "ai_provider_request",
      title: "详细请求 AI 供应商",
      description: "发送一次详细的 Responses API 请求，可验证结构化 JSON 输出和 function 工具调用。只使用 WFL 已登记供应商，不接受 URL 或请求头；真实消耗额度。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...providerRequestProperties(),
          input: {
            description: "可选 Responses input 文本或受限输入项数组；与 prompt 二选一。",
            oneOf: [
              { type: "string", minLength: 1, maxLength: AI_PROVIDER_TEST_LIMITS.maxPromptCharacters },
              { type: "array", minItems: 1, maxItems: AI_PROVIDER_TEST_LIMITS.maxInputItems, items: inputItemSchema() },
            ],
          },
          tools: functionToolsSchema({ mock: false }),
          toolChoice: { type: "string", enum: ["auto", "required", "none"] },
          stream: { type: "boolean", description: "是否按 Responses SSE 流读取后聚合返回。" },
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 64 },
              schema: { type: "object" },
              strict: { type: "boolean" },
            },
            required: ["schema"],
          },
        },
        required: [],
      },
    },
    {
      name: "ai_provider_models",
      title: "查询 AI 供应商模型",
      description: "查询 WFL 已登记供应商的 /models 列表；不会接收 URL 或返回 API Key。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          providerId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "ai_provider_list 返回的供应商 ID；省略时使用当前活动供应商。",
          },
        },
      },
    },
    {
      name: "ai_provider_agent_test",
      title: "测试 AI 供应商 Agent 工具循环",
      description: `让真实供应商在调用方设置的轮数和调用次数内选择固定虚拟工具（系统上限 ${AI_PROVIDER_TEST_LIMITS.maxAgentRounds} 轮、${AI_PROVIDER_TEST_LIMITS.maxToolCalls} 次）；工具结果由调用方提供，服务器不执行任意代码。用于验证 tool call、工具结果回传和多轮完成。`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...providerRequestProperties(),
          maxRounds: {
            type: "integer",
            minimum: 1,
            maximum: AI_PROVIDER_TEST_LIMITS.maxAgentRounds,
            default: AI_PROVIDER_TEST_LIMITS.maxAgentRounds,
            description: "Agent 最大工具轮数；调用方可以按测试需要设置，仍有防止无限循环的系统上限。",
          },
          maxToolCalls: {
            type: "integer",
            minimum: 1,
            maximum: AI_PROVIDER_TEST_LIMITS.maxToolCalls,
            default: AI_PROVIDER_TEST_LIMITS.maxToolCalls,
            description: "Agent 最大工具调用次数；调用方可以按测试需要设置，仍有防止无限循环的系统上限。",
          },
          tools: functionToolsSchema({ mock: true }),
        },
        required: ["prompt"],
      },
    },
    {
      name: "ai_provider_run_suite",
      title: "运行 AI 供应商测试套件",
      description: "运行固定的少量文本、流式、结构化、工具调用、工具回传和错误场景；最多 6 项、7 次请求，不是压力测试。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          providerId: providerRequestProperties().providerId,
          model: providerRequestProperties().model,
          maxOutputTokens: providerRequestProperties().maxOutputTokens,
          reasoningEffort: providerRequestProperties().reasoningEffort,
          contextManagement: contextManagementSchema(),
          previousResponseId: previousResponseIdSchema(),
          store: { type: "boolean", description: "是否将 Responses 保存到供应商端；不指定时使用供应商默认值。" },
          cases: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
            items: {
              type: "string",
              enum: ["text", "stream", "structured", "tool_call", "tool_result", "error"],
            },
          },
        },
      },
    },
  ];
}

function providerRequestProperties() {
  return {
    providerId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "ai_provider_list 返回的供应商 ID；省略时使用当前活动供应商。",
    },
    model: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
      description: "可选模型 ID；省略时使用供应商已保存的模型。",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 32000,
      description: "要发送给真实供应商的测试提示词。",
    },
      maxOutputTokens: {
        type: "integer",
        minimum: 1,
        description: "可选输出 Token 上限，默认 512；不是保证输出长度，且可能包含推理 Token。具体可用范围由供应商和模型决定。",
    },
    reasoningEffort: reasoningEffortSchema(),
    contextManagement: contextManagementSchema(),
    previousResponseId: previousResponseIdSchema(),
    store: { type: "boolean", description: "是否将 Responses 保存到供应商端；不指定时使用供应商默认值。" },
  };
}

function contextManagementSchema() {
  return {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["compaction"] },
        compactThreshold: {
          type: "integer",
          minimum: 1000,
          description: "达到此上下文 Token 阈值时触发服务端 compaction；不指定则使用供应商默认值。",
        },
      },
      required: ["type"],
    },
    description: "Responses context_management；当前支持 compaction。下一次无状态请求必须保留返回的 compaction output item。",
  };
}

function previousResponseIdSchema() {
  return {
    type: "string",
    minLength: 1,
    maxLength: 256,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    description: "可选 previous_response_id；使用它续接时只传新的 input，不要重复传上一响应 output。",
  };
}

function inputItemSchema() {
  return {
    type: "object",
    oneOf: [
      {
        properties: {
          type: { type: "string", enum: ["compaction"] },
          id: { type: "string", maxLength: 256 },
          encrypted_content: { type: "string", maxLength: AI_PROVIDER_TEST_LIMITS.maxCompactionCharacters },
        },
        required: ["type", "encrypted_content"],
      },
      {
        properties: {
          type: { type: "string", enum: ["function_call_output"] },
          call_id: { type: "string", minLength: 1, maxLength: 128 },
          output: {},
        },
        required: ["type", "call_id", "output"],
      },
      {
        properties: {
          type: { type: "string", enum: ["function_call"] },
          id: { type: "string", maxLength: 256 },
          call_id: { type: "string", minLength: 1, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 64 },
          arguments: {},
        },
        required: ["type", "call_id", "name", "arguments"],
      },
      {
        properties: {
          type: { type: "string", enum: ["message"] },
          role: { type: "string", enum: ["user", "assistant", "system", "developer"] },
          content: {},
        },
        required: ["role", "content"],
      },
    ],
    description: "包括 message、function call/output，以及可原样回传的 compaction item。",
  };
}

function reasoningEffortSchema() {
  return {
    type: "string",
    enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    description: "可选 Responses reasoning.effort；不指定时不发送。并非所有模型都支持所有值。",
  };
}

function functionToolsSchema({ mock }) {
  const properties = {
    type: { type: "string", enum: ["function"] },
    name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
    description: { type: "string", maxLength: 1000 },
    parameters: { type: "object", description: "JSON Schema；省略时使用空对象参数。" },
    strict: { type: "boolean" },
  };
  if (mock) {
    properties.builtin = {
      type: "string",
      enum: ["fixed", "calculator", "query", "failure"],
      description: "仅 Agent 测试使用的内置纯内存工具类型。",
    };
    properties.mockResult = { description: "固定 JSON 工具结果；不会作为代码执行。" };
    properties.mockError = { type: "string", maxLength: 4000 };
  }
  return {
    type: "array",
    maxItems: 8,
    items: {
      type: "object",
      additionalProperties: false,
      properties,
      required: ["name"],
    },
  };
}

function formatTestResult(result) {
  return [
    result?.mode ? `模式：${result.mode}` : null,
    `供应商：${result?.providerName || result?.providerId || "未知"}`,
    `模型：${result?.model || "未知"}`,
    `HTTP：${result?.httpStatus ?? "未返回"}`,
    `耗时：${Number.isFinite(result?.latencyMs) ? `${result.latencyMs} ms` : "未知"}`,
    Number.isSafeInteger(result?.maxOutputTokens) ? `输出上限：${result.maxOutputTokens}（不是固定长度）` : null,
    result?.reasoningEffort ? `推理强度：${result.reasoningEffort}` : null,
    result?.status ? `完成原因：${result.status}` : null,
    result?.incompleteDetails?.reason ? `未完成原因：${result.incompleteDetails.reason}` : null,
    formatCompactionItems(result?.outputItems || result?.responses?.flatMap((entry) => entry.outputItems || []) || []),
    result?.streamed ? `流式事件：${result.streamEvents ?? 0}` : null,
    typeof result?.structuredValid === "boolean" ? `结构化校验：${result.structuredValid ? "通过" : "失败"}` : null,
    Number.isInteger(result?.rounds) ? `轮数：${result.rounds}` : null,
    Array.isArray(result?.toolCalls) && result.toolCalls.length
      ? `工具调用：${result.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})${call.ok ? "" : " [失败]"}`).join("；")}`
      : null,
    result?.usage ? `Usage：${JSON.stringify(result.usage)}` : null,
    result?.ok === true
      ? `响应：\n${result.text || "（空响应）"}${result.truncated ? "\n（响应已截断）" : ""}`
      : `失败：${result?.error || "供应商测试失败"}${result?.truncated ? "\n（响应已截断）" : ""}`,
  ].filter(Boolean).join("\n");
}

function formatSuiteResult(result) {
  return [
    `供应商：${result?.providerName || result?.providerId || "未知"}`,
    `模型：${result?.model || "未知"}`,
    `套件状态：${result?.ok === true ? "通过" : "存在失败项"}`,
    Number.isSafeInteger(result?.maxOutputTokens) ? `输出上限：${result.maxOutputTokens}（不是固定长度）` : null,
    result?.reasoningEffort ? `推理强度：${result.reasoningEffort}` : null,
    result?.status ? `最近完成原因：${result.status}` : null,
    result?.incompleteDetails?.reason ? `最近未完成原因：${result.incompleteDetails.reason}` : null,
    `请求数：${result?.requestCount ?? 0}/${result?.maxRequests ?? "未知"}`,
    `耗时：${Number.isFinite(result?.latencyMs) ? `${result.latencyMs} ms` : "未知"}`,
    result?.usage ? `Usage：${JSON.stringify(result.usage)}` : null,
    ...(Array.isArray(result?.cases)
      ? result.cases.map((entry) => {
        const items = [
          ...(Array.isArray(entry.result?.outputItems) ? entry.result.outputItems : []),
          ...(Array.isArray(entry.result?.responses) ? entry.result.responses.flatMap((response) => response.outputItems || []) : []),
        ];
        return `${entry.ok ? "✓" : "✗"} ${entry.name} · ${entry.latencyMs} ms`
          + (entry.error || entry.result?.error ? ` · ${entry.error || entry.result.error}` : "")
          + (items.some((item) => item?.type === "compaction") ? " · 含 compaction output item" : "");
      })
      : []),
  ].filter(Boolean).join("\n");
}

function formatCompactionItems(items) {
  const compactions = Array.isArray(items)
    ? items.filter((item) => item?.type === "compaction")
    : [];
  if (!compactions.length) return null;
  return `Compaction output item：${compactions.map((item) => (
    `${item.id || "无 ID"} · ${typeof item.encrypted_content === "string"
      ? `${Buffer.byteLength(item.encrypted_content, "utf8")} bytes`
      : "已返回加密内容"}`
  )).join("；")}（encrypted_content 为不透明上下文，不在文本摘要中展开）`;
}

function requestBroker(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(TOOL_TIMEOUT_MS);
    let responseBuffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      responseBuffer += chunk;
      if (Buffer.byteLength(responseBuffer) > BROKER_RESPONSE_LIMIT_BYTES) {
        finish(new Error("AI 供应商测试响应过大"));
        return;
      }
      const newline = responseBuffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(responseBuffer.slice(0, newline));
      } catch {
        finish(new Error("AI 供应商测试返回了无效响应"));
        return;
      }
      if (!response?.ok) finish(new Error(String(response?.error || "AI 供应商测试失败")));
      else finish(null, response.result);
    });
    socket.on("timeout", () => finish(new Error("AI 供应商真实测试超时")));
    socket.on("error", () => finish(new Error("AI 供应商测试服务当前不可用")));
    socket.on("end", () => {
      if (!settled) finish(new Error("AI 供应商测试服务提前断开"));
    });
  });
}

function fingerprintCapabilities(value) {
  return JSON.stringify(value || { enabled: false });
}

function toolError(message) {
  const text = String(message || "AI 供应商测试失败").slice(0, 2_000);
  return {
    content: [{ type: "text", text }],
    structuredContent: { error: text },
    isError: true,
  };
}

function supportedProtocolVersion(value) {
  return ["2024-11-05", "2025-03-26", PROTOCOL_VERSION].includes(value)
    ? value
    : PROTOCOL_VERSION;
}

function parseSocketPath(args) {
  const index = args.indexOf("--socket");
  const value = index === -1 ? "" : String(args[index + 1] || "");
  if (!value.startsWith("/") || value.length > 4_096 || /[\u0000\r\n]/.test(value)) {
    process.stderr.write("WFL AI provider test MCP requires an absolute --socket path\n");
    process.exit(2);
  }
  return value;
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function writeNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
