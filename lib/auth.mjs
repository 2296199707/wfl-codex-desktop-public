import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function createAuthRecord(username, password) {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(username)) throw new Error("Invalid username");
  if (typeof password !== "string" || password.length < 16) {
    throw new Error("Password must contain at least 16 characters");
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  return {
    version: 1,
    username,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}

export async function loadAuth(filePath) {
  try {
    const record = JSON.parse(await fs.readFile(filePath, "utf8"));
    validateAuthRecord(record);
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Unable to load authentication file: ${error.message}`);
  }
}

export async function writeAuth(filePath, record) {
  validateAuthRecord(record);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function verifyBasicAuth(header, record) {
  if (!header?.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return verifyAuthCredentials(username, password, record);
}

export function verifyAuthCredentials(username, password, record) {
  validateAuthRecord(record);
  if (!safeEqual(username, record.username)) return false;
  const salt = Buffer.from(record.salt, "base64");
  const expected = Buffer.from(record.hash, "base64");
  const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(actual, expected);
}

export function authCredentialRevision(record) {
  return Number.isSafeInteger(record?.credentialRevision) && record.credentialRevision >= 1
    ? record.credentialRevision
    : 0;
}

export function nextAuthCredentialRevision(previous, now = Date.now()) {
  const previousRevision = Number.isSafeInteger(previous) && previous >= 1 ? previous : 0;
  const currentTime = Number.isSafeInteger(now) && now >= 1 ? now : Date.now();
  if (previousRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Authentication credential revision exhausted");
  return Math.max(currentTime, previousRevision + 1);
}

export function generatePassword() {
  return crypto.randomBytes(18).toString("base64url");
}

export function validateAuthRecord(record) {
  if (
    record?.version !== 1 ||
    typeof record.username !== "string" ||
    typeof record.salt !== "string" ||
    typeof record.hash !== "string"
  ) {
    throw new Error("Invalid authentication record");
  }
  if (
    record.credentialRevision !== undefined
    && (!Number.isSafeInteger(record.credentialRevision) || record.credentialRevision < 1)
  ) {
    throw new Error("Invalid authentication credential revision");
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
