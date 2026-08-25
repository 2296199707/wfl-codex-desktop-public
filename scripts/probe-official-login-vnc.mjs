#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const execute = promisify(execFile);
const projectDirectory = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const noVncDirectory = path.join(projectDirectory, "node_modules", "@novnc", "novnc");
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "official-login-vnc-probe-"));
const displayNumber = await findDisplayNumber();
const display = `:${displayNumber}`;
const displayEnvironment = { ...process.env, DISPLAY: display };
const vncSocketPath = path.join(temporaryDirectory, "vnc.sock");
const childProcesses = [];
const diagnostics = [];
let webServer = null;
let webSocketServer = null;
let browser = null;
let targetWindow = null;

try {
  const profileDirectory = path.join(temporaryDirectory, "profile");
  const targetPage = path.join(temporaryDirectory, "target.html");
  await fs.mkdir(profileDirectory);
  await fs.writeFile(targetPage, `<!doctype html>
    <meta charset="utf-8">
    <title>VNC-PROBE</title>
    <style>body{margin:0;padding:30px}input{width:600px;height:50px;font:24px sans-serif}</style>
    <input id="probe" autofocus>
    <script>
      probe.addEventListener("focus", () => { document.title = "FOCUSED:" + probe.value; });
      probe.addEventListener("input", () => { document.title = "VALUE:" + probe.value; });
      probe.addEventListener("copy", () => { document.title = "COPIED:" + probe.value; });
    </script>`);

  startChild("/usr/bin/Xvfb", [display, "-screen", "0", "800x600x24", "-ac", "-nolisten", "tcp"]);
  await waitForPath(`/tmp/.X11-unix/X${displayNumber}`);
  startChild(chromium.executablePath(), [
    "--no-sandbox",
    `--user-data-dir=${profileDirectory}`,
    "--window-size=800,600",
    "--window-position=0,0",
    "--no-first-run",
    "--disable-gpu",
    `--app=file://${targetPage}`,
  ], displayEnvironment);
  targetWindow = await waitForWindow("VNC-PROBE|FOCUSED:");
  await execute("/usr/bin/xdotool", ["windowfocus", "--sync", targetWindow], { env: displayEnvironment });

  startChild("/usr/bin/x11vnc", [
    "-display", display,
    "-unixsock", vncSocketPath,
    "-rfbport", "0",
    "-forever",
    "-shared",
    "-nopw",
    "-xkb",
    "-repeat",
    "-ncache", "0",
    "-quiet",
  ], displayEnvironment);
  await waitForPath(vncSocketPath);

  ({ webServer, webSocketServer } = await startNoVncProbeServer(vncSocketPath));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`http://127.0.0.1:${webServer.address().port}`);
  await page.waitForFunction(() => window.vncConnected === true);
  const canvas = page.locator("#screen canvas");
  await canvas.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector("#screen canvas");
    return element && element.width === 800 && element.height === 600;
  });

  await canvas.click({ position: { x: 160, y: 55 } });
  await waitForWindow("FOCUSED:");
  await page.keyboard.type("Abc@123");
  await waitForWindow("VALUE:Abc@123");

  await sendShortcut(page, "a");
  await sendShortcut(page, "c");
  await waitForWindow("COPIED:Abc@123");
  const copied = await page.waitForFunction(() => window.remoteClipboard === "Abc@123", null, { timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  const copiedText = copied ? "Abc@123" : await waitForClipboard("Abc@123");

  await sendShortcut(page, "a");
  await sendText(page, "Paste-42");
  await waitForWindow("VALUE:Paste-42");

  console.log(JSON.stringify({
    ok: true,
    transport: "noVNC 1.7.0 + x11vnc Unix socket",
    pointer: "focused",
    typed: "Abc@123",
    copied: copiedText,
    copyTransport: copied ? "noVNC" : "xclip fallback",
    pasted: "Paste-42",
  }));
} catch (error) {
  const activeTitle = await currentWindowTitle().catch(() => "unavailable");
  console.error(`${error.stack || error}\nRemote window title: ${activeTitle}\n${diagnostics.join("").slice(-8_000)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const client of webSocketServer?.clients || []) client.terminate();
  await closeServer(webSocketServer);
  await closeServer(webServer);
  for (const child of childProcesses.reverse()) child.kill("SIGTERM");
  await delay(250);
  for (const child of childProcesses) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

function startChild(command, arguments_, environment = process.env) {
  const child = spawn(command, arguments_, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => diagnostics.push(`${path.basename(command)}: ${chunk}`));
  childProcesses.push(child);
  return child;
}

async function findDisplayNumber() {
  for (let display = 90; display < 190; display += 1) {
    try {
      await fs.access(`/tmp/.X11-unix/X${display}`);
    } catch {
      return display;
    }
  }
  throw new Error("No free X11 display is available");
}

async function waitForPath(filename, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filename);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

async function waitForWindow(pattern, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execute(
        "/usr/bin/xdotool",
        ["search", "--onlyvisible", "--name", pattern],
        { env: displayEnvironment },
      );
      const window = stdout.trim().split("\n")[0];
      if (window) return window;
    } catch {}
    await delay(50);
  }
  throw new Error(`Timed out waiting for remote window ${pattern}`);
}

async function currentWindowTitle() {
  const { stdout } = await execute("/usr/bin/xdotool", ["getwindowname", targetWindow], { env: displayEnvironment });
  return stdout.trim();
}

async function waitForClipboard(expected, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execute(
        "/usr/bin/xclip",
        ["-selection", "clipboard", "-out"],
        { env: displayEnvironment },
      );
      if (stdout === expected) return stdout;
    } catch {}
    await delay(50);
  }
  throw new Error("Unable to read the remote CLIPBOARD selection through xclip");
}

async function startNoVncProbeServer(socketPath) {
  const html = `<!doctype html>
    <style>html,body,#screen{width:800px;height:600px;margin:0;overflow:hidden}</style>
    <div id="screen"></div>
    <script type="module">
      import RFB from "/core/rfb.js";
      const rfb = new RFB(document.querySelector("#screen"), "ws://" + location.host + "/vnc", { shared: true });
      window.rfb = rfb;
      window.remoteClipboard = "";
      rfb.scaleViewport = true;
      rfb.addEventListener("connect", () => { window.vncConnected = true; rfb.focus(); });
      rfb.addEventListener("clipboard", (event) => { window.remoteClipboard = event.detail.text; });
    </script>`;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
      return;
    }
    const filename = path.resolve(noVncDirectory, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!filename.startsWith(`${noVncDirectory}${path.sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = await fs.readFile(filename);
      response.writeHead(200, { "Content-Type": filename.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      const upstream = net.createConnection(socketPath);
      const close = () => {
        upstream.destroy();
        if (client.readyState < 2) client.close();
      };
      upstream.on("data", (chunk) => {
        if (client.readyState === 1) client.send(chunk, { binary: true });
      });
      upstream.once("error", close);
      upstream.once("close", close);
      client.on("message", (data) => upstream.write(data));
      client.once("close", close);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { webServer: server, webSocketServer: wss };
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function sendShortcut(page, character) {
  return page.evaluate((key) => {
    const keysym = key.codePointAt(0);
    const code = `Key${key.toUpperCase()}`;
    window.rfb.sendKey(0xffe3, "ControlLeft", true);
    window.rfb.sendKey(keysym, code, true);
    window.rfb.sendKey(keysym, code, false);
    window.rfb.sendKey(0xffe3, "ControlLeft", false);
  }, character);
}

function sendText(page, text) {
  return page.evaluate((value) => {
    for (const character of value) window.rfb.sendKey(character.codePointAt(0));
  }, text);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
