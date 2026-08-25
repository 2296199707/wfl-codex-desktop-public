import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, app, styles, server, quickCheck, runtime, usersHtml, usersApp, multiUserStore] = await Promise.all([
  fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../scripts/quick-update-check.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/claude-runtime.mjs", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/users.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/users.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/multi-user-store.mjs", import.meta.url), "utf8"),
]);

test("Claude settings expose a compatibility and sanitized Doctor management view", () => {
  for (const id of [
    "claudeCompatibilityPanel",
    "claudeCompatibilityState",
    "claudeCompatibilityActual",
    "claudeCompatibilityBaseline",
    "claudeCompatibilityCommit",
    "claudeCompatibilityInstall",
    "claudeCompatibilityChannel",
    "claudeCompatibilityAutoUpdate",
    "claudeCompatibilityChecked",
    "claudeCompatibilityProbe",
    "claudeCompatibilityCounts",
    "claudeCompatibilityDrift",
    "claudeCompatibilityDeferred",
    "claudeCompatibilityRefreshButton",
    "claudeUnlimitedRetryInput",
    "claudeAutocompactInput",
    "claudeRetryFrequencyInput",
    "claudeMaxRetriesInput",
    "claudeTaskSettingsSaveButton",
    "claudePauseButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function renderClaudeCompatibility\(snapshot\)/);
  assert.match(app, /function refreshClaudeCompatibility\(\)/);
  assert.match(app, /运行时强制阻止原生自动更新|原生启用 · 运行时已阻止/);
  assert.match(app, /握手通过/);
  assert.match(app, /\["部分实现", aggregate\.partial/);
  assert.match(app, /\["计划", aggregate\.planned/);
  assert.match(app, /\["主动延期", aggregate\.deferred/);
  assert.match(app, /snapshot\?\.capabilityGroups/);
  assert.match(app, /doctor\.warnings/);
  assert.match(app, /doctor\.fatalIssues/);
  assert.match(app, /CLI 构建提交与审查基线不一致/);
  assert.match(app, /已有 \$\{evidenceCount\} 条代码、界面或测试证据/);
  assert.match(app, /function renderClaudeRecoveryCard\(recovery\)/);
  assert.match(app, /继续未完成任务/);
  assert.match(app, /function saveClaudeTaskSettings\(\)/);
  assert.match(app, /function toggleClaudePause\(\)/);
  assert.match(app, /claude\/turn\/retry-now/);
});

test("Claude compatibility management remains compact on mobile", () => {
  assert.match(styles, /\.claude-compatibility-meta,[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(styles, /@media[\s\S]*\.claude-compatibility-meta,[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(styles, /\.claude-compatibility-drift[\s\S]*overflow: auto/);
  assert.match(styles, /\.claude-compatibility-actions[\s\S]*flex-direction: column/);
  assert.match(styles, /\.claude-recovery-card[\s\S]*max-width/);
  assert.match(styles, /@media[\s\S]*\.claude-recovery-card[\s\S]*max-width: 100%/);
  assert.match(styles, /\.claude-recovery-provider-select/);
});

test("server and bounded update checks gate Claude on the reviewed compatibility snapshot", () => {
  assert.match(server, /app\.get\("\/api\/claude\/compatibility"/);
  assert.match(server, /inspectClaudeCompatibility\(\{/);
  assert.match(server, /claudeCompatibilitySnapshot\(\)/);
  assert.match(quickCheck, /await assertClaudeCompatible\(\{/);
  assert.match(quickCheck, /optional \/ not-installed/);
  assert.match(quickCheck, /scripts", "claude-command"/);
  assert.match(runtime, /DISABLE_AUTOUPDATER: "1"/);
  assert.match(runtime, /claudeReviewedTopLevelEvent/);
  assert.match(runtime, /Claude 已拒绝未审查控制请求/);
  assert.match(server, /"claude\/turn\/recover"/);
  assert.match(server, /"claude\/turn\/pause"/);
  assert.match(server, /"claude\/turn\/retry-now"/);
  assert.match(runtime, /status: "recoveryPending"/);
  assert.match(runtime, /recoveredFromRunId/);
  assert.match(runtime, /classifyClaudeFailure/);
  assert.match(runtime, /retryFrequency/);
  assert.match(runtime, /--autocompact/);
  assert.match(app, /自动压缩窗口/);
});

test("Claude is an optional component gated by the version center", () => {
  for (const id of [
    "claudeComponentPanel",
    "claudeComponentVersion",
    "claudeComponentState",
    "claudeComponentProgress",
    "installClaudeButton",
    "claudeVersionCompatibilityPanel",
    "claudeVersionCompatibilityToggle",
    "claudeVersionCompatibilityDetails",
    "claudeVersionCompatibilityCounts",
    "claudeCompatibilityDecision",
    "keepClaudeUpdateButton",
    "rollbackClaudeUpdateButton",
    "claudeVersionCompatibilityDeferred",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Claude Code（可选）/);
  assert.match(html, /id="installClaudeButton"[\s\S]*检查并升级/);
  assert.match(app, /function claudeComponentReady\(\)/);
  assert.match(app, /function promptClaudeInstall\(/);
  assert.match(app, /function renderClaudeVersionCompatibility\(/);
  assert.match(app, /function loadClaudeVersionCompatibility\(/);
  assert.match(app, /是否前往版本中心下载并安装/);
  assert.match(app, /"X-Codex-Desktop-Action": "claude-component-install"/);
  assert.match(server, /app\.get\("\/api\/claude\/component"/);
  assert.match(server, /app\.post\("\/api\/claude\/component\/install"/);
  assert.match(server, /app\.post\("\/api\/claude\/component\/decision"/);
  assert.match(app, /function decideClaudeUpdate\(decision\)/);
  assert.match(server, /launchClaudeInstallWorker\(\{ decision \}\)/);
  assert.match(server, /launchClaudeInstallWorker\(\{ repair \}\)/);
  assert.match(server, /Claude Code 尚未安装，请前往版本中心安装/);
});

test("Claude capabilities use independent account permissions in the server and mobile management UI", () => {
  for (const permission of [
    "claudeRuntime",
    "claudeOfficialLogin",
    "claudeProviders",
    "claudeExtensions",
    "claudeMcp",
    "claudeHooks",
    "claudeMemory",
    "claudeBackground",
    "claudeWorktree",
    "claudeProxy",
    "claudeStructuredOutput",
    "claudeUltraReview",
    "claudeProjectPurge",
    "claudeBetaHeaders",
  ]) {
    assert.match(server, new RegExp(`"${permission}"`));
    assert.match(multiUserStore, new RegExp(`${permission}:`));
  }
  for (const id of [
    "claudeRuntimePermission",
    "claudeOfficialLoginPermission",
    "claudeProvidersPermission",
    "claudeExtensionsPermission",
    "claudeMcpPermission",
    "claudeHooksPermission",
    "claudeMemoryPermission",
    "claudeBackgroundPermission",
    "claudeWorktreePermission",
    "claudeProxyPermission",
    "claudeStructuredOutputPermission",
    "claudeUltraReviewPermission",
    "claudeProjectPurgePermission",
    "claudeBetaHeadersPermission",
    "defaultClaudeRuntime",
    "defaultClaudeMcp",
    "defaultClaudeStructuredOutput",
    "defaultClaudeUltraReview",
    "defaultClaudeProjectPurge",
    "defaultClaudeBetaHeaders",
    "tierClaudeRuntime",
    "tierClaudeProxy",
    "tierClaudeStructuredOutput",
    "tierClaudeUltraReview",
    "tierClaudeProjectPurge",
    "tierClaudeBetaHeaders",
  ]) {
    assert.match(usersHtml, new RegExp(`id="${id}"`));
    assert.match(usersApp, new RegExp(`elements\\.${id}`));
  }
  assert.match(server, /CLAUDE_RPC_PERMISSIONS/);
  assert.match(server, /claudeHttpPermission\(request\.path\)/);
  assert.match(server, /assertClaudePermissionMode/);
  assert.match(server, /assertClaudeStructuredOutputAccess/);
  assert.match(server, /requireClaudeAccess\(request, "claudeUltraReview"\)/);
  assert.match(server, /requireClaudeAccess\(request, "claudeProjectPurge"\)/);
  assert.match(app, /function canUseClaudeRuntime\(\)/);
  assert.match(app, /item\.hidden = !canUseClaudePermission\("claudeRuntime"\)/);
  assert.match(app, /item\.dataset\.componentState/);
  assert.match(app, /elements\.claudeMcpTab\.hidden = !canUseClaudeMcp\(\)/);
});
