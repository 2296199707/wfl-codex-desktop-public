import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertClaudeActivationAllowed,
  inspectClaudeCompatibility,
} from "../lib/claude-compatibility.mjs";
import {
  ACTIVE_CLAUDE_COMPONENT_PHASES,
  CLAUDE_COMPONENT_STALE_MS,
  CLAUDE_COMPONENT_VERSION,
  ClaudeComponentStatusStore,
  claudeComponentSnapshot,
  clearClaudeComponentDecision,
  managedClaudeComponentDirectory,
  previousClaudeComponentDirectory,
  readClaudeComponentDecision,
  writeClaudeComponentDecision,
} from "../lib/claude-component.mjs";

const execFileAsync = promisify(execFile);
const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDirectory, ".codex-runtime"),
);
const stateDirectory = path.resolve(
  process.env.CODEX_DESKTOP_STATE_DIR || path.join(projectDirectory, ".codex-desktop"),
);
const statusStore = new ClaudeComponentStatusStore(stateDirectory);
const lockPath = path.join(runtimeDirectory, "claude", "install.lock");
const repairMode = process.env.CODEX_DESKTOP_CLAUDE_REPAIR === "1";
const decisionMode = process.env.CODEX_DESKTOP_CLAUDE_DECISION || null;
const packageByArchitecture = {
  x64: {
    name: "@anthropic-ai/claude-code-linux-x64",
  },
  arm64: {
    name: "@anthropic-ai/claude-code-linux-arm64",
  },
};

try {
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await componentStatus(), null, 2));
  } else if (process.argv.includes("--worker")) {
    await runWorker();
  } else {
    await launchWorker();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function componentStatus() {
  return claudeComponentSnapshot({ runtimeDirectory, appDirectory: projectDirectory, statusStore });
}

async function launchWorker() {
  const current = await componentStatus();
  if (decisionMode && !["keep", "rollback"].includes(decisionMode)) {
    throw new Error("Claude Code 版本决定无效");
  }
  if (decisionMode && !current.pendingDecision) throw new Error("当前没有待决定的 Claude Code 升级");
  if (!decisionMode && current.pendingDecision) throw new Error("请先决定保留新版或恢复上一版 Claude Code");
  if (ACTIVE_CLAUDE_COMPONENT_PHASES.has(current.operation?.phase)) {
    throw new Error("Claude Code 安装任务已在运行");
  }
  if (!current.installSupported) throw new Error("当前服务器架构不支持网页安装 Claude Code");
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o755 });
  const unit = `wfl-claude-install-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await statusStore.write({
    phase: "queued",
    version: current.version || CLAUDE_COMPONENT_VERSION,
    detail: decisionMode === "keep"
      ? "等待确认保留新版 Claude Code"
      : decisionMode === "rollback"
        ? "等待恢复上一版 Claude Code"
        : repairMode
          ? "等待 Claude Code 修复任务启动"
          : "等待 Claude Code 更新检查",
    unit,
    startedAt: Date.now(),
    completedAt: null,
    error: null,
  });
  try {
    await execFileAsync("systemd-run", [
      `--unit=${unit}`,
      "--description=WFL Claude Code optional component install",
      `--property=WorkingDirectory=${projectDirectory}`,
      "--property=RuntimeMaxSec=20min",
      `--setenv=HOME=${process.env.HOME || "/root"}`,
      `--setenv=PATH=${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      `--setenv=CODEX_DESKTOP_STATE_DIR=${stateDirectory}`,
      `--setenv=CODEX_DESKTOP_RUNTIME_DIR=${runtimeDirectory}`,
      `--setenv=CODEX_DESKTOP_CLAUDE_REPAIR=${repairMode ? "1" : "0"}`,
      ...(decisionMode ? [`--setenv=CODEX_DESKTOP_CLAUDE_DECISION=${decisionMode}`] : []),
      "--collect",
      "--no-block",
      process.execPath,
      fileURLToPath(import.meta.url),
      "--worker",
    ], { cwd: projectDirectory, timeout: 10_000 });
  } catch (error) {
    await statusStore.write({
      phase: "failed",
      detail: "Claude Code 安装任务未能启动",
      completedAt: Date.now(),
      error: error.message,
    });
    throw error;
  }
  console.log(JSON.stringify({ ok: true, unit, status: "queued" }));
}

async function runWorker() {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o755 });
  const lock = await acquireInstallLock();
  let temporaryDirectory = null;
  try {
    if (decisionMode) {
      await resolvePendingDecision(decisionMode);
      return;
    }
    const selected = packageByArchitecture[process.arch];
    if (process.platform !== "linux" || !selected) throw new Error("当前服务器架构不受支持");
    const existing = await componentStatus();
    if (existing.pendingDecision) throw new Error("请先决定保留新版或恢复上一版 Claude Code");
    const latest = await inspectLatestPackage(selected.name);
    if (existing.ready && existing.version === latest.version && !repairMode) {
      await statusStore.write({
        phase: "completed",
        version: existing.version,
        detail: `Claude Code ${existing.version} 已是官方最新版`,
        completedAt: Date.now(),
        error: null,
      });
      return;
    }
    const disk = await fs.statfs(runtimeDirectory);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (availableBytes < 700 * 1024 * 1024) throw new Error("安装 Claude Code 至少需要 700 MB 可用空间");

    await statusStore.write({
      phase: "downloading",
      version: latest.version,
      detail: `正在下载 Claude Code ${latest.version}`,
    });
    temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(lockPath), ".install-"));
    const downloadDirectory = path.join(temporaryDirectory, "download");
    const extractDirectory = path.join(temporaryDirectory, "extract");
    await fs.mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(extractDirectory, { recursive: true, mode: 0o700 });
    const { stdout } = await execFileAsync("npm", [
      "pack",
      `${selected.name}@${latest.version}`,
      "--json",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      `--pack-destination=${downloadDirectory}`,
    ], { cwd: temporaryDirectory, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
    const packed = JSON.parse(stdout).at(0);
    if (!packed?.filename) throw new Error("Claude Code 下载结果无效");
    const archive = path.join(downloadDirectory, packed.filename);
    await verifyIntegrity(archive, latest.integrity);
    await execFileAsync("tar", ["-xzf", archive, "-C", extractDirectory], {
      cwd: temporaryDirectory,
      timeout: 2 * 60_000,
    });
    const candidateDirectory = path.join(extractDirectory, "package");
    const candidateCommand = path.join(candidateDirectory, "claude");
    await fs.chmod(candidateDirectory, 0o755);
    await fs.chmod(candidateCommand, 0o755);

    await statusStore.write({ phase: "verifying", detail: "正在验证 Claude CLI、Doctor 与协议兼容性" });
    const { stdout: versionOutput } = await execFileAsync(candidateCommand, ["--version"], {
      cwd: projectDirectory,
      timeout: 20_000,
      maxBuffer: 128 * 1024,
    });
    if (!versionOutput.includes(latest.version)) {
      throw new Error("下载的 Claude Code 版本与官方目标版本不一致");
    }
    const compatibility = await inspectClaudeCompatibility({ command: candidateCommand, projectDirectory });
    assertClaudeActivationAllowed(compatibility);
    await fs.writeFile(path.join(candidateDirectory, "component.json"), `${JSON.stringify({
      name: "Claude Code",
      version: latest.version,
      package: selected.name,
      integrity: latest.integrity,
      activationAllowed: true,
      compatibilityRisk: compatibility.risk,
      installedAt: Date.now(),
    }, null, 2)}\n`, { mode: 0o644 });

    const target = managedClaudeComponentDirectory(runtimeDirectory);
    const previous = previousClaudeComponentDirectory(runtimeDirectory);
    await fs.rm(previous, { recursive: true, force: true });
    let hadPrevious = false;
    try {
      await fs.rename(target, previous);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(candidateDirectory, target);
    } catch (error) {
      if (hadPrevious) await fs.rename(previous, target).catch(() => {});
      throw error;
    }
    const decisionRequired = compatibility.decisionRequired === true
      && existing.version !== latest.version;
    if (decisionRequired) {
      try {
        await writeClaudeComponentDecision(runtimeDirectory, {
          beforeVersion: existing.version,
          afterVersion: latest.version,
          previousSource: hadPrevious ? "managed" : existing.source || "none",
          pendingAt: Date.now(),
        });
      } catch (error) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        if (hadPrevious) await fs.rename(previous, target).catch(() => {});
        throw error;
      }
    } else {
      await fs.rm(previous, { recursive: true, force: true });
      await clearClaudeComponentDecision(runtimeDirectory);
    }
    await statusStore.write({
      phase: "completed",
      version: latest.version,
      detail: decisionRequired
        ? `Claude Code ${latest.version} 已启用；请查看受限功能并决定保留或恢复上一版`
        : `Claude Code ${latest.version} 已安装并通过兼容性检查`,
      completedAt: Date.now(),
      error: null,
    });
  } catch (error) {
    await statusStore.write({
      phase: "failed",
      version: null,
      detail: "Claude Code 安装失败，Codex 服务未受影响",
      completedAt: Date.now(),
      error: error.message,
    }).catch(() => {});
    throw error;
  } finally {
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    await lock?.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function resolvePendingDecision(decision) {
  if (!["keep", "rollback"].includes(decision)) throw new Error("Claude Code 版本决定无效");
  const current = await componentStatus();
  const pending = current.pendingDecision || await readClaudeComponentDecision(runtimeDirectory);
  if (!pending) throw new Error("当前没有待决定的 Claude Code 升级");
  const target = managedClaudeComponentDirectory(runtimeDirectory);
  const previous = previousClaudeComponentDirectory(runtimeDirectory);
  if (decision === "keep") {
    await fs.rm(previous, { recursive: true, force: true });
    await clearClaudeComponentDecision(runtimeDirectory);
    await statusStore.write({
      phase: "completed",
      version: pending.afterVersion,
      detail: `Claude Code ${pending.afterVersion} 已由所有者确认保留`,
      completedAt: Date.now(),
      error: null,
    });
    return;
  }

  const discarded = `${target}.discarded-${process.pid}`;
  await fs.rm(discarded, { recursive: true, force: true });
  await fs.rename(target, discarded);
  let previousRestored = false;
  try {
    if (pending.previousSource === "managed") {
      await fs.rename(previous, target);
      previousRestored = true;
    }
    const restored = await componentStatus();
    if (pending.beforeVersion) {
      if (!restored.installed || restored.version !== pending.beforeVersion) {
        throw new Error("恢复后的 Claude Code 版本与上一版记录不一致");
      }
    } else if (restored.source === "managed") {
      throw new Error("Claude Code 首次安装回退未移除托管组件");
    }
    await clearClaudeComponentDecision(runtimeDirectory);
    await fs.rm(discarded, { recursive: true, force: true });
    await statusStore.write({
      phase: "completed",
      version: restored.version,
      detail: restored.installed
        ? `Claude Code 已恢复到 ${restored.version}`
        : "Claude Code 新安装已撤销",
      completedAt: Date.now(),
      error: null,
    });
  } catch (error) {
    if (previousRestored) await fs.rename(target, previous).catch(() => {});
    await fs.rename(discarded, target).catch(() => {});
    throw error;
  }
}

async function inspectLatestPackage(packageName) {
  await statusStore.write({ phase: "verifying", detail: "正在查询 Claude Code 官方最新版" });
  const { stdout } = await execFileAsync("npm", [
    "view",
    `${packageName}@latest`,
    "version",
    "dist.integrity",
    "--json",
    "--registry=https://registry.npmjs.org",
  ], { cwd: projectDirectory, timeout: 30_000, maxBuffer: 256 * 1024 });
  const value = JSON.parse(stdout);
  const version = String(value?.version || "");
  const integrity = String(value?.["dist.integrity"] || "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
    throw new Error("Claude Code 官方版本元数据无效");
  }
  return { version, integrity };
}

async function acquireInstallLock() {
  try {
    return await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= CLAUDE_COMPONENT_STALE_MS) {
      throw new Error("另一项 Claude Code 安装正在运行");
    }
    await fs.unlink(lockPath).catch(() => {});
    try {
      return await fs.open(lockPath, "wx", 0o600);
    } catch (retryError) {
      if (retryError.code === "EEXIST") throw new Error("另一项 Claude Code 安装正在运行");
      throw retryError;
    }
  }
}

async function verifyIntegrity(filePath, expected) {
  const [algorithm, digest] = expected.split("-", 2);
  if (algorithm !== "sha512" || !digest) throw new Error("Claude Code 完整性基线无效");
  const hash = crypto.createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const actual = hash.digest("base64");
  if (actual !== digest) throw new Error("Claude Code 下载包完整性校验失败");
}
