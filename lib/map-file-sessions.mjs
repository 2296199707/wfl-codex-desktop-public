import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_SESSIONS_PER_BROWSER = 8;
const DEFAULT_MAX_GRANT_RESOURCES = 4096;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const PROJECT_RESOURCE_EXTENSIONS = new Set([".tx", ".tmj", ".tsj", ".world", ".txt"]);
const DEFAULT_AUTO_SAVE_INTERVAL_MS = 120_000;
const HASH_READ_BYTES = 1024 * 1024;

export class MapFileSessionError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "MapFileSessionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class MapFileSessionStore {
  constructor(options = {}) {
    this.documentKind = normalizeDocumentKind(options.documentKind);
    this.fileExtensions = normalizeFileExtensions(options.fileExtensions, this.documentKind);
    this.chunkBytes = positiveInteger(options.chunkBytes, DEFAULT_CHUNK_BYTES, "chunkBytes");
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
    this.maxSessionsPerBrowser = positiveInteger(
      options.maxSessionsPerBrowser,
      DEFAULT_MAX_SESSIONS_PER_BROWSER,
      "maxSessionsPerBrowser",
    );
    this.maxGrantResources = positiveInteger(
      options.maxGrantResources,
      DEFAULT_MAX_GRANT_RESOURCES,
      "maxGrantResources",
    );
    this.maxProjectBytes = positiveInteger(
      options.maxProjectBytes,
      DEFAULT_MAX_PROJECT_BYTES,
      "maxProjectBytes",
    );
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.sessions = new Map();
    this.pendingOpenCount = 0;
    this.pendingBrowserOpens = new Map();
  }

  async open(input) {
    this.pruneExpired();
    const identity = normalizeIdentity(input?.identity);
    const targetPath = normalizeAbsoluteDocumentPath(input?.targetPath, this.fileExtensions, this.documentKind);
    const projectPath = normalizeAbsoluteProjectPath(input?.projectPath, targetPath);
    const projectFilePath = normalizeAbsoluteProjectFilePath(input?.projectFilePath, projectPath);
    const projectResourceRoots = normalizeProjectResourceRoots(input?.projectResourceRoots, projectPath);
    const relativePath = path.relative(projectPath, targetPath).split(path.sep).join("/");
    const config = normalizeSessionConfig(input?.config, {
      chunkBytes: this.chunkBytes,
      maxBytes: DEFAULT_MAX_BYTES,
      autoSaveIntervalMs: DEFAULT_AUTO_SAVE_INTERVAL_MS,
    });
    const releaseCapacity = this.reserveCapacity(identity);
    let session = null;
    try {
      const inspected = await inspectMapFile(targetPath, { maxBytes: config.maxBytes });
      const projectSource = projectFilePath
        ? await inspectProjectSource(projectFilePath, projectPath, this.maxProjectBytes)
        : null;
      const createdAt = this.now();
      session = {
        id: crypto.randomBytes(24).toString("base64url"),
        identity,
        projectPath,
        projectFilePath,
        projectResourceRoots,
        projectFile: projectFilePath
          ? path.relative(projectPath, projectFilePath).split(path.sep).join("/")
          : null,
        projectSourceVersion: projectSource?.version || null,
        targetPath,
        relativePath,
        documentKind: this.documentKind,
        writable: input?.writable === true,
        version: inspected.version,
        fingerprint: inspected.fingerprint,
        size: inspected.fingerprint.size,
        modifiedAt: inspected.fingerprint.mtimeMs,
        createdAt,
        expiresAt: createdAt + this.ttlMs,
        config: Object.freeze({ ...config, ttlMs: this.ttlMs }),
        resourcePaths: new Set(),
      };
      this.sessions.set(session.id, session);
      const firstChunk = await readSessionChunk(session, 0);
      return publicSession(session, firstChunk);
    } catch (error) {
      if (session) this.sessions.delete(session.id);
      throw error;
    } finally {
      releaseCapacity();
    }
  }

  async read(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    if (String(input?.version || "") !== session.version) {
      throw sessionError(409, "map-version-conflict", "地图内容版本不匹配，请重新打开地图");
    }
    const offset = Number(input?.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= session.size) {
      throw sessionError(400, "invalid-map-offset", "地图分段位置无效");
    }
    return {
      sessionId: session.id,
      version: session.version,
      size: session.size,
      ...(await readSessionChunk(session, offset)),
    };
  }

  close(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    this.sessions.delete(session.id);
    return true;
  }

  closeForBrowserSession(input) {
    this.pruneExpired();
    const identity = normalizeBrowserIdentity(input);
    let closed = 0;
    for (const [id, session] of this.sessions) {
      if (!sameBrowserIdentity(session.identity, identity)) continue;
      this.sessions.delete(id);
      closed += 1;
    }
    return Object.freeze({ closed });
  }

  closeForUser(input = {}) {
    this.pruneExpired();
    const userId = normalizeUserId(input.userId);
    let closed = 0;
    for (const [id, session] of this.sessions) {
      if (session.identity.userId !== userId) continue;
      this.sessions.delete(id);
      closed += 1;
    }
    return Object.freeze({ closed });
  }

  snapshot(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    return publicSession(session, null);
  }

  context(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    return Object.freeze({
      projectPath: session.projectPath,
      targetPath: session.targetPath,
      projectFile: session.projectFile,
      projectFilePath: session.projectFilePath,
      projectResourceRoots: session.projectResourceRoots,
      relativePath: session.relativePath,
      documentKind: session.documentKind,
      version: session.version,
      writable: session.writable,
    });
  }

  async readProjectSource(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    if (!session.projectFilePath) {
      return Object.freeze({
        relativePath: null,
        size: 0,
        modifiedAt: null,
        version: null,
        content: null,
      });
    }
    const source = await readStableProjectSource(
      session.projectFilePath,
      session.projectPath,
      this.maxProjectBytes,
    );
    return Object.freeze({
      relativePath: session.projectFile,
      size: source.stat.size,
      modifiedAt: source.stat.mtimeMs,
      version: source.version,
      content: source.content,
    });
  }

  async readProjectResource(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    if (!session.projectFilePath) {
      throw sessionError(404, "map-project-resource-not-configured", "当前地图没有绑定 Tiled 项目资源目录");
    }
    const resourcePath = normalizeSessionResourcePath(session.projectPath, input?.resourcePath);
    if (!session.projectResourceRoots.some((root) => isWithinSessionResourceRoot(root, resourcePath))) {
      throw sessionError(403, "map-project-resource-outside-folders", "资源不在 Tiled 项目的 folders 范围内");
    }
    const extension = path.posix.extname(resourcePath).toLowerCase();
    if (!PROJECT_RESOURCE_EXTENSIONS.has(extension)) {
      throw sessionError(415, "map-project-resource-unsupported", "当前工程资源类型不支持在地图窗口读取");
    }
    const targetPath = path.resolve(session.projectPath, resourcePath);
    const source = await readStableProjectSource(targetPath, session.projectPath, this.maxProjectBytes);
    return Object.freeze({
      relativePath: resourcePath,
      size: source.stat.size,
      modifiedAt: source.stat.mtimeMs,
      version: source.version,
      content: source.content,
    });
  }

  setResources(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    if (String(input?.version || "") !== session.version) {
      throw sessionError(409, "map-version-conflict", "地图资源清单版本与读取会话不匹配");
    }
    session.resourcePaths = new Set(
      (Array.isArray(input?.resourcePaths) ? input.resourcePaths : [])
        .map((resourcePath) => normalizeSessionResourcePath(session.projectPath, resourcePath)),
    );
    return session.resourcePaths.size;
  }

  grantResources(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    if (!session.writable) {
      throw sessionError(403, "map-session-read-only", "只读地图会话不能导入新的工程资源");
    }
    if (String(input?.version || "") !== session.version) {
      throw sessionError(409, "map-version-conflict", "地图资源授权版本与读取会话不匹配");
    }
    const resourcePaths = Array.isArray(input?.resourcePaths) ? input.resourcePaths : [];
    if (!resourcePaths.length || resourcePaths.length > this.maxGrantResources) {
      throw sessionError(
        400,
        "invalid-map-resource-grant",
        `地图资源授权清单无效，最多 ${this.maxGrantResources} 项`,
      );
    }
    const granted = resourcePaths.map((resourcePath) => (
      normalizeSessionResourcePath(session.projectPath, resourcePath)
    ));
    for (const resourcePath of granted) session.resourcePaths.add(resourcePath);
    return Object.freeze({
      granted: Object.freeze([...new Set(granted)]),
      resourceCount: session.resourcePaths.size,
    });
  }

  authorizeResource(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    const resourcePath = normalizeSessionResourcePath(session.projectPath, input?.resourcePath);
    if (!session.resourcePaths.has(resourcePath)) {
      throw sessionError(403, "map-resource-not-referenced", "当前地图没有引用这个工程资源");
    }
    return resourcePath;
  }

  async refresh(input) {
    this.pruneExpired();
    const session = this.requireSession(input?.sessionId, input?.identity);
    const inspected = await inspectMapFile(session.targetPath, { maxBytes: session.config.maxBytes });
    session.version = inspected.version;
    session.fingerprint = inspected.fingerprint;
    session.size = inspected.fingerprint.size;
    session.modifiedAt = inspected.fingerprint.mtimeMs;
    session.resourcePaths = new Set();
    return publicSession(session, null);
  }

  clear() {
    this.sessions.clear();
  }

  pruneExpired() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  requireSession(sessionId, rawIdentity) {
    const id = String(sessionId || "");
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      if (session) this.sessions.delete(id);
      throw sessionError(404, "map-session-not-found", "地图会话不存在或已过期");
    }
    const identity = normalizeIdentity(rawIdentity);
    if (!sameIdentity(session.identity, identity)) {
      throw sessionError(404, "map-session-not-found", "地图会话不存在或已过期");
    }
    return session;
  }

  reserveCapacity(identity) {
    if (this.sessions.size + this.pendingOpenCount >= this.maxSessions) {
      throw sessionError(429, "map-session-capacity", "地图会话已达到管理员设置的并发上限");
    }
    let browserSessions = 0;
    for (const session of this.sessions.values()) {
      if (
        session.identity.userId === identity.userId
        && session.identity.browserSessionId === identity.browserSessionId
      ) browserSessions += 1;
    }
    const browserKey = `${identity.userId}\0${identity.browserSessionId}`;
    const pendingBrowser = this.pendingBrowserOpens.get(browserKey) || 0;
    if (browserSessions + pendingBrowser >= this.maxSessionsPerBrowser) {
      throw sessionError(429, "map-browser-session-capacity", "当前登录已达到管理员设置的地图窗口上限");
    }
    this.pendingOpenCount += 1;
    this.pendingBrowserOpens.set(browserKey, pendingBrowser + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingOpenCount -= 1;
      const count = (this.pendingBrowserOpens.get(browserKey) || 1) - 1;
      if (count > 0) this.pendingBrowserOpens.set(browserKey, count);
      else this.pendingBrowserOpens.delete(browserKey);
    };
  }
}

export function normalizeMapEditorInstanceId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(id)) {
    throw sessionError(400, "invalid-map-editor-instance", "地图编辑器窗口标识无效");
  }
  return id;
}

export async function inspectMapFile(targetPath, options = {}) {
  throwIfAborted(options.signal);
  const handle = await fs.open(targetPath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw sessionError(400, "invalid-map-file", "地图路径不是文件");
    if (options.maxBytes !== undefined && before.size > options.maxBytes) {
      throw sessionError(413, "map-file-size-limit", "地图超过管理员设置的读取上限");
    }
    const fingerprint = fileFingerprint(before);
    const hash = crypto.createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.allocUnsafe(Math.min(HASH_READ_BYTES, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      throwIfAborted(options.signal);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw sessionError(409, "map-file-changed", "地图在打开过程中发生变化，请重试");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        throw sessionError(415, "invalid-map-utf8", "地图文件不是有效的 UTF-8 文本");
      }
      offset += bytesRead;
    }
    throwIfAborted(options.signal);
    try {
      decoder.decode();
    } catch {
      throw sessionError(415, "invalid-map-utf8", "地图文件不是有效的 UTF-8 文本");
    }
    const after = await handle.stat();
    const pathStat = await fs.stat(targetPath);
    if (!sameFingerprint(fingerprint, fileFingerprint(after)) || !sameFingerprint(fingerprint, fileFingerprint(pathStat))) {
      throw sessionError(409, "map-file-changed", "地图在打开过程中发生变化，请重试");
    }
    return { fingerprint, version: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readSessionChunk(session, offset) {
  const before = fileFingerprint(await fs.stat(session.targetPath));
  if (!sameFingerprint(session.fingerprint, before)) {
    throw sessionError(409, "map-file-changed", "地图已被其他窗口或任务修改，请重新打开");
  }
  const length = Math.min(session.config.chunkBytes, session.size - offset);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.open(session.targetPath, "r");
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, length, offset));
  } finally {
    await handle.close();
  }
  const after = fileFingerprint(await fs.stat(session.targetPath));
  if (!sameFingerprint(session.fingerprint, after) || bytesRead !== length) {
    throw sessionError(409, "map-file-changed", "地图在读取过程中发生变化，请重新打开");
  }
  const decoded = decodeUtf8Chunk(buffer.subarray(0, bytesRead), offset + bytesRead >= session.size);
  const nextOffset = offset + decoded.bytes;
  return {
    content: decoded.content,
    offset,
    nextOffset,
    eof: nextOffset >= session.size,
  };
}

function decodeUtf8Chunk(buffer, atEnd) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const end = buffer.length - trim;
    if (!end && !atEnd) continue;
    try {
      return { content: decoder.decode(buffer.subarray(0, end)), bytes: end };
    } catch {
      if (atEnd) break;
    }
  }
  throw sessionError(415, "invalid-map-utf8", "地图文件不是有效的 UTF-8 文本");
}

function normalizeSessionConfig(value, fallback) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    chunkBytes: positiveInteger(input.chunkBytes, fallback.chunkBytes, "chunkBytes"),
    maxBytes: positiveInteger(input.maxBytes, fallback.maxBytes, "maxBytes"),
    autoSaveIntervalMs: autoSaveInterval(input.autoSaveIntervalMs, fallback.autoSaveIntervalMs),
  };
}

function autoSaveInterval(value, fallback) {
  if (value === undefined) return fallback;
  if (value === 0) return 0;
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 3_600_000) {
    throw new TypeError("autoSaveIntervalMs must be zero or a bounded positive integer");
  }
  return value;
}

function publicSession(session, firstChunk) {
  return {
    id: session.id,
    documentKind: session.documentKind,
    relativePath: session.relativePath,
    size: session.size,
    modifiedAt: session.modifiedAt,
    version: session.version,
    writable: session.writable,
    projectFile: session.projectFile,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    config: session.config,
    ...(firstChunk ? { firstChunk } : {}),
  };
}

function normalizeAbsoluteProjectFilePath(value, projectPath) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\0")
    || path.extname(value).toLowerCase() !== ".tiled-project"
  ) {
    throw sessionError(400, "invalid-map-project-file", "Tiled 项目文件路径无效");
  }
  const resolved = path.resolve(value);
  const relative = path.relative(projectPath, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sessionError(403, "map-project-file-outside-project", "Tiled 项目文件必须位于地图工程内");
  }
  return resolved;
}

function normalizeProjectResourceRoots(value, projectPath) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError("projectResourceRoots must be an array");
  return Object.freeze([...new Set(value.map((entry) => {
    if (entry === "") return "";
    if (typeof entry !== "string" || entry.includes("\\") || entry.includes("\0")) {
      throw sessionError(400, "invalid-map-project-resource-root", "Tiled folders 路径无效");
    }
    const resolved = path.resolve(projectPath, entry);
    const relative = path.relative(projectPath, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw sessionError(403, "map-project-resource-root-outside-project", "Tiled folders 不能越过工程目录");
    }
    return relative.split(path.sep).join("/");
  }))]);
}

async function inspectProjectSource(projectFilePath, projectPath, maxBytes) {
  const source = await readStableProjectSource(projectFilePath, projectPath, maxBytes);
  return { version: source.version };
}

async function readStableProjectSource(projectFilePath, projectPath, maxBytes) {
  const relative = path.relative(projectPath, projectFilePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sessionError(403, "map-project-file-outside-project", "Tiled 项目文件必须位于地图工程内");
  }
  let handle;
  try {
    const projectFileRealPath = await fs.realpath(projectFilePath);
    if (projectFileRealPath !== projectFilePath) {
      throw sessionError(403, "map-project-file-symlink", "Tiled 项目资源不能通过符号链接读取");
    }
    handle = await fs.open(projectFilePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile()) throw sessionError(400, "invalid-map-project-file", "Tiled 项目路径不是文件");
    if (before.size > maxBytes) {
      throw sessionError(413, "map-project-file-size-limit", "Tiled 项目文件超过地图会话读取上限");
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (!sameFingerprint(before, after) || buffer.length !== before.size) {
      throw sessionError(409, "map-project-file-changed", "Tiled 项目文件在读取过程中发生变化，请重试");
    }
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      throw sessionError(415, "invalid-map-project-utf8", "Tiled 项目文件不是有效的 UTF-8", error);
    }
    return {
      buffer,
      content,
      stat: before,
      version: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    if (error instanceof MapFileSessionError) throw error;
    if (error?.code === "ELOOP") {
      throw sessionError(403, "map-project-file-symlink", "Tiled 项目文件不能是符号链接");
    }
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw sessionError(404, "map-project-file-not-found", "绑定的 Tiled 项目文件不存在");
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw sessionError(403, "map-project-file-forbidden", "没有权限读取绑定的 Tiled 项目文件");
    }
    throw sessionError(500, "map-project-file-read-failed", "无法读取绑定的 Tiled 项目文件");
  } finally {
    await handle?.close();
  }
}

function isWithinSessionResourceRoot(root, candidate) {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  const editorInstanceId = normalizeMapEditorInstanceId(value?.editorInstanceId);
  if (!userId || userId.length > 256 || !browserSessionId || browserSessionId.length > 512) {
    throw sessionError(400, "invalid-map-session-identity", "地图会话身份无效");
  }
  return Object.freeze({ userId, browserSessionId, editorInstanceId });
}

function normalizeBrowserIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || userId.length > 256 || !browserSessionId || browserSessionId.length > 512) {
    throw sessionError(400, "invalid-map-session-identity", "地图会话身份无效");
  }
  return Object.freeze({ userId, browserSessionId });
}

function normalizeUserId(value) {
  const userId = String(value || "");
  if (!userId || userId.length > 256) {
    throw sessionError(400, "invalid-map-session-identity", "地图会话身份无效");
  }
  return userId;
}

function sameBrowserIdentity(left, right) {
  return left.userId === right.userId && left.browserSessionId === right.browserSessionId;
}

function sameIdentity(left, right) {
  return left.userId === right.userId
    && left.browserSessionId === right.browserSessionId
    && left.editorInstanceId === right.editorInstanceId;
}

function normalizeAbsoluteDocumentPath(value, fileExtensions, documentKind) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || !fileExtensions.has(path.extname(value).toLowerCase())
  ) {
    const extensions = [...fileExtensions].join("、");
    const label = documentKind === "world" ? "World" : documentKind === "tileset" ? "瓦片集" : "地图";
    throw sessionError(400, "invalid-map-path", `${label}文件必须是工程内的 ${extensions} 文件`);
  }
  return path.resolve(value);
}

function normalizeDocumentKind(value) {
  const kind = value === undefined ? "map" : String(value);
  if (!new Set(["map", "world", "tileset"]).has(kind)) {
    throw new TypeError("documentKind must be map, world, or tileset");
  }
  return kind;
}

function normalizeFileExtensions(value, documentKind) {
  const source = value === undefined
    ? [documentKind === "world" ? ".world" : documentKind === "tileset" ? ".tsj" : ".tmj"]
    : value;
  if (!Array.isArray(source) && !(source instanceof Set)) {
    throw new TypeError("fileExtensions must be an array or Set");
  }
  const extensions = new Set();
  for (const entry of source) {
    const extension = String(entry || "").toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._-]{0,15}$/u.test(extension)) {
      throw new TypeError("fileExtensions contains an invalid extension");
    }
    extensions.add(extension);
  }
  if (!extensions.size) throw new TypeError("fileExtensions cannot be empty");
  return extensions;
}

function normalizeAbsoluteProjectPath(value, targetPath) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw sessionError(400, "invalid-map-project", "地图工程路径无效");
  }
  const projectPath = path.resolve(value);
  const relative = path.relative(projectPath, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sessionError(400, "invalid-map-path", "地图文件必须位于工程目录内");
  }
  return projectPath;
}

function normalizeSessionResourcePath(projectPath, value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw sessionError(400, "invalid-map-resource-path", "地图资源路径无效");
  }
  const targetPath = path.resolve(projectPath, value);
  const relative = path.relative(projectPath, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sessionError(400, "invalid-map-resource-path", "地图资源路径必须位于工程内");
  }
  return relative.split(path.sep).join("/");
}

function fileFingerprint(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFingerprint(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Map file inspection was aborted");
}

function sessionError(statusCode, code, message) {
  return new MapFileSessionError(statusCode, code, message);
}
