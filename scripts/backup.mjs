import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPackageManifest,
  inspectPackageSource,
  PACKAGE_MANIFEST_NAME,
} from "../lib/package-source.mjs";
import { publishImmutableArchive } from "../lib/immutable-archive-publisher.mjs";
import { assertReleaseVersionMetadata } from "../lib/release-version-metadata.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GIT_COMMAND_TIMEOUT_MS = 60_000;
const ARCHIVE_COMMAND_TIMEOUT_MS = 10 * 60_000;
const version = (await fs.readFile(path.join(projectDir, "VERSION"), "utf8")).trim();
const packageJson = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
const candidateCommit = process.env.CODEX_DESKTOP_CANDIDATE_COMMIT?.toLowerCase() || null;
const packageSource = process.env.CODEX_DESKTOP_PACKAGE_SOURCE === "1";
if (version !== packageJson.version) throw new Error("VERSION and package.json do not match");
await assertReleaseVersionMetadata(projectDir, { expectedVersion: version });
if (candidateCommit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(candidateCommit)) {
  throw new Error("Candidate backup source commit is invalid");
}

const backupDir = path.resolve(
  process.env.CODEX_DESKTOP_BACKUP_DIR || path.join(projectDir, "backups"),
);
const candidateSuffix = candidateCommit ? `-${candidateCommit.slice(0, 12)}` : "";
const archiveName = `wfl-codex-desktop-v${version}${candidateSuffix}.tar.gz`;
const archivePath = path.join(backupDir, archiveName);
const checksumPath = `${archivePath}.sha256`;
await fs.mkdir(backupDir, { recursive: true });
const sourceCommit = await resolveSourceCommit();
const manifestCreatedAt = await resolveManifestCreatedAt(sourceCommit);
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-release-"));
const temporaryArchive = path.join(temporaryDirectory, archiveName);
try {
  const manifest = createPackageManifest({
    name: packageJson.name,
    version,
    sourceCommit,
    createdAt: manifestCreatedAt,
  });
  const temporaryManifestDirectory = path.join(temporaryDirectory, "manifest");
  await fs.mkdir(path.join(temporaryManifestDirectory, "manifest"), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(temporaryManifestDirectory, "manifest", PACKAGE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  await run("tar", [
    "--create",
    "--gzip",
    "--file",
    temporaryArchive,
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--pax-option=delete=atime,delete=ctime",
    "--exclude=.git",
    "--exclude=.codex-desktop",
    "--exclude=.codex-runtime",
    "--exclude=.codex-uploads",
    "--exclude=*/.codex-uploads",
    "--exclude=*/.codex-uploads/*",
    "--exclude=generated-images",
    "--exclude=*/generated-images",
    "--exclude=*/generated-images/*",
    "--exclude=archive",
    "--exclude=*/archive",
    "--exclude=*/archive/*",
    "--exclude=node_modules",
    "--exclude=node_modules/*",
    "--exclude=./node_modules",
    "--exclude=./node_modules/*",
    "--exclude=test-results",
    "--exclude=coverage",
    "--exclude=*.recovery-backup-*",
    "--exclude=*/*.recovery-backup-*",
    "--exclude=backups",
    "--exclude=backups/*",
    "--exclude=./backups",
    "--exclude=./backups/*",
    "--exclude=backups/*.tar.gz",
    "--exclude=backups/*.sha256",
    "--exclude=backups/*.publish.lock",
    "--exclude=backups/*.publish.lock.recovery",
    "--exclude=*.bak",
    "--exclude=.env",
    "--exclude=*.log",
    "--exclude=./.codex-package.json",
    "--transform",
    `s,^\\.,wfl-codex-desktop-v${version},`,
    "--transform",
    `s,^manifest/\\.codex-package\\.json$,wfl-codex-desktop-v${version}/.codex-package.json,`,
    ".",
    "--directory",
    temporaryManifestDirectory,
    `manifest/${PACKAGE_MANIFEST_NAME}`,
  ], { timeoutMs: ARCHIVE_COMMAND_TIMEOUT_MS });

  const digest = await publishArchive(temporaryArchive, archivePath, checksumPath, archiveName);
  console.log(`${archivePath}\nSHA-256 ${digest}`);
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

async function resolveSourceCommit() {
  if (packageSource) {
    const packaged = await inspectPackageSource(projectDir);
    if (packaged.version !== version) throw new Error("Package source version does not match VERSION");
    if (candidateCommit && packaged.manifest.sourceCommit.toLowerCase() !== candidateCommit) {
      throw new Error("Candidate package source no longer matches its verified commit");
    }
    return packaged.manifest.sourceCommit;
  }
  const hasLocalGit = await fs.lstat(path.join(projectDir, ".git")).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!hasLocalGit) {
    const packaged = await inspectPackageSource(projectDir);
    return packaged.manifest.sourceCommit;
  }
  const status = (await capture("git", ["status", "--porcelain", "--untracked-files=all"], {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  if (status) throw new Error("Source backup requires a clean Git checkout");
  const head = (await capture("git", ["rev-parse", "HEAD"], {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  if (candidateCommit) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(candidateCommit) || head !== candidateCommit) {
      throw new Error("Candidate backup source no longer matches its verified commit");
    }
    return head;
  }
  const tag = (await capture("git", ["rev-parse", `v${version}^{commit}`], {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  if (head !== tag) throw new Error(`Source backup requires HEAD to match tag v${version}`);
  return head;
}

async function resolveManifestCreatedAt(sourceCommit) {
  if (packageSource) {
    const packaged = await inspectPackageSource(projectDir);
    if (isIsoTimestamp(packaged.manifest.createdAt)) return packaged.manifest.createdAt;
  }
  const commitDate = (await capture("git", ["show", "-s", "--format=%cI", sourceCommit], {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  if (isIsoTimestamp(commitDate)) return commitDate;
  throw new Error("Release source does not have a stable manifest timestamp");
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function run(command, args, { timeoutMs = ARCHIVE_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    settleChild(child, command, timeoutMs, (error, code) => {
      if (error) reject(error);
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

function capture(command, args, { timeoutMs = GIT_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    settleChild(child, command, timeoutMs, (error, code) => {
      if (error) reject(error);
      else if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

function settleChild(child, command, timeoutMs, callback) {
  let settled = false;
  let timedOut = false;
  let timeoutError = null;
  let killTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutError = new Error(`${command} timed out after ${timeoutMs}ms`);
    timeoutError.code = "ERR_CHILD_PROCESS_TIMEOUT";
    terminateChild(child, "SIGTERM");
    killTimer = setTimeout(() => {
      terminateChild(child, "SIGKILL");
      finish(timeoutError, null);
    }, 2_000);
    killTimer.unref?.();
  }, Math.max(1_000, Number(timeoutMs) || GIT_COMMAND_TIMEOUT_MS));
  timer.unref?.();

  const finish = (error, code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    callback(error || (timedOut ? timeoutError : null), code);
  };
  child.once("error", (error) => finish(error, null));
  child.once("close", (code) => finish(null, code));
}

function terminateChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!/(?:ESRCH|EINVAL)/u.test(String(error?.code || ""))) return false;
  }
  return true;
}

async function publishArchive(sourceArchive, destinationArchive, destinationChecksum, archiveName) {
  return publishImmutableArchive({
    sourceArchive,
    destinationArchive,
    destinationChecksum,
    archiveName,
    ownerCommand: "scripts/backup.mjs",
    acceptedCommands: ["scripts/backup.mjs", "scripts/package-local-candidate.mjs"],
    operationId: `release-archive:${archiveName}`,
  });
}
