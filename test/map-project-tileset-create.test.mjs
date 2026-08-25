import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTiledTilesetDocument,
  createTiledTilesetFile,
} from "../lib/map-project-tileset-create.mjs";

const IMAGE_HASH = "a".repeat(64);

test("builds a Tiled 1.12.2 atlas from decoded image dimensions", () => {
  const document = createTiledTilesetDocument({
    relativePath: "tiles/terrain.tsj",
    kind: "atlas",
    name: "Terrain",
    tilewidth: 16,
    tileheight: 16,
    margin: 1,
    spacing: 2,
    transparentcolor: "#FF00FF",
  }, [{ path: "images/terrain.png", width: 56, height: 38, sha256: IMAGE_HASH }]);
  assert.deepEqual(document, {
    columns: 3,
    image: "../images/terrain.png",
    imageheight: 38,
    imagewidth: 56,
    margin: 1,
    name: "Terrain",
    spacing: 2,
    tilecount: 6,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    transparentcolor: "#ff00ff",
    type: "tileset",
    version: "1.12",
  });
});

test("creates stable local IDs for an image collection without reordering inputs", () => {
  const document = createTiledTilesetDocument({
    relativePath: "tiles/props.tsj",
    kind: "collection",
    name: "Props",
  }, [
    { path: "images/tree.webp", width: 24, height: 48, sha256: "b".repeat(64) },
    { path: "images/rock.png", width: 64, height: 32, sha256: "c".repeat(64) },
  ]);
  assert.equal(document.columns, 0);
  assert.equal(document.tilecount, 2);
  assert.equal(document.tilewidth, 64);
  assert.equal(document.tileheight, 48);
  assert.deepEqual(document.tiles, [
    { id: 0, image: "../images/tree.webp", imageheight: 48, imagewidth: 24 },
    { id: 1, image: "../images/rock.png", imageheight: 32, imagewidth: 64 },
  ]);
});

test("rejects unsafe, duplicate, empty, and undersized tileset inputs", () => {
  assert.throws(
    () => createTiledTilesetDocument({
      relativePath: "../escape.tsj",
      kind: "atlas",
      name: "Bad",
      tilewidth: 16,
      tileheight: 16,
    }, [{ path: "images/a.png", width: 16, height: 16 }]),
    (error) => error.statusCode === 400 && error.code === "invalid-map-project-tileset-path",
  );
  assert.throws(
    () => createTiledTilesetDocument({
      relativePath: "tiles/a.tsj",
      kind: "atlas",
      name: "Bad",
      tilewidth: 32,
      tileheight: 32,
    }, [{ path: "images/a.png", width: 16, height: 16 }]),
    (error) => error.statusCode === 400 && error.code === "map-project-atlas-image-too-small",
  );
  assert.throws(
    () => createTiledTilesetDocument({
      relativePath: "tiles/a.tsj",
      kind: "collection",
      name: "Bad",
    }, []),
    (error) => error.statusCode === 400 && error.code === "invalid-map-project-collection-images",
  );
});

test("atomically creates a validated atlas without overwriting an existing TSJ", async () => {
  await withProject(async ({ projectPath }) => {
    const input = atlasInput(projectPath, "tiles/terrain.tsj");
    const options = {
      inspectResource: fixedInspector(),
      validateCandidate: validateCandidateHash,
    };
    const created = await createTiledTilesetFile(input, options);
    assert.equal(created.kind, "atlas");
    assert.equal(created.tilecount, 8);
    assert.equal(created.imageCount, 1);
    assert.deepEqual(created.imagePaths, ["images/terrain.png"]);
    const targetPath = path.join(projectPath, created.relativePath);
    const original = await fs.readFile(targetPath);
    const document = JSON.parse(original);
    assert.equal(document.image, "../images/terrain.png");
    await assert.rejects(
      createTiledTilesetFile(input, options),
      (error) => error.statusCode === 409 && error.code === "map-project-tileset-exists",
    );
    assert.deepEqual(await fs.readFile(targetPath), original);
  });
});

test("image changes and validation failures leave no TSJ target or candidate", async () => {
  await withProject(async ({ projectPath }) => {
    let inspections = 0;
    await assert.rejects(
      createTiledTilesetFile(atlasInput(projectPath, "tiles/changed.tsj"), {
        inspectResource: async ({ resourcePath }) => ({
          kind: "image",
          path: resourcePath,
          width: 64,
          height: 32,
          sha256: `${inspections++ ? "b" : "a"}`.repeat(64),
        }),
        validateCandidate: validateCandidateHash,
      }),
      (error) => error.statusCode === 409 && error.code === "map-project-tileset-image-changed",
    );
    await assert.rejects(fs.access(path.join(projectPath, "tiles", "changed.tsj")));

    await assert.rejects(
      createTiledTilesetFile(atlasInput(projectPath, "tiles/rejected.tsj"), {
        inspectResource: fixedInspector(),
        validateCandidate: async () => {
          const error = new Error("fixture rejected");
          error.statusCode = 422;
          throw error;
        },
      }),
      (error) => error.statusCode === 422 && error.code === "map-project-tileset-validation-failed",
    );
    await assert.rejects(fs.access(path.join(projectPath, "tiles", "rejected.tsj")));
    assert.deepEqual(
      (await fs.readdir(path.join(projectPath, "tiles"))).filter((name) => name.includes("wfl-new-tileset")),
      [],
    );
  });
});

function atlasInput(projectPath, relativePath) {
  return {
    projectPath,
    relativePath,
    kind: "atlas",
    name: "Terrain",
    image: "images/terrain.png",
    tilewidth: 16,
    tileheight: 16,
    margin: 0,
    spacing: 0,
  };
}

function fixedInspector() {
  return async ({ resourcePath }) => ({
    kind: "image",
    path: resourcePath,
    width: 64,
    height: 32,
    sha256: IMAGE_HASH,
  });
}

async function validateCandidateHash({ candidatePath }) {
  const content = await fs.readFile(candidatePath);
  return {
    version: crypto.createHash("sha256").update(content).digest("hex"),
    diagnostics: [],
  };
}

async function withProject(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-tileset-create-"));
  const projectPath = path.join(root, "project");
  try {
    await fs.mkdir(path.join(projectPath, "tiles"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "images"), { recursive: true });
    await operation({ root, projectPath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
