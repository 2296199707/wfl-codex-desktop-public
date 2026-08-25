import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectCodexInstallation } from "./codex-prerequisite.mjs";
import { inspectCodexRuntimeSource } from "./codex-runtime-bundle.mjs";

const JOURNAL_SCHEMA = 4;
const LEGACY_JOURNAL_SCHEMAS = new Set([1, 2, 3]);
const JOURNAL_NAME = "codex-install-recovery.json";
const NPM_BACKUP_LAYOUT = "npm-composite-v1";
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/;
const STANDALONE_TARGET_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const NATIVE_PACKAGE_NAME_PATTERN = /^@openai\/codex-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function prepareCodexInstallRecovery({
  runtimeDirectory,
  operationId,
  command,
  versionOutput,
  appVersion,
  environment = process.env,
  syncPath = syncFilesystemPath,
} = {}) {
  const runtime = path.resolve(runtimeDirectory || "");
  const id = validateOperationId(operationId);
  const beforeVersion = parseCodexVersion(versionOutput);
  const journalPath = path.join(runtime, JOURNAL_NAME);
  if (await pathExists(journalPath)) {
    throw new Error("A previous Codex installation recovery must complete before another update");
  }

  const installation = await inspectOfficialInstallation(command, beforeVersion, environment);
  const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 20);
  const backupPath = path.join(installation.storageRoot, `.wfl-codex-backup-${digest}`);
  const backupTemporary = `${backupPath}.tmp-${process.pid}`;
  const packageDevice = (await fs.stat(installation.packageRoot)).dev;
  const backupDevice = (await fs.stat(installation.storageRoot)).dev;
  if (packageDevice !== backupDevice) throw new Error("Codex recovery backup must use the package filesystem");
  if (installation.nativePackageRoot && (await fs.stat(installation.nativePackageRoot)).dev !== backupDevice) {
    throw new Error("Codex native recovery backup must use the package filesystem");
  }

  await fs.mkdir(runtime, { recursive: true, mode: 0o755 });
  await fs.rm(backupTemporary, { recursive: true, force: true });
  if (await pathExists(backupPath)) throw new Error("Codex recovery backup already exists");

  try {
    if (installation.installationKind === "npm" && installation.nativePackageRoot) {
      await fs.mkdir(backupTemporary, { recursive: true, mode: 0o700 });
      await copyDirectory(installation.packageRoot, path.join(backupTemporary, "wrapper"));
      await copyDirectory(installation.nativePackageRoot, path.join(backupTemporary, "native"));
      await verifyNpmPackagePair(
        backupTemporary,
        beforeVersion,
        installation.nativePackageName,
        installation.nativeTarget,
      );
    } else {
      await copyDirectory(installation.packageRoot, backupTemporary);
      await verifyInstallationTree(
        installation.installationKind,
        backupTemporary,
        beforeVersion,
        installation.standaloneTarget,
      );
    }
    await syncPath(backupTemporary);
    await fs.rename(backupTemporary, backupPath);
    await syncDirectory(installation.storageRoot);

    const journal = {
      schemaVersion: JOURNAL_SCHEMA,
      state: "prepared",
      operationId: id,
      appVersion: validateAppVersion(appVersion),
      beforeVersion,
      installationKind: installation.installationKind,
      packageRoot: installation.packageRoot,
      storageRoot: installation.storageRoot,
      backupPath,
      commandPath: installation.commandPath,
      commandLinkTarget: installation.commandLinkTarget,
      entrypointRelative: installation.entrypointRelative,
      ...(installation.installationKind === "npm"
        ? {
          globalModulesRoot: installation.storageRoot,
          ...(installation.nativePackageRoot ? {
            backupLayout: NPM_BACKUP_LAYOUT,
            nativePackageRoot: installation.nativePackageRoot,
            nativePackageRelative: installation.nativePackageRelative,
            nativeRoot: installation.nativeRoot,
            nativePackageName: installation.nativePackageName,
            nativeTarget: installation.nativeTarget,
          } : {}),
        }
        : {
            standaloneRoot: installation.standaloneRoot,
            standaloneTarget: installation.standaloneTarget,
            selectorPath: installation.selectorPath,
            selectorLinkTarget: installation.selectorLinkTarget,
          }),
      preparedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await durableWriteJson(journalPath, journal);
    return structuredClone(journal);
  } catch (error) {
    await fs.rm(backupTemporary, { recursive: true, force: true }).catch(() => {});
    if (!await pathExists(journalPath)) {
      await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function readCodexInstallRecovery(runtimeDirectory) {
  const journalPath = path.join(path.resolve(runtimeDirectory || ""), JOURNAL_NAME);
  try {
    return validateJournal(JSON.parse(await fs.readFile(journalPath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("Codex installation recovery journal is invalid");
    throw error;
  }
}

export async function restoreCodexInstallRecovery({
  runtimeDirectory,
  inspectInstallation = inspectCodexInstallation,
  syncPath = syncFilesystemPath,
} = {}) {
  const runtime = path.resolve(runtimeDirectory || "");
  const journalPath = path.join(runtime, JOURNAL_NAME);
  let journal = await readCodexInstallRecovery(runtime);
  if (!journal) return { restored: false, journal: null };
  if (journal.state === "update-committed" || journal.state === "rollback-committed") {
    return { restored: false, journal };
  }

  await verifyRecoveryBackup(journal);
  const digest = crypto.createHash("sha256").update(journal.operationId).digest("hex").slice(0, 20);
  const restorePath = path.join(path.dirname(journal.packageRoot), `.codex-wfl-restore-${digest}`);
  const failedPath = path.join(journal.storageRoot, `.wfl-codex-failed-${digest}`);

  if (!await installationMatches(journal)) {
    journal = await updateJournal(journalPath, journal, "restoring");
    await fs.rm(restorePath, { recursive: true, force: true });
    if (isCompositeNpmJournal(journal)) {
      await fs.mkdir(restorePath, { recursive: true, mode: 0o700 });
      await copyDirectory(path.join(journal.backupPath, "wrapper"), path.join(restorePath, "wrapper"));
      await copyDirectory(path.join(journal.backupPath, "native"), path.join(restorePath, "native"));
      await verifyNpmPackagePair(
        restorePath,
        journal.beforeVersion,
        journal.nativePackageName,
        journal.nativeTarget,
      );
      await syncPath(restorePath);
      await restoreNpmPackagePair(journal, restorePath, failedPath);
    } else {
      await copyDirectory(journal.backupPath, restorePath);
      await verifyInstallationTree(
        journal.installationKind,
        restorePath,
        journal.beforeVersion,
        journal.standaloneTarget,
      );
      await syncPath(restorePath);
      await fs.rm(failedPath, { recursive: true, force: true });
      if (await pathExists(journal.packageRoot)) await fs.rename(journal.packageRoot, failedPath);
      try {
        await fs.rename(restorePath, journal.packageRoot);
      } catch (error) {
        if (!await pathExists(journal.packageRoot) && await pathExists(failedPath)) {
          await fs.rename(failedPath, journal.packageRoot).catch(() => {});
        }
        throw error;
      }
      await syncDirectory(path.dirname(journal.packageRoot));
    }
  }

  await restoreInstallationLinks(journal);
  const inspected = await inspectInstallation({
    command: path.join(journal.packageRoot, journal.entrypointRelative),
  });
  if (parseCodexVersion(inspected.version) !== journal.beforeVersion) {
    throw new Error("Restored Codex CLI version does not match the recovery journal");
  }
  journal = await updateJournal(journalPath, journal, "package-restored", { packageRestoredAt: Date.now() });
  return { restored: true, journal };
}

export async function completeCodexInstallRecovery(runtimeDirectory, { beforeJournalRemoval } = {}) {
  const journal = await readCodexInstallRecovery(runtimeDirectory);
  if (!journal) return false;
  if (journal.state !== "update-committed" && journal.state !== "rollback-committed") {
    throw new Error("Codex installation recovery outcome must be committed before cleanup");
  }
  const runtime = path.resolve(runtimeDirectory || "");
  const journalPath = path.join(runtime, JOURNAL_NAME);
  const digest = crypto.createHash("sha256").update(journal.operationId).digest("hex").slice(0, 20);
  await Promise.all([
    fs.rm(journal.backupPath, { recursive: true, force: true }),
    fs.rm(path.join(journal.storageRoot, `.wfl-codex-failed-${digest}`), { recursive: true, force: true }),
    fs.rm(path.join(path.dirname(journal.packageRoot), `.codex-wfl-restore-${digest}`), { recursive: true, force: true }),
  ]);
  await syncDirectory(journal.storageRoot);
  if (beforeJournalRemoval) await beforeJournalRemoval(structuredClone(journal));
  await fs.rm(journalPath, { force: true });
  await syncDirectory(runtime);
  return true;
}

export async function holdCodexInstallRecoveryForDecision(runtimeDirectory, versionOutput) {
  const runtime = path.resolve(runtimeDirectory || "");
  const journalPath = path.join(runtime, JOURNAL_NAME);
  const journal = await readCodexInstallRecovery(runtime);
  if (!journal) return null;
  const afterVersion = parseCodexVersion(versionOutput);
  if (journal.state === "decision-pending") {
    if (journal.afterVersion !== afterVersion) {
      throw new Error("Pending Codex decision version does not match the selected installation");
    }
    return journal;
  }
  if (journal.state !== "prepared") {
    throw new Error("Only a prepared Codex installation can wait for an owner decision");
  }
  return updateJournal(journalPath, journal, "decision-pending", {
    afterVersion,
    decisionPendingAt: Date.now(),
  });
}

export async function commitCodexInstallRecovery(runtimeDirectory, versionOutput) {
  const runtime = path.resolve(runtimeDirectory || "");
  const journalPath = path.join(runtime, JOURNAL_NAME);
  let journal = await readCodexInstallRecovery(runtime);
  if (!journal) return null;
  const afterVersion = parseCodexVersion(versionOutput);
  if (journal.state === "update-committed") {
    if (journal.afterVersion !== afterVersion) {
      throw new Error("Committed Codex update version does not match the requested outcome");
    }
    return journal;
  }
  if (!["prepared", "decision-pending"].includes(journal.state)) {
    throw new Error("Only a prepared or owner-approved Codex installation can be committed as an update");
  }
  return updateJournal(journalPath, journal, "update-committed", {
    afterVersion,
    updateCommittedAt: Date.now(),
  });
}

export async function commitCodexInstallRollback(runtimeDirectory) {
  const runtime = path.resolve(runtimeDirectory || "");
  const journalPath = path.join(runtime, JOURNAL_NAME);
  let journal = await readCodexInstallRecovery(runtime);
  if (!journal) return null;
  if (journal.state === "rollback-committed") return journal;
  if (journal.state !== "package-restored") {
    throw new Error("Only a verified restored Codex installation can be committed as a rollback");
  }
  return updateJournal(journalPath, journal, "rollback-committed", { rollbackCommittedAt: Date.now() });
}

export function parseCodexVersion(value) {
  const match = /^codex-cli\s+([^\s]+)$/i.exec(String(value || "").trim());
  if (!match || !VERSION_PATTERN.test(match[1])) throw new Error("Invalid official Codex version output");
  return match[1];
}

export async function verifyCodexInstallRecoverySelection(
  journalValue,
  versionOutput,
  environment = process.env,
) {
  const journal = validateJournal(journalValue);
  const expectedVersion = parseCodexVersion(versionOutput);
  const selected = await inspectOfficialInstallation(
    journal.commandPath,
    expectedVersion,
    environment,
    { requireNative: journal.installationKind !== "npm" || journal.schemaVersion >= JOURNAL_SCHEMA },
  );
  if (selected.installationKind !== journal.installationKind) {
    throw new Error("Updated Codex installation kind does not match the recovery journal");
  }
  if (selected.commandPath !== journal.commandPath || selected.storageRoot !== journal.storageRoot) {
    throw new Error("Updated Codex installation escaped the verified recovery root");
  }
  if (journal.installationKind === "npm") {
    if (selected.packageRoot !== journal.packageRoot) {
      throw new Error("Updated Codex npm package root does not match the recovery journal");
    }
    if (isCompositeNpmJournal(journal) && (
      selected.nativePackageRoot !== journal.nativePackageRoot
      || selected.nativeRoot !== journal.nativeRoot
      || selected.nativePackageName !== journal.nativePackageName
      || selected.nativeTarget !== journal.nativeTarget
    )) {
      throw new Error("Updated Codex native package does not match the recovery journal");
    }
  }
  if (
    journal.installationKind === "standalone"
    && (
      selected.standaloneRoot !== journal.standaloneRoot
      || selected.selectorPath !== journal.selectorPath
    )
  ) {
    throw new Error("Updated Codex standalone selector does not match the recovery journal");
  }
  return selected;
}

async function inspectOfficialInstallation(
  command,
  expectedVersion,
  environment,
  { requireNative = true } = {},
) {
  const commandPath = await resolveExecutable(command, environment);
  const commandStat = await fs.lstat(commandPath);
  if (!commandStat.isSymbolicLink()) {
    throw new Error("Web Codex updates require an official Codex command symlink");
  }
  const commandLinkTarget = await fs.readlink(commandPath);
  const realEntrypoint = await fs.realpath(commandPath);
  const packageRoot = path.dirname(path.dirname(realEntrypoint));
  const entrypointRelative = path.relative(packageRoot, realEntrypoint);
  if (entrypointRelative === path.join("bin", "codex.js")) {
    if (path.basename(packageRoot) !== "codex" || path.basename(path.dirname(packageRoot)) !== "@openai") {
      throw new Error("The Codex command is not installed as @openai/codex");
    }
    const storageRoot = path.dirname(path.dirname(packageRoot));
    await verifyInstallationTree("npm", packageRoot, expectedVersion);
    if (!requireNative) {
      return {
        installationKind: "npm",
        commandPath,
        commandLinkTarget,
        packageRoot,
        storageRoot,
        entrypointRelative,
      };
    }
    const runtimeSource = await inspectCodexRuntimeSource({
      command: commandPath,
      environment,
      requireOfficial: true,
    });
    if (runtimeSource.installationKind !== "npm" || runtimeSource.wrapperRoot !== packageRoot) {
      throw new Error("The Codex npm command does not expose its expected native package");
    }
    const nativePackageRoot = path.resolve(
      path.dirname(path.dirname(runtimeSource.nativeRoot)),
    );
    const nativePackageRelative = path.relative(storageRoot, nativePackageRoot);
    if (!isSafeRelativePath(nativePackageRelative) || !isWithin(nativePackageRoot, storageRoot)) {
      throw new Error("The Codex native package escaped the npm module root");
    }
    if (isWithin(nativePackageRoot, packageRoot) || nativePackageRoot === packageRoot) {
      throw new Error("The Codex native package cannot be nested inside the wrapper package");
    }
    const nativePackageManifest = JSON.parse(
      await fs.readFile(path.join(nativePackageRoot, "package.json"), "utf8"),
    );
    await verifyNativePackageTree(
      nativePackageRoot,
      expectedVersion,
      runtimeSource.target,
      nativePackageManifest.name,
    );
    return {
      installationKind: "npm",
      commandPath,
      commandLinkTarget,
      packageRoot,
      storageRoot,
      entrypointRelative,
      nativePackageRoot,
      nativePackageRelative,
      nativeRoot: runtimeSource.nativeRoot,
      nativePackageName: nativePackageManifest.name,
      nativeTarget: runtimeSource.target,
    };
  }

  if (entrypointRelative !== path.join("bin", "codex")) {
    throw new Error("The Codex command is not owned by an official npm or standalone package layout");
  }
  const storageRoot = path.dirname(packageRoot);
  const standaloneRoot = path.dirname(storageRoot);
  if (path.basename(storageRoot) !== "releases" || path.basename(standaloneRoot) !== "standalone") {
    throw new Error("The Codex command is not installed in an official standalone release root");
  }
  const selectorPath = path.join(standaloneRoot, "current");
  const selectorStat = await fs.lstat(selectorPath);
  if (!selectorStat.isSymbolicLink()) throw new Error("The Codex standalone current selector is invalid");
  const selectorLinkTarget = await fs.readlink(selectorPath);
  if (await fs.realpath(selectorPath) !== packageRoot) {
    throw new Error("The Codex standalone current selector does not match the active command");
  }
  const manifest = await verifyInstallationTree("standalone", packageRoot, expectedVersion);
  if (path.basename(packageRoot) !== `${expectedVersion}-${manifest.target}`) {
    throw new Error("The Codex standalone release directory does not match its package metadata");
  }
  return {
    installationKind: "standalone",
    commandPath,
    commandLinkTarget,
    packageRoot,
    storageRoot,
    entrypointRelative,
    standaloneRoot,
    standaloneTarget: manifest.target,
    selectorPath,
    selectorLinkTarget,
  };
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
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH entries.
    }
  }
  throw new Error("Cannot resolve the official Codex command");
}

async function verifyInstallationTree(installationKind, packageRoot, expectedVersion, standaloneTarget = null) {
  const stat = await fs.lstat(packageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Codex package root is invalid");
  if (installationKind === "npm") {
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "@openai/codex" || manifest.version !== expectedVersion) {
      throw new Error("Codex npm package identity does not match the installed CLI version");
    }
    const entrypoint = path.join(packageRoot, "bin", "codex.js");
    const entrypointStat = await fs.lstat(entrypoint);
    if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink()) {
      throw new Error("Codex npm entrypoint is invalid");
    }
    return manifest;
  }

  if (installationKind !== "standalone") throw new Error("Unsupported Codex installation kind");
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "codex-package.json"), "utf8"));
  if (
    manifest.layoutVersion !== 1
    || manifest.version !== expectedVersion
    || manifest.variant !== "codex"
    || manifest.entrypoint !== "bin/codex"
    || !STANDALONE_TARGET_PATTERN.test(String(manifest.target || ""))
    || (standaloneTarget !== null && manifest.target !== standaloneTarget)
  ) {
    throw new Error("Codex standalone package identity does not match the installed CLI version");
  }
  const entrypoint = path.join(packageRoot, "bin", "codex");
  const entrypointStat = await fs.lstat(entrypoint);
  if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink() || !(entrypointStat.mode & 0o111)) {
    throw new Error("Codex standalone entrypoint is invalid");
  }
  const codeModeHost = path.join(packageRoot, "bin", "codex-code-mode-host");
  const codeModeHostStat = await fs.lstat(codeModeHost).catch((error) => {
    if (error.code === "ENOENT") throw new Error("Codex standalone code-mode host is missing");
    throw error;
  });
  if (!codeModeHostStat.isFile() || codeModeHostStat.isSymbolicLink() || !(codeModeHostStat.mode & 0o111)) {
    throw new Error("Codex standalone code-mode host is invalid");
  }
  return manifest;
}

async function verifyNativePackageTree(packageRoot, expectedVersion, expectedTarget, expectedName) {
  const stat = await fs.lstat(packageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Codex native package root is invalid");
  const packageManifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (
    !NATIVE_PACKAGE_NAME_PATTERN.test(String(packageManifest.name || ""))
    || packageManifest.name !== expectedName
    || packageManifest.version !== expectedVersion
  ) {
    throw new Error("Codex native package identity does not match the installed CLI version");
  }
  const nativeRoot = path.join(packageRoot, "vendor", expectedTarget);
  const nativeManifest = JSON.parse(await fs.readFile(path.join(nativeRoot, "codex-package.json"), "utf8"));
  if (
    nativeManifest.layoutVersion !== 1
    || nativeManifest.version !== expectedVersion
    || nativeManifest.variant !== "codex"
    || nativeManifest.entrypoint !== "bin/codex"
    || nativeManifest.resourcesDir !== "codex-resources"
    || nativeManifest.pathDir !== "codex-path"
    || nativeManifest.target !== expectedTarget
  ) {
    throw new Error("Codex native runtime package identity does not match the installed CLI version");
  }
  await assertExecutableFile(path.join(nativeRoot, "bin", "codex"), "Codex native executable");
  await assertExecutableFile(
    path.join(nativeRoot, "bin", "codex-code-mode-host"),
    "Codex native code-mode host",
  );
  await assertDirectory(path.join(nativeRoot, nativeManifest.resourcesDir), "Codex native resources directory");
  await assertDirectory(path.join(nativeRoot, nativeManifest.pathDir), "Codex native path directory");
  return { packageManifest, nativeManifest, nativeRoot };
}

async function verifyNpmPackagePair(root, expectedVersion, nativePackageName, nativeTarget) {
  await verifyInstallationTree("npm", path.join(root, "wrapper"), expectedVersion);
  return verifyNativePackageTree(
    path.join(root, "native"),
    expectedVersion,
    nativeTarget,
    nativePackageName,
  );
}

async function verifyRecoveryBackup(journal) {
  if (isCompositeNpmJournal(journal)) {
    return verifyNpmPackagePair(
      journal.backupPath,
      journal.beforeVersion,
      journal.nativePackageName,
      journal.nativeTarget,
    );
  }
  return verifyInstallationTree(
    journal.installationKind,
    journal.backupPath,
    journal.beforeVersion,
    journal.standaloneTarget,
  );
}

async function restoreNpmPackagePair(journal, restorePath, failedPath) {
  await fs.mkdir(failedPath, { recursive: true, mode: 0o700 });
  await replaceRestoredPackage(
    journal.packageRoot,
    path.join(restorePath, "wrapper"),
    path.join(failedPath, "wrapper"),
    (candidate) => verifyInstallationTree("npm", candidate, journal.beforeVersion),
  );
  await replaceRestoredPackage(
    journal.nativePackageRoot,
    path.join(restorePath, "native"),
    path.join(failedPath, "native"),
    (candidate) => verifyNativePackageTree(
      candidate,
      journal.beforeVersion,
      journal.nativeTarget,
      journal.nativePackageName,
    ),
  );
  await fs.rm(restorePath, { recursive: true, force: true });
  await Promise.all([
    syncDirectory(path.dirname(journal.packageRoot)),
    syncDirectory(path.dirname(journal.nativePackageRoot)),
  ]);
}

async function replaceRestoredPackage(target, staged, failed, verify) {
  if (await pathExists(failed)) await verify(failed);
  if (await pathExists(target)) {
    if (await pathExists(failed)) await fs.rm(target, { recursive: true, force: true });
    else await fs.rename(target, failed);
  }
  if (await pathExists(target)) throw new Error("Codex recovery target could not be replaced safely");
  await fs.rename(staged, target);
}

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function assertExecutableFile(filename, label) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
    throw new Error(`${label} is invalid`);
  }
}

async function assertDirectory(filename, label) {
  const stat = await fs.lstat(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is invalid`);
}

function isCompositeNpmJournal(journal) {
  return journal?.installationKind === "npm" && journal.backupLayout === NPM_BACKUP_LAYOUT;
}

async function installationMatches(journal) {
  try {
    await verifyInstallationTree(
      journal.installationKind,
      journal.packageRoot,
      journal.beforeVersion,
      journal.standaloneTarget,
    );
    if (isCompositeNpmJournal(journal)) {
      await verifyNativePackageTree(
        journal.nativePackageRoot,
        journal.beforeVersion,
        journal.nativeTarget,
        journal.nativePackageName,
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function restoreInstallationLinks(journal) {
  if (journal.installationKind === "standalone") {
    await restoreSymbolicLink(
      journal.selectorPath,
      journal.selectorLinkTarget,
      journal.packageRoot,
      "Codex standalone selector",
    );
  }
  await restoreSymbolicLink(
    journal.commandPath,
    journal.commandLinkTarget,
    path.join(journal.packageRoot, journal.entrypointRelative),
    "Codex command link",
  );
}

async function restoreSymbolicLink(linkPath, linkTarget, expectedRealPath, label) {
  const temporary = path.join(
    path.dirname(linkPath),
    `.codex-wfl-link-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await fs.rm(temporary, { force: true });
  await fs.symlink(linkTarget, temporary);
  await fs.rename(temporary, linkPath);
  await syncDirectory(path.dirname(linkPath));
  const resolved = await fs.realpath(linkPath);
  if (resolved !== expectedRealPath) {
    throw new Error(`Restored ${label} does not select the recovered package`);
  }
}

function validateJournal(value) {
  if (![...LEGACY_JOURNAL_SCHEMAS, JOURNAL_SCHEMA].includes(value?.schemaVersion)) {
    throw new Error("Unsupported Codex recovery journal schema");
  }
  const operationId = validateOperationId(value.operationId);
  const beforeVersion = validateVersion(value.beforeVersion, "Codex recovery version");
  const appVersion = validateAppVersion(value.appVersion);
  const installationKind = value.schemaVersion === 1
    ? "npm"
    : validateInstallationKind(value.installationKind);
  const states = new Set([
    "prepared",
    "decision-pending",
    "restoring",
    "package-restored",
    "update-committed",
    "rollback-committed",
  ]);
  if (!states.has(value.state)) throw new Error("Invalid Codex recovery state");
  const afterVersion = ["decision-pending", "update-committed"].includes(value.state)
    ? validateVersion(value.afterVersion, "committed Codex update version")
    : null;
  const packageRoot = validateAbsolutePath(value.packageRoot, "Codex package root");
  const storageRoot = validateAbsolutePath(
    value.schemaVersion === 1 ? value.globalModulesRoot : value.storageRoot,
    "Codex recovery storage root",
  );
  const backupPath = validateAbsolutePath(value.backupPath, "Codex backup path");
  const commandPath = validateAbsolutePath(value.commandPath, "Codex command path");
  const digest = crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 20);
  if (backupPath !== path.join(storageRoot, `.wfl-codex-backup-${digest}`)) {
    throw new Error("Codex recovery backup path is invalid");
  }
  const commandLinkTarget = validateLinkTarget(value.commandLinkTarget, "Codex recovery command link");

  let installationFields;
  if (installationKind === "npm") {
    if (path.basename(packageRoot) !== "codex" || path.basename(path.dirname(packageRoot)) !== "@openai") {
      throw new Error("Codex recovery package root is invalid");
    }
    if (path.dirname(path.dirname(packageRoot)) !== storageRoot) {
      throw new Error("Codex recovery module root is invalid");
    }
    if (value.entrypointRelative !== path.join("bin", "codex.js")) {
      throw new Error("Codex recovery entrypoint is invalid");
    }
    if (value.schemaVersion >= JOURNAL_SCHEMA) {
      if (value.backupLayout !== NPM_BACKUP_LAYOUT) {
        throw new Error("Codex npm recovery backup layout is invalid");
      }
      const nativePackageRoot = validateAbsolutePath(value.nativePackageRoot, "Codex native package root");
      const nativePackageRelative = validateRelativePath(
        value.nativePackageRelative,
        "Codex native package relative path",
      );
      const nativeRoot = validateAbsolutePath(value.nativeRoot, "Codex native runtime root");
      const nativePackageName = String(value.nativePackageName || "");
      const nativeTarget = String(value.nativeTarget || "");
      if (!NATIVE_PACKAGE_NAME_PATTERN.test(nativePackageName)) {
        throw new Error("Codex native package name is invalid");
      }
      if (!STANDALONE_TARGET_PATTERN.test(nativeTarget)) {
        throw new Error("Codex native package target is invalid");
      }
      if (
        path.join(storageRoot, nativePackageRelative) !== nativePackageRoot
        || !isWithin(nativePackageRoot, storageRoot)
        || nativePackageRoot === packageRoot
        || isWithin(nativePackageRoot, packageRoot)
        || path.basename(path.dirname(nativePackageRoot)) !== "@openai"
        || path.basename(nativePackageRoot) !== nativePackageName.slice("@openai/".length)
        || nativeRoot !== path.join(nativePackageRoot, "vendor", nativeTarget)
      ) {
        throw new Error("Codex native recovery root is invalid");
      }
      installationFields = {
        globalModulesRoot: storageRoot,
        backupLayout: NPM_BACKUP_LAYOUT,
        nativePackageRoot,
        nativePackageRelative,
        nativeRoot,
        nativePackageName,
        nativeTarget,
      };
    } else {
      installationFields = { globalModulesRoot: storageRoot };
    }
  } else {
    const standaloneRoot = validateAbsolutePath(value.standaloneRoot, "Codex standalone root");
    const standaloneTarget = String(value.standaloneTarget || "");
    const selectorPath = validateAbsolutePath(value.selectorPath, "Codex standalone selector");
    const selectorLinkTarget = validateLinkTarget(
      value.selectorLinkTarget,
      "Codex standalone selector link",
    );
    if (!STANDALONE_TARGET_PATTERN.test(standaloneTarget)) {
      throw new Error("Codex standalone target is invalid");
    }
    if (
      path.basename(storageRoot) !== "releases"
      || path.dirname(storageRoot) !== standaloneRoot
      || path.basename(standaloneRoot) !== "standalone"
      || path.dirname(packageRoot) !== storageRoot
      || path.basename(packageRoot) !== `${beforeVersion}-${standaloneTarget}`
    ) {
      throw new Error("Codex standalone recovery root is invalid");
    }
    if (selectorPath !== path.join(standaloneRoot, "current")) {
      throw new Error("Codex standalone recovery selector is invalid");
    }
    if (value.entrypointRelative !== path.join("bin", "codex")) {
      throw new Error("Codex standalone recovery entrypoint is invalid");
    }
    installationFields = {
      standaloneRoot,
      standaloneTarget,
      selectorPath,
      selectorLinkTarget,
    };
  }
  return {
    ...value,
    operationId,
    beforeVersion,
    afterVersion,
    appVersion,
    installationKind,
    packageRoot,
    storageRoot,
    backupPath,
    commandPath,
    commandLinkTarget,
    ...installationFields,
  };
}

function validateInstallationKind(value) {
  if (!new Set(["npm", "standalone"]).has(value)) throw new Error("Invalid Codex installation kind");
  return value;
}

function validateLinkTarget(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value;
}

function validateOperationId(value) {
  const normalized = String(value || "");
  if (!OPERATION_ID_PATTERN.test(normalized)) throw new Error("Invalid Codex recovery operation ID");
  return normalized;
}

function validateVersion(value, label) {
  const normalized = String(value || "");
  if (!VERSION_PATTERN.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function validateAppVersion(value) {
  const normalized = validateVersion(value, "application recovery version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error("Invalid application recovery version");
  }
  return normalized;
}

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return path.normalize(value);
}

function validateRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function isSafeRelativePath(value) {
  try {
    return validateRelativePath(value, "Codex relative path") === path.normalize(value);
  } catch {
    return false;
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function updateJournal(journalPath, journal, state, extra = {}) {
  const next = validateJournal({ ...journal, ...extra, state, updatedAt: Date.now() });
  await durableWriteJson(journalPath, next);
  return next;
}

async function durableWriteJson(destination, value) {
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncFilesystemPath(candidate) {
  await new Promise((resolve, reject) => {
    const child = spawn("sync", ["-f", candidate], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`sync -f failed (${code})`)));
  });
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pathExists(candidate) {
  return fs.access(candidate).then(() => true, () => false);
}
