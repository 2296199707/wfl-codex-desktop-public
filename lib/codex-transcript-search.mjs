import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stripCollaborationStrategyUserPrefix } from "./codex-policy.mjs";

const SEARCH_CURSOR_PATTERN = /^wfl-native-search-v1-(\d+)$/;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_OCCURRENCES = 1_000;

export function isCodexTranscriptSearchCursor(value) {
  return typeof value === "string" && SEARCH_CURSOR_PATTERN.test(value);
}

export async function searchCodexTranscriptOccurrences({
  codexHome,
  filePath,
  threadId,
  searchTerm,
  cursor = null,
  limit = 50,
}) {
  const transcriptPath = await validatedTranscriptPath(codexHome, filePath, threadId);
  const offset = transcriptSearchOffset(cursor);
  const query = searchTerm.toLocaleLowerCase();
  const results = [];
  let totalMatches = 0;
  let currentTurnId = null;
  let searchableItemOrdinal = 0;
  const input = fs.createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"type":"event_msg"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event?.payload;
      if (payload?.type === "task_started" && validIdentifier(payload.turn_id)) {
        currentTurnId = payload.turn_id;
        searchableItemOrdinal = 0;
        continue;
      }
      if (!currentTurnId || !["user_message", "agent_message"].includes(payload?.type)) continue;
      const rawText = typeof payload.message === "string" ? payload.message : "";
      const itemType = payload.type === "user_message" ? "userMessage" : "agentMessage";
      const text = itemType === "userMessage"
        ? stripCollaborationStrategyUserPrefix(rawText).text
        : rawText;
      const itemOrdinal = searchableItemOrdinal++;
      if (!text) continue;
      const lower = text.toLocaleLowerCase();
      let matchIndex = lower.indexOf(query);
      while (matchIndex >= 0 && totalMatches < MAX_OCCURRENCES) {
        if (totalMatches >= offset && results.length <= limit) {
          const snippetStart = Math.max(0, matchIndex - 120);
          const snippetEnd = Math.min(text.length, matchIndex + searchTerm.length + 180);
          results.push({
            turnId: currentTurnId,
            itemId: `wfl-native-item-${currentTurnId}-${itemOrdinal}`,
            itemType,
            itemOrdinal,
            snippet: text.slice(snippetStart, snippetEnd),
            snippetMatchRange: {
              start: matchIndex - snippetStart,
              end: matchIndex - snippetStart + searchTerm.length,
            },
            turnCursor: JSON.stringify({ turnId: currentTurnId, includeAnchor: true }),
          });
        }
        totalMatches += 1;
        if (results.length > limit) break;
        matchIndex = lower.indexOf(query, matchIndex + Math.max(1, query.length));
      }
      if (results.length > limit || totalMatches >= MAX_OCCURRENCES) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  const hasMore = results.length > limit;
  return {
    data: results.slice(0, limit),
    nextCursor: hasMore ? `wfl-native-search-v1-${offset + limit}` : null,
  };
}

async function validatedTranscriptPath(codexHome, filePath, threadId) {
  if (typeof codexHome !== "string" || typeof filePath !== "string") {
    throw searchError("Codex 对话文件不可用", "ERR_CODEX_TRANSCRIPT_PATH");
  }
  if (!validIdentifier(threadId)) {
    throw searchError("Codex 对话 ID 无效", "ERR_CODEX_TRANSCRIPT_PATH");
  }
  const sessionsRoot = await fsp.realpath(path.join(codexHome, "sessions"));
  const resolved = await fsp.realpath(filePath);
  if (!pathWithin(sessionsRoot, resolved) || !resolved.endsWith(".jsonl")) {
    throw searchError("Codex 对话文件不在账号会话目录中", "ERR_CODEX_TRANSCRIPT_PATH");
  }
  const info = await fsp.stat(resolved);
  if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) {
    throw searchError("Codex 对话文件不可检索", "ERR_CODEX_TRANSCRIPT_PATH");
  }
  const firstLine = await readFirstLine(resolved);
  let metadata;
  try {
    metadata = JSON.parse(firstLine);
  } catch {
    throw searchError("Codex 对话文件头无效", "ERR_CODEX_TRANSCRIPT_PATH");
  }
  const metadataThreadId = metadata?.payload?.session_id || metadata?.payload?.id;
  if (metadata?.type !== "session_meta" || metadataThreadId !== threadId) {
    throw searchError("Codex 对话文件与当前对话不匹配", "ERR_CODEX_TRANSCRIPT_PATH");
  }
  return resolved;
}

function transcriptSearchOffset(cursor) {
  if (cursor == null || cursor === "") return 0;
  const match = SEARCH_CURSOR_PATTERN.exec(cursor);
  const offset = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_OCCURRENCES) {
    throw searchError("对话搜索分页位置无效", "ERR_CODEX_TRANSCRIPT_CURSOR");
  }
  return offset;
}

async function readFirstLine(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) throw searchError("Codex 对话文件头过长", "ERR_CODEX_TRANSCRIPT_PATH");
    return text.slice(0, newline);
  } finally {
    await handle.close();
  }
}

function pathWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function validIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000\r\n]/.test(value);
}

function searchError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
