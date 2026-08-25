import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const ENTRY_STEPS = new Set(["prepared", "old-moved", "new-active", "new-stashed", "old-active"]);
const GENERATIONS = new Set(["new", "old"]);
const PHASES = new Set([
  "prepared",
  "stopping",
  "swapping",
  "forward-complete",
  "starting",
  "verified",
  "recovering-new",
  "recovering-old",
  "recovered-new",
  "recovered-old",
]);

export class RestoreSwapJournal {
  constructor(runtimeDirectory, {
    now = () => Date.now(),
    afterRename = async () => {},
    isAllowedTarget = defaultAllowedTarget,
  } = {}) {
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.filePath = path.join(this.runtimeDirectory, "backup-restore-swap.json");
    this.now = now;
    this.afterRename = afterRename;
    this.isAllowedTarget = isAllowedTarget;
    this.value = null;
  }

  async create({ operationId, unit, backupId, ownerPid, ownerStartTicks, entries }) {
    if (await this.read()) throw journalError("已有未完成的数据恢复交换日志", "ERR_RESTORE_JOURNAL_ACTIVE");
    const createdAt = this.now();
    const value = normalizeJournal({
      schemaVersion: SCHEMA_VERSION,
      operationId,
      unit,
      backupId,
      ownerPid,
      ownerStartTicks,
      desiredGeneration: "new",
      phase: "prepared",
      entries: entries.map((entry) => ({
        target: entry.target,
        replacement: entry.replacement,
        previous: entry.previous,
        originalExisted: Boolean(entry.originalExisted),
        step: "prepared",
      })),
      createdAt,
      updatedAt: createdAt,
    }, this.isAllowedTarget);
    await this.write(value);
    return structuredClone(value);
  }

  async read() {
    let stat;
    try {
      stat = await fs.lstat(this.filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        this.value = null;
        return null;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw journalError("数据恢复交换日志类型无效", "ERR_RESTORE_JOURNAL_INVALID");
    }
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      throw journalError(`无法读取数据恢复交换日志：${error.message}`, "ERR_RESTORE_JOURNAL_INVALID");
    }
    this.value = normalizeJournal(parsed, this.isAllowedTarget);
    return structuredClone(this.value);
  }

  async claim({ ownerPid, ownerStartTicks }) {
    const value = await this.requireValue();
    value.ownerPid = requirePid(ownerPid);
    value.ownerStartTicks = requireStartTicks(ownerStartTicks);
    value.updatedAt = this.now();
    await this.write(value);
    return structuredClone(value);
  }

  async setPhase(phase) {
    if (!PHASES.has(phase)) throw new TypeError("Invalid restore journal phase");
    const value = await this.requireValue();
    value.phase = phase;
    value.updatedAt = this.now();
    await this.write(value);
  }

  async setDesiredGeneration(generation) {
    if (!GENERATIONS.has(generation)) throw new TypeError("Invalid restore journal generation");
    const value = await this.requireValue();
    value.desiredGeneration = generation;
    value.updatedAt = this.now();
    await this.write(value);
  }

  async moveOriginalAside(index) {
    const { value, entry } = await this.requireEntry(index);
    if (entry.step !== "prepared") throw journalError("数据恢复条目状态不允许移动旧目录", "ERR_RESTORE_JOURNAL_STATE");
    if (entry.originalExisted) {
      await this.renameDurable(entry.target, entry.previous, { action: "move-old", index, entry });
    }
    entry.step = "old-moved";
    value.phase = "swapping";
    value.updatedAt = this.now();
    await this.write(value);
  }

  async activateReplacement(index) {
    const { value, entry } = await this.requireEntry(index);
    if (entry.step !== "old-moved") throw journalError("数据恢复条目状态不允许启用新目录", "ERR_RESTORE_JOURNAL_STATE");
    await this.renameDurable(entry.replacement, entry.target, { action: "activate-new", index, entry });
    entry.step = "new-active";
    value.phase = value.entries.every((candidate) => candidate.step === "new-active")
      ? "forward-complete"
      : "swapping";
    value.updatedAt = this.now();
    await this.write(value);
  }

  async recoverConsistentGeneration({ preferredGeneration = null } = {}) {
    const value = await this.requireValue();
    const inspections = await Promise.all(value.entries.map((entry) => inspectEntry(entry)));
    const canUseNew = inspections.every((entry) => entry.newAvailable);
    const canUseOld = inspections.every((entry) => entry.oldAvailable);
    const preferred = preferredGeneration || value.desiredGeneration;
    let generation = null;
    if (preferred === "new" && canUseNew) generation = "new";
    else if (preferred === "old" && canUseOld) generation = "old";
    else if (canUseNew) generation = "new";
    else if (canUseOld) generation = "old";
    if (!generation) {
      throw journalError("数据恢复副本无法组成完整一致的新代或旧代", "ERR_RESTORE_GENERATION_INCOMPLETE");
    }

    value.desiredGeneration = generation;
    value.phase = generation === "new" ? "recovering-new" : "recovering-old";
    value.updatedAt = this.now();
    await this.write(value);
    for (let index = 0; index < value.entries.length; index += 1) {
      if (generation === "new") await this.recoverEntryForward(index);
      else await this.recoverEntryOld(index);
    }
    // Each durable write replaces the in-memory journal with its normalized
    // copy. Re-read it after the per-entry loop so an older object cannot
    // overwrite the steps persisted by recoverEntryForward/recoverEntryOld.
    const recovered = await this.requireValue();
    recovered.phase = generation === "new" ? "recovered-new" : "recovered-old";
    recovered.updatedAt = this.now();
    await this.write(recovered);
    await this.assertConsistent(generation);
    return { generation, journal: structuredClone(await this.requireValue()) };
  }

  async inspectConsistency() {
    const value = await this.requireValue();
    const inspections = await Promise.all(value.entries.map((entry) => inspectEntry(entry)));
    return {
      newComplete: inspections.every((entry) => entry.newActive),
      oldComplete: inspections.every((entry) => entry.oldActive),
      entries: inspections,
    };
  }

  async clear(operationId) {
    const value = await this.requireValue();
    if (operationId && value.operationId !== operationId) {
      throw journalError("数据恢复交换日志属于另一个任务", "ERR_RESTORE_JOURNAL_OWNER");
    }
    await fs.unlink(this.filePath);
    await syncDirectory(this.runtimeDirectory);
    this.value = null;
  }

  async recoverEntryForward(index) {
    const { value, entry } = await this.requireEntry(index);
    let state = await inspectEntry(entry);
    if (state.newActive) {
      entry.step = "new-active";
      value.updatedAt = this.now();
      await this.write(value);
      return;
    }
    if (!state.replacementExists) {
      throw journalError(`找不到新数据副本：${entry.target}`, "ERR_RESTORE_GENERATION_INCOMPLETE");
    }
    if (state.targetExists) {
      if (state.previousExists) {
        throw journalError(`恢复目录状态存在歧义：${entry.target}`, "ERR_RESTORE_GENERATION_AMBIGUOUS");
      }
      await this.renameDurable(entry.target, entry.previous, { action: "recover-preserve-old", index, entry });
      entry.step = "old-moved";
      value.updatedAt = this.now();
      await this.write(value);
      state = await inspectEntry(entry);
    }
    await this.renameDurable(entry.replacement, entry.target, { action: "recover-new", index, entry });
    entry.step = "new-active";
    value.updatedAt = this.now();
    await this.write(value);
  }

  async recoverEntryOld(index) {
    const { value, entry } = await this.requireEntry(index);
    let state = await inspectEntry(entry);
    if (state.oldActive) {
      entry.step = "old-active";
      value.updatedAt = this.now();
      await this.write(value);
      return;
    }
    if (state.targetExists) {
      if (state.replacementExists) {
        throw journalError(`恢复目录状态存在歧义：${entry.target}`, "ERR_RESTORE_GENERATION_AMBIGUOUS");
      }
      await this.renameDurable(entry.target, entry.replacement, { action: "recover-stash-new", index, entry });
      entry.step = "new-stashed";
      value.updatedAt = this.now();
      await this.write(value);
      state = await inspectEntry(entry);
    }
    if (entry.originalExisted) {
      if (!state.previousExists) {
        throw journalError(`找不到旧数据副本：${entry.target}`, "ERR_RESTORE_GENERATION_INCOMPLETE");
      }
      await this.renameDurable(entry.previous, entry.target, { action: "recover-old", index, entry });
    }
    entry.step = "old-active";
    value.updatedAt = this.now();
    await this.write(value);
  }

  async assertConsistent(generation) {
    const consistency = await this.inspectConsistency();
    if ((generation === "new" && consistency.newComplete) || (generation === "old" && consistency.oldComplete)) return;
    throw journalError("数据恢复完成后仍不是一致代", "ERR_RESTORE_GENERATION_INCOMPLETE");
  }

  async requireValue() {
    if (!this.value) await this.read();
    if (!this.value) throw journalError("没有待处理的数据恢复交换日志", "ERR_RESTORE_JOURNAL_MISSING");
    return this.value;
  }

  async requireEntry(index) {
    const value = await this.requireValue();
    if (!Number.isInteger(index) || index < 0 || index >= value.entries.length) {
      throw new RangeError("Invalid restore journal entry index");
    }
    return { value, entry: value.entries[index] };
  }

  async renameDurable(source, destination, metadata) {
    await fs.rename(source, destination);
    await syncRenameDirectories(source, destination);
    await this.afterRename({ ...metadata, source, destination });
  }

  async write(value) {
    const normalized = normalizeJournal(value, this.isAllowedTarget);
    await fs.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o755 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle = null;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.filePath);
      await syncDirectory(this.runtimeDirectory);
      this.value = normalized;
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export function createRestoreTargetValidator({
  stateDirectory,
  usersRoot,
  ownerCodexHome,
  projectRoot,
  sourceDirectory,
} = {}) {
  const state = path.resolve(stateDirectory || "");
  const users = path.resolve(usersRoot || "");
  const owner = path.resolve(ownerCodexHome || "");
  const projects = path.resolve(projectRoot || "");
  const source = path.resolve(sourceDirectory || "");
  return (candidate) => {
    const target = path.resolve(String(candidate || ""));
    return target === state
      || target === users
      || target === owner
      || (
        isInside(projects, target)
        && target !== projects
        && !isInside(source, target)
        && !isInside(users, target)
      );
  };
}

async function inspectEntry(entry) {
  const [targetExists, replacementExists, previousExists] = await Promise.all([
    exists(entry.target),
    exists(entry.replacement),
    exists(entry.previous),
  ]);
  const newAtTarget = targetExists
    && !replacementExists
    && ["old-moved", "new-active"].includes(entry.step);
  const oldAtTarget = targetExists
    && ["prepared", "new-stashed", "old-active"].includes(entry.step);
  return {
    targetExists,
    replacementExists,
    previousExists,
    newAvailable: replacementExists || newAtTarget,
    oldAvailable: !entry.originalExisted || previousExists || oldAtTarget,
    newActive: newAtTarget,
    oldActive: entry.originalExisted ? oldAtTarget && !previousExists : !targetExists,
  };
}

function normalizeJournal(input, isAllowedTarget) {
  if (input?.schemaVersion !== SCHEMA_VERSION) throw invalidJournal();
  const operationId = requireOperationId(input.operationId);
  const unit = String(input.unit || "");
  if (!/^wfl-codex-desktop-backend@(4318|4319)\.service$/.test(unit)) throw invalidJournal();
  const backupId = String(input.backupId || "");
  if (!/^b-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/.test(backupId)) throw invalidJournal();
  if (!GENERATIONS.has(input.desiredGeneration) || !PHASES.has(input.phase)) throw invalidJournal();
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 10_000) throw invalidJournal();
  const paths = new Set();
  const entries = input.entries.map((raw) => {
    const target = path.resolve(String(raw?.target || ""));
    const replacement = path.resolve(String(raw?.replacement || ""));
    const previous = path.resolve(String(raw?.previous || ""));
    if (!path.isAbsolute(target) || target === "/" || !isAllowedTarget(target)) throw invalidJournal();
    if (!replacement.endsWith(".new") || !previous.endsWith(".old")) throw invalidJournal();
    if (replacement.slice(0, -4) !== previous.slice(0, -4)) throw invalidJournal();
    if (!replacement.startsWith(`${target}.wfl-restore-`)) throw invalidJournal();
    if (path.dirname(target) !== path.dirname(replacement) || path.dirname(target) !== path.dirname(previous)) {
      throw invalidJournal();
    }
    for (const candidate of [target, replacement, previous]) {
      if (paths.has(candidate)) throw invalidJournal();
      paths.add(candidate);
    }
    if (typeof raw.originalExisted !== "boolean" || !ENTRY_STEPS.has(raw.step)) throw invalidJournal();
    return { target, replacement, previous, originalExisted: raw.originalExisted, step: raw.step };
  });
  for (let index = 0; index < entries.length; index += 1) {
    for (let other = index + 1; other < entries.length; other += 1) {
      if (isInside(entries[index].target, entries[other].target)
        || isInside(entries[other].target, entries[index].target)) {
        throw invalidJournal();
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    unit,
    backupId,
    ownerPid: requirePid(input.ownerPid),
    ownerStartTicks: requireStartTicks(input.ownerStartTicks),
    desiredGeneration: input.desiredGeneration,
    phase: input.phase,
    entries,
    createdAt: requireTimestamp(input.createdAt),
    updatedAt: requireTimestamp(input.updatedAt),
  };
}

function defaultAllowedTarget(target) {
  return path.isAbsolute(target) && target !== "/";
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireOperationId(value) {
  const operationId = String(value || "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,158}[A-Za-z0-9])?$/.test(operationId)) throw invalidJournal();
  return operationId;
}

function requirePid(value) {
  if (!Number.isSafeInteger(value) || value <= 1) throw invalidJournal();
  return value;
}

function requireStartTicks(value) {
  if (!/^\d+$/.test(String(value || ""))) throw invalidJournal();
  return String(value);
}

function requireTimestamp(value) {
  if (!Number.isFinite(value) || value <= 0) throw invalidJournal();
  return value;
}

async function syncRenameDirectories(source, destination) {
  const directories = [...new Set([path.dirname(source), path.dirname(destination)])];
  await Promise.all(directories.map(syncDirectory));
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function invalidJournal() {
  return journalError("数据恢复交换日志无效", "ERR_RESTORE_JOURNAL_INVALID");
}

function journalError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
