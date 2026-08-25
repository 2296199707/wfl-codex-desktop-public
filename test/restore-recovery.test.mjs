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
const recoveryScript = path.join(projectDirectory, "scripts", "recover-data-restore.mjs");

test("candidate startup cannot mutate a prepared restore while an active backend still uses old data", async () => {
  await fixture(async ({ environment, entry }) => {
    const result = await runRecovery({ ...environment, FAKE_ACTIVE_MATCH: "backend@4318.service" });
    assert.equal(result.code, 1);
    assert.equal(await readGeneration(entry.target), "old");
    assert.equal(await readGeneration(entry.replacement), "new");
    await assert.rejects(fs.access(entry.previous), (error) => error.code === "ENOENT");
  });
});

test("boot recovery cannot mutate data while the legacy backend is active", async () => {
  await fixture(async ({ environment, entry }) => {
    const result = await runRecovery({ ...environment, FAKE_ACTIVE_MATCH: "wfl-codex-desktop.service" });
    assert.equal(result.code, 1);
    assert.equal(await readGeneration(entry.target), "old");
    assert.equal(await readGeneration(entry.replacement), "new");
    await assert.rejects(fs.access(entry.previous), (error) => error.code === "ENOENT");
  });
});

test("boot recovery completes the desired generation only when both backend slots are inactive", async () => {
  await fixture(async ({ environment, entry, runtimeDirectory }) => {
    const result = await runRecovery({
      ...environment,
      // Process startup can exceed the fixture's 40 ms blocker deadline while
      // the complete candidate suite is exercising systemd-heavy scenarios.
      CODEX_DESKTOP_RESTORE_RECOVERY_TIMEOUT_MS: "1000",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readGeneration(entry.target), "new");
    assert.equal(await readGeneration(entry.previous), "old");
    await assert.rejects(fs.access(entry.replacement), (error) => error.code === "ENOENT");
    const recovered = JSON.parse(await fs.readFile(
      path.join(runtimeDirectory, "backup-restore-swap.json"),
      "utf8",
    ));
    assert.equal(recovered.phase, "recovered-new");
  });
});

test("a temporary blocker is retried within one recovery ExecStart so the backend start can continue", async () => {
  await fixture(async ({ environment, entry, runtimeDirectory }) => {
    const parentLog = path.join(runtimeDirectory, "recovery-parents.log");
    const result = await runRecovery({
      ...environment,
      FAKE_ACTIVE_MATCH: "backend@4318.service",
      FAKE_ACTIVE_ONCE_MARKER: path.join(runtimeDirectory, "active-once"),
      FAKE_RECOVERY_PARENT_LOG: parentLog,
      CODEX_DESKTOP_RESTORE_RECOVERY_TIMEOUT_MS: "1000",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readGeneration(entry.target), "new");
    const parents = (await fs.readFile(parentLog, "utf8")).trim().split("\n");
    assert.ok(parents.length >= 6);
    assert.equal(new Set(parents).size, 1);
  });
});

async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-recovery-"));
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  const fakeBin = path.join(root, "bin");
  const suffix = `${stateDirectory}.wfl-restore-deadbeef00`;
  const entry = {
    target: stateDirectory,
    replacement: `${suffix}.new`,
    previous: `${suffix}.old`,
    originalExisted: true,
  };
  await Promise.all([
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    writeGeneration(entry.target, "old"),
    writeGeneration(entry.replacement, "new"),
  ]);
  await fs.writeFile(path.join(fakeBin, "systemctl"), `#!/bin/sh
if [ -n "${"${FAKE_RECOVERY_PARENT_LOG}"}" ]; then
  printf '%s\\n' "$PPID" >> "${"${FAKE_RECOVERY_PARENT_LOG}"}"
fi
if [ -n "${"${FAKE_ACTIVE_MATCH}"}" ]; then
  case "$*" in
    *"${"${FAKE_ACTIVE_MATCH}"}"*)
      if [ -z "${"${FAKE_ACTIVE_ONCE_MARKER}"}" ]; then
        printf '%s\\n' active
        exit 0
      fi
      if [ ! -e "${"${FAKE_ACTIVE_ONCE_MARKER}"}" ]; then
        : > "${"${FAKE_ACTIVE_ONCE_MARKER}"}"
        printf '%s\\n' active
        exit 0
      fi
      ;;
  esac
fi
printf '%s\\n' inactive
exit 3
`, { mode: 0o755 });
  const journal = new RestoreSwapJournal(runtimeDirectory);
  await journal.create({
    operationId: "restore-recovery-test",
    unit: "wfl-codex-desktop-backend@4318.service",
    backupId: "b-20260101T000000Z-deadbeef",
    ownerPid: process.pid,
    ownerStartTicks: await readProcessStartTicks(process.pid),
    entries: [entry],
  });
  try {
    await operation({
      entry,
      runtimeDirectory,
      environment: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CODEX_DESKTOP_SOURCE_DIR: projectDirectory,
        CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
        CODEX_DESKTOP_STATE_DIR: stateDirectory,
        CODEX_DESKTOP_PROJECT_ROOT: path.join(root, "projects"),
        CODEX_DESKTOP_MULTI_USER_ROOT: path.join(root, "users"),
        CODEX_DESKTOP_OWNER_CODEX_HOME: path.join(root, "owner-codex"),
        CODEX_DESKTOP_RESTORE_RECOVERY_TIMEOUT_MS: "40",
        CODEX_DESKTOP_RESTORE_RECOVERY_RETRY_MS: "5",
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runRecovery(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [recoveryScript], {
      cwd: projectDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function writeGeneration(directory, value) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "generation.txt"), `${value}\n`);
}

async function readGeneration(directory) {
  return (await fs.readFile(path.join(directory, "generation.txt"), "utf8")).trim();
}
