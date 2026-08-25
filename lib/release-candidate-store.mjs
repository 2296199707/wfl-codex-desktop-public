import fs from "node:fs/promises";
import path from "node:path";
import { acquireOperationLock } from "./operation-lock.mjs";

const SCHEMA_VERSION = 1;
const MAX_CANDIDATES = 24;
const PHASES = new Set([
  "preparing",
  "testing",
  "browser-verification",
  "deploying",
  "verifying",
  "awaiting-approval",
  "discarding",
  "promoting",
  "stable",
  "failed",
  "discarded",
]);
export const ACTIVE_RELEASE_CANDIDATE_PHASES = new Set([
  "preparing",
  "testing",
  "browser-verification",
  "deploying",
  "verifying",
  "awaiting-approval",
  "discarding",
  "promoting",
]);

export class ReleaseCandidateStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    const directory = path.resolve(stateDirectory);
    this.filePath = path.join(directory, "release-candidates.json");
    this.lockPath = path.join(directory, "release-candidates.lock");
    this.now = now;
    this.mutationQueue = Promise.resolve();
  }

  async read() {
    try {
      return normalizeDocument(JSON.parse(await fs.readFile(this.filePath, "utf8")), this.now());
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return emptyDocument(this.now());
      throw error;
    }
  }

  async current() {
    const document = await this.read();
    return document.candidates.find((candidate) => candidate.id === document.currentId) || null;
  }

  async create(input) {
    return this.#mutate(async () => {
      const document = await this.read();
      const current = document.candidates.find((candidate) => candidate.id === document.currentId);
      if (current && ACTIVE_RELEASE_CANDIDATE_PHASES.has(current.phase)) {
        throw candidateError("ERR_RELEASE_CANDIDATE_ACTIVE", `Candidate ${current.id} is still ${current.phase}`);
      }
      const createdAt = this.now();
      const candidate = normalizeCandidate({
        ...input,
        phase: "preparing",
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        error: null,
      }, createdAt);
      assertCandidateIdentity(candidate);
      const candidates = [
        candidate,
        ...document.candidates.filter((entry) => entry.id !== candidate.id),
      ].slice(0, MAX_CANDIDATES);
      await this.#write({ schemaVersion: SCHEMA_VERSION, currentId: candidate.id, candidates });
      return candidate;
    });
  }

  async update(id, update, { expectedPhases = null } = {}) {
    return this.#mutate(async () => {
      const document = await this.read();
      const index = document.candidates.findIndex((candidate) => candidate.id === id);
      if (index === -1) throw candidateError("ERR_RELEASE_CANDIDATE_NOT_FOUND", "Release candidate was not found");
      const current = document.candidates[index];
      if (expectedPhases && !new Set(expectedPhases).has(current.phase)) {
        throw candidateError(
          "ERR_RELEASE_CANDIDATE_STALE",
          `Candidate ${id} is ${current.phase}, not ${expectedPhases.join(" or ")}`,
        );
      }
      const updated = normalizeCandidate({ ...current, ...update, id: current.id, updatedAt: this.now() }, this.now());
      assertCandidateIdentity(updated);
      document.candidates[index] = updated;
      document.currentId = id;
      await this.#write(document);
      return updated;
    });
  }

  async discard(id, { reason = null, discardedBy = null } = {}) {
    const now = this.now();
    return this.update(id, {
      phase: "discarded",
      detail: reason || "候选版本已废弃",
      discardedBy,
      completedAt: now,
      error: null,
    }, { expectedPhases: ["awaiting-approval", "failed"] });
  }

  async #write(value) {
    const updatedAt = this.now();
    const document = normalizeDocument({ ...value, updatedAt }, updatedAt);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async #mutate(operation) {
    const next = this.mutationQueue.then(async () => {
      const lock = await this.#acquireMutationLock();
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    });
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  async #acquireMutationLock() {
    const options = {
      ownerCommand: "lib/release-candidate-store.mjs",
      acceptedCommands: [
        "node",
        "server.mjs",
        "scripts/release.mjs",
        "scripts/rollback.mjs",
        "scripts/promote-release-candidate.mjs",
      ],
      conflictMessage: "Another release candidate state update is already running",
      acquireWaitMs: 100,
    };
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        return await acquireOperationLock(this.lockPath, options);
      } catch (error) {
        if (error.code !== "ERR_OPERATION_LOCKED" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}

function normalizeDocument(value, now) {
  const candidates = Array.isArray(value?.candidates)
    ? value.candidates.map((candidate) => normalizeCandidate(candidate, now)).filter(validCandidateIdentity)
    : [];
  const currentId = clean(value?.currentId, 180);
  return {
    schemaVersion: SCHEMA_VERSION,
    currentId: candidates.some((candidate) => candidate.id === currentId)
      ? currentId
      : candidates[0]?.id || null,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    updatedAt: timestamp(value?.updatedAt) || now,
  };
}

function emptyDocument(now) {
  return { schemaVersion: SCHEMA_VERSION, currentId: null, candidates: [], updatedAt: now };
}

function normalizeCandidate(value, now) {
  const phase = PHASES.has(value?.phase) ? value.phase : "failed";
  const checks = value?.checks && typeof value.checks === "object" ? value.checks : {};
  return {
    id: clean(value?.id, 180),
    version: stableVersion(value?.version),
    previousVersion: stableVersion(value?.previousVersion),
    commitSha: gitHash(value?.commitSha),
    treeHash: gitHash(value?.treeHash),
    phase,
    status: candidateStatus(phase),
    rollbackUnit: clean(value?.rollbackUnit, 180),
    rollbackTargetVersion: stableVersion(value?.rollbackTargetVersion),
    detail: clean(value?.detail, 300),
    unit: clean(value?.unit, 180),
    checks: {
      fullSuite: normalizeCheck(checks.fullSuite),
      browser: normalizeCheck(checks.browser),
      deployment: normalizeCheck(checks.deployment),
    },
    actualValidationConfirmed: value?.actualValidationConfirmed === true,
    actualValidationConfirmedAt: timestamp(value?.actualValidationConfirmedAt),
    actualValidationConfirmedBy: clean(value?.actualValidationConfirmedBy, 120),
    promotedBy: clean(value?.promotedBy, 120),
    discardedBy: clean(value?.discardedBy, 120),
    createdAt: timestamp(value?.createdAt) || now,
    updatedAt: timestamp(value?.updatedAt) || now,
    completedAt: timestamp(value?.completedAt),
    error: clean(value?.error, 600),
  };
}

function normalizeCheck(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["pending", "running", "passed", "failed"].includes(value.status) ? value.status : "pending";
  return {
    status,
    command: clean(value.command, 160),
    startedAt: timestamp(value.startedAt),
    completedAt: timestamp(value.completedAt),
    summary: clean(value.summary, 300),
  };
}

function candidateStatus(phase) {
  if (["preparing", "testing", "browser-verification", "deploying", "verifying", "discarding", "promoting"].includes(phase)) {
    return "running";
  }
  if (phase === "awaiting-approval") return "awaiting-approval";
  return phase;
}

function assertCandidateIdentity(candidate) {
  if (!validCandidateIdentity(candidate)) throw new Error("Release candidate identity is invalid");
}

function validCandidateIdentity(candidate) {
  return Boolean(
    candidate?.id
    && /^candidate-v\d+\.\d+\.\d+-[a-f0-9]{12}-\d+$/.test(candidate.id)
    && candidate.version
    && candidate.commitSha
    && candidate.treeHash,
  );
}

function stableVersion(value) {
  const normalized = String(value || "").trim();
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(normalized) ? normalized : null;
}

function gitHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(normalized) ? normalized : null;
}

function clean(value, limit) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function candidateError(code, message) {
  return Object.assign(new Error(message), { code });
}
