import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOperationLock } from "../lib/operation-lock.mjs";
import { versionReleaseReferences } from "../lib/release-reference-versioning.mjs";
import {
  commitVersionSyncTransaction,
  recoverVersionSyncTransaction,
} from "../lib/version-sync-transaction.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
const formalRelease = process.argv.includes("--formal") || process.env.CODEX_DESKTOP_FORMAL_RELEASE === "1";

if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run version:sync -- <major.minor.patch> [--formal]");
  process.exit(1);
}
if (formalRelease && version.includes("-")) {
  console.error("Formal version sync requires a version without a prerelease suffix");
  process.exit(1);
}
// Local/test syncs keep a beta cache/display suffix. Formal releases opt out
// explicitly so the committed release assets and UI use the exact version.
const assetVersion = formalRelease
  ? version
  : (version.endsWith("-beta") ? version : `${version}-beta`);
const syncLock = await acquireOperationLock(path.join(projectDir, ".codex-runtime", "version-sync.lock"), {
  ownerCommand: "scripts/sync-version.mjs",
  acceptedCommands: ["scripts/sync-version.mjs"],
  operationId: `version-sync-${process.pid}`,
  conflictMessage: "Another version synchronization is already running",
});

try {
function compactMobileVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return String(value || "").slice(0, 8);
  const prerelease = match[4]
    ? match[4].toLowerCase().startsWith("beta") ? "β" : "*"
    : "";
  return `${match[1]}.${match[2]}.${match[3]}${prerelease}`;
}

const packagePath = path.join(projectDir, "package.json");
const lockPath = path.join(projectDir, "package-lock.json");
const appPath = path.join(projectDir, "public", "app.js");
const htmlPath = path.join(projectDir, "public", "index.html");
const mapEditorHtmlPath = path.join(projectDir, "public", "map-editor.html");
const mapEditorModuleDirectory = path.join(projectDir, "public", "map-editor");
const worldEditorHtmlPath = path.join(projectDir, "public", "world-editor.html");
const tilesetEditorHtmlPath = path.join(projectDir, "public", "tileset-editor.html");
const characterEditorHtmlPath = path.join(projectDir, "public", "character-editor.html");
const characterEditorModuleDirectory = path.join(projectDir, "public", "character-editor");
const loginHtmlPath = path.join(projectDir, "public", "login.html");
const sourceHtmlPath = path.join(projectDir, "public", "source.html");
const opsHtmlPath = path.join(projectDir, "public", "ops.html");
const usersHtmlPath = path.join(projectDir, "public", "users.html");
const mobileToolHtmlPath = path.join(projectDir, "public", "mobile-tool.html");
const serverFileManagerHtmlPath = path.join(projectDir, "public", "server-file-manager.html");
const readmePath = path.join(projectDir, "README.md");
const chineseReadmePath = path.join(projectDir, "README.zh-CN.md");
const transactionPath = path.join(projectDir, ".codex-runtime", "version-sync.transaction.json");
const chineseDeploymentPath = path.join(projectDir, "docs", "server-deployment.zh-CN.md");

function versionAssets(source, assets, label) {
  let output = source;
  for (const asset of assets) {
    const escapedAsset = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`/${escapedAsset}(?:\\?v=[^\"]+)?(?=\")`);
    if (!pattern.test(output)) throw new Error(`Versioned ${asset} reference was not found in ${label}`);
    output = output.replace(pattern, `/${asset}?v=${assetVersion}`);
  }
  return output;
}

function versionRelativeJavaScriptReferences(source) {
  return source.replace(
    /(["'])(\.\.?\/[^"'?#\r\n]+\.js)(?:\?v=[^"'#\r\n]*)?\1/gu,
    (_match, quote, modulePath) => `${quote}${modulePath}?v=${assetVersion}${quote}`,
  );
}

function versionJavaScriptReferences(source) {
  let output = versionRelativeJavaScriptReferences(source);
  output = output.replace(
    /(["'])(\/(?!\/|rescue\/)[^"'?#\r\n]+\.js)(?:\?v=[^"'#\r\n]*)?\1/gu,
    (_match, quote, modulePath) => `${quote}${modulePath}?v=${assetVersion}${quote}`,
  );
  return output;
}

function versionHtmlBrowserAssets(source) {
  return source.replace(
    /(\b(?:src|href)\s*=\s*["'])(?!https?:\/\/|\/\/|data:|blob:|#)(?!\/rescue(?:\/|["']))([^"'#\r\n]+\.(?:js|css))(?:\?v=[^"'#\r\n]*)?(["'])/giu,
    (_match, prefix, resource, suffix) => `${prefix}${resource}?v=${assetVersion}${suffix}`,
  );
}

async function versionBrowserJavaScriptFiles() {
  const publicDirectory = path.join(projectDir, "public");
  const files = await collectBrowserFiles(publicDirectory);
  return Promise.all(files
    .filter(({ relative }) => relative.endsWith(".js") && !isRescueAsset(relative))
    .filter(({ relative }) => relative !== "app.js")
    .map(async ({ filePath }) => ({
      filePath,
      source: versionJavaScriptReferences(await fs.readFile(filePath, "utf8")),
    })));
}

async function collectBrowserFiles(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectBrowserFiles(filePath, relative));
    else if (entry.isFile()) files.push({ filePath, relative });
  }
  return files;
}

function isRescueAsset(relativePath) {
  const segments = relativePath.split("/");
  return segments.includes("rescue")
    || (segments.length === 1 && segments[0].startsWith("rescue."));
}

async function versionMapEditorModules() {
  const entries = (await fs.readdir(mapEditorModuleDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error("No map editor JavaScript modules were found");
  return Promise.all(entries.map(async (entry) => {
    const filePath = path.join(mapEditorModuleDirectory, entry.name);
    return {
      filePath,
      source: versionRelativeJavaScriptReferences(await fs.readFile(filePath, "utf8")),
    };
  }));
}

async function versionCharacterEditorModules() {
  const entries = (await fs.readdir(characterEditorModuleDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error("No character editor JavaScript modules were found");
  return Promise.all(entries.map(async (entry) => {
    const filePath = path.join(characterEditorModuleDirectory, entry.name);
    let source = await fs.readFile(filePath, "utf8");
    source = source.replace(
      /from "\/map-project-session\.js(?:\?v=[^"]+)?";/u,
      `from "/map-project-session.js?v=${assetVersion}";`,
    );
    source = source.replace(
      /from "\/character-editor\/character-animation-model\.js(?:\?v=[^"]+)?";/u,
      `from "/character-editor/character-animation-model.js?v=${assetVersion}";`,
    );
    source = source.replace(
      /from "\/map-editor\/map-account-session-guard\.js(?:\?v=[^"]+)?";/u,
      `from "/map-editor/map-account-session-guard.js?v=${assetVersion}";`,
    );
    return { filePath, source };
  }));
}

function versionReleaseArchives(source) {
  return versionReleaseReferences(source, version);
}

await recoverVersionSyncTransaction(transactionPath);
const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
const packageLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
packageJson.version = version;
packageLock.version = version;
if (packageLock.packages?.[""]) packageLock.packages[""].version = version;

let app = await fs.readFile(appPath, "utf8");
if (!/const UI_VERSION = "[^"]+";/.test(app)) throw new Error("UI_VERSION was not found in public/app.js");
app = app.replace(/const UI_VERSION = "[^"]+";/, `const UI_VERSION = "${version}";`);
if (!/const UI_VERSION_LABEL = "[^"]+";/.test(app)) throw new Error("UI_VERSION_LABEL was not found in public/app.js");
app = app.replace(/const UI_VERSION_LABEL = "[^"]+";/, `const UI_VERSION_LABEL = "${assetVersion}";`);
for (const moduleName of [
  "thread-state.js",
  "image-intent.js",
  "image-context-policy.js",
  "image-attachment-context.js",
  "game-work-mode.js",
  "map-project-session.js",
  "map-editor/map-tab-channel.js",
  "map-editor/map-conversation-channel.js",
  "conversation-state.js",
]) {
  const pattern = new RegExp(`from "\\./${moduleName.replace(".", "\\.")}(?:\\?v=[^"]+)?";`);
  if (!pattern.test(app)) throw new Error(`Versioned ${moduleName} import was not found in public/app.js`);
  app = app.replace(pattern, `from "./${moduleName}?v=${assetVersion}";`);
}
app = versionJavaScriptReferences(app);

const browserJavaScriptFiles = await versionBrowserJavaScriptFiles();

let html = await fs.readFile(htmlPath, "utf8");
html = versionAssets(html, ["styles.css", "i18n.js", "boot.js"], "public/index.html");
html = versionHtmlBrowserAssets(html);
if (!/data-version="[^"]+"/.test(html)) throw new Error("Boot loader version was not found");
html = html.replace(/data-version="[^"]+"/, `data-version="${version}"`);
if (!/data-asset-version="[^"]+"/.test(html)) throw new Error("Boot loader asset version was not found");
html = html.replace(/data-asset-version="[^"]+"/, `data-asset-version="${assetVersion}"`);
if (!/aria-label="当前(?:测试)?版本 [^，]+，检查升级"/.test(html)) {
  throw new Error("Version button label was not found");
}
html = html.replace(
  /aria-label="当前(?:测试)?版本 [^，]+，检查升级"/,
  `aria-label="当前${formalRelease ? "" : "测试"}版本 ${assetVersion}，检查升级"`,
);
if (!/data-mobile-label="[^"]*"/.test(html)) throw new Error("Mobile version label was not found");
html = html.replace(/data-mobile-label="[^"]*"/, `data-mobile-label="${compactMobileVersion(assetVersion)}"`);
html = html.replace(/id="versionLabel">v[^<]+</, `id="versionLabel">v${version}<`);
html = html.replace(/id="currentVersionValue">v[^<]+</, `id="currentVersionValue">v${assetVersion}<`);

let mapEditorHtml = await fs.readFile(mapEditorHtmlPath, "utf8");
mapEditorHtml = versionAssets(
  mapEditorHtml,
  [
    "map-editor/map-editor.css",
    "vendor/lucide/lucide.min.js",
    "vendor/pixi/pixi.min.js",
    "vendor/pixi/packages/advanced-blend-modes.min.js",
    "vendor/pixi/packages/unsafe-eval.min.js",
    "map-editor/map-editor.js",
  ],
  "public/map-editor.html",
);
mapEditorHtml = versionHtmlBrowserAssets(mapEditorHtml);
let worldEditorHtml = versionAssets(
  await fs.readFile(worldEditorHtmlPath, "utf8"),
  ["map-editor/world-editor.css", "vendor/lucide/lucide.min.js", "map-editor/world-editor.js"],
  "public/world-editor.html",
);
worldEditorHtml = versionHtmlBrowserAssets(worldEditorHtml);
let tilesetEditorHtml = versionAssets(
  await fs.readFile(tilesetEditorHtmlPath, "utf8"),
  ["map-editor/tileset-editor.css", "vendor/lucide/lucide.min.js", "map-editor/tileset-editor.js"],
  "public/tileset-editor.html",
);
tilesetEditorHtml = versionHtmlBrowserAssets(tilesetEditorHtml);
let characterEditorHtml = versionAssets(
  await fs.readFile(characterEditorHtmlPath, "utf8"),
  ["character-editor/character-editor.css", "character-editor/character-editor.js"],
  "public/character-editor.html",
);
characterEditorHtml = versionHtmlBrowserAssets(characterEditorHtml);

let loginHtml = await fs.readFile(loginHtmlPath, "utf8");
loginHtml = versionAssets(loginHtml, ["i18n.js"], "public/login.html");
loginHtml = versionHtmlBrowserAssets(loginHtml);

let sourceHtml = await fs.readFile(sourceHtmlPath, "utf8");
sourceHtml = versionHtmlBrowserAssets(sourceHtml);

let opsHtml = await fs.readFile(opsHtmlPath, "utf8");
opsHtml = versionAssets(opsHtml, ["ops.css", "i18n.js", "ops.js"], "public/ops.html");
opsHtml = versionHtmlBrowserAssets(opsHtml);

let usersHtml = await fs.readFile(usersHtmlPath, "utf8");
usersHtml = versionAssets(usersHtml, ["users.css", "i18n.js", "users.js"], "public/users.html");
usersHtml = versionHtmlBrowserAssets(usersHtml);
if (!/WFL Codex Web Workspace <strong>v[^<]+<\/strong>/.test(usersHtml)) {
  throw new Error("User management footer version was not found");
}
usersHtml = usersHtml.replace(
  /WFL Codex Web Workspace <strong>v[^<]+<\/strong>/,
  `WFL Codex Web Workspace <strong>v${version}</strong>`,
);

let mobileToolHtml = await fs.readFile(mobileToolHtmlPath, "utf8");
mobileToolHtml = versionHtmlBrowserAssets(mobileToolHtml);

let serverFileManagerHtml = await fs.readFile(serverFileManagerHtmlPath, "utf8");
serverFileManagerHtml = versionHtmlBrowserAssets(serverFileManagerHtml);

let readme = await fs.readFile(readmePath, "utf8");
if (!/Current release: `v[^`]+`/.test(readme)) throw new Error("Current release was not found in README.md");
readme = readme.replace(/Current release: `v[^`]+`/, `Current release: \`v${version}\``);
readme = versionReleaseArchives(readme);

let chineseReadme = await fs.readFile(chineseReadmePath, "utf8");
if (!/当前版本：`v[^`]+`/.test(chineseReadme)) {
  throw new Error("Current release was not found in README.zh-CN.md");
}
chineseReadme = chineseReadme.replace(/当前版本：`v[^`]+`/, `当前版本：\`v${version}\``);
chineseReadme = chineseReadme.replace(/当前发布标签 `v[^`]+`/, `当前发布标签 \`v${version}\``);
chineseReadme = versionReleaseArchives(chineseReadme);

let chineseDeployment = await fs.readFile(chineseDeploymentPath, "utf8");
chineseDeployment = versionReleaseArchives(chineseDeployment);

await commitVersionSyncTransaction({
  transactionPath,
  entries: [
    { destination: packagePath, content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { destination: lockPath, content: `${JSON.stringify(packageLock, null, 2)}\n` },
    { destination: path.join(projectDir, "VERSION"), content: `${version}\n` },
    { destination: appPath, content: app },
    { destination: htmlPath, content: html },
    { destination: mapEditorHtmlPath, content: mapEditorHtml },
    { destination: worldEditorHtmlPath, content: worldEditorHtml },
    { destination: tilesetEditorHtmlPath, content: tilesetEditorHtml },
    { destination: characterEditorHtmlPath, content: characterEditorHtml },
    ...browserJavaScriptFiles.map(({ filePath, source }) => ({ destination: filePath, content: source })),
    { destination: loginHtmlPath, content: loginHtml },
    { destination: sourceHtmlPath, content: sourceHtml },
    { destination: opsHtmlPath, content: opsHtml },
    { destination: usersHtmlPath, content: usersHtml },
    { destination: mobileToolHtmlPath, content: mobileToolHtml },
    { destination: serverFileManagerHtmlPath, content: serverFileManagerHtml },
    { destination: readmePath, content: readme },
    { destination: chineseReadmePath, content: chineseReadme },
    { destination: chineseDeploymentPath, content: chineseDeployment },
  ],
});

console.log(`Synchronized project version ${version}. Update CHANGELOG.md before release.`);
} finally {
  await syncLock.release();
}
