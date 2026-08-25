import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mapAssetTransactionJournalPath,
  inspectMapAssetPublicationTransactions,
  recoverMapAssetPublicationTransactions,
  writeMapAssetTransactionJournal,
} from "../lib/map-asset-publication.mjs";

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-asset-recovery-"));
  const projectPath = path.join(root, "project");
  const temporaryRoot = path.join(root, "candidates");
  const candidateDirectory = path.join(temporaryRoot, "candidate-interrupted-test");
  await fs.mkdir(path.join(projectPath, "assets"), { recursive: true });
  await fs.mkdir(candidateDirectory, { recursive: true });
  try {
    await run({ projectPath, temporaryRoot, candidateDirectory });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function stagedEntry(projectPath, name, bytes, index, { link = false } = {}) {
  const targetPath = path.join(projectPath, "assets", name);
  const temporaryPath = path.join(path.dirname(targetPath), `.${name}.123.recovery.tmp`);
  await fs.writeFile(temporaryPath, bytes);
  const stat = await fs.stat(temporaryPath);
  if (link) await fs.link(temporaryPath, targetPath);
  return {
    index,
    targetPath,
    temporaryPath,
    device: String(stat.dev),
    inode: String(stat.ino),
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    linked: link,
  };
}

test("startup recovery rolls back an interrupted partial multi-file publication", async () => {
  await fixture(async ({ projectPath, temporaryRoot, candidateDirectory }) => {
    const first = await stagedEntry(projectPath, "plant.png", Buffer.from("image-bytes"), 0, { link: true });
    const second = await stagedEntry(projectPath, "plant.tsj", Buffer.from("tileset-bytes"), 1);
    const journalPath = mapAssetTransactionJournalPath(candidateDirectory);
    await writeMapAssetTransactionJournal({
      journalPath,
      projectPath,
      jobId: "interrupted-job",
      state: { phase: "linking", allLinked: false, entries: [first, second] },
    });

    const recovered = await recoverMapAssetPublicationTransactions({ temporaryRoot });
    assert.deepEqual(recovered, { recovered: 1, completed: 0, rolledBack: 1, failures: [] });
    for (const filename of [
      first.targetPath, first.temporaryPath, second.targetPath, second.temporaryPath, journalPath,
    ]) assert.equal(await fs.lstat(filename).catch(() => null), null, filename);
  });
});

test("startup recovery completes cleanup after every output was durably linked", async () => {
  await fixture(async ({ projectPath, temporaryRoot, candidateDirectory }) => {
    const firstBytes = Buffer.from("image-bytes");
    const secondBytes = Buffer.from("tileset-bytes");
    const first = await stagedEntry(projectPath, "plant.png", firstBytes, 0, { link: true });
    const second = await stagedEntry(projectPath, "plant.tsj", secondBytes, 1, { link: true });
    const journalPath = mapAssetTransactionJournalPath(candidateDirectory);
    await writeMapAssetTransactionJournal({
      journalPath,
      projectPath,
      jobId: "linked-job",
      state: { phase: "linked", allLinked: true, entries: [first, second] },
    });

    const recovered = await recoverMapAssetPublicationTransactions({ temporaryRoot });
    assert.deepEqual(recovered, { recovered: 1, completed: 1, rolledBack: 0, failures: [] });
    assert.deepEqual(await fs.readFile(first.targetPath), firstBytes);
    assert.deepEqual(await fs.readFile(second.targetPath), secondBytes);
    for (const filename of [first.temporaryPath, second.temporaryPath, journalPath]) {
      assert.equal(await fs.lstat(filename).catch(() => null), null, filename);
    }
  });
});

test("recovery leaves a replaced output untouched and reports the ownership mismatch", async () => {
  await fixture(async ({ projectPath, temporaryRoot, candidateDirectory }) => {
    const entry = await stagedEntry(projectPath, "plant.png", Buffer.from("candidate"), 0, { link: true });
    await fs.unlink(entry.targetPath);
    await fs.writeFile(entry.targetPath, "unrelated replacement");
    const journalPath = mapAssetTransactionJournalPath(candidateDirectory);
    await writeMapAssetTransactionJournal({
      journalPath,
      projectPath,
      jobId: "replaced-job",
      state: { phase: "linking", allLinked: false, entries: [entry] },
    });

    const recovered = await recoverMapAssetPublicationTransactions({ temporaryRoot });
    assert.equal(recovered.recovered, 0);
    assert.equal(recovered.failures.length, 1);
    assert.equal(await fs.readFile(entry.targetPath, "utf8"), "unrelated replacement");
    assert.notEqual(await fs.lstat(journalPath).catch(() => null), null);
  });
});

test("administrator inspection exposes bounded asset transaction metadata without absolute paths", async () => {
  await fixture(async ({ projectPath, temporaryRoot, candidateDirectory }) => {
    const entry = await stagedEntry(projectPath, "plant.png", Buffer.from("candidate"), 0, { link: true });
    await writeMapAssetTransactionJournal({
      journalPath: mapAssetTransactionJournalPath(candidateDirectory),
      projectPath,
      jobId: "job-redacted",
      state: { phase: "linking", allLinked: false, entries: [entry] },
    });
    const listed = await inspectMapAssetPublicationTransactions({ temporaryRoot, projectPath });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].transactionType, "asset-publication");
    assert.equal(listed[0].projectName, path.basename(projectPath));
    assert.equal(listed[0].fileCount, 1);
    assert.equal(listed[0].entries[0].targetPath, "assets/plant.png");
    assert.equal(JSON.stringify(listed).includes(projectPath), false);
    assert.equal(JSON.stringify(listed).includes(entry.temporaryPath), false);
  });
});

test("active publication candidates are skipped by inspection and recovery", async () => {
  await fixture(async ({ projectPath, temporaryRoot, candidateDirectory }) => {
    const entry = await stagedEntry(projectPath, "active.png", Buffer.from("candidate"), 0, { link: true });
    const journalPath = mapAssetTransactionJournalPath(candidateDirectory);
    await writeMapAssetTransactionJournal({
      journalPath,
      projectPath,
      jobId: "active-job",
      state: { phase: "linking", allLinked: false, entries: [entry] },
    });
    const listed = await inspectMapAssetPublicationTransactions({
      temporaryRoot,
      projectPath,
      protectedDirectories: [candidateDirectory],
    });
    assert.equal(listed[0].phase, "protected");
    const recovered = await recoverMapAssetPublicationTransactions({
      temporaryRoot,
      projectPath,
      protectedDirectories: [candidateDirectory],
    });
    assert.deepEqual(recovered, { recovered: 0, completed: 0, rolledBack: 0, failures: [] });
    assert.notEqual(await fs.lstat(journalPath).catch(() => null), null);
  });
});

test("corrupt publication journals remain visible and do not block recovery of other candidates", async () => {
  await fixture(async ({ projectPath, temporaryRoot, candidateDirectory }) => {
    const corruptDirectory = path.join(temporaryRoot, "candidate-corrupt");
    await fs.mkdir(corruptDirectory, { recursive: true });
    const corruptJournal = mapAssetTransactionJournalPath(corruptDirectory);
    await fs.writeFile(corruptJournal, "{not-json\n");

    const listed = await inspectMapAssetPublicationTransactions({ temporaryRoot, projectPath });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].phase, "invalid");
    assert.equal(listed[0].error.code, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID");

    const recovered = await recoverMapAssetPublicationTransactions({ temporaryRoot, projectPath });
    assert.equal(recovered.recovered, 0);
    assert.equal(recovered.failures.length, 1);
    assert.equal(recovered.failures[0].code, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID");
    assert.notEqual(await fs.lstat(corruptJournal).catch(() => null), null);
    assert.equal(await fs.lstat(mapAssetTransactionJournalPath(candidateDirectory)).catch(() => null), null);
  });
});
