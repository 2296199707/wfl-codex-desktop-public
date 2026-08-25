import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  IMAGE_PARTIAL_PREVIEW_DEFAULTS,
  ImagePartialPreviewStore,
} from "../lib/image-partial-preview-store.mjs";

const WINDOW_A = "a".repeat(64);
const WINDOW_B = "b".repeat(64);
const OPERATION_A = "c".repeat(64);
const OPERATION_B = "d".repeat(64);
const IDENTITY_A = Object.freeze({
  userId: "user-a",
  browserSessionId: "browser-a",
  windowId: WINDOW_A,
  operationId: OPERATION_A,
});

test("stages private unpredictable previews and opens them only for the exact identity", async (context) => {
  const fixture = await createFixture(context);
  const image = pngFixture(18, 11);
  const sourcePath = await fixture.source("worker-partial.png", image);
  const staged = await fixture.store.stage({
    sourcePath,
    expected: expectedImage(image, 18, 11),
    ...IDENTITY_A,
  });

  assert.match(staged.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(staged.metadata.expiresAt - staged.metadata.createdAt, IMAGE_PARTIAL_PREVIEW_DEFAULTS.ttlMs);
  assert.equal((await fs.stat(fixture.previewRoot)).mode & 0o7777, 0o700);
  const files = await fs.readdir(fixture.previewRoot);
  assert.equal(files.length, 1);
  assert.match(files[0], /^partial-[a-f0-9]{48}\.png$/);
  assert.notEqual(files[0], path.basename(sourcePath));
  assert.equal((await fs.stat(path.join(fixture.previewRoot, files[0]))).mode & 0o7777, 0o600);

  await assert.rejects(
    fixture.store.open(staged.token, { ...IDENTITY_A, userId: "user-b" }),
    (error) => error.code === "PARTIAL_PREVIEW_NOT_FOUND" && error.statusCode === 404,
  );
  await assert.rejects(
    fixture.store.open(staged.token, { ...IDENTITY_A, browserSessionId: "browser-b" }),
    (error) => error.code === "PARTIAL_PREVIEW_NOT_FOUND",
  );
  await assert.rejects(
    fixture.store.open(staged.token, { ...IDENTITY_A, windowId: WINDOW_B }),
    (error) => error.code === "PARTIAL_PREVIEW_NOT_FOUND",
  );
  await assert.rejects(
    fixture.store.open(staged.token, { ...IDENTITY_A, operationId: OPERATION_B }),
    (error) => error.code === "PARTIAL_PREVIEW_NOT_FOUND",
  );
  await assert.rejects(
    fixture.store.open(staged.token, {
      userId: IDENTITY_A.userId,
      browserSessionId: IDENTITY_A.browserSessionId,
    }),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW" && error.statusCode === 400,
  );
  await assert.rejects(
    fixture.store.open("../bad-token", IDENTITY_A),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW" && error.statusCode === 400,
  );

  const opened = await fixture.store.open(staged.token, IDENTITY_A);
  assert.deepEqual(opened.metadata, staged.metadata);
  const chunks = [];
  for await (const chunk of opened.handle.createReadStream({ autoClose: false })) chunks.push(chunk);
  await opened.handle.close();
  assert.deepEqual(Buffer.concat(chunks), image);
});

test("rejects Base64, unsafe paths, formats, digests, and declared dimensions", async (context) => {
  const fixture = await createFixture(context);
  const image = pngFixture(8, 6);
  const sourcePath = await fixture.source("partial.png", image);
  const base = {
    sourcePath,
    expected: expectedImage(image, 8, 6),
    ...IDENTITY_A,
  };

  await assert.rejects(
    fixture.store.stage({ ...base, windowId: undefined }),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW" && error.statusCode === 400,
  );
  await assert.rejects(
    fixture.store.stage({ ...base, operationId: "legacy-operation" }),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW",
  );

  await assert.rejects(
    fixture.store.stage({ ...base, data: image.toString("base64") }),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW",
  );
  await assert.rejects(
    fixture.store.stage({ ...base, sourcePath: "relative/partial.png" }),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW",
  );
  await assert.rejects(
    fixture.store.stage({ ...base, expected: { ...base.expected, format: "gif", mediaType: "image/gif" } }),
    (error) => error.code === "INVALID_PARTIAL_PREVIEW",
  );
  await assert.rejects(
    fixture.store.stage({ ...base, expected: { ...base.expected, sha256: "0".repeat(64) } }),
    (error) => error.code === "IMAGE_SOURCE_SHA256_MISMATCH",
  );
  await assert.rejects(
    fixture.store.stage({ ...base, expected: { ...base.expected, width: 9 } }),
    (error) => error.code === "PARTIAL_PREVIEW_METADATA_MISMATCH",
  );
  assert.deepEqual(await fs.readdir(fixture.previewRoot), []);
});

test("expires previews and evicts the oldest entry at bounded capacity", async (context) => {
  let now = 1_000;
  const fixture = await createFixture(context, {
    ttlMs: 100,
    maxEntries: 2,
    maxBytes: 1_000_000,
    maxFileBytes: 1_000_000,
    now: () => now,
  });
  const images = [pngFixture(3, 3), pngFixture(4, 4), pngFixture(5, 5)];
  const staged = [];
  for (let index = 0; index < images.length; index += 1) {
    const size = index + 3;
    staged.push(await fixture.store.stage({
      sourcePath: await fixture.source(`partial-${index}.png`, images[index]),
      expected: expectedImage(images[index], size, size),
      ...IDENTITY_A,
    }));
    now += 1;
  }

  assert.equal(fixture.store.status().entries, 2);
  assert.equal((await fs.readdir(fixture.previewRoot)).length, 2);
  await assert.rejects(
    fixture.store.open(staged[0].token, IDENTITY_A),
    (error) => error.code === "PARTIAL_PREVIEW_NOT_FOUND",
  );
  now += 200;
  await fixture.store.prune();
  assert.deepEqual(fixture.store.status(), {
    entries: 0,
    totalBytes: 0,
    maxEntries: 2,
    maxBytes: 1_000_000,
    ttlMs: 100,
  });
  assert.deepEqual(await fs.readdir(fixture.previewRoot), []);
});

test("open rejects symlink replacement and cleanup never follows or removes it", async (context) => {
  const fixture = await createFixture(context);
  const image = pngFixture(7, 5);
  const staged = await fixture.store.stage({
    sourcePath: await fixture.source("partial.png", image),
    expected: expectedImage(image, 7, 5),
    ...IDENTITY_A,
  });
  const [filename] = await fs.readdir(fixture.previewRoot);
  const previewPath = path.join(fixture.previewRoot, filename);
  const movedPath = path.join(fixture.sourceRoot, "moved-original.png");
  const outsidePath = path.join(fixture.sourceRoot, "outside.txt");
  await fs.writeFile(outsidePath, "do not remove");
  await fs.rename(previewPath, movedPath);
  await fs.symlink(outsidePath, previewPath);

  await assert.rejects(
    fixture.store.open(staged.token, IDENTITY_A),
    (error) => error.code === "PARTIAL_PREVIEW_UNAVAILABLE" || error.code === "PARTIAL_PREVIEW_REPLACED",
  );
  await fixture.store.close();
  assert.equal((await fs.lstat(previewPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outsidePath, "utf8"), "do not remove");
  assert.deepEqual(await fs.readFile(movedPath), image);
});

test("close removes only recorded inodes and rejects further operations", async (context) => {
  const fixture = await createFixture(context);
  const image = pngFixture(2, 2);
  const staged = await fixture.store.stage({
    sourcePath: await fixture.source("partial.png", image),
    expected: expectedImage(image, 2, 2),
    ...IDENTITY_A,
  });
  await fs.writeFile(path.join(fixture.previewRoot, "unmanaged.txt"), "keep");
  await fixture.store.close();
  assert.deepEqual(await fs.readdir(fixture.previewRoot), ["unmanaged.txt"]);
  await assert.rejects(
    fixture.store.open(staged.token, IDENTITY_A),
    (error) => error.code === "PARTIAL_PREVIEW_STORE_CLOSED",
  );
  await assert.rejects(
    fixture.store.stage({}),
    (error) => error.code === "PARTIAL_PREVIEW_STORE_CLOSED",
  );
});

test("initialization removes only stale managed preview files", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-preview-recovery-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const previewRoot = path.join(parent, "previews");
  await fs.mkdir(previewRoot, { mode: 0o700 });
  const stale = path.join(previewRoot, `partial-${"a".repeat(48)}.png`);
  const unmanaged = path.join(previewRoot, "unmanaged.txt");
  await fs.writeFile(stale, "stale");
  await fs.writeFile(unmanaged, "keep");

  const store = await new ImagePartialPreviewStore(previewRoot).initialize();
  context.after(() => store.close());
  assert.deepEqual(await fs.readdir(previewRoot), ["unmanaged.txt"]);
  assert.equal(await fs.readFile(unmanaged, "utf8"), "keep");
});

test("initialization rejects a symlink root", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-preview-root-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "target");
  const linked = path.join(parent, "linked");
  await fs.mkdir(target);
  await fs.symlink(target, linked);
  const store = new ImagePartialPreviewStore(linked);
  await assert.rejects(
    store.initialize(),
    (error) => error.code === "UNSAFE_PARTIAL_PREVIEW_ROOT",
  );
});

async function createFixture(context, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-partial-preview-"));
  const sourceRoot = path.join(parent, "worker-output");
  const previewRoot = path.join(parent, "previews");
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  const store = await new ImagePartialPreviewStore(previewRoot, options).initialize();
  context.after(async () => {
    await store.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  return {
    store,
    sourceRoot,
    previewRoot,
    async source(name, data) {
      const filename = path.join(sourceRoot, name);
      await fs.writeFile(filename, data, { mode: 0o600 });
      return filename;
    },
  };
}

function expectedImage(image, width, height) {
  return {
    size: image.length,
    sha256: crypto.createHash("sha256").update(image).digest("hex"),
    format: "png",
    width,
    height,
    mediaType: "image/png",
  };
}

function pngFixture(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((1 + (width * 4)) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const checksumInput = Buffer.concat([name, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(checksumInput), 8 + data.length);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
