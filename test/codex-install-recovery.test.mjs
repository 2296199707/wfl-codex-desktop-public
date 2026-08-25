import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commitCodexInstallRecovery,
  commitCodexInstallRollback,
  completeCodexInstallRecovery,
  holdCodexInstallRecoveryForDecision,
  prepareCodexInstallRecovery,
  readCodexInstallRecovery,
  restoreCodexInstallRecovery,
  verifyCodexInstallRecoverySelection,
} from "../lib/codex-install-recovery.mjs";
import { readProcessStartTicks } from "../lib/operation-lock.mjs";

const recoveryScript = fileURLToPath(new URL("../scripts/recover-codex-update.mjs", import.meta.url));
const crashWorker = fileURLToPath(new URL("fixtures/codex-update-crash-worker.mjs", import.meta.url));
const codexUpdateScript = fileURLToPath(new URL("../scripts/update-codex.mjs", import.meta.url));
const recoverySource = await fs.readFile(recoveryScript, "utf8");
const updaterSource = await fs.readFile(new URL("../scripts/update-codex.mjs", import.meta.url), "utf8");

test("rejects an unowned Codex executable before creating a recovery journal", async () => {
  await withFixture(async (fixture) => {
    const unowned = path.join(fixture.root, "codex-custom");
    await fs.writeFile(unowned, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await assert.rejects(
      prepareCodexInstallRecovery({
        runtimeDirectory: fixture.runtimeDirectory,
        operationId: "codex-reject-custom",
        command: unowned,
        versionOutput: "codex-cli 1.2.3",
        appVersion: "0.37.1",
        syncPath: async () => {},
      }),
      /official Codex command symlink/,
    );
    assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
  });
});

test("restores the complete official npm package and exact version without network access", async () => {
  await withFixture(async (fixture) => {
    const journal = await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-offline-restore",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    await installFakeVersion(fixture.packageRoot, fixture.afterVersion);
    await fs.writeFile(path.join(fixture.nativePackageRoot, "new-only.txt"), "new native\n");
    await fs.writeFile(path.join(fixture.packageRoot, "new-only.txt"), "new\n");
    await fs.rm(fixture.commandPath);
    await fs.symlink("../broken/codex.js", fixture.commandPath);

    const result = await restoreCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      syncPath: async () => {},
    });
    assert.equal(result.restored, true);
    assert.equal(result.journal.state, "package-restored");
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version, fixture.beforeVersion);
    assert.equal(await fs.readFile(path.join(fixture.packageRoot, "old-only.txt"), "utf8"), "verified old package\n");
    await assert.rejects(fs.access(path.join(fixture.packageRoot, "new-only.txt")), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture.nativePackageRoot, "package.json"), "utf8")).version,
      fixture.beforeVersion,
    );
    await assert.rejects(fs.access(path.join(fixture.nativePackageRoot, "new-only.txt")), { code: "ENOENT" });
    assert.equal(await fs.realpath(fixture.commandPath), path.join(fixture.packageRoot, "bin", "codex.js"));
    assert.equal(await fs.readFile(journal.backupPath, "utf8").catch((error) => error.code), "EISDIR");

    const committed = await commitCodexInstallRollback(fixture.runtimeDirectory);
    assert.equal(committed.state, "rollback-committed");
    assert.equal(await completeCodexInstallRecovery(fixture.runtimeDirectory), true);
    assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
    await assert.rejects(fs.access(journal.backupPath), { code: "ENOENT" });
  });
});

test("keeps the previous CLI recoverable while an owner decision is pending", async () => {
  await withFixture(async (fixture) => {
    await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-owner-decision",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    await installFakeVersion(fixture.packageRoot, fixture.afterVersion);
    const pending = await holdCodexInstallRecoveryForDecision(
      fixture.runtimeDirectory,
      `codex-cli ${fixture.afterVersion}`,
    );
    assert.equal(pending.state, "decision-pending");
    assert.equal(pending.afterVersion, fixture.afterVersion);
    await assert.rejects(
      completeCodexInstallRecovery(fixture.runtimeDirectory),
      /outcome must be committed/,
    );

    const restored = await restoreCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      syncPath: async () => {},
    });
    assert.equal(restored.journal.state, "package-restored");
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version,
      fixture.beforeVersion,
    );
    await commitCodexInstallRollback(fixture.runtimeDirectory);
    await completeCodexInstallRecovery(fixture.runtimeDirectory);
  });
});

test("continues to recover legacy npm journals created before standalone support", async () => {
  await withFixture(async (fixture) => {
    const journal = await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-legacy-npm-journal",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    const legacy = { ...journal, schemaVersion: 1 };
    delete legacy.installationKind;
    delete legacy.storageRoot;
    await fs.writeFile(
      path.join(fixture.runtimeDirectory, "codex-install-recovery.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      { mode: 0o600 },
    );

    const loaded = await readCodexInstallRecovery(fixture.runtimeDirectory);
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(loaded.installationKind, "npm");
    assert.equal(loaded.storageRoot, fixture.globalModulesRoot);
    await restoreCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      syncPath: async () => {},
    });
    await commitCodexInstallRollback(fixture.runtimeDirectory);
    assert.equal(await completeCodexInstallRecovery(fixture.runtimeDirectory), true);
  });
});

test("restores an official standalone release and both selectors without network access", async () => {
  await withStandaloneFixture(async (fixture) => {
    const journal = await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-standalone-offline-restore",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    assert.equal(journal.installationKind, "standalone");
    assert.equal(journal.storageRoot, fixture.releasesRoot);
    assert.equal(journal.selectorPath, fixture.selectorPath);

    const updatedRoot = await selectFakeStandaloneVersion(fixture, fixture.afterVersion);
    await fs.rm(fixture.packageRoot, { recursive: true, force: true });
    assert.equal(await fs.realpath(fixture.commandPath), path.join(updatedRoot, "bin", "codex"));

    const result = await restoreCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      syncPath: async () => {},
    });
    assert.equal(result.restored, true);
    assert.equal(result.journal.state, "package-restored");
    assert.equal(await fs.realpath(fixture.selectorPath), fixture.packageRoot);
    assert.equal(await fs.realpath(fixture.commandPath), path.join(fixture.packageRoot, "bin", "codex"));
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "codex-package.json"), "utf8")).version,
      fixture.beforeVersion,
    );
    assert.equal(await fs.readFile(path.join(fixture.packageRoot, "old-only.txt"), "utf8"), "verified old release\n");
    await fs.access(updatedRoot);

    const committed = await commitCodexInstallRollback(fixture.runtimeDirectory);
    assert.equal(committed.state, "rollback-committed");
    assert.equal(await completeCodexInstallRecovery(fixture.runtimeDirectory), true);
    await assert.rejects(fs.access(journal.backupPath), { code: "ENOENT" });
  });
});

test("standalone rollback verifies the restored native entrypoint directly", async () => {
  await withStandaloneFixture(async (fixture) => {
    await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-standalone-direct-exec",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    await selectFakeStandaloneVersion(fixture, fixture.afterVersion);
    await fs.rm(fixture.packageRoot, { recursive: true, force: true });
    const inspections = [];

    await restoreCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      inspectInstallation: async (options) => {
        inspections.push(options);
        return { version: `codex-cli ${fixture.beforeVersion}`, appServerReady: true };
      },
      syncPath: async () => {},
    });

    assert.deepEqual(inspections, [{
      command: path.join(fixture.packageRoot, "bin", "codex"),
    }]);
    assert.notEqual(inspections[0].command, process.execPath);
    assert.equal(inspections[0].commandArgs, undefined);
  });
});

test("an active standalone update handoff verifies the selected release instead of the old directory", async () => {
  await withStandaloneFixture(async (fixture) => {
    const operationId = "codex-standalone-active-handoff";
    const journal = await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId,
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    const updatedRoot = await selectFakeStandaloneVersion(fixture, fixture.afterVersion);
    const owner = await startCodexUpdateOwner();
    try {
      await writeCodexUpdateLock(fixture.runtimeDirectory, owner, operationId);
      const recovered = await runRecovery(fixture);
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.match(recovered.stdout, /Active Codex update handoff verified/);
      assert.equal((await readCodexInstallRecovery(fixture.runtimeDirectory)).state, "prepared");
      assert.equal(await fs.realpath(fixture.selectorPath), updatedRoot);
      assert.equal(await fs.realpath(fixture.commandPath), path.join(updatedRoot, "bin", "codex"));
      await fs.access(journal.backupPath);
    } finally {
      await stopCodexUpdateOwner(owner);
    }
  });
});

test("standalone updates validate the newly selected release and survive committed cleanup", async () => {
  await withStandaloneFixture(async (fixture) => {
    const journal = await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-standalone-committed-update",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    const updatedRoot = await selectFakeStandaloneVersion(fixture, fixture.afterVersion);
    const selected = await verifyCodexInstallRecoverySelection(
      journal,
      `codex-cli ${fixture.afterVersion}`,
    );
    assert.equal(selected.packageRoot, updatedRoot);
    assert.equal(selected.installationKind, "standalone");
    await commitCodexInstallRecovery(fixture.runtimeDirectory, `codex-cli ${fixture.afterVersion}`);

    const recovered = await runRecovery(fixture);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, new RegExp(`Completed interrupted Codex update cleanup at codex-cli ${fixture.afterVersion}`));
    assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
    assert.equal(await fs.realpath(fixture.selectorPath), updatedRoot);
    assert.equal(await fs.realpath(fixture.commandPath), path.join(updatedRoot, "bin", "codex"));
    await assert.rejects(fs.access(journal.backupPath), { code: "ENOENT" });
  });
});

test("cleanup refuses to infer an outcome from an intermediate recovery state", async () => {
  await withFixture(async (fixture) => {
    await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-explicit-outcome",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });

    await assert.rejects(
      completeCodexInstallRecovery(fixture.runtimeDirectory),
      /outcome must be committed before cleanup/,
    );
    assert.equal((await readCodexInstallRecovery(fixture.runtimeDirectory)).state, "prepared");
  });
});

test("a matching active Codex update hands a verified changed CLI through the recovery gate", async () => {
  await withFixture(async (fixture) => {
    const operationId = "codex-active-update-handoff";
    const journal = await prepareUpdatedFixture(fixture, operationId);
    const owner = await startCodexUpdateOwner();
    try {
      await writeCodexUpdateLock(fixture.runtimeDirectory, owner, operationId);
      const beforeJournal = await fs.readFile(
        path.join(fixture.runtimeDirectory, "codex-install-recovery.json"),
        "utf8",
      );

      const recovered = await runRecovery(fixture);
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.match(recovered.stdout, /Active Codex update handoff verified/);
      assert.equal(
        await fs.readFile(path.join(fixture.runtimeDirectory, "codex-install-recovery.json"), "utf8"),
        beforeJournal,
      );
      assert.equal((await readCodexInstallRecovery(fixture.runtimeDirectory)).state, "prepared");
      assert.equal(
        JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version,
        fixture.afterVersion,
      );
      await fs.access(journal.backupPath);
      await assert.rejects(
        fs.access(path.join(fixture.stateDirectory, "codex-update-status.json")),
        { code: "ENOENT" },
      );
    } finally {
      await stopCodexUpdateOwner(owner);
    }
  });
});

test("a Codex update lock for another operation cannot hand off a prepared journal", async () => {
  await withFixture(async (fixture) => {
    const operationId = "codex-mismatched-update-handoff";
    await prepareUpdatedFixture(fixture, operationId);
    const owner = await startCodexUpdateOwner();
    try {
      await writeCodexUpdateLock(fixture.runtimeDirectory, owner, `${operationId}-other`);
      await assertGateRejected(
        fixture,
        await runRecovery(fixture),
        /active Codex update does not own/i,
      );
    } finally {
      await stopCodexUpdateOwner(owner);
    }
  });
});

test("a stale Codex update process fingerprint cannot hand off a prepared journal", async () => {
  await withFixture(async (fixture) => {
    const operationId = "codex-stale-update-handoff";
    await prepareUpdatedFixture(fixture, operationId);
    const owner = await startCodexUpdateOwner();
    try {
      await writeCodexUpdateLock(fixture.runtimeDirectory, owner, operationId, {
        startTicks: String(BigInt(owner.startTicks) + 1n),
      });
      await assertInterruptedRecovery(fixture, await runRecovery(fixture));
    } finally {
      await stopCodexUpdateOwner(owner);
    }
  });
});

test("an unchanged CLI cannot use an active update lock to bypass recovery", async () => {
  await withFixture(async (fixture) => {
    const operationId = "codex-unchanged-update-handoff";
    await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId,
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    const owner = await startCodexUpdateOwner();
    try {
      await writeCodexUpdateLock(fixture.runtimeDirectory, owner, operationId);
      await assertGateRejected(
        fixture,
        await runRecovery(fixture),
        /has not installed a changed CLI/i,
        { expectedVersion: fixture.beforeVersion },
      );
    } finally {
      await stopCodexUpdateOwner(owner);
    }
  });
});

test("a changed CLI without app-server cannot use an active update handoff", async () => {
  await withFixture(async (fixture) => {
    const operationId = "codex-invalid-update-handoff";
    await prepareUpdatedFixture(fixture, operationId, { appServerReady: false });
    const owner = await startCodexUpdateOwner();
    try {
      await writeCodexUpdateLock(fixture.runtimeDirectory, owner, operationId);
      await assertGateRejected(
        fixture,
        await runRecovery(fixture),
        /handoff verification failed/i,
      );
    } finally {
      await stopCodexUpdateOwner(owner);
    }
  });
});

test("an unverifiable Codex update lock fails closed without consuming recovery", async () => {
  await withFixture(async (fixture) => {
    const operationId = "codex-unknown-update-handoff";
    await prepareUpdatedFixture(fixture, operationId);
    await fs.writeFile(
      path.join(fixture.runtimeDirectory, "codex-update.lock"),
      "{}\n",
      { mode: 0o600 },
    );

    await assertGateRejected(
      fixture,
      await runRecovery(fixture),
      /Cannot verify the Codex update lock owner/i,
    );
  });
});

test("SIGKILL recovery restores and verifies the CLI without depending on backend topology", async () => {
  await withFixture(async (fixture) => {
    const operationId = `codex-sigkill-${Date.now()}`;
    const worker = spawn(process.execPath, [crashWorker], {
      env: {
        ...process.env,
        TEST_RUNTIME_DIR: fixture.runtimeDirectory,
        TEST_OPERATION_ID: operationId,
        TEST_CODEX_COMMAND: fixture.commandPath,
        TEST_CODEX_PACKAGE_ROOT: fixture.packageRoot,
        TEST_BEFORE_VERSION: fixture.beforeVersion,
        TEST_AFTER_VERSION: fixture.afterVersion,
        TEST_APP_VERSION: fixture.appVersion,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const workerExit = waitForExit(worker);
    await waitForOutput(worker, "READY");
    worker.kill("SIGKILL");
    const killed = await workerExit;
    assert.equal(killed.signal, "SIGKILL");
    assert.equal((await readCodexInstallRecovery(fixture.runtimeDirectory)).state, "prepared");
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version, fixture.afterVersion);

    const recovered = await run(recoveryScript, {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      CODEX_DESKTOP_SOURCE_DIR: fixture.root,
      CODEX_DESKTOP_RUNTIME_DIR: fixture.runtimeDirectory,
      CODEX_DESKTOP_STATE_DIR: fixture.stateDirectory,
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, new RegExp(`Recovered Codex CLI ${fixture.beforeVersion}`));
    assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version, fixture.beforeVersion);
    assert.equal(await fs.realpath(fixture.commandPath), path.join(fixture.packageRoot, "bin", "codex.js"));
    const status = JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, "codex-update-status.json"), "utf8"));
    assert.equal(status.phase, "recovered");
    assert.match(status.detail, /已安全恢复并复验 codex-cli/);
  });
});

test("SIGKILL during committed update cleanup keeps the verified new CLI", async () => {
  await withFixture(async (fixture) => {
    const worker = spawn(process.execPath, [crashWorker], {
      env: {
        ...process.env,
        TEST_RUNTIME_DIR: fixture.runtimeDirectory,
        TEST_OPERATION_ID: "codex-committed-cleanup",
        TEST_CODEX_COMMAND: fixture.commandPath,
        TEST_CODEX_PACKAGE_ROOT: fixture.packageRoot,
        TEST_BEFORE_VERSION: fixture.beforeVersion,
        TEST_AFTER_VERSION: fixture.afterVersion,
        TEST_APP_VERSION: fixture.appVersion,
        TEST_CRASH_MODE: "update-cleanup",
        TEST_STATE_DIR: fixture.stateDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const workerExit = waitForExit(worker);
    await waitForOutput(worker, "READY");
    worker.kill("SIGKILL");
    assert.equal((await workerExit).signal, "SIGKILL");
    const journal = await readCodexInstallRecovery(fixture.runtimeDirectory);
    assert.equal(journal.state, "update-committed");
    assert.equal(journal.afterVersion, fixture.afterVersion);
    await assert.rejects(fs.access(journal.backupPath), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, "codex-update-status.json"), "utf8")).phase,
      "completed",
    );

    const recovered = await run(recoveryScript, {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      CODEX_DESKTOP_SOURCE_DIR: fixture.root,
      CODEX_DESKTOP_RUNTIME_DIR: fixture.runtimeDirectory,
      CODEX_DESKTOP_STATE_DIR: fixture.stateDirectory,
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, new RegExp(`Completed interrupted Codex update cleanup at codex-cli ${fixture.afterVersion}`));
    assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version, fixture.afterVersion);
    await assert.rejects(fs.access(journal.backupPath), { code: "ENOENT" });
    const status = JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, "codex-update-status.json"), "utf8"));
    assert.equal(status.phase, "completed");
    assert.equal(status.beforeVersion, `codex-cli ${fixture.beforeVersion}`);
    assert.equal(status.afterVersion, `codex-cli ${fixture.afterVersion}`);
  });
});

test("committed update recovery rejects a different valid CLI version", async () => {
  await withFixture(async (fixture) => {
    await prepareCodexInstallRecovery({
      runtimeDirectory: fixture.runtimeDirectory,
      operationId: "codex-committed-version-mismatch",
      command: fixture.commandPath,
      versionOutput: `codex-cli ${fixture.beforeVersion}`,
      appVersion: fixture.appVersion,
      syncPath: async () => {},
    });
    await installFakeVersion(fixture.packageRoot, fixture.afterVersion);
    await commitCodexInstallRecovery(
      fixture.runtimeDirectory,
      `codex-cli ${fixture.afterVersion}`,
    );
    await installFakeVersion(fixture.packageRoot, "8.8.8");

    const recovered = await run(recoveryScript, {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      CODEX_DESKTOP_SOURCE_DIR: fixture.root,
      CODEX_DESKTOP_RUNTIME_DIR: fixture.runtimeDirectory,
      CODEX_DESKTOP_STATE_DIR: fixture.stateDirectory,
    });
    assert.notEqual(recovered.code, 0);
    assert.match(recovered.stderr, /version does not match the recovery journal/);
    assert.equal((await readCodexInstallRecovery(fixture.runtimeDirectory)).state, "update-committed");
    await assert.rejects(fs.access(path.join(fixture.stateDirectory, "codex-update-status.json")), { code: "ENOENT" });
  });
});

test("SIGKILL during committed rollback cleanup preserves failure and the verified old CLI", async () => {
  await withFixture(async (fixture) => {
    const worker = spawn(process.execPath, [crashWorker], {
      env: {
        ...process.env,
        TEST_RUNTIME_DIR: fixture.runtimeDirectory,
        TEST_OPERATION_ID: "codex-rollback-cleanup",
        TEST_CODEX_COMMAND: fixture.commandPath,
        TEST_CODEX_PACKAGE_ROOT: fixture.packageRoot,
        TEST_BEFORE_VERSION: fixture.beforeVersion,
        TEST_AFTER_VERSION: fixture.afterVersion,
        TEST_APP_VERSION: fixture.appVersion,
        TEST_CRASH_MODE: "rollback-cleanup",
        TEST_STATE_DIR: fixture.stateDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const workerExit = waitForExit(worker);
    await waitForOutput(worker, "READY");
    worker.kill("SIGKILL");
    assert.equal((await workerExit).signal, "SIGKILL");
    const journal = await readCodexInstallRecovery(fixture.runtimeDirectory);
    assert.equal(journal.state, "rollback-committed");
    await assert.rejects(fs.access(journal.backupPath), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, "codex-update-status.json"), "utf8")).phase,
      "failed",
    );

    const recovered = await run(recoveryScript, {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      CODEX_DESKTOP_SOURCE_DIR: fixture.root,
      CODEX_DESKTOP_RUNTIME_DIR: fixture.runtimeDirectory,
      CODEX_DESKTOP_STATE_DIR: fixture.stateDirectory,
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, new RegExp(`Recovered Codex CLI ${fixture.beforeVersion}`));
    assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version, fixture.beforeVersion);
    const status = JSON.parse(await fs.readFile(path.join(fixture.stateDirectory, "codex-update-status.json"), "utf8"));
    assert.equal(status.phase, "recovered");
    assert.match(status.detail, /已安全恢复并复验 codex-cli/);
  });
});

test("the Codex recovery gate does not depend on gateway or backend service startup", () => {
  assert.doesNotMatch(recoverySource, /deploy\.mjs|systemctl|\/internal\/(?:codex|gateway)-ready|\bfetch\s*\(/);
});

test("terminal update status is durable before committed recovery journals are removed", () => {
  const firstRecoveryStatus = recoverySource.indexOf("statusStore.write");
  const firstRecoveryCleanup = recoverySource.indexOf("completeCodexInstallRecovery", firstRecoveryStatus);
  const secondRecoveryStatus = recoverySource.indexOf("statusStore.write", firstRecoveryStatus + 1);
  const secondRecoveryCleanup = recoverySource.indexOf("completeCodexInstallRecovery", secondRecoveryStatus);
  assert.ok(firstRecoveryStatus < firstRecoveryCleanup);
  assert.ok(secondRecoveryStatus < secondRecoveryCleanup);

  const noChange = updaterSource.slice(
    updaterSource.indexOf("if (before.version === after.version)"),
    updaterSource.indexOf("await assertNotCancelled", updaterSource.indexOf("if (before.version === after.version)")),
  );
  assert.match(noChange, /if \(!await commitCodexInstallRecovery\(runtimeDir, after\.version\)\)/);
  assert.ok(noChange.indexOf("await complete({") < noChange.indexOf("completeCodexInstallRecovery"));

  const successfulUpdate = updaterSource.slice(
    updaterSource.indexOf("const activePort = await verifyDeployment"),
    updaterSource.indexOf("} catch (error) {", updaterSource.indexOf("const activePort = await verifyDeployment")),
  );
  assert.ok(successfulUpdate.indexOf("await complete({") < successfulUpdate.indexOf("completeCodexInstallRecovery"));

  const failedUpdateStart = updaterSource.indexOf(
    "} catch (error) {",
    updaterSource.indexOf("const activePort = await verifyDeployment"),
  );
  const failedUpdate = updaterSource.slice(
    failedUpdateStart,
    updaterSource.indexOf("} finally {", failedUpdateStart),
  );
  assert.ok(failedUpdate.indexOf("await fail(") < failedUpdate.indexOf("completeCodexInstallRecovery"));
  assert.doesNotMatch(updaterSource.match(/async function fail[\s\S]*?\n\}/)?.[0] || "", /\.catch\(/);
});

async function prepareUpdatedFixture(fixture, operationId, options = {}) {
  const journal = await prepareCodexInstallRecovery({
    runtimeDirectory: fixture.runtimeDirectory,
    operationId,
    command: fixture.commandPath,
    versionOutput: `codex-cli ${fixture.beforeVersion}`,
    appVersion: fixture.appVersion,
    syncPath: async () => {},
  });
  await installFakeVersion(fixture.packageRoot, fixture.afterVersion, options);
  return journal;
}

function runRecovery(fixture) {
  return run(recoveryScript, {
    ...process.env,
    PATH: `${fixture.binDirectory}:${process.env.PATH}`,
    CODEX_DESKTOP_SOURCE_DIR: fixture.root,
    CODEX_DESKTOP_RUNTIME_DIR: fixture.runtimeDirectory,
    CODEX_DESKTOP_STATE_DIR: fixture.stateDirectory,
  });
}

async function assertInterruptedRecovery(fixture, recovered) {
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.doesNotMatch(recovered.stdout, /Active Codex update handoff verified/);
  assert.match(recovered.stdout, new RegExp(`Recovered Codex CLI ${fixture.beforeVersion}`));
  assert.equal(await readCodexInstallRecovery(fixture.runtimeDirectory), null);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version,
    fixture.beforeVersion,
  );
  const status = JSON.parse(await fs.readFile(
    path.join(fixture.stateDirectory, "codex-update-status.json"),
    "utf8",
  ));
  assert.equal(status.phase, "recovered");
}

async function assertGateRejected(
  fixture,
  recovered,
  errorPattern,
  { expectedVersion = fixture.afterVersion } = {},
) {
  assert.notEqual(recovered.code, 0);
  assert.match(recovered.stderr, errorPattern);
  assert.doesNotMatch(recovered.stdout, /Active Codex update handoff verified/);
  const journal = await readCodexInstallRecovery(fixture.runtimeDirectory);
  assert.equal(journal.state, "prepared");
  await fs.access(journal.backupPath);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).version,
    expectedVersion,
  );
  await assert.rejects(
    fs.access(path.join(fixture.stateDirectory, "codex-update-status.json")),
    { code: "ENOENT" },
  );
}

async function startCodexUpdateOwner() {
  const child = spawn(process.execPath, [
    "-e",
    'process.stdout.write("READY\\n"); setInterval(() => {}, 60_000);',
    codexUpdateScript,
    "--worker",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = waitForExit(child);
  try {
    await waitForOutput(child, "READY");
    const startTicks = await readProcessStartTicks(child.pid);
    assert.match(startTicks, /^\d+$/);
    return { child, exit, startTicks };
  } catch (error) {
    child.kill("SIGKILL");
    await exit.catch(() => {});
    throw error;
  }
}

async function stopCodexUpdateOwner(owner) {
  owner.child.kill("SIGKILL");
  await owner.exit;
}

async function writeCodexUpdateLock(runtimeDirectory, owner, operationId, overrides = {}) {
  const record = {
    schemaVersion: 1,
    token: crypto.randomUUID(),
    pid: owner.child.pid,
    startTicks: owner.startTicks,
    operationId,
    ownerCommand: "scripts/update-codex.mjs",
    createdAt: Date.now(),
    ...overrides,
  };
  await fs.writeFile(
    path.join(runtimeDirectory, "codex-update.lock"),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
}

async function withFixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-install-recovery-"));
  const globalModulesRoot = path.join(root, "global", "lib", "node_modules");
  const packageRoot = path.join(globalModulesRoot, "@openai", "codex");
  const nativePackageRoot = path.join(globalModulesRoot, "@openai", "codex-linux-x64");
  const binDirectory = path.join(root, "global", "bin");
  const commandPath = path.join(binDirectory, "codex");
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  const beforeVersion = "1.2.3";
  const afterVersion = "9.9.9";
  const appVersion = "0.37.1";
  try {
    await Promise.all([
      fs.mkdir(binDirectory, { recursive: true }),
      fs.mkdir(runtimeDirectory, { recursive: true }),
      fs.mkdir(stateDirectory, { recursive: true }),
    ]);
    await installFakeVersion(packageRoot, beforeVersion);
    await fs.writeFile(path.join(packageRoot, "old-only.txt"), "verified old package\n");
    await fs.symlink("../lib/node_modules/@openai/codex/bin/codex.js", commandPath);
    await operation({
      root,
      globalModulesRoot,
      packageRoot,
      nativePackageRoot,
      binDirectory,
      commandPath,
      runtimeDirectory,
      stateDirectory,
      beforeVersion,
      afterVersion,
      appVersion,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withStandaloneFixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-standalone-recovery-"));
  const standaloneRoot = path.join(root, ".codex", "packages", "standalone");
  const releasesRoot = path.join(standaloneRoot, "releases");
  const selectorPath = path.join(standaloneRoot, "current");
  const binDirectory = path.join(root, ".local", "bin");
  const commandPath = path.join(binDirectory, "codex");
  const runtimeDirectory = path.join(root, "runtime");
  const stateDirectory = path.join(root, "state");
  const beforeVersion = "1.2.3";
  const afterVersion = "9.9.9";
  const target = "x86_64-unknown-linux-musl";
  const packageRoot = path.join(releasesRoot, `${beforeVersion}-${target}`);
  const appVersion = "0.39.1";
  const fixture = {
    root,
    standaloneRoot,
    releasesRoot,
    selectorPath,
    binDirectory,
    commandPath,
    runtimeDirectory,
    stateDirectory,
    beforeVersion,
    afterVersion,
    target,
    packageRoot,
    appVersion,
  };
  try {
    await Promise.all([
      fs.mkdir(releasesRoot, { recursive: true }),
      fs.mkdir(binDirectory, { recursive: true }),
      fs.mkdir(runtimeDirectory, { recursive: true }),
      fs.mkdir(stateDirectory, { recursive: true }),
    ]);
    await installFakeStandaloneVersion(packageRoot, beforeVersion, target);
    await fs.writeFile(path.join(packageRoot, "old-only.txt"), "verified old release\n");
    await fs.symlink(packageRoot, selectorPath);
    await fs.symlink(path.join(selectorPath, "bin", "codex"), commandPath);
    await operation(fixture);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function selectFakeStandaloneVersion(fixture, version, options = {}) {
  const packageRoot = path.join(fixture.releasesRoot, `${version}-${fixture.target}`);
  await installFakeStandaloneVersion(packageRoot, version, fixture.target, options);
  const temporary = `${fixture.selectorPath}.test-next`;
  await fs.rm(temporary, { force: true });
  await fs.symlink(packageRoot, temporary);
  await fs.rename(temporary, fixture.selectorPath);
  return packageRoot;
}

async function installFakeStandaloneVersion(
  packageRoot,
  version,
  target,
  { appServerReady = true } = {},
) {
  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "codex-package.json"),
    `${JSON.stringify({
      layoutVersion: 1,
      version,
      target,
      variant: "codex",
      entrypoint: "bin/codex",
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    })}\n`,
  );
  await fs.writeFile(path.join(packageRoot, "bin", "codex"), `#!/usr/bin/env node
    const fs = require("node:fs");
    const path = require("node:path");
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "codex-package.json"), "utf8"));
    if (process.argv[2] === "--version") console.log("codex-cli " + manifest.version);
    else if (process.argv[2] === "app-server" && process.argv[3] === "--help") ${appServerReady ? 'console.log("Usage: codex app-server")' : "process.exit(3)"};
    else process.exit(2);
  `, { mode: 0o755 });
  await fs.writeFile(path.join(packageRoot, "bin", "codex-code-mode-host"), `#!/bin/sh
    if [ "$1" = "--help" ]; then echo "Usage: codex-code-mode-host [OPTIONS]"; else exit 2; fi
  `, { mode: 0o755 });
  await Promise.all([
    fs.mkdir(path.join(packageRoot, "codex-resources"), { recursive: true }),
    fs.mkdir(path.join(packageRoot, "codex-path"), { recursive: true }),
  ]);
}

async function installFakeVersion(packageRoot, version, { appServerReady = true } = {}) {
  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@openai/codex", version })}\n`,
  );
  await fs.writeFile(path.join(packageRoot, "bin", "codex.js"), `#!/usr/bin/env node
    const fs = require("node:fs");
    const path = require("node:path");
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    if (process.argv[2] === "--version") console.log("codex-cli " + manifest.version);
    else if (process.argv[2] === "app-server" && process.argv[3] === "--help") ${appServerReady ? 'console.log("Usage: codex app-server")' : "process.exit(3)"};
    else process.exit(2);
  `, { mode: 0o755 });
  await installFakeNativeVersion(
    path.join(path.dirname(packageRoot), "codex-linux-x64"),
    version,
  );
}

async function installFakeNativeVersion(nativePackageRoot, version) {
  const target = "x86_64-unknown-linux-musl";
  const nativeRoot = path.join(nativePackageRoot, "vendor", target);
  await fs.rm(nativePackageRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(nativeRoot, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(nativePackageRoot, "package.json"),
    `${JSON.stringify({ name: "@openai/codex-linux-x64", version })}\n`,
  );
  await fs.writeFile(
    path.join(nativeRoot, "codex-package.json"),
    `${JSON.stringify({
      layoutVersion: 1,
      version,
      target,
      variant: "codex",
      entrypoint: "bin/codex",
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    })}\n`,
  );
  await fs.writeFile(path.join(nativeRoot, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(
    path.join(nativeRoot, "bin", "codex-code-mode-host"),
    "#!/bin/sh\necho 'Usage: codex-code-mode-host'\n",
    { mode: 0o755 },
  );
  await Promise.all([
    fs.mkdir(path.join(nativeRoot, "codex-resources"), { recursive: true }),
    fs.mkdir(path.join(nativeRoot, "codex-path"), { recursive: true }),
  ]);
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(marker)) finish();
    };
    const onErrorData = (chunk) => { output += chunk; };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => finish(new Error(
      `Worker exited before ${marker} (${code ?? signal}): ${output}`,
    ));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Timed out waiting for ${marker}: ${output}`));
    }, 30_000);
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function run(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
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
