import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGameProjectWorkspace,
  gameProjectDirectoryName,
} from "../lib/game-project-workspace-create.mjs";

test("creates a complete editable game workspace skeleton", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-game-workspace-create-"));
  const projectPath = path.join(root, "forest-town");
  try {
    const calls = [];
    const result = await createGameProjectWorkspace({
      name: "Forest Town",
      directoryName: "forest-town",
      projectPath,
      projectFile: ".tiled-project",
      initialMap: "maps/intro.tmj",
      preset: "building",
      width: 96,
      height: 48,
      tilewidth: 16,
      tileheight: 16,
    }, {
      createMap: async (input) => {
        calls.push(input);
        return { relativePath: input.relativePath, version: "test" };
      },
    });

    assert.equal(result.projectFile, ".tiled-project");
    assert.equal(result.initialMap, "maps/intro.tmj");
    assert.equal(result.initialLayerName, "Ground");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].projectPath, projectPath);
    assert.equal(calls[0].relativePath, "maps/intro.tmj");
    assert.equal(calls[0].width, 96);
    assert.equal(calls[0].height, 48);
    await fs.access(path.join(projectPath, "maps"));
    await fs.access(path.join(projectPath, "images"));
    assert.equal(await fs.readFile(path.join(projectPath, ".tiled-project"), "utf8").then((source) => (
      JSON.parse(source).folders.includes("maps")
    )), true);
    assert.equal(await fs.readFile(path.join(projectPath, "automapping", "rules.txt"), "utf8"), "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removes only the newly created workspace when setup fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-game-workspace-create-fail-"));
  const projectPath = path.join(root, "broken-game");
  try {
    await assert.rejects(
      createGameProjectWorkspace({
        name: "Broken Game",
        projectPath,
      }, {
        createMap: async () => {
          throw new Error("map setup failed");
        },
      }),
      (error) => error.statusCode === 500 && error.code === "GAME_PROJECT_CREATE_FAILED",
    );
    await assert.rejects(fs.access(projectPath), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("derives a filesystem-safe directory name without hardcoding a project path", () => {
  assert.equal(gameProjectDirectoryName("Forest Town"), "Forest-Town");
  assert.equal(gameProjectDirectoryName(""), "game-project");
  assert.equal(gameProjectDirectoryName("..."), "game-project");
});
