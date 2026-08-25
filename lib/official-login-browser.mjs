import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeOfficialProxy,
  openOfficialProxyTunnel,
  publicOfficialProxy,
} from "./official-proxy.mjs";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MIN_VIEWPORT_WIDTH = 360;
const MAX_VIEWPORT_WIDTH = 1280;
const MIN_VIEWPORT_HEIGHT = 560;
const MAX_VIEWPORT_HEIGHT = 900;
const MAX_TEXT_LENGTH = 2_048;
const MAX_STREAM_FRAME_LENGTH = 8 * 1024 * 1024;
const MAX_ENCODER_BUFFER_LENGTH = 16 * 1024 * 1024;
const BROWSER_UID = 65_534;
const BROWSER_GID = 65_534;
const SAFE_KEY_PATTERN = /^(?:Backspace|Tab|Enter|Escape|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)$/;
const SAFE_MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);
const TOP_LEVEL_HOSTS = new Set([
  "auth.openai.com",
  "chatgpt.com",
  "login.openai.com",
  "accounts.openai.com",
  "platform.openai.com",
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
]);
const RESOURCE_DOMAIN_ROOTS = [
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "cloudflare.com",
  "hcaptcha.com",
  "arkoselabs.com",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "googleusercontent.com",
  "apple.com",
  "apple-cloudkit.com",
  "cdn-apple.com",
  "icloud.com",
  "microsoft.com",
  "microsoftonline.com",
  "microsoftonline-p.com",
  "live.com",
  "msauth.net",
  "msftauth.net",
];
const CLAUDE_TOP_LEVEL_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "auth.anthropic.com",
  "console.anthropic.com",
  "accounts.google.com",
]);
const CLAUDE_RESOURCE_DOMAIN_ROOTS = [
  "anthropic.com",
  "claude.ai",
  "claude.com",
  "cloudflare.com",
  "hcaptcha.com",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "googleusercontent.com",
];
const MCP_COMMON_OAUTH_DOMAIN_ROOTS = [
  "accounts.google.com",
  "github.com",
  "githubusercontent.com",
  "login.microsoftonline.com",
  "microsoftonline.com",
  "auth0.com",
  "okta.com",
  "cloudflare.com",
  "hcaptcha.com",
];
const MOCK_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==",
  "base64",
);

export class OfficialLoginBrowserManager extends EventEmitter {
  constructor({
    runtimeDirectory,
    browserType = null,
    browserExecutable = null,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    testMode = false,
    flow = "codex",
  } = {}) {
    super();
    if (!runtimeDirectory) throw new Error("Official login browser runtime directory is required");
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.browserType = browserType;
    this.browserExecutable = browserExecutable;
    this.now = now;
    this.ttlMs = Math.max(60_000, Math.min(DEFAULT_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
    this.testMode = testMode === true;
    if (!["codex", "claude", "mcp"].includes(flow)) throw new Error("Official login browser flow is invalid");
    this.flow = flow;
    this.active = null;
  }

  snapshot(userId) {
    const session = this.sessionFor(userId, false);
    return session ? publicSession(session) : null;
  }

  hasActiveSession() {
    return Boolean(this.active && !this.active.closing);
  }

  async start({ userId, loginId, authUrl, viewport, proxy = null }) {
    if (!userId || !loginId) throw browserError(400, "官方登录浏览器请求无效");
    const validatedAuthUrl = validateAuthUrl(authUrl, this.flow);
    if (this.active) {
      if (this.active.userId === String(userId) && this.active.loginId === String(loginId)) {
        return publicSession(this.active);
      }
      throw browserError(409, "另一个服务器登录窗口正在使用，请稍后再试");
    }

    const session = {
      id: crypto.randomUUID(),
      userId: String(userId),
      loginId: String(loginId),
      viewport: normalizeBrowserViewport(viewport),
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      authUrl: validatedAuthUrl,
      displayHost: new URL(validatedAuthUrl).hostname,
      allowedProxyHosts: this.flow === "mcp" ? mcpAllowedProxyHosts(validatedAuthUrl) : null,
      directory: null,
      display: null,
      xauthorityPath: null,
      displayProcess: null,
      vncProcess: null,
      vncServer: null,
      vncSocketPath: null,
      mockVncEvents: [],
      mockClipboardText: "",
      browserProcess: null,
      encoderProcess: null,
      upstreamProxy: proxy == null ? null : normalizeOfficialProxy(proxy),
      networkProxy: null,
      networkProxyPort: null,
      encoderBuffer: Buffer.alloc(0),
      timer: null,
      queue: Promise.resolve(),
      pendingOperations: 0,
      latestFrame: null,
      frameSequence: 0,
      subscribers: new Set(),
      closing: false,
      mock: this.testMode,
    };
    this.active = session;

    try {
      if (!session.mock) await this.launch(session);
      else {
        await this.startMockVncServer(session);
        this.publishFrame(session, MOCK_JPEG.toString("base64"), session.displayHost);
      }
      session.timer = setTimeout(() => void this.expire(session), this.ttlMs);
      session.timer.unref?.();
      return publicSession(session);
    } catch (error) {
      await this.closeSession(session);
      throw browserError(502, cleanLaunchError(error));
    }
  }

  async frame(userId) {
    const session = this.sessionFor(userId);
    const frame = session.latestFrame || await waitForFrame(session, 8_000);
    return {
      image: Buffer.from(frame.data, "base64"),
      ...publicSession(session),
      host: frame.host,
    };
  }

  subscribe(userId, listener) {
    if (typeof listener !== "function") throw browserError(400, "服务器浏览器流请求无效");
    const session = this.sessionFor(userId);
    session.subscribers.add(listener);
    if (session.latestFrame) listener(session.latestFrame);
    return () => session.subscribers.delete(listener);
  }

  async connectVnc(userId) {
    const session = this.sessionFor(userId);
    if (!session.vncSocketPath) throw browserError(404, "服务器登录窗口尚未准备完成");
    return connectUnixSocket(session.vncSocketPath, 3_000);
  }

  async clipboard(userId) {
    const session = this.sessionFor(userId);
    const text = session.mock ? session.mockClipboardText : await readX11Clipboard(session);
    return { ...publicSession(session), text: String(text || "").slice(0, 8_192) };
  }

  async reopenAuthorization(userId) {
    const session = this.sessionFor(userId);
    try {
      await this.enqueue(session, async () => {
        if (session.mock) return;
        await runXdotool(session, ["key", "--clearmodifiers", "ctrl+l"]);
        await runXdotool(session, ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], session.authUrl);
        await runXdotool(session, ["key", "--clearmodifiers", "Return"]);
      });
      session.displayHost = new URL(session.authUrl).hostname;
      return publicSession(session);
    } catch {
      throw browserError(502, "无法重新打开 Claude 授权页，请重置登录后再试");
    }
  }

  async input(userId, value) {
    const session = this.sessionFor(userId);
    const input = normalizeBrowserInput(value, session.viewport);
    try {
      const result = await this.enqueue(session, async () => {
        if (session.mock) return { editable: input.type === "click", inputMode: input.type === "click" ? "text" : "none" };
        if (input.type === "click") {
          await runXdotool(session, [
            "mousemove", "--sync", String(Math.round(input.x)), String(Math.round(input.y)),
            "click", "--repeat", String(input.clickCount), "--delay", "100", "1",
          ]);
        } else if (input.type === "move") {
          await runXdotool(session, ["mousemove", String(Math.round(input.x)), String(Math.round(input.y))]);
        } else if (input.type === "wheel") {
          await runBrowserWheel(session, input.deltaX, input.deltaY);
        } else if (input.type === "text") {
          await runXdotool(session, ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], input.text);
        } else if (input.type === "key") {
          await runXdotool(session, ["key", "--clearmodifiers", xdotoolKey(input)]);
        }
        return { editable: input.type === "click", inputMode: input.type === "click" ? "text" : "none" };
      });
      return { ...publicSession(session), ...result };
    } catch (error) {
      if (shouldCloseAfterBrowserError(error)) await this.fail(session);
      throw error;
    }
  }

  async close(userId, { loginId = null } = {}) {
    const session = this.sessionFor(userId, false);
    if (!session || (loginId && session.loginId !== String(loginId))) return false;
    await this.closeSession(session);
    return true;
  }

  async closeAll() {
    if (this.active) await this.closeSession(this.active);
  }

  async launch(session) {
    const browserType = this.browserType || (await import("playwright")).chromium;
    const executable = await fs.realpath(this.browserExecutable || browserType.executablePath());
    const executableStat = await fs.stat(executable);
    if (!executableStat.isFile()) throw new Error("服务器 Chromium 不可用");
    await Promise.all([
      fs.access("/usr/bin/bwrap"),
      fs.access("/usr/bin/Xvfb"),
      fs.access("/usr/bin/xauth"),
      fs.access("/usr/bin/x11vnc"),
      fs.access("/usr/bin/xclip"),
      fs.access("/usr/bin/ffmpeg"),
      fs.access("/usr/bin/xdotool"),
    ]);
    const executableName = path.basename(executable);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(executableName)) throw new Error("服务器 Chromium 路径无效");

    const baseDirectory = path.join(this.runtimeDirectory, "official-login-browsers");
    await fs.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(baseDirectory, 0o700);
    const directory = await fs.mkdtemp(path.join(baseDirectory, "session-"));
    session.directory = directory;
    const profileDirectory = path.join(directory, "profile");
    await fs.mkdir(profileDirectory, { mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await this.startNetworkProxy(session);
    await this.startVirtualDisplay(session);
    await this.startVncServer(session);
    const startPage = path.join(profileDirectory, "start.html");
    await fs.writeFile(
      startPage,
      `<!doctype html><meta charset="utf-8"><title>${this.flow === "claude" ? "Claude" : this.flow === "mcp" ? "MCP" : "OpenAI"} OAuth</title><script>location.replace(${JSON.stringify(session.authUrl)})</script>`,
      { mode: 0o600 },
    );

    const bwrapArguments = [
      "--die-with-parent", "--new-session",
      "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--ro-bind", "/tmp/.X11-unix", "/tmp/.X11-unix",
      "--tmpfs", "/opt", "--ro-bind", path.dirname(executable), "/opt/wfl-browser",
      "--bind", directory, directory,
      "--uid", String(BROWSER_UID), "--gid", String(BROWSER_GID),
      "--setenv", "HOME", profileDirectory,
      "--setenv", "TMPDIR", "/tmp",
      "--setenv", "DISPLAY", session.display,
      "--setenv", "XAUTHORITY", session.xauthorityPath,
      "--", `/opt/wfl-browser/${executableName}`,
      "--no-sandbox",
      `--user-data-dir=${profileDirectory}`,
      `--window-size=${session.viewport.width},${session.viewport.height}`,
      "--window-position=0,0",
      "--kiosk",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-infobars",
      "--disable-popup-blocking",
      "--disable-quic",
      "--disable-search-engine-choice-screen",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--no-default-apps",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-service-autorun",
      "--password-store=basic",
      "--use-mock-keychain",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--lang=zh-CN",
      `--proxy-server=http://127.0.0.1:${session.networkProxyPort}`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-features=AutofillServerCommunication,PasswordManagerOnboarding,OptimizationHints",
      pathToFileURL(startPage).href,
    ];
    session.browserProcess = spawn("/usr/bin/bwrap", bwrapArguments, {
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      stdio: "ignore",
    });
    monitorBrowserProcess(this, session, session.browserProcess, "Chromium");
    await waitForRunningProcess(session.browserProcess, 800, "服务器 Chromium 启动失败");
    this.startEncoder(session);
    await waitForFrame(session, 12_000);
    await fs.rm(startPage, { force: true }).catch(() => {});
    session.authUrl = "";
  }

  async startVncServer(session) {
    const socketPath = path.join(session.directory, "vnc.sock");
    // TCP is disabled below; x11vnc's -localhost filter rejects Unix socket peers.
    const process = spawn("/usr/bin/x11vnc", [
      "-display", session.display,
      "-auth", session.xauthorityPath,
      "-unixsock", socketPath,
      "-rfbport", "0",
      "-forever",
      "-shared",
      "-nopw",
      "-xkb",
      "-repeat",
      "-ncache", "0",
      "-cursor", "most",
      "-clip", `${session.viewport.width}x${session.viewport.height}+0+0`,
      "-quiet",
    ], {
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        DISPLAY: session.display,
        XAUTHORITY: session.xauthorityPath,
      },
      stdio: "ignore",
    });
    session.vncProcess = process;
    session.vncSocketPath = socketPath;
    monitorBrowserProcess(this, session, process, "x11vnc");
    await waitForUnixSocket(process, socketPath, 5_000);
    await fs.chmod(socketPath, 0o600);
  }

  async startMockVncServer(session) {
    const baseDirectory = path.join(this.runtimeDirectory, "official-login-browsers");
    await fs.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(baseDirectory, 0o700);
    session.directory = await fs.mkdtemp(path.join(baseDirectory, "mock-session-"));
    const socketPath = path.join(session.directory, "vnc.sock");
    const server = net.createServer((socket) => initializeMockVncClient(session, socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    session.vncServer = server;
    session.vncSocketPath = socketPath;
  }

  async startNetworkProxy(session) {
    const proxy = http.createServer((request, response) => {
      let target;
      try {
        target = new URL(request.url);
      } catch {
        denyProxyRequest(response, 400);
        return;
      }
      if (
        this.flow !== "codex"
        ||
        target.protocol !== "http:"
        || target.hostname !== "localhost"
        || target.port !== "1455"
        || target.pathname !== "/auth/callback"
      ) {
        denyProxyRequest(response, 403);
        return;
      }
      const headers = { ...request.headers, host: "localhost:1455" };
      delete headers["proxy-connection"];
      const upstream = http.request({
        hostname: "127.0.0.1",
        port: 1455,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => denyProxyRequest(response, 502));
      request.pipe(upstream);
    });
    proxy.on("connect", (request, clientSocket, head) => {
      void this.connectNetworkProxy(session, request, clientSocket, head);
    });
    proxy.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") {
      await closeServer(proxy);
      throw new Error("服务器登录网络隔离启动失败");
    }
    session.networkProxy = proxy;
    session.networkProxyPort = address.port;
  }

  async connectNetworkProxy(session, request, clientSocket, head) {
      let target;
      try {
        target = new URL(`https://${request.url}`);
      } catch {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const port = Number(target.port || 443);
      if (port !== 443 || !isAllowedProxyHost(target.hostname, this.flow, session)) {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      let upstream;
      try {
        upstream = session.upstreamProxy
          ? await openOfficialProxyTunnel(session.upstreamProxy, target.hostname, port, {
            allowPrivateProxy: this.testMode,
          })
          : net.connect({ host: target.hostname, port });
      } catch {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
      }
      upstream.setTimeout(30_000);
      clientSocket.setTimeout(30_000);
      const connected = () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      };
      if (session.upstreamProxy) connected();
      else upstream.once("connect", connected);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on("error", close);
      upstream.once("close", close);
      upstream.once("timeout", close);
      clientSocket.on("error", close);
      clientSocket.once("close", close);
      clientSocket.once("timeout", close);
  }

  async startVirtualDisplay(session) {
    const xauthorityPath = path.join(session.directory, "Xauthority");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const displayNumber = 100 + crypto.randomInt(700);
      const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
      if (await pathExists(socketPath)) continue;
      const display = `:${displayNumber}`;
      await fs.writeFile(xauthorityPath, "", { mode: 0o600 });
      await runChildProcess("/usr/bin/xauth", [
        "-f", xauthorityPath, "add", display, ".", crypto.randomBytes(16).toString("hex"),
      ]);
      await fs.chmod(xauthorityPath, 0o644);
      const displayProcess = spawn("/usr/bin/Xvfb", [
        display,
        "-screen", "0", `${session.viewport.width}x${session.viewport.height}x24`,
        "-nolisten", "tcp",
        "-auth", xauthorityPath,
      ], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: "ignore" });
      try {
        await waitForDisplay(displayProcess, socketPath, 3_000);
        session.display = display;
        session.xauthorityPath = xauthorityPath;
        session.displayProcess = displayProcess;
        monitorBrowserProcess(this, session, displayProcess, "Xvfb");
        return;
      } catch {
        await terminateChild(displayProcess);
      }
    }
    throw new Error("服务器虚拟显示启动失败");
  }

  startEncoder(session) {
    const dimensions = `${session.viewport.width}x${session.viewport.height}`;
    const encoder = spawn("/usr/bin/ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "x11grab", "-draw_mouse", "1", "-framerate", "12", "-video_size", dimensions,
      "-i", `${session.display}+0,0`,
      "-an", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "pipe:1",
    ], {
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        DISPLAY: session.display,
        XAUTHORITY: session.xauthorityPath,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    session.encoderProcess = encoder;
    encoder.stdout.on("data", (chunk) => this.consumeEncoderChunk(session, chunk));
    monitorBrowserProcess(this, session, encoder, "ffmpeg");
  }

  consumeEncoderChunk(session, chunk) {
    if (session.closing || this.active !== session) return;
    session.encoderBuffer = Buffer.concat([session.encoderBuffer, chunk]);
    while (session.encoderBuffer.length) {
      const start = session.encoderBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) {
        session.encoderBuffer = session.encoderBuffer.subarray(Math.max(0, session.encoderBuffer.length - 1));
        return;
      }
      if (start > 0) session.encoderBuffer = session.encoderBuffer.subarray(start);
      const end = session.encoderBuffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end === -1) {
        if (session.encoderBuffer.length > MAX_ENCODER_BUFFER_LENGTH) session.encoderBuffer = Buffer.alloc(0);
        return;
      }
      const image = session.encoderBuffer.subarray(0, end + 2);
      session.encoderBuffer = session.encoderBuffer.subarray(end + 2);
      if (image.length <= MAX_STREAM_FRAME_LENGTH) {
        this.publishFrame(session, image.toString("base64"), session.displayHost);
      }
    }
  }

  publishFrame(session, data, host) {
    const frame = {
      type: "frame",
      sequence: ++session.frameSequence,
      data,
      host,
      width: session.viewport.width,
      height: session.viewport.height,
    };
    session.latestFrame = frame;
    for (const listener of session.subscribers) {
      try {
        listener(frame);
      } catch {}
    }
  }

  enqueue(session, operation) {
    if (session.pendingOperations >= 32) throw browserError(429, "服务器浏览器输入过快，请稍后重试");
    session.pendingOperations += 1;
    const task = session.queue.then(() => {
      if (session.closing || this.active !== session) throw browserError(404, "服务器登录窗口已关闭");
      return operation();
    }).finally(() => {
      session.pendingOperations = Math.max(0, session.pendingOperations - 1);
    });
    session.queue = task.catch(() => {});
    return task;
  }

  sessionFor(userId, required = true) {
    const session = this.active;
    if (session && session.userId === String(userId) && !session.closing) return session;
    if (!required) return null;
    if (session) throw browserError(403, "服务器登录窗口属于另一个账号");
    throw browserError(404, "服务器登录窗口已关闭");
  }

  async expire(session) {
    if (this.active !== session || session.closing) return;
    const payload = { userId: session.userId, loginId: session.loginId };
    await this.closeSession(session);
    this.emit("expired", payload);
  }

  async fail(session) {
    if (this.active !== session || session.closing) return;
    const payload = { userId: session.userId, loginId: session.loginId };
    await this.closeSession(session);
    this.emit("failed", payload);
  }

  async closeSession(session) {
    if (!session || session.closing) return;
    session.closing = true;
    clearTimeout(session.timer);
    if (this.active === session) this.active = null;
    for (const listener of session.subscribers) {
      try {
        listener({ type: "closed" });
      } catch {}
    }
    session.subscribers.clear();
    await terminateChild(session.encoderProcess);
    await terminateChild(session.vncProcess);
    await terminateChild(session.browserProcess);
    await terminateChild(session.displayProcess);
    await closeServer(session.vncServer);
    await closeServer(session.networkProxy);
    if (session.directory) await fs.rm(session.directory, { recursive: true, force: true }).catch(() => {});
    session.encoderProcess = null;
    session.vncProcess = null;
    session.vncServer = null;
    session.vncSocketPath = null;
    session.browserProcess = null;
    session.displayProcess = null;
    session.upstreamProxy = null;
    session.networkProxy = null;
    session.networkProxyPort = null;
    session.encoderBuffer = Buffer.alloc(0);
    session.latestFrame = null;
    session.display = null;
    session.xauthorityPath = null;
    session.authUrl = "";
  }
}

export function normalizeBrowserViewport(value) {
  const width = boundedInteger(value?.width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH, 1100);
  const height = boundedInteger(value?.height, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT, 720);
  return { width, height };
}

export function normalizeBrowserInput(value, viewport) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw browserError(400, "服务器浏览器输入无效");
  const type = String(value.type || "");
  if (["click", "move"].includes(type)) {
    const x = boundedCoordinate(value.x, viewport.width);
    const y = boundedCoordinate(value.y, viewport.height);
    const clickCount = type === "click" && value.clickCount === 2 ? 2 : 1;
    return { type, x, y, clickCount };
  }
  if (type === "wheel") {
    return {
      type,
      deltaX: boundedDelta(value.deltaX),
      deltaY: boundedDelta(value.deltaY),
    };
  }
  if (type === "text") {
    const text = typeof value.text === "string" ? value.text : "";
    if (!text || text.length > MAX_TEXT_LENGTH || /[\0]/.test(text)) throw browserError(400, "服务器浏览器文字输入无效");
    return { type, text };
  }
  if (type === "key") {
    const key = String(value.key || "");
    const modifiers = Array.isArray(value.modifiers)
      ? [...new Set(value.modifiers.filter((entry) => SAFE_MODIFIERS.has(entry)))].slice(0, 2)
      : [];
    const modifiedCharacter = /^[A-Za-z0-9]$/.test(key) && modifiers.some((entry) => ["Alt", "Control", "Meta"].includes(entry));
    if (!SAFE_KEY_PATTERN.test(key) && !modifiedCharacter) throw browserError(400, "服务器浏览器按键无效");
    return { type, key, modifiers };
  }
  throw browserError(400, "服务器浏览器输入类型无效");
}

export function isAllowedTopLevelUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (["about:", "data:", "blob:"].includes(url.protocol)) return true;
  if (url.protocol === "http:" && url.hostname === "localhost" && url.port === "1455" && url.pathname === "/auth/callback") {
    return true;
  }
  return url.protocol === "https:" && TOP_LEVEL_HOSTS.has(url.hostname.toLowerCase());
}

export function isAllowedBrowserResourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (["about:", "data:", "blob:"].includes(url.protocol)) return true;
  if (url.protocol === "http:" && url.hostname === "localhost" && url.port === "1455" && url.pathname === "/auth/callback") {
    return true;
  }
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return RESOURCE_DOMAIN_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

function isAllowedProxyHost(hostname, flow = "codex", session = null) {
  const normalized = String(hostname || "").toLowerCase();
  if (flow === "mcp") {
    const roots = session?.allowedProxyHosts;
    return roots instanceof Set && [...roots].some((root) =>
      normalized === root || normalized.endsWith(`.${root}`));
  }
  const roots = flow === "claude"
    ? CLAUDE_RESOURCE_DOMAIN_ROOTS
    : RESOURCE_DOMAIN_ROOTS;
  return roots.some((root) => normalized === root || normalized.endsWith(`.${root}`));
}

function denyProxyRequest(response, statusCode) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  response.end("Blocked");
}

function validateAuthUrl(value, flow = "codex") {
  const url = typeof value === "string" ? value : "";
  if (flow === "mcp") {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw browserError(502, "MCP 返回了无效的 OAuth 地址");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
      || !isPublicBrowserHostname(hostname)
    ) {
      throw browserError(502, "MCP OAuth 地址必须是公开的 HTTPS 地址");
    }
    return parsed.toString();
  }
  if (flow === "claude") {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw browserError(502, "Claude 返回了不受信任的官方登录地址");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !CLAUDE_TOP_LEVEL_HOSTS.has(hostname)) {
      throw browserError(502, "Claude 返回了不受信任的官方登录地址");
    }
    return parsed.toString();
  }
  if (!isAllowedTopLevelUrl(url)) throw browserError(502, "Codex 返回了不受信任的官方登录地址");
  const parsed = new URL(url);
  if (!["auth.openai.com", "chatgpt.com"].includes(parsed.hostname.toLowerCase())) {
    throw browserError(502, "Codex 返回了不受信任的官方登录地址");
  }
  return parsed.toString();
}

function mcpAllowedProxyHosts(authUrl) {
  const hostname = new URL(authUrl).hostname.toLowerCase();
  const roots = new Set(MCP_COMMON_OAUTH_DOMAIN_ROOTS);
  roots.add(hostname);
  const labels = hostname.split(".");
  if (labels.length >= 2) roots.add(labels.slice(-2).join("."));
  return roots;
}

function isPublicBrowserHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized.endsWith(".local") || normalized.endsWith(".internal")
    || !normalized.includes(".")) return false;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;
    return first !== 10
      && !(first === 172 && second >= 16 && second <= 31)
      && !(first === 192 && second === 168)
      && first !== 127
      && !(first === 169 && second === 254)
      && first !== 0;
  }
  if (ipVersion === 6) {
    return !normalized.startsWith("::1")
      && !normalized.startsWith("fc")
      && !normalized.startsWith("fd")
      && !normalized.startsWith("fe8")
      && !normalized.startsWith("fe9")
      && !normalized.startsWith("fea")
      && !normalized.startsWith("feb");
  }
  return true;
}

function publicSession(session) {
  return {
    active: true,
    transport: "vnc",
    host: session.displayHost,
    expiresAt: session.expiresAt,
    viewport: { ...session.viewport },
    proxy: session.upstreamProxy ? publicOfficialProxy(session.upstreamProxy) : null,
  };
}

function connectUnixSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(reject, new Error("服务器登录画面连接超时"));
    }, timeoutMs);
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", onError);
      socket.removeListener("connect", onConnect);
      operation(value);
    };
    const onError = (error) => finish(reject, error);
    const onConnect = () => {
      socket.on("error", ignoreSocketError);
      finish(resolve, socket);
    };
    const ignoreSocketError = () => {};
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

async function waitForUnixSocket(process, socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) throw new Error("x11vnc stopped");
    try {
      const socket = await connectUnixSocket(socketPath, Math.min(500, Math.max(1, deadline - Date.now())));
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError || new Error("x11vnc timed out");
}

function initializeMockVncClient(session, socket) {
  let buffer = Buffer.alloc(0);
  let phase = "version";
  let text = session.mockClipboardText;
  let clientClipboard = "";
  let controlDown = false;
  socket.write("RFB 003.008\n");
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      if (phase === "version") {
        if (buffer.length < 12) return;
        buffer = buffer.subarray(12);
        socket.write(Buffer.from([1, 1]));
        phase = "security";
        continue;
      }
      if (phase === "security") {
        if (buffer.length < 1) return;
        buffer = buffer.subarray(1);
        socket.write(Buffer.alloc(4));
        phase = "client-init";
        continue;
      }
      if (phase === "client-init") {
        if (buffer.length < 1) return;
        buffer = buffer.subarray(1);
        socket.write(mockVncServerInit(session.viewport));
        phase = "messages";
        continue;
      }
      const type = buffer[0];
      let length;
      if (type === 0) length = 20;
      else if (type === 2) {
        if (buffer.length < 4) return;
        length = 4 + buffer.readUInt16BE(2) * 4;
      } else if (type === 3) length = 10;
      else if (type === 4) length = 8;
      else if (type === 5) length = 6;
      else if (type === 6) {
        if (buffer.length < 8) return;
        length = 8 + buffer.readUInt32BE(4);
      } else {
        socket.destroy(new Error(`Unsupported mock RFB message ${type}`));
        return;
      }
      if (buffer.length < length) return;
      const message = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      if (type === 3) socket.write(mockVncFramebuffer());
      if (type === 4) {
        const down = message[1] === 1;
        const keysym = message.readUInt32BE(4);
        session.mockVncEvents.push({ type: "key", down, keysym });
        if ([0xffe3, 0xffe4].includes(keysym)) {
          controlDown = down;
          continue;
        }
        if (!down) continue;
        if (controlDown && [0x63, 0x78].includes(keysym)) {
          session.mockClipboardText = text;
          socket.write(mockVncClipboard(text));
          continue;
        }
        if (controlDown && keysym === 0x76) {
          text += clientClipboard;
          session.mockClipboardText = text;
          socket.write(mockVncClipboard(text));
          continue;
        }
        if (keysym === 0xff08) text = [...text].slice(0, -1).join("");
        else if (keysym === 0xff09) text += "\t";
        else if (keysym === 0xff0d) text += "\n";
        else {
          const unicodeKeysym = keysym >= 0x01000000;
          const codePoint = unicodeKeysym ? keysym & 0x00ffffff : keysym;
          if ((unicodeKeysym && codePoint <= 0x10ffff) || (codePoint >= 0x20 && codePoint <= 0xff)) {
            text += String.fromCodePoint(codePoint);
          }
        }
        session.mockClipboardText = text;
        socket.write(mockVncClipboard(text));
      }
      if (type === 5) session.mockVncEvents.push({ type: "pointer", buttons: message[1] });
      if (type === 6) {
        clientClipboard = message.subarray(8).toString("utf8");
        session.mockVncEvents.push({ type: "clipboard", text: clientClipboard });
      }
    }
  });
  socket.on("error", () => {});
}

function mockVncServerInit(viewport) {
  const name = Buffer.from("WFL OAuth test browser", "utf8");
  const payload = Buffer.alloc(24 + name.length);
  payload.writeUInt16BE(viewport.width, 0);
  payload.writeUInt16BE(viewport.height, 2);
  payload[4] = 32;
  payload[5] = 24;
  payload[7] = 1;
  payload.writeUInt16BE(255, 8);
  payload.writeUInt16BE(255, 10);
  payload.writeUInt16BE(255, 12);
  payload[14] = 16;
  payload[15] = 8;
  payload.writeUInt32BE(name.length, 20);
  name.copy(payload, 24);
  return payload;
}

function mockVncFramebuffer() {
  const width = 32;
  const height = 32;
  const payload = Buffer.alloc(4 + 12 + width * height * 4);
  payload.writeUInt16BE(1, 2);
  payload.writeUInt16BE(width, 8);
  payload.writeUInt16BE(height, 10);
  for (let offset = 16; offset < payload.length; offset += 4) {
    payload[offset] = 0x28;
    payload[offset + 1] = 0x8a;
    payload[offset + 2] = 0x2f;
  }
  return payload;
}

function mockVncClipboard(text) {
  const value = Buffer.from(text, "utf8");
  const payload = Buffer.alloc(8 + value.length);
  payload[0] = 3;
  payload.writeUInt32BE(value.length, 4);
  value.copy(payload, 8);
  return payload;
}

function waitForFrame(session, timeoutMs) {
  if (session.latestFrame) return Promise.resolve(session.latestFrame);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.subscribers.delete(listener);
      reject(browserError(502, "服务器登录画面连接超时"));
    }, timeoutMs);
    const listener = (payload) => {
      if (payload?.type === "frame") {
        clearTimeout(timer);
        session.subscribers.delete(listener);
        resolve(payload);
      } else if (payload?.type === "closed") {
        clearTimeout(timer);
        session.subscribers.delete(listener);
        reject(browserError(404, "服务器登录窗口已关闭"));
      }
    };
    session.subscribers.add(listener);
  });
}

async function runBrowserWheel(session, deltaX, deltaY) {
  const operations = [];
  const verticalRepeats = Math.min(12, Math.max(0, Math.ceil(Math.abs(deltaY) / 100)));
  const horizontalRepeats = Math.min(12, Math.max(0, Math.ceil(Math.abs(deltaX) / 100)));
  if (verticalRepeats) {
    operations.push(runXdotool(session, [
      "click", "--repeat", String(verticalRepeats), "--delay", "12", deltaY < 0 ? "4" : "5",
    ]));
  }
  if (horizontalRepeats) {
    operations.push(runXdotool(session, [
      "click", "--repeat", String(horizontalRepeats), "--delay", "12", deltaX < 0 ? "6" : "7",
    ]));
  }
  await Promise.all(operations);
}

function xdotoolKey(input) {
  const keyNames = {
    Backspace: "BackSpace",
    Tab: "Tab",
    Enter: "Return",
    Escape: "Escape",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "Page_Up",
    PageDown: "Page_Down",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Space: "space",
  };
  const modifierNames = { Alt: "alt", Control: "ctrl", Meta: "super", Shift: "shift" };
  return [...input.modifiers.map((entry) => modifierNames[entry]), keyNames[input.key] || input.key].join("+");
}

function runXdotool(session, args, input = null) {
  if (!session.display || !session.xauthorityPath) throw browserError(404, "服务器登录窗口已关闭");
  return runChildProcess("/usr/bin/xdotool", args, {
    input,
    timeoutMs: 5_000,
    environment: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      DISPLAY: session.display,
      XAUTHORITY: session.xauthorityPath,
    },
  });
}

async function readX11Clipboard(session) {
  if (!session.display || !session.xauthorityPath) throw browserError(404, "服务器登录窗口已关闭");
  const options = {
    timeoutMs: 2_000,
    captureOutput: true,
    maxOutputLength: 8_192,
    environment: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      DISPLAY: session.display,
      XAUTHORITY: session.xauthorityPath,
    },
  };
  for (const target of ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING"]) {
    try {
      return await runChildProcess(
        "/usr/bin/xclip",
        ["-selection", "clipboard", "-out", "-target", target],
        options,
      );
    } catch {
      // Chromium pages expose different X11 text targets; try each bounded text representation.
    }
  }
  throw browserError(409, "服务器剪贴板没有可读取的文字，请先在 Claude 授权页复制授权码");
}

function runChildProcess(command, args, {
  input = null,
  timeoutMs = 5_000,
  environment = null,
  captureOutput = false,
  maxOutputLength = 8_192,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment || { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      stdio: [input === null ? "ignore" : "pipe", captureOutput ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxOutputLength) stdout += chunk.toString("utf8").slice(0, maxOutputLength - stdout.length);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2_048) stderr += chunk.toString("utf8").slice(0, 2_048 - stderr.length);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(captureOutput ? stdout : undefined);
      else reject(new Error(`${path.basename(command)} exited (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    if (input !== null) child.stdin.end(input);
  });
}

function monitorBrowserProcess(manager, session, child, name) {
  let reported = false;
  const report = (detail) => {
    if (reported || session.closing || manager.active !== session) return;
    reported = true;
    console.error(`Official login browser ${name} stopped${detail ? ` (${detail})` : ""}`);
    void manager.fail(session);
  };
  child.once("error", (error) => report(error.message));
  child.once("exit", (code, signal) => report(String(code ?? signal ?? "unknown")));
}

function waitForRunningProcess(child, waitMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("error", fail);
      child.off("exit", fail);
      resolve();
    }, waitMs);
    child.once("error", fail);
    child.once("exit", fail);
  });
}

async function waitForDisplay(child, socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Xvfb stopped");
    if (await pathExists(socketPath)) return;
    await delay(50);
  }
  throw new Error("Xvfb timed out");
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => { timer = setTimeout(resolve, 1_500); }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(minimum, Math.min(maximum, number)));
}

function boundedCoordinate(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw browserError(400, "服务器浏览器坐标无效");
  return Math.max(0, Math.min(maximum, number));
}

function boundedDelta(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(-2_000, Math.min(2_000, number)));
}

function cleanLaunchError(error) {
  const message = String(error?.message || "");
  if (/服务器 Chromium 不可用|executable.*(?:not|missing)/i.test(message)) {
    return "服务器 Chromium 尚未安装，请重新运行服务器安装检查";
  }
  if (/xvfb|xauth|x11vnc|xclip|bwrap|ffmpeg|xdotool/i.test(message)) return "服务器登录浏览器隔离依赖不完整，请重新运行服务器安装检查";
  return "服务器登录浏览器启动失败";
}

function shouldCloseAfterBrowserError(error) {
  return ![400, 403, 404, 429].includes(error?.statusCode);
}

function browserError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
