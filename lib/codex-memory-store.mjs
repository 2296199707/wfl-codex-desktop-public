import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_THREAD_MODES = 500;
const MAX_MEMORY_FILES = 256;
const MAX_MEMORY_FILE_BYTES = 512 * 1024;
const MAX_MEMORY_DEPTH = 8;
const THREAD_ID_PATTERN = /^[^\u0000\r\n]{1,256}$/;
const MEMORY_FILE_PATTERN = /\.(?:md|txt|json|jsonl)$/i;
const SECRET_PATTERNS = [
  {
    pattern: /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*["']?\s*[:=]\s*["']?)([^\s"',}\]]{4,})/gi,
    replacement: "$1[已隐藏]",
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/gi,
    replacement: "Bearer [已隐藏]",
  },
  {
    pattern: /\b(?:sk|sess|ghp|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[已隐藏的凭据]",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[已隐藏的令牌]",
  },
];

export class CodexMemoryStore {
  constructor({
    stateDirectory,
    codexHome,
    uid = null,
    gid = null,
    now = () => Date.now(),
  }) {
    this.directory = path.join(path.resolve(stateDirectory), "codex-memory");
    this.indexPath = path.join(this.directory, "thread-modes.json");
    this.codexHome = path.resolve(codexHome);
    this.memoryDirectory = path.join(this.codexHome, "memories");
    this.uid = Number.isInteger(uid)
      ? uid
      : typeof process.getuid === "function" ? process.getuid() : null;
    this.gid = Number.isInteger(gid)
      ? gid
      : typeof process.getgid === "function" ? process.getgid() : null;
    this.now = now;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    this.data = normalizeIndex(await readJson(this.indexPath, emptyIndex()));
    await this.persist();
    return this;
  }

  threadMode(threadId) {
    this.assertInitialized();
    const id = normalizeCodexMemoryThreadId(threadId);
    const record = this.data.threadModes[id];
    return record ? structuredClone(record) : null;
  }

  async setThreadMode(threadId, mode) {
    this.assertInitialized();
    const id = normalizeCodexMemoryThreadId(threadId);
    const normalizedMode = normalizeThreadMemoryMode(mode);
    const record = { mode: normalizedMode, updatedAt: this.now() };
    this.data.threadModes[id] = record;
    const entries = Object.entries(this.data.threadModes)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_THREAD_MODES);
    this.data.threadModes = Object.fromEntries(entries);
    await this.persist();
    return { threadId: id, ...record };
  }

  async listMemories() {
    this.assertInitialized();
    const root = await this.safeMemoryRoot();
    if (!root) return [];
    const files = [];
    const queue = [{ directory: root, depth: 0 }];
    while (queue.length && files.length < MAX_MEMORY_FILES) {
      const current = queue.shift();
      const entries = await fs.readdir(current.directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= MAX_MEMORY_FILES) break;
        if (!entry.name || entry.name === "." || entry.name === "..") continue;
        const absolutePath = path.join(current.directory, entry.name);
        const stat = await fs.lstat(absolutePath);
        assertOwnedMemoryEntry(stat, this.uid, this.gid);
        if (stat.isSymbolicLink()) throw storeError(409, "记忆目录包含不安全的符号链接");
        if (stat.isDirectory()) {
          if (current.depth >= MAX_MEMORY_DEPTH) continue;
          assertPrivateDirectoryMode(stat);
          queue.push({ directory: absolutePath, depth: current.depth + 1 });
          continue;
        }
        if (!stat.isFile() || !MEMORY_FILE_PATTERN.test(entry.name)) continue;
        if (stat.size > MAX_MEMORY_FILE_BYTES) continue;
        assertSafeFileMode(stat);
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        files.push({
          path: relativePath,
          name: entry.name,
          size: stat.size,
          updatedAt: stat.mtimeMs,
        });
      }
    }
    return files.sort((left, right) => right.updatedAt - left.updatedAt || left.path.localeCompare(right.path));
  }

  async readMemory(relativePath) {
    this.assertInitialized();
    const root = await this.safeMemoryRoot();
    if (!root) throw storeError(404, "当前账号尚未生成本地记忆");
    const normalizedPath = normalizeMemoryPath(relativePath);
    const target = path.resolve(root, ...normalizedPath.split("/"));
    assertInside(root, target);
    let realTarget;
    try {
      realTarget = await fs.realpath(target);
    } catch (error) {
      if (error.code === "ENOENT") throw storeError(404, "记忆文件不存在");
      throw error;
    }
    assertInside(root, realTarget);
    if (realTarget !== target) throw storeError(409, "记忆文件路径包含不安全的链接");
    const stat = await fs.lstat(realTarget);
    assertOwnedMemoryEntry(stat, this.uid, this.gid);
    if (!stat.isFile() || stat.isSymbolicLink()) throw storeError(400, "记忆路径不是普通文件");
    assertSafeFileMode(stat);
    if (!MEMORY_FILE_PATTERN.test(realTarget)) throw storeError(400, "该记忆文件格式不支持预览");
    if (stat.size > MAX_MEMORY_FILE_BYTES) throw storeError(413, "记忆文件过大，无法在网页中预览");
    const raw = await fs.readFile(realTarget, "utf8");
    if (raw.includes("\u0000")) throw storeError(400, "记忆文件不是可安全显示的文本");
    const content = redactMemorySecrets(raw);
    return {
      path: normalizedPath,
      name: path.basename(normalizedPath),
      size: stat.size,
      updatedAt: stat.mtimeMs,
      content,
      redacted: content !== raw,
    };
  }

  async safeMemoryRoot() {
    let stat;
    try {
      stat = await fs.lstat(this.memoryDirectory);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError(409, "Codex 记忆目录不是安全的真实目录");
    }
    assertOwnedMemoryEntry(stat, this.uid, this.gid);
    assertPrivateDirectoryMode(stat);
    const root = await fs.realpath(this.memoryDirectory);
    const codexHomeReal = await fs.realpath(this.codexHome);
    assertInside(codexHomeReal, root);
    return root;
  }

  async persist() {
    const operation = async () => {
      const temporaryPath = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporaryPath, this.indexPath);
      await fs.chmod(this.indexPath, 0o600);
    };
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.data) throw new Error("Codex memory store is not initialized");
  }
}

export function normalizeThreadMemoryMode(value) {
  if (value !== "enabled" && value !== "disabled") {
    throw storeError(400, "对话记忆模式无效");
  }
  return value;
}

export function normalizeCodexMemorySettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storeError(400, "Codex Memories 设置无效");
  }
  const allowed = new Set([
    "featureEnabled",
    "useMemories",
    "generateMemories",
    "disableOnExternalContext",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw storeError(400, "Codex Memories 设置包含未知字段");
  }
  const output = {};
  for (const key of allowed) {
    if (typeof value[key] !== "boolean") throw storeError(400, "Codex Memories 开关必须是布尔值");
    output[key] = value[key];
  }
  return output;
}

export function publicCodexMemoryConfiguration(configRead, featureList = null) {
  const config = isRecord(configRead?.config) ? configRead.config : {};
  const nativeFeature = Array.isArray(featureList?.data)
    ? featureList.data.find((entry) => entry?.name === "memories")
    : null;
  return {
    featureEnabled: config.features?.memories === true,
    useMemories: config.memories?.use_memories !== false,
    generateMemories: config.memories?.generate_memories !== false,
    disableOnExternalContext: config.memories?.disable_on_external_context === true
      || config.memories?.no_memories_if_mcp_or_web_search === true,
    supported: nativeFeature ? nativeFeature.stage !== "removed" : true,
    stage: typeof nativeFeature?.stage === "string" ? nativeFeature.stage : null,
  };
}

export function userCodexMemoryConfigMetadata(configRead) {
  const layers = Array.isArray(configRead?.layers) ? configRead.layers : [];
  const userLayer = layers.find((layer) => (
    layer?.name?.type === "user"
    && layer.name.profile == null
    && isRecord(layer.config)
  ));
  return {
    version: typeof userLayer?.version === "string" ? userLayer.version : null,
    filePath: typeof userLayer?.name?.file === "string" ? userLayer.name.file : null,
  };
}

export function redactMemorySecrets(value) {
  let output = String(value);
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function normalizeCodexMemoryThreadId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!THREAD_ID_PATTERN.test(id)) throw storeError(400, "对话编号无效");
  return id;
}

function normalizeMemoryPath(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 1_024 || raw.includes("\\") || /[\u0000\r\n]/.test(raw)) {
    throw storeError(400, "记忆文件路径无效");
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "."
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
    || !MEMORY_FILE_PATTERN.test(normalized)
  ) {
    throw storeError(400, "记忆文件路径无效");
  }
  return normalized;
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw storeError(409, "记忆文件路径越过了当前账号目录");
  }
}

function assertOwnedMemoryEntry(stat, uid, gid) {
  if (Number.isInteger(uid) && stat.uid !== uid) {
    throw storeError(409, "记忆文件属主与当前账号不匹配");
  }
  if (Number.isInteger(gid) && stat.gid !== gid) {
    throw storeError(409, "记忆文件属组与当前账号不匹配");
  }
}

function assertPrivateDirectoryMode(stat) {
  if ((stat.mode & 0o022) !== 0) throw storeError(409, "记忆目录允许其他账号写入，已拒绝读取");
}

function assertSafeFileMode(stat) {
  if ((stat.mode & 0o022) !== 0) throw storeError(409, "记忆文件允许其他账号写入，已拒绝读取");
}

function emptyIndex() {
  return { version: STORE_VERSION, threadModes: {} };
}

function normalizeIndex(value) {
  if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.threadModes)) return emptyIndex();
  const records = [];
  for (const [threadId, record] of Object.entries(value.threadModes)) {
    try {
      const id = normalizeCodexMemoryThreadId(threadId);
      const mode = normalizeThreadMemoryMode(record?.mode);
      const updatedAt = Number.isFinite(record?.updatedAt) && record.updatedAt > 0
        ? record.updatedAt
        : Date.now();
      records.push([id, { mode, updatedAt }]);
    } catch {
      // Ignore malformed private state instead of exposing it to the browser.
    }
  }
  records.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  return {
    version: STORE_VERSION,
    threadModes: Object.fromEntries(records.slice(0, MAX_THREAD_MODES)),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw new Error(`Unable to read ${path.basename(filePath)}: ${error.message}`);
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function storeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
