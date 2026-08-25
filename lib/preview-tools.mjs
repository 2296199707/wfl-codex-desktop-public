import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".tmj", "application/json; charset=utf-8"],
  [".tsj", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

const PREVIEW_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";

export async function startStaticPreviewServer({
  root,
  entry = "index.html",
  host = "127.0.0.1",
  port = 0,
  virtualFiles = new Map(),
} = {}) {
  const rootPath = await safeRoot(root);
  const normalizedEntry = normalizeRelativePath(entry);
  const files = virtualFiles instanceof Map ? virtualFiles : new Map(Object.entries(virtualFiles));
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://preview.invalid").pathname);
      const relative = pathname === "/" ? normalizedEntry : pathname.replace(/^\/+/, "");
      const virtual = files.get(`/${relative}`) || files.get(relative);
      if (virtual !== undefined) {
        sendBody(response, virtual.body ?? virtual, virtual.type || "text/html; charset=utf-8");
        return;
      }
      const target = await safeFile(rootPath, relative);
      if (!target) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": "inline",
        "Content-Security-Policy": PREVIEW_CSP,
        "Content-Type": MIME_TYPES.get(path.extname(target).toLowerCase()) || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      (await fs.open(target, "r")).createReadStream().pipe(response);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid preview path\n");
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
    root: rootPath,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function normalizeRelativePath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("preview path must stay inside the project");
  }
  return normalized;
}

export function mimeTypeForFile(value) {
  return MIME_TYPES.get(path.extname(String(value || "")).toLowerCase()) || "application/octet-stream";
}

async function safeRoot(value) {
  if (!value) throw new Error("a project directory is required");
  const root = await fs.realpath(path.resolve(value));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("project root is not a directory");
  return root;
}

async function safeFile(root, relative) {
  let normalized;
  try {
    normalized = normalizeRelativePath(relative);
  } catch {
    return null;
  }
  const candidate = path.resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    const target = await fs.realpath(candidate);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
    return target;
  } catch {
    return null;
  }
}

function sendBody(response, body, type) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": PREVIEW_CSP,
    "Content-Type": type,
    "Content-Length": value.length,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(value);
}

export { MIME_TYPES, PREVIEW_CSP };
