import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listSafeProjectDirectories,
  listSafeWorktreeProjectDirectories,
} from "../lib/map-recovery-project-scan.mjs";

test("startup recovery scan discovers only shallow real project directories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-recovery-scan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.mkdir(path.join(root, "z-project")),
    fs.mkdir(path.join(root, "a-project")),
    fs.mkdir(path.join(root, ".hidden-project")),
  ]);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-recovery-scan-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, "linked-project"));
  const result = await listSafeProjectDirectories(root);
  assert.deepEqual(result.directories, [
    path.join(root, "a-project"),
    path.join(root, "z-project"),
  ]);
  assert.equal(result.truncated, false);
});

test("startup recovery scan has a fixed bound and reports truncation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-recovery-scan-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.mkdir(path.join(root, "project-a")),
    fs.mkdir(path.join(root, "project-b")),
  ]);
  const result = await listSafeProjectDirectories(root, { maxProjects: 1 });
  assert.equal(result.directories.length, 1);
  assert.equal(result.truncated, true);
});

test("missing recovery scan roots are treated as empty", async () => {
  const root = path.join(os.tmpdir(), `wfl-map-recovery-missing-${process.pid}-${Date.now()}`);
  const result = await listSafeProjectDirectories(root);
  assert.deepEqual(result.directories, []);
  assert.equal(result.truncated, false);
});

test("startup recovery scan discovers ready nested Worktree projects from private state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-recovery-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "projects");
  const codexHome = path.join(root, "codex");
  const stateDirectory = path.join(root, "state");
  const repositoryRoot = path.join(projectRoot, "game-repo");
  const sourceProjectPath = path.join(repositoryRoot, "packages", "game");
  const worktreeProjectPath = path.join(codexHome, "worktrees", "wt-1", "packages", "game");
  await fs.mkdir(sourceProjectPath, { recursive: true });
  await fs.mkdir(worktreeProjectPath, { recursive: true });
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "codex-worktrees.json"), JSON.stringify({
    version: 1,
    records: [
      {
        id: "wt-1",
        state: "ready",
        projectPath: sourceProjectPath,
        repositoryRoot,
        worktreePath: path.join(codexHome, "worktrees", "wt-1"),
      },
      {
        id: "wt-missing",
        state: "missing",
        projectPath: sourceProjectPath,
        repositoryRoot,
        worktreePath: path.join(codexHome, "worktrees", "wt-missing"),
      },
    ],
  }));
  const result = await listSafeWorktreeProjectDirectories({ stateDirectory, codexHome, projectRoot });
  assert.deepEqual(result.directories, [worktreeProjectPath]);
  assert.equal(result.truncated, false);
});

test("startup recovery scan rejects malformed or symlinked Worktree state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-recovery-worktree-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "state");
  const codexHome = path.join(root, "codex");
  const projectRoot = path.join(root, "projects");
  await Promise.all([
    fs.mkdir(stateDirectory, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(projectRoot, { recursive: true }),
  ]);
  await fs.writeFile(path.join(stateDirectory, "codex-worktrees.json"), "{bad json\n");
  await assert.rejects(
    listSafeWorktreeProjectDirectories({ stateDirectory, codexHome, projectRoot }),
    /cannot be read/u,
  );
  const outsideState = path.join(root, "outside-state.json");
  await fs.writeFile(outsideState, JSON.stringify({ version: 1, records: [] }));
  await fs.rm(path.join(stateDirectory, "codex-worktrees.json"));
  await fs.symlink(outsideState, path.join(stateDirectory, "codex-worktrees.json"));
  await assert.rejects(
    listSafeWorktreeProjectDirectories({ stateDirectory, codexHome, projectRoot }),
    /invalid for recovery scanning/u,
  );
});
