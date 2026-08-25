import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const mobileHtml = await fs.readFile(new URL("../public/mobile-tool.html", import.meta.url), "utf8");
const mobileApp = await fs.readFile(new URL("../public/mobile-tool.js", import.meta.url), "utf8");
const mobileDependencyManager = await fs.readFile(new URL("../lib/mobile-app-dependencies.mjs", import.meta.url), "utf8");
const conversationState = await fs.readFile(new URL("../public/conversation-state.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
const androidBuilder = await fs.readFile(new URL("../lib/android-apk-builder.mjs", import.meta.url), "utf8");
const claudeRuntime = await fs.readFile(new URL("../lib/claude-runtime.mjs", import.meta.url), "utf8");
const feedback = await fs.readFile(new URL("../lib/codex-feedback.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = (await fs.readFile(new URL("../VERSION", import.meta.url), "utf8")).trim();
const assetVersion = app.match(/const UI_VERSION_LABEL = "([^"]+)";/)?.[1] || "";
const mobileVersion = assetVersion.replace(/-beta(?:\..*)?$/i, "β");

test("the document has unique element IDs", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});

test("project and conversation drawer actions share one command-bar control", () => {
  const commandbar = html.match(/<section class="commandbar">[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(
    commandbar,
    /<div class="project-navigation-control">[\s\S]*?id="projectSwitcher"[\s\S]*?id="panelsButton"[\s\S]*?<\/div>/,
  );
  assert.match(commandbar, /id="panelsButton"[^>]*aria-label="打开对话记录"/);
  assert.match(css, /\.project-navigation-control > \.icon-button \{[\s\S]*?border-left: 1px solid var\(--line\);/);
});

test("every element registered by the UI controller exists in the document", () => {
  const registry = app.match(/const elements = Object\.fromEntries\([\s\S]*?\]\.map\(\(id\)/)?.[0];
  assert.ok(registry, "element registry was not found");
  const ids = [...registry.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
});

test("browser assets are local and the page declares a mobile viewport", () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, new RegExp(`src="/i18n\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}"`));
  assert.match(html, /src="\/vendor\/lucide\/lucide\.min\.js(?:\?v=[^"]+)?"/);
  assert.match(html, new RegExp(`src="/boot\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}"`));
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
});

test("mobile App workbench is linked from the toolbox and keeps preview/build controls together", () => {
  assert.match(html, /id="toolboxOpenMobileAppButton"/);
  for (const id of ["mobileConfigForm", "mobileProjectPath", "mobileStorageRoot", "mobileFlutterBin", "scanFlutterButton", "mobileFlutterPathOptions", "mobilePreviewFrame", "flutterDependencyProgress", "prepareFlutterButton", "preparePubButton", "prepareJavaButton", "apkBuildForm"]) {
    assert.match(mobileHtml, new RegExp(`id="${id}"`));
  }
  assert.match(mobileHtml, /预览模式/);
  assert.match(mobileApp, /mobile-app-preview-start/);
  assert.match(mobileApp, /mobile-app-apk-build/);
  assert.match(mobileApp, /\$\("preparePubButton"\)\.disabled = !flutterReady \|\| pubReady \|\| pubBusy/);
  assert.match(mobileApp, /function scheduleDependencyPoll\(\)/);
  assert.match(mobileApp, /flutterDependencyProgress/);
  assert.match(mobileApp, /mobileFlutterBin/);
  assert.match(mobileApp, /flutterPaths/);
  assert.match(mobileDependencyManager, /path\.join\(this\.sourceDirectory, "scripts", "mobile-app-dependencies\.mjs"\)/);
  assert.match(server, /\/api\/tools\/mobile-app\/config/);
  assert.match(server, /MobileAppConfigStore/);
  assert.match(server, /Flutter SDK 正在准备，请等待完成/);
});

test("release version metadata stays synchronized", () => {
  assert.equal(version, packageJson.version);
  assert.ok(
    [version, version.endsWith("-beta") ? version : `${version}-beta`].includes(assetVersion),
    "asset version must be the formal version or its local beta label",
  );
  assert.match(app, new RegExp(`const UI_VERSION = "${version.replaceAll(".", "\\.")}"`));
  assert.match(app, new RegExp(`const UI_VERSION_LABEL = "${assetVersion.replaceAll(".", "\\.")}"`));
  assert.match(app, new RegExp(`from "\\./thread-state\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}"`));
  assert.match(app, new RegExp(`from "\\./image-intent\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}"`));
  assert.match(app, new RegExp(`from "\\./conversation-state\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}"`));
  assert.match(conversationState, /export function createConversationState/);
  assert.match(html, new RegExp(`/styles\\.css\\?v=${assetVersion.replaceAll(".", "\\.")}`));
  assert.match(html, new RegExp(`/i18n\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}`));
  assert.match(html, new RegExp(`/boot\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}`));
  assert.match(html, new RegExp(`data-version="${version.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`data-asset-version="${assetVersion.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`data-mobile-label="${mobileVersion.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`id="currentVersionValue">v${assetVersion.replaceAll(".", "\\.")}`));
  assert.match(mobileHtml, new RegExp(`/mobile-tool\\.css\\?v=${assetVersion.replaceAll(".", "\\.")}`));
  assert.match(mobileHtml, new RegExp(`/mobile-tool\\.js\\?v=${assetVersion.replaceAll(".", "\\.")}`));
});

test("interface language is a browser preference independent from Codex settings", () => {
  assert.match(html, /id="interfaceLanguage"[^>]*data-language-select/);
  assert.match(html, /<option value="zh-CN">简体中文<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.doesNotMatch(app, /interfaceLanguage[\s\S]{0,300}config\/value\/write/);
});

test("permission defaults can be applied through a new branch without implying sandbox hot switching", () => {
  assert.match(html, /id="applySettingsToBranchButton"[^>]*value="apply-branch"/);
  assert.match(html, /运行中的旧会话不能热切换沙箱/);
  assert.match(app, /const applyToBranch = event\.submitter\?\.value === "apply-branch"/);
  assert.match(app, /if \(applyToBranch\) await forkThread\(\)/);
  assert.match(app, /state\.activeThread\.imported[\s\S]{0,200}_wflMaterializationSandbox = state\.config\.sandbox_mode/);
});

test("single-user Codex concurrency is editable and mobile conversation scrolling is touch-safe", () => {
  for (const id of ["codexThreadLimitField", "codexThreadLimitInput", "codexThreadLimitHint"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="codexThreadLimitInput"[^>]*min="1"[^>]*max="16"/);
  assert.match(app, /saveCodexThreadLimitFromSettings/);
  assert.match(app, /codexThreadLimitField\.hidden/);
  assert.match(app, /body: JSON\.stringify\(\{ codexThreadLimit: limit \}\)/);
  assert.match(server, /updateSingleUserCodexThreadLimit/);
  assert.match(server, /codexTaskAdmissions\.capacityChanged\(\)/);
  assert.match(css, /\.message-stage \{[\s\S]*?touch-action: pan-y;[\s\S]*?-webkit-overflow-scrolling: touch;/);
  assert.match(css, /\.project-list,[\s\S]*?\.thread-list \{[\s\S]*?touch-action: pan-y;/);
});

test("Codex MCP uses guarded native configuration and a bounded extension-center UI", () => {
  for (const id of [
    "codexMcpTab",
    "codexMcpPanel",
    "codexMcpList",
    "codexMcpEditor",
    "codexMcpTransportInput",
    "codexMcpInspector",
    "codexMcpResourceInput",
    "codexMcpToolInput",
    "codexMcpToolArgumentsInput",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /\/api\/codex\/mcp\/config/);
  assert.match(app, /codex-mcp-config-save/);
  assert.match(app, /codex-mcp-config-delete/);
  assert.match(app, /mcpServerStatus\/list/);
  assert.match(app, /mcpServer\/resource\/read/);
  assert.match(app, /mcpServer\/tool\/call/);
  assert.match(app, /\/api\/codex\/mcp\/oauth\/start/);
  assert.match(server, /requireCodexMcpAccess\(request\)/);
  assert.match(server, /publicCodexMcpServerConfig/);
  assert.match(server, /result\.authorizationUrl = ""/);
  assert.match(css, /\.codex-mcp-workspace/);
  assert.match(css, /\.codex-mcp-inspector pre/);
  assert.match(css, /\.codex-mcp-form-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test("external Agent migration is permission-gated, snapshot-backed, and mobile-operable", () => {
  for (const id of [
    "codexMigrationTab",
    "codexMigrationPanel",
    "codexMigrationDetectButton",
    "codexMigrationImportButton",
    "codexMigrationItemList",
    "codexMigrationHistoryList",
    "codexMigrationSnapshotList",
    "accountCodexMigrationPermission",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /导入前自动创建只读恢复快照/);
  assert.match(app, /function canUseCodexMigration/);
  assert.match(app, /externalAgentConfig\/detect/);
  assert.match(app, /externalAgentConfig\/import\/readHistories/);
  assert.match(app, /codex-external-migration\/updated/);
  assert.match(server, /\["externalAgentConfig\/detect", "codexMigration"\]/);
  assert.match(server, /CodexExternalMigrationStore/);
  assert.match(server, /externalAgentConfig\/import\/recordHistory/);
  assert.match(css, /\.codex-migration-safety/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.codex-migration-options/);
});

test("native Codex Memories are explicit, account-isolated, and safely reviewable", () => {
  for (const id of [
    "codexMemorySettingsSection",
    "codexMemoryEnabledInput",
    "codexMemoryUseInput",
    "codexMemoryGenerateInput",
    "codexMemoryExternalInput",
    "codexMemoryThreadToggleButton",
    "codexMemoryFileList",
    "codexMemoryPreviewContent",
    "codexMemoryResetDialog",
    "accountCodexMemoryPermission",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /不能覆盖 <code>AGENTS\.md<\/code>/);
  assert.match(html, /清除全部 Codex 记忆/);
  assert.match(app, /function canUseCodexMemory/);
  assert.match(app, /\/api\/codex\/memories\/settings/);
  assert.match(app, /codex-memory-thread-mode/);
  assert.match(app, /codex-memory-reset/);
  assert.match(server, /thread\/memoryMode\/set/);
  assert.match(server, /"memory\/reset", null/);
  assert.match(server, /requireCodexMemoryAccess\(request\)/);
  assert.match(css, /\.codex-memory-mode-grid/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.codex-memory-mode-grid/);
});

test("Codex Terminal is project-bounded, window-scoped, permission-gated, and mobile-operable", () => {
  for (const id of [
    "terminalDrawerButton",
    "terminalDrawer",
    "terminalOutput",
    "terminalInputForm",
    "terminalInput",
    "terminalStopButton",
    "terminalBackgroundList",
    "terminalThreadShellButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-terminal-key="ctrl-c"/);
  assert.match(html, /data-terminal-key="tab"/);
  assert.match(app, /canUseCodexTerminal/);
  assert.match(app, /rpc\("command\/exec"/);
  assert.match(app, /rpc\("command\/exec\/write"/);
  assert.match(app, /rpc\("command\/exec\/terminate"/);
  assert.match(app, /thread\/backgroundTerminals\/list/);
  assert.match(app, /confirm\("该命令将作为当前对话的无沙箱 Shell 命令运行/);
  assert.match(server, /terminalSessions = new Map/);
  assert.match(server, /routeTerminalOutput/);
  assert.match(server, /terminateClientTerminals/);
  assert.match(server, /networkAccess: false/);
  assert.match(server, /\["thread\/shellCommand", "codexTerminal"\]/);
  assert.match(css, /\.terminal-drawer/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.terminal-drawer/);
});

test("Codex background tasks are durable, permission-gated, retry-bounded, and mobile-operable", () => {
  for (const id of [
    "backgroundTaskDrawerButton",
    "backgroundTaskDrawer",
    "backgroundTaskForm",
    "backgroundTaskScheduleKindInput",
    "backgroundTaskInfiniteRetryInput",
    "backgroundTaskRetryBackoffInput",
    "backgroundTaskMaxAttemptsInput",
    "backgroundTaskList",
    "backgroundTaskDetail",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /关闭网页后仍会继续/);
  assert.match(html, /断网、账号\/API 暂时不可用和限流/);
  assert.match(app, /function canUseCodexBackground/);
  assert.match(app, /\/api\/codex\/background-tasks/);
  assert.match(app, /"X-Codex-Desktop-Action": "codex-background-create"/);
  assert.match(app, /"retrySettings"/);
  assert.match(server, /requireCodexBackgroundAccess\(request\)/);
  assert.match(server, /CodexBackgroundTaskStore/);
  assert.match(server, /backgroundTaskErrorIsRetryable/);
  assert.match(server, /clientSubmissionId: `background-thread:\$\{run\.id\}`/);
  assert.match(server, /clientSubmissionId: run\.id,[\s\S]*?method: "turn\/start"/);
  assert.match(server, /broadcastBackgroundTask\("recoveryPending", taskId\)/);
  assert.match(app, /uncertain: "等待权威确认"/);
  assert.match(css, /\.background-task-drawer/);
  assert.match(css, /\.background-task-card\[data-status="uncertain"\]/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.background-task-drawer/);
});

test("the unified task center is privacy-bounded, actionable, and mobile-operable", () => {
  for (const id of [
    "backgroundTaskDrawerButton",
    "backgroundTaskDrawer",
    "backgroundTaskCloseButton",
    "taskCenterOverviewTab",
    "taskCenterSchedulesTab",
    "taskCenterOverviewPanel",
    "taskCenterMetrics",
    "taskCenterList",
    "backgroundTaskBody",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<h2>任务中心<\/h2>/);
  assert.match(html, /aria-label="收起任务中心"/);
  assert.match(app, /\/api\/task\/center/);
  assert.match(app, /function renderTaskCenterOverview/);
  assert.match(app, /function openTaskCenterThread/);
  assert.match(app, /function openTaskCenterClaudeSession/);
  assert.match(app, /function openTaskCenterClaudeBackground/);
  assert.match(app, /rpc\("claude\/turn\/pause", \{ sessionId: row\.sessionId, mode: "after-turn" \}\)/);
  assert.match(app, /rpc\("claude\/turn\/continue", \{ sessionId: row\.sessionId \}\)/);
  assert.match(app, /rpc\("claude\/turn\/interrupt", \{ sessionId: row\.sessionId \}\)/);
  assert.doesNotMatch(app, /任务中心当前显示 Codex 任务/);
  assert.match(app, /updateGoalControl\("pause", "after-turn", row\.threadId\)/);
  assert.match(app, /rpc\("turn\/interrupt", \{ threadId: row\.threadId, turnId: row\.turnId \}\)/);
  assert.doesNotMatch(
    app.match(/function normalizeTaskCenterRow[\s\S]*?\n\}/)?.[0] || "",
    /thread\?\.preview/,
  );
  assert.match(server, /app\.get\("\/api\/task\/center"/);
  assert.match(server, /function publicTaskCenterGoal/);
  assert.match(server, /function publicTaskCenterBackgroundTask/);
  assert.match(server, /function publicTaskCenterClaudeSession/);
  assert.match(server, /function publicTaskCenterClaudeBackgroundTask/);
  assert.doesNotMatch(
    server.match(/function publicTaskCenterGoal[\s\S]*?\n\}/)?.[0] || "",
    /objective/,
  );
  assert.doesNotMatch(
    server.match(/function publicTaskCenterBackgroundTask[\s\S]*?\n\}/)?.[0] || "",
    /prompt/,
  );
  assert.doesNotMatch(
    server.match(/function publicTaskCenterClaudeSession[\s\S]*?\n\}/)?.[0] || "",
    /preview|messages/,
  );
  assert.doesNotMatch(
    server.match(/function publicTaskCenterClaudeBackgroundTask[\s\S]*?\n\}/)?.[0] || "",
    /prompt|detail|needs|transcript/,
  );
  assert.match(css, /\.task-center-overview/);
  assert.match(css, /\.task-center-card-actions/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.task-center-metrics/);
});

test("Goal termination reports cleanup only after native Turn and Goal confirmation", () => {
  const mainInterrupt = app.match(/async function interruptTurn\(\)[\s\S]*?\n\}\n\nasync function toggleClaudePause/)?.[0] || "";
  const centerInterrupt = app.match(/async function terminateTaskCenterTurn\(row\)[\s\S]*?\n\}\n\nfunction scheduleTaskCenterInterruptRefresh/)?.[0] || "";
  assert.match(mainInterrupt, /result\?\.confirmedInactive/);
  assert.match(mainInterrupt, /result\.nativeVerified === true/);
  assert.match(mainInterrupt, /result\.goalPauseConfirmed === true/);
  assert.match(mainInterrupt, /returnedTaskIsInactive/);
  assert.match(mainInterrupt, /result\.goalPauseConfirmed === false/);
  assert.match(centerInterrupt, /result\?\.confirmedInactive/);
  assert.match(centerInterrupt, /result\?\.nativeVerified === true/);
  assert.match(centerInterrupt, /result\?\.goalPauseConfirmed === true/);
  assert.match(centerInterrupt, /returnedTaskIsInactive/);
  assert.match(server, /CODEX_CONFIRMED_INACTIVE_GOAL_STATUSES/);
  assert.match(server, /retryGoalPauseAfterInterrupt/);
  assert.match(server, /nativeThreadIdForPublic\(publicThreadId\)/);
});

test("Claude reconnects from ordered server snapshots without replaying an uncertain turn", () => {
  assert.match(app, /claudeSessionCache: new Map\(\)/);
  assert.match(app, /claudeSessionLoadVersion/);
  assert.match(app, /function observeClaudeRuntimeSnapshot/);
  assert.match(app, /function cacheClaudeSession/);
  assert.match(app, /loadVersion !== state\.claudeSessionLoadVersion \|\| threadListProject\(\)\?\.path !== cwd/);
  assert.match(app, /pendingClaudeTurnRequest/);
  assert.match(app, /function reconcilePendingClaudeTurnRequest/);
  assert.match(app, /clientMessageId: pending\.clientMessageId/);
  assert.match(app, /error\.deliveryUnknown/);
  assert.match(app, /state\.claudeActiveEventSequence/);
  assert.match(server, /runtime\.claudeRuntime\.sessionSnapshot/);
  assert.match(server, /runtime\.claudeRuntime\.readSessionSnapshot/);
  assert.match(claudeRuntime, /runtimeEpoch: this\.runtimeEpoch/);
  assert.match(claudeRuntime, /eventSequence: \+\+this\.eventSequence/);
  assert.match(claudeRuntime, /queueChildEvent/);
  assert.match(claudeRuntime, /queueChildExit/);
  assert.match(claudeRuntime, /scopedControlRequestId/);
});

test("Claude official quota uses native rate-limit events and never invents unavailable limits", () => {
  assert.match(app, /function claudeOfficialQuotaSummary/);
  assert.match(app, /官方暂未提供额度/);
  assert.match(app, /five_hour: "5 小时"/);
  assert.match(app, /"official\/quota-updated"/);
  assert.match(app, /"official\/account-deleted"/);
  assert.match(claudeRuntime, /event\.type === "rate_limit_event"/);
  assert.match(claudeRuntime, /recordOfficialRateLimitEvent/);
  assert.match(claudeRuntime, /rate_limit_info/);
});

test("Claude official account deletion previews bindings and requires server confirmation", () => {
  assert.match(app, /async function deleteClaudeOfficialAccount/);
  assert.match(app, /delete-preview/);
  assert.match(app, /claude-official-account-delete/);
  assert.match(app, /彻底删除 Claude 官方账号/);
  assert.match(server, /officialAccountDeletePreview/);
  assert.match(server, /request\.body\.confirmation !== "彻底删除 Claude 官方账号"/);
  assert.match(claudeRuntime, /async deleteOfficialAccount/);
  assert.match(claudeRuntime, /仍有 Claude 会话绑定此账号/);
});

test("Claude account proxy health stays low-frequency and shows exit IP or failure time", () => {
  assert.match(app, /function claudeOfficialProxyHealthSummary/);
  assert.match(app, /代理可用/);
  assert.match(app, /代理异常/);
  assert.match(app, /"official\/proxy-health-updated"/);
  assert.match(claudeRuntime, /DEFAULT_OFFICIAL_PROXY_HEALTH_INTERVAL_MS = 10 \* 60_000/);
  assert.match(claudeRuntime, /async refreshOfficialProxyHealth/);
  assert.match(claudeRuntime, /officialProxyHealthRunning/);
  assert.match(claudeRuntime, /this\.scheduleOfficialProxyHealth\(\)/);
});

test("Claude API providers use stable aliases and server-side secret-safe model discovery", () => {
  assert.match(html, /id="claudeProviderModelInput"[^>]+list="claudeProviderModelOptions"[^>]+value="sonnet"/);
  assert.match(html, /id="claudeProviderProbeButton"/);
  assert.match(app, /async function probeClaudeProviderConnection/);
  assert.match(app, /"X-Codex-Desktop-Action": "claude-provider-probe"/);
  assert.match(app, /state\.claudeProviderModelCatalogs/);
  assert.match(server, /app\.post\("\/api\/claude\/providers\/probe"/);
  assert.match(server, /requireClaudeAccess\(request, "claudeProviders"\)/);
  assert.doesNotMatch(app, /current\.model \|\| "claude-sonnet-4-5"/);
});

test("Claude native launch isolation is explicit, bounded, and applies only to new processes", () => {
  for (const id of [
    "claudeSystemPromptInput",
    "claudeExcludeDynamicPromptInput",
    "claudeSettingSourceUserInput",
    "claudeSettingSourceProjectInput",
    "claudeSettingSourceLocalInput",
    "claudeSafeModeInput",
    "claudeStrictMcpInput",
    "claudeMcpWhitelistList",
    "claudeNoPersistenceInput",
    "claudeJsonSchemaInput",
    "claudeInlineAgentsList",
    "claudeBriefInput",
    "claudeRemoteFilesInput",
    "claudeFromPrInput",
    "claudePluginDirectoriesInput",
    "claudePluginUrlsInput",
    "claudeBetaHeadersInput",
    "claudeMcpLogoutButton",
    "claudeMcpResetProjectButton",
    "claudePluginValidatePathInput",
    "claudePluginPrunePreviewButton",
    "claudePluginLifecycleOutput",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /仅对下次启动的 Claude 进程生效/);
  assert.match(app, /function updateClaudeLaunchDraftAvailability/);
  assert.match(app, /function persistClaudeLaunchSettings/);
  assert.match(app, /临时对话后，服务退出或原生进程结束将无法恢复/);
  assert.match(app, /function renderClaudeResult/);
  assert.match(app, /item\.structuredOutput/);
  assert.match(claudeRuntime, /args\.push\("--system-prompt", session\.systemPrompt\)/);
  assert.match(claudeRuntime, /args\.push\("--safe-mode"\)/);
  assert.match(claudeRuntime, /args\.push\("--no-session-persistence"\)/);
  assert.match(claudeRuntime, /args\.push\("--agents", await this\.inlineAgentsJson/);
  assert.match(claudeRuntime, /args\.push\("--brief"\)/);
  assert.match(claudeRuntime, /args\.push\("--autocompact", String\(session\.autocompact\)\)/);
  assert.match(claudeRuntime, /args\.push\("--file", \.\.\.session\.remoteFiles\.map\(remoteFileSpec\)\)/);
  assert.match(claudeRuntime, /args\.push\("--from-pr", session\.fromPr\)/);
  assert.match(claudeRuntime, /args\.push\("--plugin-dir", pluginPath\)/);
  assert.match(claudeRuntime, /args\.push\("--betas", \.\.\.session\.betaHeaders\)/);
  assert.match(server, /assertClaudeSessionPluginAccess/);
  assert.match(server, /assertClaudeBetaHeaderAccess/);
  assert.match(server, /claude-plugin-validate/);
  assert.match(server, /claude-mcp-reset-project-choices/);
  assert.match(claudeRuntime, /"--strict-mcp-config"/);
  assert.match(claudeRuntime, /sessions: \[\.\.\.this\.sessions\.values\(\)\]\.filter\(\(session\) => !session\.noSessionPersistence\)/);
  assert.match(server, /assertClaudeMcpSessionConfigAccess/);
});

test("Codex Apps follow upstream feature gates while plugins use the isolated CLI marketplace adapter", () => {
  for (const id of [
    "codexAppsTab",
    "codexAppsPanel",
    "codexInstalledAppsList",
    "codexCatalogAppsList",
    "codexAppsLoadMoreButton",
    "codexAppEditor",
    "codexAppEnabledInput",
    "codexAppDestructiveInput",
    "codexAppOpenWorldInput",
    "codexAppReviewerInput",
    "codexAppApprovalInput",
    "officialBrowserCompleteButton",
    "codexPluginsTab",
    "codexPluginsPanel",
    "codexPluginGateStatus",
    "codexPluginRefreshButton",
    "codexPluginMarketplaceAdmin",
    "codexPluginMarketplaceForm",
    "codexPluginMarketplaceSourceInput",
    "codexPluginMarketplaceRefInput",
    "codexPluginMarketplaceSparseInput",
    "codexPluginMarketplaceList",
    "codexPluginSearchInput",
    "codexPluginInstalledList",
    "codexPluginCatalogList",
    "codexFeatureFlagList",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /experimentalFeature\/list/);
  assert.match(app, /app\/installed/);
  assert.match(app, /app\/list/);
  assert.match(app, /app\/read/);
  assert.match(app, /\/api\/codex\/apps\/install\/start/);
  assert.match(app, /\/api\/codex\/apps\/install\/complete/);
  assert.match(app, /path: `app:\/\/\$\{app\.id\}`/);
  assert.match(app, /selectedCodexApps/);
  assert.match(server, /item\.path\.startsWith\("app:\/\/"\)/);
  assert.match(server, /assertCodexAppsFeatureStable/);
  assert.doesNotMatch(
    app.match(/async function startCodexAppInstall[\s\S]*?\n\}/)?.[0] || "",
    /installUrl/,
  );
  assert.match(app, /\/api\/codex\/plugins/);
  assert.match(app, /rpc\("plugin\/search"/);
  assert.match(app, /\/api\/codex\/native-plugins\/install/);
  assert.match(app, /\/api\/codex\/native-plugins\/uninstall/);
  assert.match(app, /nativeInstalled/);
  assert.match(app, /openai-curated/);
  assert.match(app, /来源：\$\{official \? "OpenAI 官方目录" : "管理员配置的第三方市场"\}/);
  assert.match(app, /\/api\/codex\/plugin-marketplaces/);
  assert.match(app, /第三方插件可包含 Skills、MCP、Hooks 与可执行资源/);
  assert.match(app, /运行工具时仍受当前沙箱、审批策略及外部服务权限约束/);
  assert.match(server, /requireAdmin\(request\)[\s\S]*?addCodexPluginMarketplace/);
  assert.match(server, /verifiedNativeCodexPlugin/);
  assert.match(server, /sanitizeNativeCodexInstalledCatalog/);
  assert.match(server, /\["app\/list", "codexApps"\]/);
  assert.doesNotMatch(
    server.match(/const RPC_ALLOWLIST = new Set\(\[[\s\S]*?\]\);/)?.[0] || "",
    /"plugin\/install"/,
  );
  assert.match(css, /\.codex-feature-flags/);
  assert.match(css, /\.codex-plugin-gate/);
  assert.match(css, /\.codex-plugin-card/);
});

test("Codex 0.147 conversation sections, auto approval, and optional MCP state are explicit", () => {
  assert.match(app, /rpc\("threadSection\/list"/);
  assert.match(app, /rpc\("thread\/section\/move"/);
  assert.match(app, /params\.sectionId = sectionId/);
  assert.match(app, /params\.sortKey = "section_position"/);
  assert.match(app, /sortKey: "updated_at"/);
  assert.match(app, /isCodexSectionPositionFilterError/);
  assert.match(app, /sectionIds: null/);
  assert.match(app, /codexRuntimeFeatureAvailable\("conversationSections"\)/);
  assert.match(app, /codexRuntimeFeatureAvailable\("pluginSearch"\)/);
  assert.match(app, /reorderThreadInSection/);
  assert.match(app, /Codex 0\.147 使用持久分区顺序/);
  assert.match(html, /自动代审（--approve-for-me）/);
  assert.match(app, /官方 --approve-for-me 必须使用“工作区写入”权限/);
  assert.match(app, /\/api\/codex\/mcp\/protocol-2026/);
  assert.match(app, /persistedEnabled/);
  assert.match(app, /runtimeEnabled/);
  assert.match(server, /features\.mcp_2026_07_28/);
  assert.match(server, /new-app-server-and-tasks/);
});

test("Claude extensions and new-conversation workspaces expose bounded native controls", () => {
  for (const id of [
    "claudeExtensionsTab",
    "claudeSkillsPanel",
    "claudeAgentsPanel",
    "claudePluginsPanel",
    "claudeSkillForm",
    "claudeAgentForm",
    "claudePluginMarketList",
    "claudePluginSearchInput",
    "claudePluginRefreshButton",
    "claudePluginMarketplaceForm",
    "claudePluginMarketplaceSourceInput",
    "claudePluginMarketplaceList",
    "claudeMemoryStatus",
    "claudeMemoryInput",
    "claudeMemoryError",
    "claudeMemoryClearButton",
    "claudeMemorySaveButton",
    "claudeHooksTab",
    "claudeHooksPanel",
    "claudeHooksStatus",
    "claudeHooksList",
    "claudeHooksForm",
    "claudeHookEventInput",
    "claudeHookMatcherInput",
    "claudeHookCommandInput",
    "claudeHookTimeoutInput",
    "claudeHookError",
    "claudeHooksClearButton",
    "claudeHookSaveButton",
    "claudePluginForm",
    "claudeWorkspaceButton",
    "claudeWorktreeInput",
    "claudeAdditionalDirectoriesInput",
    "claudeExecutionButton",
    "claudeExecutionView",
    "claudeFallbackModelInput",
    "claudeMaxBudgetInput",
    "claudeAllowedToolsInput",
    "claudeDisallowedToolsInput",
    "claudeAgentInput",
    "claudeExecutionSaveButton",
    "claudeBackgroundTab",
    "claudeBackgroundPanel",
    "claudeBackgroundRefreshButton",
    "claudeBackgroundList",
    "claudeBackgroundForm",
    "claudeBackgroundNameInput",
    "claudeBackgroundPermissionInput",
    "claudeBackgroundPromptInput",
    "claudeBackgroundError",
    "claudeBackgroundStatus",
    "claudeBackgroundStartButton",
    "claudeCommandButton",
    "claudeCommandMenu",
    "claudeCommandStatus",
    "claudeCommandList",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /fetchWithTimeout\(`?\/api\/claude\/extensions/);
  assert.match(app, /pluginMarket/);
  assert.match(app, /\/api\/claude\/memory/);
  assert.match(app, /claude-memory-save/);
  assert.match(app, /claude-memory-clear/);
  assert.match(app, /\/api\/claude\/hooks/);
  assert.match(app, /claude-hooks-save/);
  assert.match(app, /claude-hooks-clear/);
  assert.match(html, /命令会以当前工程目录和账号权限执行/);
  assert.match(html, /class="claude-hook-command-input" id="claudeHookCommandInput"/);
  assert.match(css, /\.claude-memory-section textarea/);
  assert.match(css, /\.claude-hooks-list/);
  assert.match(app, /item\.subtype\.startsWith\("hook_"\)/);
  assert.match(app, /服务器隔离浏览器|声明的权限/);
  for (const action of [
    "claude-skill-create",
    "claude-skill-update",
    "claude-skill-delete",
    "claude-agent-create",
    "claude-agent-update",
    "claude-agent-delete",
    "claude-plugin-install",
    "claude-plugin-enabled",
    "claude-plugin-delete",
  ]) assert.match(app, new RegExp(`X-Codex-Desktop-Action[^\\n]+${action}`));
  for (const action of [
    "claude-plugin-marketplace-add",
    "claude-plugin-marketplace-update",
    "claude-plugin-marketplace-remove",
  ]) assert.match(app, new RegExp(action));
  assert.match(app, /workspaceMode: state\.selectedClaudeWorkspaceMode/);
  assert.match(app, /additionalDirectories: parseClaudeAdditionalDirectories/);
  assert.match(app, /fallbackModel: params\.fallbackModel|fallbackModel: session\.fallbackModel/);
  assert.match(app, /claude\/session\/configure/);
  assert.match(app, /maxBudgetUsd/);
  assert.match(app, /\/api\/claude\/background-agents/);
  assert.match(app, /claude-background-start/);
  assert.match(app, /claude-background-stop/);
  assert.match(app, /startClaudeBackgroundPolling/);
  assert.match(app, /function renderClaudeAgentTask/);
  assert.match(app, /function refreshClaudeElapsedTimes/);
  assert.match(app, /\["thinking", "tool"\]\.includes\(payload\.item\.type\)/);
  assert.match(app, /\/api\/claude\/commands/);
  assert.match(app, /function handleClaudeCommandKeydown/);
  assert.match(server, /app\.get\("\/api\/claude\/commands"/);
  assert.match(server, /runtime\.claudeRuntime\.commandSnapshot\(\{/);
  assert.match(server, /includeSkills: canUseClaudePermission\(request, "claudeExtensions"\)/);
  assert.match(app, /async function applyClaudeBuiltinCommand/);
  assert.match(app, /command\.action === "doctor"/);
  assert.match(app, /command\.action === "permissions"/);
  assert.match(app, /command\.action === "context"/);
  assert.match(css, /\.claude-command-menu/);
  assert.match(html, /仅对下次启动的 Claude 进程生效；运行中的任务不会热切换/);
  assert.match(html, /后台任务由 Claude 原生守护进程托管/);
  assert.match(app, /额外目录最多设置 8 个/);
  assert.match(css, /\.claude-extension-layout \{[\s\S]*?grid-template-columns: minmax\(190px, 0\.7fr\) minmax\(0, 1\.8fr\)/);
  assert.match(css, /\.claude-background-list \{[\s\S]*?overflow-y: auto/);
  assert.match(css, /\.claude-background-transcript \{[\s\S]*?overflow: auto/);
  assert.match(css, /\.claude-agent-activity/);
  assert.match(css, /\.provider-claude-workspace > \.claude-body \{[\s\S]*?overscroll-behavior: contain;[\s\S]*?touch-action: pan-y;/);
  assert.match(css, /\.claude-extension-layout \{ grid-template-columns: 1fr; gap: 12px; \}/);
});

test("Claude background agents use guarded project-scoped server routes", () => {
  assert.match(server, /app\.get\("\/api\/claude\/background-agents"/);
  assert.match(server, /app\.post\("\/api\/claude\/background-agents"/);
  assert.match(server, /app\.get\("\/api\/claude\/background-agents\/:id"/);
  assert.match(server, /app\.post\("\/api\/claude\/background-agents\/:id\/stop"/);
  assert.match(server, /assertOperationRequest\(request, "claude-background-start"\)/);
  assert.match(server, /assertOperationRequest\(request, "claude-background-stop"\)/);
  assert.match(server, /validateClaudeBackgroundCwd\(request\.body\?\.cwd, runtime\)/);
  assert.match(server, /assertSafeProjectDirectory\(requested, runtime\)/);
  assert.match(server, /runtime\.withTaskAdmission[\s\S]{0,240}assertQuotaAvailable\(runtime\)[\s\S]{0,240}startBackgroundAgent/);
});

test("Claude Rewind previews checkpoints and confirms code restoration without rewriting chat history", () => {
  for (const id of [
    "claudeRewindButton",
    "claudeRewindDialog",
    "claudeRewindTargetSelect",
    "claudeRewindPreview",
    "claudeRewindPreviewButton",
    "claudeRewindRestoreButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /回退只恢复代码文件，不删除当前聊天记录/);
  assert.match(app, /rpc\("claude\/session\/rewind"/);
  assert.match(app, /dryRun: true/);
  assert.match(app, /dryRun: false/);
  assert.match(app, /confirm: true/);
  assert.match(app, /预计覆盖 \$\{files\} 个文件，聊天记录会保留/);
  assert.match(server, /"claude\/session\/rewind"/);
  assert.match(server, /runtime\.claudeRuntime\.rewindFiles/);
  assert.match(css, /\.claude-rewind-preview/);
});

test("version upgrades require an explicit confirmation from the version center", () => {
  assert.match(app, /versionButton\.addEventListener\("click", openVersionDialog\)/);
  assert.match(app, /confirmUpgradeButton\.addEventListener\("click", confirmUpgrade\)/);
  assert.match(html, /id="versionNotesButton"/);
  assert.match(html, /id="confirmUpgradeButton"[^>]*disabled/);
});

test("the operations center is restricted to administrators and links back to real panels", async () => {
  assert.match(html, /id="opsButton" href="\/ops"[^>]*hidden/);
  assert.match(html, /id="opsButton"[\s\S]*?管理员运维中心/);
  assert.match(app, /elements\.opsButton\.hidden = !admin/);
  assert.match(app, /handleEntryHash\(\)/);
  assert.match(app, /entry === "version"\) openVersionDialog\(\)/);
  assert.match(app, /entry === "settings"/);
});

test("signed-in users can read release notes while announcement publishing stays administrative", () => {
  for (const id of [
    "accountVersionButton",
    "accountAnnouncementButton",
    "announcementDialog",
    "announcementPublished",
    "announcementEditor",
    "saveAnnouncementDraftButton",
    "publishAnnouncementButton",
    "unpublishAnnouncementButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /fetchWithTimeout\(`\/api\/version\?_=/);
  assert.match(app, /elements\.versionButton\.hidden = false/);
  assert.match(app, /codexUpdatePanel\.hidden = !admin/);
  assert.match(app, /"X-Codex-Desktop-Action": action/);
  assert.match(app, /announcement-draft-save/);
  assert.match(app, /announcement-publish/);
  assert.match(app, /announcement-unpublish/);
  assert.match(app, /codexDesktop\.announcementSeen/);
  assert.match(app, /function scheduleUnreadAnnouncement\(\)/);
  assert.match(app, /function openUnreadAnnouncement\(\)/);
  assert.match(app, /document\.querySelector\("dialog\[open\]"\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*announcement(?:Title|Body|Draft)/i);
});

test("the version center uses one synchronized update path and monitors its durable release", () => {
  assert.match(html, /id="sourceVersionValue"/);
  assert.match(css, /\.version-modal form\s*\{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.match(css, /\.version-modal \.modal-body\s*\{[\s\S]*min-height: 0/);
  assert.match(html, /id="releaseProgress"[^>]*role="status"/);
  assert.match(html, /data-release-progress-icon/);
  assert.match(app, /fetchWithTimeout\(`\/api\/release\/status\?_=/);
  assert.doesNotMatch(html, /id="startReleaseButton"/);
  assert.doesNotMatch(app, /\/api\/release\/start/);
  assert.doesNotMatch(html, /一键部署/);
  assert.match(app, /setInterval\(\(\) => \{[\s\S]*versionDialog\.open[\s\S]*\}, 1_000\)/);
  assert.match(app, /function failedUpdateIsCurrent\(appUpdate, release\)/);
  assert.match(app, /updateTime >= releaseTime/);
  assert.match(app, /failedUpdateIsCurrent\(release\.appUpdate, release\.release\)/);
  assert.match(app, /const iconName = running \? "loader-circle" : status === "completed" \? "circle-check" : "circle-alert"/);
  assert.match(app, /elements\.releaseProgressTime\.textContent = `已结束\$\{duration\}`/);
  assert.match(app, /testing: "运行完整测试和浏览器检查"/);
  assert.match(app, /deploying: "验证候选服务并执行蓝绿切换"/);
});

test("the version center can securely synchronize a remote stable release", () => {
  assert.match(html, /id="remoteVersionValue"/);
  assert.match(html, /id="syncReleaseButton"[^>]*disabled/);
  assert.match(app, /syncReleaseButton\.addEventListener\("click", startAppUpdate\)/);
  assert.match(app, /fetch\("\/api\/app\/update\/start"/);
  assert.match(app, /"X-Codex-Desktop-Action": "app-update"/);
  assert.match(app, /重新验证并完成更新/);
  assert.match(app, /preparing: "在隔离目录安装锁定依赖"/);
  assert.match(app, /waiting: "等待安全切换窗口，对话服务保持开放"/);
  assert.match(app, /draining: "已确认任务空闲，正在短时切换"/);
});

test("the primary version center separates candidate preparation, promotion, and discard", () => {
  for (const id of [
    "releaseCandidatePanel",
    "startReleaseCandidateButton",
    "promoteReleaseCandidateButton",
    "discardReleaseCandidateButton",
    "releaseCandidateConfirmDialog",
    "releaseCandidateValidationInput",
    "releaseCandidatePasswordInput",
    "releaseCandidateConfirmationInput",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /请手动输入上方完整候选编号/);
  assert.match(app, /release\.candidates\?\.current/);
  assert.match(app, /"X-Codex-Desktop-Action": "release-candidate-start"/);
  assert.match(app, /"release-candidate-promote"/);
  assert.match(app, /"release-candidate-discard"/);
  assert.match(app, /\["awaiting-approval", "discarding", "failed"\]/);
  assert.match(app, /discarding: "正在恢复旧版本"/);
  assert.match(app, /actualValidationConfirmed: promote/);
  assert.match(app, /通常需要 10–20 分钟/);
});

test("the version center can securely start and monitor an official Codex update", () => {
  assert.match(html, /id="codexVersionValue"/);
  assert.match(html, /id="codexUpdateProgress"[^>]*role="status"/);
  assert.match(html, /id="updateCodexButton"[^>]*disabled/);
  assert.match(app, /updateCodexButton\.addEventListener\("click", startCodexUpdate\)/);
  assert.match(app, /fetch\("\/api\/codex\/update\/start"/);
  assert.match(app, /"X-Codex-Desktop-Action": "codex-update"/);
  assert.match(app, /deploying: "在备用后端验证新版 Codex"/);
  assert.match(app, /更新不会等待运行中的对话/);
});

test("API provider controls are wired and never prefill a stored secret", () => {
  assert.match(app, /accountProviderButton\.addEventListener\("click"/);
  assert.match(html, /id="providerQuickButton"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="providerQuickMenu"[^>]*role="menu"/);
  assert.match(html, /id="providerQuickSelect"[^>]*aria-hidden="true"/);
  assert.match(html, /id="providerQuickRefreshButton"/);
  assert.match(html, /刷新额度/);
  assert.doesNotMatch(html, /id="providerButton"/);
  assert.match(app, /providerQuickButton\.addEventListener\("click", toggleProviderQuickMenu\)/);
  assert.match(app, /任务执行中只读/);
  assert.match(app, /loadAccountOfficialQuota\(\{[\s\S]*?refresh: force && !conversationBusy\(\)/);
  assert.match(app, /loadProviderUsage\(\{ force \}\)/);
  assert.match(app, /\/api\/providers\/usage/);
  assert.match(app, /providerUsageRequestAccountId/);
  assert.match(app, /providerUsageGeneration/);
  assert.match(app, /function resetProviderUsageState\(accountId = null\)/);
  assert.match(app, /Never let that response populate the next account's provider panel/);
  assert.match(app, /providerUsageForTarget/);
  assert.match(app, /function providerQuickCompactLabel\(entry, fallback\)/);
  assert.match(app, /function providerQuickUsageText\(entry\)/);
  assert.match(app, /if \(balance\) return formatProviderBalance\(balance\)/);
  assert.match(app, /window\.label === "5 小时"/);
  assert.match(app, /formatProviderBalance/);
  assert.match(app, /providerQuickEntries\(\)/);
  assert.match(app, /function renderThreadProviderBinding\(\)/);
  assert.match(app, /providerUsage = binding\.kind === "managed"/);
  assert.match(app, /badgeIdentity\.textContent = identity/);
  assert.match(app, /thread-provider-identity/);
  assert.match(app, /thread-provider-usage/);
  assert.match(app, /renderThreadProviderBinding\(\);/);
  assert.match(css, /\.provider-quick-menu \{/);
  assert.match(css, /\.provider-quick-balance \{/);
  assert.match(css, /\.provider-quick-refresh \{/);
  assert.match(css, /\.provider-quick-row:disabled \{[\s\S]*?opacity: 1;/);
  assert.match(css, /\.thread-provider-badge \{[\s\S]*?display: inline-flex;/);
  assert.match(css, /\.thread-provider-usage \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(app, /queryProviderModels\(catalogId, "auto", \{ announce: false \}\)/);
  assert.match(app, /providerForm\.addEventListener\("submit"/);
  assert.match(app, /activateDefaultProviderButton\.addEventListener\("click", \(\) => activateDefaultProvider\(\)\)/);
  assert.match(html, /id="providerApiKeyInput" type="password"[^>]*autocomplete="new-password"/);
  assert.doesNotMatch(html, /id="providerApiKeyInput"[^>]*\svalue=/);
  assert.doesNotMatch(app, /providerApiKeyInput\.value\s*=\s*profile\./);
  assert.match(app, /saveProviderButton\.hidden = !canEdit \|\| profile\.id === state\.activeProviderId/);
  assert.match(app, /保存并重新启用/);
  assert.match(html, /id="editCurrentProviderButton"[^>]*hidden/);
  assert.match(app, /editCurrentProviderButton\.addEventListener\("click", editCurrentProviderConfiguration\)/);
  assert.match(app, /current\.editableProfileId/);
  assert.match(app, /现有密钥不可读取，请重新输入 API Key/);
  assert.match(html, /初始模型 <small>可选<\/small>/);
  assert.match(html, /id="providerModelInput"(?![^>]*required)[^>]*placeholder="留空后在主页选择"/);
  assert.match(html, /id="providerModelInput"[^>]*list="providerModelOptions"/);
  assert.match(html, /id="providerModelsRefreshButton"[^>]*title="查询供应商模型"/);
  assert.match(html, /id="providerModelCatalogSelect"[^>]*hidden/);
  assert.match(app, /providerModelInput\.value = ""/);
  assert.match(app, /providerModelInput\.value = profile\.model \|\| ""/);
  assert.match(app, /fetch\(`\/api\/providers\/\$\{encodeURIComponent\(providerId\)\}\/models`/);
  assert.match(app, /"X-Codex-Desktop-Action": "provider-models-query"/);
  assert.match(app, /mergeDiscoveredProviderModels\(providerId\)/);
  assert.doesNotMatch(server, /DeepSeekHarness|deepseek-harness|WFL_DEEPSEEK_HARNESS|codexDeepSeekHarnessMcpOverride/u);
  assert.doesNotMatch(app, /provider-subagent-settings|\/api\/providers\/subagent/u);
  for (const id of [
    "providerSubagentForm",
    "providerSubagentProviderInput",
    "providerSubagentWireApiInput",
    "saveProviderSubagentButton",
  ]) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(server, /providerStore\.setSubagent|resolveThirdPartySubagentExecutionContext|retainedForSubagent/u);
});

test("provider failover is explicit, account-scoped, and visible per conversation", () => {
  for (const id of [
    "threadProviderBadge",
    "providerFailoverSection",
    "providerFailoverToggle",
    "providerFailoverAcknowledge",
    "providerFailoverConfirmation",
    "providerFailoverList",
    "providerFailoverAudit",
    "providerFailoverSaveButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /自动切换可能改变请求身份与计费来源/);
  assert.match(html, /不会跨用户切换/);
  assert.match(app, /"X-Codex-Desktop-Action": "provider-failover-settings"/);
  assert.match(app, /"X-Codex-Desktop-Action": "provider-failover-check"/);
  assert.match(app, /acknowledgeIdentityAndBilling: enabling/);
  assert.match(app, /confirmation: enabling \? elements\.providerFailoverConfirmation/);
  assert.match(app, /message\.type === "provider\/thread-binding"/);
  assert.match(app, /message\.type === "provider\/routing-updated"/);
  assert.match(app, /function renderThreadProviderBinding/);
  assert.match(app, /target\.disabledReason !== "管理员未分配此 API"/);
  assert.match(css, /\.thread-provider-badge/);
  assert.match(css, /\.provider-failover-section/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.provider-failover-section/);
});

test("conversation messages show stable compact timestamps without affecting transcript identity", () => {
  assert.match(app, /<time hidden><\/time>/);
  assert.match(app, /function normalizeMessageTimestamp/);
  assert.match(app, /function firstMessageTimestamp/);
  assert.match(app, /function uuidV7Timestamp/);
  assert.match(app, /item\?\.type === "userMessage"[\s\S]{0,800}item\?\.type === "agentMessage"/);
  assert.match(app, /uuidV7Timestamp\(turn\?\.id\)/);
  assert.doesNotMatch(app.match(/function messageTimestamp[\s\S]*?\n\}/)?.[0] || "", /_displayCreatedAt|Date\.now/);
  assert.match(css, /\.message-label time/);
  assert.match(css, /\.message\.agent \.message-label > span:first-child/);
  assert.doesNotMatch(css, /\.message\.agent \.message-label,\s*\n\.message\.user/);
  assert.match(app, /node\.dataset\.transcriptKey = descriptor\.key/);
  assert.match(app, /previous\.replaceWith\(node\)/);
});

test("conversation context usage and compaction follow the official app-server protocol", () => {
  for (const id of [
    "contextStatusButton",
    "contextDialog",
    "contextPercentValue",
    "contextWindowValue",
    "contextCumulativeValue",
    "contextAutoCompactValue",
    "contextCompactionCountValue",
    "compactThreadButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /最近上下文占用/);
  assert.match(html, /id="compactThreadButton"[^>]*aria-label="立即压缩当前对话上下文"/);
  assert.match(app, /method === "thread\/tokenUsage\/updated"/);
  assert.match(app, /usage\?\.last\.totalTokens/);
  assert.match(app, /usage\.total\.totalTokens/);
  assert.match(app, /modelContextWindow/);
  assert.match(app, /item\.type !== "contextCompaction"/);
  assert.match(app, /method === "thread\/compacted"/);
  assert.match(app, /beginDurableOperation\("thread\/compact\/start", operationParams\)/);
  assert.match(app, /_wflClientOperationId: durableOperation\.clientOperationId/);
  assert.match(app, /DURABLE_OPERATION_CACHE_PREFIX/);
  assert.match(app, /error\?\.deliveryUnknown === true/);
  assert.match(app, /state\.threadTokenUsage\.get\(threadId\)/);
  assert.match(app, /至少 \$\{summary\.count\} 次/);
  assert.match(app, /"已加载 0 次"/);
  assert.match(app, /summary\.count \? "时间未上报" : "未记录"/);
  assert.match(app, /method === "item\/completed" && params\.item\?\.type === "contextCompaction"/);
  assert.match(css, /\.context-compaction-marker/);
});

test("native conversation and project-file search expose bounded desktop and mobile controls", () => {
  for (const id of [
    "conversationSearchButton",
    "conversationSearchDialog",
    "conversationSearchInput",
    "conversationSearchResults",
    "conversationSearchPreviousButton",
    "conversationSearchNextButton",
    "fileSearchButton",
    "fileSearchDialog",
    "fileSearchInput",
    "fileSearchResults",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /rpc\("thread\/search"/);
  assert.match(app, /rpc\("thread\/searchOccurrences"/);
  assert.match(app, /rpc\("fuzzyFileSearch\/sessionStart"/);
  assert.match(app, /rpc\("fuzzyFileSearch\/sessionUpdate"/);
  assert.match(app, /rpc\("fuzzyFileSearch\/sessionStop"/);
  assert.match(app, /appendHighlightedSearchSnippet/);
  assert.match(app, /openConversationSearchOccurrenceInResource/);
  assert.match(app, /previewKind: "conversation"/);
  assert.match(app, /不写入聊天/);
  assert.doesNotMatch(app, /jumpToConversationSearchOccurrence/);
  assert.match(server, /CODEX_SEARCH_REQUESTS_PER_WINDOW/);
  assert.match(server, /normalizeFuzzyFileSearchRoots/);
  assert.match(server, /fuzzyFileSearchSession\(client, publicSessionId\)/);
  assert.match(css, /\.search-panel \{/);
  assert.match(css, /\.search-result-snippet mark/);
  assert.match(css, /pre\[data-kind="conversation"\] mark/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.search-panel/);
});

test("official Goals are editable and cached per conversation while status stays automatic", () => {
  for (const id of [
    "goalBar",
    "goalOpenButton",
    "goalDialog",
    "goalCollapseButton",
    "goalDisabledNote",
    "goalObjectiveField",
    "goalObjectiveInput",
    "goalObjectiveCount",
    "goalStatusValue",
    "goalBudgetField",
    "goalCloseButton",
    "goalRunButton",
    "goalProviderCard",
    "goalSwitchProviderButton",
    "goalRecoveryCard",
    "goalRecoveryError",
    "goalRecoveryProviderButton",
    "goalRetryNowButton",
    "goalTokenBudgetInput",
    "goalClearButton",
    "goalClearButtonLabel",
    "goalSaveButton",
    "goalSaveButtonLabel",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /threadGoals: new Map\(\)/);
  assert.match(html, /id="goalObjectiveInput"[^>]*data-maxlength="4000"[^>]*aria-describedby="goalObjectiveCount"/);
  assert.match(app, /GOAL_OBJECTIVE_MAX_LENGTH = 4_000/);
  assert.match(app, /function updateGoalObjectiveCount\(\)/);
  assert.match(app, /Array\.from\(elements\.goalObjectiveInput\.value\)\.length/);
  assert.match(html, /0 \/ 4000 · 剩余 4000 字/);
  assert.match(app, /\$\{length\} \/ \$\{GOAL_OBJECTIVE_MAX_LENGTH\} · 剩余 \$\{remaining\} 字/);
  assert.match(app, /elements\.goalSaveButton\.disabled = state\.goalSaving \|\| length > GOAL_OBJECTIVE_MAX_LENGTH/);
  assert.match(server, /if \(method === "thread\/goal\/set"\) assertCodexGoalObjective\(params\)/);
  assert.match(css, /\.goal-objective-heading small\[data-status="limit"\]/);
  assert.match(app, /threadGoalRequestVersions: new Map\(\)/);
  assert.match(app, /threadGoalControls: new Map\(\)/);
  assert.match(app, /X-Codex-Desktop-Action": "goal-control"/);
  assert.match(app, /manualPauseState === "paused"/);
  assert.match(app, /manualPauseState === "paused"/);
  assert.match(app, /\["usageLimited", "blocked"\]\.includes\(goal\.status\)/);
  assert.match(app, /重新检查当前账号和 API 后启动受阻 Goal/);
  assert.match(app, /重新检查当前账号额度并继续 Goal/);
  assert.match(app, /data-lucide="\$\{canResume \? "play"/);
  assert.match(app, /rpc\("thread\/goal\/get", \{ threadId \}\)/);
  assert.match(app, /rpc\("thread\/goal\/set"/);
  assert.match(app, /beginDurableOperation\("thread\/goal\/set", operationParams\)/);
  assert.match(app, /beginDurableOperation\("thread\/goal\/clear", operationParams\)/);
  assert.match(app, /beginDurableOperation\("goal\/control", operationParams\)/);
  assert.match(app, /clientOperationId: durableOperation\.clientOperationId/);
  assert.match(app, /rpc\("thread\/goal\/clear"/);
  assert.match(app, /method === "thread\/goal\/updated"/);
  assert.match(app, /method === "thread\/goal\/cleared"/);
  assert.match(app, /state\.threadGoals\.set\(threadId, normalized\)/);
  assert.doesNotMatch(app, /goal: snapshot\.goal === undefined/);
  assert.match(app, /selectionVersion == null \|\| selectionVersion === state\.threadSelectionVersion/);
  assert.match(css, /\.goal-strip\[data-status="active"\]/);
  assert.doesNotMatch(html, /id="goalStatusInput"/);
  assert.match(html, /由 Codex 根据执行进度自动更新/);
  assert.match(html, /class="goal-status-dot"/);
  assert.match(css, /\.goal-button-details/);
  assert.match(css, /\.goal-run-button\[data-action="resume"\]/);
  assert.match(css, /\.goal-provider-card/);
  assert.match(css, /\.goal-recovery-card/);
  assert.match(app, /elements\.goalStatusValue\.textContent/);
  assert.doesNotMatch(app, /status: elements\.goalStatusInput\.value/);
  assert.match(app, /function clearGoalFromBar\(\)/);
  assert.match(app, /elements\.goalCollapseButton\.addEventListener\("click", closeGoalDialog\)/);
  assert.match(app, /function closeGoalDialog\(\)/);
  assert.match(app, /elements\.goalSaveButtonLabel\.textContent = state\.goalDraftEnabled \? "保存 Goal" : "启用 Goal"/);
  assert.match(app, /elements\.goalClearButtonLabel\.textContent = "关闭 Goal"/);
  assert.match(app, /编辑 Goal：\$\{statusLabel\} · \$\{goal\.objective\}/);
  assert.match(html, /class="settings-panel goal-panel" id="goalDialog"/);
  assert.match(css, /\.settings-panel\.goal-panel \{/);
  assert.match(css, /\.goal-collapse-button \{/);
  assert.match(css, /width: min\(380px, calc\(100vw - 20px\)\)/);
});

test("active Goals stay server-owned across browser disconnects and backend restarts", () => {
  assert.match(server, /CodexGoalRecoveryStore/);
  assert.match(server, /publicCodexNotification\(effectivePayload/);
  assert.match(server, /recordCodexGoalNotification\(publicPayload\)/);
  assert.match(server, /payload\.status === "ready"[\s\S]*?this\.scheduleGoalRecovery\(\)/);
  assert.match(server, /scanCodexGoalRollouts\(this\.user\.codexHome\)/);
  assert.match(server, /restoreCodexGoals\(records/);
  assert.match(server, /canReactivateUsageLimitedGoal/);
  assert.match(server, /goalUsageRecoveryAttempts/);
  assert.match(server, /goalUsageRecoveryRechecks/);
  assert.match(server, /\[5_000, 15_000, 30_000, 60_000, 120_000\]/);
  assert.match(server, /!BACKEND_PRIMARY_AT_START/);
  assert.match(server, /RESCUE_MODE/);
  assert.match(server, /restorePersistedUserGoalRuntimes/);
  assert.match(server, /pauseGoalAfterRetryLimit\(retryDecision, rawPayload\)/);
  assert.match(server, /classifyProviderFailure\(payload\)/);
  assert.match(server, /record\.failureKind !== "connectivity"/);
  assert.match(server, /goalConnectivityRetryDelay/);
  assert.match(server, /scheduleConnectivityGoalRetry\(record\)/);
  assert.match(server, /payload\.params\?\.success === true[\s\S]*scheduleGoalRecovery\(0, \{ force: true \}\)/);
  assert.match(html, /id="goalUnlimitedRetryInput"/);
  assert.match(html, /id="goalRetryFrequencyInput"/);
  assert.match(app, /\/api\/codex\/goal\/retry-settings/);
  assert.match(app, /\/api\/codex\/goal\/retry-now/);
  assert.match(app, /waiting\.lastError \|\| "API 或官方账号暂时不可用"/);
  assert.match(server, /assertOperationRequest\(request, "goal-retry-now"\)/);
  assert.match(app, /goalRetryFrequencyDescription/);
  assert.match(app, /retryFrequency/);
  const releaseClient = server.match(/releaseClient\(client\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(releaseClient, "client disconnect handler was not found");
  assert.doesNotMatch(releaseClient, /turn\/interrupt|bridge\.stop|goal\/clear/);
  const backgroundScheduler = server.match(
    /scheduleBackgroundTaskPump\(delayMs = null\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(backgroundScheduler, "background task scheduler was not found");
  assert.doesNotMatch(backgroundScheduler, /providerFailoverTimer/);
  const runtimeDestroy = server.match(/destroy\(reason = "Account disabled"\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(runtimeDestroy, "runtime destroy handler was not found");
  assert.match(runtimeDestroy, /clearTimeout\(this\.providerFailoverTimer\)/);
});

test("background conversations keep approvals routable after a project switch", () => {
  const preferredClient = server.match(/preferredClient\(threadId, excluded = null\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(preferredClient, "preferred client routing was not found");
  assert.match(preferredClient, /if \(ownerConnected\) return owner/);
  assert.match(preferredClient, /available\.find\(\(client\) => client\.pageVisible\) \|\| available\[0\]/);
  assert.doesNotMatch(preferredClient, /return threadId \? null/);
  assert.match(app, /return global \|\| state\.approvals\[0\] \|\| null/);
  assert.match(app, /approvalIsBackground\(request\)/);
  assert.match(app, /后台对话请求/);
  assert.match(app, /打开对应对话/);
  assert.match(app, /openApprovalConversation\(request\)/);
  assert.match(app, /threadTaskStatuses: new Map\(\)/);
  assert.match(app, /scope: "threads"/);
  assert.match(app, /includeThreads: "1"/);
  assert.match(app, /function projectTaskStatus\(projectPath\)/);
  assert.match(app, /class="project-task-status"/);
  assert.match(css, /\.project-task-status\[data-status="running"\]/);
  assert.match(css, /\.thread-row-status\[data-status="waiting"\]/);
  assert.match(server, /runtime\.taskStatus\.list\(\{ limit: 200 \}\)/);
});

test("official multi-agent collaboration is explicit, visible, and bounded", () => {
  assert.doesNotMatch(html, /id="collaborationModeButton"/);
  assert.doesNotMatch(html + app, /手动协作/);
  assert.match(html, /id="collaborationSettingsButton"/);
  assert.doesNotMatch(html + app, /协作提示词/);
  assert.doesNotMatch(html + app, /collaborationStrategyInput|collaborationPromptPreview/);
  assert.match(html, /id="collaborationSubagentEnabledInput" type="checkbox"/);
  assert.match(html, /id="collaborationPresetInput"/);
  assert.match(html, /id="collaborationSubagentModelInput"/);
  assert.match(html, /子代理模型/);
  assert.match(html, /id="collaborationSubagentEffortInput"/);
  assert.match(html, /id="collaborationThreadsInput"/);
  assert.match(html, /id="collaborationDepthInput"/);
  assert.match(app, /agents\.default_subagent_reasoning_effort/);
  assert.match(app, /agents\.max_concurrent_threads_per_session/);
  assert.match(app, /agents\.max_depth/);
  assert.match(app, /rpc\("collaborationMode\/list"/);
  assert.match(app, /agents\.default_subagent_model/);
  assert.match(app, /function populateSubagentModelSelect\(\)/);
  assert.match(app, /collaborationSubagentModelInput\.value/);
  assert.match(app, /developer_instructions: null/);
  assert.match(app, /agents\.enabled/);
  assert.doesNotMatch(app, /_wflCollaborationStrategy|message-collaboration-badge|codexDesktop\.collaborationStrategy/);
  assert.doesNotMatch(server, /applyCollaborationStrategyToTurnInput|normalizeCollaborationStrategy/);
  assert.match(server, /不能提交 Codex developer 协作指令/);
  assert.match(server, /_wflCollaborationStrategy:/);
  assert.match(app, /Ultra（最高，主动多代理）/);
  assert.match(app, /ultra: "自动协作"/);
  assert.doesNotMatch(app, /toggleCollaborationMode/);
  assert.match(app, /const model = preset\.model \|\| state\.selectedModel/);
  assert.match(app, /params\.collaborationMode = collaborationModeForRequest\(\)/);
  assert.match(app, /effort: state\.selectedEffort/);
  assert.match(app, /function turnStatusType\(turn\)/);
  assert.match(app, /turnStatusType\(result\.turn\) === "inProgress"/);
  assert.doesNotMatch(app, /multiAgentMode\s*:/);
  assert.match(app, /item\.type === "collabAgentToolCall"/);
  assert.match(app, /item\.type === "subAgentActivity"/);
  assert.match(app, /function summarizeSubagents/);
  assert.match(app, /function settleCompletedCollaborationTurn\(turn\)/);
  assert.match(app, /\["pendingInit", "running"\]\.includes\(normalizeSubagentStatus\(agent\?\.status\)\)/);
  assert.match(server, /async interruptTurn\(threadId, turnId/);
  assert.match(server, /scheduleInterruptWatchdog\(publicThreadId, effectiveTurnId\)/);
  assert.match(server, /\{ timeoutMs: 10_000 \}/);
  assert.match(server, /async forceBridgeRestart\(reason/);
  assert.match(server, /if \(!this\.bridge \|\| RESCUE_MODE\) return false/);
  assert.match(server, /validateCodexCollaborationMode/);
  assert.match(server, /Codex 协作模型不能为空/);
  assert.match(server, /该协作预设不是 Codex 当前提供的官方预设/);
  assert.match(server, /autoResolveServerRequest\(id\)/);
  assert.match(server, /this\.bridge\.respond\(pending\.payload\.id, \{ answers: \{\} \}\)/);
  assert.match(app, /等待选择已超时，Codex 将按最佳判断继续/);
  assert.match(app, /MAX_RENDERED_TOOL_OUTPUT_CHARS = 80_000/);
  assert.doesNotMatch(app, /MAX_CACHED_TOOL_OUTPUT_CHARS/);
  assert.match(app, /showToolOutput: localStorage\.getItem\("codexDesktop\.showToolOutput"\) === "true"/);
  assert.match(css, /\.subagent-item/);
  assert.match(css, /\.intelligence-collaboration-row/);
});

test("tool and file details keep content available while settings control default expansion", () => {
  assert.match(html, /id="showToolOutputInput"[\s\S]*工具输出默认展开/);
  assert.match(html, /id="expandFileChangesInput"[\s\S]*文件修改默认展开/);
  assert.match(html, /id="expandFileEditsInput"[\s\S]*单文件编辑默认展开/);
  assert.match(app, /defaultOpen: defaultOpen \|\| state\.ui\.showToolOutput/);
  assert.match(app, /defaultOpen: running && state\.ui\.showToolOutput/);
  assert.match(app, /defaultOpen: state\.ui\.expandFileChanges/);
  assert.match(app, /fileDetails\.open = transcriptExpansionValue\([\s\S]*?state\.ui\.expandFileEdits,/);
  assert.doesNotMatch(app, /defaultOpen: running \|\| state\.ui\.expandFileChanges/);
  assert.doesNotMatch(app, /state\.ui\.expandFileEdits \|\| \(running &&/);
  assert.match(app, /pre\.textContent = renderedToolOutput\(output\)/);
  assert.match(app, /else target\.textContent = renderedToolOutput\(item\.aggregatedOutput \|\| ""\)/);
  assert.doesNotMatch(app, /if \(state\.ui\.showToolOutput\) pre\.textContent/);
  assert.doesNotMatch(css, /\.hide-tool-output \.tool-output/);
});

test("multi-project task control coalesces recovery and avoids shared-bridge collateral", () => {
  assert.match(server, /goalRecoveryPendingThreadIds = new Set\(\)/);
  assert.match(server, /this\.goalRecoveryPendingThreadIds\.add\(candidate\)/);
  assert.match(server, /this\.goalRecoveryTimerDueAt <= dueAt/);
  assert.match(server, /threadIds\.map\(\(threadId\) => this\.goalRecoveryStore\.get\(threadId\)\)/);
  assert.match(server, /this\.taskStatus\.hasOtherActiveTasks\(threadId\)/);
  assert.match(server, /系统会继续定向重试，不会重启 Codex 连带中断其他任务/);
  assert.match(server, /assertThreadTaskCanStart\(threadId, \{ clientSubmissionId = null \} = \{\}\)/);
  assert.match(server, /this\.assertThreadTaskCanStart\(threadId, \{\s*clientSubmissionId: run\.id/);
  assert.match(server, /当前对话已有任务运行/);
  assert.match(server, /backgroundTaskTerminalNotifications = new Map\(\)/);
  assert.match(server, /ERR_BACKGROUND_TASK_CANCELLED/);
  assert.match(server, /payload\.params\?\.willRetry === true/);
  assert.match(server, /目标用户仍有任务运行，请等待完成或终止后再分配 API 供应商/);
});

test("official permission profiles and managed requirements are enforced beyond the settings UI", () => {
  assert.match(html, /id="settingsPermissionProfile"/);
  assert.match(html, /id="settingsApprovalsReviewer"/);
  assert.match(html, /id="settingsPolicySummary"/);
  assert.match(app, /rpc\("configRequirements\/read"/);
  assert.match(app, /rpc\("permissionProfile\/list"/);
  assert.match(app, /approvals_reviewer/);
  assert.match(app, /最终生效/);
  assert.match(server, /validateManagedConfigWrite/);
  assert.match(server, /validateCodexThreadPolicy/);
  assert.match(server, /浏览器不能直接提交原始 sandboxPolicy/);
  assert.match(css, /\.permission-policy-summary/);
});

test("official account login, queries, and reset require dedicated guarded controls", () => {
  for (const id of [
    "officialLoginButton",
    "officialContinueLoginButton",
    "officialRefreshButton",
    "officialAccountDetails",
    "officialAccountSlots",
    "officialAccountSlotList",
    "officialWorkspaceSection",
    "officialWorkspaceUnread",
    "officialWorkspaceSummary",
    "officialWorkspaceList",
    "officialWorkspaceReadButton",
    "officialCreditsNudgeButton",
    "officialUsageNudgeButton",
    "officialWorkspaceActionStatus",
    "officialProxyDialog",
    "officialProxyModeInput",
    "officialProxyHostInput",
    "officialProxyPortInput",
    "officialProxyUsernameInput",
    "officialProxyPasswordInput",
    "officialProxyTestButton",
    "officialProxySubmitButton",
    "officialBrowserDialog",
    "officialBrowserFrame",
    "officialBrowserKeyboardTray",
    "officialBrowserKeyboardInput",
    "officialBrowserClipboardTray",
    "officialBrowserClipboardButton",
    "officialBrowserKeyboardButton",
    "officialBrowserClaudeCodeButton",
    "officialBrowserCancelButton",
    "officialPrepareResetButton",
    "officialResetDialog",
    "officialResetConfirmationInput",
    "officialResetConfirmButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /"X-Codex-Desktop-Action": "official-login-start"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-account-switch"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-account-remove"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-proxy-test"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-proxy-save"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-workspace-messages-read"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-credits-nudge"/);
  assert.match(app, /confirmation: "发送额度提醒"/);
  assert.match(app, /function officialNudgeCooldown/);
  assert.match(app, /function officialProxyDialogPayload/);
  assert.match(app, /7 天用量/);
  assert.match(app, /当前账号登录已失效。账号资料和最近 7 天额度已保留，请重新登录。/);
  assert.match(app, /activeStoredAccount\?\.credentialStatus === "invalid"/);
  assert.match(css, /\.official-account-slot\[data-credential-status="invalid"\]/);
  assert.match(server, /requireOfficialAccountAccess/);
  assert.match(server, /"account\/read", \{ refreshToken: true \}/);
  assert.match(server, /markActiveInvalid/);
  assert.match(server, /OfficialProxyRouter/);
  assert.match(server, /shell_environment_policy\.exclude/);
  assert.match(server, /app\.post\("\/api\/providers\/official\/proxy\/test"/);
  assert.match(server, /app\.put\("\/api\/providers\/official\/accounts\/:id\/proxy"/);
  assert.match(server, /app\.post\("\/api\/providers\/official\/workspace-messages\/read"/);
  assert.match(server, /app\.post\("\/api\/providers\/official\/credits-nudge"/);
  assert.match(server, /quota\.workspaceMessages\?\.featureEnabled !== true/);
  assert.match(server, /requireCodexWorkspaceMessages/);
  assert.match(css, /\.official-workspace-section/);
  assert.match(app, /import\("\/vendor\/novnc-1\.7\.0\/core\/rfb\.js(?:\?v=[^"]+)?"\)/);
  assert.match(app, /function officialBrowserApiPrefix/);
  assert.match(app, /"\/api\/providers\/official\/login\/browser"/);
  assert.match(app, /"\/api\/claude\/official\/login\/browser"/);
  assert.match(app, /"\/api\/claude\/mcp\/oauth\/browser"/);
  assert.match(app, /openOfficialBrowserDialog\("claude-mcp"\)/);
  assert.doesNotMatch(app, /window\.open\(elicitation\.url/);
  assert.match(app, /new RFB\(/);
  assert.match(app, /function captureOfficialBrowserClipboard/);
  assert.match(app, /officialBrowserPendingInputs: \[\]/);
  assert.match(app, /function queueOfficialBrowserRfbInput/);
  assert.match(app, /function flushOfficialBrowserPendingInputs/);
  assert.match(app, /queue\.length >= 64/);
  assert.match(app, /function officialBrowserAction/);
  assert.match(html, /无法直接输入？点击下方“输入键盘”，再输入邮箱、密码或验证码。/);
  assert.match(html, /id="officialBrowserKeyboardButton"[\s\S]*<span>输入键盘<\/span>/);
  assert.match(css, /\.official-browser-input-hint/);
  assert.match(app, /"X-Codex-Desktop-Action": officialBrowserAction\("clipboard"\)/);
  assert.match(app, /sendOfficialBrowserText\(value\)/);
  assert.match(app, /toast\("Codex 官方登录成功"\)/);
  assert.match(app, /toast\("Claude 官方登录成功"\)/);
  assert.match(app, /async function confirmClaudeOfficialLogin/);
  assert.match(app, /正在确认服务器登录/);
  assert.match(app, /claude-official-login-browser-close/);
  assert.match(app, /claude-official-login-browser-authorize/);
  assert.match(app, /officialLoginBrowser/);
  assert.match(app, /剪贴板内容不是 Claude 授权码/);
  assert.match(app, /已阻止浏览器历史导航/);
  assert.match(app, /officialBrowserDialog\.dataset\.runtime = selectedRuntime/);
  assert.match(app, /async function submitClaudeOfficialCodeFromBrowser/);
  assert.match(app, /"claude-official-login-browser-clipboard"/);
  assert.match(html, /读取并提交授权码/);
  assert.match(css, /\.official-browser-dialog\[data-runtime="claude"\] \.official-browser-footer/);
  const claudeSubmitRoute = server.slice(
    server.indexOf('app.post("/api/claude/official/login/submit"'),
    server.indexOf('app.post("/api/claude/official/login/browser/close"'),
  );
  assert.doesNotMatch(claudeSubmitRoute, /claudeOfficialLoginBrowser\?\.close/);
  assert.match(server, /app\.post\("\/api\/claude\/official\/login\/browser\/close"/);
  assert.match(html, /id="claudeOfficialLoginLink" type="button"/);
  assert.doesNotMatch(html, /id="claudeOfficialLoginLink"[^>]*target="_blank"/);
  assert.match(html, /class="official-browser-frame" id="officialBrowserFrame" role="application"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-reset-prepare"/);
  assert.match(app, /"X-Codex-Desktop-Action": "official-reset-execute"/);
  assert.match(app, /confirmationPhrase/);
  assert.match(app, /value !== state\.officialResetChallenge\.confirmationPhrase/);
  assert.doesNotMatch(app, /localStorage[^\n]*(?:loginId|creditId|officialReset)/i);
  assert.doesNotMatch(app, /window\.open\([^\n]*(?:official|authUrl|verification)/i);
  assert.doesNotMatch(app, /(?:innerHTML|textContent|value)\s*=\s*[^\n]*(?:authUrl|loginId)/i);
  assert.doesNotMatch(html, /id="officialResetConfirmationInput"[^>]*\svalue=/);
  assert.doesNotMatch(html, /id="officialProxyPasswordInput"[^>]*\svalue=/);
  assert.doesNotMatch(app, /localStorage[^\n]*(?:officialProxy|proxyPassword)/i);
});

test("remote Git comparison is read-only, permission-gated, bounded, and mobile-operable", () => {
  for (const id of [
    "gitRemoteTab",
    "gitRemotePanel",
    "gitRemoteNameInput",
    "gitRemoteBranchInput",
    "gitRemoteCompareButton",
    "gitRemoteFileList",
    "gitRemoteReviewButton",
    "accountCodexRemoteDiffPermission",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  const panel = html.slice(
    html.indexOf('id="gitRemotePanel"'),
    html.indexOf('id="gitHistoryPanel"'),
  );
  assert.doesNotMatch(panel, /type="(?:password|text)"[^>]*(?:token|key|credential)/i);
  assert.match(app, /new URL\("\/api\/git\/remote-diff"/);
  assert.match(app, /function canUseCodexRemoteDiff/);
  assert.match(app, /function canStartRemoteGitReview/);
  assert.match(app, /state\.activeThread\.cwd === state\.currentProject\.path/);
  assert.match(app, /elements\.gitReviewTargetInput\.value = "baseBranch"/);
  assert.match(server, /app\.get\("\/api\/git\/remote-diff"/);
  assert.match(server, /requireCodexRemoteDiff\(request\)/);
  assert.match(server, /"gitDiffToRemote"/);
  assert.match(server, /localTrackingRefsOnly: true/);
  assert.match(server, /includesUntracked: false/);
  assert.match(server, /"--no-textconv"/);
  assert.match(css, /\.git-remote-file/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.git-remote-status-grid/);
});

test("Codex feedback requires a redacted preview, explicit confirmation, and a server-only native RPC", () => {
  for (const id of [
    "accountFeedbackButton",
    "accountCodexFeedbackPermission",
    "codexFeedbackDialog",
    "codexFeedbackClassificationInput",
    "codexFeedbackReasonInput",
    "codexFeedbackDiagnosticsInput",
    "codexFeedbackPreviewButton",
    "codexFeedbackPreviewText",
    "codexFeedbackConfirmInput",
    "codexFeedbackCopyButton",
    "codexFeedbackSubmitButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /永不自动上传/);
  assert.match(html, /不会读取原生日志、对话、提示词、回复、项目源码或命令内容/);
  assert.match(app, /\/api\/codex\/feedback\/preview/);
  assert.match(app, /\/api\/codex\/feedback\/upload/);
  assert.match(app, /submit-safe-feedback/);
  assert.match(app, /function canUseCodexFeedback/);
  assert.match(server, /requireCodexFeedbackAccess\(request\)/);
  assert.match(server, /runtime\.bridge\.request\(\s*"feedback\/upload"/);
  assert.match(feedback, /includeLogs: false/);
  assert.doesNotMatch(feedback, /\bthreadId\b/);
  const allowlist = server.match(/const RPC_ALLOWLIST = new Set\(\[[\s\S]*?\n\]\);/)?.[0] || "";
  assert.doesNotMatch(allowlist, /feedback\/upload/);
  assert.match(css, /\.codex-feedback-preview pre/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.codex-feedback-dialog/);
});

test("the plugin center installs only catalog plugins and keeps SSH passwords ephemeral", () => {
  assert.match(html, /id="pluginButton"/);
  assert.match(html, /id="pluginDialog"/);
  for (const id of ["pluginDependencyPanel", "pluginDependencyStatus", "pluginDependencyButton"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="officialCodexPluginsButton"[^>]*>[^<]*<i[^>]*data-lucide="puzzle"/);
  assert.match(app, /elements\.officialCodexPluginsButton\.addEventListener\("click", openOfficialCodexPlugins\)/);
  assert.match(app, /state\.codexExtensionTab = "plugins";[\s\S]*?await openCodexExtensionCenter\(\)/);
  assert.match(css, /\.official-codex-plugins-button/);
  assert.match(app, /fetch\(`\/api\/plugins\?_=/);
  assert.match(app, /"X-Codex-Desktop-Action": "plugin-install"/);
  assert.match(app, /"X-Codex-Desktop-Action": "plugin-toggle"/);
  assert.match(app, /"X-Codex-Desktop-Action": "plugin-uninstall"/);
  assert.match(app, /prepareAndroidApkDependency/);
  assert.match(app, /android-apk-dependency-install/);
  assert.match(server, /\/api\/plugins\/android-drive-builder\/dependencies\/install/);
  assert.match(androidBuilder, /openjdk-17-jdk-headless/);
  assert.match(html, /id="sshPasswordInput" type="password"[^>]*autocomplete="new-password"/);
  assert.match(html, /id="sshDurationInput"/);
  for (const duration of [30, 60, 120]) assert.match(html, new RegExp(`value="${duration}"`));
  assert.doesNotMatch(html, /id="sshPasswordInput"[^>]*\svalue=/);
  assert.match(app, /clearSshPassword\(\);\s*const response = await request/);
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\([^\n]*sshPassword/i);
  assert.match(app, /"X-Codex-Desktop-Action": "ssh-authorize"/);
  assert.match(app, /durationMinutes: Number\(elements\.sshDurationInput\.value\)/);
  assert.match(app, /"X-Codex-Desktop-Action": "ssh-revoke"/);
  assert.match(app, /response\.headers\.get\("content-type"\)/);
  assert.match(app, /includes\("application\/json"\)/);
  assert.match(app, /response\.status === 502 \|\| response\.status === 504/);
  assert.match(app, /连接响应中断，但临时 SSH 授权已创建/);
  for (const id of [
    "persistentSshDialog",
    "persistentSshForm",
    "persistentSshPasswordInput",
    "persistentSshPasswordCompatibilityInput",
    "persistentSshRecords",
    "persistentSshCreateButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /关闭后，AI 列表立即移除该服务器并中断活动命令/);
  assert.match(html, /公钥不兼容时允许加密保存密码/);
  assert.match(css, /\.ssh-access-modal form\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.ssh-access-body\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?scrollbar-gutter:\s*stable;/);
  assert.match(html, /id="androidDriveBuilderDialog"/);
  assert.match(html, /id="androidDriveBuilderOperationStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(css, /\.android-drive-builder-security > span[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.android-drive-builder-profile small[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.android-drive-builder-card\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(app, /正在加密保存签名配置…/);
  assert.match(app, /androidDriveBuilderOperationStatus\.scrollIntoView/);
  assert.match(app, /toast\(message, normalizedStatus\)/);
  assert.match(app, /"X-Codex-Desktop-Action": "persistent-ssh-toggle"/);
  assert.match(app, /server\.enabled \? "AI 可用" : "AI 不可见"/);
  assert.match(app, /allowPasswordCompatibility: elements\.persistentSshPasswordCompatibilityInput\.checked/);
  assert.match(app, /server\.authMode === "password"/);
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\([^\n]*persistentSshPassword/i);
  for (const id of [
    "windowsHostDialog",
    "windowsHostDownloadLink",
    "windowsHostPairButton",
    "windowsHostDevices",
    "windowsRemoteProjectInput",
    "windowsRemoteThreadInput",
    "windowsRemoteCompose",
    "windowsCreatorKindInput",
    "windowsCreatorSpecInput",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /windows-device-pairing-create/);
  assert.match(app, /snapshot\.companion\?\.downloadUrl/);
  assert.match(app, /windows-device-lease-acquire/);
  assert.match(app, /windows-host-call/);
  assert.match(app, /codex\.thread\.resume/);
  assert.match(app, /creator\.job\.run/);
  assert.match(app, /plugin-grant-revoke/);
  assert.match(css, /\.windows-host-modal/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.windows-host-modal/);
});

test("API provider switching prepares Codex state before requesting a restart", () => {
  const activation = app.match(/async function activateProviderProfile\(id\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(activation, "provider activation handler was not found");
  assert.ok(activation.indexOf("prepareProviderSwitch()") < activation.indexOf("fetch("));
  assert.doesNotMatch(activation, /state\.bootstrapped = false/);
});

test("active conversations survive provider restarts and browser reloads", () => {
  assert.match(app, /THREAD_RECOVERY_KEY = "codexDesktop\.activeThread"/);
  assert.match(app, /await recoverActiveThread\(\)/);
  assert.match(app, /thread\/resume/);
  assert.match(app, /const resumedThread = recentThread/);
  assert.match(app, /replaceConversationThread\([\s\S]*?resumedThread/);
  assert.doesNotMatch(app, /mergeThreadWithRecentPage\(targetSnapshot\.thread, recentThread\)/);
  assert.match(app, /rememberActiveThread\(state\.activeThread\)/);
  assert.match(app, /if \(state\.activeThread && state\.activeThreadNeedsResume\)/);
});

test("browser persistence is account-scoped without erasing server recovery", () => {
  assert.match(app, /function accountStorageKey\(base, account = state\.account\)/);
  assert.match(app, /accountStorageKey\("codexDesktop\.project"/);
  assert.match(app, /accountStorageKey\(THREAD_RECOVERY_KEY/);
  assert.match(app, /const storedThreadRecovery = loadStoredThreadRecovery\(data\.user\)/);
  assert.match(app, /else if \(storedThreadRecovery\) \{[\s\S]*?server recovery record/);
  assert.match(app, /state\.pinnedThreadIds = loadStoredSet\("codexDesktop\.pinnedThreads", data\.user\)/);
});

test("conversation imports are bounded, project-scoped, and wired beside exports", () => {
  assert.match(html, /id="importThreadButton"[^>]*title="导入对话"/);
  assert.match(html, /id="importThreadInput"[^>]*accept="\.json,\.md,application\/json,text\/markdown"[^>]*hidden/);
  assert.match(app, /THREAD_IMPORT_LIMIT_BYTES = 5 \* 1024 \* 1024/);
  assert.match(app, /"X-Codex-Desktop-Action": "thread-import"/);
  assert.match(app, /project=\$\{encodeURIComponent\(state\.currentProject\.path\)\}/);
  assert.match(app, /await selectThread\(imported\)/);
  assert.match(app, /state\.activeThread\?\.imported === true/);
});

test("new conversations materialize their first message before thread list refresh", () => {
  const send = app.match(/async function sendPrompt\(\) \{[\s\S]*?\n\}/)?.[0];
  const submit = app.match(/async function submitPendingTurnRequest\([\s\S]*?\n\}/)?.[0];
  assert.ok(send);
  assert.ok(submit);
  assert.doesNotMatch(send, /rememberActiveThread\(state\.activeThread\)/);
  assert.doesNotMatch(send, /await loadThreads\(\)/);
  assert.match(submit, /rememberActiveThread\(state\.activeThread\)/);
  assert.match(submit, /void loadThreads\(\)/);
  assert.doesNotMatch(app, /method === "thread\/started" \|\| method === "thread\/name\/updated"/);
});

test("interrupted turn starts keep one client ID and wait for safe confirmation", () => {
  assert.match(app, /state\.pendingTurnRequest = \{\s*params,\s*text,\s*skills,\s*apps,\s*imageContextTransaction,/);
  assert.match(app, /retryPendingTurnRequest\(\)/);
  assert.match(app, /error\.deliveryUnknown/);
  assert.match(app, /本条消息将在恢复后安全确认/);
  assert.match(app, /payload\.type === "result"[\s\S]{0,240}?commitConversationImageContext\(state\.imageContextLedger, pending\.imageContextTransaction\)/);
  assert.match(app, /function finishPendingSteerForTurn[\s\S]{0,500}?commitConversationImageContext\(state\.imageContextLedger, request\.imageContextTransaction\)/);
  assert.match(app, /setTimeout\(\(\) => refreshRecentTurns\(threadId\), 250\)/);
  assert.doesNotMatch(app, /catch \(error\) \{\s*elements\.promptInput\.value = text;\s*resizePrompt\(\);\s*state\.pendingUserMessage = null;/);
});

test("official model capacity failures do not auto-downgrade the model", () => {
  assert.doesNotMatch(app, /applyOfficialModelCapacityFallback/);
  assert.doesNotMatch(app, /selectModelCapacityFallback/);
  assert.match(app, /function codexFailureMessage\(error\)/);
  assert.doesNotMatch(app, /正在为下一次发送选择备用模型/);
  assert.match(server, /record\?\.failureKind === "connectivity"[\s\S]*?queueAutomaticProviderFailover/);
  assert.doesNotMatch(server, /failureKind === "capacity"[\s\S]{0,160}?queueAutomaticProviderFailover/);
});

test("transient Codex disconnects preserve the composer and avoid cold bootstrap", () => {
  assert.match(app, /connectionPhase: "cold"/);
  assert.match(app, /codexRuntimeEpoch: null/);
  assert.match(app, /codexEventSequence: 0/);
  assert.match(app, /function codexSoftReconnectEligible/);
  assert.match(app, /function beginConnectionInterruption/);
  assert.match(app, /SOCKET_RECONNECT_NOTICE_MS = 1_500/);
  assert.match(app, /function restoreCodexConnection/);
  assert.match(app, /hadSoftConversation && runtimeStatus\.sameEpoch/);
  assert.match(app, /runtimeStatus\.missedEvents[\s\S]*?synchronizeCodexAfterReconnect/);
  const reconnectSynchronization = app.slice(
    app.indexOf("async function synchronizeCodexAfterReconnect"),
    app.indexOf("function scheduleSocketReconnect"),
  );
  assert.match(reconnectSynchronization, /resumeThread\(state\.activeThread/);
  assert.doesNotMatch(reconnectSynchronization, /refreshRecentTurns|thread\/turns\/list/);
  assert.match(app, /state\.connectionPhase === "reconnecting"[\s\S]*?state\.conversationReady/);
  assert.match(app, /queuedPromptAfterReconnect/);
  assert.match(app, /function flushQueuedPromptAfterReconnect/);
  assert.match(app, /bootstrapGeneration/);
  assert.match(app, /generation !== state\.bootstrapGeneration/);
  assert.match(css, /\[data-status="reconnecting"\] \.status-dot/);
  assert.match(app, /function renderTurnStatus\(\{ busy, composerReady, label \}\)/);
  assert.match(app, /elements\.turnStatus\.dataset\.visualState === visualState/);
  assert.match(app, /elements\.sendButton\.disabled !== sendDisabled/);
  assert.match(css, /\.send-button:disabled \{[\s\S]*?opacity: 1/);
  assert.match(server, /codexRuntimeEpoch = crypto\.randomUUID\(\)/);
  assert.match(server, /codexUpstreamEventSequence \+= 1/);
  assert.match(server, /this\.codexEventSequence = this\.codexUpstreamEventSequence;[\s\S]*?this\.broadcast\(notificationMessage\)/);
  assert.match(server, /runtimeEpoch: this\.codexRuntimeEpoch/);
  assert.match(server, /eventSequence: this\.codexUpstreamEventSequence/);
});

test("conversation state uses official events and atomic Thread replacement", () => {
  assert.match(app, /conversationState: createConversationState\(\)/);
  assert.match(app, /reduceConversationNotification\([\s\S]*?notification/);
  assert.match(app, /replaceActiveConversationThread\(resumedThread\)/);
  assert.match(conversationState, /partition\.threads\.set\(thread\.id, normalizeThread\(thread\)\)/);
  assert.match(conversationState, /method === "item\/completed"/);
  assert.match(conversationState, /method === "turn\/completed"/);
  const projectResolver = app.slice(
    app.indexOf("function conversationProjectForThread"),
    app.indexOf("function replaceActiveConversationThread"),
  );
  assert.doesNotMatch(projectResolver, /state\.currentProject|"default"/);
  const notificationReducer = app.slice(
    app.indexOf("function handleCodexNotification"),
    app.indexOf("function renderActiveThread"),
  );
  assert.match(notificationReducer, /if \(notificationProject\) \{[\s\S]*?reduceConversationNotification/);
  const resumeFailure = app.slice(
    app.indexOf("  } catch (error) {", app.indexOf("async function resumeThread")),
    app.indexOf("async function prepareActiveThreadForSend"),
  );
  assert.doesNotMatch(resumeFailure, /thread\/read|thread\/turns\/list/);
  assert.doesNotMatch(app, /conversation\/(?:hello|ack|observe|replay|calibrate|activate|release)/);
  assert.doesNotMatch(app, /ConversationCheckpointStore|canonicalConversationState/);
  assert.doesNotMatch(app, /state\.activeThread\.(?:name|turns)\s*=/);
  assert.doesNotMatch(app, /_canonicalId|projectedCanonicalId|mergeCanonicalTurnProjection/);
  assert.doesNotMatch(conversationState, /_canonicalId|mergeCanonicalTurnProjection/);
  assert.doesNotMatch(server, /conversation\/(?:hello|ack|observe|replay|calibrate|activate|release)/);
});

test("new-thread delivery is idempotent across a same-runtime reconnect", () => {
  assert.match(app, /_wflClientThreadRequestId: pending\.clientId/);
  assert.match(app, /rpcWithSameRuntimeRetry\("thread\/start", params\)/);
  assert.match(app, /state\.codexRuntimeEpoch !== expectedEpoch/);
  assert.match(server, /new ThreadStartDeduplicator\(\)/);
  assert.match(server, /runtime\.threadStartDeduplicator\.run\(_wflClientThreadRequestId/);
  assert.match(server, /新对话请求 ID 无效/);
});

test("unchanged transcript nodes are reused before their renderers run", () => {
  const reconcile = app.match(/function reconcileTranscriptNodes\(descriptors\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(app, /transcriptNodeDescriptor\(createNode/);
  assert.ok(
    reconcile.indexOf("previous?.dataset.transcriptSignature") < reconcile.indexOf("descriptor.createNode()"),
  );
  assert.match(app, /const changed = reconcileTranscriptNodes\(descriptors\)/);
  assert.match(app, /if \(changed > 0\) \{\s*refreshIcons\(\)/);
  assert.match(css, /\.message-list > \[data-transcript-key\][\s\S]*content-visibility: auto/);
  assert.match(css, /contain-intrinsic-size: auto 96px/);
});

test("conversation runtime events cannot overwrite the other runtime's active task", () => {
  assert.match(app, /runtimeSwitchPending: false/);
  assert.match(app, /if \(state\.runtimeSwitchPending\) \{[\s\S]*?界面正在切换/);
  assert.match(app, /if \(state\.runtime !== "codex"\) \{[\s\S]*?state\.activeThread = null;[\s\S]*?return;/);
  assert.match(app, /function synchronizeClaudeRunState\(session\) \{[\s\S]*?if \(state\.runtime === "claude"\) \{[\s\S]*?state\.activeTurnId =/);
  assert.match(app, /state\.codexActiveTurnId = state\.activeTurnId/);
});

test("terminal conversation snapshots reject delayed stream mutations and settle steer delivery", () => {
  assert.match(conversationState, /function streamingTurn\(thread, turnId\) \{[\s\S]*?!runningStatus\(existing\.status\)/);
  assert.match(conversationState, /item\/agentMessage\/delta[\s\S]*?appendItemText\(thread, params/);
  assert.match(app, /settlePendingSteerMessages\(turn\);[\s\S]*?turnStatusType\(turn\) !== "inProgress"[\s\S]*?finishPendingSteerForTurn\(turn\.id\)/);
  assert.match(conversationState, /method === "error"[\s\S]*?turn\.status = "failed"/);
  assert.match(app, /if \(!turnStateIsComplete\) scheduleRecentTurnsRefresh\(eventThreadId\)/);
  assert.match(conversationState, /function completeTurn\(thread, incoming\)/);
  assert.match(conversationState, /upsertItem\(turn, item, \{ terminal: true \}\)/);
  assert.match(app, /startedItems[\s\S]*?matchesPendingUserMessage\(state\.pendingUserMessage, startedTurnId, item\)[\s\S]*?bindPendingUserMessage/);
  const steer = server.match(/if \(method === "turn\/steer"\) \{[\s\S]*?\n  \}\n  if \(method === "turn\/start"\)/)?.[0];
  assert.ok(steer, "turn/steer server handler was not found");
  assert.match(
    steer,
    /return runtime\.turnStartDeduplicator\.run\(bridgeParams, steer\)/,
  );
  assert.doesNotMatch(steer, /CONVERSATION_SIDECAR_ENABLED|conversationSidecar/);
  assert.ok(steer.indexOf("runtime.taskStatus.snapshot") < steer.indexOf("runtime.submitCodexRpc"));
});

test("the recovery center falls back to server-persisted thread metadata", () => {
  assert.match(html, /id="recoveryButton"/);
  assert.match(html, /id="recoveryDialog"/);
  assert.match(html, /id="recoveryList"/);
  assert.match(app, /fetchWithTimeout\(`\/api\/recovery\?_=/);
  assert.match(app, /useLatest && !state\.threadRecovery/);
  assert.match(app, /record\.status !== "failed"/);
  assert.match(app, /persistThreadRecovery\(recovery, status\)/);
  assert.match(app, /rememberActiveThread\(state\.activeThread, "recovered"\)/);
  assert.doesNotMatch(app, /rememberActiveThread\(state\.activeThread, "read-only"\)/);
});

test("conversation recovery preserves metadata but never reconstructs chat outside thread resume", () => {
  const selection = app.match(/async function selectThread\(thread\) \{[\s\S]*?\n\}/)?.[0];
  const resume = app.match(/async function resumeThread\(\s*thread,[\s\S]*?\n\}\n\nfunction recentTurnsParams/)?.[0];
  const recovery = app.match(/async function recoverActiveThread\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(selection, /scrollMessagesToBottom\(\)/);
  assert.doesNotMatch(selection, /thread\/read|refreshActiveThread/);
  assert.match(resume, /excludeTurns: true/);
  assert.match(resume, /initialTurnsPage/);
  assert.match(resume, /limit: RECOVERY_TURNS_SHOWN/);
  assert.doesNotMatch(resume, /includeTurns: false|rpc\("thread\/turns\/list"/);
  assert.match(resume, /scrollToBottom = !preserveExisting/);
  assert.match(recovery, /scrollToBottom: true/);
  assert.match(resume, /persistThreadRecovery\(thread, "failed"\)/);
  assert.doesNotMatch(recovery, /clearThreadRecovery\(\)/);
});

test("conversation content is restored from the App Server instead of browser snapshots", () => {
  assert.match(app, /const activeTurn = recentThread\.turns\?\.find/);
  assert.match(app, /selectionVersion !== state\.threadSelectionVersion/);
  assert.doesNotMatch(app, /threadCache|rememberThreadSnapshot|persistThreadSessionCache/);
  assert.doesNotMatch(app, /clearLegacyThreadSnapshots|THREAD_SNAPSHOT_LEGACY_PREFIXES|threadSnapshots\.v/);
  assert.doesNotMatch(app, /sessionStorage\.setItem\([^\n]*threadSnapshots/);
  assert.match(app, /const resumedThread = recentThread/);
  assert.match(app, /replaceActiveConversationThread\(resumedThread\)/);
  assert.doesNotMatch(app, /activateThreadSnapshot\(thread, targetSnapshot\)/);
  assert.match(app, /clearThreadSessionCache\(\);[\s\S]*clearThreadRecovery\(\)/);
});

test("the conversation sidebar paginates and preserves account-isolated cached history on refresh failures", () => {
  assert.match(app, /THREAD_LIST_PAGE_LIMIT = 100/);
  assert.match(app, /THREAD_LIST_MAX_ITEMS = 1_000/);
  assert.match(app, /THREAD_LIST_CACHE_PREFIX = "codexDesktop\.threadLists\.v1"/);
  assert.match(app, /restoreThreadListSessionCache\(data\.user\)/);
  assert.match(app, /async function loadCodexThreadListPages/);
  assert.match(app, /const result = await rpc\("thread\/list", params\)/);
  assert.match(app, /seenCursors\.has\(nextCursor\)/);
  const loader = app.match(/async function loadThreads\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loader);
  assert.match(loader, /if \(state\.threads\.length\) renderThreads\(\)/);
  assert.doesNotMatch(loader, /state\.threads = \[\][\s\S]*catch/);
  assert.match(app, /removeThreadSessionCacheItem\(state\.threadListCacheStorageKey\)/);
});

test("the server stops one turn after five consecutive retryable API errors", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /TURN_API_RETRY_LIMIT = 5/);
  assert.match(server, /new TurnRetryLimiter\(\{ maxRetries: TURN_API_RETRY_LIMIT \}\)/);
  assert.match(server, /retryDecision\.action === "limit"[\s\S]*interruptRetryingTurn\(retryDecision\)/);
  assert.match(server, /bridge\.request\("turn\/interrupt", \{ threadId, turnId \}/);
  assert.match(app, /`API 重连 \$\{retryCount\}\/\$\{retryLimit\}`/);
});

test("long conversations load recent turns first and fetch older pages on demand", () => {
  assert.match(app, /RECOVERY_TURNS_SHOWN = 4/);
  assert.match(app, /RECENT_TURNS_SHOWN = 8/);
  assert.match(app, /async function loadEarlierTurns\(\)/);
  assert.match(app, /threadHistoryPageRequests: new Map\(\)/);
  assert.match(app, /state\.threadHistoryPageRequests\.has\(threadId\)/);
  assert.match(app, /nextCursor === cursor/);
  assert.match(app, /handleMessageHistoryScroll/);
  assert.match(app, /threadHistoryTopTriggerArmed/);
  assert.match(app, /已经到最早记录/);
  assert.match(app, /加载失败，点击重试/);
  assert.match(
    app,
    /mergeLoadedTurnPage\([\s\S]*?state\.activeThread\.turns \|\| \[\],[\s\S]*?earlier,[\s\S]*?\{ prepend: true, chronological: true \}/,
  );
  const completed = app.match(/if \(method === "turn\/completed"\) \{[\s\S]*?\n  \}/)?.[0];
  assert.doesNotMatch(completed, /thread\/read|refreshActiveThread/);
  const completionHandlerStart = app.lastIndexOf('  if (method === "turn/completed") {');
  const completionHandler = app.slice(
    completionHandlerStart,
    app.indexOf('  if (method === "thread/compacted") {', completionHandlerStart),
  );
  assert.match(completionHandler, /completedTurnStateIsComplete\(params, mergedTurn\)/);
  assert.match(completionHandler, /if \(!turnStateIsComplete\) scheduleRecentTurnsRefresh/);
  assert.doesNotMatch(completionHandler, /\n    scheduleRecentTurnsRefresh/);
  const stateCheck = app.match(/function completedTurnStateIsComplete\(params, turn\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(stateCheck, /notificationTurn\?\.id/);
  assert.match(stateCheck, /notificationTurn\.id === expectedTurnId/);
  assert.match(stateCheck, /turn\.id === expectedTurnId/);
  assert.match(stateCheck, /turnStatusType\(turn\) !== "inProgress"/);
  assert.match(stateCheck, /Array\.isArray\(turn\.items\)/);
  assert.match(stateCheck, /item\?\.type === "userMessage"/);
  const runtimeStatus = app.match(/function handleThreadRuntimeStatus\(threadId, status\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(runtimeStatus, /type === "systemError"[\s\S]*?scheduleRecentTurnsRefresh/);
  assert.doesNotMatch(runtimeStatus, /type === "idle"[\s\S]*?scheduleRecentTurnsRefresh/);
  const historyLoader = app.match(/async function loadEarlierTurns\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(historyLoader, /recentTurnsParams\(threadId, cursor\)/);
  const recentRefresh = app.match(/async function refreshRecentTurns\(threadId\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(recentRefresh, /recoveryTurnsParams\(threadId\)/);
  const fork = app.match(/async function forkThread\([^]*?\n\}/)?.[0];
  assert.match(fork, /recoveryTurnsParams\(result\.thread\.id\)/);
});

test("conversation recovery reports elapsed time, pages, and approximate transfer size", () => {
  for (const id of [
    "conversationLoadProgress",
    "conversationLoadProgressLabel",
    "conversationLoadProgressDetail",
    "conversationLoadProgressTrack",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /\.conversation-load-progress \{/);
  assert.match(css, /@keyframes conversation-load-progress/);
  assert.match(html, /class="conversation-load-progress-spinner" aria-hidden="true"/);
  assert.match(css, /@keyframes conversation-load-spinner/);
  assert.match(css, /\.conversation-load-progress\[data-state="complete"\] \.conversation-load-progress-spinner/);
  assert.match(app, /function approximateUtf8ByteLength\(value\)/);
  assert.match(app, /function beginConversationLoadProgress\(label/);
  assert.match(app, /function finishConversationLoadProgress\(/);
  assert.match(app, /已接收约 \$\{formatConversationLoadKilobytes\(progress\.approxBytes\)\}/);
  assert.match(app, /details\.push\(`已等待 \$\{elapsedSeconds\} 秒`\)/);
  assert.match(app, /handleSocketMessage\(message, socketGeneration, typeof event\.data === "string"/);
  assert.match(app, /pending\.onResponseMetrics\(\{[\s\S]*?approxBytes: approximateUtf8ByteLength\(rawFrame\)/);

  const resume = app.match(/async function resumeThread\(\s*thread,[\s\S]*?\n\}\n\nfunction recentTurnsParams/)?.[0];
  assert.match(resume, /beginConversationLoadProgress\(/);
  assert.match(resume, /rpc\("thread\/resume", params, \{[\s\S]*?onResponseMetrics/);
  assert.match(resume, /hydrateThreadItemSummaries\(state\.activeThread\.id, \{ progress: loadProgress \}\)/);

  const historyLoader = app.match(/async function loadEarlierTurns\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(historyLoader, /beginConversationLoadProgress\("正在加载更早记录"/);
  assert.match(historyLoader, /pages: 1,[\s\S]*?approxBytes: responseApproxBytes/);
  assert.match(historyLoader, /await hydrateThreadItemSummaries\(threadId, \{ progress: loadProgress \}\)/);

  const itemLoader = app.match(/async function loadTurnItemsPage\([\s\S]*?\n\}/)?.[0];
  assert.match(itemLoader, /onResponseMetrics: \(\{ approxBytes \}\)/);
  assert.match(itemLoader, /loadedApproxBytes:/);
});

test("new conversations cancel stale recovery progress before marking the blank composer ready", () => {
  assert.match(app, /function cancelConversationLoadProgress\(\)/);
  assert.match(app, /function newThread\([^]*?cancelConversationLoadProgress\(\)/);
  assert.match(app, /cancelConversationLoadProgress\(\);[\s\S]*?state\.conversationReady = true;[\s\S]*?setConnection\("ready", statusText\("ready"\)\)/);
  assert.match(app, /if \(cancelled\) \{[\s\S]*?cancelConversationLoadProgress\(\)/);
});

test("thread lifecycle uses native loaded subscriptions and bounded item pagination", async () => {
  const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
  for (const method of [
    "thread/items/list",
    "thread/loaded/list",
    "thread/unsubscribe",
    "thread/metadata/update",
  ]) {
    assert.match(server, new RegExp(`"${method.replace("/", "\\/")}"`));
  }
  assert.match(app, /itemsView: "full"/);
  assert.match(app, /async function hydrateThreadItemSummaries/);
  assert.match(app, /THREAD_ITEMS_AUTO_HYDRATION_PAGE_BUDGET = 40/);
  assert.match(app, /while \(remainingPageBudget > 0\)/);
  assert.match(app, /rpc\("thread\/items\/list"/);
  assert.match(app, /normalizeThreadItemPage\(page\?\.data, "desc", turnId\)/);
  assert.match(app, /mergeLoadedItemPage\(turn\.items \|\| \[\], entries/);
  assert.match(app, /turn\._itemPageState = \{ \.\.\.pageState \}/);
  assert.match(app, /mergeRecentTurnPage\(/);
  assert.match(app, /async function loadLoadedThreads/);
  assert.match(app, /async function releaseThreadSubscription/);
  assert.match(app, /method === "thread\/status\/changed"/);
  assert.match(app, /method === "thread\/closed"/);
  assert.match(app, /reconcileThreadLifecycle\(params\.threadId, \{ closed: true \}\)/);
  assert.match(server, /browserHasThreadSubscription\(publicThreadId\)/);
  assert.match(server, /threadHasActiveWork\(publicThreadId\)/);
  assert.match(server, /CODEX_THREAD_ITEMS_RESULT_BYTES_MAX = 8 \* 1024 \* 1024/);
  assert.match(server, /app\.get\("\/api\/git\/metadata"/);
  assert.match(app, /syncActiveThreadGitMetadataFromServer/);
  assert.match(app, /Git 分支：\$\{branch\}/);
});

test("Codex Worktree branches support safe deletion, conversation rebinding, and current-branch display", () => {
  for (const id of [
    "textInputDialog",
    "textInputForm",
    "textInputDialogInput",
    "textInputDialogCancelButton",
    "textInputDialogSubmitButton",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function requestTextInput\(/);
  assert.match(app, /const branch = \(await requestTextInput\(/);
  assert.doesNotMatch(app, /const branch = prompt\(/);
  assert.match(css, /\.text-input-dialog \.form-field input \{/);
  assert.match(html, /id="chatBranchLabel"/);
  assert.match(html, /id="chatBranchMenu"[\s\S]*id="chatBranchMenuList"/);
  assert.match(app, /function canRebindActiveThreadToWorktree\(worktree\)/);
  assert.match(app, /function renderChatBranchMenu\(\)/);
  assert.match(app, /elements\.chatBranchLabel\.addEventListener\("click", toggleChatBranchMenu\)/);
  assert.match(app, /loadCodexWorktrees\(\{ force: true, all: true \}\)/);
  assert.match(app, /replaceActiveConversationThread\(resumedThread\);[\s\S]{0,120}renderProjectContext\(\)/);
  assert.match(app, /codex-worktree-rebind/);
  assert.doesNotMatch(app, /"绑定当前对话"/);
  assert.doesNotMatch(app, /"把当前对话绑定到这里"/);
  assert.match(app, /删除 Git 分支（保留恢复快照）/);
  assert.match(app, /function renderProjectContext\(\)[\s\S]*?chatBranchLabel/);
  assert.match(app, /Detached HEAD · \$\{String\(activeWorktree\.baseCommit/);
  assert.match(server, /app\.post\("\/api\/codex\/worktrees\/:id\/rebind"/);
  assert.match(server, /deleteBranch: request\.body\?\.deleteBranch === true/);
});

test("Worktree sidebar keeps its own position and treats Worktree as conversation context", () => {
  const sidebar = app.match(/function renderSidebarWorktrees\(\)[\s\S]*?\n}\n\nfunction codexWorktreeProjectForRecord/)[0];
  assert.match(sidebar, /main\.addEventListener\("click", \(\) => \{ openWorktreeFromRecord\(worktree, main\); \}\)/);
  assert.doesNotMatch(sidebar, /message-square/);
  assert.match(sidebar, /删除 Worktree（保留绑定对话和恢复快照）/);
  assert.match(sidebar, /trash-2/);
  assert.match(app, /codex-worktree-record-title/);
  assert.match(app, /titleButton\.addEventListener\("click", \(\) => \{ openWorktreeFromRecord\(worktree, titleButton\); \}\)/);
  assert.match(app, /function openWorktreeFromRecord\(worktree, trigger = null\)/);
  const opener = app.match(/async function openSidebarWorktree\(worktree\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(opener);
  assert.doesNotMatch(opener, /loadThreads\(\)/);
  assert.match(opener, /const opened = await resumeThread\(thread\)/);
  assert.match(opener, /const listedThread = state\.threads\.find/);
  assert.match(opener, /worktree,\n    \};/);
  assert.match(app, /function threadWithManagedCodexWorktree\(thread\)/);
  assert.match(app, /thread = threadWithManagedCodexWorktree\(thread\)/);
  assert.match(app, /function rebindActiveCodexWorktreeThread\(/);
  assert.match(app, /if \(result\.reboundThread\)/);
  assert.match(app, /worktree\/thread-rebound/);
  assert.match(app, /worktree\/updated/);
  assert.match(app, /worktree\/unbound/);
  assert.match(opener, /await createAndBindWorktreeConversation\(worktree\)/);
  assert.match(opener, /setThreadPaneView\("worktrees"\)/);
  assert.match(opener, /已打开此 Worktree 的对话/);
  assert.match(app, /function isUnmaterializedCodexThreadError\(error\)/);
  assert.match(app, /function activateEmptyWorktreeThread\(thread/);
  assert.match(app, /activateEmptyWorktreeThread\(thread, \{ selectionVersion \}\)/);
  assert.match(app, /thread\(\?: is\)\? not \(\?:loaded\|found\)/);
  assert.match(app, /等待发送第一条消息/);
  assert.match(app, /const SIDEBAR_VIEW_KEY = "codexDesktop\.sidebarView"/);
  assert.match(app, /sidebarView: localStorage\.getItem\(SIDEBAR_VIEW_KEY\)/);
  assert.match(app, /function restoreSidebarView\(\)/);
  assert.match(app, /openMobilePanels\(state\.sidebarView === "projects" \? "projects" : "threads", \{ persist: false \}\)/);
  assert.match(app, /localStorage\.setItem\(SIDEBAR_VIEW_KEY, nextView\)/);
  assert.match(app, /selectedWorktree\?\.threadId/);
  assert.match(app, /async function createAndBindWorktreeConversation\(worktree\)/);
  assert.match(app, /const createdThread = await createAndBindWorktreeConversation\(created\)/);
  assert.match(app, /createdThread\.worktree\.id !== created\.id/);
  assert.match(app, /if \(worktree\.threadId && deleteBranch\)/);
  assert.match(app, /async function createManagedCodexWorktreeBranch\(worktree\)/);
  assert.match(app, /async function handoffManagedCodexWorktree\(worktree\)/);
  assert.match(app, /codex-worktree-branch/);
  assert.match(app, /codex-worktree-handoff/);
  assert.match(app, /elements\.refreshThreadsButton\.hidden = showingWorktrees/);
  assert.match(html, /id="refreshWorktreesButton"[^>]*只刷新 Worktree 状态，不同步代码[^>]*>[\s\S]*刷新状态/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.worktree-pane-toolbar \.secondary-button span \{\s*display: inline;/);
  assert.match(css, /\.thread-header \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?\.thread-header \.thread-view-tabs \{[\s\S]*?width: 100%/);
  assert.match(css, /\.worktree-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.worktree-row-main \{[\s\S]*?width: 100%;[\s\S]*?cursor: pointer;/);
  assert.match(app, /function worktreeRunStatus\(worktree\)/);
  assert.match(app, /threadTaskStatuses\.get\(worktree\.threadId\)/);
  assert.match(app, /function appendWorktreePurgeActions\(actions, worktree\)/);
  const purge = app.match(
    /async function purgeManagedCodexWorktree\(worktree[\s\S]*?\n\}\n\nasync function mutateManagedCodexWorktree/,
  )?.[0];
  assert.ok(purge, "Worktree purge handler was not found");
  assert.match(purge, /window\.confirm\(/);
  assert.match(purge, /再次确认：此操作不可恢复/);
  assert.doesNotMatch(purge, /requestTextInput|(?:window\.)?prompt\s*\(/);
  assert.match(app, /再次确认：此操作不可恢复/);
  assert.match(app, /绑定对话也会一起永久删除/);
  assert.match(server, /purge \? "codex-worktree-purge" : "codex-worktree-remove"/);
  assert.match(server, /executeBrowserRpc\(runtime, "thread\/delete"/);
  assert.match(server, /store\.purge\(request\.params\.id/);
  assert.match(server, /worktree\/purged/);
  assert.match(app, /function renameManagedCodexWorktree\(worktree\)/);
  assert.match(app, /codex-worktree-rename/);
  assert.match(server, /app\.post\("\/api\/codex\/worktrees\/:id\/rename"/);
  assert.match(server, /requireCodexWorktreeStore\(runtime\)\.rename/);
  assert.match(server, /function emptyCodexWorktreeResumeResult\(/);
  assert.match(server, /codexThreadUnavailableForEmptyWorktree\(error\)/);
  assert.match(server, /function replaceMissingEmptyCodexWorktreeThread\(/);
  assert.match(server, /replaceThreadBinding\(/);
  assert.match(server, /function normalizeWorktreeThreadReference\(/);
  assert.match(server, /function rollbackEmptyCodexWorktreeThread\(/);
  assert.match(server, /unbindThread\(/);
  assert.doesNotMatch(app, /先点击当前分支并切换到其他 Worktree，再删除这个 Worktree/);
  assert.match(app, /function worktreeSyncLabel\(worktree\)/);
  assert.match(app, /function worktreeAutoAdvanceLabel\(worktree\)/);
  assert.match(app, /无法自动推进/);
  assert.match(app, /appendWorktreeAutoAdvanceBadge\(actions, worktree\)/);
  assert.match(css, /\.worktree-auto-advance-badge\[data-state="blocked"\]/);
  assert.match(sidebar, /有新代码/);
  assert.match(sidebar, /syncManagedCodexWorktree\(worktree\)/);
  assert.match(app, /async function syncManagedCodexWorktree\(worktree\)/);
  assert.match(app, /codex-worktree-sync/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.thread-header \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.thread-header \.thread-view-tabs \{[\s\S]*?width: 100%/);
});

test("Worktree actions do not use a global busy lock and backend scopes are race-safe", () => {
  const opener = app.match(/async function openSidebarWorktree\(worktree\) \{[\s\S]*?\n\}/)?.[0] || "";
  const submitter = app.match(/async function submitSidebarWorktreeForm\(event\) \{[\s\S]*?\n\}/)?.[0] || "";
  const branch = app.match(/async function createManagedCodexWorktreeBranch\(worktree\) \{[\s\S]*?\n\}/)?.[0] || "";
  const handoff = app.match(/async function handoffManagedCodexWorktree\(worktree\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(opener && submitter && branch && handoff);
  assert.doesNotMatch(opener, /conversationBusy\(\)/);
  assert.doesNotMatch(submitter, /conversationBusy\(\)/);
  assert.doesNotMatch(branch, /conversationBusy\(\)/);
  assert.doesNotMatch(handoff, /conversationBusy\(\)/);
  assert.doesNotMatch(opener, /setThreadPaneView\("threads"\)/);
  assert.doesNotMatch(opener, /loadThreads\(\)/);
  assert.match(app, /当前工程仍有集成终端命令运行[\s\S]{0,120}return false;/);
  assert.match(server, /taskScopeValues\(threadIds\)/);
  assert.match(server, /taskScopeFenceError\(message\)/);
  assert.match(server, /ERR_TASK_SCOPE_FENCED/);
  assert.match(server, /task\.workspaceMode === "worktree"/);
  assert.match(server, /method === "turn\/steer"[\s\S]*?taskScopeIsFenced/);
  assert.match(server, /worktreeId: _wflWorktreeId/);
  const restore = server.match(/app\.post\("\/api\/codex\/worktrees\/:id\/restore"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(restore, /acquireTaskScopeFence/);
});

test("Worktree task fences isolate sibling checkouts instead of locking the source project globally", () => {
  const create = server.match(/app\.post\("\/api\/codex\/worktrees"[\s\S]*?\n\}\);/)?.[0] || "";
  const sync = server.match(/app\.post\("\/api\/codex\/worktrees\/:id\/sync"[\s\S]*?\n\}\);/)?.[0] || "";
  const handoff = server.match(/app\.post\("\/api\/codex\/worktrees\/:id\/handoff"[\s\S]*?\n\}\);/)?.[0] || "";
  const restore = server.match(/app\.post\("\/api\/codex\/worktrees\/:id\/restore"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(create, /const includeUncommitted = request\.body\?\.includeUncommitted === true/);
  assert.match(create, /includeUncommitted\s*\n\s*\? runtime\.acquireTaskScopeFence/);
  assert.match(create, /: \(\) => \{\};/);
  assert.match(create, /includeUncommitted,/);
  assert.match(sync, /projectPaths: \[current\?\.worktreeProjectPath\]/);
  assert.doesNotMatch(sync, /current\?\.projectPath/);
  assert.match(handoff, /target === "local"/);
  assert.match(handoff, /\? \[current\.projectPath, current\.worktreeProjectPath\]/);
  assert.match(handoff, /: \[current\.worktreeProjectPath\]/);
  assert.doesNotMatch(restore, /current\?\.projectPath/);
});

test("mobile chat header does not duplicate the project name and keeps Worktree left of usage", () => {
  assert.match(html, /id="chatProjectLabel"[^>]*hidden/);
  assert.match(css, /\.chat-title-meta \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.chat-branch-switcher \{[\s\S]*?grid-column: 1/);
  assert.match(css, /\.thread-provider-badge \{[\s\S]*?grid-column: 2/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.chat-branch-label \{[\s\S]*?max-width: min\(260px, 52vw\)[\s\S]*?height: 18px/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.thread-provider-badge \{[\s\S]*?height: 18px/);
  assert.match(css, /\.chat-branch-switcher,[\s\S]*?\.thread-provider-badge \{[\s\S]*?align-self: center/);
});

test("the browser boot loader retries failed module startup without a stuck shell", async () => {
  const boot = await fs.readFile(new URL("../public/boot.js", import.meta.url), "utf8");
  assert.match(boot, /await import\(url\.href\)/);
  assert.match(boot, /setTimeout\(loadApplication/);
  assert.match(boot, /正在恢复连接/);
  assert.match(boot, /window\.addEventListener\("error"/);
  assert.match(boot, /window\.addEventListener\("unhandledrejection"/);
  assert.match(boot, /if \(!applicationLoaded\) showRecovery\("运行异常"\)/);
  assert.match(boot, /window\.addEventListener\("codex-desktop:fatal-error"/);
  assert.match(app, /initialize\(\)\.catch/);
  assert.match(app, /new CustomEvent\("codex-desktop:fatal-error"/);
  assert.match(boot, /href="\/rescue\/"/);
  assert.match(boot, /bootRecoveryReload/);
  assert.match(app, /await verifyReleaseAssets\(release\.version\)/);
});

test("the main window can rebuild its socket and open the independent rescue window", () => {
  assert.match(html, /href="\/rescue\/"[^>]*target="_blank"/);
  assert.match(html, /id="refreshConversationButton"/);
  assert.match(app, /refreshConversationButton\.addEventListener\("click", refreshConversation\)/);
  assert.match(app, /state\.socket = null/);
  assert.match(app, /state\.bootstrapped = false/);
  assert.match(app, /state\.activeThreadNeedsResume = true/);
  assert.match(app, /connectSocket\(\)/);
  assert.match(app, /async function waitForConversationReady\(timeoutMs = 15_000\)/);
  assert.match(app, /const refreshed = await resumeThread\(activeThread, \{ preserveExisting: true, showLoading: false \}\)/);
});

test("the main window keeps resilient task status after the conversation", () => {
  assert.match(html, /class="task-status-compact task-status-message" id="taskStatusBar"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /id="messageList"[\s\S]*id="taskStatusBar"/);
  assert.doesNotMatch(html.match(/<footer class="statusbar">[\s\S]*?<\/footer>/)?.[0] || "", /id="taskStatusBar"/);
  assert.match(html, /id="taskStatusLabel"/);
  assert.match(html, /id="taskStatusTime"/);
  assert.doesNotMatch(css, /\.task-status-message \.task-status-time\s*\{\s*display:\s*none/);
  assert.match(app, /new URLSearchParams\(\{[\s\S]*?threadId,[\s\S]*?includeThreads: "1",[\s\S]*?requestedTurnId/);
  assert.match(app, /requestedTurnId !== \(state\.activeTurnId \|\| state\.codexActiveTurnId \|\| null\)/);
  assert.match(app, /const requestedTurnId = state\.activeTurnId \|\| state\.codexActiveTurnId \|\| null/);
  assert.match(app, /authoritativeCanSend && localInProgressTurnIds\(\)\.length <= 1[\s\S]*?\(state\.activeTurnId \|\| state\.codexActiveTurnId \|\| null\)/);
  assert.match(app, /new URLSearchParams\(\{ scope: "threads", _: String\(Date\.now\(\)\) \}\)/);
  assert.match(app, /fetch\(`\/api\/task\/status\?\$\{query\}`/);
  assert.match(app, /selectionVersion !== state\.threadSelectionVersion/);
  assert.match(app, /state\.taskStatusController !== controller/);
  assert.match(app, /TASK_STATUS_FAILURE_THRESHOLD = 3/);
  assert.match(app, /scheduleTaskStatusPoll\(taskStatusPollDelay\(\)\)/);
  assert.match(app, /document\.visibilityState === "hidden"/);
  assert.match(app, /if \(!elements\.taskStatusBar\.hidden\) refreshTaskStatusVisibility\(\);/);
  assert.match(app, /completed: "已完成"/);
  assert.match(app, /waiting: "等待确认"/);
  assert.match(app, /snapshot\?\.threadId === state\.activeThread\.id/);
  assert.match(app, /elements\.taskStatusBar\.hidden = true/);
  assert.match(app, /elements\.taskStatusBar\.hidden = false/);
  assert.match(app, /status: "unavailable",\s+phase: "unavailable",\s+threadId: state\.taskStatusSnapshot\?\.threadId \|\| null/);
  assert.match(css, /\.task-status-message \{[\s\S]*width: fit-content;[\s\S]*min-height: 22px;[\s\S]*margin: -16px auto 20px max\(20px, calc\(\(100% - 900px\) \/ 2\)\);/);
  assert.match(app, /requestAnimationFrame\(scrollMessagesToBottom\)/);
  assert.doesNotMatch(app, /function reconcileActiveTurnWithTaskAuthority\(snapshot\)/);
  assert.match(app, /function codexTaskAuthorityAllowsSend\(\)/);
  assert.match(app, /function taskStatusResponseMatchesCurrentTurn\(snapshot, requestedTurnId\)/);
  assert.match(app, /snapshot\.staleTurnId.*requestedTurnId/);
  assert.match(app, /const officialTurnBusy = \(state\.activeThread\?\.turns \|\| \[\]\)/);
  assert.match(app, /Runtime task status is informational/);
  assert.match(app, /function collaborationTaskStartedAt\(thread, agents\)[\s\S]*?activeTurn\?\.startedAt[\s\S]*?agents\.startedAt \|\| null;/);
  const taskStatusVisibility = app.match(
    /function refreshTaskStatusVisibility\(\)[\s\S]*?\n}\n\nfunction visibleTaskStatusSnapshot/,
  )?.[0];
  assert.ok(taskStatusVisibility, "task status visibility renderer was not found");
  assert.doesNotMatch(taskStatusVisibility, /startedAt: Date\.now\(\)/);
  assert.match(server, /async authoritativeTaskSnapshot\(threadId/);
  const taskAuthority = server.match(
    /async authoritativeTaskSnapshot\(threadId[\s\S]*?\n  async [A-Za-z]/,
  )?.[0];
  assert.ok(taskAuthority, "authoritative task snapshot was not found");
  assert.doesNotMatch(taskAuthority, /conversationSidecar|terminalTurn|reconciledTurnIds|runtime-task-idle/);
});

test("terminal task authority fences stale history without fencing a newer Turn", () => {
  assert.match(app, /codexTerminalTaskAuthorities: new Map\(\)/);
  assert.match(app, /function rememberCodexTerminalTaskAuthority\(snapshot = \{\}/);
  assert.match(app, /function fenceCodexTurnsByTaskAuthority\(threadId, turns\)/);
  assert.match(app, /capturedTurnIds\.length === 1/);
  assert.match(app, /unresolvedCandidates\.length > 1/);
  assert.match(app, /projectionIsAmbiguous/);
  assert.match(app, /fenceCodexTurns\(merged\.turns, threadId\)/);
  assert.match(app, /void loadTaskStatus\(\{ force: true \}\)/);
  assert.match(app, /type !== "active"[\s\S]*?loadTaskStatus\(\{ force: true \}\)/);
});

test("project switches clear stale conversations before config and history catch up", () => {
  assert.match(app, /state\.conversationReady = false;[\s\S]*?state\.taskStatusSnapshot = null;/);
  assert.match(app, /state\.threadListViewKey = null;[\s\S]*?state\.threads = \[\];/);
  assert.match(app, /正在读取当前工程对话/);
  assert.match(app, /void loadThreads\(\);[\s\S]*?await loadConfig\(\)/);
  assert.match(app, /selectionVersion !== state\.threadSelectionVersion/);
});

test("project names browse an isolated conversation list without changing the active project", () => {
  const projects = app.match(/function renderProjects\(\)[\s\S]*?\n}\n\nasync function removeProject/)?.[0] || "";
  const browser = app.match(/function browseProjectThreads\(project\) \{[\s\S]*?\n}\n\nfunction renderProjects/)?.[0] || "";
  const loader = app.match(/async function loadThreads\(\) \{[\s\S]*?\n}\n\nfunction isCodexSectionPositionFilterError/)?.[0] || "";
  assert.match(projects, /browseProjectThreads\(project\)/);
  assert.doesNotMatch(projects, /button\.addEventListener\("click", \(\) => selectProject\(project\)\)/);
  assert.match(projects, /project-row-switch/);
  assert.match(projects, /selectProject\(project\)/);
  assert.match(browser, /state\.threadListProjectPath = project\.path/);
  assert.doesNotMatch(browser, /state\.currentProject\s*=/);
  assert.match(loader, /const project = threadListProject\(\)/);
  assert.match(loader, /params\.cwd = project\.path/);
  assert.match(app, /function threadListProject\(\)/);
  assert.match(app, /sidebarNewThreadButton\.addEventListener\("click", \(\) => newThread\(\{[\s\S]*?targetProject: threadListProject\(\)/);
  assert.match(app, /function renderProjectNavigationContext\(\)/);
  assert.match(app, /function newThread\(\{ cacheCurrent = true, targetProject = null \}/);
  assert.match(app, /selectProject\(targetProject\)/);
  assert.match(app, /const listProjectPath = threadListProject\(\)\?\.path \|\| null/);
  assert.match(app, /matchingProject\.path !== state\.currentProject\?\.path[\s\S]*?state\.currentProject = matchingProject[\s\S]*?state\.threadListProjectPath = matchingProject\.path/);
});

test("Codex Worktrees are filtered by their source project in every project-scoped view", () => {
  assert.match(app, /function codexWorktreeSourceProjectPath\(project\)/);
  assert.match(app, /function currentCodexWorktreeSourceProjectPath\(\)/);
  assert.match(app, /function threadListCodexWorktreeSourceProjectPath\(\)/);
  assert.match(app, /function visibleCodexWorktrees\(/);
  assert.match(app, /filter\(\(worktree\) => sameProjectPath\(worktree\?\.projectPath, sourceProjectPath\)\)/);
  const sidebar = app.match(/function renderSidebarWorktrees\(\)[\s\S]*?\n}\n\nfunction codexWorktreeProjectForRecord/)?.[0] || "";
  const manager = app.match(/function renderCodexWorktreeRecords\(\)[\s\S]*?\n}\n\nfunction worktreeRecordButton/)?.[0] || "";
  assert.match(sidebar, /const worktrees = visibleCodexWorktrees\(threadListCodexWorktreeSourceProjectPath\(\)\)/);
  assert.match(manager, /const worktrees = visibleCodexWorktrees\(currentCodexWorktreeSourceProjectPath\(\)\)/);
  assert.match(app, /function browseProjectThreads\(project\)[\s\S]*?renderSidebarWorktrees\(\)/);
  assert.match(app, /if \(project\.worktree\) return project\.sourceProjectPath/);
});

test("Codex context window defaults and 1M override use the native configuration key", () => {
  assert.match(html, /id="settingsContextWindow"/);
  assert.match(html, /<option value="1000000">1M Token<\/option>/);
  assert.doesNotMatch(html, /1050000/);
  assert.match(html, /id="settingsContextWindowHint"/);
  assert.match(app, /function renderContextWindowSetting\(\)/);
  assert.match(app, /state\.config\.model_context_window/);
  assert.match(app, /values\.model_context_window = nextContextWindow/);
  assert.match(app, /contextWindowSelection !== "__preserve__"/);
  assert.match(server, /"model_context_window"/);
  assert.match(server, /上下文窗口必须是 1-1,000,000 之间的整数/);
  assert.match(app, /const reportedWindow = positiveTokenCount\(usage\?\.modelContextWindow\)/);
  assert.match(app, /const contextWindow = reportedWindow \|\| \(threadId \? null : configuredWindow\)/);
  assert.match(app, /Codex 实际上报/);
  assert.match(app, /配置值/);
});

test("Codex context usage is invalidated after a successful model switch", () => {
  const update = app.match(/async function updateThreadSettings\([\s\S]*?\n}\n\nfunction resetClaudeRewindPreview/)?.[0] || "";
  assert.match(app, /function invalidateThreadTokenUsage\(threadId\)/);
  assert.match(update, /modelChanged/);
  assert.match(update, /invalidateThreadTokenUsage\(threadId\)/);
  assert.match(app, /updateThreadSettings\(\{ modelChanged: previousModel !== modelId \}\)/);
  assert.match(app, /updateThreadSettings\(\{ modelChanged: previousModel !== state\.selectedModel \}\)/);
});

test("an unloaded Thread resumes from the official snapshot before the composer reports ready", () => {
  assert.match(app, /async function prepareActiveThreadForSend\(\)/);
  assert.match(app, /lightweight: false/);
  assert.match(app, /state\.taskStatusSnapshot = null;[\s\S]*?setTurnBusy\(true, "正在恢复对话"\)/);
  assert.match(app, /await loadTaskStatus\(\{ force: true \}\)/);
  assert.match(app, /state\.activeThread && state\.activeThreadNeedsResume[\s\S]*?await prepareActiveThreadForSend\(\)/);
  assert.doesNotMatch(
    app.match(/const composerReady = Boolean\([\s\S]*?\n  \);/)?.[0] || "",
    /activeThreadNeedsResume/,
  );
  assert.match(app, /function commitPendingTurnRequest\(request\)/);
  assert.match(app, /function reconcilePendingTurnRequestFromTurns\(threadId, turns = \[\]\)/);
});

test("the resource explorer edits existing text files with guarded conflict-aware saves", () => {
  for (const id of [
    "resourceEditor",
    "resourceEditState",
    "resourceReloadButton",
    "resourceEditButton",
    "resourceSaveButton",
    "resourceNewFolderButton",
    "resourceNewFileButton",
    "resourceUploadButton",
    "resourceDownloadDirectoryButton",
    "resourceDownloadSelectedButton",
    "resourceTree",
    "resourceTreeSplitter",
    "resourceWorkspaceSplitter",
    "resourceSortInput",
    "resourceSortDirectionButton",
    "resourceSelectionState",
    "resourceActionDialog",
    "resourceExternalNotice",
    "resourcePreviewModeButton",
    "resourceCopyPathButton",
    "resourceLoadMoreButton",
    "resourcePreviewMarkdown",
    "resourceShell",
    "resourceCurrentDirectory",
    "resourceLargeButton",
    "resourceFullscreenButton",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /method: "PUT"/);
  assert.match(app, /"X-Codex-Desktop-Action": "resource-file-save"/);
  assert.match(app, /"X-Codex-Desktop-File-Version": data\.version/);
  assert.match(app, /confirmDiscardResourceChanges/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "s"/);
  assert.match(app, /"X-Codex-Desktop-Action": "resource-file-action"/);
  assert.match(app, /"X-Codex-Desktop-Action": "resource-file-upload"/);
  assert.match(app, /\/api\/files\/archive/);
  assert.match(app, /async function downloadSelectedResources/);
  assert.match(app, /\/api\/files\/read-chunk/);
  assert.match(app, /function renderResourceTree/);
  assert.match(app, /function sortedResourceEntries/);
  assert.match(app, /function renderResourceTextPreview/);
  assert.match(app, /resourceGitLabel/);
  assert.match(server, /RESOURCE_ARCHIVE_SELECTION_LIMIT = 100/);
  assert.match(server, /async function readResourceTextChunk/);
  assert.match(server, /function streamResourceArchive/);
  assert.match(app, /function renderResourceBreadcrumbs/);
  assert.match(app, /resourceCurrentDirectory\.textContent = currentEntry/);
  assert.match(app, /resourcePath\.scrollLeft = elements\.resourcePath\.scrollWidth/);
  assert.match(app, /rpc\("fs\/watch"/);
  assert.match(app, /rpc\("fs\/unwatch"/);
  assert.match(app, /function renderResourceMarkdown/);
  assert.match(server, /readResourcePreview/);
  assert.match(server, /resourcePreviewKind/);
  assert.match(server, /routeFileWatchChange/);
  assert.match(server, /resolveResourceTarget\(params\.project, params\.path, runtime\)/);
  assert.match(css, /\.resource-editor \{/);
  assert.match(app, /function setupResourceResizeControls\(\)/);
  assert.ok(
    app.indexOf("const RESOURCE_SPLIT_CONFIG") < app.indexOf("initialize().catch"),
    "resource split configuration must exist before eager initialization",
  );
  assert.match(app, /splitter\.setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(app, /setResourceSplitSize\(kind, current \+ \(increment \? 2 : -2\), \{ persist: true \}\)/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.resource-browser-pane \{[\s\S]*?grid-template-columns: minmax\(100px, var\(--resource-tree-size, 36%\)\) 10px minmax\(140px, 1fr\);/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.resource-tree \{[\s\S]*?grid-row: 1 \/ -1;[\s\S]*?border-right: 1px solid var\(--line\);/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.resource-row \{[\s\S]*?min-width: 0;[\s\S]*?grid-template-columns: 20px 24px minmax\(0, 1fr\) 27px;/);
  assert.match(css, /grid-template-rows: minmax\(120px, var\(--resource-browser-size, 32%\)\) 10px minmax\(0, 1fr\)/);
  assert.match(css, /\.resource-tree-splitter \{[\s\S]*?cursor: col-resize;/);
  assert.match(css, /\.resource-workspace-splitter \{[\s\S]*?cursor: row-resize;/);
  assert.match(css, /\.resource-panel\[data-large="true"\] \{/);
  assert.match(css, /\.resource-shell:fullscreen \{/);
  assert.match(app, /function toggleResourceLargeMode\(\)/);
  assert.match(app, /async function toggleResourceFullscreen\(\)/);
  assert.match(app, /elements\.resourceShell\.requestFullscreen\(\)/);
});

test("the main window reconnects promptly without retry storms", () => {
  assert.match(app, /SOCKET_CONNECT_TIMEOUT_MS = 12_000/);
  assert.match(app, /const accountSummary = loadAccount\(\{ summary: true \}\);[\s\S]*connectSocket\(\);[\s\S]*await accountSummary;/);
  assert.match(app, /Math\.min\(8_000, 1_000 \* \(1\.6 \*\* attempt\)\)/);
  assert.match(app, /window\.addEventListener\("offline", handleBrowserOffline\)/);
  assert.match(app, /window\.addEventListener\("online", handleBrowserOnline\)/);
  assert.match(app, /function handleBrowserOnline\(\)[\s\S]*?state\.socket\?\.readyState === WebSocket\.CONNECTING/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /const CLIENT_WINDOW_ID = createClientWindowId\(\)/);
  assert.match(app, /socketGeneration: 0/);
  assert.match(app, /windowId: CLIENT_WINDOW_ID,[\s\S]*generation: String\(socketGeneration\)/);
  assert.match(app, /function socketIsCurrent\(socket, socketGeneration\)/);
  assert.match(app, /pending\.socketGeneration !== socketGeneration/);
  assert.match(app, /function scheduleCodexConnectionRecovery\(payload, socketGeneration\)/);
  assert.match(app, /state\.reconnectRecoverySocketGeneration === socketGeneration[\s\S]*return state\.reconnectRecoveryPromise/);
  assert.match(app, /state\.reconnectRecoveryPromise !== recovery[\s\S]*request\.socketGeneration !== state\.socketGeneration/);
  assert.match(app, /SOCKET_CLOSE_BROWSER_OFFLINE = 4001/);
  assert.match(app, /SOCKET_CLOSE_REPLACED = 4002/);
  assert.doesNotMatch(app, /socket\.close\(1001/);
  const releaseVerifier = app.match(/async function verifyReleaseAssets\(version\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(releaseVerifier);
  assert.doesNotMatch(releaseVerifier, /rescue\.(?:html|css|js)/);
});

test("the composer uses a synchronous submission guard and rejects IME enter events", () => {
  assert.match(app, /promptSubmissionGuard: false/);
  assert.match(app, /if \(state\.promptSubmissionGuard\) return;[\s\S]*state\.promptSubmissionGuard = true/);
  assert.match(app, /finally \{[\s\S]*state\.promptSubmissionGuard = false/);
  const busySelector = app.match(/function conversationBusy\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(busySelector);
  assert.match(busySelector, /state\.runtime === "claude"[\s\S]*state\.promptSubmissionGuard/);
  assert.match(app, /compositionstart[\s\S]*promptCompositionActive = true/);
  assert.match(app, /compositionend[\s\S]*promptCompositionActive = false/);
  assert.match(app, /event\.keyCode !== 229/);
});

test("sparse terminal Turn events release the composer without clearing a newer Turn", () => {
  assert.match(app, /function inferCurrentTurnId\(params = \{\}, \{ terminal = false \} = \{\}\)[\s\S]*?localInProgressTurnIds\(\)[\s\S]*?return viableTracked\.length === 1/);
  assert.match(app, /explicitThreadId !== activeThreadId[\s\S]*?Fall[\s\S]*?through so the local authoritative Turn/);
  assert.match(app, /inferredCurrent: Boolean\(turnId\)/);
  assert.match(app, /function terminalEventCanSettleTurn\(turn, params = \{\}\)/);
  assert.match(app, /function authoritativeTrackedTurnIds\(\)/);
  assert.match(app, /function clearStaleCodexTurnPointers\(completedTurnId = null\)/);
  assert.match(app, /clearStaleCodexTurnPointers\(completedTurnId\);[\s\S]*?setTurnBusy\(conversationBusy\(\), conversationBusyLabel\(\)\)/);
  assert.match(app, /const localTurn = state\.activeThread\?\.turns\?\.find\(\(turn\) => turn\?\.id === turnId\);[\s\S]*?turnStatusType\(localTurn\) !== "inProgress"/);
  assert.match(app, /if \(state\.activeTurnId && codexTurnIdIsBusy\(state\.activeTurnId\)\) return "正在处理"/);
  assert.match(app, /state\.codexTerminalTurnIds\.has\(lifecycleContext\.turnId\)\) return;/);
});

test("slow proxy requests use bounded status polling and preserve available system data", () => {
  assert.match(app, /STATUS_REQUEST_TIMEOUT_MS = 12_000/);
  assert.match(app, /TASK_STATUS_IDLE_POLL_MS = 15_000/);
  assert.match(app, /SYSTEM_STATUS_VISIBLE_POLL_MS = 30_000/);
  assert.match(app, /SYSTEM_STATUS_HIDDEN_POLL_MS = 120_000/);
  assert.match(app, /if \(!state\.systemStatusHasData && error\.name !== "AbortError"\)/);
  assert.match(app, /\["cpu", "CPU", data\.cpuPercent\]/);
  assert.match(app, /\["memory", "内存", data\.memory\.percent\]/);
  assert.match(app, /\["disk", "磁盘", data\.disk\.percent\]/);
  assert.match(app, /Array\.isArray\(data\.disks\)/);
  assert.match(app, /disk\.label \|\| \(disk\.kind === "data" \? "数据盘"/);
  assert.match(app, /disk\.mountPoint/);
  assert.match(css, /\.system-status-data-disk::before/);
  assert.match(app, /system-status-metric system-status-\$\{name\}/);
  assert.match(app, /function cancelSystemStatusRequest\(\)/);
  assert.match(app, /baseDelay \* \(2 \*\* Math\.min\(state\.taskStatusFailures, 2\)\)/);
});

test("the main window batches streaming output and defers hidden conversation rendering", () => {
  assert.match(app, /STREAM_RENDER_INTERVAL_MS = 80/);
  assert.match(app, /scheduleStreamItemRender\(params\.turnId, item\)/);
  assert.match(app, /state\.messageItemNodes\.get\(key\)/);
  assert.match(app, /if \(item\.type === "agentMessage"\) target\.textContent/);
  assert.match(app, /document\.visibilityState === "hidden"[\s\S]*state\.deferredConversationRender = true/);
  assert.match(app, /if \(state\.deferredConversationRender\)[\s\S]*renderMessages\(true\)/);
  assert.doesNotMatch(app, /item\/agentMessage\/delta"\)[\s\S]{0,500}renderMessages\(true\)/);
  assert.doesNotMatch(app, /item\/commandExecution\/outputDelta"\)[\s\S]{0,350}renderMessages\(true\)/);
});

test("Codex transcript recovery preserves stable nodes and structured file changes", () => {
  const codexRenderer = app.slice(
    app.indexOf("function renderMessages("),
    app.indexOf("function renderClaudeMessages("),
  );
  const diffUpdate = app.slice(
    app.indexOf('if (method === "turn/diff/updated")'),
    app.indexOf('if (method === "item/plan/delta")'),
  );

  assert.match(codexRenderer, /reconcileTranscriptNodes\(descriptors\)/);
  assert.doesNotMatch(codexRenderer, /messageList\.replaceChildren\(\)/);
  assert.match(codexRenderer, /captureTranscriptScrollAnchor\(\)/);
  assert.match(codexRenderer, /restoreTranscriptScrollAnchor\(scrollAnchor\)/);
  assert.match(app, /renderTranscriptUnifiedDiff\(diff, change\.diff \|\| "", change\.path\)/);
  assert.match(conversationState, /turn\._diff = typeof params\.diff === "string"/);
  assert.doesNotMatch(diffUpdate, /protocolEvent/);
  assert.match(app, /if \(recovered && !hadSnapshot\) toast\("已恢复上次对话"\)/);
  assert.match(css, /\.transcript-details\[open\] > summary \.tool-chevron/);
  assert.match(css, /\.file-change-file > summary/);
  assert.match(css, /\.transcript-diff \.git-diff-line/);
});

test("the chat exposes a photo picker and compact thread action menu", () => {
  assert.match(html, /id="imageFileInput" type="file" accept="image\/\*"/);
  assert.match(html, /id="imageAttachmentButton"[^>]*从相册或相机上传图片/);
  assert.match(html, /id="threadMoreButton"[^>]*aria-expanded="false"/);
  assert.match(html, /id="threadActionMenu"[^>]*aria-label="对话操作"/);
  assert.match(app, /handleFileSelection\(elements\.imageFileInput\)/);
  assert.match(app, /toggleThreadActionsMenu/);
  assert.match(app, /closeThreadActionsMenu/);
  assert.match(app, /archiveThreadButton\.innerHTML = `[^`]+<span>/);
  assert.match(css, /\.thread-more-button \{\s*display: inline-grid;/);
  assert.match(css, /\.chat-actions\.menu-open \.thread-action-menu \{\s*display: grid;/);
  assert.match(app, /function appendToast\(region, message, type\)/);
  assert.match(app, /region\.childElementCount >= 3/);
  assert.match(app, /item\.dataset\.message === message/);
  assert.match(app, /function activeDialogToastRegion\(\)/);
});

test("Codex and Claude expose full-record, copy, and bounded per-message branch actions", () => {
  assert.match(html, /id="copyConversationButton"[^>]*title="复制聊天记录"/);
  assert.match(app, /async function copyConversationRecord\(\)/);
  assert.match(app, /\/api\/claude\/sessions\/\$\{encodeURIComponent\(conversation\.id\)\}\/export\?format=md/);
  assert.match(app, /\/api\/threads\/\$\{encodeURIComponent\(conversation\.id\)\}\/export\?format=md/);
  assert.match(app, /async function copyTextToClipboard\(/);
  assert.match(app, /class="message-tools"/);
  assert.match(app, /class="message-copy-button"/);
  assert.match(app, /class="message-branch-button"/);
  assert.match(app, /beforeTurnId: branchPoint\.turnId, branchDraft: branchPoint\.draft/);
  assert.match(app, /lastTurnId: branchPoint\.turnId/);
  assert.match(app, /deferGoalContinuation: true/);
  assert.match(app, /Claude 官方 CLI 暂不支持从历史消息精确分支/);
  assert.match(app, /restoreMessageBranchDraft\(branchDraft\)/);
  assert.match(css, /\.message-branch-button:disabled/);
  assert.match(css, /\.desktop\.claude-runtime \.message-copy-button:hover/);
});

test("the composer uploads pasted clipboard images and preserves text paste", () => {
  assert.match(app, /promptInput\.addEventListener\("paste", handlePromptPaste\)/);
  assert.match(app, /event\.clipboardData\?\.items/);
  assert.match(app, /item\.kind === "file" && item\.type\.startsWith\("image\/"\)/);
  assert.match(app, /if \(!images\.length\) return;\s+event\.preventDefault\(\)/);
  assert.match(app, /clipboard-\$\{timestamp\}/);
  assert.match(app, /await uploadFiles\(files\)/);
});

test("the project command group exposes files beside conversations while the drawer owns project transfer actions", () => {
  assert.match(
    html,
    /class="project-navigation-control"[\s\S]*id="projectSwitcher"[\s\S]*id="panelsButton"[\s\S]*id="resourceButton"/,
  );
  assert.match(
    html,
    /class="project-pane-actions"[\s\S]*id="importProjectButton"[\s\S]*id="downloadProjectButton"[\s\S]*id="createProjectButton"/,
  );
  assert.match(html, /id="projectRootInput"[^>]*name="rootId"/);
  assert.match(app, /projectRoots = Array\.isArray\(data\.roots\)/);
  assert.match(app, /function renderProjectRootOptions\(/);
  assert.match(app, /rootId: formData\.get\("rootId"\)/);
  assert.match(server, /publicProjectRoots\(runtime\.projectRoots, runtime\.defaultProject\)/);
  assert.match(html, /id="accountProviderButton"/);
  assert.match(html, /id="accountAddProviderButton"[^>]*hidden/);
  assert.match(html, /id="providerQuickButton"[^>]*查看供应商与账号额度/);
  assert.match(html, /id="providerQuickList"/);
  assert.match(css, /\.project-navigation-control > \.icon-button \{[\s\S]*flex: 0 0 34px/);
  assert.match(css, /\.project-pane-actions \{[\s\S]*grid-template-columns: repeat\(3/);
  assert.match(
    css,
    /@media \(max-width: 600px\)[\s\S]*\.commandbar \.provider-switcher \{[\s\S]*width: 112px;/,
  );
  assert.match(html, /id="intelligenceMenuButton"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="intelligenceEffortOptions"/);
  assert.match(html, /id="intelligenceModelOptions"/);
  assert.match(app, /intelligenceMenuButton\.addEventListener\("click", toggleIntelligenceMenu\)/);
  assert.match(app, /replace\(\/\^gpt-\/i, ""\)/);
  assert.match(app, /accountProviderButton\.addEventListener\("click"/);
  assert.match(app, /accountAddProviderButton\.addEventListener\("click"[\s\S]*await openProviderDialog\(\);[\s\S]*newProviderProfile\(\)/);
  assert.match(app, /new Option\("设置供应商", ADD_PROVIDER_OPTION\)/);
  assert.match(app, /targetId === ADD_PROVIDER_OPTION[\s\S]*await openProviderDialog\(\);[\s\S]*newProviderProfile\(\)/);
});

test("HTML navigation does not advertise archive resources to mobile download sniffers", () => {
  assert.doesNotMatch(html, /https?:\/\/[^\s"']+\.zip/i);
  assert.doesNotMatch(html, /placeholder="[^"]*\.zip/i);
  assert.match(server, /function markInlineHtmlResponse\(response, filename\)/);
  assert.match(server, /Content-Disposition", `inline; filename=/);
  assert.match(server, /X-Download-Options", "noopen"/);
});

test("mobile chrome keeps actions reachable and reveals compact labels on tap", () => {
  assert.match(html, /id="mobileActionLabel"[^>]*role="status"/);
  assert.match(html, /id="connectionPill"[^>]*role="status"[^>]*aria-label="正在连接"/);
  assert.match(html, /id="runtimeSwitcherButton"[^>]*data-connection-status="starting"/);
  assert.match(html, /class="brand-status-dot"/);
  assert.doesNotMatch(html, /id="claudeSettingsMenuItem"/);
  assert.match(html, /class="provider-switcher"[\s\S]*data-lucide="plug-zap"/);
  assert.match(html, /class="intelligence-button-icon"[^>]*data-lucide="brain-circuit"/);
  assert.match(app, /function setupMobileActionLabels\(\)/);
  assert.match(app, /document\.addEventListener\("pointerdown", handleControl, true\)/);
  assert.match(app, /document\.addEventListener\("focusin", handleControl, true\)/);
  assert.match(app, /control === elements\.runtimeSwitcherButton/);
  assert.match(app, /function toggleRuntimeMenu\(\) \{\s*hideMobileActionLabel\(\);/);
  assert.match(app, /function compactMobileVersion\(value\)/);
  assert.match(app, /versionButton\.dataset\.mobileLabel = compactMobileVersion\(UI_VERSION_LABEL\)/);
  assert.match(app, /connectionPill\.setAttribute\("aria-label", text\)/);
  assert.match(app, /runtimeSwitcherButton\.dataset\.connectionStatus = status/);
  assert.match(app, /function updateRuntimeConnectionLabel\(\)/);
  assert.match(css, /\.mobile-action-label\.visible \{[\s\S]*?opacity: 1;/);
  assert.match(css, /\.brand-switcher\[data-connection-status="ready"\] \.brand-status-dot \{\s*background: var\(--green\);/);
  assert.match(css, /\.connection-pill \{[\s\S]*?clip-path: inset\(50%\);/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.window-actions \{[\s\S]*?overflow-x: auto;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.runtime-menu \{[\s\S]*?position: fixed;[\s\S]*?z-index: 170;/);
  assert.match(css, /\.titlebar \.window-actions > \.icon-button,[\s\S]*?\.account-button \{[\s\S]*?width: 34px;/);
  assert.match(css, /\.titlebar \.window-actions > \.admin-ops-button \{[\s\S]*?width: 28px;/);
  assert.match(css, /\.window-actions #themeButton,[\s\S]*?\.window-actions #fullscreenButton \{\s*display: inline-grid;/);
  assert.doesNotMatch(css, /\.window-actions #themeButton,[\s\S]{0,100}\.window-actions #fullscreenButton \{\s*display: none;/);
  assert.match(css, /\.commandbar \.primary-button \{\s*width: 36px;/);
  assert.doesNotMatch(css, /\n  \.primary-button \{\s*width: 36px;/);
  assert.match(css, /@media \(max-width: 380px\)[\s\S]*?\.commandbar \.provider-switcher \{[\s\S]*?width: 78px;/);
  assert.match(css, /@media \(max-width: 380px\)[\s\S]*?\.intelligence-button \.intelligence-button-chevron,[\s\S]*?\.intelligence-button-icon \{\s*display: none;/);
  assert.match(css, /@media \(max-width: 380px\)[\s\S]*?\.intelligence-button \.intelligence-button-label \{\s*display: block;/);
  assert.doesNotMatch(css, /\.composer-actions \.goal-close-button \{\s*display: none;/);
  assert.match(css, /\.system-status-metric \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.system-status-memory::before \{\s*content: "内";/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.system-status-disk::before \{\s*content: "盘";/);
  assert.doesNotMatch(css, /@media \(max-width: 340px\)[\s\S]{0,200}\.system-status-primary \{\s*display: none;/);
});

test("the Codex extension center has independent touch scrolling on mobile", () => {
  assert.match(css, /\.codex-extension-shell \{[\s\S]*?min-width: 0;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.codex-extension-tabs \{[\s\S]*?overflow-x: auto;[\s\S]*?touch-action: pan-x;/);
  assert.match(css, /\.codex-extension-tabs button \{[\s\S]*?flex: 0 0 auto;[\s\S]*?scroll-snap-align: center;/);
  assert.match(css, /\.codex-extension-body \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;[\s\S]*?touch-action: pan-y;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.codex-extension-panel \{[\s\S]*?height: 100dvh;[\s\S]*?margin: 0;/);
  assert.match(app, /function centerCodexExtensionTab\(button\)/);
  assert.match(app, /tablist\.scrollTo\(\{ left: Math\.max\(0, left\), behavior: "smooth" \}\)/);
});

test("image generation uses Codex imagegen for official accounts and keeps the assigned provider path", () => {
  assert.match(app, /function codexNativeImagePrompt\(prompt\)[\s\S]*\$imagegen/);
  assert.match(app, /target\?\.active === true && target\.kind === "official"/);
  assert.match(app, /state\.capabilities\?\.imageGeneration === true/);
  assert.match(app, /return codexNativeImageGenerationAvailable\(\) \? "codex" : null/);
  assert.match(app, /imageBackend === "codex"[\s\S]*codexNativeImagePrompt\(imagePrompt\)/);
  assert.match(app, /imageBackend === "api"[\s\S]*generateImageWithApi\(imagePrompt, projectPath\)/);
  assert.match(app, /Codex 原生生图 · gpt-image-2/);
  assert.match(html, /id="imageApiProviderInput"[^>]*required/);
  assert.match(html, /id="imageApiModelInput"[^>]*list="imageApiModelPresets"[^>]*value="gpt-image-2"/);
  assert.match(html, /id="imageApiModelPresets"[\s\S]*gpt-image-2/);
  assert.match(html, /id="imageApiModelCatalogSelect"[^>]*hidden/);
  assert.match(html, /id="imageApiModelsRefreshButton"[^>]*title="查询图片供应商模型"/);
  assert.doesNotMatch(html, /id="imageApiKeyInput"/);
  assert.match(app, /fetch\("\/api\/images\/settings"/);
  assert.match(app, /"X-Codex-Desktop-Action": "image-api-save"/);
  assert.match(app, /"X-Codex-Desktop-Action": "image-api-remove"/);
  assert.match(app, /fetch\("\/api\/images\/generate"/);
  assert.match(app, /"X-Codex-Desktop-Action": "image-generate"/);
  assert.match(app, /imagePromptFromConversation\(text\)/);
  assert.match(app, /const imageRequested = Boolean\(state\.imageGenerationMode \|\| automaticImagePrompt\)/);
  assert.match(app, /if \(imageRequested && !imageBackend\)[\s\S]*loadProviderProfiles\(\)[\s\S]*imageBackend = imageGenerationBackend\(\)/);
  assert.doesNotMatch(app, /localStorage[^\n]*OPENAI_API_KEY/i);
  assert.match(app, /providerId: elements\.imageApiProviderInput\.value/);
  assert.match(app, /return state\.imageApi\.configured === true \? "api" : null;/);
  assert.match(app, /await openProviderDialog\(\);\s+selectProviderProfile\("image-api"\)/);
  assert.match(app, /管理员尚未给当前账号分配图片供应商/);
  assert.match(app, /图片已由网页配置的图片供应商生成并保存到/);
  assert.doesNotMatch(app, /catch[\s\S]{0,400}generateImageWithApi\(imagePrompt/);
});

test("generated images use a bounded preview and load the original only in an explicit dialog", () => {
  for (const id of [
    "generatedImageDialog",
    "generatedImageDialogImage",
    "generatedImageDialogStatus",
    "generatedImageDialogDownload",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function generatedImagePreviewSource\(item\)/);
  assert.match(app, /--generated-image-display-width/);
  assert.match(app, /figure\.style\.width = `\$\{displayWidth\}px`/);
  assert.match(app, /image\.style\.maxWidth = "100%"/);
  assert.match(app, /&preview=\$\{preset\}/);
  assert.match(app, /function generatedImageOriginalSource\(item\)/);
  assert.match(app, /previewButton\.addEventListener\("click", \(\) => openGeneratedImageDialog\(item\)\)/);
  assert.match(app, /image\.addEventListener\("error"[\s\S]*?image\.src = originalSource/);
  assert.match(app, /function resetGeneratedImageDialog\(\)[\s\S]*?removeAttribute\("src"\)/);
  assert.match(css, /\.generated-image-preview \{[\s\S]*?cursor: zoom-in;/);
  assert.match(css, /\.generated-image \{[\s\S]*?width: min\(100%, var\(--generated-image-display-width, 760px\)\);/);
  assert.match(css, /\.generated-image-dialog-stage img \{[\s\S]*?object-fit: contain;/);
  assert.match(server, /IMAGE_PREVIEW_GENERATION_LIMIT = 2/);
  assert.match(server, /IMAGE_PREVIEW_CACHE_LIMIT = 256/);
  assert.match(server, /"-threads", "1"/);
  assert.match(server, /webSettingsStore\.imagePreview\(\)/);
});

test("provider image generation binds its optimistic message before awaiting the image API", () => {
  const send = app.match(/async function sendPromptOnce\(\) \{[\s\S]*?\n\}/)?.[0];
  const selectThread = app.match(/async function selectThread\(thread\) \{[\s\S]*?\n\}/)?.[0];
  const newThread = app.match(/function newThread\([\s\S]*?\n\}/)?.[0];
  assert.ok(send);
  assert.ok(selectThread);
  assert.ok(newThread);
  assert.ok(send.indexOf('elements.promptInput.value = ""') < send.indexOf("await generateImageWithApi"));
  assert.ok(send.indexOf("state.pendingUserMessage = pending") < send.indexOf("await generateImageWithApi"));
  assert.match(send, /generateImageWithApi\(imagePrompt, projectPath\)/);
  assert.match(send, /imageOutputConversationAttachment\(generatedImage, "conversation"\)/);
  assert.doesNotMatch(send, /state\.attachments\.push\(directImage\)/);
  assert.match(send, /elements\.promptInput\.value = text/);
  assert.match(selectThread, /state\.imageGenerating/);
  assert.match(newThread, /state\.imageGenerating/);
  assert.match(app, /function conversationBusy\(\)[\s\S]*state\.imageGenerating/);
  assert.match(send, /beginImageTaskStatus\(\)/);
  assert.match(app, /function visibleTaskStatusSnapshot\(\)[\s\S]*state\.imageTaskStatusSnapshot/);
  assert.match(app, /phase: "imageGeneration"/);
});

test("project games open in an isolated responsive browser preview", () => {
  assert.match(html, /id="browserButton"[^>]*aria-label="预览当前工程"/);
  assert.match(html, /id="browserDialog"/);
  assert.match(html, /id="browserEntryForm"/);
  assert.match(html, /id="browserEntryDetails"/);
  assert.match(html, /id="browserEntryInput"[^>]*list="browserEntryOptions"/);
  assert.match(html, /id="browserEntryOpenButton"/);
  assert.match(html, /id="browserRefreshButton"/);
  assert.match(html, /id="browserOpenButton"/);
  assert.match(html, /id="browserCopyButton"/);
  assert.match(html, /id="browserPromptButton"[^>]*title="复制给 AI 的项目预览提示词"/);
  assert.match(html, /id="browserFullscreenButton"/);
  assert.match(html, /id="browserFrame"[\s\S]*?sandbox="allow-scripts allow-pointer-lock allow-downloads"/);
  assert.doesNotMatch(html, /id="browserFrame"[\s\S]*?sandbox="[^"]*allow-same-origin/);
  assert.match(app, /fetch\("\/api\/preview\/session"/);
  assert.match(app, /"X-Codex-Desktop-Action": "project-preview"/);
  assert.match(app, /window\.open\(state\.browserUrl, "_blank", "noopener,noreferrer"\)/);
  assert.match(app, /function automaticBrowserEntry\(entries\)/);
  assert.match(app, /copyTextToClipboard\(url, "临时预览链接已复制"/);
  assert.match(app, /PROJECT_PREVIEW_COPY_PROMPT[\s\S]*?\[打开预览\]\(game\/index\.html\)/);
  assert.match(app, /elements\.browserPromptButton\.addEventListener\("click", copyBrowserPreviewPrompt\)/);
  assert.match(app, /function copyBrowserPreviewPrompt\(\)[\s\S]*?"项目预览提示词已复制"/);
  assert.doesNotMatch(app, /wflai\.chat/i);
  assert.match(server, /developerInstructions: null/);
  assert.doesNotMatch(server, /PROJECT_PREVIEW_DEVELOPER_INSTRUCTIONS|project-preview-instructions/);
  assert.doesNotMatch(claudeRuntime, /PROJECT_PREVIEW_DEVELOPER_INSTRUCTIONS|project-preview-instructions/);
  assert.match(app, /row\.addEventListener\("dblclick"[\s\S]*?openBrowserPreview\(entry\.relativePath\)/);
  assert.match(app, /elements\.browserFrame\.src = "about:blank"/);
  assert.match(app, /function normalizeBrowserEntryPath\(value\)/);
  assert.match(app, /function renderAssistantMessageText\(container, text\)/);
  assert.match(app, /function openProjectResourceFile\(relativePath, line = null\)/);
  assert.match(css, /\.browser-panel \{[\s\S]*?width: min\(1280px/);
  assert.match(css, /\.browser-entry-details\[open\] \{[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(css, /\.browser-prompt-button \{[\s\S]*?min-height: 32px/);
  assert.match(css, /\.browser-stage iframe \{[\s\S]*?width: 100%/);
});

test("project and history panes independently support persistent desktop or compact drawer layouts", () => {
  assert.match(css, /@media \(max-width: 1200px\), \(hover: none\) and \(pointer: coarse\)/);
  assert.match(css, /@media \(min-width: 1201px\)/);
  assert.match(css, /\.workspace \{[\s\S]*?display: block;/);
  assert.match(css, /\.drawer-only \{\s*display: inline-grid;/);
  assert.match(css, /width: clamp\(236px, 30vw, 286px\)/);
  assert.match(css, /project-pane-persistent\.thread-pane-persistent[\s\S]*grid-template-columns: 300px minmax\(420px, 1fr\)/);
  assert.match(css, /project-pane-persistent\.thread-pane-persistent[\s\S]*grid-template-rows: minmax\(190px, 34%\) minmax\(0, 1fr\)/);
  assert.match(css, /\.message-avatar \{\s*display: none;/);
  assert.match(css, /\.message\.user \.message-content \{[\s\S]*justify-items: end/);
  assert.match(css, /#composerProject \{\s*display: none;/);
  assert.match(css, /\.thread-row-preview \{[\s\S]*-webkit-line-clamp: 1/);
  assert.match(html, /id="projectPanePersistentInput"/);
  assert.match(html, /id="threadPanePersistentInput"/);
  assert.match(app, /codexDesktop\.projectPanePersistent/);
  assert.match(app, /codexDesktop\.threadPanePersistent/);
  assert.match(app, /const PERSISTENT_PANE_QUERY/);
  assert.match(app, /function paneIsPersistent\(view\)/);
  assert.match(app, /toggleMobilePanels\("threads"\)/);
  assert.match(app, /toggleMobilePanels\("projects"\)/);
  assert.match(app, /sameView[\s\S]*closeMobilePanels\(\)/);
  assert.doesNotMatch(html, /id="sidebarToggleButton"/);
  assert.doesNotMatch(app, /sidebarCollapsed|toggleSidebars/);
});

test("multi-user controls are invite-only and keep host administration role-gated", async () => {
  const login = await fs.readFile(new URL("../public/login.html", import.meta.url), "utf8");
  const loginApp = await fs.readFile(new URL("../public/login.js", import.meta.url), "utf8");
  assert.match(login, /id="loginForm"/);
  assert.match(login, /data-language-toggle/);
  assert.match(login, new RegExp(`/i18n\\.js\\?v=${version.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(login, /id="(?:inviteInput|displayNameInput)"/);
  assert.match(loginApp, /const invitationToken = new URLSearchParams\(location\.search\)\.get\("invite"\)/);
  assert.match(loginApp, /\^\[A-Za-z0-9_-\]\{43\}\$/);
  assert.match(loginApp, /body\.invite = invitationToken/);
  assert.doesNotMatch(loginApp, /body\.displayName/);
  assert.match(loginApp, /\/api\/auth\/register/);
  assert.match(html, /id="multiUserSection"/);
  assert.match(html, /id="userManagementLink" href="\/users"/);
  assert.match(html, /id="downloadProjectButton"/);
  assert.match(html, /id="exportThreadButton"/);
  assert.match(app, /function isAccountAdmin\(\)/);
  assert.match(app, /\/api\/projects\/download\?project=/);
  assert.match(app, /\/api\/threads\/\$\{encodeURIComponent\(conversation\.id\)\}\/export/);
  assert.match(app, /\/api\/claude\/sessions\/\$\{encodeURIComponent\(conversation\.id\)\}\/export/);
});

test("the personal account drawer exposes quotas, permissions, and guarded profile controls", () => {
  assert.match(html, /id="accountButton"/);
  assert.match(html, /id="accountDialog"/);
  assert.match(html, /role="progressbar"[^>]*id="accountStorageProgress"/);
  assert.match(html, /id="accountTierExpiresAt"/);
  assert.match(html, /id="accountOfficialQuotaSection"[^>]*hidden/);
  assert.match(html, /id="accountOfficialLimitList"/);
  assert.match(html, /id="accountAssignedQuotaSection"[^>]*hidden/);
  assert.match(html, /官方登录[\s\S]*ChatGPT \/ Codex 额度/);
  assert.match(html, /官方登录账号，与管理员分配的 API 套餐分开统计/);
  assert.match(html, /管理员分配[\s\S]*对话 API 套餐与用量/);
  assert.match(html, /不包含官方登录账号额度/);
  assert.match(html, /id="accountTotalTokenUsage"/);
  assert.match(html, /id="accountSevenDayTokenUsage"/);
  assert.match(html, /id="accountTodayTokenUsage"/);
  assert.match(html, /id="accountFiveHourReset"/);
  assert.match(html, /id="accountWeeklyReset"/);
  assert.match(html, /id="accountMonthlyReset"/);
  assert.match(html, /id="switchAccountButton"/);
  assert.match(html, /id="accountLogoutButton"/);
  assert.match(app, /fetch\("\/api\/account", \{[\s\S]*method: "PATCH"/);
  assert.match(app, /"X-Codex-Desktop-Action": "account-profile-update"/);
  assert.match(app, /function formatResetCountdown\(timestamp\)/);
  assert.match(app, /function renderTokenStatistic\(element, usage\)/);
  assert.match(app, /\/api\/account\/official-quota\?/);
  assert.match(app, /showConversationUsage = assignedApi\?\.assigned === true \|\| user\.role === "owner"/);
  assert.match(app, /state\.accountSnapshot\.assignedApi\?\.assigned !== true && user\?\.role !== "owner"/);
  assert.match(app, /function renderAccountOfficialQuota\(\)/);
  assert.match(app, /任务中 · 缓存/);
  assert.match(app, /function accountTierExpirationLabel\(user\)/);
  assert.match(css, /\.account-panel/);
  assert.match(css, /\.account-quota-source-note/);
  assert.match(css, /\.settings-panel \{[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.modal-body,[\s\S]*?\.settings-body \{[\s\S]*?overscroll-behavior-y: contain/);
  assert.match(css, /\.admin-ops-button/);
});

test("projects can be imported from guarded tar.gz archives", () => {
  assert.match(html, /id="importProjectButton"/);
  assert.match(html, /id="projectArchiveInput"[^>]*accept="\.tar\.gz,application\/gzip,application\/x-gzip"/);
  assert.match(app, /request\.open\("POST", `\/api\/projects\/import\?name=/);
  assert.match(app, /request\.setRequestHeader\("X-Codex-Desktop-Action", "project-import"\)/);
  assert.match(app, /request\.upload\.addEventListener\("progress"/);
});
