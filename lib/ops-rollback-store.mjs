import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const USER_ID_PATTERN = /^u-[a-f0-9]{16}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class OpsRollbackStore {
  constructor(directory, { now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.filePath = path.join(path.resolve(directory), "ops-rollback-guard.json");
    this.now = now;
    this.ttlMs = Math.max(60_000, Math.min(DEFAULT_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    if (writeOnInitialize) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    }
    this.data = await readState(this.filePath);
    if (writeOnInitialize) await this.expire();
    return this;
  }

  status(actorId = null) {
    this.assertInitialized();
    const enabled = this.data.enabledUntil > this.now();
    return {
      enabled,
      expiresAt: enabled ? this.data.enabledUntil : null,
      prepared: enabled && Boolean(this.data.nonceHash) && this.data.actorId === actorId,
      targetVersion: enabled && this.data.actorId === actorId ? this.data.targetVersion : null,
    };
  }

  enable(actorId) {
    return this.mutate(async () => {
      assertUserId(actorId);
      this.data = defaultState();
      this.data.enabledUntil = this.now() + this.ttlMs;
      this.data.actorId = actorId;
      await this.write();
      return this.status(actorId);
    });
  }

  disable(actorId) {
    return this.mutate(async () => {
      assertUserId(actorId);
      this.data = defaultState();
      await this.write();
      return this.status(actorId);
    });
  }

  prepare(actorId, targetVersion, typedVersion) {
    return this.mutate(async () => {
      this.assertEnabled(actorId);
      const version = String(targetVersion || "");
      if (!VERSION_PATTERN.test(version) || typedVersion !== version) {
        throw guardError(400, "必须完整输入目标版本号进行第一次确认");
      }
      const nonce = crypto.randomBytes(32).toString("base64url");
      this.data.nonceHash = hashNonce(nonce);
      this.data.targetVersion = version;
      await this.write();
      return { nonce, targetVersion: version, expiresAt: this.data.enabledUntil };
    });
  }

  consume(actorId, targetVersion, nonce) {
    return this.mutate(async () => {
      this.assertEnabled(actorId);
      const valid = this.data.targetVersion === targetVersion
        && /^[A-Za-z0-9_-]{43}$/.test(String(nonce || ""))
        && safeEqual(this.data.nonceHash, hashNonce(nonce));
      const result = valid ? { targetVersion: this.data.targetVersion } : null;
      this.data = defaultState();
      await this.write();
      if (!result) throw guardError(403, "回滚确认已失效，请重新开启后确认");
      return result;
    });
  }

  async expire() {
    if (this.data.enabledUntil > this.now()) return;
    this.data = defaultState();
    await this.write();
  }

  assertEnabled(actorId) {
    assertUserId(actorId);
    if (this.data.enabledUntil <= this.now() || this.data.actorId !== actorId) {
      throw guardError(403, "手动回滚开关未开启或已经失效");
    }
  }

  async write() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.data) throw new Error("Rollback guard is not initialized");
  }
}

function defaultState() {
  return { version: 1, enabledUntil: 0, actorId: null, targetVersion: null, nonceHash: null };
}

async function readState(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (value?.version !== 1) return defaultState();
    return {
      version: 1,
      enabledUntil: Number.isFinite(value.enabledUntil) ? value.enabledUntil : 0,
      actorId: USER_ID_PATTERN.test(value.actorId || "") ? value.actorId : null,
      targetVersion: VERSION_PATTERN.test(value.targetVersion || "") ? value.targetVersion : null,
      nonceHash: /^[A-Za-z0-9_-]{43}$/.test(value.nonceHash || "") ? value.nonceHash : null,
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return defaultState();
    throw error;
  }
}

function assertUserId(value) {
  if (!USER_ID_PATTERN.test(String(value || ""))) throw guardError(403, "回滚操作账号无效");
}

function hashNonce(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function guardError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
