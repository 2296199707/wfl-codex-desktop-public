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
const EXPECTED_FILE_LINKS = 320;
const EXPECTED_LARGE_DIFF_ROWS = 19_999;
const FIRST_VISIBLE_BUDGET_MS = 100;
const THREAD_OPEN_BUDGET_MS = 800;

let browser = null;
let child = null;
let directory = null;

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-render-probe-"));
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
    name: "Render probe provider",
    baseUrl: "https://probe-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "render-probe-secret",
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    window.__renderProbe = {
      rpc: [],
      events: {},
      visible: {},
      longTasks: [],
      notifications: [],
      mutations: [],
    };
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__renderProbe.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // Long Task timing is optional in some Chromium builds.
    }

    const NativeWebSocket = window.WebSocket;
    function TrackingWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message?.type === "rpc" && typeof message.method === "string") {
            window.__renderProbe.rpc.push({
              requestId: String(message.requestId),
              method: message.method,
              at: performance.now(),
            });
          }
        } catch {
          // Only protocol timing metadata is relevant.
        }
        nativeSend(data);
      };
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          const payload = message?.payload;
          if (message?.type === "rpc/result") {
            const requestId = String(message.requestId);
            const request = window.__renderProbe.rpc.find((entry) => entry.requestId === requestId);
            if (request?.method === "thread/resume") {
              window.__renderProbe.events.threadResumeResultAt = performance.now();
            }
          }
          if (message?.type !== "codex/notification") return;
          const notification = {
            method: payload?.method || "unknown",
            at: performance.now(),
          };
          window.__renderProbe.notifications.push(notification);
          window.__renderProbe.lastNotification = notification;
          if (payload?.method === "item/agentMessage/delta") {
            const delta = String(payload.params?.delta || "");
            if (delta.includes("STREAM_FIRST_VISIBLE_MARKER")) {
              window.__renderProbe.events.firstDeltaReceivedAt = performance.now();
              window.__renderProbe.events.firstDeltaSourceToBrowserMs =
                Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
            }
            if (delta.includes("STREAM_FINAL_VISIBLE_MARKER")) {
              window.__renderProbe.events.finalDeltaReceivedAt = performance.now();
              window.__renderProbe.events.finalDeltaSourceToBrowserMs =
                Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
            }
            if (delta.includes("COMMAND_AFTER_LARGE_OUTPUT_MARKER")) {
              window.__renderProbe.events.commandMarkerReceivedAt = performance.now();
              window.__renderProbe.events.commandMarkerSourceToBrowserMs =
                Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
            }
            if (delta.includes("DIFF_AFTER_LARGE_PATCH_MARKER")) {
              window.__renderProbe.events.diffMarkerReceivedAt = performance.now();
              window.__renderProbe.events.diffMarkerSourceToBrowserMs =
                Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
            }
          }
          if (payload?.method === "item/commandExecution/outputDelta") {
            window.__renderProbe.events.largeCommandReceivedAt = performance.now();
            window.__renderProbe.events.largeCommandSourceToBrowserMs =
              Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
            window.__renderProbe.events.largeCommandCharacters =
              String(payload.params?.delta || "").length;
          }
          if (payload?.method === "item/fileChange/patchUpdated") {
            window.__renderProbe.events.largeDiffReceivedAt = performance.now();
            window.__renderProbe.events.largeDiffSourceToBrowserMs =
              Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
            window.__renderProbe.events.largeDiffCharacters = Array.isArray(payload.params?.changes)
              ? payload.params.changes.reduce(
                (total, change) => total + String(change?.diff || "").length,
                0,
              )
              : 0;
          }
          if (
            payload?.method === "item/completed"
            && String(payload.params?.item?.id || "").startsWith("item_render_probe_")
          ) {
            window.__renderProbe.events.itemCompletedReceivedAt = performance.now();
            window.__renderProbe.events.itemCompletedSourceToBrowserMs =
              Date.now() - Number(payload.params?.probeEmittedAtUnixMs);
          }
        } catch {
          // Non-JSON frames do not participate in this probe.
        }
      });
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

  const threadRow = page.locator(".thread-row", { hasText: "Browser recovery smoke test" });
  await threadRow.waitFor();
  await installTranscriptObserver(page);
  const threadOpenStartedAt = await page.evaluate(() => {
    window.__renderProbe.visible = {};
    window.__renderProbe.events.threadOpenStartedAt = performance.now();
    return window.__renderProbe.events.threadOpenStartedAt;
  });
  await threadRow.evaluate((node) => node.click());
  await page.getByText("The authoritative conversation was restored.", { exact: true }).waitFor();
  await page.waitForFunction(() => Number.isFinite(window.__renderProbe.visible.firstAssistantAt));

  const initialRender = await page.evaluate((startedAt) => {
    const probe = window.__renderProbe;
    const list = document.getElementById("messageList");
    return {
      openToFirstMessageMs: probe.visible.firstAssistantAt - startedAt,
      resumeResultToFirstMessageMs:
        probe.visible.firstAssistantAt - probe.events.threadResumeResultAt,
      renderedMessages: list.querySelectorAll(".message").length,
      elementNodes: list.querySelectorAll("*").length,
      allNodes: countTreeNodes(list),
    };

    function countTreeNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      let count = 0;
      while (walker.nextNode()) count += 1;
      return count;
    }
  }, threadOpenStartedAt);

  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("measure conversation render performance");
  const streamStartedAt = await page.evaluate(() => {
    window.__renderProbe.visible = {};
    window.__renderProbe.events.streamStartedAt = performance.now();
    return window.__renderProbe.events.streamStartedAt;
  });
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => Number.isFinite(window.__renderProbe.visible.firstMarkerAt));
  await page.waitForFunction(() => Number.isFinite(window.__renderProbe.visible.finalMarkerAt));
  await page.waitForFunction(
    (expected) => document.querySelectorAll("#messageList .message-file-link").length === expected,
    EXPECTED_FILE_LINKS,
  );
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await page.waitForFunction(() => Number.isFinite(window.__renderProbe.visible.fileLinksAt));

  const streamRender = await page.evaluate(({ startedAt, expectedLinks }) => {
    const probe = window.__renderProbe;
    const list = document.getElementById("messageList");
    const assistant = [...list.querySelectorAll(".message.agent")].at(-1);
    const text = assistant.querySelector(".message-text");
    const measurementEndedAt = probe.visible.fileLinksAt;
    const fileLinkMutation = probe.mutations.find((entry) => (
      entry.at >= startedAt && entry.fileLinks === expectedLinks
    ));
    const completedBeforeLinks = (
      Number.isFinite(probe.events.itemCompletedReceivedAt)
      && probe.events.itemCompletedReceivedAt <= probe.visible.fileLinksAt
    );
    const longTasks = probe.longTasks
      .filter((entry) => entry.startTime >= startedAt && entry.startTime < measurementEndedAt)
      .map((entry) => ({
        ...entry,
        measuredDuration: Math.min(entry.duration, measurementEndedAt - entry.startTime),
      }));
    return {
      payloadCharacters: text.textContent.length,
      fileLinkButtons: text.querySelectorAll(".message-file-link").length,
      semanticMarkdownElements: text.querySelectorAll(
        "h1,h2,h3,h4,h5,h6,strong,em,code,pre,ul,ol,li",
      ).length,
      elementNodes: assistant.querySelectorAll("*").length,
      allNodes: countTreeNodes(assistant),
      firstDeltaToVisibleMs: probe.visible.firstMarkerAt - probe.events.firstDeltaReceivedAt,
      finalDeltaToVisibleMs: probe.visible.finalMarkerAt - probe.events.finalDeltaReceivedAt,
      completionToFileLinksMs: completedBeforeLinks
        ? probe.visible.fileLinksAt - probe.events.itemCompletedReceivedAt
        : null,
      fileLinksBeforeCompletionMs: completedBeforeLinks
        ? null
        : probe.events.itemCompletedReceivedAt - probe.visible.fileLinksAt,
      fileLinkTriggerMethod: fileLinkMutation?.lastNotification?.method || null,
      fileLinkTriggerToVisibleMs: fileLinkMutation?.lastNotification
        ? fileLinkMutation.at - fileLinkMutation.lastNotification.at
        : null,
      firstDeltaSourceToBrowserMs: probe.events.firstDeltaSourceToBrowserMs,
      finalDeltaSourceToBrowserMs: probe.events.finalDeltaSourceToBrowserMs,
      completionSourceToBrowserMs: probe.events.itemCompletedSourceToBrowserMs,
      probeDurationMs: probe.visible.fileLinksAt - startedAt,
      timeline: {
        firstDeltaReceivedMs: probe.events.firstDeltaReceivedAt - startedAt,
        firstMarkerVisibleMs: probe.visible.firstMarkerAt - startedAt,
        finalDeltaReceivedMs: probe.events.finalDeltaReceivedAt - startedAt,
        finalMarkerVisibleMs: probe.visible.finalMarkerAt - startedAt,
        itemCompletedReceivedMs: probe.events.itemCompletedReceivedAt - startedAt,
        fileLinksVisibleMs: probe.visible.fileLinksAt - startedAt,
        mutations: probe.mutations
          .filter((entry) => entry.at >= startedAt)
          .map((entry) => ({
            ...entry,
            at: entry.at - startedAt,
            lastNotification: entry.lastNotification
              ? {
                ...entry.lastNotification,
                at: entry.lastNotification.at - startedAt,
              }
              : null,
          })),
      },
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, entry) => sum + entry.measuredDuration, 0),
      longestTaskMs: Math.max(0, ...longTasks.map((entry) => entry.measuredDuration)),
      longTaskRatio:
        longTasks.reduce((sum, entry) => sum + entry.measuredDuration, 0)
        / (probe.visible.fileLinksAt - startedAt),
      fileLinkCountMatches: text.querySelectorAll(".message-file-link").length === expectedLinks,
    };

    function countTreeNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      let count = 0;
      while (walker.nextNode()) count += 1;
      return count;
    }
  }, { startedAt: streamStartedAt, expectedLinks: EXPECTED_FILE_LINKS });

  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("measure current large payload blocking");
  const largePayloadStartedAt = await page.evaluate(() => {
    window.__renderProbe.visible = {};
    for (const key of [
      "largeCommandReceivedAt",
      "largeCommandSourceToBrowserMs",
      "largeCommandCharacters",
      "commandMarkerReceivedAt",
      "commandMarkerSourceToBrowserMs",
      "largeDiffReceivedAt",
      "largeDiffSourceToBrowserMs",
      "largeDiffCharacters",
      "diffMarkerReceivedAt",
      "diffMarkerSourceToBrowserMs",
    ]) delete window.__renderProbe.events[key];
    window.__renderProbe.events.largePayloadStartedAt = performance.now();
    return window.__renderProbe.events.largePayloadStartedAt;
  });
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    () => Number.isFinite(window.__renderProbe.visible.commandMarkerAt),
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => Number.isFinite(window.__renderProbe.visible.diffMarkerAt),
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    (expectedRows) => (
      document.querySelectorAll("#messageList .transcript-diff .git-diff-line").length >= expectedRows
    ),
    EXPECTED_LARGE_DIFF_ROWS,
    { timeout: 30_000 },
  );
  await page.locator("#stopTurnButton").waitFor({ state: "hidden", timeout: 30_000 });
  await page.waitForTimeout(300);

  const largePayloadRender = await page.evaluate(async (startedAt) => {
    const probe = window.__renderProbe;
    const list = document.getElementById("messageList");
    const commandDetails = [...list.querySelectorAll("details.tool-item")].find(
      (details) => details.querySelector("summary strong")?.textContent.includes("generate-large-output"),
    );
    const diffDetails = list.querySelector("details.file-change-item");
    if (!commandDetails || !diffDetails) throw new Error("large payload transcript nodes are missing");
    const commandOutput = commandDetails.querySelector(".tool-output");
    const endedAt = performance.now();
    const longTasks = probe.longTasks
      .filter((entry) => entry.startTime >= startedAt && entry.startTime < endedAt)
      .map((entry) => ({
        ...entry,
        measuredDuration: Math.min(entry.duration, endedAt - entry.startTime),
      }));
    const beforeCollapse = {
      commandOpen: commandDetails.open,
      commandRenderedCharacters: commandOutput?.textContent.length || 0,
      commandElementNodes: commandDetails.querySelectorAll("*").length,
      commandAllNodes: countTreeNodes(commandDetails),
      diffOpen: diffDetails.open,
      diffRows: diffDetails.querySelectorAll(".git-diff-line").length,
      diffElementNodes: diffDetails.querySelectorAll("*").length,
      diffAllNodes: countTreeNodes(diffDetails),
    };
    commandDetails.open = false;
    diffDetails.open = false;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterCollapse = {
      commandOpen: commandDetails.open,
      commandRenderedCharacters: commandOutput?.textContent.length || 0,
      commandElementNodes: commandDetails.querySelectorAll("*").length,
      commandAllNodes: countTreeNodes(commandDetails),
      diffOpen: diffDetails.open,
      diffRows: diffDetails.querySelectorAll(".git-diff-line").length,
      diffElementNodes: diffDetails.querySelectorAll("*").length,
      diffAllNodes: countTreeNodes(diffDetails),
    };
    return {
      sourcePayload: {
        commandCharacters: probe.events.largeCommandCharacters,
        diffCharacters: probe.events.largeDiffCharacters,
      },
      sourceToBrowserMs: {
        command: probe.events.largeCommandSourceToBrowserMs,
        commandMarker: probe.events.commandMarkerSourceToBrowserMs,
        diff: probe.events.largeDiffSourceToBrowserMs,
        diffMarker: probe.events.diffMarkerSourceToBrowserMs,
      },
      browserReceiveToVisibleMs: {
        commandPayloadToMarker:
          probe.visible.commandMarkerAt - probe.events.largeCommandReceivedAt,
        commandMarker:
          probe.visible.commandMarkerAt - probe.events.commandMarkerReceivedAt,
        diffPayloadToMarker:
          probe.visible.diffMarkerAt - probe.events.largeDiffReceivedAt,
        diffMarker:
          probe.visible.diffMarkerAt - probe.events.diffMarkerReceivedAt,
      },
      totalDurationMs: endedAt - startedAt,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, entry) => sum + entry.measuredDuration, 0),
      longestTaskMs: Math.max(0, ...longTasks.map((entry) => entry.measuredDuration)),
      longTaskRatio:
        longTasks.reduce((sum, entry) => sum + entry.measuredDuration, 0)
        / (endedAt - startedAt),
      beforeCollapse,
      afterCollapse,
      collapsedBodiesRemainMounted:
        afterCollapse.commandRenderedCharacters === beforeCollapse.commandRenderedCharacters
        && afterCollapse.commandAllNodes === beforeCollapse.commandAllNodes
        && afterCollapse.diffRows === beforeCollapse.diffRows
        && afterCollapse.diffAllNodes === beforeCollapse.diffAllNodes,
    };

    function countTreeNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      let count = 0;
      while (walker.nextNode()) count += 1;
      return count;
    }
  }, largePayloadStartedAt);

  assert.deepEqual(pageErrors, []);
  assert.equal(streamRender.fileLinkCountMatches, true);
  assert.equal(streamRender.semanticMarkdownElements, 0);
  assert.equal(largePayloadRender.sourcePayload.commandCharacters, 2 * 1024 * 1024);
  assert.equal(largePayloadRender.beforeCollapse.diffRows, EXPECTED_LARGE_DIFF_ROWS);
  assert.equal(largePayloadRender.afterCollapse.commandOpen, false);
  assert.equal(largePayloadRender.afterCollapse.diffOpen, false);
  assert.equal(largePayloadRender.collapsedBodiesRemainMounted, true);
  const result = {
    ok: true,
    environment: {
      transport: "random-port-http-websocket",
      appServer: "fake-codex-app-server",
      viewport: "1280x720",
      productionRequests: 0,
      rescuePortTouched: false,
    },
    renderer: {
      assistantBodyMode: "plain-text-with-project-file-links",
      markdownSemanticElements: streamRender.semanticMarkdownElements,
    },
    initialRender: {
      ...initialRender,
      budgetMs: THREAD_OPEN_BUDGET_MS,
      targetMet: initialRender.openToFirstMessageMs <= THREAD_OPEN_BUDGET_MS,
    },
    streaming: {
      ...streamRender,
      firstVisibleBudgetMs: FIRST_VISIBLE_BUDGET_MS,
      targetMet: streamRender.firstDeltaToVisibleMs <= FIRST_VISIBLE_BUDGET_MS,
    },
    currentLargePayload: {
      ...largePayloadRender,
      target: {
        collapsedCommandBodyCharacters: 0,
        collapsedDiffRows: 0,
        longestMainThreadSliceMs: 8,
      },
      targetMet:
        largePayloadRender.afterCollapse.commandRenderedCharacters === 0
        && largePayloadRender.afterCollapse.diffRows === 0
        && largePayloadRender.longestTaskMs <= 8,
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

async function installTranscriptObserver(page) {
  await page.evaluate(() => {
    const list = document.getElementById("messageList");
    const inspect = () => {
      const probe = window.__renderProbe;
      const now = performance.now();
      if (!Number.isFinite(probe.visible.firstAssistantAt) && list.querySelector(".message.agent")) {
        probe.visible.firstAssistantAt = now;
      }
      const text = [...list.querySelectorAll(".message.agent .message-text")]
        .map((node) => node.textContent || "")
        .join("\n");
      if (!Number.isFinite(probe.visible.firstMarkerAt) && text.includes("STREAM_FIRST_VISIBLE_MARKER")) {
        probe.visible.firstMarkerAt = now;
      }
      if (!Number.isFinite(probe.visible.finalMarkerAt) && text.includes("STREAM_FINAL_VISIBLE_MARKER")) {
        probe.visible.finalMarkerAt = now;
      }
      if (
        !Number.isFinite(probe.visible.fileLinksAt)
        && list.querySelectorAll(".message-file-link").length === EXPECTED_FILE_LINKS
      ) {
        probe.visible.fileLinksAt = now;
      }
      if (
        !Number.isFinite(probe.visible.commandMarkerAt)
        && text.includes("COMMAND_AFTER_LARGE_OUTPUT_MARKER")
      ) {
        probe.visible.commandMarkerAt = now;
      }
      if (
        !Number.isFinite(probe.visible.diffMarkerAt)
        && text.includes("DIFF_AFTER_LARGE_PATCH_MARKER")
      ) {
        probe.visible.diffMarkerAt = now;
      }
      const fileLinks = list.querySelectorAll(".message-file-link").length;
      if (probe.lastFileLinkCount !== fileLinks) {
        probe.lastFileLinkCount = fileLinks;
        probe.mutations.push({
          at: now,
          fileLinks,
          lastNotification: probe.lastNotification || null,
        });
      }
    };
    const EXPECTED_FILE_LINKS = 320;
    new MutationObserver(inspect).observe(list, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    inspect();
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
