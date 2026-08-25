const elements = Object.fromEntries([
  "modeDot", "modeLabel", "refreshButton", "themeButton", "errorBanner", "errorMessage", "totalUsers",
  "activeUsers", "disabledUsers", "allocatedStorage", "modeButton", "openInviteButton", "userSearch",
  "statusFilter", "userList", "detailEmpty", "userEditor", "userAvatar", "userRoleLabel", "userDisplayName",
  "userIdentity", "userStatusBadge", "currentTierStatus", "currentTierName", "currentTierMeta", "currentProviderStatus",
  "currentProviderName", "currentProviderMeta", "userTierSelect", "userTierExpiresAt", "userTierSummary", "applyTierButton", "userRole", "userQuota", "storageUsage", "storageMeter",
  "threadLimitPolicyPanel", "defaultCodexThreadLimit", "defaultCodexThreadLimitMeta", "saveThreadLimitPolicyButton",
  "userCodexThreadLimit", "userCodexThreadUsage", "userCodexThreadLimitMeta", "userCodexThreadDetails", "userCodexThreadList", "saveUserThreadLimitButton",
  "customProvidersPermission", "officialLoginPermission", "projectSharingPermission", "codexSkillsPermission",
  "codexPluginsPermission", "codexAppsPermission", "codexMcpPermission", "codexMigrationPermission", "codexMemoryPermission", "codexBackgroundPermission", "codexTerminalPermission", "codexWorkspaceMessagesPermission", "codexRemoteDiffPermission", "codexFeedbackPermission", "usageSource", "fiveHourLimit", "weeklyLimit",
  "claudeRuntimePermission", "claudeOfficialLoginPermission", "claudeProvidersPermission", "claudeExtensionsPermission", "claudeMcpPermission", "claudeHooksPermission", "claudeMemoryPermission", "claudeBackgroundPermission", "claudeWorktreePermission", "claudeProxyPermission", "claudeStructuredOutputPermission", "claudeUltraReviewPermission", "claudeProjectPurgePermission", "claudeBetaHeadersPermission",
  "monthlyLimit", "totalUsage", "fiveHourUsage", "sevenDayUsage", "monthlyUsage", "todayUsage", "providerState", "providerSelect", "assignProviderButton", "unassignProviderButton",
  "imageProviderState", "imageProviderSelect", "imageModelInput", "imagePresetInput", "imageSizeInput", "imageQualityInput",
  "imageOutputFormatInput", "imageOutputCompressionInput", "imageBackgroundInput", "imageModerationInput", "imageResultCountInput", "imagePartialImagesInput",
  "imageTimeoutInput", "imageMaxInputBytesPerImageInput", "imageMaxInputBytesTotalInput", "imageMaxOutputBytesPerImageInput", "imageMaxResponseBytesInput",
  "assignImageProviderButton", "unassignImageProviderButton",
  "toggleUserStatusButton", "saveUserButton", "editorError", "shareCount", "shareProject", "shareTarget",
  "shareAccess", "createShareButton", "shareList", "policyPanel", "defaultTierSelect", "defaultProviderSelect",
  "defaultCustomProviders", "defaultOfficialLogin", "defaultProjectSharing", "defaultCodexSkills", "defaultCodexPlugins",
  "defaultCodexApps", "defaultCodexMcp", "defaultCodexMigration", "defaultCodexMemory", "defaultCodexBackground", "defaultCodexTerminal", "defaultCodexWorkspaceMessages", "defaultCodexRemoteDiff", "defaultCodexFeedback", "savePolicyButton", "addTierButton", "tierList",
  "defaultClaudeRuntime", "defaultClaudeOfficialLogin", "defaultClaudeProviders", "defaultClaudeExtensions", "defaultClaudeMcp", "defaultClaudeHooks", "defaultClaudeMemory", "defaultClaudeBackground", "defaultClaudeWorktree", "defaultClaudeProxy", "defaultClaudeStructuredOutput", "defaultClaudeUltraReview", "defaultClaudeProjectPurge", "defaultClaudeBetaHeaders",
  "inviteDialog", "inviteForm", "inviteRole", "inviteTier", "inviteProvider", "inviteHours", "inviteTierSummary",
  "inviteResult", "inviteUrl", "copyInviteButton", "inviteError", "createInviteButton",
  "tierDialog", "tierForm", "tierDialogTitle", "tierName", "tierQuota", "tierProvider", "tierFiveHourLimit",
  "tierWeeklyLimit", "tierMonthlyLimit", "tierCustomProviders", "tierOfficialLogin", "tierProjectSharing",
  "tierCodexSkills", "tierCodexPlugins", "tierCodexApps", "tierCodexMcp", "tierCodexMigration", "tierCodexMemory", "tierCodexBackground", "tierCodexTerminal", "tierCodexWorkspaceMessages", "tierCodexRemoteDiff", "tierCodexFeedback", "tierError", "removeTierButton", "saveTierButton",
  "tierClaudeRuntime", "tierClaudeOfficialLogin", "tierClaudeProviders", "tierClaudeExtensions", "tierClaudeMcp", "tierClaudeHooks", "tierClaudeMemory", "tierClaudeBackground", "tierClaudeWorktree", "tierClaudeProxy", "tierClaudeStructuredOutput", "tierClaudeUltraReview", "tierClaudeProjectPurge", "tierClaudeBetaHeaders",
  "modeDialog", "modeForm", "modeDialogTitle", "modePassword", "modeError", "confirmModeButton", "toast",
  "currentAccount", "closeDetailButton", "drawerScrim",
].map((id) => [id, document.getElementById(id)]));

const embeddedInOps = new URLSearchParams(location.search).get("embed") === "ops";

function interfaceLocale() {
  return window.WFLI18n?.getLanguage?.() === "en" ? "en-US" : "zh-CN";
}

function setDataContent(element, value, protectedContent = true) {
  element.toggleAttribute("data-i18n-ignore", protectedContent);
  element.textContent = value;
  return element;
}

function dataOption(label, value) {
  const option = new Option(label, value);
  option.setAttribute("data-i18n-ignore", "");
  return option;
}
if (embeddedInOps) document.documentElement.dataset.embed = "ops";
const state = { account: null, mode: null, policy: null, users: [], shares: [], providers: [], projects: [], selectedId: null, detailOpen: false, editingTierId: null };

initialize();

async function initialize() {
  applyTheme();
  bindEvents();
  window.lucide?.createIcons();
  await loadData();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", loadData);
  elements.themeButton.addEventListener("click", toggleTheme);
  elements.userSearch.addEventListener("input", renderUserList);
  elements.statusFilter.addEventListener("change", renderUserList);
  elements.closeDetailButton.addEventListener("click", closeUserDetail);
  elements.drawerScrim.addEventListener("click", closeUserDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.detailOpen && !document.querySelector("dialog[open]")) closeUserDetail();
  });
  elements.userEditor.addEventListener("submit", saveSelectedUser);
  elements.toggleUserStatusButton.addEventListener("click", toggleSelectedUserStatus);
  elements.assignProviderButton.addEventListener("click", assignProvider);
  elements.unassignProviderButton.addEventListener("click", unassignProvider);
  elements.assignImageProviderButton.addEventListener("click", assignImageProvider);
  elements.unassignImageProviderButton.addEventListener("click", unassignImageProvider);
  elements.applyTierButton.addEventListener("click", applySelectedTier);
  elements.userTierSelect.addEventListener("change", renderSelectedTierSummary);
  elements.userTierExpiresAt.addEventListener("input", renderSelectedTierSummary);
  elements.savePolicyButton.addEventListener("click", savePolicy);
  elements.saveThreadLimitPolicyButton.addEventListener("click", saveThreadLimitPolicy);
  elements.saveUserThreadLimitButton.addEventListener("click", saveSelectedUserThreadLimit);
  elements.addTierButton.addEventListener("click", () => openTierDialog());
  elements.tierForm.addEventListener("submit", saveTier);
  elements.removeTierButton.addEventListener("click", removeTier);
  elements.openInviteButton.addEventListener("click", openInviteDialog);
  elements.inviteTier.addEventListener("change", updateInviteTier);
  elements.inviteRole.addEventListener("change", updateInviteTier);
  elements.inviteForm.addEventListener("submit", createInvite);
  elements.copyInviteButton.addEventListener("click", copyInvite);
  elements.modeButton.addEventListener("click", openModeDialog);
  elements.modeForm.addEventListener("submit", updateAccountMode);
  elements.createShareButton.addEventListener("click", createShare);
  elements.shareTarget.addEventListener("change", updateShareAccess);
}

async function loadData() {
  elements.refreshButton.disabled = true;
  try {
    const account = await api("/api/account?summary=1");
    if (!["owner", "admin"].includes(account.user?.role)) throw new Error("当前账号没有用户管理权限");
    const [settings, providers, projects] = await Promise.all([
      api("/api/multi-user/settings"), api("/api/providers"), api("/api/projects"),
    ]);
    state.account = account.user;
    state.mode = settings.mode;
    state.policy = settings.policy;
    state.users = settings.users || [];
    state.shares = settings.shares || [];
    state.providers = providers.profiles || [];
    state.projects = (projects.projects || []).filter((project) => !project.shared);
    if (!state.users.some((user) => user.id === state.selectedId)) {
      state.selectedId = state.users.find((user) => user.role !== "owner")?.id || state.users[0]?.id || null;
      state.detailOpen = false;
    }
    render();
    hideError();
  } catch (error) {
    showError(error.message);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function render() {
  const active = state.users.filter((user) => user.status === "active").length;
  elements.modeLabel.textContent = state.mode?.enabled ? "多用户已启用" : "单用户模式";
  elements.modeLabel.parentElement.dataset.enabled = String(state.mode?.enabled === true);
  elements.totalUsers.textContent = String(state.users.length || 1);
  elements.activeUsers.textContent = String(active || (state.mode?.enabled ? 0 : 1));
  elements.disabledUsers.textContent = String(state.users.filter((user) => user.status === "disabled").length);
  elements.allocatedStorage.textContent = formatBytes(state.users.filter((user) => !user.legacy).reduce((sum, user) => sum + (user.quotaBytes || 0), 0));
  setDataContent(elements.currentAccount, `${state.account.displayName || state.account.username} · ${roleLabel(state.account.role)}`);
  elements.modeButton.querySelector("span").textContent = state.mode?.enabled ? "关闭多用户" : "启用多用户";
  elements.modeButton.hidden = state.account.role !== "owner";
  elements.openInviteButton.disabled = !state.mode?.enabled;
  renderPolicy();
  renderUserList();
  renderEditor();
  renderShares();
  window.lucide?.createIcons();
}

function renderPolicy() {
  const policy = state.policy;
  elements.threadLimitPolicyPanel.hidden = !policy?.canManageCodexThreadLimit;
  if (policy?.canManageCodexThreadLimit) {
    elements.defaultCodexThreadLimit.value = String(policy.defaultCodexThreadLimit || 8);
    const modifier = policy.codexThreadLimitUpdatedByName || "尚未单独修改";
    const modifiedAt = policy.codexThreadLimitUpdatedAt
      ? new Date(policy.codexThreadLimitUpdatedAt).toLocaleString(interfaceLocale())
      : "";
    setDataContent(elements.defaultCodexThreadLimitMeta, `每用户默认 ${policy.defaultCodexThreadLimit || 8} 个 · ${modifier}${modifiedAt ? ` · ${modifiedAt}` : ""}`);
  }
  elements.policyPanel.hidden = !policy?.canManage;
  if (!policy?.canManage) return;
  elements.defaultTierSelect.replaceChildren(...policy.tiers.map((tier) => dataOption(tier.name, tier.id)));
  elements.defaultTierSelect.value = policy.defaultTierId || policy.tiers[0]?.id || "";
  elements.defaultProviderSelect.replaceChildren(...providerOptions("不默认分配供应商"));
  elements.defaultProviderSelect.value = policy.defaultProviderId || "";
  elements.defaultCustomProviders.checked = policy.defaultPermissions?.customProviders === true;
  elements.defaultOfficialLogin.checked = policy.defaultPermissions?.officialLogin === true;
  elements.defaultProjectSharing.checked = policy.defaultPermissions?.projectSharing === true;
  elements.defaultCodexSkills.checked = policy.defaultPermissions?.codexSkills === true;
  elements.defaultCodexPlugins.checked = policy.defaultPermissions?.codexPlugins === true;
  elements.defaultCodexApps.checked = policy.defaultPermissions?.codexApps === true;
  elements.defaultCodexMcp.checked = policy.defaultPermissions?.codexMcp === true;
  elements.defaultCodexMigration.checked = policy.defaultPermissions?.codexMigration === true;
  elements.defaultCodexMemory.checked = policy.defaultPermissions?.codexMemory === true;
  elements.defaultCodexBackground.checked = policy.defaultPermissions?.codexBackground === true;
  elements.defaultCodexTerminal.checked = policy.defaultPermissions?.codexTerminal === true;
  elements.defaultCodexWorkspaceMessages.checked = policy.defaultPermissions?.codexWorkspaceMessages === true;
  elements.defaultCodexRemoteDiff.checked = policy.defaultPermissions?.codexRemoteDiff === true;
  elements.defaultCodexFeedback.checked = policy.defaultPermissions?.codexFeedback === true;
  elements.defaultClaudeRuntime.checked = policy.defaultPermissions?.claudeRuntime === true;
  elements.defaultClaudeOfficialLogin.checked = policy.defaultPermissions?.claudeOfficialLogin === true;
  elements.defaultClaudeProviders.checked = policy.defaultPermissions?.claudeProviders === true;
  elements.defaultClaudeExtensions.checked = policy.defaultPermissions?.claudeExtensions === true;
  elements.defaultClaudeMcp.checked = policy.defaultPermissions?.claudeMcp === true;
  elements.defaultClaudeHooks.checked = policy.defaultPermissions?.claudeHooks === true;
  elements.defaultClaudeMemory.checked = policy.defaultPermissions?.claudeMemory === true;
  elements.defaultClaudeBackground.checked = policy.defaultPermissions?.claudeBackground === true;
  elements.defaultClaudeWorktree.checked = policy.defaultPermissions?.claudeWorktree === true;
  elements.defaultClaudeProxy.checked = policy.defaultPermissions?.claudeProxy === true;
  elements.defaultClaudeStructuredOutput.checked = policy.defaultPermissions?.claudeStructuredOutput === true;
  elements.defaultClaudeUltraReview.checked = policy.defaultPermissions?.claudeUltraReview === true;
  elements.defaultClaudeProjectPurge.checked = policy.defaultPermissions?.claudeProjectPurge === true;
  elements.defaultClaudeBetaHeaders.checked = policy.defaultPermissions?.claudeBetaHeaders === true;
  elements.tierList.replaceChildren();
  for (const tier of policy.tiers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tier-item";
    button.innerHTML = '<span><strong></strong><small></small></span><i data-lucide="chevron-right"></i>';
    setDataContent(button.querySelector("strong"), tier.name);
    setDataContent(button.querySelector("small"), tierSummary(tier));
    button.dataset.default = String(tier.id === policy.defaultTierId);
    button.addEventListener("click", () => openTierDialog(tier.id));
    elements.tierList.append(button);
  }
}

function renderUserList() {
  const query = elements.userSearch.value.trim().toLowerCase();
  const status = elements.statusFilter.value;
  const users = state.users.filter((user) => {
    const matchesQuery = !query || `${user.username} ${user.displayName}`.toLowerCase().includes(query);
    return matchesQuery && (!status || user.status === status);
  });
  elements.userList.replaceChildren();
  for (const user of users) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `user-row${user.id === state.selectedId ? " is-active" : ""}`;
    row.innerHTML = '<span class="row-avatar"></span><span><strong></strong><small></small></span><i class="row-state"></i>';
    setDataContent(row.querySelector(".row-avatar"), avatarText(user));
    setDataContent(row.querySelector("strong"), user.displayName || user.username);
    const tier = state.policy?.tiers?.find((entry) => entry.id === user.tierId);
    const providerName = user.assignedProviderId
      ? (state.providers.find((provider) => provider.id === user.assignedProviderId)?.name || "API 已分配")
      : "未分配 API";
    setDataContent(row.querySelector("small"), `${user.username} · ${user.tierName || tier?.name || "自定义设置"} · ${providerName}`);
    row.querySelector(".row-state").dataset.status = user.status;
    row.addEventListener("click", () => { state.selectedId = user.id; state.detailOpen = true; renderUserList(); renderEditor(); });
    elements.userList.append(row);
  }
  if (!users.length) elements.userList.innerHTML = '<div class="list-empty">没有匹配用户</div>';
}

function renderEditor() {
  const user = selectedUser();
  elements.detailEmpty.hidden = Boolean(user);
  elements.userEditor.hidden = !user;
  document.body.classList.toggle("user-drawer-open", Boolean(user));
  if (!user) return;
  const editable = canManage(user);
  setDataContent(elements.userAvatar, avatarText(user));
  elements.userRoleLabel.textContent = user.role.toUpperCase();
  setDataContent(elements.userDisplayName, user.displayName || user.username);
  setDataContent(elements.userIdentity, `${user.username} · ${user.quotaMode === "filesystem" ? "硬配额" : user.legacy ? "主机工作区" : "应用配额"}`);
  elements.userStatusBadge.textContent = user.status === "active" ? "可用" : "已停用";
  elements.userStatusBadge.dataset.status = user.status;
  renderCurrentAssignments(user);
  elements.userTierSelect.replaceChildren(
    new Option("自定义设置", ""),
    ...(state.policy?.tiers || []).map((tier) => dataOption(tier.name, tier.id)),
  );
  elements.userTierSelect.value = user.tierId || "";
  elements.userTierSelect.disabled = !editable || user.status !== "active" || !(state.policy?.tiers?.length);
  elements.userTierExpiresAt.min = localDateInputValue(Date.now());
  elements.userTierExpiresAt.value = localDateInputValue(user.tierExpiresAt);
  elements.userTierExpiresAt.disabled = elements.userTierSelect.disabled || !elements.userTierSelect.value;
  elements.applyTierButton.disabled = elements.userTierSelect.disabled || !elements.userTierSelect.value;
  renderSelectedTierSummary();
  elements.userRole.value = user.role;
  elements.userRole.disabled = !editable || state.account.role !== "owner";
  elements.userQuota.value = user.legacy ? "" : String(Math.max(1, Math.round(user.quotaBytes / 1024 ** 3)));
  elements.userQuota.disabled = !editable || user.legacy;
  const defaultLimit = state.policy?.defaultCodexThreadLimit || 8;
  elements.userCodexThreadLimit.replaceChildren(
    new Option(`使用系统默认值（${defaultLimit}）`, ""),
    ...Array.from({ length: 16 }, (_, index) => new Option(String(index + 1), String(index + 1))),
  );
  elements.userCodexThreadLimit.value = user.codexThreadLimit === null ? "" : String(user.codexThreadLimit);
  const threadLimitEditable = canManageThreadLimit(user);
  elements.userCodexThreadLimit.disabled = !threadLimitEditable;
  elements.saveUserThreadLimitButton.disabled = !threadLimitEditable;
  setDataContent(elements.userCodexThreadUsage, `${user.codexThreadUsage || 0} / ${user.effectiveCodexThreadLimit || defaultLimit}`);
  const limitModifier = user.codexThreadLimitUpdatedByName || (user.codexThreadLimit === null ? "使用系统默认值" : "未知修改人");
  const limitModifiedAt = user.codexThreadLimitUpdatedAt
    ? new Date(user.codexThreadLimitUpdatedAt).toLocaleString(interfaceLocale())
    : "";
  setDataContent(elements.userCodexThreadLimitMeta, `${limitModifier}${limitModifiedAt ? ` · ${limitModifiedAt}` : ""}`);
  const activeThreads = user.activeCodexThreads || [];
  elements.userCodexThreadDetails.hidden = activeThreads.length === 0;
  elements.userCodexThreadList.replaceChildren(...activeThreads.map((task) => {
    const row = document.createElement("div");
    const title = task.title || task.threadName || task.threadId || "Codex Thread";
    row.innerHTML = "<span></span><strong></strong>";
    setDataContent(row.querySelector("span"), String(title).slice(0, 80));
    setDataContent(row.querySelector("strong"), task.status || "running");
    return row;
  }));
  elements.storageUsage.textContent = user.legacy ? "主机空间" : `${formatBytes(user.usedBytes)} / ${formatBytes(user.quotaBytes)}`;
  elements.storageMeter.style.width = user.legacy || !user.quotaBytes ? "0" : `${Math.min(100, (user.usedBytes / user.quotaBytes) * 100)}%`;
  elements.customProvidersPermission.checked = user.permissions?.customProviders === true;
  elements.officialLoginPermission.checked = user.permissions?.officialLogin === true;
  elements.projectSharingPermission.checked = user.permissions?.projectSharing === true;
  elements.codexSkillsPermission.checked = user.permissions?.codexSkills === true;
  elements.codexPluginsPermission.checked = user.permissions?.codexPlugins === true;
  elements.codexAppsPermission.checked = user.permissions?.codexApps === true;
  elements.codexMcpPermission.checked = user.permissions?.codexMcp === true;
  elements.codexMigrationPermission.checked = user.permissions?.codexMigration === true;
  elements.codexMemoryPermission.checked = user.permissions?.codexMemory === true;
  elements.codexBackgroundPermission.checked = user.permissions?.codexBackground === true;
  elements.codexTerminalPermission.checked = user.permissions?.codexTerminal === true;
  elements.codexWorkspaceMessagesPermission.checked = user.permissions?.codexWorkspaceMessages === true;
  elements.codexRemoteDiffPermission.checked = user.permissions?.codexRemoteDiff === true;
  elements.codexFeedbackPermission.checked = user.permissions?.codexFeedback === true;
  elements.claudeRuntimePermission.checked = user.permissions?.claudeRuntime === true;
  elements.claudeOfficialLoginPermission.checked = user.permissions?.claudeOfficialLogin === true;
  elements.claudeProvidersPermission.checked = user.permissions?.claudeProviders === true;
  elements.claudeExtensionsPermission.checked = user.permissions?.claudeExtensions === true;
  elements.claudeMcpPermission.checked = user.permissions?.claudeMcp === true;
  elements.claudeHooksPermission.checked = user.permissions?.claudeHooks === true;
  elements.claudeMemoryPermission.checked = user.permissions?.claudeMemory === true;
  elements.claudeBackgroundPermission.checked = user.permissions?.claudeBackground === true;
  elements.claudeWorktreePermission.checked = user.permissions?.claudeWorktree === true;
  elements.claudeProxyPermission.checked = user.permissions?.claudeProxy === true;
  elements.claudeStructuredOutputPermission.checked = user.permissions?.claudeStructuredOutput === true;
  elements.claudeUltraReviewPermission.checked = user.permissions?.claudeUltraReview === true;
  elements.claudeProjectPurgePermission.checked = user.permissions?.claudeProjectPurge === true;
  elements.claudeBetaHeadersPermission.checked = user.permissions?.claudeBetaHeaders === true;
  elements.customProvidersPermission.disabled = !editable || user.role !== "member";
  elements.officialLoginPermission.disabled = !editable || user.role !== "member";
  elements.projectSharingPermission.disabled = !editable;
  for (const input of [
    elements.codexSkillsPermission,
    elements.codexPluginsPermission,
    elements.codexAppsPermission,
    elements.codexMcpPermission,
    elements.codexMigrationPermission,
    elements.codexMemoryPermission,
    elements.codexBackgroundPermission,
    elements.codexTerminalPermission,
    elements.codexWorkspaceMessagesPermission,
    elements.codexRemoteDiffPermission,
    elements.codexFeedbackPermission,
    elements.claudeRuntimePermission,
    elements.claudeOfficialLoginPermission,
    elements.claudeProvidersPermission,
    elements.claudeExtensionsPermission,
    elements.claudeMcpPermission,
    elements.claudeHooksPermission,
    elements.claudeMemoryPermission,
    elements.claudeBackgroundPermission,
    elements.claudeWorktreePermission,
    elements.claudeProxyPermission,
    elements.claudeStructuredOutputPermission,
    elements.claudeUltraReviewPermission,
    elements.claudeProjectPurgePermission,
    elements.claudeBetaHeadersPermission,
  ]) input.disabled = !editable || user.role !== "member";
  setLimitInput(elements.fiveHourLimit, user.fiveHourTokenLimit);
  setLimitInput(elements.weeklyLimit, user.weeklyTokenLimit);
  setLimitInput(elements.monthlyLimit, user.monthlyTokenLimit);
  for (const input of [elements.fiveHourLimit, elements.weeklyLimit, elements.monthlyLimit]) input.disabled = !editable;
  renderUsage(elements.totalUsage, user.tokenUsage?.total);
  renderUsage(elements.fiveHourUsage, user.tokenUsage?.fiveHour);
  renderUsage(elements.sevenDayUsage, user.tokenUsage?.sevenDay);
  renderUsage(elements.monthlyUsage, user.tokenUsage?.monthly);
  renderUsage(elements.todayUsage, user.tokenUsage?.today);
  const usagePeriods = [
    user.tokenUsage?.total,
    user.tokenUsage?.fiveHour,
    user.tokenUsage?.sevenDay,
    user.tokenUsage?.monthly,
    user.tokenUsage?.today,
  ].filter(Boolean);
  elements.usageSource.textContent = usagePeriods.some((usage) => usage?.available)
    ? "Codex 已上报"
    : usagePeriods.some((usage) => usage?.reportingStatus === "missing")
      ? "Codex 未上报"
      : "本周期暂无对话";
  setDataContent(
    elements.providerState,
    providerStateLabel(user.provider),
    user.provider?.providerMode === "managed" && Boolean(user.provider?.providerName),
  );
  elements.providerState.dataset.status = user.provider?.providerState || "missing";
  elements.providerSelect.replaceChildren(...state.providers.map((provider) => dataOption(provider.name, provider.id)));
  if (state.providers.some((provider) => provider.id === user.assignedProviderId)) elements.providerSelect.value = user.assignedProviderId;
  elements.providerSelect.disabled = !editable || !state.providers.length || user.status !== "active";
  elements.assignProviderButton.disabled = elements.providerSelect.disabled;
  elements.unassignProviderButton.disabled = !editable || !(
    user.assignedProviderId || user.provider?.providerName?.startsWith("分配 · ")
  );
  const imageProvider = user.provider?.imageProvider;
  setDataContent(
    elements.imageProviderState,
    imageProvider?.configured
      ? `${imageProvider.providerName || "已分配"} · ${imageProvider.model}`
      : imageProvider?.state === "error" ? "读取失败" : "未配置",
    Boolean(imageProvider?.configured),
  );
  elements.imageProviderState.dataset.status = imageProvider?.state || "missing";
  elements.imageProviderSelect.replaceChildren(...state.providers.map((provider) => dataOption(provider.name, provider.id)));
  const assignedImageProvider = state.providers.find((provider) => (
    provider.baseUrl === imageProvider?.providerBaseUrl
    && [`分配 · ${provider.name}`, provider.name].includes(imageProvider?.providerName)
  ));
  if (assignedImageProvider) elements.imageProviderSelect.value = assignedImageProvider.id;
  const imageDefaults = imageProvider?.defaults || {};
  const imageLimits = imageProvider?.limits || {};
  elements.imageModelInput.value = imageProvider?.model || "gpt-image-2";
  elements.imagePresetInput.value = imageProvider?.preset || "generation-only";
  elements.imageSizeInput.value = imageDefaults.size || imageProvider?.size || "1024x1024";
  elements.imageQualityInput.value = imageDefaults.quality || imageProvider?.quality || "auto";
  elements.imageOutputFormatInput.value = imageDefaults.outputFormat || "png";
  elements.imageOutputCompressionInput.value = String(imageDefaults.outputCompression ?? 100);
  elements.imageBackgroundInput.value = imageDefaults.background || "opaque";
  elements.imageModerationInput.value = imageDefaults.moderation || "auto";
  elements.imageResultCountInput.value = String(imageDefaults.n ?? 1);
  elements.imagePartialImagesInput.value = String(imageDefaults.partialImages ?? 0);
  elements.imageTimeoutInput.value = optionalIntegerValue(imageLimits.timeoutMs);
  elements.imageMaxInputBytesPerImageInput.value = optionalIntegerValue(imageLimits.maxInputBytesPerImage);
  elements.imageMaxInputBytesTotalInput.value = optionalIntegerValue(imageLimits.maxInputBytesTotal);
  elements.imageMaxOutputBytesPerImageInput.value = optionalIntegerValue(imageLimits.maxOutputBytesPerImage);
  elements.imageMaxResponseBytesInput.value = optionalIntegerValue(imageLimits.maxResponseBytes);
  elements.imageProviderSelect.disabled = !editable || !state.providers.length || user.status !== "active";
  for (const input of imageProviderAssignmentInputs()) {
    input.disabled = elements.imageProviderSelect.disabled;
  }
  elements.assignImageProviderButton.disabled = elements.imageProviderSelect.disabled;
  elements.unassignImageProviderButton.disabled = !editable || !imageProvider?.configured;
  elements.toggleUserStatusButton.hidden = !editable;
  elements.toggleUserStatusButton.textContent = user.status === "active" ? "停用账号" : "启用账号";
  elements.saveUserButton.disabled = !editable;
  elements.editorError.textContent = "";
}

function closeUserDetail() {
  state.detailOpen = false;
  state.selectedId = null;
  renderUserList();
  renderEditor();
}

function renderShares() {
  const targets = state.users.filter((user) => user.id !== state.account.id && user.status === "active" && user.permissions?.projectSharing);
  elements.shareProject.replaceChildren(...state.projects.map((project) => dataOption(project.name, project.path)));
  elements.shareTarget.replaceChildren(...targets.map((user) => dataOption(user.displayName || user.username, user.id)));
  elements.createShareButton.disabled = !state.mode?.enabled || !state.projects.length || !targets.length;
  updateShareAccess();
  elements.shareCount.textContent = `${state.shares.length} 项`;
  elements.shareList.replaceChildren();
  for (const share of state.shares) {
    const row = document.createElement("div");
    row.className = "share-row";
    const copy = document.createElement("div");
    const target = state.users.find((user) => user.id === share.targetUserId);
    copy.innerHTML = `<strong></strong><span></span>`;
    setDataContent(copy.querySelector("strong"), share.projectName || share.projectPath.split("/").pop());
    setDataContent(copy.querySelector("span"), `${target?.displayName || share.targetName || "未知用户"} · ${share.access === "write" ? "可编辑" : "只读"}`);
    const remove = document.createElement("button");
    remove.className = "icon-button"; remove.type = "button"; remove.title = "撤销共享"; remove.setAttribute("aria-label", "撤销共享");
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.addEventListener("click", () => removeShare(share.id));
    row.append(copy, remove); elements.shareList.append(row);
  }
  if (!state.shares.length) elements.shareList.innerHTML = '<div class="list-empty">暂无共享工程</div>';
}

function providerStateLabel(provider) {
  if (provider?.providerState === "error") return "读取失败";
  if (provider?.providerMode === "managed") return provider.providerName || "已分配";
  if (provider?.providerMode === "codex") return "Codex 原配置";
  return "未配置";
}

function renderCurrentAssignments(user) {
  const tier = state.policy?.tiers?.find((entry) => entry.id === user.tierId);
  const tierAssigned = Boolean(user.tierId || user.tierName);
  setDataContent(elements.currentTierName, user.tierName || tier?.name || "自定义设置");
  setDataContent(
    elements.currentTierMeta,
    tierAssigned ? `已应用 · ${tierExpirationLabel(user.tierExpiresAt)}` : "未套用套餐",
  );
  elements.currentTierStatus.dataset.status = tierAssigned ? "ready" : "none";

  const source = state.providers.find((provider) => provider.id === user.assignedProviderId);
  const effectiveName = user.provider?.providerMode === "managed"
    ? String(user.provider.providerName || "").replace(/^分配 · /, "")
    : "";
  const assignmentSaved = Boolean(user.assignedProviderId);
  setDataContent(
    elements.currentProviderName,
    source?.name || effectiveName || (assignmentSaved ? "已保存的 API" : providerStateLabel(user.provider)),
  );
  if (!assignmentSaved) {
    setDataContent(
      elements.currentProviderMeta,
      user.provider?.providerMode === "codex" ? "使用 Codex 原配置" : "尚未分配管理员 API",
    );
    elements.currentProviderStatus.dataset.status = user.provider?.providerMode === "codex" ? "default" : "none";
  } else if (user.provider?.providerState === "ready" && user.provider?.providerMode === "managed") {
    setDataContent(elements.currentProviderMeta, "已保存并生效");
    elements.currentProviderStatus.dataset.status = "ready";
  } else if (user.provider?.providerState === "error") {
    setDataContent(elements.currentProviderMeta, "分配已保存，运行状态读取失败");
    elements.currentProviderStatus.dataset.status = "error";
  } else {
    setDataContent(elements.currentProviderMeta, "分配已保存，等待运行时同步");
    elements.currentProviderStatus.dataset.status = "waiting";
  }
}

function renderSelectedTierSummary() {
  const user = selectedUser();
  const tier = state.policy?.tiers?.find((entry) => entry.id === elements.userTierSelect.value);
  elements.userTierExpiresAt.disabled = elements.userTierSelect.disabled || !tier;
  const current = user?.tierName
    ? `当前 ${user.tierName}（${tierExpirationLabel(user.tierExpiresAt)}）`
    : "当前为单独设置";
  setDataContent(elements.userTierSummary, tier
    ? `${current}；应用后 ${tierSummary(tier)} · ${tierExpirationLabel(tierExpirationTimestamp(elements.userTierExpiresAt.value, { allowInvalid: true }))}`
    : `${current}；选择套餐后可一次应用空间、权限、Token 和供应商`);
  elements.applyTierButton.disabled = elements.userTierSelect.disabled || !tier;
}

async function savePolicy() {
  elements.savePolicyButton.disabled = true;
  try {
    await api("/api/multi-user/policy", {
      method: "PUT",
      action: "multi-user-policy-update",
      body: {
        defaultTierId: elements.defaultTierSelect.value,
        defaultProviderId: elements.defaultProviderSelect.value || null,
        defaultPermissions: {
          customProviders: elements.defaultCustomProviders.checked,
          officialLogin: elements.defaultOfficialLogin.checked,
          projectSharing: elements.defaultProjectSharing.checked,
          codexSkills: elements.defaultCodexSkills.checked,
          codexPlugins: elements.defaultCodexPlugins.checked,
          codexApps: elements.defaultCodexApps.checked,
          codexMcp: elements.defaultCodexMcp.checked,
          codexMigration: elements.defaultCodexMigration.checked,
          codexMemory: elements.defaultCodexMemory.checked,
          codexBackground: elements.defaultCodexBackground.checked,
          codexTerminal: elements.defaultCodexTerminal.checked,
          codexWorkspaceMessages: elements.defaultCodexWorkspaceMessages.checked,
          codexRemoteDiff: elements.defaultCodexRemoteDiff.checked,
          codexFeedback: elements.defaultCodexFeedback.checked,
          claudeRuntime: elements.defaultClaudeRuntime.checked,
          claudeOfficialLogin: elements.defaultClaudeOfficialLogin.checked,
          claudeProviders: elements.defaultClaudeProviders.checked,
          claudeExtensions: elements.defaultClaudeExtensions.checked,
          claudeMcp: elements.defaultClaudeMcp.checked,
          claudeHooks: elements.defaultClaudeHooks.checked,
          claudeMemory: elements.defaultClaudeMemory.checked,
          claudeBackground: elements.defaultClaudeBackground.checked,
          claudeWorktree: elements.defaultClaudeWorktree.checked,
          claudeProxy: elements.defaultClaudeProxy.checked,
          claudeStructuredOutput: elements.defaultClaudeStructuredOutput.checked,
          claudeUltraReview: elements.defaultClaudeUltraReview.checked,
          claudeProjectPurge: elements.defaultClaudeProjectPurge.checked,
          claudeBetaHeaders: elements.defaultClaudeBetaHeaders.checked,
        },
      },
    });
    await loadData();
    toast("新用户默认设置已保存");
  } catch (error) {
    showError(error.message);
  } finally {
    elements.savePolicyButton.disabled = false;
  }
}

async function saveThreadLimitPolicy() {
  elements.saveThreadLimitPolicyButton.disabled = true;
  try {
    await api("/api/multi-user/policy", {
      method: "PUT",
      action: "multi-user-policy-update",
      body: { defaultCodexThreadLimit: Number(elements.defaultCodexThreadLimit.value) },
    });
    await loadData();
    toast("系统默认并发线程上限已更新");
  } catch (error) {
    showError(error.message);
  } finally {
    elements.saveThreadLimitPolicyButton.disabled = false;
  }
}

async function saveSelectedUserThreadLimit() {
  const user = selectedUser();
  if (!user || !canManageThreadLimit(user)) return;
  elements.saveUserThreadLimitButton.disabled = true;
  try {
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      action: "multi-user-user-update",
      body: { codexThreadLimit: elements.userCodexThreadLimit.value ? Number(elements.userCodexThreadLimit.value) : null },
    });
    await loadData();
    toast("用户并发线程上限已更新");
  } catch (error) {
    elements.editorError.textContent = error.message;
  } finally {
    elements.saveUserThreadLimitButton.disabled = false;
  }
}

function openTierDialog(tierId = null) {
  const tier = state.policy?.tiers?.find((entry) => entry.id === tierId) || null;
  state.editingTierId = tier?.id || null;
  elements.tierForm.reset();
  elements.tierDialogTitle.textContent = tier ? "编辑用户套餐" : "新建用户套餐";
  elements.tierProvider.replaceChildren(...providerOptions("不分配供应商"));
  elements.tierName.value = tier?.name || "";
  elements.tierQuota.value = tier ? String(tier.quotaBytes / 1024 ** 3) : "10";
  elements.tierProvider.value = tier?.providerId || "";
  setLimitInput(elements.tierFiveHourLimit, tier?.fiveHourTokenLimit);
  setLimitInput(elements.tierWeeklyLimit, tier?.weeklyTokenLimit);
  setLimitInput(elements.tierMonthlyLimit, tier?.monthlyTokenLimit);
  elements.tierCustomProviders.checked = tier ? tier.permissions?.customProviders === true : true;
  elements.tierOfficialLogin.checked = tier?.permissions?.officialLogin === true;
  elements.tierProjectSharing.checked = tier?.permissions?.projectSharing === true;
  elements.tierCodexSkills.checked = tier?.permissions?.codexSkills === true;
  elements.tierCodexPlugins.checked = tier?.permissions?.codexPlugins === true;
  elements.tierCodexApps.checked = tier?.permissions?.codexApps === true;
  elements.tierCodexMcp.checked = tier?.permissions?.codexMcp === true;
  elements.tierCodexMigration.checked = tier?.permissions?.codexMigration === true;
  elements.tierCodexMemory.checked = tier?.permissions?.codexMemory === true;
  elements.tierCodexBackground.checked = tier?.permissions?.codexBackground === true;
  elements.tierCodexTerminal.checked = tier?.permissions?.codexTerminal === true;
  elements.tierCodexWorkspaceMessages.checked = tier?.permissions?.codexWorkspaceMessages === true;
  elements.tierCodexRemoteDiff.checked = tier?.permissions?.codexRemoteDiff === true;
  elements.tierCodexFeedback.checked = tier?.permissions?.codexFeedback === true;
  elements.tierClaudeRuntime.checked = tier ? tier.permissions?.claudeRuntime === true : true;
  elements.tierClaudeOfficialLogin.checked = tier?.permissions?.claudeOfficialLogin === true;
  elements.tierClaudeProviders.checked = tier?.permissions?.claudeProviders === true;
  elements.tierClaudeExtensions.checked = tier?.permissions?.claudeExtensions === true;
  elements.tierClaudeMcp.checked = tier?.permissions?.claudeMcp === true;
  elements.tierClaudeHooks.checked = tier?.permissions?.claudeHooks === true;
  elements.tierClaudeMemory.checked = tier?.permissions?.claudeMemory === true;
  elements.tierClaudeBackground.checked = tier?.permissions?.claudeBackground === true;
  elements.tierClaudeWorktree.checked = tier?.permissions?.claudeWorktree === true;
  elements.tierClaudeProxy.checked = tier?.permissions?.claudeProxy === true;
  elements.tierClaudeStructuredOutput.checked = tier?.permissions?.claudeStructuredOutput === true;
  elements.tierClaudeUltraReview.checked = tier?.permissions?.claudeUltraReview === true;
  elements.tierClaudeProjectPurge.checked = tier?.permissions?.claudeProjectPurge === true;
  elements.tierClaudeBetaHeaders.checked = tier?.permissions?.claudeBetaHeaders === true;
  elements.removeTierButton.hidden = !tier || tier.id === state.policy?.defaultTierId || tier.id === "tier-default";
  elements.tierError.textContent = "";
  elements.tierDialog.showModal();
}

async function saveTier(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  elements.saveTierButton.disabled = true;
  try {
    const body = {
      name: elements.tierName.value.trim(),
      quotaBytes: Math.round(Number(elements.tierQuota.value) * 1024 ** 3),
      providerId: elements.tierProvider.value || null,
      fiveHourTokenLimit: parseLimit(elements.tierFiveHourLimit.value, "5 小时"),
      weeklyTokenLimit: parseLimit(elements.tierWeeklyLimit.value, "每周"),
      monthlyTokenLimit: parseLimit(elements.tierMonthlyLimit.value, "每月"),
      permissions: {
        customProviders: elements.tierCustomProviders.checked,
        officialLogin: elements.tierOfficialLogin.checked,
        projectSharing: elements.tierProjectSharing.checked,
        codexSkills: elements.tierCodexSkills.checked,
        codexPlugins: elements.tierCodexPlugins.checked,
        codexApps: elements.tierCodexApps.checked,
        codexMcp: elements.tierCodexMcp.checked,
        codexMigration: elements.tierCodexMigration.checked,
        codexMemory: elements.tierCodexMemory.checked,
        codexBackground: elements.tierCodexBackground.checked,
        codexTerminal: elements.tierCodexTerminal.checked,
        codexWorkspaceMessages: elements.tierCodexWorkspaceMessages.checked,
        codexRemoteDiff: elements.tierCodexRemoteDiff.checked,
        codexFeedback: elements.tierCodexFeedback.checked,
        claudeRuntime: elements.tierClaudeRuntime.checked,
        claudeOfficialLogin: elements.tierClaudeOfficialLogin.checked,
        claudeProviders: elements.tierClaudeProviders.checked,
        claudeExtensions: elements.tierClaudeExtensions.checked,
        claudeMcp: elements.tierClaudeMcp.checked,
        claudeHooks: elements.tierClaudeHooks.checked,
        claudeMemory: elements.tierClaudeMemory.checked,
        claudeBackground: elements.tierClaudeBackground.checked,
        claudeWorktree: elements.tierClaudeWorktree.checked,
        claudeProxy: elements.tierClaudeProxy.checked,
        claudeStructuredOutput: elements.tierClaudeStructuredOutput.checked,
        claudeUltraReview: elements.tierClaudeUltraReview.checked,
        claudeProjectPurge: elements.tierClaudeProjectPurge.checked,
        claudeBetaHeaders: elements.tierClaudeBetaHeaders.checked,
      },
    };
    await api(state.editingTierId
      ? `/api/multi-user/tiers/${encodeURIComponent(state.editingTierId)}`
      : "/api/multi-user/tiers", {
      method: state.editingTierId ? "PUT" : "POST",
      action: state.editingTierId ? "multi-user-tier-update" : "multi-user-tier-create",
      body,
    });
    elements.tierDialog.close();
    await loadData();
    toast(state.editingTierId ? "套餐已更新" : "套餐已创建");
  } catch (error) {
    elements.tierError.textContent = error.message;
  } finally {
    elements.saveTierButton.disabled = false;
  }
}

async function removeTier() {
  const tier = state.policy?.tiers?.find((entry) => entry.id === state.editingTierId);
  if (!tier || !confirm(`删除套餐“${tier.name}”？`)) return;
  elements.removeTierButton.disabled = true;
  try {
    await api(`/api/multi-user/tiers/${encodeURIComponent(tier.id)}`, {
      method: "DELETE",
      action: "multi-user-tier-remove",
    });
    elements.tierDialog.close();
    await loadData();
    toast("套餐已删除");
  } catch (error) {
    elements.tierError.textContent = error.message;
  } finally {
    elements.removeTierButton.disabled = false;
  }
}

async function applySelectedTier() {
  const user = selectedUser();
  const tier = state.policy?.tiers?.find((entry) => entry.id === elements.userTierSelect.value);
  if (!user || !tier || !canManage(user)) return;
  let tierExpiresAt;
  try {
    tierExpiresAt = tierExpirationTimestamp(elements.userTierExpiresAt.value);
  } catch (error) {
    elements.editorError.textContent = error.message;
    return;
  }
  const expiration = tierExpirationLabel(tierExpiresAt);
  if (!confirm(`将“${tier.name}”的空间、权限、Token 和供应商设置应用给 ${user.displayName || user.username}？\n有效期：${expiration}`)) return;
  elements.applyTierButton.disabled = true;
  try {
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}/tier`, {
      method: "POST",
      action: "multi-user-tier-apply",
      body: { tierId: tier.id, tierExpiresAt },
    });
    await loadData();
    toast(`套餐已应用：${tier.name}`);
  } catch (error) {
    elements.editorError.textContent = error.message;
  } finally {
    elements.applyTierButton.disabled = false;
  }
}

async function saveSelectedUser(event) {
  event.preventDefault();
  const user = selectedUser();
  if (!user || !canManage(user)) return;
  elements.saveUserButton.disabled = true;
  try {
    const limits = readLimits();
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH", action: "multi-user-user-update", body: {
        ...(state.account.role === "owner" ? { role: elements.userRole.value } : {}),
        quotaBytes: Math.round(Number(elements.userQuota.value) * 1024 ** 3),
        permissions: {
          customProviders: elements.customProvidersPermission.checked,
          officialLogin: elements.officialLoginPermission.checked,
          projectSharing: elements.projectSharingPermission.checked,
          codexSkills: elements.codexSkillsPermission.checked,
          codexPlugins: elements.codexPluginsPermission.checked,
          codexApps: elements.codexAppsPermission.checked,
          codexMcp: elements.codexMcpPermission.checked,
          codexMigration: elements.codexMigrationPermission.checked,
          codexMemory: elements.codexMemoryPermission.checked,
          codexBackground: elements.codexBackgroundPermission.checked,
          codexTerminal: elements.codexTerminalPermission.checked,
          codexWorkspaceMessages: elements.codexWorkspaceMessagesPermission.checked,
          codexRemoteDiff: elements.codexRemoteDiffPermission.checked,
          codexFeedback: elements.codexFeedbackPermission.checked,
          claudeRuntime: elements.claudeRuntimePermission.checked,
          claudeOfficialLogin: elements.claudeOfficialLoginPermission.checked,
          claudeProviders: elements.claudeProvidersPermission.checked,
          claudeExtensions: elements.claudeExtensionsPermission.checked,
          claudeMcp: elements.claudeMcpPermission.checked,
          claudeHooks: elements.claudeHooksPermission.checked,
          claudeMemory: elements.claudeMemoryPermission.checked,
          claudeBackground: elements.claudeBackgroundPermission.checked,
          claudeWorktree: elements.claudeWorktreePermission.checked,
          claudeProxy: elements.claudeProxyPermission.checked,
          claudeStructuredOutput: elements.claudeStructuredOutputPermission.checked,
          claudeUltraReview: elements.claudeUltraReviewPermission.checked,
          claudeProjectPurge: elements.claudeProjectPurgePermission.checked,
          claudeBetaHeaders: elements.claudeBetaHeadersPermission.checked,
        },
        ...limits,
      },
    });
    await loadData(); toast("用户设置已保存");
  } catch (error) { elements.editorError.textContent = error.message; }
  finally { elements.saveUserButton.disabled = false; }
}

async function toggleSelectedUserStatus() {
  const user = selectedUser(); if (!user || !canManage(user)) return;
  const status = user.status === "active" ? "disabled" : "active";
  if (status === "disabled" && !confirm(`停用 ${user.displayName || user.username} 并结束其登录会话？`)) return;
  try {
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}`, { method: "PATCH", action: "multi-user-user-update", body: { status } });
    await loadData(); toast(status === "active" ? "账号已启用" : "账号已停用");
  } catch (error) { elements.editorError.textContent = error.message; }
}

async function assignProvider() {
  const user = selectedUser(); if (!user || !canManage(user)) return;
  const provider = state.providers.find((entry) => entry.id === elements.providerSelect.value);
  elements.assignProviderButton.disabled = true;
  try {
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}/provider`, {
      method: "POST", action: "multi-user-provider-assign", body: { providerId: elements.providerSelect.value, ...readLimits() },
    });
    await loadData(); toast(`对话 API 已分配：${provider?.name || "已保存"}`);
  } catch (error) { elements.editorError.textContent = error.message; }
  finally { elements.assignProviderButton.disabled = false; }
}

async function unassignProvider() {
  const user = selectedUser(); if (!user || !canManage(user)) return;
  if (!confirm(`取消 ${user.displayName || user.username} 的管理员供应商分配并恢复原 Codex 配置？`)) return;
  elements.unassignProviderButton.disabled = true;
  try {
    const result = await api(`/api/multi-user/users/${encodeURIComponent(user.id)}/provider`, {
      method: "DELETE", action: "multi-user-provider-unassign",
    });
    await loadData();
    toast(result.retainedForImage ? "对话分配已取消，供应商副本因生图配置而保留" : "供应商分配已取消");
  } catch (error) { elements.editorError.textContent = error.message; }
  finally { elements.unassignProviderButton.disabled = false; }
}

async function assignImageProvider() {
  const user = selectedUser(); if (!user || !canManage(user)) return;
  elements.editorError.textContent = "";
  if (!imageProviderAssignmentInputs().every((input) => input.reportValidity())) return;
  elements.assignImageProviderButton.disabled = true;
  try {
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}/image-provider`, {
      method: "POST", action: "multi-user-image-provider-assign", body: {
        providerId: elements.imageProviderSelect.value,
        model: elements.imageModelInput.value.trim(),
        preset: elements.imagePresetInput.value,
        defaults: {
          size: elements.imageSizeInput.value.trim(),
          quality: elements.imageQualityInput.value,
          outputFormat: elements.imageOutputFormatInput.value,
          outputCompression: Number(elements.imageOutputCompressionInput.value),
          background: elements.imageBackgroundInput.value,
          moderation: elements.imageModerationInput.value,
          n: Number(elements.imageResultCountInput.value),
          partialImages: Number(elements.imagePartialImagesInput.value),
        },
        limits: imageProviderLimitsDraft(),
      },
    });
    await loadData(); toast("图片供应商已分配");
  } catch (error) { elements.editorError.textContent = error.message; }
  finally { elements.assignImageProviderButton.disabled = false; }
}

function imageProviderAssignmentInputs() {
  return [
    elements.imageModelInput,
    elements.imagePresetInput,
    elements.imageSizeInput,
    elements.imageQualityInput,
    elements.imageOutputFormatInput,
    elements.imageOutputCompressionInput,
    elements.imageBackgroundInput,
    elements.imageModerationInput,
    elements.imageResultCountInput,
    elements.imagePartialImagesInput,
    elements.imageTimeoutInput,
    elements.imageMaxInputBytesPerImageInput,
    elements.imageMaxInputBytesTotalInput,
    elements.imageMaxOutputBytesPerImageInput,
    elements.imageMaxResponseBytesInput,
  ];
}

function imageProviderLimitsDraft() {
  return Object.fromEntries([
    ["timeoutMs", elements.imageTimeoutInput],
    ["maxInputBytesPerImage", elements.imageMaxInputBytesPerImageInput],
    ["maxInputBytesTotal", elements.imageMaxInputBytesTotalInput],
    ["maxOutputBytesPerImage", elements.imageMaxOutputBytesPerImageInput],
    ["maxResponseBytes", elements.imageMaxResponseBytesInput],
  ].flatMap(([key, input]) => input.value === "" ? [] : [[key, Number(input.value)]]));
}

function optionalIntegerValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
}

async function unassignImageProvider() {
  const user = selectedUser(); if (!user || !canManage(user)) return;
  if (!confirm(`取消 ${user.displayName || user.username} 的图片供应商配置？`)) return;
  elements.unassignImageProviderButton.disabled = true;
  try {
    await api(`/api/multi-user/users/${encodeURIComponent(user.id)}/image-provider`, {
      method: "DELETE", action: "multi-user-image-provider-unassign",
    });
    await loadData(); toast("图片供应商配置已取消");
  } catch (error) { elements.editorError.textContent = error.message; }
  finally { elements.unassignImageProviderButton.disabled = false; }
}

function openInviteDialog() {
  elements.inviteForm.reset(); elements.inviteResult.hidden = true; elements.inviteError.textContent = "";
  elements.inviteRole.querySelector('option[value="admin"]').disabled = state.account.role !== "owner";
  elements.inviteTier.replaceChildren(...(state.policy?.tiers || []).map((tier) => dataOption(tier.name, tier.id)));
  elements.inviteTier.value = state.policy?.defaultTierId || state.policy?.tiers?.[0]?.id || "";
  elements.inviteProvider.replaceChildren(...providerOptions("不分配供应商", true));
  elements.inviteProvider.value = state.policy?.defaultProviderId || "";
  updateInviteTier({ preserveProvider: true });
  elements.inviteDialog.showModal();
}

function updateInviteTier({ preserveProvider = false } = {}) {
  const tier = state.policy?.tiers?.find((entry) => entry.id === elements.inviteTier.value);
  const member = elements.inviteRole.value === "member";
  elements.inviteTier.disabled = !member;
  elements.inviteProvider.disabled = !member;
  if (member && !preserveProvider) elements.inviteProvider.value = tier?.providerId || state.policy?.defaultProviderId || "";
  setDataContent(elements.inviteTierSummary, member && tier ? tierSummary({
    ...tier,
    providerName: elements.inviteProvider.selectedOptions[0]?.textContent || null,
    permissions: state.policy?.defaultPermissions || tier.permissions,
  }) : "管理员账号使用独立配置，不自动分配普通用户套餐与供应商");
}

async function createInvite(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault(); elements.createInviteButton.disabled = true;
  try {
    const data = await api("/api/multi-user/invites", { method: "POST", action: "multi-user-invite", body: {
      role: elements.inviteRole.value,
      tierId: elements.inviteTier.value,
      providerId: elements.inviteRole.value === "member" ? elements.inviteProvider.value || null : null,
      permissions: state.policy?.defaultPermissions,
      expiresHours: Number(elements.inviteHours.value),
    } });
    const url = new URL("/login.html", location.origin); url.searchParams.set("invite", data.invite.token);
    setDataContent(elements.inviteUrl, url.href); elements.inviteResult.hidden = false; toast("邀请已生成");
  } catch (error) { elements.inviteError.textContent = error.message; }
  finally { elements.createInviteButton.disabled = false; }
}

async function copyInvite() { await navigator.clipboard.writeText(elements.inviteUrl.textContent); toast("邀请链接已复制"); }

function openModeDialog() {
  elements.modeForm.reset(); elements.modeError.textContent = "";
  elements.modeDialogTitle.textContent = state.mode?.enabled ? "关闭多用户" : "启用多用户";
  elements.confirmModeButton.textContent = state.mode?.enabled ? "确认关闭" : "确认启用";
  elements.confirmModeButton.classList.toggle("danger-button", state.mode?.enabled === true);
  elements.modeDialog.showModal();
}

async function updateAccountMode(event) {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault(); elements.confirmModeButton.disabled = true;
  const enabled = state.mode?.enabled === true;
  try {
    if (enabled && !confirm("关闭后普通用户会立即退出，账号和文件保留。确认继续？")) return;
    await api(enabled ? "/api/multi-user/disable" : "/api/multi-user/enable", {
      method: "POST", action: enabled ? "multi-user-disable" : "multi-user-enable", body: { password: elements.modePassword.value },
    });
    elements.modePassword.value = ""; elements.modeDialog.close();
    if (enabled) location.replace("/"); else { await loadData(); toast("多用户已启用"); }
  } catch (error) { elements.modeError.textContent = error.message; }
  finally { elements.modePassword.value = ""; elements.confirmModeButton.disabled = false; }
}

async function createShare() {
  elements.createShareButton.disabled = true;
  try {
    await api("/api/multi-user/shares", { method: "POST", action: "multi-user-project-share", body: {
      projectPath: elements.shareProject.value, targetUserId: elements.shareTarget.value, access: elements.shareAccess.value,
    } });
    await loadData(); toast("工程已共享");
  } catch (error) { showError(error.message); }
  finally { elements.createShareButton.disabled = false; }
}

async function removeShare(id) {
  try { await api(`/api/multi-user/shares/${encodeURIComponent(id)}`, { method: "DELETE", action: "multi-user-project-unshare" }); await loadData(); toast("共享已撤销"); }
  catch (error) { showError(error.message); }
}

function updateShareAccess() {
  const user = state.users.find((entry) => entry.id === elements.shareTarget.value);
  const write = [...elements.shareAccess.options].find((option) => option.value === "write");
  if (write) write.disabled = user?.quotaMode !== "filesystem";
  if (write?.disabled && elements.shareAccess.value === "write") elements.shareAccess.value = "read";
}

function readLimits() {
  return {
    fiveHourTokenLimit: parseLimit(elements.fiveHourLimit.value, "5 小时"),
    weeklyTokenLimit: parseLimit(elements.weeklyLimit.value, "每周"),
    monthlyTokenLimit: parseLimit(elements.monthlyLimit.value, "每月"),
  };
}
function parseLimit(value, label) { const text = String(value).trim(); if (!text) return null; const limit = Math.round(Number(text) * 10_000); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1e12) throw new Error(`${label}限额必须在 1 到 1 万亿 Token 之间`); return limit; }
function setLimitInput(input, limit) { input.value = Number.isSafeInteger(limit) ? String(limit / 10_000) : ""; }
function renderUsage(element, usage) { element.textContent = usage?.available ? formatTokens(usage.totalTokens) : usage?.reportingStatus === "idle" ? "0" : "未上报"; }
function canManage(user) { return user.role !== "owner" && (state.account.role === "owner" || user.role === "member"); }
function canManageThreadLimit(user) {
  return state.policy?.canManageCodexThreadLimit === true
    && (state.account.role === "owner" || user.role === "member" || user.id === state.account.id);
}
function selectedUser() { return state.users.find((user) => user.id === state.selectedId) || null; }
function avatarText(user) { return String(user.displayName || user.username || "U").trim().slice(0, 1).toUpperCase(); }
function roleLabel(role) { return { owner: "所有者", admin: "管理员", member: "普通用户" }[role] || role; }
function providerOptions(emptyLabel, includePolicy = false) {
  const providers = new Map(state.providers.map((provider) => [provider.id, provider.name]));
  if (includePolicy && state.policy) {
    if (state.policy.defaultProviderId) providers.set(state.policy.defaultProviderId, state.policy.defaultProviderName || "默认供应商");
    for (const tier of state.policy.tiers || []) {
      if (tier.providerId) providers.set(tier.providerId, tier.providerName || "套餐供应商");
    }
  }
  return [new Option(emptyLabel, ""), ...[...providers].map(([id, name]) => dataOption(name, id))];
}
function tierSummary(tier) {
  const limits = [tier.fiveHourTokenLimit, tier.weeklyTokenLimit, tier.monthlyTokenLimit]
    .map((limit) => Number.isSafeInteger(limit) ? formatTokens(limit) : "不限")
    .join(" / ");
  const provider = tier.providerName || "不分配供应商";
  const permissions = [
    tier.permissions?.customProviders ? "自定义 API" : null,
    tier.permissions?.officialLogin ? "官方登录" : null,
    tier.permissions?.projectSharing ? "工程共享" : null,
    tier.permissions?.codexSkills ? "Skills" : null,
    tier.permissions?.codexPlugins ? "Plugins" : null,
    tier.permissions?.codexApps ? "Apps" : null,
    tier.permissions?.codexMcp ? "MCP" : null,
    tier.permissions?.codexMigration ? "Agent 迁移" : null,
    tier.permissions?.codexMemory ? "Memories" : null,
    tier.permissions?.codexBackground ? "后台任务" : null,
    tier.permissions?.codexTerminal ? "Terminal" : null,
    tier.permissions?.codexWorkspaceMessages ? "工作区消息" : null,
    tier.permissions?.codexRemoteDiff ? "远端 Git" : null,
    tier.permissions?.codexFeedback ? "官方反馈" : null,
    tier.permissions?.claudeRuntime ? "Claude" : null,
    tier.permissions?.claudeOfficialLogin ? "Claude 登录" : null,
    tier.permissions?.claudeProviders ? "Claude API" : null,
    tier.permissions?.claudeExtensions ? "Claude 扩展" : null,
    tier.permissions?.claudeMcp ? "Claude MCP" : null,
    tier.permissions?.claudeHooks ? "Claude Hooks" : null,
    tier.permissions?.claudeMemory ? "Claude Memory" : null,
    tier.permissions?.claudeBackground ? "Claude 后台" : null,
    tier.permissions?.claudeWorktree ? "Claude Worktree" : null,
    tier.permissions?.claudeProxy ? "Claude 代理" : null,
    tier.permissions?.claudeStructuredOutput ? "结构化输出" : null,
    tier.permissions?.claudeUltraReview ? "Ultra Review" : null,
    tier.permissions?.claudeProjectPurge ? "工程清理" : null,
    tier.permissions?.claudeBetaHeaders ? "Beta Header" : null,
  ]
    .filter(Boolean).join("、") || "基础权限";
  return `${formatBytes(tier.quotaBytes)} · Token ${limits} · ${provider} · ${permissions}`;
}
function localDateInputValue(timestamp) {
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function tierExpirationTimestamp(value, { allowInvalid = false } = {}) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999)
    : null;
  const timestamp = date?.getTime() ?? NaN;
  const componentsMatch = Boolean(match && date
    && date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3]));
  if (!componentsMatch || !Number.isFinite(timestamp) || timestamp <= Date.now()) {
    if (allowInvalid) return NaN;
    throw new Error("套餐到期日期必须是今天或之后，留空表示长期有效");
  }
  return timestamp;
}
function tierExpirationLabel(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return "长期有效";
  if (!Number.isFinite(timestamp)) return "到期日期无效";
  const date = new Intl.DateTimeFormat(interfaceLocale(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
  return timestamp <= Date.now() ? `已于 ${date} 到期` : `有效期至 ${date}`;
}
function formatTokens(value) { if (!Number.isSafeInteger(value)) return "--"; if (interfaceLocale() === "en-US") return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value); if (value >= 1e8) return `${(value / 1e8).toFixed(1).replace(/\.0$/, "")} 亿`; if (value >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, "")} 万`; return value.toLocaleString("zh-CN"); }
function formatBytes(value) { if (!Number.isFinite(value)) return "--"; if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`; return `${Math.round(value / 1024)} KB`; }

async function api(url, { method = "GET", action, body } = {}) {
  const headers = {};
  if (action) headers["X-Codex-Desktop-Action"] = action;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  if (response.status === 401) { location.replace(`/login.html?next=${encodeURIComponent(embeddedInOps ? "/ops#users" : "/users")}`); throw new Error("请先登录"); }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
function showError(message) { elements.errorMessage.textContent = message; elements.errorBanner.hidden = false; }
function hideError() { elements.errorBanner.hidden = true; }
let toastTimer;
function toast(message) { clearTimeout(toastTimer); elements.toast.textContent = message; elements.toast.hidden = false; toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600); }
function applyTheme() {
  const parentTheme = embeddedInOps && window.parent !== window
    ? window.parent.document.documentElement.dataset.theme
    : null;
  const stored = localStorage.getItem("codexDesktop.theme");
  document.documentElement.dataset.theme = parentTheme || stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function toggleTheme() { const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; localStorage.setItem("codexDesktop.theme", next); }
