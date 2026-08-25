import fs from "node:fs/promises";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

export class MobileAppDependencyManager {
  constructor({ stateDirectory, configStore, sourceDirectory } = {}) {
    this.statePath = path.join(path.resolve(stateDirectory), "mobile-app-dependencies.json");
    this.configStore = configStore;
    this.sourceDirectory = path.resolve(sourceDirectory);
    this.state = { version: 1, flutter: idleDependency(), pub: idleDependency() };
  }

  async initialize() {
    try {
      const value = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      if (value?.version === 1) this.state = normalizeState(value);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    for (const key of ["flutter", "pub"]) {
      if (this.state[key].status === "running" && !isAlive(this.state[key].workerPid)) {
        this.state[key] = {
          ...this.state[key],
          status: "failed",
          detail: "上次依赖准备任务已中断，可以重新准备",
          error: "依赖准备进程不存在",
          completedAt: Date.now(),
          workerPid: null,
        };
      }
    }
    await this.write();
    return this;
  }

  async snapshot() {
    try {
      this.state = normalizeState(JSON.parse(await fs.readFile(this.statePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const config = this.configStore.snapshot();
    const layout = this.configStore.layout();
    const flutter = resolveFlutterCommand(layout.flutterSdk, config.flutterBin);
    const generatedReady = await generatedProjectReady(layout.generatedProject);
    const pub = flutter
      ? {
        ...this.state.pub,
        command: flutter,
        generatedProject: generatedReady ? layout.generatedProject : null,
        status: this.state.pub.status === "running"
          ? "running"
          : this.state.pub.status === "failed"
            ? "failed"
            : generatedReady && this.state.pub.status === "ready" ? "ready" : "missing",
      }
      : { ...this.state.pub, command: null, generatedProject: null };
    const flutterReady = Boolean(
      flutter
      && this.state.flutter.status === "ready"
      && this.state.flutter.command === flutter
      && this.state.flutter.version,
    );
    return {
      flutter: {
        ...this.state.flutter,
        command: flutter,
        status: this.state.flutter.status === "running"
          ? "running"
          : flutterReady ? "ready" : flutter ? "available" : "missing",
      },
      pub,
      layout,
      selectedFlutterBin: config.flutterBin,
      flutterPaths: await this.availableFlutterPaths(),
    };
  }

  async availableFlutterPaths() {
    const config = this.configStore.snapshot();
    const layout = this.configStore.layout();
    const candidates = [
      config.flutterBin,
      process.env.FLUTTER_BIN,
      path.join(layout.flutterSdk, "bin", "flutter"),
      commandFromPath("flutter"),
      "/www/mobile-agent-tooling/flutter/bin/flutter",
      "/opt/flutter/bin/flutter",
      "/root/flutter/bin/flutter",
      "/srv/flutter/bin/flutter",
    ].filter(Boolean);
    const paths = [];
    for (const candidate of [...new Set(candidates)]) {
      const resolved = path.resolve(candidate);
      if (!isExecutable(resolved) || paths.some((entry) => entry.path === resolved)) continue;
      // Do not invoke `flutter --version` here. A fresh Flutter checkout
      // bootstraps its Dart SDK on first invocation; doing that from a status
      // request can be killed by a short synchronous timeout and leave the SDK
      // half-initialized.
      paths.push({ path: resolved, version: readStaticVersion(resolved) });
    }
    return paths;
  }

  async prepareFlutter() {
    const current = await this.snapshot();
    if (current.flutter.status === "ready") return current.flutter;
    if (this.state.flutter.status === "running") return current.flutter;
    this.state.flutter = { ...idleDependency(), status: "running", detail: "正在准备 Flutter SDK", startedAt: Date.now(), updatedAt: Date.now() };
    await this.write();
    const workerPid = this.launchWorker("flutter");
    this.state.flutter.workerPid = workerPid;
    await this.write();
    return this.state.flutter;
  }

  async preparePub() {
    const current = await this.snapshot();
    if (current.flutter.status === "running") throw dependencyError(409, "Flutter SDK 正在准备，请等待完成");
    if (current.flutter.status !== "ready" || !current.flutter.command) throw dependencyError(409, "请先准备或验证 Flutter SDK");
    if (current.pub.status === "ready") return current.pub;
    if (this.state.pub.status === "running") return current.pub;
    this.state.pub = { ...idleDependency(), status: "running", detail: "正在准备 Pub 依赖", startedAt: Date.now(), updatedAt: Date.now() };
    await this.write();
    const workerPid = this.launchWorker("pub");
    this.state.pub.workerPid = workerPid;
    await this.write();
    return this.state.pub;
  }

  launchWorker(kind) {
    const script = path.join(this.sourceDirectory, "scripts", "mobile-app-dependencies.mjs");
    const child = spawn(process.execPath, [
      script,
      "--worker",
      `--kind=${kind}`,
      `--state=${this.statePath}`,
      `--source=${this.sourceDirectory}`,
      `--storage=${this.configStore.layout().root}`,
      `--project=${this.configStore.snapshot().projectPath}`,
      `--flutter-bin=${this.configStore.snapshot().flutterBin || ""}`,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    return child.pid;
  }

  async write() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.statePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export async function runMobileDependencyWorker({ kind, statePath, sourceDirectory, storageRoot, projectPath, flutterBin = null } = {}) {
  const state = await readState(statePath);
  state[kind] = { ...state[kind], version: 1, status: "running", detail: kind === "flutter" ? "正在下载 Flutter SDK" : "正在执行 flutter pub get", error: null, startedAt: Date.now(), updatedAt: Date.now() };
  await writeState(statePath, state);
  try {
    if (kind === "flutter") {
      const result = await installFlutterSdk(storageRoot, {
        flutterBin,
        onProgress: async ({ downloadedBytes, totalBytes, progress }) => {
          state.flutter = {
            ...state.flutter,
            downloadedBytes,
            totalBytes,
            progress,
            detail: `正在下载 Flutter SDK · ${formatBytes(downloadedBytes)}${totalBytes ? ` / ${formatBytes(totalBytes)}（${Math.round(progress * 100)}%）` : ""}`,
            updatedAt: Date.now(),
          };
          await writeState(statePath, state);
        },
      });
      state.flutter = { ...state.flutter, status: "ready", command: result.command, version: result.version, detail: "Flutter SDK 已就绪", progress: 1, completedAt: Date.now(), workerPid: null, updatedAt: Date.now() };
    } else if (kind === "pub") {
      const command = resolveFlutterCommand(path.join(storageRoot, "flutter"), flutterBin);
      if (!command) throw new Error("Flutter SDK 尚未准备");
      const generatedProject = await prepareGeneratedFlutterProject({
        command,
        sourceDirectory,
        storageRoot,
        projectPath,
      });
      state.pub = { ...state.pub, status: "ready", command, generatedProject, detail: "Pub 依赖已就绪", progress: 1, completedAt: Date.now(), workerPid: null, updatedAt: Date.now() };
    } else {
      throw new Error(`未知移动 App 依赖：${kind}`);
    }
  } catch (error) {
    state[kind] = { ...state[kind], status: "failed", detail: "依赖准备失败", error: String(error.message || error), completedAt: Date.now(), workerPid: null, updatedAt: Date.now() };
  }
  await writeState(statePath, state);
}

export async function prepareGeneratedFlutterProject({ command, sourceDirectory, storageRoot, projectPath } = {}) {
  const generatedProject = generatedProjectPath(storageRoot, projectPath);
  const sourceProject = path.resolve(projectPath);
  await fs.mkdir(path.dirname(generatedProject), { recursive: true, mode: 0o750 });
  await run(command, ["create", "--platforms=android,web", "--project-name=wfl_mobile_app", generatedProject], {
    cwd: path.dirname(generatedProject),
    env: flutterEnvironment(command, storageRoot),
  });
  await replaceGeneratedFileTree(sourceProject, generatedProject, "lib");
  await copyGeneratedFile(sourceProject, generatedProject, "pubspec.yaml");
  await copyGeneratedFile(sourceProject, generatedProject, "analysis_options.yaml");
  await replaceGeneratedFileTree(sourceProject, generatedProject, "assets");
  await run(command, ["pub", "get"], {
    cwd: generatedProject,
    env: flutterEnvironment(command, storageRoot),
  });
  return generatedProject;
}

async function installFlutterSdk(storageRoot, { onProgress = null, flutterBin = null } = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("当前按需 Flutter 下载器仅支持 Linux x86_64 服务器");
  }
  const root = path.resolve(storageRoot);
  const sdk = path.join(root, "flutter");
  const existing = resolveFlutterCommand(sdk, flutterBin);
  if (existing) return verifyFlutterSdk(existing, root);
  await fs.mkdir(root, { recursive: true, mode: 0o750 });
  const metadata = await fetch("https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json").then(async (response) => {
    if (!response.ok) throw new Error(`Flutter release list returned HTTP ${response.status}`);
    return response.json();
  });
  const stableHash = metadata.current_release?.stable;
  const release = metadata.releases?.find((entry) => entry.hash === stableHash && entry.channel === "stable");
  if (!release?.archive) throw new Error("官方 Flutter 稳定版归档地址不可用");
  const archive = path.join(root, `.flutter-${process.pid}-${crypto.randomUUID()}.tar.xz`);
  try {
    const response = await fetch(`https://storage.googleapis.com/flutter_infra_release/releases/${release.archive}`);
    if (!response.ok || !response.body) throw new Error(`Flutter SDK 下载失败：HTTP ${response.status}`);
    await downloadStream(response, archive, onProgress);
    await run("tar", ["--no-same-owner", "-xJf", archive, "-C", root]);
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
  }
  const command = resolveFlutterCommand(sdk);
  if (!command) throw new Error("Flutter SDK 解压后未找到 flutter 可执行文件");
  return verifyFlutterSdk(command, root);
}

function resolveFlutterCommand(sdkRoot, configuredPath = null) {
  const configured = configuredPath || process.env.FLUTTER_BIN;
  const candidates = [
    configured,
    path.join(path.resolve(sdkRoot), "bin", "flutter"),
    commandFromPath("flutter"),
  ].filter(Boolean);
  return candidates.find((candidate) => isExecutable(candidate)) || null;
}

function isExecutable(candidate) {
  if (candidate === "flutter") return Boolean(commandFromPath("flutter"));
  try { return requireStat(candidate); } catch { return false; }
}

function commandFromPath(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readStaticVersion(command) {
  const sdkRoot = path.dirname(path.dirname(path.resolve(command)));
  try {
    const version = readFileSync(path.join(sdkRoot, "version"), "utf8").trim();
    return version || null;
  } catch {
    return null;
  }
}

function requireStat(filename) {
  const stat = statSync(filename);
  return stat.isFile() && (stat.mode & 0o111) !== 0;
}

function idleDependency() {
  return { status: "missing", command: null, version: null, generatedProject: null, detail: null, error: null, completedAt: null, startedAt: null, updatedAt: null, workerPid: null, downloadedBytes: 0, totalBytes: null, progress: 0 };
}

function normalizeState(value) {
  return {
    version: 1,
    flutter: normalizeDependency(value.flutter),
    pub: normalizeDependency(value.pub),
  };
}

function normalizeDependency(value) {
  return { ...idleDependency(), ...(value && typeof value === "object" ? value : {}) };
}

function generatedProjectPath(storageRoot, projectPath) {
  const projectKey = crypto.createHash("sha256").update(path.resolve(String(projectPath || ""))).digest("hex").slice(0, 16);
  return path.join(path.resolve(storageRoot), "generated", `flutter-${projectKey}`);
}

async function generatedProjectReady(directory) {
  if (!directory) return false;
  const required = [
    path.join(directory, "pubspec.yaml"),
    path.join(directory, "android", "gradlew"),
    path.join(directory, "android", "settings.gradle.kts"),
  ];
  try {
    await Promise.all(required.map((filename) => fs.access(filename)));
    return true;
  } catch {
    return false;
  }
}

async function replaceGeneratedFileTree(sourceDirectory, generatedProject, name) {
  const source = path.join(sourceDirectory, name);
  const target = path.join(generatedProject, name);
  await fs.rm(target, { recursive: true, force: true });
  if (await pathExists(source)) await fs.cp(source, target, { recursive: true });
}

async function copyGeneratedFile(sourceDirectory, generatedProject, name) {
  const source = path.join(sourceDirectory, name);
  const target = path.join(generatedProject, name);
  await fs.rm(target, { force: true });
  if (await pathExists(source)) await fs.copyFile(source, target);
}

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readState(filename) {
  try { return normalizeState(JSON.parse(await fs.readFile(filename, "utf8"))); }
  catch { return { version: 1, flutter: idleDependency(), pub: idleDependency() }; }
}

async function writeState(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, `${JSON.stringify(normalizeState(value), null, 2)}\n`, { mode: 0o600 });
}

async function verifyFlutterSdk(command, storageRoot) {
  const result = await run(command, ["--version"], {
    env: flutterEnvironment(command, storageRoot),
  });
  const version = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("Flutter "))
    || readStaticVersion(command);
  if (!version) throw new Error("Flutter SDK 启动成功但未返回版本信息");
  return { command, version };
}

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once("error", (error) => reject(new Error(`${command}: ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = (stderr || stdout).trim();
      reject(new Error(`${command} exited with status ${code}${detail ? `: ${detail.slice(-2000)}` : ""}`));
    });
  });
}

function appendTail(current, chunk) {
  return `${current}${Buffer.from(chunk).toString("utf8")}`.slice(-8192);
}

function dependencyError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function flutterEnvironment(command, storageRoot) {
  const sdkRoot = path.dirname(path.dirname(command));
  return {
    ...process.env,
    ...(storageRoot ? { PUB_CACHE: path.join(storageRoot, "pub-cache") } : {}),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: sdkRoot,
  };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function downloadStream(response, destination, onProgress) {
  const totalBytes = Number(response.headers.get("content-length")) || null;
  let downloadedBytes = 0;
  let lastUpdate = 0;
  let progressChain = Promise.resolve();
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastUpdate >= 1_000) {
        lastUpdate = now;
        progressChain = progressChain.then(() => onProgress({ downloadedBytes, totalBytes, progress: totalBytes ? Math.min(1, downloadedBytes / totalBytes) : 0 }));
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(destination, { mode: 0o600 }));
  await progressChain;
  if (onProgress) await onProgress({ downloadedBytes, totalBytes, progress: totalBytes ? 1 : 0 });
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
