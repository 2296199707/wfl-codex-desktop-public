import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const fakeProtocolVersion = process.env.FAKE_CODEX_PROTOCOL_VERSION === "0.146.0"
  ? "0.146.0"
  : "0.149.0";

if (process.argv[2] === "--version" || process.argv[2] === "-V") {
  process.stdout.write(`codex-cli ${fakeProtocolVersion}\n`);
  process.exit(0);
}

if (process.argv[2] === "app-server" && ["--help", "-h"].includes(process.argv[3])) {
  process.stdout.write("Run the app server\n\nUsage: codex app-server [OPTIONS]\n");
  process.exit(0);
}

if (process.argv[2] === "app-server" && process.argv[3] === "generate-ts") {
  const outputIndex = process.argv.indexOf("--out");
  const outputDirectory = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (!outputDirectory) process.exit(2);
  const fixtureDirectory = path.dirname(new URL(import.meta.url).pathname);
  const client = JSON.parse(fs.readFileSync(
    path.join(fixtureDirectory, `codex-app-server-${fakeProtocolVersion}-client-methods.json`),
    "utf8",
  ));
  const server = JSON.parse(fs.readFileSync(
    path.join(fixtureDirectory, `codex-app-server-${fakeProtocolVersion}-server-methods.json`),
    "utf8",
  ));
  const notifications = JSON.parse(fs.readFileSync(
    path.join(fixtureDirectory, `codex-app-server-${fakeProtocolVersion}-notifications.json`),
    "utf8",
  ));
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, methods] of [
    ["ClientRequest.ts", client.methods],
    ["ServerRequest.ts", server.methods],
    ["ClientNotification.ts", notifications.experimental.client],
    ["ServerNotification.ts", notifications.experimental.server],
  ]) {
    fs.writeFileSync(
      path.join(outputDirectory, name),
      methods.map((method) => `export type ${JSON.stringify(method)} = { "method": ${JSON.stringify(method)} };`).join("\n"),
    );
  }
  process.exit(0);
}

if (process.argv[2] === "plugin") {
  runFakePluginCommand(process.argv.slice(3));
  process.exit(0);
}

function runFakePluginCommand(args) {
  const command = args[0];
  const statePath = path.join(process.env.CODEX_HOME || process.env.HOME || process.cwd(), "fake-plugin-state.json");
  let state = { installedIds: [], marketplaces: ["openai-curated"] };
  try {
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state = Array.isArray(stored)
      ? { installedIds: stored, marketplaces: ["openai-curated"] }
      : {
        installedIds: Array.isArray(stored.installedIds) ? stored.installedIds : [],
        marketplaces: Array.isArray(stored.marketplaces) ? stored.marketplaces : ["openai-curated"],
      };
  } catch {
    state = { installedIds: [], marketplaces: ["openai-curated"] };
  }
  if (!state.marketplaces.includes("openai-curated")) state.marketplaces.unshift("openai-curated");
  const available = [
    fakePlugin("linear", "openai-curated", "0.0.3", "ON_INSTALL"),
    fakePlugin("github", "openai-curated", "1.2.0", "ON_USE"),
    ...(state.marketplaces.includes("team-market")
      ? [fakePlugin("team-tool", "team-market", "2.0.0", "NONE")]
      : []),
  ];
  if (command === "marketplace") {
    const action = args[1];
    if (action === "list") {
      process.stdout.write(`${JSON.stringify({
        marketplaces: state.marketplaces.map((name) => ({
          name,
          root: name === "openai-curated" ? "/private/fake/openai" : `/private/fake/${name}`,
        })),
      })}\n`);
      return;
    }
    const value = String(args[2] || "");
    if (action === "add") {
      const name = fakeMarketplaceName(value);
      if (!name || state.marketplaces.includes(name)) process.exit(2);
      state.marketplaces.push(name);
      writeFakePluginState(statePath, state);
      process.stdout.write(`${JSON.stringify({ ok: true, name, action })}\n`);
      return;
    }
    if (action === "upgrade") {
      if (!state.marketplaces.includes(value) || value === "openai-curated") process.exit(2);
      process.stdout.write(`${JSON.stringify({ ok: true, name: value, action })}\n`);
      return;
    }
    if (action === "remove") {
      if (!state.marketplaces.includes(value) || value === "openai-curated") process.exit(2);
      state.marketplaces = state.marketplaces.filter((name) => name !== value);
      state.installedIds = state.installedIds.filter((id) => !id.endsWith(`@${value}`));
      writeFakePluginState(statePath, state);
      process.stdout.write(`${JSON.stringify({ ok: true, name: value, action })}\n`);
      return;
    }
    process.exit(2);
  }
  if (command === "add" || command === "remove") {
    const pluginId = String(args[1] || "");
    if (!available.some((plugin) => plugin.pluginId === pluginId)) process.exit(2);
    const ids = new Set(state.installedIds);
    if (command === "add") ids.add(pluginId);
    else ids.delete(pluginId);
    state.installedIds = [...ids];
    writeFakePluginState(statePath, state);
    process.stdout.write(`${JSON.stringify({ ok: true, pluginId, action: command })}\n`);
    return;
  }
  if (command === "list") {
    const installed = available
      .filter((plugin) => state.installedIds.includes(plugin.pluginId))
      .map((plugin) => ({ ...plugin, installed: true, enabled: true }));
    process.stdout.write(`${JSON.stringify({ installed, available })}\n`);
    return;
  }
  process.exit(2);
}

function fakePlugin(name, marketplaceName, version, authPolicy) {
  return {
    pluginId: `${name}@${marketplaceName}`,
    name,
    marketplaceName,
    version,
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy,
    source: { source: "local", path: `/private/fake/${marketplaceName}/${name}` },
  };
}

function fakeMarketplaceName(source) {
  const normalized = String(source || "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const name = normalized.split(/[/:]/).at(-1)?.toLowerCase() || "";
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(name) ? name : null;
}

function writeFakePluginState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}

const cwd = process.env.FAKE_CODEX_PROJECT || process.cwd();
const configuredModelProvider = process.env.FAKE_CODEX_CONFIG_MODEL_PROVIDER || "custom";
let fakeModelContextWindow = 200000;
const diagnosticTraceFile = process.env.FAKE_CODEX_DIAGNOSTIC_TRACE_FILE || "";
const diagnosticTraceId = process.env.FAKE_CODEX_DIAGNOSTIC_TRACE_ID || null;
const diagnosticThreadStateFile = process.env.FAKE_CODEX_DIAGNOSTIC_THREAD_STATE_FILE || "";
const diagnosticThreadStateVisible = process.env.FAKE_CODEX_DIAGNOSTIC_THREAD_STATE_VISIBLE === "1";
const diagnosticTurnStateFile = process.env.FAKE_CODEX_DIAGNOSTIC_TURN_STATE_FILE || "";
const diagnosticTurnStateVisible = process.env.FAKE_CODEX_DIAGNOSTIC_TURN_STATE_VISIBLE === "1";
const rejectUnmaterializedResume = process.env.FAKE_CODEX_REJECT_UNMATERIALIZED_RESUME === "1";
const rejectUnmaterializedWorktreeRead = process.env.FAKE_CODEX_REJECT_UNMATERIALIZED_WORKTREE_READ === "1";
const rejectUnmaterializedWorktreeResume = process.env.FAKE_CODEX_REJECT_UNMATERIALIZED_WORKTREE_RESUME === "1";
const rejectUnmaterializedWorktreeTurn = process.env.FAKE_CODEX_REJECT_UNMATERIALIZED_WORKTREE_TURN === "1";
const diagnosticPersistedTurnStatus = process.env.FAKE_CODEX_DIAGNOSTIC_TURN_PERSIST_STATUS === "inProgress"
  ? "inProgress"
  : "completed";
const diagnosticDelayOnceMethods = new Set(
  String(process.env.FAKE_CODEX_DIAGNOSTIC_DELAY_ONCE_METHODS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const diagnosticDelayedMethods = new Set();
const diagnosticTurnIdPrefix = String(process.env.FAKE_CODEX_DIAGNOSTIC_TURN_ID_PREFIX || "")
  .replace(/[^a-z0-9_-]/gi, "")
  .slice(0, 32);
const diagnosticThreadRecords = readDiagnosticThreadRecords();
const diagnosticTurnRecords = readDiagnosticTurnRecords();
const now = Math.floor(Date.now() / 1000);
const summary = {
  id: "thread_smoke_001",
  cwd,
  name: "Browser recovery smoke test",
  preview: "Recovered conversation preview",
  createdAt: now - 600,
  updatedAt: now,
  source: "appServer",
  status: { type: "idle" },
};
const olderSummary = {
  ...summary,
  id: "thread_smoke_older_page",
  name: "Older paginated conversation",
  preview: "Loaded from the second thread list page",
  createdAt: now - 7_200,
  updatedAt: now - 3_600,
};
const parallelSummary = {
  ...summary,
  id: "thread_smoke_parallel",
  name: "Parallel subagent isolation test",
  preview: "Independent conversation without subagent activity",
  createdAt: now - 1_200,
  updatedAt: now - 300,
};
const thread = {
  ...summary,
  turns: [
    ...Array.from({ length: 16 }, (_, index) => ({
      id: `turn_smoke_history_${index + 1}`,
      startedAt: now - (17 - index) * 60,
      status: "completed",
      items: [
        {
          id: `item_smoke_history_user_${index + 1}`,
          type: "userMessage",
          content: [{ type: "text", text: `Historical question ${index + 1}` }],
        },
        {
          id: `item_smoke_history_agent_${index + 1}`,
          type: "agentMessage",
          text: `Historical response ${index + 1}`,
        },
      ],
    })),
    {
      id: "turn_smoke_001",
      startedAt: now,
      status: "completed",
      items: [
        {
          id: "item_smoke_user",
          type: "userMessage",
          content: [{ type: "text", text: "Can this conversation be restored?" }],
        },
        {
          id: "item_smoke_agent",
          type: "agentMessage",
          text: "The authoritative conversation was restored.",
        },
        {
          id: "item_smoke_files",
          type: "agentMessage",
          text: `Open [the game](game/index.html) or inspect ${cwd}/game/game.mjs:1. Model \`gpt-5.3-codex\` is not a file.`,
        },
      ],
    },
    ...(diagnosticTurnStateVisible
      ? diagnosticTurnRecords
        .filter((record) => record.threadId === summary.id)
        .map((record) => structuredClone(record.turn))
      : []),
  ],
};
const parallelThread = {
  ...parallelSummary,
  turns: [
    {
      id: "turn_smoke_parallel_001",
      status: "completed",
      items: [
        {
          id: "item_smoke_parallel_user",
          type: "userMessage",
          content: [{ type: "text", text: "Does this thread stay isolated?" }],
        },
        {
          id: "item_smoke_parallel_agent",
          type: "agentMessage",
          text: "This conversation has no subagent activity.",
        },
      ],
    },
    ...(diagnosticTurnStateVisible
      ? diagnosticTurnRecords
        .filter((record) => record.threadId === parallelSummary.id)
        .map((record) => structuredClone(record.turn))
      : []),
  ],
};
let turnCounter = 1;
let threadCounter = 1;
let compactionCounter = 1;
const persistedDiagnosticThreads = diagnosticThreadStateVisible
  ? diagnosticThreadRecords.map((record) => ({
    ...structuredClone(record.thread),
    turns: diagnosticTurnStateVisible
      ? diagnosticTurnRecords
        .filter((turnRecord) => turnRecord.threadId === record.thread.id)
        .map((turnRecord) => structuredClone(turnRecord.turn))
      : [],
  }))
  : [];
const dynamicThreads = [...persistedDiagnosticThreads, parallelThread];
const unmaterializedThreadIds = new Set();
let rejectedUnmaterializedWorktreeTurn = false;
const injectedThreadIds = new Set();
const resumeCounts = new Map();
const loadedThreadIds = new Set();
const deletedThreadIds = new Set();
const collaborationModesByThread = new Map();
const goalsByThread = new Map();
const retryIntervals = new Map();
const emptyTurnsListThreadIds = new Set();
const ambiguousIdleSnapshotThreadIds = new Set();
const staleCompletionTurnIds = new Set();
const traceProjectionByTurnId = new Map();
const diagnosticRequestMethods = new Map();
const failNextInterruptTurnIds = new Set();
const approvalTurns = new Map();
const elicitationTurns = new Map();
const skillEnabledByPath = new Map();
const terminalProcesses = new Map();
const fileWatchers = new Map();
const fuzzyFileSearchSessions = new Map();
let skillExtraRoots = [];
let mcpConfigVersion = 1;
let mcp2026Enabled = false;
let threadSectionCounter = 1;
const threadSections = [];
const threadSectionByThreadId = new Map();
const threadOrderBySection = new Map();
const nativePlugins = [{
  id: "github@openai-curated-remote",
  remotePluginId: "plugin_connector_fixture_github",
  version: "1.0.0",
  localVersion: null,
  name: "github",
  shareContext: null,
  source: { type: "npm", package: "@openai/plugin-github", version: "1.0.0", registry: null },
  installed: false,
  installedAt: null,
  enabled: false,
  installPolicy: "AVAILABLE",
  installPolicySource: null,
  mustShowInstallationInterstitial: false,
  authPolicy: "ON_INSTALL",
  availability: "AVAILABLE",
  disabledReason: null,
  eligiblePlanTypes: null,
  interface: {
    displayName: "GitHub",
    shortDescription: "Work with GitHub repositories.",
    longDescription: null,
    developerName: "OpenAI",
    category: "Developer tools",
    capabilities: ["apps"],
    websiteUrl: null,
    privacyPolicyUrl: null,
    termsOfServiceUrl: null,
    composerIcon: null,
    logo: null,
    logoDark: null,
    screenshots: [],
  },
  keywords: ["git", "repository"],
}];
let mcpServers = {
  "fixture-mcp": {
    url: "https://mcp.example.test/api",
    auth: "oauth",
    http_headers: { Authorization: "Bearer fixture-secret-never-expose" },
    enabled: true,
    required: false,
    startup_timeout_sec: 10,
    tool_timeout_sec: 60,
  },
};
let appConfigs = {
  _default: {
    enabled: true,
    destructive_enabled: false,
    open_world_enabled: false,
  },
  connector_fixture_sites: {
    enabled: true,
    default_tools_approval_mode: "prompt",
  },
};
let memoryConfig = {
  featureEnabled: false,
  useMemories: true,
  generateMemories: true,
  disableOnExternalContext: false,
};
const threadMemoryModes = new Map();
let officialLoggedIn = false;
let officialResetCredits = 1;
let externalImportCounter = 1;

function collaborationTaskText(value) {
  return String(value || "");
}
const externalImportHistories = [];
const officialLoginId = "login_fake_oauth_001";
const officialLoginDelayMs = Math.max(100, Number(process.env.FAKE_CODEX_OFFICIAL_LOGIN_DELAY_MS) || 1_200);

function fakeThreadSection(threadId) {
  const sectionId = threadSectionByThreadId.get(threadId) || null;
  return sectionId ? threadSections.find((entry) => entry.id === sectionId) || null : null;
}

function fakeThreadSectionKey(threadId) {
  return threadSectionByThreadId.get(threadId) || "__unsectioned__";
}

function fakeThreadSectionOrder(key, candidates = []) {
  if (!threadOrderBySection.has(key)) {
    threadOrderBySection.set(
      key,
      candidates.filter((entry) => fakeThreadSectionKey(entry.id) === key).map((entry) => entry.id),
    );
  }
  return threadOrderBySection.get(key);
}

function fakeThreadWithSection(value) {
  const section = fakeThreadSection(value.id);
  return {
    ...value,
    section,
    sectionEnteredAt: section ? value.sectionEnteredAt || now : null,
  };
}

function fakeThreadsBySectionPosition(candidates) {
  return [...candidates].sort((left, right) => {
    const leftSection = fakeThreadSection(left.id);
    const rightSection = fakeThreadSection(right.id);
    const leftSectionIndex = leftSection
      ? threadSections.findIndex((entry) => entry.id === leftSection.id)
      : threadSections.length;
    const rightSectionIndex = rightSection
      ? threadSections.findIndex((entry) => entry.id === rightSection.id)
      : threadSections.length;
    if (leftSectionIndex !== rightSectionIndex) return leftSectionIndex - rightSectionIndex;
    const key = fakeThreadSectionKey(left.id);
    const order = fakeThreadSectionOrder(key, candidates);
    const leftIndex = order.indexOf(left.id);
    const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }).map(fakeThreadWithSection);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (Object.hasOwn(request, "id") && request.method) {
    diagnosticRequestMethods.set(String(request.id), request.method);
  }
  traceDiagnosticProtocol("in", request);
  if (!Object.hasOwn(request, "id")) return;
  if (!request.method) {
    const pending = approvalTurns.get(String(request.id));
    if (pending) {
      approvalTurns.delete(String(request.id));
      pending.turn.status = "completed";
      pending.turn.items.push({
        id: `item_smoke_approval_result_${turnCounter}`,
        type: "agentMessage",
        text: "The approval was handled by its conversation window.",
      });
      write({ method: "turn/completed", params: { threadId: pending.threadId, turn: pending.turn } });
      return;
    }
    const elicitation = elicitationTurns.get(String(request.id));
    if (!elicitation) return;
    elicitationTurns.delete(String(request.id));
    const action = request.result?.action;
    const content = request.result?.content;
    elicitation.turn.status = action === "cancel" ? "interrupted" : "completed";
    elicitation.turn.items.push({
      id: `item_smoke_elicitation_result_${turnCounter++}`,
      type: "agentMessage",
      text: action === "accept"
        ? `MCP ${elicitation.mode} accepted${content?.nickname ? ` for ${content.nickname}` : ""}.`
        : `MCP ${elicitation.mode} ${action || "invalid"}.`,
    });
    write({
      method: "serverRequest/resolved",
      params: {
        requestId: String(request.id),
        threadId: elicitation.threadId,
        turnId: elicitation.turn.id,
      },
    });
    write({
      method: "turn/completed",
      params: { threadId: elicitation.threadId, turn: elicitation.turn },
    });
    return;
  }
  const result = responseFor(request.method, request.params || {});
  if (result instanceof Error) {
    write({ id: request.id, error: { code: -32601, message: result.message } });
  } else if (result?.delayMs) {
    setTimeout(() => write({ id: request.id, result: result.value }), result.delayMs);
  } else if (
    diagnosticDelayOnceMethods.has(request.method)
    && !diagnosticDelayedMethods.has(request.method)
  ) {
    diagnosticDelayedMethods.add(request.method);
    setTimeout(() => write({ id: request.id, result }), 4_000);
  } else {
    write({ id: request.id, result });
  }
});

function responseFor(method, params) {
  if (method === "initialize") return { userAgent: "fake-codex" };
  if (
    fakeProtocolVersion === "0.146.0"
    && (
      method.startsWith("threadSection/")
      || method === "thread/section/move"
      || method === "plugin/search"
      || (method === "thread/list" && params.sortKey === "section_position")
    )
  ) {
    return new Error(`Method unavailable in Codex ${fakeProtocolVersion}: ${method}`);
  }
  if (
    ["thread/start", "thread/resume", "thread/fork"].includes(method)
    && (!Object.hasOwn(params, "developerInstructions") || params.developerInstructions !== null)
  ) {
    return new Error("Project preview developer instructions must be cleared");
  }
  if (method === "externalAgentConfig/detect") {
    const project = Array.isArray(params.cwds) && params.cwds[0] ? path.resolve(params.cwds[0]) : cwd;
    const cursor = params.migrationSource === "cursor";
    return {
      items: [
        {
          itemType: "AGENTS_MD",
          description: cursor
            ? `Migrate Cursor instructions from ${project}/.cursor to ${project}/AGENTS.md`
            : `Migrate ${project}/CLAUDE.md to ${project}/AGENTS.md`,
          cwd: project,
          details: null,
        },
        {
          itemType: cursor ? "SKILLS" : "SESSIONS",
          description: cursor
            ? `Migrate Cursor-managed skills from ${project}/.cursor/skills`
            : `Migrate recent sessions from ${process.env.HOME || "/tmp"}/.claude/projects`,
          cwd: null,
          details: {
            plugins: [],
            skills: [],
            sessions: [],
            mcpServers: [],
            hooks: [],
            subagents: [],
            commands: [],
          },
        },
      ],
    };
  }
  if (method === "externalAgentConfig/import") {
    const importId = `12345678-1234-4234-8234-${String(externalImportCounter++).padStart(12, "0")}`;
    const itemTypeResults = params.migrationItems.map((item) => ({
      itemType: item.itemType,
      successes: [{
        itemType: item.itemType,
        cwd: item.cwd || null,
        source: null,
        target: item.cwd && item.itemType === "AGENTS_MD" ? path.join(item.cwd, "AGENTS.md") : null,
      }],
      failures: [],
    }));
    externalImportHistories.unshift({
      importId,
      providerId: params.providerId || null,
      completedAtMs: Date.now(),
      successes: itemTypeResults.flatMap((entry) => entry.successes),
      failures: [],
    });
    queueMicrotask(() => {
      write({
        method: "externalAgentConfig/import/progress",
        params: { importId, itemTypeResults: itemTypeResults.slice(0, 1) },
      });
      write({
        method: "externalAgentConfig/import/completed",
        params: { importId, itemTypeResults },
      });
    });
    return { importId };
  }
  if (method === "externalAgentConfig/import/readHistories") {
    return { data: externalImportHistories, connectors: [] };
  }
  if (method === "externalAgentConfig/import/recordHistory") {
    const importId = `12345678-1234-4234-8234-${String(externalImportCounter++).padStart(12, "0")}`;
    externalImportHistories.unshift({
      importId,
      providerId: params.providerId || null,
      completedAtMs: Date.now(),
      successes: params.itemTypeResults.flatMap((entry) => entry.successes || []),
      failures: params.itemTypeResults.flatMap((entry) => entry.failures || []),
    });
    return { importId };
  }
  if (method === "fs/watch") {
    if (fileWatchers.has(params.watchId)) return new Error("watch already exists");
    const targetPath = path.resolve(String(params.path || ""));
    try {
      const stat = fs.statSync(targetPath);
      const watcher = fs.watch(targetPath, { persistent: false }, (_eventType, filename) => {
        const changedPath = stat.isDirectory() && filename
          ? path.join(targetPath, filename.toString())
          : targetPath;
        write({
          method: "fs/changed",
          params: { watchId: params.watchId, changedPaths: [changedPath] },
        });
      });
      watcher.on("error", () => {
        fileWatchers.delete(params.watchId);
        watcher.close();
      });
      fileWatchers.set(params.watchId, watcher);
      return { path: targetPath };
    } catch (error) {
      return new Error(error.message);
    }
  }
  if (method === "fs/unwatch") {
    const watcher = fileWatchers.get(params.watchId);
    if (!watcher) return new Error("watch not found");
    fileWatchers.delete(params.watchId);
    watcher.close();
    return {};
  }
  if (method === "fuzzyFileSearch") {
    return { files: fakeFuzzyFileSearch(params.query, params.roots) };
  }
  if (method === "fuzzyFileSearch/sessionStart") {
    if (fuzzyFileSearchSessions.has(params.sessionId)) return new Error("search session already exists");
    fuzzyFileSearchSessions.set(params.sessionId, { roots: [...params.roots] });
    return {};
  }
  if (method === "fuzzyFileSearch/sessionUpdate") {
    const session = fuzzyFileSearchSessions.get(params.sessionId);
    if (!session) return new Error("search session not found");
    queueMicrotask(() => {
      write({
        method: "fuzzyFileSearch/sessionUpdated",
        params: {
          sessionId: params.sessionId,
          query: params.query,
          files: fakeFuzzyFileSearch(params.query, session.roots),
        },
      });
      write({
        method: "fuzzyFileSearch/sessionCompleted",
        params: { sessionId: params.sessionId },
      });
    });
    return {};
  }
  if (method === "fuzzyFileSearch/sessionStop") {
    if (!fuzzyFileSearchSessions.delete(params.sessionId)) return new Error("search session not found");
    return {};
  }
  if (method === "command/exec") {
    const processId = String(params.processId || "");
    terminalProcesses.set(processId, { processId, command: params.command, cwd: params.cwd });
    const commandText = Array.isArray(params.command) ? params.command.join(" ") : "";
    setTimeout(() => {
      if (!terminalProcesses.has(processId)) return;
      write({
        method: "command/exec/outputDelta",
        params: {
          processId,
          stream: "stdout",
          deltaBase64: Buffer.from(`fake terminal: ${commandText}\n`).toString("base64"),
          capReached: false,
        },
      });
    }, 10);
    setTimeout(() => terminalProcesses.delete(processId), 35);
    return { delayMs: 40, value: { exitCode: 0, stdout: "", stderr: "" } };
  }
  if (method === "command/exec/write") {
    if (!terminalProcesses.has(params.processId)) return new Error("terminal process not found");
    if (params.deltaBase64) {
      write({
        method: "command/exec/outputDelta",
        params: {
          processId: params.processId,
          stream: "stdout",
          deltaBase64: params.deltaBase64,
          capReached: false,
        },
      });
    }
    return {};
  }
  if (method === "command/exec/resize") {
    return terminalProcesses.has(params.processId) ? {} : new Error("terminal process not found");
  }
  if (method === "command/exec/terminate") {
    terminalProcesses.delete(params.processId);
    return {};
  }
  if (method === "thread/backgroundTerminals/list") {
    return {
      data: [{
        itemId: "item_fixture_background_terminal",
        processId: "process_fixture_background",
        command: "npm run dev",
        cwd,
        osPid: 4242,
        cpuPercent: 1.5,
        rssKb: 32768,
      }],
      nextCursor: null,
    };
  }
  if (method === "thread/backgroundTerminals/terminate" || method === "thread/backgroundTerminals/clean") return {};
  if (method === "thread/shellCommand") return {};
  if (method === "model/list") {
    return {
      environmentProbe: process.env.MULTIUSER_TEST_SECRET || null,
      data: [
        {
          model: "gpt-smoke",
          displayName: "Smoke Model",
          description: "Browser test model",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deep" },
            { reasoningEffort: "ultra", description: "Automatic multi-agent collaboration" },
          ],
        },
        {
          model: "gpt-smoke-fast",
          displayName: "Smoke Fast Model",
          description: "Faster browser test model",
          isDefault: false,
          hidden: false,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
          ],
        },
      ],
    };
  }
  if (method === "configRequirements/read") {
    return { requirements: null };
  }
  if (method === "permissionProfile/list") {
    const profiles = [
      {
        id: ":read-only",
        description: "Read project files without changing them.",
        allowed: true,
      },
      {
        id: ":workspace",
        description: "Read and write inside the selected workspace.",
        allowed: true,
      },
      {
        id: ":danger-full-access",
        description: "Run without the Codex filesystem sandbox.",
        allowed: true,
      },
    ];
    return { data: profiles.slice(0, params.limit || profiles.length), nextCursor: null };
  }
  if (method === "collaborationMode/list") {
    return {
      data: [{
        name: "fixture-plan",
        mode: "plan",
        model: null,
        reasoning_effort: "high",
      }, {
        name: "fixture-default",
        mode: "default",
        model: null,
        reasoning_effort: null,
      }],
    };
  }
  if (method === "config/read") {
    const config = {
      model_provider: configuredModelProvider,
      model: "gpt-smoke",
      model_reasoning_effort: "medium",
      model_context_window: fakeModelContextWindow,
      model_auto_compact_token_limit: 160000,
      model_auto_compact_token_limit_scope: "body_after_prefix",
      approval_policy: "on-request",
      approvals_reviewer: "user",
      sandbox_mode: "workspace-write",
      model_providers: {
        [configuredModelProvider]: {
          name: "Browser current provider",
          base_url: "https://browser-provider.example.test/v1",
          wire_api: "responses",
          requires_openai_auth: true,
        },
      },
      mcp_servers: structuredClone(mcpServers),
      apps: structuredClone(appConfigs),
      features: {
        memories: memoryConfig.featureEnabled,
        mcp_2026_07_28: mcp2026Enabled,
      },
      memories: {
        use_memories: memoryConfig.useMemories,
        generate_memories: memoryConfig.generateMemories,
        disable_on_external_context: memoryConfig.disableOnExternalContext,
      },
    };
    return {
      config,
      layers: params.includeLayers === true ? [{
        name: { type: "user", file: `${process.env.HOME || "/tmp"}/.codex/config.toml`, profile: null },
        version: `fake-mcp-${mcpConfigVersion}`,
        config,
        disabledReason: null,
      }] : null,
    };
  }
  if (method === "config/batchWrite") {
    if (params.expectedVersion && params.expectedVersion !== `fake-mcp-${mcpConfigVersion}`) {
      return new Error("config version changed");
    }
    for (const edit of Array.isArray(params.edits) ? params.edits : []) {
      if (edit.keyPath === "features.memories") memoryConfig.featureEnabled = edit.value === true;
      else if (edit.keyPath === "features.mcp_2026_07_28") mcp2026Enabled = edit.value === true;
      else if (edit.keyPath === "memories.use_memories") memoryConfig.useMemories = edit.value === true;
      else if (edit.keyPath === "memories.generate_memories") memoryConfig.generateMemories = edit.value === true;
      else if (edit.keyPath === "memories.disable_on_external_context") {
        memoryConfig.disableOnExternalContext = edit.value === true;
      }
    }
    mcpConfigVersion += 1;
    return {
      status: "ok",
      version: `fake-mcp-${mcpConfigVersion}`,
      filePath: `${process.env.HOME || "/tmp"}/.codex/config.toml`,
      overriddenMetadata: null,
    };
  }
  if (method === "config/value/write") {
    if (params.expectedVersion && params.expectedVersion !== `fake-mcp-${mcpConfigVersion}`) {
      return new Error("config version changed");
    }
    if (params.keyPath === "mcp_servers") mcpServers = structuredClone(params.value || {});
    else if (params.keyPath === "apps") appConfigs = structuredClone(params.value || {});
    else if (params.keyPath === "model_context_window") fakeModelContextWindow = params.value;
    else return {};
    mcpConfigVersion += 1;
    return {
      status: "ok",
      version: `fake-mcp-${mcpConfigVersion}`,
      filePath: params.filePath || `${process.env.HOME || "/tmp"}/.codex/config.toml`,
      overriddenMetadata: null,
    };
  }
  if (method === "config/mcpServer/reload") return {};
  if (method === "experimentalFeature/list") {
    return {
      data: [{
        name: "memories",
        stage: "stable",
        displayName: "Memories",
        description: "Local Codex memories",
        announcement: null,
        enabled: memoryConfig.featureEnabled,
        defaultEnabled: false,
      }, {
        name: "apps",
        stage: "stable",
        displayName: null,
        description: null,
        announcement: null,
        enabled: true,
        defaultEnabled: true,
      }, {
        name: "plugins",
        stage: "stable",
        displayName: null,
        description: null,
        announcement: null,
        enabled: true,
        defaultEnabled: true,
      }, {
        name: "remote_plugin",
        stage: "stable",
        displayName: null,
        description: null,
        announcement: null,
        enabled: true,
        defaultEnabled: true,
      }, {
        name: "mcp_2026_07_28",
        stage: "experimental",
        displayName: "MCP 2026-07-28",
        description: "Optional MCP protocol revision",
        announcement: null,
        enabled: mcp2026Enabled,
        defaultEnabled: false,
      }, {
        name: "remote_compaction_v2",
        stage: "experimental",
        displayName: "Remote compaction",
        description: "Provider-managed conversation compaction",
        announcement: null,
        enabled: true,
        defaultEnabled: false,
      }],
      nextCursor: null,
    };
  }
  if (method === "app/installed") {
    return {
      apps: [{
        id: "connector_fixture_sites",
        runtimeName: "Fixture Sites",
        enabled: true,
        callable: true,
      }, {
        id: "connector_fixture_docs",
        runtimeName: "Fixture Docs",
        enabled: true,
        callable: false,
      }],
    };
  }
  if (method === "app/list") {
    const firstPage = !params.cursor;
    return {
      data: firstPage ? [{
        id: "connector_fixture_sites",
        name: "Fixture Sites",
        description: "Build and inspect fixture websites.",
        logoUrl: "https://example.invalid/sites.png",
        logoUrlDark: null,
        iconAssets: null,
        iconDarkAssets: null,
        distributionChannel: "ECOSYSTEM_DIRECTORY",
        branding: null,
        appMetadata: null,
        labels: null,
        installUrl: "https://chatgpt.com/apps/fixture/sites",
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: [],
      }] : [{
        id: "connector_fixture_box",
        name: "Fixture Box",
        description: "Read fixture files.",
        logoUrl: null,
        logoUrlDark: null,
        iconAssets: null,
        iconDarkAssets: null,
        distributionChannel: "ECOSYSTEM_DIRECTORY",
        branding: null,
        appMetadata: null,
        labels: null,
        installUrl: "https://chatgpt.com/apps/fixture/box",
        isAccessible: false,
        isEnabled: true,
        pluginDisplayNames: ["Fixture Box Plugin"],
      }],
      nextCursor: firstPage ? "fixture-app-page-2" : null,
    };
  }
  if (method === "app/read") {
    const metadata = {
      connector_fixture_sites: {
        id: "connector_fixture_sites",
        name: "Fixture Sites",
        description: "Build and inspect fixture websites.",
        iconUrl: "https://example.invalid/sites.png",
        iconUrlDark: null,
        distributionChannel: "ECOSYSTEM_DIRECTORY",
        installUrl: "https://chatgpt.com/apps/fixture/sites",
        pluginDisplayNames: [],
        toolSummaries: params.includeTools ? [{ name: "build_site", title: "Build site" }] : null,
      },
      connector_fixture_docs: {
        id: "connector_fixture_docs",
        name: "Fixture Docs",
        description: "Read fixture documents.",
        iconUrl: null,
        iconUrlDark: null,
        distributionChannel: "BUILT_IN",
        installUrl: null,
        pluginDisplayNames: [],
        toolSummaries: null,
      },
      connector_fixture_box: {
        id: "connector_fixture_box",
        name: "Fixture Box",
        description: "Read fixture files.",
        iconUrl: null,
        iconUrlDark: null,
        distributionChannel: "ECOSYSTEM_DIRECTORY",
        installUrl: "https://chatgpt.com/apps/fixture/box",
        pluginDisplayNames: ["Fixture Box Plugin"],
        toolSummaries: null,
      },
    };
    return {
      apps: params.appIds.map((id) => metadata[id]).filter(Boolean),
      missingAppIds: params.appIds.filter((id) => !metadata[id]),
    };
  }
  if (method === "mcpServerStatus/list") {
    return {
      data: Object.entries(mcpServers)
        .filter(([, config]) => config.enabled !== false)
        .slice(0, params.limit || 50)
        .map(([name, config]) => ({
          name,
          serverInfo: { name: "Fixture MCP", version: "1.0.0" },
          tools: {
            echo: {
              name: "echo",
              title: "Echo",
              description: "Return the supplied fixture text.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
              },
            },
          },
          resources: [{
            uri: "fixture://welcome",
            name: "Fixture welcome",
            description: "A small fixture MCP resource.",
            mimeType: "text/plain",
          }],
          resourceTemplates: [],
          authStatus: typeof config.url === "string" ? "notLoggedIn" : "unsupported",
        })),
      nextCursor: null,
    };
  }
  if (method === "mcpServer/resource/read") {
    if (!mcpServers[params.server]) return new Error("MCP server not found");
    return {
      contents: [{
        uri: params.uri,
        mimeType: "text/plain",
        text: "Fixture MCP resource content",
      }],
    };
  }
  if (method === "mcpServer/tool/call") {
    if (!mcpServers[params.server]) return new Error("MCP server not found");
    return {
      content: [{ type: "text", text: String(params.arguments?.text || "fixture echo") }],
      structuredContent: { echoed: params.arguments?.text || null },
      isError: false,
    };
  }
  if (method === "mcpServer/oauth/login") {
    if (!mcpServers[params.name]) return new Error("MCP server not found");
    setTimeout(() => write({
      method: "mcpServer/oauthLogin/completed",
      params: {
        name: params.name,
        threadId: params.threadId || null,
        success: true,
      },
    }), 500);
    return {
      authorizationUrl: "https://github.com/login/oauth/authorize?client_id=fake-codex-mcp",
    };
  }
  if (method === "modelProvider/capabilities/read") return { imageGeneration: true };
  if (method === "skills/list") {
    const requestedCwds = Array.isArray(params.cwds) && params.cwds.length ? params.cwds : [cwd];
    return {
      data: requestedCwds.map((requestedCwd) => {
        const skillPath = `${requestedCwd}/.codex/skills/release-check/SKILL.md`;
        return {
          cwd: requestedCwd,
          skills: [{
            name: "release-check",
            description: "Inspect the current release and report blocking risks.",
            shortDescription: "Check release readiness",
            path: skillPath,
            scope: "repo",
            enabled: skillEnabledByPath.get(skillPath) !== false,
            interface: {
              displayName: "Release Check",
              shortDescription: "Check release readiness",
              defaultPrompt: "Review this release before it is deployed.",
              brandColor: "#10a37f",
              iconSmall: null,
              iconLarge: null,
            },
            dependencies: {
              tools: [{
                type: "command",
                value: "git",
                command: "git status --short",
                description: "Read the local Git status.",
                transport: null,
                url: null,
              }],
            },
          }],
          errors: [{
            path: `${requestedCwd}/.codex/skills/broken-skill/SKILL.md`,
            message: "Missing required frontmatter field: description",
          }],
        };
      }),
      extraRoots: [...skillExtraRoots],
    };
  }
  if (method === "skills/config/write") {
    const skillPath = params.path || `${cwd}/.codex/skills/${params.name}/SKILL.md`;
    skillEnabledByPath.set(skillPath, params.enabled === true);
    queueMicrotask(() => write({ method: "skills/changed", params: {} }));
    return { effectiveEnabled: params.enabled === true };
  }
  if (method === "skills/extraRoots/set") {
    skillExtraRoots = [...params.extraRoots];
    queueMicrotask(() => write({ method: "skills/changed", params: {} }));
    return {};
  }
  if (method === "hooks/list") {
    const requestedCwds = Array.isArray(params.cwds) && params.cwds.length ? params.cwds : [cwd];
    return {
      data: requestedCwds.map((requestedCwd) => ({
        cwd: requestedCwd,
        hooks: [{
          key: "project-release-check",
          eventName: "userPromptSubmit",
          handlerType: "command",
          source: "project",
          sourcePath: `${requestedCwd}/.codex/hooks.json`,
          command: "node scripts/check-release.mjs",
          matcher: null,
          timeoutSec: 30,
          enabled: true,
          isManaged: false,
          trustStatus: "trusted",
          currentHash: "fake-hook-release-check",
          displayOrder: 0,
          pluginId: null,
          statusMessage: "Runs before a prompt is submitted.",
          additionalContextLimit: null,
        }, {
          key: "managed-security-review",
          eventName: "permissionRequest",
          handlerType: "prompt",
          source: "cloudRequirements",
          sourcePath: `${requestedCwd}/.codex/managed-hooks.json`,
          command: null,
          matcher: "danger-full-access",
          timeoutSec: 15,
          enabled: true,
          isManaged: true,
          trustStatus: "managed",
          currentHash: "fake-hook-managed-security",
          displayOrder: 1,
          pluginId: null,
          statusMessage: null,
          additionalContextLimit: 2500,
        }],
        errors: [],
        warnings: ["Project hooks execute with the active account permissions."],
      })),
    };
  }
  if (method === "account/read") {
    return {
      account: officialLoggedIn ? { type: "chatgpt", email: "browser@example.test", planType: "plus" } : null,
      requiresOpenaiAuth: true,
    };
  }
  if (method === "account/login/start") {
    if (
      params.type !== "chatgpt"
      || params.codexStreamlinedLogin !== true
      || params.useHostedLoginSuccessPage !== true
      || params.appBrand !== "codex"
    ) return new Error("Unsupported login request");
    setTimeout(() => {
      officialLoggedIn = true;
      write({
        method: "account/login/completed",
        params: { loginId: officialLoginId, success: true, error: null },
      });
    }, officialLoginDelayMs);
    return {
      type: "chatgpt",
      loginId: officialLoginId,
      authUrl: "https://auth.openai.com/oauth/authorize?client_id=fake-browser-test",
    };
  }
  if (method === "account/login/cancel") return { status: params.loginId === officialLoginId ? "canceled" : "notFound" };
  if (method === "account/logout") {
    officialLoggedIn = false;
    return {};
  }
  if (method === "account/usage/read") {
    return {
      summary: {
        lifetimeTokens: 123456,
        currentStreakDays: 4,
        longestStreakDays: 9,
        peakDailyTokens: 54321,
        longestRunningTurnSec: 600,
      },
      dailyUsageBuckets: null,
    };
  }
  if (method === "account/rateLimits/read") {
    return {
      rateLimits: fakeRateLimit(),
      rateLimitsByLimitId: { codex: fakeRateLimit() },
      rateLimitResetCredits: {
        availableCount: officialResetCredits,
        credits: officialResetCredits ? [{
          id: "reset-credit-secret-001",
          title: "Test reset",
          description: "One test reset",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: now - 60,
          expiresAt: now + 3600,
        }] : [],
      },
    };
  }
  if (method === "account/workspaceMessages/read") {
    return {
      featureEnabled: true,
      messages: [{
        messageId: "workspace-quota-001",
        messageType: "headline",
        messageBody: "Your workspace usage limit is nearly reached. api_key=sk-fixture-secret-never-show",
        createdAt: now - 30,
        archivedAt: null,
      }, {
        messageId: "workspace-announcement-001",
        messageType: "announcement",
        messageBody: "Workspace maintenance is scheduled for tomorrow.",
        createdAt: now - 60,
        archivedAt: null,
      }, {
        messageId: "workspace-archived-001",
        messageType: "announcement",
        messageBody: "Archived message must stay hidden.",
        createdAt: now - 120,
        archivedAt: now - 10,
      }],
    };
  }
  if (method === "account/sendAddCreditsNudgeEmail") {
    if (!["credits", "usage_limit"].includes(params.creditType)) {
      return new Error("Unsupported credits nudge");
    }
    return {};
  }
  if (method === "feedback/upload") {
    if (params.includeLogs !== false || Object.hasOwn(params, "threadId")) {
      return new Error("Unsafe feedback upload parameters");
    }
    if (
      !["bug", "incorrect_result", "performance", "feature_request", "other"]
        .includes(params.classification)
      || typeof params.reason !== "string"
      || params.reason.length < 1
      || params.reason.length > 900
      || /\b(?:sk-[A-Za-z0-9]|gh[opusr]_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]|Bearer\s+(?!\[REDACTED\])|api[_-]?key\s*[:=]\s*(?!\[REDACTED\])|password\s*[:=]\s*(?!\[REDACTED\]))/i
        .test(params.reason)
    ) {
      return new Error("Invalid safe feedback body");
    }
    const extraLogFiles = params.extraLogFiles == null ? [] : params.extraLogFiles;
    if (!Array.isArray(extraLogFiles) || extraLogFiles.length > 1) {
      return new Error("Too many feedback attachments");
    }
    for (const filename of extraLogFiles) {
      if (typeof filename !== "string") return new Error("Invalid feedback attachment");
      let content;
      try {
        content = fs.readFileSync(filename);
      } catch {
        return new Error("Missing feedback attachment");
      }
      const stat = fs.statSync(filename);
      if (
        (stat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (typeof process.getgid === "function" && stat.gid !== process.getgid())
      ) return new Error("Unsafe feedback attachment ownership");
      if (content.length > 32 * 1024) return new Error("Feedback attachment is too large");
      if (
        /\b(?:sk-[A-Za-z0-9]|gh[opusr]_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]|Bearer\s+(?!\[REDACTED\])|api[_-]?key\s*[:=]\s*(?!\[REDACTED\])|password\s*[:=]\s*(?!\[REDACTED\]))/i
          .test(content.toString("utf8"))
        || /"(?:prompt|reply|conversation|command|source)"\s*:/i.test(content.toString("utf8"))
      ) return new Error("Unsafe feedback attachment");
    }
    if (params.tags?.error_code === "FORCE FAILURE") {
      return new Error("Injected feedback failure");
    }
    return { threadId: "feedback-fixture-thread" };
  }
  if (method === "gitDiffToRemote") {
    if (typeof params.cwd !== "string" || !path.isAbsolute(params.cwd)) {
      return new Error("Invalid Git workspace");
    }
    try {
      const sha = execFileSync(
        "git",
        ["-c", `safe.directory=${params.cwd}`, "-C", params.cwd, "rev-parse", "@{upstream}"],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 5_000,
        },
      ).trim();
      const diff = execFileSync(
        "git",
        ["-c", `safe.directory=${params.cwd}`, "-C", params.cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3", sha, "--"],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GIT_TERMINAL_PROMPT: "0",
          },
          maxBuffer: 3 * 1024 * 1024,
          timeout: 10_000,
        },
      );
      return { sha, diff };
    } catch {
      return new Error("No upstream Git reference");
    }
  }
  if (method === "account/rateLimitResetCredit/consume") {
    if (!params.idempotencyKey) return new Error("Missing idempotency key");
    if (!officialResetCredits) return { outcome: "noCredit" };
    officialResetCredits -= 1;
    return { outcome: "reset" };
  }
  if (method === "threadSection/list") {
    const offset = params.cursor ? Number(/^fake-section-(\d+)$/.exec(params.cursor)?.[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) return new Error("Invalid section cursor");
    const limit = params.limit || 50;
    const data = threadSections.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + data.length < threadSections.length
        ? `fake-section-${offset + data.length}`
        : null,
    };
  }
  if (method === "threadSection/create") {
    const section = {
      id: `01912345-6789-7abc-8def-${String(threadSectionCounter++).padStart(12, "0")}`,
      name: params.name,
    };
    threadSections.push(section);
    threadOrderBySection.set(section.id, []);
    return { section };
  }
  if (method === "threadSection/update") {
    const section = threadSections.find((entry) => entry.id === params.sectionId);
    if (!section) return new Error("Section not found");
    section.name = params.name;
    return { section };
  }
  if (method === "threadSection/delete") {
    const index = threadSections.findIndex((entry) => entry.id === params.sectionId);
    if (index < 0) return new Error("Section not found");
    threadSections.splice(index, 1);
    const moved = threadOrderBySection.get(params.sectionId) || [];
    const unsectioned = fakeThreadSectionOrder("__unsectioned__");
    for (const threadId of moved) {
      threadSectionByThreadId.delete(threadId);
      if (!unsectioned.includes(threadId)) unsectioned.push(threadId);
    }
    threadOrderBySection.delete(params.sectionId);
    return {};
  }
  if (method === "thread/section/move") {
    const candidates = [...dynamicThreads, summary, olderSummary];
    if (!candidates.some((entry) => entry.id === params.threadId)) return new Error("Thread not found");
    if (params.sectionId && !threadSections.some((entry) => entry.id === params.sectionId)) {
      return new Error("Section not found");
    }
    for (const order of threadOrderBySection.values()) {
      const index = order.indexOf(params.threadId);
      if (index >= 0) order.splice(index, 1);
    }
    if (params.sectionId) threadSectionByThreadId.set(params.threadId, params.sectionId);
    else threadSectionByThreadId.delete(params.threadId);
    const key = params.sectionId || "__unsectioned__";
    const target = fakeThreadSectionOrder(key, candidates);
    const beforeIndex = params.beforeThreadId ? target.indexOf(params.beforeThreadId) : -1;
    if (beforeIndex >= 0) target.splice(beforeIndex, 0, params.threadId);
    else target.push(params.threadId);
    return {};
  }
  if (method === "plugin/search") {
    const term = String(params.searchTerm || "").toLowerCase();
    const data = nativePlugins
      .filter((plugin) => `${plugin.name} ${plugin.keywords.join(" ")}`.toLowerCase().includes(term))
      .slice(0, params.limit || 20)
      .map((plugin) => ({
        plugin: structuredClone(plugin),
        marketplaceName: "openai-curated-remote",
        marketplacePath: null,
      }));
    return { data, nextCursor: null };
  }
  if (method === "plugin/installed") {
    return {
      marketplaces: [{
        name: "openai-curated-remote",
        path: null,
        interface: null,
        plugins: nativePlugins.filter((plugin) => plugin.installed).map((plugin) => structuredClone(plugin)),
      }],
      marketplaceLoadErrors: [],
    };
  }
  if (method === "plugin/install") {
    const plugin = nativePlugins.find((entry) => entry.name === params.pluginName);
    if (!plugin) return new Error("Plugin not found");
    plugin.installed = true;
    plugin.enabled = true;
    plugin.installedAt = Math.floor(Date.now() / 1_000);
    return {
      authPolicy: plugin.authPolicy,
      appsNeedingAuth: [{
        id: "connector_fixture_github",
        name: "GitHub",
        description: "Authorize GitHub access.",
        category: "Developer tools",
      }],
    };
  }
  if (method === "plugin/uninstall") {
    const plugin = nativePlugins.find((entry) => entry.id === params.pluginId);
    if (!plugin?.installed) return new Error("Plugin not installed");
    plugin.installed = false;
    plugin.enabled = false;
    plugin.installedAt = null;
    return {};
  }
  if (method === "thread/list") {
    if (params.cursor === "force-rescue-snapshot-failure") {
      return new Error("Injected corrupt official thread index");
    }
    if (!Array.isArray(params.modelProviders) || params.modelProviders.length) {
      return new Error("Invalid thread/list modelProviders compatibility filter");
    }
    if ([...unmaterializedThreadIds].some((threadId) => !injectedThreadIds.has(threadId))) {
      return new Error("thread is not materialized yet; includeTurns is unavailable before first user message");
    }
    if (params.sortKey === "section_position") {
      if (!Object.hasOwn(params, "sectionId")) {
        return new Error("section-position sorting requires a section filter");
      }
      const candidates = [...dynamicThreads, summary, olderSummary]
        .filter((candidate) => (fakeThreadSection(candidate.id)?.id || null) === params.sectionId);
      return {
        data: fakeThreadsBySectionPosition(candidates),
        nextCursor: null,
      };
    }
    if (params.cursor === "fake-thread-list-page-2") return { data: [fakeThreadWithSection(olderSummary)], nextCursor: null };
    return {
      data: [...dynamicThreads, summary].map(fakeThreadWithSection),
      nextCursor: "fake-thread-list-page-2",
    };
  }
  if (method === "thread/search") {
    const term = String(params.searchTerm || "").toLowerCase();
    const candidates = [...dynamicThreads, summary, olderSummary];
    const data = candidates
      .filter((candidate) => Boolean(candidate.archived) === (params.archived === true))
      .map((candidate) => {
        const haystack = `${candidate.name || ""}\n${candidate.preview || ""}`.toLowerCase();
        const index = haystack.indexOf(term);
        return index < 0 ? null : {
          thread: { ...candidate, turns: [] },
          snippet: index < String(candidate.name || "").length
            ? candidate.name
            : candidate.preview,
        };
      })
      .filter(Boolean)
      .slice(0, params.limit || 30);
    return { data, nextCursor: null, backwardsCursor: data.length ? "fake-search-backwards" : null };
  }
  if (method === "thread/searchOccurrences") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId)
      || (params.threadId === olderSummary.id ? { ...olderSummary, turns: [] } : thread);
    return fakeThreadSearchOccurrences(requestedThread, params);
  }
  if (method === "thread/start") {
    const providerError = requiredProviderEnvironmentError(params);
    if (providerError) return providerError;
    const threadNumber = threadCounter++;
    const started = {
      id: diagnosticTurnIdPrefix
        ? `thread_smoke_dynamic_${diagnosticTurnIdPrefix}_${threadNumber}`
        : `thread_smoke_dynamic_${threadNumber}`,
      cwd: params.cwd || cwd,
      name: "New test conversation",
      preview: "",
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      source: "appServer",
      status: { type: "idle" },
      sandbox: params.sandbox || null,
      approvalPolicy: params.approvalPolicy || null,
      modelProvider: params.modelProvider || configuredModelProvider,
      turns: [],
    };
    dynamicThreads.unshift(started);
    loadedThreadIds.add(started.id);
    unmaterializedThreadIds.add(started.id);
    persistDiagnosticThread(started);
    write({ method: "thread/started", params: { thread: started } });
    const result = {
      thread: started,
      model: params.model || "gpt-smoke",
      reasoningEffort: params.effort || "medium",
    };
    return path.basename(started.cwd) === "cancel-background-start"
      ? { delayMs: 500, value: result }
      : result;
  }
  if (method === "thread/fork") {
    const source = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    if (unmaterializedThreadIds.has(source.id) && !injectedThreadIds.has(source.id)) {
      return new Error("thread is not materialized yet");
    }
    const forked = {
      ...structuredClone(source),
      id: `thread_smoke_fork_${threadCounter++}`,
      name: `${source.name || "Conversation"} branch`,
      forkedFromId: source.id,
      turns: params.excludeTurns ? [] : structuredClone(source.turns || []),
    };
    dynamicThreads.unshift(forked);
    loadedThreadIds.add(forked.id);
    const sourceGoal = goalsByThread.get(source.id);
    if (sourceGoal) {
      goalsByThread.set(forked.id, {
        ...structuredClone(sourceGoal),
        threadId: forked.id,
        updatedAt: Math.floor(Date.now() / 1000),
      });
    }
    write({ method: "thread/started", params: { thread: { ...forked, turns: [] } } });
    return { thread: forked, model: params.model || "gpt-smoke", reasoningEffort: "medium" };
  }
  if (method === "thread/inject_items") {
    if (!dynamicThreads.some((entry) => entry.id === params.threadId)) return new Error("Unknown thread");
    injectedThreadIds.add(params.threadId);
    return {};
  }
  if (method === "thread/resume") {
    if (deletedThreadIds.has(params.threadId)) {
      return new Error(`no rollout found for thread id ${params.threadId}`);
    }
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    if (
      (rejectUnmaterializedResume || (
        rejectUnmaterializedWorktreeResume
        && requestedThread.cwd.includes("/worktrees/")
      ))
      && unmaterializedThreadIds.has(params.threadId)
      && !injectedThreadIds.has(params.threadId)
    ) {
      return new Error(`no rollout found for thread id ${params.threadId}`);
    }
    const providerError = requiredProviderEnvironmentError(params);
    if (providerError) return providerError;
    requestedThread.modelProvider = params.modelProvider || requestedThread.modelProvider || configuredModelProvider;
    loadedThreadIds.add(requestedThread.id);
    write({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: requestedThread.id,
        turnId: "turn_smoke_001",
        tokenUsage: {
          total: {
            inputTokens: 70,
            cachedInputTokens: 20,
            outputTokens: 29,
            reasoningOutputTokens: 9,
            totalTokens: 99,
          },
          last: {
            inputTokens: 70,
            cachedInputTokens: 20,
            outputTokens: 29,
            reasoningOutputTokens: 9,
            totalTokens: 99,
          },
          modelContextWindow: 200000,
        },
      },
    });
    const value = {
      thread: params.excludeTurns ? { ...requestedThread, turns: [] } : requestedThread,
      initialTurnsPage: params.initialTurnsPage ? turnsPage({ ...params.initialTurnsPage, threadId: requestedThread.id }) : null,
      model: "gpt-smoke",
      reasoningEffort: requestedThread.reasoningEffort || "medium",
    };
    const resumeCount = resumeCounts.get(requestedThread.id) || 0;
    resumeCounts.set(requestedThread.id, resumeCount + 1);
    const repeatDelay = Number(process.env.FAKE_CODEX_REPEAT_RESUME_DELAY_MS || 0);
    return resumeCount === 1 && repeatDelay > 0 ? { delayMs: repeatDelay, value } : value;
  }
  if (method === "thread/read") {
    if (deletedThreadIds.has(params.threadId)) {
      return new Error(`no rollout found for thread id ${params.threadId}`);
    }
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    if (
      rejectUnmaterializedWorktreeRead
      && unmaterializedThreadIds.has(params.threadId)
      && requestedThread.cwd.includes("/worktrees/")
    ) {
      return new Error(`thread not loaded: ${params.threadId}`);
    }
    if (params.includeTurns && unmaterializedThreadIds.has(params.threadId)) {
      return new Error(
        `thread ${params.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
      );
    }
    if (ambiguousIdleSnapshotThreadIds.has(requestedThread.id) && params.includeTurns) {
      return {
        thread: {
          ...requestedThread,
          status: { type: "idle" },
          turns: [],
        },
      };
    }
    return { thread: params.includeTurns ? requestedThread : { ...requestedThread, turns: [] } };
  }
  if (method === "thread/turns/list") {
    if (deletedThreadIds.has(params.threadId)) {
      return new Error(`no rollout found for thread id ${params.threadId}`);
    }
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    if (
      rejectUnmaterializedWorktreeRead
      && unmaterializedThreadIds.has(params.threadId)
      && requestedThread.cwd.includes("/worktrees/")
    ) {
      return new Error(`thread not loaded: ${params.threadId}`);
    }
    return turnsPage(params);
  }
  if (method === "thread/items/list") return itemsPage(params);
  if (method === "thread/loaded/list") {
    const values = [...loadedThreadIds];
    const offset = /^fake-loaded-(\d+)$/.test(String(params.cursor || ""))
      ? Number(String(params.cursor).slice("fake-loaded-".length))
      : 0;
    const limit = Number(params.limit || values.length || 100);
    const data = values.slice(offset, offset + limit);
    return {
      data,
      nextCursor: offset + data.length < values.length ? `fake-loaded-${offset + data.length}` : null,
    };
  }
  if (method === "thread/unsubscribe") {
    if (!loadedThreadIds.has(params.threadId)) return { status: "notLoaded" };
    loadedThreadIds.delete(params.threadId);
    return { status: "unsubscribed" };
  }
  if (method === "thread/metadata/update") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId)
      || (params.threadId === thread.id ? thread : null);
    if (!requestedThread) return new Error("Unknown thread");
    if (params.gitInfo === null) requestedThread.gitInfo = null;
    else requestedThread.gitInfo = { ...(requestedThread.gitInfo || {}), ...params.gitInfo };
    return { thread: { ...requestedThread, turns: [] } };
  }
  if (method === "thread/name/set") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    requestedThread.name = params.name;
    write({ method: "thread/name/updated", params: { threadId: requestedThread.id, name: params.name } });
    return {};
  }
  if (method === "thread/settings/update") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    if (params.model) requestedThread.model = params.model;
    if (params.effort) requestedThread.reasoningEffort = params.effort;
    if (Object.hasOwn(params, "collaborationMode")) {
      collaborationModesByThread.set(requestedThread.id, params.collaborationMode);
    }
    write({
      method: "thread/settings/updated",
      params: {
        threadId: requestedThread.id,
        threadSettings: {
          cwd: requestedThread.cwd,
          model: requestedThread.model || "gpt-smoke",
          modelProvider: "custom",
          serviceTier: null,
          effort: params.effort || "medium",
          collaborationMode: collaborationModesByThread.get(requestedThread.id) || {
            mode: "default",
            settings: {
              model: requestedThread.model || "gpt-smoke",
              reasoning_effort: params.effort || "medium",
              developer_instructions: null,
            },
          },
        },
      },
    });
    return {};
  }
  if (method === "thread/memoryMode/set") {
    if (!dynamicThreads.some((entry) => entry.id === params.threadId) && params.threadId !== thread.id) {
      return new Error("Unknown thread");
    }
    if (!["enabled", "disabled"].includes(params.mode)) return new Error("Invalid memory mode");
    threadMemoryModes.set(params.threadId, params.mode);
    return {};
  }
  if (method === "memory/reset") {
    const codexHome = path.resolve(process.env.CODEX_HOME || path.join(process.env.HOME || "/tmp", ".codex"));
    const memoryDirectory = path.join(codexHome, "memories");
    if (codexHome !== path.parse(codexHome).root && path.basename(memoryDirectory) === "memories") {
      fs.rmSync(memoryDirectory, { recursive: true, force: true });
    }
    return {};
  }
  if (method === "thread/goal/get") {
    return { goal: structuredClone(goalsByThread.get(params.threadId) || null) };
  }
  if (method === "thread/goal/set") {
    const existing = goalsByThread.get(params.threadId) || null;
    if (
      params.status === "paused"
      && existing?.objective === "simulate manual pause failure"
    ) {
      return new Error("simulated Goal pause failure");
    }
    const objective = typeof params.objective === "string" ? params.objective.trim() : existing?.objective;
    if (!objective) return new Error("Goal objective is required");
    const timestamp = Math.floor(Date.now() / 1000);
    const goal = {
      threadId: params.threadId,
      objective,
      status: params.status || existing?.status || "active",
      tokenBudget: params.tokenBudget == null ? null : params.tokenBudget,
      tokensUsed: existing?.tokensUsed || 0,
      timeUsedSeconds: existing?.timeUsedSeconds || 0,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    goalsByThread.set(params.threadId, goal);
    write({
      method: "thread/goal/updated",
      params: { threadId: params.threadId, turnId: null, goal: structuredClone(goal) },
    });
    return { goal: structuredClone(goal) };
  }
  if (method === "thread/goal/clear") {
    const cleared = goalsByThread.delete(params.threadId);
    write({ method: "thread/goal/cleared", params: { threadId: params.threadId } });
    return { cleared };
  }
  if (method === "thread/archive" || method === "thread/unarchive") return {};
  if (method === "thread/delete") {
    const index = dynamicThreads.findIndex((entry) => entry.id === params.threadId);
    if (index >= 0) dynamicThreads.splice(index, 1);
    unmaterializedThreadIds.delete(params.threadId);
    injectedThreadIds.delete(params.threadId);
    goalsByThread.delete(params.threadId);
    loadedThreadIds.delete(params.threadId);
    deletedThreadIds.add(params.threadId);
    write({ method: "thread/deleted", params: { threadId: params.threadId } });
    return {};
  }
  if (method === "thread/compact/start") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    const sequence = compactionCounter++;
    const turn = {
      id: `turn_smoke_compaction_${sequence}`,
      status: "inProgress",
      items: [],
    };
    const item = { id: `item_smoke_compaction_${sequence}`, type: "contextCompaction" };
    requestedThread.turns.push(turn);
    write({ method: "turn/started", params: { threadId: requestedThread.id, turn } });
    setTimeout(() => {
      const startedAtMs = Date.now();
      turn.items.push(item);
      write({
        method: "item/started",
        params: { threadId: requestedThread.id, turnId: turn.id, item, startedAtMs },
      });
      setTimeout(() => {
        turn.status = "completed";
        write({
          method: "item/completed",
          params: { threadId: requestedThread.id, turnId: turn.id, item, completedAtMs: Date.now() },
        });
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 300);
    }, 40);
    return {};
  }
  if (method === "review/start") {
    unmaterializedThreadIds.delete(params.threadId);
    const sourceThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    const reviewThread = params.delivery === "detached"
      ? {
        ...sourceThread,
        id: `thread_smoke_review_${threadCounter++}`,
        name: "Detached code review",
        preview: "Reviewing workspace changes",
        turns: [],
      }
      : sourceThread;
    if (reviewThread !== sourceThread) dynamicThreads.push(reviewThread);
    const targetLabel = params.target?.type || "unknown";
    const turn = {
      id: `turn_smoke_review_${turnCounter++}`,
      status: "inProgress",
      items: [{
        id: `item_smoke_review_entered_${turnCounter}`,
        type: "enteredReviewMode",
        review: targetLabel,
      }],
    };
    reviewThread.turns.push(turn);
    write({ method: "turn/started", params: { threadId: reviewThread.id, turn } });
    setTimeout(() => {
      turn.items.push({
        id: `item_smoke_review_agent_${turnCounter}`,
        type: "agentMessage",
        text: `Review completed for ${targetLabel}.`,
      }, {
        id: `item_smoke_review_exited_${turnCounter}`,
        type: "exitedReviewMode",
        review: targetLabel,
      });
      turn.status = "completed";
      write({ method: "turn/completed", params: { threadId: reviewThread.id, turn } });
    }, 100);
    return { reviewThreadId: reviewThread.id, turn };
  }
  if (method === "turn/steer") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    const turn = requestedThread.turns.find((entry) => entry.id === params.expectedTurnId);
    const status = typeof turn?.status === "object" ? turn.status.type : turn?.status;
    if (!turn || status !== "inProgress") return new Error("The expected turn is not running");
    const existing = turn.items.find((item) =>
      item.type === "userMessage" && item.clientId === params.clientUserMessageId);
    if (existing) return {};
    const text = (params.input || []).find((item) => item.type === "text")?.text || "";
    const item = {
      id: `item_smoke_steer_${turnCounter++}`,
      type: "userMessage",
      clientId: params.clientUserMessageId,
      content: [{ type: "text", text }],
    };
    turn.items.push(item);
    persistDiagnosticTurn(requestedThread.id, turn);
    write({
      method: "item/started",
      params: {
        threadId: requestedThread.id,
        turnId: turn.id,
        item,
        startedAtMs: Date.now(),
      },
    });
    return {};
  }
  if (method === "turn/interrupt") {
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    const turn = requestedThread.turns.find((entry) => entry.id === params.turnId);
    if (failNextInterruptTurnIds.delete(params.turnId)) {
      return new Error("simulated targeted interrupt transport failure");
    }
    const interval = retryIntervals.get(params.turnId);
    if (interval) clearInterval(interval);
    retryIntervals.delete(params.turnId);
    // Simulate an optimistic/stale completion notification: the local WFL
    // task tracker has already seen a terminal event, but the native Turn is
    // still in progress and the first interrupt acknowledgement does not
    // actually stop it. The next interrupt is allowed to clean it up so the
    // integration test can prove the first response fails closed.
    if (staleCompletionTurnIds.delete(params.turnId)) return {};
    if (turn) {
      turn.status = typeof turn.status === "object" ? { type: "interrupted" } : "interrupted";
      write({ method: "turn/completed", params: { threadId: params.threadId, turn } });
    }
    return {};
  }
  if (method === "turn/start") {
    const providerError = requiredProviderEnvironmentError();
    if (providerError) return providerError;
    if (
      rejectUnmaterializedWorktreeTurn
      && !rejectedUnmaterializedWorktreeTurn
      && unmaterializedThreadIds.has(params.threadId)
      && dynamicThreads.find((entry) => entry.id === params.threadId)?.cwd.includes("/worktrees/")
    ) {
      rejectedUnmaterializedWorktreeTurn = true;
      return new Error(`thread not found: ${params.threadId}`);
    }
    if (Object.hasOwn(params, "collaborationMode")) {
      collaborationModesByThread.set(params.threadId, params.collaborationMode);
    }
    const effectiveCollaborationMode = collaborationModesByThread.get(params.threadId) || null;
    if (effectiveCollaborationMode && !effectiveCollaborationMode.settings?.model) {
      return new Error("Collaboration mode model must not be empty");
    }
    unmaterializedThreadIds.delete(params.threadId);
    const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
    const existing = requestedThread.turns.find((turn) =>
      turn.items.some((item) => item.type === "userMessage" && item.clientId === params.clientUserMessageId),
    );
    if (existing) return { turn: existing };
    const text = (params.input || []).find((item) => item.type === "text")?.text || "";
    const taskText = collaborationTaskText(text);
    if (taskText === "verify collaboration cleared" && effectiveCollaborationMode?.mode === "plan") {
      return new Error("The old thread remained in Plan mode");
    }
    if (
      taskText === "verify selected provider"
      && process.env.FAKE_CODEX_EXPECT_PROVIDER_KEY
      && process.env.CODEX_DESKTOP_PROVIDER_KEY !== process.env.FAKE_CODEX_EXPECT_PROVIDER_KEY
    ) {
      return new Error("The selected provider environment was not applied");
    }
    const collaborationEnabled = params.effort === "ultra"
      || effectiveCollaborationMode?.mode === "default";
    const turnNumber = turnCounter++;
    const turn = {
      id: diagnosticTurnIdPrefix
        ? `turn_smoke_dynamic_${diagnosticTurnIdPrefix}_${turnNumber}`
        : `turn_smoke_dynamic_${turnNumber}`,
      status: taskText === "coordinate stuck subagents" && collaborationEnabled
        ? { type: "inProgress" }
        : "inProgress",
      items: [{
        id: `item_smoke_dynamic_${turnCounter}`,
        type: "userMessage",
        clientId: params.clientUserMessageId,
        content: [{ type: "text", text }],
      }],
    };
    requestedThread.turns.push(turn);
    persistDiagnosticTurn(requestedThread.id, turn);
    if (taskText === "hold with empty turns list") {
      emptyTurnsListThreadIds.add(requestedThread.id);
    }
    if (taskText === "hold with ambiguous idle snapshot") {
      emptyTurnsListThreadIds.add(requestedThread.id);
      ambiguousIdleSnapshotThreadIds.add(requestedThread.id);
    }
    if (taskText === "emit stale completion while native remains running") {
      staleCompletionTurnIds.add(turn.id);
    }
    if (taskText === "fail the first targeted interrupt") {
      failNextInterruptTurnIds.add(turn.id);
    }
    if (taskText === "complete without turn notifications") {
      write({
        method: "thread/status/changed",
        params: {
          threadId: requestedThread.id,
          status: { type: "active", activeFlags: [] },
        },
      });
      setTimeout(() => {
        turn.items.push({
          id: `item_smoke_recovered_${turn.id}`,
          type: "agentMessage",
          text: "The terminal snapshot recovered the completed reply.",
          phase: "final_answer",
          status: "completed",
        });
        turn.status = "completed";
        write({
          method: "thread/status/changed",
          params: { threadId: requestedThread.id, status: { type: "idle" } },
        });
      }, 80);
      return { turn };
    }
    write({
      method: "turn/started",
      params: {
        threadId: requestedThread.id,
        turn: taskText === "complete with terminal summary only"
          ? { ...turn, items: [] }
        : turn,
      },
    });
    if (taskText === "emit stale completion while native remains running") {
      setTimeout(() => write({
        method: "turn/completed",
        params: {
          threadId: requestedThread.id,
          turn: { ...turn, status: "completed" },
        },
      }), 20);
    }
    if (taskText === "complete with terminal summary only") {
      const userItem = structuredClone(turn.items[0]);
      const agentItem = {
        id: `msg_smoke_terminal_summary_${turn.id}`,
        type: "agentMessage",
        text: "The summary-only completion preserved the complete live Turn.",
        phase: "final_answer",
        status: "inProgress",
      };
      setTimeout(() => write({
        method: "item/started",
        params: {
          threadId: requestedThread.id,
          turnId: turn.id,
          item: userItem,
          startedAtMs: Date.now(),
        },
      }), 20);
      setTimeout(() => write({
        method: "item/completed",
        params: {
          threadId: requestedThread.id,
          turnId: turn.id,
          item: userItem,
          completedAtMs: Date.now(),
        },
      }), 40);
      setTimeout(() => {
        turn.items.push(agentItem);
        write({
          method: "item/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item: agentItem,
            startedAtMs: Date.now(),
          },
        });
      }, 60);
      setTimeout(() => {
        agentItem.status = "completed";
        turn.status = "completed";
        const completedAtMs = Date.now();
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item: agentItem,
            completedAtMs,
          },
        });
        persistDiagnosticTurn(requestedThread.id, turn);
        write({
          method: "turn/completed",
          params: {
            threadId: requestedThread.id,
            turn: {
              id: turn.id,
              status: "completed",
              items: [structuredClone(agentItem)],
            },
            completedAtMs,
          },
        });
      }, 100);
      return { turn };
    }
    if (taskText.startsWith("$imagegen ")) {
      const item = {
        id: `item_smoke_image_generation_${turn.id}`,
        type: "imageGeneration",
        status: "inProgress",
        revisedPrompt: taskText.slice("$imagegen ".length),
        result: null,
      };
      setTimeout(() => {
        turn.items.push(item);
        write({
          method: "item/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            startedAtMs: Date.now(),
          },
        });
      }, 20);
      setTimeout(() => {
        item.status = "completed";
        item.result = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8xN3wAAAABJRU5ErkJggg==";
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            completedAtMs: Date.now(),
          },
        });
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 100);
      return { turn };
    }
    if (taskText.includes("图片已由网页配置的图片供应商生成并保存到")) {
      setTimeout(() => {
        turn.items.push({
          id: `item_smoke_provider_image_${turn.id}`,
          type: "agentMessage",
          text: "The provider image is ready.",
          phase: "final_answer",
          status: "completed",
        });
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 100);
      return { turn };
    }
    if (taskText === "trace five layer identity") {
      const item = {
        id: `msg_trace_live_${turn.id}`,
        type: "agentMessage",
        text: "",
        phase: "final_answer",
        status: "inProgress",
      };
      traceProjectionByTurnId.set(turn.id, {
        userClientId: params.clientUserMessageId,
        snapshotUserId: `item_trace_snapshot_user_${turn.id}`,
        liveAgentId: item.id,
        snapshotAgentId: `item_trace_snapshot_agent_${turn.id}`,
      });
      setTimeout(() => {
        turn.items.push(item);
        write({
          method: "item/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            startedAtMs: Date.now(),
          },
        });
      }, 20);
      setTimeout(() => {
        const delta = "FIVE_LAYER_TRACE";
        item.text += delta;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: item.id,
            delta,
          },
        });
      }, 60);
      setTimeout(() => {
        const delta = "_COMPLETE";
        item.text += delta;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: item.id,
            delta,
          },
        });
      }, 180);
      setTimeout(() => {
        item.status = "completed";
        turn.status = "completed";
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            completedAtMs: Date.now(),
          },
        });
        write({
          method: "turn/completed",
          params: {
            threadId: requestedThread.id,
            turn,
            completedAtMs: Date.now(),
          },
        });
      }, 2_000);
      return { turn };
    }
    if (taskText === "trace duplicate notification identity") {
      const item = {
        id: `msg_trace_duplicate_notification_${turn.id}`,
        type: "agentMessage",
        text: "",
        phase: "final_answer",
        status: "inProgress",
      };
      const delta = "DUPLICATE_NOTIFICATION_TRACE";
      setTimeout(() => {
        turn.items.push(item);
        write({
          method: "item/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            startedAtMs: Date.now(),
          },
        });
      }, 20);
      for (const delayMs of [60, 160]) {
        setTimeout(() => {
          item.text += delta;
          write({
            method: "item/agentMessage/delta",
            params: {
              threadId: requestedThread.id,
              turnId: turn.id,
              itemId: item.id,
              delta,
            },
          });
        }, delayMs);
      }
      setTimeout(() => {
        item.status = "completed";
        turn.status = "completed";
        const completedAtMs = Date.now();
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            completedAtMs,
          },
        });
        write({
          method: "turn/completed",
          params: { threadId: requestedThread.id, turn, completedAtMs },
        });
      }, 2_000);
      return { turn };
    }
    if (taskText.startsWith("measure websocket backpressure ")) {
      const probeId = taskText.slice("measure websocket backpressure ".length).replace(/[^a-z0-9-]/gi, "").slice(0, 64);
      const frameCount = 128;
      const payloadBytes = 64 * 1024;
      const payload = "x".repeat(payloadBytes);
      const item = {
        id: `item_backpressure_probe_${turnCounter}`,
        type: "agentMessage",
        text: "",
        phase: "final_answer",
        status: "inProgress",
      };
      setTimeout(() => {
        turn.items.push(item);
        write({
          method: "item/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            diagnosticProbe: {
              kind: "websocket-backpressure",
              id: probeId,
              frameCount,
              payloadBytes,
            },
          },
        });
        for (let index = 0; index < frameCount; index += 1) {
          write({
            method: "item/agentMessage/delta",
            params: {
              threadId: requestedThread.id,
              turnId: turn.id,
              itemId: item.id,
              delta: payload,
              diagnosticProbe: {
                kind: "websocket-backpressure",
                id: probeId,
                index,
                frameCount,
                payloadBytes,
              },
            },
          });
        }
        item.status = "completed";
        item.text = "Backpressure diagnostic completed.";
        turn.status = "completed";
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            diagnosticProbe: {
              kind: "websocket-backpressure",
              id: probeId,
              frameCount,
              payloadBytes,
            },
          },
        });
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 20);
      return { turn };
    }
    const hookRun = {
      id: `hook_run_${turn.id}`,
      eventName: "userPromptSubmit",
      executionMode: "sync",
      handlerType: "command",
      scope: "turn",
      source: "project",
      sourcePath: `${requestedThread.cwd}/.codex/hooks.json`,
      displayOrder: 0,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
      status: "running",
      statusMessage: "Checking the outgoing prompt.",
      entries: [],
    };
    write({
      method: "hook/started",
      params: { threadId: requestedThread.id, turnId: turn.id, run: hookRun },
    });
    setTimeout(() => write({
      method: "hook/completed",
      params: {
        threadId: requestedThread.id,
        turnId: turn.id,
        run: {
          ...hookRun,
          completedAt: hookRun.startedAt + 12,
          durationMs: 12,
          status: "completed",
          statusMessage: "Prompt passed the release hook.",
          entries: [{ kind: "context", text: "Release hook checked the current prompt." }],
        },
      },
    }), 12);
    if (taskText === "request window approval") {
      const approvalId = `approval_smoke_${turn.id}`;
      approvalTurns.set(approvalId, { threadId: requestedThread.id, turn });
      setTimeout(() => write({
        id: approvalId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: requestedThread.id,
          turnId: turn.id,
          itemId: `item_smoke_approval_${turn.id}`,
          approvalId: `callback_smoke_${turn.id}`,
          command: "printf approval-window-test",
          cwd: requestedThread.cwd,
          reason: "Verify window-scoped approval routing",
          availableDecisions: ["decline", "accept"],
        },
      }), 80);
      return { turn };
    }
    if (["request codex mcp form", "request codex mcp openai form", "request codex mcp url"].includes(taskText)) {
      const requestId = `elicitation_smoke_${turn.id}`;
      const mode = taskText.endsWith("url")
        ? "url"
        : taskText.includes("openai form") ? "openai/form" : "form";
      elicitationTurns.set(requestId, {
        threadId: requestedThread.id,
        turn,
        mode,
      });
      setTimeout(() => write({
        id: requestId,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: requestedThread.id,
          turnId: turn.id,
          serverName: "fixture-mcp",
          message: mode === "url" ? "Authorize the fixture MCP server" : "Configure the fixture MCP tool",
          mode,
          ...(mode === "url"
            ? { url: "https://github.com/login/oauth/authorize?client_id=fake-browser-test" }
            : {
              requestedSchema: {
                type: "object",
                properties: {
                  nickname: {
                    type: "string",
                    title: "Nickname",
                    minLength: 2,
                  },
                  retries: {
                    type: "integer",
                    title: "Retries",
                    minimum: 1,
                    maximum: 5,
                    default: 2,
                  },
                },
                required: ["nickname"],
              },
            }),
        },
      }), 80);
      return { turn };
    }
    if (taskText === "hold account quota inspection") {
      return { turn };
    }
    if (taskText === "complete then unload current thread") {
      setTimeout(() => {
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
        loadedThreadIds.delete(requestedThread.id);
        write({
          method: "thread/status/changed",
          params: { threadId: requestedThread.id, status: { type: "notLoaded" } },
        });
        write({ method: "thread/closed", params: { threadId: requestedThread.id } });
      }, 80);
      return { turn };
    }
    if (taskText === "measure conversation render performance") {
      const item = {
        id: `item_render_probe_${turnCounter}`,
        type: "agentMessage",
        text: "",
        phase: "final_answer",
        status: "inProgress",
      };
      const body = renderProbeAssistantBody();
      setTimeout(() => {
        turn.items.push(item);
        write({
          method: "item/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            startedAtMs: Date.now(),
          },
        });
      }, 20);
      setTimeout(() => {
        const delta = "STREAM_FIRST_VISIBLE_MARKER\n";
        item.text += delta;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: item.id,
            delta,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
      }, 40);
      setTimeout(() => {
        item.text += body;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: item.id,
            delta: body,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
      }, 120);
      setTimeout(() => {
        const delta = "\nSTREAM_FINAL_VISIBLE_MARKER";
        item.text += delta;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: item.id,
            delta,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
      }, 200);
      setTimeout(() => {
        item.status = "completed";
        turn.status = "completed";
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item,
            completedAtMs: Date.now(),
            probeEmittedAtUnixMs: Date.now(),
          },
        });
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 320);
      return { turn };
    }
    if (taskText === "measure current large payload blocking") {
      const commandItem = {
        id: `item_large_command_probe_${turnCounter}`,
        type: "commandExecution",
        command: "generate-large-output",
        aggregatedOutput: "",
        status: "inProgress",
      };
      const diffItem = {
        id: `item_large_diff_probe_${turnCounter}`,
        type: "fileChange",
        status: "inProgress",
        changes: [],
        aggregatedOutput: "",
      };
      const markerItem = {
        id: `item_large_marker_probe_${turnCounter}`,
        type: "agentMessage",
        text: "",
        phase: "final_answer",
        status: "inProgress",
      };
      const commandOutput = "x".repeat(2 * 1024 * 1024);
      const diff = renderLargeProbeDiff(20_000);
      setTimeout(() => {
        turn.items.push(commandItem, diffItem, markerItem);
        for (const item of [commandItem, diffItem, markerItem]) {
          write({
            method: "item/started",
            params: {
              threadId: requestedThread.id,
              turnId: turn.id,
              item,
              startedAtMs: Date.now(),
            },
          });
        }
      }, 20);
      setTimeout(() => {
        commandItem.aggregatedOutput = commandOutput;
        write({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: commandItem.id,
            delta: commandOutput,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
        const delta = "COMMAND_AFTER_LARGE_OUTPUT_MARKER";
        markerItem.text += delta;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: markerItem.id,
            delta,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
      }, 80);
      setTimeout(() => {
        diffItem.changes = [{
          path: "src/large-probe.js",
          kind: "update",
          diff,
        }];
        write({
          method: "item/fileChange/patchUpdated",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: diffItem.id,
            changes: diffItem.changes,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
        const delta = "\nDIFF_AFTER_LARGE_PATCH_MARKER";
        markerItem.text += delta;
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            itemId: markerItem.id,
            delta,
            probeEmittedAtUnixMs: Date.now(),
          },
        });
      }, 650);
      setTimeout(() => {
        commandItem.status = "completed";
        diffItem.status = "completed";
        markerItem.status = "completed";
        turn.status = "completed";
        const completedAtMs = Date.now();
        for (const item of [commandItem, diffItem, markerItem]) {
          write({
            method: "item/completed",
            params: {
              threadId: requestedThread.id,
              turnId: turn.id,
              item,
              completedAtMs,
            },
          });
        }
        write({
          method: "turn/completed",
          params: { threadId: requestedThread.id, turn, completedAtMs },
        });
      }, 1_800);
      return { turn };
    }
    if (taskText === "coordinate activity-only subagents" && collaborationEnabled) {
      const activityItems = ["alpha", "beta"].map((suffix) => ({
        id: `item_smoke_activity_${suffix}_${turnCounter}`,
        type: "subAgentActivity",
        agentThreadId: `thread_smoke_activity_${suffix}_${turnCounter}`,
        agentPath: `/root/${suffix}`,
        kind: "started",
      }));
      setTimeout(() => {
        for (const item of activityItems) {
          turn.items.push(item);
          write({
            method: "item/started",
            params: {
              threadId: requestedThread.id,
              turnId: turn.id,
              item,
              startedAtMs: Date.now(),
            },
          });
        }
      }, 30);
      setTimeout(() => {
        turn.status = "completed";
        write({
          method: "turn/completed",
          params: { threadId: requestedThread.id, turn, completedAtMs: Date.now() },
        });
      }, 1_200);
      return { turn };
    }
    if (["coordinate subagents", "coordinate stuck subagents"].includes(taskText) && collaborationEnabled) {
      const shouldRemainActive = taskText === "coordinate stuck subagents";
      const agentThreadId = `thread_smoke_subagent_${turnCounter}`;
      const collabItem = {
        id: `item_smoke_collab_${turnCounter}`,
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        senderThreadId: requestedThread.id,
        receiverThreadIds: [agentThreadId],
        prompt: shouldRemainActive
          ? "Keep running until the parent Ultra turn is explicitly interrupted."
          : "Inspect the independent test surface and report only the result.",
        model: "gpt-smoke",
        reasoningEffort: "high",
        status: "inProgress",
        agentsStates: { [agentThreadId]: { status: "pendingInit", message: null } },
      };
      const startedItem = structuredClone(collabItem);
      const startedAtMs = Date.now();
      setTimeout(() => {
        turn.items.push(collabItem);
        write({
          method: "item/started",
          params: { threadId: requestedThread.id, turnId: turn.id, item: collabItem, startedAtMs },
        });
      }, 30);
      if (!shouldRemainActive) {
        setTimeout(() => {
          collabItem.status = "completed";
          collabItem.agentsStates[agentThreadId] = { status: "completed", message: "Independent check completed" };
          turn.status = "completed";
          write({
            method: "item/completed",
            params: { threadId: requestedThread.id, turnId: turn.id, item: collabItem, completedAtMs: Date.now() },
          });
          write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
        }, 2_500);
        setTimeout(() => {
          write({
            method: "item/started",
            params: { threadId: requestedThread.id, turnId: turn.id, item: startedItem, startedAtMs },
          });
        }, 2_650);
      }
      return { turn };
    }
    if (taskText === "generate paginated turn history") {
      setTimeout(() => {
        for (let index = 1; index <= 120; index += 1) {
          turn.items.push({
            id: `item_smoke_paginated_${turnCounter}_${index}`,
            type: "agentMessage",
            text: `Paginated turn item ${index}`,
          });
        }
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 80);
      return { turn };
    }
    const retryErrorMessage = new Map([
      ["retry invalid api five times", {
        message: "Configured API is unavailable",
        codexErrorInfo: null,
      }],
      ["retry timeout five times", {
        message: "Request timed out while connecting to the API",
        codexErrorInfo: {
          responseStreamConnectionFailed: { httpStatusCode: null },
        },
      }],
      ["retry quota five times", {
        message: "429 rate limit exceeded",
        codexErrorInfo: "usageLimitExceeded",
      }],
      ["retry credentials five times", {
        message: "401 invalid API key",
        codexErrorInfo: "unauthorized",
      }],
    ]).get(taskText);
    if (retryErrorMessage) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts += 1;
        write({
          method: "error",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            willRetry: true,
            error: retryErrorMessage,
          },
        });
        if (attempts >= 12) {
          clearInterval(interval);
          retryIntervals.delete(turn.id);
        }
      }, 40);
      retryIntervals.set(turn.id, interval);
      return { turn };
    }
    if (["report monthly quota", "report token quota"].includes(taskText)) {
      setTimeout(() => {
        turn.status = "completed";
        write({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            tokenUsage: {
              total: {
                inputTokens: 12,
                cachedInputTokens: 3,
                outputTokens: 5,
                reasoningOutputTokens: 2,
                totalTokens: 17,
              },
              last: {
                inputTokens: 12,
                cachedInputTokens: 3,
                outputTokens: 5,
                reasoningOutputTokens: 2,
                totalTokens: 17,
              },
              modelContextWindow: 200000,
            },
          },
        });
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 50);
      return { turn };
    }
    if (taskText === "materialize before listing") {
      setTimeout(() => {
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: params.threadId, turn } });
      }, 50);
      return { turn };
    }
    if (taskText === "show codex 0.146 events") {
      const imageItem = {
        id: `item_smoke_image_view_${turnCounter}`,
        type: "imageView",
        path: path.join(requestedThread.cwd, "fixture-view.png"),
      };
      setTimeout(() => {
        turn.items.push(imageItem);
        write({
          method: "item/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            item: imageItem,
            completedAtMs: Date.now(),
          },
        });
        write({
          method: "model/safetyBuffering/updated",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            model: "gpt-smoke",
            useCases: ["cyber"],
            reasons: ["transient review"],
            showBufferingUi: true,
            fasterModel: "gpt-smoke-fast",
          },
        });
        write({
          method: "model/verification",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            verifications: ["trustedAccessForCyber"],
          },
        });
        write({
          method: "turn/moderationMetadata",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            metadata: { classification: "fixture-safe" },
          },
        });
        write({
          method: "guardianWarning",
          params: {
            threadId: requestedThread.id,
            message: "Guardian is reviewing a privileged command.",
            authorization: "must-be-redacted",
          },
        });
        write({
          method: "item/autoApprovalReview/started",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            startedAtMs: Date.now(),
            reviewId: `guardian_review_${turn.id}`,
            targetItemId: `guardian_target_${turn.id}`,
            review: {
              status: "inProgress",
              riskLevel: null,
              userAuthorization: null,
              rationale: null,
            },
            action: {
              type: "command",
              source: "unifiedExec",
              command: "sudo systemctl restart fixture",
              cwd: requestedThread.cwd,
              token: "must-be-redacted",
            },
          },
        });
        write({
          method: "thread/environment/connected",
          params: {
            threadId: requestedThread.id,
            environmentId: "fixture-devbox",
            execServerUrl: "wss://must-not-reach-browser.example.test",
          },
        });
        write({
          method: "future/safeEvent",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            apiKey: "must-be-redacted",
            detail: "future event remains visible",
          },
        });
      }, 25);
      setTimeout(() => {
        write({
          method: "item/autoApprovalReview/completed",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            startedAtMs: Date.now() - 150,
            completedAtMs: Date.now(),
            reviewId: `guardian_review_${turn.id}`,
            targetItemId: `guardian_target_${turn.id}`,
            decisionSource: "agent",
            review: {
              status: "denied",
              riskLevel: "critical",
              userAuthorization: "low",
              rationale: "The command exceeds the fixture permission boundary.",
            },
            action: {
              type: "command",
              source: "unifiedExec",
              command: "sudo systemctl restart fixture",
              cwd: requestedThread.cwd,
              password: "must-be-redacted",
            },
            event: {
              credentials: "must-be-redacted",
            },
          },
        });
        write({
          method: "thread/environment/disconnected",
          params: {
            threadId: requestedThread.id,
            environmentId: "fixture-devbox",
            execServerUrl: "wss://must-not-reach-browser.example.test",
          },
        });
        write({
          method: "model/rerouted",
          params: {
            threadId: requestedThread.id,
            turnId: turn.id,
            fromModel: "gpt-smoke",
            toModel: "gpt-smoke-fast",
            reason: "highRiskCyberActivity",
          },
        });
        turn.status = "completed";
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 250);
      return { turn };
    }
    if (
      ["finish concurrent task", "verify selected provider"].includes(taskText)
      || taskText.startsWith("image context browser pass ")
    ) {
      setTimeout(() => {
        turn.status = "completed";
        turn.items.push({
          id: `item_smoke_concurrent_${turnCounter}`,
          type: "agentMessage",
          text: "The independent concurrent task completed.",
        });
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 250);
      return { turn };
    }
    if (taskText === "disconnect exactly once") {
      setTimeout(() => {
        turn.status = "completed";
        const tokenUsage = {
          total: {
            inputTokens: 12,
            cachedInputTokens: 3,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 17,
          },
          last: {
            inputTokens: 12,
            cachedInputTokens: 3,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 17,
          },
          modelContextWindow: 200000,
        };
        write({
          method: "thread/tokenUsage/updated",
          params: { threadId: requestedThread.id, turnId: turn.id, tokenUsage },
        });
        write({
          method: "thread/tokenUsage/updated",
          params: { threadId: requestedThread.id, turnId: turn.id, tokenUsage },
        });
        write({ method: "turn/completed", params: { threadId: requestedThread.id, turn } });
      }, 4500);
      return { delayMs: 4000, value: { turn } };
    }
    return { turn };
  }
  return new Error(`Unsupported fake method: ${method}`);
}

function requiredProviderEnvironmentError(params = null) {
  if (process.env.FAKE_CODEX_REQUIRE_PROVIDER_KEY !== "1") return null;
  if (!process.env.CODEX_DESKTOP_PROVIDER_KEY) {
    return new Error("Missing environment variable: `CODEX_DESKTOP_PROVIDER_KEY`.");
  }
  if (params && params.modelProvider !== configuredModelProvider) {
    return new Error(`Expected model provider ${configuredModelProvider}`);
  }
  return null;
}

function readDiagnosticTurnRecords() {
  if (!diagnosticTurnStateFile) return [];
  try {
    const value = JSON.parse(fs.readFileSync(diagnosticTurnStateFile, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function readDiagnosticThreadRecords() {
  if (!diagnosticThreadStateFile) return [];
  try {
    const value = JSON.parse(fs.readFileSync(diagnosticThreadStateFile, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function persistDiagnosticThread(started) {
  if (!diagnosticThreadStateFile) return;
  const record = {
    thread: {
      id: started.id,
      cwd: started.cwd,
      name: started.name,
      preview: "",
      createdAt: started.createdAt,
      updatedAt: started.updatedAt,
      source: started.source,
      status: { type: "idle" },
      turns: [],
    },
  };
  const records = readDiagnosticThreadRecords()
    .filter((entry) => entry?.thread?.id !== started.id);
  records.push(record);
  fs.writeFileSync(diagnosticThreadStateFile, `${JSON.stringify(records)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(diagnosticThreadStateFile, 0o600);
}

function persistDiagnosticTurn(threadId, turn) {
  if (!diagnosticTurnStateFile) return;
  const userItems = (turn.items || []).filter((item) => item.type === "userMessage");
  const record = {
    threadId,
    turn: {
      id: turn.id,
      status: diagnosticPersistedTurnStatus,
      items: userItems.map((item) => ({
        id: item.id,
        type: "userMessage",
        clientId: item.clientId || null,
        content: [],
      })),
    },
  };
  const records = readDiagnosticTurnRecords()
    .filter((entry) => entry?.turn?.id !== turn.id);
  records.push(record);
  fs.writeFileSync(diagnosticTurnStateFile, `${JSON.stringify(records)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(diagnosticTurnStateFile, 0o600);
}

function fakeFuzzyFileSearch(query, roots) {
  const term = String(query || "").toLowerCase();
  const files = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    const pending = [path.resolve(root)];
    while (pending.length && files.length < 100) {
      const directory = pending.shift();
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if ([".git", "node_modules", ".codex-runtime", ".codex-desktop"].includes(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const index = relative.toLowerCase().indexOf(term);
        if (index < 0) continue;
        files.push({
          root,
          path: absolute,
          match_type: "file",
          file_name: entry.name,
          score: Math.max(1, 1_000 - relative.length),
          indices: Array.from({ length: term.length }, (_, offset) => index + offset),
        });
      }
    }
  }
  return files.sort((left, right) => right.score - left.score).slice(0, 100);
}

function fakeThreadSearchOccurrences(requestedThread, params) {
  const term = String(params.searchTerm || "").toLowerCase();
  const occurrences = [];
  for (const turn of Array.isArray(requestedThread.turns) ? requestedThread.turns : []) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const text = item.type === "userMessage"
        ? (Array.isArray(item.content) ? item.content.map((part) => part?.text || "").join("\n") : "")
        : item.type === "agentMessage" ? String(item.text || "") : "";
      const lower = text.toLowerCase();
      let offset = 0;
      while (offset < lower.length) {
        const match = lower.indexOf(term, offset);
        if (match < 0) break;
        const start = Math.max(0, match - 80);
        const end = Math.min(text.length, match + term.length + 120);
        occurrences.push({
          turnId: turn.id,
          itemId: item.id,
          snippet: text.slice(start, end),
          snippetMatchRange: {
            start: match - start,
            end: match - start + term.length,
          },
          turnCursor: JSON.stringify({ turnId: turn.id, includeAnchor: true }),
        });
        offset = match + Math.max(1, term.length);
      }
    }
  }
  const cursor = /^fake-occurrence-(\d+)$/.exec(String(params.cursor || ""));
  const offset = cursor ? Number(cursor[1]) : 0;
  const limit = Number(params.limit || 50);
  const data = occurrences.slice(offset, offset + limit);
  return {
    data,
    nextCursor: offset + data.length < occurrences.length
      ? `fake-occurrence-${offset + data.length}`
      : null,
  };
}

function fakeRateLimit() {
  return {
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: now + 1800 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: now + 3600 },
    credits: { hasCredits: true, unlimited: false, balance: "10.00" },
    individualLimit: null,
    rateLimitReachedType: null,
  };
}

function renderProbeAssistantBody() {
  const sections = [];
  for (let index = 1; index <= 320; index += 1) {
    sections.push(
      `## Render section ${index}\n`
      + `- **bold text** and \`inline code\` with `
      + `[source ${index}](src/render-probe-${index}.js:${index})\n`,
    );
  }
  return sections.join("");
}

function renderLargeProbeDiff(lineCount) {
  const lines = [
    "diff --git a/src/large-probe.js b/src/large-probe.js",
    "index 1111111..2222222 100644",
    "--- a/src/large-probe.js",
    "+++ b/src/large-probe.js",
    "@@ -1,9998 +1,9998 @@",
  ];
  for (let index = lines.length; index < lineCount; index += 1) {
    const ordinal = index - 4;
    lines.push(index % 2 === 0
      ? `-const oldValue${ordinal} = ${ordinal};`
      : `+const newValue${ordinal} = ${ordinal};`);
  }
  return lines.join("\n");
}

function turnsPage(params) {
  const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
  if (emptyTurnsListThreadIds.has(requestedThread.id)) {
    return { data: [], nextCursor: null, backwardsCursor: null };
  }
  const limit = Number(params.limit || requestedThread.turns.length);
  const ordered = params.sortDirection === "asc" ? [...requestedThread.turns] : [...requestedThread.turns].reverse();
  let offset = /^fake-(\d+)$/.test(String(params.cursor || ""))
    ? Number(String(params.cursor).slice("fake-".length))
    : 0;
  try {
    const anchor = JSON.parse(String(params.cursor || ""));
    const anchorIndex = ordered.findIndex((turn) => turn.id === anchor?.turnId);
    if (anchorIndex >= 0) offset = anchorIndex + (anchor.includeAnchor === false ? 1 : 0);
  } catch {
    // Legacy fake cursors remain numeric.
  }
  const end = Math.min(ordered.length, offset + limit);
  return {
    data: ordered.slice(offset, end).map((turn) => projectedTurnPage(turn, params.itemsView)),
    nextCursor: end < ordered.length ? `fake-${end}` : null,
    backwardsCursor: ordered.length ? "fake-newer-turns" : null,
  };
}

function projectedTurnPage(turn, itemsView = "summary") {
  const view = itemsView || "summary";
  const selectedItems = view === "notLoaded"
    ? []
    : view === "full"
      ? structuredClone(turn.items || [])
      : (turn.items || [])
        .filter((item) => ["userMessage", "agentMessage", "plan", "contextCompaction"].includes(item.type))
        .map((item) => structuredClone(item));
  const projection = traceProjectionByTurnId.get(turn.id);
  const items = projection
    ? selectedItems.map((item) => {
        if (item.type === "userMessage" && item.clientId === projection.userClientId) {
          return { ...item, id: projection.snapshotUserId };
        }
        if (item.id === projection.liveAgentId) {
          return { ...item, id: projection.snapshotAgentId };
        }
        return item;
      })
    : selectedItems;
  return {
    ...turn,
    itemsView: view,
    items,
  };
}

function itemsPage(params) {
  const requestedThread = dynamicThreads.find((entry) => entry.id === params.threadId) || thread;
  const entries = requestedThread.turns.flatMap((turn) =>
    (turn.items || []).map((item) => ({ turnId: turn.id, item: structuredClone(item) })))
    .filter((entry) => !params.turnId || entry.turnId === params.turnId);
  const ordered = params.sortDirection === "asc" ? entries : [...entries].reverse();
  const offset = /^fake-item-(\d+)$/.test(String(params.cursor || ""))
    ? Number(String(params.cursor).slice("fake-item-".length))
    : 0;
  const limit = Number(params.limit || 50);
  const data = ordered.slice(offset, offset + limit);
  return {
    data,
    nextCursor: offset + data.length < ordered.length ? `fake-item-${offset + data.length}` : null,
    backwardsCursor: data.length ? "fake-item-backwards" : null,
  };
}

function write(message) {
  traceDiagnosticProtocol("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
  if (message?.method === "turn/started" && message.params?.threadId) {
    loadedThreadIds.add(message.params.threadId);
    process.stdout.write(`${JSON.stringify({
      method: "thread/status/changed",
      params: {
        threadId: message.params.threadId,
        status: { type: "active", activeFlags: [] },
      },
    })}\n`);
  }
  if (message?.method === "turn/completed" && message.params?.threadId) {
    process.stdout.write(`${JSON.stringify({
      method: "thread/status/changed",
      params: {
        threadId: message.params.threadId,
        status: { type: "idle" },
      },
    })}\n`);
  }
}

function traceDiagnosticProtocol(direction, message) {
  if (!diagnosticTraceFile || !message || typeof message !== "object") return;
  const rpcId = Object.hasOwn(message, "id") ? String(message.id) : null;
  const rpcMethod = typeof message.method === "string"
    ? message.method
    : rpcId ? diagnosticRequestMethods.get(rpcId) || null : null;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const result = message.result && typeof message.result === "object" ? message.result : {};
  const turn = params.turn && typeof params.turn === "object"
    ? params.turn
    : result.turn && typeof result.turn === "object"
      ? result.turn
      : null;
  const item = params.item && typeof params.item === "object" ? params.item : null;
  const pageTurns = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.initialTurnsPage?.data)
      ? result.initialTurnsPage.data
      : [];
  const row = {
    schemaVersion: 1,
    traceId: diagnosticTraceId,
    layer: "app-server",
    direction,
    atUnixMs: Date.now(),
    rpcId,
    method: rpcMethod,
    threadId: params.threadId || turn?.threadId || result.thread?.id || null,
    turnId: params.turnId || turn?.id || null,
    expectedTurnId: params.expectedTurnId || null,
    cwd: params.cwd || null,
    sandbox: params.sandbox || null,
    approvalPolicy: params.approvalPolicy || null,
    beforeTurnId: params.beforeTurnId || null,
    lastTurnId: params.lastTurnId || null,
    deferGoalContinuation: params.deferGoalContinuation === true,
    itemId: params.itemId || item?.id || null,
    itemType: item?.type || null,
    clientId: item?.clientId
      || params.clientUserMessageId
      || params._wflClientThreadRequestId
      || null,
    payloadBytes: Buffer.byteLength(JSON.stringify(message)),
    projection: pageTurns.map((entry) => ({
      turnId: entry?.id || null,
      status: typeof entry?.status === "object" ? entry.status?.type || null : entry?.status || null,
      itemIds: Array.isArray(entry?.items) ? entry.items.map((entryItem) => entryItem?.id || null) : [],
      itemTypes: Array.isArray(entry?.items) ? entry.items.map((entryItem) => entryItem?.type || null) : [],
    })),
  };
  fs.appendFileSync(diagnosticTraceFile, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  if (direction === "out" && rpcId && !message.method) diagnosticRequestMethods.delete(rpcId);
}
