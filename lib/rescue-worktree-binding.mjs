import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RESCUE_WORKTREE_BINDING_VERSION = 1;
export const RESCUE_MAIN_WORKTREE_BINDING = "owner-rescue-main-site";

export class RescueWorktreeBindingStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async read() {
    let value;
    try {
      value = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return normalizeBinding(value);
  }

  async write(value) {
    const normalized = normalizeBinding(value);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => {});
    const temporary = this.filePath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(normalized) + "\n", { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return normalized;
  }

  async clear() {
    await fs.rm(this.filePath, { force: true });
  }
}

export function normalizeBinding(value) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== RESCUE_WORKTREE_BINDING_VERSION
    || value.binding !== RESCUE_MAIN_WORKTREE_BINDING
    || typeof value.worktreeId !== "string"
    || !/^wt_[0-9a-f-]{36}$/u.test(value.worktreeId)
    || typeof value.worktreePath !== "string"
    || !path.isAbsolute(value.worktreePath)
    || typeof value.worktreeProjectPath !== "string"
    || !path.isAbsolute(value.worktreeProjectPath)
    || typeof value.sourceProjectPath !== "string"
    || !path.isAbsolute(value.sourceProjectPath)
  ) {
    return null;
  }
  return {
    version: RESCUE_WORKTREE_BINDING_VERSION,
    binding: RESCUE_MAIN_WORKTREE_BINDING,
    worktreeId: value.worktreeId,
    worktreePath: path.resolve(value.worktreePath),
    worktreeProjectPath: path.resolve(value.worktreeProjectPath),
    sourceProjectPath: path.resolve(value.sourceProjectPath),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}
