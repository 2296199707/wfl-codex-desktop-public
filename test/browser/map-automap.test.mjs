import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createAuthRecord, writeAuth } from "../../lib/auth.mjs";

const TILE_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQAgMAAAAKbpXKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAJUExURVjJguCzS////z0BPQEAAAABYktHRAJmC3xkAAAAB3RJTUUH6ggJDQgI+KkHZgAAABBjYU52AAAAEAAAABAAAAAAAAAAAEvxwwcAAAARSURBVAjXY2AAglAgYBgcDADQWxVBziqxsQAAAABJRU5ErkJggg==",
  "base64",
);

test("previews, applies, undoes, redoes, and saves project-scoped Tiled Automapping", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-automap-"));
  const projectRoot = path.join(root, "projects");
  const projectPath = path.join(projectRoot, "game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const multiUserRoot = path.join(root, "users");
  const codexHome = path.join(root, "codex-home");
  const authFile = path.join(root, "auth.json");
  const username = "codex";
  const password = "map-automap-browser-password";
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pageErrors = [];
  let server;
  let browser;

  t.after(async () => {
    await browser?.close().catch(() => {});
    server?.kill("SIGTERM");
    await fs.rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    fs.mkdir(path.join(projectPath, "maps"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "automapping"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "tiles"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "images"), { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(multiUserRoot, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  const tileset = {
    columns: 2,
    image: "../images/terrain.png",
    imageheight: 16,
    imagewidth: 32,
    margin: 0,
    name: "Terrain",
    spacing: 0,
    tilecount: 2,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
  await Promise.all([
    fs.writeFile(path.join(projectPath, "VERSION"), "0.43.27-beta\n"),
    fs.writeFile(path.join(projectPath, "CHANGELOG.md"), "# Automap test\n"),
    fs.writeFile(path.join(projectPath, "game.tiled-project"), `${JSON.stringify({
      automappingRulesFile: "automapping/rules.txt",
      compatibilityVersion: "1.12",
      folders: ["maps", "automapping", "tiles", "images"],
      propertyTypes: [],
    }, null, 2)}\n`),
    fs.writeFile(path.join(projectPath, "tiles", "terrain.tsj"), `${JSON.stringify(tileset, null, 2)}\n`),
    fs.writeFile(path.join(projectPath, "images", "terrain.png"), TILE_IMAGE),
    fs.writeFile(path.join(projectPath, "automapping", "rules.txt"), "basic.tmj\n"),
    fs.writeFile(path.join(projectPath, "automapping", "basic.tmj"), `${JSON.stringify(ruleMap(), null, 2)}\n`),
    fs.writeFile(path.join(projectPath, "maps", "world.tmj"), `${JSON.stringify(targetMap(), null, 2)}\n`),
  ]);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(new URL("../..", import.meta.url).pathname),
    env: {
      ...process.env,
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
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(server, "WFL Codex Desktop v");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username, password } });
  const main = await context.newPage();
  main.on("pageerror", (error) => pageErrors.push(`main: ${error.message}`));
  await main.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await main.locator("#mapWorkspaceButton:not([disabled])").waitFor({ timeout: 20_000 });
  await main.locator("#mapWorkspaceButton").click();
  await main.locator("#mapWorkspaceDialog[open]").waitFor();
  await main.locator('.map-workspace-resource-row[data-kind="project"]').click();
  await main.waitForFunction(() => document.querySelector("#mapWorkspaceProjectMeta")?.textContent?.includes("game.tiled-project"));
  await main.locator('.map-workspace-resource-row[data-kind="directory"]', { hasText: "maps" }).click();
  const popupPromise = context.waitForEvent("page");
  await main.locator(".map-workspace-map-row", { hasText: "world.tmj" }).click();
  const editor = await popupPromise;
  editor.on("pageerror", (error) => pageErrors.push(`editor: ${error.message}`));
  try {
    await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await editor.evaluate(() => ({
      state: document.querySelector("#mapApp")?.dataset.state,
      title: document.querySelector("#loadTitle")?.textContent,
      detail: document.querySelector("#loadDetail")?.textContent,
      body: document.body.innerText.slice(0, 1500),
    })).catch(() => ({ url: editor.url() }));
    throw new Error(`地图窗口未就绪：${JSON.stringify(diagnostic)}；页面错误：${pageErrors.join(" | ")}`, { cause: error });
  }

  assert.equal(await editor.locator("#autoMapButton").isEnabled(), true);
  const before = await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8");
  await editor.locator("#autoMapButton").click();
  await editor.locator("#autoMapDialog[open]").waitFor();
  await editor.waitForFunction(() => document.querySelector("#autoMapState")?.textContent?.includes("已加载"));
  assert.equal(await editor.locator("#autoMapRulesPath").textContent(), "automapping/rules.txt");
  assert.match(await editor.locator("#autoMapRulesOrigin").textContent(), /\.tiled-project/u);
  await editor.locator("#autoMapSeed").fill("42");
  await editor.locator("#previewAutoMapButton").click();
  await editor.locator("#autoMapPreview:not([hidden])").waitFor();
  assert.equal(await editor.locator("#autoMapPreviewSummary").textContent(), "将修改 1 个格子");
  assert.equal(await editor.locator("#documentState").textContent(), "已保存");
  assert.equal(await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8"), before);
  assert.equal(await editor.locator("#applyAutoMapButton").isEnabled(), true);
  const historyBefore = Number(await editor.locator("#undoButton").getAttribute("data-history-depth"));
  await editor.locator("#applyAutoMapButton").click();
  await editor.waitForFunction(() => document.querySelector("#autoMapState")?.textContent?.includes("尚未保存"));
  assert.equal(await editor.locator("#documentState").textContent(), "未保存");
  assert.equal(Number(await editor.locator("#undoButton").getAttribute("data-history-depth")), historyBefore + 1);
  await editor.locator("#closeAutoMapDialogButton").click();
  await editor.locator("#undoButton").click();
  assert.equal(await editor.locator("#documentState").textContent(), "已保存");
  await editor.locator("#redoButton").click();
  assert.equal(await editor.locator("#documentState").textContent(), "未保存");
  await editor.locator("#saveButton").click();
  await editor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, { timeout: 20_000 });
  const saved = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8"));
  assert.deepEqual(saved.layers.find((layer) => layer.name === "Decor").data, [101, 0, 0]);
  assert.equal(saved.tilesets[0].firstgid, 100);
  assert.equal(saved.tilesets.length, 1);
  await editor.reload({ waitUntil: "domcontentloaded" });
  await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, { timeout: 30_000 });
  await editor.locator("#autoMapButton").click();
  await editor.waitForFunction(() => document.querySelector("#autoMapState")?.textContent?.includes("已加载"));
  assert.equal(await editor.locator("#autoMapWhileDrawing").isChecked(), false);
  await editor.locator("#autoMapWhileDrawing").check();
  await editor.waitForFunction(() => document.querySelector("#autoMapState")?.textContent?.includes("已开启"));
  await editor.locator("#closeAutoMapDialogButton").click();
  await editor.locator('.layer-row[data-layer-id="1"] .layer-name').click();
  await editor.locator(".tile-swatch").first().click();
  await editor.locator("#brushToolButton").click();
  const canvas = await editor.locator("canvas.map-canvas").boundingBox();
  assert.ok(canvas);
  const zoom = Number.parseFloat(await editor.locator("#zoomLabel").textContent()) / 100;
  const mapWidth = 3 * 16 * zoom;
  const mapHeight = 16 * zoom;
  await editor.mouse.click(
    canvas.x + (canvas.width - mapWidth) / 2 + (2.5 * 16 * zoom),
    canvas.y + (canvas.height - mapHeight) / 2 + (0.5 * 16 * zoom),
  );
  await editor.waitForFunction(() => (
    document.querySelector("#undoButton")?.dataset.historyDepth === "1"
    && document.querySelector("#undoButton")?.title?.includes("AutoMap")
    && !document.querySelector("#documentState")?.textContent?.includes("正在计算")
  ), null, { timeout: 20_000 });
  assert.match(await editor.locator("#undoButton").getAttribute("title"), /AutoMap/u);
  assert.equal(await editor.locator("#documentState").textContent(), "未保存");
  await editor.locator("#undoButton").click();
  assert.equal(await editor.locator("#documentState").textContent(), "已保存");
  await editor.locator("#redoButton").click();
  assert.equal(await editor.locator("#documentState").textContent(), "未保存");
  await editor.locator("#saveButton").click();
  await editor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, { timeout: 20_000 });
  const whileDrawingSaved = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8"));
  assert.deepEqual(whileDrawingSaved.layers.find((layer) => layer.name === "Ground").data, [100, 0, 100]);
  assert.deepEqual(whileDrawingSaved.layers.find((layer) => layer.name === "Decor").data, [101, 0, 101]);
  await editor.setViewportSize({ width: 390, height: 720 });
  await editor.locator("#autoMapButton").click();
  await editor.waitForFunction(() => document.querySelector("#autoMapState")?.textContent?.includes("已加载"));
  const mobileLayout = await editor.locator("#autoMapDialog").evaluate((dialog) => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    dialogBottom: dialog.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
    actionHeights: [...dialog.querySelectorAll(".automap-actions button")].map((button) => button.getBoundingClientRect().height),
  }));
  assert.equal(mobileLayout.scrollWidth, mobileLayout.viewportWidth);
  assert.ok(mobileLayout.dialogBottom <= mobileLayout.viewportHeight + 1, JSON.stringify(mobileLayout));
  assert.ok(mobileLayout.actionHeights.every((height) => height >= 44), JSON.stringify(mobileLayout));
  await editor.locator("#closeAutoMapDialogButton").click();
  assert.deepEqual(pageErrors, []);
});

function ruleMap() {
  return {
    height: 1,
    infinite: false,
    layers: [
      { data: [1], height: 1, id: 1, name: "input_Ground", type: "tilelayer", width: 1, x: 0, y: 0 },
      { data: [2], height: 1, id: 2, name: "output_Decor", type: "tilelayer", width: 1, x: 0, y: 0 },
    ],
    nextlayerid: 3,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 1,
  };
}

function targetMap() {
  return {
    height: 1,
    infinite: false,
    layers: [
      { data: [100, 0, 0], height: 1, id: 1, name: "Ground", type: "tilelayer", width: 3, x: 0, y: 0 },
      { data: [0, 0, 0], height: 1, id: 2, name: "Decor", type: "tilelayer", width: 3, x: 0, y: 0 },
    ],
    nextlayerid: 3,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [{ firstgid: 100, source: "../tiles/terrain.tsj" }],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 3,
  };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(child, marker) {
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server startup timed out\n${output}`)), 15_000);
    const append = (chunk) => {
      output += chunk.toString();
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited with ${code}\n${output}`));
    });
  });
}
