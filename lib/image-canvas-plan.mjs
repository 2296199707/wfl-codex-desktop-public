const ALIGNMENT_POLICIES = new Set(["reject", "pad-and-crop", "rescale-and-crop"]);

export function planImageProviderCanvas({
  requested,
  capability,
  limits,
  alignmentPolicy = "reject",
} = {}) {
  const logical = normalizeDimensions(requested, "requested canvas");
  const support = normalizeCapability(capability);
  const policy = String(alignmentPolicy || "reject");
  if (!ALIGNMENT_POLICIES.has(policy)) {
    throw canvasPlanError("INVALID_IMAGE_ALIGNMENT_POLICY", "图片尺寸对齐策略无效", {
      alignmentPolicy: policy,
    });
  }

  if (supportsExactSize(logical, support, limits)) {
    return plan(logical, logical, policy, {
      kind: "none",
      offsetX: 0,
      offsetY: 0,
      scaledWidth: logical.width,
      scaledHeight: logical.height,
    }, []);
  }

  if (policy === "reject") throw unsupportedCanvas(logical, support, policy);

  if (policy === "pad-and-crop") {
    const provider = smallestPaddingCanvas(logical, support, limits);
    if (!provider) throw unsupportedCanvas(logical, support, policy);
    return plan(logical, provider, policy, {
      kind: "pad-and-crop",
      offsetX: 0,
      offsetY: 0,
      scaledWidth: logical.width,
      scaledHeight: logical.height,
    }, paddingSteps(provider, logical));
  }

  const provider = bestRescaleCanvas(logical, support, limits);
  if (!provider) throw unsupportedCanvas(logical, support, policy);
  const scale = Math.min(provider.width / logical.width, provider.height / logical.height);
  const scaledWidth = Math.max(1, Math.min(provider.width, Math.round(logical.width * scale)));
  const scaledHeight = Math.max(1, Math.min(provider.height, Math.round(logical.height * scale)));
  const offsetX = Math.floor((provider.width - scaledWidth) / 2);
  const offsetY = Math.floor((provider.height - scaledHeight) / 2);
  return plan(logical, provider, policy, {
    kind: "rescale-and-crop",
    offsetX,
    offsetY,
    scaledWidth,
    scaledHeight,
  }, [
    `scale-canvas:${logical.width}x${logical.height}->${scaledWidth}x${scaledHeight}`,
    ...paddingSteps(provider, { width: scaledWidth, height: scaledHeight }, { offsetX, offsetY }),
    `resize-output:${scaledWidth}x${scaledHeight}->${logical.width}x${logical.height}`,
  ]);
}

export function imageOperationSizeCapability(value, fallback = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  return normalizeCapability(source);
}

export function imageCanvasPlanError(error) {
  return Boolean(error?.code && [
    "INVALID_IMAGE_ALIGNMENT_POLICY",
    "INVALID_IMAGE_CANVAS",
    "IMAGE_PROVIDER_SIZE_UNSUPPORTED",
  ].includes(error.code));
}

function plan(requested, provider, alignmentPolicy, transform, postprocess) {
  return {
    requested: { ...requested },
    provider: { ...provider },
    alignmentPolicy,
    transform: { ...transform },
    postprocess: [...postprocess],
  };
}

function supportsExactSize(size, capability, limits) {
  if (capability.sizes.includes(formatSize(size))) return true;
  return capability.customSize && withinLimits(size, limits);
}

function smallestPaddingCanvas(requested, capability, limits) {
  const candidates = candidateSizes(capability, limits, {
    minimumWidth: requested.width,
    minimumHeight: requested.height,
  });
  return candidates.sort((left, right) => (
    (left.width * left.height) - (right.width * right.height)
    || Math.abs((left.width / left.height) - (requested.width / requested.height))
      - Math.abs((right.width / right.height) - (requested.width / requested.height))
    || left.width - right.width
    || left.height - right.height
  ))[0] || null;
}

function bestRescaleCanvas(requested, capability, limits) {
  const candidates = candidateSizes(capability, limits);
  const requestedRatio = requested.width / requested.height;
  return candidates.sort((left, right) => {
    const leftScale = Math.min(left.width / requested.width, left.height / requested.height);
    const rightScale = Math.min(right.width / requested.width, right.height / requested.height);
    const leftUsed = Math.round(requested.width * leftScale) * Math.round(requested.height * leftScale);
    const rightUsed = Math.round(requested.width * rightScale) * Math.round(requested.height * rightScale);
    const leftPadding = 1 - (leftUsed / (left.width * left.height));
    const rightPadding = 1 - (rightUsed / (right.width * right.height));
    const leftScore = Math.abs(Math.log(leftScale)) + leftPadding
      + Math.abs((left.width / left.height) - requestedRatio) * 0.1;
    const rightScore = Math.abs(Math.log(rightScale)) + rightPadding
      + Math.abs((right.width / right.height) - requestedRatio) * 0.1;
    return leftScore - rightScore || (left.width * left.height) - (right.width * right.height);
  })[0] || null;
}

function candidateSizes(capability, limits, { minimumWidth = 1, minimumHeight = 1 } = {}) {
  const candidates = new Map();
  for (const text of capability.sizes) {
    const parsed = parseSize(text);
    if (parsed && parsed.width >= minimumWidth && parsed.height >= minimumHeight) {
      candidates.set(text, parsed);
    }
  }
  if (capability.customSize) {
    const rule = normalizeLimits(limits);
    if (rule) {
      const startWidth = roundUp(Math.max(minimumWidth, rule.dimensionMultiple), rule.dimensionMultiple);
      const startHeight = roundUp(Math.max(minimumHeight, rule.dimensionMultiple), rule.dimensionMultiple);
      for (let width = startWidth; width <= rule.maxWidth; width += rule.dimensionMultiple) {
        for (let height = startHeight; height <= rule.maxHeight; height += rule.dimensionMultiple) {
          const entry = { width, height };
          if (withinLimits(entry, rule)) candidates.set(formatSize(entry), entry);
        }
      }
    }
  }
  return [...candidates.values()];
}

function withinLimits(size, value) {
  const limits = normalizeLimits(value);
  if (!limits) return false;
  const pixels = size.width * size.height;
  return size.width <= limits.maxWidth
    && size.height <= limits.maxHeight
    && size.width % limits.dimensionMultiple === 0
    && size.height % limits.dimensionMultiple === 0
    && Math.max(size.width / size.height, size.height / size.width) <= limits.maxAspectRatio
    && pixels >= limits.minPixels
    && pixels <= limits.maxPixels;
}

function normalizeCapability(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    customSize: source.customSize === true,
    sizes: Array.isArray(source.sizes)
      ? [...new Set(source.sizes.map(String).filter((entry) => parseSize(entry)))].slice(0, 64)
      : [],
  };
}

function normalizeLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const limits = {
    maxWidth: Number(value.maxWidth),
    maxHeight: Number(value.maxHeight),
    dimensionMultiple: Number(value.dimensionMultiple),
    maxAspectRatio: Number(value.maxAspectRatio),
    minPixels: Number(value.minPixels),
    maxPixels: Number(value.maxPixels),
  };
  return Object.values(limits).every(Number.isFinite)
    && Number.isSafeInteger(limits.maxWidth)
    && Number.isSafeInteger(limits.maxHeight)
    && Number.isSafeInteger(limits.dimensionMultiple)
    && Number.isSafeInteger(limits.minPixels)
    && Number.isSafeInteger(limits.maxPixels)
    && limits.maxWidth > 0
    && limits.maxHeight > 0
    && limits.dimensionMultiple > 0
    && limits.maxAspectRatio >= 1
    && limits.minPixels > 0
    && limits.maxPixels >= limits.minPixels
    ? limits
    : null;
}

function normalizeDimensions(value, label) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw canvasPlanError("INVALID_IMAGE_CANVAS", `${label} dimensions are invalid`);
  }
  return { width, height };
}

function parseSize(value) {
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(String(value || ""));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function formatSize(size) {
  return `${size.width}x${size.height}`;
}

function roundUp(value, multiple) {
  return Math.ceil(value / multiple) * multiple;
}

function paddingSteps(provider, content, { offsetX = 0, offsetY = 0 } = {}) {
  const right = provider.width - content.width - offsetX;
  const bottom = provider.height - content.height - offsetY;
  return [
    offsetY ? `pad-top:${offsetY}` : null,
    right ? `pad-right:${right}` : null,
    bottom ? `pad-bottom:${bottom}` : null,
    offsetX ? `pad-left:${offsetX}` : null,
    `crop-provider:${offsetX},${offsetY},${content.width},${content.height}`,
  ].filter(Boolean);
}

function unsupportedCanvas(requested, capability, alignmentPolicy) {
  return canvasPlanError(
    "IMAGE_PROVIDER_SIZE_UNSUPPORTED",
    `当前供应商的图片操作不支持 ${formatSize(requested)}`,
    {
      reason: "provider_size_unsupported",
      stage: "local_prepare",
      requestedSize: formatSize(requested),
      supportedSizes: capability.sizes,
      customSize: capability.customSize,
      alignmentPolicy,
    },
  );
}

function canvasPlanError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode: 400, retryable: false, ...details });
}
