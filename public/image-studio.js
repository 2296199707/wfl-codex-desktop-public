import { imageContextPolicy } from "./image-context-policy.js?v=0.44.65";

const IMAGE_STUDIO_STYLE_ID = "imageStudioStyles";
const IMAGE_STUDIO_NONCE_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_PARTIAL_PATH_PATTERN = /^\/api\/images\/v2\/partial\/[A-Za-z0-9_-]{43}$/;

let studioInstance = null;

export async function openImageStudio(options = {}) {
  // Validate before creating or reusing the singleton. Every embedding surface
  // must opt into an explicit context, including character-editor.
  imageContextPolicy(options.context);
  if (!studioInstance) studioInstance = createImageStudio(options);
  studioInstance.updateOptions(options);
  await studioInstance.open();
  return studioInstance;
}

export function normalizeImageStudioCapabilities(payload) {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const features = objectValue(value.features);
  const defaults = objectValue(value.defaults);
  const limits = objectValue(value.limits);
  const options = objectValue(value.options);
  const operations = stringList(value.operations, ["generate", "edit", "outpaint"]);
  const operationCapabilities = normalizeStudioOperationCapabilities(
    value.operationCapabilities,
    operations,
    stringList(limits.fixedSizes),
    Object.keys(objectValue(limits.size)).length > 0,
  );
  return {
    enabled: value.enabled === true,
    presetId: cleanString(value.presetId),
    operations,
    features: {
      mask: features.mask === true,
      multiInput: features.multiInput === true,
      streaming: features.streaming === true,
      inputFidelity: features.inputFidelity === true || stringList(options.inputFidelities).length > 0,
      strictMask: features.strictMask === true,
      seamlessOutpaint: features.seamlessOutpaint === true,
    },
    operationCapabilities,
    defaults: {
      size: cleanString(defaults.size) || "auto",
      quality: cleanString(defaults.quality),
      outputFormat: cleanString(defaults.outputFormat),
      outputCompression: boundedInteger(defaults.outputCompression, 0, 100, 100),
      background: cleanString(defaults.background),
      moderation: cleanString(defaults.moderation),
      inputFidelity: cleanString(defaults.inputFidelity),
      n: boundedInteger(defaults.n, 1, 100, 1),
      partialImages: boundedInteger(defaults.partialImages, 0, 100, 0),
    },
    limits: {
      maxPromptCharacters: boundedInteger(limits.maxPromptCharacters, 1, 100_000, 4_000),
      maxInputImages: boundedInteger(limits.maxInputImages, 0, 100, 0),
      maxOutputs: boundedInteger(limits.maxOutputs, 1, 100, 1),
      maxPartialImages: boundedInteger(limits.maxPartialImages, 0, 100, 0),
      fixedSizes: stringList(limits.fixedSizes),
      size: objectValue(limits.size),
    },
    options: {
      sizes: stringList(options.sizes),
      qualities: stringList(options.qualities),
      outputFormats: stringList(options.outputFormats),
      backgrounds: stringList(options.backgrounds),
      moderations: stringList(options.moderations),
      inputFidelities: stringList(options.inputFidelities),
    },
  };
}

export function buildImageExecutePayload(values, capabilities) {
  const operation = cleanString(values.operation);
  if (!capabilities.enabled || !capabilities.operations.includes(operation)) {
    throw new Error("当前图片预设不支持这个操作");
  }
  const project = cleanString(values.project);
  const prompt = cleanString(values.prompt);
  if (!project) throw new Error("请先选择工程");
  if (!prompt) throw new Error("请输入图片描述");
  if (prompt.length > capabilities.limits.maxPromptCharacters) {
    throw new Error(`图片描述不能超过 ${capabilities.limits.maxPromptCharacters} 个字符`);
  }

  const sourcePaths = stringList(values.sourcePaths);
  for (const path of sourcePaths) assertProjectRelativePath(path, "源图片路径");
  if (operation !== "generate" && !sourcePaths.length) throw new Error("编辑或扩图需要源图片路径");
  if (operation === "outpaint" && sourcePaths.length !== 1) throw new Error("扩图只能使用一张源图片");
  if (!capabilities.features.multiInput && sourcePaths.length > 1) throw new Error("当前图片预设只支持一张源图片");
  if (sourcePaths.length > capabilities.limits.maxInputImages) throw new Error("源图片数量超过管理员设置的上限");

  const maskPath = cleanString(values.maskPath);
  if (maskPath) {
    if (operation !== "edit" || !capabilities.features.mask) throw new Error("当前图片预设不支持蒙版编辑");
    assertProjectRelativePath(maskPath, "蒙版路径");
  }
  const destination = cleanString(values.destination);
  if (destination) assertProjectRelativePath(destination, "输出路径");

  const outputFormat = cleanString(values.outputFormat);
  const payload = {
    windowId: assertImageStudioNonce(values.windowId, "窗口标识"),
    operationId: assertImageStudioNonce(values.operationId, "操作标识"),
    operation,
    project,
    prompt,
    size: cleanString(values.size),
    quality: cleanString(values.quality),
    outputFormat,
    background: cleanString(values.background),
    moderation: cleanString(values.moderation),
    n: requestInteger(values.n, "结果数量", 1, capabilities.limits.maxOutputs),
    stream: values.stream === true && capabilities.features.streaming,
    partialImages: values.stream === true && capabilities.features.streaming
      ? requestInteger(values.partialImages, "流式预览数量", 0, capabilities.limits.maxPartialImages)
      : 0,
  };
  assertSupportedOption(payload.quality, capabilities.options.qualities, "图片质量");
  assertSupportedOption(payload.outputFormat, capabilities.options.outputFormats, "输出格式");
  assertSupportedOption(payload.background, capabilities.options.backgrounds, "背景");
  assertSupportedOption(payload.moderation, capabilities.options.moderations, "审核档位");
  if (new Set(["jpeg", "webp"]).has(outputFormat)) {
    payload.outputCompression = requestInteger(values.outputCompression, "输出压缩质量", 0, 100);
  }
  if (operation === "outpaint") {
    delete payload.size;
  } else {
    if (!payload.size) throw new Error("请选择输出尺寸");
    assertRequestedSize(payload.size, capabilities, operation);
  }
  if (operation !== "generate") payload.sourcePaths = sourcePaths;
  if (maskPath) {
    payload.maskPath = maskPath;
    payload.maskMode = cleanString(values.maskMode) || (capabilities.features.strictMask ? "strict" : "soft");
    if (!["strict", "soft"].includes(payload.maskMode)) throw new Error("蒙版模式无效");
    if (payload.maskMode === "strict") {
      if (!capabilities.features.strictMask) throw new Error("当前图片服务不支持严格蒙版模式");
      payload.maskFeather = requestInteger(values.maskFeather ?? 0, "蒙版羽化像素", 0, 128);
    }
  }
  if (destination) payload.destination = destination;
  const inputFidelity = cleanString(values.inputFidelity);
  if (operation !== "generate" && capabilities.features.inputFidelity && inputFidelity) {
    assertSupportedOption(inputFidelity, capabilities.options.inputFidelities, "输入保真度");
    payload.inputFidelity = inputFidelity;
  }
  if (operation === "outpaint") {
    payload.outpaint = {
      top: requestInteger(values.outpaint?.top, "上方扩展像素", 0, 3840),
      right: requestInteger(values.outpaint?.right, "右侧扩展像素", 0, 3840),
      bottom: requestInteger(values.outpaint?.bottom, "下方扩展像素", 0, 3840),
      left: requestInteger(values.outpaint?.left, "左侧扩展像素", 0, 3840),
    };
    if (!Object.values(payload.outpaint).some((value) => value > 0)) {
      throw new Error("扩图至少需要设置一个大于 0 的边距");
    }
    payload.preserveSource = cleanString(values.preserveSource) || "exact";
    if (!["exact", "seamless"].includes(payload.preserveSource)) throw new Error("原图保留模式无效");
    if (payload.preserveSource === "seamless") {
      if (!capabilities.features.seamlessOutpaint) throw new Error("当前图片服务不支持无缝扩图模式");
      payload.blendMargin = requestInteger(values.blendMargin ?? 64, "无缝扩图过渡宽度", 1, 512);
    }
    payload.alignmentPolicy = cleanString(values.alignmentPolicy) || "reject";
    if (!["reject", "pad-and-crop", "rescale-and-crop"].includes(payload.alignmentPolicy)) {
      throw new Error("扩图尺寸对齐策略无效");
    }
  }
  return removeEmptyOptionalValues(payload);
}

function normalizeStudioOperationCapabilities(value, operations, fixedSizes, hasCustomLimits) {
  const source = objectValue(value);
  const fallback = { customSize: fixedSizes.length === 0 && hasCustomLimits, sizes: fixedSizes };
  return Object.fromEntries(["generate", "edit", "outpaint"].map((operation) => {
    const entry = objectValue(source[operation]);
    return [operation, {
      customSize: operations.includes(operation)
        && (Object.hasOwn(entry, "customSize") ? entry.customSize === true : fallback.customSize),
      sizes: operations.includes(operation)
        ? stringList(Array.isArray(entry.sizes) ? entry.sizes : fallback.sizes).filter(validStudioSize)
        : [],
    }];
  }));
}

function validStudioSize(value) {
  return /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value);
}

export function createImageStudioNonce(cryptoObject = globalThis.crypto) {
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== "function") {
    throw new Error("浏览器无法创建安全的图片窗口标识");
  }
  const bytes = new Uint8Array(32);
  cryptoObject.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function authorizeImagePartialPreviewUrl(value, identity) {
  const windowId = assertImageStudioNonce(identity?.windowId, "窗口标识");
  const operationId = assertImageStudioNonce(identity?.operationId, "操作标识");
  const source = cleanString(value);
  if (!source) return "";
  const origin = globalThis.location?.origin || "https://image-studio.invalid";
  let url;
  try {
    url = new URL(source, `${origin}/`);
  } catch {
    return "";
  }
  if (url.origin !== origin || !IMAGE_PARTIAL_PATH_PATTERN.test(url.pathname)) return "";
  url.search = new URLSearchParams({ windowId, operationId }).toString();
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

export function assertProjectRelativePath(value, label = "路径") {
  const path = cleanString(value);
  if (
    !path
    || path.startsWith("/")
    || path.startsWith("\\")
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").some((part) => part === ".." || part === "." || !part)
  ) throw new Error(`${label}必须是工程内的相对路径`);
  return path;
}

export function formatImageBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function createImageStudio(initialOptions) {
  let options = initialOptions;
  let capabilities = null;
  let requestController = null;
  let busy = false;
  let lastProject = null;
  let initialInputBlocked = false;
  const windowId = createImageStudioNonce();
  ensureStyles(options.assetVersion);
  const root = document.createElement("dialog");
  root.className = "image-studio-dialog";
  root.id = "imageStudioDialog";
  root.innerHTML = studioMarkup();
  document.body.append(root);

  const nodes = Object.fromEntries([...root.querySelectorAll("[id]")].map((node) => [node.id, node]));
  const modeButtons = [...root.querySelectorAll("[data-image-operation]")];
  const busyControls = [...root.querySelectorAll("[data-image-busy-lock]")];

  modeButtons.forEach((button) => button.addEventListener("click", () => {
    initialInputBlocked = false;
    nodes.imageStudioError.textContent = "";
    setOperation(button.dataset.imageOperation);
    setCapabilityLoading(false);
  }));
  nodes.imageStudioCloseButton.addEventListener("click", close);
  nodes.imageStudioCancelButton.addEventListener("click", cancelRequest);
  nodes.imageStudioForm.addEventListener("submit", submit);
  nodes.imageStudioOutputFormat.addEventListener("change", refreshFormatControls);
  nodes.imageStudioMask.addEventListener("input", refreshMaskControls);
  nodes.imageStudioMaskMode.addEventListener("change", refreshMaskControls);
  nodes.imageStudioPreserveSource.addEventListener("change", refreshOutpaintControls);
  nodes.imageStudioCompression.addEventListener("input", () => {
    nodes.imageStudioCompressionValue.textContent = `${nodes.imageStudioCompression.value}%`;
  });
  nodes.imageStudioStream.addEventListener("change", refreshStreamControls);
  root.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  root.addEventListener("close", () => {
    if (busy) cancelRequest();
  });

  function updateOptions(next) {
    options = { ...options, ...next };
  }

  async function open() {
    const project = options.getProject?.() || null;
    lastProject = project?.path || null;
    nodes.imageStudioProject.textContent = project?.path || "未选择工程";
    nodes.imageStudioError.textContent = "";
    nodes.imageStudioStatus.textContent = "正在读取图片能力";
    nodes.imageStudioResults.replaceChildren();
    nodes.imageStudioEmpty.hidden = false;
    if (!root.open) root.showModal();
    refreshIcons(root);
    setCapabilityLoading(true);
    try {
      const response = await fetch("/api/images/capabilities", { cache: "no-store" });
      const data = await readResponseJson(response, "无法读取图片能力");
      capabilities = normalizeImageStudioCapabilities(data);
      applyCapabilities(capabilities);
      applyInitialInput(capabilities);
    } catch (error) {
      capabilities = null;
      nodes.imageStudioStatus.textContent = "图片能力不可用";
      nodes.imageStudioError.textContent = error.message;
    } finally {
      setCapabilityLoading(false);
    }
  }

  function applyInitialInput(value) {
    initialInputBlocked = false;
    nodes.imageStudioSources.value = "";
    nodes.imageStudioPrompt.value = cleanString(options.initialPrompt);
    nodes.imageStudioDestination.value = cleanString(options.initialDestination);
    const initialPath = cleanString(options.initialSourcePath);
    const initialOperation = cleanString(options.initialOperation);
    if (initialOperation && !value.operations.includes(initialOperation)) {
      initialInputBlocked = true;
      nodes.imageStudioError.textContent = "当前图片服务未启用文件编辑能力，请联系管理员启用 edit 后再提交。";
      return;
    }
    if (initialOperation && value.operations.includes(initialOperation)) setOperation(initialOperation);
    if (!initialPath) return;
    try {
      nodes.imageStudioSources.value = assertProjectRelativePath(initialPath, "源图片路径");
    } catch {
      initialInputBlocked = true;
      nodes.imageStudioError.textContent = "文件管理器传入的图片路径无效，请重新选择工程图片。";
    }
  }

  function close() {
    if (busy && !window.confirm("图片任务仍在运行，关闭将取消本次浏览器请求。确定关闭？")) return;
    if (busy) cancelRequest();
    root.close();
  }

  function setCapabilityLoading(loading) {
    nodes.imageStudioSubmitButton.disabled = loading || initialInputBlocked || !capabilities?.enabled || !lastProject;
  }

  function applyCapabilities(value) {
    const supported = new Set(value.operations);
    nodes.imageStudioOperation.closest(".image-studio-controls").querySelector(".image-studio-modes").style.gridTemplateColumns =
      `repeat(${Math.max(1, value.operations.length)}, minmax(0, 1fr))`;
    for (const button of modeButtons) {
      button.disabled = !supported.has(button.dataset.imageOperation);
      button.hidden = !supported.has(button.dataset.imageOperation);
    }
    let operation = root.querySelector("[data-image-operation][aria-pressed='true']")?.dataset.imageOperation;
    if (!supported.has(operation)) operation = value.operations[0] || "generate";
    populateSelect(nodes.imageStudioQuality, value.options.qualities, value.defaults.quality);
    populateSelect(nodes.imageStudioOutputFormat, value.options.outputFormats, value.defaults.outputFormat);
    populateSelect(nodes.imageStudioBackground, value.options.backgrounds, value.defaults.background);
    populateSelect(nodes.imageStudioModeration, value.options.moderations, value.defaults.moderation);
    populateSelect(nodes.imageStudioInputFidelity, value.options.inputFidelities, value.defaults.inputFidelity);
    nodes.imageStudioSize.value = value.defaults.size;
    nodes.imageStudioPrompt.maxLength = value.limits.maxPromptCharacters;
    nodes.imageStudioCompression.value = String(value.defaults.outputCompression);
    nodes.imageStudioCompressionValue.textContent = `${value.defaults.outputCompression}%`;
    nodes.imageStudioCount.max = String(value.limits.maxOutputs);
    nodes.imageStudioCount.value = String(Math.min(value.defaults.n, value.limits.maxOutputs));
    nodes.imageStudioPartialImages.max = String(value.limits.maxPartialImages);
    nodes.imageStudioPartialImages.value = String(Math.min(value.defaults.partialImages, value.limits.maxPartialImages));
    nodes.imageStudioStream.checked = value.features.streaming && value.defaults.partialImages > 0;
    nodes.imageStudioMaskMode.value = value.features.strictMask ? "strict" : "soft";
    nodes.imageStudioMaskFeather.value = "0";
    nodes.imageStudioPreserveSource.value = "exact";
    nodes.imageStudioBlendMargin.value = "64";
    nodes.imageStudioAlignmentPolicy.value = "reject";
    nodes.imageStudioStreamRow.hidden = !value.features.streaming;
    nodes.imageStudioStatus.textContent = value.enabled
      ? `已启用${value.presetId ? ` · ${value.presetId}` : ""}`
      : "管理员未启用图片工作室";
    nodes.imageStudioSubmitButton.disabled = !value.enabled || !lastProject;
    nodes.imageStudioSubmitButton.title = lastProject ? "" : "请先选择工程";
    setOperation(operation);
    refreshFormatControls();
    refreshStreamControls();
  }

  function setOperation(operation) {
    for (const button of modeButtons) {
      const active = button.dataset.imageOperation === operation;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    nodes.imageStudioOperation.value = operation;
    const generate = operation === "generate";
    const edit = operation === "edit";
    nodes.imageStudioSourcesField.hidden = generate;
    nodes.imageStudioMaskField.hidden = !edit || !capabilities?.features.mask;
    nodes.imageStudioOutpaintFields.hidden = operation !== "outpaint";
    nodes.imageStudioInputFidelityField.hidden = generate
      || !capabilities?.features.inputFidelity
      || capabilities.options.inputFidelities.length === 0;
    nodes.imageStudioSizeField.hidden = operation === "outpaint";
    const multipleSources = edit && capabilities?.features.multiInput;
    nodes.imageStudioSources.rows = multipleSources ? 3 : 1;
    nodes.imageStudioSources.placeholder = multipleSources
      ? "assets/source.png\nassets/reference.webp"
      : "assets/source.png";
    nodes.imageStudioSubmitLabel.textContent = operation === "generate" ? "生成" : operation === "edit" ? "编辑" : "扩图";
    refreshSizeControls(operation);
    refreshMaskControls();
    refreshOutpaintControls();
  }

  function refreshSizeControls(operation = nodes.imageStudioOperation.value) {
    if (!capabilities || operation === "outpaint") return;
    const operationCapability = capabilities.operationCapabilities[operation] || { customSize: false, sizes: [] };
    const sizes = operationCapability.customSize
      ? [...new Set([...operationCapability.sizes, ...capabilities.options.sizes])]
      : operationCapability.sizes;
    nodes.imageStudioSizeList.replaceChildren(...sizes.map((size) => optionNode(size)));
    nodes.imageStudioSize.placeholder = operationCapability.customSize ? "例如 1536x1024" : "请选择支持的尺寸";
    if (!operationCapability.customSize && !sizes.includes(nodes.imageStudioSize.value)) {
      nodes.imageStudioSize.value = sizes.includes(capabilities.defaults.size)
        ? capabilities.defaults.size
        : sizes[0] || "";
    }
  }

  function refreshMaskControls() {
    const edit = nodes.imageStudioOperation.value === "edit";
    const hasMask = edit && capabilities?.features.mask && Boolean(nodes.imageStudioMask.value.trim());
    nodes.imageStudioMaskControls.hidden = !hasMask;
    nodes.imageStudioMaskMode.disabled = !hasMask;
    if (!capabilities?.features.strictMask && nodes.imageStudioMaskMode.value === "strict") {
      nodes.imageStudioMaskMode.value = "soft";
    }
    const strict = hasMask && nodes.imageStudioMaskMode.value === "strict";
    nodes.imageStudioMaskFeatherField.hidden = !strict;
    nodes.imageStudioMaskFeather.disabled = !strict;
  }

  function refreshOutpaintControls() {
    const outpaint = nodes.imageStudioOperation.value === "outpaint";
    nodes.imageStudioOutpaintOptions.hidden = !outpaint;
    const seamless = outpaint && nodes.imageStudioPreserveSource.value === "seamless";
    nodes.imageStudioBlendMarginField.hidden = !seamless;
    nodes.imageStudioBlendMargin.disabled = !seamless;
  }

  function refreshFormatControls() {
    const format = nodes.imageStudioOutputFormat.value;
    const compressible = format === "jpeg" || format === "webp";
    nodes.imageStudioCompressionField.hidden = !compressible;
    nodes.imageStudioCompression.disabled = !compressible;
  }

  function refreshStreamControls() {
    const enabled = nodes.imageStudioStream.checked && capabilities?.features.streaming;
    nodes.imageStudioPartialField.hidden = !enabled;
    nodes.imageStudioPartialImages.disabled = !enabled;
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || !capabilities) return;
    nodes.imageStudioError.textContent = "";
    nodes.imageStudioResults.replaceChildren();
    nodes.imageStudioEmpty.hidden = true;
    nodes.imageStudioPartialStrip.replaceChildren();
    nodes.imageStudioPartialStrip.hidden = true;
    let payload;
    const operationId = createImageStudioNonce();
    try {
      payload = buildImageExecutePayload({ ...readFormValues(), windowId, operationId }, capabilities);
    } catch (error) {
      nodes.imageStudioError.textContent = error.message;
      return;
    }
    requestController = new AbortController();
    setBusy(true, payload.stream ? "正在等待流式预览" : "正在处理图片");
    try {
      const response = await fetch("/api/images/v2/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codex-Desktop-Action": "image-execute",
          ...(payload.stream ? { Accept: "text/event-stream" } : {}),
        },
        body: JSON.stringify(payload),
        signal: requestController.signal,
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() || "";
      let completed;
      if (response.ok && contentType.includes("text/event-stream")) {
        completed = await readImageEventStream(response, (event) => handleStreamEvent(event, operationId));
      } else {
        completed = await readResponseJson(response, "图片任务失败");
      }
      renderCompleted(completed, payload);
    } catch (error) {
      if (error.name === "AbortError") {
        nodes.imageStudioStatus.textContent = "已取消本次请求";
      } else {
        nodes.imageStudioError.textContent = structuredErrorMessage(error);
        nodes.imageStudioStatus.textContent = "图片任务失败";
      }
    } finally {
      requestController = null;
      setBusy(false);
    }
  }

  function readFormValues() {
    return {
      operation: nodes.imageStudioOperation.value,
      project: lastProject,
      prompt: nodes.imageStudioPrompt.value,
      sourcePaths: nodes.imageStudioSources.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      maskPath: nodes.imageStudioMask.value,
      maskMode: nodes.imageStudioMaskMode.value,
      maskFeather: nodes.imageStudioMaskFeather.value,
      destination: nodes.imageStudioDestination.value,
      outpaint: {
        top: nodes.imageStudioOutpaintTop.value,
        right: nodes.imageStudioOutpaintRight.value,
        bottom: nodes.imageStudioOutpaintBottom.value,
        left: nodes.imageStudioOutpaintLeft.value,
      },
      preserveSource: nodes.imageStudioPreserveSource.value,
      blendMargin: nodes.imageStudioBlendMargin.value,
      alignmentPolicy: nodes.imageStudioAlignmentPolicy.value,
      size: nodes.imageStudioSize.value,
      quality: nodes.imageStudioQuality.value,
      outputFormat: nodes.imageStudioOutputFormat.value,
      outputCompression: nodes.imageStudioCompression.value,
      background: nodes.imageStudioBackground.value,
      moderation: nodes.imageStudioModeration.value,
      inputFidelity: nodes.imageStudioInputFidelity.value,
      n: nodes.imageStudioCount.value,
      stream: nodes.imageStudioStream.checked,
      partialImages: nodes.imageStudioPartialImages.value,
    };
  }

  function handleStreamEvent(event, operationId) {
    if (event.type === "partial") renderPartial(event, operationId);
    if (event.type === "error") throw apiPayloadError(event.error || event);
    if (event.type === "completed") return event;
    return null;
  }

  function renderPartial(event, operationId) {
    const authorizedUrl = authorizeImagePartialPreviewUrl(event.url, { windowId, operationId });
    const source = authorizedUrl ? imageValueSource({ url: authorizedUrl }, lastProject) : "";
    if (!source) return;
    nodes.imageStudioPartialStrip.hidden = false;
    let item = nodes.imageStudioPartialStrip.querySelector(`[data-partial-index="${Number(event.index) || 0}"]`);
    if (!item) {
      item = document.createElement("figure");
      item.dataset.partialIndex = String(Number(event.index) || 0);
      item.innerHTML = "<img alt=\"流式预览\" /><figcaption></figcaption>";
      nodes.imageStudioPartialStrip.append(item);
    }
    item.querySelector("img").src = source;
    item.querySelector("figcaption").textContent = `预览 ${Number(event.index) + 1 || 1}`;
    nodes.imageStudioStatus.textContent = "已收到流式预览，任务仍在运行";
  }

  function renderCompleted(result, requested) {
    const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
    if (!outputs.length) throw new Error("服务器没有返回可用的图片文件");
    nodes.imageStudioResults.replaceChildren();
    outputs.forEach((output, index) => nodes.imageStudioResults.append(outputCard(output, index, result.requested || requested)));
    const sourceStatus = typeof result.sourceConsumed === "boolean"
      ? ` · 源图${result.sourceConsumed ? "已读取" : "未读取"}`
      : "";
    nodes.imageStudioStatus.textContent = `${outputs.length} 张图片已保存${sourceStatus}${result.providerRequestId ? ` · ${result.providerRequestId}` : ""}`;
    nodes.imageStudioUsage.textContent = usageSummary(result.usage);
    nodes.imageStudioUsage.hidden = !nodes.imageStudioUsage.textContent;
    refreshIcons(nodes.imageStudioResults);
    options.onCompleted?.(result);
  }

  function outputCard(output, index, requested) {
    const policy = imageContextPolicy(options.context);
    const article = document.createElement("article");
    article.className = "image-studio-result-card";
    article.dataset.imageContext = policy.scope;
    const outputPath = cleanString(output.relativePath) || cleanString(output.path);
    const source = output.url || output.previewUrl
      ? imageValueSource({ url: output.url || output.previewUrl }, lastProject)
      : imageValueSource({ path: outputPath }, lastProject);
    const requestedSize = cleanString(requested?.requestedCanvas || requested?.size);
    const providerSize = cleanString(requested?.providerSize);
    const actual = Number.isFinite(Number(output.width)) && Number.isFinite(Number(output.height))
      ? `${output.width} x ${output.height}`
      : "尺寸未知";
    article.innerHTML = `
      <div class="image-studio-result-preview"></div>
      <div class="image-studio-result-body">
        <div><strong></strong><span class="image-studio-result-meta"></span></div>
        <p class="image-studio-result-path"></p>
        <p class="image-studio-result-prompt" hidden></p>
        <div class="image-studio-result-actions">
          <button class="secondary-button" type="button" data-attach><i data-lucide="paperclip"></i><span>加入对话</span></button>
          <a class="secondary-button" target="_blank" rel="noopener" data-open><i data-lucide="external-link"></i><span>查看</span></a>
        </div>
      </div>`;
    const preview = article.querySelector(".image-studio-result-preview");
    if (source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = `图片结果 ${index + 1}`;
      image.loading = "lazy";
      image.decoding = "async";
      preview.append(image);
      article.querySelector("[data-open]").href = source;
    } else {
      preview.textContent = "图片预览不可用";
      article.querySelector("[data-open]").hidden = true;
    }
    article.querySelector("strong").textContent = `结果 ${index + 1}`;
    article.querySelector(".image-studio-result-meta").textContent = [
      requestedSize ? `请求 ${requestedSize}` : null,
      providerSize && providerSize !== requestedSize ? `供应商 ${providerSize}` : null,
      `实际 ${actual}`,
      cleanString(output.format || output.mediaType),
      formatImageBytes(output.size),
    ].filter(Boolean).join(" · ");
    article.querySelector(".image-studio-result-path").textContent = outputPath || "未返回保存路径";
    const revised = cleanString(output.revisedPrompt);
    const revisedNode = article.querySelector(".image-studio-result-prompt");
    revisedNode.hidden = !revised;
    revisedNode.textContent = revised;
    const attach = article.querySelector("[data-attach]");
    attach.querySelector("span").textContent = policy.actionLabel;
    attach.hidden = policy.scope === "visual-review"
      || typeof options.onAttach !== "function"
      || !outputPath;
    attach.addEventListener("click", async () => {
      attach.disabled = true;
      attach.querySelector("span").textContent = "应用中…";
      try {
        await options.onAttach?.(output, policy);
        attach.querySelector("span").textContent = "已加入";
      } catch (error) {
        attach.disabled = false;
        attach.querySelector("span").textContent = "重试";
        options.onAttachError?.(error, output, policy);
      }
    });
    return article;
  }

  function cancelRequest() {
    requestController?.abort();
  }

  function setBusy(nextBusy, message = "") {
    busy = nextBusy;
    root.classList.toggle("busy", busy);
    for (const control of busyControls) control.disabled = busy;
    nodes.imageStudioCancelButton.hidden = !busy;
    nodes.imageStudioSubmitButton.hidden = busy;
    if (message) nodes.imageStudioStatus.textContent = message;
    if (!busy && capabilities) {
      for (const button of modeButtons) {
        button.disabled = !capabilities.operations.includes(button.dataset.imageOperation);
      }
      nodes.imageStudioSubmitButton.disabled = initialInputBlocked || !capabilities.enabled || !lastProject;
      for (const select of [
        nodes.imageStudioQuality,
        nodes.imageStudioOutputFormat,
        nodes.imageStudioBackground,
        nodes.imageStudioModeration,
        nodes.imageStudioInputFidelity,
      ]) select.disabled = select.options.length === 0;
      refreshFormatControls();
      refreshStreamControls();
    }
  }

  return { open, close, updateOptions, get dialog() { return root; } };
}

export async function readImageEventStream(response, onEvent) {
  if (!response.body) throw new Error("服务器没有返回流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new Error("服务器返回了无效的流式图片事件"); }
      const eventName = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      if (!parsed.type && eventName) parsed.type = eventName;
      const result = onEvent(parsed);
      if (result) completed = result;
    }
    if (done) break;
  }
  if (!completed) throw new Error("流式图片任务未返回完成事件");
  return completed;
}

function imageValueSource(value, project) {
  let kind = "unknown";
  if (value && typeof value === "object") {
    if (value.url) kind = "url";
    else if (value.path) kind = "path";
    else kind = "data";
    value = value.url || value.data || value.path;
  }
  const text = cleanString(value);
  if (!text) return "";
  if (text.startsWith("data:image/")) return text;
  if (kind === "url" && text.startsWith("/") && !text.startsWith("//")) return text;
  if (kind === "url" && /^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text, location.origin);
      return url.origin === location.origin ? url.href : "";
    } catch { return ""; }
  }
  const params = new URLSearchParams({ path: text });
  if (project) params.set("project", project);
  return `/api/files/image?${params}`;
}

async function readResponseJson(response, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw apiPayloadError(data?.error || { message: `${fallback}（HTTP ${response.status}）` });
  if (!data) throw new Error(`${fallback}：服务器返回了无效响应`);
  return data;
}

function apiPayloadError(value) {
  const details = value && typeof value === "object" ? value : { message: String(value || "图片任务失败") };
  return Object.assign(new Error(cleanString(details.message) || "图片任务失败"), details);
}

function structuredErrorMessage(error) {
  const suffix = [
    error.code,
    error.operation,
    error.requestedSize && `请求 ${error.requestedSize}`,
    error.providerSize && `供应商 ${error.providerSize}`,
    error.providerRequestId || error.requestId,
  ].filter(Boolean).join(" · ");
  const supported = Array.isArray(error.supportedSizes) && error.supportedSizes.length
    ? ` 支持尺寸：${error.supportedSizes.join(", ")}`
    : "";
  return `${cleanString(error.message) || "图片任务失败"}${supported}${suffix ? `（${suffix}）` : ""}`;
}

function usageSummary(usage) {
  if (!usage || typeof usage !== "object") return "";
  const parts = [];
  if (Number.isFinite(Number(usage.inputTokens))) parts.push(`输入 ${usage.inputTokens}`);
  if (Number.isFinite(Number(usage.inputImageTokens))) parts.push(`输入图像 ${usage.inputImageTokens}`);
  if (Number.isFinite(Number(usage.outputTokens))) parts.push(`输出 ${usage.outputTokens}`);
  if (Number.isFinite(Number(usage.totalTokens))) parts.push(`合计 ${usage.totalTokens} Token`);
  return parts.join(" · ");
}

function ensureStyles(assetVersion) {
  if (document.getElementById(IMAGE_STUDIO_STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = IMAGE_STUDIO_STYLE_ID;
  link.rel = "stylesheet";
  link.href = `/image-studio.css${assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : ""}`;
  document.head.append(link);
}

function populateSelect(select, values, selected) {
  select.replaceChildren(...values.map((value) => optionNode(value)));
  select.closest("label").hidden = values.length === 0;
  select.disabled = values.length === 0;
  if (values.includes(selected)) select.value = selected;
}

function optionNode(value) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = imageOptionLabel(value);
  return option;
}

function imageOptionLabel(value) {
  return ({
    auto: "自动（供应商原生）",
    low: "低",
    medium: "中",
    high: "高",
    png: "PNG",
    jpeg: "JPEG",
    webp: "WebP",
    opaque: "不透明",
    transparent: "透明",
  })[value] || value;
}

function refreshIcons(root) {
  window.lucide?.createIcons?.({ attrs: { "stroke-width": 1.8 }, root });
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertImageStudioNonce(value, label) {
  if (typeof value !== "string" || !IMAGE_STUDIO_NONCE_PATTERN.test(value)) {
    throw new Error(`${label}无效，请重新打开图片工作室`);
  }
  return value;
}

function stringList(value, allowed = null) {
  if (!Array.isArray(value)) return [];
  const result = [...new Set(value.map(cleanString).filter(Boolean))];
  return allowed ? result.filter((entry) => allowed.includes(entry)) : result;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function requestInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function assertSupportedOption(value, options, label) {
  if (!options.length || !options.includes(value)) throw new Error(`当前图片预设不支持这个${label}`);
}

function assertRequestedSize(value, capabilities, operation) {
  const limits = capabilities.limits;
  const operationCapability = capabilities.operationCapabilities[operation] || {
    customSize: limits.fixedSizes.length === 0,
    sizes: limits.fixedSizes,
  };
  if (operationCapability.sizes.includes(value)) return;
  if (!operationCapability.customSize) {
    throw new Error(`当前供应商的 ${operation} 操作不支持这个输出尺寸；支持尺寸：${operationCapability.sizes.join(", ") || "无"}`);
  }
  const rule = limits.size;
  if (value === "auto" && rule.allowAuto === true) return;
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(value);
  if (!match || !Object.keys(rule).length) throw new Error("输出尺寸格式不正确");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const multiple = Number(rule.dimensionMultiple) || 1;
  if (
    width > Number(rule.maxWidth)
    || height > Number(rule.maxHeight)
    || width % multiple !== 0
    || height % multiple !== 0
    || pixels < Number(rule.minPixels)
    || pixels > Number(rule.maxPixels)
    || Math.max(width / height, height / width) > Number(rule.maxAspectRatio)
  ) throw new Error("输出尺寸超出管理员设置的范围");
}

function removeEmptyOptionalValues(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== "" && entry != null));
}

function studioMarkup() {
  return `
    <div class="image-studio-shell">
      <header class="image-studio-header">
        <div class="image-studio-title"><i data-lucide="images"></i><div><strong>图片工作室</strong><span id="imageStudioProject"></span></div></div>
        <button class="icon-button" id="imageStudioCloseButton" type="button" aria-label="关闭图片工作室"><i data-lucide="x"></i></button>
      </header>
      <form class="image-studio-form" id="imageStudioForm">
        <aside class="image-studio-controls">
          <div class="image-studio-modes" role="group" aria-label="图片操作">
            <button type="button" data-image-operation="generate" aria-pressed="true" data-image-busy-lock><i data-lucide="image-plus"></i><span>新建</span></button>
            <button type="button" data-image-operation="edit" aria-pressed="false" data-image-busy-lock><i data-lucide="scan-line"></i><span>编辑</span></button>
            <button type="button" data-image-operation="outpaint" aria-pressed="false" data-image-busy-lock><i data-lucide="expand"></i><span>扩图</span></button>
          </div>
          <input id="imageStudioOperation" type="hidden" value="generate" />
          <label class="image-studio-field image-studio-prompt"><span>图片描述</span><textarea id="imageStudioPrompt" rows="5" maxlength="32000" required data-image-busy-lock placeholder="描述希望生成或修改的画面"></textarea></label>
          <label class="image-studio-field" id="imageStudioSourcesField" hidden><span>源图片相对路径</span><textarea id="imageStudioSources" rows="1" spellcheck="false" data-image-busy-lock></textarea><small>每行一个当前工程内的图片路径</small></label>
          <label class="image-studio-field" id="imageStudioMaskField" hidden><span>蒙版相对路径</span><input id="imageStudioMask" type="text" spellcheck="false" data-image-busy-lock placeholder="assets/mask.png" /></label>
          <div class="image-studio-grid image-studio-mask-options" id="imageStudioMaskControls" hidden>
            <label class="image-studio-field"><span>蒙版模式</span><select id="imageStudioMaskMode" data-image-busy-lock><option value="strict">严格恢复</option><option value="soft">供应商软蒙版</option></select><small>严格模式会在返回后恢复蒙版不透明区域</small></label>
            <label class="image-studio-field" id="imageStudioMaskFeatherField"><span>蒙版羽化像素</span><input id="imageStudioMaskFeather" type="number" min="0" max="128" step="1" value="0" data-image-busy-lock /></label>
          </div>
          <fieldset class="image-studio-outpaint" id="imageStudioOutpaintFields" hidden>
            <legend>扩展像素</legend>
            <label><span>上</span><input id="imageStudioOutpaintTop" type="number" min="0" max="3840" step="1" value="0" data-image-busy-lock /></label>
            <label><span>右</span><input id="imageStudioOutpaintRight" type="number" min="0" max="3840" step="1" value="0" data-image-busy-lock /></label>
            <label><span>下</span><input id="imageStudioOutpaintBottom" type="number" min="0" max="3840" step="1" value="0" data-image-busy-lock /></label>
            <label><span>左</span><input id="imageStudioOutpaintLeft" type="number" min="0" max="3840" step="1" value="0" data-image-busy-lock /></label>
          </fieldset>
          <div class="image-studio-grid image-studio-outpaint-options" id="imageStudioOutpaintOptions" hidden>
            <label class="image-studio-field"><span>原图保留</span><select id="imageStudioPreserveSource" data-image-busy-lock><option value="exact">精确保留</option><option value="seamless">无缝过渡</option></select></label>
            <label class="image-studio-field" id="imageStudioBlendMarginField" hidden><span>接缝过渡像素</span><input id="imageStudioBlendMargin" type="number" min="1" max="512" step="1" value="64" data-image-busy-lock /></label>
            <label class="image-studio-field"><span>尺寸对齐策略</span><select id="imageStudioAlignmentPolicy" data-image-busy-lock><option value="reject">不支持即拒绝</option><option value="pad-and-crop">填充后裁回</option><option value="rescale-and-crop">缩放填充后裁回</option></select><small>仅使用本次明确选择，不会自动切换</small></label>
          </div>
          <div class="image-studio-grid">
            <label class="image-studio-field" id="imageStudioSizeField"><span>尺寸</span><input id="imageStudioSize" type="text" list="imageStudioSizeList" spellcheck="false" required data-image-busy-lock /><datalist id="imageStudioSizeList"></datalist></label>
            <label class="image-studio-field"><span>质量</span><select id="imageStudioQuality" data-image-busy-lock></select></label>
            <label class="image-studio-field"><span>输出格式</span><select id="imageStudioOutputFormat" data-image-busy-lock></select></label>
            <label class="image-studio-field"><span>背景</span><select id="imageStudioBackground" data-image-busy-lock></select></label>
            <label class="image-studio-field"><span>审核</span><select id="imageStudioModeration" data-image-busy-lock></select></label>
            <label class="image-studio-field" id="imageStudioInputFidelityField" hidden><span>输入保真度</span><select id="imageStudioInputFidelity" data-image-busy-lock></select></label>
            <label class="image-studio-field"><span>结果数量</span><input id="imageStudioCount" type="number" min="1" max="1" step="1" value="1" data-image-busy-lock /></label>
            <label class="image-studio-field" id="imageStudioCompressionField"><span>压缩质量 <output id="imageStudioCompressionValue">100%</output></span><input id="imageStudioCompression" type="range" min="0" max="100" step="1" value="100" data-image-busy-lock /></label>
          </div>
          <label class="image-studio-field"><span>输出相对路径（可选）</span><input id="imageStudioDestination" type="text" spellcheck="false" data-image-busy-lock placeholder="generated-images/concept" /><small>不会覆盖已有文件</small></label>
          <label class="toggle-line image-studio-stream" id="imageStudioStreamRow" hidden><input id="imageStudioStream" type="checkbox" data-image-busy-lock /><span class="toggle-control"></span><span>流式预览</span></label>
          <label class="image-studio-field" id="imageStudioPartialField" hidden><span>预览图片数</span><input id="imageStudioPartialImages" type="number" min="0" max="0" step="1" value="0" data-image-busy-lock /></label>
          <p class="image-studio-error" id="imageStudioError" role="alert"></p>
          <div class="image-studio-submit-row">
            <button class="secondary-button" id="imageStudioCancelButton" type="button" hidden><i data-lucide="square"></i><span>取消请求</span></button>
            <button class="primary-button" id="imageStudioSubmitButton" type="submit" data-image-busy-lock disabled><i data-lucide="sparkles"></i><span id="imageStudioSubmitLabel">生成</span></button>
          </div>
        </aside>
        <main class="image-studio-stage">
          <div class="image-studio-stage-bar"><span id="imageStudioStatus">正在读取图片能力</span><span id="imageStudioUsage" hidden></span></div>
          <div class="image-studio-partials" id="imageStudioPartialStrip" aria-live="polite" hidden></div>
          <div class="image-studio-empty" id="imageStudioEmpty"><i data-lucide="image"></i><span>结果会显示在这里</span></div>
          <div class="image-studio-results" id="imageStudioResults" aria-live="polite"></div>
        </main>
      </form>
    </div>`;
}
