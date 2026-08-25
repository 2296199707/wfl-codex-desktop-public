import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMapFile } from "./map-file-sessions.mjs";
import { clearMapRenderAssetCache } from "./map-render-cache.mjs";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("../scripts/map-render-worker.mjs", import.meta.url));
const DEFAULT_POLL_MS = 250;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TASK_OWNER_FILE = ".wfl-render-owner.json";
const LEGACY_TASK_STALE_MS = 2 * 60 * 60 * 1_000;

export function createMapRenderWorkerRunner({
  runtimeDirectory,
  workerPath = DEFAULT_WORKER_PATH,
  pollMs = DEFAULT_POLL_MS,
  processTreeMemory = processTreeRssBytes,
  commitOutputs = commitMapRenderOutputs,
  authorize = async () => {},
  checkQuota = async () => {},
  onCommitted = async () => {},
  onCommitError = async () => {},
} = {}) {
  const runtimeRoot = path.resolve(runtimeDirectory || "");
  if (!path.isAbsolute(runtimeRoot) || runtimeRoot === path.parse(runtimeRoot).root) {
    throw new TypeError("A bounded map render runtime directory is required");
  }
  const workerFile = path.resolve(workerPath);
  const intervalMs = boundedInteger(pollMs, DEFAULT_POLL_MS, 25, 10_000);
  const cacheDirectory = path.join(runtimeRoot, ".cache");
  const workers = new Set();
  let closed = false;
  let desiredWorkerSettings = null;
  let cacheMutation = Promise.resolve();
  let initializePromise = null;

  const initialize = () => {
    if (!initializePromise) initializePromise = recoverAbandonedTaskDirectories(runtimeRoot);
    return initializePromise;
  };

  async function runMapRenderWorker(job, { signal } = {}) {
    if (closed) throw runnerError("render-worker-closed", "地图 Render Worker 已关闭");
    await initialize();
    const previewCapture = job.kind === "preview-capture";
    const taskDirectory = path.join(runtimeRoot, job.id);
    const outputDirectory = path.join(taskDirectory, "output");
    await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(taskDirectory, { recursive: false, mode: 0o700 });
    await fs.writeFile(path.join(taskDirectory, TASK_OWNER_FILE), `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
    })}\n`, { flag: "wx", mode: 0o600 });
    const inputPath = path.join(taskDirectory, "input.json");
    const memoryMb = boundedInteger(job.settings?.config?.worker?.memoryMb, null, 256, 65_536);
    const timeoutMs = boundedInteger(job.settings?.config?.worker?.taskTimeoutMs, null, 1_000, 3_600_000);
    const heapMb = Math.max(128, Math.floor(memoryMb * 0.6));
    const taskSignal = createTaskSignal(signal, timeoutMs);
    const workerInput = previewCapture
      ? {
          jobId: job.id,
          kind: job.kind,
          capture: job.capture,
          taskDirectory,
          outputDirectory,
          settings: job.settings,
        }
      : {
          jobId: job.id,
          kind: job.kind,
          projectPath: job.mapContext.projectPath,
          targetPath: job.mapContext.targetPath,
          mapPath: job.mapContext.relativePath,
          expectedVersion: job.mapContext.version,
          taskDirectory,
          outputDirectory,
          cacheDirectory,
          spec: job.spec,
          settings: job.settings,
        };
    let worker = null;
    let preserveTaskDirectory = false;
    try {
      await fs.writeFile(inputPath, `${JSON.stringify(workerInput)}\n`, { mode: 0o600 });
      throwIfAborted(taskSignal.signal);
      worker = acquireWorker({ memoryMb, heapMb });
      const workerResult = await executeWorkerTask(worker, {
        id: job.id,
        inputPath,
        memoryMb,
        timeoutMs,
        signal: taskSignal.signal,
      });
      await verifyWorkerOutputs(outputDirectory, workerResult.files, { signal: taskSignal.signal });
      if (previewCapture) {
        throwIfAborted(taskSignal.signal);
        const lease = createPreviewCaptureLease(taskDirectory, outputDirectory, workerResult, { timeoutMs });
        preserveTaskDirectory = true;
        return lease;
      }
      await authorize(job);
      return await commitOutputs(job, workerResult, outputDirectory, {
        checkQuota,
        onCommitted,
        onCommitError,
        signal: taskSignal.signal,
      });
    } finally {
      taskSignal.dispose();
      if (worker?.alive && worker.busy) {
        releaseWorker(worker, boundedInteger(
          job.settings?.config?.worker?.idleRecycleMs,
          60_000,
          1_000,
          3_600_000,
        ));
      }
      if (!preserveTaskDirectory) {
        await fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  function acquireWorker({ memoryMb, heapMb }) {
    const available = [...workers].find((entry) => entry.alive && !entry.busy && entry.memoryMb === memoryMb);
    if (available) {
      clearTimeout(available.idleTimer);
      available.idleTimer = null;
      available.busy = true;
      available.stderr = "";
      return available;
    }
    const child = spawn(process.execPath, [
      `--max-old-space-size=${heapMb}`,
      workerFile,
      "--daemon",
    ], {
      cwd: path.dirname(path.dirname(workerFile)),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveClosed;
    const entry = {
      child,
      memoryMb,
      alive: true,
      busy: true,
      idleTimer: null,
      pending: null,
      stdout: Buffer.alloc(0),
      stderr: "",
      closeResult: null,
      closed: new Promise((resolve) => { resolveClosed = resolve; }),
    };
    entry.resolveClosed = resolveClosed;
    workers.add(entry);
    child.stdout.on("data", (chunk) => handleWorkerOutput(entry, chunk));
    child.stderr.on("data", (chunk) => {
      entry.stderr = `${entry.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      failWorker(entry, runnerError("render-worker-failed", error.message || "Render Worker 无法启动"));
    });
    child.once("close", (code, signalName) => {
      entry.alive = false;
      clearTimeout(entry.idleTimer);
      workers.delete(entry);
      const exit = { code, signal: signalName };
      entry.closeResult = exit;
      if (entry.pending) settleWorkerTask(entry, entry.pending, workerExitError(entry.stderr, exit), null);
      entry.resolveClosed(exit);
    });
    return entry;
  }

  function executeWorkerTask(entry, { id, inputPath, memoryMb, timeoutMs, signal }) {
    if (!entry.alive || !entry.busy || entry.pending) {
      return Promise.reject(runnerError("render-worker-failed", "Render Worker 状态不正确"));
    }
    return new Promise((resolve, reject) => {
      const task = {
        id,
        resolve,
        reject,
        timeout: null,
        memoryTimer: null,
        memorySampleInFlight: false,
        abortListener: null,
        signal,
        settled: false,
      };
      entry.pending = task;
      task.timeout = setTimeout(() => {
        failWorker(entry, runnerError("render-timeout", `Render Worker 超过 ${timeoutMs}ms 任务超时`));
      }, timeoutMs);
      task.memoryTimer = setInterval(() => {
        if (!entry.alive || entry.pending !== task || task.memorySampleInFlight) return;
        task.memorySampleInFlight = true;
        const sampledPid = entry.child.pid;
        void Promise.resolve(processTreeMemory(sampledPid)).then((bytes) => {
          if (!entry.alive || entry.pending !== task || entry.child.pid !== sampledPid) return;
          if (!Number.isFinite(bytes) || bytes <= memoryMb * 1024 * 1024) return;
          failWorker(entry, runnerError(
            "memory-budget-exceeded",
            `Render Worker 使用 ${Math.ceil(bytes / 1024 / 1024)} MiB，超过任务预算 ${memoryMb} MiB`,
          ));
        }).catch(() => {}).finally(() => {
          task.memorySampleInFlight = false;
        });
      }, intervalMs);
      task.abortListener = () => failWorker(entry, signalFailure(signal));
      if (signal?.aborted) {
        task.abortListener();
        return;
      }
      signal?.addEventListener("abort", task.abortListener, { once: true });
      entry.child.stdin.write(`${JSON.stringify({ id, inputPath })}\n`, (error) => {
        if (error && entry.pending === task) {
          failWorker(entry, runnerError("render-worker-failed", error.message || "无法发送 Render Worker 任务"));
        }
      });
    });
  }

  function handleWorkerOutput(entry, chunk) {
    if (!entry.alive) return;
    if (entry.stdout.length + chunk.length > MAX_STDOUT_BYTES) {
      failWorker(entry, runnerError("worker-output-limit", "Render Worker 返回数据超过上限"));
      return;
    }
    entry.stdout = Buffer.concat([entry.stdout, chunk]);
    while (true) {
      const newline = entry.stdout.indexOf(0x0a);
      if (newline < 0) return;
      const line = entry.stdout.subarray(0, newline).toString("utf8").trim();
      entry.stdout = entry.stdout.subarray(newline + 1);
      if (!line) continue;
      const task = entry.pending;
      if (!task) {
        failWorker(entry, runnerError("worker-response-invalid", "Render Worker 返回了未请求的数据"));
        return;
      }
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        failWorker(entry, runnerError("worker-response-invalid", "Render Worker 返回了无效 JSON"));
        return;
      }
      if (response?.id !== task.id || typeof response?.ok !== "boolean") {
        failWorker(entry, runnerError("worker-response-invalid", "Render Worker 返回的任务编号不正确"));
        return;
      }
      if (response.ok) settleWorkerTask(entry, task, null, response.result);
      else settleWorkerTask(
        entry,
        task,
        runnerError(response?.error?.code || "render-worker-failed", response?.error?.message || "Render Worker 执行失败"),
        null,
      );
    }
  }

  function settleWorkerTask(entry, task, error, result) {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timeout);
    clearInterval(task.memoryTimer);
    task.signal?.removeEventListener("abort", task.abortListener);
    if (entry.pending === task) entry.pending = null;
    if (error) task.reject(error);
    else task.resolve(result);
  }

  function failWorker(entry, error) {
    if (!entry.alive) return;
    entry.alive = false;
    clearTimeout(entry.idleTimer);
    workers.delete(entry);
    if (entry.pending) settleWorkerTask(entry, entry.pending, error, null);
    killWorkerProcessGroup(entry.child);
  }

  function releaseWorker(entry, idleRecycleMs) {
    if (!entry.alive) return;
    if (desiredWorkerSettings && (
      desiredWorkerSettings.enabled !== true
      || entry.memoryMb !== desiredWorkerSettings.memoryMb
    )) {
      failWorker(entry, runnerError("render-worker-reconfigured", "Render Worker 设置已更新"));
      return;
    }
    entry.busy = false;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => failWorker(
      entry,
      runnerError("render-worker-recycled", "Render Worker 空闲回收"),
    ), idleRecycleMs);
    entry.idleTimer.unref?.();
  }

  runMapRenderWorker.status = () => ({
    workerCount: [...workers].filter((entry) => entry.alive).length,
    idleWorkerCount: [...workers].filter((entry) => entry.alive && !entry.busy).length,
  });
  runMapRenderWorker.initialize = initialize;
  runMapRenderWorker.reconcile = (settings) => {
    const enabled = settings?.config?.worker?.enabled === true;
    const memoryMb = Number(settings?.config?.worker?.memoryMb);
    desiredWorkerSettings = { enabled, memoryMb };
    for (const entry of workers) {
      if (entry.busy) continue;
      if (!enabled || entry.memoryMb !== memoryMb) {
        failWorker(entry, runnerError("render-worker-reconfigured", "Render Worker 设置已更新"));
      }
    }
  };
  runMapRenderWorker.clearCache = () => {
    const operation = cacheMutation.then(async () => {
      await initialize();
      const before = await clearMapRenderAssetCache(cacheDirectory);
      return {
        files: before.files,
        bytes: before.bytes,
        activeWorkers: [...workers].filter((entry) => entry.alive && entry.busy).length,
      };
    });
    cacheMutation = operation.catch(() => {});
    return operation;
  };
  runMapRenderWorker.close = async () => {
    if (closed) return;
    closed = true;
    await initialize().catch(() => {});
    const pending = [...workers];
    for (const entry of pending) {
      failWorker(entry, runnerError("render-worker-closed", "地图 Render Worker 已关闭"));
    }
    await Promise.allSettled(pending.map((entry) => entry.closed));
  };

  return runMapRenderWorker;
}

function createPreviewCaptureLease(taskDirectory, outputDirectory, workerResult, { timeoutMs }) {
  if (!Array.isArray(workerResult?.files) || workerResult.files.length !== 1) {
    throw runnerError("worker-manifest-invalid", "项目截图 Worker 必须只返回一个 PNG 文件");
  }
  const file = workerResult.files[0];
  if (file.path !== "screenshot.png" || file.mediaType !== "image/png") {
    throw runnerError("worker-manifest-invalid", "项目截图 Worker 返回的文件类型不正确");
  }
  const filePath = safeManifestPath(outputDirectory, file.path);
  let cleanupTimer = null;
  let disposed = false;
  let disposePromise = null;
  const dispose = async () => {
    if (disposed) return;
    if (disposePromise) return disposePromise;
    disposePromise = fs.rm(taskDirectory, { recursive: true, force: true })
      .then(() => {
        disposed = true;
        clearTimeout(cleanupTimer);
      })
      .finally(() => {
        disposePromise = null;
      });
    return disposePromise;
  };
  cleanupTimer = setTimeout(() => {
    void dispose().catch(() => {});
  }, Math.max(60_000, Math.min(timeoutMs, 15 * 60_000)));
  cleanupTimer.unref?.();
  return {
    filePath,
    size: Number(file.size),
    sha256: String(file.sha256),
    mediaType: "image/png",
    dispose,
  };
}

export async function commitMapRenderOutputs(job, workerResult, stagingDirectory, {
  checkQuota = async () => {},
  onCommitted = async () => {},
  onCommitError = async () => {},
  signal,
} = {}) {
  throwIfAborted(signal);
  const inspected = await inspectMapFile(job.mapContext.targetPath, { signal });
  if (inspected.version !== job.mapContext.version) {
    throw runnerError("map-version-conflict", "地图在渲染输出提交前已经变化");
  }
  const projectRoot = await fs.realpath(job.mapContext.projectPath);
  const projectStat = await fs.stat(projectRoot);
  const outputRoot = await ensureProjectDirectory(projectRoot, job.outputRoot, projectStat, signal);
  const mapName = safeOutputName(path.basename(job.mapContext.relativePath, path.extname(job.mapContext.relativePath)));
  const finalName = `${mapName}-${safeOutputName(job.kind)}-${job.id.slice(0, 10)}`;
  const finalDirectory = path.join(outputRoot, finalName);
  const candidateDirectory = path.join(outputRoot, `.${finalName}.wfl-render-${process.pid}`);
  if (await exists(finalDirectory) || await exists(candidateDirectory)) {
    throw runnerError("render-output-conflict", "地图渲染输出目录已经存在");
  }
  const totalBytes = workerResult.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  await checkQuota({
    userId: job.identity.userId,
    projectPath: projectRoot,
    bytes: totalBytes,
  });
  throwIfAborted(signal);
  await fs.mkdir(candidateDirectory, { recursive: false, mode: 0o700 });
  try {
    for (const file of workerResult.files) {
      throwIfAborted(signal);
      const source = safeManifestPath(stagingDirectory, file.path);
      const destination = safeManifestPath(candidateDirectory, file.path);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      await inheritOwnership(destination, projectStat);
      await fs.chmod(destination, 0o640);
      await syncFile(destination);
    }
    await prepareCommittedDirectories(candidateDirectory, projectStat, signal);
    throwIfAborted(signal);
    await fs.rename(candidateDirectory, finalDirectory);
    await syncDirectory(outputRoot);
  } catch (error) {
    await fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const relativeDirectory = path.relative(projectRoot, finalDirectory).split(path.sep).join("/");
  const result = {
    summary: workerResult.summary,
    outputDirectory: relativeDirectory,
    files: workerResult.files.map((file) => ({ ...file })),
  };
  try {
    await onCommitted({ job, result, totalBytes });
  } catch (error) {
    await Promise.resolve(onCommitError(error, { job, result, totalBytes })).catch(() => {});
  }
  return result;
}

export async function verifyWorkerOutputs(outputDirectory, manifest, { signal } = {}) {
  throwIfAborted(signal);
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > 100_000) {
    throw runnerError("worker-manifest-invalid", "Render Worker 输出清单不正确");
  }
  const seen = new Set();
  for (const file of manifest) {
    throwIfAborted(signal);
    const relative = normalizeManifestPath(file?.path);
    if (seen.has(relative)) throw runnerError("worker-manifest-invalid", "Render Worker 输出清单包含重复文件");
    seen.add(relative);
    const filename = safeManifestPath(outputDirectory, relative);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(file?.size)) {
      throw runnerError("worker-manifest-invalid", `Render Worker 输出 ${relative} 与清单不一致`);
    }
    const hash = await hashFile(filename, { signal });
    if (hash !== file.sha256) throw runnerError("worker-manifest-invalid", `Render Worker 输出 ${relative} 哈希不一致`);
  }
  const actual = await listFiles(outputDirectory, signal);
  if (actual.length !== seen.size || actual.some((file) => !seen.has(file))) {
    throw runnerError("worker-manifest-invalid", "Render Worker 输出目录包含清单外文件");
  }
  return true;
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
      for (const child of children.trim().split(/\s+/u)) {
        if (/^\d+$/u.test(child)) pending.push(Number(child));
      }
    } catch {
      // Processes can exit while the tree is sampled.
    }
  }
  return totalKb * 1024;
}

async function ensureProjectDirectory(projectRoot, relativePath, ownerStat, signal) {
  const segments = normalizeManifestPath(relativePath).split("/");
  let current = projectRoot;
  for (const segment of segments) {
    throwIfAborted(signal);
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw runnerError("render-output-path", "地图渲染输出路径不是安全目录");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o750 });
      await inheritOwnership(current, ownerStat);
    }
    const real = await fs.realpath(current);
    if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
      throw runnerError("render-output-path", "地图渲染输出路径离开工程目录");
    }
  }
  return current;
}

async function prepareCommittedDirectories(root, ownerStat, signal) {
  const directories = [root];
  const pending = [root];
  while (pending.length) {
    throwIfAborted(signal);
    const directory = pending.shift();
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const child = path.join(directory, dirent.name);
      directories.push(child);
      pending.push(child);
    }
  }
  for (const directory of directories) {
    throwIfAborted(signal);
    await inheritOwnership(directory, ownerStat);
    await fs.chmod(directory, 0o750);
  }
  for (const directory of directories.reverse()) {
    throwIfAborted(signal);
    await syncDirectory(directory);
  }
}

async function inheritOwnership(filename, ownerStat) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : ownerStat.uid;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : ownerStat.gid;
  if (ownerStat.uid !== currentUid || ownerStat.gid !== currentGid) {
    await fs.chown(filename, ownerStat.uid, ownerStat.gid);
  }
}

async function syncFile(filename) {
  const handle = await fs.open(filename, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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

async function listFiles(root, signal) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    throwIfAborted(signal);
    const directory = pending.shift();
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) throw runnerError("worker-manifest-invalid", "Render Worker 输出包含符号链接");
      if (dirent.isDirectory()) pending.push(filename);
      else if (dirent.isFile()) files.push(path.relative(root, filename).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

function safeManifestPath(root, relativePath) {
  const normalized = normalizeManifestPath(relativePath);
  const target = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runnerError("worker-manifest-invalid", "Render Worker 输出路径越界");
  }
  return target;
}

function normalizeManifestPath(value) {
  const input = String(value || "").trim().replaceAll("\\", "/");
  const segments = input.split("/");
  if (
    !input
    || input.length > 1024
    || input.startsWith("/")
    || /^[A-Za-z]:/u.test(input)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f:*?"<>|]/u.test(segment))
  ) throw runnerError("worker-manifest-invalid", "Render Worker 输出路径不正确");
  return segments.join("/");
}

function safeOutputName(value) {
  const name = String(value || "map").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (name || "map").slice(0, 80);
}

function workerExitError(stderr, exit) {
  const lines = String(stderr || "").trim().split("\n").filter(Boolean);
  const last = lines.at(-1) || "";
  try {
    const parsed = JSON.parse(last);
    return runnerError(
      parsed.code || "render-worker-failed",
      parsed.message || parsed.error || "Render Worker 执行失败",
    );
  } catch {
    return runnerError(
      "render-worker-failed",
      last || `Render Worker exited with ${exit.code ?? exit.signal}`,
    );
  }
}

function killWorkerProcessGroup(child) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The worker already exited.
    }
  }
}

async function hashFile(filename, { signal } = {}) {
  throwIfAborted(signal);
  const hash = crypto.createHash("sha256");
  try {
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filename, { signal });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", reject);
      stream.once("end", resolve);
    });
  } catch (error) {
    if (signal?.aborted) throw signalFailure(signal);
    throw error;
  }
  throwIfAborted(signal);
  return hash.digest("hex");
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (Number.isSafeInteger(number) && number >= minimum && number <= maximum) return number;
  if (fallback !== null) return fallback;
  throw new TypeError("Invalid map render worker setting");
}

function runnerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signalFailure(signal);
}

function signalFailure(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && ["ABORT_ERR", "render-timeout"].includes(reason.code)) return reason;
  return runnerError("ABORT_ERR", "地图渲染任务已取消");
}

function createTaskSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(signalFailure(externalSignal));
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(runnerError(
    "render-timeout",
    `Render Worker 超过 ${timeoutMs}ms 任务超时`,
  )), timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

async function recoverAbandonedTaskDirectories(runtimeRoot) {
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(runtimeRoot, { withFileTypes: true });
  const staleBefore = Date.now() - LEGACY_TASK_STALE_MS;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name === ".cache") return;
    const taskDirectory = path.join(runtimeRoot, entry.name);
    let owner = null;
    try {
      owner = JSON.parse(await fs.readFile(path.join(taskDirectory, TASK_OWNER_FILE), "utf8"));
    } catch {
      // Old releases did not write an ownership marker.
    }
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 1) {
      if (processIsAlive(owner.pid)) return;
      await fs.rm(taskDirectory, { recursive: true, force: true });
      return;
    }
    const stat = await fs.lstat(taskDirectory);
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < staleBefore) {
      await fs.rm(taskDirectory, { recursive: true, force: true });
    }
  }));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
