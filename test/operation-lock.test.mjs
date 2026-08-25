import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireOperationLock,
  operationLockState,
  reclaimOperationLockForRecovery,
  readProcessStartTicks,
  statusTimestampIsFresh,
} from "../lib/operation-lock.mjs";

const lockOptions = {
  ownerCommand: "test/operation-lock.test.mjs",
  acceptedCommands: ["test/operation-lock.test.mjs"],
  conflictMessage: "test operation is already running",
};

test("concurrent acquisition exposes one complete lock record", async () => {
  await withLockPath(async (lockPath) => {
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, index) => acquireOperationLock(lockPath, {
        ...lockOptions,
        operationId: `concurrent-operation-${index}`,
      })),
    );
    const acquired = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 23);
    assert.ok(rejected.every((result) => result.reason.code === "ERR_OPERATION_LOCKED"));

    const value = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.pid, process.pid);
    assert.match(value.startTicks, /^\d+$/);
    assert.equal(typeof value.token, "string");
    assert.ok(value.token.length >= 16);

    assert.equal(await acquired[0].value.release(), true);
    await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
  });
});

test("a fresh incomplete legacy lock is preserved until its grace expires", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(lockPath, "", { mode: 0o600 });
    assert.equal(await operationLockState(lockPath, lockOptions), "unknown");
    await assert.rejects(
      acquireOperationLock(lockPath, { ...lockOptions, acquireWaitMs: 30 }),
      (error) => error.code === "ERR_OPERATION_LOCKED",
    );
    assert.equal(await fs.readFile(lockPath, "utf8"), "");

    const stale = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, stale, stale);
    const lock = await acquireOperationLock(lockPath, lockOptions);
    assert.equal(await operationLockState(lockPath, lockOptions), "active");
    await lock.release();
  });
});

test("a reused PID with different start ticks is reclaimed", async () => {
  await withLockPath(async (lockPath) => {
    const startTicks = await readProcessStartTicks(process.pid);
    assert.match(startTicks, /^\d+$/);
    await fs.writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      token: "reused-pid-record-token",
      pid: process.pid,
      startTicks: String(BigInt(startTicks) + 1n),
      operationId: "old-operation",
      ownerCommand: lockOptions.ownerCommand,
      createdAt: Date.now() - 60_000,
    })}\n`, { mode: 0o600 });

    assert.equal(await operationLockState(lockPath, lockOptions), "inactive");
    const lock = await acquireOperationLock(lockPath, lockOptions);
    assert.notEqual(lock.record.token, "reused-pid-record-token");
    await lock.release();
  });
});

test("a SIGKILLed deployment worker is not kept active by a zombie proc entry", async () => {
  await withLockPath(async (lockPath) => {
    const owner = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000)", "scripts/deploy.mjs", "--activate-staged",
    ], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      owner.once("spawn", resolve);
      owner.once("error", reject);
    });
    try {
      const startTicks = await readProcessStartTicks(owner.pid);
      assert.match(startTicks, /^\d+$/);
      await fs.writeFile(lockPath, `${JSON.stringify({
        schemaVersion: 1,
        token: "killed-deploy-worker-token",
        pid: owner.pid,
        startTicks,
        operationId: "timed-out-deployment",
        ownerCommand: "scripts/deploy.mjs",
        createdAt: Date.now(),
      })}\n`, { mode: 0o600 });
      owner.kill("SIGKILL");
      await new Promise((resolve) => owner.once("close", resolve));

      assert.equal(await operationLockState(lockPath, {
        ...lockOptions,
        ownerCommand: "scripts/deploy.mjs",
        acceptedCommands: ["scripts/deploy.mjs"],
      }), "inactive");
      const lock = await acquireOperationLock(lockPath, lockOptions);
      await lock.release();
    } finally {
      if (!owner.killed) owner.kill("SIGKILL");
    }
  });
});

test("concurrent reclaimers cannot both acquire an abandoned lock", async () => {
  await withLockPath(async (lockPath) => {
    await fs.writeFile(lockPath, "2147483647\n", { mode: 0o600 });
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () => acquireOperationLock(lockPath, lockOptions)),
    );
    const acquired = results.filter((result) => result.status === "fulfilled");
    assert.equal(acquired.length, 1);
    assert.equal(await operationLockState(lockPath, lockOptions), "active");
    await acquired[0].value.release();
  });
});

test("an old owner cannot remove a replacement lock", async () => {
  await withLockPath(async (lockPath) => {
    const oldLock = await acquireOperationLock(lockPath, lockOptions);
    await fs.unlink(lockPath);
    const replacement = await acquireOperationLock(lockPath, lockOptions);

    assert.equal(await oldLock.release(), false);
    const value = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(value.token, replacement.record.token);
    assert.equal(await operationLockState(lockPath, lockOptions), "active");
    await replacement.release();
  });
});

test("recovery cannot take over a lock with a different handoff token", async () => {
  await withLockPath(async (lockPath) => {
    const operationId = "recovery-token-mismatch";
    await writeLockRecord(lockPath, {
      token: "stale-lock-token-mismatch",
      handoffToken: "expected-recovery-token-123456",
      pid: 2_147_483_647,
      startTicks: "1",
      operationId,
      ownerCommand: lockOptions.ownerCommand,
      createdAt: Date.now() - 60_000,
    });

    let verifierCalled = false;
    const reclaimed = await reclaimOperationLockForRecovery(lockPath, {
      ...lockOptions,
      expectedOperationId: operationId,
      recoveryToken: "different-recovery-token-123456",
      verifyOwnerExit: async () => {
        verifierCalled = true;
        return true;
      },
    });

    assert.equal(reclaimed, false);
    assert.equal(verifierCalled, false);
    assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, "stale-lock-token-mismatch");
  });
});

test("recovery cannot take over while the recorded lock owner is still alive", async () => {
  await withLockPath(async (lockPath) => {
    const operationId = "recovery-live-owner";
    const recoveryToken = "live-owner-recovery-token-123456";
    const lock = await acquireOperationLock(lockPath, {
      ...lockOptions,
      operationId,
      handoffToken: recoveryToken,
    });
    try {
      const reclaimed = await reclaimOperationLockForRecovery(lockPath, {
        ...lockOptions,
        expectedOperationId: operationId,
        recoveryToken,
        verifyOwnerExit: async ({ state }) => state !== "active",
      });

      assert.equal(reclaimed, false);
      assert.equal(await operationLockState(lockPath, lockOptions), "active");
      assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, lock.record.token);
    } finally {
      await lock.release();
    }
  });
});

test("recovery cannot delete a lock after its inode or token is replaced", async () => {
  await withLockPath(async (lockPath) => {
    const operationId = "recovery-replacement-fence";
    const recoveryToken = "replacement-recovery-token-123456";
    const replacementToken = "replacement-lock-token-123456";
    await writeLockRecord(lockPath, {
      token: "stale-lock-token-replacement",
      handoffToken: recoveryToken,
      pid: 2_147_483_646,
      startTicks: "1",
      operationId,
      ownerCommand: lockOptions.ownerCommand,
      createdAt: Date.now() - 60_000,
    });

    const reclaimed = await reclaimOperationLockForRecovery(lockPath, {
      ...lockOptions,
      expectedOperationId: operationId,
      recoveryToken,
      verifyOwnerExit: async () => {
        await writeLockRecord(`${lockPath}.replacement`, {
          token: replacementToken,
          handoffToken: recoveryToken,
          pid: 2_147_483_645,
          startTicks: "1",
          operationId,
          ownerCommand: lockOptions.ownerCommand,
          createdAt: Date.now(),
        });
        await fs.rename(`${lockPath}.replacement`, lockPath);
        return true;
      },
    });

    assert.equal(reclaimed, false);
    assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, replacementToken);
  });
});

test("an owner heartbeat keeps an unverifiable live lock bounded but protected", async () => {
  await withLockPath(async (lockPath) => {
    const options = {
      ...lockOptions,
      lockHeartbeatMs: 10,
      unverifiableGraceMs: 50,
      readProcessStartTicks: async () => undefined,
      readProcessArguments: async () => undefined,
    };
    const lock = await acquireOperationLock(lockPath, options);
    const initialMtime = (await fs.stat(lockPath)).mtimeMs;
    const deadline = Date.now() + 500;
    while ((await fs.stat(lockPath)).mtimeMs <= initialMtime && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await operationLockState(lockPath, options), "unknown");
    await lock.release();
  });
});

test("an unverifiable lock without an owner heartbeat becomes reclaimable", async () => {
  await withLockPath(async (lockPath) => {
    const startTicks = await readProcessStartTicks(process.pid);
    await fs.writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      token: "unverifiable-owner-token",
      pid: process.pid,
      startTicks,
      operationId: "unverifiable-operation",
      ownerCommand: lockOptions.ownerCommand,
      createdAt: Date.now() - 10_000,
    })}\n`, { mode: 0o600 });
    const stale = new Date(Date.now() - 1_000);
    await fs.utimes(lockPath, stale, stale);
    const options = {
      ...lockOptions,
      unverifiableGraceMs: 50,
      readProcessStartTicks: async () => undefined,
      readProcessArguments: async () => undefined,
    };
    assert.equal(await operationLockState(lockPath, options), "inactive");
    const lock = await acquireOperationLock(lockPath, options);
    assert.notEqual(lock.record.token, "unverifiable-owner-token");
    await lock.release();
  });
});

test("future status timestamps are not considered fresh forever", () => {
  const now = 1_000_000;
  assert.equal(statusTimestampIsFresh({ updatedAt: now - 10_000 }, { now }), true);
  assert.equal(statusTimestampIsFresh({ updatedAt: now + 2_000 }, { now }), true);
  assert.equal(statusTimestampIsFresh({ updatedAt: now + 60_000 }, { now }), false);
});

async function withLockPath(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "operation-lock-"));
  try {
    await operation(path.join(directory, "maintenance.lock"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writeLockRecord(lockPath, record) {
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`, { mode: 0o600 });
}
