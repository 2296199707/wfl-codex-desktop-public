import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(new URL("../scripts/deploy.mjs", import.meta.url));
const packageScript = fileURLToPath(new URL("../scripts/package-local-candidate.mjs", import.meta.url));
const backupScript = fileURLToPath(new URL("../scripts/backup.mjs", import.meta.url));
const backupSource = await fs.readFile(backupScript, "utf8");
const candidateSource = await fs.readFile(packageScript, "utf8");
const archivePublisher = await fs.readFile(
  new URL("../lib/immutable-archive-publisher.mjs", import.meta.url),
  "utf8",
);

test("deployment help exits before archive or runtime preparation", async () => {
  const result = await run(deployScript, ["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Usage: node scripts\/deploy\.mjs/mu);
  assert.doesNotMatch(result.stderr, /ENOENT|checksum|archive/iu);
});

test("local candidate help does not construct a snapshot", async () => {
  const result = await run(packageScript, ["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Usage: node scripts/package-local-candidate.mjs");
  assert.doesNotMatch(result.stdout, /candidateCommit|SHA-256|\.tar\.gz/iu);
});

test("deployment and candidate package commands reject unknown arguments", async () => {
  const [deploy, candidate] = await Promise.all([
    run(deployScript, ["--surprise"]),
    run(packageScript, ["--surprise"]),
  ]);
  assert.notEqual(deploy.code, 0);
  assert.match(deploy.stderr, /Unknown deployment argument: --surprise/u);
  assert.notEqual(candidate.code, 0);
  assert.match(candidate.stderr, /Unknown candidate package argument: --surprise/u);
});

test("candidate archives use the same durable publication boundary as release backups", () => {
  assert.match(backupSource, /function publishArchive\(/u);
  assert.match(candidateSource, /function publishArchive\(/u);
  assert.match(backupSource, /publishImmutableArchive/u);
  assert.match(candidateSource, /publishImmutableArchive/u);
  assert.match(archivePublisher, /await fs\.link\(temporaryArchive, destinationArchive\)/u);
  assert.match(archivePublisher, /await fs\.link\(temporaryChecksum, destinationChecksum\)/u);
  assert.match(archivePublisher, /acquireOperationLock/u);
  assert.match(candidateSource, /CODEX_DESKTOP_BACKUP_DIR: candidateBackupDirectory/u);
  assert.match(candidateSource, /destinationBackupDirectory/u);
  assert.doesNotMatch(candidateSource, /copyFile\(sourceArchive, destinationArchive\)/u);
});

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
