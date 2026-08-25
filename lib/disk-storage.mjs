import fs from "node:fs/promises";
import path from "node:path";

const MIN_DATA_DISK_BYTES = 1024 ** 3;
const PSEUDO_FILESYSTEMS = new Set([
  "autofs",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "fusectl",
  "mqueue",
  "pstore",
  "proc",
  "securityfs",
  "sysfs",
  "tracefs",
]);

export async function inspectMountedDisks({ primaryPath = "/", mountInfoPath = "/proc/self/mountinfo" } = {}) {
  const mounts = parseMountInfo(await fs.readFile(mountInfoPath, "utf8"));
  const candidates = mounts
    .filter((mount) => mount.mountPoint === "/" || isPersistentMount(mount))
    .sort((left, right) => left.mountPoint.length - right.mountPoint.length);
  const selected = [];
  const seenSources = new Set();
  for (const mount of candidates) {
    const key = mount.source || `${mount.filesystem}:${mount.mountPoint}`;
    if (seenSources.has(key)) continue;
    const usage = await statfsUsage(mount.mountPoint).catch(() => null);
    if (!usage || (mount.mountPoint !== "/" && usage.totalBytes < MIN_DATA_DISK_BYTES)) continue;
    seenSources.add(key);
    selected.push({
      ...mount,
      ...usage,
      kind: mount.mountPoint === "/" ? "system" : "data",
    });
  }
  const primaryMount = findMountForPath(selected, primaryPath) || selected[0] || null;
  return {
    primary: primaryMount,
    disks: selected.map((disk, index) => ({
      id: diskId(disk),
      label: disk.kind === "system" ? "系统盘" : `数据盘${indexOfDataDisk(selected, disk) || ""}`.trim(),
      kind: disk.kind,
      mountPoint: disk.mountPoint,
      source: disk.source || null,
      filesystem: disk.filesystem,
      usedBytes: disk.usedBytes,
      totalBytes: disk.totalBytes,
      availableBytes: disk.availableBytes,
      percent: disk.percent,
      primary: disk === primaryMount,
    })),
  };
}

export function parseMountInfo(text) {
  const mounts = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (fields.length < 7 || separator < 0 || separator + 2 >= fields.length) continue;
    const mountPoint = decodeMountField(fields[4]);
    const filesystem = fields[separator + 1];
    const source = decodeMountField(fields[separator + 2]);
    if (!mountPoint || !path.isAbsolute(mountPoint) || !filesystem) continue;
    mounts.push({ mountPoint, filesystem, source });
  }
  return mounts;
}

export function findMountForPath(mounts, targetPath) {
  const target = path.resolve(String(targetPath || "/"));
  return [...(mounts || [])]
    .filter((mount) => pathContains(mount.mountPoint, target))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0] || null;
}

function isPersistentMount(mount) {
  return !PSEUDO_FILESYSTEMS.has(mount.filesystem)
    && (mount.source.startsWith("/dev/") || mount.filesystem === "overlay" || mount.filesystem === "fuseblk");
}

async function statfsUsage(mountPoint) {
  const stat = await fs.statfs(mountPoint);
  const blockSize = Number(stat.bsize);
  const totalBytes = Number(stat.blocks) * blockSize;
  const availableBytes = Number(stat.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - Number(stat.bfree) * blockSize);
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    percent: totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0,
  };
}

function pathContains(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeMountField(value) {
  return String(value || "").replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function indexOfDataDisk(disks, current) {
  const index = disks.filter((disk) => disk.kind === "data").indexOf(current) + 1;
  return index > 0 ? index : null;
}

function diskId(disk) {
  return `${disk.source || disk.filesystem}:${disk.mountPoint}`;
}
