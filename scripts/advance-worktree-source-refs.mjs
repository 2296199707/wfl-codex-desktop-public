import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const WORKTREE_STATE_FILE = "codex-worktrees.json";
const MAX_STATE_FILES = 256;
const MAX_RECORDS = 10_000;

/**
 * Advance only the source branches used by managed Worktrees after a verified
 * main-site release. Worktree branches and their working files are never
 * changed here; users still choose when to merge the new source commit into
 * each Worktree.
 */
export async function advanceWorktreeSourceRefs({
  stateDirectory,
  projectDirectory,
  targetCommit = null,
  dryRun = false,
} = {}) {
  const stateRoot = path.resolve(requiredPath(stateDirectory, "Worktree state directory"));
  const projectRoot = path.resolve(requiredPath(projectDirectory, "Release project directory"));
  const repositoryIdentity = await gitCommonDirectory(projectRoot);
  const resolvedTargetCommit = targetCommit
    ? await verifyCommit(projectRoot, targetCommit)
    : await git(projectRoot, ["rev-parse", "HEAD"]);
  const stateFiles = await discoverStateFiles(stateRoot);
  const refsByRepository = new Map();
  let recordCount = 0;
  const skipped = [];

  for (const stateFile of stateFiles) {
    const value = await readJson(stateFile);
    const records = Array.isArray(value?.records) ? value.records : [];
    recordCount += records.length;
    if (recordCount > MAX_RECORDS) {
      skipped.push({ stateFile, reason: "record-limit" });
      break;
    }
    for (const record of records) {
      if (!record || record.state === "deleted" || typeof record.baseRef !== "string") continue;
      if (record.baseRef === "HEAD") {
        skipped.push({ stateFile, repositoryRoot: record.repositoryRoot || null, ref: record.baseRef, reason: "base-ref-head" });
        continue;
      }
      if (!record.repositoryRoot) {
        skipped.push({ stateFile, ref: record.baseRef, reason: "repository-unavailable" });
        continue;
      }
      const repositoryRoot = path.resolve(String(record.repositoryRoot));
      let identity;
      try {
        identity = await gitCommonDirectory(repositoryRoot);
      } catch (error) {
        skipped.push({ stateFile, repositoryRoot, ref: record.baseRef, reason: `repository-unavailable: ${error.message}` });
        continue;
      }
      if (identity !== repositoryIdentity) {
        skipped.push({ stateFile, repositoryRoot, ref: record.baseRef, reason: "different-repository" });
        continue;
      }
      const refs = refsByRepository.get(repositoryRoot) || new Set();
      refs.add(record.baseRef);
      refsByRepository.set(repositoryRoot, refs);
    }
  }

  const advanced = [];
  const unchanged = [];
  for (const [repositoryRoot, refs] of refsByRepository) {
    const worktrees = await registeredWorktrees(repositoryRoot);
    for (const ref of refs) {
      const currentRef = await git(repositoryRoot, ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`], {
        allowFailure: true,
      });
      if (!currentRef) {
        skipped.push({ repositoryRoot, ref, reason: "source-ref-missing" });
        continue;
      }
      if (currentRef === resolvedTargetCommit) {
        unchanged.push({ repositoryRoot, ref, commit: currentRef });
        continue;
      }
      if (await isAncestor(repositoryRoot, resolvedTargetCommit, currentRef)) {
        unchanged.push({ repositoryRoot, ref, commit: currentRef, reason: "source-ahead" });
        continue;
      }
      if (!await isAncestor(repositoryRoot, currentRef, resolvedTargetCommit)) {
        skipped.push({ repositoryRoot, ref, reason: "source-diverged" });
        continue;
      }

      const checkedOut = worktrees.find((entry) => entry.branch === ref);
      if (checkedOut) {
        const dirty = await git(checkedOut.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
        if (dirty) {
          skipped.push({ repositoryRoot, ref, reason: "checked-out-source-dirty", path: checkedOut.path });
          continue;
        }
        if (!dryRun) {
          await git(checkedOut.path, ["merge", "--ff-only", resolvedTargetCommit]);
        }
        advanced.push({
          repositoryRoot,
          ref,
          from: currentRef,
          to: resolvedTargetCommit,
          path: checkedOut.path,
          checkedOut: true,
          dryRun,
        });
        continue;
      }

      if (!dryRun) {
        await git(repositoryRoot, [
          "update-ref",
          `refs/heads/${ref}`,
          resolvedTargetCommit,
          currentRef,
        ]);
      }
      advanced.push({
        repositoryRoot,
        ref,
        from: currentRef,
        to: resolvedTargetCommit,
        checkedOut: false,
        dryRun,
      });
    }
  }

  return {
    targetCommit: resolvedTargetCommit,
    stateFiles,
    recordCount,
    advanced,
    unchanged,
    skipped,
  };
}

async function discoverStateFiles(stateRoot) {
  const files = [];
  const ownerFile = path.join(stateRoot, WORKTREE_STATE_FILE);
  if (await isRegularFile(ownerFile)) files.push(ownerFile);
  const userStateRoot = path.join(stateRoot, "user-state");
  const entries = await fs.readdir(userStateRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(userStateRoot, entry.name, WORKTREE_STATE_FILE);
    if (await isRegularFile(file)) files.push(file);
    if (files.length >= MAX_STATE_FILES) break;
  }
  return files;
}

async function registeredWorktrees(repositoryRoot) {
  const output = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
  const result = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: path.resolve(line.slice("worktree ".length).trim()), branch: null };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    }
  }
  if (current) result.push(current);
  return result;
}

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = String(error?.stderr || error?.message || "git command failed").trim();
    throw new Error(detail.slice(-1_000));
  }
}

async function gitCommonDirectory(directory) {
  const raw = await git(directory, ["rev-parse", "--git-common-dir"]);
  return fs.realpath(path.resolve(directory, raw));
}

async function verifyCommit(directory, value) {
  const commit = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) {
    throw new Error("Invalid release source commit");
  }
  const resolved = await git(directory, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (resolved !== commit) throw new Error("Release source commit identity changed");
  return resolved;
}

async function isAncestor(directory, ancestor, descendant) {
  try {
    await git(directory, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function isRegularFile(file) {
  const stat = await fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return Boolean(stat?.isFile());
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

if (isMainModule()) {
  const stateDirectory = process.env.CODEX_DESKTOP_STATE_DIR || path.join(process.cwd(), ".codex-desktop");
  const projectDirectory = process.env.CODEX_DESKTOP_SOURCE_DIR || process.cwd();
  const targetCommit = process.env.CODEX_DESKTOP_RELEASE_COMMIT || null;
  const result = await advanceWorktreeSourceRefs({ stateDirectory, projectDirectory, targetCommit });
  console.log(JSON.stringify(result, null, 2));
}

function isMainModule() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  return entry === path.resolve(fileURLToPath(import.meta.url));
}
