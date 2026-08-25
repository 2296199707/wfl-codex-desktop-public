const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const APP_APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);
const APP_REVIEWERS = new Set(["user", "auto_review"]);
const APP_SETTING_KEYS = new Set([
  "enabled",
  "destructiveEnabled",
  "openWorldEnabled",
  "approvalsReviewer",
  "defaultToolsApprovalMode",
]);
const NATIVE_APP_SETTING_KEYS = new Set([
  "enabled",
  "destructive_enabled",
  "open_world_enabled",
  "approvals_reviewer",
  "default_tools_approval_mode",
]);

export function normalizeCodexAppId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!APP_ID_PATTERN.test(id)) {
    throw new Error("Codex App ID 需为 1–128 位字母、数字、下划线或连字符");
  }
  return id;
}

export function normalizeCodexAppInstallUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Codex App 没有可用的官方安装地址");
  }
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "chatgpt.com"
    || !url.pathname.startsWith("/apps/")
    || url.username
    || url.password
  ) {
    throw new Error("Codex App 安装地址不在允许的官方范围内");
  }
  url.hash = "";
  return url.href;
}

export function codexAppInstallUrlFromRead(result, appId) {
  const id = normalizeCodexAppId(appId);
  const app = Array.isArray(result?.apps)
    ? result.apps.find((entry) => entry?.id === id)
    : null;
  if (!app) throw new Error("Codex App 不存在或当前账号不可见");
  return {
    app,
    installUrl: normalizeCodexAppInstallUrl(app.installUrl),
  };
}

export function userCodexAppsConfig(configRead) {
  const layers = Array.isArray(configRead?.layers) ? configRead.layers : [];
  const userLayer = layers.find((layer) => (
    layer?.name?.type === "user"
    && layer.name.profile == null
    && isRecord(layer.config)
  ));
  return {
    apps: isRecord(userLayer?.config?.apps) ? structuredClone(userLayer.config.apps) : {},
    version: typeof userLayer?.version === "string" ? userLayer.version : null,
    filePath: typeof userLayer?.name?.file === "string" ? userLayer.name.file : null,
  };
}

export function publicCodexAppsConfig(configRead) {
  const current = userCodexAppsConfig(configRead);
  const apps = {};
  for (const [id, value] of Object.entries(current.apps).slice(0, 512)) {
    if (id === "_default") continue;
    if (!APP_ID_PATTERN.test(id) || !isRecord(value)) continue;
    apps[id] = publicAppSettings(value);
  }
  return {
    version: current.version,
    defaults: publicAppSettings(current.apps._default),
    apps,
  };
}

export function updateCodexAppSettings(nativeApps, appId, draft) {
  const id = normalizeCodexAppId(appId);
  if (!isRecord(draft) || Object.keys(draft).some((key) => !APP_SETTING_KEYS.has(key))) {
    throw new Error("Codex App 设置包含未知字段");
  }
  const apps = isRecord(nativeApps) ? structuredClone(nativeApps) : {};
  const existing = isRecord(apps[id]) ? apps[id] : {};
  const next = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !NATIVE_APP_SETTING_KEYS.has(key)),
  );
  setOptionalBoolean(next, "enabled", draft.enabled);
  setOptionalBoolean(next, "destructive_enabled", draft.destructiveEnabled);
  setOptionalBoolean(next, "open_world_enabled", draft.openWorldEnabled);
  setOptionalEnum(next, "approvals_reviewer", draft.approvalsReviewer, APP_REVIEWERS, "审批审核者");
  setOptionalEnum(
    next,
    "default_tools_approval_mode",
    draft.defaultToolsApprovalMode,
    APP_APPROVAL_MODES,
    "工具审批模式",
  );
  if (Object.keys(next).length) apps[id] = next;
  else delete apps[id];
  return apps;
}

function publicAppSettings(value) {
  const settings = isRecord(value) ? value : {};
  return {
    enabled: booleanOrNull(settings.enabled),
    destructiveEnabled: booleanOrNull(settings.destructive_enabled),
    openWorldEnabled: booleanOrNull(settings.open_world_enabled),
    approvalsReviewer: APP_REVIEWERS.has(settings.approvals_reviewer)
      ? settings.approvals_reviewer
      : null,
    defaultToolsApprovalMode: APP_APPROVAL_MODES.has(settings.default_tools_approval_mode)
      ? settings.default_tools_approval_mode
      : null,
  };
}

function setOptionalBoolean(target, key, value) {
  if (value == null || value === "") return;
  if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值或继承`);
  target[key] = value;
}

function setOptionalEnum(target, key, value, allowed, label) {
  if (value == null || value === "") return;
  if (!allowed.has(value)) throw new Error(`${label}无效`);
  target[key] = value;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
