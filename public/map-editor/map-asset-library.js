const ASSET_KINDS = new Set(["image", "tileset", "template", "composite-map", "directory"]);

export function createMapAssetLibrary(input = {}) {
  const entries = new Map();
  for (const raw of Array.isArray(input.entries) ? input.entries : []) {
    const asset = normalizeAsset(raw);
    if (asset) entries.set(asset.path, asset);
  }
  return Object.freeze({
    version: 1,
    projectPath: String(input.projectPath || ""),
    entries,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  });
}

export function upsertMapAsset(library, raw, now = Date.now()) {
  const asset = normalizeAsset(raw);
  if (!asset) throw assetError("MAP_ASSET_INVALID", "素材条目无效");
  const entries = new Map(library?.entries instanceof Map ? library.entries : []);
  const previous = entries.get(asset.path);
  entries.set(asset.path, Object.freeze({
    ...asset,
    favorite: raw.favorite === undefined ? previous?.favorite === true : raw.favorite === true,
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : previous?.lastUsedAt || 0,
    indexedAt: previous?.indexedAt || now,
  }));
  return libraryWithEntries(library, entries, now);
}

export function removeMapAsset(library, resourcePath, now = Date.now()) {
  const path = normalizeAssetPath(resourcePath);
  const entries = new Map(library?.entries instanceof Map ? library.entries : []);
  entries.delete(path);
  return libraryWithEntries(library, entries, now);
}

export function setMapAssetFavorite(library, resourcePath, favorite, now = Date.now()) {
  const path = normalizeAssetPath(resourcePath);
  const existing = library?.entries instanceof Map ? library.entries.get(path) : null;
  if (!existing) throw assetError("MAP_ASSET_NOT_FOUND", "素材不在当前素材库");
  const entries = new Map(library.entries);
  entries.set(path, Object.freeze({ ...existing, favorite: favorite === true }));
  return libraryWithEntries(library, entries, now);
}

export function touchMapAsset(library, resourcePath, now = Date.now()) {
  const path = normalizeAssetPath(resourcePath);
  const existing = library?.entries instanceof Map ? library.entries.get(path) : null;
  if (!existing) throw assetError("MAP_ASSET_NOT_FOUND", "素材不在当前素材库");
  const entries = new Map(library.entries);
  entries.set(path, Object.freeze({ ...existing, lastUsedAt: now }));
  return libraryWithEntries(library, entries, now);
}

export function searchMapAssets(library, query = "", options = {}) {
  const text = String(query || "").trim().toLocaleLowerCase("zh-CN");
  const kinds = new Set(Array.isArray(options.kinds) ? options.kinds.map(String) : []);
  const favoritesOnly = options.favoritesOnly === true;
  return sortedMapAssets(
    [...(library?.entries instanceof Map ? library.entries.values() : [])].filter((asset) => {
      if (kinds.size && !kinds.has(asset.kind)) return false;
      if (favoritesOnly && !asset.favorite) return false;
      if (!text) return true;
      return `${asset.name} ${asset.path} ${(asset.tags || []).join(" ")}`.toLocaleLowerCase("zh-CN").includes(text);
    }),
    options,
  );
}

export function sortedMapAssets(entries, options = {}) {
  const mode = String(options.sort || "name");
  return [...(entries || [])].sort((left, right) => {
    if (mode === "recent") {
      const recent = Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0);
      if (recent) return recent;
    }
    if (mode === "favorite") {
      const favorite = Number(right.favorite === true) - Number(left.favorite === true);
      if (favorite) return favorite;
    }
    return compareText(left.name, right.name) || compareText(left.path, right.path);
  });
}

export function mapAssetDependencySummary(asset) {
  const dependencies = Array.isArray(asset?.dependencies)
    ? [...new Set(asset.dependencies.map((entry) => String(entry || "")).filter(Boolean))]
    : [];
  return Object.freeze({
    count: dependencies.length,
    paths: Object.freeze(dependencies),
    text: dependencies.length ? `${dependencies.length} 个依赖` : "无外部依赖",
  });
}

export function serializeMapAssetLibrary(library) {
  return JSON.stringify({
    version: 1,
    projectPath: String(library?.projectPath || ""),
    entries: sortedMapAssets(library?.entries instanceof Map ? library.entries.values() : [], { sort: "name" }),
    updatedAt: Number(library?.updatedAt || 0),
  });
}

export function parseMapAssetLibrary(value) {
  let document = value;
  if (typeof value === "string") {
    try { document = JSON.parse(value); } catch { throw assetError("MAP_ASSET_LIBRARY_INVALID", "素材库数据不是有效 JSON"); }
  }
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1) {
    throw assetError("MAP_ASSET_LIBRARY_INVALID", "素材库版本或结构无效");
  }
  return createMapAssetLibrary(document);
}

function normalizeAsset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = normalizeAssetPath(value.path, false);
  const kind = String(value.kind || "");
  if (!path || !ASSET_KINDS.has(kind)) return null;
  return Object.freeze({
    path,
    name: String(value.name || path.split("/").at(-1) || path),
    kind,
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null,
    mtime: Number.isFinite(value.mtime) ? value.mtime : null,
    sha256: typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256) ? value.sha256 : null,
    width: Number.isSafeInteger(value.width) && value.width > 0 ? value.width : null,
    height: Number.isSafeInteger(value.height) && value.height > 0 ? value.height : null,
    dependencies: Object.freeze(Array.isArray(value.dependencies)
      ? [...new Set(value.dependencies.map(String).filter(Boolean))]
      : []),
    tags: Object.freeze(Array.isArray(value.tags)
      ? [...new Set(value.tags.map(String).filter(Boolean))].slice(0, 32)
      : []),
    favorite: value.favorite === true,
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0,
    indexedAt: Number.isFinite(value.indexedAt) ? value.indexedAt : 0,
  });
}

function normalizeAssetPath(value, allowNull = true) {
  if (value === null || value === undefined || value === "") return allowNull ? "" : null;
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) return null;
  return segments.join("/");
}

function libraryWithEntries(library, entries, updatedAt) {
  return Object.freeze({
    version: 1,
    projectPath: String(library?.projectPath || ""),
    entries,
    updatedAt,
  });
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-CN", { numeric: true });
}

function assetError(code, message) {
  const error = new Error(message);
  error.name = "MapAssetLibraryError";
  error.code = code;
  return error;
}
