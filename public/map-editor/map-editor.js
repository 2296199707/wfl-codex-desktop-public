import {
  parseTiledDocument,
  relativeTiledProjectReference,
  resolveTiledProjectReference,
  serializeTiledDocument,
} from "./tiled-document.js?v=0.44.55";
import { TiledEditDocument } from "./tiled-edit-document.js?v=0.44.55";
import {
  applyTiledAiPatch,
  buildTiledAiPrompt,
  parseTiledAiPatch,
  previewTiledAiPatch,
  tiledAiPatchContext,
} from "./tiled-ai-patch.js?v=0.44.55";
import { TiledAiPatchWorkerClient } from "./tiled-ai-patch-worker-client.js?v=0.44.55";
import {
  decodeTiledTileData,
  encodeTiledTileData,
} from "./tiled-tile-codec.js?v=0.44.55";
import { planTiledTilesetImport } from "./tiled-tileset-import.js?v=0.44.55";
import { planTiledTilesetReuse, remapGlobalTileId } from "./tiled-gid-reuse.js?v=0.44.55";
import {
  emptyTiledProjectTypes,
  mergeTiledClassDefaults,
  normalizeTiledPropertyValue,
  parseTiledProjectTypes,
  tiledPropertyControl,
} from "./tiled-project-types.js?v=0.44.55";
import {
  compactTiledTemplateInstance,
  createTiledTemplateDocument,
  createTiledTileObjectTemplateDocument,
  materializeTiledTemplate,
  parseTiledTemplate,
  refreshTiledTemplateInstance,
} from "./tiled-template.js?v=0.44.55";
import {
  createMapAssetLibrary,
  mapAssetDependencySummary,
  parseMapAssetLibrary,
  searchMapAssets,
  serializeMapAssetLibrary,
  setMapAssetFavorite,
  touchMapAsset,
  upsertMapAsset,
} from "./map-asset-library.js?v=0.44.55";
import {
  compositeDependencies,
  createCompositeMapDocument,
  relocateCompositeMapDocument,
  remapCompositeLayerGids,
} from "./tiled-composite.js?v=0.44.55";
import {
  buildMapImageCandidateRequest,
  buildMapImageCropRequest,
  buildMapImageEditRequest,
  buildMapImageOutpaintRequest,
  buildMapImagePublicationRequest,
  mapImageAssetPreset,
  mapImageJobIsActive,
  mapImageOperationAvailability,
  normalizeMapImageCandidateConfig,
  suggestedMapImageCompanionPath,
  suggestedMapImagePublishPath,
} from "./map-image-candidates.js?v=0.44.55";
import {
  planPublishedMapImageLayer,
  planPublishedMapImageLayerReplacement,
  planPublishedMapTileObject,
  planPublishedMapTilesetDraft,
  publishedMapImageApplicationId,
  tiledValueHasMapImageApplication,
  validatePublishedMapImageGrant,
} from "./map-image-apply.js?v=0.44.55";
import { createMapSelectionImageTarget } from "./map-selection-image-target.js?v=0.44.55";
import {
  TILED_COLLISION_SHAPES,
  TILED_OBJECT_SHAPES,
  createTiledMapObject,
  insertTiledObjectVertex,
  planTiledObjectArrangement,
  planTiledObjectResize,
  planTiledObjectRotation,
  removeTiledObjectVertex,
  suggestedTiledObjectVertex,
  tiledObjectShapeLabel,
  updateTiledObjectVertex,
} from "./map-object-model.js?v=0.44.55";
import {
  normalizeTileRandomSeed,
  paletteTileStamp,
  singleTileStamp,
  tileShapeCells,
  tileStampWrites,
  transformTileStamp,
} from "./tile-tool-model.js?v=0.44.55";
import { planTerrainBrush } from "./terrain-brush-model.js?v=0.44.55";
import {
  applyTiledAutomappingPreview,
  compileTiledAutomappingRuleMap,
  loadTiledAutomappingRules,
} from "./tiled-automap.js?v=0.44.55";
import { TiledAutomapWorkerClient } from "./tiled-automap-worker-client.js?v=0.44.55";
import { TiledFillWorkerClient } from "./tiled-fill-worker-client.js?v=0.44.55";
import {
  createTileStampLibrary,
  parseTileStampLibrary,
  removeNamedTileStamp,
  setNamedTileStampFavorite,
  sortedNamedTileStamps,
  tileStampLibraryStorageKey,
  touchNamedTileStamp,
  upsertNamedTileStamp,
} from "./tile-stamp-library.js?v=0.44.55";
import {
  combineTileSelections,
  contiguousTileSelection,
  matchingTileSelection,
  rectangularTileSelection,
  tileSelectionBounds,
} from "./tile-selection-model.js?v=0.44.55";
import {
  createMapAiProposalClient,
  createMapAiProposalPatchAdapter,
  mapAiProposalCompatibility,
} from "./map-ai-proposals.js?v=0.44.55";
import { revokeMapAiLeaseWithRetry } from "./map-ai-lease-revoke.js?v=0.44.55";
import { TiledPixiViewer } from "./pixi-viewer.js?v=0.44.55";
import { MapGamepadController } from "./map-gamepad-controller.js?v=0.44.55";
import { decodeGlobalTileId } from "./tiled-render-model.js?v=0.44.55";
import { tiledTilesetLayout } from "./tiled-tileset-model.js?v=0.44.55";
import {
  GAME_WORK_MODE_ACK_TYPE,
  GAME_WORK_MODE_HEARTBEAT_MS,
  createGameWorkModeSignal,
  gameWorkModeChannelName,
  parseGameWorkModeCommand,
} from "../game-work-mode.js?v=0.44.55";
import { createMapAccountSessionGuard } from "./map-account-session-guard.js?v=0.44.55";
import {
  createMapEditorTabSignal,
  parseMapEditorTabSignal,
} from "./map-tab-channel.js?v=0.44.55";
import { MapProjectWorkspaceClient } from "../map-project-session.js?v=0.44.55";
import {
  createMapConversationRequest,
  parseMapConversationResult,
  parseMapConversationSnapshot,
} from "./map-conversation-channel.js?v=0.44.55";
import {
  createMapEditorViewState,
  mapEditorViewStorageKey,
  parseMapEditorViewState,
} from "./map-editor-view-state.js?v=0.44.55";
import { MapGuideController } from "./map-guide-controller.js?v=0.44.55";
import {
  MapImageBoundaryController,
  planMapImageProviderCanvas,
} from "./map-image-boundary.js?v=0.44.55";

const SESSION_STORAGE_KEY = "wfl-map-editor-session-v1";
const MAP_AI_LEASE_STORAGE_KEY = "wfl-map-editor-ai-lease-v1";
const MAP_AI_PROPOSAL_POLL_MS = 1_500;
const MAP_AI_MANAGED_TASK_POLL_MS = 1_500;
const ACTIVE_RENDER_STATUSES = new Set(["queued", "running", "canceling"]);
const RENDER_FILE_DISPLAY_LIMIT = 100;
const TILE_PALETTE_PAGE_SIZE = 200;
const TILE_SHAPE_TOOLS = new Set(["tile-line", "tile-rectangle", "tile-ellipse"]);
const MAP_EDITOR_VIEW_SAVE_DELAY_MS = 250;
const elements = Object.fromEntries([
  "mapApp",
  "mapTitle",
  "mapMeta",
  "helpButton",
  "statusHelpButton",
  "helpDialog",
  "closeHelpButton",
  "confirmHelpButton",
  "mapDocumentTabList",
  "mapFileButton",
  "mapFileDialog",
  "mapFileTitle",
  "closeMapFileDialogButton",
  "cancelMapFileButton",
  "mapFileSearch",
  "mapFileState",
  "mapFileList",
  "loadMoreMapFilesButton",
  "mapDocumentTabAddButton",
  "mapCanvasHost",
  "mapGuideSurface",
  "mapRulerTop",
  "mapRulerLeft",
  "mapGuideLayer",
  "guidePanelButton",
  "mapGuidePanel",
  "closeGuidePanelButton",
  "guidesVisible",
  "guideDefaultUnit",
  "addVerticalGuideButton",
  "addHorizontalGuideButton",
  "mapGuideList",
  "mapGuideEmptyState",
  "mapLoadState",
  "loadTitle",
  "loadDetail",
  "retryButton",
  "mapState",
  "coordinates",
  "tileCoordinates",
  "selectionState",
  "gamepadState",
  "warningState",
  "documentState",
  "gameWorkModeControl",
  "gameWorkModeToggle",
  "gameWorkModeState",
  "collaborationButton",
  "collaborationPanel",
  "closeCollaborationButton",
  "collaborationScrim",
  "collaborationConnectionState",
  "conversationTabButton",
  "proposalTabButton",
  "taskTrayTabButton",
  "proposalTabCount",
  "taskTrayCount",
  "conversationPanel",
  "proposalPanel",
  "taskTrayPanel",
  "taskTrayState",
  "conversationThreadSelect",
  "refreshConversationButton",
  "focusMainConversationButton",
  "conversationMessageList",
  "conversationImageDelivery",
  "conversationComposer",
  "conversationInput",
  "conversationSendState",
  "interruptConversationButton",
  "sendConversationButton",
  "openProposalInboxButton",
  "proposalTrayList",
  "refreshTaskTrayButton",
  "taskTrayList",
  "openImageTasksButton",
  "openRenderTasksButton",
  "managedTaskDialog",
  "closeManagedTaskDialogButton",
  "managedTaskSummaryTitle",
  "managedTaskStatusBadge",
  "managedTaskStage",
  "managedTaskOperation",
  "managedTaskWorker",
  "managedTaskValidation",
  "managedTaskBaseVersion",
  "managedTaskCurrentVersion",
  "managedTaskDetailState",
  "managedTaskRiskReceipt",
  "managedTaskDiffReceipt",
  "managedTaskEventReceipt",
  "managedTaskPauseButton",
  "managedTaskResumeButton",
  "managedTaskTakeoverButton",
  "managedTaskCancelButton",
  "managedTaskApproveButton",
  "managedAuthorizationConfirmDialog",
  "managedAuthorizationConfirmDetail",
  "managedAuthorizationConfirmState",
  "cancelManagedAuthorizationConfirmButton",
  "confirmManagedAuthorizationRevokeButton",
  "managedAuthorizationTransferDialog",
  "managedAuthorizationTransferTarget",
  "managedAuthorizationTransferDetail",
  "managedAuthorizationTransferState",
  "cancelManagedAuthorizationTransferButton",
  "confirmManagedAuthorizationTransferButton",
  "managedAuthorizationAuditDialog",
  "closeManagedAuthorizationAuditButton",
  "managedAuthorizationAuditTitle",
  "managedAuthorizationAuditSummary",
  "managedAuthorizationAuditList",
  "layerPanel",
  "layerList",
  "layerCount",
  "layersButton",
  "layersCloseButton",
  "layerScrim",
  "addTileLayerButton",
  "addObjectLayerButton",
  "addGroupLayerButton",
  "addImageLayerButton",
  "addTilesetButton",
  "saveCompositeButton",
  "duplicateLayerButton",
  "moveLayerUpButton",
  "moveLayerDownButton",
  "imageArrangeButton",
  "imageArrangePanel",
  "closeImageArrangeButton",
  "imageSnapEnabled",
  "imageSnapUnit",
  "imageSnapStep",
  "deleteLayerButton",
  "imageLayerDialog",
  "imageLayerTitle",
  "imageLayerDescription",
  "closeImageLayerDialogButton",
  "imageAssetParentButton",
  "imageAssetDirectory",
  "refreshImageAssetsButton",
  "imageAssetList",
  "loadMoreImageAssetsButton",
  "imageAssetState",
  "cancelImageLayerButton",
  "importImageLayerButton",
  "tilesetAssetDialog",
  "closeTilesetAssetDialogButton",
  "tilesetAssetParentButton",
  "tilesetAssetDirectory",
  "refreshTilesetAssetsButton",
  "tilesetAssetList",
  "loadMoreTilesetAssetsButton",
  "tilesetAssetState",
  "cancelTilesetImportButton",
  "importTilesetButton",
  "zoomOutButton",
  "zoomInButton",
  "zoomLabel",
  "fitButton",
  "gridButton",
  "reloadButton",
  "closeButton",
  "undoButton",
  "redoButton",
  "saveButton",
  "revisionsButton",
  "aiEditButton",
  "autoMapButton",
  "mapImageButton",
  "assetLibraryButton",
  "mapImageDialog",
  "closeMapImageDialogButton",
  "mapImageForm",
  "mapImageOperation",
  "mapImageOperationState",
  "mapImageKind",
  "mapImageKindState",
  "mapImagePrompt",
  "mapImageSize",
  "mapImageQuality",
  "mapImageSourceField",
  "mapImageSourceButton",
  "mapImageLayerSourceButton",
  "mapImageSourceState",
  "mapImageSelectionButton",
  "mapImageSelectionState",
  "mapImageSourceFile",
  "mapImageMaskField",
  "mapImageMaskButton",
  "mapImageMaskClearButton",
  "mapImageMaskState",
  "mapImageMaskFile",
  "mapImageOutpaintFields",
  "mapImageBoundaryCanvas",
  "mapImageBoundaryEmpty",
  "mapImageBoundaryUnit",
  "mapImageBoundaryStep",
  "mapImageBoundaryResetButton",
  "mapImageBoundarySourceSize",
  "mapImageBoundaryCroppedSize",
  "mapImageBoundaryTargetSize",
  "mapImageBoundaryProviderSize",
  "mapImageBoundaryState",
  "mapImageExpandTop",
  "mapImageExpandRight",
  "mapImageExpandBottom",
  "mapImageExpandLeft",
  "mapImagePreserveSource",
  "mapImageBlendMargin",
  "mapImageAlignmentPolicy",
  "mapImageCapabilities",
  "mapImageState",
  "refreshMapImageButton",
  "mapImageSubmitButton",
  "mapImageJobList",
  "gamePreviewButton",
  "exportButton",
  "selectToolButton",
  "handToolButton",
  "brushToolButton",
  "terrainBrushToolButton",
  "eraserToolButton",
  "fillToolButton",
  "sampleToolButton",
  "tileShapeToolButton",
  "tileShapeMenu",
  "tileShapeFilled",
  "objectToolButton",
  "collisionToolButton",
  "vertexToolButton",
  "tilePalette",
  "tilePaletteTitle",
  "selectedTileState",
  "tileStampSelectButton",
  "tileStampToolbar",
  "tileRandomButton",
  "tileRandomSeedControl",
  "tileRandomSeed",
  "tileRandomizeSeedButton",
  "tileStampLibraryButton",
  "tileStampLibraryDialog",
  "closeTileStampLibraryButton",
  "tileStampLibraryForm",
  "tileStampName",
  "saveNamedTileStampButton",
  "copyTileStampButton",
  "pasteTileStampButton",
  "tileStampLibraryState",
  "tileStampLibraryList",
  "tileSelectionToolbar",
  "tileRectSelectButton",
  "tileMagicToolButton",
  "tileSameToolButton",
  "clearTileSelectionButton",
  "tilePaletteGrid",
  "tilePalettePreviousButton",
  "tilePalettePageState",
  "tilePaletteNextButton",
  "terrainBrushControls",
  "terrainSetSelect",
  "terrainColorSelect",
  "terrainBrushSeed",
  "terrainRandomizeSeedButton",
  "terrainBrushState",
  "tilesDetailButton",
  "propertiesDetailButton",
  "propertyInspector",
  "inspectorTitle",
  "inspectorMeta",
  "objectActions",
  "duplicateObjectButton",
  "saveTemplateButton",
  "refreshTemplateButton",
  "unbindTemplateButton",
  "objectArrangeButton",
  "objectArrangePanel",
  "deleteObjectButton",
  "objectCreateControls",
  "objectPreset",
  "objectShape",
  "templateAssetButton",
  "inspectorForm",
  "inspectorName",
  "inspectorClass",
  "inspectorTypeField",
  "inspectorType",
  "inspectorXField",
  "inspectorXLabel",
  "inspectorX",
  "inspectorYField",
  "inspectorYLabel",
  "inspectorY",
  "inspectorWidthField",
  "inspectorWidth",
  "inspectorHeightField",
  "inspectorHeight",
  "inspectorRotationField",
  "inspectorRotation",
  "inspectorOpacityField",
  "inspectorOpacityLabel",
  "inspectorOpacity",
  "inspectorGidField",
  "inspectorGid",
  "inspectorDrawOrderField",
  "inspectorDrawOrder",
  "objectTextFields",
  "objectTextValue",
  "objectTextFontFamily",
  "objectTextPixelSize",
  "objectTextColor",
  "objectTextHalign",
  "objectTextValign",
  "objectTextWrap",
  "objectTextBold",
  "objectTextItalic",
  "objectTextUnderline",
  "objectTextStrikeout",
  "objectTextKerning",
  "objectVertexFields",
  "objectVertexTitle",
  "addObjectVertexButton",
  "objectVertexList",
  "inspectorVisible",
  "inspectorRepeatXField",
  "inspectorRepeatX",
  "inspectorRepeatYField",
  "inspectorRepeatY",
  "customProperties",
  "addPropertyButton",
  "propertyRows",
  "templateAssetDialog",
  "closeTemplateAssetDialogButton",
  "templateAssetParentButton",
  "templateAssetDirectory",
  "refreshTemplateAssetsButton",
  "templateAssetList",
  "loadMoreTemplateAssetsButton",
  "templateAssetState",
  "cancelTemplateImportButton",
  "importTemplateButton",
  "assetLibraryDialog",
  "closeAssetLibraryButton",
  "assetLibrarySearch",
  "assetLibraryKind",
  "assetLibraryFavoritesOnly",
  "assetLibraryList",
  "assetLibraryState",
  "crossProjectImportButton",
  "crossProjectImportDialog",
  "closeCrossProjectImportButton",
  "cancelCrossProjectImportButton",
  "crossProjectImportProject",
  "crossProjectImportSourcePath",
  "crossProjectImportTargetPath",
  "crossProjectImportState",
  "crossProjectImportPlan",
  "planCrossProjectImportButton",
  "confirmCrossProjectImportButton",
  "saveConflictDialog",
  "saveConflictDetail",
  "keepConflictEditsButton",
  "reloadConflictButton",
  "mapCloseDialog",
  "mapCloseDetail",
  "mapCloseState",
  "cancelMapCloseButton",
  "discardMapCloseButton",
  "saveMapCloseButton",
  "revisionDialog",
  "closeRevisionDialogButton",
  "revisionState",
  "revisionList",
  "revisionRestorePanel",
  "revisionRestoreTitle",
  "revisionRestoreDetail",
  "revisionRestoreConfirm",
  "cancelRevisionRestoreButton",
  "confirmRevisionRestoreButton",
  "aiPatchDialog",
  "closeAiPatchDialogButton",
  "aiEditRequest",
  "copyAiPromptButton",
  "aiPatchSource",
  "aiPatchState",
  "aiPatchPreview",
  "aiPatchPreviewSummary",
  "aiPatchPreviewCount",
  "aiPatchPreviewList",
  "cancelAiPatchButton",
  "previewAiPatchButton",
  "applyAiPatchButton",
  "autoMapDialog",
  "closeAutoMapDialogButton",
  "autoMapRulesPath",
  "autoMapRulesOrigin",
  "autoMapSeed",
  "randomizeAutoMapSeedButton",
  "autoMapWhileDrawing",
  "autoMapState",
  "autoMapPreview",
  "autoMapPreviewSummary",
  "autoMapPreviewCount",
  "autoMapPreviewStats",
  "autoMapRuleList",
  "cancelAutoMapButton",
  "previewAutoMapButton",
  "applyAutoMapButton",
  "mapAiConnectionState",
  "mapAiThreadState",
  "connectMapAiButton",
  "disconnectMapAiButton",
  "refreshMapAiProposalsButton",
  "mapAiProposalList",
  "mapAiProposalState",
  "refreshMapAiManagedAuthorizationsButton",
  "mapAiManagedThread",
  "mapAiManagedProject",
  "mapAiManagedMapVersion",
  "mapAiManagedMode",
  "mapAiManagedApprovalPolicy",
  "mapAiManagedTtl",
  "mapAiManagedAllowRead",
  "mapAiManagedAllowPropose",
  "mapAiManagedAllowApply",
  "mapAiManagedMaxBatches",
  "mapAiManagedMaxOperations",
  "mapAiManagedProtectedTargets",
  "mapAiHumanOwnedTargets",
  "mapAiAiOwnedTargets",
  "mapAiSharedTargets",
  "mapAiLockedTargets",
  "mapAiCollaborationPolicyRevision",
  "saveMapAiCollaborationPolicyButton",
  "mapAiCollaborationPolicyState",
  "mapAiManagedConfirm",
  "createMapAiManagedAuthorizationButton",
  "mapAiManagedAuthorizationState",
  "mapAiManagedAuthorizationList",
  "gamePreviewDialog",
  "gamePreviewEntry",
  "gamePreviewState",
  "cancelGamePreviewButton",
  "openGamePreviewButton",
  "exportDialog",
  "closeExportDialogButton",
  "exportCreateTab",
  "exportJobsTab",
  "exportCreatePanel",
  "exportJobsPanel",
  "exportForm",
  "exportKind",
  "exportOutputRoot",
  "screenshotWidth",
  "screenshotHeight",
  "screenshotFormat",
  "screenshotMode",
  "screenshotScale",
  "screenshotTime",
  "screenshotOffsetX",
  "screenshotOffsetY",
  "exportGameEntry",
  "gameScreenshotWidth",
  "gameScreenshotHeight",
  "gameScreenshotFullPage",
  "panoramaScale",
  "panoramaFormat",
  "panoramaTime",
  "tileExportWidth",
  "tileExportHeight",
  "tileExportScale",
  "tileExportFormat",
  "tileExportTime",
  "animationWidth",
  "animationHeight",
  "animationFps",
  "animationDuration",
  "animationFormat",
  "videoWidth",
  "videoHeight",
  "videoFps",
  "videoDuration",
  "videoCodec",
  "videoCrf",
  "exportCreateState",
  "cancelExportButton",
  "startExportButton",
  "exportJobList",
  "exportJobDetail",
  "exportJobState",
  "exportFileList",
  "cancelRenderJobButton",
  "downloadRenderArchive",
].map((id) => [id, document.getElementById(id)]));

const state = {
  credentials: null,
  session: null,
  projectTypes: emptyTiledProjectTypes(),
  projectSource: null,
  document: null,
  editor: null,
  viewer: null,
  warnings: new Set(),
  gridVisible: true,
  bootstrapping: false,
  activeLayerId: null,
  selectedLayerIds: new Set(),
  layerSelectionAnchorId: null,
  layerDragIds: [],
  activeTool: "select",
  selection: null,
  selectionStart: null,
  tileSelectionBase: null,
  tileSelectionGestureMode: null,
  tileSelectionMode: "replace",
  selectedGid: null,
  tileStamp: null,
  tileStampAnchor: null,
  tileStampSelecting: false,
  tilePaletteEntries: [],
  tilePalettePage: 0,
  tileStroke: null,
  tileStrokePlan: null,
  tileStrokeAutoMapGesture: null,
  lastStrokeCell: null,
  tileShapeTool: "tile-line",
  tileShapeEdit: null,
  tileRandomEnabled: false,
  tileRandomSeed: 1,
  terrainEntries: [],
  selectedTerrainKey: null,
  selectedTerrainColor: 1,
  terrainBrushSeed: 1,
  terrainStroke: null,
  terrainStrokePlan: null,
  terrainStrokeAutoMapGesture: null,
  lastTerrainCell: null,
  terrainStrokeApproximate: 0,
  terrainBrushMessage: "",
  tileStampLibrary: createTileStampLibrary(),
  objectStart: null,
  pendingLayerRefreshes: new Set(),
  layerRefreshFrame: null,
  layerRefreshRunning: false,
  layerTreeRebuildFrame: null,
  layerTreeRebuildRunning: false,
  layerTreeRebuildPending: false,
  layerTreeReloadTilesets: false,
  preferredActiveLayerId: null,
  detailTab: "tiles",
  selectedObjectId: null,
  selectedObjectIds: new Set(),
  objectDrag: null,
  objectTransform: null,
  objectMarqueeAdditive: false,
  selectedVertexIndex: null,
  vertexDrag: null,
  imageLayerDrag: null,
  imageSnapEnabled: false,
  imageSnapUnit: "pixel",
  imageSnapStep: 1,
  guideController: null,
  objectPreset: "object",
  objectShape: "rectangle",
  objectClipboard: null,
  saving: false,
  saveProgress: "",
  activeSaveId: null,
  allowDirtyUnload: false,
  previewEntries: [],
  previewEntriesLoaded: false,
  previewLoading: false,
  renderConfig: null,
  renderJobs: [],
  managedTasks: [],
  managedTaskEvents: new Map(),
  managedTaskEventCursors: new Map(),
  managedTaskEventSyncGenerations: new Map(),
  managedMapExternalVersion: null,
  managedMapAutoRefreshVersion: null,
  managedTaskLoading: false,
  managedTaskPollTimer: null,
  renderLoading: false,
  renderMessage: "",
  activeRenderJobId: null,
  renderPollTimer: null,
  autoSaveTimer: null,
  aiPatchPreview: null,
  aiApplying: false,
  aiPatchWorkerClient: null,
  aiProposalPatchWorkerClient: null,
  aiPatchAbortController: null,
  aiPatchLoading: false,
  autoMapRules: null,
  autoMapPreview: null,
  autoMapLoading: false,
  autoMapApplying: false,
  autoMapAbortController: null,
  autoMapWorkerClient: null,
  autoMapGestureWorkerClient: null,
  autoMapGestureAbortController: null,
  autoMapGesturePending: null,
  autoMapGestureMessage: "",
  fillWorkerClient: null,
  fillAbortController: null,
  fillPending: null,
  fillMessage: "",
  fillStatusTimer: null,
  gamepadController: null,
  gamepadStatusTimer: null,
  autoMapWhileDrawing: false,
  autoMapWhileDrawingRules: null,
  autoMapWhileDrawingLoading: null,
  autoMapWhileDrawingMessage: "",
  mapAiLease: null,
  mapAiProposalClient: null,
  mapAiProposalAdapter: null,
  mapAiProposals: [],
  mapAiProposalPrepared: new Map(),
  mapAiConnectionLoading: false,
  mapAiProposalLoading: false,
  mapAiAppliedPendingAck: new Map(),
  mapAiLeaseInvalidationPending: false,
  mapAiToolsEnabled: false,
  mapAiToolsLoaded: false,
  mapAiConnectionMessage: "",
  mapAiConnectionMessageStatus: "ready",
  mapAiAutoConnectRequested: false,
  mapAiProposalPollTimer: null,
  mapAiUnseenProposalCount: 0,
  mapAiManagedAuthorizations: [],
  mapAiManagedAuthorizationLoading: false,
  mapAiManagedAuthorizationCreating: false,
  mapAiCollaborationPolicy: null,
  pendingManagedAuthorizationRevoke: null,
  pendingManagedAuthorizationTransfer: null,
  gameWorkModeEnabled: false,
  gameWorkModeChannel: null,
  gameWorkModeHeartbeatTimer: null,
  gameWorkModeAckTimer: null,
  gameWorkModeHostConnected: false,
  gameWorkModeHostActive: false,
  accountSessionGuard: null,
  collaborationOpen: matchMedia("(min-width: 1201px)").matches,
  collaborationTab: "conversation",
  conversationSnapshot: null,
  conversationSnapshotRequestedAt: 0,
  conversationPendingRequests: new Map(),
  conversationRequestTimer: null,
  conversationLastRevision: -1,
  mapEditorTabs: [],
  mapEditorTabSignalFingerprint: "",
  mapEditorTabClosedSent: false,
  projectWorkspaceClient: null,
  mapFileEntries: [],
  mapFileNextCursor: null,
  mapFileQuery: ".tmj",
  mapFileLoading: false,
  mapFileSearchTimer: null,
  mapCloseSaving: false,
  mapEditorViewState: null,
  mapEditorViewSaveTimer: null,
  mapEditorViewRestoring: false,
  mapSessionCloseStarted: false,
  revisions: [],
  selectedRevision: null,
  revisionsLoading: false,
  revisionRestoring: false,
  keepMapSessionOnPagehide: false,
  imageAssetDirectory: "",
  imageAssetCursor: null,
  imageAssetEntries: [],
  selectedImageAsset: null,
  selectedImageAssets: new Set(),
  imageAssetSelectionEntries: new Map(),
  imageAssetLoading: false,
  tilesetAssetDirectory: "",
  tilesetAssetCursor: null,
  tilesetAssetEntries: [],
  selectedTilesetAsset: null,
  tilesetAssetLoading: false,
  templateAssetDirectory: "",
  templateAssetCursor: null,
  templateAssetEntries: [],
  selectedTemplateAsset: null,
  templateAssetLoading: false,
  templateBindingVersions: new Map(),
  templateSources: new Map(),
  templateVersionWarnings: new Set(),
  templateVersionPollTimer: null,
  assetLibrary: createMapAssetLibrary(),
  assetLibraryLoading: false,
  assetLibrarySearchTimer: null,
  crossProjectImportProjects: [],
  crossProjectImportSourceSessionId: null,
  crossProjectImportPlan: null,
  crossProjectImportLoading: false,
  mapImageConfig: null,
  mapImageJobs: [],
  mapImageLoading: false,
  mapImageStarting: false,
  mapImagePublishing: new Set(),
  mapImageDiscarding: new Set(),
  mapImageApplying: new Set(),
  mapImageApplyQueue: Promise.resolve(),
  mapImageSelectionTargets: new Map(),
  mapImagePollTimer: null,
  mapImagePreviewUrls: new Map(),
  mapImagePreviewLoading: new Set(),
  mapImageComparisons: new Map(),
  mapImagePublishDrafts: new Map(),
  mapImageSourcePaths: [],
  mapImageMaskPath: "",
  mapImageUseSelection: false,
  mapImageSourceFile: null,
  mapImageMaskFile: null,
  mapImageAssetRole: null,
  mapImageSourceLayerId: null,
  mapImageSourceResolving: false,
  mapImageBoundaryController: null,
  mapImageBoundaryPlan: null,
  mapImageSourcePreviewUrl: "",
  mapImageSourcePreviewToken: 0,
};

bindControls();
initializeVisualViewportLayout();
refreshIcons();
window.addEventListener("hashchange", () => {
  if (!state.credentials) void bootstrap();
});
void bootstrap();

function initializeVisualViewportLayout() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let frame = null;
  const render = () => {
    frame = null;
    root.style.setProperty("--map-visual-viewport-width", `${Math.max(1, Math.round(viewport.width))}px`);
    root.style.setProperty("--map-visual-viewport-height", `${Math.max(1, Math.round(viewport.height))}px`);
    root.style.setProperty("--map-visual-viewport-left", `${Math.max(0, Math.round(viewport.offsetLeft))}px`);
    root.style.setProperty("--map-visual-viewport-top", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    const focusedInput = isTextEditingTarget(document.activeElement);
    const keyboardInset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    root.dataset.softKeyboard = String(Boolean(focusedInput && keyboardInset >= 80));
  };
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(render);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  render();
}

async function bootstrap() {
  if (state.bootstrapping) return;
  state.bootstrapping = true;
  try {
    state.credentials = mapSessionCredentials();
    if (!state.credentials) {
      if (location.hash === "#pending") {
        elements.loadTitle.textContent = "正在建立地图会话";
        elements.loadDetail.textContent = "";
        return;
      }
      throw new Error("地图会话信息缺失，请从工程文件管理器重新打开");
    }
    if (!state.credentials.accountId) {
      throw new Error("地图账号绑定缺失，请从当前账号的地图项目重新打开");
    }
    state.accountSessionGuard = createMapAccountSessionGuard({
      accountId: state.credentials.accountId,
      onInvalidated: invalidateMapEditorAccountSession,
    });
    const accountStatus = await state.accountSessionGuard.check();
    if (accountStatus === "invalidated") return;
    state.accountSessionGuard.start();
    window.opener = null;
    setLoading("正在读取地图", "0%");
    state.session = await fetchMapSession();
    if (state.credentials.projectPath) {
      await ensureMapProjectWorkspace().catch((error) => {
        addWarning(`项目资源工作区未连接：${error.message}`);
      });
    }
    await loadTiledProjectTypes();
    state.assetLibrary = loadStoredMapAssetLibrary();
    state.mapEditorViewState = loadMapEditorViewState();
    state.tileStampLibrary = loadTileStampLibrary();
    if (state.mapEditorViewState) {
      state.gridVisible = state.mapEditorViewState.gridVisible;
      state.imageSnapEnabled = state.mapEditorViewState.imageSnapEnabled;
      state.imageSnapUnit = state.mapEditorViewState.imageSnapUnit;
      state.imageSnapStep = state.mapEditorViewState.imageSnapStep;
      state.tileRandomEnabled = state.mapEditorViewState.tileRandomEnabled;
      state.tileRandomSeed = state.mapEditorViewState.tileRandomSeed;
      state.tileSelectionMode = state.mapEditorViewState.tileSelectionMode;
      state.autoMapWhileDrawing = state.mapEditorViewState.autoMapWhileDrawing;
    }
    elements.autoMapSeed.value = String(state.mapEditorViewState?.autoMapSeed ?? 1);
    elements.autoMapWhileDrawing.checked = state.autoMapWhileDrawing;
    elements.mapTitle.textContent = state.session.relativePath.split("/").at(-1) || "地图";
    elements.mapMeta.textContent = state.session.relativePath;
    elements.documentState.textContent = state.session.writable ? "可编辑 · 查看模式" : "只读";
    const source = await readMapContent();
    setLoading("正在解析地图", formatBytes(state.session.size));
    const parsed = parseTiledDocument(source, {
      expectedKind: "map",
      sourcePath: state.session.relativePath,
    });
    setLoading("正在解码瓦片", formatBytes(state.session.size));
    await decodeTiledTileData(parsed.document);
    await hydrateTiledTemplateInstances(parsed.document);
    state.editor = new TiledEditDocument(parsed.document);
    state.editor.subscribe(renderDocumentState);
    state.document = state.editor.document;
    initializeMapImageBoundaryController();
    for (const warning of parsed.diagnostics) addWarning(warning.message);
    setLoading("正在渲染地图", `${state.document.width} × ${state.document.height}`);
    state.mapEditorViewRestoring = Boolean(state.mapEditorViewState);
    state.viewer = await new TiledPixiViewer({
      host: elements.mapCanvasHost,
      document: state.document,
      sourcePath: state.session.relativePath,
      loadResourceText,
      loadResourceBlob,
      onCoordinate: renderCoordinates,
      onTransform: ({ zoom }) => {
        elements.zoomLabel.value = `${Math.round(zoom * 100)}%`;
        elements.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        state.guideController?.updateTransform();
        scheduleMapEditorViewStateSave();
      },
      onWarning: addWarning,
      autoFit: !state.mapEditorViewState,
      initialView: state.mapEditorViewState,
    }).initialize();
    state.autoMapWorkerClient = new TiledAutomapWorkerClient();
    state.autoMapGestureWorkerClient = new TiledAutomapWorkerClient();
    state.fillWorkerClient = new TiledFillWorkerClient();
    state.aiPatchWorkerClient = new TiledAiPatchWorkerClient();
    state.aiProposalPatchWorkerClient = new TiledAiPatchWorkerClient();
    initializeMapGamepadController();
    initializeMapGuideController();
    state.mapEditorViewRestoring = false;
    state.viewer.setGridVisible(state.gridVisible);
    elements.gridButton.classList.toggle("is-active", state.gridVisible);
    elements.gridButton.setAttribute("aria-pressed", String(state.gridVisible));
    renderLayerList();
    renderTilePalette();
    const restoredLayer = state.mapEditorViewState?.activeLayerId == null
      ? null
      : state.viewer.layerViews.find(({ layer }) => layer.id === state.mapEditorViewState.activeLayerId);
    setActiveLayer(restoredLayer || defaultActiveLayer());
    setDetailTab(state.mapEditorViewState?.detailTab || state.detailTab, { force: true });
    setActiveTool(state.mapEditorViewState?.activeTool || "select");
    setLayerPanelOpen(state.mapEditorViewState?.layerPanelOpen === true);
    initializeGameWorkMode();
    await initializeMapAiIntegration();
    setReady();
    if (state.autoMapWhileDrawing) {
      void ensureAutoMapWhileDrawingRules().then((rules) => {
        if (rules) state.autoMapWhileDrawingMessage = `AutoMap While Drawing 已恢复 · ${rules.ruleCount} 条规则`;
      }).catch((error) => {
        state.autoMapWhileDrawing = false;
        elements.autoMapWhileDrawing.checked = false;
        addWarning(`AutoMap While Drawing 未恢复：${error.message}`);
        scheduleMapEditorViewStateSave();
      });
    }
    startTemplateVersionMonitor();
    sendMapEditorTabState({ force: true });
  } catch (error) {
    setError(error);
  } finally {
    state.bootstrapping = false;
  }
}

function bindControls() {
  elements.helpButton.addEventListener("click", showEditorHelp);
  elements.statusHelpButton.addEventListener("click", showEditorHelp);
  elements.closeHelpButton.addEventListener("click", () => elements.helpDialog.close());
  elements.confirmHelpButton.addEventListener("click", () => elements.helpDialog.close());
  elements.mapFileButton.addEventListener("click", () => void showMapFileDialog());
  elements.mapDocumentTabAddButton.addEventListener("click", () => void showMapFileDialog());
  elements.closeMapFileDialogButton.addEventListener("click", closeMapFileDialog);
  elements.cancelMapFileButton.addEventListener("click", closeMapFileDialog);
  elements.mapFileDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeMapFileDialog();
  });
  elements.mapFileSearch.addEventListener("input", scheduleMapFileSearch);
  elements.loadMoreMapFilesButton.addEventListener("click", () => void loadMapFileList({ append: true }));
  elements.collaborationButton.addEventListener("click", () => setCollaborationOpen(!state.collaborationOpen));
  elements.closeCollaborationButton.addEventListener("click", () => setCollaborationOpen(false));
  elements.collaborationScrim.addEventListener("click", () => setCollaborationOpen(false));
  elements.conversationTabButton.addEventListener("click", () => setCollaborationTab("conversation"));
  elements.proposalTabButton.addEventListener("click", () => setCollaborationTab("proposal"));
  elements.taskTrayTabButton.addEventListener("click", () => setCollaborationTab("tasks"));
  elements.refreshConversationButton.addEventListener("click", requestMapConversationSnapshot);
  elements.focusMainConversationButton.addEventListener("click", () => sendMapConversationRequest("focus-main"));
  elements.conversationThreadSelect.addEventListener("change", () => {
    void switchMapConversationThread().catch((error) => {
      elements.conversationSendState.textContent = `对话切换失败：${error?.message || "未知错误"}`;
      elements.conversationSendState.dataset.status = "error";
      renderMapConversation({ preserveScroll: true });
    });
  });
  elements.conversationComposer.addEventListener("submit", (event) => void submitMapConversation(event));
  elements.conversationInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.conversationComposer.requestSubmit();
    }
  });
  elements.conversationInput.addEventListener("input", () => {
    elements.sendConversationButton.disabled = elements.conversationInput.disabled
      || !elements.conversationInput.value.trim();
  });
  elements.interruptConversationButton.addEventListener("click", () => sendMapConversationRequest("interrupt", {
    threadId: state.conversationSnapshot?.boundThreadId,
  }));
  elements.openProposalInboxButton.addEventListener("click", showAiPatchDialog);
  elements.refreshMapAiManagedAuthorizationsButton.addEventListener("click", () => void loadMapAiManagedAuthorizations());
  elements.saveMapAiCollaborationPolicyButton.addEventListener("click", () => void saveMapAiCollaborationPolicy());
  elements.createMapAiManagedAuthorizationButton.addEventListener("click", () => void createMapAiManagedAuthorization());
  elements.mapAiManagedApprovalPolicy.addEventListener("change", renderMapAiManagedAuthorizations);
  elements.mapAiManagedAllowApply.addEventListener("change", renderMapAiManagedAuthorizations);
  elements.mapAiManagedMode?.addEventListener("change", renderMapAiManagedAuthorizations);
  for (const button of document.querySelectorAll("[data-collaboration-quick-target]")) {
    button.addEventListener("click", () => appendCollaborationQuickTarget(button.dataset.collaborationQuickTarget));
  }
  elements.cancelManagedAuthorizationConfirmButton.addEventListener("click", () => {
    state.pendingManagedAuthorizationRevoke = null;
    elements.managedAuthorizationConfirmDialog.close();
  });
  elements.confirmManagedAuthorizationRevokeButton.addEventListener("click", () => void confirmRevokeMapAiManagedAuthorization());
  elements.cancelManagedAuthorizationTransferButton.addEventListener("click", cancelTransferMapAiManagedAuthorization);
  elements.confirmManagedAuthorizationTransferButton.addEventListener("click", () => void confirmTransferMapAiManagedAuthorization());
  elements.closeManagedAuthorizationAuditButton.addEventListener("click", () => elements.managedAuthorizationAuditDialog.close());
  elements.refreshTaskTrayButton.addEventListener("click", () => void loadTaskTray());
  elements.openImageTasksButton.addEventListener("click", () => void showMapImageDialog());
  elements.openRenderTasksButton.addEventListener("click", () => void openRenderTaskDialog());
  elements.closeManagedTaskDialogButton.addEventListener("click", () => elements.managedTaskDialog.close());
  for (const [button, action] of [
    [elements.managedTaskApproveButton, "approve"],
    [elements.managedTaskPauseButton, "pause"],
    [elements.managedTaskResumeButton, "resume"],
    [elements.managedTaskTakeoverButton, "takeover"],
    [elements.managedTaskCancelButton, "cancel"],
  ]) button.addEventListener("click", () => void applyManagedTaskAction(action));
  renderCollaborationPanel();
  elements.zoomOutButton.addEventListener("click", () => state.viewer?.zoomBy(0.8));
  elements.zoomInButton.addEventListener("click", () => state.viewer?.zoomBy(1.25));
  elements.fitButton.addEventListener("click", () => state.viewer?.fit());
  elements.gridButton.addEventListener("click", () => {
    state.gridVisible = !state.gridVisible;
    state.viewer?.setGridVisible(state.gridVisible);
    elements.gridButton.classList.toggle("is-active", state.gridVisible);
    elements.gridButton.setAttribute("aria-pressed", String(state.gridVisible));
    scheduleMapEditorViewStateSave();
  });
  elements.gameWorkModeToggle.addEventListener("change", toggleGameWorkMode);
  elements.reloadButton.addEventListener("click", reloadMapEditor);
  elements.retryButton.addEventListener("click", reloadMapEditor);
  elements.closeButton.addEventListener("click", closeMapEditor);
  elements.saveButton.addEventListener("click", () => void saveMap());
  elements.revisionsButton.addEventListener("click", () => void showRevisionDialog());
  elements.closeRevisionDialogButton.addEventListener("click", () => elements.revisionDialog.close());
  elements.cancelRevisionRestoreButton.addEventListener("click", cancelRevisionRestore);
  elements.revisionRestoreConfirm.addEventListener("change", renderRevisionRestorePanel);
  elements.confirmRevisionRestoreButton.addEventListener("click", () => void restoreSelectedRevision());
  elements.undoButton.addEventListener("click", undoEdit);
  elements.redoButton.addEventListener("click", redoEdit);
  elements.aiEditButton.addEventListener("click", showAiPatchDialog);
  elements.autoMapButton.addEventListener("click", () => void showAutoMapDialog());
  elements.mapImageButton.addEventListener("click", () => void showMapImageDialog());
  elements.assetLibraryButton.addEventListener("click", showAssetLibrary);
  elements.mapCanvasHost.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("application/x-wfl-map-asset")) event.preventDefault();
  });
  elements.mapCanvasHost.addEventListener("drop", (event) => {
    const payload = event.dataTransfer?.getData("application/x-wfl-map-asset");
    if (!payload) return;
    event.preventDefault();
    void dropMapAsset(payload, event);
  });
  elements.closeAssetLibraryButton.addEventListener("click", () => elements.assetLibraryDialog.close());
  elements.assetLibrarySearch.addEventListener("input", scheduleAssetLibrarySearch);
  elements.assetLibraryKind.addEventListener("change", () => void loadAssetLibrarySearch());
  elements.assetLibraryFavoritesOnly.addEventListener("change", renderAssetLibraryResults);
  elements.crossProjectImportButton.addEventListener("click", () => void showCrossProjectImport());
  elements.closeCrossProjectImportButton.addEventListener("click", closeCrossProjectImport);
  elements.cancelCrossProjectImportButton.addEventListener("click", closeCrossProjectImport);
  elements.crossProjectImportDialog.addEventListener("close", () => void releaseCrossProjectSourceSession());
  for (const control of [
    elements.crossProjectImportSourcePath,
    elements.crossProjectImportTargetPath,
  ]) control.addEventListener("input", invalidateCrossProjectImportPlan);
  elements.crossProjectImportProject.addEventListener("change", () => {
    invalidateCrossProjectImportPlan();
    void releaseCrossProjectSourceSession();
  });
  elements.planCrossProjectImportButton.addEventListener("click", () => void planCrossProjectImport());
  elements.confirmCrossProjectImportButton.addEventListener("click", () => void confirmCrossProjectImport());
  elements.gamePreviewButton.addEventListener("click", () => void showGamePreviewDialog());
  elements.exportButton.addEventListener("click", () => void showExportDialog());
  elements.selectToolButton.addEventListener("click", () => setActiveTool("select"));
  elements.handToolButton.addEventListener("click", () => setActiveTool("hand"));
  elements.sampleToolButton.addEventListener("click", () => setActiveTool("sample"));
  elements.brushToolButton.addEventListener("click", () => setActiveTool("brush"));
  elements.terrainBrushToolButton.addEventListener("click", () => setActiveTool("terrain-brush"));
  elements.eraserToolButton.addEventListener("click", () => setActiveTool("eraser"));
  elements.fillToolButton.addEventListener("click", () => {
    if (state.activeTool === "fill" && state.fillPending) cancelPendingFill("填充已取消");
    else setActiveTool("fill");
  });
  elements.tileShapeToolButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!TILE_SHAPE_TOOLS.has(state.activeTool)) setActiveTool(state.tileShapeTool);
    setTileShapeMenuOpen(elements.tileShapeMenu.hidden);
  });
  elements.tileShapeMenu.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = event.target instanceof Element ? event.target.closest("[data-tile-shape]") : null;
    if (!button) return;
    state.tileShapeTool = button.dataset.tileShape;
    setActiveTool(state.tileShapeTool);
    renderTileShapeMenu();
    setTileShapeMenuOpen(false);
  });
  elements.tileShapeFilled.addEventListener("change", () => {
    if (state.tileShapeEdit?.current) updateTileShapePreview(state.tileShapeEdit.current);
  });
  elements.tileStampSelectButton.addEventListener("click", toggleTileStampSelection);
  elements.tileStampToolbar.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-tile-stamp-transform]") : null;
    if (button) transformSelectedTileStamp(button.dataset.tileStampTransform);
  });
  elements.tileRandomButton.addEventListener("click", toggleTileRandomMode);
  elements.tileRandomSeed.addEventListener("change", updateTileRandomSeed);
  elements.tileRandomizeSeedButton.addEventListener("click", randomizeTileSeed);
  elements.terrainSetSelect.addEventListener("change", selectTerrainSet);
  elements.terrainColorSelect.addEventListener("change", selectTerrainColor);
  elements.terrainBrushSeed.addEventListener("change", updateTerrainBrushSeed);
  elements.terrainRandomizeSeedButton.addEventListener("click", randomizeTerrainBrushSeed);
  elements.tileStampLibraryButton.addEventListener("click", showTileStampLibrary);
  elements.closeTileStampLibraryButton.addEventListener("click", () => elements.tileStampLibraryDialog.close());
  elements.tileStampLibraryForm.addEventListener("submit", saveNamedTileStamp);
  elements.copyTileStampButton.addEventListener("click", () => void copyTileStampToClipboard());
  elements.pasteTileStampButton.addEventListener("click", () => void pasteTileStampFromClipboard());
  elements.tileStampLibraryList.addEventListener("click", handleTileStampLibraryAction);
  elements.tileRectSelectButton.addEventListener("click", () => setActiveTool("tile-select"));
  elements.tileMagicToolButton.addEventListener("click", () => setActiveTool("tile-magic"));
  elements.tileSameToolButton.addEventListener("click", () => setActiveTool("tile-same"));
  elements.clearTileSelectionButton.addEventListener("click", clearTileSelection);
  elements.tileSelectionToolbar.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-tile-selection-mode]") : null;
    if (button) setTileSelectionMode(button.dataset.tileSelectionMode);
  });
  elements.objectToolButton.addEventListener("click", () => setActiveTool("object"));
  elements.collisionToolButton.addEventListener("click", () => setActiveTool("collision"));
  elements.vertexToolButton.addEventListener("click", () => setActiveTool("vertex"));
  elements.layersButton.addEventListener("click", () => setLayerPanelOpen(true));
  elements.layersCloseButton.addEventListener("click", () => setLayerPanelOpen(false));
  elements.layerScrim.addEventListener("click", () => setLayerPanelOpen(false));
  elements.addTileLayerButton.addEventListener("click", () => createLayer("tilelayer"));
  elements.addObjectLayerButton.addEventListener("click", () => createLayer("objectgroup"));
  elements.addGroupLayerButton.addEventListener("click", () => createLayer("group"));
  elements.addImageLayerButton.addEventListener("click", showImageLayerImport);
  elements.addTilesetButton.addEventListener("click", showTilesetImport);
  elements.saveCompositeButton.addEventListener("click", () => void saveSelectedLayersAsComposite());
  elements.duplicateLayerButton.addEventListener("click", duplicateActiveLayer);
  elements.moveLayerUpButton.addEventListener("click", () => moveActiveLayer(-1));
  elements.moveLayerDownButton.addEventListener("click", () => moveActiveLayer(1));
  elements.imageArrangeButton.addEventListener("click", toggleImageArrangePanel);
  elements.closeImageArrangeButton.addEventListener("click", () => setImageArrangePanelOpen(false));
  elements.imageArrangePanel.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-image-arrange]") : null;
    if (button) arrangeSelectedImageLayers(button.dataset.imageArrange);
  });
  elements.imageSnapEnabled.addEventListener("change", updateImageSnapSettings);
  elements.imageSnapUnit.addEventListener("change", updateImageSnapSettings);
  elements.imageSnapStep.addEventListener("change", updateImageSnapSettings);
  elements.deleteLayerButton.addEventListener("click", deleteActiveLayer);
  elements.closeImageLayerDialogButton.addEventListener("click", closeImageAssetPicker);
  elements.cancelImageLayerButton.addEventListener("click", closeImageAssetPicker);
  elements.imageLayerDialog.addEventListener("close", () => {
    if (state.mapImageAssetRole) {
      state.mapImageAssetRole = null;
      restoreImageAssetPickerLabels();
    }
  });
  elements.imageAssetParentButton.addEventListener("click", () => {
    const directory = state.imageAssetDirectory;
    const parent = directory ? directory.split("/").slice(0, -1).join("/") : "";
    void loadImageAssets(parent);
  });
  elements.refreshImageAssetsButton.addEventListener("click", () => void loadImageAssets(state.imageAssetDirectory));
  elements.loadMoreImageAssetsButton.addEventListener("click", () => void loadImageAssets(
    state.imageAssetDirectory,
    { append: true },
  ));
  elements.importImageLayerButton.addEventListener("click", () => void importSelectedImageLayer());
  elements.closeTilesetAssetDialogButton.addEventListener("click", () => elements.tilesetAssetDialog.close());
  elements.cancelTilesetImportButton.addEventListener("click", () => elements.tilesetAssetDialog.close());
  elements.tilesetAssetParentButton.addEventListener("click", () => {
    const directory = state.tilesetAssetDirectory;
    const parent = directory ? directory.split("/").slice(0, -1).join("/") : "";
    void loadTilesetAssets(parent);
  });
  elements.refreshTilesetAssetsButton.addEventListener("click", () => void loadTilesetAssets(state.tilesetAssetDirectory));
  elements.loadMoreTilesetAssetsButton.addEventListener("click", () => void loadTilesetAssets(
    state.tilesetAssetDirectory,
    { append: true },
  ));
  elements.importTilesetButton.addEventListener("click", () => void importSelectedTileset());
  elements.templateAssetButton.addEventListener("click", showTemplateAssets);
  elements.closeTemplateAssetDialogButton.addEventListener("click", () => elements.templateAssetDialog.close());
  elements.cancelTemplateImportButton.addEventListener("click", () => elements.templateAssetDialog.close());
  elements.templateAssetParentButton.addEventListener("click", () => {
    const directory = state.templateAssetDirectory;
    const parent = directory ? directory.split("/").slice(0, -1).join("/") : "";
    void loadTemplateAssets(parent);
  });
  elements.refreshTemplateAssetsButton.addEventListener("click", () => void loadTemplateAssets(state.templateAssetDirectory));
  elements.loadMoreTemplateAssetsButton.addEventListener("click", () => void loadTemplateAssets(
    state.templateAssetDirectory,
    { append: true },
  ));
  elements.importTemplateButton.addEventListener("click", () => void importSelectedTemplate());
  elements.tilesDetailButton.addEventListener("click", () => setDetailTab("tiles"));
  elements.propertiesDetailButton.addEventListener("click", () => setDetailTab("properties"));
  elements.tilePalettePreviousButton.addEventListener("click", () => changeTilePalettePage(-1));
  elements.tilePaletteNextButton.addEventListener("click", () => changeTilePalettePage(1));
  elements.objectPreset.addEventListener("change", () => {
    state.objectPreset = elements.objectPreset.value;
    refreshObjectCreationControls();
  });
  elements.objectShape.addEventListener("change", () => {
    state.objectShape = elements.objectShape.value;
    refreshObjectCreationControls();
  });
  elements.inspectorForm.addEventListener("submit", (event) => event.preventDefault());
  elements.inspectorForm.addEventListener("change", commitInspectorChange);
  elements.duplicateObjectButton.addEventListener("click", duplicateSelectedObject);
  elements.saveTemplateButton.addEventListener("click", () => void saveSelectedObjectAsTemplate());
  elements.refreshTemplateButton.addEventListener("click", () => void refreshSelectedTemplate());
  elements.unbindTemplateButton.addEventListener("click", unbindSelectedTemplate);
  elements.objectArrangeButton.addEventListener("click", () => {
    setObjectArrangePanelOpen(elements.objectArrangePanel.hidden);
  });
  elements.objectArrangePanel.addEventListener("click", (event) => {
    const arrangeButton = event.target instanceof Element ? event.target.closest("[data-object-arrange]") : null;
    const orderButton = event.target instanceof Element ? event.target.closest("[data-object-order]") : null;
    if (arrangeButton) arrangeSelectedObjects(arrangeButton.dataset.objectArrange);
    if (orderButton) orderSelectedObjects(orderButton.dataset.objectOrder);
  });
  elements.addObjectVertexButton.addEventListener("click", addSelectedObjectVertex);
  elements.objectVertexList.addEventListener("focusin", selectVertexFromControl);
  elements.objectVertexList.addEventListener("click", (event) => {
    const removeButton = event.target instanceof Element ? event.target.closest("[data-remove-object-vertex]") : null;
    if (removeButton) removeSelectedObjectVertex(Number(removeButton.dataset.removeObjectVertex));
  });
  elements.objectVertexList.addEventListener("change", commitObjectVertexControl);
  elements.deleteObjectButton.addEventListener("click", deleteSelectedObject);
  elements.addPropertyButton.addEventListener("click", addCustomProperty);
  elements.keepConflictEditsButton.addEventListener("click", () => {
    elements.saveConflictDialog.close();
    setMapReadyStatus();
  });
  elements.reloadConflictButton.addEventListener("click", () => {
    state.allowDirtyUnload = true;
    state.keepMapSessionOnPagehide = true;
    location.reload();
  });
  elements.cancelMapCloseButton.addEventListener("click", cancelMapEditorClose);
  elements.discardMapCloseButton.addEventListener("click", finalizeMapEditorClose);
  elements.saveMapCloseButton.addEventListener("click", () => void saveAndCloseMapEditor());
  elements.mapCloseDialog.addEventListener("close", () => {
    renderMapCloseDialog();
  });
  elements.closeAiPatchDialogButton.addEventListener("click", () => elements.aiPatchDialog.close());
  elements.cancelAiPatchButton.addEventListener("click", () => elements.aiPatchDialog.close());
  elements.connectMapAiButton.addEventListener("click", () => void connectMapAiLease());
  elements.disconnectMapAiButton.addEventListener("click", () => void disconnectMapAiLease());
  elements.refreshMapAiProposalsButton.addEventListener("click", () => void loadMapAiProposals());
  elements.copyAiPromptButton.addEventListener("click", () => void copyAiEditPrompt());
  elements.aiPatchSource.addEventListener("input", () => invalidateAiPatchPreview());
  elements.previewAiPatchButton.addEventListener("click", () => void previewAiPatch());
  elements.applyAiPatchButton.addEventListener("click", applyAiPatch);
  elements.aiPatchDialog.addEventListener("close", () => {
    state.aiPatchAbortController?.abort();
    state.aiPatchAbortController = null;
    state.aiPatchLoading = false;
    invalidateAiPatchPreview();
  });
  elements.closeAutoMapDialogButton.addEventListener("click", closeAutoMapDialog);
  elements.cancelAutoMapButton.addEventListener("click", closeAutoMapDialog);
  elements.randomizeAutoMapSeedButton.addEventListener("click", randomizeAutoMapSeed);
  elements.autoMapSeed.addEventListener("input", () => {
    invalidateAutoMapPreview();
    scheduleMapEditorViewStateSave();
  });
  elements.autoMapWhileDrawing.addEventListener("change", () => void toggleAutoMapWhileDrawing());
  elements.previewAutoMapButton.addEventListener("click", () => void generateAutoMapPreview());
  elements.applyAutoMapButton.addEventListener("click", () => void applyAutoMapPreview());
  elements.autoMapDialog.addEventListener("close", () => {
    state.autoMapAbortController?.abort();
    state.autoMapAbortController = null;
    clearAutoMapPreview();
  });
  elements.closeMapImageDialogButton.addEventListener("click", () => elements.mapImageDialog.close());
  elements.refreshMapImageButton.addEventListener("click", () => void loadMapImagePanel());
  elements.mapImageOperation.addEventListener("change", (event) => {
    if (!event.target.matches('input[name="mapImageOperation"]')) return;
    renderMapImageOperationControls();
    void refreshMapImageSourcePreview();
  });
  elements.mapImageKind.addEventListener("change", () => {
    renderMapImageAssetPreset();
    renderMapImageOperationControls();
  });
  elements.mapImageSourceButton.addEventListener("click", () => openMapImageAssetPicker("source"));
  elements.mapImageLayerSourceButton.addEventListener("click", () => void useActiveImageLayerSource());
  elements.mapImageSelectionButton.addEventListener("click", toggleMapImageSelectionSource);
  elements.mapImageSourceFile.addEventListener("change", () => {
    state.mapImageSourceFile = elements.mapImageSourceFile.files?.[0] || null;
    if (state.mapImageSourceFile) {
      state.mapImageSourcePaths = [];
      state.mapImageUseSelection = false;
      state.mapImageSourceLayerId = null;
    }
    renderMapImageOperationControls();
    void refreshMapImageSourcePreview();
  });
  elements.mapImageMaskButton.addEventListener("click", () => openMapImageAssetPicker("mask"));
  elements.mapImageMaskClearButton.addEventListener("click", clearMapImageMask);
  elements.mapImageMaskFile.addEventListener("change", () => {
    state.mapImageMaskFile = elements.mapImageMaskFile.files?.[0] || null;
    if (state.mapImageMaskFile) state.mapImageMaskPath = "";
    renderMapImageOperationControls();
  });
  elements.mapImagePreserveSource.addEventListener("change", renderMapImageOperationControls);
  elements.mapImageAlignmentPolicy.addEventListener("change", renderMapImageBoundaryPlan);
  elements.mapImageBoundaryResetButton.addEventListener("click", () => state.mapImageBoundaryController?.reset());
  elements.mapImageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createMapImageCandidate();
  });
  elements.mapImageDialog.addEventListener("close", () => {
    closeMapImagePanel();
    if (taskTrayIsVisible()) scheduleMapImagePolling();
  });
  elements.cancelGamePreviewButton.addEventListener("click", () => elements.gamePreviewDialog.close());
  elements.openGamePreviewButton.addEventListener("click", () => void openGamePreview());
  elements.closeExportDialogButton.addEventListener("click", () => elements.exportDialog.close());
  elements.cancelExportButton.addEventListener("click", () => elements.exportDialog.close());
  elements.exportCreateTab.addEventListener("click", () => setExportTab("create"));
  elements.exportJobsTab.addEventListener("click", () => {
    setExportTab("jobs");
    void loadRenderJobs();
  });
  elements.exportKind.addEventListener("change", () => {
    state.renderMessage = "";
    renderExportKind();
  });
  elements.exportForm.addEventListener("change", (event) => {
    if (event.target !== elements.exportKind) state.renderMessage = "";
    renderExportKind();
  });
  elements.exportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createRenderJob();
  });
  elements.cancelRenderJobButton.addEventListener("click", () => void cancelActiveRenderJob());
  elements.exportDialog.addEventListener("close", () => {
    stopRenderPolling();
    if (taskTrayIsVisible()) scheduleRenderPolling();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".tile-shape-control")) setTileShapeMenuOpen(false);
  });
  window.addEventListener("keydown", (event) => {
    const editingText = isTextEditingTarget(event.target);
    const dialogOpen = Boolean(document.querySelector("dialog[open]"));
    if (!editingText && !dialogOpen && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "?" || event.key === "F1")) {
      event.preventDefault();
      showEditorHelp();
      return;
    }
    if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) {
      state.keepMapSessionOnPagehide = true;
      return;
    }
    // Dialogs own their keyboard input, including Escape and command letters.
    // Never let a form or confirmation dialog mutate the map behind it.
    if (dialogOpen) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      void saveMap();
      return;
    }
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redoEdit();
      else undoEdit();
      return;
    }
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redoEdit();
      return;
    }
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      if (!duplicateSelectedObject() && elements.layerPanel.contains(document.activeElement)) {
        duplicateActiveLayer();
      }
      return;
    }
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      if (copySelectedObject()) event.preventDefault();
      return;
    }
    if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      if (pasteCopiedObject()) event.preventDefault();
      return;
    }
    if (!editingText && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const tool = ({
        v: "select",
        h: "hand",
        i: "sample",
        b: "brush",
        t: "terrain-brush",
        e: "eraser",
        f: "fill",
        o: "object",
        c: "collision",
      })[event.key.toLowerCase()];
      if (tool && toolAvailable(tool)) {
        event.preventDefault();
        setActiveTool(tool);
        return;
      }
    }
    if (!editingText && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const distance = event.shiftKey ? 10 : 1;
      const moved = nudgeSelectedObjects({
        x: event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0,
        y: event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0,
      });
      if (moved) event.preventDefault();
      return;
    }
    if (!editingText && ["Delete", "Backspace"].includes(event.key) && state.selectedObjectId != null) {
      event.preventDefault();
      deleteSelectedObject();
      return;
    }
    if (!editingText
      && ["Delete", "Backspace"].includes(event.key)
      && elements.layerPanel.contains(document.activeElement)
      && state.selectedLayerIds.size) {
      event.preventDefault();
      deleteActiveLayer();
      return;
    }
    if (event.key === "Escape") {
      cancelPendingFill("填充已取消");
      cancelPendingAutoMapGesture("AutoMap While Drawing 已取消；基础编辑已保留");
      setTileShapeMenuOpen(false);
      setTileStampSelecting(false);
      setImageArrangePanelOpen(false);
      setObjectArrangePanelOpen(false);
      state.guideController?.setPanelOpen(false);
      setLayerPanelOpen(false);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "0") {
      event.preventDefault();
      state.viewer?.fit();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.allowDirtyUnload || !state.editor?.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("focus", () => {
    // A canceled native reload returns focus to this document. Do not let a
    // stale reload marker suppress a later genuine window close.
    state.keepMapSessionOnPagehide = false;
    sendMapEditorTabState({ force: true, focused: true });
  });
  window.addEventListener("blur", () => sendMapEditorTabState({ force: true, focused: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleMapAiProposalPolling({ immediate: true });
      sendGameWorkModeSignal("heartbeat");
      void checkTemplateBindingVersions();
    } else stopMapAiProposalPolling();
  });
  window.navigation?.addEventListener?.("navigate", (event) => {
    if (event.navigationType === "reload") state.keepMapSessionOnPagehide = true;
  });
  window.addEventListener("pageswap", (event) => {
    if (event.activation?.navigationType === "reload") state.keepMapSessionOnPagehide = true;
  });
  window.addEventListener("pagehide", (event) => {
    stopTemplateVersionMonitor();
    flushMapEditorViewState();
    if (!event.persisted && !state.keepMapSessionOnPagehide) closeMapSessionKeepalive();
    else shutdownGameWorkMode();
  });
}

function showEditorHelp() {
  if (!elements.helpDialog.open) elements.helpDialog.showModal();
}

function reloadMapEditor() {
  state.keepMapSessionOnPagehide = true;
  location.reload();
}

function closeMapEditor() {
  if (state.editor?.dirty) {
    elements.mapCloseDetail.textContent = `${state.session?.relativePath || "当前地图"} 有未保存修改。你可以先保存、放弃修改，或取消关闭。`;
    elements.mapCloseState.textContent = "";
    if (!elements.mapCloseDialog.open) elements.mapCloseDialog.showModal();
    renderMapCloseDialog();
    return;
  }
  finalizeMapEditorClose();
}

async function saveAndCloseMapEditor() {
  if (state.mapCloseSaving) return;
  state.mapCloseSaving = true;
  elements.mapCloseState.textContent = "正在保存地图";
  renderMapCloseDialog();
  elements.mapCloseDialog.close();
  const saved = await saveMap();
  state.mapCloseSaving = false;
  if (!saved || state.editor?.dirty) {
    if (!elements.saveConflictDialog.open) {
      elements.mapCloseState.textContent = "地图未能保存，窗口仍保持打开";
      elements.mapCloseDialog.showModal();
      renderMapCloseDialog();
    }
    return;
  }
  finalizeMapEditorClose();
}

function cancelMapEditorClose() {
  if (state.mapCloseSaving) return;
  if (elements.mapCloseDialog.open) elements.mapCloseDialog.close();
}

function renderMapCloseDialog() {
  elements.cancelMapCloseButton.disabled = state.mapCloseSaving;
  elements.discardMapCloseButton.disabled = state.mapCloseSaving;
  elements.saveMapCloseButton.disabled = state.mapCloseSaving;
}

function finalizeMapEditorClose() {
  state.allowDirtyUnload = true;
  flushMapEditorViewState();
  if (elements.mapCloseDialog.open) elements.mapCloseDialog.close();
  closeMapSessionKeepalive();
  window.close();
}

function closeMapSessionKeepalive() {
  if (state.mapSessionCloseStarted || !state.credentials?.sessionId || !state.credentials?.editorInstanceId) return;
  state.mapSessionCloseStarted = true;
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  clearAutoSaveTimer();
  stopRenderPolling();
  stopMapImagePolling();
  stopMapAiProposalPolling();
  state.autoMapWorkerClient?.destroy();
  state.autoMapWorkerClient = null;
  state.autoMapGestureAbortController?.abort();
  state.autoMapGestureWorkerClient?.destroy();
  state.autoMapGestureWorkerClient = null;
  state.fillAbortController?.abort();
  state.fillWorkerClient?.destroy();
  state.fillWorkerClient = null;
  state.aiPatchAbortController?.abort();
  state.aiPatchWorkerClient?.destroy();
  state.aiPatchWorkerClient = null;
  state.aiProposalPatchWorkerClient?.destroy();
  state.aiProposalPatchWorkerClient = null;
  state.gamepadController?.stop();
  state.gamepadController = null;
  clearTimeout(state.mapFileSearchTimer);
  state.mapFileSearchTimer = null;
  void state.projectWorkspaceClient?.close({ keepalive: true }).catch(() => {});
  state.projectWorkspaceClient = null;
  window.clearTimeout(state.gamepadStatusTimer);
  state.gamepadStatusTimer = null;
  window.clearTimeout(state.fillStatusTimer);
  state.fillStatusTimer = null;
  if (state.gameWorkModeEnabled) sendGameWorkModeSignal("disable");
  sendMapEditorTabClosed();
  shutdownGameWorkMode();
  clearStoredMapAiLease();
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  void fetch(`/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      "X-Codex-Desktop-Action": "map-session-close",
      "X-Codex-Desktop-Editor-Instance": state.credentials.editorInstanceId,
    },
  }).catch(() => {});
}

function invalidateMapEditorAccountSession() {
  state.allowDirtyUnload = true;
  state.accountSessionGuard?.stop();
  state.accountSessionGuard = null;
  closeMapSessionKeepalive();
  stopTemplateVersionMonitor();
  clearTimeout(state.assetLibrarySearchTimer);
  state.assetLibrarySearchTimer = null;
  state.mapImageSourcePreviewToken += 1;
  revokeMapImageSourcePreview();
  for (const url of state.mapImagePreviewUrls.values()) URL.revokeObjectURL(url);
  state.mapImagePreviewUrls.clear();
  state.mapImagePreviewLoading.clear();
  state.mapImageBoundaryController?.destroy();
  state.mapImageBoundaryController = null;
  state.mapImageSourceFile = null;
  state.mapImageMaskFile = null;
  state.mapImageJobs = [];
  state.mapImageComparisons.clear();
  state.mapImagePublishDrafts.clear();
  state.mapImageSelectionTargets.clear();
  state.imageAssetEntries = [];
  state.imageAssetSelectionEntries.clear();
  state.tilesetAssetEntries = [];
  state.templateAssetEntries = [];
  state.assetLibrary = createMapAssetLibrary();
  void releaseCrossProjectSourceSession();
  state.viewer?.destroy();
  state.viewer = null;
  state.guideController?.destroy();
  state.guideController = null;
  state.editor = null;
  state.document = null;
  elements.mapCanvasHost.replaceChildren();
  document.body.replaceChildren(accountSessionEndedNotice("地图编辑器"));
  document.title = "账号已切换 · WFL 地图编辑器";
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

function mapSessionCredentials() {
  const fragment = new URLSearchParams(location.hash.replace(/^#/u, ""));
  const sessionId = fragment.get("session");
  const editorInstanceId = fragment.get("editor");
  if (sessionId && editorInstanceId) {
    const threadId = fragment.get("thread");
    const hostWindowId = fragment.get("host");
    const projectPath = fragment.get("project");
    const projectFile = fragment.get("projectFile");
    const projectSessionId = fragment.get("projectSession");
    const accountId = fragment.get("account");
    state.mapAiAutoConnectRequested = fragment.get("connect") === "1";
    const credentials = {
      sessionId,
      editorInstanceId,
      ...(threadId ? { threadId } : {}),
      ...(hostWindowId ? { hostWindowId } : {}),
      ...(projectPath ? { projectPath } : {}),
      ...(projectFile ? { projectFile } : {}),
      ...(projectSessionId ? { projectSessionId } : {}),
      ...(accountId ? { accountId } : {}),
    };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(credentials));
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return credentials;
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || "null");
    if (stored?.sessionId && stored?.editorInstanceId) return stored;
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
  return null;
}

function persistMapSessionCredentials() {
  if (!state.credentials?.sessionId || !state.credentials?.editorInstanceId) return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state.credentials));
  } catch {
    // The live host binding remains authoritative when storage is unavailable.
  }
}

function bindMapConversationThread(threadId) {
  if (!threadId || state.credentials?.threadId === threadId) return;
  state.credentials.threadId = threadId;
  persistMapSessionCredentials();
}

async function fetchMapSession() {
  const response = await mapFetch(`/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}`);
  return response.session;
}

async function showRevisionDialog() {
  if (!state.session?.id || state.revisionsLoading) return;
  state.selectedRevision = null;
  state.revisionsLoading = true;
  elements.revisionRestorePanel.hidden = true;
  elements.revisionRestoreConfirm.checked = false;
  elements.revisionState.textContent = "正在读取修订历史";
  elements.revisionList.replaceChildren();
  if (!elements.revisionDialog.open) elements.revisionDialog.showModal();
  try {
    const result = await mapFetch(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/revisions?limit=100`);
    state.revisions = Array.isArray(result.revisions) ? result.revisions : [];
    elements.revisionState.textContent = state.revisions.length ? `当前版本 ${shortVersion(result.mapVersion || state.session.version)} · ${state.revisions.length} 条修订` : "暂无可恢复修订；首次成功保存后会生成历史快照";
    renderRevisionList();
  } catch (error) {
    elements.revisionState.textContent = error.message;
    elements.revisionState.dataset.status = "error";
  } finally {
    state.revisionsLoading = false;
  }
}

function renderRevisionList() {
  const fragment = document.createDocumentFragment();
  for (const revision of state.revisions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "map-revision-item";
    item.dataset.revisionId = revision.id;
    item.classList.toggle("is-selected", state.selectedRevision?.id === revision.id);
    const when = formatRevisionTime(revision.createdAt);
    item.innerHTML = `<strong>${escapeHtml(when)} · ${escapeHtml(revision.reason || "保存")}</strong><span>${escapeHtml(shortVersion(revision.version))} · ${escapeHtml(formatBytes(revision.size))}</span>`;
    item.addEventListener("click", () => selectRevision(revision));
    fragment.append(item);
  }
  elements.revisionList.replaceChildren(fragment);
}

function selectRevision(revision) {
  if (!revision || revision.version === state.session?.version) return;
  state.selectedRevision = revision;
  elements.revisionRestoreConfirm.checked = false;
  renderRevisionList();
  renderRevisionRestorePanel();
}

function renderRevisionRestorePanel() {
  const revision = state.selectedRevision;
  elements.revisionRestorePanel.hidden = !revision;
  if (!revision) return;
  elements.revisionRestoreTitle.textContent = `恢复 ${formatRevisionTime(revision.createdAt)} 的修订？`;
  elements.revisionRestoreDetail.textContent = `目标版本 ${shortVersion(revision.version)}（${formatBytes(revision.size)}）。当前窗口${state.editor?.dirty ? "有未保存编辑，恢复不会覆盖本地撤销栈；恢复后请重新加载" : "将刷新为恢复后的新版本"}。`;
  elements.confirmRevisionRestoreButton.disabled = !elements.revisionRestoreConfirm.checked || state.revisionRestoring;
}

function cancelRevisionRestore() {
  state.selectedRevision = null;
  elements.revisionRestoreConfirm.checked = false;
  renderRevisionList();
  renderRevisionRestorePanel();
}

async function restoreSelectedRevision() {
  const revision = state.selectedRevision;
  if (!revision || state.revisionRestoring || !elements.revisionRestoreConfirm.checked) return;
  if (state.editor?.dirty) {
    elements.revisionState.textContent = "当前窗口有未保存编辑，请先保存或重新加载后再恢复修订";
    elements.revisionState.dataset.status = "error";
    return;
  }
  state.revisionRestoring = true;
  renderRevisionRestorePanel();
  elements.revisionState.textContent = "正在通过分块事务恢复修订";
  try {
    const result = await mapMutation(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/revisions/${encodeURIComponent(revision.id)}/restore`, {
      method: "POST",
      action: "map-revision-restore",
      json: { expectedCurrentVersion: state.session.version, confirmation: true, clientOperationId: crypto.randomUUID() },
    });
    elements.revisionState.textContent = "修订已恢复，正在刷新编辑器";
    state.keepMapSessionOnPagehide = true;
    location.reload();
    return result;
  } catch (error) {
    elements.revisionState.textContent = error.message;
    elements.revisionState.dataset.status = "error";
    if (error.status === 409) await showRevisionDialog();
  } finally {
    state.revisionRestoring = false;
    renderRevisionRestorePanel();
  }
}

function shortVersion(value) { return String(value || "").slice(0, 12) || "--"; }
function formatRevisionTime(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未知时间";
}
function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

async function loadTiledProjectTypes() {
  state.projectTypes = emptyTiledProjectTypes();
  state.projectSource = null;
  const projectFile = state.session?.projectFile || state.credentials?.projectFile;
  if (!projectFile) return state.projectTypes;
  try {
    const source = await mapFetch(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-source`,
    );
    if (source?.type && source.type !== "project") {
      throw new Error("Tiled 项目文件类型无效");
    }
    state.projectSource = source;
    state.projectTypes = parseTiledProjectTypes(source);
  } catch (error) {
    addWarning(`项目类型未加载：${error.message}`);
  }
  return state.projectTypes;
}

function setCollaborationOpen(open) {
  state.collaborationOpen = open === true;
  renderCollaborationPanel();
  if (state.collaborationOpen && state.collaborationTab === "conversation") requestMapConversationSnapshot();
  if (state.collaborationOpen && state.collaborationTab === "tasks") void loadTaskTray();
}

function setCollaborationTab(tab) {
  if (!["conversation", "proposal", "tasks"].includes(tab)) return;
  state.collaborationTab = tab;
  if (!state.collaborationOpen) state.collaborationOpen = true;
  renderCollaborationPanel();
  if (tab === "conversation") requestMapConversationSnapshot();
  else if (tab === "proposal") {
    renderCollaborationProposalTray();
    void loadMapAiProposals({ silent: true });
  } else {
    void loadTaskTray();
  }
}

function renderCollaborationPanel() {
  elements.mapApp.dataset.collaborationOpen = String(state.collaborationOpen);
  elements.collaborationButton.setAttribute("aria-expanded", String(state.collaborationOpen));
  elements.collaborationButton.classList.toggle("is-active", state.collaborationOpen);
  elements.collaborationScrim.hidden = !state.collaborationOpen || matchMedia("(min-width: 1201px)").matches;
  const tabs = [
    ["conversation", elements.conversationTabButton, elements.conversationPanel],
    ["proposal", elements.proposalTabButton, elements.proposalPanel],
    ["tasks", elements.taskTrayTabButton, elements.taskTrayPanel],
  ];
  for (const [tab, button, panel] of tabs) {
    const active = state.collaborationTab === tab;
    button.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
  }
  renderMapConversation();
  renderCollaborationProposalTray();
  renderTaskTray();
}

function mapConversationBinding() {
  if (!state.credentials?.hostWindowId
    || !state.credentials?.editorInstanceId
    || !state.credentials?.sessionId
    || !state.credentials?.projectPath) return null;
  return {
    hostWindowId: state.credentials.hostWindowId,
    editorInstanceId: state.credentials.editorInstanceId,
    sessionId: state.credentials.sessionId,
    projectPath: state.credentials.projectPath,
  };
}

function sendMapConversationRequest(action, extra = {}) {
  const binding = mapConversationBinding();
  if (!binding || !state.gameWorkModeChannel) return null;
  try {
    const request = createMapConversationRequest(action, {
      ...binding,
      requestId: crypto.randomUUID(),
      ...extra,
    });
    state.gameWorkModeChannel.postMessage(request);
    state.conversationPendingRequests.set(request.requestId, {
      action,
      text: extra.text || "",
      sentAt: Date.now(),
    });
    scheduleConversationRequestExpiry();
    return request;
  } catch (error) {
    elements.conversationSendState.textContent = error.message;
    return null;
  }
}

function requestMapConversationSnapshot() {
  if (Date.now() - state.conversationSnapshotRequestedAt < 250) return;
  const request = sendMapConversationRequest("snapshot-request");
  if (!request) {
    renderMapConversation();
    return;
  }
  state.conversationSnapshotRequestedAt = Date.now();
  elements.conversationSendState.textContent = "正在同步主界面对话";
}

function handleMapConversationSnapshot(event) {
  const binding = mapConversationBinding();
  if (!binding) return;
  const snapshot = parseMapConversationSnapshot(event?.data, binding);
  if (!snapshot || snapshot.revision < state.conversationLastRevision) return;
  state.conversationLastRevision = snapshot.revision;
  const previousThreadId = state.credentials.threadId || null;
  state.conversationSnapshot = snapshot;
  if (snapshot.boundThreadId) bindMapConversationThread(snapshot.boundThreadId);
  if (snapshot.boundThreadId) void loadMapAiManagedAuthorizations({ silent: true });
  if (previousThreadId && previousThreadId !== snapshot.boundThreadId) {
    state.gameWorkModeEnabled = false;
    state.gameWorkModeHostConnected = false;
    state.gameWorkModeHostActive = false;
    clearTimeout(state.gameWorkModeHeartbeatTimer);
    clearTimeout(state.gameWorkModeAckTimer);
    state.gameWorkModeHeartbeatTimer = null;
    state.gameWorkModeAckTimer = null;
    if (state.mapAiLease) {
      const oldLease = state.mapAiLease;
      clearMapAiLeaseLocal();
      void revokeMapAiLeaseWithUiRetry(oldLease);
    }
    renderGameWorkMode();
  }
  if (snapshot.requestId) state.conversationPendingRequests.delete(snapshot.requestId);
  renderMapConversation({ preserveScroll: true });
}

function handleMapConversationResult(event) {
  const binding = mapConversationBinding();
  if (!binding) return;
  const result = parseMapConversationResult(event?.data, binding);
  if (!result) return;
  const pending = state.conversationPendingRequests.get(result.requestId);
  state.conversationPendingRequests.delete(result.requestId);
  if (result.threadId) {
    bindMapConversationThread(result.threadId);
    void loadMapAiManagedAuthorizations({ silent: true });
  }
  if (result.ok && result.action === "send" && pending?.text
    && elements.conversationInput.value.trim() === pending.text.trim()) {
    elements.conversationInput.value = "";
  }
  elements.conversationSendState.textContent = result.message || (result.ok ? "操作完成" : "操作失败");
  elements.conversationSendState.dataset.status = result.ok ? "ready" : "error";
  renderMapConversation({ preserveScroll: result.action !== "send" });
  scheduleConversationRequestExpiry();
}

function scheduleConversationRequestExpiry() {
  clearTimeout(state.conversationRequestTimer);
  state.conversationRequestTimer = null;
  if (!state.conversationPendingRequests.size) return;
  state.conversationRequestTimer = setTimeout(() => {
    state.conversationRequestTimer = null;
    const threshold = Date.now() - 15_000;
    let expired = false;
    for (const [requestId, request] of state.conversationPendingRequests) {
      if (request.sentAt > threshold) continue;
      state.conversationPendingRequests.delete(requestId);
      expired = true;
    }
    if (expired) {
      elements.conversationSendState.textContent = "主界面没有及时响应；消息未自动重试";
      elements.conversationSendState.dataset.status = "error";
      renderMapConversation({ preserveScroll: true });
    }
    scheduleConversationRequestExpiry();
  }, 1_000);
}

async function switchMapConversationThread() {
  const threadId = elements.conversationThreadSelect.value;
  const snapshot = state.conversationSnapshot;
  if (!threadId || threadId === snapshot?.boundThreadId) return false;
  elements.conversationThreadSelect.disabled = true;
  if (state.gameWorkModeEnabled) sendGameWorkModeSignal("disable");
  if (state.mapAiLease) await disconnectMapAiLease();
  if (state.mapAiLease) {
    elements.conversationThreadSelect.value = snapshot.boundThreadId;
    renderMapConversation({ preserveScroll: true });
    elements.conversationSendState.textContent = "旧地图 AI 授权尚未撤销，未切换对话";
    elements.conversationSendState.dataset.status = "error";
    return false;
  }
  const request = sendMapConversationRequest("switch-thread", { threadId });
  if (!request) {
    elements.conversationThreadSelect.value = snapshot.boundThreadId;
    elements.conversationSendState.textContent = "主界面对话通道不可用，未切换对话";
    elements.conversationSendState.dataset.status = "error";
    renderMapConversation({ preserveScroll: true });
    return false;
  }
  elements.conversationSendState.textContent = "正在切换对话；地图画布和未保存编辑保持不变";
  renderMapConversation({ preserveScroll: true });
  return true;
}

function submitMapConversation(event) {
  event.preventDefault();
  const snapshot = state.conversationSnapshot;
  const text = elements.conversationInput.value.trim();
  if (!text || !snapshot?.boundThreadId || !snapshot.conversation.canSend) return;
  const request = sendMapConversationRequest("send", {
    operationId: crypto.randomUUID(),
    threadId: snapshot.boundThreadId,
    text,
  });
  if (!request) return;
  elements.conversationSendState.textContent = snapshot.conversation.status === "running"
    ? "正在向当前回合追加指令"
    : "正在发送消息";
  elements.conversationSendState.dataset.status = "busy";
  renderMapConversation({ preserveScroll: true });
}

function renderMapConversation({ preserveScroll = false } = {}) {
  const snapshot = state.conversationSnapshot;
  const messageList = elements.conversationMessageList;
  const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  const previousScroll = messageList.scrollTop;
  elements.collaborationConnectionState.textContent = snapshot
    ? snapshot.conversation.label
    : state.gameWorkModeChannel ? "等待主界面对话快照" : "未连接主界面";
  const currentSelection = elements.conversationThreadSelect.value;
  elements.conversationThreadSelect.replaceChildren();
  if (!snapshot?.threads.length) {
    const option = document.createElement("option");
    option.textContent = snapshot ? "当前工程没有可见对话" : "等待主界面";
    option.value = "";
    elements.conversationThreadSelect.append(option);
  } else {
    for (const thread of snapshot.threads) {
      const option = document.createElement("option");
      option.value = thread.id;
      option.textContent = `${thread.title}${thread.status === "running" ? " · 运行中" : thread.status === "waiting" ? " · 等待中" : ""}`;
      option.title = [thread.preview, thread.model, thread.provider].filter(Boolean).join(" · ");
      elements.conversationThreadSelect.append(option);
    }
    const selected = snapshot.threads.some((thread) => thread.id === snapshot.boundThreadId)
      ? snapshot.boundThreadId
      : snapshot.threads.some((thread) => thread.id === currentSelection) ? currentSelection : snapshot.threads[0].id;
    elements.conversationThreadSelect.value = selected;
  }
  const switching = [...state.conversationPendingRequests.values()].some((entry) => entry.action === "switch-thread");
  const sending = [...state.conversationPendingRequests.values()].some((entry) => entry.action === "send");
  elements.conversationThreadSelect.disabled = !snapshot?.threads.length || switching;
  elements.conversationInput.disabled = !snapshot?.conversation.canSend || sending;
  elements.sendConversationButton.disabled = elements.conversationInput.disabled || !elements.conversationInput.value.trim();
  elements.interruptConversationButton.hidden = !snapshot?.conversation.canInterrupt;
  elements.interruptConversationButton.disabled = [...state.conversationPendingRequests.values()]
    .some((entry) => entry.action === "interrupt");
  if (!sending && !switching && snapshot) {
    elements.conversationSendState.textContent = snapshot.conversation.label;
    elements.conversationSendState.dataset.status = snapshot.conversation.canSend ? "ready" : "";
  }
  const fragment = document.createDocumentFragment();
  if (!snapshot?.messages.length) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = snapshot?.activeThreadId === snapshot?.boundThreadId
      ? "这个对话还没有可显示的用户消息或 Codex 回复。工具输出仍在主界面查看。"
      : "切换到这个同项目对话后才读取最近的有界文本消息。";
    fragment.append(empty);
  } else {
    for (const message of snapshot.messages) fragment.append(renderMapConversationMessage(message));
  }
  messageList.replaceChildren(fragment);
  const imageDelivery = snapshot?.imageDelivery || { mode: "none", label: "本回合没有发送图片" };
  elements.conversationImageDelivery.dataset.mode = imageDelivery.mode;
  elements.conversationImageDelivery.querySelector("span").textContent = imageDelivery.label;
  refreshIcons();
  requestAnimationFrame(() => {
    if (!preserveScroll || nearBottom) messageList.scrollTop = messageList.scrollHeight;
    else messageList.scrollTop = previousScroll;
  });
}

function renderMapConversationMessage(message) {
  const article = document.createElement("article");
  article.className = "conversation-message";
  article.dataset.role = message.role;
  article.dataset.streaming = String(message.streaming === true);
  const header = document.createElement("header");
  const author = document.createElement("strong");
  author.textContent = message.role === "user" ? "你" : "Codex";
  const time = document.createElement("time");
  if (message.createdAt) {
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  header.append(author, time);
  article.append(header);
  if (message.text) {
    const text = document.createElement("p");
    text.textContent = message.text;
    article.append(text);
  }
  if (message.attachments.length) {
    const attachments = document.createElement("div");
    attachments.className = "conversation-attachments";
    for (const attachment of message.attachments) {
      const chip = document.createElement("span");
      chip.className = "conversation-attachment";
      chip.innerHTML = `<i data-lucide="${attachment.kind === "image" ? "image" : "file"}"></i><span></span>`;
      chip.querySelector("span").textContent = attachment.name;
      attachments.append(chip);
    }
    article.append(attachments);
  }
  return article;
}

function renderCollaborationProposalTray() {
  if (!elements.proposalTrayList) return;
  const pending = state.mapAiProposals.filter((proposal) => proposal.status === "pending");
  elements.proposalTabCount.hidden = pending.length === 0;
  elements.proposalTabCount.textContent = String(Math.min(99, pending.length));
  const fragment = document.createDocumentFragment();
  if (!state.mapAiProposals.length) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = state.mapAiLease ? "当前没有地图 AI 提案" : "连接地图 AI 后，结构化提案会实时显示在这里。";
    fragment.append(empty);
  }
  for (const proposal of state.mapAiProposals.slice(0, 30)) {
    const item = document.createElement("article");
    item.className = "proposal-tray-item";
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = proposal.source?.label || `地图补丁 ${proposal.id.slice(0, 8)}`;
    const status = document.createElement("small");
    status.textContent = proposal.status === "pending" ? "待处理" : proposal.status === "applied" ? "已应用" : "已丢弃";
    const detail = document.createElement("p");
    detail.textContent = proposal.patch?.summary || "结构化 Tiled 补丁";
    header.append(title, status);
    item.append(header, detail);
    item.addEventListener("click", showAiPatchDialog);
    fragment.append(item);
  }
  elements.proposalTrayList.replaceChildren(fragment);
}

async function loadTaskTray() {
  if (!state.session) return;
  elements.refreshTaskTrayButton.disabled = true;
  await Promise.all([
    refreshMapImageJobs({ silent: true }),
    loadRenderJobs({ quiet: true }),
    loadManagedMapAiTasks({ silent: true }),
  ]).finally(() => {
    elements.refreshTaskTrayButton.disabled = false;
    renderTaskTray();
  });
}

async function loadManagedMapAiTasks({ silent = false } = {}) {
  if (!state.session || !state.credentials?.projectPath) return;
  if (state.managedTaskLoading) return;
  state.managedTaskLoading = true;
  try {
    const query = new URLSearchParams({ threadId: state.credentials.threadId || "", limit: "100" });
    const response = await mapFetch(`/api/map-ai/managed-tasks?${query}`);
    state.managedTasks = Array.isArray(response?.tasks)
      ? response.tasks.filter((task) => task.mapPath === state.session.relativePath)
      : [];
    if (elements.managedTaskDialog?.open && state.activeManagedTaskId) {
      const activeTask = state.managedTasks.find((task) => task.id === state.activeManagedTaskId);
      if (activeTask) renderManagedTaskDialog(activeTask);
    }
    // Event detail is best-effort UI enrichment. Keep the task snapshot fast
    // even when an older server has no event history or the event request is
    // temporarily unavailable.
    void syncManagedMapAiTaskEvents(state.managedTasks)
      .then(() => renderTaskTray())
      .catch(() => {});
    const external = state.managedTasks.find((task) => (
      task.status === "succeeded"
      && task.currentVersion
      && task.currentVersion !== state.session.version
    ));
    state.managedMapExternalVersion = external?.currentVersion || null;
    if (external) {
      if (!state.editor?.dirty && !state.saving && state.managedMapAutoRefreshVersion !== external.currentVersion) {
        state.managedMapAutoRefreshVersion = external.currentVersion;
        setTaskTrayMessage("服务端地图已更新；当前窗口无未保存修改，正在安全刷新");
        window.setTimeout(() => {
          if (state.editor?.dirty || state.saving) {
            state.managedMapAutoRefreshVersion = null;
            setTaskTrayMessage("服务端地图已有 AI 托管更新；当前窗口出现未保存修改，请手动重新加载");
            return;
          }
          void autoRefreshManagedMapEditor();
        }, 0);
      } else {
        addWarning("AI 托管任务已更新服务端地图；当前窗口仍保留本地状态，请点击重新加载后查看");
        setTaskTrayMessage("服务端地图已有 AI 托管更新；为保护本地未保存编辑，请手动点击重新加载");
      }
    }
    renderTaskTray();
    if (!silent && state.managedTasks.length) setTaskTrayMessage?.(`已同步 ${state.managedTasks.length} 个托管地图任务`);
  } catch (error) {
    if (!silent) setTaskTrayMessage?.(`托管地图任务同步失败：${error.message}`);
  } finally {
    state.managedTaskLoading = false;
    scheduleManagedMapAiTaskPolling();
  }
}

async function autoRefreshManagedMapEditor() {
  if (state.editor?.dirty || state.saving) return;
  const lease = state.mapAiLease;
  if (lease) {
    const result = await revokeMapAiLeaseWithUiRetry(lease).catch((error) => ({
      revoked: false,
      attempts: 1,
      error,
    }));
    if (!result.revoked) {
      addWarning("自动刷新前未能完全撤销旧地图 AI 授权；窗口仍会刷新，短期授权将按服务端 TTL 过期");
    }
    clearMapAiLeaseLocal();
  }
  if (!state.editor?.dirty && !state.saving) reloadMapEditor();
}

async function syncManagedMapAiTaskEvents(tasks) {
  const activeIds = new Set(tasks.map((task) => task.id));
  for (const id of state.managedTaskEvents.keys()) {
    if (!activeIds.has(id)) state.managedTaskEvents.delete(id);
  }
  for (const id of state.managedTaskEventCursors.keys()) {
    if (!activeIds.has(id)) state.managedTaskEventCursors.delete(id);
  }
  for (const id of state.managedTaskEventSyncGenerations.keys()) {
    if (!activeIds.has(id)) state.managedTaskEventSyncGenerations.delete(id);
  }
  await Promise.all(tasks.slice(0, 30).map(async (task) => {
    // A task snapshot poll can finish while the previous event page request
    // is still in flight.  Give each task's sync pass a generation so a late
    // response from the older pass cannot move the cursor backwards or put a
    // stale terminal snapshot over a newer one.  The next pass will fetch the
    // same bounded page again if it was superseded before applying it.
    const generation = (state.managedTaskEventSyncGenerations.get(task.id) || 0) + 1;
    state.managedTaskEventSyncGenerations.set(task.id, generation);
    const isCurrentGeneration = () => state.managedTaskEventSyncGenerations.get(task.id) === generation;
    let after = state.managedTaskEventCursors.get(task.id) || 0;
    // A terminal task stops the normal polling loop. Drain a bounded number
    // of event pages in this one refresh so a terminal snapshot cannot leave
    // the cursor stranded behind `hasMore=true` when the task produced more
    // events than one response page. The event tray remains bounded to its
    // latest 80 entries while the cursor still advances to the durable tail.
    const pageLimit = 500;
    const maxPages = 8;
    let pageCount = 0;
    try {
      while (pageCount < maxPages) {
        if (!isCurrentGeneration()) return;
        const query = new URLSearchParams({ after: String(after), limit: String(pageLimit) });
        const response = await mapFetch(`/api/map-ai/managed-tasks/${encodeURIComponent(task.id)}/events?${query}`);
        if (!isCurrentGeneration()) return;
        // A bounded event tail may be truncated while this window is offline,
        // and a task can become terminal between the ordinary task poll and
        // this request. Whenever the server supplies a recovery snapshot,
        // apply it before rendering and never let a stale event replay overwrite a terminal state.
        if (response?.snapshotRequired && response.snapshot) {
          const snapshot = response.snapshot;
          const index = state.managedTasks.findIndex((entry) => entry.id === task.id);
          if (index >= 0) state.managedTasks[index] = snapshot;
        }
        const incoming = Array.isArray(response?.events) ? response.events : [];
        if (incoming.length) {
          const previous = state.managedTaskEvents.get(task.id) || [];
          const seen = new Set(previous.map((event) => Number(event.seq) || 0));
          const merged = [...previous, ...incoming.filter((event) => !seen.has(Number(event.seq) || 0))].slice(-80);
          state.managedTaskEvents.set(task.id, merged);
        }
        const latest = Number(response?.latestEventSeq || task.events?.at(-1)?.seq || 0);
        const nextAfter = Number(response?.nextAfter);
        const candidateAfter = Number.isSafeInteger(nextAfter) && nextAfter >= after
          ? nextAfter
          : Math.max(after, ...incoming.map((event) => Number(event.seq) || 0));
        after = Math.max(after, candidateAfter);
        state.managedTaskEventCursors.set(task.id, after || latest);
        pageCount += 1;
        if (!response?.hasMore || after >= latest || candidateAfter <= (state.managedTaskEventCursors.get(task.id) || 0) && !incoming.length) break;
      }
      if (!state.managedTaskEventCursors.has(task.id)) {
        state.managedTaskEventCursors.set(task.id, after || Number(task.events?.at(-1)?.seq || 0));
      }
      renderTaskTray();
    } catch {
      // Task snapshots remain authoritative; event detail is an enhancement
      // and must never make the editor task tray unavailable.
    }
  }));
}

function scheduleManagedMapAiTaskPolling() {
  clearTimeout(state.managedTaskPollTimer);
  if (!state.session || !state.credentials?.projectPath) return;
  if (!state.managedTasks.some((task) => !["succeeded", "failed", "canceled", "conflict"].includes(task.status))) return;
  state.managedTaskPollTimer = setTimeout(() => {
    state.managedTaskPollTimer = null;
    void loadManagedMapAiTasks({ silent: true });
  }, MAP_AI_MANAGED_TASK_POLL_MS);
}

function taskTrayIsVisible() {
  return state.collaborationOpen && state.collaborationTab === "tasks";
}

function renderTaskTray() {
  if (!elements.taskTrayList) return;
  const imageJobs = state.mapImageJobs.slice(0, 20).map((job) => ({
    id: job.id,
    kind: "image",
    title: mapImageKindLabel(mapImageJobKind(job)),
    status: mapImageStatusLabel(job.status),
    detail: job.error?.message || String(job.request?.prompt || "").split("\n", 1)[0] || "地图图片任务",
    createdAt: job.createdAt,
    active: mapImageJobIsActive(job),
  }));
  const renderJobs = state.renderJobs.slice(0, 20).map((job) => ({
    id: job.id,
    kind: "render",
    title: renderKindLabel(job.kind),
    status: renderStatusLabel(job.status),
    detail: job.error?.message || job.result?.summary || job.outputRoot || "渲染任务",
    createdAt: job.createdAt,
    active: ACTIVE_RENDER_STATUSES.has(job.status),
  }));
  const managedTasks = state.managedTasks.slice(0, 20).map((task) => ({
    id: task.id,
    kind: "managed-map-ai",
    title: "AI 托管地图",
    status: managedTaskStatusLabel(task.status),
    detail: task.error?.message
      || state.managedTaskEvents.get(task.id)?.at(-1)?.details?.summary
      || task.checkpoints?.at(-1)?.summary
      || `操作 ${task.planSummary?.operationCount || 0} 个`,
    createdAt: task.createdAt,
    active: !["succeeded", "failed", "canceled", "conflict"].includes(task.status),
    task,
  }));
  const jobs = [...imageJobs, ...renderJobs, ...managedTasks]
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, 30);
  const activeCount = jobs.filter((job) => job.active).length;
  elements.taskTrayCount.hidden = activeCount === 0;
  elements.taskTrayCount.textContent = String(Math.min(99, activeCount));
  const fragment = document.createDocumentFragment();
  if (!jobs.length) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = "当前地图还没有图片或渲染任务。";
    fragment.append(empty);
  }
  for (const job of jobs) {
    const item = document.createElement("article");
    item.className = "task-tray-item";
    item.dataset.active = String(job.active);
    const header = document.createElement("header");
    const title = document.createElement("strong");
    const prefix = job.kind === "image" ? "图片" : job.kind === "render" ? "渲染" : "AI 托管";
    title.textContent = `${prefix} · ${job.title}`;
    const status = document.createElement("small");
    status.textContent = job.status;
    const detail = document.createElement("p");
    detail.textContent = job.detail;
    header.append(title, status);
    item.append(header, detail);
    item.addEventListener("click", () => {
      if (job.kind === "image") void showMapImageDialog();
      else if (job.kind === "render") void openRenderTaskDialog(job.id);
      else void showManagedMapAiTaskActions(job.task);
    });
    fragment.append(item);
  }
  elements.taskTrayList.replaceChildren(fragment);
  if (taskTrayIsVisible()) {
    scheduleMapImagePolling();
    scheduleRenderPolling();
  }
}

function managedTaskStatusLabel(status) {
  return {
    queued: "排队中", running: "执行中", awaiting_approval: "等待批准", paused: "已暂停",
    interrupted: "服务重启后待确认", cancel_requested: "正在取消", succeeded: "已完成",
    failed: "失败", canceled: "已取消", conflict: "版本冲突",
  }[status] || "未知状态";
}

function setTaskTrayMessage(message) {
  if (elements.taskTrayState) elements.taskTrayState.textContent = message || "";
}

async function showManagedMapAiTaskActions(task) {
  if (!task?.id) return;
  state.activeManagedTaskId = task.id;
  renderManagedTaskDialog(task);
  if (!elements.managedTaskDialog.open) elements.managedTaskDialog.showModal();
}

function activeManagedTask() {
  return state.managedTasks.find((task) => task.id === state.activeManagedTaskId) || null;
}

function renderManagedTaskDialog(task) {
  if (!task) return;
  const checkpoint = task.checkpoints?.at(-1) || null;
  const validation = task.lastValidation || checkpoint?.validation || null;
  const worker = task.workerStatus
    ? `${task.workerStatus}${task.workerIsolation ? `（${task.workerIsolation}）` : ""}`
    : "未记录";
  elements.managedTaskSummaryTitle.textContent = task.mapPath ? `地图 AI 托管 · ${task.mapPath}` : "地图 AI 托管";
  elements.managedTaskStatusBadge.textContent = managedTaskStatusLabel(task.status);
  elements.managedTaskStage.textContent = task.currentStage || managedTaskStatusLabel(task.status);
  elements.managedTaskOperation.textContent = task.currentOperation == null
    ? (task.nextOperation == null ? "无待执行操作" : `下一项：${task.nextOperation + 1}`)
    : `当前第 ${task.currentOperation + 1} 项${task.nextOperation == null ? "" : `，下一项 ${task.nextOperation + 1}`}`;
  elements.managedTaskWorker.textContent = worker;
  elements.managedTaskValidation.textContent = validation?.stage || "未记录";
  elements.managedTaskBaseVersion.textContent = shortHash(task.baseVersion);
  elements.managedTaskCurrentVersion.textContent = shortHash(task.currentVersion);
  elements.managedTaskDetailState.textContent = task.error
    ? `${task.error.code}：${task.error.message}`
    : "详细收据只显示安全摘要，不包含绝对路径、图片字节或凭据。";
  elements.managedTaskRiskReceipt.textContent = JSON.stringify(checkpoint?.risk || {}, null, 2);
  renderManagedTaskDiff(checkpoint?.diff);
  state.viewer?.setAiImpactPreview(checkpoint?.diff?.impact || null);
  const events = (state.managedTaskEvents.get(task.id) || task.events || []).slice(-8);
  elements.managedTaskEventReceipt.replaceChildren(...events.map((event) => {
    const item = document.createElement("li");
    item.textContent = `${event.type}${event.details?.summary ? `：${event.details.summary}` : ""}`;
    return item;
  }));
  const final = ["succeeded", "failed", "canceled", "conflict"].includes(task.status);
  elements.managedTaskApproveButton.hidden = task.status !== "awaiting_approval";
  elements.managedTaskPauseButton.hidden = !["queued", "running", "awaiting_approval"].includes(task.status);
  elements.managedTaskResumeButton.hidden = !["paused", "interrupted"].includes(task.status);
  elements.managedTaskTakeoverButton.hidden = final || !["queued", "running", "awaiting_approval", "paused", "interrupted"].includes(task.status);
  elements.managedTaskCancelButton.hidden = final;
}

function renderManagedTaskDiff(diff) {
  const container = elements.managedTaskDiffReceipt;
  container.replaceChildren();
  if (!diff || typeof diff !== "object") {
    container.textContent = "暂无候选差异";
    return;
  }
  const summary = document.createElement("p");
  summary.textContent = `${diff.summary || "地图修改"} · ${diff.operationCount || 0} 项操作 · ${diff.tileCellCount || 0} 个瓦片单元`;
  container.append(summary);
  const impact = diff.impact;
  if (impact && typeof impact === "object") {
    const impactSummary = document.createElement("small");
    const bounds = impact.bounds ? ` · 影响范围 ${impact.bounds.x},${impact.bounds.y} ${impact.bounds.width}×${impact.bounds.height}` : "";
    const heat = Array.isArray(impact.heatmap) ? impact.heatmap.length : 0;
    impactSummary.textContent = `影响摘要 ${impact.version || "wfl-tiled-diff-v1"} · ${impact.layers?.length || 0} 个图层 · ${impact.objects?.length || 0} 个对象锚点 · ${heat} 个热区点${bounds}`;
    container.append(impactSummary);
    if (impact.truncated && Object.values(impact.truncated).some(Boolean)) {
      const bounded = document.createElement("small");
      bounded.textContent = "影响热区已按安全上限截断，完整地图数据不会进入对话上下文";
      container.append(bounded);
    }
  }
  for (const entry of (Array.isArray(diff.entries) ? diff.entries : []).slice(0, 12)) {
    const item = document.createElement("div");
    item.className = "managed-task-diff-entry";
    item.textContent = `${entry.index == null ? "" : `#${entry.index + 1} `}${entry.title || entry.op || "操作"}${entry.detail ? `：${entry.detail}` : ""}`;
    container.append(item);
  }
  if (diff.truncated) {
    const omitted = document.createElement("small");
    omitted.textContent = `其余 ${diff.omittedEntries || 0} 项仅保存在服务端收据中`;
    container.append(omitted);
  }
}

async function applyManagedTaskAction(action) {
  const task = activeManagedTask();
  if (!task) return;
  try {
    const body = { action };
    if (action === "resume" && task.status === "interrupted") body.confirmation = task.id;
    await mapMutation(`/api/map-ai/managed-tasks/${encodeURIComponent(task.id)}/action`, {
      method: "POST", action: "map-ai-managed-task-action", json: body,
    });
    await loadManagedMapAiTasks({ silent: true });
    const updated = activeManagedTask();
    if (updated) renderManagedTaskDialog(updated);
    setTaskTrayMessage(`托管任务操作已提交：${managedTaskStatusLabel(updated?.status || task.status)}`);
  } catch (error) {
    elements.managedTaskDetailState.textContent = `操作失败：${error.message}`;
  }
}

function shortHash(value) {
  const hash = String(value || "");
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash || "--";
}

async function openRenderTaskDialog(jobId = null) {
  await showExportDialog();
  if (jobId && state.renderJobs.some((job) => job.id === jobId)) state.activeRenderJobId = jobId;
  setExportTab("jobs");
  renderRenderJobs();
}

function initializeGameWorkMode() {
  if (state.gameWorkModeChannel || !state.credentials?.hostWindowId) {
    renderGameWorkMode();
    return;
  }
  if (typeof BroadcastChannel !== "function") {
    renderGameWorkMode();
    return;
  }
  try {
    const channel = new BroadcastChannel(gameWorkModeChannelName(state.credentials.hostWindowId));
    channel.addEventListener("message", handleGameWorkModeAck);
    channel.addEventListener("message", handleGameWorkModeCommand);
    channel.addEventListener("message", handleMapEditorTabSignal);
    channel.addEventListener("message", handleMapConversationSnapshot);
    channel.addEventListener("message", handleMapConversationResult);
    state.gameWorkModeChannel = channel;
  } catch {
    state.gameWorkModeChannel = null;
  }
  renderGameWorkMode();
  renderMapDocumentTabs();
  requestMapConversationSnapshot();
}

function handleMapEditorTabSignal(event) {
  const signal = parseMapEditorTabSignal(event?.data, {
    hostWindowId: state.credentials?.hostWindowId,
  });
  if (!signal) return;
  if (signal.action === "snapshot") {
    state.mapEditorTabs = signal.tabs.filter((tab) => tab.projectPath === state.credentials?.projectPath);
    renderMapDocumentTabs();
    return;
  }
  if (signal.action === "close-command"
    && signal.targetEditorInstanceId === state.credentials?.editorInstanceId) {
    window.focus();
    closeMapEditor();
  }
}

function sendMapEditorTabState({ force = false, focused = document.hasFocus() } = {}) {
  const input = currentMapEditorTabInput({ focused });
  if (!state.gameWorkModeChannel || !input) return false;
  const fingerprint = `${input.relativePath}\0${input.dirty}\0${input.focused}`;
  if (!force && fingerprint === state.mapEditorTabSignalFingerprint) return true;
  try {
    state.gameWorkModeChannel.postMessage(createMapEditorTabSignal("state", input));
    state.mapEditorTabSignalFingerprint = fingerprint;
    return true;
  } catch {
    return false;
  }
}

function sendMapEditorTabClosed() {
  const input = currentMapEditorTabInput();
  if (state.mapEditorTabClosedSent || !state.gameWorkModeChannel || !input) return false;
  try {
    state.gameWorkModeChannel.postMessage(createMapEditorTabSignal("closed", input));
    state.mapEditorTabClosedSent = true;
    return true;
  } catch {
    return false;
  }
}

function currentMapEditorTabInput({ focused = document.hasFocus() } = {}) {
  if (!state.credentials?.hostWindowId
    || !state.credentials?.editorInstanceId
    || !state.credentials?.sessionId
    || !state.credentials?.projectPath
    || !state.session?.relativePath) return null;
  return {
    hostWindowId: state.credentials.hostWindowId,
    editorInstanceId: state.credentials.editorInstanceId,
    sessionId: state.credentials.sessionId,
    projectPath: state.credentials.projectPath,
    relativePath: state.session.relativePath,
    dirty: state.editor?.dirty === true,
    focused: focused === true,
  };
}

function renderMapDocumentTabs() {
  const ownInput = currentMapEditorTabInput();
  const tabs = [...state.mapEditorTabs];
  if (ownInput && !tabs.some((tab) => tab.editorInstanceId === ownInput.editorInstanceId)) {
    tabs.push({ ...ownInput, active: document.hasFocus() });
  }
  tabs.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
  const fragment = document.createDocumentFragment();
  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = "map-document-tab";
    row.dataset.dirty = String(tab.dirty === true);
    row.dataset.active = String(tab.active === true);
    row.dataset.editorInstanceId = tab.editorInstanceId;
    const marker = document.createElement("span");
    marker.className = "map-document-tab-state";
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "map-document-tab-name";
    activate.setAttribute("role", "tab");
    activate.setAttribute("aria-selected", String(tab.active === true));
    activate.textContent = tab.relativePath.split("/").at(-1) || tab.relativePath;
    activate.title = tab.relativePath;
    activate.addEventListener("click", () => requestMapEditorTabFocus(tab.editorInstanceId));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "map-document-tab-close";
    close.title = `关闭 ${activate.textContent}`;
    close.setAttribute("aria-label", close.title);
    close.innerHTML = '<i data-lucide="x"></i>';
    close.addEventListener("click", () => requestMapEditorTabClose(tab.editorInstanceId));
    row.append(marker, activate, close);
    fragment.append(row);
  }
  elements.mapDocumentTabList.replaceChildren(fragment);
  const canChooseMap = Boolean(state.credentials?.projectPath && state.credentials?.hostWindowId);
  elements.mapFileButton.disabled = !canChooseMap;
  elements.mapDocumentTabAddButton.disabled = !currentMapEditorTabInput();
  refreshIcons();
}

async function showMapFileDialog() {
  if (!state.credentials?.projectPath) {
    addWarning("当前地图没有绑定工程，无法切换工程地图");
    return;
  }
  if (!elements.mapFileDialog.open) elements.mapFileDialog.showModal();
  elements.mapFileTitle.textContent = `${state.session?.projectFile || "当前工程"} · 切换地图`;
  elements.mapFileSearch.value = "";
  state.mapFileQuery = ".tmj";
  state.mapFileEntries = [];
  state.mapFileNextCursor = null;
  await loadMapFileList();
  requestAnimationFrame(() => elements.mapFileSearch.focus());
}

function closeMapFileDialog() {
  clearTimeout(state.mapFileSearchTimer);
  state.mapFileSearchTimer = null;
  if (elements.mapFileDialog.open) elements.mapFileDialog.close();
}

function scheduleMapFileSearch() {
  clearTimeout(state.mapFileSearchTimer);
  state.mapFileSearchTimer = setTimeout(() => {
    state.mapFileSearchTimer = null;
    void loadMapFileList();
  }, 220);
}

async function ensureMapProjectWorkspace() {
  if (state.projectWorkspaceClient?.session) {
    updateMapProjectSessionCredential(state.projectWorkspaceClient.session);
    return state.projectWorkspaceClient.session;
  }
  const projectPath = state.credentials?.projectPath;
  if (!projectPath) throw new Error("当前地图没有绑定工程");
  const client = state.projectWorkspaceClient || new MapProjectWorkspaceClient();
  state.projectWorkspaceClient = client;
  const session = await client.open({
    project: projectPath,
    projectFile: state.session?.projectFile || state.credentials?.projectFile || null,
  });
  if (state.projectWorkspaceClient !== client) {
    await client.close({ keepalive: true }).catch(() => {});
    throw new Error("地图项目工作区在连接过程中发生变化");
  }
  updateMapProjectSessionCredential(session);
  return session;
}

function updateMapProjectSessionCredential(session) {
  if (!session?.id || !state.credentials) return;
  state.credentials.projectSessionId = session.id;
  if (session.projectFile) state.credentials.projectFile = session.projectFile;
  else if (!state.session?.projectFile) delete state.credentials.projectFile;
  persistMapSessionCredentials();
}

async function loadMapFileList({ append = false } = {}) {
  if (state.mapFileLoading) return;
  const query = elements.mapFileSearch.value.trim() || ".tmj";
  if (query.length < 2) {
    state.mapFileEntries = [];
    state.mapFileNextCursor = null;
    elements.mapFileState.textContent = "请至少输入 2 个字符，或清空以显示所有 .tmj 地图";
    elements.mapFileState.dataset.status = "";
    renderMapFileList();
    return;
  }
  if (!append || query !== state.mapFileQuery) {
    state.mapFileQuery = query;
    state.mapFileEntries = [];
    state.mapFileNextCursor = null;
  }
  state.mapFileLoading = true;
  elements.mapFileSearch.disabled = true;
  elements.mapFileState.textContent = append ? "正在加载更多地图" : "正在读取当前工程地图";
  elements.mapFileState.dataset.status = "busy";
  renderMapFileList();
  try {
    const client = state.projectWorkspaceClient || new MapProjectWorkspaceClient();
    state.projectWorkspaceClient = client;
    await ensureMapProjectWorkspace();
    const page = await client.search({
      query,
      kinds: ["map"],
      cursor: append ? state.mapFileNextCursor : null,
      limit: 100,
    });
    const entries = append ? [...state.mapFileEntries, ...page.entries] : page.entries;
    state.mapFileEntries = [...new Map(entries
      .filter((entry) => entry.kind === "map" && /\.tmj$/iu.test(entry.path))
      .map((entry) => [entry.path, entry])).values()]
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
    state.mapFileNextCursor = page.nextCursor;
    elements.mapFileState.textContent = state.mapFileEntries.length
      ? `${state.mapFileEntries.length} 个地图${page.truncated ? " · 已达到搜索上限" : ""}`
      : "没有匹配的 .tmj 地图";
    elements.mapFileState.dataset.status = page.truncated ? "warning" : "";
  } catch (error) {
    elements.mapFileState.textContent = `无法读取地图列表：${error.message}`;
    elements.mapFileState.dataset.status = "error";
    state.mapFileNextCursor = null;
  } finally {
    state.mapFileLoading = false;
    elements.mapFileSearch.disabled = false;
    renderMapFileList();
  }
}

function renderMapFileList() {
  const fragment = document.createDocumentFragment();
  if (!state.mapFileEntries.length && !state.mapFileLoading) {
    const empty = document.createElement("div");
    empty.className = "map-file-empty";
    empty.innerHTML = '<i data-lucide="map-off"></i><span>没有可切换的 .tmj 地图</span>';
    fragment.append(empty);
  }
  for (const entry of state.mapFileEntries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-file-entry";
    button.dataset.current = String(entry.path === state.session?.relativePath);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(entry.path === state.session?.relativePath));
    button.disabled = state.mapFileLoading;
    button.innerHTML = '<i data-lucide="map"></i><span class="map-file-entry-copy"><strong></strong><small></small></span><span class="map-file-entry-mark"></span>';
    button.querySelector("strong").textContent = entry.name || entry.path.split("/").at(-1) || entry.path;
    button.querySelector("small").textContent = entry.path;
    if (entry.path === state.session?.relativePath) {
      button.title = "当前地图";
      button.querySelector(".map-file-entry-mark").textContent = "当前";
    } else {
      button.title = `切换到 ${entry.path}`;
      button.addEventListener("click", () => requestMapEditorOpen(entry.path));
    }
    fragment.append(button);
  }
  elements.mapFileList.replaceChildren(fragment);
  elements.loadMoreMapFilesButton.hidden = !state.mapFileNextCursor;
  elements.loadMoreMapFilesButton.disabled = state.mapFileLoading;
  refreshIcons();
}

function requestMapEditorTabFocus(targetEditorInstanceId) {
  if (targetEditorInstanceId === state.credentials?.editorInstanceId) {
    window.focus();
    return;
  }
  sendMapEditorTabRequest("focus-request", targetEditorInstanceId);
}

function requestMapEditorTabClose(targetEditorInstanceId) {
  if (targetEditorInstanceId === state.credentials?.editorInstanceId) {
    closeMapEditor();
    return;
  }
  sendMapEditorTabRequest("close-request", targetEditorInstanceId);
}

function requestMapEditorOpen(targetRelativePath) {
  const input = currentMapEditorTabInput();
  if (!input || typeof targetRelativePath !== "string" || !/\.tmj$/iu.test(targetRelativePath)) return;
  if (targetRelativePath === input.relativePath) {
    closeMapFileDialog();
    return;
  }
  if (!state.gameWorkModeChannel) {
    elements.mapFileState.textContent = "当前窗口没有连接主站，无法切换地图；请从主站重新打开编辑器";
    elements.mapFileState.dataset.status = "error";
    return;
  }
  try {
    state.gameWorkModeChannel.postMessage(createMapEditorTabSignal("open-request", {
      ...input,
      projectSessionId: state.projectWorkspaceClient?.session?.id || state.credentials?.projectSessionId || null,
      targetRelativePath,
    }));
    elements.mapFileState.textContent = `正在打开 ${targetRelativePath}`;
    elements.mapFileState.dataset.status = "busy";
    elements.mapFileSearch.disabled = true;
    closeMapFileDialog();
  } catch {
    elements.mapFileState.textContent = "无法请求切换地图，请重试";
    elements.mapFileState.dataset.status = "error";
  }
}

function sendMapEditorTabRequest(action, targetEditorInstanceId) {
  if (!state.gameWorkModeChannel || !state.credentials?.hostWindowId) return false;
  try {
    state.gameWorkModeChannel.postMessage(createMapEditorTabSignal(action, {
      hostWindowId: state.credentials.hostWindowId,
      editorInstanceId: state.credentials.editorInstanceId,
      targetEditorInstanceId,
    }));
    return true;
  } catch {
    return false;
  }
}

function gameWorkModeAvailable() {
  return Boolean(state.gameWorkModeChannel
    && state.credentials?.hostWindowId
    && state.credentials?.threadId
    && state.credentials?.projectPath
    && state.credentials?.sessionId
    && state.credentials?.editorInstanceId);
}

function toggleGameWorkMode() {
  const enabled = elements.gameWorkModeToggle.checked === true;
  if (enabled && !gameWorkModeAvailable()) {
    state.gameWorkModeEnabled = false;
    renderGameWorkMode();
    return;
  }
  state.gameWorkModeEnabled = enabled;
  state.gameWorkModeHostConnected = false;
  state.gameWorkModeHostActive = false;
  clearTimeout(state.gameWorkModeAckTimer);
  state.gameWorkModeAckTimer = null;
  if (enabled) {
    sendGameWorkModeSignal("enable");
    scheduleGameWorkModeHeartbeat();
    state.gameWorkModeAckTimer = setTimeout(() => {
      state.gameWorkModeAckTimer = null;
      renderGameWorkMode();
    }, 2_500);
  } else {
    sendGameWorkModeSignal("disable");
    clearTimeout(state.gameWorkModeHeartbeatTimer);
    state.gameWorkModeHeartbeatTimer = null;
  }
  renderGameWorkMode();
}

function sendGameWorkModeSignal(action) {
  if (!state.gameWorkModeChannel || (action === "heartbeat" && !state.gameWorkModeEnabled)) return false;
  try {
    state.gameWorkModeChannel.postMessage(createGameWorkModeSignal({
      action,
      hostWindowId: state.credentials?.hostWindowId,
      editorInstanceId: state.credentials?.editorInstanceId,
      sessionId: state.credentials?.sessionId,
      threadId: state.credentials?.threadId,
      projectPath: state.credentials?.projectPath,
    }));
    return true;
  } catch {
    state.gameWorkModeHostConnected = false;
    state.gameWorkModeHostActive = false;
    renderGameWorkMode();
    return false;
  }
}

function scheduleGameWorkModeHeartbeat() {
  clearTimeout(state.gameWorkModeHeartbeatTimer);
  state.gameWorkModeHeartbeatTimer = null;
  if (!state.gameWorkModeEnabled || !state.gameWorkModeChannel) return;
  state.gameWorkModeHeartbeatTimer = setTimeout(() => {
    state.gameWorkModeHeartbeatTimer = null;
    sendGameWorkModeSignal("heartbeat");
    scheduleGameWorkModeHeartbeat();
  }, GAME_WORK_MODE_HEARTBEAT_MS);
}

function handleGameWorkModeAck(event) {
  const ack = event?.data;
  if (ack?.type !== GAME_WORK_MODE_ACK_TYPE
    || ack.hostWindowId !== state.credentials?.hostWindowId
    || ack.editorInstanceId !== state.credentials?.editorInstanceId
    || ack.sessionId !== state.credentials?.sessionId
    || ack.accepted !== true
    || ack.action === "disable"
    || !state.gameWorkModeEnabled) return;
  clearTimeout(state.gameWorkModeAckTimer);
  state.gameWorkModeAckTimer = null;
  state.gameWorkModeHostConnected = true;
  state.gameWorkModeHostActive = ack.active === true;
  renderGameWorkMode();
}

function handleGameWorkModeCommand(event) {
  const command = parseGameWorkModeCommand(event?.data, {
    hostWindowId: state.credentials?.hostWindowId,
    editorInstanceId: state.credentials?.editorInstanceId,
    sessionId: state.credentials?.sessionId,
    threadId: state.credentials?.threadId,
    projectPath: state.credentials?.projectPath,
  });
  if (!command || !gameWorkModeAvailable()) return;
  const enable = command.action === "enable";
  if (state.gameWorkModeEnabled === enable) {
    sendGameWorkModeSignal(enable ? "heartbeat" : "disable");
    return;
  }
  elements.gameWorkModeToggle.checked = enable;
  toggleGameWorkMode();
}

function shutdownGameWorkMode() {
  if (!state.gameWorkModeChannel) return;
  if (state.gameWorkModeEnabled) sendGameWorkModeSignal("disable");
  state.gameWorkModeEnabled = false;
  state.gameWorkModeHostConnected = false;
  state.gameWorkModeHostActive = false;
  clearTimeout(state.gameWorkModeHeartbeatTimer);
  clearTimeout(state.gameWorkModeAckTimer);
  clearTimeout(state.conversationRequestTimer);
  state.gameWorkModeHeartbeatTimer = null;
  state.gameWorkModeAckTimer = null;
  state.conversationRequestTimer = null;
  state.conversationPendingRequests.clear();
  state.conversationSnapshot = null;
  state.gameWorkModeChannel.close();
  state.gameWorkModeChannel = null;
  renderGameWorkMode();
}

function renderGameWorkMode() {
  const hasBinding = Boolean(state.credentials?.hostWindowId
    && state.credentials?.threadId
    && state.credentials?.projectPath);
  const supported = typeof BroadcastChannel === "function";
  const available = gameWorkModeAvailable();
  elements.gameWorkModeToggle.disabled = !available;
  elements.gameWorkModeToggle.checked = available && state.gameWorkModeEnabled;
  elements.gameWorkModeControl.dataset.enabled = String(available && state.gameWorkModeEnabled);
  let status = "关闭";
  if (!hasBinding) status = "未绑定对话";
  else if (!supported) status = "浏览器不支持";
  else if (!available) status = "连接不可用";
  else if (state.gameWorkModeEnabled && state.gameWorkModeHostConnected) {
    status = state.gameWorkModeHostActive ? "已生效" : "等待绑定对话";
  } else if (state.gameWorkModeEnabled) {
    status = state.gameWorkModeAckTimer ? "正在连接" : "等待主界面";
  }
  elements.gameWorkModeState.textContent = status;
  elements.gameWorkModeControl.title = !hasBinding
    ? "请从 Codex 对话打开这张地图"
    : "仅为绑定的 Codex 对话隔离重复游戏图片；普通对话不受影响";
}

function mapAiCurrentContext() {
  return {
    ...currentAiPatchContext(),
    mapSessionId: state.session?.id,
    editorInstanceId: state.credentials?.editorInstanceId,
    collaborationPolicyRevision: Number(state.mapAiCollaborationPolicy?.revision || 0),
  };
}

function readStoredMapAiLease() {
  try {
    const value = JSON.parse(sessionStorage.getItem(MAP_AI_LEASE_STORAGE_KEY) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.sessionId !== state.credentials?.sessionId
      || value.editorInstanceId !== state.credentials?.editorInstanceId
      || value.threadId !== state.credentials?.threadId
      || !value.leaseId
      || Number(value.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(MAP_AI_LEASE_STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(MAP_AI_LEASE_STORAGE_KEY);
    return null;
  }
}

function persistMapAiLease(lease) {
  const safe = {
    sessionId: state.credentials.sessionId,
    editorInstanceId: state.credentials.editorInstanceId,
    threadId: state.credentials.threadId,
    leaseId: lease.leaseId,
    mapSessionId: lease.mapSessionId,
    mapVersion: lease.mapVersion,
    editorStateId: lease.editorStateId,
    expiresAt: lease.expiresAt,
  };
  sessionStorage.setItem(MAP_AI_LEASE_STORAGE_KEY, JSON.stringify(safe));
}

function clearStoredMapAiLease() {
  sessionStorage.removeItem(MAP_AI_LEASE_STORAGE_KEY);
}

function setMapAiLease(lease, { persist = true } = {}) {
  if (!lease?.leaseId || lease.threadId !== state.credentials?.threadId
    || lease.mapSessionId !== state.session?.id
    || lease.editorInstanceId !== state.credentials?.editorInstanceId
    || lease.mapVersion !== state.session?.version
    || Number(lease.editorStateId) !== state.editor?.headStateId) {
    throw new Error("地图 AI 授权与当前地图窗口状态不匹配");
  }
  state.mapAiLease = Object.freeze({ ...lease });
  state.mapAiProposalClient = createMapAiProposalClient({
    sessionId: state.session.id,
    editorInstanceId: state.credentials.editorInstanceId,
    leaseId: lease.leaseId,
    editorStateId: lease.editorStateId,
  });
  state.mapAiProposalClient.setCollaborationPolicyRevision?.(Number(state.mapAiCollaborationPolicy?.revision || 0));
  if (persist) persistMapAiLease(lease);
  renderMapAiConnection();
}

function mapAiLeaseMatchesCurrentState() {
  const lease = state.mapAiLease;
  return Boolean(lease
    && lease.mapSessionId === state.session?.id
    && lease.mapVersion === state.session?.version
    && Number(lease.editorStateId) === state.editor?.headStateId
    && Number(lease.expiresAt) > Date.now());
}

async function initializeMapAiIntegration() {
  try {
    state.mapAiProposalAdapter = createMapAiProposalPatchAdapter({
      prepare: (document, patch, options) => state.aiProposalPatchWorkerClient.prepare(document, patch, options),
    });
    const response = await fetch("/api/account/map-ai", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      state.mapAiToolsEnabled = data?.mapAiToolsEnabled === true;
    }
  } catch {
    state.mapAiToolsEnabled = false;
  }
  state.mapAiToolsLoaded = true;
  await loadMapAiCollaborationPolicy({ silent: true });
  if (!state.mapAiToolsEnabled) clearStoredMapAiLease();
  const autoConnectRequested = state.mapAiAutoConnectRequested;
  state.mapAiAutoConnectRequested = false;
  const stored = readStoredMapAiLease();
  if (stored) {
    try {
      setMapAiLease(stored, { persist: false });
      await loadMapAiProposals({ silent: true });
    } catch {
      state.mapAiLease = null;
      state.mapAiProposalClient = null;
      clearStoredMapAiLease();
    }
  } else if (autoConnectRequested && state.mapAiToolsEnabled
    && state.credentials?.threadId && state.session?.writable) {
    await connectMapAiLease();
  }
  if (state.mapAiLease) scheduleMapAiProposalPolling();
  renderMapAiConnection();
  await loadMapAiManagedAuthorizations({ silent: true });
}

async function loadMapAiCollaborationPolicy({ silent = false } = {}) {
  if (!state.session?.id) return;
  try {
    const response = await mapFetch(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/collaboration-policy`);
    state.mapAiCollaborationPolicy = response?.policy || null;
    state.mapAiProposalClient?.setCollaborationPolicyRevision?.(Number(state.mapAiCollaborationPolicy?.revision || 0));
    renderMapAiCollaborationPolicy();
  } catch (error) {
    if (!silent) setMapAiCollaborationPolicyMessage(`读取协同策略失败：${error.message}`, "error");
  }
}

function parsePolicyTargetText(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("协同目标必须是 JSON 数组");
  return parsed;
}

function setMapAiCollaborationPolicyMessage(message, status = "ready") {
  if (!elements.mapAiCollaborationPolicyState) return;
  elements.mapAiCollaborationPolicyState.textContent = message || "";
  elements.mapAiCollaborationPolicyState.dataset.status = message ? status : "";
}

function renderMapAiCollaborationPolicy() {
  const policy = state.mapAiCollaborationPolicy;
  if (!policy) return;
  elements.mapAiCollaborationPolicyRevision.textContent = `策略 ${Number(policy.revision || 0)}`;
  elements.mapAiHumanOwnedTargets.value = JSON.stringify(policy.humanOwned || [], null, 2);
  elements.mapAiAiOwnedTargets.value = JSON.stringify(policy.aiOwned || [], null, 2);
  elements.mapAiSharedTargets.value = JSON.stringify(policy.shared || [], null, 2);
  elements.mapAiLockedTargets.value = JSON.stringify(policy.locked || [], null, 2);
  if (state.viewer) renderLayerList();
}

function appendCollaborationQuickTarget(ownership) {
  if (!["human", "locked"].includes(ownership)) return;
  if (!state.session?.relativePath || !state.editor?.layerById(state.activeLayerId)) {
    setMapAiCollaborationPolicyMessage("当前没有可标记的图层", "error");
    return;
  }
  const targets = [];
  const selection = state.selection;
  const activeLayer = state.editor.layerById(state.activeLayerId);
  const mapPath = state.session.relativePath;
  if (selection?.kind === "tile-cells"
    && selection.layerId === state.activeLayerId
    && Number.isSafeInteger(selection.startColumn)
    && Number.isSafeInteger(selection.startRow)
    && Number.isSafeInteger(selection.endColumn)
    && Number.isSafeInteger(selection.endRow)) {
    targets.push({
      kind: "region",
      mapPath,
      layerId: state.activeLayerId,
      rect: {
        x: selection.startColumn,
        y: selection.startRow,
        width: selection.endColumn - selection.startColumn + 1,
        height: selection.endRow - selection.startRow + 1,
      },
    });
  } else if (activeLayer.type === "objectgroup" && selectedObjects().length) {
    for (const object of selectedObjects()) targets.push({
      kind: "object", mapPath, layerId: state.activeLayerId, objectId: object.id,
    });
  } else if (selection?.kind === "image-layers" && Array.isArray(selection.layerIds) && selection.layerIds.length) {
    for (const layerId of selection.layerIds) targets.push({ kind: "layer", mapPath, layerId });
  } else {
    targets.push({ kind: "layer", mapPath, layerId: state.activeLayerId });
  }
  const textarea = ownership === "human" ? elements.mapAiHumanOwnedTargets : elements.mapAiLockedTargets;
  let existing;
  try {
    existing = parsePolicyTargetText(textarea.value);
  } catch {
    setMapAiCollaborationPolicyMessage("当前目标 JSON 无效，请先修正后再使用快捷标记", "error");
    textarea.focus();
    return;
  }
  const seen = new Set(existing.map((target) => JSON.stringify(target)));
  for (const target of targets) {
    const key = JSON.stringify(target);
    if (!seen.has(key)) {
      existing.push(target);
      seen.add(key);
    }
  }
  textarea.value = JSON.stringify(existing, null, 2);
  setMapAiCollaborationPolicyMessage(
    `已加入 ${targets.length} 个${ownership === "human" ? "人工" : "锁定"}目标；点击“保存协同策略”后生效`,
    "ready",
  );
}

async function saveMapAiCollaborationPolicy() {
  if (!state.session?.writable || !state.session?.id) return;
  try {
    const response = await mapMutation(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/collaboration-policy`, {
      method: "PUT", action: "map-collaboration-policy-save", json: {
        expectedRevision: Number(state.mapAiCollaborationPolicy?.revision || 0),
        humanOwned: parsePolicyTargetText(elements.mapAiHumanOwnedTargets.value).map((target) => ({ ...target, ownership: "human" })),
        aiOwned: parsePolicyTargetText(elements.mapAiAiOwnedTargets.value).map((target) => ({ ...target, ownership: "ai" })),
        shared: parsePolicyTargetText(elements.mapAiSharedTargets.value).map((target) => ({ ...target, ownership: "shared" })),
        locked: parsePolicyTargetText(elements.mapAiLockedTargets.value).map((target) => ({ ...target, ownership: "locked" })),
      },
    });
    state.mapAiCollaborationPolicy = response?.policy || state.mapAiCollaborationPolicy;
    state.mapAiProposalPrepared.clear();
    state.mapAiProposals = [];
    if (state.mapAiLease) await loadMapAiProposals({ silent: true });
    renderMapAiCollaborationPolicy();
    setMapAiCollaborationPolicyMessage("协同策略已保存；只影响新建的 AI 托管任务和保存事务", "ready");
  } catch (error) {
    if (Number(error.status) === 409) {
      // Another editor window may have advanced the policy revision. Reload
      // the authoritative server snapshot instead of leaving stale JSON in
      // this form; never auto-merge or auto-retry a policy change.
      state.mapAiProposalPrepared.clear();
      state.mapAiProposals = [];
      await loadMapAiCollaborationPolicy({ silent: true });
      if (state.mapAiLease) await loadMapAiProposals({ silent: true });
      setMapAiCollaborationPolicyMessage("协同策略已在其他窗口变化，已重新读取最新版本；请确认后再次编辑", "error");
    } else {
      setMapAiCollaborationPolicyMessage(`保存失败：${error.message}`, "error");
    }
  }
}

async function connectMapAiLease() {
  if (state.mapAiConnectionLoading || !state.session?.writable) return;
  if (!state.credentials?.threadId) {
    setMapAiConnectionMessage("当前编辑器没有绑定对话，请从对话中的工程文件管理器重新打开地图", "error");
    return;
  }
  if (!state.mapAiToolsEnabled) {
    setMapAiConnectionMessage("地图 AI 工具开关当前为关闭；请先在账号设置中显式启用", "error");
    return;
  }
  state.mapAiConnectionLoading = true;
  setMapAiConnectionMessage("");
  renderMapAiConnection();
  try {
    const result = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.session.id)}/ai-leases`,
      {
        method: "POST",
        action: "map-ai-lease-grant",
        json: {
          threadId: state.credentials.threadId,
          allowedOps: ["get_map_context", "propose_tiled_patch"],
          editorStateId: state.editor.headStateId,
        },
      },
    );
    setMapAiLease(result.lease);
    await loadMapAiProposals({ silent: true });
    scheduleMapAiProposalPolling();
    setMapAiConnectionMessage("已连接当前对话；AI 提案只会进入本窗口收件箱", "ready");
  } catch (error) {
    setMapAiConnectionMessage(error.message, "error");
  } finally {
    state.mapAiConnectionLoading = false;
    renderMapAiConnection();
  }
}

async function disconnectMapAiLease() {
  const lease = state.mapAiLease;
  if (!lease || state.mapAiConnectionLoading) return;
  state.mapAiConnectionLoading = true;
  setMapAiConnectionMessage("");
  renderMapAiConnection();
  try {
    const result = await revokeMapAiLeaseWithUiRetry(lease);
    if (result.revoked) {
      clearMapAiLeaseLocal();
      setMapAiConnectionMessage(result.stale
        ? "地图 AI 授权已失效，已清除本窗口凭据"
        : "已断开当前对话，未读取或删除历史对话内容", "ready");
    } else {
      const detail = result.error?.message || "地图 AI 授权撤销请求失败";
      setMapAiConnectionMessage(
        `地图 AI 授权撤销已尝试 ${result.attempts} 次仍失败：${detail}；授权仍保留，可再次点击断开`,
        "error",
      );
    }
  } finally {
    state.mapAiConnectionLoading = false;
    renderMapAiConnection();
  }
}

function clearMapAiLeaseLocal() {
  stopMapAiProposalPolling();
  state.mapAiLease = null;
  state.mapAiProposalClient = null;
  state.mapAiProposals = [];
  state.mapAiProposalPrepared.clear();
  state.viewer?.setAiPatchPreview(null);
  state.mapAiUnseenProposalCount = 0;
  clearStoredMapAiLease();
  updateMapAiProposalIndicator();
  renderMapAiConnection();
}

const MAP_AI_MANAGED_POLICY_LABELS = Object.freeze({
  ask_each: "每条询问",
  ai_review: "AI 审查",
  full_authorization: "完全授权",
});

async function loadMapAiManagedAuthorizations({ silent = false } = {}) {
  if (!state.credentials?.projectPath || !state.session?.relativePath) return;
  if (state.mapAiManagedAuthorizationLoading) return;
  state.mapAiManagedAuthorizationLoading = true;
  renderMapAiManagedAuthorizations();
  try {
    const query = new URLSearchParams({ limit: "100" });
    const response = await mapFetch(`/api/map-ai/managed-authorizations?${query}`);
    state.mapAiManagedAuthorizations = Array.isArray(response?.authorizations)
      ? response.authorizations.filter((authorization) => authorization.projectWide === true || authorization.mapPaths?.includes(state.session.relativePath))
      : [];
    if (!silent) setMapAiManagedAuthorizationMessage(`已读取 ${state.mapAiManagedAuthorizations.length} 个托管授权`, "ready");
  } catch (error) {
    state.mapAiManagedAuthorizations = [];
    if (!silent) setMapAiManagedAuthorizationMessage(`读取托管授权失败：${error.message}`, "error");
  } finally {
    state.mapAiManagedAuthorizationLoading = false;
    renderMapAiManagedAuthorizations();
  }
}

function setMapAiManagedAuthorizationMessage(message, status = "ready") {
  elements.mapAiManagedAuthorizationState.textContent = message || "";
  elements.mapAiManagedAuthorizationState.dataset.status = message ? status : "";
}

function parseManagedProtectedTargets(value) {
  const mapPath = state.session?.relativePath;
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(":");
    const kind = separator < 0 ? "file" : entry.slice(0, separator).trim().toLowerCase();
    const target = separator < 0 ? entry : entry.slice(separator + 1).trim();
    if (kind === "semantic") return { kind, mapPath, role: target };
    if (kind === "layer") {
      const layerId = Number(target);
      if (!Number.isSafeInteger(layerId) || layerId <= 0) throw new Error(`保护图层必须是正整数：${target}`);
      return { kind, mapPath, layerId };
    }
    if (kind === "object") {
      const [layer, object] = target.split("/").map(Number);
      if (!Number.isSafeInteger(layer) || !Number.isSafeInteger(object) || layer <= 0 || object <= 0) throw new Error(`保护对象格式应为 object:图层ID/对象ID：${target}`);
      return { kind, mapPath, layerId: layer, objectId: object };
    }
    if (kind === "file") return target === mapPath ? { kind: "file", path: mapPath } : { kind: "file", path: target };
    throw new Error(`不支持的保护目标类型：${kind}`);
  });
}

function managedAuthorizationAllowedOps() {
  const operations = ["inspect_project", "get_map_context", "read_map_region", "validate_map", "request_map_preview", "list_map_revisions"];
  if (elements.mapAiManagedAllowPropose.checked) operations.push("propose_tiled_patch");
  if (elements.mapAiManagedAllowApply.checked) operations.push("apply_tiled_patch", "restore_map_revision");
  return operations;
}

async function createMapAiManagedAuthorization() {
  if (state.mapAiManagedAuthorizationCreating) return;
  if (!state.credentials?.projectPath) {
    setMapAiManagedAuthorizationMessage("当前工程尚未连接", "error");
    return;
  }
  if (!elements.mapAiManagedConfirm.checked) {
    setMapAiManagedAuthorizationMessage("请先确认当前工程协作范围", "error");
    return;
  }
  state.mapAiManagedAuthorizationCreating = true;
  elements.createMapAiManagedAuthorizationButton.disabled = true;
  setMapAiManagedAuthorizationMessage("正在创建托管授权…", "busy");
  try {
    const body = {
      // Legacy mapVersion: state.session.version and userConfirmed: true
      // are retained only for compatibility with old map-scoped records.
      project: state.credentials.projectPath,
      projectWide: true,
      scopeKind: "project",
      mode: elements.mapAiManagedMode?.value === "apply" ? "apply" : "suggest",
      confirmed: true,
      clientOperationId: crypto.randomUUID(),
    };
    const result = await mapMutation("/api/map-ai/managed-authorizations", {
      method: "POST", action: "map-ai-managed-authorization-create", json: body,
    });
    await loadMapAiManagedAuthorizations({ silent: true });
    elements.mapAiManagedConfirm.checked = false;
    const mode = elements.mapAiManagedMode?.value === "apply" ? "apply" : "suggest";
    setMapAiManagedAuthorizationMessage(result.created
      ? (mode === "apply" ? "整个工程自动应用授权已创建；安全规则和版本校验仍然生效" : "整个工程建议授权已创建；AI 只提交可审阅方案")
      : "已有相同范围的托管授权", "ready");
  } catch (error) {
    setMapAiManagedAuthorizationMessage(`创建失败：${error.message}`, "error");
  } finally {
    state.mapAiManagedAuthorizationCreating = false;
    renderMapAiManagedAuthorizations();
  }
}

function revokeMapAiManagedAuthorization(authorization) {
  if (!authorization?.id || state.mapAiManagedAuthorizationCreating) return;
  state.pendingManagedAuthorizationRevoke = authorization;
  elements.managedAuthorizationConfirmDetail.textContent = `撤销 ${MAP_AI_MANAGED_POLICY_LABELS[authorization.approvalPolicy] || "当前"} 授权后，不能再用此授权创建托管任务，已运行任务也会停止后续批次。地图文件不会被删除或回滚。`;
  elements.managedAuthorizationConfirmState.textContent = "这是独立托管授权，不会撤销当前编辑器协作 lease。";
  elements.managedAuthorizationConfirmState.dataset.status = "ready";
  elements.confirmManagedAuthorizationRevokeButton.disabled = false;
  if (!elements.managedAuthorizationConfirmDialog.open) elements.managedAuthorizationConfirmDialog.showModal();
}

async function confirmRevokeMapAiManagedAuthorization() {
  const authorization = state.pendingManagedAuthorizationRevoke;
  if (!authorization?.id) return;
  elements.confirmManagedAuthorizationRevokeButton.disabled = true;
  elements.managedAuthorizationConfirmState.textContent = "正在撤销…";
  elements.managedAuthorizationConfirmState.dataset.status = "busy";
  try {
    await mapMutation(`/api/map-ai/managed-authorizations/${encodeURIComponent(authorization.id)}`, {
      method: "DELETE", action: "map-ai-managed-authorization-revoke", json: { reason: "用户在地图编辑器中撤销" },
    });
    await loadMapAiManagedAuthorizations({ silent: true });
    setMapAiManagedAuthorizationMessage("托管授权已撤销", "ready");
    elements.managedAuthorizationConfirmDialog.close();
  } catch (error) {
    elements.managedAuthorizationConfirmState.textContent = `撤销失败：${error.message}`;
    elements.managedAuthorizationConfirmState.dataset.status = "error";
    elements.confirmManagedAuthorizationRevokeButton.disabled = false;
  } finally {
    state.pendingManagedAuthorizationRevoke = null;
  }
}

function transferThreadCandidates() {
  const currentThreadId = state.credentials?.threadId || state.conversationSnapshot?.boundThreadId || "";
  return (Array.isArray(state.conversationSnapshot?.threads) ? state.conversationSnapshot.threads : [])
    .filter((thread) => thread?.id && thread.id !== currentThreadId);
}

function openTransferMapAiManagedAuthorization(authorization) {
  if (!authorization?.id || state.mapAiManagedAuthorizationCreating) return;
  const candidates = transferThreadCandidates();
  if (!candidates.length) {
    setMapAiManagedAuthorizationMessage("当前工程没有可转交的其他对话；请先在右侧对话中刷新或创建同工程 Thread", "error");
    return;
  }
  state.pendingManagedAuthorizationTransfer = authorization;
  elements.managedAuthorizationTransferTarget.replaceChildren(...candidates.map((thread) => {
    const option = document.createElement("option");
    option.value = thread.id;
    option.textContent = `${thread.title || "未命名对话"}${thread.status === "running" ? " · 运行中" : thread.status === "waiting" ? " · 等待中" : ""}`;
    option.title = [thread.preview, thread.model, thread.provider].filter(Boolean).join(" · ");
    return option;
  }));
  elements.managedAuthorizationTransferDetail.textContent = `当前授权属于 Thread ${authorization.threadId?.slice(0, 12) || "--"}…。转交后旧 Thread 不能再创建或继续执行此授权的任务；地图文件和批准策略保持不变。目标 Thread 必须属于同一工程。`;
  elements.managedAuthorizationTransferState.textContent = "转交会留下审计记录，并取消旧 Thread 尚未完成的托管任务。";
  elements.managedAuthorizationTransferState.dataset.status = "ready";
  elements.confirmManagedAuthorizationTransferButton.disabled = false;
  if (!elements.managedAuthorizationTransferDialog.open) elements.managedAuthorizationTransferDialog.showModal();
}

function cancelTransferMapAiManagedAuthorization() {
  state.pendingManagedAuthorizationTransfer = null;
  elements.managedAuthorizationTransferDialog.close();
}

async function confirmTransferMapAiManagedAuthorization() {
  const authorization = state.pendingManagedAuthorizationTransfer;
  const targetThreadId = elements.managedAuthorizationTransferTarget.value;
  if (!authorization?.id || !targetThreadId) return;
  elements.confirmManagedAuthorizationTransferButton.disabled = true;
  elements.managedAuthorizationTransferState.textContent = "正在转交；旧 Thread 任务会先停止…";
  elements.managedAuthorizationTransferState.dataset.status = "busy";
  try {
    await mapMutation(`/api/map-ai/managed-authorizations/${encodeURIComponent(authorization.id)}/transfer`, {
      method: "POST",
      action: "map-ai-managed-authorization-transfer",
      json: {
        targetThreadId,
        expectedThreadId: authorization.threadId,
        reason: "用户在地图编辑器中显式转交托管授权",
      },
    });
    elements.conversationThreadSelect.value = targetThreadId;
    // The host window is authoritative for Thread switching. Its eventual
    // switch-thread result refreshes the authorization list after the new
    // binding is acknowledged; do not read the old Thread in the meantime.
    // Await the request so a failed lease revoke or disconnected channel is
    // represented as a handoff that still needs manual Thread switching.
    const queued = await switchMapConversationThread();
    elements.managedAuthorizationTransferDialog.close();
    setMapAiManagedAuthorizationMessage(
      queued
        ? "托管授权已转交；正在切换到目标 Thread，旧 Thread 任务已停止，新 Thread 可在授权范围内继续"
        : "托管授权已转交，但当前窗口未能切换到目标 Thread；请在右侧对话下拉框中手动切换，旧 Thread 任务已停止",
      queued ? "ready" : "error",
    );
  } catch (error) {
    elements.managedAuthorizationTransferState.textContent = Number(error.status) === 409
      ? "转交冲突：授权已被其他操作更新，请刷新列表后重新确认"
      : `转交失败：${error.message}`;
    elements.managedAuthorizationTransferState.dataset.status = "error";
    elements.confirmManagedAuthorizationTransferButton.disabled = false;
    if (Number(error.status) === 409) await loadMapAiManagedAuthorizations({ silent: true });
  } finally {
    if (!elements.managedAuthorizationTransferDialog.open) state.pendingManagedAuthorizationTransfer = null;
  }
}

function renderMapAiManagedAuthorizations() {
  if (!elements.mapAiManagedAuthorizationList) return;
  elements.mapAiManagedThread.textContent = "工程范围";
  elements.mapAiManagedProject.textContent = state.credentials?.projectPath || "--";
  elements.mapAiManagedMapVersion.textContent = "由服务端实时校验";
  elements.refreshMapAiManagedAuthorizationsButton.disabled = state.mapAiManagedAuthorizationLoading;
  elements.createMapAiManagedAuthorizationButton.disabled = state.mapAiManagedAuthorizationCreating || !state.credentials?.projectPath;
  const fragment = document.createDocumentFragment();
  if (state.mapAiManagedAuthorizationLoading && !state.mapAiManagedAuthorizations.length) {
    const loading = document.createElement("p"); loading.className = "map-ai-managed-empty"; loading.textContent = "正在读取托管授权…"; fragment.append(loading);
  } else if (!state.mapAiManagedAuthorizations.length) {
    const empty = document.createElement("p"); empty.className = "map-ai-managed-empty"; empty.textContent = "当前工程没有托管授权"; fragment.append(empty);
  }
  for (const authorization of state.mapAiManagedAuthorizations) {
    const item = document.createElement("article"); item.className = "map-ai-managed-item";
    const heading = document.createElement("header");
    const title = document.createElement("strong"); title.textContent = MAP_AI_MANAGED_POLICY_LABELS[authorization.approvalPolicy] || authorization.approvalPolicy || "未知策略";
    const currentMapVersion = authorization.mapVersions?.[state.session?.relativePath];
    const stale = Boolean(currentMapVersion && state.session?.version && currentMapVersion !== state.session.version);
    const status = document.createElement("small"); status.textContent = Number(authorization.expiresAt) <= Date.now() || authorization.revokedReason === "托管授权已过期" ? "已过期" : authorization.revokedAt ? "已撤销" : stale ? "地图版本已变化" : "有效";
    heading.append(title, status);
    const detail = document.createElement("p");
    const ops = Array.isArray(authorization.allowedOps) ? authorization.allowedOps.join("、") : "--";
    const expires = Number(authorization.expiresAt) ? new Date(authorization.expiresAt).toLocaleString("zh-CN") : "--";
    detail.textContent = `${authorization.projectWide ? "整个工程（地图、World、瓦片集、角色和资源）" : authorization.mapPaths?.join("、") || state.session.relativePath} · ${authorization.projectWide ? (authorization.allowedOps?.includes("apply_tiled_resource_patch") ? "自动应用" : "建议模式") : `操作：${ops}`} · 到期：${expires}`;
    const actions = document.createElement("div"); actions.className = "map-ai-managed-item-actions";
    const audit = document.createElement("button"); audit.type = "button"; audit.className = "secondary-button"; audit.textContent = "审计"; audit.addEventListener("click", () => void showManagedAuthorizationAudit(authorization));
    const transfer = document.createElement("button"); transfer.type = "button"; transfer.className = "secondary-button"; transfer.textContent = "转交"; transfer.disabled = authorization.projectWide === true || Boolean(authorization.revokedAt) || Number(authorization.expiresAt) <= Date.now(); transfer.addEventListener("click", () => openTransferMapAiManagedAuthorization(authorization));
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "secondary-button is-danger"; revoke.textContent = "撤销"; revoke.disabled = Boolean(authorization.revokedAt) || Number(authorization.expiresAt) <= Date.now(); revoke.addEventListener("click", () => void revokeMapAiManagedAuthorization(authorization));
    actions.append(audit, transfer, revoke); item.append(heading, detail, actions); fragment.append(item);
  }
  elements.mapAiManagedAuthorizationList.replaceChildren(fragment);
}

async function showManagedAuthorizationAudit(authorization) {
  if (!authorization?.id || !elements.managedAuthorizationAuditDialog) return;
  elements.managedAuthorizationAuditTitle.textContent = "托管授权审计";
  elements.managedAuthorizationAuditSummary.textContent = `${MAP_AI_MANAGED_POLICY_LABELS[authorization.approvalPolicy] || authorization.approvalPolicy || "未知策略"} · ${authorization.mapPaths?.join("、") || "当前地图"}`;
  elements.managedAuthorizationAuditList.replaceChildren();
  const loading = document.createElement("li"); loading.textContent = "正在读取审计记录…"; elements.managedAuthorizationAuditList.append(loading);
  if (!elements.managedAuthorizationAuditDialog.open) elements.managedAuthorizationAuditDialog.showModal();
  try {
    const result = await mapFetch(`/api/map-ai/managed-authorizations/${encodeURIComponent(authorization.id)}/audit`);
    const events = Array.isArray(result?.audit) ? result.audit : [];
    elements.managedAuthorizationAuditList.replaceChildren(...(events.length ? events : [{ type: "unknown", at: null, reason: "暂无审计记录" }]).map((event) => {
      const item = document.createElement("li");
      const when = Number(event.at) ? new Date(event.at).toLocaleString("zh-CN") : "--";
      item.textContent = `${when} · ${event.type}${event.reason ? ` · ${event.reason}` : ""}`;
      return item;
    }));
  } catch (error) {
    elements.managedAuthorizationAuditList.replaceChildren();
    const item = document.createElement("li"); item.textContent = `读取审计失败：${error.message}`; elements.managedAuthorizationAuditList.append(item);
  }
}

function setMapAiConnectionMessage(message, status = "ready") {
  state.mapAiConnectionMessage = message || "";
  state.mapAiConnectionMessageStatus = status;
  if (!elements.mapAiConnectionState) return;
  elements.mapAiConnectionState.textContent = state.mapAiConnectionMessage;
  elements.mapAiConnectionState.dataset.status = state.mapAiConnectionMessage ? status : "";
}

async function loadMapAiProposals({ silent = false, announceNew = false } = {}) {
  if (!state.mapAiProposalClient || !mapAiLeaseMatchesCurrentState() || state.mapAiProposalLoading) return;
  state.mapAiProposalLoading = true;
  renderMapAiConnection();
  try {
    const previous = state.mapAiProposals;
    const proposals = await state.mapAiProposalClient.list({ limit: 100 });
    reconcileMapAiProposalPreviews(previous, proposals);
    state.mapAiProposals = proposals;
    const previousIds = new Set(previous.map((proposal) => proposal.id));
    const newCount = proposals.filter((proposal) => !previousIds.has(proposal.id)).length;
    if (announceNew && newCount > 0) {
      if (!elements.aiPatchDialog.open) state.mapAiUnseenProposalCount += newCount;
      setMapAiConnectionMessage(`收到 ${newCount} 个新地图 AI 提案；请预览后决定是否应用`, "ready");
      updateMapAiProposalIndicator();
    }
    if (!silent) setMapAiConnectionMessage(`已读取 ${state.mapAiProposals.length} 个地图 AI 提案`, "ready");
  } catch (error) {
    if ([403, 404, 409].includes(Number(error.status))) {
      clearMapAiLeaseLocal();
      setMapAiConnectionMessage("地图 AI 授权已失效，请重新连接当前对话", "error");
    } else if (!silent) setMapAiConnectionMessage(error.message, "error");
  } finally {
    state.mapAiProposalLoading = false;
    renderMapAiConnection();
  }
}

function reconcileMapAiProposalPreviews(previous, next) {
  const previousById = new Map(previous.map((proposal) => [proposal.id, proposal]));
  const nextById = new Map(next.map((proposal) => [proposal.id, proposal]));
  for (const proposalId of state.mapAiProposalPrepared.keys()) {
    const before = previousById.get(proposalId);
    const after = nextById.get(proposalId);
    if (!before || !after || before.status !== after.status || before.updatedAt !== after.updatedAt) {
      state.mapAiProposalPrepared.delete(proposalId);
    }
  }
}

function scheduleMapAiProposalPolling({ immediate = false } = {}) {
  stopMapAiProposalPolling();
  if (document.visibilityState !== "visible"
    || state.mapSessionCloseStarted
    || !state.mapAiProposalClient
    || !mapAiLeaseMatchesCurrentState()) return;
  state.mapAiProposalPollTimer = setTimeout(async () => {
    state.mapAiProposalPollTimer = null;
    await loadMapAiProposals({ silent: true, announceNew: true });
    scheduleMapAiProposalPolling();
  }, immediate ? 0 : MAP_AI_PROPOSAL_POLL_MS);
}

function stopMapAiProposalPolling() {
  clearTimeout(state.mapAiProposalPollTimer);
  state.mapAiProposalPollTimer = null;
}

function updateMapAiProposalIndicator() {
  const count = Math.min(99, state.mapAiUnseenProposalCount);
  if (count > 0) elements.aiEditButton.dataset.proposalCount = String(count);
  else delete elements.aiEditButton.dataset.proposalCount;
  const label = count > 0 ? `AI 地图补丁 · ${count} 个新提案` : "AI 地图补丁";
  elements.aiEditButton.title = label;
  elements.aiEditButton.setAttribute("aria-label", label);
}

function currentMapAiProposalCompatibility(proposal) {
  if (!state.mapAiLease || !mapAiLeaseMatchesCurrentState()) {
    return { matches: false, message: "地图 AI 授权与当前编辑状态不匹配，请重新连接" };
  }
  return mapAiProposalCompatibility(proposal, mapAiCurrentContext());
}

function renderMapAiConnection() {
  if (!elements.mapAiConnectionState) return;
  const connected = Boolean(state.mapAiLease);
  const compatible = mapAiLeaseMatchesCurrentState();
  elements.mapAiThreadState.textContent = state.credentials?.threadId
    ? `当前对话：${state.credentials.threadId.slice(0, 12)}…`
    : "未绑定当前对话";
  elements.connectMapAiButton.disabled = state.mapAiConnectionLoading
    || state.mapAiLeaseInvalidationPending
    || !state.session?.writable
    || !state.mapAiToolsLoaded
    || !state.mapAiToolsEnabled
    || !state.credentials?.threadId
    || connected;
  elements.disconnectMapAiButton.disabled = state.mapAiConnectionLoading
    || !connected
    || state.mapAiAppliedPendingAck.size > 0;
  elements.refreshMapAiProposalsButton.disabled = state.mapAiProposalLoading || !compatible;
  let message = state.mapAiConnectionMessage;
  let status = state.mapAiConnectionMessageStatus;
  if (state.mapAiConnectionLoading && !message) [message, status] = ["正在更新地图 AI 授权…", "busy"];
  else if (!state.mapAiToolsLoaded) [message, status] = ["正在读取账号地图 AI 开关…", "busy"];
  else if (!state.credentials?.threadId) [message, status] = ["未绑定对话；地图 AI 收件箱保持关闭", "ready"];
  else if (!state.mapAiToolsEnabled) [message, status] = ["账号地图 AI 工具开关已关闭（默认关闭）", "ready"];
  else if (!connected && !message) [message, status] = ["未连接当前对话；点击连接后才读取提案", "ready"];
  else if (connected && !compatible && state.mapAiAppliedPendingAck.size) {
    [message, status] = ["补丁已进入本地撤销栈，正在等待服务端确认；地图尚未保存", "busy"];
  }
  else if (connected && !compatible && !state.mapAiAppliedPendingAck.size) {
    [message, status] = ["地图版本或编辑状态已变化，请重新连接当前对话", "error"];
  } else if (connected && compatible && !message) {
    [message, status] = ["已连接当前对话；提案不会自动应用或保存", "ready"];
  }
  elements.mapAiConnectionState.textContent = message;
  elements.mapAiConnectionState.dataset.status = message ? status : "";
  renderMapAiProposalList();
}

function renderMapAiProposalList() {
  if (!elements.mapAiProposalList) return;
  const fragment = document.createDocumentFragment();
  if (!state.mapAiProposals.length) {
    const empty = document.createElement("p");
    empty.className = "map-ai-proposals-empty";
    empty.textContent = state.mapAiLease ? "当前没有待处理的地图 AI 提案" : "连接对话后，这里才会显示提案";
    fragment.append(empty);
  }
  for (const proposal of state.mapAiProposals) {
    const pendingAck = state.mapAiAppliedPendingAck.get(proposal.id);
    const item = document.createElement("article");
    item.className = "map-ai-proposal-item";
    item.dataset.proposalId = proposal.id;
    const heading = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = proposal.source?.label || `地图补丁 ${proposal.id.slice(0, 8)}`;
    const status = document.createElement("span");
    status.textContent = pendingAck ? "待确认" : proposal.status === "pending" ? "待处理" : proposal.status === "applied" ? "已应用" : "已丢弃";
    heading.append(title, status);
    const detail = document.createElement("p");
    detail.textContent = `${proposal.patch?.summary || "结构化 Tiled 补丁"} · ${proposal.patchBytes} B`;
    const stateText = document.createElement("small");
    const compatibility = currentMapAiProposalCompatibility(proposal);
    stateText.textContent = pendingAck ? "补丁已进入本地撤销栈，但服务端确认尚未完成" : compatibility.message || "";
    stateText.dataset.status = pendingAck || compatibility.matches ? "ready" : "error";
    const actions = document.createElement("div");
    actions.className = "map-ai-proposal-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "secondary-button";
    preview.textContent = "预览";
    preview.disabled = Boolean(pendingAck) || !compatibility.matches || state.mapAiProposalLoading;
    preview.addEventListener("click", () => void previewMapAiProposal(proposal));
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary-button";
    apply.textContent = "应用到撤销栈";
    apply.disabled = Boolean(pendingAck) || state.mapAiProposalLoading || !compatibility.matches || !state.mapAiProposalPrepared.has(proposal.id);
    apply.addEventListener("click", () => void applyMapAiProposal(proposal));
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "secondary-button is-danger";
    discard.textContent = "丢弃";
    discard.disabled = Boolean(pendingAck) || !compatibility.matches || state.mapAiProposalLoading;
    discard.addEventListener("click", () => void discardMapAiProposal(proposal));
    actions.append(preview, apply, discard);
    if (pendingAck) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "primary-button";
      retry.textContent = "重试确认";
      retry.disabled = state.mapAiProposalLoading;
      retry.addEventListener("click", () => void acknowledgeAppliedMapAiProposal(proposal));
      actions.append(retry);
    }
    item.append(heading, detail, stateText, actions);
    fragment.append(item);
  }
  elements.mapAiProposalList.replaceChildren(fragment);
  renderCollaborationProposalTray();
}

async function previewMapAiProposal(proposal) {
  const compatibility = currentMapAiProposalCompatibility(proposal);
  if (!compatibility.matches || !state.mapAiProposalAdapter) return;
  try {
    state.mapAiProposalLoading = true;
    renderMapAiProposalList();
    const prepared = await state.mapAiProposalAdapter.previewProposal({
      proposal,
      document: state.editor.document,
      context: mapAiCurrentContext(),
      loadedTilesets: state.viewer?.tilesets || [],
    });
    state.mapAiProposalPrepared.set(proposal.id, prepared);
    state.viewer?.setAiPatchPreview(prepared.normalizedPatch);
    setMapAiProposalMessage(`提案 ${proposal.id.slice(0, 8)} 已通过预览；确认后才会进入撤销栈`, "ready");
    renderMapAiProposalList();
  } catch (error) {
    setMapAiProposalMessage(error.message, "error");
  } finally {
    state.mapAiProposalLoading = false;
    renderMapAiProposalList();
  }
}

async function applyMapAiProposal(proposal) {
  const compatibility = currentMapAiProposalCompatibility(proposal);
  if (!compatibility.matches || !state.mapAiProposalAdapter || !state.mapAiProposalClient) return;
  const prepared = state.mapAiProposalPrepared.get(proposal.id);
  if (!prepared) {
    setMapAiProposalMessage("请先预览提案，再应用到撤销栈", "error");
    return;
  }
  const previousEditorStateId = state.editor.headStateId;
  state.mapAiProposalLoading = true;
  renderMapAiProposalList();
  try {
    const result = await state.mapAiProposalAdapter.applyProposal({
      prepared,
      editor: state.editor,
      context: mapAiCurrentContext(),
      loadedTilesets: state.viewer?.tilesets || [],
    });
    state.viewer?.setAiPatchPreview(null);
    state.mapAiAppliedPendingAck.set(proposal.id, { previousEditorStateId, changed: result.changed });
    await acknowledgeAppliedMapAiProposal(proposal, { manageLoading: false });
  } catch (error) {
    state.mapAiProposalClient?.setEditorState(state.editor.headStateId);
    if (state.mapAiAppliedPendingAck.has(proposal.id)) {
      setMapAiProposalMessage(`补丁已应用到本地且尚未保存，但服务端确认失败：${error.message}。请勿重复应用，可重试确认`, "error");
    } else {
      setMapAiProposalMessage(error.message, "error");
    }
  } finally {
    state.mapAiProposalLoading = false;
    renderMapAiConnection();
  }
}

async function acknowledgeAppliedMapAiProposal(proposal, { manageLoading = true } = {}) {
  const pending = state.mapAiAppliedPendingAck.get(proposal.id);
  if (!pending || !state.mapAiProposalClient) return;
  if (manageLoading) {
    state.mapAiProposalLoading = true;
    renderMapAiProposalList();
  }
  try {
    // The proposal is bound to the pre-apply editor state. The patch itself is
    // already a normal local undo entry; this request only acknowledges it.
    state.mapAiProposalClient.setEditorState(pending.previousEditorStateId);
    await state.mapAiProposalClient.acknowledge(proposal.id);
    const lease = state.mapAiLease;
    state.mapAiAppliedPendingAck.delete(proposal.id);
    state.mapAiProposalPrepared.delete(proposal.id);
    const revokeResult = lease ? await revokeMapAiLeaseWithUiRetry(lease) : null;
    clearMapAiLeaseLocal();
    if (revokeResult && !revokeResult.revoked) {
      setMapAiConnectionMessage(
        `提案已确认，本窗口凭据已清除，但服务端授权撤销在 ${revokeResult.attempts} 次尝试后仍失败；短期授权会自动过期`,
        "error",
      );
    } else if (revokeResult?.revoked) {
      setMapAiConnectionMessage("提案已确认；旧地图 AI 授权已撤销，如需继续协作请重新连接", "ready");
    }
    setMapAiProposalMessage(pending.changed
      ? "提案已应用到撤销栈，尚未保存地图；如需继续协作请重新连接"
      : "提案已确认，但没有产生地图变化；如需继续协作请重新连接", "ready");
  } catch (error) {
    if (!manageLoading) throw error;
    setMapAiProposalMessage(`补丁仍在本地撤销栈且尚未保存，确认重试失败：${error.message}`, "error");
  } finally {
    state.mapAiProposalClient?.setEditorState(state.editor.headStateId);
    if (manageLoading) {
      state.mapAiProposalLoading = false;
      renderMapAiConnection();
    }
  }
}

async function revokeMapAiLeaseWithUiRetry(lease) {
  return revokeMapAiLeaseWithRetry(
    () => mapMutation(
      `/api/maps/sessions/${encodeURIComponent(lease.mapSessionId)}/ai-leases/revoke`,
      {
        method: "POST",
        action: "map-ai-lease-revoke",
        headers: { "X-Codex-Desktop-Map-AI-Lease": lease.leaseId },
      },
    ),
    {
      onStatus(update) {
        if (update.phase !== "retry-scheduled") return;
        setMapAiConnectionMessage(
          `地图 AI 授权撤销失败，正在进行有限重试（下一次 ${update.nextAttempt}/${update.maxAttempts}）…`,
          "busy",
        );
      },
    },
  );
}

function scheduleMapAiLeaseInvalidationAfterEdit(event) {
  if (!state.mapAiLease || state.mapAiAppliedPendingAck.size > 0) return;
  if (!event || !["commit", "undo", "redo", "reset"].includes(event.action)) return;
  const lease = state.mapAiLease;
  queueMicrotask(() => {
    if (
      state.mapAiLease !== lease
      || state.mapAiAppliedPendingAck.size > 0
      || state.mapAiLeaseInvalidationPending
      || Number(lease.editorStateId) === state.editor?.headStateId
    ) return;
    state.mapAiLeaseInvalidationPending = true;
    // Remove the local bearer immediately; the network revoke then closes the
    // short race in which an old copied prompt could reach the server.
    clearMapAiLeaseLocal();
    setMapAiConnectionMessage("本地编辑状态已变化，正在撤销旧地图 AI 授权…", "busy");
    void revokeMapAiLeaseWithUiRetry(lease).then((result) => {
      if (result.revoked) {
        setMapAiConnectionMessage("本地编辑状态已变化，旧地图 AI 授权已撤销；如需继续请重新连接", "ready");
      } else {
        setMapAiConnectionMessage(
          `本窗口凭据已清除，但旧地图 AI 授权在 ${result.attempts} 次撤销尝试后仍失败；短期授权会自动过期`,
          "error",
        );
      }
    }).finally(() => {
      state.mapAiLeaseInvalidationPending = false;
      renderMapAiConnection();
    });
  });
}

async function discardMapAiProposal(proposal) {
  if (!state.mapAiProposalClient || !currentMapAiProposalCompatibility(proposal).matches) return;
  try {
    const discarded = await state.mapAiProposalClient.discard(proposal.id);
    state.mapAiProposals = state.mapAiProposals.map((entry) => entry.id === discarded.id ? discarded : entry);
    state.mapAiProposalPrepared.delete(proposal.id);
    state.viewer?.setAiPatchPreview(null);
    setMapAiProposalMessage("提案已丢弃；补丁正文已从收件箱清除", "ready");
    renderMapAiProposalList();
  } catch (error) {
    setMapAiProposalMessage(error.message, "error");
  }
}

function setMapAiProposalMessage(message, status = "ready") {
  elements.mapAiProposalState.textContent = message || "";
  elements.mapAiProposalState.dataset.status = message ? status : "";
}

async function readMapContent() {
  const chunks = [];
  let offset = 0;
  while (offset < state.session.size) {
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/content`,
      location.origin,
    );
    url.searchParams.set("version", state.session.version);
    url.searchParams.set("offset", String(offset));
    const chunk = await mapFetch(url);
    if (chunk.offset !== offset || chunk.version !== state.session.version || chunk.nextOffset <= offset) {
      throw new Error("地图分段响应不连续，请重新打开地图");
    }
    chunks.push(chunk.content);
    offset = chunk.nextOffset;
    setLoading("正在读取地图", `${Math.min(100, Math.round(offset / state.session.size * 100))}%`);
  }
  return chunks.join("");
}

async function loadResourceText(projectRelativePath) {
  const response = await fetchResource(projectRelativePath);
  return response.text();
}

async function loadResourceBlob(projectRelativePath) {
  const response = await fetchResource(projectRelativePath);
  return response.blob();
}

async function fetchResource(projectRelativePath) {
  const url = new URL(
    `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/resource`,
    location.origin,
  );
  url.searchParams.set("path", projectRelativePath);
  const response = await fetch(url, {
    cache: "no-store",
    headers: mapHeaders(),
  });
  if (!response.ok) throw await responseError(response, `无法读取地图资源 ${projectRelativePath}`);
  return response;
}

async function mapFetch(input) {
  const response = await fetch(input, { cache: "no-store", headers: mapHeaders() });
  if (!response.ok) throw await responseError(response, "地图会话请求失败");
  return response.json();
}

async function fetchMapWithTimeout(input, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("地图请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function saveMap() {
  if (state.saving || state.fillPending || state.autoMapGesturePending) return false;
  if (!state.editor?.dirty) return true;
  if (!state.session?.writable) return false;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const saveStateId = state.editor.headStateId;
  clearAutoSaveTimer();
  state.saving = true;
  setSaveProgress("正在序列化");
  setSaveButtonIcon("loader-circle");
  let save = null;
  let committed = false;
  try {
    const exportDocument = state.editor.exportDocument();
    compactMapTemplateInstances(exportDocument);
    setSaveProgress("正在编码瓦片");
    await encodeTiledTileData(exportDocument);
    setSaveProgress("正在序列化");
    const source = serializeTiledDocument(exportDocument, {
      expectedKind: "map",
      sourcePath: state.session.relativePath,
      space: 2,
      trailingNewline: true,
    });
    const bytes = new TextEncoder().encode(source);
    setSaveProgress("正在校验内容");
    const totalHash = await sha256Hex(bytes);
    const started = await mapMutation("/api/maps/save-sessions", {
      method: "POST",
      action: "map-save-start",
      json: {
        mapSessionId: state.session.id,
        expectedVersion: state.session.version,
        totalBytes: bytes.byteLength,
        totalHash,
        collaborationPolicyRevision: Number(state.mapAiCollaborationPolicy?.revision || 0),
        clientOperationId: crypto.randomUUID(),
      },
    });
    save = started.save;
    state.activeSaveId = save.id;
    for (let index = 0; index < save.chunkCount; index += 1) {
      const start = index * save.config.chunkBytes;
      const chunk = bytes.subarray(start, Math.min(bytes.byteLength, start + save.config.chunkBytes));
      setSaveProgress(`正在上传 ${index + 1}/${save.chunkCount}`);
      await mapMutation(`/api/maps/save-sessions/${encodeURIComponent(save.id)}/chunks/${index}`, {
        method: "PUT",
        action: "map-save-chunk",
        body: chunk,
        contentType: "application/octet-stream",
        headers: { "X-Content-SHA256": await sha256Hex(chunk) },
      });
    }
    setSaveProgress("等待原子提交");
    const completed = await mapMutation(
      `/api/maps/save-sessions/${encodeURIComponent(save.id)}/commit`,
      { method: "POST", action: "map-save-commit" },
    );
    committed = true;
    state.session = {
      ...state.session,
      ...(completed.session || {}),
      version: completed.result.version,
      size: completed.result.size,
      modifiedAt: completed.result.modifiedAt,
    };
    void loadMapAiManagedAuthorizations({ silent: true });
    const mapAiWasConnected = Boolean(state.mapAiLease || state.mapAiAppliedPendingAck.size);
    state.mapAiAppliedPendingAck.clear();
    clearMapAiLeaseLocal();
    if (mapAiWasConnected) {
      setMapAiConnectionMessage("地图已保存，旧授权已由服务端撤销；继续协作前请重新连接当前对话", "ready");
    }
    // Resource grants are bound to the map version; force image operations to
    // reselect their sources after a successful map save.
    state.mapImageSourcePaths = [];
    state.mapImageMaskPath = "";
    state.mapImageSourceFile = null;
    state.mapImageMaskFile = null;
    state.mapImageUseSelection = false;
    elements.mapImageSourceFile.value = "";
    elements.mapImageMaskFile.value = "";
    renderMapImageOperationControls();
    invalidateAiPatchPreview("地图文件版本已更新，请重新复制提示词并预览补丁");
    for (const diagnostic of completed.result.diagnostics || []) addWarning(diagnostic.message);
    state.editor.markSaved(saveStateId);
    renderMapMeta();
    setMapReadyStatus();
    return true;
  } catch (error) {
    if (error?.status === 409 || ["map-version-conflict", "map-file-changed"].includes(error?.code)) {
      showSaveConflict(error);
    } else {
      reportEditorError(error);
    }
    return false;
  } finally {
    if (save && !committed) {
      await mapMutation(`/api/maps/save-sessions/${encodeURIComponent(save.id)}`, {
        method: "DELETE",
        action: "map-save-abort",
      }).catch(() => {});
    }
    state.saving = false;
    state.saveProgress = "";
    state.activeSaveId = null;
    setSaveButtonIcon("save");
    renderDocumentState();
  }
}

function showAiPatchDialog() {
  if (!state.session?.writable || !state.editor) return;
  state.mapAiUnseenProposalCount = 0;
  updateMapAiProposalIndicator();
  invalidateAiPatchPreview();
  setAiPatchMessage("");
  if (!elements.aiPatchDialog.open) elements.aiPatchDialog.showModal();
  void loadMapAiProposals({ silent: true });
  elements.aiEditRequest.focus();
}

async function copyAiEditPrompt() {
  if (!state.session?.writable || !state.editor) return;
  elements.copyAiPromptButton.disabled = true;
  try {
    const toolContext = mapAiLeaseMatchesCurrentState()
      ? {
          threadId: state.credentials.threadId,
          mapSessionId: state.session.id,
          editorInstanceId: state.credentials.editorInstanceId,
          editorStateId: state.editor.headStateId,
        }
      : null;
    const prompt = buildTiledAiPrompt({
      document: state.editor.document,
      ...currentAiPatchContext(),
      activeLayerId: state.activeLayerId,
      selectedObjectId: state.selectedObjectId,
      selectedGid: state.selectedGid,
      loadedTilesets: state.viewer?.tilesets || [],
      request: elements.aiEditRequest.value,
      ...(toolContext ? { toolContext } : {}),
    });
    await writeClipboardText(prompt);
    setAiPatchMessage("地图编辑提示词已复制");
  } catch (error) {
    setAiPatchMessage(error.message, "error");
  } finally {
    elements.copyAiPromptButton.disabled = false;
  }
}

async function previewAiPatch() {
  if (!state.session?.writable || !state.editor || state.aiPatchLoading || !state.aiPatchWorkerClient) return;
  const controller = new AbortController();
  state.aiPatchAbortController?.abort();
  state.aiPatchAbortController = controller;
  state.aiPatchLoading = true;
  elements.previewAiPatchButton.disabled = true;
  try {
    const context = currentAiPatchContext();
    const editorStateId = state.editor.headStateId;
    const source = elements.aiPatchSource.value;
    const normalized = parseTiledAiPatch(source, context);
    const preview = previewTiledAiPatch(state.editor.document, normalized, {
      loadedTilesets: state.viewer?.tilesets || [],
    });
    setAiPatchMessage("正在浏览器 Worker 中预计算填充区域");
    const preparedFills = await state.aiPatchWorkerClient.prepare(state.editor.document, normalized, {
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (state.editor.headStateId !== editorStateId || elements.aiPatchSource.value !== source) {
      throw new Error("地图或补丁已经变化，请重新预览");
    }
    preview.tileCellCount = preparedFills.tileCellCount;
    state.aiPatchPreview = { context, normalized, preview, source, preparedFills, editorStateId };
    state.viewer?.setAiPatchPreview(normalized);
    renderAiPatchPreview(preview);
    elements.applyAiPatchButton.disabled = false;
    setAiPatchMessage("补丁已通过校验，应用前会再次检查当前地图状态");
  } catch (error) {
    invalidateAiPatchPreview();
    if (error.name !== "AbortError") setAiPatchMessage(error.message, "error");
  } finally {
    if (state.aiPatchAbortController === controller) state.aiPatchAbortController = null;
    state.aiPatchLoading = false;
    elements.previewAiPatchButton.disabled = false;
  }
}

function applyAiPatch() {
  if (!state.session?.writable || !state.editor || !state.aiPatchPreview) return;
  try {
    if (elements.aiPatchSource.value !== state.aiPatchPreview.source) {
      throw new Error("补丁 JSON 已变化，请重新预览");
    }
    if (state.editor.headStateId !== state.aiPatchPreview.editorStateId) {
      throw new Error("地图状态已经变化，请重新预览补丁");
    }
    const normalized = parseTiledAiPatch(elements.aiPatchSource.value, currentAiPatchContext());
    previewTiledAiPatch(state.editor.document, normalized, {
      loadedTilesets: state.viewer?.tilesets || [],
    });
    state.aiApplying = true;
    const result = applyTiledAiPatch(state.editor, normalized, {
      loadedTilesets: state.viewer?.tilesets || [],
      fillResults: state.aiPatchPreview.preparedFills.fillResults,
    });
    state.aiApplying = false;
    invalidateAiPatchPreview();
    setAiPatchMessage(result.changed
      ? "补丁已应用到当前窗口，尚未保存"
      : "补丁没有产生地图变化");
  } catch (error) {
    setAiPatchMessage(error.message, "error");
  } finally {
    state.aiApplying = false;
  }
}

function currentAiPatchContext() {
  return tiledAiPatchContext({
    mapPath: state.session.relativePath,
    mapVersion: state.session.version,
    editorStateId: state.editor.headStateId,
  });
}

function invalidateAiPatchPreview(message = "") {
  state.aiPatchAbortController?.abort();
  state.aiPatchAbortController = null;
  state.aiPatchPreview = null;
  state.viewer?.setAiPatchPreview(null);
  elements.applyAiPatchButton.disabled = true;
  elements.aiPatchPreview.hidden = true;
  elements.aiPatchPreviewSummary.textContent = "";
  elements.aiPatchPreviewCount.textContent = "";
  elements.aiPatchPreviewList.replaceChildren();
  if (message && elements.aiPatchDialog.open) setAiPatchMessage(message);
}

async function showAutoMapDialog() {
  if (!state.session?.writable || !state.editor || state.autoMapLoading) return;
  clearAutoMapPreview();
  state.autoMapRules = null;
  setAutoMapMessage("正在查找 Automapping 规则");
  elements.autoMapRulesPath.textContent = "正在查找地图旁 rules.txt";
  elements.autoMapRulesOrigin.textContent = "地图旁规则优先；否则使用 .tiled-project 的 automappingRulesFile。";
  elements.previewAutoMapButton.disabled = true;
  elements.autoMapWhileDrawing.checked = state.autoMapWhileDrawing;
  if (!elements.autoMapDialog.open) elements.autoMapDialog.showModal();
  state.autoMapLoading = true;
  state.autoMapAbortController?.abort();
  const controller = new AbortController();
  state.autoMapAbortController = controller;
  try {
    const rules = await loadAutoMapRuleSet(controller.signal);
    if (controller.signal.aborted) return;
    state.autoMapRules = rules;
    if (state.autoMapWhileDrawing) state.autoMapWhileDrawingRules = rules;
    elements.autoMapRulesPath.textContent = rules.rulesPath;
    elements.autoMapRulesOrigin.textContent = rules.origin === "map"
      ? "使用当前地图目录旁的 rules.txt（覆盖项目规则）。"
      : "使用 .tiled-project 的 automappingRulesFile。";
    elements.previewAutoMapButton.disabled = false;
    setAutoMapMessage(`已加载 ${rules.compiled.length} 个规则地图，共 ${rules.ruleCount} 条规则`);
  } catch (error) {
    if (error.name !== "AbortError") setAutoMapMessage(error.message, "error");
  } finally {
    if (state.autoMapAbortController === controller) state.autoMapAbortController = null;
    state.autoMapLoading = false;
  }
}

function closeAutoMapDialog() {
  state.autoMapAbortController?.abort();
  state.autoMapAbortController = null;
  if (elements.autoMapDialog.open) elements.autoMapDialog.close();
  else clearAutoMapPreview();
}

async function loadAutoMapRuleSet(signal) {
  if (!state.session.projectFile) {
    throw new Error("AutoMap 需要从 .tiled-project 地图项目打开，以便安全读取规则和 TSJ");
  }
  const textCache = new Map();
  const adjacentPath = siblingProjectPath(state.session.relativePath, "rules.txt");
  let rulesPath = adjacentPath;
  let origin = "map";
  try {
    textCache.set(adjacentPath, await loadProjectResourceText(
      adjacentPath,
      "地图旁 Automapping 规则",
      { signal },
    ));
  } catch (error) {
    if (error.status !== 404) throw error;
    const configured = state.projectSource?.automappingRulesFile;
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error(`没有找到 ${adjacentPath}，项目也没有设置 automappingRulesFile`);
    }
    rulesPath = resolveTiledProjectReference(state.session.projectFile, configured);
    origin = "project";
  }
  const loadText = async (relativePath) => {
    if (textCache.has(relativePath)) return textCache.get(relativePath);
    const text = await loadProjectResourceText(relativePath, "Automapping 规则", { signal });
    textCache.set(relativePath, text);
    return text;
  };
  const manifest = await loadTiledAutomappingRules({
    rulesPath,
    targetMapPath: state.session.relativePath,
    loadText,
    signal,
  });
  const targetTilesets = currentMapTilesetDescriptors();
  const virtualTargetTilesets = [...targetTilesets];
  const tilesetAdditions = [];
  const dependencyPaths = new Set();
  const compiled = [];
  for (const entry of manifest.entries) {
    signal?.throwIfAborted?.();
    const parsed = parseTiledDocument(await loadText(entry.path), {
      expectedKind: "map",
      sourcePath: entry.path,
    });
    await decodeTiledTileData(parsed.document);
    const sourceTilesets = await describeDocumentTilesets(parsed.document, entry.path);
    const reuse = planTiledTilesetReuse({
      sourceMapPath: entry.path,
      targetMapPath: state.session.relativePath,
      sourceTilesets,
      targetTilesets: virtualTargetTilesets,
    });
    const usedTargetFirstgids = new Set();
    const remapGid = (encodedGid) => {
      const remapped = reuse.remapGlobalTileId(encodedGid);
      const sourceBaseGid = decodeGlobalTileId(encodedGid).gid;
      const mapping = reuse.mappings.find((candidate) => (
        sourceBaseGid >= candidate.sourceFirstgid
        && sourceBaseGid <= candidate.sourceFirstgid + candidate.maxLocalId
      ));
      if (mapping) usedTargetFirstgids.add(mapping.targetFirstgid);
      return remapped;
    };
    const rule = compileTiledAutomappingRuleMap(parsed.document, {
      rulePath: entry.path,
      tilesets: sourceTilesets,
      remapGid,
    });
    for (const addition of reuse.additions) {
      if (!usedTargetFirstgids.has(addition.reference.firstgid)) continue;
      const source = sourceTilesets.find((candidate) => (
        addition.sourcePath
          ? candidate.sourcePath === addition.sourcePath
          : reuse.mappings.some((mapping) => (
            mapping.targetFirstgid === addition.reference.firstgid
            && candidate.firstgid === mapping.sourceFirstgid
          ))
      ));
      if (!source) throw new Error(`无法描述规则瓦片集 ${addition.sourcePath || addition.reference.firstgid}`);
      const duplicate = virtualTargetTilesets.some((candidate) => (
        candidate.firstgid === addition.reference.firstgid
        || (addition.sourcePath && candidate.sourcePath === addition.sourcePath)
      ));
      if (duplicate) continue;
      tilesetAdditions.push(addition);
      if (addition.sourcePath) dependencyPaths.add(addition.sourcePath);
      virtualTargetTilesets.push({
        reference: addition.reference,
        definition: source.definition,
        firstgid: addition.reference.firstgid,
        maxLocalId: source.maxLocalId,
        ...(addition.sourcePath ? { sourcePath: addition.sourcePath } : {}),
      });
    }
    compiled.push(rule);
  }
  return Object.freeze({
    rulesPath,
    origin,
    manifest,
    compiled: Object.freeze(compiled),
    ruleCount: compiled.reduce((sum, ruleMap) => sum + ruleMap.rules.length, 0),
    tilesetAdditions: Object.freeze(tilesetAdditions),
    dependencyPaths: Object.freeze([...dependencyPaths]),
  });
}

function siblingProjectPath(documentPath, filename) {
  const segments = String(documentPath || "").split("/");
  segments[segments.length - 1] = filename;
  return segments.join("/");
}

async function generateAutoMapPreview() {
  if (!state.autoMapRules || !state.editor || state.autoMapLoading) return;
  state.autoMapLoading = true;
  elements.previewAutoMapButton.disabled = true;
  elements.applyAutoMapButton.disabled = true;
  const controller = new AbortController();
  state.autoMapAbortController?.abort();
  state.autoMapAbortController = controller;
  try {
    const seed = normalizeAutoMapSeed(elements.autoMapSeed.value);
    setAutoMapMessage("正在生成预览");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const preview = await state.autoMapWorkerClient.preview(state.editor.document, state.autoMapRules.compiled, {
      targetPath: state.session.relativePath,
      seed,
      signal: controller.signal,
    });
    state.autoMapPreview = Object.freeze({
      preview,
      seed,
      editorStateId: state.editor.headStateId,
      rules: state.autoMapRules,
    });
    state.viewer?.setAutomapPreview(preview);
    renderAutoMapPreview(preview, state.autoMapRules);
    elements.applyAutoMapButton.disabled = preview.changes.length === 0;
    setAutoMapMessage(preview.changes.length
      ? "预览未修改地图；确认结果后可应用到当前窗口"
      : "规则执行完成，但没有产生地图变化");
  } catch (error) {
    if (error.name !== "AbortError") setAutoMapMessage(error.message, "error");
    clearAutoMapPreview();
  } finally {
    if (state.autoMapAbortController === controller) state.autoMapAbortController = null;
    state.autoMapLoading = false;
    elements.previewAutoMapButton.disabled = !state.autoMapRules;
  }
}

async function applyAutoMapPreview() {
  const prepared = state.autoMapPreview;
  if (!prepared || !state.editor || state.autoMapApplying) return;
  state.autoMapApplying = true;
  elements.applyAutoMapButton.disabled = true;
  try {
    if (prepared.editorStateId !== state.editor.headStateId) {
      throw new Error("地图状态已经变化，请重新生成 AutoMap 预览");
    }
    if (normalizeAutoMapSeed(elements.autoMapSeed.value) !== prepared.seed) {
      throw new Error("Seed 已变化，请重新生成 AutoMap 预览");
    }
    for (const dependencyPath of prepared.rules.dependencyPaths) {
      await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
        {
          method: "POST",
          action: "map-resource-grant",
          json: {
            resourcePath: dependencyPath,
            expectedKind: "tileset",
            expectedVersion: state.session.version,
          },
        },
      );
    }
    const result = applyTiledAutomappingPreview(state.editor, prepared.preview, {
      tilesetAdditions: prepared.rules.tilesetAdditions,
    });
    clearAutoMapPreview();
    setAutoMapMessage(result.changed ? "AutoMap 已应用到当前窗口，尚未保存" : "AutoMap 没有产生地图变化");
  } catch (error) {
    setAutoMapMessage(error.message, "error");
    elements.applyAutoMapButton.disabled = false;
  } finally {
    state.autoMapApplying = false;
  }
}

function invalidateAutoMapPreview() {
  if (!state.autoMapPreview) return;
  clearAutoMapPreview();
  setAutoMapMessage("Seed 已变化，请重新生成预览");
}

function clearAutoMapPreview() {
  state.autoMapPreview = null;
  state.viewer?.setAutomapPreview(null);
  elements.applyAutoMapButton.disabled = true;
  elements.autoMapPreview.hidden = true;
  elements.autoMapPreviewSummary.textContent = "";
  elements.autoMapPreviewCount.textContent = "";
  elements.autoMapPreviewStats.replaceChildren();
  elements.autoMapRuleList.replaceChildren();
}

function renderAutoMapPreview(preview, rules) {
  elements.autoMapPreviewSummary.textContent = preview.changes.length
    ? `将修改 ${preview.changes.length} 个格子`
    : "没有产生修改";
  elements.autoMapPreviewCount.textContent = `Seed ${preview.seed}`;
  const stats = [
    ["规则地图", preview.stats.ruleMaps],
    ["规则", preview.stats.rules],
    ["匹配", preview.stats.matches],
    ["修改格", preview.stats.changes],
    ["新增层", preview.stats.addedLayers],
    ["新增瓦片集", rules.tilesetAdditions.length],
  ];
  const statFragment = document.createDocumentFragment();
  for (const [label, value] of stats) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = String(value);
    row.append(term, detail);
    statFragment.append(row);
  }
  elements.autoMapPreviewStats.replaceChildren(statFragment);
  const ruleFragment = document.createDocumentFragment();
  for (const entry of rules.manifest.entries) {
    const item = document.createElement("li");
    item.textContent = entry.path;
    ruleFragment.append(item);
  }
  elements.autoMapRuleList.replaceChildren(ruleFragment);
  elements.autoMapPreview.hidden = false;
}

function randomizeAutoMapSeed() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  elements.autoMapSeed.value = String(values[0]);
  invalidateAutoMapPreview();
  scheduleMapEditorViewStateSave();
}

async function toggleAutoMapWhileDrawing() {
  const enabled = elements.autoMapWhileDrawing.checked === true;
  if (!enabled) {
    state.autoMapWhileDrawing = false;
    state.autoMapWhileDrawingRules = null;
    state.autoMapWhileDrawingLoading = null;
    state.autoMapWhileDrawingMessage = "AutoMap While Drawing 已关闭";
    scheduleMapEditorViewStateSave();
    setAutoMapMessage(state.autoMapWhileDrawingMessage);
    return;
  }
  try {
    const rules = state.autoMapRules || await loadAutoMapRuleSet();
    if (rules.tilesetAdditions.length) {
      throw new Error("当前规则需要先加入新瓦片集；请先执行一次手动 AutoMap 并保存，再开启 While Drawing");
    }
    state.autoMapWhileDrawing = true;
    state.autoMapWhileDrawingRules = rules;
    state.autoMapWhileDrawingMessage = `AutoMap While Drawing 已开启 · ${rules.ruleCount} 条规则`;
    scheduleMapEditorViewStateSave();
    setAutoMapMessage(state.autoMapWhileDrawingMessage);
  } catch (error) {
    elements.autoMapWhileDrawing.checked = false;
    state.autoMapWhileDrawing = false;
    state.autoMapWhileDrawingRules = null;
    setAutoMapMessage(error.message, "error");
  }
}

async function ensureAutoMapWhileDrawingRules() {
  if (!state.autoMapWhileDrawing) return null;
  if (state.autoMapWhileDrawingRules) return state.autoMapWhileDrawingRules;
  if (!state.autoMapWhileDrawingLoading) {
    state.autoMapWhileDrawingLoading = loadAutoMapRuleSet().then((rules) => {
      if (rules.tilesetAdditions.length) {
        throw new Error("While Drawing 规则引用了当前地图尚未加入的瓦片集");
      }
      state.autoMapWhileDrawingRules = rules;
      return rules;
    }).finally(() => {
      state.autoMapWhileDrawingLoading = null;
    });
  }
  return state.autoMapWhileDrawingLoading;
}

function beginAutoMapGesture(label) {
  if (!state.autoMapWhileDrawing || !state.autoMapWhileDrawingRules) return null;
  const seed = normalizeAutoMapSeed(elements.autoMapSeed.value || state.mapEditorViewState?.autoMapSeed || 1);
  return {
    label,
    seed,
    historyDepth: state.editor.undoStack.length,
    cells: new Set(),
    rules: state.autoMapWhileDrawingRules,
  };
}

function recordAutoMapGestureCell(gesture, x, y) {
  if (gesture) gesture.cells.add(`${x},${y}`);
}

async function applyAutoMapForGesture(gesture) {
  if (!gesture || !gesture.cells.size || !state.editor || !state.autoMapGestureWorkerClient) return false;
  if (state.editor.undoStack.length !== gesture.historyDepth + 1) {
    reportEditorError(new Error("画笔历史发生变化，已跳过 AutoMap While Drawing"));
    return false;
  }
  const region = autoMapGestureRegion(gesture.cells);
  const editor = state.editor;
  const expectedStateId = editor.headStateId;
  const controller = new AbortController();
  cancelPendingAutoMapGesture();
  const pending = Object.freeze({ controller, editor, expectedStateId, gesture, region });
  state.autoMapGestureAbortController = controller;
  state.autoMapGesturePending = pending;
  state.autoMapGestureMessage = "正在计算 AutoMap While Drawing · Esc 取消";
  clearAutoSaveTimer();
  renderDocumentState();
  let changed = false;
  try {
    const preview = await state.autoMapGestureWorkerClient.preview(editor.document, gesture.rules.compiled, {
      targetPath: state.session.relativePath,
      seed: gesture.seed,
      region,
      whileDrawing: true,
      signal: controller.signal,
    });
    if (state.autoMapGesturePending !== pending) return false;
    if (state.editor !== editor || editor.headStateId !== expectedStateId) {
      throw new Error("地图状态已经变化，已跳过旧的 AutoMap While Drawing 结果");
    }
    if (!preview.changes.length) {
      state.autoMapWhileDrawingMessage = "While Drawing：没有产生附加变化";
      return false;
    }
    if (preview.additions.length || gesture.rules.tilesetAdditions.length) {
      throw new Error("AutoMap While Drawing 不能在笔画期间创建图层或加入瓦片集；请先手动运行一次 AutoMap");
    }
    const result = applyTiledAutomappingPreview(editor, preview, { label: `${gesture.label} · AutoMap` });
    if (!result.changed) return false;
    editor.groupRecentHistory(2, `${gesture.label} + AutoMap`, {
      kind: "automap-while-drawing",
      seed: gesture.seed,
      region,
    });
    state.autoMapWhileDrawingMessage = `While Drawing：匹配 ${preview.stats.matches} 处，修改 ${preview.stats.changes} 格`;
    changed = true;
    return true;
  } catch (error) {
    if (error.name !== "AbortError") reportEditorError(error);
    return false;
  } finally {
    if (state.autoMapGesturePending === pending) {
      state.autoMapGesturePending = null;
      state.autoMapGestureAbortController = null;
      state.autoMapGestureMessage = "";
    }
    renderDocumentState();
    if (elements.autoMapDialog.open && state.autoMapWhileDrawingMessage) {
      setAutoMapMessage(state.autoMapWhileDrawingMessage);
    }
    if (editor.dirty) updateAutoSaveTimer({ action: changed ? "commit" : "undo" });
  }
}

function cancelPendingAutoMapGesture(message = "") {
  if (!state.autoMapGesturePending) return false;
  if (message) state.autoMapWhileDrawingMessage = message;
  state.autoMapGestureAbortController?.abort();
  return true;
}

function autoMapGestureRegion(cells) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of cells) {
    const separator = key.indexOf(",");
    const x = Number(key.slice(0, separator));
    const y = Number(key.slice(separator + 1));
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function normalizeAutoMapSeed(value) {
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("AutoMap Seed 必须是 0 到 4294967295 的整数");
  }
  return seed >>> 0;
}

function setAutoMapMessage(message, status = "ready") {
  elements.autoMapState.textContent = message || "";
  elements.autoMapState.dataset.status = message ? status : "";
}

function renderAiPatchPreview(preview) {
  elements.aiPatchPreviewSummary.textContent = preview.summary;
  elements.aiPatchPreviewCount.textContent = preview.tileCellCount
    ? `${preview.operationCount} 项 · ${preview.tileCellCount} 瓦片`
    : `${preview.operationCount} 项`;
  const fragment = document.createDocumentFragment();
  const displayLimit = 200;
  for (const entry of preview.entries.slice(0, displayLimit)) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const operation = document.createElement("code");
    operation.textContent = `${entry.index + 1}. ${entry.op}`;
    const detail = document.createElement("span");
    detail.textContent = entry.detail;
    item.append(title, operation, detail);
    fragment.append(item);
  }
  if (preview.entries.length > displayLimit) {
    const item = document.createElement("li");
    const detail = document.createElement("span");
    detail.textContent = `另有 ${preview.entries.length - displayLimit} 项操作已完成校验`;
    item.append(detail);
    fragment.append(item);
  }
  elements.aiPatchPreviewList.replaceChildren(fragment);
  elements.aiPatchPreview.hidden = false;
}

function setAiPatchMessage(message, status = "ready") {
  elements.aiPatchState.textContent = message;
  elements.aiPatchState.dataset.status = message ? status : "";
}

function initializeMapImageBoundaryController() {
  if (state.mapImageBoundaryController || !state.document) return;
  state.mapImageBoundaryController = new MapImageBoundaryController({
    canvas: elements.mapImageBoundaryCanvas,
    inputs: {
      top: elements.mapImageExpandTop,
      right: elements.mapImageExpandRight,
      bottom: elements.mapImageExpandBottom,
      left: elements.mapImageExpandLeft,
    },
    unitInput: elements.mapImageBoundaryUnit,
    stepInput: elements.mapImageBoundaryStep,
    emptyState: elements.mapImageBoundaryEmpty,
    document: state.document,
    onChange: () => {
      renderMapImageBoundaryPlan();
      updateMapImageControls();
    },
  });
}

async function showMapImageDialog() {
  if (!state.session?.writable || !state.editor) return;
  if (!elements.mapImageDialog.open) elements.mapImageDialog.showModal();
  setMapImageMessage("正在读取图片 Worker 状态");
  renderMapImageOperationControls();
  renderMapImageJobs();
  await refreshMapImageSourcePreview();
  await loadMapImagePanel();
  elements.mapImagePrompt.focus();
}

function currentMapImageOperation() {
  return elements.mapImageOperation
    ?.querySelector('input[name="mapImageOperation"]:checked')
    ?.value || "generate";
}

async function refreshMapImageSourcePreview() {
  const token = ++state.mapImageSourcePreviewToken;
  revokeMapImageSourcePreview();
  state.mapImageBoundaryController?.clearSource();
  state.mapImageBoundaryController?.setGuideCoordinates();
  if (currentMapImageOperation() !== "outpaint") return;
  try {
    let blob = null;
    let dimensions = null;
    if (state.mapImageUseSelection) {
      const target = selectionImageTargetForOperation("edit");
      const input = await captureMapSelectionPng(target);
      blob = new Blob([input.bytes], { type: input.mediaType });
      dimensions = { width: input.width, height: input.height };
    } else if (state.mapImageSourceFile) {
      blob = state.mapImageSourceFile;
      dimensions = await imageBlobDimensions(blob);
    } else if (state.mapImageSourcePaths.length === 1) {
      blob = await loadResourceBlob(state.mapImageSourcePaths[0]);
      dimensions = await imageBlobDimensions(blob);
    }
    if (token !== state.mapImageSourcePreviewToken) return;
    if (!blob || !dimensions) {
      renderMapImageBoundaryPlan();
      return;
    }
    const url = URL.createObjectURL(blob);
    if (token !== state.mapImageSourcePreviewToken) {
      URL.revokeObjectURL(url);
      return;
    }
    state.mapImageSourcePreviewUrl = url;
    state.mapImageBoundaryController?.setSource({ url, ...dimensions });
    updateMapImageBoundaryGuideCoordinates();
  } catch (error) {
    if (token !== state.mapImageSourcePreviewToken) return;
    elements.mapImageBoundaryState.textContent = error.message;
    elements.mapImageBoundaryState.dataset.status = "error";
    state.mapImageBoundaryPlan = null;
    updateMapImageControls();
  }
}

function updateMapImageBoundaryGuideCoordinates() {
  if (state.mapImageSourceLayerId == null || !state.guideController || !state.viewer) {
    state.mapImageBoundaryController?.setGuideCoordinates();
    return;
  }
  const bounds = state.viewer.imageLayerWorldBounds(state.mapImageSourceLayerId);
  const guideState = state.guideController.snapshot();
  if (!bounds || !guideState.guidesVisible) {
    state.mapImageBoundaryController?.setGuideCoordinates();
    return;
  }
  const visible = guideState.guides.filter((guide) => guide.visible);
  state.mapImageBoundaryController?.setGuideCoordinates({
    vertical: visible
      .filter((guide) => guide.orientation === "vertical")
      .map((guide) => guide.position - bounds.x),
    horizontal: visible
      .filter((guide) => guide.orientation === "horizontal")
      .map((guide) => guide.position - bounds.y),
  });
}

function revokeMapImageSourcePreview() {
  if (state.mapImageSourcePreviewUrl) URL.revokeObjectURL(state.mapImageSourcePreviewUrl);
  state.mapImageSourcePreviewUrl = "";
}

function renderMapImageBoundaryPlan() {
  const operation = currentMapImageOperation();
  const boundary = state.mapImageBoundaryController?.snapshot() || null;
  state.mapImageBoundaryPlan = null;
  for (const output of [
    elements.mapImageBoundarySourceSize,
    elements.mapImageBoundaryCroppedSize,
    elements.mapImageBoundaryTargetSize,
    elements.mapImageBoundaryProviderSize,
  ]) output.textContent = "--";
  elements.mapImageBoundaryState.textContent = operation === "outpaint" ? "选择源图后设置边界" : "";
  elements.mapImageBoundaryState.dataset.status = "";
  if (operation !== "outpaint" || !boundary) return;
  if (boundary.error) {
    elements.mapImageBoundaryState.textContent = boundary.error;
    elements.mapImageBoundaryState.dataset.status = "error";
    return;
  }
  elements.mapImageBoundarySourceSize.textContent = `${boundary.source.width}×${boundary.source.height}`;
  elements.mapImageBoundaryCroppedSize.textContent = `${boundary.cropped.width}×${boundary.cropped.height}`;
  elements.mapImageBoundaryTargetSize.textContent = `${boundary.target.width}×${boundary.target.height}`;
  if (boundary.hasCrop && state.mapImageUseSelection) {
    elements.mapImageBoundaryState.textContent = "地图瓦片选区暂不接受像素级内裁剪；请调整选区本身，或改用工程图片源";
    elements.mapImageBoundaryState.dataset.status = "error";
    return;
  }
  if (!boundary.hasOutpaint) {
    if (boundary.hasCrop && state.mapImageConfig?.capabilities?.localCrop) {
      elements.mapImageBoundaryProviderSize.textContent = "不使用";
      elements.mapImageBoundaryState.textContent = `本地非破坏裁剪；将创建 ${boundary.target.width}×${boundary.target.height} PNG 候选，不调用图片供应商`;
      state.mapImageBoundaryPlan = { ready: true, boundary, provider: null, localCrop: true };
      return;
    }
    elements.mapImageBoundaryState.textContent = boundary.hasCrop
      ? "当前服务端未启用本地裁剪候选"
      : "至少向内裁剪一侧或向外扩展一侧";
    elements.mapImageBoundaryState.dataset.status = "error";
    return;
  }
  const capability = state.mapImageConfig?.capabilities?.operationCapabilities?.outpaint;
  if (!capability) {
    elements.mapImageBoundaryState.textContent = "正在读取扩图尺寸能力";
    return;
  }
  try {
    const provider = planMapImageProviderCanvas(
      boundary,
      capability,
      state.mapImageConfig.capabilities.sizeLimits,
      elements.mapImageAlignmentPolicy.value,
    );
    elements.mapImageBoundaryProviderSize.textContent = provider.provider
      ? `${provider.provider.width}×${provider.provider.height}`
      : "不支持";
    if (!provider.supported) {
      elements.mapImageBoundaryState.textContent = `${provider.message}；可用尺寸：${provider.supportedSizes.join("、") || "无"}`;
      elements.mapImageBoundaryState.dataset.status = "error";
      return;
    }
    const cropText = boundary.hasCrop
      ? `先裁剪 上${boundary.crop.top} 右${boundary.crop.right} 下${boundary.crop.bottom} 左${boundary.crop.left}`
      : "不裁剪源图";
    const postprocess = provider.postprocess.length ? `；后处理 ${provider.postprocess.join("、")}` : "";
    elements.mapImageBoundaryState.textContent = `${cropText}；逻辑结果保持 ${boundary.target.width}×${boundary.target.height}${postprocess}`;
    state.mapImageBoundaryPlan = { ready: true, boundary, provider };
  } catch (error) {
    elements.mapImageBoundaryState.textContent = error.message;
    elements.mapImageBoundaryState.dataset.status = "error";
  }
}

async function loadMapImagePanel() {
  if (!state.session || state.mapImageLoading) return;
  state.mapImageLoading = true;
  elements.refreshMapImageButton.disabled = true;
  try {
    const [configPayload, jobsPayload] = await Promise.all([
      mapFetch(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-config`),
      mapFetch(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-jobs?limit=30`),
    ]);
    state.mapImageConfig = normalizeMapImageCandidateConfig(configPayload);
    setMapImageJobs(jobsPayload?.jobs);
    populateMapImageOptions();
    renderMapImageOperationControls();
    renderMapImageCapabilities();
    renderMapImageJobs();
    const operationAvailability = mapImageOperationAvailability(
      state.mapImageConfig,
      currentMapImageOperation(),
      { kind: elements.mapImageKind.value },
    );
    const localCropAvailable = currentMapImageOperation() === "outpaint"
      && state.mapImageConfig.capabilities.localCrop === true;
    setMapImageMessage(operationAvailability.enabled || localCropAvailable
      ? localCropAvailable && !operationAvailability.enabled
        ? "本地裁剪可用；AI 扩图不可用，裁剪结果仍需明确发布和导入"
        : "结果只会进入候选区；发布和导入都需要再次确认"
      : operationAvailability.reason, operationAvailability.enabled || localCropAvailable ? "ready" : "error");
    scheduleMapImagePolling();
  } catch (error) {
    state.mapImageConfig = null;
    renderMapImageCapabilities();
    renderMapImageJobs();
    setMapImageMessage(error.message, "error");
    stopMapImagePolling();
  } finally {
    state.mapImageLoading = false;
    elements.refreshMapImageButton.disabled = false;
    updateMapImageControls();
  }
}

async function refreshMapImageJobs({ silent = false } = {}) {
  if (!state.session || state.mapImageLoading) return;
  try {
    const payload = await mapFetch(
      `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-jobs?limit=30`,
    );
    setMapImageJobs(payload?.jobs);
    renderMapImageJobs();
    scheduleMapImagePolling();
  } catch (error) {
    if (!silent) setMapImageMessage(error.message, "error");
    stopMapImagePolling();
  }
}

function setMapImageJobs(value) {
  const jobs = Array.isArray(value) ? value : [];
  state.mapImageJobs = jobs;
  const activeIds = new Set(jobs.map((job) => job?.id).filter(Boolean));
  for (const job of jobs) {
    if (job?.id && job.selectionTarget?.schema === "wfl.map-selection-image-target.v1") {
      state.mapImageSelectionTargets.set(job.id, structuredClone(job.selectionTarget));
    }
  }
  for (const jobId of state.mapImageSelectionTargets.keys()) {
    if (!activeIds.has(jobId)) state.mapImageSelectionTargets.delete(jobId);
  }
  renderTaskTray();
}

function populateMapImageOptions() {
  const config = state.mapImageConfig;
  const qualities = config?.capabilities?.qualities || [];
  populateMapImageSizeOptions(currentMapImageOperation());
  renderMapImageAssetPreset();
  elements.mapImageQuality.replaceChildren();
  if (!qualities.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "供应商默认";
    elements.mapImageQuality.append(option);
  } else {
    for (const quality of qualities) {
      const option = document.createElement("option");
      option.value = quality;
      option.textContent = quality;
      elements.mapImageQuality.append(option);
    }
    if (config?.capabilities?.defaultQuality) elements.mapImageQuality.value = config.capabilities.defaultQuality;
  }
}

function populateMapImageSizeOptions(operation = "generate") {
  const config = state.mapImageConfig;
  const capability = config?.capabilities?.operationCapabilities?.[operation];
  const sizes = capability?.sizes?.length
    ? capability.sizes
    : operation === "generate" ? (config?.capabilities?.sizes || []) : [];
  const previous = elements.mapImageSize.value;
  elements.mapImageSize.replaceChildren();
  for (const size of sizes) {
    const option = document.createElement("option");
    option.value = size;
    option.textContent = size;
    elements.mapImageSize.append(option);
  }
  if (capability?.customSize && previous && /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(previous)) {
    const custom = document.createElement("option");
    custom.value = previous;
    custom.textContent = `${previous}（自定义）`;
    elements.mapImageSize.append(custom);
  }
  if (sizes.includes(previous)) elements.mapImageSize.value = previous;
  else if (operation === "generate" && config?.capabilities?.defaultSize) elements.mapImageSize.value = config.capabilities.defaultSize;
  else if (sizes[0]) elements.mapImageSize.value = sizes[0];
}

function renderMapImageAssetPreset() {
  try {
    const preset = mapImageAssetPreset(elements.mapImageKind.value);
    elements.mapImageKindState.textContent = preset.description;
    elements.mapImagePrompt.placeholder = preset.placeholder;
  } catch {
    elements.mapImageKindState.textContent = "素材类型无效";
  }
}

function mapImageOperationLabel(operation) {
  return ({ generate: "生成", edit: "编辑", outpaint: "裁剪/扩图" })[operation] || operation;
}

function renderMapImageOperationAvailability(busy = false) {
  const selected = currentMapImageOperation();
  const unavailable = [];
  let selectedAvailability = null;
  for (const input of elements.mapImageOperation.querySelectorAll('input[name="mapImageOperation"]')) {
    const availability = mapImageOperationAvailability(state.mapImageConfig, input.value, {
      kind: elements.mapImageKind.value,
    });
    const localCrop = input.value === "outpaint"
      && state.mapImageConfig?.capabilities?.localCrop === true;
    const interactionEnabled = availability.enabled || localCrop;
    const item = input.closest("label");
    input.disabled = busy || !interactionEnabled;
    item?.toggleAttribute("data-unavailable", !interactionEnabled);
    if (item) item.title = availability.enabled
      ? `${mapImageOperationLabel(input.value)}可用`
      : localCrop ? `本地裁剪可用；AI 扩图不可用：${availability.reason}` : availability.reason;
    if (!availability.enabled) unavailable.push(localCrop
      ? `AI 扩图不可用：${availability.reason}，本地裁剪仍可用`
      : `${mapImageOperationLabel(input.value)}不可用：${availability.reason}`);
    if (input.value === selected) selectedAvailability = {
      enabled: interactionEnabled,
      reason: availability.enabled ? "" : localCrop ? `AI 扩图不可用：${availability.reason}，本地裁剪仍可用` : availability.reason,
    };
  }
  if (!state.mapImageConfig) {
    elements.mapImageOperationState.textContent = "正在读取操作能力";
    elements.mapImageOperationState.dataset.status = "";
    return;
  }
  if (!selectedAvailability?.enabled) {
    elements.mapImageOperationState.textContent = `${mapImageOperationLabel(selected)}不可用：${selectedAvailability?.reason || "能力未知"}；不会自动切换操作`;
    elements.mapImageOperationState.dataset.status = "error";
    return;
  }
  elements.mapImageOperationState.textContent = unavailable.length
    ? (selectedAvailability.reason || unavailable.join("；"))
    : `${mapImageOperationLabel(selected)}可用；任务会保留当前操作、尺寸和质量参数`;
  elements.mapImageOperationState.dataset.status = unavailable.length ? "warning" : "ready";
}

function renderMapImageOperationControls() {
  const operation = currentMapImageOperation();
  const editing = operation === "edit";
  const outpainting = operation === "outpaint";
  populateMapImageSizeOptions(operation);
  elements.mapImageKind.hidden = editing || outpainting;
  elements.mapImageKind.closest(".dialog-field")?.toggleAttribute("hidden", editing || outpainting);
  elements.mapImageSize.closest(".dialog-field")?.toggleAttribute("hidden", outpainting);
  elements.mapImageSourceField.hidden = !editing && !outpainting;
  elements.mapImageMaskField.hidden = !editing;
  elements.mapImageOutpaintFields.hidden = !outpainting;
  elements.mapImageBlendMargin.disabled = elements.mapImagePreserveSource.value !== "seamless";
  elements.mapImageSourceState.textContent = state.mapImageSourcePaths.length
    ? `${state.mapImageSourcePaths.join("、")}${state.mapImageSourceLayerId != null ? "（当前图片层）" : ""}`
    : state.mapImageSourceFile?.name || "尚未选择";
  elements.mapImageMaskState.textContent = state.mapImageMaskPath || state.mapImageMaskFile?.name || "未选择蒙版";
  elements.mapImageSelectionState.textContent = state.mapImageUseSelection
    ? "将从当前地图选区截图并上传临时源图"
    : "未使用地图选区";
  elements.mapImageSelectionButton.disabled = !editing && !outpainting;
  elements.mapImageSelectionButton.classList.toggle("is-active", state.mapImageUseSelection);
  elements.mapImageSelectionButton.querySelector("span").textContent = state.mapImageUseSelection
    ? "取消选区截图"
    : "使用当前选区截图";
  elements.mapImageSubmitButton.querySelector("span").textContent = operation === "generate"
    ? "生成候选"
    : operation === "edit" ? "编辑候选" : "扩图候选";
  renderMapImageBoundaryPlan();
  updateMapImageControls();
}

function renderMapImageCapabilities() {
  const config = state.mapImageConfig;
  if (!config) {
    elements.mapImageCapabilities.textContent = "尚未读取图片能力";
    return;
  }
  const worker = config.worker.enabled
    ? config.worker.accepting ? `Worker ${config.worker.preset || "已启用"} · 接受新任务` : "Worker 已暂停接收新任务"
    : "Worker 已关闭";
  const sizes = config.capabilities.sizes.length ? config.capabilities.sizes.join("、") : "无";
  const backgrounds = [
    config.capabilities.backgrounds.includes("transparent") ? "透明" : "",
    config.capabilities.backgrounds.includes("opaque") ? "不透明" : "",
  ].filter(Boolean).join("、") || "无可用背景";
  const localCrop = config.capabilities.localCrop ? " · 本地裁剪可用" : "";
  elements.mapImageCapabilities.textContent = `${worker}${localCrop} · PNG（${backgrounds}） · 尺寸：${sizes}`;
}

function updateMapImageControls() {
  const operation = currentMapImageOperation();
  const operationAvailability = mapImageOperationAvailability(state.mapImageConfig, operation, {
    kind: elements.mapImageKind.value,
  });
  const localCrop = operation === "outpaint" && state.mapImageBoundaryPlan?.localCrop === true;
  const sourceReady = operation === "generate"
    || state.mapImageSourcePaths.length === 1
    || Boolean(state.mapImageSourceFile)
    || (state.mapImageUseSelection && Boolean(state.selection));
  const ready = state.session?.writable === true
    && (localCrop || mapImageWorkerReady(operation))
    && (localCrop || operationAvailability.enabled)
    && sourceReady
    && (operation !== "outpaint" || state.mapImageBoundaryPlan?.ready === true);
  const busy = state.mapImageLoading || state.mapImageStarting || state.mapImageSourceResolving;
  elements.mapImageButton.disabled = state.session?.writable !== true;
  elements.mapImageKind.disabled = busy;
  elements.mapImagePrompt.disabled = busy || localCrop;
  elements.mapImagePrompt.closest(".dialog-field")?.toggleAttribute("hidden", localCrop);
  renderMapImageOperationAvailability(busy);
  elements.mapImageSourceButton.disabled = busy;
  elements.mapImageLayerSourceButton.disabled = busy
    || state.mapImageSourceResolving
    || state.editor?.layerById(state.activeLayerId)?.type !== "imagelayer";
  elements.mapImageMaskButton.disabled = busy;
  elements.mapImageSize.disabled = !ready || busy || operation === "outpaint";
  elements.mapImageQuality.disabled = !ready || busy || localCrop;
  elements.mapImageSubmitButton.disabled = !ready || busy;
  elements.mapImageSubmitButton.querySelector("span").textContent = localCrop
    ? "创建裁剪候选"
    : operation === "generate" ? "生成候选" : operation === "edit" ? "编辑候选" : "扩图候选";
  const boundaryAvailable = operation === "outpaint"
    && Boolean(state.mapImageBoundaryController?.snapshot())
    && !busy;
  for (const input of [
    elements.mapImageExpandTop,
    elements.mapImageExpandRight,
    elements.mapImageExpandBottom,
    elements.mapImageExpandLeft,
    elements.mapImageBoundaryUnit,
    elements.mapImageBoundaryStep,
  ]) input.disabled = !boundaryAvailable;
  elements.mapImageBoundaryResetButton.disabled = !boundaryAvailable;
}

function toggleMapImageSelectionSource() {
  const operation = currentMapImageOperation();
  if (![
    "edit",
    "outpaint",
  ].includes(operation)) return;
  if (state.mapImageUseSelection) {
    state.mapImageUseSelection = false;
    renderMapImageOperationControls();
    void refreshMapImageSourcePreview();
    return;
  }
  try {
    selectionImageTargetForOperation(operation);
    state.mapImageUseSelection = true;
    state.mapImageSourcePaths = [];
    state.mapImageSourceFile = null;
    state.mapImageSourceLayerId = null;
    elements.mapImageSourceFile.value = "";
    setMapImageMessage("已绑定当前选区；提交时会截图并上传临时源图", "ready");
    renderMapImageOperationControls();
    void refreshMapImageSourcePreview();
  } catch (error) {
    setMapImageMessage(error.message, "error");
  }
}

function clearMapImageMask() {
  state.mapImageMaskPath = "";
  state.mapImageMaskFile = null;
  elements.mapImageMaskFile.value = "";
  renderMapImageOperationControls();
}

function mapImageWorkerReady(operation = "generate") {
  return mapImageOperationAvailability(state.mapImageConfig, operation, {
    kind: elements.mapImageKind.value,
  }).enabled;
}

function setMapImageMessage(message, status = "ready") {
  elements.mapImageState.textContent = message || "";
  elements.mapImageState.dataset.status = message ? status : "";
}

function scheduleMapImagePolling() {
  stopMapImagePolling();
  if ((!elements.mapImageDialog.open && !taskTrayIsVisible())
    || !state.mapImageJobs.some(mapImageJobIsActive)) return;
  state.mapImagePollTimer = window.setTimeout(async () => {
    state.mapImagePollTimer = null;
    await refreshMapImageJobs({ silent: true });
  }, 1500);
}

function stopMapImagePolling() {
  if (state.mapImagePollTimer != null) {
    window.clearTimeout(state.mapImagePollTimer);
    state.mapImagePollTimer = null;
  }
}

function closeMapImagePanel() {
  stopMapImagePolling();
  for (const url of state.mapImagePreviewUrls.values()) URL.revokeObjectURL(url);
  state.mapImagePreviewUrls.clear();
  state.mapImagePreviewLoading.clear();
  state.mapImageSourcePreviewToken += 1;
  revokeMapImageSourcePreview();
  state.mapImageBoundaryController?.clearSource();
}

function selectionImageTargetForOperation(operation) {
  if (!state.session?.writable || !state.editor || !state.viewer) throw new Error("地图编辑器尚未准备好");
  if (state.editor.dirty) throw new Error("使用地图选区生图前请先保存地图，确保服务端可以权威校验选区");
  const layer = state.editor.layerById(state.activeLayerId);
  if (layer?.type !== "tilelayer") throw new Error("当前版本只支持从瓦片层选区截取图片");
  const selection = state.selection;
  if (!selection || ![selection.startColumn, selection.endColumn, selection.startRow, selection.endRow].every(Number.isSafeInteger)) {
    throw new Error("请先用选择工具框选一个瓦片区域");
  }
  const expansion = operation === "outpaint"
    ? { unit: "world", ...(state.mapImageBoundaryPlan?.boundary?.outpaint || {}) }
    : { unit: "tile" };
  const target = structuredClone(createMapSelectionImageTarget({
    document: state.editor.document,
    layerId: state.activeLayerId,
    selection: {
      x: selection.startColumn,
      y: selection.startRow,
      width: selection.endColumn - selection.startColumn + 1,
      height: selection.endRow - selection.startRow + 1,
      world: { x: selection.x, y: selection.y, width: selection.width, height: selection.height },
    },
    mapVersion: state.session.version,
    editorStateId: state.editor.headStateId,
    purpose: "layer-image",
    expansion,
    maskMode: state.mapImageConfig?.capabilities?.strictMask ? "strict" : "soft",
    preserveSource: elements.mapImagePreserveSource.value || "exact",
  }));
  if (operation === "outpaint") {
    target.policies.alignmentPolicy = elements.mapImageAlignmentPolicy.value || "reject";
    if (target.policies.preserveSource === "seamless") {
      target.policies.blendMargin = Number(elements.mapImageBlendMargin.value || 64);
    }
  }
  return target;
}

async function captureMapSelectionPng(selectionTarget) {
  const region = selectionTarget?.selection?.world;
  const width = Number(region?.width);
  const height = Number(region?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("地图选区截图尺寸无效");
  }
  const extracted = state.viewer.captureWorldRect(region, { resolution: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("浏览器无法创建地图选区截图画布");
  context.clearRect(0, 0, width, height);
  context.drawImage(extracted, 0, 0, width, height);
  return canvasPngInput(canvas, "source");
}

async function canvasPngInput(canvas, kind) {
  const blob = typeof canvas.convertToBlob === "function"
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("地图选区 PNG 编码失败")),
      "image/png",
    ));
  return {
    kind,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
    mediaType: "image/png",
  };
}

async function browserImageInput(blob, kind, name = "图片") {
  const extension = String(name || "").split(".").at(-1)?.toLowerCase();
  const inferred = extension === "png"
    ? "image/png"
    : ["jpg", "jpeg"].includes(extension)
      ? "image/jpeg"
      : extension === "webp" ? "image/webp" : "";
  const declared = String(blob?.type || "").toLowerCase();
  const mediaType = declared.startsWith("image/") ? declared : inferred;
  const allowed = kind === "mask"
    ? new Set(["image/png"])
    : new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(mediaType)) {
    throw new Error(kind === "mask" ? `${name} 必须是 PNG 蒙版` : `${name} 必须是 PNG、JPEG 或 WebP`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.byteLength) throw new Error(`${name} 内容为空`);
  if (kind === "mask" && !pngHasAlphaChannel(bytes)) {
    throw new Error(`${name} 必须是包含 alpha 通道的 PNG 蒙版`);
  }
  try {
    const dimensions = await imageBlobDimensions(blob);
    return { kind, bytes, width: dimensions.width, height: dimensions.height, mediaType };
  } catch (error) {
    throw new Error(`${name} 不是浏览器可解码的图片：${error.message}`);
  }
}

async function cropBrowserImageInput(input, crop) {
  const left = Number(crop?.left || 0);
  const top = Number(crop?.top || 0);
  const right = Number(crop?.right || 0);
  const bottom = Number(crop?.bottom || 0);
  const width = Number(input?.width) - left - right;
  const height = Number(input?.height) - top - bottom;
  if (![left, top, right, bottom].every(Number.isSafeInteger)
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1) {
    throw new Error("裁剪边界与源图尺寸不匹配");
  }
  const blob = new Blob([input.bytes], { type: input.mediaType });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("浏览器无法创建裁剪画布");
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
    } finally {
      bitmap.close?.();
    }
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const value = new Image();
        value.onload = () => resolve(value);
        value.onerror = () => reject(new Error("裁剪源图解码失败"));
        value.src = url;
      });
      context.drawImage(image, left, top, width, height, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return canvasPngInput(canvas, "source");
}

async function imageBlobDimensions(blob) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1) {
        throw new Error("尺寸无效");
      }
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close?.();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const value = new Image();
      value.onload = () => resolve(value);
      value.onerror = () => reject(new Error("图片解码失败"));
      value.src = url;
    });
    if (!Number.isSafeInteger(image.naturalWidth) || !Number.isSafeInteger(image.naturalHeight)
      || image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error("尺寸无效");
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pngHasAlphaChannel(bytes) {
  if (bytes.byteLength < 33
    || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return false;
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  if (colorType !== 3) return false;
  for (let offset = 8; offset + 12 <= bytes.byteLength;) {
    const length = ((bytes[offset] << 24) >>> 0)
      + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8)
      + bytes[offset + 3];
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) return false;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === "tRNS") return true;
    if (type === "IEND") return false;
    offset = end;
  }
  return false;
}

async function projectImageTemporaryInput(projectPath, kind) {
  const blob = await loadResourceBlob(projectPath);
  return browserImageInput(blob, kind, projectPath);
}

function assertMapImageMaskDimensions(source, mask) {
  if (!mask) return;
  if (source.mediaType !== mask.mediaType) {
    throw new Error(`蒙版格式必须与源图一致；当前源图为 ${source.mediaType}，PNG-only 蒙版不能与 JPEG/WebP 源图配对，请先将源图转换为 PNG`);
  }
  if (source.width !== mask.width || source.height !== mask.height) {
    throw new Error(`蒙版尺寸 ${mask.width}×${mask.height} 必须与源图 ${source.width}×${source.height} 完全一致`);
  }
}

async function uploadMapImageTemporaryInput(input, editorStateId) {
  const totalHash = await sha256Hex(input.bytes);
  let created = null;
  try {
    const started = await mapMutation(`/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-inputs`, {
      method: "POST",
      action: "map-image-input-start",
      json: {
        expectedVersion: state.session.version,
        editorStateId,
        kind: input.kind,
        mediaType: input.mediaType,
        totalBytes: input.bytes.byteLength,
        totalHash,
        width: input.width,
        height: input.height,
      },
    });
    created = started.input;
    for (let index = 0; index < created.chunkCount; index += 1) {
      const start = index * created.chunkBytes;
      const chunk = input.bytes.subarray(start, Math.min(input.bytes.byteLength, start + created.chunkBytes));
      await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-inputs/${encodeURIComponent(created.id)}/chunks/${index}`,
        {
          method: "PUT",
          action: "map-image-input-chunk",
          body: chunk,
          contentType: "application/octet-stream",
          headers: {
            "X-Content-SHA256": await sha256Hex(chunk),
            "X-Codex-Desktop-Editor-State": String(editorStateId),
          },
        },
      );
    }
    const committed = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-inputs/${encodeURIComponent(created.id)}/commit`,
      { method: "POST", action: "map-image-input-commit", json: { editorStateId } },
    );
    return committed.input;
  } catch (error) {
    if (created?.id) await deleteMapImageTemporaryInput(created.id, editorStateId).catch(() => {});
    throw error;
  }
}

async function deleteMapImageTemporaryInput(inputId, editorStateId) {
  return mapMutation(
    `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-inputs/${encodeURIComponent(inputId)}`,
    {
      method: "DELETE",
      action: "map-image-input-delete",
      headers: { "X-Codex-Desktop-Editor-State": String(editorStateId) },
    },
  );
}

async function createMapImageCandidate() {
  const operation = currentMapImageOperation();
  const localCrop = operation === "outpaint" && state.mapImageBoundaryPlan?.localCrop === true;
  if (!state.session?.writable || (!localCrop && !mapImageWorkerReady(operation)) || state.mapImageStarting) return;
  state.mapImageStarting = true;
  updateMapImageControls();
  setMapImageMessage(localCrop ? "正在创建本地裁剪候选" : "正在排队生成候选");
  let temporaryInputs = null;
  let temporaryInputsAdmitted = false;
  let editorStateId = state.editor?.headStateId ?? 0;
  try {
    const boundary = operation === "outpaint" ? state.mapImageBoundaryPlan?.boundary : null;
    if (operation === "outpaint" && !state.mapImageBoundaryPlan?.ready) {
      throw new Error(elements.mapImageBoundaryState.textContent || "请先完成裁剪/扩图边界设置");
    }
    const selectionTarget = state.mapImageUseSelection && operation !== "generate" && !localCrop
      ? selectionImageTargetForOperation(operation)
      : null;
    if (selectionTarget && boundary?.hasCrop) {
      throw new Error("地图瓦片选区不接受像素级内裁剪；请调整选区本身，或改用工程图片源");
    }
    editorStateId = selectionTarget?.map?.editorStateId ?? editorStateId;
    const hasMaskSelection = Boolean(state.mapImageMaskFile || state.mapImageMaskPath);
    if (operation === "outpaint" && hasMaskSelection) {
      throw new Error("扩图不使用编辑蒙版，请先清除已选择的蒙版");
    }
    if (operation === "edit" && state.mapImageConfig.capabilities.strictMask === true && !hasMaskSelection) {
      throw new Error("严格蒙版编辑必须显式选择本地或工程 PNG 蒙版；不会自动创建全透明蒙版");
    }
    if (operation === "edit" && !selectionTarget && !state.mapImageSourceFile
      && state.mapImageSourcePaths.length !== 1) {
      throw new Error("编辑操作必须先选择一张工程源图、选择本地源图，或使用当前地图选区截图");
    }
    const useTemporaryInputs = operation !== "generate"
      && Boolean(selectionTarget || state.mapImageSourceFile || state.mapImageMaskFile || boundary?.hasCrop);
    if (useTemporaryInputs) {
      setMapImageMessage(selectionTarget ? "正在截取当前地图选区" : "正在校验临时源图片");
      let source = selectionTarget
        ? await captureMapSelectionPng(selectionTarget)
        : state.mapImageSourceFile
          ? await browserImageInput(state.mapImageSourceFile, "source", state.mapImageSourceFile.name)
          : await projectImageTemporaryInput(state.mapImageSourcePaths[0], "source");
      if (boundary?.hasCrop) source = await cropBrowserImageInput(source, boundary.crop);
      let mask = null;
      if (operation === "edit") {
        if (state.mapImageMaskFile) mask = await browserImageInput(state.mapImageMaskFile, "mask", state.mapImageMaskFile.name);
        else if (state.mapImageMaskPath) mask = await projectImageTemporaryInput(state.mapImageMaskPath, "mask");
        assertMapImageMaskDimensions(source, mask);
      }
      setMapImageMessage("正在分块上传临时源图片");
      temporaryInputs = {
        sourceInput: await uploadMapImageTemporaryInput(source, editorStateId),
        maskInput: null,
      };
      if (mask) {
        setMapImageMessage("正在分块上传临时蒙版");
        temporaryInputs.maskInput = await uploadMapImageTemporaryInput(mask, editorStateId);
      }
    }
    const common = {
      prompt: elements.mapImagePrompt.value,
      size: elements.mapImageSize.value,
      quality: elements.mapImageQuality.value,
    };
    const request = localCrop
      ? buildMapImageCropRequest({
          sourceSize: boundary.source,
          sourceCrop: boundary.crop,
        }, { temporaryInputCount: temporaryInputs?.sourceInput ? 1 : 0 })
      : operation === "generate"
      ? buildMapImageCandidateRequest({ kind: elements.mapImageKind.value, ...common }, state.mapImageConfig)
      : operation === "edit"
        ? buildMapImageEditRequest({
          ...common,
          sourcePaths: state.mapImageSourcePaths,
          maskPath: state.mapImageMaskPath,
          maskMode: state.mapImageConfig.capabilities.strictMask ? "strict" : "soft",
        }, state.mapImageConfig, temporaryInputs ? {
          temporaryInputCount: 1,
          hasTemporaryMask: Boolean(temporaryInputs.maskInput),
        } : {
          authorizedSourcePaths: state.mapImageSourcePaths,
          authorizedMaskPaths: state.mapImageMaskPath ? [state.mapImageMaskPath] : [],
        })
        : buildMapImageOutpaintRequest({
          ...common,
          sourcePaths: state.mapImageSourcePaths,
          sourceCrop: boundary?.hasCrop ? boundary.crop : undefined,
          outpaint: boundary?.outpaint,
          preserveSource: elements.mapImagePreserveSource.value,
          blendMargin: elements.mapImageBlendMargin.value,
          alignmentPolicy: elements.mapImageAlignmentPolicy.value,
        }, state.mapImageConfig, temporaryInputs
          ? { temporaryInputCount: 1 }
          : { authorizedSourcePaths: state.mapImageSourcePaths });
    const started = await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-jobs`,
        {
          method: "POST",
          action: "map-image-start",
          json: {
            expectedVersion: state.session.version,
            editorStateId,
            request,
            ...(selectionTarget ? { selectionTarget } : {}),
            ...(temporaryInputs ? {
              inputs: {
                sourceInputIds: [temporaryInputs.sourceInput.id],
                ...(temporaryInputs.maskInput ? { maskInputId: temporaryInputs.maskInput.id } : {}),
              },
            } : {}),
          },
        },
    );
    if (selectionTarget && started?.job?.id) {
      state.mapImageSelectionTargets.set(started.job.id, selectionTarget);
    }
    temporaryInputsAdmitted = true;
    setMapImageMessage(localCrop
      ? "裁剪候选处理中；完成后请明确发布或丢弃"
      : "候选生成中；完成后请明确发布或丢弃");
    await refreshMapImageJobs({ silent: true });
  } catch (error) {
    if (temporaryInputs && !temporaryInputsAdmitted) {
      await Promise.allSettled([
        temporaryInputs.sourceInput,
        temporaryInputs.maskInput,
      ].filter(Boolean).map((input) => deleteMapImageTemporaryInput(input.id, editorStateId)));
    }
    setMapImageMessage(error.message, "error");
  } finally {
    state.mapImageStarting = false;
    updateMapImageControls();
  }
}

function mapImageJobKind(job) {
  if (["plant", "prop", "tileset", "terrain", "background"].includes(job?.request?.assetKind)) {
    return job.request.assetKind;
  }
  if (job?.request?.operation === "crop") return "crop";
  if (job?.request?.operation === "edit") return "edit";
  if (job?.request?.operation === "outpaint") return "outpaint";
  return /tileset atlas/u.test(String(job?.request?.prompt || "")) ? "tileset" : "prop";
}

function mapImageKindLabel(kind) {
  if (kind === "crop") return "裁剪派生";
  if (kind === "edit") return "图片编辑";
  if (kind === "outpaint") return "边界扩图";
  try {
    return mapImageAssetPreset(kind).label;
  } catch {
    return "地图图片";
  }
}

function mapImageStatusLabel(status) {
  return ({
    queued: "排队中", running: "处理中", publishing: "发布中", succeeded: "待处理",
    published: "已发布", failed: "失败", canceled: "已取消", expired: "已清理",
  })[status] || status || "未知";
}

function mapImageJobStaleReason(job) {
  if (state.session?.version && job?.mapVersion && job.mapVersion !== state.session.version) {
    return "地图版本已变化";
  }
  // editorStateId is a tab-local history sequence and resets to zero after a
  // clean reload. The persisted map version is authoritative across reloads;
  // within a live tab, any unsaved edit makes a selection-derived job stale.
  if (job?.selectionTarget && state.editor?.dirty) {
    return "编辑状态已变化";
  }
  return "";
}

function renderMapImageJobs() {
  if (!elements.mapImageJobList) return;
  if (!state.mapImageJobs.length) {
    const empty = document.createElement("p");
    empty.className = "map-image-empty";
    empty.textContent = "暂无候选任务";
    elements.mapImageJobList.replaceChildren(empty);
    updateMapImageControls();
    return;
  }
  const fragment = document.createDocumentFragment();
  const activeKeys = new Set();
  for (const job of state.mapImageJobs) {
    const staleReason = mapImageJobStaleReason(job);
    const stale = Boolean(staleReason);
    const card = document.createElement("article");
    card.className = "map-image-job";
    card.dataset.jobId = job.id;
    const heading = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = `${mapImageKindLabel(mapImageJobKind(job))} · ${mapImageStatusLabel(job.status)}${stale ? ` · ${staleReason}` : ""}`;
    const meta = document.createElement("span");
    meta.textContent = formatRenderTime(job.createdAt);
    heading.append(title, meta);
    card.append(heading);
    const prompt = document.createElement("p");
    prompt.className = "map-image-job-prompt";
    prompt.textContent = String(job.request?.prompt || "").split("\n\n")[0];
    card.append(prompt);
    if (job.error?.message) {
      const error = document.createElement("p");
      error.className = "map-image-job-error";
      error.textContent = job.error.message;
      card.append(error);
      const diagnostic = mapImageJobDiagnostic(job.error);
      if (diagnostic) {
        const detail = document.createElement("small");
        detail.className = "map-image-job-diagnostic";
        detail.textContent = diagnostic;
        card.append(detail);
      }
    }
    if (Array.isArray(job.candidate?.files)) {
      const files = document.createElement("div");
      files.className = "map-image-candidates";
      for (const file of job.candidate.files) {
        const key = `${job.id}:${file.index}:${file.sha256 || ""}`;
        activeKeys.add(key);
        if (stale && state.mapImagePreviewUrls.has(key)) {
          URL.revokeObjectURL(state.mapImagePreviewUrls.get(key));
          state.mapImagePreviewUrls.delete(key);
        }
        files.append(renderMapImageCandidate(job, file, key, staleReason));
        if (!stale && !state.mapImagePreviewUrls.has(key) && !state.mapImagePreviewLoading.has(key)) {
          void loadMapImagePreview(job, file, key);
        }
      }
      card.append(files);
      if (job.candidate.files.length > 1 && !stale) {
        card.append(renderMapImageComparison(job));
      }
    }
    fragment.append(card);
  }
  for (const [key, url] of state.mapImagePreviewUrls) {
    if (!activeKeys.has(key)) {
      URL.revokeObjectURL(url);
      state.mapImagePreviewUrls.delete(key);
    }
  }
  elements.mapImageJobList.replaceChildren(fragment);
  refreshIcons();
  updateMapImageControls();
}

function mapImageJobDiagnostic(error) {
  if (!error || typeof error !== "object") return "";
  const parts = [];
  if (typeof error.code === "string" && error.code) parts.push(error.code);
  if (typeof error.operation === "string" && error.operation) parts.push(`操作：${error.operation}`);
  if (typeof error.stage === "string" && error.stage) parts.push(`阶段：${error.stage}`);
  if (typeof error.requestedSize === "string" && error.requestedSize) parts.push(`请求：${error.requestedSize}`);
  if (typeof error.providerSize === "string" && error.providerSize) parts.push(`供应商画布：${error.providerSize}`);
  if (typeof error.sourceSize === "string" && error.sourceSize) parts.push(`源图：${error.sourceSize}`);
  if (Array.isArray(error.supportedSizes) && error.supportedSizes.length) {
    parts.push(`支持：${error.supportedSizes.slice(0, 8).join("、")}`);
  }
  if (typeof error.providerRequestId === "string" && error.providerRequestId) {
    parts.push(`请求 ID：${error.providerRequestId}`);
  }
  if (error.retryable === true) parts.push("可重试");
  return parts.join(" · ");
}

function renderMapImageCandidate(job, file, key, staleReason = "") {
  const stale = Boolean(staleReason);
  const item = document.createElement("article");
  item.className = "map-image-candidate";
  item.dataset.candidateKey = key;
  const preview = document.createElement("div");
  preview.className = "map-image-preview";
  const image = document.createElement("img");
  image.alt = `${mapImageKindLabel(mapImageJobKind(job))}候选`;
  const objectUrl = state.mapImagePreviewUrls.get(key);
  if (objectUrl) image.src = objectUrl;
  else {
    image.className = "is-loading";
    image.alt = "正在加载候选预览";
  }
  preview.append(image);
  item.append(preview);
  const info = document.createElement("p");
  info.className = "map-image-file-meta";
  info.textContent = `${file.width || "?"} × ${file.height || "?"} · ${file.format || "png"} · ${formatBytes(file.size || 0)} · ${(file.sha256 || "").slice(0, 12)}`;
  item.append(info);
  const published = job.published?.find((entry) => (
    (entry.artifactType === undefined || entry.artifactType === "image")
    && Number(entry.index) === Number(file.index)
  ));
  if (stale) {
    const warning = document.createElement("p");
    warning.className = "map-image-job-error";
    warning.textContent = `此候选${staleReason}，不能预览、发布或应用；如仍需要请重新生成`;
    item.append(warning);
  }
  if (published?.relativePath) {
    const publishedPath = document.createElement("code");
    publishedPath.className = "map-image-published-path";
    publishedPath.textContent = `已发布：${published.relativePath}`;
    item.append(publishedPath);
    const companions = (job.published || []).filter((entry) => (
      ["tileset", "composite"].includes(entry.artifactType)
      && Number(entry.sourceIndex) === Number(file.index)
    ));
    for (const companion of companions) {
      const companionPath = document.createElement("code");
      companionPath.className = "map-image-published-path";
      companionPath.textContent = `${companion.artifactType === "tileset" ? "外部 TSJ" : "组合素材 TMJ"}：${companion.relativePath}`;
      item.append(companionPath);
    }
    const actions = document.createElement("div");
    actions.className = "map-image-candidate-actions map-image-apply-actions";
    const imageApplicationId = publishedMapImageApplicationId(job, published, "image-layer");
    const imageApplied = mapImageApplicationExists(imageApplicationId, "image-layer");
    const applyImage = document.createElement("button");
    applyImage.type = "button";
    applyImage.className = "primary-button";
    applyImage.dataset.mapImageApply = "image-layer";
    applyImage.textContent = imageApplied ? "已加入图片层" : "加入新图片层";
    applyImage.disabled = imageApplied || state.mapImageApplying.size > 0
      || !state.session?.writable || stale || state.layerTreeRebuildRunning;
    applyImage.addEventListener("click", () => void applyPublishedMapImage(job, published, "image-layer"));
    actions.append(applyImage);
    const replaceApplicationId = publishedMapImageApplicationId(job, published, "image-layer-replace");
    const activeImageLayer = state.editor?.layerById(state.activeLayerId);
    const replaceImage = document.createElement("button");
    replaceImage.type = "button";
    replaceImage.className = "secondary-button";
    replaceImage.dataset.mapImageApply = "image-layer-replace";
    replaceImage.textContent = "替换当前图片层";
    replaceImage.disabled = activeImageLayer?.type !== "imagelayer"
      || activeImageLayer.locked === true
      || tiledValueHasMapImageApplication(activeImageLayer, replaceApplicationId)
      || state.mapImageApplying.size > 0
      || !state.session?.writable || stale || state.layerTreeRebuildRunning;
    replaceImage.title = activeImageLayer?.type === "imagelayer"
      ? "只替换图片引用，保留当前图层位置和其他 Tiled 字段"
      : "请先在图层面板选择一个图片层";
    replaceImage.addEventListener("click", () => void applyPublishedMapImage(
      job,
      published,
      "image-layer-replace",
      state.activeLayerId,
    ));
    actions.append(replaceImage);
    const tileObjectApplicationId = publishedMapImageApplicationId(job, published, "tile-object");
    const tileObjectApplied = mapImageApplicationExists(tileObjectApplicationId, "tile-object");
    const createTileObject = document.createElement("button");
    createTileObject.type = "button";
    createTileObject.className = "secondary-button";
    createTileObject.dataset.mapImageApply = "tile-object";
    createTileObject.textContent = tileObjectApplied ? "已创建可变换对象" : "创建可缩放对象";
    createTileObject.disabled = tileObjectApplied || state.mapImageApplying.size > 0
      || !state.session?.writable || stale || state.layerTreeRebuildRunning;
    createTileObject.title = "创建 Tiled 原生 tile object，可继续调整宽、高和旋转";
    createTileObject.addEventListener("click", () => void applyPublishedMapImage(job, published, "tile-object"));
    actions.append(createTileObject);
    if (mapImageJobKind(job) === "tileset") {
      const tilesetApplicationId = publishedMapImageApplicationId(job, published, "tileset-draft");
      const tilesetApplied = mapImageApplicationExists(tilesetApplicationId, "tileset-draft");
      const applyTileset = document.createElement("button");
      applyTileset.type = "button";
      applyTileset.className = "secondary-button";
      applyTileset.dataset.mapImageApply = "tileset-draft";
      applyTileset.textContent = tilesetApplied ? "已加入瓦片集草稿" : "加入瓦片集草稿";
      try {
        planMapImageTilesetDraft(job, published);
        applyTileset.disabled = tilesetApplied || state.mapImageApplying.size > 0
          || !state.session?.writable || stale || state.layerTreeRebuildRunning;
      } catch (error) {
        applyTileset.disabled = true;
        applyTileset.title = error.message;
      }
      applyTileset.addEventListener("click", () => void applyPublishedMapImage(job, published, "tileset-draft"));
      actions.append(applyTileset);
    }
    item.append(actions);
  } else {
    const existingDraft = state.mapImagePublishDrafts.get(key);
    const defaultImagePath = suggestedMapImagePublishPath(mapImageJobKind(job));
    const draft = existingDraft && typeof existingDraft === "object"
      ? existingDraft
      : {
          mode: "image",
          imagePath: typeof existingDraft === "string" ? existingDraft : defaultImagePath,
          companionPath: "",
          name: "",
          tileWidth: Number(state.document?.tilewidth || 32),
          tileHeight: Number(state.document?.tileheight || 32),
          margin: 0,
          spacing: 0,
        };
    state.mapImagePublishDrafts.set(key, draft);
    const modeField = document.createElement("label");
    modeField.className = "map-image-publish-field";
    const modeLabel = document.createElement("span");
    modeLabel.textContent = "发布形式";
    const mode = document.createElement("select");
    mode.className = "map-image-publish-mode";
    const modes = [
      ["image", "仅图片"],
      ...(mapImageJobKind(job) === "tileset" ? [["tileset-atlas", "图片 + 外部 TSJ"]] : []),
      ["composite-map", "图片 + 组合素材 TMJ"],
    ];
    for (const [value, label] of modes) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      mode.append(option);
    }
    if (!modes.some(([value]) => value === draft.mode)) draft.mode = "image";
    mode.value = draft.mode;
    modeField.append(modeLabel, mode);
    item.append(modeField);
    const path = document.createElement("input");
    path.className = "map-image-publish-path";
    path.type = "text";
    path.inputMode = "text";
    path.placeholder = "工程相对路径，例如 assets/generated/props/tree.png";
    path.value = draft.imagePath || defaultImagePath;
    draft.imagePath = path.value;
    path.addEventListener("input", () => {
      const previousSuggestion = draft.mode === "image" ? "" : suggestedMapImageCompanionPath(draft.imagePath, draft.mode);
      draft.imagePath = path.value;
      if (draft.mode !== "image" && (!draft.companionPath || draft.companionPath === previousSuggestion)) {
        try { draft.companionPath = suggestedMapImageCompanionPath(draft.imagePath, draft.mode); } catch { draft.companionPath = ""; }
        const companionInput = item.querySelector(".map-image-companion-path");
        if (companionInput) companionInput.value = draft.companionPath;
      }
    });
    item.append(path);
    const companionFields = renderMapImageCompanionFields(draft, file);
    item.append(companionFields);
    mode.addEventListener("change", () => {
      draft.mode = mode.value;
      if (draft.mode !== "image") {
        try { draft.companionPath = suggestedMapImageCompanionPath(draft.imagePath, draft.mode); } catch { draft.companionPath = ""; }
      }
      renderMapImageJobs();
    });
    const confirm = document.createElement("label");
    confirm.className = "map-image-publish-confirm";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.publishConfirm = "true";
    const text = document.createElement("span");
    text.textContent = draft.mode === "image"
      ? "我确认将这张候选图发布到上述路径"
      : "我确认一次发布上述图片和 Tiled 附属文件；任一文件失败时整批回滚";
    confirm.append(checkbox, text);
    item.append(confirm);
    const actions = document.createElement("div");
    actions.className = "map-image-candidate-actions";
    const publish = document.createElement("button");
    publish.type = "button";
    publish.className = "primary-button";
    publish.dataset.mapImagePublish = "true";
    publish.textContent = state.mapImagePublishing.has(job.id) ? "发布中…" : "明确发布";
    publish.disabled = state.mapImagePublishing.has(job.id) || !state.session?.writable || stale;
    publish.addEventListener("click", () => void publishMapImageCandidate(job, file, item));
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "secondary-button is-danger";
    discard.dataset.mapImageDiscard = "true";
    discard.textContent = state.mapImageDiscarding.has(job.id) ? "丢弃中…" : "丢弃候选";
    discard.disabled = state.mapImageDiscarding.has(job.id);
    discard.addEventListener("click", () => void discardMapImageCandidate(job));
    actions.append(publish, discard);
    item.append(actions);
  }
  return item;
}

function renderMapImageComparison(job) {
  const files = job.candidate.files;
  const indexes = files.map((file) => file.index);
  const previous = state.mapImageComparisons.get(job.id) || {};
  const comparison = {
    left: indexes.includes(previous.left) ? previous.left : indexes[0],
    right: indexes.includes(previous.right) && previous.right !== indexes[0] ? previous.right : indexes[1],
    mode: previous.mode === "overlay" ? "overlay" : "side-by-side",
    split: Number.isFinite(previous.split) ? Math.max(0, Math.min(100, previous.split)) : 50,
  };
  if (comparison.left === comparison.right) {
    comparison.right = indexes.find((index) => index !== comparison.left) ?? indexes[1];
  }
  state.mapImageComparisons.set(job.id, comparison);
  const section = document.createElement("section");
  section.className = "map-image-comparison";
  const controls = document.createElement("div");
  controls.className = "map-image-comparison-controls";
  const makeCandidateSelect = (side, labelText) => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = labelText;
    const select = document.createElement("select");
    for (const file of files) {
      const option = document.createElement("option");
      option.value = String(file.index);
      option.textContent = `候选 ${Number(file.index) + 1} · ${file.width}x${file.height}`;
      select.append(option);
    }
    select.value = String(comparison[side]);
    select.addEventListener("change", () => {
      comparison[side] = Number(select.value);
      if (comparison.left === comparison.right) {
        const otherSide = side === "left" ? "right" : "left";
        comparison[otherSide] = indexes.find((index) => index !== comparison[side]) ?? comparison[otherSide];
      }
      renderMapImageJobs();
    });
    label.append(text, select);
    return label;
  };
  controls.append(makeCandidateSelect("left", "候选 A"), makeCandidateSelect("right", "候选 B"));
  const modeLabel = document.createElement("label");
  const modeText = document.createElement("span");
  modeText.textContent = "比较方式";
  const mode = document.createElement("select");
  for (const [value, label] of [["side-by-side", "并排"], ["overlay", "滑动叠加"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }
  mode.value = comparison.mode;
  mode.addEventListener("change", () => {
    comparison.mode = mode.value;
    renderMapImageJobs();
  });
  modeLabel.append(modeText, mode);
  controls.append(modeLabel);
  section.append(controls);

  const imageUrl = (index) => {
    const file = files.find((entry) => entry.index === index);
    return file ? state.mapImagePreviewUrls.get(`${job.id}:${file.index}:${file.sha256 || ""}`) || "" : "";
  };
  const leftUrl = imageUrl(comparison.left);
  const rightUrl = imageUrl(comparison.right);
  const viewport = document.createElement("div");
  viewport.className = `map-image-comparison-viewport is-${comparison.mode}`;
  viewport.style.setProperty("--map-image-comparison-split", `${comparison.split}%`);
  for (const [side, url] of [["left", leftUrl], ["right", rightUrl]]) {
    const figure = document.createElement("figure");
    figure.className = `is-${side}`;
    const image = document.createElement("img");
    image.alt = `${side === "left" ? "候选 A" : "候选 B"} 对比预览`;
    if (url) image.src = url;
    else image.className = "is-loading";
    const caption = document.createElement("figcaption");
    caption.textContent = side === "left" ? "A" : "B";
    figure.append(image, caption);
    viewport.append(figure);
  }
  section.append(viewport);
  if (comparison.mode === "overlay") {
    const sliderLabel = document.createElement("label");
    sliderLabel.className = "map-image-comparison-slider";
    const sliderText = document.createElement("span");
    sliderText.textContent = "分界";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(comparison.split);
    slider.addEventListener("input", () => {
      comparison.split = Number(slider.value);
      viewport.style.setProperty("--map-image-comparison-split", `${comparison.split}%`);
    });
    sliderLabel.append(sliderText, slider);
    section.append(sliderLabel);
  }
  return section;
}

function renderMapImageCompanionFields(draft) {
  const fields = document.createElement("div");
  fields.className = "map-image-companion-fields";
  fields.hidden = draft.mode === "image";
  if (draft.mode === "image") return fields;
  if (!draft.companionPath) {
    try { draft.companionPath = suggestedMapImageCompanionPath(draft.imagePath, draft.mode); } catch { draft.companionPath = ""; }
  }
  const definitions = [
    ["附属文件", "map-image-companion-path", draft.companionPath, "text", (value) => { draft.companionPath = value; }],
    ["素材名称", "map-image-companion-name", draft.name, "text", (value) => { draft.name = value; }],
    ["瓦片宽", "map-image-tile-width", draft.tileWidth, "number", (value) => { draft.tileWidth = value; }],
    ["瓦片高", "map-image-tile-height", draft.tileHeight, "number", (value) => { draft.tileHeight = value; }],
  ];
  if (draft.mode === "tileset-atlas") {
    definitions.push(
      ["图集边距", "map-image-atlas-margin", draft.margin, "number", (value) => { draft.margin = value; }],
      ["瓦片间距", "map-image-atlas-spacing", draft.spacing, "number", (value) => { draft.spacing = value; }],
    );
  }
  for (const [labelText, className, value, type, update] of definitions) {
    const field = document.createElement("label");
    field.className = "map-image-publish-field";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.className = className;
    input.type = type;
    input.value = value ?? "";
    if (type === "number") {
      input.min = labelText.includes("边距") || labelText.includes("间距") ? "0" : "1";
      input.max = "16384";
      input.step = "1";
      input.inputMode = "numeric";
    }
    input.addEventListener("input", () => update(input.value));
    field.append(label, input);
    fields.append(field);
  }
  return fields;
}

function mapImageApplicationExists(applicationId, kind) {
  if (!applicationId || !state.editor?.document) return false;
  if (kind === "tileset-draft") {
    return (state.editor.document.tilesets || []).some((tileset) => (
      tiledValueHasMapImageApplication(tileset, applicationId)
    ));
  }
  const pending = [...(state.editor.document.layers || [])];
  while (pending.length) {
    const layer = pending.shift();
    if (tiledValueHasMapImageApplication(layer, applicationId)) return true;
    if (kind === "tile-object" && Array.isArray(layer?.objects)
      && layer.objects.some((object) => tiledValueHasMapImageApplication(object, applicationId))) return true;
    if (Array.isArray(layer?.layers)) pending.push(...layer.layers);
  }
  return false;
}

function planMapImageTilesetDraft(job, published) {
  return planPublishedMapTilesetDraft({
    mapPath: state.session.relativePath,
    published,
    job,
    document: state.editor.document,
    existingTilesets: currentMapTilesetDescriptors(),
  });
}

function applyPublishedMapImage(job, published, kind, targetLayerId = null) {
  if (!state.session?.writable || state.layerTreeRebuildRunning) return;
  const staleReason = mapImageJobStaleReason(job);
  if (staleReason) {
    setMapImageMessage(`${staleReason}，不能应用旧候选`, "error");
    return;
  }
  const applicationId = publishedMapImageApplicationId(job, published, kind);
  const applyKey = kind === "image-layer-replace" ? `${applicationId}:${targetLayerId}` : applicationId;
  if (!applicationId || state.mapImageApplying.has(applyKey)
    || (kind === "image-layer-replace"
      ? tiledValueHasMapImageApplication(state.editor?.layerById(targetLayerId), applicationId)
      : mapImageApplicationExists(applicationId, kind))) return;
  state.mapImageApplying.add(applyKey);
  renderMapImageJobs();
  const queued = state.mapImageApplyQueue
    .catch(() => {})
    .then(() => performPublishedMapImageApplication(
      job,
      published,
      kind,
      applicationId,
      applyKey,
      targetLayerId,
    ));
  state.mapImageApplyQueue = queued.catch(() => {});
  return queued;
}

async function performPublishedMapImageApplication(
  job,
  published,
  kind,
  applicationId,
  applyKey,
  targetLayerId,
) {
  try {
    const granted = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
      {
        method: "POST",
        action: "map-resource-grant",
        json: {
          resourcePath: published.relativePath,
          expectedKind: "image",
          expectedVersion: state.session.version,
        },
      },
    );
    if (!state.session?.writable || job.mapVersion !== state.session.version) {
      throw new Error("地图版本在素材授权期间发生变化，候选未应用");
    }
    const staleReason = mapImageJobStaleReason(job);
    if (staleReason) throw new Error(`${staleReason}，候选未应用`);
    if (kind === "image-layer-replace") {
      if (tiledValueHasMapImageApplication(state.editor?.layerById(targetLayerId), applicationId)) return;
    } else if (mapImageApplicationExists(applicationId, kind)) return;
    const authorizedImage = validatePublishedMapImageGrant(published, granted?.resource);
    if (kind === "tileset-draft") {
      const plan = planMapImageTilesetDraft(job, authorizedImage);
      state.editor.addTileset(plan.reference, { label: "应用 AI 瓦片集草稿" });
      setMapImageMessage(
        `已将外部图片加入瓦片集草稿（GID ${plan.firstgid}-${plan.lastgid}）；已进入撤销栈，尚未保存地图`,
        "ready",
      );
    } else if (kind === "image-layer-replace") {
      const targetLayer = state.editor?.layerById(targetLayerId);
      const plan = planPublishedMapImageLayerReplacement({
        mapPath: state.session.relativePath,
        published: authorizedImage,
        job,
        layer: targetLayer,
      });
      state.editor.updateLayer(plan.layerId, plan.changes, { label: "替换图片层素材" });
      state.preferredActiveLayerId = plan.layerId;
      setMapImageMessage("已替换当前图片层引用并保留图层变换；已进入撤销栈，尚未保存地图", "ready");
    } else if (kind === "tile-object") {
      const selectionTarget = state.mapImageSelectionTargets.get(job.id) || null;
      const baseName = String(authorizedImage.relativePath || "").split("/").at(-1)?.replace(/\.[^.]+$/u, "") || "AI 图片对象";
      const plan = planPublishedMapTileObject({
        mapPath: state.session.relativePath,
        published: authorizedImage,
        job,
        document: state.editor.document,
        existingTilesets: currentMapTilesetDescriptors(),
        selectionTarget,
        name: baseName,
      });
      const applied = state.editor.runBatch("创建可缩放图片对象", (editor) => {
        editor.addTileset(plan.tileset, { label: "添加单图瓦片集" });
        const layer = editor.addLayer(plan.layer, { parentId: null, label: "添加图片对象层" });
        const object = editor.addObject(layer.id, plan.object, { label: "添加图片瓦片对象" });
        return { layer, object };
      });
      state.preferredActiveLayerId = applied.result.layer.id;
      setMapImageMessage(
        `已创建 Tiled 原生瓦片对象（GID ${plan.firstgid}）；可在对象属性中调整宽、高和旋转，已进入撤销栈`,
        "ready",
      );
    } else {
      const selectionTarget = state.mapImageSelectionTargets.get(job.id) || null;
      const baseName = String(authorizedImage.relativePath || "").split("/").at(-1)?.replace(/\.[^.]+$/u, "") || "AI 图片";
      const plan = planPublishedMapImageLayer({
        mapPath: state.session.relativePath,
        published: authorizedImage,
        job,
        selectionTarget,
        name: uniqueLayerName(baseName),
      });
      const layer = state.editor.addLayer(plan.layer, {
        // selectionTarget.target.world is a root/world coordinate. Keeping
        // generated overlays at the root prevents nested group offsets from
        // being applied a second time by the Tiled renderer.
        parentId: null,
        label: "应用 AI 图片候选",
      });
      state.preferredActiveLayerId = layer.id;
      setMapImageMessage(
        plan.target
          ? `已按选区 ${plan.target.x},${plan.target.y} · ${plan.target.width}×${plan.target.height} 加入独立图片层；已进入撤销栈，尚未保存地图`
          : "已加入独立图片层；已进入撤销栈，尚未保存地图",
        "ready",
      );
    }
  } catch (error) {
    setMapImageMessage(error.message, "error");
  } finally {
    state.mapImageApplying.delete(applyKey);
    renderMapImageJobs();
  }
}

async function loadMapImagePreview(job, file, key) {
  state.mapImagePreviewLoading.add(key);
  try {
    const response = await fetch(
      `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-jobs/${encodeURIComponent(job.id)}/files/${encodeURIComponent(file.index)}`,
      { cache: "no-store", headers: mapHeaders() },
    );
    if (!response.ok) throw await responseError(response, "无法读取候选预览");
    const type = response.headers.get("content-type") || "";
    if (!/^image\//u.test(type)) throw new Error("候选预览不是受支持的图片类型");
    const blob = await response.blob();
    if (!/^image\//u.test(blob.type || type)) throw new Error("候选预览内容类型不安全");
    const url = URL.createObjectURL(blob);
    if (!elements.mapImageDialog.open) URL.revokeObjectURL(url);
    else {
      state.mapImagePreviewUrls.set(key, url);
      renderMapImageJobs();
    }
  } catch (error) {
    if (elements.mapImageDialog.open) setMapImageMessage(error.message, "error");
  } finally {
    state.mapImagePreviewLoading.delete(key);
  }
}

async function publishMapImageCandidate(job, file, item) {
  if (!state.session?.writable || state.mapImagePublishing.has(job.id)) return;
  const confirmation = item.querySelector("[data-publish-confirm]");
  if (!confirmation?.checked) {
    setMapImageMessage("请勾选确认后再发布候选图", "error");
    return;
  }
  let publication;
  try {
    publication = buildMapImagePublicationRequest({
      file,
      imagePath: item.querySelector(".map-image-publish-path")?.value,
      mode: item.querySelector(".map-image-publish-mode")?.value,
      companionPath: item.querySelector(".map-image-companion-path")?.value,
      name: item.querySelector(".map-image-companion-name")?.value,
      tileWidth: item.querySelector(".map-image-tile-width")?.value,
      tileHeight: item.querySelector(".map-image-tile-height")?.value,
      margin: item.querySelector(".map-image-atlas-margin")?.value,
      spacing: item.querySelector(".map-image-atlas-spacing")?.value,
    });
  } catch (error) {
    setMapImageMessage(error.message, "error");
    return;
  }
  state.mapImagePublishing.add(job.id);
  renderMapImageJobs();
  try {
    await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-jobs/${encodeURIComponent(job.id)}/publish`,
      {
        method: "POST",
        action: "map-image-publish",
        json: {
          confirmation: job.id,
          mapVersion: state.session.version,
          ...publication,
        },
      },
    );
    state.mapImagePublishDrafts.delete(`${job.id}:${file.index}:${file.sha256 || ""}`);
    setMapImageMessage(
      publication.companions.length
        ? `图片与 ${publication.companions[0].type === "tileset-atlas" ? "外部 TSJ" : "组合素材 TMJ"} 已作为一个事务发布`
        : `候选图已发布到 ${publication.destinations[0].path}；可继续加入新图片层${mapImageJobKind(job) === "tileset" ? "或瓦片集草稿" : ""}`,
      "ready",
    );
    await refreshMapImageJobs({ silent: true });
  } catch (error) {
    setMapImageMessage(error.message, "error");
  } finally {
    state.mapImagePublishing.delete(job.id);
    renderMapImageJobs();
  }
}

async function discardMapImageCandidate(job) {
  if (state.mapImageDiscarding.has(job.id)) return;
  state.mapImageDiscarding.add(job.id);
  renderMapImageJobs();
  try {
    await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.session.id)}/image-jobs/${encodeURIComponent(job.id)}/candidate`,
      { method: "DELETE", action: "map-image-discard" },
    );
    setMapImageMessage("候选图已丢弃", "ready");
    await refreshMapImageJobs({ silent: true });
  } catch (error) {
    setMapImageMessage(error.message, "error");
  } finally {
    state.mapImageDiscarding.delete(job.id);
    renderMapImageJobs();
  }
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the selection-based browser fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -10000px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器未允许写入剪贴板");
}

async function showGamePreviewDialog() {
  if (!state.session || state.previewLoading) return;
  state.previewLoading = true;
  state.previewEntries = [];
  state.previewEntriesLoaded = false;
  elements.gamePreviewEntry.replaceChildren();
  elements.gamePreviewEntry.disabled = true;
  elements.openGamePreviewButton.disabled = true;
  elements.gamePreviewState.textContent = "正在读取 HTML 入口";
  if (!elements.gamePreviewDialog.open) elements.gamePreviewDialog.showModal();
  try {
    await fetchPreviewEntries();
    for (const entry of state.previewEntries) {
      const option = document.createElement("option");
      option.value = entry.path;
      option.textContent = entry.path;
      elements.gamePreviewEntry.append(option);
    }
    elements.gamePreviewEntry.disabled = !state.previewEntries.length;
    elements.openGamePreviewButton.disabled = !state.previewEntries.length;
    elements.openGamePreviewButton.querySelector("span").textContent = state.editor?.dirty
      ? "保存并打开"
      : "打开预览";
    elements.gamePreviewState.textContent = state.previewEntries.length
      ? `${state.previewEntries.length} 个入口`
      : "工程中没有 HTML 入口";
  } catch (error) {
    elements.gamePreviewState.textContent = error.message;
  } finally {
    state.previewLoading = false;
  }
}

async function fetchPreviewEntries() {
  const response = await mapFetch(
    `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/preview-entries`,
  );
  state.previewEntries = Array.isArray(response.entries) ? response.entries : [];
  state.previewEntriesLoaded = true;
  return state.previewEntries;
}

async function openGamePreview() {
  const entry = elements.gamePreviewEntry.value;
  if (!entry || state.previewLoading) return;
  const previewWindow = window.open("about:blank", "_blank");
  if (!previewWindow) {
    elements.gamePreviewState.textContent = "浏览器阻止了预览窗口";
    return;
  }
  previewWindow.opener = null;
  state.previewLoading = true;
  elements.openGamePreviewButton.disabled = true;
  elements.gamePreviewEntry.disabled = true;
  elements.gamePreviewState.textContent = state.editor?.dirty ? "正在保存地图" : "正在建立预览";
  try {
    if (state.editor?.dirty && !await saveMap()) throw new Error("地图尚未保存，预览未打开");
    const preview = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/preview`,
      {
        method: "POST",
        action: "map-game-preview",
        json: { entry },
      },
    );
    previewWindow.location.replace(preview.url);
    elements.gamePreviewDialog.close();
  } catch (error) {
    previewWindow.close();
    elements.gamePreviewState.textContent = error.message;
    elements.openGamePreviewButton.disabled = false;
    elements.gamePreviewEntry.disabled = false;
  } finally {
    state.previewLoading = false;
  }
}

async function showExportDialog() {
  if (!state.session || state.renderLoading) return;
  state.renderLoading = true;
  state.renderConfig = null;
  state.renderMessage = "正在读取导出设置";
  setExportTab("create");
  renderExportKind();
  if (!elements.exportDialog.open) elements.exportDialog.showModal();
  try {
    state.renderConfig = await mapFetch("/api/maps/render-config");
    applyRenderDefaults(state.renderConfig.defaults);
    await loadRenderJobs({ quiet: true });
    state.renderMessage = "";
    renderExportKind();
  } catch (error) {
    state.renderMessage = error.message;
  } finally {
    state.renderLoading = false;
    renderExportKind();
  }
}

function setExportTab(tab) {
  const create = tab === "create";
  elements.exportCreateTab.setAttribute("aria-selected", String(create));
  elements.exportJobsTab.setAttribute("aria-selected", String(!create));
  elements.exportCreatePanel.hidden = !create;
  elements.exportJobsPanel.hidden = create;
  if (!create) scheduleRenderPolling();
}

function applyRenderDefaults(defaults = {}) {
  const preview = defaults.preview || {};
  const panorama = defaults.panorama || {};
  const tiles = defaults.tiles || {};
  const animation = defaults.animation || {};
  const video = defaults.video || {};
  setInputValue(elements.screenshotWidth, preview.width, 1280);
  setInputValue(elements.screenshotHeight, preview.height, 720);
  setInputValue(elements.gameScreenshotWidth, preview.width, 1280);
  setInputValue(elements.gameScreenshotHeight, preview.height, 720);
  setInputValue(elements.panoramaScale, panorama.scale, 1);
  elements.panoramaFormat.value = panorama.format || "png";
  setInputValue(elements.tileExportWidth, tiles.width, 1024);
  setInputValue(elements.tileExportHeight, tiles.height, 1024);
  setInputValue(elements.tileExportScale, tiles.scale, 1);
  elements.tileExportFormat.value = tiles.format || "png";
  setInputValue(elements.animationWidth, animation.width, 1280);
  setInputValue(elements.animationHeight, animation.height, 720);
  setInputValue(elements.animationFps, animation.fps, 24);
  setInputValue(elements.animationDuration, animation.durationMs, 2000);
  elements.animationFormat.value = animation.format || "png";
  setInputValue(elements.videoWidth, video.width, 1280);
  setInputValue(elements.videoHeight, video.height, 720);
  setInputValue(elements.videoFps, video.fps, 24);
  setInputValue(elements.videoDuration, video.durationMs, 3000);
  setInputValue(elements.videoCrf, video.crf, 18);
  elements.videoCodec.value = video.codec || "libvpx-vp9";
}

function setInputValue(input, value, fallback) {
  input.value = String(Number.isFinite(Number(value)) ? value : fallback);
}

function renderExportKind() {
  const kind = elements.exportKind.value;
  for (const group of document.querySelectorAll("[data-export-kinds]")) {
    const visible = group.dataset.exportKinds.split(/\s+/u).includes(kind);
    group.hidden = !visible;
    for (const control of group.querySelectorAll("input, select, button")) control.disabled = !visible;
  }
  if (kind === "game-screenshot" && !state.previewLoading && !state.previewEntriesLoaded) {
    void loadExportGameEntries();
  } else if (kind === "game-screenshot" && state.previewEntriesLoaded && !elements.exportGameEntry.options.length) {
    populateExportGameEntries();
  }
  const available = state.renderConfig?.enabled && state.renderConfig?.accepting;
  const hasGameEntry = kind !== "game-screenshot" || Boolean(elements.exportGameEntry.value);
  const hasBatchEntry = kind !== "map-batch" || exportBatchKinds().length > 0;
  elements.startExportButton.disabled = Boolean(
    state.renderLoading
    || !state.session?.writable
    || !available
    || !hasGameEntry
    || !hasBatchEntry
  );
  elements.startExportButton.querySelector("span").textContent = state.editor?.dirty
    ? "保存并创建"
    : "创建任务";
  if (state.renderLoading) elements.exportCreateState.textContent = state.renderMessage || "正在处理";
  else if (state.renderMessage) elements.exportCreateState.textContent = state.renderMessage;
  else if (!state.session?.writable) elements.exportCreateState.textContent = "当前地图为只读模式";
  else if (!state.renderConfig) elements.exportCreateState.textContent ||= "导出设置不可用";
  else if (!state.renderConfig.enabled) elements.exportCreateState.textContent = "Render Worker 已由管理员关闭";
  else if (!state.renderConfig.accepting) elements.exportCreateState.textContent = "管理员已暂停接收新任务";
  else if (kind === "game-screenshot" && !hasGameEntry) elements.exportCreateState.textContent = "工程中没有 HTML 入口";
  else if (kind === "map-batch" && !hasBatchEntry) elements.exportCreateState.textContent = "请选择至少一个输出项";
  else elements.exportCreateState.textContent = `手动预设：${renderPresetLabel(state.renderConfig.preset)}`;
}

async function loadExportGameEntries() {
  state.previewLoading = true;
  elements.exportGameEntry.replaceChildren();
  renderExportKind();
  try {
    await fetchPreviewEntries();
    populateExportGameEntries();
    state.renderMessage = "";
  } catch (error) {
    state.previewEntriesLoaded = true;
    state.renderMessage = error.message;
  } finally {
    state.previewLoading = false;
    renderExportKind();
  }
}

function populateExportGameEntries() {
  elements.exportGameEntry.replaceChildren();
  for (const entry of state.previewEntries) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = entry.path;
    elements.exportGameEntry.append(option);
  }
}

async function createRenderJob() {
  if (state.renderLoading || !state.session?.writable) return;
  if (!elements.exportForm.reportValidity()) return;
  let spec;
  try {
    spec = exportSpec(elements.exportKind.value);
  } catch (error) {
    elements.exportCreateState.textContent = error.message;
    return;
  }
  state.renderLoading = true;
  state.renderMessage = state.editor?.dirty ? "正在保存地图" : "正在创建任务";
  renderExportKind();
  try {
    if (state.editor?.dirty && !await saveMap()) {
      throw new Error("地图尚未保存，未创建导出任务");
    }
    const response = await mapMutation("/api/maps/render-jobs", {
      method: "POST",
      action: "map-render-start",
      json: {
        mapSessionId: state.session.id,
        expectedVersion: state.session.version,
        clientOperationId: crypto.randomUUID(),
        kind: elements.exportKind.value,
        outputRoot: elements.exportOutputRoot.value,
        spec,
      },
    });
    state.activeRenderJobId = response.job.id;
    state.renderJobs = [response.job, ...state.renderJobs.filter((job) => job.id !== response.job.id)];
    state.renderMessage = "";
    setExportTab("jobs");
    renderRenderJobs();
    scheduleRenderPolling();
  } catch (error) {
    state.renderMessage = error.message;
  } finally {
    state.renderLoading = false;
    renderExportKind();
  }
}

function exportSpec(kind) {
  if (kind === "map-screenshot") {
    return {
      width: numericInput(elements.screenshotWidth),
      height: numericInput(elements.screenshotHeight),
      format: elements.screenshotFormat.value,
      mode: elements.screenshotMode.value,
      scale: numericInput(elements.screenshotScale),
      offsetX: numericInput(elements.screenshotOffsetX),
      offsetY: numericInput(elements.screenshotOffsetY),
      timeMs: numericInput(elements.screenshotTime),
    };
  }
  if (kind === "game-screenshot") {
    if (!elements.exportGameEntry.value) throw new Error("请选择 HTML 入口");
    return {
      entry: elements.exportGameEntry.value,
      width: numericInput(elements.gameScreenshotWidth),
      height: numericInput(elements.gameScreenshotHeight),
      fullPage: elements.gameScreenshotFullPage.checked,
    };
  }
  if (kind === "map-panorama") {
    return {
      scale: numericInput(elements.panoramaScale),
      format: elements.panoramaFormat.value,
      timeMs: numericInput(elements.panoramaTime),
    };
  }
  if (kind === "map-tiles") {
    return {
      width: numericInput(elements.tileExportWidth),
      height: numericInput(elements.tileExportHeight),
      scale: numericInput(elements.tileExportScale),
      format: elements.tileExportFormat.value,
      timeMs: numericInput(elements.tileExportTime),
    };
  }
  if (kind === "map-animation") {
    return {
      width: numericInput(elements.animationWidth),
      height: numericInput(elements.animationHeight),
      fps: numericInput(elements.animationFps),
      durationMs: numericInput(elements.animationDuration),
      format: elements.animationFormat.value,
    };
  }
  if (kind === "map-video") {
    return {
      width: numericInput(elements.videoWidth),
      height: numericInput(elements.videoHeight),
      fps: numericInput(elements.videoFps),
      durationMs: numericInput(elements.videoDuration),
      codec: elements.videoCodec.value,
      crf: numericInput(elements.videoCrf),
    };
  }
  if (kind === "map-batch") {
    const kinds = exportBatchKinds();
    if (!kinds.length) throw new Error("请选择至少一个批量输出项");
    return {
      tasks: kinds.map((taskKind) => ({
        kind: taskKind,
        name: taskKind.replace(/^map-/u, ""),
        spec: {},
      })),
    };
  }
  throw new Error("导出类型不正确");
}

function numericInput(input) {
  if (!input || !Number.isFinite(input.valueAsNumber)) throw new Error("导出数字参数不正确");
  return input.valueAsNumber;
}

function exportBatchKinds() {
  return [...elements.exportForm.querySelectorAll('.export-batch input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

async function loadRenderJobs({ quiet = false } = {}) {
  try {
    const response = await mapFetch("/api/maps/render-jobs?limit=50");
    state.renderJobs = Array.isArray(response.jobs) ? response.jobs : [];
    if (!state.renderJobs.some((job) => job.id === state.activeRenderJobId)) {
      state.activeRenderJobId = state.renderJobs[0]?.id || null;
    }
    renderRenderJobs();
    scheduleRenderPolling();
  } catch (error) {
    if (!quiet) elements.exportJobState.textContent = error.message;
  }
}

function renderRenderJobs() {
  const fragment = document.createDocumentFragment();
  for (const job of state.renderJobs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "export-job-row";
    row.classList.toggle("is-active", job.id === state.activeRenderJobId);
    row.addEventListener("click", () => {
      state.activeRenderJobId = job.id;
      renderRenderJobs();
    });
    const summary = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = renderKindLabel(job.kind);
    const meta = document.createElement("small");
    meta.textContent = `${formatRenderTime(job.createdAt)} · ${job.outputRoot}`;
    summary.append(title, meta);
    const status = document.createElement("span");
    status.className = "export-job-status";
    status.dataset.status = job.status;
    status.textContent = renderStatusLabel(job.status);
    row.append(summary, status);
    fragment.append(row);
  }
  elements.exportJobList.replaceChildren(fragment);
  renderActiveRenderJob();
  renderTaskTray();
}

function renderActiveRenderJob() {
  const job = state.renderJobs.find((entry) => entry.id === state.activeRenderJobId) || null;
  elements.exportFileList.replaceChildren();
  elements.cancelRenderJobButton.hidden = !job || !ACTIVE_RENDER_STATUSES.has(job.status);
  elements.downloadRenderArchive.hidden = job?.status !== "succeeded";
  if (!job) {
    elements.exportJobState.textContent = "暂无导出任务";
    elements.downloadRenderArchive.removeAttribute("href");
    refreshIcons();
    return;
  }
  const detail = job.error?.message
    || job.result?.summary
    || (job.status === "queued" ? "等待可用 Worker" : renderStatusLabel(job.status));
  elements.exportJobState.textContent = `${renderKindLabel(job.kind)} · ${detail}`;
  if (job.status === "succeeded") {
    elements.downloadRenderArchive.href = renderDownloadUrl(job.id, "archive");
    const files = job.result?.files || [];
    const fragment = document.createDocumentFragment();
    for (const file of files.slice(0, RENDER_FILE_DISPLAY_LIMIT)) {
      const link = document.createElement("a");
      link.className = "export-file-link";
      link.href = renderDownloadUrl(job.id, "file", file.path);
      link.download = file.path.split("/").at(-1) || "render-output";
      const name = document.createElement("span");
      name.textContent = file.path;
      const size = document.createElement("span");
      size.textContent = formatBytes(file.size);
      link.append(name, size);
      fragment.append(link);
    }
    if (files.length > RENDER_FILE_DISPLAY_LIMIT) {
      const remainder = document.createElement("p");
      remainder.className = "dialog-state";
      remainder.textContent = `其余 ${files.length - RENDER_FILE_DISPLAY_LIMIT} 个文件包含在整包中`;
      fragment.append(remainder);
    }
    elements.exportFileList.replaceChildren(fragment);
  } else {
    elements.downloadRenderArchive.removeAttribute("href");
  }
  refreshIcons();
}

async function cancelActiveRenderJob() {
  const job = state.renderJobs.find((entry) => entry.id === state.activeRenderJobId);
  if (!job || !ACTIVE_RENDER_STATUSES.has(job.status)) return;
  elements.cancelRenderJobButton.disabled = true;
  try {
    const response = await mapMutation(`/api/maps/render-jobs/${encodeURIComponent(job.id)}`, {
      method: "DELETE",
      action: "map-render-cancel",
    });
    state.renderJobs = state.renderJobs.map((entry) => entry.id === response.job.id ? response.job : entry);
    renderRenderJobs();
    scheduleRenderPolling();
  } catch (error) {
    elements.exportJobState.textContent = error.message;
  } finally {
    elements.cancelRenderJobButton.disabled = false;
  }
}

function scheduleRenderPolling() {
  stopRenderPolling();
  if (
    (!taskTrayIsVisible() && (!elements.exportDialog.open || elements.exportJobsPanel.hidden))
    || !state.renderJobs.some((job) => ACTIVE_RENDER_STATUSES.has(job.status))
  ) return;
  state.renderPollTimer = window.setTimeout(() => {
    state.renderPollTimer = null;
    void loadRenderJobs();
  }, 1000);
}

function stopRenderPolling() {
  window.clearTimeout(state.renderPollTimer);
  state.renderPollTimer = null;
}

function renderDownloadUrl(jobId, resource, filePath = null) {
  const url = new URL(
    `/api/maps/render-jobs/${encodeURIComponent(jobId)}/${resource}`,
    location.origin,
  );
  url.searchParams.set("editor", state.credentials.editorInstanceId);
  if (filePath) url.searchParams.set("path", filePath);
  return `${url.pathname}${url.search}`;
}

function renderKindLabel(kind) {
  return ({
    "map-screenshot": "地图截图",
    "game-screenshot": "游戏截图",
    "map-panorama": "完整全景图",
    "map-tiles": "地图切片",
    "map-animation": "动画帧序列",
    "map-video": "视频",
    "map-batch": "批量导出",
  })[kind] || kind;
}

function renderStatusLabel(status) {
  return ({
    queued: "排队中",
    running: "渲染中",
    canceling: "取消中",
    succeeded: "已完成",
    failed: "失败",
    canceled: "已取消",
    interrupted: "已中断",
  })[status] || status;
}

function renderPresetLabel(preset) {
  return ({ stable: "稳定", balanced: "均衡", performance: "性能", custom: "自定义" })[preset] || preset;
}

function formatRenderTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function mapMutation(input, options = {}) {
  const headers = {
    ...mapHeaders(),
    "X-Codex-Desktop-Action": options.action,
    ...(options.headers || {}),
  };
  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.contentType) {
    headers["Content-Type"] = options.contentType;
  }
  const response = await fetch(input, {
    method: options.method || "GET",
    cache: "no-store",
    headers,
    body,
  });
  if (!response.ok) throw await responseError(response, "地图操作请求失败");
  if (response.status === 204) return null;
  return response.json();
}

async function sha256Hex(bytes) {
  if (!crypto.subtle) throw new Error("当前浏览器环境不支持地图保存所需的 SHA-256");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function setSaveProgress(message) {
  state.saveProgress = message;
  elements.documentState.textContent = message;
  elements.saveButton.disabled = true;
}

function setSaveButtonIcon(icon) {
  elements.saveButton.innerHTML = `<i data-lucide="${icon}"></i>`;
  elements.saveButton.classList.toggle("is-saving", icon === "loader-circle");
  refreshIcons();
}

function showSaveConflict(error) {
  elements.saveConflictDetail.textContent = `${error.message} 当前窗口的编辑和撤销历史仍保留，服务端文件没有被覆盖。`;
  if (!elements.saveConflictDialog.open) elements.saveConflictDialog.showModal();
  elements.mapState.dataset.status = "error";
  elements.mapState.innerHTML = '<i data-lucide="git-compare-arrows"></i><span>版本冲突</span>';
  refreshIcons();
}

function setMapReadyStatus() {
  elements.mapState.dataset.status = "ready";
  elements.mapState.innerHTML = '<i data-lucide="circle-check"></i><span>已就绪</span>';
  refreshIcons();
}

function mapHeaders() {
  return { "X-Codex-Desktop-Editor-Instance": state.credentials.editorInstanceId };
}

async function responseError(response, fallback) {
  const data = await response.json().catch(() => ({}));
  const error = new Error(data.error || fallback);
  error.status = response.status;
  error.code = data.code || null;
  return error;
}

function renderLayerList() {
  const visibleIds = new Set(state.viewer.layerViews.map(({ layer }) => layer.id));
  state.selectedLayerIds = new Set([...state.selectedLayerIds].filter((layerId) => visibleIds.has(layerId)));
  if (!state.selectedLayerIds.size && visibleIds.has(state.activeLayerId)) {
    state.selectedLayerIds.add(state.activeLayerId);
  }
  const fragment = document.createDocumentFragment();
  for (const view of state.viewer.layerViews) {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.dataset.layerId = String(view.layer.id ?? "");
    row.style.setProperty("--layer-depth", String(view.depth));
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(view.depth + 1));
    row.setAttribute("aria-selected", String(state.selectedLayerIds.has(view.layer.id)));
    if (view.layer.type === "group") row.setAttribute("aria-expanded", "true");
    row.draggable = state.session.writable === true && !layerTreeEntryLocked(view.layer.id);
    row.classList.toggle("is-selected", state.selectedLayerIds.has(view.layer.id));
    row.classList.toggle("is-active", state.activeLayerId === view.layer.id);
    const collaborationOwnership = collaborationOwnershipForLayer(view.layer.id);
    if (collaborationOwnership) {
      row.dataset.collaborationOwnership = collaborationOwnership;
      row.title = collaborationOwnership === "locked" ? "协同策略：锁定区" : "协同策略：人工所有区";
    }
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = view.container.visible;
    checkbox.setAttribute("aria-label", `${view.layer.name || "未命名图层"} 可见性`);
    checkbox.addEventListener("change", () => toggleLayerVisibility(view, checkbox.checked));
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", layerIcon(view.layer.type));
    const name = document.createElement("button");
    name.type = "button";
    name.className = "layer-name";
    name.textContent = view.layer.name || `图层 ${view.layer.id || ""}`.trim();
    name.addEventListener("click", (event) => setActiveLayer(view, { event }));
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "layer-lock";
    lock.disabled = !state.session.writable;
    setLayerLockButton(lock, view.layer);
    lock.addEventListener("click", () => toggleLayerLock(view, lock));
    if (collaborationOwnership) {
      const badge = document.createElement("span");
      badge.className = "layer-collaboration-badge";
      badge.textContent = collaborationOwnership === "locked" ? "锁定" : "人工";
      badge.setAttribute("aria-label", row.title);
      row.append(checkbox, icon, name, badge, lock);
    } else {
      row.append(checkbox, icon, name, lock);
    }
    row.addEventListener("dragstart", (event) => beginLayerDrag(event, view));
    row.addEventListener("dragover", (event) => updateLayerDropTarget(event, view));
    row.addEventListener("drop", (event) => dropLayersOnRow(event, view));
    row.addEventListener("dragend", clearLayerDragState);
    fragment.append(row);
  }
  elements.layerList.replaceChildren(fragment);
  elements.layerList.ondragover = updateRootLayerDropTarget;
  elements.layerList.ondrop = dropLayersAtRootEnd;
  elements.layerCount.textContent = String(state.viewer.layerViews.length);
  refreshIcons();
}

function collaborationOwnershipForLayer(layerId) {
  const policy = state.mapAiCollaborationPolicy;
  const mapPath = state.session?.relativePath;
  if (!policy || !mapPath) return null;
  const targets = [
    ...(Array.isArray(policy.humanOwned) ? policy.humanOwned.map((target) => ({ ...target, ownership: "human" })) : []),
    ...(Array.isArray(policy.locked) ? policy.locked.map((target) => ({ ...target, ownership: "locked" })) : []),
  ];
  const matching = targets.filter((target) => (
    target.kind === "layer"
    && Number(target.layerId) === Number(layerId)
    && (!target.mapPath || target.mapPath === mapPath)
  ));
  if (matching.some((target) => target.ownership === "locked")) return "locked";
  return matching.some((target) => target.ownership === "human") ? "human" : null;
}

function selectedLayerRootIds() {
  const selected = state.selectedLayerIds.size
    ? state.selectedLayerIds
    : new Set(Number.isSafeInteger(state.activeLayerId) ? [state.activeLayerId] : []);
  return state.viewer.layerViews
    .filter(({ layer }) => selected.has(layer.id))
    .filter(({ layer }) => {
      const entry = state.editor?.layerEntryById(layer.id);
      return entry && !entry.ancestors.some((ancestor) => selected.has(ancestor?.id));
    })
    .map(({ layer }) => layer.id);
}

function layerTreeEntryLocked(layerId, { includeDescendants = false } = {}) {
  const entry = state.editor?.layerEntryById(layerId);
  if (!entry) return true;
  if ([...entry.ancestors, entry.layer].some((layer) => layer?.locked === true)) return true;
  if (!includeDescendants) return false;
  return state.viewer.layerViews.some(({ layer }) => (
    layer.locked === true
    && state.editor.layerEntryById(layer.id)?.ancestors.some((ancestor) => ancestor?.id === layerId)
  ));
}

function renderLayerSelectionRows() {
  for (const row of elements.layerList.querySelectorAll(".layer-row")) {
    const layerId = Number(row.dataset.layerId);
    const selected = state.selectedLayerIds.has(layerId);
    row.classList.toggle("is-selected", selected);
    row.classList.toggle("is-active", layerId === state.activeLayerId);
    row.setAttribute("aria-selected", String(selected));
  }
}

function createLayer(type, extra = {}) {
  if (!state.session?.writable || state.layerTreeRebuildRunning) return false;
  const placement = newLayerPlacement();
  const names = {
    tilelayer: "瓦片层",
    objectgroup: "对象层",
    group: "分组",
  };
  try {
    const layer = state.editor.createLayer(type, {
      ...placement,
      ...extra,
      name: extra.name || uniqueLayerName(names[type] || "图层"),
      label: `新建${names[type] || "图层"}`,
    });
    state.selectedLayerIds = new Set([layer.id]);
    state.layerSelectionAnchorId = layer.id;
    state.preferredActiveLayerId = layer.id;
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function newLayerPlacement() {
  const active = state.editor?.layerEntryById(state.activeLayerId);
  if (!active) return { parentId: null };
  if (active.layer.type === "group") {
    return { parentId: active.layer.id, index: active.layer.layers.length };
  }
  return { parentId: active.parent?.id ?? null, index: active.index + 1 };
}

function uniqueLayerName(base) {
  const normalized = String(base || "图层");
  const names = new Set((state.viewer?.layerViews || []).map(({ layer }) => String(layer.name || "")));
  if (!names.has(normalized)) return normalized;
  let suffix = 2;
  while (names.has(`${normalized} ${suffix}`)) suffix += 1;
  return `${normalized} ${suffix}`;
}

function duplicateActiveLayer() {
  const layerIds = selectedLayerRootIds();
  if (!state.session?.writable || !layerIds.length || state.layerTreeRebuildRunning) return false;
  const duplicates = [];
  try {
    state.editor.runBatch(layerIds.length > 1 ? `复制 ${layerIds.length} 个图层` : "复制图层", () => {
      for (const layerId of [...layerIds].reverse()) {
        const entry = state.editor.layerEntryById(layerId);
        const layer = state.editor.duplicateLayer(layerId, {
          parentId: entry.parent?.id ?? null,
          index: entry.index + 1,
          label: "复制图层",
        });
        duplicates.unshift(layer.id);
      }
    });
    state.selectedLayerIds = new Set(duplicates);
    state.layerSelectionAnchorId = duplicates[0] ?? null;
    state.preferredActiveLayerId = duplicates[0] ?? null;
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

async function saveSelectedLayersAsComposite() {
  const layerIds = selectedLayerRootIds();
  if (!state.session?.writable || !state.session.projectFile || !layerIds.length || state.layerTreeRebuildRunning) return false;
  const first = state.editor?.layerById(layerIds[0]);
  const baseName = String(first?.name || `layers-${layerIds.join("-")}`)
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, "-")
    .replace(/^\.+|\.+$/gu, "") || `layers-${layerIds.join("-")}`;
  const requested = window.prompt(
    "将所选图层保存为组合 TMJ（工程相对路径；已有文件不会被覆盖）",
    `maps/${baseName}.composite.tmj`,
  );
  if (requested === null) return false;
  const relativePath = requested.trim().toLowerCase().endsWith(".tmj")
    ? requested.trim()
    : `${requested.trim()}.tmj`;
  elements.saveCompositeButton.disabled = true;
  try {
    const document = createCompositeMapDocument(state.document, layerIds, {
      sourcePath: state.session.relativePath,
      targetPath: relativePath,
    });
    const dependencies = compositeDependencies(document, relativePath);
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-composite`,
      location.origin,
    );
    url.searchParams.set("path", relativePath);
    const data = await mapMutation(url, {
      method: "PUT",
      action: "map-project-composite-save",
      contentType: "application/octet-stream",
      body: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
    });
    const saved = data.composite;
    state.assetLibrary = upsertMapAsset(state.assetLibrary, {
      path: saved.relativePath,
      name: saved.relativePath.split("/").at(-1),
      kind: "composite-map",
      size: saved.size,
      sha256: saved.version,
      dependencies,
      lastUsedAt: Date.now(),
    });
    state.assetLibrary = touchMapAsset(state.assetLibrary, saved.relativePath);
    persistMapAssetLibrary();
    elements.mapState.dataset.status = "ready";
    elements.mapState.innerHTML = `<i data-lucide="package-check"></i><span>组合已保存 · ${dependencies.length} 个依赖</span>`;
    refreshIcons();
    window.setTimeout(() => {
      if (elements.mapState.textContent?.includes("组合已保存")) setMapReadyStatus();
    }, 3000);
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  } finally {
    updateLayerActionAvailability();
  }
}

function moveActiveLayer(delta) {
  const roots = selectedLayerRootIds();
  const entries = roots.map((layerId) => state.editor?.layerEntryById(layerId)).filter(Boolean);
  if (!state.session?.writable || !entries.length || state.layerTreeRebuildRunning) return false;
  const parentId = entries[0].parent?.id ?? null;
  if (entries.some((entry) => (entry.parent?.id ?? null) !== parentId)) return false;
  const selected = new Set(roots);
  const siblings = entries[0].siblings;
  const edge = delta < 0
    ? Math.min(...entries.map((entry) => entry.index))
    : Math.max(...entries.map((entry) => entry.index));
  let targetIndex = edge + (delta < 0 ? -1 : 1);
  while (targetIndex >= 0 && targetIndex < siblings.length && selected.has(siblings[targetIndex]?.id)) {
    targetIndex += delta < 0 ? -1 : 1;
  }
  const target = siblings[targetIndex];
  if (!target) return false;
  return moveSelectedLayers(roots, {
    position: delta < 0 ? "before" : "after",
    targetId: target.id,
    label: delta < 0 ? "上移图层" : "下移图层",
  });
}

function deleteActiveLayer() {
  const layerIds = selectedLayerRootIds();
  const entries = layerIds.map((layerId) => state.editor?.layerEntryById(layerId)).filter(Boolean);
  if (!state.session?.writable || !entries.length || state.layerTreeRebuildRunning) return false;
  const nestedCount = entries.reduce((total, entry) => total + countLayerTree(entry.layer) - 1, 0);
  const detail = nestedCount ? `，其中包含 ${nestedCount} 个子图层` : "";
  const subject = entries.length === 1
    ? `图层“${entries[0].layer.name || entries[0].layer.id}”`
    : `${entries.length} 个图层`;
  if (!confirm(`删除${subject}${detail}？可以通过撤销恢复。`)) return false;
  const removed = new Set(layerIds);
  const fallback = state.viewer.layerViews.find(({ layer }) => !removed.has(layer.id))?.layer || null;
  try {
    state.preferredActiveLayerId = fallback?.id ?? null;
    state.selectedLayerIds = new Set(fallback ? [fallback.id] : []);
    state.layerSelectionAnchorId = fallback?.id ?? null;
    state.editor.runBatch(entries.length > 1 ? `删除 ${entries.length} 个图层` : "删除图层", () => {
      for (const layerId of [...layerIds].reverse()) {
        state.editor.removeLayer(layerId, { label: "删除图层" });
      }
    });
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function countLayerTree(layer) {
  return 1 + (Array.isArray(layer?.layers)
    ? layer.layers.reduce((total, child) => total + countLayerTree(child), 0)
    : 0);
}

function moveSelectedLayers(layerIds, placement) {
  if (!state.session?.writable || !layerIds.length || state.layerTreeRebuildRunning) return false;
  let parentId = null;
  let index = state.editor.document.layers.length;
  if (placement.position !== "root-end") {
    const target = state.editor.layerEntryById(placement.targetId);
    if (!target) return false;
    if (placement.position === "inside") {
      if (target.layer.type !== "group") return false;
      parentId = target.layer.id;
      index = target.layer.layers.length;
    } else {
      parentId = target.parent?.id ?? null;
      index = target.index + (placement.position === "after" ? 1 : 0);
    }
  }
  try {
    const activeId = layerIds.includes(state.activeLayerId) ? state.activeLayerId : layerIds[0];
    const result = state.editor.moveLayers(layerIds, {
      parentId,
      index,
      label: placement.label || (layerIds.length > 1 ? `移动 ${layerIds.length} 个图层` : "移动图层"),
    });
    state.selectedLayerIds = new Set(layerIds);
    state.layerSelectionAnchorId = activeId;
    state.preferredActiveLayerId = activeId;
    if (!result) renderLayerSelectionRows();
    return Boolean(result);
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function beginLayerDrag(event, view) {
  if (!state.session?.writable || layerTreeEntryLocked(view.layer.id, { includeDescendants: true })) {
    event.preventDefault();
    return;
  }
  if (event.target instanceof Element && event.target.closest("input, .layer-lock")) {
    event.preventDefault();
    return;
  }
  if (!state.selectedLayerIds.has(view.layer.id)) setActiveLayer(view);
  const layerIds = selectedLayerRootIds();
  if (!layerIds.length || layerIds.some((layerId) => layerTreeEntryLocked(layerId, { includeDescendants: true }))) {
    event.preventDefault();
    return;
  }
  state.layerDragIds = layerIds;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", layerIds.join(","));
  requestAnimationFrame(() => {
    for (const layerId of layerIds) {
      elements.layerList.querySelector(`.layer-row[data-layer-id="${CSS.escape(String(layerId))}"]`)
        ?.classList.add("is-dragging");
    }
  });
}

function updateLayerDropTarget(event, view) {
  if (!state.layerDragIds.length) return;
  event.preventDefault();
  event.stopPropagation();
  const bounds = event.currentTarget.getBoundingClientRect();
  const ratio = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0.5;
  const position = view.layer.type === "group" && ratio >= 0.25 && ratio <= 0.75
    ? "inside"
    : ratio < 0.5 ? "before" : "after";
  if (!canDropLayersOn(state.layerDragIds, view.layer.id, position)) {
    event.dataTransfer.dropEffect = "none";
    clearLayerDropIndicators();
    return;
  }
  event.dataTransfer.dropEffect = "move";
  clearLayerDropIndicators();
  event.currentTarget.classList.add(`is-drop-${position}`);
  event.currentTarget.dataset.dropPosition = position;
}

function canDropLayersOn(layerIds, targetId, position) {
  if (layerIds.includes(targetId)) return false;
  const target = state.editor?.layerEntryById(targetId);
  if (!target) return false;
  if (target.ancestors.some((ancestor) => layerIds.includes(ancestor?.id))) return false;
  if (position === "inside") {
    return target.layer.type === "group" && !layerTreeEntryLocked(targetId);
  }
  return !target.ancestors.some((ancestor) => ancestor?.locked === true)
    && target.parent?.locked !== true;
}

function dropLayersOnRow(event, view) {
  if (!state.layerDragIds.length) return;
  event.preventDefault();
  event.stopPropagation();
  const position = event.currentTarget.dataset.dropPosition;
  const layerIds = [...state.layerDragIds];
  clearLayerDragState();
  if (!["before", "after", "inside"].includes(position)) return;
  moveSelectedLayers(layerIds, { position, targetId: view.layer.id });
}

function updateRootLayerDropTarget(event) {
  if (!state.layerDragIds.length
    || (event.target instanceof Element && event.target.closest(".layer-row"))) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearLayerDropIndicators();
  elements.layerList.classList.add("is-drop-root-end");
}

function dropLayersAtRootEnd(event) {
  if (!state.layerDragIds.length
    || (event.target instanceof Element && event.target.closest(".layer-row"))) return;
  event.preventDefault();
  const layerIds = [...state.layerDragIds];
  clearLayerDragState();
  moveSelectedLayers(layerIds, { position: "root-end" });
}

function clearLayerDropIndicators() {
  elements.layerList.classList.remove("is-drop-root-end");
  for (const row of elements.layerList.querySelectorAll(".layer-row")) {
    row.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
    delete row.dataset.dropPosition;
  }
}

function clearLayerDragState() {
  state.layerDragIds = [];
  clearLayerDropIndicators();
  for (const row of elements.layerList.querySelectorAll(".layer-row.is-dragging")) {
    row.classList.remove("is-dragging");
  }
}

function selectedImageLayerRecords() {
  return [...state.selectedLayerIds].map((layerId) => {
    const layer = state.editor?.layerById(layerId);
    const bounds = layer?.type === "imagelayer" ? state.viewer?.imageLayerWorldBounds(layerId) : null;
    return layer && bounds ? { layerId, layer, bounds } : null;
  }).filter(Boolean);
}

function toggleImageArrangePanel() {
  setImageArrangePanelOpen(elements.imageArrangePanel.hidden);
}

function setImageArrangePanelOpen(open) {
  const visible = Boolean(open) && selectedImageLayerRecords().length > 0;
  elements.imageArrangePanel.hidden = !visible;
  elements.imageArrangeButton.setAttribute("aria-expanded", String(visible));
  if (visible) renderImageArrangeControls();
}

function updateImageSnapSettings() {
  const step = Math.max(1, Math.min(1024, Math.round(Number(elements.imageSnapStep.value) || 1)));
  state.imageSnapEnabled = elements.imageSnapEnabled.checked;
  state.imageSnapUnit = elements.imageSnapUnit.value === "tile" ? "tile" : "pixel";
  state.imageSnapStep = step;
  elements.imageSnapStep.value = String(step);
  scheduleMapEditorViewStateSave();
}

function renderImageArrangeControls() {
  if (!state.session) return;
  const records = selectedImageLayerRecords();
  const writable = state.session.writable === true && !state.layerTreeRebuildRunning;
  const locked = records.some(({ layerId }) => layerTreeEntryLocked(layerId));
  elements.imageArrangeButton.disabled = !writable || records.length < 1;
  for (const button of elements.imageArrangePanel.querySelectorAll("[data-image-arrange]")) {
    const distribution = button.dataset.imageArrange?.startsWith("distribute-");
    button.disabled = !writable || locked || records.length < (distribution ? 3 : 2);
  }
  elements.imageSnapEnabled.checked = state.imageSnapEnabled;
  elements.imageSnapUnit.value = state.imageSnapUnit;
  elements.imageSnapStep.value = String(state.imageSnapStep);
  elements.imageSnapEnabled.disabled = !writable || !records.length;
  elements.imageSnapUnit.disabled = !writable || !records.length;
  elements.imageSnapStep.disabled = !writable || !records.length;
  if (!records.length) setImageArrangePanelOpen(false);
}

function snapImageLayerPosition(position, layerId = null) {
  if (!state.imageSnapEnabled) return position;
  const multiplierX = state.imageSnapUnit === "tile" ? Number(state.document?.tilewidth || 1) : 1;
  const multiplierY = state.imageSnapUnit === "tile" ? Number(state.document?.tileheight || 1) : 1;
  const stepX = Math.max(1, state.imageSnapStep * multiplierX);
  const stepY = Math.max(1, state.imageSnapStep * multiplierY);
  const snapped = {
    x: Math.round(position.x / stepX) * stepX,
    y: Math.round(position.y / stepY) * stepY,
  };
  if (layerId == null || !state.guideController || !state.viewer) return snapped;
  const bounds = state.viewer.imageLayerWorldBounds(layerId, snapped);
  if (!bounds) return snapped;
  const zoom = Number(state.viewer.renderView()?.scale || 1);
  const guideSnap = state.guideController.snapBounds(bounds, 8 / Math.max(0.1, zoom));
  return {
    x: Math.round((snapped.x + guideSnap.dx) * 1_000) / 1_000,
    y: Math.round((snapped.y + guideSnap.dy) * 1_000) / 1_000,
  };
}

function arrangeSelectedImageLayers(action) {
  const records = selectedImageLayerRecords();
  const minimum = String(action).startsWith("distribute-") ? 3 : 2;
  if (!state.session?.writable
    || records.length < minimum
    || records.some(({ layerId }) => layerTreeEntryLocked(layerId))) return false;
  const changes = new Map(records.map(({ layerId, layer }) => [layerId, {
    x: Number(layer.x || 0),
    y: Number(layer.y || 0),
  }]));
  const left = Math.min(...records.map(({ bounds }) => bounds.x));
  const top = Math.min(...records.map(({ bounds }) => bounds.y));
  const right = Math.max(...records.map(({ bounds }) => bounds.x + bounds.width));
  const bottom = Math.max(...records.map(({ bounds }) => bounds.y + bounds.height));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  const moveRecord = (record, deltaX, deltaY) => {
    const current = changes.get(record.layerId);
    current.x = Math.round(current.x + deltaX);
    current.y = Math.round(current.y + deltaY);
  };
  if (["left", "center-x", "right"].includes(action)) {
    for (const record of records) {
      const target = action === "left"
        ? left
        : action === "right" ? right - record.bounds.width : centerX - record.bounds.width / 2;
      moveRecord(record, target - record.bounds.x, 0);
    }
  } else if (["top", "center-y", "bottom"].includes(action)) {
    for (const record of records) {
      const target = action === "top"
        ? top
        : action === "bottom" ? bottom - record.bounds.height : centerY - record.bounds.height / 2;
      moveRecord(record, 0, target - record.bounds.y);
    }
  } else if (action === "distribute-x") {
    const ordered = [...records].sort((a, b) => a.bounds.x - b.bounds.x || a.layerId - b.layerId);
    const occupied = ordered.reduce((total, record) => total + record.bounds.width, 0);
    const gap = (right - left - occupied) / (ordered.length - 1);
    let cursor = left;
    for (const record of ordered) {
      moveRecord(record, cursor - record.bounds.x, 0);
      cursor += record.bounds.width + gap;
    }
  } else if (action === "distribute-y") {
    const ordered = [...records].sort((a, b) => a.bounds.y - b.bounds.y || a.layerId - b.layerId);
    const occupied = ordered.reduce((total, record) => total + record.bounds.height, 0);
    const gap = (bottom - top - occupied) / (ordered.length - 1);
    let cursor = top;
    for (const record of ordered) {
      moveRecord(record, 0, cursor - record.bounds.y);
      cursor += record.bounds.height + gap;
    }
  } else {
    return false;
  }

  try {
    const label = {
      left: "图片层左对齐",
      "center-x": "图片层水平居中",
      right: "图片层右对齐",
      top: "图片层顶部对齐",
      "center-y": "图片层垂直居中",
      bottom: "图片层底部对齐",
      "distribute-x": "图片层水平分布",
      "distribute-y": "图片层垂直分布",
    }[action];
    const result = state.editor.runBatch(label, () => {
      for (const record of records) {
        const next = changes.get(record.layerId);
        if (next.x !== Number(record.layer.x || 0) || next.y !== Number(record.layer.y || 0)) {
          state.editor.updateLayer(record.layerId, next, { label });
        }
      }
    });
    renderImageLayerSelection();
    return result.changed;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function showImageLayerImport() {
  if (!state.session?.writable || !state.editor) return;
  state.mapImageAssetRole = null;
  restoreImageAssetPickerLabels();
  state.selectedImageAsset = null;
  state.selectedImageAssets = new Set();
  state.imageAssetSelectionEntries = new Map();
  state.imageAssetDirectory = "";
  state.imageAssetCursor = null;
  state.imageAssetEntries = [];
  renderImageAssetList();
  elements.imageLayerDialog.showModal();
  void loadImageAssets("");
}

function openMapImageAssetPicker(role) {
  if (!state.session?.writable || !state.editor || !["source", "mask"].includes(role)) return;
  state.mapImageAssetRole = role;
  state.selectedImageAsset = null;
  state.selectedImageAssets = new Set();
  state.imageAssetSelectionEntries = new Map();
  state.imageAssetDirectory = "";
  state.imageAssetCursor = null;
  state.imageAssetEntries = [];
  elements.imageLayerTitle.textContent = role === "mask" ? "选择编辑蒙版" : "选择地图图片源";
  elements.imageLayerDescription.textContent = role === "mask"
    ? "选择当前工程已授权的 PNG、JPEG 或 WebP 蒙版；不会加入地图图层"
    : "选择当前工程图片作为 edit/outpaint 源；不会加入地图图层";
  elements.importImageLayerButton.innerHTML = role === "mask"
    ? '<i data-lucide="scan"></i><span>选择为蒙版</span>'
    : '<i data-lucide="check"></i><span>选择为源图</span>';
  renderImageAssetList();
  elements.imageLayerDialog.showModal();
  void loadImageAssets("");
  refreshIcons();
}

async function useActiveImageLayerSource() {
  const layer = state.editor?.layerById(state.activeLayerId);
  if (!state.session?.writable || layer?.type !== "imagelayer" || !layer.image || state.mapImageSourceResolving) return;
  state.mapImageSourceResolving = true;
  updateMapImageControls();
  setMapImageMessage("正在授权当前图片层源图");
  try {
    const resourcePath = resolveTiledProjectReference(state.session.relativePath, layer.image);
    const data = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
      {
        method: "POST",
        action: "map-resource-grant",
        json: {
          resourcePath,
          expectedKind: "image",
          expectedVersion: state.session.version,
        },
      },
    );
    state.mapImageSourcePaths = [data.resource?.path || resourcePath];
    state.mapImageSourceFile = null;
    state.mapImageUseSelection = false;
    state.mapImageSourceLayerId = layer.id;
    elements.mapImageSourceFile.value = "";
    setMapImageMessage("当前图片层已作为源图；可见地图辅助线会显示在边界画布中");
    renderMapImageOperationControls();
    await refreshMapImageSourcePreview();
  } catch (error) {
    setMapImageMessage(error.message, "error");
  } finally {
    state.mapImageSourceResolving = false;
    updateMapImageControls();
  }
}

function closeImageAssetPicker() {
  state.mapImageAssetRole = null;
  state.selectedImageAssets = new Set();
  state.imageAssetSelectionEntries = new Map();
  restoreImageAssetPickerLabels();
  elements.imageLayerDialog.close();
}

function restoreImageAssetPickerLabels() {
  elements.imageLayerTitle.textContent = "导入图片图层";
  elements.imageLayerDescription.textContent = "可多选当前工程中的 PNG、JPEG 或 WebP 图片；每张图片会创建一个独立图层";
  elements.importImageLayerButton.innerHTML = '<i data-lucide="image-plus"></i><span>加入图片图层</span>';
  elements.imageAssetList.setAttribute("aria-multiselectable", "true");
  refreshIcons();
}

function showTilesetImport() {
  if (!state.session?.writable || !state.editor || state.layerTreeRebuildRunning) return;
  state.selectedTilesetAsset = null;
  state.tilesetAssetDirectory = "";
  state.tilesetAssetCursor = null;
  state.tilesetAssetEntries = [];
  renderTilesetAssetList();
  elements.tilesetAssetDialog.showModal();
  void loadTilesetAssets("");
}

function showTemplateAssets() {
  const layer = state.editor?.layerById(state.activeLayerId);
  if (!state.session?.writable || layer?.type !== "objectgroup") return;
  state.selectedTemplateAsset = null;
  state.templateAssetDirectory = "";
  state.templateAssetCursor = null;
  state.templateAssetEntries = [];
  renderTemplateAssetList();
  elements.templateAssetDialog.showModal();
  void loadTemplateAssets("");
}

async function loadTemplateAssets(directory = "", { append = false } = {}) {
  if (state.templateAssetLoading) return;
  const normalized = String(directory || "").replace(/^\/+|\/+$/gu, "");
  if (!append) {
    state.templateAssetDirectory = normalized;
    state.templateAssetCursor = null;
    state.templateAssetEntries = [];
    state.selectedTemplateAsset = null;
  }
  state.templateAssetLoading = true;
  setTemplateAssetState("正在读取对象模板目录…");
  try {
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-assets`,
      location.origin,
    );
    if (normalized) url.searchParams.set("directory", normalized);
    url.searchParams.set("kinds", "template");
    url.searchParams.set("limit", "100");
    if (append && state.templateAssetCursor) url.searchParams.set("cursor", state.templateAssetCursor);
    const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
    if (!response.ok) throw await responseError(response, "无法读取对象模板目录");
    const data = await response.json();
    const entries = Array.isArray(data.catalog?.entries) ? data.catalog.entries : [];
    state.templateAssetEntries = append ? [...state.templateAssetEntries, ...entries] : entries;
    state.templateAssetCursor = data.catalog?.nextCursor || null;
    renderTemplateAssetList();
    setTemplateAssetState(state.templateAssetEntries.some((entry) => entry.kind === "template")
      ? "选择一个 .tx 模板加入当前对象层"
      : "当前目录没有可用的对象模板");
  } catch (error) {
    setTemplateAssetState(error.message, "error");
  } finally {
    state.templateAssetLoading = false;
    renderTemplateAssetList();
  }
}

function renderTemplateAssetList() {
  const fragment = document.createDocumentFragment();
  const entries = state.templateAssetEntries.filter((entry) => entry.kind === "directory" || entry.kind === "template");
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-asset-entry";
    button.dataset.path = entry.path;
    button.dataset.kind = entry.kind;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(state.selectedTemplateAsset?.path === entry.path));
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", entry.kind === "directory" ? "folder" : "package");
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const pathLabel = document.createElement("small");
    pathLabel.textContent = entry.path;
    details.append(name, pathLabel);
    const size = document.createElement("span");
    size.textContent = entry.kind === "directory" ? "目录" : formatBytes(entry.size);
    button.append(icon, details, size);
    button.addEventListener("click", () => {
      if (entry.kind === "directory") {
        void loadTemplateAssets(entry.path);
        return;
      }
      state.selectedTemplateAsset = entry;
      renderTemplateAssetList();
      setTemplateAssetState(`已选择 ${entry.path}`);
    });
    fragment.append(button);
  }
  elements.templateAssetList.replaceChildren(fragment);
  elements.templateAssetDirectory.textContent = state.templateAssetDirectory || "工程根目录";
  elements.templateAssetParentButton.disabled = !state.templateAssetDirectory || state.templateAssetLoading;
  elements.loadMoreTemplateAssetsButton.hidden = !state.templateAssetCursor || state.templateAssetLoading;
  elements.importTemplateButton.disabled = !state.selectedTemplateAsset || state.templateAssetLoading;
  refreshIcons();
}

function setTemplateAssetState(message, status = "") {
  elements.templateAssetState.textContent = String(message || "");
  elements.templateAssetState.dataset.status = status;
}

async function importSelectedTemplate() {
  const asset = state.selectedTemplateAsset;
  const layer = state.editor?.layerById(state.activeLayerId);
  if (!asset || layer?.type !== "objectgroup" || !state.session?.writable || state.templateAssetLoading) return;
  elements.importTemplateButton.disabled = true;
  setTemplateAssetState("正在读取并加入模板实例…");
  try {
    const { template } = await readTemplateSource(asset.path);
    const viewport = state.viewer?.viewportWorldRect?.();
    const worldPoint = viewport
      ? { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }
      : { x: 0, y: 0 };
    const local = state.viewer?.pointForLayer(state.activeLayerId, worldPoint) || worldPoint;
    const prepared = await materializeTemplateForCurrentMap(template, {}, {
      x: Math.round(local.x),
      y: Math.round(local.y),
      targetPath: state.session.relativePath,
      templatePath: asset.path,
    });
    delete prepared.object.id;
    let added;
    state.editor.runBatch(`加入模板 ${asset.name}`, () => {
      for (const addition of prepared.plan?.additions || []) {
        state.editor.addTileset(addition.reference, { label: `加入模板瓦片集 ${addition.sourcePath || "内嵌瓦片集"}` });
      }
      added = state.editor.addObject(state.activeLayerId, prepared.object, { label: `加入模板 ${asset.name}` });
    });
    if (prepared.plan?.additions?.length) {
      state.preferredActiveLayerId = state.activeLayerId;
      scheduleLayerTreeRebuild(state.activeLayerId, { reloadTilesets: true });
    } else {
      scheduleLayerRefresh(state.activeLayerId);
    }
    selectObject(added.id);
    elements.templateAssetDialog.close();
  } catch (error) {
    setTemplateAssetState(error.message, "error");
    elements.importTemplateButton.disabled = false;
  }
}

async function readTemplateSource(relativePath, { force = false } = {}) {
  if (!force && state.templateSources.has(relativePath)) return state.templateSources.get(relativePath);
  const url = new URL(
    `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-resource`,
    location.origin,
  );
  url.searchParams.set("path", relativePath);
  const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
  if (!response.ok) throw await responseError(response, "无法读取对象模板");
  const source = await response.json();
  const version = response.headers.get("X-WFL-Project-Resource-Version");
  const entry = Object.freeze({
    path: relativePath,
    version,
    template: parseTiledTemplate(source, { sourcePath: relativePath }),
  });
  state.templateSources.set(relativePath, entry);
  if (version) state.templateBindingVersions.set(relativePath, version);
  return entry;
}

async function loadProjectResourceText(relativePath, label = "项目资源", options = {}) {
  const url = new URL(
    `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-resource`,
    location.origin,
  );
  url.searchParams.set("path", relativePath);
  const response = await fetch(url, {
    cache: "no-store",
    headers: mapHeaders(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await responseError(response, `无法读取${label}`);
  return response.text();
}

async function hydrateTiledTemplateInstances(document, documentPath = state.session.relativePath) {
  const instances = [];
  collectTemplateInstances(document.layers, instances);
  if (!instances.length) return;
  const paths = [...new Set(instances.map(({ object }) => {
    try {
      return resolveTiledProjectReference(documentPath, object.template);
    } catch {
      return null;
    }
  }).filter(Boolean))];
  for (const templatePath of paths) {
    try {
      await readTemplateSource(templatePath);
    } catch (error) {
      addWarning(`对象模板 ${templatePath} 无法读取：${error.message}`);
    }
  }
  let targetTilesets = [];
  try {
    targetTilesets = await describeDocumentTilesets(document, documentPath);
  } catch (error) {
    addWarning(`对象模板瓦片集范围无法读取：${error.message}`);
  }
  for (const { objects, index, object } of instances) {
    let templatePath;
    try {
      templatePath = resolveTiledProjectReference(documentPath, object.template);
    } catch {
      continue;
    }
    const entry = state.templateSources.get(templatePath);
    if (!entry) continue;
    try {
      const materialized = materializeTiledTemplate(entry.template, object, {
        id: object.id,
        x: object.x,
        y: object.y,
        targetPath: documentPath,
        templatePath,
      });
      if (entry.template.object?.gid && !Object.hasOwn(object, "gid")) {
        const plan = await planTemplateTilesetReuse(entry.template, templatePath, {
          targetPath: documentPath,
          targetTilesets,
        });
        if (plan.additions.length) {
          throw new Error("模板使用的瓦片集尚未被当前地图引用；请重新拖入模板以安全加入依赖");
        }
        materialized.gid = plan.remapGlobalTileId(entry.template.object.gid);
      }
      objects[index] = materialized;
    } catch (error) {
      addWarning(`对象模板 ${templatePath} 实例化失败：${error.message}`);
    }
  }
}

async function materializeTemplateForCurrentMap(template, override, options = {}) {
  const object = materializeTiledTemplate(template, override, options);
  if (!template.object?.gid || Object.hasOwn(override, "gid")) return { object, plan: null };
  const plan = await planTemplateTilesetReuse(template, options.templatePath || template.sourcePath, {
    targetPath: state.session.relativePath,
    targetTilesets: currentMapTilesetDescriptors(),
  });
  for (const dependencyPath of plan.dependencyPaths) {
    await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
      {
        method: "POST",
        action: "map-resource-grant",
        json: {
          resourcePath: dependencyPath,
          expectedKind: "tileset",
          expectedVersion: state.session.version,
        },
      },
    );
  }
  object.gid = plan.remapGlobalTileId(template.object.gid);
  return { object, plan };
}

function currentMapTilesetDescriptors() {
  const references = state.editor?.document?.tilesets || state.document?.tilesets || [];
  return (state.viewer?.tilesets || []).map((loaded) => {
    const reference = references[loaded.index] || { firstgid: loaded.firstgid };
    const descriptor = {
      reference,
      definition: loaded.definition,
      firstgid: loaded.firstgid,
      maxLocalId: loaded.maxLocalId,
    };
    if (typeof reference.source === "string" && reference.source) {
      descriptor.sourcePath = resolveTiledProjectReference(state.session.relativePath, reference.source);
    }
    return descriptor;
  });
}

async function planTemplateTilesetReuse(template, templatePath, {
  targetPath,
  targetTilesets,
} = {}) {
  if (!template?.tileset) throw new Error("瓦片对象模板缺少根级 tileset 定义");
  const sourceTileset = await describeTilesetReference(template.tileset, templatePath);
  return planTiledTilesetReuse({
    sourceMapPath: templatePath,
    targetMapPath: targetPath,
    sourceTilesets: [sourceTileset],
    targetTilesets,
  });
}

async function describeDocumentTilesets(document, documentPath) {
  const entries = [];
  for (const reference of Array.isArray(document?.tilesets) ? document.tilesets : []) {
    entries.push(await describeTilesetReference(reference, documentPath));
  }
  return entries;
}

async function describeTilesetReference(reference, ownerDocumentPath) {
  if (!reference || !Number.isSafeInteger(reference.firstgid) || reference.firstgid < 1) {
    throw new Error("Tiled 瓦片集引用缺少有效的 firstgid");
  }
  let definition = reference;
  let sourcePath = null;
  if (typeof reference.source === "string" && reference.source) {
    sourcePath = resolveTiledProjectReference(ownerDocumentPath, reference.source);
    definition = parseTiledDocument(await loadProjectResourceText(sourcePath, "对象模板瓦片集"), {
      expectedKind: "tileset",
      sourcePath,
    }).document;
  }
  const image = definition.image
    && Number.isSafeInteger(Number(definition.imagewidth))
    && Number.isSafeInteger(Number(definition.imageheight))
    ? { width: Number(definition.imagewidth), height: Number(definition.imageheight) }
    : null;
  const layout = tiledTilesetLayout(definition, image ? { image } : {});
  return {
    reference,
    definition,
    firstgid: reference.firstgid,
    maxLocalId: layout.maxLocalId,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function collectTemplateInstances(layers, output) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    const objects = Array.isArray(layer?.objects) ? layer.objects : [];
    objects.forEach((object, index) => {
      if (typeof object?.template === "string" && object.template) output.push({ layer, objects, index, object });
    });
    collectTemplateInstances(layer?.layers, output);
  }
}

function compactMapTemplateInstances(document) {
  const instances = [];
  collectTemplateInstances(document.layers, instances);
  for (const { objects, index, object } of instances) {
    try {
      const templatePath = resolveTiledProjectReference(state.session.relativePath, object.template);
      const entry = state.templateSources.get(templatePath);
      if (entry) objects[index] = compactTiledTemplateInstance(entry.template, object);
    } catch {
      // Preserve an unreadable or invalid template instance verbatim.
    }
  }
}

async function saveSelectedObjectAsTemplate() {
  const object = selectedObject();
  if (!object || state.session?.writable !== true || !state.session.projectFile) return false;
  const baseName = String(object.name || object.class || `object-${object.id}`)
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, "-")
    .replace(/^\.+|\.+$/gu, "") || `object-${object.id}`;
  const requested = window.prompt(
    "保存为 Tiled 对象模板（工程相对 .tx 路径；已有模板不会被覆盖）",
    `templates/${baseName}.tx`,
  );
  if (requested === null) return false;
  const relativePath = requested.trim().toLowerCase().endsWith(".tx")
    ? requested.trim()
    : `${requested.trim()}.tx`;
  elements.saveTemplateButton.disabled = true;
  try {
    let document;
    if (object.gid) {
      const sourceTileset = tilesetForObjectGid(object.gid);
      if (!sourceTileset) throw new Error("瓦片对象的 gid 没有对应的瓦片集，无法保存模板");
      const sourceReference = state.editor?.document?.tilesets?.[sourceTileset.index]
        || state.document?.tilesets?.[sourceTileset.index];
      const sourcePath = typeof sourceReference?.source === "string" && sourceReference.source
        ? resolveTiledProjectReference(state.session.relativePath, sourceReference.source)
        : "";
      if (sourcePath) {
        await mapMutation(
          `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
          {
            method: "POST",
            action: "map-resource-grant",
            json: {
              resourcePath: sourcePath,
              expectedKind: "tileset",
              expectedVersion: state.session.version,
            },
          },
        );
      }
      document = createTiledTileObjectTemplateDocument(object, {
        sourcePath: state.session.relativePath,
        templatePath: relativePath,
        sourceTileset: { ...sourceTileset, sourcePath },
      });
    } else {
      document = createTiledTemplateDocument(object, {
        sourcePath: state.session.relativePath,
        templatePath: relativePath,
      });
    }
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-template`,
      location.origin,
    );
    url.searchParams.set("path", relativePath);
    const data = await mapMutation(url, {
      method: "PUT",
      action: "map-project-template-save",
      contentType: "application/octet-stream",
      body: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
    });
    const saved = data.template;
    state.assetLibrary = upsertMapAsset(state.assetLibrary, {
      path: saved.relativePath,
      name: saved.relativePath.split("/").at(-1),
      kind: "template",
      size: saved.size,
      sha256: saved.version,
      lastUsedAt: Date.now(),
    });
    state.assetLibrary = touchMapAsset(state.assetLibrary, saved.relativePath);
    persistMapAssetLibrary();
    elements.mapState.dataset.status = "ready";
    elements.mapState.innerHTML = '<i data-lucide="package-check"></i><span>模板已保存</span>';
    refreshIcons();
    window.setTimeout(() => {
      if (elements.mapState.textContent?.includes("模板已保存")) setMapReadyStatus();
    }, 3000);
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  } finally {
    renderInspector();
  }
}

function tilesetForObjectGid(encodedGid) {
  const value = Number(encodedGid) >>> 0;
  const gid = value & 0x0fff_ffff;
  if (!gid) return null;
  const tilesets = Array.isArray(state.viewer?.tilesets) ? state.viewer.tilesets : [];
  let selected = null;
  for (const tileset of tilesets) {
    if (!Number.isSafeInteger(tileset?.firstgid) || tileset.firstgid > gid) continue;
    if (Number.isSafeInteger(tileset.lastgid) && tileset.lastgid < gid) continue;
    if (!selected || tileset.firstgid > selected.firstgid) selected = tileset;
  }
  return selected;
}

function startTemplateVersionMonitor() {
  stopTemplateVersionMonitor();
  void checkTemplateBindingVersions();
  // Template files are shared project resources. A lightweight poll gives
  // open windows a deterministic refresh warning without copying template
  // contents into the conversation or changing the instance automatically.
  state.templateVersionPollTimer = window.setInterval(() => {
    if (document.visibilityState !== "hidden") void checkTemplateBindingVersions();
  }, 15_000);
}

function stopTemplateVersionMonitor() {
  if (state.templateVersionPollTimer) window.clearInterval(state.templateVersionPollTimer);
  state.templateVersionPollTimer = null;
}

async function checkTemplateBindingVersions() {
  if (!state.session?.projectFile || !state.document) return;
  const paths = new Set();
  collectTemplateReferences(state.document.layers, paths);
  for (const relativePath of paths) {
    try {
      const resolvedPath = resolveTiledProjectReference(state.session.relativePath, relativePath);
      const url = new URL(
        `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-resource`,
        location.origin,
      );
      url.searchParams.set("path", resolvedPath);
      const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
      if (!response.ok) continue;
      const version = response.headers.get("X-WFL-Project-Resource-Version");
      if (!version) continue;
      const previous = state.templateBindingVersions.get(resolvedPath);
      if (previous && previous !== version && !state.templateVersionWarnings.has(resolvedPath)) {
        state.templateVersionWarnings.add(resolvedPath);
        addWarning(`对象模板 ${resolvedPath} 已更新；请检查实例后手动刷新模板`);
      }
      state.templateBindingVersions.set(resolvedPath, version);
    } catch {
      // A deleted or temporarily unavailable template remains in the map; the
      // normal Tiled reference validator reports it on save.
    }
  }
  if (state.selectedObjectId != null) renderInspector();
}

function collectTemplateReferences(layers, output) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    for (const object of Array.isArray(layer?.objects) ? layer.objects : []) {
      if (typeof object?.template === "string" && object.template) output.add(object.template);
    }
    collectTemplateReferences(layer?.layers, output);
  }
}

async function refreshSelectedTemplate() {
  const object = selectedObject();
  if (!object || typeof object.template !== "string" || !state.session?.writable) return false;
  let templatePath;
  try {
    templatePath = resolveTiledProjectReference(state.session.relativePath, object.template);
  } catch (error) {
    reportEditorError(error);
    return false;
  }
  const previous = state.templateSources.get(templatePath);
  if (!previous) return false;
  elements.refreshTemplateButton.disabled = true;
  try {
    const next = await readTemplateSource(templatePath, { force: true });
    const refreshed = refreshTiledTemplateInstance(previous.template, next.template, object, {
      targetPath: state.session.relativePath,
      templatePath,
    });
    const keys = new Set([...Object.keys(object), ...Object.keys(refreshed)]);
    keys.delete("id");
    const changes = {};
    for (const key of keys) changes[key] = Object.hasOwn(refreshed, key) ? refreshed[key] : undefined;
    state.editor.updateObject(state.activeLayerId, object.id, changes, { label: "刷新对象模板" });
    state.templateVersionWarnings.delete(templatePath);
    if (next.version) state.templateBindingVersions.set(templatePath, next.version);
    scheduleLayerRefresh(state.activeLayerId);
    renderInspector();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  } finally {
    renderInspector();
  }
}

function unbindSelectedTemplate() {
  const object = selectedObject();
  if (!object || typeof object.template !== "string" || state.session?.writable !== true) return false;
  try {
    state.editor.updateObject(state.activeLayerId, object.id, { template: undefined }, { label: "解除对象模板绑定" });
    renderInspector();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function assetLibraryStorageKey() {
  const account = state.credentials?.accountId || "account";
  const project = state.credentials?.projectPath || "project";
  return `wfl-map-asset-library-v1:${encodeURIComponent(account)}:${encodeURIComponent(project)}`;
}

function loadStoredMapAssetLibrary() {
  try {
    const stored = localStorage.getItem(assetLibraryStorageKey());
    if (!stored) return createMapAssetLibrary({ projectPath: state.credentials?.projectPath || "" });
    const library = parseMapAssetLibrary(stored);
    return library.projectPath === (state.credentials?.projectPath || "")
      ? library
      : createMapAssetLibrary({ projectPath: state.credentials?.projectPath || "" });
  } catch {
    return createMapAssetLibrary({ projectPath: state.credentials?.projectPath || "" });
  }
}

function persistMapAssetLibrary() {
  try {
    localStorage.setItem(assetLibraryStorageKey(), serializeMapAssetLibrary(state.assetLibrary));
  } catch {
    // A full or disabled localStorage must not block project browsing.
  }
}

function showAssetLibrary() {
  if (!state.session?.projectFile) return;
  if (!elements.assetLibraryDialog.open) elements.assetLibraryDialog.showModal();
  renderAssetLibraryResults();
  elements.assetLibrarySearch.focus();
}

async function showCrossProjectImport() {
  if (!state.session?.writable || !state.credentials?.projectPath) return;
  elements.assetLibraryDialog.close();
  state.crossProjectImportPlan = null;
  state.crossProjectImportSourceSessionId = null;
  elements.crossProjectImportSourcePath.value = "";
  const currentDirectory = state.session.relativePath.split("/").slice(0, -1).join("/");
  elements.crossProjectImportTargetPath.value = currentDirectory
    ? `${currentDirectory}/imported-asset.tmj`
    : "imported-asset.tmj";
  setCrossProjectImportState("正在读取可用工程…");
  renderCrossProjectImportPlan();
  if (!elements.crossProjectImportDialog.open) elements.crossProjectImportDialog.showModal();
  try {
    const response = await fetch("/api/projects", { cache: "no-store" });
    if (!response.ok) throw await responseError(response, "无法读取工程列表");
    const data = await response.json();
    state.crossProjectImportProjects = (Array.isArray(data.projects) ? data.projects : [])
      .filter((project) => project?.path && project.path !== state.credentials.projectPath);
    const fragment = document.createDocumentFragment();
    for (const project of state.crossProjectImportProjects) {
      const option = document.createElement("option");
      option.value = project.path;
      option.textContent = project.name || project.path.split("/").at(-1) || project.path;
      fragment.append(option);
    }
    elements.crossProjectImportProject.replaceChildren(fragment);
    setCrossProjectImportState(state.crossProjectImportProjects.length
      ? "选择源工程并填写源素材和目标路径"
      : "没有可用的其他工程");
  } catch (error) {
    setCrossProjectImportState(error.message, "error");
  }
  refreshIcons();
}

function setCrossProjectImportState(message, status = "") {
  elements.crossProjectImportState.textContent = String(message || "");
  elements.crossProjectImportState.dataset.status = status;
}

function invalidateCrossProjectImportPlan() {
  state.crossProjectImportPlan = null;
  elements.confirmCrossProjectImportButton.disabled = true;
  renderCrossProjectImportPlan();
}

async function openCrossProjectSourceSession(projectPath) {
  await releaseCrossProjectSourceSession();
  let projectFile = null;
  try {
    const searchUrl = new URL("/api/files/search", location.origin);
    searchUrl.searchParams.set("project", projectPath);
    searchUrl.searchParams.set("query", ".tiled-project");
    const searchResponse = await fetch(searchUrl, { cache: "no-store" });
    if (searchResponse.ok) {
      const search = await searchResponse.json();
      projectFile = Array.isArray(search.entries)
        ? search.entries.find((entry) => String(entry.relativePath || "").toLowerCase().endsWith(".tiled-project"))?.relativePath || null
        : null;
    }
  } catch {
    // A temporary project session remains valid when no Tiled project file is available.
  }
  const response = await fetch("/api/map-projects/sessions", {
    method: "POST",
    cache: "no-store",
    headers: {
      ...mapHeaders(),
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-session-open",
    },
    body: JSON.stringify({ project: projectPath, ...(projectFile ? { projectFile } : {}) }),
  });
  if (!response.ok) throw await responseError(response, "无法打开源工程会话");
  const data = await response.json();
  if (!data.session?.id) throw new Error("源工程会话响应无效");
  state.crossProjectImportSourceSessionId = data.session.id;
  return data.session;
}

async function releaseCrossProjectSourceSession() {
  const sessionId = state.crossProjectImportSourceSessionId;
  state.crossProjectImportSourceSessionId = null;
  if (!sessionId) return;
  await fetch(`/api/map-projects/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    cache: "no-store",
    headers: { ...mapHeaders(), "X-Codex-Desktop-Action": "map-project-session-close" },
  }).catch(() => {});
}

async function requestCrossProjectImport({ confirmation = false } = {}) {
  const projectPath = elements.crossProjectImportProject.value;
  const sourcePath = elements.crossProjectImportSourcePath.value.trim();
  const targetPath = elements.crossProjectImportTargetPath.value.trim();
  if (!projectPath || !sourcePath || !targetPath) throw new Error("请选择源工程并填写源素材和目标路径");
  const targetSession = await ensureMapProjectWorkspace();
  if (!state.crossProjectImportSourceSessionId) await openCrossProjectSourceSession(projectPath);
  const body = {
    sourceProjectSessionId: state.crossProjectImportSourceSessionId,
    sourcePath,
    targetPath,
    confirmation,
    ...(confirmation && state.crossProjectImportPlan ? { planHash: state.crossProjectImportPlan.planHash } : {}),
  };
  const response = await fetch(`/api/map-projects/sessions/${encodeURIComponent(targetSession.id)}/imports`, {
    method: "POST",
    cache: "no-store",
    headers: {
      ...mapHeaders(),
      "Content-Type": "application/json",
      "X-Codex-Desktop-Action": "map-project-import",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response, confirmation ? "跨工程素材复制失败" : "无法生成跨工程素材计划");
  return response.json();
}

async function planCrossProjectImport() {
  if (state.crossProjectImportLoading) return;
  state.crossProjectImportLoading = true;
  elements.planCrossProjectImportButton.disabled = true;
  elements.confirmCrossProjectImportButton.disabled = true;
  setCrossProjectImportState("正在读取依赖并生成计划…");
  try {
    const data = await requestCrossProjectImport();
    state.crossProjectImportPlan = data.plan || null;
    renderCrossProjectImportPlan();
    elements.confirmCrossProjectImportButton.disabled = !state.crossProjectImportPlan;
    setCrossProjectImportState(state.crossProjectImportPlan
      ? `计划已生成：复制 ${state.crossProjectImportPlan.copyCount} 个文件，复用 ${state.crossProjectImportPlan.reuseCount} 个文件`
      : "没有生成有效计划", state.crossProjectImportPlan ? "" : "error");
  } catch (error) {
    setCrossProjectImportState(error.message, "error");
  } finally {
    state.crossProjectImportLoading = false;
    elements.planCrossProjectImportButton.disabled = false;
  }
}

async function confirmCrossProjectImport() {
  if (!state.crossProjectImportPlan || state.crossProjectImportLoading) return;
  state.crossProjectImportLoading = true;
  elements.planCrossProjectImportButton.disabled = true;
  elements.confirmCrossProjectImportButton.disabled = true;
  setCrossProjectImportState("正在执行原子复制事务…");
  try {
    const data = await requestCrossProjectImport({ confirmation: true });
    const published = Array.isArray(data.published) ? data.published : [];
    for (const entry of published) {
      const kind = entry.kind === "map" ? "composite-map" : entry.kind;
      if (["image", "tileset", "template", "composite-map"].includes(kind)) {
        state.assetLibrary = upsertMapAsset(state.assetLibrary, {
          path: entry.targetPath,
          name: entry.targetPath.split("/").at(-1),
          kind,
          size: entry.size,
          sha256: entry.sha256,
        });
      }
    }
    persistMapAssetLibrary();
    setAssetLibraryState(`已复制 ${published.length} 个文件到当前工程；请在当前地图中显式导入素材`);
    elements.crossProjectImportDialog.close();
  } catch (error) {
    setCrossProjectImportState(error.message, "error");
    elements.confirmCrossProjectImportButton.disabled = false;
  } finally {
    state.crossProjectImportLoading = false;
    elements.planCrossProjectImportButton.disabled = false;
  }
}

function renderCrossProjectImportPlan() {
  const plan = state.crossProjectImportPlan;
  if (!plan) {
    elements.crossProjectImportPlan.hidden = true;
    elements.crossProjectImportPlan.replaceChildren();
    return;
  }
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = `复制 ${plan.copyCount} 个 · 复用 ${plan.reuseCount} 个 · ${formatBytes(plan.copyBytes)}`;
  const hash = document.createElement("code");
  hash.textContent = plan.planHash.slice(0, 16);
  header.append(title, hash);
  const list = document.createElement("ul");
  for (const entry of plan.files || []) {
    const row = document.createElement("li");
    const target = document.createElement("code");
    target.textContent = entry.targetPath;
    const action = document.createElement("span");
    action.textContent = entry.action === "reuse" ? "复用" : `复制 · ${formatBytes(entry.size)}`;
    row.append(target, action);
    list.append(row);
  }
  elements.crossProjectImportPlan.replaceChildren(header, list);
  elements.crossProjectImportPlan.hidden = false;
}

function closeCrossProjectImport() {
  state.crossProjectImportPlan = null;
  elements.crossProjectImportDialog.close();
  void releaseCrossProjectSourceSession();
}

function scheduleAssetLibrarySearch() {
  clearTimeout(state.assetLibrarySearchTimer);
  // Apply the query to already indexed entries immediately so stale results
  // from the previous query cannot be mistaken for a completed server search.
  renderAssetLibraryResults();
  if (elements.assetLibrarySearch.value.trim().length >= 2) {
    setAssetLibraryState("正在搜索工程素材…");
  }
  state.assetLibrarySearchTimer = setTimeout(() => void loadAssetLibrarySearch(), 250);
}

async function loadAssetLibrarySearch() {
  clearTimeout(state.assetLibrarySearchTimer);
  state.assetLibrarySearchTimer = null;
  const query = elements.assetLibrarySearch.value.trim();
  if (query.length < 2) {
    renderAssetLibraryResults();
    setAssetLibraryState(query ? "搜索词至少需要 2 个字符" : "输入至少 2 个字符搜索；收藏可直接筛选");
    return;
  }
  if (state.assetLibraryLoading) return;
  state.assetLibraryLoading = true;
  setAssetLibraryState("正在搜索工程素材…");
  try {
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-assets/search`,
      location.origin,
    );
    url.searchParams.set("query", query);
    const kind = elements.assetLibraryKind.value;
    if (kind) url.searchParams.set("kinds", kind);
    url.searchParams.set("limit", "100");
    const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
    if (!response.ok) throw await responseError(response, "无法搜索工程素材");
    const data = await response.json();
    for (const entry of Array.isArray(data.search?.entries) ? data.search.entries : []) {
      const assetKind = entry.kind === "map" ? "composite-map" : entry.kind;
      if (!["image", "tileset", "template", "composite-map"].includes(assetKind)) continue;
      state.assetLibrary = upsertMapAsset(state.assetLibrary, { ...entry, kind: assetKind });
    }
    persistMapAssetLibrary();
    renderAssetLibraryResults();
    setAssetLibraryState(data.search?.truncated
      ? "结果达到管理员设置的扫描上限，请缩小搜索范围"
      : `找到 ${Array.isArray(data.search?.entries) ? data.search.entries.length : 0} 个结果`);
  } catch (error) {
    setAssetLibraryState(error.message, "error");
  } finally {
    state.assetLibraryLoading = false;
  }
}

function renderAssetLibraryResults() {
  const kind = elements.assetLibraryKind.value;
  const modelKind = kind === "map" ? "composite-map" : kind;
  const entries = searchMapAssets(state.assetLibrary, elements.assetLibrarySearch.value, {
    ...(modelKind ? { kinds: [modelKind] } : {}),
    favoritesOnly: elements.assetLibraryFavoritesOnly.checked,
    sort: elements.assetLibraryFavoritesOnly.checked ? "favorite" : "recent",
  });
  const fragment = document.createDocumentFragment();
  for (const asset of entries.slice(0, 200)) {
    const row = document.createElement("div");
    row.className = "map-asset-entry asset-library-entry";
    row.dataset.path = asset.path;
    row.dataset.kind = asset.kind;
    row.setAttribute("role", "option");
    row.tabIndex = 0;
    row.draggable = true;
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("application/x-wfl-map-asset", JSON.stringify({ path: asset.path, kind: asset.kind }));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      window.setTimeout(() => elements.assetLibraryDialog.close(), 0);
    });
    row.addEventListener("dblclick", () => {
      elements.assetLibraryDialog.close();
      const viewport = state.viewer?.viewportWorldRect?.();
      const point = viewport
        ? { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 }
        : { x: 0, y: 0 };
      void applyMapAsset(asset, point);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", assetLibraryIcon(asset.kind));
    if (asset.kind === "image" && state.credentials?.projectPath) {
      icon.hidden = true;
      const thumbnail = document.createElement("img");
      thumbnail.className = "asset-thumbnail";
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.src = assetThumbnailUrl(asset.path);
      thumbnail.addEventListener("error", () => thumbnail.remove(), { once: true });
      row.append(thumbnail);
    }
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = asset.name;
    const pathLabel = document.createElement("small");
    pathLabel.textContent = asset.path;
    details.append(name, pathLabel);
    const meta = document.createElement("span");
    const dependencySummary = mapAssetDependencySummary(asset);
    meta.textContent = dependencySummary.count
      ? `${assetLibraryKindLabel(asset.kind)} · ${dependencySummary.text}`
      : assetLibraryKindLabel(asset.kind);
    if (dependencySummary.count) meta.title = dependencySummary.paths.join("\n");
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "mini-icon-button asset-favorite-button";
    favorite.title = asset.favorite ? "取消收藏" : "收藏素材";
    favorite.setAttribute("aria-label", `${asset.favorite ? "取消收藏" : "收藏"} ${asset.name}`);
    favorite.setAttribute("aria-pressed", String(asset.favorite));
    favorite.innerHTML = `<i data-lucide="${asset.favorite ? "star" : "star-off"}"></i>`;
    favorite.addEventListener("click", () => {
      state.assetLibrary = setMapAssetFavorite(state.assetLibrary, asset.path, !asset.favorite);
      persistMapAssetLibrary();
      renderAssetLibraryResults();
    });
    row.append(icon, details, meta, favorite);
    fragment.append(row);
  }
  elements.assetLibraryList.replaceChildren(fragment);
  if (!entries.length && !state.assetLibraryLoading) {
    setAssetLibraryState(elements.assetLibraryFavoritesOnly.checked ? "当前筛选没有收藏素材" : "当前筛选没有已索引素材");
  }
  refreshIcons();
}

function assetThumbnailUrl(resourcePath) {
  const url = new URL("/api/files/image", location.origin);
  url.searchParams.set(
    "path",
    `${String(state.credentials.projectPath).replace(/\/+$/u, "")}/${String(resourcePath).replace(/^\/+|\\/gu, "")}`,
  );
  url.searchParams.set("preview", "map-asset");
  return url.toString();
}

async function dropMapAsset(payload, event) {
  let asset;
  try { asset = JSON.parse(payload); } catch { return; }
  if (!asset?.path || !["image", "template", "composite-map"].includes(asset.kind)) return;
  if (!state.session?.writable) return;
  const rect = elements.mapCanvasHost.getBoundingClientRect();
  const world = state.viewer?.screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  const point = world || { x: 0, y: 0 };
  await applyMapAsset(asset, point);
}

async function applyMapAsset(asset, point) {
  if (!asset?.path || !["image", "template", "composite-map"].includes(asset.kind)) return;
  if (!state.session?.writable) return;
  try {
    if (asset.kind === "image") {
      const data = await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
        {
          method: "POST",
          action: "map-resource-grant",
          json: { resourcePath: asset.path, expectedKind: "image", expectedVersion: state.session.version },
        },
      );
      const imageReference = relativeTiledProjectReference(state.session.relativePath, data.resource.path);
      createLayer("imagelayer", {
        image: imageReference,
        x: Math.round(point.x),
        y: Math.round(point.y),
        name: uniqueLayerName(asset.path.split("/").at(-1)?.replace(/\.[^.]+$/u, "") || "图片层"),
      });
      state.assetLibrary = touchAssetIfIndexed(asset.path);
    } else if (asset.kind === "template") {
      await dropTemplateAsset(asset.path, point);
    } else {
      await importCompositeAsset(asset.path, point);
    }
  } catch (error) {
    reportEditorError(error);
  }
}

async function importCompositeAsset(resourcePath, point) {
  const sourceUrl = new URL(
    `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/project-resource`,
    location.origin,
  );
  sourceUrl.searchParams.set("path", resourcePath);
  const sourceResponse = await fetch(sourceUrl, { cache: "no-store", headers: mapHeaders() });
  if (!sourceResponse.ok) throw await responseError(sourceResponse, "无法读取组合 TMJ");
  const parsed = parseTiledDocument(await sourceResponse.text(), {
    expectedKind: "map",
    sourcePath: resourcePath,
  });
  await decodeTiledTileData(parsed.document);
  const dependencies = compositeDependencies(parsed.document, resourcePath);
  for (const dependencyPath of dependencies) {
    if (/\.(?:png|jpe?g|webp)$/iu.test(dependencyPath)) {
      await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
        {
          method: "POST",
          action: "map-resource-grant",
          json: { resourcePath: dependencyPath, expectedKind: "image", expectedVersion: state.session.version },
        },
      );
    }
  }
  const sourceTilesets = [];
  for (const reference of Array.isArray(parsed.document.tilesets) ? parsed.document.tilesets : []) {
    if (typeof reference?.source !== "string" || !reference.source) {
      throw new Error("组合 TMJ 暂不支持未携带外部 TSJ 的内嵌瓦片集");
    }
    const sourcePath = resolveTiledProjectReference(resourcePath, reference.source);
    const granted = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
      {
        method: "POST",
        action: "map-resource-grant",
        json: { resourcePath: sourcePath, expectedKind: "tileset", expectedVersion: state.session.version },
      },
    );
    const definition = parseTiledDocument(await loadResourceText(sourcePath), {
      expectedKind: "tileset",
      sourcePath,
    }).document;
    const layout = planTiledTilesetImport({
      mapPath: resourcePath,
      resourcePath: sourcePath,
      definition,
      dependencies: granted.resource?.dependencies || [],
      existingTilesets: [],
    });
    sourceTilesets.push({ reference, definition, maxLocalId: layout.maxLocalId });
  }
  const reuse = planTiledTilesetReuse({
    sourceMapPath: resourcePath,
    targetMapPath: state.session.relativePath,
    sourceTilesets,
    targetTilesets: currentMapTilesetDescriptors(),
  });
  const relocated = relocateCompositeMapDocument(parsed.document, {
    sourcePath: resourcePath,
    targetPath: state.session.relativePath,
  });
  await hydrateTiledTemplateInstances(relocated, state.session.relativePath);
  const remapped = remapCompositeLayerGids(relocated, (gid) => reuse.remapGlobalTileId(gid));
  const groupName = resourcePath.split("/").at(-1)?.replace(/\.tmj$/iu, "") || "组合素材";
  const group = {
    type: "group",
    name: uniqueLayerName(groupName),
    offsetx: Math.round(point?.x || 0),
    offsety: Math.round(point?.y || 0),
    layers: remapped.layers,
  };
  state.editor.runBatch(`导入组合 ${groupName}`, () => {
    for (const addition of reuse.additions) state.editor.addTileset(addition.reference, { label: `导入组合瓦片集 ${addition.sourcePath}` });
    const added = state.editor.addLayer(group, { label: `导入组合 ${groupName}` });
    state.preferredActiveLayerId = added.id;
    state.selectedLayerIds = new Set([added.id]);
  });
  state.assetLibrary = touchAssetIfIndexed(resourcePath);
  scheduleLayerTreeRebuild(state.preferredActiveLayerId, { reloadTilesets: reuse.additions.length > 0 });
}

function touchAssetIfIndexed(resourcePath) {
  try {
    const next = touchMapAsset(state.assetLibrary, resourcePath);
    state.assetLibrary = next;
    persistMapAssetLibrary();
    return next;
  } catch {
    return state.assetLibrary;
  }
}

async function dropTemplateAsset(resourcePath, point) {
  let layer = state.editor?.layerById(state.activeLayerId);
  if (layer?.type !== "objectgroup") {
    layer = state.viewer?.layerViews.find(({ layer: candidate }) => candidate.type === "objectgroup")?.layer || null;
  }
  if (!layer) {
    createLayer("objectgroup", { name: uniqueLayerName("对象层") });
    layer = state.editor?.layerById(state.preferredActiveLayerId);
  }
  if (!layer || layer.type !== "objectgroup") throw new Error("没有可放置对象模板的对象层");
  const { template } = await readTemplateSource(resourcePath);
  const local = state.viewer?.pointForLayer(layer.id, point) || point;
  const prepared = await materializeTemplateForCurrentMap(template, {}, {
    x: Math.round(local.x),
    y: Math.round(local.y),
    targetPath: state.session.relativePath,
    templatePath: resourcePath,
  });
  delete prepared.object.id;
  let added;
  state.editor.runBatch(`拖入模板 ${resourcePath.split("/").at(-1)}`, () => {
    for (const addition of prepared.plan?.additions || []) {
      state.editor.addTileset(addition.reference, { label: `加入模板瓦片集 ${addition.sourcePath || "内嵌瓦片集"}` });
    }
    added = state.editor.addObject(layer.id, prepared.object, { label: `拖入模板 ${resourcePath.split("/").at(-1)}` });
  });
  if (prepared.plan?.additions?.length) {
    state.preferredActiveLayerId = layer.id;
    scheduleLayerTreeRebuild(layer.id, { reloadTilesets: true });
  } else {
    scheduleLayerRefresh(layer.id);
  }
  selectObject(added.id);
  touchAssetIfIndexed(resourcePath);
}

function setAssetLibraryState(message, status = "") {
  elements.assetLibraryState.textContent = String(message || "");
  elements.assetLibraryState.dataset.status = status;
}

function assetLibraryIcon(kind) {
  return ({ image: "image", tileset: "grid-2x2", template: "package", "composite-map": "layers-3" })[kind] || "file";
}

function assetLibraryKindLabel(kind) {
  return ({ image: "图片", tileset: "TSJ", template: "模板", "composite-map": "TMJ" })[kind] || kind;
}

async function loadTilesetAssets(directory = "", { append = false } = {}) {
  if (state.tilesetAssetLoading) return;
  const normalized = String(directory || "").replace(/^\/+|\/+$/gu, "");
  if (!append) {
    state.tilesetAssetDirectory = normalized;
    state.tilesetAssetCursor = null;
    state.tilesetAssetEntries = [];
    state.selectedTilesetAsset = null;
  }
  state.tilesetAssetLoading = true;
  setTilesetAssetState("正在读取 TSJ 素材目录…");
  try {
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets`,
      location.origin,
    );
    if (normalized) url.searchParams.set("directory", normalized);
    url.searchParams.set("limit", "100");
    if (append && state.tilesetAssetCursor) url.searchParams.set("cursor", state.tilesetAssetCursor);
    const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
    if (!response.ok) throw await responseError(response, "无法读取 TSJ 素材目录");
    const data = await response.json();
    const entries = Array.isArray(data.catalog?.entries) ? data.catalog.entries : [];
    state.tilesetAssetEntries = append
      ? [...state.tilesetAssetEntries, ...entries]
      : entries;
    state.tilesetAssetCursor = data.catalog?.nextCursor || null;
    renderTilesetAssetList();
    setTilesetAssetState(state.tilesetAssetEntries.some((entry) => entry.kind === "tileset")
      ? "选择一个 .tsj 外部瓦片集；导入时会一并授权其图片依赖"
      : "当前目录没有可用的 .tsj 瓦片集");
  } catch (error) {
    setTilesetAssetState(error.message, "error");
  } finally {
    state.tilesetAssetLoading = false;
    renderTilesetAssetList();
  }
}

function renderTilesetAssetList() {
  const fragment = document.createDocumentFragment();
  const entries = state.tilesetAssetEntries.filter((entry) => entry.kind === "directory" || entry.kind === "tileset");
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-asset-entry";
    button.dataset.path = entry.path;
    button.dataset.kind = entry.kind;
    button.setAttribute("role", "option");
    const selected = state.selectedTilesetAsset?.path === entry.path;
    button.setAttribute("aria-selected", String(selected));
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", entry.kind === "directory" ? "folder" : "grid-2x2");
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const pathLabel = document.createElement("small");
    pathLabel.textContent = entry.path;
    details.append(name, pathLabel);
    const size = document.createElement("span");
    size.textContent = entry.kind === "directory" ? "目录" : formatBytes(entry.size);
    button.append(icon, details, size);
    button.addEventListener("click", () => {
      if (entry.kind === "directory") {
        void loadTilesetAssets(entry.path);
        return;
      }
      state.selectedTilesetAsset = entry;
      renderTilesetAssetList();
      setTilesetAssetState(`已选择 ${entry.path}，导入时会检查并授权图片依赖`);
    });
    fragment.append(button);
  }
  elements.tilesetAssetList.replaceChildren(fragment);
  elements.tilesetAssetDirectory.textContent = state.tilesetAssetDirectory || "工程根目录";
  elements.tilesetAssetParentButton.disabled = !state.tilesetAssetDirectory || state.tilesetAssetLoading;
  elements.loadMoreTilesetAssetsButton.hidden = !state.tilesetAssetCursor || state.tilesetAssetLoading;
  elements.importTilesetButton.disabled = !state.selectedTilesetAsset || state.tilesetAssetLoading;
  refreshIcons();
}

function setTilesetAssetState(message, status = "") {
  elements.tilesetAssetState.textContent = String(message || "");
  elements.tilesetAssetState.dataset.status = status;
}

async function importSelectedTileset() {
  const asset = state.selectedTilesetAsset;
  if (!asset || state.tilesetAssetLoading || !state.session?.writable || state.layerTreeRebuildRunning) return;
  elements.importTilesetButton.disabled = true;
  setTilesetAssetState("正在授权 TSJ 及图片依赖…");
  try {
    const data = await mapMutation(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
      {
        method: "POST",
        action: "map-resource-grant",
        json: {
          resourcePath: asset.path,
          expectedKind: "tileset",
          expectedVersion: state.session.version,
        },
      },
    );
    const resource = data?.resource;
    const sourcePath = resource?.path || asset.path;
    const parsed = parseTiledDocument(await loadResourceText(sourcePath), {
      expectedKind: "tileset",
      sourcePath,
    });
    const plan = planTiledTilesetImport({
      mapPath: state.session.relativePath,
      resourcePath: sourcePath,
      definition: parsed.document,
      dependencies: resource?.dependencies || [],
      existingTilesets: currentMapTilesetDescriptors(),
    });
    if (!plan.reusedExisting) {
      state.editor.addTileset(plan.reference, { label: `导入瓦片集 ${plan.label}` });
      state.preferredActiveLayerId = state.activeLayerId;
      scheduleLayerTreeRebuild(state.activeLayerId, { reloadTilesets: true });
    }
    const dependencyCount = Math.max(0, plan.dependencyPaths.length - 1);
    setTilesetAssetState(
      plan.reusedExisting
        ? `${plan.label} 已在当前地图复用（firstgid ${plan.firstgid}），无需重复添加`
        : `已加入 ${plan.label}（firstgid ${plan.firstgid}），已授权 ${dependencyCount} 个图片依赖`,
    );
    elements.tilesetAssetDialog.close();
  } catch (error) {
    setTilesetAssetState(error.message, "error");
    elements.importTilesetButton.disabled = false;
  }
}

async function loadImageAssets(directory = "", { append = false } = {}) {
  if (state.imageAssetLoading) return;
  const normalized = String(directory || "").replace(/^\/+|\/+$/gu, "");
  if (!append) {
    state.imageAssetDirectory = normalized;
    state.imageAssetCursor = null;
    state.imageAssetEntries = [];
  }
  state.imageAssetLoading = true;
  setImageAssetState("正在读取素材目录…");
  try {
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets`,
      location.origin,
    );
    if (normalized) url.searchParams.set("directory", normalized);
    url.searchParams.set("limit", "100");
    if (append && state.imageAssetCursor) url.searchParams.set("cursor", state.imageAssetCursor);
    const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
    if (!response.ok) throw await responseError(response, "无法读取图片素材目录");
    const data = await response.json();
    const entries = Array.isArray(data.catalog?.entries) ? data.catalog.entries : [];
    for (const entry of entries) state.imageAssetSelectionEntries.set(entry.path, entry);
    state.imageAssetEntries = append
      ? [...state.imageAssetEntries, ...entries]
      : entries;
    state.imageAssetCursor = data.catalog?.nextCursor || null;
    renderImageAssetList();
    setImageAssetState(state.imageAssetEntries.length
      ? state.mapImageAssetRole ? "选择一张图片作为源图或蒙版" : "可多选图片；导入时每张图片会创建一个独立图层"
      : "当前目录没有可用的图片素材");
  } catch (error) {
    setImageAssetState(error.message, "error");
  } finally {
    state.imageAssetLoading = false;
    elements.refreshImageAssetsButton.disabled = false;
    renderImageAssetList();
  }
}

function renderImageAssetList() {
  const fragment = document.createDocumentFragment();
  const entries = state.imageAssetEntries.filter((entry) => (
    entry.kind === "directory"
    || (entry.kind === "image" && (!state.mapImageAssetRole || state.mapImageAssetRole !== "mask" || /\.png$/iu.test(entry.path || "")))
  ));
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-asset-entry";
    button.dataset.path = entry.path;
    button.dataset.kind = entry.kind;
    button.setAttribute("role", "option");
    const selected = state.mapImageAssetRole
      ? state.selectedImageAsset?.path === entry.path
      : state.selectedImageAssets.has(entry.path);
    button.setAttribute("aria-selected", String(selected));
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", entry.kind === "directory" ? "folder" : "image");
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const pathLabel = document.createElement("small");
    pathLabel.textContent = entry.path;
    details.append(name, pathLabel);
    const size = document.createElement("span");
    size.textContent = entry.kind === "directory" ? "目录" : formatBytes(entry.size);
    button.append(icon, details, size);
    button.addEventListener("click", () => {
      if (entry.kind === "directory") {
        void loadImageAssets(entry.path);
        return;
      }
      if (state.mapImageAssetRole) {
        state.selectedImageAsset = entry;
        state.selectedImageAssets = new Set([entry.path]);
      } else {
        const next = new Set(state.selectedImageAssets);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        state.selectedImageAssets = next;
        state.selectedImageAsset = next.size ? entry : null;
        if (next.has(entry.path)) state.imageAssetSelectionEntries.set(entry.path, entry);
        else state.imageAssetSelectionEntries.delete(entry.path);
      }
      renderImageAssetList();
      const count = state.mapImageAssetRole ? 1 : state.selectedImageAssets.size;
      setImageAssetState(
        state.mapImageAssetRole
          ? `已选择 ${entry.path}`
          : count ? `已选择 ${count} 张图片；导入时会一次创建对应图片层` : "尚未选择图片",
      );
    });
    fragment.append(button);
  }
  elements.imageAssetList.replaceChildren(fragment);
  elements.imageAssetDirectory.textContent = state.imageAssetDirectory || "工程根目录";
  elements.imageAssetParentButton.disabled = !state.imageAssetDirectory || state.imageAssetLoading;
  elements.loadMoreImageAssetsButton.hidden = !state.imageAssetCursor || state.imageAssetLoading;
  const selectionCount = state.mapImageAssetRole ? (state.selectedImageAsset ? 1 : 0) : state.selectedImageAssets.size;
  elements.importImageLayerButton.disabled = selectionCount < 1 || state.imageAssetLoading;
  if (!state.mapImageAssetRole) {
    elements.importImageLayerButton.innerHTML = selectionCount > 1
      ? `<i data-lucide="images"></i><span>加入 ${selectionCount} 个图片图层</span>`
      : '<i data-lucide="image-plus"></i><span>加入图片图层</span>';
  }
  elements.imageAssetList.setAttribute("aria-multiselectable", String(!state.mapImageAssetRole));
  refreshIcons();
}

function setImageAssetState(message, status = "") {
  elements.imageAssetState.textContent = String(message || "");
  elements.imageAssetState.dataset.status = status;
}

async function importSelectedImageLayer() {
  const selectedAssets = state.mapImageAssetRole
    ? (state.selectedImageAsset ? [state.selectedImageAsset] : [])
    : [...state.selectedImageAssets]
      .map((resourcePath) => state.imageAssetSelectionEntries.get(resourcePath))
      .filter((entry) => entry?.kind === "image");
  if (!selectedAssets.length || state.imageAssetLoading || !state.session?.writable) return;
  const asset = selectedAssets[0];
  if (state.mapImageAssetRole === "mask" && !/\.png$/iu.test(asset.path || "")) {
    setImageAssetState("编辑蒙版必须是 PNG", "error");
    return;
  }
  elements.importImageLayerButton.disabled = true;
  setImageAssetState("正在授权并加入图片图层…");
  try {
    const granted = [];
    for (const selected of selectedAssets) {
      granted.push(await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
        {
          method: "POST",
          action: "map-resource-grant",
          json: {
            resourcePath: selected.path,
            expectedKind: "image",
            expectedVersion: state.session.version,
          },
        },
      ));
    }
    const data = granted[0];
    if (state.mapImageAssetRole) {
      const grantedPath = data.resource?.path || asset.path;
      if (state.mapImageAssetRole === "source") {
        state.mapImageSourcePaths = [grantedPath];
        state.mapImageSourceFile = null;
        state.mapImageUseSelection = false;
        state.mapImageSourceLayerId = null;
        elements.mapImageSourceFile.value = "";
      } else {
        state.mapImageMaskPath = grantedPath;
        state.mapImageMaskFile = null;
        elements.mapImageMaskFile.value = "";
      }
      setMapImageMessage(
        state.mapImageAssetRole === "mask" ? "蒙版已授权并绑定到当前窗口" : "源图已授权并绑定到当前窗口",
      );
      closeImageAssetPicker();
      renderMapImageOperationControls();
      void refreshMapImageSourcePreview();
      return;
    }
    const placement = newLayerPlacement();
    const usedNames = new Set((state.viewer?.layerViews || []).map(({ layer }) => String(layer.name || "")));
    const nextName = (baseName) => {
      const normalized = String(baseName || "图片图层");
      if (!usedNames.has(normalized)) {
        usedNames.add(normalized);
        return normalized;
      }
      let suffix = 2;
      while (usedNames.has(`${normalized} ${suffix}`)) suffix += 1;
      const result = `${normalized} ${suffix}`;
      usedNames.add(result);
      return result;
    };
    const addedLayerIds = [];
    state.editor.runBatch(
      selectedAssets.length > 1 ? `批量导入 ${selectedAssets.length} 个图片图层` : "导入图片图层",
      () => {
        for (let index = 0; index < selectedAssets.length; index += 1) {
          const resource = granted[index]?.resource;
          if (!resource?.path) throw new Error("图片素材授权响应无效");
          const selected = selectedAssets[index];
          const imageReference = relativeTiledProjectReference(state.session.relativePath, resource.path);
          const baseName = selected.name.replace(/\.[^.]+$/u, "") || "图片图层";
          const layer = state.editor.addLayer({
            image: imageReference,
            name: nextName(baseName),
            type: "imagelayer",
            opacity: 1,
            visible: true,
            x: 0,
            y: 0,
          }, {
            parentId: placement.parentId,
            index: Number.isSafeInteger(placement.index) ? placement.index + index : undefined,
            label: selectedAssets.length > 1 ? "批量导入图片图层" : "导入图片图层",
          });
          addedLayerIds.push(layer.id);
        }
      },
    );
    state.selectedLayerIds = new Set(addedLayerIds);
    state.layerSelectionAnchorId = addedLayerIds.at(-1) ?? null;
    state.preferredActiveLayerId = addedLayerIds.at(-1) ?? state.activeLayerId;
    for (const selected of selectedAssets) touchAssetIfIndexed(selected.path);
    elements.imageLayerDialog.close();
  } catch (error) {
    setImageAssetState(error.message, "error");
    elements.importImageLayerButton.disabled = false;
  }
}

function renderTilePalette() {
  renderTerrainBrushControls();
  const total = state.viewer.tilePaletteCount();
  const pageCount = total ? Math.ceil(total / TILE_PALETTE_PAGE_SIZE) : 0;
  state.tilePalettePage = Math.min(
    Math.max(0, state.tilePalettePage),
    Math.max(0, pageCount - 1),
  );
  const offset = state.tilePalettePage * TILE_PALETTE_PAGE_SIZE;
  const entries = state.viewer.tilePaletteEntries({ offset, limit: TILE_PALETTE_PAGE_SIZE });
  state.tilePaletteEntries = entries;
  const fragment = document.createDocumentFragment();
  const tilesetNames = new Set(entries.map((entry) => entry.tilesetName));
  elements.tilePaletteTitle.textContent = tilesetNames.size === 1 ? [...tilesetNames][0] : "瓦片";
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tile-swatch";
    button.dataset.gid = String(entry.gid);
    button.dataset.localId = String(entry.localId);
    button.dataset.tilesetKey = entry.tilesetKey;
    button.title = `${entry.tilesetName} · GID ${entry.gid}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", "false");
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    const frame = entry.texture.frame;
    const resource = entry.texture.source.resource;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, 32, 32);
    context.drawImage(resource, frame.x, frame.y, frame.width, frame.height, 0, 0, 32, 32);
    button.append(canvas);
    button.addEventListener("click", (event) => selectPaletteTile(entry, {
      extend: event.shiftKey || state.tileStampSelecting,
    }));
    fragment.append(button);
  }
  elements.tilePaletteGrid.replaceChildren(fragment);
  elements.tilePaletteGrid.dataset.renderedCount = String(entries.length);
  elements.tilePaletteGrid.dataset.totalCount = String(total);
  elements.tilePalettePreviousButton.disabled = state.tilePalettePage === 0;
  elements.tilePaletteNextButton.disabled = pageCount === 0 || state.tilePalettePage >= pageCount - 1;
  elements.tilePalettePageState.textContent = pageCount ? `${state.tilePalettePage + 1} / ${pageCount}` : "0 / 0";
  elements.tilePalettePageState.setAttribute(
    "aria-label",
    pageCount ? `第 ${state.tilePalettePage + 1} 页，共 ${pageCount} 页` : "没有可用瓦片",
  );
  if (!entries.length) {
    if (!total) {
      state.selectedGid = null;
      state.tileStamp = null;
      state.tileStampAnchor = null;
      setTileStampSelecting(false);
      elements.selectedTileState.textContent = "--";
      updateToolAvailability();
    }
    return;
  }
  if (!state.tileStamp || !Number.isInteger(state.selectedGid)) selectPaletteTile(entries[0]);
  else {
    renderTileStampSelection();
    updateToolAvailability();
  }
}

function renderTerrainBrushControls() {
  const entries = state.viewer?.terrainPaletteEntries?.() || [];
  state.terrainEntries = entries;
  if (!entries.some((entry) => entry.key === state.selectedTerrainKey)) {
    state.selectedTerrainKey = entries[0]?.key || null;
    state.selectedTerrainColor = entries.length ? 1 : 0;
  }
  elements.terrainBrushControls.hidden = !entries.length;
  const setOptions = document.createDocumentFragment();
  for (const entry of entries) setOptions.append(new Option(`${entry.tilesetName} · ${entry.name}`, entry.key));
  elements.terrainSetSelect.replaceChildren(setOptions);
  if (state.selectedTerrainKey) elements.terrainSetSelect.value = state.selectedTerrainKey;
  const terrain = currentTerrainEntry();
  const colorOptions = document.createDocumentFragment();
  colorOptions.append(new Option("0 清除 Terrain", "0"));
  for (const color of terrain?.colors || []) colorOptions.append(new Option(`${color.index} ${color.name}`, String(color.index)));
  elements.terrainColorSelect.replaceChildren(colorOptions);
  if (!terrain?.colors.some((color) => color.index === state.selectedTerrainColor) && state.selectedTerrainColor !== 0) {
    state.selectedTerrainColor = terrain?.colors[0]?.index || 0;
  }
  elements.terrainColorSelect.value = String(state.selectedTerrainColor);
  elements.terrainBrushSeed.value = String(state.terrainBrushSeed);
  elements.terrainBrushState.textContent = state.terrainBrushMessage || (terrain
    ? `${terrain.type} · ${terrain.candidates.length} 个 wangtile · 设置变化只影响下一笔`
    : "当前地图没有可用 Terrain Set");
  elements.terrainBrushState.dataset.status = state.terrainBrushMessage.includes("近似") ? "warning" : "";
}

function currentTerrainEntry() {
  return state.terrainEntries.find((entry) => entry.key === state.selectedTerrainKey) || null;
}

function selectTerrainSet() {
  state.selectedTerrainKey = elements.terrainSetSelect.value || null;
  state.selectedTerrainColor = currentTerrainEntry()?.colors[0]?.index || 0;
  state.terrainBrushMessage = "";
  renderTerrainBrushControls();
  updateToolAvailability();
}

function selectTerrainColor() {
  state.selectedTerrainColor = Number(elements.terrainColorSelect.value);
  state.terrainBrushMessage = "";
  renderTerrainBrushControls();
  updateToolAvailability();
}

function updateTerrainBrushSeed() {
  try {
    state.terrainBrushSeed = normalizeTileRandomSeed(Number(elements.terrainBrushSeed.value));
    state.terrainBrushMessage = "Seed 已更新，只影响下一笔 Terrain";
  } catch (error) {
    reportEditorError(error);
  }
  renderTerrainBrushControls();
}

function randomizeTerrainBrushSeed() {
  state.terrainBrushSeed = crypto.getRandomValues(new Uint32Array(1))[0];
  state.terrainBrushMessage = "已生成新 Seed，只影响下一笔 Terrain";
  renderTerrainBrushControls();
}

function changeTilePalettePage(delta) {
  const total = state.viewer?.tilePaletteCount() || 0;
  const pageCount = total ? Math.ceil(total / TILE_PALETTE_PAGE_SIZE) : 0;
  const nextPage = Math.min(
    Math.max(0, state.tilePalettePage + delta),
    Math.max(0, pageCount - 1),
  );
  if (nextPage === state.tilePalettePage) return;
  state.tilePalettePage = nextPage;
  renderTilePalette();
  elements.tilePaletteGrid.scrollTop = 0;
}

function selectTile(gid) {
  const encodedGid = Number(gid) >>> 0;
  const entry = state.tilePaletteEntries.find((candidate) => candidate.gid === encodedGid);
  if (entry) {
    selectPaletteTile(entry);
    return;
  }
  state.tileStamp = singleTileStamp(encodedGid);
  state.selectedGid = encodedGid;
  state.tileStampAnchor = null;
  setTileStampSelecting(false);
  renderTileStampSelection();
  refreshObjectCreationControls();
  updateToolAvailability();
}

function selectPaletteTile(entry, options = {}) {
  try {
    const extend = options.extend === true && state.tileStampAnchor;
    state.tileStamp = extend
      ? paletteTileStamp(state.tileStampAnchor, entry)
      : singleTileStamp(entry.gid);
    state.selectedGid = state.tileStamp.cells[0].gid;
    if (!extend) state.tileStampAnchor = entry;
    if (state.tileStampSelecting) setTileStampSelecting(false);
    renderTileStampSelection();
    refreshObjectCreationControls();
    updateToolAvailability();
  } catch (error) {
    setTileStampSelecting(false);
    reportEditorError(error);
  }
}

function renderTileStampSelection() {
  const stamp = state.tileStamp;
  const selectedBaseGids = new Set((stamp?.cells || []).map(({ gid }) => decodeGlobalTileId(gid).gid));
  const selectedBaseGid = Number.isInteger(state.selectedGid) ? decodeGlobalTileId(state.selectedGid).gid : null;
  const transformed = (stamp?.cells || []).some(({ gid }) => {
    const decoded = decodeGlobalTileId(gid);
    return decoded.horizontal || decoded.vertical || decoded.diagonal || decoded.rotatedHex120;
  });
  const anchorGid = state.tileStampAnchor?.gid ?? null;
  for (const swatch of elements.tilePaletteGrid.querySelectorAll(".tile-swatch")) {
    const gid = Number(swatch.dataset.gid);
    const active = gid === selectedBaseGid;
    const stampSelected = selectedBaseGids.has(gid);
    swatch.classList.toggle("is-active", active);
    swatch.classList.toggle("is-stamp-selected", stampSelected);
    swatch.classList.toggle("is-stamp-anchor", gid === anchorGid);
    swatch.setAttribute("aria-pressed", String(stampSelected));
  }
  if (!stamp || !Number.isInteger(state.selectedGid)) {
    elements.selectedTileState.textContent = "--";
  } else if (stamp.width > 1 || stamp.height > 1) {
    elements.selectedTileState.textContent = `Stamp ${stamp.width} × ${stamp.height}${transformed ? " · 已变换" : ""}${state.tileRandomEnabled ? " · 随机" : ""}`;
  } else if (selectedBaseGid === 0) {
    elements.selectedTileState.textContent = "空瓦片";
  } else {
    elements.selectedTileState.textContent = `GID ${selectedBaseGid}${transformed ? " · 已变换" : ""}${state.tileRandomEnabled ? " · 随机" : ""}`;
  }
  const canSelectStamp = state.tileStampAnchor?.layoutKind === "atlas" && state.tileStampAnchor.tileCount > 1;
  elements.tileStampSelectButton.disabled = !canSelectStamp;
  elements.tileStampSelectButton.classList.toggle("is-active", state.tileStampSelecting);
  elements.tileStampSelectButton.setAttribute("aria-pressed", String(state.tileStampSelecting));
  renderTileStampControls();
}

function toggleTileStampSelection() {
  if (elements.tileStampSelectButton.disabled) return;
  setTileStampSelecting(!state.tileStampSelecting);
}

function setTileStampSelecting(value) {
  state.tileStampSelecting = value === true;
  elements.tileStampSelectButton.classList.toggle("is-active", state.tileStampSelecting);
  elements.tileStampSelectButton.setAttribute("aria-pressed", String(state.tileStampSelecting));
  elements.tileStampSelectButton.title = state.tileStampSelecting
    ? "点选同一图集中的 Stamp 终点"
    : "选择多格 Stamp";
}

function renderTileStampControls() {
  const hasStamp = Boolean(state.tileStamp?.cells?.length);
  const hexagonal = state.document?.orientation === "hexagonal";
  for (const button of elements.tileStampToolbar.querySelectorAll("[data-tile-stamp-transform]")) {
    const unsupported = hexagonal && !["flip-horizontal", "flip-vertical"].includes(button.dataset.tileStampTransform);
    button.disabled = !hasStamp || unsupported;
    button.setAttribute("aria-disabled", String(button.disabled));
  }
  elements.tileRandomButton.disabled = !hasStamp;
  elements.tileRandomButton.classList.toggle("is-active", state.tileRandomEnabled);
  elements.tileRandomButton.setAttribute("aria-pressed", String(state.tileRandomEnabled));
  elements.tileRandomSeedControl.hidden = !hasStamp || !state.tileRandomEnabled;
  elements.tileRandomSeed.value = String(state.tileRandomSeed);
  elements.tileStampLibraryButton.disabled = !hasStamp && !state.tileStampLibrary.entries.length;
  elements.saveNamedTileStampButton.disabled = !hasStamp;
  elements.copyTileStampButton.disabled = !hasStamp;
  elements.pasteTileStampButton.disabled = !state.session?.writable || !state.viewer;
}

function transformSelectedTileStamp(operation) {
  if (!state.tileStamp) return;
  try {
    state.tileStamp = transformTileStamp(state.tileStamp, operation, {
      hexagonal: state.document?.orientation === "hexagonal",
    });
    state.selectedGid = state.tileStamp.cells[0]?.gid ?? 0;
    state.tileStampAnchor = null;
    setTileStampSelecting(false);
    renderTileStampSelection();
    refreshObjectCreationControls();
    updateToolAvailability();
  } catch (error) {
    reportEditorError(error);
  }
}

function toggleTileRandomMode() {
  if (elements.tileRandomButton.disabled) return;
  state.tileRandomEnabled = !state.tileRandomEnabled;
  renderTileStampSelection();
  scheduleMapEditorViewStateSave();
}

function updateTileRandomSeed() {
  try {
    state.tileRandomSeed = normalizeTileRandomSeed(elements.tileRandomSeed.value);
    scheduleMapEditorViewStateSave();
  } catch (error) {
    elements.tileRandomSeed.value = String(state.tileRandomSeed);
    reportEditorError(error);
  }
}

function randomizeTileSeed() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  state.tileRandomSeed = values[0];
  elements.tileRandomSeed.value = String(state.tileRandomSeed);
  scheduleMapEditorViewStateSave();
}

function showTileStampLibrary() {
  renderTileStampLibrary();
  elements.tileStampLibraryState.textContent = "";
  delete elements.tileStampLibraryState.dataset.status;
  elements.tileStampLibraryDialog.showModal();
  if (state.tileStamp) elements.tileStampName.focus();
}

function saveNamedTileStamp(event) {
  event.preventDefault();
  if (!state.tileStamp) return;
  try {
    state.tileStampLibrary = upsertNamedTileStamp(state.tileStampLibrary, {
      id: crypto.randomUUID(),
      name: elements.tileStampName.value,
      stamp: state.tileStamp,
    });
    persistTileStampLibrary();
    elements.tileStampLibraryState.textContent = `已保存 ${elements.tileStampName.value.trim()}`;
    delete elements.tileStampLibraryState.dataset.status;
    elements.tileStampName.value = "";
    renderTileStampLibrary();
  } catch (error) {
    elements.tileStampLibraryState.textContent = error.message;
    elements.tileStampLibraryState.dataset.status = "error";
  }
}

function handleTileStampLibraryAction(event) {
  const button = event.target instanceof Element ? event.target.closest("[data-tile-stamp-action]") : null;
  if (!button) return;
  const entry = state.tileStampLibrary.entries.find((candidate) => candidate.id === button.dataset.tileStampId);
  if (!entry) return;
  try {
    if (button.dataset.tileStampAction === "use") {
      const result = touchNamedTileStamp(state.tileStampLibrary, entry.id);
      state.tileStampLibrary = result.library;
      state.tileStamp = result.entry.stamp;
      state.selectedGid = state.tileStamp.cells[0]?.gid ?? 0;
      state.tileStampAnchor = null;
      setTileStampSelecting(false);
      persistTileStampLibrary();
      renderTileStampSelection();
      updateToolAvailability();
      if (toolAvailable("brush")) setActiveTool("brush");
      elements.tileStampLibraryDialog.close();
      return;
    }
    if (button.dataset.tileStampAction === "favorite") {
      state.tileStampLibrary = setNamedTileStampFavorite(state.tileStampLibrary, entry.id, !entry.favorite);
      persistTileStampLibrary();
      renderTileStampLibrary();
      return;
    }
    if (button.dataset.tileStampAction === "delete") {
      if (!window.confirm(`删除命名 Stamp“${entry.name}”？`)) return;
      state.tileStampLibrary = removeNamedTileStamp(state.tileStampLibrary, entry.id);
      persistTileStampLibrary();
      renderTileStampLibrary();
      renderTileStampControls();
    }
  } catch (error) {
    elements.tileStampLibraryState.textContent = error.message;
    elements.tileStampLibraryState.dataset.status = "error";
  }
}

function renderTileStampLibrary() {
  const entries = sortedNamedTileStamps(state.tileStampLibrary);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "tile-stamp-library-empty";
    empty.textContent = "暂无命名 Stamp";
    elements.tileStampLibraryList.replaceChildren(empty);
    refreshIcons();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "tile-stamp-library-row";
    row.dataset.tileStampId = entry.id;
    const useButton = document.createElement("button");
    useButton.type = "button";
    useButton.dataset.tileStampAction = "use";
    useButton.dataset.tileStampId = entry.id;
    const name = document.createElement("span");
    name.textContent = entry.name;
    const detail = document.createElement("small");
    detail.textContent = `${entry.stamp.width} × ${entry.stamp.height} · ${entry.stamp.cells.filter(({ gid }) => decodeGlobalTileId(gid).gid > 0).length} 瓦片`;
    useButton.append(name, detail);
    const favoriteButton = document.createElement("button");
    favoriteButton.type = "button";
    favoriteButton.className = `mini-icon-button${entry.favorite ? " is-favorite" : ""}`;
    favoriteButton.dataset.tileStampAction = "favorite";
    favoriteButton.dataset.tileStampId = entry.id;
    favoriteButton.title = entry.favorite ? "取消收藏" : "收藏";
    favoriteButton.setAttribute("aria-label", favoriteButton.title);
    favoriteButton.setAttribute("aria-pressed", String(entry.favorite));
    favoriteButton.innerHTML = '<i data-lucide="star"></i>';
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "mini-icon-button is-danger";
    deleteButton.dataset.tileStampAction = "delete";
    deleteButton.dataset.tileStampId = entry.id;
    deleteButton.title = "删除命名 Stamp";
    deleteButton.setAttribute("aria-label", deleteButton.title);
    deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
    row.append(useButton, favoriteButton, deleteButton);
    fragment.append(row);
  }
  elements.tileStampLibraryList.replaceChildren(fragment);
  refreshIcons();
}

function tileStampTransferPayload() {
  if (!state.tileStamp || !state.session || !state.viewer) throw new Error("请先选择一个 Stamp");
  const tilesets = (state.document?.tilesets || []).map((reference, index) => {
    const loaded = state.viewer.tilesets?.[index];
    const entry = {
      firstgid: Number(reference?.firstgid),
      maxLocalId: Number.isSafeInteger(loaded?.maxLocalId) ? loaded.maxLocalId : -1,
    };
    if (reference?.source) {
      entry.ownerPath = resolveTiledProjectReference(state.session.relativePath, reference.source);
    } else {
      entry.definition = cloneJsonValue(loaded?.definition || reference);
    }
    return entry;
  });
  return {
    version: 1,
    kind: "wfl-tile-stamp",
    source: {
      projectPath: state.credentials?.projectPath || "",
      mapPath: state.session.relativePath,
    },
    tilesets,
    stamp: cloneJsonValue(state.tileStamp),
  };
}

async function copyTileStampToClipboard() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不允许写入剪贴板");
    const source = JSON.stringify(tileStampTransferPayload());
    if (source.length > 1_000_000) throw new Error("Stamp 依赖信息过大，请缩小选区后再复制");
    await navigator.clipboard.writeText(source);
    elements.tileStampLibraryState.textContent = "已复制可跨地图复用的 Stamp；粘贴到另一个地图窗口即可自动重映射 GID";
    delete elements.tileStampLibraryState.dataset.status;
  } catch (error) {
    elements.tileStampLibraryState.textContent = error.message;
    elements.tileStampLibraryState.dataset.status = "error";
  }
}

async function pasteTileStampFromClipboard() {
  try {
    if (!navigator.clipboard?.readText) throw new Error("当前浏览器不允许读取剪贴板");
    const raw = await navigator.clipboard.readText();
    if (raw.length > 1_000_000) throw new Error("剪贴板 Stamp 过大");
    const payload = JSON.parse(raw);
    if (payload?.version !== 1 || payload.kind !== "wfl-tile-stamp") {
      throw new Error("剪贴板内容不是 WFL 跨地图 Stamp");
    }
    if (payload.source?.projectPath && payload.source.projectPath !== state.credentials?.projectPath) {
      throw new Error("这个 Stamp 来自其他工程；请先把它引用的 TSJ 和图片依赖复制到当前工程，再粘贴");
    }
    const plan = planTiledTilesetReuse({
      sourceMapPath: payload.source?.mapPath,
      targetMapPath: state.session.relativePath,
      sourceTilesets: payload.tilesets,
      targetTilesets: currentMapTilesetDescriptors(),
      sourceProjectId: payload.source?.projectPath || null,
      targetProjectId: state.credentials?.projectPath || null,
    });
    if (plan.additions.some((entry) => entry.requiresResourceCopy)) {
      throw new Error("跨工程 Stamp 需要先复制 TSJ 及其图片依赖；当前不会自动降级或丢失瓦片");
    }
    for (const addition of plan.additions) {
      if (!addition.sourcePath) throw new Error("内嵌瓦片集不能通过剪贴板自动复制，请先另存为外部 TSJ");
      await mapMutation(
        `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/assets/grant`,
        {
          method: "POST",
          action: "map-resource-grant",
          json: {
            resourcePath: addition.sourcePath,
            expectedKind: "tileset",
            expectedVersion: state.session.version,
          },
        },
      );
      state.editor.addTileset(addition.reference, { label: "复用跨地图 Stamp 的瓦片集" });
    }
    state.tileStamp = plan.remapTileStamp(payload.stamp);
    state.selectedGid = state.tileStamp.cells[0]?.gid ?? 0;
    state.tileStampAnchor = null;
    setTileStampSelecting(false);
    if (plan.additions.length) {
      state.preferredActiveLayerId = state.activeLayerId;
      scheduleLayerTreeRebuild(state.activeLayerId, { reloadTilesets: true });
    }
    renderTileStampSelection();
    refreshObjectCreationControls();
    updateToolAvailability();
    elements.tileStampLibraryState.textContent = plan.additions.length
      ? `已复制 ${plan.additions.length} 个瓦片集并重映射 Stamp GID；尚未保存地图`
      : "已复用当前地图已有瓦片集并重映射 Stamp GID；尚未保存地图";
    delete elements.tileStampLibraryState.dataset.status;
  } catch (error) {
    elements.tileStampLibraryState.textContent = error.message;
    elements.tileStampLibraryState.dataset.status = "error";
  }
}

function toggleLayerVisibility(view, visible) {
  const layerIds = state.selectedLayerIds.has(view.layer.id)
    ? [...state.selectedLayerIds]
    : [view.layer.id];
  for (const layerId of layerIds) {
    const selectedView = state.viewer.layerViews.find(({ layer }) => layer.id === layerId);
    if (selectedView) state.viewer.setLayerVisible(selectedView.key, visible);
  }
  if (state.session.writable) {
    state.editor.runBatch(layerIds.length > 1 ? `${visible ? "显示" : "隐藏"} ${layerIds.length} 个图层` : `${visible ? "显示" : "隐藏"}图层`, () => {
      for (const layerId of layerIds) {
        const layer = state.editor.layerById(layerId);
        if (layer?.visible !== visible) {
          state.editor.updateLayer(layerId, { visible }, { label: visible ? "显示图层" : "隐藏图层" });
        }
      }
    });
  }
}

function toggleLayerLock(view, button) {
  if (!state.session.writable) return;
  const locked = view.layer.locked !== true;
  const layerIds = state.selectedLayerIds.has(view.layer.id)
    ? [...state.selectedLayerIds]
    : [view.layer.id];
  state.editor.runBatch(layerIds.length > 1 ? `${locked ? "锁定" : "解锁"} ${layerIds.length} 个图层` : `${locked ? "锁定" : "解锁"}图层`, () => {
    for (const layerId of layerIds) {
      const layer = state.editor.layerById(layerId);
      if (layer && (layer.locked === true) !== locked) {
        state.editor.updateLayer(layerId, { locked }, { label: locked ? "锁定图层" : "解锁图层" });
      }
    }
  });
  setLayerLockButton(button, state.editor.layerById(view.layer.id));
  refreshIcons();
}

function setLayerLockButton(button, layer) {
  const locked = layer.locked === true;
  button.innerHTML = `<i data-lucide="${locked ? "lock" : "lock-open"}"></i>`;
  button.title = locked ? "解锁图层" : "锁定图层";
  button.setAttribute("aria-label", `${locked ? "解锁" : "锁定"}${layer.name || "图层"}`);
  button.setAttribute("aria-pressed", String(locked));
}

function defaultActiveLayer() {
  return state.viewer.layerViews.find(({ layer }) => layer.type === "tilelayer" && layer.locked !== true)
    || state.viewer.layerViews.find(({ layer }) => layer.type !== "group")
    || null;
}

function setActiveLayer(view, options = {}) {
  if (!view) return;
  if (state.activeLayerId !== view.layer.id) cancelPendingFill("切换图层，填充已取消");
  if (state.activeLayerId !== view.layer.id) {
    cancelPendingAutoMapGesture("切换图层，AutoMap While Drawing 已取消；基础编辑已保留");
  }
  const event = options.event;
  const views = state.viewer.layerViews;
  const selected = new Set(state.selectedLayerIds);
  let activeView = view;
  if (options.preserveSelection) {
    for (const layerId of [...selected]) {
      if (!views.some(({ layer }) => layer.id === layerId)) selected.delete(layerId);
    }
    if (!selected.size) selected.add(view.layer.id);
  } else if (event?.shiftKey) {
    const anchorId = state.layerSelectionAnchorId ?? state.activeLayerId ?? view.layer.id;
    const anchorIndex = views.findIndex(({ layer }) => layer.id === anchorId);
    const targetIndex = views.indexOf(view);
    selected.clear();
    for (const candidate of views.slice(
      Math.min(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex),
      Math.max(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex) + 1,
    )) selected.add(candidate.layer.id);
  } else if (event && (event.ctrlKey || event.metaKey)) {
    if (selected.has(view.layer.id) && selected.size > 1) {
      selected.delete(view.layer.id);
      activeView = [...views].reverse().find(({ layer }) => selected.has(layer.id)) || view;
    } else {
      selected.add(view.layer.id);
      state.layerSelectionAnchorId = view.layer.id;
    }
  } else {
    selected.clear();
    selected.add(view.layer.id);
    state.layerSelectionAnchorId = view.layer.id;
  }
  if (state.activeLayerId !== activeView.layer.id) {
    clearObjectSelection();
    state.tileSelectionBase = null;
    state.tileSelectionGestureMode = null;
  }
  state.selectedLayerIds = selected;
  state.activeLayerId = activeView.layer.id;
  renderLayerSelectionRows();
  setDetailTab(activeView.layer.type === "tilelayer" ? "tiles" : "properties", { force: true });
  if (activeView.layer.type === "imagelayer") renderImageLayerSelection();
  renderSelectionState();
  updateToolAvailability();
  updateLayerActionAvailability();
  renderInspector();
  scheduleMapEditorViewStateSave();
}

function setDetailTab(tab, options = {}) {
  const layer = state.editor?.layerById(state.activeLayerId);
  const tileAvailable = layer?.type === "tilelayer" && elements.tilePaletteGrid.childElementCount > 0;
  const normalized = tab === "tiles" && tileAvailable ? "tiles" : "properties";
  if (!options.force && normalized === state.detailTab) return;
  state.detailTab = normalized;
  const tilesActive = normalized === "tiles";
  elements.tilesDetailButton.disabled = !tileAvailable;
  elements.tilesDetailButton.setAttribute("aria-selected", String(tilesActive));
  elements.propertiesDetailButton.setAttribute("aria-selected", String(!tilesActive));
  elements.tilePalette.hidden = !tilesActive;
  elements.propertyInspector.hidden = tilesActive;
  if (!tilesActive) renderInspector();
  scheduleMapEditorViewStateSave();
}

function setActiveTool(tool) {
  const normalized = [
    "select",
    "tile-select",
    "hand",
    "sample",
    "brush",
    "terrain-brush",
    "eraser",
    "fill",
    "tile-line",
    "tile-rectangle",
    "tile-ellipse",
    "tile-magic",
    "tile-same",
    "object",
    "collision",
    "vertex",
  ].includes(tool)
    ? tool
    : "select";
  if (!toolAvailable(normalized)) return;
  if (normalized !== state.activeTool) cancelPendingFill("切换工具，填充已取消");
  if (normalized !== state.activeTool) {
    cancelPendingAutoMapGesture("切换工具，AutoMap While Drawing 已取消；基础编辑已保留");
  }
  cancelActiveEdit();
  state.activeTool = normalized;
  if (TILE_SHAPE_TOOLS.has(normalized)) state.tileShapeTool = normalized;
  else setTileShapeMenuOpen(false);
  for (const [name, button] of toolButtonEntries()) {
    const active = name === normalized || (name === "tile-shape" && TILE_SHAPE_TOOLS.has(normalized));
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  renderTileShapeMenu();
  renderTileSelectionControls();
  state.viewer?.setInteractionMode(normalized, handlersForTool(normalized));
  refreshObjectCreationControls();
  renderObjectSelection();
  scheduleMapEditorViewStateSave();
}

function handlersForTool(tool) {
  if (tool === "select" || tool === "tile-select") {
    return { pointerDown: beginSelection, pointerMove: updateSelection, pointerUp: finishSelection, cancel: cancelSelection };
  }
  if (tool === "brush" || tool === "eraser") {
    return { pointerDown: beginTileStroke, pointerMove: continueTileStroke, pointerUp: finishTileStroke, cancel: cancelTileStroke };
  }
  if (tool === "terrain-brush") {
    return { pointerDown: beginTerrainStroke, pointerMove: continueTerrainStroke, pointerUp: finishTerrainStroke, cancel: cancelTerrainStroke };
  }
  if (tool === "sample") return { pointerDown: sampleTile };
  if (tool === "tile-magic" || tool === "tile-same") return { pointerDown: selectTilesByMatch };
  if (tool === "fill") return { pointerDown: fillTileRegion };
  if (TILE_SHAPE_TOOLS.has(tool)) {
    return { pointerDown: beginTileShape, pointerMove: continueTileShape, pointerUp: finishTileShape, cancel: cancelTileShape };
  }
  if (tool === "object" || tool === "collision") {
    return { pointerDown: beginObject, pointerMove: updateObjectDraft, pointerUp: finishObject, cancel: cancelObject };
  }
  if (tool === "vertex") {
    return { pointerDown: beginVertexDrag, pointerMove: updateVertexDrag, pointerUp: finishVertexDrag, cancel: cancelVertexDrag };
  }
  return {};
}

function initializeMapGamepadController() {
  state.gamepadController?.stop();
  state.gamepadController = new MapGamepadController({
    isBlocked: mapGamepadInputBlocked,
    onPan: ({ x, y }) => {
      if (!mapGamepadOperationPending()) state.viewer?.panByScreen?.(x, y);
    },
    onZoom: (factor) => {
      if (!mapGamepadOperationPending()) state.viewer?.zoomBy(factor);
    },
    onAction: handleMapGamepadAction,
    onStatus: ({ connected }) => {
      announceGamepadMessage(connected
        ? "手柄已连接 · 左摇杆/D-pad 平移 · 右摇杆缩放 · A 使用工具 · B 取消"
        : "");
    },
  }).start();
}

function mapGamepadInputBlocked() {
  return document.visibilityState !== "visible"
    || Boolean(document.querySelector("dialog[open]"))
    || isTextEditingTarget(document.activeElement)
    || state.saving;
}

function mapGamepadOperationPending() {
  return Boolean(state.fillPending) || Boolean(state.autoMapGesturePending);
}

function handleMapGamepadAction(action) {
  if (!state.viewer || mapGamepadInputBlocked()) return;
  if (action === "cancel") {
    cancelPendingFill("手柄已取消填充");
    cancelPendingAutoMapGesture("手柄已取消 AutoMap While Drawing；基础编辑已保留");
    cancelActiveEdit();
    setTileShapeMenuOpen(false);
    setLayerPanelOpen(false);
    state.guideController?.setPanelOpen(false);
    return;
  }
  if (mapGamepadOperationPending()) return;
  if (action === "primary") {
    if (state.activeTool === "hand") return;
    const point = state.viewer.viewportCenterWorldPoint?.();
    const handlers = handlersForTool(state.activeTool);
    if (!point || typeof handlers.pointerDown !== "function") return;
    const input = { point, pointerType: "gamepad", shiftKey: false, ctrlKey: false, metaKey: false };
    handlers.pointerDown(input);
    handlers.pointerUp?.(input);
    return;
  }
  if (action === "select-tool") setActiveTool("select");
  else if (action === "hand-tool") setActiveTool("hand");
  else if (action === "fit") state.viewer.fit();
}

function announceGamepadMessage(message) {
  window.clearTimeout(state.gamepadStatusTimer);
  elements.gamepadState.textContent = String(message || "");
  elements.gamepadState.hidden = !message;
  if (!message) {
    state.gamepadStatusTimer = null;
    return;
  }
  state.gamepadStatusTimer = window.setTimeout(() => {
    state.gamepadStatusTimer = null;
    elements.gamepadState.hidden = true;
    elements.gamepadState.textContent = "";
  }, 5_000);
}

function toolButtonEntries() {
  return [
    ["select", elements.selectToolButton],
    ["tile-select", elements.tileRectSelectButton],
    ["hand", elements.handToolButton],
    ["sample", elements.sampleToolButton],
    ["brush", elements.brushToolButton],
    ["terrain-brush", elements.terrainBrushToolButton],
    ["eraser", elements.eraserToolButton],
    ["fill", elements.fillToolButton],
    ["tile-shape", elements.tileShapeToolButton],
    ["tile-magic", elements.tileMagicToolButton],
    ["tile-same", elements.tileSameToolButton],
    ["object", elements.objectToolButton],
    ["collision", elements.collisionToolButton],
    ["vertex", elements.vertexToolButton],
  ];
}

function toolAvailable(tool) {
  if (["select", "hand"].includes(tool)) return true;
  const layer = state.editor?.layerById(state.activeLayerId);
  if (!layer) return false;
  const unencodedTileLayer = layer.type === "tilelayer" && (
    Array.isArray(layer.data)
    || (Array.isArray(layer.chunks) && layer.chunks.every((chunk) => Array.isArray(chunk.data)))
  );
  if (["tile-select", "sample", "tile-magic", "tile-same"].includes(tool)) return unencodedTileLayer;
  if (!state.session?.writable || layer.locked === true) return false;
  if (["brush", "eraser", "fill"].includes(tool) || TILE_SHAPE_TOOLS.has(tool)) {
    return unencodedTileLayer
      && (tool === "eraser" || (Number.isInteger(state.selectedGid) && state.tileStamp));
  }
  if (tool === "terrain-brush") {
    const terrain = currentTerrainEntry();
    return unencodedTileLayer
      && Boolean(terrain?.candidates.length)
      && Number.isSafeInteger(state.selectedTerrainColor)
      && state.selectedTerrainColor >= 0
      && state.selectedTerrainColor <= (terrain?.colors.length || 0);
  }
  if (tool === "vertex") {
    const object = selectedObject();
    return layer.type === "objectgroup"
      && state.selectedObjectIds.size === 1
      && (Array.isArray(object?.polygon) || Array.isArray(object?.polyline));
  }
  return ["object", "collision"].includes(tool) && layer.type === "objectgroup" && Array.isArray(layer.objects);
}

function updateToolAvailability() {
  for (const [tool, button] of toolButtonEntries()) {
    button.disabled = !toolAvailable(tool === "tile-shape" ? state.tileShapeTool : tool);
  }
  renderTileStampSelection();
  renderTileSelectionControls();
  if (!toolAvailable(state.activeTool)) setActiveTool("select");
}

function cancelActiveEdit() {
  cancelPendingFill("填充已取消");
  cancelPendingAutoMapGesture("AutoMap While Drawing 已取消；基础编辑已保留");
  cancelTileStroke();
  cancelTerrainStroke();
  cancelTileShape();
  cancelObject();
  cancelVertexDrag();
  if (state.objectDrag || state.objectTransform || state.imageLayerDrag) cancelSelection();
}

function undoEdit() {
  cancelActiveEdit();
  if (!state.editor?.canUndo) return;
  try {
    state.editor.undo();
  } catch (error) {
    reportEditorError(error);
  }
}

function redoEdit() {
  cancelActiveEdit();
  if (!state.editor?.canRedo) return;
  try {
    state.editor.redo();
  } catch (error) {
    reportEditorError(error);
  }
}

function beginSelection({ point, shiftKey = false, ctrlKey = false, metaKey = false }) {
  const layer = state.editor?.layerById(state.activeLayerId);
  if (layer?.type === "objectgroup") {
    const transformHandle = state.viewer.objectTransformHandleAtPoint(point);
    if (transformHandle && selectedObjects().length) {
      beginObjectTransform(transformHandle, point);
      return;
    }
    const additive = shiftKey || ctrlKey || metaKey;
    const object = state.viewer.objectAtPoint(state.activeLayerId, point);
    if (object) {
      if (additive) {
        selectObject(object.id, { toggle: true });
        return;
      }
      if (!state.selectedObjectIds.has(object.id)) selectObject(object.id);
      else setPrimarySelectedObject(object.id);
      const local = state.viewer.pointForLayer(state.activeLayerId, point);
      state.objectDrag = {
        layerId: state.activeLayerId,
        start: local,
        objects: selectedObjects().map((entry) => ({
          objectId: entry.id,
          original: { x: Number(entry.x || 0), y: Number(entry.y || 0) },
          current: { x: Number(entry.x || 0), y: Number(entry.y || 0) },
        })),
      };
      return;
    }
    if (!additive) clearObjectSelection();
    state.objectMarqueeAdditive = additive;
    state.selectionStart = point;
    updateSelection({ point });
    renderInspector();
    return;
  }
  if (layer?.type === "tilelayer" && state.activeTool === "tile-select") {
    state.tileSelectionBase = currentTileSelectionCells();
    state.tileSelectionGestureMode = shiftKey || ctrlKey || metaKey ? "add" : state.tileSelectionMode;
    state.selectionStart = point;
    updateSelection({ point });
    return;
  }
  const imageView = state.viewer.imageLayerAtPoint(point);
  if (imageView) {
    if (state.selectedLayerIds.has(imageView.layer.id)) {
      setActiveLayer(imageView, { preserveSelection: true });
    } else {
      setActiveLayer(imageView);
    }
    const layerIds = [...state.selectedLayerIds].filter((layerId) => (
      state.editor.layerById(layerId)?.type === "imagelayer"
      && !layerTreeEntryLocked(layerId)
    ));
    if (state.session?.writable && layerIds.length) {
      state.imageLayerDrag = {
        start: point,
        layers: layerIds.map((layerId) => {
          const imageLayer = state.editor.layerById(layerId);
          return {
            layerId,
            original: { x: Number(imageLayer.x || 0), y: Number(imageLayer.y || 0) },
            current: { x: Number(imageLayer.x || 0), y: Number(imageLayer.y || 0) },
          };
        }),
      };
    }
    renderImageLayerSelection();
    return;
  }
  state.selectionStart = point;
  updateSelection({ point });
}

function updateSelection({ point }) {
  if (state.objectTransform) {
    updateObjectTransform(point);
    return;
  }
  if (state.imageLayerDrag) {
    const delta = {
      x: Math.round(point.x - state.imageLayerDrag.start.x),
      y: Math.round(point.y - state.imageLayerDrag.start.y),
    };
    for (const entry of state.imageLayerDrag.layers) {
      entry.current = snapImageLayerPosition({
        x: entry.original.x + delta.x,
        y: entry.original.y + delta.y,
      }, entry.layerId);
      state.viewer.previewImageLayerPosition(entry.layerId, entry.current);
    }
    renderImageLayerSelection();
    return;
  }
  if (state.objectDrag) {
    const local = state.viewer.pointForLayer(state.objectDrag.layerId, point);
    if (!local) return;
    for (const entry of state.objectDrag.objects) {
      entry.current = {
        x: Math.round(entry.original.x + local.x - state.objectDrag.start.x),
        y: Math.round(entry.original.y + local.y - state.objectDrag.start.y),
      };
      state.viewer.previewObjectPosition(state.objectDrag.layerId, entry.objectId, entry.current);
    }
    renderObjectSelection();
    renderSelectionState();
    return;
  }
  if (!state.selectionStart || !state.document) return;
  if (
    state.activeTool === "tile-select"
    && state.editor?.layerById(state.activeLayerId)?.type === "tilelayer"
  ) {
    const rectangle = snappedSelection(state.selectionStart, point);
    const incoming = rectangularTileSelection(
      { x: rectangle.startColumn, y: rectangle.startRow },
      { x: rectangle.endColumn, y: rectangle.endRow },
    );
    const combined = combineTileSelections(
      state.tileSelectionBase || [],
      incoming,
      state.tileSelectionGestureMode || state.tileSelectionMode,
    );
    setTileSelection(combined);
    return;
  }
  if (state.editor?.layerById(state.activeLayerId)?.type === "objectgroup") {
    state.selection = worldRectBetween(state.selectionStart, point, "object-marquee");
    state.viewer.setSelectionRect(state.selection);
    renderSelectionState();
    return;
  }
  state.selection = snappedSelection(state.selectionStart, point);
  state.viewer.setSelectionRect(state.selection);
  renderSelectionState();
}

function finishSelection({ point }) {
  if (state.objectTransform) {
    updateObjectTransform(point);
    finishObjectTransform();
    return;
  }
  if (state.imageLayerDrag) {
    updateSelection({ point });
    const drag = state.imageLayerDrag;
    state.imageLayerDrag = null;
    try {
      state.editor.runBatch(drag.layers.length > 1 ? `移动 ${drag.layers.length} 个图片层` : "移动图片层", () => {
        for (const entry of drag.layers) {
          if (entry.current.x !== entry.original.x || entry.current.y !== entry.original.y) {
            state.editor.updateLayer(entry.layerId, entry.current, { label: "移动图片层" });
          }
        }
      });
    } catch (error) {
      for (const entry of drag.layers) state.viewer.previewImageLayerPosition(entry.layerId);
      reportEditorError(error);
    }
    renderImageLayerSelection();
    renderInspector();
    return;
  }
  if (state.objectDrag) {
    updateSelection({ point });
    const drag = state.objectDrag;
    state.objectDrag = null;
    try {
      state.editor.runBatch(drag.objects.length > 1 ? `移动 ${drag.objects.length} 个对象` : "移动对象", () => {
        for (const entry of drag.objects) {
          if (entry.current.x !== entry.original.x || entry.current.y !== entry.original.y) {
            state.editor.updateObject(drag.layerId, entry.objectId, entry.current, { label: "移动对象" });
          }
        }
      });
    } catch (error) {
      for (const entry of drag.objects) state.viewer.previewObjectPosition(drag.layerId, entry.objectId);
      reportEditorError(error);
    }
    renderObjectSelection();
    return;
  }
  if (!state.selectionStart) return;
  updateSelection({ point });
  state.selectionStart = null;
  state.tileSelectionBase = null;
  state.tileSelectionGestureMode = null;
  if (state.selection?.kind === "object-marquee") {
    const objectIds = state.viewer.objectsInWorldRect(state.activeLayerId, state.selection).map((object) => object.id);
    setObjectSelection(objectIds, { additive: state.objectMarqueeAdditive });
    state.objectMarqueeAdditive = false;
  }
}

function cancelSelection() {
  if (state.objectTransform) cancelObjectTransform();
  if (state.imageLayerDrag) {
    for (const entry of state.imageLayerDrag.layers) state.viewer?.previewImageLayerPosition(entry.layerId);
    state.imageLayerDrag = null;
  }
  if (state.objectDrag) {
    for (const entry of state.objectDrag.objects) {
      state.viewer?.previewObjectPosition(state.objectDrag.layerId, entry.objectId);
    }
    state.objectDrag = null;
  }
  state.selectionStart = null;
  state.tileSelectionBase = null;
  state.tileSelectionGestureMode = null;
  state.objectMarqueeAdditive = false;
  state.selection = null;
  state.viewer?.setSelectionRect(null);
  renderSelectionState();
}

function selectTilesByMatch({ point, shiftKey = false, ctrlKey = false, metaKey = false }) {
  const layer = state.editor?.layerById(state.activeLayerId);
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (layer?.type !== "tilelayer" || !cell) return;
  try {
    const encodedGid = state.editor.tileAt(state.activeLayerId, cell.x, cell.y);
    if (encodedGid === null) return;
    const incoming = state.activeTool === "tile-magic"
      ? contiguousTileSelection(cell, (x, y) => state.editor.tileAt(state.activeLayerId, x, y))
      : matchingTileSelection(tileLayerSelectionEntries(layer), encodedGid);
    const mode = shiftKey || ctrlKey || metaKey ? "add" : state.tileSelectionMode;
    setTileSelection(combineTileSelections(currentTileSelectionCells(), incoming, mode));
  } catch (error) {
    reportEditorError(error);
  }
}

function* tileLayerSelectionEntries(layer) {
  if (Array.isArray(layer.data)) {
    const width = Number(layer.width || 0);
    const height = Number(layer.height || 0);
    const startX = Number(layer.startx || 0);
    const startY = Number(layer.starty || 0);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        yield { x: startX + column, y: startY + row, gid: Number(layer.data[row * width + column]) >>> 0 };
      }
    }
    return;
  }
  for (const chunk of layer.chunks || []) {
    if (!Array.isArray(chunk?.data)) continue;
    for (let row = 0; row < chunk.height; row += 1) {
      for (let column = 0; column < chunk.width; column += 1) {
        yield {
          x: chunk.x + column,
          y: chunk.y + row,
          gid: Number(chunk.data[row * chunk.width + column]) >>> 0,
        };
      }
    }
  }
}

function currentTileSelectionCells() {
  return state.selection?.kind === "tile-cells" && state.selection.layerId === state.activeLayerId
    ? state.selection.cells
    : [];
}

function setTileSelection(cells) {
  const bounds = tileSelectionBounds(cells);
  if (!bounds) {
    state.selection = null;
    state.viewer?.setSelectionRect(null);
    renderSelectionState();
    renderTileSelectionControls();
    return;
  }
  const world = state.viewer.tileRegionWorldBounds(
    state.activeLayerId,
    bounds.startColumn,
    bounds.startRow,
    bounds.endColumn,
    bounds.endRow,
  );
  if (!world) return;
  state.selection = {
    kind: "tile-cells",
    layerId: state.activeLayerId,
    cells,
    ...bounds,
    ...world,
  };
  state.viewer.setSelectionRect(state.selection);
  renderSelectionState();
  renderTileSelectionControls();
}

function clearTileSelection() {
  if (state.selection?.kind !== "tile-cells") return;
  setTileSelection([]);
}

function setTileSelectionMode(mode) {
  if (!["replace", "add", "subtract", "intersect"].includes(mode)) return;
  state.tileSelectionMode = mode;
  renderTileSelectionControls();
  scheduleMapEditorViewStateSave();
}

function renderTileSelectionControls() {
  const layer = state.editor?.layerById(state.activeLayerId);
  const available = layer?.type === "tilelayer" && (
    Array.isArray(layer.data)
    || (Array.isArray(layer.chunks) && layer.chunks.every((chunk) => Array.isArray(chunk.data)))
  );
  elements.tileRectSelectButton.disabled = !available;
  elements.tileRectSelectButton.classList.toggle("is-active", available && state.activeTool === "tile-select");
  elements.tileRectSelectButton.setAttribute("aria-pressed", String(available && state.activeTool === "tile-select"));
  for (const button of elements.tileSelectionToolbar.querySelectorAll("[data-tile-selection-mode]")) {
    const active = button.dataset.tileSelectionMode === state.tileSelectionMode;
    button.disabled = !available;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  elements.clearTileSelectionButton.disabled = !available || state.selection?.kind !== "tile-cells";
}

function beginObjectTransform(handle, point) {
  const objects = selectedObjects().map((object) => cloneJsonValue(object));
  if (!objects.length) return;
  const sourceBounds = unionWorldBounds(objects.map((object) => state.viewer.objectLocalBounds(object)));
  const local = state.viewer.pointForLayer(state.activeLayerId, point);
  if (!sourceBounds || !local) return;
  const center = {
    x: sourceBounds.x + sourceBounds.width / 2,
    y: sourceBounds.y + sourceBounds.height / 2,
  };
  state.objectTransform = {
    handle,
    objects,
    sourceBounds,
    center,
    startAngle: Math.atan2(local.y - center.y, local.x - center.x),
    current: objects.map((object) => ({ id: object.id, changes: {} })),
  };
  renderObjectSelection();
}

function updateObjectTransform(point) {
  const transform = state.objectTransform;
  if (!transform) return;
  const local = state.viewer.pointForLayer(state.activeLayerId, point);
  if (!local) return;
  if (transform.handle === "rotate") {
    const angle = Math.atan2(local.y - transform.center.y, local.x - transform.center.x);
    const delta = Math.round((angle - transform.startAngle) * 180 / Math.PI);
    transform.current = delta === 0
      ? transform.objects.map((object) => ({ id: object.id, changes: {} }))
      : planTiledObjectRotation(transform.objects, transform.center, delta);
  } else {
    const targetBounds = resizedObjectBounds(transform.sourceBounds, transform.handle, {
      x: Math.round(local.x),
      y: Math.round(local.y),
    });
    const unchanged = ["x", "y", "width", "height"].every((field) => targetBounds[field] === transform.sourceBounds[field]);
    transform.current = unchanged
      ? transform.objects.map((object) => ({ id: object.id, changes: {} }))
      : planTiledObjectResize(transform.objects, transform.sourceBounds, targetBounds);
  }
  for (const entry of transform.current) {
    state.viewer.previewObjectTransform(state.activeLayerId, entry.id, entry.changes);
  }
  renderObjectSelection();
}

function resizedObjectBounds(source, handle, point) {
  let left = source.x;
  let right = source.x + source.width;
  let top = source.y;
  let bottom = source.y + source.height;
  if (handle.includes("w")) left = Math.min(point.x, right - 1);
  if (handle.includes("e")) right = Math.max(point.x, left + 1);
  if (handle.includes("n")) top = Math.min(point.y, bottom - 1);
  if (handle.includes("s")) bottom = Math.max(point.y, top + 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function finishObjectTransform() {
  const transform = state.objectTransform;
  if (!transform) return;
  state.objectTransform = null;
  const label = transform.handle === "rotate"
    ? `旋转 ${transform.objects.length > 1 ? `${transform.objects.length} 个` : ""}对象`
    : `缩放 ${transform.objects.length > 1 ? `${transform.objects.length} 个` : ""}对象`;
  try {
    state.editor.runBatch(label, () => {
      for (const entry of transform.current) {
        if (Object.keys(entry.changes).length) {
          state.editor.updateObject(state.activeLayerId, entry.id, entry.changes, { label });
        }
      }
    });
  } catch (error) {
    for (const object of transform.objects) state.viewer.previewObjectTransform(state.activeLayerId, object.id);
    reportEditorError(error);
  }
  renderObjectSelection();
  renderInspector();
}

function cancelObjectTransform() {
  const transform = state.objectTransform;
  if (!transform) return;
  state.objectTransform = null;
  for (const object of transform.objects) state.viewer?.previewObjectTransform(state.activeLayerId, object.id);
  renderObjectSelection();
  renderInspector();
}

function beginTerrainStroke({ point }) {
  cancelPendingAutoMapGesture("开始新 Terrain 笔画，旧 AutoMap 已取消；基础编辑已保留");
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  const terrain = currentTerrainEntry();
  if (!cell || !terrain) return;
  try {
    state.terrainStrokePlan = Object.freeze({
      terrain,
      color: state.selectedTerrainColor,
      seed: normalizeTileRandomSeed(state.terrainBrushSeed),
    });
    state.terrainStroke = state.editor.beginTileStroke(state.activeLayerId, {
      kind: "terrain-brush",
      label: state.selectedTerrainColor === 0 ? `清除 Terrain ${terrain.name}` : `绘制 Terrain ${terrain.name}`,
      seed: state.terrainStrokePlan.seed,
    });
    state.terrainStrokeAutoMapGesture = beginAutoMapGesture(
      state.selectedTerrainColor === 0 ? `清除 Terrain ${terrain.name}` : `绘制 Terrain ${terrain.name}`,
    );
    state.lastTerrainCell = null;
    state.terrainStrokeApproximate = 0;
    paintTerrainCell(cell);
  } catch (error) {
    state.terrainStroke = null;
    state.terrainStrokePlan = null;
    state.terrainStrokeAutoMapGesture = null;
    reportEditorError(error);
  }
}

function continueTerrainStroke({ point }) {
  if (!state.terrainStroke) return;
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (cell) paintTerrainCell(cell);
}

function paintTerrainCell(cell) {
  if (!state.terrainStroke || !state.terrainStrokePlan) return;
  if (state.lastTerrainCell?.x === cell.x && state.lastTerrainCell?.y === cell.y) return;
  try {
    const anchors = state.lastTerrainCell ? gridLineCells(state.lastTerrainCell, cell) : [cell];
    const plan = state.terrainStrokePlan;
    for (const anchor of anchors) {
      const result = planTerrainBrush({
        point: anchor,
        color: plan.color,
        type: plan.terrain.type,
        candidates: plan.terrain.candidates,
        seed: plan.seed,
        readGid: (x, y) => state.editor.tileAt(state.activeLayerId, x, y),
        wangIdForGid: (gid) => terrainWangIdForGid(plan.terrain, gid),
        isCellEditable: (x, y) => terrainCellEditable(state.activeLayerId, x, y),
      });
      for (const write of result.writes) {
        state.terrainStroke.set(write.x, write.y, write.gid);
        recordAutoMapGestureCell(state.terrainStrokeAutoMapGesture, write.x, write.y);
      }
      state.terrainStrokeApproximate += result.approximate;
    }
    state.lastTerrainCell = cell;
    scheduleLayerRefresh(state.activeLayerId);
  } catch (error) {
    reportEditorError(error);
    cancelTerrainStroke();
  }
}

function finishTerrainStroke({ point } = {}) {
  if (!state.terrainStroke) return;
  if (point) continueTerrainStroke({ point });
  if (!state.terrainStroke) return;
  const transaction = state.terrainStroke;
  const autoMapGesture = state.terrainStrokeAutoMapGesture;
  const approximate = state.terrainStrokeApproximate;
  state.terrainStroke = null;
  state.terrainStrokePlan = null;
  state.terrainStrokeAutoMapGesture = null;
  state.lastTerrainCell = null;
  state.terrainStrokeApproximate = 0;
  try {
    const changed = transaction.commit();
    if (changed) void applyAutoMapForGesture(autoMapGesture);
    state.terrainBrushMessage = approximate
      ? `已完成，${approximate} 个受影响格使用最近 wangtile 近似匹配`
      : changed ? "已完成精确 Terrain 匹配" : "这一笔没有产生变化";
  } catch (error) {
    reportEditorError(error);
  }
  renderTerrainBrushControls();
  scheduleLayerRefresh(state.activeLayerId);
}

function cancelTerrainStroke() {
  if (!state.terrainStroke) return;
  const transaction = state.terrainStroke;
  state.terrainStroke = null;
  state.terrainStrokePlan = null;
  state.terrainStrokeAutoMapGesture = null;
  state.lastTerrainCell = null;
  state.terrainStrokeApproximate = 0;
  transaction.cancel();
  scheduleLayerRefresh(state.activeLayerId);
}

function terrainWangIdForGid(terrain, encodedGid) {
  const baseGid = decodeGlobalTileId(encodedGid || 0).gid;
  const localId = baseGid - terrain.firstgid;
  return terrain.wangIdByLocalId.get(localId) || null;
}

function terrainCellEditable(layerId, x, y) {
  const layer = state.editor?.layerById(layerId);
  if (!layer || layer.type !== "tilelayer") return false;
  if (Array.isArray(layer.chunks)) return true;
  const originX = Number.isSafeInteger(layer.x) ? layer.x : 0;
  const originY = Number.isSafeInteger(layer.y) ? layer.y : 0;
  const width = Number.isSafeInteger(layer.width) ? layer.width : Number(state.document?.width || 0);
  const height = Number.isSafeInteger(layer.height) ? layer.height : Number(state.document?.height || 0);
  return x >= originX && y >= originY && x < originX + width && y < originY + height;
}

function beginTileStroke({ point }) {
  cancelPendingAutoMapGesture("开始新笔画，旧 AutoMap 已取消；基础编辑已保留");
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (!cell) return;
  try {
    const erase = state.activeTool === "eraser";
    state.tileStrokePlan = currentTileStampPlan({ erase });
    state.tileStroke = state.editor.beginTileStroke(state.activeLayerId, {
      kind: state.tileStrokePlan.random ? "random-brush" : state.activeTool,
      label: erase ? "擦除瓦片" : state.tileStrokePlan.random ? "随机绘制瓦片" : "绘制瓦片",
      seed: state.tileStrokePlan.random ? state.tileStrokePlan.seed : null,
    });
    state.tileStrokeAutoMapGesture = beginAutoMapGesture(
      erase ? "擦除瓦片" : state.tileStrokePlan.random ? "随机绘制瓦片" : "绘制瓦片",
    );
    state.lastStrokeCell = null;
    paintStrokeCell(cell);
  } catch (error) {
    state.tileStroke = null;
    state.tileStrokePlan = null;
    state.tileStrokeAutoMapGesture = null;
    reportEditorError(error);
  }
}

function continueTileStroke({ point }) {
  if (!state.tileStroke) return;
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (cell) paintStrokeCell(cell);
}

function paintStrokeCell(cell) {
  if (!state.tileStroke || !state.tileStrokePlan) return;
  try {
    const anchors = state.lastStrokeCell ? gridLineCells(state.lastStrokeCell, cell) : [cell];
    const plan = state.tileStrokePlan;
    for (const write of tileStampWrites(plan.stamp, anchors, {
      erase: plan.erase,
      random: plan.random,
      seed: plan.seed,
      weights: plan.weights,
    })) {
      state.tileStroke.set(write.x, write.y, write.gid);
      recordAutoMapGestureCell(state.tileStrokeAutoMapGesture, write.x, write.y);
    }
    state.lastStrokeCell = cell;
    scheduleLayerRefresh(state.activeLayerId);
  } catch (error) {
    reportEditorError(error);
    cancelTileStroke();
  }
}

function finishTileStroke({ point } = {}) {
  if (!state.tileStroke) return;
  if (point) continueTileStroke({ point });
  if (!state.tileStroke) return;
  const transaction = state.tileStroke;
  const autoMapGesture = state.tileStrokeAutoMapGesture;
  state.tileStroke = null;
  state.tileStrokePlan = null;
  state.tileStrokeAutoMapGesture = null;
  state.lastStrokeCell = null;
  try {
    const changed = transaction.commit();
    if (changed) void applyAutoMapForGesture(autoMapGesture);
  } catch (error) {
    reportEditorError(error);
  }
  scheduleLayerRefresh(state.activeLayerId);
}

function cancelTileStroke() {
  if (!state.tileStroke) return;
  const transaction = state.tileStroke;
  state.tileStroke = null;
  state.tileStrokePlan = null;
  state.tileStrokeAutoMapGesture = null;
  state.lastStrokeCell = null;
  transaction.cancel();
  scheduleLayerRefresh(state.activeLayerId);
}

function sampleTile({ point }) {
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (!cell) return;
  try {
    const encodedGid = state.editor.tileAt(state.activeLayerId, cell.x, cell.y);
    if (encodedGid === null) return;
    const baseGid = decodeGlobalTileId(encodedGid).gid;
    state.tileStamp = singleTileStamp(encodedGid);
    state.selectedGid = encodedGid;
    state.tileStampAnchor = state.tilePaletteEntries.find((entry) => entry.gid === baseGid) || null;
    setTileStampSelecting(false);
    renderTileStampSelection();
    refreshObjectCreationControls();
    updateToolAvailability();
    setActiveTool(baseGid === 0 ? "eraser" : "brush");
  } catch (error) {
    reportEditorError(error);
  }
}

function beginTileShape({ point }) {
  cancelPendingAutoMapGesture("开始新形状，旧 AutoMap 已取消；基础编辑已保留");
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (!cell) return;
  try {
    state.tileShapeEdit = { start: cell, current: cell, plan: currentTileStampPlan() };
    updateTileShapePreview(cell);
  } catch (error) {
    state.tileShapeEdit = null;
    reportEditorError(error);
  }
}

function continueTileShape({ point }) {
  if (!state.tileShapeEdit) return;
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (cell) updateTileShapePreview(cell);
}

function updateTileShapePreview(cell) {
  const edit = state.tileShapeEdit;
  if (!edit) return;
  edit.current = cell;
  const anchors = tileShapeCells(state.activeTool, edit.start, cell, {
    filled: elements.tileShapeFilled.checked,
  });
  const left = Math.min(edit.start.x, cell.x);
  const right = Math.max(edit.start.x, cell.x);
  const top = Math.min(edit.start.y, cell.y);
  const bottom = Math.max(edit.start.y, cell.y);
  const bounds = state.viewer.tileRegionWorldBounds(state.activeLayerId, left, top, right, bottom);
  state.viewer.setSelectionRect(bounds);
  elements.selectionState.textContent = `${tileShapeLabel(state.activeTool)} · ${right - left + 1} × ${bottom - top + 1} · ${anchors.length} 点`;
}

function finishTileShape({ point } = {}) {
  if (!state.tileShapeEdit) return;
  if (point) continueTileShape({ point });
  const edit = state.tileShapeEdit;
  state.tileShapeEdit = null;
  restoreTileShapeOverlay();
  let transaction = null;
  try {
    const anchors = tileShapeCells(state.activeTool, edit.start, edit.current, {
      filled: elements.tileShapeFilled.checked,
    });
    const plan = edit.plan;
    const label = `${plan.random ? "随机" : ""}绘制瓦片${tileShapeLabel(state.activeTool)}`;
    const autoMapGesture = beginAutoMapGesture(label);
    transaction = state.editor.beginTileStroke(state.activeLayerId, {
      kind: plan.random ? `random-${state.activeTool}` : state.activeTool,
      label,
      seed: plan.random ? plan.seed : null,
    });
    for (const write of tileStampWrites(plan.stamp, anchors, {
      random: plan.random,
      seed: plan.seed,
      weights: plan.weights,
    })) {
      transaction.set(write.x, write.y, write.gid);
      recordAutoMapGestureCell(autoMapGesture, write.x, write.y);
    }
    const changed = transaction.commit();
    if (changed) void applyAutoMapForGesture(autoMapGesture);
  } catch (error) {
    transaction?.cancel();
    reportEditorError(error);
  }
  scheduleLayerRefresh(state.activeLayerId);
}

function cancelTileShape() {
  if (!state.tileShapeEdit) return;
  state.tileShapeEdit = null;
  restoreTileShapeOverlay();
}

function currentTileStampPlan(options = {}) {
  const stamp = state.tileStamp || singleTileStamp(state.selectedGid || 0);
  const erase = options.erase === true;
  const random = state.tileRandomEnabled && !erase;
  const seed = random ? normalizeTileRandomSeed(state.tileRandomSeed) : null;
  const weights = new Map();
  if (random) {
    for (const { gid } of stamp.cells) {
      const baseGid = decodeGlobalTileId(gid).gid;
      if (baseGid && !weights.has(baseGid)) weights.set(baseGid, state.viewer.tileProbability(gid));
    }
  }
  return Object.freeze({ stamp, erase, random, seed, weights });
}

function restoreTileShapeOverlay() {
  state.viewer?.setSelectionRect(state.selection);
  renderSelectionState();
}

function setTileShapeMenuOpen(value) {
  const open = value === true && !elements.tileShapeToolButton.disabled;
  elements.tileShapeMenu.hidden = !open;
  elements.tileShapeToolButton.setAttribute("aria-expanded", String(open));
}

function renderTileShapeMenu() {
  const labels = {
    "tile-line": { label: "瓦片直线", icon: "slash" },
    "tile-rectangle": { label: "瓦片矩形", icon: "rectangle-horizontal" },
    "tile-ellipse": { label: "瓦片椭圆", icon: "circle" },
  };
  const selected = labels[state.tileShapeTool] || labels["tile-line"];
  elements.tileShapeToolButton.title = selected.label;
  elements.tileShapeToolButton.innerHTML = `<i data-lucide="${selected.icon}"></i>`;
  for (const button of elements.tileShapeMenu.querySelectorAll("[data-tile-shape]")) {
    const active = button.dataset.tileShape === state.tileShapeTool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  }
  elements.tileShapeFilled.disabled = state.tileShapeTool === "tile-line";
  refreshIcons();
}

function tileShapeLabel(tool) {
  return ({
    "tile-line": "直线",
    "tile-rectangle": "矩形",
    "tile-ellipse": "椭圆",
  })[tool] || "形状";
}

async function fillTileRegion({ point }) {
  const cell = state.viewer.tileCoordinatesForLayer(state.activeLayerId, point);
  if (!cell || !state.fillWorkerClient || state.fillPending) return;
  cancelPendingAutoMapGesture("开始填充，旧 AutoMap 已取消；基础编辑已保留");
  const editor = state.editor;
  const layerId = state.activeLayerId;
  const replacement = state.selectedGid;
  const expectedStateId = editor.headStateId;
  const layer = editor.layerById(layerId);
  const controller = new AbortController();
  const pending = Object.freeze({ controller, editor, layerId, replacement, expectedStateId });
  state.fillAbortController = controller;
  state.fillPending = pending;
  state.fillMessage = "正在计算填充 · Esc 取消";
  let outcome = "";
  clearAutoSaveTimer();
  renderDocumentState();
  try {
    const result = await state.fillWorkerClient.fill(layer, cell.x, cell.y, replacement, {
      maxCells: 1_000_000,
      signal: controller.signal,
    });
    if (state.fillPending !== pending) return;
    if (state.editor !== editor || editor.headStateId !== expectedStateId || editor.layerById(layerId) !== layer) {
      throw fillUiError("fill-result-stale", "地图状态已经变化，已丢弃旧的填充结果");
    }
    if (!result.count) {
      outcome = "所选瓦片与起点相同，没有产生变化";
      return;
    }
    const autoMapGesture = beginAutoMapGesture("填充瓦片");
    const autoMapPreview = await previewAutoMapForFill(autoMapGesture, result, pending);
    if (state.fillPending !== pending) return;
    if (state.editor !== editor || editor.headStateId !== expectedStateId || editor.layerById(layerId) !== layer) {
      throw fillUiError("fill-result-stale", "地图状态已经变化，已丢弃旧的填充结果");
    }
    if (autoMapPreview?.changes.length) {
      const applied = editor.runBatch("填充瓦片 + AutoMap", () => {
        editor.applyTileFillResult(layerId, result, { expectedStateId, label: "填充瓦片" });
        applyTiledAutomappingPreview(editor, autoMapPreview, {
          label: "填充瓦片 · AutoMap",
          existingBatch: true,
        });
      });
      if (applied.changed) {
        const entry = editor.undoStack.at(-1);
        entry.kind = "automap-while-drawing";
        entry.seed = autoMapGesture.seed;
        entry.region = autoMapRegionForFillResult(result);
      }
      state.autoMapWhileDrawingMessage = `While Drawing：匹配 ${autoMapPreview.stats.matches} 处，修改 ${autoMapPreview.stats.changes} 格`;
      if (elements.autoMapDialog.open) setAutoMapMessage(state.autoMapWhileDrawingMessage);
    } else {
      editor.applyTileFillResult(layerId, result, { expectedStateId, label: "填充瓦片" });
    }
    outcome = `已填充 ${formatCellCount(result.count)} 格`;
  } catch (error) {
    if (error.name === "AbortError") outcome = "填充已取消";
    else {
      state.fillMessage = "";
      reportEditorError(error);
    }
  } finally {
    const changed = editor.headStateId !== expectedStateId;
    if (state.fillPending === pending) {
      state.fillPending = null;
      state.fillAbortController = null;
    }
    state.fillMessage = "";
    scheduleLayerRefresh(layerId);
    renderDocumentState();
    if (editor.dirty) updateAutoSaveTimer({ action: changed ? "commit" : "undo" });
    if (outcome) announceFillMessage(outcome);
  }
}

async function previewAutoMapForFill(gesture, result, pending) {
  if (!gesture || !result.bounds || !result.count) return null;
  const region = autoMapRegionForFillResult(result);
  const preview = await state.autoMapGestureWorkerClient.preview(state.editor.document, gesture.rules.compiled, {
    targetPath: state.session.relativePath,
    seed: gesture.seed,
    region,
    whileDrawing: true,
    signal: pending.controller.signal,
    preFill: {
      layerId: pending.layerId,
      result: {
        addresses: result.addresses,
        blocks: result.blocks,
        target: result.target,
        replacement: result.replacement,
        count: result.count,
        bounds: result.bounds,
      },
    },
  });
  if (preview.additions.length || gesture.rules.tilesetAdditions.length) {
    throw new Error("AutoMap While Drawing 不能在填充期间创建图层或加入瓦片集；请先手动运行一次 AutoMap");
  }
  return preview;
}

function autoMapRegionForFillResult(result) {
  return {
    x: result.bounds.minX,
    y: result.bounds.minY,
    width: result.bounds.maxX - result.bounds.minX + 1,
    height: result.bounds.maxY - result.bounds.minY + 1,
  };
}

function cancelPendingFill(message = "填充已取消") {
  if (!state.fillPending) return false;
  state.fillMessage = message;
  state.fillAbortController?.abort();
  return true;
}

function fillUiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatCellCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function announceFillMessage(message) {
  window.clearTimeout(state.fillStatusTimer);
  elements.fillToolButton.title = message;
  elements.mapState.dataset.status = "ready";
  elements.mapState.innerHTML = '<i data-lucide="paint-bucket"></i><span></span>';
  elements.mapState.querySelector("span").textContent = message;
  refreshIcons();
  state.fillStatusTimer = window.setTimeout(() => {
    state.fillStatusTimer = null;
    setMapReadyStatus();
  }, 2_500);
}

function beginObject({ point }) {
  state.objectStart = point;
  updateObjectDraft({ point });
}

function updateObjectDraft({ point }) {
  if (!state.objectStart) return;
  state.selection = snappedSelection(state.objectStart, point);
  state.viewer.setSelectionRect(state.selection);
  renderSelectionState();
}

function finishObject({ point }) {
  if (!state.objectStart) return;
  updateObjectDraft({ point });
  const selection = state.selection;
  state.objectStart = null;
  const local = selection.objectRect || state.viewer.pointForLayer(state.activeLayerId, { x: selection.x, y: selection.y });
  if (!local) return;
  const collision = state.activeTool === "collision";
  try {
    const preset = collision ? "collision" : state.objectPreset;
    const object = state.editor.addObject(
      state.activeLayerId,
      objectForPreset(preset, local, selection.objectRect || selection),
      { label: objectPresetLabel(preset) },
    );
    scheduleLayerRefresh(state.activeLayerId);
    setActiveTool("select");
    selectObject(object.id);
  } catch (error) {
    reportEditorError(error);
  }
}

function objectForPreset(preset, local, selection) {
  const shape = preset === "spawn" ? "point" : state.objectShape;
  const rect = {
    x: local.x,
    y: local.y,
    width: selection.width,
    height: selection.height,
  };
  return createTiledMapObject({
    shape,
    semantic: preset,
    rect,
    ...(shape === "tile" ? {
      gid: state.selectedGid,
      tileAlignment: state.viewer?.tileObjectAlignment({ gid: state.selectedGid }) || "bottomleft",
    } : {}),
  });
}

function objectPresetLabel(preset) {
  if (preset === "collision") return "添加碰撞区域";
  if (preset === "spawn") return "添加出生点";
  if (preset === "portal") return "添加传送点";
  return "添加对象";
}

function refreshObjectCreationControls() {
  if (!elements.objectShape || !elements.objectPreset) return;
  const semantic = state.activeTool === "collision" ? "collision" : state.objectPreset;
  let allowedShapes = TILED_OBJECT_SHAPES;
  if (semantic === "spawn") allowedShapes = ["point"];
  else if (semantic === "portal") allowedShapes = ["rectangle", "ellipse", "capsule", "polygon"];
  else if (semantic === "collision") allowedShapes = TILED_COLLISION_SHAPES;

  for (const option of elements.objectShape.options) {
    option.disabled = !allowedShapes.includes(option.value)
      || (option.value === "tile" && !Number.isSafeInteger(state.selectedGid));
  }
  if (elements.objectShape.selectedOptions[0]?.disabled) {
    const fallback = [...elements.objectShape.options].find((option) => !option.disabled)?.value || "rectangle";
    elements.objectShape.value = fallback;
    state.objectShape = fallback;
  } else {
    elements.objectShape.value = state.objectShape;
  }
  elements.objectShape.disabled = elements.objectPreset.disabled || allowedShapes.length === 1;
}

function cancelObject() {
  if (!state.objectStart) return;
  state.objectStart = null;
  state.selection = null;
  state.viewer?.setSelectionRect(null);
  renderSelectionState();
}

function beginVertexDrag({ point }) {
  const object = selectedObject();
  const field = Array.isArray(object?.polygon) ? "polygon" : Array.isArray(object?.polyline) ? "polyline" : null;
  if (!field || state.selectedObjectIds.size !== 1) return;
  const points = cloneJsonValue(object[field]);
  const index = state.viewer.objectVertexAtPoint(state.activeLayerId, object, point, points);
  if (!Number.isSafeInteger(index)) return;
  state.selectedVertexIndex = index;
  state.vertexDrag = { field, index, original: points, current: cloneJsonValue(points) };
  state.viewer.setObjectVertexOverlay(state.activeLayerId, object, { points, activeIndex: index });
  renderObjectVertexFields(object, true);
}

function updateVertexDrag({ point }) {
  const drag = state.vertexDrag;
  const object = selectedObject();
  if (!drag || !object) return;
  const local = state.viewer.objectPointFromWorld(state.activeLayerId, object, point);
  if (!local) return;
  drag.current[drag.index] = { x: Math.round(local.x), y: Math.round(local.y) };
  state.viewer.setObjectVertexOverlay(state.activeLayerId, object, {
    points: drag.current,
    activeIndex: drag.index,
  });
  const bounds = state.viewer.objectWorldBounds(state.activeLayerId, object, { [drag.field]: drag.current });
  state.selection = bounds ? { ...bounds, kind: "objects", objectIds: [object.id] } : state.selection;
  state.viewer.setSelectionRect(state.selection);
  const row = elements.objectVertexList.querySelector(`[data-object-vertex-index="${drag.index}"]`);
  const x = row?.querySelector('[data-object-vertex-axis="x"]');
  const y = row?.querySelector('[data-object-vertex-axis="y"]');
  if (x) x.value = String(drag.current[drag.index].x);
  if (y) y.value = String(drag.current[drag.index].y);
}

function finishVertexDrag({ point } = {}) {
  const drag = state.vertexDrag;
  if (!drag) return;
  if (point) updateVertexDrag({ point });
  state.vertexDrag = null;
  const object = selectedObject();
  if (!object) return;
  try {
    if (JSON.stringify(drag.current) !== JSON.stringify(drag.original)) {
      state.editor.updateObject(state.activeLayerId, object.id, { [drag.field]: drag.current }, {
        label: "移动对象顶点",
      });
    }
  } catch (error) {
    reportEditorError(error);
  }
  renderObjectSelection();
  renderInspector();
}

function cancelVertexDrag() {
  if (!state.vertexDrag) return;
  state.vertexDrag = null;
  const object = selectedObject();
  state.viewer?.setObjectVertexOverlay(state.activeLayerId, object, {
    activeIndex: state.selectedVertexIndex,
  });
  renderObjectSelection();
  if (object) renderObjectVertexFields(object, state.session?.writable === true);
}

function scheduleLayerRefresh(layerId) {
  if (!state.viewer || layerId == null) return;
  state.pendingLayerRefreshes.add(layerId);
  if (state.layerRefreshRunning || state.layerRefreshFrame != null) return;
  state.layerRefreshFrame = requestAnimationFrame(() => {
    state.layerRefreshFrame = null;
    void flushLayerRefreshes();
  });
}

function scheduleLayerTreeRebuild(preferredLayerId = null, options = {}) {
  if (!state.viewer) return;
  if (Number.isSafeInteger(preferredLayerId) && state.editor?.layerById(preferredLayerId)) {
    state.preferredActiveLayerId = preferredLayerId;
  }
  state.layerTreeRebuildPending = true;
  if (options.reloadTilesets === true) state.layerTreeReloadTilesets = true;
  updateLayerActionAvailability();
  if (state.layerTreeRebuildRunning || state.layerTreeRebuildFrame != null) return;
  state.layerTreeRebuildFrame = requestAnimationFrame(() => {
    state.layerTreeRebuildFrame = null;
    void flushLayerTreeRebuild();
  });
}

async function flushLayerTreeRebuild() {
  if (state.layerTreeRebuildRunning || !state.viewer) return;
  state.layerTreeRebuildRunning = true;
  try {
    while (state.layerTreeRebuildPending) {
      state.layerTreeRebuildPending = false;
      const reloadTilesets = state.layerTreeReloadTilesets;
      state.layerTreeReloadTilesets = false;
      state.pendingLayerRefreshes.clear();
      clearObjectSelection();
      await state.viewer.rebuildLayers({ reloadTilesets });
      state.document = state.editor.document;
      renderLayerList();
      if (reloadTilesets) renderTilePalette();
      const preferredId = state.preferredActiveLayerId ?? state.activeLayerId;
      const nextView = state.viewer.layerViews.find(({ layer }) => layer.id === preferredId)
        || defaultActiveLayer();
      state.preferredActiveLayerId = null;
      state.activeLayerId = null;
      if (nextView) setActiveLayer(nextView, { preserveSelection: true });
      else {
        setActiveTool("select");
        renderSelectionState();
      }
    }
  } catch (error) {
    reportEditorError(error);
  } finally {
    state.layerTreeRebuildRunning = false;
    updateLayerActionAvailability();
    renderDocumentState();
    if (state.layerTreeRebuildPending) scheduleLayerTreeRebuild();
  }
}

async function flushLayerRefreshes() {
  if (state.layerRefreshRunning || !state.viewer) return;
  state.layerRefreshRunning = true;
  try {
    while (state.pendingLayerRefreshes.size) {
      const layerIds = [...state.pendingLayerRefreshes];
      state.pendingLayerRefreshes.clear();
      for (const layerId of layerIds) await state.viewer.refreshLayer(layerId);
    }
  } catch (error) {
    reportEditorError(error);
  } finally {
    state.layerRefreshRunning = false;
    if (state.pendingLayerRefreshes.size) scheduleLayerRefresh(state.pendingLayerRefreshes.values().next().value);
  }
}

function gridLineCells(start, end) {
  const cells = [];
  let x = start.x;
  let y = start.y;
  const deltaX = Math.abs(end.x - x);
  const stepX = x < end.x ? 1 : -1;
  const deltaY = -Math.abs(end.y - y);
  const stepY = y < end.y ? 1 : -1;
  let error = deltaX + deltaY;
  while (true) {
    cells.push({ x, y });
    if (x === end.x && y === end.y) break;
    const doubled = error * 2;
    if (doubled >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubled <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
  return cells;
}

function snappedSelection(start, end) {
  const layer = state.editor?.layerById(state.activeLayerId);
  if (layer?.type === "tilelayer") {
    const first = state.viewer.tileCoordinatesForLayer(state.activeLayerId, start);
    const last = state.viewer.tileCoordinatesForLayer(state.activeLayerId, end);
    if (first && last) {
      const startColumn = Math.min(first.x, last.x);
      const endColumn = Math.max(first.x, last.x);
      const startRow = Math.min(first.y, last.y);
      const endRow = Math.max(first.y, last.y);
      const bounds = state.viewer.tileRegionWorldBounds(
        state.activeLayerId,
        startColumn,
        startRow,
        endColumn,
        endRow,
      );
      if (bounds) return { ...bounds, startColumn, endColumn, startRow, endRow };
    }
  }
  const tileWidth = state.document.orientation === "isometric"
    ? state.document.tileheight
    : state.document.tilewidth;
  const tileHeight = state.document.tileheight;
  const first = layer?.type === "objectgroup" ? state.viewer.pointForLayer(state.activeLayerId, start) : start;
  const last = layer?.type === "objectgroup" ? state.viewer.pointForLayer(state.activeLayerId, end) : end;
  const startColumn = Math.floor(Math.min(first.x, last.x) / tileWidth);
  const endColumn = Math.floor(Math.max(first.x, last.x) / tileWidth);
  const startRow = Math.floor(Math.min(first.y, last.y) / tileHeight);
  const endRow = Math.floor(Math.max(first.y, last.y) / tileHeight);
  const objectRect = {
    x: startColumn * tileWidth,
    y: startRow * tileHeight,
    width: (endColumn - startColumn + 1) * tileWidth,
    height: (endRow - startRow + 1) * tileHeight,
  };
  const projected = layer?.type === "objectgroup"
    ? state.viewer.objectCoordinateRectWorldBounds(state.activeLayerId, objectRect)
    : objectRect;
  return {
    ...projected,
    ...(layer?.type === "objectgroup" ? { objectRect } : {}),
    startColumn,
    endColumn,
    startRow,
    endRow,
  };
}

function worldRectBetween(start, end, kind = null) {
  return {
    ...(kind ? { kind } : {}),
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function renderSelectionState() {
  updateMapImageControls();
  const objects = selectedObjects();
  if (objects.length > 1) {
    elements.selectionState.textContent = `${objects.length} 个对象 · ${Math.round(state.selection?.width || 0)} × ${Math.round(state.selection?.height || 0)}`;
    return;
  }
  const object = selectedObject();
  if (object) {
    const transformChanges = state.objectTransform?.current?.find((entry) => entry.id === object.id)?.changes;
    const position = transformChanges
      ? { ...object, ...transformChanges }
      : state.objectDrag?.objects?.find((entry) => entry.objectId === object.id)?.current || object;
    elements.selectionState.textContent = `${object.name || object.class || `对象 ${object.id}`} · X ${Math.round(Number(position.x || 0))} Y ${Math.round(Number(position.y || 0))}`;
    return;
  }
  if (!state.selection) {
    const layer = state.editor?.layerById(state.activeLayerId);
    elements.selectionState.textContent = layer?.name || "未选择";
    return;
  }
  if (state.selection.kind === "tile-cells") {
    elements.selectionState.textContent = `${state.selection.cells.length} 格 · ${state.selection.width} × ${state.selection.height}`;
    return;
  }
  if (state.selection.kind === "image-layers") {
    const layers = state.selection.layerIds || [];
    if (layers.length > 1) {
      elements.selectionState.textContent = `${layers.length} 个图片层 · ${Math.round(state.selection.width)} × ${Math.round(state.selection.height)}`;
    } else {
      const layer = state.editor?.layerById(layers[0]);
      const drag = state.imageLayerDrag?.layers.find((entry) => entry.layerId === layer?.id);
      const position = drag?.current || layer || {};
      elements.selectionState.textContent = `${layer?.name || "图片层"} · X ${Math.round(Number(position.x || 0))} Y ${Math.round(Number(position.y || 0))}`;
    }
    return;
  }
  const columns = state.selection.endColumn - state.selection.startColumn + 1;
  const rows = state.selection.endRow - state.selection.startRow + 1;
  elements.selectionState.textContent = `${columns} × ${rows}`;
}

function selectedObject() {
  if (state.selectedObjectId == null) return null;
  const layer = state.editor?.layerById(state.activeLayerId);
  if (layer?.type !== "objectgroup") return null;
  return layer.objects.find((object) => object?.id === state.selectedObjectId) || null;
}

function selectedObjects() {
  const layer = state.editor?.layerById(state.activeLayerId);
  if (layer?.type !== "objectgroup") return [];
  return layer.objects.filter((object) => state.selectedObjectIds.has(object?.id));
}

function selectObject(objectId, options = {}) {
  const layer = state.editor?.layerById(state.activeLayerId);
  const object = layer?.objects?.find((entry) => entry?.id === objectId);
  if (!object) return false;
  if (options.toggle === true && state.selectedObjectIds.has(object.id)) {
    state.selectedObjectIds.delete(object.id);
    if (state.selectedObjectId === object.id) {
      state.selectedObjectId = [...state.selectedObjectIds].at(-1) ?? null;
    }
  } else {
    if (options.additive !== true && options.toggle !== true) state.selectedObjectIds.clear();
    state.selectedObjectIds.add(object.id);
    state.selectedObjectId = object.id;
  }
  if (!state.selectedObjectIds.size) state.selectedObjectId = null;
  state.selectedVertexIndex = null;
  setDetailTab("properties", { force: true });
  renderObjectSelection();
  renderInspector();
  updateToolAvailability();
  return true;
}

function setPrimarySelectedObject(objectId) {
  if (!state.selectedObjectIds.has(objectId)) return false;
  state.selectedObjectId = objectId;
  state.selectedVertexIndex = null;
  setDetailTab("properties", { force: true });
  renderObjectSelection();
  renderInspector();
  updateToolAvailability();
  return true;
}

function setObjectSelection(objectIds, options = {}) {
  const layer = state.editor?.layerById(state.activeLayerId);
  if (layer?.type !== "objectgroup") return false;
  const available = new Set(layer.objects.map((object) => object?.id).filter(Number.isSafeInteger));
  if (options.additive !== true) state.selectedObjectIds.clear();
  for (const objectId of objectIds || []) {
    if (available.has(objectId)) state.selectedObjectIds.add(objectId);
  }
  state.selectedObjectId = [...state.selectedObjectIds].at(-1) ?? null;
  state.selectedVertexIndex = null;
  if (state.selectedObjectId != null) setDetailTab("properties", { force: true });
  renderObjectSelection();
  renderInspector();
  updateToolAvailability();
  return state.selectedObjectIds.size > 0;
}

function clearObjectSelection() {
  state.selectedObjectId = null;
  state.selectedObjectIds.clear();
  state.selectedVertexIndex = null;
  state.vertexDrag = null;
  state.objectDrag = null;
  state.objectTransform = null;
  state.selection = null;
  state.viewer?.setSelectionRect(null);
  state.viewer?.setObjectVertexOverlay(null, null);
  state.viewer?.setObjectTransformOverlay(null, null);
}

function renderImageLayerSelection() {
  if (!state.viewer || !state.editor) return;
  const selectedIds = [...state.selectedLayerIds].filter((layerId) => (
    state.editor.layerById(layerId)?.type === "imagelayer"
  ));
  const layerIds = selectedIds.length
    ? selectedIds
    : state.editor.layerById(state.activeLayerId)?.type === "imagelayer" ? [state.activeLayerId] : [];
  const bounds = layerIds
    .map((layerId) => state.viewer.imageLayerWorldBounds(layerId))
    .filter(Boolean);
  if (!bounds.length) return;
  const left = Math.min(...bounds.map((entry) => entry.x));
  const top = Math.min(...bounds.map((entry) => entry.y));
  const right = Math.max(...bounds.map((entry) => entry.x + entry.width));
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.height));
  state.selection = {
    kind: "image-layers",
    layerIds,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
  state.viewer.setSelectionRect(state.selection);
  renderSelectionState();
}

function renderObjectSelection() {
  const objects = selectedObjects();
  if (!objects.length) {
    state.viewer?.setObjectVertexOverlay(null, null);
    state.viewer?.setObjectTransformOverlay(null, null);
    if (state.selectedObjectId != null) clearObjectSelection();
    renderSelectionState();
    return;
  }
  const bounds = objects.map((object) => {
    const changes = state.objectTransform?.current?.find((entry) => entry.id === object.id)?.changes
      || state.objectDrag?.objects?.find((entry) => entry.objectId === object.id)?.current;
    return state.viewer?.objectWorldBounds(state.activeLayerId, object, changes);
  }).filter(Boolean);
  state.selection = unionWorldBounds(bounds, { kind: "objects", objectIds: objects.map((object) => object.id) });
  state.viewer?.setSelectionRect(state.selection);
  const vertexObject = objects.length === 1
    && (Array.isArray(objects[0].polygon) || Array.isArray(objects[0].polyline))
    ? objects[0]
    : null;
  if (state.activeTool === "vertex" && vertexObject) {
    state.viewer?.setObjectVertexOverlay(state.activeLayerId, vertexObject, {
      ...(state.vertexDrag ? { points: state.vertexDrag.current } : {}),
      activeIndex: state.selectedVertexIndex,
    });
  } else {
    state.viewer?.setObjectVertexOverlay(null, null);
  }
  const layer = state.editor?.layerById(state.activeLayerId);
  if (state.activeTool === "select" && state.session?.writable && layer?.locked !== true) {
    const localBounds = objects.map((object) => {
      const changes = state.objectTransform?.current?.find((entry) => entry.id === object.id)?.changes
        || state.objectDrag?.objects?.find((entry) => entry.objectId === object.id)?.current;
      return state.viewer.objectLocalBounds(object, changes);
    });
    state.viewer?.setObjectTransformOverlay(
      state.activeLayerId,
      unionWorldBounds(localBounds),
      { activeHandle: state.objectTransform?.handle || null },
    );
  } else {
    state.viewer?.setObjectTransformOverlay(null, null);
  }
  renderSelectionState();
}

function unionWorldBounds(bounds, extra = {}) {
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map((entry) => entry.x));
  const top = Math.min(...bounds.map((entry) => entry.y));
  const right = Math.max(...bounds.map((entry) => entry.x + entry.width));
  const bottom = Math.max(...bounds.map((entry) => entry.y + entry.height));
  return { ...extra, x: left, y: top, width: right - left, height: bottom - top };
}

function renderInspector() {
  const layer = state.editor?.layerById(state.activeLayerId);
  const object = selectedObject();
  const target = object || layer;
  if (!target) return;
  const writable = state.session?.writable === true;
  const unlocked = layer?.locked !== true;
  const canEdit = writable && unlocked;
  const isObject = Boolean(object);
  const isImageLayer = !isObject && layer.type === "imagelayer";

  elements.inspectorTitle.textContent = isObject ? (object.name || object.class || "对象") : (layer.name || "图层属性");
  const selectedCount = selectedObjects().length;
  let templateWarning = "";
  if (isObject && typeof object.template === "string") {
    try {
      const templatePath = resolveTiledProjectReference(state.session.relativePath, object.template);
      if (state.templateVersionWarnings.has(templatePath)) templateWarning = " · 模板已更新";
    } catch {
      // Keep the ordinary object inspector available for an invalid reference.
    }
  }
  elements.inspectorMeta.textContent = isObject
    ? `#${object.id} · ${tiledObjectShapeLabel(object)}${selectedCount > 1 ? ` · 已选 ${selectedCount}` : ""}${templateWarning}`
    : layer.type;
  elements.objectActions.hidden = !isObject;
  elements.objectCreateControls.hidden = isObject || layer.type !== "objectgroup";
  elements.objectPreset.value = state.objectPreset;
  elements.objectPreset.disabled = !canEdit;
  refreshObjectCreationControls();
  elements.duplicateObjectButton.disabled = !canEdit;
  elements.saveTemplateButton.disabled = !canEdit || !isObject || !state.session.projectFile;
  elements.refreshTemplateButton.disabled = !canEdit || !isObject || !templateWarning;
  elements.unbindTemplateButton.disabled = !canEdit || !isObject || typeof object.template !== "string";
  elements.deleteObjectButton.disabled = !canEdit;
  elements.templateAssetButton.disabled = !canEdit || isObject || layer.type !== "objectgroup";
  updateObjectArrangeControls(canEdit);
  if (!isObject) setObjectArrangePanelOpen(false);

  elements.inspectorName.value = String(target.name || "");
  elements.inspectorClass.value = String(target.class || "");
  elements.inspectorType.value = String(object?.type || "");
  elements.inspectorTypeField.hidden = !isObject;
  elements.inspectorYLabel.textContent = isObject ? "Y" : isImageLayer ? "位置 Y" : "偏移 Y";
  elements.inspectorXLabel.textContent = isObject ? "X" : isImageLayer ? "位置 X" : "偏移 X";
  elements.inspectorX.value = String(Number(isObject || isImageLayer ? target.x || 0 : layer.offsetx || 0));
  elements.inspectorY.value = String(Number(isObject || isImageLayer ? target.y || 0 : layer.offsety || 0));
  elements.inspectorWidth.value = String(Number(object?.width || 0));
  elements.inspectorHeight.value = String(Number(object?.height || 0));
  elements.inspectorRotation.value = String(Number(object?.rotation || 0));
  elements.inspectorWidthField.hidden = !isObject || object.point === true;
  elements.inspectorHeightField.hidden = !isObject || object.point === true;
  elements.inspectorRotationField.hidden = !isObject;
  elements.inspectorOpacityLabel.textContent = isObject ? "对象不透明度" : "图层不透明度";
  elements.inspectorOpacity.value = String(Number.isFinite(target.opacity) ? target.opacity : 1);
  elements.inspectorOpacityField.hidden = false;
  elements.inspectorGid.value = object?.gid ? String(Number(object.gid) >>> 0) : "";
  elements.inspectorGidField.hidden = !object?.gid;
  elements.inspectorDrawOrder.value = layer.draworder === "index" ? "index" : "topdown";
  elements.inspectorDrawOrderField.hidden = isObject || layer.type !== "objectgroup";
  elements.inspectorDrawOrder.disabled = !canEdit;
  elements.inspectorVisible.checked = target.visible !== false;
  elements.inspectorRepeatX.checked = layer.repeatx === true;
  elements.inspectorRepeatY.checked = layer.repeaty === true;
  elements.inspectorRepeatXField.hidden = !isImageLayer;
  elements.inspectorRepeatYField.hidden = !isImageLayer;
  renderTextObjectFields(object, canEdit);
  renderObjectVertexFields(object, canEdit);

  for (const control of elements.inspectorForm.querySelectorAll("input, select, textarea")) control.disabled = !canEdit;
  if (!isObject) elements.inspectorVisible.disabled = !writable;
  elements.customProperties.hidden = false;
  elements.addPropertyButton.disabled = !canEdit;
  renderPropertyRows(target.properties, canEdit);
}

function commitInspectorChange(event) {
  const control = event.target;
  if (control.dataset.textField) {
    commitTextObjectField(control.dataset.textField, control);
    return;
  }
  if (control.dataset.propertyField) {
    updateCustomProperty(Number(control.dataset.propertyIndex), control.dataset.propertyField, control);
    return;
  }
  const layer = state.editor?.layerById(state.activeLayerId);
  const object = selectedObject();
  if (!layer || !control.name) return;
  let field = control.name;
  if (!object && layer.type !== "imagelayer" && field === "x") field = "offsetx";
  if (!object && layer.type !== "imagelayer" && field === "y") field = "offsety";
  let value = control.type === "checkbox" ? control.checked : control.value;
  if (["x", "y", "offsetx", "offsety", "width", "height", "rotation", "opacity", "gid"].includes(field)) {
    value = control.valueAsNumber;
    if (!Number.isFinite(value)) {
      reportEditorError(new Error(`${control.labels?.[0]?.textContent || field} 必须是有效数字`));
      renderInspector();
      return;
    }
    if (field === "opacity") value = Math.max(0, Math.min(1, value));
    if (field === "gid" && (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff)) {
      reportEditorError(new Error("瓦片 GID 必须是 1 至 4294967295 的整数"));
      renderInspector();
      return;
    }
  }
  try {
    if (object) state.editor.updateObject(state.activeLayerId, object.id, { [field]: value }, { label: "修改对象属性" });
    else state.editor.updateLayer(state.activeLayerId, { [field]: value }, { label: "修改图层属性" });
  } catch (error) {
    reportEditorError(error);
    renderInspector();
  }
}

function renderTextObjectFields(object, canEdit) {
  const text = object?.text && typeof object.text === "object" ? object.text : null;
  elements.objectTextFields.hidden = !text;
  if (!text) return;
  elements.objectTextValue.value = String(text.text || "");
  elements.objectTextFontFamily.value = String(text.fontfamily || "sans-serif");
  elements.objectTextPixelSize.value = String(Number.isFinite(text.pixelsize) ? text.pixelsize : 16);
  elements.objectTextColor.value = String(text.color || "#ff000000");
  elements.objectTextHalign.value = ["left", "center", "right", "justify"].includes(text.halign) ? text.halign : "left";
  elements.objectTextValign.value = ["top", "center", "bottom"].includes(text.valign) ? text.valign : "top";
  elements.objectTextWrap.checked = text.wrap === true;
  elements.objectTextBold.checked = text.bold === true;
  elements.objectTextItalic.checked = text.italic === true;
  elements.objectTextUnderline.checked = text.underline === true;
  elements.objectTextStrikeout.checked = text.strikeout === true;
  elements.objectTextKerning.checked = text.kerning !== false;
  for (const control of elements.objectTextFields.querySelectorAll("input, select, textarea")) control.disabled = !canEdit;
}

function commitTextObjectField(field, control) {
  const object = selectedObject();
  if (!object?.text || typeof object.text !== "object") return;
  const text = cloneJsonValue(object.text);
  let value = control.type === "checkbox" ? control.checked : control.value;
  if (field === "pixelsize") {
    value = control.valueAsNumber;
    if (!Number.isSafeInteger(value) || value <= 0) {
      reportEditorError(new Error("文字字号必须是正整数"));
      renderInspector();
      return;
    }
  }
  text[field] = value;
  try {
    state.editor.updateObject(state.activeLayerId, object.id, { text }, { label: "修改文字对象" });
  } catch (error) {
    reportEditorError(error);
    renderInspector();
  }
}

function renderObjectVertexFields(object, canEdit) {
  const field = Array.isArray(object?.polygon) ? "polygon" : Array.isArray(object?.polyline) ? "polyline" : null;
  elements.objectVertexFields.hidden = !field;
  elements.objectVertexList.replaceChildren();
  if (!field) return;
  const points = state.vertexDrag?.current || object[field];
  if (state.selectedVertexIndex != null && state.selectedVertexIndex >= points.length) {
    state.selectedVertexIndex = points.length - 1;
  }
  elements.objectVertexTitle.textContent = `${field === "polygon" ? "多边形" : "折线"}顶点 · ${points.length}`;
  elements.addObjectVertexButton.disabled = !canEdit;
  const minimum = field === "polygon" ? 3 : 2;
  const fragment = document.createDocumentFragment();
  for (const [index, point] of points.entries()) {
    const row = document.createElement("div");
    row.className = `object-vertex-row${index === state.selectedVertexIndex ? " is-active" : ""}`;
    row.dataset.objectVertexIndex = String(index);
    const number = document.createElement("output");
    number.textContent = String(index + 1);
    const x = document.createElement("input");
    x.type = "number";
    x.step = "1";
    x.value = String(Number(point.x || 0));
    x.dataset.objectVertexIndex = String(index);
    x.dataset.objectVertexAxis = "x";
    x.setAttribute("aria-label", `顶点 ${index + 1} X`);
    x.disabled = !canEdit;
    const y = document.createElement("input");
    y.type = "number";
    y.step = "1";
    y.value = String(Number(point.y || 0));
    y.dataset.objectVertexIndex = String(index);
    y.dataset.objectVertexAxis = "y";
    y.setAttribute("aria-label", `顶点 ${index + 1} Y`);
    y.disabled = !canEdit;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-icon-button is-danger";
    remove.dataset.removeObjectVertex = String(index);
    remove.title = "删除顶点";
    remove.setAttribute("aria-label", `删除顶点 ${index + 1}`);
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.disabled = !canEdit || points.length <= minimum;
    row.append(number, x, y, remove);
    fragment.append(row);
  }
  elements.objectVertexList.append(fragment);
  refreshIcons();
}

function selectVertexFromControl(event) {
  const control = event.target instanceof Element ? event.target.closest("[data-object-vertex-index]") : null;
  const index = Number(control?.dataset.objectVertexIndex);
  if (!Number.isSafeInteger(index)) return;
  state.selectedVertexIndex = index;
  const object = selectedObject();
  state.viewer?.setObjectVertexOverlay(state.activeLayerId, object, {
    ...(state.vertexDrag ? { points: state.vertexDrag.current } : {}),
    activeIndex: index,
  });
  for (const row of elements.objectVertexList.querySelectorAll(".object-vertex-row")) {
    row.classList.toggle("is-active", Number(row.dataset.objectVertexIndex) === index);
  }
}

function commitObjectVertexControl(event) {
  const control = event.target;
  const index = Number(control.dataset.objectVertexIndex);
  const axis = control.dataset.objectVertexAxis;
  const object = selectedObject();
  const points = object?.polygon || object?.polyline;
  if (!Number.isSafeInteger(index) || !["x", "y"].includes(axis) || !Array.isArray(points)) return;
  const value = control.valueAsNumber;
  if (!Number.isFinite(value)) {
    reportEditorError(new Error("顶点坐标必须是有效数字"));
    renderInspector();
    return;
  }
  const point = { ...points[index], [axis]: value };
  try {
    state.editor.updateObject(state.activeLayerId, object.id, updateTiledObjectVertex(object, index, point), {
      label: "修改对象顶点",
    });
    state.selectedVertexIndex = index;
    renderObjectSelection();
    renderInspector();
  } catch (error) {
    reportEditorError(error);
    renderInspector();
  }
}

function addSelectedObjectVertex() {
  const object = selectedObject();
  if (!object) return false;
  try {
    const suggestion = suggestedTiledObjectVertex(object);
    state.editor.updateObject(
      state.activeLayerId,
      object.id,
      insertTiledObjectVertex(object, suggestion.index, suggestion.point),
      { label: "添加对象顶点" },
    );
    state.selectedVertexIndex = suggestion.index;
    renderObjectSelection();
    renderInspector();
    updateToolAvailability();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function removeSelectedObjectVertex(index) {
  const object = selectedObject();
  if (!object) return false;
  try {
    state.editor.updateObject(state.activeLayerId, object.id, removeTiledObjectVertex(object, index), {
      label: "删除对象顶点",
    });
    const points = object.polygon || object.polyline || [];
    state.selectedVertexIndex = Math.min(index, points.length - 1);
    renderObjectSelection();
    renderInspector();
    updateToolAvailability();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function renderPropertyRows(properties, canEdit) {
  const fragment = document.createDocumentFragment();
  for (const [index, property] of (Array.isArray(properties) ? properties : []).entries()) {
    const row = document.createElement("div");
    row.className = "property-row";
    const name = document.createElement("input");
    name.value = String(property?.name || "");
    name.placeholder = "名称";
    name.setAttribute("aria-label", `属性 ${index + 1} 名称`);
    setPropertyControl(name, index, "name", canEdit);
    const type = document.createElement("select");
    type.setAttribute("aria-label", `属性 ${index + 1} 类型`);
    const propertyType = String(property?.type || "string");
    const types = ["string", "int", "float", "bool", "color", "file", "object", "class", "enum", "list"];
    if (!types.includes(propertyType)) types.push(propertyType);
    for (const value of types) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      type.append(option);
    }
    type.value = propertyType;
    setPropertyControl(type, index, "type", canEdit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-icon-button is-danger";
    remove.title = "删除属性";
    remove.setAttribute("aria-label", `删除属性 ${property?.name || index + 1}`);
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.disabled = !canEdit;
    remove.addEventListener("click", () => deleteCustomProperty(index));
    const propertyTypeName = propertyTypeNameControl(property, index, canEdit);
    const value = propertyValueControl(property, index, canEdit);
    const reference = propertyReferenceButton(property, index);
    row.append(
      name,
      type,
      remove,
      ...(propertyTypeName ? [propertyTypeName] : []),
      value,
      ...(reference ? [reference] : []),
    );
    fragment.append(row);
  }
  elements.propertyRows.replaceChildren(fragment);
  refreshIcons();
}

function propertyValueControl(property, index, canEdit) {
  const type = String(property?.type || "string");
  const model = tiledPropertyControl(property, state.projectTypes);
  const input = document.createElement(["class", "list"].includes(type) ? "textarea" : type === "enum" && model.editable ? "select" : "input");
  input.className = "property-value";
  input.setAttribute("aria-label", `属性 ${property?.name || index + 1} 值`);
  if (type === "enum" && model.editable) {
    input.multiple = model.valuesAsFlags;
    for (const optionValue of model.values) {
      const option = document.createElement("option");
      option.value = String(optionValue);
      option.textContent = String(optionValue);
      const selected = model.valuesAsFlags
        ? String(property.value || "").split(",").map((entry) => entry.trim()).includes(String(optionValue))
          || (model.definition.storageType === "int" && (Number(property.value) & Number(optionValue)) === Number(optionValue))
        : String(property.value ?? "") === String(optionValue);
      option.selected = selected;
      input.append(option);
    }
  } else if (type === "bool") {
    input.type = "checkbox";
    input.checked = property.value === true;
  } else if (["int", "float", "object"].includes(type)) {
    input.type = "number";
    input.step = type === "float" ? "any" : "1";
    input.value = String(Number(property.value || 0));
  } else if (type === "class") {
    const value = model.definition
      ? mergeTiledClassDefaults(property.value, model.definition, state.projectTypes)
      : property.value;
    input.value = JSON.stringify(value ?? {}, null, 2);
    input.rows = 4;
  } else if (type === "list") {
    input.value = JSON.stringify(Array.isArray(property.value) ? property.value : [], null, 2);
    input.rows = 4;
  } else {
    input.type = "text";
    input.value = typeof property.value === "object" && property.value !== null
      ? JSON.stringify(property.value)
      : String(property.value ?? "");
  }
  setPropertyControl(input, index, "value", canEdit);
  return input;
}

function propertyTypeNameControl(property, index, canEdit) {
  const type = String(property?.type || "string");
  if (!["class", "enum"].includes(type)) return null;
  const select = document.createElement("select");
  select.className = "property-type-name";
  select.setAttribute("aria-label", `属性 ${property?.name || index + 1} 的项目类型`);
  const names = type === "class" ? state.projectTypes.classNames : state.projectTypes.enumNames;
  const current = String(property?.propertytype ?? property?.propertyType ?? "");
  const values = current && !names.includes(current) ? [current, ...names] : names;
  if (!values.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "项目中没有可用类型";
    select.append(option);
  } else {
    for (const name of values) select.append(new Option(name, name));
    select.value = current || values[0];
  }
  setPropertyControl(select, index, "propertyType", canEdit && values.length > 0);
  return select;
}

function propertyReferenceButton(property, index) {
  const type = String(property?.type || "string");
  if (!['file', 'object'].includes(type)) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini-icon-button property-reference-button";
  button.dataset.propertyReferenceIndex = String(index);
  button.innerHTML = `<i data-lucide="${type === "object" ? "locate-fixed" : "external-link"}"></i>`;
  button.title = type === "object" ? "跳转到引用对象" : "打开引用文件";
  button.setAttribute("aria-label", `${button.title} ${property?.name || index + 1}`);
  const hasValue = type === "object"
    ? Number.isSafeInteger(Number(property?.value)) && Number(property.value) > 0
    : typeof property?.value === "string" && Boolean(property.value);
  button.disabled = !hasValue;
  button.addEventListener("click", () => {
    if (type === "object") jumpToObjectPropertyReference(property.value);
    else void openFilePropertyReference(property.value, button);
  });
  return button;
}

function jumpToObjectPropertyReference(rawObjectId) {
  const objectId = Number(rawObjectId);
  const target = findObjectReference(state.editor?.document?.layers, objectId);
  if (!target) {
    reportEditorError(new Error(`没有找到引用对象 ID ${objectId}`));
    return false;
  }
  const view = state.viewer?.layerViews.find(({ layer }) => layer.id === target.layer.id);
  if (!view) {
    reportEditorError(new Error(`引用对象 ID ${objectId} 所在图层当前不可用`));
    return false;
  }
  setActiveLayer(view);
  selectObject(objectId);
  elements.selectionState.textContent = `已跳转到 ${target.object.name || target.object.class || `对象 ${objectId}`}`;
  return true;
}

function findObjectReference(layers, objectId) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    const object = Array.isArray(layer?.objects)
      ? layer.objects.find((entry) => entry?.id === objectId)
      : null;
    if (object) return { layer, object };
    const nested = findObjectReference(layer?.layers, objectId);
    if (nested) return nested;
  }
  return null;
}

async function openFilePropertyReference(rawReference, button) {
  let relativePath;
  try {
    relativePath = resolveTiledProjectReference(state.session.relativePath, String(rawReference || ""));
  } catch (error) {
    reportEditorError(error);
    return false;
  }
  const extension = relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase();
  if ([".tmj", ".world", ".tsj"].includes(extension)) {
    return openReferencedTiledDocument(relativePath, extension);
  }
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    reportEditorError(new Error("浏览器阻止了引用文件窗口"));
    return false;
  }
  button.disabled = true;
  try {
    const textResource = [".tx", ".txt"].includes(extension);
    const url = new URL(
      `/api/maps/sessions/${encodeURIComponent(state.credentials.sessionId)}/${textResource ? "project-resource" : "resource"}`,
      location.origin,
    );
    url.searchParams.set("path", relativePath);
    const response = await fetch(url, { cache: "no-store", headers: mapHeaders() });
    if (!response.ok) throw await responseError(response, "无法打开引用文件");
    const blobUrl = URL.createObjectURL(await response.blob());
    popup.location.replace(blobUrl);
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return true;
  } catch (error) {
    if (!popup.closed) popup.close();
    reportEditorError(error);
    return false;
  } finally {
    button.disabled = false;
  }
}

async function openReferencedTiledDocument(relativePath, extension) {
  if (!state.credentials?.projectPath) {
    reportEditorError(new Error("当前窗口没有项目会话，无法安全打开引用的 Tiled 文档"));
    return false;
  }
  const config = extension === ".world"
    ? {
      endpoint: "/api/map-worlds/sessions",
      action: "map-world-session-open",
      closeAction: "map-world-session-close",
      page: "/world-editor.html",
    }
    : extension === ".tsj"
      ? {
        endpoint: "/api/map-tilesets/sessions",
        action: "map-tileset-session-open",
        closeAction: "map-tileset-session-close",
        page: "/tileset-editor.html",
      }
      : {
        endpoint: "/api/maps/sessions",
        action: "map-session-open",
        closeAction: "map-session-close",
        page: "/map-editor.html",
      };
  const popup = window.open(`${config.page}#pending`, "_blank");
  if (!popup) {
    reportEditorError(new Error("浏览器阻止了 Tiled 引用窗口"));
    return false;
  }
  const editorInstanceId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tiled-reference-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let openedSessionId = null;
  try {
    const projectSession = await ensureMapProjectWorkspace();
    const response = await fetchMapWithTimeout(config.endpoint, {
      method: "POST",
      cache: "no-store",
      headers: {
        ...mapHeaders(),
        "Content-Type": "application/json",
        "X-Codex-Desktop-Action": config.action,
      },
      body: JSON.stringify({
        projectSessionId: projectSession.id,
        path: relativePath,
        editorInstanceId,
      }),
    }, 20_000);
    if (!response.ok) throw await responseError(response, "无法打开引用的 Tiled 文档");
    const data = await response.json();
    if (!data.session?.id) throw new Error("Tiled 引用会话响应无效");
    openedSessionId = data.session.id;
    if (popup.closed) {
      await closeReferencedTiledSession(config, openedSessionId, editorInstanceId);
      openedSessionId = null;
      return false;
    }
    const fragment = new URLSearchParams({
      session: data.session.id,
      editor: editorInstanceId,
      project: state.credentials.projectPath || "",
      ...(state.credentials.projectFile ? { projectFile: state.credentials.projectFile } : {}),
      ...(extension === ".tmj" ? { projectSession: projectSession.id } : {}),
      ...(state.credentials.accountId ? { account: state.credentials.accountId } : {}),
    });
    popup.location.replace(`${config.page}#${fragment}`);
    openedSessionId = null;
    return true;
  } catch (error) {
    if (openedSessionId) await closeReferencedTiledSession(config, openedSessionId, editorInstanceId);
    if (!popup.closed) popup.close();
    reportEditorError(error);
    return false;
  }
}

async function closeReferencedTiledSession(config, sessionId, editorInstanceId) {
  await fetch(`${config.endpoint}/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    cache: "no-store",
    keepalive: true,
    headers: {
      ...mapHeaders(),
      "X-Codex-Desktop-Action": config.closeAction,
      "X-Codex-Desktop-Editor-Instance": editorInstanceId,
    },
  }).catch(() => {});
}

function setPropertyControl(control, index, field, canEdit) {
  control.dataset.propertyIndex = String(index);
  control.dataset.propertyField = field;
  control.disabled = !canEdit;
}

function updateCustomProperty(index, field, control) {
  const target = selectedObject() || state.editor?.layerById(state.activeLayerId);
  const properties = cloneJsonValue(Array.isArray(target?.properties) ? target.properties : []);
  if (!properties[index]) return;
  try {
    if (field === "name") properties[index].name = control.value;
    else if (field === "type") {
      properties[index].type = control.value;
      delete properties[index].propertytype;
      delete properties[index].propertyType;
      if (control.value === "class" && state.projectTypes.classNames.length) {
        properties[index].propertytype = state.projectTypes.classNames[0];
      } else if (control.value === "enum" && state.projectTypes.enumNames.length) {
        properties[index].propertytype = state.projectTypes.enumNames[0];
      }
      properties[index].value = coercePropertyValue(properties[index], properties[index].value);
    } else if (field === "propertyType") {
      properties[index].propertytype = control.value;
      delete properties[index].propertyType;
      properties[index].value = coercePropertyValue(properties[index], properties[index].value);
    } else {
      properties[index].value = propertyControlValue(properties[index], control);
    }
    validateFileProperty(properties[index]);
    commitTargetProperties(properties, "修改 Tiled 属性");
  } catch (error) {
    reportEditorError(error);
    renderInspector();
  }
}

function propertyControlValue(property, control) {
  const type = property.type;
  if (type === "bool") return control.checked;
  if (["int", "object"].includes(type)) {
    if (!Number.isSafeInteger(control.valueAsNumber)) throw new Error("整数属性必须是安全整数");
    return control.valueAsNumber;
  }
  if (type === "float") {
    if (!Number.isFinite(control.valueAsNumber)) throw new Error("浮点属性必须是有效数字");
    return control.valueAsNumber;
  }
  if (type === "class") return normalizeTiledPropertyValue(property, JSON.parse(control.value || "{}"), state.projectTypes);
  if (type === "list") return normalizeTiledPropertyValue(property, JSON.parse(control.value || "[]"), state.projectTypes);
  if (type === "enum") {
    const model = tiledPropertyControl(property, state.projectTypes);
    let value;
    if (model.valuesAsFlags) {
      const selected = [...control.selectedOptions].map((option) => option.value);
      value = model.definition?.storageType === "int"
        ? selected.reduce((flags, entry) => flags | Number(entry), 0)
        : selected.join(",");
    } else value = control.value;
    return normalizeTiledPropertyValue(property, value, state.projectTypes);
  }
  return control.value;
}

function coercePropertyValue(property, value) {
  const type = property.type;
  if (type === "bool") return Boolean(value);
  if (["int", "object"].includes(type)) return Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  if (type === "float") return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (type === "class") {
    const definition = tiledPropertyControl(property, state.projectTypes).definition;
    return definition ? mergeTiledClassDefaults(value, definition, state.projectTypes) : value && typeof value === "object" ? value : {};
  }
  if (type === "enum") {
    const definition = tiledPropertyControl(property, state.projectTypes).definition;
    if (!definition) return value;
    if (definition.valuesAsFlags) return definition.storageType === "int" ? 0 : "";
    return definition.values[0];
  }
  if (type === "list") return Array.isArray(value) ? value : [];
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
}

function validateFileProperty(property) {
  if (property.type === "file" && property.value) {
    resolveTiledProjectReference(state.session.relativePath, property.value);
  }
}

function addCustomProperty() {
  const target = selectedObject() || state.editor?.layerById(state.activeLayerId);
  if (!target) return;
  const properties = cloneJsonValue(Array.isArray(target.properties) ? target.properties : []);
  const names = new Set(properties.map((property) => property?.name));
  let suffix = 1;
  let name = "property";
  while (names.has(name)) name = `property${++suffix}`;
  properties.push({ name, type: "string", value: "" });
  commitTargetProperties(properties, "添加 Tiled 属性");
}

function deleteCustomProperty(index) {
  const target = selectedObject() || state.editor?.layerById(state.activeLayerId);
  const properties = cloneJsonValue(Array.isArray(target?.properties) ? target.properties : []);
  if (index < 0 || index >= properties.length) return;
  properties.splice(index, 1);
  commitTargetProperties(properties, "删除 Tiled 属性");
}

function commitTargetProperties(properties, label) {
  const object = selectedObject();
  try {
    if (object) state.editor.updateObject(state.activeLayerId, object.id, { properties }, { label });
    else state.editor.updateLayer(state.activeLayerId, { properties }, { label });
  } catch (error) {
    reportEditorError(error);
    renderInspector();
  }
}

function setObjectArrangePanelOpen(open) {
  const visible = Boolean(open && selectedObjects().length);
  elements.objectArrangePanel.hidden = !visible;
  elements.objectArrangeButton.setAttribute("aria-expanded", String(visible));
}

function updateObjectArrangeControls(canEdit = false) {
  const count = selectedObjects().length;
  elements.objectArrangeButton.disabled = !canEdit || count < 1;
  for (const button of elements.objectArrangePanel.querySelectorAll("[data-object-arrange]")) {
    const distribution = button.dataset.objectArrange?.startsWith("distribute-");
    button.disabled = !canEdit || count < (distribution ? 3 : 2);
  }
  for (const button of elements.objectArrangePanel.querySelectorAll("[data-object-order]")) {
    button.disabled = !canEdit || count < 1;
  }
}

function arrangeSelectedObjects(action) {
  const objects = selectedObjects();
  if (!objects.length) return false;
  try {
    const changes = planTiledObjectArrangement(objects.map((object) => ({
      id: object.id,
      x: Number(object.x || 0),
      y: Number(object.y || 0),
      bounds: state.viewer.objectLocalBounds(object),
    })), action);
    const labels = {
      left: "对象左对齐",
      "center-x": "对象水平居中",
      right: "对象右对齐",
      top: "对象顶部对齐",
      "center-y": "对象垂直居中",
      bottom: "对象底部对齐",
      "distribute-x": "对象水平等距分布",
      "distribute-y": "对象垂直等距分布",
    };
    state.editor.runBatch(labels[action] || "排列对象", () => {
      for (const change of changes) {
        const object = objects.find((entry) => entry.id === change.id);
        if (change.x !== object.x || change.y !== object.y) {
          state.editor.updateObject(state.activeLayerId, change.id, { x: change.x, y: change.y }, {
            label: labels[action] || "排列对象",
          });
        }
      }
    });
    renderObjectSelection();
    renderInspector();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function orderSelectedObjects(direction) {
  const objects = selectedObjects();
  if (!objects.length) return false;
  const labels = {
    front: "对象置于顶层",
    forward: "对象上移一层",
    backward: "对象下移一层",
    back: "对象置于底层",
  };
  try {
    const changed = state.editor.moveObjects(
      state.activeLayerId,
      objects.map((object) => object.id),
      direction,
      { label: labels[direction] || "调整对象顺序" },
    );
    if (changed) scheduleLayerRefresh(state.activeLayerId);
    renderObjectSelection();
    return changed;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function duplicateSelectedObject() {
  const objects = selectedObjects();
  if (!objects.length) return false;
  try {
    const duplicates = [];
    state.editor.runBatch(objects.length > 1 ? `复制 ${objects.length} 个对象` : "复制对象", () => {
      for (const object of objects) {
        duplicates.push(state.editor.duplicateObject(state.activeLayerId, object.id, {
          x: Number(object.x || 0) + state.document.tilewidth,
          y: Number(object.y || 0) + state.document.tileheight,
        }));
      }
    });
    setObjectSelection(duplicates.map((object) => object.id));
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function copySelectedObject() {
  const objects = selectedObjects();
  if (!objects.length) return false;
  state.objectClipboard = cloneJsonValue(objects);
  return true;
}

function pasteCopiedObject() {
  const layer = state.editor?.layerById(state.activeLayerId);
  const clipboard = Array.isArray(state.objectClipboard) ? state.objectClipboard : [];
  if (!clipboard.length || layer?.type !== "objectgroup") return false;
  try {
    const pasted = [];
    state.editor.runBatch(clipboard.length > 1 ? `粘贴 ${clipboard.length} 个对象` : "粘贴对象", () => {
      for (const source of clipboard) {
        const value = cloneJsonValue(source);
        delete value.id;
        value.x = Number(value.x || 0) + state.document.tilewidth;
        value.y = Number(value.y || 0) + state.document.tileheight;
        pasted.push(state.editor.addObject(state.activeLayerId, value, { label: "粘贴对象" }));
      }
    });
    state.objectClipboard = cloneJsonValue(pasted);
    setObjectSelection(pasted.map((object) => object.id));
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function deleteSelectedObject() {
  const objects = selectedObjects();
  if (!objects.length) return false;
  try {
    state.editor.runBatch(objects.length > 1 ? `删除 ${objects.length} 个对象` : "删除对象", () => {
      for (const object of [...objects].reverse()) {
        state.editor.removeObject(state.activeLayerId, object.id, { label: "删除对象" });
      }
    });
    clearObjectSelection();
    renderInspector();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function nudgeSelectedObjects(delta) {
  const objects = selectedObjects();
  const layer = state.editor?.layerById(state.activeLayerId);
  if (!objects.length || !state.session?.writable || layer?.locked === true) return false;
  try {
    state.editor.runBatch(objects.length > 1 ? `微调 ${objects.length} 个对象` : "微调对象", () => {
      for (const object of objects) {
        state.editor.updateObject(state.activeLayerId, object.id, {
          x: Number(object.x || 0) + delta.x,
          y: Number(object.y || 0) + delta.y,
        }, { label: "微调对象" });
      }
    });
    renderObjectSelection();
    renderInspector();
    return true;
  } catch (error) {
    reportEditorError(error);
    return false;
  }
}

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isTextEditingTarget(target) {
  return target instanceof Element && (target.matches("input, select, textarea") || target.isContentEditable);
}

function renderDocumentState(event = null) {
  if (!state.session) return;
  if (event?.action && !state.fillPending) state.fillMessage = "";
  scheduleMapAiLeaseInvalidationAfterEdit(event);
  if (["commit", "undo", "redo"].includes(event?.action) && event.entry) {
    if (event.entry.structural === true) {
      scheduleLayerTreeRebuild(event.entry.layerId, {
        reloadTilesets: event.entry.reloadTilesets === true,
      });
    } else {
      const layerIds = Array.isArray(event.entry.layerIds)
        ? event.entry.layerIds
        : [event.entry.layerId];
      for (const layerId of layerIds.filter(Number.isSafeInteger)) scheduleLayerRefresh(layerId);
    }
  }
  if (
    state.aiPatchPreview
    && !state.aiApplying
    && ["commit", "undo", "redo", "reset", "saved"].includes(event?.action)
  ) {
    invalidateAiPatchPreview("地图状态已经变化，请重新预览补丁");
  }
  if (
    state.autoMapPreview
    && !state.autoMapApplying
    && ["commit", "undo", "redo", "reset", "saved"].includes(event?.action)
  ) {
    clearAutoMapPreview();
    if (elements.autoMapDialog.open) setAutoMapMessage("地图状态已经变化，请重新生成 AutoMap 预览");
  }
  if (state.viewer) {
    for (const view of state.viewer.layerViews) {
      state.viewer.syncLayerProperties(view.layer.id, { refreshVisibleTiles: false });
      const row = elements.layerList.querySelector(`.layer-row[data-layer-id="${CSS.escape(String(view.layer.id ?? ""))}"]`);
      const checkbox = row?.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = view.container.visible;
      const name = row?.querySelector(".layer-name");
      if (name) name.textContent = view.layer.name || `图层 ${view.layer.id || ""}`.trim();
      const lock = row?.querySelector(".layer-lock");
      if (lock) setLayerLockButton(lock, view.layer);
      if (row) row.draggable = state.session.writable === true && !layerTreeEntryLocked(view.layer.id);
    }
    state.viewer.refreshVisibleTileLayers();
  }
  elements.undoButton.disabled = !state.session.writable || !state.editor?.canUndo;
  elements.redoButton.disabled = !state.session.writable || !state.editor?.canRedo;
  elements.saveButton.disabled = !state.session.writable
    || !state.editor?.dirty
    || state.saving
    || Boolean(state.fillPending)
    || Boolean(state.autoMapGesturePending);
  elements.revisionsButton.disabled = !state.session?.id;
  elements.aiEditButton.disabled = !state.session.writable;
  elements.autoMapButton.disabled = !state.session.writable || !state.session.projectFile;
  elements.undoButton.dataset.historyDepth = String(state.editor?.undoStack.length || 0);
  elements.redoButton.dataset.historyDepth = String(state.editor?.redoStack.length || 0);
  elements.undoButton.title = state.editor?.undoStack.at(-1)?.label
    ? `撤销：${state.editor.undoStack.at(-1).label}`
    : "撤销";
  elements.redoButton.title = state.editor?.redoStack.at(-1)?.label
    ? `重做：${state.editor.redoStack.at(-1).label}`
    : "重做";
  elements.documentState.textContent = state.fillPending || state.fillMessage || state.autoMapGesturePending
    ? state.fillMessage || state.autoMapGestureMessage
    : state.saving
    ? state.saveProgress || "正在保存"
    : state.session.writable
      ? state.editor?.dirty ? "未保存" : "已保存"
      : "只读";
  updateAutoSaveTimer(event);
  if (elements.exportDialog.open) renderExportKind();
  if (state.selectedObjectId != null && !selectedObject()) clearObjectSelection();
  if (state.selectedObjectId != null) renderObjectSelection();
  updateToolAvailability();
  if (!state.imageLayerDrag && state.editor?.layerById(state.activeLayerId)?.type === "imagelayer") {
    renderImageLayerSelection();
  } else {
    renderSelectionState();
  }
  if (state.detailTab === "properties") renderInspector();
  updateLayerActionAvailability();
  sendMapEditorTabState();
  renderMapDocumentTabs();
  renderMapAiConnection();
  if (elements.mapImageDialog.open && ["commit", "undo", "redo", "reset"].includes(event?.action)) {
    renderMapImageJobs();
  }
  refreshIcons();
}

function updateLayerActionAvailability() {
  if (!state.session) return;
  const writable = state.session.writable === true
    && !state.layerTreeRebuildRunning
    && !state.layerTreeRebuildPending;
  const entry = state.editor?.layerEntryById(state.activeLayerId) || null;
  const selectedRootIds = selectedLayerRootIds();
  const selectedEntries = selectedRootIds.map((layerId) => state.editor?.layerEntryById(layerId)).filter(Boolean);
  const ancestors = entry?.ancestors || [];
  const layerLocked = Boolean(entry && [...ancestors, entry.layer].some((layer) => layer?.locked === true));
  const parentLocked = entry?.parent?.locked === true
    || ancestors.some((layer) => layer?.locked === true);
  const selectedGroupLocked = entry?.layer.type === "group" && entry.layer.locked === true;
  const canAdd = writable && !parentLocked && !selectedGroupLocked;
  elements.addTileLayerButton.disabled = !canAdd;
  elements.addObjectLayerButton.disabled = !canAdd;
  elements.addGroupLayerButton.disabled = !canAdd;
  elements.addImageLayerButton.disabled = !writable || parentLocked || selectedGroupLocked;
  elements.addImageLayerButton.title = "导入图片图层";
  elements.addTilesetButton.disabled = !writable;
  elements.addTilesetButton.title = "导入外部 TSJ 瓦片集";
  const sameParent = selectedEntries.length > 0
    && selectedEntries.every((candidate) => (
      (candidate.parent?.id ?? null) === (selectedEntries[0].parent?.id ?? null)
    ));
  const selectedIndices = selectedEntries.map((candidate) => candidate.index);
  const selectedLocked = selectedRootIds.some((layerId) => layerTreeEntryLocked(layerId, { includeDescendants: true }));
  const selectedParentLocked = selectedEntries.some((candidate) => (
    candidate.parent?.locked === true || candidate.ancestors.some((ancestor) => ancestor?.locked === true)
  ));
  const siblings = sameParent ? selectedEntries[0].siblings : [];
  const minimumIndex = selectedIndices.length ? Math.min(...selectedIndices) : -1;
  const maximumIndex = selectedIndices.length ? Math.max(...selectedIndices) : -1;
  elements.duplicateLayerButton.disabled = !writable || !selectedEntries.length || selectedParentLocked;
  elements.saveCompositeButton.disabled = !writable || !state.session.projectFile || !selectedEntries.length;
  elements.deleteLayerButton.disabled = !writable || !selectedEntries.length || selectedLocked;
  elements.moveLayerUpButton.disabled = !writable
    || !sameParent
    || selectedLocked
    || minimumIndex <= 0;
  elements.moveLayerDownButton.disabled = !writable
    || !sameParent
    || selectedLocked
    || maximumIndex >= siblings.length - 1;
  const selectionSuffix = selectedEntries.length > 1 ? `（${selectedEntries.length} 个）` : "";
  elements.duplicateLayerButton.title = `复制图层${selectionSuffix}`;
  elements.saveCompositeButton.title = `将所选图层保存为组合 TMJ${selectionSuffix}`;
  elements.deleteLayerButton.title = `删除图层${selectionSuffix}`;
  elements.moveLayerUpButton.title = `上移图层${selectionSuffix}`;
  elements.moveLayerDownButton.title = `下移图层${selectionSuffix}`;
  renderImageArrangeControls();
  updateMapImageControls();
}

function renderCoordinates(point) {
  if (!point || !state.document) return;
  // Object movement and transform commits use integer pixel rounding. Keep the
  // visible pointer coordinates on the same rule so a handle shown at X=112
  // cannot commit at X=113.
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  elements.coordinates.textContent = `X ${x} · Y ${y}`;
  const tile = state.viewer?.tileCoordinatesForLayer(state.activeLayerId, point);
  elements.tileCoordinates.textContent = tile ? `Tile ${tile.x}, ${tile.y}` : "Tile -";
}

function addWarning(message) {
  const normalized = String(message);
  state.warnings.add(normalized);
  elements.warningState.hidden = false;
  elements.warningState.querySelector("span").textContent = `${state.warnings.size} 警告`;
  elements.warningState.title = normalized;
}

function reportEditorError(error) {
  const message = error instanceof Error ? error.message : String(error || "地图编辑失败");
  addWarning(message);
  elements.warningState.setAttribute("aria-label", `地图编辑失败：${message}`);
}

function setLoading(title, detail) {
  elements.mapApp.dataset.state = "loading";
  elements.mapLoadState.hidden = false;
  elements.loadTitle.textContent = title;
  elements.loadDetail.textContent = detail;
  elements.retryButton.hidden = true;
  elements.mapState.dataset.status = "loading";
  elements.mapState.innerHTML = '<i data-lucide="loader-circle"></i><span>读取中</span>';
  refreshIcons();
}

function setReady() {
  elements.mapApp.dataset.state = "ready";
  elements.mapLoadState.hidden = true;
  elements.mapState.dataset.status = "ready";
  elements.mapState.innerHTML = '<i data-lucide="circle-check"></i><span>已就绪</span>';
  renderMapMeta();
  for (const button of [
    elements.zoomOutButton,
    elements.zoomInButton,
    elements.fitButton,
    elements.gridButton,
    elements.gamePreviewButton,
  ]) {
    button.disabled = false;
  }
  elements.assetLibraryButton.disabled = !state.session.projectFile;
  elements.crossProjectImportButton.disabled = !state.credentials?.projectPath || !state.session.writable;
  elements.exportButton.disabled = !state.session.writable;
  updateToolAvailability();
  renderDocumentState();
  refreshIcons();
}

function renderMapMeta() {
  elements.mapMeta.textContent = [
    state.session.relativePath,
    `${state.document.width} × ${state.document.height}`,
    `${state.document.tilewidth} px`,
    formatBytes(state.session.size),
  ].join(" · ");
}

function setError(error) {
  elements.mapApp.dataset.state = "error";
  elements.mapLoadState.hidden = false;
  elements.mapLoadState.querySelector(".map-loader").hidden = true;
  elements.loadTitle.textContent = error.status === 409 ? "地图版本已变化" : "地图无法打开";
  elements.loadDetail.textContent = error.message;
  elements.retryButton.hidden = false;
  elements.mapState.dataset.status = "error";
  elements.mapState.innerHTML = '<i data-lucide="circle-alert"></i><span>打开失败</span>';
  refreshIcons();
}

function setLayerPanelOpen(open) {
  elements.mapApp.dataset.layersOpen = String(Boolean(open));
  elements.layersButton.setAttribute("aria-expanded", String(Boolean(open)));
  elements.layerScrim.hidden = !open;
  scheduleMapEditorViewStateSave();
}

function mapEditorViewScope() {
  if (!state.credentials?.accountId || !state.credentials?.projectPath || !state.session?.relativePath) return null;
  return {
    accountId: state.credentials.accountId,
    projectPath: state.credentials.projectPath,
    relativePath: state.session.relativePath,
  };
}

function loadMapEditorViewState() {
  const scope = mapEditorViewScope();
  if (!scope) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(mapEditorViewStorageKey(scope)) || "null");
    return parseMapEditorViewState(stored);
  } catch {
    return null;
  }
}

function loadTileStampLibrary() {
  const scope = mapEditorViewScope();
  if (!scope) return createTileStampLibrary();
  try {
    const stored = JSON.parse(localStorage.getItem(tileStampLibraryStorageKey(scope)) || "null");
    return parseTileStampLibrary(stored) || createTileStampLibrary();
  } catch {
    return createTileStampLibrary();
  }
}

function persistTileStampLibrary() {
  const scope = mapEditorViewScope();
  if (!scope) return false;
  localStorage.setItem(tileStampLibraryStorageKey(scope), JSON.stringify(state.tileStampLibrary));
  return true;
}

function initializeMapGuideController() {
  state.guideController?.destroy();
  state.guideController = new MapGuideController({
    host: elements.mapCanvasHost,
    topRuler: elements.mapRulerTop,
    leftRuler: elements.mapRulerLeft,
    layer: elements.mapGuideLayer,
    panel: elements.mapGuidePanel,
    panelButton: elements.guidePanelButton,
    closeButton: elements.closeGuidePanelButton,
    visibleInput: elements.guidesVisible,
    unitInput: elements.guideDefaultUnit,
    addVerticalButton: elements.addVerticalGuideButton,
    addHorizontalButton: elements.addHorizontalGuideButton,
    list: elements.mapGuideList,
    emptyState: elements.mapGuideEmptyState,
    document: state.document,
    screenToWorld: (point) => state.viewer.screenToWorld(point),
    worldToScreen: (point) => state.viewer.worldToScreen(point),
    onChange: () => scheduleMapEditorViewStateSave(),
    refreshIcons,
  });
  state.guideController.restore(state.mapEditorViewState || {});
}

function scheduleMapEditorViewStateSave() {
  if (state.mapEditorViewRestoring || !state.viewer || !mapEditorViewScope()) return;
  clearTimeout(state.mapEditorViewSaveTimer);
  state.mapEditorViewSaveTimer = setTimeout(() => {
    state.mapEditorViewSaveTimer = null;
    flushMapEditorViewState();
  }, MAP_EDITOR_VIEW_SAVE_DELAY_MS);
}

function flushMapEditorViewState() {
  clearTimeout(state.mapEditorViewSaveTimer);
  state.mapEditorViewSaveTimer = null;
  const scope = mapEditorViewScope();
  if (!scope || !state.viewer) return false;
  try {
    const view = createMapEditorViewState({
      ...state.viewer.renderView(),
      ...(state.guideController?.snapshot() || {}),
      activeLayerId: state.activeLayerId,
      detailTab: state.detailTab,
      activeTool: state.activeTool,
      gridVisible: state.gridVisible,
      layerPanelOpen: elements.mapApp.dataset.layersOpen === "true",
      imageSnapEnabled: state.imageSnapEnabled,
      imageSnapUnit: state.imageSnapUnit,
      imageSnapStep: state.imageSnapStep,
      tileRandomEnabled: state.tileRandomEnabled,
      tileRandomSeed: state.tileRandomSeed,
      tileSelectionMode: state.tileSelectionMode,
      autoMapWhileDrawing: state.autoMapWhileDrawing,
      autoMapSeed: normalizeAutoMapSeed(elements.autoMapSeed.value || 1),
    });
    localStorage.setItem(mapEditorViewStorageKey(scope), JSON.stringify(view));
    state.mapEditorViewState = view;
    return true;
  } catch {
    return false;
  }
}

function layerIcon(type) {
  if (type === "tilelayer") return "grid-2x2";
  if (type === "objectgroup") return "shapes";
  if (type === "imagelayer") return "image";
  if (type === "group") return "folder-tree";
  return "file-question";
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function updateAutoSaveTimer(event) {
  const intervalMs = Number(state.session?.config?.autoSaveIntervalMs || 0);
  if (
    !state.session?.writable
    || !state.editor?.dirty
    || !intervalMs
    || state.fillPending
    || state.autoMapGesturePending
  ) {
    clearAutoSaveTimer();
    return;
  }
  if (!["commit", "undo", "redo"].includes(event?.action)) return;
  clearAutoSaveTimer();
  state.autoSaveTimer = window.setTimeout(() => {
    state.autoSaveTimer = null;
    if (state.editor?.dirty && !state.saving) void saveMap();
  }, intervalMs);
}

function clearAutoSaveTimer() {
  window.clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = null;
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}
