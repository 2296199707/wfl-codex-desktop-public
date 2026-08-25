#!/usr/bin/env node

import fs from "node:fs";

const tracePath = process.env.CAPTURE_MCP_TRACE;
let buffer = "";
let nextRequestId = 1000;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    appendTrace({ direction: "in", message });
    handle(message);
  }
});

function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "capture-mcp", version: "1" },
    });
    return;
  }
  if (message.method === "notifications/initialized" || message.method === "ping") {
    if (Object.hasOwn(message, "id")) reply(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [{
        name: "capture",
        description: "Capture the exact MCP call envelope.",
        inputSchema: { type: "object", additionalProperties: true },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    reply(message.id, {
      content: [{ type: "text", text: "capture-ok" }],
      structuredContent: { captured: true },
      isError: false,
    });
    return;
  }
  if (Object.hasOwn(message, "id")) {
    reply(message.id, { error: { code: -32601, message: "Method not found" } });
  }
}

function reply(id, result) {
  const message = { jsonrpc: "2.0", id, result };
  appendTrace({ direction: "out", message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function appendTrace(entry) {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
}

void nextRequestId;
