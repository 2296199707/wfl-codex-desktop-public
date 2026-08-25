import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptPath = fileURLToPath(import.meta.url);
const SIDECAR_ARGUMENT = "--event-log-sidecar";
const REQUEST_TIMEOUT_MS = 15_000;
const RUNS = 3;
const FLOOD_TRANSACTIONS = 64;
const EVENTS_PER_TRANSACTION = 16;
const EVENT_PAYLOAD_BYTES = 4 * 1024;

async function runProbe() {
  assert.equal(
    typeof process.getuid === "function" ? process.getuid() : null,
    0,
    "the UID/GID sidecar isolation probe must run as root",
  );

  const identities = selectProbeIdentities();
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "wfl-event-log-sidecar-"),
  );
  fs.chmodSync(temporaryRoot, 0o711);
  const sidecarRunnerPath = path.join(
    temporaryRoot,
    "event-log-sidecar-runner.mjs",
  );
  fs.copyFileSync(scriptPath, sidecarRunnerPath);
  fs.chmodSync(sidecarRunnerPath, 0o555);

  let sidecarA = null;
  let sidecarB = null;
  try {
    const runtimeA = prepareRuntimeDirectory(
      temporaryRoot,
      "runtime-a",
      identities[0],
      sidecarRunnerPath,
    );
    const runtimeB = prepareRuntimeDirectory(
      temporaryRoot,
      "runtime-b",
      identities[1],
      sidecarRunnerPath,
    );

    sidecarA = await SidecarController.launch(runtimeA);
    sidecarB = await SidecarController.launch(runtimeB);
    assert.equal(sidecarA.identity.uid, identities[0].uid);
    assert.equal(sidecarA.identity.gid, identities[0].gid);
    assert.equal(sidecarB.identity.uid, identities[1].uid);
    assert.equal(sidecarB.identity.gid, identities[1].gid);

    let crossRuntimePathRejected = false;
    let crossRuntimePathError = "";
    try {
      await sidecarA.request("validate-path", {
        databasePath: runtimeB.databasePath,
      });
    } catch (error) {
      crossRuntimePathRejected = true;
      crossRuntimePathError = String(error.message);
    }
    assert.equal(crossRuntimePathRejected, true);

    const baselineBLatencyMs = [];
    let sourceSequence = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const result = await timedRequest(sidecarB, "append", {
        events: [
          makeEvent("runtime-b", ++sourceSequence, 256, "turn/completed"),
        ],
      });
      baselineBLatencyMs.push(result.elapsedMs);
    }

    const floodBLatencyMs = [];
    const floodACompletedBeforeB = [];
    for (let run = 1; run <= RUNS; run += 1) {
      let completedA = 0;
      const requests = [];
      const first = sidecarA.sendRequest("append", {
        events: makeEventBatch(
          `runtime-a-run-${run}`,
          1,
          EVENTS_PER_TRANSACTION,
          EVENT_PAYLOAD_BYTES,
        ),
      });
      const firstStarted = sidecarA.waitForEvent(
        (message) => (
          message.event === "transaction-started"
          && message.requestId === first.requestId
        ),
      );
      requests.push(first.promise.then((result) => {
        completedA += 1;
        return result;
      }));

      for (
        let transaction = 1;
        transaction < FLOOD_TRANSACTIONS;
        transaction += 1
      ) {
        const firstEvent = (transaction * EVENTS_PER_TRANSACTION) + 1;
        const request = sidecarA.sendRequest("append", {
          events: makeEventBatch(
            `runtime-a-run-${run}`,
            firstEvent,
            EVENTS_PER_TRANSACTION,
            EVENT_PAYLOAD_BYTES,
          ),
        });
        requests.push(request.promise.then((result) => {
          completedA += 1;
          return result;
        }));
      }

      await firstStarted;
      const bResult = await timedRequest(sidecarB, "append", {
        events: [
          makeEvent(
            "runtime-b",
            ++sourceSequence,
            256,
            "turn/completed",
          ),
        ],
      });
      floodBLatencyMs.push(bResult.elapsedMs);
      floodACompletedBeforeB.push(completedA);
      assert.ok(
        completedA < FLOOD_TRANSACTIONS,
        "runtime B did not respond until runtime A drained its entire queue",
      );
      await Promise.all(requests);
    }
    const floodAIpcBackpressureSignals = sidecarA.sendBackpressureCount;
    assert.ok(
      floodAIpcBackpressureSignals > 0,
      "bounded flood did not exercise child-process IPC backpressure",
    );

    process.kill(sidecarA.pid, "SIGSTOP");
    await delay(20);
    const stoppedPing = sidecarA.sendRequest("ping");
    const stoppedAResult = await timedRequest(sidecarB, "append", {
      events: [
        makeEvent("runtime-b", ++sourceSequence, 256, "turn/completed"),
      ],
    });
    assert.ok(stoppedAResult.elapsedMs < 1_000);
    process.kill(sidecarA.pid, "SIGCONT");
    await stoppedPing.promise;

    const cursorBeforeCrash = (
      await sidecarA.request("inspect")
    ).lastCursor;
    process.kill(sidecarA.pid, "SIGKILL");
    const crashExit = await sidecarA.waitForExit();
    assert.equal(crashExit.signal, "SIGKILL");

    const killedAResult = await timedRequest(sidecarB, "append", {
      events: [
        makeEvent("runtime-b", ++sourceSequence, 256, "turn/completed"),
      ],
    });
    assert.ok(killedAResult.elapsedMs < 1_000);

    sidecarA = await SidecarController.launch(runtimeA);
    const recoveredA = await sidecarA.request("inspect");
    assert.equal(recoveredA.integrityCheck, "ok");
    assert.equal(recoveredA.lastCursor, cursorBeforeCrash);

    const filesA = await sidecarA.request("inspect-files");
    const filesB = await sidecarB.request("inspect-files");
    assertStorageFiles(filesA, identities[0]);
    assertStorageFiles(filesB, identities[1]);

    console.log(JSON.stringify({
      ok: true,
      probe: "event-log-sidecar-isolation",
      productionCodeExercised: false,
      externalNetworkAccessed: false,
      rescueWindowAccessed: false,
      rootOnlyBecauseUidGidDropIsExercised: true,
      identities: identities.map(({ name, uid, gid }) => ({ name, uid, gid })),
      topology: {
        sidecars: 2,
        databases: 2,
        sqliteJournalMode: "wal",
        sqliteSynchronous: "full",
        ipc: "node-child-process-advanced-serialization",
      },
      crossRuntimeIsolation: {
        rejected: crossRuntimePathRejected,
        errorClass: classifyPathError(crossRuntimePathError),
      },
      diskContention: {
        runs: RUNS,
        runtimeATransactionsPerRun: FLOOD_TRANSACTIONS,
        runtimeAEventsPerTransaction: EVENTS_PER_TRANSACTION,
        runtimeAPayloadBytesPerEvent: EVENT_PAYLOAD_BYTES,
        baselineRuntimeBTerminalMs: range(baselineBLatencyMs),
        floodedRuntimeBTerminalMs: range(floodBLatencyMs),
        runtimeATransactionsCompletedBeforeB: range(
          floodACompletedBeforeB,
        ),
        runtimeAIpcRequests: RUNS * FLOOD_TRANSACTIONS,
        runtimeAIpcSendReturnedFalse: floodAIpcBackpressureSignals,
      },
      stoppedSidecarIsolation: {
        signal: "SIGSTOP",
        peerTerminalMs: round(stoppedAResult.elapsedMs),
        stoppedSidecarPingRecoveredAfterSigcont: true,
      },
      crashedSidecarIsolation: {
        signal: crashExit.signal,
        peerTerminalMs: round(killedAResult.elapsedMs),
        recoveredCursor: recoveredA.lastCursor,
        integrityCheck: recoveredA.integrityCheck,
      },
      fileIsolation: {
        stateDirectoryMode: "0700",
        databaseWalShmMode: "0600",
        runtimeA: filesA,
        runtimeB: filesB,
      },
      boundedInput: {
        maximumFloodPayloadMiBPerRun: round(
          (
            FLOOD_TRANSACTIONS
            * EVENTS_PER_TRANSACTION
            * EVENT_PAYLOAD_BYTES
          ) / (1024 * 1024),
        ),
        formalInstallOrUpdateHook: false,
      },
    }, null, 2));
  } finally {
    for (const sidecar of [sidecarA, sidecarB]) {
      if (!sidecar) continue;
      try {
        if (!sidecar.exited) process.kill(sidecar.pid, "SIGCONT");
      } catch {
        // The sidecar already exited.
      }
      try {
        await sidecar.close();
      } catch {
        // Cleanup must continue for the probe-owned temporary directory.
      }
    }
    assertProbeTemporaryRoot(temporaryRoot);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

class SidecarController {
  static async launch(runtime) {
    const child = fork(
      runtime.sidecarRunnerPath,
      [
        SIDECAR_ARGUMENT,
        `--state-directory=${runtime.stateDirectory}`,
        `--database-path=${runtime.databasePath}`,
        `--account-id=${runtime.accountId}`,
        `--expected-uid=${runtime.identity.uid}`,
        `--expected-gid=${runtime.identity.gid}`,
      ],
      {
        uid: runtime.identity.uid,
        gid: runtime.identity.gid,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const controller = new SidecarController(child);
    const ready = await controller.waitForEvent(
      (message) => message.event === "ready",
    );
    controller.identity = ready.identity;
    return controller;
  }

  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.eventWaiters = new Set();
    this.nextRequestId = 1;
    this.sendBackpressureCount = 0;
    this.exited = false;
    this.exitResult = null;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.on("message", (message) => this.onMessage(message));
    child.on("error", (error) => this.failPending(error));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitResult = { code, signal };
      this.failPending(
        new Error(`sidecar exited: code=${code} signal=${signal}`),
      );
      this.resolveExit(this.exitResult);
    });
  }

  get pid() {
    return this.child.pid;
  }

  request(method, params = {}) {
    return this.sendRequest(method, params).promise;
  }

  sendRequest(method, params = {}) {
    assert.equal(this.exited, false, "cannot send to an exited sidecar");
    const requestId = this.nextRequestId++;
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      rejectRequest(new Error(`sidecar request timed out: ${method}`));
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, {
      method,
      resolve: resolveRequest,
      reject: rejectRequest,
      timer,
    });
    const accepted = this.child.send(
      { type: "request", requestId, method, params },
      (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
      },
    );
    if (!accepted) this.sendBackpressureCount += 1;
    return { requestId, promise };
  }

  waitForEvent(predicate) {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          reject(new Error("sidecar event timed out"));
        }, REQUEST_TIMEOUT_MS),
      };
      this.eventWaiters.add(waiter);
    });
  }

  onMessage(message) {
    if (message?.type === "event") {
      for (const waiter of [...this.eventWaiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.eventWaiters.delete(waiter);
        waiter.resolve(message);
      }
      return;
    }
    if (message?.type !== "response") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || `${pending.method} failed`));
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.eventWaiters.clear();
  }

  waitForExit() {
    return this.exited
      ? Promise.resolve(this.exitResult)
      : this.exitPromise;
  }

  async close() {
    if (this.exited) return this.exitResult;
    await this.request("shutdown");
    return this.waitForExit();
  }
}

async function runSidecar() {
  process.umask(0o077);
  const options = parseSidecarArguments(process.argv.slice(2));
  const actualIdentity = {
    name: options.accountId,
    uid: process.getuid(),
    gid: process.getgid(),
  };
  assert.equal(actualIdentity.uid, options.expectedUid);
  assert.equal(actualIdentity.gid, options.expectedGid);
  validateDatabasePath(
    options.databasePath,
    options.stateDirectory,
    options.expectedUid,
    options.expectedGid,
  );
  validateExistingStorageFiles(
    options.databasePath,
    options.expectedUid,
    options.expectedGid,
  );

  const database = new DatabaseSync(options.databasePath);
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
    CREATE TABLE IF NOT EXISTS account_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      last_cursor INTEGER NOT NULL CHECK(last_cursor >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO account_cursor(singleton, last_cursor)
    VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS events (
      event_cursor INTEGER PRIMARY KEY CHECK(event_cursor > 0),
      source_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  secureStorageFiles(
    options.databasePath,
    options.expectedUid,
    options.expectedGid,
  );

  const selectCursor = database.prepare(`
    SELECT last_cursor AS lastCursor
    FROM account_cursor
    WHERE singleton = 1
  `);
  const insertEvent = database.prepare(`
    INSERT INTO events(
      event_cursor,
      source_id,
      event_type,
      payload,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const updateCursor = database.prepare(`
    UPDATE account_cursor
    SET last_cursor = ?
    WHERE singleton = 1
  `);

  process.on("message", (message) => {
    if (message?.type !== "request") return;
    const { requestId, method, params = {} } = message;
    try {
      let result;
      if (method === "ping") {
        result = { pong: true };
      } else if (method === "append") {
        sendSidecarEvent({
          event: "transaction-started",
          requestId,
        });
        result = appendEvents({
          database,
          selectCursor,
          insertEvent,
          updateCursor,
          events: params.events,
        });
      } else if (method === "inspect") {
        result = inspectDatabase(database, selectCursor);
      } else if (method === "inspect-files") {
        secureStorageFiles(
          options.databasePath,
          options.expectedUid,
          options.expectedGid,
        );
        result = inspectStorageFiles(options.databasePath);
      } else if (method === "validate-path") {
        validateDatabasePath(
          params.databasePath,
          options.stateDirectory,
          options.expectedUid,
          options.expectedGid,
        );
        result = { valid: true };
      } else if (method === "shutdown") {
        database.close();
        result = { closed: true };
      } else {
        throw new Error(`unknown sidecar method: ${method}`);
      }
      process.send(
        { type: "response", requestId, ok: true, result },
        () => {
          if (method === "shutdown") process.disconnect();
        },
      );
    } catch (error) {
      process.send({
        type: "response",
        requestId,
        ok: false,
        error: String(error?.message || error),
      });
    }
  });

  sendSidecarEvent({
    event: "ready",
    identity: actualIdentity,
    journalMode,
  });
}

function appendEvents({
  database,
  selectCursor,
  insertEvent,
  updateCursor,
  events,
}) {
  assert.ok(Array.isArray(events) && events.length > 0);
  assert.ok(events.length <= EVENTS_PER_TRANSACTION);
  const startedAt = performance.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    let cursor = Number(selectCursor.get().lastCursor);
    for (const event of events) {
      cursor += 1;
      insertEvent.run(
        cursor,
        event.sourceId,
        event.eventType,
        Buffer.from(event.payload),
        event.createdAt,
      );
    }
    updateCursor.run(cursor);
    database.exec("COMMIT");
    return {
      committed: events.length,
      lastCursor: cursor,
      transactionMs: round(performance.now() - startedAt),
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original storage error.
    }
    throw error;
  }
}

function inspectDatabase(database, selectCursor) {
  return {
    lastCursor: Number(selectCursor.get().lastCursor),
    eventCount: Number(
      database.prepare("SELECT count(*) AS count FROM events").get().count,
    ),
    integrityCheck: String(
      database.prepare("PRAGMA integrity_check").get().integrity_check,
    ),
  };
}

function selectProbeIdentities() {
  const entries = fs.readFileSync("/etc/passwd", "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(":");
      return {
        name: fields[0],
        uid: Number(fields[2]),
        gid: Number(fields[3]),
      };
    })
    .filter((entry) => (
      Number.isInteger(entry.uid)
      && Number.isInteger(entry.gid)
      && entry.uid > 0
      && entry.gid > 0
    ));
  const preferredNames = ["daemon", "nobody"];
  const preferred = preferredNames
    .map((name) => entries.find((entry) => entry.name === name))
    .filter(Boolean);
  const selected = [];
  for (const entry of [...preferred, ...entries]) {
    if (selected.some((existing) => existing.uid === entry.uid)) continue;
    selected.push(entry);
    if (selected.length === 2) break;
  }
  assert.equal(selected.length, 2, "two distinct non-root UIDs are required");
  assert.notEqual(selected[0].uid, selected[1].uid);
  return selected;
}

function prepareRuntimeDirectory(
  root,
  accountId,
  identity,
  sidecarRunnerPath,
) {
  const stateDirectory = path.join(root, accountId);
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.chownSync(stateDirectory, identity.uid, identity.gid);
  fs.chmodSync(stateDirectory, 0o700);
  return {
    accountId,
    identity,
    sidecarRunnerPath,
    stateDirectory,
    databasePath: path.join(stateDirectory, "event-log.sqlite"),
  };
}

function validateDatabasePath(databasePath, stateDirectory, uid, gid) {
  assert.equal(path.basename(databasePath), "event-log.sqlite");
  const stateStat = fs.lstatSync(stateDirectory);
  assert.equal(stateStat.isSymbolicLink(), false);
  assert.equal(stateStat.isDirectory(), true);
  assert.equal(stateStat.uid, uid);
  assert.equal(stateStat.gid, gid);
  assert.equal(stateStat.mode & 0o777, 0o700);
  const realStateDirectory = fs.realpathSync(stateDirectory);
  const realParent = fs.realpathSync(path.dirname(databasePath));
  assert.equal(realParent, realStateDirectory);
  assert.equal(
    path.resolve(databasePath),
    path.join(realStateDirectory, "event-log.sqlite"),
  );
  if (fs.existsSync(databasePath)) {
    const databaseStat = fs.lstatSync(databasePath);
    assert.equal(databaseStat.isSymbolicLink(), false);
    assert.equal(databaseStat.isFile(), true);
    assert.equal(databaseStat.uid, uid);
    assert.equal(databaseStat.gid, gid);
    assert.equal(databaseStat.mode & 0o777, 0o600);
  }
}

function validateExistingStorageFiles(databasePath, uid, gid) {
  for (const candidate of storageFilePaths(databasePath)) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.uid, uid);
    assert.equal(stat.gid, gid);
    assert.equal(stat.mode & 0o777, 0o600);
  }
}

function secureStorageFiles(databasePath, uid, gid) {
  for (const candidate of storageFilePaths(databasePath)) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.uid, uid);
    assert.equal(stat.gid, gid);
    fs.chmodSync(candidate, 0o600);
  }
}

function inspectStorageFiles(databasePath) {
  return storageFilePaths(databasePath)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => {
      const stat = fs.lstatSync(candidate);
      return {
        name: path.basename(candidate),
        uid: stat.uid,
        gid: stat.gid,
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
        bytes: stat.size,
      };
    });
}

function assertStorageFiles(files, identity) {
  assert.ok(files.some((file) => file.name === "event-log.sqlite"));
  for (const file of files) {
    assert.equal(file.uid, identity.uid);
    assert.equal(file.gid, identity.gid);
    assert.equal(file.mode, "0600");
  }
}

function storageFilePaths(databasePath) {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ];
}

function parseSidecarArguments(argumentsList) {
  const values = new Map();
  for (const argument of argumentsList) {
    if (!argument.startsWith("--") || !argument.includes("=")) continue;
    const separator = argument.indexOf("=");
    values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  const options = {
    stateDirectory: values.get("state-directory"),
    databasePath: values.get("database-path"),
    accountId: values.get("account-id"),
    expectedUid: Number(values.get("expected-uid")),
    expectedGid: Number(values.get("expected-gid")),
  };
  assert.ok(options.stateDirectory);
  assert.ok(options.databasePath);
  assert.ok(options.accountId);
  assert.ok(Number.isInteger(options.expectedUid));
  assert.ok(Number.isInteger(options.expectedGid));
  return options;
}

function makeEventBatch(prefix, firstSequence, count, payloadBytes) {
  return Array.from({ length: count }, (_, index) => (
    makeEvent(prefix, firstSequence + index, payloadBytes, "item/delta")
  ));
}

function makeEvent(prefix, sequence, payloadBytes, eventType) {
  return {
    sourceId: `${prefix}-source-${sequence}`,
    eventType,
    payload: randomBytes(payloadBytes),
    createdAt: Date.now(),
  };
}

async function timedRequest(sidecar, method, params) {
  const startedAt = performance.now();
  const result = await sidecar.request(method, params);
  return {
    ...result,
    elapsedMs: performance.now() - startedAt,
  };
}

function sendSidecarEvent(message) {
  process.send({ type: "event", ...message });
}

function classifyPathError(errorMessage) {
  if (/EACCES|permission denied/i.test(errorMessage)) {
    return "filesystem-permission-rejected";
  }
  if (/Expected values to be strictly equal|realpath|state/i.test(
    errorMessage,
  )) {
    return "path-validation-rejected";
  }
  return "rejected";
}

function range(values) {
  return {
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertProbeTemporaryRoot(temporaryRoot) {
  const expectedPrefix = path.join(
    fs.realpathSync(os.tmpdir()),
    "wfl-event-log-sidecar-",
  );
  const resolved = path.resolve(temporaryRoot);
  assert.equal(resolved.startsWith(expectedPrefix), true);
  assert.notEqual(resolved, fs.realpathSync(os.tmpdir()));
}

if (process.argv.includes(SIDECAR_ARGUMENT)) {
  await runSidecar();
} else {
  await runProbe();
}
