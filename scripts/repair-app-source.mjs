#!/usr/bin/env node
import path from "node:path";
import { repairUpdateSource } from "../lib/update-source-repair.mjs";

const sourceDirectory = option("--source") || process.env.CODEX_DESKTOP_SOURCE_DIR || process.cwd();
const runtimeDirectory = option("--runtime") || process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(sourceDirectory, ".codex-runtime");
const apply = process.argv.includes("--apply");
const allowed = new Set(["--source", "--runtime", "--apply", "--dry-run"]);
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--") && !allowed.has(argument) && !argument.startsWith("--source=") && !argument.startsWith("--runtime=")) {
    throw new Error(`未知参数：${argument}`);
  }
}
if (!apply && !process.argv.includes("--dry-run")) {
  throw new Error("默认只预览；执行清理请追加 --apply");
}

console.log(JSON.stringify(await repairUpdateSource({
  sourceDirectory,
  runtimeDirectory,
  apply,
}), null, 2));

function option(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || null;
}
