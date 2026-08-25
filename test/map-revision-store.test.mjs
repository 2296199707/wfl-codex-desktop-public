import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapRevisionStore } from "../lib/map-revision-store.mjs";

test("map revision store snapshots immutable bytes and materializes a scoped restore candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-revisions-"));
  const project = path.join(root, "game");
  const state = path.join(root, "state");
  const map = path.join(project, "maps", "world.tmj");
  try {
    await fs.mkdir(path.dirname(map), { recursive: true });
    const first = Buffer.from('{"type":"map","layers":[]}\n');
    await fs.writeFile(map, first);
    const store = await new MapRevisionStore(state, { maxBytes: 1024 * 1024 }).initialize();
    const version = crypto.createHash("sha256").update(first).digest("hex");
    const staged = await store.stageCurrent({ projectPath: project, relativePath: "maps/world.tmj", targetPath: map, expectedVersion: version, reason: "ai-commit" });
    const revision = await store.commitStaged(staged);
    assert.equal(revision.relativePath, "maps/world.tmj");
    assert.equal(revision.version, version);
    assert.equal(Object.hasOwn(revision, "blobPath"), false);
    await fs.writeFile(map, '{"type":"map","layers":[{"id":1}]}\n');
    const listed = store.list({ projectPath: project, relativePath: "maps/world.tmj" });
    assert.equal(listed.length, 1);
    const materialized = await store.materialize({ revisionId: revision.id, projectPath: project, relativePath: "maps/world.tmj" });
    assert.deepEqual(await fs.readFile(materialized.candidatePath), first);
    await fs.rm(materialized.candidatePath, { force: true });
    assert.throws(() => store.get({ revisionId: revision.id, projectPath: project, relativePath: "maps/other.tmj" }), /地图修订不存在/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("map revision store refuses a changed source and enforces fixed retention", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-revisions-limit-"));
  const project = path.join(root, "game");
  const state = path.join(root, "state");
  const map = path.join(project, "world.tmj");
  try {
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(map, "one\n");
    const store = await new MapRevisionStore(state, { maxRevisions: 1, maxBytes: 1024 }).initialize();
    await assert.rejects(
      store.stageCurrent({ projectPath: project, relativePath: "world.tmj", targetPath: map, expectedVersion: "0".repeat(64) }),
      /基础版本/u,
    );
    const stagedOne = await store.stageCurrent({ projectPath: project, relativePath: "world.tmj", targetPath: map });
    await store.commitStaged(stagedOne);
    const stagedTwo = await store.stageCurrent({ projectPath: project, relativePath: "world.tmj", targetPath: map });
    await store.commitStaged(stagedTwo);
    assert.equal(store.snapshot().count, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("map revision store rejects staged paths and persisted blobs outside controlled roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-revisions-scope-"));
  const project = path.join(root, "game");
  const state = path.join(root, "state");
  const map = path.join(project, "world.tmj");
  try {
    await fs.mkdir(project, { recursive: true });
    const bytes = Buffer.from("one\n");
    await fs.writeFile(map, bytes);
    const store = await new MapRevisionStore(state).initialize();
    const version = crypto.createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(
      store.commitStaged({ stagedPath: path.join(root, "outside.bin"), projectKey: "a".repeat(64), projectPath: project, relativePath: "world.tmj", version, size: bytes.length }),
      /暂存路径不属于受控临时目录/u,
    );
    const staged = await store.stageCurrent({ projectPath: project, relativePath: "world.tmj", targetPath: map, expectedVersion: version });
    await fs.rm(staged.stagedPath);
    await assert.rejects(store.commitStaged(staged), /暂存内容已不可用/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
