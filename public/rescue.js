(() => {
  "use strict";

  function interfaceLocale() {
    return window.WFLI18n?.getLanguage?.() === "en" ? "en-US" : "zh-CN";
  }

  function interfaceIsEnglish() {
    return interfaceLocale() === "en-US";
  }

  // Rescue is served from the same origin as the main window. Namespace its
  // recovery/project pointers so opening the rescue slot can never move the
  // main window to the rescue-selected conversation (or vice versa).
  const RECOVERY_KEY = "codexDesktop.rescue.activeThread.v1";
  const PROJECT_KEY = "codexDesktop.rescue.project.v1";
  const THREAD_LEASE_OWNER_KEY = "codexDesktop.rescueThreadLeaseOwner.v1";
  const RESCUE_REFERENCE_MARKER = "[WFL_RESCUE_REFERENCE_CONTEXT_V1]";
  const RESCUE_REFERENCE_END_MARKER = "[/WFL_RESCUE_REFERENCE_CONTEXT_V1]";
  const THREAD_LEASE_OWNER_ID = threadLeaseOwnerId();
  const API_BASE = "/rescue/api";
  const SOCKET_CONNECT_TIMEOUT_MS = 12_000;
  const TASK_STATUS_FAILURE_THRESHOLD = 3;
  const TASK_STATUS_REQUEST_TIMEOUT_MS = 12_000;
  const DEPLOYMENT_CONTROL_ACTIVE_POLL_MS = 3_000;
  const DEPLOYMENT_CONTROL_IDLE_POLL_MS = 15_000;
  const DEPLOYMENT_CONTROL_HIDDEN_POLL_MS = 60_000;
  const MAIN_TASKS_ACTIVE_POLL_MS = 2_500;
  const MAIN_TASKS_IDLE_POLL_MS = 12_000;
  const MAIN_TASKS_HIDDEN_POLL_MS = 60_000;
  const RESCUE_TASKS_ACTIVE_POLL_MS = 2_000;
  const RESCUE_TASKS_IDLE_POLL_MS = 8_000;
  const RESCUE_TASKS_HIDDEN_POLL_MS = 60_000;
  const RECENT_TURNS_SHOWN = 8;
  const CLIENT_WINDOW_ID = clientWindowId();
  const state = {
    socket: null,
    socketGeneration: 0,
    codexRuntimeEpoch: null,
    codexEventSequence: 0,
    socketConnectTimer: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    taskStatusRequestPending: false,
    taskStatusController: null,
    taskStatusTimer: null,
    taskStatusFailures: 0,
    taskStatusSnapshot: null,
    rpcId: 1,
    pendingRpc: new Map(),
    pendingTurnRequest: null,
    turnStartRequestPending: false,
    promptSubmissionGuard: false,
    bridgeReady: false,
    bootstrapped: false,
    bootstrapPromise: null,
    bootstrapGeneration: 0,
    bootstrapRetryTimer: null,
    bootstrapRetryAttempts: 0,
    initialDataRetryTimer: null,
    initialDataRetryAttempts: 0,
    initialDataReady: false,
    projectsReady: false,
    projectContextVersion: 0,
    projectsLoadVersion: 0,
    threadListLoadVersion: 0,
    threadListReady: false,
    projects: [],
    projectRoot: "",
    currentProject: null,
    threads: [],
    activeThread: null,
    activeTurnId: null,
    terminalTurnIds: new Set(),
    terminalTurnStatuses: new Map(),
    terminalTaskAuthorities: new Map(),
    activeThreadNeedsResume: false,
    projectSwitchPending: false,
    models: [],
    selectedModel: null,
    selectedEffort: null,
    config: {},
    pendingText: null,
    pendingClientId: null,
    pendingCreatedAt: null,
    threadHistoryCursor: null,
    loadingEarlierTurns: false,
    messageNodes: new Map(),
    transcriptExpansion: new Map(),
    pollTimer: null,
    pollBusy: false,
    refreshTimer: null,
    approvals: [],
    providers: [],
    activeProviderId: null,
    fallbackProvider: null,
    currentProviderId: null,
    editingProviderId: "default",
    providerBusy: false,
    providerCanEdit: false,
    providerConfigurationRequired: false,
    rescueProviderIsolated: true,
    account: null,
    accountLoadPromise: null,
    deploymentControl: null,
    deploymentControlPending: false,
    deploymentCancelPending: false,
    deploymentControlTimer: null,
    deploymentControlForbidden: false,
    snapshotFallback: false,
    snapshotSavedAt: null,
    rescueComponent: null,
    rescueComponentTimer: null,
    worktree: null,
    worktreePending: false,
    worktreeActionPending: false,
    mainTasks: null,
    mainTasksPending: false,
    mainTasksTimer: null,
    mainTaskInterrupting: new Set(),
    rescueTasks: null,
    rescueTasksPending: false,
    rescueTasksLoadVersion: 0,
    rescueTasksTimer: null,
    rescueTaskInterrupting: new Set(),
    references: [],
    selectedReferenceIds: new Set(),
    mainReferenceThreads: [],
    selectedMainReference: null,
    selectedMainTurnIds: new Set(),
    activeToastKeys: new Set(),
  };

  const ids = [
    "threadToggle", "connection", "projectSelect", "modelSelect", "refreshButton", "providerButton", "providerStatus",
    "taskStatusBar", "taskStatusLabel", "taskStatusDetail", "taskStatusTime",
    "backdrop", "threadPane", "threadCount", "loadThreadsButton", "newThreadButton", "newProjectButton", "threadSearch",
    "threadList", "threadProject", "threadTitle", "copyIdButton", "deleteThreadButton", "messageStage",
    "emptyState", "messageList", "approvalStrip", "approvalLabel", "approvalOpenButton", "composerWrap", "promptInput",
    "turnState", "stopButton", "sendButton", "providerDialog", "providerForm", "providerCloseButton",
    "providerSelect", "providerName", "providerBaseUrl", "providerModel", "providerKey", "providerKeyState",
    "providerError", "providerDeleteButton", "providerDefaultButton", "providerSaveButton",
    "providerActivateButton", "approvalDialog", "approvalTitle", "approvalBody", "approvalActions", "toastRegion",
    "deploymentRescueButton", "deploymentRescueDialog", "deploymentRescueForm", "deploymentRescueSummary",
    "deploymentRescuePassword", "deploymentRescueError", "deploymentRescueConfirm", "deploymentRescueClose",
    "admissionRescueButton", "admissionRescueDialog", "admissionRescueForm", "admissionRescueSummary",
    "admissionRescuePassword", "admissionRescueConfirmation", "admissionRescueError",
    "admissionRescueConfirm", "admissionRescueClose",
    "snapshotNotice", "snapshotSavedAt",
    "rescueUpdateButton", "rescueUpdateDialog", "rescueUpdateForm", "rescueUpdateClose",
    "rescueUpdateSummary", "rescueUpdatePassword", "rescueUpdateConfirmation", "rescueUpdateError",
    "rescueUpdateConfirm", "mainTasksButton", "mainTasksBadge", "mainTasksDialog", "mainTasksClose",
    "mainTasksRefresh", "mainTasksSummary", "mainTasksError", "mainTasksList",
    "rescueTasksSummary", "rescueTasksList", "referenceButton", "referenceBanner",
    "worktreeButton", "worktreeDialog", "worktreeCloseButton", "worktreeRefreshButton", "worktreeSummary",
    "worktreeError", "worktreeEnsureButton", "worktreeDiffButton", "worktreeCheckButton", "worktreeStatus",
    "worktreeDiffOutput", "worktreeMergeConfirmation", "worktreeMergeButton",
    "referencesDialog", "referencesClose", "referenceSourceList", "referenceSourceDetail",
    "referenceCreateButton", "referenceOwnedList", "referencesError", "projectDialog", "projectForm",
    "projectCloseButton", "projectCancelButton", "projectNameInput", "templateGrid", "initializeGitInput", "projectPathPreview",
    "projectFormError", "projectSubmitButton",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  initialize();

  async function fetchWithTimeout(resource, options = {}, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(resource, { ...options, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("请求超时，请稍后重试");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initialize() {
    bindEvents();
    refreshIcons();
    loadTaskStatus();
    void loadDeploymentControl();
    void loadRescueComponent();
    void loadRescueWorktree({ silent: true });
    void loadRescueReferences();
    void loadMainTasks();
    void loadRescueTasks();
    connectSocket();
    await Promise.all([loadAccount(), loadProjects(), loadProviders()]);
    state.initialDataReady = state.projectsReady && Boolean(state.currentProject);
    updateTurnState();
    if (state.initialDataReady) void bootstrap();
    else scheduleInitialDataRetry();
  }

  function bindEvents() {
    elements.threadToggle.addEventListener("click", () => document.body.classList.toggle("threads-open"));
    elements.backdrop.addEventListener("click", closeThreads);
    elements.loadThreadsButton.addEventListener("click", loadThreads);
    elements.newThreadButton.addEventListener("click", newThread);
    elements.newProjectButton.addEventListener("click", openProjectDialog);
    elements.threadSearch.addEventListener("input", renderThreads);
    elements.refreshButton.addEventListener("click", refreshConnection);
    elements.projectSelect.addEventListener("change", changeProject);
    elements.modelSelect.addEventListener("change", changeModel);
    elements.copyIdButton.addEventListener("click", copyThreadId);
    elements.deleteThreadButton.addEventListener("click", deleteActiveThread);
    elements.sendButton.addEventListener("click", sendPrompt);
    elements.stopButton.addEventListener("click", interruptTurn);
    elements.promptInput.addEventListener("input", resizePrompt);
    window.addEventListener("online", resumeConnectivity);
    document.addEventListener("visibilitychange", () => {
      sendClientState();
      if (document.visibilityState === "visible") resumeConnectivity();
      else {
        scheduleTaskStatusPoll(taskStatusPollDelay());
        scheduleMainTasksPoll(mainTasksPollDelay());
        scheduleRescueTasksPoll(rescueTasksPollDelay());
      }
    });
    elements.promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendPrompt();
      }
    });
    elements.providerButton.addEventListener("click", openProviderDialog);
    elements.providerCloseButton.addEventListener("click", () => elements.providerDialog.close());
    elements.providerSelect.addEventListener("change", () => selectProvider(elements.providerSelect.value));
    elements.providerSaveButton.addEventListener("click", () => saveProvider(false));
    elements.providerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (canEditProviderProfiles()) saveProvider(true);
      else if (state.editingProviderId !== "default" && state.editingProviderId !== "new") {
        activateProvider(state.editingProviderId).catch((error) => {
          elements.providerError.textContent = error.message;
        });
      }
    });
    elements.providerDeleteButton.addEventListener("click", deleteProvider);
    elements.providerDefaultButton.addEventListener("click", activateDefaultProvider);
    elements.approvalOpenButton.addEventListener("click", openApproval);
    elements.deploymentRescueButton.addEventListener("click", openDeploymentRescue);
    elements.deploymentRescueForm.addEventListener("submit", cancelDeploymentFromRescue);
    elements.deploymentRescueClose.addEventListener("click", () => elements.deploymentRescueDialog.close());
    elements.deploymentRescueDialog.addEventListener("close", resetDeploymentRescue);
    elements.admissionRescueButton.addEventListener("click", openAdmissionRescue);
    elements.admissionRescueForm.addEventListener("submit", clearAdmissionsFromRescue);
    elements.admissionRescueClose.addEventListener("click", () => elements.admissionRescueDialog.close());
    elements.admissionRescueDialog.addEventListener("close", resetAdmissionRescue);
    elements.rescueUpdateButton.addEventListener("click", openRescueUpdate);
    elements.rescueUpdateClose.addEventListener("click", () => elements.rescueUpdateDialog.close());
    elements.rescueUpdateForm.addEventListener("submit", updateRescueComponent);
    elements.rescueUpdateDialog.addEventListener("close", resetRescueUpdate);
    elements.mainTasksButton.addEventListener("click", openMainTasks);
    elements.mainTasksClose.addEventListener("click", () => elements.mainTasksDialog.close());
    elements.mainTasksRefresh.addEventListener("click", () => loadMainTasks({ force: true }));
    elements.worktreeButton.addEventListener("click", openRescueWorktree);
    elements.worktreeCloseButton.addEventListener("click", () => elements.worktreeDialog.close());
    elements.worktreeRefreshButton.addEventListener("click", () => loadRescueWorktree());
    elements.worktreeEnsureButton.addEventListener("click", ensureRescueWorktree);
    elements.worktreeDiffButton.addEventListener("click", loadRescueWorktreeDiff);
    elements.worktreeCheckButton.addEventListener("click", checkRescueWorktree);
    elements.worktreeMergeButton.addEventListener("click", mergeRescueWorktree);
    elements.referenceButton.addEventListener("click", openReferencesDialog);
    elements.referencesClose.addEventListener("click", () => elements.referencesDialog.close());
    elements.referenceCreateButton.addEventListener("click", createReferenceFromSelection);
    elements.referencesDialog.addEventListener("close", resetReferencesDialog);
    elements.projectCloseButton.addEventListener("click", () => elements.projectDialog.close());
    elements.projectCancelButton.addEventListener("click", () => elements.projectDialog.close());
    elements.projectForm.addEventListener("submit", submitProjectForm);
    elements.projectNameInput.addEventListener("input", updateProjectPathPreview);
    elements.templateGrid.addEventListener("change", updateTemplateSelection);
  }

  function connectSocket() {
    if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socketGeneration = ++state.socketGeneration;
    const query = new URLSearchParams({
      windowId: CLIENT_WINDOW_ID,
      generation: String(socketGeneration),
    });
    const socket = new WebSocket(`${protocol}//${location.host}/rescue/ws?${query}`);
    state.socket = socket;
    setConnection("starting", "正在连接");
    const connectTimer = setTimeout(() => {
      if (state.socket === socket && socket.readyState === WebSocket.CONNECTING) {
        setConnection("error", "连接超时");
        socket.close();
      }
    }, SOCKET_CONNECT_TIMEOUT_MS);
    state.socketConnectTimer = connectTimer;
    const clearConnectTimer = () => {
      clearTimeout(connectTimer);
      if (state.socketConnectTimer === connectTimer) state.socketConnectTimer = null;
    };

    socket.addEventListener("open", () => {
      if (!socketIsCurrent(socket, socketGeneration)) return;
      clearConnectTimer();
      state.reconnectAttempts = 0;
      sendClientState();
    });

    socket.addEventListener("message", (event) => {
      if (!socketIsCurrent(socket, socketGeneration)) return;
      clearConnectTimer();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        toast("收到无效服务消息", "error");
        return;
      }
      handleSocketMessage(message, socketGeneration);
    });
    socket.addEventListener("close", () => {
      clearConnectTimer();
      if (!socketIsCurrent(socket, socketGeneration)) return;
      state.socket = null;
      state.bridgeReady = false;
      state.bootstrapped = false;
      state.bootstrapGeneration += 1;
      state.bootstrapPromise = null;
      state.threadListReady = false;
      if (state.activeThread) state.activeThreadNeedsResume = true;
      stopPolling();
      rejectPendingRpc("连接已断开", true, socketGeneration, true);
      setConnection("offline", "连接断开");
      updateTurnState();
      scheduleSocketReconnect();
    });
    socket.addEventListener("error", () => {
      if (socketIsCurrent(socket, socketGeneration)) setConnection("error", "连接错误");
    });
  }

  function socketIsCurrent(socket, socketGeneration) {
    return state.socket === socket && state.socketGeneration === socketGeneration;
  }

  function scheduleSocketReconnect() {
    if (state.reconnectTimer) return;
    const attempt = state.reconnectAttempts++;
    const baseDelay = Math.min(8_000, 1_000 * (1.6 ** attempt));
    const delay = Math.round(baseDelay + Math.random() * 350);
    state.reconnectTimer = setTimeout(connectSocket, delay);
  }

  function applyCodexRuntimeStatus(payload = {}) {
    const previousEpoch = state.codexRuntimeEpoch;
    const previousSequence = state.codexEventSequence;
    const runtimeEpoch = typeof payload.runtimeEpoch === "string" && payload.runtimeEpoch
      ? payload.runtimeEpoch
      : null;
    const eventSequence = Number.isSafeInteger(payload.eventSequence) && payload.eventSequence >= 0
      ? payload.eventSequence
      : previousSequence;
    const sameEpoch = Boolean(previousEpoch && runtimeEpoch && previousEpoch === runtimeEpoch);
    if (runtimeEpoch) state.codexRuntimeEpoch = runtimeEpoch;
    state.codexEventSequence = sameEpoch ? Math.max(previousSequence, eventSequence) : eventSequence;
    return {
      sameEpoch,
      epochChanged: Boolean(previousEpoch && runtimeEpoch && previousEpoch !== runtimeEpoch),
      missedEvents: sameEpoch && eventSequence > previousSequence,
    };
  }

  function sendClientState(threadId = state.activeThread?.id || null) {
    if (state.socket?.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify({
      type: "client/state",
      threadId,
      visible: document.visibilityState === "visible",
      codexRuntimeEpoch: state.codexRuntimeEpoch,
      codexEventSequence: state.codexEventSequence,
      windowId: CLIENT_WINDOW_ID,
      socketGeneration: state.socketGeneration,
    }));
  }

  function resumeConnectivity() {
    scheduleTaskStatusPoll(0);
    scheduleDeploymentControlPoll(0);
    scheduleMainTasksPoll(0);
    if (state.socket?.readyState === WebSocket.OPEN) {
      sendClientState();
      return;
    }
    if (state.socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    connectSocket();
  }

  function refreshConnection() {
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add("refreshing");
    state.bootstrapped = false;
    state.bootstrapGeneration += 1;
    state.bootstrapPromise = null;
    state.threadListReady = false;
    clearTimeout(state.bootstrapRetryTimer);
    state.bootstrapRetryTimer = null;
    if (state.activeThread) state.activeThreadNeedsResume = true;
    stopPolling();
    state.taskStatusSnapshot = null;
    updateTurnState();
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.socketConnectTimer);
    state.socketConnectTimer = null;
    state.reconnectAttempts = 0;
    const previous = state.socket;
    state.socket = null;
    rejectPendingRpc("正在刷新连接", true, state.socketGeneration, true);
    if (previous?.readyState === WebSocket.OPEN || previous?.readyState === WebSocket.CONNECTING) {
      previous.close(1000, "Refresh requested");
    }
    setConnection("starting", "正在刷新");
    scheduleDeploymentControlPoll(0);
    connectSocket();
    setTimeout(() => {
      elements.refreshButton.disabled = false;
      elements.refreshButton.classList.remove("refreshing");
    }, 1500);
  }

  function handleSocketMessage(message, socketGeneration = state.socketGeneration) {
    if (message.type === "bridge/status") {
      const payload = message.payload || {};
      const status = payload.status || "starting";
      const wasReady = state.bridgeReady;
      state.bridgeReady = status === "ready";
      setConnection(status, statusText(status));
      if (state.bridgeReady) {
        const runtimeStatus = applyCodexRuntimeStatus(payload);
        sendClientState();
        if (state.bootstrapped && runtimeStatus.sameEpoch) {
          if (runtimeStatus.missedEvents && state.activeThread) scheduleThreadRefresh(0);
          if (state.activeTurnId) startPolling();
        } else {
          state.bootstrapped = false;
          state.bootstrapGeneration += 1;
          state.bootstrapPromise = null;
          state.threadListReady = false;
          if (runtimeStatus.epochChanged && state.activeThread) state.activeThreadNeedsResume = true;
          bootstrap();
        }
        retryPendingTurnRequest();
      }
      else {
        state.bootstrapGeneration += 1;
        state.threadListReady = false;
        if (wasReady) rejectPendingRpc("Codex 服务连接中断", true, socketGeneration, true);
        stopPolling();
      }
      updateTurnState();
      return;
    }
    if (message.type === "rpc/result" || message.type === "rpc/error") {
      const pending = state.pendingRpc.get(String(message.requestId));
      if (!pending || pending.socketGeneration !== socketGeneration) return;
      state.pendingRpc.delete(String(message.requestId));
      clearTimeout(pending.timer);
      if (message.type === "rpc/error") pending.reject(new Error(message.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === "codex/notification") {
      const runtimeEpoch = typeof message.runtimeEpoch === "string" ? message.runtimeEpoch : null;
      const eventSequence = Number.isSafeInteger(message.eventSequence) ? message.eventSequence : null;
      if (runtimeEpoch && state.codexRuntimeEpoch && runtimeEpoch !== state.codexRuntimeEpoch) {
        state.codexRuntimeEpoch = runtimeEpoch;
        state.codexEventSequence = eventSequence || 0;
        state.bootstrapped = false;
        state.bootstrapGeneration += 1;
        state.bootstrapPromise = null;
        if (state.activeThread) state.activeThreadNeedsResume = true;
        void bootstrap();
        return;
      }
      if (runtimeEpoch) state.codexRuntimeEpoch = runtimeEpoch;
      if (eventSequence !== null) {
        if (eventSequence <= state.codexEventSequence) return;
        state.codexEventSequence = eventSequence;
      }
      handleNotification(message.payload || {});
    }
    if (message.type === "codex/serverRequest") enqueueApproval(message.payload || {});
    if (message.type === "error") toast(message.message || "服务错误", "error");
  }

  async function bootstrap() {
    if (state.bootstrapPromise) return state.bootstrapPromise;
    if (state.bootstrapped || !state.bridgeReady || !state.initialDataReady || !state.currentProject) return;
    const generation = ++state.bootstrapGeneration;
    const context = projectContextSnapshot();
    state.threadListReady = false;
    updateTurnState();
    const bootstrapPromise = (async () => {
      state.bootstrapped = false;
      try {
        await Promise.all([loadModels(), loadConfig(context), loadProviders()]);
        if (
          generation !== state.bootstrapGeneration
          || !state.bridgeReady
          || !projectContextIsCurrent(context)
        ) return;
        populateModels();
        if (
          generation !== state.bootstrapGeneration
          || !state.bridgeReady
          || !projectContextIsCurrent(context)
        ) return;
        state.bootstrapped = true;
        updateTurnState();
        state.bootstrapRetryAttempts = 0;
        // History is an auxiliary sidebar surface. It must not block a new
        // conversation from becoming writable when Codex is already ready;
        // the main window follows the same rule. Recover an existing thread
        // after the best-effort history refresh completes.
        void loadThreads({ context }).then(async (loaded) => {
          if (!loaded || generation !== state.bootstrapGeneration || !projectContextIsCurrent(context)) return;
          await recoverThread();
        }).catch((error) => {
          console.warn("Unable to refresh rescue conversation history:", error);
        });
      } catch (error) {
        if (
          generation !== state.bootstrapGeneration
          || !state.bridgeReady
          || !projectContextIsCurrent(context)
        ) return;
        state.bootstrapped = false;
        if (!error.recoverable) toast(error.message, "error");
        scheduleBootstrapRetry();
      } finally {
        if (state.bootstrapPromise === bootstrapPromise) state.bootstrapPromise = null;
      }
    })();
    state.bootstrapPromise = bootstrapPromise;
    return bootstrapPromise;
  }

  function rpc(method, params = {}) {
    if (state.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Codex 尚未连接"));
    const requestId = state.rpcId++;
    const socketGeneration = state.socketGeneration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingRpc.delete(String(requestId));
        reject(rpcError(`${method} 请求超时`, true));
      }, 125_000);
      state.pendingRpc.set(String(requestId), { resolve, reject, timer, socketGeneration });
      try {
        state.socket.send(JSON.stringify({
          type: "rpc",
          requestId,
          method,
          params,
          windowId: CLIENT_WINDOW_ID,
          socketGeneration,
        }));
      } catch (error) {
        clearTimeout(timer);
        state.pendingRpc.delete(String(requestId));
        reject(rpcError(error.message || `${method} 发送失败`, true));
      }
    });
  }

  function rejectPendingRpc(message, deliveryUnknown = false, socketGeneration = null, recoverable = false) {
    for (const [requestId, pending] of state.pendingRpc) {
      if (socketGeneration !== null && pending.socketGeneration !== socketGeneration) continue;
      clearTimeout(pending.timer);
      pending.reject(rpcError(message, deliveryUnknown, recoverable));
      state.pendingRpc.delete(requestId);
    }
  }

  function rpcError(message, deliveryUnknown = false, recoverable = false) {
    const error = new Error(message);
    error.deliveryUnknown = deliveryUnknown;
    error.recoverable = recoverable;
    return error;
  }

  function projectContextSnapshot() {
    return {
      version: state.projectContextVersion,
      path: state.currentProject?.path || null,
    };
  }

  function projectContextIsCurrent(context) {
    return Boolean(
      context
      && context.version === state.projectContextVersion
      && context.path === (state.currentProject?.path || null),
    );
  }

  function selectCurrentProject(project, { persist = true } = {}) {
    const nextPath = project?.path || null;
    const previousPath = state.currentProject?.path || null;
    state.currentProject = project || null;
    if (previousPath !== nextPath) {
      // A project switch changes the conversation namespace. Keep the old
      // transcript, snapshot mode, task fence, and refresh timer from being
      // rendered while the new project's official list is loading. The
      // caller will restore a selected Thread only after the new context has
      // completed its own resume/bootstrap checks.
      stopPolling();
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      state.activeThread = null;
      state.activeTurnId = null;
      state.taskStatusSnapshot = null;
      state.terminalTurnIds = new Set();
      state.terminalTurnStatuses = new Map();
      state.terminalTaskAuthorities = new Map();
      state.pendingText = null;
      state.pendingClientId = null;
      state.pendingCreatedAt = null;
      state.threadHistoryCursor = null;
      state.loadingEarlierTurns = false;
      state.messageNodes.clear();
      state.transcriptExpansion.clear();
      state.snapshotFallback = false;
      state.snapshotSavedAt = null;
      applySnapshotMode(null);
      state.projectContextVersion += 1;
      state.bootstrapGeneration += 1;
      state.bootstrapPromise = null;
      state.bootstrapped = false;
      state.threadListReady = false;
      state.threadListLoadVersion += 1;
      state.taskStatusController?.abort();
      state.taskStatusController = null;
      state.taskStatusRequestPending = false;
      state.taskStatusSnapshot = null;
      state.threads = [];
      renderThreads();
    }
    if (persist) {
      if (nextPath) localStorage.setItem(PROJECT_KEY, nextPath);
      else localStorage.removeItem(PROJECT_KEY);
    }
    renderThreadHeader();
    updateTurnState();
    return projectContextSnapshot();
  }

  async function loadProjects() {
    const loadVersion = ++state.projectsLoadVersion;
    try {
      const response = await fetchWithTimeout(`${API_BASE}/projects`, { cache: "no-store" }, 12_000);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取工程");
      if (loadVersion !== state.projectsLoadVersion) return false;
      state.projects = data.projects || [];
      state.projectsReady = true;
      state.projectRoot = typeof data.root === "string" ? data.root : state.projectRoot;
      const remembered = localStorage.getItem(PROJECT_KEY);
      const project =
        state.projects.find((entry) => entry.path === state.currentProject?.path) ||
        state.projects.find((entry) => entry.path === remembered) ||
        state.projects.find((entry) => entry.path === data.defaultProject) ||
        state.projects[0] || null;
      selectCurrentProject(project, { persist: false });
      elements.projectSelect.replaceChildren();
      for (const project of state.projects) elements.projectSelect.add(new Option(project.name, project.path));
      if (state.currentProject) elements.projectSelect.value = state.currentProject.path;
      renderThreadHeader();
      state.initialDataReady = state.projectsReady && Boolean(state.currentProject);
      updateTurnState();
      return true;
    } catch (error) {
      if (loadVersion !== state.projectsLoadVersion) return false;
      state.projectsReady = false;
      state.initialDataReady = false;
      toast(error.message, "error");
      return false;
    }
  }

  function scheduleInitialDataRetry() {
    if (state.initialDataRetryTimer) return;
    const attempt = state.initialDataRetryAttempts++;
    const delay = Math.min(30_000, Math.round(1_000 * (1.7 ** Math.min(attempt, 5))));
    state.initialDataRetryTimer = setTimeout(async () => {
      state.initialDataRetryTimer = null;
      await Promise.all([loadProjects(), loadProviders()]);
      state.initialDataReady = state.projectsReady && Boolean(state.currentProject);
      updateTurnState();
      if (state.initialDataReady) {
        state.initialDataRetryAttempts = 0;
        void bootstrap();
      } else {
        scheduleInitialDataRetry();
      }
    }, delay);
  }

  function scheduleBootstrapRetry() {
    if (state.bootstrapRetryTimer || !state.bridgeReady) return;
    if (!state.initialDataReady || !state.currentProject) {
      scheduleInitialDataRetry();
      return;
    }
    const attempt = state.bootstrapRetryAttempts++;
    const delay = Math.min(30_000, Math.round(1_000 * (1.7 ** Math.min(attempt, 5))));
    state.bootstrapRetryTimer = setTimeout(() => {
      state.bootstrapRetryTimer = null;
      if (state.bridgeReady) void bootstrap();
    }, delay);
  }

  async function loadRescueReferences() {
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/references?_=${Date.now()}`, { cache: "no-store" }, 12_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法读取主站只读引用");
      state.references = Array.isArray(data.references) ? data.references : [];
      state.selectedReferenceIds = new Set(
        [...state.selectedReferenceIds].filter((id) => state.references.some((reference) => reference.id === id)),
      );
      renderReferenceBanner();
      if (elements.referencesDialog.open) renderReferenceOwnedList();
      return state.references;
    } catch (error) {
      if (elements.referencesDialog.open) elements.referencesError.textContent = error.message;
      return [];
    }
  }

  async function openReferencesDialog() {
    resetReferencesDialog();
    renderReferenceOwnedList();
    if (!elements.referencesDialog.open) elements.referencesDialog.showModal();
    await loadMainReferenceThreads();
  }

  function resetReferencesDialog() {
    state.mainReferenceThreads = [];
    state.selectedMainReference = null;
    state.selectedMainTurnIds.clear();
    elements.referenceSourceList.replaceChildren();
    elements.referenceSourceDetail.textContent = "选择一个主站对话后，可勾选要引用的消息。";
    elements.referenceCreateButton.disabled = true;
    elements.referencesError.textContent = "";
    renderReferenceOwnedList();
  }

  async function loadMainReferenceThreads() {
    elements.referenceSourceList.innerHTML = '<div class="list-state">正在读取主站对话</div>';
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/main/references?_=${Date.now()}`, { cache: "no-store" }, 35_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法读取主站对话");
      state.mainReferenceThreads = Array.isArray(data.threads) ? data.threads : [];
      renderReferenceSourceList();
    } catch (error) {
      state.mainReferenceThreads = [];
      elements.referenceSourceList.innerHTML = '<div class="list-state">无法读取主站对话</div>';
      elements.referencesError.textContent = error.message;
    }
  }

  function renderReferenceSourceList() {
    elements.referenceSourceList.replaceChildren();
    if (!state.mainReferenceThreads.length) {
      elements.referenceSourceList.innerHTML = '<div class="list-state">主站暂无可引用对话</div>';
      return;
    }
    for (const source of state.mainReferenceThreads) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `reference-source-row${source.id === state.selectedMainReference?.id ? " active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = source.name || source.preview || "未命名主站对话";
      const preview = document.createElement("span");
      preview.textContent = source.preview || "选择后读取消息范围";
      const meta = document.createElement("small");
      meta.textContent = `${basename(source.cwd || "未指定工程")} · ${relativeTime(source.updatedAt)}`;
      button.append(title, preview, meta);
      button.addEventListener("click", () => selectMainReference(source));
      elements.referenceSourceList.append(button);
    }
  }

  async function selectMainReference(source) {
    if (!source?.id) return;
    const sourceId = source.id;
    state.selectedMainReference = { ...source, loading: true };
    state.selectedMainTurnIds.clear();
    renderReferenceSourceList();
    elements.referenceSourceDetail.textContent = "正在读取主站消息范围…";
    elements.referenceCreateButton.disabled = true;
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/rescue/main/references/${encodeURIComponent(sourceId)}?_=${Date.now()}`,
        { cache: "no-store" },
        35_000,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法读取主站消息");
      if (state.selectedMainReference?.id !== sourceId) return;
      state.selectedMainReference = data.thread || { ...source, turns: [] };
      const selectableTurns = (state.selectedMainReference.turns || [])
        .filter((turn) => referenceTurnText(turn));
      state.selectedMainTurnIds = new Set(selectableTurns.map((turn, index) => String(turn.id || `turn-${index + 1}`)));
      renderReferenceSourceDetail();
      renderReferenceSourceList();
    } catch (error) {
      if (state.selectedMainReference?.id !== sourceId) return;
      state.selectedMainReference = null;
      elements.referenceSourceDetail.textContent = "无法读取该主站对话的消息。";
      elements.referencesError.textContent = error.message;
      renderReferenceSourceList();
    }
  }

  function renderReferenceSourceDetail() {
    const thread = state.selectedMainReference;
    if (!thread || thread.loading) {
      elements.referenceSourceDetail.textContent = "选择一个主站对话后，可勾选要引用的消息。";
      elements.referenceCreateButton.disabled = true;
      return;
    }
    elements.referenceSourceDetail.replaceChildren();
    const summary = document.createElement("div");
    summary.className = "reference-source-heading";
    summary.textContent = `${thread.name || "未命名主站对话"} · ${basename(thread.cwd || "未指定工程")} · 只读`;
    elements.referenceSourceDetail.append(summary);
    const turnList = document.createElement("div");
    turnList.className = "reference-turn-list";
    const turns = (thread.turns || []).filter((turn) => referenceTurnText(turn));
    if (!turns.length) {
      const empty = document.createElement("p");
      empty.className = "list-state";
      empty.textContent = "该对话没有可引用的文本消息";
      turnList.append(empty);
    }
    for (const [index, turn] of turns.entries()) {
      const turnId = String(turn.id || `turn-${index + 1}`);
      const label = document.createElement("label");
      label.className = "reference-turn-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selectedMainTurnIds.has(turnId);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedMainTurnIds.add(turnId);
        else state.selectedMainTurnIds.delete(turnId);
        elements.referenceCreateButton.disabled = state.selectedMainTurnIds.size === 0;
      });
      const copy = document.createElement("span");
      const heading = document.createElement("strong");
      heading.textContent = `消息 ${index + 1}`;
      const text = document.createElement("small");
      text.textContent = referenceTurnText(turn).slice(0, 280);
      copy.append(heading, text);
      label.append(checkbox, copy);
      turnList.append(label);
    }
    elements.referenceSourceDetail.append(turnList);
    elements.referenceCreateButton.disabled = state.selectedMainTurnIds.size === 0;
  }

  async function createReferenceFromSelection() {
    const thread = state.selectedMainReference;
    if (!thread?.id || !state.selectedMainTurnIds.size) return;
    elements.referenceCreateButton.disabled = true;
    elements.referencesError.textContent = "";
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/references`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "rescue-reference-create",
        },
        body: JSON.stringify({
          sourceThreadId: thread.id,
          turnIds: [...state.selectedMainTurnIds],
        }),
      }, 35_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法保存主站只读引用");
      if (data.reference?.id) state.selectedReferenceIds.add(data.reference.id);
      await loadRescueReferences();
      toast("主站只读引用已保存", "success");
      elements.referencesDialog.close();
    } catch (error) {
      elements.referencesError.textContent = error.message;
      elements.referenceCreateButton.disabled = false;
    }
  }

  function renderReferenceOwnedList() {
    elements.referenceOwnedList.replaceChildren();
    if (!state.references.length) {
      elements.referenceOwnedList.innerHTML = '<div class="list-state">还没有保存的主站引用</div>';
      return;
    }
    for (const reference of state.references) {
      const card = document.createElement("article");
      card.className = `reference-card${state.selectedReferenceIds.has(reference.id) ? " selected" : ""}`;
      const label = document.createElement("label");
      label.className = "reference-card-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selectedReferenceIds.has(reference.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedReferenceIds.add(reference.id);
        else state.selectedReferenceIds.delete(reference.id);
        card.classList.toggle("selected", checkbox.checked);
        renderReferenceBanner();
      });
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = reference.source?.title || "未命名主站对话";
      const meta = document.createElement("small");
      meta.textContent = `${reference.messageCount || 0} 条消息 · ${reference.source?.version || "未知版本"} · SHA ${String(reference.contentHash || "").slice(0, 12)}`;
      copy.append(title, meta);
      label.append(checkbox, copy);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger reference-delete";
      remove.textContent = "删除";
      remove.addEventListener("click", () => deleteReference(reference.id));
      card.append(label, remove);
      elements.referenceOwnedList.append(card);
    }
  }

  async function deleteReference(referenceId) {
    if (!referenceId || !confirm("删除这条主站只读引用？当前主站对话不会受到影响。")) return;
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/references/${encodeURIComponent(referenceId)}`, {
        method: "DELETE",
        headers: {
          "X-Codex-Desktop-Action": "rescue-reference-delete",
        },
      }, 12_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法删除主站只读引用");
      state.selectedReferenceIds.delete(referenceId);
      await loadRescueReferences();
      toast("主站只读引用已删除", "success");
    } catch (error) {
      elements.referencesError.textContent = error.message;
    }
  }

  function renderReferenceBanner() {
    const active = state.references.filter((reference) => state.selectedReferenceIds.has(reference.id));
    elements.referenceBanner.replaceChildren();
    elements.referenceBanner.hidden = active.length === 0;
    if (!active.length) return;
    const text = document.createElement("span");
    text.textContent = `当前消息将附加 ${active.length} 个主站只读引用；引用不会显示为备用对话，也不会写回主站。`;
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "text-button";
    manage.textContent = "管理引用";
    manage.addEventListener("click", openReferencesDialog);
    elements.referenceBanner.append(text, manage);
  }

  function referenceTurnText(turn) {
    return (Array.isArray(turn?.items) ? turn.items : []).map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = typeof item.text === "string"
        ? item.text
        : Array.isArray(item.content)
          ? item.content
            .map((part) => typeof part === "string" ? part : part?.text || "")
            .filter(Boolean)
            .join("\n")
          : typeof item.content === "string" ? item.content : "";
      if (!text.trim()) return "";
      const label = ["user", "userMessage"].includes(item.type)
        ? "用户"
        : ["assistant", "agentMessage"].includes(item.type) ? "Codex" : item.type;
      return `${label}: ${text.trim()}`;
    }).filter(Boolean).join("\n\n");
  }

  function openProjectDialog() {
    elements.projectForm.reset();
    elements.projectFormError.textContent = "";
    updateTemplateSelection();
    updateProjectPathPreview();
    if (!elements.projectDialog.open) elements.projectDialog.showModal();
    requestAnimationFrame(() => elements.projectNameInput.focus());
  }

  function updateTemplateSelection() {
    elements.templateGrid.querySelectorAll(".template-option").forEach((label) => {
      label.classList.toggle("selected", label.querySelector("input")?.checked === true);
    });
  }

  function updateProjectPathPreview() {
    const name = elements.projectNameInput.value.trim() || "rescue-workspace";
    const root = state.projectRoot || "/备用工程根目录";
    elements.projectPathPreview.textContent = `${root.replace(/\/$/, "")}/${name}`;
  }

  async function submitProjectForm(event) {
    event.preventDefault();
    if (!elements.projectForm.reportValidity()) return;
    if (state.pendingTurnRequest || rescueTaskStatusIsActiveForCurrentThread()) {
      elements.projectFormError.textContent = "当前任务仍在运行或等待确认，请先完成或终止任务";
      return;
    }
    elements.projectSubmitButton.disabled = true;
    state.projectSwitchPending = true;
    updateTurnState();
    elements.projectFormError.textContent = "";
    const formData = new FormData(elements.projectForm);
    try {
      const response = await fetchWithTimeout(`${API_BASE}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          template: formData.get("template"),
          initializeGit: elements.initializeGitInput.checked,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法创建备用工程目录");
      elements.projectDialog.close();
      if (!await loadProjects()) throw new Error("工程已创建，但工程列表尚未刷新，请稍后重试");
      const project = state.projects.find((entry) => entry.path === data.project?.path);
      if (!project) throw new Error("工程已创建，但备用窗口暂时找不到新工程");
      const context = selectCurrentProject(project);
      elements.projectSelect.value = project.path;
      newThread();
      updateTurnState();
      try {
        if (state.bridgeReady && !await initializeSelectedProject(context)) {
          throw rpcError("备用工程尚未完成初始化", false, true);
        }
      } catch (error) {
        state.bootstrapped = false;
        scheduleBootstrapRetry();
        toast(`工程已创建，但备用窗口仍在初始化：${error.message}`, "warning");
      }
      toast("备用工程目录已创建", "success");
    } catch (error) {
      elements.projectFormError.textContent = error.message;
    } finally {
      state.projectSwitchPending = false;
      elements.projectSubmitButton.disabled = false;
      updateTurnState();
    }
  }

  async function changeProject() {
    if (state.pendingTurnRequest) {
      toast("当前消息仍在确认发送，请等待连接恢复", "error");
      return;
    }
    if (state.activeTurnId || rescueTaskStatusIsActiveForCurrentThread()) {
      elements.projectSelect.value = state.currentProject?.path || "";
      toast("当前任务仍在处理，请完成或终止任务后再切换工程", "error");
      return;
    }
    const project = state.projects.find((entry) => entry.path === elements.projectSelect.value);
    if (!project) return;
    state.projectSwitchPending = true;
    updateTurnState();
    const context = selectCurrentProject(project);
    try {
      elements.projectSelect.value = project.path;
      newThread();
      if (state.bridgeReady) {
        try {
          if (!await initializeSelectedProject(context)) {
            throw rpcError("备用工程尚未完成初始化", false, true);
          }
        } catch (error) {
          state.bootstrapped = false;
          scheduleBootstrapRetry();
          toast(`工程已切换，但备用窗口仍在初始化：${error.message}`, "warning");
        }
      } else {
        state.bootstrapped = false;
      }
    } finally {
      state.projectSwitchPending = false;
      if (projectContextIsCurrent(context)) {
        state.initialDataReady = state.projectsReady && Boolean(state.currentProject);
      }
      updateTurnState();
    }
  }

  async function loadModels() {
    const result = await rpc("model/list", { limit: 100, includeHidden: false });
    state.models = result.data || [];
  }

  async function loadConfig(context = projectContextSnapshot()) {
    if (!state.currentProject || !projectContextIsCurrent(context)) return false;
    const result = await rpc("config/read", { includeLayers: true, cwd: context.path });
    if (!projectContextIsCurrent(context)) return false;
    state.config = result.config || {};
    state.selectedModel = state.config.model || state.selectedModel;
    state.selectedEffort = state.config.model_reasoning_effort || state.selectedEffort;
    return true;
  }

  function populateModels() {
    const fallback = state.models.find((model) => model.isDefault) || state.models[0];
    if (!state.models.some((model) => model.model === state.selectedModel)) {
      state.selectedModel = fallback?.model || null;
    }
    elements.modelSelect.replaceChildren();
    for (const model of state.models) elements.modelSelect.add(new Option(model.displayName || model.model, model.model));
    if (state.selectedModel) elements.modelSelect.value = state.selectedModel;
  }

  async function initializeSelectedProject(context) {
    if (!state.bridgeReady || !projectContextIsCurrent(context)) return false;
    await Promise.all([loadModels(), loadConfig(context), loadProviders()]);
    if (!projectContextIsCurrent(context) || !state.bridgeReady) return false;
    populateModels();
    if (!projectContextIsCurrent(context) || !state.bridgeReady) return false;
    state.initialDataReady = state.projectsReady && Boolean(state.currentProject);
    state.bootstrapped = true;
    state.bootstrapRetryAttempts = 0;
    updateTurnState();
    void loadThreads({ context }).then(async (loaded) => {
      if (loaded && projectContextIsCurrent(context)) await recoverThread();
    }).catch((error) => {
      console.warn("Unable to refresh rescue conversation history:", error);
    });
    await loadTaskStatus({ force: true });
    return projectContextIsCurrent(context);
  }

  async function changeModel() {
    state.selectedModel = elements.modelSelect.value;
    if (!state.activeThread) return;
    try {
      await rpc("thread/settings/update", {
        threadId: state.activeThread.id,
        model: state.selectedModel,
        effort: state.selectedEffort,
      });
      toast("模型已更新");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function loadThreads({ required = false, context = projectContextSnapshot() } = {}) {
    if (!state.bridgeReady) return false;
    const loadVersion = ++state.threadListLoadVersion;
    if (!projectContextIsCurrent(context)) return false;
    elements.threadList.innerHTML = '<div class="list-state">正在读取对话</div>';
    try {
      const result = await rpc("thread/list", {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        cwd: context.path || undefined,
      });
      if (loadVersion !== state.threadListLoadVersion || !projectContextIsCurrent(context)) return false;
      applySnapshotMode(result.rescueSnapshot);
      state.threads = result.data || [];
      state.threadListReady = true;
      renderThreads();
      updateTurnState();
      return true;
    } catch (error) {
      if (loadVersion !== state.threadListLoadVersion || !projectContextIsCurrent(context)) return false;
      state.threadListReady = false;
      elements.threadList.innerHTML = error.recoverable
        ? '<div class="list-state">正在恢复对话连接</div>'
        : '<div class="list-state">无法读取对话</div>';
      if (!error.recoverable) toast(error.message, "error");
      updateTurnState();
      if (required) {
        throw error.recoverable
          ? error
          : rpcError(error.message, error.deliveryUnknown === true, true);
      }
      return false;
    }
  }

  function renderThreads() {
    const query = elements.threadSearch.value.trim().toLowerCase();
    const threads = state.threads.filter((thread) => {
      const title = thread.name || thread.preview || thread.id;
      return !query || title.toLowerCase().includes(query) || (thread.cwd || "").toLowerCase().includes(query);
    });
    elements.threadCount.textContent = String(threads.length);
    elements.threadList.replaceChildren();
    if (!threads.length) {
      elements.threadList.innerHTML = '<div class="list-state">暂无对话</div>';
      return;
    }
    for (const thread of threads) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `thread-row${thread.id === state.activeThread?.id ? " active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = thread.name || thread.preview || "未命名对话";
      const preview = document.createElement("span");
      preview.textContent = thread.preview || thread.cwd || "";
      const meta = document.createElement("small");
      meta.textContent = `${basename(thread.cwd || "")} · ${relativeTime(thread.updatedAt)}`;
      button.append(title, preview, meta);
      button.addEventListener("click", () => resumeThread(thread));
      elements.threadList.append(button);
    }
  }

  async function resumeThread(thread) {
    if (!thread?.id || !state.bridgeReady) return false;
    if (state.pendingTurnRequest && thread.id !== state.activeThread?.id) {
      toast("当前消息仍在确认发送，请等待连接恢复", "error");
      return false;
    }
    if (state.activeTurnId && thread.id !== state.activeThread?.id) {
      toast("当前任务仍在处理，请完成或终止任务后再切换对话", "error");
      return false;
    }
    const project = state.projects.find((entry) => entry.path === thread.cwd);
    let context = projectContextSnapshot();
    if (project) {
      context = selectCurrentProject(project);
      elements.projectSelect.value = project.path;
    }
    const previousThreadId = state.activeThread?.id || null;
    sendClientState(thread.id);
    elements.messageList.innerHTML = '<div class="list-state">正在恢复对话</div>';
    elements.emptyState.hidden = true;
    closeThreads();
    try {
      const params = {
        threadId: thread.id,
        model: state.selectedModel,
        modelProvider: state.currentProviderId || undefined,
        cwd: thread.cwd || state.currentProject?.path,
        excludeTurns: true,
        initialTurnsPage: {
          limit: RECENT_TURNS_SHOWN,
          sortDirection: "desc",
          itemsView: "full",
        },
      };
      addPolicyParams(params);
      const result = await rpc("thread/resume", params);
      if (!projectContextIsCurrent(context)) return false;
      applySnapshotMode(result.rescueSnapshot);
      state.activeThread = {
        ...result.thread,
        turns: normalizeRecentTurns(result.initialTurnsPage?.data),
      };
      state.threadHistoryCursor = result.initialTurnsPage?.nextCursor || null;
      state.loadingEarlierTurns = false;
      if (previousThreadId !== thread.id) {
        state.messageNodes.clear();
        state.transcriptExpansion.clear();
      }
      state.activeThreadNeedsResume = false;
      state.selectedModel = result.model || state.selectedModel;
      state.selectedEffort = result.reasoningEffort || state.selectedEffort;
      settlePendingText();
      syncActiveTurn();
      rememberThread();
      populateModels();
      renderActiveThread(true);
      renderThreads();
      if (state.activeTurnId) startPolling();
      await loadTaskStatus({ force: true });
      return true;
    } catch (error) {
      state.activeThreadNeedsResume = true;
      renderActiveThread(true);
      if (!error.recoverable) toast(error.message, "error");
      return false;
    }
  }

  async function recoverThread() {
    const recovery = state.activeThread || loadRecovery();
    if (!recovery?.id) return;
    const thread = state.threads.find((entry) => entry.id === recovery.id);
    if (!thread) {
      localStorage.removeItem(RECOVERY_KEY);
      return;
    }
    await resumeThread(thread);
  }

  function newThread() {
    if (state.snapshotFallback) return;
    if (state.pendingTurnRequest) {
      toast("当前消息仍在确认发送，请等待连接恢复", "error");
      return;
    }
    if (state.activeTurnId) {
      toast("当前任务仍在处理，请完成或终止任务后再新建对话", "error");
      return;
    }
    stopPolling();
    state.taskStatusSnapshot = null;
    state.activeThread = null;
    state.activeTurnId = null;
    state.activeThreadNeedsResume = false;
    state.pendingText = null;
    state.pendingClientId = null;
    state.pendingCreatedAt = null;
    state.threadHistoryCursor = null;
    state.loadingEarlierTurns = false;
    state.messageNodes.clear();
    state.transcriptExpansion.clear();
    localStorage.removeItem(RECOVERY_KEY);
    sendClientState(null);
    renderActiveThread();
    renderThreads();
    closeThreads();
    elements.promptInput.focus();
    void loadTaskStatus({ force: true });
  }

  async function sendPrompt() {
    if (state.snapshotFallback) {
      toast("最后有效聊天快照为只读，官方记录恢复后才能发送", "error");
      return;
    }
    if (
      !state.bridgeReady
      || !state.initialDataReady
      || !state.projectsReady
      || !state.bootstrapped
      || !state.currentProject
      || state.projectSwitchPending
    ) {
      updateTurnState();
      return;
    }
    if (state.providerConfigurationRequired) {
      toast(
        canEditProviderProfiles() ? "请先添加并启用 API 供应商" : "请联系管理员分配 API 供应商",
        "error",
      );
      return;
    }
    const text = elements.promptInput.value.trim();
    if (
      state.promptSubmissionGuard
      || !text
      || !state.bridgeReady
      || state.activeTurnId
      || state.pendingTurnRequest
      || !state.currentProject
    ) return;
    state.promptSubmissionGuard = true;
    try {
      if (state.activeThread && state.activeThreadNeedsResume) {
        if (!(await resumeThread(state.activeThread))) return;
      }
      elements.promptInput.value = "";
      resizePrompt();
      state.pendingText = text;
      state.pendingCreatedAt = Date.now();
      renderMessages(true);
      setBusy(true, "正在启动");
      if (!state.activeThread) {
        const params = {
          model: state.selectedModel,
          modelProvider: state.currentProviderId || undefined,
          cwd: state.currentProject.path,
          ephemeral: false,
        };
        addPolicyParams(params);
        const result = await rpc("thread/start", params);
        state.activeThread = result.thread;
        state.threadHistoryCursor = null;
        state.selectedModel = result.model || state.selectedModel;
        state.selectedEffort = result.reasoningEffort || state.selectedEffort;
        sendClientState(state.activeThread.id);
        rememberThread();
        renderActiveThread(true);
        await loadThreads();
      }
      const clientMessageId = createMessageId();
      state.pendingClientId = clientMessageId;
      const params = {
        threadId: state.activeThread.id,
        clientUserMessageId: clientMessageId,
        _wflThreadLeaseOwnerId: THREAD_LEASE_OWNER_ID,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: state.currentProject.path,
        model: state.selectedModel,
        effort: state.selectedEffort,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(state.selectedReferenceIds.size
          ? { referenceIds: [...state.selectedReferenceIds] }
          : {}),
      };
      state.pendingTurnRequest = { params, text, createdAt: state.pendingCreatedAt };
      await submitPendingTurnRequest();
    } catch (error) {
      failPendingTurnRequest(error, text);
    } finally {
      state.promptSubmissionGuard = false;
    }
  }

  async function retryPendingTurnRequest() {
    if (!state.pendingTurnRequest || state.turnStartRequestPending || !state.bridgeReady) return;
    await submitPendingTurnRequest(true);
  }

  async function submitPendingTurnRequest(isRetry = false) {
    const request = state.pendingTurnRequest;
    if (!request || state.turnStartRequestPending || !state.bridgeReady) return;
    state.turnStartRequestPending = true;
    setBusy(true, isRetry ? "正在确认发送" : "正在启动");
    try {
      const result = await rpc("turn/start", request.params);
      if (state.pendingTurnRequest !== request) return;
      upsertTurn(result.turn);
      state.pendingTurnRequest = null;
      state.activeTurnId = turnStatusType(result.turn) === "inProgress" ? result.turn.id : null;
      if (state.activeTurnId) {
        state.terminalTaskAuthorities.delete(request.params.threadId);
        state.taskStatusSnapshot = {
          ...(state.taskStatusSnapshot || {}),
          status: "running",
          phase: "starting",
          threadId: request.params.threadId,
          turnId: state.activeTurnId,
          startedAt: Date.now(),
          finishedAt: null,
        };
      }
      settlePendingText();
      if (state.activeTurnId) renderTaskStatus(state.taskStatusSnapshot);
      renderActiveThread(true);
      if (state.activeTurnId) startPolling();
    } catch (error) {
      if (state.pendingTurnRequest !== request) return;
      if (error.deliveryUnknown) {
        setBusy(true, "等待连接确认");
        renderMessages(true);
        toast("连接中断，本条消息将在恢复后安全确认", "error");
        return;
      }
      failPendingTurnRequest(error, request.text);
    } finally {
      state.turnStartRequestPending = false;
    }
  }

  function failPendingTurnRequest(error, text) {
    state.pendingTurnRequest = null;
    elements.promptInput.value = text;
    resizePrompt();
    state.pendingText = null;
    state.pendingClientId = null;
    state.pendingCreatedAt = null;
    setBusy(false);
    renderMessages();
    toast(error.message, "error");
  }

  async function interruptTurn() {
    const threadId = state.activeThread?.id;
    const task = state.taskStatusSnapshot?.threadId === threadId ? state.taskStatusSnapshot : null;
    const turnId = state.activeTurnId || task?.turnId || null;
    if (!threadId) return;
    elements.stopButton.disabled = true;
    try {
      if (!turnId && task?.status === "queued") {
        const response = await fetchWithTimeout(`${API_BASE}/task/admission/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Codex-Desktop-Action": "task-admission-cancel",
          },
          body: JSON.stringify({ threadId }),
        }, 18_000);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "无法取消排队任务");
        toast("排队任务已取消");
      } else if (turnId) {
        await rpc("turn/interrupt", { threadId, turnId });
        toast("已发送终止请求");
      } else {
        return;
      }
      await loadTaskStatus({ force: true });
    } catch (error) {
      toast(error.message, "error");
    } finally {
      elements.stopButton.disabled = false;
    }
  }

  async function deleteActiveThread() {
    if (state.snapshotFallback || !state.activeThread || state.activeTurnId || state.pendingTurnRequest) return;
    const title = state.activeThread.name || state.activeThread.preview || state.activeThread.id.slice(0, 8);
    if (!confirm(`永久删除“${title}”？`)) return;
    try {
      await rpc("thread/delete", { threadId: state.activeThread.id });
      newThread();
      await loadThreads();
      toast("对话已删除");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function copyThreadId() {
    if (!state.activeThread) return;
    try {
      await navigator.clipboard.writeText(state.activeThread.id);
      toast("对话 ID 已复制");
    } catch {
      toast("无法复制对话 ID", "error");
    }
  }

  function handleNotification(notification) {
    const { method, params = {} } = notification;
    const lifecycleEvent = method === "turn/started" || method === "turn/completed";
    const lifecycleContext = lifecycleEvent
      ? resolveTurnNotificationContext(params, { terminal: method === "turn/completed" })
      : null;
    const eventThreadId = lifecycleContext?.threadId || params.threadId;
    if (
      method === "turn/started"
      && lifecycleContext?.turnId
      && state.terminalTurnIds.has(lifecycleContext.turnId)
    ) {
      return;
    }
    const activeTurnBeforeEvent = inferCurrentTurnId()
      || state.activeTurnId
      || state.activeThread?.turns?.find((turn) => turnStatusType(turn) === "inProgress")?.id
      || null;
    if (["thread/started", "thread/name/updated", "thread/deleted", "thread/archived", "thread/unarchived"].includes(method)) {
      loadThreads();
    }
    if (method === "thread/deleted" && params.threadId === state.activeThread?.id) {
      newThread();
      return;
    }
    if (method === "thread/status/changed") {
      if (eventThreadId === state.activeThread?.id) {
        if (params.status?.type === "active") state.terminalTaskAuthorities.delete(eventThreadId);
        else void loadTaskStatus({ force: true });
      }
      return;
    }
    if (!state.activeThread || eventThreadId !== state.activeThread.id) return;
    const reconciledTurn = method === "turn/completed"
      ? reconcileTurnNotification(params, {
        terminal: true,
        threadId: eventThreadId,
        turnId: lifecycleContext?.turnId || null,
      })
      : method === "turn/started"
        ? reconcileTurnNotification(params, {
          threadId: eventThreadId,
          turnId: lifecycleContext?.turnId || null,
        })
        : null;
    if (method === "turn/started") {
      const startedTurn = reconciledTurn || params.turn || (params.turnId ? { id: params.turnId, status: "inProgress" } : null);
      state.terminalTaskAuthorities.delete(eventThreadId);
      state.activeTurnId = startedTurn?.id || state.activeTurnId;
      settlePendingTurnRequestFromTurn(eventThreadId, startedTurn, params);
      state.activeTurnId = startedTurn?.id || state.activeTurnId;
      setBusy(true, "正在处理");
      startPolling();
    }
    if (method === "turn/completed") {
      const activeBefore = activeTurnBeforeEvent;
      const completedTurnId = lifecycleContext?.turnId || params.turn?.id || params.turnId || null;
      if (completedTurnId) {
        rememberTerminalTurn(
          completedTurnId,
          turnStatusType(reconciledTurn || params.turn) || params.status || "completed",
        );
        rememberRescueTerminalTaskAuthority({
          threadId: eventThreadId,
          turnId: completedTurnId,
          status: turnStatusType(reconciledTurn || params.turn) || params.status || "completed",
          authoritative: true,
          canSend: true,
          completedAtMs: params.completedAtMs,
        }, { source: "turn-completed" });
      }
      const settled = settlePendingTurnRequestFromTurn(eventThreadId, reconciledTurn || params.turn, params);
      const belongsToActive = Boolean(
        (completedTurnId && activeBefore === completedTurnId)
        || settled
        || (!completedTurnId && lifecycleContext?.inferredCurrent && activeBefore),
      );
      if (belongsToActive) {
        state.activeTurnId = null;
        if (completedTurnId) {
          state.terminalTurnIds.add(completedTurnId);
          if (state.terminalTurnIds.size > 256) {
            state.terminalTurnIds = new Set([...state.terminalTurnIds].slice(-128));
          }
        }
        clearStaleTurnPointer(completedTurnId);
        if (settled || !completedTurnId) {
          settlePendingText();
          if (!settled) state.pendingTurnRequest = null;
        }
        stopPolling();
        setBusy(false, "就绪");
      }
      scheduleThreadRefresh(0);
      void loadTaskStatus({ force: true });
      loadThreads();
      return;
    }
    if (method.startsWith("item/") || method === "thread/compacted") scheduleThreadRefresh(120);
    if (method === "error") {
      const message = params.error?.message || "Codex 发生错误";
      const pendingRequest = state.pendingTurnRequest;
      const errorTurn = params.turn || (params.turnId ? { id: params.turnId } : null);
      const settledPending = pendingRequest
        && pendingErrorMatchesTurn(pendingRequest, params.threadId, errorTurn, params);
      const errorTargetsActive = params.threadId === state.activeThread?.id
        && (!params.turnId || params.turnId === state.activeTurnId);
      if (settledPending) {
        failPendingTurnRequest(new Error(message), pendingRequest.text);
      }
      if (errorTargetsActive) {
        state.activeTurnId = null;
        if (!settledPending) state.pendingTurnRequest = null;
        settlePendingText();
        stopPolling();
        setBusy(false, "发送失败，请重试");
      }
      toast(message, "error");
    }
  }

  function scheduleThreadRefresh(delay = 180) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshActiveThread, delay);
  }

  async function refreshActiveThread() {
    if (!state.activeThread || !state.bridgeReady || state.pollBusy) return;
    const nearBottom = isNearBottom();
    state.pollBusy = true;
    const threadId = state.activeThread.id;
    try {
      const result = await rpc("thread/turns/list", recentTurnsParams(threadId));
      if (state.activeThread?.id !== threadId) return;
      applySnapshotMode(result.rescueSnapshot);
      const previousProjectedTurnId = state.activeTurnId || null;
      state.activeThread.turns = mergeTurnPages(
        state.activeThread.turns || [],
        normalizeRecentTurns(result.data),
      );
      settlePendingText();
      for (const turn of state.activeThread.turns || []) {
        settlePendingTurnRequestFromTurn(threadId, turn, { turn, turnId: turn.id });
      }
      syncActiveTurn();
      if (
        !previousProjectedTurnId
        && state.activeTurnId
        && !rescueTaskStatusIsActive(state.taskStatusSnapshot?.status)
      ) {
        // History can replay an old inProgress Turn immediately after a
        // terminal notification. Reconcile this exact ID so the server can
        // return staleTurnId and release the composer without a reload.
        void loadTaskStatus({ force: true });
      }
      rememberThread();
      renderActiveThread(nearBottom);
      if (!state.activeTurnId) stopPolling();
    } catch (error) {
      console.error("Unable to refresh rescue thread:", error);
    } finally {
      state.pollBusy = false;
    }
  }

  function recentTurnsParams(threadId, cursor = null) {
    return {
      threadId,
      cursor,
      limit: RECENT_TURNS_SHOWN,
      sortDirection: "desc",
      itemsView: "full",
    };
  }

  function normalizeRecentTurns(turns) {
    const current = Array.isArray(turns) ? [...turns] : [];
    const ordered = orderTurnsChronologically(current);
    return fenceTerminalTurns(ordered.evidence ? ordered.turns : current.reverse());
  }

  function orderTurnsChronologically(turns) {
    const ordered = (Array.isArray(turns) ? turns : [])
      .map((turn, index) => ({ turn, index, time: turnTime(turn) }));
    if (ordered.length < 2) return { turns: ordered.map((entry) => entry.turn), evidence: true };
    const allHaveTime = ordered.every((entry) => entry.time !== null);
    const allHaveUuidV7 = ordered.every((entry) => uuidV7Identifier(entry.turn?.id));
    if (!allHaveTime && !allHaveUuidV7) return { turns: ordered.map((entry) => entry.turn), evidence: false };
    ordered.sort((left, right) => {
      // UUIDv7 is the Turn creation clock. Observation timestamps may come
      // from a later rescue/main calibration and must not move old Turns down.
      if (allHaveUuidV7) {
        const difference = left.turn.id.localeCompare(right.turn.id);
        if (difference) return difference;
      }
      if (allHaveTime) {
        const difference = left.time - right.time;
        if (difference) return difference;
      }
      return left.index - right.index;
    });
    return { turns: ordered.map((entry) => entry.turn), evidence: true };
  }

  function turnTime(turn) {
    const userMessage = (Array.isArray(turn?.items) ? turn.items : [])
      .find((item) => item?.type === "userMessage");
    for (const value of [
      userMessage?._eventAt,
      userMessage?.createdAt,
      userMessage?.startedAt,
      userMessage?.timestamp,
    ]) {
      const normalized = normalizeMessageTimestamp(value);
      if (normalized !== null) return normalized;
    }
    for (const value of [
      turn?._eventAt,
      turn?.createdAt,
      turn?.startedAt,
      turn?.timestamp,
      turn?._displayCreatedAt,
    ]) {
      const normalized = normalizeMessageTimestamp(value);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  function uuidV7Identifier(value) {
    return typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function mergeTurnPages(current, incoming, { prepend = false } = {}) {
    const byId = new Map();
    const order = prepend ? [...incoming, ...current] : [...current, ...incoming];
    for (const turn of order) {
      if (!turn?.id) continue;
      const previous = byId.get(turn.id);
      byId.set(
        turn.id,
        fenceTerminalTurn(previous ? mergeTurn(previous, turn) : turn),
      );
    }
    return fenceRescueTurnsByTaskAuthority(
      state.activeThread?.id || null,
      fenceTerminalTurns(orderTurnsChronologically([...byId.values()]).turns),
    );
  }

  async function loadEarlierTurns() {
    const threadId = state.activeThread?.id;
    const cursor = state.threadHistoryCursor;
    if (!threadId || !cursor || state.loadingEarlierTurns || !state.bridgeReady) return;
    state.loadingEarlierTurns = true;
    renderMessages();
    const oldHeight = elements.messageStage.scrollHeight;
    const oldTop = elements.messageStage.scrollTop;
    try {
      const page = await rpc("thread/turns/list", recentTurnsParams(threadId, cursor));
      if (state.activeThread?.id !== threadId || state.threadHistoryCursor !== cursor) return;
      state.activeThread.turns = mergeTurnPages(
        state.activeThread.turns || [],
        normalizeRecentTurns(page.data),
        { prepend: true },
      );
      state.threadHistoryCursor = page.nextCursor || null;
      rememberThread();
    } catch (error) {
      toast(`无法加载更早对话：${error.message}`, "error");
    } finally {
      state.loadingEarlierTurns = false;
      if (state.activeThread?.id === threadId) {
        renderMessages();
        requestAnimationFrame(() => {
          elements.messageStage.scrollTop = oldTop + elements.messageStage.scrollHeight - oldHeight;
        });
      }
    }
  }

  function renderHistoryPager() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-button";
    button.disabled = state.loadingEarlierTurns;
    button.textContent = state.loadingEarlierTurns ? "正在加载更早对话" : "加载更早对话";
    button.addEventListener("click", loadEarlierTurns);
    return button;
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(refreshActiveThread, 1_800);
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function syncActiveTurn() {
    const threadId = state.activeThread?.id || null;
    if (threadId) {
      state.activeThread.turns = fenceRescueTurnsByTaskAuthority(threadId, state.activeThread.turns || []);
    }
    const candidates = (state.activeThread?.turns || [])
      .filter((turn) => turnStatusType(turn) === "inProgress" && !state.terminalTurnIds.has(turn?.id));
    const authority = threadId ? state.terminalTaskAuthorities.get(threadId) : null;
    const projectionIsAmbiguous = Boolean(
      authority?.canSend
      && candidates.length > 1
      && !authority.turnId
      && !authority.staleTurnId
      && !(authority.fencedTurnIds || []).includes(state.activeTurnId),
    );
    const active = candidates.find((turn) => turn?.id === state.activeTurnId)
      || (!projectionIsAmbiguous ? candidates.at(-1) : null)
      || null;
    state.activeTurnId = active?.id || null;
    if (active) settlePendingTurnRequestFromTurn(state.activeThread?.id, active, { turn: active, turnId: active.id });
    const turnBusy = Boolean(state.activeTurnId || state.pendingTurnRequest);
    setBusy(turnBusy, state.activeTurnId ? "正在处理" : state.pendingTurnRequest ? "正在确认发送" : "就绪");
  }

  function clearStaleTurnPointer(completedTurnId = null) {
    const turnId = state.activeTurnId;
    if (!turnId) return;
    if (completedTurnId && turnId === completedTurnId) {
      state.activeTurnId = null;
      return;
    }
    if (state.terminalTurnIds.has(turnId)) {
      state.activeTurnId = null;
      return;
    }
    const localTurn = state.activeThread?.turns?.find((turn) => turn?.id === turnId);
    if (localTurn && turnStatusType(localTurn) !== "inProgress") state.activeTurnId = null;
    else if (
      completedTurnId
      && !localInProgressTurnIds().length
      && !state.pendingTurnRequest
      && !state.turnStartRequestPending
    ) state.activeTurnId = null;
  }

  function turnStatusType(turn) {
    const status = turn?.status;
    return status && typeof status === "object" ? status.type : status;
  }

  function turnUserMessageItems(turn) {
    return (Array.isArray(turn?.items) ? turn.items : [])
      .filter((item) => item?.type === "userMessage");
  }

  function turnNotificationId(params = {}) {
    return params?.turn?.id || params?.turnId || null;
  }

  function uniqueTurnIds(values) {
    return [...new Set(values.filter((value) => typeof value === "string" && value))];
  }

  function localInProgressTurnIds() {
    return uniqueTurnIds(
      (state.activeThread?.turns || [])
        .filter((turn) => (
          turnStatusType(turn) === "inProgress"
          && !state.terminalTurnIds.has(turn?.id)
        ))
        .map((turn) => turn?.id),
    );
  }

  function turnLifecycleTimestamp(params = {}) {
    for (const value of [
      params.completedAtMs,
      params.completedAt,
      params.turn?.completedAtMs,
      params.turn?.completedAt,
      params.turn?.updatedAt,
    ]) {
      const normalized = normalizeMessageTimestamp(value);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  function turnStartedTimestamp(turn) {
    for (const value of [
      turn?.startedAtMs,
      turn?.startedAt,
      turn?.createdAtMs,
      turn?.createdAt,
      turn?._eventAt,
      turn?._displayCreatedAt,
    ]) {
      const normalized = normalizeMessageTimestamp(value);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  function turnUserMessageClientIds(turn) {
    return turnUserMessageItems(turn)
      .map((item) => item?.clientId)
      .filter((value) => typeof value === "string" && value);
  }

  function notificationTurnClientIds(params = {}) {
    return uniqueTurnIds([
      params.clientUserMessageId,
      params.turn?.clientUserMessageId,
      ...turnUserMessageClientIds(params.turn),
    ]);
  }

  function turnMatchesNotificationIdentity(turn, clientIds) {
    if (!clientIds.length) return false;
    return turnUserMessageClientIds(turn).some((id) => clientIds.includes(id))
      || (typeof turn?.clientUserMessageId === "string" && clientIds.includes(turn.clientUserMessageId));
  }

  function terminalEventCanSettleTurn(turn, params = {}) {
    const completedAt = turnLifecycleTimestamp(params);
    const startedAt = turnStartedTimestamp(turn);
    return completedAt === null || startedAt === null || completedAt >= startedAt;
  }

  function rescueTaskStatusIsActive(status) {
    return ["queued", "running", "waiting", "stopping", "uncertain"].includes(status);
  }

  function rescueTaskStatusIsActiveForCurrentThread() {
    const snapshot = state.taskStatusSnapshot;
    const activeThreadId = state.activeThread?.id;
    return Boolean(
      snapshot?.threadId
      && activeThreadId
      && snapshot.threadId === activeThreadId
      && rescueTaskStatusIsActive(snapshot.status),
    );
  }

  function authoritativeTrackedTurnIds() {
    const task = state.taskStatusSnapshot;
    const taskTurnId = task?.threadId === state.activeThread?.id
      && rescueTaskStatusIsActive(task.status)
      ? task.turnId
      : null;
    return uniqueTurnIds([taskTurnId, state.activeTurnId]);
  }

  function inferCurrentTurnId(params = {}, { terminal = false } = {}) {
    const localTurnIds = localInProgressTurnIds();
    const clientIds = notificationTurnClientIds(params);
    if (clientIds.length) {
      const matches = localTurnIds.filter((id) => {
        const turn = state.activeThread?.turns?.find((candidate) => candidate?.id === id);
        return turnMatchesNotificationIdentity(turn, clientIds);
      });
      return matches.length === 1 ? matches[0] : null;
    }

    const authoritative = authoritativeTrackedTurnIds();
    const localAuthoritative = authoritative.filter((id) => localTurnIds.includes(id));
    if (localAuthoritative.length === 1) {
      const turn = state.activeThread?.turns?.find((candidate) => candidate?.id === localAuthoritative[0]);
      return !terminal || terminalEventCanSettleTurn(turn, params) ? localAuthoritative[0] : null;
    }
    if (localTurnIds.length === 1) {
      const turn = state.activeThread?.turns?.find((candidate) => candidate?.id === localTurnIds[0]);
      return !terminal || terminalEventCanSettleTurn(turn, params) ? localTurnIds[0] : null;
    }

    const viableTracked = authoritative.filter((id) => {
      if (state.terminalTurnIds.has(id)) return false;
      const localTurn = state.activeThread?.turns?.find((turn) => turn?.id === id);
      return !localTurn || turnStatusType(localTurn) === "inProgress";
    });
    return viableTracked.length === 1 ? viableTracked[0] : null;
  }

  function resolveTurnNotificationContext(params = {}, { terminal = false } = {}) {
    const explicitThreadId = params?.threadId || params?.turn?.threadId || null;
    const explicitTurnId = turnNotificationId(params);
    const activeThreadId = state.activeThread?.id || null;
    const pending = state.pendingTurnRequest;
    const expectedClientId = pending?.params?.clientUserMessageId || null;
    const observedClientIds = [
      params?.clientUserMessageId,
      params?.turn?.clientUserMessageId,
      ...turnUserMessageItems(params?.turn).map((item) => item?.clientId),
    ].filter((value) => typeof value === "string" && value);
    const pendingMatch = Boolean(
      expectedClientId
      && pending?.params?.threadId
      && observedClientIds.includes(expectedClientId),
    );

    if (explicitThreadId) {
      if (explicitTurnId || explicitThreadId !== activeThreadId) {
        return {
          threadId: explicitThreadId,
          turnId: explicitTurnId,
          pendingMatch: pendingMatch && pending?.params?.threadId === explicitThreadId,
          inferredCurrent: false,
          source: explicitTurnId ? "explicit" : "thread-only",
        };
      }
      // A completion scoped to the visible Thread may omit its Turn ID. Keep
      // resolving below so the single local Turn can release the composer.
    }

    if (!activeThreadId) {
      return {
        threadId: explicitThreadId || null,
        turnId: explicitTurnId,
        pendingMatch: false,
        inferredCurrent: false,
        source: explicitTurnId ? "turn-only" : "unscoped",
      };
    }

    if (explicitTurnId) {
      const localTurn = state.activeThread.turns?.find((turn) => turn?.id === explicitTurnId);
      const belongsToActive = (
        state.activeTurnId === explicitTurnId
        || Boolean(localTurn)
        || (pendingMatch && pending?.params?.threadId === activeThreadId)
      );
      if (!explicitThreadId && !belongsToActive) {
        return {
          threadId: null,
          turnId: explicitTurnId,
          pendingMatch: false,
          inferredCurrent: false,
          source: "unmatched-turn",
        };
      }
      return {
        threadId: explicitThreadId || activeThreadId,
        turnId: explicitTurnId,
        pendingMatch: pendingMatch && pending?.params?.threadId === (explicitThreadId || activeThreadId),
        inferredCurrent: !explicitThreadId,
        source: explicitThreadId ? "explicit" : "active-turn",
      };
    }

    const turnId = inferCurrentTurnId(params, { terminal });
    const source = turnId
      ? localInProgressTurnIds().length === 1 ? "unique-local-turn" : "tracked-turn"
      : null;
    const threadId = explicitThreadId || activeThreadId;
    return {
      threadId,
      turnId,
      pendingMatch: pendingMatch && pending?.params?.threadId === threadId,
      inferredCurrent: Boolean(turnId),
      source: source || (pendingMatch ? "pending-client" : "active-thread"),
    };
  }

  function turnNotificationThreadId(params = {}) {
    return resolveTurnNotificationContext(params).threadId;
  }

  function pendingTurnRequestMatchesTurn(request, threadId, turn, params = {}) {
    if (!request || !threadId || request.params?.threadId !== threadId) return false;
    const expectedClientId = request.params?.clientUserMessageId;
    const observedClientIds = [
      params.clientUserMessageId,
      params.turn?.clientUserMessageId,
      turn?.clientUserMessageId,
      ...turnUserMessageItems(turn).map((item) => item?.clientId),
    ].filter((value) => typeof value === "string" && value);
    if (expectedClientId && observedClientIds.length) return observedClientIds.includes(expectedClientId);
    const eventTurnId = params.turnId || params.turn?.id || turn?.id;
    if (
      expectedClientId
      && eventTurnId
      && (
        state.activeTurnId === eventTurnId
        || state.activeThread?.turns?.some((candidate) => (
          candidate?.id === eventTurnId && turnStatusType(candidate) === "inProgress"
        ))
      )
    ) return true;
    const expectedText = String(request.text || "").trim();
    if (!expectedText) return false;
    if (!turnUserMessageItems(turn).some((item) => userMessageText(item) === expectedText)) return false;
    if (eventTurnId && state.activeTurnId && state.activeTurnId !== eventTurnId) return false;
    const requestCreatedAt = Number(request.createdAt || state.pendingCreatedAt);
    const turnCreatedAt = normalizeMessageTimestamp(
      turn?.createdAt
        || turn?.startedAt
        || turn?.updatedAt
        || turnUserMessageItems(turn)[0]?.createdAt,
    );
    return Number.isFinite(requestCreatedAt)
      && requestCreatedAt > 0
      && Number.isFinite(turnCreatedAt)
      && turnCreatedAt >= requestCreatedAt - 2_000;
  }

  function pendingErrorMatchesTurn(request, threadId, turn, params = {}) {
    return pendingTurnRequestMatchesTurn(request, threadId, turn, params);
  }

  function reconcileTurnNotification(
    params,
    { terminal = false, threadId = turnNotificationThreadId(params), turnId = null } = {},
  ) {
    const context = resolveTurnNotificationContext(params, { terminal });
    const targetThreadId = threadId || context.threadId;
    const targetTurnId = turnId || context.turnId;
    if (!targetTurnId || state.activeThread?.id !== targetThreadId) return null;
    const current = state.activeThread.turns?.find((turn) => turn.id === targetTurnId) || null;
    const incoming = params.turn && typeof params.turn === "object" ? params.turn : {};
    const status = terminal
      ? turnStatusType(incoming) !== "inProgress"
        ? incoming.status
        : params.status || params.turnStatus || "completed"
      : incoming.status || current?.status || "inProgress";
    const next = {
      ...(current || {}),
      ...incoming,
      id: targetTurnId,
      ...(status ? { status } : {}),
    };
    upsertTurn(next);
    return state.activeThread.turns?.find((turn) => turn.id === targetTurnId) || next;
  }

  function settlePendingTurnRequestFromTurn(threadId, turn, params = {}) {
    const request = state.pendingTurnRequest;
    if (!pendingTurnRequestMatchesTurn(request, threadId, turn, params)) return false;
    state.pendingTurnRequest = null;
    state.pendingText = null;
    state.pendingClientId = null;
    state.pendingCreatedAt = null;
    if (turn?.id) upsertTurn(turn);
    elements.promptInput.value = "";
    resizePrompt();
    return true;
  }

  function upsertTurn(incoming) {
    if (!state.activeThread || !incoming) return;
    state.activeThread.turns ||= [];
    const index = state.activeThread.turns.findIndex((turn) => turn.id === incoming.id);
    const withFence = state.terminalTurnIds.has(incoming.id)
      && turnStatusType(incoming) === "inProgress"
      ? { ...incoming, status: terminalTurnStatus(incoming.id) }
      : incoming;
    if (index === -1) state.activeThread.turns.push(
      messageTimestamp(null, withFence) ? withFence : { ...withFence, _displayCreatedAt: Date.now() },
    );
    else state.activeThread.turns[index] = fenceTerminalTurn(
      mergeTurn(state.activeThread.turns[index], withFence),
    );
    state.activeThread.turns = orderTurnsChronologically(state.activeThread.turns).turns;
    const stored = state.activeThread.turns.find((turn) => turn.id === incoming.id);
    if (turnStatusType(stored) !== "inProgress") rememberTerminalTurn(stored.id, turnStatusType(stored));
  }

  function mergeTurn(current, incoming) {
    if (!current) return {
      ...incoming,
      items: Array.isArray(incoming.items) ? incoming.items : [],
    };
    if (!incoming) return current;
    const currentItems = Array.isArray(current.items) ? current.items : [];
    const incomingItems = Array.isArray(incoming.items) ? incoming.items : [];
    const next = {
      ...current,
      ...incoming,
      _displayCreatedAt: incoming._displayCreatedAt ?? current._displayCreatedAt,
    };
    if (turnStatusType(current) !== "inProgress" && turnStatusType(incoming) === "inProgress") {
      next.status = current.status;
    }
    if (!incomingItems.length) {
      next.items = currentItems;
      return next;
    }
    const currentById = new Map(currentItems.filter((item) => item?.id).map((item) => [item.id, item]));
    const incomingIds = new Set();
    const mergedItems = incomingItems.map((item) => {
      if (!item?.id) return item;
      incomingIds.add(item.id);
      return { ...(currentById.get(item.id) || {}), ...item };
    });
    for (const item of currentItems) {
      if (!item?.id || !incomingIds.has(item.id)) mergedItems.push(item);
    }
    next.items = mergedItems;
    return next;
  }

  function rememberTerminalTurn(turnId, status = "completed") {
    if (typeof turnId !== "string" || !turnId) return;
    const normalized = turnStatusType({ status }) === "inProgress"
      ? "completed"
      : (turnStatusType({ status }) || "completed");
    state.terminalTurnIds.add(turnId);
    state.terminalTurnStatuses.set(turnId, normalized);
    if (state.terminalTurnIds.size > 256) {
      state.terminalTurnIds = new Set([...state.terminalTurnIds].slice(-128));
      state.terminalTurnStatuses = new Map(
        [...state.terminalTurnStatuses.entries()]
          .filter(([id]) => state.terminalTurnIds.has(id)),
      );
    }
  }

  function terminalTurnStatus(turnId) {
    return state.terminalTurnStatuses.get(turnId) || "completed";
  }

  function fenceTerminalTurn(turn) {
    if (!turn?.id) return turn;
    const status = turnStatusType(turn);
    if (status && status !== "inProgress") {
      rememberTerminalTurn(turn.id, status);
      return turn;
    }
    if (!state.terminalTurnIds.has(turn.id) || status !== "inProgress") return turn;
    return { ...turn, status: terminalTurnStatus(turn.id) };
  }

  function fenceTerminalTurns(turns) {
    return (Array.isArray(turns) ? turns : []).map(fenceTerminalTurn);
  }

  function settlePendingText() {
    if (!state.pendingText) return;
    const found = (state.activeThread?.turns || []).some((turn) =>
      (turn.items || []).some((item) =>
        item.type === "userMessage"
        && (state.pendingClientId ? item.clientId === state.pendingClientId : userMessageText(item) === state.pendingText),
      ),
    );
    if (found) {
      state.pendingText = null;
      state.pendingClientId = null;
      state.pendingCreatedAt = null;
    }
  }

  function renderActiveThread(forceBottom = false) {
    const thread = state.activeThread;
    elements.threadTitle.textContent = thread?.name || thread?.preview || "新对话";
    elements.threadProject.textContent = basename(thread?.cwd || state.currentProject?.path || "未选择工程");
    elements.copyIdButton.disabled = !thread;
    elements.deleteThreadButton.disabled = state.snapshotFallback || !thread || Boolean(state.activeTurnId || state.pendingTurnRequest);
    renderReferenceBanner();
    renderMessages(forceBottom);
    updateTurnState();
  }

  function renderThreadHeader() {
    elements.threadProject.textContent = basename(state.activeThread?.cwd || state.currentProject?.path || "未选择工程");
  }

  function renderMessages(forceBottom = false) {
    const turns = state.activeThread?.turns || [];
    const desired = [];
    const activeKeys = new Set();
    let count = 0;
    if (state.threadHistoryCursor) {
      desired.push(renderHistoryPager());
    }
    for (const turn of turns) {
      for (const [index, item] of (turn.items || []).entries()) {
        const key = transcriptItemKey(turn, item, index);
        const signature = transcriptItemSignature(item, turn);
        activeKeys.add(key);
        let node = state.messageNodes.get(key);
        if (!node || node.dataset.renderSignature !== signature) {
          rememberTranscriptExpansion(key, node);
          node = renderItem(item, turn, key);
          if (node) {
            node.dataset.renderKey = key;
            node.dataset.renderSignature = signature;
            state.messageNodes.set(key, node);
          }
        }
        if (!node) continue;
        desired.push(node);
        count += 1;
      }
    }
    if (state.pendingText) {
      const key = `pending:${state.pendingClientId || state.pendingCreatedAt || state.pendingText}`;
      activeKeys.add(key);
      let node = state.messageNodes.get(key);
      const signature = `${state.pendingText}\0${state.pendingCreatedAt || ""}`;
      if (!node || node.dataset.renderSignature !== signature) {
        node = renderMessage("user", state.pendingText, state.pendingCreatedAt);
        node.dataset.renderKey = key;
        node.dataset.renderSignature = signature;
        state.messageNodes.set(key, node);
      }
      desired.push(node);
      count += 1;
    }
    reconcileMessageNodes(desired);
    for (const key of state.messageNodes.keys()) {
      if (!activeKeys.has(key)) state.messageNodes.delete(key);
    }
    elements.emptyState.hidden = count > 0;
    refreshIcons();
    if (forceBottom) requestAnimationFrame(scrollToBottom);
  }

  function transcriptItemKey(turn, item, index) {
    const threadId = state.activeThread?.id || "new";
    const itemId = item?.id || item?.clientId || `${item?.type || "item"}:${index}`;
    return `${threadId}:${turn?.id || "turn"}:${itemId}`;
  }

  function transcriptItemSignature(item, turn) {
    return JSON.stringify([item, messageTimestamp(item, turn)]);
  }

  function rememberTranscriptExpansion(key, node) {
    if (node?.tagName === "DETAILS") state.transcriptExpansion.set(key, node.open);
  }

  function reconcileMessageNodes(desired) {
    for (let index = 0; index < desired.length; index += 1) {
      const node = desired[index];
      const current = elements.messageList.children[index];
      if (current !== node) elements.messageList.insertBefore(node, current || null);
    }
    while (elements.messageList.children.length > desired.length) {
      elements.messageList.lastElementChild.remove();
    }
  }

  function renderItem(item, turn, expansionKey) {
    if (!item) return null;
    const timestamp = messageTimestamp(item, turn);
    if (item.type === "userMessage") {
      const parsed = rescueUserMessage(item);
      return renderMessage("user", parsed.text, timestamp, { referenceCount: parsed.referenceCount });
    }
    if (item.type === "agentMessage" && item.text) return renderMessage("agent", item.text, timestamp);
    if (item.type === "reasoning") return renderTool("推理摘要", (item.summary || []).join("\n"), item.status, expansionKey);
    if (item.type === "plan") return renderTool("计划", item.text || "", item.status, expansionKey);
    if (item.type === "commandExecution") return renderTool(item.command || "命令", item.aggregatedOutput || "", item.status, expansionKey);
    if (item.type === "fileChange") {
      return renderTool("文件更改", (item.changes || []).map((change) => `${change.kind}: ${change.path}`).join("\n"), item.status, expansionKey);
    }
    if (item.type === "mcpToolCall") {
      const result = item.error ? item.error.message : item.result ? JSON.stringify(item.result, null, 2) : "";
      return renderTool(`${item.server || "MCP"} / ${item.tool || "工具"}`, result, item.status, expansionKey);
    }
    if (item.type === "webSearch") return renderTool("网页搜索", "", item.status, expansionKey);
    if (item.type === "imageGeneration") return renderTool("生成图片", item.savedPath || item.revisedPrompt || "", item.status, expansionKey);
    return null;
  }

  function rescueUserMessage(item) {
    const parts = Array.isArray(item?.content) ? item.content : [item?.content];
    const raw = parts.map((content) => {
      if (typeof content === "string") return content;
      if (content?.type === "text") return content.text;
      if (content?.type === "mention") return `[文件] ${content.name || basename(content.path || "")}`;
      if (content?.type === "localImage" || content?.type === "image") return "[图片]";
      return "";
    }).filter(Boolean).join("\n");
    const start = raw.indexOf(RESCUE_REFERENCE_MARKER);
    if (start < 0) return { text: raw, referenceCount: 0 };
    const end = raw.indexOf(RESCUE_REFERENCE_END_MARKER, start + RESCUE_REFERENCE_MARKER.length);
    const contextEnd = end >= 0 ? end + RESCUE_REFERENCE_END_MARKER.length : raw.length;
    const visible = `${raw.slice(0, start)}${raw.slice(contextEnd)}`.trim();
    const context = raw.slice(start, contextEnd);
    const referenceCount = Math.max(1, context.match(/^引用编号：/gmu)?.length || 0);
    return {
      text: visible || "（已发送主站只读引用）",
      referenceCount,
    };
  }

  function renderMessage(role, text, timestamp = null, { referenceCount = 0 } = {}) {
    if (!text) return null;
    const article = document.createElement("article");
    article.className = `message ${role}`;
    article.innerHTML = `<span class="message-avatar"><i data-lucide="${role === "agent" ? "terminal" : "user"}"></i></span><div class="message-content"><div class="message-label"><span>${role === "agent" ? "Codex" : interfaceIsEnglish() ? "You" : "你"}</span><time hidden></time></div><div class="message-text"></div></div>`;
    article.querySelector(".message-text").textContent = text;
    if (role === "user" && referenceCount > 0) {
      article.classList.add("has-reference");
      const note = document.createElement("small");
      note.className = "message-reference-note";
      note.textContent = `已附加 ${referenceCount} 个主站只读引用`;
      article.querySelector(".message-label").append(note);
    }
    const normalizedTime = normalizeMessageTimestamp(timestamp);
    if (normalizedTime) {
      const time = article.querySelector("time");
      time.hidden = false;
      time.dateTime = new Date(normalizedTime).toISOString();
      time.textContent = new Date(normalizedTime).toLocaleTimeString(interfaceLocale(), {
        hour: "2-digit", minute: "2-digit", hour12: false,
      });
      time.title = new Date(normalizedTime).toLocaleString(interfaceLocale(), { hour12: false });
    }
    return article;
  }

  function messageTimestamp(item, turn) {
    return item?.createdAt ?? item?.startedAt ?? item?.timestamp
      ?? turn?.createdAt ?? turn?.startedAt ?? turn?.timestamp ?? turn?._displayCreatedAt;
  }

  function normalizeMessageTimestamp(value) {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }

  function renderTool(title, output, status, expansionKey) {
    const details = document.createElement("details");
    details.className = "tool-item";
    const summary = document.createElement("summary");
    summary.textContent = `${title}${statusLabel(status) ? ` · ${statusLabel(status)}` : ""}`;
    const content = document.createElement("pre");
    content.className = "tool-output";
    content.textContent = output || "暂无输出";
    details.append(summary, content);
    details.open = state.transcriptExpansion.get(expansionKey) === true;
    details.addEventListener("toggle", () => state.transcriptExpansion.set(expansionKey, details.open));
    return details;
  }

  function userMessageText(item) {
    return rescueUserMessage(item).text;
  }

  function setBusy(busy, label = busy ? "正在处理" : "就绪") {
    const taskBusy = rescueTaskStatusIsActiveForCurrentThread();
    const effectiveBusy = busy || taskBusy;
    const currentTask = state.taskStatusSnapshot?.threadId === state.activeThread?.id
      ? state.taskStatusSnapshot
      : null;
    const canCancelQueuedTask = currentTask?.status === "queued";
    elements.stopButton.hidden = !(state.activeTurnId || canCancelQueuedTask);
    const composerReady = Boolean(
      state.bridgeReady
      && state.initialDataReady
      && state.currentProject
      && state.bootstrapped
      && !state.snapshotFallback
      && !state.projectSwitchPending,
    );
    elements.sendButton.disabled = !composerReady || effectiveBusy;
    elements.turnState.dataset.status = !effectiveBusy && composerReady ? "ready" : state.bridgeReady ? "working" : "offline";
    elements.turnState.querySelector("span").textContent = state.projectSwitchPending
      ? "正在切换备用工程"
      : composerReady ? effectiveBusy && taskBusy && !state.activeTurnId ? "任务排队中" : label : "正在准备备用窗口";
    elements.deleteThreadButton.disabled = state.snapshotFallback || !state.activeThread || effectiveBusy;
  }

  function updateTurnState() {
    if (state.snapshotFallback) {
      elements.sendButton.disabled = true;
      elements.turnState.dataset.status = "offline";
      elements.turnState.querySelector("span").textContent = "只读快照";
      return;
    }
    if (!state.bridgeReady) {
      elements.sendButton.disabled = true;
      elements.turnState.dataset.status = "offline";
      elements.turnState.querySelector("span").textContent = state.pendingTurnRequest ? "等待连接确认" : "等待连接";
      return;
    }
    if (!state.initialDataReady || !state.currentProject || state.projectSwitchPending) {
      elements.sendButton.disabled = true;
      elements.turnState.dataset.status = "working";
      elements.turnState.querySelector("span").textContent = state.projectSwitchPending
        ? "正在切换备用工程"
        : "正在读取备用工程";
      return;
    }
    const turnBusy = Boolean(
      state.activeTurnId
      || state.pendingTurnRequest
      || rescueTaskStatusIsActiveForCurrentThread(),
    );
    setBusy(turnBusy, state.activeTurnId ? "正在处理" : state.pendingTurnRequest ? "正在确认发送" : "就绪");
  }

  function applySnapshotMode(metadata) {
    const fallback = metadata?.fallback === true;
    state.snapshotFallback = fallback;
    state.snapshotSavedAt = fallback && Number.isFinite(Number(metadata.savedAt)) ? Number(metadata.savedAt) : null;
    elements.snapshotNotice.hidden = !fallback;
    elements.snapshotSavedAt.textContent = state.snapshotSavedAt
      ? new Date(state.snapshotSavedAt).toLocaleString(interfaceLocale(), { hour12: false })
      : "时间未知";
    elements.promptInput.disabled = fallback;
    elements.newThreadButton.disabled = fallback;
    // Creating a filesystem project is an HTTP-side operation and does not
    // write conversation data. Keep it available even while the official
    // conversation list is temporarily shown as a read-only snapshot.
    elements.newProjectButton.disabled = state.projectSwitchPending;
    elements.modelSelect.disabled = fallback;
    elements.deleteThreadButton.disabled = fallback || !state.activeThread || Boolean(state.activeTurnId || state.pendingTurnRequest);
    updateTurnState();
    refreshIcons();
  }

  function threadLeaseOwnerId() {
    let value = sessionStorage.getItem(THREAD_LEASE_OWNER_KEY);
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() || `rescue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(THREAD_LEASE_OWNER_KEY, value);
    }
    return value;
  }

  function clientWindowId() {
    return globalThis.crypto?.randomUUID?.()
      || `rescue-window-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function loadRescueComponent() {
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/component?_=${Date.now()}`, { cache: "no-store" }, 8_000);
      if (response.status === 401) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取备用服务状态");
      state.rescueComponent = data;
      renderRescueComponent();
      const running = ["queued", "running"].includes(data.operation?.status);
      clearTimeout(state.rescueComponentTimer);
      state.rescueComponentTimer = running ? setTimeout(loadRescueComponent, 2_000) : null;
    } catch (error) {
      if (elements.rescueUpdateDialog.open) elements.rescueUpdateError.textContent = error.message;
    }
  }

  function renderRescueComponent() {
    const component = state.rescueComponent;
    elements.rescueUpdateButton.hidden = !component?.availableVersion;
    if (!component) return;
    const active = component.slots?.find((slot) => slot.active);
    const operation = component.operation;
    const running = ["queued", "running"].includes(operation?.status);
    elements.rescueUpdateSummary.textContent = running
      ? operation.detail || "备用服务正在升级"
      : `当前槽 ${component.activePort || "未初始化"} · v${active?.version || "未知"}；可升级到 v${component.availableVersion || "未知"}`;
    elements.rescueUpdateConfirm.disabled = running || !component.updateAvailable;
    elements.rescueUpdateConfirm.textContent = running ? "升级中" : component.updateAvailable ? "开始升级" : "已经是当前版本";
  }

  async function openRescueUpdate() {
    resetRescueUpdate();
    await loadRescueComponent();
    renderRescueComponent();
    elements.rescueUpdateDialog.showModal();
    elements.rescueUpdatePassword.focus();
  }

  async function updateRescueComponent(event) {
    event?.preventDefault();
    if (elements.rescueUpdateConfirm.disabled) return;
    elements.rescueUpdateConfirm.disabled = true;
    elements.rescueUpdateError.textContent = "";
    try {
      const response = await fetch(`${API_BASE}/rescue/component/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "rescue-component-update",
        },
        body: JSON.stringify({
          password: elements.rescueUpdatePassword.value,
          confirmation: elements.rescueUpdateConfirmation.value,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法启动备用服务升级");
      elements.rescueUpdatePassword.value = "";
      elements.rescueUpdateConfirmation.value = "";
      elements.rescueUpdateDialog.close();
      toast("备用服务升级已启动");
      clearTimeout(state.rescueComponentTimer);
      state.rescueComponentTimer = setTimeout(loadRescueComponent, 800);
    } catch (error) {
      elements.rescueUpdateError.textContent = error.message;
      elements.rescueUpdateConfirm.disabled = false;
    } finally {
      elements.rescueUpdatePassword.value = "";
    }
  }

  function resetRescueUpdate() {
    elements.rescueUpdatePassword.value = "";
    elements.rescueUpdateConfirmation.value = "";
    elements.rescueUpdateError.textContent = "";
    renderRescueComponent();
  }

  async function loadAccount() {
    if (state.accountLoadPromise) return state.accountLoadPromise;
    state.accountLoadPromise = (async () => {
      try {
        const response = await fetchWithTimeout(`${API_BASE}/account?summary=1`, { cache: "no-store" }, 8_000);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法读取账号信息");
        state.account = data.user;
        return true;
      } catch (error) {
        console.error("Unable to load account:", error);
        return false;
      } finally {
        state.accountLoadPromise = null;
      }
    })();
    return state.accountLoadPromise;
  }

  function isAccountAdmin() {
    return Boolean(state.account && ["owner", "admin"].includes(state.account.role));
  }

  async function loadDeploymentControl() {
    if (state.deploymentControlPending || state.deploymentControlForbidden) return;
    clearTimeout(state.deploymentControlTimer);
    state.deploymentControlTimer = null;
    state.deploymentControlPending = true;
    try {
      const response = await fetchWithTimeout(`${API_BASE}/ops/deployments/control`, { cache: "no-store" }, 8_000);
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) return;
      if (response.status === 403) {
        state.deploymentControlForbidden = true;
        state.deploymentControl = null;
        elements.deploymentRescueButton.hidden = true;
        elements.admissionRescueButton.hidden = true;
        return;
      }
      if (!response.ok) throw new Error(data.error || "无法读取维护状态");
      renderDeploymentControl(data);
    } catch {
      // Keep the last confirmed emergency control usable during transient status failures.
    } finally {
      state.deploymentControlPending = false;
      scheduleDeploymentControlPoll();
    }
  }

  function renderDeploymentControl(control) {
    state.deploymentControl = control || null;
    const visible = control?.active && (control.cancellable || control.cancellationRequested);
    const cancellationRequested = control?.cancellationRequested === true;
    const orphanedAdmissions = Number(control?.persistentAdmissions?.orphaned) || 0;
    elements.deploymentRescueButton.hidden = !visible;
    elements.admissionRescueButton.hidden = orphanedAdmissions === 0;
    elements.deploymentRescueButton.disabled = cancellationRequested;
    const label = cancellationRequested ? "维护任务正在安全取消" : "取消等待中的维护任务";
    elements.deploymentRescueButton.title = label;
    elements.deploymentRescueButton.setAttribute("aria-label", label);
    if (elements.admissionRescueDialog.open && orphanedAdmissions === 0) {
      elements.admissionRescueDialog.close();
    }
  }

  function scheduleDeploymentControlPoll(delay = deploymentControlPollDelay()) {
    if (state.deploymentControlForbidden) return;
    clearTimeout(state.deploymentControlTimer);
    state.deploymentControlTimer = setTimeout(loadDeploymentControl, delay);
  }

  function deploymentControlPollDelay() {
    if (document.visibilityState === "hidden") return DEPLOYMENT_CONTROL_HIDDEN_POLL_MS;
    return state.deploymentControl?.active
      ? DEPLOYMENT_CONTROL_ACTIVE_POLL_MS
      : DEPLOYMENT_CONTROL_IDLE_POLL_MS;
  }

  function openDeploymentRescue() {
    const control = state.deploymentControl;
    if (!control?.active || !control.cancellable || !control.operationId) return;
    elements.deploymentRescueSummary.textContent = `当前维护阶段：${control.phase}。请求被接受后，任务将在安全检查点停止；若切换已提交则会拒绝取消。`;
    elements.deploymentRescueDialog.showModal();
    elements.deploymentRescuePassword.focus();
  }

  async function cancelDeploymentFromRescue(event) {
    event?.preventDefault();
    if (state.deploymentCancelPending) return;
    const control = state.deploymentControl;
    if (!control?.operationId) return;
    state.deploymentCancelPending = true;
    elements.deploymentRescueConfirm.disabled = true;
    elements.deploymentRescueConfirm.textContent = "正在提交";
    elements.deploymentRescueError.textContent = "";
    try {
      const response = await fetchWithTimeout(`${API_BASE}/ops/deployments/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "ops-deployment-cancel" },
        body: JSON.stringify({ operationId: control.operationId, password: elements.deploymentRescuePassword.value }),
      }, 10_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "取消失败");
      elements.deploymentRescuePassword.value = "";
      elements.deploymentRescueDialog.close();
      toast("已请求取消维护任务", "success");
      renderDeploymentControl({ ...control, cancellable: false, cancellationRequested: true });
      await loadDeploymentControl();
    } catch (error) {
      elements.deploymentRescuePassword.value = "";
      await loadDeploymentControl();
      if (
        state.deploymentControl?.operationId === control.operationId
        && state.deploymentControl.cancellationRequested
      ) {
        elements.deploymentRescueDialog.close();
        toast("已请求取消维护任务", "success");
        return;
      }
      elements.deploymentRescueError.textContent = error.message;
    } finally {
      state.deploymentCancelPending = false;
      elements.deploymentRescueConfirm.disabled = false;
      elements.deploymentRescueConfirm.textContent = "确认取消";
    }
  }

  function resetDeploymentRescue() {
    elements.deploymentRescuePassword.value = "";
    elements.deploymentRescueError.textContent = "";
  }

  function openAdmissionRescue() {
    const orphaned = Number(state.deploymentControl?.persistentAdmissions?.orphaned) || 0;
    if (orphaned === 0) return;
    elements.admissionRescueSummary.textContent = `检测到 ${orphaned} 条中断写入记录。只有相关后台任务已停止时才会清理。`;
    elements.admissionRescueDialog.showModal();
    elements.admissionRescuePassword.focus();
  }

  async function clearAdmissionsFromRescue(event) {
    event.preventDefault();
    elements.admissionRescueConfirm.disabled = true;
    elements.admissionRescueConfirm.textContent = "正在清理";
    elements.admissionRescueError.textContent = "";
    try {
      const response = await fetchWithTimeout(`${API_BASE}/ops/deployments/admissions/clear`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "ops-deployment-admissions-clear",
        },
        body: JSON.stringify({
          password: elements.admissionRescuePassword.value,
          confirmation: elements.admissionRescueConfirmation.value.trim(),
        }),
      }, 10_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "清理失败");
      renderDeploymentControl({
        ...(state.deploymentControl || {}),
        persistentAdmissions: data.persistentAdmissions,
      });
      if (elements.admissionRescueDialog.open) elements.admissionRescueDialog.close();
      toast(`已清理 ${data.cleared || 0} 条中断写入记录`, "success");
      await loadDeploymentControl();
    } catch (error) {
      elements.admissionRescuePassword.value = "";
      elements.admissionRescueError.textContent = error.message;
    } finally {
      elements.admissionRescueConfirm.disabled = false;
      elements.admissionRescueConfirm.textContent = "确认清理";
    }
  }

  function resetAdmissionRescue() {
    elements.admissionRescuePassword.value = "";
    elements.admissionRescueConfirmation.value = "";
    elements.admissionRescueError.textContent = "";
  }

  function canEditProviderProfiles() {
    return isAccountAdmin() || state.account?.permissions?.customProviders === true || state.providerCanEdit;
  }

  async function loadProviders() {
    try {
      const response = await fetchWithTimeout(`${API_BASE}/providers`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取 API 供应商");
      state.providers = data.profiles || [];
      state.activeProviderId = data.activeId || null;
      state.fallbackProvider = data.fallback || null;
      state.currentProviderId = data.currentProviderId || null;
      state.providerCanEdit = data.canEdit === true;
      state.providerConfigurationRequired = data.configurationRequired === true;
      state.rescueProviderIsolated = data.rescueProviderIsolated !== false;
      const activeProfile = state.providers.find((profile) => profile.id === state.activeProviderId);
      elements.providerStatus.textContent = state.rescueProviderIsolated && !activeProfile
        ? "需要独立 API"
        : activeProfile?.name
        || data.currentProvider?.name
        || (data.currentProviderId === "openai" ? "OpenAI 官方" : data.currentProviderId || "Codex 配置");
      elements.providerButton.dataset.configured = state.providerConfigurationRequired ? "false" : "true";
      populateProviderSelect();
      updateTurnState();
    } catch (error) {
      if (elements.providerDialog.open) elements.providerError.textContent = error.message;
    }
  }

  async function openProviderDialog() {
    elements.providerError.textContent = "";
    elements.providerDialog.showModal();
    await loadProviders();
    selectProvider(state.activeProviderId || state.providers[0]?.id || "new");
  }

  function populateProviderSelect() {
    elements.providerSelect.replaceChildren();
    if (!state.rescueProviderIsolated) {
      const defaultName = state.activeProviderId ? "Codex 原配置" : "Codex 当前配置";
      elements.providerSelect.add(new Option(`${!state.activeProviderId ? "当前 · " : ""}${defaultName}`, "default"));
    }
    for (const provider of state.providers) {
      const prefix = provider.id === state.activeProviderId ? "当前 · " : "";
      elements.providerSelect.add(new Option(`${prefix}${provider.name}`, provider.id));
    }
    if (canEditProviderProfiles()) elements.providerSelect.add(new Option("+ 添加供应商", "new"));
    if ([...elements.providerSelect.options].some((option) => option.value === state.editingProviderId)) {
      elements.providerSelect.value = state.editingProviderId;
    }
  }

  function selectProvider(id) {
    state.editingProviderId = id;
    elements.providerSelect.value = id;
    elements.providerError.textContent = "";
    elements.providerKey.value = "";
    const isDefault = id === "default";
    const isNew = id === "new";
    const provider = state.providers.find((entry) => entry.id === id);
    for (const input of [elements.providerName, elements.providerBaseUrl, elements.providerModel, elements.providerKey]) {
      input.disabled = isDefault || !canEditProviderProfiles();
    }
    if (isDefault) {
      elements.providerName.value = "Codex 原配置";
      elements.providerBaseUrl.value = state.fallbackProvider?.providerId || state.currentProviderId || "默认";
      elements.providerModel.value = state.fallbackProvider?.model || "由 Codex 决定";
      elements.providerKeyState.textContent = "由 Codex 管理";
      elements.providerKey.placeholder = "由 Codex 管理";
    } else if (isNew) {
      elements.providerName.value = "";
      elements.providerBaseUrl.value = "";
      elements.providerModel.value = "";
      elements.providerKeyState.textContent = "未配置";
      elements.providerKey.placeholder = "输入新的 API Key";
      requestAnimationFrame(() => elements.providerName.focus());
    } else if (provider) {
      elements.providerName.value = provider.name;
      elements.providerBaseUrl.value = provider.baseUrl;
      elements.providerModel.value = provider.model || "";
      elements.providerKeyState.textContent = provider.hasApiKey ? "已配置，留空保留" : "未配置";
      elements.providerKey.placeholder = provider.hasApiKey ? "留空则保留已保存密钥" : "输入新的 API Key";
    }
    updateProviderControls();
  }

  async function saveProvider(activate) {
    if (!canEditProviderProfiles()) return;
    if (state.editingProviderId === "default") return;
    if (!elements.providerForm.reportValidity()) return;
    const existing = state.editingProviderId !== "new" ? state.editingProviderId : null;
    const payload = {
      name: elements.providerName.value.trim(),
      baseUrl: elements.providerBaseUrl.value.trim(),
      model: elements.providerModel.value.trim(),
      apiKey: elements.providerKey.value.trim(),
    };
    setProviderBusy(true);
    elements.providerError.textContent = "";
    try {
      const response = await fetch(existing ? `${API_BASE}/providers/${encodeURIComponent(existing)}` : `${API_BASE}/providers`, {
        method: existing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法保存 API 供应商");
      state.editingProviderId = data.profile.id;
      await loadProviders();
      selectProvider(data.profile.id);
      if (activate) await activateProvider(data.profile.id);
      else toast("API 供应商已保存");
    } catch (error) {
      elements.providerError.textContent = error.message;
    } finally {
      setProviderBusy(false);
    }
  }

  async function activateProvider(id) {
    const restore = prepareProviderSwitch();
    try {
      const response = await fetch(`${API_BASE}/providers/${encodeURIComponent(id)}/activate`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法启用 API 供应商");
      state.activeProviderId = data.activeId;
      await loadProviders();
      elements.providerDialog.close();
      toast(`已切换到 ${data.provider.name}`);
    } catch (error) {
      restore();
      throw error;
    }
  }

  async function activateDefaultProvider() {
    if (!state.activeProviderId || !state.fallbackProvider) return;
    setProviderBusy(true);
    elements.providerError.textContent = "";
    const restore = prepareProviderSwitch();
    try {
      const response = await fetch(`${API_BASE}/providers/default/activate`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法切回原配置");
      state.activeProviderId = null;
      await loadProviders();
      elements.providerDialog.close();
      toast("已切回 Codex 原配置");
    } catch (error) {
      restore();
      elements.providerError.textContent = error.message;
    } finally {
      setProviderBusy(false);
    }
  }

  async function deleteProvider() {
    const provider = state.providers.find((entry) => entry.id === state.editingProviderId);
    if (!provider || provider.id === state.activeProviderId || !confirm(`删除“${provider.name}”？`)) return;
    setProviderBusy(true);
    try {
      const response = await fetch(`${API_BASE}/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "无法删除 API 供应商");
      }
      state.editingProviderId = "default";
      await loadProviders();
      selectProvider("default");
      toast("API 供应商已删除");
    } catch (error) {
      elements.providerError.textContent = error.message;
    } finally {
      setProviderBusy(false);
    }
  }

  function prepareProviderSwitch() {
    const previous = {
      activeTurnId: state.activeTurnId,
      activeThreadNeedsResume: state.activeThreadNeedsResume,
      bootstrapped: state.bootstrapped,
    };
    if (state.activeThread) rememberThread();
    state.activeTurnId = null;
    state.activeThreadNeedsResume = Boolean(state.activeThread);
    state.bootstrapped = false;
    state.bootstrapGeneration += 1;
    state.bootstrapPromise = null;
    stopPolling();
    updateTurnState();
    return () => {
      if (!state.bridgeReady || state.bootstrapped) return;
      Object.assign(state, previous);
      updateTurnState();
      if (state.activeTurnId) startPolling();
    };
  }

  function setProviderBusy(busy) {
    state.providerBusy = busy;
    elements.providerSelect.disabled = busy;
    updateProviderControls();
  }

  function updateProviderControls() {
    const id = state.editingProviderId;
    const locked = state.providerBusy;
    const canEdit = canEditProviderProfiles();
    elements.providerDeleteButton.hidden = !canEdit;
    elements.providerDefaultButton.hidden = !canEdit || state.rescueProviderIsolated;
    elements.providerSaveButton.hidden = !canEdit;
    elements.providerDeleteButton.disabled = locked || id === "default" || id === "new" || id === state.activeProviderId;
    elements.providerDefaultButton.disabled = locked || !state.activeProviderId || !state.fallbackProvider;
    elements.providerSaveButton.disabled = locked || id === "default";
    elements.providerActivateButton.textContent = canEdit ? "保存并启用" : id === state.activeProviderId ? "当前使用" : "启用";
    elements.providerActivateButton.disabled = locked || id === "default" || (!canEdit && id === state.activeProviderId);
  }

  function enqueueApproval(request) {
    state.approvals.push(request);
    updateApprovalStrip();
    if (!elements.approvalDialog.open && request.params?.threadId === state.activeThread?.id) openApproval();
  }

  function updateApprovalStrip() {
    const request = state.approvals[0];
    elements.approvalStrip.hidden = !request;
    if (request) elements.approvalLabel.textContent = approvalTitle(request.method);
  }

  function openApproval() {
    const request = state.approvals[0];
    if (!request) return;
    elements.approvalTitle.textContent = approvalTitle(request.method);
    elements.approvalBody.replaceChildren();
    elements.approvalActions.replaceChildren();
    elements.approvalActions.className = "dialog-footer approval-actions";
    if (request.method === "item/tool/requestUserInput") renderUserQuestions(request);
    else {
      renderApprovalDetails(request);
      if (request.method === "item/permissions/requestApproval") {
        addApprovalButton("拒绝", false, () => respondApproval(request, { permissions: {}, scope: "turn" }));
        addApprovalButton("仅本轮", true, () => respondApproval(request, {
          permissions: compactPermissions(request.params?.permissions),
          scope: "turn",
        }));
      } else {
        addApprovalButton("拒绝", false, () => respondApproval(request, { decision: "decline" }));
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
          addApprovalButton("本次允许", true, () => respondApproval(request, { decision: "accept" }));
        } else {
          addApprovalButton("取消", true, () => respondApproval(request, { decision: "cancel" }));
        }
      }
    }
    elements.approvalDialog.showModal();
  }

  function renderApprovalDetails(request) {
    const params = request.params || {};
    const details = [["原因", params.reason], ["工作目录", params.cwd], ["命令", params.command]]
      .filter(([, value]) => value);
    if (!details.length) details.push(["请求", request.method]);
    for (const [label, value] of details) {
      const block = document.createElement("div");
      block.className = "approval-detail";
      const heading = document.createElement("span");
      heading.textContent = label;
      const content = document.createElement("pre");
      content.textContent = String(value);
      block.append(heading, content);
      elements.approvalBody.append(block);
    }
  }

  function renderUserQuestions(request) {
    const answers = new Map();
    for (const question of request.params?.questions || []) {
      const block = document.createElement("div");
      block.className = "question-block";
      const title = document.createElement("strong");
      title.textContent = question.question;
      const options = document.createElement("div");
      options.className = "question-options";
      if (question.options?.length) {
        const inputs = [];
        for (const option of question.options) {
          const label = document.createElement("label");
          label.className = "question-option";
          const input = document.createElement("input");
          input.type = "radio";
          input.name = `question-${question.id}`;
          input.value = option.label;
          const copy = document.createElement("span");
          copy.textContent = `${option.label}${option.description ? ` · ${option.description}` : ""}`;
          inputs.push(input);
          label.append(input, copy);
          options.append(label);
        }
        answers.set(question.id, () => inputs.find((input) => input.checked)?.value || "");
      } else {
        const input = document.createElement("input");
        input.type = question.isSecret ? "password" : "text";
        options.append(input);
        answers.set(question.id, () => input.value.trim());
      }
      block.append(title, options);
      elements.approvalBody.append(block);
    }
    addApprovalButton("取消", false, () => respondApproval(request, { answers: {} }));
    addApprovalButton("提交", true, () => {
      const result = {};
      for (const [id, read] of answers) {
        const value = read();
        result[id] = { answers: value ? [value] : [] };
      }
      respondApproval(request, { answers: result });
    });
  }

  function addApprovalButton(label, primary, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "primary-button" : "text-button";
    button.textContent = label;
    button.addEventListener("click", handler);
    elements.approvalActions.append(button);
  }

  function respondApproval(request, result) {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "serverResponse", id: request.id, result }));
    }
    state.approvals = state.approvals.filter((entry) => entry !== request);
    elements.approvalDialog.close();
    updateApprovalStrip();
    if (state.approvals.length) openApproval();
  }

  function addPolicyParams(params) {
    params.approvalPolicy = "never";
    params.sandbox = "danger-full-access";
    return params;
  }

  function rememberThread() {
    if (!state.activeThread?.id) return;
    const record = { id: state.activeThread.id, cwd: state.activeThread.cwd || state.currentProject?.path };
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(record));
  }

  function loadRecovery() {
    try {
      const record = JSON.parse(localStorage.getItem(RECOVERY_KEY) || "null");
      if (typeof record?.id === "string" && typeof record?.cwd === "string") return record;
    } catch {
      return null;
    }
    return null;
  }

  function setConnection(status, label) {
    elements.connection.dataset.status = status;
    elements.connection.querySelector("span").textContent = label;
  }

  function statusText(status) {
    return { starting: "正在连接", ready: "已连接", offline: "连接断开", error: "连接错误" }[status] || status;
  }

  async function loadMainTasks({ force = false } = {}) {
    if (state.mainTasksPending && !force) return;
    state.mainTasksPending = true;
    if (force) elements.mainTasksRefresh.classList.add("refreshing");
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/rescue/main/tasks?_=${Date.now()}`,
        { cache: "no-store" },
        8_000,
      );
      if (response.status === 401) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取主站任务");
      state.mainTasks = data;
      elements.mainTasksError.textContent = "";
      renderMainTasks();
      void loadRescueTasks();
    } catch (error) {
      if (elements.mainTasksDialog.open) elements.mainTasksError.textContent = error.message;
    } finally {
      state.mainTasksPending = false;
      elements.mainTasksRefresh.classList.remove("refreshing");
      scheduleMainTasksPoll(mainTasksPollDelay());
    }
  }

  function scheduleMainTasksPoll(delay = mainTasksPollDelay()) {
    clearTimeout(state.mainTasksTimer);
    state.mainTasksTimer = setTimeout(loadMainTasks, delay);
  }

  function mainTasksPollDelay() {
    if (document.visibilityState === "hidden") return MAIN_TASKS_HIDDEN_POLL_MS;
    return state.mainTasks?.tasks?.length ? MAIN_TASKS_ACTIVE_POLL_MS : MAIN_TASKS_IDLE_POLL_MS;
  }

  function openMainTasks() {
    renderMainTasks();
    renderRescueTasks();
    if (!elements.mainTasksDialog.open) elements.mainTasksDialog.showModal();
    void loadMainTasks({ force: true });
    void loadRescueTasks({ force: true });
  }

  function renderMainTasks() {
    const tasks = Array.isArray(state.mainTasks?.tasks) ? state.mainTasks.tasks : [];
    elements.mainTasksBadge.hidden = tasks.length === 0;
    elements.mainTasksBadge.textContent = String(Math.min(tasks.length, 99));
    elements.mainTasksButton.dataset.active = tasks.length ? "true" : "false";
    elements.mainTasksButton.title = tasks.length ? `主站有 ${tasks.length} 个运行任务` : "主站任务控制";
    elements.mainTasksSummary.textContent = tasks.length
      ? `主站 ${state.mainTasks.version || ""} 当前有 ${tasks.length} 个运行任务，可逐个安全终止。`
      : "主站当前没有运行任务。备用窗口仍可独立发起新对话。";
    elements.mainTasksList.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "list-state";
      empty.textContent = state.mainTasks ? "暂无运行任务" : "正在读取主站任务";
      elements.mainTasksList.append(empty);
      return;
    }
    for (const task of tasks) elements.mainTasksList.append(renderMainTask(task));
  }

  async function loadRescueTasks({ force = false } = {}) {
    if (state.rescueTasksPending && !force) return;
    const loadVersion = ++state.rescueTasksLoadVersion;
    state.rescueTasksPending = true;
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/task/status?scope=threads&_=${Date.now()}`,
        { cache: "no-store" },
        8_000,
      );
      if (response.status === 401) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取备用窗口任务");
      if (loadVersion !== state.rescueTasksLoadVersion) return;
      state.rescueTasks = data;
      renderRescueTasks();
    } catch (error) {
      if (elements.mainTasksDialog.open) elements.mainTasksError.textContent = error.message;
    } finally {
      if (loadVersion === state.rescueTasksLoadVersion) {
        state.rescueTasksPending = false;
        scheduleRescueTasksPoll(rescueTasksPollDelay());
      }
    }
  }

  function scheduleRescueTasksPoll(delay = rescueTasksPollDelay()) {
    clearTimeout(state.rescueTasksTimer);
    state.rescueTasksTimer = setTimeout(loadRescueTasks, delay);
  }

  function rescueTasksPollDelay() {
    if (document.visibilityState === "hidden") return RESCUE_TASKS_HIDDEN_POLL_MS;
    const active = (state.rescueTasks?.tasks || []).some((task) => (
      ["queued", "running", "waiting", "stopping", "uncertain"].includes(task.status)
    ));
    return active ? RESCUE_TASKS_ACTIVE_POLL_MS : RESCUE_TASKS_IDLE_POLL_MS;
  }

  function renderRescueTasks() {
    const tasks = (Array.isArray(state.rescueTasks?.tasks) ? state.rescueTasks.tasks : [])
      .filter((task) => ["queued", "running", "waiting", "stopping", "uncertain"].includes(task.status));
    elements.rescueTasksSummary.textContent = tasks.length
      ? `备用窗口当前有 ${tasks.length} 个运行任务；这里的终止会直接停止备用进程及其命令。`
      : "备用窗口当前没有运行任务。备用窗口可以继续独立发起新对话。";
    elements.rescueTasksList.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "list-state";
      empty.textContent = state.rescueTasks ? "暂无备用任务" : "正在读取备用任务";
      elements.rescueTasksList.append(empty);
      return;
    }
    for (const task of tasks) elements.rescueTasksList.append(renderRescueTask(task));
  }

  function rescueTaskKey(task) {
    return `${task?.threadId || ""}:${task?.turnId || ""}`;
  }

  function renderRescueTask(task) {
    const card = document.createElement("article");
    card.className = "main-task-card rescue-task-card";
    const copy = document.createElement("div");
    copy.className = "main-task-copy";
    const title = document.createElement("strong");
    title.className = "main-task-title";
    title.textContent = `备用 Codex · ${basename(task.cwd || state.currentProject?.path || "未命名工程")}`;
    const status = document.createElement("span");
    status.className = "main-task-meta";
    status.textContent = `${mainTaskStatusLabel(task.status)} · ${task.startedAt ? `已运行 ${formatTaskDuration(Date.now() - task.startedAt)}` : "时间未知"}`;
    copy.append(title, status);
    const key = rescueTaskKey(task);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "text-button main-task-stop";
    stop.textContent = state.rescueTaskInterrupting.has(key)
      ? "正在终止"
      : task.status === "queued" ? "取消排队任务" : "终止备用任务";
    stop.disabled = state.rescueTaskInterrupting.has(key) || !task.threadId;
    stop.addEventListener("click", () => interruptRescueTask(task));
    card.append(copy, stop);
    return card;
  }

  async function interruptRescueTask(task) {
    const key = rescueTaskKey(task);
    if (!task?.threadId || state.rescueTaskInterrupting.has(key)) return;
    if (!confirm("确定终止备用窗口当前任务？这会停止该任务及其命令进程。")) return;
    state.rescueTaskInterrupting.add(key);
    renderRescueTasks();
    try {
      let result;
      if (task.status === "queued") {
        const response = await fetchWithTimeout(`${API_BASE}/task/admission/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Codex-Desktop-Action": "task-admission-cancel",
          },
          body: JSON.stringify({ threadId: task.threadId }),
        }, 18_000);
        result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "无法取消排队任务");
        toast("备用排队任务已取消");
      } else {
        result = await rpc("turn/interrupt", {
          threadId: task.threadId,
          ...(task.turnId ? { turnId: task.turnId } : {}),
          _wflThreadLeaseOwnerId: THREAD_LEASE_OWNER_ID,
        });
        toast(result?.forced ? "备用任务已强制终止" : "已向备用窗口发送终止请求");
      }
      await loadRescueTasks({ force: true });
      if (task.threadId === state.activeThread?.id) await loadTaskStatus({ force: true });
    } catch (error) {
      elements.mainTasksError.textContent = error.message;
    } finally {
      state.rescueTaskInterrupting.delete(key);
      renderRescueTasks();
    }
  }

  function renderMainTask(task) {
    const card = document.createElement("article");
    card.className = "main-task-card";
    const copy = document.createElement("div");
    copy.className = "main-task-copy";
    const title = document.createElement("strong");
    title.className = "main-task-title";
    title.textContent = `${task.kind === "claude" ? "Claude" : "Codex"} · ${task.name || basename(task.projectPath || "未命名工程")}`;
    const owner = document.createElement("span");
    owner.className = "main-task-meta";
    owner.textContent = `${task.displayName || task.username || task.userId} · ${task.providerName || "默认供应商"}`;
    const status = document.createElement("span");
    status.className = "main-task-meta";
    status.textContent = `${mainTaskStatusLabel(task.status)} · ${task.startedAt ? `已运行 ${formatTaskDuration(Date.now() - task.startedAt)}` : "时间未知"}`;
    copy.append(title, owner, status);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "text-button main-task-stop";
    stop.textContent = state.mainTaskInterrupting.has(task.id) ? "正在终止" : "终止对话";
    stop.disabled = state.mainTaskInterrupting.has(task.id) || task.interruptible === false;
    stop.addEventListener("click", () => interruptMainTask(task));
    card.append(copy, stop);
    return card;
  }

  function mainTaskStatusLabel(status) {
    return {
      queued: "排队中",
      running: "运行中",
      waiting: "等待确认",
      stopping: "正在终止",
      uncertain: "状态确认中",
      inProgress: "运行中",
      paused: "已暂停",
      retryWaiting: "等待重试",
    }[status] || status || "运行中";
  }

  async function interruptMainTask(task) {
    if (!task?.id || state.mainTaskInterrupting.has(task.id)) return;
    const label = `${task.kind === "claude" ? "Claude" : "Codex"} · ${task.name || basename(task.projectPath || task.threadId || task.sessionId)}`;
    if (!confirm(`确定终止主站任务“${label}”？`)) return;
    state.mainTaskInterrupting.add(task.id);
    elements.mainTasksError.textContent = "";
    renderMainTasks();
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/main/tasks/interrupt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "rescue-main-task-interrupt",
        },
        body: JSON.stringify({
          kind: task.kind,
          userId: task.userId,
          threadId: task.threadId || undefined,
          turnId: task.turnId || undefined,
          sessionId: task.sessionId || undefined,
        }),
      }, 18_000);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法终止主站任务");
      state.mainTasks = data.snapshot || state.mainTasks;
      toast("已向主站发送终止请求");
    } catch (error) {
      elements.mainTasksError.textContent = error.message;
    } finally {
      state.mainTaskInterrupting.delete(task.id);
      renderMainTasks();
      scheduleMainTasksPoll(1_000);
    }
  }

  async function loadRescueWorktree({ silent = false } = {}) {
    if (state.worktreePending) return state.worktree;
    state.worktreePending = true;
    if (!silent) elements.worktreeRefreshButton.classList.add("refreshing");
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/rescue/worktree/status?_=${Date.now()}`,
        { cache: "no-store" },
        12_000,
      );
      if (response.status === 401) return null;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法读取主站维护 Worktree");
      state.worktree = data;
      elements.worktreeError.textContent = "";
      renderRescueWorktree();
      return data;
    } catch (error) {
      if (!silent || elements.worktreeDialog.open) elements.worktreeError.textContent = error.message;
      return null;
    } finally {
      state.worktreePending = false;
      elements.worktreeRefreshButton.classList.remove("refreshing");
      renderRescueWorktree();
    }
  }

  function openRescueWorktree() {
    elements.worktreeError.textContent = "";
    elements.worktreeDiffOutput.hidden = true;
    renderRescueWorktree();
    if (!elements.worktreeDialog.open) elements.worktreeDialog.showModal();
    void loadRescueWorktree();
  }

  function renderRescueWorktree() {
    const snapshot = state.worktree;
    const record = snapshot?.worktree;
    const ready = record?.state === "ready";
    const sourceStatus = snapshot?.source?.status;
    const worktreeStatus = record?.status;
    elements.worktreeButton.dataset.active = ready ? "true" : "false";
    elements.worktreeSummary.textContent = !snapshot
      ? "正在读取主站维护 Worktree 状态。"
      : !snapshot.configured
        ? "尚未创建主站维护 Worktree；创建后备用 Codex 只能在该独立目录中修改代码。"
        : ready
          ? `维护目录：${record.worktreeProjectPath}；主站源码：${snapshot.source?.path || "未知"}。合并前必须通过限定检查。`
          : `主站维护 Worktree 当前状态为“${record.state || "不可用"}”，可尝试恢复或联系管理员检查运行目录。`;
    elements.worktreeStatus.replaceChildren();
    if (snapshot?.source) elements.worktreeStatus.append(renderWorktreeStatusCard("主站源码", snapshot.source));
    if (record) elements.worktreeStatus.append(renderWorktreeStatusCard("备用维护 Worktree", {
      path: record.worktreeProjectPath,
      status: worktreeStatus,
    }));
    elements.worktreeEnsureButton.disabled = state.worktreeActionPending || Boolean(ready);
    elements.worktreeDiffButton.disabled = state.worktreeActionPending || !ready;
    elements.worktreeCheckButton.disabled = state.worktreeActionPending || !ready;
    elements.worktreeMergeButton.disabled = state.worktreeActionPending || !ready;
  }

  function renderWorktreeStatusCard(title, entry) {
    const card = document.createElement("article");
    card.className = "worktree-status-card";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const pathNode = document.createElement("small");
    pathNode.textContent = entry.path || "路径未知";
    const status = document.createElement("span");
    const files = Array.isArray(entry.status?.files) ? entry.status.files.length : 0;
    status.textContent = entry.status
      ? `${entry.status.repository ? "Git" : "非 Git"} · ${files ? `${files} 个修改` : "工作区干净"}`
      : "尚未检查";
    card.append(heading, pathNode, status);
    return card;
  }

  async function ensureRescueWorktree() {
    if (state.worktreeActionPending) return;
    state.worktreeActionPending = true;
    elements.worktreeError.textContent = "";
    renderRescueWorktree();
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/worktree/ensure`, {
        method: "POST",
        headers: { "X-Codex-Desktop-Action": "rescue-worktree-ensure" },
      }, 30_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法创建主站维护 Worktree");
      await loadRescueWorktree();
      await loadProjects();
      toast(data.created ? "主站维护 Worktree 已创建" : "主站维护 Worktree 已恢复", "success");
    } catch (error) {
      elements.worktreeError.textContent = error.message;
    } finally {
      state.worktreeActionPending = false;
      renderRescueWorktree();
    }
  }

  async function loadRescueWorktreeDiff() {
    if (state.worktreeActionPending) return;
    state.worktreeActionPending = true;
    elements.worktreeError.textContent = "";
    renderRescueWorktree();
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/worktree/diff?_=${Date.now()}`, { cache: "no-store" }, 30_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法读取 Worktree 差异");
      const sections = [
        ["已暂存差异", data.staged?.diff],
        ["未暂存差异", data.unstaged?.diff],
        ...(Array.isArray(data.untracked) ? data.untracked.map((entry) => [`未跟踪文件：${entry.path || ""}`, entry.diff]) : []),
      ].filter(([, diff]) => diff);
      elements.worktreeDiffOutput.textContent = sections.length
        ? sections.map(([title, diff]) => `===== ${title} =====\n${String(diff).slice(0, 120_000)}`).join("\n\n")
        : "当前 Worktree 没有可显示的差异。";
      elements.worktreeDiffOutput.hidden = false;
    } catch (error) {
      elements.worktreeError.textContent = error.message;
    } finally {
      state.worktreeActionPending = false;
      renderRescueWorktree();
    }
  }

  async function checkRescueWorktree() {
    if (state.worktreeActionPending) return;
    state.worktreeActionPending = true;
    elements.worktreeError.textContent = "";
    renderRescueWorktree();
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/worktree/check`, {
        method: "POST",
        headers: { "X-Codex-Desktop-Action": "rescue-worktree-check" },
      }, 90_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Worktree 限定检查失败");
      elements.worktreeDiffOutput.textContent = JSON.stringify(data, null, 2);
      elements.worktreeDiffOutput.hidden = false;
      toast(data.ok ? "Worktree 限定检查通过" : "Worktree 检查未通过", data.ok ? "success" : "error");
    } catch (error) {
      elements.worktreeError.textContent = error.message;
    } finally {
      state.worktreeActionPending = false;
      renderRescueWorktree();
    }
  }

  async function mergeRescueWorktree() {
    if (state.worktreeActionPending) return;
    const confirmation = elements.worktreeMergeConfirmation.value.trim();
    if (confirmation !== "合并主站维护 Worktree") {
      elements.worktreeError.textContent = "请输入“合并主站维护 Worktree”完成管理员确认";
      return;
    }
    if (!confirm("确认把独立 Worktree 的修改合并到主站源码？主站源码必须保持干净且 HEAD 未变化。")) return;
    state.worktreeActionPending = true;
    elements.worktreeError.textContent = "";
    renderRescueWorktree();
    try {
      const response = await fetchWithTimeout(`${API_BASE}/rescue/worktree/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "rescue-worktree-merge",
        },
        body: JSON.stringify({ confirmation }),
      }, 120_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "无法合并主站维护 Worktree");
      elements.worktreeMergeConfirmation.value = "";
      state.worktree = data.status || state.worktree;
      await loadProjects();
      renderRescueWorktree();
      toast("主站维护 Worktree 已合并；请在主站发布前继续做正式验证", "success");
    } catch (error) {
      elements.worktreeError.textContent = error.message;
    } finally {
      state.worktreeActionPending = false;
      renderRescueWorktree();
    }
  }

  async function loadTaskStatus({ force = false } = {}) {
    if (state.taskStatusRequestPending) {
      if (!force) return;
      state.taskStatusController?.abort();
    }
    const threadId = state.activeThread?.id || null;
    const requestedTurnId = state.activeTurnId || null;
    const projectContextVersion = state.projectContextVersion;
    state.taskStatusRequestPending = true;
    const controller = new AbortController();
    state.taskStatusController = controller;
    const timeout = setTimeout(() => controller.abort(), TASK_STATUS_REQUEST_TIMEOUT_MS);
    try {
      if (!threadId) {
        state.taskStatusSnapshot = null;
        updateTurnState();
        return;
      }
      const query = new URLSearchParams({
        threadId,
        ...(requestedTurnId ? { activeTurnId: requestedTurnId } : {}),
        _: String(Date.now()),
      });
      const response = await fetch(`${API_BASE}/task/status?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取任务状态");
      if (
        state.taskStatusController !== controller
        || state.activeThread?.id !== threadId
        || projectContextVersion !== state.projectContextVersion
        || !rescueTaskStatusResponseMatchesCurrentTurn(data, requestedTurnId)
      ) return;
      state.taskStatusFailures = 0;
      renderTaskStatus(data);
    } catch (error) {
      if (error.name === "AbortError" || state.taskStatusController !== controller) return;
      if (
        state.activeThread?.id !== threadId
        || projectContextVersion !== state.projectContextVersion
        || (state.activeTurnId || null) !== requestedTurnId
      ) return;
      state.taskStatusFailures += 1;
      if (state.taskStatusFailures >= TASK_STATUS_FAILURE_THRESHOLD) {
        renderTaskStatus({
          status: "unavailable",
          phase: "unavailable",
          threadId: state.activeThread?.id || null,
        });
      }
    } finally {
      clearTimeout(timeout);
      if (state.taskStatusController === controller) {
        state.taskStatusController = null;
        state.taskStatusRequestPending = false;
        scheduleTaskStatusPoll(taskStatusPollDelay());
      }
    }
  }

  function rescueTaskStatusResponseMatchesCurrentTurn(snapshot, requestedTurnId) {
    const currentTurnId = state.activeTurnId || null;
    if (requestedTurnId === currentTurnId) return true;
    // The completion event clears activeTurnId before an older status request
    // returns. Only accept that older response when it names the same Turn
    // and the server authoritatively says sending is safe again.
    return Boolean(
      requestedTurnId
      && !currentTurnId
      && RESCUE_TERMINAL_TASK_STATUSES.has(snapshot?.status)
      && snapshot.authoritative === true
      && snapshot.canSend === true
      && [snapshot.turnId, snapshot.staleTurnId, snapshot.activeTurnId].includes(requestedTurnId)
    );
  }

  function scheduleTaskStatusPoll(delay) {
    clearTimeout(state.taskStatusTimer);
    state.taskStatusTimer = setTimeout(loadTaskStatus, delay);
  }

  function taskStatusPollDelay() {
    if (document.visibilityState === "hidden") return 60_000;
    const active = rescueTaskStatusIsActive(state.taskStatusSnapshot?.status);
    const baseDelay = active ? 3_000 : 15_000;
    return Math.min(60_000, baseDelay * (2 ** Math.min(state.taskStatusFailures, 2)));
  }

  function renderTaskStatus(snapshot) {
    const statusLabels = {
      idle: "当前没有任务",
      running: "任务正在执行",
      waiting: "等待你的确认",
      stopping: "正在终止任务",
      completed: "任务已完成",
      failed: "任务执行失败",
      interrupted: "任务已终止",
      cancelled: "任务已取消",
      canceled: "任务已取消",
      unavailable: "状态更新延迟",
    };
    const phaseLabels = {
      idle: "等待发送任务",
      starting: "正在启动",
      working: "处理中",
      planning: "制定计划",
      thinking: "正在思考",
      responding: "生成回复",
      command: "执行命令",
      fileChange: "修改文件",
      tool: "调用工具",
      webSearch: "联网搜索",
      imageGeneration: "生成图片",
      approval: "等待批准",
      stopping: "发送终止请求",
      reconnecting: "连接恢复中",
      compacting: "整理长对话",
      completed: "执行结束",
      failed: "执行发生错误",
      interrupted: "已停止执行",
    };
    const status = Object.hasOwn(statusLabels, snapshot?.status) ? snapshot.status : "unavailable";
    state.taskStatusSnapshot = { ...snapshot, status };
    if (state.activeThread?.id === snapshot?.threadId && rescueTaskStatusIsActive(status)) {
      state.terminalTaskAuthorities.delete(snapshot.threadId);
    }
    synchronizeRescueTaskSnapshot(state.taskStatusSnapshot);
    const label = statusLabels[status];
    const detail = phaseLabels[snapshot?.phase] || (status === "unavailable" ? "正在自动重试" : "处理中");
    const time = taskStatusTime(snapshot, status);
    elements.taskStatusBar.dataset.status = status;
    elements.taskStatusLabel.textContent = label;
    elements.taskStatusDetail.textContent = detail;
    elements.taskStatusTime.textContent = time;
    elements.taskStatusBar.title = `${label} · ${detail} · ${time}`;
    updateTurnState();
  }

  function synchronizeRescueTaskSnapshot(snapshot) {
    if (!snapshot || snapshot.threadId !== state.activeThread?.id) return false;
    let changed = false;
    if (rescueTaskStatusIsActive(snapshot.status)) {
      // A task snapshot is authoritative for the rescue runtime. It can
      // recover a missed turn/started event, but only for the request's
      // current thread (loadTaskStatus rejects stale Turn responses).
      if (snapshot.turnId && state.activeTurnId !== snapshot.turnId) {
        state.activeTurnId = snapshot.turnId;
        changed = true;
      }
      return changed;
    }
    if (!RESCUE_TERMINAL_TASK_STATUSES.has(snapshot.status)) return false;

    const authority = rememberRescueTerminalTaskAuthority(snapshot);
    const targetTurnId = snapshot.turnId || snapshot.staleTurnId || (
      snapshot.authoritative === true && snapshot.canSend === true
        ? authority?.capturedTurnIds?.find((candidate) => (
          state.activeThread.turns?.some((turn) => turn?.id === candidate && turnStatusType(turn) === "inProgress")
        )) || (localInProgressTurnIds().length <= 1 ? state.activeTurnId : null)
        : null
    );
    const terminalTurnMatchedPointer = Boolean(
      snapshot.authoritative === true
      && snapshot.canSend === true
      && targetTurnId
      && state.activeTurnId === targetTurnId
    );
    const localTurn = targetTurnId
      ? state.activeThread.turns?.find((turn) => turn?.id === targetTurnId) || null
      : null;
    const terminalStatus = rescueTaskTerminalTurnStatus(snapshot.status);
    if (localTurn && turnStatusType(localTurn) === "inProgress") {
      upsertTurn({ ...localTurn, status: terminalStatus });
      changed = true;
    }
    if (targetTurnId) rememberTerminalTurn(targetTurnId, terminalStatus);
    if (targetTurnId && state.activeTurnId === targetTurnId) {
      state.activeTurnId = null;
      changed = true;
    }

    if (authority) {
      const fenced = fenceRescueTurnsByTaskAuthority(snapshot.threadId, state.activeThread.turns || []);
      if (fenced.some((turn, index) => turn !== state.activeThread.turns[index])) {
        state.activeThread.turns = fenced;
        changed = true;
      }
    }

    const pending = state.pendingTurnRequest;
    if (
      (
        pending?.params?.threadId === snapshot.threadId
        && pending.params.clientUserMessageId
        && snapshot.clientSubmissionId
        && pending.params.clientUserMessageId === snapshot.clientSubmissionId
      ) || (
        pending?.params?.threadId === snapshot.threadId
        && terminalTurnMatchedPointer
      )
    ) {
      state.pendingTurnRequest = null;
      state.pendingText = null;
      state.pendingClientId = null;
      state.pendingCreatedAt = null;
      elements.promptInput.value = "";
      resizePrompt();
      changed = true;
    }
    if (changed) {
      stopPolling();
      renderActiveThread(false);
    }
    if (pending && state.pendingTurnRequest === pending && state.activeThread?.id === snapshot.threadId) {
      scheduleThreadRefresh(0);
    }
    return changed;
  }

  const RESCUE_TERMINAL_TASK_STATUSES = new Set([
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "canceled",
    "idle",
  ]);

  function rescueTaskAuthorityTimestamp(snapshot = {}) {
    for (const value of [snapshot.finishedAt, snapshot.completedAt, snapshot.updatedAt, snapshot.observedAt]) {
      const normalized = normalizeMessageTimestamp(value);
      if (normalized !== null) return normalized;
    }
    return Date.now();
  }

  function rememberRescueTerminalTaskAuthority(snapshot = {}, { source = "task-status" } = {}) {
    const threadId = typeof snapshot.threadId === "string" && snapshot.threadId
      ? snapshot.threadId
      : null;
    if (!threadId || !RESCUE_TERMINAL_TASK_STATUSES.has(snapshot.status)) return null;
    const explicitTurnId = typeof snapshot.turnId === "string" && snapshot.turnId ? snapshot.turnId : null;
    const staleTurnId = typeof snapshot.staleTurnId === "string" && snapshot.staleTurnId ? snapshot.staleTurnId : null;
    const authoritativeCanSend = snapshot.authoritative === true && snapshot.canSend === true;
    if (!authoritativeCanSend && !explicitTurnId && !staleTurnId) return null;
    const previous = state.terminalTaskAuthorities.get(threadId);
    const currentTurnIds = state.activeThread?.id === threadId ? localInProgressTurnIds() : [];
    const identifiedTurnIds = uniqueTurnIds([explicitTurnId, staleTurnId]);
    const authority = {
      threadId,
      status: rescueTaskTerminalTurnStatus(snapshot.status),
      turnId: explicitTurnId,
      staleTurnId,
      canSend: authoritativeCanSend,
      source,
      observedAt: rescueTaskAuthorityTimestamp(snapshot),
      capturedTurnIds: identifiedTurnIds.length
        ? identifiedTurnIds
        : uniqueTurnIds([
          ...(previous?.capturedTurnIds || []),
          ...(currentTurnIds.length === 1 ? currentTurnIds : []),
        ]),
      fencedTurnIds: uniqueTurnIds(previous?.fencedTurnIds || []),
    };
    state.terminalTaskAuthorities.set(threadId, authority);
    return authority;
  }

  function rescueTaskAuthorityTurnIds(authority, turns = []) {
    if (!authority) return new Set();
    const candidates = (Array.isArray(turns) ? turns : []).filter((turn) => (
      turn?.id
      && turnStatusType(turn) === "inProgress"
      && !state.terminalTurnIds.has(turn.id)
    ));
    const ids = new Set(uniqueTurnIds([
      authority.turnId,
      authority.staleTurnId,
      ...(authority.capturedTurnIds || []),
      ...(authority.fencedTurnIds || []),
    ]));
    if (ids.size || candidates.length !== 1) return ids;
    const startedAt = turnStartedTimestamp(candidates[0]);
    if (startedAt === null || startedAt <= authority.observedAt + 2_000) ids.add(candidates[0].id);
    return ids;
  }

  function fenceRescueTurnsByTaskAuthority(threadId, turns) {
    const authority = state.terminalTaskAuthorities.get(threadId);
    if (!authority) return Array.isArray(turns) ? turns : [];
    const targetIds = rescueTaskAuthorityTurnIds(authority, turns);
    if (!targetIds.size) return Array.isArray(turns) ? turns : [];
    let changed = false;
    const fenced = (Array.isArray(turns) ? turns : []).map((turn) => {
      if (!turn?.id || !targetIds.has(turn.id) || turnStatusType(turn) !== "inProgress") return turn;
      const status = authority.status || "completed";
      rememberTerminalTurn(turn.id, status);
      changed = true;
      return { ...turn, status };
    });
    if (changed) {
      authority.fencedTurnIds = uniqueTurnIds([...(authority.fencedTurnIds || []), ...targetIds]);
      state.terminalTaskAuthorities.set(threadId, authority);
    }
    return fenced;
  }

  function rescueTaskTerminalTurnStatus(status) {
    if (status === "failed") return "failed";
    if (["interrupted", "cancelled", "canceled"].includes(status)) return "interrupted";
    return "completed";
  }

  function taskStatusTime(snapshot, status) {
    if (["running", "waiting", "stopping"].includes(status) && Number.isFinite(snapshot?.startedAt)) {
      return `已运行 ${formatTaskDuration(Date.now() - snapshot.startedAt)}`;
    }
    if (["completed", "failed", "interrupted", "cancelled", "canceled"].includes(status) && Number.isFinite(snapshot?.finishedAt)) {
      const prefix = {
        completed: "完成于",
        failed: "失败于",
        interrupted: "终止于",
        cancelled: "取消于",
        canceled: "取消于",
      }[status];
      const duration = Number.isFinite(snapshot?.startedAt)
        ? ` · 用时 ${formatTaskDuration(snapshot.finishedAt - snapshot.startedAt)}`
        : "";
      return `${prefix} ${formatTaskClock(snapshot.finishedAt)}${duration}`;
    }
    return status === "idle" ? "空闲" : "--";
  }

  function formatTaskDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
  }

  function formatTaskClock(timestamp) {
    return new Date(timestamp).toLocaleTimeString(interfaceLocale(), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function statusLabel(status) {
    if (typeof status === "object") return status.type || "";
    return { inProgress: "运行中", running: "运行中", completed: "完成", failed: "失败", declined: "已拒绝" }[status] || status || "";
  }

  function approvalTitle(method) {
    return {
      "item/commandExecution/requestApproval": "批准执行命令",
      "item/fileChange/requestApproval": "批准文件更改",
      "item/tool/requestUserInput": "Codex 需要你的选择",
      "item/permissions/requestApproval": "批准额外权限",
      "mcpServer/elicitation/request": "MCP 请求输入",
    }[method] || "Codex 请求批准";
  }

  function compactPermissions(permissions) {
    if (!permissions) return {};
    return Object.fromEntries(Object.entries(permissions).filter(([, value]) => value !== null && value !== undefined));
  }

  function relativeTime(timestamp) {
    if (!timestamp) return "";
    const delta = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
    if (delta < 60) return "刚刚";
    if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
    if (delta < 86_400) return `${Math.floor(delta / 3600)} 小时前`;
    return `${Math.floor(delta / 86_400)} 天前`;
  }

  function basename(value) {
    return String(value || "").replace(/\/+$/, "").split("/").pop() || value;
  }

  function createMessageId() {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `rescue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function resizePrompt() {
    elements.promptInput.style.height = "auto";
    elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`;
  }

  function scrollToBottom() {
    elements.messageStage.scrollTop = elements.messageStage.scrollHeight;
  }

  function isNearBottom() {
    return elements.messageStage.scrollHeight - elements.messageStage.scrollTop - elements.messageStage.clientHeight < 120;
  }

  function closeThreads() {
    document.body.classList.remove("threads-open");
  }

  function refreshIcons() {
    window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  function toast(message, type = "info") {
    const key = `${type}:${message}`;
    if (state.activeToastKeys.has(key)) return;
    state.activeToastKeys.add(key);
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    elements.toastRegion.append(item);
    setTimeout(() => {
      item.remove();
      state.activeToastKeys.delete(key);
    }, 4200);
  }
})();
