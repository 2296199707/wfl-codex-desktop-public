import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateGitBranchName,
  validateGitRelativePath,
} from "./git-workspace.mjs";

const STORE_VERSION = 1;
const MAX_THREAD_ALIASES = 512;
const MAX_DETACHED_THREADS = 512;
const DEFAULT_MAX_MANAGED = 15;
const DEFAULT_MAX_COPY_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_COPY_ENTRIES = 20_000;
const DEFAULT_EXPIRES_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const DEPENDENCY_DIRECTORIES = [
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "target",
  ".gradle",
  ".m2",
];
const PRIVATE_WORKTREE_PATHS = new Set([
  ".codex-desktop",
  ".codex-runtime",
  ".codex-uploads",
]);

export class CodexWorktreeStore {
  constructor({
    stateDirectory,
    codexHome,
    projectRoot,
    projectRoots = null,
    releaseProjectRoot = null,
    home = null,
    uid = null,
    gid = null,
    now = () => Date.now(),
    maxManaged = DEFAULT_MAX_MANAGED,
    maxCopyBytes = DEFAULT_MAX_COPY_BYTES,
    maxCopyEntries = DEFAULT_MAX_COPY_ENTRIES,
    expiresAfterMs = DEFAULT_EXPIRES_AFTER_MS,
  } = {}) {
    this.stateDirectory = path.resolve(requiredPath(stateDirectory, "Worktree state directory"));
    this.codexHome = path.resolve(requiredPath(codexHome, "Codex home"));
    this.projectRoots = [...new Set((projectRoots?.length ? projectRoots : [projectRoot])
      .map((value) => path.resolve(requiredPath(value, "Project root"))))];
    this.projectRoot = this.projectRoots[0];
    this.releaseProjectRoot = releaseProjectRoot ? path.resolve(releaseProjectRoot) : null;
    this.home = home ? path.resolve(home) : path.dirname(this.codexHome);
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.now = now;
    this.maxManaged = boundedInteger(maxManaged, 1, 100, DEFAULT_MAX_MANAGED);
    this.maxCopyBytes = boundedInteger(maxCopyBytes, 1024, 20 * 1024 * 1024 * 1024, DEFAULT_MAX_COPY_BYTES);
    this.maxCopyEntries = boundedInteger(maxCopyEntries, 1, 100_000, DEFAULT_MAX_COPY_ENTRIES);
    this.expiresAfterMs = boundedInteger(
      expiresAfterMs,
      60_000,
      365 * 24 * 60 * 60 * 1000,
      DEFAULT_EXPIRES_AFTER_MS,
    );
    this.rootDirectory = path.join(this.codexHome, "worktrees");
    this.snapshotDirectory = path.join(this.stateDirectory, "codex-worktree-snapshots-v1");
    this.handoffDirectory = path.join(this.stateDirectory, "codex-worktree-handoffs-v1");
    this.filePath = path.join(this.stateDirectory, "codex-worktrees.json");
    this.records = new Map();
    this.threadAliases = new Map();
    this.detachedThreads = new Map();
    this.operationQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this;
    await Promise.all([
      ensurePrivateDirectory(this.stateDirectory),
      ensurePrivateDirectory(this.snapshotDirectory),
      ensurePrivateDirectory(this.handoffDirectory),
      ensurePrivateDirectory(this.rootDirectory, this.uid, this.gid),
    ]);
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      for (const entry of Array.isArray(value?.records) ? value.records : []) {
        const record = normalizeStoredRecord(entry, {
          rootDirectory: this.rootDirectory,
          projectRoots: this.projectRoots,
          snapshotDirectory: this.snapshotDirectory,
          handoffDirectory: this.handoffDirectory,
        });
        if (record) this.records.set(record.id, record);
      }
      this.threadAliases = normalizeThreadAliases(value?.threadAliases);
      this.detachedThreads = normalizeDetachedThreads(value?.detachedThreads);
      this.trimThreadAliases();
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await this.reconcile();
    this.initialized = true;
    return this;
  }

  list({ projectPath = null } = {}) {
    this.assertInitialized();
    const normalizedProject = projectPath ? path.resolve(projectPath) : null;
    return [...this.records.values()]
      .filter((record) => !normalizedProject || record.projectPath === normalizedProject)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .map(publicRecord);
  }

  async listWithSync({ projectPath = null } = {}) {
    return this.queue(() => this.listWithSyncUnlocked({ projectPath }));
  }

  async listWithSyncUnlocked({ projectPath = null } = {}) {
    this.assertInitialized();
    await this.reconcile();
    const normalizedProject = projectPath ? path.resolve(projectPath) : null;
    const records = [...this.records.values()]
      .filter((record) => !normalizedProject || record.projectPath === normalizedProject)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
    return Promise.all(records.map(async (record) => {
      if (record.state !== "ready") return publicRecord(record, { sync: null });
      try {
        return publicRecord(record, { sync: await this.inspectSyncRecord(record) });
      } catch (error) {
        return publicRecord(record, {
          sync: {
            state: "unavailable",
            action: "inspect",
            available: false,
            sourceRef: record.baseRef,
            sourceCommit: null,
            currentCommit: null,
            dirty: false,
            committedChanges: false,
            reason: error.message || "无法读取 Worktree 同步状态",
          },
        });
      }
    }));
  }

  async inspectSync(id) {
    return this.inspectSyncRecord(this.requiredRecord(id));
  }

  async inspectSyncRecord(record) {
    if (record.state !== "ready" || !await pathExists(record.worktreePath)) {
      return {
        state: "unavailable",
        action: "inspect",
        available: false,
        sourceRef: record.baseRef,
        sourceCommit: null,
        currentCommit: null,
        dirty: false,
        committedChanges: false,
        autoAdvance: autoAdvanceStatus("unknown", "Worktree 目录当前不可用，无法确认来源分支是否可自动推进"),
        reason: "Worktree 目录当前不可用",
      };
    }
    const source = await this.git(record.repositoryRoot, [
      "rev-parse", "--verify", `${record.baseRef}^{commit}`,
    ], { allowFailure: true });
    if (!source.ok) {
      return {
        state: "unavailable",
        action: "inspect",
        available: false,
        sourceRef: record.baseRef,
        sourceCommit: null,
        currentCommit: null,
        dirty: false,
        committedChanges: false,
        autoAdvance: autoAdvanceStatus("blocked", `来源分支“${record.baseRef}”当前不存在，无法自动推进`),
        reason: `来源分支“${record.baseRef}”当前不存在`,
      };
    }
    const sourceCommit = source.stdout.trim();
    const autoAdvance = await this.inspectAutoAdvance(record, sourceCommit);
    const [headResult, branchResult, statusResult] = await Promise.all([
      this.git(record.worktreePath, ["rev-parse", "HEAD"]),
      this.git(record.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
      this.git(record.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        binary: true,
      }),
    ]);
    const currentCommit = headResult.stdout.trim();
    const currentBranch = branchResult.ok ? branchResult.stdout.trim() || null : null;
    const dirty = Boolean(statusResult.stdout.length);
    const committedChanges = currentCommit !== record.baseCommit;
    if (sourceCommit === record.baseCommit) {
      return {
        state: "up-to-date",
        action: null,
        available: false,
        sourceRef: record.baseRef,
        sourceCommit,
        currentCommit,
        currentBranch,
        dirty,
        committedChanges,
        autoAdvance,
        reason: "已是最新代码",
      };
    }
    if (record.location !== "worktree") {
      return {
        state: "blocked",
        action: "handoff",
        available: false,
        sourceRef: record.baseRef,
        sourceCommit,
        currentCommit,
        currentBranch,
        dirty,
        committedChanges,
        autoAdvance,
        reason: "请先把对话交接回 Worktree，再同步来源分支",
      };
    }
    if (committedChanges && !currentBranch) {
      return {
        state: "blocked",
        action: "create-branch",
        available: false,
        sourceRef: record.baseRef,
        sourceCommit,
        currentCommit,
        currentBranch,
        dirty,
        committedChanges,
        autoAdvance,
        reason: "Worktree 已有正式提交，请先保留或合并这些提交后再同步",
      };
    }
    return {
      state: "available",
      action: "sync",
      available: true,
      sourceRef: record.baseRef,
      sourceCommit,
      currentCommit,
      currentBranch,
      dirty,
      committedChanges,
      autoAdvance,
      reason: committedChanges
        ? "来源分支有新代码，已有提交和未提交修改都会被保留"
        : dirty
          ? "来源分支有新代码，未提交修改会被保留"
          : "来源分支有新代码",
    };
  }

  async inspectAutoAdvance(record, sourceCommit) {
    if (record.baseRef === "HEAD") {
      return autoAdvanceStatus("blocked", "基准是 HEAD，不是发布流程可以自动推进的来源分支");
    }
    if (this.releaseProjectRoot) {
      const sameRepository = await this.sameRepository(record.repositoryRoot, this.releaseProjectRoot);
      if (sameRepository === false) {
        return autoAdvanceStatus("not-applicable", "此 Worktree 不属于主站发布仓库，发布流程不会自动推进它");
      }
      if (sameRepository === null) {
        return autoAdvanceStatus("unknown", "无法确认此 Worktree 是否属于主站发布仓库");
      }
    }
    const target = await this.git(record.repositoryRoot, ["rev-parse", "HEAD"], { allowFailure: true });
    if (!target.ok) {
      return autoAdvanceStatus("unknown", "无法读取仓库当前提交，暂时不能确认是否可自动推进");
    }
    const targetCommit = target.stdout.trim();
    const [sourceAncestor, targetAncestor] = await Promise.all([
      this.git(record.repositoryRoot, ["merge-base", "--is-ancestor", sourceCommit, targetCommit], { allowFailure: true }),
      this.git(record.repositoryRoot, ["merge-base", "--is-ancestor", targetCommit, sourceCommit], { allowFailure: true }),
    ]);
    if (!sourceAncestor.ok && !targetAncestor.ok) {
      return autoAdvanceStatus("blocked", "来源分支已与当前发布提交分叉，不能自动快进；请先合并或重新选择来源分支");
    }
    if (targetAncestor.ok && !sourceAncestor.ok) {
      return autoAdvanceStatus("not-needed", "来源分支已领先当前发布提交，无需自动推进");
    }
    if (sourceCommit === targetCommit) {
      return autoAdvanceStatus("not-needed", "来源分支已经是当前发布提交，无需自动推进");
    }
    const sourceWorktree = await this.registeredWorktreeForBranch(record.repositoryRoot, record.baseRef);
    if (sourceWorktree?.error) return autoAdvanceStatus("unknown", sourceWorktree.error);
    if (sourceWorktree?.path) {
      const status = await this.git(sourceWorktree.path, [
        "status", "--porcelain=v1", "--untracked-files=all",
      ], { allowFailure: true });
      if (!status.ok) return autoAdvanceStatus("unknown", "无法读取来源工作树状态，暂时不能确认是否可自动推进");
      if (status.stdout) {
        return autoAdvanceStatus("blocked", "来源分支所在工作树有未提交修改，先提交或暂存后才能自动推进");
      }
    }
    return autoAdvanceStatus("eligible", "来源分支可由发布流程自动快进；Worktree 内容仍需手动同步");
  }

  async sameRepository(left, right) {
    const identity = async (directory) => {
      const result = await this.git(directory, ["rev-parse", "--git-common-dir"], { allowFailure: true });
      if (!result.ok) return null;
      try {
        return await fs.realpath(path.resolve(directory, result.stdout.trim()));
      } catch {
        return null;
      }
    };
    const [leftIdentity, rightIdentity] = await Promise.all([identity(left), identity(right)]);
    if (!leftIdentity || !rightIdentity) return null;
    return leftIdentity === rightIdentity;
  }

  async registeredWorktreeForBranch(repositoryRoot, branch) {
    const result = await this.git(repositoryRoot, ["worktree", "list", "--porcelain"], { allowFailure: true });
    if (!result.ok) return { error: "无法读取 Git Worktree 列表，暂时不能确认是否可自动推进" };
    let current = null;
    for (const line of String(result.stdout || "").split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current?.branch === branch) return current;
        current = { path: path.resolve(line.slice("worktree ".length).trim()), branch: null };
      } else if (current && line.startsWith("branch refs/heads/")) {
        current.branch = line.slice("branch refs/heads/".length).trim();
      }
    }
    return current?.branch === branch ? current : null;
  }

  get(id) {
    this.assertInitialized();
    const record = this.records.get(normalizeId(id));
    return record ? publicRecord(record) : null;
  }

  forThread(threadId) {
    this.assertInitialized();
    const normalized = this.resolveThreadId(threadId);
    const record = [...this.records.values()].find((entry) => entry.threadId === normalized);
    return record ? publicRecord(record) : null;
  }

  detachedForThread(threadId) {
    this.assertInitialized();
    const normalized = normalizeThreadId(threadId);
    const detached = this.detachedThreads.get(normalized);
    return detached ? { ...detached } : null;
  }

  async removeDetachedThread(threadId) {
    return this.queue(async () => {
      const normalized = normalizeThreadId(threadId);
      if (!this.detachedThreads.delete(normalized)) return false;
      await this.persist();
      return true;
    });
  }

  resolveThreadId(threadId) {
    this.assertInitialized();
    let current = normalizeThreadId(threadId);
    const seen = new Set();
    for (let index = 0; index < 8; index += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const next = this.threadAliases.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  }

  forProjectPath(projectPath) {
    this.assertInitialized();
    const normalized = path.resolve(String(projectPath || ""));
    const record = [...this.records.values()].find((entry) => (
      entry.state === "ready"
      && entry.location === "worktree"
      && entry.worktreeProjectPath === normalized
    ));
    return record ? publicRecord(record) : null;
  }

  findByBinding(binding) {
    this.assertInitialized();
    const normalized = normalizeBinding(binding);
    if (!normalized) return null;
    const record = [...this.records.values()].find((entry) => (
      entry.state !== "deleted" && entry.binding === normalized
    ));
    return record ? publicRecord(record) : null;
  }

  async inspectProject(projectPath) {
    this.assertInitialized();
    const project = await this.assertOwnedProject(projectPath);
    const repositoryRoot = await this.repositoryRoot(project);
    const [
      head,
      branch,
      status,
      branchOutput,
      untracked,
      included,
      dependencies,
    ] = await Promise.all([
      this.git(repositoryRoot, ["rev-parse", "HEAD"]),
      this.git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
      this.git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.git(repositoryRoot, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00", "refs/heads"]),
      this.listUntracked(repositoryRoot),
      this.listIncludedIgnored(repositoryRoot),
      inspectDependencies(repositoryRoot),
    ]);
    const branches = parseBranchOutput(branchOutput.stdout)
      .map((entry) => ({ ...entry, current: entry.name === branch.stdout.trim() }))
      .sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name));
    return {
      repository: true,
      projectPath: project,
      repositoryRoot,
      head: head.stdout.trim(),
      branch: branch.ok ? branch.stdout.trim() || null : null,
      detached: !branch.ok,
      dirty: Boolean(status.stdout.length),
      untrackedCount: untracked.length,
      includedIgnoredCount: included.length,
      dependencies,
      branches,
      canIncludeUncommitted: true,
      managedCount: this.list({ projectPath: project }).filter((entry) => entry.state !== "deleted").length,
      maxManaged: this.maxManaged,
    };
  }

  async create({
    projectPath,
    baseRef = "HEAD",
    includeUncommitted = false,
    permanent = false,
    label = null,
    binding = null,
    attachments = [],
  } = {}) {
    return this.queue(async () => {
      this.assertInitialized();
      const normalizedBinding = normalizeBinding(binding);
      if (normalizedBinding && [...this.records.values()].some((entry) => (
        entry.state !== "deleted" && entry.binding === normalizedBinding
      ))) {
        throw storeError(409, "这个 Worktree 绑定已经存在");
      }
      const project = await this.assertOwnedProject(projectPath);
      const repositoryRoot = await this.repositoryRoot(project);
      const projectRelativePath = path.relative(repositoryRoot, project);
      let activeCount = [...this.records.values()].filter((record) => record.state === "ready").length;
      if (activeCount >= this.maxManaged) {
        await this.cleanupForCapacity();
        activeCount = [...this.records.values()].filter((record) => record.state === "ready").length;
      }
      if (activeCount >= this.maxManaged) {
        throw storeError(409, `Codex Worktree 已达到 ${this.maxManaged} 个上限，请先清理旧记录`);
      }
      const normalizedBaseRef = normalizeBaseRef(baseRef);
      const base = await this.git(repositoryRoot, ["rev-parse", "--verify", `${normalizedBaseRef}^{commit}`]);
      const baseCommit = base.stdout.trim();
      assertCommit(baseCommit);
      const sourceHead = (await this.git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
      if (includeUncommitted && sourceHead !== baseCommit) {
        throw storeError(409, "只有从当前 HEAD 创建时才能带入未提交修改");
      }

      const id = `wt_${crypto.randomUUID()}`;
      const worktreePath = path.join(this.rootDirectory, id);
      const now = this.now();
      let copied = { entries: 0, bytes: 0, skippedSymlinks: 0, dependencies: [] };
      let copiedAttachments = [];
      try {
        await this.git(repositoryRoot, ["worktree", "add", "--detach", worktreePath, baseCommit], {
          timeoutMs: 120_000,
        });
        if (includeUncommitted) {
          const patch = await this.git(repositoryRoot, ["diff", "--binary", "HEAD", "--"], { binary: true });
          if (patch.stdout.length) {
            await this.git(worktreePath, ["apply", "--whitespace=nowarn", "-"], {
              input: patch.stdout,
              timeoutMs: 120_000,
            });
          }
          copied = await this.copyLocalFiles(repositoryRoot, worktreePath);
        }
        copiedAttachments = await this.copyAttachments(
          project,
          path.join(worktreePath, projectRelativePath),
          attachments,
        );
        const record = {
          version: STORE_VERSION,
          id,
          label: normalizeLabel(label),
          projectPath: project,
          repositoryRoot,
          worktreePath,
          projectRelativePath,
          worktreeProjectPath: path.join(worktreePath, projectRelativePath),
          baseRef: normalizedBaseRef,
          baseCommit,
          branch: null,
          threadId: null,
          location: "worktree",
          permanent: permanent === true || Boolean(normalizedBinding),
          pinned: Boolean(normalizedBinding),
          binding: normalizedBinding,
          state: "ready",
          createdAt: now,
          lastUsedAt: now,
          copiedEntries: copied.entries + copiedAttachments.length,
          copiedBytes: copied.bytes + copiedAttachments.reduce((total, entry) => total + entry.size, 0),
          skippedSymlinks: copied.skippedSymlinks,
          excludedDependencies: copied.dependencies,
          snapshot: null,
          handoff: null,
        };
        const baseline = await this.collectWorkingState(worktreePath, record.baseCommit);
        record.handoff = await this.writeHandoffGeneration(record, worktreePath, baseline);
        this.records.set(id, record);
        await this.persist();
        await this.cleanupExpired({ preserveId: id });
        return {
          ...publicRecord(record),
          attachments: copiedAttachments,
        };
      } catch (error) {
        this.records.delete(id);
        await this.git(repositoryRoot, ["worktree", "remove", "--force", worktreePath], {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch(() => {});
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
        await fs.rm(path.join(this.handoffDirectory, id), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async bindThread(id, threadId) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      const normalizedThreadId = normalizeThreadId(threadId);
      const existing = [...this.records.values()].find(
        (entry) => entry.threadId === normalizedThreadId && entry.id !== record.id,
      );
      if (existing) throw storeError(409, "该对话已经绑定另一个 Worktree");
      const previousThreadId = record.threadId;
      const previousLastUsedAt = record.lastUsedAt;
      const previousDetachedThreads = new Map(this.detachedThreads);
      record.threadId = normalizedThreadId;
      this.detachedThreads.delete(normalizedThreadId);
      record.lastUsedAt = this.now();
      try {
        await this.persist();
      } catch (error) {
        record.threadId = previousThreadId;
        record.lastUsedAt = previousLastUsedAt;
        this.detachedThreads = previousDetachedThreads;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async replaceThreadBinding(id, previousThreadId, nextThreadId) {
    return this.queue(async () => {
      const record = this.requiredReadyRecord(id);
      const previous = normalizeThreadId(previousThreadId);
      const next = normalizeThreadId(nextThreadId);
      if (record.threadId !== previous) {
        throw storeError(409, "Worktree 对话绑定已经变化，请刷新后重试");
      }
      const existing = [...this.records.values()].find(
        (entry) => entry.threadId === next && entry.id !== record.id,
      );
      if (existing) throw storeError(409, "该新对话已经绑定另一个 Worktree");
      const previousLastUsedAt = record.lastUsedAt;
      const previousAliases = new Map(this.threadAliases);
      const previousDetachedThreads = new Map(this.detachedThreads);
      record.threadId = next;
      record.lastUsedAt = this.now();
      this.threadAliases.set(previous, next);
      this.detachedThreads.delete(next);
      this.trimThreadAliases();
      try {
        await this.persist();
      } catch (error) {
        record.threadId = previous;
        record.lastUsedAt = previousLastUsedAt;
        this.threadAliases = previousAliases;
        this.detachedThreads = previousDetachedThreads;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async restoreThreadBinding(id, currentThreadId, previousThreadId) {
    return this.queue(async () => {
      const record = this.requiredReadyRecord(id);
      const current = normalizeThreadId(currentThreadId);
      const previous = normalizeThreadId(previousThreadId);
      if (record.threadId !== current) {
        throw storeError(409, "Worktree 对话绑定已经变化，请刷新后重试");
      }
      const previousLastUsedAt = record.lastUsedAt;
      const previousAliases = new Map(this.threadAliases);
      record.threadId = previous;
      record.lastUsedAt = this.now();
      for (const [from, to] of this.threadAliases) {
        if (from === previous && to === current) this.threadAliases.delete(from);
      }
      try {
        await this.persist();
      } catch (error) {
        record.threadId = current;
        record.lastUsedAt = previousLastUsedAt;
        this.threadAliases = previousAliases;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async unbindThread(id, expectedThreadId = null) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      const expected = expectedThreadId == null ? null : this.resolveThreadId(expectedThreadId);
      if (expected && record.threadId !== expected) {
        throw storeError(409, "Worktree 对话绑定已经变化，请刷新后重试");
      }
      const previousThreadId = record.threadId;
      const previousLastUsedAt = record.lastUsedAt;
      const previousAliases = new Map(this.threadAliases);
      record.threadId = null;
      record.lastUsedAt = this.now();
      for (const [from, to] of this.threadAliases) {
        if (from === previousThreadId || to === previousThreadId) this.threadAliases.delete(from);
      }
      try {
        await this.persist();
      } catch (error) {
        record.threadId = previousThreadId;
        record.lastUsedAt = previousLastUsedAt;
        this.threadAliases = previousAliases;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async rebindThread(id, threadId, sourceId = null) {
    return this.queue(async () => {
      const target = this.requiredReadyRecord(id);
      if (target.location !== "worktree") {
        throw storeError(409, "新的对话分支必须位于 Worktree 中");
      }
      const normalizedThreadId = normalizeThreadId(threadId);
      if (target.threadId && target.threadId !== normalizedThreadId) {
        throw storeError(409, "新的 Worktree 已绑定其他对话");
      }
      const normalizedSourceId = sourceId == null ? null : normalizeId(sourceId);
      const source = [...this.records.values()].find((entry) => (
        entry.id !== target.id
        && entry.threadId === normalizedThreadId
        && (!normalizedSourceId || entry.id === normalizedSourceId)
      ));
      if (!source) throw storeError(404, "没有找到这个对话当前绑定的 Worktree");
      if (source.repositoryRoot !== target.repositoryRoot || source.projectPath !== target.projectPath) {
        throw storeError(409, "只能在同一个 Git 工程的 Worktree 之间重新绑定对话");
      }
      const previous = {
        threadId: source.threadId,
        lastUsedAt: source.lastUsedAt,
      };
      const previousTargetThreadId = target.threadId;
      const targetLastUsedAt = target.lastUsedAt;
      const now = this.now();
      source.threadId = null;
      source.lastUsedAt = now;
      target.threadId = normalizedThreadId;
      target.lastUsedAt = now;
      try {
        await this.persist();
      } catch (error) {
        source.threadId = previous.threadId;
        source.lastUsedAt = previous.lastUsedAt;
        target.threadId = previousTargetThreadId;
        target.lastUsedAt = targetLastUsedAt;
        throw error;
      }
      return {
        worktree: publicRecord(target),
        previousWorktree: publicRecord(source),
      };
    });
  }

  async setPinned(id, pinned) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      const previousPinned = record.pinned;
      const previousLastUsedAt = record.lastUsedAt;
      record.pinned = pinned === true;
      record.lastUsedAt = this.now();
      try {
        await this.persist();
      } catch (error) {
        record.pinned = previousPinned;
        record.lastUsedAt = previousLastUsedAt;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async rename(id, label) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      const previousLabel = record.label;
      const previousLastUsedAt = record.lastUsedAt;
      record.label = normalizeLabel(label);
      record.lastUsedAt = this.now();
      try {
        await this.persist();
      } catch (error) {
        record.label = previousLabel;
        record.lastUsedAt = previousLastUsedAt;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async setBinding(id, binding) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      const normalized = normalizeBinding(binding);
      if (!normalized) throw storeError(400, "Worktree 绑定编号无效");
      const existing = [...this.records.values()].find((entry) => (
        entry.id !== record.id
        && entry.state !== "deleted"
        && entry.binding === normalized
      ));
      if (existing) throw storeError(409, "这个 Worktree 绑定已经存在");
      const previousBinding = record.binding;
      const previousPermanent = record.permanent;
      const previousPinned = record.pinned;
      const previousLastUsedAt = record.lastUsedAt;
      record.binding = normalized;
      record.permanent = true;
      record.pinned = true;
      record.lastUsedAt = this.now();
      try {
        await this.persist();
      } catch (error) {
        record.binding = previousBinding;
        record.permanent = previousPermanent;
        record.pinned = previousPinned;
        record.lastUsedAt = previousLastUsedAt;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async createBranch(id, branchName) {
    return this.queue(async () => {
      const record = this.requiredReadyRecord(id);
      if (record.location !== "worktree") {
        throw storeError(409, "请先把对话交接回 Worktree，再创建 Worktree 分支");
      }
      const branch = validateGitBranchName(branchName);
      const exists = await this.git(record.repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        allowFailure: true,
      });
      if (exists.ok) throw storeError(409, "Git 分支已存在");
      await this.git(record.worktreePath, ["switch", "-c", branch]);
      const previousBranch = record.branch;
      const previousLastUsedAt = record.lastUsedAt;
      record.branch = branch;
      record.lastUsedAt = this.now();
      try {
        await this.persist();
      } catch (error) {
        await this.git(record.worktreePath, ["switch", "--detach", record.baseCommit], {
          allowFailure: true,
        }).catch(() => {});
        await this.git(record.repositoryRoot, ["branch", "-D", branch], {
          allowFailure: true,
        }).catch(() => {});
        record.branch = previousBranch;
        record.lastUsedAt = previousLastUsedAt;
        throw error;
      }
      return publicRecord(record);
    });
  }

  async sync(id) {
    return this.queue(async () => {
      const record = this.requiredReadyRecord(id);
      const inspection = await this.inspectSyncRecord(record);
      if (inspection.state === "up-to-date") return publicRecord(record, { sync: inspection });
      if (!inspection.available) throw storeError(409, inspection.reason);

      const oldBaseCommit = record.baseCommit;
      const sourceCommit = inspection.sourceCommit;
      const worktreePath = record.worktreePath;
      const oldHead = inspection.currentCommit;
      const mergeBranch = Boolean(inspection.committedChanges && inspection.currentBranch);
      const state = await this.collectUncommittedState(worktreePath);
      const statePaths = [
        ...await this.listUntracked(worktreePath),
        ...await this.listIncludedIgnored(worktreePath),
      ];
      const files = await describeStateFiles(worktreePath, [...new Set(statePaths)], {
        maxEntries: this.maxCopyEntries,
        maxBytes: this.maxCopyBytes,
      });
      if (files.length !== new Set(statePaths).size) {
        throw storeError(409, "Worktree 包含暂不支持自动同步的符号链接或特殊文件，请先手动处理");
      }
      const mergeHead = await this.git(worktreePath, [
        "rev-parse", "--verify", "-q", "MERGE_HEAD",
      ], { allowFailure: true });
      if (mergeHead.ok) throw storeError(409, "Worktree 正在解决合并冲突，请先完成或撤销当前合并");
      const syncBackup = path.join(
        this.handoffDirectory,
        record.id,
        `sync-${crypto.randomUUID()}`,
      );
      await ensurePrivateDirectory(syncBackup);
      let mergeAttempted = false;
      let mutationStarted = false;
      try {
        await fs.writeFile(path.join(syncBackup, "changes.patch"), state.patch, { mode: 0o600 });
        await copyRelativeFiles(
          worktreePath,
          path.join(syncBackup, "files"),
          files.map((entry) => entry.path),
          {
            maxEntries: this.maxCopyEntries,
            maxBytes: this.maxCopyBytes,
            skipSymlinks: false,
          },
        );

        mutationStarted = true;
        await this.git(worktreePath, ["reset", "--hard", oldHead]);
        await removeStateFiles(worktreePath, files);
        if (mergeBranch) {
          mergeAttempted = true;
          await this.git(worktreePath, ["merge", "--no-edit", sourceCommit]);
        } else {
          await this.git(worktreePath, ["reset", "--hard", sourceCommit]);
        }
        if (state.patch.length) {
          await this.git(worktreePath, ["apply", "--check", "--whitespace=nowarn", "-"], {
            input: state.patch,
          });
          await this.git(worktreePath, ["apply", "--whitespace=nowarn", "-"], {
            input: state.patch,
          });
        }
        await assertStateTargetsAvailable(worktreePath, files);
        await copyRelativeFiles(
          path.join(syncBackup, "files"),
          worktreePath,
          files.map((entry) => entry.path),
          {
            uid: this.uid,
            gid: this.gid,
            maxEntries: this.maxCopyEntries,
            maxBytes: this.maxCopyBytes,
            skipSymlinks: false,
            noOverwrite: true,
          },
        );

        const verified = await this.collectUncommittedState(worktreePath);
        if (verified.fingerprint !== state.fingerprint) {
          throw storeError(409, "同步后的未提交修改校验不一致，已准备回滚");
        }
        const previousSnapshot = record.snapshot;
        const previousHandoff = record.handoff;
        const previousLastUsedAt = record.lastUsedAt;
        let metadataPersisted = false;
        record.baseCommit = sourceCommit;
        record.snapshot = null;
        record.handoff = null;
        record.lastUsedAt = this.now();
        try {
          if (previousSnapshot) {
            await this.snapshotUnlocked(record);
          } else {
            await this.persist();
          }
          metadataPersisted = true;
          if (previousHandoff) {
            await fs.rm(path.join(this.handoffDirectory, record.id), { recursive: true, force: true });
          }
        } catch (error) {
          record.baseCommit = oldBaseCommit;
          record.snapshot = previousSnapshot;
          record.handoff = previousHandoff;
          record.lastUsedAt = previousLastUsedAt;
          if (metadataPersisted) await this.persist().catch(() => {});
          throw error;
        }
        return publicRecord(record, { sync: await this.inspectSyncRecord(record) });
      } catch (error) {
        if (!mutationStarted) throw error;
        if (mergeAttempted) {
          await this.git(worktreePath, ["merge", "--abort"], { allowFailure: true }).catch(() => {});
        }
        const rollback = await this.restoreUncommittedState(
          worktreePath,
          mergeBranch ? oldHead : oldBaseCommit,
          state,
          files,
          syncBackup,
        ).catch((restoreError) => restoreError);
        if (rollback instanceof Error) {
          throw storeError(500, `同步失败，且自动恢复 Worktree 失败：${rollback.message}`);
        }
        throw error;
      } finally {
        await fs.rm(syncBackup, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  async handoff(id, target) {
    return this.queue(async () => {
      const record = this.requiredReadyRecord(id);
      const nextLocation = normalizeHandoffTarget(target);
      if (record.location === nextLocation) return publicRecord(record);
      if (!["worktree", "local"].includes(record.location)) {
        throw storeError(409, "Codex Worktree 当前不在可交接的位置");
      }
      const sourceRoot = record.location === "worktree" ? record.worktreePath : record.repositoryRoot;
      const destinationRoot = nextLocation === "worktree" ? record.worktreePath : record.repositoryRoot;
      const [sourceState, destinationState] = await Promise.all([
        this.collectWorkingState(sourceRoot, record.baseCommit),
        this.collectWorkingState(destinationRoot, record.baseCommit),
      ]);
      let baseline = await this.readHandoffGeneration(record);
      if (!baseline) {
        if (sourceState.fingerprint !== destinationState.fingerprint) {
          throw storeError(409, "首次交接前 Local 与 Worktree 已经不同，无法安全建立同步基线");
        }
        record.handoff = await this.writeHandoffGeneration(record, sourceRoot, sourceState);
        baseline = await this.readHandoffGeneration(record);
      }
      if (destinationState.fingerprint !== baseline.manifest.fingerprint) {
        throw storeError(
          409,
          nextLocation === "local"
            ? "Local 在上次同步后已有其他修改，请先提交、暂存到其他位置或恢复后再交接"
            : "Worktree 在上次同步后已有其他修改，请先保存快照并处理差异后再交接",
        );
      }
      const nextHandoff = await this.writeHandoffGeneration(record, sourceRoot, sourceState);
      const nextSnapshot = await this.readHandoffGeneration(record, nextHandoff);
      const previousLocation = record.location;
      const previousHandoff = record.handoff;
      let synchronized = false;
      try {
        if (sourceState.fingerprint !== destinationState.fingerprint) {
          await this.synchronizeWorkingState({
            record,
            destinationRoot,
            baseline,
            nextSnapshot,
          });
          synchronized = true;
        }
        record.location = nextLocation;
        record.handoff = nextHandoff;
        record.lastUsedAt = this.now();
        await this.persist();
      } catch (error) {
        record.location = previousLocation;
        record.handoff = previousHandoff;
        if (synchronized) {
          await this.restoreHandoffBaseline({
            record,
            destinationRoot,
            currentSnapshot: nextSnapshot,
            baseline,
          }).catch(() => {});
        }
        await fs.rm(this.handoffGenerationPath(record, nextHandoff), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await this.pruneHandoffGenerations(record).catch(() => {});
      return publicRecord(record);
    });
  }

  // Publish a confirmed Worktree state into the repository checkout while
  // keeping the record bound to the Worktree. This is deliberately separate
  // from handoff("local"): the rescue window must remain rooted in its
  // independent Worktree after a merge, otherwise the next request could
  // silently start editing the main checkout.
  async publishToLocal(id) {
    return this.queue(async () => {
      const record = this.requiredReadyRecord(id);
      if (record.location !== "worktree") {
        throw storeError(409, "主站维护 Worktree 当前不在备用 Worktree 位置");
      }
      const sourceRoot = record.worktreePath;
      const destinationRoot = record.repositoryRoot;
      const [sourceState, destinationState] = await Promise.all([
        this.collectWorkingState(sourceRoot, record.baseCommit),
        this.collectWorkingState(destinationRoot, record.baseCommit),
      ]);
      let baseline = await this.readHandoffGeneration(record);
      if (!baseline) {
        if (sourceState.fingerprint !== destinationState.fingerprint) {
          throw storeError(409, "首次合并前主站 Local 与 Worktree 已经不同，无法安全建立同步基线");
        }
        record.handoff = await this.writeHandoffGeneration(record, sourceRoot, sourceState);
        baseline = await this.readHandoffGeneration(record);
      }
      if (destinationState.fingerprint !== baseline.manifest.fingerprint) {
        throw storeError(409, "主站源码在上次同步后已有其他修改，请先保留或处理现有修改后再合并");
      }

      const nextHandoff = await this.writeHandoffGeneration(record, sourceRoot, sourceState);
      const nextSnapshot = await this.readHandoffGeneration(record, nextHandoff);
      const previousHandoff = record.handoff;
      let synchronized = false;
      try {
        if (sourceState.fingerprint !== destinationState.fingerprint) {
          await this.synchronizeWorkingState({
            record,
            destinationRoot,
            baseline,
            nextSnapshot,
          });
          synchronized = true;
        }
        // Keep location="worktree" and only advance the handoff baseline
        // after the destination was verified. A failed persist must not leave
        // the binding pointing at a state whose source is unknown.
        record.handoff = nextHandoff;
        record.lastUsedAt = this.now();
        await this.persist();
      } catch (error) {
        record.handoff = previousHandoff;
        if (synchronized) {
          await this.restoreHandoffBaseline({
            record,
            destinationRoot,
            currentSnapshot: nextSnapshot,
            baseline,
          }).catch(() => {});
        }
        await fs.rm(this.handoffGenerationPath(record, nextHandoff), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await this.pruneHandoffGenerations(record).catch(() => {});
      return publicRecord(record);
    });
  }

  async snapshot(id) {
    return this.queue(() => {
      const record = this.requiredReadyRecord(id);
      if (record.location !== "worktree") {
        throw storeError(409, "请先把对话交接回 Worktree，再保存 Worktree 快照");
      }
      return this.snapshotUnlocked(record);
    });
  }

  async restore(id) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      if (!record.snapshot) throw storeError(409, "这个 Worktree 没有可恢复快照");
      if (await pathExists(record.worktreePath)) {
        if (!await this.isManagedWorktree(record)) {
          throw storeError(409, "Worktree 目录已被替换，不是可恢复的 Git Worktree；请先移走该目录后重试");
        }
        record.state = "ready";
        record.location = "worktree";
        record.lastUsedAt = this.now();
        await this.persist();
        return publicRecord(record);
      }
      const snapshotRoot = this.snapshotPath(record);
      const manifest = await readSnapshotManifest(snapshotRoot, record);
      await this.git(record.repositoryRoot, ["worktree", "prune"], { allowFailure: true });
      try {
        await this.git(record.repositoryRoot, [
          "worktree", "add", "--detach", record.worktreePath, manifest.baseCommit,
        ], { timeoutMs: 120_000 });
        const patchPath = path.join(snapshotRoot, "changes.patch");
        const patch = await fs.readFile(patchPath);
        if (patch.length) {
          await this.git(record.worktreePath, ["apply", "--whitespace=nowarn", "-"], {
            input: patch,
            timeoutMs: 120_000,
          });
        }
        await copySnapshotFiles(path.join(snapshotRoot, "files"), record.worktreePath, {
          uid: this.uid,
          gid: this.gid,
          maxEntries: this.maxCopyEntries,
          maxBytes: this.maxCopyBytes,
        });
      } catch (error) {
        await this.git(record.repositoryRoot, ["worktree", "remove", "--force", record.worktreePath], {
          allowFailure: true,
        }).catch(() => {});
        await fs.rm(record.worktreePath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      record.state = "ready";
      record.location = "worktree";
      record.lastUsedAt = this.now();
      await this.persist();
      return publicRecord(record);
    });
  }

  async remove(id, { snapshot = true, deleteBranch = false } = {}) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      if (record.state === "deleted") return publicRecord(record);
      if (record.location === "local") {
        throw storeError(409, "对话当前在 Local，交接回 Worktree 后才能清理后台工作区");
      }
      if (!snapshot && record.threadId) {
        throw storeError(409, "已绑定对话的 Worktree 必须保留恢复快照，不能直接丢弃");
      }
      if (deleteBranch && record.threadId) {
        throw storeError(409, "请先把对话重新绑定到其他 Worktree，再删除这个 Git 分支");
      }
      const branchToDelete = deleteBranch ? record.branch : null;
      if (deleteBranch && !branchToDelete) {
        throw storeError(409, "这个 Worktree 当前没有可删除的 Git 分支");
      }
      if (branchToDelete) {
        const branchRef = `refs/heads/${branchToDelete}`;
        const branchOidResult = await this.git(record.repositoryRoot, [
          "rev-parse", "--verify", `${branchRef}^{commit}`,
        ], { allowFailure: true });
        if (!branchOidResult.ok) {
          throw storeError(409, "这个 Git 分支已经不存在，请刷新 Worktree 列表后重试");
        }
        const mergeTargetResult = await this.git(record.repositoryRoot, [
          "rev-parse", "--verify", `${record.baseRef}^{commit}`,
        ], { allowFailure: true });
        if (!mergeTargetResult.ok) {
          throw storeError(409, "无法确认这个 Git 分支是否已合并，请先保留分支并检查基准分支");
        }
        const safeToDelete = await this.git(record.repositoryRoot, [
          "merge-base", "--is-ancestor", branchRef, mergeTargetResult.stdout.trim(),
        ], { allowFailure: true });
        if (!safeToDelete.ok) {
          throw storeError(409, "这个 Git 分支包含尚未合并的提交，请先合并或保留分支");
        }
      }
      const branchOid = branchToDelete
        ? (await this.git(record.repositoryRoot, ["rev-parse", "--verify", `refs/heads/${branchToDelete}^{commit}`])).stdout.trim()
        : null;
      if (snapshot && await pathExists(record.worktreePath)) await this.snapshotUnlocked(record);
      const removedWorktree = await this.git(record.repositoryRoot, ["worktree", "remove", "--force", record.worktreePath], {
        allowFailure: true,
        timeoutMs: 60_000,
      });
      if (!removedWorktree.ok) {
        await this.git(record.repositoryRoot, ["worktree", "prune"], {
          allowFailure: true,
          timeoutMs: 30_000,
        });
        if (await this.isRegisteredWorktree(record.repositoryRoot, record.worktreePath)) {
          throw storeError(409, "Git 仍在使用这个 Worktree，暂未清理；请先完成正在进行的 Git 操作");
        }
      }
      await fs.rm(record.worktreePath, { recursive: true, force: true }).catch(() => {});
      if (!snapshot) {
        await fs.rm(this.snapshotPath(record), { recursive: true, force: true });
        await fs.rm(path.join(this.handoffDirectory, record.id), { recursive: true, force: true });
        record.snapshot = null;
        record.handoff = null;
      }
      record.state = record.snapshot ? "restorable" : "deleted";
      record.location = "none";
      record.lastUsedAt = this.now();
      if (branchToDelete) {
        const deletedBranch = await this.git(record.repositoryRoot, ["branch", "-D", branchToDelete], {
          allowFailure: true,
          timeoutMs: 60_000,
        });
        if (!deletedBranch.ok) {
          await this.persist().catch(() => {});
          throw storeError(
            409,
            removedWorktree.ok
              ? "Worktree 已清理，但 Git 分支仍被其他 Worktree 使用，因此分支未删除"
              : "Worktree 目录已清理，但 Git 分支未删除；请先执行 git worktree prune",
          );
        }
        record.branch = null;
        try {
          await this.persist();
        } catch (error) {
          await this.git(record.repositoryRoot, ["branch", branchToDelete, branchOid], {
            allowFailure: true,
          }).catch(() => {});
          record.branch = branchToDelete;
          await this.persist().catch(() => {});
          throw error;
        }
        return publicRecord(record);
      }
      await this.persist();
      return publicRecord(record);
    });
  }

  async purge(id, { deleteBranch = false } = {}) {
    return this.queue(async () => {
      const record = this.requiredRecord(id);
      if (record.state === "ready" || record.location === "worktree") {
        throw storeError(409, "请先使用普通删除清理 Worktree 目录，再执行彻底删除");
      }
      if (record.location === "local") {
        throw storeError(409, "对话当前在 Local，请先交接回 Worktree 后再彻底删除");
      }
      if (record.binding) {
        throw storeError(409, "这个 Worktree 是固定绑定目标，不能彻底删除");
      }
      if (await pathExists(record.worktreePath)) {
        throw storeError(409, "Worktree 目录仍存在，请先刷新状态并完成普通删除");
      }

      const branchToDelete = deleteBranch ? record.branch : null;
      let branchOid = null;
      if (branchToDelete) {
        const branchOidResult = await this.git(record.repositoryRoot, [
          "rev-parse", "--verify", `refs/heads/${branchToDelete}^{commit}`,
        ], { allowFailure: true });
        if (!branchOidResult.ok) throw storeError(409, "这个 Git 分支已经不存在，请刷新 Worktree 列表后重试");
        branchOid = branchOidResult.stdout.trim();
        const mergeTargetResult = await this.git(record.repositoryRoot, [
          "rev-parse", "--verify", `${record.baseRef}^{commit}`,
        ], { allowFailure: true });
        if (!mergeTargetResult.ok) throw storeError(409, "无法确认这个 Git 分支是否已合并，请先保留分支并检查基准分支");
        const safeToDelete = await this.git(record.repositoryRoot, [
          "merge-base", "--is-ancestor", `refs/heads/${branchToDelete}`, mergeTargetResult.stdout.trim(),
        ], { allowFailure: true });
        if (!safeToDelete.ok) throw storeError(409, "这个 Git 分支包含尚未合并的提交，请先合并或保留分支");
      }

      const unboundThreadId = record.threadId;
      const previousThreadId = record.threadId;
      const previousAliases = new Map(this.threadAliases);
      const previousDetachedThreads = new Map(this.detachedThreads);
      if (unboundThreadId) {
        record.threadId = null;
        for (const [from, to] of this.threadAliases) {
          if (from === unboundThreadId || to === unboundThreadId) this.threadAliases.delete(from);
        }
        this.detachedThreads.set(unboundThreadId, {
          projectPath: record.projectPath,
          label: record.label || "Worktree 对话",
          detachedAt: this.now(),
        });
        this.trimDetachedThreads();
      }

      const purgeDirectory = path.join(
        this.stateDirectory,
        `.codex-worktree-purge-${record.id}-${crypto.randomUUID()}`,
      );
      await ensurePrivateDirectory(purgeDirectory);
      const moved = [];
      const moveForPurge = async (source, name) => {
        if (!await pathExists(source)) return;
        const target = path.join(purgeDirectory, name);
        await fs.rename(source, target);
        moved.push({ source, target });
      };
      const restoreMoved = async () => {
        for (const entry of [...moved].reverse()) {
          if (await pathExists(entry.target)) await fs.rename(entry.target, entry.source);
        }
      };
      let branchDeleted = false;
      try {
        await moveForPurge(this.snapshotPath(record), "snapshot");
        await moveForPurge(path.join(this.handoffDirectory, record.id), "handoff");
        if (branchToDelete) {
          const deleted = await this.git(record.repositoryRoot, ["branch", "-D", branchToDelete], {
            allowFailure: true,
            timeoutMs: 60_000,
          });
          if (!deleted.ok) throw storeError(409, "恢复快照已暂存，但 Git 分支未删除，请稍后重试");
          branchDeleted = true;
        }
        this.records.delete(record.id);
        try {
          await this.persist();
        } catch (error) {
          this.records.set(record.id, record);
          record.threadId = previousThreadId;
          this.threadAliases = previousAliases;
          this.detachedThreads = previousDetachedThreads;
          if (branchDeleted) {
            await this.git(record.repositoryRoot, ["branch", branchToDelete, branchOid], { allowFailure: true });
            branchDeleted = false;
          }
          await restoreMoved();
          throw error;
        }
        await fs.rm(purgeDirectory, { recursive: true, force: true }).catch(() => {});
        return {
          id: record.id,
          purged: true,
          branchDeleted,
          unboundThreadId: unboundThreadId || null,
          projectPath: record.projectPath,
          label: record.label || "Worktree 对话",
        };
      } catch (error) {
        if (!this.records.has(record.id)) this.records.set(record.id, record);
        record.threadId = previousThreadId;
        this.threadAliases = previousAliases;
        this.detachedThreads = previousDetachedThreads;
        if (branchDeleted) {
          await this.git(record.repositoryRoot, ["branch", branchToDelete, branchOid], { allowFailure: true });
        }
        await restoreMoved().catch(() => {});
        await fs.rm(purgeDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async authorizeDirectory(candidate) {
    this.assertInitialized();
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
    const absolute = path.resolve(candidate);
    for (const record of this.records.values()) {
      if (
        record.state !== "ready"
        || record.location !== "worktree"
        || !isPathInside(record.worktreePath, absolute)
      ) continue;
      try {
        const [rootReal, candidateReal, stat] = await Promise.all([
          fs.realpath(record.worktreePath),
          fs.realpath(absolute),
          fs.lstat(absolute),
        ]);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathInside(rootReal, candidateReal)) return null;
        record.lastUsedAt = this.now();
        return { record: publicRecord(record), realPath: candidateReal };
      } catch {
        return null;
      }
    }
    return null;
  }

  async usage() {
    this.assertInitialized();
    let bytes = 0;
    let entries = 0;
    for (const record of this.records.values()) {
      for (const directory of [
        record.state === "ready" ? record.worktreePath : null,
        record.snapshot ? this.snapshotPath(record) : null,
        record.handoff ? this.handoffGenerationPath(record) : null,
      ].filter(Boolean)) {
        const measured = await measureTree(directory, {
          maxEntries: 200_000,
          tolerateMissing: true,
        });
        bytes += measured.bytes;
        entries += measured.entries;
      }
    }
    return {
      count: [...this.records.values()].filter((record) => record.state === "ready").length,
      restorableCount: [...this.records.values()].filter((record) => record.state === "restorable").length,
      bytes,
      entries,
      maxManaged: this.maxManaged,
    };
  }

  summary() {
    this.assertInitialized();
    const records = [...this.records.values()];
    return {
      ready: records.filter((record) => record.state === "ready").length,
      restorable: records.filter((record) => record.state === "restorable").length,
      activeInLocal: records.filter((record) => record.state === "ready" && record.location === "local").length,
      activeInWorktree: records.filter((record) => record.state === "ready" && record.location === "worktree").length,
      pinned: records.filter((record) => record.pinned).length,
      permanent: records.filter((record) => record.permanent).length,
      estimatedBytes: records.reduce((total, record) => (
        total
        + record.copiedBytes
        + Number(record.snapshot?.patchBytes || 0)
        + Number(record.snapshot?.fileBytes || 0)
        + Number(record.handoff?.patchBytes || 0)
        + Number(record.handoff?.fileBytes || 0)
      ), 0),
      maxManaged: this.maxManaged,
    };
  }

  async cleanupExpired({ preserveId = null } = {}) {
    this.assertInitialized();
    const now = this.now();
    const candidates = [...this.records.values()]
      .filter((record) => (
        record.id !== preserveId
        && record.state === "ready"
        && !record.permanent
        && !record.pinned
        && !record.threadId
        && record.lastUsedAt + this.expiresAfterMs <= now
      ))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const removed = [];
    for (const record of candidates) {
      await this.snapshotUnlocked(record);
      await this.git(record.repositoryRoot, ["worktree", "remove", "--force", record.worktreePath], {
        allowFailure: true,
      });
      await fs.rm(record.worktreePath, { recursive: true, force: true }).catch(() => {});
      record.state = "restorable";
      record.location = "none";
      record.lastUsedAt = now;
      removed.push(record.id);
    }
    if (removed.length) await this.persist();
    return removed;
  }

  async cleanupForCapacity() {
    const candidate = [...this.records.values()]
      .filter((record) => (
        record.state === "ready"
        && !record.permanent
        && !record.pinned
        && !record.threadId
      ))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) return null;
    await this.snapshotUnlocked(candidate);
    await this.git(candidate.repositoryRoot, ["worktree", "remove", "--force", candidate.worktreePath], {
      allowFailure: true,
    });
    await fs.rm(candidate.worktreePath, { recursive: true, force: true }).catch(() => {});
    candidate.state = "restorable";
    candidate.location = "none";
    candidate.lastUsedAt = this.now();
    await this.persist();
    return candidate.id;
  }

  async reconcile() {
    let changed = false;
    for (const record of this.records.values()) {
      const exists = await pathExists(record.worktreePath);
      const valid = exists && await this.isManagedWorktree(record);
      if (record.state === "ready" && !valid) {
        record.state = record.snapshot ? "restorable" : "missing";
        record.location = "none";
        changed = true;
      } else if (record.state !== "ready" && record.state !== "deleted" && valid) {
        record.state = "ready";
        record.location = "worktree";
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async isManagedWorktree(record) {
    if (!record?.worktreePath || !await pathExists(record.worktreePath)) return false;
    try {
      const [rootReal, worktreeReal, stat] = await Promise.all([
        fs.realpath(this.rootDirectory),
        fs.realpath(record.worktreePath),
        fs.lstat(record.worktreePath),
      ]);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathInside(rootReal, worktreeReal)) {
        return false;
      }
      const topLevel = await this.git(record.worktreePath, ["rev-parse", "--show-toplevel"], {
        allowFailure: true,
      });
      return topLevel.ok && path.resolve(topLevel.stdout.trim()) === worktreeReal;
    } catch {
      return false;
    }
  }

  async isRegisteredWorktree(repositoryRoot, worktreePath) {
    const result = await this.git(repositoryRoot, ["worktree", "list", "--porcelain"], {
      allowFailure: true,
    });
    if (!result.ok) return true;
    const target = path.resolve(worktreePath);
    return String(result.stdout).split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some((line) => path.resolve(line.slice("worktree ".length).trim()) === target);
  }

  async snapshotUnlocked(record) {
    if (!await pathExists(record.worktreePath)) throw storeError(404, "Worktree 目录不存在");
    const snapshotRoot = this.snapshotPath(record);
    const temporary = `${snapshotRoot}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.rm(temporary, { recursive: true, force: true });
    await ensurePrivateDirectory(temporary);
    const patch = await this.git(record.worktreePath, ["diff", "--binary", record.baseCommit, "--"], {
      binary: true,
    });
    await fs.writeFile(path.join(temporary, "changes.patch"), patch.stdout, { mode: 0o600 });
    const files = [...new Set([
      ...await this.listUntracked(record.worktreePath),
      ...await this.listIncludedIgnored(record.worktreePath),
    ])];
    const copied = await copyRelativeFiles(record.worktreePath, path.join(temporary, "files"), files, {
      uid: null,
      gid: null,
      maxEntries: this.maxCopyEntries,
      maxBytes: this.maxCopyBytes,
      skipSymlinks: true,
    });
    const now = this.now();
    const manifest = {
      version: 1,
      id: record.id,
      baseCommit: record.baseCommit,
      patchSha256: crypto.createHash("sha256").update(patch.stdout).digest("hex"),
      patchBytes: patch.stdout.length,
      files: copied.entries,
      fileBytes: copied.bytes,
      createdAt: now,
    };
    await fs.writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rm(snapshotRoot, { recursive: true, force: true });
    await fs.rename(temporary, snapshotRoot);
    await fs.chmod(snapshotRoot, 0o700);
    record.snapshot = {
      createdAt: now,
      patchBytes: patch.stdout.length,
      fileBytes: copied.bytes,
      files: copied.entries,
    };
    record.lastUsedAt = now;
    await this.persist();
    return publicRecord(record);
  }

  async collectWorkingState(repositoryRoot, baseCommit) {
    const head = (await this.git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== baseCommit) {
      throw storeError(
        409,
        "Worktree 交接暂不覆盖已产生新提交的工作区；请先保留正式分支，再从目标位置继续",
      );
    }
    const patch = (await this.git(repositoryRoot, ["diff", "--binary", baseCommit, "--"], {
      binary: true,
    })).stdout;
    const paths = [...new Set([
      ...await this.listUntracked(repositoryRoot),
      ...await this.listIncludedIgnored(repositoryRoot),
    ])].filter(isPortableWorktreePath);
    const files = await describeStateFiles(repositoryRoot, paths, {
      maxEntries: this.maxCopyEntries,
      maxBytes: this.maxCopyBytes,
    });
    return {
      head,
      patch,
      patchSha256: crypto.createHash("sha256").update(patch).digest("hex"),
      patchBytes: patch.length,
      files,
      fileBytes: files.reduce((total, entry) => total + entry.size, 0),
      fingerprint: workingStateFingerprint(patch, files),
    };
  }

  async collectUncommittedState(repositoryRoot) {
    const patch = (await this.git(repositoryRoot, ["diff", "--binary", "HEAD", "--"], {
      binary: true,
    })).stdout;
    const paths = [...new Set([
      ...await this.listUntracked(repositoryRoot),
      ...await this.listIncludedIgnored(repositoryRoot),
    ])].filter(isPortableWorktreePath);
    const files = await describeStateFiles(repositoryRoot, paths, {
      maxEntries: this.maxCopyEntries,
      maxBytes: this.maxCopyBytes,
    });
    return {
      patch,
      files,
      patchSha256: crypto.createHash("sha256").update(patch).digest("hex"),
      patchBytes: patch.length,
      fileBytes: files.reduce((total, entry) => total + entry.size, 0),
      fingerprint: workingStateFingerprint(patch, files),
    };
  }

  async restoreUncommittedState(repositoryRoot, baseCommit, state, files, backupRoot) {
    await this.git(repositoryRoot, ["reset", "--hard", baseCommit]);
    await removeStateFiles(repositoryRoot, files);
    if (state.patch.length) {
      await this.git(repositoryRoot, ["apply", "--check", "--whitespace=nowarn", "-"], {
        input: state.patch,
      });
      await this.git(repositoryRoot, ["apply", "--whitespace=nowarn", "-"], {
        input: state.patch,
      });
    }
    await assertStateTargetsAvailable(repositoryRoot, files);
    await copyRelativeFiles(
      path.join(backupRoot, "files"),
      repositoryRoot,
      files.map((entry) => entry.path),
      {
        uid: this.uid,
        gid: this.gid,
        maxEntries: this.maxCopyEntries,
        maxBytes: this.maxCopyBytes,
        skipSymlinks: false,
        noOverwrite: true,
      },
    );
    const restored = await this.collectUncommittedState(repositoryRoot);
    if (restored.fingerprint !== state.fingerprint) {
      throw storeError(500, "Worktree 原有修改恢复后的校验不一致");
    }
  }

  async writeHandoffGeneration(record, sourceRoot, state) {
    const generation = `hs_${crypto.randomUUID()}`;
    const generationPath = path.join(this.handoffDirectory, record.id, generation);
    await ensurePrivateDirectory(generationPath);
    try {
      await fs.writeFile(path.join(generationPath, "changes.patch"), state.patch, { mode: 0o600 });
      await copyRelativeFiles(
        sourceRoot,
        path.join(generationPath, "files"),
        state.files.map((entry) => entry.path),
        {
          maxEntries: this.maxCopyEntries,
          maxBytes: this.maxCopyBytes,
          skipSymlinks: true,
        },
      );
      const createdAt = this.now();
      const manifest = {
        version: 1,
        id: record.id,
        generation,
        baseCommit: record.baseCommit,
        fingerprint: state.fingerprint,
        patchSha256: state.patchSha256,
        patchBytes: state.patchBytes,
        fileBytes: state.fileBytes,
        files: state.files,
        createdAt,
      };
      await fs.writeFile(path.join(generationPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      return {
        generation,
        fingerprint: state.fingerprint,
        patchBytes: state.patchBytes,
        fileBytes: state.fileBytes,
        files: state.files.length,
        createdAt,
      };
    } catch (error) {
      await fs.rm(generationPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async readHandoffGeneration(record, handoff = record.handoff) {
    if (!handoff) return null;
    const generationPath = this.handoffGenerationPath(record, handoff);
    let manifest;
    let patch;
    try {
      [manifest, patch] = await Promise.all([
        fs.readFile(path.join(generationPath, "manifest.json"), "utf8").then(JSON.parse),
        fs.readFile(path.join(generationPath, "changes.patch")),
      ]);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const files = normalizeStateFileManifest(manifest?.files);
    const patchSha256 = crypto.createHash("sha256").update(patch).digest("hex");
    if (
      manifest?.version !== 1
      || manifest.id !== record.id
      || manifest.generation !== handoff.generation
      || manifest.baseCommit !== record.baseCommit
      || manifest.fingerprint !== handoff.fingerprint
      || patchSha256 !== manifest.patchSha256
      || workingStateFingerprint(patch, files) !== manifest.fingerprint
    ) {
      throw storeError(409, "Worktree 交接基线校验失败");
    }
    await verifyStateFiles(path.join(generationPath, "files"), files);
    return {
      path: generationPath,
      patch,
      manifest: { ...manifest, files },
    };
  }

  async synchronizeWorkingState({ record, destinationRoot, baseline, nextSnapshot }) {
    await this.transitionWorkingState(destinationRoot, baseline, nextSnapshot);
    const result = await this.collectWorkingState(destinationRoot, record.baseCommit);
    if (result.fingerprint !== nextSnapshot.manifest.fingerprint) {
      await this.transitionWorkingState(destinationRoot, nextSnapshot, baseline).catch(() => {});
      throw storeError(409, "Worktree 交接后的文件校验不一致，已恢复原位置内容");
    }
  }

  async restoreHandoffBaseline({ destinationRoot, currentSnapshot, baseline }) {
    await this.transitionWorkingState(destinationRoot, currentSnapshot, baseline);
  }

  async transitionWorkingState(destinationRoot, fromSnapshot, toSnapshot) {
    const fromPatch = fromSnapshot.patch;
    const toPatch = toSnapshot.patch;
    const fromFiles = fromSnapshot.manifest.files;
    const toFiles = toSnapshot.manifest.files;
    let reversedFromPatch = false;
    let appliedToPatch = false;
    try {
      if (fromPatch.length) {
        await this.git(destinationRoot, ["apply", "--check", "--reverse", "-"], { input: fromPatch });
        await this.git(destinationRoot, ["apply", "--whitespace=nowarn", "--reverse", "-"], { input: fromPatch });
        reversedFromPatch = true;
      }
      await removeStateFiles(destinationRoot, fromFiles);
      if (toPatch.length) {
        await this.git(destinationRoot, ["apply", "--check", "-"], { input: toPatch });
        await this.git(destinationRoot, ["apply", "--whitespace=nowarn", "-"], { input: toPatch });
        appliedToPatch = true;
      }
      await assertStateTargetsAvailable(destinationRoot, toFiles);
      await copyRelativeFiles(
        path.join(toSnapshot.path, "files"),
        destinationRoot,
        toFiles.map((entry) => entry.path),
        {
          uid: this.uid,
          gid: this.gid,
          maxEntries: this.maxCopyEntries,
          maxBytes: this.maxCopyBytes,
          skipSymlinks: false,
          noOverwrite: true,
        },
      );
    } catch (error) {
      await removeStateFiles(destinationRoot, toFiles).catch(() => {});
      if (appliedToPatch && toPatch.length) {
        await this.git(destinationRoot, ["apply", "--whitespace=nowarn", "--reverse", "-"], {
          input: toPatch,
          allowFailure: true,
        }).catch(() => {});
      }
      if (reversedFromPatch && fromPatch.length) {
        await this.git(destinationRoot, ["apply", "--whitespace=nowarn", "-"], {
          input: fromPatch,
          allowFailure: true,
        }).catch(() => {});
      }
      await copyRelativeFiles(
        path.join(fromSnapshot.path, "files"),
        destinationRoot,
        fromFiles.map((entry) => entry.path),
        {
          uid: this.uid,
          gid: this.gid,
          maxEntries: this.maxCopyEntries,
          maxBytes: this.maxCopyBytes,
          skipSymlinks: false,
        },
      ).catch(() => {});
      throw error;
    }
  }

  handoffGenerationPath(record, handoff = record.handoff) {
    const generation = normalizeHandoffGeneration(handoff?.generation);
    return path.join(this.handoffDirectory, record.id, generation);
  }

  async pruneHandoffGenerations(record) {
    const root = path.join(this.handoffDirectory, record.id);
    const active = record.handoff?.generation;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === active) continue;
      if (!/^hs_[a-f0-9-]{36}$/.test(entry.name)) continue;
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  }

  async copyLocalFiles(repositoryRoot, worktreePath) {
    const [untracked, includedIgnored, dependencies] = await Promise.all([
      this.listUntracked(repositoryRoot),
      this.listIncludedIgnored(repositoryRoot),
      inspectDependencies(repositoryRoot),
    ]);
    const candidates = [...new Set([...untracked, ...includedIgnored])];
    const copied = await copyRelativeFiles(repositoryRoot, worktreePath, candidates, {
      uid: this.uid,
      gid: this.gid,
      maxEntries: this.maxCopyEntries,
      maxBytes: this.maxCopyBytes,
      skipSymlinks: true,
      noOverwrite: true,
    });
    return { ...copied, dependencies: dependencies.filter((entry) => !candidates.some((file) => file === entry || file.startsWith(`${entry}/`))) };
  }

  async copyAttachments(projectPath, worktreePath, attachments) {
    if (attachments == null) return [];
    if (!Array.isArray(attachments) || attachments.length > 8) {
      throw storeError(400, "Worktree 附件列表无效");
    }
    const projectReal = await fs.realpath(projectPath);
    const uploadRoot = path.join(worktreePath, ".codex-uploads");
    const copied = [];
    let totalBytes = 0;
    for (const [index, attachment] of attachments.entries()) {
      if (!attachment || typeof attachment !== "object" || typeof attachment.path !== "string") {
        throw storeError(400, "Worktree 附件路径无效");
      }
      const source = path.resolve(attachment.path);
      const [sourceReal, stat] = await Promise.all([
        fs.realpath(source),
        fs.lstat(source),
      ]);
      if (
        !isPathInside(projectReal, sourceReal)
        || stat.isSymbolicLink()
        || !stat.isFile()
        || stat.size > 20 * 1024 * 1024
      ) {
        throw storeError(403, "Worktree 附件不属于当前工程或超过安全上限");
      }
      totalBytes += stat.size;
      if (totalBytes > this.maxCopyBytes) throw storeError(413, "Worktree 附件超过复制上限");
      const targetName = `${String(index + 1).padStart(2, "0")}-${sanitizeAttachmentName(
        attachment.name || path.basename(source),
      )}`;
      const target = path.join(uploadRoot, targetName);
      await mkdirOwned(worktreePath, uploadRoot, this.uid, this.gid);
      await fs.copyFile(sourceReal, target);
      await fs.chmod(target, 0o600);
      if (Number.isInteger(this.uid) && Number.isInteger(this.gid)) {
        await fs.chown(target, this.uid, this.gid);
      }
      copied.push({
        name: sanitizeAttachmentName(attachment.name || path.basename(source)),
        path: target,
        size: stat.size,
        mediaType: normalizeAttachmentMediaType(attachment.mediaType),
      });
    }
    return copied;
  }

  async listUntracked(repositoryRoot) {
    const result = await this.git(repositoryRoot, ["ls-files", "-z", "--others", "--exclude-standard"], {
      binary: true,
    });
    return parseNulPaths(result.stdout).filter(isPortableWorktreePath);
  }

  async listIncludedIgnored(repositoryRoot) {
    const includePath = path.join(repositoryRoot, ".worktreeinclude");
    const included = [];
    if (await regularFileExists(includePath)) {
      const result = await this.git(repositoryRoot, [
      "ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude",
      ], { binary: true });
      included.push(...parseNulPaths(result.stdout));
    }
    const override = "AGENTS.override.md";
    if (await regularFileExists(path.join(repositoryRoot, override))) {
      const ignored = await this.git(repositoryRoot, ["check-ignore", "--quiet", "--", override], {
        allowFailure: true,
      });
      if (ignored.ok) included.push(override);
    }
    return [...new Set(included)].filter(isPortableWorktreePath);
  }

  async assertOwnedProject(projectPath) {
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
      throw storeError(400, "Worktree 工程路径无效");
    }
    const absolute = path.resolve(projectPath);
    const [rootReals, projectReal, stat] = await Promise.all([
      Promise.all(this.projectRoots.map((root) => fs.realpath(root))),
      fs.realpath(absolute),
      fs.lstat(absolute),
    ]);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || this.projectRoots.includes(absolute)
      || !rootReals.some((rootReal) => isPathInside(rootReal, projectReal))
    ) {
      throw storeError(403, "Worktree 只能从当前账号拥有的工程创建");
    }
    return projectReal;
  }

  async repositoryRoot(projectPath) {
    const result = await this.git(projectPath, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (!result.ok) throw storeError(409, "当前工程不是 Git 仓库");
    const root = path.resolve(result.stdout.trim());
    const projectRootReals = await Promise.all(this.projectRoots.map((entry) => fs.realpath(entry)));
    if (!projectRootReals.some((projectRootReal) => isPathInside(projectRootReal, root))) {
      throw storeError(403, "Git 仓库超出当前账号工程边界");
    }
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storeError(403, "Git 仓库根目录无效");
    return root;
  }

  async git(cwd, args, options = {}) {
    return runCommand("git", args, {
      cwd,
      uid: this.uid,
      gid: this.gid,
      home: this.home,
      ...options,
    });
  }

  snapshotPath(record) {
    return path.join(this.snapshotDirectory, record.id);
  }

  requiredRecord(id) {
    this.assertInitialized();
    const record = this.records.get(normalizeId(id));
    if (!record) throw storeError(404, "Codex Worktree 不存在");
    return record;
  }

  requiredReadyRecord(id) {
    const record = this.requiredRecord(id);
    if (record.state !== "ready") throw storeError(409, "Codex Worktree 当前不可用");
    return record;
  }

  async persist() {
    const content = `${JSON.stringify({
      version: STORE_VERSION,
      records: [...this.records.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt),
      threadAliases: Object.fromEntries(this.threadAliases),
      detachedThreads: Object.fromEntries(this.detachedThreads),
    }, null, 2)}\n`;
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  queue(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  trimThreadAliases() {
    while (this.threadAliases.size > MAX_THREAD_ALIASES) {
      this.threadAliases.delete(this.threadAliases.keys().next().value);
    }
  }

  trimDetachedThreads() {
    while (this.detachedThreads.size > MAX_DETACHED_THREADS) {
      this.detachedThreads.delete(this.detachedThreads.keys().next().value);
    }
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Codex Worktree store is not initialized");
  }
}

async function runCommand(command, args, {
  cwd,
  uid = null,
  gid = null,
  home,
  input = null,
  binary = false,
  allowFailure = false,
  timeoutMs = COMMAND_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      cwd,
      env: {
        PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: home,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (Number.isInteger(uid) && Number.isInteger(gid)) {
      options.uid = uid;
      options.gid = gid;
    }
    const child = spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT_BYTES) {
        child.kill("SIGKILL");
        finish(storeError(413, "Git 命令输出过大"));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout);
      const standardOutput = out.toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0 && !allowFailure) {
        const diagnostics = [errorOutput, standardOutput].filter(Boolean).join("\n");
        finish(storeError(409, cleanGitError(diagnostics || `git 退出：${code ?? signal}`)));
        return;
      }
      finish(null, {
        ok: code === 0,
        code,
        stdout: binary ? out : out.toString("utf8"),
        stderr: errorOutput,
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(storeError(504, "Git Worktree 操作超时"));
    }, boundedInteger(timeoutMs, 1_000, 10 * 60_000, COMMAND_TIMEOUT_MS));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function copyRelativeFiles(sourceRoot, targetRoot, files, {
  uid = null,
  gid = null,
  maxEntries,
  maxBytes,
  skipSymlinks = true,
  noOverwrite = false,
} = {}) {
  let entries = 0;
  let bytes = 0;
  let skippedSymlinks = 0;
  for (const raw of files) {
    const relative = validateGitRelativePath(raw);
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) {
      if (skipSymlinks) {
        skippedSymlinks += 1;
        continue;
      }
      throw storeError(403, "Worktree 文件不能包含符号链接");
    }
    if (!stat.isFile()) continue;
    entries += 1;
    bytes += stat.size;
    if (entries > maxEntries || bytes > maxBytes) {
      throw storeError(413, "要复制到 Worktree 的本地文件超过安全上限");
    }
    await mkdirOwned(targetRoot, path.dirname(target), uid, gid);
    if (noOverwrite && await pathExists(target)) continue;
    await fs.copyFile(source, target);
    await fs.chmod(target, stat.mode & 0o777);
    if (Number.isInteger(uid) && Number.isInteger(gid)) await fs.chown(target, uid, gid);
  }
  return { entries, bytes, skippedSymlinks };
}

async function describeStateFiles(root, files, { maxEntries, maxBytes }) {
  const result = [];
  let bytes = 0;
  for (const raw of files) {
    const relative = validateGitRelativePath(raw);
    if (!isPortableWorktreePath(relative)) continue;
    const candidate = path.join(root, relative);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isFile()) continue;
    bytes += stat.size;
    if (result.length + 1 > maxEntries || bytes > maxBytes) {
      throw storeError(413, "Worktree 交接文件超过安全上限");
    }
    result.push({
      path: relative,
      size: stat.size,
      mode: stat.mode & 0o777,
      sha256: await sha256File(candidate),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeStateFileManifest(value) {
  if (!Array.isArray(value)) throw storeError(409, "Worktree 交接文件清单无效");
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    const relative = validateGitRelativePath(entry?.path);
    const size = nonnegativeInteger(entry?.size);
    const mode = boundedInteger(entry?.mode, 0, 0o777, 0o600);
    const sha256 = String(entry?.sha256 || "");
    if (
      !isPortableWorktreePath(relative)
      || seen.has(relative)
      || !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw storeError(409, "Worktree 交接文件清单无效");
    }
    seen.add(relative);
    result.push({ path: relative, size, mode, sha256 });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyStateFiles(root, files) {
  for (const entry of files) {
    const candidate = path.join(root, entry.path);
    const stat = await fs.lstat(candidate);
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size !== entry.size
      || await sha256File(candidate) !== entry.sha256
    ) {
      throw storeError(409, "Worktree 交接文件快照校验失败");
    }
  }
}

async function assertStateTargetsAvailable(root, files) {
  for (const entry of files) {
    const candidate = path.join(root, entry.path);
    try {
      await fs.lstat(candidate);
      throw storeError(409, `Worktree 交接目标已存在：${entry.path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function removeStateFiles(root, files) {
  const absoluteRoot = path.resolve(root);
  for (const entry of [...files].sort((left, right) => right.path.length - left.path.length)) {
    const relative = validateGitRelativePath(entry.path);
    const candidate = path.join(absoluteRoot, relative);
    const resolved = path.resolve(candidate);
    if (!isPathInside(absoluteRoot, resolved) || resolved === absoluteRoot) {
      throw storeError(403, "Worktree 交接清理路径超出边界");
    }
    try {
      const stat = await fs.lstat(resolved);
      if (
        stat.isSymbolicLink()
        || !stat.isFile()
        || stat.size !== entry.size
        || await sha256File(resolved) !== entry.sha256
      ) {
        throw storeError(409, `Worktree 交接文件类型已变化：${relative}`);
      }
      await fs.unlink(resolved);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let directory = path.dirname(resolved);
    while (directory !== absoluteRoot && isPathInside(absoluteRoot, directory)) {
      try {
        await fs.rmdir(directory);
      } catch (error) {
        if (["ENOTEMPTY", "ENOENT"].includes(error.code)) break;
        throw error;
      }
      directory = path.dirname(directory);
    }
  }
}

async function sha256File(candidate) {
  const handle = await fs.open(candidate, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function workingStateFingerprint(patch, files) {
  const hash = crypto.createHash("sha256");
  hash.update(patch);
  hash.update("\0");
  for (const entry of files) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(String(entry.mode));
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copySnapshotFiles(sourceRoot, targetRoot, options) {
  if (!await pathExists(sourceRoot)) return { entries: 0, bytes: 0 };
  const files = [];
  const pending = [""];
  while (pending.length) {
    const relativeDirectory = pending.pop();
    const directory = path.join(sourceRoot, relativeDirectory);
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, dirent.name);
      if (dirent.isSymbolicLink()) throw storeError(403, "Worktree 快照包含符号链接");
      if (dirent.isDirectory()) pending.push(relative);
      else if (dirent.isFile()) files.push(relative);
    }
  }
  return copyRelativeFiles(sourceRoot, targetRoot, files, {
    ...options,
    skipSymlinks: false,
    noOverwrite: true,
  });
}

async function readSnapshotManifest(snapshotRoot, record) {
  const value = JSON.parse(await fs.readFile(path.join(snapshotRoot, "manifest.json"), "utf8"));
  if (
    value?.version !== 1
    || value.id !== record.id
    || value.baseCommit !== record.baseCommit
    || !/^[a-f0-9]{64}$/.test(value.patchSha256 || "")
  ) {
    throw storeError(409, "Worktree 快照元数据无效");
  }
  const patch = await fs.readFile(path.join(snapshotRoot, "changes.patch"));
  const digest = crypto.createHash("sha256").update(patch).digest("hex");
  if (digest !== value.patchSha256) throw storeError(409, "Worktree 快照校验失败");
  return value;
}

async function measureTree(root, { maxEntries, tolerateMissing = false } = {}) {
  let entries = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (tolerateMissing && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    entries += 1;
    if (entries > maxEntries) break;
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(current)) pending.push(path.join(current, name));
    } else if (stat.isFile()) {
      bytes += stat.size;
    }
  }
  return { entries, bytes };
}

async function inspectDependencies(repositoryRoot) {
  const dependencies = [];
  for (const name of DEPENDENCY_DIRECTORIES) {
    try {
      const stat = await fs.lstat(path.join(repositoryRoot, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) dependencies.push(name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return dependencies;
}

function publicRecord(record, { sync } = {}) {
  const result = {
    id: record.id,
    label: record.label,
    projectPath: record.projectPath,
    worktreePath: record.worktreePath,
    worktreeProjectPath: record.worktreeProjectPath,
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    branch: record.branch,
    threadId: record.threadId,
    location: record.location,
    permanent: record.permanent,
    pinned: record.pinned,
    state: record.state,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    copiedEntries: record.copiedEntries,
    copiedBytes: record.copiedBytes,
    skippedSymlinks: record.skippedSymlinks,
    binding: record.binding || null,
    excludedDependencies: [...record.excludedDependencies],
    snapshot: record.snapshot ? { ...record.snapshot } : null,
    handoffAvailable: Boolean(record.handoff),
    handoffUpdatedAt: record.handoff?.createdAt || null,
  };
  if (sync !== undefined) result.sync = sync;
  return result;
}

function autoAdvanceStatus(state, reason) {
  return {
    state,
    reason: typeof reason === "string" && reason ? reason : "无法确认来源分支是否可自动推进",
  };
}

function normalizeThreadAliases(value) {
  const aliases = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return aliases;
  for (const [from, to] of Object.entries(value).slice(-MAX_THREAD_ALIASES)) {
    try {
      const source = normalizeThreadId(from);
      const target = normalizeThreadId(to);
      if (source !== target) aliases.set(source, target);
    } catch {
      // Ignore malformed aliases while preserving valid Worktree records.
    }
  }
  return aliases;
}

function normalizeDetachedThreads(value) {
  const detached = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return detached;
  for (const [threadId, entry] of Object.entries(value).slice(-MAX_DETACHED_THREADS)) {
    try {
      const normalizedThreadId = normalizeThreadId(threadId);
      const projectPath = requiredPath(entry?.projectPath, "Detached project path");
      const label = typeof entry?.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, 200)
        : "Worktree 对话";
      const detachedAt = positiveTimestamp(entry?.detachedAt);
      detached.set(normalizedThreadId, { projectPath, label, detachedAt });
    } catch {
      // Ignore malformed detached conversation metadata while preserving records.
    }
  }
  return detached;
}

function normalizeStoredRecord(value, {
  rootDirectory,
  projectRoots,
  snapshotDirectory,
  handoffDirectory,
}) {
  try {
    if (value?.version !== STORE_VERSION) return null;
    const id = normalizeId(value.id);
    const projectPath = path.resolve(requiredPath(value.projectPath, "Project path"));
    const repositoryRoot = path.resolve(requiredPath(value.repositoryRoot, "Repository root"));
    const worktreePath = path.resolve(requiredPath(value.worktreePath, "Worktree path"));
    const projectRelativePath = path.relative(repositoryRoot, projectPath);
    const worktreeProjectPath = path.join(worktreePath, projectRelativePath);
    if (
      !projectRoots.some((root) => isPathInside(root, projectPath))
      || projectRoots.includes(projectPath)
      || !projectRoots.some((root) => isPathInside(root, repositoryRoot))
      || !isPathInside(repositoryRoot, projectPath)
      || !isPathInside(rootDirectory, worktreePath)
      || !isPathInside(worktreePath, worktreeProjectPath)
      || path.dirname(worktreePath) !== rootDirectory
      || path.basename(worktreePath) !== id
    ) return null;
    const baseCommit = String(value.baseCommit || "");
    assertCommit(baseCommit);
    const threadId = value.threadId == null ? null : normalizeThreadId(value.threadId);
    const state = ["ready", "restorable", "missing", "deleted"].includes(value.state) ? value.state : "missing";
    const snapshot = normalizeSnapshot(value.snapshot);
    const handoff = normalizeHandoff(value.handoff);
    if (snapshot && !isPathInside(snapshotDirectory, path.join(snapshotDirectory, id))) return null;
    if (
      handoff
      && !isPathInside(
        handoffDirectory,
        path.join(handoffDirectory, id, handoff.generation),
      )
    ) return null;
    return {
      version: STORE_VERSION,
      id,
      label: normalizeLabel(value.label),
      projectPath,
      repositoryRoot,
      worktreePath,
      projectRelativePath,
      worktreeProjectPath,
      baseRef: normalizeBaseRef(value.baseRef),
      baseCommit,
      branch: value.branch == null ? null : validateGitBranchName(value.branch),
      threadId,
      location: ["worktree", "local", "none"].includes(value.location) ? value.location : "none",
      permanent: value.permanent === true,
      pinned: value.pinned === true,
      binding: normalizeBinding(value.binding),
      state,
      createdAt: positiveTimestamp(value.createdAt),
      lastUsedAt: positiveTimestamp(value.lastUsedAt),
      copiedEntries: nonnegativeInteger(value.copiedEntries),
      copiedBytes: nonnegativeInteger(value.copiedBytes),
      skippedSymlinks: nonnegativeInteger(value.skippedSymlinks),
      excludedDependencies: Array.isArray(value.excludedDependencies)
        ? value.excludedDependencies.filter((entry) => DEPENDENCY_DIRECTORIES.includes(entry))
        : [],
      snapshot,
      handoff,
    };
  } catch {
    return null;
  }
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  return {
    createdAt: positiveTimestamp(value.createdAt),
    patchBytes: nonnegativeInteger(value.patchBytes),
    fileBytes: nonnegativeInteger(value.fileBytes),
    files: nonnegativeInteger(value.files),
  };
}

function normalizeHandoff(value) {
  if (!value || typeof value !== "object") return null;
  try {
    const fingerprint = String(value.fingerprint || "");
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
    return {
      generation: normalizeHandoffGeneration(value.generation),
      fingerprint,
      patchBytes: nonnegativeInteger(value.patchBytes),
      fileBytes: nonnegativeInteger(value.fileBytes),
      files: nonnegativeInteger(value.files),
      createdAt: positiveTimestamp(value.createdAt),
    };
  } catch {
    return null;
  }
}

function normalizeHandoffGeneration(value) {
  const generation = String(value || "");
  if (!/^hs_[a-f0-9-]{36}$/.test(generation)) {
    throw storeError(409, "Worktree 交接快照编号无效");
  }
  return generation;
}

function normalizeHandoffTarget(value) {
  if (!["local", "worktree"].includes(value)) throw storeError(400, "Worktree 交接目标无效");
  return value;
}

function parseBranchOutput(value) {
  const fields = String(value || "").split("\0");
  const result = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index]?.trim();
    const oid = fields[index + 1]?.trim();
    if (!name || !oid) continue;
    try {
      result.push({ name: validateGitBranchName(name), oid });
    } catch {
      // Ignore an unusual ref that the browser must not submit back.
    }
  }
  return result;
}

function parseNulPaths(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""));
  // `git ls-files --others` reports an untracked nested repository as a
  // directory marker with a trailing slash (for example `nested-repo/`).
  // It is not a copyable file path. Ignore that marker instead of rejecting
  // the whole project inspection as an invalid Git path.
  return buffer.toString("utf8").split("\0")
    .filter((entry) => entry && !entry.endsWith("/"))
    .map(validateGitRelativePath);
}

function normalizeId(value) {
  const id = String(value || "");
  if (!/^wt_[a-f0-9-]{36}$/.test(id)) throw storeError(400, "Codex Worktree ID 无效");
  return id;
}

function normalizeThreadId(value) {
  const threadId = String(value || "");
  if (!threadId || threadId.length > 256 || /[\u0000-\u001f]/.test(threadId)) {
    throw storeError(400, "Codex 对话 ID 无效");
  }
  return threadId;
}

function normalizeBaseRef(value) {
  const ref = typeof value === "string" ? value.trim() : "";
  if (ref === "HEAD") return ref;
  return validateGitBranchName(ref);
}

function normalizeLabel(value) {
  if (value == null || value === "") return null;
  const label = String(value).trim();
  if (!label || label.length > 120 || /[\u0000-\u001f]/.test(label)) {
    throw storeError(400, "Worktree 名称无效");
  }
  return label;
}

function normalizeBinding(value) {
  if (value == null || value === "") return null;
  const binding = String(value).trim();
  if (
    !binding
    || binding.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(binding)
  ) {
    throw storeError(400, "Worktree 绑定编号无效");
  }
  return binding;
}

function isPortableWorktreePath(value) {
  try {
    const relative = validateGitRelativePath(value);
    const first = relative.split("/")[0];
    return !PRIVATE_WORKTREE_PATHS.has(first);
  } catch {
    return false;
  }
}

function sanitizeAttachmentName(value) {
  const basename = path.basename(String(value || "attachment"))
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 200);
  return basename && basename !== "." && basename !== ".." ? basename : "attachment";
}

function normalizeAttachmentMediaType(value) {
  const mediaType = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function assertCommit(value) {
  if (!/^[a-f0-9]{40,64}$/i.test(value)) throw storeError(409, "Git 提交 ID 无效");
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  return value;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function positiveTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Invalid timestamp");
  return Math.round(number);
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensurePrivateDirectory(directory, uid = null, gid = null) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private directory is invalid");
  await fs.chmod(directory, 0o700);
  if (
    Number.isInteger(uid)
    && Number.isInteger(gid)
    && (stat.uid !== uid || stat.gid !== gid)
  ) {
    await fs.chown(directory, uid, gid);
  }
}

async function mkdirOwned(root, directory, uid, gid) {
  const resolvedRoot = path.resolve(root);
  await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storeError(403, "Worktree 目标根目录无效");
  }
  if (
    Number.isInteger(uid)
    && Number.isInteger(gid)
    && (rootStat.uid !== uid || rootStat.gid !== gid)
  ) {
    await fs.chown(resolvedRoot, uid, gid);
  }
  const relative = path.relative(resolvedRoot, path.resolve(directory));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw storeError(403, "Worktree 目标目录超出边界");
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError(403, "Worktree 目标目录包含无效路径");
    }
    if (
      Number.isInteger(uid)
      && Number.isInteger(gid)
      && (stat.uid !== uid || stat.gid !== gid)
    ) {
      await fs.chown(current, uid, gid);
    }
  }
}

async function regularFileExists(candidate) {
  try {
    const stat = await fs.lstat(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function cleanGitError(value) {
  return String(value || "Git Worktree 操作失败")
    .replace(/\b(?:https?|ssh):\/\/[^\s]+/gi, "[remote]")
    .replace(/(?:password|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi, "[redacted]")
    .slice(0, 2_000);
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
