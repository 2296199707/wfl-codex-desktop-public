import assert from "node:assert/strict";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  publishImageBatch,
  publishImageFileBatch,
  publishNewImage,
} from "../lib/image-atomic-save.mjs";
import { openImageProjectAnchor } from "../lib/image-project-anchor.mjs";

test("publishes through an fd-anchored parent when an ancestor is replaced by a symlink", async (context) => {
  const root = await temporaryDirectory(context);
  const parent = path.join(root, "maps");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-anchor-outside-"));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(parent);
  const originalParent = `${parent}.old`;
  const anchor = await openImageProjectAnchor(root);
  context.after(() => anchor.close().catch(() => {}));
  const targetPath = path.join(parent, "result.png");
  let swapped = false;
  const fileSystem = Object.create(fs);
  fileSystem.open = async (...args) => {
    if (!swapped && String(args[0]).includes("/proc/self/fd/")) {
      swapped = true;
      await fs.rename(parent, originalParent);
      await fs.symlink(outside, parent);
    }
    return fs.open(...args);
  };

  await publishNewImage({ targetPath, data: pngFixture(7, 5) }, { fileSystem, projectAnchor: anchor });
  assert.equal((await fs.readdir(outside)).length, 0);
  assert.deepEqual(await fs.readdir(originalParent), ["result.png"]);
});

test("rejects an fd anchor when the project root is deleted and rebuilt", async (context) => {
  const root = await temporaryDirectory(context);
  const anchor = await openImageProjectAnchor(root);
  context.after(() => anchor.close().catch(() => {}));
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  await assert.rejects(anchor.assertIdentity(), (error) => error.code === "IMAGE_PROJECT_CHANGED");
});

test("publishes a validated image with actual metadata and digest", async (context) => {
  const directory = await temporaryDirectory(context);
  const targetPath = path.join(directory, "generated.png");
  const image = pngFixture(32, 18);

  const result = await publishNewImage({ targetPath, data: image });

  assert.deepEqual(result, {
    path: targetPath,
    format: "png",
    mediaType: "image/png",
    width: 32,
    height: 18,
    size: image.length,
    sha256: crypto.createHash("sha256").update(image).digest("hex"),
  });
  assert.deepEqual(await fs.readFile(targetPath), image);
  assert.deepEqual(await fs.readdir(directory), ["generated.png"]);
});

test("reports a 409 conflict without replacing an existing output", async (context) => {
  const directory = await temporaryDirectory(context);
  const targetPath = path.join(directory, "existing.png");
  const original = Buffer.from("keep this file unchanged");
  await fs.writeFile(targetPath, original);

  await assert.rejects(
    publishNewImage({ targetPath, data: pngFixture(4, 3) }),
    (error) => error.code === "IMAGE_OUTPUT_EXISTS" && error.statusCode === 409,
  );
  assert.deepEqual(await fs.readFile(targetPath), original);
  assert.deepEqual(await fs.readdir(directory), ["existing.png"]);
});

test("removes its temporary file when image validation fails", async (context) => {
  const directory = await temporaryDirectory(context);
  const targetPath = path.join(directory, "invalid.png");

  await assert.rejects(
    publishNewImage({ targetPath, data: Buffer.from("not an image") }),
    (error) => error.code === "INVALID_IMAGE",
  );
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(fs.stat(targetPath), (error) => error.code === "ENOENT");
});

test("applies the requested mode and current ownership before publishing", async (context) => {
  const directory = await temporaryDirectory(context);
  const targetPath = path.join(directory, "private.png");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;

  await publishNewImage({ targetPath, data: pngFixture(2, 2), mode: 0o600, uid, gid });

  const stat = await fs.stat(targetPath);
  assert.equal(stat.mode & 0o7777, 0o600);
  if (uid !== null) assert.equal(stat.uid, uid);
  if (gid !== null) assert.equal(stat.gid, gid);
});

test("rolls back every output and temporary file when the second batch commit fails", async (context) => {
  const directory = await temporaryDirectory(context);
  const targets = ["first.png", "second.png", "third.png"].map((name) => path.join(directory, name));
  let linkCalls = 0;
  const fileSystem = Object.create(fs);
  fileSystem.link = async (...arguments_) => {
    linkCalls += 1;
    if (linkCalls === 2) {
      const error = new Error("injected second commit failure");
      error.code = "EIO";
      throw error;
    }
    return fs.link(...arguments_);
  };

  await assert.rejects(
    publishImageBatch({
      outputs: targets.map((targetPath, index) => ({
        targetPath,
        data: pngFixture(8 + index, 6 + index),
      })),
    }, { fileSystem }),
    (error) => error.code === "EIO"
      && error.partialOutputs === undefined
      && error.rollbackFailures === undefined,
  );

  assert.equal(linkCalls, 2);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("validates every batch image before creating any temporary file", async (context) => {
  const directory = await temporaryDirectory(context);

  await assert.rejects(
    publishImageBatch({
      outputs: [
        { targetPath: path.join(directory, "valid.png"), data: pngFixture(8, 8) },
        { targetPath: path.join(directory, "invalid.png"), data: Buffer.from("not an image") },
      ],
    }),
    (error) => error.code === "INVALID_IMAGE",
  );

  assert.deepEqual(await fs.readdir(directory), []);
});

test("publishes a complete image batch only after every image is staged", async (context) => {
  const directory = await temporaryDirectory(context);
  const firstTarget = path.join(directory, "first.png");
  const secondTarget = path.join(directory, "second.png");
  const firstImage = pngFixture(12, 7);
  const secondImage = pngFixture(13, 8);

  const results = await publishImageBatch({
    outputs: [
      { targetPath: firstTarget, data: firstImage },
      { targetPath: secondTarget, data: secondImage },
    ],
  });

  assert.deepEqual(results.map(({ path: outputPath, width, height }) => ({ outputPath, width, height })), [
    { outputPath: firstTarget, width: 12, height: 7 },
    { outputPath: secondTarget, width: 13, height: 8 },
  ]);
  assert.deepEqual(await fs.readFile(firstTarget), firstImage);
  assert.deepEqual(await fs.readFile(secondTarget), secondImage);
  assert.deepEqual(await fs.readdir(directory), ["first.png", "second.png"]);
});

test("keeps an existing target and rolls back earlier batch outputs on conflict", async (context) => {
  const directory = await temporaryDirectory(context);
  const firstTarget = path.join(directory, "first.png");
  const existingTarget = path.join(directory, "existing.png");
  const original = Buffer.from("existing output must not change");
  await fs.writeFile(existingTarget, original);

  await assert.rejects(
    publishImageBatch({
      outputs: [
        { targetPath: firstTarget, data: pngFixture(9, 7) },
        { targetPath: existingTarget, data: pngFixture(10, 8) },
      ],
    }),
    (error) => error.code === "IMAGE_OUTPUT_EXISTS" && error.statusCode === 409,
  );

  assert.deepEqual(await fs.readFile(existingTarget), original);
  assert.deepEqual(await fs.readdir(directory), ["existing.png"]);
});

test("reports safe partial output metadata when a batch rollback cannot remove an output", async (context) => {
  const directory = await temporaryDirectory(context);
  const firstTarget = path.join(directory, "first.png");
  const secondTarget = path.join(directory, "second.png");
  let linkCalls = 0;
  const fileSystem = Object.create(fs);
  fileSystem.link = async (...arguments_) => {
    linkCalls += 1;
    if (linkCalls === 2) {
      const error = new Error("injected commit failure containing /private/server/path");
      error.code = "EIO";
      throw error;
    }
    return fs.link(...arguments_);
  };
  fileSystem.unlink = async (filename) => {
    if (filename === firstTarget) {
      const error = new Error("injected rollback failure containing /private/server/path");
      error.code = "EACCES";
      throw error;
    }
    return fs.unlink(filename);
  };

  await assert.rejects(
    publishImageBatch({
      outputs: [
        { targetPath: firstTarget, data: pngFixture(5, 5) },
        { targetPath: secondTarget, data: pngFixture(6, 6) },
      ],
    }, { fileSystem }),
    (error) => {
      assert.deepEqual(error.partialOutputs, [{ index: 0, filename: "first.png" }]);
      assert.deepEqual(error.rollbackFailures, [{
        index: 0,
        filename: "first.png",
        operation: "remove-output",
        code: "EACCES",
      }]);
      assert.doesNotMatch(JSON.stringify({
        partialOutputs: error.partialOutputs,
        rollbackFailures: error.rollbackFailures,
      }), /\/private\/server\/path|wfl-image-atomic-save/);
      return true;
    },
  );

  assert.deepEqual(await fs.readdir(directory), ["first.png"]);
});

test("streams worker image files through O_NOFOLLOW and publishes their expected metadata", async (context) => {
  const directory = await temporaryDirectory(context);
  const sources = ["worker-1.png", "worker-2.png"].map((name) => path.join(directory, name));
  const targets = ["result-1.png", "result-2.png"].map((name) => path.join(directory, name));
  const images = [largeWorkerFixture(150_000, 1), largeWorkerFixture(170_000, 2)];
  await Promise.all(images.map((image, index) => fs.writeFile(sources[index], image)));

  const sourceFlags = [];
  let largestRead = 0;
  const fileSystem = Object.create(fs);
  fileSystem.open = async (filename, flags, ...rest) => {
    const handle = await fs.open(filename, flags, ...rest);
    if (!sources.includes(filename)) return handle;
    sourceFlags.push(flags);
    return {
      stat: (...arguments_) => handle.stat(...arguments_),
      read: async (buffer, offset, length, position) => {
        largestRead = Math.max(largestRead, length);
        return handle.read(buffer, offset, length, position);
      },
      close: (...arguments_) => handle.close(...arguments_),
    };
  };

  const expected = images.map((image, index) => expectedWorkerImage(image, 640 + index, 480 + index));
  const results = await publishImageFileBatch({
    outputs: sources.map((sourcePath, index) => ({
      sourcePath,
      targetPath: targets[index],
      expected: expected[index],
    })),
    maxBytesPerFile: 200_000,
    maxTotalBytes: 400_000,
  }, { fileSystem });

  assert.deepEqual(results, expected.map((metadata, index) => ({ path: targets[index], ...metadata })));
  assert.deepEqual(await fs.readFile(targets[0]), images[0]);
  assert.deepEqual(await fs.readFile(targets[1]), images[1]);
  assert.equal(sourceFlags.length, 2);
  for (const flags of sourceFlags) {
    assert.equal(typeof flags, "number");
    assert.equal((flags & fsConstants.O_NOFOLLOW) === fsConstants.O_NOFOLLOW, true);
  }
  assert.equal(largestRead <= 64 * 1024, true);
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "result-1.png", "result-2.png", "worker-1.png", "worker-2.png",
  ]);
});

test("rejects a symbolic-link worker source without creating a target or temporary file", async (context) => {
  const directory = await temporaryDirectory(context);
  const image = pngFixture(11, 9);
  const sourcePath = path.join(directory, "worker.png");
  const linkedPath = path.join(directory, "worker-link.png");
  const targetPath = path.join(directory, "result.png");
  await fs.writeFile(sourcePath, image);
  await fs.symlink("worker.png", linkedPath);

  await assert.rejects(
    publishImageFileBatch({
      outputs: [{
        sourcePath: linkedPath,
        targetPath,
        expected: expectedWorkerImage(image, 11, 9),
      }],
    }),
    (error) => error.code === "IMAGE_SOURCE_SYMLINK" && error.statusCode === 403,
  );

  assert.deepEqual((await fs.readdir(directory)).sort(), ["worker-link.png", "worker.png"]);
});

test("removes staged worker output when its digest does not match expected metadata", async (context) => {
  const directory = await temporaryDirectory(context);
  const image = pngFixture(14, 10);
  const sourcePath = path.join(directory, "worker.png");
  const targetPath = path.join(directory, "result.png");
  await fs.writeFile(sourcePath, image);
  const expected = expectedWorkerImage(image, 14, 10);
  expected.sha256 = "0".repeat(64);

  await assert.rejects(
    publishImageFileBatch({ outputs: [{ sourcePath, targetPath, expected }] }),
    (error) => error.code === "IMAGE_SOURCE_SHA256_MISMATCH" && error.statusCode === 409,
  );

  assert.deepEqual(await fs.readdir(directory), ["worker.png"]);
});

test("rejects a worker source when the streamed byte count differs from expected metadata", async (context) => {
  const directory = await temporaryDirectory(context);
  const image = pngFixture(15, 10);
  const sourcePath = path.join(directory, "worker.png");
  const targetPath = path.join(directory, "result.png");
  await fs.writeFile(sourcePath, image);
  const expected = expectedWorkerImage(Buffer.concat([image, Buffer.from([1])]), 15, 10);
  const fileSystem = Object.create(fs);
  fileSystem.open = async (filename, flags, ...rest) => {
    const handle = await fs.open(filename, flags, ...rest);
    if (filename !== sourcePath) return handle;
    return {
      stat: async () => ({ isFile: () => true, size: expected.size }),
      read: (...arguments_) => handle.read(...arguments_),
      close: (...arguments_) => handle.close(...arguments_),
    };
  };

  await assert.rejects(
    publishImageFileBatch({ outputs: [{ sourcePath, targetPath, expected }] }, { fileSystem }),
    (error) => error.code === "IMAGE_SOURCE_SIZE_MISMATCH"
      && error.expectedSize === expected.size
      && error.actualSize === image.length,
  );

  assert.deepEqual(await fs.readdir(directory), ["worker.png"]);
});

test("rolls back file-backed outputs and temporaries when the second commit fails", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = [pngFixture(17, 11), pngFixture(18, 12), pngFixture(19, 13)];
  const sources = images.map((_, index) => path.join(directory, `worker-${index + 1}.png`));
  const targets = images.map((_, index) => path.join(directory, `result-${index + 1}.png`));
  await Promise.all(images.map((image, index) => fs.writeFile(sources[index], image)));
  let linkCalls = 0;
  const fileSystem = Object.create(fs);
  fileSystem.link = async (...arguments_) => {
    linkCalls += 1;
    if (linkCalls === 2) {
      const error = new Error("injected second file commit failure");
      error.code = "EIO";
      throw error;
    }
    return fs.link(...arguments_);
  };

  await assert.rejects(
    publishImageFileBatch({
      outputs: images.map((image, index) => ({
        sourcePath: sources[index],
        targetPath: targets[index],
        expected: expectedWorkerImage(image, 17 + index, 11 + index),
      })),
    }, { fileSystem }),
    (error) => error.code === "EIO"
      && error.partialOutputs === undefined
      && error.rollbackFailures === undefined,
  );

  assert.equal(linkCalls, 2);
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "worker-1.png", "worker-2.png", "worker-3.png",
  ]);
});

test("validates all file metadata and byte limits before opening a worker source", async (context) => {
  const directory = await temporaryDirectory(context);
  const image = pngFixture(20, 14);
  const sourcePath = path.join(directory, "worker.png");
  await fs.writeFile(sourcePath, image);
  let opens = 0;
  const fileSystem = Object.create(fs);
  fileSystem.open = async (...arguments_) => {
    opens += 1;
    return fs.open(...arguments_);
  };

  await assert.rejects(
    publishImageFileBatch({
      outputs: [{
        sourcePath,
        targetPath: path.join(directory, "result.png"),
        expected: expectedWorkerImage(image, 20, 14),
      }],
      maxBytesPerFile: image.length - 1,
    }, { fileSystem }),
    (error) => error.code === "IMAGE_SOURCE_TOO_LARGE" && error.statusCode === 413,
  );

  assert.equal(opens, 0);
  assert.deepEqual(await fs.readdir(directory), ["worker.png"]);
});

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-atomic-save-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
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

function largeWorkerFixture(size, marker) {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < buffer.length; index += 1) buffer[index] = (index + marker) % 251;
  return buffer;
}

function expectedWorkerImage(image, width, height) {
  return {
    size: image.length,
    sha256: crypto.createHash("sha256").update(image).digest("hex"),
    format: "png",
    width,
    height,
    mediaType: "image/png",
  };
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
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
