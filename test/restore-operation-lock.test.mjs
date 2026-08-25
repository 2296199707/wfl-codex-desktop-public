import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readProcessStartTicks,
  RestoreOperationLock,
} from "../lib/restore-operation-lock.mjs";

const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("an unverifiable restore owner becomes reclaimable after its heartbeat grace", async () => {
  await fixture(async ({ runtimeDirectory, lockPath }) => {
    const baseTime = Date.now();
    let now = baseTime;
    const ownStartTicks = await readProcessStartTicks(process.pid);
    const staleToken = `stale-${crypto.randomUUID()}`;
    await writeLock(lockPath, {
      token: staleToken,
      pid: 2_147_483_647,
      startTicks: "1",
      operationId: "stale-restore",
      backupId: null,
      workerMarker: false,
      createdAt: baseTime,
    });
    await setMtime(lockPath, baseTime);

    const store = new RestoreOperationLock(runtimeDirectory, {
      sourceDirectory,
      unverifiableGraceMs: 50,
      lockHeartbeatMs: 10,
      now: () => now,
      readProcessStartTicks: async (pid) => {
        if (pid === process.pid) return ownStartTicks;
        throw procUnavailableError();
      },
      readProcessArguments: async () => {
        throw procUnavailableError();
      },
    });

    now = baseTime + 25;
    assert.equal((await store.inspect()).state, "unknown");
    now = baseTime + 51;
    assert.equal((await store.inspect()).state, "inactive");

    const replacement = await store.acquire({
      operationId: "replacement-restore",
      workerMarker: false,
    });
    try {
      assert.notEqual(replacement.record.token, staleToken);
    } finally {
      await replacement.release();
    }
  });
});

test("one recovery invocation can wait through the unverifiable owner grace", async () => {
  await fixture(async ({ runtimeDirectory, lockPath }) => {
    const createdAt = Date.now();
    const ownStartTicks = await readProcessStartTicks(process.pid);
    await writeLock(lockPath, {
      token: `orphan-${crypto.randomUUID()}`,
      pid: 2_147_483_647,
      startTicks: "1",
      operationId: "orphaned-restore",
      backupId: "b-orphaned-owner",
      workerMarker: true,
      createdAt,
    });
    await setMtime(lockPath, createdAt);
    const store = new RestoreOperationLock(runtimeDirectory, {
      sourceDirectory,
      unverifiableGraceMs: 40,
      lockHeartbeatMs: 10,
      readProcessStartTicks: async (pid) => {
        if (pid === process.pid) return ownStartTicks;
        throw procUnavailableError();
      },
      readProcessArguments: async () => {
        throw procUnavailableError();
      },
    });

    const startedAt = Date.now();
    const recovered = await store.acquire({
      operationId: "same-invocation-recovery",
      workerMarker: false,
      waitForUnknownMs: 100,
    });
    try {
      assert.ok(Date.now() - startedAt >= 35);
    } finally {
      await recovered.release();
    }
  });
});

test("a live restore owner heartbeat prevents reaping while proc is unreadable", async () => {
  await fixture(async ({ runtimeDirectory, lockPath }) => {
    const ownStartTicks = await readProcessStartTicks(process.pid);
    let procUnavailable = false;
    let allowContenderFingerprint = false;
    let heartbeatAttempts = 0;
    const heartbeatErrors = [];
    const store = new RestoreOperationLock(runtimeDirectory, {
      sourceDirectory,
      unverifiableGraceMs: 100,
      lockHeartbeatMs: 10,
      readProcessStartTicks: async () => {
        if (!procUnavailable) return ownStartTicks;
        if (allowContenderFingerprint) {
          allowContenderFingerprint = false;
          return ownStartTicks;
        }
        throw procUnavailableError();
      },
      readProcessArguments: async () => {
        throw procUnavailableError();
      },
      touchHeartbeat: async (handle) => {
        heartbeatAttempts += 1;
        if (heartbeatAttempts === 1) {
          const error = new Error("transient heartbeat failure");
          error.code = "EIO";
          throw error;
        }
        const now = new Date();
        await handle.utimes(now, now);
      },
      onHeartbeatError: (error) => heartbeatErrors.push(error),
    });
    const owner = await store.acquire({
      operationId: "live-restore",
      backupId: "b-live-owner",
      workerMarker: true,
    });
    const initialMtime = (await fs.stat(lockPath)).mtimeMs;

    try {
      procUnavailable = true;
      await delay(250);
      assert.ok(heartbeatAttempts > 1);
      assert.equal(heartbeatErrors.length, 1);
      assert.equal(heartbeatErrors[0].code, "EIO");
      assert.ok((await fs.stat(lockPath)).mtimeMs > initialMtime);
      assert.equal((await store.inspect()).state, "unknown");

      allowContenderFingerprint = true;
      await assert.rejects(
        store.acquire({ operationId: "competing-restore", workerMarker: false }),
        (error) => error.code === "ERR_BACKUP_RESTORE_OWNER_UNKNOWN",
      );
      assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, owner.record.token);
    } finally {
      await owner.release();
    }
  });
});

test("a future restore lock is protected on first observation and becomes reclaimable after grace", async () => {
  await fixture(async ({ runtimeDirectory, lockPath }) => {
    const now = Date.now();
    let monotonicNow = 100;
    const ownStartTicks = await readProcessStartTicks(process.pid);
    const staleToken = `future-${crypto.randomUUID()}`;
    const store = new RestoreOperationLock(runtimeDirectory, {
      sourceDirectory,
      unverifiableGraceMs: 50,
      now: () => now,
      monotonicNow: () => monotonicNow,
      readProcessStartTicks: async (pid) => {
        if (pid === process.pid) return ownStartTicks;
        throw procUnavailableError();
      },
      readProcessArguments: async () => {
        throw procUnavailableError();
      },
    });

    await writeLock(lockPath, {
      token: staleToken,
      pid: 2_147_483_647,
      startTicks: "1",
      operationId: "future-restore",
      backupId: null,
      workerMarker: false,
      createdAt: now + 60_000,
    });
    await setMtime(lockPath, now + 60_000);
    assert.equal((await store.inspect()).state, "unknown");
    await assert.rejects(
      store.acquire({ operationId: "competing-restore", workerMarker: false }),
      (error) => error.code === "ERR_BACKUP_RESTORE_OWNER_UNKNOWN",
    );
    assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).token, staleToken);

    monotonicNow += 51;
    assert.equal((await store.inspect()).state, "inactive");
    const replacement = await store.acquire({
      operationId: "replacement-restore",
      workerMarker: false,
    });
    await replacement.release();

    await fs.writeFile(lockPath, "{}\n", { mode: 0o600 });
    await setMtime(lockPath, now + 60_000);
    assert.equal((await store.inspect()).state, "unknown");
    monotonicNow += 5_001;
    assert.equal((await store.inspect()).state, "inactive");
  });
});

test("a verified live restore owner resets a future timestamp observation", async () => {
  await fixture(async ({ runtimeDirectory, lockPath }) => {
    const now = Date.now();
    let monotonicNow = 10;
    let procAvailable = false;
    const ownerPid = 7_654;
    const ownerStartTicks = "123456";
    await writeLock(lockPath, {
      token: `live-future-${crypto.randomUUID()}`,
      pid: ownerPid,
      startTicks: ownerStartTicks,
      operationId: "live-future-restore",
      backupId: null,
      workerMarker: false,
      createdAt: now,
    });
    await setMtime(lockPath, now + 60_000);

    const store = new RestoreOperationLock(runtimeDirectory, {
      sourceDirectory,
      unverifiableGraceMs: 50,
      now: () => now,
      monotonicNow: () => monotonicNow,
      readProcessStartTicks: async () => {
        if (!procAvailable) throw procUnavailableError();
        return ownerStartTicks;
      },
      readProcessArguments: async () => {
        if (!procAvailable) throw procUnavailableError();
        return ["node", path.join(sourceDirectory, "scripts", "recover-data-restore.mjs")];
      },
    });

    assert.equal((await store.inspect()).state, "unknown");
    monotonicNow += 40;
    procAvailable = true;
    assert.equal((await store.inspect()).state, "active");
    procAvailable = false;
    monotonicNow += 40;
    assert.equal((await store.inspect()).state, "unknown");
    monotonicNow += 51;
    assert.equal((await store.inspect()).state, "inactive");
  });
});

async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-operation-lock-"));
  const runtimeDirectory = path.join(root, "runtime");
  const lockPath = path.join(runtimeDirectory, "backup-restore.lock");
  await fs.mkdir(runtimeDirectory, { recursive: true });
  try {
    await operation({ runtimeDirectory, lockPath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeLock(lockPath, record) {
  await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`, { mode: 0o600 });
}

function setMtime(filePath, milliseconds) {
  const timestamp = new Date(milliseconds);
  return fs.utimes(filePath, timestamp, timestamp);
}

function procUnavailableError() {
  const error = new Error("proc is unavailable");
  error.code = "EACCES";
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
