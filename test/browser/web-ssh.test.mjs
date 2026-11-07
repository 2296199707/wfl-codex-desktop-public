import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium } from "playwright";
import ssh2 from "ssh2";
import { WebSocketServer } from "ws";
import { WebSshService } from "../../lib/web-ssh.mjs";
import { createWebSshRouters } from "../../lib/web-ssh-http.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("direct links and legacy keys open working phone terminals without website login", { timeout: 30_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-web-ssh-page-"));
  const hostKeys = ssh2.utils.generateKeyPairSync("ed25519");
  const sshClients = new Set();
  const inputs = [];
  const sshServer = new ssh2.Server({ hostKeys: [hostKeys.private] }, (client) => {
    sshClients.add(client);
    client.on("error", () => {});
    client.once("close", () => sshClients.delete(client));
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "test-operator" && context.password === "test-ssh-password") context.accept();
      else context.reject(["password"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty());
      session.on("window-change", (acceptResize) => acceptResize?.());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("WFL local SSH terminal ready\r\n");
        stream.on("data", (data) => {
          inputs.push(data);
          stream.write(data);
          if (data.includes(3)) stream.write("\r\nCTRL-C received\r\n");
        });
      });
    }));
  });
  const service = await new WebSshService(directory).initialize();
  const serverSource = await fs.readFile(path.join(root, "server.mjs"), "utf8");
  const authStart = serverSource.indexOf("function isPublicAuthPath(requestPath)");
  assert.ok(authStart >= 0);
  const publicPathSource = serverSource.slice(authStart, serverSource.indexOf("\nfunction setUserSessionCookie", authStart));
  const isPublicAuthPath = vm.runInNewContext(`(${publicPathSource})`, { RESCUE_MODE: false });
  assert.equal(isPublicAuthPath("/ssh-direct.html"), true);
  assert.equal(vm.runInNewContext(`(${publicPathSource})`, { RESCUE_MODE: true })("/ssh-direct.html"), false);
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  let browser;
  let origin;
  t.after(async () => {
    await browser?.close();
    service.close();
    for (const client of wss.clients) client.terminate();
    for (const client of sshClients) client.end();
    await Promise.all([
      new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
      new Promise((resolve) => sshServer.close(resolve)),
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  app.use(express.json());
  app.use((_request, response, next) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  const routes = createWebSshRouters({
    service,
    requireAdmin: (request) => { if (request.user?.role !== "admin") throw Object.assign(new Error("Admin required"), { statusCode: 403 }); },
    assertOperation: (request, action) => {
      if (request.headers.origin !== origin || request.get("x-codex-desktop-action") !== action) throw Object.assign(new Error("Same origin required"), { statusCode: 403 });
    },
    mutate: (operation) => operation(), persistentServers: async () => [],
  });
  app.use("/api/tools/web-ssh/access", routes.accessRouter);
  app.use((request, response, next) => {
    if (isPublicAuthPath(request.path)) { next(); return; }
    if (request.headers.cookie !== "test-admin=1") { response.status(401).json({ error: "Website login required" }); return; }
    request.user = { id: "test-admin", role: "admin" };
    next();
  });
  app.use("/api/tools/web-ssh", routes.router);
  app.use("/vendor/xterm", express.static(path.join(root, "node_modules/@xterm/xterm")));
  app.use("/vendor/xterm-fit", express.static(path.join(root, "node_modules/@xterm/addon-fit/lib")));
  app.use(express.static(path.join(root, "public")));
  app.use((error, _request, response, _next) => response.status(error.statusCode || 500).json({ error: error.message }));
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ssh/ws" || request.headers.origin !== origin) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (client) => service.accept(client));
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, timeout: 10_000 });
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await adminContext.addCookies([{ name: "test-admin", value: "1", url: origin }]);
  const admin = await adminContext.newPage();
  const errors = [];
  admin.on("pageerror", (error) => errors.push(error.message));
  admin.on("dialog", (dialog) => void dialog.accept());
  await admin.goto(`${origin}/ssh.html`);
  await admin.locator("#serverEditor[open]").waitFor();
  await admin.locator('#targetForm input[name="name"]').fill("Phone terminal");
  await admin.locator('#targetForm input[name="host"]').fill("127.0.0.1");
  await admin.locator('#targetForm input[name="port"]').fill(String(sshServer.address().port));
  await admin.locator('#targetForm input[name="username"]').fill("test-operator");
  await admin.locator('#targetForm input[name="password"]').fill("test-ssh-password");
  await admin.locator("#saveTargetButton").click();
  await admin.waitForFunction(() => document.querySelector("#targetSelect").selectedOptions[0]?.textContent === "Phone terminal");
  await admin.locator('#directGrantForm input[name="name"]').fill("Direct phone");
  assert.equal(await admin.locator('#directGrantForm input[type="password"], #directGrantForm select').count(), 0);
  await admin.locator("#createDirectGrantButton").click();
  await admin.locator("#directGrantResult").waitFor({ state: "visible" });
  const directLink = await admin.locator("#directLink").inputValue();
  const directUrl = new URL(directLink);
  assert.equal(directUrl.origin, origin);
  assert.equal(directUrl.pathname, "/ssh-direct.html");
  assert.match(directUrl.hash, /^#[A-Za-z0-9_-]{64}$/u);
  const directContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const direct = await directContext.newPage();
  const requestedUrls = [];
  directContext.on("request", (request) => requestedUrls.push(request.url()));
  direct.on("pageerror", (error) => errors.push(error.message));
  await direct.goto(directLink);
  await direct.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("已连接 "));
  await direct.waitForFunction(() => document.querySelector("#terminal").textContent.includes("WFL local SSH terminal ready"));
  assert.equal(await direct.locator('input[type="password"], #accessForm').count(), 0);
  assert.equal(await direct.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await direct.locator("#fileControls").isEnabled(), true);
  await direct.locator(".xterm-helper-textarea").focus();
  await direct.keyboard.type("direct-link-input");
  await direct.keyboard.press("Enter");
  await direct.waitForFunction(() => document.querySelector("#terminal").textContent.includes("direct-link-input"));
  await direct.locator('[data-key="ctrl-c"]').click();
  await direct.waitForFunction(() => document.querySelector("#terminal").textContent.includes("CTRL-C received"));
  await direct.reload();
  await direct.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("已连接 "));
  const another = await directContext.newPage();
  await another.goto(directLink);
  await another.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("已连接 "));
  assert.deepEqual(await directContext.cookies(), []);
  assert.equal((await directContext.request.get(`${origin}/api/tools/web-ssh/status`)).status(), 401);
  assert.ok(requestedUrls.every(url => !url.includes(directUrl.hash.slice(1))));
  await admin.reload();
  const directRow = admin.locator(".grant-row").filter({ hasText: "Direct phone" });
  await directRow.getByRole("button", { name: "复制链接", exact: true }).click();
  await admin.locator("#directGrantResult").waitFor({ state: "visible" });
  assert.equal(await admin.locator("#directLink").inputValue(), directLink);
  await directRow.getByRole("button", { name: "撤销", exact: true }).click();
  await direct.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("终端已关闭"));
  await another.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("终端已关闭"));
  await direct.reload();
  await direct.waitForFunction(() => document.querySelector("#pageStatus").textContent.includes("已撤销"));
  await admin.locator(".legacy-access > summary").click();
  await admin.locator('#grantForm input[name="name"]').fill("My phone");
  await admin.locator('#grantForm input[name="accessKey"]').fill("test-phone-access-key");
  await admin.locator('#grantForm select[name="expiresInSeconds"]').selectOption("0");
  await admin.locator("#createGrantButton").click();
  await admin.locator("#grantResult").waitFor({ state: "visible" });
  assert.equal(await admin.locator("#shareLink").inputValue(), `${origin}/ssh-access.html`);
  assert.equal(await admin.locator("#newAccessKey").inputValue(), "test-phone-access-key");
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const guest = await guestContext.newPage();
  guest.on("pageerror", (error) => errors.push(error.message));
  await guest.goto(`${origin}/ssh-access.html`);
  assert.equal((await guestContext.request.get(`${origin}/api/tools/web-ssh/status`)).status(), 401);
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await guest.locator("#accessKeyInput").fill("test-phone-access-key");
  await guest.locator("#connectButton").click();
  await guest.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("已连接 "));
  await guest.waitForFunction(() => document.querySelector("#terminal").textContent.includes("WFL local SSH terminal ready"));
  assert.equal(await guest.locator("#accessKeyInput").inputValue(), "");
  await guest.locator(".xterm-helper-textarea").focus();
  await guest.keyboard.type("browser-input");
  await guest.keyboard.press("Enter");
  await guest.waitForFunction(() => document.querySelector("#terminal").textContent.includes("browser-input"));
  await guest.locator('[data-key="ctrl-c"]').click();
  await guest.waitForFunction(() => document.querySelector("#terminal").textContent.includes("CTRL-C received"));
  assert.ok(Buffer.concat(inputs).includes(Buffer.from("browser-input\r")));
  assert.ok(Buffer.concat(inputs).includes(Buffer.from([3])));
  assert.deepEqual(await guestContext.cookies(), []);
  await admin.locator(".grant-row").filter({ hasText: "My phone" }).getByRole("button", { name: "撤销", exact: true }).click();
  await guest.waitForFunction(() => document.querySelector("#connectionStatus").textContent.startsWith("终端已关闭"));
  assert.deepEqual(errors, []);
});
