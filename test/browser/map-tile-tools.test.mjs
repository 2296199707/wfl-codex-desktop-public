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

test("uses multi-cell stamps, sampling, and tile shapes on desktop and mobile", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-tile-tools-"));
  const projectRoot = path.join(root, "projects");
  const projectPath = path.join(projectRoot, "game");
  const mapPath = path.join(projectPath, "maps", "world.tmj");
  const targetMapPath = path.join(projectPath, "maps", "target.tmj");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const multiUserRoot = path.join(root, "users");
  const codexHome = path.join(root, "codex-home");
  const authFile = path.join(root, "auth.json");
  const username = "codex";
  const password = "map-tile-tools-password";
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  let browser;

  t.after(async () => {
    await browser?.close().catch(() => {});
    await stopChild(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(path.join(projectPath, "tiles"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "images"), { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(multiUserRoot, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  await Promise.all([
    fs.writeFile(path.join(projectPath, "VERSION"), "0.43.27-beta\n"),
    fs.writeFile(path.join(projectPath, "CHANGELOG.md"), "# Tile tools browser fixture\n"),
    fs.writeFile(path.join(projectPath, "images", "terrain.png"), TILE_IMAGE),
    fs.writeFile(path.join(projectPath, "tiles", "terrain.tsj"), `${JSON.stringify({
      columns: 2,
      image: "../images/terrain.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Terrain",
      spacing: 0,
      tilecount: 2,
      tileheight: 16,
      tilewidth: 16,
      tiles: [
        { id: 0, probability: 0 },
        { id: 1, probability: 1 },
      ],
      wangsets: [{
        name: "Edge Ground",
        type: "edge",
        tile: 0,
        colors: [{ color: "#4f8f3a", name: "Grass", probability: 1, tile: 0 }],
        wangtiles: [
          { tileid: 0, wangid: [0, 1, 0, 1, 0, 1, 0, 1] },
          { tileid: 1, wangid: [0, 0, 0, 0, 0, 1, 0, 0] },
        ],
      }],
      type: "tileset",
      version: "1.10",
    }, null, 2)}\n`),
    fs.writeFile(mapPath, `${JSON.stringify({
      height: 6,
      infinite: false,
      layers: [{
        data: Array(48).fill(0),
        height: 6,
        id: 1,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 8,
        x: 0,
        y: 0,
      }],
      nextlayerid: 2,
      orientation: "orthogonal",
      renderorder: "right-down",
      tileheight: 16,
      tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 8,
    }, null, 2)}\n`),
    fs.writeFile(targetMapPath, `${JSON.stringify({
      height: 6,
      infinite: false,
      layers: [{
        data: Array(48).fill(0),
        height: 6,
        id: 1,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 8,
        x: 0,
        y: 0,
      }],
      nextlayerid: 2,
      orientation: "orthogonal",
      renderorder: "right-down",
      tileheight: 16,
      tilesets: [{ firstgid: 10, source: "../tiles/terrain.tsj" }],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 8,
    }, null, 2)}\n`),
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
  const context = await browser.newContext({
    httpCredentials: { username, password },
    viewport: { width: 1280, height: 800 },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`${message.text()} @ ${message.location().url || "unknown"}`);
  });
  await openViewer(page, { baseUrl, projectPath, mapPath, editorInstanceId: "tile-tools-browser" });
  await page.locator('#mapApp[data-state="ready"]').waitFor({ timeout: 45_000 });
  assert.equal(await page.locator(".tile-swatch").count(), 2);

  await page.locator('.tile-swatch[data-gid="1"]').click();
  await page.locator("#tileStampSelectButton").click();
  assert.equal(await page.locator("#tileStampSelectButton").getAttribute("aria-pressed"), "true");
  await page.locator('.tile-swatch[data-gid="2"]').click();
  assert.equal(await page.locator("#selectedTileState").textContent(), "Stamp 2 × 1");
  assert.equal(await page.locator(".tile-swatch.is-stamp-selected").count(), 2);

  const canvas = page.locator("canvas.map-canvas");
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 700 && box.height > 500, JSON.stringify(box));
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await draw(page, "#brushToolButton", center, center);
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "1");

  await page.locator("#tileStampLibraryButton").click();
  await page.locator("#tileStampName").fill("Road pair");
  await page.locator("#saveNamedTileStampButton").click();
  await page.waitForFunction(() => document.querySelector("#tileStampLibraryState")?.textContent === "已保存 Road pair");
  assert.equal(await page.locator(".tile-stamp-library-row").count(), 1);
  const stampStorage = await page.evaluate(() => {
    const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .find((candidate) => candidate?.startsWith("wfl-map-tile-stamps-v1:"));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  assert.equal(stampStorage.entries[0].name, "Road pair");
  await page.locator("#copyTileStampButton").click();
  await page.waitForFunction(() => document.querySelector("#tileStampLibraryState")?.textContent?.includes("已复制可跨地图复用"));
  await page.locator("#closeTileStampLibraryButton").click();

  const targetPage = await context.newPage();
  targetPage.on("pageerror", (error) => pageErrors.push(`target: ${error.message}`));
  targetPage.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`target: ${message.text()} @ ${message.location().url || "unknown"}`);
  });
  await openViewer(targetPage, {
    baseUrl,
    projectPath,
    mapPath: targetMapPath,
    editorInstanceId: "tile-tools-target-browser",
  });
  await targetPage.locator('#mapApp[data-state="ready"]').waitFor({ timeout: 45_000 });
  await targetPage.locator("#tileStampLibraryButton").click();
  await targetPage.locator("#pasteTileStampButton").click();
  await targetPage.waitForFunction(() => document.querySelector("#tileStampLibraryState")?.textContent?.includes("重映射 Stamp GID"));
  assert.equal(await targetPage.locator("#selectedTileState").textContent(), "Stamp 2 × 1");
  const targetCanvas = targetPage.locator("canvas.map-canvas");
  const targetBox = await targetCanvas.boundingBox();
  assert.ok(targetBox, "target canvas is missing");
  const targetCenter = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await targetPage.locator("#tileStampLibraryDialog").evaluate((dialog) => dialog.close());
  await draw(targetPage, "#brushToolButton", targetCenter, targetCenter);
  await targetPage.locator("#saveButton").click();
  await targetPage.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, { timeout: 30_000 });
  const targetSaved = JSON.parse(await fs.readFile(targetMapPath, "utf8"));
  assert.ok(targetSaved.layers[0].data.includes(10));
  assert.ok(targetSaved.layers[0].data.includes(11));
  await targetPage.close();

  await page.locator('[data-tile-stamp-transform="flip-horizontal"]').click();
  assert.match(await page.locator("#selectedTileState").textContent(), /已变换/u);
  await draw(page, "#brushToolButton", { x: center.x, y: center.y - 90 }, { x: center.x, y: center.y - 90 });
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "2");

  await page.locator("#tileStampLibraryButton").click();
  await page.locator('[data-tile-stamp-action="use"]').click();
  assert.equal(await page.locator("#selectedTileState").textContent(), "Stamp 2 × 1");
  await page.locator("#tileRandomButton").click();
  await page.locator("#tileRandomSeed").fill("424242");
  await page.locator("#tileRandomSeed").press("Tab");
  await draw(page, "#brushToolButton", { x: center.x - 240, y: center.y - 170 }, { x: center.x + 240, y: center.y - 170 });
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "3");
  assert.match(await page.locator("#undoButton").getAttribute("title"), /随机绘制瓦片/u);
  await page.locator("#tileRandomButton").click();

  await page.locator("#sampleToolButton").click();
  await page.mouse.click(center.x, center.y);
  assert.equal(await page.locator("#brushToolButton").getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#selectedTileState").textContent(), /^GID [12]$/u);
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "3");

  await selectTileShape(page, "tile-line");
  await draw(page, "#tileShapeToolButton", { x: center.x - 190, y: center.y - 110 }, { x: center.x - 60, y: center.y - 110 }, false);
  await selectTileShape(page, "tile-rectangle", { filled: true });
  await draw(page, "#tileShapeToolButton", { x: center.x + 45, y: center.y - 115 }, { x: center.x + 155, y: center.y - 35 }, false);
  await selectTileShape(page, "tile-ellipse", { filled: false });
  await draw(page, "#tileShapeToolButton", { x: center.x - 180, y: center.y + 45 }, { x: center.x - 45, y: center.y + 125 }, false);
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "6");
  await page.locator('[data-tile-stamp-transform="flip-horizontal"]').click();
  await draw(page, "#brushToolButton", center, center);
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "7");

  assert.equal(await page.locator("#terrainBrushControls").isVisible(), true);
  assert.match(await page.locator("#terrainSetSelect").inputValue(), /terrain\.tsj/u);
  assert.equal(await page.locator("#terrainColorSelect").inputValue(), "1");
  await page.locator("#terrainBrushSeed").fill("5150");
  await page.locator("#terrainBrushSeed").press("Tab");
  await draw(page, "#terrainBrushToolButton", { x: center.x + 120, y: center.y + 120 }, { x: center.x + 120, y: center.y + 120 });
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "8");
  assert.match(await page.locator("#undoButton").getAttribute("title"), /Terrain/u);
  assert.match(await page.locator("#terrainBrushState").textContent(), /近似|精确/u);

  await page.locator('[data-tile-selection-mode="replace"]').click();
  await draw(page, "#tileRectSelectButton", center, center);
  assert.match(await page.locator("#selectionState").textContent(), /^1 格/u);
  await page.locator('[data-tile-selection-mode="add"]').click();
  const adjacent = { x: center.x + 150, y: center.y };
  await draw(page, "#tileRectSelectButton", adjacent, adjacent);
  assert.match(await page.locator("#selectionState").textContent(), /^2 格/u);
  await page.locator('[data-tile-selection-mode="subtract"]').click();
  await draw(page, "#tileRectSelectButton", center, center);
  assert.match(await page.locator("#selectionState").textContent(), /^1 格/u);
  await page.locator('[data-tile-selection-mode="intersect"]').click();
  await draw(page, "#tileRectSelectButton", adjacent, adjacent);
  assert.match(await page.locator("#selectionState").textContent(), /^1 格/u);

  await page.locator('[data-tile-selection-mode="replace"]').click();
  await page.locator("#tileMagicToolButton").click();
  await page.mouse.click(center.x, center.y);
  const magicCount = Number((await page.locator("#selectionState").textContent()).match(/^(\d+) 格/u)?.[1]);
  assert.ok(magicCount >= 1);
  await page.locator("#tileSameToolButton").click();
  await page.mouse.click(center.x, center.y);
  const sameCount = Number((await page.locator("#selectionState").textContent()).match(/^(\d+) 格/u)?.[1]);
  assert.ok(sameCount >= magicCount);
  await page.locator("#clearTileSelectionButton").click();
  assert.equal(await page.locator("#undoButton").getAttribute("data-history-depth"), "8");
  const warningText = await page.locator("#warningState").getAttribute("title");
  assert.equal(await page.locator("#warningState").isVisible(), true, warningText);
  assert.match(warningText, /Terrain|Wang/u);

  await page.locator("#saveButton").click();
  await page.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, { timeout: 30_000 });
  const saved = JSON.parse(await fs.readFile(mapPath, "utf8"));
  const nonEmpty = saved.layers[0].data.filter((gid) => Number(gid) !== 0);
  assert.ok(nonEmpty.length >= 10, `only ${nonEmpty.length} tiles were painted`);
  assert.ok(nonEmpty.includes(1));
  assert.ok(nonEmpty.includes(2));
  assert.ok(nonEmpty.some((gid) => gid > 0x0fff_ffff), "transformed Tiled GID was not saved");

  const tabletContext = await browser.newContext({
    httpCredentials: { username, password },
    viewport: { width: 1_024, height: 768 },
    hasTouch: true,
  });
  const tablet = await tabletContext.newPage();
  tablet.on("pageerror", (error) => pageErrors.push(`tablet: ${error.message}`));
  tablet.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`tablet: ${message.text()} @ ${message.location().url || "unknown"}`);
  });
  await openViewer(tablet, {
    baseUrl,
    projectPath,
    mapPath,
    editorInstanceId: "tile-tools-tablet-browser",
  });
  await tablet.locator('#mapApp[data-state="ready"]').waitFor({ timeout: 45_000 });
  assert.equal(await tablet.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const tabletCanvas = tablet.locator("canvas.map-canvas");
  const tabletBox = await tabletCanvas.boundingBox();
  assert.ok(tabletBox && tabletBox.width > 500 && tabletBox.height > 400, JSON.stringify(tabletBox));
  const tabletCenter = { x: tabletBox.x + tabletBox.width / 2, y: tabletBox.y + tabletBox.height / 2 };
  const zoomBeforePinch = await tablet.locator("#zoomLabel").textContent();
  await tabletCanvas.evaluate((canvas) => {
    window.__wflPointerTrace = [];
    window.__wflSetPointerCapture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      canvas.addEventListener(type, (event) => window.__wflPointerTrace.push({
        type,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
      }));
    }
  });
  await tabletCanvas.evaluate((canvas, center) => {
    const dispatch = (type, pointerId, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId,
      pointerType: "touch",
      isPrimary: pointerId === 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    }));
    dispatch("pointerdown", 1, center.x - 60, center.y);
    dispatch("pointerdown", 2, center.x + 60, center.y);
    dispatch("pointermove", 1, center.x - 110, center.y);
    dispatch("pointermove", 2, center.x + 110, center.y);
    dispatch("pointerup", 1, center.x - 110, center.y);
    dispatch("pointerup", 2, center.x + 110, center.y);
    canvas.setPointerCapture = window.__wflSetPointerCapture;
    delete window.__wflSetPointerCapture;
  }, {
    x: tabletBox.width / 2,
    y: tabletBox.height / 2,
  });
  await tablet.waitForTimeout(250);
  const zoomAfterPinch = await tablet.locator("#zoomLabel").textContent();
  const pointerTrace = await tablet.evaluate(() => window.__wflPointerTrace);
  assert.notEqual(zoomAfterPinch, zoomBeforePinch, JSON.stringify(pointerTrace));
  assert.equal(await tablet.locator("#undoButton").getAttribute("data-history-depth"), "0");

  if (await tablet.locator("#collaborationScrim").isVisible()) {
    await tablet.locator("#collaborationScrim").click();
  }
  await tablet.locator("#eraserToolButton").click();
  const penTraceStart = await tablet.evaluate(() => window.__wflPointerTrace.length);
  await tabletCanvas.evaluate((canvas, center) => {
    const previousCapture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    const dispatch = (type, x, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: center.y,
      pointerId: 9,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons,
      pressure: buttons ? 0.5 : 0,
    }));
    dispatch("pointerdown", center.x, 1);
    dispatch("pointermove", center.x + 24, 1);
    dispatch("pointerup", center.x + 24, 0);
    canvas.setPointerCapture = previousCapture;
    delete window.__wflSetPointerCapture;
  }, {
    x: tabletBox.width / 2,
    y: tabletBox.height / 2,
  });
  await tablet.waitForTimeout(250);
  const tabletHistoryDepth = await tablet.locator("#undoButton").getAttribute("data-history-depth");
  const penTrace = await tablet.evaluate((start) => window.__wflPointerTrace.slice(start), penTraceStart);
  assert.equal(tabletHistoryDepth, "1", JSON.stringify(penTrace));
  assert.equal(Number(await tabletCanvas.getAttribute("data-rendered-tiles")) > 0, true);
  await tablet.screenshot({ path: "test-results/map-tile-tools-tablet.png" });
  await tablet.close();
  await tabletContext.close();

  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator("#collaborationPanel").isVisible()) {
    await page.locator("#closeCollaborationButton").click();
    await page.locator("#collaborationPanel").waitFor({ state: "hidden" });
  }
  const railBox = await page.locator(".map-toolrail").boundingBox();
  assert.ok(railBox && railBox.x >= 0 && railBox.x + railBox.width <= 390, JSON.stringify(railBox));
  await page.locator("#tileShapeToolButton").click();
  const menuBox = await page.locator("#tileShapeMenu:not([hidden])").boundingBox();
  assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, JSON.stringify(menuBox));
  await page.locator("#tileShapeToolButton").click();
  await page.locator("#layersButton").click();
  await page.waitForTimeout(250);
  const stampToolbarBox = await page.locator("#tileStampToolbar").boundingBox();
  assert.ok(stampToolbarBox && stampToolbarBox.x >= 0 && stampToolbarBox.x + stampToolbarBox.width <= 390, JSON.stringify(stampToolbarBox));
  const terrainControlsBox = await page.locator("#terrainBrushControls").boundingBox();
  assert.ok(terrainControlsBox && terrainControlsBox.x >= 0 && terrainControlsBox.x + terrainControlsBox.width <= 390, JSON.stringify(terrainControlsBox));
  await page.screenshot({ path: "test-results/map-tile-tools-mobile.png" });
  assert.deepEqual(pageErrors, []);
});

async function draw(page, selector, start, end, activate = true) {
  if (activate) await page.locator(selector).click();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  if (start.x !== end.x || start.y !== end.y) await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

async function selectTileShape(page, shape, options = {}) {
  await page.locator("#tileShapeToolButton").click();
  await page.locator(`#tileShapeMenu [data-tile-shape="${shape}"]`).click();
  const filled = options.filled === true;
  if (await page.locator("#tileShapeFilled").isChecked() !== filled) {
    await page.locator("#tileShapeToolButton").click();
    await page.locator("#tileShapeFilled").setChecked(filled);
    await page.locator("#tileShapeToolButton").click();
  }
  assert.equal(await page.locator(`#tileShapeMenu [data-tile-shape="${shape}"]`).getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#tileShapeToolButton").getAttribute("aria-pressed"), "true");
}

async function openViewer(page, input) {
  await page.goto(`${input.baseUrl}/map-editor.html#pending`, { waitUntil: "domcontentloaded" });
  const opened = await page.evaluate(async ({ projectPath, mapPath, editorInstanceId }) => {
    const accountResponse = await fetch("/api/account?summary=1", { cache: "no-store" });
    const accountData = await accountResponse.json();
    if (!accountResponse.ok || !accountData.user?.id) throw new Error(accountData.error || "account read failed");
    const response = await fetch("/api/maps/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-session-open",
      },
      body: JSON.stringify({ project: projectPath, path: mapPath, editorInstanceId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { session: data.session, accountId: accountData.user.id };
  }, input);
  const fragment = new URLSearchParams({
    session: opened.session.id,
    editor: input.editorInstanceId,
    account: opened.accountId,
    project: input.projectPath,
  });
  const editorUrl = new URL("/map-editor.html", input.baseUrl);
  editorUrl.hash = fragment.toString();
  await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
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

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
