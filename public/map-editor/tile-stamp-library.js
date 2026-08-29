import { normalizeTileStamp } from "./tile-tool-model.js?v=0.44.64";

export const TILE_STAMP_LIBRARY_VERSION = 1;

const STORAGE_PREFIX = "wfl-map-tile-stamps-v1";
const MAX_STAMPS = 64;
const MAX_NAME_LENGTH = 80;

export function tileStampLibraryStorageKey({ accountId, projectPath, relativePath } = {}) {
  const account = boundedText(accountId, 256, "accountId");
  const project = boundedText(projectPath, 4096, "projectPath");
  const mapPath = boundedText(relativePath, 4096, "relativePath");
  if (!project.startsWith("/") || mapPath.startsWith("/") || !mapPath.toLowerCase().endsWith(".tmj")) {
    throw new TypeError("Invalid tile stamp library scope");
  }
  if (mapPath.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new TypeError("Invalid tile stamp library scope");
  }
  return `${STORAGE_PREFIX}:${encodeURIComponent(account)}:${encodeURIComponent(project)}:${encodeURIComponent(mapPath)}`;
}

export function createTileStampLibrary(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries.map(normalizeEntry) : [];
  if (entries.length > MAX_STAMPS) throw new TypeError(`Tile stamp library cannot exceed ${MAX_STAMPS} entries`);
  const ids = new Set();
  const names = new Set();
  for (const entry of entries) {
    const normalizedName = entry.name.toLocaleLowerCase("zh-CN");
    if (ids.has(entry.id) || names.has(normalizedName)) throw new TypeError("Tile stamp library entries must be unique");
    ids.add(entry.id);
    names.add(normalizedName);
  }
  return frozenLibrary(entries);
}

export function parseTileStampLibrary(value) {
  if (!value || value.version !== TILE_STAMP_LIBRARY_VERSION) return null;
  try {
    return createTileStampLibrary(value);
  } catch {
    return null;
  }
}

export function upsertNamedTileStamp(library, input, now = Date.now()) {
  const current = createTileStampLibrary(library || {});
  const name = stampName(input?.name);
  const stamp = normalizeTileStamp(input?.stamp);
  const timestamp = validTimestamp(now, "updatedAt");
  const matchingIndex = current.entries.findIndex((entry) => entry.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"));
  const matching = matchingIndex >= 0 ? current.entries[matchingIndex] : null;
  const id = matching?.id || stampId(input?.id);
  const entry = normalizeEntry({
    id,
    name,
    stamp,
    favorite: matching?.favorite === true,
    createdAt: matching?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastUsedAt: timestamp,
  });
  const entries = current.entries.filter((candidate) => candidate.id !== id);
  entries.unshift(entry);
  return frozenLibrary(entries.slice(0, MAX_STAMPS));
}

export function removeNamedTileStamp(library, id) {
  const current = createTileStampLibrary(library || {});
  const target = stampId(id);
  return frozenLibrary(current.entries.filter((entry) => entry.id !== target));
}

export function setNamedTileStampFavorite(library, id, favorite, now = Date.now()) {
  const current = createTileStampLibrary(library || {});
  const target = stampId(id);
  const timestamp = validTimestamp(now, "updatedAt");
  let matched = false;
  const entries = current.entries.map((entry) => {
    if (entry.id !== target) return entry;
    matched = true;
    return normalizeEntry({ ...entry, favorite: favorite === true, updatedAt: timestamp });
  });
  if (!matched) throw new TypeError("Named tile stamp was not found");
  return frozenLibrary(entries);
}

export function touchNamedTileStamp(library, id, now = Date.now()) {
  const current = createTileStampLibrary(library || {});
  const target = stampId(id);
  const timestamp = validTimestamp(now, "lastUsedAt");
  const selected = current.entries.find((entry) => entry.id === target);
  if (!selected) throw new TypeError("Named tile stamp was not found");
  const entries = current.entries.map((entry) => (
    entry.id === target ? normalizeEntry({ ...entry, lastUsedAt: timestamp }) : entry
  ));
  return {
    library: frozenLibrary(entries),
    entry: normalizeEntry({ ...selected, lastUsedAt: timestamp }),
  };
}

export function sortedNamedTileStamps(library) {
  const current = createTileStampLibrary(library || {});
  return Object.freeze([...current.entries].sort((left, right) => (
    Number(right.favorite) - Number(left.favorite)
    || right.lastUsedAt - left.lastUsedAt
    || right.updatedAt - left.updatedAt
    || left.name.localeCompare(right.name, "zh-CN")
  )));
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid tile stamp entry");
  return Object.freeze({
    id: stampId(value.id),
    name: stampName(value.name),
    stamp: normalizeTileStamp(value.stamp),
    favorite: value.favorite === true,
    createdAt: validTimestamp(value.createdAt, "createdAt"),
    updatedAt: validTimestamp(value.updatedAt, "updatedAt"),
    lastUsedAt: validTimestamp(value.lastUsedAt, "lastUsedAt"),
  });
}

function frozenLibrary(entries) {
  return Object.freeze({
    version: TILE_STAMP_LIBRARY_VERSION,
    entries: Object.freeze(entries.map((entry) => normalizeEntry(entry))),
  });
}

function stampId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id)) throw new TypeError("Invalid tile stamp id");
  return id;
}

function stampName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH || name.includes("\0")) throw new TypeError("Invalid tile stamp name");
  return name;
}

function validTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError(`Invalid ${label}`);
  return timestamp;
}

function boundedText(value, maximum, name) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > maximum || text.includes("\0")) throw new TypeError(`Invalid ${name}`);
  return text;
}
