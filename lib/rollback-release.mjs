import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PACKAGE_MANIFEST_NAME } from "./package-source.mjs";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function listVerifiedRollbackReleases({
  runtimeDirectory,
  sourceDirectory,
  backupDirectory = path.join(sourceDirectory, "backups"),
  currentVersion,
  stateSchema = 1,
}) {
  const releasesDirectory = path.join(path.resolve(runtimeDirectory), "releases");
  let entries = [];
  try {
    entries = await fs.readdir(releasesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const rows = [];
  for (const entry of entries) {
    const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(entry.name);
    if (!entry.isDirectory() || !match || match[1] === currentVersion) continue;
    try {
      rows.push(await verifyRollbackRelease(match[1], {
        runtimeDirectory,
        sourceDirectory,
        backupDirectory,
        stateSchema,
      }));
    } catch {
      // Unverified or incompatible local content is never offered to the browser.
    }
  }
  return rows.sort((left, right) => compareVersions(right.version, left.version));
}

export async function verifyRollbackRelease(
  version,
  { runtimeDirectory, sourceDirectory, backupDirectory = path.join(sourceDirectory, "backups"), stateSchema = 1 },
) {
  if (!VERSION_PATTERN.test(String(version || ""))) throw new Error("Invalid rollback version");
  const releaseDirectory = path.join(path.resolve(runtimeDirectory), "releases", `v${version}`);
  const backupPath = path.join(path.resolve(backupDirectory), `wfl-codex-desktop-v${version}.tar.gz`);
  const checksumPath = `${backupPath}.sha256`;
  const [packageText, manifestText, checksumText] = await Promise.all([
    fs.readFile(path.join(releaseDirectory, "package.json"), "utf8"),
    fs.readFile(path.join(releaseDirectory, PACKAGE_MANIFEST_NAME), "utf8"),
    fs.readFile(checksumPath, "utf8"),
    fs.access(path.join(releaseDirectory, "server.mjs")),
    fs.access(path.join(releaseDirectory, "public", "ops.html")),
  ]);
  const packageJson = JSON.parse(packageText);
  const manifest = JSON.parse(manifestText);
  if (
    packageJson.version !== version
    || manifest.version !== version
    || manifest.name !== packageJson.name
    || ![1, 2].includes(manifest.format)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(manifest.sourceCommit || "")
  ) {
    throw new Error("Rollback release metadata does not match");
  }
  const releaseStateSchema = manifest.stateSchema ?? 1;
  const minimumStateSchema = manifest.minimumStateSchema ?? 1;
  if (!Number.isInteger(releaseStateSchema) || !Number.isInteger(minimumStateSchema) || stateSchema < minimumStateSchema || stateSchema > releaseStateSchema) {
    throw new Error("Rollback release is not compatible with the current state schema");
  }
  const expected = checksumText.trim().split(/\s+/, 1)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("Rollback checksum is invalid");
  const digest = crypto.createHash("sha256").update(await fs.readFile(backupPath)).digest("hex");
  if (digest.toLowerCase() !== expected.toLowerCase()) throw new Error("Rollback package checksum mismatch");
  return { version, stateSchema: releaseStateSchema, verified: true };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}
