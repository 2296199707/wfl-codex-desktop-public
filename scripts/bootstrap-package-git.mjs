import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPackageSource } from "../lib/package-source.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.resolve(optionValue("--source") || projectDir);
const remote = optionValue("--remote");
if (!remote) throw new Error("--remote is required");
await assertRootOwnedPath(sourceDir);

const packaged = await inspectPackageSource(sourceDir);
const temporaryGitDir = path.join(sourceDir, `.git.bootstrap.${process.pid}.${crypto.randomUUID()}`);
const finalGitDir = path.join(sourceDir, ".git");
if (await exists(finalGitDir)) throw new Error("Source already contains Git metadata");

try {
  await fs.rm(temporaryGitDir, { recursive: true, force: true });
  await git(["init", "--initial-branch=stable"]);
  await git(["remote", "add", "origin", remote]);
  await git(["fetch", "--prune", "--tags", "origin", "refs/heads/stable:refs/remotes/origin/stable"]);
  const target = (await captureGit(["rev-parse", `v${packaged.version}^{commit}`])).trim();
  if (target.toLowerCase() !== packaged.manifest.sourceCommit.toLowerCase()) {
    throw new Error("Package source does not match the fetched release commit");
  }
  const stable = (await captureGit(["rev-parse", "refs/remotes/origin/stable"])).trim();
  if (target !== stable) {
    throw new Error(`Release tag v${packaged.version} does not match origin/stable`);
  }

  await git(["read-tree", target]);
  await git(["update-ref", "refs/heads/stable", target]);
  await git(["symbolic-ref", "HEAD", "refs/heads/stable"]);
  await git(["config", "branch.stable.remote", "origin"]);
  await git(["config", "branch.stable.merge", "refs/heads/stable"]);
  await git(["update-index", "--refresh"]);
  if (!await gitSucceeds(["diff-files", "--quiet"])) {
    const differences = (await captureGit(["diff-files", "--name-status"])).trim();
    throw new Error(
      `Extracted package files do not match v${packaged.version} from the Git remote: ${differences || "unknown difference"}`,
    );
  }

  await fs.rename(temporaryGitDir, finalGitDir);
  console.log(`Prepared Git metadata for v${packaged.version} from origin/stable`);
} catch (error) {
  await fs.rm(temporaryGitDir, { recursive: true, force: true }).catch(() => {});
  throw error;
}

function git(args) {
  return runGit(args, { capture: false });
}

function captureGit(args) {
  return runGit(args, { capture: true });
}

function runGit(args, { capture }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      `--git-dir=${temporaryGitDir}`,
      `--work-tree=${sourceDir}`,
      ...args,
    ], {
      cwd: sourceDir,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with status ${code}`));
    });
  });
}

function gitSucceeds(args) {
  return new Promise((resolve) => {
    const child = spawn("git", [
      `--git-dir=${temporaryGitDir}`,
      `--work-tree=${sourceDir}`,
      ...args,
    ], { cwd: sourceDir, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function exists(candidate) {
  return fs.access(candidate).then(() => true, () => false);
}

async function assertRootOwnedPath(target) {
  const resolvedTarget = await fs.realpath(target);
  let current = resolvedTarget;
  while (current !== "/") {
    const stat = await fs.lstat(current);
    const safeStickyParent = current !== resolvedTarget
      && (stat.mode & 0o1000) !== 0
      && (stat.mode & 0o022) !== 0;
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0
      || ((stat.mode & 0o022) !== 0 && !safeStickyParent)) {
      throw new Error(`Package source path must be root-owned and not group/world-writable: ${current}`);
    }
    current = path.dirname(current);
  }
}
