import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ProviderStore } from "../../lib/provider-store.mjs";

const projectDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fakeCodex = path.join(projectDirectory, "test", "fixtures", "fake-codex-app-server.mjs");
const fakeClaude = path.join(projectDirectory, "test", "fixtures", "fake-claude-control.mjs");
const screenshots = path.join(projectDirectory, "test-results");
let browser;
let child;
let directory;
let baseUrl;
let defaultProject;
const execFileAsync = promisify(execFile);

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-browser-smoke-"));
  const projectRoot = path.join(directory, "projects");
  defaultProject = path.join(projectRoot, "smoke-project");
  const gameDirectory = path.join(defaultProject, "game");
  const mapDirectory = path.join(defaultProject, "maps");
  const stateDirectory = path.join(directory, "state");
  const fakeBin = path.join(directory, "bin");
  const homeDirectory = path.join(directory, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const codexMemoryDirectory = path.join(codexHome, "memories", "durable");
  const claudeConfigDirectory = path.join(homeDirectory, ".wfl-claude");
  const codexSkillDirectory = path.join(defaultProject, ".codex", "skills", "release-check");
  await Promise.all([
    fs.mkdir(defaultProject, { recursive: true }),
    fs.mkdir(gameDirectory, { recursive: true }),
    fs.mkdir(mapDirectory, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(codexMemoryDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(claudeConfigDirectory, { recursive: true }),
    fs.mkdir(codexSkillDirectory, { recursive: true }),
    fs.mkdir(screenshots, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(gameDirectory, "index.html"),
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/game/game.css"></head><body><canvas id="game" width="320" height="180"></canvas><script type="module" src="/game/game.mjs"></script></body></html>',
    ),
    fs.writeFile(
      path.join(gameDirectory, "game.css"),
      "html,body{margin:0;width:100%;height:100%;display:grid;place-items:center;background:#17212a}canvas{width:min(92vw,640px);height:auto;box-shadow:0 10px 32px #0008}",
    ),
    fs.writeFile(
      path.join(gameDirectory, "game.mjs"),
      "const canvas=document.querySelector('#game');const context=canvas.getContext('2d');context.fillStyle='#ef4444';context.fillRect(0,0,320,180);context.fillStyle='#22c55e';context.fillRect(32,28,256,124);context.fillStyle='#f8fafc';context.font='bold 26px sans-serif';context.fillText('CODEX GAME',68,102);document.body.dataset.previewReady='true';",
    ),
    fs.writeFile(path.join(mapDirectory, "world.tmj"), `${JSON.stringify({
      height: 1,
      infinite: false,
      layers: [{ data: [0], height: 1, id: 1, name: "Ground", type: "tilelayer", width: 1 }],
      nextlayerid: 2,
      nextobjectid: 1,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.11.2",
      tileheight: 16,
      tilesets: [],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 1,
    }, null, 2)}\n`),
    fs.writeFile(
      path.join(defaultProject, "fixture-view.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8xN3wAAAABJRU5ErkJggg==", "base64"),
    ),
    fs.copyFile(path.join(projectDirectory, "VERSION"), path.join(defaultProject, "VERSION")),
    fs.copyFile(path.join(projectDirectory, "CHANGELOG.md"), path.join(defaultProject, "CHANGELOG.md")),
    fs.writeFile(path.join(defaultProject, "remote-review.txt"), "Remote comparison baseline.\n"),
    fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(fakeOfficialAuth()), { mode: 0o600 }),
    fs.writeFile(
      path.join(codexMemoryDirectory, "preferences.md"),
      "Preferred test language: Chinese\nAPI_KEY=sk_browser_memory_secret\n",
      { mode: 0o600 },
    ),
    fs.writeFile(
      path.join(codexSkillDirectory, "SKILL.md"),
      "---\nname: release-check\ndescription: Check release readiness\n---\n\nInspect the current release.\n",
    ),
    fs.writeFile(path.join(claudeConfigDirectory, ".claude.json"), `${JSON.stringify({
      mcpServers: {
        "fixture-mcp": {
          type: "http",
          url: "https://mcp.example.test/service",
          headers: { Authorization: "Bearer browser-secret" },
        },
      },
    }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: defaultProject });
  await execFileAsync("git", ["config", "user.name", "Browser Fixture"], { cwd: defaultProject });
  await execFileAsync("git", ["config", "user.email", "browser-fixture@example.test"], { cwd: defaultProject });
  await execFileAsync("git", ["add", "--all"], { cwd: defaultProject });
  await execFileAsync("git", ["commit", "-m", "test: initialize browser fixture"], { cwd: defaultProject });
  const remoteDirectory = path.join(directory, "browser-origin.git");
  await execFileAsync("git", ["init", "--bare", remoteDirectory]);
  await execFileAsync("git", ["remote", "add", "origin", remoteDirectory], { cwd: defaultProject });
  await execFileAsync("git", ["push", "--set-upstream", "origin", "main"], { cwd: defaultProject });
  await fs.writeFile(path.join(defaultProject, "review-target.txt"), "Review target before staging.\n");
  const browserProviderStore = await new ProviderStore(stateDirectory).initialize();
  await browserProviderStore.create({
    name: "Browser current provider",
    baseUrl: "https://browser-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "browser-provider-test-secret",
  });
  await browserProviderStore.create({
    name: "Browser alternate provider",
    baseUrl: "https://browser-alternate.example.test/v1",
    model: "gpt-alternate",
    apiKey: "browser-alternate-test-secret",
  });
  const claudeStateDirectory = path.join(stateDirectory, "claude");
  await fs.mkdir(claudeStateDirectory, { recursive: true });
  await fs.writeFile(path.join(claudeStateDirectory, "sessions.json"), `${JSON.stringify({
    version: 2,
    sessions: [{
      id: "33333333-3333-4333-8333-333333333333",
      cwd: defaultProject,
      name: "Claude transcript fixture",
      model: "sonnet",
      resolvedModel: "claude-sonnet-5",
      suggestion: "Run the focused browser tests",
      permissionMode: "acceptEdits",
      effort: "high",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      nativeStarted: false,
      messages: [
        { id: "fixture-user", type: "message", role: "user", content: "Inspect the browser fixture", at: Date.now() },
        { id: "system:init", type: "system", subtype: "init", content: "claude-sonnet-5 · acceptEdits", status: "completed", at: Date.now() },
        { id: "fixture-thinking", type: "thinking", content: "Reading the fixture", status: "completed", at: Date.now() },
        { id: "fixture-bash", type: "tool", toolUseId: "fixture-bash", name: "Bash", title: "npm test", category: "command", input: { command: "npm test" }, output: "2 tests passed", status: "completed", at: Date.now() },
        { id: "fixture-edit", type: "tool", toolUseId: "fixture-edit", name: "Edit", title: "Edit · public/app.js", category: "file", input: { file_path: "public/app.js", old_string: "old line", new_string: "new line" }, output: "Updated public/app.js", status: "completed", at: Date.now() },
        { id: "fixture-agent", type: "message", role: "assistant", content: "Fixture work completed.", at: Date.now() },
        { id: "fixture-compact", type: "system", subtype: "compact_boundary", content: "manual", status: "completed", at: Date.now() },
        { id: "fixture-result", type: "result", status: "completed", isError: false, durationMs: 1250, costUsd: 0.0123, numTurns: 2, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 40 }, permissionDenials: [], at: Date.now() },
      ],
    }],
  })}\n`, { mode: 0o600 });
  const shim = path.join(fakeBin, "codex");
  const claudeShim = path.join(fakeBin, "claude");
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    claudeShim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`,
    { mode: 0o755 },
  );
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: homeDirectory,
      CODEX_HOME: codexHome,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
      CODEX_DESKTOP_AUTH_FILE: path.join(directory, "missing-auth.json"),
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: defaultProject,
      CODEX_DESKTOP_RUNTIME_DIR: path.join(directory, "runtime"),
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_RESCUE_SLOT: "",
      CODEX_DESKTOP_RESCUE_SESSION_DIR: "",
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: claudeShim,
      FAKE_CLAUDE_RESPONSES: path.join(directory, "claude-control-responses.jsonl"),
      FAKE_CLAUDE_INPUTS: path.join(directory, "claude-inputs.jsonl"),
      FAKE_CLAUDE_PLUGIN_ACTIONS: path.join(directory, "claude-plugin-actions.jsonl"),
      FAKE_CODEX_PROJECT: defaultProject,
      FAKE_CODEX_REPEAT_RESUME_DELAY_MS: "1200",
      FAKE_CODEX_OFFICIAL_LOGIN_DELAY_MS: "12000",
      NODE_ENV: "test",
      CODEX_DESKTOP_OFFICIAL_BROWSER_TEST_MODE: "1",
      CODEX_DESKTOP_OFFICIAL_PROXY_TEST_MODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(child, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
});

after(async () => {
  await browser?.close();
  child?.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child?.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await fs.rm(directory, { recursive: true, force: true });
});

test("serves application HTML inline without archive-looking placeholder URLs", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response.headers()["content-disposition"], 'inline; filename="index.html"');
  assert.equal(response.headers()["x-download-options"], "noopen");
  assert.doesNotMatch(await page.content(), /https?:\/\/[^\s"']+\.zip/i);
  await page.close();
});

test("opens the Codex socket before delayed recovery data finishes loading", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let releaseRecovery;
  let recoveryReleased = false;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  let markRecoveryStarted;
  const recoveryStarted = new Promise((resolve) => { markRecoveryStarted = resolve; });
  await page.route("**/api/recovery?*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    markRecoveryStarted();
    await recoveryGate;
    recoveryReleased = true;
    await route.continue();
  });
  const bridgeStatus = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket status did not arrive before recovery completed")), 8_000);
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          if (message.type !== "bridge/status") return;
          clearTimeout(timer);
          resolve(message);
        } catch {
          // Ignore non-JSON WebSocket frames.
        }
      });
    });
  });
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await recoveryStarted;
    await bridgeStatus;
    assert.equal(recoveryReleased, false);
    assert.equal(await page.locator("#sendButton").isDisabled(), true);
    assert.match(await page.locator("#turnStatus").innerText(), /正在同步/);
  } finally {
    releaseRecovery();
  }
  await waitForCodexConnection(page);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.close();
});

test("opens the Codex socket while the account summary is delayed", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let releaseAccount;
  const accountGate = new Promise((resolve) => { releaseAccount = resolve; });
  let markAccountStarted;
  const accountStarted = new Promise((resolve) => { markAccountStarted = resolve; });
  await page.route("**/api/account?summary=1&*", async (route) => {
    markAccountStarted();
    await accountGate;
    await route.continue();
  });
  const bridgeStatus = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket status waited for the account summary")), 8_000);
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          if (message.type !== "bridge/status") return;
          clearTimeout(timer);
          resolve(message);
        } catch {
          // Ignore non-JSON WebSocket frames.
        }
      });
    });
  });
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await accountStarted;
    await bridgeStatus;
    assert.equal(await page.locator("#sendButton").isDisabled(), true);
  } finally {
    releaseAccount();
  }
  await waitForCodexConnection(page);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.close();
});

test("keeps the Codex composer stable during a transient socket outage", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(10_000);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: "none",
    });
    await page.locator('#connectionPill[data-status="reconnecting"]').waitFor();
    assert.equal(await page.locator("#sendButton").isDisabled(), false);
    assert.match(await page.locator("#turnStatus").innerText(), /正在重连/);
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });
    await waitForCodexConnection(page);
    await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    }).catch(() => {});
    await cdp.detach().catch(() => {});
    await page.close();
  }
});

test("switches the interface language without translating project or conversation content", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  await page.locator("#settingsButton").click();
  await page.locator("#settingsDialog").waitFor({ state: "visible" });
  await page.locator("#interfaceLanguage").selectOption("en");
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal(await page.locator("#settingsDialog h2").innerText(), "Settings");
  assert.equal(await page.locator("#promptInput").getAttribute("placeholder"), "Send a task to Codex");
  assert.equal(await page.locator("#interfaceLanguage").inputValue(), "en");
  await page.locator('#settingsDialog [value="cancel"]').first().click();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshots, "interface-english-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshots, "interface-english-mobile.png"), fullPage: true });

  await page.evaluate(() => {
    document.getElementById("currentProjectName").textContent = "工作区";
    const protectedMessage = document.createElement("div");
    protectedMessage.id = "i18nProtectedMessage";
    protectedMessage.className = "message-text";
    protectedMessage.textContent = "正在连接";
    document.getElementById("messageList").append(protectedMessage);
    window.WFLI18n.setLanguage("en");
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#currentProjectName").innerText(), "工作区");
  assert.equal(await page.locator("#i18nProtectedMessage").innerText(), "正在连接");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex connected");
  assert.equal(await page.locator("#settingsButton").getAttribute("title"), "Settings");
  await page.locator("#settingsButton").click();
  await page.locator("#interfaceLanguage").selectOption("zh-CN");
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.equal(await page.locator("#settingsDialog h2").innerText(), "设置");
  await page.close();
});

test("controls native Codex Memories and keeps the settings usable on mobile", { timeout: 35_000 }, async () => {
  const desktopViewport = { width: 1280, height: 800 };
  const page = await browser.newPage({ viewport: desktopViewport });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).first().click();

  await page.locator("#settingsButton").click();
  await page.locator("#settingsDialog").waitFor({ state: "visible" });
  await page.locator("#codexMemorySettingsSection").waitFor({ state: "visible" });
  assert.equal(await page.locator("#codexMemoryEnabledInput").isChecked(), false);
  await page.locator(".codex-memory-file-button", { hasText: "durable/preferences.md" }).click().catch(async (error) => {
    throw new Error(`${error.message}; status=${await page.locator("#codexMemoryStatus").innerText()}; settingsError=${await page.locator("#settingsError").innerText()}; files=${await page.locator("#codexMemoryFileList").innerText()}`);
  });
  await page.locator("#codexMemoryPreview").waitFor({ state: "visible" });
  assert.match(await page.locator("#codexMemoryPreviewContent").innerText(), /Preferred test language/);
  assert.doesNotMatch(await page.locator("#codexMemoryPreviewContent").innerText(), /sk_browser_memory_secret/);

  await page.locator("#codexMemoryEnabledInput").check();
  await page.locator("#codexMemoryUseInput").uncheck();
  await page.locator("#codexMemoryGenerateInput").check();
  await page.locator("#codexMemoryExternalInput").check();
  await page.locator("#saveSettingsButton").click();
  await page.locator("#settingsDialog").waitFor({ state: "hidden" });

  await page.locator("#settingsButton").click();
  await page.locator("#settingsDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#codexMemoryEnabledInput").isChecked(), true);
  assert.equal(await page.locator("#codexMemoryUseInput").isChecked(), false);
  assert.equal(await page.locator("#codexMemoryGenerateInput").isChecked(), true);
  assert.equal(await page.locator("#codexMemoryExternalInput").isChecked(), true);
  await page.locator("#codexMemoryThreadToggleButton").click();
  await page.locator("#codexMemoryThreadToggleButton").getByText("启用此对话", { exact: true }).waitFor();
  await page.locator("#codexMemoryThreadState").getByText("此对话不会读取或贡献记忆", { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await assertBoundedByViewport(page.locator("#settingsDialog"), { width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  await page.locator("#codexMemorySettingsSection").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, "codex-memories-390.png"), fullPage: true });
  await page.evaluate(() => fetch("/api/recovery/thread_smoke_001", { method: "DELETE" }));
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("throttles system status polling while hidden and refreshes when visible", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let statusRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/system/status") statusRequests += 1;
  });
  const initialStatus = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/system/status");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await initialStatus;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  const hiddenBaseline = statusRequests;
  await page.waitForTimeout(5_500);
  assert.equal(statusRequests, hiddenBaseline);

  const resumedStatus = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/system/status");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await resumedStatus;
  assert.ok(statusRequests > hiddenBaseline);
  await page.close();
});

test("keeps a healthy desktop free of false fatal recovery banners", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  assert.equal(await page.locator("#bootRecoveryBar").isHidden(), true);

  await page.evaluate(() => window.dispatchEvent(new Event("unhandledrejection")));
  assert.equal(await page.locator("#bootRecoveryBar").isHidden(), true);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("codex-desktop:fatal-error")));
  await page.locator("#bootRecoveryBar").waitFor({ state: "visible" });
  await page.close();
});

test("desktop loads without runtime faults and re-reads the active conversation", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  const threadRow = page.locator(".thread-row", { hasText: "Browser recovery smoke test" });
  const recoveryRecorded = page.waitForResponse(
    (response) => response.url().endsWith("/api/recovery") && response.request().method() === "POST",
  );
  await threadRow.click();
  await recoveryRecorded;
  await page.getByText("The authoritative conversation was restored.").waitFor();
  await page.getByText("Historical response 14", { exact: true }).waitFor();
  assert.equal(await page.getByText("Historical response 13", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Historical response 1", { exact: true }).count(), 0);
  const firstHistoryPageButton = page.getByRole("button", { name: "加载更早记录" });
  await firstHistoryPageButton.click();
  await page.getByText("Historical response 6", { exact: true }).waitFor();
  assert.equal(await page.getByText("Historical response 5", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Historical response 1", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "加载更早记录" }).evaluate((button) => button.click());
  await page.getByText("Historical response 1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "已经到最早记录" }).waitFor();
  assert.equal(await page.getByText("Historical response 1", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Historical response 2", { exact: true }).count(), 1);
  await page.locator("#panelsButton").click();
  await threadRow.click();
  await page.getByText("The authoritative conversation was restored.").waitFor();

  await page.goto(`${baseUrl}/ops`, { waitUntil: "domcontentloaded" });
  await page.locator(".ops-shell").waitFor();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByText("The authoritative conversation was restored.").waitFor({ timeout: 8_000 });
  assert.equal(await page.getByText("正在恢复对话", { exact: true }).count(), 0);
  await waitForCodexConnection(page);
  await page.waitForTimeout(1300);

  await page.locator("#newThreadButton").click();
  await page.locator("#panelsButton").click();
  await threadRow.click();
  await page.getByText("The authoritative conversation was restored.").waitFor({ timeout: 8_000 });
  assert.equal(await page.getByText("正在恢复对话", { exact: true }).count(), 0);
  await page.waitForTimeout(1300);

  await page.locator("#panelsButton").click();
  await page.locator("#recoveryButton").click();
  await page.locator("#recoveryDialog").waitFor({ state: "visible" });
  await page.locator(".recovery-row", { hasText: "thread_smoke_001" }).waitFor();
  await page.locator("#recoveryCloseButton").click();

  assert.deepEqual(pageErrors, []);
  assert.equal(await page.locator("#bootRecoveryBar").isHidden(), true);
  assert.ok((await page.locator(".workspace").innerText()).trim().length > 40);
  await assertVerticalStack(page, [".titlebar", ".commandbar", ".workspace", ".statusbar"]);
  if (!await page.locator("#taskStatusBar").isHidden()) {
    await assertContainedBy(page, "#taskStatusBar", "#messageStage");
  }
  await page.screenshot({ path: path.join(screenshots, "smoke-desktop.png"), fullPage: true });
  await page.evaluate(() => window.dispatchEvent(new Event("unhandledrejection")));
  assert.equal(await page.locator("#bootRecoveryBar").isHidden(), true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("codex-desktop:fatal-error")));
  await page.locator("#bootRecoveryBar").waitFor({ state: "visible" });
  assert.equal(await page.locator("#bootRecoveryBar a").getAttribute("href"), "/rescue/");
  await page.close();
});

test("a summary-only terminal Turn preserves the user's completed message without a history refresh", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let recentTurnReads = 0;
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message?.type === "rpc" && message.method === "thread/turns/list") recentTurnReads += 1;
    } catch {}
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).first().click();
  await page.getByText("The authoritative conversation was restored.", { exact: true }).waitFor();
  const readsBeforeTurn = recentTurnReads;
  const prompt = "complete with terminal summary only";
  await page.locator("#promptInput").fill(prompt);
  await page.locator("#sendButton").click();
  await page.getByText(
    "The summary-only completion preserved the complete live Turn.",
    { exact: true },
  ).waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.waitForTimeout(300);
  assert.equal(await page.getByText(prompt, { exact: true }).count(), 1);
  assert.equal(recentTurnReads, readsBeforeTurn);
  await page.close();
});

test("paginates one oversized turn without duplicate or out-of-order items", { timeout: 35_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("generate paginated turn history");
  await page.locator("#sendButton").click();
  await page.getByText("Paginated turn item 120", { exact: true }).waitFor();
  await page.getByText("Paginated turn item 1", { exact: true }).waitFor();
  await page.getByRole("button", { name: /加载本轮更早内容/ }).waitFor({ state: "hidden" });
  assert.equal(await page.getByText("Paginated turn item 50", { exact: true }).count(), 1);
  await page.locator("#threadTitleInput").fill("Paginated cache thread");
  await page.locator("#threadTitleInput").press("Enter");
  await page.locator("#newThreadButton").click();
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Paginated cache thread" }).click();
  await page.getByText("Paginated turn item 1", { exact: true }).waitFor();
  assert.equal(await page.getByText("Paginated turn item 50", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /加载本轮更早内容/ }).count(), 0);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("renders trusted Codex 0.146 safety events and safely previews imageView items", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8_000);
  const pageErrors = [];
  const notificationMethods = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message.type === "codex/notification" && message.payload?.method) {
        notificationMethods.push(message.payload.method);
      }
    } catch {
      // Only protocol notifications are useful to this diagnostic.
    }
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#newThreadButton").click();

  await page.evaluate(() => new Promise((resolve) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "codex/notification",
        payload: {
          method: "model/verification",
          params: {
            threadId: "forged",
            turnId: "forged",
            verifications: ["trustedAccessForCyber"],
          },
        },
      }));
      setTimeout(() => {
        socket.close();
        resolve();
      }, 100);
    });
  }));
  assert.equal(await page.locator(".model-verification-card").count(), 0);

  await page.locator("#promptInput").fill("show codex 0.146 events");
  await page.locator("#sendButton").click();
  await page.locator(".model-safety-card").waitFor();
  await page.locator(".model-verification-card").waitFor().catch((error) => {
    throw new Error(`${error.message}; notifications=${JSON.stringify(notificationMethods)}`);
  });
  await page.locator(".guardian-review-card").waitFor().catch((error) => {
    throw new Error(`${error.message}; notifications=${JSON.stringify(notificationMethods)}`);
  });
  await page.locator(".viewed-image img").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const image = document.querySelector(".viewed-image img");
    return image?.complete && image.naturalWidth === 1;
  });
  await page.getByText("模型已改道", { exact: true }).waitFor().catch((error) => {
    throw new Error(`${error.message}; notifications=${JSON.stringify(notificationMethods)}`);
  });
  assert.ok(notificationMethods.includes("future/safeEvent"));
  assert.equal(await page.getByText(/未识别事件 · future\/safeEvent/).count(), 0);
  assert.equal(await page.getByText("must-be-redacted", { exact: false }).count(), 0);
  const guardian = page.locator(".guardian-review-card");
  await guardian.getByText("已拒绝", { exact: true }).waitFor();
  assert.match(await guardian.innerText(), /严重风险.*低授权.*(?:permission boundary|权限边界)/s);
  assert.doesNotMatch(await guardian.innerText(), /must-be-redacted|credentials|password/i);
  assert.ok(notificationMethods.includes("thread/environment/connected"));
  assert.ok(notificationMethods.includes("thread/environment/disconnected"));
  assert.equal(await page.getByText("执行环境 · fixture-devbox", { exact: true }).count(), 0);

  const fasterButton = page.getByRole("button", { name: /后续任务改用 smoke-fast/ });
  await fasterButton.click();
  await page.waitForFunction(() => document.getElementById("modelSelect")?.value === "gpt-smoke-fast");
  assert.match(await page.locator(".model-verification-card").innerText(), /服务端要求/);
  const mobileViewport = { width: 390, height: 844 };
  await page.setViewportSize(mobileViewport);
  await page.locator(".model-verification-card").scrollIntoViewIfNeeded();
  await assertBoundedByViewport(page.locator(".model-verification-card"), mobileViewport);
  await guardian.scrollIntoViewIfNeeded();
  await assertBoundedByViewport(guardian, mobileViewport);
  await page.locator(".viewed-image").scrollIntoViewIfNeeded();
  await assertBoundedByViewport(page.locator(".viewed-image"), mobileViewport);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("shows official context usage and completes manual compaction on desktop and mobile", { timeout: 30_000 }, async () => {
  const desktopViewport = { width: 1280, height: 720 };
  const desktop = await browser.newPage({ viewport: desktopViewport });
  desktop.setDefaultTimeout(8_000);
  const desktopErrors = [];
  desktop.on("pageerror", (error) => desktopErrors.push(error.message));
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(desktop);
  await desktop.locator("#panelsButton").click();
  await desktop.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await desktop.locator("#contextStatusLabel").getByText("<1%", { exact: true }).waitFor();
  await desktop.locator("#contextStatusButton").click();
  const contextDialog = desktop.locator("#contextDialog");
  await contextDialog.waitFor({ state: "visible" });
  assert.equal(await desktop.locator("#contextUsageDetail").innerText(), "99 / 20 万 Token");
  assert.equal(await desktop.locator("#contextWindowValue").innerText(), "20 万 Token");
  assert.equal(await desktop.locator("#contextCumulativeValue").innerText(), "99 Token");
  assert.equal(await desktop.locator("#contextAutoCompactValue").innerText(), "16 万 · 80% · 主体");
  assert.equal(await desktop.locator("#contextCompactionCountValue").innerText(), "已加载 0 次");
  await assertBoundedByViewport(contextDialog, desktopViewport);

  desktop.once("dialog", (confirmation) => confirmation.accept());
  await desktop.locator("#compactThreadButton").click();
  await desktop.locator(".context-compaction-marker", { hasText: /正在压缩上下文|上下文已压缩/ }).waitFor();
  await contextDialog.locator('.modal-header [value="cancel"]').click();
  await desktop.locator("#newThreadButton").click();
  await desktop.locator("#emptyState").waitFor({ state: "visible" });
  await desktop.waitForTimeout(400);
  await desktop.locator("#panelsButton").click();
  await desktop.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await desktop.getByText("上下文已压缩", { exact: true }).waitFor();
  await desktop.locator("#contextStatusButton").click();
  await contextDialog.waitFor({ state: "visible" });
  await desktop.locator("#contextCompactionCountValue").getByText("至少 1 次", { exact: true }).waitFor();
  await desktop.waitForFunction(() => !document.getElementById("compactThreadButton")?.disabled);
  assert.equal(await desktop.locator("#contextLastCompactionValue").innerText() === "未记录", false);
  assert.deepEqual(desktopErrors, []);
  await desktop.screenshot({ path: path.join(screenshots, "context-usage-1280.png"), fullPage: true });
  await desktop.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(12_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#panelsButton").click();
  await mobile.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await mobile.locator("#contextStatusLabel").getByText("<1%", { exact: true }).waitFor();
  await mobile.locator("#contextStatusButton").click();
  await mobile.locator("#contextDialog").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#contextDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  assert.deepEqual(mobileErrors, []);
  await mobile.screenshot({ path: path.join(screenshots, "context-usage-390.png"), fullPage: true });
  await mobile.close();
});

test("refreshes the active conversation without a full page reload", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let navigations = 0;
  page.on("framenavigated", () => { navigations += 1; });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const initialNavigations = navigations;
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).first().click();
  await page.getByText("The authoritative conversation was restored.").waitFor();
  await page.locator("#refreshConversationButton").click();
  await page.waitForFunction(() => document.getElementById("refreshConversationButton")?.disabled === false);
  await page.getByText("The authoritative conversation was restored.").waitFor();
  assert.equal(navigations, initialNavigations);
  await page.close();
});

test("keeps official Goals isolated across conversation branches and browser reloads", { timeout: 40_000 }, async () => {
  let page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row").filter({ hasText: "Browser recovery smoke test" }).filter({ hasNotText: "branch" }).click();
  await page.waitForFunction(() => document.getElementById("threadTitleInput")?.value === "Browser recovery smoke test");
  await page.locator("#goalBar").waitFor({ state: "visible" });

  await page.locator("#goalOpenButton").click();
  const desktopGoalDrawer = await page.locator("#goalDialog").boundingBox();
  assert.ok(desktopGoalDrawer && desktopGoalDrawer.width <= 382);
  assert.ok(Math.abs(desktopGoalDrawer.x + desktopGoalDrawer.width - 1280) <= 2);
  await page.screenshot({ path: path.join(screenshots, "goal-drawer-1280.png"), fullPage: true });
  await page.locator("#goalCollapseButton").click();
  await page.locator("#goalDialog").waitFor({ state: "hidden" });
  await page.locator("#goalOpenButton").click();
  assert.equal(await page.locator("#goalUnlimitedRetryInput").isChecked(), false);
  await page.locator(".goal-retry-setting .toggle-control").click();
  await page.waitForFunction(() => document.getElementById("goalUnlimitedRetryInput")?.checked === true);
  await page.locator(".toast", { hasText: "已开启连接异常持续重试" }).waitFor();
  assert.match(await page.locator("#goalRetryState").innerText(), /15 秒.*15 分钟/);
  const enabledRetrySettings = await page.evaluate(async () => (
    fetch("/api/codex/goal/retry-settings", { cache: "no-store" }).then((response) => response.json())
  ));
  assert.equal(enabledRetrySettings.unlimitedRetry, true);
  assert.equal(enabledRetrySettings.retryFrequency, "balanced");
  await page.locator("#goalRetryFrequencyInput").selectOption("patient");
  await page.locator(".toast", { hasText: "Goal 重试频率已设为低频守候" }).waitFor();
  assert.match(await page.locator("#goalRetryState").innerText(), /1 分钟.*30 分钟/);
  const patientRetrySettings = await page.evaluate(async () => (
    fetch("/api/codex/goal/retry-settings", { cache: "no-store" }).then((response) => response.json())
  ));
  assert.equal(patientRetrySettings.retryFrequency, "patient");
  await page.locator("#goalRetryFrequencyInput").selectOption("balanced");
  await page.locator(".toast", { hasText: "Goal 重试频率已设为均衡" }).waitFor();
  await page.locator(".goal-retry-setting .toggle-control").click();
  await page.waitForFunction(() => document.getElementById("goalUnlimitedRetryInput")?.checked === false);
  await page.locator(".toast", { hasText: "已关闭连接异常持续重试" }).waitFor();
  assert.equal(await page.locator("#goalObjectiveField").isHidden(), true);
  assert.equal(await page.locator("#goalSaveButtonLabel").innerText(), "启用 Goal");
  await page.locator("#goalSaveButton").click();
  await page.locator("#goalObjectiveField").waitFor({ state: "visible" });
  await page.locator("#goalObjectiveInput").fill("Verify the stable release path");
  assert.equal(await page.locator("#goalObjectiveCount").innerText(), "30 / 4000 · 剩余 3970 字");
  await page.locator("#goalTokenBudgetInput").fill("50000");
  await page.locator("#goalSaveButton").click();
  await page.waitForFunction(() => (
    document.getElementById("goalOpenButton")?.getAttribute("aria-label")?.includes("Verify the stable release path")
    || document.getElementById("goalFormError")?.textContent.trim()
  ));
  assert.equal((await page.locator("#goalFormError").textContent()).trim(), "");
  assert.match(await page.locator("#goalOpenButton").getAttribute("aria-label"), /进行中.*Verify the stable release path/);
  assert.match(await page.locator("#goalUsage").innerText(), /0 \/ 5 万 Token/);
  const desktopGoalButton = await page.locator("#goalOpenButton").boundingBox();
  const desktopGoalControl = await page.locator("#goalBar").boundingBox();
  const desktopModelControl = await page.locator(".intelligence-control").boundingBox();
  assert.ok(desktopGoalButton && desktopGoalButton.width <= 30 && desktopGoalButton.height <= 30);
  assert.ok(desktopGoalControl && desktopModelControl);
  assert.ok(desktopGoalControl.x < desktopModelControl.x);
  assert.ok(Math.abs(desktopGoalControl.y - desktopModelControl.y) <= 4);
  await page.screenshot({ path: path.join(screenshots, "goal-mini-button-1280.png"), fullPage: true });
  await page.locator("#backgroundTaskDrawerButton").click();
  const goalTaskCard = page.locator(".task-center-card", { hasText: "Browser recovery smoke test" });
  await goalTaskCard.waitFor();
  await goalTaskCard.getByRole("button", { name: "安全暂停" }).waitFor();
  assert.doesNotMatch(await page.locator("#taskCenterOverviewPanel").innerText(), /Verify the stable release path/);
  await page.locator("#backgroundTaskCloseButton").click();
  await page.locator("#goalRunButton").click();
  await page.waitForFunction(() => document.getElementById("goalRunButton")?.dataset.action === "resume");
  assert.equal(await page.locator("#goalRunButton span").innerText(), "继续");
  await page.locator("#goalOpenButton").click();
  await page.locator("#goalProviderCard").waitFor({ state: "visible" });
  assert.match(await page.locator("#goalProviderDetail").innerText(), /恢复前会检查/);
  await page.locator("#goalCollapseButton").click();
  await page.locator("#goalRunButton").click();
  await page.waitForFunction(() => (
    document.getElementById("goalRunButton")?.dataset.action === "pause"
    && document.getElementById("goalRunButton")?.disabled === false
  ));
  assert.equal(await page.locator("#goalRunButton span").innerText(), "暂停");

  await page.locator("#threadMoreButton").click();
  await page.locator("#forkThreadButton").click();
  await page.locator("#threadTitleInput").waitFor();
  await page.waitForFunction(() => document.getElementById("threadTitleInput")?.value.endsWith(" branch"));
  await page.locator("#goalOpenButton").waitFor();

  await page.locator("#goalOpenButton").click();
  await page.locator("#goalObjectiveInput").fill("Audit only the branch-specific Goal");
  await page.locator("#goalSaveButton").click();
  await page.waitForFunction(() => (
    document.getElementById("goalOpenButton")?.getAttribute("aria-label")?.includes("Audit only the branch-specific Goal")
  ));
  assert.equal(await page.locator("#goalStatusLabel").innerText(), "进行中");
  assert.match(await page.locator("#goalOpenButton").getAttribute("aria-label"), /进行中.*Audit only the branch-specific Goal/);
  assert.equal(await page.locator("#goalStatusValue").innerText(), "进行中");

  await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#goalBar").waitFor({ state: "visible" });
  assert.match(await page.locator("#goalOpenButton").getAttribute("aria-label"), /进行中.*Audit only the branch-specific Goal/);

  await page.locator("#panelsButton").click();
  await page.locator(".thread-row").filter({ hasText: "Browser recovery smoke test" }).filter({ hasNotText: "branch" }).click();
  await page.locator("#goalOpenButton").waitFor();
  await page.locator("#goalCloseButton").click();
  await page.locator("#goalCloseButton").waitFor({ state: "hidden" });
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test branch" }).click();
  await page.waitForFunction(() => document.getElementById("threadTitleInput")?.value.endsWith(" branch"));
  await page.locator("#goalOpenButton").waitFor();

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#goalBar").waitFor({ state: "visible" });
  await page.locator("#goalOpenButton").click();
  await page.locator("#goalClearButton").click();
  await page.locator("#goalDialog").waitFor({ state: "hidden" });
  await page.locator("#goalOpenButton").waitFor();

  await page.locator("#threadMoreButton").click();
  await page.locator("#deleteThreadButton").click();
  await page.locator("#emptyState").waitFor({ state: "visible" });
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test branch" }).waitFor({ state: "detached" });
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row").filter({ hasText: "Browser recovery smoke test" }).filter({ hasNotText: "branch" }).click();
  await page.waitForFunction(() => document.getElementById("threadTitleInput")?.value === "Browser recovery smoke test");
  await page.locator("#goalBar").waitFor({ state: "visible" });
  await page.locator("#goalOpenButton").click();
  assert.equal(await page.locator("#goalClearButton").isVisible(), true);
  assert.equal(await page.locator("#goalClearButtonLabel").innerText(), "关闭 Goal");
  await page.locator("#goalClearButton").click();
  await page.locator("#goalDialog").waitFor({ state: "hidden" });
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: path.join(screenshots, "goal-mode-1280.png"), fullPage: true });
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  mobile.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#panelsButton").click();
  await mobile.locator(".thread-row").filter({ hasText: "Browser recovery smoke test" }).filter({ hasNotText: "branch" }).click();
  await mobile.locator("#goalOpenButton").click();
  const mobileGoalDrawer = await mobile.locator("#goalDialog").boundingBox();
  assert.ok(mobileGoalDrawer && mobileGoalDrawer.width <= 362 && mobileGoalDrawer.width < 390);
  assert.ok(Math.abs(mobileGoalDrawer.x + mobileGoalDrawer.width - 390) <= 2);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "goal-drawer-390.png"), fullPage: true });
  await mobile.locator("#goalCollapseButton").click();
  await mobile.locator("#goalDialog").waitFor({ state: "hidden" });
  await mobile.locator("#goalOpenButton").click();
  await mobile.locator("#goalSaveButton").click();
  await mobile.locator("#goalObjectiveField").waitFor({ state: "visible" });
  await mobile.locator("#goalObjectiveInput").fill("Verify the compact mobile Goal controls");
  await mobile.locator("#goalSaveButton").click();
  await mobile.locator("#goalRunButton").waitFor({ state: "visible" });
  for (const metric of ["cpu", "memory", "disk"]) {
    await mobile.locator(`#systemStatus .system-status-${metric}`).waitFor();
  }
  assert.equal(await mobile.locator("#goalCloseButton").isVisible(), true);
  await assertContainedBy(mobile, "#goalCloseButton", "#composer");
  for (const width of [390, 320]) {
    await mobile.setViewportSize({ width, height: 844 });
    const sendBox = await mobile.locator("#sendButton").boundingBox();
    assert.ok(sendBox && sendBox.width >= 31 && sendBox.height >= 31, JSON.stringify({ width, sendBox }));
    await assertContainedBy(mobile, "#sendButton", "#composer");
    for (const metric of ["cpu", "memory", "disk"]) {
      const selector = `#systemStatus .system-status-${metric}`;
      const metricBox = await mobile.locator(selector).boundingBox();
      assert.ok(metricBox && metricBox.width >= 20, JSON.stringify({ width, metric, metricBox }));
      await assertContainedBy(mobile, selector, ".statusbar");
    }
    await assertNoPairOverlap(mobile, ".composer-actions > *:not([hidden])");
    await assertNoHorizontalOverflow(mobile);
  }
  await mobile.locator("#goalOpenButton").click();
  await mobile.locator("#goalClearButton").click();
  await mobile.locator("#goalDialog").waitFor({ state: "hidden" });
  await mobile.close();
});

test("starts a native Codex conversation in a recoverable Worktree on desktop and mobile", { timeout: 50_000 }, async (t) => {
  const sourceReviewTarget = path.join(directory, "projects", "smoke-project", "review-target.txt");
  t.after(async () => {
    await fs.writeFile(sourceReviewTarget, "Review target before staging.\n");
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#newThreadButton").click();
  await page.locator("#threadTitleInput").waitFor();
  assert.equal(await page.locator("#threadTitleInput").inputValue(), "新对话");

  await page.locator("#intelligenceMenuButton").click();
  await page.locator("#codexWorkspaceButton").click();
  await page.locator('#codexWorkspaceInspection[data-state="ready"]').waitFor();
  assert.match(await page.locator("#codexWorkspaceInspectionTitle").innerText(), /main.*Worktrees/);
  assert.match(await page.locator("#codexWorkspaceInspectionDetail").innerText(), /本地修改/);
  await page.locator("#codexWorktreeModeInput").check();
  assert.equal(await page.locator("#codexWorktreeBaseInput").inputValue(), "main");
  assert.equal(await page.locator("#codexWorktreeChangesInput").isEnabled(), true);
  await page.locator("#codexWorktreeChangesInput").check();
  await page.screenshot({ path: path.join(screenshots, "codex-worktree-settings-1280.png"), fullPage: true });
  await page.locator("#codexWorkspaceSaveButton").click();
  await page.locator("#codexWorkspaceState", { hasText: "下个新对话 · Worktree" }).waitFor();

  await page.locator("#fileInput").setInputFiles({
    name: "worktree-attachment.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Worktree attachment fixture\n"),
  });
  await page.locator(".attachment-chip", { hasText: "worktree-attachment.txt" }).waitFor();
  await page.locator("#promptInput").fill("report monthly quota");
  const createdResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/codex/worktrees")
      && response.request().method() === "POST");
  await page.locator("#sendButton").click();
  const created = await (await createdResponse).json();
  assert.equal(created.worktree.state, "ready");
  assert.equal(created.worktree.attachments.length, 1);
  assert.ok(created.worktree.attachments[0].path.startsWith(created.worktree.worktreePath));
  assert.equal(
    await fs.readFile(created.worktree.attachments[0].path, "utf8"),
    "Worktree attachment fixture\n",
  );
  await page.locator("#gitStatus", { hasText: "Worktree" }).waitFor();
  await page.locator("#taskStatusLabel", { hasText: "已完成" }).waitFor();
  await page.waitForFunction(() => Boolean(document.querySelector("#activeSession")?.textContent.match(/[a-z0-9_-]{8}/i)));

  const listed = await page.evaluate(() => fetch("/api/codex/worktrees").then((response) => response.json()));
  const bound = listed.worktrees.find((entry) => entry.id === created.worktree.id);
  assert.ok(bound?.threadId);
  assert.equal(bound.worktreePath, created.worktree.worktreePath);
  const projectList = await page.evaluate(() => fetch("/api/projects").then((response) => response.json()));
  assert.equal(projectList.projects.some((entry) => entry.worktreeId === created.worktree.id), true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#gitStatus", { hasText: "Worktree" }).waitFor();
  await page.locator("#intelligenceMenuButton").click();
  assert.match(await page.locator("#codexWorkspaceState").innerText(), /当前对话 · Worktree/);
  await page.locator("#codexWorkspaceButton").click();
  await page.locator('#codexWorkspaceInspection[data-state="ready"]').waitFor();
  await page.locator("#codexWorktreeManager summary").click();
  await page.locator(".codex-worktree-record", { hasText: "Codex Desktop · Worktree" }).waitFor();
  assert.match(await page.locator("#codexWorktreeUsage").innerText(), /1\/15/);
  await fs.writeFile(
    path.join(created.worktree.worktreePath, "review-target.txt"),
    "Changed safely inside the Worktree.\n",
  );
  await page.keyboard.press("Escape");
  await page.locator("#threadMoreButton").click();
  page.once("dialog", (dialog) => dialog.accept());
  const localHandoffResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/codex/worktrees/${created.worktree.id}/handoff`)
      && response.request().method() === "POST");
  await page.locator("#worktreeHandoffButton").click();
  assert.equal((await localHandoffResponse).status(), 200);
  await page.locator("#gitStatus", { hasText: "Git 仓库" }).waitFor();
  assert.equal(
    await fs.readFile(sourceReviewTarget, "utf8"),
    "Changed safely inside the Worktree.\n",
  );
  await fs.writeFile(
    sourceReviewTarget,
    "Changed safely in Local.\n",
  );
  await page.locator("#threadMoreButton").click();
  page.once("dialog", (dialog) => dialog.accept());
  const worktreeHandoffResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/codex/worktrees/${created.worktree.id}/handoff`)
      && response.request().method() === "POST");
  await page.locator("#worktreeHandoffButton").click();
  assert.equal((await worktreeHandoffResponse).status(), 200);
  await page.locator("#gitStatus", { hasText: "Worktree" }).waitFor();
  assert.equal(
    await fs.readFile(path.join(created.worktree.worktreePath, "review-target.txt"), "utf8"),
    "Changed safely in Local.\n",
  );
  await page.locator("#threadMoreButton").click();
  const snapshotResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/codex/worktrees/${created.worktree.id}/snapshot`)
      && response.request().method() === "POST");
  await page.locator("#worktreeSnapshotButton").click();
  assert.equal((await snapshotResponse).status(), 200);
  await page.locator("#threadMoreButton").click();
  const branchResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/codex/worktrees/${created.worktree.id}/branch`)
      && response.request().method() === "POST");
  await page.locator("#worktreeBranchButton").click();
  await page.locator("#textInputDialogInput").fill("feature/browser-worktree");
  await page.locator("#textInputDialogSubmitButton").click();
  assert.equal((await branchResponse).status(), 200);
  await page.locator("#gitStatus", { hasText: "feature/browser-worktree" }).waitFor();
  assert.deepEqual(pageErrors, []);
  await page.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(10_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#intelligenceMenuButton").click();
  await mobile.locator("#codexWorkspaceButton").click();
  await mobile.locator('#codexWorkspaceInspection[data-state="ready"]').waitFor();
  await mobile.locator("#codexWorktreeManager summary").click();
  await mobile.locator(".codex-worktree-record").waitFor();
  await assertBoundedByViewport(mobile.locator("#intelligenceMenu"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "codex-worktree-settings-390.png"), fullPage: true });
  await mobile.close();
});

test("uses official subagent settings without synthetic collaboration prompts", { timeout: 40_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.locator("#intelligenceMenuButton").click();
  assert.equal(await page.locator("#collaborationModeButton").count(), 0);
  assert.doesNotMatch(await page.locator("#intelligenceMenu").innerText(), /手动协作/);
  await page.locator("#collaborationSettingsButton").click();
  await page.locator("#collaborationSettingsView").waitFor({ state: "visible" });
  assert.equal(
    await page.locator('#collaborationPresetInput option[value="fixture-default"]').count(),
    1,
  );
  assert.equal(await page.locator("#collaborationStrategyInput").count(), 0);
  assert.equal(await page.locator("#collaborationPromptPreview").count(), 0);
  await page.locator("#collaborationSubagentEnabledInput").check();
  await page.locator("#collaborationSubagentEffortInput").selectOption("xhigh");
  await page.locator("#collaborationThreadsInput").selectOption("6");
  await page.locator("#collaborationDepthInput").selectOption("1");
  await page.locator("#collaborationPresetInput").selectOption("");
  await page.locator("#collaborationSettingsSaveButton").click();
  await page.locator("#collaborationSettingsView").waitFor({ state: "hidden" });
  assert.match(await page.locator("#collaborationSettingsState").innerText(), /子代理已启用.*极高.*6 线程.*1 层/);
  await page.locator("#intelligenceEffortOptions .intelligence-option", { hasText: "Ultra" }).click();
  assert.equal(await page.locator("#effortSelect").inputValue(), "ultra");
  assert.equal(await page.locator("#intelligenceMenuLabel").innerText(), "Smoke Auto");
  await page.locator("#intelligenceMenuButton").click();
  await page.locator("#intelligenceEffortOptions .intelligence-option").filter({ hasText: /^High$/ }).click();
  assert.notEqual(await page.locator("#effortSelect").inputValue(), "ultra");

  await page.locator("#promptInput").fill("coordinate subagents");
  await page.locator("#sendButton").click();
  assert.equal(await page.locator(".message-collaboration-badge").count(), 0);
  assert.equal(await page.locator("#messageList").getByText(/wfl_collaboration_preference/).count(), 0);
  await page.locator(".subagent-item", { hasText: "启动子代理" }).waitFor();
  await page.locator("#taskStatusDetail", { hasText: "1 个子代理运行中" }).waitFor();
  await page.locator("#providerQuickButton").click();
  await page.locator("#providerQuickMenu").waitFor({ state: "visible" });
  assert.match(await page.locator("#providerQuickSummary").innerText(), /任务中只读|正在刷新连接与额度|当前空闲/);
  assert.equal(await page.locator("#providerQuickList .provider-quick-row").count() > 0, true);
  await page.keyboard.press("Escape");

  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Parallel subagent isolation test" }).click();
  await page.getByText("This conversation has no subagent activity.", { exact: true }).waitFor();
  assert.equal(await page.locator(".subagent-item").count(), 0);
  assert.equal(await page.locator("#taskStatusBar").isHidden(), true);

  await page.waitForTimeout(600);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.locator('.subagent-state-row[data-status="completed"]').waitFor({ state: "attached" });
  assert.equal(await page.locator('.subagent-state-row[data-status="running"]').count(), 0);
  assert.equal(await page.locator('.subagent-state-row[data-status="pendingInit"]').count(), 0);
  assert.doesNotMatch(await page.locator("#taskStatusDetail").innerText(), /子代理运行中/);
  assert.equal(await page.locator(".subagent-item").isVisible(), true);
  assert.equal(await page.locator(".subagent-details").isVisible(), true);

  const browserSnapshotKeys = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    return Object.keys(sessionStorage).filter((entry) =>
      /^codexDesktop\.threadSnapshots\.v[1-4]:/.test(entry));
  });
  assert.deepEqual(browserSnapshotKeys, []);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.subagent-state-row[data-status="completed"]').waitFor({ state: "attached" });
  await waitForCodexConnection(page);
  assert.equal(await page.locator('.subagent-state-row[data-status="running"]').count(), 0);
  assert.doesNotMatch(await page.locator("#taskStatusDetail").innerText(), /子代理运行中/);

  assert.notEqual(await page.locator("#effortSelect").inputValue(), "ultra");
  await page.locator("#promptInput").fill("coordinate activity-only subagents");
  await page.locator("#sendButton").click();
  await page.locator("#taskStatusDetail", { hasText: "2 个子代理运行中" }).waitFor();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await page.locator("#taskStatusLabel", { hasText: "已完成" }).waitFor();
  assert.doesNotMatch(await page.locator("#taskStatusDetail").innerText(), /子代理运行中/);

  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: path.join(screenshots, "subagent-activity-1280.png"), fullPage: true });

  assert.notEqual(await page.locator("#effortSelect").inputValue(), "ultra");
  await page.locator("#promptInput").fill("coordinate stuck subagents");
  await page.locator("#sendButton").click();
  await page.locator(".subagent-item", {
    hasText: "Keep running until the parent Ultra turn is explicitly interrupted.",
  }).waitFor();
  await page.locator("#stopTurnButton").waitFor({ state: "visible" });
  await page.locator("#stopTurnButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await page.locator("#taskStatusLabel", { hasText: "已终止" }).waitFor();
  assert.doesNotMatch(await page.locator("#taskStatusDetail").innerText(), /子代理运行中/);

  await page.locator("#newThreadButton").click();
  assert.equal(await page.locator("#taskStatusBar").isHidden(), true);
  assert.equal(await page.locator(".subagent-item").count(), 0);
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#panelsButton").click();
  await mobile.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await mobile.locator("#intelligenceMenuButton").click();
  await mobile.locator("#collaborationSettingsButton").click();
  await mobile.locator("#collaborationSettingsView").waitFor({ state: "visible" });
  const menuBox = await mobile.locator("#intelligenceMenu").boundingBox();
  assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, JSON.stringify(menuBox));
  await assertNoHorizontalOverflow(mobile);
  await mobile.evaluate(() => window.WFLI18n.setLanguage("en"));
  assert.equal(await mobile.locator("#collaborationSettingsBackButton span").innerText(), "Collaboration settings");
  assert.match(await mobile.locator("#collaborationSettingsState").innerText(), /Subagents.*threads.*depth/i);
  await mobile.screenshot({ path: path.join(screenshots, "collaboration-settings-390.png"), fullPage: true });
  await mobile.close();
});

test("remembers the account Codex model across windows and shows model with effort", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const first = await context.newPage();
  const pageErrors = [];
  first.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await first.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(first);
    await first.locator("#newThreadButton").click();
    await first.locator("#intelligenceMenuButton").click();
    await first.locator("#intelligenceModelButton").click();
    await first.locator("#intelligenceModelOptions .intelligence-option", { hasText: "GPT-Smoke Fast" }).click();
    assert.equal(await first.locator("#modelSelect").inputValue(), "gpt-smoke-fast");
    await first.locator("#intelligenceMenuButton").click();
    await first.locator("#intelligenceEffortOptions .intelligence-option", { hasText: "Low" }).click();
    assert.equal(await first.locator("#intelligenceMenuLabel").innerText(), "Smoke Fast Low");
    assert.equal(await first.evaluate(() => (
      Object.entries(localStorage).some(([key, value]) => (
        key.startsWith("codexDesktop.codexModel:") && value === "gpt-smoke-fast"
      ))
    )), true);

    const second = await context.newPage();
    second.on("pageerror", (error) => pageErrors.push(error.message));
    await second.setViewportSize({ width: 390, height: 844 });
    await second.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(second);
    await second.locator('#modelSelect option[value="gpt-smoke-fast"]').waitFor({ state: "attached" });
    await second.waitForFunction(() => document.getElementById("modelSelect")?.value === "gpt-smoke-fast");
    assert.equal(await second.locator("#modelSelect").inputValue(), "gpt-smoke-fast");
    assert.equal(await second.locator("#effortSelect").inputValue(), "low");
    assert.equal(await second.locator("#intelligenceMenuLabel").innerText(), "Smoke Fast Low");
    assert.equal(await second.locator("#intelligenceMenuLabel").evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    )), true);
    await assertContainedBy(second, "#intelligenceMenuButton", "#composer");
    await assertNoHorizontalOverflow(second);
    await second.close();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("shows effective official permission profiles and policy reasons on desktop and mobile", { timeout: 25_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({
      viewport,
      isMobile: viewport.width < 500,
      hasTouch: viewport.width < 500,
    });
    page.setDefaultTimeout(8_000);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#settingsButton").click();
    await page.locator("#settingsDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#settingsPermissionProfileField").isVisible(), true);
    assert.equal(
      await page.locator('#settingsPermissionProfile option[value=":workspace"]').count(),
      1,
    );
    assert.match(await page.locator("#settingsPolicySummary").innerText(), /账号边界.*管理员策略.*最终生效/s);
    await page.locator("#settingsPermissionProfile").selectOption(":workspace");
    assert.equal(await page.locator("#settingsApproval").isDisabled(), true);
    assert.equal(await page.locator("#settingsSandbox").isDisabled(), true);
    await assertBoundedByViewport(page.locator("#settingsDialog"), viewport);
    await assertNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.close();
  }
});

test("task status follows its conversation and stays hidden on a new chat", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let taskThreadId = "thread_other";
  await page.route("**/api/task/status?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "running",
      phase: "working",
      threadId: taskThreadId,
      turnId: "turn_status_smoke",
      startedAt: Date.now() - 2_000,
      updatedAt: Date.now(),
      finishedAt: null,
      observedAt: Date.now(),
    }),
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.waitForFunction(() => (
    document.querySelector("#threadTitleInput")?.value === "Browser recovery smoke test"
    && document.querySelectorAll("#messageList .message").length > 0
  ));
  assert.equal(await page.locator("#taskStatusBar").isHidden(), true);

  taskThreadId = "thread_smoke_001";
  await page.waitForTimeout(1_700);
  await page.locator("#taskStatusBar").waitFor({ state: "visible" });
  const initialTaskSeconds = Number((await page.locator("#taskStatusTime").innerText()).match(/(\d+) 秒/)?.[1]);
  await page.waitForFunction((initial) => {
    const seconds = Number(document.querySelector("#taskStatusTime")?.textContent.match(/(\d+) 秒/)?.[1]);
    return Number.isFinite(seconds) && seconds > initial;
  }, initialTaskSeconds);
  const updatedTaskSeconds = Number((await page.locator("#taskStatusTime").innerText()).match(/(\d+) 秒/)?.[1]);
  assert.ok(
    Number.isFinite(initialTaskSeconds) && updatedTaskSeconds > initialTaskSeconds,
    JSON.stringify({ initialTaskSeconds, updatedTaskSeconds }),
  );
  const statusBox = await page.locator("#taskStatusBar").boundingBox();
  const messageBox = await page.locator("#messageList").boundingBox();
  assert.ok(statusBox && statusBox.height <= 24, JSON.stringify(statusBox));
  assert.ok(messageBox && Math.abs(statusBox.x - messageBox.x) <= 1, JSON.stringify({ statusBox, messageBox }));

  await page.locator("#newThreadButton").click();
  assert.equal(await page.locator("#taskStatusBar").isHidden(), true);
  assert.equal(await page.locator("#emptyState").isVisible(), true);
  await page.close();
});

test("keeps simultaneous tasks isolated across two conversation windows", { timeout: 40_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const first = await context.newPage();
  const second = await context.newPage();
  first.setDefaultTimeout(10_000);
  second.setDefaultTimeout(10_000);
  await Promise.all([
    first.goto(baseUrl, { waitUntil: "domcontentloaded" }),
    second.goto(baseUrl, { waitUntil: "domcontentloaded" }),
  ]);
  await Promise.all([waitForCodexConnection(first), waitForCodexConnection(second)]);

  await first.bringToFront();
  await first.locator("#newThreadButton").click();
  await first.locator("#promptInput").fill("hold concurrent task");
  await first.locator("#sendButton").click();
  await first.getByText("hold concurrent task", { exact: true }).waitFor();
  await first.locator("#threadTitleInput").fill("Concurrent held task");
  await first.locator("#threadTitleInput").press("Enter");
  await first.locator("#stopTurnButton").waitFor({ state: "visible" });
  await first.locator("#taskStatusLabel", { hasText: "执行中" }).waitFor();

  await second.bringToFront();
  await second.locator("#newThreadButton").click();
  await second.locator("#promptInput").fill("finish concurrent task");
  await second.locator("#sendButton").click();
  await second.getByText("The independent concurrent task completed.", { exact: true }).waitFor();
  await second.locator("#threadTitleInput").fill("Concurrent completed task");
  await second.locator("#threadTitleInput").press("Enter");
  await second.locator("#taskStatusLabel", { hasText: "已完成" }).waitFor();

  await first.bringToFront();
  await first.locator("#taskStatusLabel", { hasText: "执行中" }).waitFor();
  assert.equal(await first.locator("#stopTurnButton").isVisible(), true);
  await first.locator("#stopTurnButton").click();
  await first.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await first.locator("#taskStatusLabel", { hasText: "已终止" }).waitFor();
  await context.close();
});

test("keeps Codex and Claude active state isolated while a background Codex turn completes", { timeout: 40_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const owner = await context.newPage();
  const controller = await context.newPage();
  owner.setDefaultTimeout(10_000);
  controller.setDefaultTimeout(10_000);
  await Promise.all([
    owner.goto(baseUrl, { waitUntil: "domcontentloaded" }),
    controller.goto(baseUrl, { waitUntil: "domcontentloaded" }),
  ]);
  await Promise.all([waitForCodexConnection(owner), waitForCodexConnection(controller)]);

  await owner.locator("#newThreadButton").click();
  await owner.locator("#promptInput").fill("hold runtime isolation task");
  await owner.locator("#sendButton").click();
  await owner.locator("#stopTurnButton").waitFor({ state: "visible" });
  await owner.locator("#threadTitleInput").fill("Runtime isolation held task");
  await owner.locator("#threadTitleInput").press("Enter");

  await owner.locator("#runtimeSwitcherButton").click();
  await owner.locator('[data-runtime="claude"]').click();
  await owner.locator("#desktop.claude-runtime").waitFor({ state: "attached" });
  await owner.locator("#panelsButton").click();
  await owner.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  await owner.getByText("Fixture work completed.", { exact: true }).waitFor();

  await controller.locator("#panelsButton").click();
  await controller.locator("#refreshThreadsButton").click();
  const heldThread = controller.locator(".thread-row", { hasText: "Runtime isolation held task" });
  await heldThread.waitFor();
  await heldThread.click();
  await controller.locator("#stopTurnButton").waitFor({ state: "visible" });
  await controller.locator("#stopTurnButton").click();
  await controller.locator("#stopTurnButton").waitFor({ state: "hidden" });

  await owner.waitForTimeout(300);
  assert.equal(await owner.locator("#desktop").getAttribute("class").then((value) => value.includes("claude-runtime")), true);
  assert.match(await owner.locator("#activeSession").innerText(), /Claude/);
  assert.equal(await owner.getByText("Fixture work completed.", { exact: true }).count(), 1);
  assert.equal(await owner.locator("#stopTurnButton").isHidden(), true);

  await owner.locator("#runtimeSwitcherButton").click();
  await owner.locator('[data-runtime="codex"]').click();
  await owner.waitForFunction(() => !document.getElementById("desktop")?.classList.contains("claude-runtime"));
  await owner.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await context.close();
});

test("asks before Codex and Claude start concurrent work in the same project", { timeout: 40_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  let otherRuntime = "claude";
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/task/center*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        observedAt: Date.now(),
        tasks: otherRuntime === "codex"
          ? [{ threadId: "other-codex-thread", cwd: defaultProject, status: "running" }]
          : [],
        backgroundTasks: [],
        claudeSessions: otherRuntime === "claude"
          ? [{ id: "other-claude-session", projectPath: defaultProject, status: "inProgress" }]
          : [],
        claudeBackgroundTasks: [],
      }),
    });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  const codexPrompt = "finish concurrent task";
  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill(codexPrompt);
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /Claude 正在同一项目/);
    await dialog.dismiss();
  });
  await page.locator("#sendButton").click();
  assert.equal(await page.locator("#promptInput").inputValue(), codexPrompt);
  assert.equal(await page.getByText(codexPrompt, { exact: true }).count(), 0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#sendButton").click();
  await page.locator(".message.user").getByText(codexPrompt, { exact: true }).waitFor();
  await page.getByText("The independent concurrent task completed.", { exact: true }).waitFor();

  otherRuntime = "codex";
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#desktop.claude-runtime").waitFor({ state: "attached" });
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  const claudePrompt = "confirm same-project Claude task";
  await page.locator("#promptInput").fill(claudePrompt);
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /Codex 正在同一项目/);
    await dialog.dismiss();
  });
  await page.locator("#sendButton").click();
  assert.equal(await page.locator("#promptInput").inputValue(), claudePrompt);
  assert.equal(await page.getByText(claudePrompt, { exact: true }).count(), 0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#sendButton").click();
  await page.locator(".message.user").getByText(claudePrompt, { exact: true }).waitFor();
  const approval = page.locator("#approvalDialog");
  await approval.waitFor({ state: "visible" });
  await approval.getByRole("button", { name: "本会话允许", exact: true }).click();
  await page.getByText("Permission handled.", { exact: true }).last().waitFor();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("steers a running Codex turn without replacing the interrupt control", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("hold account quota inspection");
  await page.locator("#sendButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "visible" });
  assert.equal(await page.locator("#sendButton").isEnabled(), true);
  assert.equal(await page.locator("#sendButton").getAttribute("title"), "追加到当前任务");
  assert.equal(await page.locator("#sendButton").getAttribute("aria-label"), "追加指令到当前任务");

  await page.locator("#promptInput").fill("steer from browser while the task is running");
  await page.locator("#sendButton").click();
  await page.getByText("steer from browser while the task is running", { exact: true }).waitFor();
  assert.equal(await page.locator("#stopTurnButton").isVisible(), true);
  await page.locator("#stopTurnButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  await page.locator("#taskStatusLabel", { hasText: "已终止" }).waitFor();
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("handles Codex MCP form, openai/form, and URL elicitation safely", { timeout: 50_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  for (const [prompt, modeLabel, nickname] of [
    ["request codex mcp form", "表单", "Ada"],
    ["request codex mcp openai form", "扩展表单", "Grace"],
  ]) {
    await page.locator("#newThreadButton").click();
    await page.locator("#promptInput").fill(prompt);
    await page.locator("#sendButton").click();
    await page.locator("#approvalDialog").waitFor({ state: "visible" });
    await page.getByText(modeLabel, { exact: true }).waitFor();
    const nicknameInput = page.locator('[data-codex-mcp-field="0"] [data-codex-mcp-input]');
    await nicknameInput.fill(nickname);
    await page.locator("#approvalActions").getByRole("button", { name: "提交" }).click();
    await page.locator("#approvalDialog").waitFor({ state: "hidden" });
    await page.getByText(`MCP ${modeLabel === "表单" ? "form" : "openai/form"} accepted for ${nickname}.`, {
      exact: true,
    }).waitFor();
  }

  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("request codex mcp url");
  await page.locator("#sendButton").click();
  await page.locator("#approvalDialog").waitFor({ state: "visible" });
  await page.getByText("网页登录", { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("#approvalDialogBody").innerText(), /client_id|https?:\/\/|\/login\/oauth/i);
  await page.locator("#approvalActions").getByRole("button", { name: "取消任务" }).click();
  await page.locator("#approvalDialog").waitFor({ state: "hidden" });
  await page.getByText("MCP url cancel.", { exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("runs a window-scoped Codex terminal on desktop and keeps mobile controls usable", { timeout: 40_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.locator("#terminalDrawerButton").click();
  await page.locator("#terminalDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(page.locator("#terminalDrawer"), { width: 1280, height: 720 });
  await page.locator("#terminalInput").fill("printf terminal-smoke");
  await page.locator("#terminalSendButton").click();
  await page.locator("#terminalOutput").getByText("terminal-smoke", { exact: false }).waitFor();
  await page.locator("#terminalOutput").getByText("进程结束，退出码 0", { exact: false }).waitFor();
  await page.locator("#terminalBackgroundDetails").locator("summary").click();
  await page.locator(".terminal-background-row", { hasText: "npm run dev" }).waitFor();
  assert.deepEqual(pageErrors, []);
  await page.locator("#terminalDrawerCloseButton").click();
  await page.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  mobile.setDefaultTimeout(12_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#terminalDrawerButton").click();
  await mobile.locator("#terminalDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#terminalDrawer"), { width: 390, height: 844 });
  await mobile.locator('[data-terminal-key="ctrl-c"]').waitFor();
  await mobile.locator('[data-terminal-key="tab"]').waitFor();
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "codex-terminal-drawer-390.png"), fullPage: true });
  await mobile.locator("#terminalDrawerCloseButton").click();
  await mobile.close();
});

test("creates durable Codex background tasks and keeps the drawer usable on mobile", { timeout: 40_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#backgroundTaskDrawerButton").click();
  await page.locator("#backgroundTaskDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(page.locator("#backgroundTaskDrawer"), { width: 1280, height: 720 });
  await page.locator("#taskCenterOverviewPanel").waitFor({ state: "visible" });
  await page.locator("#taskCenterSchedulesTab").click();
  await page.locator("#backgroundTaskBody").waitFor({ state: "visible" });
  await page.locator("#backgroundTaskNameInput").fill("Browser durable task");
  await page.locator("#backgroundTaskPromptInput").fill("Inspect the browser fixture after reconnecting.");
  await page.locator("#backgroundTaskScheduleKindInput").selectOption("once");
  const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString().slice(0, 16);
  await page.locator("#backgroundTaskOnceInput").fill(scheduledAt);
  await page.locator("#backgroundTaskRunNowInput").locator("..").click();
  await page.locator("#backgroundTaskInfiniteRetryInput").locator("..").click();
  await page.locator("#backgroundTaskRetryBackoffInput").selectOption("patient");
  await page.locator("#backgroundTaskCreateButton").click();
  const taskCard = page.locator(".background-task-card", { hasText: "Browser durable task" });
  await taskCard.waitFor();
  await taskCard.getByText("无限重试 · 耐心", { exact: false }).waitFor();
  await page.locator("#taskCenterOverviewTab").click();
  const centerCard = page.locator(".task-center-card", { hasText: "Browser durable task" });
  await centerCard.waitFor();
  await centerCard.getByText("等待计划", { exact: true }).waitFor();
  assert.doesNotMatch(
    await page.locator("#taskCenterOverviewPanel").innerText(),
    /Inspect the browser fixture after reconnecting/,
  );
  await page.locator("#taskCenterSchedulesTab").click();
  await taskCard.locator(".background-task-card-copy").click();
  await page.locator("#backgroundTaskDetail").getByText("Inspect the browser fixture after reconnecting.", {
    exact: true,
  }).waitFor();
  assert.deepEqual(pageErrors, []);
  await page.locator("#backgroundTaskCloseButton").click();
  await page.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  mobile.setDefaultTimeout(12_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#backgroundTaskDrawerButton").click();
  await mobile.locator("#backgroundTaskDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#backgroundTaskDrawer"), { width: 390, height: 844 });
  await mobile.locator("#taskCenterOverviewPanel").waitFor({ state: "visible" });
  await mobile.locator(".task-center-card", { hasText: "Browser durable task" }).waitFor();
  await mobile.screenshot({ path: path.join(screenshots, "codex-task-center-390.png"), fullPage: true });
  await mobile.locator("#taskCenterSchedulesTab").click();
  await mobile.locator("#backgroundTaskBody").waitFor({ state: "visible" });
  await mobile.locator("#backgroundTaskInfiniteRetryInput").locator("..").click();
  await mobile.locator("#backgroundTaskRetryBackoffInput").selectOption("balanced");
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "codex-background-tasks-390.png"), fullPage: true });
  const mobileTaskCard = mobile.locator(".background-task-card", { hasText: "Browser durable task" });
  await mobileTaskCard.locator(".background-task-card-copy").click();
  mobile.once("dialog", (dialog) => dialog.accept());
  await mobile.locator("#backgroundTaskDetail").getByRole("button", { name: "删除" }).click();
  await mobileTaskCard.waitFor({ state: "detached" });
  await mobile.locator("#backgroundTaskCloseButton").click();
  await mobile.close();
});

test("uses the Git drawer and starts an inline Codex review on desktop and mobile", { timeout: 45_000 }, async () => {
  await fs.writeFile(
    path.join(directory, "projects", "smoke-project", "remote-review.txt"),
    "Remote comparison changed.\napi_key=sk-browser-remote-secret-1234567890\n",
  );
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.locator("#gitDrawerButton").click();
  await page.locator("#gitDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(page.locator("#gitDrawer"), { width: 1280, height: 720 });
  await page.locator("#gitRemoteTab").click();
  await page.locator("#gitRemoteTarget", { hasText: "origin/main" }).waitFor();
  await page.locator("#gitRemoteSafetyState", { hasText: "Codex 原生比较" }).waitFor();
  const remoteTarget = page.locator(".git-remote-file", { hasText: "remote-review.txt" });
  await remoteTarget.locator("summary").click();
  await remoteTarget.getByText("已隐藏", { exact: false }).waitFor();
  assert.doesNotMatch(await remoteTarget.innerText(), /sk-browser-remote-secret/);
  await page.screenshot({ path: path.join(screenshots, "git-remote-diff-1280.png"), fullPage: true });
  await page.locator("#gitRemoteReviewButton").click();
  await page.locator("#gitDrawer").waitFor({ state: "hidden" });
  await page.getByText("Review completed for baseBranch.", { exact: true }).waitFor();

  await page.locator("#gitDrawerButton").click();
  await page.locator("#gitDrawer").waitFor({ state: "visible" });
  await page.locator("#gitChangesTab").click();
  const target = page.locator(".git-file-row", { hasText: "review-target.txt" });
  await target.click();
  await page.locator("#gitDiffTitle", { hasText: "review-target.txt" }).waitFor();
  await page.getByText("Review target before staging.", { exact: false }).waitFor();
  await page.locator("#gitFileStageButton").click();
  await page.locator(".git-change-group", { hasText: "Staged · 已暂存" })
    .locator(".git-file-row", { hasText: "review-target.txt" }).click();
  await page.locator("#gitFileUnstageButton").click();
  await page.locator(".git-change-group", { hasText: "Untracked · 未跟踪" })
    .locator(".git-file-row", { hasText: "review-target.txt" }).waitFor();

  await page.locator("#gitReviewTab").click();
  await page.locator("#gitReviewTargetInput").selectOption("uncommittedChanges");
  await page.locator("#gitReviewDeliveryInput").selectOption("inline");
  await page.locator("#gitStartReviewButton").click();
  await page.locator("#gitDrawer").waitFor({ state: "hidden" });
  await page.getByText("Review completed for uncommittedChanges.", { exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  await page.close();

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  mobile.setDefaultTimeout(10_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#gitDrawerButton").click();
  await mobile.locator("#gitDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#gitDrawer"), { width: 390, height: 844 });
  await mobile.locator("#gitRemoteTab").click();
  await mobile.locator("#gitRemoteTarget", { hasText: "origin/main" }).waitFor();
  const mobileRemoteTarget = mobile.locator(".git-remote-file", { hasText: "remote-review.txt" });
  await mobileRemoteTarget.locator("summary").click();
  await mobileRemoteTarget.getByText("已隐藏", { exact: false }).waitFor();
  assert.doesNotMatch(await mobileRemoteTarget.innerText(), /sk-browser-remote-secret/);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "git-remote-diff-390.png"), fullPage: true });
  await mobile.locator("#gitDrawerCloseButton").click();
  await mobile.close();
});

test("uses native Codex Skills and Hooks from the extension center and composer", { timeout: 45_000 }, async () => {
  await fs.writeFile(
    path.join(directory, "projects", "smoke-project", "CLAUDE.md"),
    "# Browser migration fixture\n",
    { mode: 0o600 },
  );
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  let resolveSkillStart;
  let resolveSkillSteer;
  const skillStartRpc = new Promise((resolve) => { resolveSkillStart = resolve; });
  const skillSteerRpc = new Promise((resolve) => { resolveSkillSteer = resolve; });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const message = JSON.parse(payload.toString());
        if (!message.params?.input?.some((item) => item.type === "skill")) return;
        if (message.method === "turn/start") resolveSkillStart(message);
        if (message.method === "turn/steer") resolveSkillSteer(message);
      } catch {
        // Ignore non-JSON WebSocket frames.
      }
    });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  if (!await page.locator(".thread-row.active").count()) {
    await page.locator(".thread-row").first().evaluate((button) => button.click());
    await page.locator(".thread-row.active").waitFor();
  }
  await page.locator("#codexExtensionsButton").waitFor({ state: "visible" });
  await page.locator("#codexExtensionsButton").click();
  await page.locator("#codexExtensionDialog").waitFor({ state: "visible" });
  await page.locator(".codex-extension-card", { hasText: "Release Check" }).waitFor();
  assert.match(await page.locator("#codexSkillErrors").innerText(), /broken-skill/);
  assert.equal(await page.locator("#codexSkillsCount").innerText(), "1");

  const skillCard = page.locator(".codex-extension-card", { hasText: "Release Check" });
  await skillCard.locator(".codex-skill-toggle").click();
  await skillCard.locator(".codex-skill-toggle", { hasText: "启用" }).waitFor();
  await skillCard.locator(".codex-skill-toggle").click();
  await skillCard.locator(".codex-skill-toggle", { hasText: "停用" }).waitFor();

  await page.locator("#codexHooksTab").click();
  assert.equal(await page.locator("#codexHooksCount").innerText(), "2");
  await page.locator(".codex-extension-card", { hasText: "project-release-check" }).waitFor();
  assert.match(await page.locator("#codexHookWarnings").innerText(), /active account permissions/);

  await page.locator("#codexMcpTab").click();
  assert.equal(await page.locator("#codexMcpCount").innerText(), "1");
  const fixtureMcp = page.locator(".codex-mcp-card", { hasText: "fixture-mcp" });
  await fixtureMcp.waitFor();
  assert.doesNotMatch(await page.locator("#codexMcpPanel").innerText(), /fixture-secret-never-expose/);
  await fixtureMcp.getByRole("button", { name: "检查" }).click();
  await page.locator("#codexMcpInspector").waitFor({ state: "visible" });
  await page.locator("#codexMcpReadResourceButton").click();
  await page.locator("#codexMcpResourceOutput", { hasText: "Fixture MCP resource content" }).waitFor();
  await page.locator("#codexMcpToolArgumentsInput").fill('{"text":"browser MCP echo"}');
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#codexMcpCallToolButton").click();
  await page.locator("#codexMcpToolOutput", { hasText: "browser MCP echo" }).waitFor();
  await page.locator("#codexMcpInspectorCloseButton").click();

  await page.locator("#codexMcpAddButton").click();
  await page.locator("#codexMcpNameInput").fill("browser-stdio");
  await page.locator("#codexMcpTransportInput").selectOption("stdio");
  await page.locator("#codexMcpCommandInput").fill("node");
  await page.locator("#codexMcpArgsInput").fill("server.mjs");
  await page.locator("#codexMcpEnvInput").fill("PRIVATE_TOKEN=browser-secret-never-expose");
  await page.locator("#codexMcpSaveButton").click();
  const stdioMcp = page.locator(".codex-mcp-card", { hasText: "browser-stdio" });
  await stdioMcp.waitFor();
  assert.doesNotMatch(await page.locator("#codexMcpPanel").innerText(), /browser-secret-never-expose/);
  page.once("dialog", (dialog) => dialog.accept());
  await stdioMcp.getByRole("button", { name: "删除" }).click();
  await stdioMcp.waitFor({ state: "detached" });

  await page.locator("#codexMigrationTab").click();
  await page.locator("#codexMigrationDetectButton").click();
  await page.locator(".codex-migration-item", { hasText: "项目指令" }).waitFor();
  assert.doesNotMatch(await page.locator("#codexMigrationPanel").innerText(), /\.jsonl|private memory content/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#codexMigrationImportButton").click();
  await page.locator(".codex-migration-history-card", { hasText: "迁移完成" }).waitFor();
  assert.equal(await page.locator("#codexMigrationSnapshotCount").innerText(), "1 份");

  await page.locator("#codexPluginsTab").click();
  await page.locator("#codexPluginGateStatus", { hasText: "可管理" }).waitFor();
  const linearPlugin = page.locator(".codex-plugin-card", { hasText: "linear@openai-curated" });
  await linearPlugin.waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await linearPlugin.getByRole("button", { name: "安装" }).click();
  await page.locator("#codexPluginInstalledList .codex-plugin-card", { hasText: "linear@openai-curated" }).waitFor();
  assert.match(await page.locator("#codexPluginsPanel").innerText(), /OpenAI 官方与管理员配置市场/);

  await assertBoundedByViewport(page.locator("#codexExtensionDialog"), { width: 1280, height: 760 });
  await page.screenshot({ path: path.join(screenshots, "codex-extensions-1280.png"), fullPage: true });
  await page.locator("#codexExtensionCloseButton").click();

  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("$rel");
  await page.locator("#codexSkillMenu").waitFor({ state: "visible" });
  await page.locator("#promptInput").press("Tab");
  await page.locator(".skill-chip", { hasText: "$release-check" }).waitFor();
  await page.locator("#promptInput").fill("hold account quota inspection");
  await page.locator("#sendButton").click();
  const startedWithSkill = await skillStartRpc;
  assert.deepEqual(
    startedWithSkill.params.input.find((item) => item.type === "skill"),
    {
      type: "skill",
      name: "release-check",
      path: path.join(directory, "projects", "smoke-project", ".codex", "skills", "release-check", "SKILL.md"),
    },
  );
  await page.locator("#stopTurnButton").waitFor({ state: "visible" });

  await page.locator("#promptInput").fill("$release");
  await page.locator("#codexSkillMenu").waitFor({ state: "visible" });
  await page.locator("#promptInput").press("Enter");
  await page.locator("#promptInput").fill("include the selected Skill in this running task");
  await page.locator("#sendButton").click();
  const steeredWithSkill = await skillSteerRpc;
  assert.equal(steeredWithSkill.params.input.some((item) => item.type === "skill" && item.name === "release-check"), true);
  await page.getByText("include the selected Skill in this running task", { exact: true }).waitFor();

  await page.locator("#codexExtensionsButton").click();
  await page.locator("#codexHooksTab").click();
  await page.locator(".codex-hook-run", { hasText: "userPromptSubmit" }).waitFor();
  assert.match(await page.locator("#codexHookRunList").innerText(), /completed|Prompt passed/);
  await page.locator("#codexExtensionCloseButton").click();
  await page.locator("#stopTurnButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(10_000);
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#codexExtensionsButton").click();
  await mobile.locator("#codexExtensionDialog").waitFor({ state: "visible" });
  await mobile.locator(".codex-extension-card", { hasText: "Release Check" }).waitFor();
  await mobile.locator("#codexMcpTab").click();
  await mobile.locator(".codex-mcp-card", { hasText: "fixture-mcp" }).waitFor();
  await mobile.locator("#codexMigrationTab").click();
  await mobile.locator(".codex-migration-history-card", { hasText: "迁移完成" }).waitFor();
  await mobile.locator("#codexPluginsTab").click();
  await mobile.locator("#codexPluginGateStatus", { hasText: "可管理" }).waitFor();
  await mobile.locator("#codexPluginInstalledList .codex-plugin-card", { hasText: "linear@openai-curated" }).waitFor();
  await assertBoundedByViewport(mobile.locator("#codexExtensionDialog"), { width: 390, height: 844 });
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "codex-extensions-390.png"), fullPage: true });
  await mobile.locator("#codexExtensionCloseButton").click();
  await mobile.locator("#promptInput").fill("$rel");
  await mobile.locator("#codexSkillMenu").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#codexSkillMenu"), { width: 390, height: 844 });
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator("#promptInput").press("Escape");
  assert.deepEqual(pageErrors, []);
  await mobile.close();
  await page.close();
});

test("connects and configures stable Codex Apps without exposing installation URLs", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#codexExtensionsButton").click();
  await page.locator("#codexExtensionDialog").waitFor({ state: "visible" });
  await page.locator("#codexAppsTab").click();
  assert.equal(await page.locator("#codexAppsCount").innerText(), "1");
  const installedSiteApp = page.locator("#codexInstalledAppsList .codex-app-card", { hasText: "Fixture Sites" });
  await installedSiteApp.waitFor();
  await page.locator("#codexCatalogAppsList .codex-app-card", { hasText: "Fixture Sites" }).waitFor();
  assert.doesNotMatch(await page.locator("#codexAppsPanel").innerText(), /chatgpt\.com\/apps|installUrl/i);
  assert.equal(await page.locator("#codexAppsPanel a").count(), 0);

  await installedSiteApp.getByRole("button", { name: "设置" }).click();
  await page.locator("#codexAppApprovalInput").selectOption("writes");
  await page.locator("#codexAppReviewerInput").selectOption("user");
  await page.locator("#codexAppSaveButton").click();
  await page.locator("#codexAppEditor").waitFor({ state: "hidden" });

  await page.locator("#codexAppsLoadMoreButton").click();
  const catalogBoxApp = page.locator("#codexCatalogAppsList .codex-app-card", { hasText: "Fixture Box" });
  await catalogBoxApp.waitFor();
  await page.locator("#codexAppsSearchInput").fill("fixture box");
  assert.equal(await page.locator("#codexCatalogAppsList .codex-app-card").count(), 1);
  await page.locator("#codexAppsSearchInput").fill("");
  await catalogBoxApp.getByRole("button", { name: "连接" }).click();
  await page.locator("#officialBrowserDialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#officialBrowserTitle").innerText(), /Fixture Box/);
  assert.equal(await page.locator("#officialBrowserCompleteButton").isVisible(), true);
  assert.doesNotMatch(await page.locator("#officialBrowserDialog").innerText(), /\/apps\/fixture\/box/);
  await page.locator("#officialBrowserCancelButton").click();
  await page.locator("#officialBrowserDialog").waitFor({ state: "hidden" });
  await page.locator("#codexExtensionCloseButton").click();

  await page.locator("#promptInput").fill("$fixture");
  await page.locator("#codexSkillMenu").waitFor({ state: "visible" });
  await page.locator("#codexSkillMenu .codex-skill-option", { hasText: "Fixture Sites" }).click();
  await page.locator(".attachment-chip.app-chip", { hasText: "$Fixture Sites" }).waitFor();
  await page.locator(".attachment-chip.app-chip button").click();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(10_000);
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#codexExtensionsButton").click();
  await mobile.locator("#codexExtensionDialog").waitFor({ state: "visible" });
  await mobile.locator("#codexAppsTab").click();
  const mobileSiteApp = mobile.locator("#codexInstalledAppsList .codex-app-card", { hasText: "Fixture Sites" });
  await mobileSiteApp.waitFor();
  await mobileSiteApp.getByRole("button", { name: "设置" }).click();
  await mobile.locator("#codexAppEditor").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#codexAppEditor"), { width: 390, height: 844 });
  await mobile.locator("#codexAppEditorCancelButton").click();
  await assertBoundedByViewport(mobile.locator("#codexExtensionDialog"), { width: 390, height: 844 });
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator("#codexExtensionCloseButton").click();
  await mobile.locator("#promptInput").fill("$fixture");
  await mobile.locator("#codexSkillMenu").waitFor({ state: "visible" });
  await mobile.locator("#codexSkillMenu .codex-skill-option", { hasText: "Fixture Sites" }).click();
  await mobile.locator(".attachment-chip.app-chip", { hasText: "$Fixture Sites" }).waitFor();
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator(".attachment-chip.app-chip button").click();

  assert.deepEqual(pageErrors, []);
  await mobile.close();
  await page.close();
});

test("routes an approval to only the window that started the turn", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const owner = await context.newPage();
  const observer = await context.newPage();
  owner.setDefaultTimeout(10_000);
  observer.setDefaultTimeout(10_000);
  await Promise.all([
    owner.goto(baseUrl, { waitUntil: "domcontentloaded" }),
    observer.goto(baseUrl, { waitUntil: "domcontentloaded" }),
  ]);
  await Promise.all([waitForCodexConnection(owner), waitForCodexConnection(observer)]);
  for (const page of [owner, observer]) {
    await page.locator("#panelsButton").click();
    await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  }

  await owner.bringToFront();
  await owner.locator("#promptInput").fill("request window approval");
  await owner.locator("#sendButton").click();
  await owner.locator("#approvalDialog").waitFor({ state: "visible" });
  await owner.locator("#approvalDialog", { hasText: "printf approval-window-test" }).waitFor();
  await owner.locator("#approvalDialog", { hasText: "callback_smoke_" }).waitFor();
  assert.equal(
    await owner.getByRole("button", { name: "本会话允许", exact: true }).count(),
    0,
  );
  await observer.waitForTimeout(300);
  assert.equal(await observer.locator("#approvalDialog").isVisible(), false);
  assert.equal(await observer.locator("#approvalBar").isVisible(), false);

  await owner.getByRole("button", { name: "本次允许", exact: true }).click();
  await owner.getByText("The approval was handled by its conversation window.", { exact: true }).waitFor();
  await observer.bringToFront();
  assert.equal(await observer.locator("#approvalDialog").isVisible(), false);
  assert.equal(await observer.locator("#approvalBar").isVisible(), false);
  await context.close();
});

test("isolated game browser renders canvas and module assets on desktop and mobile", { timeout: 40_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({
      viewport,
      isMobile: viewport.width < 600,
      hasTouch: viewport.width < 600,
    });
    page.setDefaultTimeout(8_000);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    const pageErrors = [];
    const previewFailures = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if ((response.url().includes("/preview/") || response.url().includes("/game/")) && response.status() >= 400) {
        previewFailures.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#browserButton").click();
    const dialog = page.locator("#browserDialog");
    await dialog.waitFor({ state: "visible" });
    await assertBoundedByViewport(dialog, viewport);
    await page.locator("#browserPromptButton").click();
    await page.locator(".toast", { hasText: "项目预览提示词已复制" }).waitFor();
    const copiedPrompt = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copiedPrompt, /内置“项目浏览器”/);
    assert.match(copiedPrompt, /\[打开预览\]\(game\/index\.html\)/);
    assert.doesNotMatch(copiedPrompt, /wflai\.chat/i);
    await page.frameLocator("#browserFrame").locator('body[data-preview-ready="true"]').waitFor();
    assert.equal(await page.locator("#browserEntryInput").inputValue(), "game/index.html");
    assert.equal(await page.locator("#browserEntryDetails").evaluate((details) => details.open), false);
    await page.locator("#browserEntryDetails > summary").click();
    const specifiedPreview = page.waitForResponse(
      (response) => response.url().endsWith("/api/preview/session") && response.request().method() === "POST",
    );
    await page.locator("#browserEntryInput").fill("./game/index.html");
    await page.locator("#browserEntryOpenButton").click();
    assert.equal((await specifiedPreview).status(), 201);
    assert.equal(await page.locator("#browserEntryInput").inputValue(), "game/index.html");
    assert.equal(
      await page.locator("#browserFrame").getAttribute("sandbox"),
      "allow-scripts allow-pointer-lock allow-downloads",
    );
    const pixels = await page.frameLocator("#browserFrame").locator("#game").evaluate((canvas) => {
      const context = canvas.getContext("2d");
      return {
        red: [...context.getImageData(8, 8, 1, 1).data],
        green: [...context.getImageData(40, 40, 1, 1).data],
      };
    });
    assert.deepEqual(pixels.red, [239, 68, 68, 255]);
    assert.deepEqual(pixels.green, [34, 197, 94, 255]);

    const refreshedModule = page.waitForResponse(
      (response) => response.url().endsWith("/game/game.mjs") && response.status() === 200,
    );
    await page.locator("#browserRefreshButton").click();
    await refreshedModule;
    await page.frameLocator("#browserFrame").locator('body[data-preview-ready="true"]').waitFor();

    if (viewport.width >= 600) {
      const popupPromise = page.waitForEvent("popup");
      await page.locator("#browserOpenButton").click();
      const popup = await popupPromise;
      await popup.locator('body[data-preview-ready="true"]').waitFor();
      assert.equal(await popup.locator("#game").count(), 1);
      await popup.close();
    }

    await assertNoHorizontalOverflow(page);
    assert.deepEqual(previewFailures, []);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: path.join(screenshots, `game-preview-${viewport.width}.png`),
      fullPage: true,
    });
    await page.locator("#browserCloseButton").click();
    await page.waitForFunction(() => document.getElementById("browserFrame")?.getAttribute("src") === "about:blank");
    assert.equal(await page.locator("#browserFrame").getAttribute("src"), "about:blank");
    await page.close();
  }
});

test("assistant project file references open in the browser or resource explorer", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  assert.equal(await page.locator(".message-file-link", { hasText: "gpt-5.3-codex" }).count(), 0);

  const gameLink = page.getByRole("button", { name: "the game", exact: true });
  await loadEarlierTurnsUntil(page, gameLink);
  await gameLink.click();
  await page.locator("#browserDialog").waitFor({ state: "visible" });
  await page.frameLocator("#browserFrame").locator('body[data-preview-ready="true"]').waitFor();
  await page.locator("#browserCloseButton").click();

  await page.locator(".message-file-link", { hasText: "game/game.mjs:1" }).click();
  await page.locator("#resourceDialog").waitFor({ state: "visible" });
  await page.locator("#resourcePreviewText").getByText(/previewReady/).waitFor();
  assert.match(await page.locator("#resourcePreviewName").innerText(), /game\/game\.mjs:1$/);
  await assertNoHorizontalOverflow(page);
  await page.close();
});

test("new conversations send their first message before refreshing the thread list", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("materialize before listing");
  await page.locator("#sendButton").click();
  await page.getByText("materialize before listing", { exact: true }).waitFor();
  assert.equal(await page.getByText("materialize before listing", { exact: true }).count(), 1);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "New test conversation" }).first().waitFor();
  assert.equal(await page.locator(".toast.error", { hasText: "not materialized" }).count(), 0);
  await context.close();
});

test("loads older conversation list pages instead of dropping history", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Older paginated conversation" }).waitFor();
  assert.equal(await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).count(), 1);
  await page.close();
});

test("searches native conversation text and references fuzzy-matched project files", { timeout: 35_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  await page.locator("#panelsButton").click();
  await page.locator("#threadSearch").fill("Recovered conversation");
  const matchedThread = page.locator(".thread-row", { hasText: "Browser recovery smoke test" });
  await matchedThread.waitFor();
  await matchedThread.click();
  const authoritativeMessage = page.getByText("The authoritative conversation was restored.", { exact: true });
  await loadEarlierTurnsUntil(page, authoritativeMessage);

  await page.locator("#conversationSearchButton").click();
  await page.locator("#conversationSearchInput").fill("Historical response 1");
  await page.locator("#conversationSearchForm").getByRole("button", { name: "搜索" }).click();
  await page.locator(".search-result-row", { hasText: "Historical response 1" }).first().click();
  await page.locator("#conversationSearchDialog").waitFor({ state: "hidden" });
  await page.locator("#resourceDialog").waitFor({ state: "visible" });
  await page.locator("#resourcePreviewText").getByText("Historical response 1", { exact: true }).waitFor();
  assert.equal(await page.locator("#resourcePreviewText mark").innerText(), "Historical response 1");
  assert.match(await page.locator("#resourceEditState").innerText(), /只读.*不写入聊天/);
  assert.equal(await page.locator("#messageList").getByText("Historical response 1", { exact: true }).count(), 0);
  await page.getByText("The authoritative conversation was restored.", { exact: true }).waitFor();
  await page.locator("#resourceCloseButton").click();

  await page.locator("#conversationSearchButton").click();
  await page.locator("#conversationSearchInput").fill("authoritative conversation");
  await page.locator("#conversationSearchForm").getByRole("button", { name: "搜索" }).click();
  const occurrence = page.locator(".search-result-row", { hasText: "authoritative conversation" }).first();
  await occurrence.waitFor();
  assert.equal(await occurrence.locator("mark").innerText(), "authoritative conversation");
  await occurrence.click();
  await page.locator("#conversationSearchDialog").waitFor({ state: "hidden" });
  await page.locator("#resourceDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#resourcePreviewText mark").innerText(), "authoritative conversation");
  assert.match(await page.locator("#resourcePreviewText").innerText(), /The authoritative conversation was restored\./);
  assert.equal(await page.locator("#messageList").getByText("The authoritative conversation was restored.", { exact: true }).count(), 1);
  await page.locator("#resourceCloseButton").click();

  await page.locator("#fileSearchButton").click();
  await page.locator("#fileSearchInput").fill("game.mjs");
  const fileResult = page.locator(".file-search-result", { hasText: "game.mjs" }).first();
  await fileResult.waitFor();
  await fileResult.click();
  await page.locator("#fileSearchDialog").waitFor({ state: "hidden" });
  await page.locator(".attachment-chip", { hasText: "game.mjs" }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#fileSearchButton").click();
  await page.locator("#fileSearchDialog").waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, "#fileSearchDialog");
  await page.locator("#fileSearchCloseButton").click();
  await page.close();
});

test("copies complete Codex and Claude records plus individual messages", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();

  await page.locator("#threadMoreButton").click();
  await page.locator("#copyConversationButton").click();
  await page.locator(".toast", { hasText: "聊天记录已复制" }).waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Browser recovery smoke test|Codex/);
  await page.locator("#threadMoreButton").click();
  const copyableMessage = page.locator(".message").filter({ has: page.locator(".message-copy-button:not([disabled])") }).last();
  await copyableMessage.scrollIntoViewIfNeeded();
  await copyableMessage.hover();
  await copyableMessage.locator(".message-copy-button").click();
  await page.locator(".toast", { hasText: "消息已复制" }).waitFor();
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).length > 0);

  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#desktop.claude-runtime").waitFor({ state: "attached" });
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  await page.waitForFunction(() => document.getElementById("activeSession")?.textContent.includes("33333333 · Claude"));
  await page.locator("#threadMoreButton").click();
  await page.locator("#copyConversationButton").click();
  await page.waitForFunction(async () => {
    const copied = await navigator.clipboard.readText();
    return /Claude session ID|Fixture work completed/.test(copied);
  });
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Claude session ID|Fixture work completed/);
  await page.close();
});

test("creates a Codex branch before a historical user message and restores its draft", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  const sourceThread = page.locator(".thread-row").filter({
    has: page.locator(".thread-row-title", { hasText: /^Browser recovery smoke test$/ }),
  }).first();
  await sourceThread.click();
  const sourceMessage = page.locator(".message.user", { hasText: "Can this conversation be restored?" }).filter({
    has: page.locator(".message-branch-button:not([disabled])"),
  }).first();
  await loadEarlierTurnsUntil(page, sourceMessage);
  const sourceText = (await sourceMessage.locator(".message-text").textContent())?.trim() || "";
  assert.ok(sourceText.length > 0);
  await page.waitForFunction(() => {
    const message = [...document.querySelectorAll(".message.user")]
      .find((entry) => entry.textContent.includes("Can this conversation be restored?"));
    const button = message?.querySelector(".message-branch-button:not([disabled])");
    if (!button) return false;
    button.click();
    return true;
  });
  await page.locator(".toast", { hasText: "已创建对话分支" }).waitFor();
  assert.equal((await page.locator("#promptInput").inputValue()).trim(), sourceText);
  await page.locator("#threadMoreButton").click();
  await page.locator("#deleteThreadButton").click();
  await page.locator("#emptyState").waitFor({ state: "visible" });
  await page.close();
});

test("stops a turn after five consecutive retryable API failures", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  const retryNotifications = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message.type === "codex/notification" && message.payload?.method === "error") {
        retryNotifications.push(message.payload.params);
      }
    } catch {
      // Only Codex retry notifications are useful to this diagnostic.
    }
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.locator("#goalOpenButton").click();
  await page.locator("#goalSaveButton").click();
  await page.locator("#goalObjectiveInput").fill("Preserve this Goal while the API is offline");
  await page.locator("#goalSaveButton").click();
  await page.locator("#goalDialog").waitFor({ state: "hidden" });
  await page.locator("#promptInput").fill("retry invalid api five times");
  await page.locator("#sendButton").click();
  await page.locator(".toast.error", { hasText: /API 连续失败 5 次.*当前任务已暂停/ }).waitFor().catch(async (error) => {
    throw new Error(`${error.message}; notifications=${JSON.stringify(retryNotifications)}; toasts=${JSON.stringify(await page.locator("#toastRegion").innerText())}`);
  });
  await page.waitForFunction(async () => {
    const response = await fetch(`/api/task/status?_=${Date.now()}`, { cache: "no-store" });
    return response.ok && (await response.json()).status === "interrupted";
  });
  await page.waitForTimeout(500);
  assert.ok(await page.locator(".toast.error", { hasText: "Configured API is unavailable" }).count() <= 5);
  assert.doesNotMatch(await page.locator("#turnStatus").innerText(), /正在处理|正在重试/);
  await page.waitForFunction(async () => {
    const response = await fetch(`/api/codex/goal/retry-settings?_=${Date.now()}`, { cache: "no-store" });
    const settings = response.ok ? await response.json() : null;
    return settings?.waiting?.some((record) => record.threadId === "thread_smoke_001");
  });
  await page.locator("#goalStatusLabel", { hasText: "已暂停" }).waitFor();
  await page.locator("#goalOpenButton").click();
  await page.locator("#goalRecoveryCard").waitFor({ state: "visible" });
  assert.match(await page.locator("#goalRecoveryError").innerText(), /Configured API is unavailable/);
  assert.equal(await page.locator("#goalRecoveryProviderButton").isVisible(), true);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#panelsButton").click();
  await mobile.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await mobile.locator("#goalOpenButton").click();
  await mobile.locator("#goalRecoveryCard").waitFor({ state: "visible" });
  assert.match(await mobile.locator("#goalRecoveryError").innerText(), /Configured API is unavailable/);
  assert.equal(await mobile.locator("#goalRetryNowButton span").innerText(), "立即重试");
  assert.equal(await mobile.locator("#goalRetryNowButton").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  ), true);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "goal-recovery-390.png"), fullPage: true });
  await mobile.close();
  await page.locator("#goalRetryNowButton").click();
  await page.locator(".toast", { hasText: "已发起 Goal 连接检查" }).waitFor();
  await page.locator("#goalCollapseButton").click();
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.locator("#goalCloseButton").click();
  await page.locator("#goalCloseButton").waitFor({ state: "hidden" });
  await page.close();
});

test("imports an exported Markdown conversation and opens it immediately", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#threadMoreButton").click();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator("#importThreadButton").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "browser-import.md",
    mimeType: "text/markdown",
    buffer: Buffer.from([
      "# Browser imported conversation",
      "",
      "Thread ID: ignored-browser-source",
      "",
      "## 用户",
      "",
      "Browser imported question",
      "",
      "## Codex",
      "",
      "Browser imported answer",
      "",
    ].join("\n")),
  });
  await page.locator("#threadTitleInput").waitFor();
  await page.waitForFunction(() => document.querySelector("#threadTitleInput")?.value === "Browser imported conversation");
  assert.equal(await page.locator("#threadTitleInput").inputValue(), "Browser imported conversation");
  await page.locator("#messageList").getByText("Browser imported question", { exact: true }).waitFor();
  await page.locator("#messageList").getByText("Browser imported answer", { exact: true }).waitFor();
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser imported conversation" }).waitFor();
  assert.equal(await page.locator(".toast.error").count(), 0);
  await page.close();
});

test("desktop confirms an interrupted send without duplicating it", { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class TestWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__testSocket = this;
      }
    };
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();

  await page.locator("#promptInput").fill("disconnect exactly once");
  await page.locator("#sendButton").click();
  await page.waitForFunction(async () => {
    const response = await fetch(`/api/task/status?_=${Date.now()}`, { cache: "no-store" });
    return response.ok && (await response.json()).status === "running";
  });
  await page.evaluate(() => new Promise((resolve) => {
    const socket = window.__testSocket;
    if (!socket || socket.readyState >= WebSocket.CLOSING) {
      resolve();
      return;
    }
    socket.addEventListener("close", resolve, { once: true });
    socket.close();
  }));
  await page.waitForTimeout(1800);
  assert.equal(await page.locator("#promptInput").inputValue(), "");

  await waitForCodexConnection(page);
  await page.getByText("disconnect exactly once", { exact: true }).waitFor();
  assert.equal(await page.getByText("disconnect exactly once", { exact: true }).count(), 1);
  assert.equal(await page.locator("#promptInput").inputValue(), "");
  await context.close();
});

test("reload discards optimistic cached messages and stale busy state", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.waitForFunction(() => (
    document.querySelector("#threadTitleInput")?.value === "Browser recovery smoke test"
    && document.querySelectorAll("#messageList .message").length > 0
  ));
  await page.waitForFunction(() => {
    const send = document.getElementById("sendButton");
    const status = document.getElementById("turnStatus")?.textContent || "";
    return !send?.disabled && !/正在处理|正在确认发送/.test(status);
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.getByText("提交推送部署", { exact: true }).count(), 0);
  await waitForCodexConnection(page);
  await page.waitForFunction(() => {
    const send = document.getElementById("sendButton");
    const status = document.getElementById("turnStatus")?.textContent || "";
    return !send?.disabled && !/正在处理|正在确认发送/.test(status);
  });
  assert.doesNotMatch(await page.locator("#turnStatus").innerText(), /正在处理|正在确认发送/);

  await page.close();
});

test("composer pastes clipboard images without intercepting text paste", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  const textPasteAllowed = await page.locator("#promptInput").evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "plain clipboard text");
    return input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  assert.equal(textPasteAllowed, true);

  const upload = page.waitForResponse(
    (response) => response.url().includes("/api/uploads?") && response.request().method() === "POST",
  );
  const imagePasteAllowed = await page.locator("#promptInput").evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])],
      "image.png",
      { type: "image/png" },
    ));
    return input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  assert.equal(imagePasteAllowed, false);
  assert.equal((await upload).status(), 201);
  await page.locator(".attachment-chip").waitFor();
  assert.match(await page.locator(".attachment-chip span").innerText(), /^clipboard-\d{14}\.png$/);
  assert.equal(await page.locator("#promptInput").inputValue(), "");
  await page.locator(".attachment-chip button").click();
  assert.equal(await page.locator(".attachment-chip").count(), 0);
  await page.close();
});

test("official account image generation uses Codex imagegen without calling the image provider API", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  let providerCalls = 0;
  const officialRouting = (routing = {}) => ({
    ...routing,
    targets: [{
      key: "official:browser-account",
      kind: "official",
      id: "browser-account",
      accountId: "browser-account",
      label: "Browser official account",
      active: true,
      eligible: true,
      credentialStatus: "valid",
    }],
  });
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.imageApi = { configured: false };
    data.routing = officialRouting(data.routing);
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/providers/failover?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: officialRouting(data) });
  });
  await page.route("**/api/images/generate", async (route) => {
    providerCalls += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"unexpected API image call"}' });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.waitForFunction(() => document.getElementById("imageGenerationButton")?.title.includes("Codex 原生生图"));
  await page.locator("#imageGenerationButton").click();
  await page.locator("#promptInput").fill("a small blue robot on a white background");
  await page.locator("#sendButton").click();

  await page.getByText("$imagegen a small blue robot on a white background", { exact: true }).waitFor();
  const generated = page.locator(".generated-image");
  await generated.waitFor();
  assert.equal(await generated.locator("figcaption").innerText(), "a small blue robot on a white background");
  assert.match(await generated.locator("img").getAttribute("src"), /^data:image\/png;base64,/);
  assert.equal(providerCalls, 0);
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
});

test("provider image generation keeps its prompt, status, and navigation bound to the originating conversation", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const generatedImagePath = path.join(defaultProject, "generated-images", "generated-browser.png");
  await fs.mkdir(path.dirname(generatedImagePath), { recursive: true });
  await fs.copyFile(path.join(defaultProject, "fixture-view.png"), generatedImagePath);
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.imageApi = {
      configured: true,
      providerId: data.profiles[0]?.id || null,
      providerName: "Browser image provider",
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "auto",
    };
    data.routing = {
      ...(data.routing || {}),
      targets: [{
        key: "managed:browser-image-provider",
        kind: "managed",
        id: data.profiles[0]?.id || "browser-image-provider",
        label: "Browser image provider",
        active: true,
        eligible: true,
        credentialStatus: "configured",
      }],
    };
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/images/generate", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        attachment: {
          name: "generated-browser.png",
          path: generatedImagePath,
          relativePath: "generated-images/generated-browser.png",
          mediaType: "image/png",
          previewUrl: "/api/uploads/preview?test=image",
        },
      }),
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.waitForFunction(() => (
    document.querySelector("#threadTitleInput")?.value === "Browser recovery smoke test"
    && document.querySelectorAll("#messageList .message").length > 0
  ));
  await page.locator("#newThreadButton").click();
  await page.waitForFunction(() => (
    document.querySelector("#threadTitleInput")?.value === "新对话"
    && document.querySelectorAll("#messageList .message").length === 0
  ));
  const prompt = "调用图片 API 供应商生成一张白底黄色香蕉图片";
  await page.locator("#promptInput").fill(prompt);
  const generationStarted = page.waitForRequest((request) => request.url().endsWith("/api/images/generate"));
  await page.locator("#sendButton").click();
  await generationStarted;

  assert.equal(await page.locator("#promptInput").inputValue(), "");
  assert.equal(await page.locator("#promptInput").isDisabled(), true);
  await page.locator("#taskStatusBar").waitFor({ state: "visible" });
  assert.equal(await page.locator("#taskStatusLabel").innerText(), "执行中");
  assert.equal(await page.locator("#taskStatusDetail").innerText(), "生成图片");
  assert.equal(await page.locator("#taskStatusTime").isVisible(), true);
  assert.match(await page.locator("#taskStatusTime").innerText(), /已运行 \d+ 秒/);
  await assertContainedBy(page, "#taskStatusBar", "#messageStage");
  await assertNoHorizontalOverflow(page);
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 400 });
  await page.locator("#newThreadButton").click();
  await page.locator(".toast.error", { hasText: "图片正在生成" }).waitFor();
  assert.equal(await page.getByText(prompt, { exact: true }).count(), 1);

  await page.locator("#promptInput").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("promptInput")?.disabled);
  await page.waitForFunction(() => document.querySelector("#threadTitleInput")?.value === "New test conversation");
  assert.deepEqual(
    (await page.locator(".toast.error").allInnerTexts()).filter((text) => text !== "图片正在生成，完成后再新建对话"),
    [],
  );
  assert.deepEqual(pageErrors, []);
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
});

test("project archive import dialog stays usable on desktop and mobile", { timeout: 30_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(8_000);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#projectSwitcher").click();
    await page.locator("#importProjectButton").click();
    const dialog = page.locator("#projectImportDialog");
    await dialog.waitFor({ state: "visible" });
    assert.equal(await page.locator("#projectArchiveInput").getAttribute("accept"), ".tar.gz,application/gzip,application/x-gzip");
    await assertBoundedByViewport(dialog, viewport);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `project-import-${viewport.width}.png`), fullPage: true });
    await dialog.locator('[value="cancel"]').first().click();
    await page.close();
  }
});

test("resource explorer edits and persists project code on desktop and mobile", { timeout: 40_000 }, async () => {
  const cssPath = path.join(directory, "projects", "smoke-project", "game", "game.css");
  const markdownPath = path.join(directory, "projects", "smoke-project", "game", "RESOURCE_PREVIEW.md");
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const original = "html,body{margin:0;background:#17212a}\n";
    const updated = `${original}/* edited at ${viewport.width}px */\n`;
    await fs.writeFile(cssPath, original);
    await fs.writeFile(markdownPath, "# Resource Preview\n\n- safe markdown\n");
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);

    await page.locator("#projectSwitcher").click();
    await page.locator("#resourceButton").click();
    const dialog = page.locator("#resourceDialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator(".resource-row", { hasText: "game" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#resourcePath button").length === 2);
    assert.equal(await page.locator("#resourcePath button").count(), 2);
    assert.equal(await page.locator("#resourcePath button").last().innerText(), "game");
    assert.equal(await page.locator("#resourceCurrentDirectory").innerText(), "game");
    assert.equal(await page.locator("#resourceDownloadDirectoryButton").isEnabled(), true);
    await page.locator(".resource-row", { hasText: "RESOURCE_PREVIEW.md" }).click();
    await page.locator("#resourcePreviewMarkdown").getByRole("heading", { name: "Resource Preview" }).waitFor();
    await page.locator("#resourcePreviewModeButton").click();
    await page.locator("#resourcePreviewText").getByText("# Resource Preview", { exact: false }).waitFor();
    await page.locator("#resourcePreviewModeButton").click();

    if (viewport.width >= 600) {
      await page.locator("#resourceNewFileButton").click();
      await page.locator("#resourceActionDialog").waitFor({ state: "visible" });
      await page.locator("#resourceActionName").fill("ui-created.txt");
      const created = page.waitForResponse((response) => (
        response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/files/action"
      ));
      await page.locator("#resourceActionSubmitButton").click();
      assert.equal((await created).status(), 201);
      await page.locator(".resource-row", { hasText: "ui-created.txt" }).waitFor();
    }

    await page.locator(".resource-row", { hasText: "game.css" }).click();
    await page.locator("#resourcePreviewText").getByText(/background:#17212a/).waitFor();
    await page.locator("#resourceEditButton").click();
    await page.locator("#resourceEditor").fill(updated);
    await page.locator("#resourceEditState").getByText("未保存", { exact: true }).waitFor();

    const saved = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/files/write"
    ));
    await page.locator("#resourceSaveButton").click();
    assert.equal((await saved).status(), 200);
    await page.locator("#resourceEditState").getByText("已保存", { exact: true }).waitFor();
    assert.equal(await fs.readFile(cssPath, "utf8"), updated);
    await assertContainedBy(page, "#resourceEditor", ".resource-preview");

    if (viewport.width >= 600) {
      await page.waitForTimeout(1_600);
      await page.locator("#resourceEditor").fill(`${updated}/* local unsaved */\n`);
      await fs.writeFile(cssPath, `${updated}/* external change */\n`);
      await page.locator("#resourceExternalNotice").waitFor({ state: "visible" });
      await page.locator("#resourceEditState").getByText("外部已修改", { exact: true }).waitFor();
      await page.locator("#resourceExternalRefreshButton").click();
      await page.locator("#resourcePreviewText").getByText(/external change/).waitFor();
    }
    await assertBoundedByViewport(dialog, viewport);
    await assertNoHorizontalOverflow(page);

    if (viewport.width < 600) {
      const listBox = await page.locator("#resourceList").boundingBox();
      const previewBox = await page.locator(".resource-preview").boundingBox();
      assert.ok(listBox && previewBox && listBox.y + listBox.height <= previewBox.y + 1);
    }
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(screenshots, `resource-editor-${viewport.width}.png`), fullPage: true });
    await page.locator("#resourceCloseButton").click();
    await page.close();
  }
});

test("ordinary Codex conversations send full image bytes on every turn", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  const pendingTurnCaptures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message?.type !== "rpc" || message.method !== "turn/start") return;
      pendingTurnCaptures.shift()?.(message);
    } catch {
      // Ignore non-JSON WebSocket frames.
    }
  }));
  const captureNextTurn = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for turn/start image-context frame")), 10_000);
    pendingTurnCaptures.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  const waitUntilIdle = () => page.waitForFunction(() => {
    const send = document.getElementById("sendButton");
    const status = document.getElementById("turnStatus")?.textContent || "";
    return !send?.disabled && !/正在处理|正在确认发送|正在启动/u.test(status);
  });
  const selectFixtureImage = async () => {
    const upload = page.waitForResponse(
      (response) => response.url().includes("/api/uploads?") && response.request().method() === "POST",
    );
    await page.locator("#imageFileInput").setInputFiles(path.join(defaultProject, "fixture-view.png"));
    assert.equal((await upload).status(), 201);
    await page.locator("#attachmentList .attachment-chip", { hasText: "fixture-view.png" }).waitFor();
  };

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await waitUntilIdle();
  await page.locator("#newThreadButton").click();

  await selectFixtureImage();
  await page.locator("#promptInput").fill("image context browser pass 1");
  const firstCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const first = await firstCapture;
  assert.equal(first.params.input.filter((item) => item.type === "localImage").length, 1);
  assert.doesNotMatch(JSON.stringify(first), /data:image|base64/iu);
  await waitUntilIdle();

  await selectFixtureImage();
  await page.locator("#promptInput").fill("image context browser pass 2");
  const secondCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const second = await secondCapture;
  assert.equal(second.params.input.filter((item) => item.type === "localImage").length, 1);
  const secondText = second.params.input.find((item) => item.type === "text")?.text || "";
  assert.doesNotMatch(secondText, /图片引用：|本轮未重新发送图片字节/u);
  assert.doesNotMatch(JSON.stringify(second), /data:image|base64/iu);
  await waitUntilIdle();

  await selectFixtureImage();
  assert.equal(await page.locator("#attachmentList .attachment-resend").count(), 0);
  await page.locator("#promptInput").fill("image context browser pass 3");
  const thirdCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const third = await thirdCapture;
  assert.equal(third.params.input.filter((item) => item.type === "localImage").length, 1);
  assert.doesNotMatch(JSON.stringify(third), /data:image|base64/iu);
  await waitUntilIdle();

  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("ordinary Claude conversations send full image bytes on every turn", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  const pendingTurnCaptures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message?.type !== "rpc" || message.method !== "claude/turn/start") return;
      pendingTurnCaptures.shift()?.(message);
    } catch {
      // Ignore non-JSON WebSocket frames.
    }
  }));
  const captureNextTurn = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Claude image turn")), 12_000);
    pendingTurnCaptures.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  const selectFixtureImage = async () => {
    const upload = page.waitForResponse(
      (response) => response.url().includes("/api/uploads?") && response.request().method() === "POST",
    );
    await page.locator("#imageFileInput").setInputFiles(path.join(defaultProject, "fixture-view.png"));
    assert.equal((await upload).status(), 201);
    await page.locator("#attachmentList .attachment-chip", { hasText: "fixture-view.png" }).waitFor();
  };

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  if (!await page.locator("#desktop").evaluate((element) => element.classList.contains("claude-runtime"))) {
    await page.locator("#runtimeSwitcherButton").click();
    await page.locator('[data-runtime="claude"]').click();
  }
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  for (const pass of [1, 2]) {
    await selectFixtureImage();
    assert.equal(await page.locator("#attachmentList .attachment-resend").count(), 0);
    await page.locator("#promptInput").fill(`coordinate Claude agents image pass ${pass}`);
    const capture = captureNextTurn();
    await page.locator("#sendButton").click();
    const turn = await capture;
    assert.equal(turn.params.attachments.filter((attachment) => attachment.mediaType.startsWith("image/")).length, 1);
    assert.doesNotMatch(turn.params.text, /图片引用：|本轮未重新发送图片字节/u);
    await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  }

  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("map game work mode isolates repeated images only while its bound Codex thread is active", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  const pendingTurnCaptures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message?.type !== "rpc" || message.method !== "turn/start") return;
      pendingTurnCaptures.shift()?.(message);
    } catch {
      // Ignore non-JSON WebSocket frames.
    }
  }));
  const captureNextTurn = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for game-mode turn/start frame")), 12_000);
    pendingTurnCaptures.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  const waitUntilIdle = () => page.waitForFunction(() => {
    const send = document.getElementById("sendButton");
    const status = document.getElementById("turnStatus")?.textContent || "";
    return !send?.disabled && !/正在处理|正在确认发送|正在启动/u.test(status);
  });
  const selectFixtureImage = async () => {
    const upload = page.waitForResponse(
      (response) => response.url().includes("/api/uploads?") && response.request().method() === "POST",
    );
    await page.locator("#imageFileInput").setInputFiles(path.join(defaultProject, "fixture-view.png"));
    assert.equal((await upload).status(), 201);
    await page.locator("#attachmentList .attachment-chip", { hasText: "fixture-view.png" }).waitFor();
  };

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await waitUntilIdle();
  await page.locator("#newThreadButton").click();
  await page.locator("#promptInput").fill("image context browser pass game start");
  const startCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  await startCapture;
  await waitUntilIdle();

  await page.locator("#mapWorkspaceButton:not([disabled])").click();
  const mapRow = page.locator(".map-workspace-map-row", { hasText: "maps/world.tmj" });
  await mapRow.waitFor();
  const popup = page.waitForEvent("popup");
  await mapRow.click();
  const editor = await popup;
  editor.on("pageerror", (error) => pageErrors.push(error.message));
  await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  await editor.locator("#gameWorkModeToggle:not([disabled])").waitFor();
  await editor.locator("#gameWorkModeControl").click();
  await editor.locator("#gameWorkModeState", { hasText: "已生效" }).waitFor();

  await selectFixtureImage();
  assert.equal(await page.locator("#attachmentList .attachment-resend").count(), 1);
  await page.locator("#promptInput").fill("image context browser pass game mode 1");
  const firstCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const first = await firstCapture;
  assert.equal(first.params.input.filter((item) => item.type === "localImage").length, 1);
  await waitUntilIdle();

  await selectFixtureImage();
  await page.locator("#promptInput").fill("image context browser pass game mode 2");
  const secondCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const second = await secondCapture;
  assert.equal(second.params.input.filter((item) => item.type === "localImage").length, 0);
  const secondText = second.params.input.find((item) => item.type === "text")?.text || "";
  assert.match(secondText, /图片引用：/u);
  assert.match(secondText, /本轮未重新发送图片字节/u);
  await waitUntilIdle();

  await editor.locator("#gameWorkModeControl").click();
  await editor.locator("#gameWorkModeState", { hasText: "关闭" }).waitFor();
  await selectFixtureImage();
  assert.equal(await page.locator("#attachmentList .attachment-resend").count(), 0);
  await page.locator("#promptInput").fill("image context browser pass ordinary after game mode");
  const thirdCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const third = await thirdCapture;
  assert.equal(third.params.input.filter((item) => item.type === "localImage").length, 1);
  const thirdText = third.params.input.find((item) => item.type === "text")?.text || "";
  assert.doesNotMatch(thirdText, /图片引用：|本轮未重新发送图片字节/u);
  await waitUntilIdle();

  await editor.locator("#gameWorkModeControl").click();
  await editor.locator("#gameWorkModeState", { hasText: "已生效" }).waitFor();
  await Promise.all([
    editor.waitForEvent("close"),
    editor.locator("#closeButton").click(),
  ]);
  await selectFixtureImage();
  await page.waitForFunction(() => document.querySelectorAll("#attachmentList .attachment-resend").length === 0);
  await page.locator("#promptInput").fill("image context browser pass ordinary after map close");
  const closeCapture = captureNextTurn();
  await page.locator("#sendButton").click();
  const afterClose = await closeCapture;
  assert.equal(afterClose.params.input.filter((item) => item.type === "localImage").length, 1);
  await waitUntilIdle();
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("ordinary image delivery remains full after an unknown delivery is confirmed", { timeout: 45_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const turnWaiters = [];
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class TestWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__imageContextTestSocket = this;
      }
    };
  });
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try {
      const message = JSON.parse(payload.toString());
      if (message?.type !== "rpc" || message.method !== "turn/start") return;
      for (const waiter of [...turnWaiters]) {
        if (!waiter.predicate(message)) continue;
        turnWaiters.splice(turnWaiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    } catch {
      // Ignore non-JSON WebSocket frames.
    }
  }));
  const captureTurn = (predicate) => new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    };
    const timer = setTimeout(() => {
      turnWaiters.splice(turnWaiters.indexOf(waiter), 1);
      reject(new Error("Timed out waiting for matching image-context turn/start"));
    }, 12_000);
    turnWaiters.push(waiter);
  });
  const selectFixtureImage = async () => {
    const upload = page.waitForResponse(
      (response) => response.url().includes("/api/uploads?") && response.request().method() === "POST",
    );
    await page.locator("#imageFileInput").setInputFiles(path.join(defaultProject, "fixture-view.png"));
    assert.equal((await upload).status(), 201);
    await page.locator("#attachmentList .attachment-chip", { hasText: "fixture-view.png" }).waitFor();
  };
  const textOf = (message) => message.params.input.find((item) => item.type === "text")?.text || "";

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await page.locator("#newThreadButton").click();
  await selectFixtureImage();
  await page.locator("#promptInput").fill("disconnect exactly once");
  const initialCapture = captureTurn((message) => textOf(message).includes("disconnect exactly once"));
  await page.locator("#sendButton").click();
  const initial = await initialCapture;
  assert.equal(initial.params.input.filter((item) => item.type === "localImage").length, 1);
  await page.waitForFunction(async () => {
    const response = await fetch(`/api/task/status?_=${Date.now()}`, { cache: "no-store" });
    return response.ok && (await response.json()).status === "running";
  });
  await page.evaluate(() => new Promise((resolve) => {
    const socket = window.__imageContextTestSocket;
    if (!socket || socket.readyState >= WebSocket.CLOSING) {
      resolve();
      return;
    }
    socket.addEventListener("close", resolve, { once: true });
    socket.close();
  }));
  await waitForCodexConnection(page);
  await page.waitForFunction(() => {
    const send = document.getElementById("sendButton");
    const status = document.getElementById("turnStatus")?.textContent || "";
    return !send?.disabled && !/正在处理|正在确认发送|正在启动/u.test(status);
  });

  await selectFixtureImage();
  await page.locator("#promptInput").fill("image context browser pass retry");
  const confirmedCapture = captureTurn((message) => textOf(message).includes("image context browser pass retry"));
  await page.locator("#sendButton").click();
  const confirmed = await confirmedCapture;
  assert.equal(confirmed.params.input.filter((item) => item.type === "localImage").length, 1);
  assert.doesNotMatch(textOf(confirmed), /图片引用：|本轮未重新发送图片字节/u);
  assert.doesNotMatch(JSON.stringify(confirmed), /data:image|base64/iu);
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await context.close();
});

test("visual review stays browser-local on desktop and narrow viewports", { timeout: 35_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({
      viewport,
      isMobile: viewport.width < 600,
      hasTouch: viewport.width < 600,
    });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__visualReviewAudit = { active: false, fetches: [], socketFrames: [] };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        if (window.__visualReviewAudit.active) {
          const request = input instanceof Request ? input : null;
          window.__visualReviewAudit.fetches.push({
            method: String(init.method || request?.method || "GET").toUpperCase(),
            url: String(request?.url || input || ""),
          });
        }
        return nativeFetch(input, init);
      };
      const NativeWebSocket = window.WebSocket;
      function AuditedWebSocket(...args) {
        const socket = new NativeWebSocket(...args);
        const nativeSend = socket.send.bind(socket);
        socket.send = (data) => {
          if (window.__visualReviewAudit.active) {
            window.__visualReviewAudit.socketFrames.push(String(data));
          }
          nativeSend(data);
        };
        return socket;
      }
      AuditedWebSocket.prototype = NativeWebSocket.prototype;
      for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        Object.defineProperty(AuditedWebSocket, key, { value: NativeWebSocket[key] });
      }
      window.WebSocket = AuditedWebSocket;
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#projectSwitcher").click();
    await page.locator("#resourceButton").click();
    await page.locator("#resourceDialog").waitFor({ state: "visible" });
    await page.locator(".resource-row", { hasText: "fixture-view.png" }).click();
    await page.locator("#resourcePreviewImage").waitFor({ state: "visible" });
    await page.locator("#resourceVisualReviewButton").waitFor({ state: "visible" });
    const attachmentsBefore = await page.locator("#attachmentList .attachment-chip").count();
    await page.evaluate(() => {
      window.__visualReviewAudit.active = true;
      window.__visualReviewAudit.fetches.length = 0;
      window.__visualReviewAudit.socketFrames.length = 0;
    });

    await page.locator("#resourceVisualReviewButton").click();
    const review = page.locator("#visualReviewDialog[open]");
    await review.waitFor();
    await page.waitForFunction(() => {
      const status = document.querySelector('#visualReviewDialog[open] [data-visual-review="status"]')?.textContent || "";
      const error = document.querySelector('#visualReviewDialog[open] [data-visual-review="error"]')?.textContent || "";
      return status.includes("审查完成") || error.trim().length > 0;
    });
    assert.equal(
      await review.locator('[data-visual-review="error"]').innerText(),
      "",
      await review.locator('[data-visual-review="status"]').innerText(),
    );
    assert.equal(await review.locator('[data-visual-review="dimensions"]').innerText(), "1 × 1");
    assert.equal(await review.locator('[data-visual-review="format"]').innerText(), "PNG");
    assert.match(await review.locator(".visual-review-footer").innerText(), /不会自动加入对话/);
    await assertBoundedByViewport(review, viewport);
    const reviewOverflow = await review.locator(".visual-review-shell").evaluate((shell) => ({
      clientWidth: shell.clientWidth,
      scrollWidth: shell.scrollWidth,
    }));
    assert.ok(reviewOverflow.scrollWidth <= reviewOverflow.clientWidth + 1, JSON.stringify(reviewOverflow));
    assert.equal(await page.locator("#attachmentList .attachment-chip").count(), attachmentsBefore);

    const audit = await page.evaluate(() => {
      window.__visualReviewAudit.active = false;
      return structuredClone(window.__visualReviewAudit);
    });
    const mutatingConversationFetches = audit.fetches.filter(({ method, url }) => {
      const pathname = new URL(url, baseUrl).pathname;
      return method !== "GET" && /^\/api\/(?:codex|threads?|conversations?|task)(?:\/|$)/u.test(pathname);
    });
    const conversationFrames = audit.socketFrames.flatMap((frame) => {
      try {
        const message = JSON.parse(frame);
        return /^(?:thread\/start|turn\/start|thread\/steer|turn\/steer|claude\/turn\/start)$/u.test(message?.method)
          ? [message]
          : [];
      } catch {
        return [];
      }
    });
    assert.deepEqual(mutatingConversationFetches, []);
    assert.deepEqual(conversationFrames, []);
    assert.equal(JSON.stringify(audit).includes("localImage"), false);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: path.join(screenshots, `visual-review-${viewport.width}.png`),
      fullPage: true,
    });
    await review.getByRole("button", { name: "关闭视觉审查" }).click();
    await review.waitFor({ state: "hidden" });
    await page.locator("#resourceCloseButton").click();
    await page.close();
  }
});

test("mobile keeps the top bar compact and exposes complete project drawer actions", { timeout: 40_000 }, async () => {
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);

    assert.equal(await page.locator("#providerQuickButton").isVisible(), true);
    assert.equal(await page.locator('#providerQuickSelect option[value="__add_provider__"]').innerText(), "设置供应商");
    await page.locator("#providerQuickButton").click();
    await page.locator("#providerQuickSettingsButton").click();
    await page.locator("#providerDialog").waitFor({ state: "visible" });
    await page.locator("#providerDialogTitle").getByText("API 供应商", { exact: true }).waitFor();
    await assertBoundedByViewport(page.locator("#providerDialog"), viewport);
    await page.locator("#providerCloseButton").click();
    assert.equal(await page.locator("#providerQuickRefreshButton").count(), 1);
    assert.equal(await page.locator("#providerButton").count(), 0);
    assert.equal(await page.locator("#effortSelect").isHidden(), true);
    assert.equal(await page.locator("#intelligenceMenuButton").isVisible(), true);
    await page.locator("#intelligenceMenuButton").click();
    await page.locator("#intelligenceEffortOptions .intelligence-option", { hasText: "Medium" }).click();
    assert.equal(await page.locator("#intelligenceMenuLabel").innerText(), "Smoke Medium");
    await page.locator("#newThreadButton").click();
    assert.equal(await page.locator("#taskStatusBar").isHidden(), true);
    assert.equal(await page.locator("#emptyState").isVisible(), true);
    await page.locator("#intelligenceMenuButton").click();
    await page.locator("#intelligenceMenu").waitFor({ state: "visible" });
    assert.equal(await page.locator('#intelligenceEffortOptions [aria-checked="true"]').innerText(), "Medium");
    assert.equal(await page.locator("#intelligenceModelLabel").innerText(), "GPT-Smoke");
    assert.equal(await page.locator("#collaborationModeButton").count(), 0);
    assert.equal(await page.locator("#collaborationSettingsButton").isVisible(), true);
    assert.doesNotMatch(await page.locator("#intelligenceMenu").innerText(), /手动协作/);
    await assertBoundedByViewport(page.locator("#intelligenceMenu"), viewport);
    await page.screenshot({ path: path.join(screenshots, `intelligence-menu-mobile-${viewport.width}.png`), fullPage: true });
    await page.locator("#intelligenceEffortOptions .intelligence-option", { hasText: "Ultra" }).click();
    assert.equal(await page.locator("#intelligenceMenuLabel").innerText(), "Smoke Auto");
    assert.equal(await page.locator("#effortSelect").inputValue(), "ultra");
    await page.locator("#intelligenceMenuButton").click();
    await page.locator("#intelligenceEffortOptions .intelligence-option", { hasText: "High" }).click();
    assert.equal(await page.locator("#intelligenceMenuLabel").innerText(), "Smoke High");
    await page.locator("#intelligenceMenuButton").click();
    assert.equal(await page.locator('#intelligenceEffortOptions [aria-checked="true"]').innerText(), "High");
    await page.locator("#intelligenceModelButton").click();
    assert.equal(await page.locator("#intelligenceModelView").isVisible(), true);
    assert.ok(await page.locator("#intelligenceModelOptions .intelligence-option").count() >= 1);
    await page.locator("#intelligenceMenuBackButton").click();
    await page.locator("#intelligenceMenuButton").click();
    await assertNoHorizontalOverflow(page);
    await assertNoPairOverlap(page, ".commandbar > *");

    await page.locator("#projectSwitcher").click();
    await page.waitForTimeout(220);
    const actions = page.locator(".project-pane-actions button");
    assert.equal(await actions.count(), 3);
    assert.deepEqual((await actions.allTextContents()).map((text) => text.trim()), ["上传", "下载", "新建"]);
    await assertContainedBy(page, ".project-pane-actions", "#projectPane");
    await assertNoPairOverlap(page, ".project-pane-actions button");
    for (const selector of ["#importProjectButton", "#downloadProjectButton", "#createProjectButton"]) {
      await assertContainedBy(page, selector, "#projectPane");
    }
    await assertContainedBy(page, "#resourceButton", ".project-navigation-control");
    await page.screenshot({ path: path.join(screenshots, `mobile-project-drawer-open-${viewport.width}.png`), fullPage: true });

    await page.locator("#createProjectButton").click();
    const projectDialog = page.locator("#projectDialog");
    await projectDialog.waitFor({ state: "visible" });
    await assertBoundedByViewport(projectDialog, viewport);
    await assertContainedBy(page, "#projectSubmitButton", "#projectDialog");
    await projectDialog.locator('[value="cancel"]').first().click();

    await page.locator("#resourceButton").click();
    const resourceDialog = page.locator("#resourceDialog");
    await resourceDialog.waitFor({ state: "visible" });
    await assertBoundedByViewport(resourceDialog, viewport);
    await page.locator("#resourceCloseButton").click();

    await page.locator("#accountButton").click();
    await page.locator("#accountProviderButton").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#accountProviderButton").isVisible(), true);
    await page.locator("#accountProviderButton").click();
    await page.locator("#providerDialog").waitFor({ state: "visible" });
    await assertBoundedByViewport(page.locator("#providerDialog"), viewport);
    await page.locator("#providerCloseButton").click();

    assert.deepEqual(pageErrors, []);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `mobile-project-drawer-${viewport.width}.png`), fullPage: true });
    await page.close();
  }
});

test("mobile exposes image selection and a bounded compact action menu", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  assert.equal(await page.locator("#imageFileInput").getAttribute("accept"), "image/*");

  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.waitForFunction(() => {
    const rect = document.getElementById("threadPane")?.getBoundingClientRect();
    return rect && rect.right <= 1;
  });
  const closedThreadPane = await page.locator("#threadPane").boundingBox();
  assert.ok(
    closedThreadPane && closedThreadPane.x + closedThreadPane.width <= 1,
    JSON.stringify(closedThreadPane),
  );
  await page.locator("#threadMoreButton").click();
  const menu = page.locator("#threadActionMenu");
  await menu.waitFor({ state: "visible" });
  assert.equal(await page.locator("#importThreadButton").isVisible(), true);
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox && menuBox.x >= 0 && menuBox.y >= 0);
  assert.ok(menuBox.x + menuBox.width <= 390 && menuBox.y + menuBox.height <= 844);
  await assertNoPairOverlap(page, "#threadActionMenu button");
  assert.deepEqual(pageErrors, []);
  assert.ok((await page.locator(".chat-pane").innerText()).trim().length > 40);
  await page.screenshot({ path: path.join(screenshots, "smoke-mobile.png"), fullPage: true });
  await page.close();
});

test("tablet uses one compact project or history drawer without shrinking chat", { timeout: 30_000 }, async () => {
  const viewport = { width: 1024, height: 768 };
  const page = await browser.newPage({ viewport, hasTouch: true });
  page.setDefaultTimeout(5_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  assert.equal(await page.locator("#panelsButton").isVisible(), true);
  assert.equal(await page.locator("#sidebarToggleButton").isVisible(), false);
  assert.equal(await page.locator("#providerQuickButton").isVisible(), true);
  await assertNoPairOverlap(page, ".commandbar > *");
  const chatBefore = await page.locator(".chat-pane").boundingBox();
  assert.ok(chatBefore && chatBefore.width >= viewport.width - 1);

  await page.locator("#panelsButton").click();
  await page.waitForTimeout(220);
  const threadDrawer = await page.locator("#threadPane").boundingBox();
  const projectHidden = await page.locator("#projectPane").boundingBox();
  assertCompactDrawer(threadDrawer, viewport);
  assert.ok(projectHidden && projectHidden.x + projectHidden.width <= 1);
  assert.equal(await page.locator("#panelsButton").getAttribute("aria-expanded"), "true");
  await page.screenshot({ path: path.join(screenshots, "tablet-compact-history.png"), fullPage: true });

  await page.locator("#projectSwitcher").click();
  await page.waitForTimeout(220);
  const projectDrawer = await page.locator("#projectPane").boundingBox();
  const threadHidden = await page.locator("#threadPane").boundingBox();
  assertCompactDrawer(projectDrawer, viewport);
  assert.ok(threadHidden && threadHidden.x + threadHidden.width <= 1);
  assert.equal(await page.locator("#projectSwitcher").getAttribute("aria-expanded"), "true");
  await page.screenshot({ path: path.join(screenshots, "tablet-compact-panels.png"), fullPage: true });

  await page.locator("#projectSwitcher").click();
  await page.waitForTimeout(220);
  assert.equal(await page.locator("#projectSwitcher").getAttribute("aria-expanded"), "false");
  const chatAfter = await page.locator(".chat-pane").boundingBox();
  assert.ok(chatAfter && chatAfter.width >= viewport.width - 1);
  await page.close();
});

test("desktop uses the same project or history drawer without shrinking chat", { timeout: 30_000 }, async () => {
  const viewport = { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  assert.equal(await page.locator("#panelsButton").isVisible(), true);
  assert.equal(await page.locator("#sidebarToggleButton").count(), 0);
  const chatBefore = await page.locator(".chat-pane").boundingBox();
  assert.ok(chatBefore && chatBefore.width >= viewport.width - 1);

  await page.locator("#panelsButton").click();
  await page.waitForTimeout(220);
  assertCompactDrawer(await page.locator("#threadPane").boundingBox(), viewport);
  const projectHidden = await page.locator("#projectPane").boundingBox();
  assert.ok(projectHidden && projectHidden.x + projectHidden.width <= 1);

  await page.locator("#projectSwitcher").click();
  await page.waitForTimeout(220);
  assertCompactDrawer(await page.locator("#projectPane").boundingBox(), viewport);
  const threadHidden = await page.locator("#threadPane").boundingBox();
  assert.ok(threadHidden && threadHidden.x + threadHidden.width <= 1);
  await page.screenshot({ path: path.join(screenshots, "desktop-compact-drawer.png"), fullPage: true });

  await page.locator("#mobileBackdrop").click({ position: { x: 500, y: 200 } });
  await page.waitForTimeout(220);
  assert.equal(await page.locator("#panelsButton").getAttribute("aria-expanded"), "false");
  const chatAfter = await page.locator(".chat-pane").boundingBox();
  assert.ok(chatAfter && chatAfter.width >= viewport.width - 1);
  await page.close();
});

test("desktop can persist project and history panes independently", { timeout: 30_000 }, async () => {
  const viewport = { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);

  await setPersistentPanes(page, { project: true, thread: false });
  await assertPersistentLayout(page, viewport, { project: 216, thread: 0 });
  assert.equal(await page.locator("#panelsButton").isVisible(), true);

  await setPersistentPanes(page, { project: true, thread: true });
  await assertPersistentLayout(page, viewport, { project: 300, thread: 300, stacked: true });
  assert.equal(await page.locator("#panelsButton").isVisible(), false);
  await page.screenshot({ path: path.join(screenshots, "desktop-persistent-panes.png"), fullPage: true });

  await setPersistentPanes(page, { project: false, thread: true });
  await assertPersistentLayout(page, viewport, { project: 0, thread: 272 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.waitForTimeout(350);
  await assertPersistentLayout(page, viewport, { project: 0, thread: 272 });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(220);
  const tabletChat = await page.locator(".chat-pane").boundingBox();
  const tabletThread = await page.locator("#threadPane").boundingBox();
  assert.ok(tabletChat && tabletChat.width >= 1023);
  assert.ok(tabletThread && tabletThread.x + tabletThread.width <= 1);
  assert.equal(await page.locator("#panelsButton").isVisible(), true);

  await page.setViewportSize(viewport);
  await page.waitForTimeout(350);
  await assertPersistentLayout(page, viewport, { project: 0, thread: 272 });

  await setPersistentPanes(page, { project: false, thread: false });
  const chat = await page.locator(".chat-pane").boundingBox();
  assert.ok(chat && chat.width >= viewport.width - 1);
  assert.equal(await page.locator("#panelsButton").isVisible(), true);
  await page.close();
});

test("rescue window keeps global task status inside its toolbar", { timeout: 45_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(12_000);
    const rescuePageErrors = [];
    page.on("pageerror", (error) => rescuePageErrors.push(error.message));
    let accountRequests = 0;
    await page.route("**/rescue/api/account?summary=1", (route) => {
      accountRequests += 1;
      if (accountRequests === 1) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary account lookup failure" }),
        });
      }
      return route.continue();
    });
    await page.route("**/rescue/api/ops/deployments/control", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        active: true,
        cancellable: true,
        cancellationRequested: false,
        operationId: "browser-rescue-operation",
        kind: "release",
        phase: "draining",
      }),
    }));
    await page.route("**/rescue/api/rescue/component?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        activePort: 4320,
        slots: [
          { port: 4320, active: true, version: "1.0" },
          { port: 4321, active: false, version: "1.0" },
        ],
        availableVersion: "1.1.3",
        updateAvailable: true,
        operation: null,
      }),
    }));
    await page.route("**/rescue/api/rescue/main/tasks?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        version: "0.40.5-beta",
        observedAt: Date.now(),
        tasks: [{
          id: "codex:owner:thread-browser-main",
          kind: "codex",
          userId: "owner",
          username: "owner",
          displayName: "所有者",
          threadId: "thread-browser-main",
          turnId: "turn-browser-main",
          projectPath: "/srv/browser-main",
          providerName: "官方账号",
          status: "running",
          startedAt: Date.now() - 65_000,
          interruptible: true,
        }],
      }),
    }));
    await page.goto(`${baseUrl}/rescue/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#connection span")?.textContent === "已连接");
    const historyThread = page.locator(".thread-row", { hasText: "Browser recovery smoke test" });
    await historyThread.waitFor({ state: "visible" });
    await historyThread.evaluate((node) => node.click());
    try {
      await page.waitForFunction(
        () => (
          document.querySelectorAll("#messageList .message").length > 0
          || Boolean(document.querySelector("#toastRegion")?.textContent?.trim())
        ),
        null,
        { timeout: 12_000 },
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        connection: document.querySelector("#connection")?.textContent,
        title: document.querySelector("#threadTitle")?.textContent,
        emptyHidden: document.querySelector("#emptyState")?.hidden,
        messages: document.querySelector("#messageList")?.textContent,
        messageHtml: document.querySelector("#messageList")?.innerHTML,
        toasts: document.querySelector("#toastRegion")?.textContent,
      }));
      throw new Error(`${error.message}; pageErrors=${JSON.stringify(rescuePageErrors)}; state=${JSON.stringify(diagnostic)}`);
    }
    if (await page.locator("#messageList .message").count() === 0) {
      throw new Error(`rescue thread recovery failed: ${await page.locator("#toastRegion").innerText()}`);
    }
    await assertContainedBy(page, "#composerWrap .composer", ".chat-pane");
    await assertBoundedByViewport(page.locator("#composerWrap .composer"), viewport);
    assert.equal(await page.locator("#promptInput").isVisible(), true);
    await page.locator("#deploymentRescueButton").waitFor({ state: "visible" });
    await page.locator("#rescueUpdateButton").waitFor({ state: "visible" });
    await page.locator("#mainTasksButton").waitFor({ state: "visible" });
    assert.equal(accountRequests, 1, "emergency control should not depend on retrying the account summary");
    await assertContainedBy(page, "#taskStatusBar", ".topbar");
    await assertContainedBy(page, "#deploymentRescueButton", ".topbar");
    await assertContainedBy(page, "#rescueUpdateButton", ".topbar");
    await assertContainedBy(page, "#mainTasksButton", ".topbar");
    await assertNoPairOverlap(page, ".topbar > *");
    await assertNoHorizontalOverflow(page);
    await page.locator("#deploymentRescueButton").click();
    await page.locator("#deploymentRescueDialog").waitFor({ state: "visible" });
    await assertBoundedByViewport(page.locator("#deploymentRescueDialog"), viewport);
    await page.locator("#deploymentRescueClose").click();
    await page.locator("#rescueUpdateButton").click();
    await page.locator("#rescueUpdateDialog").waitFor({ state: "visible" });
    await assertBoundedByViewport(page.locator("#rescueUpdateDialog"), viewport);
    assert.match(await page.locator("#rescueUpdateSummary").innerText(), /4320.*1\.0.*1\.1\.3/);
    await page.locator("#rescueUpdateClose").click();
    await page.locator("#mainTasksButton").click();
    await page.locator("#mainTasksDialog").waitFor({ state: "visible" });
    await assertBoundedByViewport(page.locator("#mainTasksDialog"), viewport);
    assert.match(await page.locator("#mainTasksList").innerText(), /Codex.*browser-main.*终止对话/s);
    await page.locator("#mainTasksClose").click();
    await page.locator("#snapshotNotice").evaluate((node) => {
      node.hidden = false;
      node.querySelector("time").textContent = "2026/7/25 23:59:59";
    });
    await assertContainedBy(page, "#snapshotNotice", ".chat-pane");
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: path.join(screenshots, `rescue-compact-${viewport.width}.png`),
      fullPage: true,
    });
    await page.close();
  }
});

test("operations center renders live administrator views on desktop and mobile", { timeout: 30_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#opsButton").waitFor({ state: "visible" });
    assert.equal(await page.locator("#opsButton").isVisible(), true);
    assert.match(await page.locator("#opsButton").textContent(), /管理员运维中心/);
    const opsButtonBox = await page.locator("#opsButton").boundingBox();
    assert.ok(opsButtonBox && (viewport.width < 600 ? opsButtonBox.width <= 40 : opsButtonBox.width >= 130));
    await page.locator("#accountButton").click();
    await page.locator("#accountDialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#accountPlan").innerText(), /主机所有者空间/);
    assert.equal(await page.locator("#saveAccountButton").isDisabled(), true);
    const accountViewport = await page.locator("#accountDialog").evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));
    await assertBoundedByViewport(page.locator("#accountDialog"), accountViewport);
    await assertNoHorizontalOverflow(page);
    await page.locator('#accountDialog [value="cancel"]').click();
    await page.route("**/api/ops/deployments/control?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        active: true,
        cancellable: true,
        cancellationRequested: false,
        operationId: "browser-ops-operation",
        kind: "release",
        phase: "draining",
      }),
    }));
    await page.goto(`${baseUrl}/ops`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("observedAt")?.textContent !== "--:--:--");
    assert.equal(await page.locator("#overviewView").isVisible(), true);
    assert.ok((await page.locator("#gatewayPrimary").innerText()).trim().length > 0);
    assert.ok((await page.locator("#backendPrimary").innerText()).startsWith("v"));
    assert.ok((await page.locator("#resourceChart").evaluate((canvas) => canvas.width * canvas.height)) > 0);
    assert.match(await page.locator("#healthScore").innerText(), /%$/);
    assert.ok((await page.locator("#trafficChart").evaluate((canvas) => canvas.width * canvas.height)) > 0);
    assert.match(await page.locator("#activeUserMetric").innerText(), /^(?:\d[\d,]*|Codex 未上报)$/);
    const tabLabelHeights = await page.locator(".ops-tab > span").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.ok(tabLabelHeights.every((height) => height < 24), JSON.stringify(tabLabelHeights));
    await page.screenshot({ path: path.join(screenshots, `ops-overview-${viewport.width}.png`), fullPage: true });
    await page.locator('[data-view="tasks"]').click();
    assert.equal(await page.locator("#tasksView").isVisible(), true);
    assert.equal(await page.locator("#taskRows tr").count(), 1);
    await page.locator('[data-view="map-render"]').click();
    await page.waitForFunction(() => document.getElementById("mapRenderControlStatus")?.textContent !== "读取中");
    assert.equal(await page.locator("#mapRenderView").isVisible(), true);
    assert.equal(await page.locator("[data-map-render-setting]").count(), 35);
    assert.equal(await page.locator("[data-map-render-setting]").evaluateAll((nodes) => (
      nodes.every((node) => node.type === "checkbox" || node.value !== "")
    )), true);
    assert.notEqual(await page.locator("#mapRenderPresetMetric").innerText(), "--");
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `ops-map-render-${viewport.width}.png`), fullPage: true });
    await page.route("**/api/ops/rollback?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        guard: { enabled: true, expiresAt: Date.now() + 60_000, prepared: false, targetVersion: null },
        releases: [{ version: "0.20.0", stateSchema: 1, verified: true }],
        operation: { status: "idle", phase: "idle", version: null, detail: null, startedAt: null, completedAt: null },
      }),
    }));
    await page.locator('[data-view="deployment"]').click();
    assert.match(await page.locator("#runningVersion").innerText(), /^v/);
    await page.locator("#cancelDeploymentButton").waitFor({ state: "visible" });
    await assertContainedBy(page, "#cancelDeploymentButton", ".deployment-heading");
    await assertNoPairOverlap(page, ".deployment-heading > *");
    await page.locator("#cancelDeploymentButton").click();
    await page.locator("#deploymentCancelDialog").waitFor({ state: "visible" });
    await assertBoundedByViewport(page.locator("#deploymentCancelDialog"), viewport);
    await page.locator("#deploymentCancelDialog header button").click();
    await page.locator("#deploymentCancelDialog").waitFor({ state: "hidden" });
    await page.locator("#openRollbackButton").waitFor({ state: "visible" });
    assert.equal(await page.locator("#openRollbackButton").isDisabled(), false);
    await page.locator("#openRollbackButton").click();
    await page.locator("#rollbackDialog").waitFor({ state: "visible" });
    await assertBoundedByViewport(page.locator("#rollbackDialog"), viewport);
    await page.screenshot({ path: path.join(screenshots, `ops-rollback-${viewport.width}.png`), fullPage: true });
    await page.locator("#rollbackDialog header button").click();
    await page.locator('[data-view="backups"]').click();
    assert.equal(await page.locator("#backupsView").isVisible(), true);
    assert.equal(await page.locator("#createBackupButton").isVisible(), true);
    assert.equal(await page.locator("#exportRecoveryKeyButton").isVisible(), true);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `ops-backups-${viewport.width}.png`), fullPage: true });
    await page.locator('[data-view="users"]').click();
    assert.equal(await page.locator("#totalUserMetric").innerText(), "1");
    const embeddedUsers = page.frameLocator("#userManagementFrame");
    await embeddedUsers.locator("#userList").waitFor({ state: "visible" });
    await embeddedUsers.locator("#modeLabel").evaluate((node) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const check = () => {
        if (node.textContent !== "正在读取") resolve();
        else if (Date.now() >= deadline) reject(new Error("embedded user management did not load"));
        else setTimeout(check, 50);
      };
      check();
    }));
    assert.notEqual(await embeddedUsers.locator("#modeLabel").innerText(), "正在读取");
    assert.equal(await embeddedUsers.locator(".users-titlebar").isVisible(), false);
    assert.equal(await embeddedUsers.locator("#modeButton").isVisible(), true);
    assert.equal(await embeddedUsers.locator(".management-layout").isVisible(), true);
    assert.equal(await embeddedUsers.locator("html").evaluate((root) => root.scrollWidth <= root.clientWidth + 1), true);
    await page.screenshot({ path: path.join(screenshots, `ops-users-${viewport.width}.png`), fullPage: true });
    await page.locator('[data-view="events"]').click();
    assert.equal(await page.locator("#eventsView").isVisible(), true);
    assert.equal(await page.locator("#eventSeverityFilter").isVisible(), true);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `ops-events-${viewport.width}.png`), fullPage: true });
    await page.locator('[data-view="logs"]').click();
    assert.equal(await page.locator("#logsView").isVisible(), true);
    assert.equal(await page.locator('[data-log-category="errors"]').isVisible(), true);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `ops-logs-${viewport.width}.png`), fullPage: true });
    await page.locator('[data-view="alerts"]').click();
    assert.equal(await page.locator("#alertsView").isVisible(), true);
    assert.equal(await page.locator("#alertRuleRows .alert-rule-row").count(), 5);
    const webhookUrl = page.locator("#webhookUrl");
    await webhookUrl.scrollIntoViewIfNeeded();
    assert.equal(await webhookUrl.isVisible(), true);
    assert.equal(await page.locator("#testWebhookButton").isVisible(), true);
    assert.equal(await page.locator("#removeWebhookButton").isVisible(), true);
    const saveAlertSettingsButton = page.locator("#saveAlertSettingsButton");
    await saveAlertSettingsButton.scrollIntoViewIfNeeded();
    assert.equal(await saveAlertSettingsButton.isVisible(), true);
    const alertFormBoundary = await page.evaluate(() => {
      const button = document.getElementById("saveAlertSettingsButton").getBoundingClientRect();
      const footer = document.querySelector(".ops-footer").getBoundingClientRect();
      return { buttonTop: button.top, buttonBottom: button.bottom, footerTop: footer.top };
    });
    assert.ok(alertFormBoundary.buttonTop >= 0, JSON.stringify(alertFormBoundary));
    assert.ok(alertFormBoundary.buttonBottom <= alertFormBoundary.footerTop + 1, JSON.stringify(alertFormBoundary));
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(screenshots, `ops-alerts-${viewport.width}.png`), fullPage: true });
    await page.locator('[data-view="overview"]').click();
    await page.locator('[data-metric-range="24h"]').click();
    await page.waitForFunction(() => document.querySelector('[data-metric-range="24h"]')?.classList.contains("is-active"));
    await assertNoHorizontalOverflow(page);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(screenshots, `ops-center-${viewport.width}.png`), fullPage: true });
    await page.close();
  }
});

test("workspace migration stays usable on desktop, tablet, and mobile", { timeout: 30_000 }, async () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({
      viewport,
      isMobile: viewport.width < 600,
      hasTouch: viewport.width < 600,
    });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/ops#migrations`, { waitUntil: "domcontentloaded" });
    await page.locator("#migrationProjectChoices .migration-project-option").first().waitFor();

    assert.equal(await page.locator("#migrationsTab").isVisible(), true);
    assert.equal(await page.locator("#migrationsView").isVisible(), true);
    assert.equal(await page.locator('#migrationProjectChoices input[type="checkbox"]:checked').count(), 1);
    assert.equal(await page.locator("#migrationProjectChoices .migration-project-option strong").first().textContent(), "Codex Desktop");
    assert.match(
      await page.locator("#migrationProjectChoices .migration-project-option small").first().textContent(),
      /安装目录工作区/,
    );
    assert.equal(await page.locator("#migrationIncludeGit").isChecked(), true);
    assert.equal(await page.locator("#migrationIncludeEnv").isChecked(), false);
    assert.equal(await page.locator("#createMigrationButton").isDisabled(), false);
    assert.equal(await page.locator("#migrationPackageFile").isVisible(), true);
    assert.equal(await page.locator("#uploadMigrationButton").isVisible(), true);
    assert.equal(await page.locator("#inspectMigrationButton").isDisabled(), true);

    await page.screenshot({
      path: path.join(screenshots, `ops-migrations-source-${viewport.width}.png`),
      fullPage: true,
    });
    await page.locator("#migrationPackageFile").scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(page);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: path.join(screenshots, `ops-migrations-${viewport.width}.png`),
      fullPage: true,
    });
    await page.close();
  }
});

test("workspace migration retries chunks, cancels safely, and restores resumable progress", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8_000);
  const uploads = [];
  let chunkAttempts = 0;
  let cancelMode = false;
  let releaseCancelledChunk;
  let cancelledChunkStarted;
  const cancelledChunk = new Promise((resolve) => { cancelledChunkStarted = resolve; });
  const migrationSnapshot = () => ({
    busy: false,
    operation: null,
    projects: [{
      id: "project-browser-migration",
      name: "browser-migration",
      displayName: "Browser migration",
      path: "/tmp/browser-migration",
      modifiedAt: Date.now(),
      git: false,
    }],
    exports: [],
    uploads,
    lastImport: null,
    limits: { chunkBytes: 4, packageBytes: 1024 * 1024 * 1024 },
  });
  await page.route("**/api/ops/workspace-migrations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/ops/workspace-migrations" && !url.pathname.includes("/uploads")) {
      await route.continue();
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(migrationSnapshot()) });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/uploads")) {
      const body = request.postDataJSON();
      const upload = {
        id: `wu-${String(uploads.length + 1).padStart(32, "0")}`,
        filename: body.filename,
        sizeBytes: body.sizeBytes,
        receivedBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sha256: null,
        status: "uploading",
        inspection: null,
        clientUploadId: body.clientUploadId,
        fileFingerprint: body.fileFingerprint,
      };
      uploads.unshift(upload);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ upload, chunkBytes: 4 }),
      });
      return;
    }
    if (request.method() === "PUT") {
      const upload = uploads.find((entry) => url.pathname.endsWith(entry.id));
      const offset = Number(url.searchParams.get("offset"));
      chunkAttempts += 1;
      if (!cancelMode && chunkAttempts === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary failure" }) });
        return;
      }
      if (cancelMode) {
        cancelledChunkStarted();
        await new Promise((resolve) => { releaseCancelledChunk = resolve; });
      }
      const bytes = request.postDataBuffer()?.length || 0;
      upload.receivedBytes = offset + bytes;
      upload.updatedAt = Date.now();
      if (upload.receivedBytes === upload.sizeBytes) upload.status = "complete";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ upload }) }).catch(() => {});
      return;
    }
    await route.continue();
  });

  await page.goto(`${baseUrl}/ops#migrations`, { waitUntil: "domcontentloaded" });
  await page.locator("#migrationProjectChoices .migration-project-option").waitFor();
  const firstPackage = { name: "retry.wflworkspace", mimeType: "application/octet-stream", buffer: Buffer.from("retry-upload") };
  await page.locator("#migrationPackageFile").setInputFiles(firstPackage);
  await page.waitForFunction(() => !document.getElementById("migrationUploadSummary")?.textContent.includes("正在校验"));
  await page.locator("#migrationImportPassword").fill("browser-owner-password");
  await page.locator("#uploadMigrationButton").click();
  await page.locator("#migrationUploadProgressDetail", { hasText: "100%" }).waitFor();
  await page.locator("#migrationImportStatus", { hasText: "上传完成" }).waitFor();
  assert.ok(chunkAttempts > Math.ceil(firstPackage.buffer.length / 4));

  cancelMode = true;
  const secondPackage = { name: "cancel.wflworkspace", mimeType: "application/octet-stream", buffer: Buffer.from("cancel-and-resume") };
  await page.locator("#migrationPackageFile").setInputFiles(secondPackage);
  await page.waitForFunction(() => !document.getElementById("migrationUploadSummary")?.textContent.includes("正在校验"));
  await page.locator("#migrationImportPassword").fill("browser-owner-password");
  await page.locator("#uploadMigrationButton").click();
  await cancelledChunk;
  await page.locator("#cancelMigrationUploadButton").click();
  await page.locator("#migrationImportStatus", { hasText: "上传已取消" }).waitFor();
  releaseCancelledChunk?.();
  assert.equal(await page.locator("#cancelMigrationUploadButton").isHidden(), true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#migrationUploadProgressDetail", { hasText: "等待续传" }).waitFor();
  assert.match(await page.locator("#migrationUploadSummary").innerText(), /cancel\.wflworkspace/);
  await page.close();
});

test("version center remains bounded on desktop and mobile", { timeout: 30_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(5_000);
    await page.route("**/api/release/status?*", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const now = Date.now();
      await route.fulfill({
        response,
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          release: { ...data.release, status: "completed", phase: "completed", completedAt: now },
          appUpdate: {
            status: "failed",
            phase: "failed",
            currentVersion: "0.1.0",
            targetVersion: null,
            completedAt: now - 60_000,
            error: "stale browser failure",
          },
        }),
      });
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#versionButton").click();
    const dialog = page.locator("#versionDialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#sourceVersionValue").getByText(/^v/).waitFor();
    assert.equal(await page.locator("#startReleaseButton").count(), 0);
    assert.equal(await page.locator("#syncReleaseButton").isDisabled(), true);
    assert.equal(await page.locator("#updateCodexButton").isDisabled(), true);
    assert.doesNotMatch(await page.locator("#versionState").innerText(), /stale browser failure/);
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0);
    assert.ok(box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    await assertNoPairOverlap(page, "#versionDialog .modal-footer button");
    await page.screenshot({
      path: path.join(screenshots, `version-center-${viewport.width}.png`),
      fullPage: true,
    });
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
});

test("missing optional Claude opens the version center instead of its workspace", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8_000);
  const missingComponent = {
    installed: false,
    ready: false,
    state: "not-installed",
    version: null,
    reviewedVersion: "2.1.236",
    source: null,
    installSupported: true,
    operation: { status: "idle", phase: "idle", updatedAt: Date.now() },
  };
  await page.route("**/api/account?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({ ...data, claudeComponent: missingComponent }),
    });
  });
  await page.route("**/api/release/status?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({ ...data, claudeComponent: missingComponent }),
    });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#runtimeSwitcherButton").click();
  const claudeItem = page.locator('[data-runtime="claude"]');
  await claudeItem.getByText("Claude Code · 未安装", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await claudeItem.click();
  await page.locator("#versionDialog").waitFor({ state: "visible" });
  await page.locator("#claudeComponentVersion", { hasText: "未安装" }).waitFor();
  assert.equal(await page.locator("#desktop").getAttribute("class").then((value) => value.includes("claude-runtime")), false);
  assert.equal(await page.locator("#claudeComponentVersion").textContent(), "未安装");
  assert.match(await page.locator("#claudeComponentState").textContent(), /可选安装/);
  assert.equal(await page.locator("#installClaudeButton").isEnabled(), true);
  assert.match(await page.locator("#claudeVersionCompatibilityState").textContent(), /安装 Claude Code 后可检查/);
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
});

test("Claude version center expands the reviewed compatibility snapshot", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(10_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#versionButton").click();
  await page.locator("#versionDialog").waitFor({ state: "visible" });
  await page.locator("#claudeVersionCompatibilityToggle").click();
  await page.waitForFunction(() => {
    const text = document.getElementById("claudeVersionCompatibilityState")?.textContent || "";
    return text && !text.includes("正在检查") && !text.includes("展开后检查");
  });
  assert.match(
    await page.locator("#claudeVersionCompatibilityState").textContent(),
    /匹配|异常|变化|审查/,
  );
  assert.equal(await page.locator("#claudeVersionCompatibilityDetails").isVisible(), true);
  assert.equal(await page.locator("#claudeVersionCompatibilityInstalled").textContent(), "v2.1.236");
  assert.equal(await page.locator("#claudeVersionCompatibilityCounts > div").count(), 4);
  assert.ok(await page.locator("#claudeVersionCompatibilityDeferred details").count() > 0);
  assert.equal(await page.locator("#installClaudeButton").isEnabled(), true);
  assert.match(await page.locator("#installClaudeButton").innerText(), /检查并升级/);
  await assertNoHorizontalOverflow(page);
  await page.close();
});

test("administrator edits and publishes an announcement that stays bounded on mobile", { timeout: 30_000 }, async () => {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  desktop.setDefaultTimeout(8_000);
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await desktop.locator("#accountButton").click();
  await desktop.locator("#accountAnnouncementButton").click();
  await desktop.locator("#announcementDialog").waitFor({ state: "visible" });
  await desktop.getByRole("button", { name: "确认发布", exact: true }).waitFor();
  await assertContainedBy(desktop, "#publishAnnouncementButton", "#announcementDialog");
  await desktop.locator("#announcementCategoryInput").selectOption("update");
  await desktop.locator("#announcementTitleInput").fill("Desktop release announcement");
  await desktop.locator("#announcementBodyInput").fill("The release notes are available to every signed-in user.\nNo administrator details are included.");
  await desktop.locator("#saveAnnouncementDraftButton").click();
  await desktop.locator("#announcementDraftState").getByText(/草稿保存于/).waitFor();
  assert.equal(await desktop.locator("#announcementTitle").innerText(), "暂无公告");
  await desktop.locator("#publishAnnouncementButton").click();
  await desktop.locator("#announcementTitle").getByText("Desktop release announcement", { exact: true }).waitFor();
  assert.equal(await desktop.locator("#unpublishAnnouncementButton").isVisible(), true);
  await desktop.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const dialog = mobile.locator("#announcementDialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await mobile.locator("#announcementTitle").innerText(), "Desktop release announcement");
  assert.match(await mobile.locator("#announcementBody").innerText(), /every signed-in user/);
  assert.equal(await mobile.locator("#announcementShortcutBadge").isHidden(), true);
  assert.equal(await mobile.locator("#announcementEditor").isHidden(), true);
  assert.equal(await mobile.locator("#publishAnnouncementButton").isHidden(), true);
  await assertBoundedByViewport(dialog, mobileViewport);
  await assertNoPairOverlap(mobile, "#announcementDialog .modal-footer button:not([hidden])");
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "announcement-admin-mobile.png"), fullPage: true });
  await mobile.locator('#announcementDialog .modal-header [value="cancel"]').click();
  await mobile.reload({ waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.waitForTimeout(700);
  assert.equal(await dialog.isHidden(), true);
  await mobile.locator("#accountButton").click();
  await mobile.locator("#accountAnnouncementButton").click();
  await dialog.waitFor({ state: "visible" });
  await mobile.getByRole("button", { name: "确认发布", exact: true }).waitFor();
  await assertContainedBy(mobile, "#publishAnnouncementButton", "#announcementDialog");
  mobile.once("dialog", (confirmation) => confirmation.accept());
  await mobile.locator("#unpublishAnnouncementButton").click();
  await mobile.locator("#announcementTitle").getByText("暂无公告", { exact: true }).waitFor();
  await mobile.close();
});

test("previews and explicitly uploads redacted Codex feedback on desktop and mobile", { timeout: 35_000 }, async () => {
  const desktopViewport = { width: 1280, height: 720 };
  const desktop = await browser.newPage({ viewport: desktopViewport });
  desktop.setDefaultTimeout(10_000);
  const desktopErrors = [];
  desktop.on("pageerror", (error) => desktopErrors.push(error.message));
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(desktop);
  await desktop.locator("#accountButton").click();
  await desktop.locator("#accountFeedbackButton").waitFor({ state: "visible" });
  await desktop.locator("#accountFeedbackButton").click();
  const desktopDialog = desktop.locator("#codexFeedbackDialog");
  await desktopDialog.waitFor({ state: "visible" });
  await desktop.locator("#codexFeedbackClassificationInput").selectOption("performance");
  await desktop.locator("#codexFeedbackErrorCodeInput").fill("WS 1006");
  await desktop.locator("#codexFeedbackReasonInput").fill(
    "Reconnect failed at /srv/private/browser-project with api_key=sk-browser-feedback-secret-123456.",
  );
  await desktop.locator("#codexFeedbackDiagnosticsInput").setChecked(true, { force: true });
  assert.equal(await desktop.locator("#codexFeedbackSubmitButton").isDisabled(), true);
  await desktop.locator("#codexFeedbackPreviewButton").click();
  await desktop.locator("#codexFeedbackPreview").waitFor({ state: "visible" });
  const desktopPreview = await desktop.locator("#codexFeedbackPreviewText").innerText();
  assert.match(desktopPreview, /原生日志：不上传/);
  assert.match(desktopPreview, /对话、提示词与回复：不上传/);
  assert.doesNotMatch(desktopPreview, /sk-browser-feedback-secret|\/srv\/private\/browser-project/);
  assert.equal(await desktop.locator("#codexFeedbackCopyButton").isDisabled(), false);
  assert.equal(await desktop.locator("#codexFeedbackSubmitButton").isDisabled(), true);
  await desktop.locator("#codexFeedbackConfirmInput").check();
  assert.equal(await desktop.locator("#codexFeedbackSubmitButton").isDisabled(), false);
  await assertBoundedByViewport(desktopDialog, desktopViewport);
  await desktop.locator("#codexFeedbackSubmitButton").click();
  await desktopDialog.waitFor({ state: "hidden" });
  await desktop.getByText("脱敏诊断反馈已上传", { exact: true }).waitFor();
  assert.deepEqual(desktopErrors, []);
  await desktop.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(10_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#accountButton").click();
  await mobile.locator("#accountFeedbackButton").scrollIntoViewIfNeeded();
  await mobile.locator("#accountFeedbackButton").click();
  const mobileDialog = mobile.locator("#codexFeedbackDialog");
  await mobileDialog.waitFor({ state: "visible" });
  await mobile.locator("#codexFeedbackErrorCodeInput").fill("FORCE FAILURE");
  await mobile.locator("#codexFeedbackReasonInput").fill("Mobile feedback preview remains bounded.");
  await mobile.locator("#codexFeedbackDiagnosticsInput").setChecked(true, { force: true });
  await mobile.locator("#codexFeedbackPreviewButton").click();
  await mobile.locator("#codexFeedbackPreview").waitFor({ state: "visible" });
  await mobile.locator("#codexFeedbackConfirmInput").scrollIntoViewIfNeeded();
  await mobile.locator("#codexFeedbackConfirmInput").check();
  assert.equal(await mobile.locator("#codexFeedbackSubmitButton").isDisabled(), false);
  await assertBoundedByViewport(mobileDialog, mobileViewport);
  await assertContainedBy(mobile, "#codexFeedbackCopyButton", "#codexFeedbackDialog");
  await assertContainedBy(mobile, "#codexFeedbackSubmitButton", "#codexFeedbackDialog");
  await assertNoPairOverlap(mobile, "#codexFeedbackDialog .settings-footer button");
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator("#codexFeedbackSubmitButton").click();
  await mobile.locator("#codexFeedbackResult").getByText(/上传未完成，脱敏摘要仍可复制/).waitFor();
  assert.equal(await mobileDialog.isVisible(), true);
  assert.equal(await mobile.locator("#codexFeedbackCopyButton").isDisabled(), false);
  assert.equal(await mobile.locator("#codexFeedbackSubmitButton").isDisabled(), true);
  assert.deepEqual(mobileErrors, []);
  await mobile.screenshot({ path: path.join(screenshots, "codex-feedback-390.png"), fullPage: true });
  await mobile.locator("#codexFeedbackCancelButton").click();
  await mobile.close();
});

test("official account server OAuth and reset confirmation work on desktop and mobile", { timeout: 110_000 }, async () => {
  const desktopViewport = { width: 1280, height: 720 };
  const page = await browser.newPage({ viewport: desktopViewport });
  page.setDefaultTimeout(30_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#accountButton").click();
  await page.locator("#accountProviderButton").click();
  const providerDialog = page.locator("#providerDialog");
  await providerDialog.waitFor({ state: "visible" });
  await page.locator("#editCurrentProviderButton").click();
  assert.equal(await page.locator("#providerNameInput").inputValue(), "Browser current provider");
  assert.equal(await page.locator("#providerBaseUrlInput").inputValue(), "https://browser-provider.example.test/v1");
  assert.equal(await page.locator("#providerApiKeyInput").inputValue(), "");
  await page.locator(".provider-row", { hasText: "Codex 当前配置" }).click();
  await page.locator("#officialLoginButton").click();
  const proxyDialog = page.locator("#officialProxyDialog");
  await proxyDialog.waitFor({ state: "visible" });
  await page.locator("#officialProxyModeInput").selectOption("socks5");
  await page.locator("#officialProxyLabelInput").fill("洛杉矶住宅出口");
  await page.locator("#officialProxyHostInput").fill("proxy.example.test");
  await page.locator("#officialProxyPortInput").fill("1080");
  await page.locator("#officialProxyAuthInput").check();
  await page.locator("#officialProxyUsernameInput").fill("browser-proxy-user");
  await page.locator("#officialProxyPasswordInput").fill("browser-proxy-password");
  await page.locator("#officialProxyTestButton").click();
  await page.locator("#officialProxyResult").getByText(/测试正常 · 出口 IP 8\.8\.8\.8/).waitFor();
  await assertBoundedByViewport(proxyDialog, desktopViewport);
  await page.screenshot({ path: path.join(screenshots, "official-proxy-1280.png"), fullPage: true });
  await page.locator("#officialProxySubmitButton").click();
  await proxyDialog.waitFor({ state: "hidden" });
  const browserDialog = page.locator("#officialBrowserDialog");
  await browserDialog.waitFor({ state: "visible" });
  await waitForOfficialBrowserFrame(page);
  assert.equal(await page.locator(".official-browser-input-hint").isVisible(), true);
  assert.match(await page.locator(".official-browser-input-hint").innerText(), /输入键盘/);
  assert.equal((await page.locator("#officialBrowserKeyboardButton").innerText()).trim(), "输入键盘");
  assert.equal(await page.locator("#officialBrowserHost").innerText(), "auth.openai.com");
  assert.equal(await page.locator("#officialLoginCode").isHidden(), true);
  await assertBoundedByViewport(browserDialog, desktopViewport);
  await page.screenshot({ path: path.join(screenshots, "official-server-login-1280.png"), fullPage: true });
  const physicalText = "Abc@123";
  await page.locator("#officialBrowserFrame canvas").click();
  await page.keyboard.type(physicalText);
  await page.waitForFunction((text) => document.querySelector("#officialBrowserClipboardInput")?.value === text, physicalText);
  await page.keyboard.press("Control+C");
  await page.waitForFunction((text) => navigator.clipboard.readText().then((value) => value === text), physicalText);
  await page.evaluate(() => navigator.clipboard.writeText("-clip-"));
  await page.waitForFunction(() => navigator.clipboard.readText().then((value) => value === "-clip-"));
  await page.locator("#officialBrowserFrame").press("Control+V");
  try {
    await page.waitForFunction(
      () => document.querySelector("#officialBrowserClipboardInput")?.value === "Abc@123-clip-",
      undefined,
      { timeout: 5_000 },
    );
  } catch {
    if (await page.locator("#officialBrowserClipboardInput").inputValue() !== "Abc@123-clip-") {
      await page.locator("#officialBrowserFrame").press("Control+V");
    }
    await page.waitForFunction(() => document.querySelector("#officialBrowserClipboardInput")?.value === "Abc@123-clip-");
  }
  // Clipboard operations can move focus away from the noVNC canvas while the
  // remote clipboard event is being delivered. Re-focus the actual canvas so
  // the following physical key is sent to the server browser deterministically.
  await page.locator("#officialBrowserFrame canvas").click();
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => document.querySelector("#officialBrowserClipboardInput")?.value === "Abc@123-clip");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#officialBrowserClipboardInput")?.value === "Abc@123-clip\t\n");
  await page.locator("#officialBrowserKeyboardButton").click();
  await page.waitForFunction(() => document.activeElement?.id === "officialBrowserKeyboardInput");
  let expectedRemoteText = "Abc@123-clip\t\n";
  for (const value of ["test-password", "123456", "+15551234567"]) {
    if (value === "test-password") {
      await page.locator("#officialBrowserRefreshButton").click();
    }
    await page.locator("#officialBrowserKeyboardInput").evaluate((input, text) => {
      input.value = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }, value);
    expectedRemoteText += value;
    await page.waitForFunction(
      (text) => document.querySelector("#officialBrowserClipboardInput")?.value === text,
      expectedRemoteText,
      { timeout: 20_000 },
    );
  }
  await page.locator("#officialAccountDetails").waitFor({ state: "visible" });
  await browserDialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator("#officialAccountEmail").innerText(), "browser@example.test");
  await page.locator("#officialAccountSlots").waitFor({ state: "visible" });
  await page.locator("#officialAccountSlotList").getByText(
    /洛杉矶住宅出口 · proxy\.example\.test:1080 · 出口 8\.8\.8\.8/,
  ).waitFor();
  assert.match(await page.locator("#officialAccountSlotList").innerText(), /7 天用量\s*61%/);
  assert.match(await page.locator("#officialAccountSlotList").innerText(), /洛杉矶住宅出口 · proxy\.example\.test:1080 · 出口 8\.8\.8\.8/);
  assert.equal(await page.locator(".official-account-slot-track > span").first().evaluate((element) => element.style.width), "61%");
  assert.equal(await page.locator("#officialLifetimeTokens").innerText(), "123,456");
  assert.match(await page.locator("#officialLimitList").innerText(), /主要窗口 24%/);
  assert.equal(await page.locator("#officialResetCount").innerText(), "1");
  const workspaceSection = page.locator("#officialWorkspaceSection");
  await workspaceSection.waitFor({ state: "visible" });
  assert.equal(await page.locator("#officialWorkspaceUnread").innerText(), "2 条未读");
  assert.match(await page.locator("#officialWorkspaceList").innerText(), /额度通知/);
  assert.match(await page.locator("#officialWorkspaceList").innerText(), /套餐与工作区/);
  assert.doesNotMatch(
    await page.locator("#officialWorkspaceList").innerText(),
    /sk-fixture-secret-never-show|Archived message/,
  );
  page.once("dialog", (confirmation) => confirmation.accept());
  await page.locator("#officialCreditsNudgeButton").click();
  await page.locator("#officialWorkspaceActionStatus").getByText(/官方已接受请求/).waitFor();
  assert.equal(await page.locator("#officialCreditsNudgeButton").isDisabled(), true);
  assert.match(await page.locator("#officialCreditsNudgeButton").getAttribute("title"), /分钟后重试/);
  await page.locator("#officialWorkspaceReadButton").click();
  await page.locator("#officialWorkspaceUnread").getByText("已读", { exact: true }).waitFor();
  await page.locator("#officialRefreshButton").click();
  await page.locator("#officialWorkspaceUnread").getByText("已读", { exact: true }).waitFor();
  await page.locator("#officialPrepareResetButton").click();
  const resetDialog = page.locator("#officialResetDialog");
  await resetDialog.waitFor({ state: "visible" });
  assert.equal(await page.locator("#officialResetConfirmButton").isDisabled(), true);
  await page.locator("#officialResetConfirmationInput").fill("确认");
  assert.equal(await page.locator("#officialResetConfirmButton").isDisabled(), true);
  await page.locator("#officialResetConfirmationInput").fill("确认重置");
  assert.equal(await page.locator("#officialResetConfirmButton").isDisabled(), false);
  await page.locator("#officialResetConfirmButton").click();
  await resetDialog.waitFor({ state: "hidden" });
  await page.getByText("官方速率限额已重置", { exact: true }).waitFor();
  await page.locator("#officialResetCount").getByText("0", { exact: true }).waitFor();
  await assertBoundedByViewport(providerDialog, desktopViewport);
  await page.screenshot({ path: path.join(screenshots, "official-account-1280.png"), fullPage: true });
  await page.locator('button[title="设置账号网络出口"]').first().click();
  await proxyDialog.waitFor({ state: "visible" });
  assert.equal(await page.locator("#officialProxyModeInput").inputValue(), "socks5");
  assert.equal(await page.locator("#officialProxyAuthInput").isChecked(), true);
  assert.equal(await page.locator("#officialProxyUsernameInput").inputValue(), "");
  assert.equal(await page.locator("#officialProxyPasswordInput").inputValue(), "");
  assert.match(await page.locator("#officialProxySecretHint").innerText(), /留空会保留原认证/);
  await page.locator("#officialProxyLabelInput").fill("住宅出口 A");
  await page.locator("#officialProxySubmitButton").click();
  await proxyDialog.waitFor({ state: "hidden" });
  assert.match(await page.locator("#officialAccountSlotList").innerText(), /住宅出口 A · proxy\.example\.test:1080/);
  const publicOfficialSnapshot = await page.evaluate(() =>
    fetch("/api/providers/official", { cache: "no-store" }).then((response) => response.json()));
  assert.doesNotMatch(JSON.stringify(publicOfficialSnapshot), /browser-proxy-user|browser-proxy-password/);
  await page.locator("#providerCloseButton").click();
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Browser recovery smoke test" }).click();
  await page.locator("#promptInput").fill("hold account quota inspection");
  await page.locator("#sendButton").click();
  await page.locator("#taskStatusLabel", { hasText: "执行中" }).waitFor();
  await page.locator("#accountButton").click();
  await page.locator("#accountOfficialQuotaSection").waitFor({ state: "visible" });
  assert.match(await page.locator("#accountOfficialLimitList").innerText(), /主要窗口 24%/);
  assert.equal(await page.locator("#accountOfficialSyncState").innerText(), "任务中 · 缓存");
  await assertOwnerConversationUsage(page);
  const cachedQuota = await page.evaluate(() => fetch("/api/account/official-quota?refresh=1", {
    cache: "no-store",
  }).then((response) => response.json()));
  assert.equal(cachedQuota.taskActive, true);
  assert.equal(cachedQuota.refreshDeferred, true);
  assert.equal(cachedQuota.account.email, "browser@example.test");
  assert.doesNotMatch(JSON.stringify(cachedQuota), /reset-credit-secret|login_fake_oauth/);
  await assertBoundedByViewport(page.locator("#accountDialog"), desktopViewport);
  await page.locator('#accountDialog [value="cancel"]').click();
  await page.locator("#stopTurnButton").click();
  await page.locator("#stopTurnButton").waitFor({ state: "hidden" });
  assert.deepEqual(pageErrors, []);
  await page.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(20_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#accountButton").click();
  await mobile.locator("#accountProviderButton").scrollIntoViewIfNeeded();
  await mobile.locator("#accountProviderButton").click();
  await mobile.locator("#providerDialog").waitFor({ state: "visible" });
  await mobile.locator("#officialAccountDetails").waitFor({ state: "visible" });
  await mobile.locator("#officialAccountSlots").waitFor({ state: "visible" });
  await mobile.locator("#officialWorkspaceSection").waitFor({ state: "visible" });
  assert.match(await mobile.locator("#officialWorkspaceList").innerText(), /额度通知/);
  await mobile.locator("#officialWorkspaceSection").scrollIntoViewIfNeeded();
  await assertContainedBy(mobile, ".official-workspace-actions", "#officialWorkspaceSection");
  await assertNoPairOverlap(mobile, ".official-workspace-actions button:not([hidden])");
  await mobile.screenshot({ path: path.join(screenshots, "official-workspace-messages-390.png"), fullPage: true });
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "official-account-slots-390.png"), fullPage: true });
  mobile.once("dialog", (confirmation) => confirmation.accept());
  await mobile.locator("#officialLogoutButton").click();
  await mobile.locator("#officialLoginButton").waitFor({ state: "visible" });
  await mobile.locator("#officialLoginButton").click();
  const mobileProxyDialog = mobile.locator("#officialProxyDialog");
  await mobileProxyDialog.waitFor({ state: "visible" });
  await assertBoundedByViewport(mobileProxyDialog, mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "official-proxy-390.png"), fullPage: true });
  await mobile.locator("#officialProxySubmitButton").click();
  await mobileProxyDialog.waitFor({ state: "hidden" });
  const mobileBrowserDialog = mobile.locator("#officialBrowserDialog");
  await mobileBrowserDialog.waitFor({ state: "visible" });
  await waitForOfficialBrowserFrame(mobile);
  await mobile.locator("#officialBrowserKeyboardButton").click();
  await mobile.waitForFunction(() => document.activeElement?.id === "officialBrowserKeyboardInput");
  assert.equal((await mobile.locator("#officialBrowserKeyboardButton").innerText()).trim(), "关闭键盘");
  assert.equal(await mobile.locator("#officialBrowserKeyboardTray").isVisible(), true);
  await mobile.locator("#officialBrowserKeyboardInput").fill("246810");
  await mobile.waitForFunction(() => document.querySelector("#officialBrowserClipboardInput")?.value === "246810");
  await mobile.evaluate(() => {
    document.querySelector("#officialBrowserDialog").dataset.runtime = "claude";
    document.querySelector("#officialBrowserClaudeCodeButton").hidden = false;
  });
  await assertBoundedByViewport(mobileBrowserDialog, mobileViewport);
  await assertContainedBy(mobile, ".official-browser-footer", "#officialBrowserDialog");
  await assertContainedBy(mobile, ".official-browser-input-hint", "#officialBrowserDialog");
  await assertContainedBy(mobile, "#officialBrowserClaudeCodeButton", ".official-browser-footer");
  assert.equal(await mobile.locator("#officialBrowserCancelButton").isVisible(), true);
  assert.equal(await mobile.locator("#officialBrowserKeyboardButton").isVisible(), true);
  assert.equal(await mobile.locator("#officialBrowserClaudeCodeButton").isVisible(), true);
  assert.equal((await mobile.locator("#officialBrowserClaudeCodeButton").innerText()).trim(), "读取并提交授权码");
  await assertNoPairOverlap(mobile, ".official-browser-footer > *");
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "official-server-login-390.png"), fullPage: true });
  await mobile.locator("#officialAccountDetails").waitFor({ state: "visible" });
  await mobileBrowserDialog.waitFor({ state: "hidden" });
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await mobile.locator("#providerCloseButton").click();
  await mobile.locator("#accountButton").click();
  await mobile.locator("#accountOfficialQuotaSection").waitFor({ state: "visible" });
  assert.match(await mobile.locator("#accountOfficialLimitList").innerText(), /主要窗口 24%/);
  await assertOwnerConversationUsage(mobile);
  await assertBoundedByViewport(mobile.locator("#accountDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  assert.deepEqual(mobileErrors, []);
  await mobile.screenshot({ path: path.join(screenshots, "account-official-quota-390.png"), fullPage: true });
  await mobile.locator('#accountDialog [value="cancel"]').click();
  await mobile.close();

  const compactViewport = { width: 320, height: 700 };
  const compact = await browser.newPage({ viewport: compactViewport, isMobile: true, hasTouch: true });
  compact.setDefaultTimeout(20_000);
  await compact.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(compact);
  await compact.locator("#accountButton").click();
  await compact.locator("#accountProviderButton").scrollIntoViewIfNeeded();
  await compact.locator("#accountProviderButton").click();
  await compact.locator("#officialAccountDetails").waitFor({ state: "visible" });
  compact.once("dialog", (confirmation) => confirmation.accept());
  await compact.locator("#officialLogoutButton").click();
  await compact.locator("#officialLoginButton").click();
  const compactProxyDialog = compact.locator("#officialProxyDialog");
  await compactProxyDialog.waitFor({ state: "visible" });
  await assertBoundedByViewport(compactProxyDialog, compactViewport);
  await assertNoHorizontalOverflow(compact);
  await compact.locator("#officialProxySubmitButton").click();
  await compactProxyDialog.waitFor({ state: "hidden" });
  const compactBrowserDialog = compact.locator("#officialBrowserDialog");
  await compactBrowserDialog.waitFor({ state: "visible" });
  await waitForOfficialBrowserFrame(compact);
  await compact.locator("#officialBrowserKeyboardButton").click();
  await compact.waitForFunction(() => document.activeElement?.id === "officialBrowserKeyboardInput");
  assert.equal((await compact.locator("#officialBrowserKeyboardButton").innerText()).trim(), "关闭键盘");
  await compact.evaluate(() => {
    document.querySelector("#officialBrowserDialog").dataset.runtime = "claude";
    document.querySelector("#officialBrowserClaudeCodeButton").hidden = false;
  });
  await assertBoundedByViewport(compactBrowserDialog, compactViewport);
  await assertContainedBy(compact, ".official-browser-footer", "#officialBrowserDialog");
  await assertContainedBy(compact, "#officialBrowserClaudeCodeButton", ".official-browser-footer");
  assert.equal((await compact.locator("#officialBrowserClaudeCodeButton").innerText()).trim(), "读取并提交授权码");
  await assertNoPairOverlap(compact, ".official-browser-footer > *");
  await assertNoHorizontalOverflow(compact);
  await compact.screenshot({ path: path.join(screenshots, "official-server-login-320.png"), fullPage: true });
  await compact.locator("#officialBrowserKeyboardInput").fill("135790");
  await compact.locator("#officialAccountDetails").waitFor({ state: "visible" });
  await compactBrowserDialog.waitFor({ state: "hidden" });
  await compact.close();
});

test("invalid official accounts retain identity and weekly usage on desktop and mobile", async () => {
  for (const viewport of [
    { width: 1280, height: 720, name: "desktop", isMobile: false },
    { width: 390, height: 844, name: "mobile", isMobile: true },
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
    });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/providers/official?*", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authorized: true,
        account: null,
        requiresOpenaiAuth: true,
        usage: null,
        rateLimits: null,
        pendingLogin: null,
        queryErrors: [],
        updatedAt: Date.now(),
        stale: false,
        accounts: [{
          id: "oa-0123456789abcdef",
          email: "retained@example.test",
          planType: "plus",
          active: true,
          weekly: { usedPercent: 74, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
          credentialStatus: "invalid",
          credentialStatusUpdatedAt: Date.now(),
        }],
        activeAccountId: "oa-0123456789abcdef",
        credentialInvalid: true,
        provider: { active: false, activeCustomProvider: true, canActivate: false },
      }),
    }));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#accountButton").click();
    await page.locator("#accountProviderButton").click();
    await page.locator(".provider-row", { hasText: "Codex 当前配置" }).click();
    await page.locator("#officialAccountStatus").getByText("登录已失效", { exact: true }).waitFor();
    assert.match(
      await page.locator("#officialAccountEmpty").innerText(),
      /账号资料和最近 7 天额度已保留/,
    );
    assert.match(
      await page.locator("#officialAccountSlotList").innerText(),
      /retained@example\.test[\s\S]*登录已失效[\s\S]*7 天用量[\s\S]*74%/,
    );
    assert.equal(
      await page.locator(".official-account-slot-track > span").evaluate((element) => element.style.width),
      "74%",
    );
    await page.getByRole("button", { name: "重新登录", exact: true }).first().waitFor();
    await assertBoundedByViewport(
      page.locator("#providerDialog"),
      { width: viewport.width, height: viewport.height },
    );
    await assertNoHorizontalOverflow(page);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: path.join(screenshots, `official-account-invalid-${viewport.name}.png`),
      fullPage: true,
    });
    await page.close();
  }
});

test("provider failover is explicit and keeps a compact per-thread identity on desktop and mobile", { timeout: 40_000 }, async () => {
  const desktopViewport = { width: 1280, height: 800 };
  const desktop = await browser.newPage({ viewport: desktopViewport });
  desktop.setDefaultTimeout(8_000);
  const desktopErrors = [];
  desktop.on("pageerror", (error) => desktopErrors.push(error.message));
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(desktop);
  await desktop.locator("#newThreadButton").click();
  await desktop.locator("#promptInput").fill("report monthly quota");
  await desktop.locator("#sendButton").click();
  await desktop.waitForFunction(() => {
    const send = document.getElementById("sendButton");
    const status = document.getElementById("turnStatus")?.textContent || "";
    return !send?.disabled && !/正在处理|正在确认发送/.test(status);
  });
  await desktop.locator("#threadProviderBadge").waitFor({ state: "visible" });
  assert.match(await desktop.locator("#threadProviderBadge").innerText(), /OpenAI|browser@example\.test/i);

  await desktop.locator("#accountButton").click();
  await desktop.locator("#accountProviderButton").click();
  await desktop.locator(".provider-row", { hasText: /Codex (?:当前|原)配置/ }).click();
  await desktop.locator("#providerFailoverSection").waitFor({ state: "visible" });
  assert.ok(await desktop.locator('.provider-failover-row[data-eligible="true"]').count() >= 2);
  assert.equal(await desktop.locator("#providerFailoverToggle").isChecked(), false);
  await desktop.locator(".provider-failover-toggle").click();
  assert.equal(await desktop.locator("#providerFailoverToggle").isChecked(), true);
  await desktop.locator("#providerFailoverWarning").waitFor({ state: "visible" });
  await desktop.locator("#providerFailoverSaveButton").click();
  await desktop.locator("#providerFailoverError", { hasText: /确认.*身份与计费/ }).waitFor();
  await desktop.locator("#providerFailoverAcknowledge").check({ force: true });
  await desktop.locator("#providerFailoverConfirmation").fill("启用自动故障切换");
  const enabled = desktop.waitForResponse((response) => (
    response.url().endsWith("/api/providers/failover")
    && response.request().method() === "PUT"
  ));
  await desktop.locator("#providerFailoverSaveButton").click();
  assert.equal((await enabled).status(), 200);
  await desktop.locator("#providerFailoverStatus", { hasText: "自动切换已开启" }).waitFor();

  const firstEligible = desktop.locator('.provider-failover-row[data-eligible="true"]').first();
  const firstLabel = await firstEligible.locator("strong").innerText();
  await firstEligible.getByRole("button", { name: /降低/ }).click();
  const reordered = desktop.waitForResponse((response) => (
    response.url().endsWith("/api/providers/failover")
    && response.request().method() === "PUT"
  ));
  await desktop.locator("#providerFailoverSaveButton").click();
  assert.equal((await reordered).status(), 200);
  assert.notEqual(
    await desktop.locator('.provider-failover-row[data-eligible="true"]').first().locator("strong").innerText(),
    firstLabel,
  );
  await assertBoundedByViewport(desktop.locator("#providerDialog"), desktopViewport);
  await assertNoHorizontalOverflow(desktop);
  await desktop.screenshot({ path: path.join(screenshots, "provider-failover-1280.png"), fullPage: true });

  await desktop.locator(".provider-failover-toggle").click();
  assert.equal(await desktop.locator("#providerFailoverToggle").isChecked(), false);
  const disabled = desktop.waitForResponse((response) => (
    response.url().endsWith("/api/providers/failover")
    && response.request().method() === "PUT"
  ));
  await desktop.locator("#providerFailoverSaveButton").click();
  assert.equal((await disabled).status(), 200);
  assert.deepEqual(desktopErrors, []);
  await desktop.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#accountButton").click();
  await mobile.locator("#accountProviderButton").scrollIntoViewIfNeeded();
  await mobile.locator("#accountProviderButton").click();
  await mobile.locator(".provider-row", { hasText: /Codex (?:当前|原)配置/ }).click();
  await mobile.locator("#providerFailoverSection").scrollIntoViewIfNeeded();
  await mobile.locator("#providerFailoverSection").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  assert.deepEqual(mobileErrors, []);
  await mobile.screenshot({ path: path.join(screenshots, "provider-failover-390.png"), fullPage: true });
  await mobile.close();
});

test("provider-backed image settings stay usable on desktop and mobile", { timeout: 30_000 }, async () => {
  const desktopViewport = { width: 1280, height: 720 };
  const desktop = await browser.newPage({ viewport: desktopViewport });
  desktop.setDefaultTimeout(8_000);
  const desktopErrors = [];
  desktop.on("pageerror", (error) => desktopErrors.push(error.message));
  let modelQueries = 0;
  await desktop.route("**/api/providers/*/models", async (route) => {
    assert.equal(route.request().method(), "POST");
    assert.equal(route.request().headers()["x-codex-desktop-action"], "provider-models-query");
    modelQueries += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerId: "browser-provider",
        models: ["vendor-chat-2.0", "vendor-image-2.0"],
      }),
    });
  });
  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(desktop);
  await desktop.locator("#providerQuickSelect option", { hasText: "Browser current provider" }).waitFor({ state: "attached" });
  const quickProviderOption = desktop.locator("#providerQuickSelect option", { hasText: "Browser alternate provider" });
  await quickProviderOption.waitFor({ state: "attached" });
  await desktop.locator('#modelSelect option[value="vendor-chat-2.0"]').waitFor({ state: "attached" });
  assert.equal(await desktop.locator('#modelSelect option[value="gpt-smoke"]').innerText(), "smoke");
  await desktop.locator("#intelligenceMenuButton").click();
  await desktop.locator("#intelligenceMenu").waitFor({ state: "visible" });
  await desktop.screenshot({ path: path.join(screenshots, "provider-home-1280.png"), fullPage: true });
  await desktop.locator("#intelligenceMenuButton").click();
  await desktop.locator("#accountButton").click();
  await desktop.locator("#accountProviderButton").click();
  await desktop.locator(".provider-row", { hasText: "Browser current provider" }).click();
  const providerModelsResponse = desktop.waitForResponse((response) => (
    response.url().includes("/api/providers/") && response.url().endsWith("/models")
  ));
  await desktop.locator("#providerModelsRefreshButton").click();
  assert.equal((await providerModelsResponse).status(), 200);
  await desktop.locator('#providerModelOptions option[value="vendor-chat-2.0"]').waitFor({ state: "attached" });
  await desktop.locator("#providerModelCatalogSelect").waitFor({ state: "visible" });
  assert.equal(await desktop.locator("#providerModelCatalogSelect option").count(), 3);
  await desktop.locator('#modelSelect option[value="vendor-chat-2.0"]').waitFor({ state: "attached" });
  await desktop.screenshot({ path: path.join(screenshots, "provider-models-1280.png"), fullPage: true });
  await desktop.locator(".provider-row", { hasText: "图片生成" }).click();
  await desktop.locator("#imageApiForm").waitFor({ state: "visible" });
  assert.equal(await desktop.locator("#imageApiProviderInput").inputValue().then(Boolean), true);
  const imageModelsResponse = desktop.waitForResponse((response) => (
    response.url().includes("/api/providers/") && response.url().endsWith("/models")
  ));
  await desktop.locator("#imageApiModelsRefreshButton").click();
  assert.equal((await imageModelsResponse).status(), 200);
  await desktop.locator('#imageApiModelPresets option[value="vendor-image-2.0"]').waitFor({ state: "attached" });
  await desktop.locator("#imageApiModelCatalogSelect").waitFor({ state: "visible" });
  assert.equal(modelQueries, 3);
  await desktop.locator("#imageApiModelCatalogSelect").selectOption("vendor-image-2.0");
  await desktop.locator("#imageApiQualityInput").selectOption("low");
  const saved = desktop.waitForResponse(
    (response) => response.url().endsWith("/api/images/settings") && response.request().method() === "PUT",
  );
  await desktop.locator("#saveImageApiButton").click();
  assert.equal((await saved).status(), 200);
  await desktop.locator("#imageApiStatus").getByText("已配置", { exact: true }).waitFor();
  assert.equal(await desktop.locator("#imageApiModelInput").inputValue(), "vendor-image-2.0");
  await assertBoundedByViewport(desktop.locator("#providerDialog"), desktopViewport);
  await desktop.locator("#providerCloseButton").click();
  const quickProviderId = await quickProviderOption.getAttribute("value");
  const activated = desktop.waitForResponse((response) => (
    response.url().endsWith(`/api/providers/${quickProviderId}/activate`)
    && response.request().method() === "POST"
  ));
  await desktop.locator("#providerQuickButton").click();
  await desktop.locator(".provider-quick-row", { hasText: "Browser alternate provider" }).click();
  assert.equal((await activated).status(), 200);
  await desktop.waitForFunction((providerId) => (
    document.getElementById("providerQuickSelect")?.value === providerId
  ), quickProviderId);
  assert.deepEqual(desktopErrors, []);
  await desktop.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#accountButton").click();
  await mobile.locator("#accountProviderButton").scrollIntoViewIfNeeded();
  await mobile.locator("#accountProviderButton").click();
  await mobile.locator(".provider-row", { hasText: "图片生成" }).click();
  await mobile.locator("#imageApiForm").waitFor({ state: "visible" });
  assert.equal(await mobile.locator("#imageApiProviderInput").inputValue().then(Boolean), true);
  assert.equal(await mobile.locator("#imageApiModelInput").inputValue(), "vendor-image-2.0");
  assert.equal(await mobile.locator("#imageApiQualityInput").inputValue(), "low");
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  assert.deepEqual(mobileErrors, []);
  await mobile.screenshot({ path: path.join(screenshots, "image-api-settings-390.png"), fullPage: true });

  mobile.once("dialog", (confirmation) => confirmation.accept());
  const removed = mobile.waitForResponse(
    (response) => response.url().endsWith("/api/images/settings") && response.request().method() === "DELETE",
  );
  await mobile.locator("#removeImageApiButton").click();
  assert.equal((await removed).status(), 204);
  await mobile.locator("#imageApiStatus").getByText("未配置", { exact: true }).waitFor();
  await mobile.close();
});

test("Image Studio exposes real capabilities and stays bounded on desktop, tablet, and touch mobile", { timeout: 45_000 }, async () => {
  const capabilities = {
    enabled: true,
    presetId: "browser-stable",
    operations: ["generate", "edit", "outpaint"],
    operationCapabilities: {
      generate: { customSize: true, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
      edit: { customSize: false, sizes: ["1024x1024"] },
      outpaint: { customSize: false, sizes: ["1536x1024"] },
    },
    features: {
      mask: true,
      multiInput: true,
      streaming: true,
      inputFidelity: false,
      strictMask: true,
      seamlessOutpaint: true,
    },
    defaults: {
      size: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      outputCompression: 100,
      background: "opaque",
      moderation: "auto",
      n: 1,
      partialImages: 1,
    },
    limits: {
      maxPromptCharacters: 32_000,
      maxInputImages: 4,
      maxOutputs: 4,
      maxPartialImages: 3,
      fixedSizes: [],
      size: {
        allowAuto: true,
        maxWidth: 3840,
        maxHeight: 3840,
        minPixels: 655_360,
        maxPixels: 8_294_400,
        maxAspectRatio: 3,
        dimensionMultiple: 16,
      },
    },
    options: {
      sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
      qualities: ["low", "medium", "high"],
      outputFormats: ["png", "jpeg", "webp"],
      backgrounds: ["auto", "opaque"],
      moderations: ["auto", "low"],
      inputFidelities: [],
    },
  };
  const devices = [
    { name: "desktop", viewport: { width: 1280, height: 720 }, options: {} },
    { name: "tablet", viewport: { width: 820, height: 1180 }, options: { hasTouch: true } },
    { name: "mobile-touch", viewport: { width: 390, height: 844 }, options: { isMobile: true, hasTouch: true } },
  ];

  for (const device of devices) {
    const page = await browser.newPage({ viewport: device.viewport, ...device.options });
    page.setDefaultTimeout(8_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/images/capabilities", async (route) => {
      assert.equal(route.request().method(), "GET");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(capabilities) });
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForCodexConnection(page);
    await page.locator("#imageStudioButton:not([disabled])").waitFor();
    await page.locator("#imageStudioButton").click();
    const dialog = page.locator("#imageStudioDialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#imageStudioStatus").getByText("已启用 · browser-stable", { exact: true }).waitFor();

    await assertBoundedByViewport(dialog, device.viewport);
    await assertContainedBy(page, ".image-studio-form", "#imageStudioDialog");
    await assertNoHorizontalOverflow(page);
    for (const operation of ["generate", "edit", "outpaint"]) {
      const button = page.locator(`[data-image-operation="${operation}"]`);
      await button.waitFor({ state: "visible" });
      assert.equal(await button.isEnabled(), true, `${device.name} ${operation} should be enabled`);
    }

    assert.equal(await page.locator("#imageStudioInputFidelityField").isHidden(), true);
    assert.equal(await page.locator("#imageStudioInputFidelity option").count(), 0);
    assert.equal(await page.locator('#imageStudioBackground option[value="transparent"]').count(), 0);

    await page.locator('[data-image-operation="edit"]').click();
    assert.equal(await page.locator('[data-image-operation="edit"]').getAttribute("aria-pressed"), "true");
    await page.locator("#imageStudioSourcesField").waitFor({ state: "visible" });
    assert.equal(await page.locator("#imageStudioOutpaintFields").isHidden(), true);
    assert.equal(await page.locator("#imageStudioSize").inputValue(), "1024x1024");
    await page.locator("#imageStudioMask").fill("assets/edit-mask.png");
    await page.locator("#imageStudioMaskControls").waitFor({ state: "visible" });
    assert.equal(await page.locator("#imageStudioMaskMode").inputValue(), "strict");
    await page.locator("#imageStudioMaskFeather").fill("32");
    assert.equal(await page.locator("#imageStudioMaskFeather").inputValue(), "32");

    await page.locator('[data-image-operation="outpaint"]').click();
    assert.equal(await page.locator('[data-image-operation="outpaint"]').getAttribute("aria-pressed"), "true");
    await page.locator("#imageStudioOutpaintFields").waitFor({ state: "visible" });
    assert.equal(await page.locator("#imageStudioSizeField").isHidden(), true);
    for (const selector of [
      "#imageStudioOutpaintTop",
      "#imageStudioOutpaintRight",
      "#imageStudioOutpaintBottom",
      "#imageStudioOutpaintLeft",
    ]) await page.locator(selector).waitFor({ state: "visible" });
    await page.locator("#imageStudioOutpaintRight").fill("512");
    await page.locator("#imageStudioOutpaintLeft").fill("256");
    assert.equal(await page.locator("#imageStudioOutpaintRight").inputValue(), "512");
    assert.equal(await page.locator("#imageStudioOutpaintLeft").inputValue(), "256");
    assert.equal(await page.locator("#imageStudioPreserveSource").inputValue(), "exact");
    await page.locator("#imageStudioPreserveSource").selectOption("seamless");
    await page.locator("#imageStudioBlendMarginField").waitFor({ state: "visible" });
    await page.locator("#imageStudioBlendMargin").fill("96");
    await page.locator("#imageStudioAlignmentPolicy").selectOption("pad-and-crop");
    assert.equal(await page.locator("#imageStudioBlendMargin").inputValue(), "96");
    assert.equal(await page.locator("#imageStudioAlignmentPolicy").inputValue(), "pad-and-crop");

    await assertBoundedByViewport(dialog, device.viewport);
    await assertNoHorizontalOverflow(page);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(screenshots, `image-studio-${device.name}.png`), fullPage: true });
    await page.locator("#imageStudioCloseButton").click();
    await page.close();
  }
});

test("Claude runtime keeps provider access in the shared Codex panel", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#desktop.claude-runtime").waitFor({ state: "attached" });
  await page.locator("#providerQuickButton").waitFor({ state: "visible" });
  assert.equal(await page.locator('#providerQuickSelect option[value^="official:"]').count(), 1);
  await page.locator("#panelsButton").click();
  const claudeThread = page.locator(".thread-row", { hasText: "Claude transcript fixture" });
  await claudeThread.waitFor({ state: "visible" });
  await claudeThread.click();
  await page.getByText("Fixture work completed.", { exact: true }).waitFor();
  assert.ok(await page.locator(".message.agent .message-label", { hasText: "Claude" }).count() >= 1);
  assert.equal(await page.getByText("Fixture work completed.", { exact: true }).count(), 1);
  assert.equal(await page.locator(".claude-tool-command", { hasText: "npm test" }).count(), 1);
  assert.equal(await page.locator(".claude-tool-command .tool-output", { hasText: "2 tests passed" }).isVisible(), true);
  assert.equal(await page.locator(".claude-diff .diff-remove", { hasText: "-old line" }).count(), 1);
  assert.equal(await page.locator(".claude-diff .diff-add", { hasText: "+new line" }).count(), 1);
  assert.match(
    await page.locator(".claude-result").filter({ hasText: "$0.01" }).first().innerText(),
    /1\.3 s.*\$0\.01.*2 轮/s,
  );
  await page.locator("#claudeSuggestionButton").waitFor();
  assert.equal(await page.locator("#contextStatusButton").isVisible(), true);
  assert.match(await page.locator("#contextStatusLabel").textContent(), /^(?:<1%|--)$/);
  await page.locator("#contextStatusButton").click();
  await page.locator("#contextDialogTitle", { hasText: "Claude 上下文与用量" }).waitFor();
  assert.match(await page.locator("#contextCumulativeValue").textContent(), /\d+ Token.*\d+ 次/);
  const previousCompactions = Number.parseInt(await page.locator("#contextCompactionCountValue").textContent(), 10);
  assert.ok(previousCompactions >= 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#compactThreadButton").click();
  await page.getByText("Context compacted.", { exact: true }).waitFor();
  await page.locator("#claudeSuggestionButton", { hasText: "Review the next fixture" }).waitFor();
  await page.locator("#contextStatusButton").click();
  assert.equal(
    Number.parseInt(await page.locator("#contextCompactionCountValue").textContent(), 10),
    previousCompactions + 1,
  );
  await page.locator("#contextDialog button[value=cancel]").first().click();
  await page.locator("#threadMoreButton").click();
  await page.locator("#claudeRewindButton").click();
  await page.locator("#claudeRewindDialog").waitFor({ state: "visible" });
  await page.locator("#claudeRewindPreviewButton").click();
  await page.locator("#claudeRewindPreview", { hasText: "可回退 2 个文件" }).waitFor();
  assert.match(await page.locator("#claudeRewindPreview").innerText(), /src\/fixture\.js.*README\.md/s);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#claudeRewindRestoreButton").click();
  await page.locator("#claudeRewindDialog").waitFor({ state: "hidden" });
  await page.locator(".claude-system-event", { hasText: "已恢复 Claude 文件检查点" }).waitFor();
  await page.locator("#promptInput").fill("coordinate Claude agents");
  await page.locator("#sendButton").click();
  const agentActivity = page.locator(".claude-agent-activity", { hasText: "Review the browser fixture" });
  await agentActivity.waitFor();
  assert.equal(await page.locator(".claude-agent-activity").count(), 1);
  assert.equal(await agentActivity.getAttribute("data-status"), "completed");
  assert.match(await agentActivity.innerText(), /Explore.*Responsive review complete.*用时 1\.3 s.*240 Token.*3 次工具/s);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: path.join(screenshots, "claude-transcript-1280.png"), fullPage: true });

  await page.locator("#providerQuickButton").click();
  await page.locator("#providerQuickSettingsButton").click();
  await page.locator("#providerDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#providerDialog").getAttribute("data-runtime"), "claude");
  assert.equal(await page.locator("#providerWorkspace").isHidden(), true);
  assert.equal(await page.locator("#claudeProviderWorkspace").isHidden(), false);
  assert.equal(await page.locator("#providerDialogTitle").innerText(), "Claude 设置");
  await page.locator("#claudeOfficialAccountList .claude-official-account").first().waitFor();
  assert.match(
    await page.locator("#claudeOfficialAccountList .claude-official-account").first().innerText(),
    /登录有效.*官方暂未提供额度/s,
  );
  await page.locator("#claudeMcpTab").click();
  await page.locator(".claude-mcp-row", { hasText: "fixture-mcp" }).click();
  assert.equal(await page.locator("#claudeMcpTargetInput").inputValue(), "https://mcp.example.test/service");
  assert.match(await page.locator("#claudeMcpSensitiveStatus").textContent(), /已保存 1 项/);
  await page.locator("#claudeMcpCheckButton").click();
  await page.locator('.claude-mcp-health[data-status="connected"]', { hasText: "已连接" }).waitFor();
  const publicClaudeConfig = await page.evaluate(() => fetch("/api/claude").then((response) => response.json()));
  assert.equal(JSON.stringify(publicClaudeConfig).includes("browser-secret"), false);
  await page.locator("#claudeMcpNewButton").click();
  await page.locator("#claudeMcpNameInput").fill("browser-tools");
  await page.locator("#claudeMcpTargetInput").fill("node");
  await page.locator("#claudeMcpArgsInput").fill("server.mjs");
  await page.locator("#claudeMcpSensitiveInput").fill("API_KEY=browser-new-secret");
  const createdMcp = page.waitForResponse((response) => response.url().endsWith("/api/claude/mcp") && response.request().method() === "POST");
  await page.locator("#claudeMcpForm button[type=submit]").click();
  const createdMcpResponse = await createdMcp;
  assert.equal(createdMcpResponse.status(), 201);
  assert.equal(JSON.stringify(await createdMcpResponse.json()).includes("browser-new-secret"), false);
  await page.locator(".claude-mcp-row", { hasText: "browser-tools" }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  const deletedMcp = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/claude/mcp/browser-tools"
    && response.request().method() === "DELETE"
  ));
  await page.locator("#claudeMcpDeleteButton").click();
  assert.equal((await deletedMcp).status(), 204);
  await page.locator(".claude-mcp-row", { hasText: "browser-tools" }).waitFor({ state: "detached" });

  await page.locator("#claudeBackgroundTab").click();
  await page.locator("#claudeBackgroundPanel").waitFor({ state: "visible" });
  await page.locator("#claudeBackgroundNameInput").fill("浏览器后台检查");
  await page.locator("#claudeBackgroundPermissionInput").selectOption("plan");
  await page.locator("#claudeBackgroundPromptInput").fill("独立检查当前工程并报告结果");
  const startedBackground = page.waitForResponse((response) =>
    response.url().endsWith("/api/claude/background-agents") && response.request().method() === "POST");
  await page.locator("#claudeBackgroundForm button[type=submit]").click();
  const startedBackgroundResponse = await startedBackground;
  assert.equal(startedBackgroundResponse.status(), 201);
  assert.equal(startedBackgroundResponse.request().postDataJSON().permissionMode, "plan");
  const backgroundRow = page.locator(".claude-background-row", { hasText: "浏览器后台检查" });
  await backgroundRow.waitFor();
  await backgroundRow.getByRole("button", { name: "查看记录" }).click();
  await backgroundRow.locator(".claude-background-transcript", { hasText: "后台检查正在运行。" }).waitFor();
  await assertBoundedByViewport(page.locator("#providerDialog"), { width: 1280, height: 720 });
  page.once("dialog", (dialog) => dialog.accept());
  const stoppedBackground = page.waitForResponse((response) =>
    response.url().endsWith("/api/claude/background-agents/ba5eba11/stop")
    && response.request().method() === "POST");
  await backgroundRow.getByRole("button", { name: "停止", exact: true }).click();
  assert.equal((await stoppedBackground).status(), 200);
  await backgroundRow.locator(".claude-background-badge", { hasText: "已停止" }).waitFor();
  await page.locator("#providerCloseButton").click();

  await page.locator("#intelligenceMenuButton").click();
  await page.locator("#intelligenceMenu").waitFor({ state: "visible" });
  assert.equal(await page.locator("#collaborationModeButton").count(), 0);
  assert.equal(await page.locator("#claudePermissionButton").isVisible(), true);
  await page.locator("#claudePermissionButton").click();
  await page.locator('#claudePermissionOptions [aria-checked="true"]').waitFor({ state: "visible" });
  await page.locator("#claudePermissionOptions .intelligence-option", { hasText: "仅规划" }).click();
  await page.locator("#sandboxStatus", { hasText: "仅规划" }).waitFor();
  await page.locator("#intelligenceMenuButton").click();
  await page.locator("#claudeExecutionButton").click();
  await page.locator("#claudeExecutionView").waitFor({ state: "visible" });
  assert.equal(await page.locator("#claudeFallbackModelInput").isVisible(), true);
  assert.equal(await page.locator("#claudeMaxBudgetInput").isVisible(), true);
  assert.equal(await page.locator("#claudeAllowedToolsInput").isVisible(), true);
  assert.equal(await page.locator("#claudeDisallowedToolsInput").isVisible(), true);
  assert.equal(await page.locator("#claudeAgentInput").isVisible(), true);
  await assertBoundedByViewport(page.locator("#intelligenceMenu"), { width: 1280, height: 720 });
  await page.locator("#claudeExecutionBackButton").click();
  await page.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#runtimeSwitcherButton").click();
  await mobile.locator('[data-runtime="claude"]').click();
  await mobile.locator("#desktop.claude-runtime").waitFor({ state: "attached" });
  await mobile.locator("#panelsButton").click();
  await mobile.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  await mobile.locator(".claude-agent-activity", { hasText: "Review the browser fixture" }).waitFor();
  await mobile.locator("#intelligenceMenuButton").click();
  await mobile.locator("#intelligenceMenu").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#intelligenceMenu"), mobileViewport);
  await mobile.locator("#claudePermissionButton").click();
  await assertBoundedByViewport(mobile.locator("#intelligenceMenu"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator("#claudePermissionBackButton").click();
  await mobile.locator("#claudeExecutionButton").click();
  await mobile.locator("#claudeExecutionView").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#intelligenceMenu"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  assert.deepEqual(mobileErrors, []);
  await mobile.screenshot({ path: path.join(screenshots, "claude-controls-390.png"), fullPage: true });
  await mobile.locator("#claudeExecutionBackButton").click();
  await mobile.locator("#claudePermissionButton").click();
  await mobile.locator("#claudePermissionOptions .intelligence-option", { hasText: "自动接受编辑" }).click();
  const mobileClaudeConfig = mobile.waitForResponse((response) => response.url().includes("/api/claude?") && response.ok());
  await mobile.locator("#providerQuickButton").click();
  await mobile.locator("#providerQuickSettingsButton").click();
  await mobileClaudeConfig;
  await mobile.locator("#claudeOfficialAccountList .claude-official-account").first().waitFor();
  await mobile.locator("#claudeOfficialProxyPanel").scrollIntoViewIfNeeded();
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator("#claudeMcpTab").click();
  await mobile.locator("#claudeMcpForm").scrollIntoViewIfNeeded();
  await mobile.locator(".claude-mcp-row", { hasText: "fixture-mcp" }).waitFor();
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "claude-mcp-390.png"), fullPage: true });
  await mobile.locator("#claudeBackgroundTab").click();
  await mobile.locator(".claude-background-row", { hasText: "浏览器后台检查" }).waitFor();
  await mobile.locator("#claudeBackgroundForm").scrollIntoViewIfNeeded();
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "claude-background-390.png"), fullPage: true });
  await mobile.locator("#providerCloseButton").click();
  await mobile.close();
});

test("Claude extensions and new-conversation workspaces stay usable on desktop and mobile", { timeout: 50_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#providerQuickButton").click();
  await page.locator("#providerQuickSettingsButton").click();
  await page.locator("#providerDialog").waitFor({ state: "visible" });
  await page.locator("#claudeHooksTab").click();
  await page.locator("#claudeHookMatcherInput").fill("Bash");
  await page.locator("#claudeHookCommandInput").fill("npm run check");
  await page.locator("#claudeHookTimeoutInput").selectOption("20");
  page.once("dialog", (dialog) => {
    assert.match(dialog.message(), /当前账号权限自动执行.*npm run check/s);
    dialog.accept();
  });
  const savedPrimaryHook = page.waitForResponse((response) =>
    response.url().endsWith("/api/claude/hooks") && response.request().method() === "PUT");
  await page.locator("#claudeHooksForm button[type=submit]").click();
  assert.equal((await savedPrimaryHook).status(), 200);
  await page.locator(".claude-hook-row", { hasText: "npm run check" }).waitFor();

  await page.locator("#claudeHookEventInput").selectOption("SessionEnd");
  await page.locator("#claudeHookCommandInput").fill("node scripts/cleanup.mjs");
  await page.locator("#claudeHookTimeoutInput").selectOption("5");
  page.once("dialog", (dialog) => dialog.accept());
  const savedSecondaryHook = page.waitForResponse((response) =>
    response.url().endsWith("/api/claude/hooks") && response.request().method() === "PUT");
  await page.locator("#claudeHooksForm button[type=submit]").click();
  assert.equal((await savedSecondaryHook).status(), 200);
  const secondaryHook = page.locator(".claude-hook-row", { hasText: "node scripts/cleanup.mjs" });
  await secondaryHook.waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  const deletedSecondaryHook = page.waitForResponse((response) =>
    response.url().endsWith("/api/claude/hooks") && response.request().method() === "PUT");
  await secondaryHook.getByRole("button", { name: "删除 Hook", exact: true }).click();
  assert.equal((await deletedSecondaryHook).status(), 200);
  await secondaryHook.waitFor({ state: "detached" });
  await page.locator("#providerCloseButton").click();

  const reloadedHooks = page.waitForResponse((response) =>
    response.url().includes("/api/claude/hooks?") && response.ok());
  await page.locator("#providerQuickButton").click();
  await page.locator("#providerQuickSettingsButton").click();
  await reloadedHooks;
  await page.locator("#claudeHooksTab").click();
  const storedHook = page.locator(".claude-hook-row", { hasText: "npm run check" });
  await storedHook.waitFor();
  assert.match(await storedHook.innerText(), /PreToolUse.*Bash.*20s/s);
  await page.screenshot({ path: path.join(screenshots, "claude-hooks-1280.png"), fullPage: true });
  await page.locator("#claudeExtensionsTab").click();

  await page.locator("#claudeSkillNameInput").fill("browser-release");
  await page.locator("#claudeSkillToolsInput").fill("Read Bash(git status *)");
  await page.locator("#claudeSkillDescriptionInput").fill("Checks the browser release");
  await page.locator("#claudeSkillBodyInput").fill("Inspect the release and report blockers.");
  const createdSkill = page.waitForResponse((response) => response.url().endsWith("/api/claude/skills") && response.request().method() === "POST");
  await page.locator("#claudeSkillForm button[type=submit]").click();
  assert.equal((await createdSkill).status(), 201);
  await page.locator(".claude-extension-row", { hasText: "/browser-release" }).waitFor();
  await page.locator("#claudeSkillDescriptionInput").fill("Checks and documents the browser release");
  await page.locator("#claudeSkillBodyInput").fill("Inspect the release, run focused checks, and report blockers.");
  const updatedSkill = page.waitForResponse((response) => response.url().endsWith("/api/claude/skills/browser-release") && response.request().method() === "PUT");
  await page.locator("#claudeSkillForm button[type=submit]").click();
  assert.equal((await updatedSkill).status(), 200);
  assert.equal(await page.locator("#claudeSkillDescriptionInput").inputValue(), "Checks and documents the browser release");

  await page.locator("#claudeAgentsTab").click();
  await page.locator("#claudeAgentNameInput").fill("browser-reviewer");
  await page.locator("#claudeAgentDescriptionInput").fill("Reviews changes without editing");
  await page.locator("#claudeAgentToolsInput").fill("Read, Grep, Glob");
  await page.locator("#claudeAgentDisallowedToolsInput").fill("Edit, Write");
  await page.locator("#claudeAgentModelInput").selectOption("sonnet");
  await page.locator("#claudeAgentPermissionInput").selectOption("plan");
  await page.locator("#claudeAgentEffortInput").selectOption("high");
  await page.locator("#claudeAgentWorktreeInput + .toggle-control").click();
  assert.equal(await page.locator("#claudeAgentWorktreeInput").isChecked(), true);
  await page.locator("#claudeAgentBodyInput").fill("Review the current changes and return prioritized findings.");
  const createdAgent = page.waitForResponse(
    (response) => response.url().endsWith("/api/claude/agents")
      && response.request().method() === "POST",
    { timeout: 20_000 },
  );
  await page.locator("#claudeAgentForm button[type=submit]").click();
  assert.equal((await createdAgent).status(), 201);
  await page.locator(".claude-extension-row", { hasText: "browser-reviewer" }).waitFor();
  await page.locator("#claudeAgentBodyInput").fill("Review the current changes, tests, and operational risk.");
  const updatedAgent = page.waitForResponse(
    (response) => response.url().endsWith("/api/claude/agents/browser-reviewer")
      && response.request().method() === "PUT",
    { timeout: 20_000 },
  );
  await page.locator("#claudeAgentForm button[type=submit]").click();
  assert.equal((await updatedAgent).status(), 200);
  assert.equal(await page.locator("#claudeAgentBodyInput").inputValue(), "Review the current changes, tests, and operational risk.");

  await page.locator("#claudePluginsTab").click();
  const fixturePlugin = page.locator(".claude-plugin-row", { hasText: "review-kit@fixture-market" });
  await fixturePlugin.waitFor();
  const pluginToggle = fixturePlugin.locator('input[type="checkbox"]');
  assert.equal(await pluginToggle.isDisabled(), false);
  const pluginWasEnabled = await pluginToggle.isChecked();
  const disabledPlugin = page.waitForResponse((response) => response.url().includes("/api/claude/plugins/") && response.url().endsWith("/enabled") && response.request().method() === "PUT");
  await pluginToggle.evaluate((input) => {
    input.checked = !input.checked;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal((await disabledPlugin).status(), 200);
  await page.locator("#claudePluginIdentifierInput").fill("browser-kit@fixture-market");
  const installedPlugin = page.waitForResponse((response) => response.url().endsWith("/api/claude/plugins") && response.request().method() === "POST");
  await page.locator("#claudePluginForm button[type=submit]").click();
  assert.equal((await installedPlugin).status(), 201);
  await page.waitForFunction(() => document.getElementById("claudePluginIdentifierInput")?.value === "");
  assert.equal(await page.locator("#claudePluginIdentifierInput").inputValue(), "");
  page.once("dialog", (dialog) => dialog.accept());
  const removedPlugin = page.waitForResponse((response) => response.url().includes("/api/claude/plugins/") && response.request().method() === "DELETE");
  await fixturePlugin.getByRole("button", { name: "卸载插件", exact: true }).click();
  assert.equal((await removedPlugin).status(), 204);
  const pluginActions = (await fs.readFile(path.join(directory, "claude-plugin-actions.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(pluginActions.map((args) => args.slice(0, 3)), [
    ["plugin", pluginWasEnabled ? "disable" : "enable", "review-kit@fixture-market"],
    ["plugin", "install", "browser-kit@fixture-market"],
    ["plugin", "uninstall", "review-kit@fixture-market"],
  ]);
  assert.equal(pluginActions.every((args) => args.includes("user")), true);
  await page.screenshot({ path: path.join(screenshots, "claude-extensions-1280.png"), fullPage: true });
  await page.locator("#providerCloseButton").click();

  const loadedCommands = page.waitForResponse((response) =>
    response.url().includes("/api/claude/commands?") && response.ok());
  await page.locator("#claudeCommandButton").click();
  await loadedCommands;
  await page.locator(".claude-command-option", { hasText: "/browser-release" }).waitFor();
  await page.screenshot({ path: path.join(screenshots, "claude-command-palette-1280.png"), fullPage: true });
  await page.locator("#promptInput").fill("/browser");
  assert.equal(await page.locator(".claude-command-option").count(), 1);
  await page.locator("#promptInput").press("Enter");
  assert.equal(await page.locator("#promptInput").inputValue(), "/browser-release ");
  assert.equal(await page.locator("#claudeCommandMenu").isHidden(), true);
  await page.locator("#promptInput").fill("");

  await page.locator("#intelligenceMenuButton").click();
  await page.locator("#claudeWorkspaceButton").click();
  await page.locator("#claudeWorktreeInput + .toggle-control").click();
  assert.equal(await page.locator("#claudeWorktreeInput").isChecked(), true);
  await page.locator("#claudeWorktreeNameField").waitFor({ state: "visible" });
  await page.locator("#claudeWorktreeNameInput").fill("browser-review");
  const tooManyDirectories = Array.from({ length: 9 }, (_, index) => path.join(directory, "projects", `extra-${index}`));
  await page.locator("#claudeAdditionalDirectoriesInput").fill(tooManyDirectories.join("\n"));
  await page.locator("#claudeWorkspaceSaveButton").click();
  await page.locator("#claudeWorkspaceError", { hasText: "最多设置 8 个" }).waitFor();
  const savedDirectories = [path.join(directory, "projects", "shared-one"), path.join(directory, "projects", "shared-two")];
  await page.locator("#claudeAdditionalDirectoriesInput").fill(savedDirectories.join("\n"));
  assert.equal((await page.locator("#claudeWorkspaceError").textContent()).trim(), "");
  await page.screenshot({ path: path.join(screenshots, "claude-workspace-1280.png"), fullPage: true });
  await page.locator("#claudeWorkspaceSaveButton").click();
  await page.locator("#claudeWorkspaceState", { hasText: "独立 Worktree · +2 目录" }).waitFor();
  await page.locator("#claudeWorkspaceButton").click();
  assert.equal(await page.locator("#claudeWorktreeInput").isChecked(), true);
  assert.equal(await page.locator("#claudeWorktreeNameInput").inputValue(), "browser-review");
  assert.equal(await page.locator("#claudeAdditionalDirectoriesInput").inputValue(), savedDirectories.join("\n"));

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(10_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#runtimeSwitcherButton").click();
  await mobile.locator('[data-runtime="claude"]').click();
  await mobile.locator("#providerQuickButton").click();
  await mobile.locator("#providerQuickSettingsButton").click();
  await mobile.locator("#providerDialog").waitFor({ state: "visible" });
  await mobile.locator("#claudeHooksTab").click();
  await mobile.locator(".claude-hook-row", { hasText: "npm run check" }).waitFor();
  await mobile.locator("#claudeHookCommandInput").scrollIntoViewIfNeeded();
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "claude-hooks-390.png"), fullPage: true });
  mobile.once("dialog", (dialog) => dialog.accept());
  const clearedHooks = mobile.waitForResponse((response) =>
    response.url().endsWith("/api/claude/hooks") && response.request().method() === "DELETE");
  await mobile.locator("#claudeHooksClearButton").click();
  assert.equal((await clearedHooks).status(), 200);
  await mobile.locator("#claudeHooksStatus", { hasText: "未配置" }).waitFor();
  await mobile.locator("#claudeExtensionsTab").click();
  await mobile.locator("#claudeAgentsTab").click();
  await mobile.locator(".claude-extension-row", { hasText: "browser-reviewer" }).waitFor();
  const backgroundScroll = await mobile.evaluate(() => window.scrollY);
  await mobile.locator("#claudeAgentBodyInput").scrollIntoViewIfNeeded();
  const scrollState = await mobile.evaluate(() => ({
    background: window.scrollY,
    dialog: document.querySelector("#claudeProviderWorkspace > .claude-body")?.scrollTop || 0,
  }));
  assert.equal(scrollState.background, backgroundScroll);
  assert.ok(scrollState.dialog > 0, JSON.stringify(scrollState));
  await assertBoundedByViewport(mobile.locator("#providerDialog"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "claude-extensions-390.png"), fullPage: true });
  await mobile.locator("#providerCloseButton").click();
  const loadedMobileCommands = mobile.waitForResponse((response) =>
    response.url().includes("/api/claude/commands?") && response.ok());
  await mobile.locator("#claudeCommandButton").click();
  await loadedMobileCommands;
  const mobileCommand = mobile.locator(".claude-command-option", { hasText: "/browser-release" });
  await mobileCommand.waitFor();
  await assertBoundedByViewport(mobile.locator("#claudeCommandMenu"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "claude-command-palette-390.png"), fullPage: true });
  await mobileCommand.click();
  assert.equal(await mobile.locator("#promptInput").inputValue(), "/browser-release ");
  await mobile.locator("#promptInput").fill("");
  await mobile.locator("#intelligenceMenuButton").click();
  await mobile.locator("#claudeWorkspaceButton").click();
  await mobile.locator("#claudeWorktreeInput + .toggle-control").click();
  assert.equal(await mobile.locator("#claudeWorktreeInput").isChecked(), true);
  await mobile.locator("#claudeWorktreeNameInput").fill("mobile-review");
  await assertBoundedByViewport(mobile.locator("#intelligenceMenu"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.screenshot({ path: path.join(screenshots, "claude-workspace-390.png"), fullPage: true });
  assert.deepEqual(mobileErrors, []);
  await mobile.close();

  await page.locator("#claudeWorkspaceBackButton").click();
  await page.locator("#providerQuickButton").click();
  await page.locator("#providerQuickSettingsButton").click();
  await page.locator("#claudeExtensionsTab").click();
  await page.locator("#claudeSkillsTab").click();
  await page.locator(".claude-extension-row", { hasText: "/browser-release" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  const deletedSkill = page.waitForResponse((response) => response.url().endsWith("/api/claude/skills/browser-release") && response.request().method() === "DELETE");
  await page.locator("#claudeSkillDeleteButton").click();
  assert.equal((await deletedSkill).status(), 204);
  await page.locator("#claudeAgentsTab").click();
  await page.locator(".claude-extension-row", { hasText: "browser-reviewer" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  const deletedAgent = page.waitForResponse((response) => response.url().endsWith("/api/claude/agents/browser-reviewer") && response.request().method() === "DELETE");
  await page.locator("#claudeAgentDeleteButton").click();
  assert.equal((await deletedAgent).status(), 204);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test("Claude keeps conversation actions isolated and sends uploaded project files", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();

  assert.equal(await page.locator("#goalBar").isHidden(), true);
  assert.equal(await page.locator("#contextStatusButton").isVisible(), true);
  assert.equal(await page.locator("#imageGenerationButton").isHidden(), true);

  await page.locator("#fileInput").setInputFiles({
    name: "claude-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Claude attachment fixture"),
  });
  await page.locator(".attachment-chip", { hasText: "claude-note.txt" }).waitFor();
  await page.locator("#promptInput").fill("Review the attachment");
  await page.locator("#sendButton").click();
  const permissionDialog = page.locator("#approvalDialog");
  await permissionDialog.waitFor({ state: "visible" });
  await permissionDialog.getByRole("button", { name: "本次允许", exact: true }).click();
  await page.getByText("Permission handled.", { exact: true }).last().waitFor();
  await page.locator(".message-file", { hasText: "claude-note.txt" }).waitFor();

  const inputRecords = (await fs.readFile(path.join(directory, "claude-inputs.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const attachmentInput = inputRecords.find((entry) => String(entry.message?.content || "").includes("claude-note.txt"));
  assert.ok(attachmentInput);
  assert.match(attachmentInput.message.content, /Use the Read tool/);
  assert.match(attachmentInput.message.content, /\.codex-uploads/);

  await page.locator("#threadMoreButton").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportThreadButton").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.md$/);
  assert.match(await fs.readFile(await download.path(), "utf8"), /Claude session ID:|Review the attachment/);

  await page.locator("#threadMoreButton").click();
  await page.locator("#pinThreadButton").click();
  await page.locator("#threadMoreButton").click();
  assert.equal(await page.locator("#pinThreadButton").getAttribute("aria-label"), "取消置顶");
  const previousSessionLabel = await page.locator("#activeSession").innerText();
  await page.locator("#forkThreadButton").click();
  await page.waitForFunction((previous) => document.querySelector("#activeSession")?.innerText !== previous, previousSessionLabel);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#threadMoreButton").click();
  await page.locator("#deleteThreadButton").click();
  await page.locator("#activeSession", { hasText: "未选择会话" }).waitFor();
  await page.close();
});

test("Claude turn and approval survive a closed page and reconnect without duplicate submission", { timeout: 45_000 }, async () => {
  let page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  if (!await page.locator("#desktop").evaluate((element) => element.classList.contains("claude-runtime"))) {
    await page.locator("#runtimeSwitcherButton").click();
    await page.locator('[data-runtime="claude"]').click();
  }
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  const prompt = "approval must survive browser reconnect";
  await page.locator("#promptInput").fill(prompt);
  await page.locator("#sendButton").click();
  await page.locator("#approvalDialog").waitFor({ state: "visible" });
  await page.locator("#approvalDialog").getByText("Claude wants to run npm test", { exact: true }).waitFor();
  await page.close();

  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  const approval = page.locator("#approvalDialog");
  await approval.waitFor({ state: "visible" });
  assert.match(await page.locator("#approvalDialogEyebrow").innerText(), /Claude|后台对话/);
  await approval.getByRole("button", { name: "本会话允许", exact: true }).click();
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#desktop.claude-runtime").waitFor({ state: "attached" });
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  await page.getByText("Permission handled.", { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  assert.equal(await page.locator(".message.user", { hasText: prompt }).count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Claude reconciles an unknown turn delivery after WebSocket reconnect with one client message", { timeout: 45_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    function TrackingWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        nativeSend(data);
        try {
          const message = JSON.parse(String(data));
          if (
            window.__dropNextClaudeTurn === true
            && message?.type === "rpc"
            && message?.method === "claude/turn/start"
          ) {
            window.__dropNextClaudeTurn = false;
            setTimeout(() => socket.close(4000, "fixture reconnect"), 0);
          }
        } catch {}
      };
      return socket;
    }
    TrackingWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(TrackingWebSocket, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = TrackingWebSocket;
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  const prompt = "unknown delivery must remain idempotent";
  await page.evaluate(() => { window.__dropNextClaudeTurn = true; });
  await page.locator("#promptInput").fill(prompt);
  await page.locator("#sendButton").click();
  await page.locator("#connectionText", { hasText: "Codex 已连接" }).waitFor();
  const approval = page.locator("#approvalDialog");
  await approval.waitFor({ state: "visible" });
  await approval.getByRole("button", { name: "本会话允许", exact: true }).click();
  await page.getByText("Permission handled.", { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  assert.equal(await page.locator(".message.user", { hasText: prompt }).count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Claude permission, dialogs, and MCP elicitation stay usable on desktop and mobile", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(12_000);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(page);
  await page.locator("#runtimeSwitcherButton").click();
  await page.locator('[data-runtime="claude"]').click();
  await page.locator("#panelsButton").click();
  await page.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  const observerViewport = { width: 390, height: 844 };
  const observer = await browser.newPage({
    viewport: observerViewport,
    isMobile: true,
    hasTouch: true,
  });
  observer.setDefaultTimeout(12_000);
  await observer.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(observer);
  await observer.locator("#runtimeSwitcherButton").click();
  await observer.locator('[data-runtime="claude"]').click();
  await page.locator("#promptInput").fill("permission request");
  await page.locator("#sendButton").click();
  const permissionDialog = page.locator("#approvalDialog");
  await permissionDialog.waitFor({ state: "visible" });
  await permissionDialog.getByText("Claude wants to run npm test", { exact: true }).waitFor();
  assert.equal(await page.locator("#approvalDialogEyebrow").textContent(), "Claude Code 请求");
  assert.equal(await permissionDialog.getByRole("button", { name: "本会话允许", exact: true }).count(), 1);
  assert.equal(await observer.locator("#approvalDialog").isVisible(), false);
  assert.equal(await observer.locator("#approvalBar").isVisible(), false);
  await observer.locator("#backgroundTaskDrawerButton").click();
  const claudeTaskCard = observer.locator(".task-center-card", { hasText: "Claude 前台" }).filter({
    hasText: "等待审批",
  });
  await claudeTaskCard.waitFor();
  const claudeTaskCardText = await claudeTaskCard.innerText();
  assert.match(claudeTaskCardText, /Claude 前台/);
  assert.match(claudeTaskCardText, /smoke-project/);
  assert.match(claudeTaskCardText, /原有 Claude 账号/);
  assert.match(claudeTaskCardText, /已运行 \d+ (?:秒|分钟|小时)/);
  assert.doesNotMatch(
    await observer.locator("#taskCenterOverviewPanel").innerText(),
    /permission request|Claude wants to run npm test/,
  );
  await assertBoundedByViewport(observer.locator("#backgroundTaskDrawer"), observerViewport);
  await assertNoHorizontalOverflow(observer);
  await observer.locator("#backgroundTaskCloseButton").click();
  await page.screenshot({ path: path.join(screenshots, "claude-permission-1280.png"), fullPage: true });
  await permissionDialog.getByRole("button", { name: "本会话允许", exact: true }).click();
  await page.getByText("Permission handled.", { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  await page.locator("#promptInput").fill("elicitation url request");
  await page.locator("#sendButton").click();
  const urlDialog = page.locator("#approvalDialog");
  await urlDialog.waitFor({ state: "visible" });
  await urlDialog.getByText("Connect fixture service", { exact: true }).waitFor();
  await urlDialog.getByText("服务器隔离浏览器 · example.test", { exact: true }).waitFor();
  await urlDialog.getByRole("button", { name: "打开服务器授权窗口", exact: true }).click();
  await page.locator("#officialBrowserDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#officialBrowserTitle").innerText(), "MCP 授权");
  await page.locator("#officialBrowserCloseButton").click();
  assert.equal(await page.locator("#officialBrowserDialog").isVisible(), false);
  await urlDialog.getByRole("button", { name: "完成后继续", exact: true }).click();
  await page.getByText("URL elicitation handled.", { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  await observer.close();
  await page.close();

  const mobileViewport = { width: 390, height: 844 };
  const mobile = await browser.newPage({ viewport: mobileViewport, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForCodexConnection(mobile);
  await mobile.locator("#runtimeSwitcherButton").click();
  await mobile.locator('[data-runtime="claude"]').click();
  await mobile.locator("#backgroundTaskDrawerButton").click();
  await mobile.locator("#backgroundTaskDrawer").waitFor({ state: "visible" });
  await assertBoundedByViewport(mobile.locator("#backgroundTaskDrawer"), mobileViewport);
  await assertNoHorizontalOverflow(mobile);
  await mobile.locator("#backgroundTaskCloseButton").click();
  await mobile.locator("#panelsButton").click();
  await mobile.locator(".thread-row", { hasText: "Claude transcript fixture" }).click();
  await mobile.locator("#promptInput").fill("question request");
  await mobile.locator("#sendButton").click();
  const questionDialog = mobile.locator("#approvalDialog");
  await questionDialog.waitFor({ state: "visible" });
  await questionDialog.getByText("Which layout should Claude use?", { exact: true }).waitFor();
  await assertBoundedByViewport(questionDialog, mobileViewport);
  await questionDialog.locator(".question-other-input").fill("Balanced");
  await mobile.screenshot({ path: path.join(screenshots, "claude-question-390.png"), fullPage: true });
  await questionDialog.getByRole("button", { name: "提交", exact: true }).click();
  await mobile.getByText("Question answered.", { exact: true }).waitFor();
  await mobile.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  await mobile.locator("#promptInput").fill("elicitation form request");
  await mobile.locator("#sendButton").click();
  const formDialog = mobile.locator("#approvalDialog");
  await formDialog.waitFor({ state: "visible" });
  await formDialog.getByText("Deployment settings", { exact: true }).waitFor();
  await formDialog.locator('[data-elicitation-field="0"]').selectOption({ label: "production" });
  await formDialog.locator('[data-elicitation-field="1"]').fill("4");
  await formDialog.locator('[data-elicitation-field="2"]').uncheck();
  await formDialog.locator('[data-elicitation-field="3"]').fill("Mobile rollout");
  await assertBoundedByViewport(formDialog, mobileViewport);
  await mobile.screenshot({ path: path.join(screenshots, "claude-elicitation-form-390.png"), fullPage: true });
  await formDialog.getByRole("button", { name: "提交", exact: true }).click();
  await mobile.getByText("Form elicitation handled.", { exact: true }).waitFor();
  await mobile.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  await mobile.locator("#promptInput").fill("elicitation form cancellation");
  await mobile.locator("#sendButton").click();
  await formDialog.waitFor({ state: "visible" });
  await formDialog.getByRole("button", { name: "取消", exact: true }).click();
  await mobile.getByText("Elicitation cancelled.", { exact: true }).waitFor();
  await mobile.waitForFunction(() => !document.getElementById("sendButton")?.disabled);

  await mobile.locator("#promptInput").fill("elicitation invalid request");
  await mobile.locator("#sendButton").click();
  await mobile.getByText("Invalid elicitation cancelled.", { exact: true }).waitFor();
  await mobile.waitForFunction(() => !document.getElementById("sendButton")?.disabled);
  assert.equal(await formDialog.isVisible(), false);

  await mobile.locator("#promptInput").fill("fallback request");
  await mobile.locator("#sendButton").click();
  const fallbackDialog = mobile.locator("#approvalDialog");
  await fallbackDialog.waitFor({ state: "visible" });
  await fallbackDialog.getByText("claude-opus-test", { exact: true }).waitFor();
  await fallbackDialog.getByText("claude-sonnet-test", { exact: true }).waitFor();
  assert.equal(await fallbackDialog.getByRole("button", { name: "取消", exact: true }).count(), 1);
  assert.equal(await fallbackDialog.getByRole("button", { name: "切换至 claude-sonnet-test", exact: true }).count(), 1);
  await assertBoundedByViewport(fallbackDialog, mobileViewport);
  await mobile.screenshot({ path: path.join(screenshots, "claude-fallback-390.png"), fullPage: true });
  await fallbackDialog.getByRole("button", { name: "编辑提示并重试", exact: true }).click();
  await mobile.getByText("Fallback choice handled.", { exact: true }).waitFor();
  await assertNoHorizontalOverflow(mobile);
  assert.deepEqual(mobileErrors, []);
  await mobile.close();

  const responses = (await fs.readFile(path.join(directory, "claude-control-responses.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const permission = responses.find((entry) => (
    entry.response?.request_id?.startsWith("browser-permission-")
    && Array.isArray(entry.response?.response?.updatedPermissions)
  ));
  const question = responses.find((entry) => entry.response?.request_id?.startsWith("browser-question-"));
  const dialog = responses.find((entry) => entry.response?.request_id?.startsWith("browser-dialog-"));
  const url = responses.find((entry) => entry.response?.request_id?.startsWith("browser-elicitation-url-"));
  const forms = responses.filter((entry) => entry.response?.request_id?.startsWith("browser-elicitation-form-"));
  const acceptedForm = forms.find((entry) => entry.response?.response?.action === "accept");
  const cancelledForm = forms.find((entry) => entry.response?.response?.action === "cancel");
  const invalidForm = responses.find((entry) => entry.response?.request_id?.startsWith("browser-elicitation-invalid-"));
  assert.equal(permission.response.response.updatedPermissions[0].destination, "session");
  assert.equal(question.response.response.updatedInput.answers["Which layout should Claude use?"], "Balanced");
  assert.deepEqual(dialog.response.response, { behavior: "completed", result: "edit_prompt" });
  assert.deepEqual(url.response.response, { action: "accept" });
  assert.deepEqual(acceptedForm.response.response, {
    action: "accept",
    content: { environment: "production", replicas: 4, alerts: false, note: "Mobile rollout" },
  });
  assert.deepEqual(cancelledForm.response.response, { action: "cancel" });
  assert.deepEqual(invalidForm.response.response, { action: "cancel" });
});

test("plugin center installs a bundled plugin and keeps its password window bounded", { timeout: 30_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#pluginButton").click();
    const pluginDialog = page.locator("#pluginDialog");
    await pluginDialog.waitFor({ state: "visible" });
    await page.locator(".plugin-row", { hasText: "临时 SSH 授权" }).click();
    if (await page.locator("#pluginInstallButton").isVisible()) {
      await page.locator("#pluginInstallButton").click();
      await page.locator("#pluginOpenButton").waitFor({ state: "visible" });
    }
    assert.equal(await page.locator("#pluginInstallButton").isHidden(), true);
    await assertBoundedByViewport(pluginDialog, viewport);
    await page.screenshot({
      path: path.join(screenshots, `plugin-center-${viewport.width}.png`),
      fullPage: true,
    });

    await page.locator("#pluginOpenButton").click();
    const passwordDialog = page.locator("#sshAccessDialog");
    await passwordDialog.waitFor({ state: "visible" });
    assert.equal(await page.locator("#sshPasswordInput").inputValue(), "");
    assert.equal(await page.locator("#sshPasswordInput").getAttribute("type"), "password");
    await assertBoundedByViewport(passwordDialog, viewport);
    await assertNoPairOverlap(page, "#sshAccessDialog .modal-footer button");
    if (viewport.width === 1280) {
      await page.route("**/api/plugins/secure-ssh-access/access", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({ status: 502, contentType: "text/html", body: "<!doctype html><title>Bad gateway</title>" });
      });
      await page.locator("#sshHostInput").fill("server.example.com");
      await page.locator("#sshPasswordInput").fill("browser-only-test-password");
      await page.locator("#sshAuthorizeButton").click();
      await page.locator("#sshAccessError").getByText(/检查 SSH 地址/).waitFor();
      assert.equal(await page.locator("#sshPasswordInput").inputValue(), "");
      await page.unroute("**/api/plugins/secure-ssh-access/access");
    }
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: path.join(screenshots, `ssh-password-dialog-${viewport.width}.png`),
      fullPage: true,
    });
    await page.close();
  }
});

test("Windows Host pairing entry stays usable on desktop and mobile", { timeout: 30_000 }, async () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    page.setDefaultTimeout(8_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#pluginButton").click();
    await page.locator(".plugin-row", { hasText: "Windows Codex Remote" }).click();
    if (await page.locator("#pluginInstallButton").isVisible()) {
      await page.locator("#pluginInstallButton").click();
    }
    await page.locator("#pluginOpenButton").waitFor({ state: "visible" });
    await page.locator("#pluginOpenButton").click();
    const dialog = page.locator("#windowsHostDialog");
    await dialog.waitFor({ state: "visible" });
    const downloadLink = page.locator("#windowsHostDownloadLink");
    await downloadLink.waitFor({ state: "visible" });
    assert.equal(await downloadLink.getAttribute("href"), "/api/windows-host/companion/download");
    assert.match(await downloadLink.getAttribute("download"), /^wfl-windows-host-v0\.1\.0\.zip$/);
    await page.locator("#windowsHostPairButton").click();
    await page.locator("#windowsHostPairCode").waitFor({ state: "visible" });
    assert.match(await page.locator("#windowsHostPairCode code").textContent(), /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/);
    await assertBoundedByViewport(dialog, viewport);
    await assertNoHorizontalOverflow(page);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: path.join(screenshots, `windows-host-pairing-${viewport.width}.png`),
      fullPage: true,
    });
    await page.close();
  }
});

async function assertVerticalStack(page, selectors) {
  const boxes = [];
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box && box.height > 0, `${selector} is empty or hidden`);
    boxes.push({ selector, ...box });
  }
  for (let index = 0; index < boxes.length - 1; index += 1) {
    assert.ok(
      boxes[index].y + boxes[index].height <= boxes[index + 1].y + 1,
      `${boxes[index].selector} overlaps ${boxes[index + 1].selector}`,
    );
  }
}

async function waitForOfficialBrowserFrame(page) {
  const canvas = page.locator("#officialBrowserFrame canvas");
  await page.waitForFunction(() => document.querySelector("#officialBrowserFrame")?.dataset.ready === "true");
  await canvas.waitFor({ state: "visible" });
  assert.equal(await canvas.evaluate((element) => {
    const context = element.getContext("2d");
    if (!context || element.width < 1 || element.height < 1) return false;
    return context.getImageData(Math.min(16, element.width - 1), Math.min(16, element.height - 1), 1, 1).data[3] > 0;
  }), true);
}

async function assertContainedBy(page, childSelector, parentSelector) {
  const child = await page.locator(childSelector).boundingBox();
  const parent = await page.locator(parentSelector).boundingBox();
  assert.ok(child && parent, `${childSelector} or ${parentSelector} is hidden`);
  const detail = JSON.stringify({ childSelector, parentSelector, child, parent });
  assert.ok(child.x >= parent.x && child.y >= parent.y, detail);
  assert.ok(child.x + child.width <= parent.x + parent.width + 1, detail);
  assert.ok(child.y + child.height <= parent.y + parent.height + 1, detail);
}

async function assertOwnerConversationUsage(page) {
  await page.locator("#accountAssignedQuotaSection").waitFor({ state: "visible" });
  assert.equal(await page.locator("#accountAssignedApiName").innerText(), "所有者 · 无套餐限额");
  for (const selector of [
    "#accountFiveHourUsage",
    "#accountSevenDayTokenUsage",
    "#accountMonthlyUsage",
    "#accountFiveHourReset",
    "#accountWeeklyReset",
    "#accountMonthlyReset",
  ]) {
    assert.notEqual((await page.locator(selector).innerText()).trim(), "--", `${selector} was not populated`);
  }
}

async function assertBoundedByViewport(locator, viewport) {
  const box = await locator.boundingBox();
  const detail = JSON.stringify({ box, viewport });
  assert.ok(box && box.width > 0 && box.height > 0, detail);
  assert.ok(box.x >= 0 && box.y >= 0, detail);
  assert.ok(box.x + box.width <= viewport.width + 1, JSON.stringify({ box, viewport }));
  assert.ok(box.y + box.height <= viewport.height + 1, JSON.stringify({ box, viewport }));
}

function assertCompactDrawer(box, viewport) {
  assert.ok(box && box.x >= 0 && box.y >= 0);
  assert.ok(box.width <= 286 && box.width <= viewport.width * 0.3);
  assert.ok(box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
}

async function setPersistentPanes(page, { project, thread }) {
  await page.locator("#settingsButton").click();
  await page.locator("#settingsDialog").waitFor({ state: "visible" });
  await page.locator("#projectPanePersistentInput").setChecked(project, { force: true });
  await page.locator("#threadPanePersistentInput").setChecked(thread, { force: true });
  await page.locator("#saveSettingsButton").click();
  await page.waitForFunction(() => (
    !document.querySelector("#settingsDialog")?.open
    || document.querySelector("#settingsError")?.textContent.trim()
  ));
  assert.equal((await page.locator("#settingsError").textContent()).trim(), "");
  await page.waitForTimeout(600);
}

async function assertPersistentLayout(page, viewport, { project, thread, stacked = false }) {
  const projectBox = await page.locator("#projectPane").boundingBox();
  const threadBox = await page.locator("#threadPane").boundingBox();
  const chatBox = await page.locator(".chat-pane").boundingBox();
  const className = await page.locator("#desktop").getAttribute("class");
  const detail = JSON.stringify({ className, projectBox, threadBox, chatBox });
  if (project) assert.ok(projectBox && Math.abs(projectBox.width - project) <= 1 && projectBox.x >= 0, detail);
  else assert.ok(projectBox && projectBox.x + projectBox.width <= 1, detail);
  if (thread) assert.ok(threadBox && Math.abs(threadBox.width - thread) <= 1 && threadBox.x >= (stacked ? 0 : project), detail);
  else assert.ok(threadBox && threadBox.x + threadBox.width <= 1, detail);
  if (stacked) {
    assert.ok(projectBox && threadBox && Math.abs(projectBox.x - threadBox.x) <= 1, detail);
    assert.ok(projectBox && threadBox && Math.abs(projectBox.y + projectBox.height - threadBox.y) <= 1, detail);
  }
  const sidebarWidth = stacked ? Math.max(project, thread) : project + thread;
  assert.ok(chatBox && Math.abs(chatBox.x - sidebarWidth) <= 1, detail);
  assert.ok(chatBox && Math.abs(chatBox.width - (viewport.width - sidebarWidth)) <= 1, detail);
}

async function loadEarlierTurnsUntil(page, target, maxPages = 8) {
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    if (await target.count()) return;
    const button = page.locator(".history-toggle").first();
    await button.waitFor();
    if (await button.getAttribute("data-state") === "complete") break;
    await button.click();
    await page.waitForFunction(() => (
      document.querySelector(".history-toggle")?.dataset.state !== "loading"
    ));
  }
  await target.waitFor();
}

async function waitForCodexConnection(page) {
  await page.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex 已连接");
}

async function assertNoPairOverlap(page, selector) {
  const boxes = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  );
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const overlapWidth = Math.min(boxes[left].right, boxes[right].right) - Math.max(boxes[left].left, boxes[right].left);
      const overlapHeight = Math.min(boxes[left].bottom, boxes[right].bottom) - Math.max(boxes[left].top, boxes[right].top);
      assert.ok(overlapWidth <= 1 || overlapHeight <= 1, `menu controls ${left} and ${right} overlap`);
    }
  }
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth + 1, JSON.stringify(dimensions));
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

function fakeOfficialAuth() {
  const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const account = {
    chatgpt_account_id: "browser-account",
    chatgpt_user_id: "browser-user",
    chatgpt_plan_type: "plus",
  };
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: token({
        iss: "https://auth.openai.com",
        exp: 2_000_000_000,
        sub: "browser-user",
        email: "browser@example.test",
        "https://api.openai.com/auth": account,
      }),
      access_token: token({
        iss: "https://auth.openai.com",
        exp: 2_000_000_000,
        sub: "browser-user",
        "https://api.openai.com/auth": account,
      }),
      refresh_token: "browser-refresh-token",
    },
  };
}

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8000);
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
      // The bridge can still be initializing immediately after the HTTP server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The fake Codex bridge did not pass the deep readiness probe");
}
