import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const THREAD_ID = "thread_smoke_001";
const PROBE_TIMEOUT_MS = 12_000;

class RpcSocket {
  static async connect(baseUrl) {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
      headers: { Origin: baseUrl },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), PROBE_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", reject);
    });
    return new RpcSocket(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = new Set();
    socket.on("message", (raw) => this.handleMessage(raw));
  }

  handleMessage(raw) {
    const message = JSON.parse(raw.toString());
    if (message.type === "rpc/result" || message.type === "rpc/error") {
      const pending = this.pending.get(String(message.requestId));
      if (!pending) return;
      this.pending.delete(String(message.requestId));
      clearTimeout(pending.timer);
      if (message.type === "rpc/error") pending.reject(new Error(message.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.type !== "codex/notification") return;
    const notification = message.payload;
    this.notifications.push(notification);
    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(notification)) continue;
      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(notification);
    }
  }

  call(method, params = {}) {
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`WebSocket RPC timed out: ${method}`));
      }, PROBE_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "rpc", requestId, method, params }));
    });
  }

  waitForNotification(predicate) {
    const existing = this.notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error("Codex notification timed out"));
        }, PROBE_TIMEOUT_MS),
      };
      this.notificationWaiters.add(waiter);
    });
  }

  close() {
    this.socket.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket closed"));
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WebSocket closed"));
    }
    this.notificationWaiters.clear();
  }
}

let child = null;
let directory = null;
let socket = null;
const modelServers = [];

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-goal-provider-probe-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "smoke-project");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const runtimeDirectory = path.join(directory, "runtime");

  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);

  const primaryModels = await startModelServer("primary");
  const secondaryModels = await startModelServer("secondary");
  modelServers.push(primaryModels.server, secondaryModels.server);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const primaryProvider = await providerStore.create({
    name: "Goal probe primary",
    baseUrl: primaryModels.baseUrl,
    model: "gpt-smoke",
    apiKey: "goal-probe-primary-secret",
  });
  const secondaryProvider = await providerStore.create({
    name: "Goal probe secondary",
    baseUrl: secondaryModels.baseUrl,
    model: "gpt-smoke",
    apiKey: "goal-probe-secondary-secret",
  });
  await providerStore.setActive(primaryProvider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const port = await getFreePort();
  assert.notEqual(port, 4321, "random diagnostic port must not be the frozen rescue port");
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: homeDirectory,
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
    CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
    CODEX_DESKTOP_AUTH_FILE: path.join(directory, "missing-auth.json"),
    CODEX_DESKTOP_STATE_DIR: stateDirectory,
    CODEX_DESKTOP_SOURCE_DIR: defaultProject,
    CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
    CODEX_DESKTOP_MULTI_USER_ROOT: path.join(directory, "users"),
    CODEX_DESKTOP_RELEASE_DISABLED: "1",
    CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
    CODEX_DESKTOP_CLAUDE_BIN: "/bin/false",
    FAKE_CODEX_PROJECT: defaultProject,
    FAKE_CODEX_REQUIRE_PROVIDER_KEY: "1",
    FAKE_CODEX_EXPECT_PROVIDER_KEY: "goal-probe-secondary-secret",
    NODE_ENV: "test",
  };

  child = spawnProbeServer(serverEnvironment);
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);
  socket = await RpcSocket.connect(baseUrl);

  await socket.call("thread/resume", {
    threadId: THREAD_ID,
    cwd: defaultProject,
    model: "gpt-smoke",
    modelProvider: "custom",
    excludeTurns: false,
  });
  await socket.call("thread/goal/clear", { threadId: THREAD_ID });
  const goal = await socket.call("thread/goal/set", {
    threadId: THREAD_ID,
    objective: "Pause, switch provider, resume, and survive restart",
    status: "active",
    tokenBudget: null,
  });
  assert.equal(goal.goal.status, "active");

  const turnStartedAt = Date.now();
  const initialSubmissionId = `goal-probe-${randomUUID()}`;
  const turn = await socket.call("turn/start", {
    threadId: THREAD_ID,
    cwd: defaultProject,
    model: "gpt-smoke",
    effort: "ultra",
    clientUserMessageId: initialSubmissionId,
    input: [{
      type: "text",
      text: "coordinate activity-only subagents",
      text_elements: [],
    }],
  });
  const turnId = turn.turn.id;
  const completion = socket.waitForNotification((notification) => (
    notification.method === "turn/completed"
    && notification.params?.threadId === THREAD_ID
    && notification.params?.turn?.id === turnId
  ));
  await waitForTaskState(baseUrl, THREAD_ID, new Set(["running", "waiting"]));

  const pauseRequestedAt = Date.now();
  const pausing = await requestJson(baseUrl, "/api/codex/goal/control", {
    method: "POST",
    action: "goal-control",
    body: { threadId: THREAD_ID, action: "pause", mode: "after-turn" },
  });
  assert.equal(pausing.response.status, 200);
  assert.equal(pausing.data.control.manualPauseState, "pausing");
  assert.equal(pausing.data.control.manualPauseMode, "after-turn");
  const taskWhilePausing = await requestJson(
    baseUrl,
    `/api/task/status?threadId=${encodeURIComponent(THREAD_ID)}`,
  );
  assert.equal(["running", "waiting"].includes(taskWhilePausing.data.status), true);

  const completedNotification = await completion;
  const completedAt = Date.now();
  assert.equal(normalizeTurnStatus(completedNotification.params.turn.status), "completed");
  assert.ok(
    completedAt - pauseRequestedAt >= 800,
    "after-turn pause unexpectedly interrupted the controlled 1.2 second Turn",
  );
  const paused = await waitForGoalControl(baseUrl, THREAD_ID, (control) => (
    control?.manualPauseState === "paused"
  ));
  assert.equal(paused.control.status, "paused");
  await waitForTaskState(baseUrl, THREAD_ID, new Set(["idle", "completed", "stopped"]));

  const notificationOffsetBeforeSwitch = socket.notifications.length;
  const providerSwitch = await requestJson(
    baseUrl,
    `/api/providers/${encodeURIComponent(secondaryProvider.id)}/activate`,
    { method: "POST" },
  );
  assert.equal(
    providerSwitch.response.status,
    200,
    `provider switch failed: ${providerSwitch.data.error || "unknown error"}`,
  );
  assert.equal(providerSwitch.data.activeId, secondaryProvider.id);
  await waitForDeepReady(baseUrl);
  await waitForNativeGoal(socket, THREAD_ID, "paused");

  const switched = await waitForGoalControl(baseUrl, THREAD_ID, (control, payload) => (
    control?.manualPauseState === "paused"
    && control.providerBefore?.id === primaryProvider.id
    && control.providerAfter?.id === secondaryProvider.id
    && payload.provider?.id === secondaryProvider.id
  ));
  assert.equal(switched.control.resumeWhenAvailable, false);

  const resumed = await requestJson(baseUrl, "/api/codex/goal/control", {
    method: "POST",
    action: "goal-control",
    body: { threadId: THREAD_ID, action: "resume" },
  });
  assert.equal(
    resumed.response.status,
    200,
    `Goal resume failed: ${resumed.data.error || "unknown error"}`,
  );
  assert.equal(resumed.data.control.manualPauseState, null);
  assert.equal(resumed.data.control.status, "active");
  assert.equal(resumed.data.control.providerBefore.id, primaryProvider.id);
  assert.equal(resumed.data.control.providerAfter.id, secondaryProvider.id);
  assert.ok(secondaryModels.requests.some((entry) => entry.path === "/v1/models"));
  const nativeResumed = await waitForNativeGoal(socket, THREAD_ID, "active");
  const providerSubmissionId = `provider-verified-${randomUUID()}`;
  const providerTurn = await socket.call("turn/start", {
    threadId: THREAD_ID,
    cwd: defaultProject,
    model: "gpt-smoke",
    effort: "medium",
    clientUserMessageId: providerSubmissionId,
    input: [{ type: "text", text: "verify selected provider", text_elements: [] }],
  });
  const providerTurnCompleted = await socket.waitForNotification((notification) => (
    notification.method === "turn/completed"
    && notification.params?.threadId === THREAD_ID
    && notification.params?.turn?.id === providerTurn.turn.id
  ));
  assert.equal(normalizeTurnStatus(providerTurnCompleted.params.turn.status), "completed");
  const postSwitchTurnStarts = socket.notifications
    .slice(notificationOffsetBeforeSwitch)
    .filter((notification) => (
      notification.method === "turn/started"
      && notification.params?.threadId === THREAD_ID
    ));
  assert.equal(
    postSwitchTurnStarts.filter((notification) => (
      turnClientSubmissionId(notification.params?.turn) === providerSubmissionId
    )).length,
    1,
  );
  assert.equal(
    postSwitchTurnStarts.filter((notification) => (
      turnClientSubmissionId(notification.params?.turn) === initialSubmissionId
    )).length,
    0,
    "the completed pre-switch submission was replayed after changing providers",
  );
  await waitForTaskState(baseUrl, THREAD_ID, new Set(["idle", "completed", "stopped"]));

  const pausedBeforeRestart = await requestJson(baseUrl, "/api/codex/goal/control", {
    method: "POST",
    action: "goal-control",
    body: { threadId: THREAD_ID, action: "pause", mode: "after-turn" },
  });
  assert.equal(pausedBeforeRestart.response.status, 200);
  assert.equal(pausedBeforeRestart.data.control.manualPauseState, "paused");
  const persistedPauseRequestedAt = pausedBeforeRestart.data.control.manualPauseRequestedAt;

  socket.close();
  socket = null;
  await stopProcess(child);
  child = null;

  child = spawnProbeServer(serverEnvironment);
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);
  socket = await RpcSocket.connect(baseUrl);
  const nativeAfterRestart = await waitForNativeGoal(socket, THREAD_ID, "paused");
  const controlAfterRestart = await waitForGoalControl(baseUrl, THREAD_ID, (control) => (
    control?.manualPauseState === "paused"
    && control.manualPauseRequestedAt === persistedPauseRequestedAt
  ));

  const retryClassification = [];
  for (const scenario of [
    {
      name: "timeout",
      prompt: "retry timeout five times",
      expectedFailureKind: "connectivity",
      expectedMessage: /timed out/i,
      expectedCodexErrorInfo: {
        responseStreamConnectionFailed: { httpStatusCode: null },
      },
    },
    {
      name: "quota",
      prompt: "retry quota five times",
      expectedFailureKind: "quota",
      expectedMessage: /429|rate limit/i,
      expectedCodexErrorInfo: "usageLimitExceeded",
    },
    {
      name: "credentials",
      prompt: "retry credentials five times",
      expectedFailureKind: "authentication",
      expectedMessage: /401|invalid API key/i,
      expectedCodexErrorInfo: "unauthorized",
    },
  ]) {
    const started = await socket.call("thread/start", {
      cwd: defaultProject,
      model: "gpt-smoke",
      modelProvider: "custom",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    const threadId = started.thread.id;
    await socket.call("thread/goal/set", {
      threadId,
      objective: `Classify ${scenario.name} retry exhaustion`,
      status: "active",
      tokenBudget: null,
    });
    const retryTurn = await socket.call("turn/start", {
      threadId,
      cwd: defaultProject,
      model: "gpt-smoke",
      effort: "medium",
      clientUserMessageId: `retry-${scenario.name}-${randomUUID()}`,
      input: [{ type: "text", text: scenario.prompt, text_elements: [] }],
    });
    await socket.waitForNotification((notification) => (
      notification.method === "turn/completed"
      && notification.params?.threadId === threadId
      && notification.params?.turn?.id === retryTurn.turn.id
    ));
    const classified = await waitForGoalControl(baseUrl, threadId, (control) => (
      control?.failureKind === scenario.expectedFailureKind
      && control.resumeWhenAvailable === (scenario.expectedFailureKind === "connectivity")
      && control.suspendedReason === (
        scenario.expectedFailureKind === "connectivity" ? "provider-unavailable" : null
      )
    ));
    const retrySettings = await requestJson(baseUrl, "/api/codex/goal/retry-settings");
    const waiting = retrySettings.data.waiting?.find((entry) => entry.threadId === threadId);
    if (scenario.expectedFailureKind === "connectivity") {
      assert.ok(waiting, `${scenario.name} retry was not added to connectivity recovery`);
      assert.match(waiting.lastError, scenario.expectedMessage);
    } else {
      assert.equal(waiting, undefined, `${scenario.name} must not arm connectivity recovery`);
      assert.match(classified.control.lastError, scenario.expectedMessage);
    }
    const limitedError = socket.notifications.find((notification) => (
      notification.method === "error"
      && notification.params?.threadId === threadId
      && notification.params?.retryLimitReached === true
    ));
    assert.ok(limitedError, `${scenario.name} retry limit notification was not observed`);
    assert.deepEqual(
      limitedError.params.error?.codexErrorInfo,
      scenario.expectedCodexErrorInfo,
      `${scenario.name} structured Codex error information was not preserved`,
    );
    retryClassification.push({
      source: scenario.name,
      codexErrorInfo: limitedError.params.error.codexErrorInfo,
      nativeGoalStatus: classified.control.status,
      classifiedAs: classified.control.failureKind,
      resumeWhenAvailable: classified.control.resumeWhenAvailable,
      targetMet: classified.control.failureKind === scenario.expectedFailureKind
        && classified.control.resumeWhenAvailable === (scenario.expectedFailureKind === "connectivity"),
    });
    await socket.call("thread/goal/clear", { threadId });
  }

  const result = {
    ok: true,
    environment: {
      transport: "isolated-random-port-http-websocket",
      appServer: "fake-codex-app-server",
      providerEndpoints: "two-local-loopback-model-servers",
      productionRequests: 0,
      rescuePortTouched: false,
    },
    afterTurnPause: {
      threadId: THREAD_ID,
      turnId,
      turnDurationMs: completedAt - turnStartedAt,
      elapsedAfterPauseMs: completedAt - pauseRequestedAt,
      taskStatusWhilePausing: taskWhilePausing.data.status,
      turnCompletedNaturally: normalizeTurnStatus(completedNotification.params.turn.status) === "completed",
      finalManualPauseState: paused.control.manualPauseState,
      targetMet: true,
    },
    providerSwitchAndResume: {
      providerBefore: switched.control.providerBefore,
      providerAfter: switched.control.providerAfter,
      nativeGoalStatusAfterResume: nativeResumed.status,
      newTurnStatus: normalizeTurnStatus(providerTurnCompleted.params.turn.status),
      newTurnStartedExactlyOnce: postSwitchTurnStarts.filter((notification) => (
        turnClientSubmissionId(notification.params?.turn) === providerSubmissionId
      )).length === 1,
      oldTurnReplayedAfterSwitch:
        postSwitchTurnStarts.some((notification) => (
          turnClientSubmissionId(notification.params?.turn) === initialSubmissionId
        )),
      secondaryModelChecks: secondaryModels.requests.length,
      auditPersistedThroughResume:
        resumed.data.control.providerBefore.id === primaryProvider.id
        && resumed.data.control.providerAfter.id === secondaryProvider.id,
      targetMet: true,
    },
    restartRecovery: {
      manualPauseRequestedAt: persistedPauseRequestedAt,
      nativeGoalStatus: nativeAfterRestart.status,
      controlStatus: controlAfterRestart.control.status,
      manualPauseState: controlAfterRestart.control.manualPauseState,
      browserRequired: false,
      targetMet: true,
    },
    retryClassification: {
      cases: retryClassification,
      timeoutTargetMet: retryClassification[0].targetMet,
      quotaTargetMet: retryClassification[1].targetMet,
      credentialsTargetMet: retryClassification[2].targetMet,
      finding: "only connectivity enters recoverable retry; quota and authentication remain paused without timers",
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  socket?.close();
  if (child) await stopProcess(child).catch(() => {});
  await Promise.all(modelServers.map((server) => closeServer(server).catch(() => {})));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

async function requestJson(baseUrl, url, {
  method = "GET",
  action = null,
  body = null,
} = {}) {
  const headers = {};
  if (method !== "GET") headers.Origin = baseUrl;
  if (action) headers["X-Codex-Desktop-Action"] = action;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: await response.json().catch(() => ({})) };
}

async function waitForGoalControl(baseUrl, threadId, predicate) {
  return waitFor(async () => {
    const result = await requestJson(
      baseUrl,
      `/api/codex/goal/control?threadId=${encodeURIComponent(threadId)}`,
    );
    if (result.response.ok && predicate(result.data.control, result.data)) return result.data;
    return null;
  }, `Goal control did not reach the expected state for ${threadId}`);
}

async function waitForNativeGoal(rpc, threadId, status) {
  return waitFor(async () => {
    try {
      const result = await rpc.call("thread/goal/get", { threadId });
      return normalizeTurnStatus(result.goal?.status) === status ? result.goal : null;
    } catch {
      return null;
    }
  }, `native Goal did not reach ${status} for ${threadId}`);
}

async function waitForTaskState(baseUrl, threadId, statuses) {
  return waitFor(async () => {
    const result = await requestJson(
      baseUrl,
      `/api/task/status?threadId=${encodeURIComponent(threadId)}`,
    );
    return result.response.ok && statuses.has(result.data.status) ? result.data : null;
  }, `task did not reach one of: ${[...statuses].join(", ")}`);
}

async function waitFor(check, message, timeoutMs = PROBE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function startModelServer(name) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization ? "present" : "missing",
    });
    if (request.method !== "GET" || request.url !== "/v1/models") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-smoke", owned_by: name }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  assert.notEqual(port, 4321, "local provider server must not use the frozen rescue port");
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function spawnProbeServer(environment) {
  return spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Server did not start: ${output}`)),
      PROBE_TIMEOUT_MS,
    );
    const collect = (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      processHandle.stdout.off("data", collect);
      processHandle.stderr.off("data", collect);
      resolve();
    };
    processHandle.stdout.on("data", collect);
    processHandle.stderr.on("data", collect);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${output}`));
    });
  });
}

async function waitForDeepReady(url) {
  await waitFor(async () => {
    try {
      const response = await fetch(`${url}/internal/codex-ready`);
      const data = await response.json();
      return response.ok && data.codexReady === true && data.threadListReady === true;
    } catch {
      return false;
    }
  }, "The isolated fake Codex bridge did not become ready");
}

function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      finish();
    }, 3_000);
    processHandle.once("exit", finish);
    processHandle.kill("SIGTERM");
  });
}

function normalizeTurnStatus(status) {
  return typeof status === "object" ? status?.type : status;
}

function turnClientSubmissionId(turn) {
  const userMessage = turn?.items?.find((item) => item?.type === "userMessage");
  return typeof userMessage?.clientId === "string" ? userMessage.clientId : null;
}
