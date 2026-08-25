import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_VERSION = 1;

export class RescueChatSnapshotStore {
  constructor(stateDirectory, { now = () => Date.now() } = {}) {
    this.directory = path.join(path.resolve(stateDirectory), "rescue-chat-snapshots-v1");
    this.now = now;
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    return this;
  }

  async recordList(result) {
    assertThreadList(result);
    return this.#write("thread-list.json", "thread-list", cloneJson(result));
  }

  async readList({ cwd = null, archived = false } = {}) {
    const envelope = await this.#read("thread-list.json", "thread-list");
    assertThreadList(envelope.payload);
    const data = envelope.payload.data.filter((thread) => (
      (thread.archived === true) === (archived === true)
      && (!cwd || thread.cwd === cwd)
    ));
    return withFallbackMetadata({
      ...envelope.payload,
      data,
      // A filtered fallback is a complete local view, not a continuation of
      // the failed server page. Never let an old cursor leak into another
      // project or archive scope.
      nextCursor: null,
    }, envelope.savedAt);
  }

  async recordThread(thread, { turnsPage = null } = {}) {
    assertThread(thread);
    if (turnsPage !== null) assertTurnsPage(turnsPage);
    const existing = await this.#readThreadEnvelope(thread.id).catch(() => null);
    const payload = {
      thread: cloneJson(thread),
      turnsPage: turnsPage === null ? existing?.payload?.turnsPage || null : cloneJson(turnsPage),
    };
    return this.#write(this.#threadFilename(thread.id), "thread", payload);
  }

  async recordTurns(threadId, turnsPage) {
    assertThreadId(threadId);
    assertTurnsPage(turnsPage);
    const existing = await this.#readThreadEnvelope(threadId).catch(() => null);
    const thread = existing?.payload?.thread || { id: threadId };
    return this.#write(this.#threadFilename(threadId), "thread", {
      thread,
      turnsPage: cloneJson(turnsPage),
    });
  }

  async removeThread(threadId) {
    assertThreadId(threadId);
    await fs.rm(path.join(this.directory, this.#threadFilename(threadId)), { force: true });
  }

  async readThread(threadId, { includeTurns = false } = {}) {
    const envelope = await this.#readThreadEnvelope(threadId);
    const thread = cloneJson(envelope.payload.thread);
    if (includeTurns && Array.isArray(envelope.payload.turnsPage?.data)) {
      thread.turns = cloneJson(envelope.payload.turnsPage.data);
    } else if (!includeTurns) {
      delete thread.turns;
    }
    return withFallbackMetadata({ thread }, envelope.savedAt);
  }

  async readTurns(threadId) {
    const envelope = await this.#readThreadEnvelope(threadId);
    if (!envelope.payload.turnsPage) throw snapshotError("没有可用的最后有效对话正文");
    assertTurnsPage(envelope.payload.turnsPage);
    return withFallbackMetadata(cloneJson(envelope.payload.turnsPage), envelope.savedAt);
  }

  async #readThreadEnvelope(threadId) {
    assertThreadId(threadId);
    const envelope = await this.#read(this.#threadFilename(threadId), "thread");
    assertThread(envelope.payload?.thread);
    if (envelope.payload.turnsPage !== null) assertTurnsPage(envelope.payload.turnsPage);
    return envelope;
  }

  #threadFilename(threadId) {
    return `thread-${crypto.createHash("sha256").update(threadId).digest("hex")}.json`;
  }

  async #write(filename, kind, payload) {
    const unsigned = {
      version: SNAPSHOT_VERSION,
      kind,
      savedAt: this.now(),
      payload,
    };
    const envelope = { ...unsigned, checksum: checksum(unsigned) };
    const destination = path.join(this.directory, filename);
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { savedAt: envelope.savedAt };
  }

  async #read(filename, expectedKind) {
    let envelope;
    try {
      envelope = JSON.parse(await fs.readFile(path.join(this.directory, filename), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw snapshotError("没有可用的最后有效聊天快照");
      throw snapshotError("最后有效聊天快照无法读取");
    }
    const { checksum: actualChecksum, ...unsigned } = envelope || {};
    if (
      unsigned.version !== SNAPSHOT_VERSION
      || unsigned.kind !== expectedKind
      || !Number.isFinite(unsigned.savedAt)
      || !unsigned.payload
      || typeof actualChecksum !== "string"
      || !timingSafeEqual(actualChecksum, checksum(unsigned))
    ) {
      throw snapshotError("最后有效聊天快照校验失败");
    }
    return envelope;
  }
}

function withFallbackMetadata(value, savedAt) {
  return {
    ...value,
    rescueSnapshot: {
      fallback: true,
      readOnly: true,
      savedAt,
    },
  };
}

function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function timingSafeEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertThreadList(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.data)) {
    throw new TypeError("Thread list snapshot must contain a data array");
  }
  for (const thread of result.data) assertThread(thread);
}

function assertTurnsPage(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.data)) {
    throw new TypeError("Thread turns snapshot must contain a data array");
  }
}

function assertThread(thread) {
  if (!thread || typeof thread !== "object") throw new TypeError("Thread snapshot must be an object");
  assertThreadId(thread.id);
}

function assertThreadId(threadId) {
  if (typeof threadId !== "string" || !threadId || threadId.length > 512) {
    throw new TypeError("Thread id is invalid");
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotError(message) {
  const error = new Error(message);
  error.code = "ERR_RESCUE_SNAPSHOT_UNAVAILABLE";
  return error;
}
