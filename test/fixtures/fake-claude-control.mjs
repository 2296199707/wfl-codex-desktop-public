#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
import crypto from "node:crypto";
import path from "node:path";

const backgroundConfig = process.env.CLAUDE_CONFIG_DIR;
const backgroundId = "ba5eba11";
const backgroundSessionId = "44444444-4444-4444-8444-444444444444";
const backgroundStatePath = backgroundConfig
  ? path.join(backgroundConfig, "jobs", backgroundId, "state.json")
  : null;
const backgroundTranscriptPath = backgroundConfig
  ? path.join(backgroundConfig, "projects", "-browser-fixture", `${backgroundSessionId}.jsonl`)
  : null;

async function readBackgroundState() {
  if (!backgroundStatePath) return null;
  try {
    return JSON.parse(await fs.readFile(backgroundStatePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeBackgroundState(state) {
  await fs.mkdir(path.dirname(backgroundStatePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(backgroundStatePath), 0o700);
  await fs.writeFile(backgroundStatePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await fs.chmod(backgroundStatePath, 0o600);
}

if (process.argv[2] === "--bg") {
  const nameIndex = process.argv.indexOf("--name");
  const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : "Browser background fixture";
  const prompt = process.argv.at(-1);
  const now = new Date().toISOString();
  await writeBackgroundState({
    daemonShort: backgroundId,
    sessionId: backgroundSessionId,
    cwd: process.cwd(),
    name,
    state: "working",
    status: "busy",
    tempo: "active",
    detail: "正在检查浏览器回归",
    needs: "",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    linkScanPath: backgroundTranscriptPath,
  });
  await fs.mkdir(path.dirname(backgroundTranscriptPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(backgroundTranscriptPath), 0o700);
  await fs.writeFile(backgroundTranscriptPath, [
    JSON.stringify({ type: "user", message: { content: prompt } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "后台检查正在运行。" }] } }),
  ].join("\n") + "\n", { mode: 0o600 });
  await fs.chmod(backgroundTranscriptPath, 0o600);
  process.stdout.write(`backgrounded · ${backgroundId} · ${name}\n`);
  process.exit(0);
}

if (process.argv[2] === "agents") {
  const state = await readBackgroundState();
  const cwdIndex = process.argv.indexOf("--cwd");
  const requestedCwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : null;
  const agents = state && (!requestedCwd || requestedCwd === state.cwd)
    ? [{
      id: backgroundId,
      sessionId: state.sessionId,
      cwd: state.cwd,
      name: state.name,
      state: state.state,
      status: state.status,
      startedAt: Date.parse(state.startedAt),
      updatedAt: Date.parse(state.updatedAt),
    }]
    : [];
  process.stdout.write(`${JSON.stringify(agents)}\n`);
  process.exit(0);
}

if (process.argv[2] === "stop") {
  const state = await readBackgroundState();
  if (!state || process.argv[3] !== backgroundId) process.exit(1);
  state.state = "stopped";
  state.status = "idle";
  state.tempo = "idle";
  state.detail = "任务已停止";
  state.updatedAt = new Date().toISOString();
  await writeBackgroundState(state);
  process.stdout.write(`stopped ${backgroundId}\n`);
  process.exit(0);
}

if (process.argv[2] === "plugin") {
  if (process.argv[3] === "marketplace" && process.argv[4] === "list") {
    process.stdout.write("[]\n");
  } else if (process.argv[3] === "list" && process.argv.includes("--available")) {
    process.stdout.write(JSON.stringify({ installed: [], available: [] }) + "\n");
  } else if (process.argv[3] === "list") {
    process.stdout.write(`${JSON.stringify([{ id: "review-kit@fixture-market", name: "review-kit", marketplace: "fixture-market", version: "1.2.3", scope: "user", enabled: true }])}\n`);
  } else if (process.env.FAKE_CLAUDE_PLUGIN_ACTIONS) {
    await fs.appendFile(process.env.FAKE_CLAUDE_PLUGIN_ACTIONS, `${JSON.stringify(process.argv.slice(2))}\n`);
  }
  process.exit(0);
}

if (process.argv[2] === "auto-mode") {
  const rules = {
    allow: ["Fixture allow rule"],
    soft_deny: ["Fixture soft deny rule"],
    hard_deny: ["Fixture hard deny rule"],
    environment: ["Fixture environment rule"],
  };
  if (process.argv[3] === "config" || process.argv[3] === "defaults") {
    process.stdout.write(`${JSON.stringify(rules)}\n`);
    process.exit(0);
  }
  if (process.argv[3] === "critique") {
    process.stdout.write("Fixture Auto Mode rules are focused.\n");
    process.exit(0);
  }
  if (process.argv[3] === "reset") {
    process.stdout.write("Fixture Auto Mode rules reset.\n");
    process.exit(0);
  }
  process.exit(1);
}

if (process.argv[2] === "ultrareview") {
  await new Promise((resolve) => setTimeout(resolve, 40));
  process.stdout.write(`${JSON.stringify({ bugs: [{ title: "Fixture review finding" }] })}\n`);
  process.exit(0);
}

if (process.argv[2] === "mcp" && process.argv[3] === "get") {
  process.stdout.write(`${process.argv[4]}: ✓ Connected\n`);
  process.exit(0);
}

if (process.argv.includes("auth") && process.argv.includes("status")) {
  process.stdout.write(`${JSON.stringify({
    loggedIn: true,
    authMethod: "fixture",
    email: "claude@example.test",
    subscriptionType: "max",
  })}\n`);
  process.exit(0);
}

if (process.argv[2] === "auth" && process.argv[3] === "login") {
  process.stdout.write("If the browser didn't open, visit: https://claude.com/oauth/authorize?fixture=server-browser\n");
  process.stdout.write("Paste code here if prompted > ");
  const loginInput = readline.createInterface({ input: process.stdin });
  const code = await new Promise((resolve) => loginInput.once("line", resolve));
  if (process.env.FAKE_CLAUDE_OFFICIAL_CODE) {
    await fs.writeFile(process.env.FAKE_CLAUDE_OFFICIAL_CODE, String(code).trim());
  }
  process.exit(String(code).trim() ? 0 : 1);
}

if (process.argv[2] === "auth" && process.argv[3] === "logout") {
  process.exit(0);
}

const sessionIndex = process.argv.indexOf("--session-id");
const resumeIndex = process.argv.indexOf("--resume");
const sessionId = sessionIndex !== -1
  ? process.argv[sessionIndex + 1]
  : resumeIndex !== -1 ? process.argv[resumeIndex + 1] : crypto.randomUUID();
const input = readline.createInterface({ input: process.stdin });
const pending = new Map();
let requestSequence = 0;

function write(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function finishTurn(label) {
  const messageId = `fixture-message-${requestSequence}`;
  write({ type: "assistant", session_id: sessionId, message: {
    id: messageId,
    content: [{ type: "text", text: label }],
  } });
  write({ type: "prompt_suggestion", session_id: sessionId, suggestion: "Review the next fixture" });
  write({
    type: "result",
    uuid: `fixture-result-${requestSequence}`,
    session_id: sessionId,
    result: label,
    duration_ms: 20,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 10 },
  });
}

input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    write({ type: "control_response", response: {
      subtype: "success",
      request_id: message.request_id,
      response: {},
    } });
    return;
  }
  if (message.type === "control_request" && message.request?.subtype === "rewind_files") {
    const response = message.request.dry_run === false
      ? { canRewind: true, skippedLinks: 1 }
      : {
        canRewind: true,
        filesChanged: [
          path.join(process.cwd(), "src", "fixture.js"),
          path.join(process.cwd(), "README.md"),
          path.join(process.cwd(), "..", "outside-secret.txt"),
        ],
        insertions: 7,
        deletions: 3,
      };
    write({ type: "control_response", response: {
      subtype: "success",
      request_id: message.request_id,
      response,
    } });
    return;
  }
  if (message.type === "control_response") {
    const kind = pending.get(message.response.request_id);
    if (!kind) return;
    pending.delete(message.response.request_id);
    await fs.appendFile(process.env.FAKE_CLAUDE_RESPONSES, `${JSON.stringify(message)}\n`);
    finishTurn(kind === "question"
      ? "Question answered."
      : kind === "dialog"
        ? "Fallback choice handled."
        : kind === "elicitation-url"
          ? "URL elicitation handled."
          : kind === "elicitation-form"
            ? (message.response.response.action === "cancel" ? "Elicitation cancelled." : "Form elicitation handled.")
            : kind === "elicitation-invalid" ? "Invalid elicitation cancelled." : "Permission handled.");
    return;
  }
  if (message.type !== "user") return;
  if (process.env.FAKE_CLAUDE_INPUTS) {
    await fs.appendFile(process.env.FAKE_CLAUDE_INPUTS, `${JSON.stringify(message)}\n`);
  }
  requestSequence += 1;
  const text = String(message.message?.content || "");
  write({
    type: "user",
    uuid: `11111111-1111-4111-8111-${String(requestSequence).padStart(12, "0")}`,
    session_id: sessionId,
    message: { role: "user", content: text },
  });
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    permissionMode: "manual",
    model: "fixture-model",
  });
  write({
    type: "hook_started",
    uuid: `fixture-hook-started-${requestSequence}`,
    hook_id: `fixture-hook-${requestSequence}`,
    hook_event_name: "PreToolUse",
    hook_name: "Bash validation",
    status: "started",
  });
  write({
    type: "hook_response",
    uuid: `fixture-hook-response-${requestSequence}`,
    hook_id: `fixture-hook-${requestSequence}`,
    hook_event_name: "PreToolUse",
    hook_name: "Bash validation",
    outcome: "success",
  });
  if (text.trim() === "/compact") {
    write({ type: "system", subtype: "compact_boundary", session_id: sessionId, compact_metadata: { trigger: "manual" } });
    finishTurn("Context compacted.");
    return;
  }
  if (text.includes("coordinate Claude agents")) {
    const taskId = `fixture-agent-task-${requestSequence}`;
    const startedAt = Date.now() - 1_250;
    write({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: `fixture-agent-tool-${requestSequence}`,
      description: "Review the browser fixture",
      subagent_type: "Explore",
      task_type: "local_agent",
      workflow_name: "browser-review",
      started_at: startedAt,
    });
    write({
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      summary: "Inspecting responsive controls",
      last_tool_name: "Read",
      usage: { total_tokens: 180, tool_uses: 2, duration_ms: 700 },
      updated_at: startedAt + 700,
    });
    write({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status: "completed",
      summary: "Responsive review complete",
      usage: { total_tokens: 240, tool_uses: 3, duration_ms: 1_250 },
      completed_at: startedAt + 1_250,
    });
    finishTurn("Agent review complete.");
    return;
  }
  if (text.includes("elicitation url")) {
    const requestId = `browser-elicitation-url-${requestSequence}`;
    pending.set(requestId, "elicitation-url");
    write({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "elicitation",
        mcp_server_name: "fixture-oauth",
        mode: "url",
        message: "Authorize access to the fixture MCP service.",
        url: "https://example.test/mcp/authorize?state=browser-fixture",
        elicitation_id: `browser-url-${requestSequence}`,
        title: "Connect fixture service",
        display_name: "Fixture MCP",
      },
    });
    return;
  }
  if (text.includes("elicitation form")) {
    const requestId = `browser-elicitation-form-${requestSequence}`;
    pending.set(requestId, "elicitation-form");
    write({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "elicitation",
        mcp_server_name: "fixture-deploy",
        mode: "form",
        message: "Choose deployment settings for the fixture MCP service.",
        title: "Deployment settings",
        description: "These values are returned only to Fixture MCP.",
        requested_schema: {
          type: "object",
          properties: {
            environment: {
              type: "string",
              title: "Environment",
              description: "Target environment",
              enum: ["staging", "production"],
              default: "staging",
            },
            replicas: {
              type: "integer",
              title: "Replicas",
              description: "Number of service replicas",
              minimum: 1,
              maximum: 5,
              default: 2,
            },
            alerts: {
              type: "boolean",
              title: "Enable alerts",
              default: true,
            },
            note: {
              type: "string",
              title: "Release note",
              maxLength: 240,
            },
          },
          required: ["environment", "replicas"],
        },
      },
    });
    return;
  }
  if (text.includes("elicitation invalid")) {
    const requestId = `browser-elicitation-invalid-${requestSequence}`;
    pending.set(requestId, "elicitation-invalid");
    write({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "elicitation",
        mcp_server_name: "fixture-invalid",
        mode: "form",
        message: "Unsafe nested fixture schema",
        requested_schema: {
          type: "object",
          properties: { nested: { type: "object", properties: {} } },
        },
      },
    });
    return;
  }
  if (text.includes("fallback")) {
    const requestId = `browser-dialog-${requestSequence}`;
    pending.set(requestId, "dialog");
    write({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "request_user_dialog",
        dialog_kind: "refusal_fallback_prompt",
        payload: {
          originalModel: "claude-opus-test",
          fallbackModel: "claude-sonnet-test",
          apiRefusalCategory: "cyber",
          guidanceText: "Choose how Claude should continue this task.",
          retractedMessageUuids: ["fixture-retracted-message"],
        },
      },
    });
    return;
  }
  if (text.includes("question")) {
    const requestId = `browser-question-${requestSequence}`;
    pending.set(requestId, "question");
    write({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        display_name: "AskUserQuestion",
        tool_use_id: `tool-question-${requestSequence}`,
        requires_user_interaction: true,
        input: {
          questions: [{
            question: "Which layout should Claude use?",
            header: "Layout",
            options: [
              { label: "Compact", description: "Keep the interface concise" },
              { label: "Detailed", description: "Show all execution details" },
            ],
            multiSelect: false,
          }],
        },
      },
    });
    return;
  }
  const requestId = `browser-permission-${requestSequence}`;
  pending.set(requestId, "permission");
  write({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      display_name: "Run command",
      title: "Claude wants to run npm test",
      description: "Runs the project test suite in the current workspace.",
      decision_reason: "The command requires shell access.",
      input: { command: "npm test" },
      tool_use_id: `tool-permission-${requestSequence}`,
      permission_suggestions: [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        behavior: "allow",
        destination: "session",
      }],
    },
  });
});
