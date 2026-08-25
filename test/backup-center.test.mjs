import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BackupCenter } from "../lib/backup-center.mjs";

test("backup center encrypts, verifies, stages, and retains private data", async () => {
  const root = await fs.mkdtemp("/tmp/wfl-backup-center-");
  const stateDirectory = path.join(root, "state");
  const dataDirectory = path.join(root, "project");
  const backupDirectory = path.join(root, "backups");
  try {
    await Promise.all([
      fs.mkdir(stateDirectory, { recursive: true }),
      fs.mkdir(dataDirectory, { recursive: true }),
    ]);
    await fs.writeFile(path.join(dataDirectory, "private.txt"), "backup-secret-value\n");
    await fs.writeFile(path.join(stateDirectory, "sessions.json"), "must-not-restore\n");
    const center = await new BackupCenter(backupDirectory, {
      stateDirectory,
      version: "0.23.0",
      now: () => Date.UTC(2026, 6, 22, 8, 0, 0),
    }).initialize();
    await center.updateSettings({ retentionCount: 1, intervalHours: 168, enabled: true });
    const created = await center.create({
      sources: [{ path: dataDirectory, kind: "project" }, { path: stateDirectory, kind: "state" }],
      summary: { users: 2, projects: 1, scopes: ["projects", "settings"] },
      hostId: "host-test",
    });
    assert.equal(created.version, "0.23.0");
    assert.ok(created.verifiedAt);
    const encrypted = await fs.readFile(center.archivePath(created.id));
    assert.equal(encrypted.includes("backup-secret-value"), false);
    assert.match(center.exportRecoveryKey(), /^WFL-RECOVERY-KEY-1:[A-Za-z0-9_-]{43}\n$/);

    const stagedPath = path.join(root, "staged");
    const staged = await center.stageForRestore(created.id, stagedPath);
    assert.equal(staged.manifest.hostId, "host-test");
    assert.equal(await fs.readFile(path.join(stagedPath, dataDirectory.slice(1), "private.txt"), "utf8"), "backup-secret-value\n");
    await assert.rejects(fs.access(path.join(stagedPath, stateDirectory.slice(1), "sessions.json")));

    await center.create({ sources: [{ path: dataDirectory, kind: "project" }] });
    assert.equal(center.snapshot().backups.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
