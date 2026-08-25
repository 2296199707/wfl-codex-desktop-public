import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptPath = fileURLToPath(import.meta.url);
const ACCOUNT_ID = "account-storage-probe";
const EVENT_LOG_GENERATION = "event-log-generation-storage-probe";
const MEBIBYTE = 1024 * 1024;
const SCHEMA_VERSION = 1;
const CRASH_STAGES = [
  "after-event",
  "after-source",
  "after-task",
  "after-account-cursor",
  "after-commit",
];

const benchmarkCases = [
  { payloadBytes: 256, eventCount: 512, batchSizes: [1, 16, 64] },
  { payloadBytes: 4 * 1024, eventCount: 512, batchSizes: [1, 16, 64] },
  { payloadBytes: 64 * 1024, eventCount: 64, batchSizes: [1, 8, 32] },
  { payloadBytes: 256 * 1024, eventCount: 16, batchSizes: [1, 4] },
];

class EventLogWriter {
  constructor(database, {
    accountId,
    eventLogGeneration,
    keyring,
  }) {
    this.database = database;
    this.accountId = accountId;
    this.eventLogGeneration = eventLogGeneration;
    this.keyring = keyring;
    this.selectCursor = database.prepare(`
      SELECT last_cursor AS lastCursor
      FROM account_cursors
      WHERE account_id = ?
    `);
    this.ensureAccount = database.prepare(`
      INSERT OR IGNORE INTO account_cursors(account_id, event_log_generation, last_cursor)
      VALUES (?, ?, 0)
    `);
    this.selectSource = database.prepare(`
      SELECT event_cursor AS eventCursor
      FROM source_mappings
      WHERE account_id = ? AND source_id = ?
    `);
    this.insertEvent = database.prepare(`
      INSERT INTO events(
        account_id,
        event_log_generation,
        event_cursor,
        source_id,
        thread_id,
        event_type,
        canonical_ref,
        key_id,
        nonce,
        auth_tag,
        payload_cipher,
        payload_bytes,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertSource = database.prepare(`
      INSERT INTO source_mappings(
        account_id,
        source_id,
        event_cursor,
        canonical_ref
      ) VALUES (?, ?, ?, ?)
    `);
    this.upsertTask = database.prepare(`
      INSERT INTO task_states(
        account_id,
        task_id,
        state,
        updated_cursor
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, task_id) DO UPDATE SET
        state = excluded.state,
        updated_cursor = excluded.updated_cursor
      WHERE excluded.updated_cursor >= task_states.updated_cursor
    `);
    this.updateCursor = database.prepare(`
      UPDATE account_cursors
      SET last_cursor = ?
      WHERE account_id = ?
    `);
  }

  appendBatch(inputs) {
    const results = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.ensureAccount.run(this.accountId, this.eventLogGeneration);
      const cursorRow = this.selectCursor.get(this.accountId);
      assert.ok(cursorRow);
      let eventCursor = Number(cursorRow.lastCursor);

      for (const input of inputs) {
        const existing = this.selectSource.get(this.accountId, input.sourceId);
        if (existing) {
          results.push({
            duplicate: true,
            eventCursor: Number(existing.eventCursor),
          });
          continue;
        }

        const key = this.keyring.get(input.keyId);
        if (!key) {
          throw new Error(`event payload key is unavailable: ${input.keyId}`);
        }
        eventCursor += 1;
        const aad = makeAad({
          accountId: this.accountId,
          eventLogGeneration: this.eventLogGeneration,
          eventCursor,
          sourceId: input.sourceId,
          eventType: input.eventType,
          canonicalRef: input.canonicalRef,
        });
        const sealed = sealPayload(key, input.payload, aad);
        this.insertEvent.run(
          this.accountId,
          this.eventLogGeneration,
          eventCursor,
          input.sourceId,
          input.threadId,
          input.eventType,
          input.canonicalRef,
          input.keyId,
          sealed.nonce,
          sealed.authTag,
          sealed.ciphertext,
          input.payload.length,
          input.createdAt,
        );
        this.insertSource.run(
          this.accountId,
          input.sourceId,
          eventCursor,
          input.canonicalRef,
        );
        this.upsertTask.run(
          this.accountId,
          input.taskId,
          input.taskState,
          eventCursor,
        );
        results.push({ duplicate: false, eventCursor });
      }

      this.updateCursor.run(eventCursor, this.accountId);
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The original storage error is the useful failure.
      }
      throw error;
    }
  }
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
  createSchema(database);
  fs.chmodSync(databasePath, 0o600);
  return database;
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_cursors (
      account_id TEXT PRIMARY KEY,
      event_log_generation TEXT NOT NULL,
      last_cursor INTEGER NOT NULL CHECK(last_cursor >= 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS events (
      account_id TEXT NOT NULL,
      event_log_generation TEXT NOT NULL,
      event_cursor INTEGER NOT NULL CHECK(event_cursor > 0),
      source_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      canonical_ref TEXT NOT NULL,
      key_id TEXT NOT NULL,
      nonce BLOB NOT NULL CHECK(length(nonce) = 12),
      auth_tag BLOB NOT NULL CHECK(length(auth_tag) = 16),
      payload_cipher BLOB NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(account_id, event_cursor),
      UNIQUE(account_id, source_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS source_mappings (
      account_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      event_cursor INTEGER NOT NULL,
      canonical_ref TEXT NOT NULL,
      PRIMARY KEY(account_id, source_id),
      UNIQUE(account_id, event_cursor),
      FOREIGN KEY(account_id, event_cursor)
        REFERENCES events(account_id, event_cursor)
        ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS task_states (
      account_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_cursor INTEGER NOT NULL,
      PRIMARY KEY(account_id, task_id),
      FOREIGN KEY(account_id, updated_cursor)
        REFERENCES events(account_id, event_cursor)
    ) STRICT;
  `);
}

function makeAad({
  accountId,
  eventLogGeneration,
  eventCursor,
  sourceId,
  eventType,
  canonicalRef,
}) {
  return Buffer.from(JSON.stringify([
    SCHEMA_VERSION,
    accountId,
    eventLogGeneration,
    eventCursor,
    sourceId,
    eventType,
    canonicalRef,
  ]));
}

function sealPayload(key, payload, aad) {
  assert.equal(key.length, 32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(payload),
    cipher.final(),
  ]);
  return {
    nonce,
    authTag: cipher.getAuthTag(),
    ciphertext,
  };
}

function openPayload(key, row) {
  const aad = makeAad({
    accountId: row.accountId,
    eventLogGeneration: row.eventLogGeneration,
    eventCursor: Number(row.eventCursor),
    sourceId: row.sourceId,
    eventType: row.eventType,
    canonicalRef: row.canonicalRef,
  });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    row.nonce,
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(row.authTag);
  return Buffer.concat([
    decipher.update(row.payloadCipher),
    decipher.final(),
  ]);
}

function readEvent(database, eventCursor) {
  return database.prepare(`
    SELECT
      account_id AS accountId,
      event_log_generation AS eventLogGeneration,
      event_cursor AS eventCursor,
      source_id AS sourceId,
      event_type AS eventType,
      canonical_ref AS canonicalRef,
      key_id AS keyId,
      nonce,
      auth_tag AS authTag,
      payload_cipher AS payloadCipher,
      payload_bytes AS payloadBytes
    FROM events
    WHERE account_id = ? AND event_cursor = ?
  `).get(ACCOUNT_ID, eventCursor);
}

function createInput({
  index,
  payload,
  keyId,
  prefix,
}) {
  return {
    sourceId: `${prefix}:source:${index}`,
    threadId: `${prefix}:thread:${index % 4}`,
    eventType: index % 7 === 0 ? "turn/completed" : "item/delta",
    canonicalRef: `${prefix}:entity:${index}`,
    taskId: `${prefix}:task:${index % 4}`,
    taskState: index % 7 === 0 ? "completed" : "inProgress",
    keyId,
    payload,
    createdAt: 1_785_000_000_000 + index,
  };
}

function makePayload(payloadBytes, index) {
  const payload = Buffer.alloc(payloadBytes, index % 251);
  if (payloadBytes >= 8) {
    payload.writeUInt32BE(index >>> 0, 0);
    payload.writeUInt32BE(payloadBytes >>> 0, 4);
  }
  return payload;
}

function runBenchmarkCase(directory, config, repetition) {
  const name = [
    `payload-${config.payloadBytes}`,
    `batch-${config.batchSize}`,
    `repeat-${repetition}`,
  ].join("-");
  const databasePath = path.join(directory, `${name}.sqlite`);
  const database = openDatabase(databasePath);
  const keyId = "benchmark-key";
  const key = randomBytes(32);
  const writer = new EventLogWriter(database, {
    accountId: ACCOUNT_ID,
    eventLogGeneration: EVENT_LOG_GENERATION,
    keyring: new Map([[keyId, key]]),
  });
  const transactionDurations = [];
  const startedAt = performance.now();

  for (let offset = 0; offset < config.eventCount; offset += config.batchSize) {
    const count = Math.min(config.batchSize, config.eventCount - offset);
    const inputs = Array.from({ length: count }, (_, batchIndex) => {
      const index = offset + batchIndex + 1;
      return createInput({
        index,
        payload: makePayload(config.payloadBytes, index),
        keyId,
        prefix: name,
      });
    });
    const transactionStartedAt = performance.now();
    const results = writer.appendBatch(inputs);
    transactionDurations.push(performance.now() - transactionStartedAt);
    assert.equal(results.length, inputs.length);
    assert.equal(results.some((result) => result.duplicate), false);
  }

  const durationMs = performance.now() - startedAt;
  const rowCount = Number(
    database.prepare("SELECT count(*) AS count FROM events").get().count,
  );
  const cursor = Number(
    database.prepare(`
      SELECT last_cursor AS cursor
      FROM account_cursors
      WHERE account_id = ?
    `).get(ACCOUNT_ID).cursor,
  );
  assert.equal(rowCount, config.eventCount);
  assert.equal(cursor, config.eventCount);

  const sampleCursors = [...new Set([
    1,
    Math.ceil(config.eventCount / 2),
    config.eventCount,
  ])];
  for (const sampleCursor of sampleCursors) {
    const row = readEvent(database, sampleCursor);
    const plaintext = openPayload(key, row);
    assert.equal(plaintext.length, config.payloadBytes);
    assert.deepEqual(
      plaintext,
      makePayload(config.payloadBytes, sampleCursor),
    );
  }

  checkpoint(database);
  const sizes = databaseFileSizes(databasePath);
  const modes = databaseFileModes(databasePath);
  assertPrivateModes(modes);
  database.close();

  const inputBytes = config.payloadBytes * config.eventCount;
  return {
    payloadBytes: config.payloadBytes,
    eventCount: config.eventCount,
    batchSize: config.batchSize,
    transactions: transactionDurations.length,
    durationMs: round(durationMs),
    transactionMs: {
      p50: round(percentile(transactionDurations, 0.5)),
      p95: round(percentile(transactionDurations, 0.95)),
      p99: round(percentile(transactionDurations, 0.99)),
      max: round(Math.max(...transactionDurations)),
    },
    eventsPerSecond: round(config.eventCount / (durationMs / 1_000)),
    inputMiBPerSecond: round((inputBytes / MEBIBYTE) / (durationMs / 1_000)),
    databaseBytes: sizes.database,
    walBytesAfterCheckpoint: sizes.wal,
    databaseBytesPerEvent: round(sizes.database / config.eventCount),
    estimatedDatabaseMiBAt50kEvents: round(
      (sizes.database / config.eventCount) * 50_000 / MEBIBYTE,
    ),
    fileModes: modes,
    samplesDecrypted: sampleCursors.length,
  };
}

function runSecurityChecks(directory) {
  const databasePath = path.join(directory, "security.sqlite");
  const database = openDatabase(databasePath);
  const keyring = new Map([
    ["key-old", randomBytes(32)],
    ["key-current", randomBytes(32)],
  ]);
  const writer = new EventLogWriter(database, {
    accountId: ACCOUNT_ID,
    eventLogGeneration: EVENT_LOG_GENERATION,
    keyring,
  });
  const sentinel = Buffer.from(
    "WFL_EVENT_LOG_PLAINTEXT_SENTINEL_7f14c2d9".repeat(32),
  );
  writer.appendBatch([
    createInput({
      index: 1,
      payload: sentinel,
      keyId: "key-old",
      prefix: "security",
    }),
    createInput({
      index: 2,
      payload: Buffer.from("current-key-payload"),
      keyId: "key-current",
      prefix: "security",
    }),
  ]);

  const oldRow = readEvent(database, 1);
  const currentRow = readEvent(database, 2);
  assert.deepEqual(openPayload(keyring.get("key-old"), oldRow), sentinel);
  assert.equal(
    openPayload(keyring.get("key-current"), currentRow).toString(),
    "current-key-payload",
  );

  const cursorBeforeMissingKey = Number(
    database.prepare(`
      SELECT last_cursor AS cursor
      FROM account_cursors
      WHERE account_id = ?
    `).get(ACCOUNT_ID).cursor,
  );
  keyring.delete("key-current");
  assert.throws(
    () => writer.appendBatch([
      createInput({
        index: 3,
        payload: Buffer.from("must-not-be-written"),
        keyId: "key-current",
        prefix: "security",
      }),
    ]),
    /key is unavailable/,
  );
  const stateAfterMissingKey = database.prepare(`
    SELECT
      (SELECT last_cursor FROM account_cursors WHERE account_id = ?) AS cursor,
      (SELECT count(*) FROM events WHERE account_id = ?) AS eventCount,
      (SELECT count(*) FROM source_mappings WHERE account_id = ?) AS sourceCount
  `).get(ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID);
  assert.equal(Number(stateAfterMissingKey.cursor), cursorBeforeMissingKey);
  assert.equal(Number(stateAfterMissingKey.eventCount), 2);
  assert.equal(Number(stateAfterMissingKey.sourceCount), 2);

  keyring.set("key-current", randomBytes(32));
  assert.throws(
    () => openPayload(keyring.get("key-current"), currentRow),
    /authenticate data/,
  );
  assert.deepEqual(openPayload(keyring.get("key-old"), oldRow), sentinel);

  checkpoint(database);
  const modes = databaseFileModes(databasePath);
  assertPrivateModes(modes);
  database.close();
  const plaintextSentinelFound = databaseFiles(databasePath).some((file) => (
    fs.readFileSync(file).includes(sentinel)
  ));
  assert.equal(plaintextSentinelFound, false);

  return {
    algorithm: "AES-256-GCM",
    aadIncludesAccountAndCursor: true,
    oldKeyRequiredUntilPayloadExpiry: true,
    missingKeyTransactionRolledBack: true,
    plaintextSentinelFound,
    fileModes: modes,
  };
}

function runCrashChecks(directory) {
  const baselinePath = path.join(directory, "crash-baseline.sqlite");
  const key = randomBytes(32);
  const baseline = openDatabase(baselinePath);
  const baselineWriter = new EventLogWriter(baseline, {
    accountId: ACCOUNT_ID,
    eventLogGeneration: EVENT_LOG_GENERATION,
    keyring: new Map([["crash-key", key]]),
  });
  baselineWriter.appendBatch([
    createInput({
      index: 1,
      payload: Buffer.from("baseline-running"),
      keyId: "crash-key",
      prefix: "crash",
    }),
  ]);
  checkpoint(baseline);
  baseline.close();

  const results = [];
  for (const stage of CRASH_STAGES) {
    const databasePath = path.join(directory, `crash-${stage}.sqlite`);
    fs.copyFileSync(baselinePath, databasePath);
    fs.chmodSync(databasePath, 0o600);
    const worker = spawnSync(
      process.execPath,
      [scriptPath, "--crash-worker", databasePath, stage],
      {
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
        stdio: "ignore",
        timeout: 10_000,
      },
    );
    assert.equal(worker.signal, "SIGKILL");

    const database = openDatabase(databasePath);
    const integrity = String(
      database.prepare("PRAGMA integrity_check").get().integrity_check,
    );
    assert.equal(integrity, "ok");
    const beforeRecovery = crashState(database);
    const committed = stage === "after-commit";
    if (committed) {
      assert.deepEqual(beforeRecovery, {
        cursor: 2,
        eventCount: 2,
        sourceCount: 2,
        taskState: "completed",
        taskCursor: 2,
      });
    } else {
      assert.deepEqual(beforeRecovery, {
        cursor: 1,
        eventCount: 1,
        sourceCount: 1,
        taskState: "inProgress",
        taskCursor: 1,
      });
    }

    const writer = new EventLogWriter(database, {
      accountId: ACCOUNT_ID,
      eventLogGeneration: EVENT_LOG_GENERATION,
      keyring: new Map([["crash-key", key]]),
    });
    const retryInput = createInput({
      index: 2,
      payload: Buffer.from("terminal-after-recovery"),
      keyId: "crash-key",
      prefix: "crash",
    });
    retryInput.taskId = "crash:task:1";
    retryInput.taskState = "completed";
    const retry = writer.appendBatch([
      retryInput,
    ])[0];
    assert.equal(retry.duplicate, committed);
    const afterRecovery = crashState(database);
    assert.deepEqual(afterRecovery, {
      cursor: 2,
      eventCount: 2,
      sourceCount: 2,
      taskState: "completed",
      taskCursor: 2,
    });
    assert.equal(
      String(database.prepare("PRAGMA integrity_check").get().integrity_check),
      "ok",
    );
    checkpoint(database);
    database.close();
    results.push({
      stage,
      committedBeforeRecovery: committed,
      retryWasDuplicate: retry.duplicate,
      integrity: "ok",
      finalCursor: afterRecovery.cursor,
      finalRows: afterRecovery.eventCount,
    });
  }
  return results;
}

function crashState(database) {
  const row = database.prepare(`
    SELECT
      (SELECT last_cursor FROM account_cursors WHERE account_id = ?) AS cursor,
      (SELECT count(*) FROM events WHERE account_id = ?) AS eventCount,
      (SELECT count(*) FROM source_mappings WHERE account_id = ?) AS sourceCount,
      (SELECT state FROM task_states WHERE account_id = ? AND task_id = ?) AS taskState,
      (SELECT updated_cursor FROM task_states WHERE account_id = ? AND task_id = ?) AS taskCursor
  `).get(
    ACCOUNT_ID,
    ACCOUNT_ID,
    ACCOUNT_ID,
    ACCOUNT_ID,
    "crash:task:1",
    ACCOUNT_ID,
    "crash:task:1",
  );
  return {
    cursor: Number(row.cursor),
    eventCount: Number(row.eventCount),
    sourceCount: Number(row.sourceCount),
    taskState: row.taskState,
    taskCursor: Number(row.taskCursor),
  };
}

function runCrashWorker(databasePath, stage) {
  assert.ok(CRASH_STAGES.includes(stage));
  const resolvedPath = path.resolve(databasePath);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.ok(resolvedPath.startsWith(temporaryRoot));
  assert.ok(
    path.basename(path.dirname(resolvedPath))
      .startsWith("wfl-event-log-storage-"),
  );
  assert.ok(path.basename(resolvedPath).startsWith("crash-"));
  const database = openDatabase(databasePath);
  const cursor = Number(
    database.prepare(`
      SELECT last_cursor AS cursor
      FROM account_cursors
      WHERE account_id = ?
    `).get(ACCOUNT_ID).cursor,
  ) + 1;
  assert.equal(cursor, 2);
  const crash = (expectedStage) => {
    if (stage === expectedStage) {
      process.kill(process.pid, "SIGKILL");
    }
  };

  database.exec("BEGIN IMMEDIATE");
  database.prepare(`
    INSERT INTO events(
      account_id,
      event_log_generation,
      event_cursor,
      source_id,
      thread_id,
      event_type,
      canonical_ref,
      key_id,
      nonce,
      auth_tag,
      payload_cipher,
      payload_bytes,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ACCOUNT_ID,
    EVENT_LOG_GENERATION,
    cursor,
    "crash:source:2",
    "crash:thread:2",
    "turn/completed",
    "crash:entity:2",
    "crash-key",
    Buffer.alloc(12, 1),
    Buffer.alloc(16, 2),
    Buffer.alloc(32, 3),
    32,
    1_785_000_000_002,
  );
  crash("after-event");

  database.prepare(`
    INSERT INTO source_mappings(
      account_id,
      source_id,
      event_cursor,
      canonical_ref
    ) VALUES (?, ?, ?, ?)
  `).run(ACCOUNT_ID, "crash:source:2", cursor, "crash:entity:2");
  crash("after-source");

  database.prepare(`
    INSERT INTO task_states(account_id, task_id, state, updated_cursor)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, task_id) DO UPDATE SET
      state = excluded.state,
      updated_cursor = excluded.updated_cursor
  `).run(ACCOUNT_ID, "crash:task:1", "completed", cursor);
  crash("after-task");

  database.prepare(`
    UPDATE account_cursors
    SET last_cursor = ?
    WHERE account_id = ?
  `).run(cursor, ACCOUNT_ID);
  crash("after-account-cursor");

  database.exec("COMMIT");
  crash("after-commit");
  assert.fail(`crash stage did not terminate worker: ${stage}`);
}

function checkpoint(database) {
  const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  assert.equal(Number(result.busy), 0);
}

function databaseFiles(databasePath) {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ].filter((file) => fs.existsSync(file));
}

function databaseFileSizes(databasePath) {
  const size = (file) => (
    fs.existsSync(file) ? fs.statSync(file).size : 0
  );
  return {
    database: size(databasePath),
    wal: size(`${databasePath}-wal`),
    sharedMemory: size(`${databasePath}-shm`),
  };
}

function databaseFileModes(databasePath) {
  return Object.fromEntries(databaseFiles(databasePath).map((file) => [
    path.basename(file),
    (fs.statSync(file).mode & 0o777).toString(8).padStart(3, "0"),
  ]));
}

function assertPrivateModes(modes) {
  for (const mode of Object.values(modes)) {
    assert.equal(mode, "600");
  }
}

function percentile(values, fraction) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function parseArguments(argv) {
  const options = { repetitions: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repetitions") {
      options.repetitions = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  assert.ok(Number.isSafeInteger(options.repetitions));
  assert.ok(options.repetitions >= 1 && options.repetitions <= 5);
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wfl-event-log-storage-"),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  try {
    const sqliteVersionDatabase = new DatabaseSync(":memory:");
    const sqliteVersion = String(
      sqliteVersionDatabase
        .prepare("SELECT sqlite_version() AS version")
        .get().version,
    );
    sqliteVersionDatabase.close();

    const cases = [];
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const group of benchmarkCases) {
        for (const batchSize of group.batchSizes) {
          cases.push(runBenchmarkCase(
            temporaryDirectory,
            {
              payloadBytes: group.payloadBytes,
              eventCount: group.eventCount,
              batchSize,
            },
            repetition,
          ));
        }
      }
    }
    const security = runSecurityChecks(temporaryDirectory);
    const crashes = runCrashChecks(temporaryDirectory);
    const totalInputBytes = cases.reduce(
      (total, result) => total + result.payloadBytes * result.eventCount,
      0,
    );

    console.log(JSON.stringify({
      ok: true,
      probe: "event-log-storage",
      productionCodeExercised: false,
      networkAccessed: false,
      rescueWindowAccessed: false,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        sqlite: sqliteVersion,
        journalMode: "wal",
        synchronous: "full",
      },
      bounds: {
        repetitions: options.repetitions,
        cases: cases.length,
        totalEvents: cases.reduce(
          (total, result) => total + result.eventCount,
          0,
        ),
        totalInputMiB: round(totalInputBytes / MEBIBYTE),
      },
      cases,
      security,
      crashAtomicity: crashes,
      temporaryDirectoryRemovedAtExit: true,
    }, null, 2));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const originalUmask = process.umask(0o077);
try {
  if (process.argv[2] === "--crash-worker") {
    runCrashWorker(process.argv[3], process.argv[4]);
  } else {
    main(process.argv.slice(2));
  }
} finally {
  process.umask(originalUmask);
}
