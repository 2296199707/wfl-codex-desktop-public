import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOperationLock,
  RELEASE_LOCK_ACCEPTED_COMMANDS,
} from "../lib/operation-lock.mjs";
import {
  rescueVersionFromManifest,
  rescueVersionIsNewer,
} from "../lib/rescue-component.mjs";
import { renderServiceUnit, serviceUnitVariables } from "../lib/service-units.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  validateArguments({ help: true });
  console.log([
    "Usage: node scripts/update-rescue.mjs",
    "       node scripts/update-rescue.mjs --status",
    "       node scripts/update-rescue.mjs --worker",
  ].join("\n"));
  process.exit(0);
}
validateArguments();

const runtimeDir = path.resolve(process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"));
const configuredRescueSource = process.env.CODEX_DESKTOP_RESCUE_SOURCE_DIR
  ? path.resolve(process.env.CODEX_DESKTOP_RESCUE_SOURCE_DIR)
  : null;
const activeBackendPortFile = path.join(runtimeDir, "active-port");
// The rescue component is a single fixed slot. Keep the update transaction
// pointed at the same @4321 unit and slot that the installed service uses;
// creating a parallel non-template rescue.service would leave the real slot
// untouched and can make two services race for port 4321.
const rescueDirectory = path.join(runtimeDir, "rescue-slots", "4321");
const legacyRescueDirectories = [
  path.join(runtimeDir, "rescue"),
  path.join(runtimeDir, "rescue-slot"),
  path.join(runtimeDir, "rescue-slots", "4320"),
];
const backendSlotsDirectory = path.join(runtimeDir, "slots");
const statusFile = path.join(runtimeDir, "rescue-update.json");
const lockFile = path.join(runtimeDir, "rescue-update.lock");
const releaseLockFile = path.join(runtimeDir, "release.lock");
const systemctl = process.env.CODEX_DESKTOP_SYSTEMCTL || "systemctl";
const gatewayHost = process.env.CODEX_DESKTOP_UPSTREAM_HOST || "127.0.0.1";
const gatewayPort = Number(process.env.CODEX_DESKTOP_GATEWAY_PORT || 4317);
const rescuePort = process.env.CODEX_DESKTOP_RESCUE_TEST_MODE === "1"
  ? boundedPort(process.env.CODEX_DESKTOP_RESCUE_PORT, 4321)
  : 4321;
const readinessTimeoutMs = boundedDuration(process.env.CODEX_DESKTOP_RESCUE_READY_TIMEOUT_MS, 30_000, 500, 120_000);
const switchSettleMs = boundedDuration(process.env.CODEX_DESKTOP_RESCUE_SWITCH_SETTLE_MS, 1_000, 0, 10_000);
const rescueUnitPath = path.resolve(
  process.env.CODEX_DESKTOP_RESCUE_UNIT_PATH || "/etc/systemd/system/wfl-codex-desktop-rescue@.service",
);
const rescueRequiredAssets = Object.freeze([
  "public/rescue.html",
  "public/rescue.css",
  "public/rescue.js",
  "public/i18n.js",
  "node_modules/lucide/dist/umd/lucide.min.js",
  "node_modules/@fontsource/manrope/files/manrope-latin-400-normal.woff2",
  "node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff2",
  "node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
]);

try {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await rescueStatus(), null, 2));
  } else if (process.argv.includes("--worker")) {
    await runWorker();
  } else {
    await launchWorker();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function launchWorker() {
  const unit = `wfl-codex-rescue-update-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const args = [
    "--unit", unit,
    "--no-block",
    "--collect",
    "--property=Type=exec",
    `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDir}`,
    `--setenv=CODEX_DESKTOP_SYSTEMCTL=${systemctl}`,
    `--setenv=CODEX_DESKTOP_UPSTREAM_HOST=${gatewayHost}`,
    `--setenv=CODEX_DESKTOP_GATEWAY_PORT=${gatewayPort}`,
    ...(configuredRescueSource ? [`--setenv=CODEX_DESKTOP_RESCUE_SOURCE_DIR=${configuredRescueSource}`] : []),
    process.execPath,
    fileURLToPath(import.meta.url),
    "--worker",
  ];
  await run(process.env.CODEX_DESKTOP_SYSTEMD_RUN || "systemd-run", args);
  console.log(JSON.stringify({ unit, status: "queued" }));
}

async function runWorker() {
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const lock = await acquireOperationLock(lockFile, {
    ownerCommand: "scripts/update-rescue.mjs",
    acceptedCommands: ["scripts/update-rescue.mjs"],
    requiredArguments: ["--worker"],
    conflictMessage: "Another rescue component update is already running",
  });
  let releaseLock = null;
  let previousRescue = null;
  let previousVersion = null;
  let previousService = null;
  let previousUnit = null;
  let unitInstalled = false;
  try {
    // Main-site releases own release.lock while they may replace or clean
    // active release directories. Hold the same lock for the full rescue
    // transaction so a candidate cannot disappear underneath this update.
    releaseLock = await acquireOperationLock(releaseLockFile, {
      ownerCommand: "scripts/update-rescue.mjs",
      acceptedCommands: RELEASE_LOCK_ACCEPTED_COMMANDS,
      requiredArguments: ["--worker"],
      conflictMessage: "Another main-site release or rescue update is already running",
    });
    previousRescue = await readRescueState();
    previousVersion = previousRescue?.target ? await rescueSlotVersion(previousRescue.target) : null;
    previousService = await inspectServiceState(rescueUnit());
    const source = await activeStableRelease();
    const release = await verifyRescueRelease(source);
    if (previousVersion && !rescueVersionIsNewer(release.version, previousVersion)) {
      throw new Error(
        `Rescue component version must increase: current ${previousVersion}, candidate ${release.version}`,
      );
    }
    await ensureRescueDependencies(source);
    await verifyRescueAssets(source);
    await updateStatus({
      status: "running",
      phase: "preparing",
      detail: "正在准备固定 4321 备用服务",
      version: release.version,
      previousVersion,
      source,
      activePort: 4321,
      target: source,
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    });

    previousUnit = await fs.readFile(rescueUnitPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const candidateUnit = await renderCandidateRescueUnit(source);
    verifyBoundedRescueUnit(candidateUnit);
    await atomicWrite(rescueUnitPath, candidateUnit, 0o644);
    unitInstalled = true;
    await run(systemctl, ["daemon-reload"]);
    await updateStatus({
      phase: "forcing",
      detail: "正在执行强制升级；备用窗口中的运行任务可能中断并丢失",
    });
    await run(systemctl, ["disable", "--now", rescueUnit()]).catch(() => {});
    await replaceSymlink(rescueDirectory, source);
    await updateStatus({ phase: "starting", detail: "正在启动并验证固定 4321 备用服务" });
    await run(systemctl, ["enable", "--now", rescueUnit()]);
    await waitForRescue(rescuePort, release.version);
    if (await activeStableRelease() !== source) {
      throw new Error("The active stable release changed while the rescue candidate was being verified");
    }
    await updateStatus({ phase: "switching", detail: "验证通过，确认网关仍指向固定 4321" });
    await waitForGateway();
    if (switchSettleMs) await delay(switchSettleMs);
    await updateStatus({
      status: "completed",
      phase: "completed",
      detail: `独立救援组件 ${release.label} 已验证并固定在 4321`,
      activePort: 4321,
      target: source,
      completedAt: Date.now(),
    });
    console.log(JSON.stringify({
      ok: true,
      version: release.version,
      label: release.label,
      activePort: 4321,
    }));
  } catch (error) {
    await run(systemctl, ["disable", "--now", rescueUnit()]).catch(() => {});
    await restoreSymlink(rescueDirectory, previousRescue?.link || null).catch(() => {});
    if (unitInstalled) {
      if (previousUnit === null) await fs.rm(rescueUnitPath, { force: true }).catch(() => {});
      else await atomicWrite(rescueUnitPath, previousUnit, 0o644).catch(() => {});
      await run(systemctl, ["daemon-reload"]).catch(() => {});
    }
    await restoreServiceState(rescueUnit(), previousService || { active: false, enabled: false }).catch(() => {});
    if (previousService?.active && previousVersion) {
      await waitForRescue(rescuePort, previousVersion).catch(() => {});
      await waitForGateway().catch(() => {});
    }
    await updateStatus({
      status: "failed",
      phase: "failed",
      detail: "独立救援组件升级失败，已恢复固定 4321 原版本",
      activePort: 4321,
      target: previousRescue?.target || null,
      completedAt: Date.now(),
      error: error.message,
    }).catch(() => {});
    throw error;
  } finally {
    await releaseLock?.release().catch(() => {});
    await lock.release();
  }
}

async function renderCandidateRescueUnit(source) {
  const deployment = JSON.parse(await fs.readFile(path.join(runtimeDir, "deployment.json"), "utf8"));
  const template = await fs.readFile(
    path.join(source, "systemd", "wfl-codex-desktop-rescue@.service.template"),
    "utf8",
  );
  const variables = serviceUnitVariables({
    sourceDirectory: deployment.sourceDirectory,
    projectRoot: deployment.projectRoot,
    defaultProject: deployment.defaultProject,
    stateDirectory: deployment.stateDirectory,
    runtimeDirectory: deployment.runtimeDirectory,
    nodeBinary: deployment.nodeBinary,
    serviceHome: deployment.serviceHome,
    usersRoot: deployment.usersRoot,
    ownerCodexHome: deployment.ownerCodexHome,
    candidateReleasesEnabled: deployment.candidateReleasesEnabled === true,
  });
  return renderServiceUnit(template, variables);
}

function verifyBoundedRescueUnit(content) {
  const value = String(content);
  if (
    !/Restart=on-failure/.test(value)
    || !/StartLimitIntervalSec=(?:120s|2min)/.test(value)
    || !/StartLimitBurst=5/.test(value)
    || /Restart=always|StartLimitIntervalSec=0/.test(value)
  ) {
    throw new Error("Candidate rescue unit does not provide bounded restart protection");
  }
}

async function activeStableRelease() {
  if (configuredRescueSource) return await explicitRescueSource();
  const backendPort = Number((await fs.readFile(activeBackendPortFile, "utf8")).trim());
  if (![4318, 4319].includes(backendPort)) throw new Error("Active application backend port is invalid");
  const source = await fs.realpath(path.join(backendSlotsDirectory, String(backendPort)));
  const releasesRoot = await fs.realpath(path.join(runtimeDir, "releases"));
  const relative = path.relative(releasesRoot, source);
  if (
    !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || path.dirname(relative) !== "."
    || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(path.basename(relative))
  ) {
    throw new Error("Active application backend is not a verified release");
  }
  return source;
}

async function explicitRescueSource() {
  const source = await fs.realpath(configuredRescueSource);
  const candidatesRoot = await fs.realpath(path.join(runtimeDir, "rescue-candidates"));
  const relative = path.relative(candidatesRoot, source);
  const stat = await fs.lstat(source);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !relative
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || path.dirname(relative) !== "."
    || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(path.basename(relative))
  ) {
    throw new Error("Configured rescue source is not an immutable candidate directory");
  }
  return source;
}

async function verifyRescueRelease(directory) {
  const [packageJson, manifest] = await Promise.all([
    fs.readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(directory, ".codex-package.json"), "utf8").then(JSON.parse),
  ]);
  if (
    packageJson.version !== manifest.version
    || manifest.name !== packageJson.name
    || !manifest.capabilities?.includes("owner-rescue-v3")
    || !rescueReleaseDirectoryMatchesVersion(directory, packageJson.version)
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)
  ) {
    throw new Error("Active stable release does not declare the fixed-slot rescue capability");
  }
  await Promise.all([
    "server.mjs",
    "lib/rescue-plugin-store.mjs",
    "lib/rescue-chat-snapshot.mjs",
    "lib/rescue-reference-store.mjs",
    "lib/rescue-thread-registry.mjs",
    "lib/service-units.mjs",
    "lib/thread-write-lease.mjs",
    "public/rescue.html",
    "public/rescue.css",
    "public/rescue.js",
    "public/i18n.js",
    "scripts/update-rescue.mjs",
    "systemd/wfl-codex-desktop-rescue@.service.template",
  ].map((relativePath) => fs.access(path.join(directory, relativePath))));
  const version = rescueVersionFromManifest(manifest, packageJson.version);
  return { version, label: `${version}备用窗口` };
}

async function ensureRescueDependencies(directory) {
  const dependencyDirectory = path.resolve(
    process.env.CODEX_DESKTOP_RESCUE_DEPENDENCY_DIR || path.join(projectDir, "node_modules"),
  );
  const dependencyStat = await fs.stat(dependencyDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!dependencyStat?.isDirectory()) {
    throw new Error(`Rescue dependency directory is unavailable: ${dependencyDirectory}`);
  }

  const destination = path.join(directory, "node_modules");
  let destinationStat;
  try {
    destinationStat = await fs.lstat(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!destinationStat) {
    try {
      await fs.symlink(dependencyDirectory, destination, "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  const actual = await fs.realpath(destination);
  const expected = await fs.realpath(dependencyDirectory);
  if (actual !== expected) {
    throw new Error("Rescue candidate node_modules is not bound to the verified dependency directory");
  }
}

async function verifyRescueAssets(directory) {
  try {
    await Promise.all(rescueRequiredAssets.map((relativePath) => fs.access(path.join(directory, relativePath))));
  } catch (error) {
    throw new Error(`Rescue candidate is missing a required UI asset: ${error.path || error.message}`);
  }
}

function rescueReleaseDirectoryMatchesVersion(directory, version) {
  const name = path.basename(directory);
  const prefix = `v${version}`;
  if (name === prefix) return true;
  return name.startsWith(`${prefix}-`)
    && /^[a-f0-9]{12,64}$/.test(name.slice(prefix.length + 1));
}

async function rescueSlotVersion(slot) {
  try {
    const target = await fs.realpath(slot);
    const [packageJson, manifest] = await Promise.all([
      fs.readFile(path.join(target, "package.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(target, ".codex-package.json"), "utf8").then(JSON.parse).catch(() => null),
    ]);
    return rescueVersionFromManifest(manifest, packageJson.version);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function rescueStatus() {
  let operation = null;
  try {
    operation = JSON.parse(await fs.readFile(statusFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") operation = { status: "unknown", error: "状态文件无法读取" };
  }
  const current = await readRescueState();
  const target = current?.target || null;
  const version = target ? await rescueSlotVersion(target) : null;
  const service = await inspectServiceState(rescueUnit());
  return {
    activePort: 4321,
    target,
    version,
    service,
    // Keep the response shape consumable by older rescue UIs while exposing
    // exactly one active slot. There is no inactive validation slot anymore.
    slots: [{ port: 4321, active: true, target, version }],
    operation,
  };
}

async function waitForRescue(port, expectedVersion) {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const [ready, codexReady] = await Promise.all([
        fetchJson(`http://${gatewayHost}:${port}/internal/ready`, 2_000),
        fetchJson(`http://${gatewayHost}:${port}/internal/codex-ready`, 2_000),
      ]);
      if (
        ready.ok === true
        && ready.rescueMode === true
        && ready.version === expectedVersion
        && codexReady.ok === true
        && codexReady.version === expectedVersion
        && codexReady.codexReady === true
        && codexReady.threadListReady === true
        && codexReady.runtimeBundleReady === true
        && codexReady.codeModeHostReady === true
      ) return;
      lastError = `rescue or Codex deep-readiness payload did not match the staged release: ${JSON.stringify({
        rescue: {
          ok: ready.ok,
          rescueMode: ready.rescueMode,
          version: ready.version,
        },
        codex: {
          ok: codexReady.ok,
          version: codexReady.version,
          codexReady: codexReady.codexReady,
          threadListReady: codexReady.threadListReady,
          runtimeBundleReady: codexReady.runtimeBundleReady,
          codeModeHostReady: codexReady.codeModeHostReady,
        },
      })}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(200);
  }
  throw new Error(`Fixed rescue service ${port} did not become ready: ${lastError}`);
}

async function waitForGateway() {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await fetchJson(`http://${gatewayHost}:${gatewayPort}/internal/gateway-ready`, 2_000);
      if (
        ready.ok === true
        && ready.connectionPolicyVersion >= 5
        && ready.rescueFallback === false
        && ready.rescueChannelIsolated === true
        && ready.rescueUpstreamPort === rescuePort
      ) return;
    } catch {
      // The gateway keeps the rescue channel pinned to 4321.
    }
    await delay(200);
  }
  throw new Error("Stable gateway did not keep the rescue channel on 4321");
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function updateStatus(patch) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(statusFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(statusFile, `${JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }, null, 2)}\n`, 0o600);
}

async function readLink(filename) {
  try {
    return await fs.readlink(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRescueState() {
  for (const filename of [rescueDirectory, ...legacyRescueDirectories]) {
    const link = await readLink(filename);
    if (link === null) continue;
    try {
      return {
        path: filename,
        link: await fs.realpath(filename),
        target: await fs.realpath(filename),
      };
    } catch {
      return { path: filename, link, target: null };
    }
  }
  return null;
}

async function replaceSymlink(destination, target) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.symlink(target, temporary, "dir");
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function restoreSymlink(destination, target) {
  if (target === null) {
    await fs.rm(destination, { force: true });
    await syncDirectory(path.dirname(destination));
    return;
  }
  await replaceSymlink(destination, target);
}

async function atomicWrite(destination, content, mode) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, mode);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function rescueUnit() {
  return "wfl-codex-desktop-rescue@4321.service";
}

function validateArguments({ help = false } = {}) {
  const args = process.argv.slice(2);
  if (help) {
    if (args.length !== 1 || !["--help", "-h"].includes(args[0])) {
      throw new Error("Rescue update help cannot be combined with another action");
    }
    return;
  }
  if (args.length > 1 || (args.length === 1 && !["--status", "--worker"].includes(args[0]))) {
    throw new Error(`Unknown rescue update argument: ${args[0] || ""}`);
  }
}

async function inspectServiceState(unit) {
  return {
    active: await commandSucceeds(systemctl, ["is-active", "--quiet", unit]),
    enabled: await commandSucceeds(systemctl, ["is-enabled", "--quiet", unit]),
  };
}

async function restoreServiceState(unit, state) {
  if (state.enabled) {
    await run(systemctl, state.active ? ["enable", "--now", unit] : ["enable", unit]);
  } else {
    await run(systemctl, ["disable", unit]).catch(() => {});
    if (state.active) await run(systemctl, ["start", unit]);
  }
}

async function commandSucceeds(command, args) {
  try {
    await run(command, args);
    return true;
  } catch {
    return false;
  }
}

function boundedDuration(value, fallback, minimum, maximum) {
  const duration = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(duration) || duration < minimum || duration > maximum) {
    throw new Error("Invalid rescue update timeout");
  }
  return duration;
}

function boundedPort(value, fallback) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid rescue update port");
  }
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}
