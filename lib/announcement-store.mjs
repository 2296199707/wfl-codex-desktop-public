import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;
const CATEGORIES = new Set(["notice", "update", "maintenance"]);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AnnouncementStore {
  constructor(stateDirectory, { now = () => Date.now(), createId = () => crypto.randomUUID() } = {}) {
    this.filePath = path.join(path.resolve(stateDirectory), "announcement.json");
    this.now = now;
    this.createId = createId;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.data = await readState(this.filePath);
    return this;
  }

  snapshot({ includeDraft = false } = {}) {
    this.assertInitialized();
    return {
      published: this.data.published ? structuredClone(this.data.published) : null,
      ...(includeDraft ? { draft: this.data.draft ? structuredClone(this.data.draft) : null } : {}),
    };
  }

  async saveDraft(input) {
    const content = normalizeContent(input);
    return this.mutate(async () => {
      this.data.draft = { ...content, updatedAt: this.now() };
      await this.write();
      return this.snapshot({ includeDraft: true });
    });
  }

  async publish(input) {
    const content = normalizeContent(input);
    return this.mutate(async () => {
      const publishedAt = this.now();
      this.data.draft = { ...content, updatedAt: publishedAt };
      this.data.published = {
        id: this.createId(),
        ...content,
        publishedAt,
      };
      await this.write();
      return this.snapshot({ includeDraft: true });
    });
  }

  async unpublish() {
    return this.mutate(async () => {
      this.data.published = null;
      await this.write();
      return this.snapshot({ includeDraft: true });
    });
  }

  async write() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  mutate(operation) {
    this.assertInitialized();
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.data) throw new Error("Announcement store is not initialized");
  }
}

function normalizeContent(value) {
  const title = normalizeTitle(value?.title);
  const body = normalizeBody(value?.body);
  const category = CATEGORIES.has(value?.category) ? value.category : "notice";
  if (!title) throw storeError(400, "公告标题不能为空");
  if (!body) throw storeError(400, "公告内容不能为空");
  if (title.length > 80) throw storeError(400, "公告标题不能超过 80 个字符");
  if (body.length > 4_000) throw storeError(400, "公告内容不能超过 4000 个字符");
  return { title, body, category };
}

async function readState(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (value?.version !== STORE_VERSION) return defaultState();
    return {
      version: STORE_VERSION,
      draft: normalizeStoredDraft(value.draft),
      published: normalizeStoredPublished(value.published),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return defaultState();
    throw error;
  }
}

function normalizeStoredDraft(value) {
  if (!value) return null;
  try {
    const content = normalizeContent(value);
    const updatedAt = timestamp(value.updatedAt);
    return updatedAt ? { ...content, updatedAt } : null;
  } catch {
    return null;
  }
}

function normalizeStoredPublished(value) {
  if (!value || !ID_PATTERN.test(String(value.id || ""))) return null;
  try {
    const content = normalizeContent(value);
    const publishedAt = timestamp(value.publishedAt);
    return publishedAt ? { id: value.id, ...content, publishedAt } : null;
  } catch {
    return null;
  }
}

function normalizeTitle(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function normalizeBody(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()
    : "";
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function defaultState() {
  return { version: STORE_VERSION, draft: null, published: null };
}

function storeError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
