import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, script, css, versionSource] = await Promise.all([
  fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/map-editor/map-editor.css", import.meta.url), "utf8"),
  fs.readFile(new URL("../VERSION", import.meta.url), "utf8"),
]);
const assetVersion = versionSource.trim();

const AI_ELEMENT_IDS = [
  "mapAiConnectionState",
  "mapAiThreadState",
  "connectMapAiButton",
  "disconnectMapAiButton",
  "refreshMapAiProposalsButton",
  "mapAiProposalList",
  "mapAiProposalState",
  "mapAiManagedApprovalPolicy",
  "mapAiManagedConfirm",
  "mapAiManagedProject",
  "createMapAiManagedAuthorizationButton",
  "mapAiManagedAuthorizationList",
  "refreshMapAiManagedAuthorizationsButton",
  "managedAuthorizationConfirmDialog",
  "confirmManagedAuthorizationRevokeButton",
  "managedAuthorizationTransferDialog",
  "managedAuthorizationTransferTarget",
  "confirmManagedAuthorizationTransferButton",
];

test("map editor renders an explicit opt-in proposal inbox without replacing manual patches", () => {
  for (const id of AI_ELEMENT_IDS) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(script, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(html, /默认关闭/u);
  assert.match(html, /不会读取图片像素、自动应用补丁或保存地图/u);
  assert.match(html, /id="aiPatchSource"/u);
  assert.match(html, /id="copyAiPromptButton"/u);
  assert.match(css, /\.map-ai-proposal-list/u);
  assert.match(script, new RegExp(`from "\\./map-ai-proposals\\.js\\?v=${assetVersion}"`, "u"));
});

test("map editor exposes a guarded revision history and restore flow", () => {
  for (const id of ["revisionsButton", "revisionDialog", "revisionList", "revisionRestoreConfirm", "confirmRevisionRestoreButton"]) {
    assert.equal((html.match(new RegExp(`id=[\"']${id}[\"']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(script, new RegExp(`[\"']${id}[\"']`, "u"));
  }
  assert.match(script, /\/api\/maps\/sessions\/.*revisions/u);
  assert.match(script, /confirmation: true/u);
  assert.match(script, /当前窗口有未保存编辑/u);
  assert.match(html, /我确认用此修订生成新的当前地图版本/u);
  assert.match(css, /\.map-revision-list/u);
});

test("map AI bearer remains tab-scoped and never enters prompt tool context", () => {
  assert.match(script, /sessionStorage\.setItem\(MAP_AI_LEASE_STORAGE_KEY/u);
  assert.doesNotMatch(script, /localStorage[^\n]*MAP_AI_LEASE_STORAGE_KEY/u);
  const copyPrompt = script.slice(
    script.indexOf("async function copyAiEditPrompt"),
    script.indexOf("function previewAiPatch"),
  );
  assert.match(copyPrompt, /const toolContext = mapAiLeaseMatchesCurrentState\(\)/u);
  assert.match(copyPrompt, /\.\.\.\(toolContext \? \{ toolContext \} : \{\}\)/u);
  assert.match(copyPrompt, /threadId: state\.credentials\.threadId/u);
  assert.match(copyPrompt, /mapSessionId: state\.session\.id/u);
  assert.match(copyPrompt, /editorInstanceId: state\.credentials\.editorInstanceId/u);
  assert.match(copyPrompt, /editorStateId: state\.editor\.headStateId/u);
  assert.doesNotMatch(copyPrompt, /leaseId|leaseToken|projectPath|token:/u);
});

test("headless managed authorization is explicit, scoped, and visibly separate from the editor lease", () => {
  assert.match(html, /AI 托管授权（可关闭编辑器继续运行）/u);
  assert.match(html, /与上面的编辑器协作授权完全分开/u);
  assert.match(html, /每条询问/u);
  assert.match(html, /AI 审查/u);
  assert.match(html, /完全授权/u);
  assert.match(html, /我确认以上范围/u);
  assert.match(script, /async function loadMapAiManagedAuthorizations/u);
  assert.match(script, /async function createMapAiManagedAuthorization/u);
  assert.match(script, /map-ai-managed-authorization-create/u);
  assert.match(script, /map-ai-managed-authorization-revoke/u);
  assert.doesNotMatch(script, /window\.confirm\("撤销后/u);
  assert.match(script, /confirmRevokeMapAiManagedAuthorization/u);
  assert.match(script, /mapVersion: state\.session\.version/u);
  assert.match(script, /userConfirmed: true/u);
  assert.match(script, /list_map_revisions/u);
  assert.match(script, /restore_map_revision/u);
  assert.match(html, /固定风险规则/u);
  assert.match(css, /\.map-ai-managed-access/u);
});

test("managed authorization exposes an owner-scoped audit action and dialog", () => {
  assert.match(html, /managedAuthorizationAuditDialog/u);
  assert.match(html, /managedAuthorizationAuditList/u);
  assert.match(script, /managed-authorizations\/.*\/audit/u);
  assert.match(script, /showManagedAuthorizationAudit/u);
});

test("managed authorization exposes explicit same-project Thread transfer with an optimistic guard", () => {
  assert.match(html, /转交 AI 托管授权/u);
  assert.match(html, /目标 Thread 必须属于同一工程/u);
  assert.match(script, /async function confirmTransferMapAiManagedAuthorization/u);
  assert.match(script, /map-ai-managed-authorization-transfer/u);
  assert.match(script, /expectedThreadId: authorization\.threadId/u);
  assert.match(script, /switchMapConversationThread\(\)/u);
  assert.match(script, /转交冲突/u);
  assert.match(script, /旧 Thread 任务已停止/u);
  assert.match(css, /\.managed-authorization-transfer-dialog/u);
  const transfer = script.slice(
    script.indexOf("async function confirmTransferMapAiManagedAuthorization"),
    script.indexOf("function renderMapAiManagedAuthorizations"),
  );
  assert.match(transfer, /const queued = await switchMapConversationThread\(\)/u);
  assert.match(transfer, /queued\s*\?\s*"托管授权已转交/u);
  assert.doesNotMatch(transfer, /(?:^|\n)\s*switchMapConversationThread\(\);/u);
});

test("managed event recovery applies snapshots before bounded event replay", () => {
  const sync = script.slice(
    script.indexOf("async function syncManagedMapAiTaskEvents"),
    script.indexOf("function scheduleManagedMapAiTaskPolling"),
  );
  assert.match(sync, /response\?\.snapshotRequired && response\.snapshot/u);
  assert.match(sync, /state\.managedTasks\[index\] = snapshot/u);
  assert.match(sync, /const incoming = Array\.isArray\(response\?\.events\)/u);
  assert.match(sync, /slice\(-80\)/u);
  assert.match(sync, /const maxPages = 8/u);
  assert.match(sync, /after >= latest/u);
  assert.match(sync, /managedTaskEventSyncGenerations/u);
  assert.match(sync, /const isCurrentGeneration = \(\) =>/u);
  assert.match(sync, /if \(!isCurrentGeneration\(\)\) return;/u);
  assert.match(sync, /const pageLimit = 500;\n    const maxPages = 8;\n    let pageCount = 0;/u);
});

test("collaboration policy offers explicit quick marking without replacing the server policy editor", () => {
  assert.match(html, /data-collaboration-quick-target="human"/u);
  assert.match(html, /data-collaboration-quick-target="locked"/u);
  assert.match(script, /appendCollaborationQuickTarget\(button\.dataset\.collaborationQuickTarget\)/u);
  assert.match(script, /kind: "region"/u);
  assert.match(script, /kind: "object"/u);
  assert.match(script, /kind: "layer"/u);
  assert.match(script, /点击“保存协同策略”后生效/u);
  assert.match(script, /collaborationOwnershipForLayer/u);
  assert.match(script, /layer-collaboration-badge/u);
  assert.match(css, /\.map-ai-policy-quick-actions/u);
  assert.match(css, /\.layer-row\[data-collaboration-ownership\]/u);
});

test("collaboration policy conflicts reload the server snapshot without auto-merging or retrying", () => {
  const save = script.slice(
    script.indexOf("async function saveMapAiCollaborationPolicy"),
    script.indexOf("async function connectMapAiLease"),
  );
  assert.match(save, /Number\(error\.status\) === 409/u);
  assert.match(save, /loadMapAiCollaborationPolicy\(\{ silent: true \}\)/u);
  assert.match(save, /mapAiProposalPrepared\.clear\(\)/u);
  assert.match(save, /不会自动合并|请确认后再次编辑/u);
  assert.equal((save.match(/saveMapAiCollaborationPolicy\(\);/gu) || []).length, 0);
});

test("main-page auto-connect is one-shot and never persists as a tab credential", () => {
  const credentials = script.slice(
    script.indexOf("function mapSessionCredentials"),
    script.indexOf("async function fetchMapSession"),
  );
  assert.match(credentials, /fragment\.get\("connect"\) === "1"/u);
  assert.match(credentials, /state\.mapAiAutoConnectRequested/u);
  assert.doesNotMatch(credentials, /credentials\s*=\s*\{[^}]*connect/su);
  assert.match(credentials, /history\.replaceState/u);
  const initialize = script.slice(
    script.indexOf("async function initializeMapAiIntegration"),
    script.indexOf("async function connectMapAiLease"),
  );
  assert.match(initialize, /const autoConnectRequested = state\.mapAiAutoConnectRequested/u);
  assert.match(initialize, /state\.mapAiAutoConnectRequested = false/u);
  assert.match(initialize, /autoConnectRequested[\s\S]*await connectMapAiLease\(\)/u);
});

test("visible connected editors poll for proposals without applying or saving them", () => {
  assert.match(script, /const MAP_AI_PROPOSAL_POLL_MS = 1_500/u);
  assert.match(script, /document\.addEventListener\("visibilitychange"/u);
  assert.match(script, /document\.visibilityState === "visible"[\s\S]*scheduleMapAiProposalPolling/u);
  const poll = script.slice(
    script.indexOf("function scheduleMapAiProposalPolling"),
    script.indexOf("function stopMapAiProposalPolling"),
  );
  assert.match(poll, /loadMapAiProposals\(\{ silent: true, announceNew: true \}\)/u);
  assert.match(poll, /MAP_AI_PROPOSAL_POLL_MS/u);
  assert.doesNotMatch(poll, /applyMapAiProposal|applyProposal|saveMap\(/u);
  const load = script.slice(
    script.indexOf("async function loadMapAiProposals"),
    script.indexOf("function currentMapAiProposalCompatibility"),
  );
  assert.match(load, /reconcileMapAiProposalPreviews\(previous, proposals\)/u);
  assert.match(load, /before\.updatedAt !== after\.updatedAt/u);
  assert.doesNotMatch(load, /mapAiProposalPrepared\.clear\(\)/u);
  assert.match(script, /stopMapAiProposalPolling\(\)[\s\S]*state\.mapAiLease = null/u);
});

test("proposal apply is local-first, retry-safe, and a successful save invalidates the lease", () => {
  assert.match(script, /state\.mapAiProposalAdapter\.applyProposal/u);
  assert.match(script, /state\.mapAiAppliedPendingAck\.set\(proposal\.id/u);
  assert.match(script, /await acknowledgeAppliedMapAiProposal\(proposal/u);
  assert.match(script, /retry\.textContent = "重试确认"/u);
  assert.match(script, /state\.mapAiProposalClient\.setEditorState\(pending\.previousEditorStateId\)/u);
  assert.match(script, /提案已应用到撤销栈，尚未保存地图/u);
  assert.match(script, /旧地图 AI 授权已撤销，如需继续协作请重新连接/u);
  assert.doesNotMatch(
    script.slice(script.indexOf("async function applyMapAiProposal"), script.indexOf("async function discardMapAiProposal")),
    /saveMap\(/u,
  );
  const saveBody = script.slice(script.indexOf("async function saveMap"), script.indexOf("function showAiPatchDialog"));
  assert.match(saveBody, /state\.mapAiAppliedPendingAck\.clear\(\)/u);
  assert.match(saveBody, /clearMapAiLeaseLocal\(\)/u);
  assert.match(saveBody, /旧授权已由服务端撤销/u);
});

test("a normal local edit schedules revocation of a stale map AI lease", () => {
  assert.match(script, /scheduleMapAiLeaseInvalidationAfterEdit/u);
  assert.match(script, /mapAiAppliedPendingAck\.size > 0/u);
  assert.match(script, /clearMapAiLeaseLocal\(\)/u);
  assert.match(script, /本地编辑状态已变化，旧地图 AI 授权已撤销/u);
  assert.match(script, /revokeMapAiLeaseWithUiRetry/u);
  assert.match(script, /正在进行有限重试/u);
  assert.match(script, /短期授权会自动过期/u);
});

test("session close is sent only after an explicit three-way close choice or a non-reload pagehide", () => {
  assert.match(script, /window\.addEventListener\("beforeunload"/u);
  assert.match(script, /window\.addEventListener\("pagehide", \(event\) => \{[\s\S]*?flushMapEditorViewState\(\);\s*if \(!event\.persisted && !state\.keepMapSessionOnPagehide\) closeMapSessionKeepalive\(\);\s*else shutdownGameWorkMode\(\)/u);
  assert.match(script, /if \(event\.navigationType === "reload"\) state\.keepMapSessionOnPagehide = true/u);
  assert.match(script, /function reloadMapEditor\(\) \{\s*state\.keepMapSessionOnPagehide = true;\s*location\.reload\(\)/u);
  const explicitClose = script.slice(script.indexOf("function closeMapEditor"), script.indexOf("function closeMapSessionKeepalive"));
  assert.match(explicitClose, /state\.editor\?\.dirty/u);
  assert.match(explicitClose, /mapCloseDialog\.showModal\(\)/u);
  assert.match(explicitClose, /async function saveAndCloseMapEditor/u);
  assert.match(explicitClose, /function cancelMapEditorClose/u);
  assert.match(explicitClose, /function finalizeMapEditorClose/u);
  assert.doesNotMatch(explicitClose, /window\.confirm/u);
  const keepaliveClose = script.slice(script.indexOf("function closeMapSessionKeepalive"), script.indexOf("function mapSessionCredentials"));
  assert.match(keepaliveClose, /method: "DELETE"/u);
  assert.match(keepaliveClose, /keepalive: true/u);
  assert.match(keepaliveClose, /"X-Codex-Desktop-Action": "map-session-close"/u);
  assert.match(keepaliveClose, /"X-Codex-Desktop-Editor-Instance"/u);
});

test("map view restoration is account and map scoped without persisting leases", () => {
  assert.match(script, /from "\.\/map-editor-view-state\.js/u);
  assert.match(script, /fragment\.get\("account"\)/u);
  assert.match(script, /localStorage\.getItem\(mapEditorViewStorageKey\(scope\)\)/u);
  assert.match(script, /localStorage\.setItem\(mapEditorViewStorageKey\(scope\), JSON\.stringify\(view\)\)/u);
  const flush = script.slice(script.indexOf("function flushMapEditorViewState"), script.indexOf("function layerIcon"));
  assert.match(flush, /state\.viewer\.renderView\(\)/u);
  assert.doesNotMatch(flush, /lease|token|sessionId|threadId/u);
});

test("account changes clear map pixels, image URLs, editor state, and collaboration state before closing", () => {
  assert.match(script, /createMapAccountSessionGuard/u);
  assert.match(script, /if \(!state\.credentials\.accountId\) \{\s*throw new Error/u);
  const invalidation = script.slice(
    script.indexOf("function invalidateMapEditorAccountSession"),
    script.indexOf("function accountSessionEndedNotice"),
  );
  assert.match(invalidation, /closeMapSessionKeepalive\(\)/u);
  assert.match(invalidation, /URL\.revokeObjectURL/u);
  assert.match(invalidation, /mapImageBoundaryController\?\.destroy/u);
  assert.match(invalidation, /releaseCrossProjectSourceSession/u);
  assert.match(invalidation, /viewer\?\.destroy/u);
  assert.match(invalidation, /guideController\?\.destroy/u);
  assert.match(invalidation, /state\.editor = null/u);
  assert.match(invalidation, /state\.document = null/u);
  assert.match(invalidation, /mapCanvasHost\.replaceChildren/u);
  assert.match(invalidation, /document\.body\.replaceChildren/u);
});
