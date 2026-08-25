import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_CONTROL_REQUEST_COVERAGE,
  CLAUDE_COMMAND_COVERAGE,
  CLAUDE_DIALOG_KIND_COVERAGE,
  CLAUDE_EFFORT_LEVEL_COVERAGE,
  CLAUDE_OPTION_COVERAGE,
  CLAUDE_PERMISSION_MODE_COVERAGE,
  CLAUDE_PROTOCOL_BASELINE,
  CLAUDE_REQUIRED_INTERNAL_OPTIONS,
  CLAUDE_STREAM_EVENT_COVERAGE,
  CLAUDE_SYSTEM_EVENT_COVERAGE,
  CLAUDE_TOP_LEVEL_EVENT_COVERAGE,
  claudeProtocolCoverageSections,
  claudeProtocolCoverageSnapshot,
} from "./claude-protocol-coverage.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectDirectory = path.dirname(moduleDirectory);
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 128_000;

const COVERAGE_BY_CAPABILITY_SURFACE = Object.freeze({
  helpOptions: CLAUDE_OPTION_COVERAGE,
  commands: CLAUDE_COMMAND_COVERAGE,
  permissionModes: CLAUDE_PERMISSION_MODE_COVERAGE,
  effortLevels: CLAUDE_EFFORT_LEVEL_COVERAGE,
  topLevelEvents: CLAUDE_TOP_LEVEL_EVENT_COVERAGE,
  streamEvents: CLAUDE_STREAM_EVENT_COVERAGE,
  systemEvents: CLAUDE_SYSTEM_EVENT_COVERAGE,
  controlRequests: CLAUDE_CONTROL_REQUEST_COVERAGE,
  dialogKinds: CLAUDE_DIALOG_KIND_COVERAGE,
});

const CRITICAL_CAPABILITIES = new Set([
  "helpOptions:--include-partial-messages",
  "helpOptions:--input-format",
  "helpOptions:--output-format",
  "helpOptions:--permission-mode",
  "helpOptions:--print",
  "helpOptions:--resume",
  "helpOptions:--session-id",
  "requiredInternalOptions:--permission-prompt-tool",
  "topLevelEvents:assistant",
  "topLevelEvents:result",
  "topLevelEvents:stream_event",
  "topLevelEvents:system",
  "topLevelEvents:user",
  "streamEvents:content_block_delta",
  "streamEvents:content_block_start",
  "streamEvents:content_block_stop",
  "streamEvents:message_start",
  "systemEvents:init",
  "controlRequests:initialize",
]);

export async function inspectClaudeCompatibility({
  command = process.env.CODEX_DESKTOP_CLAUDE_BIN
    || path.join(defaultProjectDirectory, "scripts", "claude-command"),
  projectDirectory = defaultProjectDirectory,
  detectedCapabilities = null,
  doctorOutput = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const fixture = await readBaselineFixture(projectDirectory);
  const duration = normalizeTimeout(timeoutMs);
  let detected = detectedCapabilities;
  let doctor = doctorOutput;
  if (!detected) {
    const [versionResult, helpResult, doctorResult, protocolProbe] = await Promise.all([
      run(command, ["--version"], { cwd: projectDirectory, timeoutMs: duration }),
      run(command, ["--help"], { cwd: projectDirectory, timeoutMs: duration }),
      run(command, ["doctor"], { cwd: projectDirectory, timeoutMs: duration }),
      probeClaudeProtocol(command, {
        cwd: projectDirectory,
        timeoutMs: Math.min(duration, 10_000),
      }),
    ]);
    detected = detectedCapabilitiesFromOutput({
      versionOutput: versionResult.stdout,
      helpOutput: helpResult.stdout,
      internalOptions: protocolProbe.internalOptions,
    });
    doctor = `${doctorResult.stdout || ""}\n${doctorResult.stderr || ""}`.trim();
  }
  return buildClaudeCompatibility({
    fixture,
    detectedCapabilities: detected,
    doctorOutput: doctor,
    checkedAt: Date.now(),
  });
}

export function buildClaudeCompatibility({
  fixture,
  detectedCapabilities,
  doctorOutput = "",
  checkedAt = Date.now(),
}) {
  const reviewed = normalizeFixture(fixture);
  const detected = normalizeDetectedCapabilities(detectedCapabilities);
  const surfaces = {
    helpOptions: compareSurface(reviewed.helpOptions, detected.helpOptions),
    commands: compareSurface(reviewed.commands, detected.commands),
    requiredInternalOptions: compareSurface(reviewed.requiredInternalOptions, detected.internalOptions),
    permissionModes: compareSurface(reviewed.permissionModes, detected.permissionModes),
    effortLevels: compareSurface(reviewed.effortLevels, detected.effortLevels),
    topLevelEvents: compareSurface(reviewed.topLevelEvents, detected.topLevelEvents),
    streamEvents: compareSurface(reviewed.streamEvents, detected.streamEvents),
    systemEvents: compareSurface(reviewed.systemEvents, detected.systemEvents),
    controlRequests: compareSurface(reviewed.controlRequestSubtypes, detected.controlRequestSubtypes),
    dialogKinds: compareSurface(reviewed.dialogKinds, detected.dialogKinds),
  };
  const semanticReviewed = reviewed.helpSemanticSha256 === detected.helpSemanticSha256;
  const versionReviewed = detected.version === reviewed.version;
  const doctor = sanitizeClaudeDoctor(doctorOutput);
  const commitReviewed = doctor.commit === reviewed.commit;
  const capabilitiesReviewed = Object.values(surfaces).every((surface) => surface.matches)
    && semanticReviewed
    && commitReviewed;
  const installationHealthy = doctor.installationHealthy === true;
  const compatible = versionReviewed && capabilitiesReviewed && installationHealthy;
  const impact = claudeCompatibilityImpact(surfaces);
  const activationAllowed = installationHealthy && impact.criticalIssues.length === 0;
  const state = compatible
    ? "compatible"
    : !installationHealthy
      ? "unhealthy"
      : !versionReviewed
        ? "version-drift"
        : "capability-drift";
  return {
    baseline: CLAUDE_PROTOCOL_BASELINE,
    installedVersion: detected.version,
    reviewedVersion: reviewed.version,
    generatedAt: reviewed.generatedAt,
    checkedAt: normalizeTimestamp(checkedAt),
    state,
    compatible,
    activationAllowed,
    decisionRequired: !compatible && activationAllowed,
    risk: compatible
      ? "compatible"
      : activationAllowed
        ? impact.limitations.length
          ? "limited"
          : "unreviewed"
        : "blocked",
    limitations: impact.limitations,
    criticalIssues: impact.criticalIssues,
    unreviewedAdditions: impact.unreviewedAdditions,
    versionReviewed,
    commitReviewed,
    capabilitiesReviewed,
    semanticReviewed,
    runtimeAutoUpdateBlocked: true,
    doctor,
    surfaces,
    coverage: compactCoverage(claudeProtocolCoverageSnapshot()),
    capabilityGroups: implementationCoverageGroups(),
    deferredGroups: deferredCoverageGroups(),
  };
}

export function assertClaudeActivationAllowed(snapshot) {
  if (snapshot?.activationAllowed === true) return snapshot;
  const detail = snapshot?.doctor?.installationHealthy === false
    ? "Claude Doctor reported an unhealthy installation"
    : (snapshot?.criticalIssues || [])
        .slice(0, 8)
        .map((item) => `${item.feature}: ${item.method}`)
        .join("; ") || "basic Claude conversation capabilities are unavailable";
  const error = new Error(`Claude core compatibility check failed: ${detail}`);
  error.code = "ERR_CLAUDE_CORE_CAPABILITY_DRIFT";
  error.snapshot = snapshot;
  throw error;
}

export async function assertClaudeCompatible(options = {}) {
  const snapshot = await inspectClaudeCompatibility(options);
  if (snapshot.compatible) return snapshot;
  const drift = Object.entries(snapshot.surfaces)
    .flatMap(([surface, value]) => [
      ...value.added.map((item) => `${surface} added ${item}`),
      ...value.removed.map((item) => `${surface} removed ${item}`),
    ])
    .slice(0, 12);
  if (!snapshot.semanticReviewed) drift.push("help semantics changed");
  if (!snapshot.commitReviewed) drift.push("CLI commit changed");
  const detail = drift.length
    ? drift.join("; ")
    : `${snapshot.installedVersion || "unknown"} has not been reviewed against ${snapshot.reviewedVersion}`;
  const error = new Error(`Claude compatibility check failed: ${detail}`);
  error.code = "ERR_CLAUDE_CAPABILITY_DRIFT";
  error.snapshot = snapshot;
  throw error;
}

export function detectedCapabilitiesFromOutput({
  versionOutput,
  helpOutput,
  internalOptions = CLAUDE_REQUIRED_INTERNAL_OPTIONS,
  protocol = {},
}) {
  const normalizedHelp = normalizeHelpText(helpOutput);
  return normalizeDetectedCapabilities({
    version: parseClaudeVersion(versionOutput),
    helpOptions: parseHelpOptions(helpOutput),
    commands: parseHelpCommands(helpOutput),
    internalOptions,
    permissionModes: parseChoiceList(helpOutput, "--permission-mode"),
    effortLevels: parseEffortLevels(helpOutput),
    helpSemanticSha256: crypto.createHash("sha256").update(normalizedHelp).digest("hex"),
    topLevelEvents: protocol.topLevelEvents
      || CLAUDE_TOP_LEVEL_EVENT_COVERAGE.map((entry) => entry.method),
    streamEvents: protocol.streamEvents
      || CLAUDE_STREAM_EVENT_COVERAGE.map((entry) => entry.method),
    systemEvents: protocol.systemEvents
      || CLAUDE_SYSTEM_EVENT_COVERAGE.map((entry) => entry.method),
    controlRequestSubtypes: protocol.controlRequestSubtypes
      || CLAUDE_CONTROL_REQUEST_COVERAGE.map((entry) => entry.method),
    dialogKinds: protocol.dialogKinds
      || CLAUDE_DIALOG_KIND_COVERAGE.map((entry) => entry.method),
  });
}

export function sanitizeClaudeDoctor(output) {
  const text = stripTerminalControl(String(output || "")).replace(/\r/g, "");
  const running = text.match(/^Running:\s*([^\s(]+)(?:\s+\(([^)]+)\))?/m);
  const commit = text.match(/^Commit:\s*([a-f0-9]{7,64})\s*$/mi);
  const platform = text.match(/^Platform:\s*([A-Za-z0-9._-]+)\s*$/m);
  const installMethod = text.match(/^Config install method:\s*([A-Za-z0-9._-]+)\s*$/m);
  const search = text.match(/^Search:\s*([^\r\n]{1,120})\s*$/m);
  const autoUpdates = text.match(/^Auto-updates:\s*(enabled|disabled|unknown)(?:\s+\([^\r\n]{1,120}\))?\s*$/mi);
  const autoUpdateChannel = text.match(/^Auto-update channel:\s*([A-Za-z0-9._-]+)\s*$/m);
  const lastUpdateAttempt = text.match(/^Last update attempt:\s*([^\r\n]{1,160})\s*$/m);
  const noInstallationIssues = /No installation issues found\./i.test(text);
  const warningSummary = /\b\d+\s+warnings? found\b/i.test(text);
  const issueMarkers = [...text.matchAll(/^\s*(?!No\b)(?:\d+\s+)?(?:installation\s+)?(?:fatal\s+)?(?:issues?|errors?)\s+found[^\r\n]*$/gim)]
    .map((match) => sanitizeDoctorStatus(match[0]));
  const explicitFatalLines = text.split("\n")
    .filter((line) => /^\s*-\s*(?:fatal|error|critical|installation issue)\b/i.test(line))
    .map((line) => sanitizeDoctorStatus(line));
  const fatalIssues = [...new Set([...issueMarkers, ...explicitFatalLines].filter(Boolean))];
  const warningBlock = text.match(/\b\d+\s+warnings? found\s*\n([\s\S]*?)(?=\nFor a full setup checkup|$)/i);
  const warnings = warningBlock
    ? [...warningBlock[1].matchAll(/^\s*-\s*([^\r\n]{1,240})\s*$/gm)]
      .map((match) => sanitizeDoctorStatus(match[1]))
      .filter(Boolean)
    : [];
  return {
    running: boundedToken(running?.[1], 64),
    version: parseClaudeVersion(running?.[2] || ""),
    commit: boundedToken(commit?.[1], 64),
    platform: boundedToken(platform?.[1], 64),
    installMethod: boundedToken(installMethod?.[1], 64),
    search: sanitizeDoctorStatus(search?.[1]),
    autoUpdates: autoUpdates?.[1]?.toLowerCase() || "unknown",
    autoUpdateChannel: boundedToken(autoUpdateChannel?.[1], 64),
    lastUpdateAttempt: sanitizeDoctorStatus(lastUpdateAttempt?.[1]),
    warnings,
    fatalIssues,
    installationHealthy: fatalIssues.length === 0 && (noInstallationIssues || warningSummary),
  };
}

function parseClaudeVersion(value) {
  return String(value || "").match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
}

function parseHelpOptions(value) {
  const result = new Set();
  for (const match of String(value || "").matchAll(/--[A-Za-z][A-Za-z0-9-]*/g)) {
    const option = match[0].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    result.add(option);
  }
  return [...result].sort(compareText);
}

function parseHelpCommands(value) {
  const text = stripTerminalControl(String(value || "")).replace(/\r/g, "");
  const commands = text.split(/\nCommands:\s*\n/)[1] || "";
  const result = [];
  for (const line of commands.split("\n")) {
    const match = line.match(/^\s{2}([a-z][a-z0-9-]*)(?:\|[a-z][a-z0-9-]*)?(?:\s|\[)/);
    if (match) result.push(match[1]);
  }
  return [...new Set(result)].sort(compareText);
}

function parseChoiceList(value, option) {
  const text = normalizeHelpText(value).replace(/\n/g, " ");
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escaped}[\\s\\S]{0,800}?\\(choices: ([^)]+)\\)`));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function parseEffortLevels(value) {
  const text = normalizeHelpText(value).replace(/\n/g, " ");
  const match = text.match(/--effort [\s\S]{0,500}?\((low,\s*medium,\s*high,\s*xhigh,\s*max)\)/);
  return match ? match[1].split(",").map((entry) => entry.trim()) : [];
}

function normalizeHelpText(value) {
  return stripTerminalControl(String(value || ""))
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function compareSurface(reviewed, detected) {
  const expected = normalizeStringList(reviewed);
  const actual = normalizeStringList(detected);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    reviewed: expected.length,
    detected: actual.length,
    added: actual.filter((item) => !expectedSet.has(item)),
    removed: expected.filter((item) => !actualSet.has(item)),
    matches: expected.length === actual.length
      && actual.every((item, index) => item === expected[index]),
  };
}

function claudeCompatibilityImpact(surfaces) {
  const limitations = [];
  const criticalIssues = [];
  const unreviewedAdditions = [];
  for (const [capabilitySurface, comparison] of Object.entries(surfaces)) {
    const inventory = new Map(
      (COVERAGE_BY_CAPABILITY_SURFACE[capabilitySurface] || [])
        .map((entry) => [entry.method, entry]),
    );
    for (const method of comparison.added) {
      unreviewedAdditions.push({
        capabilitySurface,
        method,
        feature: inventory.get(method)?.surface || inferredClaudeFeature(method),
        reason: "新版新增能力尚未接入，不影响已经验证的现有功能",
      });
    }
    for (const method of comparison.removed) {
      const entry = inventory.get(method);
      if (entry && !["runtime", "internal", "partial"].includes(entry.state)) continue;
      const item = {
        capabilitySurface,
        method,
        feature: entry?.surface || inferredClaudeFeature(method),
        reason: "新版不再提供当前实现依赖的能力",
        severity: CRITICAL_CAPABILITIES.has(`${capabilitySurface}:${method}`)
          ? "blocked"
          : "limited",
      };
      limitations.push(item);
      if (item.severity === "blocked") criticalIssues.push(item);
    }
  }
  return { limitations, criticalIssues, unreviewedAdditions };
}

function inferredClaudeFeature(method) {
  const value = String(method || "");
  if (value.includes("permission") || value.includes("tool")) return "权限与工具";
  if (value.includes("session") || value.includes("resume")) return "对话恢复";
  if (value.includes("stream") || value.includes("content_block")) return "流式输出";
  if (value.includes("task")) return "后台任务";
  if (value.includes("mcp")) return "MCP";
  if (value.includes("plugin")) return "插件";
  if (value.includes("effort")) return "思考强度";
  return "未识别的新能力";
}

function normalizeFixture(value) {
  if (!value || typeof value !== "object" || value.baseline !== CLAUDE_PROTOCOL_BASELINE) {
    throw new Error("Claude capability fixture baseline is inconsistent");
  }
  if (value.version !== baselineVersion()) throw new Error("Claude capability fixture version is inconsistent");
  if (typeof value.helpSemanticSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.helpSemanticSha256)) {
    throw new Error("Claude capability fixture semantic hash is missing");
  }
  if (typeof value.commit !== "string" || !/^[a-f0-9]{7,64}$/.test(value.commit)) {
    throw new Error("Claude capability fixture commit is missing");
  }
  return {
    ...value,
    generatedAt: normalizeIsoTimestamp(value.generatedAt),
    helpOptions: normalizeStringList(value.helpOptions),
    commands: normalizeStringList(value.commands),
    requiredInternalOptions: normalizeStringList(value.requiredInternalOptions),
    permissionModes: normalizeStringList(value.permissionModes),
    effortLevels: normalizeStringList(value.effortLevels),
    topLevelEvents: normalizeStringList(value.topLevelEvents),
    streamEvents: normalizeStringList(value.streamEvents),
    systemEvents: normalizeStringList(value.systemEvents),
    controlRequestSubtypes: normalizeStringList(value.controlRequestSubtypes),
    dialogKinds: normalizeStringList(value.dialogKinds),
  };
}

function normalizeDetectedCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Claude capability surface");
  }
  const version = typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version)
    ? value.version
    : null;
  return {
    version,
    helpSemanticSha256: typeof value.helpSemanticSha256 === "string"
      ? value.helpSemanticSha256
      : "",
    helpOptions: normalizeStringList(value.helpOptions),
    commands: normalizeStringList(value.commands),
    internalOptions: normalizeStringList(value.internalOptions),
    permissionModes: normalizeStringList(value.permissionModes),
    effortLevels: normalizeStringList(value.effortLevels),
    topLevelEvents: normalizeStringList(value.topLevelEvents),
    streamEvents: normalizeStringList(value.streamEvents),
    systemEvents: normalizeStringList(value.systemEvents),
    controlRequestSubtypes: normalizeStringList(value.controlRequestSubtypes),
    dialogKinds: normalizeStringList(value.dialogKinds),
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const entries = value.map((item) => String(item || "").trim()).filter(Boolean);
  return [...new Set(entries)].sort(compareText);
}

function compactCoverage(snapshot) {
  return Object.fromEntries(Object.entries(snapshot)
    .filter(([key]) => key !== "baseline")
    .map(([key, value]) => [key, {
      total: value.total,
      counts: { ...value.counts },
    }]));
}

function deferredCoverageGroups() {
  return implementationCoverageGroups()
    .filter((group) => ["planned", "deferred"].includes(group.category))
    .map((group) => ({
      state: group.category,
      surface: group.surface,
      count: group.count,
      methods: [...group.methods],
      reasons: [...group.reasons],
    }));
}

function implementationCoverageGroups() {
  const groups = new Map();
  for (const section of claudeProtocolCoverageSections()) {
    for (const item of section.entries) {
      const category = implementationCategory(item.state);
      const key = `${category}:${item.surface}`;
      const group = groups.get(key) || {
        category,
        surface: item.surface,
        count: 0,
        methods: [],
        reasons: new Set(),
        evidence: {
          server: new Set(),
          ui: new Set(),
          tests: new Set(),
        },
      };
      group.count += 1;
      group.methods.push(item.method);
      if (item.reason) group.reasons.add(item.reason);
      if (item.highRisk) group.reasons.add("High-risk capability");
      if (item.administratorRequired) group.reasons.add("Administrator review required");
      for (const kind of ["server", "ui", "tests"]) {
        for (const reference of item.evidence?.[kind] || []) group.evidence[kind].add(reference);
      }
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      methods: group.methods.sort(compareText),
      reasons: [...group.reasons],
      evidence: Object.fromEntries(Object.entries(group.evidence)
        .map(([kind, values]) => [kind, [...values].sort(compareText)])),
    }))
    .sort((left, right) => (
      implementationCategoryOrder(left.category) - implementationCategoryOrder(right.category)
      || right.count - left.count
      || left.surface.localeCompare(right.surface, "en")
    ));
}

function implementationCategory(state) {
  if (["runtime", "internal", "custom-equivalent"].includes(state)) return "implemented";
  if (state === "partial") return "partial";
  if (state === "planned") return "planned";
  return "deferred";
}

function implementationCategoryOrder(category) {
  return ({ implemented: 0, partial: 1, planned: 2, deferred: 3 })[category] ?? 4;
}

function sanitizeDoctorStatus(value) {
  if (typeof value !== "string") return null;
  const clean = stripTerminalControl(value).trim();
  if (!clean || clean.length > 160) return null;
  if (/[/?=&]|(?:token|secret|password|cookie|authorization|api[_ -]?key)/i.test(clean)) return "redacted";
  return clean;
}

function boundedToken(value, length) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= length ? clean : null;
}

function stripTerminalControl(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function baselineVersion() {
  const version = CLAUDE_PROTOCOL_BASELINE.match(/^claude-code (\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error("Invalid Claude protocol baseline");
  return version;
}

function normalizeTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1_000 || number > 60_000) {
    throw new Error("Invalid Claude compatibility timeout");
  }
  return Math.round(number);
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Invalid Claude compatibility check time");
  return Math.round(number);
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Claude capability fixture generation time is missing");
  }
  return new Date(value).toISOString();
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}

async function readBaselineFixture(projectDirectory) {
  return JSON.parse(await fs.readFile(
    path.join(projectDirectory, "test", "fixtures", "claude-code-2.1.236-capabilities.json"),
    "utf8",
  ));
}

function run(command, arguments_, { cwd, timeoutMs, allowFailure = false }) {
  if (typeof command !== "string" || !command || command.includes("\0")) {
    return Promise.reject(new Error("Invalid Claude command"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: "1",
        NO_COLOR: "1",
        COLUMNS: "160",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const timeoutError = new Error("Claude compatibility check timed out");
    const finish = (error, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(timeoutError);
      }, 1_000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    });
    child.on("error", (error) => finish(timedOut ? timeoutError : error));
    child.on("close", (code) => {
      if (timedOut) finish(timeoutError, code);
      else if (code === 0 || allowFailure) finish(null, code);
      else finish(new Error(`Claude compatibility command exited with status ${code}`), code);
    });
  });
}

async function probeClaudeProtocol(command, { cwd, timeoutMs }) {
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-compatibility-"));
  try {
    return await new Promise((resolve, reject) => {
      const requestId = `wfl-compat-${crypto.randomUUID()}`;
      const child = spawn(command, [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-prompt-tool", "stdio",
        "--permission-mode", "plan",
        "--bare",
      ], {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDirectory,
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          NO_COLOR: "1",
          COLUMNS: "160",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "";
      let stderrBytes = 0;
      let initialized = false;
      let settled = false;
      let timedOut = false;
      let forceKillTimer = null;
      const timeoutError = new Error("Claude lightweight protocol probe timed out");
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (!child.killed) {
          // Initialization is only a probe. Always terminate the CLI before
          // resolving so quick checks do not leave a live child or zombie
          // process behind when a wrapper exits.
          child.kill("SIGTERM");
          if (error) {
            forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
            forceKillTimer.unref?.();
          }
        }
        if (error) reject(error);
        else resolve({
          initialized: true,
          internalOptions: [...CLAUDE_REQUIRED_INTERNAL_OPTIONS],
        });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(timeoutError);
        }, 1_000);
        forceKillTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer = `${buffer}${chunk}`;
        if (Buffer.byteLength(buffer) > MAX_OUTPUT_BYTES) {
          finish(new Error("Claude lightweight protocol probe returned too much data"));
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line || line.length > MAX_OUTPUT_BYTES) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            event?.type === "control_response"
            && event?.response?.request_id === requestId
            && event?.response?.subtype === "success"
          ) {
            initialized = true;
            return;
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_OUTPUT_BYTES) finish(new Error("Claude lightweight protocol probe failed"));
      });
      child.on("error", (error) => finish(timedOut ? timeoutError : error));
      child.on("close", (code) => {
        if (!settled) {
          if (initialized) finish();
          else finish(timedOut
            ? timeoutError
            : new Error(`Claude lightweight protocol probe exited with status ${code}`));
        }
      });
      child.stdin.end(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "initialize",
          promptSuggestions: true,
          forwardSubagentText: true,
          supportedDialogKinds: ["refusal_fallback_prompt"],
        },
      })}\n`);
    });
  } finally {
    await fs.rm(configDirectory, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 50,
    });
  }
}
