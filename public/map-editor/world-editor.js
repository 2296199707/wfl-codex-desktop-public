import { MapProjectWorkspaceClient } from "../map-project-session.js?v=0.44.56-beta";
import { createMapAccountSessionGuard } from "./map-account-session-guard.js?v=0.44.56-beta";
import { parseTiledDocument } from "./tiled-document.js?v=0.44.56-beta";
import { decodeTiledTileData } from "./tiled-tile-codec.js?v=0.44.56-beta";
import {
  mapPixelBounds,
  tiledObjectScreenBounds,
  tiledTileRegionBounds,
} from "./tiled-render-model.js?v=0.44.56-beta";
import {
  TiledWorldEditDocument,
  adjacentWorldMapIndexes,
  parseTiledWorld,
  resolveWorldMapReference,
  serializeTiledWorld,
  worldBounds,
  worldMapAtPoint,
  worldMapReference,
} from "./tiled-world.js?v=0.44.56-beta";
import {
  collectWorldMapNavigation,
  planWorldMapPreviews,
  validateWorldPortalReferences,
} from "./tiled-world-navigation.js?v=0.44.56-beta";

const elements = Object.fromEntries([
  "worldApp", "worldTitle", "worldMeta", "saveButton", "undoButton", "redoButton",
  "addMapButton", "panelAddMapButton", "removeMapButton", "openMapButton", "zoomOutButton",
  "zoomInButton", "zoomLabel", "fitButton", "closeButton", "mapCount", "mapList", "worldStage",
  "worldCanvas", "loadState", "loadTitle", "loadDetail", "retryButton", "selectToolButton",
  "handToolButton", "selectedMapPath", "mapInspectorForm", "mapX", "mapY", "mapWidth",
  "mapHeight", "applyBoundsButton", "adjacentMapsToggle", "patternCount", "patternsInput",
  "applyPatternsButton", "inspectorState", "worldState", "coordinates", "selectionState",
  "documentState", "addMapDialog", "addMapForm", "addMapCloseButton", "addMapPath",
  "mapPathOptions", "addMapX", "addMapY", "addMapWidth", "addMapHeight", "addMapState",
  "addMapCancelButton", "addMapSubmitButton", "closeDialog", "closeCancelButton",
  "discardCloseButton", "saveCloseButton", "mapsPanelButton", "inspectorPanelButton",
  "navigationCheckButton", "navigationState", "navigationList", "navigationCount",
].map((id) => [id, document.getElementById(id)]));

const state = {
  credentials: null,
  session: null,
  parsed: null,
  editor: null,
  unsubscribe: null,
  projectClient: null,
  selectedFileName: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  tool: "select",
  pointer: null,
  dragPreview: null,
  saving: false,
  loading: false,
  closing: false,
  projectReady: false,
  mapOptionsLoading: false,
  mapPreviews: new Map(),
  previewRevision: 0,
  previewWork: Promise.resolve(),
  navigationChecking: false,
  navigationResult: null,
  navigationLoadErrors: [],
  navigationRevision: 0,
  accountSessionGuard: null,
};

const context = elements.worldCanvas.getContext("2d", { alpha: false });
const resizeObserver = new ResizeObserver(() => resizeCanvas());
resizeObserver.observe(elements.worldStage);
bindEvents();
refreshIcons();
void initialize();

async function initialize() {
  try {
    state.credentials = await readCredentials();
    if (!state.credentials.accountId) throw new Error("World 账号绑定缺失，请从当前账号的地图项目重新打开");
    state.accountSessionGuard = createMapAccountSessionGuard({
      accountId: state.credentials.accountId,
      onInvalidated: invalidateWorldAccountSession,
    });
    const accountStatus = await state.accountSessionGuard.check();
    if (accountStatus === "invalidated") return;
    state.accountSessionGuard.start();
    await loadWorld();
  } catch (error) {
    showLoadError(error);
  }
}

function bindEvents() {
  elements.saveButton.addEventListener("click", () => void saveWorld());
  elements.undoButton.addEventListener("click", () => {
    if (state.editor?.undo()) reconcileSelection();
  });
  elements.redoButton.addEventListener("click", () => {
    if (state.editor?.redo()) reconcileSelection();
  });
  for (const button of [elements.addMapButton, elements.panelAddMapButton]) {
    button.addEventListener("click", () => void openAddMapDialog());
  }
  elements.removeMapButton.addEventListener("click", removeSelectedMap);
  elements.openMapButton.addEventListener("click", () => void openSelectedMap());
  elements.zoomOutButton.addEventListener("click", () => zoomAt(1 / 1.2));
  elements.zoomInButton.addEventListener("click", () => zoomAt(1.2));
  elements.fitButton.addEventListener("click", fitWorld);
  elements.closeButton.addEventListener("click", requestClose);
  elements.retryButton.addEventListener("click", () => void loadWorld().catch(showLoadError));
  elements.selectToolButton.addEventListener("click", () => setTool("select"));
  elements.handToolButton.addEventListener("click", () => setTool("hand"));
  elements.mapInspectorForm.addEventListener("submit", applySelectedBounds);
  elements.adjacentMapsToggle.addEventListener("change", () => {
    try {
      state.editor?.setOnlyShowAdjacentMaps(elements.adjacentMapsToggle.checked);
    } catch (error) {
      showInspectorError(error);
    }
  });
  elements.applyPatternsButton.addEventListener("click", applyPatterns);
  elements.navigationCheckButton.addEventListener("click", () => void checkWorldNavigation());
  elements.addMapForm.addEventListener("submit", submitAddMap);
  elements.addMapCloseButton.addEventListener("click", closeAddMapDialog);
  elements.addMapCancelButton.addEventListener("click", closeAddMapDialog);
  elements.closeCancelButton.addEventListener("click", () => elements.closeDialog.close());
  elements.discardCloseButton.addEventListener("click", () => void closeWorldSession());
  elements.saveCloseButton.addEventListener("click", async () => {
    if (await saveWorld()) await closeWorldSession();
  });
  elements.worldCanvas.addEventListener("pointerdown", beginPointer);
  elements.worldCanvas.addEventListener("pointermove", movePointer);
  elements.worldCanvas.addEventListener("pointerup", finishPointer);
  elements.worldCanvas.addEventListener("pointercancel", cancelPointer);
  elements.worldCanvas.addEventListener("dblclick", (event) => {
    const hit = hitMap(canvasPoint(event));
    if (hit) {
      selectMap(hit.map.fileName);
      void openSelectedMap();
    }
  });
  elements.worldCanvas.addEventListener("wheel", handleWheel, { passive: false });
  elements.mapsPanelButton?.addEventListener("click", () => toggleMobilePanel("maps"));
  elements.inspectorPanelButton?.addEventListener("click", () => toggleMobilePanel("inspector"));
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("beforeunload", (event) => {
    if (!state.editor?.dirty || state.closing) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted && !state.closing) void releaseSessions({ keepalive: true });
  });
}

async function loadWorld() {
  if (!state.credentials || state.loading) return;
  state.loading = true;
  setLoading("正在读取 World", "0%");
  try {
    const { session } = await worldFetch(`/api/map-worlds/sessions/${encodeURIComponent(state.credentials.sessionId)}`);
    if (session.documentKind !== "world") throw new Error("服务端返回的不是 World 文档会话");
    state.session = session;
    const source = await readWorldSource(session);
    setLoading("正在校验 World", "90%");
    const parsed = parseTiledWorld(source, { sourcePath: session.relativePath });
    state.unsubscribe?.();
    state.parsed = parsed;
    state.editor = new TiledWorldEditDocument(parsed.document, { sourcePath: session.relativePath });
    state.unsubscribe = state.editor.subscribe(() => {
      invalidateNavigationCheck();
      renderAll();
      schedulePreviewReconcile();
    });
    reconcileSelection();
    await connectProject().catch((error) => {
      state.projectReady = false;
      showInspectorError(error);
    });
    elements.worldApp.dataset.state = "ready";
    elements.loadState.hidden = true;
    renderAll();
    schedulePreviewReconcile();
    requestAnimationFrame(fitWorld);
  } finally {
    state.loading = false;
  }
}

async function connectProject() {
  await state.projectClient?.close().catch(() => {});
  const client = new MapProjectWorkspaceClient();
  state.projectClient = client;
  await client.open({
    project: state.credentials.projectPath,
    projectFile: state.credentials.projectFile,
  });
  state.projectReady = true;
}

async function readWorldSource(session) {
  let offset = 0;
  let source = "";
  while (offset < session.size) {
    const chunk = await worldFetch(
      `/api/map-worlds/sessions/${encodeURIComponent(session.id)}/content?version=${encodeURIComponent(session.version)}&offset=${offset}`,
    );
    if (chunk.offset !== offset || chunk.nextOffset <= offset) throw new Error("World 分段读取位置无效");
    source += chunk.content;
    offset = chunk.nextOffset;
    setLoading("正在读取 World", `${Math.min(89, Math.round(offset / session.size * 89))}%`);
  }
  return source;
}

function renderAll() {
  renderHeader();
  renderMapList();
  renderInspector();
  renderToolbar();
  renderNavigation();
  drawWorld();
}

function renderHeader() {
  const relativePath = state.session?.relativePath || "";
  elements.worldTitle.textContent = relativePath.split("/").at(-1) || "World 编辑器";
  elements.worldMeta.textContent = relativePath || "正在建立会话";
  const dirty = state.editor?.dirty === true;
  const writable = state.session?.writable === true;
  elements.worldState.dataset.status = state.editor ? "ready" : "loading";
  elements.worldState.innerHTML = state.editor
    ? '<i data-lucide="circle-check"></i><span>已就绪</span>'
    : '<i data-lucide="loader-circle"></i><span>读取中</span>';
  elements.documentState.textContent = state.saving ? "正在保存" : dirty ? "未保存" : writable ? "已保存" : "只读";
  elements.documentState.dataset.dirty = String(dirty);
  document.title = `${dirty ? "* " : ""}${elements.worldTitle.textContent} · WFL World`;
  refreshIcons();
}

function renderMapList() {
  const maps = state.editor?.document.maps || [];
  elements.mapCount.textContent = String(maps.length);
  const fragment = document.createDocumentFragment();
  if (!maps.length) {
    const empty = document.createElement("div");
    empty.className = "world-map-empty";
    empty.textContent = "World 中还没有地图";
    fragment.append(empty);
  }
  for (const map of maps) {
    const preview = state.mapPreviews.get(map.fileName);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "world-map-row";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(map.fileName === state.selectedFileName));
    button.innerHTML = '<i data-lucide="map"></i><span><strong></strong><small></small></span>';
    button.querySelector("strong").textContent = map.fileName.split("/").at(-1);
    button.dataset.previewState = preview?.status || "boundary";
    button.querySelector("small").textContent = [
      `${map.x}, ${map.y} · ${map.width} × ${map.height}`,
      previewStatusLabel(preview),
    ].filter(Boolean).join(" · ");
    button.title = map.fileName;
    button.addEventListener("click", () => selectMap(map.fileName));
    button.addEventListener("dblclick", () => {
      selectMap(map.fileName);
      void openSelectedMap();
    });
    fragment.append(button);
  }
  elements.mapList.replaceChildren(fragment);
  refreshIcons();
}

function renderInspector() {
  const map = selectedMap();
  const writable = state.session?.writable === true && !state.saving;
  elements.selectedMapPath.textContent = map?.fileName || "未选择地图";
  for (const [input, value] of [
    [elements.mapX, map?.x], [elements.mapY, map?.y],
    [elements.mapWidth, map?.width], [elements.mapHeight, map?.height],
  ]) {
    input.disabled = !map || !writable;
    input.value = map ? String(value) : "";
  }
  elements.applyBoundsButton.disabled = !map || !writable;
  elements.adjacentMapsToggle.disabled = !state.editor || !writable;
  elements.adjacentMapsToggle.checked = state.editor?.document.onlyShowAdjacentMaps === true;
  const patterns = state.editor?.document.patterns || [];
  elements.patternCount.textContent = String(patterns.length);
  elements.patternsInput.disabled = !state.editor || !writable;
  elements.applyPatternsButton.disabled = !state.editor || !writable;
  if (document.activeElement !== elements.patternsInput) {
    elements.patternsInput.value = JSON.stringify(patterns, null, 2);
  }
  elements.selectionState.textContent = map
    ? `${map.fileName.split("/").at(-1)} · ${map.x}, ${map.y}`
    : "未选择";
}

function renderToolbar() {
  const ready = Boolean(state.editor);
  const writable = state.session?.writable === true && !state.saving;
  elements.saveButton.disabled = !ready || !writable || !state.editor.dirty;
  elements.undoButton.disabled = !ready || !writable || !state.editor.canUndo;
  elements.redoButton.disabled = !ready || !writable || !state.editor.canRedo;
  elements.addMapButton.disabled = !ready || !writable || !state.projectReady;
  elements.panelAddMapButton.disabled = elements.addMapButton.disabled;
  elements.removeMapButton.disabled = !selectedMap() || !writable;
  elements.openMapButton.disabled = !selectedMap() || !state.projectReady;
  elements.navigationCheckButton.disabled = !ready || !state.projectReady || state.navigationChecking;
  for (const button of [elements.zoomOutButton, elements.zoomInButton, elements.fitButton]) button.disabled = !ready;
  elements.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  elements.worldStage.dataset.tool = state.tool;
  elements.selectToolButton.classList.toggle("is-active", state.tool === "select");
  elements.handToolButton.classList.toggle("is-active", state.tool === "hand");
  elements.selectToolButton.setAttribute("aria-pressed", String(state.tool === "select"));
  elements.handToolButton.setAttribute("aria-pressed", String(state.tool === "hand"));
}

function renderNavigation() {
  const result = state.navigationResult;
  const loadErrorCount = state.navigationLoadErrors.length;
  const errorCount = (result?.errorCount || 0) + loadErrorCount;
  const warningCount = result?.warningCount || 0;
  elements.navigationCheckButton.disabled = !state.editor || !state.projectReady || state.navigationChecking;
  elements.navigationCount.textContent = result
    ? String(errorCount + warningCount)
    : "-";
  if (state.navigationChecking) {
    elements.navigationState.dataset.status = "loading";
  } else if (!result) {
    elements.navigationState.textContent = "尚未检查";
    elements.navigationState.dataset.status = "";
  } else if (errorCount) {
    elements.navigationState.textContent = `${errorCount} 个错误 · ${warningCount} 个警告 · ${result.validLinkCount} 条有效连接`;
    elements.navigationState.dataset.status = "error";
  } else {
    elements.navigationState.textContent = `${result.validLinkCount} 条有效连接 · ${warningCount} 个警告`;
    elements.navigationState.dataset.status = warningCount ? "warning" : "ready";
  }
  const fragment = document.createDocumentFragment();
  const diagnostics = [
    ...state.navigationLoadErrors,
    ...(result?.diagnostics || []),
  ];
  for (const diagnostic of diagnostics.slice(0, 100)) {
    const item = document.createElement("div");
    item.className = "navigation-diagnostic";
    item.dataset.severity = diagnostic.severity;
    item.innerHTML = '<i data-lucide="triangle-alert"></i><span></span>';
    item.querySelector("span").textContent = diagnostic.message;
    fragment.append(item);
  }
  elements.navigationList.replaceChildren(fragment);
  refreshIcons();
}

function resizeCanvas() {
  const rect = elements.worldStage.getBoundingClientRect();
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (elements.worldCanvas.width !== width || elements.worldCanvas.height !== height) {
    elements.worldCanvas.width = width;
    elements.worldCanvas.height = height;
  }
  drawWorld();
}

function drawWorld() {
  const canvas = elements.worldCanvas;
  const ratio = canvas.width / Math.max(1, canvas.clientWidth);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = "#101415";
  context.fillRect(0, 0, width, height);
  drawGrid(width, height);
  if (!state.editor) return;
  const maps = state.editor.document.maps;
  const selectedIndex = maps.findIndex((map) => map.fileName === state.selectedFileName);
  const adjacent = new Set(selectedIndex >= 0 ? adjacentWorldMapIndexes(state.editor.document, selectedIndex) : []);
  if (selectedIndex >= 0) adjacent.add(selectedIndex);
  drawNavigationLinks();
  for (const [index, sourceMap] of maps.entries()) {
    if (state.editor.document.onlyShowAdjacentMaps && selectedIndex >= 0 && !adjacent.has(index)) continue;
    const map = displayMap(sourceMap);
    const point = worldToCanvas(map.x, map.y);
    const mapWidth = Math.max(1, map.width * state.scale);
    const mapHeight = Math.max(1, map.height * state.scale);
    const selected = sourceMap.fileName === state.selectedFileName;
    const preview = state.mapPreviews.get(sourceMap.fileName);
    context.fillStyle = selected ? "rgba(40, 169, 111, .24)" : "rgba(86, 98, 99, .18)";
    context.strokeStyle = selected ? "#63d49b" : "#738080";
    context.lineWidth = selected ? 2 : 1;
    context.fillRect(point.x, point.y, mapWidth, mapHeight);
    if (preview?.canvas) {
      context.save();
      context.globalAlpha = selected ? .88 : .68;
      context.imageSmoothingEnabled = true;
      context.drawImage(preview.canvas, point.x, point.y, mapWidth, mapHeight);
      context.restore();
    }
    context.strokeRect(Math.round(point.x) + .5, Math.round(point.y) + .5, mapWidth, mapHeight);
    context.save();
    context.beginPath();
    context.rect(point.x, point.y, mapWidth, mapHeight);
    context.clip();
    context.fillStyle = selected ? "#eef2f1" : "#c4ccca";
    context.font = "600 12px Inter, system-ui, sans-serif";
    context.fillText(sourceMap.fileName.split("/").at(-1), point.x + 8, point.y + 19);
    context.fillStyle = "#a8b1af";
    context.font = "10px ui-monospace, monospace";
    context.fillText(`${map.x}, ${map.y} · ${map.width}×${map.height}`, point.x + 8, point.y + 35);
    context.restore();
  }
}

function drawNavigationLinks() {
  const links = state.navigationResult?.links || [];
  if (!links.length) return;
  context.save();
  context.lineWidth = 1.5;
  context.strokeStyle = "rgba(120, 174, 232, .8)";
  context.fillStyle = "#78aee8";
  for (const link of links) {
    const start = worldToCanvas(link.source.x, link.source.y);
    const end = worldToCanvas(link.target.x, link.target.y);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const curve = Math.min(80, Math.max(18, distance * .18));
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.bezierCurveTo(start.x, start.y - curve, end.x, end.y - curve, end.x, end.y);
    context.stroke();
    context.beginPath();
    context.arc(start.x, start.y, 3, 0, Math.PI * 2);
    context.arc(end.x, end.y, 3, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawGrid(width, height) {
  const steps = [16, 32, 64, 128, 256, 512, 1024, 2048];
  const worldStep = steps.find((value) => value * state.scale >= 28) || 4096;
  const screenStep = worldStep * state.scale;
  const startX = ((state.offsetX % screenStep) + screenStep) % screenStep;
  const startY = ((state.offsetY % screenStep) + screenStep) % screenStep;
  context.beginPath();
  for (let x = startX; x <= width; x += screenStep) { context.moveTo(x, 0); context.lineTo(x, height); }
  for (let y = startY; y <= height; y += screenStep) { context.moveTo(0, y); context.lineTo(width, y); }
  context.strokeStyle = "rgba(118, 134, 132, .13)";
  context.lineWidth = 1;
  context.stroke();
  const origin = worldToCanvas(0, 0);
  context.beginPath();
  context.moveTo(origin.x, 0); context.lineTo(origin.x, height);
  context.moveTo(0, origin.y); context.lineTo(width, origin.y);
  context.strokeStyle = "rgba(120, 174, 232, .38)";
  context.stroke();
}

function beginPointer(event) {
  if (!state.editor || event.button > 1) return;
  elements.worldCanvas.setPointerCapture(event.pointerId);
  const canvas = canvasPoint(event);
  const world = canvasToWorld(canvas.x, canvas.y);
  const hit = state.tool === "select" ? hitMap(canvas) : null;
  if (hit) selectMap(hit.map.fileName);
  state.pointer = {
    id: event.pointerId,
    mode: hit ? "map" : "pan",
    startCanvas: canvas,
    startWorld: world,
    startOffset: { x: state.offsetX, y: state.offsetY },
    map: hit ? { fileName: hit.map.fileName, x: hit.map.x, y: hit.map.y } : null,
  };
  elements.worldStage.dataset.panning = String(!hit);
}

function movePointer(event) {
  const canvas = canvasPoint(event);
  const world = canvasToWorld(canvas.x, canvas.y);
  elements.coordinates.textContent = `X ${Math.round(world.x)} · Y ${Math.round(world.y)}`;
  if (!state.pointer || state.pointer.id !== event.pointerId) return;
  if (state.pointer.mode === "pan") {
    state.offsetX = state.pointer.startOffset.x + canvas.x - state.pointer.startCanvas.x;
    state.offsetY = state.pointer.startOffset.y + canvas.y - state.pointer.startCanvas.y;
  } else if (state.pointer.map) {
    state.dragPreview = {
      fileName: state.pointer.map.fileName,
      x: Math.round(state.pointer.map.x + world.x - state.pointer.startWorld.x),
      y: Math.round(state.pointer.map.y + world.y - state.pointer.startWorld.y),
    };
  }
  drawWorld();
}

function finishPointer(event) {
  if (!state.pointer || state.pointer.id !== event.pointerId) return;
  movePointer(event);
  const preview = state.dragPreview;
  state.pointer = null;
  state.dragPreview = null;
  elements.worldStage.dataset.panning = "false";
  if (preview && state.session?.writable) {
    try {
      state.editor.moveMap(preview.fileName, { x: preview.x, y: preview.y });
    } catch (error) {
      showInspectorError(error);
    }
  }
  drawWorld();
}

function cancelPointer(event) {
  if (!state.pointer || state.pointer.id !== event.pointerId) return;
  state.pointer = null;
  state.dragPreview = null;
  elements.worldStage.dataset.panning = "false";
  drawWorld();
}

function handleWheel(event) {
  if (!state.editor) return;
  event.preventDefault();
  const point = canvasPoint(event);
  const before = canvasToWorld(point.x, point.y);
  state.scale = clamp(state.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), .02, 8);
  state.offsetX = point.x - before.x * state.scale;
  state.offsetY = point.y - before.y * state.scale;
  renderToolbar();
  drawWorld();
}

function zoomAt(factor) {
  const rect = elements.worldStage.getBoundingClientRect();
  const point = { x: rect.width / 2, y: rect.height / 2 };
  const before = canvasToWorld(point.x, point.y);
  state.scale = clamp(state.scale * factor, .02, 8);
  state.offsetX = point.x - before.x * state.scale;
  state.offsetY = point.y - before.y * state.scale;
  renderToolbar();
  drawWorld();
}

function fitWorld() {
  if (!state.editor) return;
  const rect = elements.worldStage.getBoundingClientRect();
  const bounds = worldBounds(state.editor.document);
  if (!bounds.width || !bounds.height) {
    state.scale = 1;
    state.offsetX = rect.width / 2;
    state.offsetY = rect.height / 2;
  } else {
    const margin = Math.min(72, Math.max(24, Math.min(rect.width, rect.height) * .08));
    state.scale = clamp(Math.min(
      (rect.width - margin * 2) / bounds.width,
      (rect.height - margin * 2) / bounds.height,
    ), .02, 8);
    state.offsetX = (rect.width - bounds.width * state.scale) / 2 - bounds.x * state.scale;
    state.offsetY = (rect.height - bounds.height * state.scale) / 2 - bounds.y * state.scale;
  }
  renderToolbar();
  drawWorld();
}

function hitMap(canvas) {
  if (!state.editor) return null;
  const world = canvasToWorld(canvas.x, canvas.y);
  const hit = worldMapAtPoint(state.editor.document, world.x, world.y);
  if (!hit) return null;
  if (state.editor.document.onlyShowAdjacentMaps && state.selectedFileName) {
    const maps = state.editor.document.maps;
    const selectedIndex = maps.findIndex((map) => map.fileName === state.selectedFileName);
    const visible = new Set([selectedIndex, ...adjacentWorldMapIndexes(state.editor.document, selectedIndex)]);
    if (!visible.has(hit.index)) return null;
  }
  return hit;
}

function displayMap(map) {
  return state.dragPreview?.fileName === map.fileName ? { ...map, ...state.dragPreview } : map;
}

function worldToCanvas(x, y) { return { x: x * state.scale + state.offsetX, y: y * state.scale + state.offsetY }; }
function canvasToWorld(x, y) { return { x: (x - state.offsetX) / state.scale, y: (y - state.offsetY) / state.scale }; }
function canvasPoint(event) {
  const rect = elements.worldCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function selectMap(fileName) {
  state.selectedFileName = fileName;
  renderAll();
  schedulePreviewReconcile();
  if (window.innerWidth <= 600) toggleMobilePanel("inspector", true);
}

function selectedMap() {
  return state.editor?.document.maps.find((map) => map.fileName === state.selectedFileName) || null;
}

function reconcileSelection() {
  if (!selectedMap()) state.selectedFileName = state.editor?.document.maps[0]?.fileName || null;
  renderAll();
  schedulePreviewReconcile();
}

function schedulePreviewReconcile() {
  const revision = ++state.previewRevision;
  state.previewWork = state.previewWork
    .catch(() => {})
    .then(() => reconcileMapPreviews(revision))
    .catch((error) => showInspectorError(error));
}

async function reconcileMapPreviews(revision) {
  if (revision !== state.previewRevision || !state.editor || !state.projectClient || state.closing) return;
  const plan = planWorldMapPreviews(state.editor.document, {
    sourcePath: state.session.relativePath,
    selectedFileName: state.selectedFileName,
  });
  const required = new Map(plan.map((entry) => [entry.fileName, entry]));
  for (const [fileName, current] of [...state.mapPreviews]) {
    const next = required.get(fileName);
    if (!next) {
      state.mapPreviews.delete(fileName);
      await releaseMapPreview(current);
      continue;
    }
    if (current.mode === "full" && next.mode === "preview" && current.status === "ready") {
      await closeMapSnapshotSession(current);
      current.mode = "preview";
      current.document = null;
      current.sessionId = null;
      current.editorInstanceId = null;
    }
  }
  renderMapList();
  drawWorld();
  for (const item of plan) {
    if (revision !== state.previewRevision || state.closing) return;
    const current = state.mapPreviews.get(item.fileName);
    if (current?.status === "ready" && current.mode === item.mode) continue;
    const pending = {
      ...item,
      status: "loading",
      canvas: current?.canvas || null,
      summary: current?.summary || null,
      document: null,
      sessionId: null,
      editorInstanceId: null,
      error: null,
    };
    state.mapPreviews.set(item.fileName, pending);
    renderMapList();
    drawWorld();
    try {
      const loaded = await loadMapSnapshot(item.mapPath, { mode: item.mode });
      if (revision !== state.previewRevision || state.closing) {
        await releaseMapPreview(loaded);
        return;
      }
      if (current?.canvas && current.canvas !== loaded.canvas) destroyPreviewCanvas(current.canvas);
      state.mapPreviews.set(item.fileName, { ...item, ...loaded, status: "ready", error: null });
    } catch (error) {
      pending.status = "error";
      pending.error = error.message || String(error);
    }
    renderMapList();
    drawWorld();
  }
}

async function loadMapSnapshot(mapPath, { mode = "preview" } = {}) {
  const editorInstanceId = `world-preview-${crypto.randomUUID()}`;
  let session = null;
  let keepSession = false;
  try {
    const response = await fetch("/api/maps/sessions", {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-session-open",
      },
      body: JSON.stringify(state.projectClient.mapOpenPayload(mapPath, editorInstanceId)),
    });
    const opened = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(opened.error || `无法读取 ${mapPath}`);
    session = opened.session;
    const source = await readMapSnapshotSource(session, editorInstanceId);
    const parsed = parseTiledDocument(source, { expectedKind: "map", sourcePath: mapPath });
    if (mode === "full") await decodeTiledTileData(parsed.document);
    const result = {
      mapPath,
      mode,
      canvas: mode === "inspect" ? null : createMapThumbnail(parsed.document),
      summary: collectWorldMapNavigation(parsed.document, { mapPath }),
      document: mode === "full" ? parsed.document : null,
      diagnostics: parsed.diagnostics,
      sessionId: mode === "full" ? session.id : null,
      editorInstanceId: mode === "full" ? editorInstanceId : null,
    };
    keepSession = mode === "full";
    return result;
  } finally {
    if (session && !keepSession) {
      await closeMapSession(session.id, editorInstanceId).catch(() => {});
    }
  }
}

async function readMapSnapshotSource(session, editorInstanceId) {
  let chunk = session.firstChunk || null;
  let source = chunk?.content || "";
  let offset = chunk?.nextOffset || 0;
  while (!chunk?.eof && offset < session.size) {
    const url = new URL(`/api/maps/sessions/${encodeURIComponent(session.id)}/content`, location.origin);
    url.searchParams.set("version", session.version);
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "X-Codex-Desktop-Editor-Instance": editorInstanceId },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `无法分段读取 ${session.relativePath}`);
    if (data.offset !== offset || data.nextOffset <= offset) throw new Error("地图预览分段响应不连续");
    chunk = data;
    source += data.content;
    offset = data.nextOffset;
  }
  return source;
}

function createMapThumbnail(documentValue) {
  const bounds = mapPixelBounds(documentValue);
  const maximum = 320;
  const scale = Math.min(1, maximum / Math.max(1, bounds.width, bounds.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(24, Math.round(bounds.width * scale));
  canvas.height = Math.max(24, Math.round(bounds.height * scale));
  const previewContext = canvas.getContext("2d", { alpha: false });
  previewContext.fillStyle = safeCanvasColor(documentValue.backgroundcolor, "#17201e");
  previewContext.fillRect(0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / Math.max(1, bounds.width);
  const scaleY = canvas.height / Math.max(1, bounds.height);
  previewContext.setTransform(scaleX, 0, 0, scaleY, -bounds.x * scaleX, -bounds.y * scaleY);
  drawPreviewLayers(previewContext, documentValue, documentValue.layers, 0, 0, 1, bounds);
  previewContext.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

function drawPreviewLayers(previewContext, mapDocument, layers, parentOffsetX, parentOffsetY, parentOpacity, bounds) {
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    if (!layer || layer.visible === false) continue;
    const coordinateX = ["group", "objectgroup", "imagelayer"].includes(layer.type) ? Number(layer.x || 0) : 0;
    const coordinateY = ["group", "objectgroup", "imagelayer"].includes(layer.type) ? Number(layer.y || 0) : 0;
    const offsetX = parentOffsetX + coordinateX + Number(layer.offsetx || 0);
    const offsetY = parentOffsetY + coordinateY + Number(layer.offsety || 0);
    const opacity = parentOpacity * clamp(Number(layer.opacity ?? 1), 0, 1);
    previewContext.save();
    previewContext.globalAlpha = opacity;
    if (layer.type === "tilelayer") drawPreviewTileLayer(previewContext, mapDocument, layer, offsetX, offsetY);
    else if (layer.type === "objectgroup") drawPreviewObjects(previewContext, mapDocument, layer, offsetX, offsetY);
    else if (layer.type === "imagelayer") {
      previewContext.fillStyle = "rgba(78, 120, 154, .34)";
      previewContext.fillRect(offsetX + bounds.x, offsetY + bounds.y, bounds.width, bounds.height);
    }
    previewContext.restore();
    drawPreviewLayers(previewContext, mapDocument, layer.layers, offsetX, offsetY, opacity, bounds);
  }
}

function drawPreviewTileLayer(previewContext, mapDocument, layer, offsetX, offsetY) {
  const blocks = Array.isArray(layer.chunks) ? layer.chunks : [layer];
  for (const block of blocks) {
    const blockWidth = Number(block?.width || layer.width || 0);
    const blockHeight = Number(block?.height || layer.height || 0);
    const originX = Number(block?.x ?? layer.startx ?? layer.x ?? 0);
    const originY = Number(block?.y ?? layer.starty ?? layer.y ?? 0);
    if (blockWidth <= 0 || blockHeight <= 0) continue;
    if (!Array.isArray(block.data)) {
      const region = tiledTileRegionBounds(mapDocument, originX, originY, blockWidth, blockHeight);
      previewContext.fillStyle = "rgba(99, 151, 119, .3)";
      previewContext.fillRect(offsetX + region.x, offsetY + region.y, region.width, region.height);
      continue;
    }
    const stride = Math.max(1, Math.ceil(Math.sqrt(block.data.length / 4_096)));
    for (let row = 0; row < blockHeight; row += stride) {
      for (let column = 0; column < blockWidth; column += stride) {
        const gid = Number(block.data[row * blockWidth + column]) >>> 0;
        if (!gid) continue;
        const region = tiledTileRegionBounds(
          mapDocument,
          originX + column,
          originY + row,
          Math.min(stride, blockWidth - column),
          Math.min(stride, blockHeight - row),
        );
        previewContext.fillStyle = previewTileColor(gid);
        previewContext.fillRect(offsetX + region.x, offsetY + region.y, region.width + .5, region.height + .5);
      }
    }
  }
}

function drawPreviewObjects(previewContext, mapDocument, layer, offsetX, offsetY) {
  for (const object of Array.isArray(layer.objects) ? layer.objects : []) {
    if (!object || object.visible === false) continue;
    const bounds = tiledObjectScreenBounds(mapDocument, object, { pointTolerance: 3 });
    const semanticType = String(object.class || object.type || "").toLowerCase();
    previewContext.fillStyle = semanticType.includes("spawn")
      ? "rgba(99, 212, 155, .8)"
      : semanticType.includes("portal")
        ? "rgba(120, 174, 232, .8)"
        : "rgba(246, 196, 83, .58)";
    previewContext.fillRect(offsetX + bounds.x, offsetY + bounds.y, Math.max(2, bounds.width), Math.max(2, bounds.height));
  }
}

async function checkWorldNavigation() {
  if (!state.editor || !state.projectClient || state.navigationChecking) return;
  const revision = ++state.navigationRevision;
  state.navigationChecking = true;
  state.navigationResult = null;
  state.navigationLoadErrors = [];
  const summaries = new Map();
  renderNavigation();
  try {
    const maps = [...state.editor.document.maps];
    for (const [index, map] of maps.entries()) {
      if (revision !== state.navigationRevision || state.closing) return;
      const mapPath = resolveWorldMapReference(state.session.relativePath, map.fileName);
      elements.navigationState.textContent = `正在检查 ${index + 1}/${maps.length}`;
      try {
        const snapshot = await loadMapSnapshot(mapPath, { mode: "inspect" });
        summaries.set(mapPath, snapshot.summary);
      } catch (error) {
        state.navigationLoadErrors.push({
          severity: "error",
          code: "world-map-navigation-load-failed",
          mapPath,
          objectId: null,
          message: `${mapPath}：${error.message || String(error)}`,
        });
      }
      renderNavigation();
    }
    if (revision !== state.navigationRevision || state.closing) return;
    state.navigationResult = validateWorldPortalReferences(
      state.editor.document,
      summaries,
      { sourcePath: state.session.relativePath },
    );
  } finally {
    state.navigationChecking = false;
    renderNavigation();
    drawWorld();
  }
}

function invalidateNavigationCheck() {
  state.navigationRevision += 1;
  state.navigationResult = null;
  state.navigationLoadErrors = [];
}

async function releaseMapPreview(entry, { keepalive = false } = {}) {
  await closeMapSnapshotSession(entry, { keepalive });
  destroyPreviewCanvas(entry?.canvas);
  if (entry) {
    entry.canvas = null;
    entry.document = null;
    entry.summary = null;
  }
}

async function closeMapSnapshotSession(entry, { keepalive = false } = {}) {
  if (!entry?.sessionId || !entry?.editorInstanceId) return;
  const sessionId = entry.sessionId;
  entry.sessionId = null;
  await closeMapSession(sessionId, entry.editorInstanceId, { keepalive }).catch(() => {});
}

async function closeMapSession(sessionId, editorInstanceId, { keepalive = false } = {}) {
  await fetch(`/api/maps/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    keepalive,
    headers: {
      "X-Codex-Desktop-Action": "map-session-close",
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  });
}

async function releaseMapPreviews({ keepalive = false } = {}) {
  state.previewRevision += 1;
  const previews = [...state.mapPreviews.values()];
  state.mapPreviews.clear();
  await Promise.allSettled(previews.map((entry) => releaseMapPreview(entry, { keepalive })));
}

function destroyPreviewCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}

function previewTileColor(gid) {
  const hue = (gid * 47) % 360;
  return `hsla(${hue}, 34%, 48%, .76)`;
}

function safeCanvasColor(value, fallback) {
  const color = String(value || "").trim();
  return /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(color) ? color : fallback;
}

function previewStatusLabel(preview) {
  if (!preview) return "边界";
  if (preview.status === "loading") return preview.canvas ? "更新中" : "读取中";
  if (preview.status === "error") return "预览失败";
  return preview.mode === "full" ? "当前地图" : "轻量预览";
}

function applySelectedBounds(event) {
  event.preventDefault();
  const map = selectedMap();
  if (!map || !state.session?.writable) return;
  try {
    state.editor.moveMap(map.fileName, { x: Number(elements.mapX.value), y: Number(elements.mapY.value) });
    state.editor.resizeMap(map.fileName, { width: Number(elements.mapWidth.value), height: Number(elements.mapHeight.value) });
    showInspectorMessage("边界已更新");
  } catch (error) {
    showInspectorError(error);
  }
}

function applyPatterns() {
  if (!state.editor || !state.session?.writable) return;
  try {
    const patterns = JSON.parse(elements.patternsInput.value || "[]");
    state.editor.replacePatterns(patterns);
    showInspectorMessage("Patterns 已更新");
  } catch (error) {
    showInspectorError(error);
  }
}

async function openAddMapDialog() {
  if (!state.editor || !state.session?.writable || !state.projectReady) return;
  elements.addMapForm.reset();
  elements.addMapX.value = "0";
  elements.addMapY.value = "0";
  elements.addMapWidth.value = "1024";
  elements.addMapHeight.value = "1024";
  elements.addMapState.textContent = "";
  elements.addMapState.dataset.status = "";
  if (!elements.addMapDialog.open) elements.addMapDialog.showModal();
  requestAnimationFrame(() => elements.addMapPath.focus());
  if (state.mapOptionsLoading) return;
  state.mapOptionsLoading = true;
  try {
    const page = await state.projectClient.search({ query: ".tmj", kinds: ["map"], limit: 100 });
    const fragment = document.createDocumentFragment();
    for (const entry of page.entries) {
      const option = document.createElement("option");
      option.value = entry.path;
      fragment.append(option);
    }
    elements.mapPathOptions.replaceChildren(fragment);
  } catch (error) {
    elements.addMapState.textContent = error.message;
    elements.addMapState.dataset.status = "error";
  } finally {
    state.mapOptionsLoading = false;
  }
}

function closeAddMapDialog() {
  if (elements.addMapDialog.open) elements.addMapDialog.close();
}

function submitAddMap(event) {
  event.preventDefault();
  if (!state.editor || !state.session?.writable) return;
  try {
    const mapPath = normalizeProjectPath(elements.addMapPath.value, ".tmj");
    const fileName = worldMapReference(state.session.relativePath, mapPath);
    const added = state.editor.addMap({
      fileName,
      x: Number(elements.addMapX.value),
      y: Number(elements.addMapY.value),
      width: Number(elements.addMapWidth.value),
      height: Number(elements.addMapHeight.value),
    });
    state.selectedFileName = added.fileName;
    closeAddMapDialog();
    renderAll();
  } catch (error) {
    elements.addMapState.textContent = error.message;
    elements.addMapState.dataset.status = "error";
  }
}

function removeSelectedMap() {
  const map = selectedMap();
  if (!map || !state.session?.writable) return;
  if (!confirm(`从 World 移除 ${map.fileName}？地图文件本身不会删除。`)) return;
  try {
    state.editor.removeMap(map.fileName);
    state.selectedFileName = null;
    reconcileSelection();
  } catch (error) {
    showInspectorError(error);
  }
}

async function openSelectedMap() {
  const map = selectedMap();
  if (!map || !state.projectClient) return;
  const mapPath = resolveWorldMapReference(state.session.relativePath, map.fileName);
  const editorWindow = window.open("/map-editor.html#pending", "_blank");
  if (!editorWindow) {
    showInspectorError(new Error("浏览器阻止了地图编辑器窗口"));
    return;
  }
  try {
    const editorInstanceId = crypto.randomUUID();
    const response = await fetch("/api/maps/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": "map-session-open",
      },
      body: JSON.stringify(state.projectClient.mapOpenPayload(mapPath, editorInstanceId)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "无法打开地图");
    if (editorWindow.closed) return;
    const fragment = new URLSearchParams({
      session: data.session.id,
      editor: editorInstanceId,
      host: `world-host-${crypto.randomUUID()}`,
      project: state.credentials.projectPath,
      ...(state.credentials.projectFile ? { projectFile: state.credentials.projectFile } : {}),
      ...(state.credentials.accountId ? { account: state.credentials.accountId } : {}),
    });
    editorWindow.location.replace(`/map-editor.html#${fragment}`);
  } catch (error) {
    if (!editorWindow.closed) editorWindow.close();
    showInspectorError(error);
  }
}

async function saveWorld() {
  if (!state.editor || !state.session?.writable || state.saving) return false;
  if (!state.editor.dirty) return true;
  state.saving = true;
  const savedStateId = state.editor.headStateId;
  let save = null;
  let committed = false;
  renderAll();
  try {
    const source = serializeTiledWorld(state.editor.exportDocument(), {
      sourcePath: state.session.relativePath,
      space: 2,
      trailingNewline: true,
    });
    const bytes = new TextEncoder().encode(source);
    const totalHash = await sha256Hex(bytes);
    setDocumentProgress("正在创建保存任务");
    const started = await worldMutation("/api/map-worlds/save-sessions", {
      method: "POST",
      action: "map-world-save-start",
      json: {
        worldSessionId: state.session.id,
        expectedVersion: state.session.version,
        totalBytes: bytes.byteLength,
        totalHash,
        clientOperationId: crypto.randomUUID(),
      },
    });
    save = started.save;
    for (let index = 0; index < save.chunkCount; index += 1) {
      const start = index * save.config.chunkBytes;
      const chunk = bytes.subarray(start, Math.min(bytes.byteLength, start + save.config.chunkBytes));
      setDocumentProgress(`正在上传 ${index + 1}/${save.chunkCount}`);
      await worldMutation(`/api/map-worlds/save-sessions/${encodeURIComponent(save.id)}/chunks/${index}`, {
        method: "PUT",
        action: "map-world-save-chunk",
        body: chunk,
        contentType: "application/octet-stream",
        headers: { "X-Content-SHA256": await sha256Hex(chunk) },
      });
    }
    setDocumentProgress("等待原子提交");
    const completed = await worldMutation(`/api/map-worlds/save-sessions/${encodeURIComponent(save.id)}/commit`, {
      method: "POST",
      action: "map-world-save-commit",
    });
    committed = true;
    state.session = { ...state.session, ...(completed.session || {}), version: completed.result.version };
    state.editor.markSaved(savedStateId);
    showInspectorMessage("World 已保存");
    return true;
  } catch (error) {
    showInspectorError(error);
    elements.worldState.dataset.status = "error";
    elements.worldState.innerHTML = '<i data-lucide="triangle-alert"></i><span>保存失败</span>';
    return false;
  } finally {
    if (save && !committed) {
      await worldMutation(`/api/map-worlds/save-sessions/${encodeURIComponent(save.id)}`, {
        method: "DELETE",
        action: "map-world-save-abort",
      }).catch(() => {});
    }
    state.saving = false;
    renderAll();
  }
}

function requestClose() {
  if (state.closing) return;
  if (state.editor?.dirty) {
    if (!elements.closeDialog.open) elements.closeDialog.showModal();
    return;
  }
  void closeWorldSession();
}

async function closeWorldSession() {
  if (state.closing) return;
  state.closing = true;
  if (elements.closeDialog.open) elements.closeDialog.close();
  await releaseSessions();
  window.close();
}

async function releaseSessions({ keepalive = false } = {}) {
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  const requests = [];
  requests.push(releaseMapPreviews({ keepalive }));
  if (state.session && state.credentials) {
    requests.push(fetch(`/api/map-worlds/sessions/${encodeURIComponent(state.session.id)}`, {
      method: "DELETE",
      keepalive,
      headers: worldHeaders("map-world-session-close"),
    }).catch(() => {}));
  }
  if (state.projectClient) requests.push(state.projectClient.close({ keepalive }).catch(() => {}));
  await Promise.allSettled(requests);
  state.session = null;
  state.projectClient = null;
}

function invalidateWorldAccountSession() {
  state.closing = true;
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  state.unsubscribe?.();
  state.unsubscribe = null;
  void releaseSessions({ keepalive: true });
  for (const entry of state.mapPreviews.values()) destroyPreviewCanvas(entry?.canvas);
  state.mapPreviews.clear();
  state.editor = null;
  state.parsed = null;
  elements.worldCanvas.width = 1;
  elements.worldCanvas.height = 1;
  document.body.replaceChildren(accountSessionEndedNotice("World 编辑器"));
  document.title = "账号已切换 · WFL World";
  setTimeout(() => window.close(), 0);
}

function accountSessionEndedNotice(label) {
  const notice = document.createElement("main");
  notice.setAttribute("role", "alert");
  notice.style.cssText = "min-height:100vh;display:grid;place-content:center;padding:24px;background:#0b1110;color:#e7efed;font:16px/1.6 system-ui,sans-serif;text-align:center";
  const title = document.createElement("h1");
  title.textContent = "账号已经切换";
  const detail = document.createElement("p");
  detail.textContent = `为保护项目隔离，旧账号的${label}窗口已清空并关闭。请从当前账号重新打开。`;
  notice.append(title, detail);
  return notice;
}

function handleKeydown(event) {
  if (event.defaultPrevented || !state.editor) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveWorld();
    return;
  }
  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) state.editor.redo(); else state.editor.undo();
    reconcileSelection();
    return;
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const map = selectedMap();
  if (!map || !state.session?.writable) return;
  const delta = event.shiftKey ? 10 : 1;
  const movement = ({ ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] })[event.key];
  if (movement) {
    event.preventDefault();
    state.editor.moveMap(map.fileName, { x: map.x + movement[0], y: map.y + movement[1] });
  }
}

function setTool(tool) {
  state.tool = tool === "hand" ? "hand" : "select";
  renderToolbar();
}

function toggleMobilePanel(panel, forceOpen = false) {
  if (!elements.worldApp) return;
  elements.worldApp.dataset.mobilePanel = forceOpen || elements.worldApp.dataset.mobilePanel !== panel ? panel : "";
}

function setLoading(title, detail) {
  elements.loadState.hidden = false;
  elements.retryButton.hidden = true;
  elements.loadTitle.textContent = title;
  elements.loadDetail.textContent = detail;
}

function showLoadError(error) {
  elements.worldApp.dataset.state = "error";
  elements.loadState.hidden = false;
  elements.loadTitle.textContent = "无法打开 World";
  elements.loadDetail.textContent = error.message;
  elements.retryButton.hidden = false;
  elements.worldState.dataset.status = "error";
  elements.worldState.innerHTML = '<i data-lucide="triangle-alert"></i><span>读取失败</span>';
  refreshIcons();
}

function showInspectorMessage(message) {
  elements.inspectorState.textContent = message;
  elements.inspectorState.dataset.status = "ready";
}

function showInspectorError(error) {
  elements.inspectorState.textContent = error.message || String(error);
  elements.inspectorState.dataset.status = "error";
}

function setDocumentProgress(message) {
  elements.documentState.textContent = message;
  elements.documentState.dataset.dirty = "true";
}

async function readCredentials() {
  if (location.hash === "#pending") {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("World 会话建立超时")), 20_000);
      window.addEventListener("hashchange", () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }
  const params = new URLSearchParams(location.hash.replace(/^#/u, ""));
  const sessionId = params.get("session") || "";
  const editorInstanceId = params.get("editor") || "";
  const projectPath = params.get("project") || "";
  const projectFile = params.get("projectFile") || null;
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(sessionId)) throw new Error("World 会话标识无效");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(editorInstanceId)) throw new Error("World 窗口标识无效");
  if (!projectPath.startsWith("/") || projectPath.includes("\0")) throw new Error("World 工程路径无效");
  if (projectFile) normalizeProjectPath(projectFile, ".tiled-project");
  return Object.freeze({
    sessionId,
    editorInstanceId,
    projectPath,
    projectFile,
    accountId: params.get("account") || null,
  });
}

function normalizeProjectPath(value, extension) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || text.includes("\\") || /^[a-z][a-z0-9+.-]*:/iu.test(text)) {
    throw new Error("路径必须是工程相对路径");
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("工程相对路径无效");
  }
  if (!text.toLowerCase().endsWith(extension)) throw new Error(`路径必须使用 ${extension}`);
  return segments.join("/");
}

function worldHeaders(action = null) {
  const headers = { "X-Codex-Desktop-Editor-Instance": state.credentials.editorInstanceId };
  if (action) headers["X-Codex-Desktop-Action"] = action;
  return headers;
}

async function worldFetch(url) {
  const response = await fetch(url, { cache: "no-store", headers: worldHeaders() });
  if (!response.ok) throw await responseError(response, "World 会话请求失败");
  return response.json();
}

async function worldMutation(url, { method, action, json, body, contentType, headers = {} }) {
  const requestHeaders = { ...worldHeaders(action), ...headers };
  let requestBody = body;
  if (json !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestBody = JSON.stringify(json);
  } else if (contentType) requestHeaders["Content-Type"] = contentType;
  const response = await fetch(url, { method, cache: "no-store", headers: requestHeaders, body: requestBody });
  if (!response.ok) throw await responseError(response, "World 操作失败");
  if (response.status === 204) return null;
  return response.json();
}

async function responseError(response, fallback) {
  const data = await response.json().catch(() => ({}));
  const error = new Error(data.error || fallback);
  error.status = response.status;
  error.code = data.code || null;
  return error;
}

async function sha256Hex(bytes) {
  if (!crypto.subtle) throw new Error("当前浏览器环境不支持 World 保存所需的 SHA-256");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }

function refreshIcons() {
  globalThis.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}
