import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 1;
const SAFE_PATH = /^\/[A-Za-z0-9._+@:/ -]+$/u;

export class MobileAppConfigStore {
  constructor({
    stateDirectory,
    sourceDirectory,
    projectRoots = [],
    defaultProject = null,
    defaultStorageRoot = null,
  } = {}) {
    if (!stateDirectory || !sourceDirectory) throw new TypeError("stateDirectory and sourceDirectory are required");
    this.filePath = path.join(path.resolve(stateDirectory), "mobile-app-config.json");
    this.sourceDirectory = path.resolve(sourceDirectory);
    this.projectRoots = [...new Set(projectRoots.map((value) => path.resolve(value)))];
    this.defaultProject = path.resolve(defaultProject || path.join(this.sourceDirectory, "apps", "mobile"));
    this.defaultStorageRoot = path.resolve(
      defaultStorageRoot
        || process.env.WFL_MOBILE_APP_STORAGE_ROOT
        || path.join(this.sourceDirectory, ".codex-runtime", "mobile-app"),
    );
    this.value = null;
  }

  async initialize({ writeOnInitialize = true } = {}) {
    let stored = null;
    try {
      stored = normalizeStoredConfig(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    this.value = stored || this.defaultConfig();
    if (writeOnInitialize && !stored) await this.write();
    return this;
  }

  snapshot() {
    return structuredClone(this.value || this.defaultConfig());
  }

  layout() {
    const config = this.snapshot();
    const root = config.storageRoot;
    const projectKey = crypto.createHash("sha256").update(config.projectPath).digest("hex").slice(0, 16);
    return {
      root,
      flutterSdk: path.join(root, "flutter"),
      pubCache: path.join(root, "pub-cache"),
      generatedRoot: path.join(root, "generated"),
      generatedProject: path.join(root, "generated", `flutter-${projectKey}`),
      previews: path.join(root, "previews"),
      apk: path.join(root, "apk"),
      gradle: path.join(root, "gradle"),
      signing: path.join(root, "signing"),
      logs: path.join(root, "logs"),
    };
  }

  async ensureLayout() {
    const layout = this.layout();
    await Promise.all(Object.values(layout).map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o750 })));
    return layout;
  }

  async save({
    projectPath = this.snapshot().projectPath,
    storageRoot = this.snapshot().storageRoot,
    flutterBin = this.snapshot().flutterBin,
  } = {}) {
    const next = {
      version: CONFIG_VERSION,
      projectPath: normalizeProjectPath(projectPath, this.projectRoots, this.defaultProject),
      storageRoot: normalizeStorageRoot(storageRoot),
      flutterBin: normalizeFlutterBin(flutterBin),
      updatedAt: Date.now(),
    };
    if (isInside(next.projectPath, next.storageRoot)) {
      throw configError("移动 App 文件目录不能位于项目源码目录内");
    }
    this.value = next;
    await this.write();
    await this.ensureLayout();
    return this.snapshot();
  }

  defaultConfig() {
    return {
      version: CONFIG_VERSION,
      projectPath: this.defaultProject,
      storageRoot: this.defaultStorageRoot,
      flutterBin: null,
      updatedAt: null,
    };
  }

  async write() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export function normalizeProjectPath(value, projectRoots = [], fallback = null) {
  const candidate = normalizePath(value) || normalizePath(fallback);
  if (!candidate) throw configError("移动 App 项目路径无效");
  if (projectRoots.length && !projectRoots.some((root) => isInside(root, candidate))) {
    throw configError("移动 App 项目必须位于已配置的项目存储根目录内");
  }
  return candidate;
}

export function normalizeStorageRoot(value) {
  const candidate = normalizePath(value);
  if (!candidate || candidate === "/") throw configError("移动 App 文件目录必须是非根绝对路径");
  return candidate;
}

export function normalizeFlutterBin(value) {
  if (value === null || value === undefined || value === "") return null;
  const candidate = normalizePath(value);
  if (!candidate) throw configError("Flutter SDK 路径必须是绝对路径");
  return candidate;
}

function normalizeStoredConfig(value) {
  if (!value || typeof value !== "object" || value.version !== CONFIG_VERSION) return null;
  try {
    return {
      version: CONFIG_VERSION,
      projectPath: normalizePath(value.projectPath),
      storageRoot: normalizeStorageRoot(value.storageRoot),
      flutterBin: normalizeFlutterBin(value.flutterBin),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function normalizePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  if (!candidate.startsWith("/") || candidate.includes("\0") || candidate.split("/").includes("..")) return null;
  if (!SAFE_PATH.test(candidate)) return null;
  return path.resolve(candidate);
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function configError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "ERR_MOBILE_APP_CONFIG" });
}
