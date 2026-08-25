import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { MapRenderAssetCache, mapRenderCacheKind } from "./map-render-cache.mjs";
import { MIME_TYPES } from "./preview-tools.mjs";

const APP_MODULES = new Set([
  "map-object-model.js",
  "pixi-viewer.js",
  "render-page.js",
  "tiled-document.js",
  "tiled-render-model.js",
  "tiled-tile-codec.js",
  "tiled-tileset-model.js",
]);
const HIDDEN_NAMES = new Set([
  ".git",
  ".codex-desktop",
  ".codex-runtime",
  ".codex-trash",
  ".codex-uploads",
  "node_modules",
]);
const RENDER_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export async function startMapRenderPreviewServer({
  projectPath,
  mapPath,
  appDirectory,
  renderConfig = {},
  cacheDirectory = null,
  cacheConfig = {},
  host = "127.0.0.1",
  port = 0,
} = {}) {
  const projectRoot = await safeRoot(projectPath);
  const appRoot = await safeRoot(appDirectory);
  const relativeMapPath = normalizeProjectPath(mapPath);
  if (!await safeProjectFile(projectRoot, relativeMapPath)) throw new Error("map file is not available inside the project");
  const renderHtml = buildRenderHtml({ ...renderConfig, mapPath: relativeMapPath });
  const assetCache = cacheDirectory ? new MapRenderAssetCache(cacheDirectory, cacheConfig) : null;
  const server = http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method || "GET")) {
        sendText(response, 405, "Method not allowed\n");
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://render.invalid").pathname);
      if (pathname === "/__wfl/render.html") {
        sendBody(response, 200, renderHtml, "text/html; charset=utf-8", request.method);
        return;
      }
      if (pathname === "/__wfl/vendor/pixi/pixi.min.js") {
        await sendFile(response, path.join(appRoot, "node_modules", "pixi.js", "dist", "pixi.min.js"), request.method);
        return;
      }
      if (pathname === "/__wfl/vendor/pixi/unsafe-eval.min.js") {
        await sendFile(
          response,
          path.join(appRoot, "node_modules", "pixi.js", "dist", "packages", "unsafe-eval.min.js"),
          request.method,
        );
        return;
      }
      if (pathname === "/__wfl/vendor/pixi/advanced-blend-modes.min.js") {
        await sendFile(
          response,
          path.join(appRoot, "node_modules", "pixi.js", "dist", "packages", "advanced-blend-modes.min.js"),
          request.method,
        );
        return;
      }
      if (pathname.startsWith("/__wfl/app/map-editor/")) {
        const name = pathname.slice("/__wfl/app/map-editor/".length);
        if (!APP_MODULES.has(name)) {
          sendText(response, 404, "Not found\n");
          return;
        }
        await sendFile(response, path.join(appRoot, "public", "map-editor", name), request.method);
        return;
      }
      const relative = pathname.replace(/^\/+/, "") || "index.html";
      const target = await safeProjectFile(projectRoot, relative, { directoryIndex: true });
      if (!target) {
        sendText(response, 404, "Not found\n");
        return;
      }
      await sendFile(response, target, request.method, assetCache, mapRenderCacheKind(target));
    } catch {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendText(response, 400, "Invalid render path\n");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    projectPath: projectRoot,
    mapPath: relativeMapPath,
    origin: `http://${host}:${actualPort}`,
    url: `http://${host}:${actualPort}/__wfl/render.html`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function buildRenderHtml(config) {
  const serialized = JSON.stringify(config).replaceAll("<", "\\u003c");
  return [
    "<!doctype html>",
    '<html data-render-state="loading">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>html,body,#renderHost{width:100%;height:100%;margin:0;overflow:hidden;background:#171918}canvas{display:block}</style>",
    "</head>",
    '<body><main id="renderHost"></main>',
    `<script>globalThis.__WFL_RENDER_CONFIG__=${serialized}</script>`,
    '<script src="/__wfl/vendor/pixi/pixi.min.js"></script>',
    '<script src="/__wfl/vendor/pixi/advanced-blend-modes.min.js"></script>',
    '<script src="/__wfl/vendor/pixi/unsafe-eval.min.js"></script>',
    '<script type="module" src="/__wfl/app/map-editor/render-page.js"></script>',
    "</body></html>",
  ].join("\n");
}

async function safeRoot(value) {
  if (!value) throw new Error("render root is required");
  const root = await fs.realpath(path.resolve(value));
  if (!(await fs.stat(root)).isDirectory()) throw new Error("render root is not a directory");
  return root;
}

function normalizeProjectPath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || HIDDEN_NAMES.has(segment))
  ) throw new Error("render path must stay inside the project");
  return segments.join("/");
}

async function safeProjectFile(root, relativePath, { directoryIndex = false } = {}) {
  let normalized;
  try {
    normalized = normalizeProjectPath(relativePath);
  } catch {
    return null;
  }
  const candidate = path.resolve(root, normalized);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    let real = await fs.realpath(candidate);
    if (real === root || !real.startsWith(`${root}${path.sep}`)) return null;
    let stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory() && directoryIndex) {
      const indexCandidate = path.join(candidate, "index.html");
      real = await fs.realpath(indexCandidate);
      stat = await fs.lstat(indexCandidate);
      if (real === root || !real.startsWith(`${root}${path.sep}`) || stat.isSymbolicLink()) return null;
    }
    return stat.isFile() ? real : null;
  } catch {
    return null;
  }
}

async function sendFile(response, filename, method, cache = null, cacheKind = null) {
  const resolved = cache && cacheKind ? await cache.resolve(filename, cacheKind) : { path: filename };
  let handle;
  try {
    handle = await fs.open(resolved.path, "r");
  } catch (error) {
    if (resolved.path === filename || error.code !== "ENOENT") throw error;
    handle = await fs.open(filename, "r");
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new Error("not a file");
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Disposition": "inline",
    "Content-Security-Policy": RENDER_CSP,
    "Content-Length": stat.size,
    "Content-Type": MIME_TYPES.get(path.extname(filename).toLowerCase()) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (method === "HEAD") {
    await handle.close();
    response.end();
    return;
  }
  await pipeline(handle.createReadStream(), response);
}

function sendText(response, status, value) {
  sendBody(response, status, value, "text/plain; charset=utf-8", "GET");
}

function sendBody(response, status, body, type, method, knownLength = null) {
  const value = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Disposition": "inline",
    "Content-Security-Policy": RENDER_CSP,
    "Content-Length": knownLength ?? value?.length ?? 0,
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : value);
}

export { RENDER_CSP };
