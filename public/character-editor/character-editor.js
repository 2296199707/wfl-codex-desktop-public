import { MapProjectWorkspaceClient } from "/map-project-session.js?v=0.44.56-beta";
import { createMapAccountSessionGuard } from "/map-editor/map-account-session-guard.js?v=0.44.56-beta";
import {
  CHARACTER_PROFILES,
  clipFrameAt,
  clipDurationMs,
  createCharacterAnimationDocument,
  frameRect,
  normalizeCharacterAnimationDocument,
  normalizeProjectRelativePath,
} from "/character-editor/character-animation-model.js?v=0.44.56-beta";

// The editor is always loaded with the release asset query.  Never fall back
// to an older release: a direct reload must not mix editor code with an old
// image-studio module after a deployment.
const CHARACTER_EDITOR_ASSET_VERSION = new URL(import.meta.url).searchParams.get("v") || "";

const app = document.querySelector("#characterApp");
const elements = Object.fromEntries([
  "characterNotice", "refreshProjectButton", "saveCharacterButton", "newCharacterButton",
  "aiGenerateButton", "aiEditButton",
  "undoButton", "redoButton", "conflictActions", "conflictDetail", "reloadRemoteButton", "saveAsDraftButton", "downloadDraftButton",
  "projectSelect", "switchProjectButton", "refreshProjectsButton", "projectListState", "projectFileSelect",
  "projectPathInput", "openProjectButton", "characterPathSelect", "sourcePathSelect", "projectState",
  "characterCanvas", "spriteSheetCanvas", "canvasEmpty", "imageSizeLabel", "frameLabel", "dirtyLabel",
  "previousFrameButton", "playButton", "nextFrameButton", "nameInput", "profileSelect",
  "frameWidthInput", "frameHeightInput", "columnsInput", "rowsInput", "marginXInput", "marginYInput",
  "spacingXInput", "spacingYInput", "referenceHeightInput", "anchorXInput", "anchorYInput",
  "moveClipUpButton", "moveClipDownButton", "duplicateClipButton", "deleteClipButton", "addClipButton",
  "clipSelect", "clipIdInput", "clipNameInput", "clipDirectionSelect", "clipLoopInput", "addFrameButton",
  "frameList", "validationMessage",
].map((id) => [id, document.getElementById(id)]));

const params = new URLSearchParams(location.hash.replace(/^#/, ""));
const workspace = new MapProjectWorkspaceClient();
const initialProject = params.get("project") || "";
const initialProjectFile = params.get("projectFile") || null;
const initialCharacterPath = params.get("path") || "";
const initialSourcePath = params.get("source") || "";
const CHARACTER_VERSION_CONFLICT_CODES = new Set([
  "wfl-character-animation-version-conflict",
  "wfl-character-animation-post-commit-conflict",
]);
const CHARACTER_RESOURCE_UNAVAILABLE_CODES = new Set([
  "map-project-resource-not-found",
  "map-project-resource-outside-folders",
  "map-project-resource-kind-mismatch",
]);
const state = {
  project: initialProject,
  projectFile: initialProjectFile,
  projects: [],
  initialSelectionPending: true,
  projectLoading: false,
  accountId: params.get("account") || null,
  accountSessionGuard: null,
  characterPath: params.get("path") || "",
  sourcePath: params.get("source") || "",
  entries: [],
  document: null,
  version: null,
  dirty: false,
  clipIndex: 0,
  frameIndex: 0,
  image: null,
  imagePath: "",
  playing: false,
  animationFrame: null,
  lastFrameAt: 0,
  elapsed: 0,
  loadToken: 0,
  sourceLoadToken: 0,
  projectLoadToken: 0,
  saving: false,
  undoStack: [],
  redoStack: [],
  savedSerialized: null,
  conflict: false,
  closing: false,
  spriteSheetScale: 1,
  imageCache: new Map(),
  candidateApplying: false,
  // Monotonic document revision. It lets a save distinguish edits made
  // while the network request was in flight from the content just written.
  revision: 0,
  // Invalidates save callbacks when the project/resource context is reset.
  saveToken: 0,
};

for (const profile of CHARACTER_PROFILES) {
  elements.profileSelect.append(new Option(profile.label, profile.id));
}

elements.projectPathInput.value = state.project;
elements.projectSelect.addEventListener("change", () => {
  const project = elements.projectSelect.value;
  if (project) elements.projectPathInput.value = project;
  if (project !== state.project) replaceProjectFileOptions([]);
  renderProjectControls();
});
elements.projectFileSelect.addEventListener("change", () => renderProjectControls());
elements.switchProjectButton.addEventListener("click", () => void switchSelectedProject());
elements.refreshProjectsButton.addEventListener("click", () => void loadProjects({ refresh: true }));
elements.openProjectButton.addEventListener("click", () => void switchSelectedProject());
elements.refreshProjectButton.addEventListener("click", () => void openProject({ keepSelection: true }));
elements.aiGenerateButton.addEventListener("click", () => void openCharacterImageStudio("generate"));
elements.aiEditButton.addEventListener("click", () => void openCharacterImageStudio("edit"));
elements.characterPathSelect.addEventListener("change", () => {
  if (elements.characterPathSelect.value) void switchCharacter(elements.characterPathSelect.value);
});
elements.sourcePathSelect.addEventListener("change", () => void selectSource(elements.sourcePathSelect.value));
elements.newCharacterButton.addEventListener("click", () => void createNewCharacter());
elements.saveCharacterButton.addEventListener("click", () => void saveCharacter());
elements.undoButton.addEventListener("click", () => undo());
elements.redoButton.addEventListener("click", () => redo());
elements.reloadRemoteButton.addEventListener("click", () => void reloadRemoteCharacter());
elements.saveAsDraftButton.addEventListener("click", () => void saveDraftAs());
elements.downloadDraftButton.addEventListener("click", () => downloadLocalDraft());
elements.profileSelect.addEventListener("change", () => updateFromInspector());
for (const id of [
  "nameInput", "frameWidthInput", "frameHeightInput", "columnsInput", "rowsInput", "marginXInput",
  "marginYInput", "spacingXInput", "spacingYInput", "referenceHeightInput", "anchorXInput", "anchorYInput",
  "clipIdInput", "clipNameInput", "clipDirectionSelect", "clipLoopInput",
]) {
  elements[id].addEventListener("input", () => updateFromInspector());
  elements[id].addEventListener("change", () => updateFromInspector());
}
elements.clipSelect.addEventListener("change", () => {
  updateFromInspector();
  state.clipIndex = Math.max(0, Number(elements.clipSelect.value) || 0);
  state.frameIndex = 0;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
});
elements.addClipButton.addEventListener("click", () => addClip());
elements.moveClipUpButton.addEventListener("click", () => moveClip(-1));
elements.moveClipDownButton.addEventListener("click", () => moveClip(1));
elements.duplicateClipButton.addEventListener("click", () => duplicateClip());
elements.deleteClipButton.addEventListener("click", () => deleteClip());
elements.addFrameButton.addEventListener("click", () => addFrame());
elements.previousFrameButton.addEventListener("click", () => moveFrame(-1));
elements.nextFrameButton.addEventListener("click", () => moveFrame(1));
elements.playButton.addEventListener("click", () => togglePlayback());
elements.spriteSheetCanvas.addEventListener("click", (event) => selectSpriteFrame(event));

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  } else if (key === "y") {
    event.preventDefault();
    redo();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "角色动画尚未保存";
});

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  closeCharacterWorkspace({ keepalive: true });
});

setEditorState("loading", "正在连接工程工作区…");
void initializeCharacterEditor();

async function initializeCharacterEditor() {
  if (state.accountId) {
    state.accountSessionGuard = createMapAccountSessionGuard({
      accountId: state.accountId,
      onInvalidated: invalidateCharacterAccountSession,
    });
    const accountStatus = await state.accountSessionGuard.check();
    if (accountStatus === "invalidated") return;
    state.accountSessionGuard.start();
  }
  const selected = await loadProjects();
  if (selected) await openProject();
}

async function loadProjects({ refresh = false } = {}) {
  elements.projectListState.textContent = refresh ? "正在刷新工程列表…" : "正在读取可用工程…";
  elements.projectSelect.disabled = true;
  try {
    const response = await fetch("/api/projects", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "无法读取工程列表");
    const projects = (Array.isArray(data.projects) ? data.projects : [])
      .filter((project) => project && typeof project.path === "string" && project.path.startsWith("/"))
      .map((project) => ({
        ...project,
        name: String(project.name || project.path.split("/").at(-1) || project.path),
        path: project.path,
      }))
      .filter((project, index, values) => values.findIndex((candidate) => candidate.path === project.path) === index);
    state.projects = projects;
    const explicitProject = state.initialSelectionPending ? initialProject : "";
    const remembered = readRememberedProject();
    const selected = (explicitProject && projects.find((project) => project.path === explicitProject))
      || projects.find((project) => project.path === state.project)
      || projects.find((project) => project.path === remembered)
      || projects.find((project) => project.path === data.defaultProject)
      || projects[0]
      || null;
    if (explicitProject && !selected?.path) {
      renderProjectOptions();
      elements.projectListState.textContent = `传入的工程不可用：${explicitProject}`;
      setEditorState("error", "主界面传入的工程不可用，请在工程列表中选择一个可访问的工程");
      renderProjectControls();
      return null;
    }
    const usesInitialBinding = Boolean(initialProject && selected?.path === initialProject);
    const currentBindingIsListed = state.projects.some((project) => project.path === state.project);
    const selectedPath = selected?.path || "";
    // During a refresh, keep the actual open binding even if its directory
    // disappeared from the catalog. The fallback is only a pending selection;
    // the user must explicitly switch before the session changes.
    if (state.initialSelectionPending || currentBindingIsListed || !state.project) {
      state.project = selectedPath;
      state.projectFile = state.initialSelectionPending && usesInitialBinding ? initialProjectFile : null;
    }
    renderProjectOptions(selectedPath || state.project);
    elements.projectPathInput.value = selectedPath || state.project;
    elements.projectListState.textContent = projects.length
      ? `${projects.length} 个可访问工程；选择后点击“切换工程”`
      : "没有可访问的工程";
    renderProjectControls();
    return selected?.path || null;
  } catch (error) {
    state.projects = [];
    renderProjectOptions();
    elements.projectListState.textContent = error.message || "无法读取工程列表";
    setEditorState("error", error.message || "无法读取工程列表");
    renderProjectControls();
    return null;
  }
}

function readRememberedProject() {
  try {
    return localStorage.getItem(characterProjectStorageKey()) || "";
  } catch {
    return "";
  }
}

function rememberProject(project) {
  try {
    if (project) localStorage.setItem(characterProjectStorageKey(), project);
  } catch {
    // Project selection remains available for the current editor window.
  }
}

function characterProjectStorageKey() {
  const account = state.accountId || "legacy";
  return `wflCharacterEditor.project:${encodeURIComponent(account)}`;
}

function renderProjectOptions(selectedPath = state.project) {
  elements.projectSelect.replaceChildren();
  if (!state.projects.length) {
    elements.projectSelect.append(new Option("没有可访问的工程", ""));
    elements.projectSelect.disabled = true;
    return;
  }
  for (const project of state.projects) {
    const option = new Option(`${project.name} · ${project.path}`, project.path);
    option.title = project.path;
    elements.projectSelect.append(option);
  }
  elements.projectSelect.value = selectedPath;
  elements.projectSelect.disabled = false;
}

function replaceProjectFileOptions(entries = [], currentPath = null) {
  elements.projectFileSelect.replaceChildren();
  elements.projectFileSelect.append(new Option("临时工程（不绑定 .tiled-project）", ""));
  for (const entry of entries) {
    if (entry?.path) elements.projectFileSelect.append(new Option(entry.path, entry.path));
  }
  const desired = currentPath || "";
  elements.projectFileSelect.value = [...elements.projectFileSelect.options]
    .some((option) => option.value === desired) ? desired : "";
  elements.projectFileSelect.disabled = !state.project || !state.projects.some((project) => project.path === state.project);
}

function renderProjectControls() {
  const selectedProject = elements.projectSelect.value || elements.projectPathInput.value.trim();
  const selectedFile = elements.projectFileSelect.value || null;
  const currentFile = state.projectFile || null;
  const sameBinding = Boolean(selectedProject)
    && selectedProject === state.project
    && selectedFile === currentFile;
  const canSelectProject = state.projects.some((project) => project.path === selectedProject);
  elements.projectPathInput.value = selectedProject || state.project || "";
  elements.switchProjectButton.disabled = state.projectLoading || !canSelectProject || sameBinding;
  elements.openProjectButton.disabled = state.projectLoading || !canSelectProject;
  elements.projectFileSelect.disabled = state.projectLoading || !state.project;
}

async function switchSelectedProject() {
  const project = elements.projectSelect.value || elements.projectPathInput.value.trim();
  if (!project) {
    setEditorState("error", "请先在工程列表中选择工程");
    return;
  }
  const projectFile = project === state.project ? (elements.projectFileSelect.value || null) : null;
  const keepSelection = project === state.project && projectFile === (state.projectFile || null);
  await openProject({
    projectOverride: project,
    projectFileOverride: projectFile,
    keepSelection,
  });
}

async function openProject({ keepSelection = false, projectOverride = null, projectFileOverride = undefined } = {}) {
  const project = projectOverride || elements.projectSelect.value || elements.projectPathInput.value.trim() || state.project;
  if (!project) {
    setEditorState("error", "请先填写工程目录");
    return;
  }
  if (!state.projects.some((entry) => entry.path === project)) {
    setEditorState("error", "请选择工程列表中的可访问工程");
    return;
  }
  if (!confirmDiscardChanges("当前角色有未保存修改，重新打开工程会丢失这些修改。继续吗？")) return;
  const projectFile = projectFileOverride !== undefined
    ? projectFileOverride
    : (project === state.project ? state.projectFile : null);
  // Capture the requested resource before clearing the old editor state. A
  // stale URL is allowed to be attempted once below, but it must never leave
  // its old conflict banner attached to the newly opened project.
  const requestedCharacter = keepSelection
    ? state.characterPath
    : (state.initialSelectionPending && project === initialProject ? initialCharacterPath : "");
  const requestedSource = keepSelection
    ? state.sourcePath
    : (state.initialSelectionPending && project === initialProject ? initialSourcePath : "");
  state.initialSelectionPending = false;
  const loadToken = ++state.projectLoadToken;
  state.loadToken += 1;
  stopPlayback();
  state.sourceLoadToken += 1;
  state.imageCache.clear();
  clearCharacterState();
  state.projectLoading = true;
  renderProjectControls();
  try {
    setEditorState("loading", "正在打开项目资源…");
    state.project = project;
    state.projectFile = projectFile || null;
    rememberProject(project);
    const session = await workspace.open({ project, projectFile: state.projectFile });
    if (loadToken !== state.projectLoadToken) return;
    elements.projectPathInput.value = project;
    elements.projectSelect.value = project;
    state.projectFile = session.projectFile || null;
    elements.projectState.textContent = `${session.projectName || project} · ${session.projectFile || "临时工程"} · ${session.writable ? "可写" : "只读"}`;
    elements.projectListState.textContent = `已绑定 ${project}；可从列表切换工程`;
    await loadEntries();
    if (loadToken !== state.projectLoadToken) return;
    // The main workspace can open a resource found below the project root.
    // Do not require that path to be present in the editor's local resource
    // index before loading it; a stale/incomplete index must never turn an
    // existing remote character into a new draft with no version baseline.
    const character = requestedCharacter || state.entries.find((entry) => entry.kind === "character")?.path || "";
    if (character) await loadCharacter(character, { resetOnMissing: true });
    else {
      state.sourcePath = requestedSource || state.entries.find((entry) => entry.kind === "image")?.path || "";
      if (state.sourcePath) {
        await createNewCharacter({ path: state.sourcePath, promptForPath: false, resetOnMissing: true });
      }
      else renderEmptyState();
    }
    if (loadToken !== state.projectLoadToken) return;
    setEditorState("ready", session.warnings?.length ? session.warnings.join(" · ") : "项目已连接");
  } catch (error) {
    if (loadToken !== state.projectLoadToken) return;
    setEditorState("error", error.message || "无法打开项目");
  } finally {
    if (loadToken === state.projectLoadToken) {
      state.projectLoading = false;
      renderProjectControls();
    }
  }
}

function closeCharacterWorkspace({ keepalive = false } = {}) {
  if (state.closing) return;
  state.closing = true;
  state.projectLoadToken += 1;
  state.loadToken += 1;
  state.sourceLoadToken += 1;
  state.saveToken += 1;
  state.saving = false;
  stopPlayback();
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  void workspace.close({ keepalive }).catch(() => {});
}

function invalidateCharacterAccountSession() {
  closeCharacterWorkspace({ keepalive: true });
  document.body.replaceChildren(accountSessionEndedNotice());
  document.title = "账号已切换 · WFL 角色动画";
  setTimeout(() => window.close(), 0);
}

function accountSessionEndedNotice() {
  const notice = document.createElement("main");
  notice.setAttribute("role", "alert");
  notice.style.cssText = "min-height:100vh;display:grid;place-content:center;padding:24px;background:#0b1110;color:#e7efed;font:16px/1.6 system-ui,sans-serif;text-align:center";
  const title = document.createElement("h1");
  title.textContent = "账号已经切换";
  const detail = document.createElement("p");
  detail.textContent = "为保护项目隔离，旧账号的角色动画窗口已清空并关闭。请从当前账号重新打开。";
  notice.append(title, detail);
  return notice;
}

async function switchCharacter(relativePath) {
  const previousPath = state.characterPath;
  if (relativePath === previousPath) return;
  if (!confirmDiscardChanges("当前角色有未保存修改，切换角色会丢失这些修改。继续吗？")) {
    elements.characterPathSelect.value = previousPath;
    return;
  }
  await loadCharacter(relativePath);
}

async function loadEntries() {
  const entries = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await workspace.tree({ kinds: ["directory", "character", "image"], cursor, limit: 200 });
    entries.push(...result.entries);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  // tree() is intentionally one directory at a time. Search supplies the
  // nested character/image resources that are not visible in the root page.
  const searchQueries = [
    [".character.json", ["character"]],
    [".png", ["image"]],
    [".jpg", ["image"]],
    [".jpeg", ["image"]],
    [".webp", ["image"]],
    [".tiled-project", ["project"]],
  ];
  const searched = await Promise.all(searchQueries.map(([query, kinds]) => loadSearchEntries(query, kinds)));
  const byPath = new Map();
  for (const entry of [...entries, ...searched.flat()]) {
    if (["directory", "character", "image", "project"].includes(entry.kind)) byPath.set(entry.path, entry);
  }
  state.entries = [...byPath.values()];
  fillResourceSelects();
}

async function loadSearchEntries(query, kinds) {
  const entries = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await workspace.search({ query, kinds, cursor, limit: 200 });
    entries.push(...result.entries);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return entries;
}

function fillResourceSelects() {
  const characters = state.entries.filter((entry) => entry.kind === "character");
  const images = state.entries.filter((entry) => entry.kind === "image")
    .filter((entry) => /\.(?:png|jpe?g|webp)$/iu.test(entry.path));
  const projectFiles = state.entries.filter((entry) => entry.kind === "project");
  if (workspace.session?.projectFile && !projectFiles.some((entry) => entry.path === workspace.session.projectFile)) {
    projectFiles.unshift({ path: workspace.session.projectFile, kind: "project" });
  }
  replaceOptions(elements.characterPathSelect, characters, "暂无 .character.json");
  replaceOptions(elements.sourcePathSelect, images, "暂无 PNG/JPG/WebP");
  replaceProjectFileOptions(projectFiles, state.projectFile);
  elements.characterPathSelect.disabled = !characters.length;
  elements.sourcePathSelect.disabled = !images.length;
  elements.newCharacterButton.disabled = !images.length;
}

function replaceOptions(select, entries, emptyLabel) {
  select.replaceChildren();
  if (!entries.length) {
    select.append(new Option(emptyLabel, ""));
    return;
  }
  for (const entry of entries) select.append(new Option(entry.path, entry.path));
}

async function loadCharacter(relativePath, { resetOnMissing = false } = {}) {
  const loadToken = ++state.loadToken;
  // A resource switch is a state boundary. Clear the old document before any
  // network work so an old conflict banner/document can never be shown for a
  // new project or character path when the new read fails.
  clearCharacterState();
  if (resetOnMissing) setConflictActions(false);
  try {
    setEditorState("loading", `正在读取 ${relativePath}…`);
    const source = await workspace.readResourceSource(relativePath);
    // The source endpoint already returns the SHA-256 of the exact bytes it
    // read. Use it as the save baseline so content and version cannot come
    // from two different moments. The version endpoint remains a compatibility
    // fallback for older backends that did not send the response header.
    const version = /^[a-f0-9]{64}$/iu.test(String(source.version || ""))
      ? source.version
      : (await workspace.readResourceVersion(relativePath, "character")).version;
    if (loadToken !== state.loadToken) return;
    const parsed = JSON.parse(source.content.replace(/^\uFEFF/u, ""));
    state.document = normalizeCharacterAnimationDocument(parsed);
    state.characterPath = relativePath;
    state.version = String(version).toLowerCase();
    state.sourcePath = state.document.source.path;
    state.clipIndex = 0;
    state.frameIndex = 0;
    state.elapsed = 0;
    state.dirty = false;
    resetHistory(state.document);
    state.conflict = false;
    setConflictActions(false);
    state.savedSerialized = serializeDocument(state.document);
    state.revision += 1;
    elements.characterPathSelect.value = relativePath;
    const image = await loadSourceImage(state.sourcePath);
    if (loadToken !== state.loadToken) return;
    if (!image || state.imagePath !== state.document.source.path) {
      state.image = null;
      state.imagePath = "";
      throw new Error("角色清单与精灵图加载结果不一致，请重新选择资源");
    }
    renderInspector();
    drawPreview();
    drawSpriteSheet();
    setDirty(false);
    setEditorState("ready", `已打开 ${relativePath}`);
  } catch (error) {
    if (resetOnMissing && loadToken === state.loadToken && isMissingCharacterResource(error)) {
      renderEmptyState();
      setEditorState("ready", "工程中没有可用角色清单或精灵图");
      return;
    }
    setEditorState("error", error.message || "无法读取角色动画清单");
  }
}

function isMissingCharacterResource(error) {
  return Number(error?.status ?? error?.statusCode) === 404
    || CHARACTER_RESOURCE_UNAVAILABLE_CODES.has(String(error?.code || ""))
    || /不存在|未找到|不在 .*范围内|not found|无法读取角色|无法读取精灵图/iu.test(String(error?.message || ""));
}

async function createNewCharacter({ path = state.sourcePath, promptForPath = true, resetOnMissing = false } = {}) {
  if (!path) {
    setEditorState("error", "请先选择精灵图");
    return;
  }
  if (!confirmDiscardChanges("当前角色有未保存修改，新建角色会替换当前草稿。继续吗？")) return;
  // A new draft supersedes every in-flight character/image load. Without
  // this fence an older request can finish later and silently replace the
  // user's new draft.
  const loadToken = ++state.loadToken;
  state.sourceLoadToken += 1;
  stopPlayback();
  let relativePath = state.characterPath;
  if (promptForPath) {
    const directory = state.entries.find((entry) => entry.kind === "directory" && entry.path)?.path || "";
    const suggested = relativePath || `${directory ? `${directory}/` : ""}hero.character.json`;
    relativePath = window.prompt("新角色清单路径（工程相对路径）", suggested) || "";
    if (!relativePath) return;
  }
  if (!relativePath) {
    const sourceName = path.split("/").at(-1) || "character.png";
    relativePath = `characters/${sourceName.replace(/\.(?:png|jpe?g|webp)$/iu, "") || "character"}.character.json`;
  }
  if (!relativePath.toLowerCase().endsWith(".character.json")) relativePath = `${relativePath}.character.json`;
  try {
    const image = await loadImage(path);
    if (loadToken !== state.loadToken) return;
    const name = relativePath.split("/").at(-1).replace(/\.character\.json$/iu, "") || "character";
    state.document = createCharacterAnimationDocument({
      name,
      profile: "topdown-rpg",
      sourcePath: path,
      sourceWidth: image.naturalWidth,
      sourceHeight: image.naturalHeight,
      source: {
        frameWidth: image.naturalWidth,
        frameHeight: image.naturalHeight,
        columns: 1,
        rows: 1,
      },
      clips: [{ id: "idle", name: "待机", frames: [{ index: 0, durationMs: 120 }] }],
    });
    state.characterPath = relativePath;
    state.sourcePath = path;
    state.version = null;
    state.image = image;
    state.imagePath = path;
    state.clipIndex = 0;
    state.frameIndex = 0;
    state.elapsed = 0;
    resetHistory(state.document);
    state.savedSerialized = null;
    state.conflict = false;
    setConflictActions(false);
    state.revision += 1;
    setDirty(true);
    renderInspector();
    drawPreview();
    drawSpriteSheet();
    setEditorState("ready", `已创建草稿 ${relativePath}，保存后写入工程`);
  } catch (error) {
    if (loadToken !== state.loadToken) return;
    if (resetOnMissing && isMissingCharacterResource(error)) {
      renderEmptyState();
      setEditorState("ready", "工程中没有可用角色清单或精灵图");
      return;
    }
    setEditorState("error", error.message || "无法创建角色草稿");
  }
}

async function selectSource(relativePath) {
  if (!relativePath || !state.document) return;
  const characterPath = state.characterPath;
  const loadToken = state.loadToken;
  try {
    const image = await loadSourceImage(relativePath);
    if (
      loadToken !== state.loadToken
      || characterPath !== state.characterPath
      || !image
      || state.imagePath !== relativePath
    ) return;
    if (!commitDocument((draft) => {
      draft.source.path = relativePath;
      draft.source.imageWidth = state.image.naturalWidth;
      draft.source.imageHeight = state.image.naturalHeight;
    })) return;
    state.elapsed = 0;
    renderInspector();
    drawPreview();
    drawSpriteSheet();
  } catch (error) {
    setEditorState("error", error.message || "无法读取精灵图");
  }
}

async function openCharacterImageStudio(operation) {
  if (!workspace.session || !state.project) {
    setEditorState("error", "请先打开一个可写的工程");
    return;
  }
  if (!workspace.session.writable) {
    setEditorState("error", "当前工程是只读的，不能保存 AI 生成候选");
    return;
  }
  if (operation === "edit" && (!state.document || !state.sourcePath || !state.image || state.imagePath !== state.document.source.path)) {
    setEditorState("error", "AI 编辑需要先选择当前精灵图");
    return;
  }
  try {
    const module = await import(`/image-studio.js?v=${encodeURIComponent(CHARACTER_EDITOR_ASSET_VERSION)}`);
    await module.openImageStudio({
      assetVersion: CHARACTER_EDITOR_ASSET_VERSION,
      context: "character-editor",
      getProject: () => ({ path: state.project }),
      initialOperation: operation,
      initialSourcePath: operation === "edit" ? state.document?.source.path || state.sourcePath : "",
      initialPrompt: characterImagePrompt(operation),
      initialDestination: "",
      onAttach: (output, policy) => applyCharacterImageCandidate(output, policy),
      onAttachError: (error) => setEditorState("error", error?.message || "无法应用角色候选素材"),
    });
  } catch (error) {
    setEditorState("error", error.message || "无法打开图片工作室");
  }
}

function characterImagePrompt(operation) {
  const profile = CHARACTER_PROFILES.find((entry) => entry.id === state.document?.profile)?.label || "游戏角色";
  if (operation === "edit") {
    return `编辑当前${profile}精灵图。保持角色身份、轮廓、朝向、画布构图和透明背景不变，只根据你接下来补充的要求修改角色细节。保持游戏素材风格，边缘清晰，不要文字、标记或水印。`;
  }
  return `生成一张用于角色编辑器的${profile}游戏角色精灵图。单个角色完整显示在画布中央，透明背景，像素风游戏素材，轮廓清晰，脚底朝向稳定，不要文字、标记、阴影或水印。输出作为单帧精灵图使用。`;
}

async function applyCharacterImageCandidate(output, policy) {
  if (policy?.scope !== "character-editor" || policy?.allowConversationAttachment === true) {
    throw new Error("角色候选的图片上下文无效");
  }
  if (!state.document || !workspace.session) throw new Error("请先打开角色动画文档");
  const relativePath = normalizeCharacterImageOutputPath(output);
  const candidateToken = ++state.sourceLoadToken;
  state.candidateApplying = true;
  renderInspector();
  setEditorState("loading", `正在加载角色候选 ${relativePath}…`);
  try {
    const image = await loadImage(relativePath);
    if (candidateToken !== state.sourceLoadToken) throw new Error("角色候选加载已过期，请重新应用");
    const preserveGrid = canPreserveSpriteGrid(state.document.source, image.naturalWidth, image.naturalHeight);
    if (!commitDocument((draft) => {
      draft.source = preserveGrid
        ? {
          ...draft.source,
          path: relativePath,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
        }
        : {
          ...draft.source,
          path: relativePath,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          frameWidth: image.naturalWidth,
          frameHeight: image.naturalHeight,
          columns: 1,
          rows: 1,
          marginX: 0,
          marginY: 0,
          spacingX: 0,
          spacingY: 0,
        };
      if (!preserveGrid) {
        for (const clip of draft.clips) {
          for (const frame of clip.frames) frame.index = 0;
        }
        draft.render = {
          ...draft.render,
          anchor: {
            ...draft.render.anchor,
            x: image.naturalWidth / 2,
            y: image.naturalHeight,
          },
        };
      }
    }, { render: false })) throw new Error("角色候选没有产生有效修改");
    state.image = image;
    state.imagePath = relativePath;
    state.sourcePath = relativePath;
    state.elapsed = 0;
    state.frameIndex = 0;
    elements.sourcePathSelect.value = relativePath;
    elements.imageSizeLabel.textContent = `图片：${image.naturalWidth} × ${image.naturalHeight}`;
    renderInspector();
    drawPreview();
    drawSpriteSheet();
    try {
      await loadEntries();
      elements.characterPathSelect.value = state.characterPath;
      elements.sourcePathSelect.value = relativePath;
    } catch {
      // The generated file is already saved. A stale resource index must not
      // undo the candidate application or discard the local character draft.
    }
    setEditorState(
      "ready",
      `已加入角色候选 ${relativePath}${preserveGrid ? "，已保留原精灵图网格" : "，已安全重置为 1×1 精灵图"}；保存角色清单后生效`,
    );
  } finally {
    state.candidateApplying = false;
    renderInspector();
  }
}

function normalizeCharacterImageOutputPath(output) {
  const relativePath = String(output?.relativePath || "").trim();
  if (!relativePath) throw new Error("图片结果没有工程相对路径，无法加入角色候选");
  const normalized = normalizeProjectRelativePath(relativePath);
  if (!/\.(?:png|jpe?g|webp)$/iu.test(normalized)) {
    throw new Error("角色候选必须是 PNG、JPG 或 WebP 图片");
  }
  if (!String(output?.mediaType || "image/png").startsWith("image/")) {
    throw new Error("图片结果类型无效，无法加入角色候选");
  }
  return normalized;
}

function canPreserveSpriteGrid(source, imageWidth, imageHeight) {
  if (
    Number(source?.imageWidth) !== imageWidth
    || Number(source?.imageHeight) !== imageHeight
    || Number(source?.columns) < 1
    || Number(source?.rows) < 1
  ) return false;
  const width = Number(source.marginX) + Number(source.columns) * Number(source.frameWidth)
    + Math.max(0, Number(source.columns) - 1) * Number(source.spacingX) + Number(source.marginX);
  const height = Number(source.marginY) + Number(source.rows) * Number(source.frameHeight)
    + Math.max(0, Number(source.rows) - 1) * Number(source.spacingY) + Number(source.marginY);
  return width <= imageWidth && height <= imageHeight;
}

async function loadSourceImage(relativePath) {
  if (!workspace.session) throw new Error("项目工作区尚未打开");
  const loadToken = ++state.sourceLoadToken;
  const image = await loadImage(relativePath);
  if (loadToken !== state.sourceLoadToken) return null;
  state.image = image;
  state.imagePath = relativePath;
  state.sourcePath = relativePath;
  elements.sourcePathSelect.value = relativePath;
  elements.imageSizeLabel.textContent = `图片：${image.naturalWidth} × ${image.naturalHeight}`;
  return image;
}

function loadImage(relativePath) {
  const cached = state.imageCache.get(relativePath);
  if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      state.imageCache.set(relativePath, image);
      resolve(image);
    };
    image.onerror = () => reject(new Error(`无法读取精灵图：${relativePath}`));
    image.src = workspace.resourceImageUrl(relativePath);
  });
}

function updateFromInspector() {
  if (!state.document) return false;
  const clip = state.document.clips[state.clipIndex];
  if (!clip) return false;
  const source = state.document.source;
  const committed = commitDocument((draft) => {
    draft.name = elements.nameInput.value;
    draft.profile = elements.profileSelect.value;
    draft.source = {
      ...draft.source,
      path: elements.sourcePathSelect.value || state.sourcePath,
      frameWidth: readInteger(elements.frameWidthInput, source.frameWidth),
      frameHeight: readInteger(elements.frameHeightInput, source.frameHeight),
      columns: readInteger(elements.columnsInput, source.columns),
      rows: readInteger(elements.rowsInput, source.rows),
      marginX: readInteger(elements.marginXInput, source.marginX),
      marginY: readInteger(elements.marginYInput, source.marginY),
      spacingX: readInteger(elements.spacingXInput, source.spacingX),
      spacingY: readInteger(elements.spacingYInput, source.spacingY),
    };
    draft.render = {
      ...draft.render,
      referenceHeight: readInteger(elements.referenceHeightInput, draft.render.referenceHeight),
      anchor: {
        ...draft.render.anchor,
        x: readNumber(elements.anchorXInput, draft.render.anchor.x, "锚点 X"),
        y: readNumber(elements.anchorYInput, draft.render.anchor.y, "锚点 Y"),
      },
    };
    draft.clips[state.clipIndex] = {
      ...clip,
      id: elements.clipIdInput.value,
      name: elements.clipNameInput.value,
      direction: elements.clipDirectionSelect.value,
      loop: elements.clipLoopInput.checked,
    };
  }, { render: false });
  if (!committed) return false;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
  return true;
}

function commitDocument(mutator, { render = true } = {}) {
  if (!state.document) return false;
  const before = serializeDocument(state.document);
  const draft = structuredClone(state.document);
  try {
    mutator(draft);
    const next = normalizeCharacterAnimationDocument(draft);
    if (serializeDocument(next) === before) {
      setValidation("");
      return true;
    }
    state.undoStack.push(structuredClone(state.document));
    if (state.undoStack.length > 100) state.undoStack.shift();
    state.redoStack = [];
    state.document = next;
    state.revision += 1;
    setValidation("");
    updateDirtyFromDocument();
    if (render) renderInspector();
    return true;
  } catch (error) {
    setValidation(error.message || "角色动画参数无效");
    return false;
  }
}

function renderInspector() {
  const animationDocument = state.document;
  if (!animationDocument) {
    elements.saveCharacterButton.disabled = true;
    elements.addClipButton.disabled = true;
    elements.addFrameButton.disabled = true;
    elements.aiGenerateButton.disabled = !workspace.session?.writable || state.candidateApplying;
    elements.aiEditButton.disabled = true;
    return;
  }
  const source = animationDocument.source;
  elements.nameInput.value = animationDocument.name;
  elements.profileSelect.value = animationDocument.profile;
  for (const [id, value] of [
    ["frameWidthInput", source.frameWidth], ["frameHeightInput", source.frameHeight],
    ["columnsInput", source.columns], ["rowsInput", source.rows], ["marginXInput", source.marginX],
    ["marginYInput", source.marginY], ["spacingXInput", source.spacingX], ["spacingYInput", source.spacingY],
    ["referenceHeightInput", animationDocument.render.referenceHeight], ["anchorXInput", animationDocument.render.anchor.x],
    ["anchorYInput", animationDocument.render.anchor.y],
  ]) elements[id].value = String(value);
  elements.sourcePathSelect.value = animationDocument.source.path;
  elements.saveCharacterButton.disabled = !workspace.session || !state.characterPath || !state.dirty;
  elements.aiGenerateButton.disabled = !workspace.session?.writable || state.candidateApplying;
  elements.aiEditButton.disabled = !workspace.session?.writable
    || !state.image
    || state.imagePath !== animationDocument.source.path
    || state.candidateApplying;
  elements.undoButton.disabled = !state.undoStack.length;
  elements.redoButton.disabled = !state.redoStack.length;
  elements.addClipButton.disabled = !workspace.session;
  elements.addFrameButton.disabled = !workspace.session;
  const hasMultipleClips = animationDocument.clips.length > 1;
  elements.moveClipUpButton.disabled = !workspace.session || state.clipIndex <= 0;
  elements.moveClipDownButton.disabled = !workspace.session || state.clipIndex >= animationDocument.clips.length - 1;
  elements.duplicateClipButton.disabled = !workspace.session;
  elements.deleteClipButton.disabled = !workspace.session || !hasMultipleClips;
  elements.previousFrameButton.disabled = !state.image;
  elements.nextFrameButton.disabled = !state.image;
  elements.playButton.disabled = !state.image;

  elements.clipSelect.replaceChildren();
  animationDocument.clips.forEach((clip, index) => elements.clipSelect.append(new Option(`${clip.name} · ${clip.id}`, String(index))));
  elements.clipSelect.disabled = !animationDocument.clips.length;
  state.clipIndex = Math.min(state.clipIndex, Math.max(0, animationDocument.clips.length - 1));
  elements.clipSelect.value = String(state.clipIndex);
  const clip = animationDocument.clips[state.clipIndex];
  if (!clip) return;
  elements.clipIdInput.value = clip.id;
  elements.clipNameInput.value = clip.name;
  elements.clipDirectionSelect.value = clip.direction || "forward";
  elements.clipLoopInput.checked = clip.loop !== false;
  elements.frameList.replaceChildren();
  clip.frames.forEach((frame, index) => {
    const row = globalThis.document.createElement("div");
    row.className = "frame-row";
    row.dataset.selected = String(index === state.frameIndex);
    row.addEventListener("click", () => {
      state.frameIndex = index;
      drawPreview();
      drawSpriteSheet();
      renderInspector();
    });
    const frameInput = field("帧索引", frame.index, "number");
    const durationInput = field("时长 ms", frame.durationMs, "number");
    frameInput.input.min = "0";
    frameInput.input.addEventListener("input", () => updateFrame(index, "index", frameInput.input.value));
    durationInput.input.min = "1";
    durationInput.input.addEventListener("input", () => updateFrame(index, "durationMs", durationInput.input.value));
    const remove = globalThis.document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFrame(index);
    });
    const duplicate = actionButton("复制", (event) => {
      event.stopPropagation();
      duplicateFrame(index);
    });
    const moveUp = actionButton("↑", (event) => {
      event.stopPropagation();
      moveTimelineFrame(index, -1);
    });
    const moveDown = actionButton("↓", (event) => {
      event.stopPropagation();
      moveTimelineFrame(index, 1);
    });
    const actions = globalThis.document.createElement("div");
    actions.className = "inline-actions";
    actions.append(moveUp, moveDown, duplicate, remove);
    row.append(frameInput.label, durationInput.label, actions);
    elements.frameList.append(row);
  });
}

function actionButton(label, handler) {
  const button = globalThis.document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function field(labelText, value, type) {
  const label = globalThis.document.createElement("label");
  label.textContent = labelText;
  const input = globalThis.document.createElement("input");
  input.type = type;
  input.value = String(value);
  label.append(input);
  return { label, input };
}

function updateFrame(index, key, value) {
  commitDocument((draft) => {
    draft.clips[state.clipIndex].frames[index][key] = Number(value);
  }, { render: false });
  drawPreview();
  drawSpriteSheet();
}

function addFrame() {
  if (!state.document) return;
  if (!commitDocument((draft) => {
    draft.clips[state.clipIndex].frames.push({ index: 0, durationMs: 120 });
  })) return;
  state.frameIndex = state.document.clips[state.clipIndex].frames.length - 1;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function removeFrame(index) {
  if (!state.document || state.document.clips[state.clipIndex].frames.length <= 1) return;
  if (!commitDocument((draft) => draft.clips[state.clipIndex].frames.splice(index, 1))) return;
  state.frameIndex = Math.min(state.frameIndex, state.document.clips[state.clipIndex].frames.length - 1);
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function duplicateFrame(index) {
  if (!state.document) return;
  if (!commitDocument((draft) => {
    const frames = draft.clips[state.clipIndex].frames;
    frames.splice(index + 1, 0, structuredClone(frames[index]));
  })) return;
  state.frameIndex = index + 1;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function moveTimelineFrame(index, delta) {
  if (!state.document) return;
  const target = index + delta;
  const frames = state.document.clips[state.clipIndex]?.frames || [];
  if (target < 0 || target >= frames.length) return;
  if (!commitDocument((draft) => {
    const draftFrames = draft.clips[state.clipIndex].frames;
    [draftFrames[index], draftFrames[target]] = [draftFrames[target], draftFrames[index]];
  })) return;
  state.frameIndex = target;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function addClip() {
  if (!state.document) return;
  const id = nextClipId(state.document.clips, `clip-${state.document.clips.length + 1}`);
  if (!commitDocument((draft) => draft.clips.push({ id, name: "新动作", frames: [{ index: 0, durationMs: 120 }] }))) return;
  state.clipIndex = state.document.clips.length - 1;
  state.frameIndex = 0;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function duplicateClip() {
  if (!state.document) return;
  const source = state.document.clips[state.clipIndex];
  if (!source) return;
  const id = nextClipId(state.document.clips, `${source.id}-copy`);
  if (!commitDocument((draft) => {
    const copy = structuredClone(draft.clips[state.clipIndex]);
    copy.id = id;
    copy.name = `${copy.name} 副本`;
    draft.clips.splice(state.clipIndex + 1, 0, copy);
  })) return;
  state.clipIndex += 1;
  state.frameIndex = 0;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function deleteClip() {
  if (!state.document || state.document.clips.length <= 1) return;
  if (!globalThis.confirm?.("删除当前动作及其时间轴帧？")) return;
  if (!commitDocument((draft) => draft.clips.splice(state.clipIndex, 1))) return;
  state.clipIndex = Math.min(state.clipIndex, state.document.clips.length - 1);
  state.frameIndex = 0;
  state.elapsed = 0;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function moveClip(delta) {
  if (!state.document) return;
  const target = state.clipIndex + delta;
  if (target < 0 || target >= state.document.clips.length) return;
  if (!commitDocument((draft) => {
    [draft.clips[state.clipIndex], draft.clips[target]] = [draft.clips[target], draft.clips[state.clipIndex]];
  })) return;
  state.clipIndex = target;
  state.frameIndex = Math.min(state.frameIndex, state.document.clips[target].frames.length - 1);
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function nextClipId(clips, preferred) {
  const ids = new Set(clips.map((clip) => clip.id));
  if (!ids.has(preferred)) return preferred;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (candidate.length <= 64 && !ids.has(candidate)) return candidate;
  }
  return `clip-${Date.now().toString(36)}`.slice(0, 64);
}

async function saveCharacter() {
  if (!state.document || !state.characterPath || !workspace.session || state.saving) return;
  if (!updateFromInspector()) return;
  const saveToken = ++state.saveToken;
  const saveProjectLoadToken = state.projectLoadToken;
  const saveLoadToken = state.loadToken;
  const saveSessionId = workspace.session.id;
  const saveCharacterPath = state.characterPath;
  const savedRevision = state.revision;
  const savedSerialized = serializeDocument(state.document);
  const isCurrentSave = () => saveToken === state.saveToken
    && saveProjectLoadToken === state.projectLoadToken
    && saveLoadToken === state.loadToken
    && saveSessionId === workspace.session?.id
    && saveCharacterPath === state.characterPath;
  state.saving = true;
  elements.saveCharacterButton.disabled = true;
  try {
    setEditorState("loading", `正在保存 ${saveCharacterPath}…`);
    const result = await workspace.saveCharacterAnimation({
      relativePath: saveCharacterPath,
      document: state.document,
      expectedVersion: state.version,
    });
    if (!isCurrentSave()) return;
    state.version = result.version;
    state.savedSerialized = savedSerialized;
    state.conflict = false;
    setConflictActions(false);
    const changedDuringSave = state.revision !== savedRevision;
    updateDirtyFromDocument();
    await loadEntries();
    if (!isCurrentSave()) return;
    elements.characterPathSelect.value = saveCharacterPath;
    setEditorState(
      "ready",
      changedDuringSave
        ? `已保存 ${saveCharacterPath} · 期间又有新修改，请再次保存`
        : `已保存 ${saveCharacterPath} · ${result.version.slice(0, 12)}`,
    );
  } catch (error) {
    if (!isCurrentSave()) return;
    const message = error.message || "保存失败；请重新读取后解决版本冲突";
    const versionConflict = isCharacterVersionConflict(error);
    if (versionConflict) {
      state.conflict = true;
      let detail = `${message} 路径：${saveCharacterPath}；本地草稿仍保留。`;
      if (state.version) detail += ` 本地基线：${state.version.slice(0, 12)}。`;
      try {
        const latest = await workspace.readResourceVersion(saveCharacterPath, "character");
        if (!isCurrentSave()) return;
        detail += ` 服务端最新：${latest.version.slice(0, 12)}。`;
      } catch {
        if (!isCurrentSave()) return;
        detail += " 暂时无法读取服务端最新版本。";
      }
      setConflictActions(true, detail);
    } else {
      state.conflict = false;
      setConflictActions(false);
    }
    setEditorState(
      "error",
      versionConflict || Number(error?.status ?? error?.statusCode) === 409 || /版本冲突|已存在|conflict|exists/iu.test(message)
        ? `${message} 当前修改仍保留在内存。`
        : message,
    );
  } finally {
    if (isCurrentSave()) {
      state.saving = false;
      renderInspector();
    }
  }
}

function isCharacterVersionConflict(error) {
  if (Number(error?.status ?? error?.statusCode) !== 409) return false;
  if (error?.code === "wfl-character-animation-exists") return false;
  return !error?.code || CHARACTER_VERSION_CONFLICT_CODES.has(error.code);
}

async function reloadRemoteCharacter() {
  if (!state.characterPath) return;
  if (!confirmDiscardChanges("放弃本地草稿并读取远程版本？此操作不可撤销。")) return;
  await loadCharacter(state.characterPath);
}

async function saveDraftAs() {
  if (!state.document || !state.characterPath || state.saving) return;
  const currentName = state.characterPath.split("/").at(-1) || "character.character.json";
  const suggested = currentName.replace(/\.character\.json$/iu, ".draft.character.json");
  const directory = state.characterPath.split("/").slice(0, -1).join("/");
  const value = globalThis.prompt?.("另存为新的角色清单路径（工程相对路径）", `${directory ? `${directory}/` : ""}${suggested}`) || "";
  if (!value) return;
  let relativePath;
  try {
    relativePath = normalizeProjectRelativePath(value);
    if (!relativePath.toLowerCase().endsWith(".character.json")) relativePath = `${relativePath}.character.json`;
  } catch (error) {
    setEditorState("error", error.message || "另存路径无效");
    return;
  }
  state.characterPath = relativePath;
  state.version = null;
  setConflictActions(false);
  await saveCharacter();
}

function downloadLocalDraft() {
  if (!state.document || !state.characterPath) return;
  const blob = new Blob([`${JSON.stringify(state.document, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = state.characterPath.split("/").at(-1) || "character.character.json";
  anchor.click();
  URL.revokeObjectURL(url);
  setEditorState("ready", "本地草稿已下载；远程文件未被覆盖");
}

function moveFrame(delta) {
  if (!state.document) return;
  const frames = state.document.clips[state.clipIndex]?.frames || [];
  if (!frames.length) return;
  state.frameIndex = (state.frameIndex + delta + frames.length) % frames.length;
  drawPreview();
  drawSpriteSheet();
}

function togglePlayback() {
  if (state.playing) stopPlayback();
  else {
    if (!state.document?.clips[state.clipIndex]?.frames?.length) return;
    state.playing = true;
    state.elapsed = 0;
    state.frameIndex = 0;
    state.lastFrameAt = performance.now();
    elements.playButton.textContent = "暂停";
    state.animationFrame = requestAnimationFrame(playFrame);
  }
}

function stopPlayback() {
  state.playing = false;
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
  elements.playButton.textContent = "播放";
}

function playFrame(now) {
  if (!state.playing || !state.document) return;
  const clip = state.document.clips[state.clipIndex];
  if (!clip) {
    stopPlayback();
    return;
  }
  state.elapsed += Math.max(0, now - state.lastFrameAt);
  state.lastFrameAt = now;
  const duration = clipDurationMs(clip);
  if (clip.loop === false && state.elapsed >= duration) {
    state.elapsed = duration;
    const terminalFrame = clipFrameAt(clip, state.elapsed);
    const terminalIndex = clip.frames.indexOf(terminalFrame);
    if (terminalIndex >= 0) state.frameIndex = terminalIndex;
    drawPreview();
    drawSpriteSheet();
    stopPlayback();
    return;
  }
  const frame = clipFrameAt(clip, state.elapsed);
  const index = clip.frames.indexOf(frame);
  if (index >= 0) state.frameIndex = index;
  drawPreview();
  drawSpriteSheet();
  state.animationFrame = requestAnimationFrame(playFrame);
}

function drawPreview() {
  const canvas = elements.characterCanvas;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const animationDocument = state.document;
  const image = state.image;
  if (!animationDocument || !image || state.imagePath !== animationDocument.source.path) {
    elements.canvasEmpty.hidden = false;
    elements.frameLabel.textContent = "帧：—";
    return;
  }
  elements.canvasEmpty.hidden = true;
  const clip = animationDocument.clips[state.clipIndex];
  const frame = clip?.frames[state.frameIndex] || clip?.frames[0];
  const rect = frameRect(animationDocument.source, frame?.index || 0);
  const scale = Math.min(10, 430 / Math.max(rect.width, rect.height));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const x = Math.round((canvas.width - width) / 2);
  const y = Math.round((canvas.height - height) / 2);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, x, y, width, height);
  const anchor = animationDocument.render.anchor;
  context.strokeStyle = "#69a8ff";
  context.beginPath();
  context.moveTo(x + anchor.x * scale, y);
  context.lineTo(x + anchor.x * scale, y + height);
  context.moveTo(x, y + anchor.y * scale);
  context.lineTo(x + width, y + anchor.y * scale);
  context.stroke();
  elements.frameLabel.textContent = `帧：${frame?.index ?? 0} · ${rect.width}×${rect.height}`;
}

function drawSpriteSheet() {
  const canvas = elements.spriteSheetCanvas;
  const context = canvas.getContext("2d");
  const image = state.image;
  const animationDocument = state.document;
  if (!image || !animationDocument) {
    canvas.width = 1;
    canvas.height = 1;
    context.clearRect(0, 0, 1, 1);
    return;
  }
  const scale = Math.min(1, 640 / image.naturalWidth, 220 / image.naturalHeight);
  state.spriteSheetScale = scale;
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const source = animationDocument.source;
  const selectedFrame = animationDocument.clips[state.clipIndex]?.frames[state.frameIndex]?.index;
  for (let index = 0; index < source.columns * source.rows; index += 1) {
    const rect = frameRect(source, index);
    const isSelected = index === selectedFrame;
    context.strokeStyle = isSelected ? "#ffd479" : "rgb(105 168 255 / 58%)";
    context.lineWidth = isSelected ? 2 : 1;
    context.strokeRect(rect.x * scale + 0.5, rect.y * scale + 0.5, rect.width * scale, rect.height * scale);
  }
}

function selectSpriteFrame(event) {
  const image = state.image;
  const animationDocument = state.document;
  if (!image || !animationDocument) return;
  const rect = elements.spriteSheetCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = ((event.clientX - rect.left) / rect.width) * image.naturalWidth;
  const y = ((event.clientY - rect.top) / rect.height) * image.naturalHeight;
  const source = animationDocument.source;
  const column = Math.floor((x - source.marginX) / (source.frameWidth + source.spacingX));
  const row = Math.floor((y - source.marginY) / (source.frameHeight + source.spacingY));
  if (column < 0 || row < 0 || column >= source.columns || row >= source.rows) return;
  const localX = x - (source.marginX + column * (source.frameWidth + source.spacingX));
  const localY = y - (source.marginY + row * (source.frameHeight + source.spacingY));
  if (localX >= source.frameWidth || localY >= source.frameHeight) return;
  const frameIndex = row * source.columns + column;
  const clip = animationDocument.clips[state.clipIndex];
  if (!clip?.frames.length) return;
  state.frameIndex = Math.min(state.frameIndex, clip.frames.length - 1);
  if (!commitDocument((draft) => {
    draft.clips[state.clipIndex].frames[state.frameIndex].index = frameIndex;
  }, { render: false })) return;
  renderInspector();
  drawPreview();
  drawSpriteSheet();
}

function clearCharacterState() {
  state.saveToken += 1;
  state.saving = false;
  state.document = null;
  state.image = null;
  state.imagePath = "";
  state.sourcePath = "";
  state.version = null;
  state.characterPath = "";
  state.savedSerialized = null;
  state.conflict = false;
  resetHistory(null);
  setConflictActions(false);
  setDirty(false);
  elements.characterPathSelect.value = "";
  elements.sourcePathSelect.value = "";
  elements.saveCharacterButton.disabled = true;
  elements.aiEditButton.disabled = true;
  drawPreview();
  drawSpriteSheet();
}

function renderEmptyState() {
  clearCharacterState();
  elements.saveCharacterButton.disabled = true;
  elements.newCharacterButton.disabled = !state.entries.some((entry) =>
    entry.kind === "image" && /\.(?:png|jpe?g|webp)$/iu.test(entry.path));
  elements.aiGenerateButton.disabled = !workspace.session?.writable;
  elements.aiEditButton.disabled = true;
  elements.projectState.textContent = state.project
    ? "当前工程中还没有可用角色或精灵图"
    : "尚未打开项目";
}

function setDirty(value) {
  state.dirty = Boolean(value);
  elements.dirtyLabel.dataset.state = state.dirty ? "dirty" : "clean";
  elements.dirtyLabel.textContent = state.dirty ? "有未保存修改" : "未修改";
  elements.saveCharacterButton.disabled = !workspace.session || !state.characterPath || !state.dirty;
}

function updateDirtyFromDocument() {
  const serialized = state.document ? serializeDocument(state.document) : null;
  setDirty(state.savedSerialized === null ? Boolean(serialized) : serialized !== state.savedSerialized);
}

function serializeDocument(value) {
  return value ? JSON.stringify(value) : null;
}

function resetHistory(documentValue) {
  state.undoStack = [];
  state.redoStack = [];
  if (documentValue) state.savedSerialized = serializeDocument(documentValue);
  elements.undoButton.disabled = true;
  elements.redoButton.disabled = true;
}

function undo() {
  if (!state.document || !state.undoStack.length) return;
  state.redoStack.push(structuredClone(state.document));
  state.document = normalizeCharacterAnimationDocument(state.undoStack.pop());
  state.revision += 1;
  state.frameIndex = Math.min(state.frameIndex, state.document.clips[state.clipIndex]?.frames.length - 1 || 0);
  updateDirtyFromDocument();
  setValidation("");
  renderInspector();
  drawPreview();
  drawSpriteSheet();
  void restoreDocumentImage();
}

function redo() {
  if (!state.document || !state.redoStack.length) return;
  state.undoStack.push(structuredClone(state.document));
  state.document = normalizeCharacterAnimationDocument(state.redoStack.pop());
  state.revision += 1;
  state.frameIndex = Math.min(state.frameIndex, state.document.clips[state.clipIndex]?.frames.length - 1 || 0);
  updateDirtyFromDocument();
  setValidation("");
  renderInspector();
  drawPreview();
  drawSpriteSheet();
  void restoreDocumentImage();
}

async function restoreDocumentImage() {
  const relativePath = state.document?.source?.path;
  if (!relativePath || state.imagePath === relativePath) return;
  const restoreToken = ++state.sourceLoadToken;
  try {
    const image = await loadImage(relativePath);
    if (restoreToken !== state.sourceLoadToken || state.document?.source?.path !== relativePath) return;
    state.image = image;
    state.imagePath = relativePath;
    state.sourcePath = relativePath;
    elements.sourcePathSelect.value = relativePath;
    elements.imageSizeLabel.textContent = `图片：${image.naturalWidth} × ${image.naturalHeight}`;
    drawPreview();
    drawSpriteSheet();
  } catch (error) {
    setEditorState("error", error.message || "无法恢复角色精灵图预览");
  }
}

function confirmDiscardChanges(message) {
  if (!state.dirty) return true;
  return typeof globalThis.confirm === "function" && globalThis.confirm(message);
}

function setConflictActions(visible, detail = "本地草稿仍保留。请选择如何恢复。") {
  const canShow = Boolean(visible && state.document && state.characterPath);
  state.conflict = canShow;
  elements.conflictActions.hidden = !canShow;
  elements.conflictDetail.textContent = detail;
}

function setValidation(message) {
  elements.validationMessage.textContent = message || "";
}

function setEditorState(kind, message) {
  app.dataset.state = kind;
  app.setAttribute("aria-busy", String(kind === "loading"));
  elements.characterNotice.dataset.state = kind;
  elements.characterNotice.textContent = message;
}

function readInteger(input, fallback) {
  const raw = String(input?.value ?? "").trim();
  if (!raw) throw new RangeError("整数不能为空");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RangeError("请输入有效整数");
  return value;
}

function readNumber(input, fallback, label) {
  const raw = String(input?.value ?? "").trim();
  if (!raw) throw new RangeError(`${label}不能为空`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new RangeError(`${label}必须是有效数字`);
  return value;
}
