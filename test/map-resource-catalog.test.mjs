import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  MapResourceCatalog,
  MapResourceCatalogError,
  AssetCatalogStore,
  grantMapResource,
  inspectMapResource,
  listMapResourceDirectory,
} from "../lib/map-resource-catalog.mjs";

async function withProject(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-resource-"));
  const projectPath = path.join(root, "project");
  try {
    await fs.mkdir(projectPath);
    await operation({ root, projectPath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function imageFixture(format = "png", width = 12, height = 8) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 0.75 } },
  })[format]().toBuffer();
}

test("lists supported resources and visible directories one level at a time with opaque pagination", async () => {
  await withProject(async ({ root, projectPath }) => {
    await fs.mkdir(path.join(projectPath, "assets"));
    await fs.mkdir(path.join(projectPath, ".git"));
    await fs.mkdir(path.join(projectPath, ".codex-private"));
    await fs.writeFile(path.join(projectPath, "ground.png"), await imageFixture());
    await fs.writeFile(path.join(projectPath, "terrain.tsj"), '{"type":"tileset"}\n');
    await fs.writeFile(path.join(projectPath, "notes.txt"), "private notes");
    await fs.writeFile(path.join(root, "outside.png"), await imageFixture());
    await fs.symlink(path.join(root, "outside.png"), path.join(projectPath, "linked.png"));
    await fs.symlink(path.join(root, "outside"), path.join(projectPath, "linked-directory"));

    const first = await listMapResourceDirectory({ projectPath, limit: 2 });
    assert.equal(first.directory, "");
    assert.deepEqual(first.entries.map(({ name, kind }) => [name, kind]), [
      ["assets", "directory"],
      ["ground.png", "image"],
    ]);
    assert.ok(first.nextCursor);
    const second = await listMapResourceDirectory({ projectPath, limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.entries.map(({ name, kind }) => [name, kind]), [["terrain.tsj", "tileset"]]);
    assert.equal(second.nextCursor, null);
    for (const entry of [...first.entries, ...second.entries]) {
      assert.equal(path.isAbsolute(entry.path), false);
      assert.ok(Object.hasOwn(entry, "size"));
      assert.equal(typeof entry.mtime, "number");
    }
    assert.equal(first.entries[0].size, null);
  });
});

test("lists only the requested directory and binds cursors to that directory", async () => {
  await withProject(async ({ projectPath }) => {
    await fs.mkdir(path.join(projectPath, "assets", "nested"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "ground.png"), await imageFixture());
    await fs.writeFile(path.join(projectPath, "assets", "tree.webp"), await imageFixture("webp"));
    await fs.writeFile(path.join(projectPath, "assets", "nested", "deep.png"), await imageFixture());
    const rootPage = await listMapResourceDirectory({ projectPath, limit: 1 });
    const nestedPage = await listMapResourceDirectory({ projectPath, directory: "assets" });
    assert.deepEqual(nestedPage.entries.map((entry) => entry.path), ["assets/nested", "assets/tree.webp"]);
    await assert.rejects(
      listMapResourceDirectory({ projectPath, directory: "assets", cursor: rootPage.nextCursor }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-resource-cursor",
    );
  });
});

test("inspects and grants decoded image metadata without exposing an absolute path", async () => {
  await withProject(async ({ projectPath }) => {
    await fs.mkdir(path.join(projectPath, "images"));
    const buffer = await imageFixture("jpeg", 37, 23);
    await fs.writeFile(path.join(projectPath, "images", "plant.jpg"), buffer);
    const catalog = new MapResourceCatalog();
    const inspected = await catalog.inspect({ projectPath, resourcePath: "images/plant.jpg" });
    assert.deepEqual(inspected, {
      path: "images/plant.jpg",
      name: "plant.jpg",
      kind: "image",
      size: buffer.length,
      mtime: inspected.mtime,
      format: "jpeg",
      mediaType: "image/jpeg",
      width: 37,
      height: 23,
    });
    assert.equal(typeof inspected.mtime, "number");
    assert.equal(JSON.stringify(inspected).includes(projectPath), false);
    assert.deepEqual(await catalog.grant({
      projectPath,
      resourcePath: "images/plant.jpg",
      expectedKind: "image",
    }), inspected);
    await assert.rejects(
      catalog.grant({ projectPath, resourcePath: "images/plant.jpg", expectedKind: "tileset" }),
      (error) => error.statusCode === 415 && error.code === "map-resource-kind-mismatch",
    );
  });
});

test("validates Tiled tilesets as bounded UTF-8 type=tileset JSON", async () => {
  await withProject(async ({ projectPath }) => {
    await fs.writeFile(path.join(projectPath, "valid.tsj"), '\uFEFF{"type":"tileset","name":"terrain"}\n');
    await fs.writeFile(path.join(projectPath, "map.tsj"), '{"type":"map"}\n');
    await fs.writeFile(path.join(projectPath, "broken.tsj"), "{broken");
    await fs.writeFile(path.join(projectPath, "binary.tsj"), Buffer.from([0xff, 0xfe]));
    const valid = await inspectMapResource({ projectPath, resourcePath: "valid.tsj" });
    assert.equal(valid.kind, "tileset");
    assert.equal(valid.tiledType, "tileset");
    await assert.rejects(
      inspectMapResource({ projectPath, resourcePath: "map.tsj" }),
      (error) => error.code === "invalid-map-tileset",
    );
    await assert.rejects(
      inspectMapResource({ projectPath, resourcePath: "broken.tsj" }),
      (error) => error.code === "invalid-map-tileset-json",
    );
    await assert.rejects(
      inspectMapResource({ projectPath, resourcePath: "binary.tsj" }),
      (error) => error.code === "invalid-map-tileset-utf8",
    );
  });
});

test("tileset inspection resolves and validates top-level and per-tile image dependencies", async () => {
  await withProject(async ({ projectPath }) => {
    await fs.mkdir(path.join(projectPath, "tilesets", "nested"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "images"));
    const sheet = await imageFixture("png", 32, 16);
    const tree = await imageFixture("webp", 13, 21);
    await fs.writeFile(path.join(projectPath, "images", "terrain.png"), sheet);
    await fs.writeFile(path.join(projectPath, "images", "tree.webp"), tree);
    await fs.writeFile(path.join(projectPath, "tilesets", "nested", "world.tsj"), JSON.stringify({
      type: "tileset",
      name: "World",
      image: "../../images/terrain.png",
      tiles: [
        { id: 1, image: "../../images/tree.webp" },
        { id: 2, image: "../../images/tree.webp" },
        { id: 3, type: "unknown-without-image" },
      ],
    }));

    const resource = await inspectMapResource({
      projectPath,
      resourcePath: "tilesets/nested/world.tsj",
    });
    assert.deepEqual(resource.dependencies.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      format: entry.format,
      width: entry.width,
      height: entry.height,
    })), [
      { path: "images/terrain.png", kind: "image", format: "png", width: 32, height: 16 },
      { path: "images/tree.webp", kind: "image", format: "webp", width: 13, height: 21 },
    ]);
    assert.equal(JSON.stringify(resource).includes(projectPath), false);
  });
});

test("tileset dependencies reject URLs, data images, project escape, symlinks, and invalid images", async () => {
  await withProject(async ({ root, projectPath }) => {
    await fs.mkdir(path.join(projectPath, "tilesets"));
    await fs.mkdir(path.join(projectPath, "images"));
    await fs.writeFile(path.join(projectPath, "images", "invalid.png"), "not an image");
    await fs.writeFile(path.join(root, "outside.png"), await imageFixture());
    await fs.symlink(path.join(root, "outside.png"), path.join(projectPath, "images", "linked.png"));
    const cases = [
      ["url.tsj", "https://example.test/tile.png", "invalid-map-tileset-image-reference"],
      ["data.tsj", "data:image/png;base64,AAAA", "invalid-map-tileset-image-reference"],
      ["escape.tsj", "../../outside.png", "invalid-map-tileset-image-reference"],
      ["linked.tsj", "../images/linked.png", "map-resource-symlink"],
      ["invalid.tsj", "../images/invalid.png", "invalid-map-image"],
    ];
    for (const [name, image, code] of cases) {
      await fs.writeFile(path.join(projectPath, "tilesets", name), JSON.stringify({
        type: "tileset",
        image,
      }));
      await assert.rejects(
        inspectMapResource({ projectPath, resourcePath: `tilesets/${name}` }),
        (error) => error.code === code,
        name,
      );
    }
  });
});

test("rejects traversal, absolute paths, URLs, hidden paths, and symbolic links", async () => {
  await withProject(async ({ root, projectPath }) => {
    await fs.mkdir(path.join(projectPath, ".git"));
    await fs.mkdir(path.join(projectPath, "assets"));
    await fs.writeFile(path.join(projectPath, ".git", "secret.png"), await imageFixture());
    await fs.writeFile(path.join(root, "outside.png"), await imageFixture());
    await fs.symlink(path.join(root, "outside.png"), path.join(projectPath, "assets", "linked.png"));
    await fs.symlink(root, path.join(projectPath, "linked-dir"));
    for (const resourcePath of ["../outside.png", "/etc/passwd", "https://example.test/a.png", "C:/a.png"] ) {
      await assert.rejects(
        grantMapResource({ projectPath, resourcePath }),
        (error) => error instanceof MapResourceCatalogError
          && error.statusCode === 400
          && error.code === "invalid-map-resource-path",
      );
    }
    await assert.rejects(
      grantMapResource({ projectPath, resourcePath: ".git/secret.png" }),
      (error) => error.statusCode === 403 && error.code === "map-resource-hidden",
    );
    await assert.rejects(
      grantMapResource({ projectPath, resourcePath: "assets/linked.png" }),
      (error) => error.statusCode === 403 && error.code === "map-resource-symlink",
    );
    await assert.rejects(
      listMapResourceDirectory({ projectPath, directory: "linked-dir" }),
      (error) => error.statusCode === 403 && error.code === "map-resource-symlink",
    );
  });
});

test("enforces byte limits and rejects invalid or extension-disguised images", async () => {
  await withProject(async ({ projectPath }) => {
    const png = await imageFixture("png", 9, 7);
    await fs.writeFile(path.join(projectPath, "oversized.png"), png);
    await fs.writeFile(path.join(projectPath, "fake.png"), "not an image");
    await fs.writeFile(path.join(projectPath, "wrong.png"), await imageFixture("jpeg"));
    const limited = new MapResourceCatalog({ maxImageBytes: png.length - 1 });
    await assert.rejects(
      limited.inspect({ projectPath, resourcePath: "oversized.png" }),
      (error) => error.statusCode === 413 && error.code === "map-resource-size-limit",
    );
    for (const resourcePath of ["fake.png", "wrong.png"]) {
      await assert.rejects(
        inspectMapResource({ projectPath, resourcePath }),
        (error) => error.statusCode === 415 && error.code === "invalid-map-image",
      );
    }
    await assert.rejects(
      inspectMapResource({ projectPath, resourcePath: "readme.txt" }),
      (error) => error.statusCode === 415 && error.code === "map-resource-unsupported",
    );
  });
});

test("asset catalog indexes content hashes, invalidates on change, and keeps tags bounded", async () => {
  await withProject(async ({ projectPath }) => {
    const filePath = path.join(projectPath, "plant.png");
    const first = await imageFixture("png", 10, 6);
    await fs.writeFile(filePath, first);
    const store = new AssetCatalogStore({ maxEntries: 2 });
    assert.throws(
      () => store.setTags({ projectPath, resourcePath: "plant.png", tags: ["prop"] }),
      (error) => error.code === "map-resource-not-indexed",
    );
    const initial = await store.inspect({ projectPath, resourcePath: "plant.png" });
    assert.equal(initial.sha256, crypto.createHash("sha256").update(first).digest("hex"));
    assert.deepEqual(initial.tags, []);
    store.setTags({ projectPath, resourcePath: "plant.png", tags: ["prop", "nature", "prop"] });
    assert.deepEqual(store.getTags({ projectPath, resourcePath: "plant.png" }), ["prop", "nature"]);
    const cached = await store.inspect({ projectPath, resourcePath: "plant.png" });
    assert.deepEqual(cached.tags, ["prop", "nature"]);

    const second = await imageFixture("png", 11, 6);
    await fs.writeFile(filePath, second);
    const changed = await store.inspect({ projectPath, resourcePath: "plant.png" });
    assert.notEqual(changed.sha256, initial.sha256);
    assert.deepEqual(changed.tags, ["prop", "nature"]);
    assert.throws(
      () => store.setTags({ projectPath, resourcePath: "plant.png", tags: ["bad tag"] }),
      (error) => error.code === "invalid-map-resource-tags",
    );

    await fs.writeFile(path.join(projectPath, "stone.png"), await imageFixture("png", 7, 7));
    await fs.writeFile(path.join(projectPath, "water.png"), await imageFixture("png", 8, 8));
    await store.inspect({ projectPath, resourcePath: "stone.png" });
    await store.inspect({ projectPath, resourcePath: "water.png" });
    assert.deepEqual(store.getTags({ projectPath, resourcePath: "plant.png" }), []);
  });
});

test("asset hash cache invalidates a rewrite that preserves size and mtime", async () => {
  await withProject(async ({ projectPath }) => {
    const filePath = path.join(projectPath, "same-shape.png");
    const first = await imageFixture("png", 10, 6);
    await fs.writeFile(filePath, first);
    const store = new AssetCatalogStore();
    const initial = await store.inspect({ projectPath, resourcePath: "same-shape.png" });
    const originalStat = await fs.stat(filePath);
    let second = null;
    for (let red = 1; red < 256 && !second; red += 1) {
      const candidate = await sharp({
        create: { width: 10, height: 6, channels: 4, background: { r: red, g: 30, b: 40, alpha: 0.75 } },
      }).png().toBuffer();
      if (candidate.length === first.length && !candidate.equals(first)) second = candidate;
    }
    assert.ok(second, "expected a same-size image with different content");
    await fs.writeFile(filePath, second);
    await fs.utimes(filePath, originalStat.atime, originalStat.mtime);
    const changed = await store.inspect({ projectPath, resourcePath: "same-shape.png" });
    assert.notEqual(changed.sha256, initial.sha256);
    assert.equal(JSON.stringify(changed).includes("_cacheIdentity"), false);
    assert.equal(JSON.stringify(changed).includes(projectPath), false);
  });
});
