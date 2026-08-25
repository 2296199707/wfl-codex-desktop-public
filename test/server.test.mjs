import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";
import { DeploymentCancelStore } from "../lib/deployment-cancel.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";
import { WorkspaceMigrationCenter } from "../lib/workspace-migration.mjs";

const appPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const serverSource = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
const VALID_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("map resources are reclaimed for one logout and for every account-wide revocation path", () => {
  const logout = serverSource.slice(
    serverSource.indexOf('app.post("/api/auth/logout"'),
    serverSource.indexOf('app.get("/api/account"'),
  );
  assert.match(logout, /scheduleMapBrowserSessionResourceRelease/u);
  assert.match(logout, /mapAiAccess\?\.revokeForBrowserSession/u);

  const disconnectUser = serverSource.slice(
    serverSource.indexOf("function disconnectAuthenticatedUserSockets"),
    serverSource.indexOf("function disconnectAllAuthenticatedSessionSockets"),
  );
  assert.match(disconnectUser, /scheduleMapUserResourceRelease/u);
  assert.match(serverSource, /mapImageJobs\?\.cancelForUser/u);
  assert.match(serverSource, /mapRenderJobs\?\.cancelForUser/u);
  assert.match(serverSource, /mapSaveSessions\?\.closeForUser/u);
  assert.match(serverSource, /mapImageInputs\?\.deleteForUser/u);
  assert.match(serverSource, /mapFileSessions\?\.closeForUser/u);
  assert.match(serverSource, /worldFileSessions\?\.closeForUser/u);
  assert.match(serverSource, /tilesetFileSessions\?\.closeForUser/u);
  assert.match(serverSource, /mapProjectSessions\?\.closeForUser/u);
});

let child;
let baseUrl;
let projectRoot;
let secondaryProjectRoot;
let defaultProject;
let managedUsersRoot;
let ownerCodexHome;
let stateDirectory;
let runtimeDirectory;
let authorization;

before(async () => {
  projectRoot = await fs.mkdtemp("/tmp/wfl-codex-desktop-test-");
  secondaryProjectRoot = await fs.mkdtemp("/tmp/wfl-codex-desktop-data-test-");
  defaultProject = path.join(projectRoot, "default-project");
  managedUsersRoot = path.join(projectRoot, "managed-users");
  ownerCodexHome = await fs.mkdtemp("/tmp/wfl-codex-home-test-");
  stateDirectory = path.join(projectRoot, "desktop-state");
  runtimeDirectory = path.join(projectRoot, "desktop-runtime");
  await Promise.all([fs.mkdir(defaultProject), fs.mkdir(managedUsersRoot), fs.mkdir(runtimeDirectory)]);
  await Promise.all([
    fs.writeFile(path.join(defaultProject, "VERSION"), `${appPackage.version}\n`),
    fs.writeFile(path.join(defaultProject, "CHANGELOG.md"), "# Test source changelog\n"),
  ]);
  const fakeSystemctl = path.join(projectRoot, "systemctl.cjs");
  await fs.writeFile(fakeSystemctl, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const active = args[0] === 'is-active' && args.at(-1) === 'wfl-codex-desktop-gateway.service';",
    "process.exit(active ? 0 : 3);",
    "",
  ].join("\n"), { mode: 0o700 });
  const authFile = path.join(projectRoot, "auth.json");
  const username = "codex";
  const password = "correct-horse-battery-staple";
  authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  await writeAuth(authFile, createAuthRecord(username, password));
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_PROJECT_ROOTS: `${projectRoot}:${secondaryProjectRoot}`,
      CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
      CODEX_DESKTOP_MULTI_USER_ROOT: managedUsersRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: ownerCodexHome,
      CODEX_DESKTOP_DISABLE_CODEX: "1",
      CODEX_DESKTOP_IMAGE_WORKER_DIRECT: "1",
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: defaultProject,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_BACKEND_ENTRY: "",
      CODEX_DESKTOP_SYSTEMCTL: fakeSystemctl,
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_ORPHAN_ADMISSION_GRACE_MS: "50",
      CODEX_DESKTOP_ORPHAN_ADMISSION_MAX_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child, "WFL Codex Desktop v");
});

after(async () => {
  child?.kill("SIGTERM");
  await Promise.all([
    fs.rm(projectRoot, { recursive: true, force: true }),
    fs.rm(secondaryProjectRoot, { recursive: true, force: true }),
    fs.rm(ownerCodexHome, { recursive: true, force: true }),
  ]);
});

test("reports health and scans the configured project root", async () => {
  const health = await fetchJson(`${baseUrl}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.data.version, appPackage.version);
  assert.equal(health.data.projectRoot, projectRoot);
  assert.equal(health.data.codexReady, false);

  const projects = await fetchJson(`${baseUrl}/api/projects`);
  assert.equal(projects.response.status, 200);
  assert.equal(projects.data.projects[0].name, "Codex Desktop");
  assert.equal(projects.data.projects.some((project) => project.path === managedUsersRoot), false);
});

test("exposes the global server file manager only through the administrator boundary", async () => {
  const unauthenticated = await fetch(`${baseUrl}/server-files.html`);
  assert.equal(unauthenticated.status, 401);

  const page = await fetch(`${baseUrl}/server-files.html`, { headers: { Authorization: authorization } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /服务器文件管理器/u);

  const status = await fetchJson(`${baseUrl}/api/tools/server-files/status`);
  assert.equal(status.response.status, 200);
  assert.equal(status.data.root, path.parse(process.cwd()).root);

  const name = `server-file-manager-http-${process.pid}-${Date.now()}.txt`;
  const target = path.join(projectRoot, name);
  const uploadName = `server-file-manager-upload-${process.pid}-${Date.now()}.bin`;
  const uploadTarget = path.join(projectRoot, uploadName);
  try {
    const created = await fetchJson(`${baseUrl}/api/tools/server-files/action`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "server-files-action",
      },
      body: JSON.stringify({ action: "create", parentPath: projectRoot, name, type: "file" }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));

    const read = await fetchJson(`${baseUrl}/api/tools/server-files/read?${new URLSearchParams({ path: target })}`);
    assert.equal(read.response.status, 200, JSON.stringify(read.data));
    const saved = await fetchJson(`${baseUrl}/api/tools/server-files/write?${new URLSearchParams({ path: target })}`, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "text/plain; charset=utf-8",
        "X-Codex-Desktop-Action": "server-files-save",
        "X-Codex-Desktop-File-Version": read.data.version,
      },
      body: "global manager test",
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.data));

    const uploadUrl = new URL(`${baseUrl}/api/tools/server-files/upload`);
    uploadUrl.searchParams.set("path", projectRoot);
    uploadUrl.searchParams.set("name", uploadName);
    const uploaded = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: authorization,
        Origin: baseUrl,
        "Content-Type": "application/octet-stream",
        "X-Codex-Desktop-Action": "server-files-upload",
      },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(uploaded.status, 201, `upload status ${uploaded.status}`);

    const downloadUrl = new URL(`${baseUrl}/api/tools/server-files/download`);
    downloadUrl.searchParams.set("path", uploadTarget);
    const downloaded = await fetch(downloadUrl, { headers: { Authorization: authorization } });
    assert.equal(downloaded.status, 200, `download status ${downloaded.status}`);
    assert.match(downloaded.headers.get("content-disposition") || "", /attachment/u);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from([0, 1, 2, 3]));

    const deleted = await fetchJson(`${baseUrl}/api/tools/server-files/action`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "server-files-action",
      },
      body: JSON.stringify({ action: "delete", path: target, confirmPath: target }),
    });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
  } finally {
    await fs.rm(target, { force: true });
    await fs.rm(uploadTarget, { force: true });
  }
});

test("treats a missing WebDAV destination as not found and permits its upload", async () => {
  const fileName = `webdav-regression-${process.pid}-${Date.now()}.txt`;
  const target = path.join(defaultProject, fileName);
  const url = `${baseUrl}/dav/${encodeURIComponent("Codex Desktop")}/${encodeURIComponent(fileName)}`;
  try {
    const missing = await fetch(url, {
      method: "PROPFIND",
      headers: { Authorization: authorization, Depth: "0" },
    });
    assert.equal(missing.status, 404, await missing.text());

    const uploaded = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/octet-stream",
      },
      body: "webdav regression",
    });
    assert.equal(uploaded.status, 201, await uploaded.text());
    assert.equal(await fs.readFile(target, "utf8"), "webdav regression");
  } finally {
    await fs.rm(target, { force: true });
  }
});

test("serves a lightweight account summary without storage or token usage", async () => {
  const summary = await fetchJson(`${baseUrl}/api/account?summary=1`);
  assert.equal(summary.response.status, 200);
  assert.equal(summary.data.summary, true);
  assert.equal(summary.data.user.role, "owner");
  assert.ok(summary.data.mode);
  for (const key of ["projectRoot", "quotaBytes", "usedBytes", "tokenUsage", "monthlyTokenUsage"]) {
    assert.equal(Object.hasOwn(summary.data, key), false, key);
  }

  const full = await fetchJson(`${baseUrl}/api/account`);
  assert.equal(full.response.status, 200);
  assert.equal(Object.hasOwn(full.data, "projectRoot"), true);
  assert.equal(Object.hasOwn(full.data, "tokenUsage"), true);
});

test("single-user account persists and applies its Codex thread limit", async () => {
  const initial = await fetchJson(`${baseUrl}/api/account`);
  const initialLimit = initial.data.user.effectiveCodexThreadLimit;
  const nextLimit = initialLimit === 8 ? 9 : 8;
  try {
    const updated = await fetchJson(`${baseUrl}/api/account`, {
      method: "PATCH",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "account-profile-update",
      },
      body: JSON.stringify({ codexThreadLimit: nextLimit }),
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.user.effectiveCodexThreadLimit, nextLimit);
    const reloaded = await fetchJson(`${baseUrl}/api/account`);
    assert.equal(reloaded.data.user.effectiveCodexThreadLimit, nextLimit);
  } finally {
    await fetchJson(`${baseUrl}/api/account`, {
      method: "PATCH",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "account-profile-update",
      },
      body: JSON.stringify({ codexThreadLimit: initialLimit }),
    });
  }
});

test("keeps map AI opt-in explicit and exposes no lease material in account settings", async () => {
  const initial = await fetchJson(`${baseUrl}/api/account/map-ai`);
  assert.equal(initial.response.status, 200, JSON.stringify(initial.data));
  assert.equal(initial.data.mapAiToolsEnabled, false);
  assert.deepEqual(initial.data.operations, ["get_map_context", "propose_tiled_patch"]);
  assert.equal(Object.hasOwn(initial.data, "leaseId"), false);
  assert.equal(Object.hasOwn(initial.data, "projectPath"), false);

  const enabled = await fetchJson(`${baseUrl}/api/account/map-ai`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-ai-setting",
    },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.mapAiToolsEnabled, true);

  const malformed = await fetchJson(`${baseUrl}/api/account/map-ai`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-ai-setting",
    },
    body: JSON.stringify({ enabled: true, leaseId: "must-not-be-accepted" }),
  });
  assert.equal(malformed.response.status, 400);

  const disabled = await fetchJson(`${baseUrl}/api/account/map-ai`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-ai-setting",
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.data));
  assert.equal(disabled.data.mapAiToolsEnabled, false);
});

test("administrators manage one global bounded conversation image preview preset", async () => {
  const initial = await fetchJson(`${baseUrl}/api/web/settings`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.settings.imagePreviewPreset, "standard");
  assert.equal(initial.data.settings.imagePreviewDisplaySize, "auto");
  assert.equal(initial.data.settings.imagePreviewDisplayWidth, 640);

  const unguarded = await fetchJson(`${baseUrl}/api/ops/web-settings`, {
    method: "PUT",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ imagePreviewPreset: "high", imagePreviewDisplaySize: "wide" }),
  });
  assert.equal(unguarded.response.status, 403);

  const updated = await fetchJson(`${baseUrl}/api/ops/web-settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-web-settings",
    },
    body: JSON.stringify({ imagePreviewPreset: "high", imagePreviewDisplaySize: "wide" }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.settings.imagePreviewPreset, "high");
  assert.equal(updated.data.settings.imagePreviewDisplaySize, "wide");

  const invalid = await fetchJson(`${baseUrl}/api/ops/web-settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-web-settings",
    },
    body: JSON.stringify({ imagePreviewPreset: "unbounded" }),
  });
  assert.equal(invalid.response.status, 400);

  const invalidSize = await fetchJson(`${baseUrl}/api/ops/web-settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-web-settings",
    },
    body: JSON.stringify({ imagePreviewDisplaySize: "unbounded" }),
  });
  assert.equal(invalidSize.response.status, 400);

  const restored = await fetchJson(`${baseUrl}/api/ops/web-settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-web-settings",
    },
    body: JSON.stringify({ imagePreviewPreset: "standard", imagePreviewDisplaySize: "auto" }),
  });
  assert.equal(restored.response.status, 200);
});

test("compresses versioned assets and keeps HTML and APIs out of persistent caches", async () => {
  const page = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const asset = await fetch(`${baseUrl}/styles.css?v=${appPackage.version}`, {
    headers: { Authorization: authorization, "Accept-Encoding": "gzip" },
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("content-encoding"), "gzip");
  assert.match(await asset.text(), /--font-ui/);

  const unversioned = await fetch(`${baseUrl}/styles.css`, { headers: { Authorization: authorization } });
  assert.equal(unversioned.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  const api = await fetchJson(`${baseUrl}/api/health`);
  assert.equal(api.response.headers.get("cache-control"), "no-store");
});

test("exposes candidate readiness only to direct loopback health checks", async () => {
  const direct = await fetch(`${baseUrl}/internal/ready`);
  assert.equal(direct.status, 200);
  const readiness = await direct.json();
  assert.equal(readiness.version, appPackage.version);
  assert.equal(readiness.codexReady, false);
  assert.equal(direct.headers.get("cache-control"), "no-store");

  const proxiedStatus = await requestStatus(`${baseUrl}/internal/ready`, {
    Host: "codex.example.test",
  });
  assert.equal(proxiedStatus, 401);
});

test("exposes main task control only to the selected backend with the rescue credential", async (t) => {
  const activePortFile = path.join(runtimeDirectory, "active-port");
  await fs.writeFile(activePortFile, `${new URL(baseUrl).port}\n`);
  t.after(() => fs.rm(activePortFile, { force: true }));
  const token = (await fs.readFile(path.join(stateDirectory, "session-token"), "utf8")).trim();
  const accepted = await fetch(`${baseUrl}/internal/rescue-control/tasks`, {
    headers: { "X-WFL-Rescue-Control": token },
  });
  assert.equal(accepted.status, 200);
  const snapshot = await accepted.json();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.tasks, []);

  const rejected = await fetch(`${baseUrl}/internal/rescue-control/tasks`, {
    headers: { "X-WFL-Rescue-Control": "invalid-rescue-control" },
  });
  assert.equal(rejected.status, 403);

  const proxied = await requestStatus(`${baseUrl}/internal/rescue-control/tasks`, {
    Host: "codex.example.test",
    "X-WFL-Rescue-Control": token,
  });
  assert.equal(proxied, 404);
});

test("rejects deep candidate readiness when Codex cannot list threads", async () => {
  const direct = await fetch(`${baseUrl}/internal/codex-ready`);
  assert.equal(direct.status, 503);
  assert.deepEqual(await direct.json(), {
    ok: false,
    version: appPackage.version,
    codexReady: false,
    threadListReady: false,
    runtimeBundleReady: false,
    codeModeHostReady: false,
  });

  const proxiedStatus = await requestStatus(`${baseUrl}/internal/codex-ready`, {
    Host: "codex.example.test",
  });
  assert.equal(proxiedStatus, 401);
});

test("reports the deployed application version without caching", async () => {
  const result = await fetchJson(`${baseUrl}/api/version`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.version, appPackage.version);
  assert.ok(result.data.changelog.includes(`## [${appPackage.version}]`));
  assert.match(result.data.releaseNotes, new RegExp(`^## \\[${appPackage.version.replaceAll(".", "\\.")}\\]`));
  assert.equal(result.data.canManageAnnouncement, true);
  assert.equal(result.data.announcement, null);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
});

test("administrators save private announcement drafts and explicitly publish or withdraw them", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/announcement/publish`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const missingMarker = await fetchJson(`${baseUrl}/api/announcement/draft`, {
    method: "PUT",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "update", title: "Version notice", body: "Draft only" }),
  });
  assert.equal(missingMarker.response.status, 403);

  const crossOrigin = await fetchJson(`${baseUrl}/api/announcement/draft`, {
    method: "PUT",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json", "X-Codex-Desktop-Action": "announcement-draft-save" },
    body: JSON.stringify({ category: "update", title: "Version notice", body: "Draft only" }),
  });
  assert.equal(crossOrigin.response.status, 403);

  const drafted = await fetchJson(`${baseUrl}/api/announcement/draft`, {
    method: "PUT",
    headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Codex-Desktop-Action": "announcement-draft-save" },
    body: JSON.stringify({ category: "update", title: "Version notice", body: "Draft only" }),
  });
  assert.equal(drafted.response.status, 200);
  assert.equal(drafted.data.published, null);
  assert.equal(drafted.data.draft.title, "Version notice");

  const beforePublish = await fetchJson(`${baseUrl}/api/version`);
  assert.equal(beforePublish.data.announcement, null);
  assert.equal(beforePublish.data.announcementDraft.title, "Version notice");

  const published = await fetchJson(`${baseUrl}/api/announcement/publish`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Codex-Desktop-Action": "announcement-publish" },
    body: JSON.stringify({ category: "maintenance", title: "Maintenance notice", body: "Service remains available." }),
  });
  assert.equal(published.response.status, 200);
  assert.match(published.data.published.id, /^[0-9a-f-]{36}$/);

  const visible = await fetchJson(`${baseUrl}/api/version`);
  assert.equal(visible.data.announcement.title, "Maintenance notice");
  assert.equal(visible.data.announcement.body, "Service remains available.");

  const withdrawn = await fetchJson(`${baseUrl}/api/announcement`, {
    method: "DELETE",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "announcement-unpublish" },
  });
  assert.equal(withdrawn.response.status, 200);
  assert.equal(withdrawn.data.published, null);
  assert.equal(withdrawn.data.draft.title, "Maintenance notice");
});

test("reports release source and status without exposing the endpoint publicly", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/release/status`);
  assert.equal(unauthenticated.status, 401);

  const result = await fetchJson(`${baseUrl}/api/release/status`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.runningVersion, appPackage.version);
  assert.equal(result.data.sourceVersion, appPackage.version);
  assert.equal(Object.hasOwn(result.data, "releaseDisabled"), false);
  assert.equal(result.data.release.phase, "idle");
  assert.equal(result.data.appUpdate.phase, "idle");
  assert.equal(result.data.remote.disabled, true);
  assert.equal(result.data.codexUpdate.disabled, true);
  assert.equal(result.data.codexUpdate.update.phase, "idle");
  assert.doesNotMatch(JSON.stringify(result.data), /provider-secret-value/);
});

test("remote application updates require authentication, same-origin confirmation, and enablement", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/app/update/start`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const missingMarker = await fetchJson(`${baseUrl}/api/app/update/start`, {
    method: "POST",
    headers: { Origin: baseUrl },
  });
  assert.equal(missingMarker.response.status, 403);

  const crossOrigin = await fetchJson(`${baseUrl}/api/app/update/start`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "X-Codex-Desktop-Action": "app-update" },
  });
  assert.equal(crossOrigin.response.status, 403);

  const disabled = await fetchJson(`${baseUrl}/api/app/update/start`, {
    method: "POST",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "app-update" },
  });
  assert.equal(disabled.response.status, 503);
  assert.match(disabled.data.error, /未启用远程安全更新/);
});

test("official Codex update requires authentication, same-origin confirmation, and enablement", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/codex/update/status`);
  assert.equal(unauthenticated.status, 401);

  const status = await fetchJson(`${baseUrl}/api/codex/update/status`);
  assert.equal(status.response.status, 200);
  assert.equal(status.data.disabled, true);
  assert.equal(status.data.update.phase, "idle");

  const missingMarker = await fetchJson(`${baseUrl}/api/codex/update/start`, {
    method: "POST",
    headers: { Origin: baseUrl },
  });
  assert.equal(missingMarker.response.status, 403);

  const crossOrigin = await fetchJson(`${baseUrl}/api/codex/update/start`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "X-Codex-Desktop-Action": "codex-update" },
  });
  assert.equal(crossOrigin.response.status, 403);

  const disabled = await fetchJson(`${baseUrl}/api/codex/update/start`, {
    method: "POST",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "codex-update" },
  });
  assert.equal(disabled.response.status, 503);
  assert.match(disabled.data.error, /未启用官方 Codex 升级/);
});

test("the redundant direct browser release API is not exposed", async () => {
  const removed = await fetch(`${baseUrl}/api/release/start`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "release",
    },
  });
  assert.equal(removed.status, 404);
});

test("update launchers do not reapply unreconciled deployment status files", () => {
  const appUpdateRoute = serverSource.slice(
    serverSource.indexOf('app.post("/api/app/update/start"'),
    serverSource.indexOf('app.get("/api/codex/update/status"'),
  );
  const codexUpdateRoute = serverSource.slice(
    serverSource.indexOf('app.post("/api/codex/update/start"'),
    serverSource.indexOf('app.get("/api/system/status"'),
  );
  assert.ok(appUpdateRoute.match(/assertNoConflictingDeployment\(\)/g)?.length >= 2);
  assert.ok(codexUpdateRoute.match(/assertNoConflictingDeployment\(\)/g)?.length >= 2);
  assert.doesNotMatch(appUpdateRoute, /StatusStore\.read\(\)/);
  assert.doesNotMatch(codexUpdateRoute, /StatusStore\.read\(\)/);
});

test("owners can atomically cancel a waiting deployment without exposing the control publicly", async (t) => {
  const statusPath = path.join(stateDirectory, "release-status.json");
  const operationId = `test-release-cancel-${Date.now()}`;
  const cancelStore = new DeploymentCancelStore(runtimeDirectory);
  t.after(async () => {
    await cancelStore.clear(operationId).catch(() => {});
    await fs.rm(statusPath, { force: true });
  });
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify({
    status: "running", phase: "verifying", version: appPackage.version, unit: operationId,
    detail: "pre-commit verification", startedAt: Date.now(), updatedAt: Date.now(), completedAt: null, error: null,
  })}\n`, { mode: 0o600 });

  const unauthenticated = await fetch(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(unauthenticated.status, 401);
  const control = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(control.response.status, 200);
  assert.deepEqual(control.data, {
    active: true,
    kind: "release",
    phase: "verifying",
    operationId,
    cancellable: true,
    cancellationRequested: false,
    persistentAdmissions: { active: 0, orphaned: 0, oldestOrphanedAt: null },
  });
  await cancelStore.commit(operationId);
  const committedControl = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(committedControl.data.cancellable, false);
  assert.equal(committedControl.data.cancellationRequested, false);
  await cancelStore.clear(operationId);

  const missingMarker = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId, password: "correct-horse-battery-staple" }),
  });
  assert.equal(missingMarker.response.status, 403);
  const changedOperation = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-deployment-cancel",
    },
    body: JSON.stringify({ operationId: `${operationId}-changed`, password: "wrong-password" }),
  });
  assert.equal(changedOperation.response.status, 409);
  const crossOrigin = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-deployment-cancel",
    },
    body: JSON.stringify({ operationId, password: "correct-horse-battery-staple" }),
  });
  assert.equal(crossOrigin.response.status, 403);
  const wrongPassword = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-deployment-cancel",
    },
    body: JSON.stringify({ operationId, password: "wrong-password" }),
  });
  assert.equal(wrongPassword.response.status, 403);

  const rateLimitedIp = "203.0.113.62";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rejected = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "CF-Connecting-IP": rateLimitedIp,
        "X-Codex-Desktop-Action": "ops-deployment-cancel",
      },
      body: JSON.stringify({ operationId, password: "wrong-password" }),
    });
    assert.equal(rejected.response.status, 403);
  }
  const rateLimited = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "CF-Connecting-IP": rateLimitedIp,
      "X-Codex-Desktop-Action": "ops-deployment-cancel",
    },
    body: JSON.stringify({ operationId, password: "wrong-password" }),
  });
  assert.equal(rateLimited.response.status, 429);
  assert.ok(Number(rateLimited.response.headers.get("retry-after")) > 0);

  const cancelled = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-deployment-cancel",
    },
    body: JSON.stringify({ operationId, password: "correct-horse-battery-staple" }),
  });
  assert.equal(cancelled.response.status, 202);
  assert.equal(cancelled.data.control.cancellationRequested, true);
  assert.equal(await cancelStore.getDecision(operationId), "cancel");
  assert.doesNotMatch(JSON.stringify(cancelled.data), /password|drain.*token/i);
  const cancellationControl = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(cancellationControl.data.cancellable, false);
  assert.equal(cancellationControl.data.cancellationRequested, true);

  const duplicateCancellation = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-deployment-cancel",
    },
    body: JSON.stringify({ operationId, password: "correct-horse-battery-staple" }),
  });
  assert.equal(duplicateCancellation.response.status, 409);
  assert.equal(await cancelStore.getDecision(operationId), "cancel");
});

test("deployment reconciliation does not let an unavailable systemd query override an inactive process lock", () => {
  const liveness = serverSource.slice(
    serverSource.indexOf("async function maintenanceOperationLiveness"),
    serverSource.indexOf("async function operationLockState"),
  );
  assert.match(liveness, /unitState === "active" \|\| lockState === "active"/);
  assert.match(liveness, /if \(lockState === "unknown"\) return "unknown"/);
  assert.doesNotMatch(liveness, /unitState === "unknown" \|\| lockState === "unknown"/);
});

test("an unknown operation lock stops blocking after the bounded worker-start grace", async (t) => {
  const statusPath = path.join(stateDirectory, "release-status.json");
  const lockPath = path.join(runtimeDirectory, "release.lock");
  const operationId = `wfl-codex-release-v${appPackage.version.replaceAll(".", "-")}-${Date.now()}-deadbeef`;
  t.after(async () => {
    await Promise.all([
      fs.rm(statusPath, { force: true }),
      fs.rm(lockPath, { force: true }),
    ]);
  });
  await fs.mkdir(runtimeDirectory, { recursive: true });
  await fs.writeFile(lockPath, "{", { mode: 0o600 });

  const writeStatus = (ageMs) => fs.writeFile(statusPath, `${JSON.stringify({
    status: "running",
    phase: "waiting",
    version: appPackage.version,
    unit: operationId,
    detail: "worker identity cannot be read",
    startedAt: Date.now() - ageMs,
    updatedAt: Date.now() - ageMs,
    completedAt: null,
    error: null,
  })}\n`, { mode: 0o600 });

  await writeStatus(45_000);
  const duringGrace = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(duringGrace.response.status, 200);
  assert.equal(duringGrace.data.active, true);

  await writeStatus(65_000);
  const afterGrace = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(afterGrace.response.status, 200);
  assert.equal(afterGrace.data.active, false);
});

test("a foreign active systemd service cannot keep a maintenance status alive", async (t) => {
  const statusPath = path.join(stateDirectory, "release-status.json");
  const staleAt = Date.now() - 65_000;
  t.after(() => fs.rm(statusPath, { force: true }));
  await fs.writeFile(statusPath, `${JSON.stringify({
    status: "running",
    phase: "deploying",
    version: appPackage.version,
    unit: "wfl-codex-desktop-gateway.service",
    detail: "foreign active service name",
    startedAt: staleAt,
    updatedAt: staleAt,
    completedAt: null,
    error: null,
  })}\n`, { mode: 0o600 });

  const control = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(control.response.status, 200);
  assert.equal(control.data.active, false);
});

test("automatically clears legacy deployment states without an updated timestamp", async (t) => {
  const statusPath = path.join(stateDirectory, "release-status.json");
  t.after(() => fs.rm(statusPath, { force: true }));
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify({
    status: "running", phase: "waiting", version: appPackage.version,
    unit: `missing-release-worker-${Date.now()}`,
    detail: "legacy waiting state", startedAt: null, completedAt: null, error: null,
  })}\n`, { mode: 0o600 });

  const result = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.active, false);
  const stored = JSON.parse(await fs.readFile(statusPath, "utf8"));
  assert.equal(stored.status, "running");
  assert.equal(stored.phase, "waiting");
});

test("reports bounded CPU, memory, and disk service metrics", async () => {
  const result = await fetchJson(`${baseUrl}/api/system/status`);
  assert.equal(result.response.status, 200);
  assert.ok(result.data.cpuPercent >= 0 && result.data.cpuPercent <= 100);
  assert.ok(result.data.memory.usedBytes > 0);
  assert.ok(result.data.memory.totalBytes >= result.data.memory.usedBytes);
  assert.ok(result.data.disk.totalBytes >= result.data.disk.usedBytes);
  assert.ok(Array.isArray(result.data.disks));
  assert.ok(result.data.disks.some((disk) => disk.primary === true));
  assert.ok(result.data.uptimeSeconds >= 0);
});

test("serves a redacted administrator operations overview", async () => {
  const unauthenticatedApi = await fetch(`${baseUrl}/api/ops/overview`);
  assert.equal(unauthenticatedApi.status, 401);
  const unauthenticatedPage = await fetch(`${baseUrl}/ops`, { redirect: "manual" });
  assert.equal(unauthenticatedPage.status, 401);

  for (const pathname of ["/ops", "/ops/", "/ops.html"]) {
    const page = await fetch(`${baseUrl}${pathname}`, { headers: { Authorization: authorization } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /id="overviewView"/);
  }

  const result = await fetchJson(`${baseUrl}/api/ops/overview`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.version, appPackage.version);
  assert.equal(result.data.services.gateway.status, "direct");
  assert.equal(result.data.services.backend.status, "healthy");
  assert.ok(result.data.mapResourceRecovery);
  assert.ok(["pending", "running", "ready", "degraded", "standby"].includes(result.data.mapResourceRecovery.state));
  assert.ok(result.data.resources.samples.length >= 1);
  assert.ok(result.data.resources.samples.length <= 360);
  assert.ok(Array.isArray(result.data.resources.disks));
  assert.ok(result.data.resources.disks.some((disk) => disk.primary === true));
  assert.equal(result.data.users.total, 1);
  assert.deepEqual(result.data.users.pagination, { page: 1, pageSize: 10, pages: 1, total: 1 });
  assert.equal(result.data.tasks.rows.length, 1);
  assert.equal(Object.hasOwn(result.data.tasks.rows[0].task, "threadId"), false);
  assert.equal(Object.hasOwn(result.data.deployment.release, "error"), false);
  assert.equal(result.data.deployment.setup.password.configured, true);
  assert.equal(result.data.deployment.setup.password.command, "sudo npm run server:password");
  assert.equal(result.data.deployment.setup.authorization.configured, false);
  assert.equal(result.data.deployment.setup.authorization.href, "/#providers");
  assert.equal(result.data.deployment.setup.access.configured, false);
  assert.equal(result.data.deployment.setup.access.command, "sudo npm run server:access");
  assert.equal(result.data.deployment.setup.updates.configured, false);
  assert.equal(result.data.deployment.setup.updates.command, "sudo npm run server:updates");
  assert.equal(Object.hasOwn(result.data.deployment.setup.updates, "remote"), false);
  assert.equal(result.data.resources.range, "1h");
  assert.ok(result.data.health.score >= 0 && result.data.health.score <= 100);
  assert.ok(Array.isArray(result.data.health.components));
  assert.ok(Array.isArray(result.data.traffic.trend.samples));
  assert.ok(Array.isArray(result.data.traffic.rankings));
  assert.equal(typeof result.data.traffic.tokenUsage.available, "boolean");
  assert.ok(Array.isArray(result.data.events.rows));
  assert.equal(result.data.alerts.rules.length, 5);
  assert.equal(result.data.alerts.webhook.configured, false);
  assert.doesNotMatch(JSON.stringify(result.data), /provider-secret-value/);

  const paged = await fetchJson(`${baseUrl}/api/ops/overview?userPage=999&userPageSize=25`);
  assert.deepEqual(paged.data.users.pagination, { page: 1, pageSize: 25, pages: 1, total: 1 });
  assert.equal(paged.data.users.rows.length, 1);
});

test("keeps map transaction recovery administrator-only, writable, and path-redacted", async () => {
  const listed = await fetchJson(`${baseUrl}/api/ops/map-resource-transactions`);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.data));
  assert.equal(typeof listed.data.project.id, "string");
  assert.equal(listed.data.project.name, path.basename(defaultProject));
  assert.equal(listed.data.project.isDefault, true);
  assert.equal(Object.hasOwn(listed.data, "projectPath"), false);
  assert.ok(Array.isArray(listed.data.transactions));
  assert.doesNotMatch(JSON.stringify(listed.data), /\/tmp\/wfl-codex-desktop-test-/u);

  const missingAction = await fetchJson(`${baseUrl}/api/ops/map-resource-transactions/recover`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ project: defaultProject }),
  });
  assert.equal(missingAction.response.status, 403);

  const recovered = await fetchJson(`${baseUrl}/api/ops/map-resource-transactions/recover`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-map-resource-transactions-recover",
    },
    body: JSON.stringify({ project: defaultProject }),
  });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.data));
  assert.equal(typeof recovered.data.project.id, "string");
  assert.equal(Object.hasOwn(recovered.data, "projectPath"), false);
  assert.ok(Number.isInteger(recovered.data.result.recovered));
  assert.doesNotMatch(JSON.stringify(recovered.data), /\/tmp\/wfl-codex-desktop-test-/u);

  const outside = await fetchJson(`${baseUrl}/api/ops/map-resource-transactions?project=${encodeURIComponent(projectRoot)}`);
  assert.equal(outside.response.status, 400);
});

test("marks abandoned backup restores failed instead of blocking deployments forever", async () => {
  const statusPath = path.join(runtimeDirectory, "backup-restore-status.json");
  const staleAt = Date.now() - 41 * 60 * 1000;
  await fs.mkdir(runtimeDirectory, { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify({
    status: "running",
    phase: "queued",
    backupId: "b-20260722T010203Z-1234abcd",
    detail: "stale restore",
    startedAt: staleAt,
    updatedAt: staleAt,
    completedAt: null,
    error: null,
  })}\n`);

  const result = await fetchJson(`${baseUrl}/api/ops/backups`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.restore.status, "failed");
  assert.match(result.data.restore.error, /worker is no longer active/i);
  const persisted = JSON.parse(await fs.readFile(statusPath, "utf8"));
  assert.equal(persisted.status, "running");
  assert.equal(persisted.completedAt, null);
});

test("only the active backend can start a scheduled shared-state backup", () => {
  const scheduler = serverSource.slice(
    serverSource.indexOf("function scheduleDataBackupCheck"),
    serverSource.indexOf("function startDataBackup"),
  );
  const activeBackendCheck = scheduler.indexOf("await opsProcessIsActive()");
  const dueCheck = scheduler.indexOf("backupCenter.scheduledBackupDue()");
  const backupStart = scheduler.indexOf('startDataBackup("scheduled", "scheduler")');
  assert.ok(activeBackendCheck >= 0);
  assert.ok(activeBackendCheck < dueCheck);
  assert.ok(dueCheck < backupStart);
});

test("an abandoned release status cannot keep rollback and emergency controls locked", async (t) => {
  const statusPath = path.join(stateDirectory, "release-status.json");
  const staleAt = Date.now() - 60_000;
  const operationId = `wfl-codex-release-v${appPackage.version.replace(/[^0-9A-Za-z]+/g, "-")}-${staleAt}-deadbeef`;
  t.after(() => fs.rm(statusPath, { force: true }));
  await fs.writeFile(statusPath, `${JSON.stringify({
    status: "running",
    phase: "deploying",
    version: appPackage.version,
    unit: operationId,
    detail: "worker exited before updating its status",
    startedAt: staleAt,
    updatedAt: staleAt,
    completedAt: null,
    error: null,
  })}\n`, { mode: 0o600 });

  const control = await fetchJson(`${baseUrl}/api/ops/deployments/control`);
  assert.equal(control.response.status, 200);
  assert.equal(control.data.active, false);
  assert.equal(control.data.phase, "idle");

  const release = await fetchJson(`${baseUrl}/api/release/status`);
  assert.equal(release.response.status, 200);
  assert.equal(release.data.release.status, "failed");
  assert.equal(release.data.release.phase, "failed");
  assert.match(release.data.release.detail, /状态已自动解除/);
});

test("serves bounded operations history, events, and protected alert settings", async () => {
  for (const range of ["1h", "24h", "7d"]) {
    const metrics = await fetchJson(`${baseUrl}/api/ops/metrics?range=${range}`);
    assert.equal(metrics.response.status, 200);
    assert.equal(metrics.data.range, range);
    assert.ok(Array.isArray(metrics.data.samples));
  }
  const invalidRange = await fetchJson(`${baseUrl}/api/ops/metrics?range=forever`);
  assert.equal(invalidRange.response.status, 400);

  const events = await fetchJson(`${baseUrl}/api/ops/events?limit=20`);
  assert.equal(events.response.status, 200);
  assert.ok(Array.isArray(events.data.events));
  for (const category of ["api", "rpc", "errors", "system", "warnings"]) {
    const logs = await fetchJson(`${baseUrl}/api/ops/logs?category=${category}`);
    assert.equal(logs.response.status, 200);
    assert.ok(Array.isArray(logs.data.rows));
    assert.doesNotMatch(JSON.stringify(logs.data), /provider-secret-value/);
  }
  const rollback = await fetchJson(`${baseUrl}/api/ops/rollback`);
  assert.equal(rollback.response.status, 200);
  assert.equal(rollback.data.available, false);
  assert.equal(rollback.data.guard.enabled, false);

  const missingMarker = await fetchJson(`${baseUrl}/api/ops/alerts/settings`, {
    method: "PUT",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ rules: { disk_usage: { enabled: false } } }),
  });
  assert.equal(missingMarker.response.status, 403);

  const crossOrigin = await fetchJson(`${baseUrl}/api/ops/alerts/settings`, {
    method: "PUT",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-alert-settings",
    },
    body: JSON.stringify({ rules: { disk_usage: { enabled: false } } }),
  });
  assert.equal(crossOrigin.response.status, 403);

  const blockedWebhook = await fetchJson(`${baseUrl}/api/ops/alerts/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-alert-settings",
    },
    body: JSON.stringify({ webhookUrl: "https://127.0.0.1/private" }),
  });
  assert.equal(blockedWebhook.response.status, 400);

  const webhookSecret = "ops-integration-webhook-secret";
  const configured = await fetchJson(`${baseUrl}/api/ops/alerts/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-alert-settings",
    },
    body: JSON.stringify({
      webhookUrl: `https://hooks.example.test/private?token=${webhookSecret}`,
      rules: { disk_usage: { enabled: true, thresholdPercent: 88, consecutive: 4, cooldownMinutes: 30 } },
    }),
  });
  assert.equal(configured.response.status, 200);
  assert.deepEqual(configured.data.webhook, { configured: true, host: "hooks.example.test" });
  assert.doesNotMatch(JSON.stringify(configured.data), new RegExp(webhookSecret));
  assert.doesNotMatch(await fs.readFile(path.join(stateDirectory, "ops-alerts.enc.json"), "utf8"), new RegExp(webhookSecret));

  const removed = await fetchJson(`${baseUrl}/api/ops/alerts/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-alert-settings",
    },
    body: JSON.stringify({ webhookUrl: "" }),
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.data.webhook.configured, false);
});

test("reports task status only to authenticated clients", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/task/status`);
  assert.equal(unauthenticated.status, 401);

  const result = await fetchJson(`${baseUrl}/api/task/status`);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.data.status, "idle");
  assert.equal(result.data.phase, "idle");
  assert.equal(result.data.startedAt, null);
  assert.ok(Number.isFinite(result.data.observedAt));

  const scoped = await fetchJson(`${baseUrl}/api/task/status?threadId=thread-status-test`);
  assert.equal(scoped.response.status, 200);
  assert.equal(scoped.data.status, "idle");
  assert.equal(scoped.data.threadId, "thread-status-test");
  assert.equal(scoped.data.authoritative, true);
  assert.equal(scoped.data.canSend, true);
  assert.equal(scoped.data.activeTurnId, null);

  const reconciled = await fetchJson(
    `${baseUrl}/api/task/status?threadId=thread-status-test&activeTurnId=turn-stale-test`,
  );
  assert.equal(reconciled.response.status, 200);
  assert.equal(reconciled.data.staleTurnId, "turn-stale-test");
  assert.equal(reconciled.data.canSend, true);

  const invalid = await fetchJson(`${baseUrl}/api/task/status?threadId=`);
  assert.equal(invalid.response.status, 400);
  const invalidTurn = await fetchJson(
    `${baseUrl}/api/task/status?threadId=thread-status-test&activeTurnId=`,
  );
  assert.equal(invalidTurn.response.status, 400);
});

test("manages bundled plugins with same-origin confirmation and never persists submitted SSH passwords", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/plugins`);
  assert.equal(unauthenticated.status, 401);

  const catalog = await fetchJson(`${baseUrl}/api/plugins`);
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.data.source.trust, "bundled");
  assert.equal(catalog.data.platformVersion, 2);
  assert.deepEqual(catalog.data.plugins.map((plugin) => plugin.id).sort(), [
    "creator-worker",
    "persistent-ssh-servers",
    "secure-ssh-access",
    "windows-codex-remote",
  ]);
  assert.equal(catalog.data.plugins.find((plugin) => plugin.id === "secure-ssh-access").installed, false);

  const missingMarker = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/install`, {
    method: "POST",
    headers: { Origin: baseUrl },
  });
  assert.equal(missingMarker.response.status, 403);

  const crossOrigin = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/install`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "X-Codex-Desktop-Action": "plugin-install" },
  });
  assert.equal(crossOrigin.response.status, 403);

  const installed = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/install`, {
    method: "POST",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "plugin-install" },
  });
  assert.equal(installed.response.status, 201);
  assert.equal(installed.data.plugin.enabled, true);
  assert.equal((await fs.stat(path.join(stateDirectory, "plugins.json"))).mode & 0o777, 0o600);

  const records = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/access`);
  assert.deepEqual(records.data.records, []);

  const password = "ssh-password-that-must-never-persist";
  const rejectedPassword = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ host: "example.com", port: 22, username: "root", password }),
  });
  assert.equal(rejectedPassword.response.status, 403);
  assert.doesNotMatch(await readTextFiles(stateDirectory), new RegExp(password));
  assert.doesNotMatch(await readTextFiles(runtimeDirectory), new RegExp(password));

  const disabled = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/enabled`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "plugin-toggle",
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.data.plugin.enabled, false);
  const unavailable = await fetchJson(`${baseUrl}/api/plugins/secure-ssh-access/access`);
  assert.equal(unavailable.response.status, 409);

  const removed = await fetch(`${baseUrl}/api/plugins/secure-ssh-access`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "plugin-uninstall",
    },
  });
  assert.equal(removed.status, 204);
});

test("persistent SSH server access is separately gated and does not expose disabled profiles", async () => {
  const installed = await fetchJson(`${baseUrl}/api/plugins/persistent-ssh-servers/install`, {
    method: "POST",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "plugin-install" },
  });
  assert.equal(installed.response.status, 201, JSON.stringify(installed.data));
  const initial = await fetchJson(`${baseUrl}/api/plugins/persistent-ssh-servers/servers`);
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.data.servers, []);

  const invalidToggle = await fetchJson(
    `${baseUrl}/api/plugins/persistent-ssh-servers/servers/pssh-0000000000000000/enabled`,
    {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "persistent-ssh-toggle",
      },
      body: JSON.stringify({ enabled: false }),
    },
  );
  assert.equal(invalidToggle.response.status, 404);

  const disabled = await fetchJson(`${baseUrl}/api/plugins/persistent-ssh-servers/enabled`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "plugin-toggle",
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.response.status, 200);
  const unavailable = await fetchJson(`${baseUrl}/api/plugins/persistent-ssh-servers/servers`);
  assert.equal(unavailable.response.status, 409);

  const reenabled = await fetchJson(`${baseUrl}/api/plugins/persistent-ssh-servers/enabled`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "plugin-toggle",
    },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(reenabled.response.status, 200);
  const removed = await fetch(`${baseUrl}/api/plugins/persistent-ssh-servers`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "plugin-uninstall",
    },
  });
  assert.equal(removed.status, 204);
});

test("pairs an outbound Windows Host and fences calls by device and Thread lease", async () => {
  const installed = await fetchJson(`${baseUrl}/api/plugins/windows-codex-remote/install`, {
    method: "POST",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "plugin-install" },
  });
  assert.equal(installed.response.status, 201, JSON.stringify(installed.data));

  const hostSnapshot = await fetchJson(`${baseUrl}/api/windows-host`);
  assert.equal(hostSnapshot.response.status, 200, JSON.stringify(hostSnapshot.data));
  assert.equal(hostSnapshot.data.companion.version, "0.1.0");
  const companionResponse = await fetch(`${baseUrl}${hostSnapshot.data.companion.downloadUrl}`, {
    headers: { Authorization: authorization },
  });
  const companionArchive = Buffer.from(await companionResponse.arrayBuffer());
  assert.equal(companionResponse.status, 200);
  assert.match(companionResponse.headers.get("content-disposition"), /wfl-windows-host-v0\.1\.0\.zip/);
  assert.equal(companionArchive.readUInt32LE(0), 0x04034b50);
  assert.doesNotMatch(companionArchive.toString("latin1"), /wfl_device_[A-Za-z0-9_-]{43}/);

  const pairing = await fetchJson(`${baseUrl}/api/windows-host/pairings`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "windows-device-pairing-create",
    },
    body: JSON.stringify({ pluginIds: ["windows-codex-remote"] }),
  });
  assert.equal(pairing.response.status, 201, JSON.stringify(pairing.data));
  assert.match(pairing.data.pairing.code, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/);

  const exchangedResponse = await fetch(`${baseUrl}/api/windows-host/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pairing.data.pairing.code,
      name: "Test Windows PC",
      platform: "windows",
      agentVersion: "0.1.0",
      protocolVersion: 1,
    }),
  });
  const exchanged = await exchangedResponse.json();
  assert.equal(exchangedResponse.status, 201, JSON.stringify(exchanged));
  const persistedDevices = await fs.readFile(path.join(stateDirectory, "windows-devices.json"), "utf8");
  assert.doesNotMatch(persistedDevices, new RegExp(exchanged.token));
  assert.doesNotMatch(persistedDevices, new RegExp(pairing.data.pairing.code));

  const socket = new WebSocket(baseUrl.replace("http", "ws") + "/device/ws");
  const authenticated = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows Host authentication timed out")), 5_000);
    socket.on("open", () => socket.send(JSON.stringify({
      type: "authenticate",
      deviceId: exchanged.device.id,
      token: exchanged.token,
      agentVersion: "0.1.0",
      protocolVersion: 1,
    })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "authenticated") return;
      clearTimeout(timer);
      resolve(message);
    });
    socket.on("error", reject);
  });
  assert.equal((await authenticated).device.id, exchanged.device.id);
  socket.send(JSON.stringify({
    type: "capabilities",
    capabilities: {
      codex: { available: true, appServer: true, version: "0.146.0" },
      creator: { available: false, workspaceConfigured: false, tools: [] },
    },
  }));

  const leaseInput = {
    deviceId: exchanged.device.id,
    pluginId: "windows-codex-remote",
    threadId: "thread-remote-1",
    windowId: "window-remote-1",
  };
  const lease = await fetchJson(`${baseUrl}/api/windows-host/leases`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "windows-device-lease-acquire",
    },
    body: JSON.stringify(leaseInput),
  });
  assert.equal(lease.response.status, 201, JSON.stringify(lease.data));

  const conflict = await fetchJson(`${baseUrl}/api/windows-host/leases`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "windows-device-lease-acquire",
    },
    body: JSON.stringify({ ...leaseInput, threadId: "thread-remote-2", windowId: "window-remote-2" }),
  });
  assert.equal(conflict.response.status, 409);

  const deviceCall = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows Host call timed out")), 5_000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "call") return;
      clearTimeout(timer);
      socket.off("message", listener);
      socket.send(JSON.stringify({
        type: "callResult",
        callId: message.callId,
        ok: true,
        result: { id: "thread-remote-1", status: "idle" },
        context: message.context,
      }));
      resolve(message);
    };
    socket.on("message", listener);
  });
  const called = fetchJson(`${baseUrl}/api/windows-host/calls`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "windows-host-call",
    },
    body: JSON.stringify({
      ...leaseInput,
      leaseEpoch: lease.data.lease.leaseEpoch,
      method: "codex.thread.resume",
      params: { projectId: "project-remote-1", threadId: "thread-remote-1" },
    }),
  });
  const [callEnvelope, callResult] = await Promise.all([deviceCall, called]);
  assert.equal(callEnvelope.context.threadId, "thread-remote-1");
  assert.equal(callResult.response.status, 200, JSON.stringify(callResult.data));
  assert.equal(callResult.data.result.status, "idle");

  const revoked = await fetchJson(`${baseUrl}/api/windows-host/devices/${encodeURIComponent(exchanged.device.id)}`, {
    method: "DELETE",
    headers: { Origin: baseUrl, "X-Codex-Desktop-Action": "windows-device-revoke" },
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.data.device.epoch, exchanged.device.epoch + 1);
  socket.close();

  const removed = await fetch(`${baseUrl}/api/plugins/windows-codex-remote`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "plugin-uninstall",
    },
  });
  assert.equal(removed.status, 204);
});

test("persists lightweight recovery records only for authenticated clients", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/recovery`);
  assert.equal(unauthenticated.status, 401);

  const remembered = await fetchJson(`${baseUrl}/api/recovery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "thread_0001", cwd: defaultProject, status: "recovered" }),
  });
  assert.equal(remembered.response.status, 200);
  assert.equal(remembered.data.record.threadId, "thread_0001");
  assert.equal(remembered.data.record.cwd, defaultProject);
  assert.equal(Object.hasOwn(remembered.data.record, "messages"), false);

  const listed = await fetchJson(`${baseUrl}/api/recovery`);
  assert.deepEqual(listed.data.records, [remembered.data.record]);

  const removed = await fetch(`${baseUrl}/api/recovery/thread_0001`, {
    method: "DELETE",
    headers: { Authorization: authorization },
  });
  assert.equal(removed.status, 204);

  const outside = await fetchJson(`${baseUrl}/api/recovery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "thread_0002", cwd: "/tmp/outside", status: "remembered" }),
  });
  assert.equal(outside.response.status, 400);
});

test("requires authentication and sends browser security headers", async () => {
  const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /Basic/);

  const authenticated = await fetch(`${baseUrl}/`, {
    headers: { Authorization: authorization, "X-Forwarded-Proto": "https" },
  });
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.headers.get("x-frame-options"), "DENY");
  assert.match(authenticated.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(authenticated.headers.get("content-security-policy"), /frame-src 'self'/);
  assert.equal(authenticated.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(authenticated.headers.get("set-cookie"), /HttpOnly/);
  assert.match(authenticated.headers.get("set-cookie"), /Secure/);

  const embeddedUsers = await fetch(`${baseUrl}/users?embed=ops`, {
    headers: { Authorization: authorization },
  });
  assert.equal(embeddedUsers.status, 200);
  assert.equal(embeddedUsers.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(embeddedUsers.headers.get("content-security-policy"), /frame-ancestors 'self'/);

  const standaloneUsers = await fetch(`${baseUrl}/users`, { headers: { Authorization: authorization } });
  assert.equal(standaloneUsers.headers.get("x-frame-options"), "DENY");
  assert.match(standaloneUsers.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("serves the authenticated rescue window and its isolated assets", async () => {
  for (const asset of ["rescue.html", "rescue.css", "rescue.js"]) {
    const response = await fetch(`${baseUrl}/${asset}`, { headers: { Authorization: authorization } });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 100);
  }
});

test("redirects trusted proxy HTTP requests before asking for a password", async () => {
  const response = await fetch(`${baseUrl}/example?value=1`, {
    redirect: "manual",
    headers: {
      "X-Forwarded-Host": "codex.example.test",
      "X-Forwarded-Proto": "http",
    },
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://codex.example.test/example?value=1");
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("creates a Node project with optional Git initialization", async () => {
  const result = await fetchJson(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "sample-node", template: "node", initializeGit: true }),
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.project.name, "sample-node");
  assert.equal(result.data.project.git, true);
  const packageJson = JSON.parse(
    await fs.readFile(path.join(projectRoot, "sample-node", "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "sample-node");
  assert.equal(await exists(path.join(projectRoot, "sample-node", "src", "index.js")), true);
});

test("creates a project under a selected secondary storage root", async () => {
  const listing = await fetchJson(`${baseUrl}/api/projects`);
  assert.equal(listing.response.status, 200);
  const dataRoot = listing.data.roots.find((root) => root.path === secondaryProjectRoot);
  assert.ok(dataRoot);
  const result = await fetchJson(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "data-project", template: "empty", rootId: dataRoot.id, initializeGit: false }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.project.path, path.join(secondaryProjectRoot, "data-project"));
  assert.equal(await exists(path.join(secondaryProjectRoot, "data-project")), true);
});

test("manages encrypted API provider profiles without returning keys", async () => {
  const created = await fetchJson(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Example Provider",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-5.6-sol",
      apiKey: "provider-secret-value",
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.profile.hasApiKey, true);
  assert.equal(Object.hasOwn(created.data.profile, "apiKey"), false);

  const listed = await fetchJson(`${baseUrl}/api/providers`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.data.profiles[0].name, "Example Provider");
  assert.doesNotMatch(JSON.stringify(listed.data), /provider-secret-value/);

  const updated = await fetchJson(`${baseUrl}/api/providers/${created.data.profile.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Updated Provider",
      baseUrl: "https://api.example.test/v2",
      model: "gpt-5.6-sol",
      apiKey: "",
    }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.profile.name, "Updated Provider");
  assert.equal(updated.data.profile.hasApiKey, true);

  const activate = await fetchJson(`${baseUrl}/api/providers/${created.data.profile.id}/activate`, {
    method: "POST",
  });
  assert.equal(activate.response.status, 503);
  assert.match(activate.data.error, /尚未就绪/);

  const removed = await fetch(`${baseUrl}/api/providers/${created.data.profile.id}`, {
    method: "DELETE",
    headers: { Authorization: authorization },
  });
  assert.equal(removed.status, 204);
  assert.equal((await fs.stat(path.join(stateDirectory, "providers.enc.json"))).mode & 0o777, 0o600);
});

test("queries a saved provider model catalog without exposing its key", async () => {
  let observedPath = null;
  let observedAuthorization = null;
  const upstream = http.createServer((request, response) => {
    observedPath = request.url;
    observedAuthorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [
        { id: "vendor-chat-2.0", object: "model" },
        { id: "vendor-chat-1.0", object: "model" },
        { id: "vendor-chat-2.0", object: "model" },
        { id: "invalid model", object: "model" },
      ],
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", resolve);
    upstream.once("error", reject);
  });
  let providerId = null;
  try {
    const upstreamPort = upstream.address().port;
    const created = await fetchJson(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Catalog Provider",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "",
        apiKey: "catalog-provider-secret",
      }),
    });
    assert.equal(created.response.status, 201);
    providerId = created.data.profile.id;

    const missingMarker = await fetchJson(`${baseUrl}/api/providers/${providerId}/models`, {
      method: "POST",
      headers: { Origin: baseUrl },
    });
    assert.equal(missingMarker.response.status, 403);

    const crossOrigin = await fetchJson(`${baseUrl}/api/providers/${providerId}/models`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "X-Codex-Desktop-Action": "provider-models-query",
      },
    });
    assert.equal(crossOrigin.response.status, 403);

    const queried = await fetchJson(`${baseUrl}/api/providers/${providerId}/models`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "X-Codex-Desktop-Action": "provider-models-query",
      },
    });
    assert.equal(queried.response.status, 200);
    assert.equal(queried.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(queried.data.models, ["vendor-chat-1.0", "vendor-chat-2.0"]);
    assert.equal(observedPath, "/v1/models");
    assert.equal(observedAuthorization, "Bearer catalog-provider-secret");
    assert.doesNotMatch(JSON.stringify(queried.data), /catalog-provider-secret/);
  } finally {
    if (providerId) {
      await fetch(`${baseUrl}/api/providers/${providerId}`, {
        method: "DELETE",
        headers: { Authorization: authorization },
      });
    }
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("automatically queries and normalizes a provider balance without exposing its key", async () => {
  let observedPath = null;
  let observedAuthorization = null;
  const upstream = http.createServer((request, response) => {
    observedPath = request.url;
    observedAuthorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      isValid: true,
      planName: "钱包余额",
      balance: 12.5,
      remaining: 12.5,
      unit: "USD",
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", resolve);
    upstream.once("error", reject);
  });
  let providerId = null;
  try {
    const upstreamPort = upstream.address().port;
    const created = await fetchJson(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Usage Provider",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "usage-model",
        apiKey: "usage-provider-secret",
      }),
    });
    assert.equal(created.response.status, 201);
    providerId = created.data.profile.id;

    const usage = await fetchJson(`${baseUrl}/api/providers/usage?refresh=1`);
    assert.equal(usage.response.status, 200, JSON.stringify(usage.data));
    const entry = usage.data.providers.find((value) => value.providerId === providerId);
    assert.equal(entry.status, "ok");
    assert.equal(entry.balance.amount, 12.5);
    assert.equal(entry.balance.currency, "USD");
    assert.equal(observedPath, "/v1/usage");
    assert.equal(observedAuthorization, "Bearer usage-provider-secret");
    assert.equal(usage.response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(usage.data), /usage-provider-secret/u);
  } finally {
    if (providerId) {
      await fetch(`${baseUrl}/api/providers/${providerId}`, {
        method: "DELETE",
        headers: { Authorization: authorization },
      });
    }
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("manages provider-backed image settings with guarded endpoints", async () => {
  const provider = await fetchJson(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Image capable provider",
      baseUrl: "https://images.example.test/v1",
      model: "gpt-text",
      apiKey: "image-provider-secret-value",
    }),
  });
  assert.equal(provider.response.status, 201);
  const missingMarker = await fetchJson(`${baseUrl}/api/images/settings`, {
    method: "PUT",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: provider.data.profile.id }),
  });
  assert.equal(missingMarker.response.status, 403);

  const crossOrigin = await fetchJson(`${baseUrl}/api/images/settings`, {
    method: "PUT",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-save",
    },
    body: JSON.stringify({ providerId: provider.data.profile.id }),
  });
  assert.equal(crossOrigin.response.status, 403);

  const saved = await fetchJson(`${baseUrl}/api/images/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-save",
    },
    body: JSON.stringify({
      providerId: provider.data.profile.id,
      model: "gpt-image-2.0",
      size: "1024x1024",
      quality: "auto",
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.imageApi.configured, true);
  assert.equal(saved.data.imageApi.providerName, "Image capable provider");
  assert.doesNotMatch(JSON.stringify(saved.data), /image-provider-secret-value/);

  const listed = await fetchJson(`${baseUrl}/api/providers`);
  assert.equal(listed.data.imageApi.configured, true);
  assert.equal(listed.data.imageApi.model, "gpt-image-2.0");
  assert.doesNotMatch(JSON.stringify(listed.data), /image-provider-secret-value/);
  assert.doesNotMatch(await fs.readFile(path.join(stateDirectory, "providers.enc.json"), "utf8"), /image-provider-secret-value/);

  const unsafeProject = await fetchJson(`${baseUrl}/api/images/generate`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-generate",
    },
    body: JSON.stringify({ prompt: "banana", project: "/tmp/outside-project" }),
  });
  assert.equal(unsafeProject.response.status, 400);

  const removed = await fetch(`${baseUrl}/api/images/settings`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "image-api-remove",
    },
  });
  assert.equal(removed.status, 204);
  const afterRemoval = await fetchJson(`${baseUrl}/api/providers`);
  assert.equal(afterRemoval.data.imageApi.configured, false);

  const generateWithoutKey = await fetchJson(`${baseUrl}/api/images/generate`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-generate",
    },
    body: JSON.stringify({ prompt: "banana", project: defaultProject }),
  });
  assert.equal(generateWithoutKey.response.status, 409);
  assert.doesNotMatch(JSON.stringify(generateWithoutKey.data), /image-provider-secret-value/);
});

test("executes image v2 operations without leaking provider secrets or trusting declared metadata", async (t) => {
  const imageWindowId = crypto.createHash("sha256").update("server-image-v2-window").digest("hex");
  let imageOperationSequence = 0;
  const imageRequest = (body) => ({
    ...body,
    windowId: imageWindowId,
    operationId: crypto.createHash("sha256")
      .update(`server-image-v2-operation-${imageOperationSequence += 1}`)
      .digest("hex"),
  });
  const disabledCapabilities = await fetchJson(`${baseUrl}/api/images/capabilities`);
  assert.equal(disabledCapabilities.response.status, 200);
  assert.equal(disabledCapabilities.response.headers.get("cache-control"), "no-store");
  assert.equal(disabledCapabilities.data.enabled, false);
  assert.deepEqual(disabledCapabilities.data.operations, []);
  assert.equal(disabledCapabilities.data.features.mask, false);

  const sharp = (await import("sharp")).default;
  const [webpA, webpB, png1024, pngMismatch] = await Promise.all([
    sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#1f6f8b" } }).webp().toBuffer(),
    sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#d6a419" } }).webp().toBuffer(),
    sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#3c7a3e" } }).png().toBuffer(),
    sharp({ create: { width: 1024, height: 768, channels: 4, background: "#8f3344" } }).png().toBuffer(),
  ]);
  const observed = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const contentType = String(request.headers["content-type"] || "");
    const text = body.toString("latin1");
    const entry = {
      path: request.url,
      authorization: request.headers.authorization,
      contentType,
      body,
      json: contentType.startsWith("application/json") ? JSON.parse(body.toString("utf8")) : null,
    };
    observed.push(entry);

    if (entry.json?.prompt === "custom multi output") {
      response.writeHead(200, { "Content-Type": "application/json", "X-Request-Id": "req-multi-1" });
      response.end(JSON.stringify({
        data: [
          { b64_json: webpA.toString("base64"), revised_prompt: "first revised" },
          { b64_json: webpB.toString("base64"), revised_prompt: "second revised" },
        ],
        usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      }));
      return;
    }
    if (entry.json?.prompt === "stream preview") {
      const encoded = png1024.toString("base64");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Request-Id": "req-stream-1",
      });
      response.write(`event: image_generation.partial_image\ndata: ${JSON.stringify({
        type: "image_generation.partial_image",
        partial_image_index: 0,
        b64_json: encoded,
      })}\n\n`);
      response.end(`event: image_generation.completed\ndata: ${JSON.stringify({
        type: "image_generation.completed",
        data: [{ b64_json: encoded, revised_prompt: "stream revised" }],
        usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      })}\n\n`);
      return;
    }
    if (entry.json?.prompt === "wrong dimensions") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: pngMismatch.toString("base64") }] }));
      return;
    }
    if (entry.json?.prompt === "legacy compatible") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: png1024.toString("base64"), revised_prompt: "legacy revised" }] }));
      return;
    }
    if (entry.json?.prompt === "WFL compatibility probe: generate-standard") {
      response.writeHead(200, { "Content-Type": "application/json", "X-Request-Id": "req-probe-generate-1" });
      response.end(JSON.stringify({
        data: [{ b64_json: png1024.toString("base64") }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }));
      return;
    }
    if (request.url === "/v1/images/edits" && text.includes("secure masked edit")) {
      response.writeHead(429, { "Content-Type": "application/json", "X-Request-Id": "req-edit-safe-1" });
      response.end(JSON.stringify({
        error: {
          code: "moderation_blocked",
          type: "provider_error",
          message: "internal provider detail and image-v2-provider-secret",
          retryable: true,
          moderation_details: {
            sexual: "high",
            secret: "internal provider detail",
            nested: { flagged: true, label: "blocked" },
            unsafe_array: ["must-not-pass"],
          },
          internal_trace: "must-not-pass",
        },
      }));
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unexpected_test_request" } }));
  });
  await new Promise((resolve, reject) => {
    upstream.listen(0, "127.0.0.1", resolve);
    upstream.once("error", reject);
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  let providerId = null;
  t.after(async () => {
    await fetch(`${baseUrl}/api/images/settings`, {
      method: "DELETE",
      headers: {
        Authorization: authorization,
        Origin: baseUrl,
        "X-Codex-Desktop-Action": "image-api-remove",
      },
    });
    if (providerId) {
      await fetch(`${baseUrl}/api/providers/${providerId}`, {
        method: "DELETE",
        headers: { Authorization: authorization },
      });
    }
  });

  const provider = await fetchJson(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Image v2 integration provider",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "unused-text-model",
      apiKey: "image-v2-provider-secret",
    }),
  });
  assert.equal(provider.response.status, 201);
  providerId = provider.data.profile.id;

  const configured = await fetchJson(`${baseUrl}/api/images/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-save",
    },
    body: JSON.stringify({
      providerId,
      preset: "openai-gpt-image-2",
      model: "gpt-image-2-test",
      defaults: { size: "1024x1024", quality: "auto", outputFormat: "png", n: 1 },
    }),
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.data));

  const capabilities = await fetchJson(`${baseUrl}/api/images/capabilities`);
  assert.equal(capabilities.response.status, 200);
  assert.equal(capabilities.data.enabled, true);
  assert.equal(capabilities.data.presetId, "openai-gpt-image-2");
  assert.deepEqual(capabilities.data.operations, ["generate", "edit", "outpaint"]);
  assert.equal(capabilities.data.features.mask, true);
  assert.equal(capabilities.data.features.multiInput, true);
  assert.equal(capabilities.data.features.multiOutput, true);
  assert.equal(capabilities.data.features.streaming, true);
  assert.deepEqual(capabilities.data.options.outputFormats, ["png", "jpeg", "webp"]);
  assert.doesNotMatch(JSON.stringify(capabilities.data), /image-v2-provider-secret|apiKey|baseUrl/);

  const requestBody = imageRequest({
    operation: "generate",
    prompt: "guarded request",
    project: defaultProject,
  });
  const missingAction = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  assert.equal(missingAction.response.status, 403);
  const crossOrigin = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(requestBody),
  });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(observed.length, 0);

  const generated = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "generate",
      prompt: "custom multi output",
      project: defaultProject,
      destination: "image-v2/custom-result.webp",
      n: 2,
      size: "1024x1024",
      quality: "high",
      outputFormat: "webp",
      outputCompression: 73,
      background: "opaque",
      moderation: "low",
    })),
  });
  assert.equal(generated.response.status, 201, JSON.stringify(generated.data));
  assert.equal(generated.data.outputs.length, 2);
  assert.deepEqual(generated.data.outputs.map((output) => output.relativePath), [
    "image-v2/custom-result-1.webp",
    "image-v2/custom-result-2.webp",
  ]);
  assert.deepEqual(generated.data.outputs.map((output) => [output.format, output.mediaType, output.width, output.height]), [
    ["webp", "image/webp", 1024, 1024],
    ["webp", "image/webp", 1024, 1024],
  ]);
  assert.equal(generated.data.outputs[0].size, (await fs.stat(generated.data.outputs[0].path)).size);
  assert.match(generated.data.outputs[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(generated.data.outputs[1].revisedPrompt, "second revised");
  assert.equal(generated.data.providerRequestId, "req-multi-1");
  assert.deepEqual(generated.data.usage, {
    inputTokens: 11,
    inputTextTokens: 0,
    inputImageTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 22,
    reasoningOutputTokens: 0,
    totalTokens: 33,
  });
  assert.match(generated.data.requested.providerProfileRevision, /^[a-f0-9]{32}$/u);
  assert.match(generated.data.requested.configurationRevision, /^[a-f0-9]{32}$/u);
  assert.deepEqual(generated.data.requested, {
    provider: "wfl",
    operation: "generate",
    model: "gpt-image-2-test",
    providerProfileRevision: generated.data.requested.providerProfileRevision,
    configurationRevision: generated.data.requested.configurationRevision,
    prompt: "custom multi output",
    n: 2,
    size: "1024x1024",
    requestedSize: "1024x1024",
    providerSize: "1024x1024",
    sourceSize: null,
    requestedCanvas: "1024x1024",
    postprocess: [],
    quality: "high",
    outputFormat: "webp",
    outputCompression: 73,
    background: "opaque",
    moderation: "low",
    partialImages: 0,
    stream: false,
    sourceConsumed: false,
  });
  const { user: providerUser, ...providerGeneratePayload } = observed[0].json;
  assert.match(providerUser, /^wfl-image-user-v1_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(providerGeneratePayload, {
    model: "gpt-image-2-test",
    prompt: "custom multi output",
    n: 2,
    size: "1024x1024",
    quality: "high",
    output_format: "webp",
    output_compression: 73,
    background: "opaque",
    moderation: "low",
  });
  assert.equal(observed[0].path, "/v1/images/generations");
  assert.equal(observed[0].authorization, "Bearer image-v2-provider-secret");

  const streamedRequest = imageRequest({
    operation: "generate",
    prompt: "stream preview",
    project: defaultProject,
    destination: "image-v2/stream-result.png",
    size: "1024x1024",
    outputFormat: "png",
    stream: true,
    partialImages: 1,
  });
  const streamedResponse = await fetch(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(streamedRequest),
  });
  assert.equal(streamedResponse.status, 200);
  assert.match(streamedResponse.headers.get("content-type"), /^text\/event-stream/);
  const streamedText = await streamedResponse.text();
  assert.doesNotMatch(streamedText, /data:image|b64_json|[A-Za-z0-9+/]{1000}/);
  const streamedEvents = streamedText.split("\n\n").filter(Boolean).map((block) => {
    const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = block.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    return { event, data: JSON.parse(data) };
  });
  const partialEvent = streamedEvents.find((entry) => entry.event === "partial")?.data;
  const completedEvent = streamedEvents.find((entry) => entry.event === "completed")?.data;
  assert.match(partialEvent.url, /^\/api\/images\/v2\/partial\/[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(partialEvent, "dataUrl"), false);
  assert.deepEqual([partialEvent.width, partialEvent.height, partialEvent.mediaType], [1024, 1024, "image/png"]);
  assert.equal(completedEvent.outputs[0].relativePath, "image-v2/stream-result.png");
  assert.equal(completedEvent.outputs[0].revisedPrompt, "stream revised");
  assert.equal(completedEvent.providerRequestId, "req-stream-1");
  const partialUrl = `${partialEvent.url}?${new URLSearchParams({
    windowId: streamedRequest.windowId,
    operationId: streamedRequest.operationId,
  })}`;
  const unauthenticatedPartial = await fetch(`${baseUrl}${partialUrl}`);
  assert.equal(unauthenticatedPartial.status, 401);
  const wrongWindowPartial = await fetch(
    `${baseUrl}${partialEvent.url}?${new URLSearchParams({
      windowId: "f".repeat(64),
      operationId: streamedRequest.operationId,
    })}`,
    { headers: { Authorization: authorization } },
  );
  assert.equal(wrongWindowPartial.status, 404);
  const authorizedPartial = await fetch(`${baseUrl}${partialUrl}`, {
    headers: { Authorization: authorization },
  });
  assert.equal(authorizedPartial.status, 200);
  assert.equal(authorizedPartial.headers.get("content-type"), "image/png");
  assert.equal(authorizedPartial.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(Buffer.from(await authorizedPartial.arrayBuffer()), png1024);
  assert.equal(observed[1].json.user, providerUser);
  assert.equal(observed[1].json.stream, true);
  assert.equal(observed[1].json.partial_images, 1);

  const formatMismatchPath = path.join(defaultProject, "image-v2", "format-mismatch.png");
  const formatMismatch = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "generate",
      prompt: "wrong format path",
      project: defaultProject,
      destination: "image-v2/format-mismatch.png",
      outputFormat: "webp",
    })),
  });
  assert.equal(formatMismatch.response.status, 400);
  assert.equal(formatMismatch.data.error.code, "IMAGE_OUTPUT_FORMAT_MISMATCH");
  assert.equal(await exists(formatMismatchPath), false);
  assert.equal(observed.length, 2);

  const sizeMismatchPath = path.join(defaultProject, "image-v2", "size-mismatch.png");
  const sizeMismatch = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "generate",
      prompt: "wrong dimensions",
      project: defaultProject,
      destination: "image-v2/size-mismatch.png",
      size: "1024x1024",
      outputFormat: "png",
    })),
  });
  assert.equal(sizeMismatch.response.status, 502);
  assert.deepEqual(sizeMismatch.data.error, {
    code: "IMAGE_SIZE_MISMATCH",
    message: "图片供应商返回的图片尺寸与请求不符",
    retryable: false,
    requestedWidth: 1024,
    requestedHeight: 1024,
    actualWidth: 1024,
    actualHeight: 768,
    stage: "provider",
    operation: "generate",
    reason: "provider_output_mismatch",
    model: "gpt-image-2-test",
    requestedSize: "1024x1024",
    providerSize: "1024x1024",
  });
  assert.equal(await exists(sizeMismatchPath), false);

  await fs.writeFile(path.join(defaultProject, "image-v2", "source.png"), png1024);
  await fs.writeFile(path.join(defaultProject, "image-v2", "mask.png"), png1024);
  await fs.symlink("source.png", path.join(defaultProject, "image-v2", "linked-source.png"));
  await fs.symlink("mask.png", path.join(defaultProject, "image-v2", "linked-mask.png"));
  const unsafeSource = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "edit",
      prompt: "unsafe path",
      project: defaultProject,
      sourcePaths: ["../outside.png"],
    })),
  });
  assert.equal(unsafeSource.response.status, 400);
  assert.equal(unsafeSource.data.error.code, "INVALID_PROJECT_FILE_PATH");
  const editFailure = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "edit",
      prompt: "secure masked edit",
      project: defaultProject,
      destination: "image-v2/edit-result.png",
      sourcePaths: ["image-v2/source.png"],
      maskPath: "image-v2/mask.png",
      size: "1024x1024",
      outputFormat: "png",
    })),
  });
  assert.equal(editFailure.response.status, 429, JSON.stringify(editFailure.data));
  assert.deepEqual(editFailure.data.error, {
    code: "moderation_blocked",
    type: "provider_error",
    message: "图片供应商请求过多或额度不足",
    retryable: true,
    requestId: "req-edit-safe-1",
    providerStatusCode: 429,
    moderationDetails: {
      sexual: "high",
      nested: { flagged: true, label: "blocked" },
    },
    stage: "provider",
    operation: "edit",
    reason: "provider_moderation_blocked",
    model: "gpt-image-2-test",
    requestedSize: "1024x1024",
    providerSize: "1024x1024",
    sourceSize: "1024x1024",
  });
  assert.doesNotMatch(JSON.stringify(editFailure.data), /provider-secret|internal provider|must-not-pass|internal_trace/);
  const editRequest = observed.at(-1);
  assert.equal(editRequest.path, "/v1/images/edits");
  assert.match(editRequest.contentType, /^multipart\/form-data; boundary=/);
  const editMultipart = editRequest.body.toString("latin1");
  assert.match(editMultipart, /name="image\[\]"; filename="source\.png"/);
  assert.match(editMultipart, /name="mask"; filename="mask\.png"/);
  assert.match(editMultipart, /name="prompt"\r\n\r\nsecure masked edit/);
  assert.doesNotMatch(editMultipart, /linked-source|\.\.\/outside/);
  assert.equal(await exists(path.join(defaultProject, "image-v2", "edit-result.png")), false);

  const legacy = await fetchJson(`${baseUrl}/api/images/generate`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-generate",
    },
    body: JSON.stringify(imageRequest({
      prompt: "legacy compatible",
      project: defaultProject,
      outputPath: "image-v2/legacy.png",
    })),
  });
  assert.equal(legacy.response.status, 201, JSON.stringify(legacy.data));
  assert.equal(legacy.data.attachment.relativePath, "image-v2/legacy.png");
  assert.equal(legacy.data.attachment.mediaType, "image/png");
  assert.equal(legacy.data.attachment.size, (await fs.stat(legacy.data.attachment.path)).size);
  assert.equal(legacy.data.revisedPrompt, "legacy revised");
  assert.equal(legacy.data.model, "gpt-image-2-test");
  assert.equal(legacy.data.size, "1024x1024");
  assert.equal(observed.at(-1).json.n, 1);
  assert.equal(observed.at(-1).json.output_format, "png");
  assert.equal(observed.length, 5);

  const symlinkSource = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "edit",
      prompt: "unsafe symlink",
      project: defaultProject,
      sourcePaths: ["image-v2/linked-source.png"],
    })),
  });
  assert.equal(symlinkSource.response.status, 403);
  assert.equal(symlinkSource.data.error.code, "IMAGE_SOURCE_SYMLINK");

  const symlinkSecondSource = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "edit",
      prompt: "unsafe second source symlink",
      project: defaultProject,
      sourcePaths: ["image-v2/source.png", "image-v2/linked-source.png"],
    })),
  });
  assert.equal(symlinkSecondSource.response.status, 403);
  assert.equal(symlinkSecondSource.data.error.code, "IMAGE_SOURCE_SYMLINK");

  const symlinkMask = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "edit",
      prompt: "unsafe mask symlink",
      project: defaultProject,
      sourcePaths: ["image-v2/source.png"],
      maskPath: "image-v2/linked-mask.png",
    })),
  });
  assert.equal(symlinkMask.response.status, 403);
  assert.equal(symlinkMask.data.error.code, "IMAGE_SOURCE_SYMLINK");

  const limited = await fetchJson(`${baseUrl}/api/images/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-save",
    },
    body: JSON.stringify({
      providerId,
      preset: "openai-gpt-image-2",
      model: "gpt-image-2-test",
      defaults: { size: "1024x1024", quality: "auto", outputFormat: "png", n: 1 },
      limits: {
        maxInputBytesPerImage: png1024.length,
        maxInputBytesTotal: png1024.length + 1,
      },
    }),
  });
  assert.equal(limited.response.status, 200, JSON.stringify(limited.data));
  const observedBeforeTotalLimit = observed.length;
  const excessiveInputs = await fetchJson(`${baseUrl}/api/images/v2/execute`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-execute",
    },
    body: JSON.stringify(imageRequest({
      operation: "edit",
      prompt: "bounded staged inputs",
      project: defaultProject,
      destination: "image-v2/too-many-input-bytes.png",
      sourcePaths: ["image-v2/source.png", "image-v2/mask.png"],
      outputFormat: "png",
    })),
  });
  assert.equal(excessiveInputs.response.status, 413, JSON.stringify(excessiveInputs.data));
  assert.equal(excessiveInputs.data.error.code, "IMAGE_INPUTS_TOO_LARGE");
  assert.equal(observed.length, observedBeforeTotalLimit);
  assert.equal(await exists(path.join(defaultProject, "image-v2", "too-many-input-bytes.png")), false);

  const unacknowledgedProbe = await fetchJson(`${baseUrl}/api/images/compatibility-probe`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-probe",
    },
    body: JSON.stringify({ tests: ["generate-standard"] }),
  });
  assert.equal(unacknowledgedProbe.response.status, 400);
  assert.equal(unacknowledgedProbe.data.error.code, "IMAGE_PROBE_ACKNOWLEDGEMENT_REQUIRED");

  const compatibilityProbe = await fetchJson(`${baseUrl}/api/images/compatibility-probe`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-probe",
    },
    body: JSON.stringify({
      tests: ["generate-standard"],
      acknowledgeCharges: true,
    }),
  });
  assert.equal(compatibilityProbe.response.status, 200, JSON.stringify(compatibilityProbe.data));
  assert.equal(compatibilityProbe.response.headers.get("cache-control"), "no-store");
  assert.match(compatibilityProbe.data.jobId, /^[a-f0-9-]{36}$/u);
  assert.equal(compatibilityProbe.data.report.kind, "wfl-image-compatibility-probe");
  assert.equal(compatibilityProbe.data.report.tests.length, 1);
  assert.deepEqual(compatibilityProbe.data.report.tests[0], {
    id: "generate-standard",
    operation: "generate",
    requestedSize: "1024x1024",
    expectedSize: "1024x1024",
    customSize: false,
    mask: false,
    ok: true,
    durationMs: compatibilityProbe.data.report.tests[0].durationMs,
    providerRequestId: "req-probe-generate-1",
    usage: {
      inputTokens: 3,
      inputTextTokens: 0,
      inputImageTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 7,
    },
  });
  assert.equal(compatibilityProbe.data.report.recommendations.note.includes("不会自动修改"), true);
  assert.doesNotMatch(JSON.stringify(compatibilityProbe.data), /image-v2-provider-secret|apiKey|baseUrl/u);
});

test("official account operations use dedicated authenticated and same-origin endpoints", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/providers/official`);
  assert.equal(unauthenticated.status, 401);

  const query = await fetchJson(`${baseUrl}/api/providers/official`);
  assert.equal(query.response.status, 503);
  assert.match(query.data.error, /尚未就绪/);

  const missingAction = await fetchJson(`${baseUrl}/api/providers/official/login/start`, {
    method: "POST",
  });
  assert.equal(missingAction.response.status, 403);

  const confirmed = await fetchJson(`${baseUrl}/api/providers/official/login/start`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "official-login-start",
    },
  });
  assert.equal(confirmed.response.status, 503);
  assert.match(confirmed.data.error, /尚未就绪/);

  const blockedRpc = await websocketRequest(baseUrl.replace("http", "ws") + "/ws", {
    type: "rpc",
    requestId: "official-account-bypass",
    method: "account/read",
    params: {},
  });
  assert.equal(blockedRpc.type, "rpc/error");
  assert.match(blockedRpc.message, /Method not allowed/);
});

test("official account handoff ignores rebuildable Sidecar work but keeps account boundaries", () => {
  const handoff = serverSource.slice(
    serverSource.indexOf("  authHandoffSnapshot()"),
    serverSource.indexOf("  async prepareCodexAuthHandoff()"),
  );
  assert.doesNotMatch(handoff, /conversationSidecar|sidecarPending/);
  assert.match(handoff, /taskActive/);
  assert.match(handoff, /bridgePending/);
  assert.match(handoff, /quotaRefreshPending/);
  assert.match(handoff, /writeLeases/);

  const accountContext = serverSource.slice(
    serverSource.indexOf("  officialAccountContext()"),
    serverSource.indexOf("  authHandoffSnapshot()"),
  );
  assert.match(accountContext, /officialAccountEpoch/);
  assert.match(accountContext, /officialAccountContextIsCurrent/);

  const quotaRefresh = serverSource.slice(
    serverSource.indexOf("async function refreshOfficialQuota"),
    serverSource.indexOf("async function", serverSource.indexOf("async function refreshOfficialQuota") + 1),
  );
  assert.match(quotaRefresh, /officialAccountContextIsCurrent/);
});

test("rebuildable Sidecar state cannot block submissions or author conversation terminal state", () => {
  const submit = serverSource.slice(
    serverSource.indexOf("  async submitCodexRpc"),
    serverSource.indexOf("  async submitGoalMutation"),
  );
  assert.match(submit, /submissionDeduplicator\.run/);
  assert.match(submit, /this\.bridge\.request/);
  assert.doesNotMatch(submit, /conversationSidecar|getConversationSubmissionCoordinator/);

  const taskAuthority = serverSource.slice(
    serverSource.indexOf("  async authoritativeTaskSnapshot"),
    serverSource.indexOf("  async conversationSidecarRequest"),
  );
  assert.doesNotMatch(
    taskAuthority,
    /conversationSidecar|terminalTurn|reconciledTurnIds|runtime-task-idle/,
  );
  assert.doesNotMatch(serverSource, /\/api\/ops\/sidecar\/prune|cleanupExpiredOutbox/);

  const rpc = serverSource.slice(
    serverSource.indexOf("async function executeBrowserRpc"),
    serverSource.indexOf("async function injectImportedTranscript"),
  );
  assert.doesNotMatch(rpc, /CONVERSATION_SIDECAR_ENABLED\s*\?/);
});

test("managed and fallback provider restarts fence and drain App Server requests", () => {
  const bridge = serverSource.slice(
    serverSource.indexOf("class CodexBridge"),
    serverSource.indexOf("class UserRuntime"),
  );
  assert.match(bridge, /beginRequestFence/);
  assert.match(bridge, /ERR_CODEX_BRIDGE_FENCED/);
  assert.match(bridge, /allowWhileFenced: true/);

  const handoff = serverSource.slice(
    serverSource.indexOf("  async restartBridgeAfterProviderHandoff"),
    serverSource.indexOf("  async prepareCodexAuthHandoff"),
  );
  assert.match(handoff, /beginRequestFence/);
  assert.match(handoff, /waitForAuthHandoffIdle/);
  assert.match(handoff, /bridge\.restart/);
  assert.match(handoff, /endRequestFence/);

  for (const name of ["activateManagedProvider", "activateFallbackProvider"]) {
    const start = serverSource.indexOf(`async function ${name}`);
    const activation = serverSource.slice(start, serverSource.indexOf("async function", start + 1));
    assert.match(activation, /restartBridgeAfterProviderHandoff/);
    assert.doesNotMatch(activation, /bridge\.restart/);
  }
});

test("rejects browser-supplied dynamic tools and remote execution environments", async () => {
  const dynamicTools = await websocketRequest(baseUrl.replace("http", "ws") + "/ws", {
    type: "rpc",
    requestId: "dynamic-tools-bypass",
    method: "thread/start",
    params: {
      cwd: defaultProject,
      dynamicTools: [],
    },
  });
  assert.equal(dynamicTools.type, "rpc/error");
  assert.match(dynamicTools.message, /动态工具默认关闭/);

  const environments = await websocketRequest(baseUrl.replace("http", "ws") + "/ws", {
    type: "rpc",
    requestId: "environment-bypass",
    method: "turn/start",
    params: {
      threadId: "thread-environment-bypass",
      input: [],
      environments: [],
    },
  });
  assert.equal(environments.type, "rpc/error");
  assert.match(environments.message, /执行环境尚未开放/);
});

test("uploads attachments only inside the selected project", async () => {
  const payload = Buffer.from("attachment content");
  const url = new URL(`${baseUrl}/api/uploads`);
  url.searchParams.set("project", defaultProject);
  url.searchParams.set("name", "notes.txt");
  const result = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Type": "text/plain",
    },
    body: payload,
  });

  assert.equal(result.response.status, 201);
  assert.equal(result.data.name, "notes.txt");
  assert.equal(result.data.mediaType, "text/plain");
  assert.equal(result.data.sha256, crypto.createHash("sha256").update(payload).digest("hex"));
  assert.equal(path.dirname(result.data.path), path.join(defaultProject, ".codex-uploads"));
  assert.deepEqual(await fs.readFile(result.data.path), payload);
});

test("rejects attachment uploads outside the project root", async () => {
  const url = new URL(`${baseUrl}/api/uploads`);
  url.searchParams.set("project", "/tmp/outside-project");
  url.searchParams.set("name", "notes.txt");
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("blocked"),
  });

  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /project path/i);
});

test("serves uploaded image previews from inside the project root", async () => {
  const payload = Buffer.from("fake png payload");
  const uploadUrl = new URL(`${baseUrl}/api/uploads`);
  uploadUrl.searchParams.set("project", defaultProject);
  uploadUrl.searchParams.set("name", "reference.png");
  const uploaded = await fetchJson(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Type": "image/png",
    },
    body: payload,
  });
  const previewUrl = new URL(`${baseUrl}/api/files/image`);
  previewUrl.searchParams.set("path", uploaded.data.path);
  const preview = await fetch(previewUrl, { headers: { Authorization: authorization } });

  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), payload);
});

test("serves Codex generated images only from the signed-in user's generated image directory", async () => {
  const payload = Buffer.from("fake generated png payload");
  const generatedDirectory = path.join(ownerCodexHome, "generated_images", "thread-test");
  const generatedPath = path.join(generatedDirectory, "generated.png");
  const privatePath = path.join(ownerCodexHome, "private.png");
  await fs.mkdir(generatedDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(generatedPath, payload),
    fs.writeFile(privatePath, payload),
  ]);

  const previewUrl = new URL(`${baseUrl}/api/files/image`);
  previewUrl.searchParams.set("path", generatedPath);
  const preview = await fetch(previewUrl, { headers: { Authorization: authorization } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), payload);

  previewUrl.searchParams.set("path", privatePath);
  const rejected = await fetchJson(previewUrl);
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.data.error, /invalid file path/i);
});

test("serves cached WebP conversation previews without replacing the original image", async () => {
  const payload = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const generatedDirectory = path.join(ownerCodexHome, "generated_images", "preview-test");
  const generatedPath = path.join(generatedDirectory, "generated.png");
  await fs.mkdir(generatedDirectory, { recursive: true });
  await fs.writeFile(generatedPath, payload);

  const previewUrl = new URL(`${baseUrl}/api/files/image`);
  previewUrl.searchParams.set("path", generatedPath);
  previewUrl.searchParams.set("preview", "standard");
  const preview = await fetch(previewUrl, { headers: { Authorization: authorization } });
  const previewBody = Buffer.from(await preview.arrayBuffer());
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal(preview.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(previewBody.subarray(0, 4).toString("ascii"), "RIFF");
  const cached = await fetch(previewUrl, { headers: { Authorization: authorization } });
  assert.equal(cached.status, 200);
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), previewBody);
  const previewCacheEntries = await fs.readdir(path.join(runtimeDirectory, "image-previews"));
  assert.equal(previewCacheEntries.some((name) => /^[a-f0-9]{64}\.webp$/.test(name)), true);
  assert.equal(await exists(path.join(stateDirectory, "image-previews")), false);

  const originalUrl = new URL(`${baseUrl}/api/files/image`);
  originalUrl.searchParams.set("path", generatedPath);
  const original = await fetch(originalUrl, { headers: { Authorization: authorization } });
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), payload);
});

test("rejects oversized image previews before streaming them to the browser", async () => {
  const oversizedPath = path.join(defaultProject, "oversized-preview.png");
  const handle = await fs.open(oversizedPath, "w");
  try {
    await handle.truncate(20 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  const previewUrl = new URL(`${baseUrl}/api/files/image`);
  previewUrl.searchParams.set("path", oversizedPath);
  const preview = await fetchJson(previewUrl);

  assert.equal(preview.response.status, 413);
  assert.match(preview.data.error, /safe size limit/i);
});

test("imports guarded tar.gz projects and rejects unsafe archives", async () => {
  const normalArchive = await createProjectArchive();
  const importedUrl = new URL(`${baseUrl}/api/projects/import`);
  importedUrl.searchParams.set("name", "imported-project");
  const imported = await fetchJson(importedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-import",
    },
    body: normalArchive,
  });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.data));
  assert.equal(imported.data.project.name, "imported-project");
  assert.equal(await fs.readFile(path.join(projectRoot, "imported-project", "README.md"), "utf8"), "imported project\n");

  const duplicate = await fetchJson(importedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-import",
    },
    body: normalArchive,
  });
  assert.equal(duplicate.response.status, 409);
  assert.match(duplicate.data.error, /同名工程/);

  const missingActionUrl = new URL(`${baseUrl}/api/projects/import`);
  missingActionUrl.searchParams.set("name", "missing-action");
  const missingAction = await fetchJson(missingActionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/gzip", Origin: baseUrl },
    body: normalArchive,
  });
  assert.equal(missingAction.response.status, 403);
  assert.equal(await exists(path.join(projectRoot, "missing-action")), false);

  const traversalUrl = new URL(`${baseUrl}/api/projects/import`);
  traversalUrl.searchParams.set("name", "traversal-project");
  const traversal = await fetchJson(traversalUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-import",
    },
    body: await createProjectArchive({ traversal: true }),
  });
  assert.equal(traversal.response.status, 400);
  assert.match(traversal.data.error, /不安全路径/);
  assert.equal(await exists(path.join(projectRoot, "traversal-project")), false);

  const symlinkUrl = new URL(`${baseUrl}/api/projects/import`);
  symlinkUrl.searchParams.set("name", "symlink-project");
  const symlink = await fetchJson(symlinkUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-import",
    },
    body: await createProjectArchive({ symlink: true }),
  });
  assert.equal(symlink.response.status, 400);
  assert.match(symlink.data.error, /链接或特殊设备/);
  assert.equal(await exists(path.join(projectRoot, "symlink-project")), false);
});

test("browses, searches, and previews project files without path traversal", async () => {
  const sourceDir = path.join(defaultProject, "src");
  const sourceFile = path.join(sourceDir, "sample-controller.js");
  const internalDir = path.join(defaultProject, ".codex-desktop");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(internalDir, { recursive: true });
  await fs.writeFile(sourceFile, "export const ready = true;\n");
  await fs.chmod(sourceFile, 0o640);
  await fs.writeFile(path.join(internalDir, "private.txt"), "hidden\n");

  const listUrl = new URL(`${baseUrl}/api/files/list`);
  listUrl.searchParams.set("project", defaultProject);
  const listed = await fetchJson(listUrl);
  assert.equal(listed.response.status, 200);
  assert.ok(listed.data.entries.some((entry) => entry.name === "src" && entry.type === "directory"));
  assert.equal(listed.data.entries.some((entry) => entry.name === ".codex-desktop"), false);

  const searchUrl = new URL(`${baseUrl}/api/files/search`);
  searchUrl.searchParams.set("project", defaultProject);
  searchUrl.searchParams.set("query", "controller");
  const searched = await fetchJson(searchUrl);
  assert.equal(searched.response.status, 200);
  assert.equal(searched.data.entries[0].relativePath, "src/sample-controller.js");

  const readUrl = new URL(`${baseUrl}/api/files/read`);
  readUrl.searchParams.set("project", defaultProject);
  readUrl.searchParams.set("path", sourceFile);
  const read = await fetchJson(readUrl);
  assert.equal(read.response.status, 200);
  assert.equal(read.data.content, "export const ready = true;\n");
  assert.equal(read.data.editable, true);
  assert.match(read.data.version, /^[a-f0-9]{64}$/);
  assert.equal(read.data.mode, 0o640);
  assert.ok(Number.isInteger(read.data.uid));
  assert.ok(Number.isInteger(read.data.gid));
  assert.equal(listed.data.entries.find((entry) => entry.name === "src").mode, 0o755);

  const largeFile = path.join(sourceDir, "large-unicode.txt");
  await fs.writeFile(largeFile, "🙂".repeat(300_000));
  readUrl.searchParams.set("path", largeFile);
  const largePreview = await fetchJson(readUrl);
  assert.equal(largePreview.response.status, 200);
  assert.equal(largePreview.data.truncated, true);
  assert.ok(Number.isSafeInteger(largePreview.data.nextOffset));
  assert.ok(largePreview.data.nextOffset > 0);
  assert.doesNotMatch(largePreview.data.content, /�/u);
  const chunkUrl = new URL(`${baseUrl}/api/files/read-chunk`);
  chunkUrl.searchParams.set("project", defaultProject);
  chunkUrl.searchParams.set("path", largeFile);
  chunkUrl.searchParams.set("offset", String(largePreview.data.nextOffset));
  const nextChunk = await fetchJson(chunkUrl);
  assert.equal(nextChunk.response.status, 200);
  assert.equal(nextChunk.data.offset, largePreview.data.nextOffset);
  assert.ok(nextChunk.data.nextOffset > nextChunk.data.offset);
  assert.doesNotMatch(nextChunk.data.content, /�/u);

  const selectedArchive = await fetch(`${baseUrl}/api/files/archive`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: defaultProject, paths: [sourceFile, largeFile] }),
  });
  assert.equal(selectedArchive.status, 200);
  assert.match(selectedArchive.headers.get("content-disposition"), /WFL-Codex-selection/);
  assert.ok((await selectedArchive.arrayBuffer()).byteLength > 0);

  readUrl.searchParams.set("path", sourceFile);

  const downloadUrl = new URL(`${baseUrl}/api/files/download`);
  downloadUrl.searchParams.set("project", defaultProject);
  downloadUrl.searchParams.set("path", sourceFile);
  const downloaded = await fetch(downloadUrl, { headers: { Authorization: authorization } });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition"), /attachment/);
  assert.equal(await downloaded.text(), "export const ready = true;\n");

  const missingConfirmation = await fetch(`${baseUrl}/api/files/write?project=${encodeURIComponent(defaultProject)}&path=${encodeURIComponent(sourceFile)}`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Codex-Desktop-File-Version": read.data.version,
    },
    body: "export const ready = false;\n",
  });
  assert.equal(missingConfirmation.status, 403);

  const beforeWrite = await fs.stat(sourceFile);
  const saved = await fetchJson(`${baseUrl}/api/files/write?project=${encodeURIComponent(defaultProject)}&path=${encodeURIComponent(sourceFile)}`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Codex-Desktop-Action": "resource-file-save",
      "X-Codex-Desktop-File-Version": read.data.version,
    },
    body: "export const ready = false;\n",
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.content, "export const ready = false;\n");
  assert.notEqual(saved.data.version, read.data.version);
  const afterWrite = await fs.stat(sourceFile);
  assert.equal(afterWrite.mode & 0o777, beforeWrite.mode & 0o777);
  assert.equal(afterWrite.uid, beforeWrite.uid);
  assert.equal(afterWrite.gid, beforeWrite.gid);

  await fs.writeFile(sourceFile, "export const changedByCodex = true;\n");
  const conflict = await fetchJson(`${baseUrl}/api/files/write?project=${encodeURIComponent(defaultProject)}&path=${encodeURIComponent(sourceFile)}`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Codex-Desktop-Action": "resource-file-save",
      "X-Codex-Desktop-File-Version": saved.data.version,
    },
    body: "export const overwrite = true;\n",
  });
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.data.error, /其他任务修改/);
  assert.equal(await fs.readFile(sourceFile, "utf8"), "export const changedByCodex = true;\n");

  readUrl.searchParams.set("path", "/etc/passwd");
  const blocked = await fetchJson(readUrl);
  assert.equal(blocked.response.status, 400);
  assert.match(blocked.data.error, /outside the project/i);

  readUrl.searchParams.set("path", path.join(internalDir, "private.txt"));
  const protectedFile = await fetchJson(readUrl);
  assert.equal(protectedFile.response.status, 403);
  assert.match(protectedFile.data.error, /protected/i);
});

test("opens a scoped map project tree and creates map sessions from relative paths", async (t) => {
  const projectDirectory = path.join(defaultProject, "map-project-http");
  const mapsDirectory = path.join(projectDirectory, "maps");
  const privateDirectory = path.join(projectDirectory, "private");
  const projectFile = path.join(projectDirectory, "game.tiled-project");
  const mapPath = path.join(mapsDirectory, "world.tmj");
  const tilesetPath = path.join(mapsDirectory, "terrain.tsj");
  await Promise.all([
    fs.mkdir(mapsDirectory, { recursive: true }),
    fs.mkdir(privateDirectory, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(projectFile, `${JSON.stringify({
      compatibilityVersion: "1.12",
      folders: ["maps"],
      propertyTypes: [],
    })}\n`),
    fs.writeFile(mapPath, `${JSON.stringify({
      type: "map",
      orientation: "orthogonal",
      renderorder: "right-down",
      width: 2,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      infinite: false,
      nextlayerid: 2,
      nextobjectid: 1,
      layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 2, height: 2, data: [0, 0, 0, 0] }],
      tilesets: [],
    })}\n`),
    fs.writeFile(tilesetPath, `${JSON.stringify({
      columns: 0,
      name: "Terrain",
      tilecount: 0,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.12",
    })}\n`),
    fs.writeFile(path.join(privateDirectory, "secret.tmj"), '{"type":"map"}\n'),
  ]);
  t.after(() => fs.rm(projectDirectory, { recursive: true, force: true }));

  const projectFileRelative = "map-project-http/game.tiled-project";
  const unconfirmed = await fetchJson(`${baseUrl}/api/map-projects/sessions`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ project: defaultProject, projectFile: projectFileRelative }),
  });
  assert.equal(unconfirmed.response.status, 403);

  const opened = await fetchJson(`${baseUrl}/api/map-projects/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-session-open",
    },
    body: JSON.stringify({ project: defaultProject, projectFile: projectFileRelative }),
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  const projectSession = opened.data.session;
  assert.equal(projectSession.projectFile, projectFileRelative);
  assert.equal(projectSession.temporary, false);
  assert.deepEqual(projectSession.resourceRoots, ["map-project-http/maps"]);
  assert.equal(projectSession.manifest.compatibilityVersion, "1.12");
  assert.equal(JSON.stringify(opened.data).includes(defaultProject), false);

  const rootTree = await fetchJson(
    `${baseUrl}/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}/tree?limit=1`,
  );
  assert.equal(rootTree.response.status, 200, JSON.stringify(rootTree.data));
  assert.deepEqual(rootTree.data.tree.entries.map((entry) => entry.path), ["map-project-http"]);
  assert.equal(JSON.stringify(rootTree.data).includes(defaultProject), false);

  const projectTree = await fetchJson(
    `${baseUrl}/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}/tree?directory=${encodeURIComponent("map-project-http")}`,
  );
  assert.equal(projectTree.response.status, 200, JSON.stringify(projectTree.data));
  assert.deepEqual(projectTree.data.tree.entries.map(({ path: entryPath, kind }) => [entryPath, kind]), [
    ["map-project-http/maps", "directory"],
    ["map-project-http/game.tiled-project", "project"],
  ]);

  const searchUrl = new URL(
    `/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}/search`,
    baseUrl,
  );
  searchUrl.searchParams.set("query", "world");
  searchUrl.searchParams.set("kinds", "map");
  const searched = await fetchJson(searchUrl);
  assert.equal(searched.response.status, 200, JSON.stringify(searched.data));
  assert.deepEqual(searched.data.search.entries.map((entry) => entry.path), [
    "map-project-http/maps/world.tmj",
  ]);

  const resourceVersionUrl = new URL(
    `/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}/resource-version`,
    baseUrl,
  );
  resourceVersionUrl.searchParams.set("path", "map-project-http/maps/world.tmj");
  resourceVersionUrl.searchParams.set("kind", "map");
  const resourceVersion = await fetchJson(resourceVersionUrl);
  assert.equal(resourceVersion.response.status, 200, JSON.stringify(resourceVersion.data));
  assert.equal(resourceVersion.data.projectSessionId, projectSession.id);
  assert.equal(resourceVersion.data.resource.relativePath, "map-project-http/maps/world.tmj");
  assert.match(resourceVersion.data.resource.version, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(resourceVersion.data.resource, "content"), false);
  const wrongResourceKindUrl = new URL(resourceVersionUrl);
  wrongResourceKindUrl.searchParams.set("kind", "tileset");
  const wrongResourceKind = await fetchJson(wrongResourceKindUrl);
  assert.equal(wrongResourceKind.response.status, 415);
  assert.equal(wrongResourceKind.data.code, "map-project-resource-kind-mismatch");
  const protectedResourceVersionUrl = new URL(resourceVersionUrl);
  protectedResourceVersionUrl.searchParams.set("path", "map-project-http/private/secret.tmj");
  const protectedResourceVersion = await fetchJson(protectedResourceVersionUrl);
  assert.equal(protectedResourceVersion.response.status, 403);
  assert.equal(protectedResourceVersion.data.code, "map-project-resource-outside-folders");

  const outsideTree = await fetchJson(
    `${baseUrl}/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}/tree?directory=${encodeURIComponent("map-project-http/private")}`,
  );
  assert.equal(outsideTree.response.status, 403);
  assert.equal(outsideTree.data.code, "map-project-directory-outside-folders");

  const createUrl = `${baseUrl}/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}/maps`;
  const createBody = {
    relativePath: "map-project-http/maps/new-zone.tmj",
    orientation: "hexagonal",
    infinite: false,
    width: 5,
    height: 4,
    tilewidth: 16,
    tileheight: 16,
    staggeraxis: "y",
    staggerindex: "odd",
    hexsidelength: 8,
    backgroundcolor: "#102030ff",
    initialLayerName: "Ground",
    tilesets: ["map-project-http/maps/terrain.tsj"],
    targetVersion: "1.12.2",
  };
  const unconfirmedCreate = await fetchJson(createUrl, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  assert.equal(unconfirmedCreate.response.status, 403);
  const created = await fetchJson(createUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-map-create",
    },
    body: JSON.stringify(createBody),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.map.relativePath, createBody.relativePath);
  assert.equal(created.data.map.orientation, "hexagonal");
  assert.equal(created.data.map.tilesetCount, 1);
  assert.equal(JSON.stringify(created.data).includes(defaultProject), false);
  const createdDocument = JSON.parse(await fs.readFile(
    path.join(defaultProject, "map-project-http", "maps", "new-zone.tmj"),
    "utf8",
  ));
  assert.deepEqual(createdDocument.tilesets, [{ firstgid: 1, source: "terrain.tsj" }]);
  assert.equal(createdDocument.tiledversion, "1.12.2");

  const duplicate = await fetchJson(createUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-map-create",
    },
    body: JSON.stringify(createBody),
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, "map-project-map-exists");
  const blockedCreate = await fetchJson(createUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-map-create",
    },
    body: JSON.stringify({ ...createBody, relativePath: "map-project-http/private/new-zone.tmj" }),
  });
  assert.equal(blockedCreate.response.status, 403);
  assert.equal(blockedCreate.data.code, "map-project-resource-outside-folders");
  const wrongTileset = await fetchJson(createUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-map-create",
    },
    body: JSON.stringify({
      ...createBody,
      relativePath: "map-project-http/maps/wrong-tileset.tmj",
      tilesets: ["map-project-http/maps/world.tmj"],
    }),
  });
  assert.equal(wrongTileset.response.status, 415);
  assert.equal(wrongTileset.data.code, "map-project-resource-kind-mismatch");

  const editorInstanceId = "map-project-http-editor-0001";
  const mapOpened = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-session-open",
    },
    body: JSON.stringify({
      projectSessionId: projectSession.id,
      path: "map-project-http/maps/world.tmj",
      editorInstanceId,
    }),
  });
  assert.equal(mapOpened.response.status, 201, JSON.stringify(mapOpened.data));
  assert.equal(mapOpened.data.session.relativePath, "map-project-http/maps/world.tmj");
  assert.equal(mapOpened.data.session.writable, true);

  const blockedMap = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-session-open",
    },
    body: JSON.stringify({
      projectSessionId: projectSession.id,
      path: "map-project-http/private/secret.tmj",
      editorInstanceId: "map-project-http-editor-0002",
    }),
  });
  assert.equal(blockedMap.response.status, 403);
  assert.equal(blockedMap.data.code, "map-project-resource-outside-folders");

  const closedMap = await fetch(`${baseUrl}/api/maps/sessions/${encodeURIComponent(mapOpened.data.session.id)}`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "map-session-close",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(closedMap.status, 204);
  const closedProject = await fetch(
    `${baseUrl}/api/map-projects/sessions/${encodeURIComponent(projectSession.id)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: authorization,
        Origin: baseUrl,
        "X-Codex-Desktop-Action": "map-project-session-close",
      },
    },
  );
  assert.equal(closedProject.status, 204);
});

test("streams maps larger than the text editor limit with window and version isolation", async (t) => {
  const mapDirectory = path.join(defaultProject, "map-session-test");
  const mapPath = path.join(mapDirectory, "large-world.tmj");
  const otherMapPath = path.join(mapDirectory, "private-world.tmj");
  const gameEntryPath = path.join(mapDirectory, "index.html");
  const assetDirectory = path.join(mapDirectory, "assets");
  const tilesetPath = path.join(assetDirectory, "world.tsj");
  const imagePath = path.join(assetDirectory, "terrain.png");
  const tilesetImagePath = path.join(assetDirectory, "tileset-only.png");
  const privateImagePath = path.join(assetDirectory, "private.png");
  const importableImagePath = path.join(assetDirectory, "importable.png");
  const importableTilesetPath = path.join(assetDirectory, "importable.tsj");
  const importableSheetPath = path.join(assetDirectory, "importable-sheet.png");
  const importableTilePath = path.join(assetDirectory, "importable-tile.png");
  const invalidImportImagePath = path.join(assetDirectory, "invalid-import.png");
  const invalidImportTilesetPath = path.join(assetDirectory, "invalid-import.tsj");
  const mapDocument = {
    type: "map",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ id: 1, name: "Backdrop", type: "imagelayer", image: "assets/terrain.png" }],
    tilesets: [{ firstgid: 1, source: "assets/world.tsj" }],
    unknownLargeField: "地图🙂".repeat(220_000),
  };
  const content = `${JSON.stringify(mapDocument)}\n`;
  assert.ok(Buffer.byteLength(content) > 1024 * 1024);
  await fs.mkdir(assetDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(mapPath, content),
    fs.writeFile(gameEntryPath, "<!doctype html><title>Map preview</title>\n"),
    fs.writeFile(otherMapPath, `${JSON.stringify({
      type: "map",
      width: 1,
      height: 1,
      tilewidth: 16,
      tileheight: 16,
      layers: [{ id: 1, name: "Private", type: "imagelayer", image: "assets/private.png" }],
      tilesets: [],
    })}\n`),
    fs.writeFile(tilesetPath, `${JSON.stringify({
      type: "tileset",
      name: "World",
      tilewidth: 1,
      tileheight: 1,
      tilecount: 1,
      columns: 1,
      image: "tileset-only.png",
      imagewidth: 1,
      imageheight: 1,
    })}\n`),
    fs.writeFile(imagePath, VALID_TEST_PNG),
    fs.writeFile(tilesetImagePath, VALID_TEST_PNG),
    fs.writeFile(privateImagePath, VALID_TEST_PNG),
    fs.writeFile(importableImagePath, VALID_TEST_PNG),
    fs.writeFile(importableSheetPath, VALID_TEST_PNG),
    fs.writeFile(importableTilePath, VALID_TEST_PNG),
    fs.writeFile(invalidImportImagePath, Buffer.from("not-a-png")),
    fs.writeFile(importableTilesetPath, JSON.stringify({
      type: "tileset",
      name: "Importable",
      image: "importable-sheet.png",
      tiles: [{ id: 1, image: "importable-tile.png" }],
    })),
    fs.writeFile(invalidImportTilesetPath, JSON.stringify({
      type: "tileset",
      name: "Invalid import",
      image: "invalid-import.png",
    })),
  ]);
  t.after(() => fs.rm(mapDirectory, { recursive: true, force: true }));

  const editorInstanceId = "map-editor-window-0001";
  const missingConfirmation = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ project: defaultProject, path: mapPath, editorInstanceId }),
  });
  assert.equal(missingConfirmation.response.status, 403);

  const opened = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-session-open",
    },
    body: JSON.stringify({ project: defaultProject, path: mapPath, editorInstanceId }),
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  assert.equal(opened.data.session.relativePath, "map-session-test/large-world.tmj");
  assert.equal(opened.data.session.writable, true);
  assert.ok(opened.data.session.size > 1024 * 1024);
  assert.match(opened.data.session.version, /^[a-f0-9]{64}$/u);

  const wrongWindowUrl = new URL(
    `/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/content`,
    baseUrl,
  );
  wrongWindowUrl.searchParams.set("version", opened.data.session.version);
  wrongWindowUrl.searchParams.set("offset", String(opened.data.session.firstChunk.nextOffset));
  const wrongWindow = await fetchJson(wrongWindowUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": "map-editor-window-0002" },
  });
  assert.equal(wrongWindow.response.status, 404);

  let reconstructed = opened.data.session.firstChunk.content;
  let offset = opened.data.session.firstChunk.nextOffset;
  while (offset < opened.data.session.size) {
    const chunkUrl = new URL(
      `/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/content`,
      baseUrl,
    );
    chunkUrl.searchParams.set("version", opened.data.session.version);
    chunkUrl.searchParams.set("offset", String(offset));
    const chunk = await fetchJson(chunkUrl, {
      headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
    });
    assert.equal(chunk.response.status, 200, JSON.stringify(chunk.data));
    reconstructed += chunk.data.content;
    offset = chunk.data.nextOffset;
  }
  assert.equal(reconstructed, content);
  assert.equal(JSON.parse(reconstructed).unknownLargeField, mapDocument.unknownLargeField);

  const previewEntries = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/preview-entries`,
    { headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId } },
  );
  assert.equal(previewEntries.response.status, 200, JSON.stringify(previewEntries.data));
  assert.equal(
    previewEntries.data.entries.some((entry) => entry.path === "map-session-test/index.html"),
    true,
  );
  const wrongWindowPreviewEntries = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/preview-entries`,
    { headers: { "X-Codex-Desktop-Editor-Instance": "map-editor-window-0002" } },
  );
  assert.equal(wrongWindowPreviewEntries.response.status, 404);
  const gamePreview = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/preview`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-game-preview",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
      body: JSON.stringify({ entry: "map-session-test/index.html" }),
    },
  );
  assert.equal(gamePreview.response.status, 201, JSON.stringify(gamePreview.data));
  assert.equal(gamePreview.data.entry, "map-session-test/index.html");
  const gamePreviewPage = await fetch(`${baseUrl}${gamePreview.data.url}`);
  assert.equal(gamePreviewPage.status, 200);
  assert.match(await gamePreviewPage.text(), /Map preview/u);

  const resourceUrl = new URL(
    `/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/resource`,
    baseUrl,
  );
  resourceUrl.searchParams.set("path", "map-session-test/assets/world.tsj");
  const tileset = await fetch(resourceUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(tileset.status, 200);
  assert.match(tileset.headers.get("content-type"), /application\/json/u);
  assert.equal((await tileset.json()).name, "World");

  resourceUrl.searchParams.set("path", "map-session-test/assets/terrain.png");
  const image = await fetch(resourceUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(image.status, 200);
  assert.equal(Buffer.from(await image.arrayBuffer()).toString("hex"), VALID_TEST_PNG.toString("hex"));

  resourceUrl.searchParams.set("path", "map-session-test/assets/tileset-only.png");
  const tilesetImage = await fetch(resourceUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(tilesetImage.status, 200);
  assert.equal(Buffer.from(await tilesetImage.arrayBuffer()).toString("hex"), VALID_TEST_PNG.toString("hex"));

  resourceUrl.searchParams.set("path", "map-session-test/assets/private.png");
  const unreferenced = await fetchJson(resourceUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(unreferenced.response.status, 403);
  assert.equal(unreferenced.data.code, "map-resource-not-referenced");

  const assetCatalogUrl = new URL(
    `/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/assets`,
    baseUrl,
  );
  assetCatalogUrl.searchParams.set("directory", "map-session-test/assets");
  const assetCatalog = await fetchJson(assetCatalogUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(assetCatalog.response.status, 200, JSON.stringify(assetCatalog.data));
  assert.equal(assetCatalog.data.mapVersion, opened.data.session.version);
  assert.equal(assetCatalog.data.writable, true);
  assert.equal(
    assetCatalog.data.catalog.entries.some((entry) => (
      entry.path === "map-session-test/assets/importable.png" && entry.kind === "image"
    )),
    true,
  );
  assert.equal(JSON.stringify(assetCatalog.data).includes(defaultProject), false);
  const wrongWindowCatalog = await fetchJson(assetCatalogUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": "map-editor-window-0002" },
  });
  assert.equal(wrongWindowCatalog.response.status, 404);

  const grantUrl = `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/assets/grant`;
  const grantedImage = await fetchJson(grantUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-resource-grant",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      resourcePath: "map-session-test/assets/importable.png",
      expectedKind: "image",
      expectedVersion: opened.data.session.version,
    }),
  });
  assert.equal(grantedImage.response.status, 201, JSON.stringify(grantedImage.data));
  assert.equal(grantedImage.data.resource.width, 1);
  assert.equal(grantedImage.data.resource.height, 1);
  assert.equal(grantedImage.data.resource.path, "map-session-test/assets/importable.png");
  assert.equal(
    grantedImage.data.resource.sha256,
    crypto.createHash("sha256").update(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )).digest("hex"),
  );
  assert.equal(Object.hasOwn(grantedImage.data.resource, "absolutePath"), false);

  resourceUrl.searchParams.set("path", "map-session-test/assets/importable.png");
  const newlyGranted = await fetch(resourceUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(newlyGranted.status, 200);
  assert.equal(Buffer.from(await newlyGranted.arrayBuffer()).subarray(1, 4).toString("ascii"), "PNG");

  const grantedTileset = await fetchJson(grantUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-resource-grant",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      resourcePath: "map-session-test/assets/importable.tsj",
      expectedKind: "tileset",
      expectedVersion: opened.data.session.version,
    }),
  });
  assert.equal(grantedTileset.response.status, 201, JSON.stringify(grantedTileset.data));
  assert.deepEqual(grantedTileset.data.resource.dependencies.map((entry) => entry.path), [
    "map-session-test/assets/importable-sheet.png",
    "map-session-test/assets/importable-tile.png",
  ]);
  assert.deepEqual(grantedTileset.data.grant.granted, [
    "map-session-test/assets/importable.tsj",
    "map-session-test/assets/importable-sheet.png",
    "map-session-test/assets/importable-tile.png",
  ]);
  for (const resourcePath of [
    "map-session-test/assets/importable.tsj",
    "map-session-test/assets/importable-sheet.png",
    "map-session-test/assets/importable-tile.png",
  ]) {
    resourceUrl.searchParams.set("path", resourcePath);
    const dependency = await fetch(resourceUrl, {
      headers: {
        Authorization: authorization,
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
    });
    assert.equal(dependency.status, 200, resourcePath);
  }

  const invalidTilesetGrant = await fetchJson(grantUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-resource-grant",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      resourcePath: "map-session-test/assets/invalid-import.tsj",
      expectedKind: "tileset",
      expectedVersion: opened.data.session.version,
    }),
  });
  assert.equal(invalidTilesetGrant.response.status, 415);
  resourceUrl.searchParams.set("path", "map-session-test/assets/invalid-import.tsj");
  const invalidTilesetResource = await fetchJson(resourceUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(invalidTilesetResource.response.status, 403);

  const invalidGrant = await fetchJson(grantUrl, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-resource-grant",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      resourcePath: "map-session-test/assets/invalid-import.png",
      expectedKind: "image",
      expectedVersion: opened.data.session.version,
    }),
  });
  assert.equal(invalidGrant.response.status, 415);

  const otherOpened = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-session-open",
    },
    body: JSON.stringify({ project: defaultProject, path: otherMapPath, editorInstanceId }),
  });
  assert.equal(otherOpened.response.status, 201, JSON.stringify(otherOpened.data));
  const otherResourceUrl = new URL(
    `/api/maps/sessions/${encodeURIComponent(otherOpened.data.session.id)}/resource`,
    baseUrl,
  );
  otherResourceUrl.searchParams.set("path", "map-session-test/assets/private.png");
  const referencedByOtherMap = await fetch(otherResourceUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(referencedByOtherMap.status, 200);
  assert.equal(Buffer.from(await referencedByOtherMap.arrayBuffer()).toString("hex"), VALID_TEST_PNG.toString("hex"));

  resourceUrl.searchParams.set("path", "/etc/passwd");
  const escapedResource = await fetchJson(resourceUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(escapedResource.response.status, 400);

  const savedMapContent = Buffer.from(`${JSON.stringify({ ...mapDocument, savedByHttpTest: true }, null, 2)}\n`);
  const savedMapHash = crypto.createHash("sha256").update(savedMapContent).digest("hex");
  const wrongSaveWindow = await fetchJson(`${baseUrl}/api/maps/save-sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-save-start",
      "X-Codex-Desktop-Editor-Instance": "map-editor-window-0002",
    },
    body: JSON.stringify({
      mapSessionId: opened.data.session.id,
      expectedVersion: opened.data.session.version,
      totalBytes: savedMapContent.length,
      totalHash: savedMapHash,
      clientOperationId: "map-save-http-wrong-window",
    }),
  });
  assert.equal(wrongSaveWindow.response.status, 404);

  const saveStarted = await fetchJson(`${baseUrl}/api/maps/save-sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-save-start",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      mapSessionId: opened.data.session.id,
      expectedVersion: opened.data.session.version,
      totalBytes: savedMapContent.length,
      totalHash: savedMapHash,
      clientOperationId: "map-save-http-operation-0001",
    }),
  });
  assert.equal(saveStarted.response.status, 201, JSON.stringify(saveStarted.data));
  const save = saveStarted.data.save;
  assert.ok(save.chunkCount > 1);
  for (let index = save.chunkCount - 1; index >= 0; index -= 1) {
    const start = index * save.config.chunkBytes;
    const chunk = savedMapContent.subarray(start, Math.min(savedMapContent.length, start + save.config.chunkBytes));
    const uploaded = await fetchJson(
      `${baseUrl}/api/maps/save-sessions/${encodeURIComponent(save.id)}/chunks/${index}`,
      {
        method: "PUT",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/octet-stream",
          "X-Codex-Desktop-Action": "map-save-chunk",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
          "X-Content-SHA256": crypto.createHash("sha256").update(chunk).digest("hex"),
        },
        body: chunk,
      },
    );
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.chunk.index, index);
  }
  const committed = await fetchJson(
    `${baseUrl}/api/maps/save-sessions/${encodeURIComponent(save.id)}/commit`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "X-Codex-Desktop-Action": "map-save-commit",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
    },
  );
  assert.equal(committed.response.status, 200, JSON.stringify(committed.data));
  assert.equal(committed.data.result.version, savedMapHash);
  assert.equal(committed.data.session.version, savedMapHash);
  assert.deepEqual(await fs.readFile(mapPath), savedMapContent);

  const revisionsUrl = `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/revisions`;
  const revisions = await fetchJson(revisionsUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(revisions.response.status, 200, JSON.stringify(revisions.data));
  assert.equal(revisions.data.mapVersion, savedMapHash);
  assert.ok(revisions.data.revisions.some((revision) => revision.version === opened.data.session.version));
  assert.equal(JSON.stringify(revisions.data).includes(defaultProject), false);
  const wrongRevisionWindow = await fetchJson(revisionsUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": "map-editor-window-0002" },
  });
  assert.equal(wrongRevisionWindow.response.status, 404);
  const targetRevision = revisions.data.revisions.find((revision) => revision.version === opened.data.session.version);
  assert.ok(targetRevision);
  await fs.writeFile(mapPath, `${JSON.stringify({ ...mapDocument, savedByHttpTest: true, changedAfterSave: true }, null, 2)}\n`);
  const staleRestore = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/revisions/${encodeURIComponent(targetRevision.id)}/restore`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-revision-restore",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
      body: JSON.stringify({ expectedCurrentVersion: opened.data.session.version, confirmation: true, clientOperationId: "map-revision-http-stale-0001" }),
    },
  );
  assert.equal(staleRestore.response.status, 409);
  assert.equal(staleRestore.data.error, "地图当前版本已变化，请刷新后再恢复修订");
  await fs.writeFile(mapPath, savedMapContent);
  const crossMapRestore = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(otherOpened.data.session.id)}/revisions/${encodeURIComponent(targetRevision.id)}/restore`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-revision-restore",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
      body: JSON.stringify({ expectedCurrentVersion: otherOpened.data.session.version, confirmation: true, clientOperationId: "map-revision-http-cross-map-0001" }),
    },
  );
  assert.equal(crossMapRestore.response.status, 404);
  const missingRestoreConfirmation = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/revisions/${encodeURIComponent(targetRevision.id)}/restore`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-revision-restore",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
      body: JSON.stringify({ expectedCurrentVersion: savedMapHash }),
    },
  );
  assert.equal(missingRestoreConfirmation.response.status, 400);
  const restored = await fetchJson(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/revisions/${encodeURIComponent(targetRevision.id)}/restore`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-revision-restore",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
      body: JSON.stringify({ expectedCurrentVersion: savedMapHash, confirmation: true, clientOperationId: "map-revision-http-restore-0001" }),
    },
  );
  assert.equal(restored.response.status, 201, JSON.stringify(restored.data));
  assert.equal(restored.data.result.version, opened.data.session.version);
  assert.deepEqual(await fs.readFile(mapPath), Buffer.from(content));
  const revisionsAfterRestore = await fetchJson(revisionsUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(revisionsAfterRestore.response.status, 200);
  assert.ok(revisionsAfterRestore.data.revisions.some((revision) => revision.version === savedMapHash));

  await fs.writeFile(mapPath, `${JSON.stringify({ ...mapDocument, width: 2 })}\n`);
  const staleUrl = new URL(
    `/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}/content`,
    baseUrl,
  );
  staleUrl.searchParams.set("version", restored.data.session.version);
  staleUrl.searchParams.set("offset", "0");
  const stale = await fetchJson(staleUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.code, "map-file-changed");

  const closed = await fetch(`${baseUrl}/api/maps/sessions/${encodeURIComponent(opened.data.session.id)}`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "map-session-close",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(closed.status, 204);
  const otherClosed = await fetch(
    `${baseUrl}/api/maps/sessions/${encodeURIComponent(otherOpened.data.session.id)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: authorization,
        Origin: baseUrl,
        "X-Codex-Desktop-Action": "map-session-close",
        "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      },
    },
  );
  assert.equal(otherClosed.status, 204);
});

test("administrators manually manage image Worker settings and admission with revisions", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/ops/image-execution`);
  assert.equal(unauthenticated.status, 401);

  const initial = await fetchJson(`${baseUrl}/api/ops/image-execution`);
  assert.equal(initial.response.status, 200, JSON.stringify(initial.data));
  assert.equal(initial.response.headers.get("cache-control"), "no-store");
  assert.equal(initial.data.settings.preset, "stable");
  assert.equal(initial.data.settings.acceptNewTasks, true);
  assert.equal(initial.data.queue.workerCount, 0);
  assert.equal(initial.data.queue.queueLength, 0);
  assert.equal(initial.data.realtime.preset, "stable");
  assert.ok(Number.isFinite(initial.data.realtime.cpuPercent));
  assert.ok(initial.data.realtime.availableMemoryBytes > 0);

  const unguarded = await fetchJson(`${baseUrl}/api/ops/image-execution/settings`, {
    method: "PUT",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ preset: "balanced", expectedRevision: initial.data.settings.revision }),
  });
  assert.equal(unguarded.response.status, 403);

  const ambiguous = await fetchJson(`${baseUrl}/api/ops/image-execution/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-settings",
    },
    body: JSON.stringify({ preset: "balanced", config: { worker: {} } }),
  });
  assert.equal(ambiguous.response.status, 400);

  const custom = await fetchJson(`${baseUrl}/api/ops/image-execution/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-settings",
    },
    body: JSON.stringify({
      config: { worker: {
        enabled: true,
        concurrency: 2,
        queueLimit: 64,
        memoryMb: 512,
        taskTimeoutMs: 120_000,
      } },
      expectedRevision: initial.data.settings.revision,
    }),
  });
  assert.equal(custom.response.status, 200, JSON.stringify(custom.data));
  assert.equal(custom.data.settings.preset, "custom");
  assert.equal(custom.data.settings.config.worker.concurrency, 2);
  assert.equal(custom.data.settings.config.worker.queueLimit, 64);
  assert.equal(custom.data.realtime.preset, "custom");

  const stalePreset = await fetchJson(`${baseUrl}/api/ops/image-execution/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-settings",
    },
    body: JSON.stringify({ preset: "performance", expectedRevision: initial.data.settings.revision }),
  });
  assert.equal(stalePreset.response.status, 409);

  const paused = await fetchJson(`${baseUrl}/api/ops/image-execution/control`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-control",
    },
    body: JSON.stringify({ acceptNewTasks: false, expectedRevision: custom.data.settings.revision }),
  });
  assert.equal(paused.response.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.settings.acceptNewTasks, false);
  assert.equal(paused.data.queue.accepting, false);

  const invalidControl = await fetchJson(`${baseUrl}/api/ops/image-execution/control`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-control",
    },
    body: JSON.stringify({ acceptNewTasks: "yes", expectedRevision: paused.data.settings.revision }),
  });
  assert.equal(invalidControl.response.status, 400);

  const resumed = await fetchJson(`${baseUrl}/api/ops/image-execution/control`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-control",
    },
    body: JSON.stringify({ acceptNewTasks: true, expectedRevision: paused.data.settings.revision }),
  });
  assert.equal(resumed.response.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.settings.acceptNewTasks, true);
  assert.equal(resumed.data.queue.accepting, true);

  const restored = await fetchJson(`${baseUrl}/api/ops/image-execution/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-settings",
    },
    body: JSON.stringify({ preset: "stable", expectedRevision: resumed.data.settings.revision }),
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.settings.preset, "stable");
  assert.equal(restored.data.settings.acceptNewTasks, true);
});

test("runs manually configured map render jobs through the isolated worker", async (t) => {
  const renderDirectory = path.join(defaultProject, "map-render-http-test");
  const mapPath = path.join(renderDirectory, "maps", "world.tmj");
  const tilesetPath = path.join(renderDirectory, "tiles", "world.tsj");
  const imagePath = path.join(renderDirectory, "images", "terrain.png");
  const tileImage = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQAgMAAAAKbpXKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAJUExURVjJguCzS////z0BPQEAAAABYktHRAJmC3xkAAAAB3RJTUUH6ggJDQgI+KkHZgAAABBjYU52AAAAEAAAABAAAAAAAAAAAEvxwwcAAAARSURBVAjXY2AAglAgYBgcDADQWxVBziqxsQAAAABJRU5ErkJggg==",
    "base64",
  );
  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(path.dirname(tilesetPath), { recursive: true }),
    fs.mkdir(path.dirname(imagePath), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(imagePath, tileImage),
    fs.writeFile(tilesetPath, `${JSON.stringify({
      columns: 2,
      image: "../images/terrain.png",
      imageheight: 16,
      imagewidth: 32,
      name: "Terrain",
      tilecount: 2,
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
    })}\n`),
    fs.writeFile(mapPath, `${JSON.stringify({
      type: "map",
      width: 2,
      height: 1,
      tilewidth: 16,
      tileheight: 16,
      layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 2, height: 1, data: [1, 2] }],
      tilesets: [{ firstgid: 1, source: "../tiles/world.tsj" }],
    })}\n`),
  ]);
  t.after(() => fs.rm(renderDirectory, { recursive: true, force: true }));

  const configured = await fetchJson(`${baseUrl}/api/ops/map-render/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-map-render-settings",
    },
    body: JSON.stringify({
      config: {
        mapIo: {
          readChunkBytes: 64 * 1024,
          saveChunkBytes: 64 * 1024,
          autoSaveIntervalMs: 0,
        },
      },
    }),
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.data));
  assert.equal(configured.data.settings.preset, "custom");
  assert.equal(configured.data.realtime.preset, "custom");
  assert.ok(Number.isFinite(configured.data.realtime.cpuPercent));
  assert.ok(configured.data.realtime.availableMemoryBytes > 0);
  const renderConfig = await fetchJson(`${baseUrl}/api/maps/render-config`);
  assert.equal(renderConfig.response.status, 200, JSON.stringify(renderConfig.data));
  assert.equal(renderConfig.data.preset, "custom");
  assert.equal(renderConfig.data.enabled, true);
  assert.equal(renderConfig.data.accepting, true);

  const editorInstanceId = "map-render-http-window-0001";
  const opened = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-session-open",
    },
    body: JSON.stringify({ project: defaultProject, path: mapPath, editorInstanceId }),
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  assert.equal(opened.data.session.config.chunkBytes, 64 * 1024);
  assert.equal(opened.data.session.config.autoSaveIntervalMs, 0);

  const paused = await fetchJson(`${baseUrl}/api/ops/map-render/admission`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-map-render-admission",
    },
    body: JSON.stringify({
      acceptNewTasks: false,
      expectedRevision: configured.data.settings.revision,
    }),
  });
  assert.equal(paused.response.status, 200, JSON.stringify(paused.data));
  const rejected = await fetchJson(`${baseUrl}/api/maps/render-jobs`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-render-start",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      mapSessionId: opened.data.session.id,
      expectedVersion: opened.data.session.version,
      clientOperationId: "map-render-http-paused-0001",
      kind: "map-screenshot",
      spec: { width: 64, height: 32, mode: "fit" },
    }),
  });
  assert.equal(rejected.response.status, 503, JSON.stringify(rejected.data));
  const resumed = await fetchJson(`${baseUrl}/api/ops/map-render/continue`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-map-render-continue",
    },
    body: JSON.stringify({ expectedRevision: paused.data.settings.revision }),
  });
  assert.equal(resumed.response.status, 200, JSON.stringify(resumed.data));

  const created = await fetchJson(`${baseUrl}/api/maps/render-jobs`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-render-start",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
    body: JSON.stringify({
      mapSessionId: opened.data.session.id,
      expectedVersion: opened.data.session.version,
      clientOperationId: "map-render-http-screenshot-0001",
      kind: "map-screenshot",
      outputRoot: "map-render-http-test/exports",
      spec: { width: 64, height: 32, mode: "fit", format: "png" },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.job.settings.preset, "custom");
  const jobId = created.data.job.id;

  const wrongWindow = await fetchJson(`${baseUrl}/api/maps/render-jobs/${encodeURIComponent(jobId)}`, {
    headers: { "X-Codex-Desktop-Editor-Instance": "map-render-http-window-0002" },
  });
  assert.equal(wrongWindow.response.status, 404);

  let completed = created.data.job;
  for (let attempt = 0; attempt < 300 && !["succeeded", "failed", "canceled"].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await fetchJson(`${baseUrl}/api/maps/render-jobs/${encodeURIComponent(jobId)}`, {
      headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
    });
    assert.equal(status.response.status, 200, JSON.stringify(status.data));
    completed = status.data.job;
  }
  assert.equal(completed.status, "succeeded", JSON.stringify(completed.error));
  assert.equal(completed.result.files.length, 1);
  assert.equal(completed.result.files[0].path, "screenshot.png");

  const downloadUrl = new URL(`/api/maps/render-jobs/${encodeURIComponent(jobId)}/file`, baseUrl);
  downloadUrl.searchParams.set("path", "screenshot.png");
  downloadUrl.searchParams.set("editor", editorInstanceId);
  const downloaded = await fetch(downloadUrl, {
    headers: { Authorization: authorization },
  });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("etag"), `"${completed.result.files[0].sha256}"`);
  const png = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 32);
  const archiveUrl = new URL(`/api/maps/render-jobs/${encodeURIComponent(jobId)}/archive`, baseUrl);
  archiveUrl.searchParams.set("editor", editorInstanceId);
  const archived = await fetch(archiveUrl, { headers: { Authorization: authorization } });
  assert.equal(archived.status, 200);
  assert.match(archived.headers.get("content-disposition"), /\.tar\.gz"$/u);
  const archive = Buffer.from(await archived.arrayBuffer());
  assert.equal(archive.subarray(0, 2).toString("hex"), "1f8b");

  const cleared = await fetchJson(`${baseUrl}/api/ops/map-render/cache/clear`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "ops-map-render-cache-clear",
    },
  });
  assert.equal(cleared.response.status, 200, JSON.stringify(cleared.data));
  assert.ok(cleared.data.cache.files >= 1);
  assert.ok(cleared.data.cache.bytes > 0);

  const staleSettings = await fetchJson(`${baseUrl}/api/ops/map-render/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-map-render-settings",
    },
    body: JSON.stringify({
      preset: "balanced",
      expectedRevision: configured.data.settings.revision,
    }),
  });
  assert.equal(staleSettings.response.status, 409);

  const restored = await fetchJson(`${baseUrl}/api/ops/map-render/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-map-render-settings",
    },
    body: JSON.stringify({ preset: "stable" }),
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.settings.preset, "stable");
});

test("serves isolated project browser previews with guarded relative assets", async () => {
  const gameDirectory = path.join(defaultProject, "game");
  const internalDirectory = path.join(defaultProject, ".codex-desktop");
  const linkedAsset = path.join(gameDirectory, "outside.js");
  await Promise.all([
    fs.mkdir(gameDirectory, { recursive: true }),
    fs.mkdir(internalDirectory, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(defaultProject, "index.html"), "<!doctype html><title>root preview</title>\n"),
    fs.writeFile(path.join(gameDirectory, "index.html"), '<!doctype html><link rel="stylesheet" href="/game/game.css"><link rel="apple-touch-icon" href="icon.png"/><style>canvas{background-image:url("/game/background.png")}</style><script type="module" src="/game/game.mjs"></script>\n'),
    fs.writeFile(path.join(gameDirectory, "game.css"), 'canvas { background: rgb(12 34 56); background-image: url("/game/background.png"); }\n'),
    fs.writeFile(path.join(gameDirectory, "game.mjs"), "const emscriptenRoot = '/'; const assetRoot = '/game/'; document.body.dataset.previewReady = 'true';\n"),
    fs.writeFile(path.join(internalDirectory, "private.js"), "globalThis.privateValue = true;\n"),
  ]);
  await fs.symlink("/etc/passwd", linkedAsset);

  const entriesUrl = new URL(`${baseUrl}/api/preview/entries`);
  entriesUrl.searchParams.set("project", defaultProject);
  const entries = await fetchJson(entriesUrl);
  assert.equal(entries.response.status, 200);
  assert.deepEqual(entries.data.entries.map((entry) => entry.path), ["index.html", "game/index.html"]);
  assert.equal(entries.data.entries.every((entry) => Number.isFinite(entry.modifiedAt)), true);

  const session = await fetchJson(`${baseUrl}/api/preview/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-preview",
    },
    body: JSON.stringify({ project: defaultProject, entry: "game/index.html" }),
  });
  assert.equal(session.response.status, 201, JSON.stringify(session.data));
  assert.equal(session.data.entry, "game/index.html");

  const preview = await fetch(`${baseUrl}${session.data.url}`);
  const previewBody = await preview.text();
  assert.equal(preview.status, 200, previewBody);
  const token = new URL(preview.url).pathname.split("/")[2];
  assert.match(previewBody, new RegExp(`/preview/${token.replaceAll(".", "\\.")}/game/game\\.mjs`));
  assert.match(previewBody, new RegExp(`/preview/${token.replaceAll(".", "\\.")}/game/game\\.css`));
  assert.match(previewBody, /href="icon\.png"\/>/);
  assert.doesNotMatch(previewBody, /icon\.png"\/preview\//);
  assert.match(previewBody, new RegExp(`url\\("/preview/${token.replaceAll(".", "\\.")}/game/background\\.png"\\)`));
  assert.equal(preview.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(preview.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(preview.headers.get("access-control-allow-origin"), "*");
  assert.equal(preview.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.match(preview.headers.get("content-security-policy"), /sandbox allow-scripts allow-pointer-lock allow-downloads/);
  assert.doesNotMatch(preview.headers.get("content-security-policy"), /allow-same-origin/);

  const moduleAsset = await fetch(new URL("game.mjs", preview.url));
  assert.equal(moduleAsset.status, 200);
  assert.match(moduleAsset.headers.get("content-type"), /javascript/);
  const moduleBody = await moduleAsset.text();
  assert.match(moduleBody, /previewReady/);
  assert.match(moduleBody, /emscriptenRoot = '\/'/);
  assert.match(moduleBody, /assetRoot = '\/game\/'/);
  assert.doesNotMatch(moduleBody, new RegExp(`/preview/${token.replaceAll(".", "\\.")}/`));
  const stylesheet = await fetch(new URL("game.css", preview.url));
  assert.equal(stylesheet.status, 200);
  assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(
    await stylesheet.text(),
    new RegExp(`url\\("/preview/${token.replaceAll(".", "\\.")}/game/background\\.png"\\)`),
  );
  const rootModuleAsset = await fetch(`${baseUrl}/preview/${token}/game/game.mjs`);
  assert.equal(rootModuleAsset.status, 200);
  assert.equal(rootModuleAsset.headers.get("access-control-allow-origin"), "*");
  assert.match(await rootModuleAsset.text(), /previewReady/);

  const previewPrefix = new URL("./", preview.url).href;
  const protectedAsset = await fetch(new URL("../.codex-desktop/private.js", previewPrefix));
  assert.equal(protectedAsset.status, 403);
  const linked = await fetch(new URL("outside.js", previewPrefix));
  assert.equal(linked.status, 403);

  const tamperedToken = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  const tampered = await fetch(`${baseUrl}/preview/${tamperedToken}/game/index.html`);
  assert.equal(tampered.status, 403);

  const traversal = await fetchJson(`${baseUrl}/api/preview/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-preview",
    },
    body: JSON.stringify({ project: defaultProject, entry: "../index.html" }),
  });
  assert.equal(traversal.response.status, 400);
});

test("owner confirmation enables a fixed same-origin preview host and keeps sandbox fallback reversible", async () => {
  const initial = await fetchJson(`${baseUrl}/api/ops/public-origin`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.configured, false);
  assert.equal(initial.data.fallback, "sandbox");
  assert.equal(initial.data.candidates.some((candidate) => candidate.origin.includes("wflai.chat")), false);

  const confirmed = await fetchJson(`${baseUrl}/api/ops/public-origin/confirm`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-public-origin-confirm",
    },
    body: JSON.stringify({ publicOrigin: "https://codex.example.test", slotCount: 2 }),
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.configured, true);
  assert.deepEqual(confirmed.data.config.previewOrigins, [
    "https://preview-1.codex.example.test",
    "https://preview-2.codex.example.test",
  ]);

  const mainSite = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(mainSite.status, 200);
  assert.match(
    mainSite.headers.get("content-security-policy"),
    /frame-src 'self' https:\/\/preview-1\.codex\.example\.test https:\/\/preview-2\.codex\.example\.test/,
  );

  const session = await fetchJson(`${baseUrl}/api/preview/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-preview",
    },
    body: JSON.stringify({ project: defaultProject, entry: "game/index.html" }),
  });
  assert.equal(session.response.status, 201, JSON.stringify(session.data));
  assert.equal(session.data.mode, "origin");
  assert.match(session.data.url, /^https:\/\/preview-[12]\.codex\.example\.test\/preview\//);
  const previewUrl = new URL(session.data.url);
  const originPreview = await fetch(`${baseUrl}${previewUrl.pathname}`, {
    headers: {
      "X-Forwarded-Host": previewUrl.host,
      "X-Forwarded-Proto": "https",
    },
  });
  assert.equal(originPreview.status, 200, await originPreview.text());
  assert.equal(originPreview.headers.get("x-frame-options"), null);
  assert.match(originPreview.headers.get("content-security-policy"), /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(originPreview.headers.get("content-security-policy"), /sandbox/);

  const wrongHost = await fetch(`${baseUrl}${previewUrl.pathname}`, {
    headers: { "X-Forwarded-Host": "preview-1.other.example.test", "X-Forwarded-Proto": "https" },
  });
  assert.equal(wrongHost.status, 403);

  const disabled = await fetchJson(`${baseUrl}/api/ops/public-origin/disable`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-public-origin-disable",
    },
    body: JSON.stringify({ reason: "test" }),
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.data));
  assert.equal(disabled.data.configured, false);
  assert.equal(disabled.data.fallback, "sandbox");
});

test("owner configures a private Tencent Cloud DNSPod wizard and previews records before mutation", async () => {
  const confirmed = await fetchJson(`${baseUrl}/api/ops/public-origin/confirm`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-public-origin-confirm",
    },
    body: JSON.stringify({
      publicOrigin: "https://codex.example.test",
      previewBaseDomain: "preview.codex.example.test",
      slotCount: 2,
      isolation: "session",
    }),
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.data));

  const saved = await fetchJson(`${baseUrl}/api/ops/tencent-cloud/config`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-tencent-cloud-config",
    },
    body: JSON.stringify({
      secretId: "AKIDexample123456",
      secretKey: "secret-key-example",
      region: "ap-guangzhou",
      zoneDomain: "example.test",
      targetType: "A",
      target: "203.0.113.8",
      certificateEmail: "owner@example.test",
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.provider.configured, true);
  assert.equal(saved.data.provider.secretId, "AKIDex***3456");
  assert.equal(JSON.stringify(saved.data).includes("secret-key-example"), false);

  const plan = await fetchJson(`${baseUrl}/api/ops/tencent-cloud/plan`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      zoneDomain: "example.test",
      targetType: "A",
      target: "203.0.113.8",
    }),
  });
  assert.equal(plan.response.status, 200, JSON.stringify(plan.data));
  assert.deepEqual(plan.data.plan.map((record) => record.subDomain), ["*.preview.codex"]);

  const credentials = JSON.parse(await fs.readFile(path.join(stateDirectory, "tencent-cloud-dns.json"), "utf8"));
  assert.equal(credentials.secretKey, "secret-key-example");
  const credentialStat = await fs.stat(path.join(stateDirectory, "tencent-cloud-dns.json"));
  assert.equal(credentialStat.mode & 0o077, 0);

  const disabled = await fetchJson(`${baseUrl}/api/ops/public-origin/disable`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-public-origin-disable",
    },
    body: JSON.stringify({ reason: "test" }),
  });
  assert.equal(disabled.response.status, 200);
});

test("preview capture rejects non-preview and private targets before launching a browser", async () => {
  const privateTarget = await fetchJson(`${baseUrl}/api/preview/capture`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "project-preview-capture",
    },
    body: JSON.stringify({ url: "http://169.254.169.254/preview/not-a-token" }),
  });
  assert.equal(privateTarget.response.status, 403);

  const mainTarget = await fetchJson(`${baseUrl}/api/preview/capture`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "project-preview-capture",
    },
    body: JSON.stringify({ url: `${baseUrl}/api/account` }),
  });
  assert.equal(mainTarget.response.status, 403);
});

test("preview capture streams an exact PNG from the isolated Render Worker", async () => {
  const session = await fetchJson(`${baseUrl}/api/preview/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-preview",
    },
    body: JSON.stringify({ project: defaultProject, entry: "game/index.html" }),
  });
  assert.equal(session.response.status, 201, JSON.stringify(session.data));
  const captured = await fetch(`${baseUrl}/api/preview/capture`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "project-preview-capture",
    },
    body: JSON.stringify({
      url: new URL(session.data.url, baseUrl).href,
      width: 400,
      height: 300,
      fullPage: false,
    }),
  });
  const png = Buffer.from(await captured.arrayBuffer());
  assert.equal(captured.status, 200, captured.status === 200 ? undefined : png.toString("utf8"));
  assert.equal(captured.headers.get("cache-control"), "no-store");
  assert.equal(captured.headers.get("content-type"), "image/png");
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 400);
  assert.equal(png.readUInt32BE(20), 300);
  assert.doesNotMatch(serverSource, /import\(["']playwright["']\)/u);
  assert.doesNotMatch(serverSource, /capturePreviewScreenshot/u);
});

test("preview capture timeout or manual Worker shutdown does not take down the main site", async () => {
  const slowEntry = path.join(defaultProject, "game", "slow-capture.html");
  await fs.writeFile(
    slowEntry,
    "<!doctype html><title>slow</title><script>setInterval(() => fetch(location.href), 50)</script>\n",
  );
  try {
    const session = await fetchJson(`${baseUrl}/api/preview/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        "X-Codex-Desktop-Action": "project-preview",
      },
      body: JSON.stringify({ project: defaultProject, entry: "game/slow-capture.html" }),
    });
    assert.equal(session.response.status, 201, JSON.stringify(session.data));
    const timeoutSettings = await fetchJson(`${baseUrl}/api/ops/map-render/settings`, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "ops-map-render-settings",
      },
      body: JSON.stringify({ config: { worker: { taskTimeoutMs: 1_000 } } }),
    });
    assert.equal(timeoutSettings.response.status, 200, JSON.stringify(timeoutSettings.data));
    const timedOut = await fetchJson(`${baseUrl}/api/preview/capture`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "project-preview-capture",
      },
      body: JSON.stringify({ url: new URL(session.data.url, baseUrl).href, width: 400, height: 300 }),
    });
    assert.equal(timedOut.response.status, 502, JSON.stringify(timedOut.data));
    assert.equal(timedOut.data.code, "render-timeout");
    const healthyAfterTimeout = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: authorization },
    });
    assert.equal(healthyAfterTimeout.status, 200);

    const disabled = await fetchJson(`${baseUrl}/api/ops/map-render/settings`, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "ops-map-render-settings",
      },
      body: JSON.stringify({ config: { worker: { enabled: false } } }),
    });
    assert.equal(disabled.response.status, 200, JSON.stringify(disabled.data));
    const unavailable = await fetchJson(`${baseUrl}/api/preview/capture`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "project-preview-capture",
      },
      body: JSON.stringify({ url: new URL(session.data.url, baseUrl).href }),
    });
    assert.equal(unavailable.response.status, 503, JSON.stringify(unavailable.data));
    const healthyAfterDisable = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: authorization },
    });
    assert.equal(healthyAfterDisable.status, 200);
  } finally {
    await fs.rm(slowEntry, { force: true });
    const restored = await fetchJson(`${baseUrl}/api/ops/map-render/settings`, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "ops-map-render-settings",
      },
      body: JSON.stringify({ preset: "stable" }),
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
  }
});

test("owner can opt into per-session preview Origins for browser storage isolation", async () => {
  const confirmed = await fetchJson(`${baseUrl}/api/ops/public-origin/confirm`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-public-origin-confirm",
    },
    body: JSON.stringify({
      publicOrigin: "https://codex.example.test",
      previewBaseDomain: "preview.codex.example.test",
      isolation: "session",
      slotCount: 2,
    }),
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.config.isolation, "session");
  const mainSite = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(mainSite.status, 200);
  assert.match(
    mainSite.headers.get("content-security-policy"),
    /frame-src 'self' https:\/\/\*\.preview\.codex\.example\.test/,
  );
  const session = await fetchJson(`${baseUrl}/api/preview/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "project-preview",
    },
    body: JSON.stringify({ project: defaultProject, entry: "game/index.html" }),
  });
  assert.equal(session.response.status, 201, JSON.stringify(session.data));
  assert.match(session.data.url, /^https:\/\/preview-session-[0-9a-f]{24}\.preview\.codex\.example\.test\/preview\//);
  const disabled = await fetchJson(`${baseUrl}/api/ops/public-origin/disable`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-public-origin-disable",
    },
    body: JSON.stringify({ reason: "test" }),
  });
  assert.equal(disabled.response.status, 200);
});

test("rejects resource symlinks that escape the selected project", async () => {
  const linkedFile = path.join(defaultProject, "outside-link.txt");
  await fs.symlink("/etc/passwd", linkedFile);
  const readUrl = new URL(`${baseUrl}/api/files/read`);
  readUrl.searchParams.set("project", defaultProject);
  readUrl.searchParams.set("path", linkedFile);
  const result = await fetchJson(readUrl);

  assert.equal(result.response.status, 403);
  assert.match(result.data.error, /symbolic links/i);
});

test("rejects project paths that escape the root through a symbolic link", async () => {
  const linkedProject = path.join(projectRoot, "linked-project");
  await fs.symlink("/tmp", linkedProject);
  const url = new URL(`${baseUrl}/api/uploads`);
  url.searchParams.set("project", linkedProject);
  url.searchParams.set("name", "blocked.txt");
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("blocked"),
  });

  assert.equal(result.response.status, 403);
  assert.match(result.data.error, /symbolic links/i);
});

test("rejects project path traversal", async () => {
  const result = await fetchJson(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "../outside", template: "empty" }),
  });
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /工程名称/);
});

test("rejects non-allowlisted app-server methods", async () => {
  const compact = await websocketRequest(`${baseUrl.replace("http", "ws")}/ws`, {
    type: "rpc",
    requestId: 43,
    method: "thread/compact/start",
    // The shared test server deliberately disables Codex. Use an invalid
    // thread identity so this only proves the method passed the allowlist;
    // a valid identity would wait for a backend that cannot exist here and
    // leave the persistent-state admission held after the client timeout.
    params: { threadId: "" },
  });
  assert.equal(compact.type, "rpc/error");
  assert.equal(compact.requestId, 43);
  assert.doesNotMatch(compact.message, /not allowed/);

  const message = await websocketRequest(`${baseUrl.replace("http", "ws")}/ws`, {
    type: "rpc",
    requestId: 44,
    method: "fs/remove",
    params: { path: "/tmp/example" },
  });
  assert.equal(message.type, "rpc/error");
  assert.equal(message.requestId, 44);
  assert.match(message.message, /not allowed/);
});

test("reports an admitted HTTP mutation as persistent-state busy until its response finishes", async () => {
  const held = openHeldProjectImport("maintenance-inflight");
  held.request.write(Buffer.from("x"));
  await waitForImportScratchFile();

  const busy = await waitForTaskReadiness((value) => value.maintenanceIdle === false);
  assert.equal(busy.taskIdle, true);
  assert.equal(busy.draining, false);

  held.request.end(Buffer.from("y"));
  const status = await held.response;
  assert.ok(status >= 400);
  const idle = await waitForTaskReadiness((value) => value.maintenanceIdle === true);
  assert.equal(idle.taskIdle, true);
  assert.equal(idle.draining, false);
});

test("release draining blocks new turns without exposing task details", async () => {
  const drainStore = new ReleaseDrainStore(runtimeDirectory);
  const drain = await drainStore.begin(appPackage.version);
  try {
    const ready = await waitForTaskReadiness((value) => value.draining === true && value.maintenanceIdle === true);
    assert.deepEqual(ready, { ok: true, taskIdle: true, maintenanceIdle: true, draining: true });

    const readable = await fetchJson(`${baseUrl}/api/account?summary=1`);
    assert.equal(readable.response.status, 200);

    const blockedMutations = await Promise.all([
      fetchJson(`${baseUrl}/api/recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "blocked" }),
      }),
      fetchJson(`${baseUrl}/api/announcement/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "blocked" }),
      }),
      fetchJson(`${baseUrl}/api/recovery/blocked`, { method: "DELETE" }),
    ]);
    for (const result of blockedMutations) {
      assert.equal(result.response.status, 503);
      assert.equal(result.data.code, "ERR_MAINTENANCE_DRAIN_ACTIVE");
    }

    const emergencyCancel = await fetchJson(`${baseUrl}/api/ops/deployments/cancel`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "ops-deployment-cancel",
      },
      body: JSON.stringify({ operationId: "no-active-operation", password: "correct-horse-battery-staple" }),
    });
    assert.equal(emergencyCancel.response.status, 409);
    assert.notEqual(emergencyCancel.data.code, "ERR_MAINTENANCE_DRAIN_ACTIVE");

    const admissionRecovery = await fetchJson(`${baseUrl}/api/ops/deployments/admissions/clear`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "ops-deployment-admissions-clear",
      },
      body: JSON.stringify({
        password: "correct-horse-battery-staple",
        confirmation: "清理中断写入",
      }),
    });
    assert.equal(admissionRecovery.response.status, 200);
    assert.equal(admissionRecovery.data.cleared, 0);
    assert.deepEqual(admissionRecovery.data.persistentAdmissions, {
      active: 0, orphaned: 0, oldestOrphanedAt: null,
    });

    const message = await websocketRequest(`${baseUrl.replace("http", "ws")}/ws`, {
      type: "rpc",
      requestId: 45,
      method: "turn/start",
      params: { threadId: "thread_drain_test", cwd: defaultProject, input: [] },
    });
    assert.equal(message.type, "rpc/error");
    assert.match(message.message, /安全更新/);

    const write = await websocketRequest(`${baseUrl.replace("http", "ws")}/ws`, {
      type: "rpc",
      requestId: 46,
      method: "thread/name/set",
      params: { threadId: "thread_drain_test", name: "blocked" },
    });
    assert.equal(write.type, "rpc/error");
    assert.match(write.message, /安全更新/);

    const read = await websocketRequest(`${baseUrl.replace("http", "ws")}/ws`, {
      type: "rpc",
      requestId: 47,
      method: "config/read",
      params: { cwd: defaultProject, includeLayers: false },
    });
    assert.equal(read.type, "rpc/error");
    assert.doesNotMatch(read.message, /安全更新/);

    const interrupt = await websocketRequest(`${baseUrl.replace("http", "ws")}/ws`, {
      type: "rpc",
      requestId: 48,
      method: "turn/interrupt",
      params: { threadId: "thread_drain_test", turnId: "turn_drain_test" },
    });
    assert.equal(interrupt.type, "rpc/error");
    assert.match(interrupt.message, /安全更新/);

    const approval = await websocketMessage(`${baseUrl.replace("http", "ws")}/ws`, {
      type: "serverResponse",
      id: "approval_drain_test",
      result: { decision: "accept" },
    }, (value) => value.type === "error");
    assert.match(approval.message, /安全更新/);
  } finally {
    await drainStore.clear(drain.token);
  }
});

test("imports an encrypted workspace package with chunk guards and conflict-safe project names", async () => {
  const sourceRoot = await fs.mkdtemp("/tmp/wfl-server-workspace-source-");
  try {
    const sourceProject = path.join(sourceRoot, "default-project");
    await fs.mkdir(sourceProject);
    await fs.writeFile(path.join(sourceProject, "MIGRATED.md"), "workspace package\n");
    await fs.writeFile(path.join(defaultProject, "TARGET-UNCHANGED.md"), "existing target\n");
    const center = await new WorkspaceMigrationCenter(path.join(sourceRoot, "center"), { version: appPackage.version }).initialize();
    const migration = await center.createExport({
      projects: [{ name: "default-project", path: sourceProject }],
      conversations: [{
        projectId: "project-0001",
        transcript: {
          name: "Migrated server conversation",
          turns: [{ items: [{ type: "user", text: "Move me" }, { type: "assistant", text: "Moved" }] }],
        },
      }],
    });
    const packageBytes = await fs.readFile(center.exportPath(migration.id));
    const recoveryKey = await center.exportKey(migration.id);

    const overview = await fetchJson(`${baseUrl}/api/ops/workspace-migrations`);
    assert.equal(overview.response.status, 200);
    const applicationWorkspace = overview.data.projects.find((project) => project.applicationWorkspace);
    assert.equal(applicationWorkspace.name, "Codex-Desktop-workspace");
    assert.equal(applicationWorkspace.displayName, "Codex Desktop");
    assert.equal(JSON.stringify(overview.data.projects).includes(projectRoot), false);

    const missingAction = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "workspace.wflworkspace", sizeBytes: packageBytes.length, password: "correct-horse-battery-staple" }),
    });
    assert.equal(missingAction.response.status, 403);

    const clientUploadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fileFingerprint = "c".repeat(64);
    const started = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-workspace-upload-start" },
      body: JSON.stringify({
        filename: "workspace.wflworkspace",
        sizeBytes: packageBytes.length,
        clientUploadId,
        fileFingerprint,
        password: "correct-horse-battery-staple",
      }),
    });
    assert.equal(started.response.status, 201, JSON.stringify(started.data));
    const uploadId = started.data.upload.id;
    const repeatedStart = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-workspace-upload-start" },
      body: JSON.stringify({
        filename: "workspace.wflworkspace",
        sizeBytes: packageBytes.length,
        clientUploadId,
        fileFingerprint,
        password: "correct-horse-battery-staple",
      }),
    });
    assert.equal(repeatedStart.response.status, 201, JSON.stringify(repeatedStart.data));
    assert.equal(repeatedStart.data.upload.id, uploadId);

    const wrongOffset = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads/${uploadId}?offset=1`, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/octet-stream",
        "X-Codex-Desktop-Action": "ops-workspace-upload-chunk",
      },
      body: packageBytes,
    });
    assert.equal(wrongOffset.response.status, 409);

    const uploaded = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads/${uploadId}?offset=0`, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/octet-stream",
        "X-Codex-Desktop-Action": "ops-workspace-upload-chunk",
      },
      body: packageBytes,
    });
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.upload.status, "complete");

    const inspected = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads/${uploadId}/inspect`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-workspace-upload-inspect" },
      body: JSON.stringify({ recoveryKey }),
    });
    assert.equal(inspected.response.status, 200, JSON.stringify(inspected.data));
    assert.equal(inspected.data.inspection.plan[0].targetName, "default-project-migrated");
    assert.equal(inspected.data.inspection.plan[0].renamed, true);

    const imported = await fetchJson(`${baseUrl}/api/ops/workspace-migrations/uploads/${uploadId}/import`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-workspace-import-execute" },
      body: JSON.stringify({
        recoveryKey,
        typedMigrationId: migration.id,
        password: "correct-horse-battery-staple",
      }),
    });
    assert.equal(imported.response.status, 202, JSON.stringify(imported.data));
    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = await fetchJson(`${baseUrl}/api/ops/workspace-migrations`);
      if (!status.data.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.data.operation.status, "completed", JSON.stringify(status.data.operation));
    assert.equal(await fs.readFile(path.join(defaultProject, "TARGET-UNCHANGED.md"), "utf8"), "existing target\n");
    assert.equal(await fs.readFile(path.join(projectRoot, "default-project-migrated", "MIGRATED.md"), "utf8"), "workspace package\n");
    const imports = JSON.parse(await fs.readFile(path.join(stateDirectory, "thread-imports", "index.json"), "utf8"));
    const conversation = imports.records.find((record) => record.name === "Migrated server conversation");
    assert.equal(conversation.cwd, path.join(projectRoot, "default-project-migrated"));
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test("workspace exports stop safely when Codex repeats a terminal conversation cursor", () => {
  const collector = serverSource.slice(
    serverSource.indexOf("async function collectWorkspaceConversations"),
    serverSource.indexOf("async function workspaceImportPlan"),
  );
  assert.match(collector, /const seenCursors = new Set\(\)/);
  assert.match(collector, /if \(!nextCursor \|\| seenCursors\.has\(nextCursor\)\) break/);
  assert.doesNotMatch(collector, /Codex 对话分页位置没有推进/);
});

test("application workspace migration stages outside the application source", () => {
  assert.match(serverSource, /WORKSPACE_MIGRATION_STAGING_DIR/);
  assert.match(serverSource, /path\.join\(PROJECT_ROOT, `\.\$\{path\.basename\(SOURCE_DIR\)\}-workspace-staging`\)/);
  assert.match(serverSource, /stagingDirectory: WORKSPACE_MIGRATION_STAGING_DIR/);
});

test("indexed backup and workspace packages can download from the private runtime directory", () => {
  assert.match(serverSource, /sendFile\(backupCenter\.archivePath\(backup\.id\), \{ dotfiles: "allow" \}\)/);
  assert.match(serverSource, /sendFile\(workspaceMigrationCenter\.exportPath\(migration\.id\), \{ dotfiles: "allow" \}\)/);
});

test("rate limits repeated invalid passwords from the same Cloudflare client", async () => {
  const invalid = `Basic ${Buffer.from("codex:invalid-password-value").toString("base64")}`;
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`${baseUrl}/`, {
      headers: {
        Authorization: invalid,
        "CF-Connecting-IP": "203.0.113.50",
      },
    });
  }
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});

test("releases maintenance admission after an aborted mutating handler completes cleanup", async () => {
  const held = openHeldProjectImport("maintenance-aborted");
  void held.response.catch(() => {});
  held.request.on("error", () => {});
  held.request.write(Buffer.from("x"));
  await waitForImportScratchFile();
  held.request.destroy();
  await waitForNoImportScratchFiles();

  const snapshot = await waitForTaskReadiness((value) => value.maintenanceIdle === true);
  assert.equal(snapshot.taskIdle, true);
  assert.equal(snapshot.maintenanceIdle, true);
  assert.equal(snapshot.draining, false);
});

async function fetchJson(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: authorization, ...options?.headers },
  });
  return { response, data: await response.json() };
}

function openHeldProjectImport(name) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = http.request(`${baseUrl}/api/projects/import?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Origin: baseUrl,
      "Content-Type": "application/octet-stream",
      "Content-Length": "2",
      "X-Codex-Desktop-Action": "project-import",
    },
  }, (serverResponse) => {
    serverResponse.resume();
    serverResponse.on("end", () => resolveResponse(serverResponse.statusCode));
  });
  request.on("error", rejectResponse);
  request.flushHeaders();
  return { request, response };
}

async function waitForTaskReadiness(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/internal/task-ready`);
    if (response.ok) {
      const value = await response.json();
      if (predicate(value)) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for task readiness state");
}

async function waitForImportScratchFile(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(projectRoot);
    if (entries.some((name) => name.startsWith(".wfl-import-") && name.endsWith(".tar.gz"))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for project import scratch file");
}

async function waitForNoImportScratchFiles(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(projectRoot);
    if (!entries.some((name) => name.startsWith(".wfl-import-"))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for project import cleanup");
}

function websocketRequest(url, payload) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    const timer = setTimeout(() => reject(new Error("WebSocket test timed out")), 5000);
    socket.on("open", () => socket.send(JSON.stringify(payload)));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.requestId !== payload.requestId) return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.on("error", reject);
  });
}

function websocketMessage(url, payload, predicate) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    const timer = setTimeout(() => reject(new Error("WebSocket test timed out")), 5000);
    socket.on("open", () => socket.send(JSON.stringify(payload)));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.on("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function requestStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
}

function waitForServer(processHandle, marker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start within 5s: ${output}`)), 5_000);
    let output = "";
    processHandle.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      resolve();
    });
    processHandle.stderr.on("data", (chunk) => {
      output += chunk;
    });
    processHandle.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${output}`));
    });
  });
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readTextFiles(directory) {
  const chunks = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile()) chunks.push(await fs.readFile(candidate, "utf8").catch(() => ""));
    }
  }
  await walk(directory);
  return chunks.join("\n");
}

async function createProjectArchive({ traversal = false, symlink = false } = {}) {
  const directory = await fs.mkdtemp("/tmp/wfl-project-archive-");
  const root = path.join(directory, "project-source");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "README.md"), "imported project\n");
    if (symlink) await fs.symlink("README.md", path.join(root, "linked-readme"));
    const args = ["--create", "--gzip", "--file=-", "--directory", directory];
    if (traversal) args.push("--transform=s|project-source/README.md|../escape.txt|", "project-source/README.md");
    else args.push("project-source");
    return await captureProcess("tar", args);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function captureProcess(command, args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    childProcess.stdout.on("data", (chunk) => chunks.push(chunk));
    childProcess.stderr.on("data", (chunk) => (stderr += chunk));
    childProcess.on("error", reject);
    childProcess.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}
