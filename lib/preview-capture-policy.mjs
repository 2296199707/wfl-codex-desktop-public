import net from "node:net";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function normalizeCaptureUrl(value, {
  baseOrigin = null,
  allowedOrigins = [],
  allowedOriginPredicate = null,
  allowLoopback = false,
  requirePreviewPath = true,
} = {}) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 8_192) throw captureError(400, "截图地址不正确");
  let parsed;
  try {
    parsed = new URL(raw, baseOrigin || undefined);
  } catch {
    throw captureError(400, "截图地址必须是有效的 http(s) 地址");
  }
  if (![
    "http:",
    "https:",
  ].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw captureError(400, "截图只允许无凭据的 http(s) 地址");
  }
  if (requirePreviewPath && !parsed.pathname.startsWith("/preview/")) {
    throw captureError(403, "截图只能打开项目预览路径");
  }
  const origin = parsed.origin;
  const allowed = new Set((allowedOrigins || []).map((candidate) => String(candidate).replace(/\/$/, "").toLowerCase()));
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || net.isIP(parsed.hostname) === 4 && parsed.hostname.startsWith("127.");
  if (!allowed.has(origin.toLowerCase())
    && !(typeof allowedOriginPredicate === "function" && allowedOriginPredicate(origin))
    && !(allowLoopback && loopback)) {
    throw captureError(403, "截图地址不在本实例的预览 Origin 白名单中");
  }
  return parsed;
}

export function assertCaptureAddresses(addresses, { allowLoopback = false } = {}) {
  const values = Array.isArray(addresses) ? addresses : [addresses];
  if (!values.length) throw captureError(502, "截图目标没有解析到地址");
  for (const value of values) {
    const address = typeof value === "string" ? value : value?.address;
    if (!address || isBlockedAddress(address, { allowLoopback })) {
      throw captureError(403, "截图目标解析到受限制的网络地址");
    }
  }
  return true;
}

export function isBlockedAddress(address, { allowLoopback = false } = {}) {
  const normalized = String(address || "").toLowerCase().replace(/^::ffff:/, "");
  const family = net.isIP(normalized);
  if (!family) return false;
  if (allowLoopback && ((family === 4 && normalized.startsWith("127.")) || (family === 6 && normalized === "::1"))) {
    return false;
  }
  if (family === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("ff");
}

function captureError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
