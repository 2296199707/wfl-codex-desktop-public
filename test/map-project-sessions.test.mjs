import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MapProjectSessionStore } from "../lib/map-project-sessions.mjs";

const identity = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-session-1",
});

async function withProject(operation) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-project-session-"));
  const projectPath = path.join(temporaryRoot, "game");
  try {
    await fs.mkdir(path.join(projectPath, "maps"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "private"));
    await fs.writeFile(path.join(projectPath, "maps", "world.tmj"), '{"type":"map"}\n');
    await fs.writeFile(path.join(projectPath, "private", "hidden.tmj"), '{"type":"map"}\n');
    await operation({ temporaryRoot, projectPath });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("opens temporary project sessions without exposing absolute server paths", async () => {
  await withProject(async ({ projectPath }) => {
    const store = new MapProjectSessionStore();
    const session = await store.open({ identity, projectPath, writable: true });
    assert.equal(session.projectName, "game");
    assert.equal(session.projectFile, null);
    assert.equal(session.temporary, true);
    assert.equal(session.writable, true);
    assert.deepEqual(session.resourceRoots, [""]);
    assert.equal(JSON.stringify(session).includes(projectPath), false);
    assert.equal(
      store.authorizeRelativePath({
        sessionId: session.id,
        identity,
        relativePath: "maps/world.tmj",
        kind: "map",
      }),
      "maps/world.tmj",
    );
    assert.equal(
      store.authorizeRelativePath({
        sessionId: session.id,
        identity,
        relativePath: "maps/terrain.tsj",
        kind: "tileset",
      }),
      "maps/terrain.tsj",
    );
    assert.throws(
      () => store.authorizeRelativePath({
        sessionId: session.id,
        identity,
        relativePath: "maps/world.tmj",
        kind: "tileset",
      }),
      (error) => error.statusCode === 415 && error.code === "map-project-resource-kind-mismatch",
    );
  });
});

test("reads Tiled project metadata and enforces declared folders", async () => {
  await withProject(async ({ projectPath }) => {
    const projectFilePath = path.join(projectPath, "game.tiled-project");
    await fs.writeFile(projectFilePath, `${JSON.stringify({
      compatibilityVersion: "1.12",
      automappingRulesFile: "rules.txt",
      folders: ["maps", "missing", "../outside"],
      propertyTypes: [{ name: "Portal", type: "class" }],
    })}\n`);
    const store = new MapProjectSessionStore();
    const session = await store.open({ identity, projectPath, projectFilePath });
    assert.equal(session.projectFile, "game.tiled-project");
    assert.equal(session.temporary, false);
    assert.deepEqual(session.resourceRoots, ["maps"]);
    assert.equal(session.manifest.compatibilityVersion, "1.12");
    assert.equal(session.manifest.automappingRulesFile, "rules.txt");
    assert.equal(session.manifest.propertyTypeCount, 1);
    assert.match(session.manifest.version, /^[a-f0-9]{64}$/u);
    assert.equal(session.warnings.length, 2);
    assert.equal(store.authorizeRelativePath({
      sessionId: session.id,
      identity,
      relativePath: "maps/world.tmj",
      kind: "map",
    }), "maps/world.tmj");
    assert.throws(
      () => store.authorizeRelativePath({
        sessionId: session.id,
        identity,
        relativePath: "private/hidden.tmj",
        kind: "map",
      }),
      (error) => error.statusCode === 403 && error.code === "map-project-resource-outside-folders",
    );
  });
});

test("reads the bound Tiled project source without exposing an absolute path", async () => {
  await withProject(async ({ projectPath }) => {
    const projectFilePath = path.join(projectPath, "game.tiled-project");
    const source = `${JSON.stringify({ folders: ["maps"], propertyTypes: [{ name: "Biome", type: "enum", values: ["forest"] }] })}\n`;
    await fs.writeFile(projectFilePath, source);
    const store = new MapProjectSessionStore();
    const session = await store.open({ identity, projectPath, projectFilePath });
    const result = await store.readProjectSource({ sessionId: session.id, identity });
    assert.equal(result.relativePath, "game.tiled-project");
    assert.equal(result.content, source);
    assert.equal(result.size, Buffer.byteLength(source));
    assert.match(result.version, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(result).includes(projectPath), false);
  });
});

test("reads authorized template and composite resource sources without following symlinks", async () => {
  await withProject(async ({ projectPath }) => {
    await fs.mkdir(path.join(projectPath, "templates"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "templates", "portal.tx"), `${JSON.stringify({
      type: "template",
      object: { id: 1, name: "Portal" },
    })}\n`);
    await fs.writeFile(path.join(projectPath, "maps", "pond.tmj"), `${JSON.stringify({
      type: "map", layers: [], tilesets: [], width: 0, height: 0,
    })}\n`);
    const store = new MapProjectSessionStore();
    const session = await store.open({ identity, projectPath });
    const template = await store.readResourceSource({
      sessionId: session.id,
      identity,
      relativePath: "templates/portal.tx",
    });
    assert.equal(template.relativePath, "templates/portal.tx");
    assert.equal(JSON.parse(template.content).type, "template");
    const composite = await store.readResourceSource({
      sessionId: session.id,
      identity,
      relativePath: "maps/pond.tmj",
    });
    assert.equal(JSON.parse(composite.content).type, "map");
    await assert.rejects(
      store.readResourceSource({ sessionId: session.id, identity, relativePath: "maps/world.tmj".replace(".tmj", ".png") }),
      (error) => error.statusCode === 415 && error.code === "map-project-resource-source-unsupported",
    );
  });
});

test("reads only bounded metadata for a resource version and enforces kind/path isolation", async () => {
  await withProject(async ({ projectPath }) => {
    const source = '{"type":"map","layers":[]}' + "\n";
    await fs.writeFile(path.join(projectPath, "maps", "versioned.tmj"), source);
    const projectFilePath = path.join(projectPath, "game.tiled-project");
    await fs.writeFile(projectFilePath, `${JSON.stringify({ folders: ["maps"] })}\n`);
    const store = new MapProjectSessionStore({ maxProjectBytes: 1024 * 1024 });
    const session = await store.open({ identity, projectPath, projectFilePath });
    const result = await store.readResourceVersion({
      sessionId: session.id,
      identity,
      relativePath: "maps/versioned.tmj",
      kind: "map",
    });
    assert.deepEqual(Object.keys(result).sort(), ["modifiedAt", "relativePath", "size", "version"]);
    assert.equal(result.relativePath, "maps/versioned.tmj");
    assert.equal(result.size, Buffer.byteLength(source));
    assert.match(result.version, /^[a-f0-9]{64}$/u);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "content"), false);
    await assert.rejects(
      store.readResourceVersion({
        sessionId: session.id,
        identity,
        relativePath: "private/hidden.tmj",
        kind: "map",
      }),
      (error) => error.statusCode === 403 && error.code === "map-project-resource-outside-folders",
    );
    await assert.rejects(
      store.readResourceVersion({
        sessionId: session.id,
        identity,
        relativePath: "maps/versioned.tmj",
        kind: "tileset",
      }),
      (error) => error.statusCode === 415 && error.code === "map-project-resource-kind-mismatch",
    );
  });
});

test("resource version hashing is independent from the small text-source limit", async () => {
  await withProject(async ({ projectPath }) => {
    const source = `${JSON.stringify({ type: "map", payload: "x".repeat(256) })}\n`;
    await fs.writeFile(path.join(projectPath, "maps", "large-version.tmj"), source);
    const store = new MapProjectSessionStore({ maxProjectBytes: 32, maxResourceVersionBytes: 1024 * 1024 });
    const session = await store.open({ identity, projectPath });
    await assert.rejects(
      store.readResourceSource({ sessionId: session.id, identity, relativePath: "maps/large-version.tmj" }),
      (error) => error.statusCode === 413 && error.code === "tiled-project-size-limit",
    );
    const version = await store.readResourceVersion({
      sessionId: session.id,
      identity,
      relativePath: "maps/large-version.tmj",
      kind: "map",
    });
    assert.equal(version.size, Buffer.byteLength(source));
    assert.match(version.version, /^[a-f0-9]{64}$/u);
  });
});

test("binds project sessions to user and login browser but not an editor window", async () => {
  await withProject(async ({ projectPath }) => {
    const store = new MapProjectSessionStore();
    const session = await store.open({ identity, projectPath });
    assert.equal(store.snapshot({
      sessionId: session.id,
      identity: { ...identity, editorInstanceId: "ignored-editor-1" },
    }).id, session.id);
    assert.throws(
      () => store.snapshot({ sessionId: session.id, identity: { ...identity, userId: "user-2" } }),
      (error) => error.statusCode === 404 && error.code === "map-project-session-not-found",
    );
    assert.throws(
      () => store.snapshot({
        sessionId: session.id,
        identity: { ...identity, browserSessionId: "browser-session-2" },
      }),
      (error) => error.statusCode === 404 && error.code === "map-project-session-not-found",
    );
  });
});

test("logout closes only project sessions for the exact user and browser login", async () => {
  await withProject(async ({ projectPath }) => {
    const store = new MapProjectSessionStore({ maxSessions: 8, maxSessionsPerBrowser: 8 });
    const first = await store.open({ identity, projectPath });
    const second = await store.open({ identity, projectPath });
    const otherIdentity = { ...identity, browserSessionId: "browser-session-2" };
    const other = await store.open({ identity: otherIdentity, projectPath });
    assert.deepEqual(store.closeForBrowserSession(identity), { closed: 2 });
    for (const session of [first, second]) {
      assert.throws(
        () => store.snapshot({ sessionId: session.id, identity }),
        (error) => error.code === "map-project-session-not-found",
      );
    }
    assert.equal(store.snapshot({ sessionId: other.id, identity: otherIdentity }).id, other.id);
  });
});

test("revoking an account closes project sessions from all of its browser logins", async () => {
  await withProject(async ({ projectPath }) => {
    const store = new MapProjectSessionStore({ maxSessions: 8, maxSessionsPerBrowser: 8 });
    const first = await store.open({ identity, projectPath });
    const secondIdentity = { ...identity, browserSessionId: "browser-session-2" };
    const second = await store.open({ identity: secondIdentity, projectPath });
    const survivorIdentity = { ...identity, userId: "user-2" };
    const survivor = await store.open({ identity: survivorIdentity, projectPath });

    assert.deepEqual(store.closeForUser({ userId: identity.userId }), { closed: 2 });
    for (const [session, sessionIdentity] of [[first, identity], [second, secondIdentity]]) {
      assert.throws(
        () => store.snapshot({ sessionId: session.id, identity: sessionIdentity }),
        (error) => error.code === "map-project-session-not-found",
      );
    }
    assert.equal(store.snapshot({ sessionId: survivor.id, identity: survivorIdentity }).id, survivor.id);
  });
});

test("uses fixed session capacity and expiry without adaptive changes", async () => {
  let now = 1_000;
  await withProject(async ({ projectPath }) => {
    const store = new MapProjectSessionStore({
      ttlMs: 100,
      maxSessions: 1,
      maxSessionsPerBrowser: 1,
      now: () => now,
    });
    const session = await store.open({ identity, projectPath });
    await assert.rejects(
      store.open({ identity, projectPath }),
      (error) => error.statusCode === 429 && error.code === "map-project-session-capacity",
    );
    now = 1_101;
    assert.throws(
      () => store.snapshot({ sessionId: session.id, identity }),
      (error) => error.statusCode === 404 && error.code === "map-project-session-not-found",
    );
    assert.ok((await store.open({ identity, projectPath })).id);
  });
});

test("rejects malformed, oversized and symlinked Tiled project files", async () => {
  await withProject(async ({ temporaryRoot, projectPath }) => {
    const store = new MapProjectSessionStore({ maxProjectBytes: 32 });
    const malformed = path.join(projectPath, "bad.tiled-project");
    await fs.writeFile(malformed, "not-json");
    await assert.rejects(
      store.open({ identity, projectPath, projectFilePath: malformed }),
      (error) => error.statusCode === 415 && error.code === "invalid-tiled-project-json",
    );
    const oversized = path.join(projectPath, "large.tiled-project");
    await fs.writeFile(oversized, JSON.stringify({ folders: ["maps"], note: "x".repeat(64) }));
    await assert.rejects(
      store.open({ identity, projectPath, projectFilePath: oversized }),
      (error) => error.statusCode === 413 && error.code === "tiled-project-size-limit",
    );
    const outside = path.join(temporaryRoot, "outside.tiled-project");
    await fs.writeFile(outside, '{"folders":["."]}\n');
    const linked = path.join(projectPath, "linked.tiled-project");
    await fs.symlink(outside, linked);
    await assert.rejects(
      store.open({ identity, projectPath, projectFilePath: linked }),
      (error) => error.statusCode === 403 && error.code === "map-project-symlink",
    );
  });
});
