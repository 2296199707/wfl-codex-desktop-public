import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const html = await fs.readFile(new URL("../public/ops.html", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/ops.js", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/ops.css", import.meta.url), "utf8");
const desktopApp = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const version = (await fs.readFile(new URL("../VERSION", import.meta.url), "utf8")).trim();

test("operations page registers unique and complete elements", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const registry = app.match(/const elements = Object\.fromEntries\(\[[\s\S]*?\]\.map/)?.[0];
  assert.ok(registry);
  const registeredIds = [...registry.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  for (const id of registeredIds) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
});

test("operations page is local, responsive, and uses guarded write actions", () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, /href="\/ops\.css\?v=[^"]+"/);
  assert.match(html, new RegExp(`/i18n\\.js\\?v=${version.replaceAll(".", "\\.")}`));
  assert.match(html, /data-language-toggle/);
  assert.match(html, /src="\/ops\.js\?v=[^"]+"/);
  assert.match(html, /src="\/vendor\/lucide\/lucide\.min\.js(?:\?v=[^"]+)?"/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.match(app, /fetch\(`\/api\/ops\/overview\?_=/);
  assert.match(app, /\/api\/ops\/metrics\?range=/);
  assert.match(app, /\/api\/ops\/events\?/);
  assert.match(app, /method:\s*"PUT"/);
  assert.match(app, /method:\s*"POST"/);
  assert.match(app, /method:\s*"DELETE"/);
  assert.doesNotMatch(app, /method:\s*"PATCH"/);
  assert.match(app, /action:\s*"ops-alert-settings"/);
  assert.match(app, /action:\s*"ops-webhook-test"/);
  assert.match(app, /action:\s*"ops-rollback-toggle"/);
  assert.match(app, /action:\s*"ops-rollback-prepare"/);
  assert.match(app, /action:\s*"ops-rollback-execute"/);
  assert.match(app, /action:\s*"ops-deployment-cancel"/);
  assert.match(app, /action:\s*"ops-deployment-admissions-clear"/);
  assert.match(app, /action:\s*"ops-backup-create"/);
  assert.match(app, /action:\s*"ops-backup-delete"/);
  assert.match(app, /action:\s*"ops-backup-restore-prepare"/);
  assert.match(app, /action:\s*"ops-backup-restore-execute"/);
  assert.match(app, /action:\s*"ops-workspace-export-create"/);
  assert.match(app, /setRequestHeader\("X-Codex-Desktop-Action", "ops-workspace-upload-chunk"\)/);
  assert.match(app, /action:\s*"ops-workspace-upload-inspect"/);
  assert.match(app, /action:\s*"ops-workspace-import-execute"/);
  assert.doesNotMatch(app, /ops-sidecar-prune|cleanupExpiredOutbox/);
  assert.match(app, /action:\s*"ops-web-settings"/);
  assert.match(app, /action:\s*"ops-map-render-settings"/);
  assert.match(app, /action:\s*"ops-map-render-admission"/);
  assert.match(app, /action:\s*"ops-map-render-continue"/);
  assert.match(app, /action:\s*"ops-map-render-cache-clear"/);
  assert.match(app, /action:\s*"ops-image-execution-settings"/);
  assert.match(app, /action:\s*"ops-image-execution-control"/);
  assert.match(app, /action:\s*"ops-tencent-cloud-config"/);
  assert.match(app, /action:\s*"ops-tencent-cloud-apply"/);
  assert.match(app, /MIGRATION_UPLOAD_MAX_RETRIES = 4/);
  assert.match(app, /new XMLHttpRequest\(\)/);
  assert.match(app, /state\.migrationUploadController\.abort\(\)/);
  assert.match(app, /sessionStorage\.setItem\(MIGRATION_UPLOAD_RECOVERY_KEY/);
  assert.match(app, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(app, /估算剩余/);
  assert.match(html, /id="migrationUploadProgressDetail"/);
  assert.match(html, /id="cancelMigrationUploadButton"/);
  assert.match(html, /placeholder="请手动输入上方完整编号"/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, new RegExp(`/ops\\.css\\?v=${version.replaceAll(".", "\\.")}`));
  assert.match(html, new RegExp(`/ops\\.js\\?v=${version.replaceAll(".", "\\.")}`));
});

test("operations page has dashboard, worker controls, logs, deployment, backups, Sidecar, migrations, users, events, and alerts", () => {
  for (const view of ["overview", "tasks", "map-render", "image-execution", "deployment", "backups", "sidecar", "migrations", "users", "events", "logs", "alerts"]) {
    assert.match(html, new RegExp(`data-view-panel="${view}"`));
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
  assert.match(html, /id="resourceChart"/);
  assert.match(html, /id="diskLabel"/);
  assert.match(html, /id="additionalDiskReadings"/);
  assert.match(html, /data-metric-range="24h"/);
  assert.match(app, /Array\.isArray\(resources\?\.disks\)/);
  assert.match(app, /function renderAdditionalDisks\(disks\)/);
  assert.match(app, /disk\.mountPoint/);
  assert.match(css, /\.additional-disk-readings \{ display: contents; \}/);
  assert.match(css, /\.disk-reading \.meter span \{ background: var\(--amber\); \}/);
  assert.match(html, /id="eventRows"/);
  assert.match(html, /id="alertRuleRows"/);
  assert.match(html, /id="trafficChart"/);
  assert.match(html, /id="rankingRows"/);
  assert.match(html, /id="webSettingsForm"/);
  assert.match(html, /id="imagePreviewPreset"[\s\S]*?value="minimal"[\s\S]*?value="economy"[\s\S]*?value="standard"[\s\S]*?value="clear"[\s\S]*?value="high"/);
  assert.match(html, /id="imagePreviewDisplaySize"[\s\S]*?value="auto"[\s\S]*?value="compact"[\s\S]*?value="standard"[\s\S]*?value="wide"/);
  assert.match(html, /id="tencentCloudForm"/);
  assert.match(html, /腾讯云 DNS 与证书向导/);
  assert.match(html, /id="checkTencentCloudButton"/);
  assert.match(html, /id="planTencentCloudButton"/);
  assert.match(html, /id="applyTencentCloudButton"/);
  assert.match(app, /function pollTencentCloudSetup\(setupId\)/);
  assert.match(css, /\.tencent-cloud-form/);
  assert.match(app, /\/api\/ops\/web-settings/);
  assert.match(app, /function saveWebSettings\(event\)/);
  assert.match(css, /\.web-settings-form/);
  assert.match(html, /id="mapRenderSettingsForm"/);
  assert.match(html, /id="mapRenderCpuMetric"[\s\S]*?id="mapRenderMemoryMetric"[\s\S]*?id="mapRenderLatencyMetric"[\s\S]*?id="mapRenderWorkerMetric"[\s\S]*?id="mapRenderQueueMetric"[\s\S]*?id="mapRenderPresetMetric"/);
  for (const setting of [
    "worker.enabled", "worker.renderConcurrency", "worker.screenshotConcurrency", "worker.queueLimit", "worker.memoryMb",
    "worker.taskTimeoutMs", "worker.idleRecycleMs", "cache.tileMb", "cache.imageMb",
    "preview.width", "preview.height", "preview.fps", "preview.antialias", "panorama.scale",
    "panorama.format", "tiles.width", "tiles.height", "tiles.scale", "tiles.format",
    "animation.width", "animation.height", "animation.fps", "animation.durationMs", "animation.format",
    "video.width", "video.height", "video.fps", "video.durationMs", "video.codec", "video.crf",
    "mapIo.readChunkBytes", "mapIo.saveChunkBytes", "mapIo.saveCommitConcurrency", "mapIo.maxMapBytes",
    "mapIo.autoSaveIntervalMs",
  ]) assert.match(html, new RegExp(`name="${setting.replaceAll(".", "\\.")}"`));
  assert.match(app, /MAP_RENDER_POLL_MS = 5_000/);
  assert.match(app, /expectedRevision:\s*state\.mapRenderFormRevision/);
  assert.match(app, /\/api\/ops\/map-render\/continue/);
  assert.match(app, /\/api\/ops\/map-render\/cache\/clear/);
  assert.match(css, /\.map-render-setting-grid/);
  assert.match(html, /id="imageExecutionSettingsForm"/);
  assert.match(html, /id="imageExecutionCpuMetric"[\s\S]*?id="imageExecutionMemoryMetric"[\s\S]*?id="imageExecutionLatencyMetric"[\s\S]*?id="imageExecutionWorkerMetric"[\s\S]*?id="imageExecutionQueueMetric"[\s\S]*?id="imageExecutionPresetMetric"/);
  for (const setting of [
    "worker.enabled", "worker.concurrency", "worker.queueLimit", "worker.memoryMb", "worker.taskTimeoutMs",
  ]) assert.match(html, new RegExp(`name="${setting.replaceAll(".", "\\.")}"[\\s\\S]*?data-image-execution-setting`));
  for (const preset of ["stable", "balanced", "performance", "custom"]) {
    assert.match(html, new RegExp(`data-image-execution-preset="${preset}"`));
  }
  assert.match(html, /状态指标只读，不会自动切换并发、预算或预设/);
  assert.match(app, /IMAGE_EXECUTION_POLL_MS = 5_000/);
  assert.match(app, /fetch|requestOpsJson/);
  assert.match(app, /\/api\/ops\/image-execution\?_=/);
  assert.match(app, /\/api\/ops\/image-execution\/settings/);
  assert.match(app, /body:\s*\{ config, expectedRevision: state\.imageExecutionFormRevision \}/);
  assert.match(app, /body:\s*\{ acceptNewTasks, expectedRevision \}/);
  assert.match(app, /state\.imageExecutionFormDirty[\s\S]*?state\.imageExecutionFormRevision/);
  assert.match(app, /Number\(error\?\.status\) === 409[\s\S]*?loadImageExecution\(\{ force: true, populateForm: true \}\)/);
  assert.match(css, /\.image-execution-fields/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.image-execution-fields \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /Codex 官方 Token/);
  assert.match(html, /缓存 Token/);
  assert.match(html, /推理 Token/);
  assert.match(app, /Codex 未上报/);
  assert.match(app, /user\.turns > 0/);
  assert.doesNotMatch(app, /供应商未提供/);
  assert.match(html, /id="rollbackDialog"/);
  assert.match(html, /id="cancelDeploymentButton"/);
  assert.match(html, /id="deploymentCancelDialog"/);
  assert.match(html, /id="clearAdmissionsButton"/);
  assert.match(html, /id="admissionsClearDialog"/);
  assert.match(app, /persistentAdmissions\?\.orphaned/);
  assert.match(html, /class="section-heading deployment-heading"/);
  assert.match(app, /function renderDeploymentControl\(control\)/);
  assert.match(app, /event\.submitter\?\.value === "cancel"/);
  assert.match(html, /id="setupSummary"/);
  assert.match(html, /href="\/#providers"/);
  assert.match(html, /href="\/#account"/);
  assert.match(html, /data-setup-command="access"/);
  assert.match(html, /data-setup-command="updates"/);
  assert.match(app, /function renderSetup\(setup\)/);
  assert.match(app, /navigator\.clipboard\.writeText\(command\)/);
  assert.match(css, /\.setup-list/);
  assert.match(desktopApp, /entry === "providers"/);
  assert.match(desktopApp, /entry === "account"/);
  assert.match(desktopApp, /void openProviderDialog\(\)/);
  assert.match(desktopApp, /void openAccountDialog\(\)/);
  assert.match(html, /id="backupRows"/);
  assert.match(html, /id="backupRestoreDialog"/);
  assert.match(html, /id="sidecarRows"/);
  assert.doesNotMatch(html, /sidecarPruneDialog|清理过期提交|防重复提交台账/);
  assert.match(html, /Sidecar 只保存可删除重建的历史搜索与索引数据/);
  assert.match(app, /\/api\/ops\/sidecar/);
  assert.match(app, /function renderSidecar\(data\)/);
  assert.match(html, /id="migrationProjectChoices"/);
  assert.match(html, /id="migrationPackageFile"/);
  assert.match(html, /id="migrationRecoveryKey"/);
  assert.doesNotMatch(html, /id="userRows"/);
  assert.doesNotMatch(html, /id="userPageSize"/);
  assert.match(html, /id="userManagementFrame"[^>]+data-src="\/users\?embed=ops"/);
  assert.match(app, /function ensureUserManagementFrame\(\)/);
  assert.doesNotMatch(app, /state\.userPage/);
  assert.doesNotMatch(app, /function changeUserPage/);
  assert.match(css, /\.user-management-section \{ overflow: hidden; padding: 0; \}/);
  assert.match(app, /配置读取失败/);
  assert.match(app, /data\.viewer\?\.role !== "owner"/);
  assert.match(html, /data-log-category="errors"/);
  assert.match(app, /document\.visibilityState === "hidden"/);
  assert.match(app, /REFRESH_VISIBLE_MS = 15_000/);
  assert.match(app, /REFRESH_HIDDEN_MS = 120_000/);
  assert.match(app, /OVERVIEW_TIMEOUT_MS = 15_000/);
  assert.match(app, /OVERVIEW_FAILURE_THRESHOLD = 3/);
  assert.match(app, /state\.overviewFailures >= OVERVIEW_FAILURE_THRESHOLD/);
  assert.match(app, /state\.overviewController\?\.abort\(\)/);
  assert.match(app, /requestId !== state\.overviewRequestId/);
  assert.match(app, /fetch\(`\/api\/ops\/deployments\/control\?_=/);
  assert.match(app, /DEPLOYMENT_CONTROL_ACTIVE_POLL_MS = 3_000/);
  assert.match(app, /scheduleDeploymentControlPoll/);
  assert.match(app, /Keep the last confirmed emergency control/);
  assert.match(app, /if \(!state\.deploymentControlConfirmed\) renderDeploymentControl\(deployment\.control\)/);
  assert.match(app, /function renderActiveOverviewView\(data\)/);
  assert.match(app, /if \(state\.view === "overview"\)/);
  const overviewLoader = app.match(/async function loadOverview[\s\S]*?function cancelOverviewRequest/)?.[0] || "";
  assert.doesNotMatch(overviewLoader, /loadBackups\(\)/);
});
