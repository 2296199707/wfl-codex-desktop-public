import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForIdleDrain } from "../lib/maintenance-drain.mjs";
import { ReleaseDrainStore } from "../lib/release-drain.mjs";

const restoreScript = await fs.readFile(new URL("../scripts/restore-data-backup.mjs", import.meta.url), "utf8");

async function fixture(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-drain-"));
  const store = new ReleaseDrainStore(directory);
  try {
    await operation({ directory, store });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("busy waiting never creates a drain lease", async () => {
  await fixture(async ({ store }) => {
    let probes = 0;
    await assert.rejects(waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => ({ taskIdle: false, maintenanceIdle: true, draining: false }),
      timeoutMs: 25,
      pollIntervalMs: 5,
      leaseTtlMs: 100,
      renewIntervalMs: 20,
      onWaiting: async () => { probes += 1; },
    }), /task admission remained open/);
    assert.equal((await store.read()).active, false);
    assert.equal(probes, 1);
  });
});

test("forced maintenance can acquire a lease while a conversation task is active", async () => {
  await fixture(async ({ store }) => {
    const fetchReadiness = async () => ({
      taskIdle: false,
      maintenanceIdle: true,
      draining: (await store.read()).active,
    });
    const controller = await waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness,
      forceTask: true,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    assert.equal(controller.forceTask, true);
    assert.equal((await store.read()).active, true);
    await controller.release();
  });
});

test("an incomplete readiness protocol fails before creating any drain lease", async () => {
  await fixture(async ({ store }) => {
    let beginCalls = 0;
    const originalBegin = store.begin.bind(store);
    store.begin = (...args) => {
      beginCalls += 1;
      return originalBegin(...args);
    };

    await assert.rejects(
      waitForIdleDrain({
        drainStore: store,
        version: "1.2.3",
        fetchReadiness: async () => ({ taskIdle: true, draining: false }),
        timeoutMs: 100,
        pollIntervalMs: 1,
        leaseTtlMs: 100,
        renewIntervalMs: 20,
      }),
      (error) => error.code === "ERR_TASK_DRAIN_UNSUPPORTED",
    );
    assert.equal(beginCalls, 0);
    assert.equal((await store.read()).active, false);
  });
});

test("a recognized legacy protocol is opt-in and identifies an exclusive activation", async () => {
  await fixture(async ({ store }) => {
    const fetchReadiness = async () => ({
      taskIdle: true,
      draining: (await store.read()).active,
      legacyProtocol: true,
    });
    await assert.rejects(
      waitForIdleDrain({
        drainStore: store,
        version: "1.2.3",
        fetchReadiness,
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
      (error) => error.code === "ERR_TASK_DRAIN_UNSUPPORTED",
    );

    const controller = await waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness,
      allowLegacyProtocol: true,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    assert.equal(controller.legacyProtocol, true);
    await controller.release();
  });
});

test("an unmarked response cannot bypass persistent-state readiness as legacy", async () => {
  await fixture(async ({ store }) => {
    await assert.rejects(
      waitForIdleDrain({
        drainStore: store,
        version: "1.2.3",
        fetchReadiness: async () => ({ taskIdle: true, draining: false }),
        allowLegacyProtocol: true,
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
      (error) => error.code === "ERR_TASK_DRAIN_UNSUPPORTED",
    );
    assert.equal((await store.read()).active, false);
  });
});

test("a task admission race releases the provisional lease and retries", async () => {
  await fixture(async ({ store }) => {
    let probe = 0;
    const controller = await waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => {
        probe += 1;
        if (probe === 1) return { taskIdle: true, maintenanceIdle: true, draining: false };
        if (probe === 2) return { taskIdle: false, maintenanceIdle: true, draining: true };
        if (probe === 3) return { taskIdle: true, maintenanceIdle: true, draining: false };
        return { taskIdle: true, maintenanceIdle: true, draining: true };
      },
      timeoutMs: 200,
      pollIntervalMs: 1,
      leaseTtlMs: 100,
      renewIntervalMs: 20,
    });
    assert.ok(probe >= 4);
    assert.equal((await store.read()).active, true);
    await controller.release();
    assert.equal((await store.read()).active, false);
  });
});

test("persistent state activity prevents a drain lease even when tasks are idle", async () => {
  await fixture(async ({ store }) => {
    let beginCalls = 0;
    const originalBegin = store.begin.bind(store);
    store.begin = (...args) => {
      beginCalls += 1;
      return originalBegin(...args);
    };

    await assert.rejects(waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => ({ taskIdle: true, maintenanceIdle: false, draining: false }),
      timeoutMs: 25,
      pollIntervalMs: 5,
      leaseTtlMs: 100,
      renewIntervalMs: 20,
    }), /task admission remained open/);
    assert.equal(beginCalls, 0);
    assert.equal((await store.read()).active, false);
  });
});

test("a persistent write race releases the provisional lease and retries", async () => {
  await fixture(async ({ store }) => {
    let probe = 0;
    const controller = await waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => {
        probe += 1;
        if (probe === 1) return { taskIdle: true, maintenanceIdle: true, draining: false };
        if (probe === 2) return { taskIdle: true, maintenanceIdle: false, draining: true };
        if (probe === 3) return { taskIdle: true, maintenanceIdle: true, draining: false };
        return { taskIdle: true, maintenanceIdle: true, draining: true };
      },
      timeoutMs: 200,
      pollIntervalMs: 1,
      leaseTtlMs: 100,
      renewIntervalMs: 20,
    });
    assert.ok(probe >= 4);
    assert.equal((await store.read()).active, true);
    await controller.release();
    assert.equal((await store.read()).active, false);
  });
});

test("owner cancellation exits without closing task admission", async () => {
  await fixture(async ({ store }) => {
    await assert.rejects(waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => ({ taskIdle: false, maintenanceIdle: true, draining: false }),
      isCancellationRequested: async () => true,
      timeoutMs: 100,
      pollIntervalMs: 1,
      leaseTtlMs: 100,
      renewIntervalMs: 20,
    }), (error) => error.code === "ERR_MAINTENANCE_CANCELLED");
    assert.equal((await store.read()).active, false);
  });
});

test("lease renewal cannot extend task blocking beyond the hard drain deadline", async () => {
  await fixture(async ({ store }) => {
    const startedAt = Date.now();
    const controller = await waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => ({
        taskIdle: true,
        maintenanceIdle: true,
        draining: (await store.read()).active,
      }),
      timeoutMs: 500,
      pollIntervalMs: 1,
      leaseTtlMs: 50,
      renewIntervalMs: 10,
      maxDrainMs: 90,
    });

    assert.ok(controller.deadlineAt >= startedAt + 80);
    assert.ok(controller.deadlineAt <= Date.now() + 90);
    await delay(120);
    assert.equal((await store.read()).active, false);
    await assert.rejects(
      controller.assertActive(),
      (error) => error.code === "ERR_MAINTENANCE_DRAIN_DEADLINE",
    );
    await controller.release();
  });
});

test("release activation may request sixty seconds but no caller can exceed it", async () => {
  await fixture(async ({ store }) => {
    const controller = await waitForIdleDrain({
      drainStore: store,
      version: "1.2.3",
      fetchReadiness: async () => ({
        taskIdle: true,
        maintenanceIdle: true,
        draining: (await store.read()).active,
      }),
      maxDrainMs: 60_000,
    });
    assert.ok(controller.deadlineAt > Date.now() + 59_000);
    await controller.release();
    await assert.rejects(
      waitForIdleDrain({
        drainStore: store,
        version: "1.2.3",
        fetchReadiness: async () => ({ taskIdle: true, maintenanceIdle: true, draining: false }),
        maxDrainMs: 60_001,
      }),
      /cannot exceed 60000ms/,
    );
    assert.equal((await store.read()).active, false);
  });
});

test("data restore fences the stop and never rolls back after the drain deadline", () => {
  const outerRecoveryStart = restoreScript.indexOf("} catch (error) {\n  if (restoreLock) {");
  const switching = restoreScript.slice(
    restoreScript.indexOf('await update("draining"'),
    outerRecoveryStart,
  );
  const cancellation = switching.indexOf("await assertNotCancelled()");
  const firstFence = switching.indexOf("await drainLease.assertActive()", cancellation);
  const commit = switching.indexOf("await commitRestoreDecision()", firstFence);
  const switchingStatus = switching.indexOf('await update("switching"', commit);
  const secondFence = switching.indexOf("await drainLease.assertActive()", switchingStatus);
  const stopBudget = switching.indexOf("const stopTimeoutMs = drainSystemctlBudget", secondFence);
  const stop = switching.indexOf('await run("systemctl", ["stop", unit], {', stopBudget);
  const postStopFence = switching.indexOf("await drainLease.assertActive()", stop);
  assert.ok(cancellation >= 0 && cancellation < firstFence);
  assert.ok(firstFence < commit && commit < switchingStatus);
  assert.ok(switchingStatus < secondFence && secondFence < stopBudget && stopBudget < stop);
  assert.ok(stop < postStopFence);
  assert.match(switching, /timeoutMs: stopTimeoutMs/);
  assert.match(switching, /timeoutMs: drainSystemctlBudget\([\s\S]*?DRAIN_START_TIMEOUT_MS/);
  assert.match(switching, /waitForReady\(activePort, remainingDrainMs\([\s\S]*?DRAIN_POST_START_ROLLBACK_RESERVE_MS/);

  const recovery = restoreScript.slice(outerRecoveryStart);
  assert.match(recovery, /canRollbackWithinDrain\(drainLease, requiredBudgetMs\)/);
  assert.match(recovery, /timeoutMs: recoveryStopTimeoutMs/);
  assert.match(recovery, /timeoutMs: RECOVERY_SYSTEMCTL_TIMEOUT_MS/);
  assert.match(recovery, /failForward = true/);
  assert.match(recovery, /preferredGeneration = rollbackAllowed \? "old" : "new"/);
  assert.match(recovery, /swapJournal\.setDesiredGeneration\(preferredGeneration\)/);
  assert.match(recovery, /recoverJournalGeneration\(preferredGeneration\)/);
  assert.match(restoreScript, /swapJournal\.moveOriginalAside\(index\)/);
  assert.match(restoreScript, /swapJournal\.activateReplacement\(index\)/);
  assert.doesNotMatch(restoreScript, /await fs\.rename\(entry\.(?:target|replacement|previous)/);
  assert.match(recovery, /terminalStatusWritten[\s\S]*?dataConsistent[\s\S]*?backendReady[\s\S]*?!preserveRecoveryArtifacts/);
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
