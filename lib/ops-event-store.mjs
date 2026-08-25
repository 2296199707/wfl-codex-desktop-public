import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class OpsEventStore {
  constructor(directory, {
    now = () => Date.now(),
    retentionMs = DEFAULT_RETENTION_MS,
    maxEvents = DEFAULT_MAX_EVENTS,
    compactEvery = 100,
    writeOnInitialize = true,
  } = {}) {
    this.filePath = path.join(path.resolve(directory), "ops-events.ndjson");
    this.directory = path.dirname(this.filePath);
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxEvents = maxEvents;
    this.compactEvery = compactEvery;
    this.writeOnInitialize = writeOnInitialize;
    this.events = [];
    this.pendingCompaction = 0;
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    this.events = (await readTail(this.filePath, MAX_FILE_BYTES)).map(normalizeStoredEvent).filter(Boolean);
    this.prune();
    if (this.writeOnInitialize) await this.compact();
    this.initialized = true;
    return this;
  }

  activate() {
    return this.mutate(async () => {
      this.assertInitialized();
      this.events = (await readTail(this.filePath, MAX_FILE_BYTES)).map(normalizeStoredEvent).filter(Boolean);
      this.prune();
      await this.compact();
    });
  }

  record(input) {
    return this.mutate(async () => {
      this.assertInitialized();
      const event = normalizeNewEvent(input, this.now());
      this.events.push(event);
      this.prune();
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      this.pendingCompaction += 1;
      if (this.pendingCompaction >= this.compactEvery) await this.compact();
      return structuredClone(event);
    });
  }

  query({ limit = 100, before = null, severity = null, type = null } = {}) {
    this.assertInitialized();
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const beforeAt = before !== null && before !== undefined && Number.isFinite(Number(before))
      ? Number(before)
      : Number.POSITIVE_INFINITY;
    return this.events
      .filter((event) => event.at < beforeAt)
      .filter((event) => !severity || event.severity === severity)
      .filter((event) => !type || event.type === type)
      .slice(-boundedLimit)
      .reverse()
      .map((event) => structuredClone(event));
  }

  async flush() {
    await this.writeQueue;
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    this.events = this.events
      .filter((event) => event.at >= cutoff && event.at <= this.now() + 60_000)
      .sort((left, right) => left.at - right.at)
      .slice(-this.maxEvents);
  }

  async compact() {
    const content = this.events.map((event) => JSON.stringify(event)).join("\n") + (this.events.length ? "\n" : "");
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
    this.pendingCompaction = 0;
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Operations event store is not initialized");
  }
}

function normalizeNewEvent(input, at) {
  const type = cleanType(input?.type);
  const severity = ["info", "warning", "critical"].includes(input?.severity) ? input.severity : "info";
  const title = cleanText(input?.title, 120);
  if (!type || !title) throw new TypeError("Invalid operations event");
  return {
    id: `evt-${crypto.randomBytes(8).toString("hex")}`,
    at: Math.round(at),
    type,
    severity,
    source: cleanType(input?.source) || "system",
    title,
    detail: cleanText(input?.detail, 240) || null,
  };
}

function normalizeStoredEvent(value) {
  if (!/^evt-[a-f0-9]{16}$/.test(String(value?.id || ""))) return null;
  const at = Number(value.at);
  const type = cleanType(value.type);
  const title = cleanText(value.title, 120);
  if (!Number.isFinite(at) || !type || !title) return null;
  return {
    id: value.id,
    at: Math.round(at),
    type,
    severity: ["info", "warning", "critical"].includes(value.severity) ? value.severity : "info",
    source: cleanType(value.source) || "system",
    title,
    detail: cleanText(value.detail, 240) || null,
  };
}

function cleanType(value) {
  const result = String(value || "").trim();
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(result) ? result : "";
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

async function readTail(filePath, maxBytes) {
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
