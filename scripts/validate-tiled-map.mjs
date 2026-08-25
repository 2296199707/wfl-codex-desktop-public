import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import {
  collectTiledReferences,
  parseTiledDocument,
} from "../public/map-editor/tiled-document.js";
import {
  parseTiledWorld,
  resolveWorldMapReference,
} from "../public/map-editor/tiled-world.js";
import { parseTiledTemplate } from "../public/map-editor/tiled-template.js";

const [candidatePath, sourcePath, projectPath, expectedKind = "map"] = process.argv.slice(2);

try {
  if (!candidatePath || !sourcePath || !["map", "tileset", "template", "world"].includes(expectedKind)) {
    throw new Error("Tiled 文档校验参数缺失或无效");
  }
  const source = await fs.readFile(candidatePath);
  const parsed = expectedKind === "world"
    ? parseTiledWorld(source, { sourcePath })
    : expectedKind === "template"
      ? parseTiledTemplate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source).replace(/^\uFEFF/u, "")), { sourcePath })
      : parseTiledDocument(source, { expectedKind, sourcePath });
  const uniqueReferences = new Map();
  const resources = new Set();
  const diagnostics = [...(parsed.diagnostics || [])];
  const pendingTilesets = [];
  const pendingTemplates = [];
  if (expectedKind === "world") collectWorldReferences(parsed, sourcePath);
  else if (expectedKind === "template") collectTemplateReferences(parsed, sourcePath);
  else collectReferences(parsed, sourcePath);
  const visitedTilesets = new Set();
  while (pendingTilesets.length) {
    const tilesetPath = pendingTilesets.shift();
    if (visitedTilesets.has(tilesetPath)) continue;
    visitedTilesets.add(tilesetPath);
    const absolutePath = await safeProjectFile(projectPath, tilesetPath);
    if (!absolutePath) {
      diagnostics.push({
        severity: "warning",
        code: "missing-map-resource",
        path: "$",
        message: `外部瓦片集 ${tilesetPath} 当前不存在，引用已保留`,
      });
      continue;
    }
    const tilesetSource = await fs.readFile(absolutePath);
    const tileset = parseTiledDocument(tilesetSource, { expectedKind: "tileset", sourcePath: tilesetPath });
    diagnostics.push(...tileset.diagnostics);
    collectReferences(tileset, tilesetPath);
  }
  const visitedTemplates = new Set();
  while (pendingTemplates.length) {
    const templatePath = pendingTemplates.shift();
    if (visitedTemplates.has(templatePath)) continue;
    visitedTemplates.add(templatePath);
    const absolutePath = await safeProjectFile(projectPath, templatePath);
    if (!absolutePath) {
      diagnostics.push({ severity: "warning", code: "missing-map-resource", path: "$", message: `对象模板 ${templatePath} 当前不存在，引用已保留` });
      continue;
    }
    const templateSource = await fs.readFile(absolutePath);
    const template = parseTiledTemplate(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(templateSource).replace(/^\uFEFF/u, "")),
      { sourcePath: templatePath },
    );
    collectTemplateReferences(template, templatePath);
  }
  process.stdout.write(JSON.stringify({
    version: crypto.createHash("sha256").update(source).digest("hex"),
    diagnostics,
    references: [...uniqueReferences.values()],
    resources: [...resources].sort(),
  }));

  function collectReferences(document, ownerPath) {
    for (const reference of collectTiledReferences(document, { sourcePath: ownerPath })) {
      const key = `${reference.kind}\0${reference.resolvedPath || reference.reference}`;
      if (!uniqueReferences.has(key)) uniqueReferences.set(key, reference);
      if (!reference.resolvedPath) continue;
      resources.add(reference.resolvedPath);
      if (reference.kind === "tileset" && path.posix.extname(reference.resolvedPath).toLowerCase() === ".tsj") {
        pendingTilesets.push(reference.resolvedPath);
      }
      if (reference.kind === "template" && path.posix.extname(reference.resolvedPath).toLowerCase() === ".tx") {
        pendingTemplates.push(reference.resolvedPath);
      }
    }
  }

  function collectWorldReferences(world, ownerPath) {
    for (const [index, map] of (world.document.maps || []).entries()) {
      const resolvedPath = resolveWorldMapReference(ownerPath, map.fileName);
      const reference = {
        kind: "map",
        reference: map.fileName,
        jsonPath: `$.maps[${index}].fileName`,
        resolvedPath,
        error: null,
      };
      const key = `${reference.kind}\0${resolvedPath}`;
      if (!uniqueReferences.has(key)) uniqueReferences.set(key, reference);
      resources.add(resolvedPath);
    }
  }

  function collectTemplateReferences(template, ownerPath) {
    const document = template?.raw || template;
    const object = document?.object;
    if (!object || typeof object !== "object") return;
    collectTemplateValueReferences(object, ownerPath, "$.object");
    if (document.tileset && typeof document.tileset === "object") {
      if (typeof document.tileset.source === "string") {
        addReference("tileset", document.tileset.source, "$.tileset.source", ownerPath);
      }
      collectTemplateValueReferences(document.tileset, ownerPath, "$.tileset");
    }
  }

  function collectTemplateValueReferences(value, ownerPath, jsonPath) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collectTemplateValueReferences(entry, ownerPath, `${jsonPath}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${jsonPath}.${key}`;
      if (key === "image" && typeof entry === "string") addReference("image", entry, childPath, ownerPath);
      else if (key === "source" && typeof entry === "string") addReference("tileset", entry, childPath, ownerPath);
      else if (key === "template" && typeof entry === "string") addReference("template", entry, childPath, ownerPath);
      else if (key === "value" && typeof entry === "string") {
        // File properties are represented as {type:"file",value:"..."}.
        // The surrounding property type is checked below; plain strings are
        // deliberately not treated as paths.
        if (value.type === "file") addReference("file", entry, childPath, ownerPath);
      }
      collectTemplateValueReferences(entry, ownerPath, childPath);
    }
  }

  function addReference(kind, reference, jsonPath, ownerPath) {
    let resolvedPath = null;
    let error = null;
    try {
      resolvedPath = resolveProjectReference(ownerPath, reference);
    } catch (caught) {
      error = caught.message;
    }
    const key = `${kind}\0${resolvedPath || reference}`;
    if (!uniqueReferences.has(key)) uniqueReferences.set(key, { kind, reference, jsonPath, resolvedPath, error });
    if (resolvedPath) resources.add(resolvedPath);
    if (kind === "tileset" && resolvedPath && path.posix.extname(resolvedPath).toLowerCase() === ".tsj") {
      pendingTilesets.push(resolvedPath);
    }
    if (kind === "template" && resolvedPath && path.posix.extname(resolvedPath).toLowerCase() === ".tx") {
      pendingTemplates.push(resolvedPath);
    }
  }

  function resolveProjectReference(ownerPath, reference) {
    const directory = ownerPath.split("/").slice(0, -1);
    if (typeof reference !== "string" || !reference.trim() || reference.includes("\\")
      || reference.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(reference)) {
      throw new Error("Tiled 资源引用必须是工程相对路径");
    }
    const result = [...directory];
    for (const segment of reference.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!result.length) throw new Error("Tiled 资源引用不能离开工程");
        result.pop();
      } else result.push(segment);
    }
    if (!result.length) throw new Error("Tiled 资源引用必须指向文件");
    return result.join("/");
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message || "Tiled 地图校验失败" }));
  process.exitCode = 1;
}

async function safeProjectFile(projectRoot, relativePath) {
  if (!projectRoot) return null;
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`地图资源 ${relativePath} 不属于当前工程`);
  }
  try {
    const [rootReal, realPath, stat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
      fs.lstat(candidate),
    ]);
    const realRelative = path.relative(rootReal, realPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative) || stat.isSymbolicLink()) {
      throw new Error(`地图资源 ${relativePath} 不能使用符号链接逃逸工程`);
    }
    if (!stat.isFile()) throw new Error(`地图资源 ${relativePath} 不是文件`);
    return realPath;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
