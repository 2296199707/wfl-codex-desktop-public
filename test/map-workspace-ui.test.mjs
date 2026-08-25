import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const [html, app, css] = await Promise.all([
  fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

const MAP_WORKSPACE_IDS = [
  "mapWorkspaceButton",
  "mapWorkspaceDialog",
  "mapWorkspaceCloseButton",
  "mapWorkspaceOpenEditorButton",
  "mapWorkspaceNewButton",
  "mapWorkspaceNewWorldButton",
  "mapWorkspaceNewTilesetButton",
  "mapWorkspaceRefreshButton",
  "mapWorkspaceProjectName",
  "mapWorkspaceProjectMeta",
  "mapWorkspaceActionState",
  "mapWorkspaceSearch",
  "mapWorkspaceKindFilter",
  "mapWorkspaceSelectionState",
  "mapWorkspaceMapList",
  "mapWorkspaceMapCount",
  "mapWorkspaceState",
  "mapWorkspaceTabs",
  "mapWorkspaceTabsCount",
  "mapNewDialog",
  "mapNewForm",
  "mapNewSubmitButton",
  "mapNewName",
  "mapNewDirectory",
  "mapNewOrientation",
  "mapNewInfinite",
  "mapNewTileset",
  "mapNewPathPreview",
  "worldNewDialog",
  "worldNewForm",
  "worldNewSubmitButton",
  "worldNewName",
  "worldNewDirectory",
  "worldNewAdjacent",
  "worldNewPathPreview",
  "tilesetNewDialog",
  "tilesetNewForm",
  "tilesetNewSubmitButton",
  "tilesetNewName",
  "tilesetNewDirectory",
  "tilesetNewDisplayName",
  "tilesetNewKind",
  "tilesetNewImageList",
  "tilesetNewPathPreview",
  "mapAiToolsToggle",
  "mapAiToolsState",
  "imageContextIsolationToggle",
  "imageContextIsolationState",
  "imageContextIsolationDetail",
  "mapGameWorkModeToggle",
  "mapGameWorkModeState",
  "mapGameWorkModeDetail",
  "mapManagedMapPath",
  "mapManagedInspectButton",
  "mapManagedApprovalPolicy",
  "mapManagedConfirm",
  "mapManagedCreateButton",
  "mapManagedList",
  "mapManagedTransferDialog",
  "mapManagedTransferTarget",
  "mapManagedTransferState",
  "cancelMapManagedTransferButton",
  "confirmMapManagedTransferButton",
];

test("main chrome exposes one responsive map workspace panel", () => {
  for (const id of MAP_WORKSPACE_IDS) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "gu")) || []).length, 1, `${id} must exist once`);
    assert.match(app, new RegExp(`["']${id}["']`, "u"));
  }
  assert.match(html, /id="mapWorkspaceButton"[^>]*aria-label="打开工具中心"/u);
  assert.match(html, /id="mapWorkspaceOpenEditorButton"[^>]*aria-label="打开游戏地图编辑器"/u);
  assert.match(html, /class="settings-panel map-workspace-panel toolbox-panel"/u);
  assert.match(html, /id="mapAiToolsToggle" type="checkbox"/u);
  assert.match(html, /id="imageContextIsolationToggle"[^>]*role="switch"/u);
  assert.match(css, /\.map-workspace-shell/u);
  assert.match(css, /\.map-workspace-resource-row/u);
  const workspaceBodyRule = css.match(/\.map-workspace-body\s*\{[^}]+\}/u)?.[0] || "";
  assert.match(workspaceBodyRule, /overflow-y:\s*auto/u);
  assert.match(workspaceBodyRule, /safe-area-inset-bottom/u);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.settings-panel \{[\s\S]*?width: 100%/u);
  assert.match(css, /\.map-workspace-panel\s*\{[\s\S]*?width:\s*min\(760px/u);
});

test("toolbox groups primary actions, filters resources, and carries selected character assets", () => {
  assert.match(html, /class="toolbox-category-tabs"[^>]*role="tablist"/u);
  assert.match(html, /class="toolbox-create-actions"[^>]*role="group"/u);
  assert.match(html, /id="mapWorkspaceActionState"[^>]*aria-live="polite"/u);
  assert.match(html, /id="mapWorkspaceKindFilter"[\s\S]*?value="character"[\s\S]*?value="image"/u);
  assert.match(html, /id="mapWorkspaceSelectionState"[^>]*role="status"/u);
  assert.match(app, /function updateMapWorkspaceKindFilter/u);
  assert.match(app, /function mapWorkspaceEntryMatchesFilter/u);
  assert.match(app, /function selectMapWorkspaceResource/u);
  assert.match(app, /state\.mapWorkspaceSelectedEntry \|\| state\.resourcePreviewEntry/u);
  assert.match(app, /entry\.kind === "character"|\["character", "image"\]/u);
  assert.match(css, /\.map-workspace-primary-actions/u);
  assert.match(css, /\.map-workspace-resource-toolbar/u);
  assert.match(css, /\.map-workspace-resource-row\[data-selected="true"\]/u);
});

test("new-map wizard preserves explicit Tiled parameters and preopens the editor window", () => {
  assert.match(html, /id="mapWorkspaceNewButton"[^>]*aria-label="新建地图"/u);
  assert.match(html, /id="mapNewOrientation"[\s\S]*?value="orthogonal"[\s\S]*?value="oblique"/u);
  assert.match(html, /id="mapNewInfinite" type="checkbox"/u);
  assert.match(html, /id="mapNewTileset"[^>]*list="mapNewTilesetOptions"/u);
  assert.match(html, /id="mapNewTargetVersion"[\s\S]*?value="1\.12\.2"/u);
  const wizard = app.slice(
    app.indexOf("function openMapNewDialog"),
    app.indexOf("async function loadMapAiToolsSetting"),
  );
  assert.match(wizard, /client\.createMap\(payload\)/u);
  assert.match(wizard, /window\.open\("\/map-editor\.html#pending", "_blank"\)/u);
  assert.ok(
    wizard.indexOf('window.open("/map-editor.html#pending", "_blank")') < wizard.indexOf("client.createMap(payload)"),
  );
  assert.match(wizard, /refreshMapWorkspaceCreatedPath\(created\)/u);
  assert.match(wizard, /openMapEditorEntry\([\s\S]*?source: "workspace", editorWindow/u);
  assert.match(css, /\.map-new-dialog/u);
  assert.match(css, /\.map-new-four-grid\[data-infinite="true"\]/u);
});

test("map workspace opens a project session with paginated tree and bounded search", () => {
  const list = app.slice(
    app.indexOf("async function loadMapWorkspaceProject"),
    app.indexOf("async function loadMapAiToolsSetting"),
  );
  assert.match(app, /MapProjectWorkspaceClient/u);
  assert.match(list, /client\.open\(\{ project: project\.path, projectFile \}\)/u);
  assert.match(list, /client\.tree\(\{/u);
  assert.match(list, /client\.search\(\{ query/u);
  assert.match(list, /entry\.kind === "directory"/u);
  assert.match(list, /entry\.kind === "map"/u);
  assert.match(list, /entry\.kind === "world"/u);
  assert.match(list, /entry\.kind === "project"/u);
  assert.doesNotMatch(list, /\/api\/files\/search/u);
  const open = app.slice(
    app.indexOf("async function openMapEditorEntry"),
    app.indexOf("async function loadBrowserPreviewEntries"),
  );
  assert.match(open, /window\.open\("\/map-editor\.html#pending", "_blank"\)/u);
  assert.match(open, /fetch(?:WithTimeout)?\("\/api\/maps\/sessions"/u);
  assert.match(open, /"X-Codex-Desktop-Action": "map-session-open"/u);
  assert.match(open, /mapOpenPayload\(relativePath, editorInstanceId\)/u);
  assert.match(open, /threadId && state\.mapAiToolsEnabled \? \{ connect: "1" \}/u);
  assert.match(open, /state\.account\?\.id \? \{ account: state\.account\.id \}/u);
  assert.match(open, /state\.runtime !== "codex"/u);
});

test("World resources create and open through dedicated World sessions", () => {
  assert.match(html, /id="mapWorkspaceNewWorldButton"[^>]*aria-label="新建 World"/u);
  assert.match(html, /id="worldNewDialog"/u);
  assert.match(app, /client\.createWorld\(\{/u);
  assert.match(app, /worldOpenPayload\(entry\.path, editorInstanceId\)/u);
  assert.match(app, /fetch(?:WithTimeout)?\("\/api\/map-worlds\/sessions"/u);
  assert.match(app, /"X-Codex-Desktop-Action": "map-world-session-open"/u);
  assert.match(app, /editorWindow\.location\.replace\(`\/world-editor\.html#/u);
});

test("tileset resources create and open through dedicated TSJ sessions", () => {
  assert.match(html, /id="mapWorkspaceNewTilesetButton"[^>]*aria-label="新建瓦片集"/u);
  assert.match(html, /id="tilesetNewDialog"/u);
  assert.match(html, /id="tilesetNewKind"[\s\S]*?value="atlas"[\s\S]*?value="collection"/u);
  assert.match(app, /client\.createTileset\(payload\)/u);
  assert.match(app, /tilesetOpenPayload\(entry\.path, editorInstanceId\)/u);
  assert.match(app, /fetch(?:WithTimeout)?\("\/api\/map-tilesets\/sessions"/u);
  assert.match(app, /"X-Codex-Desktop-Action": "map-tileset-session-open"/u);
  assert.match(app, /editorWindow\.location\.replace\(`\/tileset-editor\.html#/u);
  assert.match(app, /entry\.kind === "tileset"/u);
  assert.match(css, /\.tileset-new-image-list/u);
});

test("map workspace and editor share project-scoped multi-window tabs", () => {
  assert.match(app, /createMapEditorTabSignal/u);
  assert.match(app, /parseMapEditorTabSignal/u);
  assert.match(app, /function broadcastMapEditorTabSnapshot/u);
  assert.match(app, /function requestMapEditorTabClose/u);
  assert.match(app, /state\.mapEditorRecentTabs = loadMapEditorRecentTabs\(\)/u);
  assert.match(css, /\.map-workspace-tab\[data-dirty="true"\]/u);
  assert.match(app, /mapWorkspaceOpenEditorButton.*openMapWorkspaceEditor|openMapWorkspaceEditor\(\)/u);
});

test("project workspace client keeps public resource paths project-relative", async () => {
  const client = await fs.readFile(new URL("../public/map-project-session.js", import.meta.url), "utf8");
  assert.match(client, /path must be project-relative/u);
  assert.match(client, /\/api\/map-projects\/sessions/u);
  assert.match(client, /map-project-session-open/u);
  assert.match(client, /map-project-session-close/u);
  assert.doesNotMatch(client, /projectPath\s*:/u);
});

test("account map AI toggle uses the explicit opt-in contract", () => {
  const settings = app.slice(
    app.indexOf("async function loadMapAiToolsSetting"),
    app.indexOf("const MAP_MANAGED_POLICY_LABELS"),
  );
  assert.match(settings, /fetchWithTimeout\("\/api\/account\/map-ai"/u);
  assert.match(settings, /fetch\("\/api\/account\/map-ai", \{/u);
  assert.match(settings, /method: "PUT"/u);
  assert.match(settings, /"X-Codex-Desktop-Action": "map-ai-setting"/u);
  assert.match(settings, /JSON\.stringify\(\{ enabled \}\)/u);
  assert.doesNotMatch(settings, /leaseId|projectPath|editorInstanceId/u);
  assert.match(settings, /const requestAccountId = state\.account\?\.id \|\| null/u);
  assert.match(settings, /state\.mapAiToolsRequestAccountId === requestAccountId/u);
  assert.match(settings, /if \(state\.account\?\.id !== requestAccountId\) return false/u);
  assert.match(settings, /if \(state\.account\?\.id !== requestAccountId\) return/u);
});

test("main map workspace exposes explicit headless managed authorization without opening the editor", () => {
  assert.match(html, /AI 托管授权/u);
  assert.match(html, /读取版本/u);
  assert.match(html, /每条询问/u);
  assert.match(html, /AI 审查/u);
  assert.match(html, /完全授权/u);
  assert.match(html, /我确认当前工程和设计资源范围/u);
  assert.match(app, /async function inspectMapManagedPath/u);
  assert.match(app, /async function loadMapManagedAuthorizations/u);
  assert.match(app, /async function createMapManagedAuthorization/u);
  assert.match(app, /map-ai-managed-authorization-create/u);
  assert.match(app, /map-ai-managed-authorization-revoke/u);
  assert.match(app, /mapVersion: state\.mapManagedMapVersion/u);
  assert.match(app, /userConfirmed: true/u);
  assert.match(app, /fingerprintForManagedProject/u);
  assert.match(app, /function mapManagedContextSnapshot/u);
  assert.match(app, /requestVersion !== state\.mapManagedRequestVersion/u);
  assert.match(app, /mapManagedContextIsCurrent\(context\)/u);
  assert.match(css, /\.map-managed-access-block/u);
  assert.match(app, /list_map_revisions/u);
  assert.match(app, /restore_map_revision/u);
});

test("main managed authorization transfer is same-project, optimistic, and switches the active Thread", () => {
  assert.match(html, /id="mapManagedTransferDialog"[\s\S]*?id="mapManagedTransferTarget"[\s\S]*?id="confirmMapManagedTransferButton"/u);
  const transfer = app.slice(
    app.indexOf("function mapManagedTransferCandidates"),
    app.indexOf("function renderMapManagedAccess"),
  );
  assert.match(transfer, /thread\.cwd === state\.currentProject\?\.path/u);
  assert.match(transfer, /expectedThreadId: authorization\.threadId/u);
  assert.match(transfer, /Number\(error\.status\) === 409/u);
  assert.match(transfer, /await selectThread\(targetThread\)/u);
  assert.match(transfer, /转交冲突/u);
  assert.match(app, /error\.status = response\.status/u);
  assert.match(app, /error\.code = data\?\.code \|\| null/u);
  assert.match(css, /\.map-managed-item-actions[\s\S]*?flex-wrap: wrap/u);
  assert.match(css, /\.map-managed-transfer-dialog/u);
});

test("main-page account changes reset map workspace, conversation mirrors, leases, and stale AI requests", () => {
  const accountChange = app.slice(
    app.indexOf("if (previousAccountId && previousAccountId !== data.user?.id)"),
    app.indexOf("} else if (storedThreadRecovery)"),
  );
  assert.match(accountChange, /state\.mapWorkspaceLoadId \+= 1/u);
  assert.match(accountChange, /state\.mapWorkspaceClient = null/u);
  assert.match(accountChange, /state\.imageContextLedger\.clear\(\)/u);
  assert.match(accountChange, /state\.gameWorkModeLeases\.clear\(\)/u);
  assert.match(accountChange, /state\.mapEditorGameBindings\.clear\(\)/u);
  assert.match(accountChange, /state\.worldEditorWindows\.clear\(\)/u);
  assert.match(accountChange, /state\.tilesetEditorWindows\.clear\(\)/u);
  assert.match(accountChange, /state\.mapConversationOperations\.clear\(\)/u);
  assert.match(accountChange, /state\.mapConversationImageDeliveries\.clear\(\)/u);
  assert.match(accountChange, /state\.mapAiToolsRequest = null/u);
  assert.match(accountChange, /state\.mapAiToolsRequestAccountId = null/u);
  assert.match(accountChange, /state\.mapAiToolsEnabled = false/u);
  assert.match(accountChange, /resetMapWorkspaceView\(\)/u);
  assert.match(accountChange, /previousMapWorkspaceClient\?\.close/u);
});
