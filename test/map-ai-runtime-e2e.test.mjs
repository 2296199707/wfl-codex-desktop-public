import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repository = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const fakeCodex = path.join(repository, "test", "fixtures", "fake-codex-app-server.mjs");
const fakeClaude = path.join(repository, "test", "fixtures", "fake-claude-control.mjs");
const mapAiMcp = path.join(repository, "scripts", "map-ai-mcp.mjs");
const managedMapAiMcp = path.join(repository, "scripts", "map-ai-managed-mcp.mjs");

test("runtime map AI HTTP and MCP keep map authorization isolated and revoke stale contexts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-runtime-"));
  // The runtime-bundle verifier intentionally requires every ancestor of a
  // staged legacy executable to be searchable by isolated users. A mkdtemp
  // root is private (0700) by default, so make only this test root searchable
  // without making its files readable. Production runtime roots already live
  // below administrator-managed searchable directories.
  await fs.chmod(root, 0o711);
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "game");
  const mapPath = path.join(project, "maps", "world.tmj");
  const secondMapPath = path.join(project, "maps", "second.tmj");
  const thirdMapPath = path.join(project, "maps", "third.tmj");
  const otherProject = path.join(projectRoot, "other-game");
  const otherMapPath = path.join(otherProject, "maps", "other.tmj");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const codexHome = path.join(root, "codex-home");
  const usersRoot = path.join(root, "users");
  const bin = path.join(root, "bin");
  const authFile = path.join(root, "auth.json");
  const username = "owner";
  const password = "map-ai-owner-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const editorInstanceId = "map-ai-editor-e2e";
  const originalMap = `${JSON.stringify({
    type: "map",
    version: "1.10",
    tiledversion: "1.10.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 2,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 2, height: 2, data: [0, 0, 0, 0] }],
    tilesets: [],
  }, null, 2)}\n`;
  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(path.dirname(otherMapPath), { recursive: true }),
    fs.mkdir(path.join(project, "maps", "generated"), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(usersRoot, { recursive: true }),
    fs.mkdir(bin, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(mapPath, originalMap),
    fs.writeFile(secondMapPath, originalMap),
    fs.writeFile(thirdMapPath, originalMap),
    fs.writeFile(otherMapPath, originalMap),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  const codexShim = path.join(bin, "codex");
  const claudeShim = path.join(bin, "claude");
  await fs.writeFile(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`, { mode: 0o755 });
  await fs.writeFile(claudeShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_RESCUE_MODE: "0",
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: project,
      CODEX_DESKTOP_MULTI_USER_ROOT: usersRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: codexHome,
      CODEX_DESKTOP_AUTH_FILE: authFile,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_SOURCE_DIR: repository,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "0",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CLAUDE_BIN: claudeShim,
      FAKE_CODEX_PROJECT: project,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopProcess(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForServer(server, "WFL Codex Desktop v");

  const accountBefore = await requestJson(baseUrl, "/api/account/map-ai", { authorization });
  assert.equal(accountBefore.response.status, 200, JSON.stringify(accountBefore.data));
  assert.equal(accountBefore.data.mapAiToolsEnabled, false);
  const multiUser = await requestJson(baseUrl, "/api/multi-user/enable", {
    method: "POST",
    authorization,
    action: "multi-user-enable",
    body: { password },
  });
  assert.equal(multiUser.response.status, 202, JSON.stringify(multiUser.data));
  const ownerCookie = cookieFrom(multiUser.response);
  assert.ok(ownerCookie);
  const secondLogin = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    action: "login",
    body: { username, password },
  });
  assert.equal(secondLogin.response.status, 200, JSON.stringify(secondLogin.data));
  const otherBrowserCookie = cookieFrom(secondLogin.response);
  assert.ok(otherBrowserCookie);
  assert.notEqual(otherBrowserCookie, ownerCookie);
  const enabled = await requestJson(baseUrl, "/api/account/map-ai", {
    method: "PUT",
    cookie: ownerCookie,
    action: "map-ai-setting",
    body: { enabled: true },
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.data));

  const opened = await requestJson(baseUrl, "/api/maps/sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-session-open",
    body: { project, path: mapPath, editorInstanceId },
  });
  assert.equal(opened.response.status, 201, JSON.stringify(opened.data));
  const session = opened.data.session;
  assert.equal(session.relativePath, "maps/world.tmj");
  assert.equal(session.version, crypto.createHash("sha256").update(originalMap).digest("hex"));

  const managedAuthorization = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/world.tmj",
      mapVersion: session.version,
      threadId: "thread_smoke_001",
      allowedOps: ["get_map_context", "propose_tiled_patch", "apply_tiled_patch"],
      approvalPolicy: "ask_each",
      userConfirmed: true,
      clientOperationId: "managed-auth-e2e-1",
    },
  });
  assert.equal(managedAuthorization.response.status, 201, JSON.stringify(managedAuthorization.data));
  const managedAuth = managedAuthorization.data.authorization;
  assert.equal(managedAuth.authorityMode, "managed");
  assert.equal(Object.hasOwn(managedAuth, "projectPath"), false);

  // Resource-patch contracts are candidate-only: the browser uploads bytes
  // through the scoped chunk bridge, while MCP receives only an opaque id.
  // Keep this setup before the MCP adapter is spawned so the same long-lived
  // managed socket exercises both proposal and apply boundaries below.
  const resourceThreadId = "thread_smoke_parallel";
  const resourceRelativePath = "maps/generated/ai.tmj";
  const resourceBytes = Buffer.from(originalMap);
  const resourceUploadStarted = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/managed-resource-uploads`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-resource-upload-start",
    editorInstanceId,
    body: {
      path: resourceRelativePath,
      baseVersion: null,
      totalBytes: resourceBytes.length,
      totalHash: sha256(resourceBytes),
      editorStateId: 0,
      threadId: resourceThreadId,
    },
  });
  assert.equal(resourceUploadStarted.response.status, 201, JSON.stringify(resourceUploadStarted.data));
  const resourceUpload = resourceUploadStarted.data.upload;
  const resourceChunk = await fetch(`${baseUrl}/api/maps/sessions/${session.id}/managed-resource-uploads/${resourceUpload.uploadId}/chunks/0`, {
    method: "PUT",
    headers: {
      Cookie: ownerCookie,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "map-ai-resource-upload-chunk",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      "X-Codex-Desktop-Editor-State": "0",
      "X-WFL-Map-AI-Thread": resourceThreadId,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(resourceBytes.length),
      "X-Content-SHA256": sha256(resourceBytes),
    },
    body: resourceBytes,
  });
  assert.equal(resourceChunk.status, 200, await resourceChunk.text());
  const resourceCommitted = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/managed-resource-uploads/${resourceUpload.uploadId}/commit`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-resource-upload-commit",
    editorInstanceId,
    body: { editorStateId: 0, threadId: resourceThreadId },
  });
  assert.equal(resourceCommitted.response.status, 201, JSON.stringify(resourceCommitted.data));
  const resourceCandidate = resourceCommitted.data.candidate;
  const resourceAuthorization = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/world.tmj",
      mapVersion: session.version,
      threadId: resourceThreadId,
      allowedOps: ["propose_tiled_resource_patch", "apply_tiled_resource_patch"],
      targetFiles: ["maps/world.tmj", resourceRelativePath],
      targetFileVersions: { "maps/world.tmj": session.version, [resourceRelativePath]: null },
      approvalPolicy: "ask_each",
      userConfirmed: true,
      clientOperationId: "managed-auth-resource-e2e",
    },
  });
  assert.equal(resourceAuthorization.response.status, 201, JSON.stringify(resourceAuthorization.data));
  const resourceAuth = resourceAuthorization.data.authorization;
  const managedTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: managedAuth.id,
      clientOperationId: "managed-task-e2e-1",
      request: { operations: [{ op: "update-object", objectId: 7, changes: { x: 32 } }] },
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 1 },
    },
  });
  assert.equal(managedTask.response.status, 201, JSON.stringify(managedTask.data));
  assert.equal(managedTask.data.task.status, "queued");
  assert.equal(managedTask.data.task.mapPath, "maps/world.tmj");
  assert.equal(managedTask.data.task.planAvailable, true);
  assert.doesNotMatch(JSON.stringify(managedTask.data), new RegExp(escapeRegExp(project), "u"));
  const managedTaskEventsBefore = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${managedTask.data.task.id}/events?after=0&limit=50`, {
    cookie: ownerCookie,
  });
  assert.equal(managedTaskEventsBefore.response.status, 200, JSON.stringify(managedTaskEventsBefore.data));
  assert.equal(managedTaskEventsBefore.data.gap, false);
  assert.equal(managedTaskEventsBefore.data.snapshotRequired, false);
  assert.equal(managedTaskEventsBefore.data.events.some((event) => event.type === "created"), true);
  assert.equal(managedTaskEventsBefore.data.nextAfter, managedTaskEventsBefore.data.latestEventSeq);
  const managedTaskDiff = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${managedTask.data.task.id}/diff`, {
    cookie: ownerCookie,
  });
  assert.equal(managedTaskDiff.response.status, 200, JSON.stringify(managedTaskDiff.data));
  assert.equal(managedTaskDiff.data.taskId, managedTask.data.task.id);
  assert.equal(managedTaskDiff.data.diff, null);
  const pausedManagedTask = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${managedTask.data.task.id}/action`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-action",
    body: { action: "pause" },
  });
  assert.equal(pausedManagedTask.response.status, 200, JSON.stringify(pausedManagedTask.data));
  assert.equal(pausedManagedTask.data.task.status, "paused");
  const revokedManaged = await requestJson(baseUrl, `/api/map-ai/managed-authorizations/${managedAuth.id}`, {
    method: "DELETE",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-revoke",
    body: { reason: "e2e revoke" },
  });
  assert.equal(revokedManaged.response.status, 200, JSON.stringify(revokedManaged.data));
  assert.equal(revokedManaged.data.authorization.revokedReason, "e2e revoke");
  const managedTaskAfterRevoke = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${managedTask.data.task.id}`, {
    cookie: ownerCookie,
  });
  assert.equal(managedTaskAfterRevoke.response.status, 200, JSON.stringify(managedTaskAfterRevoke.data));
  assert.equal(managedTaskAfterRevoke.data.task.status, "canceled");
  assert.equal(await fs.readFile(mapPath, "utf8"), originalMap);
  const managedTaskEventsAfter = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${managedTask.data.task.id}/events?after=0&limit=50`, {
    cookie: ownerCookie,
  });
  assert.equal(managedTaskEventsAfter.response.status, 200, JSON.stringify(managedTaskEventsAfter.data));
  assert.equal(managedTaskEventsAfter.data.snapshotRequired, true);
  assert.equal(managedTaskEventsAfter.data.snapshot.status, "canceled");
  assert.equal(managedTaskEventsAfter.data.events.some((event) => ["cancel-requested", "canceled"].includes(event.type)), true);
  const managedTaskEventsResumed = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${managedTask.data.task.id}/events?after=${managedTaskEventsAfter.data.nextAfter}&limit=50`, {
    cookie: ownerCookie,
  });
  assert.equal(managedTaskEventsResumed.response.status, 200, JSON.stringify(managedTaskEventsResumed.data));
  assert.equal(managedTaskEventsResumed.data.events.length, 0);
  assert.equal(managedTaskEventsResumed.data.nextAfter, managedTaskEventsAfter.data.nextAfter);

  // A Thread handoff must stop only the old Thread's task. A task created
  // after the handoff against the new Thread remains valid and queued.
  const transferAuthorization = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/world.tmj",
      mapVersion: session.version,
      threadId: "thread_smoke_001",
      allowedOps: ["get_map_context"],
      approvalPolicy: "ask_each",
      userConfirmed: true,
      clientOperationId: "managed-auth-transfer-e2e",
    },
  });
  assert.equal(transferAuthorization.response.status, 201, JSON.stringify(transferAuthorization.data));
  const transferAuth = transferAuthorization.data.authorization;
  const oldThreadTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: transferAuth.id,
      clientOperationId: "managed-task-transfer-old",
      request: { format: "wfl-handoff-note", version: 1, summary: "handoff boundary" },
      planSummary: { operationCount: 0, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(oldThreadTask.response.status, 201, JSON.stringify(oldThreadTask.data));
  const transferred = await requestJson(baseUrl, `/api/map-ai/managed-authorizations/${transferAuth.id}/transfer`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-transfer",
    body: { targetThreadId: "thread_smoke_parallel" },
  });
  assert.equal(transferred.response.status, 200, JSON.stringify(transferred.data));
  const oldThreadTaskAfterTransfer = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${oldThreadTask.data.task.id}`, { cookie: ownerCookie });
  assert.equal(oldThreadTaskAfterTransfer.response.status, 200, JSON.stringify(oldThreadTaskAfterTransfer.data));
  assert.equal(oldThreadTaskAfterTransfer.data.task.status, "canceled");
  const newThreadTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: transferAuth.id,
      clientOperationId: "managed-task-transfer-new",
      request: { format: "wfl-handoff-note", version: 1, summary: "new Thread task" },
      planSummary: { operationCount: 0, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(newThreadTask.response.status, 201, JSON.stringify(newThreadTask.data));
  assert.equal(newThreadTask.data.task.status, "queued");

  // The public HTTP task route must schedule an explicit multi-map plan too;
  // previously only the MCP entry point called the executor, leaving this
  // durable task queued forever. Full authorization removes only the human
  // gate; the executor still validates both versions and commits atomically.
  const secondMapSource = await fs.readFile(secondMapPath);
  const thirdMapSource = await fs.readFile(thirdMapPath);
  const secondMapVersion = sha256(secondMapSource);
  const thirdMapVersion = sha256(thirdMapSource);
  const multiMapAuthorization = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/second.tmj",
      mapVersion: secondMapVersion,
      mapPaths: ["maps/second.tmj", "maps/third.tmj"],
      mapVersions: { "maps/second.tmj": secondMapVersion, "maps/third.tmj": thirdMapVersion },
      threadId: "thread_smoke_parallel",
      allowedOps: ["apply_tiled_patch"],
      approvalPolicy: "full_authorization",
      userConfirmed: true,
      clientOperationId: "managed-auth-http-multi-map",
    },
  });
  assert.equal(multiMapAuthorization.response.status, 201, JSON.stringify(multiMapAuthorization.data));
  const multiMap = multiMapAuthorization.data.authorization;
  const multiMapPatch = {
    format: "wfl-multi-map-patch",
    version: 1,
    summary: "HTTP multi-map scheduling",
    maps: ["maps/second.tmj", "maps/third.tmj"].map((mapPathValue, index) => ({
      mapPath: mapPathValue,
      patch: {
        format: "wfl-tiled-patch",
        version: 1,
        base: { mapPath: mapPathValue, mapVersion: index === 0 ? secondMapVersion : thirdMapVersion, editorStateId: 0 },
        summary: `HTTP multi-map ${index}`,
        operations: [{ op: "update-layer", layerId: 1, changes: { name: `HTTP Multi ${index}` } }],
      },
    })),
  };
  const multiMapTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: multiMap.id,
      clientOperationId: "managed-task-http-multi-map",
      request: multiMapPatch,
      planSummary: { operationCount: 2, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(multiMapTask.response.status, 201, JSON.stringify(multiMapTask.data));
  const multiMapFinal = await waitForManagedTask(baseUrl, multiMapTask.data.task.id, ownerCookie, (task) => ["succeeded", "failed", "conflict"].includes(task.status));
  assert.equal(multiMapFinal.status, "succeeded", JSON.stringify(multiMapFinal));
  assert.equal(JSON.parse(await fs.readFile(mapPath, "utf8")).layers[0].name, "Ground");
  assert.equal(JSON.parse(await fs.readFile(secondMapPath, "utf8")).layers[0].name, "HTTP Multi 0");
  assert.equal(JSON.parse(await fs.readFile(thirdMapPath, "utf8")).layers[0].name, "HTTP Multi 1");
  assert.equal(multiMapFinal.currentVersions["maps/second.tmj"], sha256(await fs.readFile(secondMapPath)));
  assert.equal(multiMapFinal.currentVersions["maps/third.tmj"], sha256(await fs.readFile(thirdMapPath)));

  const managedSocketDirectory = path.join(runtimeDirectory, "map-ai-managed-tools");
  const managedSocketNames = (await fs.readdir(managedSocketDirectory)).filter((name) => name.endsWith(".sock"));
  assert.equal(managedSocketNames.length, 1);
  const managedSocketPath = path.join(managedSocketDirectory, managedSocketNames[0]);
  const managedCatalogMcp = spawn(process.execPath, [managedMapAiMcp, managedSocketPath], {
    cwd: repository,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => managedCatalogMcp.kill("SIGTERM"));
  const managedReadCatalog = jsonLineReader(managedCatalogMcp.stdout);
  managedCatalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const managedInitialization = (await managedReadCatalog()).result;
  assert.equal(managedInitialization.capabilities.tools.listChanged, false);
  managedCatalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  assert.deepEqual((await managedReadCatalog()).result.tools.map((tool) => tool.name), [
    "inspect_project", "get_project_context", "read_project_resource", "get_map_context", "read_map_region", "validate_map", "request_map_preview", "list_map_revisions", "restore_map_revision", "propose_tiled_patch", "apply_tiled_patch", "propose_project_patch", "apply_project_patch", "propose_tiled_resource_patch", "apply_tiled_resource_patch",
  ]);
  const projectAuthorizationResponse = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      projectWide: true,
      mode: "suggest",
      confirmed: true,
      clientOperationId: "managed-auth-project-wide-e2e",
    },
  });
  assert.equal(projectAuthorizationResponse.response.status, 201, JSON.stringify(projectAuthorizationResponse.data));
  const projectAuthorization = projectAuthorizationResponse.data.authorization;
  assert.equal(projectAuthorization.projectWide, true);
  assert.equal(projectAuthorization.scopeKind, "project");
  const projectCatalog = await callManagedMapAiMcp(managedSocketPath, "inspect_project", {
    authorizationId: projectAuthorization.id,
  });
  assert.equal(projectCatalog.result.isError, false, JSON.stringify(projectCatalog));
  assert.equal(projectCatalog.result.structuredContent.scope, "project");
  assert.ok(projectCatalog.result.structuredContent.resources.some((entry) => entry.path === "maps/world.tmj"));
  const projectContext = await callManagedMapAiMcp(managedSocketPath, "get_project_context", {
    authorizationId: projectAuthorization.id,
  });
  assert.equal(projectContext.result.isError, false, JSON.stringify(projectContext));
  assert.ok(projectContext.result.structuredContent.byKind.map.includes("maps/world.tmj"));
  const projectResource = await callManagedMapAiMcp(managedSocketPath, "read_project_resource", {
    authorizationId: projectAuthorization.id,
    resourcePath: "maps/world.tmj",
    maxBytes: 16 * 1024,
  });
  assert.equal(projectResource.result.isError, false, JSON.stringify(projectResource));
  assert.equal(projectResource.result.structuredContent.resource.path, "maps/world.tmj");
  assert.equal(projectResource.result.structuredContent.content, originalMap);
  const resourcePatch = {
    format: "wfl-tiled-resource-patch",
    version: 1,
    summary: "publish generated map",
    files: [{ path: resourceRelativePath, baseVersion: null, candidateId: resourceCandidate.candidateId }],
  };
  const managedContext = {
    authorizationId: resourceAuth.id,
    threadId: resourceThreadId,
    projectFingerprint: resourceAuth.projectFingerprint,
    mapPath: "maps/world.tmj",
    mapVersion: session.version,
  };
  const resourceProposal = await callManagedMapAiMcp(managedSocketPath, "propose_tiled_resource_patch", {
    ...managedContext,
    patch: resourcePatch,
  });
  assert.equal(resourceProposal.result.isError, false, JSON.stringify(resourceProposal));
  assert.equal(resourceProposal.result.structuredContent.requiresTask, true);
  const projectProposal = await callManagedMapAiMcp(managedSocketPath, "propose_project_patch", {
    authorizationId: projectAuthorization.id,
    patch: resourcePatch,
  });
  assert.equal(projectProposal.result.isError, false, JSON.stringify(projectProposal));
  assert.equal(projectProposal.result.structuredContent.scope, "project");
  assert.equal(projectProposal.result.structuredContent.requiresTask, true);
  const resourceApply = await callManagedMapAiMcp(managedSocketPath, "apply_tiled_resource_patch", {
    ...managedContext,
    patch: resourcePatch,
    clientOperationId: "managed-resource-apply-e2e",
  });
  assert.equal(resourceApply.result.isError, false, JSON.stringify(resourceApply));
  assert.ok(["queued", "awaiting_approval"].includes(resourceApply.result.structuredContent.task.status));
  assert.equal(await fs.access(path.join(project, resourceRelativePath)).then(() => true, () => false), false);
  const tamperedResourcePatch = { ...resourcePatch, files: [{ ...resourcePatch.files[0], sha256: "0".repeat(64) }] };
  const tamperedProposal = await callManagedMapAiMcp(managedSocketPath, "propose_tiled_resource_patch", {
    ...managedContext,
    patch: tamperedResourcePatch,
  });
  assert.equal(tamperedProposal.result.isError, true);
  assert.equal(typeof tamperedProposal.result.structuredContent.code, "string");

  // Exercise the public managed-task HTTP path as well as the MCP adapter.
  // The route deliberately persists a task before background execution, so
  // invalid candidates must settle to a bounded failure and never publish a
  // file; approval-policy tasks must remain stopped until an explicit action.
  const validResourceTaskPatch = {
    format: "wfl-tiled-resource-patch",
    version: 1,
    summary: "HTTP managed resource boundary",
    files: [{ path: resourceRelativePath, baseVersion: null, candidateId: resourceCandidate.candidateId }],
  };
  const httpResourceTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: resourceAuth.id,
      clientOperationId: "managed-resource-http-ask-each",
      request: validResourceTaskPatch,
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(httpResourceTask.response.status, 201, JSON.stringify(httpResourceTask.data));
  assert.equal(httpResourceTask.data.task.status, "queued");
  const httpResourceAwaiting = await waitForManagedTask(baseUrl, httpResourceTask.data.task.id, ownerCookie, (task) => task.status === "awaiting_approval");
  assert.equal(httpResourceAwaiting.status, "awaiting_approval");
  assert.equal(await pathExists(path.join(project, resourceRelativePath)), false);

  const missingCandidateTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: resourceAuth.id,
      clientOperationId: "managed-resource-http-missing-candidate",
      request: {
        ...validResourceTaskPatch,
        files: [{ path: resourceRelativePath, baseVersion: null, candidateId: "missing-resource-candidate" }],
      },
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(missingCandidateTask.response.status, 201, JSON.stringify(missingCandidateTask.data));
  const missingCandidateFinal = await waitForManagedTask(baseUrl, missingCandidateTask.data.task.id, ownerCookie, (task) => task.status === "failed");
  assert.equal(missingCandidateFinal.error.code, "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND");
  assert.equal(await pathExists(path.join(project, resourceRelativePath)), false);

  const declaredHashMismatchTask = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: resourceAuth.id,
      clientOperationId: "managed-resource-http-declared-hash-mismatch",
      request: {
        ...validResourceTaskPatch,
        files: [{ path: resourceRelativePath, baseVersion: null, candidateId: resourceCandidate.candidateId, sha256: "0".repeat(64) }],
      },
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(declaredHashMismatchTask.response.status, 201, JSON.stringify(declaredHashMismatchTask.data));
  const declaredHashMismatchFinal = await waitForManagedTask(baseUrl, declaredHashMismatchTask.data.task.id, ownerCookie, (task) => task.status === "failed");
  assert.equal(declaredHashMismatchFinal.error.code, "MAP_AI_RESOURCE_CANDIDATE_CHANGED");
  assert.equal(await pathExists(path.join(project, resourceRelativePath)), false);

  const aiReviewAuthorizationResponse = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/world.tmj",
      mapVersion: session.version,
      threadId: resourceThreadId,
      allowedOps: ["apply_tiled_resource_patch"],
      targetFiles: ["maps/world.tmj", resourceRelativePath],
      targetFileVersions: { "maps/world.tmj": session.version, [resourceRelativePath]: null },
      approvalPolicy: "ai_review",
      userConfirmed: true,
      clientOperationId: "managed-resource-ai-review-http",
    },
  });
  assert.equal(aiReviewAuthorizationResponse.response.status, 201, JSON.stringify(aiReviewAuthorizationResponse.data));
  const aiReviewAuthorization = aiReviewAuthorizationResponse.data.authorization;
  const aiReviewTaskResponse = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: aiReviewAuthorization.id,
      clientOperationId: "managed-resource-http-ai-review",
      request: validResourceTaskPatch,
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(aiReviewTaskResponse.response.status, 201, JSON.stringify(aiReviewTaskResponse.data));
  const aiReviewAwaiting = await waitForManagedTask(baseUrl, aiReviewTaskResponse.data.task.id, ownerCookie, (task) => task.status === "awaiting_approval");
  assert.equal(aiReviewAwaiting.status, "awaiting_approval");
  assert.equal(await pathExists(path.join(project, resourceRelativePath)), false);
  const aiReviewRevoked = await requestJson(baseUrl, `/api/map-ai/managed-authorizations/${aiReviewAuthorization.id}`, {
    method: "DELETE",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-revoke",
    body: { reason: "HTTP ai_review boundary" },
  });
  assert.equal(aiReviewRevoked.response.status, 200, JSON.stringify(aiReviewRevoked.data));
  const aiReviewCanceled = await waitForManagedTask(baseUrl, aiReviewTaskResponse.data.task.id, ownerCookie, (task) => task.status === "canceled");
  assert.equal(aiReviewCanceled.status, "canceled");

  const resourceRevoked = await requestJson(baseUrl, `/api/map-ai/managed-authorizations/${resourceAuth.id}`, {
    method: "DELETE",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-revoke",
    body: { reason: "HTTP ask_each boundary" },
  });
  assert.equal(resourceRevoked.response.status, 200, JSON.stringify(resourceRevoked.data));
  const httpResourceCanceled = await waitForManagedTask(baseUrl, httpResourceTask.data.task.id, ownerCookie, (task) => task.status === "canceled");
  assert.equal(httpResourceCanceled.status, "canceled");
  assert.equal(await pathExists(path.join(project, resourceRelativePath)), false);

  // Full authorization removes only the human approval gate. The same
  // candidate still passes the transaction, Tiled dependency closure and
  // version checks before it is published.
  const fullAuthorizationResponse = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/world.tmj",
      mapVersion: session.version,
      threadId: resourceThreadId,
      allowedOps: ["apply_tiled_resource_patch"],
      targetFiles: ["maps/world.tmj", resourceRelativePath],
      targetFileVersions: { "maps/world.tmj": session.version, [resourceRelativePath]: null },
      approvalPolicy: "full_authorization",
      userConfirmed: true,
      clientOperationId: "managed-resource-full-http",
    },
  });
  assert.equal(fullAuthorizationResponse.response.status, 201, JSON.stringify(fullAuthorizationResponse.data));
  const fullAuthorization = fullAuthorizationResponse.data.authorization;
  const fullTaskResponse = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: fullAuthorization.id,
      clientOperationId: "managed-resource-http-full-valid",
      request: validResourceTaskPatch,
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(fullTaskResponse.response.status, 201, JSON.stringify(fullTaskResponse.data));
  const fullTaskSucceeded = await waitForManagedTask(baseUrl, fullTaskResponse.data.task.id, ownerCookie, (task) => task.status === "succeeded");
  assert.equal(fullTaskSucceeded.status, "succeeded");
  assert.equal(await fs.readFile(path.join(project, resourceRelativePath), "utf8"), originalMap);

  // A task can be queued with a valid snapshot, but an external create after
  // its approval card must make the whole publish fail closed.
  const conflictRelativePath = "maps/generated/http-conflict.tmj";
  const conflictCandidate = await uploadManagedResourceCandidate({
    baseUrl,
    cookie: ownerCookie,
    sessionId: session.id,
    editorInstanceId,
    threadId: resourceThreadId,
    relativePath: conflictRelativePath,
    baseVersion: null,
    bytes: resourceBytes,
  });
  const conflictAuthorizationResponse = await requestJson(baseUrl, "/api/map-ai/managed-authorizations", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-authorization-create",
    body: {
      project,
      mapPath: "maps/world.tmj",
      mapVersion: session.version,
      threadId: resourceThreadId,
      allowedOps: ["apply_tiled_resource_patch"],
      targetFiles: ["maps/world.tmj", conflictRelativePath],
      targetFileVersions: { "maps/world.tmj": session.version, [conflictRelativePath]: null },
      approvalPolicy: "ask_each",
      userConfirmed: true,
      clientOperationId: "managed-resource-conflict-http",
    },
  });
  assert.equal(conflictAuthorizationResponse.response.status, 201, JSON.stringify(conflictAuthorizationResponse.data));
  const conflictAuthorization = conflictAuthorizationResponse.data.authorization;
  const conflictTaskResponse = await requestJson(baseUrl, "/api/map-ai/managed-tasks", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-create",
    body: {
      authorizationId: conflictAuthorization.id,
      clientOperationId: "managed-resource-http-conflict",
      request: {
        format: "wfl-tiled-resource-patch",
        version: 1,
        summary: "HTTP version conflict",
        files: [{ path: conflictRelativePath, baseVersion: null, candidateId: conflictCandidate.candidateId }],
      },
      planSummary: { operationCount: 1, tileCellCount: 0, ordinaryObjectCount: 0 },
    },
  });
  assert.equal(conflictTaskResponse.response.status, 201, JSON.stringify(conflictTaskResponse.data));
  const conflictAwaiting = await waitForManagedTask(baseUrl, conflictTaskResponse.data.task.id, ownerCookie, (task) => task.status === "awaiting_approval");
  assert.equal(conflictAwaiting.status, "awaiting_approval");
  await fs.writeFile(path.join(project, conflictRelativePath), resourceBytes);
  const conflictApproved = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${conflictTaskResponse.data.task.id}/action`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-managed-task-action",
    body: { action: "approve", approvalId: "http-conflict-approval" },
  });
  assert.equal(conflictApproved.response.status, 200, JSON.stringify(conflictApproved.data));
  const conflictFinal = await waitForManagedTask(baseUrl, conflictTaskResponse.data.task.id, ownerCookie, (task) => task.status === "conflict");
  assert.equal(conflictFinal.error.code, "MAP_AI_TASK_VERSION_CONFLICT");
  assert.equal(await fs.readFile(path.join(project, conflictRelativePath), "utf8"), originalMap);
  assert.equal(await fs.readFile(mapPath, "utf8"), originalMap);
  for (const authorizationId of [fullAuthorization.id, conflictAuthorization.id]) {
    const revokedAuthorization = await requestJson(baseUrl, `/api/map-ai/managed-authorizations/${authorizationId}`, {
      method: "DELETE",
      cookie: ownerCookie,
      action: "map-ai-managed-authorization-revoke",
      body: { reason: "HTTP boundary cleanup" },
    });
    assert.equal(revokedAuthorization.response.status, 200, JSON.stringify(revokedAuthorization.data));
  }

  const socketDirectory = path.join(runtimeDirectory, "map-ai-tools");
  const socketNames = (await fs.readdir(socketDirectory)).filter((name) => name.endsWith(".sock"));
  assert.equal(socketNames.length, 1);
  const socketPath = path.join(socketDirectory, socketNames[0]);
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
  const catalogMcp = spawn(process.execPath, [mapAiMcp, socketPath], {
    cwd: repository,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => catalogMcp.kill("SIGTERM"));
  const readCatalog = jsonLineReader(catalogMcp.stdout);
  catalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const catalogInitialization = (await readCatalog()).result;
  assert.equal(catalogInitialization.capabilities.tools.listChanged, false);
  assert.equal(typeof catalogInitialization.instructions, "string");
  catalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  catalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  assert.deepEqual((await readCatalog()).result.tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);

  const granted = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-leases`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-lease-grant",
    editorInstanceId,
    body: {
      threadId: "thread_smoke_001",
      editorStateId: 0,
      allowedOps: ["get_map_context", "propose_tiled_patch"],
    },
  });
  assert.equal(granted.response.status, 201, JSON.stringify(granted.data));
  const lease = granted.data.lease;
  assert.match(lease.leaseId, /^[A-Za-z0-9_-]{43}$/u);
  catalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`);
  assert.deepEqual((await readCatalog()).result.tools.map((tool) => tool.name), [
    "get_map_context",
    "propose_tiled_patch",
  ]);
  const toolContext = {
    threadId: "thread_smoke_001",
    mapSessionId: session.id,
    editorInstanceId,
    editorStateId: 0,
  };

  const contextCall = await callMapAiMcp(socketPath, "get_map_context", toolContext);
  assert.equal(contextCall.result.isError, false, JSON.stringify(contextCall));
  assert.deepEqual(contextCall.result.structuredContent.context, {
    mapSessionId: session.id,
    mapPath: "maps/world.tmj",
    mapVersion: session.version,
    writable: true,
    editorInstanceId,
    editorStateId: 0,
    leaseExpiresAt: lease.expiresAt,
  });

  const patch = {
    format: "wfl-tiled-patch",
    version: 1,
    base: { mapPath: "maps/world.tmj", mapVersion: session.version, editorStateId: 0 },
    summary: "Rename the ground layer",
    operations: [{ op: "update-layer", layerId: 1, changes: { name: "AI Ground" } }],
  };
  const proposed = await callMapAiMcp(socketPath, "propose_tiled_patch", { ...toolContext, patch });
  assert.equal(proposed.result.isError, false, JSON.stringify(proposed));
  const receipt = proposed.result.structuredContent.proposal;
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.summary, patch.summary);
  assert.equal(receipt.risk.ruleVersion, "map-risk-v1");
  assert.equal(receipt.risk.riskLevel, "high");
  assert.deepEqual(receipt.risk.reasonCodes, ["layer_rename"]);
  assert.deepEqual(receipt.risk.hardBlocks, []);
  assert.equal(Object.hasOwn(receipt, "patch"), false);
  const serializedReceipt = JSON.stringify(proposed);
  assert.doesNotMatch(serializedReceipt, /map-ai-owner-password|leaseId|browserSessionId|projectPath/u);
  assert.doesNotMatch(serializedReceipt, new RegExp(escapeRegExp(project), "u"));
  assert.equal(await fs.readFile(mapPath, "utf8"), originalMap);

  const inbox = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-proposals`, {
    cookie: ownerCookie,
    editorInstanceId,
    leaseId: lease.leaseId,
    editorStateId: 0,
  });
  assert.equal(inbox.response.status, 200, JSON.stringify(inbox.data));
  assert.equal(inbox.data.proposals.length, 1);
  assert.deepEqual(inbox.data.proposals[0].patch, patch);
  assert.equal(await fs.readFile(mapPath, "utf8"), originalMap);

  const otherWindowEditor = "map-ai-other-window";
  const otherWindowHttp = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-context`, {
    cookie: ownerCookie,
    editorInstanceId: otherWindowEditor,
    leaseId: lease.leaseId,
    editorStateId: 0,
  });
  assert.equal(otherWindowHttp.response.status, 404, JSON.stringify(otherWindowHttp.data));
  const otherWindowMcp = await callMapAiMcp(socketPath, "get_map_context", {
    ...toolContext,
    editorInstanceId: otherWindowEditor,
  });
  assert.equal(otherWindowMcp.result.isError, true);
  assert.equal(otherWindowMcp.result.structuredContent.code, "MAP_AI_LEASE_NOT_FOUND");

  const otherBrowserHttp = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-context`, {
    cookie: otherBrowserCookie,
    editorInstanceId,
    leaseId: lease.leaseId,
    editorStateId: 0,
  });
  assert.equal(otherBrowserHttp.response.status, 404, JSON.stringify(otherBrowserHttp.data));
  const otherBrowserEditor = "map-ai-browser-two";
  const otherBrowserOpened = await requestJson(baseUrl, "/api/maps/sessions", {
    method: "POST",
    cookie: otherBrowserCookie,
    action: "map-session-open",
    body: { project, path: mapPath, editorInstanceId: otherBrowserEditor },
  });
  assert.equal(otherBrowserOpened.response.status, 201, JSON.stringify(otherBrowserOpened.data));
  const otherBrowserSession = otherBrowserOpened.data.session;
  const otherBrowserLeaseReuse = await requestJson(
    baseUrl,
    `/api/maps/sessions/${otherBrowserSession.id}/ai-context`,
    {
      cookie: otherBrowserCookie,
      editorInstanceId: otherBrowserEditor,
      leaseId: lease.leaseId,
      editorStateId: 0,
    },
  );
  assert.equal(otherBrowserLeaseReuse.response.status, 409, JSON.stringify(otherBrowserLeaseReuse.data));
  const otherBrowserMcp = await callMapAiMcp(socketPath, "get_map_context", {
    ...toolContext,
    mapSessionId: otherBrowserSession.id,
    editorInstanceId: otherBrowserEditor,
  });
  assert.equal(otherBrowserMcp.result.isError, true);
  assert.equal(otherBrowserMcp.result.structuredContent.code, "MAP_AI_LEASE_NOT_FOUND");

  const otherProjectEditor = "map-ai-other-project";
  const otherProjectOpened = await requestJson(baseUrl, "/api/maps/sessions", {
    method: "POST",
    cookie: ownerCookie,
    action: "map-session-open",
    body: { project: otherProject, path: otherMapPath, editorInstanceId: otherProjectEditor },
  });
  assert.equal(otherProjectOpened.response.status, 201, JSON.stringify(otherProjectOpened.data));
  const otherProjectSession = otherProjectOpened.data.session;
  const crossProjectGrant = await requestJson(
    baseUrl,
    `/api/maps/sessions/${otherProjectSession.id}/ai-leases`,
    {
      method: "POST",
      cookie: ownerCookie,
      action: "map-ai-lease-grant",
      editorInstanceId: otherProjectEditor,
      body: {
        threadId: toolContext.threadId,
        editorStateId: 0,
        allowedOps: ["get_map_context"],
      },
    },
  );
  assert.equal(crossProjectGrant.response.status, 409, JSON.stringify(crossProjectGrant.data));
  const crossProjectHttp = await requestJson(
    baseUrl,
    `/api/maps/sessions/${otherProjectSession.id}/ai-context`,
    {
      cookie: ownerCookie,
      editorInstanceId: otherProjectEditor,
      leaseId: lease.leaseId,
      editorStateId: 0,
    },
  );
  assert.equal(crossProjectHttp.response.status, 409, JSON.stringify(crossProjectHttp.data));
  const crossProjectMcp = await callMapAiMcp(socketPath, "get_map_context", {
    ...toolContext,
    mapSessionId: otherProjectSession.id,
    editorInstanceId: otherProjectEditor,
  });
  assert.equal(crossProjectMcp.result.isError, true);
  assert.equal(crossProjectMcp.result.structuredContent.code, "MAP_AI_LEASE_NOT_FOUND");

  const wrongState = await callMapAiMcp(socketPath, "get_map_context", {
    ...toolContext,
    editorStateId: 1,
  });
  assert.equal(wrongState.result.isError, true);
  assert.equal(wrongState.result.structuredContent.code, "MAP_AI_LEASE_NOT_FOUND");

  const revoked = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-leases/revoke`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-lease-revoke",
    editorInstanceId,
    leaseId: lease.leaseId,
    body: {},
  });
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.data));
  catalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
  assert.deepEqual((await readCatalog()).result.tools.map((tool) => tool.name), ["get_map_context", "propose_tiled_patch"]);
  const afterRevoke = await callMapAiMcp(socketPath, "get_map_context", toolContext);
  assert.equal(afterRevoke.result.isError, true);
  assert.equal(afterRevoke.result.structuredContent.code, "MAP_AI_OPERATION_UNAVAILABLE");

  const regranted = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-leases`, {
    method: "POST",
    cookie: ownerCookie,
    action: "map-ai-lease-grant",
    editorInstanceId,
    body: {
      threadId: toolContext.threadId,
      editorStateId: 0,
      allowedOps: ["get_map_context", "propose_tiled_patch"],
    },
  });
  assert.equal(regranted.response.status, 201, JSON.stringify(regranted.data));
  const currentLease = regranted.data.lease;
  catalogMcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} })}\n`);
  assert.deepEqual((await readCatalog()).result.tools.map((tool) => tool.name), [
    "get_map_context",
    "propose_tiled_patch",
  ]);

  await fs.writeFile(mapPath, `${originalMap}\n`);
  const changedMapHttp = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-context`, {
    cookie: ownerCookie,
    editorInstanceId,
    leaseId: currentLease.leaseId,
    editorStateId: 0,
  });
  assert.equal(changedMapHttp.response.status, 409, JSON.stringify(changedMapHttp.data));
  const changedMapMcp = await callMapAiMcp(socketPath, "get_map_context", toolContext);
  assert.equal(changedMapMcp.result.isError, true);
  assert.equal(changedMapMcp.result.structuredContent.code, "MAP_AI_MAP_VERSION_CONFLICT");
  await fs.writeFile(mapPath, originalMap);

  const deleted = await websocketRpc(baseUrl, ownerCookie, "thread/delete", {
    threadId: toolContext.threadId,
  });
  assert.equal(deleted.type, "rpc/result", JSON.stringify(deleted));
  const deletedThreadHttp = await requestJson(baseUrl, `/api/maps/sessions/${session.id}/ai-context`, {
    cookie: ownerCookie,
    editorInstanceId,
    leaseId: currentLease.leaseId,
    editorStateId: 0,
  });
  assert.equal(deletedThreadHttp.response.status, 404, JSON.stringify(deletedThreadHttp.data));
  const deletedThreadMcp = await callMapAiMcp(socketPath, "get_map_context", toolContext);
  assert.equal(deletedThreadMcp.result.isError, true);
  assert.equal(deletedThreadMcp.result.structuredContent.code, "MAP_AI_OPERATION_UNAVAILABLE");
  assert.equal(await fs.readFile(mapPath, "utf8"), originalMap);
});

test("map AI runtime override is optional and rescue-gated without model-visible secrets", async () => {
  const source = await fs.readFile(path.join(repository, "server.mjs"), "utf8");
  const override = source.slice(
    source.indexOf("function codexMapAiMcpOverride"),
    source.indexOf("function codexPersistentSshMcpOverride"),
  );
  assert.match(override, /mcp_servers\.wfl_map_ai/u);
  assert.match(override, /required = false/u);
  assert.doesNotMatch(override, /lease|token|projectPath|browserSession|userId/iu);
  const runtimeSetup = source.slice(
    source.indexOf("this.refreshImportedThreadMappings()"),
    source.indexOf("const environment = this.environmentForProvider"),
  );
  assert.match(runtimeSetup, /if \(!RESCUE_MODE && CODEX_ENABLED\)/u);
  assert.match(runtimeSetup, /new MapAiToolService/u);
});

async function requestJson(baseUrl, pathname, {
  method = "GET",
  authorization = null,
  cookie = null,
  action = null,
  body = undefined,
  editorInstanceId = null,
  leaseId = null,
  editorStateId = null,
} = {}) {
  const headers = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers.Origin = baseUrl;
  if (action) headers["X-Codex-Desktop-Action"] = action;
  if (editorInstanceId) headers["X-Codex-Desktop-Editor-Instance"] = editorInstanceId;
  if (leaseId) headers["X-Codex-Desktop-Map-AI-Lease"] = leaseId;
  if (editorStateId !== null) headers["X-Codex-Desktop-Editor-State"] = String(editorStateId);
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

async function waitForManagedTask(baseUrl, taskId, cookie, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const snapshot = await requestJson(baseUrl, `/api/map-ai/managed-tasks/${encodeURIComponent(taskId)}`, { cookie });
    assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.data));
    latest = snapshot.data.task;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`托管任务未在 ${timeoutMs}ms 内达到预期状态: ${taskId} (${latest?.status || "unknown"})`);
}

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function uploadManagedResourceCandidate({ baseUrl, cookie, sessionId, editorInstanceId, threadId, relativePath, baseVersion, bytes }) {
  const started = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(sessionId)}/managed-resource-uploads`, {
    method: "POST",
    cookie,
    action: "map-ai-resource-upload-start",
    editorInstanceId,
    body: {
      path: relativePath,
      baseVersion,
      totalBytes: bytes.length,
      totalHash: sha256(bytes),
      editorStateId: 0,
      threadId,
    },
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.data));
  const upload = started.data.upload;
  const chunk = await fetch(`${baseUrl}/api/maps/sessions/${encodeURIComponent(sessionId)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/chunks/0`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      "X-Codex-Desktop-Action": "map-ai-resource-upload-chunk",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
      "X-Codex-Desktop-Editor-State": "0",
      "X-WFL-Map-AI-Thread": threadId,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "X-Content-SHA256": sha256(bytes),
    },
    body: bytes,
  });
  assert.equal(chunk.status, 200, await chunk.text());
  const committed = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(sessionId)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/commit`, {
    method: "POST",
    cookie,
    action: "map-ai-resource-upload-commit",
    editorInstanceId,
    body: { editorStateId: 0, threadId },
  });
  assert.equal(committed.response.status, 201, JSON.stringify(committed.data));
  return committed.data.candidate;
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

function websocketRpc(baseUrl, cookie, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace("http", "ws") + "/ws", {
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket RPC timed out: ${method}`));
    }, 10_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "rpc", requestId, method, params })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function callMapAiMcp(socketPath, name, args) {
  const child = spawn(process.execPath, [mapAiMcp, socketPath], {
    cwd: repository,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })}\n`);
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error(`Map AI MCP timed out: ${stderr}`);
  }
  assert.equal(exit.code, 0, stderr);
  const line = stdout.trim().split("\n").find(Boolean);
  assert.ok(line, `Map AI MCP returned no output: ${stderr}`);
  return JSON.parse(line);
}

async function callManagedMapAiMcp(socketPath, name, args) {
  const child = spawn(process.execPath, [managedMapAiMcp, socketPath], {
    cwd: repository,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })}\n`);
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error(`Managed map AI MCP timed out: ${stderr}`);
  }
  assert.equal(exit.code, 0, stderr);
  const line = stdout.trim().split("\n").find(Boolean);
  assert.ok(line, `Managed map AI MCP returned no output: ${stderr}`);
  return JSON.parse(line);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonLineReader(stream) {
  let buffer = "";
  const values = [];
  const waiters = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else values.push(value);
    }
  });
  return () => values.length
    ? Promise.resolve(values.shift())
    : new Promise((resolve) => waiters.push(resolve));
}

function readWithTimeout(read, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP notification timed out")), timeoutMs);
    void read().then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
