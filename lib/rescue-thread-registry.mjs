import fs from "node:fs/promises";
import path from "node:path";

const REGISTRY_VERSION = 1;
const MAX_THREAD_IDS = 10_000;

/**
 * The rescue Codex home is physically separate from the main Codex home, but
 * keeping an explicit registry gives the HTTP/RPC boundary a second, durable
 * ownership check.  A stale main-site id therefore cannot be resumed merely
 * because a browser kept it in localStorage.
 */
export class RescueThreadRegistry {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.directory = path.join(path.resolve(stateDirectory), "rescue-thread-registry-v1");
    this.file = path.join(this.directory, "threads.json");
    this.now = now;
    this.ids = new Set();
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (parsed?.version === REGISTRY_VERSION && Array.isArray(parsed.threadIds)) {
        this.ids = new Set(parsed.threadIds.filter(validThreadId).slice(-MAX_THREAD_IDS));
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.ids.clear();
    }
    return this;
  }

  has(threadId) {
    return validThreadId(threadId) && this.ids.has(threadId);
  }

  snapshot() {
    return [...this.ids];
  }

  async add(threadId) {
    assertThreadId(threadId);
    if (this.ids.has(threadId)) return false;
    this.ids.add(threadId);
    while (this.ids.size > MAX_THREAD_IDS) this.ids.delete(this.ids.values().next().value);
    await this.#persist();
    return true;
  }

  async addMany(threadIds) {
    let changed = false;
    for (const threadId of threadIds || []) {
      if (!validThreadId(threadId) || this.ids.has(threadId)) continue;
      this.ids.add(threadId);
      changed = true;
    }
    while (this.ids.size > MAX_THREAD_IDS) this.ids.delete(this.ids.values().next().value);
    if (changed) await this.#persist();
    return changed;
  }

  async remove(threadId) {
    if (!validThreadId(threadId) || !this.ids.delete(threadId)) return false;
    await this.#persist();
    return true;
  }

  async #persist() {
    const payload = {
      version: REGISTRY_VERSION,
      updatedAt: this.now(),
      threadIds: this.snapshot(),
    };
    this.writePromise = this.writePromise.then(async () => {
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
      try {
        await fs.rename(temporary, this.file);
        await fs.chmod(this.file, 0o600);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    return this.writePromise;
  }
}

function validThreadId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000\r\n]/u.test(value);
}

function assertThreadId(value) {
  if (!validThreadId(value)) throw new TypeError("Rescue thread id is invalid");
}
