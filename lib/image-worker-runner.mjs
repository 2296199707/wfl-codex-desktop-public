import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKER_PATH = fileURLToPath(new URL("../scripts/image-execution-worker.mjs", import.meta.url));
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_CONTROL_LINE_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const LEASE_TTL_MS = 30 * 60_000;
const ABANDONED_TASK_TTL_MS = 2 * 60 * 60_000;
const ENVIRONMENT_ALLOWLIST = [
  "PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
];

export function createImageWorkerRunner({
  runtimeDirectory,
  workerPath = DEFAULT_WORKER_PATH,
  spawnProcess = spawn,
  systemdRunCommand = "systemd-run",
  systemctlCommand = "systemctl",
  useSystemd = true,
  stopUnit = null,
  prepareTask = async (job) => job.payload,
  unitIsActive = null,
  now = () => Date.now(),
  abandonedTaskTtlMs = ABANDONED_TASK_TTL_MS,
} = {}) {
  const runtimeRoot = path.resolve(runtimeDirectory || "");
  if (!path.isAbsolute(runtimeRoot) || runtimeRoot === path.parse(runtimeRoot).root) {
    throw new TypeError("A bounded image worker runtime directory is required");
  }
  const workerFile = path.resolve(workerPath);
  if (typeof prepareTask !== "function") throw new TypeError("Image worker prepareTask hook must be a function");
  const active = new Map();
  let closed = false;
  let initializePromise = null;

  const initialize = () => {
    if (!initializePromise) initializePromise = recoverAbandonedImageTaskDirectories(runtimeRoot, {
      now,
      staleMs: abandonedTaskTtlMs,
      unitIsActive: unitIsActive || ((unitName) => systemdUnitIsActive(spawnProcess, systemctlCommand, unitName)),
    });
    return initializePromise;
  };

  async function runImageWorker(job, { signal = null, onEvent = null } = {}) {
    if (closed) throw runnerError(503, "IMAGE_WORKER_CLOSED", "图片 Worker 已关闭");
    assertJob(job);
    assertAbortSignal(signal);
    if (signal?.aborted) throw canceledError();
    // Capture the cgroup and timeout budget before the first asynchronous boundary.
    // Queue admission freezes the complete task; the runner still must not observe a
    // caller mutating the settings object while abandoned-task recovery is running.
    const worker = job.settings.config.worker;
    const memoryMb = boundedInteger(worker.memoryMb, null, 256, 65_536);
    const timeoutMs = boundedInteger(worker.taskTimeoutMs, null, 1_000, 3_600_000);
    const cancelGraceMs = boundedInteger(worker.cancelGraceMs, 5_000, 100, 60_000);
    if (!memoryMb || !timeoutMs) {
      throw runnerError(500, "IMAGE_WORKER_SETTINGS_INVALID", "图片 Worker 任务设置无效");
    }
    await initialize();
    const taskDirectory = path.join(runtimeRoot, job.id);
    const inputDirectory = path.join(taskDirectory, "input");
    const outputDirectory = path.join(taskDirectory, "output");
    const temporaryDirectory = path.join(taskDirectory, "tmp");
    await fs.mkdir(taskDirectory, { recursive: false, mode: 0o700 });
    await fs.mkdir(inputDirectory, { mode: 0o700 });
    await fs.mkdir(outputDirectory, { mode: 0o700 });
    await fs.mkdir(temporaryDirectory, { mode: 0o700 });
    const heapMb = Math.max(128, Math.floor(memoryMb * 0.55));
    const unitName = `wfl-codex-image-${job.id}.service`;
    let payload;
    try {
      payload = await prepareTask(job, {
        taskDirectory,
        inputDirectory,
        outputDirectory,
        temporaryDirectory,
        signal,
      });
      assertJsonPayload(payload);
      if (signal?.aborted) throw canceledError();
    } catch (error) {
      await fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const request = {
      protocolVersion: 1,
      id: job.id,
      taskDirectory,
      inputDirectory,
      outputDirectory,
      payload,
    };
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) {
      await fs.rm(taskDirectory, { recursive: true, force: true });
      throw runnerError(413, "IMAGE_WORKER_REQUEST_TOO_LARGE", "图片 Worker 请求超过 IPC 上限");
    }

    const command = useSystemd ? systemdRunCommand : process.execPath;
    const args = useSystemd
      ? systemdArguments({
          unitName,
          memoryMb,
          timeoutMs,
          heapMb,
          workerFile,
          taskDirectory,
          sensitiveRuntimeDirectory: sensitiveRuntimeBoundary(runtimeRoot, workerFile),
        })
      : [`--max-old-space-size=${heapMb}`, workerFile];
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd: path.dirname(path.dirname(workerFile)),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: workerEnvironment(process.env, temporaryDirectory),
      });
    } catch (error) {
      await fs.rm(taskDirectory, { recursive: true, force: true });
      throw runnerError(503, "IMAGE_WORKER_UNAVAILABLE", "无法启动独立图片 Worker", error);
    }

    const entry = {
      job,
      child,
      unitName,
      taskDirectory,
      outputDirectory,
      useSystemd,
      stopUnit,
      systemctlCommand,
      spawnProcess,
      cancelGraceMs,
      stdout: Buffer.alloc(0),
      stdoutBytes: 0,
      stderr: "",
      terminal: null,
      eventChain: Promise.resolve(),
      stopping: null,
      abortListener: null,
      timeout: null,
      killTimer: null,
    };
    active.set(job.id, entry);
    entry.abortListener = () => {
      if (!entry.terminal) entry.terminal = { error: canceledError() };
      void stopWorker(entry);
    };
    signal?.addEventListener("abort", entry.abortListener, { once: true });
    entry.timeout = setTimeout(() => {
      if (!entry.terminal) {
        entry.terminal = {
          error: runnerError(504, "IMAGE_WORKER_TIMEOUT", `图片 Worker 超过 ${timeoutMs}ms 任务超时`),
        };
      }
      void stopWorker(entry);
    }, timeoutMs);

    const completion = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => handleStdout(entry, chunk, onEvent));
      child.stderr.on("data", (chunk) => {
        entry.stderr = `${entry.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
      });
      child.once("error", (error) => {
        if (!entry.terminal) {
          entry.terminal = {
            error: runnerError(503, "IMAGE_WORKER_UNAVAILABLE", "无法启动独立图片 Worker", error),
          };
        }
      });
      child.once("close", async (code, signalName) => {
        clearTimeout(entry.timeout);
        clearTimeout(entry.killTimer);
        signal?.removeEventListener("abort", entry.abortListener);
        active.delete(job.id);
        try {
          if (entry.stdout.length) parseControlLine(entry, entry.stdout, onEvent);
          await entry.eventChain;
          if (entry.terminal?.error) throw entry.terminal.error;
          if (!entry.terminal?.result) {
            throw workerExitError(entry.stderr, { code, signal: signalName });
          }
          if (code !== 0) throw workerExitError(entry.stderr, { code, signal: signalName });
          const verified = await verifyImageWorkerFiles(
            outputDirectory,
            entry.terminal.result.files,
            { allowEmpty: entry.job.payload?.kind === "compatibility-probe" },
          );
          const lease = createLease(taskDirectory, outputDirectory, {
            ...entry.terminal.result,
            files: verified,
          });
          resolve(lease);
        } catch (error) {
          await fs.rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
          reject(error);
        }
      });
    });

    child.stdin.end(encoded, (error) => {
      if (!error || entry.terminal) return;
      entry.terminal = {
        error: runnerError(502, "IMAGE_WORKER_IPC_FAILED", "无法发送图片 Worker 任务", error),
      };
      void stopWorker(entry);
    });
    return completion;
  }

  async function stopWorker(entry) {
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      if (entry.useSystemd) {
        try {
          if (typeof entry.stopUnit === "function") await entry.stopUnit(entry.unitName);
          else await runStopCommand(entry.spawnProcess, entry.systemctlCommand, entry.unitName);
        } catch {
          // The launcher process is still force-killed below if the unit did not stop.
        }
      } else {
        killProcessGroup(entry.child, "SIGTERM");
      }
      entry.killTimer = setTimeout(() => killProcessGroup(entry.child, "SIGKILL"), entry.cancelGraceMs);
      entry.killTimer.unref?.();
    })();
    return entry.stopping;
  }

  runImageWorker.status = () => ({ workerCount: active.size });
  runImageWorker.initialize = initialize;
  runImageWorker.close = async () => {
    if (closed) return;
    closed = true;
    for (const entry of active.values()) {
      if (!entry.terminal) {
        entry.terminal = { error: runnerError(503, "IMAGE_WORKER_CLOSED", "图片 Worker 已关闭") };
      }
      void stopWorker(entry);
    }
    await Promise.allSettled([...active.values()].map((entry) => waitForClose(entry.child)));
  };
  return runImageWorker;
}

export async function recoverAbandonedImageTaskDirectories(runtimeDirectory, {
  now = () => Date.now(),
  staleMs = ABANDONED_TASK_TTL_MS,
  unitIsActive = async () => false,
} = {}) {
  const root = path.resolve(runtimeDirectory || "");
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw new TypeError("A bounded image worker runtime directory is required");
  }
  if (!Number.isSafeInteger(staleMs) || staleMs < 0 || typeof unitIsActive !== "function") {
    throw new TypeError("Invalid abandoned image task recovery options");
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(root);
  let removed = 0;
  for (const name of entries) {
    if (!/^[a-f0-9]{36}$/u.test(name)) continue;
    const candidate = path.join(root, name);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    if (stat.mtimeMs > now() - staleMs) continue;
    const real = await fs.realpath(candidate).catch(() => null);
    if (real !== candidate || !isPathInside(root, real)) continue;
    if (await unitIsActive(`wfl-codex-image-${name}.service`)) continue;
    await fs.rm(candidate, { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}

function systemdArguments({
  unitName,
  memoryMb,
  timeoutMs,
  heapMb,
  workerFile,
  taskDirectory,
  sensitiveRuntimeDirectory,
}) {
  return [
    "--quiet",
    "--pipe",
    "--wait",
    "--collect",
    "--service-type=exec",
    `--unit=${unitName}`,
    "--property=MemoryAccounting=yes",
    `--property=MemoryMax=${memoryMb}M`,
    "--property=MemorySwapMax=0",
    `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1_000)}s`,
    "--property=KillMode=control-group",
    "--property=OOMPolicy=stop",
    "--property=ProtectSystem=strict",
    // Hide the main-site runtime state (provider-store key, sessions, and
    // deployment state), then expose only this task's already-created tree.
    `--property=TemporaryFileSystem=${sensitiveRuntimeDirectory}:ro`,
    `--property=BindPaths=${taskDirectory}`,
    `--property=ReadWritePaths=${taskDirectory}`,
    "--property=UMask=0077",
    "--property=NoNewPrivileges=yes",
    "--property=PrivateTmp=yes",
    "--property=PrivateDevices=yes",
    "--property=ProtectHome=yes",
    "--property=ProtectKernelTunables=yes",
    "--property=ProtectKernelModules=yes",
    "--property=ProtectKernelLogs=yes",
    "--property=ProtectControlGroups=yes",
    "--property=ProtectClock=yes",
    "--property=ProtectHostname=yes",
    "--property=ProtectProc=invisible",
    "--property=ProcSubset=pid",
    "--property=RestrictSUIDSGID=yes",
    "--property=RestrictNamespaces=yes",
    "--property=RestrictRealtime=yes",
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "--property=SystemCallArchitectures=native",
    "--property=LockPersonality=yes",
    "--",
    process.execPath,
    `--max-old-space-size=${heapMb}`,
    workerFile,
  ];
}

function handleStdout(entry, chunk, onEvent) {
  if (entry.terminal?.error) return;
  entry.stdoutBytes += chunk.length;
  if (entry.stdoutBytes > MAX_CONTROL_BYTES || entry.stdout.length + chunk.length > MAX_CONTROL_LINE_BYTES) {
    entry.terminal = {
      error: runnerError(502, "IMAGE_WORKER_OUTPUT_LIMIT", "图片 Worker 控制输出超过上限"),
    };
    void stopActiveEntry(entry);
    return;
  }
  entry.stdout = Buffer.concat([entry.stdout, chunk]);
  while (true) {
    const newline = entry.stdout.indexOf(0x0a);
    if (newline < 0) return;
    const line = entry.stdout.subarray(0, newline);
    entry.stdout = entry.stdout.subarray(newline + 1);
    if (!line.length) continue;
    parseControlLine(entry, line, onEvent);
    if (entry.terminal?.error) return;
  }
}

function parseControlLine(entry, bytes, onEvent) {
  if (bytes.length > MAX_CONTROL_LINE_BYTES) {
    entry.terminal = { error: runnerError(502, "IMAGE_WORKER_OUTPUT_LIMIT", "图片 Worker 控制行超过上限") };
    void stopActiveEntry(entry);
    return;
  }
  let message;
  try {
    message = JSON.parse(bytes.toString("utf8"));
  } catch {
    entry.terminal = { error: runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 返回了无效 JSON") };
    void stopActiveEntry(entry);
    return;
  }
  if (message?.protocolVersion !== 1 || message?.id !== entry.job.id || typeof message?.type !== "string") {
    entry.terminal = { error: runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 返回的任务编号或协议不正确") };
    void stopActiveEntry(entry);
    return;
  }
  if (message.type === "started") return;
  if (message.type === "phase") {
    if (!["preparing", "provider", "postprocessing", "committing"].includes(message.phase)) {
      entry.terminal = { error: runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 返回了无效阶段") };
      void stopActiveEntry(entry);
      return;
    }
    queueEvent(entry, onEvent, { type: "phase", phase: message.phase });
    return;
  }
  if (message.type === "partial") {
    let file;
    try {
      file = normalizeManifestFile(message.file);
    } catch (error) {
      entry.terminal = { error };
      void stopActiveEntry(entry);
      return;
    }
    appendEvent(entry, async () => {
      const [verified] = await verifyImageWorkerFiles(entry.outputDirectory, [file]);
      if (typeof onEvent === "function") {
        await onEvent({
          type: "partial",
          index: Number.isSafeInteger(message.index) ? message.index : null,
          file: verified,
          providerRequestId: safeIdentifier(message.providerRequestId, 200),
        });
      }
    });
    return;
  }
  if (message.type === "usage") {
    let usage;
    try {
      usage = normalizeMetadata(message.usage);
    } catch (error) {
      entry.terminal = { error };
      void stopActiveEntry(entry);
      return;
    }
    const operation = ["generate", "edit", "outpaint"].includes(message.operation) ? message.operation : null;
    const probeId = safeIdentifier(message.probeId, 100);
    queueEvent(entry, onEvent, {
      type: "usage",
      usage,
      providerRequestId: safeIdentifier(message.providerRequestId, 200),
      ...(operation ? { operation } : {}),
      ...(probeId ? { probeId } : {}),
    });
    return;
  }
  if (message.type === "completed") {
    if (entry.terminal) {
      entry.terminal = { error: runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 重复结束任务") };
      void stopActiveEntry(entry);
      return;
    }
    try {
      const files = normalizeManifest(message.result?.files, {
        allowEmpty: entry.job.payload?.kind === "compatibility-probe",
      });
      entry.terminal = {
        result: {
          files,
          usage: normalizeMetadata(message.result?.usage),
          providerRequestId: safeIdentifier(message.result?.providerRequestId, 200),
          requested: normalizeMetadata(message.result?.requested),
        },
      };
    } catch (error) {
      entry.terminal = { error };
      void stopActiveEntry(entry);
    }
    return;
  }
  if (message.type === "error") {
    entry.terminal = { error: workerReportedError(message.error) };
    return;
  }
  entry.terminal = { error: runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 返回了未知事件") };
  void stopActiveEntry(entry);
}

function queueEvent(entry, onEvent, event) {
  if (typeof onEvent !== "function") return;
  appendEvent(entry, () => onEvent(event));
}

function appendEvent(entry, operation) {
  entry.eventChain = entry.eventChain.then(operation).catch((error) => {
    if (!entry.terminal?.error) entry.terminal = { error };
    void stopActiveEntry(entry);
  });
}

// parseControlLine is outside the runner closure; attach the stop operation to entries.
function stopActiveEntry(entry) {
  if (entry.useSystemd) {
    const stopping = typeof entry.stopUnit === "function"
      ? Promise.resolve().then(() => entry.stopUnit(entry.unitName))
      : runStopCommand(entry.spawnProcess, entry.systemctlCommand, entry.unitName);
    return stopping.catch(() => {}).finally(() => killProcessGroup(entry.child, "SIGKILL"));
  }
  killProcessGroup(entry.child, "SIGKILL");
  return Promise.resolve();
}

export async function verifyImageWorkerFiles(outputDirectory, files, { allowEmpty = false } = {}) {
  const root = await fs.realpath(path.resolve(outputDirectory));
  const normalized = normalizeManifest(files, { allowEmpty });
  const seen = new Set();
  const verified = [];
  for (const file of normalized) {
    if (seen.has(file.path)) throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 重复声明输出文件");
    seen.add(file.path);
    const candidate = safeOutputPath(root, file.path);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
      throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出文件不完整");
    }
    const real = await fs.realpath(candidate);
    if (!isPathInside(root, real)) {
      throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出路径越界");
    }
    const sha256 = await hashFile(real);
    if (sha256 !== file.sha256) {
      throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出哈希不一致");
    }
    verified.push({ ...file, absolutePath: real });
  }
  return verified;
}

function normalizeManifest(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length < (allowEmpty ? 0 : 1) || value.length > 10) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出清单无效");
  }
  return value.map(normalizeManifestFile);
}

function normalizeManifestFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出文件记录无效");
  }
  const filePath = normalizeRelativePath(value.path);
  if (!Number.isSafeInteger(value.size) || value.size < 1) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出大小无效");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256 || "")) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出哈希无效");
  }
  if (!Number.isSafeInteger(value.width) || value.width < 1 || !Number.isSafeInteger(value.height) || value.height < 1) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出尺寸无效");
  }
  if (!["png", "jpeg", "webp"].includes(value.format)) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出格式无效");
  }
  const mediaType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[value.format];
  if (value.mediaType !== mediaType) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出媒体类型无效");
  }
  return {
    path: filePath,
    size: value.size,
    sha256: value.sha256,
    width: value.width,
    height: value.height,
    format: value.format,
    mediaType,
    revisedPrompt: boundedText(value.revisedPrompt, 4_000),
  };
}

function createLease(taskDirectory, outputDirectory, result) {
  let disposed = false;
  let disposePromise = null;
  const dispose = () => {
    if (disposed) return Promise.resolve();
    if (disposePromise) return disposePromise;
    disposePromise = fs.rm(taskDirectory, { recursive: true, force: true }).then(() => {
      disposed = true;
      clearTimeout(timer);
    });
    return disposePromise;
  };
  const timer = setTimeout(() => void dispose().catch(() => {}), LEASE_TTL_MS);
  timer.unref?.();
  return { ...result, taskDirectory, outputDirectory, dispose };
}

function normalizeMetadata(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object") {
    throw runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 元数据无效");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 32 * 1024) {
    throw runnerError(502, "IMAGE_WORKER_RESPONSE_INVALID", "图片 Worker 元数据过大");
  }
  return JSON.parse(encoded);
}

function safeOutputPath(root, relativePath) {
  const candidate = path.resolve(root, ...normalizeRelativePath(relativePath).split("/"));
  if (!isPathInside(path.resolve(root), candidate)) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出路径越界");
  }
  return candidate;
}

function normalizeRelativePath(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 1_024 || text.includes("\\") || path.posix.isAbsolute(text)) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出路径无效");
  }
  const normalized = path.posix.normalize(text);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw runnerError(502, "IMAGE_WORKER_MANIFEST_INVALID", "图片 Worker 输出路径无效");
  }
  return normalized;
}

async function hashFile(filename) {
  const handle = await fs.open(filename, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function runStopCommand(spawnProcess, command, unitName) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, ["stop", unitName], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("systemctl stop failed")));
  });
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

function workerEnvironment(source, temporaryDirectory) {
  const environment = {
    HOME: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = source?.[name];
    if (typeof value !== "string" || !value || /[\u0000\r\n]/u.test(value)) continue;
    environment[name] = value;
  }
  return environment;
}

function sensitiveRuntimeBoundary(runtimeRoot, workerFile) {
  const parent = path.dirname(runtimeRoot);
  return parent === path.parse(parent).root || isPathInside(parent, workerFile)
    ? runtimeRoot
    : parent;
}

function systemdUnitIsActive(spawnProcess, command, unitName) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, ["is-active", "--quiet", unitName], {
        stdio: "ignore",
        env: workerEnvironment(process.env, "/tmp"),
      });
    } catch {
      // Recovery must fail closed: an unavailable systemctl cannot prove that
      // the transient unit has stopped, so retain its task directory.
      resolve(true);
      return;
    }
    child.once("error", () => resolve(true));
    child.once("close", (code) => {
      // systemctl uses 3 for inactive and 4 for unknown/not-found. Every
      // other failure is treated as potentially active to avoid deleting a
      // live Worker's inputs or outputs during a control-plane outage.
      resolve(code === 0 || ![3, 4].includes(code));
    });
  });
}

function workerReportedError(value) {
  const statusCode = boundedInteger(value?.statusCode, 502, 400, 599);
  const code = safeIdentifier(value?.code, 100) || "IMAGE_WORKER_FAILED";
  const message = boundedText(value?.message, 1_000) || "图片 Worker 执行失败";
  const error = Object.assign(new Error(message), {
    statusCode,
    code,
    retryable: value?.retryable === true,
    providerRequestId: safeIdentifier(value?.providerRequestId ?? value?.requestId, 200),
    requestId: safeIdentifier(value?.requestId ?? value?.providerRequestId, 200),
  });
  copySafeErrorDetails(error, value);
  return error;
}

function copySafeErrorDetails(target, source) {
  const type = safeIdentifier(source?.type, 200);
  if (type) target.type = type;
  for (const field of ["stage", "operation", "reason"]) {
    const value = safeIdentifier(source?.[field], 100);
    if (value) target[field] = value;
  }
  const model = boundedText(source?.model, 200);
  if (model && !/[\u0000-\u001f\u007f]/u.test(model)) target.model = model;
  for (const field of ["requestedSize", "providerSize", "sourceSize"]) {
    const value = boundedText(source?.[field], 32);
    if (value && /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value)) target[field] = value;
  }
  if (["strict", "soft"].includes(source?.maskMode)) target.maskMode = source.maskMode;
  if (["exact", "seamless"].includes(source?.preserveSource)) target.preserveSource = source.preserveSource;
  if (["reject", "pad-and-crop", "rescale-and-crop"].includes(source?.alignmentPolicy)) {
    target.alignmentPolicy = source.alignmentPolicy;
  }
  if (typeof source?.customSize === "boolean") target.customSize = source.customSize;
  if (Array.isArray(source?.supportedSizes)) {
    target.supportedSizes = [...new Set(source.supportedSizes
      .map((value) => boundedText(value, 32))
      .filter((value) => /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value || "")))]
      .slice(0, 64);
  }
  for (const field of ["requestedFormat", "actualFormat", "outputFormat"]) {
    if (["png", "jpeg", "webp"].includes(source?.[field])) target[field] = source[field];
  }
  if (Number.isSafeInteger(source?.providerStatusCode) && source.providerStatusCode >= 400 && source.providerStatusCode <= 599) {
    target.providerStatusCode = source.providerStatusCode;
  }
  for (const field of ["requestedWidth", "requestedHeight", "actualWidth", "actualHeight"]) {
    if (Number.isSafeInteger(source?.[field]) && source[field] >= 1 && source[field] <= 100_000) {
      target[field] = source[field];
    }
  }
  for (const field of ["requestedCount", "actualCount"]) {
    if (Number.isSafeInteger(source?.[field]) && source[field] >= 0 && source[field] <= 10_000) {
      target[field] = source[field];
    }
  }
  if (Number.isSafeInteger(source?.outputCompression) && source.outputCompression >= 0 && source.outputCompression <= 100) {
    target.outputCompression = source.outputCompression;
  }
  if (source?.moderationDetails != null) {
    const details = sanitizeStructuredDetails(source.moderationDetails);
    if (details != null) target.moderationDetails = details;
  }
}

function sanitizeStructuredDetails(value, depth = 0) {
  if (depth > 4) return null;
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => sanitizeStructuredDetails(entry, depth + 1));
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(key) || /(?:key|token|secret|authorization|prompt|url)/iu.test(key)) continue;
    result[key] = sanitizeStructuredDetails(entry, depth + 1);
  }
  return result;
}

function workerExitError(stderr, exit) {
  const details = boundedText(stderr, 1_000) || "";
  const memory = exit.code === 137
    || exit.signal === "SIGKILL"
    || /(?:oom|out of memory|memory limit|status=9\/kill)/iu.test(details);
  return runnerError(
    502,
    memory ? "IMAGE_WORKER_MEMORY_EXCEEDED" : "IMAGE_WORKER_EXITED",
    memory ? "图片 Worker 超过任务内存预算" : `图片 Worker 异常退出 (${exit.code ?? exit.signal ?? "unknown"})`,
  );
}

function assertJob(job) {
  if (!job || typeof job !== "object" || !/^[a-f0-9]{36}$/u.test(job.id || "")) {
    throw runnerError(400, "INVALID_IMAGE_JOB", "图片 Worker 任务编号无效");
  }
  if (!job.payload || typeof job.payload !== "object" || !job.settings?.config?.worker) {
    throw runnerError(400, "INVALID_IMAGE_JOB", "图片 Worker 任务参数无效");
  }
}

function assertJsonPayload(value) {
  const ancestors = new Set();
  const visit = (entry) => {
    if (entry == null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (!entry || typeof entry !== "object" || entry instanceof Uint8Array) {
      throw runnerError(400, "INVALID_IMAGE_TASK_PAYLOAD", "图片任务只能通过任务目录传递图片字节");
    }
    if (ancestors.has(entry)) throw runnerError(400, "INVALID_IMAGE_TASK_PAYLOAD", "图片任务参数不能循环引用");
    ancestors.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
    } else {
      if (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
        throw runnerError(400, "INVALID_IMAGE_TASK_PAYLOAD", "图片任务参数必须是普通 JSON 对象");
      }
      for (const child of Object.values(entry)) visit(child);
    }
    ancestors.delete(entry);
  };
  visit(value);
}

function assertAbortSignal(value) {
  if (value == null) return;
  if (
    typeof value !== "object"
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function"
  ) throw runnerError(400, "INVALID_ABORT_SIGNAL", "图片 Worker 取消信号无效");
}

function canceledError() {
  return runnerError(499, "IMAGE_TASK_CANCELED", "图片任务已取消");
}

function runnerError(statusCode, code, message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    statusCode,
    code,
    retryable: false,
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function boundedText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maximum) : null;
}

function safeIdentifier(value, maximum) {
  const text = boundedText(value, maximum);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
