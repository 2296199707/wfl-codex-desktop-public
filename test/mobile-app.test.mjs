import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import express from "express";
import { parse } from "yaml";
import { MobileAppConfigStore } from "../lib/mobile-app-config.mjs";
import { MobileAppPreviewToolService } from "../lib/mobile-app-preview-tool-service.mjs";
import {
  isMobilePreviewSessionId,
  MobileAppPreviewManager,
} from "../lib/mobile-app-preview.mjs";
import {
  MobilePreviewBrowserSession,
} from "../lib/mobile-app-preview-render.mjs";
import {
  publishMobilePreviewWeb,
  resetMobilePreviewWorkspace,
  stageMobilePreviewProject,
} from "../lib/mobile-app-preview-stage.mjs";

test("mobile App config stores one custom root and derives its directories", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-mobile-app-"));
  try {
    const store = await new MobileAppConfigStore({
      stateDirectory: path.join(directory, "state"),
      sourceDirectory: directory,
      projectRoots: [directory],
    }).initialize();
    const config = await store.save({
      projectPath: path.join(directory, "apps", "mobile"),
      storageRoot: path.join(directory, "data", "mobile-app"),
      flutterBin: path.join(directory, "flutter", "bin", "flutter"),
    });
    assert.equal(config.storageRoot, path.join(directory, "data", "mobile-app"));
    assert.equal(config.flutterBin, path.join(directory, "flutter", "bin", "flutter"));
    const layout = store.layout();
    assert.equal(layout.apk, path.join(config.storageRoot, "apk"));
    assert.equal(layout.signing, path.join(config.storageRoot, "signing"));
    assert.equal(layout.generatedRoot, path.join(config.storageRoot, "generated"));
    assert.match(layout.generatedProject, new RegExp(`${path.join(config.storageRoot, "generated", "flutter-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{16}$`));
    await fs.access(layout.apk);
    await fs.access(layout.pubCache);
    await assert.rejects(
      store.save({ projectPath: "/tmp/outside-mobile-project", storageRoot: config.storageRoot }),
      /项目必须位于/u,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mobile preview session ids are fixed-length hex values", () => {
  assert.equal(isMobilePreviewSessionId("a".repeat(24)), true);
  assert.equal(isMobilePreviewSessionId("../preview"), false);
});

test("mobile preview tool validates interactive browser operations", async () => {
  const service = new MobileAppPreviewToolService({
    directory: os.tmpdir(),
    userId: "interaction-test",
    click: async (input) => input,
    type: async (input) => input,
    scroll: async (input) => input,
  });
  assert.deepEqual(
    await service.execute(JSON.stringify({ version: 1, action: "mobile_preview_click", arguments: { x: 0, y: 843 } })),
    { x: 0, y: 843 },
  );
  assert.deepEqual(
    await service.execute(JSON.stringify({ version: 1, action: "mobile_preview_type", arguments: { text: "测试", clear: true } })),
    { text: "测试", clear: true },
  );
  assert.deepEqual(
    await service.execute(JSON.stringify({ version: 1, action: "mobile_preview_scroll", arguments: { deltaY: 400 } })),
    { deltaX: 0, deltaY: 400 },
  );
  await assert.rejects(
    service.execute(JSON.stringify({ version: 1, action: "mobile_preview_click", arguments: { x: 390, y: 10 } })),
    /坐标超出/u,
  );
});

test("mobile preview waits for the Flutter compilation marker before reporting ready", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-mobile-preview-ready-"));
  const previewDirectory = path.join(directory, "preview");
  const server = http.createServer((_request, response) => response.end("ready"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fs.mkdir(previewDirectory, { recursive: true });
    const manager = new MobileAppPreviewManager({
      stateDirectory: path.join(directory, "state"),
      sourceDirectory: directory,
      configStore: {},
    });
    manager.record = {
      sessionId: "a".repeat(24),
      pid: process.pid,
      port: server.address().port,
      status: "starting",
      url: `/tools/mobile-preview/${"a".repeat(24)}/`,
      projectPath: directory,
      previewDirectory,
      readyMarkerPath: path.join(previewDirectory, ".wfl-preview-ready"),
      logPath: null,
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      completedAt: null,
      detail: "starting",
      error: null,
    };

    assert.equal((await manager.snapshot()).status, "starting");
    await fs.writeFile(path.join(previewDirectory, ".wfl-preview-ready"), "");
    assert.equal((await manager.snapshot()).status, "running");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("static mobile preview renders its first frame through the real gateway path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-mobile-gateway-preview-"));
  const sessionId = "b".repeat(24);
  const accessKey = "C".repeat(43);
  const previewUrl = `/tools/mobile-preview/${sessionId}/${accessKey}/`;
  const webDirectory = path.join(directory, "preview", "build", "web");
  let backend;
  let gateway;
  let browserSession;
  try {
    await writeRenderedPreviewFixture(webDirectory, previewUrl, { interactive: true });
    const manager = new MobileAppPreviewManager({
      stateDirectory: path.join(directory, "state"),
      sourceDirectory: directory,
      configStore: {},
    });
    manager.record = staticPreviewRecord({ directory, webDirectory, sessionId, accessKey, previewUrl });
    const app = express();
    mountPreview(app, manager);
    backend = await listen(app);
    gateway = await startGateway(backend.address().port, directory);
    browserSession = new MobilePreviewBrowserSession({
      targetForRecord: (record) => `http://127.0.0.1:${gateway.port}${record.url}`,
    });
    manager.validatePreview = (record) => browserSession.validate(record);

    await fs.writeFile(manager.record.readyMarkerPath, "stale-build\n");
    manager.record.pid = process.pid;
    assert.equal((await manager.snapshot()).status, "starting");
    await fs.writeFile(manager.record.readyMarkerPath, "build-1\n");
    const snapshot = await manager.snapshot();
    assert.equal(snapshot.status, "running", snapshot.error || snapshot.detail);
    const initial = await browserSession.screenshot(snapshot);
    const clicked = await browserSession.click(snapshot, { x: 100, y: 100 });
    const typed = await browserSession.type(snapshot, { text: "persistent", clear: true });
    const scrolled = await browserSession.scroll(snapshot, { deltaY: 420 });
    assert.equal(initial.screenshot.mimeType, "image/png");
    assert.ok(Buffer.from(initial.screenshot.data, "base64").length > 1_000);
    assert.notEqual(clicked.screenshot.data, initial.screenshot.data);
    assert.notEqual(typed.screenshot.data, clicked.screenshot.data);
    assert.notEqual(scrolled.screenshot.data, typed.screenshot.data);
    assert.deepEqual(clicked.interaction, { type: "click", x: 100, y: 100 });
    assert.equal(typed.interaction.characters, 10);
    assert.deepEqual(scrolled.interaction, { type: "scroll", deltaX: 0, deltaY: 420 });
    const rebuilt = await browserSession.screenshot({ ...snapshot, buildId: "build-2" });
    assert.notEqual(rebuilt.screenshot.data, scrolled.screenshot.data);
    assert.equal(rebuilt.screenshot.data, initial.screenshot.data);
    const invalid = await fetch(`http://127.0.0.1:${gateway.port}/tools/mobile-preview/${sessionId}/${"D".repeat(43)}/`);
    assert.equal(invalid.status, 404);
  } finally {
    await browserSession?.close();
    await gateway?.close();
    await closeServer(backend);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sandboxed mobile preview cannot carry or read the main-site login identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-mobile-identity-preview-"));
  const sessionId = "d".repeat(24);
  const accessKey = "E".repeat(43);
  const previewUrl = `/tools/mobile-preview/${sessionId}/${accessKey}/`;
  const webDirectory = path.join(directory, "preview", "build", "web");
  const apiCookies = [];
  const previewCookies = [];
  let backend;
  let gateway;
  let browser;
  try {
    await writeRenderedPreviewFixture(webDirectory, previewUrl, {
      beforeDraw: `
        window.identityReadable = false;
        try {
          const response = await fetch('/api/account?source=preview', { credentials: 'include' });
          const account = await response.json();
          window.identityReadable = account.username === 'owner';
        } catch {}
        window.identityChecked = true;
      `,
    });
    const manager = new MobileAppPreviewManager({ stateDirectory: path.join(directory, "state"), sourceDirectory: directory, configStore: {} });
    manager.record = { ...staticPreviewRecord({ directory, webDirectory, sessionId, accessKey, previewUrl }), status: "running" };
    const app = express();
    app.get("/api/account", (request, response) => {
      apiCookies.push({ source: request.query.source, cookie: request.headers.cookie || "" });
      if ((request.headers.cookie || "").includes("admin_session=secret")) response.json({ username: "owner" });
      else response.status(401).json({ error: "unauthenticated" });
    });
    app.get("/identity-host", (_request, response) => {
      response.type("html").send(`<iframe title="preview" src="${previewUrl}" sandbox="allow-scripts" referrerpolicy="no-referrer" credentialless></iframe>`);
    });
    app.use("/tools/mobile-preview/", (request, _response, next) => {
      previewCookies.push(request.headers.cookie || "");
      next();
    });
    mountPreview(app, manager);
    backend = await listen(app);
    gateway = await startGateway(backend.address().port, directory);

    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([{
      name: "admin_session",
      value: "secret",
      url: `http://127.0.0.1:${gateway.port}`,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${gateway.port}/identity-host`);
    assert.equal(await page.evaluate(async () => (await fetch("/api/account?source=host")).status), 200);
    const frame = await waitForPreviewFrame(page, previewUrl);
    await frame.waitForFunction(() => window.identityChecked === true);
    assert.equal(await frame.evaluate(() => window.identityReadable), false);
    assert.ok(apiCookies.some((entry) => entry.source === "host" && entry.cookie.includes("admin_session=secret")));
    const previewApiAttempts = apiCookies.filter((entry) => entry.source === "preview");
    assert.ok(previewApiAttempts.length >= 1);
    assert.ok(previewApiAttempts.every((entry) => !entry.cookie));
    assert.ok(previewCookies.length >= 2);
    assert.ok(previewCookies.every((cookie) => !cookie));

    const toolHtml = await fs.readFile(path.join(process.cwd(), "public", "mobile-tool.html"), "utf8");
    assert.match(toolHtml, /sandbox="allow-scripts"/u);
    assert.doesNotMatch(toolHtml, /allow-same-origin/u);
    assert.match(toolHtml, /credentialless/u);
  } finally {
    await browser?.close().catch(() => {});
    await gateway?.close();
    await closeServer(backend);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mobile preview staging preserves the full project and rewrites local path dependencies", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-mobile-project-stage-"));
  const project = path.join(directory, "apps", "mobile");
  const shared = path.join(directory, "apps", "shared_package");
  const transitive = path.join(directory, "apps", "transitive_package");
  const preview = path.join(directory, "staged", "preview");
  const workspace = path.join(directory, "staged", "workspace");
  try {
    await Promise.all([
      fs.mkdir(path.join(project, "web"), { recursive: true }),
      fs.mkdir(path.join(project, "resources"), { recursive: true }),
      fs.mkdir(path.join(project, "packages", "internal", "lib"), { recursive: true }),
      fs.mkdir(path.join(project, ".dart_tool"), { recursive: true }),
      fs.mkdir(path.join(project, "build"), { recursive: true }),
      fs.mkdir(path.join(shared, "lib"), { recursive: true }),
      fs.mkdir(path.join(shared, "assets"), { recursive: true }),
      fs.mkdir(path.join(transitive, "lib"), { recursive: true }),
      fs.mkdir(preview, { recursive: true }),
      fs.mkdir(path.join(workspace, ".dart_tool"), { recursive: true }),
      fs.mkdir(path.join(workspace, "build", "web"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(project, "pubspec.yaml"), `name: mobile\ndependencies:\n  shared_package:\n    path: ../shared_package\n  internal:\n    path: packages/internal\nflutter:\n  assets:\n    - resources/config.json\n`),
      fs.writeFile(path.join(project, "pubspec.lock"), "packages: {}\n"),
      fs.writeFile(path.join(project, "web", "index.html"), "custom web shell"),
      fs.writeFile(path.join(project, "resources", "config.json"), "{\"ready\":true}"),
      fs.writeFile(path.join(project, ".dart_tool", "stale"), "stale"),
      fs.writeFile(path.join(project, "build", "stale"), "stale"),
      fs.writeFile(path.join(project, "packages", "internal", "pubspec.yaml"), "name: internal\n"),
      fs.writeFile(path.join(project, "packages", "internal", "lib", "internal.dart"), "const internal = true;\n"),
      fs.writeFile(path.join(shared, "pubspec.yaml"), "name: shared_package\ndependencies:\n  transitive_package:\n    path: ../transitive_package\n"),
      fs.writeFile(path.join(shared, "lib", "shared.dart"), "const shared = true;\n"),
      fs.writeFile(path.join(shared, "assets", "shared.json"), "{}"),
      fs.writeFile(path.join(transitive, "pubspec.yaml"), "name: transitive_package\n"),
      fs.writeFile(path.join(transitive, "lib", "transitive.dart"), "const transitive = true;\n"),
      fs.writeFile(path.join(workspace, ".dart_tool", "incremental-cache"), "keep"),
      fs.writeFile(path.join(workspace, "build", "compiler-cache"), "keep"),
      fs.writeFile(path.join(workspace, "build", "web", "stale.js"), "stale"),
      fs.writeFile(path.join(workspace, "stale-source.dart"), "stale"),
    ]);

    await resetMobilePreviewWorkspace(workspace);
    await fs.access(path.join(workspace, ".dart_tool", "incremental-cache"));
    await fs.access(path.join(workspace, "build", "compiler-cache"));
    await assert.rejects(fs.access(path.join(workspace, "build", "web", "stale.js")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(workspace, "stale-source.dart")), { code: "ENOENT" });
    await stageMobilePreviewProject(project, preview);
    assert.equal(await fs.readFile(path.join(preview, "web", "index.html"), "utf8"), "custom web shell");
    assert.equal(await fs.readFile(path.join(preview, "resources", "config.json"), "utf8"), "{\"ready\":true}");
    await fs.access(path.join(preview, "pubspec.lock"));
    await assert.rejects(fs.access(path.join(preview, ".dart_tool", "stale")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(preview, "build", "stale")), { code: "ENOENT" });

    const stagedPubspec = parse(await fs.readFile(path.join(preview, "pubspec.yaml"), "utf8"));
    const sharedDestination = path.resolve(preview, stagedPubspec.dependencies.shared_package.path);
    assert.ok(sharedDestination.startsWith(`${preview}${path.sep}`));
    assert.equal(await fs.readFile(path.join(sharedDestination, "assets", "shared.json"), "utf8"), "{}");
    const sharedPubspec = parse(await fs.readFile(path.join(sharedDestination, "pubspec.yaml"), "utf8"));
    const transitiveDestination = path.resolve(sharedDestination, sharedPubspec.dependencies.transitive_package.path);
    assert.ok(transitiveDestination.startsWith(`${preview}${path.sep}`));
    await fs.access(path.join(transitiveDestination, "lib", "transitive.dart"));

    const internalDestination = path.resolve(preview, stagedPubspec.dependencies.internal.path);
    await fs.access(path.join(internalDestination, "lib", "internal.dart"));

    const builtWeb = path.join(directory, "built-web");
    await fs.mkdir(path.join(preview, "build", "web"), { recursive: true });
    await fs.mkdir(builtWeb, { recursive: true });
    await fs.writeFile(path.join(preview, "build", "web", "old.js"), "old");
    await fs.writeFile(path.join(builtWeb, "main.dart.js"), "new");
    await publishMobilePreviewWeb(builtWeb, preview);
    assert.equal(await fs.readFile(path.join(preview, "build", "web", "main.dart.js"), "utf8"), "new");
    await assert.rejects(fs.access(path.join(preview, "build", "web", "old.js")), { code: "ENOENT" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  const previewScript = await fs.readFile(path.join(process.cwd(), "scripts", "preview-mobile-app.sh"), "utf8");
  assert.doesNotMatch(previewScript, /pub get --directory="\$PROJECT"/u);
  assert.match(previewScript, /build web/u);
  assert.match(previewScript, /--no-web-resources-cdn/u);
  assert.match(previewScript, /--pwa-strategy=none/u);
  assert.match(previewScript, /--base-href/u);
  assert.match(previewScript, /--reset-workspace/u);
  assert.match(previewScript, /--publish-web/u);
  assert.match(previewScript, /flock 9/u);
  assert.doesNotMatch(previewScript, /run -d web-server/u);
});

function staticPreviewRecord({ directory, webDirectory, sessionId, accessKey, previewUrl }) {
  return {
    sessionId,
    accessKey,
    buildId: "build-1",
    pid: 99_999_999,
    port: null,
    status: "starting",
    url: previewUrl,
    projectPath: directory,
    previewDirectory: path.dirname(path.dirname(webDirectory)),
    webDirectory,
    readyMarkerPath: path.join(path.dirname(path.dirname(webDirectory)), ".wfl-preview-ready"),
    deliveryMode: "static",
    logPath: null,
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    completedAt: null,
    detail: "building",
    error: null,
  };
}

async function writeRenderedPreviewFixture(webDirectory, previewUrl, { beforeDraw = "", interactive = false } = {}) {
  await fs.mkdir(webDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(path.dirname(path.dirname(webDirectory)), ".wfl-preview-ready"), "build-1\n"),
    fs.writeFile(path.join(webDirectory, "index.html"), `<base href="${previewUrl}"><flt-glass-pane></flt-glass-pane><script src="main.dart.js"></script>`),
    fs.writeFile(path.join(webDirectory, "flutter_bootstrap.js"), ""),
    fs.writeFile(path.join(webDirectory, "canvaskit.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])),
    fs.writeFile(path.join(webDirectory, "main.dart.js"), `
      (async () => {
        const wasm = await fetch('canvaskit.wasm');
        await WebAssembly.instantiate(await wasm.arrayBuffer());
        ${beforeDraw}
        const pane = document.querySelector('flt-glass-pane');
        const root = pane.attachShadow({ mode: 'open' });
        const canvas = document.createElement('canvas');
        canvas.width = 390; canvas.height = 844;
        root.append(canvas);
        const context = canvas.getContext('2d');
        let interactionCount = 0;
        let typedText = '';
        let scrollOffset = 0;
        const draw = () => {
          context.fillStyle = '#ffffff'; context.fillRect(0, 0, 390, 844);
          context.fillStyle = interactionCount % 2 ? '#f59e0b' : '#ef4444'; context.fillRect(20, 20, 160, 360);
          context.fillStyle = typedText ? '#a855f7' : '#22c55e'; context.fillRect(210, 20, 160, 360);
          context.fillStyle = scrollOffset ? '#06b6d4' : '#2563eb'; context.fillRect(20, 420, 350, 380);
          context.fillStyle = '#111827'; context.font = '20px sans-serif'; context.fillText(typedText || 'ready', 35, 470);
        };
        draw();
        ${interactive ? `
          const input = document.createElement('input');
          input.style.cssText = 'position:absolute;opacity:0;width:1px;height:1px';
          root.append(input);
          canvas.addEventListener('click', () => { interactionCount += 1; input.focus(); draw(); });
          input.addEventListener('input', () => { typedText = input.value; draw(); });
          canvas.addEventListener('wheel', (event) => { event.preventDefault(); scrollOffset += event.deltaY; draw(); }, { passive: false });
        ` : ""}
      })();
    `),
  ]);
}

function mountPreview(app, manager) {
  app.use("/tools/mobile-preview/:sessionId/:accessKey", async (request, response, next) => {
    try {
      if (!manager.acceptsAccessKey(request.params.sessionId, request.params.accessKey)) {
        response.status(404).end();
        return;
      }
      await manager.proxy(request, response, request.params.sessionId, request.params.accessKey, request.path || "/");
    } catch (error) {
      next(error);
    }
  });
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function startGateway(upstreamPort, directory) {
  const port = await getFreePort();
  const rescuePort = await getFreePort();
  const activePortFile = path.join(directory, `active-port-${port}`);
  await fs.writeFile(activePortFile, `${upstreamPort}\n`);
  const child = spawn(process.execPath, [path.join(process.cwd(), "gateway.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_DESKTOP_UPSTREAM_PORTS: String(upstreamPort),
      CODEX_DESKTOP_UPSTREAM_PORT: String(upstreamPort),
      CODEX_DESKTOP_ACTIVE_PORT_FILE: activePortFile,
      CODEX_DESKTOP_RESCUE_PORT: String(rescuePort),
      CODEX_DESKTOP_GATEWAY_TEST_MODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForGateway(port, child);
  return {
    port,
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function waitForGateway(port, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试网关提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/gateway-ready`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试网关未就绪");
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await closeServer(server);
  return port;
}

async function waitForPreviewFrame(page, previewUrl) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((entry) => entry.url().includes(previewUrl));
    if (frame) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error("隔离预览 iframe 未加载");
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
