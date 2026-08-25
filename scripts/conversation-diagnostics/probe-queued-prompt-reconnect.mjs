import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket, { WebSocketServer } from "ws";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 25_000;
const FIXED_THREAD_ID = "thread_smoke_001";
const ORIGINAL_PROMPT = "queue payload before reconnect";
const EDITED_PROMPT = "edited payload after queue";
const DRAFT_PROMPT = "unsent draft before reload";
const ATTACHMENT_NAME = "queued-context.txt";

let browser = null;
let rootDirectory = null;
const liveChildren = new Set();
const liveContexts = new Set();
const liveProxies = new Set();

try {
  rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-queued-prompt-reconnect-"));
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });

  const payloadMutation = await probePayloadMutation();
  const destinationMutation = await probeDestinationMutation();
  const draftReload = await probeDraftReload();

  assert.equal(payloadMutation.requestCountBeforeReconnect, 0);
  assert.equal(payloadMutation.sentEditedPayload, true);
  assert.equal(payloadMutation.sentOriginalPayload, false);
  assert.equal(payloadMutation.sentOriginalAttachment, false);
  assert.equal(destinationMutation.requestCountBeforeReconnect, 0);
  assert.equal(destinationMutation.destinationProjectChanged, true);
  assert.equal(destinationMutation.destinationThreadChanged, true);
  assert.equal(draftReload.draftTextRestored, false);
  assert.equal(draftReload.draftAttachmentRestored, false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: {
      transport: "isolated-browser-random-port-controlled-reconnect-proxy",
      appServer: "fake-codex-app-server",
      productionRequests: 0,
      frozenRescuePortTouched: false,
      formalChecksModified: false,
      capturedContent: false,
    },
    scenarios: [
      payloadMutation,
      destinationMutation,
      draftReload,
    ],
    classification: {
      queuedPromptStoresFrozenPayload: false,
      queuedPromptStoresFrozenDestination: false,
      reconnectReadsLiveComposerState: true,
      reconnectReadsLiveProjectState: true,
      unsentDraftPersistsAcrossReload: false,
      unsentAttachmentsPersistAcrossReload: false,
      durableComposerOutboxPresent: false,
      targetMet: false,
    },
  }, null, 2)}\n`);
} finally {
  for (const context of liveContexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const proxy of liveProxies) await proxy.close().catch(() => {});
  for (const child of liveChildren) await stopProcess(child).catch(() => {});
  if (rootDirectory) await fs.rm(rootDirectory, { recursive: true, force: true });
}

async function probePayloadMutation() {
  const environment = await createScenarioEnvironment("payload-mutation");
  try {
    await selectExistingThread(environment.page);
    await uploadAttachment(environment.page);
    await environment.page.locator("#promptInput").fill(ORIGINAL_PROMPT);

    await enterReconnectWindow(environment);
    await environment.page.locator("#sendButton").click();
    await waitForQueuedPrompt(environment.page);
    const requestCountBeforeReconnect = environment.proxy.turnStarts.length;

    await environment.page.locator("#promptInput").fill(EDITED_PROMPT);
    await environment.page.locator(
      '#attachmentList button[aria-label="移除附件"]',
    ).click();
    const attachmentRemovedAfterQueue = await environment.page.locator(
      '#attachmentList button[aria-label="移除附件"]',
    ).count() === 0;

    await resumeReconnectWindow(environment);
    await waitFor(
      () => environment.proxy.turnStarts.length >= 1,
      "queued payload was not submitted after reconnect",
    );
    const submitted = environment.proxy.turnStarts.at(-1);
    assert.equal(submitted.threadId, FIXED_THREAD_ID);
    assert.equal(environment.pageErrors.length, 0);

    return {
      name: "payload-edited-after-queue",
      requestCountBeforeReconnect,
      attachmentRemovedAfterQueue,
      sentEditedPayload: submitted.textClass === "edited",
      sentOriginalPayload: submitted.textClass === "original",
      sentAttachmentCount: submitted.attachmentCount,
      sentOriginalAttachment: submitted.hasDiagnosticAttachment,
      clickTimePayloadFrozen: (
        submitted.textClass === "original"
        && submitted.hasDiagnosticAttachment
      ),
      targetMet: false,
    };
  } finally {
    await environment.close();
  }
}

async function probeDestinationMutation() {
  const environment = await createScenarioEnvironment("destination-mutation");
  try {
    await selectExistingThread(environment.page);
    await environment.page.locator("#promptInput").fill(ORIGINAL_PROMPT);

    await enterReconnectWindow(environment);
    await environment.page.locator("#sendButton").click();
    await waitForQueuedPrompt(environment.page);
    const requestCountBeforeReconnect = environment.proxy.turnStarts.length;

    await selectProject(
      environment.page,
      environment.destinationProjectName,
      environment.destinationProject,
    );
    await resumeReconnectWindow(environment);
    await waitFor(
      () => (
        environment.proxy.threadStarts.length >= 1
        && environment.proxy.turnStarts.length >= 1
      ),
      "queued prompt did not start in the selected destination project",
    );

    const threadStart = environment.proxy.threadStarts.at(-1);
    const turnStart = environment.proxy.turnStarts.at(-1);
    const destinationProjectChanged = (
      threadStart.cwdClass === "destination"
      && turnStart.cwdClass === "destination"
    );
    const destinationThreadChanged = turnStart.threadId !== FIXED_THREAD_ID;
    assert.equal(turnStart.textClass, "original");
    assert.equal(environment.pageErrors.length, 0);

    return {
      name: "project-switched-after-queue",
      requestCountBeforeReconnect,
      destinationProjectChanged,
      destinationThreadChanged,
      newThreadStartedAfterReconnect: environment.proxy.threadStarts.length === 1,
      queuedPayloadTypePreserved: turnStart.textClass === "original",
      clickTimeDestinationFrozen: !destinationProjectChanged,
      targetMet: false,
    };
  } finally {
    await environment.close();
  }
}

async function probeDraftReload() {
  const environment = await createScenarioEnvironment("draft-reload");
  try {
    await selectExistingThread(environment.page);
    await uploadAttachment(environment.page);
    await environment.page.locator("#promptInput").fill(DRAFT_PROMPT);
    const turnStartsBeforeReload = environment.proxy.turnStarts.length;

    await environment.page.reload({ waitUntil: "domcontentloaded" });
    await waitForCodexConnection(environment.page);
    await environment.page.waitForFunction(
      () => document.getElementById("promptInput") && document.getElementById("attachmentList"),
    );

    const draftTextRestored = (
      await environment.page.locator("#promptInput").inputValue()
    ) === DRAFT_PROMPT;
    const draftAttachmentRestored = await environment.page.locator(
      '#attachmentList button[aria-label="移除附件"]',
    ).count() > 0;
    const turnStartsAfterReload = environment.proxy.turnStarts.length;
    assert.equal(turnStartsAfterReload, turnStartsBeforeReload);
    assert.equal(environment.pageErrors.length, 0);

    return {
      name: "unsent-draft-page-reload",
      draftTextRestored,
      draftAttachmentRestored,
      turnStartTriggeredByReload: turnStartsAfterReload > turnStartsBeforeReload,
      targetMet: false,
    };
  } finally {
    await environment.close();
  }
}

async function createScenarioEnvironment(name) {
  const directory = path.join(rootDirectory, name);
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "source-project");
  const destinationProject = path.join(projectRoot, "destination-project");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const runtimeDirectory = path.join(directory, "runtime");

  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(destinationProject, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
  ]);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  const provider = await providerStore.create({
    name: "Queued prompt diagnostic provider",
    baseUrl: "https://queued-prompt.example.test/v1",
    model: "gpt-smoke",
    apiKey: "queued-prompt-diagnostic-secret",
  });
  await providerStore.setActive(provider.id);

  const shim = path.join(fakeBin, "codex");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );

  const [backendPort, proxyPort] = await reserveDistinctPorts(2);
  assert.notEqual(backendPort, 4321, "diagnostic backend must not use the frozen rescue port");
  assert.notEqual(proxyPort, 4321, "diagnostic proxy must not use the frozen rescue port");
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: homeDirectory,
      HOST: "127.0.0.1",
      PORT: String(backendPort),
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
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(backendBaseUrl);

  const proxy = await createControlledProxy({
    listenPort: proxyPort,
    upstreamPort: backendPort,
    defaultProject,
    destinationProject,
  });
  liveProxies.add(proxy);

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  liveContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(proxyBaseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  return {
    child,
    context,
    defaultProject,
    destinationProject,
    destinationProjectName: path.basename(destinationProject),
    page,
    pageErrors,
    proxy,
    async close() {
      await context.close().catch(() => {});
      liveContexts.delete(context);
      await proxy.close().catch(() => {});
      liveProxies.delete(proxy);
      await stopProcess(child).catch(() => {});
    },
  };
}

async function selectExistingThread(page) {
  const threadRow = page.locator(
    ".thread-row",
    { hasText: "Browser recovery smoke test" },
  ).first();
  await threadRow.waitFor();
  await threadRow.evaluate((node) => node.click());
  await page.locator("#messageList").getByText(
    "The authoritative conversation was restored.",
    { exact: true },
  ).waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
}

async function uploadAttachment(page) {
  await page.locator("#fileInput").setInputFiles({
    name: ATTACHMENT_NAME,
    mimeType: "text/plain",
    buffer: Buffer.from("bounded diagnostic attachment"),
  });
  await page.locator("#attachmentList", { hasText: ATTACHMENT_NAME }).waitFor();
}

async function enterReconnectWindow(environment) {
  environment.proxy.disconnect();
  await environment.page.waitForFunction(() => (
    document.getElementById("connectionText")?.textContent !== "Codex 已连接"
    && document.getElementById("sendButton")?.disabled === false
  ));
}

async function waitForQueuedPrompt(page) {
  await page.waitForFunction(() => (
    document.getElementById("sendButton")?.disabled === true
    && document.getElementById("turnStatus")?.textContent?.includes("等待连接恢复")
  ));
}

async function resumeReconnectWindow(environment) {
  environment.proxy.resume();
  await environment.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForCodexConnection(environment.page);
}

async function selectProject(page, name, expectedPath) {
  await page.locator("#projectSwitcher").click();
  const row = page.locator(".project-row", { hasText: name });
  await row.waitFor();
  await row.click();
  await page.waitForFunction(
    (projectPath) => (
      document.querySelector(".project-row.active")?.getAttribute("data-path") === projectPath
    ),
    expectedPath,
  );
}

async function createControlledProxy({
  listenPort,
  upstreamPort,
  defaultProject,
  destinationProject,
}) {
  const clients = new Set();
  const upstreams = new Set();
  const threadStarts = [];
  const turnStarts = [];
  let blocked = false;

  const server = http.createServer((request, response) => {
    const upstreamRequest = http.request({
      hostname: "127.0.0.1",
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.on("error", () => {
      if (!response.headersSent) response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("Diagnostic backend unavailable");
    });
    request.pipe(upstreamRequest);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (blocked) {
      socket.destroy();
      return;
    }
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${request.url}`, {
      headers: forwardedWebSocketHeaders(request.headers),
    });
    upstreams.add(upstream);
    const buffered = [];
    const bufferMessage = (data, isBinary) => buffered.push([data, isBinary]);
    upstream.on("message", bufferMessage);

    upstream.once("open", () => {
      if (blocked) {
        upstream.terminate();
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        clients.add(client);
        upstream.off("message", bufferMessage);
        const forwardUpstream = (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        };
        upstream.on("message", forwardUpstream);
        for (const [data, isBinary] of buffered) forwardUpstream(data, isBinary);

        client.on("message", (data, isBinary) => {
          let message = null;
          try {
            message = JSON.parse(data.toString());
          } catch {
            // Opaque frames are forwarded but never recorded.
          }
          if (message?.type === "rpc") {
            if (message.method === "thread/start") {
              threadStarts.push({
                cwdClass: classifyProject(
                  message.params?.cwd,
                  defaultProject,
                  destinationProject,
                ),
              });
            }
            if (message.method === "turn/start") {
              const text = (message.params?.input || [])
                .find((item) => item?.type === "text")?.text || "";
              const attachments = (message.params?.input || [])
                .filter((item) => item?.type === "mention" || item?.type === "localImage");
              turnStarts.push({
                threadId: message.params?.threadId || null,
                cwdClass: classifyProject(
                  message.params?.cwd,
                  defaultProject,
                  destinationProject,
                ),
                textClass: text === ORIGINAL_PROMPT
                  ? "original"
                  : text === EDITED_PROMPT
                    ? "edited"
                    : text === DRAFT_PROMPT ? "draft" : "other",
                attachmentCount: attachments.length,
                hasDiagnosticAttachment: attachments.some(
                  (item) => path.basename(String(item.path || "")) === ATTACHMENT_NAME,
                ),
              });
            }
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });

        const closeClient = () => {
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.terminate();
          }
        };
        upstream.once("close", closeClient);
        upstream.once("error", closeClient);
        client.once("close", () => {
          clients.delete(client);
          upstream.off("message", forwardUpstream);
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.terminate();
          }
        });
      });
    });
    upstream.once("error", () => {
      upstreams.delete(upstream);
      socket.destroy();
    });
    upstream.once("close", () => upstreams.delete(upstream));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolve);
  });

  return {
    threadStarts,
    turnStarts,
    disconnect() {
      blocked = true;
      for (const client of clients) client.terminate();
      for (const upstream of upstreams) upstream.terminate();
    },
    resume() {
      blocked = false;
    },
    async close() {
      blocked = true;
      for (const client of clients) client.terminate();
      for (const upstream of upstreams) upstream.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function classifyProject(value, defaultProject, destinationProject) {
  if (value === defaultProject) return "source";
  if (value === destinationProject) return "destination";
  return "other";
}

function forwardedWebSocketHeaders(headers) {
  const forwarded = {};
  for (const name of [
    "authorization",
    "cookie",
    "origin",
    "user-agent",
    "x-forwarded-for",
    "x-forwarded-proto",
  ]) {
    if (headers[name] !== undefined) forwarded[name] = headers[name];
  }
  if (headers.host) forwarded.host = headers.host;
  return forwarded;
}

async function waitForCodexConnection(page) {
  await page.waitForFunction(
    () => document.getElementById("connectionText")?.textContent === "Codex 已连接",
  );
}

function reserveDistinctPorts(count) {
  return Promise.all(Array.from({ length: count }, () => getFreePort()))
    .then((ports) => (
      new Set(ports).size === count ? ports : reserveDistinctPorts(count)
    ));
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
      () => reject(new Error(`Backend did not start: ${output}`)),
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
      reject(new Error(`Backend exited early (${code}): ${output}`));
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
  }, `backend did not become ready: ${url}`);
}

async function waitFor(predicate, errorMessage, timeoutMs = PROBE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(errorMessage);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
