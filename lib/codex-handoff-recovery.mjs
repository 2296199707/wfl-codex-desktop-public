import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const MAX_RECORDS = 512;
const HANDOFF_STATES = new Set(["prepared", "recovering", "failed"]);
const RECORD_STATES = new Set(["pending", "recovering", "interrupted", "completed", "failed"]);

/**
 * Durable, deliberately small journal for the boundary between two main
 * backends.  It contains only enough identity to re-check a native Thread;
 * transcript and task authority remain owned by Codex and the live runtime.
 */
export class CodexHandoffRecoveryStore {
  constructor(runtimeDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(path.resolve(runtimeDirectory), "codex-thread-handoff.json");
    this.now = now;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
    try {
      this.state = normalizeState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.state = null;
    }
    return this;
  }

  snapshot() {
    if (!this.state) return null;
    return cloneState(this.state);
  }

  async begin({ handoffId, sourceBackendInstanceId = null, sourceWriterEpoch = null } = {}) {
    const normalizedId = normalizeIdentifier(handoffId, "handoff ID");
    if (this.state?.handoffId === normalizedId && HANDOFF_STATES.has(this.state.state)) {
      return this.snapshot();
    }
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      handoffId: normalizedId,
      sourceBackendInstanceId: normalizeOptionalIdentifier(sourceBackendInstanceId),
      sourceWriterEpoch: normalizeOptionalEpoch(sourceWriterEpoch),
      state: "prepared",
      createdAt: this.now(),
      updatedAt: this.now(),
      records: [],
    };
    await this.persist();
    return this.snapshot();
  }

  async upsert(record = {}) {
    if (!this.state) throw new Error("Codex handoff journal has not been started");
    const normalized = normalizeRecord(record, this.now());
    const key = handoffRecordKey(normalized);
    const records = this.state.records.filter((entry) => handoffRecordKey(entry) !== key);
    records.unshift(normalized);
    this.state = {
      ...this.state,
      records: records.slice(0, MAX_RECORDS),
      updatedAt: this.now(),
    };
    await this.persist();
    return normalized;
  }

  async updateRecord(record, patch = {}) {
    if (!this.state) return null;
    const key = typeof record === "string" ? record : handoffRecordKey(record);
    const current = this.state.records.find((entry) => handoffRecordKey(entry) === key);
    if (!current) return null;
    const next = normalizeRecord({ ...current, ...patch }, this.now());
    this.state = {
      ...this.state,
      records: this.state.records.map((entry) => (
        handoffRecordKey(entry) === key ? next : entry
      )),
      updatedAt: this.now(),
    };
    await this.persist();
    return next;
  }

  async setState(state) {
    if (!this.state) return null;
    if (!HANDOFF_STATES.has(state)) throw new Error("Invalid Codex handoff state");
    this.state = { ...this.state, state, updatedAt: this.now() };
    await this.persist();
    return this.snapshot();
  }

  async clear(handoffId = null) {
    if (handoffId && this.state?.handoffId !== handoffId) return false;
    this.state = null;
    this.writeQueue = this.writeQueue.then(() => fs.rm(this.filePath, { force: true }));
    await this.writeQueue;
    return true;
  }

  async persist() {
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    await this.writeQueue;
  }
}

export function handoffRecordKey(record) {
  return `${String(record?.userId || "")}\u0000${String(record?.threadId || "")}`;
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported Codex handoff journal schema");
  const handoffId = normalizeIdentifier(value.handoffId, "handoff ID");
  if (!HANDOFF_STATES.has(value.state)) throw new Error("Invalid Codex handoff journal state");
  const records = Array.isArray(value.records)
    ? value.records.slice(0, MAX_RECORDS).map((record) => normalizeRecord(record, value.updatedAt)).filter(Boolean)
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    handoffId,
    sourceBackendInstanceId: normalizeOptionalIdentifier(value.sourceBackendInstanceId),
    sourceWriterEpoch: normalizeOptionalEpoch(value.sourceWriterEpoch),
    state: value.state,
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt),
    records,
  };
}

function normalizeRecord(value, timestamp) {
  const userId = normalizeIdentifier(value?.userId, "user ID");
  const threadId = normalizeIdentifier(value?.threadId, "thread ID");
  const cwd = typeof value?.cwd === "string" && path.isAbsolute(value.cwd)
    ? path.resolve(value.cwd)
    : null;
  if (!cwd || cwd.length > 4_096) throw new Error("Invalid Codex handoff project path");
  const state = RECORD_STATES.has(value?.state) ? value.state : "pending";
  return {
    userId,
    threadId,
    nativeThreadId: normalizeOptionalIdentifier(value?.nativeThreadId),
    turnId: normalizeOptionalIdentifier(value?.turnId),
    cwd,
    clientSubmissionId: normalizeOptionalIdentifier(value?.clientSubmissionId),
    state,
    nativeStatus: normalizeOptionalIdentifier(value?.nativeStatus),
    createdAt: normalizeTimestamp(value?.createdAt) || timestamp,
    updatedAt: normalizeTimestamp(value?.updatedAt) || timestamp,
  };
}

function cloneState(value) {
  return {
    ...value,
    records: value.records.map((record) => ({ ...record })),
  };
}

function normalizeIdentifier(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 256 || /[\u0000\r\n]/.test(normalized)) {
    throw new Error(`Invalid Codex handoff ${label}`);
  }
  return normalized;
}

function normalizeOptionalIdentifier(value) {
  if (value == null || value === "") return null;
  return normalizeIdentifier(value, "identifier");
}

function normalizeOptionalEpoch(value) {
  if (value == null || value === "") return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}
