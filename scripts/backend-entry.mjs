import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackendAuthorityStore, readSelectedBackendPort } from "../lib/backend-authority.mjs";
import { prepareCodexRuntimeBundle } from "../lib/codex-runtime-bundle.mjs";

const CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY = "codex-runtime-bundle-v1";

const sourceDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backendSourceDirectory = path.resolve(
  process.env.CODEX_DESKTOP_BACKEND_SOURCE_DIR || sourceDirectory,
);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Backend entry requires a valid PORT");

const packageJson = JSON.parse(await fs.readFile(path.join(backendSourceDirectory, "package.json"), "utf8"));
const packageManifest = JSON.parse(
  await fs.readFile(path.join(backendSourceDirectory, ".codex-package.json"), "utf8"),
);
const version = packageJson.version;
const codexRuntimeBundleRequired = packageManifest.capabilities?.includes(
  CODEX_RUNTIME_BUNDLE_PACKAGE_CAPABILITY,
) === true;
const authorityStore = new BackendAuthorityStore(runtimeDirectory);
const backendInstanceId = process.env.CODEX_DESKTOP_BACKEND_INSTANCE_ID || authorityStore.createInstanceId();
let transitioning = false;
let standbyServer = null;
let standbyCodexRuntime = null;

if (await isSelected()) {
  await startPrimary();
} else {
  await startStandby();
}

async function startStandby() {
  if (codexRuntimeBundleRequired) {
    standbyCodexRuntime = await prepareCodexRuntimeBundle({
      command: process.env.CODEX_DESKTOP_CODEX_BIN || "codex",
      runtimeDirectory,
    });
    if (!standbyCodexRuntime.officialPackage
      || standbyCodexRuntime.runtimeBundleReady !== true
      || standbyCodexRuntime.codeModeHostReady !== true) {
      throw new Error("Candidate standby requires a complete official Codex runtime bundle");
    }
  }
  standbyServer = http.createServer((request, response) => {
    void routeStandbyRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      sendJson(response, 503, { ok: false, error: error.message });
    });
  });
  standbyServer.keepAliveTimeout = 2_000;
  standbyServer.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    standbyServer.once("error", reject);
    standbyServer.listen(port, host, resolve);
  });
  console.log(`WFL backend standby v${version}: http://${host}:${port} (${backendInstanceId})`);
}

async function routeStandbyRequest(request, response) {
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 404, { ok: false });
    return;
  }
  const pathname = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`).pathname;
  if (request.method === "GET" && ["/internal/standby-ready", "/internal/backend-identity"].includes(pathname)) {
    sendJson(response, 200, {
      ok: true,
      version,
      port,
      backendInstanceId,
      primary: false,
      standby: true,
      runtimeBundleRequired: codexRuntimeBundleRequired,
      ...(codexRuntimeBundleRequired ? {
        runtimeBundleReady: true,
        codeModeHostReady: true,
        codexVersion: standbyCodexRuntime.version,
        codexTarget: standbyCodexRuntime.target,
        codexRuntimeSha256: standbyCodexRuntime.treeSha256,
        codexCodeModeHostSha256: standbyCodexRuntime.codeModeHostSha256,
      } : {}),
    });
    return;
  }
  if (request.method === "GET" && pathname === "/internal/ready") {
    sendJson(response, 503, { ok: false, version, primary: false, standby: true });
    return;
  }
  if (request.method === "POST" && pathname === "/internal/activate-primary") {
    if (transitioning) {
      sendJson(response, 202, { ok: true, version, backendInstanceId, transitioning: true });
      return;
    }
    let authority;
    try {
      authority = await authorityStore.read({ allowMissing: false });
      await authorityStore.assertCurrent({
        backendInstanceId,
        writerEpoch: authority.writerEpoch,
        port,
      });
    } catch {
      sendJson(response, 409, { ok: false, error: "Backend does not own writer authority" });
      return;
    }
    transitioning = true;
    response.once("finish", () => void transitionToPrimary());
    sendJson(response, 202, {
      ok: true,
      version,
      port,
      backendInstanceId,
      writerEpoch: authority.writerEpoch,
      transitioning: true,
    });
    return;
  }
  sendJson(response, 404, { ok: false });
}

async function transitionToPrimary() {
  try {
    await new Promise((resolve, reject) => {
      standbyServer.close((error) => error ? reject(error) : resolve());
      standbyServer.closeIdleConnections?.();
    });
    standbyServer = null;
    // Standby handoff intentionally promotes the candidate before the public
    // selector moves. The deploy worker keeps the gateway on the old backend
    // until this process passes deep readiness, so this path must not fall
    // back to standby merely because active-port still names the old slot.
    await startPrimary({ allowUnselected: true });
  } catch (error) {
    console.error(`Backend standby activation failed: ${error.stack || error.message}`);
    process.exitCode = 1;
    process.exit();
  }
}

async function startPrimary({ allowUnselected = false } = {}) {
  if (!allowUnselected && !await isSelected()) {
    if (!standbyServer) await startStandby();
    return;
  }
  const authority = await authorityStore.claim({ backendInstanceId, port });
  // The selector and writer authority are separate durable records. Recheck
  // the selector after the authority claim so a concurrent blue-green switch
  // cannot make an old backend enter the application as primary.
  if (!allowUnselected && !await isSelected()) {
    if (!standbyServer) await startStandby();
    return;
  }
  if (allowUnselected) process.env.CODEX_DESKTOP_BACKEND_PROMOTE_UNSELECTED = "1";
  process.env.CODEX_DESKTOP_BACKEND_INSTANCE_ID = backendInstanceId;
  process.env.CODEX_DESKTOP_BACKEND_WRITER_EPOCH = String(authority.writerEpoch);
  process.env.CODEX_DESKTOP_BACKEND_ENTRY = "1";
  await import(pathToFileURL(path.join(backendSourceDirectory, "server.mjs")).href);
}

async function isSelected() {
  return await readSelectedBackendPort(runtimeDirectory, { allowMissing: true }) === port;
}

function sendJson(response, statusCode, value) {
  const content = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });
  response.end(content);
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function shutdown() {
  if (!standbyServer) return;
  standbyServer.close(() => process.exit(0));
  standbyServer.closeAllConnections?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
