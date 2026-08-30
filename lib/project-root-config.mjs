import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_PROJECT_ROOTS,
  isSafeProjectRoot,
  normalizeProjectRoots,
  projectRootId,
  publicProjectRoots,
} from "./project-roots.mjs";

const STORE_VERSION = 1;
const MAX_DATA_ROOTS = Math.max(0, MAX_PROJECT_ROOTS - 1);

export class ProjectRootConfigStore {
  constructor(filePath, {
    primaryRoot,
    environmentRoots = null,
    now = () => Date.now(),
  } = {}) {
    this.filePath = path.resolve(requiredPath(filePath, "项目存储配置文件"));
    this.primaryRoot = normalizePrimaryRoot(primaryRoot);
    this.environmentRoots = normalizeProjectRoots(
      environmentRoots || [this.primaryRoot],
      this.primaryRoot,
    );
    this.now = now;
    this.config = null;
    this.configError = null;
    this.writeQueue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.config = {
        version: STORE_VERSION,
        dataRoots: normalizeDataRoots(value?.dataRoots, this.primaryRoot),
        updatedAt: Number.isFinite(value?.updatedAt) ? value.updatedAt : null,
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.configError = "项目存储配置无效，已回退到服务环境配置";
      }
      this.config = null;
    }
    this.initialized = true;
    return this;
  }

  configuredDataRoots() {
    this.assertInitialized();
    if (this.config) return [...this.config.dataRoots];
    return this.environmentRoots.filter((root) => root !== this.primaryRoot);
  }

  hasPersistedConfig() {
    this.assertInitialized();
    return Boolean(this.config);
  }

  async previewDataRoots(value) {
    this.assertInitialized();
    const dataRoots = normalizeDataRoots(value, this.primaryRoot);
    return {
      dataRoots,
      activeRoots: await this.resolveRoots(dataRoots),
    };
  }

  setDataRoots(value) {
    const task = this.writeQueue.then(async () => {
      const preview = await this.previewDataRoots(value);
      const config = {
        version: STORE_VERSION,
        dataRoots: preview.dataRoots,
        updatedAt: this.now(),
      };
      await writeJsonAtomic(this.filePath, config);
      this.config = config;
      this.configError = null;
      return preview;
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async resolveRoots(dataRoots = undefined) {
    this.assertInitialized();
    const configured = dataRoots === undefined ? this.configuredDataRoots() : dataRoots;
    const roots = [this.primaryRoot];
    for (const root of normalizeDataRoots(configured, this.primaryRoot)) {
      const inspection = await inspectProjectRoot(root);
      if (inspection.active) roots.push(root);
    }
    return normalizeProjectRoots(roots, this.primaryRoot);
  }

  async snapshot({ activeRoots = null, defaultProject = null } = {}) {
    this.assertInitialized();
    const configured = this.configuredDataRoots();
    const resolvedRoots = activeRoots || await this.resolveRoots(configured);
    const active = new Set(resolvedRoots.map((root) => path.resolve(root)));
    const dataRoots = await Promise.all(configured.map(async (root, index) => {
      const inspection = await inspectProjectRoot(root);
      return {
        id: projectRootId(root),
        path: root,
        label: `数据盘 ${index + 1}`,
        active: inspection.active && active.has(root),
        status: inspection.status,
        reason: inspection.reason,
      };
    }));
    return {
      version: STORE_VERSION,
      primary: {
        id: projectRootId(this.primaryRoot),
        path: this.primaryRoot,
        label: "主存储",
        active: true,
      },
      dataRoots,
      roots: publicProjectRoots(resolvedRoots, defaultProject),
      defaultProject: defaultProject ? path.resolve(defaultProject) : null,
      updatedAt: this.config?.updatedAt || null,
      ...(this.configError ? { warning: this.configError } : {}),
    };
  }

  assertInitialized() {
    if (!this.initialized) throw new Error("Project root config is not initialized");
  }
}

export function normalizeDataRoots(value, primaryRoot = null) {
  if (!Array.isArray(value)) throw new Error("附加数据盘目录必须是数组");
  const primary = primaryRoot ? normalizePrimaryRoot(primaryRoot) : null;
  const roots = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("附加数据盘目录必须是绝对路径");
    const input = raw.trim();
    if (!input) continue;
    if (!path.isAbsolute(input)) throw new Error("附加数据盘目录必须是绝对路径");
    const candidate = normalizeProjectRoots([input], primary || "/srv")[0];
    if (candidate === primary || roots.includes(candidate)) continue;
    roots.push(candidate);
  }
  if (roots.length > MAX_DATA_ROOTS) {
    throw new Error(`附加数据盘目录最多支持 ${MAX_DATA_ROOTS} 个`);
  }
  return roots;
}

export async function inspectProjectRoot(root) {
  const candidate = path.resolve(String(root || ""));
  if (!isSafeProjectRoot(candidate)) {
    return { active: false, status: "invalid", reason: "路径不是有效的绝对目录" };
  }
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return { active: false, status: "unavailable", reason: "目录不存在或尚未挂载" };
    }
    return { active: false, status: "unavailable", reason: "目录当前无法访问" };
  }
  if (stat.isSymbolicLink()) {
    return { active: false, status: "invalid", reason: "不启用符号链接目录" };
  }
  if (!stat.isDirectory()) {
    return { active: false, status: "invalid", reason: "路径不是目录" };
  }
  try {
    await fs.realpath(candidate);
  } catch {
    return { active: false, status: "unavailable", reason: "目录当前无法访问" };
  }
  return { active: true, status: "active", reason: "已启用" };
}

function normalizePrimaryRoot(value) {
  const roots = normalizeProjectRoots([String(value || "")], "/srv");
  return roots[0];
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
