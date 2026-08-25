import fs from "node:fs/promises";
import readline from "node:readline";
import { ANDROID_APK_MCP_TOOLS } from "../lib/android-apk-builder.mjs";

const args = parseArguments(process.argv.slice(2));
const endpoint = args.endpoint || `http://127.0.0.1:${process.env.CODEX_DESKTOP_GATEWAY_PORT || 4317}/api/plugins/android-drive-builder/mcp/call`;
const tokenFile = args.tokenFile || process.env.WFL_ANDROID_APK_TOOL_TOKEN_FILE || "";
const protocolVersion = "2024-11-05";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const value = line.trim();
  if (!value) return;
  void handleMessage(value);
});

async function handleMessage(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    return;
  }
  if (request.method?.startsWith("notifications/")) return;
  if (request.method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wfl-android-apk-builder", version: "2.0.0" },
      },
    });
    return;
  }
  if (request.method === "ping") {
    writeMessage({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "tools/list") {
    writeMessage({ jsonrpc: "2.0", id: request.id, result: { tools: ANDROID_APK_MCP_TOOLS } });
    return;
  }
  if (request.method === "tools/call") {
    try {
      const result = await callBackend(request.params?.name, request.params?.arguments || {});
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      });
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: true, content: [{ type: "text", text: error.message || "Android APK 工具调用失败" }] },
      });
    }
    return;
  }
  writeMessage({
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code: -32601, message: `Unsupported MCP method: ${request.method || ""}` },
  });
}

async function callBackend(name, argumentsValue) {
  if (!name || typeof name !== "string") throw new Error("缺少 Android APK 工具名称");
  if (!tokenFile) throw new Error("Android APK MCP 未配置本地授权文件");
  const token = (await fs.readFile(tokenFile, "utf8")).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_600_000);
  timer.unref?.();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WFL-Android-APK-Token": token,
      },
      body: JSON.stringify({ tool: name, arguments: argumentsValue }),
      signal: controller.signal,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Android APK 工具返回了无效响应（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(data.error || `Android APK 工具调用失败（HTTP ${response.status}）`);
    return data.result ?? data;
  } finally {
    clearTimeout(timer);
  }
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--endpoint") result.endpoint = values[++index] || "";
    else if (value === "--token-file") result.tokenFile = values[++index] || "";
  }
  return result;
}

function writeMessage(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
