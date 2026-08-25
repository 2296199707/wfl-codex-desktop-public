import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listVerifiedRollbackReleases, verifyRollbackRelease } from "../lib/rollback-release.mjs";

test("rollback releases require an exact local directory, manifest, and package checksum", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rollback-release-");
  const runtimeDirectory = path.join(directory, "runtime");
  const sourceDirectory = path.join(directory, "source");
  try {
    await createRelease("0.20.0", { runtimeDirectory, sourceDirectory, stateSchema: 1 });
    const rows = await listVerifiedRollbackReleases({ runtimeDirectory, sourceDirectory, currentVersion: "0.21.0", stateSchema: 1 });
    assert.deepEqual(rows, [{ version: "0.20.0", stateSchema: 1, verified: true }]);
    await assert.rejects(
      verifyRollbackRelease("../../tmp", { runtimeDirectory, sourceDirectory }),
      /Invalid rollback version/,
    );

    await fs.writeFile(path.join(sourceDirectory, "backups", "wfl-codex-desktop-v0.20.0.tar.gz"), "tampered");
    await assert.rejects(
      verifyRollbackRelease("0.20.0", { runtimeDirectory, sourceDirectory }),
      /checksum mismatch/,
    );
    assert.deepEqual(await listVerifiedRollbackReleases({ runtimeDirectory, sourceDirectory, currentVersion: "0.21.0" }), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rollback release rejects a newer persistent state schema", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-rollback-schema-");
  const runtimeDirectory = path.join(directory, "runtime");
  const sourceDirectory = path.join(directory, "source");
  try {
    await createRelease("0.20.0", { runtimeDirectory, sourceDirectory, stateSchema: 2, minimumStateSchema: 2 });
    await assert.rejects(
      verifyRollbackRelease("0.20.0", { runtimeDirectory, sourceDirectory, stateSchema: 1 }),
      /not compatible/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createRelease(version, { runtimeDirectory, sourceDirectory, stateSchema, minimumStateSchema = 1 }) {
  const release = path.join(runtimeDirectory, "releases", `v${version}`);
  const backupDirectory = path.join(sourceDirectory, "backups");
  await Promise.all([
    fs.mkdir(path.join(release, "public"), { recursive: true }),
    fs.mkdir(backupDirectory, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(release, "package.json"), JSON.stringify({ name: "wfl", version })),
    fs.writeFile(path.join(release, ".codex-package.json"), JSON.stringify({
      format: 2, name: "wfl", version, sourceCommit: "a".repeat(40), stateSchema, minimumStateSchema,
    })),
    fs.writeFile(path.join(release, "server.mjs"), ""),
    fs.writeFile(path.join(release, "public", "ops.html"), ""),
  ]);
  const archive = path.join(backupDirectory, `wfl-codex-desktop-v${version}.tar.gz`);
  await fs.writeFile(archive, "verified-package");
  const digest = crypto.createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
}
