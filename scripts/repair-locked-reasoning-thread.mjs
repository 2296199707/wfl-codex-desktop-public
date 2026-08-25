import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSessionFile } from "../lib/codex-reasoning-sanitizer.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_LOG = "/srv/wfl-codex-desktop/.codex-desktop/state-repair-backups/reasoning-repair.log";

function parseArguments(argv) {
  const options = { file: null, bridgePid: null, log: DEFAULT_LOG, waitMs: 15_000, maxWaitMs: 10 * 60_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") options.file = argv[++index];
    else if (argument === "--bridge-pid") options.bridgePid = Number(argv[++index]);
    else if (argument === "--log") options.log = argv[++index];
    else if (argument === "--wait-ms") options.waitMs = Number(argv[++index]);
    else if (argument === "--max-wait-ms") options.maxWaitMs = Number(argv[++index]);
    else {
      console.error(`未知参数: ${argument}`);
      process.exit(2);
    }
  }
  if (!options.file || !Number.isInteger(options.bridgePid) || options.bridgePid <= 0) {
    console.error("必须提供 --file 和 --bridge-pid");
    process.exit(2);
  }
  return options;
}

function appendLog(logPath, message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging is best-effort
  }
}

async function statNow(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

async function waitForIdle(filePath, { stableSamples = 3, sampleMs = 5_000, maxWaitMs }) {
  const started = Date.now();
  let last = null;
  let stable = 0;
  while (Date.now() - started < maxWaitMs) {
    const current = await statNow(filePath);
    if (current) {
      if (last && current.size === last.size && current.mtimeMs === last.mtimeMs) {
        stable += 1;
        if (stable >= stableSamples) return current;
      } else {
        stable = 0;
      }
      last = current;
    }
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  return null;
}

function openOldInodeFd(bridgePid, targetPath) {
  if (!Number.isInteger(bridgePid) || bridgePid <= 0) return null;
  const fdDirectory = `/proc/${bridgePid}/fd`;
  let names;
  try {
    names = fs.readdirSync(fdDirectory);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      let link = fs.readlinkSync(path.join(fdDirectory, name));
      if (link.endsWith(" (deleted)")) link = link.slice(0, -" (deleted)".length);
      if (link === targetPath) return `/proc/${bridgePid}/fd/${name}`;
    } catch {
      // fd closed concurrently
    }
  }
  return null;
}

async function appendOldInodeDelta(canonicalPath, bridgePid, originalSize) {
  // The running app-server keeps the pre-rename inode open and may append new
  // events while sanitization is in progress. Read the delta off that fd and
  // merge it into the sanitized file so no events are lost.
  const fdPath = openOldInodeFd(bridgePid, canonicalPath);
  if (!fdPath) return 0;
  let fdStat;
  let canonicalStat;
  try {
    fdStat = await fsp.stat(fdPath);
    canonicalStat = await fsp.stat(canonicalPath);
  } catch {
    return 0;
  }
  if (fdStat.ino === canonicalStat.ino) return 0;
  if (fdStat.size <= originalSize) return 0;
  const delta = Buffer.alloc(fdStat.size - originalSize);
  const fd = await fsp.open(fdPath, "r");
  try {
    await fd.read(delta, 0, delta.length, originalSize);
  } finally {
    await fd.close();
  }
  const tail = delta.toString("utf8").trimEnd();
  let valid = true;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      valid = false;
      break;
    }
  }
  if (!valid || delta.length === 0) return 0;
  const mergeStat = await fsp.stat(canonicalPath);
  let prefix = Buffer.alloc(0);
  if (mergeStat.size > 0) {
    const tail = Buffer.alloc(1);
    const handle = await fsp.open(canonicalPath, "r");
    try {
      await handle.read(tail, 0, 1, mergeStat.size - 1);
    } finally {
      await handle.close();
    }
    if (tail[0] !== 0x0a) prefix = Buffer.from("\n");
  }
  fs.appendFileSync(canonicalPath, Buffer.concat([prefix, delta]));
  return delta.length;
}

const options = parseArguments(process.argv.slice(2));
const filePath = path.resolve(options.file);
const logPath = path.resolve(options.log);
appendLog(logPath, `启动修复任务: ${filePath} (bridge pid ${options.bridgePid})`);

const stat = await waitForIdle(filePath, { maxWaitMs: options.maxWaitMs });
if (!stat) {
  appendLog(logPath, `等待超时（${Math.round(options.maxWaitMs / 1000)}s），线程仍活跃，放弃本次修复`);
  console.log("timeout");
  process.exit(3);
}

const backupName = `${path.basename(filePath)}.wfl-reasoning-bak-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const backupPath = path.join(path.dirname(filePath), backupName);
await fsp.copyFile(filePath, backupPath);
appendLog(logPath, `已备份到 ${backupPath}`);

const result = await sanitizeSessionFile(filePath, {
  expectedUid: typeof process.getuid === "function" ? process.getuid() : null,
  expectedGid: typeof process.getgid === "function" ? process.getgid() : null,
});
if (!result.sanitized) {
  appendLog(logPath, "文件无需清洗或清洗失败，撤销备份");
  await fsp.rm(backupPath, { force: true }).catch(() => {});
  console.log("noop");
  process.exit(0);
}
appendLog(logPath, `已清洗 ${result.reasoningItemsCleaned} 条明文推理`);

// 旧 inode 仍被 app-server 持有，合并清洗后新增的事件，再重启 app-server 让线程重新加载。
const mergedFromOldInode = await appendOldInodeDelta(filePath, options.bridgePid, result.bytesRead ?? 0);
if (mergedFromOldInode > 0) {
  appendLog(logPath, `从旧 inode 合并了 ${mergedFromOldInode} 字节清洗期间新事件`);
}

try {
  process.kill(options.bridgePid, "SIGTERM");
  appendLog(logPath, `已向 app-server pid ${options.bridgePid} 发送 SIGTERM，等待后端自动重启`);
} catch (error) {
  appendLog(logPath, `app-server 可能已退出，跳过重启: ${error.message}`);
}
console.log(JSON.stringify({ sanitized: true, reasoningItemsCleaned: result.reasoningItemsCleaned, mergedFromOldInode, backupPath }));
appendLog(logPath, "修复任务完成");
