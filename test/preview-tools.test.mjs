import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startStaticPreviewServer } from "../lib/preview-tools.mjs";

test("standalone project preview serves raw external assets and blocks escaping links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-preview-tools-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-preview-outside-"));
  let preview;
  try {
    await fs.mkdir(path.join(root, "assets"));
    await fs.writeFile(path.join(root, "index.html"), '<img src="assets/hero.webp">');
    await fs.writeFile(path.join(root, "assets", "hero.webp"), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "secret.txt"));
    preview = await startStaticPreviewServer({ root, port: 0 });

    const html = await fetch(preview.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /assets\/hero\.webp/);
    const asset = await fetch(new URL("assets/hero.webp", preview.url));
    assert.equal(asset.status, 200);
    assert.equal(Buffer.from(await asset.arrayBuffer()).toString("hex"), "010203");
    const escaped = await fetch(new URL("secret.txt", preview.url));
    assert.equal(escaped.status, 404);
  } finally {
    await preview?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("single-file viewer remains a raw-file reference instead of embedding content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-preview-tools-"));
  let preview;
  try {
    await fs.writeFile(path.join(root, "map.json"), '{"city":"cloud"}');
    preview = await startStaticPreviewServer({
      root,
      entry: "viewer.html",
      port: 0,
      virtualFiles: new Map([["/viewer.html", {
        body: '<script>fetch("/map.json")</script>',
        type: "text/html; charset=utf-8",
      }]]),
    });
    const viewer = await fetch(preview.url);
    const body = await viewer.text();
    assert.equal(viewer.status, 200);
    assert.match(body, /fetch\("\/map\.json"\)/);
    assert.doesNotMatch(body, /cloud/);
  } finally {
    await preview?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});
