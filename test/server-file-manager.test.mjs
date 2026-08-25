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
  readServerFile,
  renameServerFile,
  uploadServerFile,
  writeServerFile,
} from "../lib/server-file-manager.mjs";

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
