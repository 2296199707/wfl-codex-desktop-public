import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  assertCodexActivationAllowed,
  inspectCodexProtocolCompatibility,
} from "../lib/codex-compatibility.mjs";
import { inspectCodexInstallation } from "../lib/codex-prerequisite.mjs";
import { assertClaudeCompatible } from "../lib/claude-compatibility.mjs";
import { claudeComponentSnapshot } from "../lib/claude-component.mjs";
import { chromiumExecutablePath } from "../lib/playwright-browser.mjs";

const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"),
);
const gatewayUrl = process.env.CODEX_DESKTOP_QUICK_CHECK_GATEWAY_URL || "http://127.0.0.1:4317";
const offline = process.env.CODEX_DESKTOP_QUICK_CHECK_OFFLINE === "1";
const results = [];

await check("node", async () => {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major) || major < 22) throw new Error("Node.js 22 or newer is required for the main site");
  return process.version;
});
await check("codex", async () => {
  const installation = await inspectCodexInstallation();
  if (!installation.appServerReady) throw new Error("Codex app-server is unavailable");
  const compatibility = await inspectCodexProtocolCompatibility({
    installedVersion: installation.version,
    projectDirectory: sourceDirectory,
  });
  assertCodexActivationAllowed(compatibility);
  return {
    version: installation.version,
    state: compatibility.state,
    risk: compatibility.risk,
    runtimeCapabilities: compatibility.runtimeCapabilities,
  };
});
await check("claude", async () => {
  const component = await claudeComponentSnapshot({
    runtimeDirectory,
    appDirectory: sourceDirectory,
    commandOverride: process.env.CODEX_DESKTOP_CLAUDE_BIN || null,
  });
  if (!component.installed) return "optional / not-installed";
  if (!component.ready) {
    throw new Error(`Claude Code ${component.version || "unknown"} does not match reviewed version ${component.reviewedVersion}`);
  }
  const compatibility = await assertClaudeCompatible({
    command: process.env.CODEX_DESKTOP_CLAUDE_BIN || path.join(sourceDirectory, "scripts", "claude-command"),
    projectDirectory: sourceDirectory,
  });
  return `${compatibility.installedVersion} / ${compatibility.state}`;
});
await check("chromium", async () => {
  const browser = await chromiumExecutablePath({ runtimeDirectory });
  await fs.access(browser.executable, constants.R_OK | constants.X_OK);
  return browser.executable;
});
await check("source", async () => {
  await Promise.all([
    fs.access(sourceDirectory, constants.R_OK | constants.X_OK),
    fs.access(path.join(sourceDirectory, "server.mjs"), constants.R_OK),
    fs.access(path.join(sourceDirectory, "gateway.mjs"), constants.R_OK),
    fs.access(path.join(sourceDirectory, "public", "login.html"), constants.R_OK),
  ]);
  return sourceDirectory;
});
await check("state", async () => {
  await Promise.all([
    fs.access(runtimeDirectory, constants.R_OK | constants.W_OK | constants.X_OK),
    fs.access(stateDirectory, constants.R_OK | constants.W_OK | constants.X_OK),
  ]);
  return `${stateDirectory} / ${runtimeDirectory}`;
});

if (offline) {
  results.push({ name: "services", ok: true, detail: "deferred-until-post-deploy-doctor" });
  console.log(JSON.stringify({ ok: true, checks: results }, null, 2));
  process.exit(0);
}

const gateway = await check("gateway", async () => {
  const ready = await fetchJson(`${gatewayUrl}/internal/gateway-ready`);
  if (ready.ok !== true || !Number.isInteger(ready.upstreamPort)) throw new Error("Stable gateway is not ready");
  return ready;
});
await check("active-backend", async () => {
  const ready = await fetchJson(`http://127.0.0.1:${gateway.upstreamPort}/internal/codex-ready`);
  if (
    ready.ok !== true
    || ready.codexReady !== true
    || ready.runtimeBundleReady !== true
    || ready.codeModeHostReady !== true
    || typeof ready.codexTarget !== "string"
    || !/^[a-f0-9]{64}$/iu.test(ready.codexRuntimeSha256 || "")
    || !/^[a-f0-9]{64}$/iu.test(ready.codexCodeModeHostSha256 || "")
  ) throw new Error("Active Codex backend or native runtime bundle is not ready");
  return ready.version;
});
await check("login-page", async () => {
  const response = await fetch(`${gatewayUrl}/login.html`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.text();
  if (!response.ok || !body.includes("loginForm")) throw new Error("Login page probe failed");
  return response.status;
});
await check("websocket", () => probeWebSocket(`${gatewayUrl.replace(/^http/, "ws")}/ws`));
console.log(JSON.stringify({ ok: true, checks: results }, null, 2));

async function check(name, operation) {
  try {
    const detail = await operation();
    results.push({ name, ok: true, detail });
    return detail;
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(JSON.stringify({ ok: false, checks: results }, null, 2));
    process.exitCode = 1;
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function probeWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: gatewayUrl } });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket probe timed out"));
    }, 3_000);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once("open", () => {
      socket.close();
      finish("connected");
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if ([401, 429].includes(response.statusCode)) finish(`authenticated:${response.statusCode}`);
      else reject(new Error(`WebSocket probe returned ${response.statusCode}`));
    });
    socket.once("error", (error) => {
      if (!timer) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}
