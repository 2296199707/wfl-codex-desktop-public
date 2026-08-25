import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { advanceWorktreeSourceRefs } from "../scripts/advance-worktree-source-refs.mjs";

const execFileAsync = promisify(execFile);

test("advances only clean source refs and leaves Worktree branches untouched", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-worktree-source-refs-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.name", "Source Ref Test"]);
  await git(directory, ["config", "user.email", "source-ref-test@example.test"]);
  await fs.writeFile(path.join(directory, "tracked.txt"), "base\n");
  await git(directory, ["add", "tracked.txt"]);
  await git(directory, ["commit", "-m", "base"]);
  const base = await rev(directory, "HEAD");
  await git(directory, ["branch", "source-clean", base]);
  await git(directory, ["branch", "source-dirty", base]);
  await fs.writeFile(path.join(directory, "tracked.txt"), "release\n");
  await git(directory, ["commit", "-am", "release"]);
  const target = await rev(directory, "HEAD");

  const sourceWorktree = path.join(directory, "source-worktree");
  await git(directory, ["worktree", "add", sourceWorktree, "source-clean"]);
  const dirtySourceWorktree = path.join(directory, "dirty-source-worktree");
  await git(directory, ["worktree", "add", dirtySourceWorktree, "source-dirty"]);
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-worktree-source-state-"));
  context.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  await fs.writeFile(path.join(stateDirectory, "codex-worktrees.json"), `${JSON.stringify({
    version: 1,
    records: [
      { repositoryRoot: directory, baseRef: "source-clean", state: "ready" },
      { repositoryRoot: directory, baseRef: "source-dirty", state: "ready" },
      { repositoryRoot: directory, baseRef: "HEAD", state: "ready" },
    ],
  })}\n`);
  await fs.writeFile(path.join(sourceWorktree, "uncommitted.txt"), "keep\n");
  await fs.writeFile(path.join(dirtySourceWorktree, "uncommitted.txt"), "keep\n");

  const result = await advanceWorktreeSourceRefs({
    stateDirectory,
    projectDirectory: directory,
    targetCommit: target,
  });
  assert.equal(result.advanced.length, 0);
  assert.ok(result.skipped.some((entry) => entry.ref === "source-clean" && entry.reason === "checked-out-source-dirty"));
  assert.ok(result.skipped.some((entry) => entry.ref === "HEAD" && entry.reason === "base-ref-head"));
  assert.equal(await rev(directory, "source-clean"), base);
  assert.equal(await rev(directory, "source-dirty"), base);
});

test("fast-forwards a clean checked-out source branch and an unshared ref", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-worktree-source-refs-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.name", "Source Ref Test"]);
  await git(directory, ["config", "user.email", "source-ref-test@example.test"]);
  await fs.writeFile(path.join(directory, "tracked.txt"), "base\n");
  await git(directory, ["add", "tracked.txt"]);
  await git(directory, ["commit", "-m", "base"]);
  const base = await rev(directory, "HEAD");
  await git(directory, ["branch", "source-checked", base]);
  await git(directory, ["branch", "source-unchecked", base]);
  await fs.writeFile(path.join(directory, "tracked.txt"), "release\n");
  await git(directory, ["commit", "-am", "release"]);
  const target = await rev(directory, "HEAD");
  await git(directory, ["checkout", "source-checked"]);

  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-worktree-source-state-"));
  context.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  await fs.mkdir(path.join(stateDirectory, "user-state", "u-test"), { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "codex-worktrees.json"), `${JSON.stringify({
    records: [{ repositoryRoot: directory, baseRef: "source-checked", state: "ready" }],
  })}\n`);
  await fs.writeFile(path.join(stateDirectory, "user-state", "u-test", "codex-worktrees.json"), `${JSON.stringify({
    records: [{ repositoryRoot: directory, baseRef: "source-unchecked", state: "ready" }],
  })}\n`);

  const result = await advanceWorktreeSourceRefs({
    stateDirectory,
    projectDirectory: directory,
    targetCommit: target,
  });
  assert.equal(result.advanced.length, 2);
  assert.equal(await rev(directory, "source-checked"), target);
  assert.equal(await rev(directory, "source-unchecked"), target);
  assert.equal(await fs.readFile(path.join(directory, "tracked.txt"), "utf8"), "release\n");
});

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function rev(cwd, ref) {
  const result = await execFileAsync("git", ["rev-parse", ref], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}
