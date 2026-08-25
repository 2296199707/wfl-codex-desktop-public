import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ProviderStore } from "../../lib/provider-store.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(path.dirname(scriptDirectory));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const PROBE_TIMEOUT_MS = 12_000;

let browser = null;
let child = null;
let directory = null;

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-conversation-probe-"));
  const projectRoot = path.join(directory, "projects");
  const defaultProject = path.join(projectRoot, "smoke-project");
  const projectB = path.join(projectRoot, "probe-project-b");
  const projectC = path.join(projectRoot, "probe-project-c");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const runtimeDirectory = path.join(directory, "runtime");

  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(projectB, { recursive: true }),
    fs.mkdir(projectC, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);

  const providerStore = await new ProviderStore(stateDirectory).initialize();
  await providerStore.create({
    name: "Conversation probe provider",
    baseUrl: "https://probe-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "conversation-probe-secret",
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
      FAKE_CODEX_REPEAT_RESUME_DELAY_MS: "1200",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);

  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__conversationProbeRpc = [];
    function TrackingWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message?.type === "rpc" && typeof message.method === "string") {
            window.__conversationProbeRpc.push(structuredClone(message));
          }
        } catch {
          // Only JSON-RPC metadata is relevant to this probe.
        }
        nativeSend(data);
      };
      return socket;
    }
    TrackingWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(TrackingWebSocket, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = TrackingWebSocket;
  });

  const page = await context.newPage();
  page.setDefaultTimeout(PROBE_TIMEOUT_MS);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  const projectResults = [];
  for (const [projectName, projectPath] of [
    ["smoke-project", defaultProject],
    ["probe-project-b", projectB],
    ["probe-project-c", projectC],
  ]) {
    await selectProject(page, projectName);
    await page.locator("#newThreadButton").click();
    await page.locator("#promptInput").fill("hold account quota inspection");
    await page.locator("#sendButton").click();
    await page.locator("#stopTurnButton").waitFor({ state: "visible" });
    const request = await latestTurnStart(page, "hold account quota inspection", projectPath);
    projectResults.push({
      projectName,
      projectPath,
      threadId: request.params.threadId,
      clientUserMessageId: request.params.clientUserMessageId,
    });
  }
  assert.equal(new Set(projectResults.map((entry) => entry.threadId)).size, 3);
  assert.equal(new Set(projectResults.map((entry) => entry.clientUserMessageId)).size, 3);

  for (const entry of projectResults) {
    await selectProject(page, entry.projectName);
    await page.locator(".thread-row").first().click();
    await page.locator("#stopTurnButton").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#threadTitleInput").evaluate((input) => Boolean(input.value)),
      true,
    );
  }

  await selectProject(page, "smoke-project");
  await page.locator("#newThreadButton").click();
  await clearRpcTrace(page);
  await dispatchImeEnter(page, {
    text: "ime composition probe",
    isComposing: true,
    keyCode: 13,
  });
  await page.waitForTimeout(150);
  const composingDispatches = await turnStartCount(page, "ime composition probe");
  assert.equal(composingDispatches, 0);

  await dispatchImeEnter(page, {
    text: "ime composition probe",
    isComposing: false,
    keyCode: 229,
  });
  await waitForTurnStartCount(page, "ime composition probe", 1);
  const keyCode229Dispatches = await turnStartCount(page, "ime composition probe");
  await page.locator("#stopTurnButton").waitFor({ state: "visible" });
  await page.locator("#stopTurnButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });

  await page.locator("#newThreadButton").click();
  await clearRpcTrace(page);
  await page.locator("#promptInput").fill("finish concurrent task");
  await dispatchClickAndEnter(page);
  await waitForTurnStartCount(page, "finish concurrent task", 1);
  await page.getByText("The independent concurrent task completed.", { exact: true }).waitFor();
  const normalSameTickDispatches = await turnStartCount(page, "finish concurrent task");
  assert.equal(normalSameTickDispatches, 1);

  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("complete then unload current thread");
  await page.locator("#sendButton").click();
  await waitForTurnStartCount(page, "complete then unload current thread", 1);
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#stopTurnButton").isHidden(), true);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  await clearRpcTrace(page);
  await page.locator("#promptInput").fill("duplicate after unloaded resume");
  await dispatchClickAndEnter(page);
  await waitForTurnStartCount(page, "duplicate after unloaded resume", 2);
  const staleResumeRequests = await matchingTurnStarts(page, "duplicate after unloaded resume");
  assert.equal(staleResumeRequests.length, 2);
  assert.equal(new Set(staleResumeRequests.map((request) => request.params.clientUserMessageId)).size, 2);

  assert.deepEqual(pageErrors, []);
  const result = {
    ok: true,
    environment: {
      transport: "random-port-http-websocket",
      appServer: "fake-codex-app-server",
      productionRequests: 0,
      rescuePortTouched: false,
    },
    multiProject: {
      projects: projectResults,
      allThreeRunningAfterSwitches: true,
      targetMet: true,
    },
    inputMethod: {
      composingEnterDispatches: composingDispatches,
      keyCode229WhileCompositionDispatches: keyCode229Dispatches,
      targetMet: keyCode229Dispatches === 0,
    },
    sameTickSubmission: {
      normalThreadDispatches: normalSameTickDispatches,
      resumeRequiredDispatches: staleResumeRequests.length,
      resumeRequiredClientIds: staleResumeRequests.map((request) => request.params.clientUserMessageId),
      targetMet: normalSameTickDispatches === 1 && staleResumeRequests.length === 1,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
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

async function selectProject(page, name) {
  await page.locator("#projectSwitcher").click();
  const row = page.locator(".project-row", { hasText: name });
  await row.waitFor();
  const projectPath = await row.getAttribute("data-path");
  assert.ok(projectPath, `Project row ${name} has no data-path`);
  await row.click();
  await page.waitForFunction(
    (expectedPath) => document.querySelector(".project-row.active")?.getAttribute("data-path") === expectedPath,
    projectPath,
  );
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
}

async function latestTurnStart(page, text, cwd = null) {
  const matches = await matchingTurnStarts(page, text);
  const filtered = cwd ? matches.filter((request) => request.params.cwd === cwd) : matches;
  assert.ok(filtered.length > 0, `No turn/start captured for ${text} in ${cwd || "any cwd"}`);
  return filtered.at(-1);
}

async function matchingTurnStarts(page, text) {
  return page.evaluate((expectedText) => window.__conversationProbeRpc.filter((message) => (
    message.method === "turn/start"
    && message.params?.input?.some((item) => item.type === "text" && item.text === expectedText)
  )), text);
}

async function turnStartCount(page, text) {
  return (await matchingTurnStarts(page, text)).length;
}

async function waitForTurnStartCount(page, text, count) {
  await page.waitForFunction(
    ({ expectedText, expectedCount }) => window.__conversationProbeRpc.filter((message) => (
      message.method === "turn/start"
      && message.params?.input?.some((item) => item.type === "text" && item.text === expectedText)
    )).length >= expectedCount,
    { expectedText: text, expectedCount: count },
  );
}

async function clearRpcTrace(page) {
  await page.evaluate(() => {
    window.__conversationProbeRpc = [];
  });
}

async function dispatchImeEnter(page, { text, isComposing, keyCode }) {
  await page.locator("#promptInput").evaluate((input, values) => {
    input.value = values.text;
    input.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: values.text,
    }));
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: values.text,
      inputType: "insertCompositionText",
      isComposing: true,
    }));
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter",
    });
    Object.defineProperties(event, {
      isComposing: { value: values.isComposing },
      keyCode: { value: values.keyCode },
      which: { value: values.keyCode },
    });
    input.dispatchEvent(event);
  }, { text, isComposing, keyCode });
}

async function dispatchClickAndEnter(page) {
  await page.evaluate(() => {
    document.getElementById("sendButton").click();
    document.getElementById("promptInput").dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter",
    }));
  });
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
