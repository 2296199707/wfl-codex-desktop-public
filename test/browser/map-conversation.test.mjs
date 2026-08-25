import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { ProviderStore } from "../../lib/provider-store.mjs";

const repository = path.resolve(new URL("../..", import.meta.url).pathname);
const fakeCodex = path.join(repository, "test", "fixtures", "fake-codex-app-server.mjs");

test("map editor mirrors and sends through the authoritative same-project Codex thread", { timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-conversation-browser-"));
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const homeDirectory = path.join(root, "home");
  const codexHome = path.join(homeDirectory, ".codex");
  const fakeBin = path.join(root, "bin");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  let browser;

  t.after(async () => {
    await browser?.close().catch(() => {});
    server?.kill("SIGTERM");
    await fs.rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    fs.mkdir(path.join(project, "maps"), { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(project, "game.tiled-project"), `${JSON.stringify({ folders: ["maps"] }, null, 2)}\n`),
    fs.writeFile(path.join(project, "maps/scene.tmj"), `${JSON.stringify({
      type: "map",
      version: "1.12",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      renderorder: "right-down",
      infinite: false,
      width: 8,
      height: 8,
      tilewidth: 16,
      tileheight: 16,
      nextlayerid: 2,
      nextobjectid: 1,
      layers: [{
        id: 1,
        name: "Ground",
        type: "tilelayer",
        width: 8,
        height: 8,
        data: new Array(64).fill(0),
      }],
      tilesets: [],
    }, null, 2)}\n`),
    fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(fakeOfficialAuth()), { mode: 0o600 }),
    fs.writeFile(
      path.join(fakeBin, "codex"),
      `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`,
      { mode: 0o755 },
    ),
  ]);
  const providerStore = await new ProviderStore(stateDirectory).initialize();
  await providerStore.create({
    name: "Map conversation browser provider",
    baseUrl: "https://map-conversation-provider.example.test/v1",
    model: "gpt-smoke",
    apiKey: "map-conversation-browser-secret",
  });

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: homeDirectory,
      CODEX_HOME: codexHome,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: project,
      CODEX_DESKTOP_AUTH_FILE: path.join(root, "missing-auth.json"),
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: repository,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_RESCUE_SLOT: "",
      CODEX_DESKTOP_RESCUE_SESSION_DIR: "",
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      FAKE_CODEX_PROJECT: project,
      NODE_ENV: "test",
      CODEX_DESKTOP_OFFICIAL_BROWSER_TEST_MODE: "1",
      CODEX_DESKTOP_OFFICIAL_PROXY_TEST_MODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(server, "WFL Codex Desktop v");
  await waitForDeepReady(baseUrl);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const main = await context.newPage();
  const pageErrors = [];
  main.on("pageerror", (error) => pageErrors.push(`main: ${error.message}`));
  await main.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await main.waitForFunction(() => document.getElementById("connectionText")?.textContent === "Codex 已连接");
  await main.locator("#panelsButton").click();
  await main.locator(".thread-row", { hasText: "Browser recovery smoke test" }).first().click();
  await main.locator("#threadTitleInput").waitFor();
  assert.equal(await main.locator("#threadTitleInput").inputValue(), "Browser recovery smoke test");
  const initialThreadCount = await main.locator(".thread-row").count();

  await main.locator("#mapWorkspaceButton:not([disabled])").click();
  await main.locator("#mapWorkspaceDialog[open]").waitFor();
  const projectFile = main.locator('.map-workspace-resource-row[data-kind="project"]');
  await projectFile.waitFor({ timeout: 20_000 });
  await projectFile.click();
  await main.waitForFunction(() => (
    document.querySelector("#mapWorkspaceProjectMeta")?.textContent?.includes("game.tiled-project")
  ));
  const mapsDirectory = main.locator('.map-workspace-resource-row[data-kind="directory"]', { hasText: "maps" });
  await mapsDirectory.waitFor({ timeout: 20_000 });
  await mapsDirectory.click();
  const mapRow = main.locator(".map-workspace-map-row", { hasText: "maps/scene.tmj" });
  await mapRow.waitFor();
  const popup = main.waitForEvent("popup");
  await mapRow.click();
  const editor = await popup;
  editor.on("pageerror", (error) => pageErrors.push(`editor: ${error.message}`));
  await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  await editor.waitForFunction(() => [...document.querySelectorAll("#conversationThreadSelect option")]
    .some((option) => option.textContent?.includes("Browser recovery smoke test")));
  assert.match(await editor.locator("#conversationMessageList").innerText(), /authoritative conversation was restored/iu);
  assert.equal(await editor.locator("#conversationThreadSelect").inputValue(), "thread_smoke_001");

  const message = "finish concurrent task";
  await editor.locator("#conversationInput:not([disabled])").fill(message);
  await editor.locator("#sendConversationButton:not([disabled])").click();
  await editor.locator(".conversation-message", { hasText: message }).last().waitFor({ timeout: 15_000 }).catch(async (error) => {
    const [editorState, mainState] = await Promise.all([
      editor.evaluate(() => ({
        sendState: document.querySelector("#conversationSendState")?.textContent,
        input: document.querySelector("#conversationInput")?.value,
        inputDisabled: document.querySelector("#conversationInput")?.disabled,
        messages: document.querySelector("#conversationMessageList")?.textContent,
      })),
      main.evaluate(() => ({
        activeThread: document.querySelector(".thread-row.active .thread-row-title")?.textContent,
        prompt: document.querySelector("#promptInput")?.value,
        messages: document.querySelector("#messageList")?.textContent?.slice(-2_000),
      })),
    ]);
    throw new Error(`${error.message}\n${JSON.stringify({ editorState, mainState, pageErrors })}`);
  });
  await editor.locator(".conversation-message", { hasText: "The independent concurrent task completed." }).waitFor({
    timeout: 15_000,
  });
  await main.locator(".message.user", { hasText: message }).last().waitFor();
  await main.locator(".message.agent", { hasText: "The independent concurrent task completed." }).waitFor();
  assert.equal(await main.locator(".thread-row").count(), initialThreadCount);

  await editor.locator("#conversationThreadSelect").selectOption("thread_smoke_parallel");
  await editor.waitForFunction(() => document.querySelector("#conversationThreadSelect")?.value === "thread_smoke_parallel");
  await main.waitForFunction(() => document.querySelector(".thread-row.active .thread-row-title")?.textContent === "Parallel subagent isolation test");
  assert.match(await editor.locator("#conversationMessageList").innerText(), /Does this thread stay isolated/iu);
  assert.equal(await editor.evaluate(() => (
    JSON.parse(sessionStorage.getItem("wfl-map-editor-session-v1") || "null")?.threadId
  )), "thread_smoke_parallel");
  await editor.reload({ waitUntil: "domcontentloaded" });
  await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  await editor.waitForFunction(() => (
    document.querySelector("#conversationThreadSelect")?.value === "thread_smoke_parallel"
  ));
  assert.match(await editor.locator("#conversationMessageList").innerText(), /Does this thread stay isolated/iu);
  assert.equal(await editor.locator("#gameWorkModeToggle").isChecked(), false);
  await editor.setViewportSize({ width: 390, height: 720 });
  const mobileLayout = await editor.evaluate(() => {
    const bounds = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const panel = bounds("#collaborationPanel");
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      panel: panel && { left: panel.left, right: panel.right, width: panel.width },
      tabHeight: bounds("#conversationTabButton")?.height,
      selectHeight: bounds("#conversationThreadSelect")?.height,
      refreshHeight: bounds("#refreshConversationButton")?.height,
      sendHeight: bounds("#sendConversationButton")?.height,
    };
  });
  assert.ok(mobileLayout.panel);
  assert.ok(Math.abs(mobileLayout.panel.left) < 1 && Math.abs(mobileLayout.panel.right - 390) < 1);
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth);
  assert.ok(mobileLayout.tabHeight >= 44);
  assert.ok(mobileLayout.selectHeight >= 40);
  assert.ok(mobileLayout.refreshHeight >= 40);
  assert.ok(mobileLayout.sendHeight >= 40);
  await editor.setViewportSize({ width: 390, height: 520 });
  await editor.locator("#conversationInput").focus();
  assert.ok(await editor.evaluate(() => (
    document.querySelector("#conversationComposer")?.getBoundingClientRect().bottom <= innerHeight + 1
  )));
  assert.deepEqual(pageErrors, []);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function fakeOfficialAuth() {
  const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const claims = {
    iss: "https://auth.openai.com",
    exp: 2_000_000_000,
    sub: "browser-user",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "browser-account",
      chatgpt_user_id: "browser-user",
      chatgpt_plan_type: "plus",
    },
  };
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: token(claims),
      access_token: token(claims),
      refresh_token: "browser-refresh-token",
    },
  };
}

function waitForOutput(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/internal/codex-ready`);
      const data = await response.json();
      if (response.ok && data.codexReady === true && data.threadListReady === true) return;
    } catch {
      // The bridge can still be initializing.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The fake Codex bridge did not pass the readiness probe");
}
