const RESERVED_PARAMETER_NAMES = new Set([
  "apiKey",
  "api_key",
  "baseUrl",
  "base_url",
  "url",
  "headers",
  "authorization",
  "Authorization",
  "__proto__",
  "prototype",
  "constructor",
]);
const MAX_PARAMETER_DEPTH = 8;
const MAX_PARAMETER_ENTRIES = 512;
const MAX_PARAMETER_STRING_LENGTH = 256 * 1024;
const MAX_PARAMETER_BYTES = 200 * 1024;

export function normalizeImageProviderParameters(value, { allowEmpty = true } = {}) {
  if (value == null) return allowEmpty ? {} : null;
  if (!isRecord(value)) throw parameterError("供应商原生参数必须是对象");
  let entries = 0;
  const normalized = normalizeValue(value, 0, () => {
    entries += 1;
    if (entries > MAX_PARAMETER_ENTRIES) throw parameterError("供应商原生参数过多");
  });
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PARAMETER_BYTES) {
    throw parameterError("供应商原生参数过大");
  }
  return normalized;
}

export function hasImageProviderParameter(value, names) {
  if (!isRecord(value)) return false;
  return names.some((name) => Object.hasOwn(value, name));
}

export function imageProviderParameter(value, names) {
  if (!isRecord(value)) return undefined;
  for (const name of names) {
    if (Object.hasOwn(value, name)) return value[name];
  }
  return undefined;
}

function normalizeValue(value, depth, count) {
  if (depth > MAX_PARAMETER_DEPTH) throw parameterError("供应商原生参数嵌套过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_PARAMETER_STRING_LENGTH) throw parameterError("供应商原生参数字符串过长");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw parameterError("供应商原生参数包含无效数字");
    return value;
  }
  if (Array.isArray(value)) {
    count();
    return value.map((entry) => normalizeValue(entry, depth + 1, count));
  }
  if (!isRecord(value)) throw parameterError("供应商原生参数包含不支持的值");
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 128 || RESERVED_PARAMETER_NAMES.has(key)) {
      throw parameterError(`供应商原生参数名 ${key || "<empty>"} 不允许`);
    }
    count();
    output[key] = normalizeValue(entry, depth + 1, count);
  }
  return output;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parameterError(message) {
  return Object.assign(new Error(message), {
    code: "INVALID_IMAGE_PROVIDER_PARAMETERS",
    statusCode: 400,
  });
}
