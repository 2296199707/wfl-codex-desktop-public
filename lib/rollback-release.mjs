import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PACKAGE_MANIFEST_NAME } from "./package-source.mjs";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_SUFFIX_PATTERN = /^[a-f0-9]{12}$/i;

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
  const versions = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("v")) continue;
    try {
      const packageJson = JSON.parse(await fs.readFile(
        path.join(releasesDirectory, entry.name, "package.json"),
        "utf8",
      ));
      if (VERSION_PATTERN.test(packageJson.version || "") && packageJson.version !== currentVersion) {
        versions.add(packageJson.version);
      }
    } catch {
      // Unreadable or malformed local content is never offered to the browser.
    }
  }
  const rows = [];
  for (const version of versions) {
    try {
      const verified = await verifyRollbackRelease(version, {
        runtimeDirectory,
        sourceDirectory,
        backupDirectory,
        stateSchema,
      });
      rows.push({ version: verified.version, stateSchema: verified.stateSchema, verified: true });
    } catch {
      // Unverified, incompatible, or ambiguous local content is never offered to the browser.
    }
  }
  return rows.sort((left, right) => compareVersions(right.version, left.version));
}

export async function verifyRollbackRelease(
  version,
  { runtimeDirectory, sourceDirectory, backupDirectory = path.join(sourceDirectory, "backups"), stateSchema = 1 },
) {
  if (!VERSION_PATTERN.test(String(version || ""))) throw new Error("Invalid rollback version");
  const releasesDirectory = path.join(path.resolve(runtimeDirectory), "releases");
  const releaseDirectories = await matchingReleaseDirectories(releasesDirectory, version);
  const verified = [];
  let firstError = null;
  for (const releaseDirectory of releaseDirectories) {
    try {
      verified.push(await verifyReleaseCandidate({
        version,
        releaseDirectory,
        backupDirectory,
        stateSchema,
      }));
    } catch (error) {
      firstError ||= error;
      // A directory is only eligible after all package and checksum checks pass.
    }
  }
  if (verified.length === 0) {
    if (releaseDirectories.length === 1 && firstError) throw firstError;
    throw new Error(`No verified rollback release is available for v${version}`);
  }
  if (verified.length > 1) throw new Error(`Rollback release v${version} has multiple verified candidates`);
  return verified[0];
}

async function verifyReleaseCandidate({ version, releaseDirectory, backupDirectory, stateSchema }) {
  const releaseName = path.basename(releaseDirectory);
  const suffix = releaseName.slice(`v${version}`.length);
  const archiveName = `wfl-codex-desktop-v${version}${suffix}.tar.gz`;
  const backupPath = path.join(path.resolve(backupDirectory), archiveName);
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
  if (suffix && (
    !suffix.startsWith("-")
    || !COMMIT_SUFFIX_PATTERN.test(suffix.slice(1))
    || manifest.sourceCommit.slice(0, 12).toLowerCase() !== suffix.slice(1).toLowerCase()
  )) {
    throw new Error("Rollback release directory identity does not match its package manifest");
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
  return {
    version,
    stateSchema: releaseStateSchema,
    verified: true,
    releaseDirectory,
    backupPath,
    sourceCommit: manifest.sourceCommit.toLowerCase(),
  };
}

async function matchingReleaseDirectories(releasesDirectory, version) {
  let entries;
  try {
    entries = await fs.readdir(releasesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const pattern = new RegExp(`^v${escapeRegExp(version)}(?:-([a-f0-9]{12}))?$`, "i");
  return entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => path.join(releasesDirectory, entry.name));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareVersions(left, right) {
  const [leftCore, leftPrerelease = ""] = left.split("-", 2);
  const [rightCore, rightPrerelease = ""] = right.split("-", 2);
  const a = leftCore.split(".").map(Number);
  const b = rightCore.split(".").map(Number);
  const coreComparison = (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  if (coreComparison) return coreComparison;
  if (!leftPrerelease && rightPrerelease) return 1;
  if (leftPrerelease && !rightPrerelease) return -1;
  if (!leftPrerelease && !rightPrerelease) return 0;
  const leftParts = leftPrerelease.split(".");
  const rightParts = rightPrerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (index >= leftParts.length) return -1;
    if (index >= rightParts.length) return 1;
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
