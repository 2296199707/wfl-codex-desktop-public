import process from "node:process";
import { serialize } from "node:v8";
import { ConversationSidecarStorage } from "../lib/conversation-sidecar-storage.mjs";

const REQUEST_MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_METHODS = new Set([
  "health",
  "managementSnapshot",
  "indexHistory",
  "historyTurns",
  "historyMessageIdentities",
  "close",
]);

process.umask(0o077);
const configuration = parseArguments(process.argv.slice(2));
let storage = null;
let initializationError = null;
let closing = false;
let requestChain = Promise.resolve();

try {
  storage = new ConversationSidecarStorage(configuration).initialize();
} catch (error) {
  initializationError = error;
}

process.on("message", (message) => {
  requestChain = requestChain
    .then(() => handleMessage(message))
    .catch((error) => {
      process.stderr.write(`Conversation sidecar request failure: ${error.stack || error.message}\n`);
    });
});

process.on("disconnect", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

send({
  type: "ready",
  pid: process.pid,
  identity: {
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
  },
  health: healthSnapshot(),
});

async function handleMessage(message) {
  if (closing) return;
  const requestId = message?.requestId;
  if (
    message?.type !== "request"
    || !Number.isSafeInteger(requestId)
    || requestId < 1
  ) {
    return;
  }
  let response;
  try {
    if (serialize(message).byteLength > REQUEST_MAX_BYTES) {
      throw workerError("ERR_SIDECAR_REQUEST_TOO_LARGE", "Sidecar request exceeds 12 MiB");
    }
    const method = String(message.method || "");
    if (!ALLOWED_METHODS.has(method)) {
      throw workerError("ERR_SIDECAR_METHOD", "Unsupported sidecar method");
    }
    const result = dispatch(method, message.params);
    response = { type: "response", requestId, ok: true, result };
  } catch (error) {
    response = {
      type: "response",
      requestId,
      ok: false,
      error: publicError(error),
    };
  }
  const shouldClose = message.method === "close";
  await send(response);
  if (shouldClose) shutdown();
}

function dispatch(method, params) {
  if (method === "health") return healthSnapshot();
  if (method === "close") {
    storage?.close();
    return { closed: true };
  }
  if (!storage) throw initializationError || workerError(
    "ERR_SIDECAR_DEGRADED",
    "Conversation sidecar initialization failed",
  );
  return storage[method](params);
}

function healthSnapshot() {
  if (storage) return storage.health();
  return {
    ok: false,
    writable: false,
    accountId: configuration.accountId,
    schemaVersion: null,
    keyAvailable: false,
    keyId: null,
    stateIntegrity: "unavailable",
    historyIntegrity: "unavailable",
    degradedReason: storageFailureReason(initializationError),
  };
}

function send(message) {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      process.send(message, (error) => {
        if (error && !closing) {
          process.stderr.write(`Conversation sidecar IPC failure: ${error.message}\n`);
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function shutdown() {
  if (closing) return;
  closing = true;
  storage?.close();
  storage = null;
  try {
    process.disconnect();
  } catch {}
  setImmediate(() => process.exit(0));
}

function parseArguments(args) {
  const values = new Map();
  for (const argument of args) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) continue;
    values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return {
    stateDirectory: requiredArgument(values, "state-directory"),
    accountId: requiredArgument(values, "account-id"),
    expectedUid: requiredIntegerArgument(values, "expected-uid"),
    expectedGid: requiredIntegerArgument(values, "expected-gid"),
  };
}

function requiredArgument(values, name) {
  const value = values.get(name);
  if (!value) throw workerError("ERR_SIDECAR_CONFIGURATION", `Missing --${name}`);
  return value;
}

function requiredIntegerArgument(values, name) {
  const value = Number(requiredArgument(values, name));
  if (!Number.isInteger(value) || value < 0) {
    throw workerError("ERR_SIDECAR_CONFIGURATION", `Invalid --${name}`);
  }
  return value;
}

function storageFailureReason(error) {
  if (!error) return "initialization-failed";
  if (typeof error.code === "string" && error.code.startsWith("ERR_")) {
    return error.code.toLowerCase().replace(/^err_/, "").replaceAll("_", "-");
  }
  return "initialization-failed";
}

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ERR_SIDECAR_REQUEST",
    message: String(error?.message || "Conversation sidecar request failed").slice(0, 1_000),
  };
}

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
