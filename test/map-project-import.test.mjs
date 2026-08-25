import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  commitMapProjectImportPlan,
  planMapProjectImport,
} from "../lib/map-project-import.mjs";

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-project-import-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await Promise.all([
    fs.mkdir(path.join(source, "maps"), { recursive: true }),
    fs.mkdir(path.join(source, "tiles"), { recursive: true }),
    fs.mkdir(path.join(source, "templates"), { recursive: true }),
    fs.mkdir(path.join(source, "images"), { recursive: true }),
    fs.mkdir(path.join(target, "imports"), { recursive: true }),
  ]);
  try {
    await run({ root, source, target });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const VALID_TILE_IMAGE = await sharp({
  create: { width: 32, height: 32, channels: 4, background: { r: 38, g: 116, b: 82, alpha: 1 } },
}).png().toBuffer();
const VALID_TERRAIN_IMAGE = await sharp({
  create: { width: 16, height: 16, channels: 4, background: { r: 38, g: 116, b: 82, alpha: 1 } },
}).png().toBuffer();

test("plans and atomically commits a cross-project TSJ with rewritten image dependency", async () => {
  await fixture(async ({ root, source, target }) => {
    const image = VALID_TERRAIN_IMAGE;
    const tileset = `${JSON.stringify({
      columns: 1,
      image: "../images/terrain.png",
      imageheight: 16,
      imagewidth: 16,
      name: "Terrain",
      tilecount: 1,
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
    }, null, 2)}\n`;
    await fs.writeFile(path.join(source, "images/terrain.png"), image);
    await fs.writeFile(path.join(source, "tiles/terrain.tsj"), tileset);

    const plan = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source-game",
      sourceResourceRoots: ["tiles", "images"],
      sourcePath: "tiles/terrain.tsj",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/terrain.tsj",
    });
    assert.equal(plan.copyCount, 2);
    assert.equal(plan.reuseCount, 0);
    assert.equal(plan.files.find((entry) => entry.sourcePath === "images/terrain.png").targetPath, "imports/_deps/source-game/images/terrain.png");

    const committed = await commitMapProjectImportPlan(plan, {
      temporaryRoot: path.join(root, "transactions"),
    });
    assert.equal(committed.published.length, 2);
    const rewritten = JSON.parse(await fs.readFile(path.join(target, "imports/terrain.tsj"), "utf8"));
    assert.equal(rewritten.image, "_deps/source-game/images/terrain.png");
    assert.deepEqual(await fs.readFile(path.join(target, "imports/_deps/source-game/images/terrain.png")), image);
    assert.equal(committed.plan.planHash, plan.planHash);
    assert.equal(plan.files.find((entry) => entry.targetPath === "imports/terrain.tsj").sha256, hash(Buffer.from(JSON.stringify(rewritten, null, 2) + "\n")));

    const reused = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source-game",
      sourceResourceRoots: ["tiles", "images"],
      sourcePath: "tiles/terrain.tsj",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/terrain.tsj",
    });
    assert.equal(reused.copyCount, 0);
    assert.equal(reused.reuseCount, 2);
  });
});

test("rejects unsafe or external dependencies without changing the target", async () => {
  await fixture(async ({ source, target }) => {
    await fs.writeFile(path.join(source, "tiles/bad.tsj"), `${JSON.stringify({
      type: "tileset",
      image: "https://example.test/remote.png",
      tilewidth: 16,
      tileheight: 16,
    })}\n`);
    await assert.rejects(
      planMapProjectImport({
        sourceProjectPath: source,
        sourceProjectName: "source",
        sourceResourceRoots: ["tiles", "images"],
        sourcePath: "tiles/bad.tsj",
        targetProjectPath: target,
        targetResourceRoots: ["imports"],
        targetPath: "imports/bad.tsj",
      }),
      (error) => ["MAP_IMPORT_EXTERNAL_REFERENCE", "MAP_IMPORT_DOCUMENT_INVALID"].includes(error.code),
    );
    assert.equal(await fs.lstat(path.join(target, "imports/bad.tsj")).catch(() => null), null);
  });
});

test("rejects a corrupted raster dependency before creating an import plan", async () => {
  await fixture(async ({ source, target }) => {
    await fs.writeFile(path.join(source, "images/corrupt.png"), Buffer.from("not-a-png"));
    await assert.rejects(
      planMapProjectImport({
        sourceProjectPath: source,
        sourceProjectName: "source",
        sourceResourceRoots: ["images"],
        sourcePath: "images/corrupt.png",
        targetProjectPath: target,
        targetResourceRoots: ["imports"],
        targetPath: "imports/corrupt.png",
      }),
      (error) => error.code === "MAP_IMPORT_IMAGE_INVALID" && error.statusCode === 422,
    );
    assert.equal(await fs.lstat(path.join(target, "imports/corrupt.png")).catch(() => null), null);
  });
});

test("rejects a tileset whose declared atlas dimensions do not match the decoded image", async () => {
  await fixture(async ({ source, target }) => {
    await fs.writeFile(path.join(source, "images/wrong.png"), VALID_TILE_IMAGE);
    await fs.writeFile(path.join(source, "tiles/wrong.tsj"), `${JSON.stringify({
      columns: 1,
      image: "../images/wrong.png",
      imageheight: 16,
      imagewidth: 16,
      name: "Wrong",
      tilecount: 1,
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
    })}\n`);
    await assert.rejects(
      planMapProjectImport({
        sourceProjectPath: source,
        sourceProjectName: "source",
        sourceResourceRoots: ["tiles", "images"],
        sourcePath: "tiles/wrong.tsj",
        targetProjectPath: target,
        targetResourceRoots: ["imports"],
        targetPath: "imports/wrong.tsj",
      }),
      (error) => error.code === "MAP_IMPORT_TILESET_GRID_INVALID" && error.statusCode === 422,
    );
    assert.equal(await fs.lstat(path.join(target, "imports/wrong.tsj")).catch(() => null), null);
  });
});

test("validates image-collection tile dimensions during import planning", async () => {
  await fixture(async ({ source, target }) => {
    await fs.writeFile(path.join(source, "images/tree.png"), VALID_TILE_IMAGE);
    await fs.writeFile(path.join(source, "tiles/props.tsj"), `${JSON.stringify({
      tilecount: 1,
      tileheight: 32,
      tilewidth: 32,
      tiles: [{ id: 0, image: "../images/tree.png", imageheight: 32, imagewidth: 32 }],
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
    })}\n`);
    const plan = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source",
      sourceResourceRoots: ["tiles", "images"],
      sourcePath: "tiles/props.tsj",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/props.tsj",
    });
    assert.equal(plan.copyCount, 2);

    await fs.writeFile(path.join(source, "tiles/props.tsj"), `${JSON.stringify({
      tilecount: 1,
      tileheight: 32,
      tilewidth: 32,
      tiles: [{ id: 0, image: "../images/tree.png", imageheight: 16, imagewidth: 16 }],
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
    })}\n`);
    await assert.rejects(
      planMapProjectImport({
        sourceProjectPath: source,
        sourceProjectName: "source",
        sourceResourceRoots: ["tiles", "images"],
        sourcePath: "tiles/props.tsj",
        targetProjectPath: target,
        targetResourceRoots: ["imports"],
        targetPath: "imports/props-2.tsj",
      }),
      (error) => error.code === "MAP_IMPORT_TILESET_IMAGE_INVALID" && error.statusCode === 422,
    );
  });
});

test("keeps a non-raster SVG atlas importable without guessing pixel dimensions", async () => {
  await fixture(async ({ source, target }) => {
    await fs.writeFile(path.join(source, "images/vector.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#267452"/></svg>\n');
    await fs.writeFile(path.join(source, "tiles/vector.tsj"), `${JSON.stringify({
      columns: 1,
      image: "../images/vector.svg",
      imageheight: 16,
      imagewidth: 16,
      name: "Vector",
      tilecount: 1,
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
    })}\n`);
    const plan = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source",
      sourceResourceRoots: ["tiles", "images"],
      sourcePath: "tiles/vector.tsj",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/vector.tsj",
    });
    assert.equal(plan.copyCount, 2);
    await commitMapProjectImportPlan(plan, { temporaryRoot: path.join(path.dirname(source), "transactions") });
    assert.equal(await fs.readFile(path.join(target, "imports/_deps/source/images/vector.svg"), "utf8"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#267452"/></svg>\n');
  });
});

test("validates an inline TMJ tileset against its decoded image before import", async () => {
  await fixture(async ({ root, source, target }) => {
    await fs.writeFile(path.join(source, "images/inline.png"), VALID_TILE_IMAGE);
    const map = {
      type: "map",
      version: "1.12",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      renderorder: "right-down",
      infinite: false,
      width: 1,
      height: 1,
      tilewidth: 32,
      tileheight: 32,
      nextlayerid: 2,
      nextobjectid: 1,
      layers: [{ id: 1, name: "Ground", type: "tilelayer", x: 0, y: 0, width: 1, height: 1, opacity: 1, visible: true, data: [1] }],
      tilesets: [{
        firstgid: 1,
        columns: 1,
        image: "../images/inline.png",
        imageheight: 32,
        imagewidth: 32,
        name: "Inline",
        tilecount: 1,
        tileheight: 32,
        tilewidth: 32,
        type: "tileset",
        version: "1.12",
        tiledversion: "1.12.2",
      }],
    };
    await fs.writeFile(path.join(source, "maps/inline.tmj"), `${JSON.stringify(map, null, 2)}\n`);
    const plan = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source",
      sourceResourceRoots: ["maps", "images"],
      sourcePath: "maps/inline.tmj",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/inline.tmj",
    });
    assert.equal(plan.copyCount, 2);
    await commitMapProjectImportPlan(plan, { temporaryRoot: path.join(root, "transactions") });
    const copiedMap = JSON.parse(await fs.readFile(path.join(target, "imports/inline.tmj"), "utf8"));
    assert.equal(copiedMap.tilesets[0].image, "_deps/source/images/inline.png");
    assert.deepEqual(await fs.readFile(path.join(target, "imports/_deps/source/images/inline.png")), VALID_TILE_IMAGE);

    map.tilesets[0].imagewidth = 16;
    await fs.writeFile(path.join(source, "maps/inline.tmj"), `${JSON.stringify(map, null, 2)}\n`);
    await assert.rejects(
      planMapProjectImport({
        sourceProjectPath: source,
        sourceProjectName: "source",
        sourceResourceRoots: ["maps", "images"],
        sourcePath: "maps/inline.tmj",
        targetProjectPath: target,
        targetResourceRoots: ["imports"],
        targetPath: "imports/inline-bad.tmj",
      }),
      (error) => error.code === "MAP_IMPORT_TILESET_GRID_INVALID" && error.statusCode === 422,
    );
  });
});

test("validates an inline TX tileset against its decoded image before import", async () => {
  await fixture(async ({ root, source, target }) => {
    await fs.writeFile(path.join(source, "images/template.png"), VALID_TILE_IMAGE);
    const template = {
      type: "template",
      tileset: {
        firstgid: 1,
        columns: 1,
        image: "../images/template.png",
        imageheight: 32,
        imagewidth: 32,
        tilecount: 1,
        tileheight: 32,
        tilewidth: 32,
        type: "tileset",
        version: "1.12",
        tiledversion: "1.12.2",
      },
      object: { id: 1, gid: 1, x: 0, y: 0, width: 32, height: 32, visible: true },
    };
    await fs.writeFile(path.join(source, "templates/inline.tx"), `${JSON.stringify(template, null, 2)}\n`);
    const plan = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source",
      sourceResourceRoots: ["templates", "images"],
      sourcePath: "templates/inline.tx",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/inline.tx",
    });
    assert.equal(plan.copyCount, 2);
    await commitMapProjectImportPlan(plan, { temporaryRoot: path.join(root, "transactions") });
    const copiedTemplate = JSON.parse(await fs.readFile(path.join(target, "imports/inline.tx"), "utf8"));
    assert.equal(copiedTemplate.tileset.image, "_deps/source/images/template.png");
    assert.deepEqual(await fs.readFile(path.join(target, "imports/_deps/source/images/template.png")), VALID_TILE_IMAGE);

    template.tileset.imageheight = 16;
    await fs.writeFile(path.join(source, "templates/inline.tx"), `${JSON.stringify(template, null, 2)}\n`);
    await assert.rejects(
      planMapProjectImport({
        sourceProjectPath: source,
        sourceProjectName: "source",
        sourceResourceRoots: ["templates", "images"],
        sourcePath: "templates/inline.tx",
        targetProjectPath: target,
        targetResourceRoots: ["imports"],
        targetPath: "imports/inline-bad.tx",
      }),
      (error) => error.code === "MAP_IMPORT_TILESET_GRID_INVALID" && error.statusCode === 422,
    );
  });
});

test("copies a tile-object template with its root TSJ and image dependency", async () => {
  await fixture(async ({ root, source, target }) => {
    const image = VALID_TILE_IMAGE;
    const tileset = {
      columns: 1,
      image: "../images/tree.png",
      imageheight: 32,
      imagewidth: 32,
      name: "Trees",
      tilecount: 1,
      tileheight: 32,
      tilewidth: 32,
      type: "tileset",
      version: "1.12",
      tiledversion: "1.12.2",
      futureTilesetField: { keep: true },
    };
    const template = {
      type: "template",
      tileset: { firstgid: 1, source: "../tiles/trees.tsj" },
      object: {
        id: 1,
        gid: (0x8000_0000 | 1) >>> 0,
        name: "Tree",
        visible: true,
        futureObjectField: { keep: true },
      },
      futureTemplateField: { keep: true },
    };
    await Promise.all([
      fs.writeFile(path.join(source, "images/tree.png"), image),
      fs.writeFile(path.join(source, "tiles/trees.tsj"), `${JSON.stringify(tileset, null, 2)}\n`),
      fs.writeFile(path.join(source, "templates/tree.tx"), `${JSON.stringify(template, null, 2)}\n`),
    ]);

    const plan = await planMapProjectImport({
      sourceProjectPath: source,
      sourceProjectName: "source-game",
      sourceResourceRoots: ["templates", "tiles", "images"],
      sourcePath: "templates/tree.tx",
      targetProjectPath: target,
      targetResourceRoots: ["imports"],
      targetPath: "imports/tree.tx",
    });
    assert.equal(plan.copyCount, 3);
    assert.deepEqual(plan.files.map(({ sourcePath, targetPath }) => ({ sourcePath, targetPath })), [
      { sourcePath: "templates/tree.tx", targetPath: "imports/tree.tx" },
      { sourcePath: "tiles/trees.tsj", targetPath: "imports/_deps/source-game/tiles/trees.tsj" },
      { sourcePath: "images/tree.png", targetPath: "imports/_deps/source-game/images/tree.png" },
    ]);

    await commitMapProjectImportPlan(plan, { temporaryRoot: path.join(root, "transactions") });
    const copiedTemplate = JSON.parse(await fs.readFile(path.join(target, "imports/tree.tx"), "utf8"));
    const copiedTileset = JSON.parse(await fs.readFile(path.join(target, "imports/_deps/source-game/tiles/trees.tsj"), "utf8"));
    assert.equal(copiedTemplate.tileset.source, "_deps/source-game/tiles/trees.tsj");
    assert.equal(copiedTemplate.object.gid, (0x8000_0000 | 1) >>> 0);
    assert.deepEqual(copiedTemplate.futureTemplateField, { keep: true });
    assert.equal(copiedTileset.image, "../images/tree.png");
    assert.deepEqual(copiedTileset.futureTilesetField, { keep: true });
    assert.deepEqual(await fs.readFile(path.join(target, "imports/_deps/source-game/images/tree.png")), image);
  });
});
