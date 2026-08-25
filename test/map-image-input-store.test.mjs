import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapImageInputStore } from "../lib/map-image-input-store.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const IDENTITY = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-session-1",
  editorInstanceId: "map-editor-window-0001",
});
const MAP_VERSION = "a".repeat(64);

async function fixture(run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-image-input-"));
  const projectPath = path.join(root, "project");
  const temporaryRoot = path.join(root, "temporary-inputs");
  await fs.mkdir(projectPath, { recursive: true });
  const store = await new MapImageInputStore({
    temporaryRoot,
    authorizeSession: options.authorizeSession,
    now: options.now,
    ttlMs: options.ttlMs,
    chunkBytes: options.chunkBytes || 32,
    maxBytes: options.maxBytes,
    cleanupIntervalMs: 60_000,
  }).initialize();
  try {
    await run({ root, projectPath, temporaryRoot, store });
  } finally {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function context(projectPath, overrides = {}) {
  return {
    identity: IDENTITY,
    mapContext: {
      mapSessionId: "map-session-0001",
      version: MAP_VERSION,
      projectPath,
      targetPath: path.join(projectPath, "maps", "world.tmj"),
      writable: true,
    },
    editorStateId: 7,
    ...overrides,
  };
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

async function upload(store, projectPath, bytes = PNG, overrides = {}) {
  const uploadContext = context(projectPath, {
    ...(overrides.identity ? { identity: overrides.identity } : {}),
    ...(overrides.mapContext ? { mapContext: overrides.mapContext } : {}),
    ...(overrides.editorStateId !== undefined ? { editorStateId: overrides.editorStateId } : {}),
  });
  const created = await store.create({
    ...uploadContext,
    kind: "source",
    mediaType: "image/png",
    totalBytes: bytes.length,
    totalHash: hash(bytes),
    ...overrides,
  });
  for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
    const chunk = bytes.subarray(offset, Math.min(offset + created.chunkBytes, bytes.length));
    await store.append({
      ...uploadContext,
      inputId: created.id,
      index,
      source: chunk,
      contentLength: chunk.length,
      chunkHash: hash(chunk),
    });
    offset += chunk.length;
  }
  return { created, finalized: await store.finalize({ ...uploadContext, inputId: created.id }) };
}

test("uploads source in ordered chunks, validates hash/magic/dimensions, and hides paths", async () => {
  await fixture(async ({ projectPath, temporaryRoot, store }) => {
    const { created, finalized } = await upload(store, projectPath);
    assert.equal(created.status, "uploading");
    assert.equal(finalized.status, "finalized");
    assert.equal(finalized.width, 1);
    assert.equal(finalized.height, 1);
    assert.equal(finalized.sha256, hash(PNG));
    assert.equal(JSON.stringify(finalized).includes(temporaryRoot), false);
    assert.equal(JSON.stringify(finalized).includes(projectPath), false);
    assert.equal(store.status().finalized, 1);
  });
});

test("rejects out-of-order, mismatched, and duplicate chunks without corrupting the payload", async () => {
  await fixture(async ({ projectPath, temporaryRoot, store }) => {
    const bytes = Buffer.concat([PNG, PNG]);
    const created = await store.create({
      ...context(projectPath), kind: "source", mediaType: "image/png",
      totalBytes: bytes.length, totalHash: hash(bytes),
    });
    const chunk = bytes.subarray(0, created.chunkBytes);
    await assert.rejects(store.append({ ...context(projectPath), inputId: created.id, index: 1, source: chunk, contentLength: chunk.length, chunkHash: hash(chunk) }), (error) => error.code === "MAP_IMAGE_INPUT_CHUNK_ORDER");
    await assert.rejects(store.append({ ...context(projectPath), inputId: created.id, index: 0, source: chunk, contentLength: chunk.length, chunkHash: hash(Buffer.from("bad")) }), (error) => error.code === "MAP_IMAGE_INPUT_CHUNK_HASH");
    await store.append({ ...context(projectPath), inputId: created.id, index: 0, source: chunk, contentLength: chunk.length, chunkHash: hash(chunk) });
    await assert.rejects(store.append({ ...context(projectPath), inputId: created.id, index: 0, source: chunk, contentLength: chunk.length, chunkHash: hash(chunk) }), (error) => error.code === "MAP_IMAGE_INPUT_CHUNK_ORDER");
  });
});

test("supports async iterable chunks and explicit execution authorization", async () => {
  const calls = [];
  await fixture(async ({ projectPath, temporaryRoot, store }) => {
    const created = await store.create({ ...context(projectPath), kind: "source", mediaType: "image/png", totalBytes: PNG.length, totalHash: hash(PNG) });
    async function* chunks() { yield PNG.subarray(0, 16); yield PNG.subarray(16, 32); }
    const firstChunk = PNG.subarray(0, created.chunkBytes);
    await store.append({ ...context(projectPath), inputId: created.id, index: 0, source: chunks(), contentLength: firstChunk.length, chunkHash: hash(firstChunk) });
    for (let offset = created.chunkBytes, index = 1; offset < PNG.length; index += 1) {
      const chunk = PNG.subarray(offset, Math.min(offset + created.chunkBytes, PNG.length));
      await store.append({ ...context(projectPath), inputId: created.id, index, source: chunk, contentLength: chunk.length, chunkHash: hash(chunk) });
      offset += chunk.length;
    }
    await store.finalize({ ...context(projectPath), inputId: created.id });
    const descriptor = await store.authorize({ ...context(projectPath), inputId: created.id, purpose: "input-execute" });
    assert.equal(Object.keys(descriptor).includes("absolutePath"), false);
    assert.equal(JSON.stringify(descriptor).includes(temporaryRoot), false);
    assert.equal(typeof descriptor.absolutePath, "string");
    assert.equal(calls.at(-1).purpose, "input-execute");
    await descriptor.release();
  }, { authorizeSession: async (value) => calls.push(value) });
});

test("requires current map version, editor state, and window identity", async () => {
  await fixture(async ({ projectPath, store }) => {
    const { finalized } = await upload(store, projectPath);
    assert.equal((await store.snapshot({ ...context(projectPath), inputId: finalized.id })).id, finalized.id);
    await assert.rejects(store.read({ ...context(projectPath), inputId: finalized.id, mapVersion: "b".repeat(64) }), (error) => error.code === "MAP_IMAGE_INPUT_CONTEXT_CONFLICT");
    await assert.rejects(store.read({ ...context(projectPath), inputId: finalized.id, editorStateId: 8 }), (error) => error.code === "MAP_IMAGE_INPUT_CONTEXT_CONFLICT");
    await assert.rejects(store.read({ ...context(projectPath), inputId: finalized.id, identity: { ...IDENTITY, editorInstanceId: "map-editor-window-0002" } }), (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND");
    await assert.rejects(store.snapshot({ ...context(projectPath), inputId: finalized.id, identity: { ...IDENTITY, editorInstanceId: "map-editor-window-0002" } }), (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND");
  });
});

test("enforces PNG masks and rejects declared type or dimensions that disagree", async () => {
  await fixture(async ({ projectPath, store }) => {
    await assert.rejects(store.create({ ...context(projectPath), kind: "mask", mediaType: "image/jpeg", totalBytes: PNG.length, totalHash: hash(PNG) }), (error) => error.code === "MAP_IMAGE_INPUT_MEDIA_TYPE_INVALID");
    const created = await store.create({ ...context(projectPath), kind: "source", mediaType: "image/png", width: 2, height: 1, totalBytes: PNG.length, totalHash: hash(PNG) });
    for (let offset = 0, index = 0; offset < PNG.length; index += 1) {
      const chunk = PNG.subarray(offset, Math.min(offset + created.chunkBytes, PNG.length));
      await store.append({ ...context(projectPath), inputId: created.id, index, source: chunk, contentLength: chunk.length, chunkHash: hash(chunk) });
      offset += chunk.length;
    }
    await assert.rejects(store.finalize({ ...context(projectPath), inputId: created.id }), (error) => error.code === "MAP_IMAGE_INPUT_DIMENSIONS");
  });
});

test("rechecks file identity and blocks symlink replacement", async () => {
  await fixture(async ({ projectPath, store }) => {
    const { finalized } = await upload(store, projectPath);
    const descriptor = await store.authorize({ ...context(projectPath), inputId: finalized.id });
    const real = descriptor.absolutePath;
    await descriptor.release();
    const replacement = `${real}.replacement`;
    await fs.rename(real, replacement);
    await fs.symlink(replacement, real);
    await assert.rejects(store.read({ ...context(projectPath), inputId: finalized.id }), (error) => error.code === "MAP_IMAGE_INPUT_CHANGED");
  });
});

test("expires and removes temporary inputs after TTL", async () => {
  let clock = 1_000;
  await fixture(async ({ projectPath, temporaryRoot, store }) => {
    const { finalized } = await upload(store, projectPath);
    clock = finalized.expiresAt + 1;
    assert.equal(await store.pruneExpired(), 1);
    assert.equal(store.status().inputs, 0);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
    await assert.rejects(store.read({ ...context(projectPath), inputId: finalized.id }), (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND");
  }, { now: () => clock, ttlMs: 100 });
});

test("logout removes idle temporary inputs only for the exact browser login", async () => {
  await fixture(async ({ projectPath, temporaryRoot, store }) => {
    const own = await upload(store, projectPath);
    const otherIdentity = { ...IDENTITY, browserSessionId: "browser-session-2" };
    const otherContext = { ...context(projectPath), identity: otherIdentity };
    const created = await store.create({
      ...otherContext,
      kind: "source",
      mediaType: "image/png",
      totalBytes: PNG.length,
      totalHash: hash(PNG),
    });
    for (let offset = 0, index = 0; offset < PNG.length; index += 1) {
      const chunk = PNG.subarray(offset, Math.min(offset + created.chunkBytes, PNG.length));
      await store.append({
        ...otherContext,
        inputId: created.id,
        index,
        source: chunk,
        contentLength: chunk.length,
        chunkHash: hash(chunk),
      });
      offset += chunk.length;
    }
    await store.finalize({ ...otherContext, inputId: created.id });

    assert.deepEqual(await store.deleteForBrowserSession(IDENTITY), { deleted: 1, retained: 0 });
    await assert.rejects(
      store.snapshot({ ...context(projectPath), inputId: own.finalized.id }),
      (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND",
    );
    assert.equal((await store.snapshot({ ...otherContext, inputId: created.id })).id, created.id);
    assert.equal((await fs.readdir(temporaryRoot)).length, 1);
  });
});

test("logout defers claimed and retained input deletion until their last Worker lease releases", async () => {
  await fixture(async ({ projectPath, temporaryRoot, store }) => {
    const claimedInput = await upload(store, projectPath);
    const retainedInput = await upload(store, projectPath);
    const claim = await store.claim({
      ...context(projectPath),
      inputId: claimedInput.finalized.id,
    });
    const retain = await store.retain({
      ...context(projectPath),
      inputId: retainedInput.finalized.id,
    });

    assert.deepEqual(await store.deleteForBrowserSession(IDENTITY), { deleted: 0, retained: 2 });
    assert.equal(store.status().inputs, 2);
    assert.equal((await fs.readdir(temporaryRoot)).length, 2);

    await claim.release();
    await assert.rejects(
      store.snapshot({ ...context(projectPath), inputId: claimedInput.finalized.id }),
      (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND",
    );
    assert.equal(store.status().inputs, 1);

    await retain.release();
    await assert.rejects(
      store.snapshot({ ...context(projectPath), inputId: retainedInput.finalized.id }),
      (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND",
    );
    assert.equal(store.status().inputs, 0);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  });
});

test("revoking an account deletes image inputs from all logins but not another user", async () => {
  await fixture(async ({ projectPath, store }) => {
    const first = await upload(store, projectPath);
    const secondIdentity = { ...IDENTITY, browserSessionId: "browser-session-2" };
    const secondContext = { ...context(projectPath), identity: secondIdentity };
    const second = await upload(store, projectPath, PNG, secondContext);
    const survivorIdentity = { ...IDENTITY, userId: "user-2", editorInstanceId: "map-editor-window-0002" };
    const survivorContext = { ...context(projectPath), identity: survivorIdentity };
    const survivor = await upload(store, projectPath, PNG, survivorContext);

    assert.deepEqual(await store.deleteForUser({ userId: IDENTITY.userId }), { deleted: 2, retained: 0 });
    await assert.rejects(
      store.snapshot({ ...context(projectPath), inputId: first.finalized.id }),
      (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND",
    );
    await assert.rejects(
      store.snapshot({ ...secondContext, inputId: second.finalized.id }),
      (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND",
    );
    assert.equal((await store.snapshot({ ...survivorContext, inputId: survivor.finalized.id })).id, survivor.finalized.id);
  });
});

test("claims are exclusive, prevent deletion/TTL, and release idempotently", async () => {
  let clock = 1_000;
  await fixture(async ({ projectPath, store }) => {
    const { finalized } = await upload(store, projectPath);
    const first = await store.claim({ ...context(projectPath), inputId: finalized.id });
    assert.equal(Object.keys(first).includes("absolutePath"), false);
    await assert.rejects(
      store.claim({ ...context(projectPath), inputId: finalized.id, identity: { ...IDENTITY, editorInstanceId: "map-editor-window-0002" } }),
      (error) => error.code === "MAP_IMAGE_INPUT_NOT_FOUND",
    );
    await assert.rejects(store.claim({ ...context(projectPath), inputId: finalized.id }), (error) => error.code === "MAP_IMAGE_INPUT_CLAIMED");
    await assert.rejects(store.delete({ ...context(projectPath), inputId: finalized.id }), (error) => error.code === "MAP_IMAGE_INPUT_CLAIMED");
    clock = finalized.expiresAt + 1;
    assert.equal(await store.pruneExpired(), 0);
    await first.release();
    await first.release();
    assert.equal(await store.pruneExpired(), 1);
  }, { now: () => clock, ttlMs: 100 });
});

test("stages a claimed input with source hash/inode checks and no path in result", async () => {
  await fixture(async ({ projectPath, root, store }) => {
    const { finalized } = await upload(store, projectPath);
    const workerDir = path.join(root, "worker-input");
    await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });
    const destination = path.join(workerDir, "source.png");
    const result = await store.stageTo({ ...context(projectPath), inputId: finalized.id, destinationPath: destination });
    assert.deepEqual(await fs.readFile(destination), PNG);
    assert.equal(result.sha256, hash(PNG));
    assert.equal(result.bytes, PNG.length);
    assert.equal(Object.hasOwn(result, "destinationPath"), false);
    assert.equal(JSON.stringify(result).includes(workerDir), false);
    await assert.rejects(store.stageTo({ ...context(projectPath), inputId: finalized.id, destinationPath: destination }), (error) => error.code === "MAP_IMAGE_INPUT_DESTINATION_EXISTS");
  });
});

test("stage rejects an input whose inode or bytes changed after finalize", async () => {
  await fixture(async ({ projectPath, root, store }) => {
    const { finalized } = await upload(store, projectPath);
    const workerDir = path.join(root, "worker-input");
    await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });
    const destination = path.join(workerDir, "changed.png");
    const sourcePath = (await store.authorize({ ...context(projectPath), inputId: finalized.id })).absolutePath;
    const replacement = `${sourcePath}.replacement`;
    await fs.rename(sourcePath, replacement);
    await fs.symlink(replacement, sourcePath);
    await assert.rejects(store.stageTo({ ...context(projectPath), inputId: finalized.id, destinationPath: destination }), (error) => error.code === "MAP_IMAGE_INPUT_CHANGED");
    await fs.unlink(sourcePath);
    await fs.rename(replacement, sourcePath);
    const handle = await fs.open(sourcePath, "r+");
    const altered = Buffer.from(PNG);
    altered[altered.length - 1] ^= 1;
    await handle.write(altered, 0, altered.length, 0);
    await handle.close();
    await assert.rejects(store.stageTo({ ...context(projectPath), inputId: finalized.id, destinationPath: destination }), (error) => error.code === "MAP_IMAGE_INPUT_CHANGED");
  });
});

test("aborting a Worker task releases its claim and leaves the input deletable", async () => {
  await fixture(async ({ projectPath, store }) => {
    const { finalized } = await upload(store, projectPath);
    const controller = new AbortController();
    const lease = await store.claim({ ...context(projectPath), inputId: finalized.id, signal: controller.signal });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.status().claimed, 0);
    await assert.doesNotReject(store.delete({ ...context(projectPath), inputId: finalized.id }));
    const second = await upload(store, projectPath);
    const secondController = new AbortController();
    secondController.abort();
    await assert.rejects(store.claim({ ...context(projectPath), inputId: second.finalized.id, signal: secondController.signal }), (error) => error.code === "MAP_IMAGE_INPUT_CANCELED");
    await lease.release();
  });
});

test("retains finalized inputs across queued jobs and releases the pin idempotently", async () => {
  let clock = 1_000;
  await fixture(async ({ projectPath, store }) => {
    const { finalized } = await upload(store, projectPath);
    const lease = await store.retain({ ...context(projectPath), inputId: finalized.id });
    assert.equal(store.status().retained, 1);
    await assert.rejects(
      store.delete({ ...context(projectPath), inputId: finalized.id }),
      (error) => error.code === "MAP_IMAGE_INPUT_CLAIMED",
    );
    clock = finalized.expiresAt + 1;
    assert.equal(await store.pruneExpired(), 0);
    await lease.release();
    await lease.release();
    assert.equal(store.status().retained, 0);
    assert.equal(await store.pruneExpired(), 1);
  }, { now: () => clock, ttlMs: 100 });
});
