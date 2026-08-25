const MAP_ASSET_PRESETS = Object.freeze({
  plant: Object.freeze({
    label: "透明植物",
    background: "transparent",
    directory: "plants",
    placeholder: "例如：与当前森林地图一致的手绘蕨类植物，俯视角，完整轮廓，可复用单体素材",
    description: "透明单体或小型植物簇，保留完整轮廓和地面接触点，适合素材库重复摆放。",
    constraints: "Reusable isolated 2D game plant asset. One compact plant or one coherent small plant cluster, with a clear ground-contact anchor and the complete silhouette visible. Transparent background with real transparent pixels around the artwork. Match one consistent camera perspective, scale, and lighting. No scene, frame, text, UI, labels, characters, tile grid, or baked collision marks.",
    quality: "transparent-border",
  }),
  prop: Object.freeze({
    label: "透明物件",
    background: "transparent",
    directory: "props",
    placeholder: "例如：与当前村庄地图一致的木箱，俯视角，完整轮廓，可复用单体素材",
    description: "透明通用物件，不含场景、角色、文字或碰撞标记。",
    constraints: "Reusable isolated 2D game map prop asset. One complete reusable object with a clear ground-contact anchor and the complete silhouette visible. Transparent background with real transparent pixels around visible artwork. Match one consistent camera perspective, scale, and lighting. No scene, frame, text, UI, labels, characters, tile grid, or baked collision marks.",
    quality: "transparent-border",
  }),
  tileset: Object.freeze({
    label: "瓦片集图集",
    background: "transparent",
    directory: "tilesets",
    placeholder: "例如：32 像素网格的苔藓地牢瓦片集，包含地面、边缘、内外角，统一俯视光照",
    description: "规则网格图集；发布后仍需设置瓦片尺寸并建立或关联 TSJ。",
    constraints: "Reusable 2D game tileset atlas asset. Transparent background with real transparent pixels around visible tile artwork. Grid-aligned tile cells with consistent scale, camera perspective, lighting, and exact cell boundaries. Keep terrain tiles, edges, corners, and declared variants in predictable cells. No full scene, text, UI, labels, characters, props crossing cell boundaries, or baked collision marks.",
    quality: "transparent",
  }),
  terrain: Object.freeze({
    label: "无缝地块",
    background: "opaque",
    directory: "terrain",
    placeholder: "例如：俯视手绘苔藓草地，无物件，四边连续，可横纵重复铺设",
    description: "不透明满画布地块；系统会检查透明像素和横纵两组接缝。",
    constraints: "Reusable seamless 2D game terrain texture. Opaque, full-bleed artwork with no gutters or transparent gaps. The full output canvas is a periodic tiling target on both horizontal and vertical axes: opposite outer edges must join without a visible seam when repeated. Consistent top-down scale and lighting. No scene, frame, text, UI, labels, characters, props, or baked collision marks.",
    quality: "periodic-opaque",
  }),
  background: Object.freeze({
    label: "完整背景",
    background: "opaque",
    directory: "backgrounds",
    placeholder: "例如：固定战斗场景的完整森林空地背景，横向构图，无角色、文字或界面",
    description: "不透明满画布背景，用于图片层或固定场景；碰撞和交互对象仍需单独建立。",
    constraints: "Complete opaque full-bleed 2D game scene background for a Tiled image layer, fixed battle scene, menu scene, or visual reference. Fill the entire canvas with coherent artwork and preserve one camera perspective and lighting setup. No transparent margins, frame, text, UI, labels, player characters, enemies, or baked collision marks. This image is visual artwork only; collision and interactive runtime objects remain separate map data.",
    quality: "opaque",
  }),
});
const ASSET_KINDS = new Set(Object.keys(MAP_ASSET_PRESETS));
const PUBLISH_KINDS = new Set([...ASSET_KINDS, "crop", "edit", "outpaint"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "publishing"]);
const IMAGE_OPERATIONS = new Set(["generate", "edit", "outpaint"]);
const OUTPAINT_POLICIES = new Set(["exact", "seamless"]);
const OUTPAINT_ALIGNMENT_POLICIES = new Set(["reject", "pad-and-crop", "rescale-and-crop"]);
const MAP_ASSET_QUALITY_SCHEMA = "map-image-quality-target-v1";
const MAP_IMAGE_PUBLICATION_MODES = new Set(["image", "tileset-atlas", "composite-map"]);

export function normalizeMapImageCandidateConfig(value) {
  const source = record(value);
  const capabilities = record(source.capabilities);
  const worker = record(source.worker);
  const defaults = record(capabilities.defaults);
  const limits = record(capabilities.limits);
  const sizeLimits = record(limits.size);
  const options = record(capabilities.options);
  const operationCapabilities = record(capabilities.operationCapabilities);
  const generate = record(operationCapabilities.generate);
  const operations = stringList(capabilities.operations);
  const sizes = unique([
    ...stringList(generate.sizes),
    ...stringList(options.sizes),
    ...(validSize(defaults.size) ? [String(defaults.size)] : []),
  ]).filter(validSize);
  const qualities = stringList(options.qualities);
  const formats = stringList(options.outputFormats);
  const backgrounds = stringList(options.backgrounds);
  const moderations = stringList(options.moderations);
  const ready = capabilities.enabled === true
    && operations.includes("generate")
    && worker.enabled === true
    && worker.accepting === true
    && formats.includes("png")
    && backgrounds.some((background) => background === "transparent" || background === "opaque")
    && sizes.length > 0;
  return Object.freeze({
    ready,
    reason: candidateUnavailableReason({ capabilities, worker, operations, formats, backgrounds, sizes }),
    worker: Object.freeze({
      enabled: worker.enabled === true,
      accepting: worker.accepting === true,
      preset: clean(worker.preset),
    }),
    capabilities: Object.freeze({
      enabled: capabilities.enabled === true,
      operations: Object.freeze(operations),
      outputFormats: Object.freeze(formats),
      backgrounds: Object.freeze(backgrounds),
      operationCapabilities: Object.freeze(Object.fromEntries(
        [...IMAGE_OPERATIONS].map((operation) => {
          const entry = record(operationCapabilities[operation]);
          return [operation, Object.freeze({
            enabled: operations.includes(operation),
            sizes: Object.freeze(unique([
              ...stringList(entry.sizes),
              ...stringList(operation === "generate" ? options.sizes : []),
            ]).filter(validSize)),
            customSize: entry.customSize === true,
          })];
        }),
      )),
      sizes: Object.freeze(sizes),
      customSize: generate.customSize === true,
      qualities: Object.freeze(qualities),
      maxPromptCharacters: positiveInteger(limits.maxPromptCharacters, 4_000),
      sizeLimits: Object.freeze({
        maxWidth: positiveInteger(sizeLimits.maxWidth, 3_840),
        maxHeight: positiveInteger(sizeLimits.maxHeight, 3_840),
        dimensionMultiple: positiveInteger(sizeLimits.dimensionMultiple, 1),
        maxAspectRatio: positiveNumber(sizeLimits.maxAspectRatio, 3),
        minPixels: positiveInteger(sizeLimits.minPixels, 1),
        maxPixels: positiveInteger(sizeLimits.maxPixels, 8_294_400),
      }),
      defaultSize: sizes.includes(defaults.size) ? defaults.size : sizes[0] || "",
      defaultQuality: qualities.includes(defaults.quality) ? defaults.quality : qualities[0] || "",
      defaultModeration: moderations.includes(defaults.moderation) ? defaults.moderation : moderations[0] || "",
      strictMask: record(capabilities.features).strictMask === true,
      seamlessOutpaint: record(capabilities.features).seamlessOutpaint === true,
      localCrop: record(capabilities.features).localCrop === true,
    }),
  });
}

export function mapImageAssetPreset(kind) {
  const preset = MAP_ASSET_PRESETS[clean(kind)];
  if (!preset) throw new Error("地图素材类型无效");
  return preset;
}

export function mapImageOperationAvailability(config, operation, { kind = "prop" } = {}) {
  const selectedOperation = clean(operation);
  if (!IMAGE_OPERATIONS.has(selectedOperation)) {
    return Object.freeze({ enabled: false, reason: "图片操作无效" });
  }
  if (!config?.capabilities?.enabled) {
    return Object.freeze({ enabled: false, reason: "当前账号尚未配置图片供应商" });
  }
  if (!config.capabilities.operations.includes(selectedOperation)
    || config.capabilities.operationCapabilities?.[selectedOperation]?.enabled !== true) {
    const label = selectedOperation === "generate" ? "生成" : selectedOperation === "edit" ? "编辑" : "扩图";
    return Object.freeze({ enabled: false, reason: `当前图片预设未启用${label}` });
  }
  if (!config.worker?.enabled) {
    return Object.freeze({ enabled: false, reason: "图片 Worker 已由管理员关闭" });
  }
  if (!config.worker.accepting) {
    return Object.freeze({ enabled: false, reason: "管理员已暂停接收新的图片任务" });
  }
  if (!config.capabilities.outputFormats.includes("png")) {
    return Object.freeze({ enabled: false, reason: "当前图片预设不能输出 PNG" });
  }
  const preset = selectedOperation === "generate" ? MAP_ASSET_PRESETS[clean(kind)] : null;
  if (selectedOperation === "generate" && !preset) {
    return Object.freeze({ enabled: false, reason: "地图素材类型无效" });
  }
  const background = preset?.background || "transparent";
  if (!config.capabilities.backgrounds.includes(background)) {
    const label = background === "opaque" ? "不透明" : "透明";
    return Object.freeze({ enabled: false, reason: `当前图片预设不能输出${label} PNG` });
  }
  const capability = config.capabilities.operationCapabilities?.[selectedOperation];
  if (!capability?.customSize && !capability?.sizes?.length) {
    return Object.freeze({ enabled: false, reason: "当前图片预设没有此操作可用的尺寸" });
  }
  return Object.freeze({ enabled: true, reason: "" });
}

/**
 * Build an edit candidate request from paths that have already been selected
 * and granted by the map-session resource catalog.  The allow-list is
 * deliberately mandatory so the dialog cannot turn free-text paths into a
 * provider input authority bypass.
 */
export function buildMapImageEditRequest(values, config, {
  authorizedSourcePaths = [],
  authorizedMaskPaths = [],
  temporaryInputCount = null,
  hasTemporaryMask = false,
} = {}) {
  assertOperationReady(config, "edit");
  const prompt = candidatePrompt(values?.prompt, config);
  const temporary = temporaryInputCount != null;
  const sourcePaths = temporary
    ? []
    : authorizedPaths(values?.sourcePaths, authorizedSourcePaths, "编辑源图");
  const inputCount = temporary ? boundedInteger(temporaryInputCount, 0, 1, 16) : sourcePaths.length;
  if (!inputCount) throw new Error("编辑至少需要一张已授权源图或当前窗口临时输入");
  const maskPath = temporary
    ? ""
    : optionalAuthorizedPath(values?.maskPath, authorizedMaskPaths, "编辑蒙版");
  const hasMask = temporary ? hasTemporaryMask === true : Boolean(maskPath);
  const maskMode = clean(values?.maskMode) || (config.capabilities.strictMask ? "strict" : "soft");
  if (!new Set(["strict", "soft"]).has(maskMode)) throw new Error("蒙版模式无效");
  if (maskMode === "strict" && !config.capabilities.strictMask) throw new Error("当前图片预设不支持严格蒙版");
  if (maskMode === "strict" && !hasMask) throw new Error("严格蒙版编辑必须显式选择蒙版");
  return compact({
    operation: "edit",
    prompt,
    sourcePaths: temporary ? undefined : sourcePaths,
    maskPath: temporary ? undefined : maskPath,
    maskMode: hasMask ? maskMode : undefined,
    maskFeather: hasMask && maskMode === "strict" ? boundedInteger(values?.maskFeather, 0, 0, 128) : undefined,
    size: operationSize(values?.size, config, "edit"),
    quality: operationQuality(values?.quality, config),
    outputFormat: "png",
    background: "transparent",
    moderation: config.capabilities.defaultModeration,
    n: 1,
    stream: false,
    partialImages: 0,
  });
}

/** Build an outpaint candidate request for one authorized source image. */
export function buildMapImageOutpaintRequest(values, config, {
  authorizedSourcePaths = [],
  temporaryInputCount = null,
} = {}) {
  assertOperationReady(config, "outpaint");
  const prompt = candidatePrompt(values?.prompt, config);
  const temporary = temporaryInputCount != null;
  const sourcePaths = temporary
    ? []
    : authorizedPaths(values?.sourcePaths, authorizedSourcePaths, "扩图源图");
  const inputCount = temporary ? boundedInteger(temporaryInputCount, 0, 1, 16) : sourcePaths.length;
  if (inputCount !== 1) throw new Error("扩图只能使用一张已授权源图或当前窗口临时输入");
  const outpaint = {
    top: boundedInteger(values?.outpaint?.top, 0, 0, 3840),
    right: boundedInteger(values?.outpaint?.right, 0, 0, 3840),
    bottom: boundedInteger(values?.outpaint?.bottom, 0, 0, 3840),
    left: boundedInteger(values?.outpaint?.left, 0, 0, 3840),
  };
  if (!Object.values(outpaint).some((value) => value > 0)) throw new Error("扩图至少需要一个大于 0 的方向");
  const sourceCrop = normalizeSourceCrop(values?.sourceCrop);
  if (sourceCrop && !temporary) throw new Error("裁剪预处理必须使用当前窗口临时源图");
  const preserveSource = clean(values?.preserveSource) || "exact";
  if (!OUTPAINT_POLICIES.has(preserveSource)) throw new Error("原图保留模式无效");
  if (preserveSource === "seamless" && !config.capabilities.seamlessOutpaint) {
    throw new Error("当前图片预设不支持无缝扩图模式");
  }
  const alignmentPolicy = clean(values?.alignmentPolicy) || "reject";
  if (!OUTPAINT_ALIGNMENT_POLICIES.has(alignmentPolicy)) throw new Error("扩图尺寸对齐策略无效");
  return compact({
    operation: "outpaint",
    prompt,
    sourcePaths: temporary ? undefined : sourcePaths,
    sourceCrop,
    outpaint,
    preserveSource,
    blendMargin: preserveSource === "seamless" ? boundedInteger(values?.blendMargin, 64, 1, 512) : undefined,
    alignmentPolicy,
    quality: operationQuality(values?.quality, config),
    outputFormat: "png",
    background: "transparent",
    moderation: config.capabilities.defaultModeration,
    n: 1,
    stream: false,
    partialImages: 0,
  });
}

/** Build a provider-free crop candidate from one current-window temporary PNG. */
export function buildMapImageCropRequest(values, { temporaryInputCount = null } = {}) {
  const inputCount = boundedInteger(temporaryInputCount, 0, 0, 1);
  if (inputCount !== 1) throw new Error("纯裁剪必须使用一张当前窗口临时源图");
  const sourceSize = normalizeImageDimensions(values?.sourceSize, "源图尺寸无效");
  const sourceCrop = normalizeSourceCrop(values?.sourceCrop);
  if (!sourceCrop) throw new Error("纯裁剪至少需要裁掉一侧");
  const width = sourceSize.width - sourceCrop.left - sourceCrop.right;
  const height = sourceSize.height - sourceCrop.top - sourceCrop.bottom;
  if (width < 1 || height < 1) throw new Error("裁剪后至少需要保留 1×1 像素");
  return Object.freeze({
    operation: "crop",
    sourceSize,
    sourceCrop,
    outputFormat: "png",
    n: 1,
  });
}

function normalizeSourceCrop(value) {
  if (value == null) return undefined;
  const crop = Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [
    side,
    boundedInteger(value?.[side], 0, 0, 3_840),
  ]));
  return Object.values(crop).some(Boolean) ? crop : undefined;
}

function normalizeImageDimensions(value, message) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new Error(message);
  }
  return Object.freeze({ width, height });
}

export function buildMapImageCandidateRequest(values, config) {
  const kind = clean(values?.kind);
  const preset = mapImageAssetPreset(kind);
  const availability = mapImageOperationAvailability(config, "generate", { kind });
  if (!availability.enabled) throw new Error(availability.reason || "地图内置生图当前不可用");
  const userPrompt = clean(values?.prompt);
  if (!userPrompt) throw new Error("请输入素材描述");
  if (userPrompt.length > config.capabilities.maxPromptCharacters) {
    throw new Error(`素材描述不能超过 ${config.capabilities.maxPromptCharacters} 个字符`);
  }
  const size = clean(values?.size);
  if (!config.capabilities.sizes.includes(size) && !(config.capabilities.customSize && validSize(size))) {
    throw new Error("图片尺寸不在当前管理员配置允许的范围内");
  }
  const quality = clean(values?.quality);
  if (quality && !config.capabilities.qualities.includes(quality)) throw new Error("图片质量选项无效");
  const prompt = `${userPrompt}\n\n${preset.constraints}`;
  if (prompt.length > config.capabilities.maxPromptCharacters) {
    throw new Error(`素材描述加上地图资产约束后不能超过 ${config.capabilities.maxPromptCharacters} 个字符`);
  }
  return compact({
    operation: "generate",
    assetKind: kind,
    qualityTarget: preset.quality === "transparent" || preset.quality === "transparent-border"
      ? {
          schemaVersion: MAP_ASSET_QUALITY_SCHEMA,
          alpha: "required",
        }
      : preset.quality === "periodic-opaque" ? {
          schemaVersion: MAP_ASSET_QUALITY_SCHEMA,
          tiling: { mode: "periodic", axes: ["horizontal", "vertical"] },
        } : {
          schemaVersion: MAP_ASSET_QUALITY_SCHEMA,
          alpha: "opaque",
        },
    prompt,
    size,
    quality,
    outputFormat: "png",
    background: preset.background,
    moderation: config.capabilities.defaultModeration,
    n: 1,
    stream: false,
    partialImages: 0,
  });
}

export function normalizeMapImagePublishPath(value, format = "png") {
  const destination = clean(value);
  const parts = destination.split("/");
  if (
    !destination
    || destination.startsWith("/")
    || destination.includes("\\")
    || parts.some((part) => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(destination)
  ) throw new Error("发布路径必须是安全的工程相对文件路径");
  const expected = String(format || "png").toLowerCase() === "jpeg" ? new Set(["jpg", "jpeg"]) : new Set([String(format || "png").toLowerCase()]);
  const extension = destination.split(".").at(-1)?.toLowerCase();
  if (!expected.has(extension)) throw new Error(`发布路径扩展名必须匹配 ${format || "png"}`);
  return destination;
}

export function suggestedMapImageCompanionPath(imagePath, mode) {
  const publicationMode = clean(mode);
  if (!new Set(["tileset-atlas", "composite-map"]).has(publicationMode)) {
    throw new Error("附属素材类型无效");
  }
  const normalized = normalizeMapImagePublishPath(imagePath, pathFormat(imagePath));
  return normalized.replace(/\.[^.]+$/u, publicationMode === "tileset-atlas" ? ".tsj" : ".tmj");
}

export function buildMapImagePublicationRequest({
  file,
  imagePath,
  mode = "image",
  companionPath = "",
  name = "",
  tileWidth,
  tileHeight,
  margin = 0,
  spacing = 0,
} = {}) {
  const index = Number(file?.index);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("候选图编号无效");
  const publicationMode = clean(mode) || "image";
  if (!MAP_IMAGE_PUBLICATION_MODES.has(publicationMode)) throw new Error("发布形式无效");
  const destination = normalizeMapImagePublishPath(imagePath, file?.format || "png");
  const result = {
    destinations: [{ index, path: destination }],
    companions: [],
  };
  if (publicationMode === "image") return result;
  const companionExtension = publicationMode === "tileset-atlas" ? ".tsj" : ".tmj";
  const normalizedCompanionPath = normalizeCompanionPath(companionPath, companionExtension);
  if (normalizedCompanionPath === destination) throw new Error("附属素材路径不能与图片路径相同");
  const normalizedName = clean(name) || destination.split("/").at(-1)?.replace(/\.[^.]+$/u, "") || "AI 素材";
  if (normalizedName.length > 255 || /[\u0000-\u001f\u007f]/u.test(normalizedName)) {
    throw new Error("附属素材名称无效");
  }
  const companion = {
    type: publicationMode,
    sourceIndex: index,
    path: normalizedCompanionPath,
    name: normalizedName,
    tileWidth: boundedInteger(tileWidth, 0, 1, 16_384),
    tileHeight: boundedInteger(tileHeight, 0, 1, 16_384),
  };
  if (publicationMode === "tileset-atlas") {
    companion.margin = boundedInteger(margin, 0, 0, 16_384);
    companion.spacing = boundedInteger(spacing, 0, 0, 16_384);
  }
  result.companions.push(companion);
  return result;
}

export function suggestedMapImagePublishPath(kind, now = new Date()) {
  const normalizedKind = clean(kind);
  if (!PUBLISH_KINDS.has(normalizedKind)) throw new Error("地图素材类型无效");
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  const directory = MAP_ASSET_PRESETS[normalizedKind]?.directory
    || (normalizedKind === "crop" ? "crops" : normalizedKind === "edit" ? "edits" : "outpaint");
  return `assets/generated/${directory}/${normalizedKind}-${stamp}.png`;
}

export function mapImageJobIsActive(job) {
  return ACTIVE_STATUSES.has(String(job?.status || ""));
}

function candidateUnavailableReason({ capabilities, worker, operations, formats, backgrounds, sizes }) {
  if (capabilities.enabled !== true) return "当前账号尚未配置图片供应商";
  if (!operations.includes("generate")) return "当前图片预设未启用文本生成";
  if (worker.enabled !== true) return "图片 Worker 已由管理员关闭";
  if (worker.accepting !== true) return "管理员已暂停接收新的图片任务";
  if (!formats.includes("png")) return "当前图片预设不能输出 PNG";
  if (!backgrounds.some((background) => background === "transparent" || background === "opaque")) {
    return "当前图片预设不支持地图素材所需的透明或不透明背景";
  }
  if (!sizes.length) return "当前图片预设没有可用尺寸";
  return "";
}

function assertOperationReady(config, operation) {
  const availability = mapImageOperationAvailability(config, operation);
  if (!availability.enabled) throw new Error(availability.reason || "地图内置生图当前不可用");
}

function candidatePrompt(value, config) {
  const prompt = clean(value);
  if (!prompt) throw new Error("请输入素材描述");
  if (prompt.length > config.capabilities.maxPromptCharacters) {
    throw new Error(`素材描述不能超过 ${config.capabilities.maxPromptCharacters} 个字符`);
  }
  return prompt;
}

function operationSize(value, config, operation) {
  const size = clean(value) || config.capabilities.operationCapabilities[operation]?.sizes?.[0] || "";
  const capability = config.capabilities.operationCapabilities[operation];
  if (!capability?.customSize && !capability?.sizes?.includes(size)) {
    throw new Error("图片尺寸不在当前管理员配置允许的范围内");
  }
  if (capability.customSize && !validSize(size)) throw new Error("图片尺寸格式无效");
  return size;
}

function operationQuality(value, config) {
  const quality = clean(value);
  if (quality && !config.capabilities.qualities.includes(quality)) throw new Error("图片质量选项无效");
  return quality;
}

function authorizedPaths(value, allowed, label) {
  const requested = Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
  if (!requested.length) return [];
  const allow = new Set((Array.isArray(allowed) ? allowed : []).map(clean).filter(Boolean));
  for (const sourcePath of requested) {
    if (!/\.(?:png|jpe?g|webp)$/iu.test(sourcePath)) throw new Error(`${label}必须是 PNG、JPEG 或 WebP 图片`);
    normalizeMapImagePublishPath(sourcePath, pathFormat(sourcePath));
    if (!allow.has(sourcePath)) throw new Error(`${label}必须来自当前窗口已授权的工程图片`);
  }
  return [...new Set(requested)];
}

function optionalAuthorizedPath(value, allowed, label) {
  const source = clean(value);
  if (!source) return undefined;
  const values = authorizedPaths([source], allowed, label);
  return values[0];
}

function pathFormat(value) {
  const extension = String(value || "").split(".").at(-1)?.toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? extension : extension || "png";
}

function normalizeCompanionPath(value, extension) {
  const destination = clean(value);
  const parts = destination.split("/");
  if (
    !destination
    || destination.startsWith("/")
    || destination.includes("\\")
    || /^[a-z][a-z0-9+.-]*:/iu.test(destination)
    || parts.some((part) => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f:*?"<>|]/u.test(destination)
    || !destination.toLowerCase().endsWith(extension)
  ) throw new Error(`附属素材路径必须是安全的工程相对 ${extension} 文件路径`);
  return destination;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`数值必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return number;
}

function validSize(value) {
  return /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(String(value || ""));
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function stringList(value) {
  return Array.isArray(value) ? unique(value.map(clean).filter(Boolean)) : [];
}

function unique(values) {
  return [...new Set(values)];
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && entry != null));
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
