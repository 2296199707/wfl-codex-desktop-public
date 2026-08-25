const state = { data: null, previewTimer: null, apkTimer: null, dependencyTimer: null, previewStatus: null };
const $ = (id) => document.getElementById(id);

await load();
$("mobileConfigForm").addEventListener("submit", saveConfig);
$("scanFlutterButton").addEventListener("click", loadFlutterPaths);
$("prepareFlutterButton").addEventListener("click", prepareFlutter);
$("preparePubButton").addEventListener("click", preparePub);
$("startPreviewButton").addEventListener("click", startPreview);
$("stopPreviewButton").addEventListener("click", stopPreview);
$("openPreviewButton").addEventListener("click", () => state.data?.preview?.url && window.open(state.data.preview.url, "_blank", "noopener,noreferrer"));
$("prepareJavaButton").addEventListener("click", prepareJava);
$("signingForm").addEventListener("submit", saveSigning);
$("apkBuildForm").addEventListener("submit", buildApk);
$("terminateApkButton").addEventListener("click", terminateApk);
async function load() {
  try {
    const response = await fetch(`/api/tools/mobile-app/status?_=${Date.now()}`, { cache: "no-store" });
    state.data = await json(response);
    render();
  } catch (error) { setText("mobileConfigStatus", error.message); }
}

async function saveConfig(event) {
  event.preventDefault();
  try {
    const response = await request("/api/tools/mobile-app/config", "PUT", "mobile-app-config-save", { projectPath: $("mobileProjectPath").value.trim(), storageRoot: $("mobileStorageRoot").value.trim(), flutterBin: $("mobileFlutterBin").value.trim() || null });
    state.data = { ...state.data, config: response.config, layout: response.layout };
    setText("mobileConfigStatus", "已保存，后续依赖和构建使用新目录");
    render();
  } catch (error) { setText("mobileConfigStatus", error.message); }
}

async function loadFlutterPaths() {
  try {
    await load();
    setText("mobileConfigStatus", "已扫描服务器上的可用 Flutter SDK；选择后保存位置");
  } catch (error) { setText("mobileConfigStatus", error.message); }
}

async function prepareFlutter() { await mutate("/api/tools/mobile-app/dependencies/flutter/prepare", "mobile-app-flutter-prepare", "Flutter SDK 准备已启动"); }
async function preparePub() { await mutate("/api/tools/mobile-app/dependencies/pub/prepare", "mobile-app-pub-prepare", "Pub 依赖准备已启动"); }
async function prepareJava() { await mutate("/api/tools/mobile-app/apk/dependencies/install", "mobile-app-apk-dependency-install", "Java 依赖准备已启动"); }

async function mutate(url, action, message) {
  try { await request(url, "POST", action, {}); setText("previewDetail", message); await load(); scheduleDependencyPoll(); }
  catch (error) { setText("previewDetail", error.message); }
}

async function startPreview() {
  try {
    const response = await request("/api/tools/mobile-app/preview/start", "POST", "mobile-app-preview-start", {});
    state.data = { ...state.data, preview: response.preview };
    render();
    pollPreview();
  } catch (error) { setText("previewDetail", error.message); }
}

async function stopPreview() {
  const sessionId = state.data?.preview?.sessionId;
  if (!sessionId) return;
  try { const response = await request("/api/tools/mobile-app/preview/stop", "POST", "mobile-app-preview-stop", { sessionId }); state.data.preview = response.preview; render(); }
  catch (error) { setText("previewDetail", error.message); }
}

async function saveSigning(event) {
  event.preventDefault();
  try {
    const response = await request("/api/tools/mobile-app/apk/signing-profiles", "POST", "mobile-app-apk-signing-profile-save", { id: $("signingId").value.trim(), alias: $("signingAlias").value.trim(), password: $("signingPassword").value, keystorePath: $("signingKeystore").value.trim() || null });
    $("signingPassword").value = "";
    state.data.apk.signing = response.signing;
    setText("signingStatus", "签名配置已保存");
    render();
  } catch (error) { setText("signingStatus", error.message); }
}

async function buildApk(event) {
  event.preventDefault();
  const profile = $("signingProfile").value;
  if (!profile || !confirm("确认开始 Android APK 构建？构建会占用服务器资源。")) return;
  try {
    await request("/api/tools/mobile-app/apk/build", "POST", "mobile-app-apk-build", { projectPath: state.data.config.projectPath, gradleTask: $("gradleTask").value, signingProfileId: profile, outputPath: $("apkOutput").value.trim(), confirm: true });
    setText("apkDetail", "构建任务已启动");
    pollApk();
  } catch (error) { setText("apkDetail", error.message); }
}

async function terminateApk() {
  const operationId = state.data?.apk?.job?.operationId;
  if (!operationId || !confirm("确认终止当前 APK 构建？")) return;
  try { await request("/api/tools/mobile-app/apk/terminate", "POST", "mobile-app-apk-terminate", { operationId, confirm: true }); pollApk(); }
  catch (error) { setText("apkDetail", error.message); }
}

function pollPreview() { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(async () => { await load(); if (["starting", "running"].includes(state.data?.preview?.status)) pollPreview(); }, 2000); }
function pollApk() { clearTimeout(state.apkTimer); state.apkTimer = setTimeout(async () => { await load(); if (["queued", "running"].includes(state.data?.apk?.job?.status)) pollApk(); }, 2000); }
function scheduleDependencyPoll() {
  clearTimeout(state.dependencyTimer);
  const dependencies = state.data?.dependencies || {};
  const busy = [dependencies.flutter?.status, dependencies.pub?.status].some((status) => ["queued", "running", "installing"].includes(status));
  if (!busy) return;
  state.dependencyTimer = setTimeout(async () => { await load(); scheduleDependencyPoll(); }, 2000);
}

function render() {
  const data = state.data || {};
  $("mobileProjectPath").value = data.config?.projectPath || "";
  $("mobileStorageRoot").value = data.config?.storageRoot || "";
  $("mobileFlutterBin").value = data.config?.flutterBin || data.dependencies?.selectedFlutterBin || "";
  const deps = data.dependencies || {};
  const flutterReady = deps.flutter?.status === "ready" && Boolean(deps.flutter?.command);
  const flutterAvailable = deps.flutter?.status === "available" && Boolean(deps.flutter?.command);
  const flutterBusy = ["queued", "running", "installing"].includes(deps.flutter?.status);
  const pubReady = deps.pub?.status === "ready";
  const pubBusy = ["queued", "running", "installing"].includes(deps.pub?.status);
  setStatus("flutterDependency", deps.flutter?.status === "ready" ? deps.flutter.version || "已就绪" : flutterAvailable ? "已发现，请点击准备验证" : deps.flutter?.detail || "未准备");
  const flutterProgress = $("flutterDependencyProgress");
  flutterProgress.hidden = !flutterBusy && !flutterReady;
  flutterProgress.value = Math.max(0, Math.min(1, Number(deps.flutter?.progress) || 0));
  setStatus("pubDependency", deps.pub?.status === "ready" ? "已就绪" : deps.pub?.error ? (deps.pub?.detail || "依赖准备失败") + "：" + deps.pub.error : deps.pub?.detail || "未准备");
  setStatus("javaDependency", data.apk?.dependency?.status === "ready" ? "已就绪" : data.apk?.dependency?.detail || "未准备");
  setText("apkDirectory", data.layout?.apk || "--");
  const pathOptions = (deps.flutterPaths || []).map((entry) => new Option(`${entry.path}${entry.version ? ` · ${entry.version}` : ""}`, entry.path));
  $("mobileFlutterPathOptions").replaceChildren(...pathOptions);
  $("prepareFlutterButton").disabled = flutterReady || flutterBusy;
  $("prepareFlutterButton").textContent = flutterBusy ? "正在准备 Flutter…" : flutterReady ? "Flutter SDK 已就绪" : flutterAvailable ? "验证 Flutter SDK" : "准备 Flutter SDK";
  $("preparePubButton").disabled = !flutterReady || pubReady || pubBusy;
  $("preparePubButton").textContent = pubBusy ? "正在准备 Pub…" : pubReady ? "Pub 缓存已就绪" : "准备 Pub 依赖";
  const preview = data.preview || {};
  const previousPreviewStatus = state.previewStatus;
  state.previewStatus = preview.status || "idle";
  setStatus("previewStatus", preview.detail || preview.status || "未启动");
  if (preview.error || preview.status === "failed") setText("previewDetail", preview.error || preview.detail);
  const previewReady = Boolean(preview.url && preview.status === "running");
  $("previewPlaceholder").hidden = previewReady;
  if (!previewReady && $("mobilePreviewFrame").src !== "about:blank") $("mobilePreviewFrame").src = "about:blank";
  if (previewReady && $("mobilePreviewFrame").src !== new URL(preview.url, location.origin).href) $("mobilePreviewFrame").src = preview.url;
  if (preview.url && previousPreviewStatus === "starting" && state.previewStatus === "running") $("mobilePreviewFrame").src = `${preview.url}?ready=${Date.now()}`;
  $("stopPreviewButton").disabled = !["starting", "running"].includes(preview.status);
  $("openPreviewButton").disabled = !previewReady;
  $("startPreviewButton").disabled = (["starting", "running"].includes(preview.status) && preview.deliveryMode === "static") || !flutterReady;
  setStatus("apkStatus", data.apk?.job?.detail || data.apk?.job?.status || "未执行");
  setText("apkDetail", data.apk?.job?.error || data.apk?.job?.detail || "");
  $("terminateApkButton").hidden = !["queued", "running"].includes(data.apk?.job?.status);
  const profiles = data.apk?.signing?.profiles || [];
  const select = $("signingProfile");
  select.replaceChildren(...(profiles.length ? profiles.map((profile) => new Option(`${profile.alias} (${profile.id})`, profile.id)) : [new Option("请先保存配置", "")]));
  const artifact = data.apk?.job?.artifact;
  $("apkDownload").hidden = !artifact?.relativePath;
  if (artifact?.relativePath) { $("apkDownload").href = "/api/tools/mobile-app/apk/download"; $("apkDownload").textContent = `下载 ${artifact.filename || "APK"}`; }
  scheduleDependencyPoll();
}

async function request(url, method, action, body) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": action }, body: JSON.stringify(body) });
  return json(response);
}
async function json(response) { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`); return data; }
function setText(id, value) { $(id).textContent = value || ""; }
function setStatus(id, value) { $(id).textContent = value || "--"; $(id).dataset.state = value === "已就绪" ? "ready" : ""; }
