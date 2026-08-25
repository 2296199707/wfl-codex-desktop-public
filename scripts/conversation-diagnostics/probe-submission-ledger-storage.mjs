import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const ACCOUNT_ID = "account-submission-ledger-probe";
const SCHEMA_VERSION = 1;
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1_000;
const FIXED_NOW = 1_785_460_000_000;
const CRASH_KEY = Buffer.alloc(32, 0x4b);
const CRASH_DIGEST_KEY = Buffer.alloc(32, 0x44);
const CRASH_STAGES = Object.freeze([
  "prepare-after-ledger",
  "prepare-after-commit",
  "sent-after-state",
  "sent-after-commit",
  "unknown-after-state",
  "unknown-after-commit",
  "accepted-after-state",
  "accepted-after-purge",
  "accepted-after-commit",
  "cleanup-after-state",
  "cleanup-after-purge",
  "cleanup-after-commit",
]);
const ALLOWED_TRANSITIONS = new Map([
  ["prepared", new Set(["sent", "cancelled", "unknown"])],
  ["sent", new Set(["accepted", "rejected", "unknown", "unresolved-abandoned"])],
  ["unknown", new Set(["accepted", "unresolved-abandoned"])],
  ["accepted", new Set(["terminal"])],
]);

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
    CREATE TABLE IF NOT EXISTS submission_ledger (
      account_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      submission_type TEXT NOT NULL
        CHECK(submission_type IN ('start', 'steer')),
      thread_id TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'prepared',
        'sent',
        'accepted',
        'terminal',
        'rejected',
        'unknown',
        'cancelled',
        'unresolved-abandoned'
      )),
      provider_id TEXT NOT NULL,
      model_digest TEXT NOT NULL,
      settings_digest TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
      outbox_key_id TEXT,
      outbox_nonce BLOB,
      outbox_auth_tag BLOB,
      outbox_cipher BLOB,
      rpc_id TEXT,
      turn_id TEXT,
      recovery_blocked INTEGER NOT NULL DEFAULT 0
        CHECK(recovery_blocked IN (0, 1)),
      prepared_at INTEGER NOT NULL,
      sent_at INTEGER,
      accepted_at INTEGER,
      terminal_at INTEGER,
      outbox_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(account_id, submission_id),
      CHECK(
        (outbox_cipher IS NULL
          AND outbox_nonce IS NULL
          AND outbox_auth_tag IS NULL
          AND outbox_key_id IS NULL)
        OR
        (outbox_cipher IS NOT NULL
          AND length(outbox_nonce) = 12
          AND length(outbox_auth_tag) = 16
          AND outbox_key_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS submission_transitions (
      transition_id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      transition_at INTEGER NOT NULL,
      reason_class TEXT NOT NULL,
      FOREIGN KEY(account_id, submission_id)
        REFERENCES submission_ledger(account_id, submission_id)
        ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS submission_expiry
      ON submission_ledger(account_id, outbox_expires_at)
      WHERE outbox_cipher IS NOT NULL;
  `);
}

class SubmissionLedger {
  constructor(database, {
    accountId,
    keyring,
    digestKey,
    crashAt = null,
  }) {
    this.database = database;
    this.accountId = accountId;
    this.keyring = keyring;
    this.digestKey = digestKey;
    this.crashAt = crashAt;
    this.select = database.prepare(`
      SELECT
        account_id AS accountId,
        submission_id AS submissionId,
        submission_type AS submissionType,
        thread_id AS threadId,
        state,
        provider_id AS providerId,
        model_digest AS modelDigest,
        settings_digest AS settingsDigest,
        payload_digest AS payloadDigest,
        payload_bytes AS payloadBytes,
        outbox_key_id AS outboxKeyId,
        outbox_nonce AS outboxNonce,
        outbox_auth_tag AS outboxAuthTag,
        outbox_cipher AS outboxCipher,
        rpc_id AS rpcId,
        turn_id AS turnId,
        recovery_blocked AS recoveryBlocked,
        prepared_at AS preparedAt,
        sent_at AS sentAt,
        accepted_at AS acceptedAt,
        terminal_at AS terminalAt,
        outbox_expires_at AS outboxExpiresAt,
        updated_at AS updatedAt
      FROM submission_ledger
      WHERE account_id = ? AND submission_id = ?
    `);
    this.insert = database.prepare(`
      INSERT INTO submission_ledger(
        account_id,
        submission_id,
        submission_type,
        thread_id,
        state,
        provider_id,
        model_digest,
        settings_digest,
        payload_digest,
        payload_bytes,
        outbox_key_id,
        outbox_nonce,
        outbox_auth_tag,
        outbox_cipher,
        recovery_blocked,
        prepared_at,
        outbox_expires_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `);
    this.insertTransition = database.prepare(`
      INSERT INTO submission_transitions(
        account_id,
        submission_id,
        from_state,
        to_state,
        transition_at,
        reason_class
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.updateState = database.prepare(`
      UPDATE submission_ledger
      SET
        state = ?,
        rpc_id = COALESCE(?, rpc_id),
        turn_id = COALESCE(?, turn_id),
        recovery_blocked = ?,
        sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
        accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END,
        terminal_at = CASE
          WHEN ? IN ('terminal', 'rejected', 'cancelled', 'unresolved-abandoned')
            THEN ?
          ELSE terminal_at
        END,
        updated_at = ?
      WHERE account_id = ? AND submission_id = ? AND state = ?
    `);
    this.purgeOutbox = database.prepare(`
      UPDATE submission_ledger
      SET
        outbox_key_id = NULL,
        outbox_nonce = NULL,
        outbox_auth_tag = NULL,
        outbox_cipher = NULL,
        updated_at = ?
      WHERE account_id = ? AND submission_id = ?
    `);
    this.markBlocked = database.prepare(`
      UPDATE submission_ledger
      SET recovery_blocked = ?, updated_at = ?
      WHERE account_id = ? AND submission_id = ?
    `);
  }

  prepare(input) {
    validatePrepareInput(input);
    const key = this.keyring.get(input.keyId);
    if (!key) throw new Error(`outbox key unavailable: ${input.keyId}`);
    const payloadDigest = digest(this.digestKey, input.payload);
    const modelDigest = digest(this.digestKey, Buffer.from(input.model));
    const settingsDigest = digest(this.digestKey, Buffer.from(input.settings));
    const aad = makeAad({
      accountId: this.accountId,
      submissionId: input.submissionId,
      submissionType: input.submissionType,
      threadId: input.threadId,
      providerId: input.providerId,
      modelDigest,
      settingsDigest,
      payloadDigest,
    });
    const sealed = sealPayload(key, input.payload, aad);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.read(input.submissionId);
      if (existing) {
        assert.equal(existing.submissionType, input.submissionType);
        assert.equal(existing.threadId, input.threadId);
        assert.equal(existing.providerId, input.providerId);
        assert.equal(existing.modelDigest, modelDigest);
        assert.equal(existing.settingsDigest, settingsDigest);
        if (existing.payloadDigest !== payloadDigest) {
          throw new Error("submission ID collision with a different frozen payload");
        }
        this.database.exec("COMMIT");
        return { duplicate: true, row: existing };
      }

      this.insert.run(
        this.accountId,
        input.submissionId,
        input.submissionType,
        input.threadId,
        input.providerId,
        modelDigest,
        settingsDigest,
        payloadDigest,
        input.payload.length,
        input.keyId,
        sealed.nonce,
        sealed.authTag,
        sealed.ciphertext,
        input.now,
        input.now + OUTBOX_TTL_MS,
        input.now,
      );
      this.#crash("prepare-after-ledger");
      this.insertTransition.run(
        this.accountId,
        input.submissionId,
        null,
        "prepared",
        input.now,
        "prepared",
      );
      this.#crash("prepare-after-history");
      this.database.exec("COMMIT");
      this.#crash("prepare-after-commit");
      return { duplicate: false, row: this.read(input.submissionId) };
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  transition(submissionId, nextState, {
    now,
    rpcId = null,
    turnId = null,
    reasonClass = nextState,
    purgeOutbox = false,
    allowRecoveryUnknown = false,
    crashPrefix = nextState,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read(submissionId);
      assert.ok(current, `submission not found: ${submissionId}`);
      if (current.state === nextState) {
        this.database.exec("COMMIT");
        return { duplicate: true, row: current };
      }
      const allowed = ALLOWED_TRANSITIONS.get(current.state)?.has(nextState);
      assert.ok(
        allowed || (
          allowRecoveryUnknown
          && nextState === "unknown"
          && (current.state === "prepared" || current.state === "sent")
        ),
        `invalid submission transition ${current.state} -> ${nextState}`,
      );
      const recoveryBlocked = allowRecoveryUnknown ? 1 : 0;
      const update = this.updateState.run(
        nextState,
        rpcId,
        turnId,
        recoveryBlocked,
        nextState,
        now,
        nextState,
        now,
        nextState,
        now,
        now,
        this.accountId,
        submissionId,
        current.state,
      );
      assert.equal(Number(update.changes), 1);
      this.#crash(`${crashPrefix}-after-state`);
      if (purgeOutbox) {
        const purge = this.purgeOutbox.run(
          now,
          this.accountId,
          submissionId,
        );
        assert.equal(Number(purge.changes), 1);
      }
      this.#crash(`${crashPrefix}-after-purge`);
      this.insertTransition.run(
        this.accountId,
        submissionId,
        current.state,
        nextState,
        now,
        reasonClass,
      );
      this.#crash(`${crashPrefix}-after-history`);
      this.database.exec("COMMIT");
      this.#crash(`${crashPrefix}-after-commit`);
      return { duplicate: false, row: this.read(submissionId) };
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  read(submissionId) {
    return this.select.get(this.accountId, submissionId) ?? null;
  }

  openOutbox(submissionId, now) {
    const row = this.read(submissionId);
    assert.ok(row);
    if (!row.outboxCipher) return null;
    const key = this.keyring.get(row.outboxKeyId);
    if (!key) {
      this.#markUnreadable(row, now);
      return null;
    }
    const aad = makeAad(row);
    try {
      const payload = openPayload(key, row, aad);
      this.markBlocked.run(0, now, this.accountId, submissionId);
      return payload;
    } catch {
      this.#markUnreadable(row, now);
      return null;
    }
  }

  #markUnreadable(row, now) {
    if (row.state === "prepared" || row.state === "sent") {
      this.transition(row.submissionId, "unknown", {
        now,
        reasonClass: "outbox-unreadable",
        allowRecoveryUnknown: true,
      });
    } else {
      this.markBlocked.run(1, now, this.accountId, row.submissionId);
    }
  }

  cleanupExpired(now) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.database.prepare(`
        SELECT
          submission_id AS submissionId,
          state
        FROM submission_ledger
        WHERE account_id = ?
          AND outbox_cipher IS NOT NULL
          AND outbox_expires_at <= ?
        ORDER BY submission_id
      `).all(this.accountId, now);
      const results = [];
      for (const row of expired) {
        const nextState = row.state === "prepared"
          ? "cancelled"
          : (row.state === "sent" || row.state === "unknown")
            ? "unresolved-abandoned"
            : row.state;
        if (nextState !== row.state) {
          const update = this.updateState.run(
            nextState,
            null,
            null,
            0,
            nextState,
            now,
            nextState,
            now,
            nextState,
            now,
            now,
            this.accountId,
            row.submissionId,
            row.state,
          );
          assert.equal(Number(update.changes), 1);
        }
        this.#crash("cleanup-after-state");
        this.purgeOutbox.run(now, this.accountId, row.submissionId);
        this.#crash("cleanup-after-purge");
        if (nextState !== row.state) {
          this.insertTransition.run(
            this.accountId,
            row.submissionId,
            row.state,
            nextState,
            now,
            "outbox-hard-expiry",
          );
        }
        this.#crash("cleanup-after-history");
        results.push({
          submissionId: row.submissionId,
          fromState: row.state,
          toState: nextState,
        });
      }
      this.database.exec("COMMIT");
      this.#crash("cleanup-after-commit");
      return results;
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  #crash(stage) {
    if (this.crashAt === stage) {
      process.kill(process.pid, "SIGKILL");
    }
  }
}

function validatePrepareInput(input) {
  assert.ok(input && typeof input === "object");
  assert.match(input.submissionId, /^submission-[a-z0-9-]+$/);
  assert.ok(input.submissionType === "start" || input.submissionType === "steer");
  assert.ok(input.threadId === null || typeof input.threadId === "string");
  assert.equal(typeof input.providerId, "string");
  assert.equal(typeof input.model, "string");
  assert.equal(typeof input.settings, "string");
  assert.ok(Buffer.isBuffer(input.payload));
  assert.equal(typeof input.keyId, "string");
  assert.ok(Number.isSafeInteger(input.now));
}

function makeAad(row) {
  return Buffer.from(JSON.stringify([
    SCHEMA_VERSION,
    row.accountId,
    row.submissionId,
    row.submissionType,
    row.threadId,
    row.providerId,
    row.modelDigest,
    row.settingsDigest,
    row.payloadDigest,
  ]));
}

function digest(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sealPayload(key, payload, aad) {
  assert.equal(key.length, 32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    nonce,
    authTag: cipher.getAuthTag(),
    ciphertext,
  };
}

function openPayload(key, row, aad) {
  const decipher = createDecipheriv("aes-256-gcm", key, row.outboxNonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(row.outboxAuthTag);
  return Buffer.concat([
    decipher.update(row.outboxCipher),
    decipher.final(),
  ]);
}

function rollback(database) {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original storage error or injected process termination path.
  }
}

function baseInput(submissionId, {
  now = FIXED_NOW,
  payload = Buffer.from(`private-payload:${submissionId}`),
  submissionType = "start",
  threadId = "thread-ledger-probe",
  providerId = "provider-a",
  keyId = "outbox-key",
} = {}) {
  return {
    submissionId,
    submissionType,
    threadId,
    providerId,
    model: "model-probe",
    settings: "sandbox=workspace-write",
    payload,
    keyId,
    now,
  };
}

function transitionCount(database, submissionId) {
  return Number(database.prepare(`
    SELECT count(*) AS count
    FROM submission_transitions
    WHERE account_id = ? AND submission_id = ?
  `).get(ACCOUNT_ID, submissionId).count);
}

function projectedRow(row) {
  if (!row) return null;
  return {
    state: row.state,
    hasOutbox: Boolean(row.outboxCipher),
    recoveryBlocked: Boolean(row.recoveryBlocked),
    rpcId: row.rpcId,
    turnId: row.turnId,
  };
}

function runStateMachineChecks(directory) {
  const databasePath = path.join(directory, "state-machine.sqlite");
  const database = openDatabase(databasePath);
  const keyring = new Map([["outbox-key", randomBytes(32)]]);
  const ledger = new SubmissionLedger(database, {
    accountId: ACCOUNT_ID,
    keyring,
    digestKey: randomBytes(32),
  });
  const input = baseInput("submission-state-machine");
  const prepared = ledger.prepare(input);
  assert.equal(prepared.duplicate, false);
  assert.deepEqual(ledger.openOutbox(input.submissionId, FIXED_NOW), input.payload);
  assert.equal(ledger.prepare(input).duplicate, true);
  assert.throws(
    () => ledger.prepare({
      ...input,
      payload: Buffer.from("different frozen payload"),
    }),
    /different frozen payload/,
  );

  ledger.transition(input.submissionId, "sent", {
    now: FIXED_NOW + 1,
    rpcId: "rpc-state-machine",
  });
  ledger.transition(input.submissionId, "unknown", {
    now: FIXED_NOW + 2,
    reasonClass: "result-lost-after-write",
  });
  assert.throws(
    () => ledger.transition(input.submissionId, "rejected", {
      now: FIXED_NOW + 3,
    }),
    /invalid submission transition/,
  );
  const accepted = ledger.transition(input.submissionId, "accepted", {
    now: FIXED_NOW + 4,
    turnId: "turn-state-machine",
    reasonClass: "history-index-match",
    purgeOutbox: true,
  }).row;
  assert.deepEqual(projectedRow(accepted), {
    state: "accepted",
    hasOutbox: false,
    recoveryBlocked: false,
    rpcId: "rpc-state-machine",
    turnId: "turn-state-machine",
  });
  ledger.transition(input.submissionId, "terminal", {
    now: FIXED_NOW + 5,
    reasonClass: "turn-completed",
  });
  assert.equal(transitionCount(database, input.submissionId), 5);

  const preparedCancellation = baseInput("submission-cancel-prepared");
  ledger.prepare(preparedCancellation);
  ledger.transition(preparedCancellation.submissionId, "cancelled", {
    now: FIXED_NOW + 1,
    purgeOutbox: true,
    reasonClass: "cancel-before-write",
  });
  assert.equal(ledger.read(preparedCancellation.submissionId).state, "cancelled");

  const explicitRejection = baseInput("submission-explicit-rejection");
  ledger.prepare(explicitRejection);
  ledger.transition(explicitRejection.submissionId, "sent", {
    now: FIXED_NOW + 1,
    rpcId: "rpc-rejected",
  });
  ledger.transition(explicitRejection.submissionId, "rejected", {
    now: FIXED_NOW + 2,
    purgeOutbox: true,
    reasonClass: "explicit-no-side-effect-rejection",
  });
  assert.equal(ledger.read(explicitRejection.submissionId).state, "rejected");

  checkpoint(database);
  const modes = databaseFileModes(databasePath);
  assertPrivateModes(modes);
  database.close();
  return {
    uniqueKey: "(account_id, submission_id)",
    samePayloadPrepareIdempotent: true,
    differentPayloadCollisionRejected: true,
    unknownCannotBecomeRejected: true,
    acceptedPurgesEncryptedOutboxAtomically: true,
    preparedOnlyCancellation: true,
    explicitRejectionAfterSent: true,
    fileModes: modes,
  };
}

function runSecurityChecks(directory) {
  const databasePath = path.join(directory, "security.sqlite");
  const database = openDatabase(databasePath);
  const key = randomBytes(32);
  const digestKey = randomBytes(32);
  const keyring = new Map([["outbox-key", key]]);
  const ledger = new SubmissionLedger(database, {
    accountId: ACCOUNT_ID,
    keyring,
    digestKey,
  });
  const sentinel = Buffer.from(
    "WFL_SUBMISSION_OUTBOX_PLAINTEXT_SENTINEL_42a1".repeat(32),
  );
  const input = baseInput("submission-security", { payload: sentinel });
  ledger.prepare(input);
  assert.deepEqual(ledger.openOutbox(input.submissionId, FIXED_NOW), sentinel);

  keyring.delete("outbox-key");
  assert.equal(ledger.openOutbox(input.submissionId, FIXED_NOW + 1), null);
  let row = ledger.read(input.submissionId);
  assert.deepEqual(projectedRow(row), {
    state: "unknown",
    hasOutbox: true,
    recoveryBlocked: true,
    rpcId: null,
    turnId: null,
  });
  keyring.set("outbox-key", key);
  assert.deepEqual(ledger.openOutbox(input.submissionId, FIXED_NOW + 2), sentinel);
  row = ledger.read(input.submissionId);
  assert.equal(Boolean(row.recoveryBlocked), false);
  assert.equal(row.state, "unknown");

  const tampered = baseInput("submission-tampered");
  ledger.prepare(tampered);
  database.prepare(`
    UPDATE submission_ledger
    SET outbox_auth_tag = ?
    WHERE account_id = ? AND submission_id = ?
  `).run(Buffer.alloc(16, 0xff), ACCOUNT_ID, tampered.submissionId);
  assert.equal(ledger.openOutbox(tampered.submissionId, FIXED_NOW + 3), null);
  assert.equal(ledger.read(tampered.submissionId).state, "unknown");
  assert.equal(Boolean(ledger.read(tampered.submissionId).recoveryBlocked), true);

  assert.throws(
    () => ledger.prepare(baseInput("submission-missing-key", {
      keyId: "missing-key",
    })),
    /key unavailable/,
  );
  assert.equal(ledger.read("submission-missing-key"), null);

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
    digest: "HMAC-SHA-256",
    aadBindsAccountSubmissionTypeDestinationAndDigests: true,
    missingKeyPrepareRolledBack: true,
    unavailableOrCorruptOutboxBecomesBlockedUnknown: true,
    restoredKeyDoesNotAutoReplayUnknown: true,
    plaintextSentinelFound,
    fileModes: modes,
  };
}

function runRetentionChecks(directory) {
  const databasePath = path.join(directory, "retention.sqlite");
  const database = openDatabase(databasePath);
  const ledger = new SubmissionLedger(database, {
    accountId: ACCOUNT_ID,
    keyring: new Map([["outbox-key", randomBytes(32)]]),
    digestKey: randomBytes(32),
  });
  const prepared = baseInput("submission-expired-prepared");
  const sent = baseInput("submission-expired-sent");
  const unknown = baseInput("submission-expired-unknown");
  for (const input of [prepared, sent, unknown]) ledger.prepare(input);
  ledger.transition(sent.submissionId, "sent", {
    now: FIXED_NOW + 1,
    rpcId: "rpc-expired-sent",
  });
  ledger.transition(unknown.submissionId, "sent", {
    now: FIXED_NOW + 1,
    rpcId: "rpc-expired-unknown",
  });
  ledger.transition(unknown.submissionId, "unknown", {
    now: FIXED_NOW + 2,
    reasonClass: "result-lost-after-write",
  });

  const beforeExpiry = ledger.cleanupExpired(FIXED_NOW + OUTBOX_TTL_MS - 1);
  assert.deepEqual(beforeExpiry, []);
  const expired = ledger.cleanupExpired(FIXED_NOW + OUTBOX_TTL_MS);
  assert.equal(expired.length, 3);
  assert.deepEqual(projectedRow(ledger.read(prepared.submissionId)), {
    state: "cancelled",
    hasOutbox: false,
    recoveryBlocked: false,
    rpcId: null,
    turnId: null,
  });
  assert.equal(ledger.read(sent.submissionId).state, "unresolved-abandoned");
  assert.equal(ledger.read(unknown.submissionId).state, "unresolved-abandoned");
  assert.equal(Boolean(ledger.read(sent.submissionId).outboxCipher), false);
  assert.equal(Boolean(ledger.read(unknown.submissionId).outboxCipher), false);
  checkpoint(database);
  database.close();
  return {
    hardExpiryHours: OUTBOX_TTL_MS / (60 * 60 * 1_000),
    beforeDeadlinePurged: 0,
    expiredPreparedState: "cancelled",
    expiredSentState: "unresolved-abandoned",
    expiredUnknownState: "unresolved-abandoned",
    sentOrUnknownNeverRelabeledRejected: true,
    encryptedOutboxPurgedAtHardDeadline: true,
  };
}

function prepareCrashBaseline(databasePath, stage) {
  const database = openDatabase(databasePath);
  const ledger = new SubmissionLedger(database, {
    accountId: ACCOUNT_ID,
    keyring: new Map([["outbox-key", CRASH_KEY]]),
    digestKey: CRASH_DIGEST_KEY,
  });
  if (stage.startsWith("prepare-")) {
    checkpoint(database);
    database.close();
    return;
  }
  const input = baseInput("submission-crash");
  ledger.prepare(input);
  if (stage.startsWith("sent-")) {
    checkpoint(database);
    database.close();
    return;
  }
  ledger.transition(input.submissionId, "sent", {
    now: FIXED_NOW + 1,
    rpcId: "rpc-crash",
  });
  if (stage.startsWith("unknown-")) {
    checkpoint(database);
    database.close();
    return;
  }
  ledger.transition(input.submissionId, "unknown", {
    now: FIXED_NOW + 2,
    reasonClass: "result-lost-after-write",
  });
  checkpoint(database);
  database.close();
}

function runCrashWorker(databasePath, stage) {
  assert.ok(CRASH_STAGES.includes(stage));
  const resolvedPath = path.resolve(databasePath);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.ok(resolvedPath.startsWith(temporaryRoot));
  assert.ok(
    path.basename(path.dirname(resolvedPath))
      .startsWith("wfl-submission-ledger-"),
  );
  assert.ok(path.basename(resolvedPath).startsWith("crash-"));
  const database = openDatabase(resolvedPath);
  const ledger = new SubmissionLedger(database, {
    accountId: ACCOUNT_ID,
    keyring: new Map([["outbox-key", CRASH_KEY]]),
    digestKey: CRASH_DIGEST_KEY,
    crashAt: stage,
  });
  const input = baseInput("submission-crash");
  if (stage.startsWith("prepare-")) {
    ledger.prepare(input);
  } else if (stage.startsWith("sent-")) {
    ledger.transition(input.submissionId, "sent", {
      now: FIXED_NOW + 1,
      rpcId: "rpc-crash",
    });
  } else if (stage.startsWith("unknown-")) {
    ledger.transition(input.submissionId, "unknown", {
      now: FIXED_NOW + 2,
      reasonClass: "result-lost-after-write",
    });
  } else if (stage.startsWith("accepted-")) {
    ledger.transition(input.submissionId, "accepted", {
      now: FIXED_NOW + 3,
      turnId: "turn-crash",
      reasonClass: "history-index-match",
      purgeOutbox: true,
    });
  } else {
    assert.ok(stage.startsWith("cleanup-"));
    ledger.cleanupExpired(FIXED_NOW + OUTBOX_TTL_MS);
  }
  assert.fail(`crash stage did not terminate worker: ${stage}`);
}

function expectedCrashState(stage, committed) {
  if (stage.startsWith("prepare-")) {
    return committed
      ? { state: "prepared", hasOutbox: true, transitions: 1 }
      : { state: null, hasOutbox: false, transitions: 0 };
  }
  if (stage.startsWith("sent-")) {
    return committed
      ? { state: "sent", hasOutbox: true, transitions: 2 }
      : { state: "prepared", hasOutbox: true, transitions: 1 };
  }
  if (stage.startsWith("unknown-")) {
    return committed
      ? { state: "unknown", hasOutbox: true, transitions: 3 }
      : { state: "sent", hasOutbox: true, transitions: 2 };
  }
  if (stage.startsWith("accepted-")) {
    return committed
      ? { state: "accepted", hasOutbox: false, transitions: 4 }
      : { state: "unknown", hasOutbox: true, transitions: 3 };
  }
  return committed
    ? { state: "unresolved-abandoned", hasOutbox: false, transitions: 4 }
    : { state: "unknown", hasOutbox: true, transitions: 3 };
}

function readCrashState(database) {
  const row = database.prepare(`
    SELECT state, outbox_cipher AS outboxCipher
    FROM submission_ledger
    WHERE account_id = ? AND submission_id = ?
  `).get(ACCOUNT_ID, "submission-crash");
  return {
    state: row?.state ?? null,
    hasOutbox: Boolean(row?.outboxCipher),
    transitions: transitionCount(database, "submission-crash"),
  };
}

function runCrashChecks(directory) {
  const results = [];
  for (const stage of CRASH_STAGES) {
    const databasePath = path.join(directory, `crash-${stage}.sqlite`);
    prepareCrashBaseline(databasePath, stage);
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
    const committed = stage.endsWith("after-commit");
    const state = readCrashState(database);
    assert.deepEqual(state, expectedCrashState(stage, committed));
    const recoveryLedger = new SubmissionLedger(database, {
      accountId: ACCOUNT_ID,
      keyring: new Map([["outbox-key", CRASH_KEY]]),
      digestKey: CRASH_DIGEST_KEY,
    });
    let retryWasDuplicate;
    if (stage.startsWith("prepare-")) {
      retryWasDuplicate = recoveryLedger
        .prepare(baseInput("submission-crash"))
        .duplicate;
    } else if (stage.startsWith("sent-")) {
      retryWasDuplicate = recoveryLedger.transition(
        "submission-crash",
        "sent",
        {
          now: FIXED_NOW + 1,
          rpcId: "rpc-crash",
        },
      ).duplicate;
    } else if (stage.startsWith("unknown-")) {
      retryWasDuplicate = recoveryLedger.transition(
        "submission-crash",
        "unknown",
        {
          now: FIXED_NOW + 2,
          reasonClass: "result-lost-after-write",
        },
      ).duplicate;
    } else if (stage.startsWith("accepted-")) {
      retryWasDuplicate = recoveryLedger.transition(
        "submission-crash",
        "accepted",
        {
          now: FIXED_NOW + 3,
          turnId: "turn-crash",
          reasonClass: "history-index-match",
          purgeOutbox: true,
        },
      ).duplicate;
    } else {
      const retry = recoveryLedger.cleanupExpired(
        FIXED_NOW + OUTBOX_TTL_MS,
      );
      retryWasDuplicate = retry.length === 0;
    }
    assert.equal(retryWasDuplicate, committed);
    const finalState = readCrashState(database);
    const expectedFinal = stage.startsWith("prepare-")
      ? { state: "prepared", hasOutbox: true, transitions: 1 }
      : stage.startsWith("sent-")
        ? { state: "sent", hasOutbox: true, transitions: 2 }
        : stage.startsWith("unknown-")
          ? { state: "unknown", hasOutbox: true, transitions: 3 }
          : stage.startsWith("accepted-")
            ? { state: "accepted", hasOutbox: false, transitions: 4 }
            : {
                state: "unresolved-abandoned",
                hasOutbox: false,
                transitions: 4,
              };
    assert.deepEqual(finalState, expectedFinal);
    checkpoint(database);
    const modes = databaseFileModes(databasePath);
    assertPrivateModes(modes);
    database.close();
    results.push({
      stage,
      committedBeforeCrash: committed,
      state,
      retryWasDuplicate,
      finalState,
      integrity,
    });
  }
  return results;
}

function runBenchmark(directory) {
  const databasePath = path.join(directory, "benchmark.sqlite");
  const database = openDatabase(databasePath);
  const ledger = new SubmissionLedger(database, {
    accountId: ACCOUNT_ID,
    keyring: new Map([["outbox-key", randomBytes(32)]]),
    digestKey: randomBytes(32),
  });
  const prepareDurations = [];
  const transitionDurations = [];
  const records = 256;
  for (let index = 0; index < records; index += 1) {
    const submissionId = `submission-benchmark-${index}`;
    let startedAt = performance.now();
    ledger.prepare(baseInput(submissionId, {
      payload: randomBytes(2 * 1024),
      submissionType: index % 3 === 0 ? "steer" : "start",
    }));
    prepareDurations.push(performance.now() - startedAt);
    startedAt = performance.now();
    ledger.transition(submissionId, "sent", {
      now: FIXED_NOW + 1,
      rpcId: `rpc-benchmark-${index}`,
    });
    transitionDurations.push(performance.now() - startedAt);
    startedAt = performance.now();
    ledger.transition(
      submissionId,
      index % 2 === 0 ? "accepted" : "unknown",
      {
        now: FIXED_NOW + 2,
        turnId: index % 2 === 0 ? `turn-benchmark-${index}` : null,
        reasonClass: index % 2 === 0
          ? "rpc-result"
          : "result-lost-after-write",
        purgeOutbox: index % 2 === 0,
      },
    );
    transitionDurations.push(performance.now() - startedAt);
  }
  const counts = database.prepare(`
    SELECT
      count(*) AS records,
      sum(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      sum(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) AS unknownRows,
      sum(CASE WHEN outbox_cipher IS NOT NULL THEN 1 ELSE 0 END) AS retainedOutboxes
    FROM submission_ledger
    WHERE account_id = ?
  `).get(ACCOUNT_ID);
  assert.equal(Number(counts.records), records);
  assert.equal(Number(counts.accepted), records / 2);
  assert.equal(Number(counts.unknownRows), records / 2);
  assert.equal(Number(counts.retainedOutboxes), records / 2);
  checkpoint(database);
  const databaseBytes = fs.statSync(databasePath).size;
  database.close();
  return {
    records,
    payloadBytesPerRecord: 2 * 1024,
    transactions: prepareDurations.length + transitionDurations.length,
    prepareMs: summarizeDurations(prepareDurations),
    transitionMs: summarizeDurations(transitionDurations),
    acceptedOutboxesPurged: records / 2,
    unknownOutboxesRetained: records / 2,
    databaseBytes,
  };
}

function summarizeDurations(values) {
  return {
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  };
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

function databaseFileModes(databasePath) {
  return Object.fromEntries(databaseFiles(databasePath).map((file) => [
    path.basename(file),
    (fs.statSync(file).mode & 0o777).toString(8).padStart(3, "0"),
  ]));
}

function assertPrivateModes(modes) {
  for (const mode of Object.values(modes)) assert.equal(mode, "600");
}

function main() {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wfl-submission-ledger-"),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  try {
    const versionDatabase = new DatabaseSync(":memory:");
    const sqliteVersion = String(
      versionDatabase.prepare("SELECT sqlite_version() AS version").get().version,
    );
    versionDatabase.close();
    const stateMachine = runStateMachineChecks(temporaryDirectory);
    const security = runSecurityChecks(temporaryDirectory);
    const retention = runRetentionChecks(temporaryDirectory);
    const crashAtomicity = runCrashChecks(temporaryDirectory);
    const benchmark = runBenchmark(temporaryDirectory);
    console.log(JSON.stringify({
      ok: true,
      probe: "submission-ledger-storage",
      productionCodeExercised: false,
      externalNetworkAccessed: false,
      rescueWindowAccessed: false,
      formalInstallOrUpdateHook: false,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        sqlite: sqliteVersion,
        journalMode: "wal",
        synchronous: "full",
      },
      stateMachine,
      security,
      retention,
      crashAtomicity,
      benchmark,
      boundaries: {
        upstreamExactlyOnceProven: false,
        candidateImplementationValidated: false,
        productionSidecarExercised: false,
        providerOrModelCalled: false,
        temporaryDirectoryRemovedAtExit: true,
      },
    }, null, 2));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const originalUmask = process.umask(0o077);
try {
  if (process.argv[2] === "--crash-worker") {
    runCrashWorker(process.argv[3], process.argv[4]);
  } else if (process.argv.length === 2) {
    main();
  } else {
    throw new Error("This probe accepts no arguments");
  }
} finally {
  process.umask(originalUmask);
}
