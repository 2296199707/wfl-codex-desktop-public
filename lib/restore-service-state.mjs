import { spawn } from "node:child_process";

export const RESTORE_DATA_SERVICE_UNITS = Object.freeze([
  "wfl-codex-desktop-backend@4318.service",
  "wfl-codex-desktop-backend@4319.service",
  "wfl-codex-desktop.service",
]);

const ACTIVE_STATES = new Set(["active", "activating", "reloading", "deactivating"]);
const INACTIVE_STATES = new Set(["inactive", "failed", "dead", "unknown"]);

export async function assertRestoreDataServicesInactive({
  allowedActiveUnits = [],
  readState = readSystemdUnitState,
} = {}) {
  const allowed = new Set(allowedActiveUnits);
  if ([...allowed].some((unit) => !RESTORE_DATA_SERVICE_UNITS.includes(unit))) {
    throw new TypeError("Invalid allowed restore data service");
  }
  const states = await Promise.all(RESTORE_DATA_SERVICE_UNITS.map(async (unit) => ({
    unit,
    state: await readState(unit),
  })));
  const conflict = states.find(({ unit, state }) => ACTIVE_STATES.has(state) && !allowed.has(unit));
  if (conflict) {
    const error = new Error(`${conflict.unit} 仍在运行，拒绝修改备份恢复目录`);
    error.code = "ERR_RESTORE_DATA_SERVICE_ACTIVE";
    throw error;
  }
  return states;
}

export async function systemdUnitIsActive(unit, options) {
  return ACTIVE_STATES.has(await readSystemdUnitState(unit, options));
}

export function readSystemdUnitState(unit, { timeoutMs = 3_000 } = {}) {
  if (!RESTORE_DATA_SERVICE_UNITS.includes(unit)) throw new TypeError("Invalid restore data service");
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", ["is-active", unit], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(serviceStateError(`无法确认 ${unit} 是否停止`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => (stdout = `${stdout}${chunk}`.slice(-100)));
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-1000)));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const state = stdout.trim();
      if (ACTIVE_STATES.has(state) || INACTIVE_STATES.has(state)) resolve(state);
      else reject(serviceStateError(stderr.trim() || `无法确认 ${unit} 是否停止`));
    });
  });
}

function serviceStateError(message) {
  const error = new Error(message);
  error.code = "ERR_RESTORE_DATA_SERVICE_UNKNOWN";
  return error;
}
