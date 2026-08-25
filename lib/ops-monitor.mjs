import os from "node:os";
import fs from "node:fs/promises";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_SAMPLES = 360;

export class OpsMonitor {
  constructor({
    now = () => Date.now(),
    cpuTimes = defaultCpuTimes,
    memoryUsage = defaultMemoryUsage,
    diskUsage,
    networkUsage = defaultNetworkUsage,
    onSample = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxSamples = DEFAULT_MAX_SAMPLES,
  } = {}) {
    if (typeof diskUsage !== "function") throw new TypeError("diskUsage is required");
    this.now = now;
    this.cpuTimes = cpuTimes;
    this.memoryUsage = memoryUsage;
    this.diskUsage = diskUsage;
    this.networkUsage = networkUsage;
    this.onSample = typeof onSample === "function" ? onSample : null;
    this.intervalMs = intervalMs;
    this.maxSamples = maxSamples;
    this.previousCpu = this.cpuTimes();
    this.previousNetwork = null;
    this.samples = [];
    this.timer = null;
    this.pendingSample = null;
  }

  start() {
    if (this.timer) return this;
    this.sample().catch(() => {});
    this.timer = setInterval(() => this.sample().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async sample() {
    if (this.pendingSample) return this.pendingSample;
    const latest = this.samples.at(-1);
    if (latest && this.now() - latest.at < this.intervalMs) return structuredClone(latest);
    this.pendingSample = this.captureSample();
    try {
      return await this.pendingSample;
    } finally {
      this.pendingSample = null;
    }
  }

  history() {
    return this.samples.map((sample) => structuredClone(sample));
  }

  latest() {
    return this.samples.length ? structuredClone(this.samples.at(-1)) : null;
  }

  async captureSample() {
    const currentCpu = this.cpuTimes();
    const idleDelta = currentCpu.idle - this.previousCpu.idle;
    const totalDelta = currentCpu.total - this.previousCpu.total;
    this.previousCpu = currentCpu;
    const cpuPercent = totalDelta > 0 ? percentage(totalDelta - idleDelta, totalDelta) : 0;
    const memory = normalizeUsage(this.memoryUsage());
    const disk = normalizeUsage(await this.diskUsage());
    const network = normalizeNetwork(await this.networkUsage());
    const elapsedSeconds = this.previousNetwork
      ? Math.max(0.001, (this.now() - this.previousNetwork.at) / 1000)
      : null;
    const sample = {
      at: this.now(),
      cpuPercent: clamp(cpuPercent),
      memory: { ...memory, percent: percentage(memory.usedBytes, memory.totalBytes) },
      disk: { ...disk, percent: percentage(disk.usedBytes, disk.totalBytes) },
      network: {
        rxBytesPerSecond: elapsedSeconds ? Math.max(0, Math.round((network.rxBytes - this.previousNetwork.rxBytes) / elapsedSeconds)) : 0,
        txBytesPerSecond: elapsedSeconds ? Math.max(0, Math.round((network.txBytes - this.previousNetwork.txBytes) / elapsedSeconds)) : 0,
      },
    };
    this.previousNetwork = { ...network, at: sample.at };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
    if (this.onSample) await this.onSample(structuredClone(sample));
    return structuredClone(sample);
  }
}

async function defaultNetworkUsage() {
  try {
    const text = await fs.readFile("/proc/net/dev", "utf8");
    return text.split("\n").slice(2).reduce((total, line) => {
      const [name, values] = line.trim().split(":", 2);
      if (!values || name === "lo") return total;
      const fields = values.trim().split(/\s+/).map(Number);
      total.rxBytes += Number.isFinite(fields[0]) ? fields[0] : 0;
      total.txBytes += Number.isFinite(fields[8]) ? fields[8] : 0;
      return total;
    }, { rxBytes: 0, txBytes: 0 });
  } catch {
    return { rxBytes: 0, txBytes: 0 };
  }
}

function normalizeNetwork(value) {
  return {
    rxBytes: Math.max(0, Number(value?.rxBytes) || 0),
    txBytes: Math.max(0, Number(value?.txBytes) || 0),
  };
}

function defaultCpuTimes() {
  return os.cpus().reduce(
    (snapshot, cpu) => {
      snapshot.idle += cpu.times.idle;
      snapshot.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return snapshot;
    },
    { idle: 0, total: 0 },
  );
}

function defaultMemoryUsage() {
  const totalBytes = os.totalmem();
  return { usedBytes: totalBytes - os.freemem(), totalBytes };
}

function normalizeUsage(value) {
  const totalBytes = Math.max(0, Number(value?.totalBytes) || 0);
  const usedBytes = Math.max(0, Math.min(totalBytes, Number(value?.usedBytes) || 0));
  return { usedBytes, totalBytes };
}

function percentage(used, total) {
  return total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}
