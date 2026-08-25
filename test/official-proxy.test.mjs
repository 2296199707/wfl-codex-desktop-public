import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  isOfficialProxyHost,
  OfficialProxyRouter,
  normalizeOfficialProxy,
  openOfficialProxyTunnel,
  publicOfficialProxy,
} from "../lib/official-proxy.mjs";

test("official proxy settings accept HTTP and SOCKS5 while redacting credentials", () => {
  const httpProxy = normalizeOfficialProxy({
    protocol: "http",
    host: "Residential.Example.com",
    port: 8_000,
    username: "customer-zone-home",
    password: "private-password",
    label: "家庭出口",
  });
  assert.deepEqual(httpProxy, {
    protocol: "http",
    host: "residential.example.com",
    port: 8_000,
    username: "customer-zone-home",
    password: "private-password",
    label: "家庭出口",
  });
  const publicProxy = publicOfficialProxy({
    config: httpProxy,
    health: {
      status: "ready",
      checkedAt: 10_000,
      latencyMs: 86,
      exitIp: "203.0.113.8",
    },
  });
  assert.deepEqual(publicProxy, {
    configured: true,
    protocol: "http",
    host: "residential.example.com",
    port: 8_000,
    label: "家庭出口",
    hasAuthentication: true,
    health: {
      status: "ready",
      checkedAt: 10_000,
      latencyMs: 86,
      exitIp: "203.0.113.8",
      code: null,
    },
  });
  assert.doesNotMatch(JSON.stringify(publicProxy), /customer-zone-home|private-password/);
  assert.equal(normalizeOfficialProxy({
    protocol: "socks5",
    host: "socks.example.test",
    port: 10_80,
  }).protocol, "socks5");
  assert.throws(
    () => normalizeOfficialProxy({ protocol: "https", host: "proxy.example.test", port: 443 }),
    /仅支持 HTTP 和 SOCKS5/,
  );
  assert.throws(
    () => normalizeOfficialProxy({ protocol: "http", host: "http://proxy.example.test", port: 8080 }),
    /地址无效/,
  );
  assert.equal(isOfficialProxyHost("api.openai.com"), true);
  assert.equal(isOfficialProxyHost("api.anthropic.com"), false);
  assert.equal(isOfficialProxyHost("api.anthropic.com", ["anthropic.com", "claude.com"]), true);
  assert.equal(isOfficialProxyHost("example.com", ["anthropic.com", "claude.com"]), false);
});

test("HTTP residential proxy CONNECT uses basic authentication and keeps credentials private", async () => {
  const target = await startEchoServer();
  let observedAuthorization = null;
  const proxy = await startHttpProxy({
    onConnect(request) {
      observedAuthorization = request.authorization;
    },
  });
  try {
    const socket = await openOfficialProxyTunnel({
      protocol: "http",
      host: "127.0.0.1",
      port: proxy.port,
      username: "proxy-user",
      password: "proxy-pass",
    }, "127.0.0.1", target.port, { allowPrivateProxy: true });
    socket.write("http-proxy-ok");
    assert.equal((await readExact(socket, 13)).toString(), "http-proxy-ok");
    socket.destroy();
    assert.equal(observedAuthorization, `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`);

    await assert.rejects(
      openOfficialProxyTunnel({
        protocol: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: "proxy-user",
        password: "wrong",
      }, "127.0.0.1", target.port, { allowPrivateProxy: true }),
      (error) => error.proxyCode === "authentication" && !/wrong/.test(error.message),
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("SOCKS5 residential proxy connects with username/password and remote DNS framing", async () => {
  const target = await startEchoServer();
  const observed = [];
  const proxy = await startSocks5Proxy({
    username: "socks-user",
    password: "socks-pass",
    observed,
  });
  try {
    const socket = await openOfficialProxyTunnel({
      protocol: "socks5",
      host: "127.0.0.1",
      port: proxy.port,
      username: "socks-user",
      password: "socks-pass",
    }, "127.0.0.1", target.port, { allowPrivateProxy: true });
    socket.write("socks-proxy-ok");
    assert.equal((await readExact(socket, 14)).toString(), "socks-proxy-ok");
    socket.destroy();
    assert.deepEqual(observed[0], { host: "127.0.0.1", port: target.port });
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("per-account router sends OpenAI hosts through the configured proxy and keeps other hosts direct", async () => {
  const proxyTargets = [];
  const proxy = await startHttpProxy({
    tunnelWithoutTarget: true,
    onConnect(request) {
      proxyTargets.push(request.authority);
    },
  });
  const directTarget = await startEchoServer();
  const router = new OfficialProxyRouter({ allowPrivateProxy: true });
  try {
    await router.configure({
      protocol: "http",
      host: "127.0.0.1",
      port: proxy.port,
    });
    const endpoint = new URL(router.snapshot().endpoint);
    const official = await connectTcp(endpoint.hostname, Number(endpoint.port));
    official.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
    assert.match((await readUntil(official, "\r\n\r\n")).toString(), /200 Connection Established/);
    official.destroy();
    assert.deepEqual(proxyTargets, ["api.openai.com:443"]);

    const direct = await connectTcp(endpoint.hostname, Number(endpoint.port));
    direct.write(`CONNECT 127.0.0.1:${directTarget.port} HTTP/1.1\r\nHost: 127.0.0.1:${directTarget.port}\r\n\r\n`);
    assert.match((await readUntil(direct, "\r\n\r\n")).toString(), /200 Connection Established/);
    direct.write("direct-ok");
    assert.equal((await readExact(direct, 9)).toString(), "direct-ok");
    direct.destroy();

    assert.match(router.environment().HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(router.environment().NO_PROXY, "127.0.0.1,localhost,::1");
  } finally {
    await router.close();
    await proxy.close();
    await directTarget.close();
  }
});

test("production proxy connections reject loopback and private endpoints", async () => {
  await assert.rejects(
    openOfficialProxyTunnel({
      protocol: "http",
      host: "127.0.0.1",
      port: 8_080,
    }, "api.openai.com", 443),
    (error) => error.proxyCode === "private" && error.statusCode === 400,
  );
});

async function startEchoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  const port = await listen(server);
  return { port, close: () => close(server) };
}

async function startHttpProxy({ onConnect = null, tunnelWithoutTarget = false } = {}) {
  const server = net.createServer(async (socket) => {
    try {
      const header = (await readUntil(socket, "\r\n\r\n")).toString("latin1");
      const authority = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]/i.exec(header)?.[1] || "";
      const authorization = /^Proxy-Authorization:\s*(.+)$/im.exec(header)?.[1]?.trim() || null;
      onConnect?.({ authority, authorization });
      if (authorization && authorization !== `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
        return;
      }
      if (tunnelWithoutTarget) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        return;
      }
      const target = parseAuthority(authority);
      const upstream = await connectTcp(target.host, target.port);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    } catch {
      socket.destroy();
    }
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

async function startSocks5Proxy({ username, password, observed }) {
  const server = net.createServer(async (socket) => {
    const reader = new TestSocketReader(socket);
    try {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([0x05, 0x02]));
      const authHeader = await reader.read(2);
      const providedUsername = (await reader.read(authHeader[1])).toString();
      const passwordLength = (await reader.read(1))[0];
      const providedPassword = (await reader.read(passwordLength)).toString();
      if (providedUsername !== username || providedPassword !== password) {
        socket.end(Buffer.from([0x01, 0x01]));
        return;
      }
      socket.write(Buffer.from([0x01, 0x00]));
      const request = await reader.read(5);
      const host = (await reader.read(request[4])).toString();
      const portBuffer = await reader.read(2);
      const port = portBuffer.readUInt16BE(0);
      observed.push({ host, port });
      const upstream = await connectTcp(host, port);
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      reader.detach();
      socket.resume();
      upstream.pipe(socket);
      socket.pipe(upstream);
    } catch {
      socket.destroy();
    }
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readExact(socket, length) {
  return readWithParser(socket, (buffer) =>
    buffer.length >= length ? { value: buffer.subarray(0, length), consumed: length } : null);
}

function readUntil(socket, marker) {
  const delimiter = Buffer.from(marker);
  return readWithParser(socket, (buffer) => {
    const index = buffer.indexOf(delimiter);
    if (index === -1) return null;
    const consumed = index + delimiter.length;
    return { value: buffer.subarray(0, consumed), consumed };
  });
}

function readWithParser(socket, parser) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("test socket read timed out"));
    }, 3_000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parser(buffer);
      if (!parsed) return;
      cleanup();
      const rest = buffer.subarray(parsed.consumed);
      if (rest.length) socket.unshift(rest);
      resolve(parsed.value);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function parseAuthority(authority) {
  const separator = authority.lastIndexOf(":");
  return {
    host: authority.slice(0, separator),
    port: Number(authority.slice(separator + 1)),
  };
}

class TestSocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    socket.on("data", this.onData);
  }

  read(length) {
    return new Promise((resolve) => {
      this.waiter = { length, resolve };
      this.flush();
    });
  }

  flush() {
    if (!this.waiter || this.buffer.length < this.waiter.length) return;
    const waiter = this.waiter;
    this.waiter = null;
    const value = this.buffer.subarray(0, waiter.length);
    this.buffer = this.buffer.subarray(waiter.length);
    waiter.resolve(value);
  }

  detach() {
    this.socket.pause();
    this.socket.removeListener("data", this.onData);
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}
