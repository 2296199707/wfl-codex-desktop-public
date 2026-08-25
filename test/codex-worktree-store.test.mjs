import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CodexWorktreeStore } from "../lib/codex-worktree-store.mjs";

const execute = promisify(execFile);

test("creates a detached Codex worktree with bounded local changes and restores a private snapshot", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const store = await createStore(fixture).initialize();

  const inspected = await store.inspectProject(fixture.project);
  assert.equal(inspected.repository, true);
  assert.equal(inspected.branch, "main");
  assert.equal(inspected.dirty, true);
  assert.equal(inspected.untrackedCount, 1);
  assert.deepEqual(inspected.dependencies, ["node_modules"]);
  assert.deepEqual(inspected.branches.map((entry) => entry.name), ["main"]);

  const created = await store.create({
    projectPath: fixture.project,
    baseRef: "main",
    includeUncommitted: true,
    label: "Browser feature",
    attachments: [{
      name: "user notes.txt",
      path: fixture.attachment,
      mediaType: "text/plain",
    }],
  });
  assert.equal(created.state, "ready");
  assert.equal(created.branch, null);
  assert.equal(created.label, "Browser feature");
  assert.equal(await read(path.join(created.worktreePath, "tracked.txt")), "changed locally\n");
  assert.equal(await read(path.join(created.worktreePath, "notes", "draft.txt")), "draft\n");
  assert.equal(await read(path.join(created.worktreePath, ".env")), "SECRET=local-only\n");
  assert.equal(created.attachments.length, 1);
  assert.equal(created.attachments[0].mediaType, "text/plain");
  assert.equal(await read(created.attachments[0].path), "attachment\n");
  assert.ok(created.attachments[0].path.startsWith(path.join(created.worktreePath, ".codex-uploads")));
  await assert.rejects(fs.lstat(path.join(created.worktreePath, "ignored-link")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(created.worktreePath, "node_modules", "fixture.txt")), { code: "ENOENT" });
  assert.deepEqual(created.excludedDependencies, ["node_modules"]);
  assert.equal(created.skippedSymlinks, 1);
  assert.equal((await git(created.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)).code, 1);

  const bound = await store.bindThread(created.id, "thread-worktree-fixture");
  assert.equal(bound.threadId, "thread-worktree-fixture");
  const renamed = await store.rename(created.id, "Renamed browser feature");
  assert.equal(renamed.label, "Renamed browser feature");
  assert.equal(store.get(created.id).label, "Renamed browser feature");
  const branch = await store.createBranch(created.id, "feature/worktree-fixture");
  assert.equal(branch.branch, "feature/worktree-fixture");
  await fs.writeFile(path.join(created.worktreePath, "tracked.txt"), "changed after branch\n");
  await fs.writeFile(path.join(created.worktreePath, "extra.txt"), "snapshot me\n");

  const handedToLocal = await store.handoff(created.id, "local");
  assert.equal(handedToLocal.location, "local");
  assert.equal(await read(path.join(fixture.project, "tracked.txt")), "changed after branch\n");
  assert.equal(await read(path.join(fixture.project, "extra.txt")), "snapshot me\n");
  await fs.writeFile(path.join(fixture.project, "tracked.txt"), "changed in Local\n");
  await fs.writeFile(path.join(fixture.project, "local-only.txt"), "back to worktree\n");
  const handedBack = await store.handoff(created.id, "worktree");
  assert.equal(handedBack.location, "worktree");
  assert.equal(await read(path.join(created.worktreePath, "tracked.txt")), "changed in Local\n");
  assert.equal(await read(path.join(created.worktreePath, "local-only.txt")), "back to worktree\n");
  await fs.writeFile(path.join(fixture.project, "tracked.txt"), "conflicting Local edit\n");
  await fs.writeFile(path.join(created.worktreePath, "tracked.txt"), "competing Worktree edit\n");
  await assert.rejects(
    store.handoff(created.id, "local"),
    /Local 在上次同步后已有其他修改/,
  );
  assert.equal(await read(path.join(fixture.project, "tracked.txt")), "conflicting Local edit\n");
  assert.equal(await read(path.join(created.worktreePath, "tracked.txt")), "competing Worktree edit\n");
  await fs.writeFile(path.join(fixture.project, "tracked.txt"), "changed in Local\n");
  await fs.writeFile(path.join(created.worktreePath, "tracked.txt"), "changed in Local\n");

  const snapshotted = await store.snapshot(created.id);
  assert.ok(snapshotted.snapshot.patchBytes > 0);
  assert.ok(snapshotted.snapshot.files >= 3);
  const stateMode = (await fs.stat(path.join(fixture.state, "codex-worktrees.json"))).mode & 0o777;
  assert.equal(stateMode, 0o600);

  const removed = await store.remove(created.id);
  assert.equal(removed.state, "restorable");
  await assert.rejects(fs.lstat(created.worktreePath), { code: "ENOENT" });
  const restored = await store.restore(created.id);
  assert.equal(restored.state, "ready");
  assert.equal(await read(path.join(created.worktreePath, "tracked.txt")), "changed in Local\n");
  assert.equal(await read(path.join(created.worktreePath, "extra.txt")), "snapshot me\n");
  assert.equal(await read(path.join(created.worktreePath, "local-only.txt")), "back to worktree\n");
  assert.equal(await read(path.join(created.worktreePath, ".env")), "SECRET=local-only\n");

  const authorized = await store.authorizeDirectory(created.worktreePath);
  assert.equal(authorized.record.id, created.id);
  assert.equal(authorized.realPath, await fs.realpath(created.worktreePath));
  assert.equal(await store.authorizeDirectory(fixture.project), null);

  const reloaded = await createStore(fixture).initialize();
  assert.equal(reloaded.forThread("thread-worktree-fixture").id, created.id);
  assert.equal(reloaded.get(created.id).state, "ready");
  const usage = await reloaded.usage();
  assert.equal(usage.count, 1);
  assert.ok(usage.bytes > 0);
});

test("reclaims only unbound disposable worktrees at capacity and protects pinned records", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const store = await createStore(fixture, { maxManaged: 1 }).initialize();
  const first = await store.create({ projectPath: fixture.project });
  const second = await store.create({ projectPath: fixture.project });
  assert.equal(store.get(first.id).state, "restorable");
  assert.equal(store.get(second.id).state, "ready");

  await store.remove(second.id, { snapshot: false });
  const third = await store.create({ projectPath: fixture.project });
  await store.setPinned(third.id, true);
  await assert.rejects(
    store.create({ projectPath: fixture.project }),
    /已达到 1 个上限/,
  );
  assert.equal(store.get(third.id).state, "ready");
});

test("persists Worktree Thread aliases and rolls back failed binding mutations", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project });
  await store.bindThread(worktree.id, "thread-alias-before");

  const rebound = await store.replaceThreadBinding(
    worktree.id,
    "thread-alias-before",
    "thread-alias-after",
  );
  assert.equal(rebound.threadId, "thread-alias-after");
  assert.equal(store.resolveThreadId("thread-alias-before"), "thread-alias-after");
  assert.equal(store.forThread("thread-alias-before").threadId, "thread-alias-after");
  await assert.rejects(
    store.remove(worktree.id, { snapshot: false }),
    /必须保留恢复快照/,
  );

  const reloaded = await createStore(fixture).initialize();
  assert.equal(reloaded.resolveThreadId("thread-alias-before"), "thread-alias-after");
  assert.equal(reloaded.forThread("thread-alias-before").id, worktree.id);

  const originalPersist = store.persist.bind(store);
  store.persist = async () => { throw new Error("simulated binding persist failure"); };
  await assert.rejects(
    store.bindThread(worktree.id, "thread-bind-failure"),
    /simulated binding persist failure/,
  );
  store.persist = originalPersist;
  assert.equal(store.get(worktree.id).threadId, "thread-alias-after");
  assert.equal(store.resolveThreadId("thread-alias-before"), "thread-alias-after");
});

test("does not resurrect deleted or replaced Worktree directories and cleans discardable state", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const options = {
    stateDirectory: fixture.state,
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    home: fixture.home,
  };
  const store = await createStore(fixture).initialize();
  const deleted = await store.create({ projectPath: fixture.project });
  await store.remove(deleted.id, { snapshot: false });
  await fs.mkdir(deleted.worktreePath, { recursive: true });
  await fs.writeFile(path.join(deleted.worktreePath, "spoof.txt"), "not a Worktree\n");
  const reloaded = await new CodexWorktreeStore(options).initialize();
  assert.equal(reloaded.get(deleted.id).state, "deleted");

  const restorable = await reloaded.create({ projectPath: fixture.project });
  await fs.writeFile(path.join(restorable.worktreePath, "keep.txt"), "keep\n");
  await reloaded.remove(restorable.id);
  await fs.mkdir(restorable.worktreePath, { recursive: true });
  await fs.writeFile(path.join(restorable.worktreePath, "spoof.txt"), "not a Git Worktree\n");
  await assert.rejects(
    reloaded.restore(restorable.id),
    /不是可恢复的 Git Worktree/,
  );
  assert.equal(reloaded.get(restorable.id).state, "restorable");

  const disposable = await reloaded.create({ projectPath: fixture.project });
  const handoffRoot = path.join(fixture.state, "codex-worktree-handoffs-v1", disposable.id);
  assert.ok((await fs.readdir(handoffRoot)).length > 0);
  const discarded = await reloaded.remove(disposable.id, { snapshot: false });
  assert.equal(discarded.state, "deleted");
  assert.equal(discarded.handoffAvailable, false);
  await assert.rejects(fs.lstat(handoffRoot), { code: "ENOENT" });
});

test("purges deleted Worktree records and optionally removes their Git branch", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project, baseRef: "main" });
  await store.createBranch(worktree.id, "feature/purge-worktree");
  const removed = await store.remove(worktree.id);
  assert.equal(removed.state, "restorable");

  const purged = await store.purge(worktree.id, { deleteBranch: true });
  assert.equal(purged.id, worktree.id);
  assert.equal(purged.purged, true);
  assert.equal(purged.branchDeleted, true);
  assert.equal(purged.unboundThreadId, null);
  assert.equal(store.get(worktree.id), null);
  await assert.rejects(fs.lstat(path.join(fixture.state, "codex-worktree-snapshots-v1", worktree.id)), { code: "ENOENT" });
  assert.equal((await git(fixture.project, [
    "show-ref", "--verify", "--quiet", "refs/heads/feature/purge-worktree",
  ], true)).code, 1);
  assert.equal((await createStore(fixture).initialize()).get(worktree.id), null);
});

test("automatically detaches a conversation when purging its Worktree", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project });
  await store.bindThread(worktree.id, "thread-purge-bound");
  await store.remove(worktree.id);
  const purged = await store.purge(worktree.id);
  assert.equal(purged.purged, true);
  assert.equal(purged.unboundThreadId, "thread-purge-bound");
  assert.equal(purged.projectPath, fixture.project);
  assert.equal(store.get(worktree.id), null);
  const detached = store.detachedForThread("thread-purge-bound");
  assert.equal(detached.projectPath, fixture.project);
  assert.equal(detached.label, "Worktree 对话");
  assert.ok(detached.detachedAt > 0);
});

test("reconciles an externally missing active Worktree before listing it", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project });
  await fs.rm(worktree.worktreePath, { recursive: true, force: true });
  const listed = await store.listWithSync({ projectPath: fixture.project });
  assert.equal(listed[0].state, "missing");
  assert.equal(store.get(worktree.id).state, "missing");
});

test("detects source updates and synchronizes them while preserving uncommitted Worktree changes", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project, baseRef: "main", label: "同步测试" });

  await fs.writeFile(path.join(fixture.project, "released.txt"), "from source\n");
  await git(fixture.project, ["add", "released.txt"]);
  await git(fixture.project, ["commit", "-m", "source update"]);
  await fs.writeFile(path.join(worktree.worktreePath, "tracked.txt"), "local edit\n");
  await fs.writeFile(path.join(worktree.worktreePath, "local.txt"), "keep me\n");

  const before = (await store.listWithSync({ projectPath: fixture.project }))[0];
  assert.equal(before.sync.state, "available");
  assert.equal(before.sync.available, true);
  assert.equal(before.sync.dirty, true);

  const synchronized = await store.sync(worktree.id);
  assert.equal(synchronized.sync.state, "up-to-date");
  assert.equal(synchronized.sync.available, false);
  assert.equal(await read(path.join(worktree.worktreePath, "released.txt")), "from source\n");
  assert.equal(await read(path.join(worktree.worktreePath, "tracked.txt")), "local edit\n");
  assert.equal(await read(path.join(worktree.worktreePath, "local.txt")), "keep me\n");
  assert.equal(synchronized.baseCommit, (await git(fixture.project, ["rev-parse", "HEAD"])).stdout.trim());
});

test("shows whether a Worktree source can advance automatically and why it is blocked", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const base = (await git(fixture.project, ["rev-parse", "HEAD"])).stdout.trim();
  await git(fixture.project, ["branch", "source-for-auto-advance", base]);
  await fs.writeFile(path.join(fixture.project, "released.txt"), "release\n");
  await git(fixture.project, ["add", "released.txt"]);
  await git(fixture.project, ["commit", "-m", "release target"]);

  const store = await createStore(fixture).initialize();
  const worktree = await store.create({
    projectPath: fixture.project,
    baseRef: "source-for-auto-advance",
  });
  const eligible = await store.inspectSync(worktree.id);
  assert.equal(eligible.autoAdvance.state, "eligible");
  assert.match(eligible.autoAdvance.reason, /可由发布流程自动快进/);

  const sourceCheckout = path.join(fixture.directory, "source-checkout");
  await git(fixture.project, ["worktree", "add", sourceCheckout, "source-for-auto-advance"]);
  await fs.writeFile(path.join(sourceCheckout, "uncommitted.txt"), "hold\n");
  const blocked = await store.inspectSync(worktree.id);
  assert.equal(blocked.autoAdvance.state, "blocked");
  assert.match(blocked.autoAdvance.reason, /未提交修改/);
});

test("rolls back a Worktree sync when uncommitted changes conflict with the source update", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project, baseRef: "main" });

  await fs.writeFile(path.join(fixture.project, "tracked.txt"), "source conflict\n");
  await git(fixture.project, ["add", "tracked.txt"]);
  await git(fixture.project, ["commit", "-m", "source conflict"]);
  await fs.writeFile(path.join(worktree.worktreePath, "tracked.txt"), "local conflict\n");

  await assert.rejects(store.sync(worktree.id), (error) => {
    assert.match(error.message, /tracked\.txt/);
    assert.match(error.message, /CONFLICT|patch|冲突/i);
    assert.doesNotMatch(error.message, /^git 退出：1$/);
    return true;
  });
  assert.equal(await read(path.join(worktree.worktreePath, "tracked.txt")), "local conflict\n");
  assert.equal((await store.inspectSync(worktree.id)).state, "available");
});

test("merges source updates into a formal Worktree branch without dropping its commits", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project, baseRef: "main" });
  await store.createBranch(worktree.id, "feature/sync-branch");
  await fs.writeFile(path.join(worktree.worktreePath, "branch-change.txt"), "branch\n");
  await git(worktree.worktreePath, ["add", "branch-change.txt"]);
  await git(worktree.worktreePath, ["commit", "-m", "branch change"]);
  const branchHead = (await git(worktree.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

  await fs.writeFile(path.join(fixture.project, "released.txt"), "from source\n");
  await git(fixture.project, ["add", "released.txt"]);
  await git(fixture.project, ["commit", "-m", "source update"]);

  const before = await store.inspectSync(worktree.id);
  assert.equal(before.state, "available");
  assert.equal(before.committedChanges, true);
  const synchronized = await store.sync(worktree.id);
  assert.equal(synchronized.sync.state, "up-to-date");
  assert.equal(await read(path.join(worktree.worktreePath, "branch-change.txt")), "branch\n");
  assert.equal(await read(path.join(worktree.worktreePath, "released.txt")), "from source\n");
  assert.equal((await git(worktree.worktreePath, ["merge-base", "--is-ancestor", branchHead, "HEAD"], true)).code, 0);
});

test("rebinds an existing conversation to a new branch and safely deletes the old branch", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const oldWorktree = await store.create({ projectPath: fixture.project, baseRef: "main", label: "旧分支" });
  await store.createBranch(oldWorktree.id, "feature/old-worktree");
  await fs.writeFile(path.join(oldWorktree.worktreePath, "merged-from-old-worktree.txt"), "merged\n");
  await git(oldWorktree.worktreePath, ["add", "merged-from-old-worktree.txt"]);
  await git(oldWorktree.worktreePath, ["commit", "-m", "old worktree change"]);
  await git(fixture.project, ["merge", "--no-ff", "--no-edit", "feature/old-worktree"]);
  await store.bindThread(oldWorktree.id, "thread-rebind-fixture");
  const newWorktree = await store.create({ projectPath: fixture.project, baseRef: "main", label: "新分支" });
  await store.createBranch(newWorktree.id, "feature/new-worktree");

  const rebound = await store.rebindThread(newWorktree.id, "thread-rebind-fixture", oldWorktree.id);
  assert.equal(rebound.worktree.threadId, "thread-rebind-fixture");
  assert.equal(rebound.worktree.branch, "feature/new-worktree");
  assert.equal(rebound.previousWorktree.threadId, null);
  assert.equal(store.forThread("thread-rebind-fixture").id, newWorktree.id);

  const removed = await store.remove(oldWorktree.id, { deleteBranch: true });
  assert.equal(removed.state, "restorable");
  assert.equal(removed.branch, null);
  assert.equal((await git(fixture.project, [
    "show-ref", "--verify", "--quiet", "refs/heads/feature/old-worktree",
  ], true)).code, 1);
  assert.equal((await git(fixture.project, [
    "show-ref", "--verify", "--quiet", "refs/heads/feature/new-worktree",
  ], true)).code, 0);
});

test("refuses to delete a branch with commits not merged into its current base ref", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const worktree = await store.create({ projectPath: fixture.project, baseRef: "main" });
  await store.createBranch(worktree.id, "feature/unmerged-worktree");
  await fs.writeFile(path.join(worktree.worktreePath, "unmerged.txt"), "keep\n");
  await git(worktree.worktreePath, ["add", "unmerged.txt"]);
  await git(worktree.worktreePath, ["commit", "-m", "unmerged worktree change"]);

  await assert.rejects(
    store.remove(worktree.id, { deleteBranch: true }),
    /尚未合并的提交/,
  );
  assert.equal(store.get(worktree.id).state, "ready");
  assert.equal((await git(fixture.project, [
    "show-ref", "--verify", "--quiet", "refs/heads/feature/unmerged-worktree",
  ], true)).code, 0);
  assert.equal(await read(path.join(worktree.worktreePath, "unmerged.txt")), "keep\n");
});

test("rejects non-repositories, paths outside the account root, and non-current dirty bases", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const store = await createStore(fixture).initialize();
  const plain = path.join(fixture.projectRoot, "plain");
  await fs.mkdir(plain);
  await assert.rejects(store.inspectProject(plain), /不是 Git 仓库/);
  await assert.rejects(store.inspectProject(fixture.directory), /当前账号拥有的工程/);

  await git(fixture.project, ["branch", "other", "HEAD~0"]);
  await fs.writeFile(path.join(fixture.project, "tracked.txt"), "another local edit\n");
  await git(fixture.project, ["checkout", "-b", "later"]);
  await fs.writeFile(path.join(fixture.project, "later.txt"), "later\n");
  await git(fixture.project, ["add", "later.txt"]);
  await git(fixture.project, ["commit", "-m", "later"]);
  await fs.writeFile(path.join(fixture.project, "tracked.txt"), "dirty on later\n");
  await assert.rejects(
    store.create({
      projectPath: fixture.project,
      baseRef: "other",
      includeUncommitted: true,
    }),
    /只有从当前 HEAD 创建/,
  );
});

test("ignores Git trailing-slash markers for nested untracked repositories", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const nested = path.join(fixture.project, "nested-repository");
  await fs.mkdir(nested);
  await git(nested, ["init", "-b", "main"]);

  const store = await createStore(fixture).initialize();
  const inspected = await store.inspectProject(fixture.project);

  assert.equal(inspected.repository, true);
  assert.equal(inspected.untrackedCount, 1);
});

test("publishes a rescue Worktree to Local without rebinding the active Worktree", async (context) => {
  const fixture = await createFixture();
  context.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.project, ["checkout", "--", "."]);
  await git(fixture.project, ["clean", "-fdx"]);
  const store = await createStore(fixture).initialize();
  const created = await store.create({ projectPath: fixture.project });
  await fs.writeFile(path.join(created.worktreePath, "tracked.txt"), "rescue change\n");
  await fs.writeFile(path.join(created.worktreePath, "rescue-only.txt"), "keep editing here\n");

  const published = await store.publishToLocal(created.id);
  assert.equal(published.location, "worktree");
  assert.equal(await read(path.join(fixture.project, "tracked.txt")), "rescue change\n");
  assert.equal(await read(path.join(fixture.project, "rescue-only.txt")), "keep editing here\n");
  assert.equal(await read(path.join(created.worktreePath, "tracked.txt")), "rescue change\n");
  assert.equal(await read(path.join(created.worktreePath, "rescue-only.txt")), "keep editing here\n");

  await fs.writeFile(path.join(created.worktreePath, "tracked.txt"), "second rescue change\n");
  const originalPersist = store.persist.bind(store);
  store.persist = async () => {
    throw new Error("simulated state persist failure");
  };
  await assert.rejects(store.publishToLocal(created.id), /simulated state persist failure/);
  store.persist = originalPersist;
  assert.equal(await read(path.join(fixture.project, "tracked.txt")), "rescue change\n");
  assert.equal(await read(path.join(created.worktreePath, "tracked.txt")), "second rescue change\n");
  assert.equal(store.get(created.id).location, "worktree");
});

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worktree-store-"));
  const home = path.join(directory, "home");
  const codexHome = path.join(home, ".codex");
  const state = path.join(home, "state");
  const projectRoot = path.join(home, "projects");
  const project = path.join(projectRoot, "repository");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await git(project, ["init", "-b", "main"]);
  await git(project, ["config", "user.name", "Worktree Test"]);
  await git(project, ["config", "user.email", "worktree@example.test"]);
  await fs.writeFile(path.join(project, "tracked.txt"), "committed\n");
  await fs.writeFile(path.join(project, ".gitignore"), ".env\nignored-link\nnode_modules/\n.codex-uploads/\n");
  await fs.writeFile(path.join(project, ".worktreeinclude"), ".env\nignored-link\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "fixture"]);
  await fs.writeFile(path.join(project, "tracked.txt"), "changed locally\n");
  await fs.mkdir(path.join(project, "notes"));
  await fs.writeFile(path.join(project, "notes", "draft.txt"), "draft\n");
  await fs.writeFile(path.join(project, ".env"), "SECRET=local-only\n");
  await fs.symlink("tracked.txt", path.join(project, "ignored-link"));
  await fs.mkdir(path.join(project, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(project, "node_modules", "fixture.txt"), "dependency\n");
  const uploadDirectory = path.join(project, ".codex-uploads");
  await fs.mkdir(uploadDirectory);
  const attachment = path.join(uploadDirectory, "user-notes.txt");
  await fs.writeFile(attachment, "attachment\n");
  return { directory, home, codexHome, state, projectRoot, project, attachment };
}

function createStore(fixture, options = {}) {
  return new CodexWorktreeStore({
    stateDirectory: fixture.state,
    codexHome: fixture.codexHome,
    projectRoot: fixture.projectRoot,
    home: fixture.home,
    ...options,
  });
}

async function git(cwd, args, allowFailure = false) {
  try {
    const result = await execute("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!allowFailure) throw error;
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

async function read(filePath) {
  return fs.readFile(filePath, "utf8");
}
