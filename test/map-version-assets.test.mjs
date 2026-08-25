import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAP_EDITOR_PACKAGE_ASSETS,
  MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS,
} from "../lib/package-source.mjs";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDirectory = path.join(projectDirectory, "public");
const mapEditorDirectory = path.join(publicDirectory, "map-editor");
const relativeJavaScriptReference = /(["'])(\.\.?\/[^"'?#\r\n]+\.js)(?:\?v=([^"'#\r\n]*))?\1/gu;

test("all browser map editor module references share one explicit cache key", async () => {
  const [mapHtml, worldHtml, tilesetHtml, characterHtml, characterSource, appSource, entries] = await Promise.all([
    fs.readFile(path.join(publicDirectory, "map-editor.html"), "utf8"),
    fs.readFile(path.join(publicDirectory, "world-editor.html"), "utf8"),
    fs.readFile(path.join(publicDirectory, "tileset-editor.html"), "utf8"),
    fs.readFile(path.join(publicDirectory, "character-editor.html"), "utf8"),
    fs.readFile(path.join(publicDirectory, "character-editor", "character-editor.js"), "utf8"),
    fs.readFile(path.join(publicDirectory, "app.js"), "utf8"),
    fs.readdir(mapEditorDirectory, { withFileTypes: true }),
  ]);
  const assetVersion = requiredVersion(mapHtml, /\/map-editor\/map-editor\.js\?v=([^"']+)/u);
  for (const asset of [
    "map-editor/map-editor.css",
    "vendor/lucide/lucide.min.js",
    "vendor/pixi/pixi.min.js",
    "vendor/pixi/packages/advanced-blend-modes.min.js",
    "vendor/pixi/packages/unsafe-eval.min.js",
  ]) {
    const escapedAsset = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.equal(requiredVersion(mapHtml, new RegExp(`/${escapedAsset}\\?v=([^\"']+)`, "u")), assetVersion);
  }
  assert.equal(requiredVersion(worldHtml, /\/map-editor\/world-editor\.js\?v=([^"']+)/u), assetVersion);
  assert.equal(requiredVersion(tilesetHtml, /\/map-editor\/tileset-editor\.js\?v=([^"']+)/u), assetVersion);
  assert.equal(requiredVersion(characterHtml, /\/character-editor\/character-editor\.js\?v=([^"']+)/u), assetVersion);
  assert.equal(
    requiredVersion(characterHtml, /\/character-editor\/character-editor\.css\?v=([^"']+)/u),
    assetVersion,
  );
  assert.equal(
    requiredVersion(characterSource, /from "\/map-project-session\.js\?v=([^"']+)"/u),
    assetVersion,
  );
  assert.equal(
    requiredVersion(characterSource, /from "\/character-editor\/character-animation-model\.js\?v=([^"']+)"/u),
    assetVersion,
  );

  for (const moduleName of [
    "game-work-mode.js",
    "map-project-session.js",
    "map-editor/map-tab-channel.js",
    "map-editor/map-conversation-channel.js",
  ]) {
    const escapedName = moduleName.replaceAll(".", "\\.").replaceAll("/", "\\/");
    assert.equal(
      requiredVersion(appSource, new RegExp(`${escapedName}\\?v=([^"']+)`, "u")),
      assetVersion,
      `public/app.js must use the map cache key for ${moduleName}`,
    );
  }

  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".js"))) {
    const source = await fs.readFile(path.join(mapEditorDirectory, entry.name), "utf8");
    for (const match of source.matchAll(relativeJavaScriptReference)) {
      assert.equal(
        match[3],
        assetVersion,
        `public/map-editor/${entry.name} must version ${match[2]}`,
      );
    }
  }
});

test("the map package capability covers every browser map module and shared dependency", async () => {
  const [entries, libraryEntries] = await Promise.all([
    fs.readdir(mapEditorDirectory, { withFileTypes: true }),
    fs.readdir(path.join(projectDirectory, "lib"), { withFileTypes: true }),
  ]);
  const browserModules = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => `public/map-editor/${entry.name}`);
  const serverModules = libraryEntries
    .filter((entry) => entry.isFile() && entry.name.startsWith("map-") && entry.name.endsWith(".mjs"))
    .map((entry) => `lib/${entry.name}`);
  for (const relativePath of [
    ...browserModules,
    ...serverModules,
    "public/game-work-mode.js",
    "public/map-project-session.js",
  ]) {
    assert.ok(MAP_EDITOR_PACKAGE_ASSETS.includes(relativePath), `${relativePath} is missing from the map package`);
  }
  await Promise.all(MAP_EDITOR_RUNTIME_DEPENDENCY_ASSETS.map(async (relativePath) => {
    await fs.access(path.join(projectDirectory, relativePath));
  }));
});

function requiredVersion(source, pattern) {
  const match = pattern.exec(source);
  assert.ok(match, `versioned asset reference was not found: ${pattern}`);
  return match[1];
}
