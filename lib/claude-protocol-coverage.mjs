export const CLAUDE_PROTOCOL_BASELINE = "claude-code 2.1.236";

export const CLAUDE_CAPABILITY_STATES = new Set([
  "runtime",
  "internal",
  "custom-equivalent",
  "partial",
  "planned",
  "deferred",
  "not-applicable",
]);

export const CLAUDE_OPTION_COVERAGE = Object.freeze([
  runtime("--add-dir", "Workspace access"),
  runtime("--agent", "Custom agents"),
  runtime("--agents", "Inline agent definitions"),
  runtime("--allow-dangerously-skip-permissions", "Permission modes", { highRisk: true }),
  runtime("--allowed-tools", "Tool policy"),
  runtime("--append-system-prompt", "Project memory"),
  runtime("--autocompact", "Context compaction", {
    evidence: {
      server: ["lib/claude-runtime.mjs#normalizeClaudeLaunchSettings", "lib/claude-runtime.mjs#spawnClaude"],
      ui: ["public/app.js#renderClaudeExecutionSettings"],
      tests: ["test/claude-runtime.test.mjs#autocompact"],
    },
  }),
  notApplicable("--ax-screen-reader", "Accessibility", {
    reason: "The browser owns accessible rendering instead of the terminal renderer",
  }),
  customEquivalent("--background", "Native background agents", {
    replacement: "--bg",
    evidence: backgroundAgentEvidence(),
  }),
  internal("--bare", "Compatibility diagnostics"),
  runtime("--betas", "Anthropic beta headers", { highRisk: true }),
  runtime("--bg", "Native background agents", { evidence: backgroundAgentEvidence() }),
  runtime("--brief", "Agent-to-user messaging"),
  deferred("--chrome", "Claude in Chrome", { reason: "Server browser isolation requires a separate review" }),
  deferred("--cloud", "Cloud sessions", {
    administratorRequired: true,
    reason: "Cloud session creation and attachment require a separate account, data residency, and session-isolation review",
  }),
  customEquivalent("--continue", "Conversation recovery", { replacement: "--resume" }),
  deferred("--dangerously-skip-permissions", "Permission modes", {
    highRisk: true,
    replacement: "--allow-dangerously-skip-permissions plus explicit mode",
  }),
  deferred("--debug", "Diagnostics", { reason: "Raw upstream debug logs can contain sensitive data" }),
  deferred("--debug-file", "Diagnostics", { reason: "Raw upstream debug files bypass WFL redaction" }),
  customEquivalent("--disable-slash-commands", "Skills policy"),
  runtime("--disallowed-tools", "Tool policy"),
  runtime("--effort", "Model effort"),
  deferred("--environment", "Self-hosted cloud environments", {
    administratorRequired: true,
    reason: "Self-hosted cloud environments need explicit server registration and project-bound authorization",
  }),
  runtime("--exclude-dynamic-system-prompt-sections", "Prompt cache isolation"),
  runtime("--fallback-model", "Model fallback"),
  runtime("--file", "Remote file resources"),
  runtime("--fork-session", "Conversation branching"),
  runtime("--forward-subagent-text", "Subagent transcript"),
  runtime("--from-pr", "Pull request recovery"),
  internal("--help", "Compatibility inventory"),
  deferred("--ide", "IDE integration", { reason: "The browser workspace is the active IDE surface" }),
  runtime("--include-hook-events", "Hooks"),
  runtime("--include-partial-messages", "Streaming"),
  runtime("--input-format", "Streaming"),
  runtime("--json-schema", "Structured output"),
  runtime("--max-budget-usd", "Spend control"),
  runtime("--mcp-config", "MCP configuration"),
  runtime("--model", "Model selection"),
  customEquivalent("--name", "Conversation naming"),
  deferred("--no-chrome", "Claude in Chrome"),
  runtime("--no-session-persistence", "Ephemeral sessions"),
  runtime("--output-format", "Streaming"),
  runtime("--permission-mode", "Permission modes"),
  runtime("--plugin-dir", "Session plugins"),
  customEquivalent("--plugin-url", "Session plugins", {
    highRisk: true,
    administratorRequired: true,
    replacement: "Server-pinned download, ZIP validation, then --plugin-dir",
    evidence: {
      server: ["lib/claude-session-plugins.mjs#materializeClaudePluginUrls"],
      ui: ["public/app.js#Claude-settings"],
      tests: ["test/claude-session-plugins.test.mjs"],
    },
  }),
  runtime("--print", "Streaming"),
  runtime("--prompt-suggestions", "Prompt suggestions"),
  deferred("--remote-control", "Remote Control", { reason: "WFL already provides authenticated remote access" }),
  deferred("--remote-control-session-name-prefix", "Remote Control"),
  customEquivalent("--replay-user-messages", "Message idempotency", {
    replacement: "Client message IDs and server-side turn deduplication",
  }),
  runtime("--resume", "Conversation recovery"),
  runtime("--safe-mode", "Extension troubleshooting"),
  runtime("--session-id", "Conversation identity"),
  runtime("--setting-sources", "Configuration scopes"),
  runtime("--settings", "Hooks and managed settings"),
  runtime("--strict-mcp-config", "MCP isolation"),
  runtime("--system-prompt", "Prompt configuration"),
  deferred("--teleport", "Teleport sessions", {
    reason: "Teleport session restore requires a reviewed remote-session identity and lifecycle",
  }),
  deferred("--tmux", "Terminal worktrees", { reason: "Not applicable to browser-owned process lifecycle" }),
  customEquivalent("--tools", "Tool policy", { replacement: "--allowed-tools and --disallowed-tools" }),
  runtime("--verbose", "Streaming"),
  internal("--version", "Compatibility inventory"),
  runtime("--worktree", "Worktrees"),
]);

export const CLAUDE_COMMAND_COVERAGE = Object.freeze([
  runtime("agents", "Native background agents", {
    evidence: backgroundAgentEvidence(),
  }),
  internal("auth", "Official login"),
  runtime("auto-mode", "Automatic permission classifier", {
    evidence: {
      server: ["lib/claude-runtime.mjs#autoModeSnapshot"],
      ui: ["public/app.js#renderClaudeAutoMode"],
      tests: ["test/claude-runtime.test.mjs#Claude-Auto-Mode"],
    },
  }),
  internal("doctor", "Compatibility diagnostics"),
  deferred("gateway", "Enterprise gateway", { administratorRequired: true }),
  deferred("import", "Configuration import", {
    reason: "Native import writes external-agent configuration and needs preview, conflict, and secret-redaction handling",
  }),
  deferred("install", "CLI lifecycle", { replacement: "Pinned application dependency and compatibility gate" }),
  runtime("mcp", "MCP management", {
    evidence: {
      server: ["lib/claude-runtime.mjs#listMcpServers"],
      ui: ["public/app.js#renderClaudeMcpList"],
      tests: ["test/claude-runtime.test.mjs#Claude-MCP-configuration"],
    },
  }),
  runtime("plugin", "Plugin management", {
    highRisk: true,
    evidence: runtimeEvidence("test/claude-runtime.test.mjs"),
  }),
  runtime("project", "Project state", {
    evidence: {
      server: ["lib/claude-runtime.mjs#previewProjectPurge"],
      ui: ["public/app.js#previewClaudeProjectPurge"],
      tests: ["test/claude-runtime.test.mjs#Claude-project-purge"],
    },
  }),
  deferred("setup-token", "Long-lived authentication", {
    highRisk: true,
    reason: "Long-lived tokens require a dedicated encrypted account workflow",
  }),
  runtime("ultrareview", "Cloud code review", {
    highRisk: true,
    evidence: {
      server: ["lib/claude-runtime.mjs#startUltraReview"],
      ui: ["public/app.js#renderClaudeUltraReviews"],
      tests: ["test/claude-runtime.test.mjs#Claude-Ultra-Review"],
    },
  }),
  deferred("update", "CLI lifecycle", { replacement: "Pinned application dependency and compatibility gate" }),
]);

export const CLAUDE_TOP_LEVEL_EVENT_COVERAGE = Object.freeze([
  internal("control_request", "Control request lifecycle"),
  internal("control_cancel_request", "Control request lifecycle"),
  internal("control_response", "Control request lifecycle"),
  runtime("system", "System events"),
  runtime("stream_event", "Streaming"),
  runtime("assistant", "Assistant messages"),
  runtime("user", "User and tool-result messages"),
  runtime("prompt_suggestion", "Prompt suggestions"),
  runtime("rate_limit_event", "Official account usage limits"),
  runtime("result", "Turn completion"),
  runtime("hook_started", "Hooks"),
  runtime("hook_progress", "Hooks"),
  runtime("hook_response", "Hooks"),
  runtime("task_started", "Native background tasks"),
  runtime("task_progress", "Native background tasks"),
  runtime("task_notification", "Native background tasks"),
]);

export const CLAUDE_STREAM_EVENT_COVERAGE = Object.freeze([
  runtime("message_start", "Streaming"),
  runtime("content_block_start", "Streaming"),
  runtime("content_block_delta", "Streaming"),
  runtime("content_block_stop", "Streaming"),
]);

export const CLAUDE_SYSTEM_EVENT_COVERAGE = Object.freeze([
  runtime("init", "Native session identity"),
  internal("status", "Process status"),
  runtime("task_started", "Native background tasks"),
  runtime("task_progress", "Native background tasks"),
  runtime("task_notification", "Native background tasks"),
  runtime("compact_boundary", "Context compaction"),
  runtime("api_error", "API errors"),
  runtime("rewind_files", "File checkpoints"),
]);

export const CLAUDE_CONTROL_REQUEST_COVERAGE = Object.freeze([
  internal("initialize", "Runtime handshake"),
  runtime("can_use_tool", "Tool approval"),
  runtime("request_user_dialog", "User questions"),
  runtime("elicitation", "MCP elicitation"),
]);

export const CLAUDE_DIALOG_KIND_COVERAGE = Object.freeze([
  runtime("refusal_fallback_prompt", "Safety fallback"),
]);

export const CLAUDE_PERMISSION_MODE_COVERAGE = Object.freeze([
  runtime("acceptEdits", "Permission modes"),
  runtime("auto", "Permission modes"),
  runtime("bypassPermissions", "Permission modes", { highRisk: true }),
  runtime("manual", "Permission modes"),
  runtime("dontAsk", "Permission modes"),
  runtime("plan", "Permission modes"),
]);

export const CLAUDE_EFFORT_LEVEL_COVERAGE = Object.freeze([
  runtime("low", "Model effort"),
  runtime("medium", "Model effort"),
  runtime("high", "Model effort"),
  runtime("xhigh", "Model effort"),
  runtime("max", "Model effort"),
]);

export const CLAUDE_REQUIRED_INTERNAL_OPTIONS = Object.freeze([
  "--permission-prompt-tool",
]);

export function claudeProtocolCoverageSnapshot() {
  return {
    baseline: CLAUDE_PROTOCOL_BASELINE,
    options: coverageSnapshot(CLAUDE_OPTION_COVERAGE),
    commands: coverageSnapshot(CLAUDE_COMMAND_COVERAGE),
    topLevelEvents: coverageSnapshot(CLAUDE_TOP_LEVEL_EVENT_COVERAGE),
    streamEvents: coverageSnapshot(CLAUDE_STREAM_EVENT_COVERAGE),
    systemEvents: coverageSnapshot(CLAUDE_SYSTEM_EVENT_COVERAGE),
    controlRequests: coverageSnapshot(CLAUDE_CONTROL_REQUEST_COVERAGE),
    dialogKinds: coverageSnapshot(CLAUDE_DIALOG_KIND_COVERAGE),
    permissionModes: coverageSnapshot(CLAUDE_PERMISSION_MODE_COVERAGE),
    effortLevels: coverageSnapshot(CLAUDE_EFFORT_LEVEL_COVERAGE),
  };
}

export function claudeProtocolCoverageSections() {
  return [
    { key: "options", label: "Startup options", entries: CLAUDE_OPTION_COVERAGE },
    { key: "commands", label: "Commands", entries: CLAUDE_COMMAND_COVERAGE },
    { key: "topLevelEvents", label: "Top-level events", entries: CLAUDE_TOP_LEVEL_EVENT_COVERAGE },
    { key: "streamEvents", label: "Stream events", entries: CLAUDE_STREAM_EVENT_COVERAGE },
    { key: "systemEvents", label: "System events", entries: CLAUDE_SYSTEM_EVENT_COVERAGE },
    { key: "controlRequests", label: "Control requests", entries: CLAUDE_CONTROL_REQUEST_COVERAGE },
    { key: "dialogKinds", label: "Dialog kinds", entries: CLAUDE_DIALOG_KIND_COVERAGE },
    { key: "permissionModes", label: "Permission modes", entries: CLAUDE_PERMISSION_MODE_COVERAGE },
    { key: "effortLevels", label: "Effort levels", entries: CLAUDE_EFFORT_LEVEL_COVERAGE },
  ].map((section) => ({
    ...section,
    entries: section.entries.map((item) => ({ ...item, evidence: cloneEvidence(item.evidence) })),
  }));
}

export function claudeReviewedTopLevelEvent(type) {
  return CLAUDE_TOP_LEVEL_EVENT_COVERAGE.some((entry) => entry.method === type);
}

export function claudeReviewedStreamEvent(type) {
  return CLAUDE_STREAM_EVENT_COVERAGE.some((entry) => entry.method === type);
}

export function claudeReviewedSystemEvent(subtype) {
  return CLAUDE_SYSTEM_EVENT_COVERAGE.some((entry) => entry.method === subtype);
}

function coverageSnapshot(entries) {
  const counts = Object.fromEntries([...CLAUDE_CAPABILITY_STATES].map((state) => [state, 0]));
  for (const item of entries) counts[item.state] += 1;
  return {
    total: entries.length,
    counts,
    entries: entries.map((item) => ({ ...item })),
  };
}

function runtime(method, surface, extra = {}) {
  return entry(method, "runtime", surface, extra);
}

function internal(method, surface, extra = {}) {
  return entry(method, "internal", surface, extra);
}

function customEquivalent(method, surface, extra = {}) {
  return entry(method, "custom-equivalent", surface, extra);
}

function partial(method, surface, extra = {}) {
  return entry(method, "partial", surface, extra);
}

function planned(method, surface, extra = {}) {
  return entry(method, "planned", surface, extra);
}

function deferred(method, surface, extra = {}) {
  return entry(method, "deferred", surface, extra);
}

function notApplicable(method, surface, extra = {}) {
  return entry(method, "not-applicable", surface, extra);
}

function entry(method, state, surface, extra) {
  const suppliedEvidence = normalizeEvidence(extra.evidence);
  const evidence = hasEvidence(suppliedEvidence)
    ? suppliedEvidence
    : defaultEvidence(state);
  return Object.freeze({
    method,
    state,
    surface,
    origin: state === "custom-equivalent" ? "wfl-compatible" : "claude-native",
    ...extra,
    evidence: Object.freeze(evidence),
  });
}

function backgroundAgentEvidence() {
  return {
    server: ["lib/claude-background.mjs#ClaudeBackgroundAgents"],
    ui: ["public/app.js#renderClaudeBackgroundAgents"],
    tests: ["test/claude-runtime.test.mjs#native-background-agents"],
  };
}

function runtimeEvidence(testFile = "test/claude-runtime.test.mjs") {
  return {
    server: ["lib/claude-runtime.mjs#ClaudeRuntime"],
    ui: ["public/app.js#Claude-settings"],
    tests: [testFile],
  };
}

function defaultEvidence(state) {
  if (["runtime", "internal", "custom-equivalent", "partial"].includes(state)) {
    return runtimeEvidence();
  }
  return {
    server: ["lib/claude-protocol-coverage.mjs#coverage-registry"],
    ui: [],
    tests: ["test/claude-protocol-coverage.test.mjs#classified-inventory"],
  };
}

function normalizeEvidence(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    server: normalizeEvidenceList(source.server),
    ui: normalizeEvidenceList(source.ui),
    tests: normalizeEvidenceList(source.tests),
  });
}

function normalizeEvidenceList(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value
    .map((item) => String(item || "").trim())
    .filter(Boolean))]);
}

function hasEvidence(value) {
  return value.server.length > 0 || value.ui.length > 0 || value.tests.length > 0;
}

function cloneEvidence(value) {
  return {
    server: [...(value?.server || [])],
    ui: [...(value?.ui || [])],
    tests: [...(value?.tests || [])],
  };
}
