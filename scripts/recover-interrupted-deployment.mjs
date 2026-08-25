import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileDeploymentRecoveryStatus } from "../lib/deployment-recovery-status.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = path.resolve(process.env.CODEX_DESKTOP_SOURCE_DIR || projectDirectory);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime"),
);
const failurePath = path.join(runtimeDirectory, "deployment-recovery-failure.json");
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(sourceDirectory, ".codex-desktop"),
);

const errors = [];
const preparedIdentity = await readPreparedIdentity();
await attemptRecovery("codex", () => [path.join(sourceDirectory, "scripts", "recover-codex-update.mjs")]);
// OnFailure can be scheduled while the original release unit is still
// unwinding.  In that case deploy.mjs must report a deferred recovery instead
// of competing with the live owner; the independent watchdog will retry after
// the owner is gone.
process.env.CODEX_DESKTOP_RECOVERY_DEFER_IF_ACTIVE = "1";
await attemptRecovery("topology", topologyRecoveryArguments);

if (errors.length > 0) {
  if (preparedIdentity?.operationId) {
    await reconcileDeploymentRecoveryStatus({
      stateDirectory,
      operationId: preparedIdentity.operationId,
      version: preparedIdentity.version,
      outcome: "failed",
      error: errors.map(({ stage, message }) => `${stage}: ${message}`).join("; "),
      detail: "中断恢复未能完成，已保留可恢复状态",
    }).catch(() => {});
  }
  await durableWriteFailure({
    schemaVersion: 1,
    status: "failed",
    failedAt: Date.now(),
    errors,
  });
  throw new Error(errors.map(({ stage, message }) => `${stage}: ${message}`).join("; "));
}
await fs.rm(failurePath, { force: true });

async function readPreparedIdentity() {
  try {
    const value = JSON.parse(await fs.readFile(path.join(runtimeDirectory, "prepared-deployment.json"), "utf8"));
    return {
      operationId: validOperationId(value?.operationId) ? value.operationId : null,
      version: validVersion(value?.version) ? value.version : null,
      watchToken: validWatchToken(value?.watchToken) ? value.watchToken : null,
      ownerPid: Number.isSafeInteger(value?.ownerPid) && value.ownerPid > 1 ? value.ownerPid : null,
      ownerStartTicks: /^\d+$/.test(value?.ownerStartTicks || "") ? value.ownerStartTicks : null,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function attemptRecovery(stage, argsOrFactory) {
  try {
    const args = typeof argsOrFactory === "function" ? await argsOrFactory() : argsOrFactory;
    await run(process.execPath, args);
  } catch (error) {
    errors.push({ stage, message: error.message });
  }
}

async function durableWriteFailure(value) {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });
  const temporary = `${failurePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, failurePath);
}

async function topologyRecoveryArguments() {
  const args = [path.join(sourceDirectory, "scripts", "deploy.mjs"), "--recover-staged"];
  const manifestPath = path.join(runtimeDirectory, "prepared-deployment.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (validOperationId(manifest?.operationId)) args.push("--operation-id", manifest.operationId);
    if (validVersion(manifest?.version)) args.push("--version", manifest.version);
    const identity = await readPreparedIdentity();
    const watchdogToken = await readWatchdogToken(identity);
    if (watchdogToken) process.env.CODEX_DESKTOP_DEPLOYMENT_WATCH_TOKEN = watchdogToken;
  } catch (error) {
    if (error.code === "ERR_DEPLOYMENT_WATCHDOG_ATTESTATION") throw error;
    if (error.code !== "ENOENT") {
      // Let deploy.mjs perform the authoritative manifest validation.  The
      // recovery service must still run it so a malformed or raced manifest
      // is recorded through the normal topology failure path.
    }
  }
  return args;
}

async function readWatchdogToken(identity) {
  if (
    !identity?.operationId
    || !identity.watchToken
    || !identity.ownerPid
    || !identity.ownerStartTicks
  ) return null;
  const readyPath = path.join(
    runtimeDirectory,
    "deployment-watchdogs",
    `${identity.operationId}.json`,
  );
  try {
    const stat = await fs.lstat(readyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) {
      const error = new Error("Deployment recovery watchdog attestation is unsafe");
      error.code = "ERR_DEPLOYMENT_WATCHDOG_ATTESTATION";
      throw error;
    }
    const ready = JSON.parse(await fs.readFile(readyPath, "utf8"));
    if (
      ready?.schemaVersion !== 1
      || ready.operationId !== identity.operationId
      || ready.token !== identity.watchToken
      || ready.ownerPid !== identity.ownerPid
      || ready.ownerStartTicks !== identity.ownerStartTicks
      || !Number.isSafeInteger(ready.watcherPid)
      || ready.watcherPid <= 1
      || !/^\d+$/.test(ready.watcherStartTicks || "")
    ) {
      const error = new Error("Deployment recovery watchdog identity does not match the staged deployment");
      error.code = "ERR_DEPLOYMENT_WATCHDOG_ATTESTATION";
      throw error;
    }
    return ready.token;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validOperationId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value);
}

function validVersion(value) {
  return typeof value === "string"
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function validWatchToken(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: sourceDirectory,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0])} failed (${code ?? signal})`));
    });
  });
}
