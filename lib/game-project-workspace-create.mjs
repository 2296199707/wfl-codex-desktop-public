import fs from "node:fs/promises";
import path from "node:path";
import { createTiledMap } from "./map-project-create.mjs";

export const GAME_PROJECT_WORKSPACE_DEFAULTS = Object.freeze({
  preset: "building",
  orientation: "orthogonal",
  width: 64,
  height: 64,
  tilewidth: 32,
  tileheight: 32,
  initialMap: "maps/main.tmj",
  initializeGit: true,
});

const PROJECT_DIRECTORIES = Object.freeze([
  "maps",
  "tilesets",
  "templates",
  "images",
  "characters",
  "worlds",
  "automapping",
  "extensions",
]);
const PRESETS = new Set(["building", "background"]);
const ORIENTATIONS = new Set(["orthogonal", "isometric", "staggered", "hexagonal", "oblique"]);
const MAX_NAME_LENGTH = 240;
const MAX_DIRECTORY_NAME_LENGTH = 128;
const MAX_RELATIVE_PATH_LENGTH = 4_096;

export class GameProjectWorkspaceCreateError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "GameProjectWorkspaceCreateError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Create the predictable filesystem skeleton used by the game workspace.
 * The caller owns authorization, quota and optional Git initialization.
 */
export async function createGameProjectWorkspace(input = {}, options = {}) {
  const name = normalizeName(input.name);
  const directoryName = normalizeDirectoryName(input.directoryName || name);
  const projectPath = normalizeAbsolutePath(input.projectPath);
  const projectFile = normalizeRelativePath(
    input.projectFile || `${directoryName}.tiled-project`,
    ".tiled-project",
    "Tiled 项目文件",
  );
  const initialMap = normalizeRelativePath(
    input.initialMap || GAME_PROJECT_WORKSPACE_DEFAULTS.initialMap,
    ".tmj",
    "初始地图",
  );
  const preset = normalizeEnum(
    input.preset ?? GAME_PROJECT_WORKSPACE_DEFAULTS.preset,
    PRESETS,
    "游戏工程地图预设",
  );
  const orientation = normalizeEnum(
    input.orientation ?? GAME_PROJECT_WORKSPACE_DEFAULTS.orientation,
    ORIENTATIONS,
    "地图方向",
  );
  const width = positiveInteger(input.width ?? GAME_PROJECT_WORKSPACE_DEFAULTS.width, "地图宽度");
  const height = positiveInteger(input.height ?? GAME_PROJECT_WORKSPACE_DEFAULTS.height, "地图高度");
  const tilewidth = positiveInteger(input.tilewidth ?? GAME_PROJECT_WORKSPACE_DEFAULTS.tilewidth, "瓦片宽度");
  const tileheight = positiveInteger(input.tileheight ?? GAME_PROJECT_WORKSPACE_DEFAULTS.tileheight, "瓦片高度");
  const initialLayerName = normalizeName(
    input.initialLayerName || (preset === "background" ? "Background" : "Ground"),
    "初始图层名称",
  );
  const initialMapDirectory = path.posix.dirname(initialMap);
  const projectDirectories = Object.freeze([
    ...new Set([
      ...PROJECT_DIRECTORIES,
      initialMapDirectory,
    ]),
  ]);
  const projectFileDirectory = path.posix.dirname(projectFile);
  const folderReferences = projectDirectories.map((directory) => (
    relativeProjectReference(projectFileDirectory, directory)
  ));
  const projectDocument = {
    automappingRulesFile: relativeProjectReference(projectFileDirectory, "automapping/rules.txt"),
    commands: [],
    compatibilityVersion: "1.12",
    extensionsPath: relativeProjectReference(projectFileDirectory, "extensions"),
    folders: folderReferences,
    propertyTypes: [],
  };
  const createMap = typeof options.createMap === "function" ? options.createMap : createTiledMap;
  let created = false;
  try {
    await fs.mkdir(projectPath, { recursive: false, mode: 0o750 });
    created = true;
    await fs.mkdir(path.dirname(path.join(projectPath, ...projectFile.split("/"))), {
      recursive: true,
      mode: 0o750,
    });
    await Promise.all(projectDirectories.map((directory) => (
      fs.mkdir(path.join(projectPath, ...directory.split("/")), { recursive: true, mode: 0o750 })
    )));
    await writeNewFile(
      path.join(projectPath, ...projectFile.split("/")),
      `${JSON.stringify(projectDocument, null, 2)}\n`,
    );
    await writeNewFile(
      path.join(projectPath, "automapping", "rules.txt"),
      "",
    );
    const map = await createMap({
      projectPath,
      relativePath: initialMap,
      preset,
      orientation,
      width,
      height,
      tilewidth,
      tileheight,
      initialLayerName,
      infinite: input.infinite === true,
      renderorder: input.renderorder,
      backgroundcolor: input.backgroundcolor,
      targetVersion: input.targetVersion,
    }, options.mapOptions || {});
    return Object.freeze({
      name,
      directoryName,
      projectPath,
      projectFile,
      initialMap,
      preset,
      orientation,
      width,
      height,
      tilewidth,
      tileheight,
      initialLayerName,
      directories: projectDirectories,
      map: map || null,
    });
  } catch (error) {
    if (created) await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    if (error instanceof GameProjectWorkspaceCreateError) throw error;
    if (error?.code === "EEXIST") {
      throw createError(409, "GAME_PROJECT_PATH_EXISTS", "目标游戏工程目录已经存在", error);
    }
    throw createError(500, "GAME_PROJECT_CREATE_FAILED", error?.message || "无法创建游戏工程", error);
  }
}

export function gameProjectDirectoryName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "game-project";
  const normalized = raw.normalize("NFKC").replace(/[^\p{Letter}\p{Number}._-]+/gu, "-");
  const trimmed = normalized.replace(/^-+|-+$/gu, "").slice(0, MAX_DIRECTORY_NAME_LENGTH);
  return trimmed && trimmed !== "." && trimmed !== ".." && !trimmed.startsWith(".")
    ? trimmed
    : "game-project";
}

async function writeNewFile(filePath, content) {
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o640);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw createError(409, "GAME_PROJECT_FILE_EXISTS", "游戏工程文件已经存在", error);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\0\r\n]/u.test(name)) {
    throw createError(400, "GAME_PROJECT_INVALID_NAME", "游戏工程名称无效");
  }
  return name;
}

function normalizeDirectoryName(value) {
  const name = String(value || "").trim();
  if (
    !name
    || name.length > MAX_DIRECTORY_NAME_LENGTH
    || name === "."
    || name === ".."
    || name.startsWith(".")
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
    || /[\r\n]/u.test(name)
  ) throw createError(400, "GAME_PROJECT_INVALID_DIRECTORY_NAME", "游戏工程目录名称无效");
  return name;
}

function normalizeAbsolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw createError(400, "GAME_PROJECT_INVALID_PATH", "游戏工程目录必须是绝对路径");
  }
  return path.resolve(value);
}

function normalizeRelativePath(value, extension, label) {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_RELATIVE_PATH_LENGTH
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) throw createError(400, "GAME_PROJECT_INVALID_RESOURCE_PATH", `${label}必须使用工程相对路径`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || (
    segment.startsWith(".") && segment !== ".tiled-project"
  ))) {
    throw createError(400, "GAME_PROJECT_INVALID_RESOURCE_PATH", `${label}路径无效`);
  }
  const normalized = segments.join("/");
  const extensionMatches = extension === ".tiled-project"
    && path.posix.basename(normalized).toLowerCase() === ".tiled-project";
  if (!extensionMatches && path.posix.extname(normalized).toLowerCase() !== extension) {
    throw createError(400, "GAME_PROJECT_INVALID_RESOURCE_PATH", `${label}必须使用 ${extension} 扩展名`);
  }
  return normalized;
}

function normalizeEnum(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) throw createError(400, "GAME_PROJECT_INVALID_OPTION", `${label}无效`);
  return normalized;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw createError(400, "GAME_PROJECT_INVALID_DIMENSION", `${label}必须是正整数`);
  }
  return number;
}

function relativeProjectReference(fromDirectory, targetPath) {
  const relative = path.posix.relative(fromDirectory === "." ? "" : fromDirectory, targetPath);
  return relative || ".";
}

function createError(statusCode, code, message, cause = null) {
  return new GameProjectWorkspaceCreateError(statusCode, code, message, cause);
}
