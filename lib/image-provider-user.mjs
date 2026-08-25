import crypto from "node:crypto";

const OUTPUT_PREFIX = "wfl-image-user-v1_";
const HMAC_NAMESPACE = "wfl-codex-desktop/image-provider-user/v1";
const MAX_USER_ID_BYTES = 1024;
const MAX_SECRET_BYTES = 4096;

export class ImageProviderUserIdentifierError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ImageProviderUserIdentifierError";
    this.code = code;
  }
}

export function createImageProviderUserIdentifier({ userId, secret } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const secretBytes = normalizeSecret(secret);
  const userIdBytes = Buffer.from(normalizedUserId, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(userIdBytes.length);
  const digest = crypto.createHmac("sha256", secretBytes)
    .update(HMAC_NAMESPACE, "ascii")
    .update("\0", "ascii")
    .update(length)
    .update(userIdBytes)
    .digest("base64url");
  return `${OUTPUT_PREFIX}${digest}`;
}

function normalizeUserId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw identifierError("INVALID_IMAGE_PROVIDER_USER_ID", "Image provider user ID must be a non-empty string");
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_USER_ID_BYTES) {
    throw identifierError("INVALID_IMAGE_PROVIDER_USER_ID", "Image provider user ID exceeds the byte limit");
  }
  return value;
}

function normalizeSecret(value) {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw identifierError("INVALID_IMAGE_PROVIDER_USER_SECRET", "Image provider user secret is required");
  }
  const bytes = typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (!bytes.length || (typeof value === "string" && !value.trim())) {
    throw identifierError("INVALID_IMAGE_PROVIDER_USER_SECRET", "Image provider user secret must not be empty");
  }
  if (bytes.length > MAX_SECRET_BYTES) {
    throw identifierError("INVALID_IMAGE_PROVIDER_USER_SECRET", "Image provider user secret exceeds the byte limit");
  }
  return bytes;
}

function identifierError(code, message) {
  return new ImageProviderUserIdentifierError(code, message);
}
