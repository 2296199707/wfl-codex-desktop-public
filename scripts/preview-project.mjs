#!/usr/bin/env node
import process from "node:process";
import { startStaticPreviewServer } from "../lib/preview-tools.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.root) usage("用法：preview-project PROJECT_DIR [--entry index.html] [--port 4173]");
const preview = await startStaticPreviewServer({
  root: args.root,
  entry: args.entry || "index.html",
  host: args.host || "127.0.0.1",
  port: args.port === undefined ? 4173 : Number(args.port),
});
console.log(JSON.stringify({
  command: "preview-project",
  root: preview.root,
  entry: args.entry || "index.html",
  url: preview.url,
  rawFiles: true,
}, null, 2));
console.error("按 Ctrl-C 停止预览服务。");
const shutdown = async () => {
  await preview.close().catch(() => {});
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function parseArgs(values) {
  const result = { root: values[0] };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--entry") result.entry = values[++index];
    else if (value === "--host") result.host = values[++index];
    else if (value === "--port") result.port = values[++index];
    else usage(`未知参数：${value}`);
  }
  return result;
}

function usage(message) {
  console.error(message);
  process.exit(2);
}
