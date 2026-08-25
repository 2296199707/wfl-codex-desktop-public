import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapAiResourceCandidateStore } from "../lib/map-ai-resource-candidate-store.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("resource candidates are opaque, hash-bound, leased, and capacity-bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const source = path.join(sourceRoot, "terrain.png");
  await fs.mkdir(sourceRoot, { recursive: true });
  const bytes = Buffer.from("candidate-image");
  await fs.writeFile(source, bytes);
  const store = await new MapAiResourceCandidateStore({
    temporaryRoot: path.join(root, "private"),
    sourceRoots: [sourceRoot],
    maxBytes: bytes.length,
    maxCandidateBytes: bytes.length,
  }).initialize();
  const candidate = await store.register({
    userId: "user-1", projectPath: path.join(root, "game"), threadId: "thread-1",
    relativePath: "tiles/terrain.png", baseVersion: null, sourcePath: source,
  });
  assert.equal(candidate.baseVersion, null);
  assert.equal(candidate.sha256, hash(bytes));
  assert.equal(Object.hasOwn(candidate, "candidatePath"), false);
  const resolved = await store.resolve({
    candidateId: candidate.candidateId, userId: "user-1", projectPath: path.join(root, "game"),
    threadId: "thread-1", relativePath: "tiles/terrain.png", baseVersion: null,
  });
  assert.deepEqual(await fs.readFile(resolved.candidatePath), bytes);
  await store.remove(candidate.candidateId);
  assert.equal(await fs.access(resolved.candidatePath).then(() => true, () => false), true);
  await resolved.release();
  assert.equal(await fs.access(resolved.candidatePath).then(() => true, () => false), false);
  assert.deepEqual(store.status(), { candidates: 0, bytes: 0 });
});

test("candidate registration rejects a source outside configured roots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "outside.png");
  await fs.writeFile(source, "x");
  const store = await new MapAiResourceCandidateStore({
    temporaryRoot: path.join(root, "private"),
    sourceRoots: [path.join(root, "allowed")],
  }).initialize();
  await assert.rejects(
    store.register({ userId: "u", projectPath: path.join(root, "game"), threadId: "t", relativePath: "a.png", baseVersion: null, sourcePath: source }),
    (error) => error.code === "MAP_AI_RESOURCE_CANDIDATE_SOURCE_OUTSIDE_ROOT",
  );
});

test("resolve closes the TTL cleanup race before returning a leased path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidates-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const source = path.join(sourceRoot, "map.tmj");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(source, "{\"type\":\"map\"}");
  let releaseInspection;
  const inspectionPaused = new Promise((resolve) => { releaseInspection = resolve; });
  let enteredInspection;
  const inspectionEntered = new Promise((resolve) => { enteredInspection = resolve; });
  const store = await new MapAiResourceCandidateStore({
    temporaryRoot: path.join(root, "private"),
    sourceRoots: [sourceRoot],
    now: () => 10_000,
    ttlMs: 60_000,
  }).initialize();
  const candidate = await store.register({
    userId: "u", projectPath: path.join(root, "game"), threadId: "thread",
    relativePath: "maps/map.tmj", baseVersion: null, sourcePath: source,
  });
  const original = store.inspectStored.bind(store);
  store.inspectStored = async (...args) => {
    enteredInspection();
    await inspectionPaused;
    return original(...args);
  };
  const resolving = store.resolve({
    candidateId: candidate.candidateId, userId: "u", projectPath: path.join(root, "game"),
    threadId: "thread", relativePath: "maps/map.tmj", baseVersion: null,
  });
  await inspectionEntered;
  await store.remove(candidate.candidateId);
  releaseInspection();
  await assert.rejects(resolving, (error) => error.code === "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND");
});

test("registration idempotency survives candidate-store restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidates-restart-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const source = path.join(sourceRoot, "map.tmj");
  await fs.mkdir(sourceRoot, { recursive: true });
  const bytes = Buffer.from('{"type":"map"}');
  await fs.writeFile(source, bytes);
  const options = { temporaryRoot: path.join(root, "private"), sourceRoots: [sourceRoot], maxBytes: bytes.length, maxCandidateBytes: bytes.length };
  const first = await new MapAiResourceCandidateStore(options).initialize();
  const created = await first.register({ userId: "u", projectPath: path.join(root, "game"), threadId: "thread", relativePath: "maps/retry.tmj", baseVersion: null, sourcePath: source, idempotencyKey: "upload-1", size: bytes.length, sha256: hash(bytes) });
  const second = await new MapAiResourceCandidateStore(options).initialize();
  const retried = await second.register({ userId: "u", projectPath: path.join(root, "game"), threadId: "thread", relativePath: "maps/retry.tmj", baseVersion: null, sourcePath: source, idempotencyKey: "upload-1", size: bytes.length, sha256: hash(bytes) });
  assert.equal(retried.candidateId, created.candidateId);
  assert.equal(second.status().candidates, 1);
  await first.close();
  await second.close();
});

test("a tampered persisted candidate is rejected and removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidates-tamper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const source = path.join(sourceRoot, "map.tmj");
  await fs.mkdir(sourceRoot, { recursive: true });
  const bytes = Buffer.from('{"type":"map"}');
  await fs.writeFile(source, bytes);
  const store = await new MapAiResourceCandidateStore({ temporaryRoot: path.join(root, "private"), sourceRoots: [sourceRoot] }).initialize();
  const candidate = await store.register({ userId: "u", projectPath: path.join(root, "game"), threadId: "thread", relativePath: "maps/tamper.tmj", baseVersion: null, sourcePath: source });
  const resolved = await store.resolve({ candidateId: candidate.candidateId, userId: "u", projectPath: path.join(root, "game"), threadId: "thread", relativePath: "maps/tamper.tmj", baseVersion: null });
  await fs.writeFile(resolved.candidatePath, "tampered");
  await resolved.release();
  await assert.rejects(
    store.resolve({ candidateId: candidate.candidateId, userId: "u", projectPath: path.join(root, "game"), threadId: "thread", relativePath: "maps/tamper.tmj", baseVersion: null }),
    (error) => error.code === "MAP_AI_RESOURCE_CANDIDATE_CHANGED",
  );
  assert.equal(store.status().candidates, 0);
});

test("expired registration receipts are not returned as valid candidates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidates-expiry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const source = path.join(sourceRoot, "map.tmj");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(source, "{\"type\":\"map\"}");
  let now = 10_000;
  const store = await new MapAiResourceCandidateStore({
    temporaryRoot: path.join(root, "private"),
    sourceRoots: [sourceRoot],
    now: () => now,
    ttlMs: 1_000,
  }).initialize();
  const candidate = await store.register({
    userId: "u", projectPath: path.join(root, "game"), threadId: "thread",
    relativePath: "maps/expired.tmj", baseVersion: null, sourcePath: source,
    idempotencyKey: "expired-operation",
  });
  now += 1_001;
  assert.equal(store.lookupRegistration({
    userId: "u", projectPath: path.join(root, "game"), threadId: "thread",
    idempotencyKey: "expired-operation",
  }), null);
  assert.equal(store.findRegistration({
    userId: "u", projectPath: path.join(root, "game"), threadId: "thread",
    idempotencyKey: "expired-operation",
  }), null);
  await assert.rejects(
    store.resolve({
      candidateId: candidate.candidateId, userId: "u", projectPath: path.join(root, "game"),
      threadId: "thread", relativePath: "maps/expired.tmj", baseVersion: null,
    }),
    (error) => error.code === "MAP_AI_RESOURCE_CANDIDATE_NOT_FOUND",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.status().candidates, 0);
});
