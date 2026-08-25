import assert from "node:assert/strict";
import test from "node:test";
import { MapProjectWorkspaceClient } from "../public/map-project-session.js";

function response(status, data = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test("project workspace client opens, browses, searches and closes one relative-path session", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === "/api/map-projects/sessions" && options.method === "POST") {
      return response(201, {
        session: {
          id: "project-session-abcdefghijklmnop",
          projectName: "game",
          projectFile: "game.tiled-project",
          temporary: false,
          writable: true,
          resourceRoots: ["maps"],
          manifest: { compatibilityVersion: "1.12" },
          warnings: [],
          createdAt: 1,
          expiresAt: 2,
        },
      });
    }
    if (parsed.pathname.endsWith("/tree")) {
      return response(200, {
        projectSessionId: "project-session-abcdefghijklmnop",
        tree: {
          directory: "maps",
          entries: [{ path: "maps/world.tmj", name: "world.tmj", kind: "map", size: 12, modifiedAt: 3 }],
          nextCursor: "cursor_1",
        },
      });
    }
    if (parsed.pathname.endsWith("/search")) {
      return response(200, {
        projectSessionId: "project-session-abcdefghijklmnop",
        search: {
          entries: [{ path: "maps/world.tmj", name: "world.tmj", kind: "map", size: 12, modifiedAt: 3 }],
          nextCursor: null,
          scanned: 10,
          truncated: false,
        },
      });
    }
    if (parsed.pathname.endsWith("/resource-version")) {
      return response(200, {
        projectSessionId: "project-session-abcdefghijklmnop",
        resource: {
          relativePath: parsed.searchParams.get("path"),
          size: 4096,
          modifiedAt: 1700000000,
          version: "f".repeat(64),
        },
      });
    }
    if (parsed.pathname.endsWith("/maps") && options.method === "POST") {
      const body = JSON.parse(options.body);
      return response(201, {
        projectSessionId: "project-session-abcdefghijklmnop",
        map: {
          relativePath: body.relativePath,
          version: "a".repeat(64),
          size: 512,
          modifiedAt: 4,
          orientation: body.orientation,
          infinite: body.infinite,
          width: body.width || 0,
          height: body.height || 0,
          tilewidth: body.tilewidth,
          tileheight: body.tileheight,
          tilesetCount: body.tilesets.length,
          diagnostics: [],
        },
      });
    }
    if (parsed.pathname.endsWith("/worlds") && options.method === "POST") {
      const body = JSON.parse(options.body);
      return response(201, {
        projectSessionId: "project-session-abcdefghijklmnop",
        world: {
          relativePath: body.relativePath,
          version: "b".repeat(64),
          size: 256,
          modifiedAt: 5,
          mapCount: body.maps.length,
          patternCount: body.patterns.length,
          onlyShowAdjacentMaps: body.onlyShowAdjacentMaps,
          diagnostics: [],
        },
      });
    }
    if (parsed.pathname.endsWith("/tilesets") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const imagePaths = body.kind === "atlas" ? [body.image] : body.images;
      return response(201, {
        projectSessionId: "project-session-abcdefghijklmnop",
        tileset: {
          relativePath: body.relativePath,
          version: "c".repeat(64),
          size: 384,
          modifiedAt: 6,
          kind: body.kind,
          name: body.name,
          tilewidth: body.tilewidth || 64,
          tileheight: body.tileheight || 48,
          tilecount: body.kind === "atlas" ? 8 : imagePaths.length,
          columns: body.kind === "atlas" ? 4 : 0,
          imageCount: imagePaths.length,
          imagePaths,
          diagnostics: [],
        },
      });
    }
    if (parsed.pathname.endsWith("/imports") && options.method === "POST") {
      const body = JSON.parse(options.body);
      const plan = {
        schema: "wfl.map-project-import.v1",
        planHash: "d".repeat(64),
        source: { projectName: "source-game", path: body.sourcePath },
        target: { path: body.targetPath },
        files: [{
          sourcePath: body.sourcePath,
          targetPath: body.targetPath,
          kind: "tileset",
          size: 128,
          sha256: "e".repeat(64),
          action: "copy",
          dependency: false,
        }],
        copyCount: 1,
        reuseCount: 0,
        copyBytes: 128,
        totalBytes: 128,
      };
      return response(body.confirmation ? 201 : 200, {
        projectSessionId: "project-session-abcdefghijklmnop",
        sourceProjectSessionId: body.sourceProjectSessionId,
        plan,
        ...(body.confirmation ? {
          published: [{ targetPath: body.targetPath, size: 128, sha256: "e".repeat(64) }],
          reused: 0,
        } : { requiresConfirmation: true }),
      });
    }
    if (options.method === "DELETE") return response(204, null);
    return response(404, { error: "unexpected" });
  };
  const client = new MapProjectWorkspaceClient({ fetchImpl, origin: "https://desktop.example" });
  const session = await client.open({ project: "/srv/projects/game", projectFile: "game.tiled-project" });
  assert.equal(session.projectFile, "game.tiled-project");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    project: "/srv/projects/game",
    projectFile: "game.tiled-project",
  });
  const tree = await client.tree({ directory: "maps", kinds: ["map"], limit: 20 });
  assert.equal(tree.entries[0].path, "maps/world.tmj");
  assert.match(requests[1].url, /directory=maps/u);
  assert.match(requests[1].url, /kinds=map/u);
  const search = await client.search({ query: "world", kinds: ["map"] });
  assert.equal(search.entries[0].kind, "map");
  const version = await client.readResourceVersion("maps/world.tmj");
  assert.deepEqual(version, {
    relativePath: "maps/world.tmj",
    size: 4096,
    modifiedAt: 1700000000,
    version: "f".repeat(64),
  });
  const versionRequest = requests.find(({ url }) => new URL(url).pathname.endsWith("/resource-version"));
  assert.match(versionRequest.url, /path=maps%2Fworld\.tmj/u);
  assert.match(versionRequest.url, /kind=map/u);
  const created = await client.createMap({
    relativePath: "maps/new-zone.tmj",
    orientation: "hexagonal",
    infinite: false,
    width: 8,
    height: 6,
    tilewidth: 16,
    tileheight: 16,
    renderorder: "right-down",
    initialLayerName: "Ground",
    tilesets: ["maps/terrain.tsj"],
    staggeraxis: "y",
    staggerindex: "odd",
    hexsidelength: 8,
  });
  assert.equal(created.relativePath, "maps/new-zone.tmj");
  const createRequest = requests.find(({ url, options }) => new URL(url).pathname.endsWith("/maps") && options.method === "POST");
  assert.equal(createRequest.options.headers["X-Codex-Desktop-Action"], "map-project-map-create");
  assert.equal(JSON.parse(createRequest.options.body).projectPath, undefined);
  const createdWorld = await client.createWorld({
    relativePath: "maps/game.world",
    maps: [{ path: "maps/world.tmj", x: 0, y: 0, width: 320, height: 240 }],
    patterns: [],
    onlyShowAdjacentMaps: true,
  });
  assert.equal(createdWorld.relativePath, "maps/game.world");
  assert.equal(createdWorld.mapCount, 1);
  const worldCreateRequest = requests.find(({ url, options }) => new URL(url).pathname.endsWith("/worlds") && options.method === "POST");
  assert.equal(worldCreateRequest.options.headers["X-Codex-Desktop-Action"], "map-project-world-create");
  assert.equal(JSON.parse(worldCreateRequest.options.body).projectPath, undefined);
  const createdAtlas = await client.createTileset({
    relativePath: "tiles/terrain.tsj",
    kind: "atlas",
    name: "Terrain",
    image: "images/terrain.png",
    tilewidth: 16,
    tileheight: 16,
    margin: 1,
    spacing: 2,
    transparentcolor: "#ff00ff",
  });
  assert.equal(createdAtlas.relativePath, "tiles/terrain.tsj");
  assert.equal(createdAtlas.tilecount, 8);
  assert.deepEqual(createdAtlas.imagePaths, ["images/terrain.png"]);
  const tilesetCreateRequest = requests.find(({ url, options }) => new URL(url).pathname.endsWith("/tilesets") && options.method === "POST");
  assert.equal(tilesetCreateRequest.options.headers["X-Codex-Desktop-Action"], "map-project-tileset-create");
  assert.deepEqual(JSON.parse(tilesetCreateRequest.options.body), {
    relativePath: "tiles/terrain.tsj",
    kind: "atlas",
    name: "Terrain",
    targetVersion: "1.12.2",
    image: "images/terrain.png",
    tilewidth: 16,
    tileheight: 16,
    margin: 1,
    spacing: 2,
    transparentcolor: "#ff00ff",
  });
  const createdCollection = await client.createTileset({
    relativePath: "tiles/props.tsj",
    kind: "collection",
    name: "Props",
    images: ["images/tree.png", "images/rock.webp"],
  });
  assert.equal(createdCollection.kind, "collection");
  assert.deepEqual(createdCollection.imagePaths, ["images/tree.png", "images/rock.webp"]);
  const importPlan = await client.importResource({
    sourceProjectSessionId: "source-project-session-1234",
    sourcePath: "tiles/source.tsj",
    targetPath: "imports/source.tsj",
  });
  assert.equal(importPlan.committed, false);
  assert.equal(importPlan.plan.copyCount, 1);
  const importRequest = requests.find(({ url }) => new URL(url).pathname.endsWith("/imports"));
  assert.equal(importRequest.options.headers["X-Codex-Desktop-Action"], "map-project-import");
  const imported = await client.importResource({
    sourceProjectSessionId: "source-project-session-1234",
    sourcePath: "tiles/source.tsj",
    targetPath: "imports/source.tsj",
    planHash: importPlan.plan.planHash,
    confirmation: true,
  });
  assert.equal(imported.committed, true);
  assert.equal(imported.published[0].targetPath, "imports/source.tsj");
  assert.deepEqual(client.mapOpenPayload("maps/world.tmj", "editor-window-0001"), {
    projectSessionId: session.id,
    path: "maps/world.tmj",
    editorInstanceId: "editor-window-0001",
  });
  assert.deepEqual(client.worldOpenPayload("maps/game.world", "world-window-0001"), {
    projectSessionId: session.id,
    path: "maps/game.world",
    editorInstanceId: "world-window-0001",
  });
  assert.deepEqual(client.tilesetOpenPayload("tiles/terrain.tsj", "tileset-window-0001"), {
    projectSessionId: session.id,
    path: "tiles/terrain.tsj",
    editorInstanceId: "tileset-window-0001",
  });
  assert.equal(await client.close(), true);
  assert.equal(requests.at(-1).options.headers["X-Codex-Desktop-Action"], "map-project-session-close");
});

test("project workspace client rejects absolute or traversal paths returned by a server", async () => {
  const client = new MapProjectWorkspaceClient({
    origin: "https://desktop.example",
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/map-projects/sessions" && options.method === "POST") {
        return response(201, {
          session: {
            id: "project-session-abcdefghijklmnop",
            projectName: "game",
            projectFile: null,
            temporary: true,
            writable: true,
            resourceRoots: ["maps"],
            warnings: [],
          },
        });
      }
      return response(200, {
        projectSessionId: "project-session-abcdefghijklmnop",
        tree: {
          directory: "",
          entries: [{ path: "/etc/passwd", name: "passwd", kind: "other" }],
          nextCursor: null,
        },
      });
    },
  });
  await client.open({ project: "/srv/projects/game" });
  await assert.rejects(client.tree(), /project-relative/u);
  assert.throws(() => client.mapOpenPayload("../private.tmj", "editor-window-0001"), /project-relative/u);
  assert.throws(() => client.worldOpenPayload("../private.world", "world-window-0001"), /project-relative/u);
  assert.throws(() => client.tilesetOpenPayload("../private.tsj", "tileset-window-0001"), /project-relative/u);
  assert.throws(() => client.tilesetOpenPayload("maps/world.tmj", "tileset-window-0001"), /must end in \.tsj/u);
  await assert.rejects(
    client.createTileset({ relativePath: "tiles/empty.tsj", kind: "collection", name: "Empty", images: [] }),
    /non-empty array/u,
  );
});

test("project workspace client fences concurrent opens and closes the stale response", async () => {
  const opened = [];
  const closed = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/map-projects/sessions" && options.method === "POST") {
      const project = JSON.parse(options.body).project;
      await new Promise((resolve) => setTimeout(resolve, project.endsWith("/a") ? 25 : 1));
      const id = project.endsWith("/a") ? "project-session-aaaaaaaa" : "project-session-bbbbbbbb";
      opened.push({ project, id });
      return response(201, {
        session: {
          id,
          projectName: project.split("/").at(-1),
          projectFile: null,
          temporary: true,
          writable: true,
          resourceRoots: [""],
          warnings: [],
        },
      });
    }
    if (options.method === "DELETE") {
      closed.push(parsed.pathname.split("/").at(-1));
      return response(204, null);
    }
    return response(404, { error: "unexpected" });
  };
  const client = new MapProjectWorkspaceClient({
    origin: "https://desktop.example",
    fetchImpl,
  });
  const first = client.open({ project: "/srv/projects/a" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = client.open({ project: "/srv/projects/b" });
  await assert.rejects(first, (error) => error.code === "map-project-stale-operation");
  const current = await second;
  assert.equal(current.id, "project-session-bbbbbbbb");
  assert.equal(client.session.id, current.id);
  assert.deepEqual(opened.map(({ id }) => id), ["project-session-bbbbbbbb", "project-session-aaaaaaaa"]);
  assert.deepEqual(closed, ["project-session-aaaaaaaa"]);
});

test("project workspace client reads template/composite source through a relative path", async () => {
  const requests = [];
  const client = new MapProjectWorkspaceClient({
    origin: "https://desktop.example",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return name.toLowerCase() === "x-wfl-project-resource-version" ? "a".repeat(64) : null; } },
        async text() { return '{"type":"template"}'; },
        async json() { return {}; },
      };
    },
  });
  client.session = {
    id: "project-session-abcdefghijklmnop",
    projectFile: null,
    resourceRoots: [""],
    writable: true,
  };
  const result = await client.readResourceSource("templates/portal.tx");
  assert.equal(result.relativePath, "templates/portal.tx");
  assert.equal(JSON.parse(result.content).type, "template");
  assert.match(requests[0].url, /resource-source\?path=templates%2Fportal\.tx/u);
});

test("project workspace client preserves conflict status and code for draft recovery", async () => {
  const client = new MapProjectWorkspaceClient({
    origin: "https://desktop.example",
    fetchImpl: async () => response(409, { error: "资源版本已经变化", code: "wfl-character-version-conflict" }),
  });
  client.session = {
    id: "project-session-abcdefghijklmnop",
    projectFile: null,
    resourceRoots: [""],
    writable: true,
  };
  await assert.rejects(
    client.saveCharacterAnimation({ relativePath: "characters/hero.character.json", document: {} }),
    (error) => error.status === 409
      && error.statusCode === 409
      && error.code === "wfl-character-version-conflict",
  );
});
