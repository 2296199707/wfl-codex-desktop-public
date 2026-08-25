import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectMapFile } from "../lib/map-file-sessions.mjs";
import {
  inspectTiledWorldInChild,
  MapSaveSessionStore,
} from "../lib/map-save-sessions.mjs";

const identity = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-session-1",
  editorInstanceId: "editor-window-0001",
});

test("uploads chunks out of order, accepts identical retries, and atomically commits", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ chunkBytes: 31 });
    const content = mapBytes({ note: "地图🙂".repeat(30), unknownRoot: { keep: true } });
    const save = await beginSave(store, fixture, content, "save-operation-0001");
    const chunks = splitChunks(content, save.config.chunkBytes);
    for (const index of [...chunks.keys()].reverse()) {
      const uploaded = await upload(store, save, index, chunks[index]);
      assert.equal(uploaded.index, index);
    }
    const duplicate = await upload(store, save, 0, chunks[0]);
    assert.equal(duplicate.idempotent, true);
    let authorizations = 0;
    const result = await store.commit({
      saveId: save.id,
      identity,
      authorize: async () => { authorizations += 1; },
    });
    assert.equal(authorizations, 2);
    assert.equal(result.version, sha256(content));
    assert.deepEqual(await fs.readFile(fixture.targetPath), content);
    assert.equal((await fs.stat(fixture.targetPath)).mode & 0o777, 0o640);
    assert.equal((await store.commit({ saveId: save.id, identity })).version, result.version);
    assert.equal((await fs.readdir(fixture.temporaryRoot)).length, 0);
  });
});

test("atomically saves a multi-megabyte map beyond the ordinary write limit", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ chunkBytes: 256 * 1024 });
    const content = mapBytes({ note: "large-map-data".repeat(350_000) });
    assert.ok(content.length > 4 * 1024 * 1024);
    const save = await beginSave(store, fixture, content, "save-operation-large-map");
    const chunks = splitChunks(content, save.config.chunkBytes);
    assert.ok(chunks.length > 16);
    for (const [index, chunk] of chunks.entries()) await upload(store, save, index, chunk);
    const result = await store.commit({ saveId: save.id, identity });
    assert.equal(result.size, content.length);
    assert.equal(result.version, sha256(content));
    assert.deepEqual(await fs.readFile(fixture.targetPath), content);
  });
});

test("prepares a validated chunked candidate for a later project transaction without replacing the map", async () => {
  await withSaveFixture(async (fixture) => {
    const content = mapBytes({ note: "prepared candidate" });
    const store = fixture.store({ chunkBytes: 29 });
    const save = await beginSave(store, fixture, content, "save-operation-prepare-candidate");
    for (const [index, chunk] of splitChunks(content, save.config.chunkBytes).entries()) {
      await upload(store, save, index, chunk);
    }
    const sourceBefore = await fs.readFile(fixture.targetPath);
    const candidate = await store.prepareCandidate({
      saveId: save.id,
      identity,
      documentKind: "map",
    });
    assert.equal(candidate.size, content.length);
    assert.equal(candidate.sha256, sha256(content));
    assert.equal(candidate.relativePath, "maps/world.tmj");
    assert.deepEqual(await fs.readFile(fixture.targetPath), sourceBefore);
    assert.deepEqual(await fs.readFile(candidate.candidatePath), content);
    await store.abort({ saveId: save.id, identity, documentKind: "map" });
    assert.equal(await fs.access(candidate.candidatePath).then(() => true, () => false), false);
  });
});

test("rejects missing chunks and hash mismatches without changing the source map", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ chunkBytes: 29 });
    const original = await fs.readFile(fixture.targetPath);
    const content = mapBytes({ note: "replacement".repeat(20) });

    const missing = await beginSave(store, fixture, content, "save-operation-missing");
    const chunks = splitChunks(content, missing.config.chunkBytes);
    for (let index = 0; index < chunks.length - 1; index += 1) await upload(store, missing, index, chunks[index]);
    await assert.rejects(
      store.commit({ saveId: missing.id, identity }),
      (error) => error.statusCode === 409 && error.code === "map-save-chunks-missing",
    );
    assert.deepEqual(await fs.readFile(fixture.targetPath), original);

    const badChunk = await beginSave(store, fixture, content, "save-operation-bad-chunk");
    await assert.rejects(
      store.uploadChunk({
        saveId: badChunk.id,
        identity,
        index: 0,
        source: splitChunks(content, badChunk.config.chunkBytes)[0],
        chunkHash: "0".repeat(64),
      }),
      (error) => error.statusCode === 422 && error.code === "map-save-chunk-hash",
    );

    const wrongTotal = await store.begin({
      identity,
      mapContext: fixture.context,
      expectedVersion: fixture.context.version,
      totalBytes: content.length,
      totalHash: "f".repeat(64),
      clientOperationId: "save-operation-bad-total",
    });
    for (const [index, chunk] of splitChunks(content, wrongTotal.config.chunkBytes).entries()) {
      await upload(store, wrongTotal, index, chunk);
    }
    await assert.rejects(
      store.commit({ saveId: wrongTotal.id, identity }),
      (error) => error.statusCode === 422 && error.code === "map-save-total-hash",
    );
    assert.deepEqual(await fs.readFile(fixture.targetPath), original);
  });
});

test("isolates UTF-8 and Tiled validation failures from the source file", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ chunkBytes: 17 });
    const original = await fs.readFile(fixture.targetPath);
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
    const utf8Save = await beginSave(store, fixture, invalidUtf8, "save-operation-utf8");
    for (const [index, chunk] of splitChunks(invalidUtf8, utf8Save.config.chunkBytes).entries()) {
      await upload(store, utf8Save, index, chunk);
    }
    await assert.rejects(
      store.commit({ saveId: utf8Save.id, identity }),
      (error) => error.statusCode === 415 && error.code === "invalid-map-utf8",
    );

    const invalidTiled = Buffer.from('{"type":"map","layers":[]}\n');
    const tiledSave = await beginSave(store, fixture, invalidTiled, "save-operation-tiled");
    for (const [index, chunk] of splitChunks(invalidTiled, tiledSave.config.chunkBytes).entries()) {
      await upload(store, tiledSave, index, chunk);
    }
    await assert.rejects(
      store.commit({ saveId: tiledSave.id, identity }),
      (error) => error.statusCode === 422 && error.code === "map-validation-failed",
    );
    assert.deepEqual(await fs.readFile(fixture.targetPath), original);
  });
});

test("returns a conflict when the target changes after upload", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ chunkBytes: 23 });
    const content = mapBytes({ note: "our edit" });
    const save = await beginSave(store, fixture, content, "save-operation-conflict");
    for (const [index, chunk] of splitChunks(content, save.config.chunkBytes).entries()) {
      await upload(store, save, index, chunk);
    }
    const external = mapBytes({ note: "external edit" });
    await fs.writeFile(fixture.targetPath, external);
    await assert.rejects(
      store.commit({ saveId: save.id, identity }),
      (error) => error.statusCode === 409 && error.code === "map-version-conflict",
    );
    assert.deepEqual(await fs.readFile(fixture.targetPath), external);
  });
});

test("binds saves to one identity and keeps client operation IDs idempotent", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store();
    const content = mapBytes({ note: "identity" });
    const save = await beginSave(store, fixture, content, "save-operation-identity");
    const duplicate = await beginSave(store, fixture, content, "save-operation-identity");
    assert.equal(duplicate.id, save.id);
    await assert.rejects(
      store.uploadChunk({
        saveId: save.id,
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
        index: 0,
        source: content,
        chunkHash: sha256(content),
      }),
      (error) => error.statusCode === 404 && error.code === "map-save-session-not-found",
    );
    await assert.rejects(
      store.begin({
        identity,
        mapContext: fixture.context,
        expectedVersion: fixture.context.version,
        totalBytes: content.length,
        totalHash: "a".repeat(64),
        clientOperationId: "save-operation-identity",
      }),
      (error) => error.statusCode === 409 && error.code === "map-save-operation-conflict",
    );
  });
});

test("serializes concurrent begin requests for idempotency and capacity", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ maxSessions: 1, maxSessionsPerBrowser: 1 });
    const content = mapBytes({ note: "concurrent begin" });
    const request = {
      identity,
      mapContext: fixture.context,
      expectedVersion: fixture.context.version,
      totalBytes: content.length,
      totalHash: sha256(content),
      clientOperationId: "save-concurrent-begin-0001",
    };
    const [first, retry] = await Promise.all([store.begin(request), store.begin(request)]);
    assert.equal(retry.id, first.id);
    assert.equal(store.sessions.size, 1);

    await assert.rejects(
      store.begin({
        ...request,
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
        clientOperationId: "save-concurrent-begin-0002",
      }),
      (error) => error.statusCode === 429 && error.code === "map-save-session-capacity",
    );
  });
});

test("evicts completed idempotency records before rejecting a new save at capacity", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ maxSessions: 1, maxSessionsPerBrowser: 1 });
    const firstContent = mapBytes({ note: "first completed save" });
    const first = await beginSave(store, fixture, firstContent, "save-capacity-completed-0001");
    for (const [index, chunk] of splitChunks(firstContent, first.config.chunkBytes).entries()) {
      await upload(store, first, index, chunk);
    }
    await store.commit({ saveId: first.id, identity });
    assert.equal((await store.commit({ saveId: first.id, identity })).version, sha256(firstContent));

    const current = await inspectMapFile(fixture.targetPath);
    const secondContent = mapBytes({ note: "second save after completed record" });
    const second = await store.begin({
      identity,
      mapContext: { ...fixture.context, version: current.version },
      expectedVersion: current.version,
      totalBytes: secondContent.length,
      totalHash: sha256(secondContent),
      clientOperationId: "save-capacity-completed-0002",
    });
    assert.notEqual(second.id, first.id);
    assert.equal(store.sessions.size, 1);
    assert.throws(
      () => store.snapshot({ saveId: first.id, identity }),
      (error) => error.statusCode === 404 && error.code === "map-save-session-not-found",
    );
  });
});

test("queues commits at the fixed manual concurrency limit", async () => {
  await withSaveFixture(async (fixture) => {
    const secondPath = path.join(path.dirname(fixture.targetPath), "second.tmj");
    await fs.writeFile(secondPath, mapBytes({ note: "second source" }), { mode: 0o640 });
    const secondInspected = await inspectMapFile(secondPath);
    const entered = [];
    const releases = [];
    const store = fixture.store({
      chunkBytes: 64,
      commitConcurrency: 1,
      validateCandidate: async () => {
        entered.push(entered.length + 1);
        await new Promise((resolve) => releases.push(resolve));
        return { diagnostics: [], references: [] };
      },
    });
    const firstContent = mapBytes({ note: "first target" });
    const secondContent = mapBytes({ note: "second target" });
    const first = await beginSave(store, fixture, firstContent, "save-operation-queue-1");
    const secondFixture = {
      ...fixture,
      targetPath: secondPath,
      context: {
        ...fixture.context,
        mapSessionId: "map-session-0002",
        targetPath: secondPath,
        relativePath: "maps/second.tmj",
        version: secondInspected.version,
      },
    };
    const second = await beginSave(store, secondFixture, secondContent, "save-operation-queue-2");
    for (const [index, chunk] of splitChunks(firstContent, first.config.chunkBytes).entries()) await upload(store, first, index, chunk);
    for (const [index, chunk] of splitChunks(secondContent, second.config.chunkBytes).entries()) await upload(store, second, index, chunk);

    const firstCommit = store.commit({ saveId: first.id, identity });
    await waitFor(() => entered.length === 1);
    const secondCommit = store.commit({ saveId: second.id, identity });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(entered, [1]);
    assert.equal(store.status().commitQueued, 1);
    releases.shift()();
    await waitFor(() => entered.length === 2);
    releases.shift()();
    await Promise.all([firstCommit, secondCommit]);
    assert.deepEqual(await fs.readFile(fixture.targetPath), firstContent);
    assert.deepEqual(await fs.readFile(secondPath), secondContent);
  });
});

test("keeps per-session save parameters when later tasks use a new manual concurrency", async () => {
  await withSaveFixture(async (fixture) => {
    const secondPath = path.join(path.dirname(fixture.targetPath), "second-snapshot.tmj");
    await fs.writeFile(secondPath, mapBytes({ note: "second snapshot source" }), { mode: 0o640 });
    const secondInspected = await inspectMapFile(secondPath);
    const entered = [];
    const releases = [];
    const store = fixture.store({
      chunkBytes: 64,
      commitConcurrency: 1,
      validateCandidate: async () => {
        entered.push(entered.length + 1);
        await new Promise((resolve) => releases.push(resolve));
        return { diagnostics: [], references: [] };
      },
    });
    const firstContent = mapBytes({ note: "first snapshot target" });
    const secondContent = mapBytes({ note: "second snapshot target" });
    const first = await beginSave(store, fixture, firstContent, "save-snapshot-queue-1", {
      chunkBytes: 31,
      maxBytes: 1_024 * 1_024,
      commitConcurrency: 1,
    });
    const secondFixture = {
      ...fixture,
      targetPath: secondPath,
      context: {
        ...fixture.context,
        mapSessionId: "map-session-snapshot-0002",
        targetPath: secondPath,
        relativePath: "maps/second-snapshot.tmj",
        version: secondInspected.version,
      },
    };
    const second = await beginSave(store, secondFixture, secondContent, "save-snapshot-queue-2", {
      chunkBytes: 47,
      maxBytes: 2 * 1_024 * 1_024,
      commitConcurrency: 2,
    });
    assert.equal(first.config.chunkBytes, 31);
    assert.equal(first.config.commitConcurrency, 1);
    assert.equal(second.config.chunkBytes, 47);
    assert.equal(second.config.commitConcurrency, 2);
    for (const [index, chunk] of splitChunks(firstContent, first.config.chunkBytes).entries()) await upload(store, first, index, chunk);
    for (const [index, chunk] of splitChunks(secondContent, second.config.chunkBytes).entries()) await upload(store, second, index, chunk);

    const firstCommit = store.commit({ saveId: first.id, identity });
    await waitFor(() => entered.length === 1);
    const secondCommit = store.commit({ saveId: second.id, identity });
    await waitFor(() => entered.length === 2);
    releases.shift()();
    releases.shift()();
    await Promise.all([firstCommit, secondCommit]);
  });
});

test("validates and atomically saves World documents without executing patterns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-world-save-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "worlds", "game.world");
  const mapPath = path.join(projectPath, "maps", "town.tmj");
  const temporaryRoot = path.join(root, "runtime", "map-saves");
  const source = worldBytes({ onlyShowAdjacentMaps: false });
  const content = worldBytes({ onlyShowAdjacentMaps: true, futureField: { retained: true } });
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(mapPath), { recursive: true });
    await fs.writeFile(targetPath, source, { mode: 0o640 });
    await fs.writeFile(mapPath, mapBytes());
    const inspected = await inspectMapFile(targetPath);
    const store = new MapSaveSessionStore({ temporaryRoot, chunkBytes: 37 });
    const save = await store.begin({
      identity,
      mapContext: {
        mapSessionId: "world-session-0001",
        documentKind: "world",
        projectPath,
        targetPath,
        relativePath: "worlds/game.world",
        version: inspected.version,
        writable: true,
      },
      expectedVersion: inspected.version,
      totalBytes: content.length,
      totalHash: sha256(content),
      clientOperationId: "world-save-operation-0001",
    });
    for (const [index, chunk] of splitChunks(content, save.config.chunkBytes).entries()) {
      await upload(store, save, index, chunk);
    }
    const result = await store.commit({ saveId: save.id, identity });
    assert.equal(result.documentKind, "world");
    assert.equal(result.referenceCount, 1);
    assert.deepEqual(store.resourcePaths({ saveId: save.id, identity }), ["maps/town.tmj"]);
    assert.deepEqual(await fs.readFile(targetPath), content);
    const validated = await inspectTiledWorldInChild({
      candidatePath: targetPath,
      sourcePath: "worlds/game.world",
      projectPath,
      memoryMb: 128,
      timeoutMs: 10_000,
    });
    assert.equal(validated.references[0].kind, "map");
    assert.equal(validated.references[0].resolvedPath, "maps/town.tmj");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects mismatched map and World save context extensions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-world-save-context-"));
  const temporaryRoot = path.join(root, "runtime", "map-saves");
  try {
    const store = new MapSaveSessionStore({ temporaryRoot });
    const base = {
      identity,
      expectedVersion: "a".repeat(64),
      totalBytes: 2,
      totalHash: "b".repeat(64),
      clientOperationId: "world-save-context-0001",
    };
    await assert.rejects(
      store.begin({
        ...base,
        mapContext: {
          mapSessionId: "world-session-context-0001",
          documentKind: "world",
          projectPath: path.join(root, "project"),
          targetPath: path.join(root, "project", "maps", "wrong.tmj"),
          relativePath: "maps/wrong.tmj",
          version: "a".repeat(64),
          writable: true,
        },
      }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-save-context",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not expose a World save session through map save operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-world-save-kind-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "worlds", "game.world");
  const temporaryRoot = path.join(root, "runtime", "map-saves");
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const source = worldBytes();
    await fs.writeFile(targetPath, source);
    const inspected = await inspectMapFile(targetPath);
    const store = new MapSaveSessionStore({ temporaryRoot });
    const save = await store.begin({
      identity,
      mapContext: {
        mapSessionId: "world-session-kind-0001",
        documentKind: "world",
        projectPath,
        targetPath,
        relativePath: "worlds/game.world",
        version: inspected.version,
        writable: true,
      },
      expectedVersion: inspected.version,
      totalBytes: source.length,
      totalHash: sha256(source),
      clientOperationId: "world-save-kind-0001",
    });
    assert.throws(
      () => store.snapshot({ saveId: save.id, identity, documentKind: "map" }),
      (error) => error.statusCode === 404 && error.code === "map-save-session-not-found",
    );
    assert.equal(store.snapshot({ saveId: save.id, identity, documentKind: "world" }).documentKind, "world");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("logout removes only uncommitted save sessions for the exact browser login", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ maxSessions: 8, maxSessionsPerBrowser: 8 });
    const content = mapBytes({ note: "browser logout cleanup" });
    const own = await beginSave(store, fixture, content, "save-browser-cleanup-1");
    const otherIdentity = {
      ...identity,
      browserSessionId: "browser-session-2",
      editorInstanceId: "editor-window-0002",
    };
    const other = await store.begin({
      identity: otherIdentity,
      mapContext: fixture.context,
      expectedVersion: fixture.context.version,
      totalBytes: content.length,
      totalHash: sha256(content),
      clientOperationId: "save-browser-cleanup-2",
    });
    assert.deepEqual(await store.closeForBrowserSession(identity), { closed: 1, committing: 0 });
    assert.throws(
      () => store.snapshot({ saveId: own.id, identity }),
      (error) => error.code === "map-save-session-not-found",
    );
    assert.equal(store.snapshot({ saveId: other.id, identity: otherIdentity }).id, other.id);
    await store.abort({ saveId: other.id, identity: otherIdentity });
  });
});

test("logout lets an atomic save finish and then releases its session immediately", async () => {
  await withSaveFixture(async (fixture) => {
    let releaseValidation;
    const store = fixture.store({
      chunkBytes: 64,
      validateCandidate: () => new Promise((resolve) => {
        releaseValidation = () => resolve({ diagnostics: [], references: [] });
      }),
    });
    const content = mapBytes({ note: "finish atomic save after logout" });
    const save = await beginSave(store, fixture, content, "save-browser-committing-cleanup");
    for (const [index, chunk] of splitChunks(content, save.config.chunkBytes).entries()) {
      await upload(store, save, index, chunk);
    }
    const commit = store.commit({ saveId: save.id, identity });
    await waitFor(() => typeof releaseValidation === "function");

    assert.deepEqual(await store.closeForBrowserSession(identity), { closed: 0, committing: 1 });
    assert.equal(store.status().sessions, 1);
    releaseValidation();
    const result = await commit;

    assert.equal(result.version, sha256(content));
    assert.deepEqual(await fs.readFile(fixture.targetPath), content);
    assert.equal(store.status().sessions, 0);
    assert.deepEqual(await fs.readdir(fixture.temporaryRoot), []);
    assert.throws(
      () => store.snapshot({ saveId: save.id, identity }),
      (error) => error.code === "map-save-session-not-found",
    );
  });
});

test("revoking an account closes save sessions from all browser logins", async () => {
  await withSaveFixture(async (fixture) => {
    const store = fixture.store({ maxSessions: 8, maxSessionsPerBrowser: 8 });
    const content = mapBytes({ note: "account save cleanup" });
    const first = await beginSave(store, fixture, content, "save-user-cleanup-0001");
    const secondIdentity = {
      ...identity,
      browserSessionId: "browser-session-2",
      editorInstanceId: "editor-window-0002",
    };
    const second = await store.begin({
      identity: secondIdentity,
      mapContext: fixture.context,
      expectedVersion: fixture.context.version,
      totalBytes: content.length,
      totalHash: sha256(content),
      clientOperationId: "save-user-cleanup-0002",
    });
    const survivorIdentity = { ...identity, userId: "user-2", editorInstanceId: "editor-window-0003" };
    const survivor = await store.begin({
      identity: survivorIdentity,
      mapContext: fixture.context,
      expectedVersion: fixture.context.version,
      totalBytes: content.length,
      totalHash: sha256(content),
      clientOperationId: "save-user-survivor-0001",
    });

    assert.deepEqual(await store.closeForUser({ userId: identity.userId }), { closed: 2, committing: 0 });
    for (const [save, saveIdentity] of [[first, identity], [second, secondIdentity]]) {
      assert.throws(
        () => store.snapshot({ saveId: save.id, identity: saveIdentity }),
        (error) => error.code === "map-save-session-not-found",
      );
    }
    assert.equal(store.snapshot({ saveId: survivor.id, identity: survivorIdentity }).id, survivor.id);
    await store.abort({ saveId: survivor.id, identity: survivorIdentity });
  });
});

test("binds external TSJ saves to the tileset document kind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-tileset-save-kind-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "tiles", "terrain.tsj");
  const temporaryRoot = path.join(root, "runtime", "map-saves");
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const source = Buffer.from(`${JSON.stringify({
      type: "tileset",
      name: "Terrain",
      tilewidth: 16,
      tileheight: 16,
      columns: 0,
      tilecount: 0,
      tiles: [],
    })}\n`);
    await fs.writeFile(targetPath, source);
    const inspected = await inspectMapFile(targetPath);
    const store = new MapSaveSessionStore({ temporaryRoot });
    const save = await store.begin({
      identity,
      mapContext: {
        mapSessionId: "tileset-session-kind-0001",
        documentKind: "tileset",
        projectPath,
        targetPath,
        relativePath: "tiles/terrain.tsj",
        version: inspected.version,
        writable: true,
      },
      expectedVersion: inspected.version,
      totalBytes: source.length,
      totalHash: sha256(source),
      clientOperationId: "tileset-save-kind-0001",
    });
    assert.throws(
      () => store.snapshot({ saveId: save.id, identity, documentKind: "map" }),
      (error) => error.statusCode === 404 && error.code === "map-save-session-not-found",
    );
    assert.equal(
      store.snapshot({ saveId: save.id, identity, documentKind: "tileset" }).documentKind,
      "tileset",
    );
    await store.abort({ saveId: save.id, identity, documentKind: "tileset" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withSaveFixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-save-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "maps", "world.tmj");
  const temporaryRoot = path.join(root, "runtime", "map-saves");
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, mapBytes({ note: "source" }), { mode: 0o640 });
    const inspected = await inspectMapFile(targetPath);
    const context = {
      mapSessionId: "map-session-0001",
      projectPath,
      targetPath,
      relativePath: "maps/world.tmj",
      version: inspected.version,
      writable: true,
    };
    await operation({
      root,
      projectPath,
      targetPath,
      temporaryRoot,
      context,
      store: (options = {}) => new MapSaveSessionStore({ temporaryRoot, ...options }),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function beginSave(store, fixture, content, clientOperationId, config) {
  return store.begin({
    identity,
    mapContext: fixture.context,
    expectedVersion: fixture.context.version,
    totalBytes: content.length,
    totalHash: sha256(content),
    clientOperationId,
    config,
  });
}

function upload(store, save, index, content) {
  return store.uploadChunk({
    saveId: save.id,
    identity,
    index,
    source: content,
    chunkHash: sha256(content),
  });
}

function mapBytes(extra = {}) {
  return Buffer.from(`${JSON.stringify({
    type: "map",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [],
    tilesets: [],
    ...extra,
  }, null, 2)}\n`);
}

function worldBytes(extra = {}) {
  return Buffer.from(`${JSON.stringify({
    type: "world",
    maps: [{ fileName: "../maps/town.tmj", x: 0, y: 0, width: 320, height: 240 }],
    patterns: [{
      regexp: "^map_(\\d+)_(\\d+)\\.tmj$",
      multiplierX: 320,
      multiplierY: 240,
      offsetX: 0,
      offsetY: 0,
      mapWidth: 320,
      mapHeight: 240,
    }],
    ...extra,
  }, null, 2)}\n`);
}

function splitChunks(content, chunkBytes) {
  const chunks = [];
  for (let offset = 0; offset < content.length; offset += chunkBytes) {
    chunks.push(content.subarray(offset, Math.min(content.length, offset + chunkBytes)));
  }
  return chunks;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
