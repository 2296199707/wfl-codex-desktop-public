import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_IMAGE_PREVIEW_PRESET,
  DEFAULT_IMAGE_PREVIEW_DISPLAY_SIZE,
  IMAGE_PREVIEW_DISPLAY_SIZES,
  IMAGE_PREVIEW_PRESETS,
  WebSettingsStore,
} from "../lib/web-settings-store.mjs";

test("web settings expose five bounded image preview presets and persist the selected default", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-web-settings-"));
  try {
    const store = await new WebSettingsStore(directory).initialize();
    assert.equal(store.snapshot().imagePreviewPreset, DEFAULT_IMAGE_PREVIEW_PRESET);
    assert.equal(store.snapshot().imagePreviewDisplaySize, DEFAULT_IMAGE_PREVIEW_DISPLAY_SIZE);
    assert.deepEqual(Object.keys(IMAGE_PREVIEW_DISPLAY_SIZES), ["auto", "compact", "standard", "wide"]);
    assert.deepEqual(Object.keys(IMAGE_PREVIEW_PRESETS), [
      "minimal",
      "economy",
      "standard",
      "clear",
      "high",
    ]);
    assert.deepEqual(store.imagePreview(), {
      preset: "standard",
      maxEdge: 1024,
      quality: 65,
      displaySize: "auto",
      displayWidth: 640,
    });

    await store.update({ imagePreviewPreset: "high", imagePreviewDisplaySize: "compact" });
    const restored = await new WebSettingsStore(directory).initialize();
    assert.equal(restored.snapshot().imagePreviewPreset, "high");
    assert.equal(restored.snapshot().imagePreviewDisplaySize, "compact");
    assert.deepEqual(restored.imagePreview(), {
      preset: "high",
      maxEdge: 1920,
      quality: 82,
      displaySize: "compact",
      displayWidth: 480,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("web settings reject unknown image preview presets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-web-settings-"));
  try {
    const store = await new WebSettingsStore(directory).initialize();
    await assert.rejects(
      store.update({ imagePreviewPreset: "unbounded" }),
      (error) => error.status === 400 && /档位/.test(error.message),
    );
    assert.equal(store.snapshot().imagePreviewPreset, "standard");
    await assert.rejects(
      store.update({ imagePreviewDisplaySize: "unbounded" }),
      (error) => error.status === 400 && /显示尺寸/.test(error.message),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
