import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeOfficialAccountStore } from "../lib/claude-official-accounts.mjs";

test("Claude official account slots isolate config directories and encrypt proxy credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-accounts-"));
  const stateDirectory = path.join(root, "state");
  const legacyConfigDirectory = path.join(root, "legacy-config");
  let now = 1_700_000_000_000;
  try {
    const store = await new ClaudeOfficialAccountStore(stateDirectory, {
      legacyConfigDirectory,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      now: () => now,
    }).initialize();
    assert.deepEqual(store.snapshot(), { activeId: null, accounts: [] });

    const first = await store.create({ label: "Primary Claude" });
    now += 1_000;
    const second = await store.create({ label: "Backup Claude" });
    assert.equal(first.active, true);
    assert.equal(second.active, false);
    assert.notEqual(first.id, second.id);
    assert.equal(Object.hasOwn(first, "configDirectory"), false);
    assert.equal((await fs.stat(store.configDirectory(first.id))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(store.configDirectory(second.id))).mode & 0o777, 0o700);

    now += 1_000;
    const checked = await store.recordStatus(first.id, {
      loggedIn: true,
      email: "primary@example.test",
      subscriptionType: "max",
    });
    assert.equal(checked.credentialStatus, "valid");
    assert.equal(checked.email, "primary@example.test");
    assert.equal(checked.subscriptionType, "max");
    assert.equal(checked.quotaAvailable, false);
    now += 1_000;
    await store.recordQuota(first.id, {
      type: "five_hour",
      status: "allowed_warning",
      utilization: 0.61,
      resetsAt: 1_700_010_800,
      observedAt: now,
    });
    const withQuota = await store.recordQuota(first.id, {
      type: "seven_day",
      status: "allowed",
      utilization: 0.24,
      resetsAt: 1_700_604_800,
      observedAt: now,
    });
    assert.equal(withQuota.quotaAvailable, true);
    assert.deepEqual(withQuota.quota, {
      source: "rate_limit_event",
      status: "allowed",
      windows: [
        {
          type: "five_hour",
          utilization: 0.61,
          resetsAt: 1_700_010_800_000,
          observedAt: now,
        },
        {
          type: "seven_day",
          utilization: 0.24,
          resetsAt: 1_700_604_800_000,
          observedAt: now,
        },
      ],
      updatedAt: now,
    });

    const withProxy = await store.setProxy(first.id, {
      protocol: "socks5",
      host: "residential.example.test",
      port: 1080,
      username: "proxy-user",
      password: "proxy-password-secret",
      label: "Home IP",
    }, {
      status: "ready",
      checkedAt: now,
      latencyMs: 84,
      exitIp: "203.0.113.10",
    });
    assert.deepEqual(withProxy.proxy, {
      configured: true,
      protocol: "socks5",
      host: "residential.example.test",
      port: 1080,
      label: "Home IP",
      hasAuthentication: true,
      health: {
        status: "ready",
        checkedAt: now,
        latencyMs: 84,
        exitIp: "203.0.113.10",
        code: null,
      },
    });
    assert.equal(Object.hasOwn(withProxy.proxy, "password"), false);
    assert.equal(store.privateProxy(first.id).password, "proxy-password-secret");
    const encrypted = await fs.readFile(path.join(stateDirectory, "official-accounts.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, /proxy-password-secret|primary@example\.test/);

    now += 1_000;
    await store.markInvalid(first.id, "expired");
    await assert.rejects(store.activate(first.id), /登录已失效/);
    await assert.rejects(store.activate(second.id), /登录已失效/);
    await store.recordStatus(second.id, {
      loggedIn: true,
      email: "backup@example.test",
      subscriptionType: "pro",
    });
    const activated = await store.activate(second.id);
    assert.equal(activated.active, true);
    assert.equal(store.snapshot().activeId, second.id);

    const reopened = await new ClaudeOfficialAccountStore(stateDirectory, {
      legacyConfigDirectory,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      now: () => now,
    }).initialize();
    assert.equal(reopened.snapshot().accounts.length, 2);
    assert.equal(reopened.snapshot().activeId, second.id);
    assert.equal(reopened.get(first.id).credentialStatus, "invalid");
    assert.equal(reopened.get(first.id).quota.windows.length, 2);
    assert.equal(reopened.privateProxy(first.id).password, "proxy-password-secret");
    const removedConfigDirectory = reopened.configDirectory(first.id);
    const removed = await reopened.remove(first.id);
    assert.equal(removed.removedId, first.id);
    assert.equal(removed.accounts.length, 1);
    assert.equal(removed.activeId, second.id);
    await assert.rejects(fs.access(removedConfigDirectory), { code: "ENOENT" });
    assert.equal(reopened.get(first.id), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude legacy login becomes a retained account slot without exposing its path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-legacy-account-"));
  const stateDirectory = path.join(root, "state");
  const legacyConfigDirectory = path.join(root, "legacy-config");
  try {
    const store = await new ClaudeOfficialAccountStore(stateDirectory, {
      legacyConfigDirectory,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    }).initialize();
    assert.equal(await store.ensureLegacy({ loggedIn: false }), null);
    const legacy = await store.ensureLegacy({
      loggedIn: true,
      email: "legacy@example.test",
      subscriptionType: "pro",
    });
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.active, true);
    assert.equal(legacy.credentialStatus, "valid");
    assert.equal(store.configDirectory(legacy.id), legacyConfigDirectory);
    assert.equal(Object.hasOwn(legacy, "configDirectory"), false);
    const refreshed = await store.ensureLegacy({
      loggedIn: true,
      email: "legacy-renamed@example.test",
      subscriptionType: "max",
    });
    assert.equal(refreshed.id, legacy.id);
    assert.equal(store.snapshot().accounts.length, 1);
    assert.equal(refreshed.email, "legacy-renamed@example.test");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Claude account storage rejects a symlinked account root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-claude-account-symlink-"));
  const stateDirectory = path.join(root, "state");
  const outside = path.join(root, "outside");
  try {
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(stateDirectory, "official-accounts"));
    await assert.rejects(
      new ClaudeOfficialAccountStore(stateDirectory, {
        legacyConfigDirectory: path.join(root, "legacy"),
      }).initialize(),
      /unsafe/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
