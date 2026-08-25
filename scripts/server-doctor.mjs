import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCodexInstallation } from "../lib/codex-prerequisite.mjs";
import { PublicOriginConfigStore } from "../lib/public-origin-config.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDir = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"),
);
const stateDir = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(projectDir, ".codex-desktop"),
);
const checkRescue = process.argv.includes("--rescue") || !process.argv.includes("--main-only");
if (checkRescue && process.argv.includes("--main-only")) {
  throw new Error("--main-only and --rescue cannot be used together");
}
const version = (await fs.readFile(path.join(projectDir, "VERSION"), "utf8")).trim();
const results = [];

await check("Official Codex CLI and app-server", async () => {
  const installation = await inspectCodexInstallation();
  return installation.version;
});
await check("Deployment recovery circuit breaker", async () => {
  const failurePath = path.join(runtimeDir, "deployment-recovery-failure.json");
  let failure;
  try {
    const stat = await fs.stat(failurePath);
    if (!stat.isFile() || stat.size > 32_768) throw new Error("invalid failure record");
    failure = JSON.parse(await fs.readFile(failurePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "clear";
    throw error;
  }
  const errors = Array.isArray(failure?.errors) ? failure.errors : [];
  const summary = errors
    .filter((entry) => ["codex", "topology"].includes(entry?.stage) && typeof entry?.message === "string")
    .slice(0, 2)
    .map((entry) => `${entry.stage}: ${entry.message.slice(0, 240)}`)
    .join("; ");
  if (failure?.status !== "failed" || !summary) throw new Error("invalid failure record");
  throw new Error(summary);
});
await check("Password record", async () => {
  const auth = await fs.stat(path.join(stateDir, "auth.json"));
  if (!auth.isFile() || auth.size === 0) throw new Error("missing");
  if ((auth.mode & 0o077) !== 0) throw new Error("permissions must be 0600");
  return "private file present";
});
await check("Domain-neutral project preview", async () => {
  const config = await new PublicOriginConfigStore(stateDir).initialize();
  const snapshot = config.snapshot();
  if (snapshot.mode === "unconfigured") return "sandbox fallback (no public Origin confirmed)";
  if (snapshot.mode !== "confirmed" || !snapshot.publicOrigin || snapshot.previewOrigins.length !== snapshot.slotCount) {
    throw new Error("invalid public Origin state");
  }
  return `${snapshot.publicOrigin} with ${snapshot.slotCount} preview Origin(s), ${snapshot.isolation || "pool"} isolation`;
});
await check("Stable gateway service", async () => {
  const state = (await capture("systemctl", ["is-active", "wfl-codex-desktop-gateway.service"])).trim();
  if (state !== "active") throw new Error(state || "inactive");
  return state;
});
if (checkRescue) {
  await check("Independent owner rescue service", async () => {
    const unit = "wfl-codex-desktop-rescue.service";
    const configured = await pathExists(path.join(runtimeDir, "rescue"));
    if (!configured) return "not configured (main-site installation preserved rescue)";
    const state = await capture("systemctl", ["is-active", unit]).then((value) => value.trim(), () => "inactive");
    if (state !== "active") throw new Error(`${unit} is ${state || "inactive"}`);
    const ready = await fetchJson("http://127.0.0.1:4321/internal/ready", 5_000);
    if (ready.ok !== true || ready.rescueMode !== true) throw new Error("invalid rescue readiness response");
    return `v${ready.version} on 4321`;
  });
}
await check("Loopback gateway", async () => {
  const gateway = await fetchJson("http://127.0.0.1:4317/internal/gateway-ready", 5_000);
  if (
    gateway.ok !== true
    || ![4318, 4319].includes(gateway.upstreamPort)
    || gateway.connectionPolicyVersion !== 8
    || gateway.keepAliveTimeoutMs !== 120_000
    || gateway.rescueUpstreamPort !== 4321
    || gateway.rescueUpstreamPorts?.join(",") !== "4321"
    || gateway.rescueFallback !== false
    || gateway.rescueChannelIsolated !== true
  ) {
    throw new Error("invalid gateway readiness response");
  }
  return `backend ${gateway.upstreamPort}, HTTP policy v${gateway.connectionPolicyVersion}`;
});
await check("Codex deep readiness", async () => {
  const activePort = Number((await fs.readFile(path.join(runtimeDir, "active-port"), "utf8")).trim());
  const ready = await fetchJson(`http://127.0.0.1:${activePort}/internal/codex-ready`, 8_000);
  if (
    ready.version !== version
    || ready.threadListReady !== true
    || ready.runtimeBundleReady !== true
    || ready.codeModeHostReady !== true
    || typeof ready.codexTarget !== "string"
    || !/^[a-f0-9]{64}$/iu.test(ready.codexRuntimeSha256 || "")
    || !/^[a-f0-9]{64}$/iu.test(ready.codexCodeModeHostSha256 || "")
  ) {
    throw new Error("thread/list or Codex runtime bundle verification failed");
  }
  return `v${ready.version}, Codex ${ready.codexVersion || "unknown"}, ${ready.threadsObserved ?? 0} thread(s) observed`;
});
await check("Loopback-only service units", async () => {
  const servicePaths = [
    fs.readFile("/etc/systemd/system/wfl-codex-desktop-gateway.service", "utf8"),
    fs.readFile("/etc/systemd/system/wfl-codex-desktop-backend@.service", "utf8"),
  ];
  if (checkRescue && await pathExists(path.join(runtimeDir, "rescue"))) {
    servicePaths.push(fs.readFile("/etc/systemd/system/wfl-codex-desktop-rescue.service", "utf8"));
  }
  const units = await Promise.all(servicePaths);
  if (units.some((unit) => !unit.includes("Environment=HOST=127.0.0.1"))) {
    throw new Error("a service is not bound to loopback");
  }
  return "127.0.0.1 only";
});

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`);
}
if (results.some((result) => !result.ok)) process.exitCode = 1;

async function check(name, operation) {
  try {
    results.push({ name, ok: true, detail: await operation() });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}`);
  return data;
}

function pathExists(filename) {
  return fs.access(filename).then(() => true, () => false);
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}
