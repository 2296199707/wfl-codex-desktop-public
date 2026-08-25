import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { assertCaptureAddresses, isBlockedAddress } from "./preview-capture-policy.mjs";
import { normalizePublicOrigin, previewSessionOrigin } from "./public-origin-config.mjs";

const HEALTH_SESSION_BYTES = Buffer.alloc(12, 0);

export async function inspectPublicOriginHealth(config, {
  lookup = dns.lookup,
  fetchImpl = globalThis.fetch,
  tlsProbe = probeTls,
  now = () => Date.now(),
} = {}) {
  if (config?.mode !== "confirmed") {
    return { configured: false, checkedAt: now(), origins: [], summary: "sandbox" };
  }
  const publicOrigin = normalizePublicOrigin(config.publicOrigin, { allowLoopback: false });
  const origins = [{ origin: publicOrigin, kind: "public" }];
  if (config.isolation === "session") {
    const session = previewSessionOrigin({
      previewBaseDomain: config.previewBaseDomain,
      randomBytes: () => HEALTH_SESSION_BYTES,
    });
    origins.push({ origin: session, kind: "session-wildcard" });
  } else {
    for (const origin of (config.previewOrigins || [])) origins.push({ origin, kind: "preview" });
  }
  const checks = await Promise.all(origins.map(({ origin, kind }) => inspectOneOrigin(origin, {
    kind,
    lookup,
    fetchImpl,
    tlsProbe,
  })));
  const healthy = checks.every((check) => check.ok);
  return {
    configured: true,
    ok: healthy,
    checkedAt: now(),
    origins: checks,
    summary: healthy ? "all-healthy" : "attention-required",
  };
}

export function certificateCoversHost(certificate, hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const names = String(certificate?.subjectaltname || "")
    .split(/,\s*/)
    .map((value) => value.replace(/^DNS:/i, "").toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  return names.some((name) => name === host || (name.startsWith("*.") && host.endsWith(name.slice(1)) && host.split(".").length === name.split(".").length));
}

export function isAcceptableOriginHttpStatus(status) {
  return (status >= 200 && status < 400) || status === 401;
}

async function inspectOneOrigin(origin, { kind, lookup, fetchImpl, tlsProbe }) {
  const parsed = new URL(origin);
  const result = {
    origin: parsed.origin,
    hostname: parsed.hostname,
    kind,
    ok: false,
    dns: { ok: false, addresses: [], detail: null },
    tls: { ok: false, detail: null, expiresAt: null, coversHost: false },
    http: { ok: false, status: null, detail: null },
  };
  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    assertCaptureAddresses(addresses, { allowLoopback: false });
    result.dns = {
      ok: true,
      addresses: addresses.map((value) => value.address || value).filter((value) => typeof value === "string"),
      detail: "解析正常",
    };
  } catch (error) {
    result.dns.detail = error.message;
    return result;
  }
  try {
    const certificate = await tlsProbe(parsed.hostname, 443);
    const expiresAt = Date.parse(certificate.valid_to || "");
    result.tls = {
      ok: certificate.authorized !== false && Number.isFinite(expiresAt) && expiresAt > Date.now(),
      detail: certificate.authorized === false ? certificate.authorizationError || "证书校验失败" : "TLS 正常",
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      coversHost: certificateCoversHost(certificate, parsed.hostname),
    };
    result.tls.ok = result.tls.ok && result.tls.coversHost;
    if (!result.tls.coversHost) result.tls.detail = "证书 SAN 不包含此主机名";
  } catch (error) {
    result.tls.detail = error.message;
  }
  if (typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl(`${parsed.origin}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
      });
      const httpOk = isAcceptableOriginHttpStatus(response.status);
      result.http = {
        ok: httpOk,
        status: response.status,
        detail: httpOk
          ? response.status === 401 ? "HTTPS 响应正常（需要认证）" : "HTTPS 响应正常"
          : `HTTP ${response.status}`,
      };
    } catch (error) {
      result.http.detail = error.message;
    }
  }
  result.ok = result.dns.ok && result.tls.ok && result.http.ok;
  return result;
}

function probeTls(hostname, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: true,
      timeout: 8_000,
    });
    const finish = (error, value) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate(true);
      finish(null, {
        authorized: socket.authorized,
        authorizationError: socket.authorizationError,
        subjectaltname: certificate.subjectaltname,
        valid_to: certificate.valid_to,
      });
    });
    socket.once("timeout", () => finish(new Error("TLS 检查超时")));
    socket.once("error", (error) => finish(error));
  });
}

export function isPublicHealthAddress(value) {
  const address = String(value || "");
  return Boolean(net.isIP(address)) && !isBlockedAddress(address, { allowLoopback: false });
}
