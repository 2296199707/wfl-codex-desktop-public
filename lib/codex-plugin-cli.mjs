export const OFFICIAL_CODEX_PLUGIN_MARKETPLACE = "openai-curated";

const PLUGIN_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GITHUB_MARKETPLACE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})(?:@[A-Za-z0-9][A-Za-z0-9._/-]{0,254})?$/;
const SCP_MARKETPLACE_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/;

export function normalizeCodexPluginId(value, { allowedMarketplaces = null } = {}) {
  const pluginId = String(value || "").trim().toLowerCase();
  const parts = pluginId.split("@");
  if (
    parts.length !== 2
    || !PLUGIN_PART_PATTERN.test(parts[0])
    || !PLUGIN_PART_PATTERN.test(parts[1])
  ) {
    throw new Error("Codex 插件标识必须使用 plugin@marketplace");
  }
  if (allowedMarketplaces && !allowedMarketplaces.has(parts[1])) {
    throw new Error("Codex 插件来源不在当前已配置市场中");
  }
  return `${parts[0]}@${parts[1]}`;
}

export function normalizeOfficialCodexPluginId(value) {
  let pluginId;
  try {
    pluginId = normalizeCodexPluginId(value);
  } catch {
    throw new Error("只允许管理 OpenAI 官方插件");
  }
  if (!pluginId.endsWith(`@${OFFICIAL_CODEX_PLUGIN_MARKETPLACE}`)) {
    throw new Error("只允许管理 OpenAI 官方插件");
  }
  return pluginId;
}

export function publicCodexPluginSnapshot(value) {
  const installed = normalizePluginRows(value?.installed, true);
  const installedIds = new Set(installed.map((plugin) => plugin.pluginId));
  const available = normalizePluginRows(value?.available, false)
    .map((plugin) => installedIds.has(plugin.pluginId) ? { ...plugin, installed: true } : plugin);
  const officialInstalled = installed.filter(isOfficialPlugin);
  const officialAvailable = available.filter(isOfficialPlugin);
  return {
    marketplace: OFFICIAL_CODEX_PLUGIN_MARKETPLACE,
    installed: uniquePlugins(officialInstalled),
    available: uniquePlugins(officialAvailable),
    updatedAt: Date.now(),
  };
}

export function publicCodexPluginCatalog(value, marketplaceValue, { includeRoots = false } = {}) {
  const marketplaces = normalizeMarketplaceRows(marketplaceValue?.marketplaces, { includeRoots });
  if (!marketplaces.some((marketplace) => marketplace.name === OFFICIAL_CODEX_PLUGIN_MARKETPLACE)) {
    marketplaces.unshift({
      name: OFFICIAL_CODEX_PLUGIN_MARKETPLACE,
      official: true,
      kind: "managed",
      root: null,
    });
  }
  const allowedMarketplaces = new Set(marketplaces.map((marketplace) => marketplace.name));
  const installed = normalizePluginRows(value?.installed, true, { allowedMarketplaces });
  const installedIds = new Set(installed.map((plugin) => plugin.pluginId));
  const available = normalizePluginRows(value?.available, false, { allowedMarketplaces })
    .map((plugin) => installedIds.has(plugin.pluginId) ? { ...plugin, installed: true } : plugin);
  return {
    marketplace: OFFICIAL_CODEX_PLUGIN_MARKETPLACE,
    marketplaces,
    installed: uniquePlugins(installed),
    available: uniquePlugins(available),
    updatedAt: Date.now(),
  };
}

export function normalizeCodexMarketplaceName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!PLUGIN_PART_PATTERN.test(name)) throw new Error("Codex 插件市场名称无效");
  return name;
}

export function normalizeCodexMarketplaceSource(value) {
  const source = String(value || "").trim();
  if (!source || source.length > 2_048 || /[\0\r\n]/.test(source) || source.startsWith("-")) {
    throw new Error("Codex 插件市场来源无效");
  }
  if (GITHUB_MARKETPLACE_PATTERN.test(source) || SCP_MARKETPLACE_PATTERN.test(source)) {
    return { source, kind: GITHUB_MARKETPLACE_PATTERN.test(source) ? "github" : "ssh" };
  }
  if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
    return { source, kind: "local" };
  }
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("市场来源需为 GitHub owner/repo、HTTPS、SSH 或工程内本地目录");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("插件市场 URL 不能包含账号、密码、查询参数或片段");
  }
  if (parsed.protocol === "https:") return { source: parsed.toString(), kind: "https" };
  if (parsed.protocol === "ssh:") return { source: parsed.toString(), kind: "ssh" };
  throw new Error("远程插件市场只允许 HTTPS 或 SSH");
}

export function normalizeCodexMarketplaceRef(value) {
  const ref = String(value || "").trim();
  if (!ref) return null;
  if (
    ref.length > 256
    || ref.startsWith("-")
    || /[\0-\x20\x7f~^:?*\[\\]/.test(ref)
    || ref.includes("..")
    || ref.includes("@{")
    || ref.endsWith(".")
    || ref.endsWith("/")
  ) {
    throw new Error("Codex 插件市场 Git ref 无效");
  }
  return ref;
}

export function normalizeCodexMarketplaceSparse(value) {
  if (value != null && !Array.isArray(value)) throw new Error("插件市场稀疏路径必须使用列表");
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > 16) throw new Error("插件市场稀疏路径不能超过 16 条");
  return [...new Set(rows.map((entry) => {
    const item = String(entry || "").trim().replaceAll("\\", "/");
    if (
      !item
      || item.length > 1_024
      || item.startsWith("-")
      || item.startsWith("/")
      || /[\0\r\n]/.test(item)
      || item.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Codex 插件市场稀疏路径无效");
    }
    return item;
  }))];
}

function normalizePluginRows(rows, installedFallback, { allowedMarketplaces = null } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 2_000).map((row) => {
    if (!row || typeof row !== "object") return null;
    let pluginId;
    try {
      pluginId = normalizeCodexPluginId(
        row.pluginId || `${String(row.name || "")}@${String(row.marketplaceName || "")}`,
        { allowedMarketplaces },
      );
    } catch {
      return null;
    }
    const [name, marketplaceName] = pluginId.split("@");
    return {
      pluginId,
      name,
      marketplaceName,
      version: safeText(row.version, 64),
      installed: row.installed === true || installedFallback,
      enabled: row.enabled === true,
      installPolicy: safeEnum(row.installPolicy, ["AVAILABLE", "REQUIRES_APPROVAL", "BLOCKED"]),
      authPolicy: safeEnum(row.authPolicy, ["NONE", "ON_INSTALL", "ON_USE"]),
    };
  }).filter(Boolean);
}

function normalizeMarketplaceRows(rows, { includeRoots }) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const result = [];
  for (const row of rows.slice(0, 128)) {
    if (!row || typeof row !== "object") continue;
    let name;
    try {
      name = normalizeCodexMarketplaceName(row.name);
    } catch {
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const root = typeof row.root === "string" && row.root.length <= 4_096 && !/[\0\r\n]/.test(row.root)
      ? row.root
      : null;
    result.push({
      name,
      official: name === OFFICIAL_CODEX_PLUGIN_MARKETPLACE,
      kind: name === OFFICIAL_CODEX_PLUGIN_MARKETPLACE ? "managed" : marketplaceRootKind(root),
      root: includeRoots ? root : null,
    });
  }
  return result;
}

function marketplaceRootKind(root) {
  if (!root) return "configured";
  return root.includes("/.tmp/") || root.includes("\\.tmp\\") ? "git-cache" : "local";
}

function isOfficialPlugin(plugin) {
  return plugin.marketplaceName === OFFICIAL_CODEX_PLUGIN_MARKETPLACE;
}

function uniquePlugins(rows) {
  const plugins = new Map();
  for (const row of rows) plugins.set(row.pluginId, row);
  return [...plugins.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function safeText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}
