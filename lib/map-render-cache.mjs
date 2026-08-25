import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_KINDS = new Set(["tile", "image"]);
const TILE_EXTENSIONS = new Set([".csv", ".json", ".tmj", ".tmx", ".tsj", ".tsx", ".world"]);
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export class MapRenderAssetCache {
  constructor(directory, {
    tileBytes = 0,
    imageBytes = 0,
    idleMs = 60_000,
    now = () => Date.now(),
  } = {}) {
    this.root = boundedCacheRoot(directory);
    this.limits = {
      tile: cacheLimit(tileBytes),
      image: cacheLimit(imageBytes),
    };
    this.idleMs = boundedInteger(idleMs, 60_000, 1_000, 3_600_000);
    this.now = now;
  }

  async read(filename, kind) {
    const resolved = await this.resolve(filename, kind);
    try {
      return await fs.readFile(resolved.path);
    } catch (error) {
      if (resolved.path === filename || error.code !== "ENOENT") throw error;
      return fs.readFile(filename);
    }
  }

  async resolve(filename, kind) {
    if (!CACHE_KINDS.has(kind)) return sourceEntry(filename);
    const limit = this.limits[kind];
    const source = await sourceEntry(filename);
    if (limit === 0 || source.size > limit) return source;

    const bucket = path.join(this.root, kind);
    try {
      await fs.mkdir(bucket, { recursive: true, mode: 0o700 });
    } catch {
      return source;
    }
    const signature = fileSignature(filename, source.stat);
    const cachePath = path.join(bucket, `${crypto.createHash("sha256").update(signature).digest("hex")}.bin`);
    if (await validCacheFile(cachePath, source.size)) {
      const now = new Date(this.now());
      await fs.utimes(cachePath, now, now).catch(() => {});
      return { path: cachePath, size: source.size, cached: true };
    }

    const release = await acquireCacheLock(this.root, kind);
    if (!release) return source;
    try {
      const current = await sourceEntry(filename);
      const currentSignature = fileSignature(filename, current.stat);
      const currentPath = path.join(bucket, `${crypto.createHash("sha256").update(currentSignature).digest("hex")}.bin`);
      if (await validCacheFile(currentPath, current.size)) {
        const now = new Date(this.now());
        await fs.utimes(currentPath, now, now).catch(() => {});
        return { path: currentPath, size: current.size, cached: true };
      }
      if (current.size > limit) return current;
      const stored = await copyCacheFile(filename, currentPath, currentSignature, current.size);
      if (!stored) return sourceEntry(filename);
      await this.trimUnlocked(kind, currentPath).catch(() => {});
      return { path: currentPath, size: current.size, cached: true };
    } catch {
      return sourceEntry(filename);
    } finally {
      await release();
    }
  }

  async trim(kind, retainedPath = null) {
    if (!CACHE_KINDS.has(kind)) return;
    const release = await acquireCacheLock(this.root, kind);
    if (!release) return;
    try {
      await this.trimUnlocked(kind, retainedPath);
    } finally {
      await release();
    }
  }

  async trimUnlocked(kind, retainedPath = null) {
    const bucket = path.join(this.root, kind);
    const entries = await listCacheFiles(bucket);
    const staleBefore = this.now() - this.idleMs;
    let total = 0;
    const retained = [];
    for (const entry of entries) {
      if (entry.mtimeMs < staleBefore && entry.path !== retainedPath) {
        await fs.rm(entry.path, { force: true }).catch(() => {});
        continue;
      }
      total += entry.size;
      retained.push(entry);
    }
    const limit = this.limits[kind];
    for (const entry of retained.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= limit) break;
      if (entry.path === retainedPath) continue;
      await fs.rm(entry.path, { force: true }).catch(() => {});
      total -= entry.size;
    }
  }
}

export async function clearMapRenderAssetCache(directory) {
  const root = boundedCacheRoot(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const releases = [];
  try {
    for (const kind of CACHE_KINDS) {
      const release = await acquireCacheLock(root, kind, 10_000);
      if (!release) {
        throw Object.assign(new Error(`Timed out waiting for the ${kind} render cache lock`), {
          code: "render-cache-busy",
        });
      }
      releases.push(release);
    }
    const entries = (await Promise.all([...CACHE_KINDS].map((kind) => (
      listCacheFiles(path.join(root, kind))
    )))).flat();
    for (const kind of CACHE_KINDS) {
      await fs.rm(path.join(root, kind), { recursive: true, force: true });
    }
    return {
      files: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.size, 0),
    };
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

export function mapRenderCacheKind(filename) {
  const extension = path.extname(String(filename || "")).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TILE_EXTENSIONS.has(extension)) return "tile";
  return null;
}

async function copyCacheFile(source, filename, signature, expectedSize) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    const [sourceStat, temporaryStat] = await Promise.all([
      fs.stat(source, { bigint: true }),
      fs.stat(temporary, { bigint: true }),
    ]);
    if (
      fileSignature(source, sourceStat) !== signature
      || Number(temporaryStat.size) !== expectedSize
      || !temporaryStat.isFile()
    ) return false;
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
    return true;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function sourceEntry(filename) {
  const stat = await fs.stat(filename, { bigint: true });
  const size = Number(stat.size);
  if (!stat.isFile() || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("render cache source is not a regular file");
  }
  return { path: filename, size, stat, cached: false };
}

async function validCacheFile(filename, expectedSize) {
  try {
    const stat = await fs.lstat(filename);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedSize;
  } catch {
    return false;
  }
}

async function acquireCacheLock(root, kind, waitMs = 1_000) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, `.${kind}.lock`);
  const token = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const ownerPath = path.join(lockPath, "owner");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(ownerPath, `${token}\n`, { flag: "wx", mode: 0o600 });
      return async () => {
        try {
          if ((await fs.readFile(ownerPath, "utf8")).trim() !== token) return;
        } catch {
          return;
        }
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") return null;
      await removeDeadLock(lockPath, ownerPath);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return null;
}

async function removeDeadLock(lockPath, ownerPath) {
  const recoveryPath = `${lockPath}.recovery`;
  try {
    await fs.mkdir(recoveryPath, { mode: 0o700 });
  } catch {
    return;
  }
  try {
    let owner;
    try {
      owner = (await fs.readFile(ownerPath, "utf8")).trim();
    } catch {
      return;
    }
    const pid = Number(owner.split("-", 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(recoveryPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function listCacheFiles(directory) {
  let names;
  try {
    names = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of names) {
    const filename = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      await fs.rm(filename, { recursive: entry.isDirectory(), force: true }).catch(() => {});
      continue;
    }
    const stat = await fs.stat(filename);
    files.push({ path: filename, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

function fileSignature(filename, stat) {
  return [
    path.resolve(filename),
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs ?? BigInt(Math.round(Number(stat.mtimeMs) * 1_000_000)),
    stat.ctimeNs ?? BigInt(Math.round(Number(stat.ctimeMs) * 1_000_000)),
  ].join("\u0000");
}

function cacheLimit(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 1024 * 1024 * 1024 * 1024) {
    throw new TypeError("Invalid map render cache limit");
  }
  return number;
}

function boundedCacheRoot(directory) {
  const root = path.resolve(String(directory || ""));
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw new TypeError("A bounded map render cache directory is required");
  }
  return root;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}
