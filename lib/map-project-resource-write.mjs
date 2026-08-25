import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { inspectDecodedImageFile } from "./image-file.mjs";
import {
  normalizeCharacterAnimationDocument,
  serializeCharacterAnimationDocument,
} from "../public/character-editor/character-animation-model.js";
import { collectTiledReferences, parseTiledDocument } from "../public/map-editor/tiled-document.js";
import { parseTiledTemplate } from "../public/map-editor/tiled-template.js";
import { parseTiledWorld } from "../public/map-editor/tiled-world.js";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATE_BYTES = 4 * 1024 * 1024 * 1024;
const TRANSACTION_DIRECTORY_PREFIX = ".codex-map-transaction-";
const TRANSACTION_JOURNAL_NAME = ".map-resource-transaction.json";
const TRANSACTION_SCHEMA = "wfl.map-resource-transaction.v1";
const MAX_TRANSACTION_JOURNAL_BYTES = 512 * 1024;
const activeResourceTransactionDirectories = new Set();
// Resource writers can be constructed by different runtime adapters in the
// same process. Keep the project lock table at module scope so those adapters
// still serialize against one another; an instance-local map would only
// protect calls made through one writer object.
const sharedResourceTargetLocks = new Map();

export class MapProjectResourceWriteError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectResourceWriteError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Register an in-process resource transaction so recovery cannot race it. */
export function beginMapProjectResourceTransaction(stagingDirectory) {
  const directory = path.resolve(String(stagingDirectory || ""));
  if (!path.isAbsolute(String(stagingDirectory || "")) || directory === path.parse(directory).root) {
    throw writeError(500, "map-resource-transaction-directory-invalid", "地图资源事务目录无效");
  }
  activeResourceTransactionDirectories.add(directory);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeResourceTransactionDirectories.delete(directory);
  };
}

function activeResourceTransactionDirectorySet() {
  return new Set(activeResourceTransactionDirectories);
}

function projectResourceLockKey(projectPath) {
  return `${path.resolve(projectPath)}\0project-resources`;
}

/**
 * Atomic writer for small Tiled project resources such as object templates.
 * Map documents continue to use the chunked MapSaveSessionStore; this writer
 * deliberately does not introduce a second large-file upload path.
 */
export class MapProjectResourceWriter {
  constructor(options = {}) {
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
    this.maxCandidateBytes = positiveInteger(
      options.maxCandidateBytes,
      DEFAULT_MAX_CANDIDATE_BYTES,
      "maxCandidateBytes",
    );
    this.candidateRoots = normalizeCandidateRoots(options.candidateRoots);
  }

  async saveTemplate(input = {}) {
    const projectPath = await inspectProjectRoot(input.projectPath);
    const resourceRoots = normalizeResourceRoots(input.resourceRoots);
    const relativePath = normalizeTemplatePath(input.relativePath);
    if (!resourceRoots.some((root) => isWithinRoot(root, relativePath))) {
      throw writeError(403, "map-project-resource-outside-folders", "模板不在 Tiled 项目的 folders 范围内");
    }
    const document = normalizeTemplateDocument(input.document);
    return this.saveJsonResource({
      projectPath,
      resourceRoots,
      relativePath,
      expectedVersion: input.expectedVersion,
      document,
      pathErrorCode: "invalid-map-project-template-path",
      existsCode: "map-project-template-exists",
      conflictCode: "map-project-template-version-conflict",
      sizeCode: "map-project-template-size-limit",
      label: "对象模板",
      validate: input.validate,
      validateReferences: true,
    });
  }

  async saveCompositeMap(input = {}) {
    const projectPath = await inspectProjectRoot(input.projectPath);
    const resourceRoots = normalizeResourceRoots(input.resourceRoots);
    const relativePath = normalizeCompositeMapPath(input.relativePath);
    if (!resourceRoots.some((root) => isWithinRoot(root, relativePath))) {
      throw writeError(403, "map-project-resource-outside-folders", "组合地图不在 Tiled 项目的 folders 范围内");
    }
    const document = normalizeCompositeMapDocument(input.document);
    return this.saveJsonResource({
      projectPath,
      resourceRoots,
      relativePath,
      expectedVersion: input.expectedVersion,
      document,
      pathErrorCode: "invalid-map-project-composite-path",
      existsCode: "map-project-composite-exists",
      conflictCode: "map-project-composite-version-conflict",
      sizeCode: "map-project-composite-size-limit",
      label: "组合地图",
      validate: input.validate,
      validateReferences: true,
    });
  }

  async saveCharacterAnimation(input = {}) {
    const projectPath = await inspectProjectRoot(input.projectPath);
    const resourceRoots = normalizeResourceRoots(input.resourceRoots);
    const relativePath = normalizeCharacterAnimationPath(input.relativePath);
    if (!resourceRoots.some((root) => isWithinRoot(root, relativePath))) {
      throw writeError(403, "map-project-resource-outside-folders", "角色动画清单不在 Tiled 项目的 folders 范围内");
    }
    let document;
    try {
      document = normalizeCharacterAnimationDocument(input.document);
    } catch (error) {
      throw writeError(422, "invalid-wfl-character-animation", error.message);
    }
    return this.saveJsonResource({
      projectPath,
      resourceRoots,
      relativePath,
      expectedVersion: input.expectedVersion,
      document,
      pathErrorCode: "invalid-wfl-character-animation-path",
      existsCode: "wfl-character-animation-exists",
      conflictCode: "wfl-character-animation-version-conflict",
      sizeCode: "wfl-character-animation-size-limit",
      postCommitConflictCode: "wfl-character-animation-post-commit-conflict",
      label: "角色动画清单",
      validate: async () => validateCharacterAnimationReferences({
        projectPath,
        resourceRoots,
        document,
        maxBytes: this.maxCandidateBytes,
      }),
      validateReferences: false,
      serialize: () => Buffer.from(serializeCharacterAnimationDocument(document), "utf8"),
    });
  }

  async saveTransaction(input = {}) {
    const projectPath = await inspectProjectRoot(input.projectPath);
    const resourceRoots = normalizeResourceRoots(input.resourceRoots);
    const rawFiles = Array.isArray(input.files) ? input.files : [];
    if (!rawFiles.length || rawFiles.length > 256) {
      throw writeError(400, "invalid-map-resource-transaction", "地图素材事务必须包含 1 到 256 个文件");
    }
    const files = rawFiles.map((entry, index) => {
      const relativePath = normalizeProjectResourcePath(entry?.relativePath);
      if (!resourceRoots.some((root) => isWithinRoot(root, relativePath))) {
        throw writeError(403, "map-project-resource-outside-folders", `事务文件 ${relativePath} 不在 Tiled folders 范围内`);
      }
      const hasContent = entry && Object.hasOwn(entry, "content") && entry.content !== undefined;
      const content = hasContent ? toBuffer(entry.content) : null;
      const candidatePath = hasContent ? null : normalizeCandidatePath(entry?.candidatePath, this.candidateRoots);
      const candidateSize = candidatePath === null ? null : normalizeCandidateSize(entry?.candidateSize, this.maxCandidateBytes);
      const candidateSha256 = candidatePath === null ? null : normalizeExpectedVersion(entry?.candidateSha256);
      if (candidatePath !== null && !candidateSha256) {
        throw writeError(400, "invalid-map-resource-candidate", "大文件事务候选必须提供 SHA-256");
      }
      return {
        index,
        relativePath,
        content,
        candidatePath,
        candidateSize,
        candidateSha256,
        expectedVersion: normalizeExpectedVersion(entry?.expectedVersion),
        targetPath: path.join(projectPath, ...relativePath.split("/")),
      };
    });
    const seen = new Set();
    for (const file of files) {
      if (seen.has(file.relativePath)) throw writeError(400, "map-resource-transaction-duplicate", `事务重复写入 ${file.relativePath}`);
      seen.add(file.relativePath);
    }
    const inlineBytes = files.reduce((total, file) => total + (file.content?.length || 0), 0);
    const candidateBytes = files.reduce((total, file) => total + (file.candidateSize || 0), 0);
    const totalBytes = inlineBytes + candidateBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || inlineBytes > this.maxBytes || candidateBytes > this.maxCandidateBytes) {
      throw writeError(413, "map-resource-transaction-size-limit", "地图素材事务超过管理员设置的保存上限");
    }
    const lockKey = projectResourceLockKey(projectPath);
    return this.withTargetLock(lockKey, async () => {
      const stagingDirectory = await fs.mkdtemp(path.join(projectPath, TRANSACTION_DIRECTORY_PREFIX));
      const releaseTransaction = beginMapProjectResourceTransaction(stagingDirectory);
      const journalPath = path.join(stagingDirectory, TRANSACTION_JOURNAL_NAME);
      const staged = [];
      const published = [];
      let preserveRecovery = false;
      try {
        for (const file of files) {
          const parentPath = await inspectSafeParent(projectPath, file.relativePath);
          const before = await inspectOptionalTarget(projectPath, file.targetPath, this.maxCandidateBytes);
          assertWriteVersion(before, file.expectedVersion, "map-resource-transaction-exists", "map-resource-transaction-version-conflict", "事务文件");
          const temporaryPath = path.join(parentPath, `.${path.basename(file.targetPath)}.codex-transaction-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
          await stageTransactionCandidate(file, temporaryPath, before);
          const candidateStat = await fs.lstat(temporaryPath);
          if (!candidateStat.isFile() || candidateStat.size !== (file.candidateSize ?? file.content.length)) {
            throw writeError(409, "map-resource-transaction-candidate-conflict", `事务候选 ${file.relativePath} 大小已变化`);
          }
          const candidateHash = await fileSha256(temporaryPath);
          if (candidateHash !== (file.candidateSha256 || sha256(file.content))) {
            throw writeError(409, "map-resource-transaction-candidate-conflict", `事务候选 ${file.relativePath} 已变化`);
          }
          staged.push({
            ...file,
            parentPath,
            before,
            temporaryPath,
            backupPath: path.join(stagingDirectory, `backup-${file.index}`),
            candidateStat,
            size: candidateStat.size,
            candidateSha256: candidateHash,
          });
        }
        await writeTransactionJournal(journalPath, {
          projectPath,
          phase: "staged",
          entries: staged,
          published: [],
        });
        await input.validate?.({ projectPath, files: staged.map(publicStagedFile) });
        if (input.validateReferences === true) {
          await validateStagedTiledReferences({
            projectPath,
            staged,
            maxBytes: this.maxCandidateBytes,
          });
        }
        for (const file of staged) {
          const current = await inspectOptionalTarget(projectPath, file.targetPath, this.maxCandidateBytes);
          assertWriteVersion(current, file.expectedVersion, "map-resource-transaction-exists", "map-resource-transaction-version-conflict", "事务文件");
        }
        // The first dependency-closure pass happens before the target-version
        // boundary check.  Run it once more immediately before backups and
        // publication so an existing TSJ/image/template replaced during the
        // staging or validation window cannot silently invalidate a batch
        // that is about to be committed.  This remains a bounded check and
        // still fails closed if a dependency changes again while publishing.
        if (input.validateReferences === true) {
          await validateStagedTiledReferences({
            projectPath,
            staged,
            maxBytes: this.maxCandidateBytes,
          });
        }
        // Re-run the caller's live authorization at the final publish
        // boundary. A grant or version can become stale while a large
        // dependency closure is being parsed; no backup or rename may happen
        // after that boundary has failed.
        await input.validate?.({
          projectPath,
          files: staged.map(publicStagedFile),
          phase: "before-publish",
        });
        // Keep the optimistic target-version check immediately adjacent to
        // the final authorization callback.  The earlier check protects the
        // long staging/validation window; this second check closes the
        // callback-to-backup window for writers that do not themselves read
        // every target version.
        for (const file of staged) {
          const current = await inspectOptionalTarget(projectPath, file.targetPath, this.maxCandidateBytes);
          assertWriteVersion(current, file.expectedVersion, "map-resource-transaction-exists", "map-resource-transaction-version-conflict", "事务文件");
        }
        for (const file of staged) {
          if (file.before) await fs.link(file.targetPath, file.backupPath);
        }
        await writeTransactionJournal(journalPath, {
          projectPath,
          phase: "backed-up",
          entries: staged,
          published: [],
        });
        for (const file of staged) {
          if (file.before) {
            await fs.rename(file.temporaryPath, file.targetPath);
          } else {
            try {
              await fs.link(file.temporaryPath, file.targetPath);
              // The target now belongs to this transaction. Register it
              // before unlinking the private staging link so an interruption
              // or cleanup error cannot leave an unjournaled new file behind.
              published.push(file);
              await fs.unlink(file.temporaryPath);
            } catch (error) {
              if (error?.code === "EEXIST") {
                throw writeError(409, "map-resource-transaction-exists", `事务文件 ${file.relativePath} 已存在`);
              }
              throw error;
            }
          }
          if (!published.includes(file)) published.push(file);
          await writeTransactionJournal(journalPath, {
            projectPath,
            phase: "publishing",
            entries: staged,
            published,
          });
        }
        await Promise.all([...new Set(staged.map((file) => file.parentPath))].map(syncDirectory));
        const results = [];
        for (const file of staged) {
          const saved = await inspectOptionalTarget(projectPath, file.targetPath, this.maxCandidateBytes);
          if (!saved || saved.version !== file.candidateSha256 || saved.stat.size !== file.size) {
            throw writeError(409, "map-resource-transaction-post-commit-conflict", `事务文件 ${file.relativePath} 提交后发生变化`);
          }
          results.push({
            relativePath: file.relativePath,
            version: saved.version,
            size: saved.stat.size,
            modifiedAt: saved.stat.mtimeMs,
            created: file.before === null,
          });
        }
        await writeTransactionJournal(journalPath, {
          projectPath,
          phase: "committed",
          entries: staged,
          published,
        });
        return Object.freeze({ files: Object.freeze(results), totalBytes });
      } catch (error) {
        let rollbackConflict = false;
        try {
          for (const file of [...published].reverse()) {
            const current = await lstatOrNull(file.targetPath);
            // Never delete or overwrite a file that no longer belongs to this
            // transaction. A concurrent writer wins and the caller receives a
            // conflict rather than losing that writer's bytes.
            if (!current || !sameIdentity(current, file.candidateStat)) {
              rollbackConflict = true;
              continue;
            }
            await fs.rm(file.targetPath, { force: true });
            if (file.before) await fs.rename(file.backupPath, file.targetPath);
          }
        } catch (rollbackError) {
          preserveRecovery = true;
          rollbackConflict = true;
          error = writeError(409, "map-resource-transaction-rollback-failed", "事务回滚失败，已保留恢复现场", rollbackError);
        }
        if (rollbackConflict) {
          preserveRecovery = true;
          throw writeError(409, "map-resource-transaction-post-commit-conflict", "事务回滚期间发现文件已被其他任务替换，未覆盖外部修改", error);
        }
        if (error instanceof MapProjectResourceWriteError || Number.isInteger(error?.statusCode)) throw error;
        throw fileError(error, "地图素材事务提交失败");
      } finally {
        releaseTransaction();
        if (!preserveRecovery) {
          await Promise.all(staged.map((file) => fs.rm(file.temporaryPath, { force: true }).catch(() => {})));
          await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
        }
      }
    });
  }

  async saveJsonResource(input) {
    const content = input.serialize
      ? input.serialize()
      : Buffer.from(`${JSON.stringify(input.document, null, 2)}\n`, "utf8");
    if (content.length > this.maxBytes) {
      throw writeError(413, input.sizeCode, `${input.label}超过管理员设置的保存上限`);
    }
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    const targetPath = path.join(input.projectPath, ...input.relativePath.split("/"));
    // Share the project-level transaction lock with multi-file saves. A
    // target-only lock allowed a single-file editor save to race between a
    // transaction's final version check and its rename.
    return this.withTargetLock(projectResourceLockKey(input.projectPath), async () => {
      const parentPath = await inspectSafeParent(input.projectPath, input.relativePath);
      const before = await inspectOptionalTarget(input.projectPath, targetPath, this.maxBytes);
      assertWriteVersion(before, expectedVersion, input.existsCode, input.conflictCode, input.label);
      const temporaryPath = path.join(
        parentPath,
        `.${path.basename(targetPath)}.codex-map-resource-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
      );
      let handle;
      try {
        const mode = before?.stat.mode ? before.stat.mode & 0o777 : 0o600;
        handle = await fs.open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = null;
        await input.validate?.({
          candidatePath: temporaryPath,
          projectPath: input.projectPath,
          relativePath: input.relativePath,
        });
        if (input.validateReferences === true) {
          const candidateStat = await fs.lstat(temporaryPath);
          const staged = [{
            relativePath: input.relativePath,
            temporaryPath,
            candidateStat,
            size: candidateStat.size,
            candidateSha256: sha256(content),
            before,
          }];
          await validateStagedTiledReferences({
            projectPath: input.projectPath,
            staged,
            maxBytes: this.maxCandidateBytes,
          });
        }
        const current = await inspectOptionalTarget(input.projectPath, targetPath, this.maxBytes);
        assertWriteVersion(current, expectedVersion, input.existsCode, input.conflictCode, input.label);
        if (input.validateReferences === true) {
          const candidateStat = await fs.lstat(temporaryPath);
          await validateStagedTiledReferences({
            projectPath: input.projectPath,
            staged: [{
              relativePath: input.relativePath,
              temporaryPath,
              candidateStat,
              size: candidateStat.size,
              candidateSha256: sha256(content),
              before,
            }],
            maxBytes: this.maxCandidateBytes,
          });
        }
        if (current) await fs.rename(temporaryPath, targetPath);
        else {
          try {
            await fs.link(temporaryPath, targetPath);
          } catch (error) {
            if (error?.code === "EEXIST") {
              throw writeError(409, input.existsCode, `${input.label}已存在，默认不会覆盖已有文件`);
            }
            throw error;
          }
          await fs.unlink(temporaryPath);
        }
        await syncDirectory(parentPath);
        const saved = await inspectOptionalTarget(input.projectPath, targetPath, this.maxBytes);
        if (!saved || saved.version !== sha256(content) || saved.stat.size !== content.length) {
          throw writeError(409, input.postCommitConflictCode || `${input.label === "组合地图" ? "map-project-composite" : "map-project-template"}-post-commit-conflict`, `${input.label}提交后立即发生变化，请重新读取`);
        }
        return Object.freeze({
          relativePath: input.relativePath,
          version: saved.version,
          size: saved.stat.size,
          modifiedAt: saved.stat.mtimeMs,
          created: before === null,
        });
      } catch (error) {
        // Preserve structured validation/authentication failures supplied by
        // the HTTP layer (for example a child Tiled validator returning 422)
        // instead of converting them into a misleading generic 500.
        if (error instanceof MapProjectResourceWriteError || Number.isInteger(error?.statusCode)) throw error;
        throw fileError(error, `无法保存${input.label}`);
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
      }
    });
  }

  async withTargetLock(targetPath, operation) {
    const previous = sharedResourceTargetLocks.get(targetPath) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    sharedResourceTargetLocks.set(targetPath, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (sharedResourceTargetLocks.get(targetPath) === current) sharedResourceTargetLocks.delete(targetPath);
    }
  }
}

/**
 * Validate the complete dependency closure of staged Tiled resources.  A
 * direct TMJ -> existing TSJ reference is not enough: that TSJ may itself
 * reference a missing image or template.  Walk every reachable Tiled JSON
 * document, resolving candidates from the transaction first and existing
 * files second.  The walk is bounded and cycle-safe, and never follows a
 * symlink or leaves the project root.
 */
async function validateStagedTiledReferences({ projectPath, staged, maxBytes = DEFAULT_MAX_CANDIDATE_BYTES }) {
  const stagedByPath = new Map(staged.map((entry) => [entry.relativePath, entry]));
  const imageMetadata = new Map();
  const visitedDocuments = new Set();
  const roots = staged
    .filter((entry) => TILED_DOCUMENT_EXTENSIONS.has(path.posix.extname(entry.relativePath).toLowerCase()))
    .map((entry) => entry.relativePath);
  // An image can be published as a standalone resource candidate (for
  // example, when an AI task prepares an atlas before the TSJ is updated).
  // Validate every staged raster independently, not only images reached from
  // a Tiled document, so a corrupt candidate can never enter the project.
  for (const entry of staged) {
    if (isImageResourcePath(entry.relativePath)) await validateReferencedImage(entry.relativePath);
  }
  for (const relativePath of roots) {
    await visitTiledDocument(relativePath);
  }

  async function visitTiledDocument(relativePath) {
    const normalized = normalizeReferenceClosurePath(relativePath);
    if (visitedDocuments.has(normalized)) return;
    visitedDocuments.add(normalized);
    const extension = path.posix.extname(normalized).toLowerCase();
    const source = await readSafeResource(normalized);
    let document;
    try {
      if (extension === ".tmj" || extension === ".tsj") {
        document = parseTiledDocument(source, {
          expectedKind: extension === ".tsj" ? "tileset" : "map",
          sourcePath: normalized,
        }).document;
      } else if (extension === ".tx") {
        document = parseTiledTemplate(JSON.parse(source), { sourcePath: normalized }).raw;
      } else {
        document = parseTiledWorld(source, { sourcePath: normalized }).document;
      }
    } catch (error) {
      throw writeError(422, "map-resource-reference-document-invalid", `事务引用 ${normalized} 不是有效 Tiled 文档`);
    }
    if (extension === ".tsj") await validateTilesetGrid(document, normalized);
    if (extension === ".tmj") {
      for (const [index, entry] of (document.tilesets || []).entries()) {
        if (entry && typeof entry === "object" && typeof entry.source !== "string") {
          await validateTilesetGrid(entry, `${normalized}#tileset-${index}`);
        }
      }
    }
    const references = extension === ".world"
      ? collectWorldReferences(document, normalized)
      : extension === ".tx"
        ? collectTemplateReferences(document, normalized)
        : collectTiledReferences(document, { sourcePath: normalized });
    for (const reference of references) {
      if (reference.error || !reference.resolvedPath) {
        throw writeError(422, "map-resource-reference-invalid", `事务文件 ${normalized} 包含无效资源引用`);
      }
      const dependency = normalizeReferenceClosurePath(reference.resolvedPath);
      await assertSafeReferencedFile(dependency);
      if (isImageResourcePath(dependency)) {
        await validateReferencedImage(dependency);
      }
      if (TILED_DOCUMENT_EXTENSIONS.has(path.posix.extname(dependency).toLowerCase())) {
        await visitTiledDocument(dependency);
      }
    }
  }

  async function readSafeResource(relativePath) {
    const stagedEntry = stagedByPath.get(relativePath);
    const filename = stagedEntry?.temporaryPath || path.join(projectPath, ...relativePath.split("/"));
    const stat = await fs.lstat(filename).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw writeError(422, "map-resource-reference-missing", `资源引用 ${relativePath} 不存在或不是安全文件`);
    }
    if (stat.size > maxBytes) {
      throw writeError(413, "map-resource-reference-size-limit", `资源引用 ${relativePath} 超过读取上限`);
    }
    try {
      return await fs.readFile(filename, "utf8");
    } catch (error) {
      throw writeError(422, "map-resource-reference-read-failed", `无法读取资源引用 ${relativePath}`);
    }
  }

  async function assertSafeReferencedFile(relativePath) {
    const stagedEntry = stagedByPath.get(relativePath);
    const target = path.join(projectPath, ...relativePath.split("/"));
    if (stagedEntry) return;
    const relative = path.relative(projectPath, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw writeError(422, "map-resource-reference-outside-project", `资源引用 ${relativePath} 离开工程`);
    }
    let current = projectPath;
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      const ancestor = await fs.lstat(current).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!ancestor || ancestor.isSymbolicLink()) {
        throw writeError(422, "map-resource-reference-missing", `资源引用 ${relativePath} 不存在或包含不安全路径`);
      }
      if (current !== target && !ancestor.isDirectory()) {
        throw writeError(422, "map-resource-reference-missing", `资源引用 ${relativePath} 的父路径不是目录`);
      }
    }
    const stat = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw writeError(422, "map-resource-reference-missing", `资源引用 ${relativePath} 不存在或不是安全文件`);
    }
  }

  async function validateReferencedImage(relativePath) {
    const cached = imageMetadata.get(relativePath);
    if (cached) return cached;
    const stagedEntry = stagedByPath.get(relativePath);
    const filename = stagedEntry?.temporaryPath || path.join(projectPath, ...relativePath.split("/"));
    try {
      const inspected = await inspectDecodedImageFile(filename, {
        maxBytes,
        maxWidth: 16_384,
        maxHeight: 16_384,
        maxPixels: 64 * 1024 * 1024,
        allowedFormats: [path.posix.extname(relativePath).slice(1).toLowerCase() === "jpg" ? "jpeg" : path.posix.extname(relativePath).slice(1).toLowerCase()],
      });
      if (stagedEntry && (inspected.size !== stagedEntry.size)) {
        throw writeError(409, "map-resource-reference-changed", `图片资源 ${relativePath} 在校验期间发生变化`);
      }
      imageMetadata.set(relativePath, Object.freeze(inspected));
      return inspected;
    } catch (error) {
      if (error instanceof MapProjectResourceWriteError) throw error;
      throw writeError(422, "map-resource-image-invalid", `图片资源 ${relativePath} 无法解码或尺寸无效`);
    }
  }

  async function validateTilesetGrid(tileset, sourcePath) {
    if (!tileset || typeof tileset !== "object") return;
    // Image-collection tilesets have no atlas-level `image`; each tile owns
    // its raster and may declare imagewidth/imageheight.  Do not return early
    // before validating those per-tile dimensions.
    if (typeof tileset.image !== "string") {
      await validateTilesetCollectionTiles(tileset, sourcePath);
      return;
    }
    const imagePath = normalizeReferenceClosurePath(
      resolveReferenceSegments(sourcePath.split("#", 1)[0].split("/").slice(0, -1), tileset.image),
    );
    await assertSafeReferencedFile(imagePath);
    const image = await validateReferencedImage(imagePath);
    const tileWidth = Number(tileset.tilewidth);
    const tileHeight = Number(tileset.tileheight);
    const margin = Number(tileset.margin || 0);
    const spacing = Number(tileset.spacing || 0);
    if (![tileWidth, tileHeight, margin, spacing].every(Number.isSafeInteger)
      || tileWidth < 1 || tileHeight < 1 || margin < 0 || spacing < 0) {
      throw writeError(422, "map-resource-tileset-grid-invalid", `瓦片集 ${sourcePath} 的网格参数无效`);
    }
    if (tileset.imagewidth !== undefined && Number(tileset.imagewidth) !== image.width) {
      throw writeError(422, "map-resource-tileset-grid-invalid", `瓦片集 ${sourcePath} 的 imagewidth 与图片实际尺寸不一致`);
    }
    if (tileset.imageheight !== undefined && Number(tileset.imageheight) !== image.height) {
      throw writeError(422, "map-resource-tileset-grid-invalid", `瓦片集 ${sourcePath} 的 imageheight 与图片实际尺寸不一致`);
    }
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
      throw writeError(422, "map-resource-tileset-grid-invalid", `瓦片集 ${sourcePath} 的图片不能按 ${tileWidth}×${tileHeight}、margin=${margin}、spacing=${spacing} 整齐切分`);
    }
    if (tileset.columns !== undefined && Number(tileset.columns) !== columns) {
      throw writeError(422, "map-resource-tileset-grid-invalid", `瓦片集 ${sourcePath} 的 columns 与图片网格不一致`);
    }
    if (tileset.tilecount !== undefined && Number(tileset.tilecount) !== columns * rows) {
      throw writeError(422, "map-resource-tileset-grid-invalid", `瓦片集 ${sourcePath} 的 tilecount 与图片网格不一致`);
    }
    await validateTilesetCollectionTiles(tileset, sourcePath);
  }

  async function validateTilesetCollectionTiles(tileset, sourcePath) {
    const directory = sourcePath.split("#", 1)[0].split("/").slice(0, -1);
    for (const [index, tile] of (Array.isArray(tileset.tiles) ? tileset.tiles : []).entries()) {
      if (!tile || typeof tile !== "object" || typeof tile.image !== "string") continue;
      const tilePath = `${sourcePath}#tile-${index}`;
      const imagePath = normalizeReferenceClosurePath(resolveReferenceSegments(directory, tile.image));
      await assertSafeReferencedFile(imagePath);
      const image = await validateReferencedImage(imagePath);
      const declaredWidth = tile.imagewidth == null ? null : Number(tile.imagewidth);
      const declaredHeight = tile.imageheight == null ? null : Number(tile.imageheight);
      if (declaredWidth !== null && (!Number.isSafeInteger(declaredWidth) || declaredWidth < 1 || declaredWidth !== image.width)) {
        throw writeError(422, "map-resource-tileset-image-invalid", `瓦片 ${tilePath} 的 imagewidth 与图片实际尺寸不一致`);
      }
      if (declaredHeight !== null && (!Number.isSafeInteger(declaredHeight) || declaredHeight < 1 || declaredHeight !== image.height)) {
        throw writeError(422, "map-resource-tileset-image-invalid", `瓦片 ${tilePath} 的 imageheight 与图片实际尺寸不一致`);
      }
    }
  }
}

const TILED_DOCUMENT_EXTENSIONS = new Set([".tmj", ".tsj", ".tx", ".world"]);
const IMAGE_RESOURCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
function isImageResourcePath(value) {
  return IMAGE_RESOURCE_EXTENSIONS.has(path.posix.extname(value).toLowerCase());
}

function normalizeReferenceClosurePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw writeError(422, "map-resource-reference-outside-project", "Tiled 资源引用必须是工程内相对路径");
  }
  const segments = value.split("/");
  const normalized = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!normalized.length) throw writeError(422, "map-resource-reference-outside-project", "Tiled 资源引用不能离开工程");
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }
  if (!normalized.length || normalized.some((segment) => segment.startsWith("."))) {
    throw writeError(422, "map-resource-reference-invalid", "Tiled 资源引用路径无效");
  }
  return normalized.join("/");
}

function collectWorldReferences(document, sourcePath) {
  const references = [];
  for (const entry of Array.isArray(document?.maps) ? document.maps : []) {
    if (typeof entry?.fileName !== "string") continue;
    references.push(resolveClosureReference("map", entry.fileName, sourcePath));
  }
  return references;
}

function collectTemplateReferences(document, sourcePath) {
  const references = [];
  const push = (kind, value) => {
    if (typeof value !== "string") return;
    try {
      const directory = sourcePath.split("/").slice(0, -1);
      references.push({ kind, reference: value, resolvedPath: resolveReferenceSegments(directory, value), error: null });
    } catch (error) {
      references.push({ kind, reference: value, resolvedPath: null, error: error.message });
    }
  };
  const walkProperties = (properties) => {
    if (!Array.isArray(properties)) return;
    for (const property of properties) {
      if (property && property.type === "file") push("file-property", property.value);
    }
  };
  const walkObject = (object) => {
    if (!object || typeof object !== "object") return;
    if (Object.hasOwn(object, "template")) push("template", object.template);
    walkProperties(object.properties);
    if (object.objectgroup) walkLayer(object.objectgroup);
  };
  const walkLayer = (layer) => {
    if (!layer || typeof layer !== "object") return;
    walkProperties(layer.properties);
    for (const object of Array.isArray(layer.objects) ? layer.objects : []) walkObject(object);
    for (const child of Array.isArray(layer.layers) ? layer.layers : []) walkLayer(child);
  };
  walkObject(document?.object);
  const tileset = document?.tileset;
  if (tileset && typeof tileset === "object") {
    if (typeof tileset.source === "string") push("tileset", tileset.source);
    push("image", tileset.image);
    walkProperties(tileset.properties);
    for (const tile of Array.isArray(tileset.tiles) ? tileset.tiles : []) {
      push("image", tile?.image);
      walkProperties(tile?.properties);
      walkLayer(tile?.objectgroup);
    }
  }
  return references;
}

function resolveClosureReference(kind, reference, sourcePath) {
  try {
    const directory = sourcePath.split("/").slice(0, -1);
    return { kind, reference, resolvedPath: resolveReferenceSegments(directory, reference), error: null };
  } catch (error) {
    return { kind, reference, resolvedPath: null, error: error.message };
  }
}

function resolveReferenceSegments(directory, reference) {
  if (typeof reference !== "string" || !reference.trim() || reference.includes("\\")
    || reference.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(reference)) {
    throw new TypeError("Tiled 资源引用必须是工程相对路径");
  }
  const result = [...directory];
  for (const segment of reference.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!result.length) throw new TypeError("Tiled 资源引用不能离开工程");
      result.pop();
    } else result.push(segment);
  }
  if (!result.length) throw new TypeError("Tiled 资源引用必须指向文件");
  return result.join("/");
}

/**
 * Recover resource transactions left in a project directory after a process
 * crash. Recovery is conservative: an output is removed/restored only when
 * its device/inode still belongs to this transaction. External replacements
 * are never overwritten and remain reported for an administrator.
 */
export async function recoverMapProjectResourceTransactions({ projectPath } = {}) {
  const root = await inspectProjectRoot(projectPath);
  const result = { recovered: 0, completed: 0, rolledBack: 0, failures: [] };
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw fileError(error, "无法读取地图工程事务目录");
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TRANSACTION_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, entry.name);
    if (activeResourceTransactionDirectorySet().has(directory)) continue;
    const journalPath = path.join(directory, TRANSACTION_JOURNAL_NAME);
    if (!await pathExists(journalPath)) continue;
    try {
      const journal = await readTransactionJournal(journalPath);
      const outcome = await recoverTransactionJournal(root, directory, journal);
      result.recovered += 1;
      if (outcome === "completed") result.completed += 1;
      else result.rolledBack += 1;
    } catch (error) {
      result.failures.push({
        directory: entry.name,
        code: typeof error?.code === "string" ? error.code : "MAP_RESOURCE_TRANSACTION_RECOVERY_FAILED",
        message: String(error?.message || "地图资源事务恢复失败").slice(0, 500),
      });
    }
  }
  return Object.freeze({
    recovered: result.recovered,
    completed: result.completed,
    rolledBack: result.rolledBack,
    failures: Object.freeze(result.failures.map((entry) => Object.freeze(entry))),
  });
}

/**
 * Read-only administrator view of journals that could not be recovered.
 * Absolute filesystem paths and candidate filenames are intentionally omitted;
 * the recovery endpoint returns only project-relative resource metadata.
 */
export async function inspectMapProjectResourceTransactions({ projectPath } = {}) {
  const root = await inspectProjectRoot(projectPath);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const transactions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TRANSACTION_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, entry.name);
    const journalPath = path.join(directory, TRANSACTION_JOURNAL_NAME);
    if (!await pathExists(journalPath)) continue;
    try {
      const journal = await readTransactionJournal(journalPath);
      if (activeResourceTransactionDirectorySet().has(directory)) {
        transactions.push(Object.freeze({
          transactionType: "map-resource",
          directory: entry.name,
          phase: "protected",
          protected: true,
          message: "对应地图资源事务仍在提交，已跳过恢复",
        }));
        continue;
      }
      transactions.push(Object.freeze({
        transactionType: "map-resource",
        directory: entry.name,
        phase: journal.phase,
        published: Object.freeze(Array.isArray(journal.published) ? [...journal.published] : []),
        entries: Object.freeze(journal.entries.map((item) => Object.freeze({
          relativePath: String(item.relativePath || ""),
          beforeExists: item.beforeExists === true,
          beforeVersion: item.beforeVersion || null,
          candidateSize: Number(item.candidateSize),
          candidateSha256: item.candidateSha256,
        }))),
      }));
    } catch (error) {
      transactions.push(Object.freeze({
        directory: entry.name,
        phase: "invalid",
        error: Object.freeze({
          code: String(error?.code || "MAP_RESOURCE_TRANSACTION_RECOVERY_FAILED"),
          message: String(error?.message || "事务日志无效").slice(0, 500),
        }),
      }));
    }
  }
  return Object.freeze(transactions);
}

async function inspectProjectRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw writeError(400, "invalid-map-project", "地图工程路径无效");
  }
  const resolved = path.resolve(value);
  try {
    const [realPath, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
    if (realPath !== resolved || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw writeError(403, "map-project-symlink", "地图工程不能通过符号链接写入");
    }
    return realPath;
  } catch (error) {
    if (error instanceof MapProjectResourceWriteError) throw error;
    throw fileError(error, "地图工程不存在");
  }
}

async function inspectSafeParent(projectPath, relativePath) {
  const parentSegments = relativePath.split("/").slice(0, -1);
  let current = projectPath;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw writeError(404, "map-project-template-directory-not-found", "模板目录不存在，请先在工程中创建目录");
      }
      throw fileError(error, "无法读取模板目录");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw writeError(403, "map-project-resource-symlink", "模板目录不能包含符号链接或非目录路径");
    }
  }
  const realPath = await fs.realpath(current);
  if (realPath !== current || !isWithinAbsolute(projectPath, realPath)) {
    throw writeError(403, "map-project-resource-symlink", "模板目录不能越过地图工程");
  }
  return current;
}

async function inspectOptionalTarget(projectPath, targetPath, maxBytes) {
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fileError(error, "无法读取对象模板状态");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw writeError(403, "map-project-resource-symlink", "对象模板不能是符号链接或非文件路径");
  }
  if (stat.size > maxBytes) {
    throw writeError(413, "map-project-template-size-limit", "已有对象模板超过管理员设置的保存上限");
  }
  const realPath = await fs.realpath(targetPath);
  if (realPath !== targetPath || !isWithinAbsolute(projectPath, realPath)) {
    throw writeError(403, "map-project-resource-symlink", "对象模板不能越过地图工程");
  }
  return { stat, version: await fileSha256(targetPath) };
}

function assertWriteVersion(target, expectedVersion, existsCode = "map-project-template-exists", conflictCode = "map-project-template-version-conflict", label = "对象模板") {
  if (expectedVersion === null) {
    if (target) throw writeError(409, existsCode, `${label}已存在，默认不会覆盖已有文件`);
    return;
  }
  if (!target || target.version !== expectedVersion) {
    throw writeError(409, conflictCode, `${label}已被其他窗口修改，当前内容未覆盖服务端文件`);
  }
}

function normalizeTemplateDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.type !== "template" || !value.object || typeof value.object !== "object"
    || Array.isArray(value.object)) {
    throw writeError(422, "invalid-tiled-template", "Tiled 模板必须包含 type=template 和 object");
  }
  if (value.object.id !== 1) {
    throw writeError(422, "invalid-tiled-template-object-id", "Tiled 模板对象 ID 必须为 1");
  }
  if (Object.hasOwn(value.object, "x") || Object.hasOwn(value.object, "y")
    || Object.hasOwn(value.object, "template")) {
    throw writeError(422, "invalid-tiled-template-instance-fields", "模板对象不能保存实例位置或模板回引用");
  }
  try {
    return structuredClone(value);
  } catch {
    throw writeError(422, "invalid-tiled-template", "Tiled 模板包含无法序列化的值");
  }
}

function normalizeCompositeMapDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.type !== "map" || !Array.isArray(value.layers)) {
    throw writeError(422, "invalid-tiled-composite-map", "组合素材必须是有效的 Tiled map 文档");
  }
  try {
    return structuredClone(value);
  } catch {
    throw writeError(422, "invalid-tiled-composite-map", "组合地图包含无法序列化的值");
  }
}

function normalizeTemplatePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw writeError(400, "invalid-map-project-template-path", "模板路径必须是工程相对 .tx 路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw writeError(400, "invalid-map-project-template-path", "模板路径不能包含越界或隐藏路径");
  }
  if (path.posix.extname(value).toLowerCase() !== ".tx") {
    throw writeError(415, "map-project-template-kind-mismatch", "对象模板路径必须以 .tx 结尾");
  }
  return segments.join("/");
}

function normalizeCompositeMapPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw writeError(400, "invalid-map-project-composite-path", "组合地图路径必须是工程相对 .tmj 路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw writeError(400, "invalid-map-project-composite-path", "组合地图路径不能包含越界或隐藏路径");
  }
  if (path.posix.extname(value).toLowerCase() !== ".tmj") {
    throw writeError(415, "map-project-composite-kind-mismatch", "组合地图路径必须以 .tmj 结尾");
  }
  return segments.join("/");
}

function normalizeProjectResourcePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw writeError(400, "invalid-map-project-resource-path", "事务资源路径必须是工程相对路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw writeError(400, "invalid-map-project-resource-path", "事务资源路径不能包含越界或隐藏路径");
  }
  const extension = path.posix.extname(value).toLowerCase();
  if (![".tmj", ".tsj", ".tx", ".world", ".png", ".jpg", ".jpeg", ".webp"].includes(extension)
    && !value.toLowerCase().endsWith(".character.json")) {
    throw writeError(415, "map-resource-transaction-kind-mismatch", "事务只允许 Tiled 文档和独立图片文件");
  }
  return segments.join("/");
}

function normalizeCharacterAnimationPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw writeError(400, "invalid-wfl-character-animation-path", "角色动画清单必须使用工程相对路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw writeError(400, "invalid-wfl-character-animation-path", "角色动画清单路径不能包含越界或隐藏路径");
  }
  if (!value.toLowerCase().endsWith(".character.json")) {
    throw writeError(415, "wfl-character-animation-kind-mismatch", "角色动画清单路径必须以 .character.json 结尾");
  }
  return segments.join("/");
}

function normalizeRecoveryRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw writeError(500, "map-resource-transaction-journal-invalid", "事务日志资源路径无效");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw writeError(500, "map-resource-transaction-journal-invalid", "事务日志资源路径越界");
  }
  if (![".tmj", ".tsj", ".tx", ".world", ".png", ".jpg", ".jpeg", ".webp"].includes(path.posix.extname(value).toLowerCase())
    && !value.toLowerCase().endsWith(".character.json")) {
    throw writeError(500, "map-resource-transaction-journal-invalid", "事务日志资源类型无效");
  }
  return segments.join("/");
}

async function validateCharacterAnimationReferences({ projectPath, resourceRoots, document, maxBytes }) {
  const sourcePath = normalizeCharacterSourceImagePath(document?.source?.path);
  if (!resourceRoots.some((root) => isWithinRoot(root, sourcePath))) {
    throw writeError(403, "map-project-resource-outside-folders", "角色精灵图不在 Tiled 项目的 folders 范围内");
  }
  const targetPath = path.join(projectPath, ...sourcePath.split("/"));
  await assertSafeCharacterFile(projectPath, targetPath, sourcePath);
  const extension = path.posix.extname(sourcePath).slice(1).toLowerCase();
  let image;
  try {
    image = await inspectDecodedImageFile(targetPath, {
      maxBytes,
      maxWidth: 16_384,
      maxHeight: 16_384,
      maxPixels: 64 * 1024 * 1024,
      allowedFormats: [extension === "jpg" ? "jpeg" : extension],
    });
  } catch (error) {
    if (error instanceof MapProjectResourceWriteError) throw error;
    throw writeError(422, "wfl-character-source-image-invalid", `角色精灵图 ${sourcePath} 无法解码或尺寸无效`);
  }
  const source = document.source;
  if (source.imageWidth !== image.width || source.imageHeight !== image.height) {
    throw writeError(422, "wfl-character-source-size-mismatch", `角色精灵图 ${sourcePath} 的实际尺寸与清单不一致`);
  }
  const gridWidth = source.marginX * 2
    + source.columns * source.frameWidth
    + Math.max(0, source.columns - 1) * source.spacingX;
  const gridHeight = source.marginY * 2
    + source.rows * source.frameHeight
    + Math.max(0, source.rows - 1) * source.spacingY;
  if (gridWidth !== image.width || gridHeight !== image.height) {
    throw writeError(422, "wfl-character-grid-invalid", `角色精灵图 ${sourcePath} 不能按当前网格完整切分`);
  }
  return image;
}

function normalizeCharacterSourceImagePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw writeError(422, "wfl-character-source-path-invalid", "角色精灵图必须是工程相对路径");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw writeError(422, "wfl-character-source-path-invalid", "角色精灵图路径无效");
  }
  const extension = path.posix.extname(value).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw writeError(415, "wfl-character-source-image-format", "角色精灵图只支持 PNG、JPG 和 WebP");
  }
  return segments.join("/");
}

async function assertSafeCharacterFile(projectPath, targetPath, relativePath) {
  const relative = path.relative(projectPath, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw writeError(403, "map-project-resource-outside-project", `角色精灵图 ${relativePath} 离开工程目录`);
  }
  let current = projectPath;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) {
      throw writeError(422, "wfl-character-source-missing", `角色精灵图 ${relativePath} 不存在或包含不安全路径`);
    }
    if (current !== targetPath && !stat.isDirectory()) {
      throw writeError(422, "wfl-character-source-missing", `角色精灵图 ${relativePath} 的父路径不是目录`);
    }
  }
  const stat = await fs.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw writeError(422, "wfl-character-source-missing", `角色精灵图 ${relativePath} 不是安全文件`);
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw writeError(400, "invalid-map-resource-transaction-content", "事务文件内容无效");
}

function normalizeCandidateRoots(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 16) throw new TypeError("candidateRoots must be an array");
  return Object.freeze(value.map((entry) => {
    if (typeof entry !== "string" || !path.isAbsolute(entry) || entry.includes("\0")) {
      throw new TypeError("candidateRoots must contain absolute paths");
    }
    return path.resolve(entry);
  }));
}

function normalizeCandidatePath(value, roots) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw writeError(400, "invalid-map-resource-candidate", "事务候选路径无效");
  }
  const resolved = path.resolve(value);
  if (!roots.length || !roots.some((root) => isWithinAbsolute(root, resolved))) {
    throw writeError(403, "map-resource-candidate-outside-root", "事务候选不在受控暂存目录");
  }
  return resolved;
}

function normalizeCandidateSize(value, maximum) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) {
    throw writeError(413, "map-resource-transaction-size-limit", "事务候选大小无效或超过上限");
  }
  return size;
}

async function stageTransactionCandidate(file, temporaryPath, before) {
  const mode = before?.stat.mode ? before.stat.mode & 0o777 : 0o600;
  if (file.candidatePath) {
    await assertSafeCandidateSource(file.candidatePath);
    const initial = await fs.lstat(file.candidatePath);
    if (!initial.isFile() || initial.size !== file.candidateSize) {
      throw writeError(409, "map-resource-transaction-candidate-conflict", `事务候选 ${file.relativePath} 大小已变化`);
    }
    const source = await fs.open(file.candidatePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    let handle;
    try {
      const sourceStat = await source.stat();
      if (!sourceStat.isFile() || sourceStat.size !== file.candidateSize) {
        throw writeError(409, "map-resource-transaction-candidate-conflict", `事务候选 ${file.relativePath} 大小已变化`);
      }
      handle = await fs.open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
      for await (const chunk of createFileChunks(source)) {
        await handle.writeFile(chunk);
      }
      await handle.sync();
      const final = await fs.lstat(file.candidatePath);
      if (!sameIdentity(initial, final) || final.size !== file.candidateSize) {
        throw writeError(409, "map-resource-transaction-candidate-conflict", `事务候选 ${file.relativePath} 在复制期间发生变化`);
      }
    } finally {
      await handle?.close().catch(() => {});
      await source.close().catch(() => {});
    }
    return;
  }
  const handle = await fs.open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(file.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertSafeCandidateSource(candidatePath) {
  let current = candidatePath;
  const ancestors = [];
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const entry of ancestors.reverse()) {
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) throw writeError(403, "map-resource-candidate-symlink", "事务候选路径不能包含符号链接");
  }
}

async function* createFileChunks(handle) {
  const buffer = Buffer.allocUnsafe(256 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) return;
    yield buffer.subarray(0, bytesRead);
  }
}


function publicStagedFile(file) {
  return Object.freeze({
    relativePath: file.relativePath,
    candidatePath: file.temporaryPath,
    size: file.size,
    version: file.candidateSha256,
  });
}

function normalizeResourceRoots(value) {
  if (!Array.isArray(value) || !value.length || value.length > 128) {
    throw writeError(400, "invalid-map-project-roots", "Tiled folders 范围无效");
  }
  return Object.freeze([...new Set(value.map((entry) => {
    if (entry === "") return "";
    if (typeof entry !== "string" || entry.includes("\0") || entry.includes("\\")) {
      throw writeError(400, "invalid-map-project-roots", "Tiled folders 范围无效");
    }
    const segments = entry.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
      throw writeError(400, "invalid-map-project-roots", "Tiled folders 范围无效");
    }
    return segments.join("/");
  }))]);
}

function normalizeExpectedVersion(value) {
  if (value === undefined || value === null || value === "") return null;
  const version = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(version)) {
    throw writeError(400, "invalid-map-project-template-version", "对象模板基础版本无效");
  }
  return version;
}

function isWithinRoot(root, candidate) {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}

function isWithinAbsolute(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeTransactionJournal(filename, { projectPath, phase, entries, published }) {
  const payload = {
    schema: TRANSACTION_SCHEMA,
    projectPath: path.resolve(projectPath),
    phase,
    entries: entries.map((entry) => ({
      relativePath: entry.relativePath,
      targetPath: entry.targetPath,
      temporaryPath: entry.temporaryPath,
      backupPath: entry.backupPath,
      expectedVersion: entry.expectedVersion,
      beforeVersion: entry.before?.version || null,
      beforeExists: entry.before !== null,
      candidateDevice: String(entry.candidateStat?.dev || ""),
      candidateInode: String(entry.candidateStat?.ino || ""),
      candidateSize: entry.size,
      candidateSha256: entry.candidateSha256,
    })),
    published: published.map((entry) => entry.relativePath),
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_TRANSACTION_JOURNAL_BYTES) throw writeError(500, "map-resource-transaction-journal-too-large", "地图资源事务日志超过上限");
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readTransactionJournal(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw writeError(500, "map-resource-transaction-journal-invalid", "地图资源事务日志不能是符号链接");
  if (!stat.isFile() || stat.size > MAX_TRANSACTION_JOURNAL_BYTES) throw writeError(500, "map-resource-transaction-journal-invalid", "地图资源事务日志无效");
  let value;
  try { value = JSON.parse(await fs.readFile(filename, "utf8")); } catch { throw writeError(500, "map-resource-transaction-journal-invalid", "地图资源事务日志不是有效 JSON"); }
  if (!value || value.schema !== TRANSACTION_SCHEMA || !["staged", "backed-up", "publishing", "committed"].includes(value.phase) || !Array.isArray(value.entries) || value.entries.length > 256) {
    throw writeError(500, "map-resource-transaction-journal-invalid", "地图资源事务日志结构无效");
  }
  return value;
}

async function recoverTransactionJournal(projectRoot, directory, journal) {
  if (path.resolve(journal.projectPath) !== path.resolve(projectRoot)) throw writeError(500, "map-resource-transaction-project-mismatch", "事务日志工程不匹配");
  const entries = journal.entries.map((entry) => {
    const relativePath = normalizeRecoveryRelativePath(entry.relativePath);
    const targetPath = path.resolve(String(entry.targetPath || ""));
    const temporaryPath = path.resolve(String(entry.temporaryPath || ""));
    const backupPath = path.resolve(String(entry.backupPath || ""));
    if (!isWithinAbsolute(projectRoot, targetPath)
      || targetPath !== path.join(projectRoot, ...relativePath.split("/"))
      || path.dirname(temporaryPath) !== path.dirname(targetPath)
      || path.dirname(backupPath) !== directory
      || !isWithinAbsolute(projectRoot, temporaryPath)
      || !isWithinAbsolute(directory, backupPath)
      || !path.basename(temporaryPath).startsWith(`.${path.basename(targetPath)}.codex-transaction-`)
      || !/^\d+-[a-f0-9]{12}$/u.test(path.basename(temporaryPath).split(".codex-transaction-")[1] || "")
      || !/^backup-\d+$/u.test(path.basename(backupPath))) {
      throw writeError(500, "map-resource-transaction-journal-invalid", "事务日志路径越界");
    }
    if (!/^[a-f0-9]{64}$/u.test(String(entry.candidateSha256 || "")) || !/^\d+$/.test(String(entry.candidateDevice || "")) || !/^\d+$/.test(String(entry.candidateInode || ""))) throw writeError(500, "map-resource-transaction-journal-invalid", "事务日志候选身份无效");
    return { ...entry, relativePath, targetPath, temporaryPath, backupPath };
  });
  await Promise.all(entries.map((entry) => assertRecoveryParent(projectRoot, entry.targetPath)));
  const complete = journal.phase === "committed" && await Promise.all(entries.map(async (entry) => {
    const stat = await lstatOrNull(entry.targetPath);
    return Boolean(
      stat
      && stat.isFile()
      && String(stat.dev) === entry.candidateDevice
      && String(stat.ino) === entry.candidateInode
      && stat.size === Number(entry.candidateSize)
      && await fileSha256(entry.targetPath) === entry.candidateSha256,
    );
  })).then((values) => values.every(Boolean));
  if (complete) {
    await fs.rm(directory, { recursive: true, force: true });
    return "completed";
  }
  // A crash can leave the old target, a candidate target, or an unrelated
  // external replacement at each path.  Never use rename(backup, target)
  // blindly: on Linux it fails with EEXIST when the old target is still
  // present, and replacing an external target would lose user data.
  for (const entry of entries.reverse()) {
    await rollbackRecoveredEntry(projectRoot, entry, journal);
  }
  await fs.rm(directory, { recursive: true, force: true });
  return "rolled-back";
}

async function assertRecoveryParent(projectRoot, targetPath) {
  const relativeParent = path.relative(projectRoot, path.dirname(targetPath));
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw writeError(500, "map-resource-transaction-journal-invalid", "事务目标目录越界");
  }
  let current = projectRoot;
  for (const segment of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw writeError(409, "map-resource-transaction-recovery-conflict", "事务目标目录已变化，已保留恢复现场");
    }
  }
}

async function rollbackRecoveredEntry(_projectRoot, entry, journal) {
  const target = await lstatOrNull(entry.targetPath);
  const candidateOwned = target && target.isFile()
    && String(target.dev) === entry.candidateDevice
    && String(target.ino) === entry.candidateInode
    && target.size === Number(entry.candidateSize)
    && await fileSha256(entry.targetPath) === entry.candidateSha256;
  const backup = entry.beforeExists ? await lstatOrNull(entry.backupPath) : null;
  const backupUsable = Boolean(backup?.isFile());

  if (candidateOwned) {
    await fs.rm(entry.targetPath, { force: true });
  } else if (target) {
    // An unchanged pre-transaction target is safe to keep.  It is commonly
    // still linked to the backup inode while a `backed-up` transaction has
    // not published this entry yet.
    const isBackupIdentity = backupUsable && sameIdentity(target, backup);
    const isExpectedBefore = entry.beforeExists && entry.beforeVersion
      && target.isFile() && await fileSha256(entry.targetPath) === entry.beforeVersion;
    if (!entry.beforeExists) {
      throw writeError(409, "map-resource-transaction-recovery-conflict", `恢复发现外部替换：${entry.relativePath}`);
    }
    if (!isBackupIdentity && !isExpectedBefore) {
      throw writeError(409, "map-resource-transaction-recovery-conflict", `恢复发现外部替换：${entry.relativePath}`);
    }
    // For an unchanged pre-transaction target, leave it in place.  The
    // private backup link is removed with the staging directory below.
  }

  if (entry.beforeExists) {
    const current = await lstatOrNull(entry.targetPath);
    const currentIsBackup = current && backupUsable && sameIdentity(current, backup);
    const currentIsBefore = current?.isFile() && entry.beforeVersion
      && await fileSha256(entry.targetPath) === entry.beforeVersion;
    if (!currentIsBackup && !currentIsBefore) {
      if (!backupUsable) {
        // The backup may have been lost only after the target was restored.
        // Verify by content before accepting the target as the old file.
        const restored = current?.isFile() && entry.beforeVersion
          && await fileSha256(entry.targetPath) === entry.beforeVersion;
        if (!restored) {
          throw writeError(409, "map-resource-transaction-recovery-conflict", `恢复缺少原文件备份：${entry.relativePath}`);
        }
      } else if (!current) {
        // No target remains, so moving the private hard-link backup is safe.
        await fs.rename(entry.backupPath, entry.targetPath);
      } else {
        throw writeError(409, "map-resource-transaction-recovery-conflict", `恢复发现外部替换：${entry.relativePath}`);
      }
    }
  }
  await fs.rm(entry.temporaryPath, { force: true });
}

async function lstatOrNull(filename) {
  try { return await fs.lstat(filename); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fileSha256(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function sameIdentity(left, right) {
  return left && right && String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function fileError(error, message) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
    return writeError(404, "map-project-resource-not-found", message, error);
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return writeError(403, "map-project-resource-forbidden", "没有权限写入地图项目资源", error);
  }
  return writeError(500, "map-project-resource-write-failed", message, error);
}

function writeError(statusCode, code, message, cause = null) {
  return new MapProjectResourceWriteError(statusCode, code, message, cause);
}
