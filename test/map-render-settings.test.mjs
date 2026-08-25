import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAP_RENDER_PRESETS,
  MapRenderSettingsStore,
} from "../lib/map-render-settings.mjs";

async function withStore(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-settings-"));
  try {
    const store = await new MapRenderSettingsStore(root, { now: () => 1_000 }).initialize({
      writeOnInitialize: true,
    });
    await operation({ root, store });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("starts in the manually selected stable preset and persists private state", async () => {
  await withStore(async ({ root, store }) => {
    const settings = store.snapshot();
    assert.equal(settings.preset, "stable");
    assert.equal(settings.acceptNewTasks, true);
    assert.deepEqual(settings.config, MAP_RENDER_PRESETS.stable);
    assert.equal(settings.config.worker.renderConcurrency, 1);
    assert.equal(settings.config.worker.queueLimit, 128);
    const stat = await fs.stat(path.join(root, "map-render-settings.json"));
    assert.equal(stat.mode & 0o077, 0);
  });
});

test("switches presets only through an explicit administrator operation", async () => {
  await withStore(async ({ root, store }) => {
    const performance = await store.applyPreset("performance");
    assert.equal(performance.preset, "performance");
    assert.equal(performance.revision, 2);
    assert.deepEqual(performance.config, MAP_RENDER_PRESETS.performance);

    const reloaded = await new MapRenderSettingsStore(root).initialize();
    assert.equal(reloaded.snapshot().preset, "performance");
    assert.deepEqual(reloaded.snapshot().config, MAP_RENDER_PRESETS.performance);
  });
});

test("captures immutable task settings while later custom changes affect only new tasks", async () => {
  await withStore(async ({ store }) => {
    const before = store.taskSnapshot();
    const custom = await store.updateCustom({
      worker: { renderConcurrency: 3, screenshotConcurrency: 2, memoryMb: 2_048 },
      preview: { width: 2_048, height: 1_152, fps: 48, antialias: false },
      mapIo: { autoSaveIntervalMs: 0 },
    });
    assert.equal(custom.preset, "custom");
    assert.equal(custom.config.worker.renderConcurrency, 3);
    assert.equal(custom.config.preview.width, 2_048);
    assert.equal(custom.config.mapIo.autoSaveIntervalMs, 0);
    assert.equal(before.preset, "stable");
    assert.equal(before.config.worker.renderConcurrency, 1);
    assert.equal(Object.isFrozen(before.config.worker), true);
  });
});

test("pauses new admission without changing the selected render preset", async () => {
  await withStore(async ({ store }) => {
    const paused = await store.setAcceptNewTasks(false);
    assert.equal(paused.acceptNewTasks, false);
    assert.equal(paused.preset, "stable");
    assert.equal(paused.revision, 2);
    const resumed = await store.setAcceptNewTasks(true);
    assert.equal(resumed.acceptNewTasks, true);
    assert.equal(resumed.preset, "stable");
  });
});

test("rejects invalid custom concurrency and export parameters", async () => {
  await withStore(async ({ store }) => {
    const maximum = await store.updateCustom({ preview: { width: 32_767, height: 32_767 } });
    assert.equal(maximum.config.preview.width, 32_767);
    await assert.rejects(
      store.updateCustom({ worker: { renderConcurrency: 1, screenshotConcurrency: 2 } }),
      (error) => error.statusCode === 400,
    );
    await assert.rejects(
      store.updateCustom({ panorama: { scale: 0 } }),
      (error) => error.statusCode === 400,
    );
    await assert.rejects(
      store.updateCustom({ worker: { queueLimit: 0 } }),
      (error) => error.statusCode === 400,
    );
    await assert.rejects(
      store.updateCustom({ preview: { width: 32_768 } }),
      (error) => error.statusCode === 400,
    );
    await assert.rejects(
      store.updateCustom({ adaptive: { enabled: true } }),
      (error) => error.statusCode === 400,
    );
    assert.equal(store.snapshot().preset, "custom");
  });
});

test("rejects stale administrator revisions without changing settings", async () => {
  await withStore(async ({ store }) => {
    const initial = store.snapshot();
    const updated = await store.updateCustom({ worker: { memoryMb: 1_024 } }, {
      expectedRevision: initial.revision,
    });
    assert.equal(updated.revision, initial.revision + 1);
    await assert.rejects(
      store.applyPreset("balanced", { expectedRevision: initial.revision }),
      (error) => error.statusCode === 409,
    );
    await assert.rejects(
      store.setAcceptNewTasks(false, { expectedRevision: 0 }),
      (error) => error.statusCode === 400,
    );
    assert.equal(store.snapshot().preset, "custom");
    assert.equal(store.snapshot().acceptNewTasks, true);
  });
});
