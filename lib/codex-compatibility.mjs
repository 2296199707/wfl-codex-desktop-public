import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCodexInstallation } from "./codex-prerequisite.mjs";
import {
  CODEX_CLIENT_NOTIFICATION_COVERAGE,
  CODEX_PROTOCOL_BASELINE,
  CODEX_PROTOCOL_COVERAGE,
  CODEX_SERVER_NOTIFICATION_COVERAGE,
  CODEX_SERVER_REQUEST_COVERAGE,
  codexClientNotificationCoverageSnapshot,
  codexProtocolCoverageSnapshot,
  codexServerNotificationCoverageSnapshot,
  codexServerRequestCoverageSnapshot,
} from "./codex-protocol-coverage.mjs";
import { codexRuntimeCapabilities } from "./codex-runtime-capabilities.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectDirectory = path.dirname(moduleDirectory);
const SURFACE_FILES = Object.freeze({
  clientRequests: "ClientRequest.ts",
  serverRequests: "ServerRequest.ts",
  clientNotifications: "ClientNotification.ts",
  serverNotifications: "ServerNotification.ts",
});

const COVERAGE_BY_PROTOCOL_SURFACE = Object.freeze({
  clientRequests: CODEX_PROTOCOL_COVERAGE,
  serverRequests: CODEX_SERVER_REQUEST_COVERAGE,
  clientNotifications: CODEX_CLIENT_NOTIFICATION_COVERAGE,
  serverNotifications: CODEX_SERVER_NOTIFICATION_COVERAGE,
});

// These methods are required to start a conversation and converge a running
// turn. Optional feature drift can be exposed to the owner, but losing one of
// these methods must never activate a backend that cannot provide basic chat.
const CRITICAL_PROTOCOL_METHODS = new Set([
  "clientRequests:initialize",
  "clientRequests:thread/list",
  "clientRequests:thread/read",
  "clientRequests:thread/resume",
  "clientRequests:thread/start",
  "clientRequests:turn/interrupt",
  "clientRequests:turn/start",
  "clientNotifications:initialized",
  "serverNotifications:error",
  "serverNotifications:item/agentMessage/delta",
  "serverNotifications:item/completed",
  "serverNotifications:item/started",
  "serverNotifications:thread/started",
  "serverNotifications:turn/completed",
  "serverNotifications:turn/started",
]);

export async function inspectCodexProtocolCompatibility({
  command = process.env.CODEX_DESKTOP_CODEX_BIN || "codex",
  installedVersion = null,
  projectDirectory = defaultProjectDirectory,
  detectedSurface = null,
  timeoutMs = 20_000,
} = {}) {
  const baselineVersion = codexBaselineVersion();
  const version = installedVersion || (await inspectCodexInstallation({ command })).version;
  const fixtureDirectory = path.join(projectDirectory, "test", "fixtures");
  const [reviewedSurface, manifest, detected] = await Promise.all([
    readReviewedSurface(fixtureDirectory, baselineVersion),
    readSchemaManifest(fixtureDirectory, baselineVersion),
    detectedSurface
      ? Promise.resolve(normalizeDetectedSurface(detectedSurface))
      : generateDetectedSurface(command, projectDirectory, timeoutMs),
  ]);
  return buildCodexProtocolCompatibility({
    installedVersion: version,
    reviewedSurface,
    detectedSurface: detected,
    generatedAt: manifest.generatedAt,
    checkedAt: Date.now(),
  });
}

export function buildCodexProtocolCompatibility({
  installedVersion,
  reviewedSurface,
  detectedSurface,
  generatedAt,
  checkedAt = Date.now(),
}) {
  const reviewed = normalizeDetectedSurface(reviewedSurface);
  const detected = normalizeDetectedSurface(detectedSurface);
  const surfaces = Object.fromEntries(Object.keys(SURFACE_FILES).map((name) => {
    const expected = reviewed[name];
    const actual = detected[name];
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    return [name, {
      reviewed: expected.length,
      detected: actual.length,
      added: actual.filter((method) => !expectedSet.has(method)),
      removed: expected.filter((method) => !actualSet.has(method)),
      matches: expected.length === actual.length
        && actual.every((method, index) => method === expected[index]),
    }];
  }));
  const versionReviewed = installedVersion === CODEX_PROTOCOL_BASELINE;
  const protocolReviewed = Object.values(surfaces).every((surface) => surface.matches);
  const compatible = versionReviewed && protocolReviewed;
  const impact = compatibilityImpact(surfaces);
  const activationAllowed = impact.criticalIssues.length === 0;
  const versionRelation = codexVersionRelation(installedVersion);
  const partiallyCompatible = !compatible
    && activationAllowed
    && versionRelation !== "unknown";
  const compatibilityLevel = compatible
    ? "full"
    : partiallyCompatible
      ? "partial"
      : activationAllowed
        ? "unreviewed"
        : "blocked";
  const runtimeCapabilities = codexRuntimeCapabilities({
    version: installedVersion,
    clientRequests: detected.clientRequests,
  });
  return {
    baseline: CODEX_PROTOCOL_BASELINE,
    installedVersion,
    snapshotVersion: codexBaselineVersion(),
    generatedAt: normalizeIsoTimestamp(generatedAt),
    checkedAt: normalizeTimestamp(checkedAt),
    state: compatible ? "compatible" : versionReviewed ? "protocol-drift" : "version-drift",
    compatible,
    partiallyCompatible,
    compatibilityLevel,
    versionRelation,
    versionDirection: versionRelation === "older"
      ? "downward"
      : versionRelation === "newer"
        ? "upward"
        : versionRelation,
    versionReviewed,
    protocolReviewed,
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
    runtimeCapabilities,
    featureLimitations: runtimeFeatureLimitations(runtimeCapabilities),
    surfaces,
    coverage: {
      clientRequests: compactCoverage(codexProtocolCoverageSnapshot()),
      serverRequests: compactCoverage(codexServerRequestCoverageSnapshot()),
      serverNotifications: compactCoverage(codexServerNotificationCoverageSnapshot()),
      clientNotifications: compactCoverage(codexClientNotificationCoverageSnapshot()),
    },
    deferredGroups: deferredCoverageGroups(),
  };
}

function runtimeFeatureLimitations(capabilities) {
  const limitations = [];
  if (!capabilities.conversationSections) {
    limitations.push({
      feature: "conversationSections",
      label: "持久对话分区和分区内排序",
      requiredVersion: "0.147.0",
      fallback: "按更新时间列出对话并保留浏览器本地置顶",
    });
  }
  if (!capabilities.pluginSearch) {
    limitations.push({
      feature: "pluginSearch",
      label: "原生插件统一搜索",
      requiredVersion: "0.147.0",
      fallback: "继续显示和管理已配置插件市场目录",
    });
  }
  return limitations;
}

function codexVersionRelation(installedVersion) {
  const installed = parseCodexVersion(installedVersion);
  const baseline = parseCodexVersion(CODEX_PROTOCOL_BASELINE);
  if (!installed || !baseline) return "unknown";
  if (installed.major !== baseline.major) return installed.major < baseline.major ? "older" : "newer";
  if (installed.minor !== baseline.minor) return installed.minor < baseline.minor ? "older" : "newer";
  if (installed.patch !== baseline.patch) return installed.patch < baseline.patch ? "older" : "newer";
  return "baseline";
}

function parseCodexVersion(value) {
  const match = /(?:^|\s)codex-cli\s+(\d+)\.(\d+)\.(\d+)/iu.exec(String(value || "").trim())
    || /^(\d+)\.(\d+)\.(\d+)/u.exec(String(value || "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function assertCodexActivationAllowed(snapshot) {
  if (snapshot?.activationAllowed === true) return snapshot;
  const detail = (snapshot?.criticalIssues || [])
    .slice(0, 8)
    .map((item) => `${item.feature}: ${item.method}`)
    .join("; ") || "basic conversation protocol is unavailable";
  const error = new Error(`Codex core compatibility check failed: ${detail}`);
  error.code = "ERR_CODEX_CORE_PROTOCOL_DRIFT";
  error.snapshot = snapshot;
  throw error;
}

export async function assertCodexProtocolCompatible(options = {}) {
  const snapshot = await inspectCodexProtocolCompatibility(options);
  if (snapshot.compatible || snapshot.partiallyCompatible) return snapshot;
  const changes = Object.entries(snapshot.surfaces)
    .flatMap(([surface, value]) => [
      ...value.added.map((method) => `${surface} added ${method}`),
      ...value.removed.map((method) => `${surface} removed ${method}`),
    ])
    .slice(0, 12);
  const detail = changes.length
    ? changes.join("; ")
    : `${snapshot.installedVersion} has not been reviewed against ${snapshot.baseline}`;
  const error = new Error(`Codex protocol compatibility check failed: ${detail}`);
  error.code = "ERR_CODEX_PROTOCOL_DRIFT";
  error.snapshot = snapshot;
  throw error;
}

async function readReviewedSurface(fixtureDirectory, version) {
  const prefix = `codex-app-server-${version}`;
  const [client, server, notifications] = await Promise.all([
    readJson(path.join(fixtureDirectory, `${prefix}-client-methods.json`)),
    readJson(path.join(fixtureDirectory, `${prefix}-server-methods.json`)),
    readJson(path.join(fixtureDirectory, `${prefix}-notifications.json`)),
  ]);
  return normalizeDetectedSurface({
    clientRequests: client.methods,
    serverRequests: server.methods,
    clientNotifications: notifications.experimental?.client,
    serverNotifications: notifications.experimental?.server,
  });
}

async function readSchemaManifest(fixtureDirectory, version) {
  const manifest = await readJson(
    path.join(fixtureDirectory, `codex-app-server-${version}-schema-manifest.json`),
  );
  if (manifest.baseline !== CODEX_PROTOCOL_BASELINE) {
    throw new Error("Codex protocol schema manifest baseline is inconsistent");
  }
  return manifest;
}

async function generateDetectedSurface(command, projectDirectory, timeoutMs) {
  if (typeof command !== "string" || !command || command.includes("\0")) {
    throw new Error("Invalid Codex command");
  }
  const duration = Number(timeoutMs);
  if (!Number.isFinite(duration) || duration < 1_000 || duration > 60_000) {
    throw new Error("Invalid Codex protocol check timeout");
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-compatibility-"));
  try {
    await run(command, [
      "app-server",
      "generate-ts",
      "--experimental",
      "--out",
      temporaryDirectory,
    ], {
      cwd: projectDirectory,
      timeoutMs: Math.floor(duration),
    });
    return normalizeDetectedSurface(Object.fromEntries(await Promise.all(
      Object.entries(SURFACE_FILES).map(async ([surface, file]) => [
        surface,
        methodsFromTypeScript(await fs.readFile(path.join(temporaryDirectory, file), "utf8"), file),
      ]),
    )));
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function methodsFromTypeScript(source, name) {
  const methods = [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]);
  if (!methods.length) throw new Error(`${name} contains no protocol methods`);
  return methods;
}

function normalizeDetectedSurface(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex protocol surface");
  }
  return Object.fromEntries(Object.keys(SURFACE_FILES).map((name) => {
    const methods = value[name];
    if (!Array.isArray(methods) || !methods.length) {
      throw new Error(`Codex protocol surface ${name} is missing`);
    }
    if (methods.some((method) => typeof method !== "string" || !method || method.length > 160)) {
      throw new Error(`Codex protocol surface ${name} contains an invalid method`);
    }
    const unique = [...new Set(methods)].sort((left, right) => left.localeCompare(right, "en"));
    if (unique.length !== methods.length) {
      throw new Error(`Codex protocol surface ${name} contains duplicate methods`);
    }
    return [name, unique];
  }));
}

function deferredCoverageGroups() {
  const groups = new Map();
  for (const entry of [
    ...CODEX_PROTOCOL_COVERAGE,
    ...CODEX_SERVER_REQUEST_COVERAGE,
    ...CODEX_SERVER_NOTIFICATION_COVERAGE,
    ...CODEX_CLIENT_NOTIFICATION_COVERAGE,
  ]) {
    if (entry.state !== "deferred") continue;
    const current = groups.get(entry.surface) || {
      surface: entry.surface,
      count: 0,
      methods: [],
      replacements: [],
      reasons: new Set(),
    };
    current.count += 1;
    current.methods.push(entry.method);
    if (entry.replacement) current.replacements.push({
      method: entry.method,
      replacement: entry.replacement,
    });
    if (entry.deprecated) current.reasons.add("上游已弃用");
    else if (entry.highRisk) current.reasons.add("高风险接口，使用受限替代能力");
    else if (entry.experimental) current.reasons.add("上游实验接口，默认关闭");
    else if (entry.legacy) current.reasons.add("旧版兼容接口");
    else current.reasons.add("等待上游稳定或产品排期");
    groups.set(entry.surface, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      methods: group.methods.sort((left, right) => left.localeCompare(right, "en")),
      replacements: group.replacements.sort((left, right) => left.method.localeCompare(right.method, "en")),
      reasons: [...group.reasons],
    }))
    .sort((left, right) => right.count - left.count || left.surface.localeCompare(right.surface, "en"));
}

function compactCoverage(snapshot) {
  return {
    total: snapshot.total,
    counts: { ...snapshot.counts },
  };
}

function compatibilityImpact(surfaces) {
  const limitations = [];
  const criticalIssues = [];
  const unreviewedAdditions = [];
  for (const [protocolSurface, comparison] of Object.entries(surfaces)) {
    const inventory = new Map(
      (COVERAGE_BY_PROTOCOL_SURFACE[protocolSurface] || [])
        .map((entry) => [entry.method, entry]),
    );
    for (const method of comparison.added) {
      unreviewedAdditions.push({
        protocolSurface,
        method,
        feature: inferredFeature(method),
        reason: "新版新增能力尚未接入，不影响已经验证的现有功能",
      });
    }
    for (const method of comparison.removed) {
      const entry = inventory.get(method);
      if (entry && !["browser", "internal"].includes(entry.state)) continue;
      const item = {
        protocolSurface,
        method,
        feature: entry?.surface || inferredFeature(method),
        reason: "新版不再提供当前实现依赖的协议方法",
        severity: CRITICAL_PROTOCOL_METHODS.has(`${protocolSurface}:${method}`)
          ? "blocked"
          : "limited",
      };
      limitations.push(item);
      if (item.severity === "blocked") criticalIssues.push(item);
    }
  }
  return { limitations, criticalIssues, unreviewedAdditions };
}

function inferredFeature(method) {
  const prefix = String(method || "").split("/", 1)[0];
  const names = {
    account: "官方账号",
    app: "Codex Apps",
    command: "集成终端",
    config: "设置",
    environment: "执行环境",
    fs: "项目文件",
    item: "任务内容",
    mcpServer: "MCP",
    model: "模型",
    plugin: "Codex 插件",
    process: "进程控制",
    remoteControl: "远程控制",
    review: "代码审查",
    skills: "Skills",
    thread: "对话",
    turn: "任务执行",
  };
  return names[prefix] || "未识别的新能力";
}

function codexBaselineVersion() {
  const version = CODEX_PROTOCOL_BASELINE.match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error("Invalid Codex protocol baseline");
  return version;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Codex protocol schema manifest generation time is missing");
  }
  return new Date(value).toISOString();
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid compatibility check time");
  return Math.round(timestamp);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function run(command, arguments_, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Codex protocol compatibility check timed out"));
    }, timeoutMs);
    timeout.unref?.();
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Codex protocol generator exited with status ${code}`));
    });
  });
}
