import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PROFILE_PATH = "/etc/apparmor.d/wfl-codex-desktop-userns";
const APPARMOR_PARSER = "/usr/sbin/apparmor_parser";
const BWRAP = "/usr/bin/bwrap";

export async function installCodexUsernsProfile({
  command = "codex",
  destination = PROFILE_PATH,
  parser = APPARMOR_PARSER,
  procRoot = "/proc",
  runner = run,
} = {}) {
  if (await readTrimmed(path.join(procRoot, "sys/kernel/apparmor_restrict_unprivileged_userns")) !== "1") {
    return { installed: false, reason: "restriction-disabled" };
  }
  await Promise.all([fs.access(parser), fs.access(BWRAP)]).catch(() => {
    throw new Error("AppArmor userns restriction is active, but apparmor_parser or bubblewrap is unavailable");
  });
  const binaries = await discoverCodexNativeBinaries(command);
  if (!binaries.length) throw new Error("Unable to locate the official Codex native binary for its AppArmor profile");
  const content = renderCodexUsernsProfile(binaries);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o644 });
  await fs.rename(temporary, destination);
  await fs.chmod(destination, 0o644);
  await runner(parser, ["--replace", "--skip-read-cache", destination]);
  return { installed: true, binaries };
}

export async function discoverCodexNativeBinaries(command = "codex", { envPath = process.env.PATH } = {}) {
  const executable = command.includes("/") ? path.resolve(command) : await findExecutable(command, envPath);
  if (!executable) return [];
  const resolved = await fs.realpath(executable);
  const stat = await fs.stat(resolved);
  if (stat.size >= 1024 * 1024 && path.basename(resolved) === "codex") return [resolved];
  const packageRoot = path.basename(resolved) === "codex.js"
    ? path.dirname(path.dirname(resolved))
    : path.dirname(resolved);
  const matches = [];
  await walk(packageRoot, 0, matches);
  return [...new Set(matches)].sort();
}

export function renderCodexUsernsProfile(binaries) {
  const paths = [...new Set(binaries.map(validateAttachmentPath))].sort();
  if (!paths.length) throw new Error("At least one Codex native binary is required");
  const profiles = paths.map((binary, index) => `profile wfl-codex-native-${index + 1} "${binary}" flags=(unconfined) {
  userns,
  ${BWRAP} px -> wfl-codex-bwrap-${index + 1},
  profile wfl-codex-bwrap-${index + 1} ${BWRAP} flags=(unconfined) {
    userns,
  }
}`);
  return `# Managed by WFL Codex Desktop. Allows only Codex-launched bubblewrap user namespaces.
abi <abi/4.0>,
include <tunables/global>

${profiles.join("\n\n")}
`;
}

async function walk(directory, depth, matches) {
  if (depth > 9 || matches.length > 8) return;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(candidate, depth + 1, matches);
      continue;
    }
    if (!entry.isFile() || entry.name !== "codex") continue;
    const stat = await fs.stat(candidate);
    if (stat.size >= 1024 * 1024 && (stat.mode & 0o111)) matches.push(await fs.realpath(candidate));
  }
}

async function findExecutable(command, envPath = "") {
  for (const directory of String(envPath || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

function validateAttachmentPath(value) {
  const candidate = path.resolve(String(value || ""));
  if (!/^\/[A-Za-z0-9._+@/-]+$/.test(candidate) || candidate.includes("..")) {
    throw new Error("Codex native binary path is not safe for an AppArmor attachment");
  }
  return candidate;
}

async function readTrimmed(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}
