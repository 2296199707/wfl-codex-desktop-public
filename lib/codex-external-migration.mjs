import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const DETECTION_TTL_MS = 30 * 60 * 1000;
const MAX_DETECTIONS = 12;
const MAX_OPERATIONS = 50;
const MAX_ITEMS = 128;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const ITEM_TYPES = new Set([
  "AGENTS_MD",
  "CONFIG",
  "SKILLS",
  "PLUGINS",
  "MCP_SERVER_CONFIG",
  "SUBAGENTS",
  "HOOKS",
  "COMMANDS",
  "MEMORY",
  "SESSIONS",
]);

export class CodexExternalMigrationStore {
  constructor({
    stateDirectory,
    home,
    codexHome,
    projectRoot,
    uid = null,
    gid = null,
    now = () => Date.now(),
  }) {
    this.directory = path.join(path.resolve(stateDirectory), "codex-external-migration");
    this.snapshotDirectory = path.join(this.directory, "snapshots");
    this.indexPath = path.join(this.directory, "index.json");
    this.home = path.resolve(home);
    this.codexHome = path.resolve(codexHome);
    this.projectRoot = path.resolve(projectRoot);
    this.uid = Number.isInteger(uid) ? uid : typeof process.getuid === "function" ? process.getuid() : null;
    this.gid = Number.isInteger(gid) ? gid : typeof process.getgid === "function" ? process.getgid() : null;
    this.now = now;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.snapshotDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.chmod(this.directory, 0o700),
      fs.chmod(this.snapshotDirectory, 0o700),
    ]);
    this.data = await readJson(this.indexPath, emptyIndex());
    normalizeIndex(this.data, this.now());
    await this.persist();
    return this;
  }

  async recordDetection({
    providerId = "claude-code",
    migrationSource = "claude-code",
    items,
    requestedCwds = [],
  }) {
    this.assertInitialized();
    const normalizedItems = normalizeDetectionItems(items, {
      home: this.home,
      projectRoot: this.projectRoot,
      requestedCwds,
      uid: this.uid,
      gid: this.gid,
    });
    const now = this.now();
    const record = {
      id: `d-${crypto.randomBytes(12).toString("hex")}`,
      providerId: normalizeProviderId(providerId),
      migrationSource: normalizeMigrationSource(migrationSource),
      createdAt: now,
      expiresAt: now + DETECTION_TTL_MS,
      items: normalizedItems,
    };
    this.data.detections.unshift(record);
    this.data.detections = this.data.detections
      .filter((entry) => entry.expiresAt > now)
      .slice(0, MAX_DETECTIONS);
    await this.persist();
    return publicDetection(record);
  }

  detection(id) {
    this.assertInitialized();
    const record = this.data.detections.find((entry) => entry.id === id);
    if (!record || record.expiresAt <= this.now()) return null;
    return structuredClone(record);
  }

  selectedItems(detectionId, itemIds) {
    const detection = this.detection(detectionId);
    if (!detection) throw storeError(409, "迁移扫描结果已过期，请重新扫描");
    if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > MAX_ITEMS) {
      throw storeError(400, "请选择要导入的迁移项目");
    }
    const unique = [...new Set(itemIds.map(normalizeItemId))];
    const selected = unique.map((id) => detection.items.find((item) => item.id === id));
    if (selected.some((item) => !item)) throw storeError(409, "迁移项目不属于最近一次安全扫描");
    return { detection, items: selected };
  }

  async prepareImport({ detectionId, itemIds }) {
    const selection = this.selectedItems(detectionId, itemIds);
    const snapshot = await this.createSnapshot(selection);
    return {
      detection: publicDetection(selection.detection),
      nativeItems: selection.items.map(nativeMigrationItem),
      selectedItems: selection.items.map(publicMigrationItem),
      snapshot,
    };
  }

  async beginImport({
    importId,
    detectionId,
    selectedItems,
    snapshotId,
  }) {
    this.assertInitialized();
    const id = normalizeImportId(importId);
    const existing = this.data.operations.find((entry) => entry.importId === id);
    if (existing) return publicOperation(existing);
    const detection = this.detection(detectionId);
    if (!detection) throw storeError(409, "迁移扫描结果已过期，请重新扫描");
    const now = this.now();
    const operation = {
      importId: id,
      detectionId: detection.id,
      providerId: detection.providerId,
      migrationSource: detection.migrationSource,
      snapshotId: normalizeSnapshotId(snapshotId),
      itemIds: selectedItems.map((item) => normalizeItemId(item.id)),
      itemTypes: [...new Set(selectedItems.map((item) => normalizeItemType(item.itemType)))],
      status: "running",
      itemTypeResults: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.data.operations.unshift(operation);
    this.data.operations = this.data.operations.slice(0, MAX_OPERATIONS);
    await this.persist();
    return publicOperation(operation);
  }

  async updateImport(importId, itemTypeResults, { completed = false } = {}) {
    this.assertInitialized();
    const id = normalizeImportId(importId);
    const operation = this.data.operations.find((entry) => entry.importId === id);
    if (!operation) return null;
    operation.itemTypeResults = normalizeItemTypeResults(itemTypeResults);
    operation.status = completed
      ? operation.itemTypeResults.some((entry) => entry.failures.length) ? "partial" : "completed"
      : "running";
    operation.updatedAt = this.now();
    operation.completedAt = completed ? operation.updatedAt : null;
    await this.persist();
    return publicOperation(operation);
  }

  async failPreparedImport({ importId = null, detectionId, selectedItems, snapshotId, message }) {
    this.assertInitialized();
    const detection = this.detection(detectionId);
    const now = this.now();
    const operation = {
      importId: importId
        ? normalizeImportId(importId)
        : `wfl-failed-${crypto.randomBytes(12).toString("hex")}`,
      detectionId,
      providerId: detection?.providerId || "claude-code",
      migrationSource: detection?.migrationSource || "claude-code",
      snapshotId: normalizeSnapshotId(snapshotId),
      itemIds: selectedItems.map((item) => normalizeItemId(item.id)),
      itemTypes: [...new Set(selectedItems.map((item) => normalizeItemType(item.itemType)))],
      status: "failed",
      itemTypeResults: selectedItems.map((item) => ({
        itemType: item.itemType,
        successes: [],
        failures: [{
          itemType: item.itemType,
          errorType: "WFL_IMPORT_START_FAILED",
          subErrorType: null,
          failureStage: "start",
          message: normalizeMessage(message),
          cwd: item.cwd,
          source: null,
        }],
      })),
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    };
    this.data.operations.unshift(operation);
    this.data.operations = this.data.operations.slice(0, MAX_OPERATIONS);
    await this.persist();
    return publicOperation(operation);
  }

  retrySelection(importId) {
    this.assertInitialized();
    const operation = this.data.operations.find((entry) => entry.importId === normalizeImportId(importId));
    if (!operation || !["partial", "failed"].includes(operation.status)) {
      throw storeError(409, "该迁移没有可重试的失败项目");
    }
    const failedTypes = new Set(operation.itemTypeResults
      .filter((entry) => entry.failures.length)
      .map((entry) => entry.itemType));
    const detection = this.detection(operation.detectionId);
    if (!detection) throw storeError(409, "原迁移扫描结果已过期，请重新扫描");
    const itemIds = operation.itemIds.filter((id) => {
      const item = detection.items.find((entry) => entry.id === id);
      return item && failedTypes.has(item.itemType);
    });
    if (!itemIds.length) throw storeError(409, "失败项目已不在安全扫描结果中，请重新扫描");
    return { detectionId: detection.id, itemIds };
  }

  snapshot() {
    this.assertInitialized();
    return {
      detections: this.data.detections
        .filter((entry) => entry.expiresAt > this.now())
        .map(publicDetection),
      operations: this.data.operations.map(publicOperation),
      snapshots: this.data.snapshots.map(publicSnapshot),
    };
  }

  async reconcileHistories(histories) {
    this.assertInitialized();
    const entries = Array.isArray(histories) ? histories : [];
    let changed = false;
    for (const history of entries) {
      const operation = this.data.operations.find((entry) => entry.importId === history?.importId);
      if (!operation || operation.completedAt) continue;
      operation.itemTypeResults = historyToResults(history);
      operation.status = operation.itemTypeResults.some((entry) => entry.failures.length)
        ? "partial"
        : "completed";
      operation.updatedAt = Number(history.completedAtMs) || this.now();
      operation.completedAt = operation.updatedAt;
      changed = true;
    }
    if (changed) await this.persist();
    return this.snapshot();
  }

  async createSnapshot({ detection, items }) {
    const id = `s-${crypto.randomBytes(12).toString("hex")}`;
    const temporaryDirectory = path.join(this.snapshotDirectory, `.${id}.${process.pid}.tmp`);
    const targetDirectory = path.join(this.snapshotDirectory, id);
    await fs.mkdir(temporaryDirectory, { mode: 0o700 });
    const roots = snapshotRoots({
      items,
      migrationSource: detection.migrationSource,
      home: this.home,
      codexHome: this.codexHome,
      projectRoot: this.projectRoot,
    });
    const manifest = {
      version: 1,
      id,
      detectionId: detection.id,
      providerId: detection.providerId,
      createdAt: this.now(),
      expectedUid: this.uid,
      expectedGid: this.gid,
      entries: [],
      totalBytes: 0,
    };
    const budget = { files: 0, bytes: 0 };
    try {
      for (const root of roots) {
        const destination = path.join(temporaryDirectory, root.archiveName);
        await snapshotPath(root.sourcePath, destination, {
          manifest,
          budget,
          expectedUid: this.uid,
          expectedGid: this.gid,
          allowedRoots: root.allowedRoots,
          snapshotRoot: temporaryDirectory,
        });
      }
      const manifestPath = path.join(temporaryDirectory, "manifest.json");
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o400,
        flag: "wx",
      });
      await makeTreeReadOnly(temporaryDirectory);
      await fs.rename(temporaryDirectory, targetDirectory);
      const snapshot = {
        id,
        detectionId: detection.id,
        providerId: detection.providerId,
        createdAt: manifest.createdAt,
        fileCount: budget.files,
        totalBytes: budget.bytes,
      };
      this.data.snapshots.unshift(snapshot);
      this.data.snapshots = this.data.snapshots.slice(0, MAX_OPERATIONS);
      await this.persist();
      return publicSnapshot(snapshot);
    } catch (error) {
      await fs.chmod(temporaryDirectory, 0o700).catch(() => {});
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async persist() {
    this.assertInitialized({ allowEmpty: true });
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.indexPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(temporary, payload, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.indexPath);
      await fs.chmod(this.indexPath, 0o600);
    });
    return this.writeQueue;
  }

  assertInitialized({ allowEmpty = false } = {}) {
    if (!allowEmpty && !this.data) throw new Error("Codex external migration store is not initialized");
    if (allowEmpty && !this.data) this.data = emptyIndex();
  }
}

export function publicExternalMigrationHistory(result) {
  const data = Array.isArray(result?.data) ? result.data.slice(0, 100).map((entry) => ({
    importId: normalizeImportId(entry?.importId),
    providerId: entry?.providerId == null ? null : normalizeProviderId(entry.providerId),
    completedAtMs: normalizeTimestamp(entry?.completedAtMs),
    successes: normalizeSuccesses(entry?.successes),
    failures: normalizeFailures(entry?.failures),
  })) : [];
  const connectors = Array.isArray(result?.connectors) ? result.connectors.slice(0, 100).map((entry) => ({
    name: normalizeLabel(entry?.name, "连接器"),
    sessionCount: boundedInteger(entry?.sessionCount, 0, 1_000_000),
    source: entry?.source === "remoteMcpServersConfig" ? entry.source : "remoteMcpServersConfig",
  })) : [];
  return { data, connectors };
}

export function normalizeExternalMigrationDetectionParams(params, {
  currentProject,
  includeHomeDefault = true,
} = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw storeError(400, "迁移扫描参数无效");
  }
  const includeHome = params.includeHome === undefined ? includeHomeDefault : params.includeHome === true;
  const cwds = params.cwds === undefined
    ? currentProject ? [path.resolve(currentProject)] : []
    : params.cwds;
  if (!Array.isArray(cwds) || cwds.length > 16) throw storeError(400, "迁移工程列表无效");
  return {
    includeHome,
    cwds: [...new Set(cwds.map((cwd) => {
      if (typeof cwd !== "string" || !cwd || !path.isAbsolute(cwd) || /[\r\n\0]/.test(cwd)) {
        throw storeError(400, "迁移工程目录无效");
      }
      return path.resolve(cwd);
    }))],
    maxSessionAgeDays: boundedInteger(params.maxSessionAgeDays ?? 30, 1, 365),
    maxSessions: boundedInteger(params.maxSessions ?? 50, 1, 200),
    migrationSource: normalizeMigrationSource(params.migrationSource || "claude-code"),
  };
}

function normalizeDetectionItems(items, context) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw storeError(400, "Codex 返回了无效的迁移项目");
  return items.map((item) => normalizeDetectionItem(item, context));
}

function normalizeDetectionItem(item, context) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw storeError(400, "Codex 返回了无效的迁移项目");
  }
  const itemType = normalizeItemType(item.itemType);
  const cwd = item.cwd == null || item.cwd === "" ? null : path.resolve(String(item.cwd));
  if (cwd && !context.requestedCwds.some((root) => inside(root, cwd))) {
    throw storeError(403, "Codex 返回了扫描范围外的迁移工程");
  }
  const description = normalizeLabel(item.description, "迁移项目", 2_048);
  const details = normalizeMigrationDetails(item.details, {
    home: context.home,
    cwd,
    requestedCwds: context.requestedCwds,
  });
  const native = { itemType, description, cwd, ...(details ? { details } : {}) };
  return {
    id: `mi-${crypto.createHash("sha256").update(canonicalJson(native)).digest("hex").slice(0, 24)}`,
    ...native,
  };
}

function normalizeMigrationDetails(value, { home, cwd, requestedCwds = [] }) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw storeError(400, "迁移项目详情无效");
  const names = (key, fields) => {
    if (!Array.isArray(value[key]) || value[key].length > 1_000) return [];
    return value[key].map((entry) => Object.fromEntries(fields.map((field) => [
      field,
      normalizeLabel(entry?.[field], field, 512),
    ])));
  };
  const sessions = Array.isArray(value.sessions) ? value.sessions.slice(0, 200).flatMap((entry) => {
    const sessionPath = path.resolve(String(entry?.path || ""));
    if (!inside(home, sessionPath)) throw storeError(403, "迁移会话路径超出当前账号目录");
    const sessionCwd = path.resolve(String(entry?.cwd || cwd || ""));
    const allowedSessionRoots = [home, cwd, ...requestedCwds].filter(Boolean);
    if (!sessionCwd || !allowedSessionRoots.some((root) => inside(root, sessionCwd))) {
      return [];
    }
    return [{
      path: sessionPath,
      cwd: sessionCwd,
      title: entry?.title == null ? null : normalizeLabel(entry.title, "会话", 512),
    }];
  }) : [];
  const memory = Array.isArray(value.memory)
    ? value.memory.slice(0, 1_000).map((entry) => normalizeLabel(entry, "Memory", 2_048))
    : [];
  return {
    plugins: names("plugins", ["marketplaceName"]).map((entry, index) => ({
      ...entry,
      pluginNames: Array.isArray(value.plugins[index]?.pluginNames)
        ? value.plugins[index].pluginNames.slice(0, 1_000).map((name) => normalizeLabel(name, "插件", 512))
        : [],
    })),
    skills: names("skills", ["name"]),
    sessions,
    mcpServers: names("mcpServers", ["name"]),
    hooks: names("hooks", ["name"]),
    subagents: names("subagents", ["name"]),
    commands: names("commands", ["name"]),
    ...(memory.length ? { memory } : {}),
  };
}

function snapshotRoots({ items, migrationSource = "claude-code", home, codexHome, projectRoot }) {
  const types = new Set(items.map((item) => item.itemType));
  const roots = [];
  const add = (archiveName, sourcePath, allowedRoots) => {
    if (roots.some((entry) => entry.sourcePath === sourcePath)) return;
    roots.push({ archiveName, sourcePath, allowedRoots });
  };
  const sourceByType = migrationSource === "cursor"
    ? {
      AGENTS_MD: ["AGENTS.md", ".cursor/rules"],
      CONFIG: [".cursor/rules", ".cursor/plugins", ".cursor-plugin/plugin.json", ".codex/config.toml"],
      SKILLS: [".cursor/skills", ".agents/skills", ".codex/skills"],
      PLUGINS: [".cursor/plugins", ".cursor-plugin/plugin.json", ".codex/plugins"],
      MCP_SERVER_CONFIG: [".cursor/mcp.json", ".mcp.json", ".codex/config.toml"],
      SUBAGENTS: [".cursor/agents", ".codex/agents"],
      HOOKS: [".cursor/hooks", ".codex/hooks"],
      COMMANDS: [".cursor/commands", ".codex/prompts", ".codex/commands"],
      MEMORY: [".cursor/rules", ".codex/memories"],
    }
    : {
    AGENTS_MD: ["CLAUDE.md", "AGENTS.md"],
    CONFIG: [".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml"],
    SKILLS: [".claude/skills", ".agents/skills", ".codex/skills"],
    PLUGINS: [".claude/plugins", ".claude/settings.json", ".codex/plugins"],
    MCP_SERVER_CONFIG: [".claude/settings.json", ".mcp.json", ".codex/config.toml"],
    SUBAGENTS: [".claude/agents", ".codex/agents"],
    HOOKS: [".claude/settings.json", ".claude/hooks", ".codex/hooks"],
    COMMANDS: [".claude/commands", ".codex/prompts", ".codex/commands"],
    MEMORY: [".claude/CLAUDE.md", ".claude/memory", ".codex/memories"],
    };
  const homeCandidates = new Set();
  for (const type of types) {
    for (const relative of sourceByType[type] || []) homeCandidates.add(relative);
  }
  for (const relative of homeCandidates) {
    const sourcePath = relative.startsWith(".codex/")
      ? path.join(codexHome, relative.slice(".codex/".length))
      : path.join(home, relative);
    add(`home/${safeArchiveRelative(relative)}`, sourcePath, [home]);
  }
  const cwds = [...new Set(items.map((item) => item.cwd).filter(Boolean))];
  for (const cwd of cwds) {
    for (const type of types) {
      for (const relative of sourceByType[type] || []) {
        add(
          `projects/${projectArchiveName(projectRoot, cwd)}/${safeArchiveRelative(relative)}`,
          path.join(cwd, relative),
          [cwd],
        );
      }
    }
  }
  for (const item of items) {
    for (const session of item.details?.sessions || []) {
      add(
        `sessions/${crypto.createHash("sha256").update(session.path).digest("hex").slice(0, 16)}-${path.basename(session.path)}`,
        session.path,
        [home],
      );
    }
  }
  return roots;
}

async function snapshotPath(sourcePath, destination, context) {
  const stat = await fs.lstat(sourcePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) {
    context.manifest.entries.push({
      sourcePath,
      archivePath: path.relative(context.snapshotRoot, destination),
      exists: false,
    });
    return;
  }
  assertSnapshotSource(sourcePath, stat, context);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const names = await fs.readdir(sourcePath);
    if (names.length > MAX_FILES) throw storeError(413, "迁移快照目录文件过多");
    for (const name of names.sort()) {
      await snapshotPath(path.join(sourcePath, name), path.join(destination, name), context);
    }
    return;
  }
  if (!stat.isFile()) throw storeError(400, "迁移快照只接受普通文件和目录");
  if (stat.size > MAX_FILE_BYTES) throw storeError(413, "迁移快照包含过大的单个文件");
  context.budget.files += 1;
  context.budget.bytes += stat.size;
  if (context.budget.files > MAX_FILES || context.budget.bytes > MAX_SNAPSHOT_BYTES) {
    throw storeError(413, "迁移快照超出安全大小限制");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  await fs.chmod(destination, 0o400);
  const digest = crypto.createHash("sha256").update(await fs.readFile(destination)).digest("hex");
  context.manifest.entries.push({
    sourcePath,
    archivePath: path.relative(context.snapshotRoot, destination),
    exists: true,
    size: stat.size,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    sha256: digest,
  });
  context.manifest.totalBytes = context.budget.bytes;
}

function assertSnapshotSource(sourcePath, stat, {
  expectedUid,
  expectedGid,
  allowedRoots,
}) {
  if (!allowedRoots.some((root) => inside(root, sourcePath))) {
    throw storeError(403, "迁移快照路径超出当前账号边界");
  }
  if (stat.isSymbolicLink()) throw storeError(400, "迁移快照不跟随符号链接");
  if (Number.isInteger(expectedUid) && stat.uid !== expectedUid) {
    throw storeError(403, "迁移源文件属主与当前账号 UID 不一致");
  }
  if (Number.isInteger(expectedGid) && stat.gid !== expectedGid) {
    throw storeError(403, "迁移源文件属组与当前账号 GID 不一致");
  }
  if ((stat.mode & 0o7000) !== 0) throw storeError(403, "迁移源文件包含特殊权限位");
  if ((stat.mode & 0o002) !== 0) throw storeError(403, "迁移源文件不能允许其他用户写入");
}

async function makeTreeReadOnly(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(child);
    else await fs.chmod(child, 0o400);
  }
  await fs.chmod(directory, 0o500);
}

function publicDetection(record) {
  return {
    id: record.id,
    providerId: record.providerId,
    migrationSource: record.migrationSource,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    items: record.items.map(publicMigrationItem),
  };
}

function publicMigrationItem(item) {
  return {
    id: item.id,
    itemType: item.itemType,
    description: item.description,
    cwd: item.cwd,
    details: item.details ? {
      plugins: item.details.plugins,
      skills: item.details.skills,
      sessions: item.details.sessions.map(({ path: _path, ...session }) => session),
      mcpServers: item.details.mcpServers,
      hooks: item.details.hooks,
      subagents: item.details.subagents,
      commands: item.details.commands,
      memoryCount: item.details.memory?.length || 0,
    } : null,
  };
}

function nativeMigrationItem(item) {
  const { id: _id, ...native } = item;
  return structuredClone(native);
}

function publicOperation(operation) {
  return {
    importId: operation.importId,
    detectionId: operation.detectionId,
    providerId: operation.providerId,
    migrationSource: operation.migrationSource,
    snapshotId: operation.snapshotId,
    itemTypes: [...operation.itemTypes],
    status: operation.status,
    itemTypeResults: normalizeItemTypeResults(operation.itemTypeResults),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  };
}

function publicSnapshot(snapshot) {
  return {
    id: snapshot.id,
    detectionId: snapshot.detectionId,
    providerId: snapshot.providerId,
    createdAt: snapshot.createdAt,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    readOnly: true,
  };
}

function normalizeItemTypeResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map((entry) => ({
    itemType: normalizeItemType(entry?.itemType),
    successes: normalizeSuccesses(entry?.successes),
    failures: normalizeFailures(entry?.failures),
  }));
}

function normalizeSuccesses(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1_000).map((entry) => {
    const itemType = normalizeItemType(entry?.itemType);
    return {
      itemType,
      cwd: nullablePath(entry?.cwd),
      source: itemType === "SESSIONS" ? null : nullablePath(entry?.source),
      target: itemType === "SESSIONS" ? null : nullablePath(entry?.target),
    };
  });
}

function normalizeFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1_000).map((entry) => {
    const itemType = normalizeItemType(entry?.itemType);
    return {
      itemType,
      errorType: entry?.errorType == null ? null : normalizeLabel(entry.errorType, "errorType", 256),
      subErrorType: entry?.subErrorType == null ? null : normalizeLabel(entry.subErrorType, "subErrorType", 256),
      failureStage: normalizeLabel(entry?.failureStage, "failureStage", 256),
      message: normalizeMessage(entry?.message),
      cwd: nullablePath(entry?.cwd),
      source: itemType === "SESSIONS" ? null : nullablePath(entry?.source),
    };
  });
}

function historyToResults(history) {
  const grouped = new Map();
  for (const success of normalizeSuccesses(history?.successes)) {
    const entry = grouped.get(success.itemType) || { itemType: success.itemType, successes: [], failures: [] };
    entry.successes.push(success);
    grouped.set(success.itemType, entry);
  }
  for (const failure of normalizeFailures(history?.failures)) {
    const entry = grouped.get(failure.itemType) || { itemType: failure.itemType, successes: [], failures: [] };
    entry.failures.push(failure);
    grouped.set(failure.itemType, entry);
  }
  return [...grouped.values()];
}

function normalizeIndex(value, now) {
  if (!value || value.version !== STORE_VERSION) throw new Error("Unsupported Codex external migration store");
  value.detections = Array.isArray(value.detections)
    ? value.detections.filter((entry) => entry?.expiresAt > now).slice(0, MAX_DETECTIONS)
    : [];
  value.operations = Array.isArray(value.operations) ? value.operations.slice(0, MAX_OPERATIONS) : [];
  value.snapshots = Array.isArray(value.snapshots) ? value.snapshots.slice(0, MAX_OPERATIONS) : [];
}

function emptyIndex() {
  return { version: STORE_VERSION, detections: [], operations: [], snapshots: [] };
}

function normalizeMigrationSource(value) {
  if (!["claude-code", "cursor"].includes(value)) {
    throw storeError(400, "当前版本仅支持 Claude Code 或 Cursor 迁移");
  }
  return value;
}

function normalizeProviderId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw storeError(400, "迁移来源标识无效");
  return normalized;
}

function normalizeItemType(value) {
  if (!ITEM_TYPES.has(value)) throw storeError(400, `不支持的迁移项目类型：${value || "unknown"}`);
  return value;
}

function normalizeItemId(value) {
  const normalized = String(value || "");
  if (!/^mi-[a-f0-9]{24}$/.test(normalized)) throw storeError(400, "迁移项目编号无效");
  return normalized;
}

function normalizeSnapshotId(value) {
  const normalized = String(value || "");
  if (!/^s-[a-f0-9]{24}$/.test(normalized)) throw storeError(400, "迁移快照编号无效");
  return normalized;
}

function normalizeImportId(value) {
  const normalized = String(value || "");
  if (
    !/^(?:[0-9a-f]{8}-[0-9a-f-]{27}|wfl-failed-[a-f0-9]{24})$/i.test(normalized)
    || /[\r\n\0]/.test(normalized)
  ) throw storeError(400, "迁移任务编号无效");
  return normalized;
}

function normalizeLabel(value, label, limit = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > limit || /[\r\n\0]/.test(normalized)) {
    throw storeError(400, `${label}无效`);
  }
  return normalized;
}

function normalizeMessage(value) {
  return String(value || "迁移失败").replace(/\0/g, "").slice(0, 2_048);
}

function normalizeTimestamp(value) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nullablePath(value) {
  if (value == null || value === "") return null;
  const normalized = String(value);
  if (!path.isAbsolute(normalized) || normalized.length > 4_096 || /[\r\n\0]/.test(normalized)) {
    throw storeError(400, "迁移结果路径无效");
  }
  return path.resolve(normalized);
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw storeError(400, "迁移数量参数无效");
  }
  return number;
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeArchiveRelative(value) {
  return String(value).split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..").join("/");
}

function projectArchiveName(projectRoot, cwd) {
  const relative = inside(projectRoot, cwd) ? path.relative(projectRoot, cwd) || "root" : path.basename(cwd);
  const slug = relative.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "project";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
