import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  inspectMapProjectResourceTransactions,
  MapProjectResourceWriter,
  recoverMapProjectResourceTransactions,
} from "../lib/map-project-resource-write.mjs";

async function fixture(t) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-write-"));
  await fs.mkdir(path.join(projectPath, "maps"));
  await fs.mkdir(path.join(projectPath, "templates"));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  return projectPath;
}

function template(name = "Portal", extra = {}) {
  return {
    type: "template",
    object: {
      id: 1,
      name,
      width: 16,
      height: 20,
      futureObjectField: { keep: true },
      ...extra,
    },
  };
}

async function interruptedJournal(t, { phase, targetContent = "before\n", candidateContent = "after\n", publish = false, backup = true } = {}) {
  const projectPath = await fixture(t);
  const targetPath = path.join(projectPath, "maps", "village.tmj");
  const directory = await fs.mkdtemp(path.join(projectPath, ".codex-map-transaction-"));
  const temporaryPath = path.join(projectPath, "maps", ".village.tmj.codex-transaction-1234-a1b2c3d4e5f6");
  const backupPath = path.join(directory, "backup-0");
  await fs.writeFile(targetPath, targetContent);
  await fs.writeFile(temporaryPath, candidateContent);
  const candidateStat = await fs.lstat(temporaryPath);
  if (backup) await fs.link(targetPath, backupPath);
  if (publish) {
    await fs.rename(temporaryPath, targetPath);
  }
  await fs.writeFile(path.join(directory, ".map-resource-transaction.json"), JSON.stringify({
    schema: "wfl.map-resource-transaction.v1",
    projectPath,
    phase,
    entries: [{
      relativePath: "maps/village.tmj",
      targetPath,
      temporaryPath,
      backupPath,
      expectedVersion: null,
      beforeVersion: sha256(Buffer.from(targetContent)),
      beforeExists: true,
      candidateDevice: String(candidateStat.dev),
      candidateInode: String(candidateStat.ino),
      candidateSize: Buffer.byteLength(candidateContent),
      candidateSha256: sha256(Buffer.from(candidateContent)),
    }],
    published: publish ? ["maps/village.tmj"] : [],
  }, null, 2));
  return { projectPath, targetPath, directory };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const VALID_PNG_1X1 = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 32, g: 96, b: 160, alpha: 1 } },
}).png().toBuffer();
const VALID_PNG_16X16 = await sharp({
  create: { width: 16, height: 16, channels: 4, background: { r: 32, g: 96, b: 160, alpha: 1 } },
}).png().toBuffer();

test("atomically creates a new .tx template and preserves unknown fields", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const saved = await writer.saveTemplate({
    projectPath,
    resourceRoots: ["maps", "templates"],
    relativePath: "templates/portal.tx",
    document: template(),
  });
  assert.equal(saved.created, true);
  assert.match(saved.version, /^[a-f0-9]{64}$/u);
  const source = await fs.readFile(path.join(projectPath, "templates/portal.tx"), "utf8");
  assert.equal(source.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(source).object.futureObjectField, { keep: true });
  const files = await fs.readdir(path.join(projectPath, "templates"));
  assert.deepEqual(files, ["portal.tx"]);
});

test("refuses implicit overwrite and supports an explicit hash-checked update", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter();
  const created = await writer.saveTemplate({
    projectPath,
    resourceRoots: ["templates"],
    relativePath: "templates/portal.tx",
    document: template(),
  });
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["templates"],
      relativePath: "templates/portal.tx",
      document: template("Changed"),
    }),
    (error) => error.statusCode === 409 && error.code === "map-project-template-exists",
  );
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["templates"],
      relativePath: "templates/portal.tx",
      expectedVersion: "0".repeat(64),
      document: template("Changed"),
    }),
    (error) => error.statusCode === 409 && error.code === "map-project-template-version-conflict",
  );
  const updated = await writer.saveTemplate({
    projectPath,
    resourceRoots: ["templates"],
    relativePath: "templates/portal.tx",
    expectedVersion: created.version,
    document: template("Changed"),
  });
  assert.equal(updated.created, false);
  assert.notEqual(updated.version, created.version);
  assert.equal(JSON.parse(await fs.readFile(path.join(projectPath, "templates/portal.tx"), "utf8")).object.name, "Changed");
});

test("character saves distinguish an existing target from a stale version", async (t) => {
  const projectPath = await fixture(t);
  await fs.mkdir(path.join(projectPath, "characters"));
  const writer = new MapProjectResourceWriter();
  const document = {
    schema: "wfl.character-animation.v1",
    version: 1,
    name: "Hero",
    profile: "topdown-rpg",
    source: {
      path: "hero.png",
      imageWidth: 1,
      imageHeight: 1,
      frameWidth: 1,
      frameHeight: 1,
      columns: 1,
      rows: 1,
    },
    render: { anchor: { x: 0.5, y: 1 }, referenceHeight: 1 },
    clips: [{ id: "idle", name: "Idle", frames: [{ index: 0, durationMs: 120 }] }],
  };
  await fs.writeFile(path.join(projectPath, "characters/hero.character.json"), JSON.stringify(document));
  await assert.rejects(
    writer.saveCharacterAnimation({
      projectPath,
      resourceRoots: ["characters"],
      relativePath: "characters/hero.character.json",
      document,
    }),
    (error) => error.statusCode === 409 && error.code === "wfl-character-animation-exists",
  );
  await assert.rejects(
    writer.saveCharacterAnimation({
      projectPath,
      resourceRoots: ["characters"],
      relativePath: "characters/hero.character.json",
      expectedVersion: "0".repeat(64),
      document,
    }),
    (error) => error.statusCode === 409 && error.code === "wfl-character-animation-version-conflict",
  );
});

test("enforces folders, safe paths, parent existence and template instance rules", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter();
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["maps"],
      relativePath: "templates/portal.tx",
      document: template(),
    }),
    (error) => error.statusCode === 403 && error.code === "map-project-resource-outside-folders",
  );
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: [""],
      relativePath: "../portal.tx",
      document: template(),
    }),
    (error) => error.statusCode === 400 && error.code === "invalid-map-project-template-path",
  );
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: [""],
      relativePath: "missing/portal.tx",
      document: template(),
    }),
    (error) => error.statusCode === 404 && error.code === "map-project-template-directory-not-found",
  );
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["templates"],
      relativePath: "templates/portal.tx",
      document: template("Portal", { x: 1 }),
    }),
    (error) => error.statusCode === 422 && error.code === "invalid-tiled-template-instance-fields",
  );
});

test("rejects symlink parents and serializes concurrent no-overwrite creates", async (t) => {
  const projectPath = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(projectPath, "linked"));
  const writer = new MapProjectResourceWriter();
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: [""],
      relativePath: "linked/escape.tx",
      document: template(),
    }),
    (error) => error.statusCode === 403 && error.code === "map-project-resource-symlink",
  );
  const results = await Promise.allSettled([
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["templates"],
      relativePath: "templates/race.tx",
      document: template("One"),
    }),
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["templates"],
      relativePath: "templates/race.tx",
      document: template("Two"),
    }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(results.find((entry) => entry.status === "rejected").reason.code, "map-project-template-exists");
});

test("validates and atomically writes a composite TMJ through the same project writer", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const saved = await writer.saveCompositeMap({
    projectPath,
    resourceRoots: ["maps"],
    relativePath: "maps/village.composite.tmj",
    document: {
      type: "map",
      version: "1.10",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      width: 1,
      height: 1,
      tilewidth: 16,
      tileheight: 16,
      layers: [{ id: 1, name: "Village", type: "group", layers: [] }],
      tilesets: [],
    },
    validate: async ({ candidatePath, relativePath }) => {
      assert.match(candidatePath, /\.village\.composite\.tmj\.codex-map-resource-/u);
      assert.equal(relativePath, "maps/village.composite.tmj");
    },
  });
  assert.equal(saved.created, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(projectPath, "maps/village.composite.tmj"), "utf8")).layers[0].name, "Village");
});

test("direct template saves reject a missing file-property dependency before publish", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  await assert.rejects(
    writer.saveTemplate({
      projectPath,
      resourceRoots: ["templates"],
      relativePath: "templates/missing-image.tx",
      document: template("Missing", {
        properties: [{ name: "portrait", type: "file", value: "../images/missing.png" }],
      }),
    }),
    (error) => error.code === "map-resource-reference-missing",
  );
  assert.equal(await fs.access(path.join(projectPath, "templates/missing-image.tx")).then(() => true, () => false), false);
});

test("direct composite saves validate transitive TMJ -> TSJ -> image references", async (t) => {
  const projectPath = await fixture(t);
  await fs.mkdir(path.join(projectPath, "tiles"));
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const document = {
    type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
    tilewidth: 16, tileheight: 16,
    layers: [{ id: 1, type: "tilelayer", width: 1, height: 1, data: [1] }],
    tilesets: [{ firstgid: 1, source: "../tiles/missing.tsj" }],
  };
  await assert.rejects(
    writer.saveCompositeMap({
      projectPath,
      resourceRoots: ["maps", "tiles"],
      relativePath: "maps/missing-dependency.tmj",
      document,
    }),
    (error) => error.code === "map-resource-reference-missing",
  );
  assert.equal(await fs.access(path.join(projectPath, "maps/missing-dependency.tmj")).then(() => true, () => false), false);
});

test("direct composite saves preserve structured child-validator status codes", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  await assert.rejects(
    writer.saveCompositeMap({
      projectPath,
      resourceRoots: ["maps"],
      relativePath: "maps/child-invalid.tmj",
      document: {
        type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
        tilewidth: 16, tileheight: 16, layers: [], tilesets: [],
      },
      validate: async () => {
        throw Object.assign(new Error("Tiled 子进程拒绝文档"), { statusCode: 422, code: "MAP_TILED_VALIDATION_FAILED" });
      },
    }),
    (error) => error.statusCode === 422 && error.code === "MAP_TILED_VALIDATION_FAILED",
  );
  assert.equal(await fs.access(path.join(projectPath, "maps/child-invalid.tmj")).then(() => true, () => false), false);
});

test("commits a multi-file dependency transaction and rolls it back on validation failure", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const committed = await writer.saveTransaction({
    projectPath,
    resourceRoots: ["maps", "templates"],
    files: [
      { relativePath: "maps/village.tmj", content: '{"type":"map"}\n' },
      { relativePath: "templates/tree.tx", content: '{"type":"template","object":{"id":1}}\n' },
      { relativePath: "maps/tree.png", content: Buffer.from([137, 80, 78, 71]) },
    ],
  });
  assert.equal(committed.files.length, 3);
  assert.equal(await fs.readFile(path.join(projectPath, "maps", "village.tmj"), "utf8"), '{"type":"map"}\n');
  await assert.rejects(
    writer.saveTransaction({
      projectPath,
      resourceRoots: ["maps", "templates"],
      files: [
        { relativePath: "maps/village.tmj", expectedVersion: committed.files[0].version, content: "changed\n" },
        { relativePath: "templates/tree.tx", expectedVersion: committed.files[1].version, content: "changed\n" },
      ],
      validate: async () => { throw Object.assign(new Error("invalid dependency"), { statusCode: 422, code: "invalid-dependency" }); },
    }),
    (error) => error.code === "invalid-dependency",
  );
  assert.equal(await fs.readFile(path.join(projectPath, "maps", "village.tmj"), "utf8"), '{"type":"map"}\n');
  assert.equal(await fs.readFile(path.join(projectPath, "templates", "tree.tx"), "utf8"), '{"type":"template","object":{"id":1}}\n');
});

test("serializes single-resource saves behind a project transaction and rechecks authorization before publish", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  let enteredValidation;
  const validationEntered = new Promise((resolve) => { enteredValidation = resolve; });
  let releaseValidation;
  const validationReleased = new Promise((resolve) => { releaseValidation = resolve; });
  let validationCount = 0;
  const transactionPromise = writer.saveTransaction({
    projectPath,
    resourceRoots: ["maps"],
    files: [{ relativePath: "maps/transaction.tmj", content: "transaction\n" }],
    validate: async ({ phase }) => {
      validationCount += 1;
      if (!phase) {
        enteredValidation();
        await validationReleased;
      }
    },
  });
  await validationEntered;
  const singleSave = writer.saveTemplate({
    projectPath,
    resourceRoots: ["templates"],
    relativePath: "templates/concurrent.tx",
    document: template("Concurrent"),
  });
  const whileTransactionOpen = await Promise.race([
    singleSave.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 50)),
  ]);
  assert.equal(whileTransactionOpen, "still-waiting");
  releaseValidation();
  const [transaction, saved] = await Promise.all([transactionPromise, singleSave]);
  assert.equal(transaction.files[0].relativePath, "maps/transaction.tmj");
  assert.equal(saved.relativePath, "templates/concurrent.tx");
  assert.equal(validationCount, 2);
});

test("checks target versions again after the final authorization callback", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  let injected = false;
  await assert.rejects(
    writer.saveTransaction({
      projectPath,
      resourceRoots: ["maps"],
      files: [{ relativePath: "maps/final-boundary.tmj", content: "candidate\n" }],
      validate: async ({ phase }) => {
        if (phase === "before-publish" && !injected) {
          injected = true;
          await fs.writeFile(path.join(projectPath, "maps/final-boundary.tmj"), "external\n");
        }
      },
    }),
    (error) => error.code === "map-resource-transaction-exists",
  );
  assert.equal(await fs.readFile(path.join(projectPath, "maps/final-boundary.tmj"), "utf8"), "external\n");
});

test("shares the project lock across separately constructed writers", async (t) => {
  const projectPath = await fixture(t);
  const first = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const second = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  let entered;
  const wait = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstSave = first.saveTemplate({
    projectPath,
    resourceRoots: ["templates"],
    relativePath: "templates/shared-lock-a.tx",
    document: template("A"),
    validate: async () => { entered(); await gate; },
  });
  await wait;
  const secondSave = second.saveTemplate({
    projectPath,
    resourceRoots: ["templates"],
    relativePath: "templates/shared-lock-b.tx",
    document: template("B"),
  });
  assert.equal(await Promise.race([
    secondSave.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 50)),
  ]), "still-waiting");
  release();
  await Promise.all([firstSave, secondSave]);
});

test("validates a complete TMJ -> TSJ -> PNG dependency closure inside one transaction", async (t) => {
  const projectPath = await fixture(t);
  await fs.mkdir(path.join(projectPath, "tiles"));
  await fs.mkdir(path.join(projectPath, "images"));
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const map = {
    type: "map", version: "1.10", tiledversion: "1.12.2", orientation: "orthogonal",
    renderorder: "right-down", infinite: false, width: 1, height: 1, tilewidth: 16, tileheight: 16,
    layers: [{ id: 1, name: "Ground", type: "tilelayer", width: 1, height: 1, data: [1] }],
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
  };
  const tileset = {
    type: "tileset", version: "1.10", tiledversion: "1.12.2", name: "Terrain",
    tilewidth: 16, tileheight: 16, tilecount: 1, columns: 1, image: "../images/terrain.png",
    imagewidth: 16, imageheight: 16,
  };
  const committed = await writer.saveTransaction({
    projectPath,
    resourceRoots: [""],
    validateReferences: true,
    files: [
      { relativePath: "maps/world.tmj", content: JSON.stringify(map) },
      { relativePath: "tiles/terrain.tsj", content: JSON.stringify(tileset) },
      { relativePath: "images/terrain.png", content: VALID_PNG_16X16 },
    ],
  });
  assert.equal(committed.files.length, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(projectPath, "tiles/terrain.tsj"))).image, "../images/terrain.png");
});

test("rejects a missing transitive TSJ image before publishing any transaction file", async (t) => {
  const projectPath = await fixture(t);
  await fs.mkdir(path.join(projectPath, "tiles"));
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const mapSource = JSON.stringify({
    type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
    tilewidth: 16, tileheight: 16, layers: [{ id: 1, type: "tilelayer", width: 1, height: 1, data: [1] }],
    tilesets: [{ firstgid: 1, source: "../tiles/terrain.tsj" }],
  });
  const tsjSource = JSON.stringify({ type: "tileset", version: "1.10", name: "Terrain", tilewidth: 16, tileheight: 16, tilecount: 1, columns: 1, image: "terrain.png", imagewidth: 16, imageheight: 16 });
  await assert.rejects(
    writer.saveTransaction({
      projectPath,
      resourceRoots: [""],
      validateReferences: true,
      files: [
        { relativePath: "maps/world.tmj", content: mapSource },
        { relativePath: "tiles/terrain.tsj", content: tsjSource },
      ],
    }),
    (error) => error.code === "map-resource-reference-missing",
  );
  assert.equal(await fs.access(path.join(projectPath, "maps/world.tmj")).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(projectPath, "tiles/terrain.tsj")).then(() => true, () => false), false);
});

test("validates an unreferenced raster candidate before publishing a resource transaction", async (t) => {
  const projectPath = await fixture(t);
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  await assert.rejects(
    writer.saveTransaction({
      projectPath,
      resourceRoots: ["maps"],
      validateReferences: true,
      files: [{ relativePath: "maps/corrupt.png", content: Buffer.from("not-a-png") }],
    }),
    (error) => error.code === "map-resource-image-invalid",
  );
  assert.equal(await fs.access(path.join(projectPath, "maps/corrupt.png")).then(() => true, () => false), false);
});

test("validates image-collection tile dimensions in a direct resource transaction", async (t) => {
  const projectPath = await fixture(t);
  await fs.mkdir(path.join(projectPath, "tiles"));
  await fs.mkdir(path.join(projectPath, "images"));
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const tileset = {
    type: "tileset", version: "1.10", name: "Props", tilewidth: 16, tileheight: 16,
    tilecount: 1, tiles: [{ id: 0, image: "../images/grass.png", imagewidth: 8, imageheight: 16 }],
  };
  await assert.rejects(
    writer.saveTransaction({
      projectPath,
      resourceRoots: [""],
      validateReferences: true,
      files: [
        { relativePath: "tiles/props.tsj", content: JSON.stringify(tileset) },
        { relativePath: "images/grass.png", content: VALID_PNG_16X16 },
      ],
    }),
    (error) => error.code === "map-resource-tileset-image-invalid",
  );
  assert.equal(await fs.access(path.join(projectPath, "tiles/props.tsj")).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(projectPath, "images/grass.png")).then(() => true, () => false), false);
});

test("walks template and World references as part of the same closure", async (t) => {
  const projectPath = await fixture(t);
  await fs.mkdir(path.join(projectPath, "worlds"));
  await fs.mkdir(path.join(projectPath, "images"));
  const writer = new MapProjectResourceWriter({ maxBytes: 64 * 1024 });
  const map = JSON.stringify({
    type: "map", version: "1.10", orientation: "orthogonal", width: 1, height: 1,
    tilewidth: 16, tileheight: 16,
    layers: [{ id: 1, type: "objectgroup", objects: [{ id: 1, x: 0, y: 0, template: "../templates/tree.tx" }] }],
    tilesets: [],
  });
  const template = JSON.stringify({ type: "template", object: { id: 1, properties: [{ name: "portrait", type: "file", value: "../images/tree.png" }] } });
  const world = JSON.stringify({ type: "world", maps: [{ fileName: "../maps/world.tmj", x: 0, y: 0, width: 16, height: 16 }], patterns: [] });
  const result = await writer.saveTransaction({
    projectPath,
    resourceRoots: [""],
    validateReferences: true,
    files: [
      { relativePath: "maps/world.tmj", content: map },
      { relativePath: "templates/tree.tx", content: template },
      { relativePath: "worlds/game.world", content: world },
      { relativePath: "images/tree.png", content: VALID_PNG_1X1 },
    ],
  });
  assert.equal(result.files.length, 4);
});

test("streams a large candidate file into the project transaction without the inline 4 MiB limit", async (t) => {
  const projectPath = await fixture(t);
  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidate-"));
  t.after(() => fs.rm(candidateRoot, { recursive: true, force: true }));
  const candidatePath = path.join(candidateRoot, "large.png");
  const candidate = Buffer.alloc(5 * 1024 * 1024 + 17, 0x5a);
  await fs.writeFile(candidatePath, candidate);
  const writer = new MapProjectResourceWriter({
    maxBytes: 4 * 1024 * 1024,
    maxCandidateBytes: 16 * 1024 * 1024,
    candidateRoots: [candidateRoot],
  });
  const result = await writer.saveTransaction({
    projectPath,
    resourceRoots: ["maps"],
    files: [{
      relativePath: "maps/large.png",
      candidatePath,
      candidateSize: candidate.length,
      candidateSha256: sha256(candidate),
    }],
  });
  assert.equal(result.files[0].size, candidate.length);
  assert.deepEqual(await fs.readFile(path.join(projectPath, "maps/large.png")), candidate);
  assert.deepEqual(await fs.readFile(candidatePath), candidate);
});

test("rejects a candidate whose declared hash does not match without touching the target", async (t) => {
  const projectPath = await fixture(t);
  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-candidate-mutated-"));
  t.after(() => fs.rm(candidateRoot, { recursive: true, force: true }));
  const candidatePath = path.join(candidateRoot, "candidate.png");
  const original = Buffer.from("candidate-original\n");
  await fs.writeFile(candidatePath, original);
  const writer = new MapProjectResourceWriter({ candidateRoots: [candidateRoot] });
  await assert.rejects(
    writer.saveTransaction({
      projectPath,
      resourceRoots: ["maps"],
      files: [{
        relativePath: "maps/candidate.png",
        candidatePath,
        candidateSize: original.length,
        candidateSha256: sha256(Buffer.from("different\n")),
      }],
    }),
    (error) => error.code === "map-resource-transaction-candidate-conflict",
  );
  assert.equal(await fs.access(path.join(projectPath, "maps/candidate.png")).then(() => true, () => false), false);
});

test("recovers a backed-up transaction without EEXIST and preserves the old target", async (t) => {
  const { projectPath, targetPath, directory } = await interruptedJournal(t, { phase: "backed-up" });
  const result = await recoverMapProjectResourceTransactions({ projectPath });
  assert.deepEqual(result.failures, []);
  assert.equal(result.rolledBack, 1);
  assert.equal(await fs.readFile(targetPath, "utf8"), "before\n");
  assert.equal(await fs.access(directory).then(() => true, () => false), false);
});

test("recovers a staged transaction by removing its private candidate only", async (t) => {
  const { projectPath, targetPath, directory } = await interruptedJournal(t, {
    phase: "staged",
    backup: false,
  });
  const result = await recoverMapProjectResourceTransactions({ projectPath });
  assert.deepEqual(result.failures, []);
  assert.equal(await fs.readFile(targetPath, "utf8"), "before\n");
  assert.equal(await fs.access(directory).then(() => true, () => false), false);
});

test("recovers a partially published transaction by removing only its candidate", async (t) => {
  const { projectPath, targetPath, directory } = await interruptedJournal(t, {
    phase: "publishing",
    publish: true,
  });
  const result = await recoverMapProjectResourceTransactions({ projectPath });
  assert.deepEqual(result.failures, []);
  assert.equal(result.rolledBack, 1);
  assert.equal(await fs.readFile(targetPath, "utf8"), "before\n");
  assert.equal(await fs.access(directory).then(() => true, () => false), false);
});

test("finishes cleanup after a committed transaction whose journal was not removed", async (t) => {
  const { projectPath, targetPath, directory } = await interruptedJournal(t, {
    phase: "committed",
    publish: true,
  });
  const result = await recoverMapProjectResourceTransactions({ projectPath });
  assert.deepEqual(result.failures, []);
  assert.equal(result.completed, 1);
  assert.equal(await fs.readFile(targetPath, "utf8"), "after\n");
  assert.equal(await fs.access(directory).then(() => true, () => false), false);
});

test("leaves an externally replaced target and its journal for administrator review", async (t) => {
  const { projectPath, targetPath, directory } = await interruptedJournal(t, {
    phase: "publishing",
    publish: true,
  });
  await fs.writeFile(targetPath, "external\n");
  const result = await recoverMapProjectResourceTransactions({ projectPath });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, "map-resource-transaction-recovery-conflict");
  assert.equal(await fs.readFile(targetPath, "utf8"), "external\n");
  assert.equal(await fs.access(directory).then(() => true, () => false), true);
});

test("exposes only bounded relative recovery metadata to administrators", async (t) => {
  const { projectPath } = await interruptedJournal(t, { phase: "publishing", publish: true });
  const transactions = await inspectMapProjectResourceTransactions({ projectPath });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].entries[0].relativePath, "maps/village.tmj");
  assert.equal(Object.hasOwn(transactions[0].entries[0], "targetPath"), false);
  assert.equal(JSON.stringify(transactions).includes(projectPath), false);
});

test("active resource transactions are protected from administrator recovery", async (t) => {
  const { projectPath, targetPath, directory } = await interruptedJournal(t, { phase: "publishing", publish: true });
  const { beginMapProjectResourceTransaction } = await import("../lib/map-project-resource-write.mjs");
  const release = beginMapProjectResourceTransaction(directory);
  t.after(release);
  const listed = await inspectMapProjectResourceTransactions({ projectPath });
  assert.equal(listed[0].phase, "protected");
  const recovered = await recoverMapProjectResourceTransactions({ projectPath });
  assert.deepEqual(recovered, { recovered: 0, completed: 0, rolledBack: 0, failures: [] });
  assert.equal(await fs.access(targetPath).then(() => true, () => false), true);
  assert.equal(await fs.access(directory).then(() => true, () => false), true);
});
