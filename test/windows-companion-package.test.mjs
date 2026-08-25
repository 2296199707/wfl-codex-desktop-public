import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildWindowsCompanionPackage } from "../lib/windows-companion-package.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const companionRoot = path.join(repositoryRoot, "companion", "windows-host");

test("Windows companion is a standalone deterministic package", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(companionRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@wfl/windows-host");
  assert.equal(packageJson.private, true);
  assert.ok(packageJson.files.includes("src"));
  assert.ok(packageJson.files.includes("scripts"));
  await fs.access(path.join(companionRoot, "npm-shrinkwrap.json"));

  for (const filename of await fs.readdir(path.join(companionRoot, "src"))) {
    if (!filename.endsWith(".mjs")) continue;
    const source = await fs.readFile(path.join(companionRoot, "src", filename), "utf8");
    assert.doesNotMatch(source, /from\s+["']\.\.\//, `${filename} must not import outside the package`);
  }

  const { stdout } = await execute("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: companionRoot,
    maxBuffer: 2 * 1024 * 1024,
  });
  const packed = JSON.parse(stdout)[0];
  const files = new Set(packed.files.map((entry) => entry.path));
  assert.equal(packed.name, "@wfl/windows-host");
  assert.ok(files.has("npm-shrinkwrap.json"));
  assert.ok(files.has("src/windows-host-policy.mjs"));
  assert.ok(files.has("src/codex-rpc-client.mjs"));
});

test("Windows companion installer remains interactive and non-privileged", async () => {
  const installer = await fs.readFile(path.join(companionRoot, "scripts", "install.ps1"), "utf8");
  assert.match(installer, /Read-Host\s+"Type INSTALL to continue"/);
  assert.match(installer, /npm ci --omit=dev --ignore-scripts/);
  assert.doesNotMatch(installer, /\b(?:New-Service|Set-Service|Start-Service|Stop-Service|schtasks(?:\.exe)?|sc\.exe|netsh(?:\.exe)?|New-NetFirewallRule|Set-NetFirewallRule)\b/i);
  assert.doesNotMatch(installer, /Start-Process[^\r\n]*-Verb\s+RunAs/i);
});

test("server-side Windows companion ZIP is deterministic and contains only the reviewed files", async () => {
  const first = await buildWindowsCompanionPackage(companionRoot);
  const second = await buildWindowsCompanionPackage(companionRoot);
  assert.equal(first.version, "0.1.0");
  assert.equal(first.filename, "wfl-windows-host-v0.1.0.zip");
  assert.deepEqual(first.buffer, second.buffer);
  assert.equal(first.buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(first.buffer.readUInt32LE(first.buffer.length - 22), 0x06054b50);
  const printable = first.buffer.toString("latin1");
  for (const filename of first.files) {
    assert.match(printable, new RegExp(escapeRegex(`wfl-windows-host-0.1.0/${filename}`)));
  }
  assert.equal(first.files.some((filename) => filename.startsWith("node_modules/") || filename.endsWith("windows-host.json")), false);

  const manifests = await Promise.all([
    "windows-codex-remote",
    "creator-worker",
  ].map((pluginId) => fs.readFile(path.join(repositoryRoot, "plugins", "catalog", pluginId, "plugin.json"), "utf8")
    .then(JSON.parse)));
  for (const manifest of manifests) {
    assert.equal(manifest.companion.minVersion, first.version);
    assert.equal(manifest.companion.protocolVersion, 1);
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
