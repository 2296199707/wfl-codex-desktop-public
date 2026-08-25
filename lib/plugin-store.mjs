import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 2;
const SUPPORTED_MANIFEST_FORMATS = new Set([1, 2]);
const SUPPORTED_CAPABILITIES = new Set([
  "temporary-ssh-access",
  "persistent-ssh-servers",
  "windows-codex-remote",
  "creator-worker",
  "android-drive-builder",
  "android-apk-builder",
  "ai-provider-real-test",
]);
const SUPPORTED_PERMISSIONS = new Set([
  "network:ssh",
  "network:ai-provider",
  "credential:one-time",
  "credential:encrypted",
  "temporary-key:write",
  "server:profile",
  "command:remote",
  "device:pair",
  "device:connect",
  "codex:local-app-server",
  "thread:read",
  "thread:resume",
  "turn:start",
  "workspace:read",
  "workspace:write",
  "job:run",
  "tool:allowlisted",
  "build:android",
  "credential:signing",
  "credential:export",
]);
const CAPABILITY_PERMISSIONS = new Map([
  ["temporary-ssh-access", new Set(["network:ssh", "credential:one-time", "temporary-key:write"])],
  ["persistent-ssh-servers", new Set([
    "network:ssh",
    "credential:encrypted",
    "server:profile",
    "command:remote",
  ])],
  ["windows-codex-remote", new Set([
    "device:pair",
    "device:connect",
    "codex:local-app-server",
    "thread:read",
    "thread:resume",
    "turn:start",
  ])],
  ["creator-worker", new Set([
    "device:pair",
    "device:connect",
    "workspace:read",
    "workspace:write",
    "job:run",
    "tool:allowlisted",
  ])],
  ["android-drive-builder", new Set([
    "build:android",
    "credential:encrypted",
    "tool:allowlisted",
  ])],
  ["android-apk-builder", new Set([
    "build:android",
    "credential:encrypted",
    "tool:allowlisted",
  ])],
  ["ai-provider-real-test", new Set([
    "network:ai-provider",
    "credential:encrypted",
    "tool:allowlisted",
  ])],
]);
const SUPPORTED_RISKS = new Set(["low", "medium", "high"]);
const SUPPORTED_CATEGORIES = new Set(["infrastructure", "remote-access", "creative-production"]);
const SUPPORTED_PLATFORMS = new Set(["linux", "windows", "macos"]);

export class PluginStore {
  constructor(catalogDirectory, stateDirectory, { now = () => Date.now(), appVersion = null } = {}) {
    this.catalogDirectory = catalogDirectory;
    this.installDirectory = path.join(stateDirectory, "plugins");
    this.storePath = path.join(stateDirectory, "plugins.json");
    this.now = now;
    this.appVersion = appVersion && normalizeVersion(appVersion);
    this.catalog = new Map();
    this.installed = [];
    this.grants = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.installDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.installDirectory, 0o700);
    this.catalog = await loadCatalog(this.catalogDirectory);
    const state = await this.readStore();
    this.installed = state.installed;
    this.grants = state.grants;
    return this;
  }

  snapshot({ viewer = null, includeGrants = false } = {}) {
    return {
      platformVersion: 2,
      source: {
        id: "wfl-official",
        name: "WFL 官方插件目录",
        trust: "bundled",
      },
      plugins: [...this.catalog.values()].map((entry) => {
        const installed = this.installed.find((item) => item.id === entry.manifest.id);
        const compatibility = pluginCompatibility(entry.manifest, this.appVersion);
        const grants = this.grants.filter((grant) => grant.pluginId === entry.manifest.id);
        return {
          ...entry.manifest,
          downloadSize: entry.downloadSize,
          installed: Boolean(installed),
          enabled: Boolean(installed?.enabled),
          installedVersion: installed?.version || null,
          updateAvailable: Boolean(installed && installed.version !== entry.manifest.version),
          installedAt: installed?.installedAt || null,
          compatible: compatibility.compatible,
          compatibilityReason: compatibility.reason,
          authorized: viewer ? this.isAuthorized(entry.manifest.id, viewer) : null,
          grantCount: grants.length,
          ...(includeGrants ? { grantedUserIds: grants.map((grant) => grant.userId) } : {}),
        };
      }),
    };
  }

  isEnabled(id) {
    return this.installed.some((entry) => entry.id === id && entry.enabled);
  }

  isAuthorized(id, user) {
    const catalogEntry = this.catalog.get(String(id));
    if (!catalogEntry || !this.isEnabled(id) || !user || user.status === "disabled") return false;
    if (user.role === "owner" || user.role === "admin") return true;
    if (user.permissions?.codexPlugins !== true) return false;
    if (catalogEntry.manifest.perUserAuthorization !== true) return true;
    return this.grants.some((grant) => grant.pluginId === id && grant.userId === user.id);
  }

  async install(id) {
    return this.mutate(async () => {
      const catalogEntry = this.requireCatalogEntry(id);
      const compatibility = pluginCompatibility(catalogEntry.manifest, this.appVersion);
      if (!compatibility.compatible) throw pluginError(409, compatibility.reason);
      this.assertDependenciesReady(catalogEntry.manifest);
      const now = this.now();
      const existing = this.installed.find((entry) => entry.id === id);
      const installed = {
        id,
        version: catalogEntry.manifest.version,
        enabled: true,
        installedAt: existing?.installedAt || now,
        updatedAt: now,
      };
      this.installed = [installed, ...this.installed.filter((entry) => entry.id !== id)];
      await this.installManifest(catalogEntry.manifest);
      await this.writeStore();
      return this.publicPlugin(id);
    });
  }

  async setEnabled(id, enabled) {
    return this.mutate(async () => {
      const installed = this.installed.find((entry) => entry.id === id);
      if (!installed) throw pluginError(404, "插件尚未安装");
      if (enabled) {
        const catalogEntry = this.requireCatalogEntry(id);
        const compatibility = pluginCompatibility(catalogEntry.manifest, this.appVersion);
        if (!compatibility.compatible) throw pluginError(409, compatibility.reason);
        this.assertDependenciesReady(catalogEntry.manifest);
      } else {
        const dependent = this.enabledDependent(id);
        if (dependent) throw pluginError(409, `请先停用依赖此插件的 ${dependent.name}`);
      }
      installed.enabled = Boolean(enabled);
      installed.updatedAt = this.now();
      await this.writeStore();
      return this.publicPlugin(id);
    });
  }

  async uninstall(id) {
    return this.mutate(async () => {
      const dependent = this.installedDependent(id);
      if (dependent) throw pluginError(409, `请先卸载依赖此插件的 ${dependent.name}`);
      const before = this.installed.length;
      this.installed = this.installed.filter((entry) => entry.id !== id);
      if (before === this.installed.length) throw pluginError(404, "插件尚未安装");
      this.grants = this.grants.filter((grant) => grant.pluginId !== id);
      await fs.rm(path.join(this.installDirectory, id), { recursive: true, force: true });
      await this.writeStore();
    });
  }

  async grant(id, userId, grantedBy) {
    return this.mutate(async () => {
      const catalogEntry = this.requireCatalogEntry(id);
      if (!this.isEnabled(id)) throw pluginError(409, "插件尚未安装并启用");
      if (catalogEntry.manifest.perUserAuthorization !== true) {
        throw pluginError(409, "此插件不需要按用户授权");
      }
      const normalizedUserId = normalizeOpaqueId(userId, "用户 ID");
      const normalizedActorId = normalizeOpaqueId(grantedBy, "授权账号 ID");
      const now = this.now();
      const existing = this.grants.find((grant) => grant.pluginId === id && grant.userId === normalizedUserId);
      const grant = {
        pluginId: id,
        userId: normalizedUserId,
        grantedBy: normalizedActorId,
        grantedAt: existing?.grantedAt || now,
        updatedAt: now,
      };
      this.grants = [
        grant,
        ...this.grants.filter((entry) => entry.pluginId !== id || entry.userId !== normalizedUserId),
      ];
      await this.writeStore();
      return { ...grant };
    });
  }

  async revokeGrant(id, userId) {
    return this.mutate(async () => {
      this.requireCatalogEntry(id);
      const normalizedUserId = normalizeOpaqueId(userId, "用户 ID");
      const before = this.grants.length;
      this.grants = this.grants.filter((grant) => grant.pluginId !== id || grant.userId !== normalizedUserId);
      if (before === this.grants.length) throw pluginError(404, "未找到用户插件授权");
      await this.writeStore();
    });
  }

  requireCatalogEntry(id) {
    if (!validPluginId(id)) throw pluginError(400, "插件 ID 格式不正确");
    const entry = this.catalog.get(id);
    if (!entry) throw pluginError(404, "插件目录中不存在此插件");
    return entry;
  }

  assertDependenciesReady(manifest) {
    const missing = manifest.dependencies.filter((dependency) => !this.isEnabled(dependency));
    if (missing.length) throw pluginError(409, `请先安装并启用依赖插件：${missing.join("、")}`);
  }

  enabledDependent(id) {
    return [...this.catalog.values()]
      .map((entry) => entry.manifest)
      .find((manifest) => manifest.dependencies.includes(id) && this.isEnabled(manifest.id)) || null;
  }

  installedDependent(id) {
    return [...this.catalog.values()]
      .map((entry) => entry.manifest)
      .find((manifest) => manifest.dependencies.includes(id)
        && this.installed.some((installed) => installed.id === manifest.id)) || null;
  }

  publicPlugin(id) {
    const plugin = this.snapshot().plugins.find((entry) => entry.id === id);
    if (!plugin) throw pluginError(404, "插件目录中不存在此插件");
    return plugin;
  }

  async installManifest(manifest) {
    const directory = path.join(this.installDirectory, manifest.id);
    const destination = path.join(directory, "plugin.json");
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  }

  async readStore() {
    try {
      const data = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (![1, STORE_VERSION].includes(data?.version) || !Array.isArray(data.installed)) {
        throw new Error("Unsupported plugin store format");
      }
      return {
        installed: data.installed.map(normalizeInstalled).filter((entry) => this.catalog.has(entry.id)),
        grants: data.version === STORE_VERSION && Array.isArray(data.grants)
          ? data.grants.map(normalizeGrant).filter((entry) => this.catalog.has(entry.pluginId))
          : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法读取插件状态: ${error.message}`);
      return { installed: [], grants: [] };
    }
  }

  async writeStore() {
    const content = `${JSON.stringify({
      version: STORE_VERSION,
      installed: this.installed,
      grants: this.grants,
    }, null, 2)}\n`;
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, this.storePath);
    await fs.chmod(this.storePath, 0o600);
  }

  mutate(operation) {
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }
}

async function loadCatalog(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const catalog = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !validPluginId(entry.name)) continue;
    const manifestPath = path.join(directory, entry.name, "plugin.json");
    const source = await fs.readFile(manifestPath, "utf8");
    const manifest = normalizeManifest(JSON.parse(source));
    if (manifest.id !== entry.name) throw new Error(`Plugin directory mismatch: ${entry.name}`);
    if (catalog.has(manifest.id)) throw new Error(`Duplicate plugin ID: ${manifest.id}`);
    catalog.set(manifest.id, { manifest, downloadSize: Buffer.byteLength(source) });
  }
  validateCatalogDependencies(catalog);
  return catalog;
}

function validateCatalogDependencies(catalog) {
  for (const { manifest } of catalog.values()) {
    for (const dependency of manifest.dependencies) {
      if (!catalog.has(dependency)) throw new Error(`Unknown plugin dependency: ${manifest.id} -> ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cyclic plugin dependency: ${id}`);
    visiting.add(id);
    for (const dependency of catalog.get(id).manifest.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of catalog.keys()) visit(id);
}

function normalizeManifest(value) {
  const format = Number(value?.format);
  if (!SUPPORTED_MANIFEST_FORMATS.has(format)) throw new Error("Unsupported plugin manifest format");
  const id = String(value.id || "");
  const name = String(value.name || "").trim();
  const version = String(value.version || "");
  const publisher = String(value.publisher || "").trim();
  const summary = String(value.summary || "").trim();
  const icon = String(value.icon || "");
  const capability = String(value.capability || "");
  const permissions = Array.isArray(value.permissions) ? [...new Set(value.permissions.map(String))] : [];
  if (!validPluginId(id)) throw new Error("Invalid plugin ID");
  if (!name || name.length > 64 || !publisher || publisher.length > 64) throw new Error("Invalid plugin identity");
  if (!summary || summary.length > 240) throw new Error("Invalid plugin summary");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid plugin version");
  if (!/^[a-z0-9-]{1,48}$/.test(icon)) throw new Error("Invalid plugin icon");
  if (!SUPPORTED_CAPABILITIES.has(capability)) throw new Error("Unsupported plugin capability");
  if (!permissions.length || permissions.some((permission) => !SUPPORTED_PERMISSIONS.has(permission))) {
    throw new Error("Unsupported plugin permission");
  }
  const requiredPermissions = CAPABILITY_PERMISSIONS.get(capability);
  if (permissions.length !== requiredPermissions.size || permissions.some((permission) => !requiredPermissions.has(permission))) {
    throw new Error("Plugin permissions do not match capability");
  }
  if (format === 1) {
    return {
      format,
      id,
      name,
      version,
      publisher,
      summary,
      icon,
      capability,
      permissions,
      category: "infrastructure",
      risk: "high",
      platforms: ["linux"],
      compatibility: { minAppVersion: "0.1.0", maxAppVersion: null },
      companion: null,
      dependencies: [],
      perUserAuthorization: false,
    };
  }
  const category = String(value.category || "");
  const risk = String(value.risk || "");
  const platforms = Array.isArray(value.platforms) ? [...new Set(value.platforms.map(String))] : [];
  const compatibility = normalizeCompatibility(value.compatibility);
  const companion = value.companion === null || value.companion === undefined
    ? null
    : normalizeCompanion(value.companion);
  const dependencies = Array.isArray(value.dependencies) ? [...new Set(value.dependencies.map(String))] : [];
  if (!SUPPORTED_CATEGORIES.has(category)) throw new Error("Unsupported plugin category");
  if (!SUPPORTED_RISKS.has(risk)) throw new Error("Unsupported plugin risk");
  if (!platforms.length || platforms.some((platform) => !SUPPORTED_PLATFORMS.has(platform))) {
    throw new Error("Unsupported plugin platform");
  }
  if (dependencies.some((dependency) => !validPluginId(dependency) || dependency === id)) {
    throw new Error("Invalid plugin dependency");
  }
  return {
    format,
    id,
    name,
    version,
    publisher,
    summary,
    icon,
    capability,
    permissions,
    category,
    risk,
    platforms,
    compatibility,
    companion,
    dependencies,
    perUserAuthorization: value.perUserAuthorization === true,
  };
}

function normalizeInstalled(value) {
  const id = String(value?.id || "");
  const version = String(value?.version || "");
  const installedAt = Number(value?.installedAt);
  const updatedAt = Number(value?.updatedAt);
  if (!validPluginId(id) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid installed plugin");
  if (!Number.isFinite(installedAt) || installedAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error("Invalid plugin timestamp");
  }
  return { id, version, enabled: value.enabled === true, installedAt, updatedAt };
}

function normalizeGrant(value) {
  const pluginId = String(value?.pluginId || "");
  const userId = normalizeOpaqueId(value?.userId, "用户 ID");
  const grantedBy = normalizeOpaqueId(value?.grantedBy, "授权账号 ID");
  const grantedAt = Number(value?.grantedAt);
  const updatedAt = Number(value?.updatedAt);
  if (!validPluginId(pluginId)) throw new Error("Invalid plugin grant");
  if (!Number.isFinite(grantedAt) || grantedAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error("Invalid plugin grant timestamp");
  }
  return { pluginId, userId, grantedBy, grantedAt, updatedAt };
}

function normalizeCompatibility(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin compatibility");
  const minAppVersion = normalizeVersion(value.minAppVersion);
  const maxAppVersion = value.maxAppVersion === null || value.maxAppVersion === undefined
    ? null
    : normalizeVersion(value.maxAppVersion);
  if (maxAppVersion && compareVersions(minAppVersion, maxAppVersion) > 0) {
    throw new Error("Invalid plugin compatibility range");
  }
  return { minAppVersion, maxAppVersion };
}

function normalizeCompanion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin companion");
  const id = String(value.id || "");
  const name = String(value.name || "").trim();
  const protocolVersion = Number(value.protocolVersion);
  const minVersion = normalizeVersion(value.minVersion);
  const install = String(value.install || "");
  if (!validPluginId(id) || !name || name.length > 64) throw new Error("Invalid plugin companion identity");
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1 || protocolVersion > 100) {
    throw new Error("Invalid plugin companion protocol");
  }
  if (install !== "manual") throw new Error("Unsupported plugin companion installation");
  if (value.requiresUserConfirmation !== true) throw new Error("Companion installation must require confirmation");
  return { id, name, protocolVersion, minVersion, install, requiresUserConfirmation: true };
}

function pluginCompatibility(manifest, appVersion) {
  if (!appVersion) return { compatible: true, reason: null };
  if (compareVersions(appVersion, manifest.compatibility.minAppVersion) < 0) {
    return { compatible: false, reason: `需要 WFL v${manifest.compatibility.minAppVersion} 或更高版本` };
  }
  if (manifest.compatibility.maxAppVersion && compareVersions(appVersion, manifest.compatibility.maxAppVersion) > 0) {
    return { compatible: false, reason: `仅兼容至 WFL v${manifest.compatibility.maxAppVersion}` };
  }
  return { compatible: true, reason: null };
}

function normalizeVersion(value) {
  const version = String(value || "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error("Invalid semantic version");
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(".").map(Number);
  const b = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function normalizeOpaqueId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

function validPluginId(value) {
  return /^[a-z][a-z0-9-]{2,63}$/.test(String(value));
}

function pluginError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
