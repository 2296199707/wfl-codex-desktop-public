import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_SESSIONS_PER_BROWSER = 4;
const DEFAULT_MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RESOURCE_VERSION_BYTES = 4 * 1024 * 1024 * 1024;
const RESOURCE_VERSION_HASH_CHUNK_BYTES = 256 * 1024;
const PROJECT_RESOURCE_EXTENSIONS = new Set([".tx", ".tmj", ".tsj", ".world", ".txt"]);

export class MapProjectSessionError extends Error {
  constructor(statusCode, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "MapProjectSessionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class MapProjectSessionStore {
  constructor(options = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
    this.maxSessionsPerBrowser = positiveInteger(
      options.maxSessionsPerBrowser,
      DEFAULT_MAX_SESSIONS_PER_BROWSER,
      "maxSessionsPerBrowser",
    );
    this.maxProjectBytes = positiveInteger(
      options.maxProjectBytes,
      DEFAULT_MAX_PROJECT_BYTES,
      "maxProjectBytes",
    );
    this.maxResourceVersionBytes = positiveInteger(
      options.maxResourceVersionBytes,
      DEFAULT_MAX_RESOURCE_VERSION_BYTES,
      "maxResourceVersionBytes",
    );
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.sessions = new Map();
    this.pendingOpenCount = 0;
    this.pendingBrowserOpens = new Map();
  }

  async open(input = {}) {
    this.pruneExpired();
    const identity = normalizeIdentity(input.identity);
    const projectPath = await inspectProjectRoot(input.projectPath);
    const projectFilePath = normalizeProjectFilePath(projectPath, input.projectFilePath);
    const releaseCapacity = this.reserveCapacity(identity);
    let session = null;
    try {
      const inspected = projectFilePath
        ? await inspectTiledProject(projectPath, projectFilePath, this.maxProjectBytes)
        : temporaryProject(projectPath);
      const createdAt = this.now();
      session = {
        id: crypto.randomBytes(24).toString("base64url"),
        identity,
        projectPath,
        projectName: path.basename(projectPath),
        projectFilePath,
        projectFile: inspected.projectFile,
        writable: input.writable === true,
        resourceRoots: inspected.resourceRoots,
        manifest: inspected.manifest,
        warnings: inspected.warnings,
        createdAt,
        expiresAt: createdAt + this.ttlMs,
      };
      this.sessions.set(session.id, session);
      return publicSession(session);
    } catch (error) {
      if (session) this.sessions.delete(session.id);
      throw error;
    } finally {
      releaseCapacity();
    }
  }

  snapshot(input = {}) {
    this.pruneExpired();
    return publicSession(this.requireSession(input.sessionId, input.identity));
  }

  context(input = {}) {
    this.pruneExpired();
    const session = this.requireSession(input.sessionId, input.identity);
    return Object.freeze({
      projectPath: session.projectPath,
      projectFile: session.projectFile,
      projectFilePath: session.projectFilePath,
      resourceRoots: session.resourceRoots,
      writable: session.writable,
    });
  }

  async readProjectSource(input = {}) {
    this.pruneExpired();
    const session = this.requireSession(input.sessionId, input.identity);
    if (!session.projectFilePath || !session.projectFile) {
      throw projectError(404, "map-project-file-not-configured", "当前地图项目没有绑定 .tiled-project 文件");
    }
    const opened = await readStableFile(session.projectFilePath, this.maxProjectBytes);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer);
    } catch (error) {
      throw projectError(415, "invalid-tiled-project-json", "Tiled 项目文件不是有效的 UTF-8", error);
    }
    return Object.freeze({
      relativePath: session.projectFile,
      size: opened.stat.size,
      modifiedAt: opened.stat.mtimeMs,
      version: crypto.createHash("sha256").update(opened.buffer).digest("hex"),
      content,
    });
  }

  async readResourceSource(input = {}) {
    this.pruneExpired();
    const session = this.requireSession(input.sessionId, input.identity);
    const relativePath = this.authorizeRelativePath({
      sessionId: input.sessionId,
      identity: input.identity,
      relativePath: input.relativePath,
    });
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (!PROJECT_RESOURCE_EXTENSIONS.has(extension) && !isCharacterAnimationPath(relativePath)) {
      throw projectError(415, "map-project-resource-source-unsupported", "当前资源不支持以文本方式读取");
    }
    const targetPath = await safeProjectResourcePath(session.projectPath, relativePath);
    const opened = await readStableFile(targetPath, this.maxProjectBytes);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer);
    } catch (error) {
      throw projectError(415, "map-project-resource-utf8", "地图项目资源不是有效的 UTF-8 文本", error);
    }
    return Object.freeze({
      relativePath,
      size: opened.stat.size,
      modifiedAt: opened.stat.mtimeMs,
      version: crypto.createHash("sha256").update(opened.buffer).digest("hex"),
      content,
    });
  }

  async readResourceVersion(input = {}) {
    this.pruneExpired();
    const session = this.requireSession(input.sessionId, input.identity);
    const relativePath = this.authorizeRelativePath({
      sessionId: input.sessionId,
      identity: input.identity,
      relativePath: input.relativePath,
      kind: input.kind,
    });
    const targetPath = await safeProjectResourcePath(session.projectPath, relativePath);
    const opened = await hashStableFile(targetPath, this.maxResourceVersionBytes);
    return Object.freeze({
      relativePath,
      size: opened.stat.size,
      modifiedAt: opened.stat.mtimeMs,
      version: opened.version,
    });
  }

  authorizeRelativePath(input = {}) {
    this.pruneExpired();
    const session = this.requireSession(input.sessionId, input.identity);
    const relativePath = normalizeRelativePath(input.relativePath);
    if (!session.resourceRoots.some((root) => isWithinRelativeRoot(root, relativePath))) {
      throw projectError(403, "map-project-resource-outside-folders", "资源不在 Tiled 项目的 folders 范围内");
    }
    if (input.kind === "map" && path.posix.extname(relativePath).toLowerCase() !== ".tmj") {
      throw projectError(415, "map-project-resource-kind-mismatch", "所选资源不是 .tmj 地图");
    }
    if (input.kind === "world" && path.posix.extname(relativePath).toLowerCase() !== ".world") {
      throw projectError(415, "map-project-resource-kind-mismatch", "所选资源不是 .world 文档");
    }
    if (input.kind === "tileset" && path.posix.extname(relativePath).toLowerCase() !== ".tsj") {
      throw projectError(415, "map-project-resource-kind-mismatch", "所选资源不是 .tsj 外部瓦片集");
    }
    if (input.kind === "character" && !isCharacterAnimationPath(relativePath)) {
      throw projectError(415, "map-project-resource-kind-mismatch", "所选资源不是 .character.json 角色动画清单");
    }
    if (input.kind === "image" && !new Set([".png", ".jpg", ".jpeg", ".webp"]).has(path.posix.extname(relativePath).toLowerCase())) {
      throw projectError(415, "map-project-resource-kind-mismatch", "所选资源不是受支持的图片");
    }
    return relativePath;
  }

  close(input = {}) {
    this.pruneExpired();
    const session = this.requireSession(input.sessionId, input.identity);
    this.sessions.delete(session.id);
    return true;
  }

  closeForBrowserSession(input = {}) {
    this.pruneExpired();
    const identity = normalizeIdentity(input);
    let closed = 0;
    for (const [id, session] of this.sessions) {
      if (!sameIdentity(session.identity, identity)) continue;
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
      throw projectError(404, "map-project-session-not-found", "地图项目会话不存在或已过期");
    }
    const identity = normalizeIdentity(rawIdentity);
    if (!sameIdentity(session.identity, identity)) {
      throw projectError(404, "map-project-session-not-found", "地图项目会话不存在或已过期");
    }
    return session;
  }

  reserveCapacity(identity) {
    if (this.sessions.size + this.pendingOpenCount >= this.maxSessions) {
      throw projectError(429, "map-project-session-capacity", "地图项目会话已达到管理员设置的上限");
    }
    const browserKey = identityKey(identity);
    let browserSessions = 0;
    for (const session of this.sessions.values()) {
      if (identityKey(session.identity) === browserKey) browserSessions += 1;
    }
    const pendingBrowser = this.pendingBrowserOpens.get(browserKey) || 0;
    if (browserSessions + pendingBrowser >= this.maxSessionsPerBrowser) {
      throw projectError(
        429,
        "map-project-browser-session-capacity",
        "当前登录已达到管理员设置的地图项目会话上限",
      );
    }
    this.pendingOpenCount += 1;
    this.pendingBrowserOpens.set(browserKey, pendingBrowser + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingOpenCount -= 1;
      const remaining = (this.pendingBrowserOpens.get(browserKey) || 1) - 1;
      if (remaining > 0) this.pendingBrowserOpens.set(browserKey, remaining);
      else this.pendingBrowserOpens.delete(browserKey);
    };
  }
}

async function inspectProjectRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw projectError(400, "invalid-map-project", "地图工程路径无效");
  }
  try {
    const resolved = path.resolve(value);
    const [realPath, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== resolved) {
      throw projectError(403, "map-project-symlink", "地图工程不能通过符号链接打开");
    }
    return realPath;
  } catch (error) {
    if (error instanceof MapProjectSessionError) throw error;
    throw fileError(error, "地图工程不存在", "invalid-map-project");
  }
}

function normalizeProjectFilePath(projectPath, value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\0")
    || path.extname(value).toLowerCase() !== ".tiled-project"
  ) {
    throw projectError(400, "invalid-tiled-project-path", "Tiled 项目文件必须是工程内的 .tiled-project 文件");
  }
  const projectFilePath = path.resolve(value);
  const relativePath = path.relative(projectPath, projectFilePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw projectError(400, "invalid-tiled-project-path", "Tiled 项目文件必须位于当前工程内");
  }
  return projectFilePath;
}

async function inspectTiledProject(projectPath, projectFilePath, maxBytes) {
  let projectFileRealPath;
  try {
    projectFileRealPath = await fs.realpath(projectFilePath);
  } catch (error) {
    throw fileError(error, "Tiled 项目文件不存在", "invalid-tiled-project-path");
  }
  if (projectFileRealPath !== projectFilePath || !isWithin(projectPath, projectFileRealPath)) {
    throw projectError(403, "map-project-symlink", "Tiled 项目文件不能通过符号链接打开");
  }
  const opened = await readStableFile(projectFilePath, maxBytes);
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened.buffer).replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw projectError(415, "invalid-tiled-project-json", "Tiled 项目文件不是有效的 UTF-8 JSON", error);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw projectError(415, "invalid-tiled-project", "Tiled 项目文件必须是 JSON 对象");
  }
  const projectFile = toRelativePath(projectPath, projectFilePath);
  const folderValues = document.folders === undefined ? ["."] : document.folders;
  if (!Array.isArray(folderValues)) {
    throw projectError(415, "invalid-tiled-project-folders", "Tiled 项目的 folders 必须是数组");
  }
  const warnings = [];
  const resourceRoots = [];
  for (const value of folderValues) {
    const resolved = await inspectDeclaredFolder(projectPath, path.dirname(projectFilePath), value);
    if (resolved.warning) warnings.push(resolved.warning);
    else if (!resourceRoots.includes(resolved.relativePath)) resourceRoots.push(resolved.relativePath);
  }
  resourceRoots.sort(compareText);
  return {
    projectFile,
    resourceRoots: Object.freeze(resourceRoots),
    warnings: Object.freeze(warnings),
    manifest: Object.freeze({
      compatibilityVersion: stringOrNull(document.compatibilityVersion),
      automappingRulesFile: safeManifestReference(document.automappingRulesFile),
      extensionsPath: safeManifestReference(document.extensionsPath),
      propertyTypeCount: Array.isArray(document.propertyTypes) ? document.propertyTypes.length : 0,
      version: crypto.createHash("sha256").update(opened.buffer).digest("hex"),
      modifiedAt: opened.stat.mtimeMs,
    }),
  };
}

function temporaryProject(projectPath) {
  return {
    projectFile: null,
    resourceRoots: Object.freeze([""]),
    warnings: Object.freeze([]),
    manifest: Object.freeze({
      compatibilityVersion: null,
      automappingRulesFile: null,
      extensionsPath: null,
      propertyTypeCount: 0,
      version: null,
      modifiedAt: null,
    }),
    projectPath,
  };
}

async function inspectDeclaredFolder(projectPath, projectFileDirectory, value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) return { warning: `已忽略无效的 Tiled folders 条目：${String(value)}` };
  const candidate = path.resolve(projectFileDirectory, value);
  const relative = path.relative(projectPath, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relativeSegmentsHidden(relative)) {
    return { warning: `已忽略工程范围外的 Tiled folders 条目：${value}` };
  }
  try {
    const [realPath, stat] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== candidate || !isWithin(projectPath, realPath)) {
      return { warning: `已忽略不安全的 Tiled folders 条目：${value}` };
    }
    return { relativePath: toRelativePath(projectPath, realPath) };
  } catch {
    return { warning: `Tiled folders 目录不存在或不可读：${value}` };
  }
}

async function readStableFile(targetPath, maxBytes) {
  let handle;
  try {
    const realPath = await fs.realpath(targetPath);
    if (realPath !== targetPath) throw projectError(403, "map-project-symlink", "项目资源不能通过符号链接读取");
    handle = await fs.open(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile()) throw projectError(400, "invalid-tiled-project", "Tiled 项目路径不是文件");
    if (before.size > maxBytes) {
      throw projectError(413, "tiled-project-size-limit", "Tiled 项目文件超过管理员设置的读取上限");
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || buffer.length !== before.size) {
      throw projectError(409, "tiled-project-changed", "Tiled 项目文件在读取过程中发生变化，请重试");
    }
    return { buffer, stat: before };
  } catch (error) {
    if (error instanceof MapProjectSessionError) throw error;
    if (error?.code === "ELOOP") {
      throw projectError(403, "map-project-symlink", "Tiled 项目文件不能是符号链接");
    }
    throw fileError(error, "无法读取 Tiled 项目文件", "invalid-tiled-project-path");
  } finally {
    await handle?.close();
  }
}

async function hashStableFile(targetPath, maxBytes) {
  let handle;
  try {
    const realPath = await fs.realpath(targetPath);
    if (realPath !== targetPath) throw projectError(403, "map-project-symlink", "项目资源不能通过符号链接读取");
    handle = await fs.open(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile()) throw projectError(400, "invalid-tiled-project", "项目资源路径不是文件");
    if (before.size > maxBytes) {
      throw projectError(413, "map-project-resource-size-limit", "地图项目资源超过管理员设置的版本校验上限");
    }
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(RESOURCE_VERSION_HASH_CHUNK_BYTES, Math.max(1, before.size)));
    let position = 0;
    while (position < before.size) {
      const result = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (!result.bytesRead) break;
      hash.update(chunk.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFile(before, after) || position !== before.size) {
      throw projectError(409, "tiled-project-changed", "Tiled 项目资源在版本校验过程中发生变化，请重试");
    }
    return { stat: before, version: hash.digest("hex") };
  } catch (error) {
    if (error instanceof MapProjectSessionError) throw error;
    if (error?.code === "ELOOP") {
      throw projectError(403, "map-project-symlink", "项目资源不能是符号链接");
    }
    throw fileError(error, "无法校验地图项目资源版本", "map-project-resource-not-found");
  } finally {
    await handle?.close();
  }
}

async function safeProjectResourcePath(projectPath, relativePath) {
  const segments = relativePath.split("/");
  let current = projectPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      throw fileError(error, "项目资源不存在", "map-project-resource-not-found");
    }
    if (stat.isSymbolicLink()) throw projectError(403, "map-project-symlink", "项目资源不能通过符号链接读取");
  }
  const realPath = await fs.realpath(current).catch((error) => {
    throw fileError(error, "项目资源不存在", "map-project-resource-not-found");
  });
  if (!isWithin(projectPath, realPath) || realPath !== current) {
    throw projectError(403, "map-project-symlink", "项目资源不能通过符号链接读取");
  }
  return realPath;
}

function publicSession(session) {
  return Object.freeze({
    id: session.id,
    projectName: session.projectName,
    projectFile: session.projectFile,
    temporary: session.projectFile === null,
    writable: session.writable,
    resourceRoots: session.resourceRoots,
    manifest: session.manifest,
    warnings: session.warnings,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
}

function normalizeIdentity(value) {
  const userId = String(value?.userId || "");
  const browserSessionId = String(value?.browserSessionId || "");
  if (!userId || userId.length > 256 || !browserSessionId || browserSessionId.length > 512) {
    throw projectError(400, "invalid-map-project-session-identity", "地图项目会话身份无效");
  }
  return Object.freeze({ userId, browserSessionId });
}

function normalizeUserId(value) {
  const userId = String(value || "");
  if (!userId || userId.length > 256) {
    throw projectError(400, "invalid-map-project-session-identity", "地图项目会话身份无效");
  }
  return userId;
}

function normalizeRelativePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) throw projectError(400, "invalid-map-project-resource-path", "地图项目资源必须使用工程相对路径");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isHiddenName(segment))) {
    throw projectError(400, "invalid-map-project-resource-path", "地图项目资源路径无效");
  }
  return segments.join("/");
}

function isCharacterAnimationPath(value) {
  return typeof value === "string" && value.toLowerCase().endsWith(".character.json");
}

function safeManifestReference(value) {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && value.length <= 4096 ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length <= 128 ? value : null;
}

function isWithinRelativeRoot(root, candidate) {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toRelativePath(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function relativeSegmentsHidden(value) {
  return value.split(path.sep).some(isHiddenName);
}

function isHiddenName(value) {
  return typeof value === "string" && (value.startsWith(".") || value === "node_modules");
}

function sameIdentity(left, right) {
  return left.userId === right.userId && left.browserSessionId === right.browserSessionId;
}

function identityKey(identity) {
  return `${identity.userId}\0${identity.browserSessionId}`;
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function fileError(error, message, code) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return projectError(404, code, message, error);
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return projectError(403, "map-project-forbidden", "没有权限读取地图工程", error);
  }
  return projectError(500, "map-project-io-error", message, error);
}

function projectError(statusCode, code, message, cause = null) {
  return new MapProjectSessionError(statusCode, code, message, cause);
}
