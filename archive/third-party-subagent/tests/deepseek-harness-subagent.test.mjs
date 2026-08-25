import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { DeepSeekHarnessSubagentService } from "../lib/deepseek-harness-subagent.mjs";

async function makeRoot(prefix = "wfl-dsh-subagent-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function sessionArtifacts(root) {
  const found = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.name.startsWith("session.jsonl")) {
        found.push(target);
      }
    }
  };
  await visit(root);
  return found;
}

function serviceFor(root, { harnessFactory, resolveProvider = () => ({
  apiKey: "provider-test-key",
  baseUrl: "https://gateway.example.test/v1",
  model: "provider-test-model",
  wireApi: "openai-responses",
}), resolveExecutionContext = () => ({
  cwd: path.join(root, "project"),
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
}) } = {}) {
  return new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "test-user",
    home: path.join(root, "home"),
    project: path.join(root, "project"),
    configPath: path.join(root, "cordis.yml"),
    resolveProvider,
    resolveExecutionContext,
    harnessFactory,
  });
}

function request(service, input = {}) {
  return service.execute(JSON.stringify({
    version: 1,
    authToken: service.authToken,
    parentThreadId: "test-parent-thread",
    parentTurnId: "test-parent-turn",
    description: "bounded test task",
    prompt: "inspect the supplied workspace and report the result",
    ...input,
  }));
}

function openAiResponsesEvents(text) {
  const message = {
    id: "msg_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", annotations: [], logprobs: [], text }],
  };
  const completed = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: "gpt-test-model",
    output: [message],
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    },
    user: null,
    metadata: {},
  };
  const part = message.content[0];
  return [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: "response.content_part.done", item_id: message.id, output_index: 0, content_index: 0, part },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: completed },
  ];
}

test("official Harness calls use start, run, and close exactly once", async () => {
  const root = await makeRoot();
  const calls = [];
  const harnessFactory = (options) => ({
    async start() {
      calls.push(["start", options]);
    },
    async run(prompt, options) {
      calls.push(["run", prompt, options]);
      return { finalResponse: "verified" };
    },
    async close() {
      calls.push(["close"]);
    },
  });
  const service = serviceFor(root, { harnessFactory });
  try {
    const result = await request(service);
    assert.deepEqual(result, { finalResponse: "verified" });
    assert.deepEqual(calls.map(([name]) => name), ["start", "run", "close"]);
    assert.equal(calls[0][1].cwd, path.join(root, "project"));
    assert.equal(calls[0][1].provider, "wfl-third-party");
    assert.equal(calls[0][1].launch.env.HOME, path.join(root, "home"));
    assert.equal(calls[0][1].launch.env.TMPDIR, path.join(root, "home", "tmp"));
    assert.equal(calls[0][1].launch.env.WFL_SUBAGENT_API, "openai-responses");
    assert.equal(calls[0][1].launch.env.WFL_SUBAGENT_SANDBOX_MODE, "workspace-write");
    assert.equal(Object.hasOwn(calls[0][1].launch.env, "WFL_SUBAGENT_APPROVAL_POLICY"), false);
    assert.equal(calls[0][1].launch.env.WFL_SUBAGENT_API_KEY, "provider-test-key");
    assert.equal(Object.hasOwn(calls[0][1].launch.env, "DEEPSEEK_API_KEY"), false);
    assert.equal(calls[1][1], "inspect the supplied workspace and report the result");
    assert.doesNotMatch(calls[1][1], /bounded test task|Task description|Task instructions/u);
    assert.match(calls[1][2].sessionId, /^wfl-subagent-[a-f0-9]{32}$/u);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a live service observes provider enable, replacement, and disable without restarting", async () => {
  const root = await makeRoot("wfl-dsh-live-settings-test-");
  let provider = null;
  let created = 0;
  const service = serviceFor(root, {
    resolveProvider: () => provider,
    harnessFactory: () => {
      created += 1;
      return {
        start: async () => {},
        run: async () => ({ finalResponse: "live settings observed" }),
        close: async () => {},
      };
    },
  });
  try {
    const socketPath = await service.start();
    await assert.rejects(request(service), (error) => {
      assert.equal(error.code, "SUBAGENT_PROVIDER_UNAVAILABLE");
      return true;
    });

    provider = {
      apiKey: "enabled-provider-key",
      baseUrl: "https://gateway.example.test/v1",
      model: "model-a",
      wireApi: "openai-responses",
    };
    assert.deepEqual(await request(service), { finalResponse: "live settings observed" });

    provider = {
      ...provider,
      apiKey: "replacement-provider-key",
      model: "model-b",
      wireApi: "openai-completions",
    };
    assert.deepEqual(await request(service), { finalResponse: "live settings observed" });

    provider = null;
    await assert.rejects(request(service), (error) => {
      assert.equal(error.code, "SUBAGENT_PROVIDER_UNAVAILABLE");
      return true;
    });
    assert.equal(created, 2);
    assert.equal(await service.start(), socketPath);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the pinned official runtime completes one real call through a fake DeepSeek SSE endpoint", async () => {
  const root = await makeRoot("wfl-dsh-real-runtime-test-");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: "real fake-runtime result" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(path.join(root, "project"), { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "real-runtime-test-user",
    home: path.join(root, "home"),
    project: path.join(root, "project"),
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-runtime-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "deepseek-test-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: () => ({
      cwd: path.join(root, "project"),
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    }),
  });
  try {
    const result = await request(service, {
      description: "real runtime integration probe",
      prompt: "Return the short final result after one model request.",
    });
    assert.deepEqual(result, { finalResponse: "real fake-runtime result" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].body.model, "deepseek-test-model");
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(await sessionArtifacts(service.sessionRoot), []);
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("official continuable background start returns its child and settles once without a host model call", async () => {
  const root = await makeRoot("wfl-dsh-continuable-runtime-test-");
  const project = path.join(root, "project");
  const requests = [];
  const settlements = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: "continuable fake result" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "continuable-runtime-test-user",
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-continuable-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "fake-continuable-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
    onSettlement: (settlement) => settlements.push(settlement),
  });
  try {
    const result = await request(service, {
      runInBackground: true,
      description: "official continuable background probe",
      prompt: "Return one short result.",
    });
    assert.equal(result.mode, "continuable");
    assert.match(String(result.childId), /^[0-9a-f-]{36}$/u);
    for (let attempt = 0; attempt < 200 && settlements.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].childId, result.childId);
    assert.equal(settlements[0].parentThreadId, "test-parent-thread");
    assert.equal(settlements[0].stopReason, "completed");
    assert.equal(settlements[0].finalResponse, "continuable fake result");
    assert.equal(requests.length, 1);
    const bindingPath = path.join(service.directory, "host-bindings.json");
    const bindingStat = await fs.stat(bindingPath);
    assert.equal(bindingStat.mode & 0o777, 0o600);
    const bindings = JSON.parse(await fs.readFile(bindingPath, "utf8"));
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].parentThreadId, "test-parent-thread");
    assert.equal(bindings[0].hostId.startsWith("wfl-codex-host-"), true);
    assert.equal(bindings[0].cwd, project);
    assert.equal(bindings[0].sandboxMode, "read-only");
    assert.doesNotMatch(await fs.readFile(bindingPath, "utf8"), /fake-continuable-key|Bearer|token/iu);
    await assert.rejects(
      service.execute(JSON.stringify({
        version: 1,
        authToken: service.authToken,
        operation: "interrupt_agent",
        parentThreadId: "different-parent-thread",
        childId: result.childId,
      })),
      (error) => {
        assert.equal(error.code, "SUBAGENT_UNAUTHORIZED");
        return true;
      },
    );
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("control authorization is checked even when the wrong parent Host is already resident", async () => {
  const root = await makeRoot("wfl-dsh-host-authorization-test-");
  const project = path.join(root, "project");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: "authorization probe" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "host-authorization-test-user",
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-host-authorization-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "fake-host-authorization-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
  });
  try {
    const first = await request(service, {
      parentThreadId: "parent-a",
      parentTurnId: "turn-a",
      runInBackground: true,
    });
    const second = await request(service, {
      parentThreadId: "parent-b",
      parentTurnId: "turn-b",
      runInBackground: true,
    });
    assert.equal(first.mode, "continuable");
    assert.equal(second.mode, "continuable");
    for (let attempt = 0; attempt < 200 && requests.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(
      service.execute(JSON.stringify({
        version: 1,
        authToken: service.authToken,
        operation: "interrupt_agent",
        parentThreadId: "parent-b",
        childId: first.childId,
      })),
      (error) => {
        assert.equal(error.code, "SUBAGENT_UNAUTHORIZED");
        return true;
      },
    );
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent continuable children produce one settlement per child without duplicates", async () => {
  const root = await makeRoot("wfl-dsh-settlement-concurrency-test-");
  const project = path.join(root, "project");
  const requests = [];
  const settlements = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    const text = parsed.messages?.some((message) => /second child/u.test(String(message.content)))
      ? "second child result"
      : "first child result";
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "settlement-concurrency-test-user",
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-settlement-concurrency-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "fake-settlement-concurrency-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
    onSettlement: (settlement) => settlements.push(settlement),
  });
  try {
    const [first, second] = await Promise.all([
      request(service, {
        description: "first concurrent child",
        prompt: "Return the first child result.",
        runInBackground: true,
      }),
      request(service, {
        description: "second concurrent child",
        prompt: "Return the second child result.",
        runInBackground: true,
      }),
    ]);
    const childIds = [first.childId, second.childId];
    assert.equal(new Set(childIds).size, 2);
    for (let attempt = 0; attempt < 400 && settlements.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settlements.length, 2);
    assert.deepEqual(new Set(settlements.map((entry) => entry.childId)), new Set(childIds));
    assert.ok(settlements.every((entry) => entry.parentThreadId === "test-parent-thread"));
    assert.ok(settlements.every((entry) => entry.stopReason === "completed"));
    assert.equal(new Set(settlements.map((entry) => entry.runId)).size, 2);
    assert.equal(requests.length, 2);
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("independent parent Hosts keep cwd and sandbox policy isolated in one runtime", async () => {
  const root = await makeRoot("wfl-dsh-parent-isolation-test-");
  const projectOne = path.join(root, "project-one");
  const projectTwo = path.join(root, "project-two");
  const requests = [];
  const requestCounts = new Map();
  const settlements = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const serialized = JSON.stringify(parsed);
    const label = serialized.includes("parent-one") ? "one" : "two";
    const count = (requestCounts.get(label) || 0) + 1;
    requestCounts.set(label, count);
    requests.push({ label, body: parsed });
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    if (count === 1) {
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl_isolation_${label}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "parent-isolation-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: `call_write_${label}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  file_path: `${label}-cwd-proof.txt`,
                  content: `${label} workspace\n`,
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl_isolation_${label}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "parent-isolation-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl_isolation_result_${label}`,
        object: "chat.completion.chunk",
        created: 2,
        model: "parent-isolation-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: `${label} isolated` },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl_isolation_result_${label}`,
        object: "chat.completion.chunk",
        created: 2,
        model: "parent-isolation-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(projectOne, { recursive: true }),
    fs.mkdir(projectTwo, { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "parent-isolation-test-user",
    home: path.join(root, "home"),
    project: projectOne,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-parent-isolation-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "parent-isolation-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: (parentThreadId) => ({
      cwd: parentThreadId === "parent-one" ? projectOne : projectTwo,
      sandboxMode: parentThreadId === "parent-one" ? "workspace-write" : "read-only",
      approvalPolicy: "never",
    }),
    onSettlement: (settlement) => settlements.push(settlement),
  });
  try {
    const [first, second] = await Promise.all([
      request(service, {
        parentThreadId: "parent-one",
        parentTurnId: "turn-one",
        description: "parent-one workspace write",
        prompt: "Write the parent-one proof file.",
        runInBackground: true,
      }),
      request(service, {
        parentThreadId: "parent-two",
        parentTurnId: "turn-two",
        description: "parent-two read-only probe",
        prompt: "Write the parent-two proof file.",
        runInBackground: true,
      }),
    ]);
    assert.equal(first.mode, "continuable");
    assert.equal(second.mode, "continuable");
    for (let attempt = 0; attempt < 400 && settlements.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settlements.length, 2);
    assert.equal(await fs.readFile(path.join(projectOne, "one-cwd-proof.txt"), "utf8"), "one workspace\n");
    await assert.rejects(fs.access(path.join(projectTwo, "one-cwd-proof.txt")));
    await assert.rejects(fs.access(path.join(projectTwo, "two-cwd-proof.txt")));
    // The read-only child still receives a model turn after the attempted
    // write so Harness can report the sandbox denial and obtain its final
    // response. The denied tool call must not be mistaken for a lost or
    // cross-parent request.
    assert.equal(requests.length, 4);
    assert.equal(requestCounts.get("one"), 2);
    assert.equal(requestCounts.get("two"), 2);
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a persisted continuable child can be listed and cold-resumed after runtime restart", async () => {
  const root = await makeRoot("wfl-dsh-cold-resume-test-");
  const project = path.join(root, "project");
  const requests = [];
  let releaseInitial;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    if (requests.length === 1) await initialGate;
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: "cold resume result" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const provider = () => ({
    apiKey: "fake-cold-resume-key",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    model: "fake-cold-resume-model",
    wireApi: "openai-completions",
  });
  const makeService = (settlements) => new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "cold-resume-test-user",
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: provider,
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
    onSettlement: (settlement) => settlements.push(settlement),
  });
  const firstService = makeService([]);
  let secondService = null;
  try {
    const started = await request(firstService, {
      parentThreadId: "cold-parent",
      parentTurnId: "cold-turn-1",
      runInBackground: true,
      description: "persist a child before runtime restart",
      prompt: "Start the child and wait for the runtime restart.",
    });
    assert.equal(started.mode, "continuable");
    for (let attempt = 0; attempt < 200 && requests.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 1);
    await firstService.close();
    releaseInitial();

    const settlements = [];
    secondService = makeService(settlements);
    const listed = await secondService.execute(JSON.stringify({
      version: 1,
      authToken: secondService.authToken,
      operation: "list_agents",
      parentThreadId: "cold-parent",
      scope: "children",
    }));
    assert.ok(listed.entries.some((entry) => entry.id === started.childId));

    const sent = await secondService.execute(JSON.stringify({
      version: 1,
      authToken: secondService.authToken,
      operation: "send_message",
      parentThreadId: "cold-parent",
      childId: started.childId,
      message: "Continue after the runtime restart and return the result.",
    }));
    assert.match(sent.messageId, /^[0-9a-f-]{36}$/u);
    for (let attempt = 0; attempt < 400 && settlements.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].childId, started.childId);
    assert.equal(settlements[0].finalResponse, "cold resume result");
    assert.equal(requests.length, 2);
  } finally {
    releaseInitial();
    await firstService.close();
    await secondService?.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cold recovery resolves the persisted provider owner before switching to the selected provider", async () => {
  const root = await makeRoot("wfl-dsh-cold-provider-owner-test-");
  const project = path.join(root, "project");
  const requests = [];
  const resolveCalls = [];
  let releaseInitial;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    if (requests.length === 1) await initialGate;
    const text = parsed.model === "provider-a-model"
      ? "provider-a resumed"
      : "provider-b foreground";
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const providers = {
    "provider-a": {
      providerId: "provider-a",
      apiKey: "provider-a-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "provider-a-model",
      wireApi: "openai-completions",
    },
    "provider-b": {
      providerId: "provider-b",
      apiKey: "provider-b-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "provider-b-model",
      wireApi: "openai-completions",
    },
  };
  let selectedProviderId = "provider-a";
  const resolveProvider = (providerId = null) => {
    resolveCalls.push(providerId);
    return providers[providerId || selectedProviderId];
  };
  const makeService = (settlements) => new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "cold-provider-owner-test-user",
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider,
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
    onSettlement: (settlement) => settlements.push(settlement),
  });
  const firstService = makeService([]);
  let secondService = null;
  try {
    const started = await request(firstService, {
      parentThreadId: "cold-provider-parent",
      parentTurnId: "cold-provider-turn-1",
      runInBackground: true,
      description: "persist provider A ownership",
      prompt: "Start the child and wait for a runtime restart.",
    });
    assert.equal(started.mode, "continuable");
    for (let attempt = 0; attempt < 200 && requests.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests[0].model, "provider-a-model");
    await firstService.close();
    releaseInitial();

    selectedProviderId = "provider-b";
    const settlements = [];
    secondService = makeService(settlements);
    const listed = await secondService.execute(JSON.stringify({
      version: 1,
      authToken: secondService.authToken,
      operation: "list_agents",
      parentThreadId: "cold-provider-parent",
      scope: "children",
    }));
    assert.ok(listed.entries.some((entry) => entry.id === started.childId));
    assert.ok(resolveCalls.includes("provider-a"), "cold recovery did not resolve the persisted provider id");
    assert.equal(requests.length, 1, "listing a child must not call the model");

    const sent = await secondService.execute(JSON.stringify({
      version: 1,
      authToken: secondService.authToken,
      operation: "send_message",
      parentThreadId: "cold-provider-parent",
      childId: started.childId,
      message: "Continue with provider A and return the result.",
    }));
    assert.match(sent.messageId, /^[0-9a-f-]{36}$/u);
    for (let attempt = 0; attempt < 400 && settlements.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].finalResponse, "provider-a resumed");
    assert.equal(requests[1].model, "provider-a-model");

    const completed = await request(secondService, {
      parentThreadId: "cold-provider-parent",
      parentTurnId: "cold-provider-turn-2",
      description: "switch only after the old child settles",
      prompt: "Return the provider B result.",
    });
    assert.deepEqual(completed, { finalResponse: "provider-b foreground" });
    assert.equal(requests[2].model, "provider-b-model");
  } finally {
    releaseInitial();
    await firstService.close();
    await secondService?.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("provider replacement does not kill a live child and switches only after it settles", async () => {
  const root = await makeRoot("wfl-dsh-provider-switch-test-");
  const project = path.join(root, "project");
  const requests = [];
  const settlements = [];
  let releaseInitial;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    if (requests.length === 1) await initialGate;
    const text = requests.length === 1 ? "old provider settled" : "new provider completed";
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const chunk of [
      { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await fs.mkdir(project, { recursive: true });
  let provider = {
    apiKey: "provider-a-key",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    model: "provider-a-model",
    wireApi: "openai-completions",
  };
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "provider-switch-test-user",
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => provider,
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
    onSettlement: (settlement) => settlements.push(settlement),
  });
  try {
    const started = await request(service, {
      parentThreadId: "provider-switch-parent",
      parentTurnId: "provider-switch-turn-1",
      runInBackground: true,
      description: "keep the old provider child alive",
      prompt: "Wait for the provider switch test to release you.",
    });
    assert.equal(started.mode, "continuable");
    for (let attempt = 0; attempt < 200 && requests.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "provider-a-model");

    provider = {
      ...provider,
      apiKey: "provider-b-key",
      model: "provider-b-model",
    };
    await assert.rejects(
      request(service, {
        parentThreadId: "provider-switch-parent",
        parentTurnId: "provider-switch-turn-2",
        runInBackground: true,
        description: "must wait for the old child",
        prompt: "This must not start while the first child is running.",
      }),
      (error) => {
        assert.equal(error.code, "SUBAGENT_PROVIDER_SWITCH_BUSY");
        return true;
      },
    );
    const listed = await request(service, {
      operation: "list_agents",
      parentThreadId: "provider-switch-parent",
      childId: started.childId,
      scope: "children",
    });
    assert.equal(listed.entries.find((entry) => entry.id === started.childId)?.activity, "running");
    assert.equal(requests.length, 1);

    releaseInitial();
    for (let attempt = 0; attempt < 300 && settlements.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].finalResponse, "old provider settled");

    const completed = await request(service, {
      parentThreadId: "provider-switch-parent",
      parentTurnId: "provider-switch-turn-3",
      description: "use the replacement provider after settlement",
      prompt: "Return the replacement-provider result.",
    });
    assert.deepEqual(completed, { finalResponse: "new provider completed" });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].model, "provider-b-model");
  } finally {
    releaseInitial();
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the pinned official runtime can execute a workspace write tool before returning", async () => {
  const root = await makeRoot("wfl-dsh-tool-runtime-test-");
  const project = path.join(root, "project");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ method: request.method, url: request.url, body: parsed });
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    if (requests.length === 1) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_tool_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-tool-test-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: "call_write_fixture",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  file_path: "harness-proof.txt",
                  content: "official Harness tool write succeeded\n",
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_tool_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-tool-test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_tool_result_fixture",
        object: "chat.completion.chunk",
        created: 2,
        model: "deepseek-tool-test-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "workspace tool verified" },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_tool_result_fixture",
        object: "chat.completion.chunk",
        created: 2,
        model: "deepseek-tool-test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "tool-runtime-test-user",
    home: path.join(root, "home"),
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-tool-runtime-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "deepseek-tool-test-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    }),
  });
  try {
    const result = await request(service, {
      description: "official runtime tool probe",
      prompt: "Create the requested proof file, then return the final result.",
    });
    assert.deepEqual(result, { finalResponse: "workspace tool verified" });
    assert.equal(await fs.readFile(path.join(project, "harness-proof.txt"), "utf8"), "official Harness tool write succeeded\n");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.ok(requests[0].body.tools.some((tool) => tool.function?.name === "write"));
    assert.ok(requests[1].body.messages.some((message) => message.role === "tool"));
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the pinned official runtime enforces an inherited read-only sandbox", async () => {
  const root = await makeRoot("wfl-dsh-read-only-runtime-test-");
  const project = path.join(root, "project");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    if (requests.length === 1) {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_read_only_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-read-only-test-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: "call_write_read_only_fixture",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  file_path: "read-only-proof.txt",
                  content: "this write must be denied\n",
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_read_only_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-read-only-test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_read_only_result_fixture",
        object: "chat.completion.chunk",
        created: 2,
        model: "deepseek-read-only-test-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "read-only denial observed" },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_read_only_result_fixture",
        object: "chat.completion.chunk",
        created: 2,
        model: "deepseek-read-only-test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(project, { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "read-only-runtime-test-user",
    home: path.join(root, "home"),
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-read-only-runtime-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "deepseek-read-only-test-model",
      wireApi: "openai-completions",
    }),
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
  });
  try {
    const result = await request(service, {
      description: "inherited read-only sandbox probe",
      prompt: "Attempt the requested write, then report the result.",
    });
    assert.deepEqual(result, { finalResponse: "read-only denial observed" });
    await assert.rejects(fs.access(path.join(project, "read-only-proof.txt")));
    assert.equal(requests.length, 2);
    const toolResult = requests[1].messages.find((message) => message.role === "tool");
    assert.match(String(toolResult?.content || ""), /sandbox.*denied|read-only/iu);
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the pinned official runtime completes one real call through a fake OpenAI Responses endpoint", async () => {
  const root = await makeRoot("wfl-dsh-responses-runtime-test-");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    for (const event of openAiResponsesEvents("gpt fake-runtime result")) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  await Promise.all([
    fs.mkdir(path.join(root, "home"), { recursive: true }),
    fs.mkdir(path.join(root, "project"), { recursive: true }),
  ]);
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(root, "service"),
    userId: "responses-runtime-test-user",
    home: path.join(root, "home"),
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "fake-responses-key",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "gpt-test-model",
      wireApi: "openai-responses",
    }),
    resolveExecutionContext: () => ({
      cwd: path.join(root, "project"),
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
  });
  try {
    const result = await request(service, {
      description: "Responses runtime integration probe",
      prompt: "Return the short final result after one model request.",
    });
    assert.deepEqual(result, { finalResponse: "gpt fake-runtime result" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/responses");
    assert.equal(requests[0].body.model, "gpt-test-model");
    assert.equal(requests[0].body.stream, true);
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("service start and close own only the per-user socket", async () => {
  const root = await makeRoot();
  const service = serviceFor(root, { harnessFactory: () => ({
    start: async () => {},
    run: async () => ({ finalResponse: "unused" }),
    close: async () => {},
  }) });
  try {
    const socketPath = await service.start();
    await fs.access(socketPath);
    const tokenStat = await fs.stat(service.authTokenPath);
    assert.equal(tokenStat.mode & 0o777, 0o600);
    assert.equal((await fs.readFile(service.authTokenPath, "utf8")).trim(), service.authToken);
    await service.close();
    await assert.rejects(fs.access(socketPath));
    await assert.rejects(fs.access(service.authTokenPath));
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("service start never removes an active socket owned by another instance", async () => {
  const root = await makeRoot("wfl-dsh-active-socket-");
  const service = serviceFor(root, { harnessFactory: () => ({
    start: async () => {},
    run: async () => ({ finalResponse: "unused" }),
    close: async () => {},
  }) });
  const blocker = net.createServer();
  try {
    await fs.mkdir(service.socketDirectory, { recursive: true });
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(service.socketPath, resolve);
    });
    await assert.rejects(
      service.start(),
      (error) => error.code === "SUBAGENT_SOCKET_IN_USE",
    );
    assert.equal((await fs.stat(service.socketPath)).isSocket(), true);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production-length runtime paths keep the Harness socket below the Unix limit", async () => {
  const root = await makeRoot("wfl-dsh-long-runtime-");
  const runtimeDirectory = path.join(root, "r".repeat(15));
  const userId = "u-0000000000000000";
  const project = path.join(root, "project");
  const service = new DeepSeekHarnessSubagentService({
    directory: path.join(runtimeDirectory, "deepseek-harness-subagents", userId),
    userId,
    home: path.join(root, "home"),
    project,
    configPath: path.resolve("config/deepseek-harness/cordis.yml"),
    resolveProvider: () => ({
      apiKey: "provider-test-key",
      baseUrl: "https://gateway.example.test/v1",
      model: "provider-test-model",
      wireApi: "openai-responses",
    }),
    resolveExecutionContext: () => ({
      cwd: project,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    }),
  });
  try {
    const socketPath = await service.start();
    assert.ok(Buffer.byteLength(socketPath) <= 107, `${socketPath} is too long`);
    await fs.access(socketPath);
    assert.match(socketPath, /\/dsh-sockets\/u-[a-f0-9]{12}\/dsh-[a-f0-9]{12}\.sock$/u);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Harness errors are propagated and the child is still closed", async () => {
  const root = await makeRoot();
  let closed = 0;
  const service = serviceFor(root, {
    harnessFactory: () => ({
      start: async () => {},
      run: async () => { throw new Error("model failed"); },
      close: async () => { closed += 1; },
    }),
  });
  try {
    await assert.rejects(request(service), /model failed/u);
    assert.equal(closed, 1);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("official non-completed turn reasons preserve partial output without reporting success", async () => {
  const root = await makeRoot();
  const service = serviceFor(root, {
    harnessFactory: () => ({
      start: async () => {},
      run: async () => ({
        finalResponse: "partial output",
        events: [{ type: "turn/end", data: { reason: { kind: "error", error: { code: "UPSTREAM" } } } }],
      }),
      close: async () => {},
    }),
  });
  try {
    await assert.rejects(
      request(service),
      (error) => {
        assert.equal(error.code, "SUBAGENT_ERROR");
        assert.equal(error.stopReason, "error");
        assert.equal(error.partialOutput, "partial output");
        return true;
      },
    );
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an empty official final response is rejected", async () => {
  const root = await makeRoot();
  const service = serviceFor(root, {
    harnessFactory: () => ({
      start: async () => {},
      run: async () => ({
        finalResponse: "",
        events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
      }),
      close: async () => {},
    }),
  });
  try {
    await assert.rejects(request(service), (error) => error.code === "SUBAGENT_EMPTY_RESULT");
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("independent Harness runs overlap and settle without sharing state", async () => {
  const root = await makeRoot("wfl-dsh-concurrency-test-");
  let created = 0;
  let entered = 0;
  let maximumActive = 0;
  let release;
  let allEntered;
  const enteredPromise = new Promise((resolve) => { allEntered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const closed = [];
  const options = [];
  const service = serviceFor(root, {
    harnessFactory: (value) => {
      const id = created++;
      options.push(value);
      return {
        start: async () => {},
        run: async () => {
          entered += 1;
          maximumActive = Math.max(maximumActive, entered);
          if (entered === 2) allEntered();
          await gate;
          entered -= 1;
          return { finalResponse: `parallel-${id}` };
        },
        close: async () => { closed.push(id); },
      };
    },
  });
  try {
    const first = request(service, { description: "first parallel task" });
    const second = request(service, { description: "second parallel task" });
    await enteredPromise;
    assert.equal(service.harnesses.size, 2);
    assert.equal(maximumActive, 2);
    release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.finalResponse).sort(), ["parallel-0", "parallel-1"]);
    assert.equal(service.harnesses.size, 0);
    assert.deepEqual(closed.sort((a, b) => a - b), [0, 1]);
    assert.equal(options.length, 2);
    assert.notEqual(options[0].launch.args, options[1].launch.args);
  } finally {
    release();
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("one failed Harness does not cancel or corrupt a sibling run", async () => {
  const root = await makeRoot("wfl-dsh-failure-isolation-test-");
  let created = 0;
  const closed = [];
  const service = serviceFor(root, {
    harnessFactory: () => {
      const id = created++;
      return {
        start: async () => {},
        run: async () => {
          if (id === 0) throw new Error("only first child failed");
          return { finalResponse: "sibling survived" };
        },
        close: async () => { closed.push(id); },
      };
    },
  });
  try {
    const results = await Promise.allSettled([request(service), request(service)]);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(results.find((result) => result.status === "rejected").reason.message, /only first child failed/u);
    assert.deepEqual(results.find((result) => result.status === "fulfilled").value, { finalResponse: "sibling survived" });
    assert.deepEqual(closed.sort((a, b) => a - b), [0, 1]);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("each Harness run receives the resolved parent cwd, sandbox, and approval policy", async () => {
  const root = await makeRoot();
  const inheritedCwd = path.join(root, "parent-workspace");
  let options;
  let resolvedParentThreadId;
  let resolvedParentTurnId;
  const service = serviceFor(root, {
    resolveExecutionContext: (parentThreadId, parentTurnId) => {
      resolvedParentThreadId = parentThreadId;
      resolvedParentTurnId = parentTurnId;
      return {
        cwd: inheritedCwd,
        sandboxMode: "read-only",
        approvalPolicy: "never",
      };
    },
    harnessFactory: (value) => {
      options = value;
      return {
        start: async () => {},
        run: async () => ({ finalResponse: "inherited" }),
        close: async () => {},
      };
    },
  });
  try {
    await request(service, {
      parentThreadId: "parent-thread-1",
      parentTurnId: "parent-turn-1",
    });
    assert.equal(resolvedParentThreadId, "parent-thread-1");
    assert.equal(resolvedParentTurnId, "parent-turn-1");
    assert.equal(options.cwd, inheritedCwd);
    assert.equal(options.launch.cwd, inheritedCwd);
    assert.equal(options.launch.env.DSH_CWD, inheritedCwd);
    assert.equal(options.launch.env.WFL_SUBAGENT_SANDBOX_MODE, "read-only");
    assert.equal(Object.hasOwn(options.launch.env, "WFL_SUBAGENT_APPROVAL_POLICY"), false);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an ask approval parent is rejected until an approval bridge exists", async () => {
  const root = await makeRoot();
  let created = 0;
  const service = serviceFor(root, {
    resolveExecutionContext: () => ({
      cwd: path.join(root, "project"),
      sandboxMode: "read-only",
      approvalPolicy: "ask",
    }),
    harnessFactory: () => {
      created += 1;
      return {
        start: async () => {},
        run: async () => ({ finalResponse: "delegated approval is pinned" }),
        close: async () => {},
      };
    },
  });
  try {
    await assert.rejects(request(service), (error) => {
      assert.equal(error.code, "SUBAGENT_APPROVAL_UNSUPPORTED");
      return true;
    });
    assert.equal(created, 0);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid or ambiguous parent context fails before a Harness is created", async () => {
  const root = await makeRoot();
  let created = 0;
  const service = serviceFor(root, {
    resolveExecutionContext: () => ({
      cwd: path.join(root, "project"),
      sandboxMode: "unknown",
      approvalPolicy: "ask",
    }),
    harnessFactory: () => {
      created += 1;
      return null;
    },
  });
  try {
    await assert.rejects(request(service), /无法安全继承/u);
    assert.equal(created, 0);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Harness composition uses the official generic adapter and contains no credential", async () => {
  const config = await fs.readFile(path.resolve("config/deepseek-harness/cordis.yml"), "utf8");
  assert.match(config, /@deepseek-ai\/dsh-llm-pi-ai/u);
  assert.match(config, /wfl-third-party/u);
  assert.match(config, /WFL_SUBAGENT_API/u);
  assert.match(config, /WFL_SUBAGENT_SANDBOX_MODE/u);
  assert.doesNotMatch(config, /WFL_SUBAGENT_APPROVAL_POLICY/u);
  assert.doesNotMatch(config, /sk-[A-Za-z0-9]|DEEPSEEK_API_KEY|dsh-llm-deepseek/u);
  assert.doesNotMatch(config, /maxTokens|max_tokens|budget|quota/u);
});

test("disconnecting the MCP socket closes the in-flight Harness", async () => {
  const root = await makeRoot();
  let created;
  let closed = false;
  const service = serviceFor(root, {
    harnessFactory: () => {
      let release;
      const pending = new Promise((resolve) => { release = resolve; });
      created = { release };
      return {
        start: async () => {},
        run: async () => {
          await pending;
          return { finalResponse: "late" };
        },
        close: async () => {
          closed = true;
          release();
        },
      };
    },
  });
  try {
    const socketPath = await service.start();
    const socket = net.createConnection(socketPath);
    await once(socket, "connect");
    socket.write(`${JSON.stringify({
      version: 1,
      authToken: service.authToken,
      parentThreadId: "disconnect-parent-thread",
      parentTurnId: "disconnect-parent-turn",
      description: "disconnect test",
      prompt: "wait",
    })}\n`);
    for (let attempt = 0; attempt < 100 && !created; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(created);
    socket.destroy();
    for (let attempt = 0; attempt < 100 && !closed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closed, true);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP exposes the official subagent tool and control tools without WFL budgets", async () => {
  const child = spawn(process.execPath, [
    path.resolve("scripts/deepseek-harness-mcp.mjs"),
    "--socket",
    "/tmp/nonexistent-deepseek-harness-test.sock",
  ], {
    cwd: path.resolve("."),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const nextLine = async () => {
    for (let attempt = 0; attempt < 100 && !lines.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.length, "MCP process did not return a response");
    return lines.shift();
  };
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })}\n`);
    await nextLine();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const response = await nextLine();
    assert.equal(response.id, 2);
    assert.deepEqual(response.result.tools.map((tool) => tool.name), [
      "subagent",
      "send_message",
      "interrupt_agent",
      "list_agents",
    ]);
    const tool = response.result.tools.find((entry) => entry.name === "subagent");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["description", "prompt", "run_in_background"]);
    assert.deepEqual(tool.inputSchema.required, ["description", "prompt"]);
    assert.doesNotMatch(JSON.stringify(response.result.tools), /apiKey|budget|token.?limit|max.?tokens|threadId|role/u);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "subagent",
        arguments: { description: "metadata mismatch", prompt: "must be rejected" },
        _meta: {
          threadId: "parent-thread-a",
          "x-codex-turn-metadata": { thread_id: "parent-thread-b" },
        },
      },
    })}\n`);
    const mismatch = await nextLine();
    assert.equal(mismatch.id, 3);
    assert.equal(mismatch.result.isError, true);
    assert.equal(mismatch.result.structuredContent.code, "SUBAGENT_PARENT_THREAD_MISMATCH");

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "subagent",
        arguments: { description: "missing metadata", prompt: "must be rejected" },
      },
    })}\n`);
    const missing = await nextLine();
    assert.equal(missing.id, 4);
    assert.equal(missing.result.isError, true);
    assert.equal(missing.result.structuredContent.code, "SUBAGENT_PARENT_METADATA_REQUIRED");
  } finally {
    child.kill("SIGTERM");
    await once(child, "close").catch(() => {});
  }
});

test("MCP cancellation closes the corresponding in-flight service socket", async () => {
  const root = await makeRoot("wfl-dsh-mcp-cancel-test-");
  const socketPath = path.join(root, "mcp.sock");
  const authTokenPath = path.join(root, "auth.token");
  await fs.writeFile(authTokenPath, "test-token\n", { mode: 0o600 });
  let serviceSocket = null;
  let receivedRequest;
  const requestReceived = new Promise((resolve) => { receivedRequest = resolve; });
  const serviceSocketClosed = new Promise((resolve) => {
    const server = net.createServer((socket) => {
      serviceSocket = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        receivedRequest(JSON.parse(buffer.slice(0, newline)));
      });
      socket.once("close", resolve);
    });
    server.listen(socketPath, () => { receivedRequest.server = server; });
  });
  const child = spawn(process.execPath, [
    path.resolve("scripts/deepseek-harness-mcp.mjs"),
    "--socket",
    socketPath,
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, WFL_DEEPSEEK_HARNESS_AUTH_TOKEN_FILE: authTokenPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const nextLine = async () => {
    for (let attempt = 0; attempt < 200 && !lines.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.length, "MCP process did not return a response");
    return lines.shift();
  };
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })}\n`);
    await nextLine();
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "subagent",
        arguments: { description: "cancel this", prompt: "wait for cancellation" },
        _meta: {
          threadId: "cancel-parent-thread",
          "x-codex-turn-metadata": {
            thread_id: "cancel-parent-thread",
            turn_id: "cancel-parent-turn",
          },
        },
      },
    })}\n`);
    const request = await Promise.race([
      requestReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error("MCP service request timed out")), 2_000)),
    ]);
    assert.equal(request.authToken, "test-token");
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "test cancellation" },
    })}\n`);
    await Promise.race([
      serviceSocketClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("MCP service socket was not closed")), 2_000)),
    ]);
    const response = await nextLine();
    assert.equal(response.id, 2);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.code, "SUBAGENT_CANCELLED");
  } finally {
    serviceSocket?.destroy();
    if (receivedRequest.server) await new Promise((resolve) => receivedRequest.server.close(resolve));
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP bounds request size and redacts provider error credentials", async () => {
  const root = await makeRoot("wfl-dsh-mcp-boundary-test-");
  const socketPath = path.join(root, "mcp.sock");
  const authTokenPath = path.join(root, "auth.token");
  await fs.writeFile(authTokenPath, "test-token\n", { mode: 0o600 });
  let serviceSocket = null;
  let serviceServer;
  serviceServer = net.createServer((socket) => {
    serviceSocket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end(`${JSON.stringify({
        version: 1,
        ok: false,
        error: {
          code: "SUBAGENT_UPSTREAM",
          message: "authorization Bearer sk-super-secret-123456 apiKey=raw-provider-key",
          stopReason: "error",
          partialOutput: "partial model output",
        },
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    serviceServer.once("error", reject);
    serviceServer.listen(socketPath, resolve);
  });
  const child = spawn(process.execPath, [
    path.resolve("scripts/deepseek-harness-mcp.mjs"),
    "--socket",
    socketPath,
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, WFL_DEEPSEEK_HARNESS_AUTH_TOKEN_FILE: authTokenPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const nextLine = async () => {
    for (let attempt = 0; attempt < 200 && !lines.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.length, "MCP process did not return a response");
    return lines.shift();
  };
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })}\n`);
    await nextLine();
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "subagent",
        arguments: { description: "boundary", prompt: "test error" },
        _meta: {
          threadId: "boundary-parent-thread",
          "x-codex-turn-metadata": {
            thread_id: "boundary-parent-thread",
            turn_id: "boundary-parent-turn",
          },
        },
      },
    })}\n`);
    const errorResponse = await nextLine();
    const errorText = errorResponse.result.content[0].text;
    assert.equal(errorResponse.result.isError, true);
    assert.doesNotMatch(errorText, /super-secret|raw-provider-key/iu);
    assert.match(errorText, /redacted/iu);
    assert.equal(errorResponse.result.content[1].text, "partial model output");
    assert.equal(errorResponse.result.structuredContent.stopReason, "error");
    assert.equal(errorResponse.result.structuredContent.partialOutput, "partial model output");

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
      params: { padding: "x".repeat(512 * 1024) },
    })}\n`);
    const oversized = await nextLine();
    assert.equal(oversized.id, null);
    assert.equal(oversized.error.code, -32600);
  } finally {
    serviceSocket?.destroy();
    await new Promise((resolve) => serviceServer.close(resolve));
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP handles sibling tool calls concurrently", async () => {
  const root = await makeRoot("wfl-dsh-mcp-concurrency-test-");
  const socketPath = path.join(root, "mcp.sock");
  const authTokenPath = path.join(root, "auth.token");
  await fs.writeFile(authTokenPath, "test-token\n", { mode: 0o600 });
  const sockets = new Set();
  const requests = [];
  let resolveRequests;
  const requestsReceived = new Promise((resolve) => { resolveRequests = resolve; });
  const serviceServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        requests.push({ socket, request: JSON.parse(buffer.slice(0, newline)) });
        buffer = buffer.slice(newline + 1);
        if (requests.length === 2) resolveRequests();
      }
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    serviceServer.once("error", reject);
    serviceServer.listen(socketPath, resolve);
  });
  const child = spawn(process.execPath, [
    path.resolve("scripts/deepseek-harness-mcp.mjs"),
    "--socket",
    socketPath,
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, WFL_DEEPSEEK_HARNESS_AUTH_TOKEN_FILE: authTokenPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const nextLine = async () => {
    for (let attempt = 0; attempt < 200 && !lines.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.length, "MCP process did not return a response");
    return lines.shift();
  };
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })}\n`);
    await nextLine();
    for (const [id, description, metadata] of [
      [2, "parallel one", {
        threadId: "parent-thread-one",
        "x-codex-turn-metadata": {
          thread_id: "parent-thread-one",
          session_id: "parent-session-one",
          turn_id: "parent-turn-one",
        },
      }],
      [3, "parallel two", {
        threadId: "parent-thread-two",
        "x-codex-turn-metadata": {
          thread_id: "parent-thread-two",
          session_id: "parent-session-two",
          turn_id: "parent-turn-two",
        },
      }],
    ]) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "subagent",
          arguments: { description, prompt: "return after the service response" },
          ...(metadata ? { _meta: metadata } : {}),
        },
      })}\n`);
    }
    await Promise.race([
      requestsReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error("MCP calls were not concurrent")), 2_000)),
    ]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ request }) => request.authToken), ["test-token", "test-token"]);
    assert.equal(
      requests.find(({ request }) => request.description === "parallel one").request.parentThreadId,
      "parent-thread-one",
    );
    assert.equal(
      requests.find(({ request }) => request.description === "parallel one").request.parentTurnId,
      "parent-turn-one",
    );
    assert.equal(
      requests.find(({ request }) => request.description === "parallel two").request.parentThreadId,
      "parent-thread-two",
    );
    assert.equal(
      requests.find(({ request }) => request.description === "parallel two").request.parentTurnId,
      "parent-turn-two",
    );
    for (const { socket, request } of requests) {
      const result = request.runInBackground
        ? { mode: "continuable", childId: `fake-${request.description.replaceAll(" ", "-")}` }
        : { finalResponse: `completed ${request.description}` };
      socket.end(`${JSON.stringify({
        version: 1,
        ok: true,
        result,
      })}\n`);
    }
    const responses = await Promise.all([nextLine(), nextLine()]);
    assert.deepEqual(new Set(responses.map((response) => response.id)), new Set([2, 3]));
    assert.ok(responses.every((response) => response.result.isError === false));
    assert.ok(responses.every((response) => response.result.structuredContent.childId));
    assert.ok(responses.every((response) => /started subagent/u.test(response.result.content[0].text)));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => serviceServer.close(resolve));
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close").catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
