import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,158}[A-Za-z0-9])?$/;
const DECISIONS = new Set(["cancel", "commit"]);

export class DeploymentCancelStore {
  constructor(runtimeDirectory, { now = () => Date.now() } = {}) {
    this.directory = path.join(path.resolve(runtimeDirectory), "deployment-cancel");
    this.now = now;
  }

  async requestCancel(operationId) {
    return this.decide(operationId, "cancel");
  }

  async commit(operationId) {
    return this.decide(operationId, "commit");
  }

  async getDecision(operationId) {
    const id = validateOperationId(operationId);
    return (await readDecision(this.markerPath(id), id)).decision;
  }

  async isCancellationRequested(operationId) {
    return await this.getDecision(operationId) === "cancel";
  }

  async clear(operationId) {
    const id = validateOperationId(operationId);
    try {
      await fs.unlink(this.markerPath(id));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
  }

  markerPath(operationId) {
    return path.join(this.directory, `${operationId}.json`);
  }

  async decide(operationId, requestedDecision) {
    const id = validateOperationId(operationId);
    await this.ensureDirectory();
    const filePath = this.markerPath(id);
    const temporary = path.join(this.directory, `.${id}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const decidedAt = this.now();
    let handle;

    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ operationId: id, decision: requestedDecision, decidedAt })}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await fs.link(temporary, filePath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await readDecision(filePath, id);
        const decision = existing.decision || "cancel";
        return {
          operationId: id,
          decision,
          decidedAt: existing.decidedAt,
          accepted: decision === requestedDecision,
          created: false,
        };
      }
      await syncDirectory(this.directory);
      return {
        operationId: id,
        decision: requestedDecision,
        decidedAt,
        accepted: true,
        created: true,
      };
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid deployment operation ID");
  }
  return value;
}

async function readDecision(filePath, operationId) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return { decision: "cancel", decidedAt: null };
    const raw = await fs.readFile(filePath, "utf8");
    const value = JSON.parse(raw);
    if (value?.operationId === operationId && DECISIONS.has(value?.decision)) {
      return {
        decision: value.decision,
        decidedAt: finiteTimestamp(value.decidedAt),
      };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { decision: null, decidedAt: null };
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { decision: "cancel", decidedAt: null };
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}
