import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const MAX_REFERENCES = 256;
const MAX_REFERENCE_BYTES = 1024 * 1024;

export class RescueReferenceStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.directory = path.join(path.resolve(stateDirectory), "rescue-references-v1");
    this.now = now;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    return this;
  }

  async create({
    sourceThreadId,
    sourceTitle,
    sourceCwd,
    sourceVersion,
    sourceUpdatedAt,
    turns,
  } = {}) {
    const normalizedTurns = normalizeTurns(turns);
    if (!normalizedTurns.length) throw new Error("主站对话没有可引用的消息");
    const current = await this.list();
    if (current.length >= MAX_REFERENCES) throw new Error("主站只读引用数量已达到上限");
    const createdAt = this.now();
    const id = referenceId(createdAt);
    const content = normalizedTurns.map((turn) => ({
      turnId: turn.turnId,
      ordinal: turn.ordinal,
      text: turn.text,
    }));
    const contentHash = hash({ sourceThreadId, content });
    const record = {
      version: STORE_VERSION,
      id,
      createdAt,
      updatedAt: createdAt,
      readOnly: true,
      source: {
        surface: "main",
        threadId: normalizeText(sourceThreadId, 512, "主站对话 ID"),
        title: normalizeText(sourceTitle || "未命名主站对话", 512, "主站对话标题"),
        cwd: normalizeText(sourceCwd || "未指定工程", 4096, "主站工程路径"),
        version: normalizeText(sourceVersion || "unknown", 128, "主站版本"),
        updatedAt: Number.isFinite(Number(sourceUpdatedAt)) ? Number(sourceUpdatedAt) : null,
        turnIds: content.map((turn) => turn.turnId),
      },
      content,
      contentHash,
    };
    await this.#write(record);
    return publicReference(record, true);
  }

  async list() {
    const names = await fs.readdir(this.directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = [];
    for (const name of names.filter((entry) => /^REF-[0-9]{8}-[A-Z0-9]{8}\.json$/u.test(entry))) {
      try {
        const record = await this.#read(name.slice(0, -5));
        records.push(publicReference(record, false));
      } catch {
        // A partial or tampered reference is never exposed to the browser.
      }
    }
    return records.sort((left, right) => right.createdAt - left.createdAt);
  }

  async read(id) {
    const record = await this.#read(id);
    return publicReference(record, true);
  }

  async remove(id) {
    const normalized = normalizeReferenceId(id);
    await fs.rm(path.join(this.directory, `${normalized}.json`), { force: true });
    return { id: normalized, removed: true };
  }

  async #read(id) {
    const normalized = normalizeReferenceId(id);
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(this.directory, `${normalized}.json`), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw notFoundError();
      throw new Error("主站只读引用无法读取");
    }
    assertRecord(parsed, normalized);
    return parsed;
  }

  async #write(record) {
    const destination = path.join(this.directory, `${record.id}.json`);
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function publicReference(record, includeContent) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    readOnly: true,
    source: { ...record.source, turnIds: [...record.source.turnIds] },
    messageCount: record.content.length,
    contentHash: record.contentHash,
    ...(includeContent ? { content: record.content.map((entry) => ({ ...entry })) } : {}),
  };
}

function normalizeTurns(turns) {
  if (!Array.isArray(turns) || turns.length > 100) throw new Error("主站引用消息范围无效");
  const normalized = turns.map((turn, index) => {
    const turnId = normalizeText(turn?.turnId || `turn-${index + 1}`, 512, "引用消息 ID");
    const text = normalizeText(turn?.text, 100_000, "引用消息内容", { allowLineBreaks: true });
    if (!text.trim()) return null;
    return {
      turnId,
      ordinal: Number.isSafeInteger(turn?.ordinal) && turn.ordinal >= 0 ? turn.ordinal : index,
      text: text.trim(),
    };
  }).filter(Boolean);
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes > MAX_REFERENCE_BYTES) throw new Error("单条主站引用不能超过 1 MB");
  return normalized;
}

function assertRecord(record, expectedId) {
  if (
    !record
    || record.version !== STORE_VERSION
    || record.id !== expectedId
    || record.readOnly !== true
    || !record.source
    || !Array.isArray(record.content)
    || typeof record.contentHash !== "string"
    || hash({ sourceThreadId: record.source.threadId, content: record.content }) !== record.contentHash
  ) throw new Error("主站只读引用校验失败");
  normalizeReferenceId(record.id);
  normalizeText(record.source.threadId, 512, "主站对话 ID");
  normalizeTurns(record.content);
}

function normalizeReferenceId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^REF-[0-9]{8}-[A-Z0-9]{8}$/u.test(id)) {
    const error = notFoundError();
    throw error;
  }
  return id;
}

function normalizeText(value, maxLength, label, { allowLineBreaks = false } = {}) {
  const invalidControl = allowLineBreaks ? /[\u0000]/u : /[\u0000\r\n]/u;
  if (typeof value !== "string" || !value || value.length > maxLength || invalidControl.test(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function referenceId(timestamp) {
  const date = new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
  return `REF-${date}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function notFoundError() {
  const error = new Error("主站只读引用不存在");
  error.code = "ERR_RESCUE_REFERENCE_NOT_FOUND";
  error.statusCode = 404;
  return error;
}
