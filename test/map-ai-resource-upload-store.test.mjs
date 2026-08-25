import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapAiResourceUploadStore } from "../lib/map-ai-resource-upload-store.mjs";

const identity = { userId: "u", browserSessionId: "browser", editorInstanceId: "editor-12345678" };
const mapContext = { mapSessionId: "map-session", projectPath: "/srv/game", version: "a".repeat(64) };
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("chunked resource upload finalizes only after size/hash and validator checks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("{\"type\":\"map\",\"layers\":[]}");
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 4, authorizeSession: async () => {} }).initialize();
  const upload = await store.create({ identity, mapContext, editorStateId: 2, relativePath: "maps/main.tmj", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  for (let index = 0; index < upload.chunkCount; index += 1) {
    const chunk = bytes.subarray(index * upload.chunkBytes, Math.min(bytes.length, (index + 1) * upload.chunkBytes));
    await store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 2, threadId: "thread-1", index, source: chunk, contentLength: chunk.length, chunkHash: hash(chunk) });
  }
  const finalized = await store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 2, threadId: "thread-1", validate: async ({ path: candidatePath }) => assert.deepEqual(await fs.readFile(candidatePath), bytes) });
  assert.equal(finalized.status, "finalized");
  const source = await store.openSource({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 2, threadId: "thread-1" });
  assert.deepEqual(await fs.readFile(source.sourcePath), bytes);
  assert.equal(Object.hasOwn(source, "sourcePath"), true);
  assert.throws(() => store.snapshot({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 2, threadId: "wrong" }), (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH");
});

test("resource upload rejects out-of-order or mismatched chunks and never exposes a path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("abcdef");
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 4 }).initialize();
  const upload = await store.create({ identity, mapContext, relativePath: "images/a.png", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  await assert.rejects(store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 1, source: bytes.subarray(0, 4), contentLength: 4, chunkHash: hash(bytes.subarray(0, 4)) }), (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_CHUNK_ORDER");
  await assert.rejects(store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes.subarray(0, 4), contentLength: 4, chunkHash: hash(Buffer.from("xxxx")) }), (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_CHUNK_HASH");
  assert.equal(Object.hasOwn(upload, "filePath"), false);
  await assert.rejects(
    store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, index: 0, source: bytes.subarray(0, 4), contentLength: 4, chunkHash: hash(bytes.subarray(0, 4)) }),
    (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_THREAD_INVALID",
  );
  assert.throws(
    () => store.snapshot({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0 }),
    (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_THREAD_INVALID",
  );
});

test("cleanup requested while a chunk is active waits for the write to finish", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-busy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("abcdef");
  let releaseSource;
  let sourceEntered;
  const sourcePaused = new Promise((resolve) => { releaseSource = resolve; });
  const entered = new Promise((resolve) => { sourceEntered = resolve; });
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 6 }).initialize();
  const upload = await store.create({ identity, mapContext, relativePath: "images/a.png", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  const appending = store.append({
    uploadId: upload.uploadId,
    identity,
    mapSessionId: mapContext.mapSessionId,
    mapVersion: mapContext.version,
    editorStateId: 0,
    threadId: "thread-1",
    index: 0,
    source: (async function* () { sourceEntered(); yield bytes.subarray(0, 3); await sourcePaused; yield bytes.subarray(3); })(),
    contentLength: bytes.length,
    chunkHash: hash(bytes),
  });
  await entered;
  await store.delete({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  assert.equal(store.status().uploads, 1);
  releaseSource();
  await assert.doesNotReject(appending);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.status().uploads, 0);
});

test("candidate source lease keeps the staged payload until registration releases it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-lease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("{" + "\"type\":\"map\"" + "}");
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 64 }).initialize();
  const upload = await store.create({ identity, mapContext, relativePath: "maps/a.tmj", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  await store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes, contentLength: bytes.length, chunkHash: hash(bytes) });
  await store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  const source = await store.openSource({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  await store.releaseAfterCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1" });
  assert.equal(store.status().uploads, 1);
  assert.deepEqual(await fs.readFile(source.sourcePath), bytes);
  await source.release();
  assert.equal(store.status().uploads, 0);
});

test("source lease is acquired before asynchronous re-authorization", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-auth-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("auth-race");
  let allowAuthorization;
  const authorizationPaused = new Promise((resolve) => { allowAuthorization = resolve; });
  const store = await new MapAiResourceUploadStore({
    temporaryRoot: path.join(root, "uploads"),
    chunkBytes: 64,
    authorizeSession: async ({ purpose }) => { if (purpose === "resource-upload-source") await authorizationPaused; },
  }).initialize();
  const upload = await store.create({ identity, mapContext, relativePath: "maps/auth-race.tmj", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  await store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes, contentLength: bytes.length, chunkHash: hash(bytes) });
  await store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  const opening = store.openSource({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  while (store.status().uploads !== 1 || store.uploads.get(upload.uploadId)?.leases !== 1) await new Promise((resolve) => setImmediate(resolve));
  await store.deleteForUser({ userId: identity.userId });
  assert.equal(store.status().uploads, 1);
  allowAuthorization();
  const source = await opening;
  assert.deepEqual(await fs.readFile(source.sourcePath), bytes);
  await source.release();
  assert.equal(store.status().uploads, 0);
});

test("validator failure leaves an upload retryable and never registers a candidate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("retryable");
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 64 }).initialize();
  const upload = await store.create({ identity, mapContext, relativePath: "maps/retry.tmj", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  await store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes, contentLength: bytes.length, chunkHash: hash(bytes) });
  await assert.rejects(
    store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", validate: async () => { throw new Error("invalid tiled document"); } }),
    /invalid tiled document/u,
  );
  assert.equal(store.snapshot({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" }).status, "uploading");
  const finalized = await store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  assert.equal(finalized.status, "finalized");
});

test("commit receipt survives staging cleanup and is scoped to the same editor context", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-receipt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("receipt");
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 64 }).initialize();
  const upload = await store.create({ identity, mapContext, relativePath: "maps/receipt.tmj", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  await store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes, contentLength: bytes.length, chunkHash: hash(bytes) });
  await store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  const candidate = { candidateId: "opaque-candidate", path: "maps/receipt.tmj", baseVersion: null, size: bytes.length, sha256: hash(bytes) };
  const committed = await store.commitCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, candidate });
  assert.equal(committed.idempotent, false);
  const retry = store.committedCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, projectPath: mapContext.projectPath });
  assert.equal(retry.idempotent, true);
  assert.deepEqual(retry.candidate, candidate);
  assert.equal(store.status().uploads, 0);
  assert.throws(() => store.committedCandidate({ uploadId: upload.uploadId, identity, threadId: "other-thread", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, projectPath: mapContext.projectPath }), (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_SCOPE_MISMATCH");
});

test("candidate receipt rejects destination, version, size, and hash mismatches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-candidate-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("candidate-scope");
  const store = await new MapAiResourceUploadStore({ temporaryRoot: path.join(root, "uploads"), chunkBytes: 64 }).initialize();
  const baseVersion = "b".repeat(64);
  const upload = await store.create({
    identity, mapContext, relativePath: "maps/scope.tmj", baseVersion,
    totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1",
  });
  await store.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes, contentLength: bytes.length, chunkHash: hash(bytes) });
  await store.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });

  const candidate = { candidateId: "opaque-scope-candidate", path: "maps/scope.tmj", baseVersion, size: bytes.length, sha256: hash(bytes) };
  const mismatches = [
    { path: "maps/other.tmj" },
    { baseVersion: "c".repeat(64) },
    { size: bytes.length + 1 },
    { sha256: hash(Buffer.from("different")) },
  ];
  for (const change of mismatches) {
    await assert.rejects(
      store.commitCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, candidate: { ...candidate, ...change } }),
      (error) => error.code === "MAP_AI_RESOURCE_UPLOAD_CANDIDATE_SCOPE_MISMATCH",
    );
    assert.equal(store.status().uploads, 1);
  }
  const committed = await store.commitCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, candidate });
  assert.equal(committed.committed, true);
  assert.equal(committed.idempotent, false);
});

test("commit receipt is restored after an upload-store restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-upload-restart-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("restart-receipt");
  const options = { temporaryRoot: path.join(root, "uploads"), chunkBytes: 64 };
  const first = await new MapAiResourceUploadStore(options).initialize();
  const upload = await first.create({ identity, mapContext, relativePath: "maps/restart.tmj", baseVersion: null, totalBytes: bytes.length, totalHash: hash(bytes), threadId: "thread-1" });
  await first.append({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1", index: 0, source: bytes, contentLength: bytes.length, chunkHash: hash(bytes) });
  await first.finalize({ uploadId: upload.uploadId, identity, mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, threadId: "thread-1" });
  const candidate = { candidateId: "opaque-restart-candidate", path: "maps/restart.tmj", baseVersion: null, size: bytes.length, sha256: hash(bytes) };
  await first.commitCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, candidate });
  await first.close();
  const second = await new MapAiResourceUploadStore(options).initialize();
  const restored = second.committedCandidate({ uploadId: upload.uploadId, identity, threadId: "thread-1", mapSessionId: mapContext.mapSessionId, mapVersion: mapContext.version, editorStateId: 0, projectPath: mapContext.projectPath });
  assert.equal(restored.idempotent, true);
  assert.deepEqual(restored.candidate, candidate);
  await second.close();
});
