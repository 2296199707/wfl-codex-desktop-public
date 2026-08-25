#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import {
  parseTiledAiPatch,
  prepareTiledAiPatchFills,
  applyTiledAiPatch,
  previewTiledAiPatch,
} from "../public/map-editor/tiled-ai-patch.js";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import { parseTiledDocument, serializeTiledDocument } from "../public/map-editor/tiled-document.js";
import { assertProtectedTargetsUnchanged, findProtectedOperationViolations } from "../lib/map-ai-protected-targets.mjs";
import { assertMapPatchRuntimeCompatible, inspectMapRuntimeCapabilities } from "../lib/map-runtime-capabilities.mjs";
import { summarizeTiledPatchImpact } from "../lib/map-ai-diff.mjs";

const inputPath = process.argv[2];
try {
  if (!inputPath) throw workerError("MAP_AI_WORKER_INPUT_INVALID", "地图 AI Worker 输入文件缺失");
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const result = await execute(input);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error?.code || "MAP_AI_WORKER_FAILED", message: error?.message || "地图 AI Worker 执行失败" } })}\n`);
  process.exitCode = 1;
}

async function execute(input) {
  if (!input || input.protocolVersion !== 1) throw workerError("MAP_AI_WORKER_INPUT_INVALID", "地图 AI Worker 协议版本无效");
  const targetPath = assertAbsoluteFile(input.targetPath, "targetPath");
  const projectPath = await assertRealProjectDirectory(input.projectPath);
  const targetRealPath = await fs.realpath(targetPath).catch(() => null);
  const targetStat = await fs.lstat(targetPath).catch(() => null);
  const relativeTarget = targetRealPath ? path.relative(projectPath, targetRealPath) : "";
  if (!targetRealPath || !targetStat?.isFile() || targetStat.isSymbolicLink() || !relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw workerError("MAP_AI_WORKER_TARGET_INVALID", "地图 AI Worker 目标路径无效或离开工程");
  }
  const source = await readBoundedMap(targetPath, Number(input.maxReadBytes || 0));
  const currentVersion = crypto.createHash("sha256").update(source).digest("hex");
  if (currentVersion !== String(input.expectedVersion).toLowerCase()) {
    throw workerError("MAP_AI_MAP_VERSION_CONFLICT", "地图在 Worker 读取前已经变化");
  }
  const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: String(input.mapPath) });
  const patchSource = JSON.stringify(input.plan);
  const patch = parseTiledAiPatch(patchSource, {
    mapPath: String(input.mapPath),
    mapVersion: currentVersion,
    editorStateId: Number(input.plan?.base?.editorStateId ?? 0),
  });
  const runtimeCapabilities = input.runtimeCapabilities && typeof input.runtimeCapabilities === "object"
    ? input.runtimeCapabilities
    : await inspectMapRuntimeCapabilities({ projectPath, mapPath: String(input.mapPath) });
  assertMapPatchRuntimeCompatible(parsed.document, patch, runtimeCapabilities);
  const preview = previewTiledAiPatch(parsed.document, patch);
  const protectedViolations = findProtectedOperationViolations(parsed.document, patch, input.protectedTargets || [], String(input.mapPath));
  if (protectedViolations.length) throw workerError("MAP_AI_PROTECTED_OPERATION", protectedViolations[0].message);
  const summary = previewSummary(preview, patch);
  const impact = summarizeTiledPatchImpact(parsed.document, patch, { maxHeat: 512 });
  if (input.mode !== "apply") return { currentVersion, preview: summary, impact };
  const prepared = prepareTiledAiPatchFills(parsed.document, patch);
  const editor = new TiledEditDocument(parsed.document);
  applyTiledAiPatch(editor, patch, { fillResults: prepared.fillResults, label: `托管 AI：${patch.summary}` });
  const candidate = editor.exportDocument();
  assertProtectedTargetsUnchanged(parsed.document, candidate, input.protectedTargets || [], String(input.mapPath));
  const serialized = serializeTiledDocument(candidate, {
    expectedKind: "map", sourcePath: String(input.mapPath), space: 2, trailingNewline: true,
  });
  const bytes = Buffer.from(serialized, "utf8");
  const outputDirectory = assertAbsoluteDirectory(input.outputDirectory);
  const candidatePath = path.join(outputDirectory, "candidate.tmj");
  await fs.writeFile(candidatePath, bytes, { mode: 0o600, flag: "wx" });
  return {
    currentVersion,
    preview: summary,
    impact,
    candidate: {
      path: "candidate.tmj",
      size: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      mediaType: "application/json",
    },
  };
}

function previewSummary(preview, patch) {
  const entries = Array.isArray(preview?.entries) ? preview.entries : [];
  const limit = 24;
  const operationKinds = Object.create(null);
  for (const operation of patch.operations) operationKinds[operation.op] = (operationKinds[operation.op] || 0) + 1;
  return {
    summary: truncate(preview?.summary || patch.summary || "地图 AI 托管补丁", 2_000),
    operationCount: preview.operationCount,
    tileCellCount: preview.tileCellCount,
    ordinaryObjectCount: patch.operations.filter((entry) => ["add-object", "update-object", "remove-object"].includes(entry.op)).length,
    operationKinds,
    entries: entries.slice(0, limit).map((entry) => ({
      index: entry.index,
      op: truncate(entry.op, 64),
      title: truncate(entry.title, 240),
      detail: truncate(entry.detail, 512),
    })),
    truncated: entries.length > limit,
    omittedEntries: Math.max(0, entries.length - limit),
  };
}

function assertAbsoluteFile(value, label) {
  const filename = String(value || "");
  if (!path.isAbsolute(filename) || filename.includes("\u0000")) throw workerError("MAP_AI_WORKER_INPUT_INVALID", `${label} 无效`);
  return filename;
}
function assertAbsoluteDirectory(value) {
  const directory = String(value || "");
  if (!path.isAbsolute(directory) || directory.includes("\u0000")) throw workerError("MAP_AI_WORKER_INPUT_INVALID", "outputDirectory 无效");
  return directory;
}
async function readBoundedMap(filename, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw workerError("MAP_AI_TASK_READ_LIMIT_INVALID", "地图 AI Worker 读取预算无效");
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > maxBytes) throw workerError("MAP_AI_TASK_MAP_TOO_LARGE", "托管地图超过当前任务读取预算");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw workerError("MAP_AI_TASK_MAP_TOO_LARGE", "托管地图超过当前任务读取预算");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
async function assertRealProjectDirectory(value) {
  const directory = assertAbsoluteDirectory(value);
  const stat = await fs.lstat(directory).catch(() => null);
  const real = await fs.realpath(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || real !== path.resolve(directory)) {
    throw workerError("MAP_AI_WORKER_PROJECT_INVALID", "地图 AI Worker 工程路径无效");
  }
  return real;
}
function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function workerError(code, message) { return Object.assign(new Error(message), { code }); }
