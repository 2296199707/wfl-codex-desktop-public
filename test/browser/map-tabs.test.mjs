import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createAuthRecord, writeAuth } from "../../lib/auth.mjs";

test("keeps project map tabs synchronized across independent editor windows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-tabs-"));
  const projectRoot = path.join(root, "projects");
  const projectPath = path.join(projectRoot, "game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const multiUserRoot = path.join(root, "users");
  const codexHome = path.join(root, "codex-home");
  const authFile = path.join(root, "auth.json");
  const username = "codex";
  const password = "map-tabs-browser-password";
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
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(multiUserRoot, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  await Promise.all([
    fs.writeFile(path.join(projectPath, "VERSION"), "0.43.27-beta\n"),
    fs.writeFile(path.join(projectPath, "CHANGELOG.md"), "# Map tabs test\n"),
    fs.writeFile(path.join(projectPath, "game.tiled-project"), `${JSON.stringify({
      compatibilityVersion: "1.12",
      folders: ["maps"],
      propertyTypes: [],
    })}\n`),
    writeMap(path.join(projectPath, "maps", "world.tmj"), "World"),
    writeMap(path.join(projectPath, "maps", "dungeon.tmj"), "Dungeon"),
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
  await main.setViewportSize({ width: 1280, height: 800 });
  await openMapWorkspace(main, baseUrl);

  const world = await openMap(main, context, "world.tmj", pageErrors);
  await openMapWorkspace(main, baseUrl);
  const dungeon = await openMap(main, context, "dungeon.tmj", pageErrors);

  await assertTabSet(world, ["dungeon.tmj", "world.tmj"]);
  await assertTabSet(dungeon, ["dungeon.tmj", "world.tmj"]);
  await fs.mkdir("test-results", { recursive: true });
  await dungeon.screenshot({ path: "test-results/map-tabs-two-windows.png" });

  await world.locator("#addTileLayerButton:not([disabled])").click();
  await dungeon.locator('.map-document-tab:has-text("world.tmj")[data-dirty="true"]').waitFor();

  await dungeon.locator('.map-document-tab:has-text("world.tmj") .map-document-tab-name').click();
  await dungeon.locator('.map-document-tab:has-text("world.tmj")[data-active="true"]').waitFor();

  await dungeon.locator('.map-document-tab:has-text("world.tmj") .map-document-tab-close').click();
  await world.locator("#mapCloseDialog[open]").waitFor();
  assert.equal(await world.locator("#cancelMapCloseButton").isVisible(), true);
  assert.equal(await world.locator("#discardMapCloseButton").isVisible(), true);
  assert.equal(await world.locator("#saveMapCloseButton").isVisible(), true);
  await world.screenshot({ path: "test-results/map-tabs-dirty-close.png" });
  await world.locator("#cancelMapCloseButton").click();
  assert.equal(await world.locator("#mapCloseDialog").isHidden(), true);

  await dungeon.bringToFront();
  await dungeon.locator('.map-document-tab:has-text("world.tmj") .map-document-tab-close').click();
  await world.locator("#mapCloseDialog[open]").waitFor();
  const worldClosed = world.waitForEvent("close");
  await world.locator("#discardMapCloseButton").click();
  await worldClosed;
  await dungeon.locator('.map-document-tab:has-text("world.tmj")').waitFor({ state: "detached" });

  await dungeon.locator("#mapDocumentTabAddButton").click();
  await dungeon.locator("#mapFileDialog[open]").waitFor();
  await dungeon.locator('.map-file-entry:has-text("world.tmj")').waitFor();
  await dungeon.locator("#cancelMapFileButton").click();
  await openMapWorkspace(main, baseUrl);
  await main.locator("#mapWorkspaceDialog[open]").waitFor();
  await main.waitForFunction(() => document.querySelector("#mapWorkspaceProjectMeta")?.textContent?.includes("game.tiled-project"));
  const recentWorld = main.locator('.map-workspace-tab[data-open="false"]', { hasText: "world.tmj" });
  await recentWorld.waitFor();
  const reopenedPromise = context.waitForEvent("page");
  await recentWorld.locator(".map-workspace-tab-main").click();
  const reopened = await reopenedPromise;
  reopened.on("pageerror", (error) => pageErrors.push(`reopened: ${error.message}`));
  await reopened.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  await assertTabSet(reopened, ["dungeon.tmj", "world.tmj"]);
  await reopened.locator("#zoomInButton").click();
  await reopened.locator("#gridButton").click();
  await reopened.locator("#handToolButton").click();
  await reopened.evaluate(() => document.querySelector("#layersButton")?.click());
  await reopened.waitForTimeout(350);
  const storedView = await reopened.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => (
      entry.startsWith("wfl-map-editor-view-v1:") && entry.endsWith(encodeURIComponent("maps/world.tmj"))
    ));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  assert.ok(storedView);
  assert.equal(storedView.gridVisible, false);
  assert.equal(storedView.activeTool, "hand");
  assert.equal(storedView.layerPanelOpen, true);
  await reopened.reload({ waitUntil: "domcontentloaded" });
  await reopened.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  const restoredView = await reopened.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => (
      entry.startsWith("wfl-map-editor-view-v1:") && entry.endsWith(encodeURIComponent("maps/world.tmj"))
    ));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  assert.ok(Math.abs(restoredView.scale - storedView.scale) < 0.0001);
  assert.ok(Math.abs(restoredView.offsetX - storedView.offsetX) < 0.0001);
  assert.ok(Math.abs(restoredView.offsetY - storedView.offsetY) < 0.0001);
  assert.equal(await reopened.locator("#gridButton").getAttribute("aria-pressed"), "false");
  assert.equal(await reopened.locator("#handToolButton").getAttribute("aria-pressed"), "true");
  assert.equal(await reopened.locator("#mapApp").getAttribute("data-layers-open"), "true");
  assert.deepEqual(pageErrors, []);
});

async function writeMap(filePath, layerName) {
  await fs.writeFile(filePath, `${JSON.stringify({
    height: 2,
    infinite: false,
    layers: [{ data: [0, 0, 0, 0], height: 2, id: 1, name: layerName, type: "tilelayer", width: 2 }],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  }, null, 2)}\n`);
}

async function openMapWorkspace(page, baseUrl) {
  if (page.url() === "about:blank") await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (!await page.locator("#mapWorkspaceDialog").evaluate((dialog) => dialog.open)) {
    await page.locator("#mapWorkspaceButton:not([disabled])").waitFor({ timeout: 20_000 });
    await page.locator("#mapWorkspaceButton").click();
  }
  await page.locator("#mapWorkspaceDialog[open]").waitFor();
  const projectFile = page.locator('.map-workspace-resource-row[data-kind="project"]');
  await projectFile.waitFor({ timeout: 20_000 });
  if (!await page.locator("#mapWorkspaceProjectMeta").textContent().then((text) => text?.includes("game.tiled-project") === true)) {
    await projectFile.click();
  }
  await page.waitForFunction(() => document.querySelector("#mapWorkspaceProjectMeta")?.textContent?.includes("game.tiled-project"));
  const mapsDirectory = page.locator('.map-workspace-resource-row[data-kind="directory"]', { hasText: "maps" });
  await mapsDirectory.waitFor({ timeout: 20_000 });
  if (await page.locator(".map-workspace-map-row").count() === 0) await mapsDirectory.click();
  await page.locator(".map-workspace-map-row").first().waitFor({ timeout: 20_000 });
}

async function openMap(main, context, name, pageErrors) {
  const popupPromise = context.waitForEvent("page");
  await main.locator(".map-workspace-map-row", { hasText: name }).click();
  const editor = await popupPromise;
  editor.on("pageerror", (error) => pageErrors.push(`${name}: ${error.message}`));
  await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  return editor;
}

async function assertTabSet(page, expected) {
  await page.waitForFunction((count) => document.querySelectorAll(".map-document-tab").length === count, expected.length);
  const names = await page.locator(".map-document-tab-name").allTextContents();
  assert.deepEqual(names.sort(), [...expected].sort());
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
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
