import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

export class ImageSecureInputError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ImageSecureInputError";
    this.code = code;
  }
}

export async function readSecureProjectImage({
  projectRealPath,
  targetPath,
  relativePath,
  maxBytes,
}) {
  let opened;
  try {
    opened = await openSecureProjectImage({ projectRealPath, targetPath, relativePath, maxBytes });
    const data = await readFileHandleBounded(opened.handle, maxBytes);
    return { path: opened.path, data, stat: opened.stat };
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

export async function stageSecureProjectImage({
  projectRealPath,
  targetPath,
  relativePath,
  maxBytes,
  destinationPath,
}) {
  if (typeof destinationPath !== "string" || !destinationPath) {
    throw new TypeError("destinationPath must be a non-empty string");
  }

  const resolvedDestination = path.resolve(destinationPath);
  let source;
  let destination;
  let destinationCreated = false;
  let completed = false;
  try {
    source = await openSecureProjectImage({ projectRealPath, targetPath, relativePath, maxBytes });
    destination = await openExclusiveDestination(resolvedDestination);
    destinationCreated = true;
    await destination.handle.chmod(0o600);

    const copied = await copyFileHandleBounded(source.handle, destination.handle, maxBytes);
    const [sourceFinalStat, destinationFinalStat] = await Promise.all([
      source.handle.stat(),
      destination.handle.stat(),
    ]);
    if (sourceFinalStat.dev !== source.stat.dev || sourceFinalStat.ino !== source.stat.ino) {
      throw secureInputError("SYMLINK", "Image input identity changed while staging");
    }
    if (destinationFinalStat.size !== copied.size) {
      throw secureInputError("DESTINATION_INVALID", "Image staging destination size is inconsistent");
    }
    await destination.handle.sync();
    completed = true;
    return {
      path: source.path,
      sourcePath: source.path,
      relativePath,
      destinationPath: destination.path,
      size: copied.size,
      sha256: copied.sha256,
      source: fileIdentity(sourceFinalStat),
      destination: fileIdentity(destinationFinalStat),
    };
  } finally {
    await destination?.handle.close().catch(() => {});
    await source?.handle.close().catch(() => {});
    if (destinationCreated && !completed) {
      await removeCreatedDestination(
        [destination?.path, resolvedDestination],
        destination?.stat,
      );
    }
  }
}

async function openSecureProjectImage({ projectRealPath, targetPath, relativePath, maxBytes }) {
  const projectRoot = path.resolve(projectRealPath);
  const expectedPath = path.resolve(projectRoot, ...String(relativePath).split("/"));
  if (!isPathInside(projectRoot, expectedPath)) {
    throw secureInputError("SYMLINK", "Image input path is outside the project");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  let handle;
  try {
    const flags = fsConstants.O_RDONLY | linuxNoFollowFlag();
    try {
      handle = await fsPromises.open(targetPath, flags);
    } catch (error) {
      if (process.platform === "linux" && error?.code === "ELOOP") {
        throw secureInputError("SYMLINK", "Image input must not be a symbolic link", error);
      }
      throw error;
    }

    const stat = await handle.stat();
    if (!stat.isFile()) throw secureInputError("NOT_FILE", "Image input must be a regular file");
    if (stat.size > maxBytes) throw secureInputError("TOO_LARGE", "Image input exceeds the byte limit");

    const actualPath = await openedFilePath(handle, targetPath);
    if (!isPathInside(projectRoot, actualPath) || actualPath !== expectedPath) {
      throw secureInputError("SYMLINK", "Image input path was redirected");
    }
    await assertOpenedPathIdentity(expectedPath, stat, "SYMLINK", "Image input path was redirected");
    return { handle, path: actualPath, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function openExclusiveDestination(destinationPath) {
  let handle;
  try {
    try {
      handle = await fsPromises.open(
        destinationPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | linuxNoFollowFlag(),
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST" || error?.code === "ELOOP") {
        let symbolicLink = false;
        try {
          symbolicLink = (await fsPromises.lstat(destinationPath)).isSymbolicLink();
        } catch {}
        throw secureInputError(
          symbolicLink ? "DESTINATION_SYMLINK" : "DESTINATION_EXISTS",
          symbolicLink
            ? "Image staging destination must not be a symbolic link"
            : "Image staging destination already exists",
          error,
        );
      }
      throw error;
    }

    const stat = await handle.stat();
    if (!stat.isFile()) throw secureInputError("DESTINATION_INVALID", "Image staging destination is not a regular file");
    const actualPath = await openedFilePath(handle, destinationPath);
    if (actualPath !== destinationPath) {
      throw secureInputError("DESTINATION_SYMLINK", "Image staging destination path was redirected");
    }
    await assertOpenedPathIdentity(
      destinationPath,
      stat,
      "DESTINATION_SYMLINK",
      "Image staging destination path was redirected",
    );
    return { handle, path: actualPath, stat };
  } catch (error) {
    if (handle) {
      const stat = await handle.stat().catch(() => null);
      const actualPath = await openedFilePath(handle, destinationPath).catch(() => null);
      await handle.close().catch(() => {});
      await removeCreatedDestination([actualPath, destinationPath], stat);
    }
    throw error;
  }
}

async function openedFilePath(handle, targetPath) {
  if (process.platform === "linux") {
    return fsPromises.realpath(`/proc/self/fd/${handle.fd}`);
  }
  return fsPromises.realpath(targetPath);
}

async function assertOpenedPathIdentity(expectedPath, openedStat, code, message) {
  let targetStat;
  try {
    targetStat = await fsPromises.lstat(expectedPath);
  } catch (error) {
    throw secureInputError(code, message, error);
  }
  if (
    targetStat.isSymbolicLink()
    || targetStat.dev !== openedStat.dev
    || targetStat.ino !== openedStat.ino
  ) throw secureInputError(code, message);
}

async function readFileHandleBounded(handle, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const remaining = maxBytes - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) throw secureInputError("TOO_LARGE", "Image input exceeds the byte limit");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function copyFileHandleBounded(source, destination, maxBytes) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let totalBytes = 0;
  while (true) {
    const readLength = Math.min(buffer.length, (maxBytes - totalBytes) + 1);
    const { bytesRead } = await source.read(buffer, 0, readLength, null);
    if (!bytesRead) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) throw secureInputError("TOO_LARGE", "Image input exceeds the byte limit");
    hash.update(buffer.subarray(0, bytesRead));
    await writeFileHandleFully(destination, buffer, bytesRead);
  }
  return { size: totalBytes, sha256: hash.digest("hex") };
}

async function writeFileHandleFully(handle, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset, null);
    if (!bytesWritten) throw secureInputError("DESTINATION_INVALID", "Image staging destination write made no progress");
    offset += bytesWritten;
  }
}

async function removeCreatedDestination(paths, identity) {
  if (!identity) return;
  for (const candidate of new Set(paths.filter(Boolean))) {
    try {
      const stat = await fsPromises.lstat(candidate);
      if (!stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) {
        await fsPromises.unlink(candidate);
        return;
      }
    } catch {}
  }
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
  };
}

function linuxNoFollowFlag() {
  return process.platform === "linux" ? (fsConstants.O_NOFOLLOW || 0) : 0;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function secureInputError(code, message, cause) {
  return new ImageSecureInputError(code, message, cause ? { cause } : undefined);
}
