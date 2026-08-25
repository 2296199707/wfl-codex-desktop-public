import fs from "node:fs/promises";
import path from "node:path";

const PACKAGE_FILES = Object.freeze([
  "README.zh-CN.md",
  "npm-shrinkwrap.json",
  "package.json",
  "scripts/install.ps1",
  "src/agent.mjs",
  "src/codex-host.mjs",
  "src/codex-rpc-client.mjs",
  "src/config.mjs",
  "src/creator-host.mjs",
  "src/main.mjs",
  "src/windows-host-policy.mjs",
  "start.cmd",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

export async function buildWindowsCompanionPackage(sourceDirectory) {
  const root = await fs.realpath(sourceDirectory);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const version = normalizeVersion(packageJson.version);
  const prefix = `wfl-windows-host-${version}/`;
  const entries = [];
  let totalBytes = 0;
  for (const relativePath of PACKAGE_FILES) {
    const target = path.join(root, ...relativePath.split("/"));
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      throw new Error(`Windows companion package entry is invalid: ${relativePath}`);
    }
    const realTarget = await fs.realpath(target);
    if (!pathIsWithin(root, realTarget)) throw new Error(`Windows companion package entry escaped its root: ${relativePath}`);
    const data = await fs.readFile(realTarget);
    totalBytes += data.length;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("Windows companion package is too large");
    entries.push({ name: `${prefix}${relativePath}`, data });
  }
  const buffer = zipStored(entries);
  return {
    version,
    filename: `wfl-windows-host-v${version}.zip`,
    contentType: "application/zip",
    buffer,
    files: [...PACKAGE_FILES],
  };
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o100600 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
}));

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeVersion(value) {
  const version = String(value || "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid Windows companion version");
  return version;
}
