import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MapProjectCatalog,
  MAP_PROJECT_RESOURCE_KINDS,
} from "../lib/map-project-catalog.mjs";

async function withProject(operation) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-project-catalog-"));
  const projectPath = path.join(temporaryRoot, "game");
  try {
    await fs.mkdir(path.join(projectPath, "maps", "zone2"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "assets"));
    await fs.mkdir(path.join(projectPath, "private"));
    await fs.mkdir(path.join(projectPath, ".git"));
    await fs.mkdir(path.join(projectPath, "node_modules"));
    await fs.writeFile(path.join(projectPath, "game.tiled-project"), '{"folders":["maps","assets"]}\n');
    await fs.writeFile(path.join(projectPath, "maps", "zone10.tmj"), '{"type":"map"}\n');
    await fs.writeFile(path.join(projectPath, "maps", "zone2", "town.tmj"), '{"type":"map"}\n');
    await fs.writeFile(path.join(projectPath, "maps", "world.world"), '{"maps":[]}\n');
    await fs.writeFile(path.join(projectPath, "maps", "terrain.tsj"), '{"type":"tileset"}\n');
    await fs.writeFile(path.join(projectPath, "maps", "portal.tx"), '{"type":"template"}\n');
    await fs.writeFile(path.join(projectPath, "maps", "rules.txt"), "rules/map.tmx\n");
    await fs.writeFile(path.join(projectPath, "assets", "grass.png"), "png");
    await fs.writeFile(path.join(projectPath, "assets", "theme.ogg"), "audio");
    await fs.writeFile(path.join(projectPath, "assets", "index.html"), "<main></main>\n");
    await fs.writeFile(path.join(projectPath, "assets", "runtime.js"), "export {};\n");
    await fs.writeFile(path.join(projectPath, "private", "secret.tmj"), '{"type":"map"}\n');
    await fs.writeFile(path.join(projectPath, ".git", "config"), "private\n");
    await fs.writeFile(path.join(projectPath, "node_modules", "package.js"), "private\n");
    await operation({ temporaryRoot, projectPath });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("lists a scoped project tree with relative paths, resource kinds and opaque pagination", async () => {
  await withProject(async ({ projectPath }) => {
    const catalog = new MapProjectCatalog({ defaultPageSize: 2 });
    const context = {
      projectPath,
      projectFile: "game.tiled-project",
      resourceRoots: ["maps", "assets"],
    };
    const first = await catalog.list({ ...context, limit: 2 });
    assert.deepEqual(first.entries.map(({ path: entryPath, kind }) => [entryPath, kind]), [
      ["assets", "directory"],
      ["maps", "directory"],
    ]);
    assert.ok(first.nextCursor);
    const second = await catalog.list({ ...context, limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.entries.map(({ path: entryPath, kind }) => [entryPath, kind]), [
      ["game.tiled-project", "project"],
    ]);
    assert.equal(second.nextCursor, null);
    assert.equal(JSON.stringify({ first, second }).includes(projectPath), false);

    const maps = await catalog.list({ ...context, directory: "maps", limit: 20 });
    assert.deepEqual(maps.entries.map(({ name, kind }) => [name, kind]), [
      ["zone2", "directory"],
      ["portal.tx", "template"],
      ["rules.txt", "automapping"],
      ["terrain.tsj", "tileset"],
      ["world.world", "world"],
      ["zone10.tmj", "map"],
    ]);
    assert.equal(maps.entries.every((entry) => MAP_PROJECT_RESOURCE_KINDS.includes(entry.kind)
      || entry.kind === "directory"), true);
  });
});

test("filters file kinds while retaining directories needed for navigation", async () => {
  await withProject(async ({ projectPath }) => {
    const catalog = new MapProjectCatalog();
    const listed = await catalog.list({
      projectPath,
      projectFile: "game.tiled-project",
      resourceRoots: ["maps"],
      directory: "maps",
      kinds: "map,world",
    });
    assert.deepEqual(listed.entries.map(({ name, kind }) => [name, kind]), [
      ["zone2", "directory"],
      ["world.world", "world"],
      ["zone10.tmj", "map"],
    ]);
  });
});

test("searches recursively with bounded scans and cursor-bound pagination", async () => {
  await withProject(async ({ projectPath }) => {
    const context = {
      projectPath,
      projectFile: "game.tiled-project",
      resourceRoots: ["maps", "assets"],
    };
    const catalog = new MapProjectCatalog({ defaultPageSize: 1 });
    const first = await catalog.search({ ...context, query: "tmj", kinds: ["map"], limit: 1 });
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].kind, "map");
    assert.ok(first.nextCursor);
    const second = await catalog.search({
      ...context,
      query: "tmj",
      kinds: ["map"],
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.entries.length, 1);
    assert.notEqual(second.entries[0].path, first.entries[0].path);
    assert.equal(second.nextCursor, null);
    await assert.rejects(
      catalog.search({ ...context, query: "world", kinds: ["map"], cursor: first.nextCursor }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-project-cursor",
    );

    const bounded = new MapProjectCatalog({ maxSearchEntries: 2 });
    const truncated = await bounded.search({ ...context, query: "map" });
    assert.equal(truncated.scanned, 2);
    assert.equal(truncated.truncated, true);
  });
});

test("does not expose resources outside declared folders, hidden paths or symlinks", async () => {
  await withProject(async ({ temporaryRoot, projectPath }) => {
    const outside = path.join(temporaryRoot, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "outside.tmj"), '{"type":"map"}\n');
    await fs.symlink(outside, path.join(projectPath, "maps", "linked"));
    const catalog = new MapProjectCatalog();
    const context = {
      projectPath,
      projectFile: "game.tiled-project",
      resourceRoots: ["maps"],
    };
    const maps = await catalog.list({ ...context, directory: "maps" });
    assert.equal(maps.entries.some((entry) => entry.name === "linked"), false);
    await assert.rejects(
      catalog.list({ ...context, directory: "private" }),
      (error) => error.statusCode === 403 && error.code === "map-project-directory-outside-folders",
    );
    await assert.rejects(
      catalog.list({ ...context, directory: "../private" }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-project-path",
    );
    const search = await catalog.search({ ...context, query: "secret" });
    assert.deepEqual(search.entries, []);
  });
});

