import fs from "node:fs/promises";
import path from "node:path";

const RELEASE_STATUSES = new Set(["idle", "running", "completed", "failed"]);
const RELEASE_PHASES = new Set([
  "idle",
  "queued",
  "preflight",
  "testing",
  "backup",
  "waiting",
  "draining",
  "deploying",
  "verifying",
  "completed",
  "failed",
]);

export const ACTIVE_RELEASE_PHASES = new Set([
  "queued",
  "preflight",
  "testing",
  "backup",
  "waiting",
  "draining",
  "deploying",
  "verifying",
]);

export class ReleaseStatusStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(stateDirectory, "release-status.json");
    this.now = now;
  }

  async read() {
    try {
      return normalizeStatus(JSON.parse(await fs.readFile(this.filePath, "utf8")), this.now());
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return idleStatus(this.now());
      throw error;
    }
  }

  async write(update) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const current = await this.read();
    const status = normalizeStatus({ ...current, ...update, updatedAt: this.now() }, this.now());
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
    return status;
  }
}

function normalizeStatus(value, now) {
  const phase = RELEASE_PHASES.has(value?.phase) ? value.phase : "idle";
  const status = RELEASE_STATUSES.has(value?.status) ? value.status : ACTIVE_RELEASE_PHASES.has(phase) ? "running" : "idle";
  return {
    status,
    phase,
    version: cleanText(value?.version, 64),
    candidateId: cleanText(value?.candidateId, 180),
    commitSha: gitHash(value?.commitSha),
    treeHash: gitHash(value?.treeHash),
    detail: cleanText(value?.detail, 240),
    unit: cleanText(value?.unit, 160),
    startedAt: finiteTimestamp(value?.startedAt),
    updatedAt: finiteTimestamp(value?.updatedAt),
    completedAt: finiteTimestamp(value?.completedAt),
    error: cleanText(value?.error, 500),
    recoveryOutcome: recoveryOutcome(value?.recoveryOutcome),
    recoveryReconciledAt: finiteTimestamp(value?.recoveryReconciledAt),
  };
}

function idleStatus(now) {
  return {
    status: "idle",
    phase: "idle",
    version: null,
    candidateId: null,
    commitSha: null,
    treeHash: null,
    detail: null,
    unit: null,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    error: null,
    recoveryOutcome: null,
    recoveryReconciledAt: null,
  };
}

function cleanText(value, limit) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function gitHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(normalized) ? normalized : null;
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function recoveryOutcome(value) {
  return value === "old" || value === "candidate" ? value : null;
}
