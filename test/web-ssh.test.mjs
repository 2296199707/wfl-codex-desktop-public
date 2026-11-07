import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import express from "express";
import ssh2 from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import { WebSshService, inspectWebSshHostKey } from "../lib/web-ssh.mjs";
import { createWebSshRouters } from "../lib/web-ssh-http.mjs";

const FINGERPRINT = `SHA256:${crypto.createHash("sha256").update("test-host").digest("base64").replace(/=+$/u, "")}`;
const TARGET = { name: "Test SSH", host: "server.example.com", port: 2222, username: "operator", password: "test-remote-password", hostKeyFingerprint: FINGERPRINT };

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stderr.pause = () => {};
    this.stderr.resume = () => {};
    this.writes = [];
    this.windows = [];
    this.paused = false;
  }
  write(data) { this.writes.push(data); }
  setWindow(...values) { this.windows.push(values); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  end() { this.ended = true; }
}

class FakeClient extends EventEmitter {
  shell(options, callback) {
    this.options = options;
    this.channel = new FakeChannel();
    callback(null, this.channel);
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.emit("close");
  }
}

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.messages = []; }
  send(data, options, callback) {
    this.messages.push(options?.binary ? Buffer.from(data) : JSON.parse(data));
    callback?.();
  }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.reason = reason; this.emit("close"); }
  terminate() { this.close(1006); }
  ping() { this.emit("pong"); }
  receive(message) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-web-ssh-test-"));
  const connections = [];
  const connector = { connect: async (input) => {
    const client = new FakeClient();
    connections.push({ input: { ...input }, client });
    return { client };
  } };
  const service = await new WebSshService(directory, { connector, ...options }).initialize();
  t.after(async () => { service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, connections, connector };
}

async function until(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected SSH state did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function authenticate(service, result) {
  const socket = new FakeSocket();
  service.accept(socket);
  socket.receive({ type: "authenticate", ticket: result.ticket, cols: 92, rows: 30 });
  await until(() => socket.messages.some((message) => message.type === "ready"));
  return socket;
}

test("web SSH encrypts remote credentials and only returns the access key at creation", async (t) => {
  const { service, connections } = await fixture(t);
  const target = await service.saveTarget("admin-a", { ...TARGET, password: "", privateKey: "test-private-key", passphrase: "test-key-passphrase" });
  const reference = { kind: "saved", id: target.id };
  const grant = await service.createGrant("admin-a", { reference, accessKey: "test-access-key", expiresInSeconds: 0 });
  assert.equal(grant.accessKey, "test-access-key");
  const stored = await fs.readFile(service.storePath, "utf8");
  for (const secret of ["test-private-key", "test-key-passphrase", "test-access-key"]) assert.ok(!stored.includes(secret));
  assert.equal((await fs.stat(service.storePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(service.keyPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(service.directory)).mode & 0o777, 0o700);
  const snapshot = JSON.stringify(await service.snapshot("admin-a"));
  assert.ok(!snapshot.includes("credentials"));
  assert.ok(!snapshot.includes("digest"));
  assert.ok(!snapshot.includes(grant.accessKey));
  const restarted = await new WebSshService(path.dirname(path.dirname(service.directory)), { connector: service.connector }).initialize();
  t.after(() => restarted.close());
  const result = await restarted.issueAccessTicket(grant.accessKey);
  assert.equal(result.target.id, target.id);
  await authenticate(restarted, result);
  assert.equal(connections.at(-1).input.privateKey, "test-private-key");
  assert.equal(connections.at(-1).input.passphrase, "test-key-passphrase");
  assert.equal(connections.at(-1).input.expectedFingerprint, FINGERPRINT);
});

test("direct links are random, reusable without expiry, privately recoverable and revocable", async (t) => {
  let now = 1_800_000_000_000;
  const { service, directory, connector } = await fixture(t, { now: () => now });
  const target = await service.saveTarget("admin-a", TARGET);
  const reference = { kind: "saved", id: target.id };
  const link = await service.createGrant("admin-a", { reference, mode: "link", accessKey: "short", expiresInSeconds: 1 });
  assert.match(link.accessKey, /^[A-Za-z0-9_-]{64}$/u);
  assert.equal(link.grant.mode, "link");
  assert.equal(link.grant.expiresAt, null);
  const other = await service.createGrant("admin-a", { reference, mode: "link" });
  assert.notEqual(other.accessKey, link.accessKey);
  assert.ok(!(await fs.readFile(service.storePath, "utf8")).includes(link.accessKey));
  const snapshot = JSON.stringify(await service.snapshot("admin-a"));
  for (const value of [link.accessKey, "linkSecret", "digest"]) assert.ok(!snapshot.includes(value));
  const restarted = await new WebSshService(directory, { connector, now: () => now }).initialize();
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.readDirectLink("admin-a", link.grant.id), { accessKey: link.accessKey });
  await assert.rejects(restarted.readDirectLink("admin-b", link.grant.id), { statusCode: 404 });
  now += 10 * 365 * 86_400_000;
  const first = await authenticate(restarted, await restarted.issueAccessTicket(link.accessKey, { mode: "link" }));
  const second = await authenticate(restarted, await restarted.issueAccessTicket(link.accessKey, { mode: "link" }));
  assert.equal(first.readyState, 1);
  assert.equal(second.readyState, 1);
  await restarted.revokeGrant("admin-a", link.grant.id);
  assert.equal(first.readyState, 3);
  assert.equal(second.readyState, 3);
  await assert.rejects(restarted.readDirectLink("admin-a", link.grant.id), { statusCode: 404 });
  await assert.rejects(restarted.issueAccessTicket(link.accessKey, { mode: "link" }), { statusCode: 403 });
  assert.equal((await restarted.issueAccessTicket(other.accessKey, { mode: "link" })).target.id, target.id);
});

test("an access key binds to exactly one target and a connection ticket can only be used once", async (t) => {
  const { service } = await fixture(t, { ownerAllowed: async (id) => id === "admin-a" });
  const first = await service.saveTarget("admin-a", TARGET);
  const second = await service.saveTarget("admin-a", { ...TARGET, host: "other.example.com" });
  assert.deepEqual(await service.snapshot("admin-b"), { targets: [], grants: [] });
  await assert.rejects(service.createGrant("admin-b", { reference: { kind: "saved", id: first.id } }), { statusCode: 404 });
  await assert.rejects(service.issueOwnerTicket("admin-b", { kind: "saved", id: first.id }), { statusCode: 403 });
  const grant = await service.createGrant("admin-a", { reference: { kind: "saved", id: first.id } });
  const result = await service.issueAccessTicket(grant.accessKey);
  assert.equal(result.target.id, first.id);
  const context = await service.consumeTicket(result.ticket);
  assert.notEqual(context.reference.id, second.id);
  assert.equal(context.authSession, undefined);
  await assert.rejects(service.consumeTicket(result.ticket), { statusCode: 403 });
  await assert.rejects(service.issueAccessTicket("incorrect-key"), { statusCode: 403 });
  await assert.rejects(service.createGrant("admin-a", { reference: context.reference, accessKey: grant.accessKey }), { statusCode: 409 });
});

test("web SSH forwards PTY input, binary output, resize and output acknowledgements", async (t) => {
  const { service, connections } = await fixture(t);
  const target = await service.saveTarget("admin-a", TARGET);
  const socket = await authenticate(service, await service.issueOwnerTicket("admin-a", { kind: "saved", id: target.id }));
  const client = connections.at(-1).client;
  assert.equal(connections.at(-1).input.keepaliveInterval, 15_000);
  assert.equal(connections.at(-1).input.keepaliveCountMax, 6);
  assert.deepEqual(client.options, { term: "xterm-256color", cols: 92, rows: 30 });
  socket.receive({ type: "input", data: "printf hello\n\x03" });
  socket.receive({ type: "resize", cols: 120, rows: 40 });
  await until(() => client.channel.writes.length === 1 && client.channel.windows.length === 1);
  assert.deepEqual(client.channel.writes, ["printf hello\n\x03"]);
  assert.deepEqual(client.channel.windows, [[40, 120, 0, 0]]);
  const output = Buffer.alloc(256 * 1024, 65);
  client.channel.emit("data", output);
  assert.deepEqual(socket.messages.at(-1), output);
  assert.equal(client.channel.paused, true);
  socket.receive({ type: "ack", bytes: output.length });
  await until(() => !client.channel.paused);
  client.channel.stderr.emit("data", Buffer.from("stderr"));
  assert.equal(socket.messages.at(-1).toString(), "stderr");
  socket.receive({ type: "disconnect" });
  assert.equal(client.ended, true);
  assert.equal(service.sessions.size, 0);
});

test("a temporary browser disconnect resumes the same PTY without replaying input", async (t) => {
  const { service, connections } = await fixture(t);
  const target = await service.saveTarget("admin-a", TARGET);
  const original = await authenticate(service, await service.issueOwnerTicket("admin-a", { kind: "saved", id: target.id }));
  const client = connections.at(-1).client;
  const ready = original.messages.find((message) => message.type === "ready");
  original.receive({ type: "input", data: "long-running-command\n" });
  original.close(1006);
  assert.ok(!client.ended);
  assert.equal(client.channel.paused, true);
  client.channel.emit("data", Buffer.from("output during reconnect"));
  const resumed = new FakeSocket();
  service.accept(resumed);
  resumed.receive({ type: "resume", resumeToken: ready.resumeToken, cols: 120, rows: 32 });
  await until(() => resumed.messages.some((message) => message.type === "ready"));
  assert.equal(resumed.messages.find((message) => message.type === "ready").resumed, true);
  assert.equal(resumed.messages.find((message) => message.type === "ready").fileToken, ready.fileToken);
  assert.equal(resumed.messages.at(-1).toString(), "output during reconnect");
  resumed.receive({ type: "input", data: "\x03" });
  assert.deepEqual(client.channel.writes, ["long-running-command\n", "\x03"]);
  assert.equal(connections.length, 2);
  assert.equal(client.channel.paused, false);
  resumed.receive({ type: "disconnect" });
  assert.equal(client.ended, true);
});

test("resume cannot replace a live terminal, bypass expiry, or recover a revoked grant", async (t) => {
  let now = Date.now();
  const { service } = await fixture(t, { now: () => now, resumeGraceMs: 1000 });
  const target = await service.saveTarget("admin-a", TARGET);
  const reference = { kind: "saved", id: target.id };
  const original = await authenticate(service, await service.issueOwnerTicket("admin-a", reference));
  const token = original.messages.find((message) => message.type === "ready").resumeToken;
  const attempted = new FakeSocket();
  service.accept(attempted);
  attempted.receive({ type: "resume", resumeToken: token });
  await until(() => attempted.readyState === 3);
  assert.equal(attempted.messages.at(-1).statusCode, 409);
  assert.equal(original.readyState, 1);
  original.close(1006);
  now += 1001;
  await assert.rejects(service.findResumeSession(token), { statusCode: 403 });
  await service.sweep();
  assert.equal(service.sessions.size, 0);
  const grant = await service.createGrant("admin-a", { reference });
  const guest = await authenticate(service, await service.issueAccessTicket(grant.accessKey));
  const guestReady = guest.messages.find((message) => message.type === "ready");
  guest.close(1006);
  await service.revokeGrant("admin-a", grant.grant.id);
  await assert.rejects(service.findResumeSession(guestReady.resumeToken), { statusCode: 403 });
  await assert.rejects(service.withFiles(guestReady.fileToken, () => {}), { statusCode: 403 });
});

test("revoke and expiry close the associated terminal without closing other sessions", async (t) => {
  let now = 1_800_000_000_000;
  const { service } = await fixture(t, { now: () => now });
  const target = await service.saveTarget("admin-a", TARGET);
  const reference = { kind: "saved", id: target.id };
  const first = await service.createGrant("admin-a", { reference, expiresInSeconds: 1 });
  const second = await service.createGrant("admin-a", { reference, expiresInSeconds: 0 });
  const owner = await authenticate(service, await service.issueOwnerTicket("admin-a", reference));
  const expiring = await authenticate(service, await service.issueAccessTicket(first.accessKey));
  const revoked = await authenticate(service, await service.issueAccessTicket(second.accessKey));
  const pendingTicket = await service.issueAccessTicket(second.accessKey);
  await assert.rejects(service.revokeGrant("admin-b", second.grant.id), { statusCode: 404 });
  await service.revokeGrant("admin-a", second.grant.id);
  assert.equal(revoked.readyState, 3);
  assert.equal(expiring.readyState, 1);
  await assert.rejects(service.consumeTicket(pendingTicket.ticket), { statusCode: 403 });
  await assert.rejects(service.issueAccessTicket(second.accessKey), { statusCode: 403 });
  now += 1_001;
  await service.sweep();
  assert.equal(expiring.readyState, 3);
  assert.equal(owner.readyState, 1);
  await assert.rejects(service.issueAccessTicket(first.accessKey), { statusCode: 403 });
  await service.deleteTarget("admin-a", target.id);
  assert.equal(owner.readyState, 3);
  assert.equal((await service.snapshot("admin-a")).grants.length, 0);
});

test("revocation during SSH authentication cannot resurrect a terminal", async (t) => {
  const { service, connector } = await fixture(t);
  const target = await service.saveTarget("admin-a", TARGET);
  const grant = await service.createGrant("admin-a", { reference: { kind: "saved", id: target.id } });
  let resolveConnection;
  connector.connect = () => new Promise((resolve) => { resolveConnection = resolve; });
  const result = await service.issueAccessTicket(grant.accessKey);
  const socket = new FakeSocket();
  service.accept(socket);
  socket.receive({ type: "authenticate", ticket: result.ticket });
  await until(() => Boolean(resolveConnection));
  await service.revokeGrant("admin-a", grant.grant.id);
  const client = new FakeClient();
  resolveConnection({ client });
  await until(() => client.ended);
  assert.equal(socket.readyState, 3);
  assert.ok(!socket.messages.some((message) => message.type === "ready"));
  assert.equal(client.channel, undefined);
});

test("concurrent settings reads do not discard a pending grant write", async (t) => {
  const { service } = await fixture(t);
  const target = await service.saveTarget("admin-a", TARGET);
  const original = service.ensureKey.bind(service);
  let release;
  service.ensureKey = async () => { await original(); await new Promise((resolve) => { release = resolve; }); };
  const writing = service.createGrant("admin-a", { reference: { kind: "saved", id: target.id } });
  await until(() => Boolean(release));
  await service.snapshot("admin-a");
  release();
  const grant = await writing;
  assert.equal((await service.snapshot("admin-a")).grants[0].id, grant.grant.id);
  assert.equal((await service.issueAccessTicket(grant.accessKey)).target.id, target.id);
});

test("expired tickets, invalid input and lost owner authorization fail closed without echoing credentials", async (t) => {
  let now = 1_800_000_000_000;
  let allowed = true;
  const { service, connector } = await fixture(t, { now: () => now, ownerAllowed: async () => allowed });
  const target = await service.saveTarget("admin-a", TARGET);
  const reference = { kind: "saved", id: target.id };
  const expired = await service.issueOwnerTicket("admin-a", reference);
  now += 30_001;
  await assert.rejects(service.consumeTicket(expired.ticket), { statusCode: 403 });
  const socket = await authenticate(service, await service.issueOwnerTicket("admin-a", reference));
  socket.receive({ type: "input", data: { invalid: true } });
  await until(() => socket.readyState === 3);
  const second = await authenticate(service, await service.issueOwnerTicket("admin-a", reference));
  allowed = false;
  await service.sweep();
  assert.equal(second.readyState, 3);
  allowed = true;
  connector.connect = async () => { throw new Error(TARGET.password); };
  const broken = new FakeSocket();
  service.accept(broken);
  broken.receive({ type: "authenticate", ticket: (await service.issueOwnerTicket("admin-a", reference)).ticket });
  await until(() => broken.readyState === 3);
  assert.ok(!JSON.stringify(broken.messages).includes(TARGET.password));
  const unauthenticated = new FakeSocket();
  service.accept(unauthenticated);
  service.close();
  assert.equal(unauthenticated.readyState, 3);
});

test("an administrator session revocation only closes its own browser terminal", async (t) => {
  let valid = true;
  const { service } = await fixture(t, { sessionAllowed: async () => valid });
  const target = await service.saveTarget("admin-a", TARGET);
  const reference = { kind: "saved", id: target.id };
  const owner = await authenticate(service, await service.issueOwnerTicket("admin-a", reference, { id: "admin-session" }));
  const grant = await service.createGrant("admin-a", { reference });
  const guest = await authenticate(service, await service.issueAccessTicket(grant.accessKey));
  valid = false;
  await service.sweep();
  assert.equal(owner.readyState, 3);
  assert.equal(guest.readyState, 1);
});

test("missing master key does not regenerate credentials or prevent optional service initialization", async (t) => {
  const { service, directory } = await fixture(t);
  await service.saveTarget("admin-a", TARGET);
  const before = await fs.readFile(service.storePath, "utf8");
  await fs.unlink(service.keyPath);
  const restarted = await new WebSshService(directory).initialize();
  t.after(() => restarted.close());
  assert.ok(restarted.loadError);
  await assert.rejects(restarted.snapshot("admin-a"), { statusCode: 503 });
  assert.equal(await fs.readFile(service.storePath, "utf8"), before);
  await assert.rejects(fs.stat(service.keyPath), { code: "ENOENT" });
});

test("public key login is one fixed-target endpoint, not a website login or arbitrary SSH connector", async (t) => {
  const { service } = await fixture(t);
  const target = await service.saveTarget("admin-a", TARGET);
  const grant = await service.createGrant("admin-a", { reference: { kind: "saved", id: target.id } });
  const link = await service.createGrant("admin-a", { reference: { kind: "saved", id: target.id }, mode: "link" });
  let failures = 0;
  const app = express();
  app.use(express.json());
  const routes = createWebSshRouters({
    service,
    requireAdmin: (request) => { if (request.user?.id !== "admin-a") throw Object.assign(new Error("Admin required"), { statusCode: 403 }); },
    assertOperation: (request, action) => {
      if (request.headers.origin !== "https://wfl.example" || request.get("x-codex-desktop-action") !== action) {
        throw Object.assign(new Error("Same origin required"), { statusCode: 403 });
      }
    },
    mutate: (operation) => operation(), persistentServers: async () => [],
    recordFailure: () => { failures += 1; }, clearFailures: () => { failures = 0; }, retryAfter: () => failures >= 3 ? 30 : 0,
  });
  app.use("/api/tools/web-ssh/access", routes.accessRouter);
  app.use((request, response, next) => {
    if (request.get("x-test-user") !== "admin-a") { response.status(401).json({ error: "Website login required" }); return; }
    request.user = { id: "admin-a" };
    next();
  });
  app.use("/api/tools/web-ssh", routes.router);
  app.get("/api/private", (_request, response) => response.json({ private: true }));
  app.use((error, _request, response, _next) => response.status(error.statusCode || 500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (resource, body, extraHeaders = {}) => fetch(`${base}${resource}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Origin: "https://wfl.example", "X-Codex-Desktop-Action": "web-ssh-access", ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await call("/api/tools/web-ssh/status")).status, 401);
  assert.equal((await call("/api/private", { accessKey: grant.accessKey })).status, 401);
  const response = await call("/api/tools/web-ssh/access/sessions", { accessKey: grant.accessKey, host: "evil.example", reference: { kind: "saved", id: "other" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const result = await response.json();
  assert.equal(result.target.id, target.id);
  const context = await service.consumeTicket(result.ticket);
  assert.equal(context.reference.id, target.id);
  assert.equal(context.authSession, undefined);
  assert.equal((await call("/api/tools/web-ssh/access/sessions", { accessKey: grant.accessKey }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/tools/web-ssh/status", null, { "x-test-user": "admin-a" })).status, 200);
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await call("/api/tools/web-ssh/access/sessions", { accessKey: "wrong-key" })).status, 403);
  const throttled = await call("/api/tools/web-ssh/access/sessions", { accessKey: "wrong-key" });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "30");
  assert.equal((await call(`/api/tools/web-ssh/grants/${link.grant.id}/link`)).status, 401);
  const recovered = await call(`/api/tools/web-ssh/grants/${link.grant.id}/link`, null, { "x-test-user": "admin-a" });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("cache-control"), "no-store");
  assert.deepEqual(await recovered.json(), { accessKey: link.accessKey });
  assert.equal((await call("/api/tools/web-ssh/access/links/sessions", { accessKey: grant.accessKey })).status, 403);
  assert.equal((await call("/api/tools/web-ssh/access/links/sessions", { accessKey: "missing-link" })).status, 403);
  const direct = await call("/api/tools/web-ssh/access/links/sessions", { accessKey: link.accessKey, host: "evil.example" });
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get("set-cookie"), null);
  assert.equal(direct.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await direct.json()).target.id, target.id);
  assert.equal((await call("/api/tools/web-ssh/access/links/sessions", { accessKey: link.accessKey })).status, 200);
  assert.equal((await call("/api/tools/web-ssh/status", null, { "x-test-user": "admin-a" })).status, 200);
});

test("actual local SSH PTY renders over WebSocket and pins the confirmed host key", { timeout: 10_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-web-ssh-pty-"));
  const { private: privateKey } = ssh2.utils.generateKeyPairSync("ed25519");
  const clientKeys = ssh2.utils.generateKeyPairSync("ed25519", { passphrase: "test-private-key-passphrase", cipher: "aes256-ctr", rounds: 1 });
  const clientPublicKey = ssh2.utils.parseKey(clientKeys.public);
  const sshClients = new Set();
  let pty = null;
  let resized = null;
  let authenticated = 0;
  const sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    sshClients.add(client);
    client.on("error", () => {});
    client.once("close", () => sshClients.delete(client));
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "operator" && context.password === TARGET.password) { authenticated += 1; context.accept(); }
      else if (context.method === "publickey" && context.username === "operator"
        && context.key.data.equals(clientPublicKey.getPublicSSH())
        && (!context.signature || clientPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true)) {
        authenticated += 1;
        context.accept();
      }
      else context.reject(["password"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty, _reject, info) => { pty = info; acceptPty(); });
      session.on("window-change", (acceptResize, _reject, info) => { resized = info; acceptResize?.(); });
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("local-ssh-ready\r\n");
        stream.on("data", (data) => stream.write(data));
      });
    }));
  });
  let service;
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => service.accept(socket));
  let socket;
  t.after(async () => {
    socket?.terminate();
    service?.close();
    for (const client of sshClients) client.end();
    for (const client of wss.clients) client.terminate();
    await Promise.all([
      new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => sshServer.close(resolve)),
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const targetInput = { ...TARGET, host: "127.0.0.1", port: sshServer.address().port };
  const probe = await inspectWebSshHostKey(targetInput, { timeoutMs: 2_000 });
  assert.match(probe.hostKeyFingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
  assert.equal(authenticated, 0);
  service = await new WebSshService(directory).initialize();
  await assert.rejects(service.saveTarget("admin-a", { ...targetInput, hostKeyFingerprint: FINGERPRINT }), /指纹不匹配/u);
  await service.saveTarget("admin-a", { ...targetInput, ...probe });
  const target = await service.saveTarget("admin-a", { ...targetInput, ...probe, password: "", privateKey: clientKeys.private, passphrase: "test-private-key-passphrase" });
  const grant = await service.createGrant("admin-a", { reference: { kind: "saved", id: target.id } });
  const result = await service.issueAccessTicket(grant.accessKey);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ssh/ws`);
  const controls = [];
  let output = "";
  socket.on("message", (raw, binary) => {
    if (binary) { output += raw.toString(); socket.send(JSON.stringify({ type: "ack", bytes: raw.length })); }
    else controls.push(JSON.parse(raw.toString()));
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "authenticate", ticket: result.ticket, cols: 100, rows: 35 }));
  await until(() => controls.some((message) => message.type === "ready") && output.includes("local-ssh-ready"));
  assert.equal(pty.cols, 100);
  assert.equal(pty.rows, 35);
  socket.send(JSON.stringify({ type: "input", data: "interactive-input\n\x03" }));
  socket.send(JSON.stringify({ type: "resize", cols: 140, rows: 45 }));
  await until(() => output.includes("interactive-input") && resized?.cols === 140);
  assert.equal(resized.rows, 45);
  const closed = once(socket, "close");
  await service.revokeGrant("admin-a", grant.grant.id);
  await closed;
});

test("actual admin page route works inside a hidden release directory and requires admin access", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-release-route-"));
  const publicDirectory = path.join(directory, ".codex-runtime", "releases", "candidate", "public");
  await fs.mkdir(publicDirectory, { recursive: true });
  const html = await fs.readFile(new URL("../public/ssh.html", import.meta.url), "utf8");
  await fs.writeFile(path.join(publicDirectory, "ssh.html"), html);
  const source = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const start = source.indexOf('app.get(["/ssh", "/ssh/", "/ssh.html"]');
  assert.ok(start >= 0);
  const end = source.indexOf('\n});', start) + '\n});'.length;
  const app = express();
  vm.runInNewContext(source.slice(start, end), {
    app, path, PUBLIC_DIR: publicDirectory, webSshService: {},
    requireAdmin: (request) => { if (request.get("x-test-role") !== "admin") throw Object.assign(new Error("Admin required"), { statusCode: 403 }); },
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    markInlineHtmlResponse: (response, filename) => response.setHeader("Content-Disposition", `inline; filename="${filename}"`),
  });
  app.use((error, _request, response, _next) => response.status(error.statusCode || 500).json({ error: error.message }));
  const server = http.createServer(app);
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/ssh.html`)).status, 403);
  for (const route of ["/ssh", "/ssh/", "/ssh.html"]) {
    const response = await fetch(`${origin}${route}`, { headers: { "x-test-role": "admin" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), html);
  }
});

test("web SSH pages and navigation use local terminal assets and participate in normal version sync", async () => {
  const read = (resource) => fs.readFile(new URL(`../${resource}`, import.meta.url), "utf8");
  const [admin, access, script, index, app, server, gateway, versionSync] = await Promise.all([
    "public/ssh.html", "public/ssh-access.html", "public/web-ssh.js", "public/index.html", "public/app.js", "server.mjs", "gateway.mjs", "scripts/sync-version.mjs",
  ].map(read));
  assert.match(admin, /data-mode="admin"/u);
  assert.match(access, /id="accessKeyInput"/u);
  assert.doesNotMatch(access, /name="(?:password|privateKey|host|username)"/u);
  assert.doesNotMatch(script, /localStorage|sessionStorage/u);
  assert.match(script, /credentials: accessMode \? "omit" : "same-origin"/u);
  for (const html of [admin, access]) {
    for (const match of html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css))/gu)) {
      const asset = match[1].replace("/vendor/xterm-fit/", "/node_modules/@xterm/addon-fit/lib/").replace("/vendor/xterm/", "/node_modules/@xterm/xterm/");
      await fs.access(new URL(`..${asset.startsWith("/node_modules/") ? asset : `/public${asset}`}`, import.meta.url));
    }
  }
  assert.match(index, /data-toolbox-tool-id="web-ssh"[^>]*data-toolbox-admin="true"/u);
  assert.match(index, /<a[^>]*id="toolboxOpenWebSshButton"[^>]*href="\/ssh.html"[^>]*rel="noopener noreferrer"/u);
  assert.doesNotMatch(app, /浏览器阻止了网页 SSH 窗口/u);
  assert.ok(server.indexOf('app.use("/api/tools/web-ssh/access"') < server.indexOf('const multiUserEnabled = multiUserStore.modeSnapshot().enabled;', server.indexOf('const app = express();')));
  assert.match(server, /app\.get\(\["\/ssh", "\/ssh\/", "\/ssh.html"\][\s\S]{0,130}requireAdmin\(request\)/u);
  assert.match(gateway, /opaque: vncSocket \|\| deviceSocket \|\| sshSocket/u);
  assert.match(versionSync, /destination: webSshHtmlPath/u);
  assert.match(versionSync, /destination: webSshAccessHtmlPath/u);
});
