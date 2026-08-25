import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireOperationLock } from "./operation-lock.mjs";

const DEFAULT_LOCK_WAIT_MS = 10 * 60_000;

/**
 * Publish an archive and its checksum without ever replacing archive bytes
 * that were already accepted for the same immutable name.
 *
 * The operation lock keeps the two-file publication sequence serial across
 * backup and candidate-package processes. The hard-link publication is still
 * exclusive, so an unexpected writer cannot turn the final archive rename
 * into an overwrite.
 */
export async function publishImmutableArchive({
  sourceArchive,
  destinationArchive,
  destinationChecksum,
  archiveName,
  ownerCommand,
  acceptedCommands = [],
  operationId,
  conflictMessage = "Another release archive publication is already running",
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
}) {
  if (!sourceArchive || !destinationArchive || !destinationChecksum || !archiveName || !ownerCommand) {
    throw new TypeError("Archive publication paths and owner command are required");
  }
  const destinationDirectory = path.dirname(destinationArchive);
  const checksumDirectory = path.dirname(destinationChecksum);
  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
  if (checksumDirectory !== destinationDirectory) {
    await fs.mkdir(checksumDirectory, { recursive: true, mode: 0o755 });
  }

  const lockPath = `${destinationArchive}.publish.lock`;
  const lock = await acquirePublicationLock(lockPath, {
    ownerCommand,
    acceptedCommands: [...new Set([ownerCommand, ...acceptedCommands])],
    operationId: operationId || `archive:${archiveName}`,
    conflictMessage,
    lockWaitMs,
  });
  const suffix = `${process.pid}.${crypto.randomUUID()}.tmp`;
  const temporaryArchive = `${destinationArchive}.${suffix}`;
  const temporaryChecksum = `${destinationChecksum}.${suffix}`;

  try {
    await copyAndSync(sourceArchive, temporaryArchive, 0o644);
    const digest = crypto.createHash("sha256").update(await fs.readFile(temporaryArchive)).digest("hex");
    await writeAndSync(temporaryChecksum, `${digest}  ${archiveName}\n`, 0o644);

    const existingArchive = await readOptional(destinationArchive);
    if (existingArchive !== null) {
      assertArchiveDigest(existingArchive, digest, archiveName);
    } else {
      // An orphan checksum from an interrupted publication is only safe to
      // retain when it already describes the archive we are about to expose.
      const existingChecksum = await readOptional(destinationChecksum, "utf8");
      if (existingChecksum !== null && !checksumMatches(existingChecksum, digest)) {
        throw new Error("Existing release checksum is not compatible with the immutable source");
      }
      try {
        await fs.link(temporaryArchive, destinationArchive);
        await syncDirectory(destinationDirectory);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const racedArchive = await readOptional(destinationArchive);
        if (racedArchive === null) throw error;
        assertArchiveDigest(racedArchive, digest, archiveName);
      }
    }

    await publishChecksum({
      temporaryChecksum,
      destinationChecksum,
      digest,
      archiveName,
      directory: checksumDirectory,
    });
    return digest;
  } finally {
    try {
      await Promise.all([
        fs.rm(temporaryArchive, { force: true }),
        fs.rm(temporaryChecksum, { force: true }),
      ]);
    } finally {
      await lock.release();
    }
  }
}

async function acquirePublicationLock(lockPath, options) {
  const deadline = Date.now() + Math.max(1_000, Number(options.lockWaitMs) || DEFAULT_LOCK_WAIT_MS);
  while (true) {
    try {
      return await acquireOperationLock(lockPath, {
        ownerCommand: options.ownerCommand,
        acceptedCommands: options.acceptedCommands,
        operationId: options.operationId,
        conflictMessage: options.conflictMessage,
        acquireWaitMs: 100,
      });
    } catch (error) {
      if (error.code !== "ERR_OPERATION_LOCKED" || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

async function publishChecksum({
  temporaryChecksum,
  destinationChecksum,
  digest,
  archiveName,
  directory,
}) {
  const existingChecksum = await readOptional(destinationChecksum, "utf8");
  if (existingChecksum !== null) {
    if (checksumMatches(existingChecksum, digest)) return;
    // The archive was already verified above, so replacing a stale sidecar
    // cannot make the immutable archive/checksum pair disagree.
    await fs.rename(temporaryChecksum, destinationChecksum);
    await syncDirectory(directory);
    return;
  }

  try {
    await fs.link(temporaryChecksum, destinationChecksum);
    await syncDirectory(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const racedChecksum = await readOptional(destinationChecksum, "utf8");
    if (racedChecksum !== null && checksumMatches(racedChecksum, digest)) return;
    throw new Error(`Existing checksum is not compatible with immutable archive ${archiveName}`);
  }
}

async function readOptional(filePath, encoding) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Immutable archive publication target is not a regular file: ${filePath}`);
    }
    return await fs.readFile(filePath, encoding);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertArchiveDigest(content, digest, archiveName) {
  const existingDigest = crypto.createHash("sha256").update(content).digest("hex");
  if (existingDigest !== digest) {
    throw new Error(`Existing archive differs from the immutable source for ${archiveName}`);
  }
}

function checksumMatches(content, digest) {
  const value = String(content).trim().split(/\s+/, 1)[0];
  return /^[a-f0-9]{64}$/i.test(value) && value.toLowerCase() === digest;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
