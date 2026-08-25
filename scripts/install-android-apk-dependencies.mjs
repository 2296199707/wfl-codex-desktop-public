import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const packageName = "openjdk-17-jdk-headless";
const statePath = process.env.CODEX_DESKTOP_ANDROID_APK_DEPENDENCY_STATE;
const operationId = process.env.CODEX_DESKTOP_ANDROID_APK_DEPENDENCY_OPERATION || null;

if (!process.argv.includes("--worker")) {
  console.error("This command is launched by the Android APK builder plugin.");
  process.exit(2);
}
if (!statePath || !path.isAbsolute(statePath)) {
  console.error("Android APK dependency state path is missing.");
  process.exit(2);
}
if (process.getuid && process.getuid() !== 0) {
  await writeState({ status: "failed", phase: "failed", detail: "Java 构建依赖下载需要 root 权限", error: "worker is not running as root" });
  process.exit(1);
}

const startedAt = Date.now();
await writeState({
  status: "installing",
  phase: "installing",
  detail: `正在下载并安装 ${packageName}`,
  error: null,
  startedAt,
  updatedAt: startedAt,
  completedAt: null,
});

try {
  await run("/usr/bin/apt-get", ["-o", "Dpkg::Use-Pty=0", "-o", "APT::Color=0", "-q", "update", "-qq"], 10 * 60_000);
  await run(
    "/usr/bin/apt-get",
    [
      "-o", "Dpkg::Use-Pty=0",
      "-o", "APT::Color=0",
      "-q",
      "install",
      "-y",
      "--no-install-recommends",
      packageName,
    ],
    10 * 60_000,
  );
  await writeState({
    status: "completed",
    phase: "completed",
    detail: "Java keytool 已准备完成",
    error: null,
    startedAt,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  });
} catch (error) {
  await writeState({
    status: "failed",
    phase: "failed",
    detail: "Java 构建依赖下载失败",
    error: sanitize(error),
    startedAt,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  });
  process.exitCode = 1;
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        DEBIAN_FRONTEND: "noninteractive",
        NEEDRESTART_MODE: "a",
        APT_LISTCHANGES_FRONTEND: "none",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} 超时`));
    }, timeoutMs);
    timer.unref?.();
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with ${signal || code}`));
    });
  });
}

async function writeState(patch) {
  const current = await readState();
  const next = {
    schemaVersion: 1,
    operationId,
    unit: current.unit || null,
    ...current,
    ...patch,
  };
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, statePath);
}

async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(statePath, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function sanitize(error) {
  return String(error?.message || error || "未知 Java 依赖错误")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 1_000);
}
