import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeResponseAssistantIdentity } from "./conversation-message-identity.mjs";

export const CONVERSATION_SIDECAR_SCHEMA_VERSION = 2;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KEY_BYTES = 32;
const KEY_FILE = "conversation-state.key";
const STATE_DATABASE = "conversation-state.sqlite";
const HISTORY_DATABASE = "conversation-history.sqlite";
const HISTORY_READ_BYTES = 256 * 1024;
const HISTORY_HEAD_BYTES = 4 * 1024;
const HISTORY_ANCHOR_BYTES = 4 * 1024;
const HISTORY_MAX_LINE_BYTES = 10 * 1024 * 1024;
const HISTORY_BATCH_ROWS = 1_000;
const HISTORY_IDENTITY_MAX_TURNS = 100;
const HISTORY_IDENTITY_MAX_MESSAGES = 10_000;

export class ConversationSidecarStorage {
  constructor({
    stateDirectory,
    accountId,
    expectedUid,
    expectedGid,
    now = () => Date.now(),
  }) {
    this.stateDirectory = path.resolve(String(stateDirectory || ""));
    this.accountId = validIdentifier(accountId, "account ID");
    this.expectedUid = integerIdentity(expectedUid, "UID");
    this.expectedGid = integerIdentity(expectedGid, "GID");
    this.now = now;
    this.keyPath = path.join(this.stateDirectory, KEY_FILE);
    this.stateDatabasePath = path.join(this.stateDirectory, STATE_DATABASE);
    this.historyDatabasePath = path.join(this.stateDirectory, HISTORY_DATABASE);
    this.masterKey = null;
    this.keyId = null;
    this.keys = null;
    this.stateDatabase = null;
    this.historyDatabase = null;
    this.degradedReason = null;
    this.closed = false;
  }

  initialize() {
    validatePrivateDirectory(this.stateDirectory, this.expectedUid, this.expectedGid);
    const databaseExists = storageFileExists(this.stateDatabasePath)
      || storageFileExists(this.historyDatabasePath);
    const key = loadOrCreateMasterKey(this.keyPath, {
      expectedUid: this.expectedUid,
      expectedGid: this.expectedGid,
      allowCreate: !databaseExists,
    });
    if (key) {
      this.masterKey = key;
      this.keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
      this.keys = deriveSidecarKeys(key, this.accountId);
    } else {
      this.degradedReason = "key-missing";
    }

    try {
      this.stateDatabase = openSidecarDatabase(this.stateDatabasePath, {
        expectedUid: this.expectedUid,
        expectedGid: this.expectedGid,
        readOnly: !this.keys,
        createSchema: this.keys ? createStateSchema : null,
      });
      this.historyDatabase = openSidecarDatabase(this.historyDatabasePath, {
        expectedUid: this.expectedUid,
        expectedGid: this.expectedGid,
        readOnly: !this.keys,
        createSchema: this.keys ? createHistorySchema : null,
      });
    } catch (error) {
      this.degradedReason ||= storageFailureReason(error);
      this.close();
    }
    return this;
  }

  health() {
    const stateIntegrity = databaseIntegrity(this.stateDatabase);
    const historyIntegrity = databaseIntegrity(this.historyDatabase);
    const ok = Boolean(
      !this.closed
      && this.keys
      && stateIntegrity === "ok"
      && historyIntegrity === "ok"
      && !this.degradedReason
    );
    return {
      ok,
      writable: ok,
      accountId: this.accountId,
      schemaVersion: CONVERSATION_SIDECAR_SCHEMA_VERSION,
      keyAvailable: Boolean(this.keys),
      keyId: this.keyId,
      stateIntegrity,
      historyIntegrity,
      degradedReason: this.degradedReason,
      stateDatabase: STATE_DATABASE,
      historyDatabase: HISTORY_DATABASE,
    };
  }

  managementSnapshot() {
    const health = this.health();
    const stateBytes = databaseFilesSize(this.stateDatabasePath);
    const historyBytes = databaseFilesSize(this.historyDatabasePath);
    const keyBytes = regularFileSize(this.keyPath);
    if (!this.stateDatabase || !this.historyDatabase) {
      return {
        ...health,
        storage: {
          totalBytes: stateBytes + historyBytes + keyBytes,
          stateBytes,
          historyBytes,
          keyBytes,
          historySources: 0,
          indexedHistoryRecords: 0,
          indexedHistoryTurns: 0,
        },
      };
    }
    const history = this.historyDatabase.prepare(`
      SELECT
        COUNT(*) AS sources,
        COALESCE(SUM(indexed_records), 0) AS records,
        COALESCE(SUM(indexed_turns), 0) AS turns
      FROM history_sources
      WHERE account_id = ?
    `).get(this.accountId);
    return {
      ...health,
      storage: {
        totalBytes: stateBytes + historyBytes + keyBytes,
        stateBytes,
        historyBytes,
        keyBytes,
        historySources: Number(history?.sources || 0),
        indexedHistoryRecords: Number(history?.records || 0),
        indexedHistoryTurns: Number(history?.turns || 0),
      },
    };
  }

  indexHistory(input) {
    this.assertWritable();
    const sourcePath = path.resolve(String(input?.sourcePath || ""));
    const expectedUid = integerIdentity(input?.expectedUid ?? this.expectedUid, "history UID");
    const expectedGid = integerIdentity(input?.expectedGid ?? this.expectedGid, "history GID");
    const source = validateHistorySource(sourcePath, expectedUid, expectedGid);
    const sourceKey = keyedDigest(this.keys.history, Buffer.from(source.realPath), "history-source");
    const database = this.historyDatabase;
    const previous = selectHistorySource(database, this.accountId, sourceKey);
    const fd = fs.openSync(source.realPath, "r");
    try {
      validateOpenedHistorySource(fd, source.stat, expectedUid, expectedGid);
      const headDigest = fileRangeDigest(
        fd,
        0,
        Math.min(source.stat.size, HISTORY_HEAD_BYTES),
        this.keys.history,
        "head",
      );
      const comparisonHeadDigest = previous
        ? fileRangeDigest(
          fd,
          0,
          Math.min(previous.sourceSize, source.stat.size, HISTORY_HEAD_BYTES),
          this.keys.history,
          "head",
        )
        : headDigest;
      const anchorDigest = previous
        ? fileRangeDigest(
          fd,
          Math.max(0, previous.safeOffset - Math.min(previous.safeOffset, HISTORY_ANCHOR_BYTES)),
          Math.min(previous.safeOffset, HISTORY_ANCHOR_BYTES),
          this.keys.history,
          "anchor",
        )
        : null;
      const rebuildReason = historyRebuildReason(
        previous,
        source.stat,
        comparisonHeadDigest,
        anchorDigest,
      );
      if (rebuildReason) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare("DELETE FROM history_records WHERE account_id = ? AND source_key = ?")
            .run(this.accountId, sourceKey);
          database.prepare("DELETE FROM history_compactions WHERE account_id = ? AND source_key = ?")
            .run(this.accountId, sourceKey);
          database.prepare("DELETE FROM history_turns WHERE account_id = ? AND source_key = ?")
            .run(this.accountId, sourceKey);
          database.prepare("DELETE FROM history_sources WHERE account_id = ? AND source_key = ?")
            .run(this.accountId, sourceKey);
          database.exec("COMMIT");
        } catch (error) {
          rollback(database);
          throw error;
        }
      }
      const checkpoint = rebuildReason ? null : previous;
      const initialTurnIdDigest = checkpoint
        ? selectLatestHistoryTurnDigest(
          database,
          this.accountId,
          sourceKey,
          checkpoint.indexedRecords,
        )
        : null;
      const scan = scanHistoryLines({
        fd,
        startOffset: checkpoint?.safeOffset || 0,
        startRowOrdinal: checkpoint?.indexedRecords || 0,
        initialTurnIdDigest,
        maximumOffset: source.stat.size,
        digestKey: this.keys.history,
        onBatch: (batch) => this.commitHistoryBatch({
          sourceKey,
          source,
          headDigest,
          batch,
        }),
      });
      const finalAnchor = fileRangeDigest(
        fd,
        Math.max(0, scan.safeOffset - Math.min(scan.safeOffset, HISTORY_ANCHOR_BYTES)),
        Math.min(scan.safeOffset, HISTORY_ANCHOR_BYTES),
        this.keys.history,
        "anchor",
      );
      upsertHistorySource(database, {
        accountId: this.accountId,
        sourceKey,
        stat: source.stat,
        headDigest,
        anchorDigest: finalAnchor,
        safeOffset: scan.safeOffset,
        indexedRecords: scan.indexedRecords,
        indexedTurns: historyTurnCount(database, this.accountId, sourceKey),
        trailingBytes: source.stat.size - scan.safeOffset,
        updatedAt: this.now(),
      });
      secureDatabaseFiles(this.historyDatabasePath, this.expectedUid, this.expectedGid);
      return {
        sourceKey,
        rebuildReason,
        rowsIndexed: scan.rowsIndexed,
        oversizedRecords: scan.oversizedRecords,
        safeOffset: scan.safeOffset,
        trailingBytes: source.stat.size - scan.safeOffset,
        indexedRecords: scan.indexedRecords,
        indexedTurns: historyTurnCount(database, this.accountId, sourceKey),
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  historyTurns(input) {
    this.assertReadable();
    const sourceKey = validDigest(input?.sourceKey, "history source key");
    const limit = boundedInteger(input?.limit, 1, 100, 20);
    const before = input?.before == null ? Number.MAX_SAFE_INTEGER : boundedInteger(
      input.before,
      0,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    return this.historyDatabase.prepare(`
      SELECT
        turn_id_digest AS turnIdDigest,
        turn_ordinal AS turnOrdinal,
        first_row_ordinal AS firstRowOrdinal,
        last_row_ordinal AS lastRowOrdinal,
        first_byte AS firstByte,
        last_byte AS lastByte,
        item_count AS itemCount,
        user_count AS userCount
      FROM history_turns
      WHERE account_id = ? AND source_key = ? AND turn_ordinal < ?
      ORDER BY turn_ordinal DESC
      LIMIT ?
    `).all(this.accountId, sourceKey, before, limit);
  }

  historyMessageIdentities(input) {
    this.assertReadable();
    const turnIds = [...new Set(Array.isArray(input?.turnIds) ? input.turnIds : [])]
      .map((turnId) => validIdentifier(turnId, "history Turn ID"));
    if (!turnIds.length || turnIds.length > HISTORY_IDENTITY_MAX_TURNS) {
      throw sidecarError(
        "ERR_HISTORY_TURN_LIMIT",
        `History identity lookup requires 1-${HISTORY_IDENTITY_MAX_TURNS} Turns`,
      );
    }
    const requestedTurnIds = new Set(turnIds);
    const sourcePath = path.resolve(String(input?.sourcePath || ""));
    const source = validateHistorySource(
      sourcePath,
      input?.expectedUid ?? this.expectedUid,
      input?.expectedGid ?? this.expectedGid,
    );
    const indexed = this.indexHistory({
      sourcePath,
      expectedUid: input?.expectedUid ?? this.expectedUid,
      expectedGid: input?.expectedGid ?? this.expectedGid,
    });
    const turnDigestToId = new Map(turnIds.map((turnId) => [
      keyedDigest(this.keys.history, Buffer.from(String(turnId)), "turn"),
      turnId,
    ]));
    const placeholders = [...turnDigestToId].map(() => "?").join(", ");
    const rows = this.historyDatabase.prepare(`
      SELECT
        records.row_ordinal AS rowOrdinal,
        records.byte_start AS byteStart,
        records.byte_end AS byteEnd,
        records.turn_id_digest AS turnIdDigest,
        records.record_digest AS recordDigest,
        (
          SELECT compactions.replacement_digest
          FROM history_compactions AS compactions
          WHERE compactions.account_id = records.account_id
            AND compactions.source_key = records.source_key
            AND compactions.row_ordinal <= records.row_ordinal
          ORDER BY compactions.row_ordinal DESC
          LIMIT 1
        ) AS replacementLineageDigest
      FROM history_records AS records
      WHERE records.account_id = ?
        AND records.source_key = ?
        AND records.top_type = 'response_item'
        AND records.role = 'assistant'
        AND records.item_id_digest IS NOT NULL
        AND records.turn_id_digest IN (${placeholders})
      ORDER BY records.row_ordinal
    `).all(this.accountId, indexed.sourceKey, ...turnDigestToId.keys());
    const fd = fs.openSync(source.realPath, "r");
    const messages = [];
    try {
      validateOpenedHistorySource(
        fd,
        source.stat,
        input?.expectedUid ?? this.expectedUid,
        input?.expectedGid ?? this.expectedGid,
      );
      for (const row of rows) {
        const length = Number(row.byteEnd) - Number(row.byteStart);
        if (length < 1 || length > HISTORY_MAX_LINE_BYTES + 1) continue;
        const line = Buffer.allocUnsafe(length);
        const bytes = fs.readSync(fd, line, 0, length, Number(row.byteStart));
        if (bytes !== length) {
          throw sidecarError("ERR_HISTORY_SOURCE_CHANGED", "History source changed during lookup");
        }
        let value = null;
        try {
          value = JSON.parse(line.subarray(0, line.at(-1) === 0x0a ? -1 : undefined).toString("utf8"));
        } catch {}
        const identity = nativeResponseAssistantIdentity(value);
        if (!identity?.turnId || !requestedTurnIds.has(identity.turnId)) continue;
        messages.push({
          turnId: identity.turnId,
          itemId: identity.itemId,
          fingerprint: identity.fingerprint,
          phase: identity.phase,
          rowOrdinal: row.rowOrdinal,
          recordDigest: row.recordDigest,
          replacementLineageDigest: row.replacementLineageDigest || null,
        });
        if (messages.length > HISTORY_IDENTITY_MAX_MESSAGES) {
          throw sidecarError(
            "ERR_HISTORY_MESSAGE_LIMIT",
            `History identity lookup exceeds ${HISTORY_IDENTITY_MAX_MESSAGES} messages`,
          );
        }
      }
      return {
        sourceSize: source.stat.size,
        scannedFrom: 0,
        // indexHistory performs the complete incremental scan; identity lookup
        // then reads only the indexed response rows from the full source.
        scannedBytes: source.stat.size,
        truncated: false,
        indexedRecords: indexed.indexedRecords,
        indexedTurns: indexed.indexedTurns,
        messages,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  commitHistoryBatch({ sourceKey, source, headDigest, batch }) {
    if (!batch.rows.length) return;
    const database = this.historyDatabase;
    database.exec("BEGIN IMMEDIATE");
    try {
      const insertRecord = database.prepare(`
        INSERT OR REPLACE INTO history_records(
          account_id, source_key, row_ordinal, byte_start, byte_end,
          top_type, subtype, turn_id_digest, item_id_digest, client_id_digest,
          role, phase, record_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const upsertTurn = database.prepare(`
        INSERT INTO history_turns(
          account_id, source_key, turn_id_digest, turn_ordinal,
          first_row_ordinal, last_row_ordinal, first_byte, last_byte,
          item_count, user_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, source_key, turn_id_digest) DO UPDATE SET
          last_row_ordinal = excluded.last_row_ordinal,
          last_byte = excluded.last_byte,
          item_count = history_turns.item_count + excluded.item_count,
          user_count = history_turns.user_count + excluded.user_count
      `);
      const insertCompaction = database.prepare(`
        INSERT OR REPLACE INTO history_compactions(
          account_id, source_key, row_ordinal, window_id_digest,
          previous_window_id_digest, first_window_id_digest,
          replacement_digest, replacement_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of batch.rows) {
        insertRecord.run(
          this.accountId,
          sourceKey,
          row.rowOrdinal,
          row.byteStart,
          row.byteEnd,
          row.topType,
          row.subtype,
          row.turnIdDigest,
          row.itemIdDigest,
          row.clientIdDigest,
          row.role,
          row.phase,
          row.recordDigest,
        );
        if (row.compaction) {
          insertCompaction.run(
            this.accountId,
            sourceKey,
            row.rowOrdinal,
            row.compaction.windowIdDigest,
            row.compaction.previousWindowIdDigest,
            row.compaction.firstWindowIdDigest,
            row.compaction.replacementDigest,
            row.compaction.replacementCount,
          );
        }
      }
      for (const turn of batch.turns.values()) {
        upsertTurn.run(
          this.accountId,
          sourceKey,
          turn.turnIdDigest,
          turn.turnOrdinal,
          turn.firstRowOrdinal,
          turn.lastRowOrdinal,
          turn.firstByte,
          turn.lastByte,
          turn.itemCount,
          turn.userCount,
        );
      }
      const anchorDigest = fileRangeDigest(
        batch.fd,
        Math.max(0, batch.safeOffset - Math.min(batch.safeOffset, HISTORY_ANCHOR_BYTES)),
        Math.min(batch.safeOffset, HISTORY_ANCHOR_BYTES),
        this.keys.history,
        "anchor",
      );
      upsertHistorySource(database, {
        accountId: this.accountId,
        sourceKey,
        stat: source.stat,
        headDigest,
        anchorDigest,
        safeOffset: batch.safeOffset,
        indexedRecords: batch.indexedRecords,
        indexedTurns: historyTurnCount(database, this.accountId, sourceKey),
        trailingBytes: Math.max(0, source.stat.size - batch.safeOffset),
        updatedAt: this.now(),
      });
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
  }

  assertReadable() {
    if (this.closed || !this.stateDatabase || !this.historyDatabase) {
      throw sidecarError("ERR_SIDECAR_DEGRADED", this.degradedReason || "Sidecar is unavailable");
    }
  }

  assertWritable() {
    this.assertReadable();
    if (!this.keys || this.degradedReason) {
      throw sidecarError("ERR_SIDECAR_DEGRADED", this.degradedReason || "Sidecar is read-only");
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const database of [this.stateDatabase, this.historyDatabase]) {
      try {
        database?.close();
      } catch {}
    }
    this.stateDatabase = null;
    this.historyDatabase = null;
    if (this.masterKey) this.masterKey.fill(0);
    for (const key of Object.values(this.keys || {})) key.fill?.(0);
    this.masterKey = null;
    this.keys = null;
  }
}

function databaseFilesSize(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .reduce((total, filename) => total + regularFileSize(filename), 0);
}

function regularFileSize(filename) {
  try {
    const stat = fs.statSync(filename, { bigint: false });
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function createStateSchema(database) {
  // Event replay, ACK, source mapping, and submission/outbox tables belonged
  // to the superseded conversation recovery design. Sidecar initialization
  // removes those records and retains only rebuildable index metadata.
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS ack_leases;
    DROP TABLE IF EXISTS source_mappings;
    DROP TABLE IF EXISTS event_contents;
    DROP TABLE IF EXISTS event_log;
    DROP TABLE IF EXISTS event_state;
    DROP TABLE IF EXISTS submission_transitions;
    DROP TABLE IF EXISTS submissions;
    DROP TABLE IF EXISTS operation_ledger;
    DROP TABLE IF EXISTS migration_journal;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sidecar_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(`
    INSERT INTO sidecar_metadata(key, value) VALUES ('schema-version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(CONVERSATION_SIDECAR_SCHEMA_VERSION));
}

function createHistorySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sidecar_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS history_sources (
      account_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      source_size INTEGER NOT NULL CHECK(source_size >= 0),
      source_mtime_ms INTEGER NOT NULL CHECK(source_mtime_ms >= 0),
      head_digest TEXT NOT NULL,
      anchor_digest TEXT NOT NULL,
      safe_offset INTEGER NOT NULL CHECK(safe_offset >= 0),
      indexed_records INTEGER NOT NULL CHECK(indexed_records >= 0),
      indexed_turns INTEGER NOT NULL CHECK(indexed_turns >= 0),
      trailing_bytes INTEGER NOT NULL CHECK(trailing_bytes >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(account_id, source_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS history_turns (
      account_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      turn_id_digest TEXT NOT NULL,
      turn_ordinal INTEGER NOT NULL CHECK(turn_ordinal >= 0),
      first_row_ordinal INTEGER NOT NULL,
      last_row_ordinal INTEGER NOT NULL,
      first_byte INTEGER NOT NULL,
      last_byte INTEGER NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      user_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id, source_key, turn_id_digest)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS history_records (
      account_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      row_ordinal INTEGER NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      top_type TEXT NOT NULL,
      subtype TEXT,
      turn_id_digest TEXT,
      item_id_digest TEXT,
      client_id_digest TEXT,
      role TEXT,
      phase TEXT,
      record_digest TEXT NOT NULL,
      PRIMARY KEY(account_id, source_key, row_ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS history_compactions (
      account_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      row_ordinal INTEGER NOT NULL,
      window_id_digest TEXT,
      previous_window_id_digest TEXT,
      first_window_id_digest TEXT,
      replacement_digest TEXT NOT NULL,
      replacement_count INTEGER NOT NULL CHECK(replacement_count >= 0),
      PRIMARY KEY(account_id, source_key, row_ordinal)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS history_turn_order
      ON history_turns(account_id, source_key, turn_ordinal DESC);
    CREATE INDEX IF NOT EXISTS history_client_id
      ON history_records(account_id, client_id_digest)
      WHERE client_id_digest IS NOT NULL;
    CREATE INDEX IF NOT EXISTS history_item_id
      ON history_records(account_id, item_id_digest)
      WHERE item_id_digest IS NOT NULL;
    CREATE INDEX IF NOT EXISTS history_compaction_order
      ON history_compactions(account_id, source_key, row_ordinal DESC);
  `);
  database.prepare(`
    INSERT INTO sidecar_metadata(key, value) VALUES ('schema-version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(CONVERSATION_SIDECAR_SCHEMA_VERSION));
}

function openSidecarDatabase(filename, {
  expectedUid,
  expectedGid,
  readOnly,
  createSchema,
}) {
  validateStoragePath(filename, expectedUid, expectedGid);
  const existed = storageFileExists(filename);
  if (readOnly && !existed) return null;
  const database = readOnly
    ? new DatabaseSync(filename, { readOnly: true })
    : new DatabaseSync(filename);
  if (!readOnly) {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA temp_store = MEMORY;
    `);
    const journalMode = String(database.prepare("PRAGMA journal_mode = WAL").get().journal_mode).toLowerCase();
    if (journalMode !== "wal") throw sidecarError("ERR_STORAGE_MODE", "SQLite WAL mode is unavailable");
    createSchema?.(database);
    secureDatabaseFiles(filename, expectedUid, expectedGid);
  } else {
    database.exec("PRAGMA query_only = ON;");
  }
  return database;
}

function validatePrivateDirectory(directory, expectedUid, expectedGid) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw sidecarError("ERR_STORAGE_LAYOUT", "Sidecar state directory must be a real directory");
  }
  if (fs.realpathSync(directory) !== path.resolve(directory)) {
    throw sidecarError("ERR_STORAGE_LAYOUT", "Sidecar state directory may not traverse symlinks");
  }
  if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
    throw sidecarError("ERR_STORAGE_OWNER", "Sidecar state directory owner does not match the account");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw sidecarError("ERR_STORAGE_MODE", "Sidecar state directory must not be group/world accessible");
  }
}

function validateStoragePath(filename, expectedUid, expectedGid) {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (!storageFileExists(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw sidecarError("ERR_STORAGE_LAYOUT", "Sidecar storage files must be regular files");
    }
    if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
      throw sidecarError("ERR_STORAGE_OWNER", "Sidecar storage file owner does not match the account");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw sidecarError("ERR_STORAGE_MODE", "Sidecar storage files must use owner-only permissions");
    }
  }
}

function secureDatabaseFiles(filename, expectedUid, expectedGid) {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (!storageFileExists(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw sidecarError("ERR_STORAGE_LAYOUT", "Sidecar storage file changed type");
    }
    if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
      throw sidecarError("ERR_STORAGE_OWNER", "Sidecar storage file changed owner");
    }
    fs.chmodSync(candidate, 0o600);
  }
}

function loadOrCreateMasterKey(filename, { expectedUid, expectedGid, allowCreate }) {
  if (storageFileExists(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== KEY_BYTES) {
      throw sidecarError("ERR_KEY_INVALID", "Conversation state key is invalid");
    }
    if (stat.uid !== expectedUid || stat.gid !== expectedGid || (stat.mode & 0o777) !== 0o600) {
      throw sidecarError("ERR_KEY_PERMISSIONS", "Conversation state key must be owner-only");
    }
    return fs.readFileSync(filename);
  }
  if (!allowCreate) return null;
  const key = randomBytes(KEY_BYTES);
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filename, 0o600);
  const stat = fs.lstatSync(filename);
  if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
    throw sidecarError("ERR_KEY_PERMISSIONS", "Conversation state key owner is invalid");
  }
  return key;
}

function deriveSidecarKeys(masterKey, accountId) {
  const salt = createHash("sha256").update(`wfl-conversation-sidecar:${accountId}`).digest();
  const derive = (purpose) => Buffer.from(hkdfSync(
    "sha256",
    masterKey,
    salt,
    Buffer.from(`wfl-conversation-sidecar-v1:${purpose}`),
    32,
  ));
  return {
    history: derive("history"),
  };
}

function keyedDigest(key, value, domain) {
  return createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
}

function validateHistorySource(filename, expectedUid, expectedGid) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw sidecarError("ERR_HISTORY_SOURCE", "History source must be a regular file");
  }
  if (fs.realpathSync(filename) !== filename) {
    throw sidecarError("ERR_HISTORY_SOURCE", "History source may not traverse symlinks");
  }
  if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
    throw sidecarError("ERR_HISTORY_OWNER", "History source owner does not match the account");
  }
  if ((stat.mode & 0o022) !== 0) {
    throw sidecarError("ERR_HISTORY_MODE", "History source must be owner-only");
  }
  if ((stat.mode & 0o044) !== 0 && !hasPrivateOwnerBoundary(filename, expectedUid)) {
    throw sidecarError(
      "ERR_HISTORY_MODE",
      "Readable history source must remain behind an owner-private directory",
    );
  }
  return { realPath: filename, stat };
}

function validateOpenedHistorySource(fd, expectedStat, expectedUid, expectedGid) {
  const stat = fs.fstatSync(fd);
  if (
    !stat.isFile()
    || stat.uid !== expectedUid
    || stat.gid !== expectedGid
    || (stat.mode & 0o022) !== 0
    || Number(stat.dev) !== Number(expectedStat.dev)
    || Number(stat.ino) !== Number(expectedStat.ino)
  ) {
    throw sidecarError(
      "ERR_HISTORY_SOURCE_CHANGED",
      "History source changed while it was being opened",
    );
  }
}

function hasPrivateOwnerBoundary(filename, expectedUid) {
  let current = path.dirname(filename);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory() && stat.uid === expectedUid && (stat.mode & 0o077) === 0) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function scanHistoryLines({
  fd,
  startOffset,
  startRowOrdinal,
  initialTurnIdDigest,
  maximumOffset,
  digestKey,
  onBatch,
}) {
  let position = startOffset;
  let safeOffset = startOffset;
  let rowOrdinal = startRowOrdinal;
  let currentTurnIdDigest = initialTurnIdDigest || null;
  let carry = Buffer.alloc(0);
  let carryStart = startOffset;
  let oversizedDigest = null;
  let oversizedRecords = 0;
  let rowsIndexed = 0;
  let batch = newHistoryBatch(fd);
  while (position < maximumOffset) {
    const chunk = Buffer.allocUnsafe(Math.min(HISTORY_READ_BYTES, maximumOffset - position));
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      const newline = chunk.indexOf(0x0a, cursor);
      const segmentEnd = newline === -1 || newline >= bytesRead ? bytesRead : newline;
      const segment = chunk.subarray(cursor, segmentEnd);
      if (oversizedDigest) {
        oversizedDigest.update(segment);
      } else if (carry.length + segment.length <= HISTORY_MAX_LINE_BYTES) {
        carry = carry.length ? Buffer.concat([carry, segment]) : Buffer.from(segment);
      } else {
        oversizedDigest = createHmac("sha256", digestKey)
          .update("history-record")
          .update("\0")
          .update(carry)
          .update(segment);
        carry = Buffer.alloc(0);
      }
      if (newline === -1 || newline >= bytesRead) break;
      const byteStart = carryStart;
      const byteEnd = position + newline + 1;
      rowOrdinal += 1;
      rowsIndexed += 1;
      const row = oversizedDigest
        ? oversizedHistoryRow({
          rowOrdinal,
          byteStart,
          byteEnd,
          recordDigest: oversizedDigest.digest("hex"),
        })
        : historyRow(carry, {
          rowOrdinal,
          byteStart,
          byteEnd,
          digestKey,
        });
      if (oversizedDigest) oversizedRecords += 1;
      if (row.turnIdDigest) {
        currentTurnIdDigest = row.turnIdDigest;
      } else {
        row.turnIdDigest = currentTurnIdDigest;
      }
      batch.rows.push(row);
      addHistoryTurn(batch.turns, row);
      safeOffset = byteEnd;
      batch.safeOffset = safeOffset;
      batch.indexedRecords = rowOrdinal;
      cursor = newline + 1;
      if (batch.rows.length >= HISTORY_BATCH_ROWS) {
        onBatch(batch);
        batch = newHistoryBatch(fd);
      }
      carry = Buffer.alloc(0);
      oversizedDigest = null;
      carryStart = byteEnd;
      cursor = newline + 1;
    }
    position += bytesRead;
  }
  if (batch.rows.length) onBatch(batch);
  return { safeOffset, indexedRecords: rowOrdinal, rowsIndexed, oversizedRecords };
}

function newHistoryBatch(fd) {
  return {
    fd,
    rows: [],
    turns: new Map(),
    safeOffset: 0,
    indexedRecords: 0,
  };
}

function historyRow(line, { rowOrdinal, byteStart, byteEnd, digestKey }) {
  let value = null;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {}
  const payload = value?.payload && typeof value.payload === "object" ? value.payload : {};
  const topType = safeOptionalClass(value?.type) || "invalid";
  const subtype = safeOptionalClass(payload.type || payload.event_type || payload.kind);
  const turnId = payload.turn_id
    || payload.turnId
    || payload.turn?.id
    || payload.context?.turn_id
    || payload.internal_chat_message_metadata_passthrough?.turn_id
    || null;
  const itemId = payload.id || payload.item?.id || payload.item_id || null;
  const clientId = payload.client_id
    || payload.clientId
    || payload.item?.clientId
    || payload.message?.client_id
    || null;
  const role = safeOptionalClass(payload.role || payload.item?.role);
  const phase = safeOptionalClass(payload.phase || payload.status?.type || payload.status);
  const compaction = topType === "compacted" && Array.isArray(payload.replacement_history)
    ? {
      windowIdDigest: optionalKeyedDigest(digestKey, payload.window_id, "compaction-window"),
      previousWindowIdDigest: optionalKeyedDigest(
        digestKey,
        payload.previous_window_id,
        "compaction-window",
      ),
      firstWindowIdDigest: optionalKeyedDigest(
        digestKey,
        payload.first_window_id,
        "compaction-window",
      ),
      replacementDigest: keyedDigest(
        digestKey,
        Buffer.from(stableStringify(payload.replacement_history)),
        "compaction-replacement",
      ),
      replacementCount: payload.replacement_history.length,
    }
    : null;
  return {
    rowOrdinal,
    byteStart,
    byteEnd,
    topType,
    subtype,
    turnIdDigest: optionalKeyedDigest(digestKey, turnId, "turn"),
    itemIdDigest: optionalKeyedDigest(digestKey, itemId, "item"),
    clientIdDigest: optionalKeyedDigest(digestKey, clientId, "client"),
    role,
    phase,
    compaction,
    recordDigest: keyedDigest(digestKey, line, "history-record"),
  };
}

function oversizedHistoryRow({ rowOrdinal, byteStart, byteEnd, recordDigest }) {
  return {
    rowOrdinal,
    byteStart,
    byteEnd,
    topType: "oversized",
    subtype: null,
    turnIdDigest: null,
    itemIdDigest: null,
    clientIdDigest: null,
    role: null,
    phase: null,
    compaction: null,
    recordDigest,
  };
}

function addHistoryTurn(turns, row) {
  if (!row.turnIdDigest) return;
  let turn = turns.get(row.turnIdDigest);
  if (!turn) {
    turn = {
      turnIdDigest: row.turnIdDigest,
      turnOrdinal: row.rowOrdinal,
      firstRowOrdinal: row.rowOrdinal,
      lastRowOrdinal: row.rowOrdinal,
      firstByte: row.byteStart,
      lastByte: row.byteEnd,
      itemCount: 0,
      userCount: 0,
    };
    turns.set(row.turnIdDigest, turn);
  }
  turn.lastRowOrdinal = row.rowOrdinal;
  turn.lastByte = row.byteEnd;
  if (row.itemIdDigest) turn.itemCount += 1;
  if (row.clientIdDigest) turn.userCount += 1;
}

function selectHistorySource(database, accountId, sourceKey) {
  return database.prepare(`
    SELECT
      device, inode, source_size AS sourceSize, source_mtime_ms AS sourceMtimeMs,
      head_digest AS headDigest, anchor_digest AS anchorDigest,
      safe_offset AS safeOffset, indexed_records AS indexedRecords,
      indexed_turns AS indexedTurns, trailing_bytes AS trailingBytes,
      updated_at AS updatedAt
    FROM history_sources
    WHERE account_id = ? AND source_key = ?
  `).get(accountId, sourceKey) || null;
}

function selectLatestHistoryTurnDigest(database, accountId, sourceKey, rowOrdinal) {
  return database.prepare(`
    SELECT turn_id_digest AS turnIdDigest
    FROM history_records
    WHERE account_id = ?
      AND source_key = ?
      AND row_ordinal <= ?
      AND turn_id_digest IS NOT NULL
    ORDER BY row_ordinal DESC
    LIMIT 1
  `).get(accountId, sourceKey, rowOrdinal)?.turnIdDigest || null;
}

function historyRebuildReason(previous, stat, headDigest, anchorDigest) {
  if (!previous) return "new-source";
  if (Number(previous.device) !== Number(stat.dev)) return "device-changed";
  if (Number(previous.inode) !== Number(stat.ino)) return "inode-changed";
  if (Number(stat.size) < Number(previous.safeOffset)) return "source-truncated";
  if (previous.headDigest !== headDigest) return "head-prefix-changed";
  if (previous.anchorDigest !== anchorDigest) return "indexed-anchor-changed";
  return null;
}

function upsertHistorySource(database, {
  accountId,
  sourceKey,
  stat,
  headDigest,
  anchorDigest,
  safeOffset,
  indexedRecords,
  indexedTurns,
  trailingBytes,
  updatedAt,
}) {
  database.prepare(`
    INSERT INTO history_sources(
      account_id, source_key, device, inode, source_size, source_mtime_ms,
      head_digest, anchor_digest, safe_offset, indexed_records, indexed_turns,
      trailing_bytes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, source_key) DO UPDATE SET
      device = excluded.device,
      inode = excluded.inode,
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      head_digest = excluded.head_digest,
      anchor_digest = excluded.anchor_digest,
      safe_offset = excluded.safe_offset,
      indexed_records = excluded.indexed_records,
      indexed_turns = excluded.indexed_turns,
      trailing_bytes = excluded.trailing_bytes,
      updated_at = excluded.updated_at
  `).run(
    accountId,
    sourceKey,
    Number(stat.dev),
    Number(stat.ino),
    Number(stat.size),
    Math.max(0, Math.round(stat.mtimeMs)),
    headDigest,
    anchorDigest,
    safeOffset,
    indexedRecords,
    indexedTurns,
    trailingBytes,
    updatedAt,
  );
}

function historyTurnCount(database, accountId, sourceKey) {
  return Number(database.prepare(`
    SELECT count(*) AS count
    FROM history_turns
    WHERE account_id = ? AND source_key = ?
  `).get(accountId, sourceKey).count);
}

function fileRangeDigest(fd, start, length, key, domain) {
  if (!length) return keyedDigest(key, Buffer.alloc(0), domain);
  const buffer = Buffer.allocUnsafe(length);
  const bytes = fs.readSync(fd, buffer, 0, length, start);
  return keyedDigest(key, buffer.subarray(0, bytes), domain);
}

function databaseIntegrity(database) {
  if (!database) return "unavailable";
  try {
    return String(database.prepare("PRAGMA quick_check").get().quick_check || "unknown");
  } catch {
    return "corrupt";
  }
}

function storageFailureReason(error) {
  if (error?.code?.startsWith("ERR_")) return error.code.toLowerCase().replace(/^err_/, "").replaceAll("_", "-");
  return /malformed|not a database|database disk image/i.test(String(error?.message || ""))
    ? "database-corrupt"
    : "database-unavailable";
}

function storageFileExists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function validIdentifier(value, label) {
  const text = String(value || "");
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw sidecarError("ERR_INVALID_IDENTIFIER", `Invalid ${label}`);
  }
  return text;
}

function optionalIdentifier(value, label) {
  if (value == null || value === "") return null;
  return validIdentifier(value, label);
}

function validDigest(value, label) {
  const text = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(text)) throw sidecarError("ERR_INVALID_DIGEST", `Invalid ${label}`);
  return text;
}

function integerIdentity(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw sidecarError("ERR_INVALID_IDENTITY", `Invalid ${label}`);
  }
  return number;
}

function safeTimestamp(value, fallback) {
  const timestamp = value == null ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw sidecarError("ERR_INVALID_TIMESTAMP", "Invalid timestamp");
  }
  return timestamp;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw sidecarError("ERR_INVALID_LIMIT", "Numeric value is outside the allowed range");
  }
  return number;
}

function safeClass(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) {
    throw sidecarError("ERR_INVALID_CLASS", "Invalid protocol class");
  }
  return text;
}

function safeOptionalClass(value) {
  if (value == null || value === "") return null;
  try {
    return safeClass(value);
  } catch {
    return "unknown";
  }
}

function optionalKeyedDigest(key, value, domain) {
  if (typeof value !== "string" || !value) return null;
  return keyedDigest(key, Buffer.from(value), domain);
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
      throw sidecarError("ERR_INVALID_PAYLOAD", "Index payload is not JSON serializable");
    }
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (seen.has(value)) throw sidecarError("ERR_INVALID_PAYLOAD", "Index payload contains a cycle");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => stableValue(entry, seen));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      result[key] = stableValue(entry, seen);
    }
  }
  seen.delete(value);
  return result;
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function rollback(database) {
  try {
    database.exec("ROLLBACK");
  } catch {}
}

function sidecarError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
