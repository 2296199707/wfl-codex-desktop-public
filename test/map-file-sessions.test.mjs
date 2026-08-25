import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapFileSessionStore } from "../lib/map-file-sessions.mjs";

const identity = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-session-1",
  editorInstanceId: "editor-window-0001",
});

async function withMapFile(content, operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-session-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "maps", "world.tmj");
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content);
    await operation({ projectPath, targetPath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("reads a UTF-8 map in stable content-versioned chunks", async () => {
  const content = `${JSON.stringify({
    type: "map",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [],
    tilesets: [],
    note: "地图🙂".repeat(40),
  })}\n`;
  await withMapFile(content, async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 37 });
    const opened = await store.open({ identity, projectPath, targetPath, writable: true });
    assert.match(opened.version, /^[a-f0-9]{64}$/u);
    assert.equal(opened.relativePath, "maps/world.tmj");
    assert.equal(opened.writable, true);
    assert.equal(opened.config.chunkBytes, 37);

    let reconstructed = opened.firstChunk.content;
    let offset = opened.firstChunk.nextOffset;
    while (offset < opened.size) {
      const chunk = await store.read({
        sessionId: opened.id,
        identity,
        version: opened.version,
        offset,
      });
      reconstructed += chunk.content;
      offset = chunk.nextOffset;
    }
    assert.equal(reconstructed, content);
  });
});

test("binds Tiled project source to the map window after the project workspace closes", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const projectFilePath = path.join(projectPath, "game.tiled-project");
    const templatePath = path.join(projectPath, "templates", "portal.tx");
    const projectSource = `${JSON.stringify({
      folders: ["maps"],
      propertyTypes: [{ name: "Biome", type: "enum", values: ["forest", "desert"] }],
    })}\n`;
    await fs.writeFile(projectFilePath, projectSource);
    await fs.mkdir(path.dirname(templatePath), { recursive: true });
    await fs.writeFile(templatePath, `${JSON.stringify({ type: "template", object: { id: 1, name: "Portal" } })}\n`);
    const store = new MapFileSessionStore({ chunkBytes: 64 });
    const opened = await store.open({
      identity,
      projectPath,
      targetPath,
      projectFilePath,
      projectResourceRoots: ["maps", "templates"],
    });
    assert.equal(opened.projectFile, "game.tiled-project");
    assert.equal(JSON.stringify(opened).includes(projectPath), false);

    const source = await store.readProjectSource({ sessionId: opened.id, identity });
    assert.equal(source.relativePath, "game.tiled-project");
    assert.equal(source.content, projectSource);
    assert.equal(source.size, Buffer.byteLength(projectSource));
    assert.match(source.version, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(source).includes(projectPath), false);
    const template = await store.readProjectResource({
      sessionId: opened.id,
      identity,
      resourcePath: "templates/portal.tx",
    });
    assert.equal(JSON.parse(template.content).type, "template");
    await assert.rejects(
      store.readProjectResource({ sessionId: opened.id, identity, resourcePath: "private/hidden.tx" }),
      (error) => error.statusCode === 403 && error.code === "map-project-resource-outside-folders",
    );

    assert.throws(
      () => store.context({
        sessionId: opened.id,
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
      }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
    await assert.rejects(
      store.readProjectSource({
        sessionId: opened.id,
        identity: { ...identity, browserSessionId: "browser-session-2" },
      }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
  });
});

test("returns an explicit empty project source for temporary map sessions", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore();
    const opened = await store.open({ identity, projectPath, targetPath });
    assert.equal(opened.projectFile, null);
    assert.deepEqual(
      await store.readProjectSource({ sessionId: opened.id, identity }),
      {
        relativePath: null,
        size: 0,
        modifiedAt: null,
        version: null,
        content: null,
      },
    );
  });
});

test("rejects unsafe or oversized Tiled project sources before opening a map window", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const root = path.dirname(projectPath);
    const outside = path.join(root, "outside.tiled-project");
    await fs.writeFile(outside, "{}\n");
    const store = new MapFileSessionStore({ maxProjectBytes: 32 });
    await assert.rejects(
      store.open({ identity, projectPath, targetPath, projectFilePath: outside }),
      (error) => error.statusCode === 403 && error.code === "map-project-file-outside-project",
    );

    const oversized = path.join(projectPath, "oversized.tiled-project");
    await fs.writeFile(oversized, JSON.stringify({ note: "x".repeat(64) }));
    await assert.rejects(
      store.open({ identity, projectPath, targetPath, projectFilePath: oversized }),
      (error) => error.statusCode === 413 && error.code === "map-project-file-size-limit",
    );

    const linked = path.join(projectPath, "linked.tiled-project");
    await fs.symlink(outside, linked);
    await assert.rejects(
      store.open({ identity, projectPath, targetPath, projectFilePath: linked }),
      (error) => error.statusCode === 403 && error.code === "map-project-file-symlink",
    );

    const invalidUtf8 = path.join(projectPath, "invalid.tiled-project");
    await fs.writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
    await assert.rejects(
      store.open({ identity, projectPath, targetPath, projectFilePath: invalidUtf8 }),
      (error) => error.statusCode === 415 && error.code === "invalid-map-project-utf8",
    );
  });
});

test("opens an external TSJ in an isolated tileset document session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-tileset-session-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "tiles", "terrain.tsj");
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = `${JSON.stringify({
      type: "tileset",
      name: "Terrain",
      tilewidth: 16,
      tileheight: 16,
      columns: 0,
      tilecount: 0,
      tiles: [],
    })}\n`;
    await fs.writeFile(targetPath, content);
    const store = new MapFileSessionStore({ documentKind: "tileset", chunkBytes: 64 });
    const opened = await store.open({ identity, projectPath, targetPath, writable: true });
    assert.equal(opened.documentKind, "tileset");
    assert.equal(opened.relativePath, "tiles/terrain.tsj");
    let reconstructed = opened.firstChunk.content;
    let offset = opened.firstChunk.nextOffset;
    while (offset < opened.size) {
      const chunk = await store.read({
        sessionId: opened.id,
        identity,
        version: opened.version,
        offset,
      });
      reconstructed += chunk.content;
      offset = chunk.nextOffset;
    }
    assert.equal(reconstructed, content);
    await assert.rejects(
      store.open({
        identity: { ...identity, editorInstanceId: "tileset-wrong-extension" },
        projectPath,
        targetPath: path.join(projectPath, "tiles", "terrain.tmj"),
      }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-path",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("streams a multi-megabyte UTF-8 map beyond the ordinary file preview limit", async () => {
  const content = `${JSON.stringify({
    type: "map",
    width: 1,
    height: 1,
    tilewidth: 16,
    tileheight: 16,
    layers: [],
    tilesets: [],
    note: "地图🙂".repeat(500_000),
  })}\n`;
  assert.ok(Buffer.byteLength(content) > 4 * 1024 * 1024);
  await withMapFile(content, async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 64 * 1024 });
    const opened = await store.open({
      identity,
      projectPath,
      targetPath,
      config: { chunkBytes: 64 * 1024, maxBytes: 16 * 1024 * 1024 },
    });
    const hash = crypto.createHash("sha256");
    hash.update(opened.firstChunk.content);
    let offset = opened.firstChunk.nextOffset;
    let chunks = 1;
    while (offset < opened.size) {
      const chunk = await store.read({ sessionId: opened.id, identity, version: opened.version, offset });
      assert.ok(Buffer.byteLength(chunk.content) <= 64 * 1024);
      hash.update(chunk.content);
      offset = chunk.nextOffset;
      chunks += 1;
    }
    assert.ok(chunks > 64);
    assert.equal(hash.digest("hex"), opened.version);
  });
});

test("binds sessions to the browser and editor window", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 64 });
    const opened = await store.open({ identity, projectPath, targetPath });
    assert.throws(
      () => store.snapshot({
        sessionId: opened.id,
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
      }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
    assert.throws(
      () => store.snapshot({
        sessionId: opened.id,
        identity: { ...identity, userId: "user-2" },
      }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
    assert.throws(
      () => store.snapshot({
        sessionId: opened.id,
        identity: { ...identity, browserSessionId: "browser-session-2" },
      }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
  });
});

test("logout closes only map sessions owned by the exact user and browser login", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ maxSessions: 8, maxSessionsPerBrowser: 8 });
    const ownFirst = await store.open({ identity, projectPath, targetPath });
    const ownSecondIdentity = { ...identity, editorInstanceId: "editor-window-0002" };
    const ownSecond = await store.open({ identity: ownSecondIdentity, projectPath, targetPath });
    const otherBrowserIdentity = {
      ...identity,
      browserSessionId: "browser-session-2",
      editorInstanceId: "editor-window-0003",
    };
    const otherBrowser = await store.open({ identity: otherBrowserIdentity, projectPath, targetPath });
    const otherUserIdentity = {
      ...identity,
      userId: "user-2",
      editorInstanceId: "editor-window-0004",
    };
    const otherUser = await store.open({ identity: otherUserIdentity, projectPath, targetPath });

    assert.deepEqual(store.closeForBrowserSession(identity), { closed: 2 });
    for (const [session, sessionIdentity] of [[ownFirst, identity], [ownSecond, ownSecondIdentity]]) {
      assert.throws(
        () => store.snapshot({ sessionId: session.id, identity: sessionIdentity }),
        (error) => error.code === "map-session-not-found",
      );
    }
    assert.equal(store.snapshot({ sessionId: otherBrowser.id, identity: otherBrowserIdentity }).id, otherBrowser.id);
    assert.equal(store.snapshot({ sessionId: otherUser.id, identity: otherUserIdentity }).id, otherUser.id);
  });
});

test("revoking an account closes its map sessions across every browser login", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ maxSessions: 8, maxSessionsPerBrowser: 8 });
    const first = await store.open({ identity, projectPath, targetPath });
    const secondIdentity = {
      ...identity,
      browserSessionId: "browser-session-2",
      editorInstanceId: "editor-window-0002",
    };
    const second = await store.open({ identity: secondIdentity, projectPath, targetPath });
    const survivorIdentity = { ...identity, userId: "user-2", editorInstanceId: "editor-window-0003" };
    const survivor = await store.open({ identity: survivorIdentity, projectPath, targetPath });

    assert.deepEqual(store.closeForUser({ userId: identity.userId }), { closed: 2 });
    for (const [session, sessionIdentity] of [[first, identity], [second, secondIdentity]]) {
      assert.throws(
        () => store.snapshot({ sessionId: session.id, identity: sessionIdentity }),
        (error) => error.code === "map-session-not-found",
      );
    }
    assert.equal(store.snapshot({ sessionId: survivor.id, identity: survivorIdentity }).id, survivor.id);
  });
});

test("authorizes only resources in the version-bound Tiled reference manifest", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 64 });
    const opened = await store.open({ identity, projectPath, targetPath });
    assert.equal(store.setResources({
      sessionId: opened.id,
      identity,
      version: opened.version,
      resourcePaths: ["tiles/world.tsj", "images/terrain.png"],
    }), 2);
    assert.equal(store.authorizeResource({
      sessionId: opened.id,
      identity,
      resourcePath: "images/terrain.png",
    }), "images/terrain.png");
    assert.throws(
      () => store.authorizeResource({
        sessionId: opened.id,
        identity,
        resourcePath: "images/private.png",
      }),
      (error) => error.statusCode === 403 && error.code === "map-resource-not-referenced",
    );
    assert.throws(
      () => store.setResources({
        sessionId: opened.id,
        identity,
        version: "0".repeat(64),
        resourcePaths: [],
      }),
      (error) => error.statusCode === 409 && error.code === "map-version-conflict",
    );
  });
});

test("grants validated resources only to the matching writable version-bound window", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 64 });
    const writableIdentity = { ...identity, editorInstanceId: "editor-grant-window" };
    const opened = await store.open({
      identity: writableIdentity,
      projectPath,
      targetPath,
      writable: true,
    });
    const granted = store.grantResources({
      sessionId: opened.id,
      identity: writableIdentity,
      version: opened.version,
      resourcePaths: ["images/tree.png", "images/tree.png"],
    });
    assert.deepEqual(granted.granted, ["images/tree.png"]);
    assert.equal(granted.resourceCount, 1);
    assert.equal(store.authorizeResource({
      sessionId: opened.id,
      identity: writableIdentity,
      resourcePath: "images/tree.png",
    }), "images/tree.png");
    assert.throws(
      () => store.grantResources({
        sessionId: opened.id,
        identity: { ...writableIdentity, editorInstanceId: "editor-other-window" },
        version: opened.version,
        resourcePaths: ["images/rock.png"],
      }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
    assert.throws(
      () => store.grantResources({
        sessionId: opened.id,
        identity: writableIdentity,
        version: "stale",
        resourcePaths: ["images/rock.png"],
      }),
      (error) => error.statusCode === 409 && error.code === "map-version-conflict",
    );

    const readOnlyIdentity = { ...identity, editorInstanceId: "editor-read-only-window" };
    const readOnly = await store.open({
      identity: readOnlyIdentity,
      projectPath,
      targetPath,
      writable: false,
    });
    assert.throws(
      () => store.grantResources({
        sessionId: readOnly.id,
        identity: readOnlyIdentity,
        version: readOnly.version,
        resourcePaths: ["images/tree.png"],
      }),
      (error) => error.statusCode === 403 && error.code === "map-session-read-only",
    );
  });
});

test("grants a controlled tileset dependency batch beyond the legacy 64-resource ceiling", async () => {
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 64, maxGrantResources: 128 });
    const opened = await store.open({ identity, projectPath, targetPath, writable: true });
    const resourcePaths = Array.from({ length: 65 }, (_, index) => `tilesets/images/tile-${index}.png`);
    const granted = store.grantResources({
      sessionId: opened.id,
      identity,
      version: opened.version,
      resourcePaths,
    });
    assert.equal(granted.granted.length, 65);
    assert.equal(granted.resourceCount, 65);
    assert.equal(store.authorizeResource({
      sessionId: opened.id,
      identity,
      resourcePath: resourcePaths.at(-1),
    }), resourcePaths.at(-1));

    const limited = new MapFileSessionStore({ maxGrantResources: 2 });
    const limitedSession = await limited.open({ identity, projectPath, targetPath, writable: true });
    assert.throws(
      () => limited.grantResources({
        sessionId: limitedSession.id,
        identity,
        version: limitedSession.version,
        resourcePaths: ["tilesets/a.png", "tilesets/b.png", "tilesets/c.png"],
      }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-resource-grant",
    );
  });
});

test("returns a conflict when the map changes after opening", async () => {
  await withMapFile('{"type":"map","value":1}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 8 });
    const opened = await store.open({ identity, projectPath, targetPath });
    await fs.writeFile(targetPath, '{"type":"map","value":2}\n');
    await assert.rejects(
      store.read({
        sessionId: opened.id,
        identity,
        version: opened.version,
        offset: opened.firstChunk.nextOffset,
      }),
      (error) => error.statusCode === 409 && error.code === "map-file-changed",
    );
  });
});

test("refreshes the owning read session after a committed save", async () => {
  await withMapFile('{"type":"map","value":1}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 8 });
    const opened = await store.open({ identity, projectPath, targetPath, writable: true });
    await fs.writeFile(targetPath, '{"type":"map","value":2}\n');
    const refreshed = await store.refresh({ sessionId: opened.id, identity });
    assert.notEqual(refreshed.version, opened.version);
    assert.equal(refreshed.size, Buffer.byteLength('{"type":"map","value":2}\n'));
    assert.equal(store.context({ sessionId: opened.id, identity }).version, refreshed.version);
  });
});

test("uses fixed capacity and expiry settings without adapting them", async () => {
  let now = 1_000;
  await withMapFile('{"type":"map"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({
      chunkBytes: 64,
      ttlMs: 100,
      maxSessions: 1,
      maxSessionsPerBrowser: 1,
      now: () => now,
    });
    const opened = await store.open({ identity, projectPath, targetPath });
    await assert.rejects(
      store.open({
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
        projectPath,
        targetPath,
      }),
      (error) => error.statusCode === 429 && error.code === "map-session-capacity",
    );
    now = 1_101;
    assert.throws(
      () => store.snapshot({ sessionId: opened.id, identity }),
      (error) => error.statusCode === 404 && error.code === "map-session-not-found",
    );
    const reopened = await store.open({ identity, projectPath, targetPath });
    assert.equal(reopened.config.chunkBytes, 64);
  });
});

test("reserves capacity before concurrent file inspection", async () => {
  await withMapFile(`{"type":"map","note":"${"x".repeat(2 * 1024 * 1024)}"}\n`, async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ maxSessions: 1, maxSessionsPerBrowser: 1 });
    const attempts = await Promise.allSettled([
      store.open({ identity, projectPath, targetPath }),
      store.open({
        identity: { ...identity, editorInstanceId: "editor-window-0002" },
        projectPath,
        targetPath,
      }),
    ]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    assert.equal(rejected.reason.statusCode, 429);
    assert.equal(store.sessions.size, 1);
  });
});

test("rejects an oversized map before creating a read session and on refresh", async () => {
  await withMapFile('{"type":"map","value":1}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore();
    await assert.rejects(
      store.open({ identity, projectPath, targetPath, config: { maxBytes: 8 } }),
      (error) => error.statusCode === 413 && error.code === "map-file-size-limit",
    );
    assert.equal(store.sessions.size, 0);

    const opened = await store.open({ identity, projectPath, targetPath, config: { maxBytes: 64 } });
    await fs.writeFile(targetPath, `{"type":"map","note":"${"y".repeat(80)}"}\n`);
    await assert.rejects(
      store.refresh({ sessionId: opened.id, identity }),
      (error) => error.statusCode === 413 && error.code === "map-file-size-limit",
    );
  });
});

test("snapshots manual map I/O settings for each newly opened session", async () => {
  await withMapFile('{"type":"map","note":"abcdefghijklmnopqrstuvwxyz"}\n', async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore({ chunkBytes: 64 });
    const first = await store.open({
      identity,
      projectPath,
      targetPath,
      config: { chunkBytes: 11, maxBytes: 1_024, autoSaveIntervalMs: 45_000 },
    });
    const second = await store.open({
      identity: { ...identity, editorInstanceId: "editor-window-0002" },
      projectPath,
      targetPath,
      config: { chunkBytes: 19, maxBytes: 2_048, autoSaveIntervalMs: 0 },
    });
    assert.deepEqual(
      { ...first.config, ttlMs: undefined },
      { chunkBytes: 11, maxBytes: 1_024, autoSaveIntervalMs: 45_000, ttlMs: undefined },
    );
    assert.equal(first.firstChunk.nextOffset, 11);
    assert.equal(second.config.chunkBytes, 19);
    assert.equal(second.config.autoSaveIntervalMs, 0);
    assert.equal(second.firstChunk.nextOffset, 19);
    await assert.rejects(
      store.open({
        identity: { ...identity, editorInstanceId: "editor-window-0003" },
        projectPath,
        targetPath,
        config: { chunkBytes: 16, maxBytes: 8, autoSaveIntervalMs: 60_000 },
      }),
      (error) => error.statusCode === 413 && error.code === "map-file-size-limit",
    );
  });
});

test("rejects invalid UTF-8 and non-map extensions", async () => {
  await withMapFile(Buffer.from([0xc3, 0x28]), async ({ projectPath, targetPath }) => {
    const store = new MapFileSessionStore();
    await assert.rejects(
      store.open({ identity, projectPath, targetPath }),
      (error) => error.statusCode === 415 && error.code === "invalid-map-utf8",
    );
    await assert.rejects(
      store.open({ identity, projectPath, targetPath: path.join(projectPath, "map.json") }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-path",
    );
  });
});

test("opens World documents only through an explicitly isolated World store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-world-session-"));
  const projectPath = path.join(root, "project");
  const targetPath = path.join(projectPath, "worlds", "game.world");
  const content = `${JSON.stringify({ type: "world", maps: [], patterns: [] })}\n`;
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content);
    const mapStore = new MapFileSessionStore();
    await assert.rejects(
      mapStore.open({ identity, projectPath, targetPath }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-path",
    );
    const worldStore = new MapFileSessionStore({ documentKind: "world", fileExtensions: [".world"] });
    const opened = await worldStore.open({ identity, projectPath, targetPath, writable: true });
    assert.equal(opened.documentKind, "world");
    assert.equal(opened.firstChunk.content, content);
    assert.equal(worldStore.context({ sessionId: opened.id, identity }).documentKind, "world");
    await assert.rejects(
      worldStore.open({ identity, projectPath, targetPath: path.join(projectPath, "maps", "wrong.tmj") }),
      (error) => error.statusCode === 400 && error.code === "invalid-map-path",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
