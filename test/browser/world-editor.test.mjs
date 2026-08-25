import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createAuthRecord, writeAuth } from "../../lib/auth.mjs";

test("renders, switches, validates, saves, and releases a multi-map World", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-world-editor-browser-"));
  const projectRoot = path.join(root, "projects");
  const projectPath = path.join(projectRoot, "game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const multiUserRoot = path.join(root, "users");
  const codexHome = path.join(root, "codex-home");
  const authFile = path.join(root, "auth.json");
  const worldPath = path.join(projectPath, "worlds", "main.world");
  const username = "codex";
  const password = "world-editor-browser-password";
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pageErrors = [];
  let server;
  let browser;

  t.after(async () => {
    await browser?.close().catch(() => {});
    await stopProcess(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    fs.mkdir(path.join(projectPath, "maps"), { recursive: true }),
    fs.mkdir(path.dirname(worldPath), { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(multiUserRoot, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  await Promise.all([
    fs.writeFile(path.join(projectPath, "VERSION"), "0.43.27-beta\n"),
    fs.writeFile(path.join(projectPath, "CHANGELOG.md"), "# World editor browser test\n"),
    fs.writeFile(path.join(projectPath, "maps", "forest.tmj"), mapSource({
      name: "Forest",
      data: [1, 1, 0, 0, 1, 2, 2, 0, 0, 2, 2, 1, 0, 0, 1, 1],
      objects: [{
        id: 1,
        class: "Portal",
        type: "portal",
        name: "ToTown",
        x: 48,
        y: 24,
        width: 16,
        height: 16,
        properties: [
          { name: "targetMap", type: "string", value: "town.tmj" },
          { name: "targetSpawn", type: "string", value: "entry" },
        ],
      }],
    })),
    fs.writeFile(path.join(projectPath, "maps", "town.tmj"), mapSource({
      name: "Town",
      data: [2, 2, 2, 2, 2, 0, 0, 2, 2, 0, 1, 2, 2, 2, 2, 2],
      objects: [{
        id: 1,
        class: "SpawnPoint",
        type: "spawn",
        name: "Entry",
        point: true,
        x: 16,
        y: 32,
        properties: [{ name: "spawnId", type: "string", value: "entry" }],
      }],
    })),
    fs.writeFile(path.join(projectPath, "maps", "remote.tmj"), mapSource({
      name: "Remote",
      data: [3, 0, 3, 0, 0, 3, 0, 3, 3, 0, 3, 0, 0, 3, 0, 3],
      objects: [],
    })),
    fs.writeFile(worldPath, `${JSON.stringify({
      type: "world",
      onlyShowAdjacentMaps: true,
      patterns: [],
      maps: [
        { fileName: "../maps/forest.tmj", x: 0, y: 0, width: 64, height: 64 },
        { fileName: "../maps/town.tmj", x: 64, y: 0, width: 64, height: 64 },
        { fileName: "../maps/remote.tmj", x: 512, y: 0, width: 64, height: 64 },
      ],
    }, null, 2)}\n`),
  ]);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(new URL("../..", import.meta.url).pathname),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: projectPath,
      CODEX_DESKTOP_MULTI_USER_ROOT: multiUserRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      CODEX_DESKTOP_DISABLE_CODEX: "1",
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: projectPath,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_SYSTEMCTL: "/bin/false",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(server, "WFL Codex Desktop v");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username, password } });
  const host = await context.newPage();
  observeErrors(host, pageErrors, "host");
  await host.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const credentials = await createWorldSession(host, projectPath, "worlds/main.world");

  const desktop = await context.newPage();
  observeErrors(desktop, pageErrors, "desktop");
  const deletedMapSessions = [];
  desktop.on("request", (request) => {
    if (request.method() === "DELETE" && /\/api\/maps\/sessions\//u.test(request.url())) {
      deletedMapSessions.push(request.url());
    }
  });
  await desktop.setViewportSize({ width: 1280, height: 800 });
  await openWorldEditor(desktop, baseUrl, projectPath, credentials);
  await waitForPreviewState(desktop, "forest.tmj", "当前地图");
  await waitForPreviewState(desktop, "town.tmj", "轻量预览");
  assert.match(await mapRow(desktop, "remote.tmj").innerText(), /边界/u);
  assert.ok(await nonBackgroundPixelCount(desktop) > 1_000);

  const deletesBeforeSwitch = deletedMapSessions.length;
  const releasedSession = desktop.waitForRequest((request) => (
    request.method() === "DELETE" && /\/api\/maps\/sessions\//u.test(request.url())
  ));
  await mapRow(desktop, "town.tmj").click();
  await waitForPreviewState(desktop, "town.tmj", "当前地图");
  await waitForPreviewState(desktop, "forest.tmj", "轻量预览");
  await releasedSession;
  assert.ok(deletedMapSessions.length > deletesBeforeSwitch, "switching current map must close at least one map session");

  await desktop.locator("#navigationCheckButton:not([disabled])").click();
  await desktop.waitForFunction(() => {
    const state = document.querySelector("#navigationState");
    return state && /1 条有效连接/u.test(state.textContent || "");
  }, null, { timeout: 20_000 });
  assert.match(await desktop.locator("#navigationState").textContent(), /0 个警告/u);
  assert.equal(await desktop.locator(".navigation-diagnostic").count(), 0);

  await desktop.locator("#mapX").fill("96");
  await desktop.locator("#applyBoundsButton").click();
  await desktop.waitForFunction(() => document.querySelector("#documentState")?.textContent === "未保存");
  await desktop.locator("#undoButton").click();
  assert.equal(await desktop.locator("#mapX").inputValue(), "64");
  await desktop.locator("#redoButton").click();
  assert.equal(await desktop.locator("#mapX").inputValue(), "96");
  await desktop.locator("#saveButton").click();
  await desktop.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });
  assert.equal(JSON.parse(await fs.readFile(worldPath, "utf8")).maps[1].x, 96);
  await fs.mkdir("test-results", { recursive: true });
  await desktop.screenshot({ path: "test-results/world-editor-desktop.png" });

  const reopened = await createWorldSession(host, projectPath, "worlds/main.world");
  const mobile = await context.newPage();
  observeErrors(mobile, pageErrors, "mobile");
  await mobile.setViewportSize({ width: 390, height: 844 });
  await openWorldEditor(mobile, baseUrl, projectPath, reopened);
  await waitForPreviewState(mobile, "forest.tmj", "当前地图");
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const canvasBounds = await mobile.locator("#worldCanvas").boundingBox();
  const mobileLayout = await mobile.evaluate(() => Object.fromEntries([
    ["inner", { width: innerWidth, height: innerHeight }],
    ...["worldApp", "worldStage", "worldCanvas"].map((id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      return [id, {
        x: rect.x,
        width: rect.width,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        minWidth: getComputedStyle(element).minWidth,
        widthStyle: getComputedStyle(element).width,
      }];
    }),
  ]));
  assert.ok(
    canvasBounds && canvasBounds.x >= -1 && canvasBounds.x + canvasBounds.width <= 391,
    JSON.stringify({ canvasBounds, mobileLayout }),
  );
  assert.ok(await nonBackgroundPixelCount(mobile) > 500);
  await mobile.locator("#inspectorPanelButton").click();
  const inspectorBounds = await mobile.locator(".world-inspector").boundingBox();
  assert.ok(inspectorBounds && inspectorBounds.x >= -1 && inspectorBounds.x + inspectorBounds.width <= 391);
  await mobile.locator("#mapsPanelButton").click();
  const mapPanelBounds = await mobile.locator(".world-map-panel").boundingBox();
  assert.ok(mapPanelBounds && mapPanelBounds.x >= -1 && mapPanelBounds.x + mapPanelBounds.width <= 391);
  await mobile.screenshot({ path: "test-results/world-editor-mobile.png" });

  assert.deepEqual(pageErrors, []);
});

async function createWorldSession(page, projectPath, relativePath) {
  return page.evaluate(async ({ projectPath: project, relativePath: worldPath }) => {
    const projectResponse = await fetch("/api/map-projects/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-project-session-open",
      },
      body: JSON.stringify({ project }),
    });
    const projectData = await projectResponse.json();
    if (!projectResponse.ok) throw new Error(projectData.error || "project open failed");
    const editorInstanceId = crypto.randomUUID();
    const worldResponse = await fetch("/api/map-worlds/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-world-session-open",
      },
      body: JSON.stringify({
        projectSessionId: projectData.session.id,
        path: worldPath,
        editorInstanceId,
      }),
    });
    const worldData = await worldResponse.json();
    if (!worldResponse.ok) throw new Error(worldData.error || "World open failed");
    return { sessionId: worldData.session.id, editorInstanceId };
  }, { projectPath, relativePath });
}

async function openWorldEditor(page, baseUrl, projectPath, credentials) {
  const accountResponse = await page.request.get(`${baseUrl}/api/account?summary=1`, {
    headers: { "Cache-Control": "no-store" },
  });
  const accountData = await accountResponse.json();
  if (!accountResponse.ok() || !accountData.user?.id) {
    throw new Error(accountData.error || "account read failed");
  }
  const fragment = new URLSearchParams({
    session: credentials.sessionId,
    editor: credentials.editorInstanceId,
    project: projectPath,
    account: accountData.user.id,
  });
  await page.goto(`${baseUrl}/world-editor.html#${fragment}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#worldApp")?.dataset.state === "ready", null, {
    timeout: 20_000,
  });
}

function mapRow(page, name) {
  return page.locator(".world-map-row", { hasText: name });
}

async function waitForPreviewState(page, name, label) {
  await page.waitForFunction(({ name: mapName, label: status }) => {
    return [...document.querySelectorAll(".world-map-row")].some((row) => (
      row.textContent?.includes(mapName) && row.textContent?.includes(status)
    ));
  }, { name, label }, { timeout: 20_000 });
}

async function nonBackgroundPixelCount(page) {
  return page.locator("#worldCanvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let changed = 0;
    for (let index = 0; index < data.length; index += 16) {
      if (data[index] !== 16 || data[index + 1] !== 20 || data[index + 2] !== 21) changed += 1;
    }
    return changed;
  });
}

function mapSource({ name, data, objects }) {
  return `${JSON.stringify({
    type: "map",
    version: "1.12",
    tiledversion: "1.12.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 4,
    height: 4,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 3,
    nextobjectid: Math.max(1, ...objects.map((object) => object.id + 1)),
    backgroundcolor: name === "Forest" ? "#173924" : name === "Town" ? "#3a3346" : "#25333b",
    layers: [
      { id: 1, name, type: "tilelayer", width: 4, height: 4, data },
      { id: 2, name: "Gameplay", type: "objectgroup", objects, draworder: "topdown" },
    ],
    tilesets: [],
  }, null, 2)}\n`;
}

function observeErrors(page, errors, label) {
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: console ${message.text()}`);
  });
}

async function getFreePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function waitForServer(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15_000);
    const append = (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      resolve();
    };
    processHandle.stdout.on("data", append);
    processHandle.stderr.on("data", append);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before readiness (${code ?? signal}): ${output}`));
    });
  });
}

function stopProcess(processHandle) {
  return new Promise((resolve) => {
    if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      resolve();
    }, 5_000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    processHandle.kill("SIGTERM");
  });
}
