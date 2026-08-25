import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OfficialLoginBrowserManager,
  isAllowedBrowserResourceUrl,
  isAllowedTopLevelUrl,
  normalizeBrowserInput,
  normalizeBrowserViewport,
} from "../lib/official-login-browser.mjs";

const browserSource = await fs.readFile(new URL("../lib/official-login-browser.mjs", import.meta.url), "utf8");
const serverSource = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");

test("official login browser URL rules allow only bounded OAuth destinations", () => {
  for (const url of [
    "https://auth.openai.com/oauth/authorize",
    "https://chatgpt.com/auth/login",
    "https://platform.openai.com/auth/codex/success",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://appleid.apple.com/auth/authorize",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "http://localhost:1455/auth/callback?code=private",
  ]) assert.equal(isAllowedTopLevelUrl(url), true, url);

  for (const url of [
    "http://auth.openai.com/oauth/authorize",
    "https://auth.openai.com.example.test/oauth/authorize",
    "https://example.test/",
    "http://localhost:1455/other",
    "http://localhost:1456/auth/callback",
    "file:///etc/passwd",
  ]) assert.equal(isAllowedTopLevelUrl(url), false, url);

  assert.equal(isAllowedBrowserResourceUrl("https://cdn.oaistatic.com/assets/login.js"), true);
  assert.equal(isAllowedBrowserResourceUrl("https://fonts.gstatic.com/font.woff2"), true);
  assert.equal(isAllowedBrowserResourceUrl("https://aadcdn.msftauth.net/shared/login.js"), true);
  assert.equal(isAllowedBrowserResourceUrl("https://cdn-apple.com/assets/login.js"), true);
  assert.equal(isAllowedBrowserResourceUrl("http://localhost:1455/auth/callback?code=private"), true);
  assert.equal(isAllowedBrowserResourceUrl("http://localhost:1455/other"), false);
  assert.equal(isAllowedBrowserResourceUrl("https://openai.com.example.test/steal"), false);
  assert.equal(isAllowedBrowserResourceUrl("http://example.test/asset.js"), false);
});

test("official login browser uses native X11 VNC without a DevTools automation channel", () => {
  assert.match(browserSource, /spawn\("\/usr\/bin\/Xvfb"/);
  assert.match(browserSource, /spawn\("\/usr\/bin\/x11vnc"/);
  assert.match(browserSource, /runChildProcess\(\s*"\/usr\/bin\/xclip"/);
  for (const target of ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING"]) {
    assert.match(browserSource, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(browserSource, /"-unixsock", socketPath/);
  assert.match(browserSource, /"-rfbport", "0"/);
  assert.doesNotMatch(browserSource, /"-localhost"/);
  assert.match(browserSource, /spawn\("\/usr\/bin\/ffmpeg"/);
  assert.match(browserSource, /runChildProcess\("\/usr\/bin\/xdotool"/);
  assert.match(browserSource, /"--uid", String\(BROWSER_UID\), "--gid", String\(BROWSER_GID\)/);
  assert.match(browserSource, /"--disable-infobars"/);
  assert.doesNotMatch(browserSource, /remote-debugging|startScreencast|launchPersistentContext/);
});

test("official login browser sockets keep persistent error guards during teardown", () => {
  assert.match(browserSource, /upstream\.on\("error", close\)/);
  assert.match(browserSource, /clientSocket\.on\("error", close\)/);
  assert.match(browserSource, /socket\.on\("error", ignoreSocketError\)/);
  assert.match(serverSource, /upstream\.on\("error", close\)/);
  assert.match(serverSource, /CLAUDE_MCP_OAUTH_BROWSER_VNC_PATH/);
  assert.match(serverSource, /claudeMcpOAuthBrowser/);
  assert.match(serverSource, /claude-mcp-oauth-browser-input/);
});

test("Claude code submission keeps the server browser open until login is confirmed", () => {
  const submitRoute = serverSource.slice(
    serverSource.indexOf('app.post("/api/claude/official/login/submit"'),
    serverSource.indexOf('app.post("/api/claude/official/login/browser/close"'),
  );
  assert.match(submitRoute, /submitOfficialLogin\(request\.body\?\.code\)/);
  assert.doesNotMatch(submitRoute, /claudeOfficialLoginBrowser\?\.close/);
  assert.match(serverSource, /"claude-official-login-browser-close"/);
  assert.match(serverSource, /"claude-official-login-browser-authorize"/);
  assert.match(serverSource, /if \(!runtime\.claudeRuntime\.snapshot\(\)\.officialLoginRunning\)/);
});

test("official login browser viewport and input normalization are bounded", () => {
  assert.deepEqual(normalizeBrowserViewport({ width: 200, height: 2_000 }), { width: 360, height: 900 });
  assert.deepEqual(normalizeBrowserViewport({ width: "900.4", height: "700.6" }), { width: 900, height: 701 });
  assert.deepEqual(normalizeBrowserViewport(null), { width: 1100, height: 720 });

  const viewport = { width: 900, height: 700 };
  assert.deepEqual(normalizeBrowserInput({ type: "click", x: -1, y: 999, clickCount: 2 }, viewport), {
    type: "click", x: 0, y: 700, clickCount: 2,
  });
  assert.deepEqual(normalizeBrowserInput({ type: "move", x: 20, y: 30 }, viewport), {
    type: "move", x: 20, y: 30, clickCount: 1,
  });
  assert.deepEqual(normalizeBrowserInput({ type: "wheel", deltaX: -9_000, deltaY: 9_000 }, viewport), {
    type: "wheel", deltaX: -2_000, deltaY: 2_000,
  });
  assert.deepEqual(normalizeBrowserInput({ type: "text", text: "private input" }, viewport), {
    type: "text", text: "private input",
  });
  assert.deepEqual(normalizeBrowserInput({ type: "key", key: "a", modifiers: ["Control", "Control"] }, viewport), {
    type: "key", key: "a", modifiers: ["Control"],
  });
  assert.deepEqual(normalizeBrowserInput({ type: "key", key: "Enter", modifiers: [] }, viewport), {
    type: "key", key: "Enter", modifiers: [],
  });

  assert.throws(() => normalizeBrowserInput({ type: "click", x: "no", y: 1 }, viewport), /坐标无效/);
  assert.throws(() => normalizeBrowserInput({ type: "text", text: "" }, viewport), /文字输入无效/);
  assert.throws(() => normalizeBrowserInput({ type: "text", text: "x".repeat(2_049) }, viewport), /文字输入无效/);
  assert.throws(() => normalizeBrowserInput({ type: "key", key: "F12" }, viewport), /按键无效/);
  assert.throws(() => normalizeBrowserInput({ type: "navigate", url: "https://example.test" }, viewport), /输入类型无效/);
});

test("official login browser isolates one user session and removes temporary state", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "official-browser-test-"));
  const manager = new OfficialLoginBrowserManager({ runtimeDirectory, testMode: true });
  try {
    const session = await manager.start({
      userId: "user-1",
      loginId: "private-login-id",
      authUrl: "https://auth.openai.com/oauth/authorize?state=private-state",
      viewport: { width: 800, height: 640 },
      proxy: {
        protocol: "http",
        host: "127.0.0.1",
        port: 8_080,
        username: "private-proxy-user",
        password: "private-proxy-password",
        label: "Login route",
      },
    });
    assert.deepEqual(session.viewport, { width: 800, height: 640 });
    assert.equal(session.proxy.protocol, "http");
    assert.equal(session.proxy.hasAuthentication, true);
    assert.doesNotMatch(JSON.stringify(session), /login-id|private-state|authUrl|private-proxy-user|private-proxy-password/i);
    assert.equal(manager.snapshot("user-2"), null);
    await assert.rejects(
      manager.start({
        userId: "user-2",
        loginId: "other-login",
        authUrl: "https://auth.openai.com/oauth/authorize",
      }),
      (error) => error.statusCode === 409,
    );
    await assert.rejects(manager.frame("user-2"), (error) => error.statusCode === 403);
    assert.equal((await manager.frame("user-1")).image.length > 100, true);
    const stream = [];
    manager.subscribe("user-1", (frame) => stream.push(frame));
    assert.equal(stream[0].type, "frame");
    assert.equal(stream[0].data.length > 100, true);
    assert.deepEqual({ width: stream[0].width, height: stream[0].height }, { width: 800, height: 640 });
    assert.deepEqual(await manager.input("user-1", { type: "click", x: 5, y: 5 }), {
      ...session,
      editable: true,
      inputMode: "text",
    });

    const browserDirectory = path.join(runtimeDirectory, "mock-session");
    await fs.mkdir(browserDirectory);
    await fs.writeFile(path.join(browserDirectory, "secret"), "temporary");
    manager.active.directory = browserDirectory;
    assert.equal(await manager.close("user-1"), true);
    assert.equal(stream.at(-1).type, "closed");
    await assert.rejects(fs.access(browserDirectory), { code: "ENOENT" });
    assert.equal(manager.hasActiveSession(), false);

    await assert.rejects(
      manager.start({
        userId: "user-1",
        loginId: "private-login-id",
        authUrl: "https://example.test/oauth/authorize",
      }),
      (error) => error.statusCode === 502,
    );
  } finally {
    await manager.closeAll();
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Claude official login browser accepts only Claude OAuth destinations", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-official-browser-test-"));
  const manager = new OfficialLoginBrowserManager({ runtimeDirectory, testMode: true, flow: "claude" });
  try {
    const session = await manager.start({
      userId: "user-claude",
      loginId: "private-claude-login",
      authUrl: "https://claude.com/oauth/authorize?state=private-state",
      viewport: { width: 900, height: 700 },
    });
    assert.equal(session.host, "claude.com");
    assert.equal(session.transport, "vnc");
    assert.doesNotMatch(JSON.stringify(session), /private-claude-login|private-state/);
    const reopened = await manager.reopenAuthorization("user-claude");
    assert.equal(reopened.host, "claude.com");
    assert.doesNotMatch(JSON.stringify(reopened), /private-claude-login|private-state/);
    await manager.close("user-claude");

    await assert.rejects(
      manager.start({
        userId: "user-claude",
        loginId: "private-claude-login",
        authUrl: "https://auth.openai.com/oauth/authorize",
      }),
      (error) => error.statusCode === 502,
    );
    await assert.rejects(
      manager.start({
        userId: "user-claude",
        loginId: "private-claude-login",
        authUrl: "https://claude.com.example.test/oauth/authorize",
      }),
      (error) => error.statusCode === 502,
    );
  } finally {
    await manager.closeAll();
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("MCP OAuth browser keeps the provider URL server-side and rejects private targets", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-mcp-browser-test-"));
  const manager = new OfficialLoginBrowserManager({ runtimeDirectory, testMode: true, flow: "mcp" });
  try {
    const session = await manager.start({
      userId: "user-mcp",
      loginId: "private-mcp-request",
      authUrl: "https://login.example.test/oauth/authorize?state=private-state",
      viewport: { width: 900, height: 700 },
    });
    assert.equal(session.host, "login.example.test");
    assert.doesNotMatch(JSON.stringify(session), /private-mcp-request|private-state|authUrl/);
    assert.equal((await manager.frame("user-mcp")).host, "login.example.test");
    await manager.close("user-mcp");

    for (const authUrl of [
      "http://login.example.test/oauth/authorize",
      "https://localhost/oauth/authorize",
      "https://127.0.0.1/oauth/authorize",
      "https://192.168.1.10/oauth/authorize",
      "https://login.example.test:8443/oauth/authorize",
    ]) {
      await assert.rejects(
        manager.start({ userId: "user-mcp", loginId: "request", authUrl }),
        (error) => error.statusCode === 502,
        authUrl,
      );
    }
  } finally {
    await manager.closeAll();
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("official login browser expires sessions and bounds queued input", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "official-browser-queue-test-"));
  const manager = new OfficialLoginBrowserManager({ runtimeDirectory, testMode: true });
  try {
    await manager.start({
      userId: "user-1",
      loginId: "private-login-id",
      authUrl: "https://auth.openai.com/oauth/authorize",
    });
    let releaseQueue;
    manager.active.queue = new Promise((resolve) => { releaseQueue = resolve; });
    const queued = Array.from({ length: 32 }, () => manager.input("user-1", { type: "key", key: "Tab" }));
    await assert.rejects(
      manager.input("user-1", { type: "key", key: "Tab" }),
      (error) => error.statusCode === 429,
    );
    releaseQueue();
    await Promise.all(queued);

    const expiration = new Promise((resolve) => manager.once("expired", resolve));
    const active = manager.active;
    await manager.expire(active);
    assert.deepEqual(await expiration, { userId: "user-1", loginId: "private-login-id" });
    assert.equal(manager.hasActiveSession(), false);
  } finally {
    await manager.closeAll();
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("official login browser tears down a session when native input capture fails", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "official-browser-failure-test-"));
  const manager = new OfficialLoginBrowserManager({ runtimeDirectory, testMode: true });
  try {
    await manager.start({
      userId: "user-1",
      loginId: "private-login-id",
      authUrl: "https://auth.openai.com/oauth/authorize",
    });
    manager.active.mock = false;
    manager.active.display = ":9999";
    manager.active.xauthorityPath = path.join(runtimeDirectory, "missing-xauth");
    const failure = new Promise((resolve) => manager.once("failed", resolve));
    await assert.rejects(manager.input("user-1", { type: "key", key: "Tab" }), /xdotool exited/);
    assert.deepEqual(await failure, { userId: "user-1", loginId: "private-login-id" });
    assert.equal(manager.hasActiveSession(), false);
  } finally {
    await manager.closeAll();
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});
