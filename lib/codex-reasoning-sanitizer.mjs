import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_SESSION_SCAN_FILES = 4_000;
const MAX_SESSION_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const PLAINTEXT_REASONING_MARKER = '"reasoning_text"';
const REASONING_CONTENT_TYPES = new Set(["reasoning_text", "text"]);

export class ReasoningSanitizerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sanitizerError(code, message) {
  return new ReasoningSanitizerError(code, message);
}

function boundedPath(value, label) {
  if (typeof value !== "string" || !value) throw sanitizerError("ERR_SANITIZE_PATH", `${label} 必须是非空路径`);
  return path.resolve(value);
}

async function statRegularFile(filePath, { expectedUid = null, expectedGid = null } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw sanitizerError("ERR_SESSION_MISSING", "会话文件不存在");
    throw sanitizerError("ERR_SESSION_STAT", `无法读取会话文件: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw sanitizerError("ERR_SESSION_TYPE", "会话文件必须是普通文件");
  }
  if ((stat.mode & 0o022) !== 0) {
    throw sanitizerError("ERR_SESSION_MODE", "会话文件权限必须禁止组/其他写入");
  }
  if (Number.isInteger(expectedUid) && stat.uid !== expectedUid) {
    throw sanitizerError("ERR_SESSION_OWNER", "会话文件属主与当前账号不一致");
  }
  if (Number.isInteger(expectedGid) && stat.gid !== expectedGid) {
    throw sanitizerError("ERR_SESSION_GROUP", "会话文件属组与当前账号不一致");
  }
  return stat;
}

async function walkSessionFiles(sessionsRoot) {
  const results = [];
  const pending = [sessionsRoot];
  while (pending.length > 0 && results.length <= MAX_SESSION_SCAN_FILES) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return results;
      throw sanitizerError("ERR_SESSION_SCAN", `无法扫描会话目录: ${error.message}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
      } else if (
        entry.isFile()
        && entry.name.startsWith("rollout-")
        && entry.name.endsWith(".jsonl")
      ) {
        results.push(path.join(directory, entry.name));
      }
    }
  }
  return results;
}

export async function sessionFileForThread(sessionsRoot, threadId) {
  const root = boundedPath(sessionsRoot, "会话根目录");
  if (typeof threadId !== "string" || !threadId || /[^\w-]/.test(threadId)) {
    throw sanitizerError("ERR_SESSION_THREAD_ID", "对话 ID 无效");
  }
  const files = await walkSessionFiles(root);
  const match = files.find((file) => path.basename(file).includes(threadId));
  return match ? path.resolve(match) : null;
}

export async function sessionFileContainsPlaintextReasoning(filePath) {
  const resolved = boundedPath(filePath, "会话文件");
  const stat = await fsp.stat(resolved);
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    throw sanitizerError("ERR_SESSION_TOO_LARGE", "会话文件过大，跳过清洗");
  }
  let found = false;
  const stream = fs.createReadStream(resolved, { highWaterMark: 256 * 1024 });
  let tail = "";
  try {
    for await (const chunk of stream) {
      const text = chunk.toString("utf8");
      if (text.includes(PLAINTEXT_REASONING_MARKER) || tail.includes(PLAINTEXT_REASONING_MARKER)) {
        found = true;
        break;
      }
      tail = text;
    }
  } finally {
    stream.destroy();
  }
  return found;
}

function cleanReasoningItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (item.type !== "reasoning" && item.payload?.type !== "reasoning") return false;
  const content = item.type === "reasoning" ? item.content : item.payload.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  const hasPlaintext = content.some((part) => (
    part && typeof part === "object" && REASONING_CONTENT_TYPES.has(part.type)
  ));
  if (!hasPlaintext) return false;
  if (item.type === "reasoning") item.content = [];
  else item.payload.content = [];
  return true;
}

export async function sanitizeSessionFile(
  filePath,
  {
    expectedUid = null,
    expectedGid = null,
    backupDirectory = null,
    dryRun = false,
  } = {},
) {
  const resolved = boundedPath(filePath, "会话文件");
  const stat = await statRegularFile(resolved, { expectedUid, expectedGid });
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    throw sanitizerError("ERR_SESSION_TOO_LARGE", "会话文件过大，拒绝清洗");
  }
  const backupName = `${path.basename(resolved)}.wfl-reasoning-bak-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const backupPath = backupDirectory
    ? path.join(boundedPath(backupDirectory, "清洗备份目录"), backupName)
    : path.join(path.dirname(resolved), backupName);
  const temporaryPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.wfl-sanitize-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`,
  );

  const endsWithNewline = await fileEndsWithNewline(resolved, stat.size);
  const counter = { bytes: 0 };
  const input = fs.createReadStream(resolved, { highWaterMark: 4 * 1024 * 1024 });
  const output = dryRun ? null : fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  let cleaned = 0;
  let lineCount = 0;
  let outputBytes = 0;
  try {
    for await (const line of sessionLines(input, counter)) {
      lineCount += 1;
      let outputLine = line;
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          if (cleanReasoningItem(event)) {
            cleaned += 1;
            outputLine = JSON.stringify(event);
          }
        } catch {
          // keep malformed lines byte-identical
        }
      }
      const text = `${outputLine}\n`;
      outputBytes += Buffer.byteLength(text, "utf8");
      if (output && !(await writeChunk(output, text))) {
        throw sanitizerError("ERR_SESSION_WRITE", "清洗输出写入失败");
      }
    }
    if (output) await endStream(output);
  } finally {
    input.destroy();
    if (output) output.destroy();
  }
  if (lineCount > 0 && !endsWithNewline) {
    outputBytes = Math.max(0, outputBytes - 1);
    if (output) await truncateLastByte(temporaryPath);
  }
  if (cleaned === 0) {
    if (output) await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    return {
      sanitized: false,
      reasoningItemsCleaned: 0,
      bytesBefore: stat.size,
      bytesAfter: stat.size,
      bytesRead: counter.bytes,
      lineCount,
      backupPath: null,
    };
  }
  if (dryRun) {
    return {
      sanitized: true,
      dryRun,
      reasoningItemsCleaned: cleaned,
      bytesBefore: stat.size,
      bytesAfter: outputBytes,
      bytesRead: counter.bytes,
      lineCount,
      backupPath: null,
    };
  }
  try {
    if (backupDirectory) await fsp.mkdir(path.dirname(backupPath), { recursive: true });
    await fsp.copyFile(resolved, backupPath, fs.constants.COPYFILE_EXCL);
    const handle = await fsp.open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (Number.isInteger(expectedUid) && Number.isInteger(expectedGid)) {
      await fsp.chown(temporaryPath, expectedUid, expectedGid);
    } else {
      await fsp.chmod(temporaryPath, stat.mode & 0o777);
    }
    await fsp.rename(temporaryPath, resolved);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw sanitizerError("ERR_SESSION_REWRITE", `会话文件清洗失败: ${error.message}`);
  }
  return {
    sanitized: true,
    reasoningItemsCleaned: cleaned,
    bytesBefore: stat.size,
    bytesAfter: outputBytes,
    bytesRead: counter.bytes,
    lineCount,
    backupPath,
  };
}

async function fileEndsWithNewline(filePath, size) {
  if (size <= 0) return false;
  const handle = await fsp.open(filePath, "r");
  try {
    const tail = Buffer.alloc(1);
    const read = await handle.read(tail, 0, 1, size - 1);
    return read.bytesRead === 1 && tail[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

async function writeChunk(stream, text) {
  if (stream.write(text)) return true;
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    stream.once("error", onError);
    stream.once("drain", onDrain);
  });
}

async function truncateLastByte(filePath) {
  const handle = await fsp.open(filePath, "r+");
  try {
    const size = (await handle.stat()).size;
    if (size > 0) await handle.truncate(size - 1);
  } finally {
    await handle.close();
  }
}

async function endStream(stream) {
  if (stream.writableEnded) return;
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end((error) => {
      stream.off("error", reject);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function* sessionLines(input, counter) {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  for await (const chunk of input) {
    counter.bytes += chunk.byteLength;
    carry += decoder.write(chunk);
    let index;
    while ((index = carry.indexOf("\n")) !== -1) {
      yield carry.slice(0, index);
      carry = carry.slice(index + 1);
    }
  }
  const tail = carry + decoder.end();
  if (tail) yield tail;
}

export function isPathOpenByPid(filePath, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const target = boundedPath(filePath, "会话文件");
  let realTarget = null;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return false;
  }
  const fdDirectory = `/proc/${pid}/fd`;
  let names;
  try {
    names = fs.readdirSync(fdDirectory);
  } catch {
    return false;
  }
  for (const name of names) {
    try {
      const link = fs.readlinkSync(path.join(fdDirectory, name));
      if (link === target || link === realTarget) return true;
      if (path.isAbsolute(link)) {
        try {
          if (fs.realpathSync(link) === realTarget) return true;
        } catch {
          // stale fd target
        }
      }
    } catch {
      // fd closed concurrently
    }
  }
  return false;
}

export async function sanitizeThreadReasoningContent({
  codexHome,
  threadId,
  expectedUid = null,
  expectedGid = null,
  backupDirectory = null,
  bridgePid = null,
  dryRun = false,
}) {
  const home = boundedPath(codexHome, "Codex 主目录");
  const sessionsRoot = path.join(home, "sessions");
  const filePath = await sessionFileForThread(sessionsRoot, threadId);
  if (!filePath) return { found: false, sanitized: false, reasoningItemsCleaned: 0 };
  if (bridgePid && isPathOpenByPid(filePath, bridgePid)) {
    return { found: true, locked: true, sanitized: false, reasoningItemsCleaned: 0 };
  }
  const needsSanitizing = await sessionFileContainsPlaintextReasoning(filePath);
  if (!needsSanitizing) return { found: true, sanitized: false, reasoningItemsCleaned: 0 };
  const result = await sanitizeSessionFile(filePath, {
    expectedUid,
    expectedGid,
    backupDirectory,
    dryRun,
  });
  return { found: true, ...result };
}
