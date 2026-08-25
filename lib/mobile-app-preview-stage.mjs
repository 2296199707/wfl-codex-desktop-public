import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

const DEPENDENCY_SECTIONS = ["dependencies", "dev_dependencies", "dependency_overrides"];
const EXCLUDED_NAMES = new Set([
  ".dart_tool",
  ".flutter-plugins",
  ".flutter-plugins-dependencies",
  ".git",
  ".gradle",
  ".hg",
  ".idea",
  ".packages",
  ".svn",
  ".symlinks",
  ".vscode",
  ".wfl-path-dependencies",
  "Pods",
  "build",
  "coverage",
  "node_modules",
]);

export async function stageMobilePreviewProject(projectDirectory, previewDirectory) {
  const projectRoot = await fs.realpath(path.resolve(projectDirectory));
  const previewRoot = path.resolve(previewDirectory);
  if (previewRoot === projectRoot || isInside(projectRoot, previewRoot)) {
    throw new Error("移动预览构建目录不能位于源工程内");
  }
  await requirePubspec(projectRoot);

  const destinations = new Map([[projectRoot, previewRoot]]);
  const processing = new Set();
  const processed = new Set();

  const destinationFor = (source, packageName) => {
    const existing = destinations.get(source);
    if (existing) return existing;
    const relative = path.relative(projectRoot, source);
    const destination = relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
      ? path.join(previewRoot, relative)
      : path.join(
        previewRoot,
        ".wfl-path-dependencies",
        `${safePackageName(packageName)}-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 10)}`,
      );
    destinations.set(source, destination);
    return destination;
  };

  const stagePackage = async (source, destination) => {
    if (processed.has(source) || processing.has(source)) return;
    processing.add(source);
    await copyProjectTree(source, destination);
    const sourcePubspec = path.join(source, "pubspec.yaml");
    const document = parseDocument(await fs.readFile(sourcePubspec, "utf8"));
    if (document.errors.length) throw new Error(`Flutter pubspec.yaml 无法解析：${document.errors[0].message}`);
    const pubspec = document.toJS({ mapAsMap: false }) || {};

    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = pubspec[section];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const [packageName, specification] of Object.entries(dependencies)) {
        const localPath = specification && typeof specification === "object" && !Array.isArray(specification)
          ? specification.path
          : null;
        if (typeof localPath !== "string" || !localPath.trim()) continue;
        const dependencySource = await fs.realpath(path.resolve(source, localPath));
        await requirePubspec(dependencySource, packageName);
        const dependencyDestination = destinationFor(dependencySource, packageName);
        await stagePackage(dependencySource, dependencyDestination);
        let rewritten = path.relative(destination, dependencyDestination).split(path.sep).join("/");
        if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
        document.setIn([section, packageName, "path"], rewritten);
      }
    }

    await fs.writeFile(path.join(destination, "pubspec.yaml"), document.toString(), { mode: 0o640 });
    processing.delete(source);
    processed.add(source);
  };

  await stagePackage(projectRoot, previewRoot);
  return {
    projectRoot,
    previewRoot,
    localDependencies: [...destinations.entries()]
      .filter(([source]) => source !== projectRoot)
      .map(([source, destination]) => ({ source, destination })),
  };
}

export async function resetMobilePreviewWorkspace(workspaceDirectory) {
  const workspace = path.resolve(workspaceDirectory);
  await fs.mkdir(workspace, { recursive: true, mode: 0o750 });
  const entries = await fs.readdir(workspace, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => ![".dart_tool", "build"].includes(entry.name))
    .map((entry) => fs.rm(path.join(workspace, entry.name), { recursive: true, force: true })));
  await fs.rm(path.join(workspace, "build", "web"), { recursive: true, force: true });
}

export async function publishMobilePreviewWeb(sourceWebDirectory, previewDirectory) {
  const source = await fs.realpath(path.resolve(sourceWebDirectory));
  const destinationRoot = path.resolve(previewDirectory);
  const buildDirectory = path.join(destinationRoot, "build");
  const identity = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const next = path.join(buildDirectory, `.web-next-${identity}`);
  const previous = path.join(buildDirectory, `.web-previous-${identity}`);
  const destination = path.join(buildDirectory, "web");
  await fs.mkdir(buildDirectory, { recursive: true, mode: 0o750 });
  await fs.cp(source, next, { recursive: true, force: true });
  let movedPrevious = false;
  try {
    await fs.rename(destination, previous);
    movedPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(next, destination);
  } catch (error) {
    if (movedPrevious) await fs.rename(previous, destination).catch(() => {});
    throw error;
  }
  if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
}

async function copyProjectTree(source, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o750 });
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      if (!relative) return true;
      return !relative.split(path.sep).some((part) => EXCLUDED_NAMES.has(part));
    },
  });
}

async function requirePubspec(directory, packageName = null) {
  const stat = await fs.stat(path.join(directory, "pubspec.yaml")).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(packageName
      ? `本地 path 依赖 ${packageName} 缺少 pubspec.yaml`
      : "移动 App 工程缺少 pubspec.yaml");
  }
}

function safePackageName(value) {
  const normalized = String(value || "dependency").replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "dependency";
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
