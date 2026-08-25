const state = {
  root: "/",
  currentPath: "/",
  offset: 0,
  limit: 500,
  total: 0,
  entries: [],
  selected: null,
  file: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

for (const [id, handler] of [
  ["pathForm", openPathFromForm],
  ["homeButton", () => openDirectory(state.root)],
  ["upButton", () => state.currentPath === state.root ? null : openDirectory(parentPath(state.currentPath))],
  ["refreshButton", () => openDirectory(state.currentPath, { keepSelection: true })],
  ["newFileButton", () => createEntry("file")],
  ["newDirectoryButton", () => createEntry("directory")],
  ["renameButton", renameSelected],
  ["deleteButton", deleteSelected],
  ["downloadButton", downloadSelected],
  ["saveButton", saveFile],
  ["previousPageButton", () => openDirectory(state.currentPath, { offset: Math.max(0, state.offset - state.limit) })],
  ["nextPageButton", () => openDirectory(state.currentPath, { offset: state.offset + state.limit })],
].map(([id, handler]) => [$(id), handler])) {
  id.addEventListener("click", handler);
}

$("uploadInput").addEventListener("change", uploadSelectedFile);
$("fileRows").addEventListener("dblclick", (event) => {
  const row = event.target.closest("tr[data-path]");
  const entry = state.entries.find((candidate) => candidate.path === row?.dataset.path);
  if (!entry) return;
  if (entry.type === "directory") void openDirectory(entry.path);
  else if (entry.type === "file") void readFile(entry);
});
$("fileRows").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-path]");
  const entry = state.entries.find((candidate) => candidate.path === row?.dataset.path);
  if (!entry) return;
  if (entry.type === "directory" && event.target.closest(".entry-name-cell")) {
    void openDirectory(entry.path);
    return;
  }
  selectEntry(entry);
});

await initialize();

async function initialize() {
  try {
    const status = await request("/api/tools/server-files/status");
    state.root = status.root || "/";
    state.currentPath = state.root;
    $("pathInput").value = state.currentPath;
    setStatus(`已连接 ${status.platform || "服务器"}；文本编辑上限 ${formatBytes(status.editLimitBytes)}`);
    await openDirectory(state.currentPath);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function openPathFromForm(event) {
  event.preventDefault();
  await openDirectory($("pathInput").value.trim());
}

async function openDirectory(pathValue, { offset = 0, keepSelection = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  $("directoryLoading").hidden = false;
  try {
    const query = new URLSearchParams({ path: pathValue, offset: String(offset), limit: String(state.limit) });
    const data = await request(`/api/tools/server-files/list?${query}`);
    state.currentPath = data.path;
    state.offset = data.offset;
    state.total = data.total;
    state.entries = data.entries || [];
    $("pathInput").value = state.currentPath;
    if (!keepSelection) clearSelection();
    else if (state.selected) {
      const refreshed = state.entries.find((entry) => entry.path === state.selected.path);
      if (refreshed) selectEntry(refreshed);
      else clearSelection();
    }
    renderEntries();
    setStatus(`已打开 ${state.currentPath}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.busy = false;
    $("directoryLoading").hidden = true;
  }
}

function renderEntries() {
  const rows = state.entries.map((entry) => {
    const selected = state.selected?.path === entry.path ? " selected" : "";
    const typeLabel = { directory: "文件夹", file: "文件", symlink: "符号链接", other: "其他" }[entry.type] || entry.type;
    const className = entry.type === "directory" ? "directory" : entry.type === "symlink" ? "symlink" : "";
    const icon = entry.type === "directory" ? "▸" : entry.type === "symlink" ? "↗" : "·";
    return `<tr data-path="${escapeAttribute(entry.path)}" class="${selected.trim()}">
      <td class="entry-name-cell"><span class="entry-name ${className}"${entry.type === "directory" ? ' title="点击进入文件夹"' : ""}><span class="entry-icon">${icon}</span>${escapeHtml(entry.name)}</span></td>
      <td>${typeLabel}</td>
      <td>${entry.type === "file" ? formatBytes(entry.size) : "--"}</td>
      <td>${formatDate(entry.modifiedAt)}</td>
      <td>${formatMode(entry.mode)}</td>
    </tr>`;
  }).join("");
  $("fileRows").innerHTML = rows || '<tr class="empty-row"><td colspan="5">此目录没有可显示的内容</td></tr>';
  $("directorySummary").textContent = `${state.currentPath} · ${state.total.toLocaleString("zh-CN")} 项`;
  const page = state.total ? Math.floor(state.offset / state.limit) + 1 : 1;
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  $("pageSummary").textContent = `${page} / ${pages}`;
  $("previousPageButton").disabled = state.offset <= 0;
  $("nextPageButton").disabled = state.offset + state.entries.length >= state.total;
  $("upButton").disabled = state.currentPath === state.root;
}

function selectEntry(entry) {
  state.selected = entry;
  renderEntries();
  const file = entry.type === "file";
  $("renameButton").disabled = false;
  $("deleteButton").disabled = false;
  $("downloadButton").disabled = !file;
  if (file) void readFile(entry);
  else {
    state.file = null;
    $("editorTitle").textContent = entry.type === "directory" ? "文件夹" : "不可预览项";
    $("editorMeta").textContent = entry.type === "symlink" ? "符号链接不会被跟随或读取。" : entry.path;
    $("fileEditor").value = "";
    $("fileEditor").readOnly = true;
    $("saveButton").disabled = true;
    $("editorStatus").textContent = entry.path;
  }
}

async function readFile(entry) {
  try {
    const query = new URLSearchParams({ path: entry.path });
    const file = await request(`/api/tools/server-files/read?${query}`);
    state.file = file;
    $("editorTitle").textContent = file.name;
    $("editorMeta").textContent = `${file.path} · ${formatBytes(file.size)}${file.truncated ? " · 仅显示开头" : ""}`;
    $("fileEditor").value = file.binary ? "[二进制文件不可作为文本预览，请使用下载。]" : file.content || "";
    $("fileEditor").readOnly = !file.editable;
    $("saveButton").disabled = !file.editable;
    $("editorStatus").textContent = file.binary ? "二进制文件" : file.truncated ? `内容过大，省略 ${formatBytes(file.omittedBytes)}` : "可以编辑并保存";
  } catch (error) {
    setEditorError(error.message);
  }
}

async function saveFile() {
  if (!state.file?.editable) return;
  try {
    $("saveButton").disabled = true;
    const query = new URLSearchParams({ path: state.file.path });
    const response = await fetch(`/api/tools/server-files/write?${query}`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Codex-Desktop-Action": "server-files-save",
        "X-Codex-Desktop-File-Version": state.file.version,
      },
      body: $("fileEditor").value,
    });
    const data = await json(response);
    state.file = data.entry;
    $("editorStatus").textContent = "已保存";
    setStatus(`已保存 ${state.file.path}`);
    await openDirectory(state.currentPath, { keepSelection: true });
  } catch (error) {
    $("saveButton").disabled = false;
    setEditorError(error.message);
  }
}

async function createEntry(type) {
  const label = type === "directory" ? "文件夹名称" : "文件名称";
  const name = window.prompt(`请输入${label}`);
  if (name === null) return;
  try {
    await mutate("/api/tools/server-files/action", { action: "create", parentPath: state.currentPath, name, type });
    setStatus(`已创建 ${name}`);
    await openDirectory(state.currentPath, { keepSelection: true });
  } catch (error) { setStatus(error.message, true); }
}

async function renameSelected() {
  if (!state.selected) return;
  const name = window.prompt("请输入新名称", state.selected.name);
  if (name === null || name === state.selected.name) return;
  try {
    await mutate("/api/tools/server-files/action", { action: "rename", path: state.selected.path, name });
    setStatus(`已重命名为 ${name}`);
    await openDirectory(state.currentPath);
  } catch (error) { setStatus(error.message, true); }
}

async function deleteSelected() {
  if (!state.selected) return;
  const message = state.selected.type === "directory"
    ? `确认递归删除文件夹及其全部内容？\n\n${state.selected.path}`
    : `确认删除此文件？\n\n${state.selected.path}`;
  if (!window.confirm(message)) return;
  try {
    await mutate("/api/tools/server-files/action", {
      action: "delete",
      path: state.selected.path,
      recursive: state.selected.type === "directory",
      confirmPath: state.selected.path,
    });
    setStatus(`已删除 ${state.selected.path}`);
    await openDirectory(state.currentPath);
  } catch (error) { setStatus(error.message, true); }
}

function downloadSelected() {
  if (state.selected?.type !== "file") return;
  const query = new URLSearchParams({ path: state.selected.path });
  window.location.href = `/api/tools/server-files/download?${query}`;
}

async function uploadSelectedFile() {
  const file = $("uploadInput").files?.[0];
  $("uploadInput").value = "";
  if (!file) return;
  try {
    const query = new URLSearchParams({ path: state.currentPath, name: file.name });
    const response = await fetch(`/api/tools/server-files/upload?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Codex-Desktop-Action": "server-files-upload" },
      body: file,
    });
    await json(response);
    setStatus(`已上传 ${file.name}`);
    await openDirectory(state.currentPath, { keepSelection: true });
  } catch (error) { setStatus(error.message, true); }
}

async function mutate(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": "server-files-action" },
    body: JSON.stringify(body),
  });
  return json(response);
}

async function request(url) {
  const response = await fetch(url, { cache: "no-store" });
  return json(response);
}

async function json(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function clearSelection() {
  state.selected = null;
  state.file = null;
  $("renameButton").disabled = true;
  $("deleteButton").disabled = true;
  $("downloadButton").disabled = true;
  $("saveButton").disabled = true;
  $("editorTitle").textContent = "文件预览";
  $("editorMeta").textContent = "选择普通文件查看内容；符号链接不会被跟随。";
  $("fileEditor").value = "";
  $("fileEditor").readOnly = true;
  $("editorStatus").textContent = "";
}

function setStatus(message, error = false) {
  $("managerStatus").textContent = message || "";
  $("managerStatus").dataset.error = String(error);
}

function setEditorError(message) {
  $("editorStatus").textContent = message;
  $("editorStatus").dataset.error = "true";
}

function parentPath(value) {
  const normalized = value.replace(/[\\/]+$/, "") || state.root;
  if (normalized === state.root) return state.root;
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (separator < 0) return state.root;
  const parent = normalized.slice(0, separator);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || state.root;
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const bytes = Math.max(0, Number(value));
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1_024 ** 3).toFixed(1)} GiB`;
}

function formatDate(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return new Date(value).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

function formatMode(mode) {
  return Number.isInteger(mode) ? `0${mode.toString(8).padStart(3, "0")}` : "--";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function escapeAttribute(value) { return escapeHtml(value); }
