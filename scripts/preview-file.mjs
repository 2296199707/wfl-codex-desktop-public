#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { mimeTypeForFile, startStaticPreviewServer } from "../lib/preview-tools.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage("用法：preview-file FILE [--port 4174]");
const file = await fs.realpath(path.resolve(args.file));
const stat = await fs.stat(file);
if (!stat.isFile()) usage("只能预览单个文件");
const directory = path.dirname(file);
const basename = path.basename(file);
const urlPath = `/${encodeURIComponent(basename)}`;
const type = mimeTypeForFile(file);
const viewer = viewerHtml({ basename, urlPath, type });
const preview = await startStaticPreviewServer({
  root: directory,
  entry: "__preview_file_viewer__.html",
  host: args.host || "127.0.0.1",
  port: args.port === undefined ? 4174 : Number(args.port),
  virtualFiles: new Map([["/__preview_file_viewer__.html", { body: viewer, type: "text/html; charset=utf-8" }]]),
});
console.log(JSON.stringify({ command: "preview-file", file, type, url: preview.url }, null, 2));
console.error("按 Ctrl-C 停止预览服务。");
const shutdown = async () => {
  await preview.close().catch(() => {});
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function viewerHtml({ basename: title, urlPath, type }) {
  const kind = type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video" : "text";
  const escapedTitle = JSON.stringify(title);
  const escapedPath = JSON.stringify(urlPath);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>html,body{margin:0;min-height:100%;background:#111827;color:#e5e7eb;font:16px system-ui,sans-serif}main{padding:24px;display:grid;gap:16px;justify-items:center}img,video{max-width:96vw;max-height:80vh}audio{width:min(720px,96vw)}pre{width:min(1100px,96vw);box-sizing:border-box;white-space:pre-wrap;overflow:auto;padding:16px;border-radius:12px;background:#0b1220}h1{font-size:18px;word-break:break-all}</style><main><h1 id="title"></h1><div id="viewer"></div></main><script>const title=${escapedTitle};const file=${escapedPath};document.title=title;document.querySelector('#title').textContent=title;const viewer=document.querySelector('#viewer');const kind=${JSON.stringify(kind)};if(kind==='image'){const el=document.createElement('img');el.src=file;el.alt=title;viewer.append(el)}else if(kind==='audio'){const el=document.createElement('audio');el.controls=true;el.src=file;viewer.append(el)}else if(kind==='video'){const el=document.createElement('video');el.controls=true;el.src=file;viewer.append(el)}else{const pre=document.createElement('pre');fetch(file).then(r=>r.text()).then(text=>pre.textContent=text).catch(error=>pre.textContent=error.message);viewer.append(pre)}</script>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function parseArgs(values) {
  const result = { file: values[0] };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--host") result.host = values[++index];
    else if (value === "--port") result.port = values[++index];
    else usage(`未知参数：${value}`);
  }
  return result;
}

function usage(message) {
  console.error(message);
  process.exit(2);
}
