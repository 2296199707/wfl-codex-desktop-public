const REFRESH_VISIBLE_MS = 15_000;

function interfaceLocale() {
  return window.WFLI18n?.getLanguage?.() === "en" ? "en-US" : "zh-CN";
}

function setDataContent(element, value, protectedContent = true) {
  element.toggleAttribute("data-i18n-ignore", protectedContent);
  element.textContent = value;
  return element;
}
const REFRESH_HIDDEN_MS = 120_000;
const OVERVIEW_TIMEOUT_MS = 15_000;
const OVERVIEW_FAILURE_THRESHOLD = 3;
const DEPLOYMENT_CONTROL_ACTIVE_POLL_MS = 3_000;
const DEPLOYMENT_CONTROL_IDLE_POLL_MS = 15_000;
const DEPLOYMENT_CONTROL_HIDDEN_POLL_MS = 60_000;
const DEPLOYMENT_CONTROL_TIMEOUT_MS = 8_000;
const MAP_RENDER_POLL_MS = 5_000;
const MAP_RENDER_HIDDEN_POLL_MS = 60_000;
const MAP_RENDER_TIMEOUT_MS = 8_000;
const IMAGE_EXECUTION_POLL_MS = 5_000;
const IMAGE_EXECUTION_HIDDEN_POLL_MS = 60_000;
const IMAGE_EXECUTION_TIMEOUT_MS = 8_000;
const ACTIVE_TASK_STATES = new Set(["running", "waiting", "stopping"]);
const MIGRATION_UPLOAD_RECOVERY_KEY = "codexDesktop.workspaceMigrationUpload.v1";
const MIGRATION_UPLOAD_MAX_RETRIES = 4;
const MIGRATION_UPLOAD_RETRY_BASE_MS = 400;
const restoredMigrationUpload = loadMigrationUploadRecovery();

const elements = Object.fromEntries([
  "liveState", "liveStateLabel", "observedAt", "refreshButton", "themeButton", "errorBanner", "errorMessage",
  "taskTabCount", "userTabCount", "eventTabCount", "alertTabCount", "overallMetric", "activeTaskMetric", "clientMetric", "activeUserMetric",
  "serviceSummary", "gatewayService", "gatewayPrimary", "gatewaySecondary", "backendService", "backendPrimary",
  "backendSecondary", "codexService", "codexPrimary", "codexSecondary", "providerService", "providerPrimary",
  "providerSecondary", "metricRangeControl", "cpuValue", "cpuMeter", "memoryValue", "memoryDetail", "memoryMeter",
  "diskLabel", "diskValue", "diskDetail", "diskMeter", "additionalDiskReadings", "resourceChart", "taskSummary", "taskRows", "taskEmpty",
  "runningVersion", "sourceVersion", "remoteVersion", "codexVersion", "releaseDetail", "releaseStatus",
  "appUpdateDetail", "appUpdateStatus", "codexUpdateDetail", "codexUpdateStatus", "totalUserMetric",
  "cancelDeploymentButton", "deploymentCancelDialog", "deploymentCancelForm", "deploymentCancelSummary",
  "deploymentCancelPassword", "executeDeploymentCancelButton", "deploymentCancelStatus", "clearAdmissionsButton",
  "admissionsClearDialog", "admissionsClearForm", "admissionsClearSummary", "admissionsClearPassword",
  "admissionsClearConfirmation", "executeAdmissionsClearButton", "admissionsClearStatus",
  "setupSummary", "setupPasswordDetail", "setupPasswordStatus", "setupAuthorizationDetail",
  "setupAuthorizationStatus", "setupAccessDetail", "setupAccessStatus", "setupUpdatesDetail", "setupUpdatesStatus",
  "publicOriginStatus", "publicOriginForm", "publicOriginInput", "previewBaseDomainInput", "previewSlotCountInput", "previewIsolationInput",
  "confirmPublicOriginButton", "disablePublicOriginButton", "publicOriginCandidates", "publicOriginFormStatus",
  "tencentCloudStatus", "tencentCloudForm", "tencentSecretIdInput", "tencentSecretKeyInput", "tencentRegionInput",
  "tencentZoneDomainInput", "tencentTargetTypeInput", "tencentTargetInput", "tencentCertificateEmailInput",
  "tencentManagePublicOriginInput", "tencentReplaceExistingInput", "saveTencentCloudButton", "checkTencentCloudButton",
  "planTencentCloudButton", "applyTencentCloudButton", "clearTencentCloudButton", "tencentCloudFormStatus", "tencentCloudOutput",
  "enabledUserMetric", "disabledUserMetric", "quotaMetric", "userManagementFrame", "footerVersion", "refreshSchedule",
  "eventCountMetric", "criticalEventMetric", "warningEventMetric", "latestEventMetric", "eventSeverityFilter",
  "eventSourceFilter", "eventRows", "eventEmpty", "loadMoreEventsButton", "activeAlertMetric", "enabledAlertMetric",
  "webhookMetric", "alertRuleMetric", "activeAlertSummary", "activeAlertRows", "activeAlertEmpty", "alertSettingsForm",
  "alertRuleRows", "webhookStatus", "webhookUrl", "testWebhookButton", "removeWebhookButton", "saveAlertSettingsButton",
  "alertSettingsStatus",
  "healthRing", "healthScore", "healthLabel", "healthDeductions", "trafficSummary", "trafficChart",
  "networkRxValue", "networkTxValue", "rankingSummary", "rankingRows", "rankingEmpty",
  "webSettingsForm", "imagePreviewPreset", "imagePreviewDisplaySize", "webSettingsStatus", "saveWebSettingsButton",
  "rollbackDetail", "rollbackStatus", "rollbackEnabled", "rollbackEnabledLabel", "rollbackVersion",
  "openRollbackButton", "rollbackPanelStatus", "logCategoryControl", "logRows", "logEmpty", "loadMoreLogsButton",
  "rollbackDialog", "rollbackForm", "rollbackStepOne", "rollbackStepTwo", "rollbackTargetLabel",
  "rollbackTypedVersion", "rollbackContinueButton", "rollbackPassword", "rollbackBackButton", "executeRollbackButton",
  "rollbackDialogStatus",
  "backupsTab", "backupTabCount", "backupCountMetric", "backupSizeMetric", "latestBackupMetric",
  "backupScheduleMetric", "exportRecoveryKeyButton", "createBackupButton", "backupSettingsForm",
  "backupScheduleEnabled", "backupInterval", "backupRetention", "backupSettingsPassword",
  "saveBackupSettingsButton", "backupOperationStatus", "backupListSummary", "backupRows", "backupEmpty",
  "backupRestoreStatus", "backupRestoreDetail", "backupRestoreTime", "backupActionDialog", "backupActionForm",
  "backupActionTitle", "backupActionSummary", "backupActionPassword", "executeBackupActionButton",
  "backupActionError", "backupRestoreDialog", "backupRestoreForm", "backupRestoreStepOne", "backupRestoreStepTwo",
  "backupRestoreTypedId", "backupRestorePassword", "prepareBackupRestoreButton", "backupRestoreConfirmation",
  "backBackupRestoreButton", "executeBackupRestoreButton", "backupRestoreError",
  "migrationsTab", "migrationTabCount", "migrationProjectMetric", "migrationExportMetric", "migrationUploadMetric",
  "migrationImportMetric", "migrationSelectionSummary", "migrationExportForm", "migrationProjectChoices",
  "migrationIncludeGit", "migrationIncludeEnv", "migrationExportPassword", "createMigrationButton",
  "migrationOperationStatus", "migrationExportSummary", "migrationExportRows", "migrationExportEmpty",
  "migrationUploadSummary", "migrationUploadForm", "migrationPackageFile", "migrationRecoveryKey",
  "migrationImportPassword", "uploadMigrationButton", "inspectMigrationButton", "migrationUploadProgress",
  "migrationUploadProgressTrack", "migrationUploadProgressDetail", "cancelMigrationUploadButton",
  "migrationImportStatus", "migrationPreview", "migrationPreviewTitle", "migrationPreviewDetail",
  "migrationPlanRows", "migrationTypedId", "executeMigrationButton", "migrationUploadRows", "migrationUploadEmpty",
  "sidecarTab", "sidecarTabCount", "sidecarSizeMetric", "sidecarEventMetric", "sidecarHistoryMetric",
  "sidecarWorkerMetric", "sidecarModeStatus", "refreshSidecarButton",
  "sidecarRows", "sidecarEmpty", "sidecarOperationStatus",
  "mapRenderTabCount", "mapRenderCpuMetric", "mapRenderMemoryMetric", "mapRenderLatencyMetric",
  "mapRenderWorkerMetric", "mapRenderQueueMetric", "mapRenderPresetMetric", "mapRenderControlStatus",
  "pauseMapRenderButton", "continueMapRenderButton", "clearMapRenderCacheButton", "mapRenderSettingsRevision",
  "mapRenderOperationStatus", "mapRenderSettingsForm", "mapRenderSettingsStatus", "saveMapRenderSettingsButton",
  "imageExecutionTabCount", "imageExecutionCpuMetric", "imageExecutionMemoryMetric", "imageExecutionLatencyMetric",
  "imageExecutionWorkerMetric", "imageExecutionQueueMetric", "imageExecutionPresetMetric", "imageExecutionControlStatus",
  "pauseImageExecutionButton", "continueImageExecutionButton", "imageExecutionSettingsRevision",
  "imageExecutionOperationStatus", "imageExecutionSettingsForm", "imageExecutionSettingsStatus",
  "saveImageExecutionSettingsButton",
].map((id) => [id, document.getElementById(id)]));

const state = {
  data: null,
  timer: null,
  loading: false,
  overviewController: null,
  overviewRequestId: 0,
  overviewFailures: 0,
  view: "overview",
  metricRange: "1h",
  metricSamples: [],
  metricRetentionSeconds: 3600,
  events: [],
  eventsLoaded: false,
  eventsHasMore: true,
  alertFormDirty: false,
  logCategory: "api",
  logs: [],
  logsLoaded: false,
  logsHasMore: true,
  rollback: null,
  rollbackNonce: null,
  backups: null,
  backupAction: null,
  backupRestoreId: null,
  backupRestoreNonce: null,
  migrations: null,
  migrationUploadId: restoredMigrationUpload?.uploadId || null,
  migrationUploadClientId: restoredMigrationUpload?.clientUploadId || null,
  migrationFileFingerprint: restoredMigrationUpload?.fileFingerprint || null,
  migrationFileSelectionVersion: 0,
  migrationUploadController: null,
  migrationUploadActive: false,
  migrationUploadCancelled: false,
  migrationUploadMetrics: null,
  migrationInspection: null,
  migrationLoading: false,
  migrationPollTimer: null,
  deploymentControl: null,
  deploymentControlConfirmed: false,
  deploymentControlPending: false,
  deploymentControlTimer: null,
  deploymentControlController: null,
  deploymentControlRequestId: 0,
  sidecar: null,
  sidecarLoading: false,
  webSettings: null,
  webSettingsLoading: false,
  publicOriginLoading: false,
  tencentCloudLoading: false,
  tencentCloudConfigured: false,
  mapRender: null,
  mapRenderLoading: false,
  mapRenderMutation: false,
  mapRenderFormDirty: false,
  mapRenderFormRevision: null,
  mapRenderTimer: null,
  mapRenderController: null,
  mapRenderRequestId: 0,
  imageExecution: null,
  imageExecutionLoading: false,
  imageExecutionMutation: false,
  imageExecutionFormDirty: false,
  imageExecutionFormRevision: null,
  imageExecutionTimer: null,
  imageExecutionController: null,
  imageExecutionRequestId: 0,
};

initialize();

function initialize() {
  applyStoredTheme();
  bindEvents();
  selectView(location.hash.slice(1) || "overview");
  window.lucide?.createIcons();
  void loadDeploymentControl();
  void loadWebSettings();
  void loadMapRender({ populateForm: true });
  void loadImageExecution({ populateForm: true });
  loadOverview();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", async () => {
    await Promise.all([
      loadOverview({ force: true }),
      loadDeploymentControl({ force: true }),
    ]);
    if (state.view === "events") await loadEvents({ reset: true });
    if (state.view === "logs") await loadLogs({ reset: true });
    if (state.view === "deployment") await loadRollback();
    if (state.view === "deployment") await loadPublicOrigin();
    if (state.view === "deployment") await loadTencentCloud();
    if (state.view === "backups") await loadBackups();
    if (state.view === "sidecar") await loadSidecar();
    if (state.view === "migrations") await loadMigrations();
    if (state.view === "map-render") await loadMapRender({ force: true, populateForm: !state.mapRenderFormDirty });
    if (state.view === "image-execution") await loadImageExecution({ force: true, populateForm: !state.imageExecutionFormDirty });
    if (state.view === "overview") await loadWebSettings();
  });
  elements.themeButton.addEventListener("click", toggleTheme);
  elements.userManagementFrame.addEventListener("load", syncUserManagementTheme);
  document.querySelectorAll("[data-setup-command]").forEach((button) => {
    button.addEventListener("click", () => copySetupCommand(button));
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => selectView(button.dataset.view));
  });
  document.querySelectorAll("[data-metric-range]").forEach((button) => {
    button.addEventListener("click", () => loadMetrics(button.dataset.metricRange));
  });
  elements.eventSeverityFilter.addEventListener("change", renderEvents);
  elements.eventSourceFilter.addEventListener("change", renderEvents);
  elements.loadMoreEventsButton.addEventListener("click", () => loadEvents());
  elements.alertSettingsForm.addEventListener("input", () => { state.alertFormDirty = true; });
  elements.alertSettingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveAlertSettings();
  });
  elements.webSettingsForm.addEventListener("submit", saveWebSettings);
  elements.publicOriginForm.addEventListener("submit", confirmPublicOrigin);
  elements.disablePublicOriginButton.addEventListener("click", disablePublicOrigin);
  elements.tencentCloudForm.addEventListener("submit", saveTencentCloud);
  elements.checkTencentCloudButton.addEventListener("click", () => checkTencentCloud({ showOutput: true }));
  elements.planTencentCloudButton.addEventListener("click", previewTencentCloudPlan);
  elements.applyTencentCloudButton.addEventListener("click", applyTencentCloud);
  elements.clearTencentCloudButton.addEventListener("click", clearTencentCloud);
  elements.testWebhookButton.addEventListener("click", testWebhook);
  elements.removeWebhookButton.addEventListener("click", removeWebhook);
  document.querySelectorAll("[data-log-category]").forEach((button) => {
    button.addEventListener("click", () => selectLogCategory(button.dataset.logCategory));
  });
  elements.loadMoreLogsButton.addEventListener("click", () => loadLogs());
  elements.rollbackEnabled.addEventListener("change", toggleRollback);
  elements.openRollbackButton.addEventListener("click", openRollbackDialog);
  elements.rollbackContinueButton.addEventListener("click", prepareRollback);
  elements.rollbackBackButton.addEventListener("click", () => setRollbackStep(1));
  elements.executeRollbackButton.addEventListener("click", executeRollback);
  elements.rollbackDialog.addEventListener("close", resetRollbackDialog);
  elements.cancelDeploymentButton.addEventListener("click", openDeploymentCancelDialog);
  elements.deploymentCancelForm.addEventListener("submit", cancelDeployment);
  elements.deploymentCancelDialog.addEventListener("close", resetDeploymentCancelDialog);
  elements.clearAdmissionsButton.addEventListener("click", openAdmissionsClearDialog);
  elements.admissionsClearForm.addEventListener("submit", clearOrphanedAdmissions);
  elements.admissionsClearDialog.addEventListener("close", resetAdmissionsClearDialog);
  elements.createBackupButton.addEventListener("click", () => openBackupAction("create"));
  elements.exportRecoveryKeyButton.addEventListener("click", () => openBackupAction("key"));
  elements.backupActionForm.addEventListener("submit", executeBackupAction);
  elements.backupActionDialog.addEventListener("close", resetBackupAction);
  elements.backupSettingsForm.addEventListener("submit", saveBackupSettings);
  elements.prepareBackupRestoreButton.addEventListener("click", prepareBackupRestore);
  elements.backBackupRestoreButton.addEventListener("click", () => setBackupRestoreStep(1));
  elements.executeBackupRestoreButton.addEventListener("click", executeBackupRestore);
  elements.backupRestoreDialog.addEventListener("close", resetBackupRestore);
  elements.migrationExportForm.addEventListener("submit", createWorkspaceMigration);
  elements.migrationProjectChoices.addEventListener("change", updateMigrationSelection);
  elements.migrationPackageFile.addEventListener("change", selectMigrationPackage);
  elements.uploadMigrationButton.addEventListener("click", uploadWorkspaceMigration);
  elements.cancelMigrationUploadButton.addEventListener("click", cancelWorkspaceMigrationUpload);
  elements.inspectMigrationButton.addEventListener("click", inspectWorkspaceMigration);
  elements.executeMigrationButton.addEventListener("click", executeWorkspaceMigration);
  elements.refreshSidecarButton.addEventListener("click", () => loadSidecar({ force: true }));
  elements.mapRenderSettingsForm.addEventListener("input", () => {
    if (!state.mapRenderFormDirty) state.mapRenderFormRevision = state.mapRender?.settings?.revision ?? null;
    state.mapRenderFormDirty = true;
    elements.mapRenderSettingsStatus.dataset.status = "degraded";
    elements.mapRenderSettingsStatus.textContent = "有未保存修改";
  });
  elements.mapRenderSettingsForm.addEventListener("submit", saveMapRenderSettings);
  document.querySelectorAll("[data-map-render-preset]").forEach((button) => {
    button.addEventListener("click", () => applyMapRenderPreset(button.dataset.mapRenderPreset));
  });
  elements.pauseMapRenderButton.addEventListener("click", pauseMapRenderAdmission);
  elements.continueMapRenderButton.addEventListener("click", continueMapRenderQueue);
  elements.clearMapRenderCacheButton.addEventListener("click", clearMapRenderCache);
  elements.imageExecutionSettingsForm.addEventListener("input", () => {
    if (!state.imageExecutionFormDirty) {
      state.imageExecutionFormRevision = state.imageExecution?.settings?.revision ?? null;
    }
    state.imageExecutionFormDirty = true;
    elements.imageExecutionSettingsStatus.dataset.status = "degraded";
    elements.imageExecutionSettingsStatus.textContent = "有未保存修改";
  });
  elements.imageExecutionSettingsForm.addEventListener("submit", saveImageExecutionSettings);
  document.querySelectorAll("[data-image-execution-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = button.dataset.imageExecutionPreset;
      if (preset === "custom") elements.imageExecutionSettingsForm.requestSubmit();
      else void applyImageExecutionPreset(preset);
    });
  });
  elements.pauseImageExecutionButton.addEventListener("click", () => setImageExecutionAdmission(false));
  elements.continueImageExecutionButton.addEventListener("click", () => setImageExecutionAdmission(true));
  document.addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    elements.refreshSchedule.textContent = hidden ? "后台每 2 分钟刷新" : "每 15 秒刷新";
    if (hidden) {
      cancelOverviewRequest();
      scheduleRefresh(REFRESH_HIDDEN_MS);
      scheduleDeploymentControlPoll();
      scheduleMapRenderPoll();
      scheduleImageExecutionPoll();
      return;
    }
    void loadDeploymentControl({ force: true });
    if (state.view === "map-render") void loadMapRender({ force: true, populateForm: !state.mapRenderFormDirty });
    if (state.view === "image-execution") void loadImageExecution({ force: true, populateForm: !state.imageExecutionFormDirty });
    loadOverview({ force: true });
  });
  window.addEventListener("online", () => {
    void loadDeploymentControl({ force: true });
    if (state.view === "map-render") void loadMapRender({ force: true, populateForm: !state.mapRenderFormDirty });
    if (state.view === "image-execution") void loadImageExecution({ force: true, populateForm: !state.imageExecutionFormDirty });
    loadOverview({ force: true });
  });
  window.addEventListener("resize", () => {
    if (state.data && state.view === "overview") {
      drawResourceChart(state.metricSamples);
      drawTrafficChart(state.data.traffic?.trend?.samples || []);
    }
  });
}

function applyStoredTheme() {
  const stored = localStorage.getItem("codexDesktop.theme");
  const theme = stored === "dark" || stored === "light"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("codexDesktop.theme", theme);
  syncUserManagementTheme();
  if (state.data && state.view === "overview") drawResourceChart(state.metricSamples);
  if (state.data && state.view === "overview") drawTrafficChart(state.data.traffic?.trend?.samples || []);
}

function selectView(view) {
  const valid = ["overview", "tasks", "map-render", "image-execution", "deployment", "backups", "sidecar", "migrations", "users", "events", "logs", "alerts"].includes(view) ? view : "overview";
  state.view = valid;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === valid));
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === valid;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  history.replaceState(null, "", valid === "overview" ? location.pathname : `#${valid}`);
  if (state.data) renderActiveOverviewView(state.data);
  if (valid === "events" && !state.eventsLoaded) loadEvents({ reset: true });
  if (valid === "logs" && !state.logsLoaded) loadLogs({ reset: true });
  if (valid === "deployment") {
    loadRollback();
    loadPublicOrigin();
    loadTencentCloud();
  }
  if (valid === "backups") loadBackups();
  if (valid === "sidecar") loadSidecar();
  if (valid === "migrations") loadMigrations();
  if (valid === "map-render") loadMapRender({ populateForm: !state.mapRenderFormDirty });
  else cancelMapRenderRequest();
  if (valid === "image-execution") loadImageExecution({ populateForm: !state.imageExecutionFormDirty });
  else cancelImageExecutionRequest();
  if (valid === "users") ensureUserManagementFrame();
}

function ensureUserManagementFrame() {
  if (elements.userManagementFrame.getAttribute("src")) return;
  elements.userManagementFrame.src = elements.userManagementFrame.dataset.src;
}

async function loadOverview({ force = false } = {}) {
  if (state.loading && !force) return;
  if (force) cancelOverviewRequest();
  state.loading = true;
  elements.refreshButton.classList.add("is-loading");
  clearTimeout(state.timer);
  const controller = new AbortController();
  const requestId = ++state.overviewRequestId;
  state.overviewController = controller;
  const timeout = setTimeout(() => controller.abort(), OVERVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/ops/overview?_=${Date.now()}`, { cache: "no-store", signal: controller.signal });
    if (response.status === 401) {
      location.replace(`/login.html?next=${encodeURIComponent("/ops")}`);
      return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取运维状态");
    if (requestId !== state.overviewRequestId) return;
    state.overviewFailures = 0;
    state.data = data;
    renderOverview(data);
    elements.errorBanner.hidden = true;
  } catch (error) {
    if (requestId !== state.overviewRequestId) return;
    state.overviewFailures += 1;
    const initialFailure = !state.data;
    if (initialFailure || state.overviewFailures >= OVERVIEW_FAILURE_THRESHOLD) {
      elements.errorMessage.textContent = error.name === "AbortError"
        ? "网络响应较慢，已降低刷新频率并保留上次数据"
        : error.message;
      elements.errorBanner.hidden = false;
      elements.liveState.dataset.status = initialFailure ? "offline" : "degraded";
      elements.liveStateLabel.textContent = initialFailure ? "连接较慢" : "更新延迟";
    }
  } finally {
    clearTimeout(timeout);
    if (requestId === state.overviewRequestId) {
      state.overviewController = null;
      state.loading = false;
      elements.refreshButton.classList.remove("is-loading");
      scheduleRefresh();
    }
  }
}

function cancelOverviewRequest() {
  state.overviewRequestId += 1;
  state.overviewController?.abort();
  state.overviewController = null;
  state.loading = false;
  elements.refreshButton.classList.remove("is-loading");
}

function scheduleRefresh(delay = document.visibilityState === "hidden" ? REFRESH_HIDDEN_MS : REFRESH_VISIBLE_MS) {
  clearTimeout(state.timer);
  const failureDelay = state.overviewFailures > 0
    ? Math.min(60_000, delay * (2 ** Math.min(state.overviewFailures, 2)))
    : delay;
  state.timer = setTimeout(loadOverview, failureDelay);
}

async function loadDeploymentControl({ force = false } = {}) {
  if (state.deploymentControlPending && !force) return;
  if (force) cancelDeploymentControlRequest();
  clearTimeout(state.deploymentControlTimer);
  state.deploymentControlTimer = null;
  state.deploymentControlPending = true;
  const controller = new AbortController();
  const requestId = ++state.deploymentControlRequestId;
  state.deploymentControlController = controller;
  const timeout = setTimeout(() => controller.abort(), DEPLOYMENT_CONTROL_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/ops/deployments/control?_=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) return;
    if (requestId !== state.deploymentControlRequestId) return;
    if (response.status === 403) {
      state.deploymentControlConfirmed = true;
      renderDeploymentControl(null);
      return;
    }
    if (!response.ok) throw new Error(data.error || "无法读取维护状态");
    state.deploymentControlConfirmed = true;
    renderDeploymentControl(data);
  } catch {
    // Keep the last confirmed emergency control while this lightweight endpoint retries.
  } finally {
    clearTimeout(timeout);
    if (requestId === state.deploymentControlRequestId) {
      state.deploymentControlController = null;
      state.deploymentControlPending = false;
      scheduleDeploymentControlPoll();
    }
  }
}

function cancelDeploymentControlRequest() {
  state.deploymentControlRequestId += 1;
  state.deploymentControlController?.abort();
  state.deploymentControlController = null;
  state.deploymentControlPending = false;
}

function scheduleDeploymentControlPoll(delay = deploymentControlPollDelay()) {
  clearTimeout(state.deploymentControlTimer);
  state.deploymentControlTimer = setTimeout(() => void loadDeploymentControl(), delay);
}

function deploymentControlPollDelay() {
  if (document.visibilityState === "hidden") return DEPLOYMENT_CONTROL_HIDDEN_POLL_MS;
  return state.deploymentControl?.active
    ? DEPLOYMENT_CONTROL_ACTIVE_POLL_MS
    : DEPLOYMENT_CONTROL_IDLE_POLL_MS;
}

function renderOverview(data) {
  const overall = data.health?.status === "critical" ? "offline" : data.health?.status || "degraded";
  const overallLabel = { healthy: "运行正常", degraded: "部分异常", offline: "需要处理" }[overall];
  elements.liveState.dataset.status = overall;
  elements.liveStateLabel.textContent = overallLabel;
  elements.observedAt.textContent = formatTime(data.observedAt);
  elements.overallMetric.textContent = `${data.health?.score ?? "--"}%`;
  elements.activeTaskMetric.textContent = formatNumber(data.traffic?.requests || 0);
  elements.clientMetric.textContent = data.traffic?.p95LatencyMs === null ? "--" : `${formatNumber(data.traffic.p95LatencyMs)} ms`;
  elements.activeUserMetric.textContent = data.traffic?.tokenUsage?.available
    ? formatNumber(data.traffic.tokenUsage.totalTokens)
    : "Codex 未上报";
  elements.taskTabCount.textContent = String(data.tasks.active);
  elements.userTabCount.textContent = String(data.users.total);
  elements.eventTabCount.textContent = String(data.events?.rows?.length || 0);
  elements.alertTabCount.textContent = String(data.alerts?.active || 0);
  elements.footerVersion.textContent = `v${data.version}`;
  elements.backupsTab.hidden = data.viewer?.role !== "owner";
  elements.migrationsTab.hidden = data.viewer?.role !== "owner";
  if (state.metricRange === "1h") {
    state.metricSamples = data.resources?.samples || [];
    state.metricRetentionSeconds = data.resources?.retentionSeconds || 3600;
  }
  state.events = mergeEvents(data.events?.rows || [], state.events);
  renderActiveOverviewView(data);
}

function renderActiveOverviewView(data) {
  if (state.view === "overview") {
    renderServices(data.services);
    renderHealth(data.health);
    renderTraffic(data.traffic);
    renderResources(data.resources);
    renderRankings(data.traffic?.rankings || []);
    return;
  }
  if (state.view === "tasks") renderTasks(data.tasks);
  else if (state.view === "deployment") renderDeployment(data.deployment);
  else if (state.view === "users") renderUsers(data.users);
  else if (state.view === "events") renderEvents();
  else if (state.view === "alerts") renderAlerts(data.alerts);
}

function renderServices(services) {
  const gateway = services.gateway;
  setService(
    elements.gatewayService,
    gateway.status === "direct" ? "healthy" : gateway.status,
    gateway.status === "direct" ? "直接访问" : statusLabel(gateway.status),
    gateway.status === "direct"
      ? `后端 :${gateway.upstreamPort}`
      : `:${gateway.port} → :${gateway.upstreamPort || "--"}${gateway.latencyMs === null ? "" : ` · ${gateway.latencyMs} ms`}`,
    elements.gatewayPrimary,
    elements.gatewaySecondary,
  );
  setService(elements.backendService, services.backend.status, `v${services.backend.version}`, `端口 ${services.backend.port} · ${formatDuration(services.backend.uptimeSeconds)}`, elements.backendPrimary, elements.backendSecondary);
  setService(elements.codexService, services.codex.status, statusLabel(services.codex.status), `${services.codex.readyRuntimes} / ${services.codex.totalRuntimes} 个运行环境`, elements.codexPrimary, elements.codexSecondary);
  setService(
    elements.providerService,
    services.provider.status,
    services.provider.configuredRuntimes === services.provider.totalRuntimes ? "配置完整" : "缺少配置",
    `${services.provider.managedRuntimes} 个托管 · ${services.provider.codexRuntimes} 个 Codex 原配置`,
    elements.providerPrimary,
    elements.providerSecondary,
  );
  const issueCount = Object.values(services).filter((service) => ["offline", "degraded"].includes(service.status)).length;
  elements.serviceSummary.textContent = issueCount ? `${issueCount} 项需要检查` : "链路正常";
}

function setService(node, status, primary, secondary, primaryNode, secondaryNode) {
  node.dataset.status = status;
  primaryNode.textContent = primary;
  secondaryNode.textContent = secondary;
}

function renderHealth(health) {
  if (!health) return;
  const score = Math.max(0, Math.min(100, Number(health.score) || 0));
  elements.healthScore.textContent = `${score}%`;
  elements.healthRing.style.setProperty("--health-score", `${score * 3.6}deg`);
  elements.healthRing.dataset.status = health.status;
  elements.healthLabel.textContent = health.status === "healthy" ? "运行健康" : health.status === "degraded" ? "存在性能扣分" : "需要立即检查";
  elements.healthDeductions.replaceChildren();
  const deductions = health.deductions || [];
  if (!deductions.length) {
    const item = document.createElement("span");
    item.textContent = "当前没有健康扣分";
    elements.healthDeductions.append(item);
    return;
  }
  for (const deduction of deductions.slice(0, 4)) {
    const item = document.createElement("span");
    item.textContent = `${deduction.label} -${deduction.points}`;
    elements.healthDeductions.append(item);
  }
}

function renderTraffic(traffic) {
  if (!traffic) return;
  const success = traffic.successRate === null ? "暂无请求" : `成功率 ${traffic.successRate.toFixed(1)}%`;
  elements.trafficSummary.textContent = `${success} · 当前并发 ${traffic.inFlight || 0}`;
  drawTrafficChart(traffic.trend?.samples || []);
}

function drawTrafficChart(samples) {
  const canvas = elements.trafficChart;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  const styles = getComputedStyle(document.documentElement);
  const width = bounds.width;
  const height = bounds.height;
  const padding = { top: 8, right: 8, bottom: 20, left: 28 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = styles.getPropertyValue("--line").trim();
  context.fillStyle = styles.getPropertyValue("--faint").trim();
  context.font = "10px JetBrains Mono";
  const maximum = Math.max(1, ...samples.flatMap((sample) => [sample.requests || 0, sample.rpcCalls || 0]));
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + chartHeight * step / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  if (!samples.length) {
    context.fillText("等待流量数据", padding.left + 8, padding.top + chartHeight / 2);
    return;
  }
  const series = [
    { color: "--blue", value: (sample) => sample.requests || 0 },
    { color: "--red", value: (sample) => sample.requestErrors || 0 },
    { color: "--teal", value: (sample) => sample.rpcCalls || 0 },
  ];
  for (const item of series) {
    context.beginPath();
    context.strokeStyle = styles.getPropertyValue(item.color).trim();
    context.lineWidth = 1.8;
    samples.forEach((sample, index) => {
      const x = padding.left + chartWidth * (samples.length === 1 ? 0.5 : index / (samples.length - 1));
      const y = padding.top + chartHeight * (1 - item.value(sample) / maximum);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.fillStyle = styles.getPropertyValue(item.color).trim();
    samples.forEach((sample, index) => {
      const x = padding.left + chartWidth * (samples.length === 1 ? 0.5 : index / (samples.length - 1));
      const y = padding.top + chartHeight * (1 - item.value(sample) / maximum);
      context.beginPath();
      context.arc(x, y, 2.2, 0, Math.PI * 2);
      context.fill();
    });
  }
  context.fillStyle = styles.getPropertyValue("--faint").trim();
  context.fillText(String(maximum), 2, padding.top + 8);
  context.fillText("0", 12, padding.top + chartHeight);
}

function renderResources(resources) {
  const latest = resources?.samples?.at(-1);
  if (!latest) return;
  const mountedDisks = (Array.isArray(resources?.disks) ? resources.disks : [])
    .filter((disk) => disk && Number(disk.totalBytes) > 0);
  const primaryDisk = mountedDisks.find((disk) => disk.primary === true)
    || mountedDisks.find((disk) => disk.kind === "system")
    || null;
  const primaryReading = primaryDisk || latest.disk;
  setReading(elements.cpuValue, elements.cpuMeter, latest.cpuPercent);
  setReading(elements.memoryValue, elements.memoryMeter, latest.memory.percent);
  setReading(elements.diskValue, elements.diskMeter, primaryReading.percent);
  elements.memoryDetail.textContent = `${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`;
  setDataContent(elements.diskLabel, formatMountedDiskLabel(primaryDisk));
  setDataContent(elements.diskDetail, formatMountedDiskDetail(primaryReading));
  renderAdditionalDisks(mountedDisks.filter((disk) => disk !== primaryDisk));
  elements.networkRxValue.textContent = `${formatBytes(latest.network?.rxBytesPerSecond || 0)}/s`;
  elements.networkTxValue.textContent = `${formatBytes(latest.network?.txBytesPerSecond || 0)}/s`;
  drawResourceChart(state.metricSamples);
}

function renderAdditionalDisks(disks) {
  elements.additionalDiskReadings.replaceChildren();
  elements.additionalDiskReadings.hidden = disks.length === 0;
  for (const disk of disks) {
    const reading = document.createElement("div");
    reading.className = "resource-reading disk-reading additional-disk-reading";

    const heading = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("strong");
    const detail = document.createElement("small");
    const meter = document.createElement("div");
    const fill = document.createElement("span");

    meter.className = "meter";
    setDataContent(label, formatMountedDiskLabel(disk));
    setDataContent(detail, formatMountedDiskDetail(disk));
    setReading(value, fill, disk.percent);
    if (disk.source || disk.filesystem) {
      reading.title = [disk.source, disk.filesystem].filter(Boolean).join(" · ");
    }
    heading.append(label, value);
    meter.append(fill);
    reading.append(heading, detail, meter);
    elements.additionalDiskReadings.append(reading);
  }
}

function formatMountedDiskLabel(disk) {
  if (!disk) return interfaceLocale() === "en-US" ? "Disk" : "磁盘";
  const dataIndex = String(disk.label || "").match(/(\d+)$/u)?.[1] || "";
  if (interfaceLocale() === "en-US") {
    if (disk.kind === "system") return "System disk";
    if (disk.kind === "data") return `Data disk${dataIndex ? ` ${dataIndex}` : ""}`;
    return "Storage disk";
  }
  return String(disk.label || (disk.kind === "system" ? "系统盘" : disk.kind === "data" ? "数据盘" : "存储盘"));
}

function formatMountedDiskDetail(disk) {
  const usage = `${formatBytes(disk?.usedBytes)} / ${formatBytes(disk?.totalBytes)}`;
  return disk?.mountPoint ? `${disk.mountPoint} · ${usage}` : usage;
}

function renderRankings(rows) {
  elements.rankingRows.replaceChildren();
  elements.rankingEmpty.hidden = rows.length > 0;
  elements.rankingSummary.textContent = rows.length ? `${rows.length} 个活跃用户` : "暂无统计";
  for (const user of rows) {
    const row = document.createElement("tr");
    row.append(
      userCell(user),
      textCell(formatNumber(user.requests)),
      textCell(formatNumber(user.turns)),
      tokenUsageCell(user, "inputTokens"),
      tokenUsageCell(user, "cachedInputTokens"),
      tokenUsageCell(user, "outputTokens"),
      tokenUsageCell(user, "reasoningOutputTokens"),
      tokenUsageCell(user, "totalTokens"),
      textCell(formatRelativeTime(user.lastActiveAt)),
    );
    elements.rankingRows.append(row);
  }
}

function tokenUsageCell(user, key) {
  return textCell(user.tokenAvailable ? formatNumber(user[key]) : user.turns > 0 ? "Codex 未上报" : "0");
}

async function loadMetrics(range) {
  if (!["1h", "24h", "7d"].includes(range)) return;
  state.metricRange = range;
  document.querySelectorAll("[data-metric-range]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.metricRange === range);
  });
  if (range === "1h" && state.data) {
    state.metricSamples = state.data.resources?.samples || [];
    state.metricRetentionSeconds = state.data.resources?.retentionSeconds || 3600;
    drawResourceChart(state.metricSamples);
    return;
  }
  try {
    const response = await fetch(`/api/ops/metrics?range=${encodeURIComponent(range)}&_=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取资源趋势");
    if (state.metricRange !== range) return;
    state.metricSamples = data.samples || [];
    state.metricRetentionSeconds = data.retentionSeconds || 0;
    drawResourceChart(state.metricSamples);
  } catch (error) {
    showError(error.message);
  }
}

function setReading(label, meter, value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  label.textContent = `${percent.toFixed(1)}%`;
  meter.style.width = `${percent}%`;
}

function drawResourceChart(samples) {
  const canvas = elements.resourceChart;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  const styles = getComputedStyle(document.documentElement);
  const width = bounds.width;
  const height = bounds.height;
  const padding = { top: 8, right: 8, bottom: 22, left: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  context.clearRect(0, 0, width, height);
  context.font = "10px JetBrains Mono";
  context.fillStyle = styles.getPropertyValue("--faint").trim();
  context.strokeStyle = styles.getPropertyValue("--line").trim();
  context.lineWidth = 1;
  for (const value of [0, 25, 50, 75, 100]) {
    const y = padding.top + chartHeight * (1 - value / 100);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(String(value), 4, y + 3);
  }
  if (samples.length < 2) {
    context.fillText("等待采样数据", padding.left + 8, padding.top + chartHeight / 2);
    return;
  }
  const chartSamples = downsampleSamples(samples, Math.max(120, Math.floor(chartWidth * 1.5)));
  const series = [
    { color: "--chart-cpu", value: (sample) => sample.cpuPercent },
    { color: "--chart-memory", value: (sample) => sample.memory.percent },
    { color: "--chart-disk", value: (sample) => sample.disk.percent },
  ];
  for (const item of series) {
    context.beginPath();
    context.strokeStyle = styles.getPropertyValue(item.color).trim();
    context.lineWidth = 1.8;
    chartSamples.forEach((sample, index) => {
      const x = padding.left + chartWidth * index / (chartSamples.length - 1);
      const y = padding.top + chartHeight * (1 - item.value(sample) / 100);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  context.fillStyle = styles.getPropertyValue("--faint").trim();
  context.fillText(formatChartTime(samples[0].at), padding.left, height - 5);
  const latestLabel = formatChartTime(samples.at(-1).at);
  context.fillText(latestLabel, width - padding.right - context.measureText(latestLabel).width, height - 5);
}

function renderTasks(tasks) {
  elements.taskRows.replaceChildren();
  elements.taskEmpty.hidden = tasks.rows.length > 0;
  const worktreeCount = tasks.rows.reduce((total, runtime) => total + Number(runtime.worktrees?.ready || 0), 0);
  elements.taskSummary.textContent = `${tasks.active} 个活动任务 · ${worktreeCount} 个 Worktrees · ${tasks.connectedClients} 个连接`;
  for (const runtime of tasks.rows) {
    const row = document.createElement("tr");
    row.append(
      userCell(runtime),
      badgeCell(runtime.codexReady ? "就绪" : "离线", runtime.codexReady ? "healthy" : "offline"),
      badgeCell(providerModeLabel(runtime.providerMode, runtime.providerProfiles), runtime.providerConfigured ? "healthy" : "degraded"),
      badgeCell(taskStatusLabel(runtime.task.status), runtime.task.status),
      textCell(taskPhaseLabel(runtime.task.phase)),
      worktreeUsageCell(runtime.worktrees),
      textCell(String(runtime.connectedClients)),
      textCell(formatRelativeTime(runtime.task.updatedAt)),
    );
    elements.taskRows.append(row);
  }
}

function worktreeUsageCell(worktrees) {
  const cell = textCell(worktrees
    ? `${worktrees.ready}/${worktrees.maxManaged} · ${formatBytes(worktrees.estimatedBytes)}`
    : "--");
  if (worktrees) {
    cell.title = [
      `Worktree 中 ${worktrees.activeInWorktree}`,
      `Local 中 ${worktrees.activeInLocal}`,
      `可恢复 ${worktrees.restorable}`,
      `固定 ${worktrees.pinned}`,
      `永久 ${worktrees.permanent}`,
    ].join(" · ");
  }
  return cell;
}

function renderDeployment(deployment) {
  elements.runningVersion.textContent = versionLabel(deployment.runningVersion);
  elements.sourceVersion.textContent = versionLabel(deployment.sourceVersion);
  elements.remoteVersion.textContent = versionLabel(deployment.remoteVersion);
  elements.codexVersion.textContent = deployment.codex.installedVersion || "--";
  renderOperation(deployment.release, elements.releaseStatus, elements.releaseDetail);
  renderOperation(deployment.appUpdate, elements.appUpdateStatus, elements.appUpdateDetail);
  renderOperation(deployment.codex.update, elements.codexUpdateStatus, elements.codexUpdateDetail);
  renderOperation(deployment.rollback, elements.rollbackStatus, elements.rollbackDetail);
  if (!state.deploymentControlConfirmed) renderDeploymentControl(deployment.control);
  renderSetup(deployment.setup);
}

function renderDeploymentControl(control) {
  state.deploymentControl = control || null;
  const visible = control?.active && (control.cancellable || control.cancellationRequested);
  const orphanedAdmissions = Number(control?.persistentAdmissions?.orphaned) || 0;
  elements.cancelDeploymentButton.hidden = !visible;
  elements.clearAdmissionsButton.hidden = orphanedAdmissions === 0;
  elements.cancelDeploymentButton.disabled = control?.cancellationRequested === true;
  elements.cancelDeploymentButton.querySelector("span").textContent = control?.cancellationRequested
    ? "正在取消"
    : "取消维护";
  if (
    elements.deploymentCancelDialog.open
    && (!control?.active || !control.cancellable || !control.operationId)
  ) {
    elements.deploymentCancelDialog.close();
  }
  if (elements.admissionsClearDialog.open && orphanedAdmissions === 0) {
    elements.admissionsClearDialog.close();
  }
}

function openDeploymentCancelDialog() {
  const control = state.deploymentControl;
  if (!control?.active || !control.operationId || !control.cancellable) return;
  const labels = {
    release: "网页发布",
    "app-update": "远程同步",
    "codex-update": "Codex 升级",
    rollback: "手动回滚",
    "data-restore": "数据恢复",
  };
  elements.deploymentCancelSummary.textContent = `取消${labels[control.kind] || "维护任务"}，当前阶段：${control.phase}。切换一旦提交将拒绝取消。`;
  elements.deploymentCancelDialog.showModal();
  elements.deploymentCancelPassword.focus();
}

async function cancelDeployment(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.deploymentCancelDialog.close();
    return;
  }
  const control = state.deploymentControl;
  if (!control?.operationId) return;
  elements.executeDeploymentCancelButton.disabled = true;
  elements.deploymentCancelStatus.hidden = true;
  try {
    const result = await requestOpsJson("/api/ops/deployments/cancel", {
      method: "POST",
      action: "ops-deployment-cancel",
      body: { operationId: control.operationId, password: elements.deploymentCancelPassword.value },
      timeoutMs: 10_000,
    });
    state.deploymentControlConfirmed = true;
    renderDeploymentControl(result.control);
    elements.deploymentCancelPassword.value = "";
    if (elements.deploymentCancelDialog.open) elements.deploymentCancelDialog.close();
    await loadDeploymentControl({ force: true });
    void loadOverview({ force: true });
  } catch (error) {
    elements.deploymentCancelPassword.value = "";
    await loadDeploymentControl({ force: true });
    if (
      state.deploymentControl?.operationId === control.operationId
      && state.deploymentControl.cancellationRequested
    ) {
      elements.deploymentCancelDialog.close();
      return;
    }
    elements.deploymentCancelStatus.hidden = false;
    elements.deploymentCancelStatus.dataset.status = "error";
    elements.deploymentCancelStatus.textContent = error.message;
  } finally {
    elements.executeDeploymentCancelButton.disabled = false;
  }
}

function resetDeploymentCancelDialog() {
  elements.deploymentCancelPassword.value = "";
  elements.deploymentCancelStatus.hidden = true;
}

function openAdmissionsClearDialog() {
  const orphaned = Number(state.deploymentControl?.persistentAdmissions?.orphaned) || 0;
  if (orphaned === 0) return;
  elements.admissionsClearSummary.textContent = `检测到 ${orphaned} 条中断写入记录。只有相关后台任务已停止时才会清理。`;
  elements.admissionsClearDialog.showModal();
  elements.admissionsClearPassword.focus();
}

async function clearOrphanedAdmissions(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.admissionsClearDialog.close();
    return;
  }
  elements.executeAdmissionsClearButton.disabled = true;
  elements.admissionsClearStatus.hidden = true;
  try {
    const result = await requestOpsJson("/api/ops/deployments/admissions/clear", {
      method: "POST",
      action: "ops-deployment-admissions-clear",
      body: {
        password: elements.admissionsClearPassword.value,
        confirmation: elements.admissionsClearConfirmation.value.trim(),
      },
      timeoutMs: 10_000,
    });
    renderDeploymentControl({
      ...(state.deploymentControl || {}),
      persistentAdmissions: result.persistentAdmissions,
    });
    if (elements.admissionsClearDialog.open) elements.admissionsClearDialog.close();
    await loadDeploymentControl({ force: true });
    void loadOverview({ force: true });
  } catch (error) {
    elements.admissionsClearPassword.value = "";
    elements.admissionsClearStatus.hidden = false;
    elements.admissionsClearStatus.dataset.status = "error";
    elements.admissionsClearStatus.textContent = error.message;
  } finally {
    elements.executeAdmissionsClearButton.disabled = false;
  }
}

function resetAdmissionsClearDialog() {
  elements.admissionsClearPassword.value = "";
  elements.admissionsClearConfirmation.value = "";
  elements.admissionsClearStatus.hidden = true;
}

function renderSetup(setup) {
  if (!setup) return;
  const entries = [setup.password, setup.authorization, setup.access, setup.updates];
  elements.setupSummary.textContent = `${entries.filter((entry) => entry?.configured).length} / 4 已完成`;
  renderSetupStatus(
    setup.password,
    elements.setupPasswordStatus,
    elements.setupPasswordDetail,
    setup.password.configured ? "密码保护已启用" : "尚未生成网页密码",
  );
  renderSetupStatus(
    setup.authorization,
    elements.setupAuthorizationStatus,
    elements.setupAuthorizationDetail,
    setup.authorization.configured ? "已检测到可用配置" : "尚未选择官方登录或 API 供应商",
  );
  renderSetupStatus(
    setup.access,
    elements.setupAccessStatus,
    elements.setupAccessDetail,
    accessSetupLabel(setup.access),
  );
  renderSetupStatus(
    setup.updates,
    elements.setupUpdatesStatus,
    elements.setupUpdatesDetail,
    setup.updates.configured ? "只读 SSH 更新源已连接" : "未配置 Git 更新源，版本中心不能远程同步",
  );
  document.querySelectorAll("[data-setup-command]").forEach((button) => {
    button.dataset.command = setup[button.dataset.setupCommand]?.command || "";
  });
}

function renderSetupStatus(entry, badge, detail, label) {
  const configured = entry?.configured === true;
  badge.dataset.status = configured ? "healthy" : "degraded";
  badge.textContent = configured ? "已完成" : "待配置";
  detail.textContent = label;
}

function accessSetupLabel(access) {
  if (!access?.configured) return "尚未记录访问方式";
  if (access.mode === "local") return "仅本机或 SSH 端口转发";
  if (access.mode === "cloudflare") return access.hostname ? `Cloudflare Tunnel · ${access.hostname}` : "Cloudflare Tunnel";
  return access.hostname ? `域名 HTTPS · ${access.hostname}` : "域名 HTTPS";
}

async function copySetupCommand(button) {
  const command = button.dataset.command;
  if (!command) return;
  const label = button.querySelector("span");
  try {
    await navigator.clipboard.writeText(command);
    label.textContent = "已复制";
    setTimeout(() => { label.textContent = "复制命令"; }, 1_500);
  } catch {
    showError(`无法访问剪贴板，请在项目目录执行：${command}`);
  }
}

function renderOperation(operation, badge, detail) {
  badge.dataset.status = operation.status;
  badge.textContent = operationStatusLabel(operation.status);
  detail.textContent = operation.detail || (operation.completedAt ? `完成于 ${formatDateTime(operation.completedAt)}` : "暂无运行记录");
}

function renderUsers(users) {
  elements.totalUserMetric.textContent = String(users.total);
  elements.enabledUserMetric.textContent = String(users.active);
  elements.disabledUserMetric.textContent = String(users.disabled);
  elements.quotaMetric.textContent = formatBytes(users.quotaBytes);
}

function syncUserManagementTheme() {
  try {
    const root = elements.userManagementFrame.contentDocument?.documentElement;
    if (root) root.dataset.theme = document.documentElement.dataset.theme;
  } catch {
    // The embedded page keeps its stored theme until same-origin content is available.
  }
}

async function loadEvents({ reset = false } = {}) {
  elements.loadMoreEventsButton.disabled = true;
  try {
    const parameters = new URLSearchParams({ limit: "100", _: String(Date.now()) });
    if (!reset && state.events.length) parameters.set("before", String(Math.min(...state.events.map((event) => event.at))));
    const response = await fetch(`/api/ops/events?${parameters}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取事件记录");
    if (reset) state.events = [];
    state.events = mergeEvents(data.events || [], state.events);
    state.eventsLoaded = true;
    state.eventsHasMore = (data.events || []).length === 100;
    renderEvents();
  } catch (error) {
    showError(error.message);
  } finally {
    elements.loadMoreEventsButton.disabled = false;
  }
}

function mergeEvents(incoming, existing) {
  return [...new Map([...incoming, ...existing].map((event) => [event.id, event])).values()]
    .sort((left, right) => right.at - left.at)
    .slice(0, 2_000);
}

function renderEvents() {
  const severity = elements.eventSeverityFilter.value;
  const source = elements.eventSourceFilter.value;
  const filtered = state.events.filter((event) => (
    (!severity || event.severity === severity) && (!source || event.source === source)
  ));
  elements.eventRows.replaceChildren();
  for (const event of filtered) elements.eventRows.append(eventRow(event));
  elements.eventEmpty.hidden = filtered.length > 0;
  elements.loadMoreEventsButton.hidden = !state.eventsHasMore || !state.eventsLoaded;
  elements.eventCountMetric.textContent = String(state.events.length);
  elements.criticalEventMetric.textContent = String(state.events.filter((event) => event.severity === "critical").length);
  elements.warningEventMetric.textContent = String(state.events.filter((event) => event.severity === "warning").length);
  elements.latestEventMetric.textContent = state.events.length ? formatRelativeTime(state.events[0].at) : "--";
  elements.eventTabCount.textContent = String(state.events.length);
  window.lucide?.createIcons();
}

function eventRow(event) {
  const row = document.createElement("article");
  row.className = "event-row";
  row.dataset.severity = event.severity;
  const icon = document.createElement("span");
  icon.className = "event-icon";
  const iconElement = document.createElement("i");
  iconElement.dataset.lucide = eventIcon(event.source);
  icon.append(iconElement);
  const content = document.createElement("div");
  const title = document.createElement("strong");
  setDataContent(title, event.title);
  const detail = document.createElement("span");
  setDataContent(detail, event.detail || sourceLabel(event.source), Boolean(event.detail));
  content.append(title, detail);
  const meta = document.createElement("div");
  meta.className = "event-meta";
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.dataset.status = severityStatus(event.severity);
  badge.textContent = severityLabel(event.severity);
  const time = document.createElement("time");
  time.dateTime = new Date(event.at).toISOString();
  time.textContent = formatDateTime(event.at);
  meta.append(badge, time);
  row.append(icon, content, meta);
  return row;
}

function selectLogCategory(category) {
  if (!["api", "rpc", "errors", "system", "warnings"].includes(category)) return;
  state.logCategory = category;
  document.querySelectorAll("[data-log-category]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.logCategory === category);
  });
  loadLogs({ reset: true });
}

async function loadLogs({ reset = false } = {}) {
  elements.loadMoreLogsButton.disabled = true;
  try {
    const parameters = new URLSearchParams({ category: state.logCategory, limit: "100", _: String(Date.now()) });
    if (!reset && state.logs.length) parameters.set("before", String(Math.min(...state.logs.map((row) => row.at))));
    const response = await fetch(`/api/ops/logs?${parameters}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取运行日志");
    const incoming = data.rows || [];
    state.logs = reset ? incoming : [...state.logs, ...incoming];
    state.logs = state.logs.sort((left, right) => right.at - left.at).slice(0, 2_000);
    state.logsLoaded = true;
    state.logsHasMore = incoming.length === 100;
    renderLogs();
  } catch (error) {
    showError(error.message);
  } finally {
    elements.loadMoreLogsButton.disabled = false;
  }
}

function renderLogs() {
  elements.logRows.replaceChildren();
  for (const item of state.logs) {
    const event = Boolean(item.id);
    const row = document.createElement("tr");
    row.append(
      textCell(formatDateTime(item.at)),
      textCell(event ? sourceLabel(item.source) : logKindLabel(item.kind)),
      textCell(event ? item.title : item.operation, true),
      badgeCell(event ? severityLabel(item.severity) : item.success ? "成功" : "失败", event ? severityStatus(item.severity) : item.success ? "healthy" : "failed"),
      textCell(event || item.durationMs === null ? "--" : `${formatNumber(item.durationMs)} ms`),
      textCell(event ? item.detail || "系统" : item.username || "系统", Boolean(event ? item.detail : item.username)),
    );
    elements.logRows.append(row);
  }
  elements.logEmpty.hidden = state.logs.length > 0;
  elements.loadMoreLogsButton.hidden = !state.logsHasMore;
}

function logKindLabel(kind) {
  return { http: "HTTP", rpc: "Codex RPC", turn: "任务", socket: "连接" }[kind] || "系统";
}

async function loadSidecar({ force = false } = {}) {
  if (state.sidecarLoading) return;
  state.sidecarLoading = true;
  elements.refreshSidecarButton.disabled = true;
  elements.refreshSidecarButton.classList.toggle("is-loading", force);
  try {
    const data = await requestOpsJson(`/api/ops/sidecar?_=${Date.now()}`, { timeoutMs: 30_000 });
    state.sidecar = data;
    renderSidecar(data);
    elements.sidecarOperationStatus.hidden = true;
  } catch (error) {
    showSidecarStatus(error.message, "error");
  } finally {
    state.sidecarLoading = false;
    elements.refreshSidecarButton.disabled = false;
    elements.refreshSidecarButton.classList.remove("is-loading");
  }
}

function renderSidecar(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const totals = data?.totals || {};
  const storedAccounts = rows.filter((row) => Number(row.storage?.totalBytes) > 0).length;
  elements.sidecarSizeMetric.textContent = formatBytes(totals.physicalBytes);
  elements.sidecarEventMetric.textContent = formatNumber(totals.indexedHistoryRecords || 0);
  elements.sidecarHistoryMetric.textContent = formatNumber(totals.indexedHistoryTurns || 0);
  elements.sidecarWorkerMetric.textContent = `${formatNumber(totals.activeWorkers || 0)} / ${formatNumber(totals.accounts || 0)}`;
  elements.sidecarTabCount.textContent = String(storedAccounts);
  elements.sidecarModeStatus.textContent = data.enabled
    ? `已启用 · ${data.mode || "未知模式"}`
    : "未启用";
  elements.sidecarModeStatus.dataset.status = !data.enabled
    ? "idle"
    : totals.pressured > 0 || rows.some((row) => row.status === "degraded")
      ? "degraded"
      : "healthy";
  elements.sidecarRows.replaceChildren();
  for (const item of rows) {
    const row = document.createElement("tr");
    const storage = item.storage || {};
    const queue = item.queue || {};
    const health = item.health || {};
    const integrity = health.stateIntegrity || health.historyIntegrity
      ? `${health.stateIntegrity || "--"} / ${health.historyIntegrity || "--"}`
      : health.degradedReason || "--";
    row.append(
      userCell(item),
      badgeCell(sidecarStatusLabel(item.status, item.pressured), sidecarStatusBadge(item.status, item.pressured)),
      textCell(formatBytes(storage.totalBytes)),
      textCell(formatNumber(storage.indexedHistoryRecords || 0)),
      textCell(`${formatNumber(storage.indexedHistoryTurns || 0)} Turn · ${formatNumber(storage.indexedHistoryRecords || 0)} 条`),
      textCell(`${formatNumber(queue.count || 0)} · ${formatBytes(queue.bytes)}`),
      textCell(integrity, Boolean(health.degradedReason)),
    );
    elements.sidecarRows.append(row);
  }
  elements.sidecarEmpty.hidden = rows.length > 0;
  window.lucide?.createIcons();
}

function sidecarStatusLabel(status, pressured) {
  if (pressured) return "队列承压";
  return {
    healthy: "正常",
    degraded: "异常",
    inactive: "未运行",
    empty: "未创建",
    disabled: "未启用",
  }[status] || "未知";
}

function sidecarStatusBadge(status, pressured) {
  if (pressured || status === "degraded") return "degraded";
  if (status === "healthy") return "healthy";
  return "idle";
}

function showSidecarStatus(message, status) {
  elements.sidecarOperationStatus.hidden = false;
  elements.sidecarOperationStatus.dataset.status = status;
  elements.sidecarOperationStatus.textContent = message;
}

async function loadBackups() {
  try {
    const response = await fetch(`/api/ops/backups?_=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取备份状态");
    state.backups = data;
    renderBackups(data);
  } catch (error) {
    showBackupStatus(error.message, "error");
  }
}

function renderBackups(data) {
  const backups = data.backups || [];
  const totalBytes = backups.reduce((sum, backup) => sum + (backup.sizeBytes || 0), 0);
  elements.backupCountMetric.textContent = String(backups.length);
  elements.backupTabCount.textContent = String(backups.length);
  elements.backupSizeMetric.textContent = formatBytes(totalBytes);
  elements.latestBackupMetric.textContent = backups.length ? formatRelativeTime(backups[0].createdAt) : "--";
  elements.backupScheduleMetric.textContent = data.settings?.enabled
    ? data.settings.intervalHours === 168 ? "每周" : "每天"
    : "未启用";
  elements.backupScheduleEnabled.checked = data.settings?.enabled === true;
  elements.backupInterval.value = String(data.settings?.intervalHours || 24);
  elements.backupRetention.value = String(data.settings?.retentionCount || 7);
  elements.createBackupButton.disabled = data.busy === true;
  elements.createBackupButton.querySelector("span")?.remove();
  elements.backupListSummary.textContent = `${backups.length} 个备份`;
  elements.backupRows.replaceChildren();
  for (const backup of backups) elements.backupRows.append(createBackupRow(backup));
  elements.backupEmpty.hidden = backups.length > 0;
  renderBackupRestoreStatus(data.restore);
  window.lucide?.createIcons();
}

function createBackupRow(backup) {
  const row = document.createElement("article");
  row.className = "backup-row";
  const icon = document.createElement("span");
  icon.className = "backup-row-icon";
  icon.innerHTML = '<i data-lucide="archive"></i>';
  const copy = document.createElement("div");
  copy.className = "backup-row-copy";
  const title = document.createElement("strong");
  setDataContent(title, backup.id);
  const detail = document.createElement("span");
  detail.textContent = `${backup.kind === "scheduled" ? "定时" : "手动"} · v${backup.version} · ${formatBytes(backup.sizeBytes)} · ${backup.summary?.users || 0} 用户 · ${backup.summary?.projects || 0} 工程`;
  const checksum = document.createElement("code");
  checksum.textContent = `SHA-256 ${backup.sha256.slice(0, 16)}... · ${backup.verifiedAt ? `已校验 ${formatRelativeTime(backup.verifiedAt)}` : "待校验"}`;
  copy.append(title, detail, checksum);
  const time = document.createElement("time");
  time.textContent = formatDateTime(backup.createdAt);
  const actions = document.createElement("div");
  actions.className = "backup-row-actions";
  actions.append(
    backupIconButton("shield-check", "校验备份", () => verifyBackup(backup.id)),
    backupLinkButton("download", "下载备份", `/api/ops/backups/${encodeURIComponent(backup.id)}/download`),
    backupIconButton("archive-restore", "恢复此备份", () => openBackupRestore(backup.id)),
    backupIconButton("trash-2", "删除备份", () => openBackupAction("delete", backup.id), true),
  );
  const meta = document.createElement("div");
  meta.className = "backup-row-meta";
  meta.append(time, actions);
  row.append(icon, copy, meta);
  return row;
}

function backupIconButton(icon, label, action, danger = false) {
  const button = document.createElement("button");
  button.type = "button"; button.className = `icon-button${danger ? " danger-button" : ""}`;
  button.title = label; button.setAttribute("aria-label", label); button.innerHTML = `<i data-lucide="${icon}"></i>`;
  button.addEventListener("click", action); return button;
}

function backupLinkButton(icon, label, href) {
  const link = document.createElement("a");
  link.className = "icon-button"; link.href = href; link.download = ""; link.title = label; link.setAttribute("aria-label", label);
  link.innerHTML = `<i data-lucide="${icon}"></i>`; return link;
}

async function verifyBackup(id) {
  try {
    await requestOpsJson(`/api/ops/backups/${encodeURIComponent(id)}/verify`, { method: "POST", action: "ops-backup-verify" });
    showBackupStatus("备份校验通过", "success"); await loadBackups();
  } catch (error) { showBackupStatus(error.message, "error"); }
}

function openBackupAction(type, id = null) {
  state.backupAction = { type, id };
  elements.backupActionPassword.value = "";
  elements.backupActionError.hidden = true;
  const content = {
    create: ["立即创建数据备份", "将加密备份当前用户、工程、对话、上传、供应商和服务配置。", "开始备份"],
    key: ["导出恢复密钥", "恢复密钥可以解密服务器数据备份，请离线保管。", "导出密钥"],
    delete: ["删除数据备份", `删除 ${id} 后不能恢复。`, "确认删除"],
  }[type];
  elements.backupActionTitle.textContent = content[0];
  elements.backupActionSummary.textContent = content[1];
  elements.executeBackupActionButton.textContent = content[2];
  elements.executeBackupActionButton.classList.toggle("danger-primary", type === "delete");
  elements.backupActionDialog.showModal();
  elements.backupActionPassword.focus();
}

async function executeBackupAction(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const action = state.backupAction;
  if (!action) return;
  const password = elements.backupActionPassword.value;
  elements.executeBackupActionButton.disabled = true;
  try {
    if (action.type === "create") {
      await requestOpsJson("/api/ops/backups", { method: "POST", action: "ops-backup-create", body: { password } });
      showBackupStatus("备份任务已启动", "success");
    } else if (action.type === "delete") {
      await requestOpsJson(`/api/ops/backups/${encodeURIComponent(action.id)}`, { method: "DELETE", action: "ops-backup-delete", body: { password } });
      showBackupStatus("备份已删除", "success");
    } else if (action.type === "key") {
      await downloadRecoveryKey(password);
      showBackupStatus("恢复密钥已导出", "success");
    }
    elements.backupActionPassword.value = "";
    elements.backupActionDialog.close();
    await loadBackups();
  } catch (error) {
    elements.backupActionPassword.value = "";
    elements.backupActionError.hidden = false;
    elements.backupActionError.dataset.status = "error";
    elements.backupActionError.textContent = error.message;
  } finally {
    elements.executeBackupActionButton.disabled = false;
  }
}

async function downloadRecoveryKey(password) {
  const response = await fetch("/api/ops/backups/recovery-key/export", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-backup-key-export" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "恢复密钥导出失败");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a"); link.href = url; link.download = "codex-backup-recovery-key.txt";
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function resetBackupAction() {
  state.backupAction = null;
  elements.backupActionPassword.value = "";
  elements.backupActionError.hidden = true;
}

async function saveBackupSettings(event) {
  event.preventDefault();
  elements.saveBackupSettingsButton.disabled = true;
  try {
    await requestOpsJson("/api/ops/backups/settings", { method: "PUT", action: "ops-backup-settings", body: {
      enabled: elements.backupScheduleEnabled.checked,
      intervalHours: Number(elements.backupInterval.value),
      retentionCount: Number(elements.backupRetention.value),
      password: elements.backupSettingsPassword.value,
    } });
    elements.backupSettingsPassword.value = "";
    showBackupStatus("备份策略已保存", "success"); await loadBackups();
  } catch (error) { elements.backupSettingsPassword.value = ""; showBackupStatus(error.message, "error"); }
  finally { elements.saveBackupSettingsButton.disabled = false; }
}

function openBackupRestore(id) {
  resetBackupRestore();
  state.backupRestoreId = id;
  elements.backupRestoreTypedId.placeholder = id;
  elements.backupRestoreDialog.showModal();
  elements.backupRestoreTypedId.focus();
}

async function prepareBackupRestore() {
  elements.prepareBackupRestoreButton.disabled = true;
  try {
    const data = await requestOpsJson(`/api/ops/backups/${encodeURIComponent(state.backupRestoreId)}/restore/prepare`, {
      method: "POST", action: "ops-backup-restore-prepare", body: {
        typedBackupId: elements.backupRestoreTypedId.value.trim(), password: elements.backupRestorePassword.value,
      },
    });
    state.backupRestoreNonce = data.confirmation.nonce;
    const manifest = data.confirmation.manifest;
    elements.backupRestoreConfirmation.textContent = `v${manifest.appVersion} · ${manifest.summary.users} 用户 · ${manifest.summary.projects} 工程 · 校验通过`;
    elements.backupRestorePassword.value = "";
    setBackupRestoreStep(2);
  } catch (error) { showBackupRestoreError(error.message); }
  finally { elements.prepareBackupRestoreButton.disabled = false; }
}

async function executeBackupRestore() {
  elements.executeBackupRestoreButton.disabled = true;
  try {
    await requestOpsJson(`/api/ops/backups/${encodeURIComponent(state.backupRestoreId)}/restore/execute`, {
      method: "POST", action: "ops-backup-restore-execute", body: { nonce: state.backupRestoreNonce },
    });
    elements.backupRestoreDialog.close();
    showBackupStatus("恢复任务已启动，服务稍后会短暂重连", "success");
    await loadBackups();
  } catch (error) { state.backupRestoreNonce = null; showBackupRestoreError(error.message); }
  finally { elements.executeBackupRestoreButton.disabled = false; }
}

function setBackupRestoreStep(step) {
  elements.backupRestoreStepOne.hidden = step !== 1;
  elements.backupRestoreStepTwo.hidden = step !== 2;
  elements.backupRestoreError.hidden = true;
}

function resetBackupRestore() {
  state.backupRestoreId = null; state.backupRestoreNonce = null;
  elements.backupRestoreTypedId.value = ""; elements.backupRestorePassword.value = "";
  setBackupRestoreStep(1);
}

function showBackupRestoreError(message) {
  elements.backupRestoreError.hidden = false; elements.backupRestoreError.dataset.status = "error"; elements.backupRestoreError.textContent = message;
}

function renderBackupRestoreStatus(restore = {}) {
  const labels = { idle: "空闲", queued: "等待启动", preparing: "准备中", draining: "等待任务", switching: "切换中", completed: "已完成", failed: "失败" };
  elements.backupRestoreStatus.textContent = labels[restore.phase] || labels[restore.status] || "空闲";
  elements.backupRestoreStatus.dataset.status = restore.status === "failed" ? "failed" : restore.status === "running" ? "degraded" : restore.status === "completed" ? "healthy" : "idle";
  elements.backupRestoreDetail.textContent = restore.error || restore.detail || "没有正在执行的恢复任务";
  elements.backupRestoreTime.textContent = formatDateTime(restore.completedAt || restore.startedAt);
}

function showBackupStatus(message, status) {
  elements.backupOperationStatus.hidden = false;
  elements.backupOperationStatus.dataset.status = status;
  elements.backupOperationStatus.textContent = message;
}

async function loadMigrations() {
  if (state.migrationLoading) return;
  state.migrationLoading = true;
  clearTimeout(state.migrationPollTimer);
  try {
    const response = await fetch(`/api/ops/workspace-migrations?_=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取工作区迁移状态");
    state.migrations = data;
    renderMigrations(data);
    if (data.busy && state.view === "migrations") {
      state.migrationPollTimer = setTimeout(loadMigrations, 2_000);
    }
  } catch (error) {
    showMigrationStatus(elements.migrationOperationStatus, error.message, "error");
  } finally {
    state.migrationLoading = false;
  }
}

function renderMigrations(data) {
  const projects = data.projects || [];
  const exports = data.exports || [];
  const uploads = data.uploads || [];
  const selectedIds = new Set(
    [...elements.migrationProjectChoices.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value),
  );
  const hadChoices = elements.migrationProjectChoices.childElementCount > 0;
  elements.migrationProjectMetric.textContent = String(projects.length);
  elements.migrationExportMetric.textContent = String(exports.length);
  elements.migrationUploadMetric.textContent = String(uploads.length);
  elements.migrationImportMetric.textContent = data.lastImport ? formatRelativeTime(data.lastImport.importedAt) : "--";
  elements.migrationTabCount.textContent = String(exports.length);
  elements.migrationProjectChoices.replaceChildren();
  for (const project of projects) {
    const label = document.createElement("label");
    label.className = "migration-project-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "migrationProject";
    input.value = project.id;
    input.checked = hadChoices ? selectedIds.has(project.id) : true;
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    setDataContent(name, project.displayName || project.name);
    const detail = document.createElement("small");
    detail.textContent = project.applicationWorkspace
      ? `安装目录工作区 · ${formatDateTime(project.modifiedAt)}`
      : `${project.git ? "Git 工程" : "普通目录"} · ${formatDateTime(project.modifiedAt)}`;
    copy.append(name, detail);
    label.append(input, copy);
    elements.migrationProjectChoices.append(label);
  }
  updateMigrationSelection();
  elements.createMigrationButton.disabled = data.busy === true || !projects.length;
  renderMigrationOperation(data.operation);

  elements.migrationExportSummary.textContent = `${exports.length} 个迁移包`;
  elements.migrationExportRows.replaceChildren();
  for (const migration of exports) elements.migrationExportRows.append(createMigrationExportRow(migration));
  elements.migrationExportEmpty.hidden = exports.length > 0;

  elements.migrationUploadRows.replaceChildren();
  for (const upload of uploads) elements.migrationUploadRows.append(createMigrationUploadRow(upload));
  elements.migrationUploadEmpty.hidden = uploads.length > 0;
  if (!state.migrationUploadId && state.migrationUploadClientId) {
    const recovered = uploads.find((upload) => upload.clientUploadId === state.migrationUploadClientId);
    if (recovered) {
      state.migrationUploadId = recovered.id;
      state.migrationFileFingerprint = recovered.fileFingerprint;
      persistMigrationUploadRecovery(null, recovered);
    }
  }
  const activeUpload = uploads.find((upload) => upload.id === state.migrationUploadId);
  if (activeUpload) {
    setDataContent(elements.migrationUploadSummary, `${activeUpload.filename} · ${formatBytes(activeUpload.receivedBytes)} / ${formatBytes(activeUpload.sizeBytes)}`);
    elements.inspectMigrationButton.disabled = activeUpload.status !== "complete" && activeUpload.status !== "imported";
    renderMigrationUploadProgress(activeUpload, { active: state.migrationUploadActive });
    if (activeUpload.inspection && !state.migrationInspection) {
      state.migrationInspection = activeUpload.inspection;
    }
  } else if (state.migrationUploadId && !state.migrationUploadActive) {
    clearMigrationUploadRecovery();
  }
  window.lucide?.createIcons();
}

function updateMigrationSelection() {
  const selected = elements.migrationProjectChoices.querySelectorAll('input[type="checkbox"]:checked').length;
  elements.migrationSelectionSummary.textContent = `${selected} 个工程`;
  elements.createMigrationButton.disabled = Boolean(state.migrations?.busy) || selected === 0;
}

function renderMigrationOperation(operation) {
  if (!operation) return;
  const status = operation.status === "failed" ? "error" : "success";
  showMigrationStatus(
    elements.migrationOperationStatus,
    operation.error || operation.detail || "工作区迁移任务正在执行",
    operation.status === "running" ? "success" : status,
  );
  if (operation.type === "import") {
    showMigrationStatus(
      elements.migrationImportStatus,
      operation.error || operation.detail,
      operation.status === "failed" ? "error" : "success",
    );
  }
}

function createMigrationExportRow(migration) {
  const row = document.createElement("article");
  row.className = "backup-row";
  const icon = document.createElement("span");
  icon.className = "backup-row-icon";
  icon.innerHTML = '<i data-lucide="package-check"></i>';
  const copy = document.createElement("div");
  copy.className = "backup-row-copy";
  const title = document.createElement("strong");
  setDataContent(title, migration.id);
  const detail = document.createElement("span");
  detail.textContent = `v${migration.appVersion} · ${formatBytes(migration.sizeBytes)} · ${migration.projects} 工程 · ${migration.conversations} 对话`;
  const checksum = document.createElement("code");
  checksum.textContent = `SHA-256 ${migration.sha256.slice(0, 20)}...`;
  copy.append(title, detail, checksum);
  const time = document.createElement("time");
  time.textContent = formatDateTime(migration.createdAt);
  const actions = document.createElement("div");
  actions.className = "backup-row-actions";
  actions.append(
    backupLinkButton("download", "下载迁移包", `/api/ops/workspace-migrations/exports/${encodeURIComponent(migration.id)}/download`),
    backupIconButton("key-round", "下载恢复密钥", () => downloadWorkspaceMigrationKey(migration.id)),
    backupIconButton("trash-2", "删除迁移包", () => deleteWorkspaceMigrationExport(migration.id), true),
  );
  const meta = document.createElement("div");
  meta.className = "backup-row-meta";
  meta.append(time, actions);
  row.append(icon, copy, meta);
  return row;
}

function createMigrationUploadRow(upload) {
  const row = document.createElement("article");
  row.className = "backup-row";
  const icon = document.createElement("span");
  icon.className = "backup-row-icon";
  icon.innerHTML = `<i data-lucide="${upload.status === "imported" ? "folder-check" : "file-up"}"></i>`;
  const copy = document.createElement("div");
  copy.className = "backup-row-copy";
  const title = document.createElement("strong");
  setDataContent(title, upload.filename);
  const detail = document.createElement("span");
  detail.textContent = `${migrationUploadStatusLabel(upload)} · ${formatBytes(upload.receivedBytes)} / ${formatBytes(upload.sizeBytes)}`;
  const checksum = document.createElement("code");
  checksum.textContent = upload.inspection
    ? `${upload.inspection.migrationId} · ${upload.inspection.projects.length} 工程 · ${upload.inspection.conversations} 对话`
    : upload.sha256 ? `SHA-256 ${upload.sha256.slice(0, 20)}...` : upload.id;
  copy.append(title, detail, checksum);
  const time = document.createElement("time");
  time.textContent = formatDateTime(upload.updatedAt);
  const actions = document.createElement("div");
  actions.className = "backup-row-actions";
  actions.append(
    backupIconButton("mouse-pointer-click", "选择此上传", () => selectMigrationUpload(upload)),
    backupIconButton("trash-2", "删除上传", () => deleteWorkspaceMigrationUpload(upload.id), true),
  );
  const meta = document.createElement("div");
  meta.className = "backup-row-meta";
  meta.append(time, actions);
  row.append(icon, copy, meta);
  return row;
}

async function createWorkspaceMigration(event) {
  event.preventDefault();
  const projectIds = [...elements.migrationProjectChoices.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
  elements.createMigrationButton.disabled = true;
  try {
    await requestOpsJson("/api/ops/workspace-migrations/exports", {
      method: "POST",
      action: "ops-workspace-export-create",
      body: {
        projectIds,
        includeGit: elements.migrationIncludeGit.checked,
        includeEnv: elements.migrationIncludeEnv.checked,
        password: elements.migrationExportPassword.value,
      },
    });
    elements.migrationExportPassword.value = "";
    showMigrationStatus(elements.migrationOperationStatus, "工作区迁移包任务已启动", "success");
    await loadMigrations();
  } catch (error) {
    elements.migrationExportPassword.value = "";
    showMigrationStatus(elements.migrationOperationStatus, error.message, "error");
  } finally {
    elements.createMigrationButton.disabled = false;
  }
}

async function downloadWorkspaceMigrationKey(id) {
  const password = elements.migrationExportPassword.value;
  if (!password) {
    showMigrationStatus(elements.migrationOperationStatus, "请输入所有者密码后再下载恢复密钥", "error");
    elements.migrationExportPassword.focus();
    return;
  }
  try {
    const response = await fetch(`/api/ops/workspace-migrations/exports/${encodeURIComponent(id)}/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-workspace-export-key" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "恢复密钥下载失败");
    }
    downloadBlob(await response.blob(), `${id}-recovery-key.txt`);
    showMigrationStatus(elements.migrationOperationStatus, "恢复密钥已下载", "success");
  } catch (error) {
    showMigrationStatus(elements.migrationOperationStatus, error.message, "error");
  } finally {
    elements.migrationExportPassword.value = "";
  }
}

async function deleteWorkspaceMigrationExport(id) {
  const password = elements.migrationExportPassword.value;
  if (!password) {
    showMigrationStatus(elements.migrationOperationStatus, "请输入所有者密码后再删除迁移包", "error");
    elements.migrationExportPassword.focus();
    return;
  }
  if (!confirm(`确认删除迁移包 ${id}？`)) return;
  try {
    await requestOpsJson(`/api/ops/workspace-migrations/exports/${encodeURIComponent(id)}`, {
      method: "DELETE", action: "ops-workspace-export-delete", body: { password },
    });
    showMigrationStatus(elements.migrationOperationStatus, "迁移包已删除", "success");
    await loadMigrations();
  } catch (error) {
    showMigrationStatus(elements.migrationOperationStatus, error.message, "error");
  } finally {
    elements.migrationExportPassword.value = "";
  }
}

async function selectMigrationPackage() {
  const selectionVersion = ++state.migrationFileSelectionVersion;
  const file = elements.migrationPackageFile.files?.[0];
  const preferredUploadId = state.migrationUploadId;
  state.migrationUploadId = null;
  state.migrationUploadClientId = null;
  state.migrationFileFingerprint = null;
  state.migrationInspection = null;
  elements.migrationPreview.hidden = true;
  elements.inspectMigrationButton.disabled = true;
  if (!file) {
    state.migrationFileFingerprint = null;
    elements.migrationUploadProgress.hidden = true;
    setDataContent(elements.migrationUploadSummary, "未选择文件", false);
    return;
  }
  setDataContent(
    elements.migrationUploadSummary,
    `${file.name} · 正在校验文件`,
  );
  try {
    const fingerprint = await migrationFileFingerprint(file);
    if (selectionVersion !== state.migrationFileSelectionVersion || elements.migrationPackageFile.files?.[0] !== file) return;
    state.migrationFileFingerprint = fingerprint;
    const uploads = state.migrations?.uploads || [];
    const resumable = uploads.find((entry) => (
      entry.status === "uploading"
      && entry.filename === file.name
      && entry.sizeBytes === file.size
      && entry.fileFingerprint === fingerprint
      && entry.id === preferredUploadId
    )) || uploads.find((entry) => (
      entry.status === "uploading"
      && entry.filename === file.name
      && entry.sizeBytes === file.size
      && entry.fileFingerprint === fingerprint
    ));
    state.migrationUploadId = resumable?.id || null;
    state.migrationUploadClientId = resumable?.clientUploadId || crypto.randomUUID();
    persistMigrationUploadRecovery(file);
    if (resumable) renderMigrationUploadProgress(resumable, { active: false });
    else elements.migrationUploadProgress.hidden = true;
    setDataContent(
      elements.migrationUploadSummary,
      resumable
        ? `${file.name} · ${formatBytes(resumable.receivedBytes)} / ${formatBytes(file.size)}`
        : `${file.name} · ${formatBytes(file.size)}`,
    );
  } catch (error) {
    if (selectionVersion !== state.migrationFileSelectionVersion) return;
    state.migrationFileFingerprint = null;
    showMigrationStatus(elements.migrationImportStatus, `无法校验迁移包：${error.message}`, "error");
  }
}

async function uploadWorkspaceMigration() {
  const file = elements.migrationPackageFile.files?.[0];
  if (!file) {
    showMigrationStatus(elements.migrationImportStatus, "请选择 .wflworkspace 文件", "error");
    return;
  }
  if (state.migrationUploadActive) return;
  state.migrationFileSelectionVersion += 1;
  state.migrationUploadActive = true;
  state.migrationUploadCancelled = false;
  state.migrationUploadController = new AbortController();
  setMigrationUploadControls(true);
  elements.migrationUploadProgress.hidden = false;
  try {
    const fingerprint = state.migrationFileFingerprint || await migrationFileFingerprint(file);
    if (state.migrationUploadController.signal.aborted) throw abortError();
    state.migrationFileFingerprint = fingerprint;
    state.migrationUploadClientId ||= crypto.randomUUID();
    let upload = state.migrations?.uploads?.find((entry) => (
      (entry.id === state.migrationUploadId || !state.migrationUploadId)
      && entry.filename === file.name
      && entry.sizeBytes === file.size
      && entry.fileFingerprint === fingerprint
      && entry.status === "uploading"
    ));
    let chunkBytes = state.migrations?.limits?.chunkBytes || 8 * 1024 * 1024;
    if (!upload) {
      persistMigrationUploadRecovery(file);
      const data = await retryMigrationUploadRequest(() => requestOpsJson(
        "/api/ops/workspace-migrations/uploads",
        {
          method: "POST",
          action: "ops-workspace-upload-start",
          signal: state.migrationUploadController.signal,
          body: {
            filename: file.name,
            sizeBytes: file.size,
            clientUploadId: state.migrationUploadClientId,
            fileFingerprint: fingerprint,
            password: elements.migrationImportPassword.value,
          },
        },
      ), state.migrationUploadController.signal);
      upload = data.upload;
      chunkBytes = data.chunkBytes;
      state.migrationUploadId = upload.id;
      state.migrationUploadClientId = upload.clientUploadId;
      persistMigrationUploadRecovery(file);
      elements.migrationImportPassword.value = "";
    }
    let offset = upload.receivedBytes;
    beginMigrationUploadMetrics(offset);
    renderMigrationUploadProgress(upload, { active: true });
    while (offset < file.size) {
      const end = Math.min(file.size, offset + chunkBytes);
      upload = await uploadMigrationChunk(upload, file, offset, end, state.migrationUploadController.signal);
      offset = upload.receivedBytes;
      renderMigrationUploadProgress(upload, { active: true, committed: true });
    }
    elements.inspectMigrationButton.disabled = false;
    showMigrationStatus(elements.migrationImportStatus, "迁移包上传完成，可以开始预检", "success");
    await loadMigrations();
  } catch (error) {
    const cancelled = state.migrationUploadCancelled || error.name === "AbortError";
    // Publish the cancelled state only after the cancel control has been
    // hidden. Otherwise the status text can become observable while the
    // asynchronous refresh below still renders the upload as active.
    if (cancelled) {
      state.migrationUploadActive = false;
      state.migrationUploadController = null;
      setMigrationUploadControls(false);
    }
    showMigrationStatus(
      elements.migrationImportStatus,
      cancelled ? "上传已取消，已接收的分块可以继续上传" : `${error.message}，已保留服务器确认的上传进度`,
      cancelled ? "success" : "error",
    );
    await loadMigrations();
  } finally {
    elements.migrationImportPassword.value = "";
    state.migrationUploadActive = false;
    state.migrationUploadController = null;
    setMigrationUploadControls(false);
  }
}

function cancelWorkspaceMigrationUpload() {
  if (!state.migrationUploadActive || !state.migrationUploadController) return;
  state.migrationUploadCancelled = true;
  elements.cancelMigrationUploadButton.disabled = true;
  state.migrationUploadController.abort();
}

function setMigrationUploadControls(active) {
  elements.migrationPackageFile.disabled = active;
  elements.uploadMigrationButton.disabled = active;
  elements.cancelMigrationUploadButton.hidden = !active;
  elements.cancelMigrationUploadButton.disabled = false;
}

function beginMigrationUploadMetrics(receivedBytes) {
  const now = performance.now();
  state.migrationUploadMetrics = {
    displayedBytes: receivedBytes,
    lastBytes: receivedBytes,
    lastAt: now,
    bytesPerSecond: 0,
  };
}

function renderMigrationUploadProgress(upload, { active = false, committed = false, transmittedBytes = null } = {}) {
  if (!upload?.sizeBytes) return;
  elements.migrationUploadProgress.hidden = false;
  const metrics = state.migrationUploadMetrics;
  let receivedBytes = Math.max(0, Math.min(upload.sizeBytes, transmittedBytes ?? upload.receivedBytes));
  if (active && metrics) {
    if (committed && receivedBytes < metrics.displayedBytes) {
      metrics.displayedBytes = receivedBytes;
      metrics.lastBytes = receivedBytes;
      metrics.lastAt = performance.now();
    } else {
      metrics.displayedBytes = Math.max(metrics.displayedBytes, receivedBytes);
      receivedBytes = metrics.displayedBytes;
    }
    const now = performance.now();
    const elapsedMs = now - metrics.lastAt;
    const addedBytes = receivedBytes - metrics.lastBytes;
    if (elapsedMs >= 100 && addedBytes > 0) {
      const currentSpeed = addedBytes * 1000 / elapsedMs;
      metrics.bytesPerSecond = metrics.bytesPerSecond
        ? metrics.bytesPerSecond * 0.65 + currentSpeed * 0.35
        : currentSpeed;
      metrics.lastBytes = receivedBytes;
      metrics.lastAt = now;
    }
  }
  const percent = Math.min(100, receivedBytes / upload.sizeBytes * 100);
  const roundedPercent = Math.round(percent);
  const speed = active ? state.migrationUploadMetrics?.bytesPerSecond || 0 : 0;
  const etaSeconds = speed > 0 ? Math.ceil((upload.sizeBytes - receivedBytes) / speed) : null;
  elements.migrationUploadProgressTrack.firstElementChild.style.width = `${percent}%`;
  elements.migrationUploadProgressTrack.setAttribute("aria-valuenow", String(roundedPercent));
  elements.migrationUploadProgressDetail.textContent = [
    `${roundedPercent}%`,
    `${formatBytes(receivedBytes)} / ${formatBytes(upload.sizeBytes)}`,
    active && speed > 0 ? `${formatBytes(speed)}/s` : null,
    active && etaSeconds != null ? `估算剩余 ${formatDuration(etaSeconds)}` : upload.status === "uploading" ? "等待续传" : null,
  ].filter(Boolean).join(" · ");
  setDataContent(elements.migrationUploadSummary, `${upload.filename} · ${formatBytes(receivedBytes)} / ${formatBytes(upload.sizeBytes)}`);
  elements.cancelMigrationUploadButton.hidden = !active;
}

async function uploadMigrationChunk(upload, file, offset, end, signal) {
  let latest = upload;
  let lastError = null;
  for (let attempt = 0; attempt <= MIGRATION_UPLOAD_MAX_RETRIES; attempt += 1) {
    if (signal.aborted) throw abortError();
    try {
      return await sendMigrationUploadChunk(upload, file.slice(offset, end), offset, signal, (loaded) => {
        renderMigrationUploadProgress(
          { ...upload, receivedBytes: offset, sizeBytes: file.size },
          { active: true, transmittedBytes: offset + loaded },
        );
      });
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") throw abortError();
      lastError = error;
      latest = await readMigrationUpload(upload.id, signal).catch(() => latest);
      if (latest.receivedBytes > offset || latest.status === "complete") return latest;
      if (!retryableMigrationUploadError(error) || attempt === MIGRATION_UPLOAD_MAX_RETRIES) break;
      showMigrationStatus(
        elements.migrationImportStatus,
        `分块上传失败，正在重试 ${attempt + 1}/${MIGRATION_UPLOAD_MAX_RETRIES}`,
        "success",
      );
      renderMigrationUploadProgress(latest, { active: true, committed: true });
      await migrationUploadDelay(MIGRATION_UPLOAD_RETRY_BASE_MS * 2 ** attempt, signal);
    }
  }
  throw lastError || new Error("迁移包分块上传失败");
}

function sendMigrationUploadChunk(upload, blob, offset, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open("PUT", `/api/ops/workspace-migrations/uploads/${encodeURIComponent(upload.id)}?offset=${offset}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-Codex-Desktop-Action", "ops-workspace-upload-chunk");
    request.upload.addEventListener("progress", (event) => onProgress(event.loaded));
    request.addEventListener("load", () => {
      signal.removeEventListener("abort", abort);
      const data = parseJsonObject(request.responseText);
      if (request.status >= 200 && request.status < 300 && data.upload) resolve(data.upload);
      else reject(migrationUploadHttpError(request.status, data.error || "迁移包分块上传失败"));
    });
    request.addEventListener("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("迁移包分块上传网络中断"));
    });
    request.addEventListener("abort", () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    });
    signal.addEventListener("abort", abort, { once: true });
    request.send(blob);
  });
}

async function readMigrationUpload(uploadId, signal) {
  const response = await fetch(`/api/ops/workspace-migrations?_=${Date.now()}`, { cache: "no-store", signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw migrationUploadHttpError(response.status, data.error || "无法确认服务器上传进度");
  const upload = data.uploads?.find((entry) => entry.id === uploadId);
  if (!upload) throw migrationUploadHttpError(404, "服务器上传记录不存在");
  state.migrations = data;
  return upload;
}

async function retryMigrationUploadRequest(operation, signal) {
  let lastError;
  for (let attempt = 0; attempt <= MIGRATION_UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") throw abortError();
      lastError = error;
      if (!retryableMigrationUploadError(error) || attempt === MIGRATION_UPLOAD_MAX_RETRIES) break;
      await migrationUploadDelay(MIGRATION_UPLOAD_RETRY_BASE_MS * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

function retryableMigrationUploadError(error) {
  const status = Number(error?.status);
  return !Number.isFinite(status) || [408, 409, 425, 429].includes(status) || status >= 500;
}

function migrationUploadHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function abortError() {
  return new DOMException("Upload cancelled", "AbortError");
}

function migrationUploadDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function migrationFileFingerprint(file) {
  const sampleBytes = 64 * 1024;
  const [headBuffer, tailBuffer] = await Promise.all([
    file.slice(0, Math.min(file.size, sampleBytes)).arrayBuffer(),
    file.slice(Math.max(0, file.size - sampleBytes), file.size).arrayBuffer(),
  ]);
  const metadata = new TextEncoder().encode(`${file.name}\0${file.size}\0`);
  const head = new Uint8Array(headBuffer);
  const tail = new Uint8Array(tailBuffer);
  const input = new Uint8Array(metadata.length + head.length + tail.length);
  input.set(metadata, 0);
  input.set(head, metadata.length);
  input.set(tail, metadata.length + head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadMigrationUploadRecovery() {
  try {
    const record = JSON.parse(sessionStorage.getItem(MIGRATION_UPLOAD_RECOVERY_KEY));
    if (!record || typeof record !== "object") return null;
    if (record.uploadId != null && !/^wu-[a-f0-9]{32}$/.test(record.uploadId)) return null;
    if (record.clientUploadId != null && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.clientUploadId)) return null;
    if (record.fileFingerprint != null && !/^[a-f0-9]{64}$/.test(record.fileFingerprint)) return null;
    if (!Number.isFinite(record.savedAt) || Date.now() - record.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
    return record;
  } catch {
    return null;
  }
}

function persistMigrationUploadRecovery(file = null, upload = null) {
  try {
    sessionStorage.setItem(MIGRATION_UPLOAD_RECOVERY_KEY, JSON.stringify({
      uploadId: upload?.id || state.migrationUploadId || null,
      clientUploadId: upload?.clientUploadId || state.migrationUploadClientId || null,
      fileFingerprint: upload?.fileFingerprint || state.migrationFileFingerprint || null,
      filename: file?.name || upload?.filename || null,
      sizeBytes: file?.size || upload?.sizeBytes || null,
      savedAt: Date.now(),
    }));
  } catch {
    // The server upload record remains authoritative when session storage is unavailable.
  }
}

function clearMigrationUploadRecovery() {
  try {
    sessionStorage.removeItem(MIGRATION_UPLOAD_RECOVERY_KEY);
  } catch {
    // Ignore browsers that disable session storage.
  }
  state.migrationUploadId = null;
  state.migrationUploadClientId = null;
  state.migrationFileFingerprint = null;
}

function selectMigrationUpload(upload) {
  state.migrationUploadId = upload.id;
  state.migrationUploadClientId = upload.clientUploadId || null;
  state.migrationFileFingerprint = upload.fileFingerprint || null;
  state.migrationInspection = upload.inspection || null;
  persistMigrationUploadRecovery(null, upload);
  setDataContent(elements.migrationUploadSummary, `${upload.filename} · ${formatBytes(upload.receivedBytes)} / ${formatBytes(upload.sizeBytes)}`);
  renderMigrationUploadProgress(upload, { active: false });
  elements.inspectMigrationButton.disabled = upload.status !== "complete" && upload.status !== "imported";
  if (upload.inspection) renderMigrationInspection(upload.inspection);
  else elements.migrationPreview.hidden = true;
}

async function inspectWorkspaceMigration() {
  if (!state.migrationUploadId) {
    showMigrationStatus(elements.migrationImportStatus, "请先上传或选择迁移包", "error");
    return;
  }
  elements.inspectMigrationButton.disabled = true;
  try {
    const data = await requestOpsJson(`/api/ops/workspace-migrations/uploads/${encodeURIComponent(state.migrationUploadId)}/inspect`, {
      method: "POST", action: "ops-workspace-upload-inspect", body: { recoveryKey: elements.migrationRecoveryKey.value.trim() },
    });
    state.migrationInspection = data.inspection;
    renderMigrationInspection(data.inspection);
    showMigrationStatus(elements.migrationImportStatus, "预检通过，目标目录和对话记录均可导入", "success");
    await loadMigrations();
  } catch (error) {
    state.migrationInspection = null;
    elements.migrationPreview.hidden = true;
    showMigrationStatus(elements.migrationImportStatus, error.message, "error");
  } finally {
    elements.inspectMigrationButton.disabled = false;
  }
}

function renderMigrationInspection(inspection) {
  state.migrationInspection = inspection;
  elements.migrationPreview.hidden = false;
  setDataContent(elements.migrationPreviewTitle, inspection.migrationId);
  elements.migrationPreviewDetail.textContent = `v${inspection.appVersion} · ${inspection.projects.length} 工程 · ${inspection.conversations} 对话 · ${formatBytes(inspection.expandedBytes)}`;
  elements.migrationTypedId.value = "";
  elements.migrationTypedId.placeholder = "请手动输入上方完整编号";
  elements.migrationPlanRows.replaceChildren();
  for (const item of inspection.plan || []) {
    const row = document.createElement("div");
    row.className = "migration-plan-row";
    const source = document.createElement("span");
    setDataContent(source, item.sourceName);
    const arrow = document.createElement("i");
    arrow.dataset.lucide = "arrow-right";
    const target = document.createElement("span");
    setDataContent(target, item.targetName);
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.dataset.status = item.renamed ? "degraded" : "healthy";
    badge.textContent = item.renamed ? "自动改名" : "新建";
    row.append(source, arrow, target, badge);
    elements.migrationPlanRows.append(row);
  }
  window.lucide?.createIcons();
}

async function executeWorkspaceMigration() {
  const inspection = state.migrationInspection;
  if (!inspection || !state.migrationUploadId) {
    showMigrationStatus(elements.migrationImportStatus, "请先完成迁移包预检", "error");
    return;
  }
  elements.executeMigrationButton.disabled = true;
  try {
    await requestOpsJson(`/api/ops/workspace-migrations/uploads/${encodeURIComponent(state.migrationUploadId)}/import`, {
      method: "POST", action: "ops-workspace-import-execute", body: {
        recoveryKey: elements.migrationRecoveryKey.value.trim(),
        typedMigrationId: elements.migrationTypedId.value.trim(),
        password: elements.migrationImportPassword.value,
      },
    });
    elements.migrationImportPassword.value = "";
    elements.migrationRecoveryKey.value = "";
    elements.migrationPreview.hidden = true;
    state.migrationInspection = null;
    showMigrationStatus(elements.migrationImportStatus, "工作区导入任务已启动", "success");
    await loadMigrations();
  } catch (error) {
    elements.migrationImportPassword.value = "";
    showMigrationStatus(elements.migrationImportStatus, error.message, "error");
  } finally {
    elements.executeMigrationButton.disabled = false;
  }
}

async function deleteWorkspaceMigrationUpload(id) {
  const password = elements.migrationImportPassword.value;
  if (!password) {
    showMigrationStatus(elements.migrationImportStatus, "请输入所有者密码后再删除上传记录", "error");
    elements.migrationImportPassword.focus();
    return;
  }
  if (!confirm("确认删除此上传记录？")) return;
  try {
    await requestOpsJson(`/api/ops/workspace-migrations/uploads/${encodeURIComponent(id)}`, {
      method: "DELETE", action: "ops-workspace-upload-delete", body: { password },
    });
    if (state.migrationUploadId === id) {
      clearMigrationUploadRecovery();
      state.migrationInspection = null;
      elements.migrationPreview.hidden = true;
      elements.migrationUploadProgress.hidden = true;
    }
    await loadMigrations();
  } catch (error) {
    showMigrationStatus(elements.migrationImportStatus, error.message, "error");
  } finally {
    elements.migrationImportPassword.value = "";
  }
}

function migrationUploadStatusLabel(upload) {
  if (upload?.status === "uploading") {
    return state.migrationUploadActive && upload.id === state.migrationUploadId ? "上传中" : "等待续传";
  }
  return { complete: "待预检", imported: "已导入" }[upload?.status] || "未知";
}

function showMigrationStatus(node, message, status) {
  node.hidden = false;
  node.dataset.status = status;
  node.textContent = message;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadRollback() {
  try {
    const response = await fetch(`/api/ops/rollback?_=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法读取回滚状态");
    state.rollback = data;
    renderRollback(data);
  } catch (error) {
    showRollbackStatus(error.message, "error");
  }
}

function renderRollback(data) {
  elements.rollbackEnabled.checked = data.guard.enabled;
  elements.rollbackEnabled.disabled = !data.available;
  elements.rollbackEnabledLabel.textContent = data.guard.enabled
    ? `开启至 ${formatTime(data.guard.expiresAt)}`
    : "已关闭";
  elements.rollbackVersion.replaceChildren();
  const releases = data.releases || [];
  if (!releases.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无可用版本";
    elements.rollbackVersion.append(option);
  } else {
    for (const release of releases) {
      const option = document.createElement("option");
      option.value = release.version;
      option.textContent = `v${release.version}`;
      elements.rollbackVersion.append(option);
    }
  }
  const running = data.operation?.status === "running";
  elements.rollbackVersion.disabled = !data.guard.enabled || running || !releases.length;
  elements.openRollbackButton.disabled = !data.guard.enabled || running || !releases.length;
  if (data.operation) renderOperation(data.operation, elements.rollbackStatus, elements.rollbackDetail);
}

async function toggleRollback() {
  const enabled = elements.rollbackEnabled.checked;
  elements.rollbackEnabled.disabled = true;
  try {
    await requestOpsJson("/api/ops/rollback/enabled", {
      method: "PUT",
      action: "ops-rollback-toggle",
      body: { enabled },
    });
    await loadRollback();
    showRollbackStatus(enabled ? "手动回滚已临时开启" : "手动回滚已关闭", "success");
  } catch (error) {
    elements.rollbackEnabled.checked = !enabled;
    showRollbackStatus(error.message, "error");
  } finally {
    elements.rollbackEnabled.disabled = false;
  }
}

function openRollbackDialog() {
  const version = elements.rollbackVersion.value;
  if (!version) return;
  resetRollbackDialog();
  elements.rollbackTargetLabel.textContent = `v${version}`;
  elements.rollbackTypedVersion.placeholder = version;
  elements.rollbackDialog.showModal();
  elements.rollbackTypedVersion.focus();
}

async function prepareRollback() {
  const targetVersion = elements.rollbackVersion.value;
  elements.rollbackContinueButton.disabled = true;
  try {
    const data = await requestOpsJson("/api/ops/rollback/prepare", {
      method: "POST",
      action: "ops-rollback-prepare",
      body: { targetVersion, typedVersion: elements.rollbackTypedVersion.value.trim() },
    });
    state.rollbackNonce = data.confirmation.nonce;
    setRollbackStep(2);
    elements.rollbackPassword.focus();
  } catch (error) {
    showRollbackDialogStatus(error.message, "error");
  } finally {
    elements.rollbackContinueButton.disabled = false;
  }
}

async function executeRollback() {
  const targetVersion = elements.rollbackVersion.value;
  const password = elements.rollbackPassword.value;
  elements.executeRollbackButton.disabled = true;
  try {
    await requestOpsJson("/api/ops/rollback/execute", {
      method: "POST",
      action: "ops-rollback-execute",
      body: { targetVersion, nonce: state.rollbackNonce, password },
    });
    elements.rollbackPassword.value = "";
    elements.rollbackDialog.close();
    showRollbackStatus(`回滚到 v${targetVersion} 的后台任务已启动`, "success");
    await loadRollback();
    await loadOverview({ force: true });
  } catch (error) {
    elements.rollbackPassword.value = "";
    state.rollbackNonce = null;
    showRollbackDialogStatus(error.message, "error");
    await loadRollback();
  } finally {
    elements.executeRollbackButton.disabled = false;
  }
}

function setRollbackStep(step) {
  elements.rollbackStepOne.hidden = step !== 1;
  elements.rollbackStepTwo.hidden = step !== 2;
  elements.rollbackDialogStatus.hidden = true;
}

function resetRollbackDialog() {
  state.rollbackNonce = null;
  elements.rollbackTypedVersion.value = "";
  elements.rollbackPassword.value = "";
  setRollbackStep(1);
}

function showRollbackStatus(message, status) {
  elements.rollbackPanelStatus.hidden = false;
  elements.rollbackPanelStatus.dataset.status = status;
  elements.rollbackPanelStatus.textContent = message;
}

function showRollbackDialogStatus(message, status) {
  elements.rollbackDialogStatus.hidden = false;
  elements.rollbackDialogStatus.dataset.status = status;
  elements.rollbackDialogStatus.textContent = message;
}

function renderAlerts(alerts) {
  if (!alerts) return;
  state.alerts = alerts;
  const enabled = alerts.rules.filter((rule) => rule.enabled).length;
  elements.activeAlertMetric.textContent = String(alerts.active);
  elements.enabledAlertMetric.textContent = String(enabled);
  elements.webhookMetric.textContent = alerts.webhook.configured ? "已配置" : "未配置";
  elements.alertRuleMetric.textContent = String(alerts.rules.length);
  elements.alertTabCount.textContent = String(alerts.active);
  elements.activeAlertSummary.textContent = `${alerts.active} 项需要处理`;
  elements.webhookStatus.textContent = alerts.webhook.configured ? alerts.webhook.host : "未配置";
  elements.webhookStatus.dataset.status = alerts.webhook.configured ? "healthy" : "idle";
  elements.testWebhookButton.disabled = !alerts.webhook.configured;
  elements.removeWebhookButton.disabled = !alerts.webhook.configured;

  const active = alerts.rules.filter((rule) => rule.active);
  elements.activeAlertRows.replaceChildren();
  for (const rule of active) {
    const row = document.createElement("article");
    row.className = "active-alert-row";
    row.dataset.severity = rule.severity;
    const icon = document.createElement("i");
    icon.dataset.lucide = "triangle-alert";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = rule.label;
    const detail = document.createElement("span");
    detail.textContent = `${alertValueLabel(rule)} · ${formatRelativeTime(rule.openedAt)}`;
    content.append(title, detail);
    row.append(icon, content);
    elements.activeAlertRows.append(row);
  }
  elements.activeAlertEmpty.hidden = active.length > 0;
  if (!state.alertFormDirty) renderAlertRules(alerts.rules);
  window.lucide?.createIcons();
}

function renderAlertRules(rules) {
  elements.alertRuleRows.replaceChildren();
  for (const rule of rules) {
    const row = document.createElement("article");
    row.className = "alert-rule-row";
    row.dataset.ruleId = rule.id;

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "rule-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "rule-enabled";
    checkbox.checked = rule.enabled;
    checkbox.setAttribute("aria-label", `启用${rule.label}`);
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = rule.label;
    const stateLabel = document.createElement("small");
    stateLabel.textContent = rule.active ? "告警中" : rule.enabled ? "监控中" : "已停用";
    identity.append(name, stateLabel);
    enabledLabel.append(checkbox, identity);
    row.append(enabledLabel);

    const controls = document.createElement("div");
    controls.className = "rule-controls";
    if (rule.thresholdSupported) controls.append(numberControl("阈值 %", "rule-threshold", rule.thresholdPercent, 50, 99));
    controls.append(
      numberControl("连续次数", "rule-consecutive", rule.consecutive, 1, 60),
      numberControl("冷却分钟", "rule-cooldown", rule.cooldownMinutes, 5, 1440),
    );
    row.append(controls);
    elements.alertRuleRows.append(row);
  }
}

function numberControl(label, className, value, min, max) {
  const control = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.className = className;
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  control.append(text, input);
  return control;
}

async function saveAlertSettings({ remove = false } = {}) {
  setAlertFormBusy(true);
  try {
    const rules = {};
    for (const row of elements.alertRuleRows.querySelectorAll("[data-rule-id]")) {
      rules[row.dataset.ruleId] = {
        enabled: row.querySelector(".rule-enabled").checked,
        consecutive: Number(row.querySelector(".rule-consecutive").value),
        cooldownMinutes: Number(row.querySelector(".rule-cooldown").value),
        ...(row.querySelector(".rule-threshold") ? { thresholdPercent: Number(row.querySelector(".rule-threshold").value) } : {}),
      };
    }
    const webhookUrl = elements.webhookUrl.value.trim();
    const payload = { rules };
    if (remove || webhookUrl) payload.webhookUrl = remove ? "" : webhookUrl;
    const alerts = await requestOpsJson("/api/ops/alerts/settings", {
      method: "PUT",
      action: "ops-alert-settings",
      body: payload,
    });
    elements.webhookUrl.value = "";
    state.alertFormDirty = false;
    if (state.data) state.data.alerts = alerts;
    renderAlerts(alerts);
    showAlertStatus(remove ? "Webhook 已移除" : "告警设置已保存", "success");
  } catch (error) {
    showAlertStatus(error.message, "error");
  } finally {
    setAlertFormBusy(false);
  }
}

async function testWebhook() {
  setAlertFormBusy(true);
  try {
    await requestOpsJson("/api/ops/alerts/webhook/test", { method: "POST", action: "ops-webhook-test" });
    showAlertStatus("Webhook 测试成功", "success");
  } catch (error) {
    showAlertStatus(error.message, "error");
  } finally {
    setAlertFormBusy(false);
  }
}

function removeWebhook() {
  if (confirm("确认移除当前 Webhook？")) saveAlertSettings({ remove: true });
}

async function loadWebSettings() {
  if (state.webSettingsLoading) return;
  state.webSettingsLoading = true;
  try {
    const data = await requestOpsJson(`/api/ops/web-settings?_=${Date.now()}`);
    state.webSettings = data.settings;
    renderWebSettings(data.settings);
  } catch (error) {
    elements.webSettingsStatus.dataset.status = "error";
    elements.webSettingsStatus.textContent = error.message;
  } finally {
    state.webSettingsLoading = false;
  }
}

function renderWebSettings(settings) {
  const preset = settings?.imagePreviewPreset || "standard";
  const displaySize = settings?.imagePreviewDisplaySize || "auto";
  elements.imagePreviewPreset.value = preset;
  elements.imagePreviewDisplaySize.value = displaySize;
  const label = {
    minimal: "极省",
    economy: "节省",
    standard: "标准",
    clear: "清晰",
    high: "高清",
  }[preset] || "标准";
  const sizeLabel = {
    auto: "自动尺寸",
    compact: "紧凑尺寸",
    standard: "标准尺寸",
    wide: "宽屏尺寸",
  }[displaySize] || "自动尺寸";
  elements.webSettingsStatus.dataset.status = "healthy";
  elements.webSettingsStatus.textContent = `${label} · ${sizeLabel}`;
}

async function saveWebSettings(event) {
  event.preventDefault();
  elements.saveWebSettingsButton.disabled = true;
  elements.imagePreviewPreset.disabled = true;
  elements.imagePreviewDisplaySize.disabled = true;
  elements.webSettingsStatus.dataset.status = "loading";
  elements.webSettingsStatus.textContent = "保存中";
  try {
    const data = await requestOpsJson("/api/ops/web-settings", {
      method: "PUT",
      action: "ops-web-settings",
      body: {
        imagePreviewPreset: elements.imagePreviewPreset.value,
        imagePreviewDisplaySize: elements.imagePreviewDisplaySize.value,
      },
    });
    state.webSettings = data.settings;
    renderWebSettings(data.settings);
  } catch (error) {
    elements.webSettingsStatus.dataset.status = "error";
    elements.webSettingsStatus.textContent = error.message;
  } finally {
    elements.saveWebSettingsButton.disabled = false;
    elements.imagePreviewPreset.disabled = false;
    elements.imagePreviewDisplaySize.disabled = false;
  }
}

async function loadPublicOrigin() {
  if (state.publicOriginLoading) return;
  state.publicOriginLoading = true;
  try {
    const data = await requestOpsJson(`/api/ops/public-origin?_=${Date.now()}`);
    renderPublicOrigin(data);
  } catch (error) {
    elements.publicOriginStatus.dataset.status = "error";
    elements.publicOriginStatus.textContent = error.message;
  } finally {
    state.publicOriginLoading = false;
  }
}

function renderPublicOrigin(data) {
  const config = data?.config;
  const configured = data?.configured === true && config?.mode === "confirmed";
  elements.publicOriginStatus.dataset.status = configured ? "healthy" : "degraded";
  elements.publicOriginStatus.textContent = configured ? "已确认" : "沙箱模式";
  if (configured) {
    elements.publicOriginInput.value = config.publicOrigin || "";
    elements.previewBaseDomainInput.value = config.previewBaseDomain || "";
    elements.previewSlotCountInput.value = String(config.slotCount || 4);
    elements.previewIsolationInput.value = config.isolation === "session" ? "session" : "pool";
  }
  const candidates = data?.candidates || [];
  elements.publicOriginCandidates.replaceChildren();
  elements.publicOriginCandidates.hidden = candidates.length === 0;
  for (const candidate of candidates.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "public-origin-candidate";
    row.textContent = `${candidate.origin} · ${candidate.source}${candidate.requiresOwnerConfirmation ? " · 需所有者确认" : ""}`;
    elements.publicOriginCandidates.append(row);
  }
  elements.disablePublicOriginButton.disabled = !configured;
  if (!configured) {
    showPublicOriginStatus(data?.fallback === "sandbox" ? "未确认公开域名，当前保持安全沙箱" : "尚未配置", "info");
  }
}

async function confirmPublicOrigin(event) {
  event.preventDefault();
  setPublicOriginBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/public-origin/confirm", {
      method: "POST",
      action: "ops-public-origin-confirm",
      body: {
        publicOrigin: elements.publicOriginInput.value.trim(),
        previewBaseDomain: elements.previewBaseDomainInput.value.trim() || null,
        slotCount: Number(elements.previewSlotCountInput.value),
        isolation: elements.previewIsolationInput.value,
      },
    });
    renderPublicOrigin(data);
    showPublicOriginStatus("公开 Origin 已确认；请先完成 DNS 与证书配置，再打开预览链接", "success");
  } catch (error) {
    showPublicOriginStatus(error.message, "error");
  } finally {
    setPublicOriginBusy(false);
  }
}

async function disablePublicOrigin() {
  if (!confirm("确认停用固定预览域名并回到沙箱模式？")) return;
  setPublicOriginBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/public-origin/disable", {
      method: "POST",
      action: "ops-public-origin-disable",
      body: { reason: "owner-disabled" },
    });
    renderPublicOrigin(data);
    showPublicOriginStatus("已停用，新的预览会话将回到沙箱模式", "success");
  } catch (error) {
    showPublicOriginStatus(error.message, "error");
  } finally {
    setPublicOriginBusy(false);
  }
}

function setPublicOriginBusy(busy) {
  for (const element of [
    elements.confirmPublicOriginButton,
    elements.disablePublicOriginButton,
    elements.publicOriginInput,
    elements.previewBaseDomainInput,
    elements.previewSlotCountInput,
    elements.previewIsolationInput,
  ]) element.disabled = busy;
  elements.publicOriginStatus.dataset.status = busy ? "loading" : elements.publicOriginStatus.dataset.status;
  if (busy) elements.publicOriginStatus.textContent = "保存中";
}

function showPublicOriginStatus(message, status) {
  elements.publicOriginFormStatus.hidden = false;
  elements.publicOriginFormStatus.dataset.status = status;
  elements.publicOriginFormStatus.textContent = message;
}

async function loadTencentCloud() {
  if (state.tencentCloudLoading) return;
  state.tencentCloudLoading = true;
  try {
    const data = await requestOpsJson(`/api/ops/tencent-cloud?_=${Date.now()}`);
    renderTencentCloud(data);
  } catch (error) {
    showTencentCloudStatus(error.message, "error");
    elements.tencentCloudStatus.dataset.status = "error";
    elements.tencentCloudStatus.textContent = "读取失败";
  } finally {
    state.tencentCloudLoading = false;
  }
}

function renderTencentCloud(data) {
  const provider = data?.provider || {};
  const configured = provider.configured === true;
  state.tencentCloudConfigured = configured;
  elements.tencentCloudStatus.dataset.status = configured ? "healthy" : "degraded";
  elements.tencentCloudStatus.textContent = configured ? "凭据已保存" : "未配置";
  elements.clearTencentCloudButton.disabled = !configured;
  elements.planTencentCloudButton.disabled = !configured;
  elements.applyTencentCloudButton.disabled = !configured;
  elements.tencentSecretIdInput.value = "";
  elements.tencentSecretIdInput.required = !configured;
  elements.tencentSecretIdInput.placeholder = configured && provider.secretId
    ? `已保存 ${provider.secretId}`
    : "AKID...";
  elements.tencentSecretKeyInput.value = "";
  elements.tencentSecretKeyInput.required = !configured;
  elements.tencentSecretKeyInput.placeholder = configured ? "留空保持原密钥" : "SecretKey";
  elements.tencentRegionInput.value = provider.region || "ap-guangzhou";
  if (provider.zoneDomain) elements.tencentZoneDomainInput.value = provider.zoneDomain;
  else if (data?.publicOrigin?.publicOrigin) elements.tencentZoneDomainInput.value = new URL(data.publicOrigin.publicOrigin).hostname;
  elements.tencentTargetTypeInput.value = provider.targetType || "A";
  if (provider.target) elements.tencentTargetInput.value = provider.target;
  else if (!elements.tencentTargetInput.value && data?.targetCandidates?.length) {
    const candidate = data.targetCandidates.find((entry) => entry.type === "A") || data.targetCandidates[0];
    elements.tencentTargetTypeInput.value = candidate.type;
    elements.tencentTargetInput.value = candidate.value;
  }
  if (provider.certificateEmail) elements.tencentCertificateEmailInput.value = provider.certificateEmail;
  if (data?.health) renderTencentHealth(data.health);
  if (data?.setup?.status && data.setup.status !== "idle") {
    elements.tencentCloudOutput.hidden = false;
    elements.tencentCloudOutput.textContent = JSON.stringify(data.setup, null, 2);
  }
}

async function saveTencentCloud(event) {
  event.preventDefault();
  setTencentCloudBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/tencent-cloud/config", {
      method: "PUT",
      action: "ops-tencent-cloud-config",
      body: tencentCloudFormValues({ includeSecrets: true }),
    });
    renderTencentCloud(data);
    showTencentCloudStatus("腾讯云 DNSPod 凭据已保存到服务器私有文件；浏览器不会重新读取 SecretKey", "success");
  } catch (error) {
    showTencentCloudStatus(error.message, "error");
  } finally {
    setTencentCloudBusy(false);
  }
}

async function clearTencentCloud() {
  if (!confirm("确认删除服务器保存的腾讯云 SecretId 和 SecretKey？已创建的 DNS 记录和证书不会自动删除。")) return;
  setTencentCloudBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/tencent-cloud/config", {
      method: "DELETE",
      action: "ops-tencent-cloud-config-clear",
    });
    renderTencentCloud(data);
    showTencentCloudStatus("服务器保存的腾讯云凭据已删除；腾讯云控制台中的记录未改变", "success");
  } catch (error) {
    showTencentCloudStatus(error.message, "error");
  } finally {
    setTencentCloudBusy(false);
  }
}

async function checkTencentCloud({ showOutput = false } = {}) {
  setTencentCloudBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/tencent-cloud/check", { method: "POST" });
    renderTencentCloud(data);
    if (showOutput) {
      elements.tencentCloudOutput.hidden = false;
      elements.tencentCloudOutput.textContent = JSON.stringify(data.health, null, 2);
    }
    renderTencentHealth(data.health);
  } catch (error) {
    showTencentCloudStatus(error.message, "error");
  } finally {
    setTencentCloudBusy(false);
  }
}

function renderTencentHealth(health) {
  if (!health?.configured) {
    showTencentCloudStatus("公开 Origin 尚未确认，当前只能保存腾讯云配置", "info");
    return;
  }
  const healthy = health.ok === true;
  const passed = (health.origins || []).filter((origin) => origin.ok).length;
  const total = health.origins?.length || 0;
  elements.tencentCloudStatus.dataset.status = healthy ? "healthy" : "degraded";
  elements.tencentCloudStatus.textContent = healthy ? "DNS/证书正常" : "需要处理";
  showTencentCloudStatus(
    healthy ? `${passed}/${total} 个 Origin 的 DNS、证书和 HTTPS 均正常` : `${passed}/${total} 个 Origin 正常；请查看检查结果`,
    healthy ? "success" : "info",
  );
}

async function previewTencentCloudPlan() {
  setTencentCloudBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/tencent-cloud/plan", {
      method: "POST",
      body: tencentCloudFormValues(),
    });
    elements.tencentCloudOutput.hidden = false;
    elements.tencentCloudOutput.textContent = data.plan.map((record) => (
      `${record.host}\n  ${record.subDomain} ${record.recordType} ${record.value} TTL=${record.ttl}`
    )).join("\n");
    showTencentCloudStatus(`计划包含 ${data.plan.length} 条 DNS 记录；尚未写入腾讯云`, "info");
  } catch (error) {
    showTencentCloudStatus(error.message, "error");
  } finally {
    setTencentCloudBusy(false);
  }
}

async function applyTencentCloud() {
  setTencentCloudBusy(true);
  try {
    const values = tencentCloudFormValues();
    const preview = await requestOpsJson("/api/ops/tencent-cloud/plan", { method: "POST", body: values });
    const replacement = values.replaceExisting ? "；允许替换同名默认线路记录" : "；遇到已有不同记录会停止";
    if (!confirm(`确认向腾讯云 DNSPod 写入 ${preview.plan.length} 条记录${replacement}？\n\n证书和反向代理会在 DNS 配置完成后继续检查。`)) return;
    const data = await requestOpsJson("/api/ops/tencent-cloud/apply", {
      method: "POST",
      action: "ops-tencent-cloud-apply",
      body: { ...values, confirm: true, issueCertificate: true },
      timeoutMs: 120_000,
    });
    renderTencentCloud(data);
    elements.tencentCloudOutput.hidden = false;
    elements.tencentCloudOutput.textContent = JSON.stringify(data.setup, null, 2);
    showTencentCloudStatus("腾讯云 DNS、证书和受管 Nginx 后台向导已启动", "info");
    void pollTencentCloudSetup(data.setup?.id);
  } catch (error) {
    showTencentCloudStatus(error.message, "error");
  } finally {
    setTencentCloudBusy(false);
  }
}

async function pollTencentCloudSetup(setupId) {
  if (!setupId) return;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (document.visibilityState === "hidden") continue;
    try {
      const data = await requestOpsJson(`/api/ops/tencent-cloud?_=${Date.now()}`);
      if (data.setup?.id !== setupId) return;
      renderTencentCloud(data);
      elements.tencentCloudOutput.hidden = false;
      elements.tencentCloudOutput.textContent = JSON.stringify(data.setup, null, 2);
      if (data.setup.status === "completed") {
        showTencentCloudStatus(data.setup.detail || "腾讯云 DNS、证书和反向代理向导已完成", "success");
        await checkTencentCloud({ showOutput: true });
        return;
      }
      if (data.setup.status === "failed") {
        showTencentCloudStatus(data.setup.error || data.setup.detail || "腾讯云向导失败", "error");
        return;
      }
    } catch (error) {
      if (attempt > 3) {
        showTencentCloudStatus(error.message, "error");
        return;
      }
    }
  }
  showTencentCloudStatus("后台向导仍在运行，请稍后点击检查状态", "info");
}

function tencentCloudFormValues({ includeSecrets = false } = {}) {
  return {
    ...(includeSecrets ? {
      secretId: elements.tencentSecretIdInput.value.trim(),
      secretKey: elements.tencentSecretKeyInput.value.trim(),
      region: elements.tencentRegionInput.value,
      certificateEmail: elements.tencentCertificateEmailInput.value.trim(),
    } : {}),
    zoneDomain: elements.tencentZoneDomainInput.value.trim(),
    targetType: elements.tencentTargetTypeInput.value,
    target: elements.tencentTargetInput.value.trim(),
    certificateEmail: elements.tencentCertificateEmailInput.value.trim(),
    managePublicOrigin: elements.tencentManagePublicOriginInput.checked,
    replaceExisting: elements.tencentReplaceExistingInput.checked,
  };
}

function setTencentCloudBusy(busy) {
  for (const element of [
    elements.tencentSecretIdInput,
    elements.tencentSecretKeyInput,
    elements.tencentRegionInput,
    elements.tencentZoneDomainInput,
    elements.tencentTargetTypeInput,
    elements.tencentTargetInput,
    elements.tencentCertificateEmailInput,
    elements.tencentManagePublicOriginInput,
    elements.tencentReplaceExistingInput,
    elements.saveTencentCloudButton,
    elements.checkTencentCloudButton,
    elements.planTencentCloudButton,
    elements.applyTencentCloudButton,
  ]) element.disabled = busy;
  elements.planTencentCloudButton.disabled = busy || !state.tencentCloudConfigured;
  elements.applyTencentCloudButton.disabled = busy || !state.tencentCloudConfigured;
  elements.clearTencentCloudButton.disabled = busy || !state.tencentCloudConfigured;
  if (busy) {
    elements.tencentCloudStatus.dataset.status = "loading";
    elements.tencentCloudStatus.textContent = "处理中";
  }
}

function showTencentCloudStatus(message, status) {
  elements.tencentCloudFormStatus.hidden = false;
  elements.tencentCloudFormStatus.dataset.status = status;
  elements.tencentCloudFormStatus.textContent = message;
}

async function requestOpsJson(url, { method, action, body, timeoutMs = null, signal = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(action ? { "X-Codex-Desktop-Action": action } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal || (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw migrationUploadHttpError(response.status, data.error || "操作失败");
  return data;
}

function setAlertFormBusy(busy) {
  for (const button of [elements.saveAlertSettingsButton, elements.testWebhookButton, elements.removeWebhookButton]) {
    button.disabled = busy || (button !== elements.saveAlertSettingsButton && !state.alerts?.webhook?.configured);
  }
}

function showAlertStatus(message, status) {
  elements.alertSettingsStatus.hidden = false;
  elements.alertSettingsStatus.dataset.status = status;
  elements.alertSettingsStatus.textContent = message;
}

async function loadMapRender({ force = false, populateForm = false } = {}) {
  if (state.mapRenderLoading && !force) return;
  if (force) cancelMapRenderRequest();
  state.mapRenderLoading = true;
  clearTimeout(state.mapRenderTimer);
  const controller = new AbortController();
  const requestId = ++state.mapRenderRequestId;
  state.mapRenderController = controller;
  const timeout = setTimeout(() => controller.abort(), MAP_RENDER_TIMEOUT_MS);
  try {
    const data = await requestOpsJson(`/api/ops/map-render?_=${Date.now()}`, { signal: controller.signal });
    if (requestId !== state.mapRenderRequestId) return;
    renderMapRender(data, { populateForm: populateForm || !state.mapRender });
  } catch (error) {
    if (requestId !== state.mapRenderRequestId || error.name === "AbortError" && state.view !== "map-render") return;
    showMapRenderStatus(error.name === "AbortError" ? "地图 Render 状态读取超时" : error.message, "error");
    elements.mapRenderControlStatus.dataset.status = "failed";
    elements.mapRenderControlStatus.textContent = "读取失败";
  } finally {
    clearTimeout(timeout);
    if (requestId === state.mapRenderRequestId) {
      state.mapRenderLoading = false;
      state.mapRenderController = null;
      scheduleMapRenderPoll();
    }
  }
}

function cancelMapRenderRequest() {
  clearTimeout(state.mapRenderTimer);
  state.mapRenderTimer = null;
  state.mapRenderController?.abort();
  state.mapRenderController = null;
  state.mapRenderLoading = false;
  state.mapRenderRequestId += 1;
}

function scheduleMapRenderPoll() {
  clearTimeout(state.mapRenderTimer);
  state.mapRenderTimer = null;
  if (state.view !== "map-render") return;
  const delay = document.visibilityState === "hidden" ? MAP_RENDER_HIDDEN_POLL_MS : MAP_RENDER_POLL_MS;
  state.mapRenderTimer = setTimeout(() => void loadMapRender(), delay);
}

function renderMapRender(data, { populateForm = false } = {}) {
  if (!data?.settings || !data?.queue || !data?.realtime) return;
  state.mapRender = data;
  const { settings, queue, realtime } = data;
  elements.mapRenderCpuMetric.textContent = Number.isFinite(realtime.cpuPercent)
    ? `${formatNumber(realtime.cpuPercent)}%`
    : "--";
  elements.mapRenderMemoryMetric.textContent = Number.isFinite(realtime.availableMemoryBytes)
    ? formatBytes(realtime.availableMemoryBytes)
    : "--";
  elements.mapRenderLatencyMetric.textContent = Number.isFinite(realtime.mainSiteLatencyMs)
    ? `${formatNumber(realtime.mainSiteLatencyMs)} ms`
    : "--";
  elements.mapRenderWorkerMetric.textContent = String(Math.max(0, Number(realtime.workerCount) || 0));
  elements.mapRenderQueueMetric.textContent = String(Math.max(0, Number(realtime.queueLength) || 0));
  elements.mapRenderPresetMetric.textContent = mapRenderPresetLabel(realtime.preset);
  elements.mapRenderTabCount.textContent = String(Math.max(0, Number(queue.queueLength) || 0));
  elements.mapRenderSettingsRevision.textContent = `修订 ${settings.revision}`;

  const enabled = settings.config.worker.enabled === true;
  const accepting = settings.acceptNewTasks === true;
  elements.mapRenderControlStatus.dataset.status = enabled && accepting ? "healthy" : enabled ? "degraded" : "disabled";
  elements.mapRenderControlStatus.textContent = !enabled ? "Worker 已关闭" : accepting ? "接收新任务" : "已暂停接收";
  elements.pauseMapRenderButton.disabled = state.mapRenderMutation || !accepting;
  elements.continueMapRenderButton.disabled = state.mapRenderMutation || accepting;
  elements.clearMapRenderCacheButton.disabled = state.mapRenderMutation;
  for (const button of document.querySelectorAll("[data-map-render-preset]")) {
    button.classList.toggle("is-active", button.dataset.mapRenderPreset === settings.preset);
    button.disabled = state.mapRenderMutation;
  }
  if (populateForm) {
    populateMapRenderForm(settings.config);
    state.mapRenderFormDirty = false;
    state.mapRenderFormRevision = settings.revision;
  }
  if (!state.mapRenderFormDirty) {
    elements.mapRenderSettingsStatus.dataset.status = settings.preset === "custom" ? "degraded" : "healthy";
    elements.mapRenderSettingsStatus.textContent = `${mapRenderPresetLabel(settings.preset)} · 修订 ${settings.revision}`;
  }
  elements.saveMapRenderSettingsButton.disabled = state.mapRenderMutation;
}

function populateMapRenderForm(config) {
  for (const input of elements.mapRenderSettingsForm.querySelectorAll("[data-map-render-setting]")) {
    const value = nestedValue(config, input.name);
    if (input.type === "checkbox") input.checked = value === true;
    else input.value = value === undefined || value === null ? "" : String(value);
  }
}

function readMapRenderForm() {
  if (!elements.mapRenderSettingsForm.reportValidity()) throw new Error("请检查地图 Render 设置的数值范围");
  const config = {};
  for (const input of elements.mapRenderSettingsForm.querySelectorAll("[data-map-render-setting]")) {
    const value = input.type === "checkbox"
      ? input.checked
      : input.type === "number" ? input.valueAsNumber : input.value;
    if (input.type === "number" && !Number.isFinite(value)) throw new Error(`设置 ${input.name} 不是有效数值`);
    assignNestedValue(config, input.name, value);
  }
  if (config.worker.screenshotConcurrency > config.worker.renderConcurrency) {
    throw new Error("截图并发不能大于渲染并发");
  }
  if (config.mapIo.autoSaveIntervalMs !== 0 && config.mapIo.autoSaveIntervalMs < 5_000) {
    throw new Error("自动保存间隔必须为 0，或不少于 5000ms");
  }
  return config;
}

async function saveMapRenderSettings(event) {
  event.preventDefault();
  let config;
  try {
    config = readMapRenderForm();
  } catch (error) {
    showMapRenderStatus(error.message, "error");
    return;
  }
  setMapRenderBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/map-render/settings", {
      method: "PUT",
      action: "ops-map-render-settings",
      body: { config, expectedRevision: state.mapRenderFormRevision },
    });
    state.mapRenderFormDirty = false;
    renderMapRender(data, { populateForm: true });
    showMapRenderStatus("自定义设置已保存；新任务将使用修订后的参数", "success");
  } catch (error) {
    await handleMapRenderMutationError(error);
  } finally {
    setMapRenderBusy(false);
  }
}

async function applyMapRenderPreset(preset) {
  if (!["stable", "balanced", "performance"].includes(preset) || state.mapRenderMutation) return;
  const current = state.mapRender?.settings?.preset;
  if (current === preset && !state.mapRenderFormDirty) return;
  if ((current === "custom" || state.mapRenderFormDirty) && !confirm(`确认切换到“${mapRenderPresetLabel(preset)}”预设并替换表单参数？`)) return;
  setMapRenderBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/map-render/settings", {
      method: "PUT",
      action: "ops-map-render-settings",
      body: {
        preset,
        expectedRevision: state.mapRenderFormDirty
          ? state.mapRenderFormRevision
          : state.mapRender?.settings?.revision,
      },
    });
    state.mapRenderFormDirty = false;
    renderMapRender(data, { populateForm: true });
    showMapRenderStatus(`已手动切换到“${mapRenderPresetLabel(preset)}”预设`, "success");
  } catch (error) {
    await handleMapRenderMutationError(error);
  } finally {
    setMapRenderBusy(false);
  }
}

async function pauseMapRenderAdmission() {
  if (state.mapRenderMutation || state.mapRender?.settings?.acceptNewTasks !== true) return;
  const expectedRevision = state.mapRender.settings.revision;
  setMapRenderBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/map-render/admission", {
      method: "PUT",
      action: "ops-map-render-admission",
      body: { acceptNewTasks: false, expectedRevision },
    });
    if (state.mapRenderFormDirty && state.mapRenderFormRevision === expectedRevision) {
      state.mapRenderFormRevision = data.settings.revision;
    }
    renderMapRender(data);
    showMapRenderStatus("已暂停接收新任务；运行中和已排队任务保持原参数", "success");
  } catch (error) {
    await handleMapRenderMutationError(error);
  } finally {
    setMapRenderBusy(false);
  }
}

async function continueMapRenderQueue() {
  if (state.mapRenderMutation || state.mapRender?.settings?.acceptNewTasks === true) return;
  const expectedRevision = state.mapRender.settings.revision;
  setMapRenderBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/map-render/continue", {
      method: "POST",
      action: "ops-map-render-continue",
      body: { expectedRevision },
    });
    if (state.mapRenderFormDirty && state.mapRenderFormRevision === expectedRevision) {
      state.mapRenderFormRevision = data.settings.revision;
    }
    renderMapRender(data);
    showMapRenderStatus("队列已继续接收新任务", "success");
  } catch (error) {
    await handleMapRenderMutationError(error);
  } finally {
    setMapRenderBusy(false);
  }
}

async function clearMapRenderCache() {
  if (state.mapRenderMutation || !confirm("确认清理地图 Render Worker 的瓦片与图片缓存？工程源文件和任务输出不会被删除。")) return;
  setMapRenderBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/map-render/cache/clear", {
      method: "POST",
      action: "ops-map-render-cache-clear",
    });
    renderMapRender(data);
    showMapRenderStatus(`已清理 ${data.cache?.files || 0} 个缓存文件，共 ${formatBytes(data.cache?.bytes || 0)}`, "success");
  } catch (error) {
    await handleMapRenderMutationError(error);
  } finally {
    setMapRenderBusy(false);
  }
}

async function handleMapRenderMutationError(error) {
  if (Number(error?.status) === 409) {
    state.mapRenderFormDirty = false;
    await loadMapRender({ force: true, populateForm: true });
    showMapRenderStatus("设置已被其他管理窗口更新，已加载服务器最新修订", "error");
    return;
  }
  showMapRenderStatus(error.message, "error");
}

function setMapRenderBusy(busy) {
  if (busy) cancelMapRenderRequest();
  state.mapRenderMutation = busy;
  for (const control of elements.mapRenderSettingsForm.elements) control.disabled = busy;
  for (const button of document.querySelectorAll("[data-map-render-preset]")) button.disabled = busy;
  elements.pauseMapRenderButton.disabled = busy || state.mapRender?.settings?.acceptNewTasks !== true;
  elements.continueMapRenderButton.disabled = busy || state.mapRender?.settings?.acceptNewTasks === true;
  elements.clearMapRenderCacheButton.disabled = busy;
  elements.saveMapRenderSettingsButton.disabled = busy;
  if (busy) {
    elements.mapRenderControlStatus.dataset.status = "running";
    elements.mapRenderControlStatus.textContent = "处理中";
  } else if (state.mapRender) {
    renderMapRender(state.mapRender);
    scheduleMapRenderPoll();
  }
}

function showMapRenderStatus(message, status) {
  elements.mapRenderOperationStatus.hidden = false;
  elements.mapRenderOperationStatus.dataset.status = status;
  elements.mapRenderOperationStatus.textContent = message;
}

function mapRenderPresetLabel(preset) {
  return { stable: "稳定", balanced: "均衡", performance: "性能", custom: "自定义" }[preset] || "--";
}

async function loadImageExecution({ force = false, populateForm = false } = {}) {
  if (state.imageExecutionLoading && !force) return;
  if (force) cancelImageExecutionRequest();
  state.imageExecutionLoading = true;
  clearTimeout(state.imageExecutionTimer);
  const controller = new AbortController();
  const requestId = ++state.imageExecutionRequestId;
  state.imageExecutionController = controller;
  const timeout = setTimeout(() => controller.abort(), IMAGE_EXECUTION_TIMEOUT_MS);
  try {
    const data = await requestOpsJson(`/api/ops/image-execution?_=${Date.now()}`, { signal: controller.signal });
    if (requestId !== state.imageExecutionRequestId) return;
    renderImageExecution(data, { populateForm: populateForm || !state.imageExecution });
  } catch (error) {
    if (requestId !== state.imageExecutionRequestId || error.name === "AbortError" && state.view !== "image-execution") return;
    showImageExecutionStatus(error.name === "AbortError" ? "图片 Worker 状态读取超时" : error.message, "error");
    elements.imageExecutionControlStatus.dataset.status = "failed";
    elements.imageExecutionControlStatus.textContent = "读取失败";
  } finally {
    clearTimeout(timeout);
    if (requestId === state.imageExecutionRequestId) {
      state.imageExecutionLoading = false;
      state.imageExecutionController = null;
      scheduleImageExecutionPoll();
    }
  }
}

function cancelImageExecutionRequest() {
  clearTimeout(state.imageExecutionTimer);
  state.imageExecutionTimer = null;
  state.imageExecutionController?.abort();
  state.imageExecutionController = null;
  state.imageExecutionLoading = false;
  state.imageExecutionRequestId += 1;
}

function scheduleImageExecutionPoll() {
  clearTimeout(state.imageExecutionTimer);
  state.imageExecutionTimer = null;
  if (state.view !== "image-execution") return;
  const delay = document.visibilityState === "hidden"
    ? IMAGE_EXECUTION_HIDDEN_POLL_MS
    : IMAGE_EXECUTION_POLL_MS;
  state.imageExecutionTimer = setTimeout(() => void loadImageExecution(), delay);
}

function renderImageExecution(data, { populateForm = false } = {}) {
  if (!data?.settings || !data?.realtime) return;
  state.imageExecution = data;
  const { settings, realtime } = data;
  const queueLength = Math.max(0, Number(realtime.queueLength ?? data.queue?.queueLength) || 0);
  elements.imageExecutionCpuMetric.textContent = Number.isFinite(realtime.cpuPercent)
    ? `${formatNumber(realtime.cpuPercent)}%`
    : "--";
  elements.imageExecutionMemoryMetric.textContent = Number.isFinite(realtime.availableMemoryBytes)
    ? formatBytes(realtime.availableMemoryBytes)
    : "--";
  elements.imageExecutionLatencyMetric.textContent = Number.isFinite(realtime.mainSiteLatencyMs)
    ? `${formatNumber(realtime.mainSiteLatencyMs)} ms`
    : "--";
  elements.imageExecutionWorkerMetric.textContent = String(Math.max(0, Number(realtime.workerCount) || 0));
  elements.imageExecutionQueueMetric.textContent = String(queueLength);
  elements.imageExecutionPresetMetric.textContent = imageExecutionPresetLabel(realtime.preset ?? settings.preset);
  elements.imageExecutionTabCount.textContent = String(queueLength);
  elements.imageExecutionSettingsRevision.textContent = `修订 ${settings.revision}`;

  const enabled = settings.config?.worker?.enabled === true;
  const accepting = settings.acceptNewTasks === true;
  elements.imageExecutionControlStatus.dataset.status = enabled && accepting ? "healthy" : enabled ? "degraded" : "disabled";
  elements.imageExecutionControlStatus.textContent = !enabled ? "Worker 已关闭" : accepting ? "接收新任务" : "已暂停接收";
  elements.pauseImageExecutionButton.disabled = state.imageExecutionMutation || !accepting;
  elements.continueImageExecutionButton.disabled = state.imageExecutionMutation || accepting;
  for (const button of document.querySelectorAll("[data-image-execution-preset]")) {
    button.classList.toggle("is-active", button.dataset.imageExecutionPreset === settings.preset);
    button.disabled = state.imageExecutionMutation;
  }
  if (populateForm) {
    populateImageExecutionForm(settings.config);
    state.imageExecutionFormDirty = false;
    state.imageExecutionFormRevision = settings.revision;
  }
  if (!state.imageExecutionFormDirty) {
    elements.imageExecutionSettingsStatus.dataset.status = settings.preset === "custom" ? "degraded" : "healthy";
    elements.imageExecutionSettingsStatus.textContent = `${imageExecutionPresetLabel(settings.preset)} · 修订 ${settings.revision}`;
  }
  elements.saveImageExecutionSettingsButton.disabled = state.imageExecutionMutation;
}

function populateImageExecutionForm(config) {
  for (const input of elements.imageExecutionSettingsForm.querySelectorAll("[data-image-execution-setting]")) {
    const value = nestedValue(config, input.name);
    if (input.type === "checkbox") input.checked = value === true;
    else input.value = value === undefined || value === null ? "" : String(value);
  }
}

function readImageExecutionForm() {
  if (!elements.imageExecutionSettingsForm.reportValidity()) {
    throw new Error("请检查图片 Worker 设置的数值范围");
  }
  const config = {};
  for (const input of elements.imageExecutionSettingsForm.querySelectorAll("[data-image-execution-setting]")) {
    const value = input.type === "checkbox" ? input.checked : input.valueAsNumber;
    if (input.type === "number" && !Number.isFinite(value)) throw new Error(`设置 ${input.name} 不是有效数值`);
    assignNestedValue(config, input.name, value);
  }
  return config;
}

async function saveImageExecutionSettings(event) {
  event.preventDefault();
  if (state.imageExecutionMutation) return;
  let config;
  try {
    config = readImageExecutionForm();
  } catch (error) {
    showImageExecutionStatus(error.message, "error");
    return;
  }
  setImageExecutionBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/image-execution/settings", {
      method: "PUT",
      action: "ops-image-execution-settings",
      body: { config, expectedRevision: state.imageExecutionFormRevision },
    });
    state.imageExecutionFormDirty = false;
    renderImageExecution(data, { populateForm: true });
    showImageExecutionStatus("自定义设置已保存；新任务将使用修订后的参数", "success");
  } catch (error) {
    await handleImageExecutionMutationError(error);
  } finally {
    setImageExecutionBusy(false);
  }
}

async function applyImageExecutionPreset(preset) {
  if (!["stable", "balanced", "performance"].includes(preset) || state.imageExecutionMutation) return;
  const current = state.imageExecution?.settings?.preset;
  if (current === preset && !state.imageExecutionFormDirty) return;
  if ((current === "custom" || state.imageExecutionFormDirty)
    && !confirm(`确认切换到“${imageExecutionPresetLabel(preset)}”预设并替换表单参数？`)) return;
  setImageExecutionBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/image-execution/settings", {
      method: "PUT",
      action: "ops-image-execution-settings",
      body: {
        preset,
        expectedRevision: state.imageExecutionFormDirty
          ? state.imageExecutionFormRevision
          : state.imageExecution?.settings?.revision,
      },
    });
    state.imageExecutionFormDirty = false;
    renderImageExecution(data, { populateForm: true });
    showImageExecutionStatus(`已手动切换到“${imageExecutionPresetLabel(preset)}”预设`, "success");
  } catch (error) {
    await handleImageExecutionMutationError(error);
  } finally {
    setImageExecutionBusy(false);
  }
}

async function setImageExecutionAdmission(acceptNewTasks) {
  if (state.imageExecutionMutation || state.imageExecution?.settings?.acceptNewTasks === acceptNewTasks) return;
  const expectedRevision = state.imageExecution?.settings?.revision;
  if (!Number.isSafeInteger(expectedRevision)) return;
  setImageExecutionBusy(true);
  try {
    const data = await requestOpsJson("/api/ops/image-execution/control", {
      method: "POST",
      action: "ops-image-execution-control",
      body: { acceptNewTasks, expectedRevision },
    });
    if (state.imageExecutionFormDirty && state.imageExecutionFormRevision === expectedRevision) {
      state.imageExecutionFormRevision = data.settings.revision;
    }
    renderImageExecution(data);
    showImageExecutionStatus(
      acceptNewTasks
        ? "已继续接收新任务"
        : "已暂停接收新任务；运行中和已排队任务保持原参数",
      "success",
    );
  } catch (error) {
    await handleImageExecutionMutationError(error);
  } finally {
    setImageExecutionBusy(false);
  }
}

async function handleImageExecutionMutationError(error) {
  if (Number(error?.status) === 409) {
    state.imageExecutionFormDirty = false;
    await loadImageExecution({ force: true, populateForm: true });
    showImageExecutionStatus("设置已被其他管理窗口更新，已加载服务器最新修订", "error");
    return;
  }
  showImageExecutionStatus(error.message, "error");
}

function setImageExecutionBusy(busy) {
  if (busy) cancelImageExecutionRequest();
  state.imageExecutionMutation = busy;
  for (const control of elements.imageExecutionSettingsForm.elements) control.disabled = busy;
  for (const button of document.querySelectorAll("[data-image-execution-preset]")) button.disabled = busy;
  elements.pauseImageExecutionButton.disabled = busy || state.imageExecution?.settings?.acceptNewTasks !== true;
  elements.continueImageExecutionButton.disabled = busy || state.imageExecution?.settings?.acceptNewTasks === true;
  elements.saveImageExecutionSettingsButton.disabled = busy;
  if (busy) {
    elements.imageExecutionControlStatus.dataset.status = "running";
    elements.imageExecutionControlStatus.textContent = "处理中";
  } else if (state.imageExecution) {
    renderImageExecution(state.imageExecution);
    scheduleImageExecutionPoll();
  }
}

function showImageExecutionStatus(message, status) {
  elements.imageExecutionOperationStatus.hidden = false;
  elements.imageExecutionOperationStatus.dataset.status = status;
  elements.imageExecutionOperationStatus.textContent = message;
}

function imageExecutionPresetLabel(preset) {
  return { stable: "稳定", balanced: "均衡", performance: "性能", custom: "自定义" }[preset] || "--";
}

function nestedValue(value, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, key) => current?.[key], value);
}

function assignNestedValue(target, dottedPath, value) {
  const keys = String(dottedPath || "").split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) current = current[key] ||= {};
  current[keys.at(-1)] = value;
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorBanner.hidden = false;
}

function downsampleSamples(samples, maxPoints) {
  if (samples.length <= maxPoints) return samples;
  const size = Math.ceil(samples.length / maxPoints);
  const result = [];
  for (let index = 0; index < samples.length; index += size) {
    const bucket = samples.slice(index, index + size);
    const average = (selector) => bucket.reduce((total, sample) => total + selector(sample), 0) / bucket.length;
    result.push({
      at: bucket[Math.floor(bucket.length / 2)].at,
      cpuPercent: average((sample) => sample.cpuPercent),
      memory: { percent: average((sample) => sample.memory.percent) },
      disk: { percent: average((sample) => sample.disk.percent) },
    });
  }
  return result;
}

function eventIcon(source) {
  return { gateway: "cloud", codex: "terminal-square", conversation: "database-zap", resource: "gauge", deployment: "package-check", task: "list-checks", user: "user-cog", alert: "bell-ring" }[source] || "activity";
}

function sourceLabel(source) {
  return { gateway: "入口网关", codex: "Codex Runtime", conversation: "对话存储", resource: "主机资源", deployment: "部署", task: "任务", user: "用户", alert: "告警" }[source] || "系统";
}

function severityLabel(severity) {
  return { critical: "严重", warning: "警告", info: "信息" }[severity] || "信息";
}

function severityStatus(severity) {
  return { critical: "failed", warning: "degraded", info: "healthy" }[severity] || "healthy";
}

function alertValueLabel(rule) {
  if (typeof rule.currentValue === "number" && rule.thresholdSupported) return `当前 ${Number(rule.currentValue).toFixed(1)}%`;
  return "状态异常";
}

function userCell(user) {
  const cell = document.createElement("td");
  const primary = document.createElement("span");
  primary.className = "cell-primary";
  setDataContent(primary, user.displayName || user.username);
  const secondary = document.createElement("span");
  secondary.className = "cell-secondary";
  setDataContent(secondary, user.username);
  cell.append(primary, secondary);
  return cell;
}

function badgeCell(label, status) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.dataset.status = status;
  badge.textContent = label;
  cell.append(badge);
  return cell;
}

function textCell(value, protectedContent = false) {
  const cell = document.createElement("td");
  setDataContent(cell, value, protectedContent);
  return cell;
}

function statusLabel(status) {
  return { healthy: "正常", degraded: "部分可用", offline: "不可用", direct: "直接访问" }[status] || "未知";
}

function taskStatusLabel(status) {
  return { idle: "空闲", running: "执行中", waiting: "等待确认", stopping: "正在终止", completed: "已完成", failed: "失败", interrupted: "已终止" }[status] || status || "未知";
}

function taskPhaseLabel(phase) {
  return { idle: "等待任务", starting: "启动", working: "处理中", planning: "规划", thinking: "思考", responding: "回复", command: "命令", fileChange: "文件修改", tool: "工具", webSearch: "搜索", imageGeneration: "生图", approval: "审批", stopping: "终止", reconnecting: "重连", compacting: "整理对话", completed: "完成", failed: "失败", interrupted: "已终止" }[phase] || phase || "--";
}

function operationStatusLabel(status) {
  return { idle: "空闲", running: "执行中", completed: "已完成", failed: "失败" }[status] || status || "未知";
}

function roleLabel(role) {
  return { owner: "所有者", admin: "管理员", member: "普通用户" }[role] || role;
}

function providerModeLabel(mode, profileCount = 0, providerName = null) {
  if (mode === "managed") return providerName || (profileCount ? `${profileCount} 个托管配置` : "托管供应商");
  if (mode === "codex") return "Codex 原配置";
  if (mode === "error") return "配置读取失败";
  return "未配置";
}

function versionLabel(value) {
  return value ? `v${value}` : "--";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat(interfaceLocale(), { maximumFractionDigits: 1 }).format(number);
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value >= 86400) return `${Math.floor(value / 86400)} 天`;
  if (value >= 3600) return `${Math.round(value / 3600)} 小时`;
  if (value >= 60) return `${Math.round(value / 60)} 分钟`;
  return `${Math.round(value)} 秒`;
}

function formatTime(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleTimeString(interfaceLocale(), { hour12: false }) : "--:--:--";
}

function formatChartTime(value) {
  if (!Number.isFinite(value)) return "--";
  const options = state.metricRange === "7d"
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }
    : { hour: "2-digit", minute: "2-digit", hour12: false };
  return new Date(value).toLocaleString(interfaceLocale(), options);
}

function formatDateTime(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString(interfaceLocale(), { hour12: false }) : "--";
}

function formatRelativeTime(value) {
  if (!Number.isFinite(value)) return "--";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return formatDateTime(value);
}
