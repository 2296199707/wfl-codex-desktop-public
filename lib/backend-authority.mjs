import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export class BackendAuthorityStore {
  constructor(runtimeDirectory, {
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID(),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  } = {}) {
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.filename = path.join(this.runtimeDirectory, "writer-authority.json");
    this.lockDirectory = path.join(this.runtimeDirectory, "writer-authority.lock");
    this.now = now;
    this.randomUUID = randomUUID;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  createInstanceId() {
    return this.randomUUID();
  }

  async read({ allowMissing = true } = {}) {
    try {
      return validateAuthority(JSON.parse(await fs.readFile(this.filename, "utf8")));
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw authorityError("Writer authority is not valid JSON");
      throw error;
    }
  }

  async claim({ backendInstanceId, port, expectedWriterEpoch } = {}) {
    validateInstanceId(backendInstanceId);
    validatePort(port);
    return this.withLock(async () => {
      const current = await this.read();
      if (expectedWriterEpoch !== undefined && current?.writerEpoch !== expectedWriterEpoch) {
        throw authorityConflict(
          `Writer epoch changed from ${expectedWriterEpoch ?? "none"} to ${current?.writerEpoch ?? "none"}`,
        );
      }
      if (current?.backendInstanceId === backendInstanceId && current.port === port) return current;
      const nextEpoch = (current?.writerEpoch || 0) + 1;
      if (!Number.isSafeInteger(nextEpoch)) throw authorityError("Writer epoch is exhausted");
      const authority = {
        schemaVersion: SCHEMA_VERSION,
        backendInstanceId,
        writerEpoch: nextEpoch,
        port,
        grantedAt: this.now(),
      };
      await atomicWriteJson(this.filename, authority, 0o600);
      return authority;
    });
  }

  async assertCurrent({ backendInstanceId, writerEpoch, port } = {}) {
    validateInstanceId(backendInstanceId);
    validateEpoch(writerEpoch);
    if (port !== undefined) validatePort(port);
    const current = await this.read({ allowMissing: false });
    if (
      current.backendInstanceId !== backendInstanceId
      || current.writerEpoch !== writerEpoch
      || (port !== undefined && current.port !== port)
    ) {
      throw fencedError(current, { backendInstanceId, writerEpoch, port });
    }
    return current;
  }

  async withLock(operation) {
    await fs.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o755 });
    const deadline = this.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await fs.mkdir(this.lockDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = await fs.stat(this.lockDirectory).catch((statError) => {
          if (statError.code === "ENOENT") return null;
          throw statError;
        });
        if (stat && this.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(this.lockDirectory, { recursive: true, force: true });
          continue;
        }
        if (this.now() >= deadline) throw authorityConflict("Timed out acquiring writer-authority lock");
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rm(this.lockDirectory, { recursive: true, force: true });
    }
  }
}

export async function readSelectedBackendPort(runtimeDirectory, { allowMissing = false } = {}) {
  try {
    const value = Number((await fs.readFile(path.join(runtimeDirectory, "active-port"), "utf8")).trim());
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw authorityError("Selected backend port is invalid");
    }
    return value;
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw error;
  }
}

function validateAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError("Writer authority must be an object");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) throw authorityError("Writer authority schema is unsupported");
  validateInstanceId(value.backendInstanceId);
  validateEpoch(value.writerEpoch);
  validatePort(value.port);
  if (!Number.isSafeInteger(value.grantedAt) || value.grantedAt <= 0) {
    throw authorityError("Writer authority timestamp is invalid");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    backendInstanceId: value.backendInstanceId,
    writerEpoch: value.writerEpoch,
    port: value.port,
    grantedAt: value.grantedAt,
  });
}

function validateInstanceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw authorityError("Backend instance ID is invalid");
  }
}

function validateEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw authorityError("Writer epoch is invalid");
}

function validatePort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw authorityError("Backend port is invalid");
}

function fencedError(current, attempted) {
  const error = authorityError(
    `Backend writer authority moved to epoch ${current.writerEpoch} on port ${current.port}`,
  );
  error.code = "ERR_BACKEND_WRITER_FENCED";
  error.statusCode = 503;
  error.current = current;
  error.attempted = attempted;
  return error;
}

function authorityConflict(message) {
  const error = authorityError(message);
  error.code = "ERR_BACKEND_AUTHORITY_CONFLICT";
  return error;
}

function authorityError(message) {
  const error = new Error(message);
  error.code = "ERR_BACKEND_AUTHORITY_INVALID";
  return error;
}

async function atomicWriteJson(filename, value, mode) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filename);
    await fs.chmod(filename, mode);
    const directory = await fs.open(path.dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
