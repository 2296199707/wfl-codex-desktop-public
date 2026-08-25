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

const repository = path.resolve(new URL("../..", import.meta.url).pathname);

test("copies a cross-project tile template and imports it with a remapped TSJ in Chromium", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-import-browser-"));
  const projectRoot = path.join(root, "projects");
  const sourceProject = path.join(projectRoot, "source-game");
  const targetProject = path.join(projectRoot, "target-game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const multiUserRoot = path.join(root, "users");
  const codexHome = path.join(root, "codex-home");
  const authFile = path.join(root, "auth.json");
  const username = "codex";
  const password = "map-import-browser-password";
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
    fs.mkdir(path.join(sourceProject, "assets"), { recursive: true }),
    fs.mkdir(path.join(targetProject, "maps"), { recursive: true }),
    fs.mkdir(path.join(targetProject, "templates"), { recursive: true }),
    fs.mkdir(path.join(targetProject, "tiles"), { recursive: true }),
    fs.mkdir(path.join(targetProject, "images"), { recursive: true }),
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(multiUserRoot, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  await Promise.all([
    fs.writeFile(path.join(sourceProject, "game.tiled-project"), `${JSON.stringify({ folders: ["assets"] }, null, 2)}\n`),
    fs.writeFile(path.join(targetProject, "game.tiled-project"), `${JSON.stringify({
      compatibilityVersion: "1.12",
      folders: ["maps", "templates", "tiles", "images"],
    }, null, 2)}\n`),
    fs.writeFile(path.join(sourceProject, "assets/trees.tsj"), `${JSON.stringify({
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
      name: "Trees",
      columns: 1,
      tilecount: 1,
      tilewidth: 16,
      tileheight: 16,
      image: "tree.png",
      imagewidth: 16,
      imageheight: 16,
      futureTilesetField: { keep: true },
    }, null, 2)}\n`),
    fs.writeFile(path.join(sourceProject, "assets/tree.tx"), `${JSON.stringify({
      type: "template",
      tileset: { firstgid: 1, source: "trees.tsj" },
      object: {
        id: 1,
        gid: (0x8000_0000 | 1) >>> 0,
        name: "Tree",
        width: 16,
        height: 16,
        visible: true,
        futureObjectField: { keep: true },
      },
      futureTemplateField: { keep: true },
    }, null, 2)}\n`),
    fs.writeFile(path.join(targetProject, "maps/scene.tmj"), `${JSON.stringify({
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
        name: "Objects",
        type: "objectgroup",
        draworder: "topdown",
        objects: [],
        properties: [{ name: "targetMap", type: "file", value: "scene.tmj" }],
      }],
      tilesets: [],
    }, null, 2)}\n`),
    sharp({ create: { width: 16, height: 16, channels: 4, background: "#4f8f42" } })
      .png()
      .toFile(path.join(sourceProject, "assets/tree.png")),
  ]);

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: targetProject,
      CODEX_DESKTOP_MULTI_USER_ROOT: multiUserRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      CODEX_DESKTOP_DISABLE_CODEX: "1",
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: repository,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_SYSTEMCTL: "/bin/false",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(server, "WFL Codex Desktop v");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username, password } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const opened = await page.evaluate(async ({ project, path: relativePath }) => {
    const accountResponse = await fetch("/api/account?summary=1", { cache: "no-store" });
    const accountData = await accountResponse.json();
    if (!accountResponse.ok || !accountData.user?.id) throw new Error(accountData.error || "account read failed");
    const projectResponse = await fetch("/api/map-projects/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "map-project-session-open" },
      body: JSON.stringify({ project, projectFile: "game.tiled-project" }),
    });
    const projectData = await projectResponse.json();
    if (!projectResponse.ok) throw new Error(projectData.error || "project open failed");
    const editorInstanceId = crypto.randomUUID();
    const mapResponse = await fetch("/api/maps/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "map-session-open" },
      body: JSON.stringify({
        projectSessionId: projectData.session.id,
        path: relativePath,
        editorInstanceId,
      }),
    });
    const mapData = await mapResponse.json();
    if (!mapResponse.ok) throw new Error(mapData.error || "map open failed");
    return {
      projectSessionId: projectData.session.id,
      mapSessionId: mapData.session.id,
      editorInstanceId,
      accountId: accountData.user.id,
    };
  }, { project: targetProject, path: "maps/scene.tmj" });
  const fragment = new URLSearchParams({
    session: opened.mapSessionId,
    editor: opened.editorInstanceId,
    project: targetProject,
    projectFile: "game.tiled-project",
    projectSession: opened.projectSessionId,
    account: opened.accountId,
  });
  await page.goto(`${baseUrl}/map-editor.html#${fragment}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });

  const referencePopupPromise = context.waitForEvent("page");
  await page.locator('.property-reference-button[aria-label^="打开引用文件"]').click();
  const referenceEditor = await referencePopupPromise;
  referenceEditor.on("pageerror", (error) => pageErrors.push(error.message));
  await referenceEditor.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  assert.match(await referenceEditor.locator("#mapMeta").textContent(), /maps\/scene\.tmj/u);
  await referenceEditor.close();

  await page.locator("#assetLibraryButton:not([disabled])").click();
  await page.locator("#assetLibraryDialog[open]").waitFor();
  await page.locator("#crossProjectImportButton:not([disabled])").click();
  await page.locator("#crossProjectImportDialog[open]").waitFor();
  await page.locator(`#crossProjectImportProject option[value="${sourceProject}"]`).waitFor({
    state: "attached",
    timeout: 20_000,
  });
  await page.locator("#crossProjectImportProject").selectOption(sourceProject);
  await page.locator("#crossProjectImportSourcePath").fill("assets/tree.tx");
  await page.locator("#crossProjectImportTargetPath").fill("templates/tree.tx");
  await page.locator("#planCrossProjectImportButton:not([disabled])").click();
  await page.waitForFunction(() => document.querySelector("#crossProjectImportState")?.textContent?.includes("计划已生成"), null, {
    timeout: 20_000,
  });
  assert.equal(await page.locator("#crossProjectImportPlan li").count(), 3);
  assert.match(await page.locator("#crossProjectImportPlan").innerText(), /templates\/tree\.tx/u);
  assert.match(await page.locator("#crossProjectImportPlan").innerText(), /templates\/_deps\/game\/assets\/trees\.tsj/u);
  await page.locator("#confirmCrossProjectImportButton:not([disabled])").click();
  await page.waitForFunction(() => !document.querySelector("#crossProjectImportDialog")?.open, null, {
    timeout: 20_000,
  });
  assert.equal(await fs.lstat(path.join(targetProject, "templates/tree.tx")).then(() => true, () => false), true);

  await page.locator('.layer-row[data-layer-id="1"]').click();
  await page.locator("#templateAssetButton:not([disabled])").click();
  await page.locator("#templateAssetDialog[open]").waitFor();
  await page.locator('#templateAssetList .map-asset-entry[data-kind="directory"]', { hasText: "templates" }).click();
  await page.locator('#templateAssetList .map-asset-entry[data-kind="template"]', { hasText: "tree.tx" }).click();
  await page.locator("#importTemplateButton:not([disabled])").click();
  await page.waitForFunction(() => !document.querySelector("#templateAssetDialog")?.open, null, {
    timeout: 20_000,
  });
  await page.locator("#saveButton:not([disabled])").click();
  await page.waitForFunction(() => document.querySelector("#documentState")?.textContent === "已保存", null, {
    timeout: 20_000,
  });

  const copiedTemplate = JSON.parse(await fs.readFile(path.join(targetProject, "templates/tree.tx"), "utf8"));
  const savedMap = JSON.parse(await fs.readFile(path.join(targetProject, "maps/scene.tmj"), "utf8"));
  assert.equal(copiedTemplate.tileset.source, "_deps/game/assets/trees.tsj");
  assert.deepEqual(copiedTemplate.futureTemplateField, { keep: true });
  assert.deepEqual(savedMap.tilesets, [{ firstgid: 1, source: "../templates/_deps/game/assets/trees.tsj" }]);
  assert.equal(savedMap.layers[0].objects.length, 1);
  assert.equal(savedMap.layers[0].objects[0].template, "../templates/tree.tx");
  assert.equal(Object.hasOwn(savedMap.layers[0].objects[0], "gid"), false);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#mapApp")?.dataset.state === "ready", null, {
    timeout: 30_000,
  });
  assert.deepEqual(pageErrors, []);
});

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
