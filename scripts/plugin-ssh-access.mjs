import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { temporarySshCommandArguments } from "../lib/temporary-ssh-command.mjs";
import {
  isExpectedTemporarySshControlPath,
  temporarySshControlDirectory,
} from "../lib/temporary-ssh-paths.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDir = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"),
);
const directory = path.join(runtimeDir, "plugin-data", "secure-ssh-access");
const controlDirectory = temporarySshControlDirectory(runtimeDir);
const command = process.argv[2] || "list";
const id = process.argv[3] || "";
const records = await readRecords();

if (command === "list") {
  writeJson({ records: records.map(publicRecord) });
} else if (command === "command") {
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new Error("Temporary SSH access not found or expired");
  writeJson({
    ...publicRecord(record),
    ssh: {
      command: "ssh",
      args: temporarySshCommandArguments(record),
    },
  });
} else {
  throw new Error("Usage: node scripts/plugin-ssh-access.mjs [list|command ID]");
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readRecords() {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"));
      const record = normalizeRecord(value, entry.name);
      const accessPath = record.authMode === "password-control" ? record.controlPath : record.privateKeyPath;
      if (record.expiresAt > Date.now() && await exists(accessPath)) records.push(record);
    } catch {
      // The server owns validation and cleanup; the CLI ignores incomplete records.
    }
  }
  return records.sort((left, right) => right.createdAt - left.createdAt);
}

function normalizeRecord(value, filename) {
  const id = String(value?.id || "");
  const authMode = value.authMode === "password-control" ? "password-control" : "public-key";
  const basePath = path.join(directory, id);
  if (!/^ssh-[a-f0-9]{16}$/.test(id) || filename !== `${id}.json`) throw new Error("Invalid access record ID");
  if (
    value.knownHostsPath !== `${basePath}.known_hosts`
    || (authMode === "public-key" && (
      value.privateKeyPath !== basePath
      || value.publicKeyPath !== `${basePath}.pub`
    ))
    || (authMode === "password-control" && !isExpectedTemporarySshControlPath({
      candidate: value.controlPath,
      controlDirectory,
      dataDirectory: directory,
      id,
    }))
  ) {
    throw new Error("Invalid access record path");
  }
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= value.createdAt) {
    throw new Error("Invalid access record expiry");
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(String(value.username || ""))) throw new Error("Invalid access username");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("Invalid access port");
  return { ...value, authMode };
}

function publicRecord(record) {
  return {
    id: record.id,
    target: `${record.username}@${record.host}:${record.port}`,
    authMode: record.authMode,
    hostKeyFingerprint: record.hostKeyFingerprint,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
