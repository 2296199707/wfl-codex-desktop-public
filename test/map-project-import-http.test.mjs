import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";
import sharp from "sharp";

const repository = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const TERRAIN_IMAGE = await sharp({
  create: { width: 16, height: 16, channels: 4, background: { r: 38, g: 116, b: 82, alpha: 1 } },
}).png().toBuffer();

test("cross-project import HTTP flow stays browser/user/folders/write scoped and confirms an unchanged plan", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-import-http-"));
  const projectRoot = path.join(root, "projects");
  const sourceProject = path.join(projectRoot, "source-game");
  const targetProject = path.join(projectRoot, "target-game");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const codexHome = path.join(root, "codex-home");
  const usersRoot = path.join(root, "users");
  const authFile = path.join(root, "auth.json");
  const fakeSystemctl = path.join(root, "systemctl.cjs");
  const username = "owner";
  const password = "map-import-http-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  await Promise.all([
    fs.mkdir(path.join(sourceProject, "assets"), { recursive: true }),
    fs.mkdir(path.join(targetProject, "imports"), { recursive: true }),
    fs.mkdir(path.join(targetProject, "outside"), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(usersRoot, { recursive: true }),
  ]);
  const sourceProjectFile = `${JSON.stringify({ folders: ["assets"] }, null, 2)}\n`;
  const targetProjectFile = `${JSON.stringify({ folders: ["imports"] }, null, 2)}\n`;
  const sourceTileset = (marker = "v1") => `${JSON.stringify({
    type: "tileset",
    version: "1.12",
    tiledversion: "1.12.2",
    name: `Terrain-${marker}`,
    columns: 1,
    tilecount: 1,
    tilewidth: 16,
    tileheight: 16,
    image: "terrain.png",
    imagewidth: 16,
    imageheight: 16,
  }, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(path.join(sourceProject, "game.tiled-project"), sourceProjectFile),
    fs.writeFile(path.join(targetProject, "game.tiled-project"), targetProjectFile),
    fs.writeFile(path.join(sourceProject, "assets/terrain.tsj"), sourceTileset()),
    fs.writeFile(path.join(sourceProject, "assets/terrain.png"), TERRAIN_IMAGE),
    fs.writeFile(path.join(targetProject, "imports/conflict.tsj"), "different target bytes\n"),
    fs.writeFile(fakeSystemctl, "#!/usr/bin/env node\nprocess.exit(3);\n", { mode: 0o700 }),
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
      CODEX_DESKTOP_DEFAULT_PROJECT: sourceProject,
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

  const enabled = await requestJson(baseUrl, "/api/multi-user/enable", {
    method: "POST",
    authorization,
    action: "multi-user-enable",
    body: { password },
  });
  assert.equal(enabled.response.status, 202, diagnostic(enabled, serverOutput));
  const ownerCookie = cookieFrom(enabled.response);
  const secondLogin = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    action: "login",
    body: { username, password },
  });
  assert.equal(secondLogin.response.status, 200, diagnostic(secondLogin, serverOutput));
  const secondCookie = cookieFrom(secondLogin.response);
  assert.notEqual(secondCookie, ownerCookie);

  const invite = await requestJson(baseUrl, "/api/multi-user/invites", {
    method: "POST",
    cookie: ownerCookie,
    action: "multi-user-invite",
    body: { role: "member", quotaBytes: 1024 * 1024 * 1024, expiresHours: 2 },
  });
  assert.equal(invite.response.status, 201, diagnostic(invite, serverOutput));
  const registered = await requestJson(baseUrl, "/api/auth/register", {
    method: "POST",
    action: "register",
    body: {
      invite: invite.data.invite.token,
      username: "member.import",
      displayName: "Import Member",
      password: "member-import-password-1234",
    },
  });
  assert.equal(registered.response.status, 201, diagnostic(registered, serverOutput));
  const memberCookie = cookieFrom(registered.response);

  const sourceSession = await openProject(baseUrl, ownerCookie, sourceProject);
  const targetSession = await openProject(baseUrl, ownerCookie, targetProject);
  const requestBody = {
    sourceProjectSessionId: sourceSession.id,
    sourcePath: "assets/terrain.tsj",
    targetPath: "imports/terrain.tsj",
  };

  const crossBrowser = await importResource(baseUrl, secondCookie, targetSession.id, requestBody);
  assert.equal(crossBrowser.response.status, 404, diagnostic(crossBrowser, serverOutput));
  const crossUser = await importResource(baseUrl, memberCookie, targetSession.id, requestBody);
  assert.equal(crossUser.response.status, 404, diagnostic(crossUser, serverOutput));
  const outsideFolders = await importResource(baseUrl, ownerCookie, targetSession.id, {
    ...requestBody,
    targetPath: "outside/terrain.tsj",
  });
  assert.equal(outsideFolders.response.status, 403, diagnostic(outsideFolders, serverOutput));

  const planned = await importResource(baseUrl, ownerCookie, targetSession.id, requestBody);
  assert.equal(planned.response.status, 200, diagnostic(planned, serverOutput));
  assert.equal(planned.data.requiresConfirmation, true);
  assert.equal(planned.data.plan.copyCount, 2);
  await fs.writeFile(path.join(sourceProject, "assets/terrain.tsj"), sourceTileset("v2"));
  const staleConfirmation = await importResource(baseUrl, ownerCookie, targetSession.id, {
    ...requestBody,
    confirmation: true,
    planHash: planned.data.plan.planHash,
  });
  assert.equal(staleConfirmation.response.status, 409, diagnostic(staleConfirmation, serverOutput));
  assert.equal(await fs.lstat(path.join(targetProject, "imports/terrain.tsj")).catch(() => null), null);

  const refreshed = await importResource(baseUrl, ownerCookie, targetSession.id, requestBody);
  assert.equal(refreshed.response.status, 200, diagnostic(refreshed, serverOutput));
  assert.notEqual(refreshed.data.plan.planHash, planned.data.plan.planHash);
  const committed = await importResource(baseUrl, ownerCookie, targetSession.id, {
    ...requestBody,
    confirmation: true,
    planHash: refreshed.data.plan.planHash,
  });
  assert.equal(committed.response.status, 201, diagnostic(committed, serverOutput));
  assert.equal(committed.data.published.length, 2);
  const copiedTileset = JSON.parse(await fs.readFile(path.join(targetProject, "imports/terrain.tsj"), "utf8"));
  assert.equal(copiedTileset.name, "Terrain-v2");
  assert.equal(copiedTileset.image, "_deps/game/assets/terrain.png");
  assert.deepEqual(await fs.readFile(path.join(targetProject, "imports/_deps/game/assets/terrain.png")), TERRAIN_IMAGE);

  const conflicting = await importResource(baseUrl, ownerCookie, targetSession.id, {
    ...requestBody,
    targetPath: "imports/conflict.tsj",
  });
  assert.equal(conflicting.response.status, 409, diagnostic(conflicting, serverOutput));
  assert.equal(await fs.readFile(path.join(targetProject, "imports/conflict.tsj"), "utf8"), "different target bytes\n");

  const memberUpdated = await requestJson(
    baseUrl,
    `/api/multi-user/users/${encodeURIComponent(registered.data.user.id)}`,
    {
      method: "PATCH",
      cookie: ownerCookie,
      action: "multi-user-user-update",
      body: {
        permissions: {
          ...registered.data.user.permissions,
          projectSharing: true,
        },
      },
    },
  );
  assert.equal(memberUpdated.response.status, 200, diagnostic(memberUpdated, serverOutput));
  const shared = await requestJson(baseUrl, "/api/multi-user/shares", {
    method: "POST",
    cookie: ownerCookie,
    action: "multi-user-project-share",
    body: { projectPath: targetProject, targetUserId: registered.data.user.id, access: "read" },
  });
  assert.equal(shared.response.status, 201, diagnostic(shared, serverOutput));
  const readOnlyTarget = await openProject(baseUrl, memberCookie, targetProject);
  assert.equal(readOnlyTarget.writable, false);
  const readOnlyImport = await importResource(baseUrl, memberCookie, readOnlyTarget.id, {
    sourceProjectSessionId: "missing-source-session",
    sourcePath: "assets/terrain.tsj",
    targetPath: "imports/read-only.tsj",
  });
  assert.equal(readOnlyImport.response.status, 403, diagnostic(readOnlyImport, serverOutput));
  assert.equal(await fs.lstat(path.join(targetProject, "imports/read-only.tsj")).catch(() => null), null);
});

async function openProject(baseUrl, cookie, project) {
  const opened = await requestJson(baseUrl, "/api/map-projects/sessions", {
    method: "POST",
    cookie,
    action: "map-project-session-open",
    body: { project, projectFile: "game.tiled-project" },
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  return opened.data.session;
}

function importResource(baseUrl, cookie, targetSessionId, body) {
  return requestJson(
    baseUrl,
    `/api/map-projects/sessions/${encodeURIComponent(targetSessionId)}/imports`,
    { method: "POST", cookie, action: "map-project-import", body },
  );
}

async function requestJson(baseUrl, pathname, {
  method = "GET",
  authorization = null,
  cookie = null,
  action = null,
  body = undefined,
} = {}) {
  const headers = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers.Origin = baseUrl;
  if (action) headers["X-Codex-Desktop-Action"] = action;
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
