import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 12_000;
const RECONNECT_GRACE_OBSERVATION_MS = 10_500;

let browser = null;
let child = null;
let directory = null;
let contextA = null;
let contextB = null;

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-multi-client-probe-"));
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

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  await providerStore.create({
    name: "Multi-client probe provider",
    baseUrl: "https://probe-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "multi-client-probe-secret",
  });

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const port = await getFreePort();
  assert.notEqual(port, 4321, "random diagnostic port must not be the frozen rescue port");
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
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
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: "/bin/false",
      FAKE_CODEX_PROJECT: defaultProject,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);

  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  contextA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await contextA.addInitScript(initializeBrowserProbe);
  const pageA = await contextA.newPage();
  pageA.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrorsA = [];
  pageA.on("pageerror", (error) => pageErrorsA.push(error.message));
  await pageA.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(pageA);

  await pageA.locator("#newThreadButton").click();
  await pageA.locator("#promptInput").fill("hold account quota inspection");
  await pageA.locator("#sendButton").click();
  await pageA.locator("#stopTurnButton").waitFor({ state: "visible" });
  const threadARequest = await latestTurnStart(pageA, "hold account quota inspection");
  const threadAId = threadARequest.params.threadId;
  const turnAId = await activeTurnId(pageA, threadAId);
  await pageA.locator("#threadTitleInput").fill("Shared running thread");
  await pageA.locator("#threadTitleInput").press("Enter");
  await pageA.waitForFunction(() => (
    document.getElementById("threadTitleInput")?.value === "Shared running thread"
  ));

  contextB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await contextB.addInitScript(initializeBrowserProbe);
  const pageB = await contextB.newPage();
  pageB.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrorsB = [];
  pageB.on("pageerror", (error) => pageErrorsB.push(error.message));
  await pageB.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(pageB);

  const [leaseOwnerA, leaseOwnerB] = await Promise.all([
    pageA.evaluate(() => sessionStorage.getItem("codexDesktop.threadLeaseOwner.v1")),
    pageB.evaluate(() => sessionStorage.getItem("codexDesktop.threadLeaseOwner.v1")),
  ]);
  assert.match(leaseOwnerA, /^[a-f0-9-]{36}$/);
  assert.match(leaseOwnerB, /^[a-f0-9-]{36}$/);
  assert.notEqual(leaseOwnerA, leaseOwnerB);

  await Promise.all([clearNotifications(pageA), clearNotifications(pageB)]);
  await pageB.locator("#newThreadButton").click();
  await pageB.locator("#promptInput").fill("finish concurrent task");
  await pageB.locator("#sendButton").click();
  const threadBRequest = await latestTurnStart(pageB, "finish concurrent task");
  const threadBId = threadBRequest.params.threadId;
  assert.notEqual(threadAId, threadBId);
  await pageB.locator("#messageList").getByText(
    "The independent concurrent task completed.",
    { exact: true },
  ).waitFor();
  await pageA.waitForFunction((threadId) => (
    window.__multiClientProbe.notifications.some((entry) => (
      entry.threadId === threadId && entry.method === "turn/completed"
    ))
  ), threadBId);

  const broadcastToInactiveClient = await pageA.evaluate((threadId) => {
    const matches = window.__multiClientProbe.notifications.filter((entry) => entry.threadId === threadId);
    return {
      count: matches.length,
      methods: [...new Set(matches.map((entry) => entry.method))],
    };
  }, threadBId);
  const inactiveThreadPollutedDom = await pageA.locator("#messageList").getByText(
    "The independent concurrent task completed.",
    { exact: true },
  ).count();
  assert.equal(inactiveThreadPollutedDom, 0);
  await pageA.locator("#stopTurnButton").waitFor({ state: "visible" });

  const sharedRow = pageB.locator(".thread-row", { hasText: "Shared running thread" });
  await sharedRow.waitFor();
  await sharedRow.evaluate((node) => node.click());
  await pageB.locator("#stopTurnButton").waitFor({ state: "visible" });
  await pageB.waitForFunction(() => (
    document.getElementById("threadTitleInput")?.value === "Shared running thread"
  ));
  assert.equal(
    await pageB.locator("#messageList").getByText(
      "hold account quota inspection",
      { exact: true },
    ).count(),
    1,
  );

  await pageA.close();
  await pageB.waitForTimeout(RECONNECT_GRACE_OBSERVATION_MS);
  const loadedAfterFirstClientClosed = await browserRpc(pageB, "thread/loaded/list", { limit: 100 });
  const runningAfterFirstClientClosed = await pageB.locator("#stopTurnButton").isVisible();
  assert.equal(loadedAfterFirstClientClosed.data.includes(threadAId), true);
  assert.equal(runningAfterFirstClientClosed, true);

  await pageB.locator("#stopTurnButton").click();
  await pageB.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await pageB.waitForTimeout(500);
  const loadedWithSecondClientSubscribed = await browserRpc(
    pageB,
    "thread/loaded/list",
    { limit: 100 },
  );
  assert.equal(loadedWithSecondClientSubscribed.data.includes(threadAId), true);

  const unsubscribe = await browserRpc(pageB, "thread/unsubscribe", { threadId: threadAId });
  await pageB.waitForTimeout(500);
  const loadedAfterFinalUnsubscribe = await browserRpc(pageB, "thread/loaded/list", { limit: 100 });
  assert.equal(loadedAfterFinalUnsubscribe.data.includes(threadAId), false);
  assert.deepEqual(pageErrorsA, []);
  assert.deepEqual(pageErrorsB, []);

  const result = {
    ok: true,
    environment: {
      transport: "two-isolated-browser-contexts-random-port-http-websocket",
      appServer: "fake-codex-app-server",
      productionRequests: 0,
      rescuePortTouched: false,
    },
    identity: {
      leaseOwnerA,
      leaseOwnerB,
      independent: leaseOwnerA !== leaseOwnerB,
    },
    crossThreadBroadcast: {
      sourceThreadId: threadBId,
      inactiveClientThreadId: threadAId,
      receivedByInactiveClient: broadcastToInactiveClient.count > 0,
      notificationCount: broadcastToInactiveClient.count,
      methods: broadcastToInactiveClient.methods,
      inactiveThreadDomMessages: inactiveThreadPollutedDom,
      domIsolated: inactiveThreadPollutedDom === 0,
    },
    sharedSubscription: {
      threadId: threadAId,
      turnId: turnAId,
      reconnectGraceObservedMs: RECONNECT_GRACE_OBSERVATION_MS,
      runningAfterFirstClientClosed,
      loadedAfterFirstClientClosed: loadedAfterFirstClientClosed.data.includes(threadAId),
      loadedAfterCompletionWhileSecondSubscribed:
        loadedWithSecondClientSubscribed.data.includes(threadAId),
      finalUnsubscribeStatus: unsubscribe.status,
      loadedAfterFinalUnsubscribe: loadedAfterFinalUnsubscribe.data.includes(threadAId),
      targetMet:
        runningAfterFirstClientClosed
        && loadedAfterFirstClientClosed.data.includes(threadAId)
        && loadedWithSecondClientSubscribed.data.includes(threadAId)
        && !loadedAfterFinalUnsubscribe.data.includes(threadAId),
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await contextA?.close().catch(() => {});
  await contextB?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}

function initializeBrowserProbe() {
  window.__multiClientProbe = {
    sent: [],
    notifications: [],
    responses: {},
    socket: null,
  };
  const NativeWebSocket = window.WebSocket;
  function TrackingWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    window.__multiClientProbe.socket = socket;
    const nativeSend = socket.send.bind(socket);
    socket.send = (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message?.type === "rpc") {
          window.__multiClientProbe.sent.push(structuredClone(message));
        }
      } catch {
        // Only protocol metadata is retained.
      }
      nativeSend(data);
    };
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "rpc/result" || message?.type === "rpc/error") {
          window.__multiClientProbe.responses[String(message.requestId)] = structuredClone(message);
        }
        if (message?.type !== "codex/notification") return;
        const params = message.payload?.params || {};
        window.__multiClientProbe.notifications.push({
          method: message.payload?.method || "unknown",
          threadId: params.threadId || params.thread?.id || null,
          turnId: params.turnId || params.turn?.id || null,
          at: performance.now(),
        });
      } catch {
        // Non-JSON frames are outside this probe.
      }
    });
    return socket;
  }
  TrackingWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(TrackingWebSocket, key, { value: NativeWebSocket[key] });
  }
  window.WebSocket = TrackingWebSocket;
}

async function latestTurnStart(page, text) {
  await page.waitForFunction((expectedText) => (
    window.__multiClientProbe.sent.some((message) => (
      message.method === "turn/start"
      && message.params?.input?.some((item) => item.type === "text" && item.text === expectedText)
    ))
  ), text);
  return page.evaluate((expectedText) => (
    window.__multiClientProbe.sent.filter((message) => (
      message.method === "turn/start"
      && message.params?.input?.some((item) => item.type === "text" && item.text === expectedText)
    )).at(-1)
  ), text);
}

async function activeTurnId(page, threadId) {
  await page.waitForFunction((expectedThreadId) => (
    window.__multiClientProbe.notifications.some((entry) => (
      entry.threadId === expectedThreadId && entry.method === "turn/started" && entry.turnId
    ))
  ), threadId);
  return page.evaluate((expectedThreadId) => (
    window.__multiClientProbe.notifications.find((entry) => (
      entry.threadId === expectedThreadId && entry.method === "turn/started" && entry.turnId
    )).turnId
  ), threadId);
}

async function clearNotifications(page) {
  await page.evaluate(() => {
    window.__multiClientProbe.notifications = [];
  });
}

async function browserRpc(page, method, params) {
  const requestId = `diagnostic-${randomUUID()}`;
  await page.evaluate(({ id, rpcMethod, rpcParams }) => {
    const socket = window.__multiClientProbe.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Diagnostic WebSocket is not open");
    }
    socket.send(JSON.stringify({
      type: "rpc",
      requestId: id,
      method: rpcMethod,
      params: rpcParams,
    }));
  }, { id: requestId, rpcMethod: method, rpcParams: params });
  await page.waitForFunction((id) => (
    Object.hasOwn(window.__multiClientProbe.responses, id)
  ), requestId);
  const response = await page.evaluate((id) => (
    window.__multiClientProbe.responses[id]
  ), requestId);
  if (response.type === "rpc/error") throw new Error(response.message);
  return response.result;
}

async function waitForCodexConnection(page) {
  await page.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex 已连接");
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
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8_000);
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
    processHandle.once("exit", (code) => reject(new Error(`Server exited early (${code}): ${output}`)));
  });
}

async function waitForDeepReady(url) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/internal/codex-ready`);
      const data = await response.json();
      if (response.ok && data.codexReady === true && data.threadListReady === true) return;
    } catch {
      // The isolated bridge may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The isolated fake Codex bridge did not become ready");
}
