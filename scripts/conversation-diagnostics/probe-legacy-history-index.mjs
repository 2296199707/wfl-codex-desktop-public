import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const MEBIBYTE = 1024 * 1024;
const TARGET_BYTES = 50 * MEBIBYTE;
const HEAD_BYTES = 64 * 1024;
const ANCHOR_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * MEBIBYTE;
const SCHEMA_VERSION = 1;
const SYNTHETIC_SENTINEL = "WFL_LEGACY_BODY_MUST_NOT_ENTER_SIDECAR";
const SAFE_ENUM = /^[A-Za-z0-9_.:/-]{1,64}$/;

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function safeEnum(value) {
  const text = String(value ?? "");
  return SAFE_ENUM.test(text) ? text : "<other>";
}

function optionalDigest(key, value, domain) {
  return typeof value === "string" && value
    ? hmac(key, Buffer.from(`${domain}\0${value}`))
    : null;
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function validatePrivateSource(stat, {
  expectedUid,
  expectedGid,
  expectedMode = 0o600,
}) {
  if (!stat.isFile()) throw probeError("source-not-regular");
  if (stat.uid !== expectedUid) throw probeError("source-uid-mismatch");
  if (stat.gid !== expectedGid) throw probeError("source-gid-mismatch");
  if (modeBits(stat) !== expectedMode) throw probeError("source-mode-mismatch");
}

function probeError(code) {
  return Object.assign(new Error(code), { code });
}

function readDigestAt(fd, offset, length, key, domain) {
  if (length <= 0) return hmac(key, Buffer.from(`${domain}\0`));
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (count === 0) break;
    read += count;
  }
  return hmac(key, Buffer.concat([
    Buffer.from(`${domain}\0`),
    buffer.subarray(0, read),
  ]));
}

function sourceHeadDigest(fd, size, key) {
  return readDigestAt(fd, 0, Math.min(size, HEAD_BYTES), key, "head");
}

function sourceAnchorDigest(fd, safeOffset, key) {
  const length = Math.min(safeOffset, ANCHOR_BYTES);
  return readDigestAt(fd, safeOffset - length, length, key, "anchor");
}

function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = MEMORY;
  `);
  const journalMode = String(
    database.prepare("PRAGMA journal_mode = WAL").get().journal_mode,
  ).toLowerCase();
  assert.equal(journalMode, "wal");
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      source_dev TEXT NOT NULL,
      source_ino TEXT NOT NULL,
      source_size INTEGER NOT NULL CHECK(source_size >= 0),
      source_mtime_ms INTEGER NOT NULL CHECK(source_mtime_ms >= 0),
      head_digest TEXT NOT NULL,
      anchor_digest TEXT NOT NULL,
      safe_offset INTEGER NOT NULL CHECK(safe_offset >= 0),
      indexed_records INTEGER NOT NULL CHECK(indexed_records >= 0),
      indexed_turns INTEGER NOT NULL CHECK(indexed_turns >= 0),
      current_turn_ordinal INTEGER,
      scan_generation INTEGER NOT NULL CHECK(scan_generation > 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS turns (
      turn_ordinal INTEGER PRIMARY KEY,
      turn_id_digest TEXT NOT NULL,
      start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK(end_offset >= start_offset),
      row_count INTEGER NOT NULL CHECK(row_count >= 0),
      client_count INTEGER NOT NULL CHECK(client_count >= 0),
      item_count INTEGER NOT NULL CHECK(item_count >= 0),
      summary_digest TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS records (
      row_ordinal INTEGER PRIMARY KEY,
      turn_ordinal INTEGER,
      start_offset INTEGER NOT NULL UNIQUE CHECK(start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK(end_offset > start_offset),
      top_type TEXT NOT NULL,
      payload_type TEXT NOT NULL,
      item_id_digest TEXT,
      client_id_digest TEXT,
      role TEXT,
      phase TEXT,
      row_digest TEXT NOT NULL,
      FOREIGN KEY(turn_ordinal) REFERENCES turns(turn_ordinal)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT;

    CREATE INDEX IF NOT EXISTS record_turn_order
      ON records(turn_ordinal, row_ordinal);
    CREATE INDEX IF NOT EXISTS record_item_digest
      ON records(item_id_digest)
      WHERE item_id_digest IS NOT NULL;
    CREATE INDEX IF NOT EXISTS record_client_digest
      ON records(client_id_digest)
      WHERE client_id_digest IS NOT NULL;
  `);
  fs.chmodSync(databasePath, 0o600);
  return database;
}

function readState(database) {
  const row = database.prepare(`
    SELECT
      schema_version AS schemaVersion,
      source_dev AS sourceDev,
      source_ino AS sourceIno,
      source_size AS sourceSize,
      source_mtime_ms AS sourceMtimeMs,
      head_digest AS headDigest,
      anchor_digest AS anchorDigest,
      safe_offset AS safeOffset,
      indexed_records AS indexedRecords,
      indexed_turns AS indexedTurns,
      current_turn_ordinal AS currentTurnOrdinal,
      scan_generation AS scanGeneration
    FROM source_state
    WHERE singleton = 1
  `).get();
  return row ? numericState(row) : null;
}

function numericState(row) {
  return {
    ...row,
    sourceSize: Number(row.sourceSize),
    sourceMtimeMs: Number(row.sourceMtimeMs),
    safeOffset: Number(row.safeOffset),
    indexedRecords: Number(row.indexedRecords),
    indexedTurns: Number(row.indexedTurns),
    currentTurnOrdinal: row.currentTurnOrdinal == null
      ? null
      : Number(row.currentTurnOrdinal),
    scanGeneration: Number(row.scanGeneration),
  };
}

function detectRebuildReason(state, stat, headDigest, anchorDigest) {
  if (!state) return "initial-build";
  if (state.schemaVersion !== SCHEMA_VERSION) return "schema-changed";
  if (state.sourceDev !== String(stat.dev) || state.sourceIno !== String(stat.ino)) {
    return "inode-changed";
  }
  if (stat.size < state.sourceSize || stat.size < state.safeOffset) {
    return "source-truncated";
  }
  if (headDigest !== state.headDigest) return "head-prefix-changed";
  if (anchorDigest !== state.anchorDigest) return "indexed-anchor-changed";
  return null;
}

async function scanCompleteLines(fd, {
  startOffset,
  endOffset,
  digestKey,
  initialTurn,
  initialRowOrdinal,
  initialTurnOrdinal,
}) {
  if (endOffset <= startOffset) {
    return {
      rows: [],
      turns: new Map(),
      safeOffset: startOffset,
      trailingBytes: 0,
      maxLineBytes: 0,
      malformedRows: 0,
      currentTurn: initialTurn,
      lastRowOrdinal: initialRowOrdinal,
      lastTurnOrdinal: initialTurnOrdinal,
    };
  }

  const input = fs.createReadStream(null, {
    fd,
    autoClose: false,
    start: startOffset,
    end: endOffset - 1,
    highWaterMark: MEBIBYTE,
  });
  let carry = Buffer.alloc(0);
  let carryOffset = startOffset;
  let maxLineBytes = 0;
  let malformedRows = 0;
  let rowOrdinal = initialRowOrdinal;
  let turnOrdinal = initialTurnOrdinal;
  let currentTurn = initialTurn ? { ...initialTurn } : null;
  const rows = [];
  const turns = new Map();
  if (currentTurn) turns.set(currentTurn.turnOrdinal, currentTurn);

  for await (const chunk of input) {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let cursor = 0;
    while (true) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline === -1) break;
      const rawLine = buffer.subarray(cursor, newline);
      const lineStart = carryOffset + cursor;
      const lineEnd = carryOffset + newline + 1;
      maxLineBytes = Math.max(maxLineBytes, rawLine.length);
      if (rawLine.length > MAX_LINE_BYTES) throw probeError("line-too-large");
      let parsed;
      try {
        parsed = JSON.parse(rawLine.toString("utf8"));
      } catch {
        malformedRows += 1;
        cursor = newline + 1;
        continue;
      }

      const metadata = extractMetadata(parsed, rawLine, digestKey);
      const boundary = turnBoundary(metadata, digestKey);
      if (boundary?.startsTurn) {
        if (currentTurn) {
          currentTurn.endOffset = lineStart;
          turns.set(currentTurn.turnOrdinal, currentTurn);
        }
        turnOrdinal += 1;
        currentTurn = {
          turnOrdinal,
          turnIdDigest: boundary.turnIdDigest,
          startOffset: lineStart,
          endOffset: lineEnd,
          rowCount: 0,
          clientCount: 0,
          itemCount: 0,
          summaryDigest: hmac(
            digestKey,
            Buffer.from(`turn\0${boundary.turnIdDigest}`),
          ),
        };
        turns.set(turnOrdinal, currentTurn);
      }

      rowOrdinal += 1;
      const rowDigest = hmac(digestKey, rawLine);
      const row = {
        rowOrdinal,
        turnOrdinal: currentTurn?.turnOrdinal ?? null,
        startOffset: lineStart,
        endOffset: lineEnd,
        ...metadata,
        rowDigest,
      };
      rows.push(row);
      if (currentTurn) {
        currentTurn.endOffset = lineEnd;
        currentTurn.rowCount += 1;
        currentTurn.clientCount += metadata.clientIdDigest ? 1 : 0;
        currentTurn.itemCount += metadata.itemIdDigest ? 1 : 0;
        currentTurn.summaryDigest = hmac(
          digestKey,
          Buffer.from(`${currentTurn.summaryDigest}\0${rowDigest}`),
        );
        turns.set(currentTurn.turnOrdinal, currentTurn);
      }
      cursor = newline + 1;
    }
    carry = buffer.subarray(cursor);
    carryOffset += cursor;
    if (carry.length > MAX_LINE_BYTES) throw probeError("line-too-large");
  }

  return {
    rows,
    turns,
    safeOffset: carryOffset,
    trailingBytes: carry.length,
    maxLineBytes,
    malformedRows,
    currentTurn,
    lastRowOrdinal: rowOrdinal,
    lastTurnOrdinal: turnOrdinal,
  };
}

function extractMetadata(row, rawLine, digestKey) {
  const topType = safeEnum(row?.type);
  const payload = row?.payload && typeof row.payload === "object"
    ? row.payload
    : {};
  const payloadType = safeEnum(payload.type ?? "<none>");
  const itemIdDigest = topType === "response_item"
    ? optionalDigest(digestKey, payload.id, "item")
    : null;
  const clientIdDigest = topType === "event_msg" && payloadType === "user_message"
    ? optionalDigest(digestKey, payload.client_id ?? payload.clientId, "client")
    : null;
  return {
    topType,
    payloadType,
    itemIdDigest,
    clientIdDigest,
    role: payload.role == null ? null : safeEnum(payload.role),
    phase: payload.phase == null ? null : safeEnum(payload.phase),
    turnId: typeof payload.turn_id === "string"
      ? payload.turn_id
      : typeof payload.turnId === "string"
        ? payload.turnId
        : null,
    rawBytes: rawLine.length,
  };
}

function turnBoundary(metadata, digestKey) {
  if (!metadata.turnId) return null;
  if (metadata.topType === "turn_context") {
    return {
      startsTurn: true,
      turnIdDigest: optionalDigest(digestKey, metadata.turnId, "turn"),
    };
  }
  return null;
}

function loadCurrentTurn(database, ordinal) {
  if (ordinal == null) return null;
  const row = database.prepare(`
    SELECT
      turn_ordinal AS turnOrdinal,
      turn_id_digest AS turnIdDigest,
      start_offset AS startOffset,
      end_offset AS endOffset,
      row_count AS rowCount,
      client_count AS clientCount,
      item_count AS itemCount,
      summary_digest AS summaryDigest
    FROM turns
    WHERE turn_ordinal = ?
  `).get(ordinal);
  if (!row) return null;
  return {
    ...row,
    turnOrdinal: Number(row.turnOrdinal),
    startOffset: Number(row.startOffset),
    endOffset: Number(row.endOffset),
    rowCount: Number(row.rowCount),
    clientCount: Number(row.clientCount),
    itemCount: Number(row.itemCount),
  };
}

async function updateIndex({
  sourcePath,
  databasePath,
  digestKey,
  expectedUid,
  expectedGid,
  expectedMode = 0o600,
  faultAt = null,
}) {
  const pathStat = fs.lstatSync(sourcePath);
  if (pathStat.isSymbolicLink()) throw probeError("source-symlink-rejected");
  const fd = fs.openSync(sourcePath, "r");
  let database;
  try {
    const stat = fs.fstatSync(fd);
    validatePrivateSource(stat, { expectedUid, expectedGid, expectedMode });
    const headDigest = sourceHeadDigest(fd, stat.size, digestKey);
    database = openDatabase(databasePath);
    const previous = readState(database);
    const previousAnchor = previous
      ? sourceAnchorDigest(fd, previous.safeOffset, digestKey)
      : null;
    const rebuildReason = detectRebuildReason(
      previous,
      stat,
      headDigest,
      previousAnchor,
    );
    const rebuild = rebuildReason !== null;
    const startOffset = rebuild ? 0 : previous.safeOffset;
    const initialRowOrdinal = rebuild ? 0 : previous.indexedRecords;
    const initialTurnOrdinal = rebuild ? 0 : previous.indexedTurns;
    const initialTurn = rebuild
      ? null
      : loadCurrentTurn(database, previous.currentTurnOrdinal);
    const scanStarted = performance.now();
    const scan = await scanCompleteLines(fd, {
      startOffset,
      endOffset: stat.size,
      digestKey,
      initialTurn,
      initialRowOrdinal,
      initialTurnOrdinal,
    });
    const scanElapsedMs = performance.now() - scanStarted;
    const finalPathStat = fs.lstatSync(sourcePath);
    if (
      String(finalPathStat.dev) !== String(stat.dev)
      || String(finalPathStat.ino) !== String(stat.ino)
    ) {
      throw probeError("source-replaced-during-scan");
    }
    const anchorDigest = sourceAnchorDigest(fd, scan.safeOffset, digestKey);
    const nextGeneration = (previous?.scanGeneration ?? 0) + 1;

    database.exec("BEGIN IMMEDIATE");
    try {
      if (rebuild) {
        database.exec(`
          DELETE FROM records;
          DELETE FROM turns;
          DELETE FROM source_state;
        `);
      }
      const insertRecord = database.prepare(`
        INSERT INTO records(
          row_ordinal,
          turn_ordinal,
          start_offset,
          end_offset,
          top_type,
          payload_type,
          item_id_digest,
          client_id_digest,
          role,
          phase,
          row_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of scan.rows) {
        insertRecord.run(
          row.rowOrdinal,
          row.turnOrdinal,
          row.startOffset,
          row.endOffset,
          row.topType,
          row.payloadType,
          row.itemIdDigest,
          row.clientIdDigest,
          row.role,
          row.phase,
          row.rowDigest,
        );
      }

      const upsertTurn = database.prepare(`
        INSERT INTO turns(
          turn_ordinal,
          turn_id_digest,
          start_offset,
          end_offset,
          row_count,
          client_count,
          item_count,
          summary_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_ordinal) DO UPDATE SET
          turn_id_digest = excluded.turn_id_digest,
          start_offset = excluded.start_offset,
          end_offset = excluded.end_offset,
          row_count = excluded.row_count,
          client_count = excluded.client_count,
          item_count = excluded.item_count,
          summary_digest = excluded.summary_digest
      `);
      for (const turn of scan.turns.values()) {
        upsertTurn.run(
          turn.turnOrdinal,
          turn.turnIdDigest,
          turn.startOffset,
          turn.endOffset,
          turn.rowCount,
          turn.clientCount,
          turn.itemCount,
          turn.summaryDigest,
        );
      }

      database.prepare(`
        INSERT INTO source_state(
          singleton,
          schema_version,
          source_dev,
          source_ino,
          source_size,
          source_mtime_ms,
          head_digest,
          anchor_digest,
          safe_offset,
          indexed_records,
          indexed_turns,
          current_turn_ordinal,
          scan_generation
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          schema_version = excluded.schema_version,
          source_dev = excluded.source_dev,
          source_ino = excluded.source_ino,
          source_size = excluded.source_size,
          source_mtime_ms = excluded.source_mtime_ms,
          head_digest = excluded.head_digest,
          anchor_digest = excluded.anchor_digest,
          safe_offset = excluded.safe_offset,
          indexed_records = excluded.indexed_records,
          indexed_turns = excluded.indexed_turns,
          current_turn_ordinal = excluded.current_turn_ordinal,
          scan_generation = excluded.scan_generation
      `).run(
        SCHEMA_VERSION,
        String(stat.dev),
        String(stat.ino),
        stat.size,
        Math.max(0, Math.trunc(stat.mtimeMs)),
        headDigest,
        anchorDigest,
        scan.safeOffset,
        scan.lastRowOrdinal,
        scan.lastTurnOrdinal,
        scan.currentTurn?.turnOrdinal ?? null,
        nextGeneration,
      );

      if (faultAt === "before-commit") await holdForCrash("before-commit");
      database.exec("COMMIT");
      if (faultAt === "after-commit") await holdForCrash("after-commit");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // A committed transaction or killed worker cannot be rolled back here.
      }
      throw error;
    }

    return {
      status: rebuild ? "rebuilt" : "incremental",
      rebuildReason,
      sourceBytes: stat.size,
      bytesScanned: stat.size - startOffset,
      parsedBytes: scan.safeOffset - startOffset,
      rowsIndexed: scan.rows.length,
      turnsTouched: scan.turns.size,
      trailingBytes: scan.trailingBytes,
      malformedRows: scan.malformedRows,
      maxLineBytes: scan.maxLineBytes,
      safeOffset: scan.safeOffset,
      scanElapsedMs,
      state: readState(database),
    };
  } finally {
    try {
      database?.close();
    } catch {
      // The worker may be killed immediately after COMMIT.
    }
    fs.closeSync(fd);
  }
}

async function holdForCrash(stage) {
  if (typeof process.send === "function") process.send({ stage });
  await new Promise(() => {});
}

function writeJsonLine(fd, row) {
  const line = `${JSON.stringify(row)}\n`;
  fs.writeSync(fd, line);
  return Buffer.byteLength(line);
}

function syntheticRows(turnNumber, bodyBytes = 4 * 1024) {
  const turnId = `turn-${String(turnNumber).padStart(8, "0")}`;
  const clientId = `client-${String(turnNumber).padStart(8, "0")}`;
  const itemId = `msg_${String(turnNumber).padStart(8, "0")}`;
  const body = `${SYNTHETIC_SENTINEL}:${turnNumber}:`
    + "x".repeat(Math.max(0, bodyBytes - SYNTHETIC_SENTINEL.length - 20));
  return [
    {
      timestamp: "2026-07-30T00:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: turnId, cwd: "/private/synthetic" },
    },
    {
      timestamp: "2026-07-30T00:00:00.001Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    },
    {
      timestamp: "2026-07-30T00:00:00.002Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: clientId,
        message: body,
      },
    },
    {
      timestamp: "2026-07-30T00:00:00.003Z",
      type: "response_item",
      payload: {
        type: "message",
        id: itemId,
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: body }],
      },
    },
    {
      timestamp: "2026-07-30T00:00:00.004Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId },
    },
  ];
}

function createSyntheticHistory(filePath, {
  targetBytes,
  bodyBytes = 4 * 1024,
  largeLineBytes = 0,
  partial = false,
  firstTurn = 1,
}) {
  const fd = fs.openSync(filePath, "wx", 0o600);
  let completeBytes = 0;
  let completeRows = 0;
  let turns = 0;
  let turnNumber = firstTurn;
  try {
    while (completeBytes < targetBytes) {
      for (const row of syntheticRows(turnNumber, bodyBytes)) {
        completeBytes += writeJsonLine(fd, row);
        completeRows += 1;
      }
      turns += 1;
      turnNumber += 1;
    }
    if (largeLineBytes > 0) {
      completeBytes += writeJsonLine(fd, {
        timestamp: "2026-07-30T00:00:00.004Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: `call-large-${turnNumber}`,
          id: `item-large-${turnNumber}`,
          output: `${SYNTHETIC_SENTINEL}:large:`
            + "l".repeat(largeLineBytes),
        },
      });
      completeRows += 1;
    }
    let partialPrefix = Buffer.alloc(0);
    let partialSuffix = Buffer.alloc(0);
    if (partial) {
      const partialLine = Buffer.from(`${JSON.stringify({
        timestamp: "2026-07-30T00:00:00.005Z",
        type: "response_item",
        payload: {
          type: "message",
          id: `msg_partial_${turnNumber}`,
          role: "assistant",
          phase: "final_answer",
          content: [{
            type: "output_text",
            text: `${SYNTHETIC_SENTINEL}:partial:${"p".repeat(bodyBytes)}`,
          }],
        },
      })}\n`);
      const split = Math.floor(partialLine.length / 2);
      partialPrefix = partialLine.subarray(0, split);
      partialSuffix = partialLine.subarray(split);
      fs.writeSync(fd, partialPrefix);
    }
    return {
      completeBytes,
      completeRows,
      turns,
      nextTurn: turnNumber,
      partialPrefix,
      partialSuffix,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function appendTurns(filePath, {
  firstTurn,
  count,
  bodyBytes = 4 * 1024,
}) {
  const fd = fs.openSync(filePath, "a");
  let bytes = 0;
  let rows = 0;
  try {
    for (let index = 0; index < count; index += 1) {
      for (const row of syntheticRows(firstTurn + index, bodyBytes)) {
        bytes += writeJsonLine(fd, row);
        rows += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, rows, turns: count };
}

function databaseSnapshot(databasePath) {
  const database = openDatabase(databasePath);
  try {
    const state = readState(database);
    const recordCount = Number(
      database.prepare("SELECT count(*) AS count FROM records").get().count,
    );
    const turnCount = Number(
      database.prepare("SELECT count(*) AS count FROM turns").get().count,
    );
    return { state, recordCount, turnCount };
  } finally {
    database.close();
  }
}

function listTurnPage(databasePath, {
  beforeOrdinal = null,
  afterOrdinal = null,
  limit = 8,
}) {
  assert.ok(!(beforeOrdinal != null && afterOrdinal != null));
  const database = openDatabase(databasePath);
  try {
    let rows;
    if (afterOrdinal != null) {
      rows = database.prepare(`
        SELECT
          turn_ordinal AS turnOrdinal,
          turn_id_digest AS turnIdDigest,
          start_offset AS startOffset,
          end_offset AS endOffset,
          row_count AS rowCount,
          client_count AS clientCount,
          item_count AS itemCount,
          summary_digest AS summaryDigest
        FROM turns
        WHERE turn_ordinal > ?
        ORDER BY turn_ordinal ASC
        LIMIT ?
      `).all(afterOrdinal, limit);
    } else {
      rows = database.prepare(`
        SELECT
          turn_ordinal AS turnOrdinal,
          turn_id_digest AS turnIdDigest,
          start_offset AS startOffset,
          end_offset AS endOffset,
          row_count AS rowCount,
          client_count AS clientCount,
          item_count AS itemCount,
          summary_digest AS summaryDigest
        FROM turns
        WHERE (? IS NULL OR turn_ordinal < ?)
        ORDER BY turn_ordinal DESC
        LIMIT ?
      `).all(beforeOrdinal, beforeOrdinal, limit);
    }
    return rows.map((row) => ({
      ...row,
      turnOrdinal: Number(row.turnOrdinal),
      startOffset: Number(row.startOffset),
      endOffset: Number(row.endOffset),
      rowCount: Number(row.rowCount),
      clientCount: Number(row.clientCount),
      itemCount: Number(row.itemCount),
    }));
  } finally {
    database.close();
  }
}

function assertNoPlaintextInSidecar(databasePath) {
  const needle = Buffer.from(SYNTHETIC_SENTINEL);
  const checked = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${databasePath}${suffix}`;
    if (!fs.existsSync(candidate)) continue;
    checked.push(path.basename(candidate));
    assert.equal(fs.readFileSync(candidate).includes(needle), false);
  }
  return checked.length;
}

function writeWorkerConfig(configPath, value) {
  fs.writeFileSync(configPath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

async function runCrashWorker(configPath, expectedStage) {
  const child = fork(scriptPath, ["--worker", configPath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: ["--no-warnings"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const stage = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`worker timeout at ${expectedStage}: ${stderr}`));
    }, 15_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message?.stage);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(
        `worker exited before ${expectedStage}: code=${code} signal=${signal} ${stderr}`,
      ));
    });
  });
  assert.equal(stage, expectedStage);
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGKILL");
  const exit = await exitPromise;
  assert.equal(exit.signal, "SIGKILL");
}

async function workerMain(configPath) {
  const configStat = fs.lstatSync(configPath);
  assert.equal(configStat.isFile(), true);
  assert.equal(modeBits(configStat), 0o600);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const keyStat = fs.lstatSync(config.digestKeyPath);
  assert.equal(keyStat.isFile(), true);
  assert.equal(modeBits(keyStat), 0o600);
  const digestKey = fs.readFileSync(config.digestKeyPath);
  assert.equal(digestKey.length, 32);
  await updateIndex({
    ...config,
    digestKey,
  });
}

async function main() {
  const originalUmask = process.umask(0o077);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "wfl-legacy-history-index-"),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  let result;
  try {
    const digestKey = randomBytes(32);
    const digestKeyPath = path.join(temporaryRoot, "digest.key");
    fs.writeFileSync(digestKeyPath, digestKey, { mode: 0o600, flag: "wx" });
    const expectedUid = process.getuid();
    const expectedGid = process.getgid();

    const largeSource = path.join(temporaryRoot, "large-rollout.jsonl");
    const largeDatabase = path.join(temporaryRoot, "large-index.sqlite");
    const fixture = createSyntheticHistory(largeSource, {
      targetBytes: TARGET_BYTES,
      bodyBytes: 4 * 1024,
      largeLineBytes: Math.floor(2.7 * MEBIBYTE),
      partial: true,
    });
    const initialStarted = performance.now();
    const initial = await updateIndex({
      sourcePath: largeSource,
      databasePath: largeDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    const initialElapsedMs = performance.now() - initialStarted;
    assert.equal(initial.status, "rebuilt");
    assert.equal(initial.rebuildReason, "initial-build");
    assert.equal(initial.safeOffset, fixture.completeBytes);
    assert.equal(initial.trailingBytes, fixture.partialPrefix.length);
    assert.equal(initial.state.indexedRecords, fixture.completeRows);
    assert.equal(initial.state.indexedTurns, fixture.turns);
    assert.ok(initial.parsedBytes >= TARGET_BYTES);
    assert.ok(initialElapsedMs <= 2_000);

    fs.appendFileSync(largeSource, fixture.partialSuffix);
    const appended = appendTurns(largeSource, {
      firstTurn: fixture.nextTurn,
      count: 12,
      bodyBytes: 2 * 1024,
    });
    const incremental = await updateIndex({
      sourcePath: largeSource,
      databasePath: largeDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    assert.equal(incremental.status, "incremental");
    assert.equal(incremental.rebuildReason, null);
    assert.equal(incremental.trailingBytes, 0);
    assert.equal(
      incremental.rowsIndexed,
      1 + appended.rows,
    );
    assert.equal(
      incremental.bytesScanned,
      fixture.partialPrefix.length
        + fixture.partialSuffix.length
        + appended.bytes,
    );

    const latestPage = listTurnPage(largeDatabase, { limit: 8 });
    assert.equal(latestPage.length, 8);
    assert.ok(
      latestPage.every((turn, index) => (
        index === 0 || latestPage[index - 1].turnOrdinal > turn.turnOrdinal
      )),
    );
    const olderPage = listTurnPage(largeDatabase, {
      beforeOrdinal: latestPage.at(-1).turnOrdinal,
      limit: 8,
    });
    assert.equal(olderPage.length, 8);
    assert.ok(olderPage[0].turnOrdinal < latestPage.at(-1).turnOrdinal);
    const forwardPage = listTurnPage(largeDatabase, {
      afterOrdinal: 0,
      limit: 8,
    });
    assert.equal(forwardPage.length, 8);
    assert.ok(
      forwardPage.every((turn, index) => (
        index === 0 || forwardPage[index - 1].turnOrdinal < turn.turnOrdinal
      )),
    );
    const sidecarFilesChecked = assertNoPlaintextInSidecar(largeDatabase);

    const mutationSource = path.join(temporaryRoot, "mutation-rollout.jsonl");
    const mutationDatabase = path.join(temporaryRoot, "mutation-index.sqlite");
    createSyntheticHistory(mutationSource, {
      targetBytes: MEBIBYTE,
      bodyBytes: 2 * 1024,
    });
    await updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    const initialMutationSize = fs.statSync(mutationSource).size;
    fs.truncateSync(mutationSource, Math.floor(initialMutationSize / 2));
    const truncated = await updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    assert.equal(truncated.rebuildReason, "source-truncated");

    const replacementSource = path.join(temporaryRoot, "replacement.jsonl");
    createSyntheticHistory(replacementSource, {
      targetBytes: 512 * 1024,
      bodyBytes: 1024,
      firstTurn: 20_000,
    });
    fs.renameSync(replacementSource, mutationSource);
    const replaced = await updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    assert.equal(replaced.rebuildReason, "inode-changed");

    const prefixFd = fs.openSync(mutationSource, "r+");
    try {
      fs.writeSync(prefixFd, Buffer.from(" "), 0, 1, 0);
    } finally {
      fs.closeSync(prefixFd);
    }
    const prefixChanged = await updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    assert.equal(prefixChanged.rebuildReason, "head-prefix-changed");

    const beforePermission = databaseSnapshot(mutationDatabase);
    fs.chmodSync(mutationSource, 0o640);
    const permissionCode = await rejectedAsyncCode(() => updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    }));
    assert.equal(permissionCode, "source-mode-mismatch");
    assert.equal(modeBits(fs.statSync(mutationSource)), 0o640);
    assert.deepEqual(databaseSnapshot(mutationDatabase), beforePermission);
    fs.chmodSync(mutationSource, 0o600);

    const ownerBefore = fs.statSync(mutationSource);
    const ownerCode = await rejectedAsyncCode(() => updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid: expectedUid + 1,
      expectedGid,
    }));
    assert.equal(ownerCode, "source-uid-mismatch");
    const ownerAfter = fs.statSync(mutationSource);
    assert.equal(ownerAfter.uid, ownerBefore.uid);
    assert.equal(ownerAfter.gid, ownerBefore.gid);
    const groupCode = await rejectedAsyncCode(() => updateIndex({
      sourcePath: mutationSource,
      databasePath: mutationDatabase,
      digestKey,
      expectedUid,
      expectedGid: expectedGid + 1,
    }));
    assert.equal(groupCode, "source-gid-mismatch");
    const groupAfter = fs.statSync(mutationSource);
    assert.equal(groupAfter.uid, ownerBefore.uid);
    assert.equal(groupAfter.gid, ownerBefore.gid);

    const crashSource = path.join(temporaryRoot, "crash-rollout.jsonl");
    const crashDatabase = path.join(temporaryRoot, "crash-index.sqlite");
    const crashFixture = createSyntheticHistory(crashSource, {
      targetBytes: 512 * 1024,
      bodyBytes: 1024,
      firstTurn: 30_000,
    });
    await updateIndex({
      sourcePath: crashSource,
      databasePath: crashDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    appendTurns(crashSource, {
      firstTurn: crashFixture.nextTurn,
      count: 16,
      bodyBytes: 1024,
    });
    const beforeCommitCrash = databaseSnapshot(crashDatabase);
    const beforeCommitConfig = path.join(temporaryRoot, "before-commit.json");
    writeWorkerConfig(beforeCommitConfig, {
      sourcePath: crashSource,
      databasePath: crashDatabase,
      digestKeyPath,
      expectedUid,
      expectedGid,
      expectedMode: 0o600,
      faultAt: "before-commit",
    });
    await runCrashWorker(beforeCommitConfig, "before-commit");
    const afterBeforeCommitCrash = databaseSnapshot(crashDatabase);
    assert.deepEqual(afterBeforeCommitCrash, beforeCommitCrash);

    const recovered = await updateIndex({
      sourcePath: crashSource,
      databasePath: crashDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    assert.ok(recovered.rowsIndexed > 0);
    const afterRecovery = databaseSnapshot(crashDatabase);
    appendTurns(crashSource, {
      firstTurn: crashFixture.nextTurn + 16,
      count: 16,
      bodyBytes: 1024,
    });
    const afterCommitConfig = path.join(temporaryRoot, "after-commit.json");
    writeWorkerConfig(afterCommitConfig, {
      sourcePath: crashSource,
      databasePath: crashDatabase,
      digestKeyPath,
      expectedUid,
      expectedGid,
      expectedMode: 0o600,
      faultAt: "after-commit",
    });
    await runCrashWorker(afterCommitConfig, "after-commit");
    const afterAfterCommitCrash = databaseSnapshot(crashDatabase);
    assert.ok(
      afterAfterCommitCrash.state.safeOffset > afterRecovery.state.safeOffset,
    );
    assert.ok(afterAfterCommitCrash.recordCount > afterRecovery.recordCount);
    const retryAfterCommit = await updateIndex({
      sourcePath: crashSource,
      databasePath: crashDatabase,
      digestKey,
      expectedUid,
      expectedGid,
    });
    assert.equal(retryAfterCommit.rowsIndexed, 0);
    assert.equal(
      retryAfterCommit.safeOffset,
      afterAfterCommitCrash.state.safeOffset,
    );

    result = {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      fixture: {
        sourceBytes: initial.sourceBytes,
        completeBytes: fixture.completeBytes,
        completeRows: fixture.completeRows,
        turns: fixture.turns,
        maxLineBytes: initial.maxLineBytes,
        privateDirectoryMode: "0700",
        privateFileMode: "0600",
      },
      performance: {
        targetBytes: TARGET_BYTES,
        targetMsPer50MiB: 2_000,
        initialElapsedMs: Number(initialElapsedMs.toFixed(3)),
        scannerElapsedMs: Number(initial.scanElapsedMs.toFixed(3)),
        passed: initialElapsedMs <= 2_000,
      },
      incompleteLine: {
        withheldBytes: fixture.partialPrefix.length,
        initialSafeOffset: initial.safeOffset,
        indexedAfterNewline: incremental.rowsIndexed,
        passed: true,
      },
      incremental: {
        bytesScanned: incremental.bytesScanned,
        rowsIndexed: incremental.rowsIndexed,
        turnsTouched: incremental.turnsTouched,
        rebuilt: false,
      },
      rebuildDetection: {
        truncated: truncated.rebuildReason,
        inodeReplacement: replaced.rebuildReason,
        headPrefixChange: prefixChanged.rebuildReason,
      },
      sourceValidation: {
        modeMismatch: permissionCode,
        uidMismatch: ownerCode,
        gidMismatch: groupCode,
        sourceModeWasNotRepaired: true,
        sourceOwnerWasNotRepaired: true,
      },
      crashRecovery: {
        beforeCommitRolledBack: true,
        afterCommitRecovered: true,
        retryInsertedRows: retryAfterCommit.rowsIndexed,
        checkpointAndRowsAtomic: true,
      },
      pagination: {
        latestPageTurns: latestPage.length,
        olderPageTurns: olderPage.length,
        forwardPageTurns: forwardPage.length,
        storedContentBodies: 0,
        officialRpcCalls: 0,
      },
      privacy: {
        hmac: "HMAC-SHA-256",
        sidecarFilesChecked,
        plaintextSentinelFound: false,
      },
      limits: {
        readsProductionHistory: false,
        productionIndexImplemented: false,
        sourceAuthorityChanged: false,
        appendOnlySourceAssumption: true,
        candidate200MiBValidationPending: true,
      },
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    process.umask(originalUmask);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function rejectedAsyncCode(action) {
  try {
    await action();
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

if (process.argv[2] === "--worker") {
  await workerMain(process.argv[3]);
} else {
  await main();
}
