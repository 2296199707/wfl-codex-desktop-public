import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const DEFAULT_PRESET = "stable";
const PRESET_NAMES = new Set(["stable", "balanced", "performance"]);
const FORMAT_NAMES = new Set(["png", "webp"]);
const VIDEO_CODECS = new Set(["libvpx-vp9", "libx264"]);

export const MAP_RENDER_PRESETS = deepFreeze({
  stable: preset({
    renderConcurrency: 1,
    screenshotConcurrency: 1,
    queueLimit: 128,
    memoryMb: 768,
    tileCacheMb: 128,
    imageCacheMb: 256,
    taskTimeoutMs: 180_000,
    idleRecycleMs: 60_000,
    previewWidth: 1_280,
    previewHeight: 720,
    previewFps: 30,
    panoramaScale: 1,
    animationFps: 24,
    videoFps: 24,
    readChunkBytes: 256 * 1024,
    saveChunkBytes: 256 * 1024,
    autoSaveIntervalMs: 120_000,
  }),
  balanced: preset({
    renderConcurrency: 2,
    screenshotConcurrency: 1,
    queueLimit: 512,
    memoryMb: 1_536,
    tileCacheMb: 256,
    imageCacheMb: 512,
    taskTimeoutMs: 240_000,
    idleRecycleMs: 90_000,
    previewWidth: 1_920,
    previewHeight: 1_080,
    previewFps: 60,
    panoramaScale: 2,
    animationFps: 30,
    videoFps: 30,
    readChunkBytes: 512 * 1024,
    saveChunkBytes: 512 * 1024,
    autoSaveIntervalMs: 90_000,
  }),
  performance: preset({
    renderConcurrency: 4,
    screenshotConcurrency: 2,
    queueLimit: 2_000,
    memoryMb: 3_072,
    tileCacheMb: 512,
    imageCacheMb: 1_024,
    taskTimeoutMs: 360_000,
    idleRecycleMs: 120_000,
    previewWidth: 2_560,
    previewHeight: 1_440,
    previewFps: 60,
    panoramaScale: 3,
    animationFps: 60,
    videoFps: 60,
    readChunkBytes: 1024 * 1024,
    saveChunkBytes: 1024 * 1024,
    autoSaveIntervalMs: 60_000,
  }),
});

export class MapRenderSettingsStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(path.resolve(stateDirectory), "map-render-settings.json");
    this.now = now;
    this.settings = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const loaded = await readSettings(this.filePath, this.now());
    this.settings = loaded.settings;
    if (writeOnInitialize && loaded.normalized) await this.write();
    return this;
  }

  snapshot() {
    if (!this.settings) throw new Error("Map render settings store is not initialized");
    return structuredClone(this.settings);
  }

  taskSnapshot() {
    const current = this.snapshot();
    delete current.acceptNewTasks;
    return deepFreeze(current);
  }

  async applyPreset(name, { expectedRevision = null } = {}) {
    if (!PRESET_NAMES.has(name)) throw settingsError(400, "地图渲染预设不正确");
    return this.mutate(async () => {
      assertExpectedRevision(this.settings, expectedRevision);
      this.settings = nextSettings(this.settings, {
        preset: name,
        config: structuredClone(MAP_RENDER_PRESETS[name]),
      }, this.now());
      await this.write();
      return this.snapshot();
    });
  }

  async updateCustom(patch, { expectedRevision = null } = {}) {
    return this.mutate(async () => {
      assertExpectedRevision(this.settings, expectedRevision);
      const merged = mergeConfig(this.settings.config, patch);
      this.settings = nextSettings(this.settings, {
        preset: "custom",
        config: normalizeConfig(merged, { strict: true }),
      }, this.now());
      await this.write();
      return this.snapshot();
    });
  }

  async setAcceptNewTasks(value, { expectedRevision = null } = {}) {
    if (typeof value !== "boolean") throw settingsError(400, "地图渲染接收状态不正确");
    return this.mutate(async () => {
      assertExpectedRevision(this.settings, expectedRevision);
      this.settings = {
        ...this.settings,
        revision: this.settings.revision + 1,
        acceptNewTasks: value,
        updatedAt: this.now(),
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

function preset(input) {
  return {
    worker: {
      enabled: true,
      renderConcurrency: input.renderConcurrency,
      screenshotConcurrency: input.screenshotConcurrency,
      queueLimit: input.queueLimit,
      memoryMb: input.memoryMb,
      taskTimeoutMs: input.taskTimeoutMs,
      idleRecycleMs: input.idleRecycleMs,
    },
    cache: {
      tileMb: input.tileCacheMb,
      imageMb: input.imageCacheMb,
    },
    preview: {
      width: input.previewWidth,
      height: input.previewHeight,
      fps: input.previewFps,
      antialias: true,
    },
    panorama: {
      scale: input.panoramaScale,
      format: "png",
    },
    tiles: {
      width: 1_024,
      height: 1_024,
      scale: input.panoramaScale,
      format: "png",
    },
    animation: {
      width: input.previewWidth,
      height: input.previewHeight,
      fps: input.animationFps,
      durationMs: 2_000,
      format: "png",
    },
    video: {
      width: input.previewWidth,
      height: input.previewHeight,
      fps: input.videoFps,
      durationMs: 3_000,
      codec: "libvpx-vp9",
      crf: 18,
    },
    mapIo: {
      readChunkBytes: input.readChunkBytes,
      saveChunkBytes: input.saveChunkBytes,
      saveCommitConcurrency: 1,
      maxMapBytes: 4 * 1024 * 1024 * 1024,
      autoSaveIntervalMs: input.autoSaveIntervalMs,
    },
  };
}

function nextSettings(current, update, now) {
  return {
    version: STORE_VERSION,
    revision: current.revision + 1,
    preset: update.preset,
    acceptNewTasks: current.acceptNewTasks,
    config: update.config,
    updatedAt: now,
  };
}

function mergeConfig(current, patch) {
  if (!isRecord(patch)) throw settingsError(400, "地图渲染自定义设置不正确");
  const allowed = new Set(Object.keys(current));
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key) || !isRecord(patch[key])) throw settingsError(400, `地图渲染设置 ${key} 不正确`);
  }
  return Object.fromEntries(Object.entries(current).map(([key, value]) => [
    key,
    { ...value, ...(patch[key] || {}) },
  ]));
}

function normalizeConfig(value, { strict = false } = {}) {
  const fallback = MAP_RENDER_PRESETS[DEFAULT_PRESET];
  const input = isRecord(value) ? value : {};
  const worker = normalizeSection(input.worker, fallback.worker, {
    enabled: booleanValue,
    renderConcurrency: integer(1, 64),
    screenshotConcurrency: integer(1, 64),
    queueLimit: integer(1, 100_000),
    memoryMb: integer(256, 65_536),
    taskTimeoutMs: integer(1_000, 3_600_000),
    idleRecycleMs: integer(1_000, 3_600_000),
  }, strict);
  if (worker.screenshotConcurrency > worker.renderConcurrency) {
    if (strict) throw settingsError(400, "截图并发不能大于渲染并发");
    worker.screenshotConcurrency = worker.renderConcurrency;
  }
  return {
    worker,
    cache: normalizeSection(input.cache, fallback.cache, {
      tileMb: integer(0, 1_048_576),
      imageMb: integer(0, 1_048_576),
    }, strict),
    preview: normalizeSection(input.preview, fallback.preview, {
      width: integer(320, 32_767),
      height: integer(240, 32_767),
      fps: integer(1, 240),
      antialias: booleanValue,
    }, strict),
    panorama: normalizeSection(input.panorama, fallback.panorama, {
      scale: numberValue(0.01, 16),
      format: enumValue(FORMAT_NAMES),
    }, strict),
    tiles: normalizeSection(input.tiles, fallback.tiles, {
      width: integer(128, 8_192),
      height: integer(128, 8_192),
      scale: numberValue(0.01, 16),
      format: enumValue(FORMAT_NAMES),
    }, strict),
    animation: normalizeSection(input.animation, fallback.animation, {
      width: integer(320, 32_767),
      height: integer(240, 32_767),
      fps: integer(1, 240),
      durationMs: integer(100, 3_600_000),
      format: enumValue(FORMAT_NAMES),
    }, strict),
    video: normalizeSection(input.video, fallback.video, {
      width: integer(320, 32_767),
      height: integer(240, 32_767),
      fps: integer(1, 240),
      durationMs: integer(100, 3_600_000),
      codec: enumValue(VIDEO_CODECS),
      crf: integer(0, 63),
    }, strict),
    mapIo: normalizeSection(input.mapIo, fallback.mapIo, {
      readChunkBytes: integer(64 * 1024, 64 * 1024 * 1024),
      saveChunkBytes: integer(64 * 1024, 64 * 1024 * 1024),
      saveCommitConcurrency: integer(1, 64),
      maxMapBytes: integer(1024 * 1024, 1024 * 1024 * 1024 * 1024),
      autoSaveIntervalMs: autoSaveInterval,
    }, strict),
  };
}

function normalizeSection(value, fallback, validators, strict) {
  const input = isRecord(value) ? value : {};
  const output = {};
  for (const [key, validate] of Object.entries(validators)) {
    try {
      output[key] = validate(input[key] === undefined ? fallback[key] : input[key]);
    } catch (error) {
      if (strict) throw settingsError(400, `地图渲染设置 ${key} 不正确`);
      output[key] = fallback[key];
    }
  }
  if (strict) {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(validators, key)) throw settingsError(400, `未知地图渲染设置 ${key}`);
    }
  }
  return output;
}

function integer(minimum, maximum) {
  return (value) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError("invalid integer");
    return number;
  };
}

function numberValue(minimum, maximum) {
  return (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) throw new TypeError("invalid number");
    return number;
  };
}

function booleanValue(value) {
  if (typeof value !== "boolean") throw new TypeError("invalid boolean");
  return value;
}

function enumValue(values) {
  return (value) => {
    if (!values.has(value)) throw new TypeError("invalid enum");
    return value;
  };
}

function autoSaveInterval(value) {
  const number = Number(value);
  if (number === 0) return 0;
  if (!Number.isSafeInteger(number) || number < 5_000 || number > 3_600_000) throw new TypeError("invalid interval");
  return number;
}

async function readSettings(filePath, now) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    const presetName = PRESET_NAMES.has(raw?.preset) || raw?.preset === "custom"
      ? raw.preset
      : DEFAULT_PRESET;
    const config = presetName === "custom"
      ? normalizeConfig(raw?.config)
      : structuredClone(MAP_RENDER_PRESETS[presetName]);
    const settings = {
      version: STORE_VERSION,
      revision: positiveInteger(raw?.revision, 1),
      preset: presetName,
      acceptNewTasks: typeof raw?.acceptNewTasks === "boolean" ? raw.acceptNewTasks : true,
      config,
      updatedAt: positiveInteger(raw?.updatedAt, now),
    };
    return {
      settings,
      normalized: JSON.stringify(raw) !== JSON.stringify(settings),
    };
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return {
      settings: {
        version: STORE_VERSION,
        revision: 1,
        preset: DEFAULT_PRESET,
        acceptNewTasks: true,
        config: structuredClone(MAP_RENDER_PRESETS[DEFAULT_PRESET]),
        updatedAt: now,
      },
      normalized: true,
    };
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function assertExpectedRevision(current, expectedRevision) {
  if (expectedRevision === null || expectedRevision === undefined) return;
  const revision = Number(expectedRevision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw settingsError(400, "地图渲染设置修订号不正确");
  }
  if (revision !== current.revision) {
    throw settingsError(409, "地图渲染设置已在其他管理窗口中更新，请刷新后重试");
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function settingsError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
