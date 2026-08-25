import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";

const repository = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const fakeCodex = path.join(repository, "test", "fixtures", "fake-codex-app-server.mjs");
const fakeClaude = path.join(repository, "test", "fixtures", "fake-claude-control.mjs");

test("managed resource upload HTTP flow is Thread-bound and returns only an opaque candidate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-http-"));
  await fs.chmod(root, 0o711);
  const projectRoot = path.join(root, "projects");
  const project = path.join(projectRoot, "game");
  const mapPath = path.join(project, "maps", "world.tmj");
  const stateDirectory = path.join(root, "state");
  // Keep the Unix socket path below Linux's 108-byte AF_UNIX limit.
  const runtimeDirectory = path.join(root, "r");
  const codexHome = path.join(root, "codex-home");
  const usersRoot = path.join(root, "users");
  const authFile = path.join(root, "auth.json");
  const username = "owner";
  const password = "resource-upload-http-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const map = `${JSON.stringify({
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
  const candidate = `${JSON.stringify({
    type: "map",
    version: "1.10",
    tiledversion: "1.10.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [{ id: 1, name: "Uploaded", type: "tilelayer", width: 1, height: 1, data: [0] }],
    tilesets: [],
  }, null, 2)}\n`;
  await Promise.all([
    fs.mkdir(path.dirname(mapPath), { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(usersRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(mapPath, map),
    fs.writeFile(path.join(project, "VERSION"), "0.43.0-beta\n"),
    fs.writeFile(path.join(project, "CHANGELOG.md"), "# HTTP resource upload test\n"),
  ]);
  await writeAuth(authFile, createAuthRecord(username, password));
  await fs.writeFile(path.join(root, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodex)} "$@"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      PATH: process.env.PATH,
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
      CODEX_DESKTOP_CODEX_BIN: path.join(root, "codex"),
      CODEX_DESKTOP_CLAUDE_BIN: path.join(root, "claude"),
      CODEX_DESKTOP_BACKEND_INSTANCE_ID: "",
      CODEX_DESKTOP_BACKEND_WRITER_EPOCH: "",
      CODEX_DESKTOP_CONVERSATION_SIDECAR: "0",
      CODEX_DESKTOP_RELEASE_DISABLED: "1",
      CODEX_DESKTOP_APP_UPDATE_DISABLED: "1",
      CODEX_DESKTOP_CODEX_UPDATE_DISABLED: "1",
      FAKE_CODEX_PROJECT: project,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForServer(server, "WFL Codex Desktop v");

  const editorInstanceId = "map-resource-upload-http-0001";
  const opened = await requestJson(baseUrl, "/api/maps/sessions", {
    method: "POST",
    authorization,
    action: "map-session-open",
    body: { project, path: mapPath, editorInstanceId },
  });
  assert.equal(opened.response.status, 201, diagnostic(opened, output));
  const session = opened.data.session;
  const threadId = "thread_smoke_001";
  const bytes = Buffer.from(candidate);
  const totalHash = sha256(bytes);
  const uploadHeaders = {
    Origin: baseUrl,
    "X-Codex-Desktop-Editor-Instance": editorInstanceId,
  };
  const started = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads`, {
    method: "POST",
    authorization,
    action: "map-ai-resource-upload-start",
    headers: uploadHeaders,
    body: {
      path: "maps/generated/uploaded.tmj",
      baseVersion: null,
      totalBytes: bytes.length,
      totalHash,
      editorStateId: 0,
      threadId,
    },
  });
  assert.equal(started.response.status, 201, diagnostic(started, output));
  const upload = started.data.upload;
  assert.equal(upload.threadId, threadId);
  assert.equal(Object.hasOwn(upload, "filePath"), false);

  const chunkBytes = upload.chunkBytes;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes)));
  const chunksUrl = (index) => `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`;
  const missingThread = await fetch(`${baseUrl}${chunksUrl(0)}`, {
    method: "PUT",
    headers: { Authorization: authorization, ...uploadHeaders, "Content-Type": "application/octet-stream", "Content-Length": String(chunks[0].length), "X-Content-SHA256": sha256(chunks[0]), "X-Codex-Desktop-Action": "map-ai-resource-upload-chunk" },
    body: chunks[0],
  });
  assert.equal(missingThread.status, 400);
  const wrongThread = await uploadChunk(baseUrl, chunksUrl(0), authorization, uploadHeaders, chunks[0], "other-thread");
  assert.equal(wrongThread.response.status, 409, diagnostic(wrongThread, output));
  for (const [index, chunk] of chunks.entries()) {
    const appended = await uploadChunk(baseUrl, chunksUrl(index), authorization, uploadHeaders, chunk, threadId);
    assert.equal(appended.response.status, 200, diagnostic(appended, output));
  }

  const unknownCommitField = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/commit`, {
    method: "POST",
    authorization,
    action: "map-ai-resource-upload-commit",
    headers: uploadHeaders,
    body: { editorStateId: 0, threadId, unexpected: true },
  });
  assert.equal(unknownCommitField.response.status, 400, diagnostic(unknownCommitField, output));

  // A changed map must stop the commit before a candidate is registered. The
  // original bytes are restored and the same upload can then be retried.
  await fs.writeFile(mapPath, `${map}changed\n`);
  const staleCommit = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/commit`, {
    method: "POST",
    authorization,
    action: "map-ai-resource-upload-commit",
    headers: uploadHeaders,
    body: { editorStateId: 0, threadId },
  });
  assert.equal(staleCommit.response.status, 409, diagnostic(staleCommit, output));
  await fs.writeFile(mapPath, map);

  const status = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}?threadId=${encodeURIComponent(threadId)}&editorStateId=0`, {
    authorization,
    headers: uploadHeaders,
  });
  assert.equal(status.response.status, 200, diagnostic(status, output));
  assert.equal(status.data.upload.uploadedBytes, bytes.length);
  const wrongStatusThread = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}?threadId=other-thread&editorStateId=0`, {
    authorization,
    headers: uploadHeaders,
  });
  assert.equal(wrongStatusThread.response.status, 409, diagnostic(wrongStatusThread, output));
  const commit = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/commit`, {
    method: "POST",
    authorization,
    action: "map-ai-resource-upload-commit",
    headers: uploadHeaders,
    body: { editorStateId: 0, threadId },
  });
  assert.equal(commit.response.status, 201, diagnostic(commit, output));
  assert.match(commit.data.candidate.candidateId, /^[A-Za-z0-9_-]{20,}$/u);
  assert.equal(commit.data.candidate.path, "maps/generated/uploaded.tmj");
  assert.doesNotMatch(JSON.stringify(commit.data), /\/tmp\/|\/srv\/|candidatePath|filePath/u);
  const afterCommit = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}?threadId=${encodeURIComponent(threadId)}&editorStateId=0`, {
    authorization,
    headers: uploadHeaders,
  });
  assert.equal(afterCommit.response.status, 404, diagnostic(afterCommit, output));

  const retryCommit = await requestJson(baseUrl, `/api/maps/sessions/${encodeURIComponent(session.id)}/managed-resource-uploads/${encodeURIComponent(upload.uploadId)}/commit`, {
    method: "POST",
    authorization,
    action: "map-ai-resource-upload-commit",
    headers: uploadHeaders,
    body: { editorStateId: 0, threadId },
  });
  assert.equal(retryCommit.response.status, 200, diagnostic(retryCommit, output));
  assert.equal(retryCommit.data.idempotent, true);
  assert.equal(retryCommit.data.candidate.candidateId, commit.data.candidate.candidateId);
});

async function uploadChunk(baseUrl, url, authorization, common, bytes, threadId) {
  return requestRawJson(baseUrl, url, {
    method: "PUT",
    authorization,
    headers: {
      ...common,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "X-Content-SHA256": sha256(bytes),
      "X-Codex-Desktop-Action": "map-ai-resource-upload-chunk",
      "X-WFL-Map-AI-Thread": threadId,
    },
    body: bytes,
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  return requestRawJson(baseUrl, pathname, { ...options, json: true });
}

async function requestRawJson(baseUrl, pathname, { method = "GET", authorization, action, headers = {}, body, json = false } = {}) {
  const requestHeaders = { Accept: "application/json", Authorization: authorization, ...headers };
  if (action) requestHeaders["X-Codex-Desktop-Action"] = action;
  if (json && body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  if (method !== "GET") requestHeaders.Origin ||= baseUrl;
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  return { response, data };
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function diagnostic(result, output) { return `${JSON.stringify(result.data)}\n${output}`; }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

function waitForServer(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server start timeout: ${output}`)), 10_000);
    processHandle.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      resolve();
    });
    processHandle.stderr.on("data", (chunk) => { output += chunk; });
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}): ${output}`));
    });
  });
}
