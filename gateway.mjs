import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_SOURCE_SHA256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const UPSTREAM_HOST = process.env.CODEX_DESKTOP_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORTS = new Set(
  String(process.env.CODEX_DESKTOP_UPSTREAM_PORTS || "4318,4319")
    .split(",")
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
);
const DEFAULT_UPSTREAM_PORT = Number(process.env.CODEX_DESKTOP_UPSTREAM_PORT || 4318);
const DEFAULT_RESCUE_UPSTREAM_PORT = Number(process.env.CODEX_DESKTOP_RESCUE_PORT || 4321);
const RESCUE_UPSTREAM_PORTS = new Set([DEFAULT_RESCUE_UPSTREAM_PORT]);
const GATEWAY_TEST_MODE = process.env.CODEX_DESKTOP_GATEWAY_TEST_MODE === "1";
const ACTIVE_PORT_FILE = path.resolve(
  process.env.CODEX_DESKTOP_ACTIVE_PORT_FILE || path.join(APP_DIR, ".codex-runtime", "active-port"),
);
const RECONNECT_DELAY_MS = 500;
const HEARTBEAT_INTERVAL_MS = Number(process.env.CODEX_DESKTOP_HEARTBEAT_INTERVAL_MS || 25_000);
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.CODEX_DESKTOP_KEEP_ALIVE_TIMEOUT_MS || 120_000);
const CONNECTION_POLICY_VERSION = 8;
const OFFICIAL_BROWSER_VNC_PATHS = new Set([
  "/api/providers/official/login/browser/vnc",
  "/api/claude/official/login/browser/vnc",
  "/api/claude/mcp/oauth/browser/vnc",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const bridges = new Map();
const upstreamAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1_000, maxFreeSockets: 16 });

if (!UPSTREAM_PORTS.has(DEFAULT_UPSTREAM_PORT)) {
  throw new Error("Default upstream port is not allowlisted");
}
if (DEFAULT_RESCUE_UPSTREAM_PORT !== 4321 && !GATEWAY_TEST_MODE) {
  throw new Error("Rescue upstream port is fixed at 4321");
}
if ([...RESCUE_UPSTREAM_PORTS].some((port) => UPSTREAM_PORTS.has(port))) {
  throw new Error("Rescue upstream ports must be isolated from main upstream ports");
}
if (!Number.isFinite(HEARTBEAT_INTERVAL_MS) || HEARTBEAT_INTERVAL_MS < 1_000) {
  throw new Error("WebSocket heartbeat interval must be at least 1000ms");
}
if (!Number.isFinite(KEEP_ALIVE_TIMEOUT_MS) || KEEP_ALIVE_TIMEOUT_MS < 10_000) {
  throw new Error("HTTP keep-alive timeout must be at least 10000ms");
}

const server = http.createServer((request, response) => {
  if (request.url === "/internal/gateway-ready" && isDirectLoopbackRequest(request)) {
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(`${JSON.stringify({
      ok: true,
      upstreamPort: activeUpstreamPort(),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
      connectionPolicyVersion: CONNECTION_POLICY_VERSION,
      gatewaySourceSha256: GATEWAY_SOURCE_SHA256,
      rescueUpstreamPort: activeRescueUpstreamPort(),
      rescueUpstreamPorts: [...RESCUE_UPSTREAM_PORTS],
      rescueFallback: false,
      rescueChannelIsolated: true,
    })}\n`);
    return;
  }
  proxyHttpRequest(request, response);
});
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  const rescueSocket = pathname === "/rescue/ws";
  const vncSocket = OFFICIAL_BROWSER_VNC_PATHS.has(pathname);
  const deviceSocket = pathname === "/device/ws";
  if ((!rescueSocket && !vncSocket && !deviceSocket && pathname !== "/ws") || !validWebSocketOrigin(request)) {
    socket.destroy();
    return;
  }

  let settled = false;
  const fail = (status = 503, reason = "Service Unavailable") => {
    if (settled) return;
    settled = true;
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  };
  const connect = (target) => {
    const upstream = openUpstream(request.headers, target);
    upstream.once("open", () => {
      if (settled) return;
      settled = true;
      wss.handleUpgrade(request, socket, head, (client) => {
        bridges.set(client, bridgeWebSocket(client, upstream, request.headers, { opaque: vncSocket || deviceSocket }));
        client.once("close", () => bridges.delete(client));
        wss.emit("connection", client, request);
      });
    });
    const unavailable = () => {
      fail(503, rescueSocket ? "Rescue Service Unavailable" : "Service Unavailable");
    };
    upstream.once("unexpected-response", (_request, response) => {
      fail(response.statusCode || 503, http.STATUS_CODES[response.statusCode] || "Service Unavailable");
    });
    upstream.once("error", unavailable);
  };
  connect(rescueSocket
    ? rescueUpstreamTarget(rescueWebSocketPath(request.url))
    : vncSocket
      ? { port: activeUpstreamPort(), path: request.url, channel: "main" }
      : { port: activeUpstreamPort(), path: request.url || "/ws", channel: "main" });
});

server.listen(PORT, HOST, () => {
  console.log(`WFL Codex Gateway: http://${HOST}:${PORT} -> ${UPSTREAM_HOST}:${activeUpstreamPort()}`);
});

let observedUpstreamPort = activeUpstreamPort();
let observedRescueUpstreamPort = activeRescueUpstreamPort();
setInterval(() => {
  const port = activeUpstreamPort();
  const rescuePort = activeRescueUpstreamPort();
  if (port === observedUpstreamPort && rescuePort === observedRescueUpstreamPort) return;
  observedUpstreamPort = port;
  observedRescueUpstreamPort = rescuePort;
  for (const bridge of bridges.values()) bridge.migrate({ port, rescuePort });
}, 250).unref();

function proxyHttpRequest(request, response) {
  const target = httpUpstreamTarget(request.url);
  if (target.channel === "rescue") {
    proxyRescueHttpRequest(request, response, target);
    return;
  }
  proxyHttpRequestOnce(request, response, target);
}

function proxyRescueHttpRequest(request, response, rescueTarget) {
  proxyHttpRequestOnce(request, response, rescueTarget, null, "rescue");
}

function proxyHttpRequestOnce(request, response, target, body = null, channel = "main") {
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: target.port,
      method: request.method,
      path: target.path,
      headers: endToEndHeaders(request.headers),
      agent: upstreamAgent,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, endToEndHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "1",
    });
    response.end(channel === "rescue"
      ? "Rescue service is unavailable. The main service was not used.\n"
      : "Service is updating. Retry shortly.\n");
  });
  request.on("aborted", () => upstream.destroy());
  if (body === null) request.pipe(upstream);
  else {
    if (body.length) upstream.setHeader?.("Content-Length", String(body.length));
    upstream.end(body);
  }
}

function endToEndHeaders(headers) {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  for (const token of String(headers.connection || "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) blocked.add(name);
  }
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

function bridgeWebSocket(client, initialUpstream, requestHeaders, { opaque = false } = {}) {
  let upstream = initialUpstream;
  let reconnectTimer = null;
  let closed = false;
  let clientMissedHeartbeats = 0;
  let upstreamMissedHeartbeats = 0;

  client.on("pong", () => { clientMissedHeartbeats = 0; });
  const heartbeatTimer = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) {
      if (clientMissedHeartbeats >= 2) {
        client.terminate();
        return;
      }
      clientMissedHeartbeats += 1;
      client.ping();
    }
    if (upstream.readyState === WebSocket.OPEN) {
      if (upstreamMissedHeartbeats >= 2) {
        upstream.terminate();
        return;
      }
      upstreamMissedHeartbeats += 1;
      upstream.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const forwardUpstreamMessage = (data, isBinary) => {
    upstreamMissedHeartbeats = 0;
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  };
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    if (opaque) {
      client.close(1012, "Backend switched");
      return;
    }
    sendJson(client, { type: "bridge/status", payload: { status: "starting" } });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      upstream = openUpstream(
        requestHeaders,
        upstream.codexDesktopChannel === "rescue"
          ? rescueUpstreamTarget(upstream.codexDesktopPath)
          : {
              port: activeUpstreamPort(),
              path: upstream.codexDesktopPath,
              channel: "main",
            },
      );
      upstream.once("open", attachUpstream);
      upstream.once("unexpected-response", (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 429) {
          client.close(1008, "Authentication required");
          return;
        }
        scheduleReconnect();
      });
      upstream.once("error", () => {});
      upstream.once("close", scheduleReconnect);
    }, RECONNECT_DELAY_MS);
  };
  const attachUpstream = () => {
    upstreamMissedHeartbeats = 0;
    upstream.removeListener("close", scheduleReconnect);
    upstream.on("pong", () => { upstreamMissedHeartbeats = 0; });
    upstream.on("message", forwardUpstreamMessage);
    upstream.once("close", scheduleReconnect);
  };

  attachUpstream();
  client.on("message", (data, isBinary) => {
    clientMissedHeartbeats = 0;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (opaque) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "rpc" && message.requestId !== undefined) {
        sendJson(client, {
          type: "rpc/error",
          requestId: message.requestId,
          message: "服务正在更新，请稍后重试",
        });
      }
    } catch {
      // Ignore non-RPC data while the backend reconnects.
    }
  });
  client.once("close", () => {
    closed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
  return {
    migrate({ port, rescuePort }) {
      const targetPort = upstream.codexDesktopChannel === "rescue" ? rescuePort : port;
      if (upstream.codexDesktopPort === targetPort) return;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(1012, "Backend switched");
      }
    },
  };
}

function openUpstream(requestHeaders, target = null) {
  const headers = {};
  for (const name of [
    "authorization",
    "cookie",
    "origin",
    "host",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]) {
    if (requestHeaders[name] !== undefined) headers[name] = requestHeaders[name];
  }
  const port = target?.port || activeUpstreamPort();
  const websocketPath = target?.path || "/ws";
  const upstream = new WebSocket(`ws://${UPSTREAM_HOST}:${port}${websocketPath}`, { headers });
  upstream.codexDesktopPort = port;
  upstream.codexDesktopPath = websocketPath;
  upstream.codexDesktopChannel = target?.channel === "rescue" ? "rescue" : "main";
  return upstream;
}

function httpUpstreamTarget(requestUrl) {
  const value = String(requestUrl || "/");
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);
  if (["/rescue", "/rescue/", "/rescue.html"].includes(pathname)) {
    return rescueUpstreamTarget(`/rescue.html${query}`);
  }
  if (pathname.startsWith("/rescue/")) {
    // Keep the namespace intact so the rescue backend can normalize its own
    // assets and API paths. Stripping the prefix turns /rescue/assets/* into
    // /assets/*, which falls through to the unstyled application shell.
    return rescueUpstreamTarget(`${pathname}${query}`);
  }
  return { port: activeUpstreamPort(), path: value };
}

function activeUpstreamPort() {
  return selectedPort(ACTIVE_PORT_FILE, UPSTREAM_PORTS, DEFAULT_UPSTREAM_PORT);
}

function activeRescueUpstreamPort() {
  return DEFAULT_RESCUE_UPSTREAM_PORT;
}

function selectedPort(filename, allowlist, fallback) {
  try {
    const port = Number(fs.readFileSync(filename, "utf8").trim());
    if (allowlist.has(port)) return port;
  } catch {
    // Use the configured default before the first slot activation.
  }
  return fallback;
}

function rescueUpstreamTarget(pathname) {
  return { port: activeRescueUpstreamPort(), path: pathname, channel: "rescue" };
}

function rescueWebSocketPath(requestUrl) {
  const source = new URL(String(requestUrl || "/rescue/ws"), "http://localhost");
  return `/ws${source.search}`;
}

function validWebSocketOrigin(request) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host) return false;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isDirectLoopbackRequest(request) {
  const remote = request.socket.remoteAddress;
  const host = request.headers.host;
  return (
    (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") &&
    (host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`)
  );
}

function sendJson(client, message) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function shutdown() {
  for (const client of wss.clients) client.close(1012, "Gateway restarting");
  wss.close();
  upstreamAgent.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
