import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProcessStartTicks } from "../lib/restore-operation-lock.mjs";
import { RestoreSwapJournal } from "../lib/restore-swap-journal.mjs";

test("recovers forward after a crash between moving old data and persisting the step", async () => {
  await fixture(1, async ({ runtimeDirectory, entries }) => {
    const crashing = journal(runtimeDirectory, ({ action }) => {
      if (action === "move-old") throw crashError();
    });
    await createJournal(crashing, entries);
    await assert.rejects(crashing.moveOriginalAside(0), /injected crash/);

    const recovered = journal(runtimeDirectory);
    assert.equal((await recovered.read()).entries[0].step, "prepared");
    const result = await recovered.recoverConsistentGeneration();
    assert.equal(result.generation, "new");
    await assertGeneration(entries, "new");
  });
});

test("recovers forward after a crash between activating new data and persisting the step", async () => {
  await fixture(1, async ({ runtimeDirectory, entries }) => {
    const crashing = journal(runtimeDirectory, ({ action }) => {
      if (action === "activate-new") throw crashError();
    });
    await createJournal(crashing, entries);
    await crashing.moveOriginalAside(0);
    await assert.rejects(crashing.activateReplacement(0), /injected crash/);

    const recovered = journal(runtimeDirectory);
    assert.equal((await recovered.read()).entries[0].step, "old-moved");
    const result = await recovered.recoverConsistentGeneration();
    assert.equal(result.generation, "new");
    await assertGeneration(entries, "new");
  });
});

test("finishes one generation after a crash halfway through multiple directory swaps", async () => {
  await fixture(3, async ({ runtimeDirectory, entries }) => {
    const crashing = journal(runtimeDirectory, ({ action, index }) => {
      if (action === "activate-new" && index === 1) throw crashError();
    });
    await createJournal(crashing, entries);
    await crashing.moveOriginalAside(0);
    await crashing.activateReplacement(0);
    await crashing.moveOriginalAside(1);
    await assert.rejects(crashing.activateReplacement(1), /injected crash/);

    const recovered = journal(runtimeDirectory);
    const result = await recovered.recoverConsistentGeneration();
    assert.equal(result.generation, "new");
    await assertGeneration(entries, "new");
    assert.equal((await recovered.inspectConsistency()).newComplete, true);
  });
});

test("falls back to a complete old generation when a new copy is unavailable", async () => {
  await fixture(2, async ({ runtimeDirectory, entries }) => {
    const active = journal(runtimeDirectory);
    await createJournal(active, entries);
    await active.moveOriginalAside(0);
    await fs.rm(entries[0].replacement, { recursive: true, force: true });

    const recovered = journal(runtimeDirectory);
    const result = await recovered.recoverConsistentGeneration();
    assert.equal(result.generation, "old");
    await assertGeneration(entries, "old");
    assert.equal((await recovered.inspectConsistency()).oldComplete, true);
  });
});

test("recovery fails closed when neither generation is complete", async () => {
  await fixture(2, async ({ runtimeDirectory, entries }) => {
    const active = journal(runtimeDirectory);
    await createJournal(active, entries);
    await active.moveOriginalAside(0);
    await fs.rm(entries[0].replacement, { recursive: true, force: true });
    await fs.rm(entries[1].target, { recursive: true, force: true });

    const recovered = journal(runtimeDirectory);
    await assert.rejects(
      recovered.recoverConsistentGeneration(),
      (error) => error.code === "ERR_RESTORE_GENERATION_INCOMPLETE",
    );
    await fs.access(path.join(runtimeDirectory, "backup-restore-swap.json"));
  });
});

async function fixture(count, operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-journal-"));
  const runtimeDirectory = path.join(root, "runtime");
  const dataDirectory = path.join(root, "data");
  await Promise.all([
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(dataDirectory, { recursive: true }),
  ]);
  const entries = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const target = path.join(dataDirectory, `scope-${index}`);
      const base = `${target}.wfl-restore-deadbeef${index}`;
      const replacement = `${base}.new`;
      const previous = `${base}.old`;
      await writeGeneration(target, `old-${index}`);
      await writeGeneration(replacement, `new-${index}`);
      entries.push({ target, replacement, previous, originalExisted: true });
    }
    await operation({ root, runtimeDirectory, entries });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function journal(runtimeDirectory, afterRename = async () => {}) {
  return new RestoreSwapJournal(runtimeDirectory, { afterRename });
}

async function createJournal(instance, entries) {
  await instance.create({
    operationId: "restore-test-operation",
    unit: "wfl-codex-desktop-backend@4318.service",
    backupId: "b-20260101T000000Z-deadbeef",
    ownerPid: process.pid,
    ownerStartTicks: await readProcessStartTicks(process.pid),
    entries,
  });
}

async function assertGeneration(entries, generation) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (generation === "new") {
      assert.equal(await readGeneration(entry.target), `new-${index}`);
      await fs.access(entry.previous);
      await assert.rejects(fs.access(entry.replacement), (error) => error.code === "ENOENT");
    } else {
      assert.equal(await readGeneration(entry.target), `old-${index}`);
    }
  }
}

async function writeGeneration(directory, value) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "generation.txt"), `${value}\n`);
}

async function readGeneration(directory) {
  return (await fs.readFile(path.join(directory, "generation.txt"), "utf8")).trim();
}

function crashError() {
  return new Error("injected crash after durable rename");
}
