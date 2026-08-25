import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

/**
 * Open an immutable directory anchor for a project.  Paths resolved through
 * this object are rooted at /proc/self/fd/<root-fd>; replacing any ancestor
 * of the original project path therefore cannot redirect a publish outside
 * the directory represented by the already-open root fd.
 */
export async function openImageProjectAnchor(projectRoot, { fileSystem = fs } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw anchorError("IMAGE_PROJECT_ANCHOR_INVALID", "projectRoot must be an absolute path");
  }
  const rootPath = path.resolve(projectRoot);
  const rootHandle = await openDirectory(fileSystem, rootPath);
  const initial = await rootHandle.stat();
  if (!initial.isDirectory()) {
    await rootHandle.close().catch(() => {});
    throw anchorError("IMAGE_PROJECT_ANCHOR_NOT_DIRECTORY", "projectRoot must be a directory");
  }
  const anchor = {
    projectRoot: rootPath,
    device: initial.dev,
    inode: initial.ino,
    rootHandle,
    get rootFd() { return rootHandle.fd; },
    async assertIdentity() {
      let current;
      let anchored;
      try {
        [current, anchored] = await Promise.all([
          fileSystem.lstat(rootPath),
          rootHandle.stat(),
        ]);
      } catch (error) {
        throw anchorError("IMAGE_PROJECT_CHANGED", "project root identity changed", error);
      }
      if (current.dev !== initial.dev || current.ino !== initial.ino || !current.isDirectory()) {
        throw anchorError("IMAGE_PROJECT_CHANGED", "project root identity changed");
      }
      if (anchored.dev !== initial.dev || anchored.ino !== initial.ino || !anchored.isDirectory()) {
        throw anchorError("IMAGE_PROJECT_CHANGED", "project root identity changed");
      }
      return { dev: initial.dev, ino: initial.ino };
    },
    async resolveTarget(targetPath, {
      createParents = true,
      directoryMode = 0o750,
      uid = null,
      gid = null,
    } = {}) {
      if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
        throw anchorError("IMAGE_PROJECT_TARGET_INVALID", "targetPath must be an absolute path");
      }
      const relative = path.relative(rootPath, path.resolve(targetPath));
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw anchorError("IMAGE_PROJECT_TARGET_OUTSIDE", "targetPath is outside the project root");
      }
      const segments = relative.split(path.sep).filter(Boolean);
      const basename = segments.pop();
      if (!basename || basename === "." || basename === "..") {
        throw anchorError("IMAGE_PROJECT_TARGET_INVALID", "targetPath must identify a file");
      }
      if (!Number.isInteger(directoryMode) || directoryMode < 0 || directoryMode > 0o7777) {
        throw anchorError("IMAGE_PROJECT_TARGET_INVALID", "directoryMode must be a valid file mode");
      }
      for (const [name, value] of [["uid", uid], ["gid", gid]]) {
        if (value !== null && (!Number.isInteger(value) || value < 0)) {
          throw anchorError("IMAGE_PROJECT_TARGET_INVALID", `${name} must be a non-negative integer or null`);
        }
      }
      const handles = [];
      let directoryPath = `/proc/self/fd/${rootHandle.fd}`;
      try {
        for (const segment of segments) {
          const nextPath = path.join(directoryPath, segment);
          let nextHandle;
          let created = false;
          try {
            nextHandle = await openDirectory(fileSystem, nextPath);
          } catch (error) {
            if (error?.code !== "ENOENT" || !createParents) throw error;
            await fileSystem.mkdir(nextPath, { mode: directoryMode });
            nextHandle = await openDirectory(fileSystem, nextPath);
            created = true;
          }
          if (created) {
            if (uid !== null || gid !== null) {
              const current = await nextHandle.stat();
              await nextHandle.chown(uid ?? current.uid, gid ?? current.gid);
            }
            await nextHandle.chmod(directoryMode);
          }
          handles.push(nextHandle);
          directoryPath = `/proc/self/fd/${nextHandle.fd}`;
        }
        return {
          requestedTargetPath: targetPath,
          targetPath: path.join(directoryPath, basename),
          directory: directoryPath,
          basename,
          handles,
          async close() {
            for (const handle of [...handles].reverse()) await handle.close().catch(() => {});
          },
        };
      } catch (error) {
        for (const handle of [...handles].reverse()) await handle.close().catch(() => {});
        throw error;
      }
    },
    async close() { await rootHandle.close(); },
  };
  return anchor;
}
async function openDirectory(fileSystem, targetPath) {
  try {
    return await fileSystem.open(targetPath, DIRECTORY_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw anchorError("IMAGE_PROJECT_SYMLINK", "project path must not contain symbolic links", error);
    }
    throw error;
  }
}

function anchorError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = code === "IMAGE_PROJECT_CHANGED"
    ? 409
    : code === "IMAGE_PROJECT_SYMLINK"
      ? 403
      : 400;
  return error;
}
