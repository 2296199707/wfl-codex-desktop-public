#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = "subagent";
const SEND_MESSAGE_TOOL = "send_message";
const INTERRUPT_TOOL = "interrupt_agent";
const LIST_TOOL = "list_agents";
const REQUEST_LIMIT_BYTES = 512 * 1024;
const scriptArgs = process.argv.slice(2);
const argumentValue = (name) => {
  const index = scriptArgs.indexOf(name);
  return index === -1 ? null : scriptArgs[index + 1] || null;
};
const socketPath = argumentValue("--socket") || process.env.WFL_DEEPSEEK_HARNESS_SOCKET;
const authToken = readAuthToken();
const activeCalls = new Map();
let inputBuffer = "";

function readAuthToken() {
  const tokenPath = process.env.WFL_DEEPSEEK_HARNESS_AUTH_TOKEN_FILE;
  if (!tokenPath) return null;
  try {
    return fs.readFileSync(tokenPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let index;
  while ((index = inputBuffer.indexOf("\n")) !== -1) {
    const rawLine = inputBuffer.slice(0, index);
    const line = rawLine.trim();
    inputBuffer = inputBuffer.slice(index + 1);
    if (!line) continue;
    if (Buffer.byteLength(rawLine) > REQUEST_LIMIT_BYTES) {
      writeError(null, -32600, "Request too large");
      continue;
    }
    void handleLine(line);
  }
  if (Buffer.byteLength(inputBuffer) > REQUEST_LIMIT_BYTES) {
    inputBuffer = "";
    writeError(null, -32600, "Request too large");
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
  if (!message || typeof message !== "object") {
    writeError(null, -32600, "Invalid Request");
    return;
  }
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      activeCalls.get(String(requestId))?.abort();
    }
    return;
  }
  if (!Object.hasOwn(message, "id")) return;
  try {
    if (message.method === "initialize") {
      writeResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wfl-third-party-subagent", title: "第三方子代理", version: "1.0.0" },
      });
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    if (message.method === "tools/list") {
      writeResult(message.id, { tools: toolDefinitions() });
      return;
    }
    if (message.method === "tools/call") {
      const toolName = message.params?.name;
      if (![TOOL_NAME, SEND_MESSAGE_TOOL, INTERRUPT_TOOL, LIST_TOOL].includes(toolName)) {
        writeResult(message.id, toolError("UNKNOWN_TOOL", "未知的第三方子代理工具"));
        return;
      }
      const args = validateArguments(toolName, message.params?.arguments);
      const parentContext = parentContextFromMeta(message.params?._meta, { requireTurn: toolName === TOOL_NAME });
      const requestId = String(message.id);
      const controller = new AbortController();
      activeCalls.set(requestId, controller);
      try {
        const response = await requestService({
          version: 1,
          authToken,
          operation: toolName === TOOL_NAME
            ? "start"
            : toolName === SEND_MESSAGE_TOOL
              ? "send_message"
              : toolName === INTERRUPT_TOOL
                ? "interrupt_agent"
                : "list_agents",
          ...(toolName === TOOL_NAME ? {
            description: args.description,
            prompt: args.prompt,
            runInBackground: args.run_in_background,
          } : {}),
          ...(toolName === SEND_MESSAGE_TOOL ? {
            childId: args.subagent_id,
            message: args.message,
          } : {}),
          ...(toolName === INTERRUPT_TOOL ? { childId: args.agent_id } : {}),
          ...(toolName === LIST_TOOL ? { scope: args.scope } : {}),
          parentThreadId: parentContext.parentThreadId,
          ...(parentContext.parentTurnId ? { parentTurnId: parentContext.parentTurnId } : {}),
        }, controller.signal);
        if (response.ok !== true) {
          const error = response.error || {};
          writeResult(message.id, toolError(
            error.code || "SUBAGENT_ERROR",
            error.message || "第三方子代理执行失败",
            {
              stopReason: error.stopReason,
              partialOutput: error.partialOutput,
            },
          ));
          return;
        }
        writeResult(message.id, toolResult(toolName, response.result));
      } finally {
        if (activeCalls.get(requestId) === controller) activeCalls.delete(requestId);
      }
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") {
      writeResult(message.id, toolError(error.code || "SUBAGENT_ERROR", error.message || "第三方子代理执行失败"));
    } else {
      writeError(message.id, -32603, String(error?.message || "Internal error").slice(0, 2_000));
    }
  }
}

function toolDefinitions() {
  return [
    {
      name: TOOL_NAME,
      title: "第三方子代理",
      description: "启动一个可继续执行的 coding subagent。默认后台运行并立即返回 durable subagent id；设置 run_in_background=false 时等待本次结果。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string", minLength: 1, description: "任务的简短、独立描述。" },
          prompt: { type: "string", minLength: 1, description: "交给子代理执行的完整任务说明。" },
          run_in_background: { type: "boolean", default: true, description: "是否立即返回并让子代理在后台继续执行。" },
        },
        required: ["description", "prompt"],
      },
    },
    {
      name: SEND_MESSAGE_TOOL,
      title: "发送子代理消息",
      description: "向已有 background subagent 发送下一轮消息；只返回消息已送达的确认，不返回子代理回答。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          subagent_id: { type: "string", minLength: 1, description: "启动子代理时返回的 durable id。" },
          message: { type: "string", minLength: 1, description: "要发送给子代理的下一轮消息。" },
        },
        required: ["subagent_id", "message"],
      },
    },
    {
      name: INTERRUPT_TOOL,
      title: "中断子代理",
      description: "请求停止子代理当前轮次；已排队消息保留，子代理仍可继续接收后续消息。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent_id: { type: "string", minLength: 1, description: "要中断的子代理 id。" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: LIST_TOOL,
      title: "列出子代理",
      description: "列出当前父会话的可继续子代理；这是状态快照，不是结果收集接口。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string", enum: ["children", "descendants"], default: "children" },
        },
      },
    },
  ];
}

function validateArguments(toolName, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工具参数必须是对象");
  }
  const allowed = toolName === TOOL_NAME
    ? new Set(["description", "prompt", "run_in_background"])
    : toolName === SEND_MESSAGE_TOOL
      ? new Set(["subagent_id", "message"])
      : toolName === INTERRUPT_TOOL
        ? new Set(["agent_id"])
        : new Set(["scope"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("工具参数包含不支持的字段");
  }
  if (toolName === TOOL_NAME) {
    const description = typeof value.description === "string" ? value.description.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    if (!description || !prompt) throw new Error("description 和 prompt 都不能为空");
    if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") {
      throw new Error("run_in_background 必须是布尔值");
    }
    return { description, prompt, run_in_background: value.run_in_background !== false };
  }
  if (toolName === SEND_MESSAGE_TOOL) {
    const subagentId = typeof value.subagent_id === "string" ? value.subagent_id.trim() : "";
    const message = typeof value.message === "string" ? value.message.trim() : "";
    if (!subagentId || !message) throw new Error("subagent_id 和 message 都不能为空");
    return { subagent_id: subagentId, message };
  }
  if (toolName === INTERRUPT_TOOL) {
    const agentId = typeof value.agent_id === "string" ? value.agent_id.trim() : "";
    if (!agentId) throw new Error("agent_id 不能为空");
    return { agent_id: agentId };
  }
  if (value.scope !== undefined && !["children", "descendants"].includes(value.scope)) {
    throw new Error("scope 无效");
  }
  return { scope: value.scope || "children" };
}

function toolResult(toolName, result = {}) {
  if (toolName === TOOL_NAME) {
    if (result.mode === "continuable") {
      const childId = String(result.childId || "");
      return {
        content: [{ type: "text", text: `started subagent ${childId}` }],
        structuredContent: { childId },
        isError: false,
      };
    }
    return {
      content: [{ type: "text", text: String(result.finalResponse || "") }],
      structuredContent: { finalResponse: String(result.finalResponse || "") },
      isError: false,
    };
  }
  if (toolName === SEND_MESSAGE_TOOL) {
    const messageId = String(result.messageId || "");
    return {
      content: [{ type: "text", text: "message queued as the next turn for the subagent" }],
      structuredContent: { messageId },
      isError: false,
    };
  }
  if (toolName === INTERRUPT_TOOL) {
    return {
      content: [{ type: "text", text: "interrupt request accepted" }],
      structuredContent: { accepted: result.accepted === true },
      isError: false,
    };
  }
  const entries = Array.isArray(result.entries) ? result.entries : [];
  return {
    content: [{ type: "text", text: entries.length ? JSON.stringify(entries) : "(no subagents)" }],
    structuredContent: entries,
    isError: false,
  };
}

function parentContextFromMeta(meta, { requireTurn = true } = {}) {
  if (meta === undefined || meta === null) {
    throw metadataError(
      "Codex 父线程和父轮次元数据缺失",
      "SUBAGENT_PARENT_METADATA_REQUIRED",
    );
  }
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw metadataError("MCP 工具元数据无效");
  }

  const topLevelThreadId = metadataThreadId(meta, "threadId");
  const topLevelTurnId = metadataThreadId(meta, "turnId");
  const turnMetadata = meta["x-codex-turn-metadata"];
  const nestedContext = turnMetadata === undefined || turnMetadata === null
    ? { threadId: null, turnId: null }
    : (() => {
      if (typeof turnMetadata !== "object" || Array.isArray(turnMetadata)) {
        throw metadataError("Codex 轮次元数据无效");
      }
      return {
        threadId: metadataThreadId(turnMetadata, "thread_id"),
        turnId: metadataThreadId(turnMetadata, "turn_id"),
      };
    })();

  if (topLevelThreadId && nestedContext.threadId && topLevelThreadId !== nestedContext.threadId) {
    throw metadataError("Codex 父线程元数据不一致", "SUBAGENT_PARENT_THREAD_MISMATCH");
  }
  if (topLevelTurnId && nestedContext.turnId && topLevelTurnId !== nestedContext.turnId) {
    throw metadataError("Codex 父轮次元数据不一致", "SUBAGENT_PARENT_TURN_MISMATCH");
  }
  const parentThreadId = topLevelThreadId || nestedContext.threadId || null;
  const parentTurnId = topLevelTurnId || nestedContext.turnId || null;
  if (!parentThreadId || (requireTurn && !parentTurnId)) {
    throw metadataError(
      requireTurn ? "Codex 父线程和父轮次元数据不完整" : "Codex 父线程元数据不完整",
      "SUBAGENT_PARENT_METADATA_REQUIRED",
    );
  }
  return { parentThreadId, parentTurnId };
}

function metadataThreadId(value, key) {
  if (!Object.hasOwn(value, key)) return null;
  const threadId = value[key];
  if (
    typeof threadId !== "string"
    || !threadId
    || threadId.length > 256
    || threadId !== threadId.trim()
    || /[\u0000\r\n]/u.test(threadId)
  ) {
    throw metadataError(`Codex ${key} 无效`);
  }
  return threadId;
}

function metadataError(message, code = "SUBAGENT_PARENT_THREAD_INVALID") {
  return Object.assign(new Error(message), { code });
}

function requestService(request, signal = null) {
  if (!socketPath) return Promise.reject(new Error("第三方子代理服务地址不存在"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let abortListener = null;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      socket.destroy();
      operation();
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        finish(() => resolve(JSON.parse(line)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) finish(() => reject(new Error("第三方子代理服务连接已关闭")));
    });
    abortListener = () => finish(() => reject(Object.assign(
      new Error("第三方子代理工具调用已取消"),
      { code: "SUBAGENT_CANCELLED" },
    )));
    if (signal?.aborted) {
      abortListener();
      return;
    }
    signal?.addEventListener("abort", abortListener, { once: true });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

function toolError(code, message, details = {}) {
  const safeMessage = sanitizeErrorMessage(message);
  const partialOutput = typeof details.partialOutput === "string" ? details.partialOutput : "";
  const content = [{ type: "text", text: safeMessage }];
  if (partialOutput.trim()) content.push({ type: "text", text: partialOutput });
  const structuredContent = {
    code: safeErrorCode(code),
    message: safeMessage,
    ...(typeof details.stopReason === "string" ? { stopReason: details.stopReason } : {}),
    ...(partialOutput.trim() ? { partialOutput } : {}),
  };
  return {
    content,
    isError: true,
    structuredContent,
  };
}

function safeErrorCode(value) {
  const code = String(value || "SUBAGENT_ERROR");
  return /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : "SUBAGENT_ERROR";
}

function sanitizeErrorMessage(value) {
  let message = String(value || "第三方子代理执行失败");
  message = message
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[redacted-api-key]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/giu, "$1[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]");
  return message.slice(0, 4_000);
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
