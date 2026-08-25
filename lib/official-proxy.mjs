import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

const PROXY_PROTOCOLS = new Set(["http", "socks5"]);
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 64;
const MAX_CREDENTIAL_BYTES = 255;
const DEFAULT_CONNECT_TIMEOUT_MS = 12_000;
const MAX_PROXY_HEADER_BYTES = 16 * 1024;
const MAX_IP_RESPONSE_BYTES = 32 * 1024;
const OFFICIAL_DOMAIN_ROOTS = [
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
];

export class OfficialProxyRouter {
  constructor({
    allowPrivateProxy = false,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    officialDomainRoots = OFFICIAL_DOMAIN_ROOTS,
  } = {}) {
    this.allowPrivateProxy = allowPrivateProxy === true;
    this.connectTimeoutMs = boundedTimeout(connectTimeoutMs);
    this.officialDomainRoots = normalizeDomainRoots(officialDomainRoots);
    this.proxy = null;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
  }

  async configure(value) {
    const proxy = value == null ? null : normalizeOfficialProxy(value);
    if (!proxy) {
      this.proxy = null;
      await this.closeServer();
      return null;
    }
    this.proxy = proxy;
    if (!this.server) await this.startServer();
    return this.snapshot();
  }

  matches(value) {
    const proxy = value == null ? null : normalizeOfficialProxy(value);
    return officialProxyIdentity(this.proxy) === officialProxyIdentity(proxy);
  }

  snapshot() {
    if (!this.proxy || !this.port) return null;
    return {
      active: true,
      endpoint: `http://127.0.0.1:${this.port}`,
      proxy: publicOfficialProxy({ config: this.proxy }),
    };
  }

  environment() {
    if (!this.proxy || !this.port) return {};
    const endpoint = `http://127.0.0.1:${this.port}`;
    return {
      HTTPS_PROXY: endpoint,
      https_proxy: endpoint,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    };
  }

  async close() {
    this.proxy = null;
    await this.closeServer();
  }

  async startServer() {
    const server = http.createServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("HTTPS CONNECT only");
    });
    server.on("connect", (request, clientSocket, head) => {
      void this.handleConnect(request, clientSocket, head);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeHttpServer(server, this.sockets);
      throw officialProxyError("router", "账号代理路由器启动失败");
    }
    this.server = server;
    this.port = address.port;
  }

  async handleConnect(request, clientSocket, head) {
    const target = parseConnectTarget(request.url);
    if (!target || !this.proxy) {
      endConnect(clientSocket, target ? 503 : 400);
      return;
    }
    let upstream;
    try {
      upstream = isOfficialProxyHost(target.host, this.officialDomainRoots)
        ? await openOfficialProxyTunnel(this.proxy, target.host, target.port, {
          allowPrivateProxy: this.allowPrivateProxy,
          timeoutMs: this.connectTimeoutMs,
        })
        : await connectTcpHost(target.host, target.port, this.connectTimeoutMs);
    } catch (error) {
      endConnect(clientSocket, 502, error?.proxyCode || "connect");
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", close);
    upstream.once("close", close);
    clientSocket.on("error", close);
    clientSocket.once("close", close);
  }

  async closeServer() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await closeHttpServer(server, this.sockets);
  }
}

export function normalizeOfficialProxy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw officialProxyError("invalid", "代理配置无效", 400);
  }
  const protocol = String(value.protocol || "").trim().toLowerCase().replace(/:$/, "");
  if (!PROXY_PROTOCOLS.has(protocol)) {
    throw officialProxyError("protocol", "仅支持 HTTP 和 SOCKS5 代理", 400);
  }
  const host = normalizeProxyHost(value.host);
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw officialProxyError("port", "代理端口无效", 400);
  }
  const username = boundedCredential(value.username, "代理用户名");
  const password = boundedCredential(value.password, "代理密码");
  if (password && !username) {
    throw officialProxyError("credentials", "填写代理密码时必须同时填写用户名", 400);
  }
  const label = boundedText(value.label, MAX_LABEL_LENGTH);
  return { protocol, host, port, username, password, label };
}

export function publicOfficialProxy(value) {
  const config = value?.config ? normalizeOfficialProxy(value.config) : normalizeOfficialProxy(value);
  const health = normalizeOfficialProxyHealth(value?.health);
  return {
    configured: true,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    label: config.label,
    hasAuthentication: Boolean(config.username),
    health,
  };
}

export function normalizeOfficialProxyHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = ["ready", "failed", "unknown"].includes(value.status) ? value.status : "unknown";
  const checkedAt = timestamp(value.checkedAt);
  const latencyMs = Number.isFinite(value.latencyMs)
    ? Math.max(0, Math.min(120_000, Math.round(value.latencyMs)))
    : null;
  const exitIp = net.isIP(String(value.exitIp || "")) ? String(value.exitIp) : null;
  const code = boundedText(value.code, 32);
  return { status, checkedAt, latencyMs, exitIp, code };
}

export function officialProxyIdentity(value) {
  if (!value) return "";
  const proxy = normalizeOfficialProxy(value);
  return JSON.stringify([
    proxy.protocol,
    proxy.host,
    proxy.port,
    proxy.username,
    proxy.password,
  ]);
}

export function isOfficialProxyHost(hostname, domainRoots = OFFICIAL_DOMAIN_ROOTS) {
  const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return normalizeDomainRoots(domainRoots).some((root) =>
    normalized === root || normalized.endsWith(`.${root}`));
}

export async function testOfficialProxy(value, {
  allowPrivateProxy = false,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  probeHost = "api.openai.com",
  lookupExitIp = true,
} = {}) {
  const proxy = normalizeOfficialProxy(value);
  const startedAt = Date.now();
  const socket = await openOfficialProxyTunnel(proxy, probeHost, 443, {
    allowPrivateProxy,
    timeoutMs,
  });
  const secureSocket = await secureTlsSocket(socket, probeHost, timeoutMs);
  secureSocket.destroy();
  let exitIp = null;
  if (lookupExitIp) {
    exitIp = await readProxyExitIp(proxy, { allowPrivateProxy, timeoutMs }).catch(() => null);
  }
  return {
    status: "ready",
    checkedAt: Date.now(),
    latencyMs: Date.now() - startedAt,
    exitIp,
    code: null,
  };
}

export function failedOfficialProxyHealth(error) {
  return {
    status: "failed",
    checkedAt: Date.now(),
    latencyMs: null,
    exitIp: null,
    code: boundedText(error?.proxyCode, 32) || "connect",
  };
}

export async function openOfficialProxyTunnel(value, targetHost, targetPort, {
  allowPrivateProxy = false,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  const proxy = normalizeOfficialProxy(value);
  const host = normalizeTargetHost(targetHost);
  const port = Number(targetPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw officialProxyError("target", "代理目标端口无效", 400);
  }
  const socket = await connectProxyEndpoint(proxy, {
    allowPrivateProxy,
    timeoutMs,
  });
  try {
    if (proxy.protocol === "http") {
      await establishHttpTunnel(socket, proxy, host, port, timeoutMs);
    } else {
      await establishSocks5Tunnel(socket, proxy, host, port, timeoutMs);
    }
    socket.setTimeout(0);
    socket.resume();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectProxyEndpoint(proxy, { allowPrivateProxy, timeoutMs }) {
  let addresses;
  try {
    addresses = await dns.lookup(proxy.host, { all: true, verbatim: true });
  } catch {
    throw officialProxyError("dns", "无法解析代理服务器地址");
  }
  if (!addresses.length) throw officialProxyError("dns", "代理服务器没有可用地址");
  if (!allowPrivateProxy && addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw officialProxyError("private", "代理服务器必须使用公开网络地址", 400);
  }
  let lastError = null;
  for (const address of addresses) {
    try {
      return await connectTcpAddress(address.address, proxy.port, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw officialProxyError(
    lastError?.proxyCode || "connect",
    lastError?.message || "无法连接代理服务器",
  );
}

function connectTcpHost(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const timer = setTimeout(() => finish(reject, officialProxyError("timeout", "连接目标服务器超时")), boundedTimeout(timeoutMs));
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      if (operation === reject) socket.destroy();
      operation(value);
    };
    const onConnect = () => finish(resolve, socket);
    const onError = () => finish(reject, officialProxyError("connect", "无法连接目标服务器"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function connectTcpAddress(address, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    let settled = false;
    const timer = setTimeout(() => finish(reject, officialProxyError("timeout", "连接代理服务器超时")), boundedTimeout(timeoutMs));
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      if (operation === reject) socket.destroy();
      operation(value);
    };
    const onConnect = () => finish(resolve, socket);
    const onError = () => finish(reject, officialProxyError("connect", "无法连接代理服务器"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function establishHttpTunnel(socket, proxy, host, port, timeoutMs) {
  const authority = formatAuthority(host, port);
  const authorization = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`
    : "";
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n${authorization}\r\n`,
  );
  const reader = new SocketReader(socket);
  try {
    const header = (await reader.readUntil(Buffer.from("\r\n\r\n"), MAX_PROXY_HEADER_BYTES, timeoutMs)).toString("latin1");
    const match = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(header);
    const status = Number(match?.[1]);
    if (status === 407) throw officialProxyError("authentication", "住宅代理账号或密码错误", 502);
    if (status !== 200) throw officialProxyError("response", `住宅代理拒绝连接（${status || "无状态码"}）`);
  } finally {
    reader.detach();
  }
}

async function establishSocks5Tunnel(socket, proxy, host, port, timeoutMs) {
  const reader = new SocketReader(socket);
  try {
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await reader.read(2, timeoutMs);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) {
      throw officialProxyError("authentication", "SOCKS5 代理不接受当前认证方式");
    }
    if (greeting[1] === 0x02) {
      const username = Buffer.from(proxy.username, "utf8");
      const password = Buffer.from(proxy.password, "utf8");
      socket.write(Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]));
      const authentication = await reader.read(2, timeoutMs);
      if (authentication[0] !== 0x01 || authentication[1] !== 0x00) {
        throw officialProxyError("authentication", "SOCKS5 住宅代理账号或密码错误");
      }
    } else if (greeting[1] !== 0x00) {
      throw officialProxyError("authentication", "SOCKS5 代理返回了不支持的认证方式");
    }
    const hostBytes = Buffer.from(host, "utf8");
    if (hostBytes.length > 255) throw officialProxyError("target", "代理目标地址过长", 400);
    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
      hostBytes,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const response = await reader.read(4, timeoutMs);
    if (response[0] !== 0x05 || response[1] !== 0x00) {
      throw officialProxyError("response", `SOCKS5 住宅代理拒绝连接（${response[1] ?? "未知"}）`);
    }
    if (response[3] === 0x01) await reader.read(4 + 2, timeoutMs);
    else if (response[3] === 0x04) await reader.read(16 + 2, timeoutMs);
    else if (response[3] === 0x03) {
      const length = (await reader.read(1, timeoutMs))[0];
      await reader.read(length + 2, timeoutMs);
    } else {
      throw officialProxyError("response", "SOCKS5 住宅代理返回了无效地址");
    }
  } finally {
    reader.detach();
  }
}

async function secureTlsSocket(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
    let settled = false;
    const timer = setTimeout(() => finish(reject, officialProxyError("timeout", "代理 TLS 检测超时")), boundedTimeout(timeoutMs));
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secureSocket.removeListener("secureConnect", onSecure);
      secureSocket.removeListener("error", onError);
      if (operation === reject) secureSocket.destroy();
      operation(value);
    };
    const onSecure = () => finish(resolve, secureSocket);
    const onError = () => finish(reject, officialProxyError("tls", "住宅代理无法建立安全连接"));
    secureSocket.once("secureConnect", onSecure);
    secureSocket.once("error", onError);
  });
}

async function readProxyExitIp(proxy, { allowPrivateProxy, timeoutMs }) {
  const host = "api64.ipify.org";
  const socket = await openOfficialProxyTunnel(proxy, host, 443, { allowPrivateProxy, timeoutMs });
  const secureSocket = await secureTlsSocket(socket, host, timeoutMs);
  secureSocket.write(
    `GET /?format=json HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: WFL-Codex-Desktop\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
  );
  const response = await readClosedSocket(secureSocket, timeoutMs, MAX_IP_RESPONSE_BYTES);
  const separator = response.indexOf("\r\n\r\n");
  if (separator === -1 || !/^HTTP\/1\.[01]\s+200\b/i.test(response)) {
    throw officialProxyError("ip-check", "无法查询住宅代理出口 IP");
  }
  let value = response.slice(separator + 4).trim();
  if (/transfer-encoding:\s*chunked/i.test(response.slice(0, separator))) value = decodeFirstChunk(value);
  let ip = null;
  try {
    ip = JSON.parse(value).ip;
  } catch {
    ip = value;
  }
  if (!net.isIP(String(ip || "").trim())) throw officialProxyError("ip-check", "住宅代理未返回有效出口 IP");
  return String(ip).trim();
}

function readClosedSocket(socket, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => finish(reject, officialProxyError("timeout", "代理响应超时")), boundedTimeout(timeoutMs));
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
      if (operation === reject) socket.destroy();
      operation(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(reject, officialProxyError("response", "代理响应过大"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(reject, officialProxyError("response", "读取代理响应失败"));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.failure = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    this.onError = () => this.fail(officialProxyError("connect", "代理连接已断开"));
    this.onClose = () => this.fail(officialProxyError("connect", "代理连接提前关闭"));
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  read(length, timeoutMs) {
    return this.waitFor((buffer) => {
      if (buffer.length < length) return null;
      return { value: buffer.subarray(0, length), consumed: length };
    }, timeoutMs);
  }

  readUntil(marker, maxBytes, timeoutMs) {
    return this.waitFor((buffer) => {
      const index = buffer.indexOf(marker);
      if (index !== -1) {
        const consumed = index + marker.length;
        return { value: buffer.subarray(0, consumed), consumed };
      }
      if (buffer.length > maxBytes) throw officialProxyError("response", "代理响应头过大");
      return null;
    }, timeoutMs);
  }

  waitFor(parser, timeoutMs) {
    if (this.waiter) return Promise.reject(officialProxyError("state", "代理握手状态冲突"));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(officialProxyError("timeout", "住宅代理握手超时"));
      }, boundedTimeout(timeoutMs));
      this.waiter = { parser, resolve, reject, timer };
      this.flush();
    });
  }

  flush() {
    if (!this.waiter) return;
    let parsed;
    try {
      parsed = this.waiter.parser(this.buffer);
    } catch (error) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
      return;
    }
    if (!parsed) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    this.buffer = this.buffer.subarray(parsed.consumed);
    waiter.resolve(parsed.value);
  }

  fail(error) {
    this.failure = error;
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  detach() {
    this.socket.pause();
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("close", this.onClose);
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}

function normalizeProxyHost(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw || raw.length > MAX_HOST_LENGTH || /[/:@\s?#\[\]]/.test(raw)) {
    throw officialProxyError("host", "代理服务器地址无效", 400);
  }
  if (net.isIP(raw)) return raw;
  if (!raw.includes(".") || raw.split(".").some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw officialProxyError("host", "代理服务器必须填写公开域名或 IP", 400);
  }
  return raw;
}

function normalizeTargetHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host.length > MAX_HOST_LENGTH || /[/@\s?#]/.test(host)) {
    throw officialProxyError("target", "代理目标地址无效", 400);
  }
  return host;
}

function parseConnectTarget(value) {
  const authority = String(value || "");
  let url;
  try {
    url = new URL(`https://${authority}`);
  } catch {
    return null;
  }
  const port = Number(url.port || 443);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: url.hostname.toLowerCase(), port };
}

function formatAuthority(host, port) {
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function boundedCredential(value, name) {
  const text = value == null ? "" : String(value);
  if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIAL_BYTES || /[\0\r\n]/.test(text)) {
    throw officialProxyError("credentials", `${name}过长或包含无效字符`, 400);
  }
  return text;
}

function boundedText(value, limit) {
  if (value == null) return null;
  const text = String(value).trim();
  return text && text.length <= limit && !/[\0\r\n]/.test(text) ? text : null;
}

function timestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function boundedTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1_000, Math.min(30_000, Math.round(number))) : DEFAULT_CONNECT_TIMEOUT_MS;
}

function normalizeDomainRoots(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32) {
    throw new Error("Official proxy domain roots are invalid");
  }
  const roots = [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase().replace(/\.$/, "")))];
  if (roots.some((entry) => (
    !entry
    || entry.length > MAX_HOST_LENGTH
    || !entry.includes(".")
    || entry.split(".").some((label) => !label || label.length > MAX_LABEL_LENGTH
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ))) {
    throw new Error("Official proxy domain roots are invalid");
  }
  return roots;
}

function isPublicIpAddress(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a !== 0
      && a !== 10
      && a !== 127
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && b === 0 && c === 0)
      && !(a === 192 && b === 0 && c === 2)
      && !(a === 192 && b === 168)
      && !(a === 198 && [18, 19].includes(b))
      && !(a === 198 && b === 51 && c === 100)
      && !(a === 203 && b === 0 && c === 113)
      && a < 224;
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized !== "::"
      && normalized !== "::1"
      && !normalized.startsWith("fc")
      && !normalized.startsWith("fd")
      && !/^fe[89ab]/.test(normalized)
      && !normalized.startsWith("ff")
      && !normalized.startsWith("2001:db8:");
  }
  return false;
}

function decodeFirstChunk(value) {
  const newline = value.indexOf("\r\n");
  if (newline === -1) return value;
  const length = Number.parseInt(value.slice(0, newline), 16);
  if (!Number.isFinite(length) || length < 0) return value;
  return value.slice(newline + 2, newline + 2 + length).trim();
}

function endConnect(socket, statusCode, code = null) {
  const statusText = {
    400: "Bad Request",
    502: "Bad Gateway",
    503: "Service Unavailable",
  }[statusCode] || "Forbidden";
  const codeHeader = code ? `X-WFL-Proxy-Error: ${boundedText(code, 32) || "connect"}\r\n` : "";
  socket.end(`HTTP/1.1 ${statusCode} ${statusText}\r\n${codeHeader}Connection: close\r\n\r\n`);
}

async function closeHttpServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

function officialProxyError(code, message, statusCode = 502) {
  const error = new Error(message);
  error.proxyCode = code;
  error.statusCode = statusCode;
  return error;
}
