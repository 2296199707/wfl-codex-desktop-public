import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";

export const CONVERSATION_SIDECAR_QUEUE_HIGH_REQUESTS = 48;
export const CONVERSATION_SIDECAR_QUEUE_HARD_REQUESTS = 64;
export const CONVERSATION_SIDECAR_QUEUE_HIGH_BYTES = 9 * 1024 * 1024;
export const CONVERSATION_SIDECAR_QUEUE_HARD_BYTES = 12 * 1024 * 1024;
export const CONVERSATION_SIDECAR_QUEUE_LOW_REQUESTS = 32;
export const CONVERSATION_SIDECAR_QUEUE_LOW_BYTES = 6 * 1024 * 1024;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_PATH = fileURLToPath(
  new URL("../scripts/conversation-sidecar-worker.mjs", import.meta.url),
);

export class ConversationSidecarClient {
  constructor({
    stateDirectory,
    accountId,
    uid,
    gid,
    workerPath = DEFAULT_WORKER_PATH,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    onPressureChange = null,
    onLog = null,
  }) {
    this.stateDirectory = path.resolve(String(stateDirectory || ""));
    this.accountId = String(accountId || "");
    this.uid = validIdentity(uid, "UID");
    this.gid = validIdentity(gid, "GID");
    this.workerPath = path.resolve(workerPath);
    this.requestTimeoutMs = boundedDuration(requestTimeoutMs, "request timeout");
    this.startTimeoutMs = boundedDuration(startTimeoutMs, "start timeout");
    this.onPressureChange = typeof onPressureChange === "function" ? onPressureChange : null;
    this.onLog = typeof onLog === "function" ? onLog : null;
    this.child = null;
    this.childGeneration = 0;
    this.startPromise = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.inFlight = null;
    this.nextRequestId = 1;
    this.pressured = false;
    this.closed = false;
    this.stderrTail = "";
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) {
      return Promise.reject(clientError("ERR_SIDECAR_CLOSED", "Conversation sidecar is closed"));
    }
    let bytes;
    try {
      bytes = serialize({ method, params }).byteLength;
    } catch {
      return Promise.reject(clientError(
        "ERR_SIDECAR_REQUEST_INVALID",
        "Sidecar request is not serializable",
      ));
    }
    if (bytes > CONVERSATION_SIDECAR_QUEUE_HARD_BYTES) {
      return Promise.reject(clientError(
        "ERR_SIDECAR_QUEUE_FULL",
        "Sidecar request exceeds the 12 MiB hard limit",
      ));
    }
    const outstandingCount = this.queue.length + (this.inFlight ? 1 : 0);
    const outstandingBytes = this.queuedBytes + (this.inFlight?.bytes || 0);
    if (
      outstandingCount >= CONVERSATION_SIDECAR_QUEUE_HARD_REQUESTS
      || outstandingBytes + bytes > CONVERSATION_SIDECAR_QUEUE_HARD_BYTES
    ) {
      return Promise.reject(clientError(
        "ERR_SIDECAR_QUEUE_FULL",
        "This account's sidecar queue reached its hard limit",
      ));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        method: String(method || ""),
        params,
        bytes,
        timeoutMs: boundedDuration(timeoutMs, "request timeout"),
        resolve,
        reject,
      });
      this.queuedBytes += bytes;
      this.updatePressure();
      void this.pump();
    });
  }

  health() {
    return this.request("health");
  }

  pressureSnapshot() {
    const count = this.queue.length + (this.inFlight ? 1 : 0);
    const bytes = this.queuedBytes + (this.inFlight?.bytes || 0);
    return {
      pressured: this.pressured,
      count,
      bytes,
      highRequests: CONVERSATION_SIDECAR_QUEUE_HIGH_REQUESTS,
      hardRequests: CONVERSATION_SIDECAR_QUEUE_HARD_REQUESTS,
      highBytes: CONVERSATION_SIDECAR_QUEUE_HIGH_BYTES,
      hardBytes: CONVERSATION_SIDECAR_QUEUE_HARD_BYTES,
      lowRequests: CONVERSATION_SIDECAR_QUEUE_LOW_REQUESTS,
      lowBytes: CONVERSATION_SIDECAR_QUEUE_LOW_BYTES,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const closeError = clientError("ERR_SIDECAR_CLOSED", "Conversation sidecar is closing");
    this.rejectQueued(closeError);
    const child = this.child;
    if (!child) return;
    const exited = waitForExit(child);
    try {
      if (child.connected) {
        child.send({
          type: "request",
          requestId: this.nextRequestId++,
          method: "close",
          params: {},
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  async pump() {
    if (this.closed || this.inFlight || !this.queue.length) return;
    let child;
    try {
      child = await this.ensureChild();
    } catch (error) {
      this.rejectQueued(error);
      return;
    }
    if (this.closed || this.inFlight || !this.queue.length || child !== this.child) return;
    const entry = this.queue.shift();
    this.queuedBytes -= entry.bytes;
    const requestId = this.nextRequestId++;
    const generation = this.childGeneration;
    const timer = setTimeout(() => {
      if (this.inFlight?.requestId !== requestId) return;
      const error = clientError(
        "ERR_SIDECAR_TIMEOUT",
        `Conversation sidecar request timed out: ${entry.method}`,
      );
      this.inFlight = null;
      entry.reject(error);
      this.updatePressure();
      this.retireChild(child, error);
    }, entry.timeoutMs);
    timer.unref();
    this.inFlight = { ...entry, requestId, generation, timer };
    this.updatePressure();
    try {
      child.send(
        {
          type: "request",
          requestId,
          method: entry.method,
          params: entry.params,
        },
        (error) => {
          if (!error || this.inFlight?.requestId !== requestId) return;
          this.finishInFlight({ error });
          this.retireChild(child, error);
        },
      );
    } catch (error) {
      this.finishInFlight({ error });
      this.retireChild(child, error);
    }
  }

  async ensureChild() {
    if (this.child?.connected) return this.child;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startChild().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startChild() {
    await preparePrivateDirectory(this.stateDirectory, this.uid, this.gid);
    if (this.closed) throw clientError("ERR_SIDECAR_CLOSED", "Conversation sidecar is closed");
    const generation = this.childGeneration + 1;
    const child = fork(
      this.workerPath,
      [
        `--state-directory=${this.stateDirectory}`,
        `--account-id=${this.accountId}`,
        `--expected-uid=${this.uid}`,
        `--expected-gid=${this.gid}`,
      ],
      {
        uid: this.uid,
        gid: this.gid,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv: ["--no-warnings"],
      },
    );
    this.child = child;
    this.childGeneration = generation;
    this.stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192);
      this.onLog?.({
        level: "warn",
        message: String(chunk).trim().slice(0, 1_000),
      });
    });
    child.on("message", (message) => this.handleMessage(child, generation, message));
    child.on("error", (error) => this.handleChildFailure(child, generation, error));
    child.on("exit", (code, signal) => {
      this.handleChildFailure(
        child,
        generation,
        clientError(
          "ERR_SIDECAR_EXITED",
          `Conversation sidecar exited (code=${code ?? "none"}, signal=${signal || "none"})`,
        ),
      );
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        const error = clientError(
          "ERR_SIDECAR_START_TIMEOUT",
          "Conversation sidecar did not become ready",
        );
        this.retireChild(child, error);
        reject(error);
      }, this.startTimeoutMs);
      timer.unref();
      const onReady = (message) => {
        if (message?.type !== "ready") return;
        cleanup();
        resolve(child);
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(clientError(
          "ERR_SIDECAR_START_FAILED",
          `Conversation sidecar exited before ready (code=${code ?? "none"}, signal=${signal || "none"})`,
        ));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onReady);
        child.off("exit", onExit);
      };
      child.on("message", onReady);
      child.once("exit", onExit);
    });
  }

  handleMessage(child, generation, message) {
    if (child !== this.child || generation !== this.childGeneration) return;
    if (message?.type !== "response") return;
    if (!this.inFlight || message.requestId !== this.inFlight.requestId) return;
    if (message.ok) {
      this.finishInFlight({ result: message.result });
    } else {
      this.finishInFlight({ error: remoteError(message.error) });
    }
  }

  finishInFlight({ result, error }) {
    const entry = this.inFlight;
    if (!entry) return;
    this.inFlight = null;
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(result);
    this.updatePressure();
    void this.pump();
  }

  handleChildFailure(child, generation, error) {
    if (child !== this.child || generation !== this.childGeneration) return;
    this.retireChild(child, error);
  }

  retireChild(child, error) {
    if (child !== this.child) return;
    this.child = null;
    this.rejectQueued(error);
    if (this.inFlight?.generation === this.childGeneration) {
      this.finishInFlight({ error });
    }
    try {
      if (child.connected) child.disconnect();
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
  }

  rejectQueued(error) {
    const queued = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const entry of queued) entry.reject(error);
    this.updatePressure();
  }

  updatePressure() {
    const snapshot = this.pressureSnapshot();
    const next = this.pressured
      ? (
        snapshot.count > CONVERSATION_SIDECAR_QUEUE_LOW_REQUESTS
        || snapshot.bytes > CONVERSATION_SIDECAR_QUEUE_LOW_BYTES
      )
      : (
        snapshot.count >= CONVERSATION_SIDECAR_QUEUE_HIGH_REQUESTS
        || snapshot.bytes >= CONVERSATION_SIDECAR_QUEUE_HIGH_BYTES
      );
    if (next === this.pressured) return;
    this.pressured = next;
    this.onPressureChange?.({ ...snapshot, pressured: next });
  }
}

async function preparePrivateDirectory(directory, uid, gid) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw clientError("ERR_STORAGE_LAYOUT", "Sidecar parent must be a real directory");
    }
    if (await fs.realpath(parent) !== path.resolve(parent)) {
      throw clientError("ERR_STORAGE_LAYOUT", "Sidecar parent may not traverse symlinks");
    }
    await fs.mkdir(directory, { mode: 0o700 });
    if (
      typeof process.getuid === "function"
      && process.getuid() === 0
      && (uid !== 0 || gid !== 0)
    ) {
      await fs.chown(directory, uid, gid);
    }
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw clientError("ERR_STORAGE_LAYOUT", "Sidecar state path must be a real directory");
  }
  if (await fs.realpath(directory) !== path.resolve(directory)) {
    throw clientError("ERR_STORAGE_LAYOUT", "Sidecar state path may not traverse symlinks");
  }
  if (stat.uid !== uid || stat.gid !== gid) {
    throw clientError("ERR_STORAGE_OWNER", "Sidecar state owner does not match the account");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw clientError("ERR_STORAGE_MODE", "Sidecar state directory must be owner-only");
  }
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function validIdentity(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw clientError("ERR_SIDECAR_CONFIGURATION", `Invalid sidecar ${label}`);
  }
  return number;
}

function boundedDuration(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 100 || number > 5 * 60_000) {
    throw clientError("ERR_SIDECAR_CONFIGURATION", `Invalid ${label}`);
  }
  return number;
}

function remoteError(value) {
  return clientError(
    typeof value?.code === "string" ? value.code : "ERR_SIDECAR_REQUEST",
    String(value?.message || "Conversation sidecar request failed"),
  );
}

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
