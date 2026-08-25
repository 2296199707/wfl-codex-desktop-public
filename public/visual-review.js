import {
  imageContextPolicy,
  sanitizeVisualReviewReport,
} from "./image-context-policy.js?v=0.44.55";

// Visual review is deliberately a browser-local, bounded operation.  It reads
// one already-authorized project image, performs a small raster inspection,
// and only keeps a sanitized report while the dialog is open.
export const VISUAL_REVIEW_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxPixels: 8_294_400,
  maxAnalysisPixels: 1_048_576,
  maxReportCharacters: 8_000,
});

const FORMAT_BY_MEDIA_TYPE = Object.freeze({
  "image/avif": "AVIF",
  "image/gif": "GIF",
  "image/jpeg": "JPEG",
  "image/jpg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
});
const LOCAL_IMAGE_ENDPOINT = "/api/files/image";
const NONCE = "visualReviewStyles";
let reviewInstance = null;

/**
 * Open (or reuse) the visual review surface.  A caller must explicitly opt
 * into the visual-review context; there is intentionally no default scope.
 */
export async function openVisualReview(options = {}) {
  imageContextPolicy(options.context);
  if (!reviewInstance) reviewInstance = createVisualReview(options);
  reviewInstance.updateOptions(options);
  await reviewInstance.open();
  return reviewInstance;
}

/** Close a currently open review without loading the module again. */
export function closeVisualReview() {
  reviewInstance?.close();
}

/**
 * Analyze an RGBA sample.  `width`/`height` describe the supplied sample;
 * `sourceWidth`/`sourceHeight` describe the original image.  Large images are
 * therefore reported with an explicit estimate instead of silently claiming
 * that a downsampled scan was exact.
 */
export function analyzeImagePixels({
  width,
  height,
  pixels,
  sourceWidth = width,
  sourceHeight = height,
  mediaType = "",
  byteLength = 0,
  name = "图片",
} = {}) {
  const sampleWidth = exactDimension(width, "分析宽度");
  const sampleHeight = exactDimension(height, "分析高度");
  const originalWidth = exactDimension(sourceWidth, "图片宽度");
  const originalHeight = exactDimension(sourceHeight, "图片高度");
  const samplePixelCount = sampleWidth * sampleHeight;
  const sourcePixelCount = originalWidth * originalHeight;
  if (sourcePixelCount > VISUAL_REVIEW_LIMITS.maxPixels) {
    throw visualReviewError("VISUAL_REVIEW_PIXELS", "图片像素数量超过视觉审查上限");
  }
  if (!pixels || typeof pixels.length !== "number" || pixels.length !== samplePixelCount * 4) {
    throw visualReviewError("VISUAL_REVIEW_PIXELS", "图片像素数据不完整");
  }
  const sourceScale = sourcePixelCount / samplePixelCount;
  const sampled = sourcePixelCount !== samplePixelCount;
  const edgeBand = Math.max(1, Math.min(12, Math.floor(Math.min(sampleWidth, sampleHeight) * 0.02)));
  let transparent = 0;
  let semiTransparent = 0;
  let opaque = 0;
  let edgeTransparent = 0;
  let edgeSemiTransparent = 0;
  let edgeBrightSemiTransparent = 0;
  let edgePixelCount = 0;
  let transparentBright = 0;
  let cornerTransparent = 0;

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const offset = (y * sampleWidth + x) * 4;
      const red = Number(pixels[offset]) || 0;
      const green = Number(pixels[offset + 1]) || 0;
      const blue = Number(pixels[offset + 2]) || 0;
      const alpha = Number(pixels[offset + 3]) || 0;
      const isEdge = x < edgeBand
        || y < edgeBand
        || x >= sampleWidth - edgeBand
        || y >= sampleHeight - edgeBand;
      if (alpha === 0) {
        transparent += 1;
        if ((red + green + blue) / 3 >= 220) transparentBright += 1;
        if (isEdge) edgeTransparent += 1;
        if ((x === 0 || x === sampleWidth - 1) && (y === 0 || y === sampleHeight - 1)) {
          cornerTransparent += 1;
        }
      } else if (alpha < 255) {
        semiTransparent += 1;
        if (isEdge) {
          edgeSemiTransparent += 1;
          if ((red + green + blue) / 3 >= 220) edgeBrightSemiTransparent += 1;
        }
      } else {
        opaque += 1;
      }
      if (isEdge) edgePixelCount += 1;
    }
  }

  const estimate = (value) => Math.min(sourcePixelCount, Math.max(0, Math.round(value * sourceScale)));
  const transparentPixels = estimate(transparent);
  const semiTransparentPixels = estimate(semiTransparent);
  const opaquePixels = estimate(opaque);
  const edgeTransparentPixels = estimate(edgeTransparent);
  const edgeSemiPixels = estimate(edgeSemiTransparent);
  const edgeBrightPixels = estimate(edgeBrightSemiTransparent);
  const edgeRatio = edgePixelCount ? edgeSemiTransparent / edgePixelCount : 0;
  const brightEdgeRatio = edgePixelCount ? edgeBrightSemiTransparent / edgePixelCount : 0;
  const transparentRatio = samplePixelCount ? transparent / samplePixelCount : 0;
  const issues = [];
  const tags = [];

  if (transparentRatio > 0.005) tags.push("透明背景");
  else tags.push("不透明背景");
  if (semiTransparent > 0) tags.push("半透明像素");
  if (brightEdgeRatio >= 0.02) {
    issues.push({
      code: "alpha-fringe",
      severity: "warning",
      message: "边缘存在较多浅色半透明像素，放到深色背景时可能出现白边。",
      confidence: Math.min(1, brightEdgeRatio * 4),
    });
    tags.push("可能有浅色边缘");
  } else if (edgeRatio >= 0.08) {
    issues.push({
      code: "soft-edge",
      severity: "info",
      message: "边缘包含半透明过渡，导入瓦片或缩放前建议确认抗锯齿符合美术规范。",
      confidence: Math.min(1, edgeRatio * 2),
    });
  }
  if (transparentRatio > 0.995) {
    issues.push({
      code: "nearly-empty",
      severity: "warning",
      message: "图片几乎完全透明，可能是空素材或导出透明度异常。",
      confidence: Math.min(1, transparentRatio),
    });
  }
  if (cornerTransparent > 0) tags.push("角落透明");
  if (transparentBright > 0 && brightEdgeRatio < 0.02) tags.push("透明区含亮色像素");
  const recommendations = [];
  if (issues.some((issue) => issue.code === "alpha-fringe")) {
    recommendations.push("在深色和浅色背景各预览一次，必要时重新导出边缘或使用严格蒙版。");
  }
  if (issues.some((issue) => issue.code === "nearly-empty")) {
    recommendations.push("确认源文件不是空画布，并检查导出时的透明通道设置。");
  }
  if (!issues.length) recommendations.push("未发现明显的透明边缘问题，可继续在地图或图片工作室中使用。");
  const format = formatLabel(mediaType, name);
  const summary = `${safeName(name)}：${originalWidth}×${originalHeight}，${format}，${formatBytes(byteLength)}；`
    + `透明像素 ${formatCount(transparentPixels)}${sampled ? "（估算）" : ""}，`
    + `半透明像素 ${formatCount(semiTransparentPixels)}${sampled ? "（估算）" : ""}。`;
  const clean = sanitizeVisualReviewReport({
    summary,
    tags,
    issues,
    scores: {
      alphaCoverage: sourcePixelCount ? opaquePixels / sourcePixelCount : 0,
      edgeCleanliness: Math.max(0, 1 - edgeRatio),
    },
    recommendations,
  });
  return Object.freeze({
    schema: "wfl-visual-review",
    version: 1,
    context: "visual-review",
    name: safeName(name),
    width: originalWidth,
    height: originalHeight,
    pixels: sourcePixelCount,
    format,
    bytes: boundedBytes(byteLength),
    sampled,
    sampleWidth,
    sampleHeight,
    transparentPixels,
    semiTransparentPixels,
    opaquePixels,
    edgeTransparentPixels,
    edgeSemiTransparentPixels: edgeSemiPixels,
    issues: clean.issues,
    tags: clean.tags,
    scores: clean.scores,
    recommendations: clean.recommendations,
    summary: clean.summary,
  });
}

export function formatVisualReviewSummary(report) {
  const value = report && typeof report === "object" ? report : {};
  const lines = [
    "WFL 视觉审查摘要",
    "上下文：visual-review（图片不会自动加入对话）",
    `尺寸：${safeInteger(value.width)}×${safeInteger(value.height)}（${formatCount(value.pixels)} 像素）`,
    `格式：${safeName(value.format || "未知")}`,
    `文件大小：${formatBytes(value.bytes)}`,
    `透明像素：${formatCount(value.transparentPixels)}${value.sampled ? "（估算）" : ""}`,
    `半透明像素：${formatCount(value.semiTransparentPixels)}${value.sampled ? "（估算）" : ""}`,
    `边缘透明像素：${formatCount(value.edgeTransparentPixels)}；边缘半透明像素：${formatCount(value.edgeSemiTransparentPixels)}`,
    `标签：${Array.isArray(value.tags) && value.tags.length ? value.tags.join("、") : "无"}`,
    "问题：",
    ...(Array.isArray(value.issues) && value.issues.length
      ? value.issues.map((issue) => `- [${safeName(issue?.severity || "info")}] ${safeText(issue?.message)}`)
      : ["- 未发现明显问题"]),
    "建议：",
    ...(Array.isArray(value.recommendations) && value.recommendations.length
      ? value.recommendations.map((item) => `- ${safeText(item)}`)
      : ["- 无"]),
  ];
  return lines.join("\n").slice(0, VISUAL_REVIEW_LIMITS.maxReportCharacters);
}

function createVisualReview(initialOptions) {
  let options = { ...initialOptions };
  let requestController = null;
  let objectUrl = null;
  let busy = false;
  let report = null;
  ensureStyles(options.assetVersion);
  const root = document.createElement("dialog");
  root.className = "visual-review-dialog";
  root.id = "visualReviewDialog";
  root.innerHTML = visualReviewMarkup();
  document.body.append(root);
  const nodes = Object.fromEntries([...root.querySelectorAll("[data-visual-review]")]
    .map((node) => [node.dataset.visualReview, node]));

  root.querySelectorAll('[data-visual-review="close"]').forEach((button) => {
    button.addEventListener("click", close);
  });
  nodes.copy?.addEventListener("click", copySummary);
  root.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  root.addEventListener("close", cleanup);

  function updateOptions(next = {}) {
    options = { ...options, ...next };
  }

  async function open() {
    imageContextPolicy(options.context);
    if (!root.open) root.showModal();
    nodes.title.textContent = safeName(options.name || "工程图片");
    nodes.status.textContent = "正在读取图片…";
    nodes.error.textContent = "";
    nodes.copy.disabled = true;
    nodes.report.hidden = true;
    nodes.preview.hidden = true;
    report = null;
    cleanupSource();
    requestController?.abort();
    requestController = new AbortController();
    busy = true;
    try {
      const source = normalizeSourceUrl(options.sourceUrl);
      const blob = await fetchBoundedImage(source, requestController.signal);
      const decoded = await decodeImageBlob(blob);
      try {
        report = inspectDecodedImage(decoded, blob, options);
      } finally {
        decoded.close?.();
      }
      objectUrl = URL.createObjectURL(blob);
      nodes.preview.src = objectUrl;
      nodes.preview.alt = safeName(options.name || "工程图片");
      nodes.preview.hidden = false;
      renderReport(report);
      nodes.copy.disabled = false;
      nodes.status.textContent = report.sampled
        ? "审查完成（大图使用有界采样）"
        : "审查完成";
      options.onCompleted?.(report);
    } catch (error) {
      if (error?.name === "AbortError") return;
      nodes.status.textContent = "无法完成视觉审查";
      nodes.error.textContent = error?.message || "图片读取失败";
    } finally {
      busy = false;
      requestController = null;
    }
  }

  async function copySummary() {
    if (!report || busy) return;
    try {
      await copyText(formatVisualReviewSummary(report));
      nodes.status.textContent = "审查摘要已复制（未发送到对话）";
    } catch (error) {
      nodes.error.textContent = error?.message || "无法复制审查摘要";
    }
  }

  function close() {
    requestController?.abort();
    requestController = null;
    cleanupSource();
    report = null;
    busy = false;
    if (root.open) root.close();
  }

  function cleanup() {
    requestController?.abort();
    requestController = null;
    cleanupSource();
    report = null;
    busy = false;
    options.onClose?.();
  }

  function cleanupSource() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    nodes.preview?.removeAttribute("src");
  }

  function renderReport(value) {
    nodes.report.hidden = false;
    nodes.dimensions.textContent = `${value.width} × ${value.height}`;
    nodes.format.textContent = value.format;
    nodes.bytes.textContent = formatBytes(value.bytes);
    nodes.pixels.textContent = `${formatCount(value.pixels)}${value.sampled ? "（采样估算）" : ""}`;
    nodes.transparent.textContent = `${formatCount(value.transparentPixels)}${value.sampled ? "（估算）" : ""}`;
    nodes.edge.textContent = `${formatCount(value.edgeTransparentPixels)} 透明 / ${formatCount(value.edgeSemiTransparentPixels)} 半透明`;
    nodes.tags.textContent = value.tags.join("、") || "无";
    nodes.issues.replaceChildren();
    for (const issue of value.issues) {
      const item = document.createElement("li");
      item.dataset.severity = issue.severity || "info";
      item.textContent = issue.message;
      nodes.issues.append(item);
    }
    if (!value.issues.length) {
      const item = document.createElement("li");
      item.textContent = "未发现明显问题";
      nodes.issues.append(item);
    }
    nodes.recommendations.replaceChildren();
    for (const recommendation of value.recommendations) {
      const item = document.createElement("li");
      item.textContent = recommendation;
      nodes.recommendations.append(item);
    }
  }

  return {
    open,
    close,
    updateOptions,
    get dialog() { return root; },
    get report() { return report; },
  };
}

function inspectDecodedImage(decoded, blob, options) {
  const width = Number(decoded.width);
  const height = Number(decoded.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width * height > VISUAL_REVIEW_LIMITS.maxPixels) {
    throw visualReviewError("VISUAL_REVIEW_PIXELS", `图片像素数量超过上限（最多 ${formatCount(VISUAL_REVIEW_LIMITS.maxPixels)}）`);
  }
  const scale = Math.min(1, Math.sqrt(VISUAL_REVIEW_LIMITS.maxAnalysisPixels / (width * height)));
  const sampleWidth = Math.max(1, Math.floor(width * scale));
  const sampleHeight = Math.max(1, Math.floor(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw visualReviewError("VISUAL_REVIEW_CANVAS", "浏览器无法创建图片分析画布");
  context.clearRect(0, 0, sampleWidth, sampleHeight);
  context.drawImage(decoded.image, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  return analyzeImagePixels({
    width: sampleWidth,
    height: sampleHeight,
    sourceWidth: width,
    sourceHeight: height,
    pixels,
    mediaType: blob.type,
    byteLength: blob.size,
    name: options.name,
  });
}

async function fetchBoundedImage(sourceUrl, signal) {
  const response = await fetch(sourceUrl, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    let detail = "图片读取失败";
    try { detail = (await response.text()).slice(0, 300) || detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > VISUAL_REVIEW_LIMITS.maxBytes) {
    throw visualReviewError("VISUAL_REVIEW_BYTES", `图片文件超过 ${formatBytes(VISUAL_REVIEW_LIMITS.maxBytes)} 上限`);
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > VISUAL_REVIEW_LIMITS.maxBytes) {
      throw visualReviewError("VISUAL_REVIEW_BYTES", `图片文件超过 ${formatBytes(VISUAL_REVIEW_LIMITS.maxBytes)} 上限`);
    }
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > VISUAL_REVIEW_LIMITS.maxBytes) {
        await reader.cancel();
        throw visualReviewError("VISUAL_REVIEW_BYTES", `图片文件超过 ${formatBytes(VISUAL_REVIEW_LIMITS.maxBytes)} 上限`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
}

async function decodeImageBlob(blob) {
  let bitmapError = null;
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      const image = await globalThis.createImageBitmap(blob);
      return { image, width: image.width, height: image.height, close: () => image.close?.() };
    } catch (error) {
      // Some Chromium builds reject otherwise valid small/legacy PNGs through
      // createImageBitmap while the regular HTML image decoder accepts them.
      // Keep the bounded browser-local operation usable without weakening the
      // pixel/byte limits enforced before and after decoding.
      bitmapError = error;
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("浏览器无法解码这张图片"));
      element.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => {} };
  } catch (error) {
    if (bitmapError && !error.cause) {
      try { error.cause = bitmapError; } catch { /* ignore non-extensible errors */ }
    }
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizeSourceUrl(value) {
  if (typeof location === "undefined") throw new Error("当前浏览器上下文不可用");
  let parsed;
  try { parsed = new URL(String(value || ""), location.href); } catch { throw new Error("图片来源地址无效"); }
  if (parsed.origin !== location.origin || parsed.pathname !== LOCAL_IMAGE_ENDPOINT) {
    throw new Error("视觉审查只允许读取当前工程图片");
  }
  return parsed.href;
}

function visualReviewMarkup() {
  return `
    <div class="visual-review-shell" data-visual-review-shell>
      <header class="visual-review-header">
        <div class="visual-review-title"><span aria-hidden="true">◌</span><div><strong>视觉审查</strong><small data-visual-review="title"></small></div></div>
        <button class="icon-button" type="button" data-visual-review="close" title="关闭视觉审查" aria-label="关闭视觉审查">×</button>
      </header>
      <main class="visual-review-body">
        <section class="visual-review-preview"><img data-visual-review="preview" alt="" hidden /><p data-visual-review="status">等待读取图片…</p></section>
        <section class="visual-review-report" data-visual-review="report" hidden>
          <dl class="visual-review-facts">
            <div><dt>实际尺寸</dt><dd data-visual-review="dimensions">—</dd></div>
            <div><dt>格式</dt><dd data-visual-review="format">—</dd></div>
            <div><dt>文件大小</dt><dd data-visual-review="bytes">—</dd></div>
            <div><dt>像素数量</dt><dd data-visual-review="pixels">—</dd></div>
            <div><dt>透明像素</dt><dd data-visual-review="transparent">—</dd></div>
            <div><dt>边缘透明度</dt><dd data-visual-review="edge">—</dd></div>
            <div><dt>标签</dt><dd data-visual-review="tags">—</dd></div>
          </dl>
          <div class="visual-review-section"><h3>问题</h3><ul data-visual-review="issues"></ul></div>
          <div class="visual-review-section"><h3>建议</h3><ul data-visual-review="recommendations"></ul></div>
        </section>
        <p class="visual-review-error" data-visual-review="error" role="alert"></p>
      </main>
      <footer class="visual-review-footer">
        <span>报告仅保存在此窗口；不会自动加入对话。</span>
        <div><button class="secondary-button" type="button" data-visual-review="copy" disabled>复制审查摘要</button><button class="primary-button" type="button" data-visual-review="close">关闭</button></div>
      </footer>
    </div>`;
}

function ensureStyles(assetVersion) {
  if (typeof document === "undefined" || document.getElementById(NONCE)) return;
  const link = document.createElement("link");
  link.id = NONCE;
  link.rel = "stylesheet";
  link.href = `./visual-review.css?v=${encodeURIComponent(String(assetVersion || "local"))}`;
  document.head.append(link);
}

async function copyText(value) {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(String(value));
    return;
  }
  throw new Error("当前浏览器不允许复制到剪贴板");
}

function formatLabel(mediaType, name) {
  const media = FORMAT_BY_MEDIA_TYPE[String(mediaType || "").toLowerCase().split(";", 1)[0].trim()];
  if (media) return media;
  const extension = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
  return FORMAT_BY_MEDIA_TYPE[`image/${extension || ""}`] || "未知格式";
}

function exactDimension(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw visualReviewError("VISUAL_REVIEW_PIXELS", `${label}不正确`);
  return number;
}

function boundedBytes(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= VISUAL_REVIEW_LIMITS.maxBytes ? number : 0;
}

function formatBytes(value) {
  const bytes = boundedBytes(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number).toLocaleString("zh-CN") : "0";
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? formatCount(number) : "未知";
}

function safeName(value) {
  const raw = typeof value === "string" ? value : "图片";
  const normalized = raw.replaceAll("\\", "/").split("/").pop() || "图片";
  return normalized.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 160) || "图片";
}

function safeText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1_000) : "";
}

function visualReviewError(code, message) {
  return Object.assign(new Error(message), { code });
}
