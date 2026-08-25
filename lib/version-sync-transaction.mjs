import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

/**
 * Recover a version synchronization that was interrupted between file
 * replacements. Recovery is deliberately conservative: a file may only be
 * restored when it still contains either the old or the staged new bytes.
 */
export async function recoverVersionSyncTransaction(transactionPath) {
  const pointerPath = path.resolve(transactionPath);
  const manifest = await readJsonOptional(pointerPath);
  if (manifest === null) {
    await removeOrphanTransactions(pointerPath);
    return false;
  }
  validateManifest(manifest, pointerPath);

  if (["committed", "rolled-back"].includes(manifest.phase)) {
    await finishTransaction(pointerPath, manifest);
    await removeOrphanTransactions(pointerPath);
    return true;
  }
  if (!["prepared", "committing"].includes(manifest.phase)) {
    throw transactionError("ERR_VERSION_SYNC_TRANSACTION", "Version synchronization transaction state is invalid");
  }

  for (const entry of [...manifest.entries].reverse()) {
    await restoreEntry(entry);
  }
  manifest.phase = "rolled-back";
  await writeJsonAtomic(pointerPath, manifest);
  await finishTransaction(pointerPath, manifest);
  await removeOrphanTransactions(pointerPath);
  return true;
}

/**
 * Stage all old/new bytes before exposing a transaction journal, then commit
 * each target with an atomic per-file replacement. A crash leaves the
 * journal available for recoverVersionSyncTransaction on the next run.
 */
export async function commitVersionSyncTransaction({
  transactionPath,
  entries,
  onEntryCommitted,
}) {
  const pointerPath = path.resolve(transactionPath);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError("Version synchronization requires at least one file");
  }
  await recoverVersionSyncTransaction(pointerPath);

  const transactionDirectory = `${pointerPath}.${process.pid}.${crypto.randomUUID()}.transaction`;
  const originalDirectory = path.join(transactionDirectory, "original");
  const stagedDirectory = path.join(transactionDirectory, "staged");
  await fs.mkdir(originalDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagedDirectory, { recursive: true, mode: 0o700 });
  let manifest = null;

  try {
    const seenDestinations = new Set();
    const manifestEntries = [];
    for (const [index, entry] of entries.entries()) {
      const rawDestination = typeof entry?.destination === "string" ? entry.destination.trim() : "";
      const destination = path.resolve(rawDestination);
      if (!rawDestination || seenDestinations.has(destination)) {
        throw new TypeError("Version synchronization destinations must be unique");
      }
      seenDestinations.add(destination);
      if (typeof entry?.content !== "string") {
        throw new TypeError(`Version synchronization content is invalid for ${destination}`);
      }

      const original = await snapshot(destination);
      const originalPath = path.join(originalDirectory, String(index));
      const stagedPath = path.join(stagedDirectory, String(index));
      if (original.exists) await copyAndSync(destination, originalPath, original.mode);
      await writeAndSync(stagedPath, entry.content, original.mode);
      manifestEntries.push({
        destination,
        originalPath,
        stagedPath,
        originalExists: original.exists,
        originalDigest: original.digest,
        newDigest: digest(entry.content),
        mode: original.mode,
      });
    }

    manifest = {
      schemaVersion: SCHEMA_VERSION,
      phase: "prepared",
      transactionDirectory,
      entries: manifestEntries,
      createdAt: Date.now(),
    };
    await writeJsonAtomic(pointerPath, manifest);
    manifest.phase = "committing";
    await writeJsonAtomic(pointerPath, manifest);

    for (const [index, entry] of manifest.entries.entries()) {
      await assertCurrentDigest(entry, entry.originalExists, entry.originalDigest);
      await installStagedEntry(entry);
      if (typeof onEntryCommitted === "function") await onEntryCommitted(entry, index);
    }

    manifest.phase = "committed";
    await writeJsonAtomic(pointerPath, manifest);
    await finishTransaction(pointerPath, manifest);
  } catch (error) {
    if (manifest) {
      try {
        await recoverVersionSyncTransaction(pointerPath);
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
      }
    } else {
      await fs.rm(transactionDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function restoreEntry(entry) {
  const current = await snapshot(entry.destination);
  if (stateMatches(current, entry.originalExists, entry.originalDigest)) return;
  if (!stateMatches(current, true, entry.newDigest)) {
    throw transactionError(
      "ERR_VERSION_SYNC_RECOVERY_CONFLICT",
      `Cannot recover version synchronization because ${entry.destination} changed externally`,
    );
  }
  if (!entry.originalExists) {
    await fs.unlink(entry.destination).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(path.dirname(entry.destination));
    return;
  }
  const temporary = `${entry.destination}.${process.pid}.${crypto.randomUUID()}.restore`;
  try {
    await copyAndSync(entry.originalPath, temporary, entry.mode);
    await fs.rename(temporary, entry.destination);
    await syncDirectory(path.dirname(entry.destination));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function installStagedEntry(entry) {
  await fs.mkdir(path.dirname(entry.destination), { recursive: true, mode: 0o755 });
  const temporary = `${entry.destination}.${process.pid}.${crypto.randomUUID()}.sync`;
  try {
    await copyAndSync(entry.stagedPath, temporary, entry.mode);
    await fs.rename(temporary, entry.destination);
    await syncDirectory(path.dirname(entry.destination));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function assertCurrentDigest(entry, exists, expectedDigest) {
  const current = await snapshot(entry.destination);
  if (!stateMatches(current, exists, expectedDigest)) {
    throw transactionError(
      "ERR_VERSION_SYNC_SOURCE_CHANGED",
      `Version synchronization source changed while preparing ${entry.destination}`,
    );
  }
}

async function snapshot(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw transactionError("ERR_VERSION_SYNC_TARGET", `Version synchronization target is not a regular file: ${filePath}`);
    }
    const content = await fs.readFile(filePath);
    return {
      exists: true,
      digest: digest(content),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, digest: null, mode: 0o644 };
    throw error;
  }
}

function stateMatches(state, exists, expectedDigest) {
  return exists === state.exists && (!exists || state.digest === expectedDigest);
}

async function finishTransaction(pointerPath, manifest) {
  validateManifest(manifest, pointerPath);
  await fs.rm(manifest.transactionDirectory, { recursive: true, force: true });
  await fs.unlink(pointerPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(path.dirname(pointerPath));
}

async function removeOrphanTransactions(pointerPath) {
  const directory = path.dirname(pointerPath);
  const prefix = `${path.basename(pointerPath)}.`;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => fs.rm(path.join(directory, entry.name), { recursive: true, force: true })));
}

function validateManifest(manifest, pointerPath) {
  if (
    manifest?.schemaVersion !== SCHEMA_VERSION
    || !["prepared", "committing", "committed", "rolled-back"].includes(manifest.phase)
    || !Array.isArray(manifest.entries)
    || !manifest.transactionDirectory
  ) {
    throw transactionError("ERR_VERSION_SYNC_TRANSACTION", "Version synchronization transaction journal is invalid");
  }
  const pointerDirectory = path.dirname(pointerPath);
  const transactionDirectory = path.resolve(manifest.transactionDirectory);
  if (
    path.dirname(transactionDirectory) !== pointerDirectory
    || !path.basename(transactionDirectory).startsWith(`${path.basename(pointerPath)}.`)
  ) {
    throw transactionError("ERR_VERSION_SYNC_TRANSACTION", "Version synchronization transaction directory is invalid");
  }
  for (const entry of manifest.entries) {
    const originalPath = path.resolve(String(entry?.originalPath || ""));
    const stagedPath = path.resolve(String(entry?.stagedPath || ""));
    if (
      typeof entry?.destination !== "string"
      || typeof entry.originalPath !== "string"
      || typeof entry.stagedPath !== "string"
      || typeof entry.originalExists !== "boolean"
      || typeof entry.newDigest !== "string"
      || (entry.originalExists && typeof entry.originalDigest !== "string")
    ) {
      throw transactionError("ERR_VERSION_SYNC_TRANSACTION", "Version synchronization transaction entry is invalid");
    }
    if (!isWithin(transactionDirectory, originalPath) || !isWithin(transactionDirectory, stagedPath)) {
      throw transactionError("ERR_VERSION_SYNC_TRANSACTION", "Version synchronization journal paths escaped its transaction directory");
    }
  }
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeAndSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 0o600);
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function copyAndSync(source, destination, mode) {
  await fs.copyFile(source, destination);
  await fs.chmod(destination, mode);
  const handle = await fs.open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAndSync(destination, content, mode) {
  const handle = await fs.open(destination, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
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

function digest(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function transactionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
