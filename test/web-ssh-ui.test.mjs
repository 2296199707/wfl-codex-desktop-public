import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function accessPage(fetch, { mode = "access", href = "https://wfl.example/ssh-access.html" } = {}) {
  const elements = new Map();
  class Element {
    constructor() { this.handlers = new Map(); this.dataset = {}; this.value = "test-access-key"; this.clientWidth = 800; this.children = []; }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    scrollIntoView() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    click() { this.clicked = true; this.handlers.get("click")?.(); }
    remove() { this.removed = true; }
  }
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  class Terminal {
    constructor() { this.cols = 100; this.rows = 35; this.output = []; }
    loadAddon() {}
    open() {}
    writeln() {}
    onData() {}
    onResize() {}
    reset() {}
    focus() {}
    write(data, callback) { this.output.push(data); callback?.(); }
  }
  const sockets = [];
  const timers = new Map();
  let timerId = 0;
  const created = [];
  const body = new Element();
  body.dataset.mode = mode;
  class Socket extends Element {
    static OPEN = 1;
    static CLOSING = 2;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close(code = 1000) { this.readyState = 3; this.handlers.get("close")?.({ code }); }
    open() { this.readyState = 1; this.handlers.get("open")?.(); }
    message(data) { this.handlers.get("message")?.({ data }); }
  }
  const context = vm.createContext({
    window: { Terminal, FitAddon: { FitAddon: class { fit() {} } }, addEventListener() {} },
    document: { body, getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: (tag) => { const node = new Element(); node.tag = tag; created.push(node); return node; } },
    ResizeObserver: class { observe() {} },
    WebSocket: Socket, URL, Uint8Array, fetch, AbortSignal,
    setTimeout: (operation, delay) => { const id = ++timerId; timers.set(id, { operation, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    location: { href, protocol: "https:" }, navigator: { clipboard: {} },
  });
  const source = await fs.readFile(new URL("../public/web-ssh.js", import.meta.url), "utf8");
  const page = await new vm.Script(`(async () => { ${source}\nreturn { state, terminal, connect, disconnect, sendInput, loadFiles, downloadFile }; })()`).runInContext(context);
  return { ...page, element, sockets, timers, created };
}

const response = () => ({ ok: true, status: 200, json: async () => ({ ticket: "test-ticket", target: { name: "Test server", host: "server.example.com", port: 2222, username: "operator" } }) });

test("a direct link connects automatically and reconnects without a password or putting its credential in request URLs", async () => {
  const accessKey = "A".repeat(64);
  const requests = [];
  const page = await accessPage(async (url, options) => { requests.push({ url, options }); return response(); }, {
    mode: "direct", href: `https://wfl.example/ssh-direct.html#${accessKey}`,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/tools/web-ssh/access/links/sessions");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(requests[0].options.body), { accessKey });
  assert.equal(page.sockets[0].url.href, "wss://wfl.example/ssh/ws");
  page.sockets[0].open();
  page.sockets[0].message(JSON.stringify({ type: "ready" }));
  page.sendInput("echo direct-link\n");
  assert.deepEqual(page.sockets[0].sent.at(-1), { type: "input", data: "echo direct-link\n" });
  page.disconnect();
  await page.connect();
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].options.body), { accessKey });
  assert.ok(requests.every(request => !request.url.includes(accessKey)));
  page.disconnect();
  const invalid = await accessPage(() => assert.fail("Incomplete link must not attempt a connection"), { mode: "direct", href: "https://wfl.example/ssh-direct.html" });
  assert.equal(invalid.sockets.length, 0);
  assert.equal(invalid.element("connectButton").disabled, true);
});

test("canceling a pending access-key login does not open a late terminal socket", async () => {
  let resolve;
  let calls = 0;
  const page = await accessPage(() => { calls += 1; return new Promise((done) => { resolve = done; }); });
  const pending = page.connect();
  assert.equal(page.state.busy, true);
  await page.connect();
  assert.equal(calls, 1);
  page.disconnect();
  resolve(response());
  await pending;
  assert.equal(page.sockets.length, 0);
  assert.equal(page.state.busy, false);
  assert.equal(page.element("connectButton").disabled, false);
});

test("access page sends only the access key without cookies and preserves terminal input across chunk boundaries", async () => {
  const requests = [];
  const page = await accessPage(async (url, options) => { requests.push({ url, options }); return response(); });
  await page.connect();
  assert.equal(requests[0].url, "/api/tools/web-ssh/access/sessions");
  assert.equal(requests[0].options.credentials, "omit");
  assert.deepEqual(JSON.parse(requests[0].options.body), { accessKey: "test-access-key" });
  assert.equal(page.element("accessKeyInput").value, "");
  const socket = page.sockets[0];
  assert.equal(socket.url.href, "wss://wfl.example/ssh/ws");
  socket.open();
  assert.equal(socket.sent[0].type, "authenticate");
  assert.equal(socket.sent[0].ticket, "test-ticket");
  socket.message(JSON.stringify({ type: "ready" }));
  const command = `${"a".repeat(7999)}😀\n\x03`;
  page.sendInput(command);
  const chunks = socket.sent.filter((message) => message.type === "input").map((message) => message.data);
  assert.equal(chunks.join(""), command);
  assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(), command);
  socket.message(new Uint8Array([65, 66]).buffer);
  assert.deepEqual(socket.sent.at(-1), { type: "ack", bytes: 2 });
  const messageCount = socket.sent.length;
  page.disconnect();
  page.sendInput("must-not-replay");
  assert.equal(socket.sent.length, messageCount + 1);
  assert.deepEqual(socket.sent.at(-1), { type: "disconnect" });
  assert.equal(page.state.socket, null);
});

test("automatic reconnection uses a resume token and stops on explicit disconnect or expired authorization", async () => {
  let calls = 0;
  const page = await accessPage(async () => { calls += 1; return response(); });
  await page.connect();
  const first = page.sockets[0];
  first.open();
  first.message(JSON.stringify({ type: "ready", resumeToken: "original-resume-token", fileToken: "file-token" }));
  first.close(1006);
  page.sendInput("must-not-send-while-offline");
  assert.equal(first.sent.filter((message) => message.type === "input").length, 0);
  const reconnect = page.timers.get(page.state.reconnectTimer);
  assert.equal(reconnect.delay, 1000);
  reconnect.operation();
  const second = page.sockets[1];
  second.open();
  assert.deepEqual(second.sent[0], { type: "resume", resumeToken: "original-resume-token", cols: 100, rows: 35 });
  assert.equal(calls, 1);
  second.message(JSON.stringify({ type: "ready", resumed: true, resumeToken: "original-resume-token", fileToken: "file-token" }));
  assert.equal(page.state.ready, true);
  page.disconnect();
  assert.equal(page.state.resumeToken, "");
  assert.equal(page.state.reconnectTimer, null);
  assert.deepEqual(second.sent.at(-1), { type: "disconnect" });
  await page.connect();
  const third = page.sockets[2];
  third.open();
  third.message(JSON.stringify({ type: "ready", resumeToken: "expired-token" }));
  third.close(1006);
  page.timers.get(page.state.reconnectTimer).operation();
  const fourth = page.sockets[3];
  fourth.open();
  fourth.message(JSON.stringify({ type: "error", statusCode: 403, message: "原终端已结束" }));
  fourth.close(1008);
  assert.equal(page.state.resumeToken, "");
  assert.equal(page.state.reconnectTimer, null);
});

test("file panel uses the current SSH capability and native downloads without exposing the session token in URLs", async () => {
  const requests = [];
  const page = await accessPage(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/files/list")) return { ok: true, json: async () => ({
      path: "/remote", parent: "/", entries: [{ name: "<img onerror=alert(1)>.txt", path: "/remote/sample.txt", kind: "file", size: 1024 }],
    }) };
    if (url.endsWith("/files/downloads")) return { ok: true, json: async () => ({ ticket: "single-use-download", name: "sample.txt" }) };
    return response();
  });
  await page.connect();
  const socket = page.sockets[0];
  socket.open();
  socket.message(JSON.stringify({ type: "ready", fileToken: "current-ssh-session", resumeToken: "resume-token" }));
  await page.loadFiles(".");
  const listRequest = requests.at(-1);
  assert.equal(listRequest.options.credentials, "omit");
  assert.equal(listRequest.options.headers["X-Wfl-Ssh-Session"], "current-ssh-session");
  assert.deepEqual(JSON.parse(listRequest.options.body), { path: "." });
  assert.equal(page.element("remoteDirectory").value, "/remote");
  assert.equal(page.element("remoteFiles").children[0].children[0].textContent, "<img onerror=alert(1)>.txt");
  await page.downloadFile("/remote/sample.txt");
  const link = page.created.find((node) => node.tag === "a");
  assert.equal(link.href, "/api/tools/web-ssh/access/files/downloads/single-use-download");
  assert.equal(link.download, "sample.txt");
  assert.equal(link.clicked, true);
  assert.ok(requests.every(({ url }) => !url.includes("current-ssh-session")));
  assert.equal(socket.readyState, 1);
  page.disconnect();
});
