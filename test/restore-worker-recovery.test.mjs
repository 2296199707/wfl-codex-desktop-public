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
const restoreScript = path.join(projectDirectory, "scripts", "restore-data-backup.mjs");
const readyFailureFixture = path.join(
  projectDirectory,
  "test",
  "fixtures",
  "restore-ready-failure.mjs",
);
const backupId = "b-20260101T000000Z-deadbeef";

test("a successful start followed by readiness failure never swaps away a complete old generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-worker-recovery-"));
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  const fakeBin = path.join(root, "bin");
  const systemctlLog = path.join(root, "systemctl.log");
  const activeMarker = path.join(root, "backend-active");
  const operationId = "restore-readiness-failure";
  const base = `${stateDirectory}.wfl-restore-deadbeef00`;
  const entry = {
    target: stateDirectory,
    replacement: `${base}.new`,
    previous: `${base}.old`,
    originalExisted: true,
  };

  await Promise.all([
    fs.mkdir(runtimeDirectory, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    writeGeneration(entry.target, "old"),
    writeGeneration(entry.replacement, "new"),
  ]);
  await fs.writeFile(path.join(fakeBin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$RESTORE_TEST_SYSTEMCTL_LOG"
case "$1" in
  start) : > "$RESTORE_TEST_ACTIVE_MARKER"; exit 0 ;;
  stop) rm -f "$RESTORE_TEST_ACTIVE_MARKER"; exit 0 ;;
  is-active)
    if [ -f "$RESTORE_TEST_ACTIVE_MARKER" ]; then printf '%s\\n' active; exit 0; fi
    printf '%s\\n' inactive; exit 3 ;;
esac
exit 0
`, { mode: 0o755 });

  const journal = new RestoreSwapJournal(runtimeDirectory);
  await journal.create({
    operationId,
    unit: "wfl-codex-desktop-backend@4318.service",
    backupId,
    ownerPid: process.pid,
    ownerStartTicks: await readProcessStartTicks(process.pid),
    entries: [entry],
  });
  await journal.setDesiredGeneration("old");

  try {
    const result = await runRestore({
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${readyFailureFixture}`,
      CODEX_DESKTOP_SOURCE_DIR: projectDirectory,
      CODEX_DESKTOP_RUNTIME_DIR: runtimeDirectory,
      CODEX_DESKTOP_STATE_DIR: stateDirectory,
      CODEX_DESKTOP_BACKUP_DIR: path.join(root, "backups"),
      CODEX_DESKTOP_PROJECT_ROOT: path.join(root, "projects"),
      CODEX_DESKTOP_MULTI_USER_ROOT: path.join(root, "users"),
      CODEX_DESKTOP_OWNER_CODEX_HOME: path.join(root, "owner-codex"),
      CODEX_DESKTOP_OPERATION_ID: operationId,
      CODEX_DESKTOP_RESTORE_RECOVERY_READY_TIMEOUT_MS: "25",
      RESTORE_TEST_SYSTEMCTL_LOG: systemctlLog,
      RESTORE_TEST_ACTIVE_MARKER: activeMarker,
    });

    assert.equal(result.code, 1, result.stderr);
    assert.match(await fs.readFile(systemctlLog, "utf8"), /start wfl-codex-desktop-backend@4318\.service/);
    assert.equal(await readGeneration(entry.target), "old");
    assert.equal(await readGeneration(entry.replacement), "new");
    await assert.rejects(fs.access(entry.previous), (error) => error.code === "ENOENT");
    const pending = await journal.read();
    assert.equal(pending.desiredGeneration, "old");
    assert.equal((await journal.inspectConsistency()).oldComplete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function runRestore(environment) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [restoreScript, backupId, "--worker"], {
      cwd: projectDirectory,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function writeGeneration(directory, value) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "generation.txt"), `${value}\n`);
}

async function readGeneration(directory) {
  return (await fs.readFile(path.join(directory, "generation.txt"), "utf8")).trim();
}
