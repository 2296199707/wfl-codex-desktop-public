import crypto from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const STATE_SCHEMA_VERSION = 2;
const SECRET_STORE_VERSION = 1;
const MAX_COMMAND_OUTPUT_BYTES = 16_000;
const MAX_PROJECT_SCAN_ENTRIES = 4_000;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
export const ANDROID_APK_JAVA_DEPENDENCY_PACKAGE = "openjdk-17-jdk-headless";
const JAVA_DEPENDENCY_STATE_VERSION = 1;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GRADLE_TASK_PATTERN = /^(?:assemble[A-Za-z0-9_-]*|(?::[A-Za-z0-9_-]+)*:assemble[A-Za-z0-9_-]*)$/u;
const APK_RELATIVE_PATTERN = /\.apk$/iu;
const LIMIT_OVERRIDE_KEYS = new Set([
  "memoryMaxMiB",
  "memoryHighMiB",
  "gradleHeapMiB",
  "workers",
  "cpuQuotaPercent",
  "tasksMax",
  "swapMaxMiB",
  "goMemoryMiB",
  "timeoutMinutes",
]);

export const ANDROID_APK_SIGNING_PASSWORD_MIN_LENGTH = 16;
export const ANDROID_APK_SIGNING_PASSWORD_MAX_LENGTH = 256;
export const ANDROID_APK_MCP_SERVER_NAME = "wfl_android_apk_builder";

export const ANDROID_APK_MCP_TOOLS = Object.freeze([
  {
    name: "android_apk_inspect_project",
    title: "检查 Android 工程",
    description: "检查已授权目录内的任意 Android Gradle 工程，不执行构建或修改文件；此工具不绑定网盘项目。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectPath"],
      properties: {
        projectPath: {
          type: "string",
          description: "已授权工程目录的绝对路径，或相对于授权工程根目录的路径。",
        },
      },
    },
  },
  {
    name: "android_apk_list_signing_profiles",
    title: "列出 Android 签名配置",
    description: "列出可用于签名的配置 ID；不会返回任何密码或密钥内容。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "android_apk_status",
    title: "读取 Android 构建状态",
    description: "读取当前 Android APK 构建状态和最近一次产物信息。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "android_apk_build",
    title: "构建并签名 Android APK",
    description: "仅由 AI 工具调用：在已授权的任意 Android Gradle 工程内执行明确指定的 assemble 任务，并使用已保存的签名配置生成 APK。此工具会消耗 CPU/内存并修改工程输出目录；调用前必须取得用户明确同意，并将 confirm 设置为 true。它不负责对现成 APK 做反编译或改包。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectPath", "gradleTask", "signingProfileId", "confirm"],
      properties: {
        projectPath: { type: "string", description: "已授权 Android Gradle 工程路径。" },
        gradleTask: {
          type: "string",
          description: "只允许 assemble、assembleRelease、:app:assembleRelease 等 assemble 任务；不接受 Shell 命令或 Gradle 参数。",
        },
        signingProfileId: { type: "string", description: "管理员预先保存的签名配置 ID。" },
        artifactPath: {
          type: "string",
          description: "可选：构建后 APK 相对于工程目录的路径。多个 APK 输出时必须提供。",
        },
        outputPath: {
          type: "string",
          description: "可选：签名 APK 相对于工程目录的输出路径；默认写入 .wfl-apk-output。",
        },
        overwrite: { type: "boolean", description: "目标文件已存在时是否允许覆盖；默认 false。" },
        confirm: {
          const: true,
          description: "用户已明确确认本次构建及其资源消耗。必须为 true。",
        },
      },
    },
  },
  {
    name: "android_apk_force_terminate",
    title: "强制终止 Android 构建",
    description: "强制终止当前 Android APK 构建及其子进程，可能留下未完成的 Gradle 输出；调用前必须取得用户明确同意，并将 confirm 设置为 true。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operationId", "confirm"],
      properties: {
        operationId: { type: "string", description: "android_apk_status 返回的当前 operationId。" },
        confirm: {
          const: true,
          description: "用户已明确确认强制终止。必须为 true。",
        },
      },
    },
  },
]);

export function getAndroidApkBuildLimits(overrides = {}) {
  const cpuCount = Math.max(1, os.cpus().length);
  const hostMemoryMiB = Math.max(1_024, Math.floor(os.totalmem() / 1024 / 1024));
  const defaultMemoryMaxMiB = roundMiB(hostMemoryMiB * 0.5, 256, 1_024, 6_144);
  const memoryMaxMiB = effectiveInteger(
    "memoryMaxMiB",
    "WFL_ANDROID_BUILD_MEMORY_MAX_MIB",
    defaultMemoryMaxMiB,
    1_024,
    6_144,
    overrides,
  );
  const memoryHighMiB = effectiveInteger(
    "memoryHighMiB",
    "WFL_ANDROID_BUILD_MEMORY_HIGH_MIB",
    roundMiB(memoryMaxMiB * 0.75, 128, 512, memoryMaxMiB),
    512,
    memoryMaxMiB,
    overrides,
  );
  const gradleHeapMaxMiB = Math.max(512, memoryMaxMiB - 256);
  const gradleHeapMiB = effectiveInteger(
    "gradleHeapMiB",
    "WFL_ANDROID_BUILD_GRADLE_HEAP_MIB",
    roundMiB(memoryMaxMiB * 0.75, 128, 512, gradleHeapMaxMiB),
    512,
    gradleHeapMaxMiB,
    overrides,
  );
  const defaultWorkers = Math.min(6, Math.max(2, cpuCount - 2));
  const workers = effectiveInteger("workers", "WFL_ANDROID_BUILD_WORKERS", defaultWorkers, 1, 8, overrides);
  const cpuQuotaPercent = effectiveInteger(
    "cpuQuotaPercent",
    "WFL_ANDROID_BUILD_CPU_QUOTA_PERCENT",
    Math.min(600, Math.max(150, workers * 100)),
    50,
    800,
    overrides,
  );
  const tasksMax = effectiveInteger(
    "tasksMax",
    "WFL_ANDROID_BUILD_TASKS_MAX",
    Math.max(256, workers * 96),
    64,
    1_024,
    overrides,
  );
  const swapMaxMiB = effectiveInteger(
    "swapMaxMiB",
    "WFL_ANDROID_BUILD_SWAP_MAX_MIB",
    Math.min(512, Math.max(128, roundMiB(memoryMaxMiB * 0.125, 128, 128, 512))),
    0,
    1_024,
    overrides,
  );
  const goMemoryMiB = effectiveInteger(
    "goMemoryMiB",
    "WFL_ANDROID_BUILD_GO_MEMORY_MIB",
    Math.min(1_024, Math.max(512, roundMiB(memoryMaxMiB * 0.375, 128, 256, memoryMaxMiB))),
    256,
    memoryMaxMiB,
    overrides,
  );
  const timeoutMinutes = effectiveInteger(
    "timeoutMinutes",
    "WFL_ANDROID_BUILD_TIMEOUT_MINUTES",
    30,
    10,
    60,
    overrides,
  );
  return Object.freeze({
    cpuCount,
    hostMemoryMiB,
    memoryMaxMiB,
    memoryHighMiB,
    gradleHeapMiB,
    workers,
    cpuQuotaPercent,
    tasksMax,
    swapMaxMiB,
    goMemoryMiB,
    timeoutMinutes,
    gradleMaxHeap: `${gradleHeapMiB}m`,
    memoryHigh: `${memoryHighMiB}M`,
    memoryMax: `${memoryMaxMiB}M`,
    memorySwapMax: `${swapMaxMiB}M`,
    cpuQuota: `${cpuQuotaPercent}%`,
    tasksMaxValue: String(tasksMax),
    workersValue: String(workers),
    timeoutMs: timeoutMinutes * 60 * 1_000,
  });
}

export class AndroidApkBuilderService {
  constructor({
    sourceDirectory,
    stateDirectory,
    keyDirectory = "/opt/wfl-build-tools",
    projectRoots = [],
    androidHome = null,
    mcpScriptPath = null,
  } = {}) {
    if (!sourceDirectory || !stateDirectory) throw new TypeError("sourceDirectory and stateDirectory are required");
    this.sourceDirectory = path.resolve(sourceDirectory);
    this.stateDirectory = path.resolve(stateDirectory);
    this.pluginStateDirectory = path.join(this.stateDirectory, "plugin-data", "android-apk-builder");
    this.statePath = path.join(this.pluginStateDirectory, "state.json");
    this.limitsPath = path.join(this.pluginStateDirectory, "limits.json");
    this.dependencyStatePath = path.join(this.pluginStateDirectory, "java-dependency.json");
    this.buildLockPath = path.join(this.pluginStateDirectory, "build.lock");
    this.toolTokenPath = path.join(this.pluginStateDirectory, "mcp.token");
    this.keyRootDirectory = path.resolve(keyDirectory);
    this.profileDirectory = path.join(this.keyRootDirectory, "android-apk-builder");
    this.androidHome = androidHome || process.env.ANDROID_HOME || "/opt/android-sdk";
    this.projectRootsInput = projectRoots.length ? projectRoots : [this.sourceDirectory];
    this.projectRoots = [];
    this.mcpScriptPath = mcpScriptPath ? path.resolve(mcpScriptPath) : null;
    this.profileStore = new AndroidApkSigningProfileStore({
      directory: this.profileDirectory,
      keyRootDirectory: this.keyRootDirectory,
      legacyDirectory: this.keyRootDirectory,
    });
    this.task = null;
    this.activeCommand = null;
    this.activeSystemdUnit = null;
    this.terminationRequested = false;
    this.limitOverrides = {};
    this.toolToken = null;
    this.state = idleState();
    this.dependencyState = defaultDependencyState();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(this.pluginStateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.pluginStateDirectory, 0o700).catch(() => {});
    try {
      this.state = sanitizeState(JSON.parse(await fs.readFile(this.statePath, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") this.state = idleState();
      else this.state = failedState("无法读取 Android APK 构建状态");
    }
    try {
      const limits = JSON.parse(await fs.readFile(this.limitsPath, "utf8"));
      this.limitOverrides = normalizeLimitOverrides(limits?.overrides || {});
    } catch (error) {
      if (error.code !== "ENOENT") this.limitOverrides = {};
    }
    this.projectRoots = await resolveProjectRoots(this.projectRootsInput);
    await this.profileStore.initialize({ writeOnInitialize });
    this.toolToken = await loadOrCreateToken(this.toolTokenPath, { create: writeOnInitialize });
    if (writeOnInitialize && ["queued", "running"].includes(this.state.status)) {
      this.state = {
        ...this.state,
        status: "failed",
        phase: "failed",
        detail: "服务器重启时 Android APK 构建任务被中断",
        error: "构建进程未能在服务器重启前完成",
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.writeState();
    }
    return this;
  }

  isBusy() {
    return Boolean(this.task);
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async signingSnapshot() {
    return this.profileStore.snapshot();
  }

  async dependencySnapshot() {
    const persisted = await readJson(this.dependencyStatePath);
    this.dependencyState = sanitizeDependencyState(persisted || this.dependencyState);
    const toolPath = tryResolveJavaTool("keytool");
    const status = toolPath
      ? "ready"
      : ["queued", "installing"].includes(this.dependencyState.status)
        ? this.dependencyState.status
        : this.dependencyState.status === "failed" ? "failed" : "missing";
    return {
      ...structuredClone(this.dependencyState),
      package: ANDROID_APK_JAVA_DEPENDENCY_PACKAGE,
      status,
      toolPath,
      detail: toolPath
        ? "Java keytool 已就绪"
        : this.dependencyState.detail || "Android APK 构建需要 Java keytool",
    };
  }

  async addProjectRoot(directory) {
    const roots = await resolveProjectRoots([directory]);
    for (const root of roots) {
      if (!this.projectRoots.some((entry) => entry.path === root.path)) this.projectRoots.push(root);
    }
    return this.projectRoots.map((entry) => entry.path);
  }

  async prepareJavaDependency() {
    if (this.isBusy()) throw builderError(409, "Android APK 构建正在执行，暂时不能准备 Java 依赖");
    const current = await this.dependencySnapshot();
    if (["ready", "queued", "installing"].includes(current.status)) return current;
    if (process.getuid && process.getuid() !== 0) {
      throw builderError(503, "Java 构建依赖需要服务器 root 权限，请由管理员安装");
    }
    const operationId = `android-apk-java-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
    const unit = `wfl-codex-android-apk-java-${systemdUnitToken(operationId)}`;
    await this.writeDependencyState({
      ...defaultDependencyState(),
      operationId,
      unit,
      status: "queued",
      phase: "queued",
      detail: `等待下载 ${ANDROID_APK_JAVA_DEPENDENCY_PACKAGE}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    try {
      await launchJavaDependencyWorker({
        sourceDirectory: this.sourceDirectory,
        statePath: this.dependencyStatePath,
        operationId,
        unit,
      });
    } catch (error) {
      await this.writeDependencyState({
        ...this.dependencyState,
        status: "failed",
        phase: "failed",
        detail: "无法启动 Java 构建依赖下载",
        error: sanitizeErrorMessage(error),
        updatedAt: Date.now(),
        completedAt: Date.now(),
      }).catch(() => {});
      throw builderError(503, `无法启动 Java 构建依赖下载：${sanitizeErrorMessage(error)}`);
    }
    return this.dependencySnapshot();
  }

  async writeDependencyState(value) {
    this.dependencyState = sanitizeDependencyState(value);
    await writeJsonAtomic(this.dependencyStatePath, this.dependencyState, 0o600);
  }

  async saveSigningProfile(input = {}) {
    if (this.isBusy()) throw builderError(409, "Android APK 构建正在执行，暂时不能修改签名配置");
    return this.profileStore.save(input);
  }

  buildLimitsSnapshot() {
    return {
      ...getAndroidApkBuildLimits(this.limitOverrides),
      overrides: structuredClone(this.limitOverrides),
    };
  }

  toolSnapshot() {
    return {
      server: ANDROID_APK_MCP_SERVER_NAME,
      configured: Boolean(this.toolToken),
      script: this.mcpScriptPath,
      tokenFile: this.toolTokenPath,
      buildEntryPoint: "codex-mcp-only",
      automaticBuild: false,
      approvalRequired: true,
    };
  }

  verifyToolToken(value) {
    const token = typeof value === "string" ? value.trim() : "";
    if (!this.toolToken || !token || token.length !== this.toolToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.toolToken));
  }

  async saveBuildLimits(input = {}) {
    if (this.isBusy()) throw builderError(409, "Android APK 构建正在执行，暂时不能修改性能限制");
    const overrides = input?.reset === true ? {} : normalizeLimitOverrides(input?.overrides || input);
    this.limitOverrides = overrides;
    await writeJsonAtomic(this.limitsPath, { schemaVersion: 1, overrides, updatedAt: Date.now() }, 0o600);
    return this.buildLimitsSnapshot();
  }

  async inspectProject(projectValue) {
    const project = await this.resolveProject(projectValue);
    const entries = await fs.readdir(project.path, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^(?:settings\.gradle(?:\.kts)?|build\.gradle(?:\.kts)?|gradlew)$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const appDirectory = path.join(project.path, "app");
    const appFiles = await fs.readdir(appDirectory, { withFileTypes: true }).catch(() => []);
    return {
      projectPath: project.path,
      projectRoot: project.root,
      relativePath: project.relativePath,
      gradleWrapper: files.includes("gradlew"),
      rootFiles: files,
      appDirectory: appFiles.length ? appDirectory : null,
      appBuildFiles: appFiles
        .filter((entry) => entry.isFile() && /^build\.gradle(?:\.kts)?$/u.test(entry.name))
        .map((entry) => entry.name),
      suggestedTasks: ["assembleDebug", "assembleRelease", ":app:assembleRelease"],
    };
  }

  async build({
    projectPath,
    gradleTask,
    signingProfileId,
    artifactPath = null,
    outputPath = null,
    outputDirectory = null,
    overwrite = false,
    confirm = false,
  } = {}) {
    if (confirm !== true) throw builderError(400, "构建 APK 前必须取得用户明确确认");
    if (this.isBusy()) throw builderError(409, "已有 Android APK 构建任务正在执行");
    const project = await this.resolveProject(projectPath);
    const task = normalizeGradleTask(gradleTask);
    const profileId = normalizeProfileId(signingProfileId);
    await this.profileStore.requireProfile(profileId);
    const artifactRelativePath = artifactPath == null || artifactPath === ""
      ? null
      : normalizeProjectRelativePath(artifactPath, "APK 输入路径");
    if (artifactRelativePath && !APK_RELATIVE_PATTERN.test(artifactRelativePath)) {
      throw builderError(400, "APK 输入路径必须以 .apk 结尾");
    }
    const outputRelativePath = outputPath == null || outputPath === ""
      ? null
      : normalizeProjectRelativePath(outputPath, "APK 输出路径");
    if (outputRelativePath && !APK_RELATIVE_PATTERN.test(outputRelativePath)) {
      throw builderError(400, "APK 输出路径必须以 .apk 结尾");
    }
    const buildLock = await acquireBuildLock(this.buildLockPath);
    const operationId = `android-apk-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    const limits = this.buildLimitsSnapshot();
    this.terminationRequested = false;
    this.state = {
      ...idleState(),
      schemaVersion: STATE_SCHEMA_VERSION,
      operationId,
      status: "queued",
      phase: "queued",
      projectPath: project.path,
      projectRelativePath: project.relativePath,
      gradleTask: task,
      signingProfileId: profileId,
      artifactPath: artifactRelativePath,
      outputPath: outputRelativePath,
      limits: publicLimits(limits),
      detail: "已确认，等待 Android 构建资源",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await this.writeState();
      const taskPromise = this.run({
        operationId,
        project,
        gradleTask: task,
        signingProfileId: profileId,
        artifactPath: artifactRelativePath,
        outputPath: outputRelativePath,
        overwrite: overwrite === true,
        limits,
      })
        .catch(async (error) => {
          await this.fail(error);
        })
        .finally(async () => {
          this.activeCommand = null;
          this.activeSystemdUnit = null;
          await buildLock.release().catch(() => {});
          if (this.task === taskPromise) this.task = null;
        });
      this.task = taskPromise;
      return this.snapshot();
    } catch (error) {
      await buildLock.release().catch(() => {});
      throw error;
    }
  }

  async terminate({ operationId, confirm = false } = {}) {
    if (confirm !== true) throw builderError(400, "强制终止前必须取得用户明确确认");
    if (!this.isBusy()) throw builderError(409, "当前没有正在执行的 Android APK 构建");
    if (String(operationId || "") !== this.state.operationId) {
      throw builderError(409, "构建任务已经变化，请先刷新状态");
    }
    this.terminationRequested = true;
    this.state = {
      ...this.state,
      status: "running",
      phase: "terminating",
      detail: "正在强制终止 Android 构建及其子进程",
      updatedAt: Date.now(),
    };
    await this.writeState().catch(() => {});
    this.activeCommand?.kill("SIGKILL");
    if (this.activeSystemdUnit) stopSystemdUnit(this.activeSystemdUnit, { force: true });
    return this.snapshot();
  }

  async run({
    operationId,
    project,
    gradleTask,
    signingProfileId,
    artifactPath,
    outputPath,
    overwrite,
    limits,
  }) {
    let credentials = null;
    try {
      this.assertNotTerminated();
      await this.update("running", "preparing", "正在检查 Android Gradle 工程");
      await assertBuildProject(project.path);
      credentials = await this.profileStore.credentials(signingProfileId);
      this.assertNotTerminated();
      await this.update("running", "building", `正在执行 ${gradleTask}`);
      const goBinDirectory = await resolveGoBinDirectory();
      const environment = {
        ...process.env,
        ANDROID_HOME: this.androidHome,
        ANDROID_SDK_ROOT: this.androidHome,
        WFL_ANDROID_KEYSTORE: credentials.keystorePath,
        WFL_ANDROID_KEY_ALIAS: credentials.alias,
        WFL_ANDROID_STORE_PASSWORD: credentials.password,
        WFL_ANDROID_KEY_PASSWORD: credentials.password,
        // Keep compatibility with the bundled WFL Codex Drive Gradle
        // project; generic Android projects simply ignore these variables.
        WFL_DRIVE_KEYSTORE: credentials.keystorePath,
        WFL_DRIVE_KEY_ALIAS: credentials.alias,
        WFL_DRIVE_STORE_PASSWORD: credentials.password,
        WFL_DRIVE_KEY_PASSWORD: credentials.password,
        PATH: [goBinDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
        GOMAXPROCS: String(limits.workers),
        GOMEMLIMIT: `${limits.goMemoryMiB}MiB`,
      };
      await runAndroidGradleBuild({
        operationId,
        cwd: project.path,
        task: gradleTask,
        env: environment,
        limits,
        register: ({ command, unit }) => {
          this.activeCommand = command;
          this.activeSystemdUnit = unit || null;
          if (this.terminationRequested) command.kill("SIGKILL");
        },
      });
      this.assertNotTerminated();
      await this.update("running", "signing", "正在定位并签名 APK 输出");
      const sourceApk = await locateApk(project.path, artifactPath);
      const targetRelativePath = outputPath || path.posix.join(
        ".wfl-apk-output",
        `${path.basename(sourceApk.relativePath, ".apk")}-${operationId}.apk`,
      );
      const targetPath = outputDirectory
        ? await resolveExternalOutputPath(outputDirectory, targetRelativePath)
        : await resolveWritableProjectPath(project.path, targetRelativePath);
      if (!overwrite && await fileExists(targetPath)) throw builderError(409, "APK 输出文件已存在；如需覆盖请明确传入 overwrite=true");
      await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o750 });
      await signApk(sourceApk.path, targetPath, credentials, this.androidHome, ({ kill, pid }) => {
        this.activeCommand = { kill, pid };
        this.activeSystemdUnit = null;
        if (this.terminationRequested) kill("SIGKILL");
      });
      this.assertNotTerminated();
      const artifact = await describeArtifact(targetPath, {
        projectPath: project.path,
        relativePath: targetRelativePath,
        certificateSha256: credentials.certificateSha256,
      });
      this.assertNotTerminated();
      this.state = {
        ...this.state,
        status: "completed",
        phase: "completed",
        detail: "Android APK 已构建并签名；未自动发布到工具箱",
        artifact,
        completedAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
      };
      await this.writeState();
    } finally {
      if (credentials) credentials.password = "";
    }
  }

  assertNotTerminated() {
    if (this.terminationRequested) throw builderError(499, "Android APK 构建已被强制终止", "ERR_ANDROID_APK_TERMINATED");
  }

  async fail(error) {
    const terminated = error?.code === "ERR_ANDROID_APK_TERMINATED" || this.terminationRequested;
    this.state = {
      ...this.state,
      status: "failed",
      phase: "failed",
      detail: terminated ? "Android APK 构建已强制终止" : "Android APK 构建失败",
      error: terminated ? "构建被管理员强制终止" : sanitizeErrorMessage(error),
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.writeState().catch(() => {});
  }

  async update(status, phase, detail) {
    this.state = { ...this.state, status, phase, detail, error: null, updatedAt: Date.now() };
    await this.writeState();
  }

  async writeState() {
    await writeJsonAtomic(this.statePath, this.state, 0o600);
  }

  async resolveProject(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw.length > 4_096 || /[\u0000\r\n]/u.test(raw)) throw builderError(400, "Android 工程路径无效");
    const candidates = path.isAbsolute(raw)
      ? [path.resolve(raw)]
      : this.projectRoots.map((root) => path.resolve(root.path, raw));
    for (const candidate of candidates) {
      const resolved = await fs.realpath(candidate).catch(() => null);
      if (!resolved) continue;
      const root = this.projectRoots.find((entry) => isPathInside(entry.path, resolved));
      if (!root) continue;
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat?.isDirectory()) continue;
      return {
        path: resolved,
        root: root.path,
        relativePath: path.relative(root.path, resolved) || ".",
      };
    }
    throw builderError(403, "Android 工程不在管理员授权的工程目录内，或目录不存在");
  }

  async callTool(name, argumentsValue = {}) {
    if (!ANDROID_APK_MCP_TOOLS.some((tool) => tool.name === name)) throw builderError(404, `未知 Android APK 工具：${name}`);
    if (name === "android_apk_inspect_project") return this.inspectProject(argumentsValue.projectPath);
    if (name === "android_apk_list_signing_profiles") return this.signingSnapshot();
    if (name === "android_apk_status") {
      return {
        job: this.snapshot(),
        limits: this.buildLimitsSnapshot(),
        authorizedProjectRoots: this.projectRoots.map((entry) => entry.path),
      };
    }
    if (name === "android_apk_build") return this.build(argumentsValue);
    if (name === "android_apk_force_terminate") return this.terminate(argumentsValue);
    throw builderError(404, `未实现 Android APK 工具：${name}`);
  }
}

class AndroidApkSigningProfileStore {
  constructor({ directory, keyRootDirectory, legacyDirectory }) {
    this.directory = path.resolve(directory);
    this.keyRootDirectory = path.resolve(keyRootDirectory);
    this.legacyDirectory = path.resolve(legacyDirectory);
    this.keyPath = path.join(this.directory, "profiles.key");
    this.storePath = path.join(this.directory, "profiles.enc.json");
    this.data = { profiles: [] };
    this.key = null;
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700).catch(() => {});
    this.data = await this.readStore();
    if (writeOnInitialize && this.data.profiles.length === 0) await this.migrateLegacyDriveProfile();
    return this;
  }

  async snapshot() {
    return {
      profiles: this.data.profiles.map(publicProfile),
      encrypted: Boolean(this.key && this.data.profiles.length),
    };
  }

  async save({ id, password, alias = null, keystorePath = null } = {}) {
    const profileId = normalizeProfileId(id);
    const secret = validateSigningPassword(password);
    const profileAlias = normalizeAlias(alias || profileId);
    await this.ensureKey();
    const existing = this.data.profiles.find((profile) => profile.id === profileId);
    if (existing) {
      if (existing.alias !== profileAlias) throw builderError(409, "签名配置已存在且别名不同；请使用新的配置 ID");
      if (existing.password !== secret) throw builderError(409, "签名配置已存在；输入密码与原密钥不匹配");
      if (keystorePath && path.resolve(keystorePath) !== path.resolve(existing.keystorePath)) {
        throw builderError(409, "签名配置已存在且密钥文件不同；请使用新的配置 ID");
      }
      return publicProfile(existing);
    }
    const resolvedKeyPath = await this.resolveKeystorePath(keystorePath, profileId);
    if (!await fileExists(resolvedKeyPath)) {
      const temporaryKeyPath = `${resolvedKeyPath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
      try {
        await generateSigningKey(temporaryKeyPath, profileAlias, secret);
        await fs.rename(temporaryKeyPath, resolvedKeyPath);
      } finally {
        await fs.rm(temporaryKeyPath, { force: true }).catch(() => {});
      }
    }
    const certificateSha256 = await readKeyCertificate(resolvedKeyPath, profileAlias, secret);
    const now = Date.now();
    const profile = {
      id: profileId,
      alias: profileAlias,
      keystorePath: resolvedKeyPath,
      password: secret,
      certificateSha256,
      createdAt: now,
      updatedAt: now,
    };
    this.data.profiles = [...this.data.profiles, profile];
    await this.writeStore();
    return publicProfile(profile);
  }

  async requireProfile(id) {
    const profileId = normalizeProfileId(id);
    const profile = this.data.profiles.find((entry) => entry.id === profileId);
    if (!profile) throw builderError(400, `未找到签名配置：${profileId}`);
    return publicProfile(profile);
  }

  async credentials(id) {
    const profileId = normalizeProfileId(id);
    const profile = this.data.profiles.find((entry) => entry.id === profileId);
    if (!profile) throw builderError(400, `未找到签名配置：${profileId}`);
    await fs.access(profile.keystorePath);
    await fs.chmod(profile.keystorePath, 0o600).catch(() => {});
    return { ...profile, password: profile.password };
  }

  async readStore() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      this.key = await loadSecretKey(this.keyPath, false);
      const data = normalizeProfileStore(decryptEnvelope(envelope, this.key));
      const root = await fs.realpath(this.keyRootDirectory);
      for (const profile of data.profiles) {
        if (!isPathInside(root, profile.keystorePath)) throw new Error("签名密钥文件越过 root-only 目录边界");
        const stat = await fs.lstat(profile.keystorePath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("签名密钥文件不是普通文件");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT" && error.path === this.storePath) return { profiles: [] };
      if (error.code === "ENOENT") throw new Error("Android 签名加密密钥缺失，未读取签名配置");
      throw new Error(`无法读取 Android 签名加密配置：${error.message}`);
    }
  }

  async ensureKey() {
    if (!this.key) this.key = await loadSecretKey(this.keyPath, true);
  }

  async writeStore() {
    await this.ensureKey();
    await writeJsonAtomic(this.storePath, encryptEnvelope({ schemaVersion: 1, ...this.data }, this.key), 0o600);
  }

  async resolveKeystorePath(value, profileId) {
    if (value && !path.isAbsolute(String(value))) throw builderError(400, "已有签名密钥文件路径必须是绝对路径");
    const candidate = value
      ? path.resolve(String(value))
      : path.join(this.directory, `${profileId}.keystore`);
    const root = await fs.realpath(this.keyRootDirectory);
    if (!isPathInside(root, candidate)) throw builderError(403, "签名密钥文件必须位于 root-only 签名目录内");
    if (await fileExists(candidate)) {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw builderError(400, "签名密钥文件必须是普通文件，不能是符号链接");
      const real = await fs.realpath(candidate);
      if (!isPathInside(root, real)) throw builderError(403, "签名密钥文件越过 root-only 目录边界");
      await fs.chmod(real, 0o600).catch(() => {});
    } else {
      await fs.mkdir(path.dirname(candidate), { recursive: true, mode: 0o700 });
    }
    return candidate;
  }

  async migrateLegacyDriveProfile() {
    const configPath = path.join(this.legacyDirectory, "wfl-codex-drive-signing.json");
    const keyPath = path.join(this.legacyDirectory, "wfl-codex-drive-plugin.keystore");
    try {
      const legacy = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (!legacy?.password || !await fileExists(keyPath)) return;
      const alias = normalizeAlias(legacy.alias || "wfl-codex-drive");
      const password = validateSigningPassword(legacy.password);
      const certificateSha256 = await readKeyCertificate(keyPath, alias, password);
      await this.ensureKey();
      this.data.profiles = [{
        id: "wfl-codex-drive",
        alias,
        keystorePath: keyPath,
        password,
        certificateSha256,
        createdAt: Number(legacy.createdAt) || Date.now(),
        updatedAt: Date.now(),
      }];
      await this.writeStore();
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`旧版网盘签名配置迁移失败：${error.message}`);
    }
  }
}

export function normalizeProfileId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!PROFILE_ID_PATTERN.test(id)) throw builderError(400, "签名配置 ID 需为 1–64 位字母、数字、点、下划线或连字符");
  return id;
}

function normalizeAlias(value) {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(alias)) throw builderError(400, "Android 签名别名无效");
  return alias;
}

function validateSigningPassword(value) {
  const password = typeof value === "string" ? value : "";
  if (password.length < ANDROID_APK_SIGNING_PASSWORD_MIN_LENGTH || password.length > ANDROID_APK_SIGNING_PASSWORD_MAX_LENGTH) {
    throw builderError(400, `Android 签名密码长度必须为 ${ANDROID_APK_SIGNING_PASSWORD_MIN_LENGTH}-${ANDROID_APK_SIGNING_PASSWORD_MAX_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(password)) throw builderError(400, "Android 签名密码不能包含控制字符");
  return password;
}

function normalizeGradleTask(value) {
  const task = typeof value === "string" ? value.trim() : "";
  if (!GRADLE_TASK_PATTERN.test(task)) throw builderError(400, "Gradle 任务只允许 assemble 类任务，不接受命令或额外参数");
  return task;
}

function normalizeProjectRelativePath(value, label) {
  const raw = typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
  if (!raw || raw.length > 4_096 || raw.startsWith("/") || /[\u0000\r\n]/u.test(raw)) throw builderError(400, `${label}无效`);
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw builderError(403, `${label}不能越过工程目录`);
  }
  return normalized;
}

function normalizeLimitOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw builderError(400, "Android 构建性能限制格式无效");
  if (Object.keys(value).some((key) => !LIMIT_OVERRIDE_KEYS.has(key))) throw builderError(400, "Android 构建性能限制包含未知字段");
  const output = {};
  for (const key of LIMIT_OVERRIDE_KEYS) {
    if (!Object.hasOwn(value, key) || value[key] === "" || value[key] == null) continue;
    if (!Number.isInteger(Number(value[key]))) throw builderError(400, `${key}必须是整数`);
    output[key] = Number(value[key]);
  }
  const limits = getAndroidApkBuildLimits(output);
  for (const [key, valueToCheck] of Object.entries(output)) {
    const expected = limits[key];
    if (key === "memoryMaxMiB" && (valueToCheck < 1_024 || valueToCheck > 6_144)) throw builderError(400, "内存上限必须为 1024–6144 MiB");
    if (key === "memoryHighMiB" && (valueToCheck < 512 || valueToCheck > limits.memoryMaxMiB)) throw builderError(400, "MemoryHigh 超出有效范围");
    if (key === "gradleHeapMiB" && (valueToCheck < 512 || valueToCheck > Math.max(512, limits.memoryMaxMiB - 256))) throw builderError(400, "Gradle 堆上限超出有效范围");
    if (["workers", "cpuQuotaPercent", "tasksMax", "swapMaxMiB", "goMemoryMiB", "timeoutMinutes"].includes(key) && valueToCheck !== expected) {
      // The effective calculation clamps only through explicit bounded values;
      // a mismatch here means this value was outside its allowed range.
      throw builderError(400, `${key}超出有效范围`);
    }
  }
  return output;
}

function effectiveInteger(key, envName, fallback, minimum, maximum, overrides) {
  const explicit = Object.hasOwn(overrides || {}, key) ? overrides[key] : readEnvironmentInteger(envName);
  const value = explicit == null ? fallback : explicit;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw builderError(400, `${key}超出有效范围 ${minimum}–${maximum}`);
  }
  return value;
}

function readEnvironmentInteger(name) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? value : null;
}

function roundMiB(value, quantum, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(value / quantum) * quantum));
}

function publicLimits(limits) {
  return {
    memoryMaxMiB: limits.memoryMaxMiB,
    memoryHighMiB: limits.memoryHighMiB,
    gradleHeapMiB: limits.gradleHeapMiB,
    workers: limits.workers,
    cpuQuotaPercent: limits.cpuQuotaPercent,
    tasksMax: limits.tasksMax,
    swapMaxMiB: limits.swapMaxMiB,
    goMemoryMiB: limits.goMemoryMiB,
    timeoutMinutes: limits.timeoutMinutes,
  };
}

async function resolveProjectRoots(values) {
  const roots = [];
  for (const value of values) {
    const candidate = path.resolve(String(value));
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real) continue;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isDirectory()) continue;
    if (!roots.some((entry) => entry.path === real)) roots.push({ path: real });
  }
  if (!roots.length) throw new Error("没有可用的 Android APK 授权工程目录");
  return roots;
}

async function assertBuildProject(projectPath) {
  const wrapper = path.join(projectPath, "gradlew");
  const settings = ["settings.gradle", "settings.gradle.kts"];
  const build = ["build.gradle", "build.gradle.kts"];
  if (!await fileExists(wrapper)) throw builderError(400, "Android 工程缺少 gradlew");
  if (!await firstExisting(projectPath, settings)) throw builderError(400, "Android 工程缺少 settings.gradle(.kts)");
  if (!await firstExisting(projectPath, build) && !await firstExisting(path.join(projectPath, "app"), build)) {
    throw builderError(400, "Android 工程缺少 build.gradle(.kts)");
  }
  const stat = await fs.stat(wrapper);
  if (!stat.isFile()) throw builderError(400, "gradlew 不是普通文件");
}

async function firstExisting(directory, names) {
  for (const name of names) if (await fileExists(path.join(directory, name))) return name;
  return null;
}

async function locateApk(projectPath, requestedRelativePath) {
  if (requestedRelativePath) {
    const pathValue = await resolveExistingProjectPath(projectPath, requestedRelativePath);
    const stat = await fs.stat(pathValue);
    if (!stat.isFile() || !APK_RELATIVE_PATTERN.test(pathValue)) throw builderError(400, "指定的 APK 输出不是普通 .apk 文件");
    return { path: pathValue, relativePath: requestedRelativePath };
  }
  const candidates = await findApks(projectPath);
  if (candidates.length === 0) throw builderError(400, "Gradle 构建完成但没有找到 APK；请提供 artifactPath");
  if (candidates.length > 1) {
    throw builderError(409, `找到多个 APK，请提供 artifactPath：${candidates.slice(0, 12).join("、")}`);
  }
  const relativePath = candidates[0];
  return { path: path.resolve(projectPath, ...relativePath.split("/")), relativePath };
}

async function findApks(projectPath) {
  const output = [];
  const queue = [{ directory: projectPath, depth: 0 }];
  let scanned = 0;
  while (queue.length && scanned < MAX_PROJECT_SCAN_ENTRIES) {
    const current = queue.shift();
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++scanned > MAX_PROJECT_SCAN_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isFile() && APK_RELATIVE_PATTERN.test(entry.name)) {
        output.push(path.relative(projectPath, absolute).split(path.sep).join("/"));
        continue;
      }
      if (!entry.isDirectory() || current.depth >= 12) continue;
      if ([".git", ".gradle", "node_modules", ".wfl-apk-output"].includes(entry.name)) continue;
      queue.push({ directory: absolute, depth: current.depth + 1 });
    }
  }
  return output.sort();
}

async function resolveExistingProjectPath(projectPath, relativePath) {
  const candidate = path.resolve(projectPath, ...relativePath.split("/"));
  const real = await fs.realpath(candidate).catch(() => null);
  if (!real || !isPathInside(projectPath, real)) throw builderError(403, "APK 路径越过工程目录或不存在");
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) throw builderError(403, "不允许通过符号链接读取 APK");
  return real;
}

async function resolveWritableProjectPath(projectPath, relativePath) {
  const candidate = path.resolve(projectPath, ...relativePath.split("/"));
  if (!isPathInside(projectPath, candidate)) throw builderError(403, "APK 输出路径越过工程目录");
  try {
    const targetStat = await fs.lstat(candidate);
    if (targetStat.isSymbolicLink()) throw builderError(403, "不允许通过符号链接覆盖 APK 输出");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(candidate);
  let current = parent;
  while (isPathInside(projectPath, current)) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw builderError(403, "APK 输出目录不能包含符号链接");
      const real = await fs.realpath(current);
      if (!isPathInside(projectPath, real)) throw builderError(403, "APK 输出目录越过工程目录");
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parentOfCurrent = path.dirname(current);
      if (parentOfCurrent === current) break;
      current = parentOfCurrent;
    }
  }
  throw builderError(403, "APK 输出目录不在工程目录内");
}

async function describeArtifact(filename, { projectPath, relativePath, certificateSha256 }) {
  const stat = await fs.stat(filename);
  return {
    filename: path.basename(filename),
    absolutePath: filename,
    relativePath,
    size: stat.size,
    sha256: await sha256File(filename),
    certificateSha256,
    projectPath,
  };
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function signApk(source, destination, credentials, androidHome, register = null) {
  const apksigner = await resolveApksigner(androidHome);
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp.apk`;
  try {
    await runCommand(apksigner, [
      "sign",
      "--ks", credentials.keystorePath,
      "--ks-key-alias", credentials.alias,
      "--ks-pass", "env:WFL_ANDROID_SIGNING_PASSWORD",
      "--key-pass", "env:WFL_ANDROID_SIGNING_PASSWORD",
      "--out", temporary,
      source,
    ], {
      cwd: path.dirname(destination),
      env: { WFL_ANDROID_SIGNING_PASSWORD: credentials.password },
      timeoutMs: 60_000,
      register,
    });
    await fs.chmod(temporary, 0o640);
    await fs.rename(temporary, destination);
    const verification = await runCommand(apksigner, ["verify", "--print-certs", destination], {
      cwd: path.dirname(destination),
      timeoutMs: 60_000,
      register,
    });
    const certificateSha256 = parseCertificateSha256(`${verification.stdout}\n${verification.stderr}`);
    if (!certificateSha256 || certificateSha256 !== credentials.certificateSha256) {
      throw builderError(400, "APK 签名证书与所选签名配置不匹配");
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function resolveApksigner(androidHome) {
  const configured = process.env.WFL_ANDROID_APKSIGNER;
  if (configured) return configured;
  const directory = path.join(androidHome || "/opt/android-sdk", "build-tools");
  const versions = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of versions.filter((item) => item.isDirectory()).map((item) => item.name).sort().reverse()) {
    const candidate = path.join(directory, entry, "apksigner");
    if (await fileExists(candidate)) return candidate;
  }
  return "apksigner";
}

async function resolveGoBinDirectory() {
  const configured = process.env.WFL_ANDROID_GO_BIN || process.env.WFL_DRIVE_GO_BIN;
  const candidates = [
    configured,
    "/opt/wfl-build-tools/go/bin/go",
    "/opt/go1.24.13/bin/go",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return path.dirname(candidate);
    } catch {
      // Try the next provisioned or configured Go toolchain.
    }
  }
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      await fs.access(path.join(directory, "go"));
      return directory;
    } catch {
      // Continue searching PATH entries.
    }
  }
  throw builderError(503, "Android APK 构建环境缺少 Go 编译器");
}

async function generateSigningKey(filename, alias, password) {
  await runCommand(resolveJavaTool("keytool"), [
    "-genkeypair", "-v", "-storetype", "PKCS12", "-keystore", filename,
    "-alias", alias, "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000",
    "-dname", `CN=WFL Android APK ${alias}, OU=Android, O=WFL Codex, C=CN`,
    "-storepass:env", "WFL_ANDROID_SIGNING_PASSWORD",
    "-keypass:env", "WFL_ANDROID_SIGNING_PASSWORD",
  ], {
    cwd: path.dirname(filename),
    env: { WFL_ANDROID_SIGNING_PASSWORD: password },
    timeoutMs: 60_000,
  });
  await fs.chmod(filename, 0o600).catch(() => {});
}

async function readKeyCertificate(filename, alias, password) {
  const result = await runCommand(resolveJavaTool("keytool"), [
    "-list", "-v", "-keystore", filename, "-alias", alias,
    "-storepass:env", "WFL_ANDROID_SIGNING_PASSWORD",
  ], {
    cwd: path.dirname(filename),
    env: { WFL_ANDROID_SIGNING_PASSWORD: password },
    timeoutMs: 60_000,
  });
  const digest = parseCertificateSha256(`${result.stdout}\n${result.stderr}`);
  if (!digest) throw builderError(400, "无法读取 Android 签名证书指纹");
  return digest;
}

export function parseCertificateSha256(output) {
  const text = String(output || "").replaceAll(/\r\n?/gu, "\n");
  const digestPattern = /([0-9a-f](?:[\s:]?[0-9a-f]){63})/iu;
  const patterns = [
    /\bcertificate\s+(?:SHA-?256|SHA256)\s+(?:digest|fingerprint)\s*:\s*/giu,
    /\bcertificate\s+fingerprint\s*\(\s*SHA-?256\s*\)\s*:\s*/giu,
    /\b(?:SHA-?256|SHA256)(?:\s+(?:digest|fingerprint))?\s*(?:\([^)]*\))?\s*:\s*/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = text.slice(match.index + match[0].length).match(digestPattern)?.[1];
      const digest = candidate?.replaceAll(/[^0-9a-f]/giu, "").toLowerCase();
      if (digest?.length === 64) return digest;
    }
  }
  for (const line of text.split("\n")) {
    if (!/certificate|signer|fingerprint|sha-?256/iu.test(line)) continue;
    const candidate = line.match(digestPattern)?.[1];
    const digest = candidate?.replaceAll(/[^0-9a-f]/giu, "").toLowerCase();
    if (digest?.length === 64) return digest;
  }
  return null;
}

async function runAndroidGradleBuild({ operationId, cwd, task, env, limits, register }) {
  const args = [
    `-Dorg.gradle.jvmargs=-Xmx${limits.gradleMaxHeap} -Dfile.encoding=UTF-8 -XX:+UseSerialGC`,
    `-Dorg.gradle.workers.max=${limits.workersValue}`,
    "-Dorg.gradle.parallel=false",
    "-Dkotlin.compiler.execution.strategy=in-process",
    "-Dkotlin.daemon.jvm.options=-Xmx512m",
    task,
    "--no-daemon",
    "--console=plain",
  ];
  const systemdRun = process.env.CODEX_DESKTOP_SYSTEMD_RUN || "systemd-run";
  const unit = `wfl-codex-android-apk-${systemdUnitToken(operationId)}`;
  if (process.env.CODEX_DESKTOP_ANDROID_BUILD_SYSTEMD === "0") {
    return runCommand("./gradlew", args, {
      cwd,
      env,
      timeoutMs: limits.timeoutMs,
      register: (command) => register({ command, unit: null }),
    });
  }
  const systemdArgs = [
    "--scope", "--quiet", "--collect", `--unit=${unit}`,
    "--description=WFL Codex Android APK build",
    `--property=MemoryHigh=${limits.memoryHigh}`,
    `--property=MemoryMax=${limits.memoryMax}`,
    `--property=MemorySwapMax=${limits.memorySwapMax}`,
    `--property=CPUQuota=${limits.cpuQuota}`,
    `--property=TasksMax=${limits.tasksMaxValue}`,
    "--property=OOMPolicy=stop", "--property=KillMode=control-group",
    "--nice=10", "--property=IOWeight=50",
    `--property=RuntimeMaxSec=${limits.timeoutMinutes * 60}s`, "--", "./gradlew", ...args,
  ];
  try {
    return await runCommand(systemdRun, systemdArgs, {
      cwd,
      env,
      timeoutMs: limits.timeoutMs,
      register: (command) => register({ command, unit }),
      onTimeout: () => stopSystemdUnit(unit),
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return runCommand("./gradlew", args, {
      cwd,
      env,
      timeoutMs: limits.timeoutMs,
      register: (command) => register({ command, unit: null }),
    });
  }
}

function runCommand(command, args, { cwd, env = {}, timeoutMs = COMMAND_TIMEOUT_MS, onTimeout = null, register = null } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = { head: "", tail: "" };
    const stderr = { head: "", tail: "" };
    let settled = false;
    let timer = null;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const kill = (signal = "SIGTERM") => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between status polling and signalling.
      }
    };
    register?.({ kill, pid: child.pid });
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      kill("SIGTERM");
      const error = new Error(`Android APK 构建命令超时（${Math.round(timeoutMs / 60_000)} 分钟）`);
      error.code = "ERR_ANDROID_APK_COMMAND_TIMEOUT";
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => appendCommandOutput(stdout, chunk));
    child.stderr.on("data", (chunk) => appendCommandOutput(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(null, { stdout: commandOutput(stdout), stderr: commandOutput(stderr), code, signal });
        return;
      }
      const error = new Error(`${path.basename(command)} 执行失败（${signal || `退出码 ${code}`}）`);
      error.code = "ERR_ANDROID_APK_COMMAND_FAILED";
      error.commandOutput = sanitizeErrorMessage(`${commandOutput(stderr)}\n${commandOutput(stdout)}`);
      finish(error);
    });
  });
}

function stopSystemdUnit(unit, { force = false } = {}) {
  if (!unit) return;
  const systemctl = process.env.CODEX_DESKTOP_SYSTEMCTL || "systemctl";
  const commands = force
    ? [["kill", "--kill-who=all", "--signal=SIGKILL", unit], ["stop", "--no-block", unit]]
    : [["stop", "--no-block", unit]];
  for (const args of commands) {
    try {
      const child = spawn(systemctl, args, { stdio: "ignore", detached: true });
      child.unref?.();
    } catch {}
  }
}

function systemdUnitToken(value) {
  return String(value || "android")
    .replace(/[^A-Za-z0-9:_.@-]/gu, "-")
    .slice(0, 160) || "android";
}

async function acquireBuildLock(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await fs.open(filename, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await readJson(filename);
    if (current && processIsRunning(current.pid)) throw builderError(409, "已有 Android APK 构建任务正在执行");
    await fs.rm(filename, { force: true });
    handle = await fs.open(filename, "wx", 0o600);
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`);
  await handle.close();
  return {
    async release() {
      const current = await readJson(filename);
      if (current?.token === token) await fs.rm(filename, { force: true });
    },
  };
}

function processIsRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function encryptEnvelope(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: SECRET_STORE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptEnvelope(envelope, key) {
  if (envelope?.version !== SECRET_STORE_VERSION) throw new Error("签名加密配置版本不受支持");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function loadSecretKey(filename, create) {
  try {
    const key = await fs.readFile(filename);
    if (key.length !== 32) throw new Error("Android 签名加密密钥长度无效");
    await fs.chmod(filename, 0o600).catch(() => {});
    return key;
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    const key = crypto.randomBytes(32);
    try {
      await fs.writeFile(filename, key, { mode: 0o600, flag: "wx" });
      return key;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      return loadSecretKey(filename, false);
    }
  }
}

async function loadOrCreateToken(filename, { create }) {
  try {
    const token = (await fs.readFile(filename, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{64}$/u.test(token)) throw new Error("Android APK MCP token 无效");
    await fs.chmod(filename, 0o600).catch(() => {});
    return token;
  } catch (error) {
    if (error.code !== "ENOENT" || !create) return null;
    const token = crypto.randomBytes(48).toString("base64url");
    await fs.writeFile(filename, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  }
}

function normalizeProfileStore(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.profiles)) throw new Error("签名配置内容无效");
  return {
    profiles: value.profiles.map((profile) => {
      const id = normalizeProfileId(profile.id);
      const alias = normalizeAlias(profile.alias);
      const password = validateSigningPassword(profile.password);
      const keystoreValue = typeof profile.keystorePath === "string" ? profile.keystorePath.trim() : "";
      if (!path.isAbsolute(keystoreValue) || !Number.isFinite(Number(profile.createdAt))) throw new Error("签名配置字段无效");
      const keystorePath = path.resolve(keystoreValue);
      const certificateSha256 = normalizeSha256(profile.certificateSha256);
      return {
        id,
        alias,
        password,
        keystorePath,
        certificateSha256,
        createdAt: Number(profile.createdAt),
        updatedAt: Number(profile.updatedAt) || Number(profile.createdAt),
      };
    }),
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    alias: profile.alias,
    certificateSha256: profile.certificateSha256,
    keystoreConfigured: true,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function normalizeSha256(value) {
  const digest = String(value || "").replaceAll(/[^0-9a-f]/giu, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("签名证书指纹无效");
  return digest;
}

function defaultDependencyState() {
  return {
    schemaVersion: JAVA_DEPENDENCY_STATE_VERSION,
    operationId: null,
    unit: null,
    status: "missing",
    phase: "missing",
    detail: "Android APK 构建需要 Java keytool",
    error: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

function sanitizeDependencyState(value) {
  const state = defaultDependencyState();
  if (!value || typeof value !== "object") return state;
  for (const key of Object.keys(state)) if (Object.hasOwn(value, key)) state[key] = value[key];
  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion !== JAVA_DEPENDENCY_STATE_VERSION) {
    state.schemaVersion = JAVA_DEPENDENCY_STATE_VERSION;
  }
  if (!["missing", "queued", "installing", "completed", "failed"].includes(state.status)) state.status = "missing";
  if (!["missing", "queued", "installing", "completed", "failed"].includes(state.phase)) state.phase = state.status;
  for (const key of ["operationId", "unit", "detail", "error"]) {
    if (state[key] !== null && typeof state[key] !== "string") state[key] = null;
  }
  for (const key of ["startedAt", "updatedAt", "completedAt"]) {
    if (!Number.isFinite(state[key])) state[key] = null;
  }
  return state;
}

function idleState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    operationId: null,
    status: "idle",
    phase: "idle",
    projectPath: null,
    projectRelativePath: null,
    gradleTask: null,
    signingProfileId: null,
    artifactPath: null,
    outputPath: null,
    limits: null,
    detail: "尚未执行 Android APK 构建",
    error: null,
    artifact: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

function failedState(detail) {
  return { ...idleState(), status: "failed", phase: "failed", detail, error: detail, updatedAt: Date.now(), completedAt: Date.now() };
}

function sanitizeState(value) {
  if (!value || typeof value !== "object") return failedState("Android APK 构建状态格式无效");
  const state = idleState();
  for (const key of Object.keys(state)) if (Object.hasOwn(value, key)) state[key] = value[key];
  if (!["idle", "queued", "running", "completed", "failed"].includes(state.status)) return failedState("Android APK 构建状态无效");
  for (const key of ["projectPath", "projectRelativePath", "gradleTask", "signingProfileId", "artifactPath", "outputPath", "detail"]) {
    if (state[key] !== null && typeof state[key] !== "string") state[key] = null;
  }
  if (typeof state.error !== "string" && state.error !== null) state.error = null;
  if (!state.artifact || typeof state.artifact !== "object") state.artifact = null;
  else state.artifact = {
    filename: typeof state.artifact.filename === "string" ? state.artifact.filename : null,
    absolutePath: typeof state.artifact.absolutePath === "string" ? state.artifact.absolutePath : null,
    relativePath: typeof state.artifact.relativePath === "string" ? state.artifact.relativePath : null,
    size: Number.isSafeInteger(state.artifact.size) ? state.artifact.size : null,
    sha256: /^[a-f0-9]{64}$/iu.test(String(state.artifact.sha256 || "")) ? String(state.artifact.sha256).toLowerCase() : null,
    certificateSha256: /^[a-f0-9]{64}$/iu.test(String(state.artifact.certificateSha256 || "")) ? String(state.artifact.certificateSha256).toLowerCase() : null,
    projectPath: typeof state.artifact.projectPath === "string" ? state.artifact.projectPath : null,
  };
  return state;
}

function sanitizeErrorMessage(error) {
  const values = typeof error === "string" ? [error] : [error?.message, error?.commandOutput];
  return values.filter(Boolean).map((value) => String(value).replace(/[\r\n]+/gu, " ").trim()).join("：").slice(0, 1_000) || "未知 Android APK 构建错误";
}

function appendCommandOutput(target, chunk) {
  const text = String(chunk);
  const limit = Math.floor(MAX_COMMAND_OUTPUT_BYTES / 2);
  if (target.head.length < limit) target.head = `${target.head}${text}`.slice(0, limit);
  target.tail = `${target.tail}${text}`.slice(-limit);
}

function commandOutput(target) {
  return target.head && target.tail && target.head !== target.tail
    ? `${target.head}\n…[output truncated]…\n${target.tail}`
    : target.head || target.tail;
}

export function resolveJavaTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const configuredHomes = [process.env.WFL_ANDROID_JAVA_HOME, process.env.JAVA_HOME]
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const pathCandidates = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));
  const candidates = [
    ...configuredHomes.map((home) => path.join(home, "bin", executable)),
    ...pathCandidates,
    "/usr/lib/jvm/default-java/bin/keytool",
    "/usr/lib/jvm/java-21-openjdk-amd64/bin/keytool",
    "/usr/lib/jvm/java-17-openjdk-amd64/bin/keytool",
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved) return resolved;
  throw builderError(
    503,
    `Android APK 构建环境缺少 ${name}；请在 APK 构建器插件中下载并准备 ${ANDROID_APK_JAVA_DEPENDENCY_PACKAGE}`,
  );
}

function tryResolveJavaTool(name) {
  try {
    return resolveJavaTool(name);
  } catch {
    return null;
  }
}

async function launchJavaDependencyWorker({ sourceDirectory, statePath, operationId, unit }) {
  const systemdRun = process.env.CODEX_DESKTOP_SYSTEMD_RUN || "systemd-run";
  const fallbackPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const args = [
    `--unit=${unit}`,
    "--description=WFL Codex Android APK builder Java dependency",
    `--property=WorkingDirectory=${sourceDirectory}`,
    "--property=RuntimeMaxSec=15min",
    "--property=Type=oneshot",
    "--property=User=root",
    "--property=Group=root",
    `--setenv=PATH=${process.env.PATH || fallbackPath}`,
    `--setenv=HOME=${process.env.HOME || "/root"}`,
    `--setenv=CODEX_DESKTOP_ANDROID_APK_DEPENDENCY_STATE=${statePath}`,
    `--setenv=CODEX_DESKTOP_ANDROID_APK_DEPENDENCY_OPERATION=${operationId}`,
    "--collect",
    "--no-block",
    process.execPath,
    path.join(sourceDirectory, "scripts", "install-android-apk-dependencies.mjs"),
    "--worker",
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(systemdRun, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${systemdRun} exited with status ${code}`));
    });
  });
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveExternalOutputPath(directory, relativePath) {
  const root = path.resolve(directory);
  const relative = normalizeProjectRelativePath(relativePath, "APK 输出路径");
  const target = path.resolve(root, relative);
  if (!isPathInside(root, target) || target === root) throw builderError(400, "APK 输出路径无效");
  await fs.mkdir(root, { recursive: true, mode: 0o750 });
  return target;
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filename, value, mode) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    await fs.chmod(temporary, mode).catch(() => {});
    await fs.rename(temporary, filename);
    await fs.chmod(filename, mode).catch(() => {});
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function builderError(statusCode, message, code = null) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}
