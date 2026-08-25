import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDecodedImageFile } from "./image-file.mjs";
import { publishFileBatch } from "./image-atomic-save.mjs";
import { openImageProjectAnchor } from "./image-project-anchor.mjs";
import {
  beginMapAssetPublication,
  mapAssetTransactionJournalPath,
  removeMapAssetTransactionJournal,
  writeMapAssetTransactionJournal,
} from "./map-asset-publication.mjs";
import { parseTiledDocument } from "../public/map-editor/tiled-document.js";
import { parseTiledTemplate } from "../public/map-editor/tiled-template.js";
import { parseTiledWorld } from "../public/map-editor/tiled-world.js";

const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set([".tmj", ".tsj", ".tx", ".world"]);
const ALLOWED_REFERENCE_EXTENSIONS = new Set([
  ".aac", ".avif", ".flac", ".gif", ".jpeg", ".jpg", ".m4a", ".mp3", ".ogg",
  ".opus", ".png", ".svg", ".tmj", ".tsj", ".tx", ".wav", ".webm", ".webp", ".world",
]);
const DECODABLE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export class MapProjectImportError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectImportError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Create a bounded, content-addressed import plan. The caller must perform
 * user/session authorization before invoking this function. All paths in the
 * public result remain project-relative; absolute paths are kept only in the
 * non-enumerable commit fields used immediately by the server.
 */
export async function planMapProjectImport(input = {}) {
  const sourceProject = await inspectProjectRoot(input.sourceProjectPath, "源工程");
  const targetProject = await inspectProjectRoot(input.targetProjectPath, "目标工程");
  if (sourceProject === targetProject) {
    throw importError(400, "MAP_IMPORT_SAME_PROJECT", "同工程素材请直接复用，不需要跨工程复制");
  }
  const sourceRoots = normalizeRoots(input.sourceResourceRoots);
  const targetRoots = normalizeRoots(input.targetResourceRoots);
  const sourcePath = normalizeRelativePath(input.sourcePath);
  const targetPath = normalizeRelativePath(input.targetPath);
  if (path.posix.extname(sourcePath).toLowerCase() !== path.posix.extname(targetPath).toLowerCase()) {
    throw importError(415, "MAP_IMPORT_PRIMARY_FORMAT_MISMATCH", "源素材和目标素材必须使用相同的文件格式");
  }
  assertWithinRoots(sourceRoots, sourcePath, "源素材");
  assertWithinRoots(targetRoots, targetPath, "目标素材");
  const limits = normalizeLimits(input);
  const sourceProjectName = safeProjectName(input.sourceProjectName || path.basename(sourceProject));
  const records = new Map();
  const pending = [sourcePath];
  let scannedBytes = 0;
  while (pending.length) {
    const currentPath = pending.shift();
    if (records.has(currentPath)) continue;
    const record = await readProjectFile(sourceProject, sourceRoots, currentPath, limits.maxBytesPerFile);
    scannedBytes += record.size;
    if (!Number.isSafeInteger(scannedBytes) || scannedBytes > limits.maxTotalBytes) {
      throw importError(413, "MAP_IMPORT_TOTAL_SIZE_LIMIT", "跨工程素材总大小超过上限");
    }
    const document = DOCUMENT_EXTENSIONS.has(path.posix.extname(currentPath).toLowerCase())
      ? parseJsonDocument(record.buffer, currentPath)
      : null;
    const references = document
      ? collectDocumentReferences(document, path.posix.extname(currentPath).toLowerCase())
      : [];
    const normalizedReferences = [];
    for (const reference of references) {
      const resolved = resolveProjectReference(currentPath, reference.value);
      if (!resolved) {
        throw importError(
          422,
          "MAP_IMPORT_EXTERNAL_REFERENCE",
          `素材 ${currentPath} 包含不能复制的外部引用：${reference.value}`,
        );
      }
      assertWithinRoots(sourceRoots, resolved, "素材依赖");
      normalizedReferences.push({ ...reference, sourcePath: resolved });
      if (!records.has(resolved)) pending.push(resolved);
    }
    records.set(currentPath, Object.freeze({
      sourcePath: currentPath,
      sourceAbsolutePath: record.absolutePath,
      sourceSize: record.size,
      sourceSha256: record.sha256,
      sourceMode: record.mode,
      sourceBuffer: document ? null : record.buffer,
      imageMetadata: record.imageMetadata || null,
      document,
      references: Object.freeze(normalizedReferences),
    }));
    if (records.size > limits.maxFiles) {
      throw importError(413, "MAP_IMPORT_FILE_LIMIT", "跨工程素材依赖数量超过上限");
    }
  }

  validateImportedTilesetDimensions(records);

  const mapping = new Map([[sourcePath, targetPath]]);
  for (const currentPath of records.keys()) {
    if (currentPath === sourcePath) continue;
    mapping.set(
      currentPath,
      dependencyTargetPath({
        targetPath,
        sourceProjectName,
        sourcePath: currentPath,
      }),
    );
  }

  const files = [];
  let totalBytes = 0;
  for (const record of records.values()) {
    const mappedPath = mapping.get(record.sourcePath);
    const transformed = record.document
      ? serializeDocument(rewriteDocumentReferences(record.document, record.sourcePath, mappedPath, mapping, record.references), record.sourcePath)
      : null;
    const outputSize = transformed ? transformed.length : record.sourceSize;
    const sha256 = transformed ? sha256Hex(transformed) : record.sourceSha256;
    totalBytes += outputSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw importError(413, "MAP_IMPORT_TOTAL_SIZE_LIMIT", "跨工程素材总大小超过上限");
    }
    const targetAbsolutePath = path.join(targetProject, ...mappedPath.split("/"));
    const existing = await inspectTargetFile(targetProject, targetAbsolutePath, limits.maxBytesPerFile);
    let action = "copy";
    if (existing) {
      if (existing.size !== outputSize || existing.sha256 !== sha256) {
        throw importError(409, "MAP_IMPORT_TARGET_CONFLICT", `目标素材已存在且内容不同：${mappedPath}`);
      }
      action = "reuse";
    }
    const entry = {
      sourcePath: record.sourcePath,
      targetPath: mappedPath,
      kind: resourceKind(mappedPath),
      size: outputSize,
      sha256,
      action,
      dependency: record.sourcePath !== sourcePath,
      ...(action === "copy" && record.document
        ? { data: transformed }
        : action === "copy"
          ? { sourceAbsolutePath: record.sourceAbsolutePath, expectedSourceSize: record.sourceSize, expectedSourceSha256: record.sourceSha256 }
          : {}),
    };
    Object.defineProperties(entry, {
      targetAbsolutePath: { value: targetAbsolutePath, enumerable: false },
      sourceAbsolutePath: { value: record.sourceAbsolutePath, enumerable: false },
      isDocument: { value: Boolean(record.document), enumerable: false },
    });
    files.push(Object.freeze(entry));
  }
  const copyBytes = files.filter((entry) => entry.action === "copy").reduce((sum, entry) => sum + entry.size, 0);
  const publicFiles = files.map(({ data, sourceAbsolutePath, expectedSourceSize, expectedSourceSha256, ...entry }) => entry);
  const planHash = sha256Hex(Buffer.from(JSON.stringify({
    sourceProject: sourceProjectName,
    sourcePath,
    targetPath,
    files: publicFiles,
  }), "utf8"));
  const plan = {
    schema: "wfl.map-project-import.v1",
    planHash,
    source: { projectName: sourceProjectName, path: sourcePath },
    target: { path: targetPath },
    files: Object.freeze(publicFiles.map((entry) => Object.freeze(entry))),
    copyCount: files.filter((entry) => entry.action === "copy").length,
    reuseCount: files.filter((entry) => entry.action === "reuse").length,
    copyBytes,
    totalBytes,
  };
  Object.defineProperty(plan, "_commit", {
    value: Object.freeze({ sourceProject, targetProject, files: Object.freeze(files), limits }),
    enumerable: false,
  });
  return Object.freeze(plan);
}

/** Commit only the exact plan returned by planMapProjectImport. */
export async function commitMapProjectImportPlan(plan, { temporaryRoot, uid = null, gid = null } = {}) {
  if (!plan?._commit || plan.schema !== "wfl.map-project-import.v1") {
    throw importError(400, "MAP_IMPORT_PLAN_INVALID", "跨工程导入计划无效或已过期");
  }
  const files = plan._commit.files.filter((entry) => entry.action === "copy");
  if (!files.length) return Object.freeze({ published: [], reused: plan.reuseCount, plan: publicImportPlan(plan) });
  const root = path.resolve(String(temporaryRoot || ""));
  if (!path.isAbsolute(String(temporaryRoot || "")) || root === path.parse(root).root) {
    throw importError(500, "MAP_IMPORT_TEMP_ROOT_INVALID", "跨工程导入事务目录无效");
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const candidateDirectory = await fs.mkdtemp(path.join(root, "candidate-import-"));
  const journalPath = mapAssetTransactionJournalPath(candidateDirectory);
  let anchor = null;
  const releasePublication = beginMapAssetPublication(candidateDirectory);
  let preserveRecovery = false;
  try {
    anchor = await openImageProjectAnchor(plan._commit.targetProject);
    const outputs = files.map((entry) => ({
      ...(entry.isDocument ? { data: entry.data } : {
        sourcePath: entry.sourceAbsolutePath,
        expected: { size: entry.expectedSourceSize, sha256: entry.expectedSourceSha256 },
      }),
      targetPath: entry.targetAbsolutePath,
      expected: entry.isDocument ? { size: entry.size, sha256: entry.sha256 } : { size: entry.expectedSourceSize, sha256: entry.expectedSourceSha256 },
      mode: 0o640,
      uid,
      gid,
    }));
    const published = await publishFileBatch({
      outputs,
      maxBytesPerFile: plan._commit.limits.maxBytesPerFile,
      maxTotalBytes: plan._commit.limits.maxTotalBytes,
    }, {
      projectAnchor: anchor,
      journal: (state) => writeMapAssetTransactionJournal({
        journalPath,
        projectPath: plan._commit.targetProject,
        jobId: `map-import-${plan.planHash.slice(0, 24)}`,
        state,
      }),
    });
    await removeMapAssetTransactionJournal(journalPath).catch(() => {});
    return Object.freeze({
      published: Object.freeze(published.map((entry, index) => Object.freeze({
        ...entry,
        sourcePath: files[index].sourcePath,
        targetPath: files[index].targetPath,
        kind: files[index].kind,
      }))),
      reused: plan.reuseCount,
      plan: publicImportPlan(plan),
    });
  } catch (error) {
    preserveRecovery = Boolean(error?.rollbackFailures?.length || error?.partialOutputs?.length);
    if (preserveRecovery) {
      error.recoveryTransaction = path.basename(candidateDirectory);
    } else {
      await removeMapAssetTransactionJournal(journalPath).catch(() => {});
    }
    throw error;
  } finally {
    releasePublication();
    await anchor?.close().catch(() => {});
    if (!preserveRecovery) await fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export function publicImportPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  return {
    schema: plan.schema,
    planHash: plan.planHash,
    source: plan.source,
    target: plan.target,
    files: plan.files,
    copyCount: plan.copyCount,
    reuseCount: plan.reuseCount,
    copyBytes: plan.copyBytes,
    totalBytes: plan.totalBytes,
  };
}

function collectDocumentReferences(document, extension) {
  const references = [];
  const add = (value, kind) => {
    if (typeof value === "string" && value) references.push({ value, kind });
  };
  const properties = (items) => {
    for (const property of Array.isArray(items) ? items : []) {
      if (!property || typeof property !== "object") continue;
      if (String(property.type || "").toLowerCase() === "file") add(property.value, "file");
      if (property.type === "class" || property.value && typeof property.value === "object") propertiesFromValue(property.value);
    }
  };
  const propertiesFromValue = (value) => {
    if (Array.isArray(value)) return value.forEach((entry) => propertiesFromValue(entry));
    if (!value || typeof value !== "object") return;
    if (String(value.type || "").toLowerCase() === "file") add(value.value, "file");
    if (Array.isArray(value.value)) return properties(value.value);
    if (value.value && typeof value.value === "object") propertiesFromValue(value.value);
  };
  const tileset = (entry) => {
    if (!entry || typeof entry !== "object") return;
    add(entry.source, "tileset");
    add(entry.image, "image");
    properties(entry.properties);
    for (const tile of Array.isArray(entry.tiles) ? entry.tiles : []) {
      add(tile?.image, "image");
      properties(tile?.properties);
      properties(tile?.objectgroup?.properties);
      for (const object of Array.isArray(tile?.objectgroup?.objects) ? tile.objectgroup.objects : []) {
        add(object?.template, "template");
        properties(object?.properties);
      }
    }
  };
  const layers = (items) => {
    for (const layer of Array.isArray(items) ? items : []) {
      add(layer?.image, "image");
      properties(layer?.properties);
      for (const object of Array.isArray(layer?.objects) ? layer.objects : []) {
        add(object?.template, "template");
        properties(object?.properties);
        if (object?.tileset && typeof object.tileset === "object") add(object.tileset.source, "tileset");
      }
      layers(layer?.layers);
    }
  };
  if (extension === ".tmj" || extension === ".world") {
    for (const entry of Array.isArray(document.tilesets) ? document.tilesets : []) tileset(entry);
    layers(document.layers);
    properties(document.properties);
    for (const map of Array.isArray(document.maps) ? document.maps : []) add(map?.file || map?.path, "map");
  } else if (extension === ".tsj") {
    tileset(document);
  } else if (extension === ".tx") {
    tileset(document.tileset);
    add(document.object?.template, "template");
    // Preserve compatibility with older WFL drafts that placed the tileset
    // beside the object fields. Tiled itself stores it at document.tileset.
    add(document.object?.tileset?.source, "tileset");
    properties(document.object?.properties);
  }
  return references;
}

function rewriteDocumentReferences(document, sourcePath, targetPath, mapping, references) {
  const result = structuredClone(document);
  const rewrite = (value) => {
    if (typeof value !== "string" || !value) return value;
    const resolved = resolveProjectReference(sourcePath, value);
    const destination = resolved ? mapping.get(resolved) : null;
    return destination ? relativeReference(targetPath, destination) : value;
  };
  const properties = (items) => {
    for (const property of Array.isArray(items) ? items : []) {
      if (!property || typeof property !== "object") continue;
      if (String(property.type || "").toLowerCase() === "file" && typeof property.value === "string") property.value = rewrite(property.value);
      if (property.value && typeof property.value === "object") rewritePropertyValue(property.value);
    }
  };
  const rewritePropertyValue = (value) => {
    if (Array.isArray(value)) return value.forEach((entry) => rewritePropertyValue(entry));
    if (!value || typeof value !== "object") return;
    if (String(value.type || "").toLowerCase() === "file" && typeof value.value === "string") value.value = rewrite(value.value);
    if (value.value && typeof value.value === "object") rewritePropertyValue(value.value);
  };
  const tileset = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (typeof entry.source === "string") entry.source = rewrite(entry.source);
    if (typeof entry.image === "string") entry.image = rewrite(entry.image);
    properties(entry.properties);
    for (const tile of Array.isArray(entry.tiles) ? entry.tiles : []) {
      if (typeof tile?.image === "string") tile.image = rewrite(tile.image);
      properties(tile?.properties);
      properties(tile?.objectgroup?.properties);
      for (const object of Array.isArray(tile?.objectgroup?.objects) ? tile.objectgroup.objects : []) {
        if (typeof object?.template === "string") object.template = rewrite(object.template);
        properties(object?.properties);
      }
    }
  };
  const layers = (items) => {
    for (const layer of Array.isArray(items) ? items : []) {
      if (typeof layer?.image === "string") layer.image = rewrite(layer.image);
      properties(layer?.properties);
      for (const object of Array.isArray(layer?.objects) ? layer.objects : []) {
        if (typeof object?.template === "string") object.template = rewrite(object.template);
        properties(object?.properties);
        if (object?.tileset && typeof object.tileset.source === "string") object.tileset.source = rewrite(object.tileset.source);
      }
      layers(layer?.layers);
    }
  };
  if (sourcePath.toLowerCase().endsWith(".tmj") || sourcePath.toLowerCase().endsWith(".world")) {
    for (const entry of Array.isArray(result.tilesets) ? result.tilesets : []) tileset(entry);
    layers(result.layers);
    properties(result.properties);
    for (const map of Array.isArray(result.maps) ? result.maps : []) {
      if (typeof map?.file === "string") map.file = rewrite(map.file);
      if (typeof map?.path === "string") map.path = rewrite(map.path);
    }
  } else if (sourcePath.toLowerCase().endsWith(".tsj")) {
    tileset(result);
  } else if (sourcePath.toLowerCase().endsWith(".tx")) {
    tileset(result.tileset);
    if (typeof result.object?.template === "string") result.object.template = rewrite(result.object.template);
    if (typeof result.object?.tileset?.source === "string") result.object.tileset.source = rewrite(result.object.tileset.source);
    properties(result.object?.properties);
  }
  return result;
}

function serializeDocument(document, sourcePath) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/**
 * Validate image dimensions and atlas geometry before an import plan can be
 * committed.  The normal resource-write path performs the same check after a
 * candidate is staged; doing it here is important because a cross-project
 * import rewrites references and otherwise could publish a TSJ whose declared
 * dimensions no longer describe its actual image.
 */
function validateImportedTilesetDimensions(records) {
  for (const [sourcePath, record] of records) {
    const extension = path.posix.extname(sourcePath).toLowerCase();
    if (extension === ".tsj") {
      validateImportedTileset(record.document, sourcePath, records);
    } else if (extension === ".tmj") {
      for (const [index, entry] of (Array.isArray(record.document?.tilesets) ? record.document.tilesets : []).entries()) {
        if (entry && typeof entry === "object" && typeof entry.source !== "string") {
          validateImportedTileset(entry, `${sourcePath}#tileset-${index}`, records);
        }
      }
    } else if (extension === ".tx" && record.document?.tileset && typeof record.document.tileset === "object") {
      validateImportedTileset(record.document.tileset, `${sourcePath}#tileset`, records);
    }
  }
}

function validateImportedTileset(tileset, sourcePath, records) {
  if (!tileset || typeof tileset !== "object") return;
  if (typeof tileset.image === "string") {
    const image = importedImageMetadata(sourcePath, tileset.image, records);
    // SVG/GIF/AVIF and other allowed standalone resources are copied as
    // opaque files.  Their dimensions are not part of the bounded raster
    // decoder used by import planning, so preserve the existing Tiled
    // document and let the normal editor/catalog inspect them later.
    if (!image) return validateImportedTilesetCollectionTiles(tileset, sourcePath, records);
    const imageWidth = positiveImportedInteger(tileset.imagewidth, "imagewidth", sourcePath, false);
    const imageHeight = positiveImportedInteger(tileset.imageheight, "imageheight", sourcePath, false);
    if (imageWidth !== null && imageWidth !== image.width) {
      throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 的 imagewidth 与图片实际尺寸不一致`);
    }
    if (imageHeight !== null && imageHeight !== image.height) {
      throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 的 imageheight 与图片实际尺寸不一致`);
    }
    const tileWidth = positiveImportedInteger(tileset.tilewidth, "tilewidth", sourcePath, true);
    const tileHeight = positiveImportedInteger(tileset.tileheight, "tileheight", sourcePath, true);
    const margin = nonNegativeImportedInteger(tileset.margin, "margin", sourcePath);
    const spacing = nonNegativeImportedInteger(tileset.spacing, "spacing", sourcePath);
    const usableWidth = image.width - margin * 2;
    const usableHeight = image.height - margin * 2;
    const columns = usableWidth >= tileWidth
      ? Math.floor((usableWidth + spacing) / (tileWidth + spacing))
      : 0;
    const rows = usableHeight >= tileHeight
      ? Math.floor((usableHeight + spacing) / (tileHeight + spacing))
      : 0;
    const exactWidth = columns > 0 && columns * tileWidth + Math.max(0, columns - 1) * spacing === usableWidth;
    const exactHeight = rows > 0 && rows * tileHeight + Math.max(0, rows - 1) * spacing === usableHeight;
    if (!columns || !rows || !exactWidth || !exactHeight) {
      throw importError(
        422,
        "MAP_IMPORT_TILESET_GRID_INVALID",
        `瓦片集 ${sourcePath} 的图片不能按 ${tileWidth}×${tileHeight}、margin=${margin}、spacing=${spacing} 整齐切分`,
      );
    }
    const declaredColumns = positiveImportedInteger(tileset.columns, "columns", sourcePath, false);
    if (declaredColumns !== null && declaredColumns !== columns) {
      throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 的 columns 与图片网格不一致`);
    }
    const declaredTileCount = positiveImportedInteger(tileset.tilecount, "tilecount", sourcePath, false);
    if (declaredTileCount !== null && declaredTileCount !== columns * rows) {
      throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 的 tilecount 与图片网格不一致`);
    }
  }

  validateImportedTilesetCollectionTiles(tileset, sourcePath, records);
}

function validateImportedTilesetCollectionTiles(tileset, sourcePath, records) {
  // Image-collection tilesets do not have one atlas.  Validate every tile's
  // decoded image and its optional declared dimensions instead.
  for (const [index, tile] of (Array.isArray(tileset.tiles) ? tileset.tiles : []).entries()) {
    if (!tile || typeof tile !== "object" || typeof tile.image !== "string") continue;
    const tilePath = `${sourcePath}#tile-${index}`;
    const image = importedImageMetadata(tilePath, tile.image, records);
    if (!image) continue;
    const imageWidth = positiveImportedInteger(tile.imagewidth, "imagewidth", tilePath, false);
    const imageHeight = positiveImportedInteger(tile.imageheight, "imageheight", tilePath, false);
    if (imageWidth !== null && imageWidth !== image.width) {
      throw importError(422, "MAP_IMPORT_TILESET_IMAGE_INVALID", `瓦片 ${tilePath} 的 imagewidth 与图片实际尺寸不一致`);
    }
    if (imageHeight !== null && imageHeight !== image.height) {
      throw importError(422, "MAP_IMPORT_TILESET_IMAGE_INVALID", `瓦片 ${tilePath} 的 imageheight 与图片实际尺寸不一致`);
    }
  }
}

function importedImageMetadata(ownerPath, reference, records) {
  const resolved = resolveProjectReference(ownerPath.split("#", 1)[0], reference);
  const record = resolved ? records.get(resolved) : null;
  if (!record) {
    throw importError(422, "MAP_IMPORT_TILESET_IMAGE_INVALID", `瓦片集 ${ownerPath} 的图片无法取得实际尺寸：${reference}`);
  }
  return record.imageMetadata || null;
}

function positiveImportedInteger(value, field, sourcePath, required) {
  if (value === undefined || value === null) {
    if (required) throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 缺少有效的 ${field}`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 的 ${field} 无效`);
  }
  return parsed;
}

function nonNegativeImportedInteger(value, field, sourcePath) {
  if (value === undefined || value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw importError(422, "MAP_IMPORT_TILESET_GRID_INVALID", `瓦片集 ${sourcePath} 的 ${field} 无效`);
  }
  return parsed;
}

function resolveProjectReference(ownerPath, value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  if (value.includes("\\") || value.includes("\0")) throw importError(422, "MAP_IMPORT_REFERENCE_INVALID", `资源引用无效：${value}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), value));
  if (!resolved || resolved === "." || resolved.startsWith("../") || resolved === ".." || resolved.split("/").some((segment) => segment.startsWith("."))) {
    throw importError(403, "MAP_IMPORT_REFERENCE_OUTSIDE", `资源引用越过工程目录：${value}`);
  }
  const extension = path.posix.extname(resolved).toLowerCase();
  if (!ALLOWED_REFERENCE_EXTENSIONS.has(extension)) {
    throw importError(415, "MAP_IMPORT_REFERENCE_UNSUPPORTED", `不支持复制此资源类型：${resolved}`);
  }
  return resolved;
}

function dependencyTargetPath({ targetPath, sourceProjectName, sourcePath }) {
  const directory = path.posix.dirname(targetPath);
  return path.posix.join(directory, "_deps", sourceProjectName, sourcePath);
}

function relativeReference(ownerPath, targetPath) {
  const reference = path.posix.relative(path.posix.dirname(ownerPath), targetPath);
  if (!reference || reference.startsWith("../") && path.posix.dirname(targetPath) === "") return path.posix.basename(targetPath);
  return reference;
}

async function readProjectFile(projectRoot, roots, relativePath, maxBytes) {
  assertWithinRoots(roots, relativePath, "资源");
  const absolutePath = await safeProjectPath(projectRoot, relativePath);
  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw importError(415, "MAP_IMPORT_RESOURCE_NOT_FILE", `资源不是普通文件：${relativePath}`);
    if (stat.size <= 0 || stat.size > maxBytes) throw importError(413, "MAP_IMPORT_FILE_SIZE_LIMIT", `资源超过单文件上限：${relativePath}`);
    const extension = path.posix.extname(relativePath).toLowerCase();
    let imageMetadata = null;
    if (DECODABLE_IMAGE_EXTENSIONS.has(extension)) {
      try {
        imageMetadata = await inspectDecodedImageFile(absolutePath, {
          maxBytes,
          maxWidth: 16_384,
          maxHeight: 16_384,
          maxPixels: 64 * 1024 * 1024,
          allowedFormats: [extension === ".jpg" ? "jpeg" : extension.slice(1)],
        });
      } catch (error) {
        throw importError(422, "MAP_IMPORT_IMAGE_INVALID", `图片资源无法解码：${relativePath}`, error);
      }
      await assertSourceFileIdentity(absolutePath, stat, relativePath);
    }
    const document = DOCUMENT_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
    let buffer = null;
    let sha256;
    if (document) {
      buffer = await handle.readFile();
      sha256 = sha256Hex(buffer);
    } else {
      const digest = crypto.createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
        if (!bytesRead) break;
        digest.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (offset !== stat.size) throw importError(409, "MAP_IMPORT_SOURCE_CHANGED", `源素材读取期间发生变化：${relativePath}`);
      sha256 = digest.digest("hex");
    }
    await assertSourceFileIdentity(absolutePath, stat, relativePath);
    return {
      absolutePath,
      buffer,
      size: stat.size,
      mode: stat.mode & 0o777,
      sha256,
      imageMetadata,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertSourceFileIdentity(absolutePath, expected, relativePath) {
  const current = await fs.lstat(absolutePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current || current.isSymbolicLink() || !current.isFile()
    || current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size
    || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) {
    throw importError(409, "MAP_IMPORT_SOURCE_CHANGED", `源素材读取期间发生变化：${relativePath}`);
  }
}

async function inspectTargetFile(projectRoot, absolutePath, maxBytes) {
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw importError(500, "MAP_IMPORT_TARGET_READ_FAILED", "无法读取目标素材状态", error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw importError(403, "MAP_IMPORT_TARGET_UNSAFE", "目标素材不能是符号链接或目录");
  if (stat.size > maxBytes) throw importError(413, "MAP_IMPORT_FILE_SIZE_LIMIT", "目标素材超过单文件上限");
  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== stat.size || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw importError(409, "MAP_IMPORT_TARGET_CHANGED", "目标素材在计划期间发生变化");
    }
    const digest = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, current.size || 1));
    let offset = 0;
    while (offset < current.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, current.size - offset), offset);
      if (!bytesRead) break;
      digest.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset !== current.size) throw importError(409, "MAP_IMPORT_TARGET_CHANGED", "目标素材在计划期间发生变化");
    return { size: current.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function safeProjectPath(projectRoot, relativePath) {
  let current = projectRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") throw importError(404, "MAP_IMPORT_SOURCE_NOT_FOUND", `源素材不存在：${relativePath}`);
      throw error;
    });
    if (stat.isSymbolicLink()) throw importError(403, "MAP_IMPORT_SOURCE_UNSAFE", `源素材路径包含符号链接：${relativePath}`);
  }
  const real = await fs.realpath(current);
  if (real !== current || !isWithin(projectRoot, real)) throw importError(403, "MAP_IMPORT_SOURCE_UNSAFE", "源素材越过工程目录");
  return real;
}

async function inspectProjectRoot(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw importError(400, "MAP_IMPORT_PROJECT_INVALID", `${label}路径无效`);
  }
  const resolved = path.resolve(value);
  const [real, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]).catch((error) => {
    throw importError(404, "MAP_IMPORT_PROJECT_NOT_FOUND", `${label}不存在`, error);
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) {
    throw importError(403, "MAP_IMPORT_PROJECT_UNSAFE", `${label}不能是符号链接`);
  }
  return real;
}

function parseJsonDocument(buffer, relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  try {
    const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/u, ""));
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("not object");
    if (extension === ".tmj") {
      parseTiledDocument(buffer, { expectedKind: "map", sourcePath: relativePath });
    } else if (extension === ".tsj") {
      parseTiledDocument(buffer, { expectedKind: "tileset", sourcePath: relativePath });
    } else if (extension === ".tx") {
      parseTiledTemplate(document, { sourcePath: relativePath });
    } else if (extension === ".world") {
      parseTiledWorld(buffer, { sourcePath: relativePath });
    }
    return document;
  } catch (error) {
    throw importError(422, "MAP_IMPORT_DOCUMENT_INVALID", `Tiled 文档无效：${relativePath}`, error);
  }
}

function normalizeRoots(value) {
  if (!Array.isArray(value) || !value.length) throw importError(403, "MAP_IMPORT_FOLDERS_INVALID", "Tiled folders 范围无效");
  return [...new Set(value.map((entry) => entry === "" ? "" : normalizeRelativePath(entry)))];
}

function assertWithinRoots(roots, relativePath, label) {
  if (!roots.some((root) => isWithinRelativeRoot(root, relativePath))) {
    throw importError(403, "MAP_IMPORT_OUTSIDE_FOLDERS", `${label}不在 Tiled folders 范围内：${relativePath}`);
  }
}

function normalizeLimits(input) {
  const maxFiles = boundedInteger(input.maxFiles, DEFAULT_MAX_FILES, 1, DEFAULT_MAX_FILES);
  const maxBytesPerFile = boundedInteger(input.maxBytesPerFile, DEFAULT_MAX_BYTES_PER_FILE, 1, DEFAULT_MAX_BYTES_PER_FILE);
  const maxTotalBytes = boundedInteger(input.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1, DEFAULT_MAX_TOTAL_BYTES);
  return { maxFiles, maxBytesPerFile, maxTotalBytes };
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw importError(400, "MAP_IMPORT_PATH_INVALID", "工程相对路径无效");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw importError(400, "MAP_IMPORT_PATH_INVALID", "工程相对路径不能包含越界或隐藏路径");
  }
  return segments.join("/");
}

function resourceKind(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension === ".tmj") return "map";
  if (extension === ".tsj") return "tileset";
  if (extension === ".tx") return "template";
  if (extension === ".world") return "world";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".avif"].includes(extension)) return "image";
  if ([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"].includes(extension)) return "audio";
  return "other";
}

function safeProjectName(value) {
  const normalized = String(value || "source").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "").slice(0, 80);
  return normalized || "source";
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isWithinRelativeRoot(root, candidate) {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw importError(400, "MAP_IMPORT_LIMIT_INVALID", "导入事务限制无效");
  return parsed;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function importError(statusCode, code, message, cause = null) {
  return new MapProjectImportError(statusCode, code, message, cause);
}
