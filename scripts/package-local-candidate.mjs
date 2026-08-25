import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseVersionMetadata } from "../lib/release-version-metadata.mjs";
import { publishImmutableArchive } from "../lib/immutable-archive-publisher.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GIT_COMMAND_TIMEOUT_MS = 60_000;
const BACKUP_COMMAND_TIMEOUT_MS = 10 * 60_000;
const destinationBackupDirectory = path.resolve(
  process.env.CODEX_DESKTOP_BACKUP_DIR || path.join(projectDir, "backups"),
);

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  if (process.argv.length !== 3) throw new Error("Candidate package help cannot be combined with another argument");
  console.log("Usage: node scripts/package-local-candidate.mjs");
  process.exit(0);
}
if (process.argv.length !== 2) {
  throw new Error(`Unknown candidate package argument: ${process.argv[2]}`);
}

const version = (await fs.readFile(path.join(projectDir, "VERSION"), "utf8")).trim();
const packageJson = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf8"));
if (version !== packageJson.version) throw new Error("VERSION and package.json do not match");
await assertReleaseVersionMetadata(projectDir, { expectedVersion: version });

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-codex-local-candidate-"));
const temporaryIndex = path.join(temporaryDirectory, "candidate.index");
const candidateWorktree = path.join(temporaryDirectory, "source");
let worktreeAdded = false;

try {
  const head = (await capture("git", ["rev-parse", "HEAD"], {
    cwd: projectDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  const indexEnvironment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  await run("git", ["read-tree", "HEAD"], {
    cwd: projectDir,
    env: indexEnvironment,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  await run("git", ["add", "-A", "--", "."], {
    cwd: projectDir,
    env: indexEnvironment,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  const tree = (await capture("git", ["write-tree"], {
    cwd: projectDir,
    env: indexEnvironment,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  const timestamp = Math.floor(Date.now() / 1000);
  const identityEnvironment = {
    ...indexEnvironment,
    GIT_AUTHOR_NAME: "WFL Codex Local Candidate",
    GIT_AUTHOR_EMAIL: "local-candidate@localhost",
    GIT_COMMITTER_NAME: "WFL Codex Local Candidate",
    GIT_COMMITTER_EMAIL: "local-candidate@localhost",
    GIT_AUTHOR_DATE: `@${timestamp} +0000`,
    GIT_COMMITTER_DATE: `@${timestamp} +0000`,
  };
  const candidateCommit = (await capture("git", [
    "commit-tree",
    tree,
    "-p",
    head,
    "-m",
    `Local candidate v${version}`,
  ], {
    cwd: projectDir,
    env: identityEnvironment,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  })).trim().toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(candidateCommit)) {
    throw new Error("Local candidate commit identity is invalid");
  }

  await run("git", ["worktree", "add", "--detach", candidateWorktree, candidateCommit], {
    cwd: projectDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  worktreeAdded = true;
  const candidateBackupDirectory = path.join(candidateWorktree, "backups");
  await run(process.execPath, [path.join(candidateWorktree, "scripts", "backup.mjs")], {
    cwd: candidateWorktree,
    env: {
      ...process.env,
      CODEX_DESKTOP_BACKUP_DIR: candidateBackupDirectory,
      CODEX_DESKTOP_CANDIDATE_COMMIT: candidateCommit,
    },
    stdio: "inherit",
    timeoutMs: BACKUP_COMMAND_TIMEOUT_MS,
  });

  const archiveName = `wfl-codex-desktop-v${version}-${candidateCommit.slice(0, 12)}.tar.gz`;
  const sourceArchive = path.join(candidateWorktree, "backups", archiveName);
  const destinationDirectory = destinationBackupDirectory;
  const destinationArchive = path.join(destinationDirectory, archiveName);
  const destinationChecksum = `${destinationArchive}.sha256`;
  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
  await publishArchive(sourceArchive, destinationArchive, destinationChecksum, archiveName);

  console.log(JSON.stringify({
    ok: true,
    version,
    candidateCommit,
    tree,
    archive: destinationArchive,
    checksum: destinationChecksum,
  }, null, 2));
} finally {
  if (worktreeAdded) {
    await run("git", ["worktree", "remove", "--force", candidateWorktree], {
      cwd: projectDir,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      allowFailure: true,
    });
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args, {
  cwd,
  env = process.env,
  stdio = "ignore",
  timeoutMs = GIT_COMMAND_TIMEOUT_MS,
  allowFailure = false,
} = {}) {
  return spawnAndWait(command, args, {
    cwd,
    env,
    stdio,
    timeoutMs,
    allowFailure,
  });
}

function capture(command, args, {
  cwd,
  env = process.env,
  timeoutMs = GIT_COMMAND_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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

function spawnAndWait(command, args, {
  cwd,
  env,
  stdio,
  timeoutMs,
  allowFailure = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
      detached: process.platform !== "win32",
    });
    settleChild(child, command, timeoutMs, (error, code) => {
      if (error) {
        if (allowFailure) resolve();
        else reject(error);
        return;
      }
      if (code === 0 || allowFailure) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

function settleChild(child, command, timeoutMs, callback) {
  let settled = false;
  let timedOut = false;
  let timeoutError = null;
  let killTimer = null;
  let timer = setTimeout(() => {
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
    ownerCommand: "scripts/package-local-candidate.mjs",
    acceptedCommands: ["scripts/backup.mjs", "scripts/package-local-candidate.mjs"],
    operationId: `candidate-archive:${archiveName}`,
  });
}
