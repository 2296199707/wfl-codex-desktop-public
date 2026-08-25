import fs from "node:fs/promises";
import path from "node:path";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const HTML_RESOURCE_PATTERN = /<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref)\s*=\s*(["'])([^"']+)\1/giu;
const STATIC_JS_REFERENCE_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bnew\s+(?:Worker|URL)\s*\(\s*)(["'])([^"']+\.js(?:\?[^"']*)?)\1/gu;
const TEMPLATE_JS_REFERENCE_PATTERN = /(?:\bimport\s*\(\s*|\bnew\s+(?:Worker|URL)\s*\(\s*)`([^`]*\.js[^`]*)`/gu;

export async function assertReleaseVersionMetadata(
  directory,
  { expectedVersion = null, assetVersion = null } = {},
) {
  const root = path.resolve(directory);
  const version = (await fs.readFile(path.join(root, "VERSION"), "utf8")).trim();
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const expected = expectedVersion || version;
  const expectedAssetVersion = assetVersion || expected;
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid release VERSION: ${version}`);
  if (version !== expected) throw new Error(`Release VERSION is ${version}, expected ${expected}`);
  if (packageJson.version !== expected) {
    throw new Error(`Release package.json is v${packageJson.version}, expected v${expected}`);
  }

  const app = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
  const index = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
  assertSingleVersion(app, /const UI_VERSION = "([^"]+)";/u, expected, "public/app.js UI_VERSION");
  assertSingleVersion(app, /const UI_VERSION_LABEL = "([^"]+)";/u, expectedAssetVersion, "public/app.js UI_VERSION_LABEL");
  assertSingleVersion(index, /data-version="([^"]+)"/u, expected, "public/index.html data-version");
  assertSingleVersion(index, /data-asset-version="([^"]+)"/u, expectedAssetVersion, "public/index.html data-asset-version");

  const htmlFiles = await collectFiles(path.join(root, "public"), (relativePath) => (
    relativePath.endsWith(".html") && !isRescueAsset(relativePath)
  ));
  for (const relativePath of htmlFiles) {
    const source = await fs.readFile(path.join(root, "public", relativePath), "utf8");
    for (const match of source.matchAll(HTML_RESOURCE_PATTERN)) {
      const resource = match[2];
      if (!isVersionedBrowserAsset(resource)) continue;
      assertAssetQuery(resource, expectedAssetVersion, `public/${relativePath}`);
    }
  }

  const javascriptFiles = await collectFiles(path.join(root, "public"), (relativePath) => (
    relativePath.endsWith(".js") && !isRescueAsset(relativePath)
  ));
  for (const relativePath of javascriptFiles) {
    const source = await fs.readFile(path.join(root, "public", relativePath), "utf8");
    for (const match of source.matchAll(STATIC_JS_REFERENCE_PATTERN)) {
      const resource = match[2];
      if (relativePath === "boot.js" && resource === "/app.js") continue;
      assertAssetQuery(resource, expectedAssetVersion, `public/${relativePath}`);
    }
    for (const match of source.matchAll(TEMPLATE_JS_REFERENCE_PATTERN)) {
      assertTemplateAssetQuery(match[1], expectedAssetVersion, `public/${relativePath}`);
    }
    assertKnownDynamicAssetQueries(source, relativePath, expectedAssetVersion);
  }

  return { version, assetVersion: expectedAssetVersion };
}

function isVersionedBrowserAsset(value) {
  if (!/^\/?(?:[^?#]+)\.(?:js|css)(?:\?[^#]*)?$/iu.test(value)) return false;
  return !/^https?:\/\//iu.test(value) && !value.startsWith("//") && !isRescueAsset(value);
}

function assertAssetQuery(resource, expectedAssetVersion, label) {
  const match = resource.match(/\?v=([^&#]+)/u);
  if (!match) throw new Error(`${label} has an unversioned local browser asset: ${resource}`);
  if (match[1] !== expectedAssetVersion) {
    throw new Error(`${label} uses asset version ${match[1]}, expected ${expectedAssetVersion}: ${resource}`);
  }
}

function assertTemplateAssetQuery(source, expectedAssetVersion, label) {
  const assetMatch = source.match(/(?:^|[./])[^/`]+\.js/iu);
  if (!assetMatch) return;
  const queryMatch = source.match(/\?v=([^&`}]*)/iu);
  if (!queryMatch) throw new Error(`${label} has an unversioned dynamic local JavaScript asset: ${source}`);
  if (queryMatch[1] && !queryMatch[1].includes("$") && queryMatch[1] !== expectedAssetVersion) {
    throw new Error(`${label} uses dynamic asset version ${queryMatch[1]}, expected ${expectedAssetVersion}`);
  }
}

function assertKnownDynamicAssetQueries(source, relativePath, expectedAssetVersion) {
  // Dynamic CSS is intentionally built from the version carried by the
  // importing page/module.  Requiring the conditional query here prevents a
  // new embedding surface from silently falling back to an unversioned CSS.
  for (const asset of ["image-studio.css", "visual-review.css"]) {
    if (!source.includes(asset)) continue;
    const index = source.indexOf(asset);
    const context = source.slice(Math.max(0, index - 120), Math.min(source.length, index + asset.length + 180));
    if (!context.includes("?v=") && !context.includes("?v`")) {
      throw new Error(`public/${relativePath} does not version dynamic ${asset}`);
    }
  }
  if (relativePath === "character-editor/character-editor.js") {
    const dynamicImport = source.match(/import\(\s*`\/image-studio\.js([^`]*)`/u);
    if (!dynamicImport || !dynamicImport[1].includes("?v=")) {
      throw new Error("Character editor image-studio import is not versioned");
    }
  }
}

async function collectFiles(directory, predicate, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(fullPath, predicate, relativePath));
    else if (entry.isFile() && predicate(relativePath)) result.push(relativePath);
  }
  return result.sort();
}

function isRescueAsset(relativePath) {
  return relativePath === "rescue.html"
    || relativePath === "rescue.css"
    || relativePath === "rescue.js"
    || relativePath.startsWith("rescue/")
    || relativePath.includes("/rescue/");
}

function assertSingleVersion(source, pattern, expected, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`${label} was not found`);
  if (match[1] !== expected) throw new Error(`${label} is ${match[1]}, expected ${expected}`);
}
