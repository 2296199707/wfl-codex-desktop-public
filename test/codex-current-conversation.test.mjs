import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repository = path.resolve(new URL("..", import.meta.url).pathname);

test("installed Codex handles website GPT-6 tool turns, active reads, steer and interrupt", {
  timeout: 45_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-current-"));
  const project = path.join(root, "projects", "workspace");
  const codexHome = path.join(root, "codex-home");
  const runtime = path.join(root, "runtime");
  const requests = [];
  const providerErrors = [];
  const provider = http.createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      assert.ok(requests.length <= 5, "bounded local provider request count");
      assert.equal(body.model, "gpt-6-astra");
      assert.equal(body.stream, true);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
      const responseId = `resp_compat_${requests.length}`;
      event({ type: "response.created", response: { id: responseId, status: "in_progress" } });
      // The next turn stays open until the website sends a native interrupt.
      if (requests.length >= 3) return;

      let item;
      if (requests.length === 1) {
        const declared = body.tools || body.input.filter((entry) => entry.type === "additional_tools").flatMap((entry) => entry.tools);
        const tools = declared.flatMap((tool) => tool.type === "namespace"
          ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name }))
          : [tool]);
        const tool = tools.find((entry) => ["exec_command", "shell_command", "shell"].includes(entry.name))
          || tools.find((entry) => entry.name === "exec");
        assert.ok(tool, `native execution tool is available: ${tools.map((entry) => entry.name).join(", ")}`);
        const args = tool.name === "exec_command"
          ? { cmd: "printf WFL_COMPAT_TOOL_OK", max_output_tokens: 64 }
          : tool.name === "shell_command"
            ? { command: "printf WFL_COMPAT_TOOL_OK" }
            : { command: ["/bin/echo", "WFL_COMPAT_TOOL_OK"] };
        item = {
          type: "function_call", id: "fc_compat", call_id: "call_compat", name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          arguments: JSON.stringify(args),
        };
        if (tool.name === "exec") {
          delete item.arguments;
          item.type = "custom_tool_call";
          item.input = 'text(await tools.exec_command({cmd: "printf WFL_COMPAT_TOOL_OK", max_output_tokens: 64}));';
        }
      } else {
        const returned = body.input.find((entry) => ["function_call_output", "custom_tool_call_output"].includes(entry.type)
          && (entry.call_id === "call_compat" || entry.name === "exec"));
        assert.ok(returned, "tool result reaches the same provider");
        assert.match(JSON.stringify(returned.output), /WFL_COMPAT_TOOL_OK/);
        item = {
          type: "message", id: "msg_compat", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "WFL_COMPAT_OK", annotations: [] }],
        };
        event({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } });
        event({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "WFL_COMPAT_OK" });
      }
      event({ type: "response.output_item.done", output_index: 0, item });
      event({
        type: "response.completed",
        response: {
          id: responseId, status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      response.end();
    } catch (error) {
      providerErrors.push(error.message);
      response.destroy();
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let child;
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.kill("SIGTERM");
      await stopped;
      clearTimeout(force);
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), [
    'model = "gpt-6-astra"',
    'model_provider = "compatibility"',
    'model_reasoning_effort = "low"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '[model_providers.compatibility]',
    'name = "Local compatibility fixture"',
    `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join("\n"));
  const authFile = path.join(root, "auth.json");
  await writeAuth(authFile, createAuthRecord("owner", "compatibility-owner-password"));
  const portReservation = http.createServer();
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const port = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test",
      CODEX_DESKTOP_PROJECT_ROOT: path.dirname(project),
      CODEX_DESKTOP_PROJECT_ROOTS: path.dirname(project),
      CODEX_DESKTOP_DEFAULT_PROJECT: project,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: path.join(root, "state"),
      CODEX_DESKTOP_RUNTIME_DIR: runtime,
      CODEX_DESKTOP_SOURCE_DIR: repository,
      CODEX_DESKTOP_MULTI_USER_ROOT: path.join(root, "users"),
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_DISABLE_CODEX: "0",
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "0",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: path.join(repository, "test", "fixtures", "fake-claude-control.mjs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8_000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8_000); });
  await waitFor(() => output.includes("WFL Codex Desktop v"), () => output);
  const login = await fetch(`${baseUrl}/`, {
    headers: { Authorization: `Basic ${Buffer.from("owner:compatibility-owner-password").toString("base64")}` },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const messages = [];
  socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, { headers: { Cookie: cookie, Origin: baseUrl } });
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(socket, "open");
  await waitFor(() => messages.find((entry) => entry.type === "bridge/status" && entry.payload.status === "ready"), () => output);
  let nextId = 0;
  const rpc = async (method, params) => {
    const requestId = ++nextId;
    socket.send(JSON.stringify({ type: "rpc", requestId, method, params }));
    const reply = await waitFor(() => messages.find((entry) => entry.requestId === requestId), () => `${method}: ${output}`);
    assert.equal(reply.type, "rpc/result", `${method}: ${reply.message}`);
    return reply.result;
  };
  const started = await rpc("thread/start", { cwd: project, model: "gpt-6-astra", approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  await rpc("thread/settings/update", { threadId, model: "gpt-6-astra", effort: "low" });
  const startTurn = (text, id) => rpc("turn/start", {
    threadId, cwd: project, model: "gpt-6-astra", effort: "low",
    clientUserMessageId: id, _wflThreadLeaseOwnerId: "compatibility-window",
    input: [{ type: "text", text, text_elements: [] }],
  });
  const first = await startTurn("Run the local compatibility check.", "compatibility-first");
  await waitFor(() => messages.find((entry) => entry.type === "codex/notification"
    && entry.payload?.method === "turn/completed" && entry.payload.params.turn.id === first.turn.id),
  () => JSON.stringify({ providerErrors, requests: requests.length, output }));
  assert.deepEqual(providerErrors, []);
  assert.equal(requests.length, 2);
  const read = await rpc("thread/read", { threadId, includeTurns: true });
  assert.match(JSON.stringify(read.thread.turns), /WFL_COMPAT_OK/);
  assert.match(JSON.stringify(read.thread.turns), /commandExecution/);
  const active = await startTurn("Hold for a follow-up instruction.", "compatibility-second");
  await waitFor(() => requests.length >= 3, () => output);
  const other = await rpc("thread/start", { cwd: project, model: "gpt-6-astra" });
  assert.notEqual(other.thread.id, threadId);
  const activeRead = await rpc("thread/read", { threadId, includeTurns: true });
  assert.equal(activeRead.thread.id, threadId);
  await rpc("turn/steer", {
    threadId, expectedTurnId: active.turn.id, clientUserMessageId: "compatibility-steer",
    _wflProjectCwd: project,
    input: [{ type: "text", text: "Keep the check local.", text_elements: [] }],
  });
  await rpc("turn/interrupt", { threadId, turnId: active.turn.id });
  const stopped = await waitFor(() => messages.find((entry) => entry.type === "codex/notification"
    && entry.payload?.method === "turn/completed" && entry.payload.params.turn.id === active.turn.id), () => output);
  assert.equal(stopped.payload.params.turn.status, "interrupted");
  const resumed = await rpc("thread/resume", { threadId, cwd: project });
  assert.equal(resumed.thread.id, threadId);
  assert.deepEqual(providerErrors, []);
});

async function waitFor(predicate, describe) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Compatibility check timed out: ${describe()}`);
}
