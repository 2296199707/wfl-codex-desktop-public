import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OfficialAccountStore, accountMetadata } from "../lib/official-account-store.mjs";

test("official account slots encrypt credentials, preserve ownership, and switch atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "official-account-slots-"));
  const stateDirectory = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  await Promise.all([
    fs.mkdir(stateDirectory, { mode: 0o700 }),
    fs.mkdir(codexHome, { mode: 0o700 }),
  ]);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  const first = auth("account-one", "one@example.test", "plus");
  const second = auth("account-two", "two@example.test", "pro");
  const authPath = path.join(codexHome, "auth.json");

  try {
    await fs.writeFile(authPath, JSON.stringify(first), { mode: 0o600 });
    const store = await new OfficialAccountStore(stateDirectory, { codexHome, uid, gid }).initialize();
    const imported = store.snapshot();
    assert.equal(imported.accounts.length, 1);
    assert.equal(imported.accounts[0].email, "one@example.test");
    assert.equal(imported.accounts[0].active, true);
    assert.equal(imported.accounts[0].credentialStatus, "unknown");

    const encrypted = await fs.readFile(path.join(stateDirectory, "official-accounts.enc.json"), "utf8");
    assert.doesNotMatch(encrypted, /one@example\.test|refresh-account-one|access-account-one/);

    await store.captureActive({
      account: { type: "chatgpt", email: "one@example.test", planType: "plus" },
      rateLimits: {
        buckets: [{
          primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 37, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
        }],
      },
      credentialStatus: "valid",
      proxy: {
        protocol: "http",
        host: "residential-one.example.test",
        port: 8_080,
        username: "account-one-zone",
        password: "proxy-secret-one",
        label: "账号一住宅 IP",
      },
      proxyHealth: {
        status: "ready",
        checkedAt: 1_800_000_000_000,
        latencyMs: 92,
        exitIp: "8.8.8.8",
      },
    });
    assert.deepEqual(store.snapshot().accounts[0].weekly, {
      usedPercent: 37,
      windowDurationMins: 10_080,
      resetsAt: 1_900_500_000,
    });
    assert.deepEqual(store.snapshot().accounts[0].proxy, {
      configured: true,
      protocol: "http",
      host: "residential-one.example.test",
      port: 8_080,
      label: "账号一住宅 IP",
      hasAuthentication: true,
      health: {
        status: "ready",
        checkedAt: 1_800_000_000_000,
        latencyMs: 92,
        exitIp: "8.8.8.8",
        code: null,
      },
    });
    assert.equal(store.privateProxy().password, "proxy-secret-one");
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /account-one-zone|proxy-secret-one/);
    const encryptedWithProxy = await fs.readFile(path.join(stateDirectory, "official-accounts.enc.json"), "utf8");
    assert.doesNotMatch(encryptedWithProxy, /proxy-secret-one|residential-one|account-one-zone/);

    await fs.writeFile(authPath, JSON.stringify(second), { mode: 0o600 });
    await store.captureActive({
      credentialStatus: "valid",
      rateLimits: {
        buckets: [{
          secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: 1_901_000_000 },
        }],
      },
      proxy: {
        protocol: "socks5",
        host: "residential-two.example.test",
        port: 10_80,
        username: "account-two-zone",
        password: "proxy-secret-two",
      },
      proxyHealth: {
        status: "ready",
        checkedAt: 1_800_000_010_000,
        latencyMs: 118,
        exitIp: "1.1.1.1",
      },
    });
    const withSecond = store.snapshot();
    assert.equal(withSecond.accounts.length, 2);
    assert.equal(withSecond.accounts.find((entry) => entry.active).email, "two@example.test");

    const firstSlot = withSecond.accounts.find((entry) => entry.email === "one@example.test");
    const secondSlot = withSecond.accounts.find((entry) => entry.email === "two@example.test");
    await store.markActiveInvalid();
    assert.equal(store.snapshot().accounts.find((entry) => entry.id === secondSlot.id).credentialStatus, "invalid");
    await store.activate(firstSlot.id);
    assert.equal(accountMetadata(JSON.parse(await fs.readFile(authPath, "utf8"))).email, "one@example.test");
    const stat = await fs.stat(authPath);
    assert.equal(stat.mode & 0o777, 0o600);
    if (uid !== null) assert.equal(stat.uid, uid);
    if (gid !== null) assert.equal(stat.gid, gid);

    await assert.rejects(
      store.activate(secondSlot.id),
      (error) => error.statusCode === 409 && /登录已失效/.test(error.message),
    );
    assert.equal(accountMetadata(JSON.parse(await fs.readFile(authPath, "utf8"))).email, "one@example.test");

    const reloaded = await new OfficialAccountStore(stateDirectory, { codexHome, uid, gid }).initialize();
    const retained = reloaded.snapshot().accounts.find((entry) => entry.id === secondSlot.id);
    assert.equal(retained.email, "two@example.test");
    assert.equal(retained.planType, "pro");
    assert.equal(retained.credentialStatus, "invalid");
    assert.equal(retained.weekly.usedPercent, 62);
    assert.equal(retained.proxy.protocol, "socks5");
    assert.equal(retained.proxy.health.exitIp, "1.1.1.1");
    assert.equal(reloaded.privateProxy(secondSlot.id).password, "proxy-secret-two");

    await reloaded.setProxy(firstSlot.id, null);
    assert.equal(reloaded.snapshot().accounts.find((entry) => entry.id === firstSlot.id).proxy, null);
    assert.equal(reloaded.nextAccountIdAfterRemoval(firstSlot.id), null);
    await reloaded.remove(firstSlot.id);
    assert.equal(reloaded.snapshot().activeId, null);
    assert.equal(reloaded.snapshot().accounts[0].credentialStatus, "invalid");
    await assert.rejects(fs.stat(authPath), (error) => error.code === "ENOENT");
    await reloaded.remove(secondSlot.id);
    assert.equal(reloaded.snapshot().accounts.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("legacy account bundles migrate once into read-only backup and isolated encrypted slots", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "official-account-migration-"));
  const stateDirectory = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  const authPath = path.join(codexHome, "auth.json");
  const keyPath = path.join(stateDirectory, "official-accounts.key");
  const storePath = path.join(stateDirectory, "official-accounts.enc.json");
  const backupPath = path.join(stateDirectory, "official-accounts.v1.enc.readonly.json");
  const slotDirectory = path.join(stateDirectory, "official-account-auth-v2");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  const key = crypto.randomBytes(32);
  const firstAuth = auth("legacy-one", "legacy-one@example.test", "plus");
  const secondAuth = auth("legacy-two", "legacy-two@example.test", "pro");
  const firstId = "oa-1111111111111111";
  const secondId = "oa-2222222222222222";
  const now = 1_800_000_000_000;
  const accountRecord = (id, credentials, updatedAt) => ({
    id,
    fingerprint: accountMetadata(credentials).fingerprint,
    email: accountMetadata(credentials).email,
    planType: accountMetadata(credentials).planType,
    auth: credentials,
    weekly: null,
    proxy: null,
    workspaceMessages: { seen: [], nudges: [] },
    credentialStatus: "valid",
    credentialStatusUpdatedAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
    lastUsedAt: updatedAt,
  });

  try {
    await Promise.all([
      fs.mkdir(stateDirectory, { mode: 0o700 }),
      fs.mkdir(codexHome, { mode: 0o700 }),
    ]);
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    await fs.writeFile(authPath, JSON.stringify(firstAuth), { mode: 0o600 });
    const legacyEnvelope = encryptStoreEnvelope(key, 1, {
      version: 1,
      activeId: firstId,
      accounts: [
        accountRecord(firstId, firstAuth, now),
        accountRecord(secondId, secondAuth, now - 1_000),
      ],
    });
    const legacyBytes = `${JSON.stringify(legacyEnvelope)}\n`;
    await fs.writeFile(storePath, legacyBytes, { mode: 0o600 });

    const store = await new OfficialAccountStore(stateDirectory, {
      codexHome,
      uid,
      gid,
      now: () => now,
    }).initialize();

    assert.equal(await fs.readFile(backupPath, "utf8"), legacyBytes);
    assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o400);
    const currentEnvelope = JSON.parse(await fs.readFile(storePath, "utf8"));
    assert.equal(currentEnvelope.version, 2);
    const currentStore = decryptStoreEnvelope(key, currentEnvelope);
    assert.equal(currentStore.version, 2);
    assert.equal(currentStore.accounts.length, 2);
    assert.equal(currentStore.accounts.some((entry) => Object.hasOwn(entry, "auth")), false);

    const slotFiles = (await fs.readdir(slotDirectory)).sort();
    assert.deepEqual(slotFiles, [`${firstId}.enc.json`, `${secondId}.enc.json`]);
    for (const filename of slotFiles) {
      const bytes = await fs.readFile(path.join(slotDirectory, filename), "utf8");
      assert.doesNotMatch(bytes, /refresh-legacy|legacy-(?:one|two)@example\.test/);
      assert.equal((await fs.stat(path.join(slotDirectory, filename))).mode & 0o777, 0o600);
    }

    await store.activate(secondId);
    assert.equal(JSON.parse(await fs.readFile(authPath, "utf8")).tokens.refresh_token, "refresh-legacy-two");
    await store.activate(firstId);
    assert.equal(JSON.parse(await fs.readFile(authPath, "utf8")).tokens.refresh_token, "refresh-legacy-one");

    const reloaded = await new OfficialAccountStore(stateDirectory, {
      codexHome,
      uid,
      gid,
      now: () => now + 1,
    }).initialize();
    assert.equal(reloaded.snapshot().activeId, firstId);
    assert.equal(await fs.readFile(backupPath, "utf8"), legacyBytes);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("account slots reject unsafe permissions and credentials encrypted for another slot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "official-account-tamper-"));
  const stateDirectory = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  const authPath = path.join(codexHome, "auth.json");
  const slotDirectory = path.join(stateDirectory, "official-account-auth-v2");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;

  try {
    await Promise.all([
      fs.mkdir(stateDirectory, { mode: 0o700 }),
      fs.mkdir(codexHome, { mode: 0o700 }),
    ]);
    await fs.writeFile(authPath, JSON.stringify(auth("tamper-one", "one@example.test", "plus")), {
      mode: 0o600,
    });
    const store = await new OfficialAccountStore(stateDirectory, { codexHome, uid, gid }).initialize();
    const firstId = store.snapshot().activeId;
    await fs.writeFile(authPath, JSON.stringify(auth("tamper-two", "two@example.test", "pro")), {
      mode: 0o600,
    });
    await store.captureActive({ credentialStatus: "valid" });
    const secondId = store.snapshot().activeId;
    const firstSlotPath = path.join(slotDirectory, `${firstId}.enc.json`);
    const secondSlotPath = path.join(slotDirectory, `${secondId}.enc.json`);

    await fs.chmod(firstSlotPath, 0o644);
    await assert.rejects(store.activate(firstId), /凭据.*permissions are invalid/);
    await fs.chmod(firstSlotPath, 0o600);

    const firstEnvelope = JSON.parse(await fs.readFile(firstSlotPath, "utf8"));
    const secondEnvelope = JSON.parse(await fs.readFile(secondSlotPath, "utf8"));
    await fs.writeFile(firstSlotPath, `${JSON.stringify({
      ...secondEnvelope,
      accountId: firstEnvelope.accountId,
    })}\n`, { mode: 0o600 });
    await assert.rejects(store.activate(firstId), /无法读取官方账号独立凭据/);
    assert.equal(JSON.parse(await fs.readFile(authPath, "utf8")).tokens.refresh_token, "refresh-tamper-two");

    const reloaded = await new OfficialAccountStore(stateDirectory, { codexHome, uid, gid }).initialize();
    const snapshots = reloaded.snapshot().accounts;
    assert.equal(snapshots.find((entry) => entry.id === firstId).credentialStatus, "invalid");
    assert.equal(snapshots.find((entry) => entry.id === secondId).credentialStatus, "valid");
    assert.equal(reloaded.snapshot().activeId, secondId);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("official workspace message state and nudge cooldown stay isolated per account", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "official-workspace-state-"));
  const stateDirectory = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  await Promise.all([
    fs.mkdir(stateDirectory, { mode: 0o700 }),
    fs.mkdir(codexHome, { mode: 0o700 }),
  ]);
  const authPath = path.join(codexHome, "auth.json");
  let now = 1_800_000_000_000;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;

  try {
    await fs.writeFile(authPath, JSON.stringify(auth("workspace-one", "one@example.test", "plus")), {
      mode: 0o600,
    });
    const store = await new OfficialAccountStore(stateDirectory, {
      codexHome,
      uid,
      gid,
      now: () => now,
    }).initialize();
    const firstId = store.snapshot().activeId;
    assert.deepEqual(store.workspaceMessageState(), { seenMessageIds: [], nudges: [] });

    await store.acknowledgeWorkspaceMessages(["message-1", "message-2"], { accountId: firstId });
    assert.deepEqual(store.workspaceMessageState().seenMessageIds, ["message-1", "message-2"]);
    await assert.rejects(
      store.acknowledgeWorkspaceMessages(["message-1", "message-1"], { accountId: firstId }),
      /消息编号无效/,
    );

    await store.recordCreditsNudge("credits", "sent", { accountId: firstId });
    assert.equal(store.creditsNudgeCooldown("credits", 600_000, { accountId: firstId }).allowed, false);
    assert.equal(store.creditsNudgeCooldown("credits", 600_000, { accountId: firstId }).retryAfterMs, 600_000);
    now += 600_001;
    assert.equal(store.creditsNudgeCooldown("credits", 600_000, { accountId: firstId }).allowed, true);
    await store.recordCreditsNudge("usage_limit", "failed", { accountId: firstId });
    assert.equal(store.creditsNudgeCooldown("usage_limit", 600_000, { accountId: firstId }).allowed, true);

    await fs.writeFile(authPath, JSON.stringify(auth("workspace-two", "two@example.test", "pro")), {
      mode: 0o600,
    });
    await store.captureActive();
    const secondId = store.snapshot().activeId;
    assert.notEqual(secondId, firstId);
    assert.deepEqual(store.workspaceMessageState(), { seenMessageIds: [], nudges: [] });
    await assert.rejects(
      store.acknowledgeWorkspaceMessages(["message-3"], { accountId: firstId }),
      /已经切换/,
    );

    await store.activate(firstId);
    const reloaded = await new OfficialAccountStore(stateDirectory, {
      codexHome,
      uid,
      gid,
      now: () => now,
    }).initialize();
    assert.equal(reloaded.snapshot().activeId, firstId);
    assert.deepEqual(reloaded.workspaceMessageState().seenMessageIds, ["message-1", "message-2"]);
    assert.deepEqual(
      reloaded.workspaceMessageState().nudges.map((entry) => [entry.creditType, entry.status]),
      [["usage_limit", "failed"], ["credits", "sent"]],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function auth(accountId, email, planType) {
  const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const commonAuth = {
    chatgpt_account_id: accountId,
    chatgpt_user_id: `user-${accountId}`,
    chatgpt_plan_type: planType,
  };
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: token({
        iss: "https://auth.openai.com",
        sub: `subject-${accountId}`,
        email,
        "https://api.openai.com/auth": commonAuth,
      }),
      access_token: token({
        iss: "https://auth.openai.com",
        sub: `subject-${accountId}`,
        "https://api.openai.com/auth": commonAuth,
      }),
      refresh_token: `refresh-${accountId}`,
    },
  };
}

function encryptStoreEnvelope(key, version, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptStoreEnvelope(key, envelope) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));
}
