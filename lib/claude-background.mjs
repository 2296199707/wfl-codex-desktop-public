import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Small, server-side adapter for Claude Code's native background-agent store.
 *
 * The adapter deliberately does not keep a child process alive. `claude --bg`
 * hands the job to Claude's own daemon; callers can refresh the state through
 * `claude agents --json --all` and the 0600 job/transcript files. This makes
 * the feature safe to recover after a WFL process restart.
 */
export class ClaudeBackgroundAgents extends EventEmitter {
  constructor({
    user,
    command = "claude",
    configDirectory,
    dataDirectory,
    spawnOptions,
    maxJobs = MAX_BACKGROUND_JOBS,
  } = {}) {
    super();
    this.user = user || {};
    this.command = command;
    this.configDirectory = path.resolve(configDirectory || "");
    this.dataDirectory = path.resolve(dataDirectory || "");
    this.metadataPath = path.join(this.dataDirectory, "background-agents.json");
    this.jobsDirectory = path.join(this.configDirectory, "jobs");
    this.spawnOptions = typeof spawnOptions === "function"
      ? spawnOptions
      : ({ cwd, stdio }) => ({
        cwd,
        stdio,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: this.configDirectory,
        },
      });
    this.maxJobs = Number.isSafeInteger(maxJobs) && maxJobs > 0
      ? Math.min(maxJobs, MAX_BACKGROUND_JOBS)
      : MAX_BACKGROUND_JOBS;
    this.metadata = new Map();
    this.initialized = false;
    this.operationQueue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return this;
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDirectory, 0o700).catch(() => {});
    await this.loadMetadata();
    this.initialized = true;
    return this;
  }

  count() {
    return this.metadata.size;
  }

  ids() {
    return [...this.metadata.keys()];
  }

  async start(options = {}) {
    return this.queue(async () => {
      this.assertInitialized();
      const cwd = await this.normalizeCwd(options.cwd);
      const prompt = normalizePrompt(options.prompt);
      const explicitName = typeof options.name === "string" && options.name.trim();
      const name = normalizeName(explicitName || prompt.slice(0, 64) || "Claude background agent");
      if (this.metadata.size >= this.maxJobs) {
        throw runtimeError(400, "Claude 后台 Agent 数量已达上限");
      }

      const args = ["--bg", "--name", name];
      appendOptionalArg(args, "--model", options.model, 256);
      appendOptionalArg(args, "--effort", options.effort, 32);
      appendOptionalArg(args, "--permission-mode", options.permissionMode, 64);
      appendOptionalArg(args, "--fallback-model", options.fallbackModel, 512);
      appendOptionalArg(args, "--max-budget-usd", normalizeBudget(options.maxBudgetUsd));
      appendRulesArg(args, "--allowed-tools", options.allowedTools);
      appendRulesArg(args, "--disallowed-tools", options.disallowedTools);
      appendOptionalArg(args, "--agent", options.agent, 128);
      appendAdditionalDirectories(args, options.additionalDirectories, this.projectRoot());
      appendSettingSourcesArg(args, options.settingSources);
      appendPluginDirectories(args, options.pluginDirectories, this.projectRoot());
      if (options.mcpConfigPath) {
        const mcpConfigPath = await this.assertDispatchConfigFile(options.mcpConfigPath);
        args.push("--mcp-config", mcpConfigPath);
      }
      if (options.strictMcpConfig === true) {
        if (!options.mcpConfigPath) throw runtimeError(400, "Claude 后台 Agent 严格 MCP 配置缺少隔离文件");
        args.push("--strict-mcp-config");
      }
      if (options.settingsPath) {
        const settingsPath = await this.assertDispatchConfigFile(options.settingsPath);
        args.push("--settings", settingsPath, "--include-hook-events");
      }
      // `--bg` is intentionally used without `-p/--print`: Claude rejects
      // those modes together and background jobs are native interactive jobs.
      args.push(prompt);

      const result = await runCommand(
        this.command,
        args,
        this.spawnOptions({ cwd, stdio: ["ignore", "pipe", "pipe"] }),
        BACKGROUND_COMMAND_TIMEOUT_MS,
      );
      const output = stripTerminalControl(`${result.stdout}\n${result.stderr}`);
      let shortId = parseBackgroundId(output);
      if (result.code !== 0) {
        throw runtimeError(502, cleanCommandError(output, "Claude 后台 Agent 启动失败"));
      }
      // A few CLI builds print the acknowledgement asynchronously. Reconcile
      // through `agents --json` before giving up.
      let native = null;
      if (!shortId) {
        const listed = await this.listNative({ cwd, tolerateErrors: true });
        native = pickRecentlyStarted(listed, { cwd, name, startedAt: Date.now() - 30_000 });
        shortId = native?.shortId || null;
      }
      if (!shortId) throw runtimeError(502, "Claude 后台 Agent 启动响应无效");
      if (!native) {
        const listed = await this.listNative({ cwd, tolerateErrors: true });
        native = listed.find((entry) => entry.shortId === shortId) || null;
      }
      const now = Date.now();
      const metadata = normalizeMetadata({
        shortId,
        sessionId: native?.sessionId || null,
        cwd,
        name,
        nameOrigin: explicitName ? "user" : "prompt",
        promptPreview: redactSecrets(prompt).slice(0, MAX_PROMPT_PREVIEW),
        parentSessionId: normalizeUuid(options.parentSessionId),
        model: options.model,
        providerId: options.providerId,
        providerName: options.providerName,
        settingSources: options.settingSources,
        mcpServerNames: options.mcpServerNames,
        pluginCount: options.pluginDirectories?.length || 0,
        hooksEnabled: Boolean(options.settingsPath),
        additionalDirectoryCount: options.additionalDirectories?.length || 0,
        createdAt: native?.createdAt || now,
        updatedAt: native?.updatedAt || now,
      }, this.projectRoot());
      this.metadata.set(shortId, metadata);
      await this.persistMetadata();
      const record = publicBackgroundAgent({
        ...metadata,
        ...(native || {}),
        shortId,
        cwd,
        name,
        promptPreview: metadata.promptPreview,
      });
      this.emit("event", { type: "background/started", agent: record });
      return record;
    });
  }

  async list(options = {}) {
    return this.queue(async () => {
      this.assertInitialized();
      const cwd = await this.normalizeCwd(options.cwd || this.projectRoot());
      const native = await this.listNative({ cwd, tolerateErrors: options.tolerateErrors !== false });
      const byId = new Map(native.map((entry) => [entry.shortId, entry]));

      // Include metadata jobs even when `claude agents` has a transient
      // failure; the state file is the recovery source of truth.
      for (const entry of this.metadata.values()) {
        if (entry.cwd === cwd && !byId.has(entry.shortId)) {
          const state = await this.readState(entry.shortId, { strict: false });
          byId.set(entry.shortId, state ? mergeNativeState(entry, state) : entry);
        }
      }

      const records = [];
      for (const entry of byId.values()) {
        if (!entry?.shortId) continue;
        const entryCwd = await this.safeEntryCwd(entry.cwd || cwd, cwd);
        if (!entryCwd) continue;
        const metadata = this.metadata.get(entry.shortId);
        let state = null;
        try {
          state = await this.readState(entry.shortId, { strict: false });
        } catch (error) {
          this.emit("log", { level: "warn", message: backgroundLogFailure("状态恢复", error) });
        }
        const merged = {
          ...(metadata || {}),
          ...(entry || {}),
          ...(state ? mergeNativeState({}, state) : {}),
          shortId: entry.shortId,
          cwd: entryCwd,
        };
        if (!metadata) {
          const recovered = normalizeMetadata(merged, this.projectRoot());
          if (recovered) this.metadata.set(entry.shortId, recovered);
        } else if (state) {
          const updated = normalizeMetadata({ ...metadata, ...merged }, this.projectRoot());
          if (updated) this.metadata.set(entry.shortId, updated);
        }
        records.push(await this.toPublicRecord(merged));
      }
      if (this.metadata.size) await this.persistMetadata();
      records.sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0));
      return records.slice(0, this.maxJobs);
    });
  }

  async assertDispatchConfigFile(value) {
    const target = typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
    if (!target || !pathWithin(this.dataDirectory, target)) {
      throw runtimeError(400, "Claude 后台 Agent 调度配置路径无效");
    }
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw runtimeError(400, "Claude 后台 Agent 调度配置文件不安全");
    }
    return target;
  }

  /**
   * Return a bounded, transcript-free snapshot for the unified task center.
   *
   * Native state files are the durable source of truth for jobs started by
   * this runtime. Reading them avoids launching one `claude agents` process
   * per project whenever the task drawer refreshes.
   */
  async taskSnapshot() {
    this.assertInitialized();
    const metadataEntries = [...this.metadata.values()].slice(-this.maxJobs);
    const records = [];
    for (const metadata of metadataEntries) {
      let state = null;
      try {
        state = await this.readState(metadata.shortId, { strict: false });
      } catch (error) {
        this.emit("log", { level: "warn", message: backgroundLogFailure("任务中心状态恢复", error) });
      }
      records.push(publicBackgroundAgent({
        ...metadata,
        ...(state ? mergeNativeState({}, state) : {}),
        shortId: metadata.shortId,
        cwd: metadata.cwd,
      }));
    }
    return records.sort(
      (left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0),
    );
  }

  async read(id, { includeTranscript = true, limit = MAX_TRANSCRIPT_LINES } = {}) {
    return this.queue(async () => {
      this.assertInitialized();
      const shortId = normalizeShortId(id);
      const cwd = this.metadata.get(shortId)?.cwd || this.projectRoot();
      await this.normalizeCwd(cwd);
      const native = await this.listNative({ cwd, tolerateErrors: true });
      const listed = native.find((entry) => entry.shortId === shortId) || null;
      const metadata = this.metadata.get(shortId) || null;
      if (!listed && !metadata) throw runtimeError(404, "Claude 后台 Agent 不存在");
      const state = await this.readState(shortId, { strict: true });
      const merged = {
        ...(metadata || {}),
        ...(listed || {}),
        ...(state ? mergeNativeState({}, state) : {}),
        shortId,
        cwd: await this.normalizeCwd((listed || metadata || state)?.cwd || cwd),
      };
      const result = await this.toPublicRecord(merged);
      if (includeTranscript) {
        result.transcript = await this.readTranscriptForState(shortId, state, {
          limit: normalizeLimit(limit),
          strict: true,
        });
      }
      return result;
    });
  }

  async stop(id) {
    return this.queue(async () => {
      this.assertInitialized();
      const shortId = normalizeShortId(id);
      const metadata = this.metadata.get(shortId);
      let native = null;
      let cwd;
      if (metadata?.cwd) {
        cwd = await this.normalizeCwd(metadata.cwd);
      } else {
        const candidates = await this.listNative({ cwd: this.projectRoot(), tolerateErrors: true });
        native = candidates.find((entry) => entry.shortId === shortId) || null;
        if (!native) throw runtimeError(404, "Claude 后台 Agent 不存在");
        cwd = await this.normalizeCwd(native.cwd || this.projectRoot());
      }
      const result = await runCommand(
        this.command,
        ["stop", shortId],
        this.spawnOptions({ cwd, stdio: ["ignore", "pipe", "pipe"] }),
        BACKGROUND_COMMAND_TIMEOUT_MS,
      );
      const output = stripTerminalControl(`${result.stdout}\n${result.stderr}`);
      if (result.code !== 0) throw runtimeError(502, cleanCommandError(output, "Claude 后台 Agent 停止失败"));
      const state = await this.readState(shortId, { strict: false });
      const merged = {
        ...(metadata || {}),
        ...(native || {}),
        shortId,
        cwd,
        ...(state ? mergeNativeState({}, state) : {}),
      };
      const updated = normalizeMetadata(merged, this.projectRoot());
      if (updated) this.metadata.set(shortId, updated);
      await this.persistMetadata();
      const record = await this.toPublicRecord(merged);
      this.emit("event", { type: "background/stopped", agent: record });
      return record;
    });
  }

  async destroy() {
    await this.operationQueue.catch(() => {});
  }

  async loadMetadata() {
    let raw;
    try {
      raw = await readSecureFile(this.metadataPath, {
        maxBytes: MAX_METADATA_BYTES,
        expectedUid: this.expectedUid(),
        expectedGid: this.expectedGid(),
        allowMissing: true,
        rootDirectory: this.dataDirectory,
      });
    } catch (error) {
      this.emit("log", { level: "warn", message: backgroundLogFailure("元数据恢复", error) });
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed?.agents;
      if (!Array.isArray(entries)) return;
      for (const entry of entries.slice(0, this.maxJobs)) {
        const normalized = normalizeMetadata(entry, this.projectRoot());
        if (normalized) this.metadata.set(normalized.shortId, normalized);
      }
    } catch {
      // A partial metadata write should not prevent the runtime from starting.
    }
  }

  async persistMetadata() {
    const entries = [...this.metadata.values()]
      .map((entry) => normalizeMetadata(entry, this.projectRoot()))
      .filter(Boolean)
      .slice(-this.maxJobs);
    const payload = JSON.stringify({ version: 1, agents: entries });
    await writeSecureFile(this.metadataPath, `${payload}\n`, {
      expectedUid: this.expectedUid(),
      expectedGid: this.expectedGid(),
    });
  }

  async listNative({ cwd, tolerateErrors = false } = {}) {
    const normalizedCwd = await this.normalizeCwd(cwd || this.projectRoot());
    const result = await runCommand(
      this.command,
      ["agents", "--json", "--all", "--cwd", normalizedCwd],
      this.spawnOptions({ cwd: normalizedCwd, stdio: ["ignore", "pipe", "pipe"] }),
      BACKGROUND_COMMAND_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      if (tolerateErrors) return [];
      throw runtimeError(502, cleanCommandError(`${result.stdout}\n${result.stderr}`, "Claude 后台 Agent 列表读取失败"));
    }
    const parsed = parseJsonOutput(result.stdout);
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (Array.isArray(parsed.agents) ? parsed.agents : Array.isArray(parsed.sessions) ? parsed.sessions : Array.isArray(parsed.jobs) ? parsed.jobs : [])
        : [];
    return entries
      .map((entry) => normalizeNativeEntry(entry, this.projectRoot()))
      .filter((entry) => entry && entry.cwd === normalizedCwd);
  }

  async toPublicRecord(entry) {
    const state = entry?.stateFileState || entry;
    const transcriptAvailable = Boolean(state?.linkScanPath);
    return publicBackgroundAgent({
      ...entry,
      shortId: entry.shortId,
      transcriptAvailable,
      stateTrusted: entry.stateTrusted !== false,
    });
  }

  async readState(shortId, { strict = true } = {}) {
    const id = normalizeShortId(shortId);
    const directory = path.join(this.jobsDirectory, id);
    const statePath = path.join(directory, "state.json");
    try {
      const raw = await readSecureFile(statePath, {
        maxBytes: MAX_STATE_BYTES,
        expectedUid: this.expectedUid(),
        expectedGid: this.expectedGid(),
        allowMissing: !strict,
        rootDirectory: this.jobsDirectory,
      });
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return normalizeState(parsed, this.projectRoot());
    } catch (error) {
      if (!strict && ["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      if (error.status) throw error;
      throw runtimeError(502, "Claude 后台 Agent 状态文件不安全，原始路径与诊断已隐藏");
    }
  }

  async readTranscriptForState(shortId, state, { limit, strict }) {
    const transcriptPath = safeTranscriptPath(state?.linkScanPath, this.configDirectory);
    if (!transcriptPath) return [];
    let raw;
    try {
      raw = await readSecureFile(transcriptPath, {
        maxBytes: MAX_TRANSCRIPT_BYTES,
        expectedUid: this.expectedUid(),
        expectedGid: this.expectedGid(),
        allowMissing: !strict,
        rootDirectory: path.join(this.configDirectory, "projects"),
      });
    } catch (error) {
      if (!strict && ["ENOENT", "ENOTDIR"].includes(error.code)) return [];
      if (error.status) throw error;
      throw runtimeError(502, "Claude 后台 Agent 转录文件不安全，原始路径与诊断已隐藏");
    }
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return sanitizeTranscriptValue(JSON.parse(line));
      } catch {
        return { type: "text", content: redactSecrets(stripTerminalControl(line)).slice(0, MAX_ITEM_TEXT) };
      }
    });
  }

  async safeEntryCwd(value, requestedCwd) {
    try {
      const cwd = await this.normalizeCwd(value || requestedCwd);
      return cwd === requestedCwd ? cwd : null;
    } catch {
      return null;
    }
  }

  projectRoot() {
    return path.resolve(this.user.projectRoot || this.user.home || process.cwd());
  }

  expectedUid() {
    return Number.isInteger(this.user.uid) ? this.user.uid : process.getuid?.() ?? null;
  }

  expectedGid() {
    return Number.isInteger(this.user.gid) ? this.user.gid : process.getgid?.() ?? null;
  }

  async normalizeCwd(value) {
    const raw = typeof value === "string" && value.trim() ? value.trim() : this.projectRoot();
    if (!path.isAbsolute(raw) || raw.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(raw)) {
      throw runtimeError(400, "Claude 后台 Agent 工程目录无效");
    }
    let root;
    let cwd;
    try {
      [root, cwd] = await Promise.all([fs.realpath(this.projectRoot()), fs.realpath(path.resolve(raw))]);
    } catch {
      throw runtimeError(400, "Claude 后台 Agent 工程目录不存在");
    }
    if (!pathWithin(root, cwd)) throw runtimeError(403, "Claude 后台 Agent 超出账号工程范围");
    return cwd;
  }

  queue(operation) {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => {});
    return next;
  }

  assertInitialized() {
    if (!this.initialized) throw runtimeError(503, "Claude 后台 Agent 运行时尚未就绪");
  }
}

const MAX_BACKGROUND_JOBS = 200;
const MAX_PATH_LENGTH = 4_096;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_PROMPT_PREVIEW = 500;
const MAX_ITEM_TEXT = 100_000;
const MAX_STATE_BYTES = 1 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 500;
const BACKGROUND_COMMAND_TIMEOUT_MS = 20_000;
const ALLOWED_STATES = new Set(["working", "blocked", "done", "stopped", "failed", "running", "idle", "unknown"]);
const ALLOWED_TEMPO = new Set(["active", "idle", "blocked", "unknown"]);

function normalizePrompt(value) {
  if (typeof value !== "string") throw runtimeError(400, "Claude 后台 Agent 提示不能为空");
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH || /[\u0000]/.test(prompt)) {
    throw runtimeError(400, "Claude 后台 Agent 提示无效");
  }
  return prompt;
}

function normalizeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 128 || /[\u0000\r\n]/.test(name)) {
    throw runtimeError(400, "Claude 后台 Agent 名称无效");
  }
  return name;
}

function normalizeShortId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}$/.test(id)) throw runtimeError(400, "Claude 后台 Agent ID 无效");
  return id;
}

function normalizeUuid(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function normalizeBudget(value) {
  if (value === undefined || value === null || value === "") return null;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0 || budget > 10_000) {
    throw runtimeError(400, "Claude 后台 Agent 预算无效");
  }
  return String(budget);
}

function appendOptionalArg(args, flag, value, maxLength) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
    throw runtimeError(400, `Claude 后台 Agent ${flag} 参数无效`);
  }
  args.push(flag, value);
}

function appendRulesArg(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  const rules = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/).filter(Boolean)
      : null;
  if (!rules || rules.length > 64 || rules.some((rule) => typeof rule !== "string" || !rule || rule.length > 256 || /[\u0000\r\n]/.test(rule))) {
    throw runtimeError(400, `Claude 后台 Agent ${flag} 参数无效`);
  }
  args.push(flag, rules.join(","));
}

function appendSettingSourcesArg(args, value) {
  if (value === undefined || value === null || value === "") return;
  const sources = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (
    !sources
    || sources.length > 3
    || sources.some((source) => !["user", "project", "local"].includes(source))
    || new Set(sources).size !== sources.length
  ) {
    throw runtimeError(400, "Claude 后台 Agent 设置来源无效");
  }
  if (sources.length) args.push("--setting-sources", sources.join(","));
}

function appendPluginDirectories(args, value, projectRoot) {
  if (value === undefined || value === null || value === "") return;
  if (!Array.isArray(value) || value.length > 8) {
    throw runtimeError(400, "Claude 后台 Agent 插件目录无效");
  }
  for (const entry of value) {
    const target = typeof entry === "string" && path.isAbsolute(entry) ? path.resolve(entry) : null;
    if (!target || !pathWithin(projectRoot, target)) {
      throw runtimeError(400, "Claude 后台 Agent 插件目录必须位于当前账号工程内");
    }
    args.push("--plugin-dir", target);
  }
}

function appendAdditionalDirectories(args, value, projectRoot) {
  if (value === undefined || value === null || value === "") return;
  if (!Array.isArray(value) || value.length > 8) {
    throw runtimeError(400, "Claude 后台 Agent 额外目录无效");
  }
  for (const entry of value) {
    const target = typeof entry === "string" && path.isAbsolute(entry) ? path.resolve(entry) : null;
    if (!target || !pathWithin(projectRoot, target)) {
      throw runtimeError(400, "Claude 后台 Agent 额外目录必须位于当前账号工程内");
    }
    args.push("--add-dir", target);
  }
}

function parseBackgroundId(output) {
  const text = stripTerminalControl(output);
  const match = text.match(/backgrounded[\s·•\-:]+([0-9a-f]{8})(?:[\s·•\-:]+|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function parseJsonOutput(output) {
  const text = stripTerminalControl(output).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const starts = [text.indexOf("["), text.indexOf("{")].filter((index) => index >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        // Keep scanning for a JSON payload after a startup banner.
      }
    }
    return null;
  }
}

function normalizeNativeEntry(value, projectRoot) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const shortId = (() => {
    const candidate = value.id || value.shortId || value.short || value.daemonShort;
    return typeof candidate === "string" && /^[0-9a-f]{8}$/i.test(candidate) ? candidate.toLowerCase() : null;
  })();
  if (!shortId) return null;
  const cwd = typeof value.cwd === "string" && path.isAbsolute(value.cwd) ? path.resolve(value.cwd) : null;
  if (cwd && !pathWithin(path.resolve(projectRoot), cwd)) return null;
  return {
    shortId,
    sessionId: normalizeUuid(value.sessionId || value.resumeSessionId),
    cwd,
    name: cleanPublicText(value.name, 128) || null,
    state: normalizeStateName(value.state || value.status),
    status: cleanPublicText(value.status, 32) || null,
    tempo: normalizeTempo(value.tempo),
    detail: redactSecrets(cleanPublicText(value.detail, 1_000)),
    needs: redactSecrets(cleanPublicText(value.needs || value.waitingFor, 1_000)),
    createdAt: normalizeTimestamp(value.createdAt || value.startedAt),
    updatedAt: normalizeTimestamp(value.updatedAt || value.finishedAt || value.settledAt),
    startedAt: normalizeTimestamp(value.startedAt || value.createdAt),
    transcriptAvailable: false,
  };
}

function normalizeState(value, projectRoot) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = normalizeNativeEntry({
    id: value.daemonShort || value.shortId || value.id,
    sessionId: value.sessionId || value.resumeSessionId,
    cwd: value.cwd,
    name: value.name,
    state: value.state,
    status: value.status,
    tempo: value.tempo,
    detail: value.detail,
    needs: value.needs || value.waitingFor,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
  }, projectRoot);
  if (!normalized) return null;
  const linkScanPath = typeof value.linkScanPath === "string" ? value.linkScanPath : null;
  return {
    ...normalized,
    linkScanPath,
    stateTrusted: true,
  };
}

function normalizeMetadata(value, projectRoot) {
  const native = normalizeNativeEntry(value, projectRoot);
  if (!native) return null;
  const cwd = typeof value.cwd === "string" && path.isAbsolute(value.cwd) ? path.resolve(value.cwd) : native.cwd;
  if (!cwd || !pathWithin(path.resolve(projectRoot), cwd)) return null;
  return {
    shortId: native.shortId,
    sessionId: native.sessionId,
    cwd,
    name: native.name || normalizeOptionalText(value.name, 128),
    nameOrigin: ["user", "prompt"].includes(value.nameOrigin) ? value.nameOrigin : "legacy",
    promptPreview: redactSecrets(normalizeOptionalText(value.promptPreview, MAX_PROMPT_PREVIEW)),
    parentSessionId: normalizeUuid(value.parentSessionId),
    model: normalizeOptionalText(value.model, 256),
    providerId: normalizeOptionalText(value.providerId, 128),
    providerName: normalizeOptionalText(value.providerName, 128),
    settingSources: Array.isArray(value.settingSources)
      ? [...new Set(value.settingSources.filter((entry) => ["user", "project", "local"].includes(entry)))].slice(0, 3)
      : [],
    mcpServerNames: Array.isArray(value.mcpServerNames)
      ? [...new Set(value.mcpServerNames
        .filter((entry) => typeof entry === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(entry)))]
        .slice(0, 64)
      : [],
    pluginCount: Number.isSafeInteger(value.pluginCount) ? Math.max(0, Math.min(8, value.pluginCount)) : 0,
    hooksEnabled: value.hooksEnabled === true,
    additionalDirectoryCount: Number.isSafeInteger(value.additionalDirectoryCount)
      ? Math.max(0, Math.min(8, value.additionalDirectoryCount))
      : 0,
    createdAt: native.createdAt || Date.now(),
    updatedAt: native.updatedAt || native.createdAt || Date.now(),
  };
}

function mergeNativeState(base, state) {
  if (!state) return base;
  return {
    ...base,
    ...state,
    stateFileState: state,
    sessionId: state.sessionId || base.sessionId || null,
    cwd: state.cwd || base.cwd || null,
  };
}

function publicBackgroundAgent(value) {
  const state = normalizeStateName(value.state || value.status);
  return {
    id: value.shortId,
    shortId: value.shortId,
    sessionId: normalizeUuid(value.sessionId),
    nativeSessionId: normalizeUuid(value.sessionId),
    cwd: typeof value.cwd === "string" ? path.resolve(value.cwd) : null,
    name: cleanPublicText(value.name, 128) || null,
    nameOrigin: ["user", "prompt"].includes(value.nameOrigin) ? value.nameOrigin : "legacy",
    promptPreview: redactSecrets(cleanPublicText(value.promptPreview, MAX_PROMPT_PREVIEW)) || null,
    parentSessionId: normalizeUuid(value.parentSessionId),
    model: cleanPublicText(value.model, 256) || null,
    providerId: cleanPublicText(value.providerId, 128) || null,
    providerName: cleanPublicText(value.providerName, 128) || null,
    settingSources: Array.isArray(value.settingSources)
      ? value.settingSources.filter((entry) => ["user", "project", "local"].includes(entry)).slice(0, 3)
      : [],
    mcpServerNames: Array.isArray(value.mcpServerNames)
      ? value.mcpServerNames
        .filter((entry) => typeof entry === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(entry))
        .slice(0, 64)
      : [],
    pluginCount: Number.isSafeInteger(value.pluginCount) ? Math.max(0, Math.min(8, value.pluginCount)) : 0,
    hooksEnabled: value.hooksEnabled === true,
    additionalDirectoryCount: Number.isSafeInteger(value.additionalDirectoryCount)
      ? Math.max(0, Math.min(8, value.additionalDirectoryCount))
      : 0,
    kind: "background",
    state,
    status: cleanPublicText(value.status, 32) || null,
    tempo: normalizeTempo(value.tempo),
    detail: redactSecrets(cleanPublicText(value.detail, 1_000)) || null,
    needs: redactSecrets(cleanPublicText(value.needs, 1_000)) || null,
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt),
    startedAt: normalizeTimestamp(value.startedAt),
    transcriptAvailable: value.transcriptAvailable === true || Boolean(value.linkScanPath),
    stateTrusted: value.stateTrusted !== false,
  };
}

function safeTranscriptPath(value, configDirectory) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const root = path.resolve(configDirectory, "projects");
  const target = path.resolve(value);
  return pathWithin(root, target) && target.endsWith(".jsonl") ? target : null;
}

async function readSecureFile(filePath, {
  maxBytes,
  expectedUid,
  expectedGid,
  allowMissing = false,
  rootDirectory = null,
} = {}) {
  if (rootDirectory) await assertSafeAncestors(filePath, rootDirectory);
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (allowMissing && ["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw runtimeError(502, "目标文件不安全：必须是普通文件");
  if ((stat.mode & 0o777) !== 0o600) throw runtimeError(502, "文件权限必须为 0600");
  if (Number.isInteger(expectedUid) && stat.uid !== expectedUid) throw runtimeError(502, "文件属主不匹配");
  if (Number.isInteger(expectedGid) && stat.gid !== expectedGid) throw runtimeError(502, "文件属组不匹配");
  if (stat.size > maxBytes) throw runtimeError(502, "文件超过允许大小");
  return fs.readFile(filePath, "utf8");
}

async function assertSafeAncestors(filePath, rootDirectory) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(filePath);
  if (!pathWithin(root, target)) throw runtimeError(502, "文件路径超出安全目录");
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw runtimeError(502, "文件路径根目录不安全");
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return;
  }
  const relative = path.relative(root, path.dirname(target));
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw runtimeError(502, "文件路径目录不安全");
    }
  }
}

async function writeSecureFile(filePath, content, { expectedUid, expectedGid } = {}) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
  try {
    const existing = await fs.lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw runtimeError(500, "后台 Agent 元数据文件不安全");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.chmod(tempPath, 0o600);
  if (Number.isInteger(expectedUid) && Number.isInteger(expectedGid)) {
    await fs.chown(tempPath, expectedUid, expectedGid).catch(() => {});
  }
  await fs.rename(tempPath, filePath);
}

function pickRecentlyStarted(entries, { cwd, name, startedAt }) {
  return entries
    .filter((entry) => entry.cwd === cwd && (!name || entry.name === name))
    .sort((left, right) => Math.abs((left.startedAt || 0) - startedAt) - Math.abs((right.startedAt || 0) - startedAt))[0] || null;
}

function normalizeStateName(value) {
  const state = String(value || "").trim().toLowerCase();
  return ALLOWED_STATES.has(state) ? state : "unknown";
}

function normalizeTempo(value) {
  const tempo = String(value || "").trim().toLowerCase();
  return ALLOWED_TEMPO.has(tempo) ? tempo : "unknown";
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) return MAX_TRANSCRIPT_LINES;
  return Math.min(limit, MAX_TRANSCRIPT_LINES);
}

function normalizeOptionalText(value, maxLength) {
  return typeof value === "string" ? value.replace(/[\u0000\r\n]/g, " ").trim().slice(0, maxLength) : "";
}

function cleanPublicText(value, maxLength) {
  return normalizeOptionalText(value, maxLength).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|authorization|password)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/(ANTHROPIC_API_KEY\s*=\s*)([^\s,;]+)/gi, "$1[redacted]");
}

function sanitizeTranscriptValue(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value).slice(0, MAX_ITEM_TEXT);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeTranscriptValue(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (/^(?:providerEnv|env|environment|apiKey|api_key|token|accessToken|refreshToken|secret|authorization|headers)$/i.test(key)) continue;
    result[key] = sanitizeTranscriptValue(entry, depth + 1);
  }
  return result;
}

function pathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripTerminalControl(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(-32_000);
}

function cleanCommandError(output, fallback) {
  const source = stripTerminalControl(output);
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
  if (/EACCES|EPERM|permission denied/i.test(source)) {
    return `${fallback}（文件或进程权限不足，原始诊断已隐藏）`;
  }
  return `${fallback}（原始诊断已隐藏）`;
}

function runCommand(command, args, options, timeoutMs) {
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
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("exit", (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

function backgroundLogFailure(operation, error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,48}$/.test(error.code)
    ? ` · ${error.code}`
    : "";
  return `Claude 后台${operation}失败，原始诊断已隐藏${code}`;
}

function runtimeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
