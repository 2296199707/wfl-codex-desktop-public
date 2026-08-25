import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MapAiProjectScopeError,
  inspectMapAiProjectResource,
  listMapAiProjectResources,
  readMapAiProjectResource,
} from "../lib/map-ai-project-scope.mjs";

test("project resource scan is bounded, relative, classified, and symlink-free", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-project-scope-"));
  const project = path.join(root, "game");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(project, "maps"), { recursive: true });
  await fs.mkdir(path.join(project, "worlds"), { recursive: true });
  await fs.mkdir(path.join(project, "tilesets"), { recursive: true });
  await fs.mkdir(path.join(project, "characters"), { recursive: true });
  await fs.mkdir(path.join(project, "assets"), { recursive: true });
  await fs.mkdir(path.join(project, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(project, "node_modules", "ignored"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(project, "maps", "world.tmj"), "{}"),
    fs.writeFile(path.join(project, "worlds", "main.world"), "{}"),
    fs.writeFile(path.join(project, "tilesets", "terrain.tsj"), "{}"),
    fs.writeFile(path.join(project, "characters", "hero.character.json"), "{}"),
    fs.writeFile(path.join(project, "assets", "hero.png"), Buffer.from([0, 1, 2])),
    fs.writeFile(path.join(project, ".hidden", "secret.tmj"), "{}"),
    fs.writeFile(path.join(project, "node_modules", "ignored", "package.json"), "{}"),
    fs.writeFile(path.join(outside, "outside.txt"), "private"),
  ]);
  await fs.symlink(path.join(outside, "outside.txt"), path.join(project, "link.txt"));
  await fs.symlink(outside, path.join(project, "linked-directory"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const catalog = await listMapAiProjectResources({ projectPath: project });
  assert.equal(catalog.truncated, false);
  assert.deepEqual(catalog.resources.map((entry) => entry.path), [
    "assets/hero.png",
    "characters/hero.character.json",
    "maps/world.tmj",
    "tilesets/terrain.tsj",
    "worlds/main.world",
  ]);
  assert.deepEqual(
    Object.fromEntries(catalog.resources.map((entry) => [entry.path, entry.kind])),
    {
      "assets/hero.png": "image",
      "characters/hero.character.json": "character",
      "maps/world.tmj": "map",
      "tilesets/terrain.tsj": "tileset",
      "worlds/main.world": "world",
    },
  );

  const inspected = await inspectMapAiProjectResource({ projectPath: project, relativePath: "maps/world.tmj" });
  assert.equal(inspected.version, crypto.createHash("sha256").update("{}").digest("hex"));
  const text = await readMapAiProjectResource({ projectPath: project, relativePath: "characters/hero.character.json" });
  assert.equal(text.content, "{}");
  await assert.rejects(
    readMapAiProjectResource({ projectPath: project, relativePath: "assets/hero.png" }),
    (error) => error instanceof MapAiProjectScopeError && error.code === "MAP_AI_PROJECT_RESOURCE_BINARY",
  );
  await assert.rejects(
    inspectMapAiProjectResource({ projectPath: project, relativePath: "link.txt" }),
    (error) => error instanceof MapAiProjectScopeError && error.code === "MAP_AI_PROJECT_RESOURCE_SYMLINK",
  );
  await assert.rejects(
    inspectMapAiProjectResource({ projectPath: project, relativePath: "../outside.txt" }),
    (error) => error instanceof MapAiProjectScopeError && error.code === "MAP_AI_PROJECT_RESOURCE_PATH_INVALID",
  );
});

test("project root symlinks are rejected and catalog limits are explicit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-ai-project-root-"));
  const project = path.join(root, "game");
  const linked = path.join(root, "linked-game");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "a.txt"), "a");
  await fs.symlink(project, linked);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    listMapAiProjectResources({ projectPath: linked }),
    (error) => error instanceof MapAiProjectScopeError && error.code === "MAP_AI_PROJECT_SYMLINK",
  );
  const limited = await listMapAiProjectResources({ projectPath: project, limit: 1 });
  assert.equal(limited.resourceCount, 1);
  assert.equal(limited.truncated, false);
});
