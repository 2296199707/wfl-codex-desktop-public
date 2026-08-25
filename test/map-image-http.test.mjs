import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthRecord, writeAuth } from "../lib/auth.mjs";
import { createMapSelectionImageTarget } from "../public/map-editor/map-selection-image-target.js";

const appPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const fakeCodex = path.join(process.cwd(), "test", "fixtures", "fake-codex-app-server.mjs");

test("map image HTTP jobs stage, preview, isolate, and explicitly publish a candidate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-image-http-"));
  const projectRoot = path.join(root, "projects");
  const defaultProject = path.join(projectRoot, "default-project");
  const managedUsersRoot = path.join(projectRoot, "managed-users");
  const stateDirectory = path.join(root, "state");
  const runtimeDirectory = path.join(root, "runtime");
  const ownerCodexHome = path.join(root, "codex-home");
  const mapDirectory = path.join(defaultProject, "maps");
  const mapPath = path.join(mapDirectory, "world.tmj");
  const mapDocument = {
    type: "map",
    orientation: "orthogonal",
    renderorder: "right-down",
    width: 64,
    height: 64,
    tilewidth: 16,
    tileheight: 16,
    infinite: false,
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [{
      id: 1,
      name: "Ground",
      type: "tilelayer",
      width: 64,
      height: 64,
      data: Array(64 * 64).fill(0),
    }],
    tilesets: [],
  };
  await Promise.all([
    fs.mkdir(mapDirectory, { recursive: true }),
    fs.mkdir(managedUsersRoot, { recursive: true }),
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(ownerCodexHome, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(defaultProject, "VERSION"), `${appPackage.version}\n`),
    fs.writeFile(path.join(defaultProject, "CHANGELOG.md"), "# Map image HTTP test\n"),
    fs.writeFile(mapPath, `${JSON.stringify(mapDocument)}\n`),
  ]);
  const fakeSystemctl = path.join(root, "systemctl.cjs");
  await fs.writeFile(fakeSystemctl, [
    "#!/usr/bin/env node",
    "process.exit(3);",
    "",
  ].join("\n"), { mode: 0o700 });
  const codexShim = path.join(root, "codex");
  await fs.writeFile(codexShim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodex)} "$@"\n`, { mode: 0o700 });
  const authFile = path.join(root, "auth.json");
  const username = "codex";
  const password = "map-image-http-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  await writeAuth(authFile, createAuthRecord(username, password));

  const sharp = (await import("sharp")).default;
  const candidatePng = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: "#438a52" },
  }).png().toBuffer();
  const providerRequests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const contentType = String(request.headers["content-type"] || "");
    const json = contentType.startsWith("application/json")
      ? JSON.parse(body.toString("utf8"))
      : null;
    const multipart = contentType.startsWith("multipart/form-data")
      ? {
          prompt: multipartTextField(body, "prompt"),
          size: multipartTextField(body, "size"),
        }
      : null;
    const requestedSize = String(json?.size || multipart?.size || "1024x1024");
    const sizeMatch = /^(\d+)x(\d+)$/u.exec(requestedSize);
    const responsePng = sizeMatch && requestedSize !== "1024x1024"
      ? await sharp({
          create: {
            width: Number(sizeMatch[1]),
            height: Number(sizeMatch[2]),
            channels: 4,
            background: "#376aa8",
          },
        }).png().toBuffer()
      : candidatePng;
    providerRequests.push({ path: request.url, json, multipart, contentType, body });
    response.writeHead(200, { "Content-Type": "application/json", "X-Request-Id": "map-http-request-1" });
    response.end(JSON.stringify({
      data: [{ b64_json: responsePng.toString("base64"), revised_prompt: "map candidate revised" }],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    }));
  });
  await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_PROJECT_ROOT: projectRoot,
      CODEX_DESKTOP_DEFAULT_PROJECT: defaultProject,
      CODEX_DESKTOP_MULTI_USER_ROOT: managedUsersRoot,
      CODEX_DESKTOP_OWNER_CODEX_HOME: ownerCodexHome,
      CODEX_DESKTOP_CODEX_BIN: codexShim,
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
      FAKE_CODEX_PROJECT: defaultProject,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForServer(child, "WFL Codex Desktop v");

  const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { Authorization: authorization, ...options.headers },
    });
    return { response, data: await response.json() };
  };
  const provider = await fetchJson(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Map image HTTP provider",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      model: "unused-text-model",
      apiKey: "map-image-http-secret",
    }),
  });
  assert.equal(provider.response.status, 201, JSON.stringify(provider.data));
  const configured = await fetchJson(`${baseUrl}/api/images/settings`, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "image-api-save",
    },
    body: JSON.stringify({
      providerId: provider.data.profile.id,
      preset: "openai-gpt-image-2",
      model: "gpt-image-2-map-http-test",
      defaults: { size: "1024x1024", quality: "auto", outputFormat: "png", n: 1 },
    }),
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.data));

  const editorInstanceId = "map-image-http-window-0001";
  const mapOpened = await fetchJson(`${baseUrl}/api/maps/sessions`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-session-open",
    },
    body: JSON.stringify({ project: defaultProject, path: mapPath, editorInstanceId }),
  });
  assert.equal(mapOpened.response.status, 201, JSON.stringify(mapOpened.data));
  const session = mapOpened.data.session;
  const jobsUrl = `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-jobs`;
  const requestHeaders = {
    Origin: baseUrl,
    "Content-Type": "application/json",
    "X-Codex-Desktop-Action": "map-image-start",
    "X-Codex-Desktop-Editor-Instance": editorInstanceId,
  };

  const staleStart = await fetchJson(jobsUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      expectedVersion: "b".repeat(64),
      request: { operation: "generate", prompt: "stale candidate", size: "1024x1024", outputFormat: "png" },
    }),
  });
  assert.equal(staleStart.response.status, 409, JSON.stringify(staleStart.data));

  const started = await fetchJson(jobsUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      expectedVersion: session.version,
      request: {
        operation: "generate",
        prompt: "map candidate green ground tile",
        size: "1024x1024",
        quality: "auto",
        outputFormat: "png",
        n: 1,
      },
    }),
  });
  assert.equal(started.response.status, 202, JSON.stringify(started.data));
  const jobId = started.data.job.id;
  const jobUrl = `${jobsUrl}/${encodeURIComponent(jobId)}`;
  let completed;
  try {
    completed = await waitForJob(fetchJson, jobUrl, editorInstanceId);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${childOutput}`, { cause: error });
  }
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.candidate.files[0].mediaType, "image/png");
  assert.equal(completed.candidate.files[0].width, 1024);
  assert.equal(completed.candidate.files[0].height, 1024);
  const publicJob = JSON.stringify(completed);
  assert.doesNotMatch(publicJob, /attachment|map-image-candidates|image-execution|\/tmp\//u);
  assert.doesNotMatch(publicJob, new RegExp(escapeRegExp(defaultProject), "u"));

  // A browser retry after a lost response must return the same opaque
  // candidate rather than registering another image candidate.
  const candidateBridgeHeaders = {
    Origin: baseUrl,
    "Content-Type": "application/json",
    "X-Codex-Desktop-Action": "map-ai-resource-candidate-register",
    "X-Codex-Desktop-Editor-Instance": editorInstanceId,
  };
  const candidateBridgeBody = {
    index: 0,
    path: "maps/generated/managed-green-ground.png",
    baseVersion: null,
    threadId: "thread_smoke_001",
    clientOperationId: "map-image-candidate-bridge-0001",
  };
  const bridged = await fetchJson(`${jobUrl}/managed-resource-candidate`, {
    method: "POST",
    headers: candidateBridgeHeaders,
    body: JSON.stringify(candidateBridgeBody),
  });
  assert.equal(bridged.response.status, 201, JSON.stringify(bridged.data));
  assert.match(bridged.data.candidate.candidateId, /^[A-Za-z0-9_-]{20,}$/u);
  assert.equal(bridged.data.candidate.path, candidateBridgeBody.path);
  assert.doesNotMatch(JSON.stringify(bridged.data), /\/tmp\/|candidatePath|filePath/u);
  const bridgedRetry = await fetchJson(`${jobUrl}/managed-resource-candidate`, {
    method: "POST",
    headers: candidateBridgeHeaders,
    body: JSON.stringify(candidateBridgeBody),
  });
  assert.equal(bridgedRetry.response.status, 200, JSON.stringify(bridgedRetry.data));
  assert.equal(bridgedRetry.data.idempotent, true);
  assert.equal(bridgedRetry.data.candidate.candidateId, bridged.data.candidate.candidateId);
  const bridgedConflict = await fetchJson(`${jobUrl}/managed-resource-candidate`, {
    method: "POST",
    headers: candidateBridgeHeaders,
    body: JSON.stringify({ ...candidateBridgeBody, path: "maps/generated/managed-green-ground-2.png" }),
  });
  assert.equal(bridgedConflict.response.status, 409, JSON.stringify(bridgedConflict.data));

  // A retry must not trust the public receipt after the private staged
  // payload has changed.  Locate the test-only candidate payload under the
  // runtime directory and corrupt it, then verify the bridge re-resolves the
  // candidate and returns a structured conflict instead of the stale 200
  // receipt.
  const candidateRoot = path.join(runtimeDirectory, "map-ai-resource-candidates");
  const candidateDirectories = (await fs.readdir(candidateRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("resource-"));
  assert.equal(candidateDirectories.length, 1);
  const candidateDirectory = path.join(candidateRoot, candidateDirectories[0].name);
  const candidateManifest = JSON.parse(await fs.readFile(path.join(candidateDirectory, ".map-ai-resource-candidate.json"), "utf8"));
  assert.equal(candidateManifest.id, bridged.data.candidate.candidateId);
  await fs.writeFile(path.join(candidateDirectory, "payload.png"), Buffer.from("tampered-image"));
  const tamperedRetry = await fetchJson(`${jobUrl}/managed-resource-candidate`, {
    method: "POST",
    headers: candidateBridgeHeaders,
    body: JSON.stringify(candidateBridgeBody),
  });
  assert.equal(tamperedRetry.response.status, 409, JSON.stringify(tamperedRetry.data));
  assert.equal(tamperedRetry.data.code, "MAP_AI_RESOURCE_CANDIDATE_CHANGED");

  const wrongWindow = await fetchJson(jobUrl, {
    headers: { "X-Codex-Desktop-Editor-Instance": "map-image-http-window-0002" },
  });
  assert.equal(wrongWindow.response.status, 404);

  const candidateUrl = `${jobUrl}/files/0`;
  const wrongWindowPreview = await fetch(candidateUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": "map-image-http-window-0002",
    },
  });
  assert.equal(wrongWindowPreview.status, 404);
  const preview = await fetch(candidateUrl, {
    headers: {
      Authorization: authorization,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), candidatePng);

  const destination = "maps/generated/green-ground.png";
  const publishHeaders = {
    Origin: baseUrl,
    "Content-Type": "application/json",
    "X-Codex-Desktop-Action": "map-image-publish",
    "X-Codex-Desktop-Editor-Instance": editorInstanceId,
  };
  const missingConfirmation = await fetchJson(`${jobUrl}/publish`, {
    method: "POST",
    headers: publishHeaders,
    body: JSON.stringify({
      mapVersion: session.version,
      destinations: [{ index: 0, path: destination }],
    }),
  });
  assert.equal(missingConfirmation.response.status, 400);
  assert.equal(await fs.stat(path.join(defaultProject, destination)).catch(() => null), null);

  const wrongVersion = await fetchJson(`${jobUrl}/publish`, {
    method: "POST",
    headers: publishHeaders,
    body: JSON.stringify({
      confirmation: jobId,
      mapVersion: "c".repeat(64),
      destinations: [{ index: 0, path: destination }],
    }),
  });
  assert.equal(wrongVersion.response.status, 409);
  assert.equal(await fs.stat(path.join(defaultProject, destination)).catch(() => null), null);

  const published = await fetchJson(`${jobUrl}/publish`, {
    method: "POST",
    headers: publishHeaders,
    body: JSON.stringify({
      confirmation: jobId,
      mapVersion: session.version,
      destinations: [{ index: 0, path: destination }],
      companions: [
        {
          type: "tileset-atlas",
          sourceIndex: 0,
          path: "maps/generated/green-ground.tsj",
          name: "Green ground",
          tileWidth: 32,
          tileHeight: 32,
          margin: 0,
          spacing: 0,
        },
        {
          type: "composite-map",
          sourceIndex: 0,
          path: "maps/generated/green-ground.tmj",
          name: "Green ground composite",
          tileWidth: 32,
          tileHeight: 32,
        },
      ],
    }),
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.data));
  assert.equal(published.data.job.status, "published");
  assert.equal(published.data.published[0].relativePath, destination);
  assert.deepEqual(
    published.data.published.map((entry) => entry.artifactType),
    ["image", "tileset", "composite"],
  );
  assert.deepEqual(await fs.readFile(path.join(defaultProject, destination)), candidatePng);
  const publishedTileset = JSON.parse(await fs.readFile(
    path.join(defaultProject, "maps/generated/green-ground.tsj"),
    "utf8",
  ));
  assert.equal(publishedTileset.image, "green-ground.png");
  assert.equal(publishedTileset.tilecount, 1024);
  const publishedComposite = JSON.parse(await fs.readFile(
    path.join(defaultProject, "maps/generated/green-ground.tmj"),
    "utf8",
  ));
  assert.equal(publishedComposite.layers[0].image, "green-ground.png");
  const publicPublish = JSON.stringify(published.data);
  assert.doesNotMatch(publicPublish, /attachment|map-image-candidates|image-execution|\/tmp\//u);
  assert.doesNotMatch(publicPublish, new RegExp(escapeRegExp(defaultProject), "u"));
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].path, "/v1/images/generations");
  assert.equal(providerRequests[0].json.prompt, "map candidate green ground tile");

  // Temporary source/mask inputs are pinned for the queued job and staged
  // into the isolated Worker before the multipart edit request is sent.
  const editorStateId = 0;
  const uploadInput = async (kind) => {
    const bytes = candidatePng;
    const startedInput = await fetchJson(
      `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-inputs`,
      {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "map-image-input-start",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
        },
        body: JSON.stringify({
          expectedVersion: session.version,
          editorStateId,
          kind,
          mediaType: "image/png",
          totalBytes: bytes.length,
          totalHash: sha256(bytes),
          width: 1024,
          height: 1024,
        }),
      },
    );
    assert.equal(startedInput.response.status, 201, JSON.stringify(startedInput.data));
    const input = startedInput.data.input;
    const chunk = await fetchJson(
      `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-inputs/${encodeURIComponent(input.id)}/chunks/0`,
      {
        method: "PUT",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "X-Content-SHA256": sha256(bytes),
          "X-Codex-Desktop-Action": "map-image-input-chunk",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
          "X-Codex-Desktop-Editor-State": String(editorStateId),
        },
        body: bytes,
      },
    );
    assert.equal(chunk.response.status, 200, JSON.stringify(chunk.data));
    const committed = await fetchJson(
      `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-inputs/${encodeURIComponent(input.id)}/commit`,
      {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "map-image-input-commit",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
        },
        body: JSON.stringify({ editorStateId }),
      },
    );
    assert.equal(committed.response.status, 200, JSON.stringify(committed.data));
    return committed.data.input;
  };
  const cropSourceInput = await uploadInput("source");
  const imageOps = await fetchJson(`${baseUrl}/api/ops/image-execution`);
  assert.equal(imageOps.response.status, 200, JSON.stringify(imageOps.data));
  const pausedImages = await fetchJson(`${baseUrl}/api/ops/image-execution/control`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-control",
    },
    body: JSON.stringify({
      acceptNewTasks: false,
      expectedRevision: imageOps.data.settings.revision,
    }),
  });
  assert.equal(pausedImages.response.status, 200, JSON.stringify(pausedImages.data));
  const providerCallsBeforeCrop = providerRequests.length;
  const cropStarted = await fetchJson(jobsUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      expectedVersion: session.version,
      editorStateId,
      inputs: { sourceInputIds: [cropSourceInput.id] },
      request: {
        operation: "crop",
        sourceSize: { width: 1_028, height: 1_024 },
        sourceCrop: { top: 0, right: 0, bottom: 0, left: 4 },
        outputFormat: "png",
        n: 1,
      },
    }),
  });
  assert.equal(cropStarted.response.status, 202, JSON.stringify(cropStarted.data));
  const cropJob = await waitForJob(
    fetchJson,
    `${jobsUrl}/${encodeURIComponent(cropStarted.data.job.id)}`,
    editorInstanceId,
  );
  assert.equal(cropJob.status, "succeeded");
  assert.equal(cropJob.result.provider, "wfl-local");
  assert.equal(cropJob.result.operation, "crop");
  assert.equal(cropJob.result.sourceConsumed, true);
  assert.equal(cropJob.result.inputImageTokens, 0);
  assert.deepEqual(cropJob.result.requested, {
    operation: "crop",
    sourceSize: "1028x1024",
    requestedCanvas: "1024x1024",
    outputFormat: "png",
    sourceConsumed: true,
    postprocess: ["crop:0,0,0,4"],
  });
  assert.equal(cropJob.candidate.files[0].width, 1_024);
  assert.equal(cropJob.candidate.files[0].height, 1_024);
  assert.equal(providerRequests.length, providerCallsBeforeCrop);
  const cropDestination = "maps/generated/local-crop.png";
  const cropPublished = await fetchJson(
    `${jobsUrl}/${encodeURIComponent(cropStarted.data.job.id)}/publish`,
    {
      method: "POST",
      headers: publishHeaders,
      body: JSON.stringify({
        confirmation: cropStarted.data.job.id,
        mapVersion: session.version,
        destinations: [{ index: 0, path: cropDestination }],
      }),
    },
  );
  assert.equal(cropPublished.response.status, 201, JSON.stringify(cropPublished.data));
  assert.equal(cropPublished.data.job.publication.provenance.provider, "wfl-local");
  assert.deepEqual(await fs.readFile(path.join(defaultProject, cropDestination)), candidatePng);
  const resumedImages = await fetchJson(`${baseUrl}/api/ops/image-execution/control`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "ops-image-execution-control",
    },
    body: JSON.stringify({
      acceptNewTasks: true,
      expectedRevision: pausedImages.data.settings.revision,
    }),
  });
  assert.equal(resumedImages.response.status, 200, JSON.stringify(resumedImages.data));
  await eventually(async () => {
    const deleted = await fetchJson(
      `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-inputs/${encodeURIComponent(cropSourceInput.id)}`,
      {
        method: "DELETE",
        headers: {
          Origin: baseUrl,
          "X-Codex-Desktop-Action": "map-image-input-delete",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
          "X-Codex-Desktop-Editor-State": String(editorStateId),
        },
      },
    );
    return deleted.response.status === 200;
  });

  const sourceInput = await uploadInput("source");
  const maskInput = await uploadInput("mask");
  const editStarted = await fetchJson(jobsUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      expectedVersion: session.version,
      editorStateId,
      inputs: { sourceInputIds: [sourceInput.id], maskInputId: maskInput.id },
      request: {
        operation: "edit",
        prompt: "repair the selected map texture",
        maskMode: "strict",
        maskFeather: 0,
        size: "1024x1024",
        quality: "auto",
        outputFormat: "png",
        background: "auto",
        moderation: "auto",
        n: 1,
      },
    }),
  });
  assert.equal(editStarted.response.status, 202, JSON.stringify(editStarted.data));
  const editJob = await waitForJob(
    fetchJson,
    `${jobsUrl}/${encodeURIComponent(editStarted.data.job.id)}`,
    editorInstanceId,
  );
  assert.equal(editJob.status, "succeeded");
  assert.equal(editJob.result.operation, "edit");
  assert.equal(editJob.result.sourceConsumed, true);
  const editProviderRequest = providerRequests.find((entry) => entry.path === "/v1/images/edits");
  assert.ok(editProviderRequest, "expected an edit provider request");
  assert.match(editProviderRequest.contentType, /^multipart\/form-data;/u);
  assert.ok(editProviderRequest.body.includes(candidatePng));
  await eventually(async () => {
    const deleted = await fetchJson(
      `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-inputs/${encodeURIComponent(sourceInput.id)}`,
      {
        method: "DELETE",
        headers: {
          Origin: baseUrl,
          "X-Codex-Desktop-Action": "map-image-input-delete",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
          "X-Codex-Desktop-Editor-State": String(editorStateId),
        },
      },
    );
    return deleted.response.status === 200;
  });

  // Outpaint receives one temporary source, expands every side, pads only the
  // provider canvas to its supported dimension multiple, and restores the
  // published candidate to the exact logical canvas requested by the editor.
  const unsafeCrop = await fetchJson(jobsUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      expectedVersion: session.version,
      editorStateId,
      request: {
        operation: "outpaint",
        prompt: "do not accept crop metadata without a window-local preprocessed input",
        sourcePaths: ["images/terrain.png"],
        sourceCrop: { left: 4 },
        outpaint: { right: 8 },
        alignmentPolicy: "reject",
        quality: "auto",
        outputFormat: "png",
        background: "auto",
        moderation: "auto",
        n: 1,
      },
    }),
  });
  assert.equal(unsafeCrop.response.status, 400);
  assert.match(unsafeCrop.data.error, /裁剪预处理只允许/u);

  const outpaintSourceInput = await uploadInput("source");
  const expansion = { top: 11, right: 13, bottom: 17, left: 7 };
  const selectionTarget = structuredClone(createMapSelectionImageTarget({
    document: mapDocument,
    layerId: 1,
    selection: { x: 0, y: 0, width: 64, height: 64 },
    mapVersion: session.version,
    editorStateId,
    purpose: "layer-image",
    expansion: { unit: "world", ...expansion },
    preserveSource: "seamless",
  }));
  selectionTarget.policies.alignmentPolicy = "pad-and-crop";
  selectionTarget.policies.blendMargin = 16;
  const outpaintStarted = await fetchJson(jobsUrl, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      expectedVersion: session.version,
      editorStateId,
      inputs: { sourceInputIds: [outpaintSourceInput.id] },
      selectionTarget,
      request: {
        operation: "outpaint",
        prompt: "extend the selected map texture on all four sides",
        outpaint: expansion,
        preserveSource: "seamless",
        blendMargin: 16,
        alignmentPolicy: "pad-and-crop",
        quality: "auto",
        outputFormat: "png",
        background: "auto",
        moderation: "auto",
        n: 1,
      },
    }),
  });
  assert.equal(outpaintStarted.response.status, 202, JSON.stringify(outpaintStarted.data));
  let outpaintJob;
  try {
    outpaintJob = await waitForJob(
      fetchJson,
      `${jobsUrl}/${encodeURIComponent(outpaintStarted.data.job.id)}`,
      editorInstanceId,
    );
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${childOutput}`, { cause: error });
  }
  assert.equal(outpaintJob.status, "succeeded");
  assert.equal(outpaintJob.selectionTarget.schema, "wfl.map-selection-image-target.v1");
  assert.deepEqual(outpaintJob.selectionTarget.target.world, selectionTarget.target.world);
  assert.deepEqual(outpaintJob.selectionTarget.policies, {
    maskMode: "strict",
    preserveSource: "seamless",
    alignmentPolicy: "pad-and-crop",
    blendMargin: 16,
  });
  assert.equal(outpaintJob.candidate.files[0].mediaType, "image/png");
  assert.equal(outpaintJob.candidate.files[0].width, 1_044);
  assert.equal(outpaintJob.candidate.files[0].height, 1_052);
  assert.equal(outpaintJob.result.operation, "outpaint");
  assert.equal(outpaintJob.result.sourceConsumed, true);
  assert.deepEqual(outpaintJob.result.requested, {
    operation: "outpaint",
    model: "gpt-image-2-map-http-test",
    providerProfileRevision: outpaintJob.result.requested.providerProfileRevision,
    configurationRevision: outpaintJob.result.requested.configurationRevision,
    n: 1,
    size: "1044x1052",
    providerSize: "1056x1056",
    sourceSize: "1024x1024",
    requestedCanvas: "1044x1052",
    quality: "auto",
    outputFormat: "png",
    background: "auto",
    moderation: "auto",
    preserveSource: "seamless",
    alignmentPolicy: "pad-and-crop",
    outputCompression: 100,
    partialImages: 0,
    maskFeather: 0,
    blendMargin: 16,
    stream: false,
    sourceConsumed: true,
    postprocess: ["pad-right:12", "pad-bottom:4", "crop-provider:0,0,1044,1052"],
  });
  const outpaintProviderRequest = providerRequests.find((entry) => (
    entry.path === "/v1/images/edits"
    && entry.multipart?.prompt === "extend the selected map texture on all four sides"
  ));
  assert.ok(outpaintProviderRequest, "expected an outpaint provider request");
  assert.equal(outpaintProviderRequest.multipart.size, "1056x1056");
  assert.match(outpaintProviderRequest.contentType, /^multipart\/form-data;/u);
  const providerCanvas = multipartFile(
    outpaintProviderRequest.body,
    outpaintProviderRequest.contentType,
    "image[]",
  ) || multipartFile(outpaintProviderRequest.body, outpaintProviderRequest.contentType, "image");
  const providerMask = multipartFile(
    outpaintProviderRequest.body,
    outpaintProviderRequest.contentType,
    "mask",
  );
  assert.ok(providerCanvas, "expected the staged outpaint canvas");
  assert.ok(providerMask, "expected the generated outpaint mask");
  assert.deepEqual(
    await sharp(providerCanvas).metadata().then(({ format, width, height }) => ({ format, width, height })),
    { format: "png", width: 1_056, height: 1_056 },
  );
  assert.deepEqual(
    await sharp(providerMask).metadata().then(({ format, width, height }) => ({ format, width, height })),
    { format: "png", width: 1_056, height: 1_056 },
  );
  const stagedSourcePixel = await sharp(providerCanvas)
    .extract({ left: expansion.left + 512, top: expansion.top + 512, width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.deepEqual([...stagedSourcePixel], [67, 138, 82, 255]);
  const publicOutpaintJob = JSON.stringify(outpaintJob);
  assert.doesNotMatch(publicOutpaintJob, /attachment|map-image-candidates|image-execution|\/tmp\//u);
  assert.doesNotMatch(publicOutpaintJob, new RegExp(escapeRegExp(defaultProject), "u"));
  await eventually(async () => {
    const deleted = await fetchJson(
      `${baseUrl}/api/maps/sessions/${encodeURIComponent(session.id)}/image-inputs/${encodeURIComponent(outpaintSourceInput.id)}`,
      {
        method: "DELETE",
        headers: {
          Origin: baseUrl,
          "X-Codex-Desktop-Action": "map-image-input-delete",
          "X-Codex-Desktop-Editor-Instance": editorInstanceId,
          "X-Codex-Desktop-Editor-State": String(editorStateId),
        },
      },
    );
    return deleted.response.status === 200;
  });
});

async function waitForJob(fetchJson, url, editorInstanceId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await fetchJson(url, {
      headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
    });
    assert.equal(current.response.status, 200, JSON.stringify(current.data));
    if (["succeeded", "published"].includes(current.data.job.status)) return current.data.job;
    if (["failed", "canceled", "expired"].includes(current.data.job.status)) {
      throw new Error(`Map image job failed: ${JSON.stringify(current.data.job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for map image job");
}

async function eventually(fn, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

function waitForServer(processHandle, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start within 8s: ${output}`)), 8_000);
    processHandle.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      resolve();
    });
    processHandle.stderr.on("data", (chunk) => { output += chunk; });
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${output}`));
    });
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function multipartTextField(body, name) {
  const text = body.toString("latin1");
  const fieldOffset = text.indexOf(`name="${name}"`);
  if (fieldOffset < 0) return null;
  const valueOffset = text.indexOf("\r\n\r\n", fieldOffset);
  if (valueOffset < 0) return null;
  const valueEnd = text.indexOf("\r\n", valueOffset + 4);
  return valueEnd < 0 ? null : text.slice(valueOffset + 4, valueEnd);
}

function multipartFile(body, contentType, name) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/u.exec(String(contentType || ""));
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return null;
  const fieldOffset = body.indexOf(Buffer.from(`name="${name}"`, "utf8"));
  if (fieldOffset < 0) return null;
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), fieldOffset);
  if (headerEnd < 0) return null;
  const dataOffset = headerEnd + 4;
  const dataEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`, "utf8"), dataOffset);
  return dataEnd < 0 ? null : body.subarray(dataOffset, dataEnd);
}
