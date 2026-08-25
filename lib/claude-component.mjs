import fs from "node:fs/promises";
import path from "node:path";

export const CLAUDE_COMPONENT_VERSION = "2.1.236";
export const ACTIVE_CLAUDE_COMPONENT_PHASES = new Set(["queued", "downloading", "verifying"]);
export const CLAUDE_COMPONENT_STALE_MS = 25 * 60_000;

const PHASES = new Set(["idle", ...ACTIVE_CLAUDE_COMPONENT_PHASES, "completed", "failed"]);

export class ClaudeComponentStatusStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.filePath = path.join(stateDirectory, "claude-component-status.json");
    this.now = now;
  }

  async read() {
    try {
      return normalizeStatus(JSON.parse(await fs.readFile(this.filePath, "utf8")), this.now());
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return idleStatus(this.now());
      throw error;
    }
  }

  async write(update) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const current = await this.read();
    const value = normalizeStatus({ ...current, ...update, updatedAt: this.now() }, this.now());
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
    return value;
  }
}

export function managedClaudeComponentDirectory(runtimeDirectory) {
  return path.join(runtimeDirectory, "claude", "current");
}

export function previousClaudeComponentDirectory(runtimeDirectory) {
  return path.join(runtimeDirectory, "claude", "previous");
}

export function claudeComponentDecisionPath(runtimeDirectory) {
  return path.join(runtimeDirectory, "claude", "pending-decision.json");
}

export function managedClaudeCommand(runtimeDirectory) {
  return path.join(managedClaudeComponentDirectory(runtimeDirectory), "claude");
}

export function bundledClaudeCommand(appDirectory) {
  return path.join(appDirectory, "node_modules", ".bin", "claude");
}

export async function claudeComponentSnapshot({
  runtimeDirectory,
  appDirectory,
  commandOverride = null,
  statusStore = new ClaudeComponentStatusStore(path.join(appDirectory, ".codex-desktop")),
  now = () => Date.now(),
} = {}) {
  const storedOperation = await statusStore.read();
  const operation = ACTIVE_CLAUDE_COMPONENT_PHASES.has(storedOperation.phase)
    && now() - (storedOperation.updatedAt || storedOperation.startedAt || 0) > CLAUDE_COMPONENT_STALE_MS
    ? {
        ...storedOperation,
        status: "failed",
        phase: "failed",
        detail: "Claude Code 安装任务已失联，可以重新安装",
        error: "后台安装任务超过时限且未更新状态",
      }
    : storedOperation;
  const candidates = commandOverride
    ? [{ source: "override", command: commandOverride, version: CLAUDE_COMPONENT_VERSION }]
    : [
        {
          source: "managed",
          command: managedClaudeCommand(runtimeDirectory),
          metadata: path.join(managedClaudeComponentDirectory(runtimeDirectory), "component.json"),
        },
        {
          source: "bundled",
          command: bundledClaudeCommand(appDirectory),
          metadata: path.join(appDirectory, "node_modules", "@anthropic-ai", "claude-code", "package.json"),
        },
      ];
  let selected = null;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate.command, fs.constants.X_OK);
      let version = candidate.version || null;
      let metadata = null;
      if (!version && candidate.metadata) {
        metadata = JSON.parse(await fs.readFile(candidate.metadata, "utf8"));
        version = typeof metadata.version === "string" ? metadata.version : null;
      }
      selected = { ...candidate, version, metadata };
      break;
    } catch {
      // Continue to the legacy bundled installation when the managed component is absent.
    }
  }
  const installed = Boolean(selected);
  const ready = installed && (
    selected.version === CLAUDE_COMPONENT_VERSION
    || selected.metadata?.activationAllowed === true
  );
  const pendingDecision = await readClaudeComponentDecision(runtimeDirectory, selected);
  const installing = ACTIVE_CLAUDE_COMPONENT_PHASES.has(operation.phase);
  const state = installing
    ? "installing"
    : ready
      ? "ready"
      : installed
        ? "version-drift"
        : operation.phase === "failed"
          ? "failed"
          : "not-installed";
  return {
    installed,
    ready,
    state,
    version: selected?.version || null,
    reviewedVersion: CLAUDE_COMPONENT_VERSION,
    source: selected?.source || null,
    pendingDecision,
    installSupported: process.platform === "linux" && ["x64", "arm64"].includes(process.arch),
    operation,
  };
}

export async function readClaudeComponentDecision(runtimeDirectory, selected = null) {
  try {
    const value = JSON.parse(await fs.readFile(claudeComponentDecisionPath(runtimeDirectory), "utf8"));
    if (value?.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(String(value.afterVersion || ""))) {
      throw new Error("Claude component decision record is invalid");
    }
    if (selected?.version && selected.version !== value.afterVersion) return null;
    return {
      beforeVersion: /^\d+\.\d+\.\d+$/.test(String(value.beforeVersion || ""))
        ? value.beforeVersion
        : null,
      afterVersion: value.afterVersion,
      previousSource: ["managed", "bundled", "none"].includes(value.previousSource)
        ? value.previousSource
        : "none",
      pendingAt: Number.isFinite(value.pendingAt) ? value.pendingAt : null,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeClaudeComponentDecision(runtimeDirectory, value) {
  const filePath = claudeComponentDecisionPath(runtimeDirectory);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  return readClaudeComponentDecision(runtimeDirectory);
}

export async function clearClaudeComponentDecision(runtimeDirectory) {
  await fs.rm(claudeComponentDecisionPath(runtimeDirectory), { force: true });
}

function normalizeStatus(value, now) {
  const phase = PHASES.has(value?.phase) ? value.phase : "idle";
  return {
    status: ACTIVE_CLAUDE_COMPONENT_PHASES.has(phase)
      ? "running"
      : phase === "completed"
        ? "completed"
        : phase === "failed"
          ? "failed"
          : "idle",
    phase,
    version: clean(value?.version, 80),
    detail: clean(value?.detail, 240),
    unit: clean(value?.unit, 160),
    startedAt: timestamp(value?.startedAt),
    updatedAt: timestamp(value?.updatedAt) || now,
    completedAt: timestamp(value?.completedAt),
    error: clean(value?.error, 500),
  };
}

function idleStatus(now) {
  return normalizeStatus({ phase: "idle", updatedAt: now }, now);
}

function clean(value, limit) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}
