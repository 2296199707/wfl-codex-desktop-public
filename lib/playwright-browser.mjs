import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_RUNTIME_DIRECTORY = path.join(process.cwd(), ".codex-runtime");
const DEFAULT_BROWSERS_DIRECTORY = path.join(os.homedir(), ".cache", "ms-playwright");
const BROWSERS_PATH_FILE = "playwright-browsers-path";
const MINIMUM_FREE_BYTES = 1_024 * 1_024 * 1_024;
const PSEUDO_FILESYSTEMS = new Set([
  "autofs",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "proc",
  "pstore",
  "ramfs",
  "securityfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

export function playwrightBrowsersPathFile(runtimeDirectory = DEFAULT_RUNTIME_DIRECTORY) {
  return path.join(path.resolve(runtimeDirectory), BROWSERS_PATH_FILE);
}

export async function readPlaywrightBrowsersPath(runtimeDirectory = DEFAULT_RUNTIME_DIRECTORY) {
  try {
    const value = (await fs.readFile(playwrightBrowsersPathFile(runtimeDirectory), "utf8")).trim();
    return normalizeBrowsersPath(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function resolvePlaywrightBrowsersPath({
  runtimeDirectory = DEFAULT_RUNTIME_DIRECTORY,
  env = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const explicitCandidates = [
    [env.CODEX_DESKTOP_PLAYWRIGHT_BROWSERS_PATH, "environment"],
    [env.PLAYWRIGHT_BROWSERS_PATH, "environment"],
  ];
  const persisted = await readPlaywrightBrowsersPath(runtimeDirectory);
  const candidates = [
    ...explicitCandidates,
    [persisted, "persisted"],
    [path.join(homeDirectory, ".cache", "ms-playwright"), "default-cache"],
    ...(await dataMountCandidates()),
    [DEFAULT_BROWSERS_DIRECTORY, "default"],
  ];

  const seen = new Set();
  for (const [candidate, source] of candidates) {
    const normalized = normalizeBrowsersPath(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    if (await isBrokenSymlink(normalized)) continue;
    const existing = await existingDirectory(normalized);
    const resolved = existing || normalized;
    if (!existing && !hasExistingTopLevelDirectory(resolved)) continue;
    const freeBytes = await freeBytesFor(resolved);
    if (existing && freeBytes >= MINIMUM_FREE_BYTES) {
      return { path: resolved, source, freeBytes };
    }
    if (!existing && freeBytes >= MINIMUM_FREE_BYTES) {
      return { path: resolved, source, freeBytes };
    }
    // An explicit path is an owner decision. Keep it usable even when the
    // filesystem is low on space so the installer can report the real error.
    if (source === "environment" && existing === null) {
      return { path: resolved, source, freeBytes };
    }
  }

  const fallback = [
    env.CODEX_DESKTOP_PLAYWRIGHT_BROWSERS_PATH,
    env.PLAYWRIGHT_BROWSERS_PATH,
    persisted,
    path.join(homeDirectory, ".cache", "ms-playwright"),
    DEFAULT_BROWSERS_DIRECTORY,
  ]
    .map(normalizeBrowsersPath)
    .find((candidate) => candidate && hasExistingTopLevelDirectory(candidate));
  const fallbackPath = fallback || DEFAULT_BROWSERS_DIRECTORY;
  return {
    path: fallbackPath,
    source: "fallback",
    freeBytes: await freeBytesFor(fallbackPath),
  };
}

export async function chromiumExecutablePath({
  runtimeDirectory = DEFAULT_RUNTIME_DIRECTORY,
  browsersPath = null,
  env = process.env,
} = {}) {
  const resolved = browsersPath
    ? { path: normalizeBrowsersPath(browsersPath), source: "provided" }
    : await resolvePlaywrightBrowsersPath({ runtimeDirectory, env });
  if (!resolved.path) throw new Error("Playwright browser cache path is invalid");
  const chromium = await loadChromium(resolved.path);
  return {
    ...resolved,
    executable: chromium.executablePath(),
  };
}

export async function ensurePlaywrightBrowser({
  runtimeDirectory = DEFAULT_RUNTIME_DIRECTORY,
  env = process.env,
  install = false,
  timeoutMs = 20 * 60 * 1_000,
} = {}) {
  const resolved = await resolvePlaywrightBrowsersPath({ runtimeDirectory, env });
  await fs.mkdir(resolved.path, { recursive: true, mode: 0o755 });
  const initial = await chromiumExecutablePath({
    runtimeDirectory,
    browsersPath: resolved.path,
    env,
  });
  if (await executableIsReady(initial.executable)) {
    await persistPlaywrightBrowsersPath(runtimeDirectory, resolved.path);
    return { ...initial, source: resolved.source, installed: false };
  }
  if (!install) {
    throw new Error(
      `Chromium executable is missing: ${initial.executable}; run scripts/ensure-playwright-browser.mjs --install`,
    );
  }

  await runPlaywrightInstall({
    cwd: process.env.CODEX_DESKTOP_SOURCE_DIR || process.cwd(),
    browsersPath: resolved.path,
    timeoutMs,
  });
  const verified = await chromiumExecutablePath({
    runtimeDirectory,
    browsersPath: resolved.path,
    env,
  });
  if (!await executableIsReady(verified.executable)) {
    throw new Error(`Chromium installation completed without an executable at ${verified.executable}`);
  }
  await persistPlaywrightBrowsersPath(runtimeDirectory, resolved.path);
  return { ...verified, source: resolved.source, installed: true };
}

export async function persistPlaywrightBrowsersPath(runtimeDirectory, browsersPath) {
  const normalized = normalizeBrowsersPath(browsersPath);
  if (!normalized) throw new Error("Cannot persist an invalid Playwright browser cache path");
  const filename = playwrightBrowsersPathFile(runtimeDirectory);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${normalized}\n`, { mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o644);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return normalized;
}

export function normalizeBrowsersPath(value) {
  if (typeof value !== "string" || !value.trim() || value.trim() === "0") return null;
  const candidate = value.trim();
  if (!candidate.startsWith("/") || candidate.includes("\0") || /[\r\n\t ]/u.test(candidate)) return null;
  if (candidate.split("/").includes("..")) return null;
  return path.resolve(candidate);
}

async function loadChromium(browsersPath) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import("playwright");
  return chromium;
}

async function executableIsReady(executable) {
  try {
    await fs.access(executable, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function existingDirectory(directory) {
  try {
    const resolved = await fs.realpath(directory);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function isBrokenSymlink(filename) {
  try {
    const stat = await fs.lstat(filename);
    return stat.isSymbolicLink() && !(await existingDirectory(filename));
  } catch {
    return false;
  }
}

function hasExistingTopLevelDirectory(directory) {
  const topLevel = `/${directory.split("/").filter(Boolean)[0] || ""}`;
  try {
    return Boolean(topLevel) && requireStat(topLevel);
  } catch {
    return false;
  }
}

function requireStat(filename) {
  // This synchronous probe only runs while selecting a cache root. It avoids
  // creating an owner-specified directory whose top-level mount is absent.
  return statSync(filename).isDirectory();
}

async function freeBytesFor(directory) {
  let current = directory;
  while (current && current !== path.dirname(current)) {
    try {
      const stat = await fs.stat(current);
      if (!stat.isDirectory()) return 0;
      const filesystem = await fs.statfs(current);
      return Number(filesystem.bavail) * Number(filesystem.bsize);
    } catch {
      current = path.dirname(current);
    }
  }
  return 0;
}

async function dataMountCandidates() {
  const rootDevice = await fs.stat("/").then((stat) => String(stat.dev)).catch(() => null);
  const mounts = await fs.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  const candidates = [];
  for (const line of mounts.split(/\r?\n/u)) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mountPoint = decodeMountField(before[4]);
    const filesystem = after[0];
    if (!mountPoint || mountPoint === "/" || PSEUDO_FILESYSTEMS.has(filesystem)) continue;
    if (["/proc", "/sys", "/dev", "/run"].some((prefix) => mountPoint === prefix || mountPoint.startsWith(`${prefix}/`))) continue;
    const device = await fs.stat(mountPoint).then((stat) => String(stat.dev)).catch(() => null);
    if (!device || device === rootDevice) continue;
    const existingDirectories = await fs.readdir(mountPoint, { withFileTypes: true })
      .then((entries) => entries
        .filter((entry) => entry.isDirectory() && /playwright|ms-playwright/iu.test(entry.name))
        .map((entry) => [path.join(mountPoint, entry.name), "data-mount-existing"]))
      .catch(() => []);
    candidates.push(...existingDirectories);
    const pathCandidate = path.join(mountPoint, ".codex-desktop", "playwright-browsers");
    const freeBytes = await freeBytesFor(mountPoint);
    if (freeBytes >= MINIMUM_FREE_BYTES) candidates.push([pathCandidate, "data-mount"]);
  }
  const unique = new Map();
  for (const candidate of candidates) unique.set(candidate[0], candidate);
  return [...unique.values()].sort((left, right) => left[0].localeCompare(right[0]));
}

function decodeMountField(value) {
  return String(value || "").replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function runPlaywrightInstall({ cwd, browsersPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["playwright", "install", "--no-shell", "--no-progress", "chromium"], {
      cwd,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "30000",
      },
      stdio: "inherit",
    });
    let settled = false;
    let killTimer = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve();
    };
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code === 0) finish();
      else if (signal) finish(new Error(`Playwright Chromium installation stopped by ${signal}`));
      else finish(new Error(`Playwright Chromium installation failed with status ${code}`));
    });
  });
}
