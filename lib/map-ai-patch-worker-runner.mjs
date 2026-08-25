import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("../scripts/map-ai-patch-worker.mjs", import.meta.url));
const DEFAULT_POLL_MS = 250;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TASK_STALE_MS = 2 * 60 * 60 * 1_000;
const ENVIRONMENT_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS"];

/**
 * Runs map patch parsing/preview/candidate generation outside the main Node
 * process. The worker only reads the authorized map and writes a candidate
 * into a private task directory; it never commits to the project.
 */
export function createMapAiPatchWorkerRunner({
  runtimeDirectory,
  workerPath = DEFAULT_WORKER_PATH,
  spawnProcess = spawn,
  systemdRunCommand = "systemd-run",
  systemctlCommand = "systemctl",
  stopUnit = null,
  useSystemd = false,
  pollMs = DEFAULT_POLL_MS,
  processTreeMemory = processTreeRssBytes,
  now = () => Date.now(),
} = {}) {
  const runtimeRoot = path.resolve(runtimeDirectory || "");
  if (!path.isAbsolute(runtimeRoot) || runtimeRoot === path.parse(runtimeRoot).root) {
    throw new TypeError("A bounded map AI worker runtime directory is required");
  }
  const workerFile = path.resolve(workerPath);
  const intervalMs = boundedInteger(pollMs, DEFAULT_POLL_MS, 25, 10_000);
  const active = new Map();
  let closed = false;
  let initialized = null;

  const initialize = () => {
    if (!initialized) initialized = recoverTaskDirectories(runtimeRoot, now);
    return initialized;
  };

  async function run(job, { signal = null } = {}) {
    if (closed) throw workerError("MAP_AI_WORKER_CLOSED", "地图 AI Worker 已关闭");
    assertJob(job);
    if (signal?.aborted) throw abortError();
    const memoryMb = boundedInteger(job.memoryMb, DEFAULT_MEMORY_MB, 256, 65_536);
    const timeoutMs = boundedInteger(job.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 3_600_000);
    await initialize();
    const id = safeTaskId(job.id);
    const taskDirectory = path.join(runtimeRoot, `${id}-${crypto.randomBytes(6).toString("hex")}`);
    const outputDirectory = path.join(taskDirectory, "output");
    const inputPath = path.join(taskDirectory, "input.json");
    await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(taskDirectory, { mode: 0o700 });
    await fs.mkdir(outputDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(taskDirectory, ".owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`, { mode: 0o600 });
    const payload = {
      protocolVersion: 1,
      id,
      mode: job.mode === "apply" ? "apply" : "preview",
      projectPath: job.projectPath,
      targetPath: job.targetPath,
      mapPath: job.mapPath,
      expectedVersion: job.expectedVersion,
      maxReadBytes: job.maxReadBytes,
      plan: job.plan,
      protectedTargets: job.protectedTargets || [],
      runtimeCapabilities: job.runtimeCapabilities || null,
      taskDirectory,
      outputDirectory,
    };
    const encoded = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES) {
      await fs.rm(taskDirectory, { recursive: true, force: true });
      throw workerError("MAP_AI_WORKER_INPUT_TOO_LARGE", "地图 AI Worker 输入超过 IPC 上限");
    }
    await fs.writeFile(inputPath, encoded, { mode: 0o600 });
    const heapMb = Math.max(128, Math.floor(memoryMb * 0.6));
    const unitName = `wfl-codex-map-ai-${crypto.createHash("sha256").update(`${id}-${taskDirectory}`).digest("hex").slice(0, 32)}.service`;
    let child;
    try {
      const command = useSystemd ? systemdRunCommand : process.execPath;
      const args = useSystemd
        ? systemdArguments({
          unitName,
          memoryMb,
          timeoutMs,
          heapMb,
          workerFile,
          inputPath,
          taskDirectory,
          targetPath: job.targetPath,
        })
        : [`--max-old-space-size=${heapMb}`, workerFile, inputPath];
      child = spawnProcess(command, args, {
        cwd: path.dirname(path.dirname(workerFile)),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: workerEnvironment(process.env, taskDirectory),
      });
    } catch (error) {
      await fs.rm(taskDirectory, { recursive: true, force: true });
      throw workerError("MAP_AI_WORKER_UNAVAILABLE", "无法启动地图 AI Worker", error);
    }
    let resolveClosed;
    const entry = {
      child,
      unitName,
      useSystemd,
      stopUnit,
      systemctlCommand,
      spawnProcess,
      taskDirectory,
      stdout: Buffer.alloc(0),
      stderr: "",
      settled: false,
      closed: new Promise((resolve) => { resolveClosed = resolve; }),
      resolveClosed: null,
    };
    entry.resolveClosed = resolveClosed;
    active.set(id, entry);
    let timeout;
    let memoryTimer;
    let abortListener;
    const result = new Promise((resolve, reject) => {
      const fail = (error) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(timeout);
        clearInterval(memoryTimer);
        signal?.removeEventListener("abort", abortListener);
        reject(error);
        void stopWorker(entry);
        void fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
      };
      const finish = (value) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(timeout);
        clearInterval(memoryTimer);
        signal?.removeEventListener("abort", abortListener);
        resolve(value);
      };
      timeout = setTimeout(() => fail(workerError("MAP_AI_WORKER_TIMEOUT", `地图 AI Worker 超过 ${timeoutMs}ms 任务超时`)), timeoutMs);
      timeout.unref?.();
      memoryTimer = setInterval(() => {
        if (entry.settled || !child.pid) return;
        void Promise.resolve(processTreeMemory(child.pid)).then((bytes) => {
          if (entry.settled || !Number.isFinite(bytes) || bytes <= memoryMb * 1024 * 1024) return;
          fail(workerError("MAP_AI_WORKER_MEMORY_LIMIT", `地图 AI Worker 使用 ${Math.ceil(bytes / 1024 / 1024)} MiB，超过任务预算 ${memoryMb} MiB`));
        }).catch(() => {});
      }, intervalMs);
      memoryTimer.unref?.();
      abortListener = () => fail(abortError());
      signal?.addEventListener("abort", abortListener, { once: true });
      child.stdout.on("data", (chunk) => {
        if (entry.settled) return;
        if (entry.stdout.length + chunk.length > MAX_STDOUT_BYTES) {
          fail(workerError("MAP_AI_WORKER_OUTPUT_LIMIT", "地图 AI Worker 返回数据超过上限"));
          return;
        }
        entry.stdout = Buffer.concat([entry.stdout, chunk]);
      });
      child.stderr.on("data", (chunk) => {
        entry.stderr = `${entry.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
      });
      child.once("error", (error) => fail(workerError("MAP_AI_WORKER_UNAVAILABLE", error.message || "地图 AI Worker 启动失败", error)));
      child.once("close", async (code, signalName) => {
        active.delete(id);
        entry.resolveClosed?.({ code, signal: signalName });
        if (entry.settled) return;
        try {
          const line = entry.stdout.toString("utf8").trim();
          const response = line ? JSON.parse(line) : null;
          if (code !== 0 || !response?.ok) throw workerExitError(entry.stderr, { code, signal: signalName }, response?.error);
          const value = await normalizeWorkerResult(response.result, outputDirectory);
          if (!value.candidate) {
            await fs.rm(taskDirectory, { recursive: true, force: true });
            finish(value);
            return;
          }
          finish({ ...value, taskDirectory, dispose: async () => fs.rm(taskDirectory, { recursive: true, force: true }) });
        } catch (error) {
          fail(error);
          await fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
        }
      });
    });
    try {
      const value = await result;
      return value;
    } catch (error) {
      await fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  run.status = () => ({ workerCount: active.size });
  run.initialize = initialize;
  run.close = async () => {
    if (closed) return;
    closed = true;
    const entries = [...active.values()];
    for (const entry of entries) void stopWorker(entry);
    await Promise.allSettled(entries.map((entry) => entry.closed));
    await Promise.allSettled(entries.map((entry) => fs.rm(entry.taskDirectory, { recursive: true, force: true })));
  };
  return run;
}

export async function processTreeRssBytes(rootPid) {
  const pid = Number(rootPid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform !== "linux") return 0;
  const pending = [pid];
  const visited = new Set();
  let totalKb = 0;
  while (pending.length) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    try {
      const status = await fs.readFile(`/proc/${current}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
      if (rss) totalKb += Number(rss[1]);
      const children = await fs.readFile(`/proc/${current}/task/${current}/children`, "utf8");
      for (const child of children.trim().split(/\s+/u)) if (/^\d+$/u.test(child)) pending.push(Number(child));
    } catch {}
  }
  return totalKb * 1024;
}

async function recoverTaskDirectories(root, now) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const staleBefore = now() - TASK_STALE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".cache") continue;
    const directory = path.join(root, entry.name);
    const stat = await fs.lstat(directory).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < staleBefore) await fs.rm(directory, { recursive: true, force: true });
  }
}

async function normalizeWorkerResult(value, outputDirectory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw workerError("MAP_AI_WORKER_RESULT_INVALID", "地图 AI Worker 返回结果无效");
  const candidate = value.candidate;
  if (candidate) {
    if (candidate.path !== "candidate.tmj") throw workerError("MAP_AI_WORKER_RESULT_INVALID", "地图 AI Worker 候选文件名无效");
    const candidatePath = path.join(outputDirectory, candidate.path);
    if (!path.resolve(candidatePath).startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) throw workerError("MAP_AI_WORKER_RESULT_INVALID", "地图 AI Worker 候选路径越界");
    const stat = await fs.lstat(candidatePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw workerError("MAP_AI_WORKER_RESULT_INVALID", "地图 AI Worker 候选文件无效");
    if (Number(candidate.size) !== stat.size) throw workerError("MAP_AI_WORKER_RESULT_INVALID", "地图 AI Worker 候选文件大小不一致");
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(candidatePath)) hash.update(chunk);
    if (hash.digest("hex") !== String(candidate.sha256)) throw workerError("MAP_AI_WORKER_RESULT_INVALID", "地图 AI Worker 候选文件哈希不一致");
    return { ...value, candidate: { ...candidate, path: candidatePath } };
  }
  return value;
}

function assertJob(job) {
  for (const field of ["id", "projectPath", "targetPath", "mapPath", "expectedVersion", "plan"]) {
    if (job?.[field] === undefined || job?.[field] === null) throw workerError("MAP_AI_WORKER_JOB_INVALID", `地图 AI Worker 缺少 ${field}`);
  }
}
function safeTaskId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(id)) return crypto.createHash("sha256").update(id).digest("hex");
  return id;
}
function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (Number.isSafeInteger(number) && number >= minimum && number <= maximum) return number;
  return fallback;
}
function workerError(code, message, cause) { return Object.assign(new Error(message), { code, cause }); }
function abortError() { return workerError("ABORT_ERR", "地图 AI Worker 任务已取消"); }
function workerExitError(stderr, exit, error) { return workerError(error?.code || "MAP_AI_WORKER_FAILED", error?.message || String(stderr || `Worker exited with ${exit.code ?? exit.signal}`)); }
function systemdArguments({ unitName, memoryMb, timeoutMs, heapMb, workerFile, inputPath, taskDirectory, targetPath }) {
  return [
    "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec",
    `--unit=${unitName}`,
    "--property=MemoryAccounting=yes",
    `--property=MemoryMax=${memoryMb}M`,
    "--property=MemorySwapMax=0",
    `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1_000)}s`,
    "--property=KillMode=control-group",
    "--property=OOMPolicy=stop",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=yes",
    "--property=PrivateTmp=yes",
    "--property=PrivateDevices=yes",
    "--property=NoNewPrivileges=yes",
    "--property=ProtectKernelTunables=yes",
    "--property=ProtectKernelModules=yes",
    "--property=ProtectKernelLogs=yes",
    "--property=ProtectControlGroups=yes",
    "--property=ProtectProc=invisible",
    "--property=ProcSubset=pid",
    "--property=RestrictSUIDSGID=yes",
    "--property=RestrictNamespaces=yes",
    "--property=RestrictRealtime=yes",
    "--property=LockPersonality=yes",
    // The worker only needs the authorized map file. Do not expose the whole
    // project tree (which may contain secrets or unrelated user files).
    `--property=BindReadOnlyPaths=${path.resolve(targetPath)}`,
    `--property=BindPaths=${path.resolve(taskDirectory)}`,
    `--property=ReadWritePaths=${path.resolve(taskDirectory)}`,
    "--property=UMask=0077",
    "--",
    process.execPath,
    `--max-old-space-size=${heapMb}`,
    workerFile,
    inputPath,
  ];
}
async function stopWorker(entry) {
  if (entry.stopping) return entry.stopping;
  entry.stopping = (async () => {
    if (entry.useSystemd) {
      try {
        if (typeof entry.stopUnit === "function") await entry.stopUnit(entry.unitName);
        else await runStopCommand(entry.spawnProcess, entry.systemctlCommand, entry.unitName);
      } catch {}
    } else {
      killProcessGroup(entry.child);
    }
    try { killProcessGroup(entry.child); } catch {}
  })();
  return entry.stopping;
}
function runStopCommand(spawnProcess, command, unitName) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(command, ["stop", unitName], { stdio: "ignore" }); }
    catch { resolve(); return; }
    child.once?.("close", resolve);
    child.once?.("error", resolve);
  });
}
function killProcessGroup(child) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

function workerEnvironment(source, taskDirectory) {
  const environment = {};
  for (const key of ENVIRONMENT_ALLOWLIST) if (source?.[key]) environment[key] = source[key];
  environment.HOME = taskDirectory;
  environment.TMPDIR = taskDirectory;
  environment.TMP = taskDirectory;
  environment.TEMP = taskDirectory;
  return environment;
}
