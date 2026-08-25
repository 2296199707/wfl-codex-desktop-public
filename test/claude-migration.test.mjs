import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  managedClaudeCommand,
  managedClaudeComponentDirectory,
} from "../lib/claude-component.mjs";
import { migrateBundledClaude } from "../scripts/migrate-claude-component.mjs";

test("fresh installations leave Claude uninstalled when no bundled package exists", async (context) => {
  const root = await temporaryRoot(context);
  const result = await migrateBundledClaude({
    projectDirectory: root,
    runtimeDirectory: path.join(root, ".codex-runtime"),
  });
  assert.deepEqual(result, { migrated: false, reason: "not-installed" });
  await assert.rejects(fs.access(managedClaudeCommand(path.join(root, ".codex-runtime"))));
});

test("legacy bundled Claude is copied into managed runtime before dependencies are cleaned", async (context) => {
  const root = await temporaryRoot(context);
  const packageName = process.arch === "x64"
    ? "@anthropic-ai/claude-code-linux-x64"
    : process.arch === "arm64"
      ? "@anthropic-ai/claude-code-linux-arm64"
      : null;
  if (!packageName) return;
  const packageDirectory = path.join(root, "node_modules", packageName);
  const sourceCommand = path.join(packageDirectory, "claude");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(sourceCommand, "legacy-claude-binary", { mode: 0o755 });
  await fs.writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ version: "2.1.220" }));

  const runtimeDirectory = path.join(root, ".codex-runtime");
  const result = await migrateBundledClaude({ projectDirectory: root, runtimeDirectory });
  assert.deepEqual(result, { migrated: true, source: "bundled", version: "2.1.220" });
  assert.equal(await fs.readFile(managedClaudeCommand(runtimeDirectory), "utf8"), "legacy-claude-binary");
  assert.equal((await fs.stat(managedClaudeCommand(runtimeDirectory))).mode & 0o111, 0o111);
  const metadata = JSON.parse(
    await fs.readFile(path.join(managedClaudeComponentDirectory(runtimeDirectory), "component.json"), "utf8"),
  );
  assert.deepEqual({
    schemaVersion: metadata.schemaVersion,
    name: metadata.name,
    version: metadata.version,
    package: metadata.package,
    activationAllowed: metadata.activationAllowed,
    compatibilityRisk: metadata.compatibilityRisk,
    migratedFromBundled: metadata.migratedFromBundled,
  }, {
    schemaVersion: 1,
    name: "Claude Code",
    version: "2.1.220",
    package: packageName,
    activationAllowed: true,
    compatibilityRisk: "legacy-migrated",
    migratedFromBundled: true,
  });
  assert.equal(typeof metadata.installedAt, "number");
});

test("an existing managed component is never replaced by legacy migration", async (context) => {
  const root = await temporaryRoot(context);
  const runtimeDirectory = path.join(root, ".codex-runtime");
  const managedDirectory = managedClaudeComponentDirectory(runtimeDirectory);
  await fs.mkdir(managedDirectory, { recursive: true });
  await fs.writeFile(managedClaudeCommand(runtimeDirectory), "managed", { mode: 0o755 });
  await fs.writeFile(path.join(managedDirectory, "component.json"), JSON.stringify({ version: "2.1.221" }));

  const result = await migrateBundledClaude({ projectDirectory: root, runtimeDirectory });
  assert.deepEqual(result, { migrated: false, reason: "managed-present" });
  assert.equal(await fs.readFile(managedClaudeCommand(runtimeDirectory), "utf8"), "managed");
});

async function temporaryRoot(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-migration-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
