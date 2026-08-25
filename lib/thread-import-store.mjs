import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const THREAD_IMPORT_LIMIT_BYTES = 5 * 1024 * 1024;
export const THREAD_IMPORT_TEXT_LIMIT_BYTES = 4 * 1024 * 1024;
export const THREAD_IMPORT_MAX_TURNS = 1_000;
export const THREAD_IMPORT_MAX_ITEMS = 4_000;
export const THREAD_IMPORT_MAX_ITEM_BYTES = 128 * 1024;

const IMPORT_ID_PATTERN = /^import_[a-f0-9]{32}$/;
const ITEM_TYPES = new Set(["user", "assistant", "reasoning", "plan"]);
const MAX_RECORDS = 100;
const MAX_STORED_BYTES = 50 * 1024 * 1024;
const WORKSPACE_MAX_RECORDS = 10_000;
const WORKSPACE_MAX_STORED_BYTES = 2 * 1024 * 1024 * 1024;
const WORKSPACE_LIMITS = Object.freeze({
  turns: 10_000,
  items: 50_000,
  itemBytes: 2 * 1024 * 1024,
  textBytes: 128 * 1024 * 1024,
});
const INTERACTIVE_LIMITS = Object.freeze({
  turns: THREAD_IMPORT_MAX_TURNS,
  items: THREAD_IMPORT_MAX_ITEMS,
  itemBytes: THREAD_IMPORT_MAX_ITEM_BYTES,
  textBytes: THREAD_IMPORT_TEXT_LIMIT_BYTES,
});

export function isImportedThreadId(value) {
  return IMPORT_ID_PATTERN.test(String(value));
}

export class ThreadImportStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.directory = path.join(stateDirectory, "thread-imports");
    this.indexPath = path.join(this.directory, "index.json");
    this.now = now;
    this.records = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
      this.records = (Array.isArray(value?.records) ? value.records : [])
        .map(normalizeStoredMetadata)
        .filter(Boolean)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, WORKSPACE_MAX_RECORDS);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.records = [];
    }
    return this;
  }

  snapshot() {
    return this.records.map(copyMetadata);
  }

  get(id) {
    const record = this.records.find((entry) => entry.id === id);
    return record ? copyMetadata(record) : null;
  }

  findByCodexThreadId(threadId) {
    const record = this.records.find((entry) => entry.codexThreadId === threadId);
    return record ? copyMetadata(record) : null;
  }

  async read(id) {
    const record = this.get(id);
    if (!record) return null;
    try {
      const value = JSON.parse(await fs.readFile(this.dataPath(id), "utf8"));
      const transcript = normalizeThreadImport(value, { preserveName: true, profile: "workspace" });
      return { ...record, turns: transcript.turns };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async create({ name, cwd, turns, codexThreadId }) {
    return this.createRecord({ name, cwd, turns, codexThreadId }, { profile: "interactive" });
  }

  async createMigration({ name, cwd, turns, codexThreadId, createdAt, updatedAt, archived = false }) {
    return this.createRecord(
      { name, cwd, turns, codexThreadId, createdAt, updatedAt, archived },
      { profile: "workspace" },
    );
  }

  async createRecord(input, { profile }) {
    const workspace = profile === "workspace";
    const transcript = normalizeThreadImport(
      { name: input.name, turns: input.turns },
      { preserveName: true, profile: workspace ? "workspace" : "interactive" },
    );
    const sizeBytes = Buffer.byteLength(JSON.stringify({ name: transcript.name, turns: transcript.turns }));
    const storedBytes = this.records.reduce((total, record) => total + record.sizeBytes, 0);
    const recordLimit = workspace ? WORKSPACE_MAX_RECORDS : MAX_RECORDS;
    const byteLimit = workspace ? WORKSPACE_MAX_STORED_BYTES : MAX_STORED_BYTES;
    if (this.records.length >= recordLimit) {
      throw importError(409, workspace ? "工作区对话数量已达到 10000 个" : "导入对话数量已达到 100 个，请先删除不再需要的导入记录");
    }
    if (storedBytes + sizeBytes > byteLimit) {
      throw importError(413, workspace ? "工作区迁移对话占用不能超过 2 GB" : "导入对话占用已达到 50 MB，请先删除不再需要的导入记录");
    }

    const now = Math.floor(this.now() / 1_000);
    const id = `import_${crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = normalizeStoredMetadata({
      id,
      codexThreadId: input.codexThreadId,
      cwd: input.cwd,
      name: transcript.name,
      preview: firstMessagePreview(transcript.turns),
      createdAt: workspace ? normalizeTimestamp(input.createdAt, now) : now,
      updatedAt: workspace ? normalizeTimestamp(input.updatedAt, now) : now,
      archived: workspace && input.archived === true,
      materialized: false,
      convertedAt: null,
      turnCount: transcript.turns.length,
      itemCount: transcript.turns.reduce((total, turn) => total + turn.items.length, 0),
      sizeBytes,
    });
    if (!metadata) throw importError(400, "导入对话元数据无效");

    await this.enqueue(async () => {
      await writeJsonAtomic(this.dataPath(id), { version: 1, name: transcript.name, turns: transcript.turns });
      this.records = [metadata, ...this.records];
      await this.persistIndex();
    });
    return copyMetadata(metadata);
  }

  async update(id, changes) {
    let updated = null;
    await this.enqueue(async () => {
      const current = this.records.find((entry) => entry.id === id);
      if (!current) return;
      if (current.materialized) throw importError(409, "迁移快照为只读恢复副本");
      const next = normalizeStoredMetadata({
        ...current,
        ...(Object.hasOwn(changes, "codexThreadId") ? { codexThreadId: changes.codexThreadId } : {}),
        ...(Object.hasOwn(changes, "materialized") ? { materialized: changes.materialized } : {}),
        ...(Object.hasOwn(changes, "convertedAt") ? { convertedAt: changes.convertedAt } : {}),
        ...(Object.hasOwn(changes, "archived") ? { archived: changes.archived } : {}),
        ...(Object.hasOwn(changes, "name") ? { name: normalizeName(changes.name) } : {}),
        updatedAt: Number.isFinite(changes.updatedAt) ? changes.updatedAt : Math.floor(this.now() / 1_000),
      });
      if (!next) throw importError(400, "导入对话更新无效");
      this.records = this.records.map((entry) => entry.id === id ? next : entry)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      await this.persistIndex();
      updated = next;
    });
    return updated ? copyMetadata(updated) : null;
  }

  async remove(id) {
    if (!IMPORT_ID_PATTERN.test(String(id))) return false;
    const record = this.records.find((entry) => entry.id === id);
    if (!record) return false;
    if (record.materialized) throw importError(409, "迁移快照为只读恢复副本");
    await this.enqueue(async () => {
      this.records = this.records.filter((entry) => entry.id !== id);
      await Promise.all([
        fs.rm(this.dataPath(id), { force: true }),
        this.persistIndex(),
      ]);
    });
    return true;
  }

  dataPath(id) {
    if (!isImportedThreadId(id)) throw importError(400, "导入对话 ID 无效");
    return path.join(this.directory, `${id}.json`);
  }

  async persistIndex() {
    await writeJsonAtomic(this.indexPath, { version: 1, records: this.records });
  }

  async enqueue(operation) {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }
}

export function parseThreadImport(content, { filename = "", contentType = "" } = {}) {
  if (!Buffer.isBuffer(content)) content = Buffer.from(content || "");
  if (!content.length) throw importError(400, "导入文件为空");
  if (content.length > THREAD_IMPORT_LIMIT_BYTES) throw importError(413, "对话导入文件不能超过 5 MB");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw importError(415, "导入文件必须是 UTF-8 文本");
  }
  text = text.replace(/^\uFEFF/, "");
  const json = /\.json$/i.test(filename) || /application\/json/i.test(contentType) || /^\s*[{[]/.test(text);
  if (json) {
    try {
      return normalizeThreadImport(JSON.parse(text));
    } catch (error) {
      if (error?.statusCode) throw error;
      throw importError(400, "JSON 对话文件格式无效");
    }
  }
  return normalizeThreadImport(parseThreadMarkdown(text));
}

export function normalizeThreadImport(value, { preserveName = false, profile = "interactive" } = {}) {
  const limits = profile === "workspace" ? WORKSPACE_LIMITS : INTERACTIVE_LIMITS;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw importError(400, "对话文件结构无效");
  if (!Array.isArray(value.turns) || !value.turns.length) throw importError(400, "对话文件中没有可导入的记录");
  if (value.turns.length > limits.turns) throw importError(413, `导入对话不能超过 ${limits.turns} 轮`);

  const turns = [];
  let itemCount = 0;
  let textBytes = 0;
  for (const sourceTurn of value.turns) {
    if (!sourceTurn || typeof sourceTurn !== "object" || !Array.isArray(sourceTurn.items)) continue;
    const items = [];
    for (const sourceItem of sourceTurn.items) {
      const type = String(sourceItem?.type || "").trim().toLowerCase();
      if (!ITEM_TYPES.has(type)) continue;
      const text = typeof sourceItem.text === "string" ? sourceItem.text.replaceAll("\u0000", "") : "";
      const bytes = Buffer.byteLength(text);
      if (!text.trim()) continue;
      if (bytes > limits.itemBytes) throw importError(413, `单条对话内容不能超过 ${Math.round(limits.itemBytes / 1024)} KB`);
      textBytes += bytes;
      itemCount += 1;
      if (textBytes > limits.textBytes) throw importError(413, `导入对话文本总量不能超过 ${Math.round(limits.textBytes / 1024 / 1024)} MB`);
      if (itemCount > limits.items) throw importError(413, `导入对话不能超过 ${limits.items} 条内容`);
      items.push({ type, text });
    }
    if (items.length) turns.push({ items });
  }
  if (!turns.length || !turns.some((turn) => turn.items.some((item) => item.type === "user" || item.type === "assistant"))) {
    throw importError(400, "对话文件中没有用户或 Codex 消息");
  }
  return {
    name: normalizeName(value.name, preserveName ? "导入的对话" : importNameFromValue(value)),
    turns,
  };
}

export function importedThreadSummary(record) {
  return {
    id: record.id,
    cwd: record.cwd,
    name: record.name,
    preview: record.preview,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    source: "appServer",
    status: { type: "idle" },
    imported: true,
    readOnlySnapshot: record.materialized === true,
    archived: record.archived,
    turns: [],
  };
}

export function importedTurns(transcript) {
  return transcript.turns.map((turn, turnIndex) => ({
    id: `${transcript.id}-turn-${turnIndex + 1}`,
    status: "completed",
    _displayCreatedAt: transcript.createdAt,
    items: turn.items.map((item, itemIndex) => ({
      id: `${transcript.id}-item-${turnIndex + 1}-${itemIndex + 1}`,
      ...(item.type === "user" ? { type: "userMessage", content: [{ type: "text", text: item.text }] } : {}),
      ...(item.type === "assistant" ? { type: "agentMessage", text: item.text } : {}),
      ...(item.type === "reasoning" ? { type: "reasoning", summary: [item.text] } : {}),
      ...(item.type === "plan" ? { type: "plan", text: item.text } : {}),
    })),
  }));
}

export function importedModelItems(transcript) {
  return transcript.turns.flatMap((turn) => turn.items.flatMap((item) => {
    if (item.type === "user") {
      return [{ type: "message", role: "user", content: [{ type: "input_text", text: item.text }] }];
    }
    if (item.type === "assistant") {
      return [{ type: "message", role: "assistant", content: [{ type: "output_text", text: item.text }] }];
    }
    return [];
  }));
}

function parseThreadMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const title = lines.find((line) => /^# (?!#)/.test(line))?.replace(/^# /, "").trim();
  const turns = [];
  let currentTurn = null;
  let currentItem = null;
  const flushItem = () => {
    if (!currentItem) return;
    currentItem.text = currentItem.lines.join("\n").trim();
    delete currentItem.lines;
    if (currentItem.text) currentTurn.items.push(currentItem);
    currentItem = null;
  };
  const flushTurn = () => {
    flushItem();
    if (currentTurn?.items.length) turns.push(currentTurn);
    currentTurn = null;
  };
  const headings = new Map([["用户", "user"], ["codex", "assistant"], ["reasoning", "reasoning"], ["plan", "plan"]]);
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    const type = match ? headings.get(match[1].toLowerCase()) || headings.get(match[1]) : null;
    if (!type) {
      if (currentItem) currentItem.lines.push(line);
      continue;
    }
    flushItem();
    if (type === "user" || !currentTurn) flushTurn();
    currentTurn ||= { items: [] };
    currentItem = { type, lines: [] };
  }
  flushTurn();
  return { name: title || "导入的对话", turns };
}

function importNameFromValue(value) {
  return typeof value.name === "string" ? value.name : "导入的对话";
}

function normalizeName(value, fallback = "导入的对话") {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (name || fallback).slice(0, 200);
}

function firstMessagePreview(turns) {
  const item = turns.flatMap((turn) => turn.items).find((entry) => entry.type === "user" || entry.type === "assistant");
  return String(item?.text || "导入的对话").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeTimestamp(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number > 10_000_000_000 ? number / 1_000 : number);
}

function normalizeStoredMetadata(value) {
  const id = String(value?.id || "");
  const codexThreadId = String(value?.codexThreadId || "");
  const cwd = path.resolve(String(value?.cwd || ""));
  const createdAt = Number(value?.createdAt);
  const updatedAt = Number(value?.updatedAt);
  if (!IMPORT_ID_PATTERN.test(id) || !codexThreadId || codexThreadId.length > 256) return null;
  if (!path.isAbsolute(String(value?.cwd || "")) || cwd.length > 4096) return null;
  if (![createdAt, updatedAt].every((entry) => Number.isFinite(entry) && entry > 0)) return null;
  if (![value.turnCount, value.itemCount, value.sizeBytes].every((entry) => Number.isSafeInteger(entry) && entry >= 0)) return null;
  return {
    id,
    codexThreadId,
    cwd,
    name: normalizeName(value.name),
    preview: String(value.preview || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240),
    createdAt,
    updatedAt,
    archived: value.archived === true,
    materialized: value.materialized === true,
    convertedAt: normalizeOptionalTimestamp(value.convertedAt),
    turnCount: value.turnCount,
    itemCount: value.itemCount,
    sizeBytes: value.sizeBytes,
  };
}

function normalizeOptionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function copyMetadata(record) {
  return { ...record };
}

function importError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}
