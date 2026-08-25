import fs from "node:fs/promises";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RAW_RETENTION_MS = 24 * HOUR_MS;
const DEFAULT_TREND_RETENTION_MS = 7 * 24 * HOUR_MS;
const DEFAULT_COMPACT_INTERVAL_MS = 6 * HOUR_MS;
const MAX_RAW_FILE_BYTES = 16 * 1024 * 1024;

export class OpsHistoryStore {
  constructor(directory, {
    now = () => Date.now(),
    rawRetentionMs = DEFAULT_RAW_RETENTION_MS,
    trendRetentionMs = DEFAULT_TREND_RETENTION_MS,
    compactIntervalMs = DEFAULT_COMPACT_INTERVAL_MS,
    maxRawSamples = 10_000,
    maxTrendSamples = 168,
    writeOnInitialize = true,
  } = {}) {
    this.directory = path.resolve(directory);
    this.rawPath = path.join(this.directory, "ops-metrics.ndjson");
    this.trendPath = path.join(this.directory, "ops-metric-trends.json");
    this.now = now;
    this.rawRetentionMs = rawRetentionMs;
    this.trendRetentionMs = trendRetentionMs;
    this.compactIntervalMs = compactIntervalMs;
    this.maxRawSamples = maxRawSamples;
    this.maxTrendSamples = maxTrendSamples;
    this.writeOnInitialize = writeOnInitialize;
    this.raw = [];
    this.trends = [];
    this.lastCompactedAt = 0;
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const now = this.now();
    const [raw, trends] = await Promise.all([
      readNdjsonTail(this.rawPath, MAX_RAW_FILE_BYTES),
      readJson(this.trendPath, []),
    ]);
    this.raw = raw.map(normalizeSample).filter(Boolean);
    this.trends = Array.isArray(trends) ? trends.map(normalizeSample).filter(Boolean) : [];
    this.prune(now);
    this.rollupCompletedHours(now);
    if (this.writeOnInitialize) {
      await this.compactRaw();
      await this.writeTrends();
    }
    this.lastCompactedAt = now;
    this.initialized = true;
    return this;
  }

  activate() {
    return this.mutate(async () => {
      this.assertInitialized();
      const now = this.now();
      const [raw, trends] = await Promise.all([
        readNdjsonTail(this.rawPath, MAX_RAW_FILE_BYTES),
        readJson(this.trendPath, []),
      ]);
      this.raw = raw.map(normalizeSample).filter(Boolean);
      this.trends = Array.isArray(trends) ? trends.map(normalizeSample).filter(Boolean) : [];
      this.prune(now);
      this.rollupCompletedHours(now);
      await this.compactRaw();
      await this.writeTrends();
      this.lastCompactedAt = now;
    });
  }

  record(value) {
    const sample = normalizeSample(value);
    if (!sample) return Promise.reject(new TypeError("Invalid operations metric sample"));
    return this.mutate(async () => {
      this.assertInitialized();
      const latest = this.raw.at(-1);
      if (latest && sample.at <= latest.at) return structuredClone(latest);
      this.raw.push(sample);
      this.prune(sample.at);
      await fs.appendFile(this.rawPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
      const trendsChanged = this.rollupCompletedHours(sample.at);
      if (trendsChanged) await this.writeTrends();
      if (sample.at - this.lastCompactedAt >= this.compactIntervalMs) {
        await this.compactRaw();
        this.lastCompactedAt = sample.at;
      }
      return structuredClone(sample);
    });
  }

  query(range = "1h") {
    this.assertInitialized();
    const now = this.now();
    if (range === "7d") {
      const currentHour = hourStart(now);
      const current = summarizeBucket(this.raw.filter((sample) => hourStart(sample.at) === currentHour), currentHour);
      const samples = [...this.trends.filter((sample) => sample.at >= now - this.trendRetentionMs)];
      if (current) samples.push(current);
      return {
        range,
        retentionSeconds: Math.round(this.trendRetentionMs / 1000),
        granularitySeconds: Math.round(HOUR_MS / 1000),
        samples: samples.slice(-this.maxTrendSamples).map((sample) => structuredClone(sample)),
      };
    }
    const retentionMs = range === "24h" ? this.rawRetentionMs : HOUR_MS;
    return {
      range: range === "24h" ? "24h" : "1h",
      retentionSeconds: Math.round(retentionMs / 1000),
      granularitySeconds: null,
      samples: this.raw
        .filter((sample) => sample.at >= now - retentionMs)
        .map((sample) => structuredClone(sample)),
    };
  }

  latest() {
    this.assertInitialized();
    return this.raw.length ? structuredClone(this.raw.at(-1)) : null;
  }

  async flush() {
    await this.writeQueue;
  }

  prune(now) {
    this.raw = this.raw
      .filter((sample) => sample.at >= now - this.rawRetentionMs && sample.at <= now + 60_000)
      .sort((left, right) => left.at - right.at)
      .slice(-this.maxRawSamples);
    this.trends = deduplicateByTimestamp(this.trends)
      .filter((sample) => sample.at >= now - this.trendRetentionMs && sample.at <= now + HOUR_MS)
      .slice(-this.maxTrendSamples);
  }

  rollupCompletedHours(now) {
    const currentHour = hourStart(now);
    const buckets = new Map();
    for (const sample of this.raw) {
      const bucket = hourStart(sample.at);
      if (bucket >= currentHour) continue;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(sample);
    }
    let changed = false;
    const byTimestamp = new Map(this.trends.map((sample) => [sample.at, sample]));
    for (const [bucket, samples] of buckets) {
      const summary = summarizeBucket(samples, bucket);
      if (!summary) continue;
      const previous = byTimestamp.get(bucket);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(summary)) {
        byTimestamp.set(bucket, summary);
        changed = true;
      }
    }
    this.trends = [...byTimestamp.values()]
      .sort((left, right) => left.at - right.at)
      .filter((sample) => sample.at >= now - this.trendRetentionMs)
      .slice(-this.maxTrendSamples);
    return changed;
  }

  async compactRaw() {
    await writeAtomic(this.rawPath, this.raw.map((sample) => JSON.stringify(sample)).join("\n") + (this.raw.length ? "\n" : ""));
  }

  async writeTrends() {
    await writeAtomic(this.trendPath, `${JSON.stringify(this.trends)}\n`);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Operations history store is not initialized");
  }
}

function normalizeSample(value) {
  const at = Number(value?.at);
  if (!Number.isFinite(at) || at < 0) return null;
  const memory = normalizeUsage(value?.memory);
  const disk = normalizeUsage(value?.disk);
  if (!memory || !disk) return null;
  return {
    at: Math.round(at),
    cpuPercent: percent(value?.cpuPercent),
    memory: { ...memory, percent: percent(value?.memory?.percent) },
    disk: { ...disk, percent: percent(value?.disk?.percent) },
    network: {
      rxBytesPerSecond: byteRate(value?.network?.rxBytesPerSecond),
      txBytesPerSecond: byteRate(value?.network?.txBytesPerSecond),
    },
  };
}

function byteRate(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizeUsage(value) {
  const usedBytes = Number(value?.usedBytes);
  const totalBytes = Number(value?.totalBytes);
  if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes) || usedBytes < 0 || totalBytes < usedBytes) return null;
  return { usedBytes: Math.round(usedBytes), totalBytes: Math.round(totalBytes) };
}

function percent(value) {
  return Math.round(Math.max(0, Math.min(100, Number(value) || 0)) * 10) / 10;
}

function hourStart(value) {
  return Math.floor(value / HOUR_MS) * HOUR_MS;
}

function summarizeBucket(samples, at) {
  if (!samples.length) return null;
  const average = (selector) => Math.round(samples.reduce((total, sample) => total + selector(sample), 0) / samples.length);
  return normalizeSample({
    at,
    cpuPercent: average((sample) => sample.cpuPercent * 10) / 10,
    memory: {
      usedBytes: average((sample) => sample.memory.usedBytes),
      totalBytes: average((sample) => sample.memory.totalBytes),
      percent: average((sample) => sample.memory.percent * 10) / 10,
    },
    disk: {
      usedBytes: average((sample) => sample.disk.usedBytes),
      totalBytes: average((sample) => sample.disk.totalBytes),
      percent: average((sample) => sample.disk.percent * 10) / 10,
    },
    network: {
      rxBytesPerSecond: average((sample) => sample.network.rxBytesPerSecond),
      txBytesPerSecond: average((sample) => sample.network.txBytesPerSecond),
    },
  });
}

function deduplicateByTimestamp(samples) {
  return [...new Map(samples.sort((left, right) => left.at - right.at).map((sample) => [sample.at, sample])).values()];
}

async function readNdjsonTail(filePath, maxBytes) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}
