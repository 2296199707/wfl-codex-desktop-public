import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const GENERATED_ROOTS = Object.freeze([
  "apps/mobile/android",
  "apps/mobile/web",
  "apps/mobile/.dart_tool",
  "apps/mobile/.idea",
  "apps/mobile/build",
  "apps/mobile/pubspec.lock",
  "apps/mobile/.metadata",
  "apps/mobile/.flutter-plugins-dependencies",
  "apps/mobile/.gitignore",
  "apps/mobile/README.md",
]);

export async function inspectUpdateSource({ sourceDirectory, runtimeDirectory = null } = {}) {
  const source = path.resolve(sourceDirectory);
  const managedRuntime = runtimeDirectory ? path.resolve(runtimeDirectory) : null;
  const status = await gitStatus(source, managedRuntime);
  const entries = status.entries;
  const candidateRoots = new Set();
  const blocked = [];
  for (const entry of entries) {
    const root = generatedRootFor(entry.path);
    if (!root || entry.indexStatus !== "??" || await isTracked(source, root)) {
      blocked.push(entry);
      continue;
    }
    candidateRoots.add(root);
  }
  return {
    clean: entries.length === 0,
    entries,
    repairable: [...candidateRoots].sort(),
    blocked,
  };
}

export async function repairUpdateSource({ sourceDirectory, runtimeDirectory, apply = false } = {}) {
  const source = path.resolve(sourceDirectory);
  const runtime = path.resolve(runtimeDirectory);
  const inspection = await inspectUpdateSource({ sourceDirectory: source, runtimeDirectory: runtime });
  if (inspection.blocked.length) {
    const error = new Error(
      `源码存在不能自动清理的修改：${inspection.blocked.map((entry) => entry.path).join("、")}`,
    );
    error.code = "ERR_UPDATE_SOURCE_REPAIR_BLOCKED";
    error.entries = inspection.blocked;
    throw error;
  }
  if (!apply || inspection.repairable.length === 0) {
    return {
      status: inspection.repairable.length ? "repairable" : "clean",
      paths: inspection.repairable,
      quarantinePath: null,
    };
  }

  const quarantinePath = path.join(
    runtime,
    "source-repair",
    `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
  );
  const moved = [];
  try {
    for (const relativePath of inspection.repairable) {
      const sourcePath = path.join(source, relativePath);
      const stat = await fs.lstat(sourcePath).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error(`拒绝隔离符号链接：${relativePath}`);
      const destination = path.join(quarantinePath, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await moveRecoverably(sourcePath, destination);
      moved.push(relativePath);
    }
    await fs.mkdir(quarantinePath, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(quarantinePath, "manifest.json"),
      `${JSON.stringify({ version: 1, sourceDirectory: source, moved, createdAt: Date.now() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    error.code ||= "ERR_UPDATE_SOURCE_REPAIR_FAILED";
    throw error;
  }
  return { status: "repaired", paths: moved, quarantinePath };
}

function generatedRootFor(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const exact = GENERATED_ROOTS.find((root) => normalized === root || normalized.startsWith(`${root}/`));
  if (exact) return exact;
  if (/^apps\/mobile\/[^/]+\.iml$/u.test(normalized)) return normalized;
  return null;
}

async function isTracked(source, relativePath) {
  const result = await runGit(["ls-files", "--", relativePath], source);
  return result.stdout.trim().length > 0;
}

async function gitStatus(source, managedRuntime = null) {
  const result = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], source);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "无法读取源码 Git 状态");
  const entries = result.stdout.split("\0").filter(Boolean).map((value) => ({
    indexStatus: value.slice(0, 2).trim() || "?",
    path: value.slice(3).replaceAll("\\", "/").replace(/\/+$/u, ""),
  })).filter((entry) => !managedRuntime || !isPathInside(source, managedRuntime, entry.path));
  return { entries };
}

function isPathInside(source, target, relativePath) {
  const relativeRuntime = path.relative(source, target);
  if (!relativeRuntime || relativeRuntime.startsWith("..") || path.isAbsolute(relativeRuntime)) return false;
  const normalizedRuntime = relativeRuntime.split(path.sep).join("/").replace(/\/$/u, "");
  return relativePath === normalizedRuntime || relativePath.startsWith(`${normalizedRuntime}/`);
}

async function moveRecoverably(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fs.cp(source, destination, { recursive: true, errorOnExist: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
