import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  IMAGE_EXECUTION_PRESETS,
  ImageExecutionSettingsStore,
} from "../lib/image-execution-settings.mjs";

async function withStore(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-image-settings-"));
  try {
    const store = await new ImageExecutionSettingsStore(root, { now: () => 1_000 }).initialize({
      writeOnInitialize: true,
    });
    await operation({ root, store });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("image execution defaults to one manually configured worker", async () => {
  await withStore(async ({ root, store }) => {
    const snapshot = store.snapshot();
    assert.equal(snapshot.preset, "stable");
    assert.equal(snapshot.acceptNewTasks, true);
    assert.deepEqual(snapshot.config, IMAGE_EXECUTION_PRESETS.stable);
    assert.equal(snapshot.config.worker.concurrency, 1);
    assert.equal(snapshot.config.worker.totalMemoryMb, snapshot.config.worker.memoryMb);
    assert.equal((await fs.stat(path.join(root, "image-execution-settings.json"))).mode & 0o777, 0o600);
  });
});

test("image task snapshots are deeply frozen and survive later manual changes", async () => {
  await withStore(async ({ store }) => {
    const frozen = store.taskSnapshot();
    const initialRevision = frozen.revision;
    await store.applyPreset("balanced", { expectedRevision: initialRevision });
    assert.equal(frozen.config.worker.concurrency, 1);
    assert.equal(store.snapshot().config.worker.concurrency, 2);
    assert.throws(() => { frozen.config.worker.concurrency = 9; }, TypeError);
  });
});

test("image execution settings reject contradictory manual budgets without adapting them", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.updateCustom({ worker: { concurrency: 2, memoryMb: 1_024, totalMemoryMb: 1_024 } }),
      (error) => error.statusCode === 400 && /总内存预算/u.test(error.message),
    );
    await assert.rejects(
      store.updateCustom({ worker: { concurrency: 1, perUserConcurrency: 2 } }),
      (error) => error.statusCode === 400 && /单用户图片并发/u.test(error.message),
    );
    assert.equal(store.snapshot().preset, "stable");
  });
});

test("image execution setting revisions fence concurrent administrators", async () => {
  await withStore(async ({ store }) => {
    const initial = store.snapshot();
    const updated = await store.setAcceptNewTasks(false, { expectedRevision: initial.revision });
    assert.equal(updated.acceptNewTasks, false);
    await assert.rejects(
      store.applyPreset("performance", { expectedRevision: initial.revision }),
      (error) => error.statusCode === 409,
    );
  });
});
