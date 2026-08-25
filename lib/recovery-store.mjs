import fs from "node:fs/promises";
import path from "node:path";

const STATUSES = new Set(["remembered", "recovered", "read-only", "failed"]);

export class RecoveryStore {
  constructor(stateDirectory, { limit = 20, now = () => Date.now() } = {}) {
    this.filePath = path.join(stateDirectory, "thread-recovery.json");
    this.limit = limit;
    this.now = now;
    this.records = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.records = (Array.isArray(stored?.records) ? stored.records : [])
        .map(normalizeStoredRecord)
        .filter(Boolean)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, this.limit);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.records = [];
    }
    return this;
  }

  snapshot() {
    return this.records.map((record) => ({ ...record }));
  }

  async remember(input) {
    const record = normalizeInputRecord(input, this.now());
    this.records = [record, ...this.records.filter((entry) => entry.threadId !== record.threadId)]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, this.limit);
    await this.persist();
    return { ...record };
  }

  async remove(threadId) {
    validateThreadId(threadId);
    const previousLength = this.records.length;
    this.records = this.records.filter((record) => record.threadId !== threadId);
    if (this.records.length !== previousLength) await this.persist();
    return this.records.length !== previousLength;
  }

  async persist() {
    const content = `${JSON.stringify({ version: 1, records: this.records }, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    await this.writeQueue;
  }
}

function normalizeInputRecord(input, updatedAt) {
  const threadId = String(input?.threadId || "").trim();
  const cwd = path.resolve(String(input?.cwd || ""));
  const status = String(input?.status || "remembered");
  validateThreadId(threadId);
  if (!path.isAbsolute(String(input?.cwd || "")) || cwd.length > 4096) {
    throw Object.assign(new Error("Invalid recovery project path"), { statusCode: 400 });
  }
  if (!STATUSES.has(status)) {
    throw Object.assign(new Error("Invalid recovery status"), { statusCode: 400 });
  }
  return { threadId, cwd, updatedAt, status };
}

function normalizeStoredRecord(record) {
  try {
    const normalized = normalizeInputRecord(record, Number(record.updatedAt));
    return Number.isFinite(normalized.updatedAt) && normalized.updatedAt > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function validateThreadId(threadId) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(threadId))) {
    throw Object.assign(new Error("Invalid recovery thread ID"), { statusCode: 400 });
  }
}
