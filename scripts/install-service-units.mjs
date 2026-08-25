import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderServiceUnit,
  SERVICE_UNIT_NAMES,
  serviceUnitVariables,
} from "../lib/service-units.mjs";
import {
  normalizeBrowsersPath,
  readPlaywrightBrowsersPath,
} from "../lib/playwright-browser.mjs";
import { normalizeProjectRoots, projectRootForPath } from "../lib/project-roots.mjs";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeDir = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDir, ".codex-runtime"),
);
const savedDeployment = await readSavedDeployment();
const outputDir = path.resolve(optionValue("--output-dir") || path.join(runtimeDir, "systemd"));
const installSystem = process.argv.includes("--install-system");
const includeRescue = process.argv.includes("--include-rescue");
if (includeRescue && process.argv.includes("--main-only")) {
  throw new Error("--main-only and --include-rescue cannot be used together");
}
// Ordinary installation is main-only. The frozen rescue component may only
// enter this script through an explicit owner-requested flag.
const mainOnly = !includeRescue;

if (installSystem && process.env.CODEX_DESKTOP_INSTALL_LOCK_HELD !== "1") {
  await runLockedSelf();
  process.exit(0);
}
const serviceHome = process.env.CODEX_DESKTOP_SERVICE_HOME
  || savedDeployment?.serviceHome
  || os.homedir();
const playwrightBrowsersPath = normalizeBrowsersPath(
  process.env.CODEX_DESKTOP_PLAYWRIGHT_BROWSERS_PATH
    || process.env.PLAYWRIGHT_BROWSERS_PATH,
)
  || await readPlaywrightBrowsersPath(runtimeDir)
  || path.join(serviceHome, ".cache", "ms-playwright");
const variables = serviceUnitVariables({
  sourceDirectory: process.env.CODEX_DESKTOP_SOURCE_DIR || projectDir,
  projectRoot: process.env.CODEX_DESKTOP_PROJECT_ROOT
    || savedDeployment?.projectRoot
    || path.dirname(projectDir),
  projectRoots: process.env.CODEX_DESKTOP_PROJECT_ROOTS
    || savedDeployment?.projectRoots
    || null,
  defaultProject: process.env.CODEX_DESKTOP_DEFAULT_PROJECT
    || savedDeployment?.defaultProject
    || path.join(path.dirname(projectDir), "workspace"),
  stateDirectory: process.env.CODEX_DESKTOP_STATE_DIR
    || savedDeployment?.stateDirectory
    || path.join(projectDir, ".codex-desktop"),
  runtimeDirectory: runtimeDir,
  nodeBinary: process.execPath,
  serviceHome,
  usersRoot: process.env.CODEX_DESKTOP_MULTI_USER_ROOT
    || savedDeployment?.usersRoot
    || "/srv/wfl-users",
  ownerCodexHome: process.env.CODEX_DESKTOP_OWNER_CODEX_HOME
    || savedDeployment?.ownerCodexHome
    || path.join(serviceHome, ".codex"),
  playwrightBrowsersPath,
  candidateReleasesEnabled: process.env.CODEX_DESKTOP_CANDIDATE_RELEASES_ENABLED === "1"
    || savedDeployment?.candidateReleasesEnabled === true,
});

if (installSystem && process.getuid?.() !== 0) {
  throw new Error("Installing systemd units requires root");
}
if (includeRescue && await rescueStateExists() && process.env.CODEX_DESKTOP_RESCUE_INSTALL_APPROVED !== "1") {
  throw new Error(
    "An existing rescue component was detected; ordinary service preparation is main-only and will not replace it",
  );
}

await ensureProjectDirectories(variables.PROJECT_ROOTS, variables.DEFAULT_PROJECT);
await Promise.all([
  ensureRealDirectory(runtimeDir, 0o755),
  ensureRealDirectory(outputDir, 0o755),
  ensureRealDirectory(variables.STATE_DIR, 0o700),
]);
await fs.chmod(variables.STATE_DIR, 0o700);
if (installSystem) {
  await Promise.all([
    assertRootOwnedPath(variables.SOURCE_DIR),
    ...normalizeProjectRoots(variables.PROJECT_ROOTS).map((root) => assertRootOwnedPath(root)),
    assertRootOwnedPath(variables.DEFAULT_PROJECT),
    assertRootOwnedPath(variables.STATE_DIR),
    assertRootOwnedPath(runtimeDir),
    assertRootOwnedPath(outputDir),
    assertRootOwnedPath("/etc/systemd/system"),
  ]);
}
const unitNames = mainOnly
  ? SERVICE_UNIT_NAMES.filter((name) => name !== "wfl-codex-desktop-rescue@.service")
  : SERVICE_UNIT_NAMES;
if (!mainOnly) await ensureRescueSlot(runtimeDir, variables.SOURCE_DIR);
for (const name of unitNames) {
  const template = await fs.readFile(path.join(projectDir, "systemd", `${name}.template`), "utf8");
  const rendered = renderServiceUnit(template, variables);
  await atomicWrite(path.join(outputDir, name), rendered, 0o644);
}

await atomicWrite(
  path.join(runtimeDir, "deployment.json"),
  `${JSON.stringify({
    sourceDirectory: variables.SOURCE_DIR,
    projectRoot: variables.PROJECT_ROOT,
    projectRoots: normalizeProjectRoots(variables.PROJECT_ROOTS),
    defaultProject: variables.DEFAULT_PROJECT,
    stateDirectory: variables.STATE_DIR,
    runtimeDirectory: variables.RUNTIME_DIR,
    nodeBinary: variables.NODE_BIN,
    serviceHome: variables.SERVICE_HOME,
    usersRoot: variables.USERS_ROOT,
    ownerCodexHome: variables.OWNER_CODEX_HOME,
    playwrightBrowsersPath: variables.PLAYWRIGHT_BROWSERS_PATH,
    candidateReleasesEnabled: variables.CANDIDATE_RELEASES_ENABLED === "1",
    installedAt: Date.now(),
  }, null, 2)}\n`,
  0o600,
);

if (installSystem) {
  for (const name of unitNames) {
    await atomicCopy(path.join(outputDir, name), path.join("/etc/systemd/system", name));
  }
  await run("systemctl", ["daemon-reload"]);
  if (!mainOnly) {
    await run("systemctl", ["enable", "--now", "wfl-codex-desktop-rescue@4321.service"]);
  }
}

console.log(`Prepared systemd units in ${outputDir}`);
if (installSystem) console.log("Installed systemd units without restarting the stable gateway");

async function ensureProjectDirectories(projectRoots, defaultProject) {
  const roots = normalizeProjectRoots(projectRoots);
  if (!projectRootForPath(roots, defaultProject)) {
    throw new Error("Default project must be a child of one of the project roots");
  }
  await Promise.all(roots.map((root) => ensureRealDirectory(root, 0o755)));
  await ensureRealDirectory(defaultProject, 0o750);
}

async function ensureRescueSlot(runtimeDirectory, sourceDirectory) {
  const rescueDirectory = path.join(runtimeDirectory, "rescue-slots", "4321");
  const legacyCandidates = [
    path.join(runtimeDirectory, "rescue"),
    path.join(runtimeDirectory, "rescue-slot"),
    path.join(runtimeDirectory, "rescue-slots", "4320"),
  ];
  await fs.mkdir(path.dirname(rescueDirectory), { recursive: true, mode: 0o755 });
  let target = await capableSymlinkTarget(rescueDirectory, { allowIncapable: true });
  if (!target) {
    for (const candidate of legacyCandidates) {
      target = await capableSymlinkTarget(candidate, { allowIncapable: true });
      if (target) break;
    }
  }
  if (!target) {
    try {
      const activeBackendPortText = await readRegularFile(path.join(runtimeDirectory, "active-port"));
      if (activeBackendPortText === null) throw new Error("Active backend port is missing");
      const activeBackendPort = activeBackendPortText.trim();
      if (!/^431[89]$/.test(activeBackendPort)) throw new Error("Active backend port is invalid");
      const activeSlot = await fs.realpath(path.join(runtimeDirectory, "slots", activeBackendPort));
      await assertRescueCapable(activeSlot);
      target = activeSlot;
    } catch {
      target = await fs.realpath(sourceDirectory);
      await assertRescueCapable(target);
    }
  }
  const existing = await fs.lstat(rescueDirectory).catch((error) => (
    error.code === "ENOENT" ? null : Promise.reject(error)
  ));
  if (existing && !existing.isSymbolicLink()) {
    throw new Error("Existing rescue directory must be a symbolic link");
  }
  if (!existing) await atomicSymlink(target, rescueDirectory);
  else if (await fs.realpath(rescueDirectory) !== target) await atomicSymlink(target, rescueDirectory, { replace: true });
  return 4321;
}

async function rescueStateExists() {
  const filenames = [
    path.join(runtimeDir, "rescue"),
    path.join(runtimeDir, "rescue-active-port"),
    path.join(runtimeDir, "rescue-slot"),
  ];
  // A portable render must be isolated from the host's installed units. Only
  // a real system installation may use the system unit as evidence that the
  // frozen rescue component already exists.
  if (installSystem) {
    filenames.push(
      "/etc/systemd/system/wfl-codex-desktop-rescue.service",
      "/etc/systemd/system/wfl-codex-desktop-rescue@.service",
    );
  }
  for (const filename of filenames) {
    const stat = await fs.lstat(filename).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat) return true;
  }
  const slotsDirectory = path.join(runtimeDir, "rescue-slots");
  const slotsStat = await fs.lstat(slotsDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (slotsStat) {
    if (slotsStat.isSymbolicLink() || !slotsStat.isDirectory()) return true;
    if ((await fs.readdir(slotsDirectory)).length > 0) return true;
  }
  return false;
}

async function capableSymlinkTarget(filename, { allowIncapable = false } = {}) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw new Error(`Existing rescue slot must be a symbolic link: ${filename}`);
  const target = await fs.realpath(filename);
  try {
    await assertRescueCapable(target);
  } catch (error) {
    if (!allowIncapable) throw error;
    return null;
  }
  return target;
}

async function atomicSymlink(target, destination) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.symlink(target, temporary, "dir");
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertRescueCapable(directory) {
  await Promise.all([
    fs.access(path.join(directory, "server.mjs")),
    fs.access(path.join(directory, "node_modules")),
    fs.access(path.join(directory, "public", "rescue.html")),
    fs.access(path.join(directory, "public", "rescue.js")),
    fs.access(path.join(directory, "public", "rescue.css")),
    Promise.any([
      fs.access(path.join(directory, "systemd", "wfl-codex-desktop-rescue@.service.template")),
      fs.access(path.join(directory, "systemd", "wfl-codex-desktop-rescue.service.template")),
    ]),
  ]);
}

async function readSavedDeployment() {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(runtimeDir, "deployment.json"), "utf8"));
    return saved && typeof saved === "object" ? saved : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read saved deployment configuration: ${error.message}`);
  }
}

async function atomicWrite(destination, content, mode) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, mode);
    await syncDirectory(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const existing = await fs.lstat(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace symbolic-link systemd unit: ${destination}`);
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function assertRootOwnedPath(target) {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Systemd path must contain only real directories: ${current}`);
    }
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`Systemd path must be root-owned and not group/world-writable: ${current}`);
    }
  }
}

async function ensureRealDirectory(directory, mode) {
  const existing = await fs.lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error(`Expected a real directory: ${directory}`);
  }
  await fs.mkdir(directory, { recursive: true, mode });
  const created = await fs.lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Expected a real directory: ${directory}`);
  }
  await fs.chmod(directory, mode);
}

async function readRegularFile(filename) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Expected a regular state file: ${filename}`);
  }
  return fs.readFile(filename, "utf8");
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runLockedSelf() {
  const lockPath = process.env.CODEX_DESKTOP_INSTALL_LOCK_PATH
    || "/run/lock/wfl-codex-desktop-install.lock";
  await new Promise((resolve, reject) => {
    const child = spawn("flock", [
      "-n",
      lockPath,
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ], {
      cwd: projectDir,
      env: { ...process.env, CODEX_DESKTOP_INSTALL_LOCK_HELD: "1" },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unable to acquire the installation lock (exit ${code})`));
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectDir, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with status ${code}`));
    });
  });
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
