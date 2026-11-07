const element = (id) => document.getElementById(id);
const directMode = document.body.dataset.mode === "direct";
const accessMode = directMode || document.body.dataset.mode === "access";
const directAccessKey = directMode ? new URL(location.href).hash.slice(1) : "";
const state = { socket: null, ready: false, targets: [], grants: [], lastAccessKey: "", lastGrantId: "", busy: false,
  lastDirectLink: "", lastDirectGrantId: "",
  generation: 0, settingsLoaded: false, resumeToken: "", fileToken: "", reconnectTimer: null,
  reconnectDeadline: 0, reconnectAttempts: 0, resumeGraceMs: 300_000, connectionTarget: null,
  directory: ".", parentDirectory: ".", fileRequestId: 0, upload: null, cancelUpload: false };
const terminal = new window.Terminal({
  cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
  theme: { background: "#101722", foreground: "#e4edf7", cursor: "#78b4ff" },
});
const fit = new window.FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(element("terminal"));
fit.fit();
terminal.writeln("WFL 网页 SSH · 连接后在远程服务器执行命令");
terminal.onData(sendInput);
terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
const resizeObserver = new ResizeObserver(() => { if (element("terminal").clientWidth) fit.fit(); });
resizeObserver.observe(element("terminal"));
element("disconnectButton").addEventListener("click", disconnect);
element("directoryForm").addEventListener("submit", (event) => {
  event.preventDefault(); void loadFiles(element("remoteDirectory").value);
});
element("parentDirectoryButton").addEventListener("click", () => void loadFiles(state.parentDirectory));
element("uploadForm").addEventListener("submit", (event) => { event.preventDefault(); void uploadFiles(); });
element("cancelUploadButton").addEventListener("click", cancelUpload);
element("downloadForm").addEventListener("submit", (event) => {
  event.preventDefault(); void downloadFile(element("remoteDownloadPath").value);
});
window.addEventListener("online", wakeReconnect);
document.addEventListener("visibilitychange", () => { if (!document.hidden) wakeReconnect(); });
element("copySelectionButton").addEventListener("click", () => void copy(terminal.getSelection()));
element("pasteButton").addEventListener("click", async () => {
  try { sendInput(await navigator.clipboard.readText()); terminal.focus(); }
  catch { showStatus("浏览器未允许读取剪贴板，请在终端使用系统粘贴。", true); }
});
const keys = { "ctrl-c": "\x03", "ctrl-d": "\x04", escape: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" };
for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("click", () => { sendInput(keys[button.dataset.key]); terminal.focus(); });
}
if (directMode) {
  element("connectButton").addEventListener("click", () => void connect());
  window.addEventListener("hashchange", () => location.reload());
  if (/^[A-Za-z0-9_-]{64}$/u.test(directAccessKey)) await connect();
  else {
    element("connectButton").disabled = true;
    element("connectionStatus").textContent = "缺少有效的直达链接";
    showStatus("请使用管理员生成的完整直达链接打开终端。", true);
  }
} else if (accessMode) {
  element("accessForm").addEventListener("submit", (event) => { event.preventDefault(); void connect(); });
} else {
  element("connectButton").addEventListener("click", () => void connect());
  element("refreshButton").addEventListener("click", () => void loadSettings());
  element("targetSelect").addEventListener("change", renderTarget);
  element("targetForm").addEventListener("submit", saveTarget);
  element("grantForm").addEventListener("submit", createGrant);
  element("directGrantForm").addEventListener("submit", createDirectGrant);
  element("copyDirectLinkButton").addEventListener("click", () => void copy(state.lastDirectLink));
  element("deleteTargetButton").addEventListener("click", deleteTarget);
  element("authMode").addEventListener("change", () => {
    const privateKey = element("authMode").value === "private-key";
    element("privateKeyFields").hidden = !privateKey;
    element("passwordField").hidden = privateKey;
  });
  element("showAccessKey").addEventListener("change", () => {
    element("newAccessKey").type = element("showAccessKey").checked ? "text" : "password";
  });
  element("copyInvitationButton").addEventListener("click", () => void copy(
    `SSH 登录页面：${element("shareLink").value}\n访问密钥：${state.lastAccessKey}`,
  ));
  await loadSettings();
}

async function request(path, { action, body, method = "POST" } = {}) {
  const response = await fetch(path, {
    method, cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(40_000),
    credentials: accessMode ? "omit" : "same-origin",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(action ? { "X-Codex-Desktop-Action": action } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (!accessMode && response.status === 401) location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return result;
}

async function loadSettings(preferred = null) {
  try {
    const result = await request("/api/tools/web-ssh/status", { method: "GET" });
    state.targets = [
      ...result.targets.map((target) => ({ ...target, kind: "saved", terminalAvailable: true })),
      ...result.persistent.map((target) => ({ ...target, kind: "persistent" })),
    ];
    state.grants = result.grants;
    const previous = preferred || element("targetSelect").value;
    element("targetSelect").replaceChildren(new Option("请选择服务器", ""),
      ...state.targets.map((target) => {
        const option = new Option(`${target.name}${target.terminalAvailable ? target.kind === "persistent" ? "（持久 SSH）" : "" : "（AI 专用，需另配终端凭据）"}`, referenceValue(target));
        option.disabled = !target.terminalAvailable;
        return option;
      }));
    const requested = new URLSearchParams(location.search).get("server");
    const requestedTarget = state.targets.find((target) => target.kind === "persistent" && target.id === requested);
    const desired = previous || (requested ? `persistent:${requested}` : referenceValue(state.targets.find((target) => target.terminalAvailable)));
    const preferredTarget = state.targets.find((target) => referenceValue(target) === desired);
    element("targetSelect").value = preferredTarget?.terminalAvailable ? referenceValue(preferredTarget) : "";
    renderTarget();
    renderGrants();
    if (!selectedTarget()) element("serverEditor").open = true;
    if (!state.settingsLoaded && requestedTarget && !requestedTarget.terminalAvailable) {
      element("serverEditor").open = true;
      for (const field of ["name", "host", "port", "username"]) element("targetForm").elements[field].value = requestedTarget[field];
      showStatus("此持久 SSH 使用禁止交互终端的 AI 专用公钥。请在本页添加服务器的密码或可用于终端的私钥；不会修改原 AI 授权。");
    }
    state.settingsLoaded = true;
  } catch (error) { showStatus(error.message, true); }
}

function selectedTarget() {
  return state.targets.find((target) => referenceValue(target) === element("targetSelect")?.value);
}

function referenceValue(target) {
  return target ? `${target.kind}:${target.id}` : "";
}

function reference(target) {
  if (!target) throw new Error("请先添加或选择一台服务器");
  return { kind: target.kind, id: target.id };
}

function renderTarget() {
  const target = selectedTarget();
  element("targetDescription").textContent = target
    ? `${target.username}@${target.host}:${target.port} · ${target.hostKeyFingerprint}` : "先添加服务器，或选择持久 SSH 插件中已保存的服务器。";
  element("connectButton").disabled = !target?.terminalAvailable || state.busy;
  element("createGrantButton").disabled = !target?.terminalAvailable || state.busy;
  element("createDirectGrantButton").disabled = !target?.terminalAvailable || state.busy;
  element("deleteTargetButton").disabled = !target || target.kind !== "saved" || state.busy;
}

async function connect() {
  if (state.busy) return;
  if ((state.ready || state.resumeToken) && !confirm("当前终端仍在使用。断开它并打开所选服务器的新终端？")) return;
  disconnect();
  const generation = state.generation;
  state.busy = true;
  element("connectButton").disabled = true;
  element("disconnectButton").disabled = false;
  element("connectionStatus").textContent = "正在获取连接授权…";
  showStatus("");
  try {
    const result = accessMode
      ? await request(directMode ? "/api/tools/web-ssh/access/links/sessions" : "/api/tools/web-ssh/access/sessions", {
        action: "web-ssh-access", body: { accessKey: directMode ? directAccessKey : element("accessKeyInput").value },
      })
      : await request("/api/tools/web-ssh/sessions", { action: "web-ssh-connect", body: { reference: reference(selectedTarget()) } });
    if (state.generation !== generation) return;
    terminal.reset();
    fit.fit();
    element("terminalTitle").textContent = result.target.name;
    element("connectionStatus").textContent = `正在连接 ${result.target.username}@${result.target.host}:${result.target.port}…`;
    state.connectionTarget = result.target;
    openSocket(result, generation);
  } catch (error) {
    if (state.generation !== generation) return;
    state.busy = false;
    element("connectButton").disabled = false;
    element("disconnectButton").disabled = true;
    element("connectionStatus").textContent = "连接失败";
    showStatus(error.message, true);
  } finally {
    if (accessMode && !directMode && state.generation === generation) element("accessKeyInput").value = "";
  }
}

function openSocket(result, generation, resume = false) {
  const url = new URL("/ssh/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  const deadline = setTimeout(() => { if (state.socket === socket && !state.ready) socket.close(); }, 15_000);
  socket.addEventListener("open", () => {
    if (state.socket !== socket || state.generation !== generation) { socket.close(); return; }
    socket.send(JSON.stringify({ ...(resume ? { type: "resume", resumeToken: state.resumeToken }
      : { type: "authenticate", ticket: result.ticket }), cols: terminal.cols, rows: terminal.rows }));
  });
  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    if (typeof event.data !== "string") {
      const data = new Uint8Array(event.data);
      terminal.write(data, () => { if (state.socket === socket) send({ type: "ack", bytes: data.byteLength }); });
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === "ready") {
      clearTimeout(deadline);
      state.ready = true;
      state.busy = false;
      state.resumeToken = message.resumeToken || "";
      state.fileToken = message.fileToken || "";
      state.resumeGraceMs = message.resumeGraceMs || 300_000;
      state.reconnectDeadline = 0;
      state.reconnectAttempts = 0;
      element("connectionStatus").textContent = `已连接 ${result.target.username}@${result.target.host}:${result.target.port}`;
      element("disconnectButton").disabled = false;
      element("connectButton").disabled = false;
      updateFileControls();
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
      if (message.resumed) showStatus("已恢复原终端，正在执行的命令继续运行。");
      else { element("terminal").scrollIntoView({ block: "nearest" }); terminal.focus(); }
    } else if (message.type === "error") {
      if (message.terminalClosed || (resume && message.statusCode === 403)) state.resumeToken = "";
      showStatus(message.message, true);
    } else if (message.type === "exit") {
      state.resumeToken = "";
      showStatus(`远程终端已退出${message.code == null ? "" : `，退出码 ${message.code}`}`);
    }
  });
  socket.addEventListener("close", (event) => {
    clearTimeout(deadline);
    if (state.socket !== socket) return;
    state.socket = null;
    state.ready = false;
    state.busy = false;
    updateFileControls();
    element("connectButton").disabled = false;
    if (event?.code === 1000 || (event?.code === 1008 && !state.resumeToken)) state.resumeToken = "";
    if (state.resumeToken) scheduleReconnect();
    else {
      state.fileToken = "";
      element("connectionStatus").textContent = directMode ? "终端已关闭，点击重新连接即可" : "终端已关闭，请重新登录连接";
      element("disconnectButton").disabled = true;
    }
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket && !state.resumeToken) showStatus(directMode
      ? "无法建立本站终端连接，请检查网络并点击重新连接。" : "无法建立本站终端连接，请检查网络或重新登录。", true);
  });
}

function scheduleReconnect() {
  if (!state.resumeToken || state.socket || state.reconnectTimer) return;
  if (!state.reconnectDeadline) state.reconnectDeadline = Date.now() + state.resumeGraceMs;
  if (Date.now() >= state.reconnectDeadline) {
    state.resumeToken = "";
    state.fileToken = "";
    element("disconnectButton").disabled = true;
    element("connectionStatus").textContent = directMode ? "原终端已结束，点击重新连接即可" : "恢复期限已过，请重新登录连接";
    return;
  }
  const delay = Math.min(1000 * 2 ** Math.min(state.reconnectAttempts++, 4), 15_000);
  element("connectionStatus").textContent = `连接中断，${Math.ceil(delay / 1000)} 秒后恢复原终端…`;
  element("disconnectButton").disabled = false;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.resumeToken && !state.socket) openSocket({ target: state.connectionTarget }, state.generation, true);
  }, delay);
}

function wakeReconnect() {
  if (state.resumeToken && !state.socket) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    scheduleReconnect();
  }
}

function disconnect() {
  const resumeToken = state.resumeToken;
  send({ type: "disconnect" });
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.resumeToken = "";
  state.fileToken = "";
  state.reconnectDeadline = 0;
  cancelUpload();
  state.generation += 1;
  state.ready = false;
  state.busy = false;
  const socket = state.socket;
  state.socket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  element("disconnectButton").disabled = true;
  element("connectButton").disabled = accessMode ? false : !selectedTarget();
  element("connectionStatus").textContent = "尚未连接";
  updateFileControls();
  if (resumeToken && (!socket || socket.readyState !== WebSocket.OPEN)) {
    void fetch("/api/tools/web-ssh/access/sessions/disconnect", {
      method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "web-ssh-disconnect" },
      body: JSON.stringify({ resumeToken }),
    }).catch(() => {});
  }
}

function updateFileControls() {
  element("fileControls").disabled = !state.ready || !state.fileToken;
}

async function fileRequest(endpoint, body) {
  if (!state.ready || !state.fileToken) throw new Error("请先连接 SSH 终端");
  const response = await fetch(`/api/tools/web-ssh/access/files/${endpoint}`, {
    method: "POST", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(40_000),
    headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "web-ssh-files", "X-Wfl-Ssh-Session": state.fileToken },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `文件操作失败（${response.status}）`);
  return result;
}

async function loadFiles(directory = state.directory) {
  const requestId = ++state.fileRequestId;
  const generation = state.generation;
  try {
    fileStatus("正在读取目录…");
    const result = await fileRequest("list", { path: directory });
    if (requestId !== state.fileRequestId || generation !== state.generation) return;
    state.directory = result.path;
    state.parentDirectory = result.parent;
    element("remoteDirectory").value = result.path;
    element("remoteFiles").replaceChildren();
    for (const entry of result.entries) {
      const row = document.createElement("div");
      row.className = "file-row";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "file-name";
      name.textContent = `${entry.kind === "directory" ? "📁 " : entry.kind === "link" ? "↗ " : ""}${entry.name}`;
      name.addEventListener("click", () => {
        if (["directory", "link"].includes(entry.kind)) void loadFiles(entry.path);
        else element("remoteDownloadPath").value = entry.path;
      });
      const size = document.createElement("span");
      size.className = "muted";
      size.textContent = entry.kind === "directory" ? "目录" : formatBytes(entry.size);
      row.append(name, size);
      if (["file", "link"].includes(entry.kind)) {
        const download = document.createElement("button");
        download.type = "button"; download.textContent = "下载";
        download.addEventListener("click", () => void downloadFile(entry.path));
        row.append(download);
      }
      element("remoteFiles").append(row);
    }
    fileStatus(`${result.entries.length} 项 · 上传目标：${result.path}`);
  } catch (error) {
    if (requestId === state.fileRequestId && generation === state.generation) fileStatus(error.message, true);
  }
}

async function downloadFile(remotePath) {
  const generation = state.generation;
  try {
    const result = await fileRequest("downloads", { path: remotePath });
    if (generation !== state.generation) return;
    const link = document.createElement("a");
    link.href = `/api/tools/web-ssh/access/files/downloads/${encodeURIComponent(result.ticket)}`;
    link.download = result.name;
    link.referrerPolicy = "no-referrer";
    document.body.append(link); link.click(); link.remove();
    fileStatus(`已开始下载 ${result.name}，进度和取消请查看浏览器下载列表。`);
  } catch (error) { if (generation === state.generation) fileStatus(error.message, true); }
}

async function uploadFiles() {
  if (state.upload || !state.ready || !state.fileToken) return;
  const files = [...element("uploadInput").files];
  if (!files.length) return;
  const directory = element("remoteDirectory").value.trim();
  if (!directory) { fileStatus("请指定远程目录", true); return; }
  const generation = state.generation;
  const overwrite = element("overwriteFiles").checked;
  state.cancelUpload = false;
  element("uploadButton").disabled = true;
  element("cancelUploadButton").hidden = false;
  try {
    for (const file of files) {
      if (state.cancelUpload || generation !== state.generation) throw new Error("上传已取消，终端可继续使用");
      const remotePath = `${directory.replace(/\/$/u, "")}/${file.name}`;
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        state.upload = xhr;
        xhr.open("PUT", `/api/tools/web-ssh/access/files?path=${encodeURIComponent(remotePath)}&overwrite=${overwrite}`);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader("X-Codex-Desktop-Action", "web-ssh-files");
        xhr.setRequestHeader("X-Wfl-Ssh-Session", state.fileToken);
        xhr.upload.onprogress = (event) => {
          if (generation === state.generation) fileStatus(`${file.name} · ${formatBytes(event.loaded)} / ${formatBytes(file.size)}${event.lengthComputable ? ` · ${Math.round(event.loaded * 100 / event.total)}%` : ""}`);
        };
        xhr.upload.onload = () => {
          if (generation === state.generation) fileStatus(`${file.name} · 已传输到本站，正在保存到远程服务器…`);
        };
        xhr.onload = () => {
          let result = {};
          try { result = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(result);
          else reject(new Error(result.error || `上传失败（${xhr.status}）`));
        };
        xhr.onerror = () => reject(new Error("上传连接中断，终端可继续使用；请刷新目录确认文件状态"));
        xhr.onabort = () => reject(new Error("上传已取消，终端可继续使用"));
        fileStatus(`正在上传 ${file.name}（${formatBytes(file.size)}）…`);
        xhr.send(file);
      });
      state.upload = null;
    }
    if (generation === state.generation) {
      element("uploadInput").value = "";
      await loadFiles(directory);
      fileStatus(`${files.length} 个文件上传完成。`);
    }
  } catch (error) { if (generation === state.generation) fileStatus(error.message, true); }
  finally {
    state.upload = null;
    element("uploadButton").disabled = false;
    element("cancelUploadButton").hidden = true;
  }
}

function cancelUpload() { state.cancelUpload = true; state.upload?.abort(); }
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fileStatus(message, error = false) {
  element("fileStatus").textContent = message;
  element("fileStatus").dataset.error = String(error);
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function sendInput(value) {
  if (!state.ready) return;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 8000, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    send({ type: "input", data: value.slice(offset, end) });
    offset = end;
  }
}

async function saveTarget(event) {
  event.preventDefault();
  const form = element("targetForm");
  const button = element("saveTargetButton");
  button.disabled = true;
  const body = Object.fromEntries(new FormData(form));
  if (element("authMode").value === "password") { body.privateKey = ""; body.passphrase = ""; }
  else body.password = "";
  body.port = Number(body.port);
  try {
    showStatus("正在读取服务器主机指纹…");
    const probe = await request("/api/tools/web-ssh/probe", { action: "web-ssh-probe", body: { host: body.host, port: body.port } });
    if (!confirm(`请确认目标服务器身份：\n${body.host}:${body.port}\n${probe.hostKeyFingerprint}\n\n仅在信任此指纹时继续。`)) { showStatus("已取消保存"); return; }
    showStatus("正在验证 SSH 登录并加密保存…");
    const result = await request("/api/tools/web-ssh/targets", { action: "web-ssh-save", body: { ...body, ...probe } });
    form.reset();
    element("serverEditor").open = false;
    element("privateKeyFields").hidden = true;
    element("passwordField").hidden = false;
    element("authMode").value = "password";
    await loadSettings(`saved:${result.target.id}`);
    showStatus("服务器已保存，可以打开终端或生成直达链接。");
  } catch (error) { showStatus(error.message, true); }
  finally {
    for (const field of ["password", "privateKey", "passphrase"]) { body[field] = ""; form.elements[field].value = ""; }
    button.disabled = false;
  }
}

function showDirectLink(accessKey, grantId) {
  const link = new URL("/ssh-direct.html", location.href);
  link.hash = accessKey;
  state.lastDirectLink = link.href;
  state.lastDirectGrantId = grantId;
  element("directLink").value = link.href;
  element("openDirectLink").href = link.href;
  element("directGrantResult").hidden = false;
}

async function createDirectGrant(event) {
  event.preventDefault();
  element("createDirectGrantButton").disabled = true;
  try {
    const result = await request("/api/tools/web-ssh/grants", { action: "web-ssh-grant", body: {
      mode: "link", reference: reference(selectedTarget()), name: new FormData(element("directGrantForm")).get("name"),
    } });
    showDirectLink(result.accessKey, result.grant.id);
    await loadSettings();
    showStatus("直达链接已生成，打开即可连接，长期有效。");
  } catch (error) { showStatus(error.message, true); }
  finally { element("createDirectGrantButton").disabled = !selectedTarget()?.terminalAvailable; }
}

async function createGrant(event) {
  event.preventDefault();
  const form = element("grantForm");
  element("createGrantButton").disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    body.reference = reference(selectedTarget());
    body.expiresInSeconds = Number(body.expiresInSeconds);
    const result = await request("/api/tools/web-ssh/grants", { action: "web-ssh-grant", body });
    state.lastAccessKey = result.accessKey;
    state.lastGrantId = result.grant.id;
    element("shareLink").value = new URL("/ssh-access.html", location.href).href;
    element("newAccessKey").value = result.accessKey;
    element("newAccessKey").type = "password";
    element("showAccessKey").checked = false;
    element("grantResult").hidden = false;
    await loadSettings();
    showStatus("访问密钥已创建。复制链接和密钥，对方只需填入密钥即可登录。");
  } catch (error) { showStatus(error.message, true); }
  finally { form.elements.accessKey.value = ""; element("createGrantButton").disabled = !selectedTarget(); }
}

function renderGrants() {
  element("grantList").replaceChildren();
  for (const grant of state.grants) {
    const row = document.createElement("div");
    row.className = "grant-row";
    const text = document.createElement("div");
    text.className = "grant-copy";
    const title = document.createElement("strong");
    title.textContent = grant.name;
    const description = document.createElement("small");
    const target = state.targets.find((entry) => entry.kind === grant.reference.kind && entry.id === grant.reference.id);
    description.textContent = `${target?.name || "服务器已删除"} · ${grant.mode === "link" ? "直达链接" : "访问密钥"} · ${grant.expired ? "已到期" : grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : "长期有效"}`;
    text.append(title, description);
    row.append(text);
    if (grant.mode === "link") {
      const copyButton = document.createElement("button");
      copyButton.className = "secondary";
      copyButton.textContent = "复制链接";
      copyButton.type = "button";
      copyButton.addEventListener("click", async () => {
        copyButton.disabled = true;
        try {
          const result = await request(`/api/tools/web-ssh/grants/${encodeURIComponent(grant.id)}/link`, { method: "GET" });
          showDirectLink(result.accessKey, grant.id);
          await copy(state.lastDirectLink);
        } catch (error) { showStatus(error.message, true); }
        finally { copyButton.disabled = false; }
      });
      row.append(copyButton);
    }
    const button = document.createElement("button");
    button.className = "danger";
    button.textContent = "撤销";
    button.type = "button";
    button.addEventListener("click", async () => {
      if (!confirm(`撤销「${grant.name}」？使用此授权的终端也会断开。`)) return;
      button.disabled = true;
      try {
        await request(`/api/tools/web-ssh/grants/${encodeURIComponent(grant.id)}`, { method: "DELETE", action: "web-ssh-revoke" });
        if (state.lastGrantId === grant.id) clearInvitation();
        if (state.lastDirectGrantId === grant.id) clearDirectLink();
        await loadSettings();
        showStatus(grant.mode === "link" ? "直达链接已撤销。" : "访问密钥已撤销。");
      } catch (error) { button.disabled = false; showStatus(error.message, true); }
    });
    row.append(button);
    element("grantList").append(row);
  }
}

async function deleteTarget() {
  const target = selectedTarget();
  if (!target || target.kind !== "saved" || !confirm(`删除「${target.name}」及关联访问密钥？已有终端会断开。`)) return;
  try {
    await request(`/api/tools/web-ssh/targets/${encodeURIComponent(target.id)}`, { method: "DELETE", action: "web-ssh-delete" });
    if (state.grants.some((grant) => grant.id === state.lastGrantId && grant.reference.kind === "saved" && grant.reference.id === target.id)) clearInvitation();
    if (state.grants.some((grant) => grant.id === state.lastDirectGrantId && grant.reference.kind === "saved" && grant.reference.id === target.id)) clearDirectLink();
    await loadSettings();
    showStatus("服务器与关联密钥已删除。");
  } catch (error) { showStatus(error.message, true); }
}

function clearDirectLink() {
  state.lastDirectGrantId = "";
  state.lastDirectLink = "";
  element("directLink").value = "";
  element("openDirectLink").removeAttribute("href");
  element("directGrantResult").hidden = true;
}

function clearInvitation() {
  state.lastGrantId = "";
  state.lastAccessKey = "";
  element("newAccessKey").value = "";
  element("grantResult").hidden = true;
}

async function copy(value) {
  if (!value) return;
  try { await navigator.clipboard.writeText(value); showStatus("已复制。"); }
  catch { showStatus("浏览器不允许复制，请手动选中内容复制。", true); }
}

function showStatus(message, error = false) {
  element("pageStatus").textContent = message;
  element("pageStatus").dataset.error = String(error);
}
