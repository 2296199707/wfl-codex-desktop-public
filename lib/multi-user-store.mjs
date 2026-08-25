import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createAuthRecord,
  nextAuthCredentialRevision,
  verifyAuthCredentials,
  validateAuthRecord,
  writeAuth,
} from "./auth.mjs";

const STORE_VERSION = 1;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const USER_ID_PATTERN = /^u-[a-f0-9]{16}$/;
const TIER_ID_PATTERN = /^(?:tier-default|t-[a-f0-9]{12})$/;
const PROVIDER_ID_PATTERN = /^p-[a-f0-9]{12}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN_QUOTA_BYTES = 256 * 1024 * 1024;
const MAX_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_TOKEN_LIMIT = 1_000_000_000_000;
export const DEFAULT_CODEX_THREAD_LIMIT = 8;
export const MIN_CODEX_THREAD_LIMIT = 1;
export const MAX_CODEX_THREAD_LIMIT = 16;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class MultiUserStore {
  constructor(directory, {
    legacyAuth = null,
    legacyAuthPath = null,
    legacyProjectRoot,
    legacyDefaultProject = legacyProjectRoot,
    legacyStateDirectory = directory,
    legacyHome = process.env.HOME || "/root",
    usersRoot = "/srv/wfl-users",
    userStateRoot = path.join(directory, "user-state"),
    sessionDirectory = directory,
    sessionFallbackDirectory = null,
    readOnly = false,
    ownerCredentialOverride = null,
    defaultQuotaBytes = DEFAULT_QUOTA_BYTES,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.directory = path.resolve(directory);
    this.configPath = path.join(this.directory, "multi-user.json");
    this.usersPath = path.join(this.directory, "users.json");
    this.invitesPath = path.join(this.directory, "invites.json");
    this.sessionDirectory = path.resolve(sessionDirectory);
    this.sessionsPath = path.join(this.sessionDirectory, "sessions.json");
    this.sessionFallbackDirectory = sessionFallbackDirectory ? path.resolve(sessionFallbackDirectory) : null;
    this.sessionFallbackPath = this.sessionFallbackDirectory
      ? path.join(this.sessionFallbackDirectory, "sessions.json")
      : null;
    this.sharesPath = path.join(this.directory, "project-shares.json");
    this.auditPath = path.join(this.directory, "audit.ndjson");
    this.legacyAuth = legacyAuth;
    this.legacyAuthPath = legacyAuthPath ? path.resolve(legacyAuthPath) : null;
    this.legacyProjectRoot = path.resolve(legacyProjectRoot || process.cwd());
    this.legacyDefaultProject = path.resolve(legacyDefaultProject || this.legacyProjectRoot);
    this.legacyStateDirectory = path.resolve(legacyStateDirectory);
    this.legacyHome = path.resolve(legacyHome);
    this.usersRoot = path.resolve(usersRoot);
    this.userStateRoot = path.resolve(userStateRoot);
    this.readOnly = readOnly === true;
    this.ownerCredentialOverride = ownerCredentialOverride ? { ...ownerCredentialOverride } : null;
    this.defaultQuotaBytes = normalizeQuota(defaultQuotaBytes);
    this.sessionTtlMs = Math.min(MAX_SESSION_TTL_MS, Math.max(60_000, Number(sessionTtlMs) || DEFAULT_SESSION_TTL_MS));
    this.now = now;
    this.config = null;
    this.users = null;
    this.invites = null;
    this.sessions = null;
    this.fallbackSessions = null;
    this.shares = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize({ writeOnInitialize = true } = {}) {
    if (writeOnInitialize) {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.chmod(this.directory, 0o700);
    }
    if (this.sessionDirectory !== this.directory) {
      await fs.mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
      await fs.chmod(this.sessionDirectory, 0o700);
    }
    [this.config, this.users, this.invites, this.sessions, this.shares] = await Promise.all([
      readJson(this.configPath, defaultConfig(this.usersRoot, this.defaultQuotaBytes)),
      readJson(this.usersPath, { version: STORE_VERSION, users: [] }),
      readJson(this.invitesPath, { version: STORE_VERSION, invites: [] }),
      readJson(this.sessionsPath, { version: STORE_VERSION, sessions: [] }),
      readJson(this.sharesPath, { version: STORE_VERSION, shares: [] }),
    ]);
    this.fallbackSessions = this.sessionFallbackPath && this.sessionFallbackPath !== this.sessionsPath
      ? await readJson(this.sessionFallbackPath, { version: STORE_VERSION, sessions: [] })
      : null;
    const configBeforeValidation = JSON.stringify(this.config);
    const usersBeforeValidation = JSON.stringify(this.users);
    const invitesBeforeValidation = JSON.stringify(this.invites);
    validateStores(this);
    const configChanged = configBeforeValidation !== JSON.stringify(this.config);
    let usersChanged = usersBeforeValidation !== JSON.stringify(this.users);
    const invitesChanged = invitesBeforeValidation !== JSON.stringify(this.invites);
    const legacyOwner = this.users.users.find((user) => user.id === this.config.ownerId && user.legacy);
    if (legacyOwner && (
      legacyOwner.projectRoot !== this.legacyProjectRoot
      || legacyOwner.defaultProject !== this.legacyDefaultProject
    )) {
      legacyOwner.projectRoot = this.legacyProjectRoot;
      legacyOwner.defaultProject = this.legacyDefaultProject;
      legacyOwner.updatedAt = this.now();
      usersChanged = true;
    }
    const migrationWrites = [];
    if (writeOnInitialize && configChanged) migrationWrites.push(writeJsonAtomic(this.configPath, this.config));
    if (writeOnInitialize && usersChanged) migrationWrites.push(writeJsonAtomic(this.usersPath, this.users));
    if (writeOnInitialize && invitesChanged) migrationWrites.push(writeJsonAtomic(this.invitesPath, this.invites));
    if (writeOnInitialize) {
      await Promise.all(migrationWrites);
      await this.pruneExpired();
    }
    return this;
  }

  modeSnapshot() {
    this.assertInitialized();
    return {
      enabled: this.config.enabled,
      configured: Boolean(this.config.ownerId),
      registration: "invite",
      defaultQuotaBytes: this.config.defaultQuotaBytes,
      defaultTierId: this.config.defaultTierId,
      defaultCodexThreadLimit: this.config.defaultCodexThreadLimit,
    };
  }

  policySnapshot(actorId) {
    const actor = this.requireRole(actorId, ["owner", "admin"]);
    return {
      canManage: actor.role === "owner",
      canManageCodexThreadLimit: ["owner", "admin"].includes(actor.role),
      defaultCodexThreadLimit: this.config.defaultCodexThreadLimit,
      codexThreadLimitUpdatedAt: this.config.codexThreadLimitUpdatedAt || null,
      codexThreadLimitUpdatedBy: this.config.codexThreadLimitUpdatedBy || null,
      defaultTierId: this.config.defaultTierId,
      defaultProviderId: this.config.defaultProviderId,
      defaultPermissions: { ...this.config.defaultPermissions },
      tiers: this.config.tiers.map(publicTier),
    };
  }

  sessionMaxAgeSeconds() {
    return Math.floor(this.sessionTtlMs / 1000);
  }

  async enable({ username, password }) {
    return this.mutate(async () => {
      if (!this.legacyAuth) throw storeError(409, "启用多用户前必须先配置当前网页密码");
      if (!verifyAuthCredentials(String(username || ""), String(password || ""), this.legacyAuth)) {
        throw storeError(403, "当前管理员密码不正确");
      }

      let owner = this.users.users.find((user) => user.id === this.config.ownerId);
      if (!owner) {
        const now = this.now();
        owner = {
          id: createUserId(),
          username: this.legacyAuth.username,
          displayName: this.legacyAuth.username,
          role: "owner",
          status: "active",
          password: { ...this.legacyAuth },
          legacy: true,
          systemUsername: null,
          uid: typeof process.getuid === "function" ? process.getuid() : null,
          gid: typeof process.getgid === "function" ? process.getgid() : null,
          home: this.legacyHome,
          codexHome: path.join(this.legacyHome, ".codex"),
          projectRoot: this.legacyProjectRoot,
          defaultProject: this.legacyDefaultProject,
          stateDirectory: this.legacyStateDirectory,
          quotaBytes: this.config.defaultQuotaBytes,
          quotaMode: "host-owner",
          fiveHourTokenLimit: null,
          weeklyTokenLimit: null,
          monthlyTokenLimit: null,
          codexThreadLimit: null,
          codexThreadLimitUpdatedAt: null,
          codexThreadLimitUpdatedBy: null,
          permissions: defaultPermissions("owner"),
          tierId: null,
          tierName: null,
          tierExpiresAt: null,
          managedProvider: null,
          pendingProviderId: null,
          createdAt: now,
          updatedAt: now,
        };
        this.users.users.push(owner);
        this.config.ownerId = owner.id;
      }
      this.config.enabled = true;
      this.config.updatedAt = this.now();
      const token = this.createSessionRecord(owner.id);
      await Promise.all([
        writeJsonAtomic(this.configPath, this.config),
        writeJsonAtomic(this.usersPath, this.users),
        writeJsonAtomic(this.sessionsPath, this.sessions),
      ]);
      await this.audit("multi_user.enabled", owner.id, { mode: "invite" });
      return { user: publicUser(owner, this.config.defaultCodexThreadLimit), token };
    });
  }

  async disable(actorId, password) {
    return this.mutate(async () => {
      const actor = this.requireUser(actorId);
      if (actor.role !== "owner") throw storeError(403, "只有所有者可以关闭多用户功能");
      if (!verifyAuthCredentials(actor.username, String(password || ""), actor.password)) {
        throw storeError(403, "所有者密码不正确");
      }
      this.config.enabled = false;
      this.config.updatedAt = this.now();
      this.sessions.sessions = [];
      await Promise.all([
        writeJsonAtomic(this.configPath, this.config),
        writeJsonAtomic(this.sessionsPath, this.sessions),
      ]);
      await this.audit("multi_user.disabled", actor.id, {});
    });
  }

  async login(username, password) {
    return this.mutate(async () => {
      if (!this.config.enabled) throw storeError(409, "多用户登录当前未启用");
      const normalized = normalizeUsername(username);
      const user = this.users.users.find((entry) => entry.username.toLowerCase() === normalized.toLowerCase());
      const credential = this.credentialForUser(user);
      if (!user || user.status !== "active" || !credential || !verifyAuthCredentials(user.username, String(password || ""), credential)) {
        throw storeError(401, "用户名或密码不正确");
      }
      const token = this.createSessionRecord(user.id);
      await writeJsonAtomic(this.sessionsPath, this.sessions);
      await this.audit("session.login", user.id, {});
      return { user: publicUser(user, this.config.defaultCodexThreadLimit), token };
    }, { allowReadOnly: true });
  }

  async authenticate(token) {
    const authenticated = await this.authenticateSession(token);
    return authenticated?.user || null;
  }

  async authenticateSession(token) {
    this.assertInitialized();
    if (!this.config.enabled || !SESSION_TOKEN_PATTERN.test(String(token || ""))) return null;
    const hash = hashToken(token);
    let source = "primary";
    let session = this.sessions.sessions.find((entry) => safeEqual(entry.tokenHash, hash));
    if (!session && this.sessionFallbackPath && this.sessionFallbackPath !== this.sessionsPath) {
      // Rescue and other read-only consumers must not retain a revoked primary
      // session in their startup snapshot. Refresh the fallback before every
      // authentication decision instead of trusting stale in-memory state.
      this.fallbackSessions = await readJson(
        this.sessionFallbackPath,
        { version: STORE_VERSION, sessions: [] },
      );
      session = this.fallbackSessions.sessions.find((entry) => safeEqual(entry.tokenHash, hash));
      source = "fallback";
    }
    if (!session || session.expiresAt <= this.now()) return null;
    const user = this.users.users.find((entry) => entry.id === session.userId && entry.status === "active");
    if (!user) return null;
    return {
      user: publicUser(user, this.config.defaultCodexThreadLimit),
      session: publicSessionIdentity(session, source),
    };
  }

  async sessionIsActive(identity) {
    this.assertInitialized();
    const sessionId = String(identity?.id || "");
    const userId = String(identity?.userId || "");
    if (!sessionId || !userId || identity?.expiresAt <= this.now()) return false;
    let sessions = this.sessions.sessions;
    if (identity?.source === "fallback") {
      if (!this.sessionFallbackPath || this.sessionFallbackPath === this.sessionsPath) return false;
      this.fallbackSessions = await readJson(
        this.sessionFallbackPath,
        { version: STORE_VERSION, sessions: [] },
      );
      sessions = this.fallbackSessions.sessions;
    }
    const session = sessions.find((entry) => entry.id === sessionId && entry.userId === userId);
    if (!session || session.expiresAt <= this.now()) return false;
    return this.users.users.some((entry) => entry.id === userId && entry.status === "active");
  }

  verifyPassword(userId, password) {
    this.assertInitialized();
    const user = this.users.users.find((entry) => entry.id === userId && entry.status === "active");
    if (!user) return false;
    const credential = this.credentialForUser(user);
    return Boolean(credential && verifyAuthCredentials(user.username, String(password || ""), credential));
  }

  setOwnerCredentialOverride(record) {
    this.assertInitialized();
    if (record === null || record === undefined) {
      this.ownerCredentialOverride = null;
      return;
    }
    validateAuthRecord(record);
    this.ownerCredentialOverride = { ...record };
  }

  credentialForUser(user) {
    if (!user) return null;
    if (user.role === "owner" && this.ownerCredentialOverride) {
      if (this.ownerCredentialOverride.username !== user.username) return null;
      return this.ownerCredentialOverride;
    }
    return user.password;
  }

  async logout(token) {
    return Boolean(await this.revokeSession(token));
  }

  async revokeSession(token) {
    return this.mutate(async () => {
      if (!SESSION_TOKEN_PATTERN.test(String(token || ""))) return null;
      const hash = hashToken(token);
      const index = this.sessions.sessions.findIndex((entry) => safeEqual(entry.tokenHash, hash));
      if (index === -1) return null;
      const [session] = this.sessions.sessions.splice(index, 1);
      await writeJsonAtomic(this.sessionsPath, this.sessions);
      await this.audit("session.logout", session.userId, {});
      return publicSessionIdentity(session, "primary");
    }, { allowReadOnly: true });
  }

  async createInvite(actorId, input = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner", "admin"]);
      const normalizedRole = normalizeInviteRole(input.role, actor.role);
      const tier = this.requireTier(input.tierId ?? this.config.defaultTierId);
      const normalizedQuota = normalizeQuota(input.quotaBytes ?? tier.quotaBytes);
      const permissions = normalizedRole === "member"
        ? normalizePermissions(input.permissions ?? this.config.defaultPermissions, normalizedRole)
        : defaultPermissions(normalizedRole);
      const providerId = normalizedRole === "member"
        ? normalizeProviderId(Object.hasOwn(input, "providerId") ? input.providerId : (tier.providerId ?? this.config.defaultProviderId))
        : null;
      const fiveHourTokenLimit = normalizeFiveHourTokenLimit(
        Object.hasOwn(input, "fiveHourTokenLimit") ? input.fiveHourTokenLimit : tier.fiveHourTokenLimit,
      );
      const weeklyTokenLimit = normalizeWeeklyTokenLimit(
        Object.hasOwn(input, "weeklyTokenLimit") ? input.weeklyTokenLimit : tier.weeklyTokenLimit,
      );
      const monthlyTokenLimit = normalizeMonthlyTokenLimit(
        Object.hasOwn(input, "monthlyTokenLimit") ? input.monthlyTokenLimit : tier.monthlyTokenLimit,
      );
      const ttlMs = Math.min(MAX_INVITE_TTL_MS, Math.max(60 * 60 * 1000, Number(input.expiresHours) * 60 * 60 * 1000 || DEFAULT_INVITE_TTL_MS));
      const token = crypto.randomBytes(32).toString("base64url");
      const now = this.now();
      const invite = {
        id: `i-${crypto.randomBytes(8).toString("hex")}`,
        tokenHash: hashToken(token),
        role: normalizedRole,
        tierId: normalizedRole === "member" ? tier.id : null,
        tierName: normalizedRole === "member" ? tier.name : null,
        quotaBytes: normalizedQuota,
        fiveHourTokenLimit,
        weeklyTokenLimit,
        monthlyTokenLimit,
        permissions,
        providerId,
        createdBy: actor.id,
        createdAt: now,
        expiresAt: now + ttlMs,
        usedAt: null,
      };
      this.invites.invites.push(invite);
      await writeJsonAtomic(this.invitesPath, this.invites);
      await this.audit("invite.created", actor.id, {
        inviteId: invite.id,
        role: normalizedRole,
        tierId: invite.tierId,
        quotaBytes: normalizedQuota,
        providerConfigured: Boolean(providerId),
      });
      return { ...publicInvite(invite), token };
    });
  }

  async register(token, input, provisionUser) {
    return this.mutate(async () => {
      if (!this.config.enabled) throw storeError(409, "多用户注册当前未启用");
      const tokenHash = hashToken(String(token || ""));
      const invite = this.invites.invites.find((entry) => safeEqual(entry.tokenHash, tokenHash));
      if (!invite || invite.usedAt || invite.expiresAt <= this.now()) throw storeError(400, "邀请链接无效或已过期");
      const username = normalizeUsername(input?.username);
      if (this.users.users.some((entry) => entry.username.toLowerCase() === username.toLowerCase())) {
        throw storeError(409, "用户名已经存在");
      }
      const password = createAuthRecord(username, String(input?.password || ""));
      const displayName = normalizeDisplayName(input?.displayName, username);
      const now = this.now();
      const user = {
        id: createUserId(),
        username,
        displayName,
        role: invite.role,
        status: "active",
        password,
        legacy: false,
        systemUsername: null,
        uid: null,
        gid: null,
        home: null,
        codexHome: null,
        projectRoot: null,
        stateDirectory: null,
        quotaBytes: invite.quotaBytes,
        quotaMode: null,
        fiveHourTokenLimit: invite.fiveHourTokenLimit,
        weeklyTokenLimit: invite.weeklyTokenLimit,
        monthlyTokenLimit: invite.monthlyTokenLimit,
        codexThreadLimit: null,
        codexThreadLimitUpdatedAt: null,
        codexThreadLimitUpdatedBy: null,
        permissions: normalizePermissions(invite.permissions, invite.role),
        tierId: invite.tierId,
        tierName: invite.tierName,
        tierExpiresAt: null,
        managedProvider: null,
        pendingProviderId: invite.providerId,
        createdAt: now,
        updatedAt: now,
      };
      if (typeof provisionUser !== "function") throw new Error("User provisioner is required");
      const layout = await provisionUser({ ...user });
      const cleanup = typeof layout?.cleanup === "function" ? layout.cleanup : null;
      const previousSessions = structuredClone(this.sessions);
      let committed = false;
      try {
        Object.assign(user, normalizeLayout(layout, user.id, this.usersRoot, this.userStateRoot));
        this.users.users.push(user);
        invite.usedAt = now;
        invite.usedBy = user.id;
        const sessionToken = this.createSessionRecord(user.id);
        await Promise.all([
          writeJsonAtomic(this.usersPath, this.users),
          writeJsonAtomic(this.invitesPath, this.invites),
          writeJsonAtomic(this.sessionsPath, this.sessions),
        ]);
        committed = true;
        await this.audit("user.registered", user.id, {
          inviteId: invite.id,
          role: user.role,
          tierId: user.tierId,
          quotaBytes: user.quotaBytes,
          providerPending: Boolean(user.pendingProviderId),
        });
        return { user: publicUser(user, this.config.defaultCodexThreadLimit), token: sessionToken };
      } catch (error) {
        if (!committed) {
          this.users.users = this.users.users.filter((entry) => entry.id !== user.id);
          invite.usedAt = null;
          delete invite.usedBy;
          this.sessions = previousSessions;
          const rollback = await Promise.allSettled([
            writeJsonAtomic(this.usersPath, this.users),
            writeJsonAtomic(this.invitesPath, this.invites),
            writeJsonAtomic(this.sessionsPath, this.sessions),
            ...(cleanup ? [cleanup()] : []),
          ]);
          const failures = rollback.filter((result) => result.status === "rejected").map((result) => result.reason);
          if (failures.length) error.rollbackError = new AggregateError(failures, "Registration rollback failed");
        }
        throw error;
      }
    });
  }

  listUsers(actorId) {
    this.requireRole(actorId, ["owner", "admin"]);
    return this.users.users
      .map((user) => publicUser(user, this.config.defaultCodexThreadLimit))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listInvites(actorId) {
    this.requireRole(actorId, ["owner", "admin"]);
    return this.invites.invites.map(publicInvite).sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateSingleUserCodexThreadLimit(actorId, value) {
    return this.mutate(async () => {
      if (this.config.enabled || this.config.ownerId) {
        throw storeError(409, "当前账号已配置多用户工作区，请修改当前用户的 Codex 并发线程上限");
      }
      const limit = normalizeCodexThreadLimit(value);
      const now = this.now();
      this.config.defaultCodexThreadLimit = limit;
      this.config.codexThreadLimitUpdatedAt = now;
      this.config.codexThreadLimitUpdatedBy = USER_ID_PATTERN.test(String(actorId || ""))
        ? String(actorId)
        : null;
      this.config.updatedAt = now;
      await writeJsonAtomic(this.configPath, this.config);
      await this.audit("user_policy.updated", actorId, {
        defaultCodexThreadLimit: this.config.defaultCodexThreadLimit,
        singleUserMode: true,
      });
      return { defaultCodexThreadLimit: this.config.defaultCodexThreadLimit };
    });
  }

  async updatePolicy(actorId, input = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner", "admin"]);
      if (actor.role !== "owner") {
        const unsupported = Object.keys(input).filter((key) => key !== "defaultCodexThreadLimit");
        if (unsupported.length) throw storeError(403, "管理员只能修改 Codex 并发线程默认上限");
      }
      if (Object.hasOwn(input, "defaultTierId")) {
        this.config.defaultTierId = this.requireTier(input.defaultTierId).id;
      }
      if (Object.hasOwn(input, "defaultProviderId")) {
        this.config.defaultProviderId = normalizeProviderId(input.defaultProviderId);
      }
      if (Object.hasOwn(input, "defaultPermissions")) {
        this.config.defaultPermissions = normalizePermissions(input.defaultPermissions, "member");
      }
      if (Object.hasOwn(input, "defaultCodexThreadLimit")) {
        this.config.defaultCodexThreadLimit = normalizeCodexThreadLimit(input.defaultCodexThreadLimit);
        this.config.codexThreadLimitUpdatedAt = this.now();
        this.config.codexThreadLimitUpdatedBy = actor.id;
      }
      this.config.updatedAt = this.now();
      await writeJsonAtomic(this.configPath, this.config);
      await this.audit("user_policy.updated", actor.id, {
        defaultTierId: this.config.defaultTierId,
        providerConfigured: Boolean(this.config.defaultProviderId),
        defaultPermissions: this.config.defaultPermissions,
        defaultCodexThreadLimit: this.config.defaultCodexThreadLimit,
      });
      return this.policySnapshot(actor.id);
    });
  }

  async createTier(actorId, input = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner"]);
      if (this.config.tiers.length >= 20) throw storeError(400, "最多创建 20 个用户套餐");
      const tier = normalizeTier(input, {
        id: `t-${crypto.randomBytes(6).toString("hex")}`,
        name: "新套餐",
        quotaBytes: this.config.defaultQuotaBytes,
        fiveHourTokenLimit: null,
        weeklyTokenLimit: null,
        monthlyTokenLimit: null,
        permissions: this.config.defaultPermissions,
        providerId: null,
      });
      if (this.config.tiers.some((entry) => entry.name.toLowerCase() === tier.name.toLowerCase())) {
        throw storeError(409, "套餐名称已经存在");
      }
      this.config.tiers.push(tier);
      this.config.updatedAt = this.now();
      await writeJsonAtomic(this.configPath, this.config);
      await this.audit("user_tier.created", actor.id, { tierId: tier.id, name: tier.name });
      return publicTier(tier);
    });
  }

  async updateTier(actorId, tierId, input = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner"]);
      const index = this.config.tiers.findIndex((entry) => entry.id === tierId);
      if (index === -1) throw storeError(404, "用户套餐不存在");
      const tier = normalizeTier(input, this.config.tiers[index]);
      if (this.config.tiers.some((entry, entryIndex) => entryIndex !== index && entry.name.toLowerCase() === tier.name.toLowerCase())) {
        throw storeError(409, "套餐名称已经存在");
      }
      this.config.tiers[index] = tier;
      if (tier.id === "tier-default") this.config.defaultQuotaBytes = tier.quotaBytes;
      this.config.updatedAt = this.now();
      await writeJsonAtomic(this.configPath, this.config);
      await this.audit("user_tier.updated", actor.id, { tierId: tier.id, name: tier.name });
      return publicTier(tier);
    });
  }

  async removeTier(actorId, tierId) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner"]);
      if (tierId === this.config.defaultTierId || tierId === "tier-default") {
        throw storeError(409, "默认套餐不能删除");
      }
      if (this.users.users.some((user) => user.tierId === tierId)) {
        throw storeError(409, "仍有用户使用这个套餐");
      }
      if (this.invites.invites.some((invite) => !invite.usedAt && invite.expiresAt > this.now() && invite.tierId === tierId)) {
        throw storeError(409, "仍有有效邀请使用这个套餐");
      }
      const index = this.config.tiers.findIndex((entry) => entry.id === tierId);
      if (index === -1) throw storeError(404, "用户套餐不存在");
      const [tier] = this.config.tiers.splice(index, 1);
      this.config.updatedAt = this.now();
      await writeJsonAtomic(this.configPath, this.config);
      await this.audit("user_tier.removed", actor.id, { tierId: tier.id, name: tier.name });
      return publicTier(tier);
    });
  }

  getTier(actorId, tierId) {
    this.requireRole(actorId, ["owner", "admin"]);
    return publicTier(this.requireTier(tierId));
  }

  getTierAssignment(actorId, tierId, tierExpiresAt = null) {
    return {
      tier: this.getTier(actorId, tierId),
      tierExpiresAt: normalizeTierExpiration(tierExpiresAt, this.now()),
    };
  }

  async setManagedProvider(actorId, userId, assignment, { preserveTier = false } = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner", "admin"]);
      const user = this.users.users.find((entry) => entry.id === userId);
      if (!user || user.role === "owner") throw storeError(409, "目标用户不可分配供应商");
      if (actor.role !== "owner" && user.role !== "member") throw storeError(403, "管理员只能管理普通用户");
      user.managedProvider = normalizeManagedProvider(assignment);
      const tier = this.config.tiers.find((entry) => entry.id === user.tierId);
      if (!preserveTier && tier && (tier.providerId || user.managedProvider) && tier.providerId !== user.managedProvider?.sourceProviderId) {
        clearTierAssignment(user);
      }
      user.pendingProviderId = null;
      user.updatedAt = this.now();
      await writeJsonAtomic(this.usersPath, this.users);
      return publicUser(user, this.config.defaultCodexThreadLimit);
    });
  }

  providerReferences(actorId, providerId) {
    this.requireRole(actorId, ["owner"]);
    const normalized = normalizeProviderId(providerId);
    return {
      defaultPolicy: this.config.defaultProviderId === normalized,
      tiers: this.config.tiers.filter((tier) => tier.providerId === normalized).map((tier) => tier.id),
      users: this.users.users.filter((user) => user.managedProvider?.sourceProviderId === normalized).map((user) => user.id),
      invites: this.invites.invites
        .filter((invite) => !invite.usedAt && invite.expiresAt > this.now() && invite.providerId === normalized)
        .map((invite) => invite.id),
    };
  }

  async updateUser(actorId, userId, input = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner", "admin"]);
      const user = this.users.users.find((entry) => entry.id === userId);
      if (!user) throw storeError(404, "用户账号不存在");
      const onlyThreadLimit = Object.keys(input).every((key) => key === "codexThreadLimit");
      if (user.role === "owner" && !(onlyThreadLimit && actor.id === user.id)) {
        throw storeError(409, "所有者账号只能修改自己的 Codex 并发线程上限");
      }
      if (actor.role !== "owner" && user.role !== "member" && !(onlyThreadLimit && actor.id === user.id)) {
        throw storeError(403, "管理员只能管理普通用户或自己的 Codex 并发线程上限");
      }
      const previousManualSettings = {
        quotaBytes: user.quotaBytes,
        fiveHourTokenLimit: user.fiveHourTokenLimit,
        weeklyTokenLimit: user.weeklyTokenLimit,
        monthlyTokenLimit: user.monthlyTokenLimit,
          permissions: {
            customProviders: user.permissions?.customProviders === true,
            officialLogin: user.permissions?.officialLogin === true,
            projectSharing: user.permissions?.projectSharing === true,
            codexSkills: user.permissions?.codexSkills === true,
            codexPlugins: user.permissions?.codexPlugins === true,
            codexApps: user.permissions?.codexApps === true,
            codexMcp: user.permissions?.codexMcp === true,
            codexMigration: user.permissions?.codexMigration === true,
            codexMemory: user.permissions?.codexMemory === true,
            codexBackground: user.permissions?.codexBackground === true,
            codexTerminal: user.permissions?.codexTerminal === true,
            codexWorkspaceMessages: user.permissions?.codexWorkspaceMessages === true,
            codexRemoteDiff: user.permissions?.codexRemoteDiff === true,
            codexFeedback: user.permissions?.codexFeedback === true,
            claudeRuntime: user.permissions?.claudeRuntime === true,
            claudeOfficialLogin: user.permissions?.claudeOfficialLogin === true,
            claudeProviders: user.permissions?.claudeProviders === true,
            claudeExtensions: user.permissions?.claudeExtensions === true,
            claudeMcp: user.permissions?.claudeMcp === true,
            claudeHooks: user.permissions?.claudeHooks === true,
            claudeMemory: user.permissions?.claudeMemory === true,
            claudeBackground: user.permissions?.claudeBackground === true,
            claudeWorktree: user.permissions?.claudeWorktree === true,
            claudeProxy: user.permissions?.claudeProxy === true,
            claudeStructuredOutput: user.permissions?.claudeStructuredOutput === true,
            claudeUltraReview: user.permissions?.claudeUltraReview === true,
            claudeProjectPurge: user.permissions?.claudeProjectPurge === true,
            claudeBetaHeaders: user.permissions?.claudeBetaHeaders === true,
          },
      };
      const tierIdSubmitted = Object.hasOwn(input, "tierId");
      const submittedTier = tierIdSubmitted && input.tierId !== null ? this.requireTier(input.tierId) : null;
      const submittedTierExpiration = submittedTier || (!tierIdSubmitted && Object.hasOwn(input, "tierExpiresAt"))
        ? normalizeTierExpiration(input.tierExpiresAt, this.now())
        : null;
      if (!tierIdSubmitted && Object.hasOwn(input, "tierExpiresAt") && !user.tierId) {
        throw storeError(409, "当前用户没有可设置有效期的套餐");
      }
      if (Object.hasOwn(input, "status")) {
        if (!["active", "disabled"].includes(input.status)) throw storeError(400, "用户状态不正确");
        user.status = input.status;
        if (user.status === "disabled") {
          this.sessions.sessions = this.sessions.sessions.filter((session) => session.userId !== user.id);
        }
      }
      if (Object.hasOwn(input, "role")) user.role = normalizeInviteRole(input.role, actor.role);
      if (Object.hasOwn(input, "quotaBytes")) user.quotaBytes = normalizeQuota(input.quotaBytes);
      if (Object.hasOwn(input, "monthlyTokenLimit")) {
        user.monthlyTokenLimit = normalizeMonthlyTokenLimit(input.monthlyTokenLimit);
      }
      if (Object.hasOwn(input, "fiveHourTokenLimit")) {
        user.fiveHourTokenLimit = normalizeFiveHourTokenLimit(input.fiveHourTokenLimit);
      }
      if (Object.hasOwn(input, "weeklyTokenLimit")) {
        user.weeklyTokenLimit = normalizeWeeklyTokenLimit(input.weeklyTokenLimit);
      }
      if (Object.hasOwn(input, "codexThreadLimit")) {
        user.codexThreadLimit = input.codexThreadLimit === null || input.codexThreadLimit === ""
          ? null
          : normalizeCodexThreadLimit(input.codexThreadLimit);
        user.codexThreadLimitUpdatedAt = this.now();
        user.codexThreadLimitUpdatedBy = actor.id;
      }
      if (Object.hasOwn(input, "quotaMode") && !user.legacy) {
        user.quotaMode = input.quotaMode === "filesystem" ? "filesystem" : "application";
      }
      if (Object.hasOwn(input, "permissions")) {
        user.permissions = normalizePermissions(input.permissions, user.role);
      } else if (Object.hasOwn(input, "role")) {
        user.permissions = normalizePermissions(user.permissions, user.role);
      }
      if (tierIdSubmitted) {
        if (input.tierId === null) {
          clearTierAssignment(user);
        } else {
          user.tierId = submittedTier.id;
          user.tierName = submittedTier.name;
          user.tierExpiresAt = submittedTierExpiration;
        }
      } else if (Object.hasOwn(input, "tierExpiresAt")) {
        user.tierExpiresAt = submittedTierExpiration;
      } else if (["quotaBytes", "fiveHourTokenLimit", "weeklyTokenLimit", "monthlyTokenLimit", "permissions"]
        .some((key) => Object.hasOwn(input, key) && (
          key === "permissions"
            ? previousManualSettings.permissions.customProviders !== user.permissions.customProviders
              || previousManualSettings.permissions.officialLogin !== user.permissions.officialLogin
              || previousManualSettings.permissions.projectSharing !== user.permissions.projectSharing
              || previousManualSettings.permissions.codexSkills !== user.permissions.codexSkills
              || previousManualSettings.permissions.codexPlugins !== user.permissions.codexPlugins
              || previousManualSettings.permissions.codexApps !== user.permissions.codexApps
              || previousManualSettings.permissions.codexMcp !== user.permissions.codexMcp
              || previousManualSettings.permissions.codexMigration !== user.permissions.codexMigration
              || previousManualSettings.permissions.codexMemory !== user.permissions.codexMemory
              || previousManualSettings.permissions.codexBackground !== user.permissions.codexBackground
              || previousManualSettings.permissions.codexTerminal !== user.permissions.codexTerminal
              || previousManualSettings.permissions.codexWorkspaceMessages !== user.permissions.codexWorkspaceMessages
              || previousManualSettings.permissions.codexRemoteDiff !== user.permissions.codexRemoteDiff
              || previousManualSettings.permissions.codexFeedback !== user.permissions.codexFeedback
              || previousManualSettings.permissions.claudeRuntime !== user.permissions.claudeRuntime
              || previousManualSettings.permissions.claudeOfficialLogin !== user.permissions.claudeOfficialLogin
              || previousManualSettings.permissions.claudeProviders !== user.permissions.claudeProviders
              || previousManualSettings.permissions.claudeExtensions !== user.permissions.claudeExtensions
              || previousManualSettings.permissions.claudeMcp !== user.permissions.claudeMcp
              || previousManualSettings.permissions.claudeHooks !== user.permissions.claudeHooks
              || previousManualSettings.permissions.claudeMemory !== user.permissions.claudeMemory
              || previousManualSettings.permissions.claudeBackground !== user.permissions.claudeBackground
              || previousManualSettings.permissions.claudeWorktree !== user.permissions.claudeWorktree
              || previousManualSettings.permissions.claudeProxy !== user.permissions.claudeProxy
              || previousManualSettings.permissions.claudeStructuredOutput !== user.permissions.claudeStructuredOutput
              || previousManualSettings.permissions.claudeUltraReview !== user.permissions.claudeUltraReview
              || previousManualSettings.permissions.claudeProjectPurge !== user.permissions.claudeProjectPurge
              || previousManualSettings.permissions.claudeBetaHeaders !== user.permissions.claudeBetaHeaders
            : previousManualSettings[key] !== user[key]
        ))) {
        clearTierAssignment(user);
      }
      user.updatedAt = this.now();
      await Promise.all([
        writeJsonAtomic(this.usersPath, this.users),
        writeJsonAtomic(this.sessionsPath, this.sessions),
      ]);
      await this.audit("user.updated", actor.id, {
        userId: user.id,
        role: user.role,
        status: user.status,
        quotaBytes: user.quotaBytes,
        fiveHourTokenLimit: user.fiveHourTokenLimit,
        weeklyTokenLimit: user.weeklyTokenLimit,
        monthlyTokenLimit: user.monthlyTokenLimit,
        tierId: user.tierId,
        tierExpiresAt: user.tierExpiresAt,
        codexThreadLimit: user.codexThreadLimit,
      });
      return publicUser(user, this.config.defaultCodexThreadLimit);
    });
  }

  async updateOwnProfile(userId, input = {}) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      const previousDisplayName = user.displayName;
      const displayName = Object.hasOwn(input, "displayName")
        ? normalizeDisplayName(input.displayName, user.username)
        : user.displayName;
      const newPassword = String(input.newPassword || "");
      const passwordChanged = newPassword.length > 0;
      let password = user.password;

      if (passwordChanged) {
        if (!verifyAuthCredentials(user.username, String(input.currentPassword || ""), user.password)) {
          throw storeError(403, "当前密码不正确");
        }
        if (newPassword.length < 16 || newPassword.length > 256) {
          throw storeError(400, "新密码必须为 16-256 个字符");
        }
        password = {
          ...createAuthRecord(user.username, newPassword),
          credentialRevision: nextAuthCredentialRevision(user.password?.credentialRevision, this.now()),
        };
      }

      user.displayName = displayName;
      user.password = password;
      user.updatedAt = this.now();
      let token = null;
      if (passwordChanged) {
        // Keep the owner's existing authenticated work alive. Password changes
        // must not fence an administrator's running conversation; new logins
        // still require the new password and the current browser receives a
        // freshly issued session below.
        if (user.role !== "owner") {
          this.sessions.sessions = this.sessions.sessions.filter((session) => session.userId !== user.id);
        }
        token = this.createSessionRecord(user.id);
      }
      await Promise.all([
        writeJsonAtomic(this.usersPath, this.users),
        ...(passwordChanged && user.legacy && this.legacyAuthPath && !this.readOnly
          ? [writeAuth(this.legacyAuthPath, password)]
          : []),
        ...(passwordChanged ? [writeJsonAtomic(this.sessionsPath, this.sessions)] : []),
      ]);
      if (passwordChanged && user.legacy) this.legacyAuth = { ...password };
      await this.audit("user.profile_updated", user.id, {
        displayNameChanged: displayName !== previousDisplayName,
        passwordChanged,
      });
      return { user: publicUser(user, this.config.defaultCodexThreadLimit), token };
    });
  }

  listProjectShares(actorId) {
    const actor = this.requireRole(actorId, ["owner", "admin"]);
    return this.shares.shares
      .filter((share) => actor.role === "owner" || share.sourceUserId === actor.id || share.targetUserId === actor.id)
      .map(publicProjectShare)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  projectSharesForUser(userId) {
    const user = this.requireUser(userId);
    if (!normalizePermissions(user.permissions, user.role).projectSharing) return [];
    return this.shares.shares
      .filter((share) => share.targetUserId === userId)
      .map(publicProjectShare);
  }

  getProjectShare(shareId) {
    const share = this.shares.shares.find((entry) => entry.id === shareId);
    return share ? publicProjectShare(share) : null;
  }

  projectSharesInvolving(userId) {
    return this.shares.shares
      .filter((share) => share.sourceUserId === userId || share.targetUserId === userId)
      .map(publicProjectShare);
  }

  async createProjectShare(actorId, { projectPath, targetUserId, access = "read" } = {}) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner", "admin"]);
      const target = this.requireUser(targetUserId);
      if (target.id === actor.id) throw storeError(409, "不能把工程共享给自己");
      if (!normalizePermissions(target.permissions, target.role).projectSharing) {
        throw storeError(409, "目标用户尚未获得共享工程权限");
      }
      const normalizedPath = path.resolve(String(projectPath || ""));
      const normalizedAccess = access === "write" ? "write" : access === "read" ? "read" : null;
      if (!path.isAbsolute(String(projectPath || "")) || !normalizedAccess) throw storeError(400, "共享工程参数不正确");
      if (normalizedAccess === "write" && target.quotaMode !== "filesystem") {
        throw storeError(409, "可编辑共享需要目标用户启用文件系统硬配额");
      }
      const duplicate = this.shares.shares.find((share) => (
        share.sourceUserId === actor.id && share.targetUserId === target.id && share.projectPath === normalizedPath
      ));
      if (duplicate) throw storeError(409, "这个工程已经共享给该用户");
      const share = {
        id: `ps-${crypto.randomBytes(8).toString("hex")}`,
        sourceUserId: actor.id,
        targetUserId: target.id,
        projectPath: normalizedPath,
        access: normalizedAccess,
        createdAt: this.now(),
      };
      this.shares.shares.push(share);
      await writeJsonAtomic(this.sharesPath, this.shares);
      await this.audit("project.shared", actor.id, {
        shareId: share.id,
        targetUserId: target.id,
        projectPath: normalizedPath,
        access: normalizedAccess,
      });
      return publicProjectShare(share);
    });
  }

  async removeProjectShare(actorId, shareId) {
    return this.mutate(async () => {
      const actor = this.requireRole(actorId, ["owner", "admin"]);
      const index = this.shares.shares.findIndex((share) => share.id === shareId);
      if (index === -1) throw storeError(404, "共享工程授权不存在");
      const share = this.shares.shares[index];
      const target = this.users.users.find((user) => user.id === share.targetUserId);
      const adminManagingMember = actor.role === "admin" && target?.role === "member";
      if (actor.role !== "owner" && share.sourceUserId !== actor.id && !adminManagingMember) {
        throw storeError(403, "当前账号不能撤销这个共享工程");
      }
      this.shares.shares.splice(index, 1);
      await writeJsonAtomic(this.sharesPath, this.shares);
      await this.audit("project.share_removed", actor.id, { shareId: share.id, targetUserId: share.targetUserId });
      return publicProjectShare(share);
    });
  }

  getUser(userId) {
    const user = this.users.users.find((entry) => entry.id === userId);
    return user ? structuredClone(user) : null;
  }

  findActiveUserByUsername(username) {
    this.assertInitialized();
    const normalized = String(username || "").trim().toLowerCase();
    if (!normalized) return null;
    const user = this.users.users.find((entry) => (
      entry.status === "active" && entry.username.toLowerCase() === normalized
    ));
    return user ? structuredClone(user) : null;
  }

  codexThreadLimitForUser(userId) {
    const user = this.users.users.find((entry) => entry.id === userId);
    return user?.codexThreadLimit ?? this.config.defaultCodexThreadLimit;
  }

  getOwner() {
    return this.getUser(this.config.ownerId);
  }

  async pruneExpired() {
    if (this.readOnly) return;
    return this.mutate(async () => {
      const now = this.now();
      const beforeSessions = this.sessions.sessions.length;
      const beforeInvites = this.invites.invites.length;
      this.sessions.sessions = this.sessions.sessions.filter((entry) => entry.expiresAt > now);
      this.invites.invites = this.invites.invites.filter((entry) => entry.usedAt || entry.expiresAt > now - MAX_INVITE_TTL_MS);
      const writes = [];
      if (this.sessions.sessions.length !== beforeSessions) writes.push(writeJsonAtomic(this.sessionsPath, this.sessions));
      if (this.invites.invites.length !== beforeInvites) writes.push(writeJsonAtomic(this.invitesPath, this.invites));
      await Promise.all(writes);
    });
  }

  createSessionRecord(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    this.sessions.sessions = this.sessions.sessions
      .filter((entry) => entry.userId !== userId || entry.expiresAt > now)
      .slice(-199);
    const userSessions = this.sessions.sessions.filter((entry) => entry.userId === userId);
    if (userSessions.length >= 20) {
      const oldest = userSessions.sort((a, b) => a.createdAt - b.createdAt)[0];
      this.sessions.sessions = this.sessions.sessions.filter((entry) => entry.id !== oldest.id);
    }
    this.sessions.sessions.push({
      id: `s-${crypto.randomBytes(8).toString("hex")}`,
      userId,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    });
    return token;
  }

  requireUser(userId) {
    const user = this.users.users.find((entry) => entry.id === userId);
    if (!user || user.status !== "active") throw storeError(403, "用户账号不可用");
    return user;
  }

  requireRole(userId, roles) {
    const user = this.requireUser(userId);
    if (!roles.includes(user.role)) throw storeError(403, "当前账号没有此操作权限");
    return user;
  }

  requireTier(tierId) {
    const tier = this.config.tiers.find((entry) => entry.id === tierId);
    if (!tier) throw storeError(404, "用户套餐不存在");
    return tier;
  }

  async audit(action, actorId, detail) {
    if (this.readOnly) return;
    const entry = JSON.stringify({ version: 1, at: this.now(), action, actorId, detail });
    await fs.appendFile(this.auditPath, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.auditPath, 0o600);
  }

  mutate(operation, { allowReadOnly = false } = {}) {
    if (this.readOnly && !allowReadOnly) {
      return Promise.reject(storeError(503, "独立救援服务只读，主服务恢复后再修改账号配置"));
    }
    const task = this.writeQueue.then(operation, operation);
    this.writeQueue = task.catch(() => {});
    return task;
  }

  assertInitialized() {
    if (!this.config || !this.users || !this.invites || !this.sessions || !this.shares) throw new Error("Multi-user store is not initialized");
  }
}

export function sessionCookieToken(header = "") {
  const value = header
    .split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === "codex_user_session")?.[1];
  return SESSION_TOKEN_PATTERN.test(value || "") ? value : null;
}

function defaultConfig(usersRoot, defaultQuotaBytes) {
  const tier = defaultTier(defaultQuotaBytes);
  return {
    version: STORE_VERSION,
    enabled: false,
    ownerId: null,
    usersRoot,
    defaultQuotaBytes,
    defaultCodexThreadLimit: DEFAULT_CODEX_THREAD_LIMIT,
    codexThreadLimitUpdatedAt: null,
    codexThreadLimitUpdatedBy: null,
    defaultTierId: tier.id,
    defaultProviderId: null,
    defaultPermissions: {
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
    },
    tiers: [tier],
    updatedAt: null,
  };
}

function validateStores(store) {
  if (store.config?.version !== STORE_VERSION || typeof store.config.enabled !== "boolean") {
    throw new Error("Invalid multi-user configuration");
  }
  if (!Array.isArray(store.users?.users) || !Array.isArray(store.invites?.invites) || !Array.isArray(store.sessions?.sessions) || !Array.isArray(store.shares?.shares)) {
    throw new Error("Invalid multi-user store");
  }
  store.config.defaultQuotaBytes = normalizeQuota(store.config.defaultQuotaBytes ?? store.defaultQuotaBytes);
  store.config.defaultCodexThreadLimit = normalizeCodexThreadLimit(
    store.config.defaultCodexThreadLimit ?? DEFAULT_CODEX_THREAD_LIMIT,
  );
  store.config.codexThreadLimitUpdatedAt = normalizeOptionalTimestamp(store.config.codexThreadLimitUpdatedAt);
  store.config.codexThreadLimitUpdatedBy = USER_ID_PATTERN.test(store.config.codexThreadLimitUpdatedBy || "")
    ? store.config.codexThreadLimitUpdatedBy
    : null;
  store.config.defaultPermissions = normalizePermissions(
    store.config.defaultPermissions ?? {
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
    },
    "member",
  );
  store.config.defaultProviderId = normalizeProviderId(store.config.defaultProviderId);
  store.config.tiers = Array.isArray(store.config.tiers) && store.config.tiers.length
    ? store.config.tiers.map((tier) => normalizeTier(tier, tier))
    : [defaultTier(store.config.defaultQuotaBytes)];
  const tierIds = new Set();
  const tiersById = new Map();
  const tierNames = new Set();
  for (const tier of store.config.tiers) {
    if (tierIds.has(tier.id) || tierNames.has(tier.name.toLowerCase())) throw new Error("Invalid duplicate user tier");
    tierIds.add(tier.id);
    tiersById.set(tier.id, tier);
    tierNames.add(tier.name.toLowerCase());
  }
  store.config.defaultTierId = tierIds.has(store.config.defaultTierId)
    ? store.config.defaultTierId
    : store.config.tiers[0].id;
  for (const user of store.users.users) {
    if (!USER_ID_PATTERN.test(user.id) || !USERNAME_PATTERN.test(user.username) || !["owner", "admin", "member"].includes(user.role)) {
      throw new Error("Invalid user record");
    }
    user.fiveHourTokenLimit = normalizeFiveHourTokenLimit(user.fiveHourTokenLimit);
    user.weeklyTokenLimit = normalizeWeeklyTokenLimit(user.weeklyTokenLimit);
    user.monthlyTokenLimit = normalizeMonthlyTokenLimit(user.monthlyTokenLimit);
    user.codexThreadLimit = user.codexThreadLimit === null || user.codexThreadLimit === undefined
      ? null
      : normalizeCodexThreadLimit(user.codexThreadLimit);
    user.codexThreadLimitUpdatedAt = normalizeOptionalTimestamp(user.codexThreadLimitUpdatedAt);
    user.codexThreadLimitUpdatedBy = USER_ID_PATTERN.test(user.codexThreadLimitUpdatedBy || "")
      ? user.codexThreadLimitUpdatedBy
      : null;
    user.permissions = normalizePermissions(user.permissions, user.role);
    const assignedTier = tiersById.get(user.tierId);
    if (assignedTier) {
      user.tierId = assignedTier.id;
      user.tierName = normalizeTierSnapshotName(user.tierName, assignedTier.name);
      user.tierExpiresAt = normalizeStoredTierExpiration(user.tierExpiresAt);
    } else {
      clearTierAssignment(user);
    }
    user.managedProvider = normalizeManagedProvider(user.managedProvider);
    user.pendingProviderId = normalizeProviderId(user.pendingProviderId);
  }
  for (const invite of store.invites.invites) {
    const inviteTier = tiersById.get(invite.tierId);
    invite.tierId = inviteTier?.id || null;
    invite.tierName = inviteTier ? normalizeTierSnapshotName(invite.tierName, inviteTier.name) : null;
    invite.fiveHourTokenLimit = normalizeFiveHourTokenLimit(invite.fiveHourTokenLimit);
    invite.weeklyTokenLimit = normalizeWeeklyTokenLimit(invite.weeklyTokenLimit);
    invite.monthlyTokenLimit = normalizeMonthlyTokenLimit(invite.monthlyTokenLimit);
    invite.permissions = normalizePermissions(invite.permissions, invite.role);
    invite.providerId = normalizeProviderId(invite.providerId);
  }
  for (const share of store.shares.shares) {
    if (!/^ps-[a-f0-9]{16}$/.test(share.id) || !USER_ID_PATTERN.test(share.sourceUserId) || !USER_ID_PATTERN.test(share.targetUserId)) {
      throw new Error("Invalid project share record");
    }
    if (!path.isAbsolute(share.projectPath) || !["read", "write"].includes(share.access)) {
      throw new Error("Invalid project share record");
    }
  }
}

function defaultTier(quotaBytes) {
  return {
    id: "tier-default",
    name: "默认套餐",
    quotaBytes: normalizeQuota(quotaBytes),
    fiveHourTokenLimit: null,
    weeklyTokenLimit: null,
    monthlyTokenLimit: null,
    permissions: {
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
    },
    providerId: null,
  };
}

function normalizeTier(input, fallback) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const previous = fallback && typeof fallback === "object" ? fallback : {};
  const id = String(previous.id || source.id || "");
  if (!TIER_ID_PATTERN.test(id)) throw storeError(400, "用户套餐编号不正确");
  const name = String(Object.hasOwn(source, "name") ? source.name : previous.name || "").trim();
  if (!name || name.length > 48) throw storeError(400, "套餐名称必须为 1-48 个字符");
  return {
    id,
    name,
    quotaBytes: normalizeQuota(Object.hasOwn(source, "quotaBytes") ? source.quotaBytes : previous.quotaBytes),
    fiveHourTokenLimit: normalizeFiveHourTokenLimit(Object.hasOwn(source, "fiveHourTokenLimit") ? source.fiveHourTokenLimit : previous.fiveHourTokenLimit),
    weeklyTokenLimit: normalizeWeeklyTokenLimit(Object.hasOwn(source, "weeklyTokenLimit") ? source.weeklyTokenLimit : previous.weeklyTokenLimit),
    monthlyTokenLimit: normalizeMonthlyTokenLimit(Object.hasOwn(source, "monthlyTokenLimit") ? source.monthlyTokenLimit : previous.monthlyTokenLimit),
    permissions: normalizePermissions(Object.hasOwn(source, "permissions") ? source.permissions : previous.permissions, "member"),
    providerId: normalizeProviderId(Object.hasOwn(source, "providerId") ? source.providerId : previous.providerId),
  };
}

function normalizeTierSnapshotName(value, fallback) {
  const name = String(value || "").trim();
  return name && name.length <= 48 ? name : fallback;
}

function normalizeStoredTierExpiration(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000
    ? timestamp
    : null;
}

function normalizeTierExpiration(value, now) {
  const timestamp = normalizeStoredTierExpiration(value);
  if (value === null || value === undefined || value === "") return null;
  if (timestamp === null || timestamp <= now) {
    throw storeError(400, "套餐到期时间必须晚于当前时间，留空表示长期有效");
  }
  return timestamp;
}

function clearTierAssignment(record) {
  record.tierId = null;
  record.tierName = null;
  record.tierExpiresAt = null;
}

function normalizeProviderId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = String(value);
  if (!PROVIDER_ID_PATTERN.test(id)) throw storeError(400, "供应商编号不正确");
  return id;
}

function normalizeManagedProvider(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storeError(400, "供应商分配记录不正确");
  const sourceProviderId = normalizeProviderId(value.sourceProviderId);
  const assignedProfileId = normalizeProviderId(value.assignedProfileId);
  const assignedBy = String(value.assignedBy || "");
  const assignedAt = Number(value.assignedAt);
  if (!sourceProviderId || !assignedProfileId || !USER_ID_PATTERN.test(assignedBy) || !Number.isFinite(assignedAt)) {
    throw storeError(400, "供应商分配记录不正确");
  }
  return { sourceProviderId, assignedProfileId, assignedBy, assignedAt };
}

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!USERNAME_PATTERN.test(username)) throw storeError(400, "用户名必须为 3-32 位字母、数字、点、横线或下划线");
  return username;
}

function normalizeDisplayName(value, fallback) {
  const displayName = String(value || fallback).trim();
  if (!displayName || displayName.length > 64) throw storeError(400, "显示名称必须为 1-64 个字符");
  return displayName;
}

function normalizeInviteRole(value, actorRole) {
  const role = String(value || "member");
  if (!['member', 'admin'].includes(role)) throw storeError(400, "邀请角色不正确");
  if (role === "admin" && actorRole !== "owner") throw storeError(403, "只有所有者可以分配管理员角色");
  return role;
}

function normalizeQuota(value) {
  const quota = Number(value);
  if (!Number.isSafeInteger(quota) || quota < MIN_QUOTA_BYTES || quota > MAX_QUOTA_BYTES) {
    throw storeError(400, "硬盘配额必须在 256 MB 到 1 TB 之间");
  }
  return quota;
}

export function normalizeCodexThreadLimit(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < MIN_CODEX_THREAD_LIMIT || numeric > MAX_CODEX_THREAD_LIMIT) {
    throw storeError(400, `Codex 并发线程上限必须为 ${MIN_CODEX_THREAD_LIMIT}-${MAX_CODEX_THREAD_LIMIT} 的整数`);
  }
  return numeric;
}

function normalizeOptionalTimestamp(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

export function normalizeMonthlyTokenLimit(value) {
  return normalizeTokenLimit(value, "每月");
}

export function normalizeFiveHourTokenLimit(value) {
  return normalizeTokenLimit(value, "5 小时");
}

export function normalizeWeeklyTokenLimit(value) {
  return normalizeTokenLimit(value, "每周");
}

function normalizeTokenLimit(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TOKEN_LIMIT) {
    throw storeError(400, `${label} Token 上限必须是 1 到 1 万亿之间的整数，留空表示不限`);
  }
  return limit;
}

function defaultPermissions(role) {
  const elevated = role === "owner" || role === "admin";
  return {
    customProviders: elevated,
    officialLogin: elevated,
    projectSharing: elevated,
    codexSkills: elevated,
    codexPlugins: elevated,
    codexApps: elevated,
    codexMcp: elevated,
    codexMigration: elevated,
    codexMemory: elevated,
    codexBackground: elevated,
    codexTerminal: elevated,
    codexWorkspaceMessages: elevated,
    codexRemoteDiff: elevated,
    codexFeedback: elevated,
    claudeRuntime: true,
    claudeOfficialLogin: elevated,
    claudeProviders: elevated,
    claudeExtensions: elevated,
    claudeMcp: elevated,
    claudeHooks: elevated,
    claudeMemory: elevated,
    claudeBackground: elevated,
    claudeWorktree: elevated,
    claudeProxy: elevated,
    claudeStructuredOutput: elevated,
    claudeUltraReview: elevated,
    claudeProjectPurge: elevated,
    claudeBetaHeaders: elevated,
  };
}

function normalizePermissions(value, role = "member") {
  const defaults = defaultPermissions(role);
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  return {
    customProviders: role === "owner" || role === "admin" ? true : value.customProviders === true,
    officialLogin: role === "owner" || role === "admin" ? true : value.officialLogin === true,
    projectSharing: role === "owner" ? true : value.projectSharing === true,
    codexSkills: role === "owner" || role === "admin" ? true : value.codexSkills === true,
    codexPlugins: role === "owner" || role === "admin" ? true : value.codexPlugins === true,
    codexApps: role === "owner" || role === "admin" ? true : value.codexApps === true,
    codexMcp: role === "owner" || role === "admin" ? true : value.codexMcp === true,
    codexMigration: role === "owner" || role === "admin" ? true : value.codexMigration === true,
    codexMemory: role === "owner" || role === "admin" ? true : value.codexMemory === true,
    codexBackground: role === "owner" || role === "admin" ? true : value.codexBackground === true,
    codexTerminal: role === "owner" || role === "admin" ? true : value.codexTerminal === true,
    codexWorkspaceMessages: role === "owner" || role === "admin"
      ? true
      : value.codexWorkspaceMessages === true,
    codexRemoteDiff: role === "owner" || role === "admin"
      ? true
      : value.codexRemoteDiff === true,
    codexFeedback: role === "owner" || role === "admin"
      ? true
      : value.codexFeedback === true,
    claudeRuntime: role === "owner" || role === "admin"
      ? true
      : value.claudeRuntime !== false,
    claudeOfficialLogin: role === "owner" || role === "admin"
      ? true
      : Object.hasOwn(value, "claudeOfficialLogin")
        ? value.claudeOfficialLogin === true
        : value.officialLogin === true,
    claudeProviders: role === "owner" || role === "admin"
      ? true
      : Object.hasOwn(value, "claudeProviders")
        ? value.claudeProviders === true
        : value.customProviders === true,
    claudeExtensions: role === "owner" || role === "admin"
      ? true
      : value.claudeExtensions === true,
    claudeMcp: role === "owner" || role === "admin"
      ? true
      : Object.hasOwn(value, "claudeMcp")
        ? value.claudeMcp === true
        : value.claudeExtensions === true,
    claudeHooks: role === "owner" || role === "admin"
      ? true
      : Object.hasOwn(value, "claudeHooks")
        ? value.claudeHooks === true
        : value.claudeExtensions === true,
    claudeMemory: role === "owner" || role === "admin"
      ? true
      : Object.hasOwn(value, "claudeMemory")
        ? value.claudeMemory === true
        : value.claudeExtensions === true,
    claudeBackground: role === "owner" || role === "admin"
      ? true
      : value.claudeBackground === true,
    claudeWorktree: role === "owner" || role === "admin"
      ? true
      : Object.hasOwn(value, "claudeWorktree")
        ? value.claudeWorktree === true
        : value.claudeRuntime !== false,
    claudeProxy: role === "owner" || role === "admin"
      ? true
      : value.claudeProxy === true,
    claudeStructuredOutput: role === "owner" || role === "admin"
      ? true
      : value.claudeStructuredOutput === true,
    claudeUltraReview: role === "owner" || role === "admin"
      ? true
      : value.claudeUltraReview === true,
    claudeProjectPurge: role === "owner" || role === "admin"
      ? true
      : value.claudeProjectPurge === true,
    claudeBetaHeaders: role === "owner" || role === "admin"
      ? true
      : value.claudeBetaHeaders === true,
  };
}

function normalizeLayout(layout, userId, usersRoot, userStateRoot) {
  const expectedHome = path.join(usersRoot, userId);
  const normalized = {
    systemUsername: String(layout?.systemUsername || ""),
    quotaMode: layout?.quotaMode === "filesystem" ? "filesystem" : "application",
    uid: Number(layout?.uid),
    gid: Number(layout?.gid),
    home: path.resolve(String(layout?.home || "")),
    codexHome: path.resolve(String(layout?.codexHome || "")),
    projectRoot: path.resolve(String(layout?.projectRoot || "")),
    defaultProject: path.resolve(String(layout?.defaultProject || "")),
    stateDirectory: path.resolve(String(layout?.stateDirectory || "")),
  };
  const relative = path.relative(expectedHome, normalized.home);
  if (relative || !Number.isInteger(normalized.uid) || normalized.uid < 0 || !Number.isInteger(normalized.gid) || normalized.gid < 0) {
    throw new Error("Provisioned user layout is invalid");
  }
  for (const directory of [normalized.codexHome, normalized.projectRoot]) {
    const child = path.relative(normalized.home, directory);
    if (!child || child.startsWith("..") || path.isAbsolute(child)) throw new Error("Provisioned user directory escaped its home");
  }
  if (normalized.stateDirectory !== path.join(userStateRoot, userId)) {
    throw new Error("Provisioned control state escaped its private root");
  }
  const defaultRelative = path.relative(normalized.projectRoot, normalized.defaultProject);
  if (!defaultRelative || defaultRelative.startsWith("..") || path.isAbsolute(defaultRelative)) {
    throw new Error("Provisioned default project escaped its project root");
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(normalized.systemUsername)) throw new Error("Invalid system username");
  return normalized;
}

function publicUser(user, defaultCodexThreadLimit = DEFAULT_CODEX_THREAD_LIMIT) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    legacy: user.legacy,
    quotaBytes: user.quotaBytes,
    quotaMode: user.quotaMode || (user.legacy ? "host-owner" : "application"),
    fiveHourTokenLimit: normalizeFiveHourTokenLimit(user.fiveHourTokenLimit),
    weeklyTokenLimit: normalizeWeeklyTokenLimit(user.weeklyTokenLimit),
    monthlyTokenLimit: normalizeMonthlyTokenLimit(user.monthlyTokenLimit),
    codexThreadLimit: user.codexThreadLimit ?? null,
    effectiveCodexThreadLimit: user.codexThreadLimit ?? normalizeCodexThreadLimit(defaultCodexThreadLimit),
    codexThreadLimitUpdatedAt: normalizeOptionalTimestamp(user.codexThreadLimitUpdatedAt),
    codexThreadLimitUpdatedBy: user.codexThreadLimitUpdatedBy || null,
    permissions: normalizePermissions(user.permissions, user.role),
    tierId: user.tierId || null,
    tierName: user.tierName || null,
    tierExpiresAt: normalizeStoredTierExpiration(user.tierExpiresAt),
    assignedProviderId: user.managedProvider?.sourceProviderId || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicSessionIdentity(session, source) {
  return {
    id: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt,
    source: source === "fallback" ? "fallback" : "primary",
  };
}

function publicProjectShare(share) {
  return {
    id: share.id,
    sourceUserId: share.sourceUserId,
    targetUserId: share.targetUserId,
    projectPath: share.projectPath,
    access: share.access,
    createdAt: share.createdAt,
  };
}

function publicInvite(invite) {
  return {
    id: invite.id,
    role: invite.role,
    tierId: invite.tierId || null,
    tierName: invite.tierName || null,
    quotaBytes: invite.quotaBytes,
    fiveHourTokenLimit: normalizeFiveHourTokenLimit(invite.fiveHourTokenLimit),
    weeklyTokenLimit: normalizeWeeklyTokenLimit(invite.weeklyTokenLimit),
    monthlyTokenLimit: normalizeMonthlyTokenLimit(invite.monthlyTokenLimit),
    permissions: normalizePermissions(invite.permissions, invite.role),
    providerConfigured: Boolean(invite.providerId),
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    usedBy: invite.usedBy || null,
  };
}

function publicTier(tier) {
  return {
    id: tier.id,
    name: tier.name,
    quotaBytes: tier.quotaBytes,
    fiveHourTokenLimit: tier.fiveHourTokenLimit,
    weeklyTokenLimit: tier.weeklyTokenLimit,
    monthlyTokenLimit: tier.monthlyTokenLimit,
    permissions: { ...tier.permissions },
    providerId: tier.providerId,
  };
}

function createUserId() {
  return `u-${crypto.randomBytes(8).toString("hex")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw new Error(`Unable to read ${path.basename(filePath)}: ${error.message}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function storeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
