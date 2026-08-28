import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createServerFile,
  deleteServerFile,
  inspectServerFilePath,
  listServerDirectory,
  normalizeServerFilePath,
  parseServerFileRange,
  readServerFile,
  renameServerFile,
  serverFileDownloadTag,
  uploadServerFile,
  writeServerFile,
} from "../lib/server-file-manager.mjs";

test("parses resumable download ranges and rejects unsatisfiable ranges", () => {
  assert.equal(parseServerFileRange(undefined, 10), null);
  assert.deepEqual(parseServerFileRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseServerFileRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.deepEqual(parseServerFileRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseServerFileRange("bytes=0-99", 10), { start: 0, end: 9 });
  for (const value of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4"]) {
    assert.throws(
      () => parseServerFileRange(value, 10),
      (error) => error.statusCode === 416 && error.code === "SERVER_FILE_RANGE_INVALID",
    );
  }
  assert.throws(() => parseServerFileRange("bytes=0-", 0), (error) => error.statusCode === 416);
});

test("download tags change when file metadata changes", () => {
  const base = { dev: 1, ino: 2, size: 3, mtimeMs: 4 };
  assert.match(serverFileDownloadTag(base), /^"[a-f0-9]{64}"$/u);
  assert.notEqual(serverFileDownloadTag(base), serverFileDownloadTag({ ...base, size: 4 }));
});

test("server file manager supports bounded global file operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-server-files-"));
  try {
    assert.equal(normalizeServerFilePath(root), root);
    await assert.rejects(
      () => inspectServerFilePath(path.join(root, "missing", "file")),
      (error) => error.statusCode === 404,
    );

    const created = await createServerFile(root, "notes.txt", "file");
    assert.equal(created.type, "file");
    const empty = await readServerFile(created.path);
    assert.equal(empty.content, "");
    assert.equal(empty.editable, true);

    const updated = await writeServerFile(created.path, "hello\nworld", empty.version);
    assert.equal(updated.content, "hello\nworld");
    await assert.rejects(
      () => writeServerFile(created.path, "stale", empty.version),
      (error) => error.statusCode === 409,
    );

    const uploaded = await uploadServerFile(root, "upload.bin", Buffer.from([1, 2, 3]));
    assert.equal(uploaded.size, 3);
    const renamed = await renameServerFile(uploaded.path, "renamed.bin");
    assert.equal(path.basename(renamed.path), "renamed.bin");

    const folder = await createServerFile(root, "nested", "directory");
    await createServerFile(folder.path, "child.txt", "file");
    const page = await listServerDirectory(root, { offset: 0, limit: 2 });
    assert.equal(page.total, 3);
    assert.equal(page.entries.length, 2);
    assert.ok(page.entries.some((entry) => entry.type === "directory"));

    await deleteServerFile(folder.path, { recursive: true, confirmPath: folder.path });
    await assert.rejects(() => fs.lstat(folder.path), (error) => error.code === "ENOENT");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server file manager does not follow symlinks and protects filesystem roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-server-files-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-server-files-outside-"));
  try {
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "secret");
    const link = path.join(root, "secret-link");
    await fs.symlink(secret, link);
    const listing = await listServerDirectory(root);
    assert.equal(listing.entries.find((entry) => entry.name === "secret-link")?.type, "symlink");
    await assert.rejects(
      () => readServerFile(link),
      (error) => error.statusCode === 403,
    );
    await assert.rejects(
      () => deleteServerFile(path.parse(root).root, { recursive: true, confirmPath: path.parse(root).root }),
      (error) => error.code === "SERVER_FILE_ROOT_PROTECTED",
    );
    await deleteServerFile(link, { confirmPath: link });
    await assert.rejects(() => fs.lstat(link), (error) => error.code === "ENOENT");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
