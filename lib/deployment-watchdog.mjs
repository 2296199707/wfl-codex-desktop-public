import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { deploymentOperationUnit } from "./deployment-operation.mjs";

const START_TIMEOUT_MS = 5_000;
const SYSTEMCTL_TIMEOUT_MS = 3_000;

export const DEPLOYMENT_RECOVERY_RESERVE_MS = 18_000;

export async function startDeploymentWatchdog({
  sourceDirectory,
  runtimeDirectory,
  operationId,
  systemdRunCommand = "systemd-run",
  systemctlCommand = "systemctl",
  environment = process.env,
  startTimeoutMs = START_TIMEOUT_MS,
  launcherTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  if (!Number.isFinite(startTimeoutMs) || startTimeoutMs < 10 || startTimeoutMs > START_TIMEOUT_MS) {
    throw new Error("Invalid deployment watchdog start timeout");
  }
  if (!Number.isFinite(launcherTimeoutMs) || launcherTimeoutMs < 10 || launcherTimeoutMs > START_TIMEOUT_MS) {
    throw new Error("Invalid deployment watchdog launcher timeout");
  }
  if (!validOperationId(operationId)) throw new Error("A valid deployment operation ID is required");
  const ownerUnit = deploymentOperationUnit(operationId);
  if (!ownerUnit) throw new Error("Deployment watchdog requires a verified systemd operation unit");
  const ownerPid = process.pid;
  const ownerStartTicks = await readProcessStartTicks(ownerPid);
  if (ownerStartTicks === null) throw new Error("Cannot identify the deployment watchdog owner");
  const token = crypto.randomUUID();
  const unit = `wfl-codex-deployment-watch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const readyDirectory = path.join(runtimeDirectory, "deployment-watchdogs");
  const readyFile = path.join(readyDirectory, `${operationId}.json`);
  await fs.mkdir(readyDirectory, { recursive: true, mode: 0o700 });
  await fs.rm(readyFile, { force: true });

  await run(systemdRunCommand, [
    `--unit=${unit}`,
    "--description=WFL Codex Desktop deployment recovery watchdog",
    `--property=WorkingDirectory=${sourceDirectory}`,
    "--property=RuntimeMaxSec=25min",
    "--property=StartLimitIntervalSec=120s",
    "--property=StartLimitBurst=45",
    `--setenv=HOME=${environment.HOME || "/root"}`,
    `--setenv=PATH=${environment.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
    `--setenv=CODEX_DESKTOP_SOURCE_DIR=${sourceDirectory}`,
    `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDirectory}`,
    `--setenv=CODEX_DESKTOP_SYSTEMCTL=${systemctlCommand}`,
    `--setenv=CODEX_DESKTOP_WATCH_OPERATION_ID=${operationId}`,
    `--setenv=CODEX_DESKTOP_WATCH_OWNER_PID=${ownerPid}`,
    `--setenv=CODEX_DESKTOP_WATCH_OWNER_START_TICKS=${ownerStartTicks}`,
    `--setenv=CODEX_DESKTOP_WATCH_OWNER_UNIT=${ownerUnit}`,
    `--setenv=CODEX_DESKTOP_WATCH_READY_FILE=${readyFile}`,
    `--setenv=CODEX_DESKTOP_WATCH_TOKEN=${token}`,
    "--collect",
    "--no-block",
    process.execPath,
    path.join(sourceDirectory, "scripts", "watch-deployment.mjs"),
  ], { cwd: sourceDirectory, timeoutMs: launcherTimeoutMs });
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    const ready = await readJson(readyFile);
    if (
      ready?.token === token
      && ready.operationId === operationId
      && ready.ownerPid === ownerPid
      && ready.ownerStartTicks === ownerStartTicks
      && ready.ownerUnit === ownerUnit
      && Number.isSafeInteger(ready.watcherPid)
      && ready.watcherPid > 1
      && /^\d+$/.test(ready.watcherStartTicks || "")
    ) {
      return {
        unit,
        token,
        async assertActive() {
          const state = await capture(systemctlCommand, ["is-active", unit], {
            cwd: sourceDirectory,
            timeoutMs: SYSTEMCTL_TIMEOUT_MS,
          });
          if (state.code !== 0 || state.stdout.trim() !== "active") {
            throw new Error("Deployment recovery watchdog is not active");
          }
        },
      };
    }
    await delay(50);
  }
  throw new Error("Deployment recovery watchdog did not become ready");
}

async function readProcessStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) throw new Error("Invalid process identity");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || "") ? fields[19] : null;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function run(command, args, { cwd, timeoutMs = START_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

function capture(command, args, { cwd, timeoutMs = SYSTEMCTL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_024) stdout += chunk;
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: "" });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

function validOperationId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
