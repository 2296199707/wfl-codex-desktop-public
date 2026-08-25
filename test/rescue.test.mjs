import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const html = await fs.readFile(new URL("../public/rescue.html", import.meta.url), "utf8");
const script = await fs.readFile(new URL("../public/rescue.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/rescue.css", import.meta.url), "utf8");
const server = await fs.readFile(new URL("../server.mjs", import.meta.url), "utf8");
const versionSync = await fs.readFile(new URL("../scripts/sync-version.mjs", import.meta.url), "utf8");
const rescueUnit = await fs.readFile(new URL("../systemd/wfl-codex-desktop-rescue@.service.template", import.meta.url), "utf8");

test("the rescue controller keeps strict mode active", () => {
  assert.match(script, /^\(\(\) => \{\n  "use strict";/);
});

test("the rescue window has unique IDs and every registered element exists", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const registry = script.match(/const ids = \[[\s\S]*?\];/)?.[0];
  assert.ok(registry, "rescue element registry was not found");
  for (const [, id] of registry.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)) {
    assert.match(html, new RegExp(`id="${id}"`), `missing rescue #${id}`);
  }
});

test("the rescue window stays independent from main application bundles", () => {
  assert.doesNotMatch(html, /(?:app|boot|thread-state)\.js|styles\.css/);
  assert.match(html, /src="\/rescue\/assets\/rescue\.js\?v=1\.1\.16"/);
  assert.match(html, /\/rescue\/assets\/i18n\.js\?v=\d+\.\d+\.\d+(?:-beta)?/);
  assert.doesNotMatch(versionSync, /rescue\.html|rescueHtml/);
  assert.match(html, /data-language-toggle/);
  assert.match(html, /href="\/rescue\/assets\/rescue\.css\?v=1\.1\.16"/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
});

test("the fixed rescue service reports the component version shipped in its own source", () => {
  assert.doesNotMatch(rescueUnit, /CODEX_DESKTOP_RESCUE_VERSION=/);
  assert.match(server, /process\.env\.CODEX_DESKTOP_RESCUE_VERSION \|\| RESCUE_COMPONENT_VERSION/);
  assert.match(rescueUnit, /Environment=PORT=%i/);
  assert.match(rescueUnit, /ExecStart=.*\/rescue-slots\/%i\/server\.mjs/);
});

test("the frozen rescue runtime does not initialize or accept Windows Host state", () => {
  assert.match(server, /const windowsDeviceStore = RESCUE_MODE \? null : await new WindowsDeviceStore/);
  assert.match(server, /const windowsCreatorJobStore = RESCUE_MODE \? null : await new WindowsCreatorJobStore/);
  assert.match(server, /if \(RESCUE_MODE \|\| !windowsDeviceBroker \|\| !host \|\| requestUrl\.search\) \{/);
  assert.match(server, /if \(RESCUE_MODE \|\| !windowsDeviceStore\) throw httpError\(404, "Windows Host 配对不可用"\)/);
});

test("the frozen rescue runtime never parses the main plugin store", () => {
  assert.match(server, /const pluginStore = RESCUE_MODE\s*\? createRescuePluginStore\(\)/);
  assert.match(server, /import \{ createRescuePluginStore \} from "\.\/lib\/rescue-plugin-store\.mjs"/);
  assert.match(rescueUnit, /StartLimitIntervalSec=120s/);
  assert.match(rescueUnit, /StartLimitBurst=5/);
  assert.match(rescueUnit, /Restart=on-failure/);
  assert.doesNotMatch(rescueUnit, /Restart=always|StartLimitIntervalSec=0/);
});

test("the frozen rescue runtime does not initialize Tencent DNS or certificate state", () => {
  assert.match(server, /const tencentCloudCredentialStore = RESCUE_MODE\s*\? null/);
  assert.match(server, /const tencentCloudSetupStore = RESCUE_MODE\s*\? null/);
  assert.match(server, /if \(!tencentCloudCredentialStore \|\| !tencentCloudSetupStore\) throw httpError\(404, "救援窗口不提供腾讯云 DNS 配置"\)/);
});

test("the rescue runtime settles provider routing before accepting browser recovery", () => {
  assert.match(server, /if \(CODEX_ENABLED && RESCUE_MODE\) \{[\s\S]*?await this\.bridge\.start\(\);[\s\S]*?await this\.reconcileRescueProvider\(\);/);
  assert.match(server, /async forceRescueBridgeRestart\(reason/);
  assert.match(server, /if \(RESCUE_MODE\) \{[\s\S]*?forceRescueBridgeRestart\(/);
  assert.match(script, /rejectPendingRpc\("Codex 服务连接中断", true, socketGeneration, true\)/);
  assert.match(script, /if \(!error\.recoverable\) toast\(error\.message, "error"\)/);
  assert.match(script, /state\.activeToastKeys\.has\(key\)/);
});

test("the rescue runtime starts an unmaterialized thread without forcing resume", () => {
  assert.match(server, /async ensureRescueThreadLoadedForTurn\(publicThreadId, params = \{\}, modelProvider = null\)/);
  assert.match(server, /await runtime\.ensureRescueThreadLoadedForTurn\(\s*publicThreadId,\s*bridgeParams,\s*rescueModelProvider,\s*\)/);
  assert.match(server, /codexRolloutMissing\(error\)[\s\S]*?return null/);
  const turnStart = server.slice(
    server.indexOf('if (method === "turn/start")'),
    server.indexOf('if (method === "thread/compact/start")'),
  );
  assert.doesNotMatch(turnStart, /if \(RESCUE_MODE && rescueModelProvider\)[\s\S]*?thread\/resume/);
});

test("the rescue runtime accepts only the shared legacy owner session in single-user mode", () => {
  assert.match(server, /function legacySessionCanAuthenticate\(request\)/);
  assert.equal((server.match(/if \(!multiUserEnabled && legacySessionCanAuthenticate\(request\)\)/g) || []).length, 2);
  assert.match(server, /return RESCUE_MODE[\s\S]*?hasSessionCookie\(request\.headers\.cookie\)[\s\S]*?!AUTH \|\| hasSessionCookie/);
});

test("the rescue controller supports recovery, conversations, providers, and approvals", () => {
  for (const method of ["thread/list", "thread/resume", "thread/turns/list", "thread/start", "turn/start", "turn/interrupt", "model/list"]) {
    assert.match(script, new RegExp(method.replace("/", "\\/")));
  }
  assert.match(script, /excludeTurns: true/);
  assert.match(script, /RECENT_TURNS_SHOWN = 8/);
  assert.doesNotMatch(script, /includeTurns: true/);
  assert.match(script, /refreshConnection/);
  assert.match(script, /API_BASE = "\/rescue\/api"/);
  assert.match(script, /\$\{API_BASE\}\/providers/);
  assert.match(script, /location\.host}\/rescue\/ws/);
  assert.match(script, /windowId: CLIENT_WINDOW_ID/);
  assert.match(script, /generation: String\(socketGeneration\)/);
  assert.match(script, /function socketIsCurrent/);
  assert.match(script, /applyCodexRuntimeStatus/);
  assert.match(script, /state\.bootstrapped && runtimeStatus\.sameEpoch/);
  assert.match(script, /state\.threadListReady = false;[\s\S]*?updateTurnState\(\);[\s\S]*?connectSocket\(\)/);
  assert.match(script, /elements\.newProjectButton\.addEventListener\("click", openProjectDialog\)/);
  assert.match(script, /elements\.projectNameInput\.focus\(\)/);
  assert.match(script, /const snapshot = state\.taskStatusSnapshot;[\s\S]*?snapshot\?\.threadId[\s\S]*?activeThreadId[\s\S]*?snapshot\.threadId === activeThreadId[\s\S]*?snapshot\.status/);
  assert.doesNotMatch(script, /state\.taskStatusSnapshot\?\.threadId === state\.activeThread\?\.id[\s\S]*?state\.taskStatusSnapshot\.status/);
  assert.match(html, /pattern="\[A-Za-z0-9\]\[A-Za-z0-9\.\_\\-\]\{0,63\}"/);
  assert.match(script, /projectContextVersion: 0/);
  assert.match(script, /function projectContextIsCurrent\(context\)/);
  assert.match(script, /state\.bootstrapGeneration \+= 1/);
  assert.match(script, /async function initializeSelectedProject\(context\)/);
  assert.match(script, /void loadThreads\(\{ context \}\)/);
  assert.match(script, /state\.threadHistoryCursor = result\.initialTurnsPage\?\.nextCursor \|\| null/);
  assert.match(script, /async function loadEarlierTurns/);
  assert.match(script, /function reconcileMessageNodes/);
  assert.match(script, /transcriptExpansion/);
  assert.match(script, /promptSubmissionGuard/);
  assert.match(script, /async function loadRescueReferences/);
  assert.match(script, /rescue\/main\/references/);
  assert.match(script, /rescue\/references/);
  assert.match(script, /referenceIds: \[\.\.\.state\.selectedReferenceIds\]/);
  assert.doesNotMatch(script, /codexDesktop\.rescue\.ownedThreads\.v1/);
  assert.doesNotMatch(script, /当前打开的是主站对话/);
  assert.doesNotMatch(script, /if \(!approved \|\| !\(await forkActiveThread/);
  assert.doesNotMatch(script, /rememberOwnedThread/);
  assert.match(script, /type: "serverResponse"/);
  assert.match(script, /providerKey\.value = ""/);
  assert.doesNotMatch(script, /providerKey\.value = provider\./);
  assert.match(html, /id="providerStatus"/);
  assert.match(html, /备用窗口使用独立加密的 API 供应商配置/);
  assert.match(script, /modelProvider: state\.currentProviderId \|\| undefined/);
  assert.match(html, /初始模型（可选）/);
  assert.match(html, /id="providerModel"(?![^>]*required)[^>]*placeholder="留空后在主页选择"/);
  assert.match(html, /id="deploymentRescueButton"/);
  assert.match(html, /id="deploymentRescueDialog"/);
  assert.match(script, /\$\{API_BASE\}\/ops\/deployments\/control/);
  assert.match(script, /"X-Codex-Desktop-Action": "ops-deployment-cancel"/);
  assert.match(script, /"X-Codex-Desktop-Action": "ops-deployment-admissions-clear"/);
  assert.match(script, /scheduleDeploymentControlPoll/);
  assert.doesNotMatch(script, /if \(!state\.account\) await loadAccount\(\)/);
  assert.ok(script.indexOf("void loadDeploymentControl()") < script.indexOf("Promise.all([loadAccount()"));
  assert.match(script, /if \(response\.status === 401\) return/);
  assert.match(script, /if \(response\.status === 403\)/);
  assert.doesNotMatch(script, /\[401, 403\]\.includes\(response\.status\)/);
  assert.match(script, /Keep the last confirmed emergency control usable/);
  assert.match(html, /id="deploymentRescueConfirm" type="submit"/);
  assert.match(html, /id="admissionRescueButton"/);
  assert.match(html, /id="admissionRescueDialog"/);
  assert.match(html, /id="rescueUpdateButton"/);
  assert.match(html, /id="rescueUpdateDialog"/);
  assert.match(html, /强制更新：[\s\S]*运行中的任务可能中断并丢失/);
  assert.match(html, /id="mainTasksButton"/);
  assert.match(html, /id="mainTasksDialog"/);
  assert.match(script, /\$\{API_BASE\}\/rescue\/main\/tasks\?_/);
  assert.match(script, /"X-Codex-Desktop-Action": "rescue-main-task-interrupt"/);
  assert.match(server, /RESCUE_MAIN_CONTROL_PREFIX = "\/internal\/rescue-control"/);
  assert.match(server, /assertRescueMainControlRequest/);
  assert.match(server, /sandbox: "danger-full-access"/);
  assert.match(server, /approvalPolicy: "never"/);
  assert.match(html, /id="snapshotNotice"[^>]*role="status"[^>]*hidden/);
  assert.match(script, /\$\{API_BASE\}\/rescue\/component/);
  assert.match(script, /"X-Codex-Desktop-Action": "rescue-component-update"/);
  assert.match(script, /_wflThreadLeaseOwnerId: THREAD_LEASE_OWNER_ID/);
  assert.match(script, /RESCUE_REFERENCE_MARKER/);
  assert.match(script, /function rescueUserMessage/);
  assert.match(script, /userMessage\?\.createdAt/);
  assert.match(script, /function uuidV7Identifier/);
  assert.match(script, /orderTurnsChronologically\(\[\.\.\.byId\.values\(\)\]\)\.turns/);
  assert.match(script, /state\.activeThread\.turns = orderTurnsChronologically\(state\.activeThread\.turns\)\.turns/);
  assert.match(html, /id="referenceButton"/);
  assert.match(html, /class="button-label">任务控制<\/span>/);
  assert.match(html, /id="referencesDialog"/);
  assert.match(html, /id="newProjectButton"/);
  assert.match(html, /class="rescue-project-pane"/);
  assert.match(html, /class="rescue-new-project-button"/);
  assert.doesNotMatch(html, /class="project-picker"/);
  assert.match(html, /id="rescueTasksList"/);
  assert.match(script, /task\/status\?scope=threads/);
  assert.match(script, /function interruptRescueTask/);
  assert.match(script, /task\.status === "queued"/);
  assert.match(server, /processGroup: RESCUE_MODE/);
  assert.match(server, /detached: this\.processGroup/);
  assert.match(server, /terminateChildProcess\(child, "SIGTERM", \{ processGroup: this\.processGroup \}\)/);
  assert.match(script, /codexDesktop\.rescue\.activeThread\.v1/);
  assert.doesNotMatch(script, /localStorage\.(?:getItem|setItem)\("codexDesktop\.activeThread"/);
  assert.match(script, /applySnapshotMode\(result\.rescueSnapshot\)/);
  assert.match(script, /最后有效聊天快照为只读/);
  assert.match(script, /Creating a filesystem project is an HTTP-side operation/);
  assert.match(script, /persistentAdmissions\?\.orphaned/);
  assert.match(script, /function selectCurrentProject\(project, \{ persist = true \} = \{\}\) \{[\s\S]*?state\.activeThread = null;[\s\S]*?state\.snapshotFallback = false;/);
  assert.match(script, /state\.threadListLoadVersion \+= 1;[\s\S]*?state\.taskStatusController\?\.abort\(\)/);
  assert.match(server, /await current\.store\.publishToLocal\(current\.worktree\.id\)/);
  assert.doesNotMatch(server, /await current\.store\.handoff\(current\.worktree\.id, "local"\);[\s\S]*?await current\.store\.handoff\(current\.worktree\.id, "worktree"\)/);
  assert.match(html, /class="composer-wrap" id="composerWrap"/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /\.chat-pane[\s\S]*?overflow: hidden/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /\.main-tasks-dialog/);
  assert.match(css, /\.main-task-stop/);
});

test("the rescue window preserves compact conversation timestamps", () => {
  assert.match(script, /<time hidden><\/time>/);
  assert.match(script, /pendingCreatedAt/);
  assert.match(script, /_displayCreatedAt: incoming\._displayCreatedAt \?\?/);
  assert.match(css, /\.message-label time/);
});

test("the rescue window independently reports compact resilient task status", () => {
  assert.match(html, /class="task-status-compact" id="taskStatusBar"[^>]*role="status"/);
  assert.match(html, /id="taskStatusLabel"/);
  assert.match(script, /const query = new URLSearchParams\(\{[\s\S]*?threadId,[\s\S]*?_:[\s\S]*?Date\.now\(\)/);
  assert.match(script, /fetch\(`\$\{API_BASE\}\/task\/status\?\$\{query\}/);
  assert.match(script, /TASK_STATUS_FAILURE_THRESHOLD = 3/);
  assert.match(script, /TASK_STATUS_REQUEST_TIMEOUT_MS = 12_000/);
  assert.match(script, /function rescueTaskStatusResponseMatchesCurrentTurn\(snapshot, requestedTurnId\)/);
  assert.match(script, /snapshot\.staleTurnId.*requestedTurnId/);
  assert.match(script, /projectContextVersion !== state\.projectContextVersion/);
  assert.match(script, /\(state\.activeTurnId \|\| null\) !== requestedTurnId/);
  assert.match(script, /baseDelay \* \(2 \*\* Math\.min\(state\.taskStatusFailures, 2\)\)/);
  assert.match(script, /scheduleTaskStatusPoll\(taskStatusPollDelay\(\)\)/);
  assert.match(script, /completed: "任务已完成"/);
});

test("the rescue composer fences stale history and keeps the fixed-slot controls wired", () => {
  assert.match(script, /terminalTaskAuthorities: new Map\(\)/);
  assert.match(script, /function rememberRescueTerminalTaskAuthority\(snapshot = \{\}/);
  assert.match(script, /function fenceRescueTurnsByTaskAuthority\(threadId, turns\)/);
  assert.match(script, /currentTurnIds\.length === 1/);
  assert.match(script, /projectionIsAmbiguous/);
  assert.match(script, /void loadTaskStatus\(\{ force: true \}\)/);
  assert.match(script, /state\.terminalTaskAuthorities\.delete\(request\.params\.threadId\)/);
  assert.match(html, /id="newProjectButton"/);
  assert.match(html, /id="worktreeEnsureButton"/);
  assert.match(html, /id="worktreeDiffButton"/);
  assert.match(html, /id="worktreeCheckButton"/);
  assert.equal((html.match(/id="worktreeDiffButton"/g) || []).length, 1);
});

test("the rescue window safely confirms interrupted sends", () => {
  assert.match(script, /state\.pendingTurnRequest = \{\s*params,\s*text,\s*createdAt:/);
  assert.match(script, /state\.pendingClientId = clientMessageId/);
  assert.match(script, /retryPendingTurnRequest\(\)/);
  assert.match(script, /error\.deliveryUnknown/);
  assert.match(script, /本条消息将在恢复后安全确认/);
});

test("the rescue window settles sparse terminal events and keeps references read-only", () => {
  assert.match(script, /function inferCurrentTurnId\(params = \{\}, \{ terminal = false \} = \{\}\)[\s\S]*?localInProgressTurnIds\(\)[\s\S]*?return viableTracked\.length === 1/);
  assert.match(script, /explicitThreadId !== activeThreadId[\s\S]*?Keep\n\s*\/\/ resolving below/);
  assert.match(script, /function terminalEventCanSettleTurn\(turn, params = \{\}\)/);
  assert.match(script, /function authoritativeTrackedTurnIds\(\)/);
  assert.match(script, /function clearStaleTurnPointer\(completedTurnId = null\)/);
  assert.match(script, /clearStaleTurnPointer\(completedTurnId\);[\s\S]*?setBusy\(false, "就绪"\)/);
  assert.match(script, /Array\.isArray\(item\?\.content\) \? item\.content/);
  assert.match(script, /\["user", "userMessage"\]\.includes\(item\.type\)/);
  assert.match(server, /exportContentText\(item\.content\)/);
  assert.match(server, /\["assistant", "agentMessage"\]\.includes\(item\.type\)/);
  assert.match(script, /state\.terminalTurnIds\.has\(lifecycleContext\.turnId\)/);
  assert.match(script, /state\.activeTurnId \|\| null/);
});
