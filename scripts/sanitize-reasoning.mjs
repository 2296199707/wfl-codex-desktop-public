import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPathOpenByPid,
  sanitizeSessionFile,
  sessionFileContainsPlaintextReasoning,
  sessionFileForThread,
} from "../lib/codex-reasoning-sanitizer.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultCodexHome = process.env.CODEX_HOME || path.join(process.env.HOME || "/root", ".codex");

function parseArguments(argv) {
  const options = {
    codexHome: defaultCodexHome,
    dryRun: true,
    threadId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex-home") options.codexHome = argv[++index];
    else if (argument === "--thread") options.threadId = argv[++index];
    else if (argument === "--apply") options.dryRun = false;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(`用法: node scripts/sanitize-reasoning.mjs [--codex-home <目录>] [--thread <对话ID>] [--apply|--dry-run]`);
      process.exit(0);
    } else {
      console.error(`未知参数: ${argument}`);
      process.exit(2);
    }
  }
  return options;
}

function openPids() {
  const pids = [];
  const entries = fs.readdirSync("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^\d+$/.test(entry.name)) pids.push(Number(entry.name));
  }
  return pids;
}

async function collectCandidates(sessionsRoot, threadId) {
  if (threadId) {
    const file = await sessionFileForThread(sessionsRoot, threadId);
    return file ? [file] : [];
  }
  const files = [];
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  return files;
}

const options = parseArguments(process.argv.slice(2));
const sessionsRoot = path.join(options.codexHome, "sessions");
const files = await collectCandidates(sessionsRoot, options.threadId);
const pids = openPids();
let affected = 0;
let cleaned = 0;
let locked = 0;
for (const file of files) {
  const needsSanitizing = await sessionFileContainsPlaintextReasoning(file).catch(() => false);
  if (!needsSanitizing) continue;
  affected += 1;
  const openBy = pids.find((pid) => isPathOpenByPid(file, pid));
  if (openBy) {
    locked += 1;
    console.log(`[locked] pid ${openBy} 持有 ${file}`);
    continue;
  }
  if (options.dryRun) {
    console.log(`[dry-run] 需要清洗: ${file}`);
    continue;
  }
  const result = await sanitizeSessionFile(file, {
    expectedUid: typeof process.getuid === "function" ? process.getuid() : null,
    expectedGid: typeof process.getgid === "function" ? process.getgid() : null,
  });
  cleaned += result.reasoningItemsCleaned;
  console.log(`[cleaned] ${file}: ${result.reasoningItemsCleaned} 条明文推理，备份 ${result.backupPath}`);
}
console.log(
  `完成: 受影响 ${affected} 个文件，锁定跳过 ${locked} 个，清洗 ${cleaned} 条${options.dryRun ? "（dry-run，未写入）" : ""}`,
);
