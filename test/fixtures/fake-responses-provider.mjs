import http from "node:http";
import { once } from "node:events";

export async function startFakeResponsesProvider({ apiKey = "sk-fake-provider-secret" } = {}) {
  const requests = [];
  const connections = new Set();
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (requestUrl.pathname === "/v1/models" && request.method === "GET") {
        if (!authorized(request, apiKey)) return sendJson(response, 401, { error: apiKey });
        return sendJson(response, 200, {
          object: "list",
          data: [{ id: "fake-model" }, { id: "fake-reasoning" }, { id: "fake-model" }],
        });
      }
      if (requestUrl.pathname !== "/v1/responses" || request.method !== "POST") {
        return sendJson(response, 404, { error: "not found" });
      }
      if (!authorized(request, apiKey)) return sendJson(response, 401, { error: apiKey });

      const raw = await readBody(request);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(response, 400, { error: "invalid request" });
      }
      requests.push({ body, authorization: request.headers.authorization || null });

      if (body.model === "fake-401") return sendJson(response, 401, { error: apiKey });
      if (body.model === "fake-429") return sendJson(response, 429, { error: "rate limited" });
      if (body.model === "wfl-suite-invalid-model") return sendJson(response, 400, { error: "invalid model" });
      if (body.model === "fake-invalid-json") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        return response.end("{invalid-json");
      }
      if (body.model === "fake-oversized") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        return response.end(`{"output_text":"${"x".repeat(33 * 1024 * 1024)}"}`);
      }
      if (body.model === "fake-timeout") return undefined;
      if (body.model === "fake-disconnect") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n");
        return response.end();
      }

      if (body.stream === true) return sendStream(response, body, apiKey);
      return sendJson(response, 200, responsePayload(body, apiKey));
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: String(error.message || "fake provider error") });
      else response.destroy();
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseUrl,
    apiKey,
    requests,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function authorized(request, apiKey) {
  return request.headers.authorization === `Bearer ${apiKey}`;
}

function responsePayload(body, apiKey) {
  const inputText = inputAsText(body.input);
  const hasCompactionInput = Array.isArray(body.input)
    && body.input.some((item) => item?.type === "compaction");
  if (body.context_management?.some((entry) => entry?.type === "compaction") || hasCompactionInput) {
    return {
      id: "resp_compaction_1",
      status: "completed",
      output_text: "Fake Responses provider compacted context.",
      output: [
        {
          type: "compaction",
          id: "item_compaction_1",
          encrypted_content: "opaque-fake-encrypted-context",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fake Responses provider compacted context." }],
        },
      ],
      usage: usage(9, 8),
    };
  }
  if (body.text?.format?.type === "json_schema") {
    return {
      id: "resp_structured_1",
      status: "completed",
      output_text: JSON.stringify({ ok: true }),
      usage: usage(7, 8),
    };
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const outputItems = body.input && Array.isArray(body.input)
      ? body.input.filter((item) => item?.type === "function_call_output")
      : [];
    if (outputItems.length) {
      const output = outputItems.map((item) => String(item.output || "")).join(" ");
      return {
        id: "resp_tool_result_1",
        status: "completed",
        output_text: output.includes("42")
          ? "The value is 42."
          : output.includes("value")
            ? "The value is 42."
          : output.includes("failure") || output.includes("失败")
            ? "继续处理了工具失败。"
            : "Tool result received.",
        usage: usage(12, 7),
      };
    }
    const tool = body.tools[0];
    const args = tool.name.includes("calc")
      ? { expression: "2 + 3 * 4" }
      : tool.name.includes("query")
        ? { key: "color" }
        : {};
    return {
      id: "resp_tool_call_1",
      status: "completed",
      output: [{
        type: "function_call",
        id: "fc_fake_1",
        call_id: "call_fake_1",
        name: tool.name,
        arguments: JSON.stringify(args),
      }],
      usage: usage(6, 4),
    };
  }
  return {
    id: "resp_text_1",
    status: "completed",
    output_text: inputText.includes("echo-secret")
      ? `echo ${apiKey}`
      : inputText.includes("42") ? "The value is 42." : "Fake Responses provider is ready.",
    usage: usage(5, 6),
  };
}

function sendStream(response, body, apiKey) {
  const payload = responsePayload({ ...body, stream: false }, apiKey);
  const text = payload.output_text || "Fake stream response.";
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache");
  const events = [
    { type: "response.created", response: { id: "resp_stream_1", status: "in_progress" } },
    { type: "response.output_text.delta", delta: text.slice(0, 8) },
    { type: "response.output_text.delta", delta: text.slice(8) },
    {
      type: "response.completed",
      response: {
        id: "resp_stream_1",
        status: "completed",
        usage: payload.usage,
        output: payload.output || [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      },
    },
  ];
  for (const event of events) {
    const encoded = `data: ${JSON.stringify(event)}\n\n`;
    response.write(encoded.slice(0, Math.max(1, Math.floor(encoded.length / 2))));
    response.write(encoded.slice(Math.max(1, Math.floor(encoded.length / 2))));
  }
  response.end("data: [DONE]\n\n");
}

function inputAsText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item?.content === "string") return item.content;
    if (Array.isArray(item?.content)) return item.content.map((entry) => entry?.text || "").join(" ");
    return item?.output || "";
  }).join(" ");
}

function usage(inputTokens, outputTokens) {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
