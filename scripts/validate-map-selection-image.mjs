import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import {
  validateMapSelectionImageTaskContract,
} from "../lib/map-selection-image-target.mjs";
import { parseTiledDocument } from "../public/map-editor/tiled-document.js";

const MAX_INPUT_BYTES = 256 * 1024;
const [mapPath, expectedVersion] = process.argv.slice(2);

try {
  if (!mapPath || !/^[a-f0-9]{64}$/u.test(String(expectedVersion || ""))) {
    throw validationError("MAP_IMAGE_SELECTION_VALIDATOR_INPUT", "地图选区校验参数缺失");
  }
  const payload = JSON.parse((await readStdin()).toString("utf8"));
  const maxMapBytes = payload.maxMapBytes == null
    ? 4 * 1024 * 1024 * 1024
    : Number(payload.maxMapBytes);
  if (!Number.isSafeInteger(maxMapBytes) || maxMapBytes < 1) {
    throw validationError("MAP_IMAGE_SELECTION_MAP_LIMIT_INVALID", "地图选区校验读取上限无效");
  }
  const handle = await fs.open(mapPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let source;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw validationError("MAP_IMAGE_SELECTION_MAP_INVALID", "地图选区目标不是文件");
    if (before.size > maxMapBytes) {
      throw validationError("MAP_IMAGE_SELECTION_MAP_LIMIT", "地图超过管理员设置的读取上限", 413);
    }
    source = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw validationError("MAP_IMAGE_SELECTION_VERSION_CONFLICT", "地图在选区校验期间发生变化", 409);
    }
  } finally {
    await handle.close();
  }
  const actualVersion = crypto.createHash("sha256").update(source).digest("hex");
  if (actualVersion !== expectedVersion) {
    throw validationError("MAP_IMAGE_SELECTION_VERSION_CONFLICT", "地图版本已变化，请重新选择区域", 409);
  }
  const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: "map.tmj" });
  const contract = validateMapSelectionImageTaskContract(payload.target, {
    document: parsed.document,
    currentMapVersion: expectedVersion,
    currentEditorStateId: payload.editorStateId,
    operation: payload.operation,
    request: payload.request,
    expectedLogicalCanvas: payload.expectedLogicalCanvas,
    limits: payload.limits,
  });
  process.stdout.write(JSON.stringify({ contract }));
} catch (error) {
  process.stderr.write(JSON.stringify({
    code: safeCode(error?.code),
    statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 400,
    error: String(error?.message || "地图选区校验失败").slice(0, 2_000),
  }));
  process.exitCode = 1;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) {
      throw validationError("MAP_IMAGE_SELECTION_PAYLOAD_TOO_LARGE", "地图选区校验参数过大");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!total) throw validationError("MAP_IMAGE_SELECTION_VALIDATOR_INPUT", "地图选区校验参数缺失");
  return Buffer.concat(chunks, total);
}

function safeCode(value) {
  const code = String(value || "MAP_IMAGE_SELECTION_INVALID");
  return /^[A-Z][A-Z0-9_]{2,100}$/u.test(code) ? code : "MAP_IMAGE_SELECTION_INVALID";
}

function validationError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
