import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { ClaudeBackgroundAgents } from "./claude-background.mjs";
import { ClaudeExtensionStore } from "./claude-extensions.mjs";
import { OfficialProxyRouter } from "./official-proxy.mjs";
import {
  materializeClaudePluginUrls,
  normalizeClaudePluginDirectories,
  normalizeClaudePluginUrls,
  resolveClaudePluginDirectories,
} from "./claude-session-plugins.mjs";
import {
  claudeReviewedStreamEvent,
  claudeReviewedSystemEvent,
  claudeReviewedTopLevelEvent,
} from "./claude-protocol-coverage.mjs";

const SESSION_VERSION = 8;
const MAX_SESSIONS = 200;
const MAX_DELETED_NATIVE_SESSIONS = 400;
const MAX_TRANSCRIPT_ITEMS = 500;
const MAX_ITEM_TEXT = 100_000;
const MAX_CONTROL_TEXT = 8_000;
const MAX_CONTROL_INPUT = 64_000;
const MAX_ELICITATION_PROPERTIES = 12;
const MAX_ELICITATION_ENUM_VALUES = 24;
const MAX_ELICITATION_STRING_LENGTH = 4_000;
const MAX_ATTACHMENTS = 8;
const MAX_NATIVE_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_TRANSCRIPTS_SCANNED = 400;
const MAX_MEMORY_LENGTH = 32_000;
const MAX_HOOKS = 64;
const MAX_HOOK_COMMAND_LENGTH = 8_000;
const MAX_HOOK_MATCHER_LENGTH = 256;
const MAX_HOOK_TIMEOUT_SECONDS = 60;
const MAX_CLAUDE_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_ENTRIES = 64;
const CLAUDE_MCP_SCOPES = new Set(["user", "project", "local"]);
const MAX_ADDITIONAL_DIRECTORIES = 8;
const MAX_PLUGIN_IDENTIFIER = 160;
const MAX_CLAUDE_TOOL_RULES = 64;
const MAX_CLAUDE_TOOL_RULE_LENGTH = 256;
const MAX_CLAUDE_AGENT_NAME_LENGTH = 128;
const MAX_CLAUDE_FALLBACK_MODEL_LENGTH = 512;
const MAX_CLAUDE_BUDGET_USD = 10_000;
const MIN_CLAUDE_AUTOCOMPACT_TOKENS = 100_000;
const MAX_CLAUDE_AUTOCOMPACT_TOKENS = 1_000_000;
const MAX_CLAUDE_SYSTEM_PROMPT_LENGTH = 32_000;
const MAX_CLAUDE_JSON_SCHEMA_LENGTH = 64_000;
const MAX_CLAUDE_JSON_SCHEMA_NODES = 2_000;
const MAX_CLAUDE_JSON_SCHEMA_DEPTH = 24;
const MAX_CLAUDE_INLINE_AGENTS = 16;
const MAX_CLAUDE_REMOTE_FILES = 16;
const MAX_CLAUDE_REMOTE_FILE_PATH_LENGTH = 512;
const MAX_CLAUDE_BETA_HEADERS = 16;
const MAX_CLAUDE_AUTO_MODE_OUTPUT = 256 * 1024;
const MAX_CLAUDE_AUTO_MODE_RULE_LENGTH = 16_000;
const CLAUDE_AUTO_MODE_GROUPS = Object.freeze(["allow", "soft_deny", "hard_deny", "environment"]);
const MAX_CLAUDE_PROJECT_BACKUP_FILES = 10_000;
const MAX_CLAUDE_PROJECT_BACKUP_BYTES = 512 * 1024 * 1024;
const CLAUDE_PROJECT_PURGE_PREVIEW_TTL_MS = 10 * 60_000;
const MAX_CLAUDE_ULTRA_REVIEWS = 20;
const MAX_CLAUDE_ULTRA_REVIEW_OUTPUT = 256 * 1024;
const CLAUDE_PLUGIN_TAG_PREVIEW_TTL_MS = 10 * 60_000;
const CLAUDE_PLUGIN_INIT_COMPONENTS = new Set([
  "skills",
  "agents",
  "hooks",
  "mcp",
  "lsp",
  "output-style",
  "channel",
]);
const CLAUDE_SETTING_SOURCES = new Set(["user", "project", "local"]);
const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REWIND_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_OFFICIAL_LOGIN_TTL_MS = 15 * 60_000;
const OFFICIAL_LOGIN_URL_TIMEOUT_MS = 20_000;
const DEFAULT_OFFICIAL_PROXY_HEALTH_INTERVAL_MS = 10 * 60_000;
const DEFAULT_OFFICIAL_PROXY_HEALTH_INITIAL_DELAY_MS = 30_000;
const CLAUDE_OFFICIAL_PROXY_DOMAIN_ROOTS = Object.freeze([
  "anthropic.com",
  "claude.ai",
  "claude.com",
]);
const CLAUDE_ACCOUNT_ID_PATTERN = /^ca-[a-f0-9]{16}$/;
const DEFAULT_MODEL = "sonnet";
const DEFAULT_PERMISSION_MODE = "acceptEdits";
const CLAUDE_RECOVERY_CONFIRMATION = "继续未完成任务";
const CLAUDE_CONTINUE_PROMPT = [
  "继续当前任务，但不要重复已经完成的工具调用。",
  "先检查当前工程和对话状态；如果无法确认安全的继续位置，请停止并询问用户。",
].join("");
const CLAUDE_RETRY_PROMPT = [
  "连接暂时恢复，请在当前任务上下文中继续未完成的工作。",
  "不要重复已经完成的工具调用或其他有副作用的操作。",
  "如果无法确认安全的继续位置，请停止并询问用户。",
].join("");
const CLAUDE_TASK_SETTINGS_VERSION = 1;
const CLAUDE_RETRY_FREQUENCIES = Object.freeze(["fast", "balanced", "patient"]);
const CLAUDE_RETRY_DELAYS_MS = Object.freeze({
  fast: Object.freeze([10_000, 20_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000]),
  balanced: Object.freeze([15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000]),
  patient: Object.freeze([60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000]),
});
const DEFAULT_CLAUDE_TASK_SETTINGS = Object.freeze({
  unlimitedRetry: false,
  retryFrequency: "balanced",
  maxRetries: 5,
});
const CLAUDE_RECOVERY_PROMPT = [
  "继续上一个因运行时断开而中断的任务。",
  "请先检查当前对话和工程状态，不要重复已经完成的工具调用或其他有副作用的操作。",
  "如果无法确认安全的继续位置，请立即停止并向用户询问。",
].join("");
const SUPPORTED_DIALOG_KINDS = ["refusal_fallback_prompt"];
const PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PermissionRequest",
  "TaskCompleted",
]);

export class ClaudeRuntime extends EventEmitter {
  constructor({
    user,
    store,
    appVersion,
    command = "claude",
    controlRequestTimeoutMs = DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
    officialAccounts = null,
    allowPrivateOfficialProxy = false,
    officialProxyHealthCheck = null,
    pluginUrlDownloader = null,
    officialProxyHealthIntervalMs = DEFAULT_OFFICIAL_PROXY_HEALTH_INTERVAL_MS,
    officialProxyHealthInitialDelayMs = DEFAULT_OFFICIAL_PROXY_HEALTH_INITIAL_DELAY_MS,
  }) {
    super();
    this.runtimeEpoch = crypto.randomUUID();
    this.eventSequence = 0;
    this.user = user;
    this.store = store;
    this.appVersion = appVersion;
    this.command = command;
    this.officialAccounts = officialAccounts;
    this.allowPrivateOfficialProxy = allowPrivateOfficialProxy === true;
    this.officialProxyRouters = new Map();
    this.officialProxyHealthCheck = typeof officialProxyHealthCheck === "function"
      ? officialProxyHealthCheck
      : null;
    this.pluginUrlDownloader = typeof pluginUrlDownloader === "function" ? pluginUrlDownloader : null;
    this.officialProxyHealthIntervalMs = Math.max(
      60_000,
      Number(officialProxyHealthIntervalMs) || DEFAULT_OFFICIAL_PROXY_HEALTH_INTERVAL_MS,
    );
    this.officialProxyHealthInitialDelayMs = Math.max(
      1_000,
      Number(officialProxyHealthInitialDelayMs) || DEFAULT_OFFICIAL_PROXY_HEALTH_INITIAL_DELAY_MS,
    );
    this.officialProxyHealthTimer = null;
    this.officialProxyHealthRunning = false;
    this.destroyed = false;
    this.directory = path.join(user.stateDirectory, "claude");
    this.configDirectory = path.join(user.home || process.env.HOME || "/tmp", ".wfl-claude");
    this.claudeConfigPath = path.join(this.configDirectory, ".claude.json");
    this.memoryDirectory = path.join(this.directory, "memory");
    this.hooksDirectory = path.join(this.directory, "hooks");
    this.sessionPluginsDirectory = path.join(this.directory, "session-plugins");
    this.projectPurgeBackupDirectory = path.join(this.directory, "project-purge-backups");
    this.ultraReviewsPath = path.join(this.directory, "ultra-reviews.json");
    this.extensionStore = new ClaudeExtensionStore({
      configDirectory: this.configDirectory,
      uid: this.user.legacy === false ? this.user.uid : null,
      gid: this.user.legacy === false ? this.user.gid : null,
    });
    this.backgroundAgents = new ClaudeBackgroundAgents({
      user: this.user,
      command: this.command,
      configDirectory: this.configDirectory,
      dataDirectory: this.directory,
      spawnOptions: ({ cwd, stdio }) => this.spawnOptions({ cwd, stdio }),
    });
    this.backgroundAgents.on("event", (payload) => this.emit("event", payload));
    this.backgroundAgents.on("log", (payload) => this.emit("log", payload));
    this.sessionsPath = path.join(this.directory, "sessions.json");
    this.taskSettingsPath = path.join(this.directory, "task-settings.json");
    this.sessions = new Map();
    this.deletedNativeSessionIds = new Set();
    this.children = new Map();
    this.childStarts = new Map();
    this.retryTimers = new Map();
    this.runtimeAllowed = this.user.permissions?.claudeRuntime !== false;
    this.taskSettings = { ...DEFAULT_CLAUDE_TASK_SETTINGS };
    this.pendingControlRequests = new Map();
    this.controlRequestTimeoutMs = Math.max(1_000, Number(controlRequestTimeoutMs) || DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
    this.loginChild = null;
    this.loginState = null;
    this.loginTimer = null;
    this.persistQueue = Promise.resolve();
    this.mcpConfigQueue = Promise.resolve();
    this.extensionConfigQueue = Promise.resolve();
    this.projectPurgePreviews = new Map();
    this.pluginTagPreviews = new Map();
    this.ultraReviews = new Map();
    this.ultraReviewChildren = new Map();
    this.ultraReviewPersistQueue = Promise.resolve();
    this.ultraReviewPersistTimer = null;
    this.initialized = false;
  }

  emit(eventName, ...args) {
    if (eventName === "event" && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      const payload = args[0];
      const session = typeof payload.sessionId === "string"
        ? this.sessions?.get(payload.sessionId)
        : null;
      args[0] = {
        ...payload,
        ...(session && !payload.session
          ? { session: publicSession(session, false, this.children?.get(session.id)) }
          : {}),
        runtimeEpoch: this.runtimeEpoch,
        eventSequence: ++this.eventSequence,
        observedAt: Date.now(),
      };
    } else if (eventName === "status" && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      args[0] = {
        ...args[0],
        runtimeEpoch: this.runtimeEpoch,
        eventSequence: this.eventSequence,
        observedAt: Date.now(),
      };
    }
    return super.emit(eventName, ...args);
  }

  async initialize() {
    if (this.initialized) return this;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.memoryDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.hooksDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.sessionPluginsDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.projectPurgeBackupDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    await fs.chmod(this.memoryDirectory, 0o700);
    await fs.chmod(this.hooksDirectory, 0o700);
    await fs.chmod(this.sessionPluginsDirectory, 0o700);
    await fs.chmod(this.projectPurgeBackupDirectory, 0o700);
    await fs.chmod(this.configDirectory, 0o700);
    await this.loadTaskSettings();
    await this.loadUltraReviews();
    if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
      await repairOwnership(this.configDirectory, this.user.uid, this.user.gid);
      await fs.chown(this.directory, this.user.uid, this.user.gid);
      await fs.chown(this.memoryDirectory, this.user.uid, this.user.gid);
      await fs.chown(this.hooksDirectory, this.user.uid, this.user.gid);
      await fs.chown(this.sessionPluginsDirectory, this.user.uid, this.user.gid);
      await fs.chown(this.projectPurgeBackupDirectory, this.user.uid, this.user.gid);
    }
    await this.initializeOfficialAccounts();
    await this.backgroundAgents.initialize();
    let recoveredPendingState = false;
    try {
      const data = JSON.parse(await fs.readFile(this.sessionsPath, "utf8"));
      if (
        Number.isInteger(data.version)
        && data.version >= 1
        && data.version <= SESSION_VERSION
        && Array.isArray(data.sessions)
      ) {
        for (const entry of data.sessions.slice(0, MAX_SESSIONS)) {
          const session = normalizeSession(entry);
          if (session) {
            if (!Object.hasOwn(entry, "providerId")) {
              const activeProvider = this.store?.getActiveProfile?.() || null;
              session.providerId = normalizeProviderId(activeProvider?.id);
              session.providerName = activeProvider?.name || null;
              recoveredPendingState = true;
            }
            if (
              !session.providerId
              && !session.officialAccountId
              && this.officialAccounts?.activeId()
            ) {
              session.officialAccountId = this.officialAccounts.activeId();
              session.officialAccountName = officialAccountDisplayName(
                this.officialAccounts.get(session.officialAccountId),
              );
              recoveredPendingState = true;
            }
            recoveredPendingState = recoverPersistedClaudeState(session) || recoveredPendingState;
            this.sessions.set(session.id, session);
          }
        }
        if (Array.isArray(data.deletedNativeSessionIds)) {
          for (const nativeSessionId of data.deletedNativeSessionIds) {
            if (isUuid(nativeSessionId)) this.deletedNativeSessionIds.add(nativeSessionId);
            if (this.deletedNativeSessionIds.size >= MAX_DELETED_NATIVE_SESSIONS) break;
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.emit("log", { level: "error", message: claudeLogFailure("会话存储", error) });
    }
    if (recoveredPendingState) await this.writeSessions();
    this.initialized = true;
    this.scheduleOfficialProxyHealth(this.officialProxyHealthInitialDelayMs);
    for (const session of this.sessions.values()) {
      if (this.runtimeAllowed && session.pendingTurn?.status === "retryWaiting") {
        this.scheduleRetry(session, session.pendingTurn);
      }
    }
    if ([...this.ultraReviews.values()].some((review) => review.status === "running")) {
      for (const review of this.ultraReviews.values()) {
        if (review.status !== "running") continue;
        review.status = "interrupted";
        review.error = "服务器重启时 Ultra Review 进程已中断，请重新运行";
        review.finishedAt = Date.now();
        review.updatedAt = review.finishedAt;
      }
      await this.persistUltraReviews();
    }
    this.emit("status", this.status());
    return this;
  }

  async initializeOfficialAccounts() {
    if (!this.officialAccounts) return;
    for (const account of this.officialAccounts.snapshot().accounts) {
      await this.configureOfficialAccountProxy(account.id);
    }
    const hasLegacy = this.officialAccounts.snapshot().accounts.some((account) => account.legacy);
    if (!hasLegacy) {
      const status = await this.runOfficialAuthStatus({
        configDirectory: this.configDirectory,
      }).catch(() => ({ loggedIn: false }));
      if (status.loggedIn) {
        const account = await this.officialAccounts.ensureLegacy(status);
        if (account) await this.configureOfficialAccountProxy(account.id);
      }
    }
  }

  async configureOfficialAccountProxy(accountId) {
    if (!this.officialAccounts?.has(accountId)) return null;
    let router = this.officialProxyRouters.get(accountId);
    if (!router) {
      router = new OfficialProxyRouter({
        allowPrivateProxy: this.allowPrivateOfficialProxy,
        officialDomainRoots: CLAUDE_OFFICIAL_PROXY_DOMAIN_ROOTS,
      });
      this.officialProxyRouters.set(accountId, router);
    }
    await router.configure(this.officialAccounts.privateProxy(accountId));
    return router.snapshot();
  }

  officialAccountsSnapshot() {
    return this.officialAccounts?.snapshot() || { activeId: null, accounts: [] };
  }

  status() {
    return {
      runtimeEpoch: this.runtimeEpoch,
      eventSequence: this.eventSequence,
      observedAt: Date.now(),
      status: [...this.children.values()].some((child) => child?.connected) ? "ready" : "idle",
      sessions: this.sessions.size,
      officialLoginRunning: Boolean(this.loginChild),
      officialLogin: publicLoginState(this.loginState, Boolean(this.loginChild)),
      officialAccounts: this.officialAccounts?.snapshot() || { activeId: null, accounts: [] },
      activeProviderId: this.store?.snapshot().activeId || null,
      pendingControlRequests: this.pendingControlRequests.size,
      runningTurns: [...this.children.values()].filter((child) => child?.turnActive).length,
      recoveryPending: [...this.sessions.values()].filter((session) =>
        session.pendingTurn?.status === "recoveryPending").length,
      pausedTurns: [...this.sessions.values()].filter((session) =>
        session.pendingTurn?.status === "paused").length,
      retryWaiting: [...this.sessions.values()].filter((session) =>
        session.pendingTurn?.status === "retryWaiting").length,
      taskSettings: publicClaudeTaskSettings(this.taskSettings),
      backgroundAgents: this.backgroundAgents?.count() || 0,
    };
  }

  snapshot() {
    return {
      ...this.status(),
      provider: this.store?.snapshot() || { activeId: null, profiles: [] },
      taskSettings: publicClaudeTaskSettings(this.taskSettings),
    };
  }

  sessionSnapshot({ cwd = null, archived = false } = {}) {
    return {
      runtimeEpoch: this.runtimeEpoch,
      eventSequence: this.eventSequence,
      observedAt: Date.now(),
      data: this.listSessions({ cwd, archived }),
      nextCursor: null,
    };
  }

  readSessionSnapshot(id) {
    return {
      runtimeEpoch: this.runtimeEpoch,
      eventSequence: this.eventSequence,
      observedAt: Date.now(),
      session: this.readSession(id),
    };
  }

  taskSettingsSnapshot() {
    return publicClaudeTaskSettings(this.taskSettings);
  }

  async updateTaskSettings(input = {}) {
    const next = normalizeClaudeTaskSettings({ ...this.taskSettings, ...input });
    this.taskSettings = next;
    await this.writeTaskSettings();
    this.emit("status", this.status());
    return publicClaudeTaskSettings(next);
  }

  async listMcpServers(cwd = null) {
    const project = cwd ? await this.normalizeHooksCwd(cwd) : null;
    const scopes = await this.readMcpScopes(project);
    return ["local", "project", "user"]
      .flatMap((scope) => Object.entries(scopes[scope] || {})
        .slice(0, MAX_MCP_SERVERS)
        .map(([name, server]) => publicMcpServer(name, server, scope))
        .filter(Boolean))
      .slice(0, MAX_MCP_SERVERS)
      .sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope));
  }

  async saveMcpServer(input, { existingName = null } = {}) {
    return this.queueMcpConfiguration(async () => {
      this.assertMcpConfigurationIdle();
      const scope = normalizeClaudeMcpScope(input?.scope);
      const project = scope === "user" ? null : await this.normalizeHooksCwd(input?.cwd);
      const scopes = await this.readMcpScopes(project);
      const servers = { ...(scopes[scope] || {}) };
      const normalizedExistingName = existingName === null ? null : normalizeMcpName(existingName);
      const previous = normalizedExistingName ? servers[normalizedExistingName] : null;
      if (normalizedExistingName && !plainObject(previous)) throw runtimeError(404, "Claude MCP 服务器不存在");
      const normalized = normalizeMcpServerInput(input, previous);
      if (!normalizedExistingName && Object.hasOwn(servers, normalized.name)) {
        throw runtimeError(409, "Claude MCP 服务器名称已存在");
      }
      if (normalizedExistingName && normalized.name !== normalizedExistingName) {
        throw runtimeError(400, "Claude MCP 服务器名称不能直接修改");
      }
      if (!normalizedExistingName && Object.keys(servers).length >= MAX_MCP_SERVERS) {
        throw runtimeError(400, "Claude MCP 服务器数量已达上限");
      }
      servers[normalized.name] = normalized.server;
      await this.writeMcpScope(scope, project, servers);
      await this.reloadIdleChildrenForConfigurationChange();
      return publicMcpServer(normalized.name, normalized.server, scope);
    });
  }

  async removeMcpServer(name, { scope = "user", cwd = null } = {}) {
    return this.queueMcpConfiguration(async () => {
      this.assertMcpConfigurationIdle();
      const normalizedName = normalizeMcpName(name);
      const normalizedScope = normalizeClaudeMcpScope(scope);
      const project = normalizedScope === "user" ? null : await this.normalizeHooksCwd(cwd);
      const scopes = await this.readMcpScopes(project);
      const servers = { ...(scopes[normalizedScope] || {}) };
      if (!Object.hasOwn(servers, normalizedName)) throw runtimeError(404, "Claude MCP 服务器不存在");
      delete servers[normalizedName];
      await this.writeMcpScope(normalizedScope, project, servers);
      await this.reloadIdleChildrenForConfigurationChange();
      return { deleted: true, name: normalizedName, scope: normalizedScope };
    });
  }

  async checkMcpServer(name, cwd = null) {
    const normalizedName = normalizeMcpName(name);
    this.assertMcpConfigurationIdle();
    const project = cwd ? await this.normalizeHooksCwd(cwd) : this.user.projectRoot;
    const servers = await this.listMcpServers(project);
    if (!servers.some((server) => server.name === normalizedName)) throw runtimeError(404, "Claude MCP 服务器不存在");
    const result = await runCommand(
      this.command,
      ["mcp", "get", normalizedName],
      this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
      30_000,
      64 * 1024,
    );
    const output = stripTerminalControl(`${result.stdout}\n${result.stderr}`);
    const failed = result.code !== 0 || /(?:\u2717|\u2718|\bfailed\b|\berror\b|not connected|timed? out|\u547d\u4ee4\u8d85\u65f6)/i.test(output);
    const authRequired = /(?:\b401\b|\b403\b|unauthori[sz]ed|oauth|authenticate|登录|授权)/i.test(output);
    const approval = /\bpending approval\b|等待批准|待批准/i.test(output)
      ? "pending"
      : /\brejected\b|已拒绝/i.test(output)
        ? "rejected"
        : /\bapproved\b|已批准/i.test(output)
          ? "approved"
          : "notApplicable";
    const status = authRequired
      ? "authRequired"
      : approval === "pending" ? "pendingApproval"
        : approval === "rejected" ? "rejected"
      : failed
        ? "failed"
        : result.code === 0 && /(?:\u2713|\u2714|\bconnected\b)/i.test(output) ? "connected" : "unknown";
    const capabilities = parseClaudeMcpCapabilities(output);
    return {
      name: normalizedName,
      status,
      approval,
      authRequired,
      tools: capabilities.tools,
      resources: capabilities.resources,
      error: failed ? claudeMcpFailureSummary(output) : null,
      checkedAt: Date.now(),
    };
  }

  async logoutMcpServer(name, cwd = null) {
    return this.queueMcpConfiguration(async () => {
      this.assertMcpConfigurationIdle();
      const normalizedName = normalizeMcpName(name);
      const project = cwd ? await this.normalizeHooksCwd(cwd) : this.user.projectRoot;
      const result = await runCommand(
        this.command,
        ["mcp", "logout", normalizedName],
        this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
        30_000,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, "Claude MCP OAuth 退出失败"));
      }
      return { ok: true, name: normalizedName, loggedOut: true };
    });
  }

  async readMcpScopes(project = null) {
    const configuration = await this.readClaudeConfiguration();
    const user = plainObject(configuration.mcpServers) ? { ...configuration.mcpServers } : {};
    if (!project) return { user, project: {}, local: {} };
    const localEntry = plainObject(configuration.projects?.[project])
      ? configuration.projects[project]
      : {};
    const local = plainObject(localEntry.mcpServers) ? { ...localEntry.mcpServers } : {};
    const projectConfiguration = await readClaudeMcpProjectConfiguration(project);
    const projectServers = plainObject(projectConfiguration.mcpServers)
      ? { ...projectConfiguration.mcpServers }
      : {};
    return { user, project: projectServers, local };
  }

  async writeMcpScope(scope, project, servers) {
    if (scope === "project") {
      await writeClaudeMcpProjectConfiguration(project, servers, {
        uid: this.user.legacy === false ? this.user.uid : null,
        gid: this.user.legacy === false ? this.user.gid : null,
      });
      return;
    }
    const configuration = await this.readClaudeConfiguration();
    if (scope === "user") {
      await this.writeClaudeConfiguration({ ...configuration, mcpServers: servers });
      return;
    }
    const projects = plainObject(configuration.projects) ? { ...configuration.projects } : {};
    const current = plainObject(projects[project]) ? { ...projects[project] } : {};
    projects[project] = { ...current, mcpServers: servers };
    await this.writeClaudeConfiguration({ ...configuration, projects });
  }

  async mergedMcpServers(project) {
    const scopes = await this.readMcpScopes(project);
    return { ...scopes.user, ...scopes.project, ...scopes.local };
  }

  async resetMcpProjectChoices(cwd, confirmation) {
    if (confirmation !== "重置 MCP 项目选择") throw runtimeError(400, "MCP 项目选择重置确认不匹配");
    return this.queueMcpConfiguration(async () => {
      this.assertMcpConfigurationIdle();
      const project = await this.normalizeHooksCwd(cwd);
      const result = await runCommand(
        this.command,
        ["mcp", "reset-project-choices"],
        this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
        30_000,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, "Claude MCP 项目批准状态重置失败"));
      }
      await this.reloadIdleChildrenForConfigurationChange("Claude MCP 项目批准状态已重置");
      return { ok: true, cwd: project, reset: true };
    });
  }

  async extensionSnapshot() {
    const [skills, agents, plugins, pluginMarket] = await Promise.all([
      this.extensionStore.listSkills(),
      this.extensionStore.listAgents(),
      this.listPlugins(),
      this.pluginMarketplaceSnapshot(),
    ]);
    return { skills, agents, plugins, pluginMarket };
  }

  async commandSnapshot({ includeSkills = true } = {}) {
    const commands = [
      {
        kind: "builtin",
        name: "doctor",
        action: "doctor",
        description: "检查 Claude CLI 兼容性与连接状态",
      },
      {
        kind: "builtin",
        name: "permissions",
        action: "permissions",
        description: "查看当前会话的 Claude 权限模式",
      },
      {
        kind: "builtin",
        name: "context",
        action: "context",
        description: "查看当前 Claude 会话的上下文与用量",
      },
    ];
    if (!includeSkills) return { commands };
    const skills = await this.extensionStore.listSkills();
    return {
      commands: commands.concat(skills
        .filter((skill) => skill.userInvocable !== false)
        .map((skill) => ({
          kind: "skill",
          name: skill.name,
          description: skill.description,
        }))),
    };
  }

  async saveSkill(input, { existingName = null } = {}) {
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const skill = await this.extensionStore.saveSkill(input, { existingName });
      await this.reloadIdleChildrenForConfigurationChange("Claude Skill 已更改");
      return skill;
    });
  }

  async removeSkill(name) {
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const result = await this.extensionStore.removeSkill(name);
      await this.reloadIdleChildrenForConfigurationChange("Claude Skill 已删除");
      return result;
    });
  }

  async saveAgent(input, { existingName = null } = {}) {
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const agent = await this.extensionStore.saveAgent(input, { existingName });
      await this.reloadIdleChildrenForConfigurationChange("Claude Agent 已更改");
      return agent;
    });
  }

  async removeAgent(name) {
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const result = await this.extensionStore.removeAgent(name);
      await this.reloadIdleChildrenForConfigurationChange("Claude Agent 已删除");
      return result;
    });
  }

  async listPlugins() {
    const result = await runCommand(
      this.command,
      ["plugin", "list", "--json"],
      this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
      20_000,
    );
    if (result.code !== 0) throw runtimeError(502, cleanCommandError(result, "Claude 插件列表读取失败"));
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw runtimeError(502, "Claude 插件列表格式无效");
    }
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    return entries.slice(0, 100).map(publicPlugin).filter(Boolean)
      .sort((left, right) => left.identifier.localeCompare(right.identifier));
  }

  async pluginMarketplaceSnapshot() {
    const [marketplaces, available, installed] = await Promise.all([
      this.listPluginMarketplaces(),
      this.listAvailablePlugins(),
      this.listPlugins(),
    ]);
    const installedIds = new Set(installed.map((plugin) => plugin.identifier));
    return {
      marketplaces,
      available: available.map((plugin) => ({
        ...plugin,
        installed: installedIds.has(plugin.identifier),
        installedVersion: installed.find((entry) => entry.identifier === plugin.identifier)?.version || null,
      })),
      installed,
      queriedAt: Date.now(),
    };
  }

  async listPluginMarketplaces() {
    const result = await runCommand(
      this.command,
      ["plugin", "marketplace", "list", "--json"],
      this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
      20_000,
    );
    if (result.code !== 0) throw runtimeError(502, cleanCommandError(result, "Claude 插件市场列表读取失败"));
    return parsePluginJsonArray(result.stdout)
      .map(publicPluginMarketplace)
      .filter(Boolean)
      .slice(0, 100)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listAvailablePlugins() {
    const result = await runCommand(
      this.command,
      ["plugin", "list", "--available", "--json"],
      this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
      30_000,
    );
    if (result.code !== 0) throw runtimeError(502, cleanCommandError(result, "Claude 插件目录读取失败"));
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw runtimeError(502, "Claude 插件目录格式无效");
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.available)
        ? parsed.available
        : [];
    return entries
      .map(publicAvailablePlugin)
      .filter(Boolean)
      .slice(0, 200)
      .sort((left, right) => left.identifier.localeCompare(right.identifier));
  }

  async addPluginMarketplace(source) {
    return this.mutatePluginMarketplace("add", normalizeMarketplaceSource(source));
  }

  async updatePluginMarketplace(name = null) {
    const normalized = name === null || name === undefined ? null : normalizeMarketplaceName(name);
    return this.mutatePluginMarketplace("update", normalized);
  }

  async removePluginMarketplace(name) {
    return this.mutatePluginMarketplace("remove", normalizeMarketplaceName(name));
  }

  async mutatePluginMarketplace(action, value) {
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const args = ["plugin", "marketplace", action];
      if (value) args.push(value);
      const result = await runCommand(
        this.command,
        args,
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        90_000,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, `Claude 插件市场${pluginMarketplaceActionLabel(action)}失败`));
      }
      await this.reloadIdleChildrenForConfigurationChange("Claude 插件市场已更改");
      return { ok: true, action, value: value || null };
    });
  }

  async installPlugin(identifier) {
    return this.mutatePlugin("install", identifier);
  }

  async pluginDetails(identifier) {
    const normalized = normalizePluginIdentifier(identifier);
    const result = await runCommand(
      this.command,
      ["plugin", "details", normalized],
      this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
      30_000,
    );
    if (result.code !== 0) {
      throw runtimeError(502, cleanCommandError(result, "Claude 插件详情读取失败"));
    }
    return {
      identifier: normalized,
      details: safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000),
      checkedAt: Date.now(),
    };
  }

  async updatePlugin(identifier) {
    return this.mutatePlugin("update", identifier);
  }

  async setPluginEnabled(identifier, enabled) {
    return this.mutatePlugin(enabled ? "enable" : "disable", identifier);
  }

  async removePlugin(identifier) {
    return this.mutatePlugin("uninstall", identifier);
  }

  async validatePlugin(cwd, requestedPath, { strict = true } = {}) {
    const project = await this.normalizeHooksCwd(cwd);
    const candidate = typeof requestedPath === "string" && requestedPath.trim()
      ? path.resolve(project, requestedPath.trim())
      : null;
    if (!candidate || !pathWithin(project, candidate)) throw runtimeError(400, "Claude 插件校验路径必须位于当前工程内");
    let target;
    let stat;
    try {
      [target, stat] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
    } catch {
      throw runtimeError(400, "Claude 插件校验路径不存在或不可访问");
    }
    if (
      stat.isSymbolicLink()
      || !pathWithin(project, target)
      || (!stat.isDirectory() && !stat.isFile())
    ) throw runtimeError(400, "Claude 插件校验路径不安全");
    const args = ["plugin", "validate"];
    if (strict === true) args.push("--strict");
    args.push(target);
    const result = await runCommand(
      this.command,
      args,
      this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
      60_000,
    );
    return {
      path: path.relative(project, target) || ".",
      valid: result.code === 0,
      strict: strict === true,
      diagnostics: safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000),
      checkedAt: Date.now(),
    };
  }

  async prunePlugins({ dryRun = true, confirmation = null } = {}) {
    if (dryRun !== true && confirmation !== "清理未使用插件") {
      throw runtimeError(400, "Claude 插件清理确认不匹配");
    }
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const args = ["plugin", "prune", "--scope", "user"];
      if (dryRun === true) args.push("--dry-run");
      else args.push("--yes");
      const result = await runCommand(
        this.command,
        args,
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        60_000,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, "Claude 未使用插件清理失败"));
      }
      if (dryRun !== true) await this.reloadIdleChildrenForConfigurationChange("Claude 未使用插件已清理");
      return {
        ok: true,
        dryRun: dryRun === true,
        diagnostics: safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000),
      };
    });
  }

  async initializePlugin({
    name,
    description = null,
    components = [],
  } = {}) {
    const normalizedName = normalizeClaudePluginScaffoldName(name);
    const normalizedDescription = normalizeClaudePluginScaffoldDescription(description);
    const normalizedComponents = normalizeClaudePluginInitComponents(components);
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const args = ["plugin", "init", normalizedName];
      if (normalizedDescription) args.push("--description", normalizedDescription);
      if (normalizedComponents.length) args.push("--with", ...normalizedComponents);
      const result = await runCommand(
        this.command,
        args,
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        60_000,
        64 * 1024,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, "Claude 插件脚手架创建失败"));
      }
      await this.reloadIdleChildrenForConfigurationChange("Claude 插件脚手架已创建");
      return {
        ok: true,
        name: normalizedName,
        components: normalizedComponents,
        diagnostics: safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000),
      };
    });
  }

  async evaluatePlugin(cwd, input = {}) {
    const project = await this.normalizeHooksCwd(cwd);
    const target = await normalizeClaudePluginEvalTarget(project, input.target);
    const options = normalizeClaudePluginEvalOptions(input);
    const args = [
      "plugin",
      "eval",
      target,
      "--json",
      "--no-scaffold",
      "--max-cost-usd",
      String(options.maxCostUsd),
      "--runs",
      String(options.runs),
      "--threshold",
      String(options.threshold),
    ];
    if (options.model) args.push("--model", options.model);
    if (options.judgeModel) args.push("--judge-model", options.judgeModel);
    if (options.caseGlob) args.push("--case", options.caseGlob);
    for (const tag of options.tags) args.push("--tag", tag);
    const result = await runCommand(
      this.command,
      args,
      this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
      30 * 60_000,
      MAX_CLAUDE_ULTRA_REVIEW_OUTPUT,
    );
    if (![0, 1, 2].includes(result.code)) {
      throw runtimeError(502, cleanCommandError(result, "Claude 插件 Eval 执行失败"));
    }
    return {
      ok: result.code === 0,
      partial: result.code === 2,
      thresholdPassed: result.code === 0,
      exitCode: result.code,
      maxCostUsd: options.maxCostUsd,
      diagnostics: safeCommandOutput(`${result.stdout}\n${result.stderr}`, MAX_CLAUDE_ULTRA_REVIEW_OUTPUT),
      completedAt: Date.now(),
    };
  }

  async previewPluginTag(cwd, requestedPath) {
    const project = await this.normalizeHooksCwd(cwd);
    const target = await resolveClaudePluginTagTarget(project, requestedPath);
    const plan = await this.readPluginTagPlan(project, target);
    const previewToken = crypto.randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    this.prunePluginTagPreviews(createdAt);
    this.pluginTagPreviews.set(previewToken, {
      cwd: project,
      target,
      fingerprint: crypto.createHash("sha256").update(plan).digest("hex"),
      createdAt,
    });
    return {
      previewToken,
      plan,
      expiresAt: createdAt + CLAUDE_PLUGIN_TAG_PREVIEW_TTL_MS,
    };
  }

  async createPluginTag({
    cwd,
    path: requestedPath,
    previewToken,
    confirmation,
  } = {}) {
    if (confirmation !== "创建 Claude 插件标签") {
      throw runtimeError(400, "Claude 插件标签确认不匹配");
    }
    const project = await this.normalizeHooksCwd(cwd);
    const target = await resolveClaudePluginTagTarget(project, requestedPath);
    const token = typeof previewToken === "string" ? previewToken.trim() : "";
    const preview = this.pluginTagPreviews.get(token);
    this.pluginTagPreviews.delete(token);
    if (
      !preview
      || Date.now() - preview.createdAt > CLAUDE_PLUGIN_TAG_PREVIEW_TTL_MS
      || preview.cwd !== project
      || preview.target !== target
    ) throw runtimeError(409, "Claude 插件标签预览已失效，请重新预览");
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const plan = await this.readPluginTagPlan(project, target);
      const fingerprint = crypto.createHash("sha256").update(plan).digest("hex");
      if (fingerprint !== preview.fingerprint) {
        throw runtimeError(409, "Claude 插件标签计划在预览后发生变化，请重新预览");
      }
      const result = await runCommand(
        this.command,
        ["plugin", "tag", target],
        this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
        60_000,
        64 * 1024,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, "Claude 插件标签创建失败"));
      }
      return {
        ok: true,
        created: true,
        diagnostics: safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000),
      };
    });
  }

  async readPluginTagPlan(project, target) {
    const result = await runCommand(
      this.command,
      ["plugin", "tag", "--dry-run", target],
      this.spawnOptions({ cwd: project, stdio: ["ignore", "pipe", "pipe"] }),
      30_000,
      64 * 1024,
    );
    if (result.code !== 0) {
      throw runtimeError(502, cleanCommandError(result, "Claude 插件标签预览失败"));
    }
    return safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000) || "Claude 未返回标签预览";
  }

  prunePluginTagPreviews(now = Date.now()) {
    for (const [token, preview] of this.pluginTagPreviews) {
      if (now - preview.createdAt > CLAUDE_PLUGIN_TAG_PREVIEW_TTL_MS) {
        this.pluginTagPreviews.delete(token);
      }
    }
  }

  async autoModeSnapshot(group = null) {
    const normalizedGroup = normalizeClaudeAutoModeGroup(group);
    const [effectiveResult, defaultResult] = await Promise.all([
      runCommand(
        this.command,
        ["auto-mode", "config"],
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        30_000,
        MAX_CLAUDE_AUTO_MODE_OUTPUT,
      ),
      runCommand(
        this.command,
        ["auto-mode", "defaults"],
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        30_000,
        MAX_CLAUDE_AUTO_MODE_OUTPUT,
      ),
    ]);
    const effective = parseClaudeAutoModeResult(effectiveResult, "Claude Auto Mode 当前配置读取失败");
    const defaults = parseClaudeAutoModeResult(defaultResult, "Claude Auto Mode 默认配置读取失败");
    const groups = CLAUDE_AUTO_MODE_GROUPS.map((name) => {
      const currentRules = effective[name];
      const defaultRules = defaults[name];
      return {
        name,
        effectiveCount: currentRules.length,
        defaultCount: defaultRules.length,
        effectiveCharacters: currentRules.reduce((total, rule) => total + rule.length, 0),
        defaultCharacters: defaultRules.reduce((total, rule) => total + rule.length, 0),
        customized: JSON.stringify(currentRules) !== JSON.stringify(defaultRules),
      };
    });
    return {
      groups,
      hasCustomRules: groups.some((entry) => entry.customized),
      selectedGroup: normalizedGroup,
      ...(normalizedGroup ? {
        effective: effective[normalizedGroup],
        defaults: defaults[normalizedGroup],
      } : {}),
      checkedAt: Date.now(),
    };
  }

  async critiqueAutoMode(model = null) {
    const normalizedModel = normalizeClaudeAutoModeModel(model);
    const args = ["auto-mode", "critique"];
    if (normalizedModel) args.push("--model", normalizedModel);
    const result = await runCommand(
      this.command,
      args,
      this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
      3 * 60_000,
      64 * 1024,
    );
    if (result.code !== 0) {
      throw runtimeError(502, cleanCommandError(result, "Claude Auto Mode 规则评估失败"));
    }
    return {
      ok: true,
      model: normalizedModel,
      critique: safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000),
      checkedAt: Date.now(),
    };
  }

  async resetAutoMode(confirmation) {
    if (confirmation !== "重置 Auto Mode 规则") {
      throw runtimeError(400, "Claude Auto Mode 重置确认不匹配");
    }
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const result = await runCommand(
        this.command,
        ["auto-mode", "reset", "--yes"],
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        30_000,
      );
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(result, "Claude Auto Mode 默认规则恢复失败"));
      }
      await this.reloadIdleChildrenForConfigurationChange("Claude Auto Mode 规则已恢复默认");
      return { ok: true, reset: true };
    });
  }

  async previewProjectPurge(cwd, officialAccountId = null) {
    const project = await this.normalizeHooksCwd(cwd);
    const context = this.projectPurgeContext(officialAccountId);
    const plan = await this.readProjectPurgePlan(project, context);
    const estimate = await inspectClaudeProjectState({
      configDirectory: context.configDirectory,
      cwd: project,
      sessionIds: this.projectNativeSessionIds(project),
    });
    const previewToken = crypto.randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    this.pruneProjectPurgePreviews(createdAt);
    this.projectPurgePreviews.set(previewToken, {
      cwd: project,
      officialAccountId: context.officialAccountId,
      fingerprint: projectPurgeFingerprint(plan),
      createdAt,
    });
    return {
      previewToken,
      exists: plan.exists,
      plan: plan.output,
      estimate,
      officialAccountId: context.officialAccountId,
      expiresAt: createdAt + CLAUDE_PROJECT_PURGE_PREVIEW_TTL_MS,
    };
  }

  async purgeProject({
    cwd,
    officialAccountId = null,
    previewToken,
    confirmation,
  } = {}) {
    if (confirmation !== "清理 Claude 工程状态") {
      throw runtimeError(400, "Claude 工程清理确认不匹配");
    }
    const project = await this.normalizeHooksCwd(cwd);
    const token = typeof previewToken === "string" ? previewToken.trim() : "";
    const preview = this.projectPurgePreviews.get(token);
    this.projectPurgePreviews.delete(token);
    if (
      !preview
      || Date.now() - preview.createdAt > CLAUDE_PROJECT_PURGE_PREVIEW_TTL_MS
      || preview.cwd !== project
    ) {
      throw runtimeError(409, "Claude 工程清理预览已失效，请重新预览");
    }
    const context = this.projectPurgeContext(officialAccountId);
    if (preview.officialAccountId !== context.officialAccountId) {
      throw runtimeError(409, "Claude 工程清理账号已变化，请重新预览");
    }
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const currentPlan = await this.readProjectPurgePlan(project, context);
      if (projectPurgeFingerprint(currentPlan) !== preview.fingerprint) {
        throw runtimeError(409, "Claude 工程状态在预览后发生变化，请重新预览");
      }
      if (!currentPlan.exists) throw runtimeError(409, "当前工程没有可清理的 Claude 原生状态");
      const backup = await this.backupProjectState(project, context, currentPlan);
      await this.closeProjectChildren(project);
      const result = await runCommand(
        this.command,
        ["project", "purge", "--yes", project],
        this.spawnOptions({
          cwd: project,
          officialAccountId: context.officialAccountId,
          configDirectory: context.configDirectory,
          stdio: ["ignore", "pipe", "pipe"],
        }),
        2 * 60_000,
        64 * 1024,
      );
      if (result.code !== 0) {
        throw runtimeError(502, `${cleanCommandError(result, "Claude 工程状态清理失败")}；私有备份 ${backup.id} 已保留`);
      }
      const affectedSessions = [];
      for (const session of this.sessions.values()) {
        if (session.cwd !== project) continue;
        const previousNativeId = session.nativeSessionId || (session.nativeStarted ? session.id : null);
        if (isUuid(previousNativeId)) this.deletedNativeSessionIds.add(previousNativeId);
        session.nativeSessionId = null;
        session.nativeStarted = false;
        session.pendingForkNativeId = null;
        session.pendingTurn = null;
        for (const message of session.messages) delete message.nativeMessageId;
        this.upsertTranscript(session, {
          id: `project-purge:${backup.id}:${session.id}`,
          type: "system",
          subtype: "project_state_purged",
          content: `Claude 原生工程状态已清理；WFL 对话记录仍保留。下一条消息会启动新的原生上下文。恢复备份编号：${backup.id}`,
          status: "completed",
          at: Date.now(),
        });
        session.updatedAt = Date.now();
        affectedSessions.push(session.id);
      }
      while (this.deletedNativeSessionIds.size > MAX_DELETED_NATIVE_SESSIONS) {
        this.deletedNativeSessionIds.delete(this.deletedNativeSessionIds.values().next().value);
      }
      await this.persistSessions();
      this.emit("status", this.status());
      return {
        ok: true,
        purged: true,
        backup,
        affectedSessions: affectedSessions.length,
      };
    });
  }

  projectPurgeContext(officialAccountId = null) {
    const requestedAccountId = normalizeClaudeAccountId(officialAccountId);
    if (
      officialAccountId !== null
      && officialAccountId !== undefined
      && officialAccountId !== ""
      && !requestedAccountId
    ) {
      throw runtimeError(400, "Claude 工程清理账号 ID 无效");
    }
    if (requestedAccountId && !this.officialAccounts?.has(requestedAccountId)) {
      throw runtimeError(404, "Claude 工程清理账号不存在");
    }
    const activeProvider = this.store?.getActiveProfile?.() || null;
    const resolvedAccountId = requestedAccountId
      || (!activeProvider ? this.officialAccounts?.activeId() || null : null);
    return {
      officialAccountId: resolvedAccountId,
      configDirectory: resolvedAccountId
        ? this.officialAccounts.configDirectory(resolvedAccountId)
        : this.configDirectory,
    };
  }

  async readProjectPurgePlan(project, context) {
    const result = await runCommand(
      this.command,
      ["project", "purge", "--dry-run", project],
      this.spawnOptions({
        cwd: project,
        officialAccountId: context.officialAccountId,
        configDirectory: context.configDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      30_000,
      64 * 1024,
    );
    const output = safeCommandOutput(`${result.stdout}\n${result.stderr}`, 32_000);
    const notFound = result.code !== 0 && /No Claude Code project state found/i.test(output);
    if (result.code !== 0 && !notFound) {
      throw runtimeError(502, cleanCommandError(result, "Claude 工程状态预览失败"));
    }
    return { exists: !notFound, output: output || (notFound ? "当前工程没有 Claude 原生状态" : "Claude 未返回清理项") };
  }

  projectNativeSessionIds(project) {
    return [...new Set([...this.sessions.values()]
      .filter((session) => session.cwd === project)
      .flatMap((session) => [session.id, session.nativeSessionId])
      .filter(isUuid))];
  }

  pruneProjectPurgePreviews(now = Date.now()) {
    for (const [token, preview] of this.projectPurgePreviews) {
      if (now - preview.createdAt > CLAUDE_PROJECT_PURGE_PREVIEW_TTL_MS) {
        this.projectPurgePreviews.delete(token);
      }
    }
  }

  async backupProjectState(project, context, plan) {
    const id = `cpp-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(5).toString("hex")}`;
    const destination = path.join(this.projectPurgeBackupDirectory, id);
    const sessionIds = this.projectNativeSessionIds(project);
    const sources = await claudeProjectStateSources(context.configDirectory, project, sessionIds);
    await fs.mkdir(destination, { mode: 0o700 });
    try {
      const stats = { files: 0, bytes: 0 };
      for (const source of sources) {
        await copyClaudeProjectStateEntry(
          source.absolute,
          path.join(destination, "native", source.relative),
          stats,
        );
      }
      const configuration = await readClaudeProjectConfiguration(context.configDirectory, project);
      const manifest = {
        version: 1,
        id,
        createdAt: Date.now(),
        cwd: project,
        officialAccountId: context.officialAccountId,
        plan: plan.output,
        projectConfiguration: configuration,
        sessionIds,
        files: stats.files,
        bytes: stats.bytes,
      };
      const manifestPath = path.join(destination, "manifest.json");
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(manifestPath, 0o600);
      if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
        await repairOwnership(destination, this.user.uid, this.user.gid);
      }
      return { id, files: stats.files, bytes: stats.bytes, sessions: sessionIds.length };
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async closeProjectChildren(project) {
    const exits = [];
    for (const session of this.sessions.values()) {
      if (session.cwd !== project) continue;
      const child = this.children.get(session.id);
      if (!child) continue;
      child.intentional = true;
      child.process?.kill("SIGTERM");
      exits.push(waitForChildExit(child.process, 5_000));
      this.children.delete(session.id);
    }
    await Promise.all(exits);
  }

  listUltraReviews(cwd = null) {
    const project = cwd ? path.resolve(cwd) : null;
    return [...this.ultraReviews.values()]
      .filter((review) => !project || review.cwd === project)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_CLAUDE_ULTRA_REVIEWS)
      .map(publicClaudeUltraReview);
  }

  async startUltraReview({
    cwd,
    target = null,
    timeoutMinutes = 30,
    officialAccountId = null,
  } = {}) {
    const project = await this.normalizeHooksCwd(cwd);
    const normalizedTarget = normalizeClaudeUltraReviewTarget(target);
    const normalizedTimeout = normalizeClaudeUltraReviewTimeout(timeoutMinutes);
    if ([...this.ultraReviews.values()].some((review) => review.status === "running")) {
      throw runtimeError(409, "当前账号已有 Ultra Review 正在运行");
    }
    const account = this.ultraReviewAccountContext(officialAccountId);
    const id = `cur-${crypto.randomBytes(12).toString("hex")}`;
    const now = Date.now();
    const review = {
      id,
      cwd: project,
      target: normalizedTarget,
      timeoutMinutes: normalizedTimeout,
      officialAccountId: account.officialAccountId,
      status: "running",
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      output: "",
      error: null,
      exitCode: null,
    };
    this.ultraReviews.set(id, review);
    this.trimUltraReviews();
    await this.persistUltraReviews();
    const args = ["ultrareview", "--json", "--timeout", String(normalizedTimeout)];
    if (normalizedTarget) args.push(normalizedTarget);
    const child = spawn(this.command, args, this.spawnOptions({
      cwd: project,
      officialAccountId: account.officialAccountId,
      configDirectory: account.configDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    const state = {
      child,
      stdout: "",
      stderr: "",
      cancelled: false,
      timer: null,
    };
    this.ultraReviewChildren.set(id, state);
    const append = (field, chunk) => {
      state[field] = `${state[field]}${chunk}`.slice(-MAX_CLAUDE_ULTRA_REVIEW_OUTPUT);
      review.updatedAt = Date.now();
      this.scheduleUltraReviewPersist();
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      state.stderr = `${state.stderr}\n${error.code || "SPAWN_ERROR"}`.slice(-MAX_CLAUDE_ULTRA_REVIEW_OUTPUT);
    });
    state.timer = setTimeout(() => {
      if (review.status !== "running") return;
      state.cancelled = false;
      review.error = "Ultra Review 超过服务器等待上限，已终止";
      child.kill("SIGTERM");
    }, (normalizedTimeout + 2) * 60_000);
    child.once("close", (code, signal) => {
      clearTimeout(state.timer);
      this.ultraReviewChildren.delete(id);
      review.exitCode = Number.isInteger(code) ? code : null;
      review.finishedAt = Date.now();
      review.updatedAt = review.finishedAt;
      review.output = safeCommandOutput(state.stdout, MAX_CLAUDE_ULTRA_REVIEW_OUTPUT);
      if (state.cancelled) {
        review.status = "cancelled";
        review.error = "Ultra Review 已由用户取消";
      } else if (code === 0) {
        review.status = "completed";
        review.error = null;
      } else {
        review.status = "failed";
        review.error = review.error || claudeUltraReviewFailure(state.stderr, code, signal);
      }
      void this.persistUltraReviews();
      this.emit("event", { type: "ultra-review/updated", review: publicClaudeUltraReview(review) });
    });
    this.emit("event", { type: "ultra-review/updated", review: publicClaudeUltraReview(review) });
    return publicClaudeUltraReview(review);
  }

  async cancelUltraReview(id) {
    const reviewId = normalizeClaudeUltraReviewId(id);
    const review = this.ultraReviews.get(reviewId);
    if (!review) throw runtimeError(404, "Claude Ultra Review 不存在");
    if (review.status !== "running") return publicClaudeUltraReview(review);
    const state = this.ultraReviewChildren.get(reviewId);
    if (!state?.child) {
      review.status = "interrupted";
      review.error = "Ultra Review 运行进程已不可用";
      review.finishedAt = Date.now();
      review.updatedAt = review.finishedAt;
      await this.persistUltraReviews();
      return publicClaudeUltraReview(review);
    }
    state.cancelled = true;
    state.child.kill("SIGTERM");
    return publicClaudeUltraReview({ ...review, status: "cancelling", updatedAt: Date.now() });
  }

  ultraReviewAccountContext(officialAccountId = null) {
    const requested = normalizeClaudeAccountId(officialAccountId);
    if (
      officialAccountId !== null
      && officialAccountId !== undefined
      && officialAccountId !== ""
      && !requested
    ) throw runtimeError(400, "Claude Ultra Review 账号 ID 无效");
    const resolved = requested || this.officialAccounts?.activeId() || null;
    if (this.officialAccounts) {
      if (!resolved || !this.officialAccounts.has(resolved)) {
        throw runtimeError(409, "Ultra Review 需要已登录的 Claude 官方账号");
      }
      const account = this.officialAccounts.get(resolved);
      if (account.credentialStatus !== "valid") {
        throw runtimeError(409, "Claude 官方账号登录已失效，请重新认证后运行 Ultra Review");
      }
      return {
        officialAccountId: resolved,
        configDirectory: this.officialAccounts.configDirectory(resolved),
      };
    }
    return { officialAccountId: null, configDirectory: this.configDirectory };
  }

  trimUltraReviews() {
    const removable = [...this.ultraReviews.values()]
      .filter((review) => review.status !== "running")
      .sort((left, right) => left.createdAt - right.createdAt);
    while (this.ultraReviews.size > MAX_CLAUDE_ULTRA_REVIEWS && removable.length) {
      this.ultraReviews.delete(removable.shift().id);
    }
  }

  async loadUltraReviews() {
    try {
      const source = JSON.parse(await fs.readFile(this.ultraReviewsPath, "utf8"));
      for (const value of Array.isArray(source?.reviews) ? source.reviews.slice(-MAX_CLAUDE_ULTRA_REVIEWS) : []) {
        const review = normalizePersistedClaudeUltraReview(value);
        if (review) this.ultraReviews.set(review.id, review);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.emit("log", { level: "warn", message: claudeLogFailure("Ultra Review 状态读取", error) });
      }
    }
  }

  scheduleUltraReviewPersist() {
    if (this.ultraReviewPersistTimer) return;
    this.ultraReviewPersistTimer = setTimeout(() => {
      this.ultraReviewPersistTimer = null;
      void this.persistUltraReviews();
    }, 1_000);
  }

  persistUltraReviews() {
    const operation = this.ultraReviewPersistQueue.then(
      () => this.writeUltraReviews(),
      () => this.writeUltraReviews(),
    );
    this.ultraReviewPersistQueue = operation.catch((error) => {
      this.emit("log", { level: "warn", message: claudeLogFailure("Ultra Review 状态保存", error) });
    });
    return operation;
  }

  async writeUltraReviews() {
    const temporary = `${this.ultraReviewsPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      version: 1,
      reviews: [...this.ultraReviews.values()].map(persistedClaudeUltraReview),
    })}\n`, { mode: 0o600, flag: "wx" });
    try {
      if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
        await fs.chown(temporary, this.user.uid, this.user.gid);
      }
      await fs.rename(temporary, this.ultraReviewsPath);
      await fs.chmod(this.ultraReviewsPath, 0o600);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async mutatePlugin(action, identifier) {
    return this.queueExtensionConfiguration(async () => {
      this.assertExtensionConfigurationIdle();
      const normalized = normalizePluginIdentifier(identifier);
      const result = await runCommand(
        this.command,
        ["plugin", action, normalized, "--scope", "user"],
        this.spawnOptions({ cwd: this.user.projectRoot, stdio: ["ignore", "pipe", "pipe"] }),
        60_000,
      );
      if (result.code !== 0) throw runtimeError(502, cleanCommandError(result, `Claude 插件${pluginActionLabel(action)}失败`));
      await this.reloadIdleChildrenForConfigurationChange("Claude 插件配置已更改");
      return { ok: true, identifier: normalized, action };
    });
  }

  listSessions({ cwd = null, archived = false } = {}) {
    return [...this.sessions.values()]
      .filter((session) => !cwd || session.cwd === cwd)
      .filter((session) => session.archived === Boolean(archived))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => publicSession(session, false, this.children.get(session.id)));
  }

  async readMemory(cwd) {
    const normalizedCwd = await this.normalizeMemoryCwd(cwd);
    const target = this.memoryPath(normalizedCwd);
    try {
      const source = JSON.parse(await fs.readFile(target, "utf8"));
      if (source?.version !== 1 || source.cwd !== normalizedCwd) return publicMemory(normalizedCwd, "");
      return publicMemory(normalizedCwd, source.text);
    } catch (error) {
      if (error.code === "ENOENT") return publicMemory(normalizedCwd, "");
      throw runtimeError(500, "Claude Memory 无法读取，原始诊断已隐藏");
    }
  }

  async saveMemory(cwd, text) {
    const normalizedCwd = await this.normalizeMemoryCwd(cwd);
    const value = typeof text === "string" ? text.trim() : "";
    if (value.length > MAX_MEMORY_LENGTH) throw runtimeError(400, "Claude Memory 不能超过 32,000 个字符");
    this.assertExtensionConfigurationIdle();
    const target = this.memoryPath(normalizedCwd);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      version: 1,
      cwd: normalizedCwd,
      text: value,
      updatedAt: Date.now(),
    })}\n`, { mode: 0o600, flag: "wx" });
    if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
      await fs.chown(temporary, this.user.uid, this.user.gid);
    }
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await this.syncDirectory(this.memoryDirectory);
    await this.reloadIdleChildrenForConfigurationChange("Claude Memory 已更改");
    return publicMemory(normalizedCwd, value);
  }

  async clearMemory(cwd) {
    const normalizedCwd = await this.normalizeMemoryCwd(cwd);
    this.assertExtensionConfigurationIdle();
    await fs.rm(this.memoryPath(normalizedCwd), { force: true });
    await this.syncDirectory(this.memoryDirectory);
    await this.reloadIdleChildrenForConfigurationChange("Claude Memory 已清除");
    return publicMemory(normalizedCwd, "");
  }

  async readHooks(cwd) {
    const normalizedCwd = await this.normalizeHooksCwd(cwd);
    const target = this.hooksPath(normalizedCwd);
    let handle;
    try {
      const linkStat = await fs.lstat(target);
      if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
        throw runtimeError(500, "Claude Hooks 配置文件不安全");
      }
      handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      const managedUser = this.user.legacy === false
        && Number.isInteger(this.user.uid)
        && Number.isInteger(this.user.gid);
      if (
        !stat.isFile()
        || stat.size > MAX_CLAUDE_CONFIG_BYTES
        || stat.dev !== linkStat.dev
        || stat.ino !== linkStat.ino
        || (stat.mode & 0o777) !== 0o600
        || (managedUser && (stat.uid !== this.user.uid || stat.gid !== this.user.gid))
      ) {
        throw runtimeError(500, "Claude Hooks 配置文件不安全");
      }
      const source = JSON.parse(await handle.readFile("utf8"));
      const entries = flattenNativeHooks(source?.hooks);
      if (!entries) throw runtimeError(500, "Claude Hooks 配置格式无效");
      return publicHooks(normalizedCwd, entries);
    } catch (error) {
      if (error.code === "ENOENT") return publicHooks(normalizedCwd, []);
      if (error.code === "ELOOP") throw runtimeError(500, "Claude Hooks 配置文件不安全");
      if (error instanceof SyntaxError) throw runtimeError(500, "Claude Hooks 配置无法解析");
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async saveHooks(cwd, hooks) {
    const normalizedCwd = await this.normalizeHooksCwd(cwd);
    const entries = normalizeHooks(hooks);
    this.assertExtensionConfigurationIdle();
    const target = this.hooksPath(normalizedCwd);
    if (!entries.length) {
      await fs.rm(target, { force: true });
      await this.syncDirectory(this.hooksDirectory);
      await this.reloadIdleChildrenForConfigurationChange("Claude Hooks 已清除");
      return publicHooks(normalizedCwd, []);
    }
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({
      hooks: buildNativeHooks(entries),
    })}\n`, { mode: 0o600, flag: "wx" });
    try {
      if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
        await fs.chown(temporary, this.user.uid, this.user.gid);
      }
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      await this.syncDirectory(this.hooksDirectory);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    await this.reloadIdleChildrenForConfigurationChange("Claude Hooks 已更改");
    return publicHooks(normalizedCwd, entries);
  }

  async clearHooks(cwd) {
    return this.saveHooks(cwd, []);
  }

  /**
   * Native Claude background Agents are independent daemon jobs. These
   * delegates intentionally expose no provider environment or API secrets.
   */
  async startBackgroundAgent(options = {}) {
    const activeProvider = this.store?.getActiveProfile?.() || null;
    const cwd = await this.normalizeHooksCwd(options.cwd);
    const dispatch = normalizeClaudeLaunchSettings({
      settingSources: options.settingSources,
      strictMcpConfig: options.strictMcpConfig,
      mcpServerNames: options.mcpServerNames,
      pluginDirectories: options.pluginDirectories,
    }, { strict: true });
    dispatch.pluginDirectories = await resolveClaudePluginDirectories(dispatch.pluginDirectories, {
      cwd,
      projectRoot: this.user.projectRoot,
    });
    const additionalDirectories = await resolveAdditionalDirectories(
      normalizeAdditionalDirectories(options.additionalDirectories, cwd, this.user.projectRoot),
      cwd,
      this.user.projectRoot,
    );
    let mcpConfigPath = null;
    if (dispatch.strictMcpConfig || dispatch.mcpServerNames.length) {
      mcpConfigPath = await this.writeSessionMcpConfig({
        id: crypto.randomUUID(),
        cwd,
        mcpServerNames: dispatch.mcpServerNames,
      });
    }
    let settingsPath = null;
    if (options.includeHooks === true) {
      const hooks = await this.readHooks(cwd);
      if (hooks.configured) settingsPath = this.hooksPath(hooks.cwd);
    }
    try {
      return await this.backgroundAgents.start({
        ...options,
        cwd,
        model: options.model || activeProvider?.model || null,
        providerId: activeProvider?.id || null,
        providerName: activeProvider?.name || "Claude 官方账号",
        settingSources: dispatch.settingSources,
        strictMcpConfig: dispatch.strictMcpConfig,
        mcpServerNames: dispatch.mcpServerNames,
        mcpConfigPath,
        pluginDirectories: dispatch.pluginDirectories,
        additionalDirectories,
        settingsPath,
      });
    } finally {
      if (mcpConfigPath) await fs.rm(mcpConfigPath, { force: true }).catch(() => {});
    }
  }

  async listBackgroundAgents(options = {}) {
    return this.backgroundAgents.list(options);
  }

  async taskCenterBackgroundAgents() {
    return this.backgroundAgents.taskSnapshot();
  }

  async readBackgroundAgent(id, options = {}) {
    return this.backgroundAgents.read(id, options);
  }

  async stopBackgroundAgent(id) {
    return this.backgroundAgents.stop(id);
  }

  /**
   * Ask the native Claude process to preview or restore the file checkpoint
   * associated with a user message.  Conversation history is intentionally
   * left untouched; callers that want a conversation branch must use the
   * existing fork operation.
   */
  async rewindFiles(id, { messageId, dryRun = true, confirm = false } = {}) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    const target = await this.resolveRewindTarget(session, messageId);
    if (!target) throw runtimeError(400, "此 Claude 消息没有可用的原生检查点");
    const wantsDryRun = dryRun !== false;
    if (!wantsDryRun && confirm !== true) {
      throw runtimeError(400, "恢复代码前需要明确确认");
    }
    const current = this.children.get(session.id);
    if (current?.turnActive) throw runtimeError(409, "Claude 正在执行任务，完成后再回退代码");
    const child = current || await this.ensureChild(session);
    await child.initializeReady?.catch((error) => {
      throw runtimeError(502, "Claude 回退通道未就绪，原始诊断已隐藏");
    });
    if (child.turnActive) throw runtimeError(409, "Claude 正在执行任务，完成后再回退代码");
    const response = await this.requestChildControl(
      session,
      child,
      {
        subtype: "rewind_files",
        user_message_id: target.nativeMessageId,
        dry_run: wantsDryRun,
      },
      DEFAULT_REWIND_REQUEST_TIMEOUT_MS,
    );
    const result = sanitizeRewindResult(response, session.cwd);
    if (!wantsDryRun && result.canRewind) {
      this.upsertTranscript(session, {
        id: `rewind:${target.nativeMessageId}:${Date.now()}`,
        type: "system",
        subtype: "rewind_files",
        content: result.filesChanged.length
          ? `已恢复 ${result.filesChanged.length} 个文件：${result.filesChanged.join(", ")}`
          : "已恢复 Claude 文件检查点",
        status: "completed",
        at: Date.now(),
      });
      session.updatedAt = Date.now();
      await this.persistSessions();
      this.emit("event", { type: "session/updated", sessionId: session.id, session: publicSession(session, false, child) });
    }
    return {
      ...result,
      sessionId: session.id,
      messageId: target.localMessageId,
      dryRun: wantsDryRun,
    };
  }

  async resolveRewindTarget(session, messageId) {
    const requested = typeof messageId === "string" ? messageId.trim() : "";
    if (!requested || requested.length > 256 || /[\0\r\n]/.test(requested)) return null;
    const local = session.messages.find(
      (item) => item.type === "message" && item.role === "user"
        && (item.id === requested || item.nativeMessageId === requested),
    );
    if (local?.nativeMessageId && isUuid(local.nativeMessageId)) {
      return { localMessageId: local.id, nativeMessageId: local.nativeMessageId };
    }
    // Sessions created before native message IDs were captured can still be
    // upgraded lazily by reading their private JSONL transcript.
    await this.hydrateNativeMessageIds(session);
    const hydrated = session.messages.find(
      (item) => item.type === "message" && item.role === "user"
        && (item.id === requested || item.nativeMessageId === requested),
    );
    if (hydrated?.nativeMessageId && isUuid(hydrated.nativeMessageId)) {
      await this.persistSessions();
      return { localMessageId: hydrated.id, nativeMessageId: hydrated.nativeMessageId };
    }
    return null;
  }

  async hydrateNativeMessageIds(session) {
    const unresolved = session.messages.filter(
      (item) => item.type === "message" && item.role === "user" && !isUuid(item.nativeMessageId),
    );
    if (!unresolved.length || !isUuid(session.nativeSessionId)) return;
    const events = await this.readNativeTranscriptEvents(session);
    if (!events.length) return;
    const used = new Set();
    for (const event of events) {
      const nativeMessageId = normalizeNativeMessageId(event.uuid || event.message?.id);
      if (!nativeMessageId) continue;
      const text = nativeUserText(event);
      if (!text) continue;
      const candidate = unresolved.find((item) =>
        !used.has(item.id) && normalizeComparableText(item.content) === normalizeComparableText(text));
      if (!candidate) continue;
      candidate.nativeMessageId = nativeMessageId;
      used.add(candidate.id);
    }
  }

  async readNativeTranscriptEvents(session) {
    const projectsDirectory = path.join(this.configDirectory, "projects");
    let projectEntries;
    try {
      projectEntries = await fs.readdir(projectsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      return [];
    }
    const expectedName = `${session.nativeSessionId}.jsonl`;
    for (const entry of projectEntries.slice(0, MAX_NATIVE_TRANSCRIPTS_SCANNED)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = path.join(projectsDirectory, entry.name, expectedName);
      let handle;
      try {
        const linkStat = await fs.lstat(target);
        if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size <= 0 || linkStat.size > MAX_NATIVE_TRANSCRIPT_BYTES) {
          continue;
        }
        handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        const managedUser = this.user.legacy === false
          && Number.isInteger(this.user.uid)
          && Number.isInteger(this.user.gid);
        if (
          !stat.isFile()
          || stat.isSymbolicLink?.()
          || stat.dev !== linkStat.dev
          || stat.ino !== linkStat.ino
          || (stat.mode & 0o777) !== 0o600
          || (managedUser && (stat.uid !== this.user.uid || stat.gid !== this.user.gid))
        ) continue;
        const source = await handle.readFile("utf8");
        const events = [];
        for (const line of source.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (
              event?.type === "user"
              && event?.sessionId === session.nativeSessionId
              && normalizeNativeMessageId(event.uuid || event.message?.id)
              && nativeUserText(event)
            ) events.push(event);
          } catch {
            // Ignore malformed lines; native CLI can append while we read.
          }
        }
        return events;
      } catch {
        // Continue scanning other project directories.
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return [];
  }

  async normalizeMemoryCwd(cwd) {
    if (typeof cwd !== "string" || !cwd) throw runtimeError(400, "Claude Memory 工程目录无效");
    let resolved;
    try {
      resolved = await fs.realpath(cwd);
    } catch {
      throw runtimeError(400, "Claude Memory 工程目录不存在");
    }
    const root = await fs.realpath(this.user.projectRoot);
    if (!pathWithin(root, resolved)) throw runtimeError(403, "Claude Memory 工程目录超出账号范围");
    return resolved;
  }

  async normalizeHooksCwd(cwd) {
    if (typeof cwd !== "string" || !cwd) throw runtimeError(400, "Claude Hooks 工程目录无效");
    let resolved;
    try {
      resolved = await fs.realpath(cwd);
    } catch {
      throw runtimeError(400, "Claude Hooks 工程目录不存在");
    }
    const root = await fs.realpath(this.user.projectRoot);
    if (!pathWithin(root, resolved)) throw runtimeError(403, "Claude Hooks 工程目录超出账号范围");
    return resolved;
  }

  memoryPath(cwd) {
    const digest = crypto.createHash("sha256").update(cwd).digest("hex");
    return path.join(this.memoryDirectory, `${digest}.json`);
  }

  hooksPath(cwd) {
    const digest = crypto.createHash("sha256").update(cwd).digest("hex");
    return path.join(this.hooksDirectory, `${digest}.json`);
  }

  async syncDirectory(directory) {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async discoverNativeSessions({ cwd = null } = {}) {
    const projectsDirectory = path.join(this.configDirectory, "projects");
    let projectDirectories;
    try {
      projectDirectories = await fs.readdir(projectsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return { discovered: 0 };
      throw error;
    }
    const knownNativeIds = new Set([
      ...this.deletedNativeSessionIds,
      ...[...this.sessions.values()].map((session) => session.nativeSessionId).filter(Boolean),
    ]);
    let discovered = 0;
    let scanned = 0;
    nativeProjects: for (const projectEntry of projectDirectories) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
      const directory = path.join(projectsDirectory, projectEntry.name);
      let files;
      try {
        files = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of files) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
        scanned += 1;
        if (scanned > MAX_NATIVE_TRANSCRIPTS_SCANNED) break nativeProjects;
        const nativeSessionId = entry.name.slice(0, -6);
        if (!isUuid(nativeSessionId) || knownNativeIds.has(nativeSessionId)) continue;
        const session = await nativeSessionFromFile(path.join(directory, entry.name), { cwd, nativeSessionId });
        if (!session) continue;
        this.sessions.set(session.id, session);
        knownNativeIds.add(nativeSessionId);
        discovered += 1;
      }
    }
    if (discovered) {
      while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
      await this.persistSessions();
      this.emit("status", this.status());
    }
    return { discovered };
  }

  readSession(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    return publicSession(session, true, this.children.get(session.id));
  }

  async startSession({
    cwd,
    model = null,
    permissionMode = DEFAULT_PERMISSION_MODE,
    effort = null,
    fallbackModel = null,
    maxBudgetUsd = null,
    allowedTools = null,
    disallowedTools = null,
    agent = null,
    forkedFrom = null,
    workspaceMode = "project",
    worktreeName = null,
    additionalDirectories = [],
    systemPrompt = undefined,
    excludeDynamicSystemPromptSections = undefined,
    settingSources = undefined,
    safeMode = undefined,
    strictMcpConfig = undefined,
    mcpServerNames = undefined,
    noSessionPersistence = undefined,
    autocompact = undefined,
    jsonSchema = undefined,
    inlineAgentNames = undefined,
    brief = undefined,
    remoteFiles = undefined,
    fromPr = undefined,
    pluginDirectories = undefined,
    pluginUrls = undefined,
    betaHeaders = undefined,
  } = {}) {
    const normalizedWorkspace = normalizeWorkspaceSettings({
      cwd,
      workspaceMode,
      worktreeName,
      additionalDirectories,
      projectRoot: this.user.projectRoot,
    });
    normalizedWorkspace.additionalDirectories = await resolveAdditionalDirectories(
      normalizedWorkspace.additionalDirectories,
      cwd,
      this.user.projectRoot,
    );
    const execution = normalizeClaudeExecutionSettings({
      fallbackModel,
      maxBudgetUsd,
      allowedTools,
      disallowedTools,
      agent,
    }, { strict: true });
    const launch = normalizeClaudeLaunchSettings({
      systemPrompt,
      excludeDynamicSystemPromptSections,
      settingSources,
      safeMode,
      strictMcpConfig,
      mcpServerNames,
      noSessionPersistence,
      autocompact,
      jsonSchema,
      inlineAgentNames,
      brief,
      remoteFiles,
      fromPr,
      pluginDirectories,
      pluginUrls,
      betaHeaders,
    }, { strict: true });
    if (!launch.safeMode) {
      launch.pluginDirectories = await resolveClaudePluginDirectories(launch.pluginDirectories, {
        cwd,
        projectRoot: this.user.projectRoot,
      });
    }
    if (forkedFrom && launch.fromPr) {
      throw runtimeError(400, "从 PR 恢复和对话分支不能同时启用");
    }
    const activeProvider = this.store?.getActiveProfile?.() || null;
    const activeOfficialAccountId = activeProvider
      ? null
      : this.officialAccounts?.activeId() || null;
    const activeOfficialAccount = activeOfficialAccountId
      ? this.officialAccounts?.get(activeOfficialAccountId)
      : null;
    if (launch.betaHeaders.length && !activeProvider) {
      throw runtimeError(409, "Anthropic Beta Header 仅支持 API Key 供应商");
    }
    const session = normalizeSession({
      id: crypto.randomUUID(),
      cwd,
      model: model || activeProvider?.model || DEFAULT_MODEL,
      providerId: normalizeProviderId(activeProvider?.id),
      providerName: activeProvider?.name || null,
      officialAccountId: activeOfficialAccountId,
      officialAccountName: officialAccountDisplayName(activeOfficialAccount),
      nameOrigin: "default",
      permissionMode,
      effort,
      ...execution,
      ...launch,
      name: "新 Claude 对话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      archived: false,
      forkedFrom: typeof forkedFrom === "string" ? forkedFrom : null,
      nativeSessionId: null,
      nativeStarted: false,
      pendingForkNativeId: null,
      ...normalizedWorkspace,
    });
    if (!session) throw runtimeError(400, "Claude 对话参数无效");
    if (forkedFrom) {
      const parent = this.sessions.get(forkedFrom);
      if (parent) {
        session.messages = parent.messages.slice(-MAX_TRANSCRIPT_ITEMS).map((item) => structuredClone(item));
        session.pendingForkNativeId = parent.nativeStarted ? (parent.nativeSessionId || parent.id) : null;
        session.workspaceMode = "project";
        session.worktreeName = null;
        session.additionalDirectories = [...parent.additionalDirectories];
        if (fallbackModel === null || fallbackModel === undefined) session.fallbackModel = parent.fallbackModel;
        if (maxBudgetUsd === null || maxBudgetUsd === undefined) session.maxBudgetUsd = parent.maxBudgetUsd;
        if (allowedTools === null || allowedTools === undefined) session.allowedTools = [...parent.allowedTools];
        if (disallowedTools === null || disallowedTools === undefined) session.disallowedTools = [...parent.disallowedTools];
        if (agent === null || agent === undefined) session.agent = parent.agent;
        if (systemPrompt === undefined) session.systemPrompt = parent.systemPrompt;
        if (excludeDynamicSystemPromptSections === undefined) {
          session.excludeDynamicSystemPromptSections = parent.excludeDynamicSystemPromptSections;
        }
        if (settingSources === undefined) session.settingSources = [...parent.settingSources];
        if (safeMode === undefined) session.safeMode = parent.safeMode;
        if (strictMcpConfig === undefined) session.strictMcpConfig = parent.strictMcpConfig;
        if (mcpServerNames === undefined) session.mcpServerNames = [...parent.mcpServerNames];
        if (noSessionPersistence === undefined) session.noSessionPersistence = parent.noSessionPersistence;
        if (autocompact === undefined) session.autocompact = parent.autocompact;
        if (jsonSchema === undefined) session.jsonSchema = parent.jsonSchema;
        if (inlineAgentNames === undefined) session.inlineAgentNames = [...parent.inlineAgentNames];
        if (brief === undefined) session.brief = parent.brief;
        if (pluginDirectories === undefined) session.pluginDirectories = [...parent.pluginDirectories];
        if (pluginUrls === undefined) session.pluginUrls = [...parent.pluginUrls];
        if (betaHeaders === undefined) session.betaHeaders = [...parent.betaHeaders];
      }
    }
    if (session.betaHeaders.length && !session.providerId) {
      throw runtimeError(409, "Anthropic Beta Header 仅支持 API Key 供应商");
    }
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    await this.persistSessions();
    this.emit("event", { type: "session/started", sessionId: session.id, session: publicSession(session, true) });
    return publicSession(session, true);
  }

  async renameSession(id, name) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    const normalized = typeof name === "string" ? name.trim().slice(0, 200) : "";
    if (!normalized) throw runtimeError(400, "Claude 对话名称不能为空");
    session.name = normalized;
    session.nameOrigin = "user";
    session.updatedAt = Date.now();
    await this.persistSessions();
    const result = publicSession(session);
    this.emit("event", { type: "session/updated", sessionId: session.id, session: result });
    return result;
  }

  async archiveSession(id, archived = true) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    session.archived = Boolean(archived);
    session.updatedAt = Date.now();
    await this.persistSessions();
    const result = publicSession(session);
    this.emit("event", { type: "session/updated", sessionId: session.id, session: result });
    return result;
  }

  async configureSession(
    id,
    {
      model,
      permissionMode,
      effort,
      fallbackModel,
      maxBudgetUsd,
      allowedTools,
      disallowedTools,
      agent,
      systemPrompt,
      excludeDynamicSystemPromptSections,
      settingSources,
      safeMode,
      strictMcpConfig,
      mcpServerNames,
      noSessionPersistence,
      autocompact,
      jsonSchema,
      inlineAgentNames,
      brief,
      remoteFiles,
      fromPr,
      pluginDirectories,
      pluginUrls,
      betaHeaders,
    } = {},
  ) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    if (this.childStarts.has(session.id)) {
      throw runtimeError(409, "Claude 正在启动任务，完成或停止后再修改会话设置");
    }
    const child = this.children.get(session.id);
    if (child?.turnActive) throw runtimeError(409, "Claude 正在执行，完成或停止后再修改会话设置");
    const normalizedModel = typeof model === "string" ? model.trim().slice(0, 128) : session.model;
    if (!normalizedModel) throw runtimeError(400, "Claude 模型无效");
    const normalizedPermissionMode = permissionMode ?? session.permissionMode;
    if (!PERMISSION_MODES.has(normalizedPermissionMode)) throw runtimeError(400, "Claude 权限模式无效");
    const normalizedEffort = effort === undefined
      ? session.effort
      : effort === null || effort === "" ? null : effort;
    if (normalizedEffort !== null && !EFFORT_LEVELS.has(normalizedEffort)) {
      throw runtimeError(400, "Claude effort 无效");
    }
    const execution = normalizeClaudeExecutionSettings({
      fallbackModel: fallbackModel === undefined ? session.fallbackModel : fallbackModel,
      maxBudgetUsd: maxBudgetUsd === undefined ? session.maxBudgetUsd : maxBudgetUsd,
      allowedTools: allowedTools === undefined ? session.allowedTools : allowedTools,
      disallowedTools: disallowedTools === undefined ? session.disallowedTools : disallowedTools,
      agent: agent === undefined ? session.agent : agent,
    }, { strict: true });
    const launch = normalizeClaudeLaunchSettings({
      systemPrompt: systemPrompt === undefined ? session.systemPrompt : systemPrompt,
      excludeDynamicSystemPromptSections: excludeDynamicSystemPromptSections === undefined
        ? session.excludeDynamicSystemPromptSections
        : excludeDynamicSystemPromptSections,
      settingSources: settingSources === undefined ? session.settingSources : settingSources,
      safeMode: safeMode === undefined ? session.safeMode : safeMode,
      strictMcpConfig: strictMcpConfig === undefined ? session.strictMcpConfig : strictMcpConfig,
      mcpServerNames: mcpServerNames === undefined ? session.mcpServerNames : mcpServerNames,
      noSessionPersistence: noSessionPersistence === undefined
        ? session.noSessionPersistence
        : noSessionPersistence,
      autocompact: autocompact === undefined ? session.autocompact : autocompact,
      jsonSchema: jsonSchema === undefined ? session.jsonSchema : jsonSchema,
      inlineAgentNames: inlineAgentNames === undefined ? session.inlineAgentNames : inlineAgentNames,
      brief: brief === undefined ? session.brief : brief,
      remoteFiles: remoteFiles === undefined ? session.remoteFiles : remoteFiles,
      fromPr: fromPr === undefined ? session.fromPr : fromPr,
      pluginDirectories: pluginDirectories === undefined ? session.pluginDirectories : pluginDirectories,
      pluginUrls: pluginUrls === undefined ? session.pluginUrls : pluginUrls,
      betaHeaders: betaHeaders === undefined ? session.betaHeaders : betaHeaders,
    }, { strict: true });
    if (!launch.safeMode) {
      launch.pluginDirectories = await resolveClaudePluginDirectories(launch.pluginDirectories, {
        cwd: session.cwd,
        projectRoot: this.user.projectRoot,
      });
    }
    if (launch.betaHeaders.length && !session.providerId) {
      throw runtimeError(409, "Anthropic Beta Header 仅支持 API Key 供应商");
    }
    if (
      session.nativeStarted
      && launch.noSessionPersistence !== session.noSessionPersistence
    ) {
      throw runtimeError(409, "临时对话模式只能在 Claude 首次启动前修改");
    }
    if (
      session.nativeStarted
      && (
        JSON.stringify(launch.remoteFiles) !== JSON.stringify(session.remoteFiles)
        || launch.fromPr !== session.fromPr
      )
    ) {
      throw runtimeError(409, "远程文件与 PR 恢复只能在 Claude 首次启动前修改");
    }
    const pluginUrlsChanged = JSON.stringify(launch.pluginUrls) !== JSON.stringify(session.pluginUrls);
    if (child?.process) {
      await this.cancelControlRequests(session.id, "会话设置已更改");
      child.intentional = true;
      child.process.kill("SIGTERM");
      this.children.delete(session.id);
    }
    session.model = normalizedModel;
    session.permissionMode = normalizedPermissionMode;
    session.effort = normalizedEffort;
    Object.assign(session, execution);
    Object.assign(session, launch);
    if (pluginUrlsChanged) {
      await fs.rm(this.sessionPluginDirectory(session.id), { recursive: true, force: true }).catch(() => {});
    }
    if (!session.strictMcpConfig || session.safeMode) {
      await fs.rm(this.sessionMcpConfigPath(session.id), { force: true }).catch(() => {});
    }
    session.updatedAt = Date.now();
    await this.persistSessions();
    const result = publicSession(session, true);
    this.emit("event", { type: "session/updated", sessionId: session.id, session: result });
    this.emit("status", this.status());
    return result;
  }

  async removeSession(id) {
    const sessionId = String(id);
    const session = this.sessions.get(sessionId);
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    await this.cancelControlRequests(sessionId, "Claude 对话已删除");
    const child = this.children.get(sessionId);
    if (child) child.intentional = true;
    child?.process?.kill("SIGTERM");
    this.children.delete(sessionId);
    await fs.rm(this.sessionMcpConfigPath(sessionId), { force: true }).catch(() => {});
    await fs.rm(this.sessionPluginDirectory(sessionId), { recursive: true, force: true }).catch(() => {});
    if (session.nativeStarted || session.nativeSource || session.messages.some((item) => item.role === "assistant")) {
      const nativeSessionId = session.nativeSessionId || session.id;
      if (isUuid(nativeSessionId)) {
        this.deletedNativeSessionIds.add(nativeSessionId);
        while (this.deletedNativeSessionIds.size > MAX_DELETED_NATIVE_SESSIONS) {
          this.deletedNativeSessionIds.delete(this.deletedNativeSessionIds.values().next().value);
        }
      }
    }
    this.sessions.delete(sessionId);
    await this.persistSessions();
    this.emit("event", { type: "session/deleted", sessionId });
    this.emit("status", this.status());
    return { deleted: true, sessionId };
  }

  async sendMessage(
    id,
    text,
    attachments = [],
    { clientMessageId = null, recoveryRunId = null } = {},
  ) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    const normalizedText = typeof text === "string" ? text.trim() : "";
    const normalizedAttachments = normalizeAttachments(attachments);
    const normalizedClientMessageId = normalizeClientMessageId(clientMessageId);
    if ((!normalizedText && !normalizedAttachments.length) || normalizedText.length > 100_000) {
      throw runtimeError(400, "Claude 消息内容无效");
    }
    if (normalizedClientMessageId) {
      const existing = session.messages.find(
        (item) => item.role === "user" && item.clientMessageId === normalizedClientMessageId,
      );
      if (existing) {
        if (!sameMessagePayload(existing, normalizedText, normalizedAttachments)) {
          throw runtimeError(409, "Claude 重试消息内容不一致");
        }
        return {
          accepted: true,
          duplicate: true,
          sessionId: session.id,
          messageId: existing.id,
          runId: existing.runId || session.pendingTurn?.runId || null,
          status: session.pendingTurn?.status || "completed",
        };
      }
    }
    if (
      ["recoveryPending", "resuming", "stopping", "pausing", "paused", "retryWaiting", "retrying"].includes(session.pendingTurn?.status)
      && session.pendingTurn.runId !== recoveryRunId
    ) {
      throw runtimeError(409, "Claude 上一项任务等待恢复处理，请先继续或标记中断");
    }
    const existingChild = this.children.get(session.id);
    if (existingChild?.turnActive) throw runtimeError(409, "Claude 正在执行任务，请等待完成或先停止");
    const child = await this.ensureChild(session);
    if (child.turnActive) throw runtimeError(409, "Claude 正在执行任务，请等待完成或先停止");
    const runId = crypto.randomUUID();
    const item = {
      id: crypto.randomUUID(),
      runId,
      type: "message",
      role: "user",
      content: normalizedText,
      attachments: normalizedAttachments,
      at: Date.now(),
      ...(normalizedClientMessageId ? { clientMessageId: normalizedClientMessageId } : {}),
    };
    session.messages.push(item);
    session.suggestion = null;
    if (session.name === "新 Claude 对话") {
      session.name = (normalizedText || normalizedAttachments[0]?.name || "Claude 附件任务").replace(/\s+/g, " ").slice(0, 80);
      session.nameOrigin = "prompt";
    }
    session.updatedAt = Date.now();
    session.pendingTurn = {
      runId,
      clientMessageId: normalizedClientMessageId,
      messageId: item.id,
      startedAt: item.at,
      lastActivityAt: item.at,
      status: "inProgress",
      ...(recoveryRunId ? { recoveredFromRunId: recoveryRunId } : {}),
    };
    child.turnActive = true;
    child.runId = runId;
    child.pauseRequested = false;
    child.safeToRetry = true;
    child.failureClass = null;
    try {
      await this.persistSessions();
      this.emit("event", { type: "user", sessionId: session.id, message: item });
      await writeLine(child.process.stdin, {
        type: "user",
        message: { role: "user", content: claudePrompt(normalizedText, normalizedAttachments) },
      });
    } catch (error) {
      child.turnActive = false;
      session.pendingTurn = {
        ...session.pendingTurn,
        status: "recoveryPending",
        recoveryReason: "delivery-unknown",
        recoveryAt: Date.now(),
        requiresConfirmation: true,
        error: "Claude 消息投递状态未知，需要确认后恢复",
      };
      await this.persistSessions();
      throw error;
    }
    return {
      accepted: true,
      sessionId: session.id,
      messageId: item.id,
      runId,
      status: "inProgress",
    };
  }

  async pauseTurn(id, { mode = "immediate" } = {}) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    if (!["after-turn", "immediate"].includes(mode)) throw runtimeError(400, "Claude 暂停模式无效");
    const child = this.children.get(session.id);
    const pending = session.pendingTurn;
    if (pending?.status === "paused") return { paused: true, status: "paused", session: publicSession(session, true, child) };
    if (!pending || !child?.turnActive) throw runtimeError(409, "Claude 当前没有正在执行的任务");
    pending.status = "pausing";
    pending.pauseMode = mode;
    pending.pauseRequestedAt = Date.now();
    pending.requiresConfirmation = false;
    child.pauseRequested = true;
    await this.cancelControlRequests(session.id, "Claude 任务正在暂停");
    await this.persistSessions();
    this.emit("event", { type: "session/updated", sessionId: session.id, session: publicSession(session, false, child) });
    if (mode === "immediate") child.process.kill("SIGINT");
    return { paused: false, status: "pausing", runId: child.runId || pending.runId, session: publicSession(session, true, child) };
  }

  async continueTurn(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    const pending = session.pendingTurn;
    if (!pending || pending.status !== "paused") {
      throw runtimeError(409, "Claude 当前没有可继续的暂停任务");
    }
    const child = await this.ensureChild(session);
    if (child.turnActive) throw runtimeError(409, "Claude 正在执行任务");
    const previousRunId = pending.runId;
    const runId = crypto.randomUUID();
    pending.status = "inProgress";
    pending.runId = runId;
    pending.lastActivityAt = Date.now();
    pending.resumedFromRunId = previousRunId;
    pending.pauseRequestedAt = pending.pauseRequestedAt || null;
    pending.pausedAt = pending.pausedAt || null;
    pending.error = null;
    child.turnActive = true;
    child.runId = runId;
    child.pauseRequested = false;
    child.safeToRetry = true;
    await this.persistSessions();
    this.upsertTranscript(session, {
      id: `resume:${runId}`,
      type: "system",
      subtype: "task_resumed",
      content: "Claude 任务已继续",
      status: "inProgress",
      at: Date.now(),
    });
    try {
      await writeLine(child.process.stdin, {
        type: "user",
        message: { role: "user", content: CLAUDE_CONTINUE_PROMPT },
      });
    } catch (error) {
      child.turnActive = false;
      session.pendingTurn = {
        ...pending,
        status: "recoveryPending",
        recoveryReason: "delivery-unknown",
        recoveryAt: Date.now(),
        requiresConfirmation: true,
        error: "Claude 继续消息投递状态未知，需要确认后恢复",
      };
      await this.persistSessions();
      throw error;
    }
    this.emit("event", { type: "session/updated", sessionId: session.id, session: publicSession(session, false, child) });
    return { continued: true, runId, resumedFromRunId: previousRunId, session: publicSession(session, true, child) };
  }

  async switchProvider(id, providerId = null, officialAccountId = null) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    if (this.childStarts.has(session.id)) {
      throw runtimeError(409, "Claude 正在启动任务，请先等待启动完成");
    }
    const normalized = normalizeProviderId(providerId);
    if (providerId !== null && providerId !== undefined && providerId !== "" && !normalized) {
      throw runtimeError(400, "Claude API 供应商 ID 无效");
    }
    const profile = normalized ? this.store.getProfile(normalized) : null;
    if (normalized && !profile) throw runtimeError(404, "Claude API 供应商不存在");
    const normalizedAccountId = normalized
      ? null
      : normalizeClaudeAccountId(officialAccountId)
        || this.officialAccounts?.activeId()
        || null;
    if (
      !normalized
      && officialAccountId !== null
      && officialAccountId !== undefined
      && officialAccountId !== ""
      && !normalizeClaudeAccountId(officialAccountId)
    ) {
      throw runtimeError(400, "Claude 官方账号 ID 无效");
    }
    const officialAccount = normalizedAccountId
      ? this.officialAccounts?.get(normalizedAccountId)
      : null;
    if (!normalized && this.officialAccounts && !officialAccount) {
      throw runtimeError(404, "Claude 官方账号不存在");
    }
    if (officialAccount && officialAccount.credentialStatus !== "valid") {
      throw runtimeError(409, "此 Claude 官方账号尚未登录或已失效，请先重新登录");
    }
    const child = this.children.get(session.id);
    if (child?.turnActive || ["inProgress", "stopping", "pausing", "retrying"].includes(session.pendingTurn?.status)) {
      throw runtimeError(409, "请先暂停 Claude 任务，再切换供应商");
    }
    if (
      session.providerId === normalized
      && (normalized || session.officialAccountId === normalizedAccountId)
    ) {
      return { changed: false, session: publicSession(session, true, child) };
    }
    const previous = session.providerId;
    const previousOfficialAccountId = session.officialAccountId || null;
    session.providerId = normalized;
    session.providerName = profile?.name || null;
    session.officialAccountId = normalizedAccountId;
    session.officialAccountName = officialAccountDisplayName(officialAccount);
    if (session.pendingTurn) {
      session.pendingTurn.providerBefore = previous;
      session.pendingTurn.providerAfter = normalized;
      session.pendingTurn.officialAccountBefore = previousOfficialAccountId;
      session.pendingTurn.officialAccountAfter = normalizedAccountId;
      session.pendingTurn.providerSwitchedAt = Date.now();
      session.pendingTurn.retryAttempts = 0;
      session.pendingTurn.nextRetryAt = null;
      session.pendingTurn.status = session.pendingTurn.status === "retryWaiting" ? "paused" : session.pendingTurn.status;
    }
    this.clearRetryTimer(session.id);
    if (child && !child.turnActive) {
      child.intentional = true;
      child.process?.kill("SIGTERM");
      this.children.delete(session.id);
    }
    await this.persistSessions();
    const result = publicSession(session, true);
    this.emit("event", { type: "session/updated", sessionId: session.id, session: result });
    return {
      changed: true,
      previousProviderId: previous,
      providerId: normalized,
      previousOfficialAccountId,
      officialAccountId: normalizedAccountId,
      session: result,
    };
  }

  async retryNow(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    const pending = session.pendingTurn;
    if (!pending || pending.status !== "retryWaiting") {
      throw runtimeError(409, "Claude 当前没有等待重试的任务");
    }
    this.clearRetryTimer(session.id);
    pending.nextRetryAt = Date.now();
    await this.persistSessions();
    this.scheduleRetry(session, pending, { immediate: true });
    return { accepted: true, status: "retrying", session: publicSession(session, true, this.children.get(session.id)) };
  }

  async interrupt(id) {
    const sessionId = String(id);
    const child = this.children.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (["paused", "retryWaiting"].includes(session?.pendingTurn?.status)) {
      this.clearRetryTimer(sessionId);
      this.upsertTranscript(session, {
        id: `interrupt:${session.pendingTurn.runId}`,
        type: "system",
        subtype: "task_interrupted",
        content: "Claude 任务已由用户终止",
        status: "interrupted",
        at: Date.now(),
      });
      session.pendingTurn = null;
      await this.persistSessions();
      child?.process?.kill("SIGTERM");
      this.children.delete(sessionId);
      const result = publicSession(session, true);
      this.emit("event", { type: "session/updated", sessionId, session: result });
      return { interrupted: true, runId: null, session: result };
    }
    if (!child?.process) return { interrupted: false };
    await this.cancelControlRequests(sessionId, "用户已终止当前任务");
    child.stopRequested = true;
    if (session?.pendingTurn) {
      session.pendingTurn = {
        ...session.pendingTurn,
        status: "stopping",
        stopRequestedAt: Date.now(),
      };
      await this.persistSessions();
      this.emit("event", {
        type: "session/updated",
        sessionId,
        session: publicSession(session, false, child),
      });
    }
    child.process.kill("SIGINT");
    return { interrupted: true, runId: child.runId || session?.pendingTurn?.runId || null };
  }

  async recoverTurn(id, { action, confirmation = null } = {}) {
    const session = this.sessions.get(String(id));
    if (!session) throw runtimeError(404, "Claude 对话不存在");
    const pending = session.pendingTurn;
    if (!pending || !["recoveryPending", "interrupted"].includes(pending.status)) {
      throw runtimeError(409, "当前 Claude 任务不需要恢复确认");
    }
    if (action === "dismiss") {
      this.upsertTranscript(session, {
        id: `recovery-dismissed:${pending.runId}`,
        type: "system",
        subtype: "recovery_interrupted",
        content: "未完成任务已由用户标记为中断",
        status: "interrupted",
        at: Date.now(),
      });
      session.pendingTurn = null;
      session.pendingApprovals = [];
      session.updatedAt = Date.now();
      await this.persistSessions();
      const result = publicSession(session, true);
      this.emit("event", { type: "session/updated", sessionId: session.id, session: result });
      this.emit("status", this.status());
      return { action, session: result };
    }
    if (pending.status !== "recoveryPending" || action !== "resume"
      || confirmation !== CLAUDE_RECOVERY_CONFIRMATION) {
      throw runtimeError(400, "继续未完成任务需要明确确认");
    }
    if (!session.nativeStarted || !isUuid(session.nativeSessionId || session.id)) {
      throw runtimeError(409, "Claude 原生会话尚未建立，不能安全自动恢复，请标记中断后重新发送");
    }
    const previous = { ...pending, status: "resuming", resumeRequestedAt: Date.now() };
    session.pendingTurn = previous;
    session.pendingApprovals = [];
    await this.persistSessions();
    try {
      const started = await this.sendMessage(
        session.id,
        CLAUDE_RECOVERY_PROMPT,
        [],
        {
          clientMessageId: `recovery-${pending.runId}`,
          recoveryRunId: pending.runId,
        },
      );
      return {
        action,
        recoveredFromRunId: pending.runId,
        ...started,
        session: publicSession(session, true, this.children.get(session.id)),
      };
    } catch (error) {
      if (session.pendingTurn?.status === "resuming") {
        session.pendingTurn = {
          ...pending,
          status: "recoveryPending",
          recoveryAt: Date.now(),
          error: "Claude 恢复启动失败，可再次确认重试",
        };
        await this.persistSessions();
      }
      throw error;
    }
  }

  async closeSession(id) {
    const sessionId = String(id);
    await this.cancelControlRequests(sessionId, "Claude 会话已关闭");
    await this.childStarts.get(sessionId)?.catch(() => {});
    const child = this.children.get(sessionId);
    child?.process.kill("SIGTERM");
    this.children.delete(sessionId);
    this.emit("status", this.status());
  }

  async createOfficialAccount({ label = null } = {}) {
    if (!this.officialAccounts) throw runtimeError(409, "当前运行时不支持 Claude 多账号");
    return {
      account: await this.officialAccounts.create({ label }),
      ...this.officialAccounts.snapshot(),
    };
  }

  async renameOfficialAccount(accountId, label) {
    if (!this.officialAccounts) throw runtimeError(409, "当前运行时不支持 Claude 多账号");
    const account = await this.officialAccounts.rename(accountId, label);
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.officialAccountId !== account.id) continue;
      session.officialAccountName = officialAccountDisplayName(account);
      changed = true;
    }
    if (changed) await this.persistSessions();
    return { account, ...this.officialAccounts.snapshot() };
  }

  officialAccountDeletePreview(accountId) {
    if (!this.officialAccounts) throw runtimeError(409, "当前运行时不支持 Claude 多账号");
    const account = this.officialAccounts.get(accountId);
    if (!account) throw runtimeError(404, "Claude 官方账号不存在");
    const sessions = [...this.sessions.values()]
      .filter((session) => session.officialAccountId === account.id)
      .map((session) => {
        const snapshot = publicSession(session, false, this.children.get(session.id));
        return {
          id: snapshot.id,
          name: snapshot.name,
          status: snapshot.status,
          archived: snapshot.archived,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_SESSIONS);
    const loginRunning = this.loginState?.accountId === account.id && Boolean(this.loginChild);
    const legacyLoginActive = account.legacy && account.credentialStatus === "valid";
    return {
      account: {
        id: account.id,
        label: account.label,
        email: account.email,
        credentialStatus: account.credentialStatus,
        active: account.active,
        legacy: account.legacy,
      },
      sessions,
      sessionCount: sessions.length,
      loginRunning,
      deletable: sessions.length === 0 && !loginRunning && !legacyLoginActive,
      reason: sessions.length
        ? "仍有 Claude 会话绑定此账号，请先删除或迁移这些会话"
        : loginRunning
          ? "此账号正在登录，请先完成或取消登录"
          : legacyLoginActive
            ? "原有共享账号必须先退出登录，才能安全删除账号槽"
            : null,
    };
  }

  async deleteOfficialAccount(accountId) {
    const preview = this.officialAccountDeletePreview(accountId);
    if (!preview.deletable) throw runtimeError(409, preview.reason || "Claude 官方账号当前不能删除");
    const result = await this.officialAccounts.remove(accountId);
    const router = this.officialProxyRouters.get(accountId);
    if (router) {
      await router.close();
      this.officialProxyRouters.delete(accountId);
    }
    this.emit("event", { type: "official/account-deleted", accountId });
    this.emit("status", this.status());
    return result;
  }

  async activateOfficialAccount(accountId) {
    if (!this.officialAccounts) throw runtimeError(409, "当前运行时不支持 Claude 多账号");
    this.assertProviderChangeIdle();
    const account = await this.officialAccounts.activate(accountId);
    return { account, ...this.officialAccounts.snapshot() };
  }

  async setOfficialAccountProxy(accountId, proxy, health = null) {
    if (!this.officialAccounts) throw runtimeError(409, "当前运行时不支持 Claude 多账号");
    this.assertProviderChangeIdle();
    const account = await this.officialAccounts.setProxy(accountId, proxy, health);
    await this.configureOfficialAccountProxy(account.id);
    this.scheduleOfficialProxyHealth();
    return { account, ...this.officialAccounts.snapshot() };
  }

  async recordOfficialAccountProxyHealth(accountId, health) {
    if (!this.officialAccounts) throw runtimeError(409, "当前运行时不支持 Claude 多账号");
    const account = await this.officialAccounts.recordProxyHealth(accountId, health);
    return { account, ...this.officialAccounts.snapshot() };
  }

  scheduleOfficialProxyHealth(delayMs = this.officialProxyHealthIntervalMs) {
    clearTimeout(this.officialProxyHealthTimer);
    this.officialProxyHealthTimer = null;
    if (
      this.destroyed
      || !this.officialProxyHealthCheck
      || !this.officialAccounts?.snapshot().accounts.some((account) => account.proxy?.configured)
    ) return;
    this.officialProxyHealthTimer = setTimeout(() => {
      this.officialProxyHealthTimer = null;
      void this.refreshOfficialProxyHealth().catch((error) => {
        this.emit("log", { level: "warn", message: claudeLogFailure("官方账号代理健康检查", error) });
      });
    }, Math.max(1_000, Number(delayMs) || this.officialProxyHealthIntervalMs));
    this.officialProxyHealthTimer.unref?.();
  }

  async refreshOfficialProxyHealth({ accountId = null, force = false } = {}) {
    if (!this.officialAccounts || !this.officialProxyHealthCheck) {
      return this.officialAccountsSnapshot();
    }
    if (this.officialProxyHealthRunning) return this.officialAccountsSnapshot();
    this.officialProxyHealthRunning = true;
    try {
      const requestedId = accountId ? normalizeClaudeAccountId(accountId) : null;
      if (accountId && !requestedId) throw runtimeError(400, "Claude 官方账号 ID 无效");
      const accounts = this.officialAccounts.snapshot().accounts
        .filter((account) => account.proxy?.configured && (!requestedId || account.id === requestedId));
      if (requestedId && !accounts.length) {
        this.officialAccounts.requireAccount(requestedId);
        throw runtimeError(409, "此 Claude 官方账号尚未配置代理");
      }
      for (const account of accounts) {
        const checkedAt = Number(account.proxy?.health?.checkedAt);
        if (
          !force
          && Number.isFinite(checkedAt)
          && Date.now() - checkedAt < this.officialProxyHealthIntervalMs
        ) continue;
        const proxy = this.officialAccounts.privateProxy(account.id);
        let health;
        try {
          health = await this.officialProxyHealthCheck(proxy);
        } catch (error) {
          health = failedClaudeOfficialProxyHealth(error);
        }
        await this.officialAccounts.recordProxyHealth(account.id, health);
        this.emit("event", { type: "official/proxy-health-updated", accountId: account.id });
      }
      return this.officialAccountsSnapshot();
    } finally {
      this.officialProxyHealthRunning = false;
      this.scheduleOfficialProxyHealth();
    }
  }

  async runOfficialAuthStatus({ accountId = null, configDirectory = null } = {}) {
    const normalizedAccountId = normalizeClaudeAccountId(accountId);
    const result = await runCommand(
      this.command,
      ["auth", "status", "--json"],
      this.spawnOptions({
        cwd: this.user.projectRoot,
        officialAccountId: normalizedAccountId,
        configDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    try {
      const parsed = JSON.parse(result.stdout);
      return { ...sanitizeAuthStatus(parsed), statusKnown: true };
    } catch {
      return {
        loggedIn: false,
        authMethod: null,
        email: null,
        subscriptionType: null,
        statusKnown: false,
        error: result.code === null
          ? "Claude 官方账号状态查询超时或无法启动"
          : "Claude 官方账号状态无法确认",
      };
    }
  }

  async startOfficialLogin(accountId = null) {
    let targetAccountId = normalizeClaudeAccountId(accountId);
    if (this.officialAccounts) {
      if (accountId && !targetAccountId) throw runtimeError(400, "Claude 官方账号 ID 无效");
      if (!targetAccountId) targetAccountId = this.officialAccounts.activeId();
      if (!targetAccountId) {
        const account = await this.officialAccounts.create();
        targetAccountId = account.id;
      }
      this.officialAccounts.requireAccount(targetAccountId);
      await this.configureOfficialAccountProxy(targetAccountId);
    }
    if (this.loginChild) {
      if ((this.loginState?.accountId || null) !== (targetAccountId || null)) {
        throw runtimeError(409, "另一个 Claude 官方账号正在登录，请先完成或取消");
      }
      if (!this.loginState?.authorizationUrl) await this.waitForOfficialLoginUrl();
      return privateLoginState(this.loginState, true);
    }
    const child = spawn(this.command, ["auth", "login", "--claudeai"], this.spawnOptions({
      cwd: this.user.projectRoot,
      officialAccountId: targetAccountId,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    this.loginChild = child;
    this.loginState = {
      loginId: crypto.randomUUID(),
      accountId: targetAccountId,
      authorizationUrl: null,
      requiresCode: false,
      codeSubmitted: false,
      expiresAt: Date.now() + DEFAULT_OFFICIAL_LOGIN_TTL_MS,
    };
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-8_000);
      this.loginState = {
        ...this.loginState,
        authorizationUrl: extractAuthorizationUrl(output) || this.loginState?.authorizationUrl || null,
        requiresCode: /paste code/i.test(output),
      };
      this.emit("event", { type: "auth/login-output" });
      this.emit("status", this.status());
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let finishing = false;
    const finish = async (processSuccess, code, signal, error = null) => {
      if (finishing) return;
      if (this.loginChild !== child) return;
      finishing = true;
      clearTimeout(this.loginTimer);
      this.loginTimer = null;
      let success = false;
      let status = null;
      if (processSuccess) {
        status = await this.runOfficialAuthStatus({
          accountId: targetAccountId,
        }).catch(() => null);
        success = status?.loggedIn === true;
        if (targetAccountId && status) {
          await this.officialAccounts?.recordStatus(targetAccountId, status, {
            markInvalid: status.statusKnown === true,
          }).catch(() => {});
        }
      }
      if (this.loginChild !== child) return;
      this.loginChild = null;
      this.loginState = null;
      if (error) {
        this.emit("event", {
          type: "auth/login-error",
          message: "Claude 官方登录进程异常，原始诊断已隐藏",
        });
      }
      else if (processSuccess && !success) {
        this.emit("event", { type: "auth/login-error", message: "Claude CLI 已退出，但服务器账号状态尚未登录" });
      }
      this.emit("event", {
        type: "auth/login-completed",
        success,
        code,
        signal,
        accountId: targetAccountId,
      });
      this.emit("status", this.status());
    };
    child.on("error", (error) => void finish(false, null, null, error));
    child.on("exit", (code, signal) => void finish(code === 0, code, signal));
    this.loginTimer = setTimeout(() => {
      if (this.loginChild !== child) return;
      this.emit("event", { type: "auth/login-error", message: "Claude 官方登录已超时" });
      child.kill("SIGTERM");
    }, DEFAULT_OFFICIAL_LOGIN_TTL_MS);
    this.loginTimer.unref?.();
    this.emit("status", this.status());
    await this.waitForOfficialLoginUrl();
    return privateLoginState(this.loginState, Boolean(this.loginChild));
  }

  async waitForOfficialLoginUrl(timeoutMs = OFFICIAL_LOGIN_URL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.loginChild && Date.now() < deadline) {
      if (this.loginState?.authorizationUrl) return this.loginState.authorizationUrl;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.loginChild) throw runtimeError(502, "Claude 官方登录进程已退出");
    await this.cancelOfficialLogin();
    throw runtimeError(504, "等待 Claude 官方授权页面超时");
  }

  async cancelOfficialLogin(loginId = null) {
    if (!this.loginChild) return { cancelled: false };
    if (loginId && this.loginState?.loginId !== String(loginId)) return { cancelled: false };
    this.loginChild.kill("SIGTERM");
    return { cancelled: true };
  }

  async submitOfficialLogin(code) {
    const normalized = typeof code === "string" ? code.trim() : "";
    if (!this.loginChild?.stdin?.writable) throw runtimeError(409, "Claude 官方登录当前不等待授权码");
    if (!normalized || normalized.length > 4_096 || /[\r\n]/.test(normalized)) {
      throw runtimeError(400, "Claude 授权码无效");
    }
    await new Promise((resolve, reject) => {
      this.loginChild.stdin.write(`${normalized}\n`, (error) => error ? reject(error) : resolve());
    });
    this.loginState = { ...this.loginState, codeSubmitted: true };
    this.emit("status", this.status());
    return { accepted: true };
  }

  async officialStatus(accountId = null) {
    if (!this.officialAccounts) return this.runOfficialAuthStatus();
    const requestedId = accountId == null || accountId === ""
      ? this.officialAccounts.activeId()
      : normalizeClaudeAccountId(accountId);
    if (accountId && !requestedId) throw runtimeError(400, "Claude 官方账号 ID 无效");
    if (!requestedId) {
      return {
        loggedIn: false,
        statusKnown: true,
        activeId: null,
        accounts: [],
        account: null,
      };
    }
    this.officialAccounts.requireAccount(requestedId);
    const status = await this.runOfficialAuthStatus({ accountId: requestedId });
    const account = await this.officialAccounts.recordStatus(requestedId, status, {
      markInvalid: status.statusKnown === true,
    });
    const snapshot = this.officialAccounts.snapshot();
    return {
      ...status,
      account,
      activeId: snapshot.activeId,
      accounts: snapshot.accounts,
    };
  }

  async logoutOfficial(accountId = null) {
    const targetAccountId = this.officialAccounts
      ? normalizeClaudeAccountId(accountId) || this.officialAccounts.activeId()
      : null;
    if (this.officialAccounts && accountId && !normalizeClaudeAccountId(accountId)) {
      throw runtimeError(400, "Claude 官方账号 ID 无效");
    }
    if (this.officialAccounts && !targetAccountId) throw runtimeError(404, "Claude 官方账号不存在");
    if (targetAccountId) this.officialAccounts.requireAccount(targetAccountId);
    const result = await runCommand(
      this.command,
      ["auth", "logout"],
      this.spawnOptions({
        cwd: this.user.projectRoot,
        officialAccountId: targetAccountId,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (result.code !== 0) throw runtimeError(502, "Claude 官方账号退出失败");
    if (targetAccountId) {
      await this.officialAccounts.markInvalid(targetAccountId, "logged-out");
      const snapshot = this.officialAccounts.snapshot();
      return {
        loggedIn: false,
        statusKnown: true,
        account: this.officialAccounts.get(targetAccountId),
        activeId: snapshot.activeId,
        accounts: snapshot.accounts,
      };
    }
    return this.officialStatus();
  }

  async destroy() {
    this.destroyed = true;
    clearTimeout(this.officialProxyHealthTimer);
    this.officialProxyHealthTimer = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.allSettled(this.childStarts.values());
    this.childStarts.clear();
    await Promise.all([...this.children.keys()].map((sessionId) =>
      this.cancelControlRequests(sessionId, "Claude 运行时正在关闭")));
    for (const child of this.children.values()) child.process.kill("SIGTERM");
    this.children.clear();
    this.loginChild?.kill("SIGTERM");
    this.loginChild = null;
    this.loginState = null;
    clearTimeout(this.loginTimer);
    this.loginTimer = null;
    this.projectPurgePreviews.clear();
    this.pluginTagPreviews.clear();
    clearTimeout(this.ultraReviewPersistTimer);
    this.ultraReviewPersistTimer = null;
    for (const state of this.ultraReviewChildren.values()) {
      state.cancelled = false;
      state.child?.kill("SIGTERM");
    }
    this.ultraReviewChildren.clear();
    await this.backgroundAgents?.destroy();
    await Promise.all([...this.officialProxyRouters.values()].map((router) => router.close()));
    this.officialProxyRouters.clear();
    await Promise.all([
      this.persistQueue,
      this.mcpConfigQueue,
      this.extensionConfigQueue,
      this.ultraReviewPersistQueue,
    ]);
  }

  async enforcePermissions({
    runtimeAllowed = true,
    backgroundAllowed = true,
    extensionsAllowed = true,
    mcpAllowed = true,
    remoteDiffAllowed = true,
    structuredOutputAllowed = true,
    ultraReviewAllowed = true,
    betaHeadersAllowed = true,
  } = {}) {
    this.runtimeAllowed = runtimeAllowed === true;
    if (!runtimeAllowed) {
      let sessionsChanged = false;
      for (const session of this.sessions.values()) {
        this.clearRetryTimer(session.id);
        const child = this.children.get(session.id);
        if (child?.turnActive) {
          let paused = false;
          try {
            await this.pauseTurn(session.id, { mode: "after-turn" });
            paused = true;
          } catch (error) {
            this.emit("log", { level: "warn", message: claudeLogFailure("Claude 权限撤销", error) });
          }
          if (!paused) {
            child.stopRequested = true;
            child.intentional = true;
            child.process?.kill("SIGINT");
          }
          continue;
        }
        if (["retryWaiting", "retrying", "pausing"].includes(session.pendingTurn?.status)) {
          session.pendingTurn = {
            ...session.pendingTurn,
            status: "paused",
            pauseMode: "permission-revoked",
            pausedAt: Date.now(),
            nextRetryAt: null,
            requiresConfirmation: false,
            error: "Claude 使用权限已撤销，任务已安全暂停",
          };
          sessionsChanged = true;
        }
        await this.cancelControlRequests(session.id, "Claude 使用权限已撤销");
        if (child) {
          child.intentional = true;
          child.process?.kill("SIGTERM");
          this.children.delete(session.id);
        }
      }
      if (sessionsChanged) await this.persistSessions();
    }
    const deniedSessionCapabilities = (session) => {
      const denied = [];
      if (
        !extensionsAllowed
        && !session.safeMode
        && (
          session.agent
          || session.inlineAgentNames.length
          || session.pluginDirectories.length
          || session.pluginUrls.length
        )
      ) denied.push("Claude 扩展");
      if (
        !mcpAllowed
        && !session.safeMode
        && (session.strictMcpConfig || session.mcpServerNames.length)
      ) denied.push("Claude MCP");
      if (!remoteDiffAllowed && session.fromPr) denied.push("远程 Pull Request");
      if (!structuredOutputAllowed && session.jsonSchema) denied.push("结构化输出");
      if (!betaHeadersAllowed && session.betaHeaders.length) denied.push("Anthropic Beta Header");
      return denied;
    };
    if (runtimeAllowed) {
      let sessionsChanged = false;
      for (const session of this.sessions.values()) {
        const denied = deniedSessionCapabilities(session);
        if (!denied.length) continue;
        const message = `${denied.join("、")}权限已撤销，任务已在安全边界暂停`;
        this.clearRetryTimer(session.id);
        const child = this.children.get(session.id);
        if (child?.turnActive) {
          try {
            await this.pauseTurn(session.id, { mode: "after-turn" });
          } catch (error) {
            this.emit("log", { level: "warn", message: claudeLogFailure("Claude 能力权限撤销", error) });
            child.stopRequested = true;
            child.intentional = true;
            child.process?.kill("SIGINT");
          }
          continue;
        }
        if (["retryWaiting", "retrying", "pausing"].includes(session.pendingTurn?.status)) {
          session.pendingTurn = {
            ...session.pendingTurn,
            status: "paused",
            pauseMode: "permission-revoked",
            pausedAt: Date.now(),
            nextRetryAt: null,
            requiresConfirmation: false,
            error: message,
          };
          sessionsChanged = true;
        }
        await this.cancelControlRequests(session.id, message);
        if (child) {
          child.intentional = true;
          child.process?.kill("SIGTERM");
          this.children.delete(session.id);
        }
      }
      if (sessionsChanged) await this.persistSessions();
    }
    if (!ultraReviewAllowed) {
      for (const id of [...this.ultraReviewChildren.keys()]) {
        await this.cancelUltraReview(id).catch((error) => {
          this.emit("log", { level: "warn", message: claudeLogFailure("Ultra Review 权限撤销", error) });
        });
      }
    }
    if (!runtimeAllowed || !backgroundAllowed) {
      for (const id of this.backgroundAgents?.ids?.() || []) {
        await this.backgroundAgents.stop(id).catch((error) => {
          this.emit("log", { level: "warn", message: claudeLogFailure("Claude 后台权限撤销", error) });
        });
      }
    }
    this.emit("status", this.status());
  }

  async ensureChild(session) {
    const existing = this.children.get(session.id);
    if (existing?.process?.stdin?.writable) return existing;
    const pending = this.childStarts.get(session.id);
    if (pending) return pending;
    const starting = this.startChild(session);
    this.childStarts.set(session.id, starting);
    try {
      return await starting;
    } finally {
      if (this.childStarts.get(session.id) === starting) this.childStarts.delete(session.id);
    }
  }

  async startChild(session) {
    const existing = this.children.get(session.id);
    if (existing?.process?.stdin?.writable) return existing;
    const profile = session.providerId ? this.store.getProfile(session.providerId) : null;
    if (session.providerId && !profile) {
      throw runtimeError(409, "此 Claude 对话绑定的 API 供应商已不存在，请先切换供应商");
    }
    const officialAccount = !profile && this.officialAccounts
      ? this.officialAccounts.get(session.officialAccountId)
      : null;
    if (!profile && this.officialAccounts && !officialAccount) {
      throw runtimeError(409, "此 Claude 对话尚未绑定官方账号，请先登录或切换账号");
    }
    if (officialAccount && officialAccount.credentialStatus !== "valid") {
      throw runtimeError(409, "此 Claude 官方账号尚未登录或已失效，请重新登录或切换账号");
    }
    if (session.noSessionPersistence && session.nativeStarted) {
      throw runtimeError(409, "临时 Claude 对话的原生进程已结束，无法恢复；请新建对话");
    }
    if (session.betaHeaders.length && !profile) {
      throw runtimeError(409, "Anthropic Beta Header 仅支持 API Key 供应商");
    }
    let sessionPluginPaths = [];
    if (!session.safeMode) {
      const localPluginPaths = await resolveClaudePluginDirectories(session.pluginDirectories, {
        cwd: session.cwd,
        projectRoot: this.user.projectRoot,
      });
      const downloadedPluginPaths = await materializeClaudePluginUrls(session.pluginUrls, {
        directory: this.sessionPluginDirectory(session.id),
        uid: this.user.legacy === false ? this.user.uid : null,
        gid: this.user.legacy === false ? this.user.gid : null,
        downloader: this.pluginUrlDownloader || undefined,
      });
      sessionPluginPaths = [...localPluginPaths, ...downloadedPluginPaths];
    }
    const memory = await this.readMemory(session.cwd);
    const hooks = await this.readHooks(session.cwd);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--prompt-suggestions", "true",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", session.permissionMode || DEFAULT_PERMISSION_MODE,
      "--model", session.model || profile?.model || DEFAULT_MODEL,
    ];
    const resumeId = session.pendingForkNativeId
      || (session.nativeStarted ? (session.nativeSessionId || session.id) : null);
    if (resumeId) {
      args.push("--resume", resumeId);
      if (session.pendingForkNativeId) args.push("--fork-session");
    } else if (session.fromPr) {
      args.push("--from-pr", session.fromPr);
    } else {
      args.push("--session-id", session.nativeSessionId || session.id);
    }
    if (!resumeId && session.remoteFiles.length) {
      await assertRemoteFileTargets(session.cwd, session.remoteFiles);
      args.push("--file", ...session.remoteFiles.map(remoteFileSpec));
    }
    if (session.effort) args.push("--effort", session.effort);
    if (session.fallbackModel) args.push("--fallback-model", session.fallbackModel);
    if (session.maxBudgetUsd !== null && session.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(session.maxBudgetUsd));
    }
    if (session.allowedTools.length) args.push("--allowed-tools", session.allowedTools.join(","));
    if (session.disallowedTools.length) args.push("--disallowed-tools", session.disallowedTools.join(","));
    if (session.agent) args.push("--agent", session.agent);
    if (session.brief) args.push("--brief");
    if (session.autocompact) args.push("--autocompact", String(session.autocompact));
    if (session.inlineAgentNames.length && !session.safeMode) {
      args.push("--agents", await this.inlineAgentsJson(session.inlineAgentNames));
    }
    if (session.permissionMode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
    if (session.systemPrompt) args.push("--system-prompt", session.systemPrompt);
    if (session.excludeDynamicSystemPromptSections && !session.systemPrompt) {
      args.push("--exclude-dynamic-system-prompt-sections");
    }
    if (session.settingSources.length) args.push("--setting-sources", session.settingSources.join(","));
    if (session.safeMode) args.push("--safe-mode");
    if (session.noSessionPersistence) args.push("--no-session-persistence");
    if (session.jsonSchema) args.push("--json-schema", session.jsonSchema);
    for (const pluginPath of sessionPluginPaths) args.push("--plugin-dir", pluginPath);
    if (session.betaHeaders.length) args.push("--betas", ...session.betaHeaders);
    if (session.strictMcpConfig && !session.safeMode) {
      args.push(
        "--mcp-config",
        await this.writeSessionMcpConfig(session),
        "--strict-mcp-config",
      );
    }
    if (memory.text && !session.safeMode) {
      args.push(
        "--append-system-prompt",
        `Project Memory (server-managed, read-only context):\n${memory.text}`,
      );
    }
    if (hooks.configured && !session.safeMode) {
      args.push("--settings", this.hooksPath(hooks.cwd), "--include-hook-events");
    }
    for (const directory of session.additionalDirectories) args.push("--add-dir", directory);
    if (!resumeId && session.workspaceMode === "worktree") {
      args.push("--worktree");
      if (session.worktreeName) args.push(session.worktreeName);
    }
    if (this.destroyed) throw runtimeError(503, "Claude 运行时正在关闭");
    if (this.sessions.get(session.id) !== session) throw runtimeError(404, "Claude 对话不存在");
    const child = spawn(this.command, args, this.spawnOptions({
      cwd: session.cwd,
      profile,
      officialAccountId: officialAccount?.id || null,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const state = {
      process: child,
      connected: true,
      buffer: "",
      turnActive: false,
      runId: null,
      lastActivityPersistAt: 0,
      intentional: false,
      stopRequested: false,
      streamMessageId: null,
      streamBlocks: new Map(),
      initializeRequestId: `wfl-init-${crypto.randomUUID()}`,
      initializeReady: null,
      initializeResolve: null,
      initializeReject: null,
      outboundControlRequests: new Map(),
      pauseRequested: false,
      safeToRetry: true,
      failureClass: null,
      eventQueue: Promise.resolve(),
    };
    state.initializeReady = new Promise((resolve, reject) => {
      state.initializeResolve = resolve;
      state.initializeReject = reject;
    });
    state.initializeReady.catch(() => {});
    this.children.set(session.id, state);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consumeOutput(session, state, chunk));
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.byteLength(chunk);
      const failure = classifyClaudeFailure({ message: chunk });
      if (failure.class !== "unknown") state.failureClass = failure.class;
      if (bytes) this.emit("log", {
        level: "error",
        message: `Claude 运行时返回了 ${bytes} 字节错误诊断，原始内容已隐藏`,
      });
    });
    child.on("error", (error) => void this.queueChildExit(session, state, {
      kind: "spawn-error",
      code: error?.code || null,
    }));
    child.on("exit", (code, signal) => void this.queueChildExit(session, state, {
      kind: "exit",
      code,
      signal,
    }));
    try {
      await writeLine(child.stdin, {
        type: "control_request",
        request_id: state.initializeRequestId,
        request: {
          subtype: "initialize",
          promptSuggestions: true,
          forwardSubagentText: true,
          supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
        },
      });
    } catch (error) {
      state.intentional = true;
      child.kill("SIGTERM");
      this.children.delete(session.id);
      throw error;
    }
    this.emit("status", this.status());
    return state;
  }

  consumeOutput(session, state, chunk) {
    state.buffer += chunk;
    let newline = state.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (line) this.queueChildEvent(session, state, line);
      newline = state.buffer.indexOf("\n");
    }
  }

  queueChildEvent(session, state, line) {
    const operation = state.eventQueue.then(
      () => this.consumeEvent(session, state, line),
      () => this.consumeEvent(session, state, line),
    );
    state.eventQueue = operation.catch((error) => {
      this.emit("log", {
        level: "error",
        message: claudeLogFailure("Claude 事件处理", error),
      });
    });
    return operation;
  }

  async queueChildExit(session, state, details = {}) {
    const tail = state.buffer.trim();
    state.buffer = "";
    if (tail) this.queueChildEvent(session, state, tail);
    await state.eventQueue;
    await this.childExit(session, state, details);
  }

  async consumeEvent(session, state, line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit("log", {
        level: "error",
        message: `Claude 返回了无法解析的 JSON 事件（${Buffer.byteLength(line)} 字节，内容已隐藏）`,
      });
      return;
    }
    if (!claudeReviewedTopLevelEvent(event?.type)) {
      this.recordUnreviewedProtocolEvent(session, {
        surface: "top-level",
        type: event?.type,
        subtype: event?.subtype,
      });
      return;
    }
    if (event.type === "system" && !claudeReviewedSystemEvent(event.subtype)) {
      this.recordUnreviewedProtocolEvent(session, {
        surface: "system",
        type: event.type,
        subtype: event.subtype,
      });
      return;
    }
    if (event.type === "stream_event" && !claudeReviewedStreamEvent(event.event?.type)) {
      this.recordUnreviewedProtocolEvent(session, {
        surface: "stream",
        type: event.type,
        subtype: event.event?.type,
      });
      return;
    }
    if (event.type === "control_request") {
      this.registerControlRequest(session, state, event);
      return;
    }
    if (event.type === "control_cancel_request") {
      this.cancelControlRequest(session.id, event.request_id, "Claude 已取消请求", false);
      return;
    }
    if (event.type === "control_response") {
      this.consumeControlResponse(session, state, event);
      return;
    }
    this.touchPendingTurn(session, state);
    if (event.type === "rate_limit_event") {
      await this.recordOfficialRateLimitEvent(session, event);
      return;
    }
    if (
      event.type === "assistant"
      && Array.isArray(event.message?.content)
      && event.message.content.some((block) => block?.type === "tool_use")
    ) {
      state.safeToRetry = false;
    }
    if (
      event.type === "user"
      && Array.isArray(event.message?.content)
      && event.message.content.some((block) => block?.type === "tool_result")
    ) {
      state.safeToRetry = false;
    }
    const payload = { sessionId: session.id, event };
    const taskEventType = claudeTaskEventType(event);
    if (event.type === "system" && event.subtype === "init") this.recordNativeInit(session, event);
    else if (taskEventType) this.recordTaskEvent(session, event, taskEventType);
    else if (event.type === "system" && !["status"].includes(event.subtype)) this.recordSystemEvent(session, event);
    if (typeof event.type === "string" && event.type.startsWith("hook_")) this.recordHookEvent(session, event);
    if (event.type === "stream_event") this.recordStreamEvent(session, state, event.event);
    if (event.type === "assistant" && event.message) this.recordAssistantEvent(session, event);
    if (event.type === "user" && event.message) {
      this.recordNativeUserEvent(session, event);
      this.recordToolResults(session, event);
    }
    if (event.type === "prompt_suggestion" && typeof event.suggestion === "string") {
      session.suggestion = event.suggestion.slice(0, 2_000);
      void this.persistSessions();
      this.emit("event", { type: "session/updated", sessionId: session.id, session: publicSession(session) });
    }
    if (event.type === "result") {
      const runId = session.pendingTurn?.runId || state.runId || null;
      const pauseRequested = state.pauseRequested || session.pendingTurn?.status === "pausing";
      const stopRequested = state.stopRequested || session.pendingTurn?.status === "stopping";
      const resultFailure = event.is_error === true || event.isError === true
        ? classifyClaudeFailure({
          subtype: event.subtype,
          error: event.error || event.result,
          failureClass: state.failureClass,
          retryAfterMs: event.retry_after_ms || event.retryAfterMs || event.retry_after,
        })
        : null;
      state.turnActive = false;
      state.runId = null;
      session.pendingApprovals = [];
      const result = sanitizeResult(event);
      session.lastResult = result;
      this.upsertTranscript(session, {
        id: typeof event.uuid === "string" ? event.uuid : crypto.randomUUID(),
        type: "result",
        status: result.isError ? "failed" : "completed",
        ...result,
        at: Date.now(),
      });
      if (stopRequested && session.pendingTurn) {
        session.pendingTurn = {
          ...session.pendingTurn,
          status: "interrupted",
          interruptedAt: Date.now(),
          recoveryAt: undefined,
          recoveryReason: "user-interrupt",
          requiresConfirmation: false,
          error: "用户已终止 Claude 任务",
        };
        state.stopRequested = false;
        this.upsertTranscript(session, {
          id: `interrupt:${runId || crypto.randomUUID()}`,
          type: "system",
          subtype: "task_interrupted",
          content: "Claude 任务已由用户终止",
          status: "interrupted",
          at: Date.now(),
        });
      } else if (pauseRequested && session.pendingTurn) {
        session.pendingTurn = {
          ...session.pendingTurn,
          status: "paused",
          pauseMode: session.pendingTurn.pauseMode || "immediate",
          pausedAt: Date.now(),
          lastActivityAt: Date.now(),
          requiresConfirmation: false,
          error: "Claude 任务已暂停，点击“继续”恢复",
        };
        state.pauseRequested = false;
        this.upsertTranscript(session, {
          id: `pause:${runId || crypto.randomUUID()}`,
          type: "system",
          subtype: "task_paused",
          content: "Claude 任务已暂停",
          status: "paused",
          at: Date.now(),
        });
      } else if (resultFailure && session.pendingTurn) {
        await this.handleRetryableFailure(session, state, resultFailure, "result");
      } else {
        session.pendingTurn = null;
      }
      const terminalTaskStatus = stopRequested
        ? "interrupted"
        : resultFailure
          ? "failed"
          : "completed";
      for (const task of session.messages.filter((item) =>
        item.type === "task" && item.status === "inProgress")) {
        this.upsertTranscript(session, {
          ...task,
          status: terminalTaskStatus,
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await this.persistSessions();
      const currentSession = publicSession(session, false, state);
      this.emit("event", {
        type: "result",
        sessionId: session.id,
        runId,
        result,
        session: currentSession,
      });
      this.emit("event", {
        type: "session/updated",
        sessionId: session.id,
        session: currentSession,
      });
      this.emit("status", this.status());
    }
    this.emit("event", payload);
  }

  async recordOfficialRateLimitEvent(session, event) {
    if (!this.officialAccounts || session.providerId || !session.officialAccountId) return;
    const sample = officialQuotaSample(event?.rate_limit_info);
    if (!sample) return;
    try {
      const account = await this.officialAccounts.recordQuota(session.officialAccountId, sample);
      this.emit("event", {
        type: "official/quota-updated",
        accountId: account.id,
      });
      this.emit("status", this.status());
    } catch (error) {
      this.emit("log", {
        level: "warn",
        message: claudeLogFailure("Claude 官方额度同步", error),
      });
    }
  }

  touchPendingTurn(session, state) {
    if (!state.turnActive || !session.pendingTurn || session.pendingTurn.status !== "inProgress") return;
    const now = Date.now();
    session.pendingTurn.lastActivityAt = now;
    if (now - Number(state.lastActivityPersistAt || 0) < 2_000) return;
    state.lastActivityPersistAt = now;
    void this.persistSessions();
  }

  clearRetryTimer(sessionId) {
    const timer = this.retryTimers.get(String(sessionId));
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(String(sessionId));
  }

  retryDelay(attempt) {
    const delays = CLAUDE_RETRY_DELAYS_MS[this.taskSettings.retryFrequency]
      || CLAUDE_RETRY_DELAYS_MS.balanced;
    const index = Math.min(delays.length - 1, Math.max(0, Number(attempt || 1) - 1));
    const base = delays[index];
    const sample = Math.random();
    return Math.max(1_000, Math.round(base * (0.9 + Math.min(1, Math.max(0, sample)) * 0.2)));
  }

  retryAllowed(attempt) {
    return this.taskSettings.unlimitedRetry === true
      || Number(attempt || 0) <= this.taskSettings.maxRetries;
  }

  scheduleRetry(session, pending, { immediate = false } = {}) {
    if (!this.runtimeAllowed) return;
    if (!session || !pending || !["retryWaiting", "retrying"].includes(pending.status)) return;
    this.clearRetryTimer(session.id);
    const delay = immediate
      ? 0
      : Math.max(0, Number(pending.nextRetryAt || 0) - Date.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(session.id);
      void this.runRetry(session.id, pending.runId).catch((error) => {
        this.emit("log", { level: "error", message: claudeLogFailure("Claude 自动重试", error) });
        const current = this.sessions.get(session.id);
        if (current?.pendingTurn?.runId !== pending.runId) return;
        current.pendingTurn = {
          ...current.pendingTurn,
          status: "recoveryPending",
          recoveryReason: "process-exit",
          recoveryAt: Date.now(),
          requiresConfirmation: true,
          nextRetryAt: null,
          error: "Claude 重试启动失败，请确认后恢复",
        };
        void this.persistSessions();
        this.emit("event", {
          type: "retry/stopped",
          sessionId: session.id,
          runId: pending.runId,
          message: "Claude 重试启动失败，请确认后恢复",
          session: publicSession(current, false),
        });
      });
    }, delay);
    timer.unref?.();
    this.retryTimers.set(session.id, timer);
  }

  async runRetry(sessionId, runId) {
    if (!this.runtimeAllowed) return;
    const session = this.sessions.get(String(sessionId));
    const pending = session?.pendingTurn;
    if (!session || !pending || pending.runId !== runId || pending.status !== "retryWaiting") return;
    const child = await this.ensureChild(session);
    if (child.turnActive) return;
    pending.status = "retrying";
    pending.lastActivityAt = Date.now();
    pending.nextRetryAt = null;
    child.turnActive = true;
    child.runId = runId;
    child.pauseRequested = false;
    child.safeToRetry = true;
    await this.persistSessions();
    this.emit("event", { type: "session/updated", sessionId: session.id, session: publicSession(session, false, child) });
    try {
      await writeLine(child.process.stdin, {
        type: "user",
        message: { role: "user", content: CLAUDE_RETRY_PROMPT },
      });
    } catch (error) {
      child.turnActive = false;
      const failure = classifyClaudeFailure({ message: error.message, code: error.code });
      await this.handleRetryableFailure(session, child, failure, "retry-delivery");
    }
  }

  async handleRetryableFailure(session, state, failure, reason = "provider") {
    const pending = session.pendingTurn;
    if (!pending) return false;
    if (!this.runtimeAllowed) {
      this.clearRetryTimer(session.id);
      pending.status = "interrupted";
      pending.interruptedAt = Date.now();
      pending.recoveryReason = "user-interrupt";
      pending.requiresConfirmation = false;
      pending.nextRetryAt = null;
      pending.error = "Claude 使用权限已撤销，任务已停止";
      await this.persistSessions();
      return false;
    }
    const normalized = failure || { class: "unknown", retryable: false, safeToRetry: false };
    const sideEffectSafe = state.safeToRetry !== false;
    const safeToRetry = sideEffectSafe && normalized.safeToRetry === true;
    const nextAttempt = Math.min(1_000_000, (pending.retryAttempts || 0) + 1);
    if (!normalized.retryable || !safeToRetry || !this.retryAllowed(nextAttempt)) {
      pending.status = "recoveryPending";
      pending.recoveryReason = !sideEffectSafe
        ? "unsafe-retry"
        : normalized.retryable
          ? "retry-exhausted"
          : "process-exit";
      pending.recoveryAt = Date.now();
      pending.requiresConfirmation = true;
      pending.retryReason = normalized.class === "auth" ? "auth" : normalized.class;
      pending.retryClass = normalized.class;
      pending.error = normalized.class === "auth"
        ? "Claude 账号或 API 凭据无效，请检查后再继续"
        : normalized.class === "quota"
          ? "Claude 账号或 API 额度不足，请切换账号或供应商"
          : !safeToRetry
            ? "任务已经执行过可能有副作用的操作，需要确认后恢复"
            : "Claude 暂时不可用，自动重试已停止，请确认后恢复";
      pending.nextRetryAt = null;
      await this.persistSessions();
      this.emit("event", {
        type: "retry/stopped",
        sessionId: session.id,
        runId: pending.runId,
        reason: pending.recoveryReason,
        failureClass: normalized.class,
        message: pending.error,
        session: publicSession(session, false),
      });
      return false;
    }
    const delay = Number.isFinite(normalized.retryAfterMs) && normalized.retryAfterMs > 0
      ? normalized.retryAfterMs
      : this.retryDelay(nextAttempt);
    pending.status = "retryWaiting";
    pending.retryAttempts = nextAttempt;
    pending.retryReason = reason === "retry-delivery" ? "network" : normalized.class;
    pending.retryClass = normalized.class;
    pending.nextRetryAt = Date.now() + delay;
    pending.requiresConfirmation = false;
    pending.error = `Claude ${normalized.class === "rate-limit" ? "触发限流" : "连接异常"}，将在稍后自动重试`;
    await this.persistSessions();
    this.scheduleRetry(session, pending);
    this.emit("event", {
      type: "retry/scheduled",
      sessionId: session.id,
      runId: pending.runId,
      retry: {
        attempts: nextAttempt,
        nextRetryAt: pending.nextRetryAt,
        reason: pending.retryReason,
        failureClass: normalized.class,
      },
      session: publicSession(session, false),
    });
    return true;
  }

  recordUnreviewedProtocolEvent(session, { surface, type, subtype }) {
    const summary = {
      surface: protocolIdentifier(surface),
      type: protocolFingerprint(type),
      subtype: protocolFingerprint(subtype),
    };
    this.emit("log", {
      level: "warn",
      message: `Claude 已忽略未审查协议事件：${summary.surface}/${summary.type}/${summary.subtype}`,
    });
    this.emit("event", {
      type: "protocol/unreviewed-event",
      sessionId: session.id,
      event: summary,
    });
  }

  consumeControlResponse(session, state, event) {
    const response = event.response;
    const requestId = cleanControlText(response?.request_id, 256);
    if (!requestId) return;
    if (requestId === state.initializeRequestId) {
      state.initializeRequestId = null;
      if (response?.subtype === "error") {
        const error = runtimeError(502, cleanControlText(response.error, 1_000) || "Claude 初始化失败");
        state.initializeReject?.(error);
      } else {
        state.initializeResolve?.();
        for (const pending of [
          ...(Array.isArray(response.pending_permission_requests) ? response.pending_permission_requests : []),
          ...(Array.isArray(response.pending_user_dialog_requests) ? response.pending_user_dialog_requests : []),
        ]) this.registerControlRequest(session, state, pending);
      }
      return;
    }
    const pending = state.outboundControlRequests?.get(requestId);
    if (!pending) return;
    state.outboundControlRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (response?.subtype === "error") {
      pending.reject(runtimeError(502, cleanControlText(response.error, 1_000) || "Claude 控制请求失败"));
      return;
    }
    pending.resolve(response?.response && typeof response.response === "object" ? response.response : {});
  }

  requestChildControl(session, state, request, timeoutMs = this.controlRequestTimeoutMs) {
    if (!state?.process?.stdin?.writable) {
      return Promise.reject(runtimeError(409, "Claude 进程未连接"));
    }
    const requestId = `wfl-control-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.outboundControlRequests?.delete(requestId);
        reject(runtimeError(504, "Claude 控制请求超时"));
      }, Math.max(1_000, Number(timeoutMs) || this.controlRequestTimeoutMs));
      timer.unref?.();
      state.outboundControlRequests ||= new Map();
      state.outboundControlRequests.set(requestId, { resolve, reject, timer });
      writeLine(state.process.stdin, {
        type: "control_request",
        request_id: requestId,
        request,
      }).catch((error) => {
        const pending = state.outboundControlRequests.get(requestId);
        if (!pending) return;
        state.outboundControlRequests.delete(requestId);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  registerControlRequest(session, state, event) {
    const nativeRequestId = cleanControlText(event?.request_id, 256);
    const request = event?.request;
    if (!nativeRequestId || !request || typeof request !== "object") return;
    const requestId = scopedControlRequestId(session.id, nativeRequestId);
    if (this.pendingControlRequests.has(requestId)) return;
    if (request.subtype === "request_user_dialog") {
      const publicRequest = sanitizeDialogRequest(session.id, requestId, request, this.controlRequestTimeoutMs);
      if (!publicRequest) {
        void this.writeControlResponse(state, nativeRequestId, { behavior: "cancelled" })
          .catch((error) => this.emit("log", { level: "error", message: claudeLogFailure("问答响应", error) }));
        return;
      }
      this.registerPendingControlRequest(session, state, requestId, nativeRequestId, request, publicRequest);
      return;
    }
    if (request.subtype === "elicitation") {
      const publicRequest = sanitizeElicitationRequest(session.id, requestId, request, this.controlRequestTimeoutMs);
      if (!publicRequest) {
        void this.writeControlResponse(state, nativeRequestId, { action: "cancel" })
          .catch((error) => this.emit("log", { level: "error", message: claudeLogFailure("Elicitation 响应", error) }));
        return;
      }
      this.registerPendingControlRequest(session, state, requestId, nativeRequestId, request, publicRequest);
      return;
    }
    if (request.subtype !== "can_use_tool") {
      const subtype = protocolFingerprint(request.subtype);
      this.emit("log", {
        level: "warn",
        message: `Claude 已拒绝未审查控制请求：${subtype}`,
      });
      void this.writeControlError(state, nativeRequestId, `Unsupported control request subtype: ${subtype}`)
        .catch((error) => this.emit("log", { level: "error", message: claudeLogFailure("控制请求拒绝", error) }));
      return;
    }
    const publicRequest = sanitizeControlRequest(session.id, requestId, request, this.controlRequestTimeoutMs);
    if (!publicRequest) {
      void this.writeControlResponse(state, nativeRequestId, {
        behavior: "deny",
        message: "Claude 权限请求格式无效",
        toolUseID: cleanControlText(request.tool_use_id, 256) || undefined,
      }).catch((error) => this.emit("log", { level: "error", message: claudeLogFailure("权限响应", error) }));
      return;
    }
    this.registerPendingControlRequest(session, state, requestId, nativeRequestId, request, publicRequest);
  }

  registerPendingControlRequest(session, state, requestId, nativeRequestId, request, publicRequest) {
    const timer = setTimeout(() => {
      const result = ["dialog", "elicitation"].includes(publicRequest.kind)
        ? { decision: "cancel" }
        : { decision: "deny", message: "等待用户响应超时" };
      void this.resolveControlRequest(session.id, requestId, result)
        .catch((error) => this.emit("log", { level: "error", message: claudeLogFailure("请求超时处理", error) }));
    }, this.controlRequestTimeoutMs);
    timer.unref?.();
    this.pendingControlRequests.set(requestId, {
      sessionId: session.id,
      state,
      nativeRequestId,
      request,
      publicRequest,
      suggestions: sanitizePermissionUpdates(request.permission_suggestions),
      timer,
      settling: false,
    });
    session.pendingApprovals = (session.pendingApprovals || [])
      .filter((entry) => entry.id !== requestId)
      .slice(-15);
    session.pendingApprovals.push({
      id: requestId,
      kind: publicRequest.kind,
      toolName: cleanControlText(publicRequest.toolName || publicRequest.tool, 256) || null,
      requestedAt: Date.now(),
      expiresAt: Date.now() + this.controlRequestTimeoutMs,
      status: "waiting",
    });
    if (session.pendingTurn) session.pendingTurn.lastActivityAt = Date.now();
    void this.persistSessions();
    this.emit("event", { type: "control/request", sessionId: session.id, request: publicRequest });
    this.emit("status", this.status());
  }

  async resolveControlRequest(sessionId, requestId, result) {
    const normalizedRequestId = String(requestId || "");
    const pending = this.pendingControlRequests.get(normalizedRequestId);
    if (!pending || pending.sessionId !== String(sessionId) || pending.settling) {
      throw runtimeError(409, "此 Claude 请求已处理或失效");
    }
    const response = controlRequestResponse(pending, result);
    pending.settling = true;
    try {
      await this.writeControlResponse(pending.state, pending.nativeRequestId, response);
    } finally {
      this.finishControlRequest(normalizedRequestId, "answered");
    }
    return { resolved: true, requestId: normalizedRequestId };
  }

  async cancelControlRequests(sessionId, reason) {
    const pending = [...this.pendingControlRequests.entries()]
      .filter(([, entry]) => entry.sessionId === String(sessionId) && !entry.settling);
    await Promise.all(pending.map(async ([requestId, entry]) => {
      entry.settling = true;
      try {
        await this.writeControlResponse(entry.state, entry.nativeRequestId, controlCancellationResponse(entry, reason));
      } catch {
        // The process may already be exiting; local state still has to settle.
      } finally {
        this.finishControlRequest(requestId, "cancelled");
      }
    }));
  }

  cancelControlRequest(sessionId, nativeRequestId, reason, writeResponse = false) {
    const requestId = scopedControlRequestId(String(sessionId || ""), String(nativeRequestId || ""));
    const pending = this.pendingControlRequests.get(requestId);
    if (!pending) return false;
    if (writeResponse) {
      const result = ["dialog", "elicitation"].includes(pending.publicRequest.kind)
        ? { decision: "cancel" }
        : { decision: "deny", message: reason };
      void this.resolveControlRequest(pending.sessionId, requestId, result)
        .catch((error) => this.emit("log", { level: "error", message: claudeLogFailure("请求取消处理", error) }));
      return true;
    }
    this.finishControlRequest(String(requestId), "cancelled");
    return true;
  }

  finishControlRequest(requestId, outcome) {
    const pending = this.pendingControlRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControlRequests.delete(requestId);
    const session = this.sessions.get(pending.sessionId);
    if (session?.pendingApprovals?.some((entry) => entry.id === requestId)) {
      session.pendingApprovals = session.pendingApprovals.filter((entry) => entry.id !== requestId);
      void this.persistSessions();
    }
    this.emit("event", {
      type: "control/resolved",
      sessionId: pending.sessionId,
      requestId,
      outcome,
    });
    this.emit("status", this.status());
  }

  writeControlResponse(state, requestId, response) {
    if (!state?.process?.stdin?.writable) throw runtimeError(409, "Claude 进程已断开");
    return writeLine(state.process.stdin, {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  writeControlError(state, requestId, error) {
    if (!state?.process?.stdin?.writable) return Promise.resolve();
    return writeLine(state.process.stdin, {
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: cleanControlText(error, 1_000) },
    });
  }

  recordNativeInit(session, event) {
    if (typeof event.session_id === "string" && isUuid(event.session_id)) session.nativeSessionId = event.session_id;
    session.nativeStarted = true;
    session.pendingForkNativeId = null;
    if (typeof event.model === "string" && event.model) session.resolvedModel = event.model.slice(0, 128);
    if (PERMISSION_MODES.has(event.permissionMode)) session.permissionMode = event.permissionMode;
    if (typeof event.cwd === "string" && path.isAbsolute(event.cwd) && event.cwd.length <= 4_096) {
      session.nativeCwd = path.resolve(event.cwd);
    }
    session.updatedAt = Date.now();
    void this.persistSessions();
    this.upsertTranscript(session, {
      id: "system:init",
      type: "system",
      subtype: "init",
      content: [session.resolvedModel || session.model, session.permissionMode].filter(Boolean).join(" · "),
      status: "completed",
      at: Date.now(),
    });
    this.emit("event", { type: "session/native-ready", sessionId: session.id, session: publicSession(session) });
  }

  recordSystemEvent(session, event) {
    this.upsertTranscript(session, {
      id: typeof event.uuid === "string" ? event.uuid : crypto.randomUUID(),
      type: "system",
      subtype: typeof event.subtype === "string" ? event.subtype : "event",
      content: systemEventText(event),
      status: event.error ? "failed" : "completed",
      at: Date.now(),
    });
  }

  recordHookEvent(session, event) {
    const subtype = String(event.type || "hook_event").slice(0, 128);
    const hookId = cleanControlText(event.hook_id || event.hookId || event.uuid || event.id, 192);
    const failed = Boolean(event.error)
      || /(?:fail|error)/i.test(subtype)
      || (Number.isInteger(event.exit_code) && event.exit_code !== 0);
    const inProgress = !failed && /(?:start|progress)/i.test(subtype);
    this.upsertTranscript(session, {
      id: hookId ? `${subtype}:${hookId}` : crypto.randomUUID(),
      type: "system",
      subtype,
      content: hookEventText(event),
      status: failed ? "failed" : inProgress ? "inProgress" : "completed",
      at: Date.now(),
    });
  }

  recordTaskEvent(session, event, taskEventType = claudeTaskEventType(event)) {
    if (!taskEventType || event.skip_transcript === true) return;
    const taskId = cleanControlText(event.task_id || event.taskId || event.id || event.uuid, 256);
    const id = taskId ? `task:${taskId}` : crypto.randomUUID();
    const previous = session.messages.find((item) => item.id === id && item.type === "task");
    const now = Date.now();
    const status = claudeTaskEventStatus(event, taskEventType);
    const startedAt = previous?.startedAt
      || normalizeClaudeEventTimestamp(event.started_at || event.startedAt)
      || now;
    const updatedAt = normalizeClaudeEventTimestamp(
      event.updated_at || event.updatedAt || event.completed_at || event.completedAt || event.timestamp,
    ) || now;
    const terminal = ["completed", "failed", "interrupted"].includes(status);
    const title = cleanControlText(
      event.description || event.subject || event.name || previous?.title || "Claude Agent 任务",
      500,
    );
    const content = cleanControlText(
      event.summary || event.message || event.detail || event.description || previous?.content || title,
      MAX_ITEM_TEXT,
    );
    this.upsertTranscript(session, {
      id,
      type: "task",
      subtype: taskEventType,
      taskId,
      toolUseId: cleanControlText(event.tool_use_id || event.toolUseId, 256) || previous?.toolUseId || null,
      parentTaskId: cleanControlText(
        event.parent_task_id || event.parentTaskId || event.parent_tool_use_id || event.parentToolUseId,
        256,
      ) || previous?.parentTaskId || null,
      agentId: cleanControlText(
        event.agent_id || event.agentId || event.agent_name || event.agentName,
        256,
      ) || previous?.agentId || null,
      subagentType: cleanControlText(
        event.subagent_type || event.subagentType,
        128,
      ) || previous?.subagentType || null,
      taskType: cleanControlText(event.task_type || event.taskType, 128) || previous?.taskType || null,
      workflowName: cleanControlText(
        event.workflow_name || event.workflowName,
        128,
      ) || previous?.workflowName || null,
      lastToolName: cleanControlText(
        event.last_tool_name || event.lastToolName,
        256,
      ) || previous?.lastToolName || null,
      usage: sanitizeClaudeTaskUsage(event.usage) || previous?.usage || null,
      title,
      content,
      status,
      startedAt,
      updatedAt,
      finishedAt: terminal ? updatedAt : null,
      at: previous?.at || startedAt,
    });
  }

  recordStreamEvent(session, state, event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "message_start") {
      state.streamMessageId = typeof event.message?.id === "string" ? event.message.id : crypto.randomUUID();
      state.streamBlocks.clear();
      return;
    }
    const index = Number.isSafeInteger(event.index) ? event.index : 0;
    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      const entry = {
        id: block.type === "tool_use" && typeof block.id === "string"
          ? block.id
          : `${state.streamMessageId || crypto.randomUUID()}:${block.type || "content"}:${index}`,
        type: block.type,
        text: block.text || block.thinking || "",
        inputJson: "",
        name: block.name,
        input: block.input,
      };
      state.streamBlocks.set(index, entry);
      this.recordStreamBlock(session, entry, true);
      return;
    }
    if (event.type === "content_block_delta") {
      const entry = state.streamBlocks.get(index);
      if (!entry) return;
      const delta = event.delta || {};
      if (typeof delta.text === "string") entry.text += delta.text;
      if (typeof delta.thinking === "string") entry.text += delta.thinking;
      if (typeof delta.partial_json === "string") entry.inputJson += delta.partial_json;
      this.recordStreamBlock(session, entry, true);
      return;
    }
    if (event.type === "content_block_stop") {
      const entry = state.streamBlocks.get(index);
      if (entry) this.recordStreamBlock(session, entry, false);
    }
  }

  recordStreamBlock(session, block, streaming) {
    if (block.type === "text") {
      this.upsertTranscript(session, {
        id: block.id,
        type: "message",
        role: "assistant",
        content: String(block.text || "").slice(0, MAX_ITEM_TEXT),
        streaming,
        at: Date.now(),
      });
    } else if (block.type === "thinking") {
      this.upsertTranscript(session, {
        id: block.id,
        type: "thinking",
        content: String(block.text || "").slice(0, MAX_ITEM_TEXT),
        status: streaming ? "inProgress" : "completed",
        at: Date.now(),
      });
    } else if (block.type === "tool_use") {
      let input = block.input;
      if (block.inputJson) {
        try { input = JSON.parse(block.inputJson); } catch { input = block.inputJson.slice(0, MAX_ITEM_TEXT); }
      }
      this.upsertTranscript(session, transcriptTool(block.id, block.name, input, streaming ? "inProgress" : "inProgress"));
    }
  }

  recordAssistantEvent(session, event) {
    const messageId = typeof event.message.id === "string" ? event.message.id : crypto.randomUUID();
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    content.forEach((block, index) => {
      if (block?.type === "text" && block.text) {
        this.upsertTranscript(session, {
          id: `${messageId}:text:${index}`,
          type: "message",
          role: "assistant",
          content: String(block.text).slice(0, MAX_ITEM_TEXT),
          streaming: false,
          at: Date.now(),
        }, { replaceStreamingType: "message" });
      } else if (block?.type === "thinking" && block.thinking) {
        this.upsertTranscript(session, {
          id: `${messageId}:thinking:${index}`,
          type: "thinking",
          content: String(block.thinking).slice(0, MAX_ITEM_TEXT),
          status: "completed",
          at: Date.now(),
        }, { replaceStreamingType: "thinking" });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        this.upsertTranscript(session, {
          ...transcriptTool(block.id, block.name, block.input, "inProgress"),
          parentToolUseId: typeof event.parent_tool_use_id === "string" ? event.parent_tool_use_id : null,
        });
      }
    });
    if (event.error && !content.some((block) => block?.type === "text")) {
      this.upsertTranscript(session, {
        id: `${messageId}:error`,
        type: "system",
        subtype: "api_error",
        content: String(event.error).slice(0, 2_000),
        status: "failed",
        at: Date.now(),
      });
    }
  }

  recordToolResults(session, event) {
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    for (const block of content) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const previous = session.messages.find((item) => item.type === "tool" && item.toolUseId === block.tool_use_id);
      this.upsertTranscript(session, {
        ...(previous || transcriptTool(block.tool_use_id, "Tool", null, "inProgress")),
        id: previous?.id || block.tool_use_id,
        output: extractToolResult(block.content, event.tool_use_result),
        result: boundedJson(event.tool_use_result),
        status: block.is_error === true ? "failed" : "completed",
        isError: block.is_error === true,
        updatedAt: Date.now(),
      });
    }
  }

  recordNativeUserEvent(session, event) {
    const nativeMessageId = normalizeNativeMessageId(event.uuid || event.message?.id);
    const text = nativeUserText(event);
    if (!nativeMessageId || !text) return;
    const pendingMessageId = session.pendingTurn?.messageId;
    const pending = pendingMessageId
      ? session.messages.find((item) => item.id === pendingMessageId && item.role === "user")
      : null;
    const candidate = pending
      || [...session.messages].reverse().find((item) =>
        item.type === "message"
        && item.role === "user"
        && !item.nativeMessageId
        && normalizeComparableText(item.content) === normalizeComparableText(text));
    if (!candidate || (candidate.nativeMessageId && candidate.nativeMessageId !== nativeMessageId)) return;
    if (candidate.nativeMessageId === nativeMessageId) return;
    candidate.nativeMessageId = nativeMessageId;
    session.updatedAt = Date.now();
    void this.persistSessions();
    this.emit("event", {
      type: "session/updated",
      sessionId: session.id,
      session: publicSession(session, false, this.children.get(session.id)),
    });
  }

  upsertTranscript(session, item, { replaceStreamingType = null } = {}) {
    let index = session.messages.findIndex((entry) => entry.id === item.id);
    if (index === -1 && replaceStreamingType) {
      index = session.messages.findIndex((entry) => entry.type === replaceStreamingType && entry.streaming === true);
    }
    let merged = index === -1 ? item : { ...session.messages[index], ...item };
    const previous = index === -1 ? null : session.messages[index];
    if (
      previous?.type === "tool"
      && item?.type === "tool"
      && ["completed", "failed"].includes(previous.status)
      && item.status === "inProgress"
    ) {
      // A native JSONL refresh or a duplicated live assistant event can arrive
      // after its tool_result. Refresh the tool metadata without regressing a
      // terminal result back to an empty, running Tool Use.
      merged = {
        ...merged,
        output: previous.output,
        result: previous.result,
        status: previous.status,
        isError: previous.isError,
        updatedAt: previous.updatedAt,
      };
    }
    const normalized = normalizeTranscriptItem(merged);
    if (!normalized) return;
    if (index === -1) session.messages.push(normalized);
    else session.messages[index] = normalized;
    if (session.messages.length > MAX_TRANSCRIPT_ITEMS) session.messages.splice(0, session.messages.length - MAX_TRANSCRIPT_ITEMS);
    session.updatedAt = Date.now();
    void this.persistSessions();
    this.emit("event", {
      type: "transcript/upsert",
      sessionId: session.id,
      item: publicTranscriptItem(normalized),
    });
  }

  async childExit(session, state, details = {}) {
    const current = this.children.get(session.id);
    if (current !== state) return;
    state.connected = false;
    this.children.delete(session.id);
    const exitError = runtimeError(502, claudeProcessExitMessage(details));
    state.initializeReject?.(exitError);
    for (const [requestId, pending] of state.outboundControlRequests || []) {
      clearTimeout(pending.timer);
      pending.reject(exitError);
      state.outboundControlRequests.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingControlRequests) {
      if (pending.sessionId === session.id) this.finishControlRequest(requestId, "process-exited");
    }
    if (!state.intentional) {
      if (state.turnActive && session.pendingTurn) {
        const stoppedByUser = state.stopRequested === true;
        const pausedByUser = state.pauseRequested === true
          || session.pendingTurn.status === "pausing";
        if (pausedByUser) {
          session.pendingTurn = {
            ...session.pendingTurn,
            status: "paused",
            pauseMode: session.pendingTurn.pauseMode || "immediate",
            pausedAt: Date.now(),
            recoveryReason: "paused",
            requiresConfirmation: false,
            error: "Claude 任务已暂停，点击“继续”恢复",
          };
        } else if (stoppedByUser) {
          session.pendingTurn = {
            ...session.pendingTurn,
            status: "interrupted",
            interruptedAt: Date.now(),
            recoveryAt: undefined,
            recoveryReason: "user-interrupt",
            requiresConfirmation: false,
            error: "用户已终止 Claude 任务",
          };
        } else {
          const failure = classifyClaudeFailure({
            ...details,
            failureClass: state.failureClass,
            message: claudeProcessExitMessage(details),
          });
          const handled = await this.handleRetryableFailure(session, state, failure, "process-exit");
          if (!handled && session.pendingTurn?.status !== "recoveryPending") {
            session.pendingTurn = {
              ...session.pendingTurn,
              status: "recoveryPending",
              recoveryAt: Date.now(),
              recoveryReason: "process-exit",
              requiresConfirmation: true,
              error: claudeProcessExitMessage(details),
            };
          }
        }
        state.pauseRequested = false;
        session.updatedAt = Date.now();
        await this.persistSessions();
      }
      this.emit("event", {
        type: "process/exited",
        sessionId: session.id,
        runId: state.runId || session.pendingTurn?.runId || null,
        message: session.pendingTurn?.status === "paused"
          ? "Claude 任务已暂停"
          : session.pendingTurn?.status === "interrupted"
            ? "Claude 任务已终止"
            : claudeProcessExitMessage(details),
        wasActive: state.turnActive
          && !["paused", "interrupted"].includes(session.pendingTurn?.status),
        session: publicSession(session, false),
      });
    }
    this.emit("status", this.status());
  }

  assertMcpConfigurationIdle() {
    if (this.loginChild) throw runtimeError(409, "Claude 官方登录进行中，完成或取消后再修改 MCP");
    if ([...this.children.values()].some((child) => child?.turnActive)) {
      throw runtimeError(409, "Claude 正在执行任务，完成或停止后再修改 MCP");
    }
  }

  assertExtensionConfigurationIdle() {
    if (this.loginChild) throw runtimeError(409, "Claude 官方登录进行中，完成或取消后再修改扩展");
    if ([...this.children.values()].some((child) => child?.turnActive)) {
      throw runtimeError(409, "Claude 正在执行任务，完成或停止后再修改扩展");
    }
  }

  assertProviderChangeIdle() {
    if (this.loginChild) throw runtimeError(409, "Claude 官方登录进行中，完成或取消后再切换供应商");
    if ([...this.children.values()].some((child) => child?.turnActive)) {
      throw runtimeError(409, "Claude 正在执行任务，完成或停止后再切换供应商");
    }
  }

  async prepareProviderChange(reason = "Claude 供应商已切换") {
    this.assertProviderChangeIdle();
    await this.reloadIdleChildrenForConfigurationChange(reason);
  }

  queueMcpConfiguration(operation) {
    const queued = this.mcpConfigQueue.then(operation, operation);
    this.mcpConfigQueue = queued.catch(() => {});
    return queued;
  }

  queueExtensionConfiguration(operation) {
    const queued = this.extensionConfigQueue.then(operation, operation);
    this.extensionConfigQueue = queued.catch(() => {});
    return queued;
  }

  async readClaudeConfiguration() {
    try {
      const stat = await fs.lstat(this.claudeConfigPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLAUDE_CONFIG_BYTES) {
        throw runtimeError(500, "Claude 用户配置文件不安全");
      }
      const value = JSON.parse(await fs.readFile(this.claudeConfigPath, "utf8"));
      if (!plainObject(value)) throw runtimeError(500, "Claude 用户配置格式无效");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      if (error instanceof SyntaxError) throw runtimeError(500, "Claude 用户配置无法解析");
      throw error;
    }
  }

  async writeClaudeConfiguration(configuration) {
    const temporary = path.join(this.configDirectory, `.claude.json.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(configuration, null, 2)}\n`);
      if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
        await handle.chown(this.user.uid, this.user.gid);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.claudeConfigPath);
      await fs.chmod(this.claudeConfigPath, 0o600);
      const directory = await fs.open(this.configDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async reloadIdleChildrenForConfigurationChange(reason = "Claude MCP 配置已更改") {
    await Promise.all([...this.children.entries()].map(async ([sessionId, child]) => {
      await this.cancelControlRequests(sessionId, reason);
      child.intentional = true;
      child.process?.kill("SIGTERM");
      this.children.delete(sessionId);
    }));
    this.emit("status", this.status());
  }

  environment(profile, { officialAccountId = null, configDirectory = null } = {}) {
    const accountId = profile ? null : normalizeClaudeAccountId(officialAccountId);
    const accountConfigDirectory = configDirectory
      || (accountId && this.officialAccounts?.has(accountId)
        ? this.officialAccounts.configDirectory(accountId)
        : this.configDirectory);
    const proxyEnvironment = accountId
      ? this.officialProxyRouters.get(accountId)?.environment() || {}
      : {};
    const environment = {
      ...process.env,
      ...(this.user.home ? {
        HOME: this.user.home,
        USER: this.user.systemUsername || process.env.USER,
        LOGNAME: this.user.systemUsername || process.env.LOGNAME,
      } : {}),
      CLAUDE_CONFIG_DIR: accountConfigDirectory,
      DISABLE_AUTOUPDATER: "1",
      ...proxyEnvironment,
      ...(profile?.apiKey ? { ANTHROPIC_API_KEY: profile.apiKey } : {}),
      ...(profile?.baseUrl ? { ANTHROPIC_BASE_URL: profile.baseUrl } : {}),
    };
    if (!profile?.apiKey) delete environment.ANTHROPIC_API_KEY;
    if (!profile?.baseUrl) delete environment.ANTHROPIC_BASE_URL;
    // Claude's SDK/stream-json mode disables file checkpoints unless this
    // opt-in is present. Respect an explicit disable from the administrator.
    if (!environment.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
      && !environment.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) {
      environment.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "1";
    }
    return environment;
  }

  spawnOptions({
    cwd,
    profile = null,
    officialAccountId = null,
    configDirectory = null,
    stdio,
  }) {
    const options = {
      cwd,
      env: this.environment(profile, { officialAccountId, configDirectory }),
      stdio,
    };
    if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
      options.uid = this.user.uid;
      options.gid = this.user.gid;
    }
    return options;
  }

  sessionMcpConfigPath(sessionId) {
    if (!isUuid(sessionId)) throw runtimeError(400, "Claude 会话 ID 无效");
    return path.join(this.directory, `.session-${sessionId}-mcp.json`);
  }

  sessionPluginDirectory(sessionId) {
    if (!isUuid(sessionId)) throw runtimeError(400, "Claude 会话 ID 无效");
    return path.join(this.sessionPluginsDirectory, sessionId);
  }

  async writeSessionMcpConfig(session) {
    const configured = await this.mergedMcpServers(session.cwd);
    const selected = {};
    for (const name of session.mcpServerNames) {
      if (!plainObject(configured[name])) {
        throw runtimeError(409, `Claude MCP 服务器“${name}”已不存在，请更新会话白名单`);
      }
      selected[name] = configured[name];
    }
    const target = this.sessionMcpConfigPath(session.id);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ mcpServers: selected })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    try {
      if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
        await fs.chown(temporary, this.user.uid, this.user.gid);
      }
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
      return target;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async inlineAgentsJson(names) {
    const available = new Map((await this.extensionStore.listAgents())
      .map((agent) => [agent.name, agent]));
    const definitions = {};
    for (const name of names) {
      const agent = available.get(name);
      if (!agent) throw runtimeError(409, `Claude Agent“${name}”已不存在，请更新会话定义`);
      definitions[name] = {
        description: agent.description,
        prompt: agent.body,
        ...(agent.tools.length ? { tools: agent.tools } : {}),
        ...(agent.model && agent.model !== "inherit" ? { model: agent.model } : {}),
      };
    }
    return JSON.stringify(definitions);
  }

  persistSessions() {
    const operation = this.persistQueue.then(() => this.writeSessions(), () => this.writeSessions());
    this.persistQueue = operation.catch((error) => {
      this.emit("log", { level: "error", message: claudeLogFailure("会话存储", error) });
    });
    return operation;
  }

  async loadTaskSettings() {
    try {
      const value = JSON.parse(await fs.readFile(this.taskSettingsPath, "utf8"));
      this.taskSettings = normalizeClaudeTaskSettings(value?.settings || value);
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.emit("log", { level: "warn", message: claudeLogFailure("Claude 任务设置", error) });
      }
      this.taskSettings = { ...DEFAULT_CLAUDE_TASK_SETTINGS };
      await this.writeTaskSettings();
    }
  }

  async writeTaskSettings() {
    const temporaryPath = `${this.taskSettingsPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify({
      version: CLAUDE_TASK_SETTINGS_VERSION,
      settings: this.taskSettings,
    })}\n`, { mode: 0o600, flag: "wx" });
    try {
      if (this.user.legacy === false && Number.isInteger(this.user.uid) && Number.isInteger(this.user.gid)) {
        await fs.chown(temporaryPath, this.user.uid, this.user.gid);
      }
      await fs.rename(temporaryPath, this.taskSettingsPath);
      await fs.chmod(this.taskSettingsPath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async writeSessions() {
    const payload = JSON.stringify({
      version: SESSION_VERSION,
      sessions: [...this.sessions.values()].filter((session) => !session.noSessionPersistence),
      deletedNativeSessionIds: [...this.deletedNativeSessionIds],
    });
    const temp = `${this.sessionsPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, `${payload}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, this.sessionsPath);
    await fs.chmod(this.sessionsPath, 0o600);
  }
}

async function nativeSessionFromFile(filePath, { cwd = null, nativeSessionId } = {}) {
  let raw;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_NATIVE_TRANSCRIPT_BYTES) return null;
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const messages = [];
  const tools = new Map();
  let sessionCwd = null;
  let createdAt = null;
  let updatedAt = null;
  let model = null;
  let permissionMode = null;
  let firstUserText = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || event.isSidechain === true || (event.sessionId && event.sessionId !== nativeSessionId)) continue;
    if (!sessionCwd && typeof event.cwd === "string" && event.cwd) sessionCwd = path.resolve(event.cwd);
    const timestamp = Date.parse(event.timestamp || "");
    if (Number.isFinite(timestamp)) {
      createdAt = createdAt === null ? timestamp : Math.min(createdAt, timestamp);
      updatedAt = updatedAt === null ? timestamp : Math.max(updatedAt, timestamp);
    }
    if (PERMISSION_MODES.has(event.permissionMode)) permissionMode = event.permissionMode;
    if (event.type === "system" && typeof event.subtype === "string") {
      const item = normalizeTranscriptItem({
        id: event.uuid || `system:${event.subtype}:${Number.isFinite(timestamp) ? timestamp : messages.length}`,
        type: "system",
        subtype: event.subtype,
        content: systemEventText(event),
        status: event.error ? "failed" : "completed",
        at: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
      if (item) messages.push(item);
      continue;
    }
    const message = event.message;
    if (event.type === "user" && message?.role === "user") {
      const content = message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n")
          : "";
      if (text.trim()) {
        if (!firstUserText) firstUserText = text.trim();
        const item = normalizeTranscriptItem({
          id: event.uuid || crypto.randomUUID(),
          type: "message",
          role: "user",
          content: text,
          nativeMessageId: normalizeNativeMessageId(event.uuid),
          at: Number.isFinite(timestamp) ? timestamp : Date.now(),
        });
        if (item) messages.push(item);
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const tool = tools.get(block.tool_use_id);
          if (!tool) continue;
          tool.output = extractToolResult(block.content, event.toolUseResult || event.tool_use_result);
          tool.status = block.is_error === true ? "failed" : "completed";
          tool.isError = block.is_error === true;
          tool.updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
        }
      }
      continue;
    }
    if (event.type !== "assistant" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (typeof message.model === "string" && message.model) model = message.model;
    const messageId = typeof message.id === "string" ? message.id : (event.uuid || crypto.randomUUID());
    message.content.forEach((block, index) => {
      const at = Number.isFinite(timestamp) ? timestamp : Date.now();
      if (block?.type === "text" && block.text) {
        const item = normalizeTranscriptItem({ id: `${messageId}:text:${index}`, type: "message", role: "assistant", content: block.text, at });
        if (item) messages.push(item);
      } else if (block?.type === "thinking" && block.thinking) {
        const item = normalizeTranscriptItem({ id: `${messageId}:thinking:${index}`, type: "thinking", content: block.thinking, status: "completed", at });
        if (item) messages.push(item);
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        const item = transcriptTool(block.id, block.name, block.input, "inProgress");
        item.at = at;
        item.updatedAt = at;
        messages.push(item);
        tools.set(block.id, item);
      }
    });
  }
  if (!sessionCwd || (cwd && path.resolve(cwd) !== sessionCwd) || !messages.length) return null;
  return normalizeSession({
    id: nativeSessionId,
    nativeSessionId,
    nativeStarted: true,
    nativeSource: true,
    cwd: sessionCwd,
    name: firstUserText.replace(/\s+/g, " ").slice(0, 80) || "原生 Claude 对话",
    nameOrigin: "prompt",
    model: model || DEFAULT_MODEL,
    permissionMode: permissionMode || DEFAULT_PERMISSION_MODE,
    createdAt: createdAt || Date.now(),
    updatedAt: updatedAt || createdAt || Date.now(),
    messages,
  });
}

function normalizeClaudeExecutionSettings(value, { strict = false } = {}) {
  const invalid = (message) => {
    if (strict) throw runtimeError(400, message);
    return {
      fallbackModel: null,
      maxBudgetUsd: null,
      allowedTools: [],
      disallowedTools: [],
      agent: null,
    };
  };
  const source = value && typeof value === "object" ? value : {};
  const rawFallbackModel = source.fallbackModel;
  let fallbackModel = null;
  if (rawFallbackModel !== undefined && rawFallbackModel !== null && rawFallbackModel !== "") {
    if (typeof rawFallbackModel !== "string") return invalid("Claude 备用模型无效");
    fallbackModel = rawFallbackModel.trim();
    if (
      !fallbackModel
      || fallbackModel.length > MAX_CLAUDE_FALLBACK_MODEL_LENGTH
      || /^[\s-]/.test(fallbackModel)
      || /[\0\r\n]/.test(fallbackModel)
    ) return invalid("Claude 备用模型无效");
  }

  const rawBudget = source.maxBudgetUsd;
  let maxBudgetUsd = null;
  if (rawBudget !== undefined && rawBudget !== null && rawBudget !== "") {
    const number = typeof rawBudget === "number" ? rawBudget : Number(rawBudget);
    if (!Number.isFinite(number) || number < 0 || number > MAX_CLAUDE_BUDGET_USD) {
      return invalid(`Claude 预算必须在 0 到 ${MAX_CLAUDE_BUDGET_USD} 美元之间`);
    }
    maxBudgetUsd = Math.round(number * 1_000_000) / 1_000_000;
  }

  const normalizeRules = (raw, label) => {
    if (raw === undefined || raw === null || raw === "") return [];
    const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/u) : null;
    if (!entries || entries.length > MAX_CLAUDE_TOOL_RULES) return invalid(`${label}列表无效`);
    const rules = [];
    for (const entry of entries) {
      if (typeof entry !== "string") return invalid(`${label}列表无效`);
      const rule = entry.trim();
      if (!rule) continue;
      if (
        rule.length > MAX_CLAUDE_TOOL_RULE_LENGTH
        || /^[\s-]/.test(rule)
        || /[\0\r\n]/.test(rule)
      ) return invalid(`${label}规则无效`);
      if (!rules.includes(rule)) rules.push(rule);
      if (rules.length > MAX_CLAUDE_TOOL_RULES) return invalid(`${label}数量超过上限`);
    }
    return rules;
  };
  const allowedTools = normalizeRules(source.allowedTools, "允许工具");
  if (!Array.isArray(allowedTools)) return allowedTools;
  const disallowedTools = normalizeRules(source.disallowedTools, "禁止工具");
  if (!Array.isArray(disallowedTools)) return disallowedTools;

  const rawAgent = source.agent;
  let agent = null;
  if (rawAgent !== undefined && rawAgent !== null && rawAgent !== "") {
    const normalizedAgent = typeof rawAgent === "string" ? rawAgent.trim() : "";
    if (
      !normalizedAgent
      || normalizedAgent.length > MAX_CLAUDE_AGENT_NAME_LENGTH
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(normalizedAgent)
    ) return invalid("Claude Agent 名称无效");
    agent = normalizedAgent;
  }
  return { fallbackModel, maxBudgetUsd, allowedTools, disallowedTools, agent };
}

function normalizeClaudeLaunchSettings(value, { strict = false } = {}) {
  const defaults = {
    systemPrompt: null,
    excludeDynamicSystemPromptSections: false,
    settingSources: [],
    safeMode: false,
    strictMcpConfig: false,
    mcpServerNames: [],
    noSessionPersistence: false,
    autocompact: null,
    jsonSchema: null,
    inlineAgentNames: [],
    brief: false,
    remoteFiles: [],
    fromPr: null,
    pluginDirectories: [],
    pluginUrls: [],
    betaHeaders: [],
  };
  const invalid = (message) => {
    if (strict) throw runtimeError(400, message);
    return { ...defaults };
  };
  const source = value && typeof value === "object" ? value : {};

  let autocompact = null;
  if (source.autocompact !== undefined && source.autocompact !== null && source.autocompact !== "") {
    if (source.autocompact === "auto") {
      autocompact = "auto";
    } else {
      const tokens = typeof source.autocompact === "number"
        ? source.autocompact
        : typeof source.autocompact === "string" && /^\d+$/.test(source.autocompact.trim())
          ? Number(source.autocompact.trim())
          : NaN;
      if (
        !Number.isSafeInteger(tokens)
        || tokens < MIN_CLAUDE_AUTOCOMPACT_TOKENS
        || tokens > MAX_CLAUDE_AUTOCOMPACT_TOKENS
      ) {
        return invalid(`Claude 自动压缩窗口必须是 auto 或 ${MIN_CLAUDE_AUTOCOMPACT_TOKENS} 到 ${MAX_CLAUDE_AUTOCOMPACT_TOKENS} tokens`);
      }
      autocompact = tokens;
    }
  }

  let systemPrompt = null;
  if (source.systemPrompt !== undefined && source.systemPrompt !== null && source.systemPrompt !== "") {
    if (typeof source.systemPrompt !== "string") return invalid("Claude 系统提示无效");
    systemPrompt = source.systemPrompt.trim();
    if (
      !systemPrompt
      || systemPrompt.length > MAX_CLAUDE_SYSTEM_PROMPT_LENGTH
      || systemPrompt.includes("\0")
    ) return invalid("Claude 系统提示无效或超过 32,000 字符");
  }

  const normalizeList = (raw, validator, label, maximum = MAX_MCP_SERVERS) => {
    if (raw === undefined || raw === null || raw === "") return [];
    const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
    if (!entries || entries.length > maximum) return invalid(`${label}无效`);
    const normalized = [];
    for (const entry of entries) {
      const item = typeof entry === "string" ? entry.trim() : "";
      if (!item) continue;
      if (!validator(item)) return invalid(`${label}包含无效值`);
      if (!normalized.includes(item)) normalized.push(item);
    }
    return normalized;
  };
  const settingSources = normalizeList(
    source.settingSources,
    (entry) => CLAUDE_SETTING_SOURCES.has(entry),
    "Claude 配置来源",
    CLAUDE_SETTING_SOURCES.size,
  );
  if (!Array.isArray(settingSources)) return settingSources;
  const mcpServerNames = normalizeList(
    source.mcpServerNames,
    validMcpName,
    "Claude MCP 白名单",
  );
  if (!Array.isArray(mcpServerNames)) return mcpServerNames;
  const inlineAgentNames = normalizeList(
    source.inlineAgentNames,
    (entry) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry),
    "Claude 会话级 Agent",
    MAX_CLAUDE_INLINE_AGENTS,
  );
  if (!Array.isArray(inlineAgentNames)) return inlineAgentNames;
  const remoteFiles = normalizeClaudeRemoteFiles(source.remoteFiles, { strict });
  if (!Array.isArray(remoteFiles)) return remoteFiles;
  const fromPr = normalizeClaudePrReference(source.fromPr, { strict });
  if (fromPr && source.forkedFrom) return invalid("从 PR 恢复和对话分支不能同时启用");
  const pluginDirectories = normalizeClaudePluginDirectories(source.pluginDirectories, { strict });
  if (!Array.isArray(pluginDirectories)) return pluginDirectories;
  const pluginUrls = normalizeClaudePluginUrls(source.pluginUrls, { strict });
  if (!Array.isArray(pluginUrls)) return pluginUrls;
  const betaHeaders = normalizeList(
    source.betaHeaders,
    (entry) => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry),
    "Anthropic Beta Header",
    MAX_CLAUDE_BETA_HEADERS,
  );
  if (!Array.isArray(betaHeaders)) return betaHeaders;

  let jsonSchema = null;
  if (source.jsonSchema !== undefined && source.jsonSchema !== null && source.jsonSchema !== "") {
    if (typeof source.jsonSchema !== "string") return invalid("Claude JSON Schema 无效");
    const raw = source.jsonSchema.trim();
    if (!raw || raw.length > MAX_CLAUDE_JSON_SCHEMA_LENGTH || raw.includes("\0")) {
      return invalid("Claude JSON Schema 无效或超过 64,000 字符");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalid("Claude JSON Schema 不是有效 JSON");
    }
    if (!(typeof parsed === "boolean" || plainObject(parsed))) {
      return invalid("Claude JSON Schema 必须是对象或布尔值");
    }
    if (!boundedJsonTree(parsed, MAX_CLAUDE_JSON_SCHEMA_NODES, MAX_CLAUDE_JSON_SCHEMA_DEPTH)) {
      return invalid("Claude JSON Schema 结构过深或过大");
    }
    jsonSchema = JSON.stringify(parsed);
  }

  return {
    systemPrompt,
    excludeDynamicSystemPromptSections: source.excludeDynamicSystemPromptSections === true,
    settingSources,
    safeMode: source.safeMode === true,
    strictMcpConfig: source.strictMcpConfig === true,
    mcpServerNames,
    noSessionPersistence: source.noSessionPersistence === true,
    autocompact,
    jsonSchema,
    inlineAgentNames,
    brief: source.brief === true,
    remoteFiles,
    fromPr,
    pluginDirectories,
    pluginUrls,
    betaHeaders,
  };
}

function normalizeClaudeRemoteFiles(value, { strict = false } = {}) {
  if (value === undefined || value === null || value === "") return [];
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : null;
  const fail = (message) => {
    if (strict) throw runtimeError(400, message);
    return [];
  };
  if (!entries || entries.length > MAX_CLAUDE_REMOTE_FILES) {
    return fail(`Claude 远程文件最多 ${MAX_CLAUDE_REMOTE_FILES} 个`);
  }
  const files = [];
  for (const entry of entries) {
    let fileId;
    let relativePath;
    if (typeof entry === "string") {
      const separator = entry.indexOf(":");
      fileId = separator > 0 ? entry.slice(0, separator).trim() : "";
      relativePath = separator > 0 ? entry.slice(separator + 1).trim() : "";
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      fileId = typeof entry.fileId === "string" ? entry.fileId.trim() : "";
      relativePath = typeof entry.relativePath === "string" ? entry.relativePath.trim() : "";
    }
    if (!/^file_[A-Za-z0-9_-]{1,200}$/.test(fileId || "")) {
      return fail("Claude 远程文件 ID 必须使用 file_ 开头");
    }
    if (
      !relativePath
      || relativePath.length > MAX_CLAUDE_REMOTE_FILE_PATH_LENGTH
      || relativePath.startsWith("/")
      || relativePath.endsWith("/")
      || relativePath.includes("\\")
      || /[\0\r\n]/.test(relativePath)
    ) {
      return fail("Claude 远程文件目标必须是安全的工程内相对路径");
    }
    const segments = relativePath.split("/");
    if (
      segments.some((segment) => !segment || segment === "." || segment === "..")
      || path.posix.normalize(relativePath) !== relativePath
    ) {
      return fail("Claude 远程文件目标不能包含空目录、点目录或越界目录");
    }
    if (files.some((item) => item.relativePath === relativePath)) {
      return fail("Claude 远程文件目标路径不能重复");
    }
    files.push({ fileId, relativePath });
  }
  for (let left = 0; left < files.length; left += 1) {
    for (let right = left + 1; right < files.length; right += 1) {
      const a = files[left].relativePath;
      const b = files[right].relativePath;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        return fail("Claude 远程文件目标不能互为文件和父目录");
      }
    }
  }
  return files;
}

function normalizeClaudePrReference(value, { strict = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const fail = () => {
    if (strict) throw runtimeError(400, "Claude PR 来源必须是 PR 编号或 github.com Pull Request URL");
    return null;
  };
  if (Number.isSafeInteger(value) && value > 0 && value <= 999_999_999) return String(value);
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^[1-9][0-9]{0,8}$/.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "github.com"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !/^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,8}\/?$/.test(url.pathname)
  ) return fail();
  return `https://github.com${url.pathname.replace(/\/$/, "")}`;
}

function remoteFileSpec(entry) {
  return `${entry.fileId}:${entry.relativePath}`;
}

async function assertRemoteFileTargets(cwd, entries) {
  let root;
  try {
    root = await fs.realpath(cwd);
  } catch {
    throw runtimeError(400, "Claude 工程目录不存在");
  }
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.relativePath.split("/"));
    if (!pathWithin(root, target) || target === root) {
      throw runtimeError(400, "Claude 远程文件目标超出工程范围");
    }
    try {
      await fs.lstat(target);
      throw runtimeError(409, `Claude 远程文件目标“${entry.relativePath}”已存在，请更换路径`);
    } catch (error) {
      if (error?.status === 409) throw error;
      if (error?.code !== "ENOENT") throw runtimeError(400, "Claude 远程文件目标不可访问");
    }
    let ancestor = path.dirname(target);
    while (ancestor !== root) {
      try {
        const stat = await fs.lstat(ancestor);
        if (stat.isSymbolicLink()) throw runtimeError(400, "Claude 远程文件目标不能经过符号链接");
        if (!stat.isDirectory()) throw runtimeError(400, "Claude 远程文件目标的父路径不是目录");
        break;
      } catch (error) {
        if (error?.status === 400) throw error;
        if (error?.code !== "ENOENT") throw runtimeError(400, "Claude 远程文件目标不可访问");
        ancestor = path.dirname(ancestor);
      }
    }
    const realAncestor = await fs.realpath(ancestor);
    if (!pathWithin(root, realAncestor)) {
      throw runtimeError(400, "Claude 远程文件目标经过了工程外路径");
    }
  }
}

function boundedJsonTree(value, maximumNodes, maximumDepth) {
  let nodes = 0;
  const visit = (entry, depth) => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) return false;
    if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) return true;
    if (Array.isArray(entry)) return entry.every((item) => visit(item, depth + 1));
    if (!plainObject(entry)) return false;
    return Object.entries(entry).every(([key, item]) =>
      key.length <= 1_024 && !key.includes("\0") && visit(item, depth + 1));
  };
  return visit(value, 0);
}

function normalizeProviderId(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^c-[a-f0-9]{12}$/.test(value) ? value : null;
}

function normalizeClaudeAccountId(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && CLAUDE_ACCOUNT_ID_PATTERN.test(value) ? value : null;
}

function officialAccountDisplayName(account) {
  if (!account) return null;
  return account.label || account.email || "Claude 官方账号";
}

function normalizeClaudeTaskSettings(value = {}) {
  const frequency = CLAUDE_RETRY_FREQUENCIES.includes(value.retryFrequency)
    ? value.retryFrequency
    : DEFAULT_CLAUDE_TASK_SETTINGS.retryFrequency;
  const rawMax = Number(value.maxRetries);
  const maxRetries = Number.isSafeInteger(rawMax)
    ? Math.min(100, Math.max(0, rawMax))
    : DEFAULT_CLAUDE_TASK_SETTINGS.maxRetries;
  return {
    unlimitedRetry: value.unlimitedRetry === true,
    retryFrequency: frequency,
    maxRetries,
  };
}

function publicClaudeTaskSettings(value) {
  return {
    unlimitedRetry: value.unlimitedRetry === true,
    retryFrequency: CLAUDE_RETRY_FREQUENCIES.includes(value.retryFrequency)
      ? value.retryFrequency
      : DEFAULT_CLAUDE_TASK_SETTINGS.retryFrequency,
    maxRetries: Number.isSafeInteger(value.maxRetries) ? value.maxRetries : DEFAULT_CLAUDE_TASK_SETTINGS.maxRetries,
  };
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") return null;
  if (!isUuid(value.id) || typeof value.cwd !== "string" || !value.cwd) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.slice(-MAX_TRANSCRIPT_ITEMS).map(normalizeTranscriptItem).filter(Boolean)
      .map((item) => item.type === "message" ? { ...item, streaming: false } : item)
    : [];
  return {
    id: value.id,
    cwd: value.cwd,
    name: typeof value.name === "string" ? value.name.slice(0, 200) : "Claude 对话",
    nameOrigin: ["default", "prompt", "user"].includes(value.nameOrigin) ? value.nameOrigin : "legacy",
    model: typeof value.model === "string" ? value.model.slice(0, 128) : DEFAULT_MODEL,
    permissionMode: PERMISSION_MODES.has(value.permissionMode) ? value.permissionMode : DEFAULT_PERMISSION_MODE,
    effort: EFFORT_LEVELS.has(value.effort) ? value.effort : null,
    ...normalizeClaudeExecutionSettings(value),
    ...normalizeClaudeLaunchSettings(value),
    forkedFrom: typeof value.forkedFrom === "string" ? value.forkedFrom : null,
    providerId: normalizeProviderId(value.providerId),
    providerName: typeof value.providerName === "string" ? value.providerName.slice(0, 128) : null,
    officialAccountId: normalizeClaudeAccountId(value.officialAccountId),
    officialAccountName: typeof value.officialAccountName === "string"
      ? value.officialAccountName.slice(0, 128)
      : null,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    archived: value.archived === true,
    nativeSessionId: isUuid(value.nativeSessionId) ? value.nativeSessionId : value.id,
    nativeStarted: value.nativeStarted === true || messages.some((item) => item.type === "message" && item.role === "assistant"),
    pendingForkNativeId: isUuid(value.pendingForkNativeId) ? value.pendingForkNativeId : null,
    nativeSource: value.nativeSource === true,
    workspaceMode: value.workspaceMode === "worktree" ? "worktree" : "project",
    worktreeName: validWorktreeName(value.worktreeName) ? value.worktreeName : null,
    additionalDirectories: normalizeStoredAdditionalDirectories(value.additionalDirectories, value.cwd),
    nativeCwd: typeof value.nativeCwd === "string" && path.isAbsolute(value.nativeCwd)
      ? path.resolve(value.nativeCwd).slice(0, 4_096)
      : null,
    resolvedModel: typeof value.resolvedModel === "string" ? value.resolvedModel.slice(0, 128) : null,
    suggestion: typeof value.suggestion === "string" ? value.suggestion.slice(0, 2_000) : null,
    lastResult: value.lastResult && typeof value.lastResult === "object" ? sanitizeResult(value.lastResult, true) : null,
    pendingTurn: normalizePendingTurn(value.pendingTurn),
    pendingApprovals: normalizePendingApprovals(value.pendingApprovals || (
      value.pendingApproval ? [value.pendingApproval] : []
    )),
    messages,
  };
}

function publicMemory(cwd, text) {
  const value = typeof text === "string" ? text.slice(0, MAX_MEMORY_LENGTH) : "";
  return {
    cwd,
    text: value,
    configured: Boolean(value),
    length: value.length,
  };
}

function normalizeHooks(value) {
  if (!Array.isArray(value)) throw runtimeError(400, "Claude Hooks 配置必须是数组");
  if (value.length > MAX_HOOKS) throw runtimeError(400, `Claude Hooks 最多配置 ${MAX_HOOKS} 条`);
  const normalized = value.map(normalizeHook);
  if (normalized.some((entry) => !entry)) throw runtimeError(400, "Claude Hooks 配置无效");
  return normalized;
}

function normalizeHook(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = typeof value.event === "string" ? value.event.trim() : "";
  const matcher = typeof value.matcher === "string" ? value.matcher.trim() : "";
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const timeout = value.timeout === undefined || value.timeout === ""
    ? 10
    : Number(value.timeout);
  if (!HOOK_EVENTS.has(event)) return null;
  if (matcher.length > MAX_HOOK_MATCHER_LENGTH) return null;
  if (!command || command.length > MAX_HOOK_COMMAND_LENGTH) return null;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_HOOK_TIMEOUT_SECONDS) return null;
  return {
    event,
    matcher,
    command,
    timeout,
  };
}

function flattenNativeHooks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = [];
  for (const [event, groups] of Object.entries(value)) {
    if (!HOOK_EVENTS.has(event) || !Array.isArray(groups)) return null;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks)) return null;
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      for (const hook of group.hooks) {
        if (!hook || hook.type !== "command") return null;
        const normalized = normalizeHook({
          event,
          matcher,
          command: hook.command,
          timeout: hook.timeout,
        });
        if (!normalized) return null;
        entries.push(normalized);
        if (entries.length > MAX_HOOKS) return null;
      }
    }
  }
  return entries;
}

function buildNativeHooks(entries) {
  const native = {};
  for (const hook of entries) {
    native[hook.event] ||= [];
    let group = native[hook.event].find((entry) => entry.matcher === hook.matcher);
    if (!group) {
      group = { matcher: hook.matcher, hooks: [] };
      native[hook.event].push(group);
    }
    group.hooks.push({ type: "command", command: hook.command, timeout: hook.timeout });
  }
  return native;
}

function publicHooks(cwd, hooks) {
  const entries = Array.isArray(hooks) ? hooks.map(normalizeHook).filter(Boolean) : [];
  return {
    cwd,
    hooks: entries,
    configured: entries.length > 0,
    count: entries.length,
    native: buildNativeHooks(entries),
  };
}

function normalizePendingTurn(value) {
  if (!value || typeof value !== "object") return null;
  const status = [
    "interrupted",
    "inProgress",
    "stopping",
    "recoveryPending",
    "resuming",
    "pausing",
    "paused",
    "retryWaiting",
    "retrying",
  ].includes(value.status) ? value.status : null;
  if (!status) return null;
  const messageId = typeof value.messageId === "string" ? value.messageId.slice(0, 256) : null;
  const clientMessageId = normalizeClientMessageId(value.clientMessageId);
  if (!messageId && !clientMessageId) return null;
  return {
    runId: isUuid(value.runId) ? value.runId : crypto.randomUUID(),
    messageId,
    clientMessageId,
    startedAt: Number(value.startedAt) || Date.now(),
    lastActivityAt: Number(value.lastActivityAt) || Number(value.startedAt) || Date.now(),
    status,
    ...(Number(value.interruptedAt) ? { interruptedAt: Number(value.interruptedAt) } : {}),
    ...(Number(value.stopRequestedAt) ? { stopRequestedAt: Number(value.stopRequestedAt) } : {}),
    ...(Number(value.recoveryAt) ? { recoveryAt: Number(value.recoveryAt) } : {}),
    ...(typeof value.recoveryReason === "string" ? { recoveryReason: safeRecoveryReason(value.recoveryReason) } : {}),
    ...(value.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
    ...(isUuid(value.recoveredFromRunId) ? { recoveredFromRunId: value.recoveredFromRunId } : {}),
    ...(Number(value.resumeRequestedAt) ? { resumeRequestedAt: Number(value.resumeRequestedAt) } : {}),
    ...(typeof value.pauseMode === "string" && ["after-turn", "immediate"].includes(value.pauseMode)
      ? { pauseMode: value.pauseMode } : {}),
    ...(Number(value.pauseRequestedAt) ? { pauseRequestedAt: Number(value.pauseRequestedAt) } : {}),
    ...(Number(value.pausedAt) ? { pausedAt: Number(value.pausedAt) } : {}),
    ...(Number.isSafeInteger(value.retryAttempts) && value.retryAttempts >= 0
      ? { retryAttempts: Math.min(1_000_000, value.retryAttempts) } : {}),
    ...(Number(value.nextRetryAt) ? { nextRetryAt: Number(value.nextRetryAt) } : {}),
    ...(typeof value.retryReason === "string" ? { retryReason: safeRetryReason(value.retryReason) } : {}),
    ...(typeof value.retryClass === "string" ? { retryClass: safeFailureClass(value.retryClass) } : {}),
    ...(value.safeToRetry === true ? { safeToRetry: true } : {}),
    ...(normalizeProviderId(value.providerBefore) ? { providerBefore: normalizeProviderId(value.providerBefore) } : {}),
    ...(normalizeProviderId(value.providerAfter) ? { providerAfter: normalizeProviderId(value.providerAfter) } : {}),
    ...(normalizeClaudeAccountId(value.officialAccountBefore)
      ? { officialAccountBefore: normalizeClaudeAccountId(value.officialAccountBefore) }
      : {}),
    ...(normalizeClaudeAccountId(value.officialAccountAfter)
      ? { officialAccountAfter: normalizeClaudeAccountId(value.officialAccountAfter) }
      : {}),
    ...(typeof value.error === "string" ? { error: safeRecoveryError(value.error) } : {}),
  };
}

function normalizePendingApprovals(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-16).map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const id = typeof entry.id === "string" ? entry.id.slice(0, 256) : "";
    if (!id) return null;
    return {
      id,
      kind: typeof entry.kind === "string" ? entry.kind.slice(0, 64) : "permission",
      toolName: cleanControlText(entry.toolName, 256) || null,
      requestedAt: Number(entry.requestedAt) || Date.now(),
      expiresAt: Number(entry.expiresAt) || null,
      status: entry.status === "expired" ? "expired" : "waiting",
    };
  }).filter(Boolean);
}

function recoverPersistedClaudeState(session) {
  let changed = false;
  if (session.pendingTurn && ["inProgress", "stopping", "resuming"].includes(session.pendingTurn.status)) {
    session.pendingTurn = {
      ...session.pendingTurn,
      status: "recoveryPending",
      recoveryReason: "runtime-restarted",
      recoveryAt: Date.now(),
      requiresConfirmation: true,
      error: "服务器运行时已重启，任务没有被自动重放",
    };
    changed = true;
  }
  if (session.pendingTurn?.status === "retrying") {
    session.pendingTurn = {
      ...session.pendingTurn,
      status: "retryWaiting",
      nextRetryAt: Date.now(),
      retryReason: session.pendingTurn.retryReason || "network",
      error: "服务器运行时已重启，等待安全重试",
    };
    changed = true;
  }
  if (session.pendingApprovals.length) {
    session.pendingApprovals = session.pendingApprovals.map((entry) => ({
      ...entry,
      status: "expired",
    }));
    changed = true;
  }
  return changed;
}

function safeRecoveryReason(value) {
  return /^(?:runtime-restarted|delivery-unknown|process-exit|user-interrupt|dismissed|send-failed|paused|retry-exhausted|unsafe-retry)$/.test(value)
    ? value
    : "process-exit";
}

function safeRetryReason(value) {
  return /^(?:network|timeout|rate-limit|server|quota|auth|unknown)$/.test(value) ? value : "unknown";
}

function safeFailureClass(value) {
  return /^(?:network|timeout|rate-limit|server|quota|auth|permanent|unknown)$/.test(value)
    ? value
    : "unknown";
}

function officialQuotaSample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = /^(?:five_hour|seven_day|seven_day_opus|seven_day_sonnet|seven_day_overage_included|overage)$/.test(
    String(value.rateLimitType || ""),
  )
    ? value.rateLimitType
    : null;
  const status = /^(?:allowed|allowed_warning|rejected)$/.test(String(value.status || ""))
    ? value.status
    : "unknown";
  const utilization = Number(value.utilization);
  const resetsAt = Number(value.resetsAt);
  if (!type && status === "unknown") return null;
  return {
    type,
    status,
    utilization: Number.isFinite(utilization) ? utilization : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    observedAt: Date.now(),
  };
}

export function classifyClaudeFailure(value = {}) {
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const signal = typeof value.signal === "string" ? value.signal.toLowerCase() : "";
  const text = [
    value.message,
    value.error,
    value.subtype,
    value.failureClass,
  ].filter((entry) => typeof entry === "string").join(" ").toLowerCase();
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|invalid[_ -]?api[_ -]?key|authentication)\b/.test(text)) {
    return { class: "auth", retryable: false, safeToRetry: false };
  }
  if (/\b(?:402|quota|credit|insufficient[_ -]?balance|billing)\b/.test(text)) {
    return { class: "quota", retryable: false, safeToRetry: false };
  }
  if (/\b(?:429|rate[_ -]?limit|too many requests|overloaded)\b/.test(text)) {
    return {
      class: "rate-limit",
      retryable: true,
      safeToRetry: true,
      retryAfterMs: normalizeRetryAfter(value.retryAfterMs ?? value.retry_after_ms),
    };
  }
  if (/\b(?:timeout|timed out|econnreset|econnrefused|enotfound|enetunreach|eai_again|network|socket)\b/.test(text)
    || ["etimedout", "econnreset", "econnrefused", "enotfound", "enetunreach", "eai_again"].includes(code)) {
    return { class: code === "etimedout" || /\btimeout/.test(text) ? "timeout" : "network", retryable: true, safeToRetry: true };
  }
  if (/\b(?:500|502|503|504|server error|service unavailable|bad gateway)\b/.test(text)) {
    return { class: "server", retryable: true, safeToRetry: true };
  }
  if (signal === "sigint" || signal === "sigterm") {
    return { class: "permanent", retryable: false, safeToRetry: false };
  }
  return { class: "unknown", retryable: false, safeToRetry: false };
}

function normalizeRetryAfter(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(30 * 60_000, Math.max(1_000, Math.round(number)));
}

function safeRecoveryError(value) {
  return String(value || "").replace(/[\0\r\n]/g, " ").slice(0, 240)
    .replace(/(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|(?:api[_-]?key|token|secret|password|cookie|authorization)\s*[:=]\s*[^\s,;]+)/gi, "[已隐藏]");
}

function publicSession(session, includeMessages = false, child = null) {
  const pendingStatus = session.pendingTurn?.status;
  let status = "idle";
  if (pendingStatus === "pausing" || pendingStatus === "stopping") status = "stopping";
  else if (child?.turnActive || ["inProgress", "retrying"].includes(pendingStatus)) status = "inProgress";
  else if (pendingStatus === "paused") status = "paused";
  else if (pendingStatus === "retryWaiting") status = "retryWaiting";
  else if (["recoveryPending", "resuming"].includes(pendingStatus)) status = "recoveryPending";
  else if (pendingStatus === "interrupted") status = "interrupted";
  const provider = session.providerId
    ? { id: session.providerId, name: session.providerName || "Claude API 供应商", kind: "api" }
    : {
      id: session.officialAccountId || null,
      name: session.officialAccountName || "Claude 官方账号",
      kind: "official",
    };
  return {
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    nameOrigin: session.nameOrigin,
    preview: session.messages.filter((item) => item.role === "user").at(-1)?.content?.slice(0, 500) || "",
    model: session.model,
    providerId: session.providerId || null,
    officialAccountId: session.officialAccountId || null,
    provider,
    permissionMode: session.permissionMode,
    effort: session.effort,
    fallbackModel: session.fallbackModel,
    maxBudgetUsd: session.maxBudgetUsd,
    allowedTools: [...session.allowedTools],
    disallowedTools: [...session.disallowedTools],
    agent: session.agent,
    systemPrompt: session.systemPrompt,
    excludeDynamicSystemPromptSections: session.excludeDynamicSystemPromptSections,
    settingSources: [...session.settingSources],
    safeMode: session.safeMode,
    strictMcpConfig: session.strictMcpConfig,
    mcpServerNames: [...session.mcpServerNames],
    noSessionPersistence: session.noSessionPersistence,
    jsonSchema: session.jsonSchema,
    inlineAgentNames: [...session.inlineAgentNames],
    brief: session.brief,
    autocompact: session.autocompact,
    remoteFiles: session.remoteFiles.map((entry) => ({ ...entry })),
    fromPr: session.fromPr,
    pluginDirectories: [...session.pluginDirectories],
    pluginUrls: [...session.pluginUrls],
    betaHeaders: [...session.betaHeaders],
    resolvedModel: session.resolvedModel,
    suggestion: session.suggestion,
    lastResult: session.lastResult,
    usageSummary: claudeUsageSummary(session),
    rewindTargets: session.messages
      .filter((item) => item.type === "message" && item.role === "user")
      .slice(-64)
      .map((item) => ({
        id: item.id,
        preview: String(item.content || "").replace(/\s+/g, " ").slice(0, 180),
        at: item.at,
        available: Boolean(item.nativeMessageId && isUuid(item.nativeMessageId)),
      })),
    forkedFrom: session.forkedFrom,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archived: session.archived === true,
    nativeStarted: session.nativeStarted === true,
    nativeSource: session.nativeSource === true,
    workspaceMode: session.workspaceMode,
    worktreeName: session.worktreeName,
    additionalDirectories: [...session.additionalDirectories],
    nativeCwd: session.nativeCwd,
    status,
    runId: child?.runId || session.pendingTurn?.runId || null,
    startedAt: session.pendingTurn?.startedAt || null,
    lastActivityAt: session.pendingTurn?.lastActivityAt || null,
    pendingApprovals: session.pendingApprovals.map((entry) => ({ ...entry })),
    recovery: ["recoveryPending", "interrupted"].includes(session.pendingTurn?.status)
      ? {
        runId: session.pendingTurn.runId,
        messageId: session.pendingTurn.messageId,
        clientMessageId: session.pendingTurn.clientMessageId,
        status: session.pendingTurn.status,
        reason: session.pendingTurn.recoveryReason || null,
        requiresConfirmation: session.pendingTurn.requiresConfirmation === true,
        startedAt: session.pendingTurn.startedAt || null,
        lastActivityAt: session.pendingTurn.lastActivityAt || null,
        interruptedAt: session.pendingTurn.interruptedAt || null,
        error: session.pendingTurn.error || "Claude 任务已中断，可重新发送",
      }
      : null,
    pause: ["pausing", "paused"].includes(session.pendingTurn?.status)
      ? {
        runId: session.pendingTurn.runId,
        status: session.pendingTurn.status,
        mode: session.pendingTurn.pauseMode || "immediate",
        requestedAt: session.pendingTurn.pauseRequestedAt || null,
        pausedAt: session.pendingTurn.pausedAt || null,
        startedAt: session.pendingTurn.startedAt || null,
        lastActivityAt: session.pendingTurn.lastActivityAt || null,
      }
      : null,
    retry: ["retryWaiting", "retrying"].includes(session.pendingTurn?.status)
      ? {
        runId: session.pendingTurn.runId,
        status: session.pendingTurn.status,
        attempts: session.pendingTurn.retryAttempts || 0,
        nextRetryAt: session.pendingTurn.nextRetryAt || null,
        reason: session.pendingTurn.retryReason || null,
        failureClass: session.pendingTurn.retryClass || null,
        startedAt: session.pendingTurn.startedAt || null,
        lastActivityAt: session.pendingTurn.lastActivityAt || null,
      }
      : null,
    ...(includeMessages ? { messages: session.messages.map(publicTranscriptItem) } : {}),
  };
}

function publicTranscriptItem(item) {
  if (!item || typeof item !== "object") return item;
  const copy = { ...item };
  delete copy.nativeMessageId;
  return copy;
}

function sanitizeResult(event, stored = false) {
  const structuredOutput = sanitizeStructuredOutput(
    stored ? event.structuredOutput : event.structured_output,
  );
  return {
    subtype: typeof event.subtype === "string" ? event.subtype.slice(0, 64) : null,
    isError: stored ? event.isError === true : event.is_error === true,
    durationMs: safeInteger(stored ? event.durationMs : event.duration_ms),
    durationApiMs: safeInteger(stored ? event.durationApiMs : event.duration_api_ms),
    costUsd: safeNumber(stored ? event.costUsd : event.total_cost_usd),
    numTurns: safeInteger(stored ? event.numTurns : event.num_turns),
    sessionId: typeof (stored ? event.sessionId : event.session_id) === "string" ? (stored ? event.sessionId : event.session_id) : null,
    terminalReason: typeof (stored ? event.terminalReason : event.terminal_reason) === "string" ? (stored ? event.terminalReason : event.terminal_reason).slice(0, 64) : null,
    apiErrorStatus: typeof (stored ? event.apiErrorStatus : event.api_error_status) === "string" ? (stored ? event.apiErrorStatus : event.api_error_status).slice(0, 128) : null,
    usage: sanitizeUsage(event.usage),
    modelUsage: sanitizeModelUsage(event.modelUsage),
    permissionDenials: sanitizePermissionDenials(stored ? event.permissionDenials : event.permission_denials),
    structuredOutput,
  };
}

function sanitizeStructuredOutput(value) {
  if (value === undefined || value === null) return null;
  if (!boundedJsonTree(value, MAX_CLAUDE_JSON_SCHEMA_NODES, MAX_CLAUDE_JSON_SCHEMA_DEPTH)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > MAX_CLAUDE_JSON_SCHEMA_LENGTH) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function sanitizeRewindResult(value, cwd) {
  const response = value && typeof value === "object" ? value : {};
  const filesChanged = [];
  for (const entry of Array.isArray(response.filesChanged) ? response.filesChanged.slice(0, 256) : []) {
    if (typeof entry !== "string" || !entry || entry.length > 4_096 || /[\0\r\n]/.test(entry)) continue;
    const resolved = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(cwd, entry);
    if (!pathWithin(cwd, resolved)) continue;
    const relative = path.relative(cwd, resolved) || path.basename(resolved);
    if (!filesChanged.includes(relative)) filesChanged.push(relative);
  }
  return {
    canRewind: response.canRewind === true,
    error: cleanControlText(response.error, 1_000) || null,
    filesChanged,
    insertions: safeInteger(response.insertions) || 0,
    deletions: safeInteger(response.deletions) || 0,
    skippedLinks: safeInteger(response.skippedLinks) || 0,
  };
}

function claudeUsageSummary(session) {
  const results = session.messages.filter((item) => item.type === "result");
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
    modelTurns: 0,
  };
  for (const result of results) {
    const usage = result.usage || {};
    const input = safeInteger(usage.input_tokens) || 0;
    const output = safeInteger(usage.output_tokens) || 0;
    const cacheCreation = safeInteger(usage.cache_creation_input_tokens) || 0;
    const cacheRead = safeInteger(usage.cache_read_input_tokens) || 0;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cacheCreationTokens += cacheCreation;
    totals.cacheReadTokens += cacheRead;
    totals.totalTokens += input + output + cacheCreation + cacheRead;
    totals.costUsd += safeNumber(result.costUsd) || 0;
    totals.durationMs += safeInteger(result.durationMs) || 0;
    totals.modelTurns += safeInteger(result.numTurns) || 0;
  }
  const last = results.at(-1);
  const lastUsage = last?.usage || {};
  const contextParts = [
    lastUsage.input_tokens,
    lastUsage.cache_creation_input_tokens,
    lastUsage.cache_read_input_tokens,
  ].map(safeInteger).filter((value) => value !== null);
  const contextUsedTokens = last && contextParts.length
    ? contextParts.reduce((sum, value) => sum + value, 0)
    : null;
  const compactions = session.messages.filter((item) => item.type === "system" && /compact/i.test(item.subtype || ""));
  return {
    requestCount: results.length,
    ...totals,
    contextUsedTokens,
    contextWindowTokens: claudeContextWindow(session.resolvedModel || session.model),
    compactionCount: compactions.length,
    lastCompactionAt: compactions.at(-1)?.at || null,
  };
}

function claudeContextWindow(model) {
  return /(?:claude|sonnet|opus|haiku|fable)/i.test(String(model || "")) ? 200_000 : null;
}

function normalizeTranscriptItem(value) {
  if (!value || typeof value !== "object") return null;
  const type = typeof value.type === "string" ? value.type : (["user", "assistant"].includes(value.role) ? "message" : null);
  const id = String(value.id || crypto.randomUUID()).slice(0, 256);
  const at = Number(value.at) || Date.now();
  if (type === "message" && ["user", "assistant"].includes(value.role)) {
    return {
      id,
      type,
      role: value.role,
      content: String(value.content || "").slice(0, MAX_ITEM_TEXT),
      ...(value.role === "user" ? {
        attachments: normalizeAttachments(value.attachments),
        ...(isUuid(value.runId) ? { runId: value.runId } : {}),
        ...(normalizeClientMessageId(value.clientMessageId) ? { clientMessageId: normalizeClientMessageId(value.clientMessageId) } : {}),
        ...(normalizeNativeMessageId(value.nativeMessageId) ? { nativeMessageId: normalizeNativeMessageId(value.nativeMessageId) } : {}),
      } : {}),
      at,
      streaming: value.streaming === true,
    };
  }
  if (type === "thinking") {
    return { id, type, content: String(value.content || "").slice(0, MAX_ITEM_TEXT), status: normalizeStatus(value.status), at };
  }
  if (type === "tool") {
    return {
      id, type,
      toolUseId: String(value.toolUseId || id).slice(0, 256),
      name: String(value.name || "Tool").slice(0, 256),
      title: String(value.title || toolTitle(value.name, value.input)).slice(0, 500),
      category: toolCategory(value.name),
      input: boundedJson(value.input),
      output: String(value.output || "").slice(-MAX_ITEM_TEXT),
      result: boundedJson(value.result),
      status: normalizeStatus(value.status),
      isError: value.isError === true,
      parentToolUseId: typeof value.parentToolUseId === "string" ? value.parentToolUseId.slice(0, 256) : null,
      at,
      updatedAt: Number(value.updatedAt) || at,
    };
  }
  if (type === "result") {
    return { id, type, status: normalizeStatus(value.status), ...sanitizeResult(value, true), at };
  }
  if (type === "system") {
    return {
      id, type,
      subtype: typeof value.subtype === "string" ? value.subtype.slice(0, 128) : null,
      content: String(value.content || "").slice(0, MAX_ITEM_TEXT),
      status: normalizeStatus(value.status),
      at,
    };
  }
  if (type === "task") {
    const status = normalizeStatus(value.status);
    const startedAt = normalizeClaudeEventTimestamp(value.startedAt) || at;
    const updatedAt = normalizeClaudeEventTimestamp(value.updatedAt) || startedAt;
    return {
      id,
      type,
      subtype: typeof value.subtype === "string" ? value.subtype.slice(0, 128) : null,
      taskId: cleanControlText(value.taskId, 256) || id.replace(/^task:/, ""),
      toolUseId: cleanControlText(value.toolUseId, 256) || null,
      parentTaskId: cleanControlText(value.parentTaskId, 256) || null,
      agentId: cleanControlText(value.agentId, 256) || null,
      subagentType: cleanControlText(value.subagentType, 128) || null,
      taskType: cleanControlText(value.taskType, 128) || null,
      workflowName: cleanControlText(value.workflowName, 128) || null,
      lastToolName: cleanControlText(value.lastToolName, 256) || null,
      usage: sanitizeClaudeTaskUsage(value.usage),
      title: cleanControlText(value.title, 500) || "Claude Agent 任务",
      content: String(value.content || "").slice(0, MAX_ITEM_TEXT),
      status,
      startedAt,
      updatedAt,
      finishedAt: ["completed", "failed", "interrupted"].includes(status)
        ? normalizeClaudeEventTimestamp(value.finishedAt) || updatedAt
        : null,
      at,
    };
  }
  return null;
}

function transcriptTool(id, name, input, status) {
  return normalizeTranscriptItem({
    id: id || crypto.randomUUID(),
    type: "tool",
    toolUseId: id,
    name,
    title: toolTitle(name, input),
    category: toolCategory(name),
    input,
    output: "",
    status,
    at: Date.now(),
  });
}

function toolCategory(name) {
  const normalized = String(name || "");
  if (normalized === "Bash") return "command";
  if (["Edit", "Write", "NotebookEdit"].includes(normalized)) return "file";
  if (normalized.startsWith("mcp__")) return "mcp";
  if (["Task", "TaskCreate", "TaskUpdate", "TaskOutput", "SendMessage"].includes(normalized)) return "agent";
  if (["Read", "Glob", "Grep"].includes(normalized)) return "read";
  if (["WebFetch", "WebSearch"].includes(normalized)) return "web";
  return "tool";
}

function toolTitle(name, input) {
  const normalized = String(name || "Tool");
  const pathValue = input && typeof input === "object" ? input.file_path || input.path || input.notebook_path : null;
  if (pathValue) return `${normalized} · ${String(pathValue).slice(0, 360)}`;
  if (normalized === "Bash" && input?.command) return String(input.command).split("\n", 1)[0].slice(0, 420);
  if (normalized.startsWith("mcp__")) return normalized.split("__").filter(Boolean).join(" / ");
  return normalized;
}

function extractToolResult(content, structured) {
  if (typeof content === "string") return content.slice(-MAX_ITEM_TEXT);
  if (Array.isArray(content)) {
    const text = content.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry?.type === "text") return entry.text || "";
      if (entry?.type === "image") return "[图片结果]";
      return boundedJsonText(entry);
    }).filter(Boolean).join("\n");
    if (text) return text.slice(-MAX_ITEM_TEXT);
  }
  return boundedJsonText(structured ?? content).slice(-MAX_ITEM_TEXT);
}

function boundedJson(value) {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    if (text.length > MAX_ITEM_TEXT) return `${text.slice(0, MAX_ITEM_TEXT)}…`;
    return JSON.parse(text);
  } catch {
    return String(value).slice(0, MAX_ITEM_TEXT);
  }
}

function boundedJsonText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ATTACHMENTS).map((attachment) => {
    if (!attachment || typeof attachment !== "object" || typeof attachment.path !== "string" || !attachment.path) return null;
    return {
      name: String(attachment.name || path.basename(attachment.path)).slice(0, 200),
      path: attachment.path.slice(0, 4_096),
      mediaType: String(attachment.mediaType || "application/octet-stream").slice(0, 100),
      size: safeInteger(attachment.size),
    };
  }).filter(Boolean);
}

function claudePrompt(text, attachments) {
  if (!attachments.length) return text;
  const files = attachments.map((attachment, index) => {
    const kind = attachment.mediaType.startsWith("image/") ? "image" : "file";
    return `${index + 1}. [${kind}] ${attachment.path}`;
  });
  return [
    text,
    "The user attached the following project files. Use the Read tool to inspect them when needed:",
    ...files,
  ].filter(Boolean).join("\n\n");
}

function sanitizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const fields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  const result = Object.fromEntries(fields.map((field) => [field, safeInteger(value[field])]).filter(([, entry]) => entry !== null));
  return Object.keys(result).length ? result : null;
}

function sanitizeModelUsage(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [model, usage] of Object.entries(value).slice(0, 12)) {
    result[String(model).slice(0, 128)] = {
      ...sanitizeUsage(usage),
      costUsd: safeNumber(usage?.costUSD ?? usage?.cost_usd),
    };
  }
  return Object.keys(result).length ? result : null;
}

function sanitizePermissionDenials(value) {
  if (!Array.isArray(value) || !value.length) return [];
  return value.slice(0, 20).map((entry) => boundedJson(entry));
}

function systemEventText(event) {
  const details = event.message || event.status || event.compact_metadata?.trigger || event.hook_name || event.subtype;
  return typeof details === "string" ? details.slice(0, MAX_ITEM_TEXT) : boundedJsonText(details).slice(0, MAX_ITEM_TEXT);
}

function hookEventText(event) {
  const lifecycle = cleanControlText(
    event.hook_event_name || event.hook_event || event.event_name || event.event,
    128,
  );
  const name = cleanControlText(event.hook_name || event.name, 256);
  const details = cleanControlText(
    event.message
      || event.status
      || event.error
      || event.stdout
      || event.stderr
      || event.outcome,
    2_000,
  );
  const content = [lifecycle, name, details].filter(Boolean).join(" · ");
  return (content || String(event.type || "Claude Hook")).slice(0, MAX_ITEM_TEXT);
}

function safeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeStatus(value) {
  return ["inProgress", "completed", "failed", "interrupted"].includes(value) ? value : "completed";
}

function claudeTaskEventType(event) {
  const type = event?.type === "system" ? event?.subtype : event?.type;
  return ["task_started", "task_progress", "task_notification"].includes(type) ? type : null;
}

function claudeTaskEventStatus(event, taskEventType = claudeTaskEventType(event)) {
  const status = String(event?.status || event?.state || "").trim().toLowerCase();
  if (/(?:fail|error)/.test(status)) return "failed";
  if (/(?:interrupt|cancel|stop)/.test(status)) return "interrupted";
  if (/(?:complete|completed|done|success|succeeded)/.test(status)) return "completed";
  return taskEventType === "task_notification" ? "completed" : "inProgress";
}

function normalizeClaudeEventTimestamp(value) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) return null;
  return Math.trunc(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp);
}

function sanitizeClaudeTaskUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const totalTokens = safeInteger(value.totalTokens ?? value.total_tokens);
  const toolUses = safeInteger(value.toolUses ?? value.tool_uses);
  const durationMs = safeInteger(value.durationMs ?? value.duration_ms);
  const usage = {
    ...(totalTokens !== null ? { totalTokens } : {}),
    ...(toolUses !== null ? { toolUses } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
  return Object.keys(usage).length ? usage : null;
}

function scopedControlRequestId(sessionId, nativeRequestId) {
  const digest = crypto.createHash("sha256")
    .update(String(nativeRequestId || ""))
    .digest("hex")
    .slice(0, 24);
  return `claude-${String(sessionId || "").slice(0, 36)}-${digest}`;
}

function sanitizeDialogRequest(sessionId, requestId, request, timeoutMs) {
  if (request.dialog_kind !== "refusal_fallback_prompt") return null;
  const payload = boundedControlJson(request.payload);
  if (!payload) return null;
  const originalModel = cleanControlText(payload.originalModel, 128);
  const fallbackModel = cleanControlText(payload.fallbackModel, 128);
  if (!originalModel || !fallbackModel) return null;
  const createdAt = Date.now();
  return {
    id: requestId,
    sessionId,
    kind: "dialog",
    dialogKind: "refusal_fallback_prompt",
    toolUseId: cleanControlText(request.tool_use_id, 256) || null,
    originalModel,
    fallbackModel,
    apiRefusalCategory: typeof payload.apiRefusalCategory === "string"
      ? cleanControlText(payload.apiRefusalCategory, 128)
      : null,
    guidanceText: cleanControlText(payload.guidanceText, 2_000) || null,
    createdAt,
    expiresAt: createdAt + timeoutMs,
  };
}

function sanitizeElicitationRequest(sessionId, requestId, request, timeoutMs) {
  const serverName = cleanControlText(request.mcp_server_name, 256);
  const message = cleanControlText(request.message, 4_000);
  const mode = request.mode === undefined ? "form" : request.mode;
  if (!serverName || !message || !["form", "url"].includes(mode)) return null;
  const createdAt = Date.now();
  const base = {
    id: requestId,
    sessionId,
    kind: "elicitation",
    mode,
    serverName,
    message,
    elicitationId: cleanControlText(request.elicitation_id, 256) || null,
    title: cleanControlText(request.title, 500) || null,
    displayName: cleanControlText(request.display_name, 256) || null,
    description: cleanControlText(request.description, 2_000) || null,
    createdAt,
    expiresAt: createdAt + timeoutMs,
  };
  if (mode === "url") {
    const url = safeElicitationUrl(request.url);
    if (!url || !base.elicitationId) return null;
    return { ...base, url, fields: null };
  }
  const fields = sanitizeElicitationSchema(request.requested_schema);
  if (!fields) return null;
  return { ...base, url: null, fields };
}

function sanitizeElicitationSchema(value) {
  const schema = boundedControlJson(value);
  if (!schema || !hasOnlyKeys(schema, ["type", "properties", "required"])) return null;
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    return null;
  }
  const entries = Object.entries(schema.properties);
  if (!entries.length || entries.length > MAX_ELICITATION_PROPERTIES) return null;
  const names = new Set(entries.map(([name]) => name));
  const reservedNames = new Set(["__proto__", "prototype", "constructor"]);
  if ([...names].some((name) => reservedNames.has(name) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name))) return null;
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.length > entries.length) return null;
  if (required.some((name) => typeof name !== "string" || !names.has(name)) || new Set(required).size !== required.length) {
    return null;
  }
  const requiredNames = new Set(required);
  const fields = [];
  for (const [name, property] of entries) {
    const field = sanitizeElicitationField(name, property, requiredNames.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}

function sanitizeElicitationField(name, property, required) {
  if (!property || typeof property !== "object" || Array.isArray(property)) return null;
  const type = property.type;
  const allowedKeys = type === "string"
    ? ["type", "title", "description", "default", "enum", "minLength", "maxLength"]
    : ["number", "integer"].includes(type)
      ? ["type", "title", "description", "default", "enum", "minimum", "maximum"]
      : ["type", "title", "description", "default", "enum"];
  if (!["string", "number", "integer", "boolean"].includes(type) || !hasOnlyKeys(property, allowedKeys)) return null;
  const title = optionalSchemaText(property.title, 120);
  const description = optionalSchemaText(property.description, 1_000);
  if (title === false || description === false) return null;
  const field = {
    name,
    type,
    required,
    title: title || name,
    description: description || null,
  };
  if (type === "string") {
    const minLength = schemaInteger(property.minLength, 0, MAX_ELICITATION_STRING_LENGTH, 0);
    const maxLength = schemaInteger(property.maxLength, 0, MAX_ELICITATION_STRING_LENGTH, MAX_ELICITATION_STRING_LENGTH);
    if (minLength === null || maxLength === null || minLength > maxLength) return null;
    field.minLength = minLength;
    field.maxLength = maxLength;
  } else if (["number", "integer"].includes(type)) {
    const minimum = schemaFiniteNumber(property.minimum, -Number.MAX_SAFE_INTEGER);
    const maximum = schemaFiniteNumber(property.maximum, Number.MAX_SAFE_INTEGER);
    if (minimum === null || maximum === null || minimum > maximum) return null;
    if (type === "integer" && (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))) return null;
    field.minimum = minimum;
    field.maximum = maximum;
  }
  if (property.enum !== undefined) {
    if (!Array.isArray(property.enum) || !property.enum.length || property.enum.length > MAX_ELICITATION_ENUM_VALUES) return null;
    if (property.enum.some((entry) => !elicitationFieldValueValid(field, entry))) return null;
    if (new Set(property.enum.map((entry) => JSON.stringify(entry))).size !== property.enum.length) return null;
    field.enum = [...property.enum];
  }
  if (Object.hasOwn(property, "default")) {
    if (!elicitationFieldValueValid(field, property.default)) return null;
    if (field.enum && !field.enum.some((entry) => Object.is(entry, property.default))) return null;
    field.hasDefault = true;
    field.default = property.default;
  } else {
    field.hasDefault = false;
  }
  return field;
}

function validateElicitationContent(request, value) {
  const content = boundedControlJson(value);
  if (!content) throw runtimeError(400, "Claude MCP 表单内容无效");
  const fields = request.fields || [];
  const byName = new Map(fields.map((field) => [field.name, field]));
  const keys = Object.keys(content);
  if (keys.length > fields.length || keys.some((key) => !byName.has(key))) {
    throw runtimeError(400, "Claude MCP 表单包含未知字段");
  }
  for (const field of fields) {
    if (!Object.hasOwn(content, field.name)) {
      if (field.required) throw runtimeError(400, `Claude MCP 表单缺少“${field.title}”`);
      continue;
    }
    const entry = content[field.name];
    if (!elicitationFieldValueValid(field, entry)) {
      throw runtimeError(400, `Claude MCP 表单字段“${field.title}”无效`);
    }
    if (field.enum && !field.enum.some((candidate) => Object.is(candidate, entry))) {
      throw runtimeError(400, `Claude MCP 表单字段“${field.title}”不在允许范围内`);
    }
  }
  return content;
}

function elicitationFieldValueValid(field, value) {
  if (field.type === "string") {
    return typeof value === "string" && value.length >= field.minLength && value.length <= field.maxLength;
  }
  if (field.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (field.type === "integer" && !Number.isSafeInteger(value)) return false;
  return value >= field.minimum && value <= field.maximum;
}

function optionalSchemaText(value, limit) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > limit) return false;
  const cleaned = cleanControlText(value, limit);
  return cleaned === value ? cleaned : false;
}

function schemaInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function schemaFiniteNumber(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

function normalizeClaudeMcpScope(value) {
  const scope = value === null || value === undefined || value === "" ? "user" : String(value).trim();
  if (!CLAUDE_MCP_SCOPES.has(scope)) throw runtimeError(400, "Claude MCP 配置作用域无效");
  return scope;
}

async function readClaudeMcpProjectConfiguration(project) {
  const target = path.join(project, ".mcp.json");
  try {
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CLAUDE_CONFIG_BYTES) {
      throw runtimeError(500, "Claude 工程 MCP 配置文件不安全");
    }
    const source = JSON.parse(await fs.readFile(target, "utf8"));
    if (!plainObject(source)) throw runtimeError(500, "Claude 工程 MCP 配置格式无效");
    return source;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw runtimeError(500, "Claude 工程 MCP 配置无法解析");
    throw error;
  }
}

async function writeClaudeMcpProjectConfiguration(project, servers, { uid = null, gid = null } = {}) {
  const current = await readClaudeMcpProjectConfiguration(project);
  const target = path.join(project, ".mcp.json");
  const temporary = path.join(project, `.mcp.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`);
    if (Number.isInteger(uid) && Number.isInteger(gid)) await handle.chown(uid, gid);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function publicMcpServer(name, value, scope = "user") {
  if (!validMcpName(name) || !plainObject(value)) return null;
  const type = ["stdio", "http", "sse"].includes(value.type) ? value.type : "unknown";
  if (type === "stdio") {
    const command = boundedMcpText(value.command, 2_048) || "";
    return {
      name,
      scope,
      type,
      supported: Boolean(command),
      command,
      args: Array.isArray(value.args)
        ? value.args.slice(0, MAX_MCP_ENTRIES).map((entry) => boundedMcpText(entry, 2_048)).filter(Boolean)
        : [],
      environmentKeys: plainObject(value.env) ? Object.keys(value.env).slice(0, MAX_MCP_ENTRIES) : [],
    };
  }
  if (["http", "sse"].includes(type)) {
    const url = normalizedMcpUrl(value.url, false);
    return {
      name,
      scope,
      type,
      supported: Boolean(url),
      url: url || "",
      headerNames: plainObject(value.headers) ? Object.keys(value.headers).slice(0, MAX_MCP_ENTRIES) : [],
    };
  }
  return { name, scope, type, supported: false };
}

function parseClaudeMcpCapabilities(value) {
  const result = { tools: [], resources: [] };
  let section = null;
  for (const rawLine of String(value || "").split(/\r?\n/).slice(0, 2_000)) {
    const line = stripTerminalControl(rawLine).trim();
    if (/^(?:tools?|工具)\s*:/i.test(line)) {
      section = "tools";
      const inline = line.replace(/^[^:]+:\s*/, "");
      if (inline) addClaudeMcpCapability(result.tools, inline);
      continue;
    }
    if (/^(?:resources?|资源)\s*:/i.test(line)) {
      section = "resources";
      const inline = line.replace(/^[^:]+:\s*/, "");
      if (inline) addClaudeMcpCapability(result.resources, inline);
      continue;
    }
    if (/^[A-Za-z][A-Za-z ]{1,30}:/.test(line) && !/^[-*•]/.test(line)) {
      section = null;
      continue;
    }
    if (section && /^[-*•]\s+/.test(line)) {
      addClaudeMcpCapability(result[section], line.replace(/^[-*•]\s+/, ""));
    }
  }
  return result;
}

function addClaudeMcpCapability(target, value) {
  if (target.length >= 100) return;
  const name = cleanControlText(String(value || "").split(/\s{2,}|\s+[—–-]\s+/, 1)[0], 160);
  if (name && !target.includes(name)) target.push(name);
}

function claudeMcpFailureSummary(value) {
  const source = String(value || "");
  if (/\b(?:401|403)\b|unauthori[sz]ed|oauth|authenticate/i.test(source)) return "MCP 服务器需要重新授权";
  if (/timed? out|timeout/i.test(source)) return "MCP 服务器连接超时";
  if (/ENOTFOUND|DNS|name resolution/i.test(source)) return "MCP 服务器域名解析失败";
  if (/ECONNREFUSED|connection refused/i.test(source)) return "MCP 服务器拒绝连接";
  if (/TLS|certificate|SSL/i.test(source)) return "MCP 服务器 TLS 校验失败";
  return "MCP 服务器连接失败，原始诊断已隐藏";
}

function normalizeMcpServerInput(value, previous = null) {
  if (!plainObject(value)) throw runtimeError(400, "Claude MCP 配置无效");
  const name = normalizeMcpName(value.name);
  const type = ["stdio", "http", "sse"].includes(value.type) ? value.type : null;
  if (!type) throw runtimeError(400, "Claude MCP 传输类型无效");
  const sensitiveMode = ["preserve", "replace", "clear"].includes(value.sensitiveMode)
    ? value.sensitiveMode
    : previous ? "preserve" : "clear";
  if (type === "stdio") {
    const command = boundedMcpText(value.command, 2_048);
    if (!command) throw runtimeError(400, "Claude MCP 启动命令无效");
    const args = normalizeMcpArguments(value.args);
    const environment = resolveMcpSensitiveMap({
      mode: sensitiveMode,
      incoming: value.environment,
      previous: previous?.type === "stdio" ? previous.env : null,
      kind: "environment",
    });
    return { name, server: { type, command, ...(args.length ? { args } : {}), ...(Object.keys(environment).length ? { env: environment } : {}) } };
  }
  const url = normalizedMcpUrl(value.url, true);
  const headers = resolveMcpSensitiveMap({
    mode: sensitiveMode,
    incoming: value.headers,
    previous: previous?.type === type ? previous.headers : null,
    kind: "headers",
  });
  return { name, server: { type, url, ...(Object.keys(headers).length ? { headers } : {}) } };
}

function resolveMcpSensitiveMap({ mode, incoming, previous, kind }) {
  if (mode === "preserve") return plainObject(previous) ? { ...previous } : {};
  if (mode === "clear") return {};
  return normalizeMcpStringMap(incoming, kind);
}

function normalizeMcpArguments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_MCP_ENTRIES) throw runtimeError(400, "Claude MCP 命令参数无效");
  return value.map((entry) => {
    const normalized = boundedMcpText(entry, 2_048);
    if (normalized === null) throw runtimeError(400, "Claude MCP 命令参数无效");
    return normalized;
  });
}

function normalizeMcpStringMap(value, kind) {
  if (!plainObject(value) || Object.keys(value).length > MAX_MCP_ENTRIES) {
    throw runtimeError(400, `Claude MCP ${kind === "headers" ? "请求头" : "环境变量"}无效`);
  }
  const result = Object.create(null);
  for (const [name, entry] of Object.entries(value)) {
    const validName = kind === "headers"
      ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
      : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
    const normalized = boundedMcpText(entry, 4_096);
    if (["__proto__", "prototype", "constructor"].includes(name) || !validName || normalized === null) {
      throw runtimeError(400, `Claude MCP ${kind === "headers" ? "请求头" : "环境变量"}无效`);
    }
    result[name] = normalized;
  }
  return result;
}

function normalizedMcpUrl(value, required) {
  if (typeof value !== "string" || !value || value.length > 2_048) {
    if (required) throw runtimeError(400, "Claude MCP URL 无效");
    return null;
  }
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    if (required) throw runtimeError(400, "Claude MCP URL 无效");
    return null;
  }
}

function normalizeMcpName(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!validMcpName(normalized)) throw runtimeError(400, "Claude MCP 名称无效");
  return normalized;
}

function validMcpName(value) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(String(value || ""));
}

function boundedMcpText(value, limit) {
  if (typeof value !== "string" || value.length > limit || /[\u0000\r\n]/.test(value)) return null;
  return value;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripTerminalControl(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(-32_000);
}

function hasOnlyKeys(value, allowed) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function safeElicitationUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sanitizeControlRequest(sessionId, requestId, request, timeoutMs) {
  const toolName = cleanControlText(request.tool_name, 256);
  const toolUseId = cleanControlText(request.tool_use_id, 256);
  const input = boundedControlJson(request.input);
  if (!toolName || !toolUseId || input === null) return null;
  const questions = toolName === "AskUserQuestion" ? sanitizeClaudeQuestions(input.questions) : null;
  if (toolName === "AskUserQuestion" && !questions) return null;
  const suggestions = sanitizePermissionUpdates(request.permission_suggestions);
  const canRemember = toolName !== "AskUserQuestion"
    && request.suppress_always_allow_rule !== true
    && suggestions.length > 0;
  const createdAt = Date.now();
  return {
    id: requestId,
    sessionId,
    kind: toolName === "AskUserQuestion" ? "question" : "permission",
    toolName,
    toolUseId,
    title: cleanControlText(request.title, 500),
    displayName: cleanControlText(request.display_name, 256),
    description: cleanControlText(request.description, 2_000),
    decisionReason: cleanControlText(request.decision_reason, 2_000),
    decisionReasonType: cleanControlText(request.decision_reason_type, 64),
    blockedPath: cleanControlText(request.blocked_path, 2_000),
    input: toolName === "AskUserQuestion" ? null : input,
    questions,
    canRemember,
    rememberLabel: canRemember ? permissionRememberLabel(suggestions) : null,
    requiresUserInteraction: request.requires_user_interaction === true,
    createdAt,
    expiresAt: createdAt + timeoutMs,
  };
}

function sanitizeClaudeQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const questions = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const question = cleanControlText(entry.question, 4_000);
    const header = cleanControlText(entry.header, 120);
    if (!question || !header || !Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 4) return null;
    const options = entry.options.map((option) => ({
      label: cleanControlText(option?.label, 200),
      description: cleanControlText(option?.description, 1_000),
      preview: cleanControlText(option?.preview, 4_000),
    }));
    if (options.some((option) => !option.label)) return null;
    questions.push({ question, header, options, multiSelect: entry.multiSelect === true });
  }
  return questions;
}

function sanitizePermissionUpdates(value) {
  if (!Array.isArray(value)) return [];
  const types = new Set(["addRules", "replaceRules", "removeRules", "setMode", "addDirectories", "removeDirectories"]);
  const destinations = new Set(["userSettings", "projectSettings", "localSettings", "session", "cliArg"]);
  const behaviors = new Set(["allow", "deny", "ask"]);
  const modes = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto", "manual"]);
  const updates = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object" || !types.has(entry.type) || !destinations.has(entry.destination)) return [];
    if (["addRules", "replaceRules", "removeRules"].includes(entry.type)) {
      if (!behaviors.has(entry.behavior) || !Array.isArray(entry.rules) || !entry.rules.length || entry.rules.length > 50) return [];
      const rules = entry.rules.map((rule) => ({
        toolName: cleanControlText(rule?.toolName, 256),
        ...(typeof rule?.ruleContent === "string" ? { ruleContent: cleanControlText(rule.ruleContent, 4_000) } : {}),
      }));
      if (rules.some((rule) => !rule.toolName)) return [];
      updates.push({ type: entry.type, rules, behavior: entry.behavior, destination: entry.destination });
    } else if (entry.type === "setMode") {
      if (!modes.has(entry.mode)) return [];
      updates.push({ type: entry.type, mode: entry.mode, destination: entry.destination });
    } else {
      if (!Array.isArray(entry.directories) || !entry.directories.length || entry.directories.length > 50) return [];
      const directories = entry.directories.map((directory) => cleanControlText(directory, 4_000));
      if (directories.some((directory) => !directory)) return [];
      updates.push({ type: entry.type, directories, destination: entry.destination });
    }
  }
  return updates;
}

function permissionRememberLabel(suggestions) {
  const destinations = new Set(suggestions.map((entry) => entry.destination));
  if ([...destinations].every((destination) => ["session", "cliArg"].includes(destination))) return "本会话允许";
  if (destinations.size === 1 && destinations.has("localSettings")) return "此工程允许";
  if (destinations.size === 1 && destinations.has("projectSettings")) return "工程共享允许";
  if (destinations.size === 1 && destinations.has("userSettings")) return "以后允许";
  return "允许并记住";
}

function controlRequestResponse(pending, result) {
  if (pending.publicRequest.kind === "dialog") return controlDialogResponse(pending, result);
  if (pending.publicRequest.kind === "elicitation") return controlElicitationResponse(pending, result);
  return controlPermissionResponse(pending, result);
}

function controlElicitationResponse(pending, result) {
  if (!result || typeof result !== "object") throw runtimeError(400, "Claude MCP 请求响应无效");
  if (result.decision === "cancel") return { action: "cancel" };
  if (result.decision === "decline") return { action: "decline" };
  if (result.decision !== "accept") throw runtimeError(400, "Claude MCP 请求决定无效");
  if (pending.publicRequest.mode === "url") return { action: "accept" };
  return {
    action: "accept",
    content: validateElicitationContent(pending.publicRequest, result.content),
  };
}

function controlDialogResponse(pending, result) {
  if (!result || typeof result !== "object") throw runtimeError(400, "Claude 对话响应无效");
  if (pending.publicRequest.dialogKind !== "refusal_fallback_prompt") return { behavior: "cancelled" };
  if (result.decision === "cancel") return { behavior: "cancelled" };
  const choices = {
    retryFallback: "retry_fallback",
    editPrompt: "edit_prompt",
  };
  const choice = choices[result.decision];
  if (!choice) throw runtimeError(400, "Claude 对话选择无效");
  return { behavior: "completed", result: choice };
}

function controlCancellationResponse(pending, reason) {
  if (pending.publicRequest.kind === "dialog") return { behavior: "cancelled" };
  if (pending.publicRequest.kind === "elicitation") return { action: "cancel" };
  return {
    behavior: "deny",
    message: cleanControlText(reason, 1_000) || "Claude 请求已取消",
    toolUseID: cleanControlText(pending.request.tool_use_id, 256) || undefined,
  };
}

function controlPermissionResponse(pending, result) {
  if (!result || typeof result !== "object") throw runtimeError(400, "Claude 请求响应无效");
  const toolUseID = cleanControlText(pending.request.tool_use_id, 256) || undefined;
  if (pending.publicRequest.kind === "question") {
    if (result.decision === "deny") {
      return {
        behavior: "deny",
        message: cleanControlText(result.message, 1_000) || "用户跳过了问题",
        toolUseID,
      };
    }
    if (result.decision !== "answer" || !result.answers || typeof result.answers !== "object" || Array.isArray(result.answers)) {
      throw runtimeError(400, "Claude 问题答案无效");
    }
    const answers = {};
    const originalQuestions = pending.request.input.questions;
    pending.publicRequest.questions.forEach((question, index) => {
      const raw = result.answers[question.question];
      const answer = Array.isArray(raw) ? raw.map((entry) => String(entry)).join(", ") : String(raw ?? "");
      if (answer.length > MAX_CONTROL_TEXT) throw runtimeError(400, "Claude 问题答案过长");
      answers[String(originalQuestions[index].question)] = answer;
    });
    return {
      behavior: "allow",
      updatedInput: { ...pending.request.input, answers },
      toolUseID,
    };
  }
  if (result.decision === "allow") return { behavior: "allow", toolUseID };
  if (result.decision === "allowAlways") {
    if (!pending.publicRequest.canRemember || !pending.suggestions.length) {
      throw runtimeError(400, "此 Claude 请求不支持记住权限");
    }
    return { behavior: "allow", updatedPermissions: pending.suggestions, toolUseID };
  }
  if (result.decision === "deny") {
    return {
      behavior: "deny",
      message: cleanControlText(result.message, 1_000) || "用户拒绝了此操作",
      toolUseID,
    };
  }
  throw runtimeError(400, "Claude 权限决定无效");
}

function boundedControlJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > MAX_CONTROL_INPUT) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanControlText(value, limit = MAX_CONTROL_TEXT) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, limit);
}

function writeLine(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
  });
}

function sanitizeAuthStatus(value) {
  return {
    loggedIn: value?.loggedIn === true,
    authMethod: typeof value?.authMethod === "string" ? value.authMethod : null,
    email: typeof value?.email === "string" ? value.email.slice(0, 320) : null,
    subscriptionType: typeof value?.subscriptionType === "string" ? value.subscriptionType.slice(0, 64) : null,
  };
}

function publicLoginState(state, running) {
  if (!running || !state) return null;
  return {
    running: true,
    accountId: normalizeClaudeAccountId(state.accountId),
    requiresCode: state.requiresCode === true,
    codeSubmitted: state.codeSubmitted === true,
    expiresAt: state.expiresAt,
  };
}

function privateLoginState(state, running) {
  const publicState = publicLoginState(state, running);
  return publicState ? {
    ...publicState,
    loginId: state.loginId,
    authorizationUrl: state.authorizationUrl,
  } : null;
}

function extractAuthorizationUrl(output) {
  for (const match of String(output || "").matchAll(/https:\/\/[^\s]+/g)) {
    try {
      const url = new URL(match[0]);
      if (
        url.protocol === "https:"
        && (url.hostname === "claude.com" || url.hostname.endsWith(".claude.com") || url.hostname.endsWith(".anthropic.com"))
      ) return url.href;
    } catch {
      // Keep scanning bounded CLI output for the next valid authorization URL.
    }
  }
  return null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function normalizeNativeMessageId(value) {
  return isUuid(value) ? String(value).toLowerCase() : null;
}

function nativeUserText(event) {
  if (event?.type !== "user" || event.message?.role !== "user") return "";
  const content = event.message.content;
  if (typeof content === "string") return content.trim().slice(0, MAX_ITEM_TEXT);
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim()
    .slice(0, MAX_ITEM_TEXT);
}

function normalizeComparableText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeClientMessageId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 && /^[a-z0-9._:-]+$/i.test(normalized) ? normalized : null;
}

function sameMessagePayload(item, text, attachments) {
  return item.content === text
    && JSON.stringify(item.attachments || []) === JSON.stringify(attachments || []);
}

function normalizeWorkspaceSettings({ cwd, workspaceMode, worktreeName, additionalDirectories, projectRoot }) {
  const mode = workspaceMode === undefined || workspaceMode === null || workspaceMode === "" ? "project" : workspaceMode;
  if (!["project", "worktree"].includes(mode)) throw runtimeError(400, "Claude 工作区模式无效");
  const name = worktreeName === undefined || worktreeName === null || worktreeName === "" ? null : String(worktreeName).trim();
  if (name !== null && !validWorktreeName(name)) throw runtimeError(400, "Claude Worktree 名称无效");
  const directories = normalizeAdditionalDirectories(additionalDirectories, cwd, projectRoot);
  return {
    workspaceMode: mode,
    worktreeName: mode === "worktree" ? name : null,
    additionalDirectories: directories,
  };
}

function normalizeAdditionalDirectories(value, cwd, projectRoot) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw runtimeError(400, "Claude 额外目录列表无效");
  }
  const base = typeof cwd === "string" && path.isAbsolute(cwd) ? path.resolve(cwd) : null;
  const allowedRoot = typeof projectRoot === "string" && path.isAbsolute(projectRoot) ? path.resolve(projectRoot) : null;
  const directories = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || !path.isAbsolute(entry) || entry.length > 4_096) {
      throw runtimeError(400, "Claude 额外目录必须是绝对路径");
    }
    const directory = path.resolve(entry);
    if (allowedRoot && !pathWithin(allowedRoot, directory)) throw runtimeError(400, "Claude 额外目录超出账号工程范围");
    if (directory !== base && !directories.includes(directory)) directories.push(directory);
  }
  return directories;
}

async function resolveAdditionalDirectories(directories, cwd, projectRoot) {
  if (!directories.length) return [];
  let allowedRoot;
  let currentDirectory;
  try {
    [allowedRoot, currentDirectory] = await Promise.all([fs.realpath(projectRoot), fs.realpath(cwd)]);
  } catch {
    throw runtimeError(400, "Claude 工程目录不存在");
  }
  const resolved = [];
  for (const directory of directories) {
    let stat;
    let realDirectory;
    try {
      [stat, realDirectory] = await Promise.all([fs.stat(directory), fs.realpath(directory)]);
    } catch {
      throw runtimeError(400, "Claude 额外目录不存在或不可访问");
    }
    if (!stat.isDirectory()) throw runtimeError(400, "Claude 额外目录必须是目录");
    if (!pathWithin(allowedRoot, realDirectory)) throw runtimeError(400, "Claude 额外目录超出账号工程范围");
    if (realDirectory !== currentDirectory && !resolved.includes(realDirectory)) resolved.push(realDirectory);
  }
  return resolved;
}

function normalizeStoredAdditionalDirectories(value, cwd) {
  try {
    return normalizeAdditionalDirectories(value, cwd, null);
  } catch {
    return [];
  }
}

function validWorktreeName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);
}

function pathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePluginIdentifier(value) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (
    !identifier
    || identifier.length > MAX_PLUGIN_IDENTIFIER
    || !/^[a-z0-9][a-z0-9._-]{0,79}@[a-z0-9][a-z0-9._-]{0,79}$/i.test(identifier)
  ) {
    throw runtimeError(400, "Claude 插件标识必须使用 plugin@marketplace");
  }
  return identifier;
}

function normalizeClaudePluginScaffoldName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw runtimeError(400, "Claude 插件名称仅支持小写字母、数字和连字符");
  }
  return name;
}

function normalizeClaudePluginScaffoldDescription(value) {
  if (value === null || value === undefined || value === "") return null;
  const description = cleanControlText(value, 500);
  if (!description) throw runtimeError(400, "Claude 插件描述无效");
  return description;
}

function normalizeClaudePluginInitComponents(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > CLAUDE_PLUGIN_INIT_COMPONENTS.size) {
    throw runtimeError(400, "Claude 插件组件列表无效");
  }
  const components = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  if (components.some((entry) => !CLAUDE_PLUGIN_INIT_COMPONENTS.has(entry))) {
    throw runtimeError(400, "Claude 插件组件类型无效");
  }
  return components;
}

async function normalizeClaudePluginEvalTarget(project, value) {
  const target = typeof value === "string" ? value.trim() : "";
  if (!target || target.length > 4096 || /[\0\r\n]/.test(target)) {
    throw runtimeError(400, "Claude 插件 Eval 目标无效");
  }
  if (/^[a-z0-9][a-z0-9._-]{0,79}(?:@[a-z0-9][a-z0-9._-]{0,79})?$/i.test(target)) {
    return target;
  }
  const candidate = path.resolve(project, target);
  if (!pathWithin(project, candidate)) throw runtimeError(400, "Claude 插件 Eval 路径必须位于当前工程内");
  try {
    const [resolved, info] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
    if (info.isSymbolicLink() || !info.isDirectory() || !pathWithin(project, resolved)) {
      throw runtimeError(400, "Claude 插件 Eval 路径不安全");
    }
    return resolved;
  } catch (error) {
    if (error?.status) throw error;
    throw runtimeError(400, "Claude 插件 Eval 路径不存在或不可访问");
  }
}

function normalizeClaudePluginEvalOptions(input = {}) {
  const maxCostUsd = Number(input.maxCostUsd ?? 1);
  const runs = Number(input.runs ?? 1);
  const threshold = Number(input.threshold ?? 1);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01 || maxCostUsd > 100) {
    throw runtimeError(400, "Claude 插件 Eval 成本上限必须为 0.01–100 美元");
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw runtimeError(400, "Claude 插件 Eval 每个用例运行次数必须为 1–10");
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw runtimeError(400, "Claude 插件 Eval 通过阈值必须为 0–1");
  }
  const model = normalizeClaudeAutoModeModel(input.model);
  const judgeModel = normalizeClaudeAutoModeModel(input.judgeModel);
  const caseGlob = input.caseGlob === null || input.caseGlob === undefined || input.caseGlob === ""
    ? null
    : String(input.caseGlob).trim();
  if (caseGlob && (caseGlob.length > 200 || /[\0\r\n]/.test(caseGlob) || caseGlob.includes(".."))) {
    throw runtimeError(400, "Claude 插件 Eval 用例筛选无效");
  }
  const tags = input.tags === null || input.tags === undefined
    ? []
    : Array.isArray(input.tags)
      ? [...new Set(input.tags.map((tag) => String(tag || "").trim()).filter(Boolean))]
      : [];
  if (
    tags.length > 8
    || tags.some((tag) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag))
  ) throw runtimeError(400, "Claude 插件 Eval 标签无效");
  return { maxCostUsd, runs, threshold, model, judgeModel, caseGlob, tags };
}

async function resolveClaudePluginTagTarget(project, value) {
  const requested = typeof value === "string" && value.trim() ? value.trim() : ".";
  if (requested.length > 4096 || /[\0\r\n]/.test(requested)) {
    throw runtimeError(400, "Claude 插件标签路径无效");
  }
  const candidate = path.resolve(project, requested);
  if (!pathWithin(project, candidate)) throw runtimeError(400, "Claude 插件标签路径必须位于当前工程内");
  try {
    const [resolved, info] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
    if (info.isSymbolicLink() || !info.isDirectory() || !pathWithin(project, resolved)) {
      throw runtimeError(400, "Claude 插件标签路径不安全");
    }
    const manifest = path.join(resolved, ".claude-plugin", "plugin.json");
    const manifestInfo = await fs.lstat(manifest);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw runtimeError(400, "Claude 插件标签路径缺少安全的 plugin.json");
    }
    return resolved;
  } catch (error) {
    if (error?.status) throw error;
    throw runtimeError(400, "Claude 插件标签路径不存在或缺少 plugin.json");
  }
}

function normalizeMarketplaceSource(value) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source || source.length > 500 || /[\0\r\n]/.test(source)) {
    throw runtimeError(400, "Claude 插件市场来源无效");
  }
  if (/^[a-z0-9_.-]{1,80}\/[a-z0-9_.-]{1,80}$/i.test(source)) return source;
  let url;
  try {
    url = new URL(source);
  } catch {
    throw runtimeError(400, "Claude 插件市场来源必须是 GitHub 仓库或 HTTPS 地址");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw runtimeError(400, "Claude 插件市场来源必须是无凭据的 HTTPS 地址");
  }
  if (!isPublicMarketplaceHostname(url.hostname)) {
    throw runtimeError(400, "Claude 插件市场来源不能指向本地或私有网络");
  }
  return url.toString();
}

function normalizeMarketplaceName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(name)) {
    throw runtimeError(400, "Claude 插件市场名称无效");
  }
  return name;
}

function isPublicMarketplaceHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized.endsWith(".local") || normalized.endsWith(".internal") || !normalized.includes(".")) {
    return false;
  }
  const version = net.isIP(normalized);
  if (version === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first !== 10
      && !(first === 172 && second >= 16 && second <= 31)
      && !(first === 192 && second === 168)
      && first !== 127
      && first !== 0
      && first !== 169;
  }
  if (version === 6) return !/^::1$|^fc|^fd|^fe[89a-f]/i.test(normalized);
  return true;
}

function publicPlugin(value) {
  if (!value || typeof value !== "object") return null;
  const marketplace = cleanControlText(value.marketplace || value.marketplaceName || value.source || "", 80);
  let identifier = cleanControlText(value.identifier || value.id || value.plugin || value.fullName || "", MAX_PLUGIN_IDENTIFIER);
  const name = cleanControlText(value.name || value.pluginName || identifier.split("@")[0] || "", 80);
  if (identifier && !identifier.includes("@") && marketplace) identifier = `${identifier}@${marketplace}`;
  if (!identifier && name && marketplace) identifier = `${name}@${marketplace}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,79}@[a-z0-9][a-z0-9._-]{0,79}$/i.test(identifier)) return null;
  const scope = ["user", "project", "local", "managed"].includes(value.scope) ? value.scope : "user";
  return {
    identifier,
    name: name || identifier.split("@")[0],
    marketplace: marketplace || identifier.split("@")[1],
    version: cleanControlText(value.version || value.installedVersion || "", 64) || null,
    description: cleanControlText(value.description || value.summary || "", 500) || null,
    scope,
    enabled: value.enabled !== false && value.disabled !== true && value.status !== "disabled",
    editable: scope === "user",
  };
}

function publicAvailablePlugin(value) {
  const plugin = publicPlugin(value);
  if (!plugin) return null;
  return {
    ...plugin,
    description: plugin.description || null,
    available: true,
    installed: value?.installed === true,
    permissions: normalizePluginPermissions(value?.permissions || value?.requiredPermissions),
  };
}

function publicPluginMarketplace(value) {
  if (!value || typeof value !== "object") return null;
  const name = cleanControlText(value.name || value.id || value.marketplace || "", 96);
  if (!name || !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(name)) return null;
  const source = cleanControlText(value.source || value.url || value.repo || value.path || "", 500) || null;
  const sourceType = cleanControlText(value.sourceType || value.type || "", 64) || null;
  const installLocation = cleanControlText(value.installLocation || value.installPath || "", 500) || null;
  const lastUpdated = cleanControlText(value.lastUpdated || value.updatedAt || "", 80) || null;
  return {
    name,
    source,
    sourceType,
    installLocation,
    lastUpdated,
    trusted: value.trusted === true || value.official === true,
  };
}

function normalizePluginPermissions(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).map(([name, detail]) => `${name}${detail ? `: ${detail}` : ""}`)
      : [];
  return [...new Set(entries
    .map((entry) => cleanControlText(entry, 160))
    .filter(Boolean))].slice(0, 32);
}

function parsePluginJsonArray(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.marketplaces)
      ? parsed.marketplaces
      : [];
}

function normalizeClaudeAutoModeGroup(value) {
  if (value === null || value === undefined || value === "") return null;
  const group = typeof value === "string" ? value.trim() : "";
  if (!CLAUDE_AUTO_MODE_GROUPS.includes(group)) {
    throw runtimeError(400, "Claude Auto Mode 规则分组无效");
  }
  return group;
}

function normalizeClaudeAutoModeModel(value) {
  if (value === null || value === undefined || value === "") return null;
  const model = typeof value === "string" ? value.trim() : "";
  if (!model || model.length > 160 || /[\0\r\n\s]/.test(model)) {
    throw runtimeError(400, "Claude Auto Mode 评估模型无效");
  }
  return model;
}

function parseClaudeAutoModeResult(result, fallback) {
  if (result?.code !== 0) throw runtimeError(502, cleanCommandError(result, fallback));
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw runtimeError(502, `${fallback}：CLI 返回格式无效或内容过大`);
  }
  if (!plainObject(parsed)) throw runtimeError(502, `${fallback}：CLI 返回格式无效`);
  return Object.fromEntries(CLAUDE_AUTO_MODE_GROUPS.map((group) => {
    const values = parsed[group];
    if (!Array.isArray(values) || values.length > 200) {
      throw runtimeError(502, `${fallback}：${group} 规则格式无效`);
    }
    return [group, values.map((value) => {
      if (typeof value !== "string" || value.length > MAX_CLAUDE_AUTO_MODE_RULE_LENGTH) {
        throw runtimeError(502, `${fallback}：${group} 规则内容无效`);
      }
      return safeCommandOutput(value, MAX_CLAUDE_AUTO_MODE_RULE_LENGTH);
    })];
  }));
}

function projectPurgeFingerprint(plan) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ exists: plan.exists === true, output: plan.output || "" }))
    .digest("hex");
}

function normalizeClaudeUltraReviewTarget(value) {
  if (value === null || value === undefined || value === "") return null;
  const target = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (/^[1-9]\d{0,9}$/.test(target)) return target;
  if (
    !target
    || target.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target)
    || target.includes("..")
    || target.includes("//")
    || target.includes("@{")
    || target.endsWith(".lock")
  ) {
    throw runtimeError(400, "Ultra Review 目标必须是 PR 编号或安全的基础分支名");
  }
  return target;
}

function normalizeClaudeUltraReviewTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) {
    throw runtimeError(400, "Ultra Review 超时必须为 1–120 分钟");
  }
  return timeout;
}

function normalizeClaudeUltraReviewId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^cur-[a-f0-9]{24}$/.test(id)) throw runtimeError(400, "Claude Ultra Review ID 无效");
  return id;
}

function publicClaudeUltraReview(value) {
  return {
    id: value.id,
    cwd: value.cwd,
    target: value.target || null,
    timeoutMinutes: value.timeoutMinutes,
    officialAccountId: value.officialAccountId || null,
    status: value.status,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finishedAt: value.finishedAt || null,
    output: value.output || "",
    error: value.error || null,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
  };
}

function persistedClaudeUltraReview(value) {
  return publicClaudeUltraReview(value);
}

function normalizePersistedClaudeUltraReview(value) {
  if (!plainObject(value)) return null;
  let id;
  try {
    id = normalizeClaudeUltraReviewId(value.id);
  } catch {
    return null;
  }
  const cwd = typeof value.cwd === "string" && path.isAbsolute(value.cwd) ? path.resolve(value.cwd) : null;
  if (!cwd) return null;
  let target;
  let timeoutMinutes;
  try {
    target = normalizeClaudeUltraReviewTarget(value.target);
    timeoutMinutes = normalizeClaudeUltraReviewTimeout(value.timeoutMinutes);
  } catch {
    return null;
  }
  const status = ["running", "completed", "failed", "cancelled", "interrupted"].includes(value.status)
    ? value.status
    : "interrupted";
  const createdAt = Number.isSafeInteger(value.createdAt) ? value.createdAt : Date.now();
  const startedAt = Number.isSafeInteger(value.startedAt) ? value.startedAt : createdAt;
  const updatedAt = Number.isSafeInteger(value.updatedAt) ? value.updatedAt : startedAt;
  return {
    id,
    cwd,
    target,
    timeoutMinutes,
    officialAccountId: normalizeClaudeAccountId(value.officialAccountId),
    status,
    createdAt,
    startedAt,
    updatedAt,
    finishedAt: Number.isSafeInteger(value.finishedAt) ? value.finishedAt : null,
    output: safeCommandOutput(value.output, MAX_CLAUDE_ULTRA_REVIEW_OUTPUT),
    error: cleanControlText(value.error, 2_000) || null,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
  };
}

function claudeUltraReviewFailure(stderr, code, signal) {
  const source = String(stderr || "");
  if (/\b(?:401|403)\b|unauthori[sz]ed|not logged in|authenticate/i.test(source)) {
    return "Claude 官方账号未授权或登录已失效";
  }
  if (/\b(?:402|quota|credit|usage limit)\b/i.test(source)) {
    return "Claude 官方账号额度不足，Ultra Review 未完成";
  }
  if (/rate.?limit|\b429\b/i.test(source)) {
    return "Claude Ultra Review 触发限流，请稍后重试";
  }
  if (/timed? out|timeout/i.test(source)) return "Claude Ultra Review 超时";
  if (/network|ECONN|ENOTFOUND|socket|TLS/i.test(source)) return "Claude Ultra Review 网络连接失败";
  const detail = [
    Number.isInteger(code) ? `退出码 ${code}` : null,
    typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null,
  ].filter(Boolean).join(" · ");
  return `Claude Ultra Review 执行失败${detail ? `（${detail}）` : ""}`;
}

function claudeProjectDirectoryKey(cwd) {
  return String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
}

async function claudeProjectStateSources(configDirectory, cwd, sessionIds = []) {
  const sources = [];
  const seen = new Set();
  const add = async (relative) => {
    const normalized = path.normalize(relative);
    if (
      path.isAbsolute(normalized)
      || normalized.startsWith("..")
      || seen.has(normalized)
    ) return;
    const absolute = path.join(configDirectory, normalized);
    if (!pathWithin(configDirectory, absolute)) return;
    try {
      await fs.lstat(absolute);
      seen.add(normalized);
      sources.push({ relative: normalized, absolute });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  await add(path.join("projects", claudeProjectDirectoryKey(cwd)));
  const identifiers = new Set(sessionIds.filter(isUuid));
  for (const topLevel of ["tasks", "todos", "file-history", "shell-snapshots"]) {
    const directory = path.join(configDirectory, topLevel);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.slice(0, MAX_CLAUDE_PROJECT_BACKUP_FILES + 1)) {
      if (
        [...identifiers].some((identifier) =>
          entry.name === identifier
          || entry.name.startsWith(`${identifier}-`)
          || entry.name.startsWith(`${identifier}.`))
      ) {
        await add(path.join(topLevel, entry.name));
      }
    }
  }
  return sources;
}

async function inspectClaudeProjectState({ configDirectory, cwd, sessionIds }) {
  const sources = await claudeProjectStateSources(configDirectory, cwd, sessionIds);
  const stats = { files: 0, bytes: 0 };
  for (const source of sources) await inspectClaudeProjectStateEntry(source.absolute, stats);
  const configuration = await readClaudeProjectConfiguration(configDirectory, cwd);
  return {
    nativeFiles: stats.files,
    nativeBytes: stats.bytes,
    sessions: sessionIds.length,
    projectConfiguration: configuration === null ? 0 : 1,
    backupLimitBytes: MAX_CLAUDE_PROJECT_BACKUP_BYTES,
  };
}

async function inspectClaudeProjectStateEntry(target, stats) {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink()) throw runtimeError(409, "Claude 工程状态包含符号链接，无法创建安全备份");
  if (info.isFile()) {
    stats.files += 1;
    stats.bytes += info.size;
    assertClaudeProjectBackupBounds(stats);
    return;
  }
  if (!info.isDirectory()) throw runtimeError(409, "Claude 工程状态包含不支持的文件类型");
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await inspectClaudeProjectStateEntry(path.join(target, entry.name), stats);
  }
}

function assertClaudeProjectBackupBounds(stats) {
  if (stats.files > MAX_CLAUDE_PROJECT_BACKUP_FILES) {
    throw runtimeError(413, "Claude 工程状态文件过多，已停止清理；请先手动归档");
  }
  if (stats.bytes > MAX_CLAUDE_PROJECT_BACKUP_BYTES) {
    throw runtimeError(413, "Claude 工程状态超过 512 MiB，已停止清理；请先手动归档");
  }
}

async function readClaudeProjectConfiguration(configDirectory, cwd) {
  try {
    const source = JSON.parse(await fs.readFile(path.join(configDirectory, ".claude.json"), "utf8"));
    if (!plainObject(source) || !plainObject(source.projects) || !Object.hasOwn(source.projects, cwd)) return null;
    return structuredClone(source.projects[cwd]);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw runtimeError(409, "Claude 原生工程配置格式无效，无法创建安全备份");
    throw error;
  }
}

async function copyClaudeProjectStateEntry(source, destination, stats) {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw runtimeError(409, "Claude 工程状态包含符号链接，无法创建安全备份");
  if (info.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    await fs.chmod(destination, 0o700);
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyClaudeProjectStateEntry(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        stats,
      );
    }
    return;
  }
  if (!info.isFile()) throw runtimeError(409, "Claude 工程状态包含不支持的文件类型");
  stats.files += 1;
  stats.bytes += info.size;
  assertClaudeProjectBackupBounds(stats);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const sourceHandle = await fs.open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
  );
  let destinationHandle;
  try {
    const verified = await sourceHandle.stat();
    if (!verified.isFile() || verified.dev !== info.dev || verified.ino !== info.ino) {
      throw runtimeError(409, "Claude 工程状态在备份时发生变化，请重新预览");
    }
    destinationHandle = await fs.open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < verified.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, verified.size - position), position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== verified.size) throw runtimeError(409, "Claude 工程状态在备份时读取不完整");
    await destinationHandle.sync();
    await destinationHandle.chmod(0o600);
  } finally {
    await Promise.all([
      sourceHandle.close().catch(() => {}),
      destinationHandle?.close().catch(() => {}),
    ]);
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.once("exit", finish);
  });
}

function cleanCommandError(result, fallback) {
  const source = stripTerminalControl(`${result?.stderr || ""}\n${result?.stdout || ""}`);
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|oauth|authenticate/i.test(source)) {
    return `${fallback}（认证或授权失败，原始诊断已隐藏）`;
  }
  if (/timed? out|timeout|命令超时/i.test(source)) {
    return `${fallback}（操作超时，原始诊断已隐藏）`;
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|name resolution/i.test(source)) {
    return `${fallback}（域名解析失败，原始诊断已隐藏）`;
  }
  if (/ECONNREFUSED|connection refused/i.test(source)) {
    return `${fallback}（目标拒绝连接，原始诊断已隐藏）`;
  }
  if (/TLS|certificate|SSL/i.test(source)) {
    return `${fallback}（TLS 校验失败，原始诊断已隐藏）`;
  }
  if (/ENOENT|not found|does not exist/i.test(source)) {
    return `${fallback}（目标不存在，原始诊断已隐藏）`;
  }
  if (/EACCES|EPERM|permission denied/i.test(source)) {
    return `${fallback}（文件或进程权限不足，原始诊断已隐藏）`;
  }
  return `${fallback}（原始诊断已隐藏）`;
}

function safeCommandOutput(value, limit = 32_000) {
  return cleanControlText(stripTerminalControl(value), limit)
    .replace(/(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,})/gi, "[凭据已隐藏]")
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, "Authorization: [已隐藏]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password|cookie)["']?\s*:\s*)["'][^"'\r\n]*["']/gi, '$1"[已隐藏]"')
    .replace(/\b(?:api[_-]?key|token|secret|password|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .trim();
}

function protocolIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z][A-Za-z0-9_/-]{0,127}$/.test(text) ? text : "unknown";
}

function protocolFingerprint(value) {
  if (typeof value !== "string" || !value) return "unknown";
  return `unreviewed-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function claudeLogFailure(operation, error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,48}$/.test(error.code)
    ? ` · ${error.code}`
    : "";
  return `Claude ${operation}失败，原始诊断已隐藏${code}`;
}

function claudeProcessExitMessage(details) {
  if (details?.kind === "spawn-error") {
    const code = typeof details.code === "string" && /^[A-Z0-9_]{1,48}$/.test(details.code)
      ? `（${details.code}）`
      : "";
    return `Claude 进程启动失败${code}`;
  }
  const code = Number.isInteger(details?.code) ? `退出码 ${details.code}` : null;
  const signal = typeof details?.signal === "string" && /^SIG[A-Z0-9]+$/.test(details.signal)
    ? details.signal
    : null;
  return `Claude 进程已退出${[code, signal].filter(Boolean).length ? `（${[code, signal].filter(Boolean).join(" · ")}）` : ""}`;
}

function pluginActionLabel(action) {
  return ({ install: "安装", update: "更新", enable: "启用", disable: "停用", uninstall: "卸载" })[action] || "操作";
}

function pluginMarketplaceActionLabel(action) {
  return ({ add: "添加", update: "更新", remove: "移除" })[action] || "操作";
}

function failedClaudeOfficialProxyHealth(error) {
  const candidate = String(error?.proxyCode || error?.code || "").toLowerCase();
  const code = [
    "authentication",
    "connect",
    "dns",
    "private",
    "protocol",
    "response",
    "timeout",
    "tls",
  ].includes(candidate) ? candidate : "connect";
  return {
    status: "failed",
    checkedAt: Date.now(),
    latencyMs: null,
    exitIp: null,
    code,
  };
}

function runtimeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function runCommand(command, args, options, timeoutMs = 15_000, outputLimit = 32_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr: `${stderr}\n命令超时` });
    }, timeoutMs);
    const boundedOutputLimit = Math.max(2_000, Math.min(Number(outputLimit) || 32_000, 512 * 1024));
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-boundedOutputLimit); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-boundedOutputLimit); });
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("exit", (code) => finish({ code, stdout, stderr }));
  });
}

async function repairOwnership(directory, uid, gid) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await repairOwnership(target, uid, gid);
    await fs.lchown(target, uid, gid);
  }
  await fs.lchown(directory, uid, gid);
}
