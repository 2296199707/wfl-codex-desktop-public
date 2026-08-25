import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { normalizeThreadImport } from "./thread-import-store.mjs";

const STORE_VERSION = 1;
const PACKAGE_SCHEMA = 1;
const PACKAGE_MAGIC = Buffer.from("WFLWORKSPACE1\0", "ascii");
const HEADER_BYTES = 40;
const IV_OFFSET = 20;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIGRATION_ID_PATTERN = /^wm-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const UPLOAD_ID_PATTERN = /^wu-[a-f0-9]{32}$/;
const CLIENT_UPLOAD_ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 250_000;
const MAX_PROJECTS = 1_000;
const MAX_CONVERSATIONS = 10_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SPECIAL_MODE_BITS = 0o7000;

export const WORKSPACE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export class WorkspaceMigrationCenter {
  constructor(directory, { version, now = () => Date.now(), stagingDirectory = null } = {}) {
    this.directory = path.resolve(directory);
    this.version = String(version || "");
    this.now = now;
    this.exportsDirectory = path.join(this.directory, "exports");
    this.uploadsDirectory = path.join(this.directory, "uploads");
    this.stagingDirectory = path.resolve(stagingDirectory || path.join(this.directory, "staging"));
    this.indexPath = path.join(this.directory, "index.json");
    this.index = null;
    this.busy = false;
    this.operation = null;
    this.writeQueue = Promise.resolve();
    this.uploadWrites = new Set();
    this.userIdentity = currentUserIdentity();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    if (writeOnInitialize) {
      await Promise.all([
        fs.mkdir(this.exportsDirectory, { recursive: true, mode: 0o700 }),
        fs.mkdir(this.uploadsDirectory, { recursive: true, mode: 0o700 }),
        fs.mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 }),
      ]);
      await Promise.all([
        fs.chmod(this.directory, 0o700),
        fs.chmod(this.exportsDirectory, 0o700),
        fs.chmod(this.uploadsDirectory, 0o700),
        fs.chmod(this.stagingDirectory, 0o700),
      ]);
    }
    this.index = await readJson(this.indexPath, { version: STORE_VERSION, exports: [], uploads: [], lastImport: null });
    validateIndex(this.index);
    if (writeOnInitialize) await this.removeStaleFiles();
    return this;
  }

  snapshot() {
    this.assertInitialized();
    return {
      busy: this.busy,
      activeUploadWrites: this.uploadWrites.size,
      operation: this.operation ? structuredClone(this.operation) : null,
      exports: this.index.exports.map(publicExport).sort((left, right) => right.createdAt - left.createdAt),
      uploads: this.index.uploads.map(publicUpload).sort((left, right) => right.createdAt - left.createdAt),
      lastImport: this.index.lastImport ? structuredClone(this.index.lastImport) : null,
      limits: { chunkBytes: WORKSPACE_UPLOAD_CHUNK_BYTES, packageBytes: MAX_PACKAGE_BYTES },
    };
  }

  async createExport({ projects, conversations, includeGit = true, includeEnv = false, sourceInstanceId = null } = {}) {
    this.assertInitialized();
    const prepared = this.busy && this.operation?.type === "export" && this.operation?.status === "running";
    if (this.busy && !prepared) throw migrationError(409, "已有工作区迁移任务正在执行");
    if (!Array.isArray(projects) || !projects.length || projects.length > MAX_PROJECTS) {
      throw migrationError(400, "请选择要迁移的工程");
    }
    if (!Array.isArray(conversations) || conversations.length > MAX_CONVERSATIONS) {
      throw migrationError(400, "迁移对话数量无效");
    }
    this.busy = true;
    const createdAt = this.now();
    const id = createMigrationId(createdAt);
    const root = path.join(this.stagingDirectory, `.export-${id}`);
    const archivePath = this.exportPath(id);
    const keyPath = this.exportKeyPath(id);
    this.setOperation("export", "running", "正在整理工程文件和对话", { migrationId: id, startedAt: createdAt });
    try {
      await Promise.all([
        fs.mkdir(path.join(root, ".wfl-workspace"), { recursive: true, mode: 0o700 }),
        fs.mkdir(path.join(root, "projects"), { recursive: true, mode: 0o700 }),
        fs.mkdir(path.join(root, "conversations"), { recursive: true, mode: 0o700 }),
      ]);
      const manifestProjects = [];
      for (let index = 0; index < projects.length; index += 1) {
        const project = normalizeSourceProject(projects[index], index);
        const destination = path.join(root, "projects", project.storageName);
        const copied = await copyProjectTree(project.path, destination, {
          includeGit,
          includeEnv,
          applicationWorkspace: project.applicationWorkspace,
          expectedUser: this.userIdentity,
        });
        manifestProjects.push({
          id: project.id,
          name: project.name,
          storageName: project.storageName,
          excluded: copied.excluded,
          sourceMode: copied.sourceMode,
        });
        this.setOperation("export", "running", `正在整理工程 ${index + 1}/${projects.length}`, { migrationId: id, startedAt: createdAt });
      }

      const manifestConversations = [];
      for (let index = 0; index < conversations.length; index += 1) {
        const conversation = normalizeSourceConversation(conversations[index], manifestProjects, index);
        const filename = `thread-${String(index + 1).padStart(6, "0")}.json`;
        const transcript = normalizeThreadImport(conversation.transcript, { preserveName: true, profile: "workspace" });
        await fs.writeFile(
          path.join(root, "conversations", filename),
          `${JSON.stringify(transcript)}\n`,
          { mode: 0o600 },
        );
        manifestConversations.push({
          file: filename,
          projectId: conversation.projectId,
          name: transcript.name,
          archived: conversation.archived,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        });
      }

      const manifest = {
        schema: PACKAGE_SCHEMA,
        id,
        appVersion: this.version,
        createdAt,
        sourceInstanceId: cleanText(sourceInstanceId, 128),
        sourceUser: this.userIdentity,
        scope: "owner-workspace",
        options: { includeGit: includeGit === true, includeEnv: includeEnv === true },
        projects: manifestProjects,
        conversations: manifestConversations,
      };
      await fs.writeFile(
        path.join(root, ".wfl-workspace", "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      const key = crypto.randomBytes(32);
      this.setOperation("export", "running", "正在压缩并加密迁移包", { migrationId: id, startedAt: createdAt });
      await encryptDirectory(root, archivePath, key);
      const [stat, sha256] = await Promise.all([fs.stat(archivePath), digestFile(archivePath)]);
      if (stat.size > MAX_PACKAGE_BYTES) throw migrationError(413, "工作区迁移包不能超过 10 GB");
      const record = {
        id,
        appVersion: this.version,
        createdAt,
        sizeBytes: stat.size,
        sha256,
        projects: manifestProjects.length,
        conversations: manifestConversations.length,
      };
      await fs.writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
      this.index.exports.push(record);
      await this.persist();
      this.setOperation("export", "completed", "工作区迁移包已生成", {
        migrationId: id, startedAt: createdAt, completedAt: this.now(),
      });
      return publicExport(record);
    } catch (error) {
      await Promise.all([fs.rm(archivePath, { force: true }), fs.rm(keyPath, { force: true })]);
      this.setOperation("export", "failed", error.message, {
        migrationId: id, startedAt: createdAt, completedAt: this.now(), error: error.message,
      });
      throw error;
    } finally {
      this.busy = false;
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  requireExport(id) {
    this.assertInitialized();
    if (!MIGRATION_ID_PATTERN.test(String(id || ""))) throw migrationError(400, "迁移包编号无效");
    const record = this.index.exports.find((entry) => entry.id === id);
    if (!record) throw migrationError(404, "迁移包不存在");
    return record;
  }

  exportPath(id) {
    if (!MIGRATION_ID_PATTERN.test(String(id || ""))) throw migrationError(400, "迁移包编号无效");
    return path.join(this.exportsDirectory, `${id}.wflworkspace`);
  }

  exportKeyPath(id) {
    if (!MIGRATION_ID_PATTERN.test(String(id || ""))) throw migrationError(400, "迁移包编号无效");
    return path.join(this.exportsDirectory, `${id}.key`);
  }

  async exportKey(id) {
    const record = this.requireExport(id);
    const key = (await fs.readFile(this.exportKeyPath(id), "utf8")).trim();
    if (Buffer.from(key, "base64url").length !== 32) throw new Error("工作区迁移密钥损坏");
    return [
      "WFL-WORKSPACE-KEY-1",
      `migration=${record.id}`,
      `key=${key}`,
      `sha256=${record.sha256}`,
      "",
    ].join("\n");
  }

  async deleteExport(id) {
    this.requireExport(id);
    this.index.exports = this.index.exports.filter((entry) => entry.id !== id);
    await Promise.all([
      fs.rm(this.exportPath(id), { force: true }),
      fs.rm(this.exportKeyPath(id), { force: true }),
      this.persist(),
    ]);
  }

  async beginUpload({ filename, sizeBytes, clientUploadId = null, fileFingerprint = null } = {}) {
    this.assertInitialized();
    const size = Number(sizeBytes);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PACKAGE_BYTES) {
      throw migrationError(413, "工作区迁移包大小必须在 1 字节到 10 GB 之间");
    }
    const safeFilename = sanitizeFilename(filename);
    const normalizedClientId = clientUploadId == null ? null : String(clientUploadId).toLowerCase();
    const normalizedFingerprint = fileFingerprint == null ? null : String(fileFingerprint).toLowerCase();
    if (normalizedClientId && !CLIENT_UPLOAD_ID_PATTERN.test(normalizedClientId)) {
      throw migrationError(400, "浏览器上传编号无效");
    }
    if (normalizedFingerprint && !SHA256_PATTERN.test(normalizedFingerprint)) {
      throw migrationError(400, "迁移包文件指纹无效");
    }
    const existing = normalizedClientId
      ? this.index.uploads.find((entry) => entry.clientUploadId === normalizedClientId)
      : null;
    if (existing) {
      if (
        existing.filename !== safeFilename
        || existing.sizeBytes !== size
        || existing.fileFingerprint !== normalizedFingerprint
      ) {
        throw migrationError(409, "浏览器上传编号已绑定到另一个迁移包");
      }
      return publicUpload(existing);
    }
    const id = `wu-${crypto.randomUUID().replaceAll("-", "")}`;
    const record = {
      id,
      filename: safeFilename,
      sizeBytes: size,
      receivedBytes: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      sha256: null,
      inspection: null,
      status: "uploading",
      clientUploadId: normalizedClientId,
      fileFingerprint: normalizedFingerprint,
    };
    await fs.writeFile(this.uploadPath(id), Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    this.index.uploads.push(record);
    await this.persist();
    return publicUpload(record);
  }

  requireUpload(id) {
    this.assertInitialized();
    if (!UPLOAD_ID_PATTERN.test(String(id || ""))) throw migrationError(400, "上传编号无效");
    const record = this.index.uploads.find((entry) => entry.id === id);
    if (!record) throw migrationError(404, "上传记录不存在");
    return record;
  }

  uploadPath(id) {
    if (!UPLOAD_ID_PATTERN.test(String(id || ""))) throw migrationError(400, "上传编号无效");
    return path.join(this.uploadsDirectory, `${id}.wflworkspace`);
  }

  async appendUpload(id, input, { offset, length } = {}) {
    const record = this.requireUpload(id);
    if (this.uploadWrites.has(id)) throw migrationError(409, "此迁移包已有上传分块正在写入");
    if (record.status === "complete") throw migrationError(409, "迁移包已经上传完成");
    const start = Number(offset);
    const declaredLength = Number(length);
    if (!Number.isSafeInteger(start) || start !== record.receivedBytes) throw migrationError(409, "上传位置不连续，请从服务器记录的位置继续");
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > WORKSPACE_UPLOAD_CHUNK_BYTES) {
      throw migrationError(413, "单个上传分块不能超过 8 MB");
    }
    if (start + declaredLength > record.sizeBytes) throw migrationError(413, "上传内容超过声明的文件大小");
    this.uploadWrites.add(id);
    let written = 0;
    try {
      const handle = await fs.open(this.uploadPath(id), "r+");
      try {
        for await (const chunk of input) {
          written += chunk.length;
          if (written > declaredLength) throw migrationError(400, "上传分块长度与声明不一致");
          await handle.write(chunk, 0, chunk.length, start + written - chunk.length);
        }
      } finally {
        await handle.close();
      }
    } finally {
      this.uploadWrites.delete(id);
    }
    if (written !== declaredLength) throw migrationError(400, "上传分块不完整");
    record.receivedBytes += written;
    record.updatedAt = this.now();
    record.inspection = null;
    if (record.receivedBytes === record.sizeBytes) {
      record.sha256 = await digestFile(this.uploadPath(id));
      record.status = "complete";
    }
    await this.persist();
    return publicUpload(record);
  }

  async inspectUpload(id, keyText) {
    const staged = await this.stageUpload(id, keyText);
    try {
      const inspection = publicInspection(staged.manifest, staged.expandedBytes);
      const record = this.requireUpload(id);
      record.inspection = inspection;
      record.updatedAt = this.now();
      await this.persist();
      return inspection;
    } finally {
      await staged.cleanup();
    }
  }

  async stageUpload(id, keyText) {
    const record = this.requireUpload(id);
    if (record.status !== "complete" || record.receivedBytes !== record.sizeBytes || !record.sha256) {
      throw migrationError(409, "迁移包尚未上传完成");
    }
    const keyRecord = parseMigrationKey(keyText);
    if (keyRecord.sha256 !== record.sha256) throw migrationError(409, "迁移包与恢复密钥的 SHA-256 不一致");
    const root = path.join(this.stagingDirectory, `.import-${id}-${crypto.randomBytes(4).toString("hex")}`);
    const tarPath = `${root}.tar.gz`;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await decryptFile(this.uploadPath(id), tarPath, keyRecord.key);
      const archive = await inspectArchive(tarPath);
      await run("tar", [
        "--extract", "--gzip", `--file=${tarPath}`, `--directory=${root}`,
        "--no-same-owner", "--same-permissions", "--delay-directory-restore",
      ]);
      const tree = await inspectExtractedTree(root);
      validateExtractedMetadata(archive, tree, this.userIdentity);
      const manifestPath = path.join(root, ".wfl-workspace", "manifest.json");
      const manifestStat = await fs.stat(manifestPath).catch(() => null);
      if (!manifestStat?.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) throw migrationError(400, "迁移包清单缺失或过大");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      validateManifest(manifest, keyRecord.migration);
      validateArchiveUser(archive, manifest.sourceUser);
      if (archive.expandedBytes !== tree.bytes) throw migrationError(409, "迁移包解压校验不一致");
      await validatePackageContents(root, manifest);
      return {
        root,
        manifest,
        expandedBytes: tree.bytes,
        cleanup: async () => Promise.all([
          fs.rm(root, { recursive: true, force: true }),
          fs.rm(tarPath, { force: true }),
        ]),
      };
    } catch (error) {
      await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(tarPath, { force: true })]);
      if (error?.statusCode) throw error;
      throw migrationError(400, `工作区迁移包无法读取：${error.message}`);
    }
  }

  async completeImport(uploadId, manifest, result) {
    const record = this.requireUpload(uploadId);
    const previous = {
      status: record.status,
      updatedAt: record.updatedAt,
      lastImport: this.index.lastImport ? structuredClone(this.index.lastImport) : null,
    };
    record.status = "imported";
    record.updatedAt = this.now();
    this.index.lastImport = {
      migrationId: manifest.id,
      importedAt: this.now(),
      projects: Number(result?.projects) || 0,
      conversations: Number(result?.conversations) || 0,
    };
    try {
      await this.persist();
    } catch (error) {
      record.status = previous.status;
      record.updatedAt = previous.updatedAt;
      this.index.lastImport = previous.lastImport;
      throw error;
    }
    this.setOperation("import", "completed", "工作区导入完成", {
      migrationId: manifest.id, completedAt: this.now(),
    });
  }

  beginImport(migrationId) {
    if (this.busy) throw migrationError(409, "已有工作区迁移任务正在执行");
    this.busy = true;
    this.setOperation("import", "running", "正在校验并导入工作区", { migrationId, startedAt: this.now() });
  }

  beginExport() {
    if (this.busy) throw migrationError(409, "已有工作区迁移任务正在执行");
    this.busy = true;
    this.setOperation("export", "running", "正在读取所选工程的对话记录", { startedAt: this.now() });
  }

  failExport(error) {
    this.busy = false;
    this.setOperation("export", "failed", error.message, {
      completedAt: this.now(), error: error.message,
    });
  }

  updateOperation(type, detail) {
    if (!this.busy || this.operation?.type !== type || this.operation?.status !== "running") return;
    this.setOperation(type, "running", detail, {
      migrationId: this.operation.migrationId,
      startedAt: this.operation.startedAt,
    });
  }

  failImport(migrationId, error) {
    this.busy = false;
    this.setOperation("import", "failed", error.message, {
      migrationId, completedAt: this.now(), error: error.message,
    });
  }

  endImport() {
    this.busy = false;
  }

  async deleteUpload(id) {
    this.requireUpload(id);
    if (this.uploadWrites.has(id)) throw migrationError(409, "迁移包正在写入，暂时不能删除");
    this.index.uploads = this.index.uploads.filter((entry) => entry.id !== id);
    await Promise.all([fs.rm(this.uploadPath(id), { force: true }), this.persist()]);
  }

  setOperation(type, status, detail, patch = {}) {
    this.operation = {
      type,
      status,
      detail: cleanText(detail, 300),
      migrationId: cleanText(patch.migrationId, 80),
      startedAt: Number(patch.startedAt) || this.operation?.startedAt || this.now(),
      completedAt: Number(patch.completedAt) || null,
      error: cleanText(patch.error, 300),
      updatedAt: this.now(),
    };
  }

  async persist() {
    const snapshot = structuredClone(this.index);
    const operation = () => writeJsonAtomic(this.indexPath, snapshot);
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => {});
    await queued;
  }

  async removeStaleFiles() {
    const cutoff = this.now() - UPLOAD_RETENTION_MS;
    const stale = this.index.uploads.filter((entry) => entry.updatedAt < cutoff);
    if (stale.length) {
      const ids = new Set(stale.map((entry) => entry.id));
      this.index.uploads = this.index.uploads.filter((entry) => !ids.has(entry.id));
      await Promise.all([...stale.map((entry) => fs.rm(this.uploadPath(entry.id), { force: true })), this.persist()]);
    }
    const entries = await fs.readdir(this.stagingDirectory, { withFileTypes: true });
    await Promise.all(entries.map((entry) => fs.rm(path.join(this.stagingDirectory, entry.name), { recursive: true, force: true })));
  }

  assertInitialized() {
    if (!this.index) throw new Error("Workspace migration center is not initialized");
  }
}

function normalizeSourceProject(input, index) {
  const sourcePath = path.resolve(String(input?.path || ""));
  const name = normalizeProjectName(input?.name);
  return {
    id: `project-${String(index + 1).padStart(4, "0")}`,
    name,
    path: sourcePath,
    storageName: `${String(index + 1).padStart(4, "0")}-${name}`,
    applicationWorkspace: input?.applicationWorkspace === true,
  };
}

function normalizeSourceConversation(input, projects, index) {
  const projectId = String(input?.projectId || "");
  if (!projects.some((project) => project.id === projectId)) throw migrationError(400, `第 ${index + 1} 个对话没有对应工程`);
  return {
    projectId,
    transcript: input?.transcript,
    archived: input?.archived === true,
    createdAt: boundedTimestamp(input?.createdAt),
    updatedAt: boundedTimestamp(input?.updatedAt),
  };
}

async function copyProjectTree(source, destination, options) {
  const sourceStat = await fs.lstat(source).catch(() => null);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) throw migrationError(400, "迁移工程必须是真实目录");
  if (await fs.realpath(source) !== source) throw migrationError(400, "迁移工程目录不能经过符号链接");
  assertEntryMetadata(sourceStat, options.expectedUser, "迁移工程根目录");
  const excluded = {
    git: 0,
    env: 0,
    dependencies: 0,
    runtime: 0,
    applicationArtifacts: 0,
    links: 0,
    special: 0,
  };
  await fs.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: async (entryPath) => {
      const relative = path.relative(source, entryPath);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (parts.includes("node_modules")) { excluded.dependencies += 1; return false; }
      if (parts.includes(".codex-desktop") || parts.includes(".codex-runtime")) { excluded.runtime += 1; return false; }
      if (
        options.applicationWorkspace
        && (
          ["backups", "coverage", "test-results"].includes(parts[0])
          || parts[0] === ".codex-package.json"
          || /^npm-debug\.log(?:\.|$)/.test(parts[0])
        )
      ) {
        excluded.applicationArtifacts += 1;
        return false;
      }
      if (!options.includeGit && parts.includes(".git")) { excluded.git += 1; return false; }
      if (!options.includeEnv && parts.some((part) => part === ".env" || part.startsWith(".env."))) { excluded.env += 1; return false; }
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) { excluded.links += 1; return false; }
      if (!stat.isDirectory() && !stat.isFile()) { excluded.special += 1; return false; }
      assertEntryMetadata(stat, options.expectedUser, `迁移工程文件 ${relative}`);
      return true;
    },
  });
  return { excluded, sourceMode: permissionMode(sourceStat) };
}

async function encryptDirectory(root, output, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  PACKAGE_MAGIC.copy(header);
  iv.copy(header, IV_OFFSET);
  await fs.writeFile(output, header, { mode: 0o600, flag: "wx" });
  const archive = spawn("tar", [
    "--create", "--gzip", "--file=-", "--directory", root,
    ".wfl-workspace", "projects", "conversations",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  archive.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const stream = pipeline(archive.stdout, cipher, createWriteStream(output, { flags: "a", mode: 0o600 }));
  const exited = new Promise((resolve, reject) => {
    archive.on("error", reject);
    archive.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited with status ${code}`)));
  });
  const results = await Promise.allSettled([stream, exited]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  await fs.appendFile(output, cipher.getAuthTag());
}

async function decryptFile(input, output, key) {
  const handle = await fs.open(input, "r");
  let stat;
  let header;
  let tag;
  try {
    stat = await handle.stat();
    if (stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error("迁移包已截断");
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, PACKAGE_MAGIC.length).equals(PACKAGE_MAGIC)) throw new Error("不是受支持的工作区迁移包");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(IV_OFFSET, IV_OFFSET + IV_BYTES));
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(input, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    createWriteStream(output, { mode: 0o600, flags: "wx" }),
  );
}

async function inspectArchive(archivePath) {
  const [namesOutput, verboseOutput] = await Promise.all([
    capture("tar", ["--list", "--gzip", `--file=${archivePath}`, "--quoting-style=escape"]),
    capture("tar", ["--list", "--gzip", "--verbose", "--numeric-owner", `--file=${archivePath}`, "--quoting-style=escape"]),
  ]);
  const names = namesOutput.split("\n").filter(Boolean);
  const details = verboseOutput.split("\n").filter(Boolean);
  if (!names.length || names.length !== details.length) throw migrationError(400, "迁移包目录结构无效");
  if (names.length > MAX_ARCHIVE_ENTRIES) throw migrationError(413, "迁移包文件数量过多");
  let expandedBytes = 0;
  const metadata = new Map();
  for (let index = 0; index < names.length; index += 1) {
    const name = validateEntryName(names[index]);
    const fields = details[index].trim().split(/\s+/);
    const type = fields[0]?.[0];
    const size = Number(fields[2]);
    if (!new Set(["-", "d"]).has(type)) throw migrationError(400, "迁移包不能包含链接或特殊设备");
    if (!Number.isSafeInteger(size) || size < 0) throw migrationError(400, "迁移包包含无效文件大小");
    const mode = parseArchiveMode(fields[0], type);
    const owner = /^(\d+)\/(\d+)$/.exec(String(fields[1] || ""));
    const uid = Number(owner?.[1]);
    const gid = Number(owner?.[2]);
    if (!validUserId(uid) || !validUserId(gid)) throw migrationError(400, "迁移包包含无效 UID/GID");
    if (metadata.has(name)) throw migrationError(400, "迁移包包含重复路径");
    metadata.set(name, { type, mode, uid, gid, size });
    if (type === "-") expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw migrationError(413, "迁移包解压后不能超过 20 GB");
  }
  return { entries: names.length, expandedBytes, metadata };
}

function validateEntryName(value) {
  if ([".", "./"].includes(value)) return ".";
  const normalized = String(value || "").replace(/^\.\//, "").replace(/\/$/, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || parts.includes("..") || parts.includes("")) {
    throw migrationError(400, "迁移包包含不安全路径");
  }
  if (![".wfl-workspace", "projects", "conversations"].includes(parts[0])) {
    throw migrationError(400, "迁移包包含未知目录");
  }
  return normalized;
}

async function inspectExtractedTree(root) {
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  const metadata = new Map();
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) throw migrationError(413, "迁移包文件数量过多");
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw migrationError(400, "迁移包不能包含链接或特殊设备");
      const relative = path.relative(root, entryPath).split(path.sep).join("/");
      metadata.set(relative, {
        type: stat.isDirectory() ? "d" : "-",
        mode: permissionMode(stat),
        uid: stat.uid,
        gid: stat.gid,
        size: stat.isFile() ? stat.size : 0,
      });
      if (stat.isDirectory()) pending.push(entryPath);
      else bytes += stat.size;
      if (bytes > MAX_EXPANDED_BYTES) throw migrationError(413, "迁移包解压后不能超过 20 GB");
    }
  }
  return { entries, bytes, metadata };
}

function validateExtractedMetadata(archive, tree, expectedUser) {
  const archived = new Map([...archive.metadata].filter(([name]) => name !== "."));
  if (archive.entries - (archive.metadata.has(".") ? 1 : 0) !== tree.entries || archived.size !== tree.metadata.size) {
    throw migrationError(409, "迁移包解压后的文件数量不一致");
  }
  for (const [name, expected] of archived) {
    const actual = tree.metadata.get(name);
    if (!actual || actual.type !== expected.type || actual.size !== expected.size || actual.mode !== expected.mode) {
      throw migrationError(409, `迁移包路径 ${name} 的类型、大小或模式校验失败`);
    }
    assertEntryMetadata(actual, expectedUser, `迁移包路径 ${name}`);
  }
}

function validateArchiveUser(archive, sourceUser) {
  if (sourceUser == null) return;
  const expected = normalizeUserIdentity(sourceUser, "迁移包源用户");
  for (const [name, entry] of archive.metadata) {
    if (entry.uid !== expected.uid || entry.gid !== expected.gid) {
      throw migrationError(409, `迁移包路径 ${name} 的属主与源用户 UID/GID 不一致`);
    }
  }
}

export async function validateMigratedProjectTree(root, { uid, gid, rootMode = null } = {}) {
  const expectedUser = normalizeUserIdentity({ uid, gid }, "目标用户");
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw migrationError(409, "迁移目标工程不是安全目录");
  assertEntryMetadata(rootStat, expectedUser, "迁移目标工程根目录");
  if (rootMode != null && permissionMode(rootStat) !== rootMode) {
    throw migrationError(409, "迁移目标工程根目录模式与迁移清单不一致");
  }
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw migrationError(409, "迁移目标工程包含链接或特殊设备");
      }
      assertEntryMetadata(stat, expectedUser, `迁移目标路径 ${path.relative(root, entryPath)}`);
      if (stat.isDirectory()) pending.push(entryPath);
    }
  }
  return true;
}

async function validatePackageContents(root, manifest) {
  const projectIds = new Set();
  for (const project of manifest.projects) {
    if (projectIds.has(project.id)) throw migrationError(400, "迁移包包含重复工程编号");
    projectIds.add(project.id);
    const projectPath = path.join(root, "projects", project.storageName);
    const stat = await fs.lstat(projectPath).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw migrationError(400, `工程 ${project.name} 的文件目录缺失`);
    if (project.sourceMode != null && permissionMode(stat) !== project.sourceMode) {
      throw migrationError(409, `工程 ${project.name} 的根目录模式与迁移清单不一致`);
    }
  }
  for (const conversation of manifest.conversations) {
    if (!projectIds.has(conversation.projectId)) throw migrationError(400, "迁移对话没有对应工程");
    const transcriptPath = path.join(root, "conversations", conversation.file);
    const stat = await fs.stat(transcriptPath).catch(() => null);
    if (!stat?.isFile() || stat.size > 128 * 1024 * 1024) throw migrationError(400, "迁移对话文件缺失或过大");
    const value = JSON.parse(await fs.readFile(transcriptPath, "utf8"));
    normalizeThreadImport(value, { preserveName: true, profile: "workspace" });
  }
}

function validateManifest(value, expectedId) {
  if (!value || value.schema !== PACKAGE_SCHEMA || !MIGRATION_ID_PATTERN.test(value.id) || value.id !== expectedId) {
    throw migrationError(400, "工作区迁移清单无效或密钥不匹配");
  }
  if (value.scope !== "owner-workspace" || !Array.isArray(value.projects) || !Array.isArray(value.conversations)) {
    throw migrationError(400, "工作区迁移范围无效");
  }
  if (!value.projects.length || value.projects.length > MAX_PROJECTS || value.conversations.length > MAX_CONVERSATIONS) {
    throw migrationError(400, "工作区迁移数量无效");
  }
  if (value.sourceUser != null) normalizeUserIdentity(value.sourceUser, "迁移包源用户");
  for (const project of value.projects) {
    normalizeProjectName(project?.name);
    if (!/^project-[0-9]{4}$/.test(String(project?.id || ""))) throw migrationError(400, "迁移工程编号无效");
    if (!/^[0-9]{4}-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(project?.storageName || ""))) {
      throw migrationError(400, "迁移工程存储名称无效");
    }
    if (project.sourceMode != null && !validPermissionMode(project.sourceMode)) {
      throw migrationError(400, "迁移工程根目录模式无效");
    }
  }
  for (const conversation of value.conversations) {
    if (!/^thread-[0-9]{6}\.json$/.test(String(conversation?.file || ""))) throw migrationError(400, "迁移对话文件名无效");
    if (typeof conversation?.projectId !== "string") throw migrationError(400, "迁移对话工程编号无效");
  }
}

function parseArchiveMode(value, type) {
  const text = String(value || "").slice(0, 10);
  if (text.length !== 10 || text[0] !== type || /[sStT]/.test(text)) {
    throw migrationError(400, "迁移包包含无效或特权文件模式");
  }
  const groups = [text.slice(1, 4), text.slice(4, 7), text.slice(7, 10)];
  if (groups.some((group) => !/^[r-][w-][x-]$/.test(group))) {
    throw migrationError(400, "迁移包包含无效文件模式");
  }
  return groups.reduce((mode, group) => (
    (mode << 3)
    | (group[0] === "r" ? 4 : 0)
    | (group[1] === "w" ? 2 : 0)
    | (group[2] === "x" ? 1 : 0)
  ), 0);
}

function permissionMode(stat) {
  return Number(stat?.mode) & 0o7777;
}

function validPermissionMode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0o777 && !(value & SPECIAL_MODE_BITS);
}

function validUserId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function currentUserIdentity() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  return validUserId(uid) && validUserId(gid) ? { uid, gid } : null;
}

function normalizeUserIdentity(value, label) {
  const uid = value?.uid;
  const gid = value?.gid;
  if (!validUserId(uid) || !validUserId(gid)) throw migrationError(400, `${label} UID/GID 无效`);
  return { uid, gid };
}

function assertEntryMetadata(stat, expectedUser, label) {
  const mode = permissionMode(stat);
  if (!validPermissionMode(mode)) throw migrationError(400, `${label} 包含无效或特权模式`);
  if (!validUserId(Number(stat?.uid)) || !validUserId(Number(stat?.gid))) {
    throw migrationError(400, `${label} UID/GID 无效`);
  }
  if (expectedUser && (stat.uid !== expectedUser.uid || stat.gid !== expectedUser.gid)) {
    throw migrationError(409, `${label} 属主与迁移用户 UID/GID 不一致`);
  }
}

function parseMigrationKey(value) {
  const lines = String(value || "").trim().split(/\r?\n/);
  if (lines[0] !== "WFL-WORKSPACE-KEY-1") throw migrationError(400, "工作区恢复密钥格式无效");
  const fields = Object.fromEntries(lines.slice(1).map((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ["", ""];
  }).filter(([key]) => key));
  const key = Buffer.from(String(fields.key || ""), "base64url");
  if (!MIGRATION_ID_PATTERN.test(String(fields.migration || "")) || key.length !== 32 || !SHA256_PATTERN.test(String(fields.sha256 || ""))) {
    throw migrationError(400, "工作区恢复密钥内容无效");
  }
  return { migration: fields.migration, key, sha256: fields.sha256 };
}

function normalizeProjectName(value) {
  const name = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw migrationError(400, "迁移工程名称无效");
  return name;
}

function validateIndex(index) {
  if (index?.version !== STORE_VERSION || !Array.isArray(index.exports) || !Array.isArray(index.uploads)) {
    throw new Error("Invalid workspace migration index");
  }
  for (const record of index.exports) {
    if (!MIGRATION_ID_PATTERN.test(record.id) || !SHA256_PATTERN.test(record.sha256) || !Number.isSafeInteger(record.sizeBytes)) {
      throw new Error("Invalid workspace export record");
    }
  }
  for (const record of index.uploads) {
    if (
      !UPLOAD_ID_PATTERN.test(record.id)
      || !Number.isSafeInteger(record.sizeBytes)
      || !Number.isSafeInteger(record.receivedBytes)
      || (record.clientUploadId != null && !CLIENT_UPLOAD_ID_PATTERN.test(record.clientUploadId))
      || (record.fileFingerprint != null && !SHA256_PATTERN.test(record.fileFingerprint))
    ) {
      throw new Error("Invalid workspace upload record");
    }
  }
}

function publicExport(record) {
  return {
    id: record.id,
    appVersion: cleanText(record.appVersion, 32),
    createdAt: record.createdAt,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    projects: record.projects,
    conversations: record.conversations,
  };
}

function publicUpload(record) {
  return {
    id: record.id,
    filename: record.filename,
    sizeBytes: record.sizeBytes,
    receivedBytes: record.receivedBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sha256: record.sha256,
    status: record.status,
    clientUploadId: record.clientUploadId || null,
    fileFingerprint: record.fileFingerprint || null,
    inspection: record.inspection ? structuredClone(record.inspection) : null,
  };
}

function publicInspection(manifest, expandedBytes) {
  return {
    migrationId: manifest.id,
    appVersion: cleanText(manifest.appVersion, 32),
    createdAt: manifest.createdAt,
    sourceInstanceId: cleanText(manifest.sourceInstanceId, 128),
    sourceUser: manifest.sourceUser ? { uid: manifest.sourceUser.uid, gid: manifest.sourceUser.gid } : null,
    projects: manifest.projects.map((project) => ({
      id: project.id,
      name: project.name,
      excluded: project.excluded,
      sourceMode: project.sourceMode ?? null,
    })),
    conversations: manifest.conversations.length,
    expandedBytes,
    options: { includeGit: manifest.options?.includeGit === true, includeEnv: manifest.options?.includeEnv === true },
  };
}

async function digestFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with status ${code}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 64 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with status ${code}`)));
  });
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function createMigrationId(now) {
  return `wm-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeFilename(value) {
  const name = path.basename(String(value || "workspace.wflworkspace")).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
  return name || "workspace.wflworkspace";
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/[\r\n\0]+/g, " ").trim().slice(0, limit) : null;
}

function boundedTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function migrationError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
