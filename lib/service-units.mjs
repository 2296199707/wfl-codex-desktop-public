import path from "node:path";
import { normalizeProjectRoots, projectRootForPath } from "./project-roots.mjs";

const SAFE_PATH = /^\/[A-Za-z0-9._+@:/-]+$/;

export const SERVICE_UNIT_NAMES = [
  "wfl-codex-desktop-restore-recovery.service",
  "wfl-codex-desktop-codex-recovery.service",
  "wfl-codex-desktop-deployment-recovery.service",
  "wfl-codex-desktop-backend@.service",
  "wfl-codex-desktop-rescue@.service",
  "wfl-codex-desktop-gateway.service",
];

export function serviceUnitVariables({
  sourceDirectory,
  projectRoot = path.dirname(sourceDirectory),
  projectRoots = null,
  defaultProject = path.join(projectRoot, "workspace"),
  stateDirectory = path.join(sourceDirectory, ".codex-desktop"),
  runtimeDirectory = path.join(sourceDirectory, ".codex-runtime"),
  nodeBinary = process.execPath,
  serviceHome = "/root",
  usersRoot = "/srv/wfl-users",
  ownerCodexHome = path.join(serviceHome, ".codex"),
  rescueCodexHomeRoot = path.join(runtimeDirectory, "rescue-codex-homes"),
  playwrightBrowsersPath = path.join(serviceHome, ".cache", "ms-playwright"),
  candidateReleasesEnabled = false,
} = {}) {
  const roots = normalizeProjectRoots(projectRoots || [projectRoot], projectRoot);
  if (!projectRootForPath(roots, defaultProject)) {
    throw new Error("DEFAULT_PROJECT must be inside one of the configured project roots");
  }
  const values = {
    SOURCE_DIR: path.resolve(sourceDirectory || ""),
    PROJECT_ROOT: path.resolve(roots[0]),
    PROJECT_ROOTS: roots.join(path.delimiter),
    DEFAULT_PROJECT: path.resolve(defaultProject),
    STATE_DIR: path.resolve(stateDirectory),
    RUNTIME_DIR: path.resolve(runtimeDirectory),
    NODE_BIN: path.resolve(nodeBinary),
    SERVICE_HOME: path.resolve(serviceHome),
    USERS_ROOT: path.resolve(usersRoot),
    OWNER_CODEX_HOME: path.resolve(ownerCodexHome),
    RESCUE_CODEX_HOME_ROOT: path.resolve(rescueCodexHomeRoot),
    PLAYWRIGHT_BROWSERS_PATH: path.resolve(playwrightBrowsersPath),
  };
  for (const [name, value] of Object.entries(values)) {
    if (!SAFE_PATH.test(value) || value.includes("..")) {
      throw new Error(`${name} must be an absolute server path without spaces or control characters`);
    }
  }
  values.SERVICE_PATH = [
    path.join(values.SERVICE_HOME, ".local", "bin"),
    path.join(values.SERVICE_HOME, ".codex", "bin"),
    path.dirname(values.NODE_BIN),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].filter((entry, index, entries) => entries.indexOf(entry) === index).join(":");
  values.CANDIDATE_RELEASES_ENABLED = candidateReleasesEnabled === true ? "1" : "0";
  return values;
}

export function renderServiceUnit(template, variables) {
  const rendered = String(template).replace(/\{\{([A-Z_]+)\}\}/g, (_match, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`Unknown service unit variable: ${name}`);
    return variables[name];
  });
  const unresolved = rendered.match(/\{\{[^}]+\}\}/);
  if (unresolved) throw new Error(`Unresolved service unit variable: ${unresolved[0]}`);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}
