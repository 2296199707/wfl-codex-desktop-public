import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { mimeTypeForFile } from "./preview-tools.mjs";

const SESSION_PATTERN = /^[a-f0-9]{24}$/u;
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PREVIEW_PORT = Number(process.env.WFL_MOBILE_APP_PREVIEW_PORT || 8788);
const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PREVIEW_RETENTION_COUNT = 8;

export const MOBILE_PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

export const MOBILE_PREVIEW_TOOLS = Object.freeze([
  "mobile_preview_start",
  "mobile_preview_status",
  "mobile_preview_restart",
  "mobile_preview_logs",
  "mobile_preview_screenshot",
  "mobile_preview_click",
  "mobile_preview_type",
  "mobile_preview_scroll",
]);

export class MobileAppPreviewManager {
  constructor({ stateDirectory, sourceDirectory, configStore, validatePreview = null } = {}) {
    this.statePath = path.join(path.resolve(stateDirectory), "mobile-app-preview.json");
    this.sourceDirectory = path.resolve(sourceDirectory);
    this.configStore = configStore;
    this.validatePreview = validatePreview;
    this.record = idleRecord();
    this.expiryTimer = null;
    this.validationPromise = null;
  }

  async initialize() {
    try {
      const value = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      const restorableStatic = value?.deliveryMode === "static"
        && isMobilePreviewAccessKey(value.accessKey)
        && value.url === mobilePreviewUrl(value.sessionId, value.accessKey);
      if (value?.sessionId && (restorableStatic || (value.deliveryMode !== "static" && isAlive(value.pid)))) {
        this.record = normalizeRecord(value);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    this.expiryTimer = setInterval(() => {
      if (this.record.expiresAt && this.record.expiresAt <= Date.now()) void this.stop(this.record.sessionId);
    }, 30_000);
    this.expiryTimer.unref?.();
    return this;
  }

  async snapshot() {
    if (["starting", "running"].includes(this.record.status) && this.record.expiresAt && this.record.expiresAt <= Date.now()) {
      return this.stop(this.record.sessionId);
    }
    if (this.record.deliveryMode === "static") {
      const built = await staticPreviewBuilt(this.record);
      if (this.record.status === "starting" && built) {
        await this.validateStaticPreview();
      } else if (this.record.status === "starting" && !isAlive(this.record.pid)) {
        this.record = { ...this.record, status: "failed", detail: "预览构建失败", error: "Flutter Web 静态构建未完成", completedAt: Date.now() };
        await this.write();
      } else if (this.record.status === "running" && !built) {
        this.record = { ...this.record, status: "failed", detail: "预览文件不可用", error: "Flutter Web 静态构建文件已丢失", completedAt: Date.now() };
        await this.write();
      }
    } else {
      if (this.record.status === "starting" && isAlive(this.record.pid) && await legacyPreviewIsReady(this.record)) {
        this.record = { ...this.record, status: "running", detail: "Flutter Web 预览已就绪" };
        await this.write();
      }
      if (this.record.status === "starting" && !isAlive(this.record.pid)) {
        this.record = { ...this.record, status: "failed", detail: "预览启动失败", error: "Flutter Web Server 已停止", completedAt: Date.now() };
        await this.write();
      }
      if (this.record.status === "running" && !isAlive(this.record.pid)) {
        this.record = { ...this.record, status: "failed", detail: "预览进程已退出", error: "Flutter Web Server 已停止", completedAt: Date.now() };
        await this.write();
      }
    }
    return structuredClone(this.record);
  }

  async start() {
    const current = await this.snapshot();
    if (["starting", "running"].includes(current.status) && current.deliveryMode === "static") return current;
    if (["starting", "running"].includes(current.status)) await this.stop(current.sessionId);
    return this.launchBuild();
  }

  async launchBuild({ reuse = null } = {}) {
    const config = this.configStore.snapshot();
    const layout = await this.configStore.ensureLayout();
    const sessionId = reuse?.sessionId || crypto.randomBytes(12).toString("hex");
    const accessKey = reuse?.accessKey || crypto.randomBytes(32).toString("base64url");
    const buildId = crypto.randomBytes(8).toString("hex");
    const previewDirectory = reuse?.previewDirectory || path.join(layout.previews, sessionId);
    const buildWorkspace = path.join(layout.root, "preview-workspace");
    const logPath = reuse?.logPath || path.join(layout.logs, `preview-${sessionId}.log`);
    const script = path.join(this.sourceDirectory, "scripts", "preview-mobile-app.sh");
    await cleanupMobilePreviewArtifacts(layout, sessionId);
    await fs.mkdir(previewDirectory, { recursive: true, mode: 0o750 });
    await fs.rm(path.join(previewDirectory, ".wfl-preview-ready"), { force: true });
    const log = await fs.open(logPath, "a", 0o640);
    const child = spawn("bash", [
      script,
      "--session", sessionId,
      "--access-key", accessKey,
      "--build-id", buildId,
      "--project", config.projectPath,
      "--preview-root", previewDirectory,
      "--workspace", buildWorkspace,
      "--storage-root", layout.root,
    ], {
      cwd: this.sourceDirectory,
      detached: true,
      env: {
        ...process.env,
        FLUTTER_BIN: config.flutterBin || process.env.FLUTTER_BIN || path.join(layout.flutterSdk, "bin", "flutter"),
        PUB_CACHE: layout.pubCache,
        WFL_MOBILE_APP_PREVIEW_ROOT: previewDirectory,
      },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();
    this.record = {
      sessionId,
      accessKey,
      buildId,
      pid: child.pid,
      port: null,
      status: "starting",
      url: mobilePreviewUrl(sessionId, accessKey),
      projectPath: config.projectPath,
      previewDirectory,
      buildWorkspace,
      webDirectory: path.join(previewDirectory, "build", "web"),
      readyMarkerPath: path.join(previewDirectory, ".wfl-preview-ready"),
      deliveryMode: "static",
      logPath,
      startedAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1_000,
      completedAt: null,
      detail: "正在构建 Flutter Web 静态预览",
      error: null,
    };
    await this.write();
    return this.record;
  }

  async restart() {
    const current = await this.snapshot();
    if (current.deliveryMode === "static" && current.sessionId && current.accessKey) {
      terminateProcess(current.pid);
      return this.launchBuild({ reuse: current });
    }
    if (current.sessionId && ["starting", "running"].includes(current.status)) await this.stop(current.sessionId);
    return this.start();
  }

  async logs() {
    const current = await this.snapshot();
    if (!current.logPath) return { sessionId: current.sessionId, status: current.status, log: "" };
    const content = await fs.readFile(current.logPath, "utf8").catch(() => "");
    return {
      sessionId: current.sessionId,
      status: current.status,
      detail: current.detail,
      error: current.error,
      log: content.slice(-16_000),
    };
  }

  async stop(sessionId = null) {
    if (!sessionId || sessionId !== this.record.sessionId || this.record.status === "stopped") return this.snapshot();
    if (isAlive(this.record.pid)) {
      try { process.kill(-this.record.pid, "SIGTERM"); } catch { try { process.kill(this.record.pid, "SIGTERM"); } catch {} }
    }
    const previewDirectory = this.record.previewDirectory;
    this.record = { ...this.record, status: "stopped", detail: "预览已停止", completedAt: Date.now() };
    await this.write();
    if (previewDirectory) await fs.rm(previewDirectory, { recursive: true, force: true }).catch(() => {});
    return this.record;
  }

  async proxy(request, response, sessionId, accessKey = null, requestPath = "/") {
    if (this.record.deliveryMode === "static") {
      await this.serveStatic(response, sessionId, accessKey, requestPath);
      return;
    }
    const record = await this.snapshot();
    if (record.sessionId !== sessionId || !["starting", "running"].includes(record.status)) {
      response.status(404).type("text/plain").send("Mobile preview is not running");
      return;
    }
    const previewBasePath = `/tools/mobile-preview/${sessionId}`;
    const relativePath = requestPath === "/" ? "/" : `/${requestPath.replace(/^\/+/, "")}`;
    const targetPath = `${previewBasePath}${relativePath}`;
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: record.port,
      method: request.method,
      path: `${targetPath}${request.url.includes("?") ? `?${request.url.split("?").slice(1).join("?")}` : ""}`,
      headers: { ...request.headers, host: `127.0.0.1:${record.port}` },
    }, (upstreamResponse) => {
      response.status(upstreamResponse.statusCode || 502);
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !["connection", "transfer-encoding"].includes(name.toLowerCase())) response.setHeader(name, value);
      }
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent) response.status(502).type("text/plain").send("Mobile preview is starting");
      else response.end();
    });
    request.pipe(upstream);
  }

  async serveStatic(response, sessionId, accessKey, requestPath = "/") {
    const record = this.record;
    if (!this.acceptsAccessKey(sessionId, accessKey) || !["starting", "running"].includes(record.status)) {
      response.status(404).type("text/plain").send("Mobile preview is not running");
      return;
    }
    const target = await resolveMobilePreviewAsset(record.webDirectory, requestPath);
    if (!target) {
      response.status(404).type("text/plain").send("Mobile preview asset not found");
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Content-Security-Policy", MOBILE_PREVIEW_CSP);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.type(mimeTypeForFile(target));
    await new Promise((resolve, reject) => {
      response.sendFile(target, {
        acceptRanges: false,
        cacheControl: false,
        lastModified: false,
      }, (error) => error ? reject(error) : resolve());
    });
  }

  acceptsAccessKey(sessionId, value) {
    if (sessionId !== this.record.sessionId || !isMobilePreviewAccessKey(value) || !isMobilePreviewAccessKey(this.record.accessKey)) return false;
    const supplied = Buffer.from(String(value));
    const expected = Buffer.from(this.record.accessKey);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  async validateStaticPreview() {
    const sessionId = this.record.sessionId;
    const buildId = this.record.buildId;
    if (this.validationPromise?.sessionId === sessionId && this.validationPromise?.buildId === buildId) {
      await this.validationPromise.promise;
      return;
    }
    const record = structuredClone(this.record);
    const promise = this.performStaticValidation(record);
    this.validationPromise = { sessionId, buildId, promise };
    try {
      await promise;
    } finally {
      if (this.validationPromise?.promise === promise) this.validationPromise = null;
    }
  }

  async performStaticValidation(record) {
    this.record = { ...this.record, detail: "正在通过本站路由验证预览画面" };
    await this.write();
    try {
      if (typeof this.validatePreview !== "function") throw new Error("本站预览验证器不可用");
      await this.validatePreview(record);
      if (this.record.sessionId !== record.sessionId || this.record.buildId !== record.buildId || this.record.status !== "starting") return;
      this.record = { ...this.record, status: "running", detail: "Flutter Web 静态预览已就绪", error: null };
    } catch (error) {
      if (this.record.sessionId !== record.sessionId || this.record.buildId !== record.buildId || this.record.status !== "starting") return;
      this.record = {
        ...this.record,
        status: "failed",
        detail: "本站预览画面验证失败",
        error: String(error?.message || error),
        completedAt: Date.now(),
      };
    }
    await this.write();
  }

  async write() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.statePath, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
  }
}

function previewResponds(port, sessionId = null) {
  return new Promise((resolve) => {
    const path = sessionId ? `/tools/mobile-preview/${sessionId}/` : "/";
    const request = http.get({ hostname: "127.0.0.1", port, path }, (response) => {
      response.resume();
      resolve((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300);
    });
    request.setTimeout(5_000, () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

async function legacyPreviewIsReady(record) {
  if (record.readyMarkerPath) {
    try {
      await fs.access(record.readyMarkerPath);
    } catch {
      return false;
    }
  }
  return previewResponds(record.port, record.sessionId);
}

async function staticPreviewBuilt(record) {
  if (!record.readyMarkerPath || !record.webDirectory) return false;
  try {
    const [marker] = await Promise.all([
      fs.readFile(record.readyMarkerPath, "utf8"),
      fs.access(path.join(record.webDirectory, "index.html")),
      fs.access(path.join(record.webDirectory, "flutter_bootstrap.js")),
      fs.access(path.join(record.webDirectory, "main.dart.js")),
    ]);
    return !record.buildId || marker.trim() === record.buildId;
  } catch {
    return false;
  }
}

function idleRecord() {
  return {
    sessionId: null,
    accessKey: null,
    buildId: null,
    pid: null,
    port: PREVIEW_PORT,
    status: "idle",
    url: null,
    projectPath: null,
    previewDirectory: null,
    buildWorkspace: null,
    webDirectory: null,
    readyMarkerPath: null,
    deliveryMode: null,
    logPath: null,
    startedAt: null,
    expiresAt: null,
    completedAt: null,
    detail: null,
    error: null,
  };
}

function normalizeRecord(value) {
  return { ...idleRecord(), ...value, status: ["starting", "running", "failed", "stopped"].includes(value.status) ? value.status : "running" };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function isMobilePreviewSessionId(value) {
  return SESSION_PATTERN.test(String(value || ""));
}

export function isMobilePreviewAccessKey(value) {
  return ACCESS_KEY_PATTERN.test(String(value || ""));
}

function mobilePreviewUrl(sessionId, accessKey) {
  return `/tools/mobile-preview/${sessionId}/${accessKey}/`;
}

async function cleanupMobilePreviewArtifacts(layout, currentSessionId = null) {
  await Promise.all([
    cleanupEntries(layout.previews, (name) => SESSION_PATTERN.test(name) && name !== currentSessionId, true),
    cleanupEntries(layout.logs, (name) => /^preview-[a-f0-9]{24}\.log$/u.test(name) && name !== `preview-${currentSessionId}.log`, false),
  ]);
}

function terminateProcess(pid) {
  if (!isAlive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
}

async function cleanupEntries(directory, acceptsName, recursive) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = (await Promise.all(entries
    .filter((entry) => acceptsName(entry.name))
    .map(async (entry) => {
      const target = path.join(directory, entry.name);
      const stat = await fs.stat(target).catch(() => null);
      return stat ? { target, modifiedAt: stat.mtimeMs } : null;
    })))
    .filter(Boolean)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const cutoff = Date.now() - PREVIEW_RETENTION_MS;
  await Promise.all(candidates
    .filter((entry, index) => index >= PREVIEW_RETENTION_COUNT || entry.modifiedAt < cutoff)
    .map((entry) => fs.rm(entry.target, { recursive, force: true }).catch(() => {})));
}

export async function resolveMobilePreviewAsset(webDirectory, requestPath = "/") {
  if (!webDirectory) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(String(requestPath || "/"), "http://preview.invalid").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  let relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative = `${relative}index.html`;
  if (relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  try {
    const root = await fs.realpath(path.resolve(webDirectory));
    const target = await fs.realpath(path.resolve(root, relative));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
    const stat = await fs.stat(target);
    return stat.isFile() ? target : null;
  } catch {
    return null;
  }
}
