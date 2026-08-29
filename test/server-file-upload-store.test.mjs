import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseServerFileUploadRange,
  ServerFileUploadStore,
} from "../lib/server-file-upload-store.mjs";

test("parses server file upload ranges", () => {
  assert.deepEqual(parseServerFileUploadRange("bytes 0-3/10"), {
    start: 0,
    end: 3,
    total: 10,
    length: 4,
  });
  assert.deepEqual(parseServerFileUploadRange("bytes 4-9/10"), {
    start: 4,
    end: 9,
    total: 10,
    length: 6,
  });
  for (const value of ["bytes 1-0/10", "bytes 0-10/10", "bytes 0-3/0", "bytes 0-3,4-5/10"]) {
    assert.throws(
      () => parseServerFileUploadRange(value),
      (error) => error.statusCode === 400 && error.code === "SERVER_FILE_UPLOAD_RANGE_INVALID",
    );
  }
});

test("resumes a server file upload after store reinitialization and publishes atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-server-file-upload-"));
  const runtime = path.join(root, "runtime");
  try {
    const first = await new ServerFileUploadStore({ temporaryRoot: runtime, chunkBytes: 4, maxBytes: 64 }).initialize();
    const targetRoot = path.join(root, "target");
    await fs.mkdir(targetRoot);
    const started = await first.start({
      ownerId: "admin-1",
      parentPath: targetRoot,
      name: "payload.bin",
      totalBytes: 10,
      clientUploadId: "browser-upload-1",
    });
    assert.equal(started.uploadedBytes, 0);
    await first.append({
      uploadId: started.uploadId,
      ownerId: "admin-1",
      range: "bytes 0-3/10",
      source: Buffer.from("ABCD"),
    });
    assert.equal((await first.status({ uploadId: started.uploadId, ownerId: "admin-1" })).offset, 4);

    const second = await new ServerFileUploadStore({ temporaryRoot: runtime, chunkBytes: 4, maxBytes: 64 }).initialize();
    const restored = await second.status({ uploadId: started.uploadId, ownerId: "admin-1" });
    assert.equal(restored.offset, 4);
    await assert.rejects(
      () => second.append({
        uploadId: started.uploadId,
        ownerId: "admin-1",
        range: "bytes 0-3/10",
        source: Buffer.from("ABCD"),
      }),
      (error) => error.statusCode === 409 && error.code === "SERVER_FILE_UPLOAD_OFFSET_CONFLICT",
    );
    await second.append({
      uploadId: started.uploadId,
      ownerId: "admin-1",
      range: "bytes 4-7/10",
      source: Buffer.from("EFGH"),
    });
    const completed = await second.append({
      uploadId: started.uploadId,
      ownerId: "admin-1",
      range: "bytes 8-9/10",
      source: Buffer.from("IJ"),
    });
    assert.equal(completed.status, "complete");
    assert.equal(completed.entry.size, 10);
    assert.equal(await fs.readFile(path.join(targetRoot, "payload.bin"), "utf8"), "ABCDEFGHIJ");

    const sameUpload = await second.start({
      ownerId: "admin-1",
      parentPath: targetRoot,
      name: "payload.bin",
      totalBytes: 10,
      clientUploadId: "browser-upload-1",
    });
    assert.equal(sameUpload.uploadId, started.uploadId);
    await assert.rejects(
      () => second.start({
        ownerId: "admin-1",
        parentPath: targetRoot,
        name: "payload.bin",
        totalBytes: 10,
        clientUploadId: "browser-upload-2",
      }),
      (error) => error.statusCode === 409 && error.code === "SERVER_FILE_ALREADY_EXISTS",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("creates an empty file through the resumable start flow", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-server-file-upload-empty-"));
  const targetRoot = path.join(root, "target");
  try {
    await fs.mkdir(targetRoot);
    const store = await new ServerFileUploadStore({ temporaryRoot: path.join(root, "runtime") }).initialize();
    const upload = await store.start({ ownerId: "admin-1", parentPath: targetRoot, name: "empty.txt", totalBytes: 0 });
    assert.equal(upload.status, "complete");
    assert.equal((await fs.stat(path.join(targetRoot, "empty.txt"))).size, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
