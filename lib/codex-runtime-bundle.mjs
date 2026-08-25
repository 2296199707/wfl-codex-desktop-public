import crypto from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const STANDALONE_MANIFEST = "codex-package.json";
const CODE_MODE_HOST = process.platform === "win32"
  ? "codex-code-mode-host.exe"
  : "codex-code-mode-host";
const NATIVE_CODEX = process.platform === "win32" ? "codex.exe" : "codex";
const TARGET_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/u;

const PLATFORM_PACKAGE_BY_TARGET = Object.freeze({
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
});

/**
 * Resolve the native package that owns an official Codex command. Standalone
 * installs point at it directly; npm installs use their platform package.
 * Unknown commands are returned as legacy commands so local fixtures and
 * explicit custom installations can still start, but they cannot satisfy the
 * official runtime-bundle deployment gate.
 */
export async function inspectCodexRuntimeSource({
  command = "codex",
  environment = process.env,
  requireOfficial = false,
} = {}) {
  const commandPath = await resolveExecutable(command, environment);
  const realCommandPath = await fs.realpath(commandPath);
  const standaloneRoot = path.dirname(path.dirname(realCommandPath));
  let standalone = null;
  if (await pathExists(path.join(standaloneRoot, STANDALONE_MANIFEST))) {
    standalone = await readNativePackage(standaloneRoot, realCommandPath);
  }
  if (standalone) {
    return Object.freeze({
      ...standalone,
      installationKind: "standalone",
      commandPath,
      realCommandPath,
    });
  }

  if (path.basename(realCommandPath) === "codex.js" && path.basename(path.dirname(realCommandPath)) === "bin") {
    const wrapperRoot = path.dirname(path.dirname(realCommandPath));
    const wrapperManifest = await readJson(path.join(wrapperRoot, "package.json")).catch(() => null);
    if (wrapperManifest?.name === "@openai/codex" && VERSION_PATTERN.test(String(wrapperManifest.version || ""))) {
      const target = platformTarget();
      const platformPackage = PLATFORM_PACKAGE_BY_TARGET[target];
      const requireFromWrapper = createRequire(path.join(wrapperRoot, "package.json"));
      let platformRoot;
      try {
        platformRoot = path.dirname(requireFromWrapper.resolve(`${platformPackage}/package.json`));
      } catch {
        platformRoot = wrapperRoot;
      }
      const nativeRoot = path.join(platformRoot, "vendor", target);
      const native = await readNativePackage(nativeRoot, null, target);
      if (native.version !== wrapperManifest.version) {
        throw new Error("Codex npm wrapper and native runtime versions do not match");
      }
      return Object.freeze({
        ...native,
        installationKind: "npm",
        commandPath,
        realCommandPath,
        wrapperRoot,
        platformPackage,
      });
    }
  }

  if (requireOfficial) {
    throw new Error("The selected Codex command does not expose a complete official native runtime package");
  }
  const stat = await fs.lstat(realCommandPath);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
    throw new Error("Codex executable is invalid");
  }
  const executableSha256 = await sha256File(realCommandPath);
  return Object.freeze({
    installationKind: "legacy",
    officialPackage: false,
    commandPath,
    realCommandPath,
    executablePath: realCommandPath,
    codeModeHostPath: null,
    codeModeHostReady: false,
    version: null,
    target: null,
    treeSha256: executableSha256,
    executableSha256,
    codeModeHostSha256: null,
  });
}

/**
 * Materialize one immutable, content-addressed Codex runtime. Keeping the
 * executable, code-mode host and resources in the same directory preserves
 * the official package's relative-path contract and prevents a later upgrade
 * from changing files used by an already-running backend.
 */
export async function prepareCodexRuntimeBundle({
  command = "codex",
  runtimeDirectory,
  environment = process.env,
} = {}) {
  if (typeof runtimeDirectory !== "string" || !path.isAbsolute(runtimeDirectory)) {
    throw new Error("Codex runtime bundle directory is invalid");
  }
  const runtimeRoot = path.resolve(runtimeDirectory);
  if (runtimeRoot === path.parse(runtimeRoot).root) {
    throw new Error("Codex runtime bundle directory is invalid");
  }
  // Isolated Codex users execute the staged native binary directly. Keep the
  // bundle root traversable while the binary/resource files remain immutable;
  // a freshly-created mkdtemp directory is normally 0700 and would make a
  // valid legacy fixture (or production isolated user) fail verification.
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  await fs.chmod(runtimeRoot, 0o755);
  const source = await inspectCodexRuntimeSource({ command, environment });
  if (!source.officialPackage) {
    return prepareLegacyRuntime(source, runtimeRoot);
  }
  const bundlesRoot = path.join(runtimeRoot, "codex-runtimes");
  const bundleName = `${source.version}-${source.treeSha256}`;
  const target = path.join(bundlesRoot, bundleName);
  await fs.mkdir(bundlesRoot, { recursive: true, mode: 0o755 });
  await fs.chmod(bundlesRoot, 0o755);

  if (await pathExists(target)) {
    await verifyStagedBundle(target, source, runtimeRoot);
  } else {
    const temporary = path.join(
      bundlesRoot,
      `.${bundleName}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.cp(source.nativeRoot, temporary, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await makeRuntimeTreeReadOnly(temporary);
      await verifyStagedBundle(temporary, source, runtimeRoot);
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !await pathExists(target)) throw error;
        await verifyStagedBundle(target, source, runtimeRoot);
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }
  await probeCodeModeHost(path.join(target, "bin", CODE_MODE_HOST));

  return Object.freeze({
    executablePath: path.join(target, "bin", NATIVE_CODEX),
    codeModeHostPath: path.join(target, "bin", CODE_MODE_HOST),
    directory: target,
    installationKind: source.installationKind,
    officialPackage: true,
    runtimeBundleReady: true,
    codeModeHostReady: true,
    codeModeHostSha256: source.codeModeHostSha256,
    version: source.version,
    target: source.target,
    treeSha256: source.treeSha256,
  });
}

async function readNativePackage(nativeRoot, expectedExecutablePath = null, expectedTarget = null) {
  const manifestPath = path.join(nativeRoot, STANDALONE_MANIFEST);
  const manifest = await readJson(manifestPath);
  if (
    manifest?.layoutVersion !== 1
    || manifest.variant !== "codex"
    || manifest.entrypoint !== "bin/codex"
    || manifest.resourcesDir !== "codex-resources"
    || manifest.pathDir !== "codex-path"
    || !VERSION_PATTERN.test(String(manifest.version || ""))
    || !TARGET_PATTERN.test(String(manifest.target || ""))
    || (expectedTarget !== null && manifest.target !== expectedTarget)
  ) {
    throw new Error("Codex native runtime manifest is invalid");
  }
  const executablePath = path.join(nativeRoot, "bin", NATIVE_CODEX);
  const codeModeHostPath = path.join(nativeRoot, "bin", CODE_MODE_HOST);
  if (expectedExecutablePath !== null && expectedExecutablePath !== executablePath) {
    throw new Error("Codex command does not match its native runtime manifest");
  }
  await assertRegularExecutable(executablePath, "Codex executable");
  await assertRegularExecutable(codeModeHostPath, "Codex code-mode host");
  await Promise.all([
    assertRegularDirectory(path.join(nativeRoot, manifest.resourcesDir), "Codex resources directory"),
    assertRegularDirectory(path.join(nativeRoot, manifest.pathDir), "Codex path directory"),
  ]);
  const [treeSha256, executableSha256, codeModeHostSha256] = await Promise.all([
    sha256Tree(nativeRoot),
    sha256File(executablePath),
    sha256File(codeModeHostPath),
  ]);
  return {
    officialPackage: true,
    nativeRoot,
    manifestPath,
    executablePath,
    codeModeHostPath,
    codeModeHostReady: true,
    version: manifest.version,
    target: manifest.target,
    treeSha256,
    executableSha256,
    codeModeHostSha256,
  };
}

async function verifyStagedBundle(directory, source, accessRoot = null) {
  const staged = await readNativePackage(directory);
  if (
    staged.version !== source.version
    || staged.target !== source.target
    || staged.treeSha256 !== source.treeSha256
    || staged.executableSha256 !== source.executableSha256
    || staged.codeModeHostSha256 !== source.codeModeHostSha256
  ) {
    throw new Error("Staged Codex runtime bundle does not match the selected official package");
  }
  if (!await executableIsAccessibleToOtherUsers(staged.executablePath, accessRoot)
    || !await executableIsAccessibleToOtherUsers(staged.codeModeHostPath, accessRoot)) {
    throw new Error("Staged Codex runtime bundle is not accessible to isolated users");
  }
}

async function prepareLegacyRuntime(source, runtimeRoot) {
  const bundlesRoot = path.join(runtimeRoot, "codex-runtimes");
  const target = path.join(bundlesRoot, `legacy-${source.executableSha256}`);
  const executablePath = path.join(target, "bin", NATIVE_CODEX);
  await fs.mkdir(path.dirname(executablePath), { recursive: true, mode: 0o755 });
  await fs.chmod(bundlesRoot, 0o755);
  await fs.chmod(target, 0o755);
  await fs.chmod(path.dirname(executablePath), 0o755);
  if (!await pathExists(executablePath)) {
    const temporary = `${executablePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.copyFile(source.executablePath, temporary, fsConstants.COPYFILE_EXCL);
      await fs.chmod(temporary, 0o555);
      if (await sha256File(temporary) !== source.executableSha256) {
        throw new Error("Staged legacy Codex executable does not match its source");
      }
      try {
        await fs.rename(temporary, executablePath);
      } catch (error) {
        if (error.code !== "EEXIST" || !await pathExists(executablePath)) throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  if (await sha256File(executablePath) !== source.executableSha256
    || !await executableIsAccessibleToOtherUsers(executablePath, runtimeRoot)) {
    throw new Error("Staged legacy Codex executable failed verification");
  }
  return Object.freeze({
    executablePath,
    directory: target,
    installationKind: source.installationKind,
    officialPackage: false,
    runtimeBundleReady: false,
    codeModeHostReady: false,
    codeModeHostSha256: null,
    version: null,
    target: null,
    treeSha256: source.treeSha256,
  });
}

async function sha256Tree(root) {
  const hash = crypto.createHash("sha256");
  await hashDirectory(root, "", hash);
  return hash.digest("hex");
}

async function hashDirectory(root, relative, hash) {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childPath = path.join(root, childRelative);
    const stat = await fs.lstat(childPath);
    if (entry.isDirectory()) {
      hash.update(`d\0${childRelative}\0`);
      await hashDirectory(root, childRelative, hash);
    } else if (entry.isFile()) {
      hash.update(`f\0${childRelative}\0${stat.size}\0`);
      for await (const chunk of createReadStream(childPath)) hash.update(chunk);
    } else if (entry.isSymbolicLink()) {
      hash.update(`l\0${childRelative}\0${await fs.readlink(childPath)}\0`);
    } else {
      throw new Error(`Unsupported entry in Codex native runtime: ${childRelative}`);
    }
  }
}

async function makeRuntimeTreeReadOnly(root) {
  await makeRuntimeDirectoryReadOnly(root);
  await fs.chmod(root, 0o555);
}

async function makeRuntimeDirectoryReadOnly(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeRuntimeDirectoryReadOnly(entryPath);
      await fs.chmod(entryPath, 0o555);
    } else if (entry.isFile()) {
      const stat = await fs.lstat(entryPath);
      await fs.chmod(entryPath, stat.mode & 0o111 ? 0o555 : 0o444);
    }
  }
}

async function assertRegularExecutable(filename, label) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label} is missing from the official Codex package`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
    throw new Error(`${label} is invalid in the official Codex package`);
  }
}

async function assertRegularDirectory(filename, label) {
  const stat = await fs.lstat(filename).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label} is missing from the official Codex package`);
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is invalid in the official Codex package`);
  }
}

async function probeCodeModeHost(command) {
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const child = spawn(command, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Codex code-mode host compatibility probe timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk) => (output = `${output}${chunk}`.slice(-8_000)));
    child.stderr.on("data", (chunk) => (output = `${output}${chunk}`.slice(-8_000)));
    child.on("error", (error) => finish(new Error(`Codex code-mode host is not executable: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0 && /codex-code-mode-host|Usage:/u.test(output)) finish();
      else finish(new Error(`Codex code-mode host compatibility probe failed (${code})`));
    });
  });
}

async function resolveExecutable(command, environment) {
  const value = String(command || "").trim();
  if (!value || value.includes("\0")) throw new Error("Codex command is invalid");
  const candidates = path.isAbsolute(value)
    ? [value]
    : value.includes(path.sep)
      ? [path.resolve(value)]
      : String(environment.PATH || "").split(path.delimiter)
        .filter((directory) => path.isAbsolute(directory))
        .map((directory) => path.join(directory, value));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH entries.
    }
  }
  throw new Error("Cannot resolve the Codex command");
}

async function executableIsAccessibleToOtherUsers(filename, boundary = null) {
  const executable = path.resolve(filename);
  const accessBoundary = boundary ? path.resolve(boundary) : null;
  if (accessBoundary && (executable === accessBoundary || !isWithin(executable, accessBoundary))) return false;
  let current = executable;
  while (true) {
    let stat;
    try {
      stat = await fs.stat(current);
    } catch {
      return false;
    }
    if (current === executable) {
      if (!stat.isFile() || (stat.mode & 0o001) === 0) return false;
    } else if (!stat.isDirectory() || (stat.mode & 0o001) === 0) {
      return false;
    }
    if (accessBoundary && current === accessBoundary) return true;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function isWithin(filename, root) {
  const relative = path.relative(root, filename);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function platformTarget() {
  const key = `${process.platform}:${process.arch}`;
  const targets = {
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
  };
  const target = targets[key];
  if (!target) throw new Error(`Unsupported Codex native platform: ${key}`);
  return target;
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function pathExists(filename) {
  return fs.access(filename).then(() => true, () => false);
}
