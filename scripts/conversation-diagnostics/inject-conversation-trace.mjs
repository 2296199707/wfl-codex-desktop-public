import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";

const SUPPORTED_OPERATIONS = new Set([
  "drop",
  "duplicate",
  "delay",
  "reorder-next",
  "disconnect-marker",
  "restart-marker",
  "slow-consumer",
]);

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

function matches(row, expected = {}) {
  return Object.entries(expected).every(([key, value]) => row[key] === value);
}

function annotate(row, rule, extra = {}) {
  return {
    ...row,
    diagnosticFault: {
      id: rule.id,
      operation: rule.op,
      ...extra,
    },
  };
}

function marker(row, rule) {
  return {
    schemaVersion: 1,
    traceId: row.traceId || null,
    connectionId: row.connectionId || null,
    clientInstanceId: row.clientInstanceId || null,
    layer: "fault-injector",
    direction: "local",
    atMonoMs: row.atMonoMs ?? null,
    atUnixMs: row.atUnixMs ?? null,
    runtimeEpoch: row.runtimeEpoch || null,
    eventSequence: row.eventSequence ?? null,
    method: rule.op === "disconnect-marker" ? "fault/disconnect" : "fault/restart",
    threadId: row.threadId || null,
    turnId: row.turnId || null,
    itemId: row.itemId || null,
    clientSubmissionId: row.clientSubmissionId || null,
    diagnosticFault: { id: rule.id, operation: rule.op },
  };
}

function boundedNumber(value, fallback, minimum, maximum, label, { integer = false } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} from ${minimum} to ${maximum}`);
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (!args.rules || !args.input) {
  throw new Error("Usage: inject-conversation-trace.mjs --rules rules.json --input trace.ndjson");
}

const rawRules = JSON.parse(await fs.promises.readFile(args.rules, "utf8"));
if (!Array.isArray(rawRules) || rawRules.length === 0) throw new Error("Rules must be a non-empty JSON array");
const rules = rawRules.map((rule, index) => {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`Rule ${index + 1} is invalid`);
  if (!SUPPORTED_OPERATIONS.has(rule.op)) throw new Error(`Rule ${index + 1} has unsupported op: ${rule.op}`);
  const nth = boundedNumber(rule.nth, null, 1, Number.MAX_SAFE_INTEGER, `Rule ${index + 1} nth`, { integer: true });
  const every = boundedNumber(rule.every, null, 1, Number.MAX_SAFE_INTEGER, `Rule ${index + 1} every`, { integer: true });
  return {
    id: String(rule.id || `rule-${index + 1}`),
    match: rule.match || {},
    nth,
    every,
    copies: boundedNumber(rule.copies, 2, 2, 20, `Rule ${index + 1} copies`, { integer: true }),
    delayMs: boundedNumber(rule.delayMs, 0, 0, 60_000, `Rule ${index + 1} delayMs`),
    bytesPerSecond: boundedNumber(rule.bytesPerSecond, 1024, 1, 1024 * 1024 * 1024, `Rule ${index + 1} bytesPerSecond`),
    op: rule.op,
    seen: 0,
    accumulatedDelayMs: 0,
  };
});

function selectedRule(row) {
  for (const rule of rules) {
    if (!matches(row, rule.match)) continue;
    rule.seen += 1;
    if (rule.nth !== null && rule.seen !== rule.nth) continue;
    if (rule.every !== null && (rule.seen - 1) % rule.every !== 0) continue;
    return rule;
  }
  return null;
}

function delayed(row, rule, delayMs) {
  return annotate({
    ...row,
    atMonoMs: Number.isFinite(row.atMonoMs) ? row.atMonoMs + delayMs : row.atMonoMs,
    atUnixMs: Number.isFinite(row.atUnixMs) ? row.atUnixMs + Math.round(delayMs) : row.atUnixMs,
  }, rule, { delayMs });
}

function output(row) {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

let heldForReorder = null;
let lineNumber = 0;
const input = readline.createInterface({
  input: fs.createReadStream(args.input, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

for await (const line of input) {
  lineNumber += 1;
  if (!line.trim()) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON at ${args.input}:${lineNumber}: ${error.message}`);
  }

  if (heldForReorder) {
    output(row);
    output(heldForReorder);
    heldForReorder = null;
    continue;
  }

  const rule = selectedRule(row);
  if (!rule) {
    output(row);
    continue;
  }

  if (rule.op === "drop") continue;
  if (rule.op === "duplicate") {
    for (let copy = 0; copy < rule.copies; copy += 1) {
      output(annotate(row, rule, { copy: copy + 1, copies: rule.copies }));
    }
    continue;
  }
  if (rule.op === "delay") {
    output(delayed(row, rule, rule.delayMs));
    continue;
  }
  if (rule.op === "reorder-next") {
    heldForReorder = annotate(row, rule);
    continue;
  }
  if (rule.op === "disconnect-marker" || rule.op === "restart-marker") {
    output(marker(row, rule));
    output(annotate(row, rule));
    continue;
  }
  if (rule.op === "slow-consumer") {
    const bytes = Number.isFinite(row.payloadBytes) ? Math.max(0, row.payloadBytes) : 0;
    rule.accumulatedDelayMs += (bytes / rule.bytesPerSecond) * 1000;
    output(delayed(row, rule, Number(rule.accumulatedDelayMs.toFixed(3))));
  }
}

if (heldForReorder) output(heldForReorder);
