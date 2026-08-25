import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { chromium } from "playwright";
import { createAuthRecord, writeAuth } from "../../lib/auth.mjs";

test("opens maps from the main workspace on desktop and mobile", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-workspace-"));
  const projectRoot = path.join(root, "projects");
  const projectPath = path.join(projectRoot, "game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const multiUserRoot = path.join(root, "users");
  const codexHome = path.join(root, "codex-home");
  const authFile = path.join(root, "auth.json");
  const username = "codex";
  const password = "map-workspace-browser-password";
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  let browser;

  t.after(async () => {
    await browser?.close().catch(() => {});
    server?.kill("SIGTERM");
    await fs.rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    fs.mkdir(path.join(projectPath, "maps"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "templates"), { recursive: true }),
    fs.mkdir(path.join(projectPath, "maps", "images"), { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(multiUserRoot, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  await Promise.all([
    fs.writeFile(path.join(projectPath, "VERSION"), "0.43.25-beta\n"),
    fs.writeFile(path.join(projectPath, "CHANGELOG.md"), "# Map workspace test\n"),
    fs.writeFile(path.join(projectPath, "game.tiled-project"), `${JSON.stringify({
      compatibilityVersion: "1.12",
      folders: ["maps", "templates"],
      propertyTypes: [
        {
          name: "Biome",
          type: "enum",
          storageType: "string",
          values: ["forest", "desert", "snow"],
          futureEnumField: { keep: true },
        },
        {
          name: "SpawnConfig",
          type: "class",
          members: [
            { name: "team", type: "string", value: "player" },
            { name: "enabled", type: "bool", value: true },
          ],
          futureClassField: "keep",
        },
      ],
      futureProjectField: { keep: true },
    })}\n`),
    fs.writeFile(path.join(projectPath, "maps", "world.tmj"), `${JSON.stringify({
      height: 1,
      infinite: false,
      layers: [{
        data: [0],
        height: 1,
        id: 1,
        name: "Ground",
        type: "tilelayer",
        width: 1,
        properties: [
          { name: "biome", type: "enum", propertytype: "Biome", value: "forest", futurePropertyField: "keep" },
          { name: "spawn", type: "class", propertytype: "SpawnConfig", value: { team: "player", futureMember: 7 } },
          {
            name: "patrol",
            type: "list",
            propertytype: "int",
            value: [{ type: "int", value: 1, futureItemField: "keep" }, { type: "int", value: 2 }],
          },
        ],
        futureLayerField: { keep: true },
      }],
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
    fs.writeFile(path.join(projectPath, "templates", "portal.tx"), `${JSON.stringify({
      type: "template",
      object: { id: 1, name: "Portal", class: "Portal", width: 16, height: 16 },
    }, null, 2)}\n`),
    sharp({ create: { width: 64, height: 32, channels: 4, background: "#4f9f66" } })
      .png()
      .toFile(path.join(projectPath, "maps", "images", "terrain.png")),
    sharp({ create: { width: 18, height: 26, channels: 4, background: "#b98352" } })
      .png()
      .toFile(path.join(projectPath, "maps", "images", "prop.png")),
    sharp({ create: { width: 12, height: 20, channels: 4, background: "#d56991" } })
      .png()
      .toFile(path.join(projectPath, "maps", "images", "flower.png")),
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
  const pageErrors = [];
  const desktop = await context.newPage();
  desktop.on("pageerror", (error) => pageErrors.push(error.message));
  await desktop.setViewportSize({ width: 1280, height: 800 });
  await openMapWorkspace(desktop, baseUrl);
  assert.ok((await desktop.locator("#mapWorkspaceProjectName").textContent())?.trim());
  assert.match(await desktop.locator("#mapWorkspaceProjectMeta").textContent(), /game\.tiled-project.*Tiled 1\.12/u);
  assert.equal(await desktop.locator(".map-workspace-map-row").count(), 1);
  assert.match(await desktop.locator(".map-workspace-map-row").innerText(), /maps\/world\.tmj/u);
  await desktop.waitForFunction(() => {
    const toggle = document.querySelector("#mapAiToolsToggle");
    return toggle && !toggle.disabled;
  });
  assert.equal(await desktop.locator("#mapAiToolsToggle").isChecked(), false);
  assert.equal(await desktop.locator("#mapGameWorkModeToggle").isDisabled(), true);
  assert.equal(await desktop.locator("#mapGameWorkModeState").textContent(), "未连接");

  await desktop.locator(".map-ai-tools-toggle").click();
  await desktop.waitForFunction(() => document.querySelector("#mapAiToolsState")?.textContent === "已开启", null, {
    timeout: 10_000,
  }).catch(async (error) => {
    const detail = await desktop.evaluate(() => ({
      checked: document.querySelector("#mapAiToolsToggle")?.checked,
      disabled: document.querySelector("#mapAiToolsToggle")?.disabled,
      state: document.querySelector("#mapAiToolsState")?.textContent,
      toasts: [...document.querySelectorAll("#toastRegion .toast")].map((item) => item.textContent),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(detail)}`);
  });
  const mapAiSetting = await desktop.evaluate(async () => (await (await fetch("/api/account/map-ai")).json()));
  assert.equal(mapAiSetting.mapAiToolsEnabled, true);
  await fs.mkdir("test-results", { recursive: true });
  await desktop.screenshot({ path: "test-results/map-workspace-desktop.png" });

  await desktop.locator("#mapWorkspaceNewButton:not([disabled])").click();
  await desktop.locator("#mapNewDialog[open]").waitFor();
  await desktop.locator("#mapNewName").fill("generated-zone");
  await desktop.locator("#mapNewDirectory").fill("maps");
  await desktop.locator("#mapNewOrientation").selectOption("hexagonal");
  assert.equal(await desktop.locator("#mapNewStaggerFields").isVisible(), true);
  assert.equal(await desktop.locator("#mapNewHexField").isVisible(), true);
  await desktop.locator("#mapNewWidth").fill("8");
  await desktop.locator("#mapNewHeight").fill("6");
  assert.equal(await desktop.locator("#mapNewPathPreview").textContent(), "maps/generated-zone.tmj");
  await desktop.screenshot({ path: "test-results/map-new-desktop.png" });
  const invalidControls = await desktop.evaluate(() => [...document.querySelector("#mapNewForm").elements]
    .filter((control) => typeof control.checkValidity === "function" && !control.checkValidity())
    .map((control) => ({ id: control.id, message: control.validationMessage })));
  assert.deepEqual(invalidControls, []);
  const createdPopupPromise = context.waitForEvent("page");
  await desktop.locator("#mapNewSubmitButton").click();
  const createdEditor = await createdPopupPromise.catch(async (error) => {
    const detail = await desktop.evaluate(() => ({
      error: document.querySelector("#mapNewError")?.textContent,
      open: document.querySelector("#mapNewDialog")?.open,
      busy: document.querySelector("#mapNewForm")?.getAttribute("aria-busy"),
      disabled: document.querySelector("#mapNewSubmitButton")?.disabled,
      toasts: [...document.querySelectorAll("#toastRegion .toast")].map((item) => item.textContent),
    }));
    throw new Error(`${error.message}\n${JSON.stringify({ detail, pageErrors })}`);
  });
  createdEditor.on("pageerror", (error) => pageErrors.push(error.message));
  await createdEditor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  const createdDocument = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "generated-zone.tmj"), "utf8"));
  assert.equal(createdDocument.orientation, "hexagonal");
  assert.equal(createdDocument.width, 8);
  assert.equal(createdDocument.height, 6);
  assert.equal(createdDocument.tiledversion, "1.12.2");
  await closeMapEditorSession(createdEditor);

  await openMapWorkspace(desktop, baseUrl);
  assert.equal(await desktop.locator(".map-workspace-map-row").count(), 2);

  await desktop.locator("#mapWorkspaceNewTilesetButton:not([disabled])").click();
  await desktop.locator("#tilesetNewDialog[open]").waitFor();
  await desktop.locator("#tilesetNewName").fill("terrain");
  await desktop.locator("#tilesetNewDirectory").fill("maps/tilesets");
  await desktop.locator("#tilesetNewDisplayName").fill("Terrain");
  await desktop.locator("#tilesetNewTileWidth").fill("16");
  await desktop.locator("#tilesetNewTileHeight").fill("16");
  await desktop.locator('.tileset-new-image-row[role="option"]', { hasText: "terrain.png" }).waitFor({ timeout: 20_000 });
  await desktop.locator('.tileset-new-image-row[role="option"]', { hasText: "terrain.png" })
    .locator(".tileset-new-image-choice")
    .check();
  const selectedAfterClick = await desktop.evaluate(() => ({
    count: document.querySelector("#tilesetNewImageList")?.dataset.selectedCount,
    rows: [...document.querySelectorAll(".tileset-new-image-row")].map((row) => ({
      selected: row.getAttribute("aria-selected"),
      path: row.dataset.imagePath,
      disabled: row.disabled,
    })),
  }));
  assert.equal(selectedAfterClick.count, "1", JSON.stringify({ selectedAfterClick, pageErrors }));
  assert.equal(await desktop.locator("#tilesetNewPathPreview").textContent(), "maps/tilesets/terrain.tsj");
  const tilesetFormState = await desktop.evaluate(() => ({
    invalid: [...document.querySelector("#tilesetNewForm").elements]
      .filter((control) => typeof control.checkValidity === "function" && !control.checkValidity())
      .map((control) => ({ id: control.id, message: control.validationMessage })),
    selected: [...document.querySelectorAll('.tileset-new-image-row[aria-selected="true"]')].map((row) => row.textContent),
  }));
  assert.deepEqual(tilesetFormState.invalid, []);
  assert.equal(tilesetFormState.selected.length, 1);
  const tilesetPopupPromise = context.waitForEvent("page", { timeout: 10_000 });
  await desktop.locator("#tilesetNewSubmitButton").click();
  const tilesetEditor = await tilesetPopupPromise.catch(async (error) => {
    const detail = await desktop.evaluate(() => ({
      error: document.querySelector("#tilesetNewError")?.textContent,
      open: document.querySelector("#tilesetNewDialog")?.open,
      busy: document.querySelector("#tilesetNewForm")?.getAttribute("aria-busy"),
      disabled: document.querySelector("#tilesetNewSubmitButton")?.disabled,
    }));
    throw new Error(`${error.message}\n${JSON.stringify({ detail, pageErrors })}`);
  });
  tilesetEditor.on("pageerror", (error) => pageErrors.push(error.message));
  await tilesetEditor.waitForFunction(() => document.querySelector("#tilesetApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  assert.equal(await tilesetEditor.locator("#tilesetKind").textContent(), "Atlas");
  assert.equal(await tilesetEditor.locator(".tile-list-row").count(), 8);
  await tilesetEditor.locator(".tile-list-row").first().click();
  assert.equal(await tilesetEditor.locator("#selectedTileId").textContent(), "ID 0");
  const paintedPixels = await tilesetEditor.locator("#tilesetCanvas").evaluate((canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) painted += 1;
    return painted;
  });
  assert.ok(paintedPixels > 100);
  await tilesetEditor.locator("#tileWidth").fill("8");
  await tilesetEditor.locator("#applyAtlasButton").click();
  await tilesetEditor.locator("#tileClass").fill("Ground");
  await tilesetEditor.locator("#tileProbabilityEnabled").check();
  await tilesetEditor.locator("#tileProbability").fill("0.75");
  await tilesetEditor.locator("#applyTileMetadataButton").click();
  await tilesetEditor.locator("#addTilePropertyButton").click();
  await tilesetEditor.locator('.tile-property-row [data-property-field="name"]').fill("walkCost");
  await tilesetEditor.locator('.tile-property-row [data-property-field="name"]').press("Tab");
  await tilesetEditor.locator('.tile-property-row [data-property-field="type"]').selectOption("int");
  await tilesetEditor.locator('.tile-property-row [data-property-field="value"]').fill("2");
  await tilesetEditor.locator('.tile-property-row [data-property-field="value"]').press("Tab");
  await tilesetEditor.locator("#addAnimationFrameButton").click();
  await tilesetEditor.locator("#addAnimationFrameButton").click();
  await tilesetEditor.locator('.animation-frame-row[data-frame-index="0"] [data-frame-field="duration"]').fill("80");
  await tilesetEditor.locator('.animation-frame-row[data-frame-index="0"] [data-frame-field="duration"]').press("Tab");
  await tilesetEditor.locator('.animation-frame-row[data-frame-index="1"] [data-frame-field="tileid"]').fill("1");
  await tilesetEditor.locator('.animation-frame-row[data-frame-index="1"] [data-frame-field="tileid"]').press("Tab");
  await tilesetEditor.locator('.animation-frame-row[data-frame-index="1"] [data-frame-field="duration"]').fill("120");
  await tilesetEditor.locator('.animation-frame-row[data-frame-index="1"] [data-frame-field="duration"]').press("Tab");
  await tilesetEditor.locator("#addCollisionButton").click();
  await tilesetEditor.locator("#newCollisionShape").selectOption("ellipse");
  await tilesetEditor.locator("#addCollisionButton").click();
  await tilesetEditor.locator('.collision-object-row[data-collision-id="2"] [data-collision-field="x"]').fill("2");
  await tilesetEditor.locator('.collision-object-row[data-collision-id="2"] [data-collision-field="x"]').press("Tab");
  await tilesetEditor.locator("#addWangSetButton").click();
  await tilesetEditor.locator("#wangSetName").fill("Ground Blend");
  await tilesetEditor.locator("#wangSetClass").fill("GroundTerrain");
  await tilesetEditor.locator("#wangSetTile").fill("0");
  await tilesetEditor.locator("#applyWangSetButton").click();
  await tilesetEditor.locator("#addWangColorButton").click();
  await tilesetEditor.locator('.wang-color-row[data-wang-color-index="1"] [data-wang-color-field="name"]').fill("Grass");
  await tilesetEditor.locator('.wang-color-row[data-wang-color-index="1"] [data-wang-color-field="name"]').press("Tab");
  await tilesetEditor.locator('.wang-color-row[data-wang-color-index="1"] [data-wang-color-field="color"]').evaluate((control) => {
    control.value = "#4f8f3a";
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tilesetEditor.locator("#addWangColorButton").click();
  await tilesetEditor.locator('.wang-color-row[data-wang-color-index="2"] [data-wang-color-field="name"]').fill("Dirt");
  await tilesetEditor.locator('.wang-color-row[data-wang-color-index="2"] [data-wang-color-field="name"]').press("Tab");
  for (const [position, color] of [[0, "1"], [1, "2"], [2, "1"], [3, "2"], [4, "1"], [5, "2"], [6, "1"], [7, "2"]]) {
    await tilesetEditor.locator(`[data-wang-position="${position}"]`).selectOption(color);
  }
  await tilesetEditor.locator("#applyTileWangButton").click();
  assert.equal(await tilesetEditor.locator(".tile-property-row").count(), 1);
  assert.equal(await tilesetEditor.locator(".animation-frame-row").count(), 2);
  assert.equal(await tilesetEditor.locator(".collision-object-row").count(), 2);
  assert.equal(await tilesetEditor.locator(".wang-color-row").count(), 2);
  await tilesetEditor.locator("#wangSetSection").scrollIntoViewIfNeeded();
  await tilesetEditor.screenshot({ path: "test-results/tileset-terrain-desktop.png" });
  await tilesetEditor.locator("#tileCollisionSection").scrollIntoViewIfNeeded();
  await tilesetEditor.screenshot({ path: "test-results/tileset-tile-data-desktop.png" });
  await tilesetEditor.locator("#saveButton:not([disabled])").click();
  await tilesetEditor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });
  await tilesetEditor.screenshot({ path: "test-results/tileset-editor-desktop.png" });
  const savedTileset = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "tilesets", "terrain.tsj"), "utf8"));
  assert.equal(savedTileset.image, "../images/terrain.png");
  assert.equal(savedTileset.tilewidth, 8);
  assert.equal(savedTileset.columns, 8);
  assert.equal(savedTileset.tilecount, 16);
  assert.equal(savedTileset.tiles[0].class, "Ground");
  assert.equal(savedTileset.tiles[0].probability, 0.75);
  assert.deepEqual(savedTileset.tiles[0].properties, [{ name: "walkCost", type: "int", value: 2 }]);
  assert.deepEqual(savedTileset.tiles[0].animation, [
    { tileid: 0, duration: 80 },
    { tileid: 1, duration: 120 },
  ]);
  assert.deepEqual(savedTileset.tiles[0].objectgroup.objects.map((object) => ({ id: object.id, shape: object.ellipse ? "ellipse" : "rectangle", x: object.x })), [
    { id: 1, shape: "rectangle", x: 0 },
    { id: 2, shape: "ellipse", x: 2 },
  ]);
  assert.deepEqual(savedTileset.wangsets, [{
    name: "Ground Blend",
    type: "mixed",
    tile: 0,
    class: "GroundTerrain",
    colors: [
      { color: "#4f8f3a", name: "Grass", probability: 1, tile: -1 },
      { color: "#808080", name: "Dirt", probability: 1, tile: -1 },
    ],
    wangtiles: [{ tileid: 0, wangid: [1, 2, 1, 2, 1, 2, 1, 2] }],
  }]);
  await closeTilesetEditorSession(tilesetEditor);

  await openMapWorkspace(desktop, baseUrl);
  assert.equal(await desktop.locator(".map-workspace-map-row").count(), 3);

  await desktop.locator("#mapWorkspaceNewTilesetButton:not([disabled])").click();
  await desktop.locator("#tilesetNewDialog[open]").waitFor();
  await desktop.locator("#tilesetNewKind").selectOption("collection");
  await desktop.locator("#tilesetNewName").fill("props");
  await desktop.locator("#tilesetNewDirectory").fill("maps/tilesets");
  await desktop.locator("#tilesetNewDisplayName").fill("Props");
  for (const imageName of ["prop.png", "terrain.png"]) {
    await desktop.locator('.tileset-new-image-row[role="option"]', { hasText: imageName })
      .locator(".tileset-new-image-choice")
      .check();
  }
  assert.equal(await desktop.locator("#tilesetNewImageList").getAttribute("data-selected-count"), "2");
  const collectionPopupPromise = context.waitForEvent("page", { timeout: 10_000 });
  await desktop.locator("#tilesetNewSubmitButton").click();
  const collectionEditor = await collectionPopupPromise;
  collectionEditor.on("pageerror", (error) => pageErrors.push(error.message));
  await collectionEditor.waitForFunction(() => document.querySelector("#tilesetApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  assert.equal(await collectionEditor.locator("#tilesetKind").textContent(), "Collection");
  assert.equal(await collectionEditor.locator(".tile-list-row").count(), 2);
  await collectionEditor.locator("#addCollectionImageButton:not([disabled])").click();
  await collectionEditor.locator("#collectionImageDialog[open]").waitFor();
  await collectionEditor.locator(".collection-image-row", { hasText: "flower.png" }).click();
  await collectionEditor.locator("#collectionImageSubmitButton:not([disabled])").click();
  await collectionEditor.waitForFunction(() => document.querySelectorAll(".tile-list-row").length === 3);
  assert.equal(await collectionEditor.locator("#selectedTileId").textContent(), "ID 2");
  await collectionEditor.locator(".tile-list-row").first().click();
  assert.equal(await collectionEditor.locator("#selectedTileId").textContent(), "ID 0");
  await collectionEditor.locator("#removeCollectionImageButton:not([disabled])").click();
  await collectionEditor.waitForFunction(() => document.querySelectorAll(".tile-list-row").length === 2);
  await collectionEditor.locator("#tilesetName").fill("Environment Props");
  await collectionEditor.locator("#applyIdentityButton").click();
  await collectionEditor.locator("#saveButton:not([disabled])").click();
  await collectionEditor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });
  const savedCollection = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "tilesets", "props.tsj"), "utf8"));
  assert.equal(savedCollection.name, "Environment Props");
  assert.deepEqual(savedCollection.tiles.map(({ id }) => id), [1, 2]);
  assert.deepEqual(savedCollection.tiles.map(({ image }) => image), ["../images/terrain.png", "../images/flower.png"]);
  await collectionEditor.screenshot({ path: "test-results/tileset-collection-desktop.png" });
  await closeTilesetEditorSession(collectionEditor);

  await openMapWorkspace(desktop, baseUrl);
  assert.equal(await desktop.locator(".map-workspace-map-row").count(), 4);

  const popupPromise = context.waitForEvent("page");
  await desktop.locator(".map-workspace-map-row", { hasText: "world.tmj" }).click();
  const editor = await popupPromise;
  editor.on("pageerror", (error) => pageErrors.push(error.message));
  await editor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  const credentials = await editor.evaluate(() => JSON.parse(
    sessionStorage.getItem("wfl-map-editor-session-v1") || "null",
  ));
  assert.ok(credentials?.sessionId);
  assert.equal(credentials.threadId, undefined);
  assert.equal(Object.hasOwn(credentials, "connect"), false);
  assert.equal(await editor.locator("#gameWorkModeToggle").isDisabled(), true);
  const templateResource = await editor.evaluate(async () => {
    const credentials = JSON.parse(sessionStorage.getItem("wfl-map-editor-session-v1") || "null");
    const response = await fetch(`/api/maps/sessions/${encodeURIComponent(credentials.sessionId)}/project-resource?path=templates%2Fportal.tx`, {
      headers: { "X-Codex-Desktop-Editor-Instance": credentials.editorInstanceId },
    });
    return { status: response.status, document: response.ok ? await response.json() : null };
  });
  assert.equal(templateResource.status, 200);
  assert.equal(templateResource.document.type, "template");
  const projectTypeControls = await editor.evaluate(() => ({
    enumValues: [...document.querySelector('select[aria-label="属性 biome 值"]')?.options || []]
      .map((option) => option.value),
    enumType: document.querySelector('select[aria-label="属性 biome 的项目类型"]')?.value,
    classType: document.querySelector('select[aria-label="属性 spawn 的项目类型"]')?.value,
    classValue: document.querySelector('textarea[aria-label="属性 spawn 值"]')?.value,
    listValue: document.querySelector('textarea[aria-label="属性 patrol 值"]')?.value,
  }));
  assert.deepEqual(projectTypeControls.enumValues, ["forest", "desert", "snow"]);
  assert.equal(projectTypeControls.enumType, "Biome");
  assert.equal(projectTypeControls.classType, "SpawnConfig");
  assert.equal(JSON.parse(projectTypeControls.classValue).enabled, true);
  assert.equal(JSON.parse(projectTypeControls.classValue).futureMember, 7);
  assert.equal(JSON.parse(projectTypeControls.listValue)[0].futureItemField, "keep");
  await editor.locator('select[aria-label="属性 biome 值"]').selectOption("desert");
  await editor.locator('textarea[aria-label="属性 spawn 值"]').fill(JSON.stringify({
    team: "enemy",
    enabled: false,
    futureMember: 7,
  }, null, 2));
  await editor.locator('textarea[aria-label="属性 spawn 值"]').press("Tab");
  await editor.locator('textarea[aria-label="属性 patrol 值"]').fill(JSON.stringify([
    { type: "int", value: 3, futureItemField: "keep" },
    { type: "int", value: 4 },
  ], null, 2));
  await editor.locator('textarea[aria-label="属性 patrol 值"]').press("Tab");
  await editor.locator("#saveButton:not([disabled])").click();
  await editor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });
  const typedSavedMap = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8"));
  const typedProperties = Object.fromEntries(typedSavedMap.layers[0].properties.map((property) => [property.name, property]));
  assert.equal(typedProperties.biome.value, "desert");
  assert.equal(typedProperties.biome.futurePropertyField, "keep");
  assert.deepEqual(typedProperties.spawn.value, { team: "enemy", enabled: false, futureMember: 7 });
  assert.deepEqual(typedProperties.patrol.value, [
    { type: "int", value: 3, futureItemField: "keep" },
    { type: "int", value: 4 },
  ]);
  assert.deepEqual(typedSavedMap.layers[0].futureLayerField, { keep: true });
  await editor.locator("#addObjectLayerButton:not([disabled])").click();
  await editor.locator('.layer-row', { hasText: "对象层" }).last().waitFor();
  await editor.locator('.layer-row', { hasText: "对象层" }).last().click();
  await editor.locator("#templateAssetButton:not([disabled])").click();
  await editor.locator("#templateAssetDialog[open]").waitFor();
  await editor.locator('#templateAssetList .map-asset-entry[data-kind="directory"]', { hasText: "templates" }).click();
  await editor.locator('#templateAssetList .map-asset-entry[data-kind="template"]', { hasText: "portal.tx" }).click();
  await editor.locator("#importTemplateButton:not([disabled])").click();
  await editor.waitForFunction(() => !document.querySelector("#templateAssetDialog")?.open);
  await editor.locator("#saveButton:not([disabled])").click();
  await editor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });
  const templateSavedMap = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8"));
  const templateLayer = templateSavedMap.layers.find((layer) => layer.type === "objectgroup" && layer.name === "对象层");
  assert.ok(templateLayer);
  assert.equal(templateLayer.objects.length, 1);
  assert.equal(templateLayer.objects[0].template, "../templates/portal.tx");
  assert.equal(Object.hasOwn(templateLayer.objects[0], "class"), false);
  await fs.writeFile(path.join(projectPath, "templates", "portal.tx"), `${JSON.stringify({
    type: "template",
    object: { id: 1, name: "Portal Updated", class: "Portal", width: 24, height: 16 },
  }, null, 2)}\n`);
  await editor.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await editor.locator("#refreshTemplateButton:not([disabled])").waitFor({ timeout: 20_000 });
  assert.match(await editor.locator("#inspectorMeta").textContent(), /模板已更新/u);
  await editor.locator("#refreshTemplateButton:not([disabled])").click();
  await editor.waitForFunction(() => document.querySelector("#inspectorWidth")?.value === "24");
  assert.equal(await editor.locator("#inspectorName").inputValue(), "Portal Updated");
  await editor.locator("#unbindTemplateButton:not([disabled])").click();
  await editor.locator("#saveButton:not([disabled])").click();
  await editor.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });
  const unboundSavedMap = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "world.tmj"), "utf8"));
  const unboundObject = unboundSavedMap.layers.find((layer) => layer.type === "objectgroup" && layer.name === "对象层").objects[0];
  assert.equal(Object.hasOwn(unboundObject, "template"), false);
  assert.equal(unboundObject.class, "Portal");
  assert.equal(unboundObject.width, 24);
  editor.once("dialog", (dialog) => dialog.accept("templates/saved-portal.tx"));
  await editor.locator("#saveTemplateButton:not([disabled])").click();
  await editor.waitForFunction(() => document.querySelector("#mapState")?.textContent?.includes("模板已保存"), null, {
    timeout: 20_000,
  });
  const createdTemplate = JSON.parse(await fs.readFile(path.join(projectPath, "templates", "saved-portal.tx"), "utf8"));
  assert.equal(createdTemplate.type, "template");
  assert.equal(createdTemplate.object.id, 1);
  assert.equal(createdTemplate.object.class, "Portal");
  assert.equal(Object.hasOwn(createdTemplate.object, "x"), false);
  assert.equal(Object.hasOwn(createdTemplate.object, "y"), false);
  assert.equal(Object.hasOwn(createdTemplate.object, "template"), false);
  editor.once("dialog", (dialog) => dialog.accept("maps/portal-group.composite.tmj"));
  await editor.locator("#saveCompositeButton:not([disabled])").click();
  await editor.waitForFunction(() => document.querySelector("#mapState")?.textContent?.includes("组合已保存"), null, {
    timeout: 20_000,
  });
  const createdComposite = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "portal-group.composite.tmj"), "utf8"));
  assert.equal(createdComposite.type, "map");
  assert.equal(createdComposite.layers.length, 1);
  assert.equal(createdComposite.layers[0].name, "对象层");
  assert.equal(createdComposite.layers[0].objects.length, 1);
  await editor.locator("#assetLibraryButton:not([disabled])").click();
  await editor.locator("#assetLibraryDialog[open]").waitFor();
  await editor.locator("#assetLibrarySearch").fill("portal-group");
  await editor.locator('.asset-library-entry[data-kind="composite-map"]', { hasText: "portal-group" }).dblclick();
  await editor.waitForFunction(() => !document.querySelector("#assetLibraryDialog")?.open);
  try {
    await editor.locator('.layer-row', { hasText: "portal-group.composite" }).waitFor({ timeout: 20_000 });
  } catch (error) {
    const detail = await editor.evaluate(() => ({
      rows: [...document.querySelectorAll(".layer-row")].map((row) => row.textContent),
      warnings: document.querySelector("#warningState")?.getAttribute("title"),
      mapState: document.querySelector("#mapState")?.textContent,
    }));
    throw new Error(`${error.message}\n${JSON.stringify(detail)}`);
  }
  await editor.locator("#assetLibraryButton:not([disabled])").click();
  await editor.locator("#assetLibraryDialog[open]").waitFor();
  await editor.locator("#assetLibrarySearch").fill("terrain");
  await editor.locator(".asset-library-entry").first().waitFor({ timeout: 20_000 });
  assert.ok(await editor.locator(".asset-library-entry").count() >= 2);
  await editor.locator(".asset-favorite-button").first().click();
  await editor.locator("#assetLibraryFavoritesOnly").check();
  assert.equal(await editor.locator(".asset-library-entry").count(), 1);
  await editor.locator("#closeAssetLibraryButton").click();
  await editor.screenshot({ path: "test-results/map-game-work-mode-desktop.png" });
  await closeMapEditorSession(editor);

  const mobile = await context.newPage();
  mobile.on("pageerror", (error) => pageErrors.push(error.message));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await openMapWorkspace(mobile, baseUrl);
  const bounds = await mobile.locator("#mapWorkspaceDialog").boundingBox();
  assert.ok(bounds);
  assert.ok(bounds.x >= -1 && bounds.y >= -1);
  assert.ok(bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator("#mapWorkspaceNewButton:not([disabled])").click();
  await mobile.locator("#mapNewDialog[open]").waitFor();
  const newMapBounds = await mobile.locator("#mapNewDialog").boundingBox();
  assert.ok(newMapBounds && newMapBounds.x >= -1 && newMapBounds.x + newMapBounds.width <= 391);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: "test-results/map-new-mobile.png" });
  await mobile.locator("#mapNewCancelButton").click();
  await mobile.screenshot({ path: "test-results/map-workspace-mobile.png" });
  assert.equal(await mobile.locator("#mapGameWorkModeToggle").isDisabled(), true);
  assert.equal(await mobile.locator("#mapGameWorkModeState").textContent(), "未连接");
  assert.equal(await mobile.locator("#bootRecoveryBar").isHidden(), true);
  const mobileTilesetPopupPromise = mobile.waitForEvent("popup");
  await mobile.locator('.map-workspace-map-row[data-kind="tileset"]', { hasText: "terrain.tsj" }).click();
  const mobileTilesetEditor = await mobileTilesetPopupPromise;
  mobileTilesetEditor.on("pageerror", (error) => pageErrors.push(error.message));
  await mobileTilesetEditor.setViewportSize({ width: 390, height: 844 });
  await mobileTilesetEditor.waitForFunction(() => document.querySelector("#tilesetApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  assert.equal(await mobileTilesetEditor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobileTilesetEditor.locator("#inspectorPanelButton").click();
  const inspectorBounds = await mobileTilesetEditor.locator(".tileset-inspector").boundingBox();
  assert.ok(inspectorBounds && inspectorBounds.x >= 0 && inspectorBounds.x + inspectorBounds.width <= 390);
  await mobileTilesetEditor.locator("#tilesPanelButton").click();
  const tilePanelBounds = await mobileTilesetEditor.locator(".tileset-tile-panel").boundingBox();
  assert.ok(tilePanelBounds && tilePanelBounds.x >= 0 && tilePanelBounds.x + tilePanelBounds.width <= 390);
  await mobileTilesetEditor.screenshot({ path: "test-results/tileset-editor-mobile.png" });
  await mobileTilesetEditor.locator(".tile-list-row").first().click();
  await mobileTilesetEditor.locator("#inspectorPanelButton").click();
  assert.equal(await mobileTilesetEditor.locator(".wang-color-row").count(), 2);
  await mobileTilesetEditor.locator("#wangSetSection").scrollIntoViewIfNeeded();
  const wangBounds = await mobileTilesetEditor.locator("#wangSetSection").boundingBox();
  assert.ok(wangBounds && wangBounds.x >= 0 && wangBounds.x + wangBounds.width <= 390);
  await mobileTilesetEditor.screenshot({ path: "test-results/tileset-terrain-mobile.png" });
  await mobileTilesetEditor.locator("#tileCollisionSection").scrollIntoViewIfNeeded();
  assert.equal(await mobileTilesetEditor.locator(".animation-frame-row").count(), 2);
  assert.equal(await mobileTilesetEditor.locator(".collision-object-row").count(), 2);
  const collisionBounds = await mobileTilesetEditor.locator("#tileCollisionSection").boundingBox();
  assert.ok(collisionBounds && collisionBounds.x >= 0 && collisionBounds.x + collisionBounds.width <= 390);
  await mobileTilesetEditor.screenshot({ path: "test-results/tileset-tile-data-mobile.png" });
  await closeTilesetEditorSession(mobileTilesetEditor);

  await openMapWorkspace(mobile, baseUrl);
  const mobilePopupPromise = mobile.waitForEvent("popup");
  await mobile.locator(".map-workspace-map-row", { hasText: "world.tmj" }).click();
  const mobileEditor = await mobilePopupPromise;
  mobileEditor.on("pageerror", (error) => pageErrors.push(error.message));
  await mobileEditor.setViewportSize({ width: 390, height: 844 });
  await mobileEditor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  const modeBounds = await mobileEditor.locator("#gameWorkModeControl").boundingBox();
  assert.ok(modeBounds && modeBounds.x >= 0 && modeBounds.x + modeBounds.width <= 390);
  assert.equal(await mobileEditor.locator("#gameWorkModeToggle").isDisabled(), true);
  assert.equal(await mobileEditor.locator("#gameWorkModeState").textContent(), "未绑定对话");
  assert.equal(await mobileEditor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobileEditor.screenshot({ path: "test-results/map-game-work-mode-mobile.png" });
  await closeMapEditorSession(mobileEditor);
  assert.deepEqual(pageErrors, []);
});

async function openMapWorkspace(page, baseUrl) {
  const openErrors = [];
  const collectError = (error) => openErrors.push(error.stack || error.message);
  page.on("pageerror", collectError);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#mapWorkspaceButton:not([disabled])").waitFor({ timeout: 20_000 });
  await page.locator("#mapWorkspaceButton").click();
  await page.locator("#mapWorkspaceDialog[open]").waitFor({ timeout: 10_000 }).catch(async (error) => {
    const detail = await page.evaluate(() => ({
      buttonDisabled: document.querySelector("#mapWorkspaceButton")?.disabled,
      dialogOpen: document.querySelector("#mapWorkspaceDialog")?.open,
      recovery: document.querySelector("#bootRecoveryMessage")?.textContent,
      toasts: [...document.querySelectorAll("#toastRegion .toast")].map((item) => item.textContent),
    }));
    throw new Error(`${error.message}\n${JSON.stringify({ detail, openErrors })}`);
  }).finally(() => page.off("pageerror", collectError));
  const projectFile = page.locator('.map-workspace-resource-row[data-kind="project"]');
  await projectFile.waitFor({ timeout: 20_000 }).catch(async (error) => {
    const detail = await page.evaluate(() => ({
      state: document.querySelector("#mapWorkspaceState")?.textContent,
      stateStatus: document.querySelector("#mapWorkspaceState")?.dataset.status,
      meta: document.querySelector("#mapWorkspaceProjectMeta")?.textContent,
      rows: [...document.querySelectorAll(".map-workspace-resource-row")].map((row) => ({
        kind: row.dataset.kind,
        text: row.textContent,
      })),
      recovery: document.querySelector("#bootRecoveryMessage")?.textContent,
    }));
    throw new Error(`${error.message}\n${JSON.stringify(detail)}`);
  });
  await projectFile.click();
  await page.waitForFunction(() => document.querySelector("#mapWorkspaceProjectMeta")?.textContent?.includes("game.tiled-project"));
  const mapsDirectory = page.locator('.map-workspace-resource-row[data-kind="directory"]', { hasText: "maps" });
  await mapsDirectory.waitFor({ timeout: 20_000 });
  await mapsDirectory.click();
  await page.locator(".map-workspace-map-row").first().waitFor({ timeout: 20_000 });
  const tilesetsDirectory = page.locator('.map-workspace-resource-row[data-kind="directory"]', { hasText: "maps/tilesets" });
  if (await tilesetsDirectory.count()) {
    await tilesetsDirectory.click();
    await page.locator('.map-workspace-map-row[data-kind="tileset"]').first().waitFor({ timeout: 20_000 });
  }
}

async function closeMapEditorSession(page) {
  await page.evaluate(async () => {
    const credentials = JSON.parse(sessionStorage.getItem("wfl-map-editor-session-v1") || "null");
    await fetch(`/api/maps/sessions/${encodeURIComponent(credentials.sessionId)}`, {
      method: "DELETE",
      headers: {
        "X-Codex-Desktop-Action": "map-session-close",
        "X-Codex-Desktop-Editor-Instance": credentials.editorInstanceId,
      },
    });
  });
  await page.close();
}

async function closeTilesetEditorSession(page) {
  await page.evaluate(async () => {
    const params = new URLSearchParams(location.hash.replace(/^#/u, ""));
    await fetch(`/api/map-tilesets/sessions/${encodeURIComponent(params.get("session"))}`, {
      method: "DELETE",
      headers: {
        "X-Codex-Desktop-Action": "map-tileset-session-close",
        "X-Codex-Desktop-Editor-Instance": params.get("editor"),
      },
    });
  });
  await page.close();
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
