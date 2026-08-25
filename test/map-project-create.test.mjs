import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import {
  createTiledMap,
  createTiledMapDocument,
} from "../lib/map-project-create.mjs";

const orientations = [
  ["orthogonal", {}],
  ["isometric", {}],
  ["staggered", { staggeraxis: "x", staggerindex: "even" }],
  ["hexagonal", { staggeraxis: "y", staggerindex: "odd", hexsidelength: 8 }],
  ["oblique", { skewx: 4, skewy: 2 }],
];

async function withProject(operation) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-project-create-"));
  const projectPath = path.join(temporaryRoot, "game");
  try {
    await fs.mkdir(path.join(projectPath, "maps"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "tiles"));
    await fs.writeFile(path.join(projectPath, "tiles", "terrain.tsj"), `${JSON.stringify({
      columns: 0,
      name: "Terrain",
      tilecount: 0,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.12",
    })}\n`);
    await operation({ temporaryRoot, projectPath });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("builds fixed and infinite Tiled 1.12.2 maps for all supported orientations", async () => {
  for (const [orientation, fields] of orientations) {
    const fixed = await createTiledMapDocument({
      relativePath: `maps/${orientation}.tmj`,
      orientation,
      width: 3,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      backgroundcolor: "#102030ff",
      initialLayerName: "Ground",
      targetVersion: "1.12.2",
      ...fields,
    });
    assert.equal(fixed.orientation, orientation);
    assert.equal(fixed.tiledversion, "1.12.2");
    assert.equal(fixed.version, "1.12");
    assert.equal(fixed.layers[0].encoding, "base64");
    assert.equal(fixed.layers[0].compression, "zlib");
    assert.deepEqual(inflateSync(Buffer.from(fixed.layers[0].data, "base64")), Buffer.alloc(24));

    const infinite = await createTiledMapDocument({
      relativePath: `maps/${orientation}-infinite.tmj`,
      orientation,
      infinite: true,
      tilewidth: 16,
      tileheight: 16,
      ...fields,
    });
    assert.equal(infinite.infinite, true);
    assert.equal(infinite.width, 0);
    assert.equal(infinite.height, 0);
    assert.deepEqual(infinite.layers[0].chunks, []);
    assert.equal("data" in infinite.layers[0], false);
  }
});

test("uses an external TSJ reference relative to the new map", async () => {
  const document = await createTiledMapDocument({
    relativePath: "maps/areas/town.tmj",
    orientation: "orthogonal",
    width: 2,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    tilesets: ["tiles/terrain.tsj"],
  });
  assert.deepEqual(document.tilesets, [{ firstgid: 1, source: "../../tiles/terrain.tsj" }]);
  await assert.rejects(
    createTiledMapDocument({
      relativePath: "maps/town.tmj",
      orientation: "orthogonal",
      width: 1,
      height: 1,
      tilewidth: 16,
      tileheight: 16,
      tilesets: ["tiles/terrain.tsj", "tiles/other.tsj"],
    }),
    (error) => error.statusCode === 400 && error.code === "invalid-map-project-tilesets",
  );
});

test("enforces the server supplied fixed-map byte budget", async () => {
  await assert.rejects(
    createTiledMapDocument({
      relativePath: "maps/too-large.tmj",
      orientation: "orthogonal",
      width: 3,
      height: 3,
      tilewidth: 16,
      tileheight: 16,
    }, { maxTileBytes: 32 }),
    (error) => error.statusCode === 413 && error.code === "map-project-create-cell-limit",
  );
});

test("atomically creates a validated map without overwriting an existing target", async () => {
  await withProject(async ({ projectPath }) => {
    const input = baseCreateInput(projectPath, "maps/town.tmj");
    const created = await createTiledMap(input, { validateCandidate: validateCandidateHash });
    assert.equal(created.relativePath, "maps/town.tmj");
    assert.match(created.version, /^[a-f0-9]{64}$/u);
    const original = await fs.readFile(path.join(projectPath, "maps", "town.tmj"));
    await assert.rejects(
      createTiledMap(input, { validateCandidate: validateCandidateHash }),
      (error) => error.statusCode === 409 && error.code === "map-project-map-exists",
    );
    assert.deepEqual(await fs.readFile(path.join(projectPath, "maps", "town.tmj")), original);
  });
});

test("validation failure and unsafe paths leave no target or candidate", async () => {
  await withProject(async ({ temporaryRoot, projectPath }) => {
    await assert.rejects(
      createTiledMap(baseCreateInput(projectPath, "maps/rejected.tmj"), {
        validateCandidate: async () => {
          const error = new Error("fixture rejected");
          error.statusCode = 422;
          throw error;
        },
      }),
      (error) => error.statusCode === 422 && error.code === "map-project-create-validation-failed",
    );
    await assert.rejects(fs.access(path.join(projectPath, "maps", "rejected.tmj")));
    assert.deepEqual((await fs.readdir(path.join(projectPath, "maps"))).filter((name) => name.includes("wfl-new")), []);

    await assert.rejects(
      createTiledMap(baseCreateInput(projectPath, "../escape.tmj")),
      (error) => error.statusCode === 400,
    );
    await assert.rejects(fs.access(path.join(temporaryRoot, "escape.tmj")));

    const outside = path.join(temporaryRoot, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(projectPath, "maps", "linked"));
    await assert.rejects(
      createTiledMap(baseCreateInput(projectPath, "maps/linked/escape.tmj")),
      (error) => [400, 403].includes(error.statusCode),
    );
    await assert.rejects(fs.access(path.join(outside, "escape.tmj")));
  });
});

test("concurrent same-target creation publishes exactly one complete map", async () => {
  await withProject(async ({ projectPath }) => {
    const input = baseCreateInput(projectPath, "maps/race.tmj");
    const results = await Promise.allSettled([
      createTiledMap(input, { validateCandidate: validateCandidateHash }),
      createTiledMap(input, { validateCandidate: validateCandidateHash }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.equal(rejected.reason.statusCode, 409);
    assert.equal(rejected.reason.code, "map-project-map-exists");
    const document = JSON.parse(await fs.readFile(path.join(projectPath, "maps", "race.tmj"), "utf8"));
    assert.equal(document.type, "map");
    assert.equal(document.layers.length, 1);
  });
});

test("created fixed and infinite maps round-trip through real Tiled 1.12.2", { timeout: 30_000 }, async () => {
  await withProject(async ({ projectPath }) => {
    for (const [name, infinite] of [["fixed", false], ["infinite", true]]) {
      const relativePath = `maps/${name}.tmj`;
      await createTiledMap({
        ...baseCreateInput(projectPath, relativePath),
        infinite,
      });
      const source = path.join(projectPath, relativePath);
      const output = path.join(projectPath, "maps", `${name}-tiled.tmj`);
      await runTiled(["--export-map", source, output]);
      const document = JSON.parse(await fs.readFile(output, "utf8"));
      assert.equal(document.type, "map");
      assert.equal(Boolean(document.infinite), infinite);
      assert.equal(document.orientation, "orthogonal");
    }
  });
});

function baseCreateInput(projectPath, relativePath) {
  return {
    projectPath,
    relativePath,
    orientation: "orthogonal",
    width: 4,
    height: 3,
    tilewidth: 16,
    tileheight: 16,
    initialLayerName: "Ground",
  };
}

async function validateCandidateHash({ candidatePath }) {
  const content = await fs.readFile(candidatePath);
  return {
    version: crypto.createHash("sha256").update(content).digest("hex"),
    diagnostics: [],
  };
}

async function runTiled(args) {
  const binary = process.env.WFL_TILED_BIN || "tiled";
  const command = process.env.DISPLAY ? binary : "xvfb-run";
  const commandArgs = process.env.DISPLAY ? args : ["-a", binary, ...args];
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Tiled failed (code=${code}, signal=${signal || "none"}): ${stderr.trim()}`));
    });
  });
}
