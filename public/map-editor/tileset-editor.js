import {
  parseTiledDocument,
  relativeTiledProjectReference,
  resolveTiledProjectReference,
  serializeTiledDocument,
} from "./tiled-document.js?v=0.44.56-beta";
import { TiledTilesetEditDocument } from "./tiled-tileset-edit-document.js?v=0.44.56-beta";
import { tiledObjectShape } from "./map-object-model.js?v=0.44.56-beta";
import { MapProjectWorkspaceClient } from "../map-project-session.js?v=0.44.56-beta";
import { createMapAccountSessionGuard } from "./map-account-session-guard.js?v=0.44.56-beta";

const PAGE_SIZE = 200;
const COLLECTION_COLUMNS = 6;
const elements = Object.fromEntries([
  "tilesetApp", "tilesetTitle", "tilesetMeta", "saveButton", "undoButton", "redoButton",
  "zoomOutButton", "zoomLabel", "zoomInButton", "fitButton", "closeButton", "tileCount",
  "tileList", "previousPageButton", "pageLabel", "nextPageButton", "tilesetStage", "tilesetCanvas",
  "loadState", "loadTitle", "loadDetail", "retryButton", "tilesPanelButton", "inspectorPanelButton",
  "tilesetKind", "identityForm", "tilesetName", "tilesetClass", "applyIdentityButton", "atlasSection",
  "atlasDimensions", "atlasImagePath", "atlasForm", "tileWidth", "tileHeight", "tileMargin",
  "tileSpacing", "transparentEnabled", "transparentColor", "applyAtlasButton", "renderingForm",
  "objectAlignment", "tileRenderSize", "fillMode", "tileOffsetX", "tileOffsetY", "gridOrientation",
  "gridWidth", "gridHeight", "allowHFlip", "allowVFlip", "allowRotate", "preferUntransformed",
  "applyRenderingButton", "selectedTileId", "selectedTileImage", "inspectorState", "tilesetState",
  "selectionState", "documentState", "closeDialog", "closeCancelButton", "discardCloseButton",
  "saveCloseButton",
  "addCollectionImageButton", "removeCollectionImageButton", "collectionImageDialog",
  "collectionImageForm", "collectionImageCloseButton", "collectionImageSearch", "collectionImageList",
  "collectionImageState", "collectionImageCancelButton", "collectionImageSubmitButton",
  "tileMetadataForm", "tileClass", "tileProbabilityEnabled", "tileProbability", "applyTileMetadataButton",
  "tilePropertiesSection", "tilePropertyRows", "addTilePropertyButton", "tileAnimationSection",
  "animationPreviewCanvas", "animationFrameRows", "addAnimationFrameButton", "tileCollisionSection",
  "collisionCount", "newCollisionShape", "addCollisionButton", "collisionObjectRows",
  "wangSetSection", "addWangSetButton", "removeWangSetButton", "wangSetSelect", "wangSetForm",
  "wangSetName", "wangSetClass", "wangSetType", "wangSetTile", "applyWangSetButton",
  "wangColorHeading", "addWangColorButton", "wangColorRows", "tileWangForm", "tileWangGrid",
  "applyTileWangButton",
].map((id) => [id, document.getElementById(id)]));

const state = {
  credentials: null,
  session: null,
  parsed: null,
  editor: null,
  unsubscribe: null,
  selectedTileId: null,
  page: 0,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  pointer: null,
  saving: false,
  loading: false,
  closing: false,
  imageRecords: new Map(),
  collectionLayout: null,
  projectClient: null,
  projectReady: false,
  collectionImages: [],
  selectedCollectionImage: null,
  collectionImagesLoading: false,
  animationStartedAt: performance.now(),
  animationPreviewActive: -1,
  animationPreviewRunning: false,
  activeWangSetIndex: 0,
  accountSessionGuard: null,
};

const canvasContext = elements.tilesetCanvas.getContext("2d", { alpha: true });
const resizeObserver = new ResizeObserver(() => resizeCanvas());
resizeObserver.observe(elements.tilesetStage);
bindEvents();
refreshIcons();
ensureAnimationPreviewLoop();
void initialize();

async function initialize() {
  try {
    state.credentials = await readCredentials();
    if (!state.credentials.accountId) throw new Error("瓦片集账号绑定缺失，请从当前账号的地图项目重新打开");
    state.accountSessionGuard = createMapAccountSessionGuard({
      accountId: state.credentials.accountId,
      onInvalidated: invalidateTilesetAccountSession,
    });
    const accountStatus = await state.accountSessionGuard.check();
    if (accountStatus === "invalidated") return;
    state.accountSessionGuard.start();
    await loadTileset();
  } catch (error) {
    showLoadError(error);
  }
}

function bindEvents() {
  elements.saveButton.addEventListener("click", () => void saveTileset());
  elements.undoButton.addEventListener("click", () => state.editor?.undo());
  elements.redoButton.addEventListener("click", () => state.editor?.redo());
  elements.zoomOutButton.addEventListener("click", () => zoomAt(1 / 1.2));
  elements.zoomInButton.addEventListener("click", () => zoomAt(1.2));
  elements.fitButton.addEventListener("click", fitTileset);
  elements.closeButton.addEventListener("click", requestClose);
  elements.retryButton.addEventListener("click", () => void loadTileset().catch(showLoadError));
  elements.previousPageButton.addEventListener("click", () => setPage(state.page - 1));
  elements.nextPageButton.addEventListener("click", () => setPage(state.page + 1));
  elements.addCollectionImageButton.addEventListener("click", () => void openCollectionImageDialog());
  elements.removeCollectionImageButton.addEventListener("click", removeSelectedCollectionImage);
  elements.identityForm.addEventListener("submit", applyIdentity);
  elements.atlasForm.addEventListener("submit", applyAtlasGrid);
  elements.renderingForm.addEventListener("submit", applyRendering);
  elements.tileMetadataForm.addEventListener("submit", applyTileMetadata);
  elements.tileProbabilityEnabled.addEventListener("change", renderTileProbabilityControl);
  elements.addTilePropertyButton.addEventListener("click", addTileProperty);
  elements.tilePropertyRows.addEventListener("change", updateTileProperty);
  elements.tilePropertyRows.addEventListener("click", handleTilePropertyAction);
  elements.addAnimationFrameButton.addEventListener("click", addAnimationFrame);
  elements.animationFrameRows.addEventListener("change", updateTileAnimationFromRows);
  elements.animationFrameRows.addEventListener("click", handleAnimationFrameAction);
  elements.addCollisionButton.addEventListener("click", addTileCollision);
  elements.collisionObjectRows.addEventListener("change", updateTileCollisionFromRow);
  elements.collisionObjectRows.addEventListener("click", handleTileCollisionAction);
  elements.addWangSetButton.addEventListener("click", addWangSet);
  elements.removeWangSetButton.addEventListener("click", removeWangSet);
  elements.wangSetSelect.addEventListener("change", selectWangSet);
  elements.wangSetForm.addEventListener("submit", applyWangSet);
  elements.addWangColorButton.addEventListener("click", addWangColor);
  elements.wangColorRows.addEventListener("change", updateWangColorFromRow);
  elements.wangColorRows.addEventListener("click", handleWangColorAction);
  elements.tileWangForm.addEventListener("submit", applyTileWangId);
  elements.transparentEnabled.addEventListener("change", renderTransparentControl);
  elements.tilesetCanvas.addEventListener("pointerdown", beginPointer);
  elements.tilesetCanvas.addEventListener("pointermove", movePointer);
  elements.tilesetCanvas.addEventListener("pointerup", finishPointer);
  elements.tilesetCanvas.addEventListener("pointercancel", cancelPointer);
  elements.tilesetCanvas.addEventListener("wheel", handleWheel, { passive: false });
  elements.tilesPanelButton?.addEventListener("click", () => toggleMobilePanel("tiles"));
  elements.inspectorPanelButton?.addEventListener("click", () => toggleMobilePanel("inspector"));
  elements.closeCancelButton.addEventListener("click", () => elements.closeDialog.close());
  elements.discardCloseButton.addEventListener("click", () => void closeTilesetSession());
  elements.saveCloseButton.addEventListener("click", async () => {
    if (await saveTileset()) await closeTilesetSession();
  });
  elements.collectionImageCloseButton.addEventListener("click", closeCollectionImageDialog);
  elements.collectionImageCancelButton.addEventListener("click", closeCollectionImageDialog);
  elements.collectionImageSearch.addEventListener("input", renderCollectionImageList);
  elements.collectionImageList.addEventListener("click", selectCollectionImageRow);
  elements.collectionImageForm.addEventListener("submit", submitCollectionImage);
  elements.collectionImageDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCollectionImageDialog();
  });
  window.addEventListener("keydown", handleKeydown);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ensureAnimationPreviewLoop();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.editor?.dirty || state.closing) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted && !state.closing) void releaseSession({ keepalive: true });
  });
}

async function loadTileset() {
  if (!state.credentials || state.loading) return;
  state.loading = true;
  setLoading("正在读取瓦片集", "0%");
  try {
    const { session } = await tilesetFetch(`/api/map-tilesets/sessions/${encodeURIComponent(state.credentials.sessionId)}`);
    if (session.documentKind !== "tileset") throw new Error("服务端返回的不是瓦片集文档会话");
    state.session = session;
    const source = await readTilesetSource(session);
    setLoading("正在校验瓦片集", "90%");
    const parsed = parseTiledDocument(source, { expectedKind: "tileset", sourcePath: session.relativePath });
    state.unsubscribe?.();
    state.parsed = parsed;
    state.editor = new TiledTilesetEditDocument(parsed.document, { sourcePath: session.relativePath });
    state.unsubscribe = state.editor.subscribe(() => {
      reconcileSelection();
      reconcileWangSelection();
      rebuildCollectionLayout();
      renderAll();
    });
    state.imageRecords.clear();
    state.selectedTileId = null;
    state.activeWangSetIndex = 0;
    state.page = 0;
    rebuildCollectionLayout();
    if (state.editor.kind === "atlas") {
      setLoading("正在读取图集图片", "95%");
      await ensureImage(atlasImageProjectPath(), { required: true });
    }
    await connectProject().catch((error) => {
      state.projectReady = false;
      showInspectorError(error);
    });
    elements.tilesetApp.dataset.state = "ready";
    elements.loadState.hidden = true;
    renderAll();
    requestAnimationFrame(fitTileset);
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

async function readTilesetSource(session) {
  let chunk = session.firstChunk || null;
  let source = chunk?.content || "";
  let offset = chunk?.nextOffset || 0;
  while (!chunk?.eof && offset < session.size) {
    setLoading("正在分段读取瓦片集", `${Math.min(89, Math.round((offset / session.size) * 89))}%`);
    const url = new URL(`/api/map-tilesets/sessions/${encodeURIComponent(session.id)}/content`, location.origin);
    url.searchParams.set("version", session.version);
    url.searchParams.set("offset", String(offset));
    chunk = await tilesetFetch(url);
    if (chunk.offset !== offset || chunk.nextOffset <= offset) throw new Error("瓦片集分段响应不连续");
    source += chunk.content;
    offset = chunk.nextOffset;
  }
  return source;
}

async function ensureImage(projectPath, { required = false } = {}) {
  if (!projectPath) {
    if (required) throw new Error("瓦片集图片引用无效");
    return null;
  }
  let record = state.imageRecords.get(projectPath);
  if (!record) {
    const image = new Image();
    record = { image, status: "loading", promise: null };
    record.promise = fetch(resourceUrl(projectPath), {
      cache: "no-store",
      headers: tilesetHeaders(),
    }).then(async (response) => {
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `无法读取图片 ${projectPath}`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        await new Promise((resolve, reject) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", () => reject(new Error(`无法解码图片 ${projectPath}`)), { once: true });
          image.decoding = "async";
          image.src = objectUrl;
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      record.status = "ready";
      renderCanvas();
      return image;
    }).catch((error) => {
      record.status = "error";
      renderCanvas();
      throw error;
    });
    state.imageRecords.set(projectPath, record);
  }
  return required ? record.promise : record.promise.catch(() => null);
}

function resourceUrl(projectPath) {
  const url = new URL(`/api/map-tilesets/sessions/${encodeURIComponent(state.session.id)}/resource`, location.origin);
  url.searchParams.set("path", projectPath);
  return url.href;
}

function atlasImageProjectPath() {
  const image = state.editor?.document.image;
  if (!image || !state.session) return null;
  return resolveTiledProjectReference(state.session.relativePath, image);
}

function collectionTiles() {
  return Array.isArray(state.editor?.document.tiles) ? state.editor.document.tiles : [];
}

function tileById(id) {
  return collectionTiles().find((tile) => tile.id === id) || null;
}

function tileCountValue() {
  if (!state.editor) return 0;
  return state.editor.kind === "atlas"
    ? Math.max(0, Number(state.editor.document.tilecount) || 0)
    : collectionTiles().length;
}

function tileIdAtIndex(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= tileCountValue()) return null;
  return state.editor.kind === "atlas" ? index : collectionTiles()[index]?.id ?? null;
}

function tileIndexById(id) {
  if (state.editor?.kind === "atlas") {
    return Number.isSafeInteger(id) && id >= 0 && id < tileCountValue() ? id : -1;
  }
  return collectionTiles().findIndex((tile) => tile.id === id);
}

function rebuildCollectionLayout() {
  if (!state.editor || state.editor.kind !== "collection") {
    state.collectionLayout = null;
    return;
  }
  const cellWidth = Math.max(48, Number(state.editor.document.tilewidth) || 1) + 24;
  const cellHeight = Math.max(48, Number(state.editor.document.tileheight) || 1) + 38;
  const count = collectionTiles().length;
  state.collectionLayout = {
    cellWidth,
    cellHeight,
    columns: COLLECTION_COLUMNS,
    rows: Math.max(1, Math.ceil(count / COLLECTION_COLUMNS)),
    width: cellWidth * COLLECTION_COLUMNS,
    height: cellHeight * Math.max(1, Math.ceil(count / COLLECTION_COLUMNS)),
  };
}

function renderAll() {
  if (!state.editor || !state.session) return;
  renderHeader();
  renderToolbar();
  renderTileList();
  renderInspector();
  renderCanvas();
  renderStatus();
  refreshIcons();
}

function renderHeader() {
  const documentValue = state.editor.document;
  elements.tilesetTitle.textContent = documentValue.name || state.session.relativePath.split("/").at(-1);
  elements.tilesetMeta.textContent = `${state.session.relativePath} · ${state.editor.kind === "atlas" ? "单图图集" : "图片集合"}`;
}

function renderToolbar() {
  const ready = Boolean(state.editor) && !state.saving;
  elements.saveButton.disabled = !ready || !state.session.writable || !state.editor.dirty;
  elements.undoButton.disabled = !ready || !state.session.writable || !state.editor.canUndo;
  elements.redoButton.disabled = !ready || !state.session.writable || !state.editor.canRedo;
  elements.zoomOutButton.disabled = !ready;
  elements.zoomInButton.disabled = !ready;
  elements.fitButton.disabled = !ready;
  const collection = state.editor.kind === "collection";
  elements.addCollectionImageButton.hidden = !collection;
  elements.removeCollectionImageButton.hidden = !collection;
  elements.addCollectionImageButton.disabled = !ready || !state.session.writable || !state.projectReady;
  elements.removeCollectionImageButton.disabled = !ready
    || !state.session.writable
    || state.selectedTileId == null
    || tileById(state.selectedTileId) == null;
  elements.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
}

function renderTileList() {
  const count = tileCountValue();
  const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE));
  state.page = clamp(state.page, 0, pageCount - 1);
  const start = state.page * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  for (let index = start; index < Math.min(count, start + PAGE_SIZE); index += 1) {
    const id = tileIdAtIndex(index);
    const tile = state.editor.kind === "collection" ? tileById(id) : null;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tile-list-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(state.selectedTileId === id));
    row.innerHTML = '<span class="tile-id-chip"></span><span><strong></strong><small></small></span>';
    row.querySelector(".tile-id-chip").textContent = String(id);
    row.querySelector("strong").textContent = `瓦片 ${id}`;
    row.querySelector("small").textContent = tile?.image || atlasTilePosition(id);
    row.addEventListener("click", () => selectTile(id, { reveal: true }));
    fragment.append(row);
  }
  if (!count) {
    const empty = document.createElement("p");
    empty.className = "resource-path";
    empty.textContent = "这个瓦片集还没有瓦片";
    fragment.append(empty);
  }
  elements.tileList.replaceChildren(fragment);
  elements.tileCount.textContent = `${count} 格`;
  elements.pageLabel.textContent = count ? `${state.page + 1} / ${pageCount}` : "0 / 0";
  elements.previousPageButton.disabled = state.page <= 0;
  elements.nextPageButton.disabled = state.page >= pageCount - 1;
}

function atlasTilePosition(id) {
  const columns = Math.max(1, Number(state.editor?.document.columns) || 1);
  return `列 ${id % columns + 1} · 行 ${Math.floor(id / columns) + 1}`;
}

function renderInspector() {
  const documentValue = state.editor.document;
  const writable = state.session.writable && !state.saving;
  elements.tilesetKind.textContent = state.editor.kind === "atlas" ? "Atlas" : "Collection";
  elements.tilesetName.value = documentValue.name || "";
  elements.tilesetClass.value = documentValue.class || "";
  elements.atlasSection.hidden = state.editor.kind !== "atlas";
  for (const control of elements.identityForm.elements) control.disabled = !writable;
  if (state.editor.kind === "atlas") {
    elements.atlasDimensions.textContent = `${documentValue.imagewidth} × ${documentValue.imageheight}`;
    elements.atlasImagePath.textContent = documentValue.image || "未引用图片";
    elements.tileWidth.value = String(documentValue.tilewidth || 1);
    elements.tileHeight.value = String(documentValue.tileheight || 1);
    elements.tileMargin.value = String(documentValue.margin || 0);
    elements.tileSpacing.value = String(documentValue.spacing || 0);
    elements.transparentEnabled.checked = Boolean(documentValue.transparentcolor);
    elements.transparentColor.value = normalizeInputColor(documentValue.transparentcolor, "#ff00ff");
    for (const control of elements.atlasForm.elements) control.disabled = !writable;
    renderTransparentControl();
  }
  elements.objectAlignment.value = documentValue.objectalignment || "unspecified";
  elements.tileRenderSize.value = documentValue.tilerendersize || "tile";
  elements.fillMode.value = documentValue.fillmode || "stretch";
  elements.tileOffsetX.value = String(documentValue.tileoffset?.x || 0);
  elements.tileOffsetY.value = String(documentValue.tileoffset?.y || 0);
  elements.gridOrientation.value = documentValue.grid?.orientation || "orthogonal";
  elements.gridWidth.value = String(documentValue.grid?.width || documentValue.tilewidth || 1);
  elements.gridHeight.value = String(documentValue.grid?.height || documentValue.tileheight || 1);
  elements.allowHFlip.checked = documentValue.transformations?.hflip === true;
  elements.allowVFlip.checked = documentValue.transformations?.vflip === true;
  elements.allowRotate.checked = documentValue.transformations?.rotate === true;
  elements.preferUntransformed.checked = documentValue.transformations?.preferuntransformed === true;
  for (const control of elements.renderingForm.elements) control.disabled = !writable;
  renderWangEditor(writable);
  if (state.selectedTileId == null) {
    elements.selectedTileId.textContent = "未选择";
    elements.selectedTileImage.textContent = "在画布或左侧列表选择瓦片";
  } else {
    const tile = tileById(state.selectedTileId);
    elements.selectedTileId.textContent = `ID ${state.selectedTileId}`;
    elements.selectedTileImage.textContent = tile?.image || atlasTilePosition(state.selectedTileId);
  }
  renderTileDetails(writable);
}

function renderWangEditor(writable) {
  const wangsets = Array.isArray(state.editor.document.wangsets) ? state.editor.document.wangsets : [];
  reconcileWangSelection();
  const fragment = document.createDocumentFragment();
  if (!wangsets.length) fragment.append(new Option("尚无 Terrain Set", ""));
  else for (const [index, wangset] of wangsets.entries()) fragment.append(new Option(wangset.name || `Terrain ${index + 1}`, String(index)));
  elements.wangSetSelect.replaceChildren(fragment);
  elements.wangSetSelect.value = wangsets.length ? String(state.activeWangSetIndex) : "";
  elements.wangSetSelect.disabled = !wangsets.length;
  elements.addWangSetButton.disabled = !writable;
  elements.removeWangSetButton.disabled = !writable || !wangsets.length;
  const wangset = wangsets[state.activeWangSetIndex] || null;
  elements.wangSetForm.hidden = !wangset;
  elements.wangColorHeading.hidden = !wangset;
  if (!wangset) {
    elements.wangColorRows.replaceChildren(emptyDetailMessage("添加 Terrain Set 后可以定义颜色和边角", "tile-property-empty"));
    elements.tileWangForm.hidden = true;
    return;
  }
  elements.wangSetName.value = wangset.name || "";
  elements.wangSetClass.value = wangset.class || "";
  elements.wangSetType.value = ["corner", "edge", "mixed"].includes(wangset.type) ? wangset.type : "mixed";
  elements.wangSetTile.value = String(Number.isSafeInteger(wangset.tile) ? wangset.tile : -1);
  for (const control of elements.wangSetForm.elements) control.disabled = !writable;
  elements.addWangColorButton.disabled = !writable;
  renderWangColorRows(wangset.colors || [], writable);
  renderTileWangForm(wangset, writable);
}

function renderWangColorRows(colors, writable) {
  const fragment = document.createDocumentFragment();
  for (const [index, color] of colors.entries()) {
    const row = document.createElement("div");
    row.className = "wang-color-row";
    row.dataset.wangColorIndex = String(index + 1);
    row.innerHTML = '<input data-wang-color-field="color" type="color" aria-label="Terrain 颜色" /><input data-wang-color-field="name" type="text" maxlength="255" aria-label="Terrain 颜色名称" /><button class="mini-icon-button is-danger" data-wang-color-action="remove" type="button" title="删除颜色"><i data-lucide="x"></i></button><div class="wang-color-fields"><label>权重<input data-wang-color-field="probability" type="number" min="0" step="any" /></label><label>代表瓦片<input data-wang-color-field="tile" type="number" min="-1" step="1" /></label></div>';
    row.querySelector('[data-wang-color-field="color"]').value = /^#[a-f0-9]{6}$/iu.test(color.color) ? color.color : "#808080";
    row.querySelector('[data-wang-color-field="name"]').value = color.name || "";
    row.querySelector('[data-wang-color-field="probability"]').value = String(color.probability ?? 1);
    row.querySelector('[data-wang-color-field="tile"]').value = String(Number.isSafeInteger(color.tile) ? color.tile : -1);
    for (const control of row.querySelectorAll("input, button")) control.disabled = !writable;
    fragment.append(row);
  }
  if (!colors.length) fragment.append(emptyDetailMessage("这个 Terrain Set 还没有颜色", "tile-property-empty"));
  elements.wangColorRows.replaceChildren(fragment);
}

function renderTileWangForm(wangset, writable) {
  const selected = state.selectedTileId != null;
  elements.tileWangForm.hidden = !selected;
  if (!selected) return;
  const mapping = [0, 1, 2, 7, null, 3, 6, 5, 4];
  const wangtile = (wangset.wangtiles || []).find((entry) => entry?.tileid === state.selectedTileId);
  const wangid = Array.isArray(wangtile?.wangid) && wangtile.wangid.length === 8 ? wangtile.wangid : Array(8).fill(0);
  const fragment = document.createDocumentFragment();
  for (const index of mapping) {
    if (index == null) {
      const center = document.createElement("span");
      center.className = "tile-wang-center";
      center.textContent = `ID ${state.selectedTileId}`;
      fragment.append(center);
      continue;
    }
    const select = document.createElement("select");
    select.dataset.wangPosition = String(index);
    select.setAttribute("aria-label", wangPositionLabel(index));
    select.append(new Option("0 空", "0"));
    for (const [colorIndex, color] of (wangset.colors || []).entries()) {
      select.append(new Option(`${colorIndex + 1} ${color.name || "未命名"}`, String(colorIndex + 1)));
    }
    select.value = String(wangid[index] || 0);
    const typeBlocked = (wangset.type === "corner" && index % 2 === 1) || (wangset.type === "edge" && index % 2 === 0);
    select.disabled = !writable || typeBlocked;
    fragment.append(select);
  }
  elements.tileWangGrid.replaceChildren(fragment);
  elements.applyTileWangButton.disabled = !writable;
}

function wangPositionLabel(index) {
  return ["左上角", "上边", "右上角", "右边", "右下角", "下边", "左下角", "左边"][index];
}

function renderTileDetails(writable) {
  const selected = state.selectedTileId != null;
  const tile = selected ? state.editor.tileDefinition(state.selectedTileId) : null;
  for (const section of [elements.tileMetadataForm, elements.tilePropertiesSection, elements.tileAnimationSection, elements.tileCollisionSection]) {
    section.hidden = !selected;
  }
  if (!tile) return;
  elements.tileClass.value = tile.class || "";
  elements.tileProbabilityEnabled.checked = tile.probability !== undefined;
  elements.tileProbability.value = String(tile.probability ?? 1);
  for (const control of elements.tileMetadataForm.elements) control.disabled = !writable;
  renderTileProbabilityControl();
  elements.addTilePropertyButton.disabled = !writable;
  elements.addAnimationFrameButton.disabled = !writable;
  elements.newCollisionShape.disabled = !writable;
  elements.addCollisionButton.disabled = !writable;
  renderTilePropertyRows(tile.properties || [], writable);
  renderAnimationFrameRows(tile.animation || [], writable);
  renderCollisionObjectRows(tile.objectgroup?.objects || [], writable);
  ensureAnimationPreviewLoop();
}

function renderTileProbabilityControl() {
  elements.tileProbability.disabled = elements.tileProbabilityEnabled.disabled || !elements.tileProbabilityEnabled.checked;
}

function renderTilePropertyRows(properties, writable) {
  const fragment = document.createDocumentFragment();
  for (const [index, property] of properties.entries()) {
    const supported = ["string", "int", "float", "bool", "color", "file", "object", "class"].includes(property?.type || "string");
    const row = document.createElement("div");
    row.className = "tile-property-row";
    row.dataset.propertyIndex = String(index);
    row.dataset.supported = String(supported);
    const name = document.createElement("input");
    name.value = String(property?.name || "");
    name.placeholder = "名称";
    name.dataset.propertyField = "name";
    name.setAttribute("aria-label", `瓦片属性 ${index + 1} 名称`);
    name.disabled = !writable || !supported;
    const type = document.createElement("select");
    type.dataset.propertyField = "type";
    type.setAttribute("aria-label", `瓦片属性 ${index + 1} 类型`);
    const types = ["string", "int", "float", "bool", "color", "file", "object", "class"];
    if (!types.includes(property.type)) types.push(property.type);
    for (const value of types) type.append(new Option(value, value));
    type.value = property.type || "string";
    type.disabled = !writable || !supported;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-icon-button is-danger";
    remove.dataset.propertyAction = "remove";
    remove.title = "删除属性";
    remove.setAttribute("aria-label", `删除瓦片属性 ${property?.name || index + 1}`);
    remove.disabled = !writable;
    remove.innerHTML = '<i data-lucide="x"></i>';
    const value = tilePropertyValueControl(property, index, writable && supported);
    row.append(name, type, remove, value);
    fragment.append(row);
  }
  if (!properties.length) fragment.append(emptyDetailMessage("这个瓦片还没有自定义属性", "tile-property-empty"));
  elements.tilePropertyRows.replaceChildren(fragment);
}

function tilePropertyValueControl(property, index, enabled) {
  const type = String(property?.type || "string");
  const input = type === "class" || type === "list" ? document.createElement("textarea") : document.createElement("input");
  input.className = "tile-property-value";
  input.dataset.propertyField = "value";
  input.setAttribute("aria-label", `瓦片属性 ${property?.name || index + 1} 值`);
  if (type === "bool") {
    input.type = "checkbox";
    input.checked = property.value === true;
  } else if (["int", "float", "object"].includes(type)) {
    input.type = "number";
    input.step = type === "float" ? "any" : "1";
    if (type === "object") input.min = "0";
    input.value = String(Number(property.value || 0));
  } else {
    if (input instanceof HTMLInputElement) input.type = "text";
    input.value = typeof property.value === "object" && property.value !== null
      ? JSON.stringify(property.value)
      : String(property.value ?? "");
  }
  input.disabled = !enabled;
  return input;
}

function renderAnimationFrameRows(frames, writable) {
  const fragment = document.createDocumentFragment();
  for (const [index, frame] of frames.entries()) {
    const row = document.createElement("div");
    row.className = "animation-frame-row";
    row.dataset.frameIndex = String(index);
    row.innerHTML = '<span></span><label>瓦片 ID<input data-frame-field="tileid" type="number" min="0" step="1" /></label><label>毫秒<input data-frame-field="duration" type="number" min="1" step="1" /></label><button class="mini-icon-button" data-frame-action="up" type="button" title="上移"><i data-lucide="arrow-up"></i></button><button class="mini-icon-button" data-frame-action="down" type="button" title="下移"><i data-lucide="arrow-down"></i></button><button class="mini-icon-button is-danger" data-frame-action="remove" type="button" title="删除帧"><i data-lucide="x"></i></button>';
    row.querySelector("span").textContent = String(index + 1);
    row.querySelector('[data-frame-field="tileid"]').value = String(frame.tileid);
    row.querySelector('[data-frame-field="duration"]').value = String(frame.duration);
    for (const control of row.querySelectorAll("input, button")) control.disabled = !writable;
    row.querySelector('[data-frame-action="up"]').disabled ||= index === 0;
    row.querySelector('[data-frame-action="down"]').disabled ||= index === frames.length - 1;
    fragment.append(row);
  }
  if (!frames.length) fragment.append(emptyDetailMessage("添加至少一帧后，预览会按 Tiled 帧时长循环播放", "animation-frame-empty"));
  elements.animationFrameRows.replaceChildren(fragment);
  state.animationPreviewActive = -1;
}

function renderCollisionObjectRows(objects, writable) {
  const fragment = document.createDocumentFragment();
  for (const object of objects) {
    const shape = tiledObjectShape(object);
    const row = document.createElement("div");
    row.className = "collision-object-row";
    row.dataset.collisionId = String(object.id);
    row.innerHTML = '<header><strong></strong><select data-collision-field="shape" aria-label="碰撞形状"><option value="rectangle">矩形</option><option value="ellipse">椭圆</option><option value="capsule">胶囊</option><option value="polygon">多边形</option><option value="polyline">折线</option></select><button class="mini-icon-button is-danger" data-collision-action="remove" type="button" title="删除碰撞"><i data-lucide="trash-2"></i></button></header><div class="collision-fields"><label>X<input data-collision-field="x" type="number" step="any" /></label><label>Y<input data-collision-field="y" type="number" step="any" /></label><label>旋转<input data-collision-field="rotation" type="number" step="any" /></label><label>宽<input data-collision-field="width" type="number" min="0" step="any" /></label><label>高<input data-collision-field="height" type="number" min="0" step="any" /></label><label>名称<input data-collision-field="name" type="text" maxlength="255" /></label><label>Class<input data-collision-field="className" type="text" maxlength="255" /></label><label class="collision-points">顶点（每行 x,y）<textarea data-collision-field="points"></textarea></label></div>';
    row.querySelector("strong").textContent = `对象 ${object.id}`;
    row.querySelector('[data-collision-field="shape"]').value = shape;
    for (const field of ["x", "y", "width", "height", "rotation", "name"]) {
      row.querySelector(`[data-collision-field="${field}"]`).value = String(object[field] ?? (field === "name" ? "Collision" : 0));
    }
    row.querySelector('[data-collision-field="className"]').value = String(object.class || "");
    const points = object.polygon || object.polyline || [];
    const pointControl = row.querySelector('[data-collision-field="points"]');
    pointControl.value = points.map((point) => `${point.x},${point.y}`).join("\n");
    pointControl.closest("label").hidden = !["polygon", "polyline"].includes(shape);
    for (const control of row.querySelectorAll("input, select, textarea, button")) control.disabled = !writable;
    fragment.append(row);
  }
  if (!objects.length) fragment.append(emptyDetailMessage("碰撞数据保存在当前 tile 的 objectgroup 中", "collision-object-empty"));
  elements.collisionObjectRows.replaceChildren(fragment);
  elements.collisionCount.textContent = `${objects.length} 个`;
}

function emptyDetailMessage(message, className) {
  const empty = document.createElement("p");
  empty.className = className;
  empty.textContent = message;
  return empty;
}

function renderTransparentControl() {
  elements.transparentColor.disabled = elements.transparentEnabled.disabled || !elements.transparentEnabled.checked;
}

function renderStatus() {
  elements.tilesetState.dataset.status = "ready";
  elements.tilesetState.innerHTML = '<i data-lucide="circle-check"></i><span>已就绪</span>';
  elements.selectionState.textContent = state.selectedTileId == null ? "未选择瓦片" : `瓦片 ${state.selectedTileId}`;
  elements.documentState.textContent = state.saving
    ? "正在保存"
    : state.editor.dirty
      ? "有未保存改动"
      : state.session.writable ? "已保存" : "只读";
  elements.documentState.dataset.dirty = String(state.editor.dirty || state.saving);
}

function renderAnimationPreviewFrame(timestamp) {
  const animated = drawAnimationPreview(timestamp);
  if (animated) requestAnimationFrame(renderAnimationPreviewFrame);
  else state.animationPreviewRunning = false;
}

function drawAnimationPreview(timestamp) {
  const canvas = elements.animationPreviewCanvas;
  const context = canvas.getContext("2d", { alpha: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.editor || state.selectedTileId == null || elements.tileAnimationSection.hidden) return false;
  const tile = state.editor.tileDefinition(state.selectedTileId);
  const frames = Array.isArray(tile.animation) ? tile.animation : [];
  let tileId = state.selectedTileId;
  let activeIndex = -1;
  if (frames.length) {
    const total = frames.reduce((sum, frame) => sum + Number(frame.duration || 0), 0);
    let elapsed = total > 0 ? (timestamp - state.animationStartedAt) % total : 0;
    activeIndex = frames.length - 1;
    for (let index = 0; index < frames.length; index += 1) {
      if (elapsed < frames[index].duration) {
        activeIndex = index;
        break;
      }
      elapsed -= frames[index].duration;
    }
    tileId = frames[activeIndex].tileid;
  }
  if (state.animationPreviewActive !== activeIndex) {
    state.animationPreviewActive = activeIndex;
    for (const row of elements.animationFrameRows.querySelectorAll(".animation-frame-row")) {
      row.dataset.active = String(Number(row.dataset.frameIndex) === activeIndex);
    }
  }
  drawPreviewTile(context, tileId, canvas.width, canvas.height);
  context.fillStyle = "rgba(10, 14, 14, .78)";
  context.fillRect(6, canvas.height - 21, 74, 15);
  context.fillStyle = "#dbe3e1";
  context.font = "10px ui-monospace, monospace";
  context.fillText(`Tile ${tileId}`, 11, canvas.height - 10);
  return frames.length > 0 && document.visibilityState === "visible";
}

function ensureAnimationPreviewLoop() {
  if (state.animationPreviewRunning) return;
  state.animationPreviewRunning = true;
  requestAnimationFrame(renderAnimationPreviewFrame);
}

function drawPreviewTile(context, id, width, height) {
  let image = null;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = 1;
  let sourceHeight = 1;
  if (state.editor.kind === "atlas") {
    const documentValue = state.editor.document;
    const record = state.imageRecords.get(atlasImageProjectPath());
    image = record?.status === "ready" ? record.image : null;
    const column = id % documentValue.columns;
    const row = Math.floor(id / documentValue.columns);
    sourceWidth = documentValue.tilewidth;
    sourceHeight = documentValue.tileheight;
    sourceX = (documentValue.margin || 0) + column * (sourceWidth + (documentValue.spacing || 0));
    sourceY = (documentValue.margin || 0) + row * (sourceHeight + (documentValue.spacing || 0));
  } else {
    const tile = tileById(id);
    if (tile) {
      const projectPath = resolveTiledProjectReference(state.session.relativePath, tile.image);
      const record = state.imageRecords.get(projectPath);
      if (!record) void ensureImage(projectPath);
      image = record?.status === "ready" ? record.image : null;
      sourceWidth = tile.imagewidth;
      sourceHeight = tile.imageheight;
    }
  }
  const scale = Math.min((width - 34) / Math.max(1, sourceWidth), (height - 22) / Math.max(1, sourceHeight));
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (width - drawWidth) / 2;
  const drawY = (height - drawHeight) / 2;
  if (image) {
    context.imageSmoothingEnabled = scale < 1;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, drawX, drawY, drawWidth, drawHeight);
  } else {
    context.strokeStyle = "#ef7272";
    context.strokeRect(drawX, drawY, drawWidth, drawHeight);
  }
}

function resizeCanvas() {
  const rect = elements.tilesetStage.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (elements.tilesetCanvas.width !== width || elements.tilesetCanvas.height !== height) {
    elements.tilesetCanvas.width = width;
    elements.tilesetCanvas.height = height;
  }
  renderCanvas();
}

function renderCanvas() {
  const canvas = elements.tilesetCanvas;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  canvasContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  canvasContext.clearRect(0, 0, width, height);
  if (!state.editor) return;
  canvasContext.save();
  canvasContext.translate(state.offsetX, state.offsetY);
  canvasContext.scale(state.scale, state.scale);
  if (state.editor.kind === "atlas") drawAtlas(width, height);
  else drawCollection(width, height);
  canvasContext.restore();
}

function drawAtlas(viewWidth, viewHeight) {
  const documentValue = state.editor.document;
  const projectPath = atlasImageProjectPath();
  const record = state.imageRecords.get(projectPath);
  if (record?.status === "ready") {
    canvasContext.imageSmoothingEnabled = state.scale < 1;
    canvasContext.drawImage(record.image, 0, 0, documentValue.imagewidth, documentValue.imageheight);
  } else {
    drawMissingImage(0, 0, documentValue.imagewidth, documentValue.imageheight);
  }
  const tileWidth = documentValue.tilewidth;
  const tileHeight = documentValue.tileheight;
  const margin = documentValue.margin || 0;
  const spacing = documentValue.spacing || 0;
  canvasContext.lineWidth = 1 / state.scale;
  const worldLeft = -state.offsetX / state.scale;
  const worldTop = -state.offsetY / state.scale;
  const worldRight = worldLeft + viewWidth / state.scale;
  const worldBottom = worldTop + viewHeight / state.scale;
  const firstColumn = clamp(Math.floor((worldLeft - margin) / (tileWidth + spacing)) - 1, 0, documentValue.columns - 1);
  const lastColumn = clamp(Math.ceil((worldRight - margin) / (tileWidth + spacing)) + 1, 0, documentValue.columns - 1);
  const rowCount = Math.max(1, Math.ceil(documentValue.tilecount / documentValue.columns));
  const firstRow = clamp(Math.floor((worldTop - margin) / (tileHeight + spacing)) - 1, 0, rowCount - 1);
  const lastRow = clamp(Math.ceil((worldBottom - margin) / (tileHeight + spacing)) + 1, 0, rowCount - 1);
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const id = row * documentValue.columns + column;
      if (id >= documentValue.tilecount) break;
      const x = margin + column * (tileWidth + spacing);
      const y = margin + row * (tileHeight + spacing);
      canvasContext.strokeStyle = id === state.selectedTileId ? "#63d49b" : "rgba(255,255,255,.38)";
      canvasContext.strokeRect(x + .5 / state.scale, y + .5 / state.scale, tileWidth, tileHeight);
      if (id === state.selectedTileId) {
        canvasContext.fillStyle = "rgba(99,212,155,.18)";
        canvasContext.fillRect(x, y, tileWidth, tileHeight);
        drawTileCollisionOverlay(state.editor.tileDefinition(id), x, y);
        drawTileWangOverlay(id, x, y, tileWidth, tileHeight);
      }
    }
  }
}

function drawCollection(viewWidth, viewHeight) {
  const layout = state.collectionLayout;
  const tiles = collectionTiles();
  if (!layout || !tiles.length) return;
  const worldLeft = -state.offsetX / state.scale;
  const worldTop = -state.offsetY / state.scale;
  const worldRight = worldLeft + viewWidth / state.scale;
  const worldBottom = worldTop + viewHeight / state.scale;
  const firstRow = clamp(Math.floor(worldTop / layout.cellHeight) - 1, 0, layout.rows - 1);
  const lastRow = clamp(Math.ceil(worldBottom / layout.cellHeight) + 1, 0, layout.rows - 1);
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const index = row * layout.columns + column;
      const tile = tiles[index];
      if (!tile) break;
      const x = column * layout.cellWidth;
      const y = row * layout.cellHeight;
      if (x > worldRight || x + layout.cellWidth < worldLeft) continue;
      drawCollectionTile(tile, x, y, layout);
    }
  }
}

function drawCollectionTile(tile, x, y, layout) {
  const projectPath = resolveTiledProjectReference(state.session.relativePath, tile.image);
  const record = state.imageRecords.get(projectPath);
  if (!record) void ensureImage(projectPath);
  const imageX = x + (layout.cellWidth - tile.imagewidth) / 2;
  const imageY = y + 8 + (Math.max(48, state.editor.document.tileheight) - tile.imageheight) / 2;
  canvasContext.fillStyle = tile.id === state.selectedTileId ? "rgba(99,212,155,.16)" : "rgba(17,22,23,.72)";
  canvasContext.fillRect(x + 3, y + 3, layout.cellWidth - 6, layout.cellHeight - 6);
  if (record?.status === "ready") canvasContext.drawImage(record.image, imageX, imageY, tile.imagewidth, tile.imageheight);
  else drawMissingImage(imageX, imageY, tile.imagewidth, tile.imageheight);
  canvasContext.strokeStyle = tile.id === state.selectedTileId ? "#63d49b" : "rgba(255,255,255,.18)";
  canvasContext.lineWidth = 1 / state.scale;
  canvasContext.strokeRect(x + 3, y + 3, layout.cellWidth - 6, layout.cellHeight - 6);
  canvasContext.fillStyle = tile.id === state.selectedTileId ? "#63d49b" : "#a8b1af";
  canvasContext.font = "10px ui-monospace, monospace";
  canvasContext.fillText(`ID ${tile.id}`, x + 9, y + layout.cellHeight - 10);
  if (tile.id === state.selectedTileId) {
    drawTileCollisionOverlay(tile, imageX, imageY);
    drawTileWangOverlay(tile.id, imageX, imageY, tile.imagewidth, tile.imageheight);
  }
}

function drawTileCollisionOverlay(tile, originX, originY) {
  const objects = Array.isArray(tile?.objectgroup?.objects) ? tile.objectgroup.objects : [];
  if (!objects.length) return;
  canvasContext.save();
  canvasContext.strokeStyle = "#ffca5c";
  canvasContext.fillStyle = "rgba(255, 202, 92, .18)";
  canvasContext.lineWidth = 1.5 / state.scale;
  for (const object of objects) {
    const shape = tiledObjectShape(object);
    canvasContext.save();
    canvasContext.translate(originX + Number(object.x || 0), originY + Number(object.y || 0));
    canvasContext.rotate(Number(object.rotation || 0) * Math.PI / 180);
    canvasContext.beginPath();
    if (shape === "ellipse") {
      canvasContext.ellipse(Number(object.width || 0) / 2, Number(object.height || 0) / 2, Math.abs(Number(object.width || 0)) / 2, Math.abs(Number(object.height || 0)) / 2, 0, 0, Math.PI * 2);
    } else if (shape === "capsule") {
      const width = Math.max(0, Number(object.width || 0));
      const height = Math.max(0, Number(object.height || 0));
      canvasContext.roundRect(0, 0, width, height, Math.min(width, height) / 2);
    } else if (shape === "polygon" || shape === "polyline") {
      const points = object[shape] || [];
      for (const [index, point] of points.entries()) {
        if (index) canvasContext.lineTo(Number(point.x || 0), Number(point.y || 0));
        else canvasContext.moveTo(Number(point.x || 0), Number(point.y || 0));
      }
      if (shape === "polygon") canvasContext.closePath();
    } else {
      canvasContext.rect(0, 0, Math.max(0, Number(object.width || 0)), Math.max(0, Number(object.height || 0)));
    }
    if (shape !== "polyline") canvasContext.fill();
    canvasContext.stroke();
    canvasContext.restore();
  }
  canvasContext.restore();
}

function drawTileWangOverlay(tileId, originX, originY, width, height) {
  const wangset = state.editor.document.wangsets?.[state.activeWangSetIndex];
  const wangtile = wangset?.wangtiles?.find((entry) => entry?.tileid === tileId);
  if (!wangtile || !Array.isArray(wangtile.wangid)) return;
  const positions = [
    [0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5],
  ];
  const radius = Math.max(2 / state.scale, Math.min(width, height) * .09);
  canvasContext.save();
  canvasContext.lineWidth = 1 / state.scale;
  for (let index = 0; index < 8; index += 1) {
    const colorIndex = Number(wangtile.wangid[index] || 0);
    const color = wangset.colors?.[colorIndex - 1]?.color;
    if (!color) continue;
    canvasContext.beginPath();
    canvasContext.arc(originX + positions[index][0] * width, originY + positions[index][1] * height, radius, 0, Math.PI * 2);
    canvasContext.fillStyle = color;
    canvasContext.fill();
    canvasContext.strokeStyle = "#ffffff";
    canvasContext.stroke();
  }
  canvasContext.restore();
}

function drawMissingImage(x, y, width, height) {
  canvasContext.fillStyle = "#242b2c";
  canvasContext.fillRect(x, y, Math.max(1, width), Math.max(1, height));
  canvasContext.strokeStyle = "#ef7272";
  canvasContext.lineWidth = 1 / state.scale;
  canvasContext.beginPath();
  canvasContext.moveTo(x, y);
  canvasContext.lineTo(x + width, y + height);
  canvasContext.moveTo(x + width, y);
  canvasContext.lineTo(x, y + height);
  canvasContext.stroke();
}

function contentBounds() {
  if (!state.editor) return { width: 1, height: 1 };
  if (state.editor.kind === "atlas") return {
    width: Math.max(1, state.editor.document.imagewidth || 1),
    height: Math.max(1, state.editor.document.imageheight || 1),
  };
  return state.collectionLayout || { width: 1, height: 1 };
}

function fitTileset() {
  if (!state.editor) return;
  const rect = elements.tilesetStage.getBoundingClientRect();
  const bounds = contentBounds();
  state.scale = clamp(Math.min((rect.width - 40) / bounds.width, (rect.height - 40) / bounds.height), .05, 16);
  state.offsetX = (rect.width - bounds.width * state.scale) / 2;
  state.offsetY = (rect.height - bounds.height * state.scale) / 2;
  renderAll();
}

function zoomAt(factor, clientX = null, clientY = null) {
  if (!state.editor) return;
  const rect = elements.tilesetStage.getBoundingClientRect();
  const anchorX = clientX == null ? rect.width / 2 : clientX - rect.left;
  const anchorY = clientY == null ? rect.height / 2 : clientY - rect.top;
  const worldX = (anchorX - state.offsetX) / state.scale;
  const worldY = (anchorY - state.offsetY) / state.scale;
  state.scale = clamp(state.scale * factor, .05, 16);
  state.offsetX = anchorX - worldX * state.scale;
  state.offsetY = anchorY - worldY * state.scale;
  renderAll();
}

function beginPointer(event) {
  if (!state.editor || event.button > 1) return;
  elements.tilesetCanvas.setPointerCapture(event.pointerId);
  state.pointer = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
  elements.tilesetStage.dataset.dragging = "true";
}

function movePointer(event) {
  const pointer = state.pointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 4) pointer.moved = true;
  state.offsetX += dx;
  state.offsetY += dy;
  renderCanvas();
}

function finishPointer(event) {
  const pointer = state.pointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  if (!pointer.moved) {
    const id = hitTile(event.clientX, event.clientY);
    if (id != null) selectTile(id);
  }
  cancelPointer(event);
}

function cancelPointer(event) {
  if (state.pointer?.pointerId !== event.pointerId) return;
  state.pointer = null;
  elements.tilesetStage.dataset.dragging = "false";
  if (elements.tilesetCanvas.hasPointerCapture(event.pointerId)) elements.tilesetCanvas.releasePointerCapture(event.pointerId);
}

function hitTile(clientX, clientY) {
  const rect = elements.tilesetCanvas.getBoundingClientRect();
  const x = (clientX - rect.left - state.offsetX) / state.scale;
  const y = (clientY - rect.top - state.offsetY) / state.scale;
  if (state.editor.kind === "atlas") {
    const documentValue = state.editor.document;
    const localX = x - (documentValue.margin || 0);
    const localY = y - (documentValue.margin || 0);
    if (localX < 0 || localY < 0) return null;
    const stepX = documentValue.tilewidth + (documentValue.spacing || 0);
    const stepY = documentValue.tileheight + (documentValue.spacing || 0);
    const column = Math.floor(localX / stepX);
    const row = Math.floor(localY / stepY);
    if (localX % stepX >= documentValue.tilewidth || localY % stepY >= documentValue.tileheight) return null;
    const id = row * documentValue.columns + column;
    return column < documentValue.columns && id < documentValue.tilecount ? id : null;
  }
  const layout = state.collectionLayout;
  if (!layout || x < 0 || y < 0) return null;
  const column = Math.floor(x / layout.cellWidth);
  const row = Math.floor(y / layout.cellHeight);
  if (column < 0 || column >= layout.columns) return null;
  return collectionTiles()[row * layout.columns + column]?.id ?? null;
}

function handleWheel(event) {
  event.preventDefault();
  zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
}

function selectTile(id, { reveal = false } = {}) {
  const index = tileIndexById(id);
  if (index < 0) return;
  state.selectedTileId = id;
  state.animationStartedAt = performance.now();
  state.page = Math.floor(index / PAGE_SIZE);
  if (reveal && innerWidth <= 620) toggleMobilePanel("tiles");
  renderAll();
}

function setPage(page) {
  const pageCount = Math.max(1, Math.ceil(tileCountValue() / PAGE_SIZE));
  state.page = clamp(page, 0, pageCount - 1);
  renderTileList();
  refreshIcons();
}

function reconcileSelection() {
  if (state.selectedTileId != null && tileIndexById(state.selectedTileId) < 0) state.selectedTileId = null;
}

function applyIdentity(event) {
  event.preventDefault();
  try {
    state.editor.setIdentity({ name: elements.tilesetName.value, className: elements.tilesetClass.value });
    showInspectorMessage("基本属性已应用");
  } catch (error) {
    showInspectorError(error);
  }
}

function applyAtlasGrid(event) {
  event.preventDefault();
  try {
    state.editor.setAtlasGrid({
      tilewidth: Number(elements.tileWidth.value),
      tileheight: Number(elements.tileHeight.value),
      margin: Number(elements.tileMargin.value),
      spacing: Number(elements.tileSpacing.value),
      transparentcolor: elements.transparentEnabled.checked ? elements.transparentColor.value : null,
    });
    showInspectorMessage("图集网格已应用");
  } catch (error) {
    showInspectorError(error);
  }
}

function applyRendering(event) {
  event.preventDefault();
  try {
    state.editor.setRendering({
      objectalignment: elements.objectAlignment.value,
      tilerendersize: elements.tileRenderSize.value,
      fillmode: elements.fillMode.value,
      tileoffsetX: Number(elements.tileOffsetX.value),
      tileoffsetY: Number(elements.tileOffsetY.value),
      gridOrientation: elements.gridOrientation.value,
      gridWidth: Number(elements.gridWidth.value),
      gridHeight: Number(elements.gridHeight.value),
      transformations: {
        hflip: elements.allowHFlip.checked,
        vflip: elements.allowVFlip.checked,
        rotate: elements.allowRotate.checked,
        preferuntransformed: elements.preferUntransformed.checked,
      },
    });
    showInspectorMessage("渲染属性已应用");
  } catch (error) {
    showInspectorError(error);
  }
}

function applyTileMetadata(event) {
  event.preventDefault();
  if (state.selectedTileId == null) return;
  try {
    state.editor.setTileMetadata(state.selectedTileId, {
      className: elements.tileClass.value,
      probability: elements.tileProbabilityEnabled.checked ? Number(elements.tileProbability.value) : null,
    });
    showInspectorMessage(`瓦片 ${state.selectedTileId} 属性已应用`);
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

function addTileProperty() {
  if (state.selectedTileId == null || !state.session?.writable) return;
  const properties = tileProperties();
  const names = new Set(properties.map((property) => property?.name));
  let suffix = 1;
  let name = "property";
  while (names.has(name)) name = `property${++suffix}`;
  properties.push({ name, type: "string", value: "" });
  try {
    state.editor.setTileProperties(state.selectedTileId, properties, { label: "添加瓦片属性" });
    showInspectorMessage(`已添加属性 ${name}`);
  } catch (error) {
    showInspectorError(error);
  }
}

function updateTileProperty(event) {
  const control = event.target.closest?.("[data-property-field]");
  const row = control?.closest?.(".tile-property-row");
  if (!control || !row || state.selectedTileId == null) return;
  const index = Number(row.dataset.propertyIndex);
  const properties = tileProperties();
  if (!properties[index]) return;
  try {
    if (control.dataset.propertyField === "name") properties[index].name = control.value;
    else if (control.dataset.propertyField === "type") {
      properties[index].type = control.value;
      properties[index].value = coerceTilePropertyValue(control.value, properties[index].value);
    } else properties[index].value = readTilePropertyValue(properties[index].type, control);
    state.editor.setTileProperties(state.selectedTileId, properties);
    showInspectorMessage(`属性 ${properties[index].name} 已更新`);
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

function handleTilePropertyAction(event) {
  const button = event.target.closest?.("[data-property-action]");
  const row = button?.closest?.(".tile-property-row");
  if (!button || !row || state.selectedTileId == null) return;
  const index = Number(row.dataset.propertyIndex);
  const properties = tileProperties();
  const [removed] = properties.splice(index, 1);
  if (!removed) return;
  try {
    state.editor.setTileProperties(state.selectedTileId, properties, { label: "删除瓦片属性" });
    showInspectorMessage(`已删除属性 ${removed.name}`);
  } catch (error) {
    showInspectorError(error);
  }
}

function tileProperties() {
  const tile = state.selectedTileId == null ? null : state.editor.tileDefinition(state.selectedTileId);
  return cloneJsonValue(Array.isArray(tile?.properties) ? tile.properties : []);
}

function readTilePropertyValue(type, control) {
  if (type === "bool") return control.checked;
  if (["int", "object"].includes(type)) {
    if (!Number.isSafeInteger(control.valueAsNumber)) throw new Error("整数属性必须是安全整数");
    if (type === "object" && control.valueAsNumber < 0) throw new Error("对象 ID 不能为负数");
    return control.valueAsNumber;
  }
  if (type === "float") {
    if (!Number.isFinite(control.valueAsNumber)) throw new Error("浮点属性必须是有效数字");
    return control.valueAsNumber;
  }
  if (type === "class") {
    const value = JSON.parse(control.value || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Class 属性必须是 JSON 对象");
    return value;
  }
  return control.value;
}

function coerceTilePropertyValue(type, value) {
  if (type === "bool") return Boolean(value);
  if (["int", "object"].includes(type)) return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  if (type === "float") return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (type === "class") return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
}

function addAnimationFrame() {
  if (state.selectedTileId == null || !state.session?.writable) return;
  const frames = tileAnimation();
  frames.push({ tileid: frames.at(-1)?.tileid ?? state.selectedTileId, duration: frames.at(-1)?.duration ?? 100 });
  commitTileAnimation(frames, "添加动画帧");
}

function updateTileAnimationFromRows() {
  if (state.selectedTileId == null) return;
  const frames = [...elements.animationFrameRows.querySelectorAll(".animation-frame-row")].map((row) => ({
    tileid: Number(row.querySelector('[data-frame-field="tileid"]').value),
    duration: Number(row.querySelector('[data-frame-field="duration"]').value),
  }));
  commitTileAnimation(frames, "修改动画帧");
}

function handleAnimationFrameAction(event) {
  const button = event.target.closest?.("[data-frame-action]");
  const row = button?.closest?.(".animation-frame-row");
  if (!button || !row || state.selectedTileId == null) return;
  const frames = tileAnimation();
  const index = Number(row.dataset.frameIndex);
  const action = button.dataset.frameAction;
  if (action === "remove") frames.splice(index, 1);
  else {
    const target = action === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= frames.length) return;
    [frames[index], frames[target]] = [frames[target], frames[index]];
  }
  commitTileAnimation(frames, action === "remove" ? "删除动画帧" : "调整动画帧顺序");
}

function tileAnimation() {
  const tile = state.selectedTileId == null ? null : state.editor.tileDefinition(state.selectedTileId);
  return cloneJsonValue(Array.isArray(tile?.animation) ? tile.animation : []);
}

function commitTileAnimation(frames, label) {
  try {
    state.editor.setTileAnimation(state.selectedTileId, frames, { label });
    state.animationStartedAt = performance.now();
    showInspectorMessage(frames.length ? `动画已更新，共 ${frames.length} 帧` : "动画已移除");
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

function addTileCollision() {
  if (state.selectedTileId == null || !state.session?.writable) return;
  try {
    const object = state.editor.addTileCollision(state.selectedTileId, {
      shape: elements.newCollisionShape.value,
      width: Number(state.editor.document.tilewidth || 1),
      height: Number(state.editor.document.tileheight || 1),
    });
    showInspectorMessage(`已添加碰撞对象 ${object.id}`);
  } catch (error) {
    showInspectorError(error);
  }
}

function updateTileCollisionFromRow(event) {
  const control = event.target.closest?.("[data-collision-field]");
  const row = control?.closest?.(".collision-object-row");
  if (!control || !row || state.selectedTileId == null) return;
  try {
    const rawPoints = row.querySelector('[data-collision-field="points"]').value.trim();
    state.editor.updateTileCollision(state.selectedTileId, Number(row.dataset.collisionId), {
      shape: row.querySelector('[data-collision-field="shape"]').value,
      x: Number(row.querySelector('[data-collision-field="x"]').value),
      y: Number(row.querySelector('[data-collision-field="y"]').value),
      width: Number(row.querySelector('[data-collision-field="width"]').value),
      height: Number(row.querySelector('[data-collision-field="height"]').value),
      rotation: Number(row.querySelector('[data-collision-field="rotation"]').value),
      name: row.querySelector('[data-collision-field="name"]').value,
      className: row.querySelector('[data-collision-field="className"]').value,
      ...(rawPoints ? { points: parseCollisionPoints(rawPoints) } : {}),
    });
    showInspectorMessage(`碰撞对象 ${row.dataset.collisionId} 已更新`);
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

function handleTileCollisionAction(event) {
  const button = event.target.closest?.("[data-collision-action]");
  const row = button?.closest?.(".collision-object-row");
  if (!button || !row || state.selectedTileId == null) return;
  try {
    state.editor.removeTileCollision(state.selectedTileId, Number(row.dataset.collisionId));
    showInspectorMessage(`已删除碰撞对象 ${row.dataset.collisionId}`);
  } catch (error) {
    showInspectorError(error);
  }
}

function parseCollisionPoints(value) {
  return value.split(/\n+/u).map((line, index) => {
    const parts = line.trim().split(/\s*,\s*/u);
    if (parts.length !== 2 || !parts.every((part) => Number.isFinite(Number(part)))) {
      throw new Error(`顶点第 ${index + 1} 行必须是 x,y`);
    }
    return { x: Number(parts[0]), y: Number(parts[1]) };
  });
}

function addWangSet() {
  if (!state.session?.writable) return;
  try {
    state.activeWangSetIndex = state.editor.addWangSet();
    renderAll();
    showInspectorMessage("已添加 Terrain/Wang Set");
  } catch (error) {
    showInspectorError(error);
  }
}

function removeWangSet() {
  const wangsets = state.editor?.document.wangsets || [];
  if (!state.session?.writable || !wangsets[state.activeWangSetIndex]) return;
  const name = wangsets[state.activeWangSetIndex].name;
  try {
    state.editor.removeWangSet(state.activeWangSetIndex);
    reconcileWangSelection();
    showInspectorMessage(`已删除 ${name}，保存前可以撤销`);
  } catch (error) {
    showInspectorError(error);
  }
}

function selectWangSet() {
  if (elements.wangSetSelect.value === "") return;
  state.activeWangSetIndex = Number(elements.wangSetSelect.value);
  renderAll();
}

function reconcileWangSelection() {
  const count = Array.isArray(state.editor?.document.wangsets) ? state.editor.document.wangsets.length : 0;
  state.activeWangSetIndex = count ? clamp(state.activeWangSetIndex, 0, count - 1) : 0;
}

function applyWangSet(event) {
  event.preventDefault();
  try {
    state.editor.updateWangSet(state.activeWangSetIndex, {
      name: elements.wangSetName.value,
      className: elements.wangSetClass.value,
      type: elements.wangSetType.value,
      tile: Number(elements.wangSetTile.value),
    });
    showInspectorMessage("Terrain/Wang Set 已更新");
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

function addWangColor() {
  try {
    const index = state.editor.addWangColor(state.activeWangSetIndex);
    showInspectorMessage(`已添加 Terrain 颜色 ${index}`);
  } catch (error) {
    showInspectorError(error);
  }
}

function updateWangColorFromRow(event) {
  const control = event.target.closest?.("[data-wang-color-field]");
  const row = control?.closest?.(".wang-color-row");
  if (!control || !row) return;
  try {
    state.editor.updateWangColor(state.activeWangSetIndex, Number(row.dataset.wangColorIndex), {
      color: row.querySelector('[data-wang-color-field="color"]').value,
      name: row.querySelector('[data-wang-color-field="name"]').value,
      probability: Number(row.querySelector('[data-wang-color-field="probability"]').value),
      tile: Number(row.querySelector('[data-wang-color-field="tile"]').value),
    });
    showInspectorMessage(`Terrain 颜色 ${row.dataset.wangColorIndex} 已更新`);
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

function handleWangColorAction(event) {
  const button = event.target.closest?.("[data-wang-color-action]");
  const row = button?.closest?.(".wang-color-row");
  if (!button || !row) return;
  try {
    state.editor.removeWangColor(state.activeWangSetIndex, Number(row.dataset.wangColorIndex));
    showInspectorMessage("Terrain 颜色已删除，现有 wangid 已保持语义重写");
  } catch (error) {
    showInspectorError(error);
  }
}

function applyTileWangId(event) {
  event.preventDefault();
  if (state.selectedTileId == null) return;
  const wangid = Array(8).fill(0);
  for (const select of elements.tileWangGrid.querySelectorAll("[data-wang-position]")) {
    wangid[Number(select.dataset.wangPosition)] = Number(select.value);
  }
  try {
    state.editor.setTileWangId(state.activeWangSetIndex, state.selectedTileId, wangid);
    showInspectorMessage(`瓦片 ${state.selectedTileId} 的 Terrain 边角已更新`);
  } catch (error) {
    showInspectorError(error);
    renderInspector();
  }
}

async function openCollectionImageDialog() {
  if (state.editor?.kind !== "collection" || !state.session?.writable || !state.projectReady) return;
  state.selectedCollectionImage = null;
  elements.collectionImageSearch.value = "";
  elements.collectionImageState.textContent = "正在读取工程图片";
  elements.collectionImageState.dataset.status = "busy";
  elements.collectionImageSubmitButton.disabled = true;
  if (!elements.collectionImageDialog.open) elements.collectionImageDialog.showModal();
  renderCollectionImageList();
  await loadCollectionProjectImages();
  requestAnimationFrame(() => elements.collectionImageSearch.focus());
}

function closeCollectionImageDialog() {
  if (state.collectionImagesLoading) return;
  if (elements.collectionImageDialog.open) elements.collectionImageDialog.close();
  state.selectedCollectionImage = null;
}

async function loadCollectionProjectImages() {
  const client = state.projectClient;
  if (!client || state.collectionImagesLoading) return;
  state.collectionImagesLoading = true;
  renderCollectionImageList();
  try {
    const results = await Promise.all(["png", "webp", "jpg", "jpeg"].map((query) => (
      client.search({ query, kinds: ["image"], limit: 100 }).catch(() => ({ entries: [] }))
    )));
    if (!elements.collectionImageDialog.open || state.projectClient !== client) return;
    const existing = new Set(collectionTiles().map((tile) => (
      resolveTiledProjectReference(state.session.relativePath, tile.image)
    )));
    const images = new Map();
    for (const page of results) {
      for (const entry of page.entries) if (!existing.has(entry.path)) images.set(entry.path, entry);
    }
    state.collectionImages = [...images.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
    elements.collectionImageState.textContent = state.collectionImages.length
      ? `可添加 ${state.collectionImages.length} 张图片`
      : "工程中没有尚未加入的图片";
    elements.collectionImageState.dataset.status = state.collectionImages.length ? "ready" : "";
  } catch (error) {
    elements.collectionImageState.textContent = error.message;
    elements.collectionImageState.dataset.status = "error";
  } finally {
    state.collectionImagesLoading = false;
    renderCollectionImageList();
  }
}

function renderCollectionImageList() {
  const query = elements.collectionImageSearch.value.trim().toLocaleLowerCase("zh-CN");
  const fragment = document.createDocumentFragment();
  let count = 0;
  for (const entry of state.collectionImages) {
    if (query && !entry.path.toLocaleLowerCase("zh-CN").includes(query)) continue;
    count += 1;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "collection-image-row";
    row.dataset.imagePath = entry.path;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(state.selectedCollectionImage === entry.path));
    row.disabled = state.collectionImagesLoading;
    row.innerHTML = '<i data-lucide="image"></i><span><strong></strong><small></small></span><i data-lucide="check"></i>';
    row.querySelector("strong").textContent = entry.name;
    row.querySelector("small").textContent = entry.path;
    fragment.append(row);
  }
  if (!count) {
    const empty = document.createElement("p");
    empty.className = "collection-image-empty";
    empty.textContent = state.collectionImagesLoading ? "正在读取" : "没有匹配的工程图片";
    fragment.append(empty);
  }
  elements.collectionImageList.replaceChildren(fragment);
  elements.collectionImageSubmitButton.disabled = state.collectionImagesLoading || !state.selectedCollectionImage;
  refreshIcons();
}

function selectCollectionImageRow(event) {
  const row = event.target.closest?.(".collection-image-row");
  if (!row || row.disabled || !elements.collectionImageList.contains(row)) return;
  state.selectedCollectionImage = row.dataset.imagePath;
  renderCollectionImageList();
}

async function submitCollectionImage(event) {
  event.preventDefault();
  const projectPath = state.selectedCollectionImage;
  if (!projectPath || state.collectionImagesLoading) return;
  state.collectionImagesLoading = true;
  elements.collectionImageState.textContent = "正在解码图片尺寸";
  elements.collectionImageState.dataset.status = "busy";
  renderCollectionImageList();
  try {
    const image = await loadProjectImage(projectPath);
    const reference = relativeTiledProjectReference(state.session.relativePath, projectPath);
    const tile = state.editor.addCollectionTile({
      image: reference,
      imagewidth: image.naturalWidth,
      imageheight: image.naturalHeight,
    });
    state.selectedTileId = tile.id;
    state.collectionImages = state.collectionImages.filter((entry) => entry.path !== projectPath);
    state.selectedCollectionImage = null;
    elements.collectionImageDialog.close();
    showInspectorMessage(`已添加瓦片 ${tile.id}`);
  } catch (error) {
    elements.collectionImageState.textContent = error.message;
    elements.collectionImageState.dataset.status = "error";
  } finally {
    state.collectionImagesLoading = false;
    renderAll();
  }
}

async function loadProjectImage(projectRelativePath) {
  const absolutePath = `${state.credentials.projectPath.replace(/\/+$/u, "")}/${normalizeProjectRelativePath(projectRelativePath)}`;
  const url = new URL("/api/files/image", location.origin);
  url.searchParams.set("path", absolutePath);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `无法读取图片 ${projectRelativePath}`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error(`无法解码图片 ${projectRelativePath}`)), { once: true });
      image.decoding = "async";
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  state.imageRecords.set(projectRelativePath, {
    image,
    status: "ready",
    promise: Promise.resolve(image),
  });
  return image;
}

function removeSelectedCollectionImage() {
  if (state.editor?.kind !== "collection" || state.selectedTileId == null || !state.session?.writable) return;
  try {
    const removedId = state.selectedTileId;
    if (state.editor.removeCollectionTiles([removedId])) {
      state.selectedTileId = null;
      showInspectorMessage(`已移除瓦片 ${removedId}，保存前可以撤销`);
    }
  } catch (error) {
    showInspectorError(error);
  }
}

async function saveTileset() {
  if (!state.editor || !state.session?.writable || state.saving) return false;
  if (!state.editor.dirty) return true;
  state.saving = true;
  const savedStateId = state.editor.headStateId;
  let save = null;
  let committed = false;
  renderAll();
  try {
    const source = serializeTiledDocument(state.editor.exportDocument(), {
      expectedKind: "tileset",
      sourcePath: state.session.relativePath,
      space: 2,
      trailingNewline: true,
    });
    const bytes = new TextEncoder().encode(source);
    const totalHash = await sha256Hex(bytes);
    const started = await tilesetMutation("/api/map-tilesets/save-sessions", {
      method: "POST",
      action: "map-tileset-save-start",
      json: {
        tilesetSessionId: state.session.id,
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
      await tilesetMutation(`/api/map-tilesets/save-sessions/${encodeURIComponent(save.id)}/chunks/${index}`, {
        method: "PUT",
        action: "map-tileset-save-chunk",
        body: chunk,
        contentType: "application/octet-stream",
        headers: { "X-Content-SHA256": await sha256Hex(chunk) },
      });
    }
    setDocumentProgress("等待原子提交");
    const completed = await tilesetMutation(`/api/map-tilesets/save-sessions/${encodeURIComponent(save.id)}/commit`, {
      method: "POST",
      action: "map-tileset-save-commit",
    });
    committed = true;
    state.session = { ...state.session, ...(completed.session || {}), version: completed.result.version };
    state.editor.markSaved(savedStateId);
    showInspectorMessage("瓦片集已保存");
    return true;
  } catch (error) {
    showInspectorError(error);
    elements.tilesetState.dataset.status = "error";
    elements.tilesetState.innerHTML = '<i data-lucide="triangle-alert"></i><span>保存失败</span>';
    return false;
  } finally {
    if (save && !committed) {
      await tilesetMutation(`/api/map-tilesets/save-sessions/${encodeURIComponent(save.id)}`, {
        method: "DELETE",
        action: "map-tileset-save-abort",
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
  void closeTilesetSession();
}

async function closeTilesetSession() {
  if (state.closing) return;
  state.closing = true;
  if (elements.closeDialog.open) elements.closeDialog.close();
  await releaseSession();
  window.close();
}

async function releaseSession({ keepalive = false } = {}) {
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  const requests = [];
  if (state.session && state.credentials) {
    requests.push(fetch(`/api/map-tilesets/sessions/${encodeURIComponent(state.session.id)}`, {
      method: "DELETE",
      keepalive,
      headers: tilesetHeaders("map-tileset-session-close"),
    }).catch(() => {}));
  }
  if (state.projectClient) requests.push(state.projectClient.close({ keepalive }).catch(() => {}));
  await Promise.allSettled(requests);
  state.session = null;
  state.projectClient = null;
  state.projectReady = false;
}

function invalidateTilesetAccountSession() {
  state.closing = true;
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  state.unsubscribe?.();
  state.unsubscribe = null;
  void releaseSession({ keepalive: true });
  state.imageRecords.clear();
  state.editor = null;
  state.parsed = null;
  elements.tilesetCanvas.width = 1;
  elements.tilesetCanvas.height = 1;
  elements.animationPreviewCanvas.width = 1;
  elements.animationPreviewCanvas.height = 1;
  document.body.replaceChildren(accountSessionEndedNotice("瓦片集编辑器"));
  document.title = "账号已切换 · WFL 瓦片集";
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
    void saveTileset();
  } else if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) state.editor.redo(); else state.editor.undo();
  } else if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) {
    if (event.key === "+" || event.key === "=") zoomAt(1.2);
    else if (event.key === "-") zoomAt(1 / 1.2);
    else if (event.key === "0") fitTileset();
  }
}

function toggleMobilePanel(panel) {
  elements.tilesetApp.dataset.mobilePanel = elements.tilesetApp.dataset.mobilePanel === panel ? "" : panel;
}

function setLoading(title, detail) {
  elements.loadState.hidden = false;
  elements.retryButton.hidden = true;
  elements.loadTitle.textContent = title;
  elements.loadDetail.textContent = detail;
}

function showLoadError(error) {
  elements.tilesetApp.dataset.state = "error";
  elements.loadState.hidden = false;
  elements.loadTitle.textContent = "无法打开瓦片集";
  elements.loadDetail.textContent = error.message;
  elements.retryButton.hidden = false;
  elements.tilesetState.dataset.status = "error";
  elements.tilesetState.innerHTML = '<i data-lucide="triangle-alert"></i><span>读取失败</span>';
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
      const timeout = setTimeout(() => reject(new Error("瓦片集会话建立超时")), 20_000);
      window.addEventListener("hashchange", () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }
  const params = new URLSearchParams(location.hash.replace(/^#/u, ""));
  const sessionId = params.get("session") || "";
  const editorInstanceId = params.get("editor") || "";
  const projectPath = params.get("project") || "";
  const projectFile = params.get("projectFile") || null;
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(sessionId)) throw new Error("瓦片集会话标识无效");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(editorInstanceId)) throw new Error("瓦片集窗口标识无效");
  if (!projectPath.startsWith("/") || projectPath.includes("\0")) throw new Error("瓦片集工程路径无效");
  if (projectFile) normalizeProjectRelativePath(projectFile, ".tiled-project");
  return Object.freeze({
    sessionId,
    editorInstanceId,
    projectPath,
    projectFile,
    accountId: params.get("account") || null,
  });
}

async function tilesetFetch(input, options = {}) {
  const response = await fetch(input, {
    cache: "no-store",
    ...options,
    headers: { ...tilesetHeaders(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "瓦片集请求失败");
  return data;
}

async function tilesetMutation(pathname, { method, action, json, body, contentType, headers = {} }) {
  const response = await fetch(pathname, {
    method,
    cache: "no-store",
    headers: {
      ...tilesetHeaders(action),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "瓦片集修改请求失败");
  return data;
}

function tilesetHeaders(action = null) {
  return {
    "X-Codex-Desktop-Editor-Instance": state.credentials?.editorInstanceId || "",
    ...(action ? { "X-Codex-Desktop-Action": action } : {}),
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeInputColor(value, fallback) {
  const color = String(value || "").toLowerCase();
  if (/^#[a-f0-9]{6}$/u.test(color)) return color;
  if (/^#[a-f0-9]{8}$/u.test(color)) return `#${color.slice(-6)}`;
  return fallback;
}

function normalizeProjectRelativePath(value, expectedExtension = null) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("/") || text.includes("\\") || /^[a-z][a-z0-9+.-]*:/iu.test(text)) {
    throw new Error("路径必须是工程相对路径");
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("工程相对路径无效");
  }
  const normalized = segments.join("/");
  if (expectedExtension && !normalized.toLowerCase().endsWith(expectedExtension)) {
    throw new Error(`路径必须使用 ${expectedExtension}`);
  }
  return normalized;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function cloneJsonValue(value) {
  return structuredClone(value);
}

function refreshIcons() {
  globalThis.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}
