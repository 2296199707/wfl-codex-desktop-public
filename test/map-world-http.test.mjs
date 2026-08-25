import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repository = path.dirname(path.dirname(new URL(import.meta.url).pathname));

test("World HTTP sessions create, stream, save, conflict, and remain isolated", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-world-http-"));
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "game");
  const otherProject = path.join(projectRoot, "other-game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const codexHome = path.join(root, "codex-home");
  const usersRoot = path.join(root, "users");
  const authFile = path.join(root, "auth.json");
  const fakeSystemctl = path.join(root, "systemctl.cjs");
  const username = "owner";
  const password = "map-world-http-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const firstMapPath = path.join(project, "maps", "first.tmj");
  const secondMapPath = path.join(project, "maps", "second.tmj");
  const otherMapPath = path.join(otherProject, "maps", "foreign.tmj");
  const terrainImagePath = path.join(project, "images", "terrain.png");
  const propImagePath = path.join(project, "images", "prop.png");
  const firstMapSource = tiledMapSource("First");
  const secondMapSource = tiledMapSource("Second");

  await Promise.all([
    fs.mkdir(path.dirname(firstMapPath), { recursive: true }),
    fs.mkdir(path.dirname(terrainImagePath), { recursive: true }),
    fs.mkdir(path.dirname(otherMapPath), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(usersRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(firstMapPath, firstMapSource),
    fs.writeFile(secondMapPath, secondMapSource),
    fs.writeFile(otherMapPath, tiledMapSource("Foreign")),
    fs.writeFile(fakeSystemctl, "#!/usr/bin/env node\nprocess.exit(3);\n", { mode: 0o700 }),
    sharp({ create: { width: 64, height: 32, channels: 4, background: "#4f7f3f" } })
      .png()
      .toFile(terrainImagePath),
    sharp({ create: { width: 18, height: 26, channels: 4, background: "#b08050" } })
      .png()
      .toFile(propImagePath),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: project,
      CODEX_DESKTOP_MULTI_USER_ROOT: usersRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      CODEX_DESKTOP_DISABLE_CODEX: "1",
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: repository,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_SYSTEMCTL: fakeSystemctl,
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  t.after(async () => {
    await stopProcess(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForServer(server, "WFL Codex Desktop v");

  const multiUser = await requestJson(baseUrl, "/api/multi-user/enable", {
    method: "POST",
    authorization,
    action: "multi-user-enable",
    body: { password },
  });
  assert.equal(multiUser.response.status, 202, diagnostic(multiUser, serverOutput));
  const ownerCookie = cookieFrom(multiUser.response);
  assert.ok(ownerCookie);
  const secondLogin = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    action: "login",
    body: { username, password },
  });
  assert.equal(secondLogin.response.status, 200, diagnostic(secondLogin, serverOutput));
  const secondCookie = cookieFrom(secondLogin.response);
  assert.ok(secondCookie);
  assert.notEqual(secondCookie, ownerCookie);

  const ownerProject = await openProject(baseUrl, ownerCookie, project);
  const secondProject = await openProject(baseUrl, secondCookie, project);
  const foreignProject = await openProject(baseUrl, ownerCookie, otherProject);
  const crossBrowserProject = await requestJson(
    baseUrl,
    `/api/map-projects/sessions/${encodeURIComponent(ownerProject.id)}`,
    { cookie: secondCookie },
  );
  assert.equal(crossBrowserProject.response.status, 404, JSON.stringify(crossBrowserProject.data));

  const atlasCreated = await requestJson(
    baseUrl,
    `/api/map-projects/sessions/${encodeURIComponent(ownerProject.id)}/tilesets`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-project-tileset-create",
      body: {
        relativePath: "tiles/terrain.tsj",
        kind: "atlas",
        name: "Terrain",
        image: "images/terrain.png",
        tilewidth: 16,
        tileheight: 16,
        margin: 0,
        spacing: 0,
        targetVersion: "1.12.2",
      },
    },
  );
  assert.equal(atlasCreated.response.status, 201, diagnostic(atlasCreated, serverOutput));
  assert.equal(atlasCreated.data.tileset.relativePath, "tiles/terrain.tsj");
  assert.equal(atlasCreated.data.tileset.kind, "atlas");
  assert.equal(atlasCreated.data.tileset.tilecount, 8);

  const collectionCreated = await requestJson(
    baseUrl,
    `/api/map-projects/sessions/${encodeURIComponent(ownerProject.id)}/tilesets`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-project-tileset-create",
      body: {
        relativePath: "tiles/props.tsj",
        kind: "collection",
        name: "Props",
        images: ["images/prop.png", "images/terrain.png"],
        targetVersion: "1.12.2",
      },
    },
  );
  assert.equal(collectionCreated.response.status, 201, diagnostic(collectionCreated, serverOutput));
  const collectionDocument = JSON.parse(await fs.readFile(path.join(project, "tiles", "props.tsj"), "utf8"));
  assert.deepEqual(collectionDocument.tiles.map(({ id, image }) => ({ id, image })), [
    { id: 0, image: "../images/prop.png" },
    { id: 1, image: "../images/terrain.png" },
  ]);

  const unsafeTilesetCreate = await requestJson(
    baseUrl,
    `/api/map-projects/sessions/${encodeURIComponent(ownerProject.id)}/tilesets`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-project-tileset-create",
      body: {
        relativePath: "../other-game/foreign.tsj",
        kind: "atlas",
        name: "Foreign",
        image: "../other-game/images/foreign.png",
        tilewidth: 16,
        tileheight: 16,
      },
    },
  );
  assert.equal(unsafeTilesetCreate.response.status, 400, JSON.stringify(unsafeTilesetCreate.data));

  const atlasPath = path.join(project, "tiles", "terrain.tsj");
  const atlasDocument = JSON.parse(await fs.readFile(atlasPath, "utf8"));
  atlasDocument.wflUnknownTilesetField = { preserved: true, padding: "t".repeat(300_000) };
  const originalAtlasSource = `${JSON.stringify(atlasDocument, null, 2)}\n`;
  await fs.writeFile(atlasPath, originalAtlasSource);
  const ownerTilesetEditor = "tileset-http-owner-window";
  const secondTilesetEditor = "tileset-http-second-window";
  const ownerTileset = await openTileset(
    baseUrl,
    ownerCookie,
    ownerProject.id,
    ownerTilesetEditor,
    "tiles/terrain.tsj",
  );
  const secondTileset = await openTileset(
    baseUrl,
    secondCookie,
    secondProject.id,
    secondTilesetEditor,
    "tiles/terrain.tsj",
  );
  assert.equal(ownerTileset.documentKind, "tileset");
  assert.equal(ownerTileset.version, sha256(Buffer.from(originalAtlasSource)));
  assert.equal(await readTiledSource(baseUrl, ownerCookie, ownerTilesetEditor, "map-tilesets", ownerTileset), originalAtlasSource);

  const referencedImage = await requestResource(
    baseUrl,
    ownerCookie,
    ownerTilesetEditor,
    ownerTileset.id,
    "images/terrain.png",
  );
  assert.equal(
    referencedImage.response.status,
    200,
    `${referencedImage.bytes.toString("utf8")}\nServer output:\n${serverOutput}`,
  );
  assert.deepEqual(referencedImage.bytes, await fs.readFile(terrainImagePath));
  const undeclaredImage = await requestResource(
    baseUrl,
    ownerCookie,
    ownerTilesetEditor,
    ownerTileset.id,
    "images/prop.png",
  );
  assert.equal(undeclaredImage.response.status, 403);
  const wrongTilesetWindow = await requestJson(
    baseUrl,
    `/api/map-tilesets/sessions/${encodeURIComponent(ownerTileset.id)}`,
    { cookie: ownerCookie, editorInstanceId: "tileset-http-wrong-window" },
  );
  assert.equal(wrongTilesetWindow.response.status, 404, JSON.stringify(wrongTilesetWindow.data));
  const wrongTilesetBrowser = await requestJson(
    baseUrl,
    `/api/map-tilesets/sessions/${encodeURIComponent(ownerTileset.id)}`,
    { cookie: secondCookie, editorInstanceId: ownerTilesetEditor },
  );
  assert.equal(wrongTilesetBrowser.response.status, 404, JSON.stringify(wrongTilesetBrowser.data));
  const crossProjectTileset = await requestJson(baseUrl, "/api/map-tilesets/sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-tileset-session-open",
    body: {
      projectSessionId: foreignProject.id,
      path: "../game/tiles/terrain.tsj",
      editorInstanceId: "tileset-http-foreign-window",
    },
  });
  assert.equal(crossProjectTileset.response.status, 400, JSON.stringify(crossProjectTileset.data));

  const nextOwnerAtlas = structuredClone(atlasDocument);
  nextOwnerAtlas.tileoffset = { x: -2, y: 4 };
  nextOwnerAtlas.wflUnknownTilesetField.savedBy = "owner-window";
  const ownerAtlasBytes = Buffer.from(`${JSON.stringify(nextOwnerAtlas, null, 2)}\n`);
  const nextSecondAtlas = structuredClone(atlasDocument);
  nextSecondAtlas.tileoffset = { x: 8, y: 0 };
  const secondAtlasBytes = Buffer.from(`${JSON.stringify(nextSecondAtlas, null, 2)}\n`);
  const ownerTilesetSave = await beginTilesetSave(
    baseUrl,
    ownerCookie,
    ownerTilesetEditor,
    ownerTileset,
    ownerAtlasBytes,
  );
  const secondTilesetSave = await beginTilesetSave(
    baseUrl,
    secondCookie,
    secondTilesetEditor,
    secondTileset,
    secondAtlasBytes,
  );
  assert.equal(ownerTilesetSave.documentKind, "tileset");
  assert.equal(ownerTilesetSave.tilesetSessionId, ownerTileset.id);
  assert.ok(ownerTilesetSave.chunkCount > 1);
  const tilesetSaveThroughMapRoute = await requestJson(
    baseUrl,
    `/api/maps/save-sessions/${encodeURIComponent(ownerTilesetSave.id)}`,
    { cookie: ownerCookie, editorInstanceId: ownerTilesetEditor },
  );
  assert.equal(tilesetSaveThroughMapRoute.response.status, 404, JSON.stringify(tilesetSaveThroughMapRoute.data));
  const tilesetSaveThroughWorldRoute = await requestJson(
    baseUrl,
    `/api/map-worlds/save-sessions/${encodeURIComponent(ownerTilesetSave.id)}`,
    { cookie: ownerCookie, editorInstanceId: ownerTilesetEditor },
  );
  assert.equal(tilesetSaveThroughWorldRoute.response.status, 404, JSON.stringify(tilesetSaveThroughWorldRoute.data));
  await uploadSaveChunks(baseUrl, ownerCookie, ownerTilesetEditor, "map-tilesets", ownerTilesetSave, ownerAtlasBytes);
  await uploadSaveChunks(baseUrl, secondCookie, secondTilesetEditor, "map-tilesets", secondTilesetSave, secondAtlasBytes);
  const committedTileset = await requestJson(
    baseUrl,
    `/api/map-tilesets/save-sessions/${encodeURIComponent(ownerTilesetSave.id)}/commit`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-tileset-save-commit",
      editorInstanceId: ownerTilesetEditor,
    },
  );
  assert.equal(committedTileset.response.status, 200, diagnostic(committedTileset, serverOutput));
  assert.equal(committedTileset.data.result.tilesetSessionId, ownerTileset.id);
  assert.equal(committedTileset.data.result.version, sha256(ownerAtlasBytes));
  assert.deepEqual(await fs.readFile(atlasPath), ownerAtlasBytes);
  assert.deepEqual(await fs.readFile(terrainImagePath), referencedImage.bytes);
  const staleTilesetCommit = await requestJson(
    baseUrl,
    `/api/map-tilesets/save-sessions/${encodeURIComponent(secondTilesetSave.id)}/commit`,
    {
      method: "POST",
      cookie: secondCookie,
      action: "map-tileset-save-commit",
      editorInstanceId: secondTilesetEditor,
    },
  );
  assert.equal(staleTilesetCommit.response.status, 409, JSON.stringify(staleTilesetCommit.data));
  assert.equal(staleTilesetCommit.data.code, "map-version-conflict");
  const abortedStaleTileset = await requestJson(
    baseUrl,
    `/api/map-tilesets/save-sessions/${encodeURIComponent(secondTilesetSave.id)}`,
    {
      method: "DELETE",
      cookie: secondCookie,
      action: "map-tileset-save-abort",
      editorInstanceId: secondTilesetEditor,
    },
  );
  assert.equal(abortedStaleTileset.response.status, 204, JSON.stringify(abortedStaleTileset.data));

  const created = await requestJson(
    baseUrl,
    `/api/map-projects/sessions/${encodeURIComponent(ownerProject.id)}/worlds`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-project-world-create",
      body: {
        relativePath: "worlds/main.world",
        maps: [
          { path: "maps/first.tmj", x: 0, y: 0, width: 64, height: 64 },
          { path: "maps/second.tmj", x: 64, y: 0, width: 64, height: 64 },
        ],
        patterns: [{
          regexp: "region-(\\d+)-(\\d+)\\.tmj",
          multiplierX: 64,
          multiplierY: 64,
          offsetX: 0,
          offsetY: 0,
          mapWidth: 64,
          mapHeight: 64,
        }],
        onlyShowAdjacentMaps: true,
      },
    },
  );
  assert.equal(created.response.status, 201, diagnostic(created, serverOutput));
  assert.equal(created.data.world.relativePath, "worlds/main.world");
  assert.equal(created.data.world.mapCount, 2);
  assert.equal(created.data.world.onlyShowAdjacentMaps, true);

  const worldPath = path.join(project, "worlds", "main.world");
  const createdDocument = JSON.parse(await fs.readFile(worldPath, "utf8"));
  assert.deepEqual(createdDocument.maps.map((entry) => entry.fileName), [
    "../maps/first.tmj",
    "../maps/second.tmj",
  ]);
  createdDocument.wflUnknownWorldField = {
    preserved: true,
    padding: "x".repeat(300_000),
  };
  const originalWorldSource = `${JSON.stringify(createdDocument, null, 2)}\n`;
  await fs.writeFile(worldPath, originalWorldSource);

  const ownerEditor = "world-http-owner-window";
  const secondEditor = "world-http-second-window";
  const ownerWorld = await openWorld(
    baseUrl,
    ownerCookie,
    ownerProject.id,
    ownerEditor,
    "worlds/main.world",
  );
  const secondWorld = await openWorld(
    baseUrl,
    secondCookie,
    secondProject.id,
    secondEditor,
    "worlds/main.world",
  );
  assert.equal(ownerWorld.documentKind, "world");
  assert.equal(ownerWorld.version, sha256(Buffer.from(originalWorldSource)));
  assert.equal(ownerWorld.firstChunk.eof, false);
  const streamed = await readWorldSource(baseUrl, ownerCookie, ownerEditor, ownerWorld);
  assert.equal(streamed, originalWorldSource);
  assert.equal(JSON.parse(streamed).wflUnknownWorldField.preserved, true);

  const wrongWindow = await requestJson(
    baseUrl,
    `/api/map-worlds/sessions/${encodeURIComponent(ownerWorld.id)}`,
    { cookie: ownerCookie, editorInstanceId: "world-http-wrong-window" },
  );
  assert.equal(wrongWindow.response.status, 404, JSON.stringify(wrongWindow.data));
  const wrongBrowser = await requestJson(
    baseUrl,
    `/api/map-worlds/sessions/${encodeURIComponent(ownerWorld.id)}`,
    { cookie: secondCookie, editorInstanceId: ownerEditor },
  );
  assert.equal(wrongBrowser.response.status, 404, JSON.stringify(wrongBrowser.data));
  const crossProjectOpen = await requestJson(baseUrl, "/api/map-worlds/sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-world-session-open",
    body: {
      projectSessionId: foreignProject.id,
      path: "../game/worlds/main.world",
      editorInstanceId: "world-http-foreign-window",
    },
  });
  assert.equal(crossProjectOpen.response.status, 400, JSON.stringify(crossProjectOpen.data));

  const nextOwnerDocument = structuredClone(createdDocument);
  nextOwnerDocument.maps[0].x = -128;
  nextOwnerDocument.wflUnknownWorldField.savedBy = "owner-window";
  const ownerBytes = Buffer.from(`${JSON.stringify(nextOwnerDocument, null, 2)}\n`);
  const nextSecondDocument = structuredClone(createdDocument);
  nextSecondDocument.maps[1].y = 192;
  const secondBytes = Buffer.from(`${JSON.stringify(nextSecondDocument, null, 2)}\n`);
  const ownerSave = await beginWorldSave(baseUrl, ownerCookie, ownerEditor, ownerWorld, ownerBytes);
  const secondSave = await beginWorldSave(baseUrl, secondCookie, secondEditor, secondWorld, secondBytes);
  assert.equal(ownerSave.documentKind, "world");
  assert.equal(ownerSave.worldSessionId, ownerWorld.id);
  assert.ok(ownerSave.chunkCount > 1);

  const worldSaveThroughMapRoute = await requestJson(
    baseUrl,
    `/api/maps/save-sessions/${encodeURIComponent(ownerSave.id)}`,
    { cookie: ownerCookie, editorInstanceId: ownerEditor },
  );
  assert.equal(worldSaveThroughMapRoute.response.status, 404, JSON.stringify(worldSaveThroughMapRoute.data));

  await uploadSaveChunks(baseUrl, ownerCookie, ownerEditor, "map-worlds", ownerSave, ownerBytes);
  await uploadSaveChunks(baseUrl, secondCookie, secondEditor, "map-worlds", secondSave, secondBytes);
  const committed = await requestJson(
    baseUrl,
    `/api/map-worlds/save-sessions/${encodeURIComponent(ownerSave.id)}/commit`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-world-save-commit",
      editorInstanceId: ownerEditor,
    },
  );
  assert.equal(committed.response.status, 200, diagnostic(committed, serverOutput));
  assert.equal(committed.data.result.documentKind, "world");
  assert.equal(committed.data.result.worldSessionId, ownerWorld.id);
  assert.equal(committed.data.result.version, sha256(ownerBytes));
  assert.equal(committed.data.session.version, sha256(ownerBytes));
  assert.deepEqual(await fs.readFile(worldPath), ownerBytes);
  assert.equal(await fs.readFile(firstMapPath, "utf8"), firstMapSource);
  assert.equal(await fs.readFile(secondMapPath, "utf8"), secondMapSource);

  const staleCommit = await requestJson(
    baseUrl,
    `/api/map-worlds/save-sessions/${encodeURIComponent(secondSave.id)}/commit`,
    {
      method: "POST",
      cookie: secondCookie,
      action: "map-world-save-commit",
      editorInstanceId: secondEditor,
    },
  );
  assert.equal(staleCommit.response.status, 409, JSON.stringify(staleCommit.data));
  assert.equal(staleCommit.data.code, "map-version-conflict");
  assert.deepEqual(await fs.readFile(worldPath), ownerBytes);
  const abortedStale = await requestJson(
    baseUrl,
    `/api/map-worlds/save-sessions/${encodeURIComponent(secondSave.id)}`,
    {
      method: "DELETE",
      cookie: secondCookie,
      action: "map-world-save-abort",
      editorInstanceId: secondEditor,
    },
  );
  assert.equal(abortedStale.response.status, 204, JSON.stringify(abortedStale.data));

  const mapEditor = "map-http-route-isolation";
  const mapOpened = await requestJson(baseUrl, "/api/maps/sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-session-open",
    body: {
      projectSessionId: ownerProject.id,
      path: "maps/first.tmj",
      editorInstanceId: mapEditor,
    },
  });
  assert.equal(mapOpened.response.status, 201, diagnostic(mapOpened, serverOutput));
  const mapSession = mapOpened.data.session;
  const mapBytes = Buffer.from(firstMapSource);
  const mapSaveStarted = await requestJson(baseUrl, "/api/maps/save-sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-save-start",
    editorInstanceId: mapEditor,
    body: {
      mapSessionId: mapSession.id,
      expectedVersion: mapSession.version,
      totalBytes: mapBytes.length,
      totalHash: sha256(mapBytes),
      clientOperationId: crypto.randomUUID(),
    },
  });
  assert.equal(mapSaveStarted.response.status, 201, diagnostic(mapSaveStarted, serverOutput));
  const mapSave = mapSaveStarted.data.save;
  const mapSaveThroughWorldRoute = await requestJson(
    baseUrl,
    `/api/map-worlds/save-sessions/${encodeURIComponent(mapSave.id)}`,
    { cookie: ownerCookie, editorInstanceId: mapEditor },
  );
  assert.equal(mapSaveThroughWorldRoute.response.status, 404, JSON.stringify(mapSaveThroughWorldRoute.data));
  const worldSessionThroughMapSave = await requestJson(baseUrl, "/api/maps/save-sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-save-start",
    editorInstanceId: ownerEditor,
    body: {
      mapSessionId: ownerWorld.id,
      expectedVersion: committed.data.result.version,
      totalBytes: ownerBytes.length,
      totalHash: sha256(ownerBytes),
      clientOperationId: crypto.randomUUID(),
    },
  });
  assert.equal(worldSessionThroughMapSave.response.status, 404, JSON.stringify(worldSessionThroughMapSave.data));

  const worldAsAiMap = await requestJson(
    baseUrl,
    `/api/maps/sessions/${encodeURIComponent(ownerWorld.id)}/ai-leases`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-ai-lease-grant",
      editorInstanceId: ownerEditor,
      body: { threadId: "thread_world_http", editorStateId: 0, allowedOps: ["get_map_context"] },
    },
  );
  assert.equal(worldAsAiMap.response.status, 404, JSON.stringify(worldAsAiMap.data));
  const worldAsImageMap = await requestJson(
    baseUrl,
    `/api/maps/sessions/${encodeURIComponent(ownerWorld.id)}/image-jobs`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-image-start",
      editorInstanceId: ownerEditor,
      body: {
        expectedVersion: committed.data.result.version,
        request: { operation: "generate", prompt: "must not run for World" },
      },
    },
  );
  assert.equal(worldAsImageMap.response.status, 404, JSON.stringify(worldAsImageMap.data));
  const worldAsRenderMap = await requestJson(baseUrl, "/api/maps/render-jobs", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-render-start",
    editorInstanceId: ownerEditor,
    body: {
      mapSessionId: ownerWorld.id,
      expectedVersion: committed.data.result.version,
      kind: "screenshot",
      clientOperationId: crypto.randomUUID(),
      outputRoot: "renders",
      spec: {},
    },
  });
  assert.equal(worldAsRenderMap.response.status, 404, JSON.stringify(worldAsRenderMap.data));

  const abortedMap = await requestJson(
    baseUrl,
    `/api/maps/save-sessions/${encodeURIComponent(mapSave.id)}`,
    {
      method: "DELETE",
      cookie: ownerCookie,
      action: "map-save-abort",
      editorInstanceId: mapEditor,
    },
  );
  assert.equal(abortedMap.response.status, 204, JSON.stringify(abortedMap.data));
});

async function openProject(baseUrl, cookie, project) {
  const opened = await requestJson(baseUrl, "/api/map-projects/sessions", {
    method: "POST",
    cookie,
    action: "map-project-session-open",
    body: { project },
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  return opened.data.session;
}

async function openWorld(baseUrl, cookie, projectSessionId, editorInstanceId, relativePath) {
  const opened = await requestJson(baseUrl, "/api/map-worlds/sessions", {
    method: "POST",
    cookie,
    action: "map-world-session-open",
    body: { projectSessionId, path: relativePath, editorInstanceId },
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  return opened.data.session;
}

async function openTileset(baseUrl, cookie, projectSessionId, editorInstanceId, relativePath) {
  const opened = await requestJson(baseUrl, "/api/map-tilesets/sessions", {
    method: "POST",
    cookie,
    action: "map-tileset-session-open",
    body: { projectSessionId, path: relativePath, editorInstanceId },
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  return opened.data.session;
}

async function readTiledSource(baseUrl, cookie, editorInstanceId, route, session) {
  let content = session.firstChunk.content;
  let chunk = session.firstChunk;
  while (!chunk.eof) {
    const read = await requestJson(
      baseUrl,
      `/api/${route}/sessions/${encodeURIComponent(session.id)}/content?version=${encodeURIComponent(session.version)}&offset=${chunk.nextOffset}`,
      { cookie, editorInstanceId },
    );
    assert.equal(read.response.status, 200, JSON.stringify(read.data));
    chunk = read.data;
    content += chunk.content;
  }
  return content;
}

async function requestResource(baseUrl, cookie, editorInstanceId, sessionId, resourcePath) {
  const response = await fetch(
    `${baseUrl}/api/map-tilesets/sessions/${encodeURIComponent(sessionId)}/resource?path=${encodeURIComponent(resourcePath)}`,
    {
      headers: {
        Cookie: cookie,
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
    },
  );
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function readWorldSource(baseUrl, cookie, editorInstanceId, session) {
  let content = session.firstChunk.content;
  let chunk = session.firstChunk;
  while (!chunk.eof) {
    const read = await requestJson(
      baseUrl,
      `/api/map-worlds/sessions/${encodeURIComponent(session.id)}/content?version=${encodeURIComponent(session.version)}&offset=${chunk.nextOffset}`,
      { cookie, editorInstanceId },
    );
    assert.equal(read.response.status, 200, JSON.stringify(read.data));
    chunk = read.data;
    content += chunk.content;
  }
  return content;
}

async function beginWorldSave(baseUrl, cookie, editorInstanceId, session, bytes) {
  const started = await requestJson(baseUrl, "/api/map-worlds/save-sessions", {
    method: "POST",
    cookie,
    action: "map-world-save-start",
    editorInstanceId,
    body: {
      worldSessionId: session.id,
      expectedVersion: session.version,
      totalBytes: bytes.length,
      totalHash: sha256(bytes),
      clientOperationId: crypto.randomUUID(),
    },
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.data));
  return started.data.save;
}

async function beginTilesetSave(baseUrl, cookie, editorInstanceId, session, bytes) {
  const started = await requestJson(baseUrl, "/api/map-tilesets/save-sessions", {
    method: "POST",
    cookie,
    action: "map-tileset-save-start",
    editorInstanceId,
    body: {
      tilesetSessionId: session.id,
      expectedVersion: session.version,
      totalBytes: bytes.length,
      totalHash: sha256(bytes),
      clientOperationId: crypto.randomUUID(),
    },
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.data));
  return started.data.save;
}

async function uploadSaveChunks(baseUrl, cookie, editorInstanceId, route, save, bytes) {
  for (let index = 0; index < save.chunkCount; index += 1) {
    const start = index * save.config.chunkBytes;
    const chunk = bytes.subarray(start, Math.min(bytes.length, start + save.config.chunkBytes));
    const response = await fetch(
      `${baseUrl}/api/${route}/save-sessions/${encodeURIComponent(save.id)}/chunks/${index}`,
      {
        method: "PUT",
        headers: {
          Cookie: cookie,
          Origin: baseUrl,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.length),
          "X-Codex-Desktop-Action": route === "map-worlds"
            ? "map-world-save-chunk"
            : route === "map-tilesets"
              ? "map-tileset-save-chunk"
              : "map-save-chunk",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
          "X-Content-SHA256": sha256(chunk),
        },
        body: chunk,
      },
    );
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.chunk.index, index);
  }
}

async function requestJson(baseUrl, pathname, {
  method = "GET",
  authorization = null,
  cookie = null,
  action = null,
  body = undefined,
  editorInstanceId = null,
} = {}) {
  const headers = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers.Origin = baseUrl;
  if (action) headers["X-Codex-Desktop-Action"] = action;
  if (editorInstanceId) headers["X-Codex-Desktop-Editor-Instance"] = editorInstanceId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  return { response, data };
}

function tiledMapSource(name) {
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
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [{
      id: 1,
      name,
      type: "tilelayer",
      width: 4,
      height: 4,
      data: Array(16).fill(0),
    }],
    tilesets: [],
  }, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

function diagnostic(result, serverOutput) {
  return `${JSON.stringify(result.data)}\nServer output:\n${serverOutput}`;
}

function waitForServer(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    const onStdout = (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      processHandle.stdout.off("data", onStdout);
      resolve();
    };
    processHandle.stdout.on("data", onStdout);
    processHandle.stderr.on("data", (chunk) => { output += chunk; });
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

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
