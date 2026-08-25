import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const ANDROID_DRIVE_SIGNING_PASSWORD_MIN_LENGTH = 16;
export const ANDROID_DRIVE_SIGNING_PASSWORD_MAX_LENGTH = 256;

const STATE_SCHEMA_VERSION = 1;
const SIGNING_CONFIG_SCHEMA_VERSION = 1;
const SIGNING_BUNDLE_FORMAT = "wfl-android-drive-signing";
const SIGNING_ALIAS = "wfl-codex-drive";
const SIGNING_KEY_FILENAME = "wfl-codex-drive-plugin.keystore";
const SIGNING_CONFIG_FILENAME = "wfl-codex-drive-signing.json";
const LEGACY_SIGNING_KEY_FILENAME = "wfl-codex-drive.keystore";
const BUILD_LOCK_FILENAME = "android-drive-build.lock";
const MAX_SIGNING_KEY_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 16_000;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const APK_NAME_PATTERN = /^wfl-codex-drive_v([0-9A-Za-z.-]+)-oss-arm64-v8a-release\.apk$/u;

// Keep a single Android build from exhausting the main server.  Defaults are
// derived from the current host so a move from a 4 GiB/4-core machine to an
// 8 GiB/8-core machine gets a larger safe budget automatically.  Every value
// has a bounded environment override for operators who want a tighter cap.
export function getAndroidDriveBuildLimits() {
  const cpuCount = Math.max(1, os.cpus().length);
  const hostMemoryMiB = Math.max(1_024, Math.floor(os.totalmem() / 1024 / 1024));
  const defaultMemoryMaxMiB = roundMiB(hostMemoryMiB * 0.5, 256, 1_024, 6_144);
  const memoryMaxMiB = readBoundedInteger(
    "WFL_ANDROID_BUILD_MEMORY_MAX_MIB",
    defaultMemoryMaxMiB,
    1_024,
    6_144,
  );
  const memoryHighMiB = readBoundedInteger(
    "WFL_ANDROID_BUILD_MEMORY_HIGH_MIB",
    roundMiB(memoryMaxMiB * 0.75, 128, 512, memoryMaxMiB),
    512,
    memoryMaxMiB,
  );
  const gradleHeapMaxMiB = Math.max(512, memoryMaxMiB - 256);
  const gradleHeapMiB = readBoundedInteger(
    "WFL_ANDROID_BUILD_GRADLE_HEAP_MIB",
    roundMiB(memoryMaxMiB * 0.75, 128, 512, gradleHeapMaxMiB),
    512,
    gradleHeapMaxMiB,
  );
  const defaultWorkers = Math.min(6, Math.max(2, cpuCount - 2));
  const gradleWorkers = readBoundedInteger("WFL_ANDROID_BUILD_WORKERS", defaultWorkers, 1, 8);
  const cpuQuotaPercent = readBoundedInteger(
    "WFL_ANDROID_BUILD_CPU_QUOTA_PERCENT",
    Math.min(600, Math.max(150, gradleWorkers * 100)),
    50,
    800,
  );
  const tasksMax = readBoundedInteger(
    "WFL_ANDROID_BUILD_TASKS_MAX",
    Math.max(256, gradleWorkers * 96),
    64,
    1_024,
  );
  const swapMaxMiB = readBoundedInteger(
    "WFL_ANDROID_BUILD_SWAP_MAX_MIB",
    Math.min(512, Math.max(128, roundMiB(memoryMaxMiB * 0.125, 128, 128, 512))),
    0,
    1_024,
  );
  const goMemoryMiB = readBoundedInteger(
    "WFL_ANDROID_BUILD_GO_MEMORY_MIB",
    Math.min(1_024, Math.max(512, roundMiB(memoryMaxMiB * 0.375, 128, 256, memoryMaxMiB))),
    256,
    memoryMaxMiB,
  );
  const timeoutMinutes = readBoundedInteger("WFL_ANDROID_BUILD_TIMEOUT_MINUTES", 30, 10, 60);

  return Object.freeze({
    cpuCount,
    hostMemoryMiB,
    gradleMaxHeap: `${gradleHeapMiB}m`,
    gradleHeapMiB,
    gradleWorkers: String(gradleWorkers),
    gradleWorkersCount: gradleWorkers,
    memoryHigh: `${memoryHighMiB}M`,
    memoryHighMiB,
    memoryMax: `${memoryMaxMiB}M`,
    memoryMaxMiB,
    memorySwapMax: `${swapMaxMiB}M`,
    memorySwapMaxMiB: swapMaxMiB,
    cpuQuota: `${cpuQuotaPercent}%`,
    cpuQuotaPercent,
    tasksMax: String(tasksMax),
    tasksMaxCount: tasksMax,
    goMemoryMiB,
    timeoutMinutes,
    timeoutMs: timeoutMinutes * 60 * 1_000,
  });
}

export const ANDROID_DRIVE_BUILD_LIMITS = getAndroidDriveBuildLimits();

export function androidDriveGradleArguments(limits = getAndroidDriveBuildLimits()) {
  return [
    `-Dorg.gradle.jvmargs=-Xmx${limits.gradleMaxHeap} -Dfile.encoding=UTF-8 -XX:+UseSerialGC`,
    `-Dorg.gradle.workers.max=${limits.gradleWorkers}`,
    "-Dorg.gradle.parallel=false",
    "-Dkotlin.compiler.execution.strategy=in-process",
    "-Dkotlin.daemon.jvm.options=-Xmx512m",
    "clean",
    "assembleOssRelease",
    "--no-daemon",
    "--console=plain",
  ];
}

export function androidDriveBuildSystemdArguments(operationId, limits = getAndroidDriveBuildLimits()) {
  const unit = `wfl-codex-android-build-${systemdUnitToken(operationId)}`;
  return {
    unit,
    args: [
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      "--description=WFL Codex Android drive build",
      `--property=MemoryHigh=${limits.memoryHigh}`,
      `--property=MemoryMax=${limits.memoryMax}`,
      `--property=MemorySwapMax=${limits.memorySwapMax}`,
      `--property=CPUQuota=${limits.cpuQuota}`,
      `--property=TasksMax=${limits.tasksMax}`,
      "--property=OOMPolicy=stop",
      "--property=KillMode=control-group",
      "--nice=10",
      "--property=IOWeight=50",
      `--property=RuntimeMaxSec=${limits.timeoutMinutes * 60}s`,
      "--",
      "./gradlew",
      ...androidDriveGradleArguments(limits),
    ],
  };
}

function readBoundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMiB(value, quantum, minimum, maximum) {
  const rounded = Math.round(value / quantum) * quantum;
  return Math.min(maximum, Math.max(minimum, rounded));
}

export function validateAndroidDriveSigningPassword(value) {
  const password = typeof value === "string" ? value : "";
  if (
    password.length < ANDROID_DRIVE_SIGNING_PASSWORD_MIN_LENGTH
    || password.length > ANDROID_DRIVE_SIGNING_PASSWORD_MAX_LENGTH
  ) {
    throw new Error(
      `新 APK 签名密码长度必须为 ${ANDROID_DRIVE_SIGNING_PASSWORD_MIN_LENGTH}-${ANDROID_DRIVE_SIGNING_PASSWORD_MAX_LENGTH} 个字符`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(password)) {
    throw new Error("新 APK 签名密码不能包含控制字符");
  }
  return password;
}

/**
 * The APK signing credential belongs to the build plugin, not to the web
 * login system.  It is generated once, kept root-only, and reused so that
 * subsequent APKs can upgrade one another.  The legacy key has a different
 * filename and is deliberately never replaced or removed.
 */
export class AndroidDriveSigningStore {
  constructor({ keyDirectory = "/opt/wfl-build-tools" } = {}) {
    this.keyDirectory = path.resolve(keyDirectory);
    this.keyPath = path.join(this.keyDirectory, SIGNING_KEY_FILENAME);
    this.configPath = path.join(this.keyDirectory, SIGNING_CONFIG_FILENAME);
  }

  async snapshot() {
    const config = await this.readConfig();
    return {
      configured: Boolean(config),
      alias: config?.alias || SIGNING_ALIAS,
      keystoreFilename: config?.keystoreFilename || SIGNING_KEY_FILENAME,
      certificateSha256: config?.certificateSha256 || null,
      createdAt: config?.createdAt || null,
      updatedAt: config?.updatedAt || null,
      legacyKeyPreserved: await fileExists(path.join(this.keyDirectory, LEGACY_SIGNING_KEY_FILENAME)),
    };
  }

  async ensure(password) {
    const signingPassword = validateAndroidDriveSigningPassword(password);
    await this.prepareDirectory();
    const existing = await this.readConfig();
    if (existing) {
      await fs.access(this.keyPath);
      await fs.chmod(this.keyPath, 0o600).catch(() => {});
      if (existing.password !== signingPassword) {
        throw new Error("输入的 Android 签名密码与当前签名配置不匹配");
      }
      return { ...existing, password: signingPassword, keyPath: this.keyPath };
    }
    if (await fileExists(this.keyPath)) {
      throw new Error("发现未配套的 Android 签名密钥；为保护现有密钥，未自动覆盖，请先导入签名配置");
    }

    const temporaryKeyPath = `${this.keyPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const now = Date.now();
    const config = {
      schemaVersion: SIGNING_CONFIG_SCHEMA_VERSION,
      format: SIGNING_BUNDLE_FORMAT,
      alias: SIGNING_ALIAS,
      keystoreFilename: SIGNING_KEY_FILENAME,
      password: signingPassword,
      certificateSha256: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await generateSigningKey(temporaryKeyPath, signingPassword);
      config.certificateSha256 = await readKeyCertificate(temporaryKeyPath, signingPassword);
      await fs.chmod(temporaryKeyPath, 0o600);
      await fs.rename(temporaryKeyPath, this.keyPath);
      await writeJsonAtomic(this.configPath, config, 0o600);
      return { ...config, password: signingPassword, keyPath: this.keyPath };
    } finally {
      await fs.rm(temporaryKeyPath, { force: true }).catch(() => {});
    }
  }

  async reveal() {
    const config = await this.requireCredentials();
    return {
      alias: config.alias,
      keystoreFilename: config.keystoreFilename,
      password: config.password,
      certificateSha256: config.certificateSha256,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  async exportBundle() {
    const config = await this.requireCredentials();
    const keystore = await fs.readFile(this.keyPath);
    if (keystore.length > MAX_SIGNING_KEY_BYTES) throw new Error("Android 签名密钥文件大小异常");
    const bundle = {
      format: SIGNING_BUNDLE_FORMAT,
      schemaVersion: SIGNING_CONFIG_SCHEMA_VERSION,
      alias: config.alias,
      password: config.password,
      certificateSha256: config.certificateSha256,
      keystoreSha256: crypto.createHash("sha256").update(keystore).digest("hex"),
      keystoreBase64: keystore.toString("base64"),
      exportedAt: Date.now(),
    };
    return {
      filename: "wfl-codex-drive-signing-bundle.json",
      content: `${JSON.stringify(bundle, null, 2)}\n`,
    };
  }

  async importBundle(value, { replace = false } = {}) {
    const bundle = parseSigningBundle(value);
    await this.prepareDirectory();
    const existing = await this.readConfig();
    if (existing && !replace) {
      throw new Error("本机已有 Android 签名配置；如需替换，请明确确认覆盖");
    }
    if (!existing && await fileExists(this.keyPath)) {
      throw new Error("发现未配套的 Android 签名密钥；未覆盖现有文件");
    }

    const keyBytes = Buffer.from(bundle.keystoreBase64, "base64");
    const temporaryKeyPath = `${this.keyPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const backupKeyPath = `${this.keyPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.previous`;
    let backedUp = false;
    try {
      await fs.writeFile(temporaryKeyPath, keyBytes, { mode: 0o600 });
      await fs.chmod(temporaryKeyPath, 0o600);
      const certificateSha256 = await readKeyCertificate(temporaryKeyPath, bundle.password);
      if (bundle.certificateSha256 && bundle.certificateSha256 !== certificateSha256) {
        throw new Error("导入的签名配置证书指纹不匹配");
      }
      if (bundle.keystoreSha256) {
        const digest = crypto.createHash("sha256").update(keyBytes).digest("hex");
        if (bundle.keystoreSha256 !== digest) throw new Error("导入的签名密钥校验失败");
      }
      const now = Date.now();
      const config = {
        schemaVersion: SIGNING_CONFIG_SCHEMA_VERSION,
        format: SIGNING_BUNDLE_FORMAT,
        alias: SIGNING_ALIAS,
        keystoreFilename: SIGNING_KEY_FILENAME,
        password: bundle.password,
        certificateSha256,
        createdAt: Number.isFinite(bundle.createdAt) && bundle.createdAt > 0 ? bundle.createdAt : now,
        updatedAt: now,
      };
      if (existing) {
        await fs.rename(this.keyPath, backupKeyPath);
        backedUp = true;
      }
      await fs.rename(temporaryKeyPath, this.keyPath);
      await writeJsonAtomic(this.configPath, config, 0o600);
      if (backedUp) await fs.rm(backupKeyPath, { force: true });
      return this.snapshot();
    } catch (error) {
      await fs.rm(temporaryKeyPath, { force: true }).catch(() => {});
      if (backedUp) {
        await fs.rm(this.keyPath, { force: true }).catch(() => {});
        await fs.rename(backupKeyPath, this.keyPath).catch(() => {});
      }
      throw error;
    } finally {
      await fs.rm(temporaryKeyPath, { force: true }).catch(() => {});
      if (!backedUp) await fs.rm(backupKeyPath, { force: true }).catch(() => {});
    }
  }

  async requireCredentials() {
    const config = await this.readConfig();
    if (!config) throw new Error("尚未生成 Android 签名配置，请先启动一次构建");
    await fs.access(this.keyPath);
    await fs.chmod(this.keyPath, 0o600).catch(() => {});
    return { ...config, keyPath: this.keyPath };
  }

  async readConfig() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      return normalizeSigningConfig(parsed);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error.message?.startsWith("签名配置")) throw error;
      throw new Error("Android 签名配置无法读取");
    }
  }

  async prepareDirectory() {
    await fs.mkdir(this.keyDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.keyDirectory, 0o700).catch(() => {});
  }
}

export class AndroidDriveReleaseJob {
  constructor({
    sourceDirectory,
    activeAppDirectory = null,
    stateDirectory,
    keyDirectory = "/opt/wfl-build-tools",
    androidHome = null,
  }) {
    this.sourceDirectory = path.resolve(sourceDirectory);
    this.activeAppDirectory = activeAppDirectory ? path.resolve(activeAppDirectory) : null;
    this.stateDirectory = path.resolve(stateDirectory);
    this.statePath = path.join(this.stateDirectory, "android-drive-release.json");
    this.buildLockPath = path.join(this.stateDirectory, BUILD_LOCK_FILENAME);
    this.keyDirectory = path.resolve(keyDirectory);
    this.androidHome = androidHome || process.env.ANDROID_HOME || "/opt/android-sdk";
    this.driveDirectory = path.join(this.sourceDirectory, "tools", "wfl-codex-drive");
    this.signingStore = new AndroidDriveSigningStore({ keyDirectory: this.keyDirectory });
    this.task = null;
    this.state = idleState();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o750 });
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      this.state = sanitizeState(parsed);
    } catch (error) {
      if (error.code !== "ENOENT") this.state = failedState("无法读取 APK 构建状态");
    }
    if (writeOnInitialize && ["queued", "running"].includes(this.state.status)) {
      this.state = {
        ...this.state,
        status: "failed",
        phase: "failed",
        detail: "服务器重启时 APK 构建任务被中断",
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
    return this.signingStore.snapshot();
  }

  buildLimitsSnapshot() {
    return getAndroidDriveBuildLimits();
  }

  async revealSigning() {
    return this.signingStore.reveal();
  }

  async exportSigningBundle() {
    return this.signingStore.exportBundle();
  }

  async importSigningBundle(bundle, options = {}) {
    if (this.isBusy()) throw Object.assign(new Error("APK 构建正在执行，暂时不能导入签名配置"), { statusCode: 409 });
    return this.signingStore.importBundle(bundle, options);
  }

  async start({ password } = {}) {
    if (this.isBusy()) {
      const error = new Error("已有 Android APK 构建任务正在执行");
      error.statusCode = 409;
      throw error;
    }
    let signingPassword;
    try {
      signingPassword = validateAndroidDriveSigningPassword(password);
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
    const buildLock = await acquireAndroidDriveBuildLock(this.buildLockPath);
    let version;
    try {
      version = await readAndroidVersion(this.driveDirectory);
    } catch (error) {
      await buildLock.release().catch(() => {});
      throw error;
    }
    const operationId = `android-drive-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    this.state = {
      ...idleState(),
      schemaVersion: STATE_SCHEMA_VERSION,
      operationId,
      status: "queued",
      phase: "queued",
      version,
      detail: "已排队，准备生成新的 Android 签名",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.writeState();

    try {
      const task = this.run({ operationId, version, password: signingPassword })
        .catch(async (error) => {
          await this.fail(error);
        })
        .finally(async () => {
          await buildLock.release().catch(() => {});
          if (this.task === task) this.task = null;
        });
      this.task = task;
      return this.snapshot();
    } catch (error) {
      await buildLock.release().catch(() => {});
      throw error;
    }
  }

  async run({ operationId, version, password }) {
    let signingCredentials = null;
    let signingPassword = password;
    try {
      const buildLimits = getAndroidDriveBuildLimits();
      await this.update("running", "preparing", "正在检查 Android 构建环境");
      await this.assertBuildPrerequisites();
      await this.update("running", "signing-key", "正在准备可复用的 Android 签名配置");
      signingCredentials = await this.signingStore.ensure(signingPassword);
      signingPassword = "";

      await this.update("running", "building", "正在构建并签名 arm64-v8a 正式 APK");
      const goBinDirectory = await resolveGoBinDirectory();
      const buildEnvironment = {
        ...process.env,
        ANDROID_HOME: this.androidHome,
        ANDROID_SDK_ROOT: this.androidHome,
        WFL_DRIVE_KEYSTORE: signingCredentials.keyPath,
        WFL_DRIVE_KEY_ALIAS: signingCredentials.alias,
        WFL_DRIVE_STORE_PASSWORD: signingCredentials.password,
        WFL_DRIVE_KEY_PASSWORD: signingCredentials.password,
      };
      buildEnvironment.PATH = [goBinDirectory, buildEnvironment.PATH].filter(Boolean).join(path.delimiter);
      buildEnvironment.GOMAXPROCS = buildLimits.gradleWorkers;
      buildEnvironment.GOMEMLIMIT = `${buildLimits.goMemoryMiB}MiB`;
      await runAndroidDriveGradleBuild({
        operationId,
        cwd: this.driveDirectory,
        env: buildEnvironment,
        limits: buildLimits,
      });

      await this.update("running", "verifying", "正在验证 APK 签名和完整性");
      const apkPath = await locateReleaseApk(this.driveDirectory, version);
      const certificate = await verifyApk(
        apkPath,
        signingCredentials.keyPath,
        signingCredentials.password,
        this.androidHome,
      );
      const artifact = await publishArtifact({
        sourceApk: apkPath,
        version,
        certificateSha256: certificate.sha256,
        sourceDirectory: this.sourceDirectory,
        activeAppDirectory: this.activeAppDirectory,
      });
      this.state = {
        ...this.state,
        operationId,
        status: "completed",
        phase: "completed",
        detail: "新签名 APK 已生成，工具箱下载文件已更新",
        artifact,
        certificateSha256: certificate.sha256,
        completedAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
      };
      await this.writeState();
    } finally {
      signingPassword = "";
      if (signingCredentials) signingCredentials.password = "";
    }
  }

  async fail(error) {
    const detail = sanitizeErrorMessage(error);
    this.state = {
      ...this.state,
      status: "failed",
      phase: "failed",
      detail: "Android APK 构建失败",
      error: detail,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.writeState().catch(() => {});
  }

  async update(status, phase, detail) {
    this.state = {
      ...this.state,
      status,
      phase,
      detail,
      updatedAt: Date.now(),
      error: null,
    };
    await this.writeState();
  }

  async writeState() {
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    try {
      await fs.rename(temporary, this.statePath);
      await fs.chmod(this.statePath, 0o600).catch(() => {});
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async assertBuildPrerequisites() {
    const required = [
      path.join(this.driveDirectory, "gradlew"),
      path.join(this.driveDirectory, "settings.gradle"),
      path.join(this.driveDirectory, "app", "build.gradle"),
    ];
    await Promise.all(required.map((filename) => fs.access(filename)));
    await fs.access(path.join(this.androidHome, "platforms"));
    await fs.access(path.join(this.androidHome, "ndk"));
    await resolveGoBinDirectory();
  }
}

async function acquireAndroidDriveBuildLock(lockPath) {
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o750 });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readAndroidDriveBuildLock(lockPath);
    if (existing && processIsRunning(existing.pid)) {
      const busy = new Error("已有 Android APK 构建任务正在执行");
      busy.statusCode = 409;
      throw busy;
    }
    await fs.rm(lockPath, { force: true });
    handle = await fs.open(lockPath, "wx", 0o600);
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`);
  await handle.close();

  return {
    async release() {
      const current = await readAndroidDriveBuildLock(lockPath);
      if (current?.token === token) await fs.rm(lockPath, { force: true });
    },
  };
}

async function readAndroidDriveBuildLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
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

async function generateSigningKey(keyPath, password) {
  await runCommand(resolveJavaTool("keytool"), [
    "-genkeypair",
    "-v",
    "-storetype",
    "PKCS12",
    "-keystore",
    keyPath,
    "-alias",
    SIGNING_ALIAS,
    "-keyalg",
    "RSA",
    "-keysize",
    "4096",
    "-validity",
    "10000",
    "-dname",
    "CN=WFL Codex Drive, OU=Android, O=WFL Codex, C=CN",
    "-storepass:env",
    "WFL_DRIVE_SIGNING_PASSWORD",
    "-keypass:env",
    "WFL_DRIVE_SIGNING_PASSWORD",
  ], {
    cwd: path.dirname(keyPath),
    env: { WFL_DRIVE_SIGNING_PASSWORD: password },
    timeoutMs: 60_000,
  });
}

async function readKeyCertificate(keyPath, password) {
  const result = await runCommand(resolveJavaTool("keytool"), [
    "-list",
    "-v",
    "-keystore",
    keyPath,
    "-alias",
    SIGNING_ALIAS,
    "-storepass:env",
    "WFL_DRIVE_SIGNING_PASSWORD",
  ], {
    cwd: path.dirname(keyPath),
    env: { WFL_DRIVE_SIGNING_PASSWORD: password },
    timeoutMs: 60_000,
  });
  const certificateSha256 = parseCertificateSha256(`${result.stdout}\n${result.stderr}`);
  if (!certificateSha256) throw new Error("无法读取 Android 签名证书指纹");
  return certificateSha256;
}

function parseSigningBundle(value) {
  let bundle = value;
  if (typeof value === "string") {
    try {
      bundle = JSON.parse(value);
    } catch {
      throw new Error("Android 签名配置文件不是有效 JSON");
    }
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Android 签名配置格式无效");
  }
  if (bundle.format !== SIGNING_BUNDLE_FORMAT) throw new Error("不是 WFL Android 网盘签名配置");
  if (String(bundle.alias || "") !== SIGNING_ALIAS) throw new Error("Android 签名别名不匹配");
  const password = validateAndroidDriveSigningPassword(String(bundle.password || ""));
  const keystoreBase64 = String(bundle.keystoreBase64 || "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(keystoreBase64) || keystoreBase64.length > MAX_SIGNING_KEY_BYTES * 2) {
    throw new Error("Android 签名密钥数据无效");
  }
  const keyBytes = Buffer.from(keystoreBase64, "base64");
  if (keyBytes.length < 512 || keyBytes.length > MAX_SIGNING_KEY_BYTES) {
    throw new Error("Android 签名密钥文件大小无效");
  }
  const certificateSha256 = bundle.certificateSha256 == null
    ? null
    : normalizeSha256(bundle.certificateSha256, "签名证书指纹");
  const keystoreSha256 = bundle.keystoreSha256 == null
    ? null
    : normalizeSha256(bundle.keystoreSha256, "签名密钥校验值");
  return {
    password,
    keystoreBase64,
    certificateSha256,
    keystoreSha256,
    createdAt: Number(bundle.createdAt),
  };
}

function normalizeSigningConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("签名配置格式无效");
  }
  if (Number(value.schemaVersion) !== SIGNING_CONFIG_SCHEMA_VERSION || value.format !== SIGNING_BUNDLE_FORMAT) {
    throw new Error("签名配置版本不受支持");
  }
  if (String(value.alias || "") !== SIGNING_ALIAS || String(value.keystoreFilename || "") !== SIGNING_KEY_FILENAME) {
    throw new Error("签名配置标识不匹配");
  }
  let password;
  try {
    password = validateAndroidDriveSigningPassword(String(value.password || ""));
  } catch {
    throw new Error("签名配置密码无效");
  }
  const certificateSha256 = normalizeSha256(value.certificateSha256, "签名证书指纹");
  const createdAt = Number(value.createdAt);
  const updatedAt = Number(value.updatedAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error("签名配置时间无效");
  }
  return {
    schemaVersion: SIGNING_CONFIG_SCHEMA_VERSION,
    format: SIGNING_BUNDLE_FORMAT,
    alias: SIGNING_ALIAS,
    keystoreFilename: SIGNING_KEY_FILENAME,
    password,
    certificateSha256,
    createdAt,
    updatedAt,
  };
}

function normalizeSha256(value, label) {
  const digest = String(value || "").replaceAll(/[^0-9a-f]/giu, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}无效`);
  return digest;
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

function idleState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    operationId: null,
    status: "idle",
    phase: "idle",
    version: null,
    detail: "尚未生成新的 APK",
    error: null,
    artifact: null,
    certificateSha256: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

function failedState(detail) {
  return {
    ...idleState(),
    status: "failed",
    phase: "failed",
    detail,
    error: detail,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  };
}

function sanitizeState(value) {
  if (!value || typeof value !== "object") return failedState("APK 构建状态格式无效");
  const state = idleState();
  for (const key of Object.keys(state)) {
    if (Object.hasOwn(value, key)) state[key] = value[key];
  }
  if (!Number.isInteger(state.schemaVersion)) state.schemaVersion = STATE_SCHEMA_VERSION;
  if (!["idle", "queued", "running", "completed", "failed"].includes(state.status)) return failedState("APK 构建状态无效");
  if (typeof state.detail !== "string") state.detail = "--";
  if (typeof state.error !== "string" && state.error !== null) state.error = null;
  if (state.artifact && typeof state.artifact === "object") {
    state.artifact = {
      filename: typeof state.artifact.filename === "string" ? state.artifact.filename : null,
      version: typeof state.artifact.version === "string" ? state.artifact.version : null,
      size: Number.isSafeInteger(state.artifact.size) ? state.artifact.size : null,
      sha256: /^[a-f0-9]{64}$/iu.test(String(state.artifact.sha256 || ""))
        ? String(state.artifact.sha256).toLowerCase()
        : null,
      download: typeof state.artifact.download === "string" ? state.artifact.download : null,
    };
  } else {
    state.artifact = null;
  }
  if (!/^[a-f0-9]{64}$/iu.test(String(state.certificateSha256 || ""))) state.certificateSha256 = null;
  return state;
}

async function readAndroidVersion(driveDirectory) {
  const source = await fs.readFile(path.join(driveDirectory, "app", "build.gradle"), "utf8");
  const match = source.match(/\bversionName\s+['"]([^'"]+)['"]/u);
  const version = match?.[1] || "";
  if (!VERSION_PATTERN.test(version)) throw new Error("Android 网盘版本号无效");
  return version;
}

async function locateReleaseApk(driveDirectory, version) {
  const outputDirectory = path.join(driveDirectory, "app", "build", "outputs", "apk", "oss", "release");
  const files = await fs.readdir(outputDirectory);
  const apkName = files.find((name) => {
    const match = name.match(APK_NAME_PATTERN);
    return match && match[1] === version;
  });
  if (!apkName) throw new Error("正式 arm64-v8a APK 未生成");
  const apkPath = path.join(outputDirectory, apkName);
  const stat = await fs.stat(apkPath);
  if (!stat.isFile() || stat.size < 1_000_000) throw new Error("正式 APK 文件不完整");
  return apkPath;
}

async function verifyApk(apkPath, keyPath, password, androidHome = null) {
  const apksigner = await resolveApksigner(androidHome || process.env.ANDROID_HOME || "/opt/android-sdk");
  const apkResult = await runCommand(apksigner, ["verify", "--print-certs", apkPath], {
    cwd: path.dirname(apkPath),
    timeoutMs: 60_000,
  });
  const apkSha = parseCertificateSha256(`${apkResult.stdout}\n${apkResult.stderr}`);
  if (!apkSha) throw new Error("无法读取 APK 签名证书指纹");
  const keyResult = await runCommand(resolveJavaTool("keytool"), [
    "-list",
    "-v",
    "-keystore",
    keyPath,
    "-alias",
    "wfl-codex-drive",
    "-storepass:env",
    "WFL_DRIVE_SIGNING_PASSWORD",
  ], {
    cwd: path.dirname(keyPath),
    env: { WFL_DRIVE_SIGNING_PASSWORD: password },
    timeoutMs: 60_000,
  });
  const keySha = parseCertificateSha256(`${keyResult.stdout}\n${keyResult.stderr}`);
  if (!keySha || keySha !== apkSha) throw new Error("APK 签名证书与新密钥不匹配");
  return { sha256: apkSha };
}

async function publishArtifact({
  sourceApk,
  version,
  certificateSha256,
  sourceDirectory,
  activeAppDirectory,
}) {
  const sourceStat = await fs.stat(sourceApk);
  const bytes = await fs.readFile(sourceApk);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = `wfl-codex-drive-arm64-v${version}.apk`;
  const download = `/downloads/${filename}`;
  const roots = uniquePaths([
    path.join(sourceDirectory, "public"),
    activeAppDirectory ? path.join(activeAppDirectory, "public") : null,
  ]);
  for (const publicRoot of roots) {
    const downloadDirectory = path.join(publicRoot, "downloads");
    await fs.mkdir(downloadDirectory, { recursive: true, mode: 0o755 });
    await copyFileAtomic(sourceApk, path.join(downloadDirectory, filename), 0o644);
    const metadataPath = path.join(downloadDirectory, "wfl-codex-drive.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    metadata.version = version;
    metadata.size = sourceStat.size;
    metadata.sha256 = sha256;
    metadata.download = download;
    metadata.signingCertificateSha256 = certificateSha256;
    const progressNote = "支持通知栏上传进度、速度/ETA、失败提示和后台上传。";
    if (!String(metadata.notes || "").includes(progressNote)) {
      metadata.notes = `${String(metadata.notes || "").trim()} ${progressNote}`.trim();
    }
    await writeJsonAtomic(metadataPath, metadata, 0o644);

    const indexPath = path.join(publicRoot, "index.html");
    const index = await fs.readFile(indexPath, "utf8");
    const replacement = index.replace(
      /\/downloads\/wfl-codex-drive-arm64-v[0-9A-Za-z.-]+\.apk/gu,
      download,
    );
    if (replacement === index) throw new Error("工具箱页面未找到网盘 APK 下载链接");
    await writeTextAtomic(indexPath, replacement, 0o644);
  }
  return {
    filename,
    version,
    size: sourceStat.size,
    sha256,
    download,
  };
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

async function copyFileAtomic(source, destination, mode) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJsonAtomic(filename, value, mode) {
  await writeTextAtomic(filename, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function writeTextAtomic(filename, content, mode) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function parseCertificateSha256(output) {
  const text = String(output || "").replaceAll(/\r\n?/gu, "\n");
  const digestPattern = /([0-9a-f](?:[\s:]?[0-9a-f]){63})/iu;
  const labeledPatterns = [
    /\bcertificate\s+(?:SHA-?256|SHA256)\s+(?:digest|fingerprint)\s*:\s*/giu,
    /\bcertificate\s+fingerprint\s*\(\s*SHA-?256\s*\)\s*:\s*/giu,
    /\b(?:SHA-?256|SHA256)(?:\s+(?:digest|fingerprint))?\s*(?:\([^)]*\))?\s*:\s*/giu,
  ];
  for (const pattern of labeledPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = text.slice(match.index + match[0].length).match(digestPattern)?.[1];
      const digest = candidate?.replaceAll(/[^0-9a-f]/giu, "").toLowerCase();
      if (digest?.length === 64) return digest;
    }
  }
  // Some JDK/apksigner versions wrap the label or omit the word "digest".
  // Inspect only lines that identify a SHA-256 certificate value so a SHA-1
  // or MD5 line can never be accepted accidentally.
  for (const line of text.split("\n")) {
    if (!/certificate|signer|fingerprint|sha-?256/iu.test(line)) continue;
    const candidate = line.match(digestPattern)?.[1];
    const digest = candidate?.replaceAll(/[^0-9a-f]/giu, "").toLowerCase();
    if (digest?.length === 64) return digest;
  }
  return null;
}

async function resolveApksigner(androidHome) {
  const configured = process.env.WFL_DRIVE_APKSIGNER;
  if (configured) return configured;
  const buildToolsDirectory = path.join(androidHome || "/opt/android-sdk", "build-tools");
  try {
    const versions = (await fs.readdir(buildToolsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      const candidate = path.join(buildToolsDirectory, version, "apksigner");
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Try the next installed build-tools version.
      }
    }
  } catch {
    // Fall back to PATH so custom Android SDK installations still work.
  }
  return "apksigner";
}

function resolveJavaTool(name) {
  return process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
}

async function resolveGoBinDirectory() {
  const configured = process.env.WFL_DRIVE_GO_BIN;
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
      // Try the next configured or provisioned Go installation.
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
  throw new Error("Android 构建环境缺少 Go 编译器");
}

function sanitizeErrorMessage(error) {
  const values = typeof error === "string"
    ? [error]
    : [error?.message, error?.commandOutput];
  const message = values
    .filter((value) => value)
    .map((value) => String(value).replace(/[\r\n]+/gu, " ").trim())
    .join("：") || "未知构建错误";
  return message.slice(0, 1_000) || "未知构建错误";
}

async function runAndroidDriveGradleBuild({ operationId, cwd, env, limits }) {
  const systemdRun = process.env.CODEX_DESKTOP_SYSTEMD_RUN || "systemd-run";
  const systemdBuild = androidDriveBuildSystemdArguments(operationId, limits);
  if (process.env.CODEX_DESKTOP_ANDROID_BUILD_SYSTEMD === "0") {
    return runCommand("./gradlew", androidDriveGradleArguments(limits), {
      cwd,
      env,
      timeoutMs: limits.timeoutMs,
    });
  }

  try {
    return await runCommand(systemdRun, systemdBuild.args, {
      cwd,
      env,
      timeoutMs: limits.timeoutMs,
      onTimeout: () => stopSystemdUnit(systemdBuild.unit),
    });
  } catch (error) {
    // Local development environments may not have systemd.  The Gradle JVM,
    // worker count and Go limits are still enforced in the direct fallback;
    // on the managed server, a systemd setup failure is surfaced instead of
    // silently starting an unbounded build.
    if (error?.code !== "ENOENT") throw error;
    return runCommand("./gradlew", androidDriveGradleArguments(limits), {
      cwd,
      env,
      timeoutMs: limits.timeoutMs,
    });
  }
}

function stopSystemdUnit(unit) {
  if (!unit) return;
  const systemctl = process.env.CODEX_DESKTOP_SYSTEMCTL || "systemctl";
  try {
    const child = spawn(systemctl, ["stop", "--no-block", unit], {
      stdio: "ignore",
      detached: true,
    });
    child.unref?.();
  } catch {
    // The command timeout is still reported to the caller.  There is no
    // useful recovery action if systemctl itself cannot be started.
  }
}

function systemdUnitToken(value) {
  const token = String(value || "android")
    .replace(/[^A-Za-z0-9:_.@-]/gu, "-")
    .slice(0, 160);
  return token || "android";
}

function runCommand(
  command,
  args,
  { cwd, env = {}, timeoutMs = COMMAND_TIMEOUT_MS, onTimeout = null } = {},
) {
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
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
    };
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Timeout cleanup is best effort; the original build timeout remains
        // the error returned to the caller.
      }
      kill();
      const error = new Error(`构建命令超时（${Math.round(timeoutMs / 60_000)} 分钟）`);
      error.code = "ERR_ANDROID_DRIVE_COMMAND_TIMEOUT";
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      appendCommandOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendCommandOutput(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(null, {
          stdout: commandOutput(stdout),
          stderr: commandOutput(stderr),
          code,
          signal,
        });
        return;
      }
      const error = new Error(`${path.basename(command)} 执行失败（${signal || `退出码 ${code}`}）`);
      error.code = "ERR_ANDROID_DRIVE_COMMAND_FAILED";
      error.commandOutput = sanitizeErrorMessage(`${commandOutput(stderr)}\n${commandOutput(stdout)}`);
      finish(error);
    });
  });
}

function appendCommandOutput(target, chunk) {
  const text = String(chunk);
  const headLimit = Math.floor(MAX_COMMAND_OUTPUT_BYTES / 2);
  if (target.head.length < headLimit) target.head = `${target.head}${text}`.slice(0, headLimit);
  target.tail = `${target.tail}${text}`.slice(-headLimit);
}

function commandOutput(target) {
  return target.head.length && target.tail.length && target.head !== target.tail
    ? `${target.head}\n…[output truncated]…\n${target.tail}`
    : target.head || target.tail;
}
