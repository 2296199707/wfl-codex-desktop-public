import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectCodexRuntimeSource } from "./codex-runtime-bundle.mjs";

export async function inspectCodexInstallation({
  command,
  commandArgs = [],
  requireRuntimeBundle = false,
} = {}) {
  const codexCommand = command || await resolveCodexCommand();
  if (!Array.isArray(commandArgs) || commandArgs.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("Invalid Codex command arguments");
  }
  let versionOutput;
  try {
    versionOutput = await capture(codexCommand, [...commandArgs, "--version"]);
  } catch (error) {
    throw new Error(`Official Codex CLI is not installed or executable: ${error.message}`);
  }

  const version = versionOutput.trim().split(/\r?\n/).find((line) => line.startsWith("codex-cli "));
  if (!version) throw new Error("The codex command is not the official Codex CLI");

  let appServerHelp;
  try {
    appServerHelp = await capture(codexCommand, [...commandArgs, "app-server", "--help"]);
  } catch (error) {
    throw new Error(`Official Codex app-server is unavailable: ${error.message}`);
  }
  if (!/Usage:\s+codex app-server|Run the app server/.test(appServerHelp)) {
    throw new Error("The installed Codex CLI does not provide app-server");
  }

  if (!requireRuntimeBundle) return { version, appServerReady: true };
  const runtimeSource = await inspectCodexRuntimeSource({
    command: codexCommand,
    requireOfficial: true,
  });
  const runtimeVersion = `codex-cli ${runtimeSource.version}`;
  if (runtimeVersion !== version) {
    throw new Error("Codex CLI and its native runtime package versions do not match");
  }
  return {
    version,
    appServerReady: true,
    runtimeBundleReady: true,
    codeModeHostReady: runtimeSource.codeModeHostReady === true,
    runtimeBundleVersion: runtimeSource.version,
    runtimeBundleTarget: runtimeSource.target,
    runtimeBundleSha256: runtimeSource.treeSha256,
    runtimeBundleExecutableSha256: runtimeSource.executableSha256,
    runtimeBundleCodeModeHostSha256: runtimeSource.codeModeHostSha256,
  };
}

async function resolveCodexCommand() {
  if (process.env.CODEX_DESKTOP_CODEX_BIN) return process.env.CODEX_DESKTOP_CODEX_BIN;

  const directories = String(process.env.PATH || "").split(path.delimiter);
  if (path.isAbsolute(process.env.HOME || "")) {
    directories.push(path.join(process.env.HOME, ".local", "bin"));
    directories.push(path.join(process.env.HOME, ".codex", "bin"));
  }
  for (const directory of new Set(directories)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "codex");
    if (await fs.access(candidate, fsConstants.X_OK).then(() => true, () => false)) return candidate;
  }
  return "codex";
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.on("error", (error) => reject(new Error(error.code || error.message)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `exited with status ${code}`));
    });
  });
}
