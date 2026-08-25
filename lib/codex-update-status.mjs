import fs from "node:fs/promises";
import path from "node:path";

const STATUSES = new Set(["idle", "running", "completed", "failed", "recovered"]);
const ACTIVE_STATUS_TTL_MS = 35 * 60 * 1000;
const PHASES = new Set([
  "idle",
  "queued",
  "checking",
  "waiting",
  "draining",
  "updating",
  "deploying",
  "forcing",
  "verifying",
  "completed",
  "failed",
  "recovered",
]);

export const ACTIVE_CODEX_UPDATE_PHASES = new Set([
  "queued",
  "checking",
  "waiting",
  "draining",
  "updating",
  "deploying",
  "forcing",
  "verifying",
]);

export class CodexUpdateStatusStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(stateDirectory, "codex-update-status.json");
    this.now = now;
  }

  async read() {
    try {
      return normalize(JSON.parse(await fs.readFile(this.filePath, "utf8")), this.now());
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return idle(this.now());
      throw error;
    }
  }

  async write(update) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const current = await this.read();
    const status = normalize({ ...current, ...update, updatedAt: this.now() }, this.now());
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
    return status;
  }
}

export function codexUpdateIsActive(status, now = Date.now()) {
  return ACTIVE_CODEX_UPDATE_PHASES.has(status?.phase)
    && now - (status.updatedAt || 0) < ACTIVE_STATUS_TTL_MS;
}

function normalize(value, now) {
  const phase = PHASES.has(value?.phase) ? value.phase : "idle";
  const status = STATUSES.has(value?.status)
    ? value.status
    : ACTIVE_CODEX_UPDATE_PHASES.has(phase)
      ? "running"
      : "idle";
  return {
    status,
    phase,
    beforeVersion: clean(value?.beforeVersion, 80),
    afterVersion: clean(value?.afterVersion, 80),
    detail: clean(value?.detail, 240),
    unit: clean(value?.unit, 160),
    startedAt: timestamp(value?.startedAt),
    updatedAt: timestamp(value?.updatedAt),
    completedAt: timestamp(value?.completedAt),
    error: clean(value?.error, 500),
    recoveredVersion: clean(value?.recoveredVersion, 80),
    recoveryOutcome: recoveryOutcome(value?.recoveryOutcome),
    recoveryReconciledAt: timestamp(value?.recoveryReconciledAt),
  };
}

function idle(now) {
  return {
    status: "idle",
    phase: "idle",
    beforeVersion: null,
    afterVersion: null,
    detail: null,
    unit: null,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    error: null,
    recoveredVersion: null,
    recoveryOutcome: null,
    recoveryReconciledAt: null,
  };
}

function clean(value, limit) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function recoveryOutcome(value) {
  return value === "old" || value === "candidate" ? value : null;
}
