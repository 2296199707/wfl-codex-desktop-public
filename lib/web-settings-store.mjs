import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 2;

export const IMAGE_PREVIEW_PRESETS = Object.freeze({
  minimal: Object.freeze({ maxEdge: 480, quality: 40 }),
  economy: Object.freeze({ maxEdge: 640, quality: 55 }),
  standard: Object.freeze({ maxEdge: 1024, quality: 65 }),
  clear: Object.freeze({ maxEdge: 1440, quality: 75 }),
  high: Object.freeze({ maxEdge: 1920, quality: 82 }),
});

export const DEFAULT_IMAGE_PREVIEW_PRESET = "standard";

export const IMAGE_PREVIEW_DISPLAY_SIZES = Object.freeze({
  auto: Object.freeze({ maxWidth: null }),
  compact: Object.freeze({ maxWidth: 480 }),
  standard: Object.freeze({ maxWidth: 640 }),
  wide: Object.freeze({ maxWidth: 760 }),
});

export const DEFAULT_IMAGE_PREVIEW_DISPLAY_SIZE = "auto";

// Auto sizing keeps the rendered card below the preview source resolution and
// avoids enlarging low-quality thumbnails on mobile or zoomed browsers.
const AUTO_DISPLAY_WIDTH_FACTOR = 0.67;

export class WebSettingsStore {
  constructor(stateDirectory) {
    this.filePath = path.join(path.resolve(stateDirectory), "web-settings.json");
    this.settings = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const { settings, normalized } = await readSettings(this.filePath);
    this.settings = settings;
    if (writeOnInitialize && normalized) await this.write();
    return this;
  }

  snapshot() {
    if (!this.settings) throw new Error("Web settings store is not initialized");
    const settings = structuredClone(this.settings);
    const preset = IMAGE_PREVIEW_PRESETS[settings.imagePreviewPreset];
    const display = IMAGE_PREVIEW_DISPLAY_SIZES[settings.imagePreviewDisplaySize];
    settings.imagePreviewDisplayWidth = display.maxWidth || Math.min(
      Math.max(Math.round(preset.maxEdge * AUTO_DISPLAY_WIDTH_FACTOR), 320),
      640,
    );
    return settings;
  }

  imagePreview() {
    const settings = this.snapshot();
    const preset = settings.imagePreviewPreset;
    return {
      preset,
      ...IMAGE_PREVIEW_PRESETS[preset],
      displaySize: settings.imagePreviewDisplaySize,
      displayWidth: settings.imagePreviewDisplayWidth,
    };
  }

  async update(input) {
    const current = this.snapshot();
    const imagePreviewPreset = Object.hasOwn(input || {}, "imagePreviewPreset")
      ? normalizeImagePreviewPreset(input.imagePreviewPreset, { strict: true })
      : current.imagePreviewPreset;
    const imagePreviewDisplaySize = Object.hasOwn(input || {}, "imagePreviewDisplaySize")
      ? normalizeImagePreviewDisplaySize(input.imagePreviewDisplaySize, { strict: true })
      : current.imagePreviewDisplaySize;
    return this.mutate(async () => {
      this.settings = {
        version: STORE_VERSION,
        imagePreviewPreset,
        imagePreviewDisplaySize,
      };
      await this.write();
      return this.snapshot();
    });
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async write() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}

export function normalizeImagePreviewPreset(value, { strict = false } = {}) {
  if (Object.hasOwn(IMAGE_PREVIEW_PRESETS, value)) return value;
  if (strict) throw storeError(400, "图片预览档位不正确");
  return DEFAULT_IMAGE_PREVIEW_PRESET;
}

export function normalizeImagePreviewDisplaySize(value, { strict = false } = {}) {
  if (Object.hasOwn(IMAGE_PREVIEW_DISPLAY_SIZES, value)) return value;
  if (strict) throw storeError(400, "图片预览显示尺寸不正确");
  return DEFAULT_IMAGE_PREVIEW_DISPLAY_SIZE;
}

async function readSettings(filePath) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    const imagePreviewPreset = normalizeImagePreviewPreset(raw?.imagePreviewPreset);
    const imagePreviewDisplaySize = normalizeImagePreviewDisplaySize(raw?.imagePreviewDisplaySize);
    return {
      settings: { version: STORE_VERSION, imagePreviewPreset, imagePreviewDisplaySize },
      normalized: raw?.version !== STORE_VERSION
        || raw?.imagePreviewPreset !== imagePreviewPreset
        || raw?.imagePreviewDisplaySize !== imagePreviewDisplaySize,
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return {
        settings: {
          version: STORE_VERSION,
          imagePreviewPreset: DEFAULT_IMAGE_PREVIEW_PRESET,
          imagePreviewDisplaySize: DEFAULT_IMAGE_PREVIEW_DISPLAY_SIZE,
        },
        normalized: true,
      };
    }
    throw error;
  }
}

function storeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
