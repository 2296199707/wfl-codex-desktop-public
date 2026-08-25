import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  validateMigratedProjectTree,
  WorkspaceMigrationCenter,
} from "../lib/workspace-migration.mjs";

test("workspace migration packages projects and conversations without credentials or unsafe links", async () => {
  const root = await fs.mkdtemp("/tmp/wfl-workspace-migration-");
  const sourceDirectory = path.join(root, "source-center");
  const targetDirectory = path.join(root, "target-center");
  const project = path.join(root, "sample-project");
  try {
    await Promise.all([
      fs.mkdir(path.join(project, ".git"), { recursive: true }),
      fs.mkdir(path.join(project, "node_modules", "dependency"), { recursive: true }),
      fs.mkdir(path.join(project, "src"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(project, "src", "index.js"), "export const ready = true;\n"),
      fs.writeFile(path.join(project, ".git", "config"), "[core]\n"),
      fs.writeFile(path.join(project, ".env"), "SECRET=not-exported\n"),
      fs.writeFile(path.join(project, "node_modules", "dependency", "index.js"), "large dependency\n"),
      fs.symlink("/etc/passwd", path.join(project, "outside-link")),
    ]);
    await Promise.all([
      fs.chmod(project, 0o750),
      fs.chmod(path.join(project, "src", "index.js"), 0o755),
    ]);
    const source = await new WorkspaceMigrationCenter(sourceDirectory, { version: "0.36.0" }).initialize();
    const migration = await source.createExport({
      projects: [{ name: "sample-project", path: project }],
      conversations: [{
        projectId: "project-0001",
        archived: false,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
        transcript: {
          name: "Migration chat",
          turns: [{ items: [{ type: "user", text: "Move this chat" }, { type: "assistant", text: "Ready" }] }],
        },
      }],
      includeGit: true,
      includeEnv: false,
      sourceInstanceId: "source-instance",
    });
    assert.equal(migration.projects, 1);
    assert.equal(migration.conversations, 1);
    assert.match(migration.sha256, /^[a-f0-9]{64}$/);

    const packageBytes = await fs.readFile(source.exportPath(migration.id));
    assert.equal(packageBytes.includes(Buffer.from("SECRET=not-exported")), false);
    const key = await source.exportKey(migration.id);
    assert.match(key, new RegExp(`migration=${migration.id}`));

    const target = await new WorkspaceMigrationCenter(targetDirectory, { version: "0.36.0" }).initialize();
    const clientUploadId = "11111111-2222-4333-8444-555555555555";
    const fileFingerprint = "a".repeat(64);
    const upload = await target.beginUpload({
      filename: `${migration.id}.wflworkspace`,
      sizeBytes: packageBytes.length,
      clientUploadId,
      fileFingerprint,
    });
    const idempotentUpload = await target.beginUpload({
      filename: `${migration.id}.wflworkspace`,
      sizeBytes: packageBytes.length,
      clientUploadId,
      fileFingerprint,
    });
    assert.equal(idempotentUpload.id, upload.id);
    await assert.rejects(target.beginUpload({
      filename: `${migration.id}.wflworkspace`,
      sizeBytes: packageBytes.length,
      clientUploadId,
      fileFingerprint: "b".repeat(64),
    }), /另一个迁移包/);
    const split = Math.floor(packageBytes.length / 2);
    await assert.rejects(
      target.appendUpload(upload.id, [packageBytes.subarray(0, split)], { offset: 1, length: split }),
      /位置不连续/,
    );
    async function* interruptedChunk() {
      yield packageBytes.subarray(0, Math.max(1, Math.floor(split / 2)));
      throw new Error("simulated connection loss");
    }
    await assert.rejects(
      target.appendUpload(upload.id, interruptedChunk(), { offset: 0, length: split }),
      /simulated connection loss/,
    );
    assert.equal(target.requireUpload(upload.id).receivedBytes, 0);
    await target.appendUpload(upload.id, [packageBytes.subarray(0, split)], { offset: 0, length: split });
    await target.appendUpload(upload.id, [packageBytes.subarray(split)], {
      offset: split,
      length: packageBytes.length - split,
    });

    const inspection = await target.inspectUpload(upload.id, key);
    assert.equal(inspection.projects[0].name, "sample-project");
    assert.deepEqual(inspection.sourceUser, {
      uid: process.getuid(),
      gid: process.getgid(),
    });
    assert.equal(inspection.projects[0].sourceMode, 0o750);
    assert.equal(inspection.projects[0].excluded.env > 0, true);
    assert.equal(inspection.projects[0].excluded.dependencies > 0, true);
    assert.equal(inspection.projects[0].excluded.links > 0, true);
    assert.equal(inspection.conversations, 1);
    const staged = await target.stageUpload(upload.id, key);
    try {
      const stagedProject = path.join(staged.root, "projects", staged.manifest.projects[0].storageName);
      assert.equal(await fs.readFile(path.join(stagedProject, "src", "index.js"), "utf8"), "export const ready = true;\n");
      assert.equal((await fs.stat(stagedProject)).mode & 0o777, 0o750);
      assert.equal((await fs.stat(path.join(stagedProject, "src", "index.js"))).mode & 0o777, 0o755);
      assert.equal((await fs.stat(path.join(stagedProject, "src", "index.js"))).uid, process.getuid());
      assert.equal((await fs.stat(path.join(stagedProject, "src", "index.js"))).gid, process.getgid());
      assert.equal(await validateMigratedProjectTree(stagedProject, {
        uid: process.getuid(),
        gid: process.getgid(),
        rootMode: 0o750,
      }), true);
      await assert.rejects(validateMigratedProjectTree(stagedProject, {
        uid: process.getuid() + 1,
        gid: process.getgid(),
        rootMode: 0o750,
      }), /属主.*UID\/GID/);
      assert.equal(await fs.readFile(path.join(stagedProject, ".git", "config"), "utf8"), "[core]\n");
      await assert.rejects(fs.access(path.join(stagedProject, ".env")), /ENOENT/);
      await assert.rejects(fs.access(path.join(stagedProject, "node_modules")), /ENOENT/);
      await assert.rejects(fs.access(path.join(stagedProject, "outside-link")), /ENOENT/);
    } finally {
      await staged.cleanup();
    }

    const originalPersist = target.persist.bind(target);
    target.persist = async () => { throw new Error("simulated index failure"); };
    await assert.rejects(
      target.completeImport(upload.id, { id: migration.id }, { projects: 1, conversations: 1 }),
      /simulated index failure/,
    );
    target.persist = originalPersist;
    assert.equal(target.requireUpload(upload.id).status, "complete");
    assert.equal(target.snapshot().lastImport, null);

    const busyUpload = await target.beginUpload({ filename: "busy.wflworkspace", sizeBytes: 1 });
    let releaseWrite;
    const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
    const pendingWrite = target.appendUpload(busyUpload.id, {
      async *[Symbol.asyncIterator]() {
        await writeGate;
        yield Buffer.from("x");
      },
    }, { offset: 0, length: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(target.deleteUpload(busyUpload.id), /正在写入/);
    releaseWrite();
    await pendingWrite;

    const corrupted = Buffer.from(packageBytes);
    corrupted[corrupted.length - 1] ^= 0xff;
    const badUpload = await target.beginUpload({ filename: "corrupted.wflworkspace", sizeBytes: corrupted.length });
    await target.appendUpload(badUpload.id, [corrupted], { offset: 0, length: corrupted.length });
    await assert.rejects(target.inspectUpload(badUpload.id, key), /SHA-256/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace exports reject privileged file modes before packaging", async () => {
  const root = await fs.mkdtemp("/tmp/wfl-workspace-mode-");
  try {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const executable = path.join(project, "unsafe.sh");
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
    await fs.chmod(executable, 0o4755);
    const center = await new WorkspaceMigrationCenter(path.join(root, "center"), { version: "0.37.7" }).initialize();
    await assert.rejects(
      center.createExport({ projects: [{ name: "project", path: project }], conversations: [] }),
      /特权模式/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("application workspaces exclude deployment artifacts but retain user-created assets", async () => {
  const root = await fs.mkdtemp("/tmp/wfl-application-workspace-");
  try {
    const project = path.join(root, "application");
    const stagingDirectory = path.join(root, "external-staging");
    await Promise.all([
      fs.mkdir(path.join(project, "backups"), { recursive: true }),
      fs.mkdir(path.join(project, "coverage"), { recursive: true }),
      fs.mkdir(path.join(project, "test-results"), { recursive: true }),
      fs.mkdir(path.join(project, ".codex-runtime"), { recursive: true }),
      fs.mkdir(path.join(project, ".codex-uploads"), { recursive: true }),
      fs.mkdir(path.join(project, "generated-images"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(project, "README.md"), "application workspace\n"),
      fs.writeFile(path.join(project, "backups", "release.tar.gz"), "release artifact\n"),
      fs.writeFile(path.join(project, "coverage", "coverage.json"), "{}\n"),
      fs.writeFile(path.join(project, "test-results", "report.txt"), "test artifact\n"),
      fs.writeFile(path.join(project, ".codex-runtime", "status.json"), "{}\n"),
      fs.writeFile(path.join(project, ".codex-package.json"), "{}\n"),
      fs.writeFile(path.join(project, ".codex-uploads", "attachment.txt"), "attachment\n"),
      fs.writeFile(path.join(project, "generated-images", "image.png"), "image\n"),
    ]);
    const source = await new WorkspaceMigrationCenter(
      path.join(project, ".codex-runtime", "workspace-migrations"),
      { version: "0.36.2", stagingDirectory },
    ).initialize();
    const migration = await source.createExport({
      projects: [{
        name: "Codex-Desktop-workspace",
        path: project,
        applicationWorkspace: true,
      }],
      conversations: [],
    });
    const packageBytes = await fs.readFile(source.exportPath(migration.id));
    assert.deepEqual(await fs.readdir(stagingDirectory), []);
    const key = await source.exportKey(migration.id);
    const target = await new WorkspaceMigrationCenter(path.join(root, "target"), { version: "0.36.2" }).initialize();
    const upload = await target.beginUpload({ filename: "application.wflworkspace", sizeBytes: packageBytes.length });
    await target.appendUpload(upload.id, [packageBytes], { offset: 0, length: packageBytes.length });
    const inspection = await target.inspectUpload(upload.id, key);
    assert.equal(inspection.projects[0].excluded.applicationArtifacts > 0, true);
    assert.equal(inspection.projects[0].excluded.runtime > 0, true);

    const staged = await target.stageUpload(upload.id, key);
    try {
      const stagedProject = path.join(staged.root, "projects", staged.manifest.projects[0].storageName);
      assert.equal(await fs.readFile(path.join(stagedProject, "README.md"), "utf8"), "application workspace\n");
      assert.equal(await fs.readFile(path.join(stagedProject, ".codex-uploads", "attachment.txt"), "utf8"), "attachment\n");
      assert.equal(await fs.readFile(path.join(stagedProject, "generated-images", "image.png"), "utf8"), "image\n");
      for (const excluded of ["backups", "coverage", "test-results", ".codex-runtime", ".codex-package.json"]) {
        await assert.rejects(fs.access(path.join(stagedProject, excluded)), /ENOENT/);
      }
    } finally {
      await staged.cleanup();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace recovery keys are bound to a specific migration package", async () => {
  const root = await fs.mkdtemp("/tmp/wfl-workspace-key-");
  try {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "README.md"), "project\n");
    const source = await new WorkspaceMigrationCenter(path.join(root, "source"), { version: "0.36.0" }).initialize();
    const target = await new WorkspaceMigrationCenter(path.join(root, "target"), { version: "0.36.0" }).initialize();
    const first = await source.createExport({ projects: [{ name: "project", path: project }], conversations: [] });
    const second = await source.createExport({ projects: [{ name: "project", path: project }], conversations: [] });
    const bytes = await fs.readFile(source.exportPath(first.id));
    const upload = await target.beginUpload({ filename: "first.wflworkspace", sizeBytes: bytes.length });
    await target.appendUpload(upload.id, [bytes], { offset: 0, length: bytes.length });
    await assert.rejects(target.inspectUpload(upload.id, await source.exportKey(second.id)), /SHA-256/);
    const inspected = await target.inspectUpload(upload.id, await source.exportKey(first.id));
    assert.equal(inspected.migrationId, first.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
