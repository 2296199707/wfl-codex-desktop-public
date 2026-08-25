import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deploymentRecoveryStatusIsTerminal,
  reconcileDeploymentRecoveryStatus,
} from "../lib/deployment-recovery-status.mjs";
import { AppUpdateStatusStore } from "../lib/app-update-status.mjs";
import { RollbackStatusStore } from "../lib/rollback-status.mjs";

test("a completed candidate recovery cannot be downgraded by a slower recovery worker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-recovery-status-"));
  const operationId = "wfl-codex-app-update-1700000000000";
  const startedAt = Date.now();
  try {
    const store = new AppUpdateStatusStore(directory);
    await store.write({ status: "running", phase: "deploying", unit: operationId, startedAt });

    const completed = await reconcileDeploymentRecoveryStatus({
      stateDirectory: directory,
      operationId,
      version: "0.43.77-beta",
      outcome: "candidate",
      selectedPort: 4318,
    });
    assert.equal(completed.updated, true);
    assert.equal(completed.status.recoveryOutcome, "candidate");
    assert.equal(
      deploymentRecoveryStatusIsTerminal(completed.status, operationId, startedAt),
      true,
    );

    const slower = await reconcileDeploymentRecoveryStatus({
      stateDirectory: directory,
      operationId,
      outcome: "failed",
      error: "late recovery failure",
    });
    assert.equal(slower.updated, false);
    assert.equal(slower.reason, "recovery-already-completed");
    assert.equal((await store.read()).status, "completed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an old-backend recovery failure remains retryable and can become candidate success", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-recovery-status-retry-"));
  const operationId = "wfl-codex-rollback-v0-43-77-beta-1700000000000";
  const startedAt = Date.now();
  try {
    const store = new RollbackStatusStore(directory);
    await store.write({ phase: "deploying", unit: operationId, startedAt });

    const failed = await reconcileDeploymentRecoveryStatus({
      stateDirectory: directory,
      operationId,
      outcome: "failed",
      selectedPort: 4319,
    });
    assert.equal(failed.status.recoveryOutcome, "old");

    const recovered = await reconcileDeploymentRecoveryStatus({
      stateDirectory: directory,
      operationId,
      outcome: "candidate",
      selectedPort: 4318,
    });
    assert.equal(recovered.updated, true);
    assert.equal(recovered.status.status, "completed");
    assert.equal(recovered.status.recoveryOutcome, "candidate");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
