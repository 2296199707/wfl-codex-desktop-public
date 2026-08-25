import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INCOMPLETE_GRACE_MS = 5_000;
const DEFAULT_UNVERIFIABLE_GRACE_MS = 60_000;
const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;
const DEFAULT_RECOVERY_CLAIM_STALE_MS = 30_000;
const DEFAULT_ACQUIRE_WAIT_MS = 2_000;
const DEFAULT_ADMISSION_WAIT_MS = 5_000;
const DEFAULT_RESERVATION_TTL_MS = 15_000;
const MAX_RESERVATION_TTL_MS = 60_000;
const MAX_LOCK_BYTES = 4_096;
const MAINTENANCE_ADMISSION_FILE = "maintenance-admission.lock";
const MAINTENANCE_RESERVATION_FILE = "maintenance-reservation.json";
const MAINTENANCE_KINDS = new Set(["app-update", "codex-update", "release", "restore", "rollback"]);
const MAINTENANCE_COMMANDS = [
  "server.mjs",
  "scripts/release.mjs",
  "scripts/rollback.mjs",
  "scripts/update-app.mjs",
  "scripts/update-codex.mjs",
  "scripts/restore-data-backup.mjs",
  "scripts/recover-data-restore.mjs",
];

export const RELEASE_LOCK_ACCEPTED_COMMANDS = Object.freeze([
  "scripts/release.mjs",
  "scripts/rollback.mjs",
  "scripts/update-rescue.mjs",
]);

export async function acquireOperationLock(filePath, options = {}) {
  const settings = normalizeOptions(options, { acquiring: true });
  const lockPath = path.resolve(filePath);
  const directory = path.dirname(lockPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });

  const startTicks = await readProcessStartTicks(process.pid);
  if (!/^\d+$/.test(startTicks || "")) {
    const error = new Error("Cannot verify operation lock owner identity");
    error.code = "ERR_OPERATION_LOCK_OWNER_UNKNOWN";
    throw error;
  }
  const record = {
    schemaVersion: 1,
    token: crypto.randomUUID(),
    handoffToken: cleanHandoffToken(settings.handoffToken),
    pid: process.pid,
    startTicks,
    operationId: cleanOperationId(settings.operationId),
    ownerCommand: settings.ownerCommand,
    createdAt: settings.now(),
  };
  const deadline = Date.now() + settings.acquireWaitMs;

  while (Date.now() <= deadline) {
    if (await recoveryClaimBlocksAcquisition(lockPath, settings)) {
      await delay(10);
      continue;
    }

    const temporary = path.join(
      directory,
      `.${path.basename(lockPath)}.${process.pid}.${record.token}.${crypto.randomUUID()}.tmp`,
    );
    let temporaryIdentity = null;
    try {
      temporaryIdentity = await writeCompleteRecord(temporary, record);
      await fs.link(temporary, lockPath);
      await syncDirectory(directory);
      const exposed = await lstatOrNull(lockPath);
      if (!exposed || !sameFile(exposed, temporaryIdentity)) throw lockLostError();
      if (await lstatOrNull(recoveryPath(lockPath))) {
        await removeOwnedLock(lockPath, exposed, record.token).catch(() => false);
        await delay(10);
        continue;
      }

      const heartbeatHandle = await fs.open(lockPath, "r+");
      const heartbeatIdentity = await heartbeatHandle.stat();
      if (!sameFile(exposed, heartbeatIdentity)) {
        await heartbeatHandle.close();
        throw lockLostError();
      }
      const stopHeartbeat = startLockHeartbeat(heartbeatHandle, settings.lockHeartbeatMs);

      let released = false;
      return {
        filePath: lockPath,
        record: { ...record },
        async release() {
          if (released) return false;
          released = true;
          stopHeartbeat();
          await heartbeatHandle.close().catch(() => {});
          return releaseOwnedLock(lockPath, exposed, record.token, settings);
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (temporaryIdentity) {
          await removeOwnedLock(lockPath, temporaryIdentity, record.token).catch(() => false);
        }
        throw error;
      }
      const observed = await inspectOperationLock(lockPath, settings);
      if (observed.state === "inactive" && observed.identity) {
        if (await reclaimObservedLock(lockPath, observed, settings)) continue;
        await delay(10);
        continue;
      }
      throw lockedError(settings.conflictMessage, observed.state);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  throw lockedError(settings.conflictMessage, "unknown");
}

export async function operationLockState(filePath, options = {}) {
  return (await inspectOperationLock(path.resolve(filePath), normalizeOptions(options))).state;
}

export async function inspectOperationLock(filePath, options = {}) {
  const settings = options.acceptedCommands ? normalizeOptions(options) : options;
  const snapshot = await readLockSnapshot(path.resolve(filePath));
  if (!snapshot) return { state: "inactive", identity: null, record: null };
  return {
    state: await lockOwnerState(snapshot, settings),
    identity: snapshot.stat,
    record: snapshot.record,
  };
}

export async function reclaimInactiveOperationLock(filePath, options = {}) {
  const settings = normalizeOptions(options);
  const lockPath = path.resolve(filePath);
  const observed = await inspectOperationLock(lockPath, settings);
  if (observed.state !== "inactive" || !observed.identity) return false;
  return reclaimObservedLock(lockPath, observed, settings);
}

/**
 * Reclaim a lock for a verified recovery handoff.  This is deliberately a
 * separate API from normal acquisition: a recovery worker must present a
 * durable, operation-scoped attestation and prove that the recorded owner is
 * no longer running before an `unknown` lock can be removed.  The final
 * inode/token check in removeClaimedLock still fences a concurrent replacement.
 */
export async function reclaimOperationLockForRecovery(filePath, {
  recoveryToken,
  expectedOperationId,
  verifyOwnerExit,
  ...options
} = {}) {
  if (typeof recoveryToken !== "string" || recoveryToken.length < 16) {
    throw new TypeError("A verified recovery token is required to take over an operation lock");
  }
  if (typeof verifyOwnerExit !== "function") {
    throw new TypeError("A recovery owner-exit verifier is required to take over an operation lock");
  }
  const settings = normalizeOptions({
    ...options,
    expectedOperationId,
  });
  const lockPath = path.resolve(filePath);
  const observed = await inspectOperationLock(lockPath, settings);
  if (!observed.identity) return false;
  if (observed.record?.operationId !== settings.expectedOperationId) return false;
  if (observed.record?.handoffToken !== recoveryToken) return false;
  if (!await verifyOwnerExit({
    state: observed.state,
    identity: observed.identity,
    record: observed.record,
    recoveryToken,
  })) return false;

  const latest = await inspectOperationLock(lockPath, settings);
  if (
    !latest.identity
    || !sameFile(latest.identity, observed.identity)
    || lockToken(latest.record) !== lockToken(observed.record)
    || latest.record?.operationId !== settings.expectedOperationId
    || latest.record?.handoffToken !== recoveryToken
    || latest.state === "active"
  ) return false;
  if (!await verifyOwnerExit({
    state: latest.state,
    identity: latest.identity,
    record: latest.record,
    recoveryToken,
  })) return false;
  return removeClaimedLock(lockPath, latest, settings);
}

export async function reserveMaintenanceOperation(runtimeDirectory, options = {}) {
  const settings = normalizeMaintenanceOptions(runtimeDirectory, options, { requireLock: false });
  return withMaintenanceAdmission(settings.runtimeDirectory, settings, async () => {
    await assertReservationAvailable(settings);
    await assertNoMaintenanceLockConflicts(settings);

    const startTicks = await readProcessStartTicks(process.pid);
    if (!/^\d+$/.test(startTicks || "")) {
      const error = new Error("Cannot verify maintenance reservation owner identity");
      error.code = "ERR_MAINTENANCE_RESERVATION_OWNER_UNKNOWN";
      throw error;
    }
    const createdAt = settings.now();
    const record = {
      schemaVersion: 1,
      reservationVersion: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      startTicks,
      operationId: settings.operationId,
      operationKind: settings.operationKind,
      ownerCommand: settings.ownerCommand,
      createdAt,
      expiresAt: createdAt + settings.reservationTtlMs,
    };
    const identity = await exposeCompleteRecord(settings.reservationPath, record);
    return {
      record: { ...record },
      async cancel() {
        return cancelMaintenanceReservation(settings.runtimeDirectory, {
          operationId: record.operationId,
          reservationToken: record.token,
          ownerCommand: settings.ownerCommand,
        });
      },
      identity,
    };
  });
}

export async function acquireMaintenanceOperationLock(runtimeDirectory, options = {}) {
  const settings = normalizeMaintenanceOptions(runtimeDirectory, options);
  return withMaintenanceAdmission(settings.runtimeDirectory, settings, async () => {
    const reservation = await inspectMaintenanceReservation(settings);
    assertWorkerOwnsReservation(reservation, settings);
    await assertNoMaintenanceLockConflicts(settings);

    let lock = null;
    try {
      lock = settings.acquireLock
        ? await settings.acquireLock()
        : await acquireOperationLock(settings.lockPath, {
          ...settings.lockOptions,
          operationId: settings.operationId,
        });
      if (reservation.state === "active") {
        const removed = await removeOwnedPath(settings.reservationPath, reservation.identity);
        if (!removed) throw maintenanceReservationError("Maintenance reservation ownership was lost");
        await syncDirectory(settings.runtimeDirectory);
      }
      return lock;
    } catch (error) {
      await lock?.release?.().catch(() => {});
      throw error;
    }
  });
}

export async function cancelMaintenanceReservation(runtimeDirectory, options = {}) {
  const settings = normalizeMaintenanceOptions(runtimeDirectory, {
    ...options,
    operationKind: options.operationKind || "release",
    lockPath: options.lockPath || path.join(path.resolve(runtimeDirectory), "release.lock"),
    lockOptions: options.lockOptions || {
      ownerCommand: options.ownerCommand,
      acceptedCommands: [options.ownerCommand],
    },
  }, { requireKind: false, requireLock: false });
  return withMaintenanceAdmission(settings.runtimeDirectory, settings, async () => {
    const reservation = await inspectMaintenanceReservation(settings);
    if (
      reservation.state === "inactive"
      || reservation.record?.operationId !== settings.operationId
      || reservation.record?.token !== settings.reservationToken
    ) return false;
    const removed = await removeOwnedPath(settings.reservationPath, reservation.identity);
    if (removed) await syncDirectory(settings.runtimeDirectory);
    return removed;
  });
}

export async function withMaintenanceAdmission(runtimeDirectory, options, operation) {
  if (typeof operation !== "function") throw new TypeError("Maintenance admission operation is required");
  const directory = path.resolve(runtimeDirectory);
  const ownerCommand = String(options?.ownerCommand || "");
  if (!ownerCommand) throw new TypeError("Maintenance admission owner command is required");
  const acceptedCommands = [...new Set([...MAINTENANCE_COMMANDS, ownerCommand])];
  const lockPath = path.join(directory, MAINTENANCE_ADMISSION_FILE);
  const deadline = Date.now() + positiveDuration(options?.admissionWaitMs, DEFAULT_ADMISSION_WAIT_MS);
  let admission = null;
  while (!admission && Date.now() <= deadline) {
    try {
      admission = await acquireOperationLock(lockPath, {
        ownerCommand,
        acceptedCommands,
        operationId: options?.operationId,
        acquireWaitMs: 100,
        conflictMessage: "Another maintenance operation is entering its critical section",
      });
    } catch (error) {
      if (error.code !== "ERR_OPERATION_LOCKED") throw error;
      if (Date.now() >= deadline) break;
      await delay(10);
    }
  }
  if (!admission) throw maintenanceConflictError("Timed out waiting for maintenance admission");
  try {
    return await operation();
  } finally {
    await admission.release();
  }
}

export function statusTimestampIsFresh(status, {
  now = Date.now(),
  maxAgeMs = 20_000,
  futureToleranceMs = 5_000,
} = {}) {
  const updatedAt = Number(status?.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  const age = now - updatedAt;
  return age >= -futureToleranceMs && age < maxAgeMs;
}

export async function readProcessStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    return /^\d+$/.test(fields[19] || "") ? fields[19] : undefined;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    return undefined;
  }
}

async function releaseOwnedLock(lockPath, identity, token, settings) {
  const observed = await inspectOperationLock(lockPath, settings);
  if (
    !observed.identity
    || !sameFile(observed.identity, identity)
    || observed.record?.token !== token
  ) return false;
  return removeClaimedLock(lockPath, observed, settings);
}

async function reclaimObservedLock(lockPath, observed, settings) {
  const latest = await inspectOperationLock(lockPath, settings);
  if (
    latest.state !== "inactive"
    || !latest.identity
    || !sameFile(latest.identity, observed.identity)
    || lockToken(latest.record) !== lockToken(observed.record)
  ) return false;
  return removeClaimedLock(lockPath, latest, settings);
}

async function removeClaimedLock(lockPath, observed, settings) {
  const claimPath = recoveryPath(lockPath);
  try {
    await fs.link(lockPath, claimPath);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(error.code)) return false;
    throw error;
  }

  let claimIdentity = null;
  try {
    await fs.utimes(claimPath, new Date(), new Date()).catch(() => {});
    claimIdentity = await lstatOrNull(claimPath);
    const current = await inspectOperationLock(lockPath, settings);
    if (
      !claimIdentity
      || !sameFile(claimIdentity, observed.identity)
      || !current.identity
      || !sameFile(current.identity, observed.identity)
      || lockToken(current.record) !== lockToken(observed.record)
    ) return false;
    await fs.unlink(lockPath);
    await syncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    if (claimIdentity) await removeOwnedPath(claimPath, claimIdentity).catch(() => false);
  }
}

async function recoveryClaimBlocksAcquisition(lockPath, settings) {
  const claimPath = recoveryPath(lockPath);
  const claim = await lstatOrNull(claimPath);
  if (!claim) return false;
  const age = settings.now() - claim.mtimeMs;
  if (age >= -5_000 && age <= settings.recoveryClaimStaleMs) return true;
  await removeOwnedPath(claimPath, claim).catch(() => false);
  return Boolean(await lstatOrNull(claimPath));
}

async function removeOwnedLock(lockPath, identity, token) {
  const current = await readLockSnapshot(lockPath);
  if (!current || !sameFile(current.stat, identity) || current.record?.token !== token) return false;
  return removeOwnedPath(lockPath, identity);
}

async function lockOwnerState(snapshot, settings) {
  const { record, stat } = snapshot;
  if (!recordIsValid(record)) {
    const age = settings.now() - stat.mtimeMs;
    return age >= -5_000 && age <= settings.incompleteGraceMs ? "unknown" : "inactive";
  }
  if (
    settings.expectedOperationId
    && record.operationId
    && settings.expectedOperationId !== record.operationId
  ) return "inactive";

  const startTicks = await settings.readProcessStartTicks(record.pid);
  if (startTicks === null) return "inactive";
  if (startTicks === undefined) return unverifiableOwnerState(snapshot, settings);
  if (!record.legacy && startTicks !== record.startTicks) return "inactive";

  const argumentsList = await settings.readProcessArguments(record.pid);
  if (argumentsList === null) return "inactive";
  if (argumentsList === undefined) return unverifiableOwnerState(snapshot, settings);
  if (!commandMatches(argumentsList, settings.acceptedCommands)) return "inactive";
  if (!settings.requiredArguments.every((argument) => argumentsList.includes(argument))) return "inactive";
  return "active";
}

function unverifiableOwnerState(snapshot, settings) {
  const age = settings.now() - snapshot.stat.mtimeMs;
  return age >= -5_000 && age <= settings.unverifiableGraceMs ? "unknown" : "inactive";
}

async function readLockSnapshot(filePath) {
  let handle = null;
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_LOCK_BYTES) {
      return { stat: before, record: null };
    }
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!sameFile(before, stat)) return null;
    const raw = (await handle.readFile("utf8")).trim();
    return { stat, record: parseRecord(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseRecord(raw) {
  if (/^\d+$/.test(raw)) {
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 1 ? { legacy: true, pid } : null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function recordIsValid(record) {
  if (record?.legacy === true) return Number.isSafeInteger(record.pid) && record.pid > 1;
  return record?.schemaVersion === 1
    && typeof record.token === "string"
    && record.token.length >= 16
    && (record.handoffToken === undefined || record.handoffToken === null || typeof record.handoffToken === "string")
    && Number.isSafeInteger(record.pid)
    && record.pid > 1
    && /^\d+$/.test(record.startTicks || "")
    && (record.operationId === null || typeof record.operationId === "string")
    && (record.ownerCommand === undefined || (
      typeof record.ownerCommand === "string"
      && record.ownerCommand.length > 0
    ))
    && Number.isFinite(record.createdAt)
    && record.createdAt > 0;
}

function normalizeMaintenanceOptions(runtimeDirectory, options, {
  requireKind = true,
  requireLock = true,
} = {}) {
  const runtime = path.resolve(runtimeDirectory);
  const operationKind = String(options.operationKind || "");
  const operationId = cleanOperationId(options.operationId);
  const ownerCommand = String(options.ownerCommand || options.lockOptions?.ownerCommand || "");
  const reservationToken = typeof options.reservationToken === "string" && options.reservationToken
    ? options.reservationToken.slice(0, 200)
    : null;
  if (requireKind && !MAINTENANCE_KINDS.has(operationKind)) {
    throw new TypeError("Invalid maintenance operation kind");
  }
  if (!operationId) throw new TypeError("Maintenance operation ID is required");
  if (!ownerCommand) throw new TypeError("Maintenance owner command is required");
  if (requireLock && !options.acquireLock && !options.lockPath) {
    throw new TypeError("Maintenance operation lock is required");
  }
  if (requireLock && !options.acquireLock && !options.lockOptions) {
    throw new TypeError("Maintenance operation lock options are required");
  }
  return {
    runtimeDirectory: runtime,
    reservationPath: path.join(runtime, MAINTENANCE_RESERVATION_FILE),
    operationKind,
    operationId,
    ownerCommand,
    reservationToken,
    reservationTtlMs: boundedDuration(
      options.reservationTtlMs,
      DEFAULT_RESERVATION_TTL_MS,
      MAX_RESERVATION_TTL_MS,
    ),
    admissionWaitMs: positiveDuration(options.admissionWaitMs, DEFAULT_ADMISSION_WAIT_MS),
    lockPath: options.lockPath ? path.resolve(options.lockPath) : null,
    lockOptions: options.lockOptions || null,
    acquireLock: typeof options.acquireLock === "function" ? options.acquireLock : null,
    allowAppUpdateParent: options.allowAppUpdateParent === true,
    now: typeof options.now === "function" ? options.now : () => Date.now(),
  };
}

async function assertReservationAvailable(settings) {
  const reservation = await inspectMaintenanceReservation(settings);
  if (reservation.state !== "inactive") {
    throw maintenanceConflictError("Another maintenance operation is waiting to start");
  }
}

function assertWorkerOwnsReservation(reservation, settings) {
  if (!settings.reservationToken) {
    if (reservation.state !== "inactive") {
      throw maintenanceConflictError("Another maintenance operation is waiting to start");
    }
    return;
  }
  if (
    reservation.state !== "active"
    || reservation.record?.operationId !== settings.operationId
    || reservation.record?.operationKind !== settings.operationKind
    || reservation.record?.token !== settings.reservationToken
  ) {
    throw maintenanceReservationError("Maintenance launch reservation expired or was replaced");
  }
}

async function assertNoMaintenanceLockConflicts(settings) {
  for (const definition of maintenanceLockDefinitions(settings.runtimeDirectory)) {
    if (settings.lockPath && path.resolve(definition.filePath) === settings.lockPath) continue;
    const observed = await inspectOperationLock(definition.filePath, normalizeOptions(definition.options));
    if (observed.state === "inactive") continue;
    if (
      settings.allowAppUpdateParent
      && settings.operationKind === "release"
      && definition.operationKind === "app-update"
      && observed.state === "active"
      && (
        observed.record?.operationId === settings.operationId
        || (
          observed.record?.legacy === true
          && observed.record.pid === process.ppid
          && !settings.reservationToken
        )
      )
    ) continue;
    throw maintenanceConflictError(
      observed.state === "unknown"
        ? "Another maintenance operation may still be running"
        : `Another ${definition.operationKind} operation is already running`,
    );
  }
}

function maintenanceLockDefinitions(runtimeDirectory) {
  return [
    {
      operationKind: "release",
      filePath: path.join(runtimeDirectory, "release.lock"),
      options: {
        ownerCommand: "scripts/release.mjs",
        acceptedCommands: RELEASE_LOCK_ACCEPTED_COMMANDS,
        requiredArguments: ["--worker"],
      },
    },
    {
      operationKind: "app-update",
      filePath: path.join(runtimeDirectory, "app-update.lock"),
      options: {
        ownerCommand: "scripts/update-app.mjs",
        acceptedCommands: ["scripts/update-app.mjs"],
        requiredArguments: ["--worker"],
      },
    },
    {
      operationKind: "codex-update",
      filePath: path.join(runtimeDirectory, "codex-update.lock"),
      options: {
        ownerCommand: "scripts/update-codex.mjs",
        acceptedCommands: ["scripts/update-codex.mjs"],
        requiredArguments: ["--worker"],
      },
    },
    {
      operationKind: "restore",
      filePath: path.join(runtimeDirectory, "backup-restore.lock"),
      options: {
        ownerCommand: "scripts/restore-data-backup.mjs",
        acceptedCommands: ["scripts/restore-data-backup.mjs", "scripts/recover-data-restore.mjs"],
      },
    },
  ];
}

async function inspectMaintenanceReservation(settings) {
  const snapshot = await readLockSnapshot(settings.reservationPath);
  if (!snapshot) return { state: "inactive", identity: null, record: null };
  const now = settings.now();
  if (validMaintenanceReservation(snapshot.record)) {
    const duration = snapshot.record.expiresAt - snapshot.record.createdAt;
    const futureAge = snapshot.record.createdAt - now;
    if (
      duration > 0
      && duration <= MAX_RESERVATION_TTL_MS
      && futureAge <= 5_000
      && now <= snapshot.record.expiresAt
    ) return { state: "active", identity: snapshot.stat, record: snapshot.record };
  } else {
    const age = now - snapshot.stat.mtimeMs;
    if (age >= -5_000 && age <= DEFAULT_INCOMPLETE_GRACE_MS) {
      return { state: "unknown", identity: snapshot.stat, record: snapshot.record };
    }
  }
  await removeOwnedPath(settings.reservationPath, snapshot.stat).catch(() => false);
  return { state: "inactive", identity: null, record: null };
}

function validMaintenanceReservation(record) {
  return recordIsValid(record)
    && record.reservationVersion === 1
    && MAINTENANCE_KINDS.has(record.operationKind)
    && typeof record.expiresAt === "number"
    && Number.isFinite(record.expiresAt);
}

async function readProcessArguments(pid) {
  try {
    // A SIGKILLed child can remain as a zombie until its parent reaps it.  A
    // zombie still has /proc/<pid>/stat and may briefly retain a command line,
    // but it can no longer own a live operation lock.
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    const commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.split("\0").filter(Boolean);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    return undefined;
  }
}

function commandMatches(argumentsList, acceptedCommands) {
  return acceptedCommands.some((command) => {
    const marker = normalizeCommand(command);
    return argumentsList.some((argument) => {
      if (!argument || argument.startsWith("-")) return false;
      const candidate = normalizeCommand(argument);
      return candidate === marker || candidate.endsWith(`/${marker}`);
    });
  });
}

function normalizeCommand(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeOptions(options, { acquiring = false } = {}) {
  const acceptedCommands = [...new Set(
    (Array.isArray(options.acceptedCommands) ? options.acceptedCommands : [options.ownerCommand])
      .filter((value) => typeof value === "string" && value.length > 0),
  )];
  if (!acceptedCommands.length) throw new TypeError("Operation lock commands are required");
  const ownerCommand = typeof options.ownerCommand === "string" && options.ownerCommand
    ? options.ownerCommand
    : acceptedCommands[0];
  if (acquiring && !ownerCommand) throw new TypeError("Operation lock owner command is required");
  const unverifiableGraceMs = positiveDuration(
    options.unverifiableGraceMs,
    DEFAULT_UNVERIFIABLE_GRACE_MS,
  );
  return {
    acceptedCommands,
    ownerCommand,
    operationId: cleanOperationId(options.operationId),
    handoffToken: cleanHandoffToken(options.handoffToken),
    expectedOperationId: cleanOperationId(options.expectedOperationId),
    requiredArguments: [...new Set(
      (Array.isArray(options.requiredArguments) ? options.requiredArguments : [])
        .filter((value) => typeof value === "string" && value.length > 0),
    )],
    conflictMessage: typeof options.conflictMessage === "string" && options.conflictMessage
      ? options.conflictMessage
      : "Another operation is already running",
    incompleteGraceMs: positiveDuration(options.incompleteGraceMs, DEFAULT_INCOMPLETE_GRACE_MS),
    unverifiableGraceMs,
    lockHeartbeatMs: Math.min(
      positiveDuration(options.lockHeartbeatMs, DEFAULT_LOCK_HEARTBEAT_MS),
      Math.max(1, unverifiableGraceMs / 2),
    ),
    recoveryClaimStaleMs: positiveDuration(
      options.recoveryClaimStaleMs,
      DEFAULT_RECOVERY_CLAIM_STALE_MS,
    ),
    acquireWaitMs: positiveDuration(options.acquireWaitMs, DEFAULT_ACQUIRE_WAIT_MS),
    readProcessStartTicks: typeof options.readProcessStartTicks === "function"
      ? options.readProcessStartTicks
      : readProcessStartTicks,
    readProcessArguments: typeof options.readProcessArguments === "function"
      ? options.readProcessArguments
      : readProcessArguments,
    now: typeof options.now === "function" ? options.now : () => Date.now(),
  };
}

function startLockHeartbeat(handle, intervalMs) {
  let stopped = false;
  let timer = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const now = new Date();
        await handle.utimes(now, now);
      } catch {
        stopped = true;
        return;
      }
      schedule();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function cleanOperationId(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : null;
}

function cleanHandoffToken(value) {
  return typeof value === "string" && value.length >= 16 ? value.slice(0, 200) : null;
}

function positiveDuration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedDuration(value, fallback, maximum) {
  const duration = positiveDuration(value, fallback);
  return Math.min(duration, maximum);
}

async function writeCompleteRecord(filePath, record) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

async function exposeCompleteRecord(filePath, record) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${record.token}.${crypto.randomUUID()}.tmp`,
  );
  try {
    const temporaryIdentity = await writeCompleteRecord(temporary, record);
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw maintenanceConflictError("Another maintenance operation is waiting to start");
      }
      throw error;
    }
    await syncDirectory(directory);
    const exposed = await lstatOrNull(filePath);
    if (!exposed || !sameFile(exposed, temporaryIdentity)) throw lockLostError();
    return exposed;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function removeOwnedPath(filePath, identity) {
  const current = await lstatOrNull(filePath);
  if (!current || !sameFile(current, identity)) return false;
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockToken(record) {
  return record?.legacy ? `legacy:${record.pid}` : record?.token || null;
}

function recoveryPath(lockPath) {
  return `${lockPath}.recovery`;
}

function lockedError(message, state) {
  const error = new Error(message);
  error.code = "ERR_OPERATION_LOCKED";
  error.ownerState = state;
  return error;
}

function lockLostError() {
  const error = new Error("Operation lock ownership was lost during acquisition");
  error.code = "ERR_OPERATION_LOCK_LOST";
  return error;
}

function maintenanceConflictError(message) {
  const error = new Error(message);
  error.code = "ERR_MAINTENANCE_CONFLICT";
  return error;
}

function maintenanceReservationError(message) {
  const error = new Error(message);
  error.code = "ERR_MAINTENANCE_RESERVATION";
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
