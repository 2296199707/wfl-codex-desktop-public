import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("Usage: analyze-conversation-traces.mjs trace-a.ndjson [trace-b.ndjson ...]");
}

const rows = [];
const malformed = [];

for (const file of files) {
  let lineNumber = 0;
  const input = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of input) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("row is not an object");
      if (row.schemaVersion !== 1) throw new Error("unsupported or missing schemaVersion");
      if (typeof row.layer !== "string" || !row.layer) throw new Error("missing layer");
      if (typeof row.method !== "string" || !row.method) throw new Error("missing method");
      if (!Number.isFinite(row.atMonoMs) && !Number.isFinite(row.atUnixMs)) {
        throw new Error("missing monotonic and wall-clock timestamp");
      }
      rows.push({ ...row, _file: file, _line: lineNumber });
    } catch (error) {
      malformed.push({ file, line: lineNumber, error: error.message });
    }
  }
}

function boundedExamples(values, limit = 20) {
  return values.slice(0, limit);
}

const sequenceGroups = new Map();
for (const row of rows) {
  if (!row.runtimeEpoch || !Number.isSafeInteger(row.eventSequence)) continue;
  const key = `${row._file}\u0000${row.connectionId || "unknown"}\u0000${row.runtimeEpoch}`;
  if (!sequenceGroups.has(key)) sequenceGroups.set(key, []);
  sequenceGroups.get(key).push(row);
}

const sequenceGaps = [];
const sequenceDuplicates = [];
for (const [key, group] of sequenceGroups) {
  group.sort((left, right) => (left.atMonoMs ?? left.atUnixMs ?? left._line)
    - (right.atMonoMs ?? right.atUnixMs ?? right._line));
  let previous = null;
  for (const row of group) {
    if (previous !== null && row.eventSequence === previous) {
      sequenceDuplicates.push({ key, eventSequence: row.eventSequence, line: row._line });
    } else if (previous !== null && row.eventSequence > previous + 1) {
      sequenceGaps.push({ key, after: previous, before: row.eventSequence, line: row._line });
    }
    if (previous === null || row.eventSequence > previous) previous = row.eventSequence;
  }
}

const itemStates = new Map();
const lifecycleRegressions = [];
for (const row of rows) {
  if (!row.itemId || !["item/started", "item/completed"].includes(row.method)) continue;
  const key = `${row.threadId || "unknown"}\u0000${row.turnId || "unknown"}\u0000${row.itemId}`;
  const previous = itemStates.get(key);
  if (previous === "completed" && row.method === "item/started") {
    lifecycleRegressions.push({ key, file: row._file, line: row._line });
  }
  if (row.method === "item/completed") itemStates.set(key, "completed");
  else if (!previous) itemStates.set(key, "started");
}

const eventLayers = new Map();
for (const row of rows) {
  if (!row.runtimeEpoch || !Number.isSafeInteger(row.eventSequence) || !row.layer) continue;
  const key = `${row.runtimeEpoch}:${row.eventSequence}`;
  if (!eventLayers.has(key)) eventLayers.set(key, new Set());
  eventLayers.get(key).add(row.layer);
}
const allLayers = [...new Set(rows.map((row) => row.layer).filter(Boolean))].sort();
const crossLayerMissing = [];
if (allLayers.length > 1) {
  for (const [eventKey, layers] of eventLayers) {
    const missing = allLayers.filter((layer) => !layers.has(layer));
    if (missing.length > 0) crossLayerMissing.push({ eventKey, present: [...layers].sort(), missing });
  }
}

const methodCounts = {};
const layerCounts = {};
for (const row of rows) {
  const method = row.method || "unknown";
  const layer = row.layer || "unknown";
  methodCounts[method] = (methodCounts[method] || 0) + 1;
  layerCounts[layer] = (layerCounts[layer] || 0) + 1;
}

process.stdout.write(`${JSON.stringify({
  ok: malformed.length === 0
    && sequenceGaps.length === 0
    && sequenceDuplicates.length === 0
    && lifecycleRegressions.length === 0,
  files,
  rowCount: rows.length,
  malformedCount: malformed.length,
  malformed: boundedExamples(malformed),
  sequenceGapCount: sequenceGaps.length,
  sequenceGaps: boundedExamples(sequenceGaps),
  sequenceDuplicateCount: sequenceDuplicates.length,
  sequenceDuplicates: boundedExamples(sequenceDuplicates),
  lifecycleRegressionCount: lifecycleRegressions.length,
  lifecycleRegressions: boundedExamples(lifecycleRegressions),
  crossLayerMissingCount: crossLayerMissing.length,
  crossLayerMissing: boundedExamples(crossLayerMissing),
  layerCounts,
  methodCounts,
}, null, 2)}\n`);
