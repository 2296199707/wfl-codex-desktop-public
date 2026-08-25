const SIDES = ["top", "right", "bottom", "left"];
const ALIGNMENT_POLICIES = new Set(["reject", "pad-and-crop", "rescale-and-crop"]);
const MAX_SIDE = 3_840;

export function normalizeMapImageBoundary(value, source) {
  const width = positiveInteger(source?.width, "源图宽度");
  const height = positiveInteger(source?.height, "源图高度");
  const sides = Object.fromEntries(SIDES.map((side) => [side, boundedSide(value?.[side], side)]));
  const target = {
    width: width + sides.left + sides.right,
    height: height + sides.top + sides.bottom,
  };
  if (!Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height)
    || target.width < 1 || target.height < 1) {
    throw new Error("裁剪边界不能移除整张源图");
  }
  const crop = Object.freeze({
    top: Math.max(0, -sides.top),
    right: Math.max(0, -sides.right),
    bottom: Math.max(0, -sides.bottom),
    left: Math.max(0, -sides.left),
  });
  const outpaint = Object.freeze({
    top: Math.max(0, sides.top),
    right: Math.max(0, sides.right),
    bottom: Math.max(0, sides.bottom),
    left: Math.max(0, sides.left),
  });
  const cropped = Object.freeze({
    width: width - crop.left - crop.right,
    height: height - crop.top - crop.bottom,
  });
  if (cropped.width < 1 || cropped.height < 1) throw new Error("裁剪后源图尺寸必须至少为 1×1");
  return Object.freeze({
    source: Object.freeze({ width, height }),
    sides: Object.freeze(sides),
    crop,
    outpaint,
    cropped,
    target: Object.freeze(target),
    hasCrop: Object.values(crop).some(Boolean),
    hasOutpaint: Object.values(outpaint).some(Boolean),
  });
}

export function planMapImageProviderCanvas(boundary, capability, limits, alignmentPolicy = "reject") {
  const normalized = normalizeMapImageBoundary(boundary?.sides || boundary, boundary?.source);
  const policy = String(alignmentPolicy || "reject");
  if (!ALIGNMENT_POLICIES.has(policy)) throw new Error("图片尺寸对齐策略无效");
  const target = normalized.target;
  const sizes = Array.isArray(capability?.sizes)
    ? [...new Set(capability.sizes.map(parseSize).filter(Boolean).map(formatSize))].map(parseSize)
    : [];
  const customSize = capability?.customSize === true;
  if (sizes.some((entry) => sameSize(entry, target)) || (customSize && withinLimits(target, limits))) {
    return Object.freeze({
      supported: true,
      logical: target,
      provider: target,
      alignmentPolicy: policy,
      postprocess: Object.freeze([]),
    });
  }
  if (policy === "reject") return unsupportedProviderPlan(target, sizes, policy);

  const candidates = [...sizes];
  if (customSize) {
    const custom = customCandidate(target, limits, policy);
    if (custom) candidates.push(custom);
  }
  const provider = policy === "pad-and-crop"
    ? candidates
      .filter((entry) => entry.width >= target.width && entry.height >= target.height)
      .sort((left, right) => left.width * left.height - right.width * right.height)[0]
    : candidates.sort((left, right) => rescaleScore(left, target) - rescaleScore(right, target))[0];
  if (!provider) return unsupportedProviderPlan(target, sizes, policy);
  const postprocess = policy === "pad-and-crop"
    ? [
        provider.width > target.width ? `pad-right:${provider.width - target.width}` : null,
        provider.height > target.height ? `pad-bottom:${provider.height - target.height}` : null,
        `crop-provider:0,0,${target.width},${target.height}`,
      ].filter(Boolean)
    : [`rescale-provider:${provider.width}x${provider.height}->${target.width}x${target.height}`];
  return Object.freeze({
    supported: true,
    logical: target,
    provider: Object.freeze({ ...provider }),
    alignmentPolicy: policy,
    postprocess: Object.freeze(postprocess),
  });
}

export function snapMapImageBoundarySide(value, side, source, guideCoordinates, tolerance) {
  const width = Number(source?.width);
  const height = Number(source?.height);
  const coordinates = finiteCoordinates(guideCoordinates);
  const candidates = side === "left" ? coordinates.map((coordinate) => -coordinate)
    : side === "right" ? coordinates.map((coordinate) => coordinate - width)
      : side === "top" ? coordinates.map((coordinate) => -coordinate)
        : side === "bottom" ? coordinates.map((coordinate) => coordinate - height)
          : [];
  return closestNumber(Number(value), candidates, tolerance);
}

export class MapImageBoundaryController {
  constructor(options) {
    this.canvas = options.canvas;
    this.inputs = Object.fromEntries(SIDES.map((side) => [side, options.inputs[side]]));
    this.unitInput = options.unitInput;
    this.stepInput = options.stepInput;
    this.emptyState = options.emptyState;
    this.document = options.document;
    this.onChange = options.onChange || (() => {});
    this.values = { top: 0, right: 0, bottom: 0, left: 0 };
    this.source = null;
    this.image = null;
    this.unit = "pixel";
    this.step = 1;
    this.guideCoordinates = { vertical: [], horizontal: [] };
    this.drag = null;
    this.layout = null;
    this.bind();
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.canvas);
    this.renderInputs();
    this.draw();
  }

  setSource(value = {}) {
    const { url, width, height } = value || {};
    if (!url || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      this.source = null;
      this.image = null;
      this.values = { top: 0, right: 0, bottom: 0, left: 0 };
      this.renderInputs();
      this.draw();
      this.onChange(this.snapshot());
      return;
    }
    this.source = { width, height, url };
    this.values = { top: 0, right: 0, bottom: 0, left: 0 };
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (this.source?.url !== url) return;
      this.image = image;
      this.draw();
    };
    image.onerror = () => {
      if (this.source?.url === url) {
        this.image = null;
        this.draw();
      }
    };
    image.src = url;
    this.renderInputs();
    this.draw();
    this.onChange(this.snapshot());
  }

  clearSource() {
    this.setSource(null);
  }

  setGuideCoordinates(value = {}) {
    this.guideCoordinates = {
      vertical: finiteCoordinates(value.vertical),
      horizontal: finiteCoordinates(value.horizontal),
    };
    this.canvas.dataset.verticalGuideCount = String(this.guideCoordinates.vertical.length);
    this.canvas.dataset.horizontalGuideCount = String(this.guideCoordinates.horizontal.length);
    this.draw();
  }

  snapshot() {
    if (!this.source) return null;
    try {
      return normalizeMapImageBoundary(this.values, this.source);
    } catch (error) {
      return Object.freeze({ source: { ...this.source }, sides: { ...this.values }, error: error.message });
    }
  }

  reset() {
    this.values = { top: 0, right: 0, bottom: 0, left: 0 };
    this.commit();
  }

  bind() {
    for (const side of SIDES) {
      this.inputs[side].addEventListener("change", () => {
        const number = Number(this.inputs[side].value);
        if (!Number.isFinite(number)) {
          this.renderInputs();
          return;
        }
        this.values[side] = this.clampSide(side, number * this.unitSize(side));
        this.commit();
      });
    }
    this.unitInput.addEventListener("change", () => {
      this.unit = this.unitInput.value === "tile" ? "tile" : "pixel";
      this.renderInputs();
      this.draw();
      this.onChange(this.snapshot());
    });
    this.stepInput.addEventListener("change", () => {
      this.step = Math.max(1, Math.min(1024, Number(this.stepInput.value) || 1));
      this.stepInput.value = formatNumber(this.step);
      this.onChange(this.snapshot());
    });
    this.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
  }

  pointerDown(event) {
    if (event.button !== 0 || !this.layout || !this.source) return;
    const point = this.canvasPoint(event);
    const side = closestHandle(point, this.layout.handles, event.pointerType === "touch" ? 24 : 14);
    if (!side) return;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = { pointerId: event.pointerId, side };
    this.canvas.dataset.dragSide = side;
  }

  pointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId || !this.layout || !this.source) return;
    const point = this.canvasPoint(event);
    const logical = {
      x: (point.x - this.layout.origin.x) / this.layout.scale,
      y: (point.y - this.layout.origin.y) / this.layout.scale,
    };
    const side = this.drag.side;
    const raw = side === "left" ? -logical.x
      : side === "right" ? logical.x - this.source.width
        : side === "top" ? -logical.y
          : logical.y - this.source.height;
    const quantum = this.unitSize(side) * this.step;
    const stepped = Math.round(raw / quantum) * quantum;
    const guideSnapped = snapMapImageBoundarySide(
      stepped,
      side,
      this.source,
      ["left", "right"].includes(side)
        ? this.guideCoordinates.vertical
        : this.guideCoordinates.horizontal,
      10 / this.layout.scale,
    );
    this.values[side] = this.clampSide(side, guideSnapped);
    this.renderInputs();
    this.draw();
  }

  pointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    delete this.canvas.dataset.dragSide;
    this.commit();
  }

  clampSide(side, value) {
    let minimum = -MAX_SIDE;
    if (this.source) {
      if (side === "left") minimum = -(this.source.width + this.values.right - 1);
      else if (side === "right") minimum = -(this.source.width + this.values.left - 1);
      else if (side === "top") minimum = -(this.source.height + this.values.bottom - 1);
      else minimum = -(this.source.height + this.values.top - 1);
    }
    return Math.max(minimum, Math.min(MAX_SIDE, Math.round(Number(value) * 1_000) / 1_000));
  }

  unitSize(side) {
    if (this.unit !== "tile") return 1;
    const size = ["left", "right"].includes(side) ? this.document?.tilewidth : this.document?.tileheight;
    return Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 1;
  }

  canvasPoint(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  commit() {
    this.renderInputs();
    this.draw();
    this.onChange(this.snapshot());
  }

  renderInputs() {
    this.unitInput.value = this.unit;
    this.stepInput.value = formatNumber(this.step);
    for (const side of SIDES) {
      this.inputs[side].value = formatNumber(this.values[side] / this.unitSize(side));
      this.inputs[side].step = String(this.step);
      this.inputs[side].disabled = !this.source;
    }
  }

  draw() {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    drawChecker(context, width, height);
    if (!this.source) {
      this.layout = null;
      this.emptyState.hidden = false;
      return;
    }
    this.emptyState.hidden = true;
    let boundary;
    try {
      boundary = normalizeMapImageBoundary(this.values, this.source);
    } catch {
      boundary = null;
    }
    const sides = boundary?.sides || this.values;
    const left = Math.min(0, -sides.left);
    const top = Math.min(0, -sides.top);
    const right = Math.max(this.source.width, this.source.width + sides.right);
    const bottom = Math.max(this.source.height, this.source.height + sides.bottom);
    const contentWidth = Math.max(1, right - left);
    const contentHeight = Math.max(1, bottom - top);
    const scale = Math.max(0.001, Math.min((width - 52) / contentWidth, (height - 42) / contentHeight));
    const origin = {
      x: (width - contentWidth * scale) / 2 - left * scale,
      y: (height - contentHeight * scale) / 2 - top * scale,
    };
    const sourceRect = rectToScreen({ x: 0, y: 0, width: this.source.width, height: this.source.height }, origin, scale);
    const targetRect = rectToScreen({
      x: -sides.left,
      y: -sides.top,
      width: this.source.width + sides.left + sides.right,
      height: this.source.height + sides.top + sides.bottom,
    }, origin, scale);
    if (this.image) context.drawImage(this.image, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
    else {
      context.fillStyle = "#303632";
      context.fillRect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
    }
    context.fillStyle = "rgb(74 185 215 / 18%)";
    context.fillRect(targetRect.x, targetRect.y, targetRect.width, targetRect.height);
    context.save();
    context.beginPath();
    context.rect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
    context.rect(targetRect.x, targetRect.y, targetRect.width, targetRect.height);
    context.fillStyle = "rgb(224 99 82 / 30%)";
    context.fill("evenodd");
    context.restore();
    context.strokeStyle = "#6bd6ef";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.strokeRect(targetRect.x, targetRect.y, targetRect.width, targetRect.height);
    context.setLineDash([]);
    context.save();
    context.strokeStyle = "rgb(126 221 158 / 82%)";
    context.lineWidth = 1;
    context.setLineDash([3, 4]);
    for (const x of this.guideCoordinates.vertical) {
      const screenX = origin.x + x * scale;
      context.beginPath();
      context.moveTo(screenX, 0);
      context.lineTo(screenX, height);
      context.stroke();
    }
    for (const y of this.guideCoordinates.horizontal) {
      const screenY = origin.y + y * scale;
      context.beginPath();
      context.moveTo(0, screenY);
      context.lineTo(width, screenY);
      context.stroke();
    }
    context.restore();
    context.strokeStyle = "rgb(255 255 255 / 55%)";
    context.lineWidth = 1;
    context.strokeRect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
    const handles = {
      top: { x: targetRect.x + targetRect.width / 2, y: targetRect.y },
      right: { x: targetRect.x + targetRect.width, y: targetRect.y + targetRect.height / 2 },
      bottom: { x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height },
      left: { x: targetRect.x, y: targetRect.y + targetRect.height / 2 },
    };
    for (const [side, point] of Object.entries(handles)) {
      context.fillStyle = this.drag?.side === side ? "#d5f7ff" : "#6bd6ef";
      context.fillRect(point.x - 5, point.y - 5, 10, 10);
      context.strokeStyle = "#102a31";
      context.strokeRect(point.x - 5, point.y - 5, 10, 10);
    }
    this.layout = { origin, scale, handles, sourceRect, targetRect };
  }

  destroy() {
    this.resizeObserver?.disconnect();
  }

}

function boundedSide(value, label) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_SIDE || Math.round(number) !== number) {
    throw new Error(`${label} 边界必须是 -${MAX_SIDE} 到 ${MAX_SIDE} 的整数像素`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 32_767) throw new Error(`${label}无效`);
  return number;
}

function parseSize(value) {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(String(value || ""));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function formatSize(value) {
  return `${value.width}x${value.height}`;
}

function sameSize(left, right) {
  return left.width === right.width && left.height === right.height;
}

function withinLimits(size, value) {
  const limits = normalizeLimits(value);
  if (!limits) return false;
  return size.width <= limits.maxWidth
    && size.height <= limits.maxHeight
    && size.width % limits.dimensionMultiple === 0
    && size.height % limits.dimensionMultiple === 0
    && Math.max(size.width / size.height, size.height / size.width) <= limits.maxAspectRatio
    && size.width * size.height >= limits.minPixels
    && size.width * size.height <= limits.maxPixels;
}

function normalizeLimits(value) {
  const limits = {
    maxWidth: Number(value?.maxWidth),
    maxHeight: Number(value?.maxHeight),
    dimensionMultiple: Number(value?.dimensionMultiple),
    maxAspectRatio: Number(value?.maxAspectRatio),
    minPixels: Number(value?.minPixels),
    maxPixels: Number(value?.maxPixels),
  };
  return Object.values(limits).every(Number.isFinite)
    && limits.maxWidth > 0 && limits.maxHeight > 0 && limits.dimensionMultiple > 0
    && limits.maxAspectRatio >= 1 && limits.minPixels > 0 && limits.maxPixels >= limits.minPixels
    ? limits
    : null;
}

function customCandidate(target, limits, policy) {
  const rule = normalizeLimits(limits);
  if (!rule) return null;
  if (policy === "pad-and-crop") {
    const candidate = {
      width: Math.ceil(target.width / rule.dimensionMultiple) * rule.dimensionMultiple,
      height: Math.ceil(target.height / rule.dimensionMultiple) * rule.dimensionMultiple,
    };
    return withinLimits(candidate, rule) ? candidate : null;
  }
  const width = Math.max(rule.dimensionMultiple, Math.min(
    rule.maxWidth,
    Math.round(target.width / rule.dimensionMultiple) * rule.dimensionMultiple,
  ));
  const height = Math.max(rule.dimensionMultiple, Math.min(
    rule.maxHeight,
    Math.round(target.height / rule.dimensionMultiple) * rule.dimensionMultiple,
  ));
  const candidate = { width, height };
  return withinLimits(candidate, rule) ? candidate : null;
}

function unsupportedProviderPlan(target, sizes, alignmentPolicy) {
  return Object.freeze({
    supported: false,
    logical: Object.freeze({ ...target }),
    provider: null,
    alignmentPolicy,
    supportedSizes: Object.freeze(sizes.map(formatSize)),
    message: `当前供应商的扩图操作不支持 ${formatSize(target)}`,
    postprocess: Object.freeze([]),
  });
}

function rescaleScore(candidate, target) {
  return Math.abs(Math.log(candidate.width / target.width))
    + Math.abs(Math.log(candidate.height / target.height))
    + Math.abs(candidate.width / candidate.height - target.width / target.height);
}

function rectToScreen(rect, origin, scale) {
  return {
    x: origin.x + rect.x * scale,
    y: origin.y + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

function closestHandle(point, handles, tolerance) {
  let closest = null;
  let distance = tolerance;
  for (const [side, handle] of Object.entries(handles || {})) {
    const current = Math.hypot(point.x - handle.x, point.y - handle.y);
    if (current <= distance) {
      closest = side;
      distance = current;
    }
  }
  return closest;
}

function finiteCoordinates(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter((entry) => Number.isFinite(entry) && Math.abs(entry) <= 1_000_000_000))]
    : [];
}

function closestNumber(value, candidates, tolerance) {
  let closest = value;
  let distance = Math.max(0, Number(tolerance) || 0);
  for (const candidate of candidates) {
    const current = Math.abs(candidate - value);
    if (current <= distance) {
      closest = candidate;
      distance = current;
    }
  }
  return closest;
}

function drawChecker(context, width, height) {
  context.fillStyle = "#242824";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#2c312d";
  const size = 12;
  for (let y = 0; y < height; y += size) {
    for (let x = (y / size) % 2 ? size : 0; x < width; x += size * 2) {
      context.fillRect(x, y, size, size);
    }
  }
}

function formatNumber(value) {
  return String(Math.round(Number(value) * 1_000) / 1_000);
}
