import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readProcessStartTicks } from "../lib/restore-operation-lock.mjs";
import { RestoreSwapJournal } from "../lib/restore-swap-journal.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const crashWorker = path.join(projectDirectory, "test", "fixtures", "restore-journal-crash-worker.mjs");

test("SIGKILL after moving old data is recovered to one complete new generation", async () => {
  await fixture(async ({ runtimeDirectory, entry, journal }) => {
    const result = await crash(runtimeDirectory, "move-old");
    assert.equal(result.signal, "SIGKILL");
    assert.equal((await journal.read()).entries[0].step, "prepared");
    const recovered = await journal.recoverConsistentGeneration();
    assert.equal(recovered.generation, "new");
    assert.equal(await generation(entry.target), "new");
    assert.equal(await generation(entry.previous), "old");
  });
});

test("SIGKILL after activating new data is recovered to one complete new generation", async () => {
  await fixture(async ({ runtimeDirectory, entry, journal }) => {
    await journal.moveOriginalAside(0);
    const result = await crash(runtimeDirectory, "activate-new");
    assert.equal(result.signal, "SIGKILL");
    assert.equal((await journal.read()).entries[0].step, "old-moved");
    const recovered = await journal.recoverConsistentGeneration();
    assert.equal(recovered.generation, "new");
    assert.equal(await generation(entry.target), "new");
    assert.equal(await generation(entry.previous), "old");
  });
});

async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-sigkill-"));
  const runtimeDirectory = path.join(root, "runtime");
  const target = path.join(root, "state");
  const base = `${target}.wfl-restore-deadbeef00`;
  const entry = {
    target,
    replacement: `${base}.new`,
    previous: `${base}.old`,
    originalExisted: true,
  };
  await Promise.all([
    fs.mkdir(runtimeDirectory, { recursive: true }),
    writeGeneration(target, "old"),
    writeGeneration(entry.replacement, "new"),
  ]);
  const journal = new RestoreSwapJournal(runtimeDirectory);
  await journal.create({
    operationId: "restore-sigkill-test",
    unit: "wfl-codex-desktop-backend@4318.service",
    backupId: "b-20260101T000000Z-deadbeef",
    ownerPid: process.pid,
    ownerStartTicks: await readProcessStartTicks(process.pid),
    entries: [entry],
  });
  try {
    await operation({ runtimeDirectory, entry, journal });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function crash(runtimeDirectory, action) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashWorker], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        RESTORE_TEST_RUNTIME_DIR: runtimeDirectory,
        RESTORE_TEST_ACTION: action,
      },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function writeGeneration(directory, value) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "generation.txt"), `${value}\n`);
}

async function generation(directory) {
  return (await fs.readFile(path.join(directory, "generation.txt"), "utf8")).trim();
}
