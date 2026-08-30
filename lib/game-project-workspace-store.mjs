import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const GAME_PROJECT_WORKSPACE_STORE_VERSION = 1;

const DEFAULT_MAX_PROJECTS = 256;
const MAX_PROJECT_ID = 128;
const MAX_PROJECT_NAME = 240;
const MAX_PROJECT_PATH = 4_096;
const MAX_RELATIVE_PATH = 4_096;
const PRESETS = new Set(["building", "background"]);
const ORIENTATIONS = new Set(["orthogonal", "isometric", "staggered", "hexagonal", "oblique"]);

/**
 * Per-user registry for game projects. The registry stores routing metadata
 * only; it never owns or removes the actual project directory.
 */
export class GameProjectWorkspaceStore {
  constructor(stateDirectory, {
    now = () => Date.now(),
    randomId = () => crypto.randomUUID(),
    maxProjects = DEFAULT_MAX_PROJECTS,
  } = {}) {
    if (typeof stateDirectory !== "string" || !stateDirectory.trim()) {
      throw new TypeError("stateDirectory is required");
    }
    this.stateDirectory = path.resolve(stateDirectory);
    this.filePath = path.join(this.stateDirectory, "game-project-workspaces.json");
    this.now = typeof now === "function" ? now : () => Date.now();
    this.randomId = typeof randomId === "function" ? randomId : () => crypto.randomUUID();
    this.maxProjects = positiveInteger(maxProjects, DEFAULT_MAX_PROJECTS, "maxProjects");
    this.projects = new Map();
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize({ writeOnInitialize = false } = {}) {
    await fs.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.stateDirectory, 0o700);
    const loaded = await readState(this.filePath, this.maxProjects);
    this.projects = loaded.projects;
    this.initialized = true;
    if (writeOnInitialize && (loaded.normalized || !(await fileExists(this.filePath)))) {
      await this.write();
    }
    return this;
  }

  list() {
    this.assertInitialized();
    return [...this.projects.values()]
      .sort(compareProjects)
      .map(publicProject)
      .map(Object.freeze);
  }

  get(projectId) {
    this.assertInitialized();
    const id = normalizeProjectId(projectId);
    const project = this.projects.get(id);
    return project ? publicProject(project) : null;
  }

  findByPath(projectPath) {
    this.assertInitialized();
    const normalized = normalizeProjectPath(projectPath);
    const project = [...this.projects.values()].find((entry) => entry.projectPath === normalized);
    return project ? publicProject(project) : null;
  }

  async register(input = {}) {
    this.assertInitialized();
    const normalized = normalizeProjectInput(input, { requirePath: true });
    return this.mutate(async () => {
      const previous = new Map(this.projects);
      const existing = normalized.projectId
        ? this.projects.get(normalized.projectId) || null
        : [...this.projects.values()].find((entry) => entry.projectPath === normalized.projectPath) || null;
      if (normalized.projectId && !existing) {
        throw storeError(404, "GAME_PROJECT_NOT_FOUND", "游戏工程登记不存在");
      }
      const pathOwner = [...this.projects.values()].find((entry) => (
        entry.projectPath === normalized.projectPath && entry.projectId !== existing?.projectId
      ));
      if (pathOwner) throw storeError(409, "GAME_PROJECT_PATH_ALREADY_REGISTERED", "这个目录已经登记为游戏工程");
      if (!existing && this.projects.size >= this.maxProjects) {
        throw storeError(409, "GAME_PROJECT_LIMIT_REACHED", "游戏工程登记数量已达到上限");
      }
      const timestamp = this.now();
      const project = {
        projectId: existing?.projectId || normalizeProjectId(this.randomId()),
        name: normalized.name || existing?.name || path.basename(normalized.projectPath),
        projectPath: normalized.projectPath,
        projectFile: normalized.projectFile !== undefined
          ? normalized.projectFile
          : existing?.projectFile || null,
        initialMap: normalized.initialMap !== undefined
          ? normalized.initialMap
          : existing?.initialMap || null,
        preset: normalized.preset || existing?.preset || null,
        orientation: normalized.orientation || existing?.orientation || null,
        width: normalized.width ?? existing?.width ?? null,
        height: normalized.height ?? existing?.height ?? null,
        tilewidth: normalized.tilewidth ?? existing?.tilewidth ?? null,
        tileheight: normalized.tileheight ?? existing?.tileheight ?? null,
        initializeGit: normalized.initializeGit ?? existing?.initializeGit ?? false,
        recentResource: normalized.recentResource !== undefined
          ? normalized.recentResource
          : existing?.recentResource || null,
        recentEditor: normalized.recentEditor !== undefined
          ? normalized.recentEditor
          : existing?.recentEditor || null,
        revision: (existing?.revision || 0) + 1,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
        snapshotAt: normalized.snapshotAt ?? existing?.snapshotAt ?? null,
      };
      this.projects.set(project.projectId, project);
      this.evict();
      try {
        await this.write();
        return publicProject(project);
      } catch (error) {
        this.projects = previous;
        throw error;
      }
    });
  }

  async open({ projectId, relativePath = undefined, editor = undefined } = {}) {
    return this.touch(projectId, {
      ...(relativePath !== undefined ? { recentResource: relativePath } : {}),
      ...(editor !== undefined ? { recentEditor: editor } : {}),
    });
  }

  async snapshot(projectId, { recentResource = undefined, recentEditor = undefined } = {}) {
    return this.touch(projectId, {
      ...(recentResource !== undefined ? { recentResource } : {}),
      ...(recentEditor !== undefined ? { recentEditor } : {}),
      snapshotAt: this.now(),
    });
  }

  async remove(projectId, { expectedRevision = undefined } = {}) {
    this.assertInitialized();
    const id = normalizeProjectId(projectId);
    return this.mutate(async () => {
      const previous = new Map(this.projects);
      const current = this.projects.get(id);
      if (!current) throw storeError(404, "GAME_PROJECT_NOT_FOUND", "游戏工程登记不存在");
      if (expectedRevision !== undefined && normalizeRevision(expectedRevision) !== current.revision) {
        throw storeError(409, "GAME_PROJECT_REVISION_CONFLICT", "游戏工程记录已经变化，请刷新后重试");
      }
      this.projects.delete(id);
      try {
        await this.write();
        return publicProject(current);
      } catch (error) {
        this.projects = previous;
        throw error;
      }
    });
  }

  async touch(projectId, patch = {}) {
    this.assertInitialized();
    const id = normalizeProjectId(projectId);
    const normalized = normalizeTouchPatch(patch);
    return this.mutate(async () => {
      const previous = new Map(this.projects);
      const current = this.projects.get(id);
      if (!current) throw storeError(404, "GAME_PROJECT_NOT_FOUND", "游戏工程登记不存在");
      const next = {
        ...current,
        ...normalized,
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      this.projects.set(id, next);
      try {
        await this.write();
        return publicProject(next);
      } catch (error) {
        this.projects = previous;
        throw error;
      }
    });
  }

  async write() {
    this.assertInitialized();
    const temporary = `${this.filePath}.${process.pid}.${this.randomId()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      version: GAME_PROJECT_WORKSPACE_STORE_VERSION,
      projects: [...this.projects.values()].map(storedProject),
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  evict() {
    while (this.projects.size > this.maxProjects) {
      const oldest = [...this.projects.values()]
        .sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0))[0];
      if (!oldest) break;
      this.projects.delete(oldest.projectId);
    }
  }

  mutate(operation) {
    this.assertInitialized();
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Game project workspace store is not initialized");
  }
}

function normalizeProjectInput(input, { requirePath = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程记录无效");
  }
  const projectPath = input.projectPath == null || input.projectPath === ""
    ? null
    : normalizeProjectPath(input.projectPath);
  if (requirePath && !projectPath) throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程目录不能为空");
  return {
    projectId: input.projectId == null || input.projectId === "" ? null : normalizeProjectId(input.projectId),
    name: input.name == null || input.name === "" ? null : normalizeProjectName(input.name),
    projectPath,
    projectFile: input.projectFile === undefined || input.projectFile === null || input.projectFile === ""
      ? input.projectFile === undefined ? undefined : null
      : normalizeRelativePath(input.projectFile),
    initialMap: input.initialMap === undefined || input.initialMap === null || input.initialMap === ""
      ? input.initialMap === undefined ? undefined : null
      : normalizeRelativePath(input.initialMap),
    preset: input.preset === undefined || input.preset === null || input.preset === ""
      ? input.preset === undefined ? undefined : null
      : normalizePreset(input.preset),
    orientation: input.orientation === undefined || input.orientation === null || input.orientation === ""
      ? input.orientation === undefined ? undefined : null
      : normalizeOrientation(input.orientation),
    width: optionalPositiveInteger(input.width, "width"),
    height: optionalPositiveInteger(input.height, "height"),
    tilewidth: optionalPositiveInteger(input.tilewidth, "tilewidth"),
    tileheight: optionalPositiveInteger(input.tileheight, "tileheight"),
    initializeGit: input.initializeGit === undefined ? undefined : Boolean(input.initializeGit),
    recentResource: input.recentResource === undefined || input.recentResource === null || input.recentResource === ""
      ? input.recentResource === undefined ? undefined : null
      : normalizeRelativePath(input.recentResource),
    recentEditor: input.recentEditor === undefined || input.recentEditor === null || input.recentEditor === ""
      ? input.recentEditor === undefined ? undefined : null
      : normalizeEditor(input.recentEditor),
    snapshotAt: input.snapshotAt === undefined || input.snapshotAt === null
      ? input.snapshotAt === undefined ? undefined : null
      : normalizeTimestamp(input.snapshotAt),
  };
}

function normalizeTouchPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程更新无效");
  }
  const patch = {};
  if (Object.hasOwn(input, "recentResource")) {
    patch.recentResource = input.recentResource == null || input.recentResource === ""
      ? null
      : normalizeRelativePath(input.recentResource);
  }
  if (Object.hasOwn(input, "recentEditor")) {
    patch.recentEditor = input.recentEditor == null || input.recentEditor === ""
      ? null
      : normalizeEditor(input.recentEditor);
  }
  if (Object.hasOwn(input, "snapshotAt")) {
    patch.snapshotAt = input.snapshotAt == null ? null : normalizeTimestamp(input.snapshotAt);
  }
  return patch;
}

function normalizeProjectId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_PROJECT_ID || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(text)) {
    throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程 ID 无效");
  }
  return text;
}

function normalizeProjectName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_PROJECT_NAME || /[\0\r\n]/u.test(text)) {
    throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程名称无效");
  }
  return text;
}

function normalizeProjectPath(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_PROJECT_PATH || !path.isAbsolute(text) || text.includes("\0")) {
    throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程目录必须是绝对路径");
  }
  return path.resolve(text);
}

function normalizeRelativePath(value) {
  const text = String(value || "").trim();
  if (
    !text
    || text.length > MAX_RELATIVE_PATH
    || text.includes("\0")
    || text.includes("\\")
    || path.posix.isAbsolute(text)
    || /^[a-z][a-z0-9+.-]*:/iu.test(text)
  ) throw storeError(400, "GAME_PROJECT_INVALID", "资源路径必须是工程相对路径");
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw storeError(400, "GAME_PROJECT_INVALID", "资源路径无效");
  }
  return segments.join("/");
}

function normalizePreset(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!PRESETS.has(text)) throw storeError(400, "GAME_PROJECT_INVALID", "游戏工程地图预设无效");
  return text;
}

function normalizeOrientation(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!ORIENTATIONS.has(text)) throw storeError(400, "GAME_PROJECT_INVALID", "地图方向无效");
  return text;
}

function normalizeEditor(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 120 || /[\0\r\n]/u.test(text)) {
    throw storeError(400, "GAME_PROJECT_INVALID", "编辑器标识无效");
  }
  return text;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw storeError(400, "GAME_PROJECT_INVALID", "时间戳无效");
  }
  return timestamp;
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw storeError(400, "GAME_PROJECT_INVALID", `${label} 必须是正整数`);
  }
  return number;
}

function positiveInteger(value, fallback, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function normalizeRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw storeError(400, "GAME_PROJECT_INVALID", "工程记录修订号无效");
  }
  return revision;
}

function compareProjects(left, right) {
  return (right.updatedAt || 0) - (left.updatedAt || 0)
    || left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
}

function publicProject(project) {
  return {
    gameProject: true,
    projectId: project.projectId,
    name: project.name,
    projectPath: project.projectPath,
    projectFile: project.projectFile,
    initialMap: project.initialMap,
    preset: project.preset,
    orientation: project.orientation,
    width: project.width,
    height: project.height,
    tilewidth: project.tilewidth,
    tileheight: project.tileheight,
    initializeGit: project.initializeGit,
    recentResource: project.recentResource,
    recentEditor: project.recentEditor,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    snapshotAt: project.snapshotAt,
  };
}

function storedProject(project) {
  return {
    projectId: project.projectId,
    name: project.name,
    projectPath: project.projectPath,
    projectFile: project.projectFile,
    initialMap: project.initialMap,
    preset: project.preset,
    orientation: project.orientation,
    width: project.width,
    height: project.height,
    tilewidth: project.tilewidth,
    tileheight: project.tileheight,
    initializeGit: project.initializeGit,
    recentResource: project.recentResource,
    recentEditor: project.recentEditor,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    snapshotAt: project.snapshotAt,
  };
}

function storeError(statusCode, code, message) {
  const error = new Error(message);
  error.name = "GameProjectWorkspaceStoreError";
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function readState(filePath, maxProjects) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!raw || raw.version !== GAME_PROJECT_WORKSPACE_STORE_VERSION || !Array.isArray(raw.projects)) {
      return { projects: new Map(), normalized: true };
    }
    const projects = new Map();
    let normalized = raw.projects.length > maxProjects;
    for (const value of raw.projects.slice(-maxProjects)) {
      try {
        const input = normalizeProjectInput(value, { requirePath: true });
        const projectId = normalizeProjectId(value.projectId);
        const revision = normalizeRevision(value.revision);
        const createdAt = normalizeTimestamp(value.createdAt);
        const updatedAt = normalizeTimestamp(value.updatedAt);
        if (updatedAt < createdAt || projects.has(projectId)) throw new Error("invalid project metadata");
        const project = {
          ...input,
          projectId,
          revision,
          createdAt,
          updatedAt,
          snapshotAt: value.snapshotAt == null ? null : normalizeTimestamp(value.snapshotAt),
          name: input.name || path.basename(input.projectPath),
        };
        if ([...projects.values()].some((entry) => entry.projectPath === project.projectPath)) {
          throw new Error("duplicate project path");
        }
        projects.set(projectId, project);
      } catch {
        normalized = true;
      }
    }
    return { projects, normalized };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { projects: new Map(), normalized: true };
    }
    throw error;
  }
}
