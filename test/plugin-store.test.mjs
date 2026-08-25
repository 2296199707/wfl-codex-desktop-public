import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginStore } from "../lib/plugin-store.mjs";

const catalogDirectory = path.resolve(new URL("../plugins/catalog", import.meta.url).pathname);

test("plugin store installs only validated catalog manifests with private state", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-plugin-store-"));
  try {
    const store = await new PluginStore(catalogDirectory, stateDirectory, { now: () => 123456 }).initialize();
    const catalog = store.snapshot();
    assert.equal(catalog.source.trust, "bundled");
    assert.equal(catalog.platformVersion, 2);
    assert.deepEqual(catalog.plugins.map((plugin) => plugin.id).sort(), [
      "ai-provider-real-test",
      "android-drive-builder",
      "creator-worker",
      "persistent-ssh-servers",
      "secure-ssh-access",
      "windows-codex-remote",
    ]);
    assert.equal(catalog.plugins.find((plugin) => plugin.id === "secure-ssh-access").installed, false);

    const installed = await store.install("secure-ssh-access");
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    assert.equal(store.isEnabled("secure-ssh-access"), true);
    const manifestPath = path.join(stateDirectory, "plugins", "secure-ssh-access", "plugin.json");
    assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(stateDirectory, "plugins.json"))).mode & 0o777, 0o600);

    const disabled = await store.setEnabled("secure-ssh-access", false);
    assert.equal(disabled.enabled, false);
    await store.uninstall("secure-ssh-access");
    assert.equal(store.snapshot().plugins.find((plugin) => plugin.id === "secure-ssh-access").installed, false);
    await assert.rejects(fs.access(manifestPath));
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("plugin store keeps installation separate from per-user authorization", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-plugin-store-"));
  try {
    const store = await new PluginStore(catalogDirectory, stateDirectory, {
      now: () => 234567,
      appVersion: "0.43.1-beta",
    }).initialize();
    const member = {
      id: "user-member",
      role: "member",
      status: "active",
      permissions: { codexPlugins: true },
    };
    const owner = {
      id: "user-owner",
      role: "owner",
      status: "active",
      permissions: { codexPlugins: true },
    };

    await store.install("windows-codex-remote");
    assert.equal(store.isAuthorized("windows-codex-remote", member), false);
    assert.equal(store.isAuthorized("windows-codex-remote", owner), true);

    await store.grant("windows-codex-remote", member.id, owner.id);
    assert.equal(store.isAuthorized("windows-codex-remote", member), true);
    assert.deepEqual(
      store.snapshot({ viewer: member, includeGrants: true })
        .plugins.find((plugin) => plugin.id === "windows-codex-remote").grantedUserIds,
      [member.id],
    );

    await store.setEnabled("windows-codex-remote", false);
    assert.equal(store.isAuthorized("windows-codex-remote", member), false);
    await store.setEnabled("windows-codex-remote", true);
    await store.revokeGrant("windows-codex-remote", member.id);
    assert.equal(store.isAuthorized("windows-codex-remote", member), false);

    await store.grant("windows-codex-remote", member.id, owner.id);
    await store.uninstall("windows-codex-remote");
    assert.equal(store.snapshot({ includeGrants: true }).plugins
      .find((plugin) => plugin.id === "windows-codex-remote").grantCount, 0);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("plugin store migrates v1 installation state without inventing user grants", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-plugin-store-"));
  try {
    await fs.writeFile(path.join(stateDirectory, "plugins.json"), `${JSON.stringify({
      version: 1,
      installed: [{
        id: "secure-ssh-access",
        version: "1.1.0",
        enabled: true,
        installedAt: 123,
        updatedAt: 123,
      }],
    })}\n`, { mode: 0o600 });
    const store = await new PluginStore(catalogDirectory, stateDirectory).initialize();
    assert.equal(store.isEnabled("secure-ssh-access"), true);
    assert.equal(store.snapshot({ includeGrants: true }).plugins
      .find((plugin) => plugin.id === "secure-ssh-access").grantCount, 0);
    await store.setEnabled("secure-ssh-access", false);
    const persisted = JSON.parse(await fs.readFile(path.join(stateDirectory, "plugins.json"), "utf8"));
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.grants, []);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("plugin store rejects IDs outside its catalog", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-plugin-store-"));
  try {
    const store = await new PluginStore(catalogDirectory, stateDirectory).initialize();
    await assert.rejects(store.install("unknown-plugin"), /不存在/);
    await assert.rejects(store.install("../escape"), /格式/);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("plugin store cannot re-enable a plugin on an incompatible app version", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-plugin-store-"));
  try {
    await fs.writeFile(path.join(stateDirectory, "plugins.json"), `${JSON.stringify({
      version: 2,
      installed: [{
        id: "windows-codex-remote",
        version: "0.1.0",
        enabled: false,
        installedAt: 123,
        updatedAt: 123,
      }],
      grants: [],
    })}\n`, { mode: 0o600 });
    const store = await new PluginStore(catalogDirectory, stateDirectory, {
      appVersion: "0.42.9",
    }).initialize();
    await assert.rejects(store.setEnabled("windows-codex-remote", true), /0\.43\.1/);
    assert.equal(store.isEnabled("windows-codex-remote"), false);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("plugin dependencies must exist, remain acyclic, and be enabled in order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-plugin-dependencies-"));
  const customCatalog = path.join(root, "catalog");
  const stateDirectory = path.join(root, "state");
  try {
    const creator = JSON.parse(await fs.readFile(
      path.join(catalogDirectory, "creator-worker", "plugin.json"),
      "utf8",
    ));
    const remote = JSON.parse(await fs.readFile(
      path.join(catalogDirectory, "windows-codex-remote", "plugin.json"),
      "utf8",
    ));
    remote.dependencies = ["creator-worker"];
    await Promise.all([
      fs.mkdir(path.join(customCatalog, "creator-worker"), { recursive: true }),
      fs.mkdir(path.join(customCatalog, "windows-codex-remote"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(customCatalog, "creator-worker", "plugin.json"), JSON.stringify(creator)),
      fs.writeFile(path.join(customCatalog, "windows-codex-remote", "plugin.json"), JSON.stringify(remote)),
    ]);
    const store = await new PluginStore(customCatalog, stateDirectory, { appVersion: "0.43.1-beta" }).initialize();
    await assert.rejects(store.install("windows-codex-remote"), /依赖插件/);
    await store.install("creator-worker");
    await store.install("windows-codex-remote");
    await assert.rejects(store.setEnabled("creator-worker", false), /先停用/);
    await assert.rejects(store.uninstall("creator-worker"), /先卸载/);
    await store.setEnabled("windows-codex-remote", false);
    await store.uninstall("windows-codex-remote");
    await store.setEnabled("creator-worker", false);

    remote.dependencies = ["missing-plugin"];
    await fs.writeFile(path.join(customCatalog, "windows-codex-remote", "plugin.json"), JSON.stringify(remote));
    await assert.rejects(new PluginStore(customCatalog, path.join(root, "missing-state")).initialize(), /Unknown plugin dependency/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
