import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTiledWorldDocument,
  createTiledWorldFile,
} from "../lib/map-project-world-create.mjs";

test("builds Tiled World references relative to the World document", () => {
  const document = createTiledWorldDocument({
    relativePath: "worlds/main.world",
    maps: [{ path: "maps/town.tmj", x: -320, y: 0, width: 320, height: 240 }],
    patterns: [{
      regexp: "region-(\\d+)-(\\d+)\\.tmj",
      multiplierX: 320,
      multiplierY: 240,
      offsetX: 0,
      offsetY: 0,
      mapWidth: 320,
      mapHeight: 240,
    }],
    onlyShowAdjacentMaps: true,
  });
  assert.equal(document.type, "world");
  assert.equal(document.maps[0].fileName, "../maps/town.tmj");
  assert.equal(document.onlyShowAdjacentMaps, true);
  assert.equal(document.patterns.length, 1);
});

test("atomically creates a validated World without overwriting an existing file", async () => {
  await withProject(async ({ projectPath }) => {
    const input = {
      projectPath,
      relativePath: "worlds/main.world",
      maps: [{ path: "maps/town.tmj", x: 0, y: 0, width: 320, height: 240 }],
      patterns: [],
      onlyShowAdjacentMaps: false,
    };
    const created = await createTiledWorldFile(input);
    assert.equal(created.relativePath, "worlds/main.world");
    assert.equal(created.mapCount, 1);
    assert.match(created.version, /^[a-f0-9]{64}$/u);
    const targetPath = path.join(projectPath, created.relativePath);
    const original = await fs.readFile(targetPath);
    const document = JSON.parse(original);
    assert.equal(document.maps[0].fileName, "../maps/town.tmj");
    await assert.rejects(
      createTiledWorldFile(input),
      (error) => error.statusCode === 409 && error.code === "map-project-world-exists",
    );
    assert.deepEqual(await fs.readFile(targetPath), original);
  });
});

test("validation failure, traversal and symlink parents leave no World target", async () => {
  await withProject(async ({ root, projectPath }) => {
    await assert.rejects(
      createTiledWorldFile({ projectPath, relativePath: "worlds/rejected.world" }, {
        validateCandidate: async () => {
          const error = new Error("fixture rejected");
          error.statusCode = 422;
          throw error;
        },
      }),
      (error) => error.statusCode === 422 && error.code === "map-project-world-validation-failed",
    );
    await assert.rejects(fs.access(path.join(projectPath, "worlds", "rejected.world")));
    await assert.rejects(
      createTiledWorldFile({ projectPath, relativePath: "../escape.world" }),
      (error) => error.statusCode === 400,
    );
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(projectPath, "linked"));
    await assert.rejects(
      createTiledWorldFile({ projectPath, relativePath: "linked/escape.world" }),
      (error) => [400, 403].includes(error.statusCode),
    );
    await assert.rejects(fs.access(path.join(outside, "escape.world")));
  });
});

test("rejects raw fileName fields, invalid map paths and malformed patterns", () => {
  assert.throws(
    () => createTiledWorldDocument({
      relativePath: "worlds/main.world",
      maps: [{ fileName: "../../escape.tmj", x: 0, y: 0, width: 1, height: 1 }],
    }),
    /工程相对路径/u,
  );
  assert.throws(
    () => createTiledWorldDocument({
      relativePath: "worlds/main.world",
      patterns: [{ regexp: "(", multiplierX: 1, multiplierY: 1, offsetX: 0, offsetY: 0, mapWidth: 1, mapHeight: 1 }],
    }),
    /regexp/u,
  );
});

async function withProject(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-world-create-"));
  const projectPath = path.join(root, "project");
  try {
    await fs.mkdir(path.join(projectPath, "maps"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "maps", "town.tmj"), `${JSON.stringify({
      type: "map",
      width: 20,
      height: 15,
      tilewidth: 16,
      tileheight: 16,
      layers: [],
      tilesets: [],
    })}\n`);
    await operation({ root, projectPath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}
