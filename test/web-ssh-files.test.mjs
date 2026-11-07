import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import express from "express";
import ssh2 from "ssh2";
import { WebSshService } from "../lib/web-ssh.mjs";
import { createWebSshRouters } from "../lib/web-ssh-http.mjs";

class TestSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.messages = []; }
  send(raw, options, done) { this.messages.push(options?.binary ? Buffer.from(raw) : JSON.parse(raw)); done?.(); }
  close() { this.readyState = 3; this.emit("close"); }
  receive(message) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
  ping() { this.emit("pong"); }
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected local SSH/SFTP state did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-ssh-files-"));
  const keys = ssh2.utils.generateKeyPairSync("ed25519");
  const fingerprint = `SHA256:${crypto.createHash("sha256").update(ssh2.utils.parseKey(keys.private).getPublicSSH()).digest("base64").replace(/=+$/u, "")}`;
  const files = new Map([["/remote/original.txt", Buffer.from("keep original")]]);
  const clients = new Set();
  let shells = 0;
  const inputs = [];
  const serverErrors = [];
  const sshServer = new ssh2.Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    client.on("error", (error) => serverErrors.push(error.message));
    client.once("close", () => clients.delete(client));
    client.on("authentication", (auth) => auth.username === "operator" && auth.password === "test-password"
      ? auth.accept() : auth.reject(["password"]));
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty());
      session.on("window-change", (acceptResize) => acceptResize?.());
      session.on("shell", (acceptShell) => {
        shells += 1;
        const stream = acceptShell();
        stream.on("data", (chunk) => { inputs.push(chunk.toString()); stream.write(chunk); });
      });
      session.on("sftp", (acceptSftp) => serveFiles(acceptSftp(), files));
    }));
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const service = await new WebSshService(directory).initialize();
  const target = await service.saveTarget("admin", {
    name: "Local test", host: "127.0.0.1", port: sshServer.address().port, username: "operator",
    password: "test-password", hostKeyFingerprint: fingerprint,
  });
  const grant = await service.createGrant("admin", { reference: { kind: "saved", id: target.id } });
  const ticket = await service.issueAccessTicket(grant.accessKey);
  const socket = new TestSocket();
  service.accept(socket);
  socket.receive({ type: "authenticate", ticket: ticket.ticket });
  await waitUntil(() => socket.messages.some((message) => message.type === "ready"));
  const ready = socket.messages.find((message) => message.type === "ready");
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const routes = createWebSshRouters({
    service, requireAdmin: () => {}, mutate: (operation) => operation(), persistentServers: async () => [],
    assertOperation: (request, action) => {
      if (request.get("origin") !== "https://wfl.example" || request.get("x-codex-desktop-action") !== action) {
        throw Object.assign(new Error("Invalid origin or action"), { statusCode: 403 });
      }
    },
  });
  app.use("/api/tools/web-ssh/access", routes.accessRouter);
  app.use((_request, response) => response.status(401).json({ error: "Website login required" }));
  app.use((error, _request, response, _next) => response.status(error.statusCode || 500).json({ error: error.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    service.close();
    for (const client of clients) client.end();
    server.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => sshServer.close(resolve))]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/tools/web-ssh/access/files`;
  const headers = {
    Origin: "https://wfl.example", "X-Codex-Desktop-Action": "web-ssh-files", "X-Wfl-Ssh-Session": ready.fileToken,
  };
  const jsonRequest = (endpoint, body, extraHeaders = {}) => fetch(`${base}/${endpoint}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
  });
  return { service, files, socket, ready, base, headers, jsonRequest, grant, inputs, serverErrors, shells: () => shells };
}

function serveFiles(sftp, files) {
  const handles = new Map();
  let handleId = 0;
  const normalized = (remote) => path.posix.resolve("/remote", remote);
  const attrs = (remote) => {
    if (remote === "/" || remote === "/remote") return { mode: 0o40755, size: 0, uid: 0, gid: 0, atime: 1, mtime: 1 };
    if (files.has(remote)) return { mode: 0o100644, size: files.get(remote).length, uid: 0, gid: 0, atime: 1, mtime: 1 };
    return null;
  };
  const handle = (requestId, entry) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(++handleId);
    handles.set(buffer.toString("hex"), entry);
    sftp.handle(requestId, buffer);
  };
  const status = (requestId, remote) => {
    if (remote.startsWith("/denied")) { sftp.status(requestId, 3); return false; }
    if (!attrs(remote)) { sftp.status(requestId, 2); return false; }
    return true;
  };
  sftp.on("error", () => {});
  sftp.on("REALPATH", (requestId, remote) => {
    const resolved = normalized(remote);
    if (status(requestId, resolved)) sftp.name(requestId, [{ filename: resolved, longname: resolved, attrs: attrs(resolved) }]);
  });
  for (const event of ["STAT", "LSTAT"]) sftp.on(event, (requestId, remote) => {
    const resolved = normalized(remote);
    if (status(requestId, resolved)) sftp.attrs(requestId, attrs(resolved));
  });
  sftp.on("OPENDIR", (requestId, remote) => {
    const resolved = normalized(remote);
    if (status(requestId, resolved)) handle(requestId, { directory: resolved, read: false });
  });
  sftp.on("READDIR", (requestId, buffer) => {
    const entry = handles.get(buffer.toString("hex"));
    if (!entry) { sftp.status(requestId, 4); return; }
    if (entry.read) { sftp.status(requestId, 1); return; }
    entry.read = true;
    sftp.name(requestId, [...files.keys()].filter((remote) => path.posix.dirname(remote) === entry.directory)
      .map((remote) => ({ filename: path.posix.basename(remote), longname: remote, attrs: attrs(remote) })));
  });
  sftp.on("OPEN", (requestId, remote, flags) => {
    const resolved = normalized(remote);
    if (resolved.startsWith("/denied")) { sftp.status(requestId, 3); return; }
    if (flags & 32 && files.has(resolved)) { sftp.status(requestId, 4); return; }
    if (flags & 8 && !files.has(resolved)) files.set(resolved, Buffer.alloc(0));
    if (!files.has(resolved)) { sftp.status(requestId, 2); return; }
    if (flags & 16) files.set(resolved, Buffer.alloc(0));
    handle(requestId, { path: resolved });
  });
  sftp.on("FSTAT", (requestId, buffer) => {
    const entry = handles.get(buffer.toString("hex"));
    if (!entry) { sftp.status(requestId, 4); return; }
    sftp.attrs(requestId, attrs(entry.path));
  });
  sftp.on("READ", (requestId, buffer, offset, length) => {
    const entry = handles.get(buffer.toString("hex"));
    if (!entry) { sftp.status(requestId, 4); return; }
    const data = files.get(entry.path);
    if (offset >= data.length) sftp.status(requestId, 1);
    else sftp.data(requestId, data.subarray(offset, offset + length));
  });
  sftp.on("WRITE", (requestId, buffer, offset, chunk) => {
    const entry = handles.get(buffer.toString("hex"));
    if (!entry) { sftp.status(requestId, 4); return; }
    const previous = files.get(entry.path);
    const data = Buffer.alloc(Math.max(previous.length, offset + chunk.length));
    previous.copy(data); chunk.copy(data, offset); files.set(entry.path, data);
    sftp.status(requestId, 0);
  });
  sftp.on("CLOSE", (requestId, buffer) => { handles.delete(buffer.toString("hex")); sftp.status(requestId, 0); });
  sftp.on("RENAME", (requestId, source, destination) => {
    if (files.has(destination)) { sftp.status(requestId, 4); return; }
    files.set(destination, files.get(source)); files.delete(source); sftp.status(requestId, 0);
  });
  sftp.on("REMOVE", (requestId, remote) => { files.delete(remote); sftp.status(requestId, 0); });
}

test("HTTP uploads and native downloads stream exact binary bytes on the current SSH connection", { timeout: 20_000 }, async (context) => {
  const setup = await fixture(context);
  const payload = crypto.randomBytes(600 * 1024);
  const remote = "/remote/测试 & binary.bin";
  const upload = await fetch(`${setup.base}?path=${encodeURIComponent(remote)}`, {
    method: "PUT", headers: { ...setup.headers, "Content-Type": "application/octet-stream" }, body: payload,
  });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).size, payload.length);
  assert.deepEqual(setup.files.get(remote), payload);
  const list = await setup.jsonRequest("list", { path: "." });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).entries.some((entry) => entry.path === remote));
  const issued = await setup.jsonRequest("downloads", { path: remote });
  const ticket = (await issued.json()).ticket;
  const download = await fetch(`${setup.base}/downloads/${ticket}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-length"), String(payload.length));
  assert.match(download.headers.get("content-disposition"), /filename\*=UTF-8''%E6/u);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload);
  assert.equal((await fetch(`${setup.base}/downloads/${ticket}`)).status, 403);
  setup.socket.receive({ type: "input", data: "terminal-still-alive\n" });
  await waitUntil(() => setup.socket.messages.some((message) => Buffer.isBuffer(message) && message.includes("terminal-still-alive")));
  assert.equal(setup.shells(), 1);
});

test("canceling a transfer and file errors preserve the PTY and existing destination", { timeout: 20_000 }, async (context) => {
  const setup = await fixture(context);
  const input = new PassThrough();
  const controller = new AbortController();
  const aborted = setup.service.withFiles(setup.ready.fileToken,
    (remote) => remote.upload("/remote/canceled.bin", input), { signal: controller.signal });
  const rejection = assert.rejects(aborted, { statusCode: 499 });
  input.write(Buffer.alloc(64 * 1024, 65));
  await waitUntil(() => [...setup.files.keys()].some((name) => name.includes(".wfl-upload-")));
  controller.abort();
  await rejection;
  assert.ok(!setup.files.has("/remote/canceled.bin"));
  assert.ok(![...setup.files.keys()].some((name) => name.includes(".wfl-upload-")));
  const denied = await setup.jsonRequest("list", { path: "/denied" });
  assert.equal(denied.status, 403);
  const conflict = await fetch(`${setup.base}?path=/remote/original.txt`, {
    method: "PUT", headers: { ...setup.headers, "Content-Type": "application/octet-stream" }, body: "replacement",
  });
  assert.equal(conflict.status, 409);
  assert.equal(setup.files.get("/remote/original.txt").toString(), "keep original");
  const unsupportedReplace = await fetch(`${setup.base}?path=/remote/original.txt&overwrite=true`, {
    method: "PUT", headers: { ...setup.headers, "Content-Type": "application/octet-stream" }, body: "replacement",
  });
  assert.equal(unsupportedReplace.status, 502);
  assert.equal(setup.files.get("/remote/original.txt").toString(), "keep original");
  assert.ok(![...setup.files.keys()].some((name) => name.includes(".wfl-upload-")));
  await setup.service.withFiles(setup.ready.fileToken, (remote) => {
    remote.sftp.ext_openssh_rename = (source, destination, done) => {
      setup.files.set(destination, setup.files.get(source)); setup.files.delete(source); done();
    };
    return remote.upload("/remote/original.txt", Readable.from([Buffer.from("explicit overwrite")]), { overwrite: true });
  });
  assert.equal(setup.files.get("/remote/original.txt").toString(), "explicit overwrite");
  setup.files.set("/remote/large.bin", Buffer.alloc(512 * 1024, 65));
  const issuedDownload = await setup.jsonRequest("downloads", { path: "/remote/large.bin" });
  const downloadTicket = (await issuedDownload.json()).ticket;
  const download = await fetch(`${setup.base}/downloads/${downloadTicket}`);
  assert.equal(download.status, 200);
  await download.body.cancel();
  await waitUntil(() => [...setup.service.sessions][0].files.operations.size === 0);
  assert.equal(setup.socket.readyState, 1, JSON.stringify(setup.socket.messages.filter((message) => !Buffer.isBuffer(message))));
  setup.socket.receive({ type: "input", data: "still-connected\n" });
  await waitUntil(() => Buffer.concat(setup.socket.messages.filter((message) => Buffer.isBuffer(message))).includes("still-connected"));
  assert.equal(setup.shells(), 1);
  assert.deepEqual(setup.serverErrors, []);
});

test("file permissions use the SSH session and revoked access also invalidates issued downloads", { timeout: 10_000 }, async (context) => {
  const setup = await fixture(context);
  const unauthorized = await setup.jsonRequest("list", { path: "." }, { "X-Wfl-Ssh-Session": "wrong-session", Cookie: "admin=pretend" });
  assert.equal(unauthorized.status, 403);
  const crossOrigin = await setup.jsonRequest("list", { path: "." }, { Origin: "https://other.example" });
  assert.equal(crossOrigin.status, 403);
  const issued = await setup.jsonRequest("downloads", { path: "/remote/original.txt" });
  const ticket = (await issued.json()).ticket;
  await setup.service.revokeGrant("admin", setup.grant.grant.id);
  assert.equal((await fetch(`${setup.base}/downloads/${ticket}`)).status, 403);
  assert.equal((await setup.jsonRequest("list", { path: "." })).status, 403);
});

test("canceling a browser download through the gateway stops its upstream transfer and keeps the terminal", { timeout: 10_000 }, async (context) => {
  const setup = await fixture(context);
  setup.files.set("/remote/gateway.bin", Buffer.alloc(512 * 1024, 65));
  const source = await fs.readFile(new URL("../gateway.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("function proxyHttpRequestOnce(");
  const end = source.indexOf("\nfunction endToEndHeaders(", begin);
  assert.ok(begin > 0 && end > begin);
  const proxy = vm.runInNewContext(`(${source.slice(begin, end)})`, {
    http, UPSTREAM_HOST: "127.0.0.1", upstreamAgent: http.globalAgent, endToEndHeaders: (headers) => headers,
  });
  const port = Number(new URL(setup.base).port);
  const server = http.createServer((request, response) => proxy(request, response, { port, path: request.url }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const issued = await setup.jsonRequest("downloads", { path: "/remote/gateway.bin" });
  const ticket = (await issued.json()).ticket;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tools/web-ssh/access/files/downloads/${ticket}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  await response.body.cancel();
  await waitUntil(() => [...setup.service.sessions][0].files.operations.size === 0);
  setup.socket.receive({ type: "input", data: "gateway-cancel-kept-pty\n" });
  await waitUntil(() => Buffer.concat(setup.socket.messages.filter((message) => Buffer.isBuffer(message))).includes("gateway-cancel-kept-pty"));
  assert.equal(setup.shells(), 1);
});
