import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAuthRecord } from "../lib/auth.mjs";
import { MultiUserStore } from "../lib/multi-user-store.mjs";
import { provisionManagedUser } from "../lib/user-provisioner.mjs";

const GIB = 1024 * 1024 * 1024;

test("multi-user mode migrates the legacy owner without storing session or invite secrets", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-store-");
  const usersRoot = path.join(directory, "managed-users");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const legacyStateDirectory = path.join(directory, "legacy-state");
  await Promise.all([fs.mkdir(legacyProjectRoot), fs.mkdir(legacyStateDirectory)]);
  const legacyAuth = createAuthRecord("owner", "owner-password-1234");
  const store = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth,
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot,
    defaultQuotaBytes: 5 * GIB,
  }).initialize();

  assert.deepEqual(store.modeSnapshot(), {
    enabled: false,
    configured: false,
    registration: "invite",
    defaultQuotaBytes: 5 * GIB,
    defaultTierId: "tier-default",
    defaultCodexThreadLimit: 8,
  });
  await assert.rejects(
    store.enable({ username: "owner", password: "wrong-password-1234" }),
    /管理员密码不正确/,
  );

  const enabled = await store.enable({ username: "owner", password: "owner-password-1234" });
  assert.equal(enabled.user.role, "owner");
  assert.equal(enabled.user.legacy, true);
  assert.equal(enabled.user.tierName, null);
  assert.equal(enabled.user.tierExpiresAt, null);
  assert.equal((await store.authenticate(enabled.token)).id, enabled.user.id);
  const additionalLogin = await store.login("owner", "owner-password-1234");
  const authenticatedSession = await store.authenticateSession(additionalLogin.token);
  assert.equal(authenticatedSession.user.id, enabled.user.id);
  assert.deepEqual(Object.keys(authenticatedSession.session).sort(), ["expiresAt", "id", "source", "userId"]);
  assert.equal(authenticatedSession.session.source, "primary");
  assert.equal(await store.sessionIsActive(authenticatedSession.session), true);
  const revokedSession = await store.revokeSession(additionalLogin.token);
  assert.deepEqual(revokedSession, authenticatedSession.session);
  assert.equal(await store.sessionIsActive(authenticatedSession.session), false);
  assert.equal(await store.authenticate(additionalLogin.token), null);
  const sessionsBeforeVerification = await fs.readFile(path.join(directory, "accounts", "sessions.json"), "utf8");
  assert.equal(store.verifyPassword(enabled.user.id, "owner-password-1234"), true);
  assert.equal(store.verifyPassword(enabled.user.id, "wrong-password-1234"), false);
  assert.equal(
    await fs.readFile(path.join(directory, "accounts", "sessions.json"), "utf8"),
    sessionsBeforeVerification,
  );

  const invite = await store.createInvite(enabled.user.id, {
    role: "member",
    quotaBytes: 2 * GIB,
    expiresHours: 2,
  });
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  const storedText = await Promise.all([
    fs.readFile(path.join(directory, "accounts", "users.json"), "utf8"),
    fs.readFile(path.join(directory, "accounts", "invites.json"), "utf8"),
    fs.readFile(path.join(directory, "accounts", "sessions.json"), "utf8"),
    fs.readFile(path.join(directory, "accounts", "audit.ndjson"), "utf8"),
  ]).then((values) => values.join("\n"));
  assert.doesNotMatch(storedText, /owner-password-1234/);
  assert.doesNotMatch(storedText, new RegExp(invite.token));
  assert.doesNotMatch(storedText, new RegExp(enabled.token));

  const restarted = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth,
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot,
    defaultQuotaBytes: 5 * GIB,
  }).initialize();
  assert.equal((await restarted.authenticate(enabled.token)).id, enabled.user.id);

  const migratedDefaultProject = path.join(legacyProjectRoot, "workspace");
  const migrated = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth,
    legacyProjectRoot,
    legacyDefaultProject: migratedDefaultProject,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot,
    defaultQuotaBytes: 5 * GIB,
  }).initialize();
  assert.equal(migrated.getUser(enabled.user.id).defaultProject, migratedDefaultProject);

  await fs.rm(directory, { recursive: true, force: true });
});

test("Codex thread limits use a mutable system default and nullable per-user override", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-thread-limit-store-");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const legacyStateDirectory = path.join(directory, "legacy-state");
  await Promise.all([fs.mkdir(legacyProjectRoot), fs.mkdir(legacyStateDirectory)]);
  const store = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot: path.join(directory, "managed-users"),
  }).initialize();
  const enabled = await store.enable({ username: "owner", password: "owner-password-1234" });

  assert.equal(enabled.user.effectiveCodexThreadLimit, 8);
  await store.updatePolicy(enabled.user.id, { defaultCodexThreadLimit: 10 });
  assert.equal(store.codexThreadLimitForUser(enabled.user.id), 10);
  let owner = await store.updateUser(enabled.user.id, enabled.user.id, { codexThreadLimit: 4 });
  assert.equal(owner.codexThreadLimit, 4);
  assert.equal(owner.effectiveCodexThreadLimit, 4);
  owner = await store.updateUser(enabled.user.id, enabled.user.id, { codexThreadLimit: null });
  assert.equal(owner.codexThreadLimit, null);
  assert.equal(owner.effectiveCodexThreadLimit, 10);
  await assert.rejects(
    store.updatePolicy(enabled.user.id, { defaultCodexThreadLimit: 17 }),
    /必须为 1-16/,
  );
});

test("single-user Codex thread limit persists before multi-user setup", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-single-thread-limit-store-");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const legacyStateDirectory = path.join(directory, "legacy-state");
  const accounts = path.join(directory, "accounts");
  const options = {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot: path.join(directory, "managed-users"),
  };
  await Promise.all([fs.mkdir(legacyProjectRoot), fs.mkdir(legacyStateDirectory)]);
  try {
    const store = await new MultiUserStore(accounts, options).initialize();
    assert.equal(store.codexThreadLimitForUser("u-0000000000000000"), 8);
    const updated = await store.updateSingleUserCodexThreadLimit("u-0000000000000000", 12);
    assert.equal(updated.defaultCodexThreadLimit, 12);
    assert.equal(store.codexThreadLimitForUser("u-0000000000000000"), 12);

    const restarted = await new MultiUserStore(accounts, options).initialize();
    assert.equal(restarted.modeSnapshot().configured, false);
    assert.equal(restarted.codexThreadLimitForUser("u-0000000000000000"), 12);
    await assert.rejects(
      restarted.updateSingleUserCodexThreadLimit("u-0000000000000000", 0),
      /必须为 1-16/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rescue mode reads account policy without sharing mutable sessions or writes", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-rescue-");
  const accounts = path.join(directory, "accounts");
  const rescueSessions = path.join(directory, "rescue-sessions", "4320");
  const usersRoot = path.join(directory, "managed-users");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const legacyStateDirectory = path.join(directory, "legacy-state");
  await Promise.all([fs.mkdir(legacyProjectRoot), fs.mkdir(legacyStateDirectory)]);
  const options = {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot,
  };
  const primary = await new MultiUserStore(accounts, options).initialize();
  const owner = await primary.enable({ username: "owner", password: "owner-password-1234" });
  const usersBefore = await fs.readFile(path.join(accounts, "users.json"), "utf8");
  const auditBefore = await fs.readFile(path.join(accounts, "audit.ndjson"), "utf8");
  const rescue = await new MultiUserStore(accounts, {
    ...options,
    sessionDirectory: rescueSessions,
    sessionFallbackDirectory: accounts,
    readOnly: true,
  }).initialize({ writeOnInitialize: false });

  const fallbackAuthentication = await rescue.authenticateSession(owner.token);
  assert.equal(fallbackAuthentication.user.id, owner.user.id);
  assert.equal(fallbackAuthentication.session.source, "fallback");
  assert.equal(await rescue.sessionIsActive(fallbackAuthentication.session), true);
  const rescueLogin = await rescue.login("owner", "owner-password-1234");
  assert.equal((await rescue.authenticate(rescueLogin.token)).id, owner.user.id);
  assert.notEqual(await fs.readFile(path.join(rescueSessions, "sessions.json"), "utf8"), "");
  assert.equal(await fs.readFile(path.join(accounts, "users.json"), "utf8"), usersBefore);
  assert.equal(await fs.readFile(path.join(accounts, "audit.ndjson"), "utf8"), auditBefore);
  await assert.rejects(
    rescue.updateUser(owner.user.id, owner.user.id, { displayName: "should-not-write" }),
    /独立救援服务只读/,
  );
  assert.equal(await primary.logout(owner.token), true);
  assert.equal(await rescue.authenticate(owner.token), null);
  assert.equal(await rescue.sessionIsActive(fallbackAuthentication.session), false);
  assert.equal((await rescue.authenticate(rescueLogin.token)).id, owner.user.id);

  await fs.rm(directory, { recursive: true, force: true });
});

test("invite registration provisions a private user layout and enforces account roles", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-register-");
  const usersRoot = path.join(directory, "managed-users");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const legacyStateDirectory = path.join(directory, "legacy-state");
  await Promise.all([fs.mkdir(legacyProjectRoot), fs.mkdir(legacyStateDirectory)]);
  const store = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot,
  }).initialize();
  const owner = await store.enable({ username: "owner", password: "owner-password-1234" });
  const invite = await store.createInvite(owner.user.id, { role: "member", quotaBytes: GIB });
  const registered = await store.register(invite.token, {
    username: "member.one",
    displayName: "Member One",
    password: "member-password-1234",
  }, (user) => provisionManagedUser(user, {
    usersRoot,
    controlStateRoot: path.join(directory, "accounts", "user-state"),
    testMode: true,
  }));

  assert.equal(registered.user.role, "member");
  assert.equal(registered.user.quotaBytes, GIB);
  assert.equal((await store.login("member.one", "member-password-1234")).user.id, registered.user.id);
  assert.equal(store.getUser(registered.user.id).projectRoot, path.join(usersRoot, registered.user.id, "projects"));
  for (const relative of ["", ".codex", "projects", "projects/workspace"]) {
    const stat = await fs.stat(path.join(usersRoot, registered.user.id, relative));
    assert.equal(stat.mode & 0o077, 0);
  }
  assert.equal(store.getUser(registered.user.id).stateDirectory, path.join(directory, "accounts", "user-state", registered.user.id));
  assert.deepEqual(registered.user.permissions, {
    customProviders: true,
    officialLogin: false,
    projectSharing: false,
    codexSkills: false,
    codexPlugins: false,
    codexApps: false,
    codexMcp: false,
    codexMigration: false,
    codexMemory: false,
    codexBackground: false,
    codexTerminal: false,
    codexWorkspaceMessages: false,
    codexRemoteDiff: false,
    codexFeedback: false,
    claudeRuntime: true,
    claudeOfficialLogin: false,
    claudeProviders: true,
    claudeExtensions: false,
    claudeMcp: false,
    claudeHooks: false,
    claudeMemory: false,
    claudeBackground: false,
    claudeWorktree: false,
    claudeProxy: false,
    claudeStructuredOutput: false,
    claudeUltraReview: false,
    claudeProjectPurge: false,
    claudeBetaHeaders: false,
  });
  assert.throws(() => store.listUsers(registered.user.id), /没有此操作权限/);
  await assert.rejects(store.createInvite(registered.user.id), /没有此操作权限/);

  const sharedProject = path.join(legacyProjectRoot, "shared-project");
  await fs.mkdir(sharedProject);
  await assert.rejects(
    store.createProjectShare(owner.user.id, {
      projectPath: sharedProject,
      targetUserId: registered.user.id,
      access: "read",
    }),
    /尚未获得共享工程权限/,
  );
  const permitted = await store.updateUser(owner.user.id, registered.user.id, {
    permissions: {
      customProviders: true,
      officialLogin: true,
      projectSharing: true,
      codexSkills: true,
      codexPlugins: true,
      codexApps: false,
      codexMcp: true,
      codexMigration: true,
      codexMemory: true,
      codexBackground: true,
      codexTerminal: true,
      codexWorkspaceMessages: true,
      codexRemoteDiff: true,
      codexFeedback: true,
      claudeRuntime: true,
      claudeOfficialLogin: true,
      claudeProviders: true,
      claudeExtensions: true,
      claudeMcp: true,
      claudeHooks: true,
      claudeMemory: true,
      claudeBackground: true,
      claudeWorktree: true,
      claudeProxy: true,
      claudeStructuredOutput: true,
      claudeUltraReview: true,
      claudeProjectPurge: true,
      claudeBetaHeaders: true,
    },
    fiveHourTokenLimit: 50_000,
    weeklyTokenLimit: 150_000,
    monthlyTokenLimit: 250_000,
  });
  assert.deepEqual(permitted.permissions, {
    customProviders: true,
    officialLogin: true,
    projectSharing: true,
    codexSkills: true,
    codexPlugins: true,
    codexApps: false,
    codexMcp: true,
    codexMigration: true,
    codexMemory: true,
    codexBackground: true,
    codexTerminal: true,
    codexWorkspaceMessages: true,
    codexRemoteDiff: true,
    codexFeedback: true,
    claudeRuntime: true,
    claudeOfficialLogin: true,
    claudeProviders: true,
    claudeExtensions: true,
    claudeMcp: true,
    claudeHooks: true,
    claudeMemory: true,
    claudeBackground: true,
    claudeWorktree: true,
    claudeProxy: true,
    claudeStructuredOutput: true,
    claudeUltraReview: true,
    claudeProjectPurge: true,
    claudeBetaHeaders: true,
  });
  assert.equal(permitted.fiveHourTokenLimit, 50_000);
  assert.equal(permitted.weeklyTokenLimit, 150_000);
  assert.equal(permitted.monthlyTokenLimit, 250_000);
  await assert.rejects(
    store.updateUser(owner.user.id, registered.user.id, { fiveHourTokenLimit: -1 }),
    /5 小时 Token 上限/,
  );
  await assert.rejects(
    store.updateUser(owner.user.id, registered.user.id, { weeklyTokenLimit: -1 }),
    /每周 Token 上限/,
  );
  await assert.rejects(
    store.updateUser(owner.user.id, registered.user.id, { monthlyTokenLimit: -1 }),
    /每月 Token 上限/,
  );
  const unlimited = await store.updateUser(owner.user.id, registered.user.id, {
    fiveHourTokenLimit: null, weeklyTokenLimit: null, monthlyTokenLimit: null,
  });
  assert.equal(unlimited.fiveHourTokenLimit, null);
  assert.equal(unlimited.weeklyTokenLimit, null);
  assert.equal(unlimited.monthlyTokenLimit, null);
  const share = await store.createProjectShare(owner.user.id, {
    projectPath: sharedProject,
    targetUserId: registered.user.id,
    access: "read",
  });
  assert.equal(store.projectSharesForUser(registered.user.id)[0].access, "read");
  assert.equal(store.listProjectShares(owner.user.id)[0].id, share.id);
  await store.removeProjectShare(owner.user.id, share.id);
  assert.deepEqual(store.projectSharesForUser(registered.user.id), []);

  const disabled = await store.updateUser(owner.user.id, registered.user.id, { status: "disabled" });
  assert.equal(disabled.status, "disabled");
  assert.equal(await store.authenticate(registered.token), null);
  await assert.rejects(store.login("member.one", "member-password-1234"), /用户名或密码不正确/);

  await fs.rm(directory, { recursive: true, force: true });
});

test("default policies and user tiers snapshot provider, permission, storage, and token settings", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-tiers-");
  const usersRoot = path.join(directory, "managed-users");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  await fs.mkdir(legacyProjectRoot);
  const store = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory: path.join(directory, "legacy-state"),
    legacyHome: directory,
    usersRoot,
  }).initialize();
  const owner = await store.enable({ username: "owner", password: "owner-password-1234" });
  assert.deepEqual(store.policySnapshot(owner.user.id).defaultPermissions, {
    customProviders: true,
    officialLogin: false,
    projectSharing: false,
    codexSkills: false,
    codexPlugins: false,
    codexApps: false,
    codexMcp: false,
    codexMigration: false,
    codexMemory: false,
    codexBackground: false,
    codexTerminal: false,
    codexWorkspaceMessages: false,
    codexRemoteDiff: false,
    codexFeedback: false,
    claudeRuntime: true,
    claudeOfficialLogin: false,
    claudeProviders: true,
    claudeExtensions: false,
    claudeMcp: false,
    claudeHooks: false,
    claudeMemory: false,
    claudeBackground: false,
    claudeWorktree: false,
    claudeProxy: false,
    claudeStructuredOutput: false,
    claudeUltraReview: false,
    claudeProjectPurge: false,
    claudeBetaHeaders: false,
  });

  const providerId = "p-aaaaaaaaaaaa";
  const tier = await store.createTier(owner.user.id, {
    name: "专业版",
    quotaBytes: 20 * GIB,
    fiveHourTokenLimit: 50_000,
    weeklyTokenLimit: 200_000,
    monthlyTokenLimit: 800_000,
    permissions: {
      customProviders: true,
      officialLogin: true,
      projectSharing: true,
      codexSkills: true,
      codexPlugins: true,
      codexApps: true,
      codexMcp: true,
      codexMigration: true,
      codexMemory: true,
      codexBackground: true,
      codexTerminal: true,
      codexWorkspaceMessages: true,
      codexRemoteDiff: true,
      codexFeedback: true,
      claudeRuntime: true,
      claudeOfficialLogin: true,
      claudeProviders: true,
      claudeExtensions: true,
      claudeMcp: true,
      claudeHooks: true,
      claudeMemory: true,
      claudeBackground: true,
      claudeWorktree: true,
      claudeProxy: true,
      claudeStructuredOutput: true,
      claudeUltraReview: true,
      claudeProjectPurge: true,
      claudeBetaHeaders: true,
    },
    providerId,
  });
  await store.updatePolicy(owner.user.id, {
    defaultTierId: tier.id,
    defaultProviderId: providerId,
    defaultPermissions: {
      customProviders: true,
      officialLogin: true,
      projectSharing: true,
      codexSkills: true,
      codexPlugins: true,
      codexApps: true,
      codexMcp: true,
      codexMigration: true,
      codexMemory: true,
      codexBackground: true,
      codexTerminal: true,
      codexWorkspaceMessages: true,
      codexRemoteDiff: true,
      codexFeedback: true,
      claudeRuntime: true,
      claudeOfficialLogin: true,
      claudeProviders: true,
      claudeExtensions: true,
      claudeMcp: true,
      claudeHooks: true,
      claudeMemory: true,
      claudeBackground: true,
      claudeWorktree: true,
      claudeProxy: true,
      claudeStructuredOutput: true,
      claudeUltraReview: true,
      claudeProjectPurge: true,
      claudeBetaHeaders: true,
    },
  });
  const invite = await store.createInvite(owner.user.id, { expiresHours: 2 });
  assert.equal(invite.tierId, tier.id);
  assert.equal(invite.tierName, "专业版");
  assert.equal(invite.quotaBytes, 20 * GIB);
  assert.equal(invite.fiveHourTokenLimit, 50_000);
  assert.equal(invite.weeklyTokenLimit, 200_000);
  assert.equal(invite.monthlyTokenLimit, 800_000);
  assert.equal(invite.providerConfigured, true);
  assert.deepEqual(invite.permissions, {
    customProviders: true,
    officialLogin: true,
    projectSharing: true,
    codexSkills: true,
    codexPlugins: true,
    codexApps: true,
    codexMcp: true,
    codexMigration: true,
    codexMemory: true,
    codexBackground: true,
    codexTerminal: true,
    codexWorkspaceMessages: true,
    codexRemoteDiff: true,
    codexFeedback: true,
    claudeRuntime: true,
    claudeOfficialLogin: true,
    claudeProviders: true,
    claudeExtensions: true,
    claudeMcp: true,
    claudeHooks: true,
    claudeMemory: true,
    claudeBackground: true,
    claudeWorktree: true,
    claudeProxy: true,
    claudeStructuredOutput: true,
    claudeUltraReview: true,
    claudeProjectPurge: true,
    claudeBetaHeaders: true,
  });

  const registered = await store.register(invite.token, {
    username: "tier.member",
    password: "member-password-1234",
  }, (user) => provisionManagedUser(user, {
    usersRoot,
    controlStateRoot: path.join(directory, "accounts", "user-state"),
    testMode: true,
  }));
  assert.equal(registered.user.tierId, tier.id);
  assert.equal(registered.user.tierName, "专业版");
  assert.equal(registered.user.tierExpiresAt, null);
  assert.equal(store.getUser(registered.user.id).pendingProviderId, providerId);
  await store.setManagedProvider(owner.user.id, registered.user.id, {
    sourceProviderId: providerId,
    assignedProfileId: "p-bbbbbbbbbbbb",
    assignedBy: owner.user.id,
    assignedAt: Date.now(),
  });
  assert.equal(store.getUser(registered.user.id).pendingProviderId, null);
  assert.equal(store.listUsers(owner.user.id).find((user) => user.id === registered.user.id).assignedProviderId, providerId);
  assert.deepEqual(store.providerReferences(owner.user.id, providerId).users, [registered.user.id]);

  const customized = await store.updateUser(owner.user.id, registered.user.id, { quotaBytes: 21 * GIB });
  assert.equal(customized.tierId, null);
  assert.equal(customized.tierName, null);
  assert.equal(customized.tierExpiresAt, null);
  const tierExpiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;
  const reapplied = await store.updateUser(owner.user.id, registered.user.id, {
    tierId: tier.id,
    tierExpiresAt,
    quotaBytes: tier.quotaBytes,
    fiveHourTokenLimit: tier.fiveHourTokenLimit,
    weeklyTokenLimit: tier.weeklyTokenLimit,
    monthlyTokenLimit: tier.monthlyTokenLimit,
    permissions: tier.permissions,
  });
  assert.equal(reapplied.tierId, tier.id);
  assert.equal(reapplied.tierName, "专业版");
  assert.equal(reapplied.tierExpiresAt, tierExpiresAt);
  await assert.rejects(store.updateUser(owner.user.id, registered.user.id, {
    tierId: tier.id,
    tierExpiresAt: Date.now() - 1,
  }), /套餐到期时间必须晚于当前时间/);
  assert.equal(store.listUsers(owner.user.id).find((user) => user.id === registered.user.id).tierExpiresAt, tierExpiresAt);
  await store.updateTier(owner.user.id, tier.id, { name: "专业版新版" });
  assert.equal(store.listUsers(owner.user.id).find((user) => user.id === registered.user.id).tierName, "专业版");
  await assert.rejects(store.removeTier(owner.user.id, tier.id), /默认套餐不能删除/);

  const usersPath = path.join(directory, "accounts", "users.json");
  const storedUsers = JSON.parse(await fs.readFile(usersPath, "utf8"));
  const storedMember = storedUsers.users.find((user) => user.id === registered.user.id);
  delete storedMember.tierName;
  delete storedMember.tierExpiresAt;
  await fs.writeFile(usersPath, JSON.stringify(storedUsers));
  const restarted = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory: path.join(directory, "legacy-state"),
    legacyHome: directory,
    usersRoot,
  }).initialize();
  const migratedMember = restarted.listUsers(owner.user.id).find((user) => user.id === registered.user.id);
  assert.equal(migratedMember.tierName, "专业版新版");
  assert.equal(migratedMember.tierExpiresAt, null);

  const expiredAt = Date.now() - 24 * 60 * 60 * 1000;
  const migratedUsers = JSON.parse(await fs.readFile(usersPath, "utf8"));
  migratedUsers.users.find((user) => user.id === registered.user.id).tierExpiresAt = expiredAt;
  await fs.writeFile(usersPath, JSON.stringify(migratedUsers));
  const expiredRestart = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory: path.join(directory, "legacy-state"),
    legacyHome: directory,
    usersRoot,
  }).initialize();
  assert.equal(expiredRestart.listUsers(owner.user.id).find((user) => user.id === registered.user.id).tierExpiresAt, expiredAt);

  await fs.rm(directory, { recursive: true, force: true });
});

test("registration rejects a provisioner that escapes the assigned user home", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-escape-");
  const usersRoot = path.join(directory, "managed-users");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const legacyStateDirectory = path.join(directory, "legacy-state");
  await Promise.all([fs.mkdir(legacyProjectRoot), fs.mkdir(legacyStateDirectory)]);
  const store = await new MultiUserStore(path.join(directory, "accounts"), {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory,
    legacyHome: directory,
    usersRoot,
  }).initialize();
  const owner = await store.enable({ username: "owner", password: "owner-password-1234" });
  const invite = await store.createInvite(owner.user.id);
  let cleaned = false;

  await assert.rejects(
    store.register(invite.token, {
      username: "escaped-user",
      password: "escaped-password-1234",
    }, async () => ({
      systemUsername: "wflc-escaped",
      uid: 1000,
      gid: 1000,
      home: "/tmp",
      codexHome: "/tmp/.codex",
      projectRoot: "/tmp/projects",
      stateDirectory: "/tmp/state",
      cleanup: async () => {
        cleaned = true;
      },
    })),
    /layout is invalid/,
  );
  assert.equal(cleaned, true);
  assert.equal(store.listUsers(owner.user.id).length, 1);

  await fs.rm(directory, { recursive: true, force: true });
});

test("managed-user provisioning removes partial test layouts after setup failure", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-rollback-");
  const usersRoot = path.join(directory, "managed-users");
  const controlStateRoot = path.join(directory, "control-state");
  const id = "u-1111111111111111";

  await assert.rejects(
    provisionManagedUser({ id, quotaBytes: GIB }, {
      usersRoot,
      controlStateRoot,
      testMode: true,
      quotaConfigurator: async () => {
        throw new Error("quota setup failed");
      },
    }),
    /quota setup failed/,
  );
  await assert.rejects(fs.access(path.join(usersRoot, id)), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(controlStateRoot, id)), { code: "ENOENT" });

  await fs.rm(directory, { recursive: true, force: true });
});

test("users can update their profile and password while other sessions are revoked", async () => {
  const directory = await fs.mkdtemp("/tmp/wfl-multi-user-profile-");
  const usersRoot = path.join(directory, "managed-users");
  const legacyProjectRoot = path.join(directory, "legacy-projects");
  const accountsRoot = path.join(directory, "accounts");
  await fs.mkdir(legacyProjectRoot);
  const store = await new MultiUserStore(accountsRoot, {
    legacyAuth: createAuthRecord("owner", "owner-password-1234"),
    legacyProjectRoot,
    legacyStateDirectory: path.join(directory, "legacy-state"),
    legacyHome: directory,
    usersRoot,
  }).initialize();
  const owner = await store.enable({ username: "owner", password: "owner-password-1234" });
  const invite = await store.createInvite(owner.user.id);
  const registered = await store.register(invite.token, {
    username: "profile.member",
    displayName: "Original Name",
    password: "member-password-1234",
  }, (user) => provisionManagedUser(user, {
    usersRoot,
    controlStateRoot: path.join(accountsRoot, "user-state"),
    testMode: true,
  }));
  const secondSession = await store.login("profile.member", "member-password-1234");

  const renamed = await store.updateOwnProfile(registered.user.id, { displayName: "Updated Name" });
  assert.equal(renamed.user.displayName, "Updated Name");
  assert.equal(renamed.token, null);
  assert.equal((await store.authenticate(registered.token)).id, registered.user.id);
  await assert.rejects(
    store.updateOwnProfile(registered.user.id, { currentPassword: "wrong-password-1234", newPassword: "replacement-password-1234" }),
    /当前密码不正确/,
  );

  const changed = await store.updateOwnProfile(registered.user.id, {
    currentPassword: "member-password-1234",
    newPassword: "replacement-password-1234",
  });
  assert.match(changed.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await store.authenticate(registered.token), null);
  assert.equal(await store.authenticate(secondSession.token), null);
  assert.equal((await store.authenticate(changed.token)).id, registered.user.id);
  await assert.rejects(store.login("profile.member", "member-password-1234"), /用户名或密码不正确/);
  assert.equal((await store.login("profile.member", "replacement-password-1234")).user.displayName, "Updated Name");

  const persisted = await Promise.all([
    fs.readFile(path.join(accountsRoot, "users.json"), "utf8"),
    fs.readFile(path.join(accountsRoot, "sessions.json"), "utf8"),
    fs.readFile(path.join(accountsRoot, "audit.ndjson"), "utf8"),
  ]).then((values) => values.join("\n"));
  assert.doesNotMatch(persisted, /member-password-1234|replacement-password-1234/);
  await fs.rm(directory, { recursive: true, force: true });
});
