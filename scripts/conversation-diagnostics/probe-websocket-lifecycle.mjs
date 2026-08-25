import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

const MAX_DURATION_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function byteBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.concat(value.map(byteBuffer));
  return Buffer.from(String(value));
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object") || {};
}

function idOf(value) {
  return typeof value === "string" && value.length <= 256 ? value : null;
}

async function readPrivateFile(file, label) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must not be readable or writable by group/other`);
  return fs.readFile(file);
}

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  throw new Error("Usage: probe-websocket-lifecycle.mjs --url ws(s)://host/path [--duration-ms 60000] [--cookie-file path] [--origin origin]");
}

const target = new URL(args.url);
if (!["ws:", "wss:"].includes(target.protocol)) throw new Error("Only ws:// and wss:// URLs are supported");
const effectivePort = target.port || (target.protocol === "wss:" ? "443" : "80");
if (effectivePort === "4321") throw new Error("Refusing to connect to frozen rescue port 4321");

const durationMs = Number(args["duration-ms"] || 60_000);
if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > MAX_DURATION_MS) {
  throw new Error(`--duration-ms must be an integer from 1000 to ${MAX_DURATION_MS}`);
}

const headers = {};
if (args["cookie-file"]) {
  const cookie = (await readPrivateFile(args["cookie-file"], "Cookie file")).toString("utf8").trim();
  if (!cookie) throw new Error("Cookie file is empty");
  headers.Cookie = cookie;
}
if (args.origin) headers.Origin = args.origin;

const digestKey = args["digest-key-file"]
  ? await readPrivateFile(args["digest-key-file"], "Digest key file")
  : randomBytes(32);
if (digestKey.length < 16) throw new Error("Digest key must contain at least 16 bytes");
const digestKeyId = createHash("sha256").update(digestKey).digest("hex").slice(0, 16);
function payloadDigest(value) {
  return createHmac("sha256", digestKey).update(value).digest("hex");
}

const connectionId = randomUUID();
const startedMonoMs = performance.now();
const startedUnixMs = Date.now();
let opened = false;
let cleanCloseRequested = false;
let settled = false;
let exitCode = 0;

function emit(fields) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    traceId: connectionId,
    gatewayConnectionId: null,
    connectionId,
    clientInstanceId: "diagnostic-probe",
    windowInstanceId: "diagnostic-probe",
    accountIdHash: null,
    layer: "browser-probe",
    direction: fields.direction || "local",
    atMonoMs: Number((performance.now() - startedMonoMs).toFixed(3)),
    atUnixMs: startedUnixMs + Math.round(performance.now() - startedMonoMs),
    visibility: "headless-probe",
    online: true,
    digestAlgorithm: "hmac-sha256",
    digestKeyId,
    ...fields,
  })}\n`);
}

function messageMetadata(raw) {
  const bytes = byteBuffer(raw);
  let parsed = null;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    // Binary or non-JSON messages are represented only by length and digest.
  }
  const body = firstObject(parsed?.params, parsed?.result, parsed?.payload);
  const turn = firstObject(body.turn);
  const item = firstObject(body.item);
  return {
    method: typeof parsed?.method === "string"
      ? parsed.method
      : parsed?.error
        ? "rpc/error"
        : parsed && Object.hasOwn(parsed, "result")
          ? "rpc/result"
          : "ws/message",
    rpcId: parsed?.id === undefined ? null : String(parsed.id).slice(0, 128),
    runtimeEpoch: idOf(body.runtimeEpoch),
    eventSequence: Number.isSafeInteger(body.eventSequence) ? body.eventSequence : null,
    threadId: idOf(body.threadId) || idOf(body.thread?.id),
    turnId: idOf(body.turnId) || idOf(turn.id),
    itemId: idOf(body.itemId) || idOf(item.id),
    clientSubmissionId: idOf(body.clientSubmissionId),
    payloadBytes: bytes.length,
    payloadDigest: payloadDigest(bytes),
  };
}

const socket = new WebSocket(target, { headers });

const completion = new Promise((resolve) => {
  socket.on("open", () => {
    opened = true;
    emit({ method: "ws/open" });
  });

  socket.on("message", (data) => {
    emit({ direction: "in", ...messageMetadata(data) });
  });

  socket.on("ping", (data) => {
    const bytes = byteBuffer(data);
    emit({ direction: "in", method: "ws/ping", payloadBytes: bytes.length, payloadDigest: payloadDigest(bytes) });
  });

  socket.on("pong", (data) => {
    const bytes = byteBuffer(data);
    emit({ direction: "in", method: "ws/pong", payloadBytes: bytes.length, payloadDigest: payloadDigest(bytes) });
  });

  socket.on("error", (error) => {
    exitCode = cleanCloseRequested ? exitCode : 2;
    emit({
      method: "ws/error",
      errorName: error?.name || "Error",
      errorCode: typeof error?.code === "string" ? error.code : null,
    });
  });

  socket.on("close", (code, reason) => {
    const reasonBytes = byteBuffer(reason);
    emit({
      method: "ws/close",
      closeCode: code,
      closeReasonBytes: reasonBytes.length,
      closeReasonDigest: payloadDigest(reasonBytes),
      wasCleanRequested: cleanCloseRequested,
      opened,
    });
    settled = true;
    resolve();
  });
});

const closeTimer = setTimeout(() => {
  cleanCloseRequested = true;
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "diagnostic complete");
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}, durationMs);
closeTimer.unref();

const hardTimer = setTimeout(() => {
  if (!settled) {
    exitCode = 2;
    socket.terminate();
  }
}, durationMs + 2_000);
hardTimer.unref();

await completion;
clearTimeout(closeTimer);
clearTimeout(hardTimer);
process.exitCode = exitCode;
