import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectImageBuffer } from "./image-file.mjs";

const TEMPORARY_CREATE_MODE = 0o600;
const MAX_TEMPORARY_NAME_ATTEMPTS = 4;
const FILE_COPY_BUFFER_BYTES = 64 * 1024;
const IMAGE_MEDIA_TYPES = new Map([
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

export async function publishNewImage(options = {}, publishOptions = {}) {
  const [result] = await publishImageBatch({ outputs: [options] }, publishOptions);
  return result;
}

export async function publishImageBatch({ outputs } = {}, { fileSystem = fs, projectAnchor = null } = {}) {
  const entries = await bindProjectAnchor(prepareBufferBatch(outputs), projectAnchor);
  return publishPreparedBatch(entries, stageImage, fileSystem);
}

export async function publishImageFileBatch({
  outputs,
  maxBytesPerFile = Number.MAX_SAFE_INTEGER,
  maxTotalBytes = Number.MAX_SAFE_INTEGER,
} = {}, { fileSystem = fs, projectAnchor = null } = {}) {
  const entries = await bindProjectAnchor(
    prepareFileBatch(outputs, { maxBytesPerFile, maxTotalBytes }),
    projectAnchor,
  );
  return publishPreparedBatch(entries, stageImageFile, fileSystem);
}

/**
 * Atomically publish an immutable batch containing arbitrary files. Each
 * source is still pinned by an expected size and SHA-256 digest; callers are
 * responsible for validating the file semantics before admission.
 */
export async function publishFileBatch({
  outputs,
  maxBytesPerFile = Number.MAX_SAFE_INTEGER,
  maxTotalBytes = Number.MAX_SAFE_INTEGER,
} = {}, { fileSystem = fs, projectAnchor = null, journal = null } = {}) {
  const entries = await bindProjectAnchor(
    prepareGenericFileBatch(outputs, { maxBytesPerFile, maxTotalBytes }),
    projectAnchor,
  );
  return publishPreparedBatch(
    entries,
    (entry, selectedFileSystem) => entry.buffer
      ? stageImage(entry, selectedFileSystem)
      : stageImageFile(entry, selectedFileSystem),
    fileSystem,
    journal,
  );
}

async function publishPreparedBatch(entries, stageEntry, fileSystem, journal = null) {
  const staged = [];
  const published = [];

  try {
    await assertAnchorIdentities(entries);
    for (const entry of entries) staged.push(await stageEntry(entry, fileSystem));
    await notifyJournal(journal, "staged", staged, published);

    for (const entry of staged) {
      await assertAnchorIdentities([entry]);
      try {
        await fileSystem.link(entry.temporaryPath, entry.targetPath);
        published.push(entry);
        await notifyJournal(journal, "linking", staged, published);
      } catch (error) {
        // Conservatively inspect this target during rollback: an adapter can
        // report an error after the hard link has already been created.
        published.push(entry);
        if (error?.code === "EEXIST") throw outputExistsError(entry.targetPath, error);
        throw error;
      }
    }

    await notifyJournal(journal, "linked", staged, published, { allLinked: true });
    await assertAnchorIdentities(staged);
    await syncDirectories(staged, fileSystem);
    for (const entry of staged) {
      await fileSystem.unlink(entry.temporaryPath);
      entry.temporaryRemoved = true;
    }
    await syncDirectories(staged, fileSystem);
    await notifyJournal(journal, "committed", staged, published, { allLinked: true });

    return staged.map(({ result }) => result);
  } catch (error) {
    const rollback = await rollbackBatch({ staged, published, fileSystem });
    attachRollbackMetadata(error, rollback);
    await notifyJournal(journal, "rolled-back", staged, [], { rollback }).catch((journalError) => {
      attachRollbackMetadata(error, {
        failures: [{ operation: "write-recovery-journal", code: safeErrorCode(journalError) }],
        partialOutputs: rollback.partialOutputs,
      });
    });
    throw error;
  } finally {
    for (const entry of staged) {
      if (entry.handle) await entry.handle.close().catch(() => {});
    }
    // A staging failure may leave bound parent handles on entries that never
    // made it into `staged`; close every bound target exactly once.
    for (const entry of entries) {
      if (entry.projectTarget) {
        await entry.projectTarget.close();
        entry.projectTarget = null;
      }
    }
  }
}

async function bindProjectAnchor(entries, projectAnchor) {
  if (!projectAnchor) return entries;
  if (typeof projectAnchor.resolveTarget !== "function" || typeof projectAnchor.assertIdentity !== "function") {
    throw invalidArgument("projectAnchor must be an image project anchor");
  }
  try {
    for (const entry of entries) {
      if (!entry.requestedTargetPath) entry.requestedTargetPath = entry.targetPath;
      const resolved = await projectAnchor.resolveTarget(entry.targetPath);
      entry.projectTarget = resolved;
      entry.projectAnchor = projectAnchor;
      entry.targetPath = resolved.targetPath;
      entry.directory = resolved.directory;
      entry.safeName = resolved.basename;
    }
    return entries;
  } catch (error) {
    for (const entry of entries) {
      if (entry.projectTarget) await entry.projectTarget.close();
    }
    throw error;
  }
}

async function assertAnchorIdentities(entries) {
  const anchors = [...new Set(entries.map((entry) => entry.projectAnchor).filter(Boolean))];
  for (const anchor of anchors) await anchor.assertIdentity();
}

function prepareBufferBatch(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw invalidArgument("outputs must be a non-empty array");
  }

  const targetKeys = new Set();
  return outputs.map((output, index) => {
    validateArguments(output ?? {});
    const { targetPath, data, mode = 0o640, uid = null, gid = null, inspectOptions = {} } = output;
    const targetKey = path.resolve(targetPath);
    if (targetKeys.has(targetKey)) throw invalidArgument("outputs must use distinct target paths");
    targetKeys.add(targetKey);

    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const inspected = inspectImageBuffer(buffer, inspectOptions);
    return {
      index,
      targetPath,
      safeName: path.basename(targetPath),
      directory: path.dirname(targetPath),
      buffer,
      mode,
      uid,
      gid,
      result: {
        path: targetPath,
        ...inspected,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      },
      projectAnchor: null,
    };
  });
}

function prepareFileBatch(outputs, { maxBytesPerFile, maxTotalBytes }) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw invalidArgument("outputs must be a non-empty array");
  }
  validateByteLimit(maxBytesPerFile, "maxBytesPerFile");
  validateByteLimit(maxTotalBytes, "maxTotalBytes");

  const targetKeys = new Set();
  let totalBytes = 0;
  return outputs.map((output, index) => {
    validateFileArguments(output ?? {});
    const {
      sourcePath,
      targetPath,
      expected,
      mode = 0o640,
      uid = null,
      gid = null,
    } = output;
    const targetKey = path.resolve(targetPath);
    if (targetKeys.has(targetKey)) throw invalidArgument("outputs must use distinct target paths");
    targetKeys.add(targetKey);
    if (expected.size > maxBytesPerFile) throw sourceTooLargeError("Image source exceeds maxBytesPerFile");
    totalBytes += expected.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw sourceTooLargeError("Image sources exceed maxTotalBytes");
    }

    const normalizedExpected = {
      size: expected.size,
      sha256: expected.sha256.toLowerCase(),
      format: expected.format,
      width: expected.width,
      height: expected.height,
      mediaType: expected.mediaType,
    };
    return {
      index,
      sourcePath,
      targetPath,
      safeName: path.basename(targetPath),
      directory: path.dirname(targetPath),
      expected: normalizedExpected,
      mode,
      uid,
      gid,
      result: { path: targetPath, ...normalizedExpected },
      projectAnchor: null,
    };
  });
}

function prepareGenericFileBatch(outputs, { maxBytesPerFile, maxTotalBytes }) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw invalidArgument("outputs must be a non-empty array");
  }
  validateByteLimit(maxBytesPerFile, "maxBytesPerFile");
  validateByteLimit(maxTotalBytes, "maxTotalBytes");

  const targetKeys = new Set();
  let totalBytes = 0;
  return outputs.map((output, index) => {
    const {
      sourcePath = null,
      data = null,
      targetPath,
      expected = null,
      mode = 0o640,
      uid = null,
      gid = null,
    } = output ?? {};
    validateTargetArguments({ targetPath, mode, uid, gid });
    const hasSource = typeof sourcePath === "string" && Boolean(sourcePath) && Boolean(path.basename(sourcePath));
    const hasData = data instanceof Uint8Array;
    if (hasSource === hasData) {
      throw invalidArgument("each generic output must provide exactly one of sourcePath or data");
    }
    const buffer = hasData
      ? (Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      : null;
    const normalizedExpected = hasSource
      ? normalizeGenericExpected(expected)
      : {
          size: buffer.length,
          sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        };
    if (hasData && expected != null) {
      const declared = normalizeGenericExpected(expected);
      if (declared.size !== normalizedExpected.size || declared.sha256 !== normalizedExpected.sha256) {
        throw invalidArgument("generic data does not match expected size or SHA-256");
      }
    }
    if (normalizedExpected.size > maxBytesPerFile) {
      throw sourceTooLargeError("File source exceeds maxBytesPerFile");
    }
    totalBytes += normalizedExpected.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw sourceTooLargeError("File sources exceed maxTotalBytes");
    }
    const targetKey = path.resolve(targetPath);
    if (targetKeys.has(targetKey)) throw invalidArgument("outputs must use distinct target paths");
    targetKeys.add(targetKey);
    return {
      index,
      sourcePath: hasSource ? sourcePath : null,
      targetPath,
      safeName: path.basename(targetPath),
      directory: path.dirname(targetPath),
      buffer,
      expected: normalizedExpected,
      mode,
      uid,
      gid,
      result: { path: targetPath, ...normalizedExpected },
      projectAnchor: null,
    };
  });
}

function normalizeGenericExpected(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw invalidArgument("expected must be an object");
  }
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0) {
    throw invalidArgument("expected.size must be a positive safe integer");
  }
  if (typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expected.sha256)) {
    throw invalidArgument("expected.sha256 must be a SHA-256 hex digest");
  }
  return { size: expected.size, sha256: expected.sha256.toLowerCase() };
}

async function stageImage(entry, fileSystem) {
  const staged = {
    ...entry,
    handle: null,
    temporaryPath: null,
    temporaryRemoved: false,
    device: null,
    inode: null,
  };

  try {
    const temporary = await openTemporaryImage(fileSystem, entry.directory, entry.safeName);
    staged.handle = temporary.handle;
    staged.temporaryPath = temporary.temporaryPath;
    staged.recoveryTemporaryPath = recoveryTemporaryPath(entry, temporary.temporaryPath);
    await staged.handle.writeFile(entry.buffer);
    await staged.handle.sync();

    let current = await staged.handle.stat();
    const desiredUid = entry.uid ?? current.uid;
    const desiredGid = entry.gid ?? current.gid;
    if (current.uid !== desiredUid || current.gid !== desiredGid) {
      await staged.handle.chown(desiredUid, desiredGid);
    }
    if ((current.mode & 0o7777) !== entry.mode) await staged.handle.chmod(entry.mode);
    await staged.handle.sync();
    current = await staged.handle.stat();
    staged.device = current.dev;
    staged.inode = current.ino;
    await staged.handle.close();
    staged.handle = null;
    return staged;
  } catch (error) {
    const failures = [];
    if (staged.handle) {
      await staged.handle.close().catch((closeError) => {
        failures.push(safeRollbackFailure(staged, "close-temporary", closeError));
      });
      staged.handle = null;
    }
    if (staged.temporaryPath) {
      await fileSystem.unlink(staged.temporaryPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") {
          failures.push(safeRollbackFailure(staged, "remove-temporary", unlinkError));
        }
      });
      await syncDirectory(fileSystem, staged.directory).catch((syncError) => {
        failures.push({ operation: "sync-directory", code: safeErrorCode(syncError) });
      });
    }
    attachRollbackMetadata(error, { failures, partialOutputs: [] });
    throw error;
  }
}

async function stageImageFile(entry, fileSystem) {
  const staged = {
    ...entry,
    handle: null,
    sourceHandle: null,
    temporaryPath: null,
    temporaryRemoved: false,
    device: null,
    inode: null,
  };

  try {
    staged.sourceHandle = await openSourceImage(fileSystem, entry.sourcePath);
    const sourceStat = await staged.sourceHandle.stat();
    if (!sourceStat.isFile()) throw sourceNotRegularError();
    if (sourceStat.size !== entry.expected.size) {
      throw sourceSizeMismatchError(entry.expected.size, sourceStat.size);
    }

    const temporary = await openTemporaryImage(fileSystem, entry.directory, entry.safeName);
    staged.handle = temporary.handle;
    staged.temporaryPath = temporary.temporaryPath;
    staged.recoveryTemporaryPath = recoveryTemporaryPath(entry, temporary.temporaryPath);
    const copied = await copyAndHashImage(staged.sourceHandle, staged.handle, entry.expected.size);
    if (copied.size !== entry.expected.size) {
      throw sourceSizeMismatchError(entry.expected.size, copied.size);
    }
    if (copied.sha256 !== entry.expected.sha256) {
      throw sourceDigestMismatchError();
    }
    await staged.sourceHandle.close();
    staged.sourceHandle = null;
    await staged.handle.sync();

    let current = await staged.handle.stat();
    if (current.size !== entry.expected.size) {
      throw sourceSizeMismatchError(entry.expected.size, current.size);
    }
    const desiredUid = entry.uid ?? current.uid;
    const desiredGid = entry.gid ?? current.gid;
    if (current.uid !== desiredUid || current.gid !== desiredGid) {
      await staged.handle.chown(desiredUid, desiredGid);
    }
    if ((current.mode & 0o7777) !== entry.mode) await staged.handle.chmod(entry.mode);
    await staged.handle.sync();
    current = await staged.handle.stat();
    staged.device = current.dev;
    staged.inode = current.ino;
    await staged.handle.close();
    staged.handle = null;
    return staged;
  } catch (error) {
    const failures = [];
    if (staged.sourceHandle) {
      await staged.sourceHandle.close().catch(() => {});
      staged.sourceHandle = null;
    }
    if (staged.handle) {
      await staged.handle.close().catch((closeError) => {
        failures.push(safeRollbackFailure(staged, "close-temporary", closeError));
      });
      staged.handle = null;
    }
    if (staged.temporaryPath) {
      await fileSystem.unlink(staged.temporaryPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") {
          failures.push(safeRollbackFailure(staged, "remove-temporary", unlinkError));
        }
      });
      await syncDirectory(fileSystem, staged.directory).catch((syncError) => {
        failures.push({ operation: "sync-directory", code: safeErrorCode(syncError) });
      });
    }
    attachRollbackMetadata(error, { failures, partialOutputs: [] });
    throw error;
  }
}

async function openSourceImage(fileSystem, sourcePath) {
  try {
    return await fileSystem.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw sourceSymlinkError(error);
    throw error;
  }
}

async function copyAndHashImage(sourceHandle, targetHandle, expectedSize) {
  const buffer = Buffer.allocUnsafe(Math.min(FILE_COPY_BUFFER_BYTES, expectedSize + 1));
  const digest = crypto.createHash("sha256");
  let size = 0;

  while (size <= expectedSize) {
    const maximumRead = Math.min(buffer.length, (expectedSize - size) + 1);
    const { bytesRead } = await sourceHandle.read(buffer, 0, maximumRead, null);
    if (bytesRead === 0) break;
    if (size + bytesRead > expectedSize) {
      throw sourceSizeMismatchError(expectedSize, size + bytesRead);
    }
    digest.update(buffer.subarray(0, bytesRead));
    await writeAll(targetHandle, buffer, bytesRead);
    size += bytesRead;
  }

  return { size, sha256: digest.digest("hex") };
}

async function writeAll(handle, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      const error = new Error("Unable to write image temporary file");
      error.code = "IMAGE_TEMPORARY_WRITE_FAILED";
      throw error;
    }
    offset += bytesWritten;
  }
}

async function rollbackBatch({ staged, published, fileSystem }) {
  const failures = [];
  const publishedSet = new Set(published);

  for (const entry of [...published].reverse()) {
    try {
      if (await pathReferencesStagedImage(entry.targetPath, entry, fileSystem)) {
        await fileSystem.unlink(entry.targetPath);
      }
      publishedSet.delete(entry);
    } catch (error) {
      failures.push(safeRollbackFailure(entry, "remove-output", error));
    }
  }

  for (const entry of staged) {
    if (!entry.temporaryPath || entry.temporaryRemoved) continue;
    try {
      await fileSystem.unlink(entry.temporaryPath);
      entry.temporaryRemoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(safeRollbackFailure(entry, "remove-temporary", error));
    }
  }

  for (const directory of uniqueDirectories(staged)) {
    try {
      await syncDirectory(fileSystem, directory);
    } catch (error) {
      failures.push({ operation: "sync-directory", code: safeErrorCode(error) });
    }
  }

  const partialOutputs = [];
  for (const entry of publishedSet) {
    try {
      if (await pathReferencesStagedImage(entry.targetPath, entry, fileSystem)) {
        partialOutputs.push(safeOutput(entry));
      }
    } catch (error) {
      // When the remaining path cannot be inspected, report it conservatively
      // instead of hiding the original commit failure.
      partialOutputs.push(safeOutput(entry));
      failures.push(safeRollbackFailure(entry, "verify-output-removal", error));
    }
  }
  return { failures, partialOutputs };
}

async function pathReferencesStagedImage(filename, entry, fileSystem) {
  try {
    const current = await fileSystem.lstat(filename);
    return current.dev === entry.device && current.ino === entry.inode;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function openTemporaryImage(fileSystem, directory, basename) {
  for (let attempt = 0; attempt < MAX_TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(directory, `.${basename}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fileSystem.open(candidate, "wx", TEMPORARY_CREATE_MODE);
      return { handle, temporaryPath: candidate };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const error = new Error("Unable to allocate a temporary image output path");
  error.code = "IMAGE_TEMPORARY_PATH_UNAVAILABLE";
  throw error;
}

async function syncDirectories(entries, fileSystem) {
  for (const directory of uniqueDirectories(entries)) await syncDirectory(fileSystem, directory);
}

function uniqueDirectories(entries) {
  return [...new Set(entries.map(({ directory }) => directory))];
}

function recoveryTemporaryPath(entry, temporaryPath) {
  const targetPath = entry.requestedTargetPath || entry.targetPath;
  return path.join(path.dirname(targetPath), path.basename(temporaryPath));
}

async function notifyJournal(journal, phase, staged, published, extra = {}) {
  if (journal == null) return;
  if (typeof journal !== "function") throw invalidArgument("journal must be a function or null");
  const linked = new Set(published.map((entry) => entry.index));
  await journal(Object.freeze({
    phase,
    allLinked: extra.allLinked === true,
    entries: Object.freeze(staged.map((entry) => Object.freeze({
      index: entry.index,
      targetPath: entry.requestedTargetPath || entry.targetPath,
      temporaryPath: entry.recoveryTemporaryPath || entry.temporaryPath,
      device: String(entry.device),
      inode: String(entry.inode),
      size: entry.result.size,
      sha256: entry.result.sha256,
      linked: linked.has(entry.index),
    }))),
    ...(extra.rollback ? { rollback: extra.rollback } : {}),
  }));
}

async function syncDirectory(fileSystem, directory) {
  const handle = await fileSystem.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateArguments({ targetPath, data, mode = 0o640, uid = null, gid = null, inspectOptions = {} }) {
  validateTargetArguments({ targetPath, mode, uid, gid });
  if (!(data instanceof Uint8Array)) throw invalidArgument("data must be a Buffer or Uint8Array");
  if (!inspectOptions || typeof inspectOptions !== "object" || Array.isArray(inspectOptions)) {
    throw invalidArgument("inspectOptions must be an object");
  }
}

function validateFileArguments({
  sourcePath,
  targetPath,
  expected,
  mode = 0o640,
  uid = null,
  gid = null,
}) {
  validateTargetArguments({ targetPath, mode, uid, gid });
  if (typeof sourcePath !== "string" || !sourcePath || !path.basename(sourcePath)) {
    throw invalidArgument("sourcePath must identify a file");
  }
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw invalidArgument("expected must be an object");
  }
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0) {
    throw invalidArgument("expected.size must be a positive safe integer");
  }
  if (typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expected.sha256)) {
    throw invalidArgument("expected.sha256 must be a SHA-256 hex digest");
  }
  if (!IMAGE_MEDIA_TYPES.has(expected.format)) {
    throw invalidArgument("expected.format must be png, jpeg, or webp");
  }
  if (expected.mediaType !== IMAGE_MEDIA_TYPES.get(expected.format)) {
    throw invalidArgument("expected.mediaType does not match expected.format");
  }
  for (const name of ["width", "height"]) {
    if (!Number.isSafeInteger(expected[name]) || expected[name] <= 0) {
      throw invalidArgument(`expected.${name} must be a positive safe integer`);
    }
  }
}

function validateTargetArguments({ targetPath, mode, uid, gid }) {
  if (typeof targetPath !== "string" || !targetPath || !path.basename(targetPath)) {
    throw invalidArgument("targetPath must identify a file");
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw invalidArgument("mode must be an integer between 0 and 07777");
  }
  for (const [name, value] of [["uid", uid], ["gid", gid]]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw invalidArgument(`${name} must be null or a non-negative integer`);
    }
  }
}

function validateByteLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidArgument(`${name} must be a positive safe integer`);
  }
}

function safeOutput(entry) {
  return { index: entry.index, filename: entry.safeName };
}

function safeRollbackFailure(entry, operation, error) {
  return { ...safeOutput(entry), operation, code: safeErrorCode(error) };
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : "IMAGE_ROLLBACK_FAILED";
}

function attachRollbackMetadata(error, { failures, partialOutputs }) {
  if (failures.length === 0 || !error || (typeof error !== "object" && typeof error !== "function")) return;
  error.partialOutputs = [
    ...(Array.isArray(error.partialOutputs) ? error.partialOutputs : []),
    ...partialOutputs,
  ];
  error.rollbackFailures = [
    ...(Array.isArray(error.rollbackFailures) ? error.rollbackFailures : []),
    ...failures,
  ];
}

function invalidArgument(message) {
  const error = new TypeError(message);
  error.code = "INVALID_IMAGE_PUBLISH_ARGUMENT";
  return error;
}

function outputExistsError(targetPath, cause) {
  const error = new Error(`Image output already exists: ${targetPath}`, { cause });
  error.code = "IMAGE_OUTPUT_EXISTS";
  error.statusCode = 409;
  return error;
}

function sourceSymlinkError(cause) {
  const error = new Error("Image source must not be a symbolic link", { cause });
  error.code = "IMAGE_SOURCE_SYMLINK";
  error.statusCode = 403;
  return error;
}

function sourceNotRegularError() {
  const error = new Error("Image source must be a regular file");
  error.code = "IMAGE_SOURCE_NOT_REGULAR";
  error.statusCode = 400;
  return error;
}

function sourceTooLargeError(message) {
  const error = new Error(message);
  error.code = "IMAGE_SOURCE_TOO_LARGE";
  error.statusCode = 413;
  return error;
}

function sourceSizeMismatchError(expectedSize, actualSize) {
  const error = new Error("Image source size does not match worker metadata");
  error.code = "IMAGE_SOURCE_SIZE_MISMATCH";
  error.statusCode = 409;
  error.expectedSize = expectedSize;
  error.actualSize = actualSize;
  return error;
}

function sourceDigestMismatchError() {
  const error = new Error("Image source digest does not match worker metadata");
  error.code = "IMAGE_SOURCE_SHA256_MISMATCH";
  error.statusCode = 409;
  return error;
}
