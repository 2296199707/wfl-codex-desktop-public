import fs from "node:fs/promises";
import path from "node:path";

export async function assertManagedRuntimeLayout(user, {
  projectRoot = user?.projectRoot,
  defaultProject = user?.defaultProject,
} = {}) {
  if (
    !user
    || !Number.isInteger(user.uid)
    || user.uid < 0
    || !Number.isInteger(user.gid)
    || user.gid < 0
  ) {
    throw new Error("Managed user identity is invalid");
  }
  const home = path.resolve(String(user.home || ""));
  const privateTemp = path.join(home, "tmp");
  const directories = [
    { path: home, privacy: "traversable" },
    { path: path.resolve(String(user.codexHome || "")), privacy: "private" },
    { path: path.resolve(String(projectRoot || "")), privacy: "traversable" },
    { path: path.resolve(String(defaultProject || "")), privacy: "shared-project" },
    { path: privateTemp, privacy: "private" },
  ];
  const [homeReal, stateDirectory] = await Promise.all([
    fs.realpath(home),
    validateControlStateDirectory(user.stateDirectory),
  ]);
  for (const entry of directories) {
    const resolved = entry.path;
    const [realPath, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
    const relative = path.relative(homeReal, realPath);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || (resolved !== home && (!relative || relative.startsWith("..") || path.isAbsolute(relative)))
    ) {
      throw new Error("Managed user runtime directory escaped its home");
    }
    if (stat.uid !== user.uid || stat.gid !== user.gid) {
      throw new Error("Managed user runtime directory owner is invalid");
    }
    if ((stat.mode & 0o7000) !== 0) {
      throw new Error("Managed user runtime directory has unsafe special mode bits");
    }
    if (entry.privacy === "private" && (stat.mode & 0o077) !== 0) {
      throw new Error("Managed user private directory permissions are too broad");
    }
    if (entry.privacy === "traversable" && (stat.mode & 0o022) !== 0) {
      throw new Error("Managed user runtime directory is writable by another account");
    }
  }
  return { homeReal, stateDirectory };
}

async function validateControlStateDirectory(value) {
  const directory = path.resolve(String(value || ""));
  const [realPath, stat] = await Promise.all([fs.realpath(directory), fs.lstat(directory)]);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || (stat.mode & 0o7000) !== 0
  ) {
    throw new Error("Managed user control state directory is unsafe");
  }
  return realPath;
}
