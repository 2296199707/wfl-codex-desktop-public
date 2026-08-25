import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openImageProjectAnchor } from "./image-project-anchor.mjs";

const MAX_COMPANIONS = 8;
const MAX_NAME_LENGTH = 255;
const MAX_TILE_SIZE = 16_384;
const RESERVED_PROJECT_SEGMENTS = new Set([
  ".git", ".codex-desktop", ".codex-runtime", ".codex-uploads", ".codex-trash",
]);
const TRANSACTION_JOURNAL_NAME = ".map-asset-publication.json";
const TRANSACTION_JOURNAL_SCHEMA = "wfl.map-asset-publication.v1";
const MAX_TRANSACTION_JOURNAL_BYTES = 1024 * 1024;
const MAX_TRANSACTION_ENTRIES = 256;
const activePublicationDirectories = new Set();

export class MapAssetPublicationError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapAssetPublicationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Register an in-process publication so recovery cannot race its journal. */
export function beginMapAssetPublication(candidateDirectory) {
  const directory = path.resolve(String(candidateDirectory || ""));
  if (!path.isAbsolute(String(candidateDirectory || "")) || directory === path.parse(directory).root) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_DIRECTORY_INVALID", "素材事务暂存目录无效");
  }
  activePublicationDirectories.add(directory);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePublicationDirectories.delete(directory);
  };
}

export function activeMapAssetPublicationDirectories() {
  return Object.freeze([...activePublicationDirectories]);
}

export function mapAssetTransactionJournalPath(candidateDirectory) {
  const directory = path.resolve(String(candidateDirectory || ""));
  if (!path.isAbsolute(String(candidateDirectory || "")) || directory === path.parse(directory).root) {
    throw publicationError(400, "MAP_ASSET_TRANSACTION_DIRECTORY_INVALID", "素材事务暂存目录无效");
  }
  return path.join(directory, TRANSACTION_JOURNAL_NAME);
}

export async function writeMapAssetTransactionJournal({
  journalPath,
  projectPath,
  jobId,
  state,
} = {}) {
  const filename = normalizeJournalPath(journalPath);
  const projectRoot = normalizeProjectRoot(projectPath);
  const journal = {
    schema: TRANSACTION_JOURNAL_SCHEMA,
    jobId: String(jobId || ""),
    projectPath: projectRoot,
    phase: String(state?.phase || ""),
    allLinked: state?.allLinked === true,
    entries: normalizeJournalEntries(state?.entries, projectRoot),
  };
  if (!journal.jobId || !["staged", "linking", "linked", "committed", "rolled-back"].includes(journal.phase)) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_STATE_INVALID", "素材事务日志状态无效");
  }
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_TRANSACTION_JOURNAL_BYTES) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_TOO_LARGE", "素材事务日志超过安全上限");
  }
  const temporaryPath = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return Object.freeze(journal);
}

export async function removeMapAssetTransactionJournal(journalPath) {
  const filename = normalizeJournalPath(journalPath);
  await fs.rm(filename, { force: true });
  await syncDirectory(path.dirname(filename)).catch(() => {});
}

/** Recover interrupted candidate publications without preventing server boot. */
export async function recoverMapAssetPublicationTransactions({
  temporaryRoot,
  projectPath = null,
  protectedDirectories = [],
} = {}) {
  const root = path.resolve(String(temporaryRoot || ""));
  const requestedProject = projectPath == null ? null : normalizeProjectRoot(projectPath);
  const protectedPaths = new Set([
    ...activeMapAssetPublicationDirectories(),
    ...(Array.isArray(protectedDirectories) ? protectedDirectories.map((value) => path.resolve(String(value))) : []),
  ]);
  const result = { recovered: 0, completed: 0, rolledBack: 0, failures: [] };
  let directories;
  try {
    directories = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.startsWith("candidate-")) continue;
    if (protectedPaths.has(path.join(root, directory.name))) continue;
    const journalPath = path.join(root, directory.name, TRANSACTION_JOURNAL_NAME);
    if (!await pathExists(journalPath)) continue;
    try {
      const journal = await readJournal(journalPath);
      if (requestedProject && path.resolve(String(journal.projectPath || "")) !== requestedProject) continue;
      const outcome = await recoverJournal(journalPath, journal);
      result.recovered += 1;
      if (outcome === "completed") result.completed += 1;
      else result.rolledBack += 1;
    } catch (error) {
      result.failures.push({
        candidate: directory.name,
        code: safeErrorCode(error),
        message: String(error?.message || "素材事务恢复失败").slice(0, 500),
      });
    }
  }
  return result;
}

/**
 * Read-only administrator view of asset publication journals.  This mirrors
 * the map-resource transaction view without exposing absolute paths or
 * candidate filenames.  Invalid journals are retained for manual recovery.
 */
export async function inspectMapAssetPublicationTransactions({
  temporaryRoot,
  projectPath = null,
  protectedDirectories = [],
} = {}) {
  const root = path.resolve(String(temporaryRoot || ""));
  const requestedProject = projectPath == null ? null : normalizeProjectRoot(projectPath);
  const protectedPaths = new Set([
    ...activeMapAssetPublicationDirectories(),
    ...(Array.isArray(protectedDirectories) ? protectedDirectories.map((value) => path.resolve(String(value))) : []),
  ]);
  const transactions = [];
  let directories;
  try {
    directories = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.startsWith("candidate-")) continue;
    const journalPath = path.join(root, directory.name, TRANSACTION_JOURNAL_NAME);
    if (!await pathExists(journalPath)) continue;
    try {
      const journal = await readJournal(journalPath);
      const journalProject = normalizeProjectRoot(journal.projectPath);
      if (requestedProject && journalProject !== requestedProject) continue;
      if (protectedPaths.has(path.join(root, directory.name))) {
        transactions.push(Object.freeze({
          transactionType: "asset-publication",
          directory: directory.name,
          projectName: path.basename(journalProject),
          phase: "protected",
          protected: true,
          message: "对应图片任务仍在发布，已跳过恢复",
        }));
        continue;
      }
      const entries = normalizeJournalEntries(journal.entries, journalProject);
      transactions.push(Object.freeze({
        transactionType: "asset-publication",
        directory: directory.name,
        jobId: String(journal.jobId || ""),
        projectName: path.basename(journalProject),
        phase: String(journal.phase || "invalid"),
        allLinked: journal.allLinked === true,
        fileCount: entries.length,
        linkedCount: entries.filter((entry) => entry.linked === true).length,
        entries: Object.freeze(entries.map((entry) => Object.freeze({
          index: entry.index,
          targetPath: path.relative(journalProject, entry.targetPath).split(path.sep).join("/"),
          size: entry.size,
          sha256: entry.sha256,
          linked: entry.linked === true,
        }))),
      }));
    } catch (error) {
      transactions.push(Object.freeze({
        transactionType: "asset-publication",
        directory: directory.name,
        phase: "invalid",
        error: Object.freeze({
          code: safeErrorCode(error),
          message: String(error?.message || "素材事务日志无效").slice(0, 500),
        }),
      }));
    }
  }
  return Object.freeze(transactions);
}

/**
 * Build server-owned TSJ/TMJ companions for staged image candidates. The
 * browser can select dimensions and destinations, but cannot provide Tiled
 * JSON or rewrite dependency paths itself.
 */
export function buildMapImagePublicationCompanions({
  companions,
  destinations,
  candidateFiles,
  jobId,
} = {}) {
  if (companions == null) return Object.freeze([]);
  if (!Array.isArray(companions) || companions.length > MAX_COMPANIONS) {
    throw publicationError(400, "MAP_IMAGE_COMPANIONS_INVALID", "附属素材清单无效或超过数量上限");
  }
  const images = new Map((Array.isArray(candidateFiles) ? candidateFiles : []).map((file) => [file.index, file]));
  const imageDestinations = new Map((Array.isArray(destinations) ? destinations : []).map((entry) => [entry.index, entry.path]));
  const paths = new Set(imageDestinations.values());
  const output = [];
  for (const entry of companions) {
    if (!isRecord(entry)) {
      throw publicationError(400, "MAP_IMAGE_COMPANION_INVALID", "附属素材条目必须是对象");
    }
    const type = String(entry.type || "");
    const allowedKeys = type === "tileset-atlas"
      ? ["margin", "name", "path", "sourceIndex", "spacing", "tileHeight", "tileWidth", "type"]
      : type === "composite-map"
        ? ["name", "path", "sourceIndex", "tileHeight", "tileWidth", "type"]
        : [];
    if (!allowedKeys.length || !hasOnlyKeys(entry, allowedKeys)) {
      throw publicationError(400, "MAP_IMAGE_COMPANION_TYPE_INVALID", "附属素材类型或参数无效");
    }
    const sourceIndex = Number(entry.sourceIndex);
    const image = Number.isSafeInteger(sourceIndex) ? images.get(sourceIndex) : null;
    const imagePath = Number.isSafeInteger(sourceIndex) ? imageDestinations.get(sourceIndex) : null;
    if (!image || !imagePath) {
      throw publicationError(400, "MAP_IMAGE_COMPANION_SOURCE_INVALID", "附属素材引用的候选图片无效");
    }
    const relativePath = normalizeProjectRelativePath(
      entry.path,
      type === "tileset-atlas" ? ".tsj" : ".tmj",
    );
    if (paths.has(relativePath)) {
      throw publicationError(400, "MAP_IMAGE_COMPANION_PATH_DUPLICATE", "发布事务中的文件路径必须唯一");
    }
    paths.add(relativePath);
    const tileWidth = positiveInteger(entry.tileWidth, "瓦片宽度");
    const tileHeight = positiveInteger(entry.tileHeight, "瓦片高度");
    const name = normalizedName(entry.name, type === "tileset-atlas" ? "AI 瓦片集" : "AI 组合素材");
    const generated = type === "tileset-atlas"
      ? buildTilesetAtlas({
          image,
          imagePath,
          relativePath,
          name,
          tileWidth,
          tileHeight,
          margin: nonNegativeInteger(entry.margin ?? 0, "图集边距"),
          spacing: nonNegativeInteger(entry.spacing ?? 0, "瓦片间距"),
          jobId,
        })
      : buildCompositeMap({
          image,
          imagePath,
          relativePath,
          name,
          tileWidth,
          tileHeight,
          jobId,
        });
    output.push(Object.freeze({
      artifactType: type === "tileset-atlas" ? "tileset" : "composite",
      sourceIndex,
      relativePath,
      mediaType: "application/json",
      format: "tiled-json",
      tiledType: type === "tileset-atlas" ? "tileset" : "map",
      size: generated.data.length,
      sha256: sha256(generated.data),
      dependencies: Object.freeze([imagePath]),
      name,
      tileWidth,
      tileHeight,
      ...generated.metadata,
      data: generated.data,
    }));
  }
  return Object.freeze(output);
}

function buildTilesetAtlas({
  image,
  imagePath,
  relativePath,
  name,
  tileWidth,
  tileHeight,
  margin,
  spacing,
  jobId,
}) {
  if (margin > image.width || margin > image.height || spacing > image.width || spacing > image.height) {
    throw publicationError(400, "MAP_IMAGE_TILESET_GRID_INVALID", "图集边距或间距超过候选图片尺寸");
  }
  const usableWidth = image.width - (margin * 2);
  const usableHeight = image.height - (margin * 2);
  const horizontalStep = tileWidth + spacing;
  const verticalStep = tileHeight + spacing;
  if (
    usableWidth < tileWidth
    || usableHeight < tileHeight
    || (usableWidth + spacing) % horizontalStep !== 0
    || (usableHeight + spacing) % verticalStep !== 0
  ) {
    throw publicationError(
      422,
      "MAP_IMAGE_TILESET_ALIGNMENT",
      `候选尺寸 ${image.width}x${image.height} 不能按 ${tileWidth}x${tileHeight}、边距 ${margin}、间距 ${spacing} 完整切分`,
    );
  }
  const columns = (usableWidth + spacing) / horizontalStep;
  const rows = (usableHeight + spacing) / verticalStep;
  const tilecount = columns * rows;
  if (!Number.isSafeInteger(tilecount) || tilecount < 1 || tilecount > 0x0fff_ffff) {
    throw publicationError(422, "MAP_IMAGE_TILESET_CAPACITY", "候选图片形成的瓦片数量无效");
  }
  const document = {
    columns,
    image: tiledReference(relativePath, imagePath),
    imageheight: image.height,
    imagewidth: image.width,
    margin,
    name,
    properties: provenanceProperties(jobId, image.sha256),
    spacing,
    tilecount,
    tiledversion: "1.12.2",
    tileheight: tileHeight,
    tilewidth: tileWidth,
    type: "tileset",
    version: "1.12",
  };
  return {
    data: serializeTiled(document),
    metadata: Object.freeze({ columns, rows, tileCount: tilecount, margin, spacing }),
  };
}

function buildCompositeMap({
  image,
  imagePath,
  relativePath,
  name,
  tileWidth,
  tileHeight,
  jobId,
}) {
  const width = Math.ceil(image.width / tileWidth);
  const height = Math.ceil(image.height / tileHeight);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw publicationError(422, "MAP_IMAGE_COMPOSITE_SIZE_INVALID", "候选图片不能形成有效的组合素材地图");
  }
  const document = {
    compressionlevel: -1,
    height,
    infinite: false,
    layers: [{
      id: 1,
      image: tiledReference(relativePath, imagePath),
      name,
      opacity: 1,
      properties: provenanceProperties(jobId, image.sha256),
      type: "imagelayer",
      visible: true,
      x: 0,
      y: 0,
    }],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: tileHeight,
    tilesets: [],
    tilewidth: tileWidth,
    type: "map",
    version: "1.12",
    width,
  };
  return {
    data: serializeTiled(document),
    metadata: Object.freeze({ mapWidth: width, mapHeight: height, layerCount: 1 }),
  };
}

function provenanceProperties(jobId, imageSha256) {
  return [
    { name: "wfl.imageJobId", type: "string", value: String(jobId || "") },
    { name: "wfl.imageSha256", type: "string", value: String(imageSha256 || "") },
  ];
}

function tiledReference(ownerPath, dependencyPath) {
  const reference = path.posix.relative(path.posix.dirname(ownerPath), dependencyPath);
  if (!reference || path.posix.isAbsolute(reference) || reference.includes("\\")) {
    throw publicationError(400, "MAP_IMAGE_COMPANION_REFERENCE_INVALID", "无法建立安全的 Tiled 相对图片引用");
  }
  return reference;
}

function normalizeProjectRelativePath(value, extension) {
  const relativePath = String(value || "").replaceAll("\\", "/");
  const segments = relativePath.split("/");
  if (
    !relativePath
    || relativePath.length > 4096
    || relativePath.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/iu.test(relativePath)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => RESERVED_PROJECT_SEGMENTS.has(segment))
    || /[\u0000-\u001f\u007f:*?"<>|]/u.test(relativePath)
    || path.posix.extname(relativePath).toLowerCase() !== extension
  ) {
    throw publicationError(400, "MAP_IMAGE_COMPANION_PATH_INVALID", `附属素材必须使用安全的工程相对 ${extension} 路径`);
  }
  return relativePath;
}

function normalizedName(value, fallback) {
  const name = String(value || "").trim() || fallback;
  if (name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw publicationError(400, "MAP_IMAGE_COMPANION_NAME_INVALID", "附属素材名称无效");
  }
  return name;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_TILE_SIZE) {
    throw publicationError(400, "MAP_IMAGE_COMPANION_DIMENSION_INVALID", `${label}必须是 1 到 ${MAX_TILE_SIZE} 的整数`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_TILE_SIZE) {
    throw publicationError(400, "MAP_IMAGE_COMPANION_DIMENSION_INVALID", `${label}必须是 0 到 ${MAX_TILE_SIZE} 的整数`);
  }
  return number;
}

function serializeTiled(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hasOnlyKeys(value, allowed) {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function recoverJournal(journalPath, journal = null) {
  const filename = normalizeJournalPath(journalPath);
  const loadedJournal = journal || await readJournal(filename);
  const projectRoot = normalizeProjectRoot(loadedJournal.projectPath);
  const entries = normalizeJournalEntries(loadedJournal.entries, projectRoot);
  if (loadedJournal.schema !== TRANSACTION_JOURNAL_SCHEMA || !entries.length) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复日志无效");
  }
  const anchor = await openImageProjectAnchor(projectRoot);
  const bound = [];
  try {
    for (const entry of entries) {
      const target = await anchor.resolveTarget(entry.targetPath, { createParents: false });
      const temporaryBasename = path.basename(entry.temporaryPath);
      bound.push({
        ...entry,
        target,
        anchoredTargetPath: target.targetPath,
        anchoredTemporaryPath: path.join(target.directory, temporaryBasename),
      });
    }
    const complete = loadedJournal.allLinked === true
      && await allOutputsMatch(bound);
    const failures = complete
      ? await cleanRecoveryTemporaries(bound)
      : await rollbackRecoveryEntries(bound);
    if (failures.length) {
      const error = publicationError(500, "MAP_ASSET_TRANSACTION_RECOVERY_INCOMPLETE", "素材事务恢复未能安全完成");
      error.failures = failures;
      throw error;
    }
    for (const directory of new Set(bound.map((entry) => entry.target.directory))) {
      await syncDirectory(directory).catch(() => {});
    }
    await removeMapAssetTransactionJournal(filename);
    return complete ? "completed" : "rolled-back";
  } finally {
    for (const entry of bound) await entry.target.close().catch(() => {});
    await anchor.close().catch(() => {});
  }
}

async function allOutputsMatch(entries) {
  for (const entry of entries) {
    let handle = null;
    try {
      handle = await fs.open(entry.anchoredTargetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== entry.size) return false;
      if (await hashFileHandle(handle) !== entry.sha256) return false;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return true;
}

// Recovery may run while a large generated image is present. Stream the
// digest verification instead of loading the complete output into the heap.
async function hashFileHandle(handle) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    digest.update(buffer.subarray(0, bytesRead));
  }
  return digest.digest("hex");
}

async function cleanRecoveryTemporaries(entries) {
  const failures = [];
  for (const entry of entries) {
    try {
      const temporary = await lstatOrNull(entry.anchoredTemporaryPath);
      if (!temporary) continue;
      if (!matchesJournalIdentity(temporary, entry)) {
        failures.push({ index: entry.index, operation: "inspect-temporary", code: "MAP_ASSET_TRANSACTION_IDENTITY_CHANGED" });
        continue;
      }
      await fs.unlink(entry.anchoredTemporaryPath);
    } catch (error) {
      failures.push({ index: entry.index, operation: "remove-temporary", code: safeErrorCode(error) });
    }
  }
  return failures;
}

async function rollbackRecoveryEntries(entries) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try {
      const [target, temporary] = await Promise.all([
        lstatOrNull(entry.anchoredTargetPath),
        lstatOrNull(entry.anchoredTemporaryPath),
      ]);
      const temporaryOwned = temporary && matchesJournalIdentity(temporary, entry);
      const targetOwned = target && temporaryOwned
        && target.dev === temporary.dev && target.ino === temporary.ino;
      if (targetOwned) await fs.unlink(entry.anchoredTargetPath);
      else if (entry.linked && target) {
        failures.push({ index: entry.index, operation: "remove-output", code: "MAP_ASSET_TRANSACTION_IDENTITY_CHANGED" });
      }
      if (temporaryOwned) await fs.unlink(entry.anchoredTemporaryPath);
      else if (temporary) {
        failures.push({ index: entry.index, operation: "remove-temporary", code: "MAP_ASSET_TRANSACTION_IDENTITY_CHANGED" });
      }
    } catch (error) {
      failures.push({ index: entry.index, operation: "rollback-entry", code: safeErrorCode(error) });
    }
  }
  return failures;
}

async function readJournal(filename) {
  let handle = null;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_TRANSACTION_JOURNAL_BYTES) {
      throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复日志大小无效");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复日志不是有效 JSON");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeJournalEntries(value, projectRoot) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRANSACTION_ENTRIES) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复文件清单无效");
  }
  const targets = new Set();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复文件条目无效");
    const targetPath = path.resolve(String(entry.targetPath || ""));
    const temporaryPath = path.resolve(String(entry.temporaryPath || ""));
    if (!path.isAbsolute(String(entry.targetPath || "")) || !isPathWithin(projectRoot, targetPath)
      || path.dirname(temporaryPath) !== path.dirname(targetPath)
      || !path.basename(temporaryPath).startsWith(`.${path.basename(targetPath)}.`)
      || !path.basename(temporaryPath).endsWith(".tmp")
      || targets.has(targetPath)) {
      throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复路径无效");
    }
    const size = Number(entry.size);
    const digest = String(entry.sha256 || "").toLowerCase();
    const device = String(entry.device || "");
    const inode = String(entry.inode || "");
    if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/u.test(digest)
      || !/^\d+$/u.test(device) || !/^\d+$/u.test(inode)) {
      throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_INVALID", "素材事务恢复元数据无效");
    }
    targets.add(targetPath);
    return {
      index: Number.isSafeInteger(entry.index) ? entry.index : index,
      targetPath,
      temporaryPath,
      size,
      sha256: digest,
      device,
      inode,
      linked: entry.linked === true,
    };
  });
}

function normalizeJournalPath(value) {
  const filename = path.resolve(String(value || ""));
  if (!path.isAbsolute(String(value || "")) || path.basename(filename) !== TRANSACTION_JOURNAL_NAME) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_JOURNAL_PATH_INVALID", "素材事务日志路径无效");
  }
  return filename;
}

function normalizeProjectRoot(value) {
  const root = path.resolve(String(value || ""));
  if (!path.isAbsolute(String(value || "")) || root === path.parse(root).root) {
    throw publicationError(500, "MAP_ASSET_TRANSACTION_PROJECT_INVALID", "素材事务工程路径无效");
  }
  return root;
}

function matchesJournalIdentity(stat, entry) {
  return stat.isFile() && String(stat.dev) === entry.device && String(stat.ino) === entry.inode;
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function lstatOrNull(filename) {
  try { return await fs.lstat(filename); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(filename) {
  return Boolean(await lstatOrNull(filename));
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_.:-]+$/u.test(error.code)
    ? error.code
    : "MAP_ASSET_TRANSACTION_RECOVERY_FAILED";
}

function publicationError(statusCode, code, message) {
  return new MapAssetPublicationError(statusCode, code, message);
}
