import fs from "node:fs/promises";
import path from "node:path";

// Recovery must discover project directories for every managed user, not only
// the default runtime.  Keep this scan shallow and bounded: a user's
// `projectRoot` contains project directories directly, while transaction
// journals themselves live inside those project directories.  Never follow a
// symlink during discovery.
const DEFAULT_MAX_PROJECTS = 4_096;
const DEFAULT_MAX_WORKTREES = 4_096;
const MAX_WORKTREE_STATE_BYTES = 4 * 1024 * 1024;

export async function listSafeProjectDirectories(rootPath, {
  maxProjects = DEFAULT_MAX_PROJECTS,
  fileSystem = fs,
} = {}) {
  const root = normalizeRoot(rootPath);
  const limit = normalizeLimit(maxProjects);
  const rootStat = await fileSystem.lstat(root).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return Object.freeze({ root, directories: Object.freeze([]), truncated: false });
  }
  const entries = await fileSystem.readdir(root, { withFileTypes: true });
  const directories = [];
  let truncated = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(root, entry.name);
    const stat = await fileSystem.lstat(candidate).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const realPath = await fileSystem.realpath(candidate).catch(() => null);
    if (realPath !== candidate) continue;
    if (directories.length >= limit) {
      truncated = true;
      break;
    }
    directories.push(candidate);
  }
  directories.sort();
  return Object.freeze({
    root,
    directories: Object.freeze(directories),
    truncated,
  });
}

/**
 * Discover ready Codex worktree project directories from the user's private
 * worktree state.  Worktrees can place the actual project below the worktree
 * root (for example `packages/game`), so a shallow directory scan is not
 * sufficient here.  Every path is checked against the same roots used by the
 * Worktree store and no symlink is followed.
 */
export async function listSafeWorktreeProjectDirectories({
  stateDirectory,
  codexHome,
  projectRoot,
  maxWorktrees = DEFAULT_MAX_WORKTREES,
  fileSystem = fs,
} = {}) {
  const stateRoot = normalizeRoot(stateDirectory);
  const codexRoot = normalizeRoot(codexHome);
  const projectRootPath = normalizeRoot(projectRoot);
  const limit = normalizeLimit(maxWorktrees);
  const statePath = path.join(stateRoot, "codex-worktrees.json");
  const stateStat = await fileSystem.lstat(statePath).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stateStat) return Object.freeze({ directories: Object.freeze([]), truncated: false });
  if (stateStat.isSymbolicLink() || !stateStat.isFile() || stateStat.size > MAX_WORKTREE_STATE_BYTES) {
    throw new Error("Codex worktree state file is invalid for recovery scanning");
  }
  let value;
  try {
    value = JSON.parse(await fileSystem.readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error("Codex worktree state file cannot be read for recovery scanning", { cause: error });
  }
  if (!value || value.version !== 1 || !Array.isArray(value.records)) {
    throw new Error("Codex worktree state file has an unsupported format");
  }
  const worktreeRoot = path.join(codexRoot, "worktrees");
  const directories = [];
  let truncated = false;
  for (const record of value.records) {
    if (record?.state !== "ready") continue;
    const worktreePath = absolutePath(record.worktreePath);
    const repositoryRoot = absolutePath(record.repositoryRoot);
    const sourceProjectPath = absolutePath(record.projectPath);
    if (!worktreePath || !repositoryRoot || !sourceProjectPath) continue;
    const projectRelativePath = path.relative(repositoryRoot, sourceProjectPath);
    const worktreeProjectPath = path.resolve(worktreePath, projectRelativePath);
    const id = typeof record.id === "string" ? record.id : "";
    if (!id || path.dirname(worktreePath) !== worktreeRoot || path.basename(worktreePath) !== id
      || !isWithinAbsolute(worktreeRoot, worktreePath)
      || !isWithinAbsolute(projectRootPath, repositoryRoot)
      || !isWithinAbsolute(repositoryRoot, sourceProjectPath)
      || !isWithinAbsolute(worktreePath, worktreeProjectPath)) continue;
    const stat = await fileSystem.lstat(worktreeProjectPath).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const realPath = await fileSystem.realpath(worktreeProjectPath).catch(() => null);
    if (realPath !== worktreeProjectPath) continue;
    if (directories.length >= limit) {
      truncated = true;
      break;
    }
    directories.push(worktreeProjectPath);
  }
  return Object.freeze({
    directories: Object.freeze([...new Set(directories)].sort()),
    truncated,
  });
}

function normalizeRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("rootPath must be an absolute path");
  }
  const root = path.resolve(value);
  if (root === path.parse(root).root) throw new TypeError("rootPath must not be the filesystem root");
  return root;
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new TypeError("maxProjects must be a positive bounded integer");
  }
  return limit;
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) return null;
  const resolved = path.resolve(value);
  return resolved === path.parse(resolved).root ? null : resolved;
}

function isWithinAbsolute(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
