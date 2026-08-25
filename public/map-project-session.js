const RESOURCE_KINDS = new Set([
  "directory",
  "map",
  "world",
  "tileset",
  "project",
  "template",
  "character",
  "image",
  "audio",
  "html",
  "stylesheet",
  "script",
  "automapping",
  "other",
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const STALE_OPERATION_CODE = "map-project-stale-operation";

export class MapProjectWorkspaceClient {
  constructor({
    fetchImpl = globalThis.fetch,
    origin = globalThis.location?.origin || "http://localhost",
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new TypeError("timeoutMs must be between 1000 and 120000");
    }
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.origin = origin;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.operationVersion = 0;
  }

  async open({ project, projectFile = null } = {}) {
    if (typeof project !== "string" || !project) throw new TypeError("project is required");
    const operationVersion = ++this.operationVersion;
    await this.closeCurrent().catch(() => {});
    if (operationVersion !== this.operationVersion) throw staleOperationError();
    const response = await this.request(new URL("/api/map-projects/sessions", this.origin), {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-project-session-open",
      },
      body: JSON.stringify({ project, ...(projectFile ? { projectFile: normalizeRelativePath(projectFile) } : {}) }),
    });
    const data = await readJson(response, "无法打开地图项目工作区");
    const session = normalizeSession(data.session);
    if (operationVersion !== this.operationVersion) {
      await this.closeSession(session.id).catch(() => {});
      throw staleOperationError();
    }
    this.session = session;
    return session;
  }

  async tree({ directory = "", kinds = [], cursor = null, limit = 100 } = {}) {
    const session = this.requireSession();
    const url = new URL(`/api/map-projects/sessions/${encodeURIComponent(session.id)}/tree`, this.origin);
    if (directory) url.searchParams.set("directory", normalizeRelativePath(directory));
    appendListQuery(url, { kinds, cursor, limit });
    const response = await this.request(url, { cache: "no-store" });
    const data = await readJson(response, "无法读取地图项目目录");
    if (data.projectSessionId !== session.id) throw new Error("地图项目目录返回了不匹配的会话");
    return normalizePage(data.tree, { directory });
  }

  async search({ query, kinds = [], cursor = null, limit = 100 } = {}) {
    const session = this.requireSession();
    const normalizedQuery = String(query || "").trim();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
      throw new TypeError("query must contain 2-100 characters");
    }
    const url = new URL(`/api/map-projects/sessions/${encodeURIComponent(session.id)}/search`, this.origin);
    url.searchParams.set("query", normalizedQuery);
    appendListQuery(url, { kinds, cursor, limit });
    const response = await this.request(url, { cache: "no-store" });
    const data = await readJson(response, "无法搜索地图项目资源");
    if (data.projectSessionId !== session.id) throw new Error("地图项目搜索返回了不匹配的会话");
    return normalizeSearchPage(data.search, normalizedQuery);
  }

  async readResourceSource(relativePath) {
    const session = this.requireSession();
    const normalized = normalizeRelativePath(relativePath);
    const url = new URL(
      `/api/map-projects/sessions/${encodeURIComponent(session.id)}/resource-source`,
      this.origin,
    );
    url.searchParams.set("path", normalized);
    const response = await this.request(url, { cache: "no-store" });
    if (!response.ok) await readJson(response, "无法读取地图项目资源");
    const content = await response.text();
    return Object.freeze({
      relativePath: normalized,
      content,
      version: response.headers.get("x-wfl-project-resource-version") || null,
    });
  }

  async readResourceVersion(relativePath, kind = "map") {
    const session = this.requireSession();
    const normalized = normalizeRelativePath(relativePath);
    const url = new URL(
      `/api/map-projects/sessions/${encodeURIComponent(session.id)}/resource-version`, this.origin,
    );
    url.searchParams.set("path", normalized);
    url.searchParams.set("kind", String(kind || "map"));
    const response = await this.request(url, { cache: "no-store" });
    const data = await readJson(response, "无法读取地图项目资源版本");
    if (data.projectSessionId !== session.id) throw new Error("地图项目资源版本返回了不匹配的会话");
    const resource = data?.resource;
    if (!resource || resource.relativePath !== normalized || !/^[a-f0-9]{64}$/iu.test(String(resource.version || ""))) {
      throw new Error("地图项目资源版本响应无效");
    }
    return Object.freeze({
      relativePath: normalized,
      size: Number(resource.size) || 0,
      modifiedAt: Number(resource.modifiedAt) || 0,
      version: String(resource.version).toLowerCase(),
    });
  }

  resourceImageUrl(relativePath) {
    const session = this.requireSession();
    const normalized = normalizeRelativePath(relativePath);
    const url = new URL(
      `/api/map-projects/sessions/${encodeURIComponent(session.id)}/resource-image`,
      this.origin,
    );
    url.searchParams.set("path", normalized);
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  async saveCharacterAnimation({ relativePath, document, expectedVersion = null } = {}) {
    const session = this.requireSession();
    if (!session.writable) throw new Error("当前地图项目是只读的");
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized.toLowerCase().endsWith(".character.json")) {
      throw new TypeError("character path must end in .character.json");
    }
    const url = new URL(
      `/api/map-projects/sessions/${encodeURIComponent(session.id)}/character`,
      this.origin,
    );
    url.searchParams.set("path", normalized);
    const response = await this.request(url, {
      method: "PUT",
      cache: "no-store",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Codex-Desktop-Action": "map-project-character-save",
        ...(expectedVersion ? { "X-WFL-Project-Resource-Version": String(expectedVersion) } : {}),
      },
      body: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
    });
    const data = await readJson(response, "无法保存角色动画清单");
    if (data.projectSessionId !== session.id || !data.character) {
      throw new Error("角色动画保存返回了不匹配的项目会话");
    }
    return Object.freeze({ ...data.character });
  }

  async importResource({ sourceProjectSessionId, sourcePath, targetPath, planHash = null, confirmation = false } = {}) {
    const session = this.requireSession();
    if (!session.writable) throw new Error("当前地图项目是只读的");
    if (typeof sourceProjectSessionId !== "string" || !sourceProjectSessionId) {
      throw new TypeError("sourceProjectSessionId is required");
    }
    const normalizedSourcePath = normalizeRelativePath(sourcePath);
    const normalizedTargetPath = normalizeRelativePath(targetPath);
    const body = {
      sourceProjectSessionId,
      sourcePath: normalizedSourcePath,
      targetPath: normalizedTargetPath,
      confirmation: confirmation === true,
      ...(planHash ? { planHash: String(planHash) } : {}),
    };
    const response = await this.request(
      new URL(`/api/map-projects/sessions/${encodeURIComponent(session.id)}/imports`, this.origin),
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "map-project-import",
        },
        body: JSON.stringify(body),
      },
    );
    const data = await readJson(response, confirmation ? "无法提交跨工程素材导入" : "无法生成跨工程素材导入计划");
    if (data.projectSessionId !== session.id || data.sourceProjectSessionId !== sourceProjectSessionId) {
      throw new Error("跨工程导入返回了不匹配的项目会话");
    }
    if (!data.plan || typeof data.plan !== "object" || typeof data.plan.planHash !== "string") {
      throw new Error("跨工程导入计划响应无效");
    }
    return Object.freeze({
      plan: normalizeImportPlan(data.plan),
      committed: confirmation === true,
      ...(Array.isArray(data.published) ? { published: Object.freeze(data.published.map((entry) => Object.freeze({ ...entry }))) } : {}),
      ...(Number.isSafeInteger(data.reused) ? { reused: data.reused } : {}),
    });
  }

  async createMap(input = {}) {
    const session = this.requireSession();
    if (!session.writable) throw new Error("当前地图项目是只读的");
    const payload = normalizeMapCreateInput(input);
    const response = await this.request(
      new URL(`/api/map-projects/sessions/${encodeURIComponent(session.id)}/maps`, this.origin),
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "map-project-map-create",
        },
        body: JSON.stringify(payload),
      },
    );
    const data = await readJson(response, "无法新建地图");
    if (data.projectSessionId !== session.id) throw new Error("新建地图返回了不匹配的项目会话");
    return normalizeCreatedMap(data.map, payload.relativePath);
  }

  async createWorld(input = {}) {
    const session = this.requireSession();
    if (!session.writable) throw new Error("当前地图项目是只读的");
    const payload = normalizeWorldCreateInput(input);
    const response = await this.request(
      new URL(`/api/map-projects/sessions/${encodeURIComponent(session.id)}/worlds`, this.origin),
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "map-project-world-create",
        },
        body: JSON.stringify(payload),
      },
    );
    const data = await readJson(response, "无法新建 World");
    if (data.projectSessionId !== session.id) throw new Error("新建 World 返回了不匹配的项目会话");
    return normalizeCreatedWorld(data.world, payload.relativePath);
  }

  async createTileset(input = {}) {
    const session = this.requireSession();
    if (!session.writable) throw new Error("当前地图项目是只读的");
    const payload = normalizeTilesetCreateInput(input);
    const response = await this.request(
      new URL(`/api/map-projects/sessions/${encodeURIComponent(session.id)}/tilesets`, this.origin),
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "map-project-tileset-create",
        },
        body: JSON.stringify(payload),
      },
    );
    const data = await readJson(response, "无法新建瓦片集");
    if (data.projectSessionId !== session.id) throw new Error("新建瓦片集返回了不匹配的项目会话");
    return normalizeCreatedTileset(data.tileset, payload.relativePath);
  }

  async close({ keepalive = false } = {}) {
    this.operationVersion += 1;
    return this.closeCurrent({ keepalive });
  }

  async closeCurrent({ keepalive = false } = {}) {
    const session = this.session;
    this.session = null;
    if (!session) return false;
    return this.closeSession(session.id, { keepalive });
  }

  async closeSession(sessionId, { keepalive = false } = {}) {
    const response = await this.request(
      new URL(`/api/map-projects/sessions/${encodeURIComponent(sessionId)}`, this.origin),
      {
        method: "DELETE",
        cache: "no-store",
        keepalive,
        headers: { "X-Codex-Desktop-Action": "map-project-session-close" },
      },
    );
    if (!response.ok && response.status !== 404) {
      await readJson(response, "无法关闭地图项目工作区");
    }
    return response.ok;
  }

  async request(input, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(input, { ...options, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error("地图项目请求超时，请稍后重试");
        timeoutError.code = "map-project-request-timeout";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  mapOpenPayload(relativePath, editorInstanceId) {
    const session = this.requireSession();
    const mapPath = normalizeRelativePath(relativePath);
    if (!mapPath.toLowerCase().endsWith(".tmj")) throw new TypeError("map path must end in .tmj");
    return Object.freeze({
      projectSessionId: session.id,
      path: mapPath,
      editorInstanceId: String(editorInstanceId || ""),
    });
  }

  worldOpenPayload(relativePath, editorInstanceId) {
    const session = this.requireSession();
    const worldPath = normalizeRelativePath(relativePath);
    if (!worldPath.toLowerCase().endsWith(".world")) throw new TypeError("world path must end in .world");
    return Object.freeze({
      projectSessionId: session.id,
      path: worldPath,
      editorInstanceId: String(editorInstanceId || ""),
    });
  }

  tilesetOpenPayload(relativePath, editorInstanceId) {
    const session = this.requireSession();
    const tilesetPath = normalizeRelativePath(relativePath);
    if (!tilesetPath.toLowerCase().endsWith(".tsj")) throw new TypeError("tileset path must end in .tsj");
    return Object.freeze({
      projectSessionId: session.id,
      path: tilesetPath,
      editorInstanceId: String(editorInstanceId || ""),
    });
  }

  requireSession() {
    if (!this.session) throw new Error("地图项目工作区尚未连接");
    return this.session;
  }
}

function staleOperationError() {
  const error = new Error("地图项目工作区请求已过期");
  error.code = STALE_OPERATION_CODE;
  return error;
}

function appendListQuery(url, { kinds, cursor, limit }) {
  const normalizedKinds = Array.isArray(kinds)
    ? [...new Set(kinds.map(String).filter((kind) => kind && kind !== "directory"))]
    : [];
  if (normalizedKinds.length) url.searchParams.set("kinds", normalizedKinds.join(","));
  if (cursor) url.searchParams.set("cursor", String(cursor));
  if (Number.isSafeInteger(limit) && limit > 0) url.searchParams.set("limit", String(limit));
}

function normalizeSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.id || "")) {
    throw new Error("地图项目会话响应无效");
  }
  const resourceRoots = Array.isArray(value.resourceRoots)
    ? value.resourceRoots.map((entry) => entry === "" ? "" : normalizeRelativePath(entry))
    : null;
  if (!resourceRoots) throw new Error("地图项目会话 folders 响应无效");
  return Object.freeze({
    id: value.id,
    projectName: String(value.projectName || ""),
    projectFile: value.projectFile == null ? null : normalizeRelativePath(value.projectFile),
    temporary: value.temporary === true,
    writable: value.writable === true,
    resourceRoots: Object.freeze(resourceRoots),
    manifest: value.manifest && typeof value.manifest === "object" ? Object.freeze({ ...value.manifest }) : null,
    warnings: Object.freeze(Array.isArray(value.warnings) ? value.warnings.map(String) : []),
    createdAt: Number(value.createdAt) || 0,
    expiresAt: Number(value.expiresAt) || 0,
  });
}

function normalizePage(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("地图项目目录响应无效");
  const directory = value.directory ? normalizeRelativePath(value.directory) : "";
  if (directory !== expected.directory) throw new Error("地图项目目录响应范围不匹配");
  return Object.freeze({
    directory,
    entries: Object.freeze(normalizeEntries(value.entries)),
    nextCursor: normalizeCursor(value.nextCursor),
  });
}

function normalizeSearchPage(value, query) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("地图项目搜索响应无效");
  return Object.freeze({
    query,
    entries: Object.freeze(normalizeEntries(value.entries)),
    nextCursor: normalizeCursor(value.nextCursor),
    scanned: Number.isSafeInteger(value.scanned) && value.scanned >= 0 ? value.scanned : 0,
    truncated: value.truncated === true,
  });
}

function normalizeImportPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "wfl.map-project-import.v1"
    || !/^[a-f0-9]{64}$/iu.test(String(value.planHash || ""))
    || !value.source || !value.target || !Array.isArray(value.files)) {
    throw new Error("跨工程导入计划结构无效");
  }
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("跨工程导入文件条目无效");
    const sourcePath = normalizeRelativePath(entry.sourcePath);
    const targetPath = normalizeRelativePath(entry.targetPath);
    if (!/^[a-f0-9]{64}$/iu.test(String(entry.sha256 || ""))) throw new Error("跨工程导入文件哈希无效");
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error("跨工程导入文件大小无效");
    if (!new Set(["copy", "reuse"]).has(entry.action)) throw new Error("跨工程导入文件动作无效");
    return Object.freeze({
      sourcePath,
      targetPath,
      kind: String(entry.kind || "other"),
      size: entry.size,
      sha256: String(entry.sha256).toLowerCase(),
      action: entry.action,
      dependency: entry.dependency === true,
    });
  });
  return Object.freeze({
    schema: value.schema,
    planHash: String(value.planHash).toLowerCase(),
    source: Object.freeze({ projectName: String(value.source.projectName || ""), path: normalizeRelativePath(value.source.path) }),
    target: Object.freeze({ path: normalizeRelativePath(value.target.path) }),
    files: Object.freeze(files),
    copyCount: Number.isSafeInteger(value.copyCount) ? value.copyCount : files.filter((entry) => entry.action === "copy").length,
    reuseCount: Number.isSafeInteger(value.reuseCount) ? value.reuseCount : files.filter((entry) => entry.action === "reuse").length,
    copyBytes: Number.isSafeInteger(value.copyBytes) ? value.copyBytes : 0,
    totalBytes: Number.isSafeInteger(value.totalBytes) ? value.totalBytes : 0,
  });
}

function normalizeEntries(value) {
  if (!Array.isArray(value)) throw new Error("地图项目资源清单无效");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || !RESOURCE_KINDS.has(entry.kind)) {
      throw new Error("地图项目资源条目无效");
    }
    const resourcePath = normalizeRelativePath(entry.path);
    return Object.freeze({
      path: resourcePath,
      name: String(entry.name || resourcePath.split("/").at(-1)),
      kind: entry.kind,
      size: entry.size == null ? null : Number(entry.size),
      modifiedAt: Number(entry.modifiedAt) || 0,
    });
  });
}

function normalizeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) {
    throw new Error("地图项目分页游标无效");
  }
  return value;
}

function normalizeMapCreateInput(input) {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath.toLowerCase().endsWith(".tmj")) throw new TypeError("map path must end in .tmj");
  const orientations = new Set(["orthogonal", "isometric", "staggered", "hexagonal", "oblique"]);
  const orientation = String(input.orientation || "");
  if (!orientations.has(orientation)) throw new TypeError("map orientation is invalid");
  const infinite = input.infinite === true;
  const payload = {
    relativePath,
    orientation,
    infinite,
    tilewidth: positiveInteger(input.tilewidth, "tilewidth"),
    tileheight: positiveInteger(input.tileheight, "tileheight"),
    renderorder: String(input.renderorder || "right-down"),
    initialLayerName: String(input.initialLayerName || "").trim(),
    tilesets: input.tilesets == null ? [] : input.tilesets.map(normalizeRelativePath),
    targetVersion: String(input.targetVersion || "1.12.2"),
  };
  if (!infinite) {
    payload.width = positiveInteger(input.width, "width");
    payload.height = positiveInteger(input.height, "height");
  }
  if (input.backgroundcolor) payload.backgroundcolor = String(input.backgroundcolor);
  if (["staggered", "hexagonal"].includes(orientation)) {
    payload.staggeraxis = String(input.staggeraxis || "y");
    payload.staggerindex = String(input.staggerindex || "odd");
  }
  if (orientation === "hexagonal") payload.hexsidelength = nonNegativeInteger(input.hexsidelength, "hexsidelength");
  if (orientation === "oblique") {
    payload.skewx = safeInteger(input.skewx, "skewx");
    payload.skewy = safeInteger(input.skewy, "skewy");
  }
  if (!payload.initialLayerName) throw new TypeError("initialLayerName is required");
  if (!Array.isArray(payload.tilesets) || payload.tilesets.length > 1) throw new TypeError("only one tileset may be selected");
  return payload;
}

function normalizeCreatedMap(value, expectedPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("新建地图响应无效");
  const relativePath = normalizeRelativePath(value.relativePath);
  if (relativePath !== expectedPath || !/^[a-f0-9]{64}$/u.test(value.version || "")) {
    throw new Error("新建地图响应范围无效");
  }
  return Object.freeze({
    relativePath,
    version: value.version,
    size: Number(value.size) || 0,
    modifiedAt: Number(value.modifiedAt) || 0,
    orientation: String(value.orientation || ""),
    infinite: value.infinite === true,
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    tilewidth: Number(value.tilewidth) || 0,
    tileheight: Number(value.tileheight) || 0,
    tilesetCount: Number(value.tilesetCount) || 0,
    diagnostics: Object.freeze(Array.isArray(value.diagnostics) ? [...value.diagnostics] : []),
  });
}

function normalizeWorldCreateInput(input) {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath.toLowerCase().endsWith(".world")) throw new TypeError("world path must end in .world");
  const maps = input.maps == null ? [] : input.maps;
  const patterns = input.patterns == null ? [] : input.patterns;
  if (!Array.isArray(maps)) throw new TypeError("maps must be an array");
  if (!Array.isArray(patterns)) throw new TypeError("patterns must be an array");
  return {
    relativePath,
    maps: maps.map((entry) => ({
      path: normalizeRelativePath(entry?.path),
      x: safeInteger(entry?.x, "map x"),
      y: safeInteger(entry?.y, "map y"),
      width: positiveInteger(entry?.width, "map width"),
      height: positiveInteger(entry?.height, "map height"),
    })),
    patterns: structuredClone(patterns),
    onlyShowAdjacentMaps: input.onlyShowAdjacentMaps === true,
  };
}

function normalizeCreatedWorld(value, expectedPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("新建 World 响应无效");
  const relativePath = normalizeRelativePath(value.relativePath);
  if (relativePath !== expectedPath || !/^[a-f0-9]{64}$/u.test(value.version || "")) {
    throw new Error("新建 World 响应范围无效");
  }
  return Object.freeze({
    relativePath,
    version: value.version,
    size: Number(value.size) || 0,
    modifiedAt: Number(value.modifiedAt) || 0,
    mapCount: Number(value.mapCount) || 0,
    patternCount: Number(value.patternCount) || 0,
    onlyShowAdjacentMaps: value.onlyShowAdjacentMaps === true,
    diagnostics: Object.freeze(Array.isArray(value.diagnostics) ? [...value.diagnostics] : []),
  });
}

function normalizeTilesetCreateInput(input) {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath.toLowerCase().endsWith(".tsj")) throw new TypeError("tileset path must end in .tsj");
  const kind = String(input.kind || "");
  if (kind !== "atlas" && kind !== "collection") throw new TypeError("tileset kind must be atlas or collection");
  const name = String(input.name || "").trim();
  if (!name) throw new TypeError("tileset name is required");
  const payload = {
    relativePath,
    kind,
    name,
    targetVersion: String(input.targetVersion || "1.12.2"),
  };
  if (kind === "atlas") {
    payload.image = normalizeRelativePath(input.image);
    payload.tilewidth = positiveInteger(input.tilewidth, "tilewidth");
    payload.tileheight = positiveInteger(input.tileheight, "tileheight");
    payload.margin = nonNegativeInteger(input.margin ?? 0, "margin");
    payload.spacing = nonNegativeInteger(input.spacing ?? 0, "spacing");
    if (input.transparentcolor) payload.transparentcolor = String(input.transparentcolor);
  } else {
    if (!Array.isArray(input.images) || !input.images.length) {
      throw new TypeError("collection images must be a non-empty array");
    }
    payload.images = input.images.map(normalizeRelativePath);
    if (new Set(payload.images).size !== payload.images.length) {
      throw new TypeError("collection images must not contain duplicates");
    }
  }
  return payload;
}

function normalizeCreatedTileset(value, expectedPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("新建瓦片集响应无效");
  const relativePath = normalizeRelativePath(value.relativePath);
  const kind = String(value.kind || "");
  const imagePaths = Array.isArray(value.imagePaths) ? value.imagePaths.map(normalizeRelativePath) : null;
  if (
    relativePath !== expectedPath
    || !/^[a-f0-9]{64}$/u.test(value.version || "")
    || (kind !== "atlas" && kind !== "collection")
    || !imagePaths
  ) throw new Error("新建瓦片集响应范围无效");
  return Object.freeze({
    relativePath,
    version: value.version,
    size: Number(value.size) || 0,
    modifiedAt: Number(value.modifiedAt) || 0,
    kind,
    name: String(value.name || ""),
    tilewidth: Number(value.tilewidth) || 0,
    tileheight: Number(value.tileheight) || 0,
    tilecount: Number(value.tilecount) || 0,
    columns: Number(value.columns) || 0,
    imageCount: Number(value.imageCount) || 0,
    imagePaths: Object.freeze(imagePaths),
    diagnostics: Object.freeze(Array.isArray(value.diagnostics) ? [...value.diagnostics] : []),
  });
}

function safeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be an integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = safeInteger(value, name);
  if (number < 0) throw new TypeError(`${name} must be non-negative`);
  return number;
}

function positiveInteger(value, name) {
  const number = safeInteger(value, name);
  if (number <= 0) throw new TypeError(`${name} must be positive`);
  return number;
}

function normalizeRelativePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) throw new TypeError("path must be project-relative");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new TypeError("path must be project-relative");
  }
  return segments.join("/");
}

async function readJson(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || fallback);
    error.status = response.status;
    error.statusCode = response.status;
    error.code = typeof data.code === "string" ? data.code : null;
    throw error;
  }
  return data;
}
