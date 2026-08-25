import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SERVER_FILE_LIST_DEFAULT_LIMIT = 500;
export const SERVER_FILE_LIST_MAX_LIMIT = 2_000;
export const SERVER_FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const SERVER_FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;

export function normalizeServerFilePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw fileManagerError(400, "服务器路径不能为空", "SERVER_FILE_PATH_REQUIRED");
  }
  const input = value.trim();
  if (
    input.length > 4_096
    || input.includes("\0")
    || /[\r\n]/.test(input)
    || !path.isAbsolute(input)
  ) {
    throw fileManagerError(400, "服务器路径必须是绝对路径", "SERVER_FILE_PATH_INVALID");
  }
  return path.resolve(input);
}

export function normalizeServerFileName(value) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > 255
  ) {
    throw fileManagerError(400, "文件或文件夹名称无效", "SERVER_FILE_NAME_INVALID");
  }
  return value;
}

export async function inspectServerFilePath(value, { allowMissing = false, allowFinalSymlink = false } = {}) {
  const targetPath = normalizeServerFilePath(value);
  const root = path.parse(targetPath).root;
  const parts = path.relative(root, targetPath).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing && index === parts.length - 1) {
        return {
          path: targetPath,
          parentPath: path.dirname(targetPath),
          exists: false,
          stat: null,
        };
      }
      if (error?.code === "ENOENT") throw fileManagerError(404, "服务器路径不存在", "SERVER_FILE_NOT_FOUND");
      throw error;
    }
    if (stat.isSymbolicLink() && !(allowFinalSymlink && index === parts.length - 1)) {
      throw fileManagerError(403, "服务器文件管理器不会跟随符号链接", "SERVER_FILE_SYMLINK_BLOCKED");
    }
    if (index === parts.length - 1) {
      return {
        path: targetPath,
        parentPath: path.dirname(targetPath),
        exists: true,
        stat,
      };
    }
  }

  const stat = await fs.lstat(targetPath);
  return { path: targetPath, parentPath: path.dirname(targetPath), exists: true, stat };
}

export async function listServerDirectory(value, { offset = 0, limit = SERVER_FILE_LIST_DEFAULT_LIMIT } = {}) {
  const inspected = await inspectServerFilePath(value);
  if (!inspected.stat.isDirectory()) {
    throw fileManagerError(400, "服务器路径不是文件夹", "SERVER_FILE_NOT_DIRECTORY");
  }
  const normalizedOffset = normalizeOffset(offset);
  const normalizedLimit = normalizeLimit(limit);
  const names = await fs.readdir(inspected.path);
  names.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
  const selected = names.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  const entries = [];
  for (const name of selected) {
    const entryPath = path.join(inspected.path, name);
    const stat = await fs.lstat(entryPath);
    entries.push(serverFileEntry(entryPath, stat));
  }
  return {
    path: inspected.path,
    parentPath: inspected.path === path.parse(inspected.path).root ? null : path.dirname(inspected.path),
    offset: normalizedOffset,
    limit: normalizedLimit,
    total: names.length,
    entries,
  };
}

export async function readServerFile(value, { maxBytes = SERVER_FILE_PREVIEW_MAX_BYTES } = {}) {
  const inspected = await inspectServerFilePath(value);
  if (!inspected.stat.isFile()) {
    throw fileManagerError(400, "只能读取普通文件", "SERVER_FILE_NOT_FILE");
  }
  const safeMaxBytes = normalizeByteLimit(maxBytes, SERVER_FILE_PREVIEW_MAX_BYTES);
  const bytesToRead = Math.min(inspected.stat.size, safeMaxBytes);
  const content = await readBytes(inspected.path, bytesToRead);
  const text = decodeText(content);
  const truncated = inspected.stat.size > bytesToRead;
  return {
    ...serverFileEntry(inspected.path, inspected.stat),
    version: truncated ? serverFileMetadataVersion(inspected.stat) : serverFileVersion(content),
    content: text,
    binary: text === null,
    truncated,
    omittedBytes: Math.max(0, inspected.stat.size - bytesToRead),
    editable: text !== null && !truncated && inspected.stat.size <= SERVER_FILE_EDIT_MAX_BYTES,
  };
}

export async function writeServerFile(value, content, expectedVersion) {
  const inspected = await inspectServerFilePath(value);
  if (!inspected.stat.isFile()) {
    throw fileManagerError(400, "只能保存普通文件", "SERVER_FILE_NOT_FILE");
  }
  if (inspected.stat.size > SERVER_FILE_EDIT_MAX_BYTES) {
    throw fileManagerError(413, "文件超过可编辑大小", "SERVER_FILE_TOO_LARGE_TO_EDIT");
  }
  if (typeof content !== "string") {
    throw fileManagerError(400, "文件内容必须是文本", "SERVER_FILE_CONTENT_INVALID");
  }
  const current = await fs.readFile(inspected.path);
  if (serverFileVersion(current) !== String(expectedVersion || "")) {
    throw fileManagerError(409, "文件已被其他任务修改，请重新加载后再保存", "SERVER_FILE_VERSION_CONFLICT");
  }
  const updated = Buffer.from(content, "utf8");
  if (updated.includes(0)) {
    throw fileManagerError(415, "文本文件不能包含 NUL 字节", "SERVER_FILE_BINARY_CONTENT");
  }
  if (updated.length > SERVER_FILE_EDIT_MAX_BYTES) {
    throw fileManagerError(413, "文件超过可编辑大小", "SERVER_FILE_TOO_LARGE_TO_EDIT");
  }
  await writeAtomic(inspected.path, updated, inspected.stat);
  const stat = await fs.lstat(inspected.path);
  return {
    ...serverFileEntry(inspected.path, stat),
    version: serverFileVersion(updated),
    content,
    binary: false,
    truncated: false,
    omittedBytes: 0,
    editable: true,
  };
}

export async function createServerFile(value, nameValue, type) {
  const parent = await inspectServerFilePath(value);
  if (!parent.stat.isDirectory()) {
    throw fileManagerError(400, "目标位置不是文件夹", "SERVER_FILE_NOT_DIRECTORY");
  }
  const name = normalizeServerFileName(nameValue);
  if (!['file', 'directory'].includes(type)) {
    throw fileManagerError(400, "新建类型无效", "SERVER_FILE_CREATE_TYPE_INVALID");
  }
  const targetPath = path.join(parent.path, name);
  const destination = await inspectServerFilePath(targetPath, { allowMissing: true });
  if (destination.exists) {
    throw fileManagerError(409, "同名文件或文件夹已存在", "SERVER_FILE_ALREADY_EXISTS");
  }
  if (type === "directory") await fs.mkdir(targetPath, { mode: 0o755 });
  else await fs.writeFile(targetPath, Buffer.alloc(0), { flag: "wx", mode: 0o644 });
  return serverFileEntry(targetPath, await fs.lstat(targetPath));
}

export async function uploadServerFile(value, nameValue, content) {
  const parent = await inspectServerFilePath(value);
  if (!parent.stat.isDirectory()) {
    throw fileManagerError(400, "目标位置不是文件夹", "SERVER_FILE_NOT_DIRECTORY");
  }
  if (!Buffer.isBuffer(content)) {
    throw fileManagerError(400, "上传内容无效", "SERVER_FILE_UPLOAD_INVALID");
  }
  const name = normalizeServerFileName(nameValue);
  const targetPath = path.join(parent.path, name);
  const destination = await inspectServerFilePath(targetPath, { allowMissing: true });
  if (destination.exists) {
    throw fileManagerError(409, "同名文件或文件夹已存在", "SERVER_FILE_ALREADY_EXISTS");
  }
  await fs.writeFile(targetPath, content, { flag: "wx", mode: 0o644 });
  return serverFileEntry(targetPath, await fs.lstat(targetPath));
}

export async function renameServerFile(value, nameValue) {
  const source = await inspectServerFilePath(value, { allowFinalSymlink: true });
  if (path.parse(source.path).root === source.path) {
    throw fileManagerError(400, "不能重命名文件系统根目录", "SERVER_FILE_ROOT_PROTECTED");
  }
  const name = normalizeServerFileName(nameValue);
  const targetPath = path.join(source.parentPath, name);
  if (targetPath === source.path) {
    throw fileManagerError(409, "新旧名称相同", "SERVER_FILE_NAME_UNCHANGED");
  }
  const destination = await inspectServerFilePath(targetPath, { allowMissing: true });
  if (destination.exists) {
    throw fileManagerError(409, "目标位置已有同名文件或文件夹", "SERVER_FILE_ALREADY_EXISTS");
  }
  await fs.rename(source.path, targetPath);
  return serverFileEntry(targetPath, await fs.lstat(targetPath));
}

export async function deleteServerFile(value, { recursive = false, confirmPath = "" } = {}) {
  const inspected = await inspectServerFilePath(value, { allowFinalSymlink: true });
  if (path.parse(inspected.path).root === inspected.path) {
    throw fileManagerError(400, "不能删除文件系统根目录", "SERVER_FILE_ROOT_PROTECTED");
  }
  if (normalizeServerFilePath(confirmPath) !== inspected.path) {
    throw fileManagerError(400, "删除操作需要确认完整路径", "SERVER_FILE_DELETE_CONFIRMATION_REQUIRED");
  }
  await fs.rm(inspected.path, { recursive: Boolean(recursive), force: false });
  return { path: inspected.path, deleted: true };
}

export function serverFileEntry(filePath, stat) {
  const type = stat.isDirectory()
    ? "directory"
    : stat.isFile()
      ? "file"
      : stat.isSymbolicLink()
        ? "symlink"
        : "other";
  return {
    name: path.basename(filePath) || path.parse(filePath).root,
    path: filePath,
    type,
    size: type === "file" ? stat.size : type === "symlink" ? stat.size : null,
    modifiedAt: stat.mtimeMs,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

export function serverFileVersion(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function serverFileMetadataVersion(stat) {
  return serverFileVersion([
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
  ].join("\0"));
}

async function readBytes(filePath, length) {
  if (length === 0) return Buffer.alloc(0);
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(length);
  try {
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeText(content) {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

async function writeAtomic(targetPath, content, stat) {
  const temporary = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.wfl-save-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: stat.mode & 0o777 });
    await fs.chmod(temporary, stat.mode & 0o777);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const currentGid = typeof process.getgid === "function" ? process.getgid() : null;
    if (currentUid === 0 && currentGid === 0 && (stat.uid !== currentUid || stat.gid !== currentGid)) {
      await fs.chown(temporary, stat.uid, stat.gid);
    }
    await fs.rename(temporary, targetPath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeOffset(value) {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw fileManagerError(400, "目录分页位置无效", "SERVER_FILE_OFFSET_INVALID");
  }
  return offset;
}

function normalizeLimit(value) {
  const limit = value == null || value === "" ? SERVER_FILE_LIST_DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SERVER_FILE_LIST_MAX_LIMIT) {
    throw fileManagerError(400, `目录分页大小必须为 1-${SERVER_FILE_LIST_MAX_LIMIT}`, "SERVER_FILE_LIMIT_INVALID");
  }
  return limit;
}

function normalizeByteLimit(value, fallback) {
  const limit = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) {
    throw fileManagerError(400, "文件读取大小无效", "SERVER_FILE_BYTE_LIMIT_INVALID");
  }
  return limit;
}

function fileManagerError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
