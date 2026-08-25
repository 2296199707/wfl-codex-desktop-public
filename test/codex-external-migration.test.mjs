import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexExternalMigrationStore,
  normalizeExternalMigrationDetectionParams,
  publicExternalMigrationHistory,
} from "../lib/codex-external-migration.mjs";

test("external migration selections come from a private expiring detection and create a read-only snapshot", async () => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.home, ".claude", "skills", "safe-skill"), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(fixture.home, ".claude", "skills", "safe-skill", "SKILL.md"),
      "---\nname: safe-skill\ndescription: safe\n---\n",
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(fixture.project, "CLAUDE.md"), "# Safe source\n", { mode: 0o600 });
    const store = await fixture.store();
    const detection = await store.recordDetection({
      items: [
        {
          itemType: "SKILLS",
          description: `Migrate skills from ${fixture.home}/.claude/skills`,
          cwd: null,
          details: {
            plugins: [],
            skills: [{ name: "safe-skill" }],
            sessions: [],
            mcpServers: [],
            hooks: [],
            subagents: [],
            commands: [],
            memory: ["private memory content"],
          },
        },
        {
          itemType: "AGENTS_MD",
          description: `Migrate ${fixture.project}/CLAUDE.md to ${fixture.project}/AGENTS.md`,
          cwd: fixture.project,
          details: null,
        },
      ],
      requestedCwds: [fixture.project],
    });
    assert.equal(detection.items.length, 2);
    assert.equal(detection.items[0].details.skills[0].name, "safe-skill");
    assert.equal(detection.items[0].details.memoryCount, 1);
    assert.doesNotMatch(JSON.stringify(detection), /private memory content/);
    await assert.rejects(
      store.prepareImport({ detectionId: detection.id, itemIds: ["mi-000000000000000000000000"] }),
      /最近一次安全扫描/,
    );

    const prepared = await store.prepareImport({
      detectionId: detection.id,
      itemIds: detection.items.map((item) => item.id),
    });
    assert.deepEqual(prepared.nativeItems.map((item) => item.itemType), ["SKILLS", "AGENTS_MD"]);
    assert.equal(prepared.snapshot.readOnly, true);
    assert.equal(prepared.snapshot.fileCount, 2);
    assert.ok(prepared.snapshot.totalBytes > 0);
    const snapshotPath = path.join(
      fixture.stateDirectory,
      "codex-external-migration",
      "snapshots",
      prepared.snapshot.id,
    );
    assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o500);
    assert.equal((await fs.stat(path.join(snapshotPath, "manifest.json"))).mode & 0o777, 0o400);
  } finally {
    await fixture.cleanup();
  }
});

test("external migration snapshot rejects symlinks, foreign paths, and unsafe source modes", async () => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.home, ".claude"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(fixture.home, "outside.txt"), "outside", { mode: 0o600 });
    await fs.symlink(path.join(fixture.home, "outside.txt"), path.join(fixture.project, "CLAUDE.md"));
    const store = await fixture.store();
    const detection = await store.recordDetection({
      items: [{
        itemType: "AGENTS_MD",
        description: "Migrate project instructions",
        cwd: fixture.project,
        details: null,
      }],
      requestedCwds: [fixture.project],
    });
    await assert.rejects(
      store.prepareImport({ detectionId: detection.id, itemIds: [detection.items[0].id] }),
      /符号链接/,
    );
    await fs.rm(path.join(fixture.project, "CLAUDE.md"));
    await fs.writeFile(path.join(fixture.project, "CLAUDE.md"), "unsafe", { mode: 0o602 });
    await fs.chmod(path.join(fixture.project, "CLAUDE.md"), 0o602);
    await assert.rejects(
      store.prepareImport({ detectionId: detection.id, itemIds: [detection.items[0].id] }),
      /其他用户写入/,
    );
    await assert.rejects(
      store.recordDetection({
        items: [{
          itemType: "AGENTS_MD",
          description: "Foreign project",
          cwd: "/tmp/not-authorized",
          details: null,
        }],
        requestedCwds: [fixture.project],
      }),
      /扫描范围外/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("external migration operations preserve failure retry selection and reconcile native history", async () => {
  const fixture = await createFixture();
  try {
    const store = await fixture.store();
    const detection = await store.recordDetection({
      items: [{
        itemType: "SESSIONS",
        description: "Migrate recent sessions",
        cwd: null,
        details: {
          plugins: [],
          skills: [],
          sessions: [],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: [],
        },
      }],
      requestedCwds: [fixture.project],
    });
    const prepared = await store.prepareImport({
      detectionId: detection.id,
      itemIds: [detection.items[0].id],
    });
    const operation = await store.beginImport({
      importId: "12345678-1234-4234-8234-123456789abc",
      detectionId: detection.id,
      selectedItems: detection.items,
      snapshotId: prepared.snapshot.id,
    });
    assert.equal(operation.status, "running");
    await store.updateImport(operation.importId, [{
      itemType: "SESSIONS",
      successes: [],
      failures: [{
        itemType: "SESSIONS",
        errorType: "read",
        subErrorType: null,
        failureStage: "copy",
        message: "fixture failure",
        cwd: null,
        source: null,
      }],
    }], { completed: true });
    assert.deepEqual(store.retrySelection(operation.importId), {
      detectionId: detection.id,
      itemIds: [detection.items[0].id],
    });
    await store.reconcileHistories([{
      importId: operation.importId,
      completedAtMs: Date.now(),
      successes: [],
      failures: [],
    }]);
    assert.equal(store.snapshot().operations[0].status, "partial");
  } finally {
    await fixture.cleanup();
  }
});

test("external migration accepts session projects inside an explicitly scanned workspace only", async () => {
  const fixture = await createFixture();
  try {
    const sessionDirectory = path.join(fixture.home, ".claude", "projects", "fixture");
    const sessionPath = path.join(sessionDirectory, "session.jsonl");
    await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(sessionPath, "{\"type\":\"user\"}\n", { mode: 0o600 });
    const store = await fixture.store();
    const detection = await store.recordDetection({
      items: [{
        itemType: "SESSIONS",
        description: "Migrate recent sessions",
        cwd: null,
        details: {
          plugins: [],
          skills: [],
          sessions: [{ path: sessionPath, cwd: fixture.project, title: "Fixture session" }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: [],
        },
      }],
      requestedCwds: [fixture.project],
    });
    assert.deepEqual(detection.items[0].details.sessions, [{
      cwd: fixture.project,
      title: "Fixture session",
    }]);
    const filtered = await store.recordDetection({
      items: [{
        itemType: "SESSIONS",
        description: "Foreign session project",
        cwd: null,
        details: {
          plugins: [],
          skills: [],
          sessions: [{ path: sessionPath, cwd: "/tmp/not-authorized", title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: [],
        },
      }],
      requestedCwds: [fixture.project],
    });
    assert.deepEqual(filtered.items[0].details.sessions, []);
  } finally {
    await fixture.cleanup();
  }
});

test("external migration request and history sanitizers stay bounded", () => {
  assert.deepEqual(
    normalizeExternalMigrationDetectionParams({}, { currentProject: "/srv/project" }),
    {
      includeHome: true,
      cwds: ["/srv/project"],
      maxSessionAgeDays: 30,
      maxSessions: 50,
      migrationSource: "claude-code",
    },
  );
  assert.throws(
    () => normalizeExternalMigrationDetectionParams({ migrationSource: "unknown" }),
    /仅支持 Claude Code 或 Cursor/,
  );
  assert.equal(
    normalizeExternalMigrationDetectionParams({ migrationSource: "cursor" }).migrationSource,
    "cursor",
  );
  const result = publicExternalMigrationHistory({
    data: [
      {
        importId: "12345678-1234-4234-8234-123456789abc",
        providerId: "claude-code",
        completedAtMs: 1234n,
        successes: [{
          itemType: "SKILLS",
          cwd: null,
          source: "/srv/source",
          target: "/srv/target",
        }],
        failures: [],
      },
      {
        importId: "87654321-1234-4234-8234-123456789abc",
        providerId: "claude-code",
        completedAtMs: 1235n,
        successes: [{
          itemType: "SESSIONS",
          cwd: "/srv/project",
          source: "/root/.claude/projects/private-session.jsonl",
          target: "/root/.codex/sessions/private-session.jsonl",
        }],
        failures: [],
      },
    ],
    connectors: [{ name: "remote", sessionCount: 2, source: "remoteMcpServersConfig" }],
  });
  assert.equal(result.data[0].completedAtMs, 1234);
  assert.equal(result.data[0].successes[0].itemType, "SKILLS");
  assert.equal(result.data[1].successes[0].source, null);
  assert.equal(result.data[1].successes[0].target, null);
  assert.doesNotMatch(JSON.stringify(result), /private-session/);
  assert.deepEqual(result.connectors[0], {
    name: "remote",
    sessionCount: 2,
    source: "remoteMcpServersConfig",
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-external-migration-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const projectRoot = path.join(home, "projects");
  const project = path.join(projectRoot, "fixture");
  const stateDirectory = path.join(root, "state");
  await Promise.all([
    fs.mkdir(codexHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(project, { recursive: true, mode: 0o700 }),
    fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  return {
    root,
    home,
    codexHome,
    projectRoot,
    project,
    stateDirectory,
    store: () => new CodexExternalMigrationStore({
      stateDirectory,
      home,
      codexHome,
      projectRoot,
      uid,
      gid,
    }).initialize(),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
