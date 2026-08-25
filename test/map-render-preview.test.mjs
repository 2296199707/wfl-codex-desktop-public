import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMapRenderPreviewServer } from "../lib/map-render-preview.mjs";

const appDirectory = path.resolve(new URL("..", import.meta.url).pathname);

test("serves a bounded map render page and read-only project resources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-preview-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-render-outside-"));
  let preview;
  try {
    await fs.mkdir(path.join(root, "maps"), { recursive: true });
    await fs.mkdir(path.join(root, ".codex-desktop"), { recursive: true });
    await fs.writeFile(path.join(root, "maps", "world.tmj"), '{"type":"map"}\n');
    await fs.writeFile(path.join(root, ".codex-desktop", "private.txt"), "private\n");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
    preview = await startMapRenderPreviewServer({
      projectPath: root,
      mapPath: "maps/world.tmj",
      appDirectory,
      renderConfig: { antialias: false },
    });
    const page = await fetch(preview.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /__WFL_RENDER_CONFIG__/u);
    assert.match(html, /maps\/world\.tmj/u);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/u);

    const map = await fetch(`${preview.origin}/maps/world.tmj`);
    assert.equal(map.status, 200);
    assert.match(map.headers.get("content-type"), /json/u);
    assert.equal(await map.text(), '{"type":"map"}\n');
    assert.equal((await fetch(`${preview.origin}/.codex-desktop/private.txt`)).status, 404);
    assert.equal((await fetch(`${preview.origin}/linked.txt`)).status, 404);
    assert.equal((await fetch(`${preview.origin}/__wfl/app/map-editor/map-editor.js`)).status, 404);
    assert.equal((await fetch(`${preview.origin}/__wfl/app/map-editor/map-object-model.js`)).status, 200);
    assert.equal((await fetch(`${preview.origin}/__wfl/app/map-editor/tiled-document.js`)).status, 200);
    assert.equal((await fetch(`${preview.origin}/__wfl/app/map-editor/tiled-tile-codec.js`)).status, 200);
    assert.equal((await fetch(`${preview.origin}/__wfl/app/map-editor/tiled-tileset-model.js`)).status, 200);
  } finally {
    await preview?.close().catch(() => {});
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  }
});
