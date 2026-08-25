import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const DEFAULT_PRESET = "stable";
const PRESET_NAMES = new Set(["stable", "balanced", "performance"]);

export const IMAGE_EXECUTION_PRESETS = deepFreeze({
  stable: preset({
    concurrency: 1,
    perUserConcurrency: 1,
    queueLimit: 128,
    perUserQueueLimit: 16,
    memoryMb: 1_024,
    totalMemoryMb: 1_024,
    taskTimeoutMs: 10 * 60_000,
    cancelGraceMs: 5_000,
  }),
  balanced: preset({
    concurrency: 2,
    perUserConcurrency: 1,
    queueLimit: 512,
    perUserQueueLimit: 32,
    memoryMb: 1_024,
    totalMemoryMb: 2_048,
    taskTimeoutMs: 10 * 60_000,
    cancelGraceMs: 5_000,
  }),
  performance: preset({
    concurrency: 4,
    perUserConcurrency: 2,
    queueLimit: 2_000,
    perUserQueueLimit: 128,
    memoryMb: 1_536,
    totalMemoryMb: 6_144,
    taskTimeoutMs: 15 * 60_000,
    cancelGraceMs: 5_000,
  }),
});

export class ImageExecutionSettingsStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(path.resolve(stateDirectory), "image-execution-settings.json");
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
    if (!this.settings) throw new Error("Image execution settings store is not initialized");
    return structuredClone(this.settings);
  }

  taskSnapshot() {
    const current = this.snapshot();
    delete current.acceptNewTasks;
    return deepFreeze(current);
  }

  async applyPreset(name, { expectedRevision = null } = {}) {
    if (!PRESET_NAMES.has(name)) throw settingsError(400, "图片执行预设不正确");
    return this.mutate(async () => {
      assertExpectedRevision(this.settings, expectedRevision);
      this.settings = nextSettings(this.settings, {
        preset: name,
        config: structuredClone(IMAGE_EXECUTION_PRESETS[name]),
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
    if (typeof value !== "boolean") throw settingsError(400, "图片执行接收状态不正确");
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

function preset(worker) {
  return { worker: { enabled: true, ...worker } };
}

async function readSettings(filename, now) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") return { settings: defaults(now), normalized: true };
    return { settings: defaults(now), normalized: true };
  }
  const fallback = defaults(now);
  if (!isRecord(raw)) return { settings: fallback, normalized: true };
  const presetName = PRESET_NAMES.has(raw.preset) ? raw.preset : DEFAULT_PRESET;
  let config;
  try {
    config = normalizeConfig(raw.config || IMAGE_EXECUTION_PRESETS[presetName]);
  } catch {
    config = structuredClone(IMAGE_EXECUTION_PRESETS[presetName]);
  }
  const settings = {
    version: STORE_VERSION,
    revision: nonNegativeInteger(raw.revision, 0),
    preset: raw.preset === "custom" || PRESET_NAMES.has(raw.preset) ? raw.preset : DEFAULT_PRESET,
    acceptNewTasks: typeof raw.acceptNewTasks === "boolean" ? raw.acceptNewTasks : true,
    config,
    updatedAt: nonNegativeInteger(raw.updatedAt, now),
  };
  return { settings, normalized: JSON.stringify(settings) !== JSON.stringify(raw) };
}

function defaults(now) {
  return {
    version: STORE_VERSION,
    revision: 1,
    preset: DEFAULT_PRESET,
    acceptNewTasks: true,
    config: structuredClone(IMAGE_EXECUTION_PRESETS[DEFAULT_PRESET]),
    updatedAt: now,
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
  if (!isRecord(patch)) throw settingsError(400, "图片执行自定义设置不正确");
  for (const key of Object.keys(patch)) {
    if (key !== "worker" || !isRecord(patch[key])) {
      throw settingsError(400, `图片执行设置 ${key} 不正确`);
    }
  }
  return { worker: { ...current.worker, ...(patch.worker || {}) } };
}

function normalizeConfig(value, { strict = false } = {}) {
  const fallback = IMAGE_EXECUTION_PRESETS[DEFAULT_PRESET].worker;
  const input = isRecord(value?.worker) ? value.worker : {};
  const validators = {
    enabled: booleanValue,
    concurrency: integer(1, 64),
    perUserConcurrency: integer(1, 64),
    queueLimit: integer(1, 100_000),
    perUserQueueLimit: integer(1, 100_000),
    memoryMb: integer(256, 65_536),
    totalMemoryMb: integer(256, 1_048_576),
    taskTimeoutMs: integer(1_000, 3_600_000),
    cancelGraceMs: integer(100, 60_000),
  };
  const worker = {};
  for (const [key, validate] of Object.entries(validators)) {
    try {
      worker[key] = validate(input[key] === undefined ? fallback[key] : input[key]);
    } catch (error) {
      if (strict) throw settingsError(400, `图片执行设置 worker.${key} 不正确`);
      worker[key] = fallback[key];
    }
  }
  if (worker.perUserConcurrency > worker.concurrency) {
    if (strict) throw settingsError(400, "单用户图片并发不能大于总并发");
    worker.perUserConcurrency = worker.concurrency;
  }
  if (worker.perUserQueueLimit > worker.queueLimit) {
    if (strict) throw settingsError(400, "单用户图片排队上限不能大于总排队上限");
    worker.perUserQueueLimit = worker.queueLimit;
  }
  if (worker.totalMemoryMb < worker.concurrency * worker.memoryMb) {
    if (strict) throw settingsError(400, "图片 Worker 总内存预算不能小于并发数乘以单任务内存预算");
    worker.totalMemoryMb = worker.concurrency * worker.memoryMb;
  }
  return { worker };
}

function assertExpectedRevision(settings, expected) {
  if (expected == null) return;
  if (!Number.isSafeInteger(expected) || expected < 1) throw settingsError(400, "图片执行设置版本不正确");
  if (settings.revision !== expected) throw settingsError(409, "图片执行设置已被其他管理员更新");
}

function integer(minimum, maximum) {
  return (value) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("integer");
    return value;
  };
}

function booleanValue(value) {
  if (typeof value !== "boolean") throw new TypeError("boolean");
  return value;
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function settingsError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, code: "IMAGE_EXECUTION_SETTINGS_INVALID" });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
