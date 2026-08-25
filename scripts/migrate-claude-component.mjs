import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  managedClaudeComponentDirectory,
  managedClaudeCommand,
} from "../lib/claude-component.mjs";

const projectDirectory = path.resolve(
  process.env.CODEX_DESKTOP_SOURCE_DIR || path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const runtimeDirectory = path.resolve(
  process.env.CODEX_DESKTOP_RUNTIME_DIR || path.join(projectDirectory, ".codex-runtime"),
);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await migrateBundledClaude({ projectDirectory, runtimeDirectory }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export async function migrateBundledClaude({ projectDirectory, runtimeDirectory }) {
  const targetDirectory = managedClaudeComponentDirectory(runtimeDirectory);
  const targetCommand = managedClaudeCommand(runtimeDirectory);
  const targetState = await inspectTarget(targetDirectory, targetCommand);
  if (targetState === "ready") {
    return { migrated: false, reason: "managed-present" };
  }
  if (targetState === "incomplete") {
    throw new Error("Claude Code managed component exists but is incomplete; repair it before dependency installation");
  }

  const source = await findBundledClaude(projectDirectory);
  if (!source) return { migrated: false, reason: "not-installed" };

  const claudeDirectory = path.dirname(targetDirectory);
  await fs.mkdir(claudeDirectory, { recursive: true, mode: 0o755 });
  const temporaryDirectory = await fs.mkdtemp(path.join(claudeDirectory, ".migration-"));
  try {
    const temporaryCommand = path.join(temporaryDirectory, "claude");
    await fs.copyFile(source.command, temporaryCommand);
    await fs.chmod(temporaryCommand, 0o755);
    await fs.writeFile(path.join(temporaryDirectory, "component.json"), `${JSON.stringify({
      schemaVersion: 1,
      name: "Claude Code",
      version: source.version,
      package: source.packageName,
      activationAllowed: true,
      compatibilityRisk: "legacy-migrated",
      migratedFromBundled: true,
      installedAt: Date.now(),
    }, null, 2)}\n`, { mode: 0o644 });
    await fs.chmod(temporaryDirectory, 0o755);
    try {
      await fs.rename(temporaryDirectory, targetDirectory);
    } catch (error) {
      if (error.code === "EEXIST") {
        const concurrent = await inspectTarget(targetDirectory, targetCommand);
        if (concurrent === "ready") return { migrated: false, reason: "managed-present" };
      }
      throw error;
    }
    return {
      migrated: true,
      source: "bundled",
      version: source.version,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function inspectTarget(directory, command) {
  try {
    const stat = await fs.stat(command);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return "incomplete";
    await fs.access(path.join(directory, "component.json"));
    return "ready";
  } catch (error) {
    if (error.code === "ENOENT") {
      try {
        await fs.lstat(directory);
        return "incomplete";
      } catch (directoryError) {
        if (directoryError.code === "ENOENT") return "absent";
        throw directoryError;
      }
    }
    throw error;
  }
}

async function findBundledClaude(projectDirectory) {
  const nodeModules = path.join(projectDirectory, "node_modules");
  const nodeModulesRoot = await fs.realpath(nodeModules).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!nodeModulesRoot) return null;
  const packageNames = platformPackageNames();
  for (const packageName of packageNames) {
    const packageDirectory = path.join(nodeModules, packageName);
    const source = await sourceFromPackage(packageDirectory, packageName, { allowedRoot: nodeModulesRoot });
    if (source) return source;
  }

  const wrapperPackage = path.join(nodeModules, "@anthropic-ai", "claude-code");
  return sourceFromPackage(wrapperPackage, "@anthropic-ai/claude-code", {
    command: path.join(wrapperPackage, "bin", "claude.exe"),
    allowedRoot: nodeModulesRoot,
  });
}

async function sourceFromPackage(
  packageDirectory,
  packageName,
  { command = path.join(packageDirectory, "claude"), allowedRoot = null } = {},
) {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(String(metadata.version || ""))) return null;
    const resolvedCommand = await fs.realpath(command);
    if (!allowedRoot || !isWithinRoot(resolvedCommand, allowedRoot)) return null;
    const stat = await fs.stat(resolvedCommand);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return null;
    return {
      command: resolvedCommand,
      packageName,
      version: metadata.version,
    };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isWithinRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function platformPackageNames() {
  if (process.platform !== "linux") return [];
  if (process.arch === "x64") {
    return [
      "@anthropic-ai/claude-code-linux-x64",
      "@anthropic-ai/claude-code-linux-x64-musl",
    ];
  }
  if (process.arch === "arm64") {
    return [
      "@anthropic-ai/claude-code-linux-arm64",
      "@anthropic-ai/claude-code-linux-arm64-musl",
    ];
  }
  return [];
}
