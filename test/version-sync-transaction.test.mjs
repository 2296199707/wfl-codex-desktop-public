import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitVersionSyncTransaction } from "../lib/version-sync-transaction.mjs";

test("version synchronization rolls back every file when a commit fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-version-sync-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transactionPath = path.join(directory, "version-sync.transaction.json");
  const first = path.join(directory, "first.txt");
  const second = path.join(directory, "second.txt");
  await Promise.all([fs.writeFile(first, "old first\n"), fs.writeFile(second, "old second\n")]);

  await assert.rejects(
    commitVersionSyncTransaction({
      transactionPath,
      entries: [
        { destination: first, content: "new first\n" },
        { destination: second, content: "new second\n" },
      ],
      onEntryCommitted: (_entry, index) => {
        if (index === 0) throw new Error("simulated interrupted commit");
      },
    }),
    /simulated interrupted commit/u,
  );
  assert.equal(await fs.readFile(first, "utf8"), "old first\n");
  assert.equal(await fs.readFile(second, "utf8"), "old second\n");
  await assert.rejects(fs.access(transactionPath), { code: "ENOENT" });
});

test("version synchronization commits staged files as one recoverable journal", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-version-sync-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transactionPath = path.join(directory, "version-sync.transaction.json");
  const existing = path.join(directory, "existing.txt");
  const created = path.join(directory, "nested", "created.txt");
  await fs.writeFile(existing, "before\n");

  await commitVersionSyncTransaction({
    transactionPath,
    entries: [
      { destination: existing, content: "after\n" },
      { destination: created, content: "created\n" },
    ],
  });
  assert.equal(await fs.readFile(existing, "utf8"), "after\n");
  assert.equal(await fs.readFile(created, "utf8"), "created\n");
  await assert.rejects(fs.access(transactionPath), { code: "ENOENT" });
});
