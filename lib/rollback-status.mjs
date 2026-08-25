import fs from "node:fs/promises";
import path from "node:path";

export const ACTIVE_ROLLBACK_PHASES = new Set(["queued", "preflight", "backup", "waiting", "draining", "deploying", "verifying"]);
const PHASES = new Set(["idle", ...ACTIVE_ROLLBACK_PHASES, "completed", "failed"]);

export class RollbackStatusStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(path.resolve(directory), "rollback-status.json");
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
    const value = normalize({ ...await this.read(), ...update, updatedAt: this.now() }, this.now());
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
    return value;
  }
}

function normalize(value, now) {
  const phase = PHASES.has(value?.phase) ? value.phase : "idle";
  return {
    status: ACTIVE_ROLLBACK_PHASES.has(phase) ? "running" : phase === "completed" ? "completed" : phase === "failed" ? "failed" : "idle",
    phase,
    fromVersion: cleanVersion(value?.fromVersion),
    targetVersion: cleanVersion(value?.targetVersion),
    candidateId: clean(value?.candidateId, 180),
    detail: clean(value?.detail, 240),
    unit: clean(value?.unit, 160),
    startedAt: timestamp(value?.startedAt),
    updatedAt: timestamp(value?.updatedAt),
    completedAt: timestamp(value?.completedAt),
    error: clean(value?.error, 300),
    recoveryOutcome: recoveryOutcome(value?.recoveryOutcome),
    recoveryReconciledAt: timestamp(value?.recoveryReconciledAt),
  };
}

function idle(now) {
  return normalize({ phase: "idle", updatedAt: now }, now);
}

function cleanVersion(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(value || "")) ? value : null;
}

function clean(value, limit) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function recoveryOutcome(value) {
  return value === "old" || value === "candidate" ? value : null;
}
