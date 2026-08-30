import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GameProjectWorkspaceStore } from "../lib/game-project-workspace-store.mjs";

async function withStore(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-game-projects-"));
  let clock = 1_700_000_000_000;
  let sequence = 0;
  try {
    const store = await new GameProjectWorkspaceStore(directory, {
      now: () => ++clock,
      randomId: () => `game-project-${String(++sequence).padStart(8, "0")}`,
    }).initialize({ writeOnInitialize: true });
    return await callback(store, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const projectA = "/srv/games/forest";
const projectB = "/srv/games/desert";

test("registers multiple projects with stable IDs and restores them", async () => {
  await withStore(async (store, directory) => {
    const forest = await store.register({
      name: "Forest Game",
      projectPath: projectA,
      projectFile: ".tiled-project",
      initialMap: "maps/forest.tmj",
      preset: "building",
      orientation: "orthogonal",
      width: 64,
      height: 64,
      tilewidth: 32,
      tileheight: 32,
      initializeGit: true,
    });
    const desert = await store.register({ name: "Desert", projectPath: projectB });
    assert.notEqual(forest.projectId, desert.projectId);
    assert.equal(store.findByPath(projectA).projectId, forest.projectId);
    assert.deepEqual(store.get(forest.projectId), forest);

    const reopened = await new GameProjectWorkspaceStore(directory).initialize();
    assert.equal(reopened.get(forest.projectId).name, "Forest Game");
    assert.equal(reopened.get(desert.projectId).projectPath, projectB);
  });
});

test("open and snapshot update only workspace metadata", async () => {
  await withStore(async (store) => {
    const project = await store.register({ name: "Forest", projectPath: projectA });
    const opened = await store.open({
      projectId: project.projectId,
      relativePath: "maps/forest.tmj",
      editor: "map",
    });
    assert.equal(opened.recentResource, "maps/forest.tmj");
    assert.equal(opened.recentEditor, "map");
    assert.equal(opened.revision, project.revision + 1);
    const snapshot = await store.snapshot(project.projectId, { recentEditor: "world" });
    assert.equal(snapshot.recentResource, "maps/forest.tmj");
    assert.equal(snapshot.recentEditor, "world");
    assert.ok(snapshot.snapshotAt >= snapshot.createdAt);
  });
});

test("reuses a path registration and rejects unknown IDs, stale revisions, and traversal", async () => {
  await withStore(async (store) => {
    const project = await store.register({ name: "Forest", projectPath: projectA });
    const repeated = await store.register({ name: "Forest Renamed", projectPath: projectA });
    assert.equal(repeated.projectId, project.projectId);
    assert.equal(repeated.name, "Forest Renamed");
    await assert.rejects(
      store.open({ projectId: "game-project-unknown" }),
      (error) => error.statusCode === 404 && error.code === "GAME_PROJECT_NOT_FOUND",
    );
    await assert.rejects(
      store.remove(project.projectId, { expectedRevision: project.revision }),
      (error) => error.statusCode === 409 && error.code === "GAME_PROJECT_REVISION_CONFLICT",
    );
    await assert.rejects(
      store.register({ name: "Bad", projectPath: projectB, initialMap: "../escape.tmj" }),
      (error) => error.statusCode === 400 && error.code === "GAME_PROJECT_INVALID",
    );
  });
});

test("removing a record does not imply deleting the actual project directory", async () => {
  await withStore(async (store) => {
    const project = await store.register({ name: "Forest", projectPath: projectA });
    const removed = await store.remove(project.projectId);
    assert.equal(removed.projectId, project.projectId);
    assert.equal(store.list().length, 0);
  });
});
