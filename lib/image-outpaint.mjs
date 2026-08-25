import sharp from "sharp";
import { inspectImageBuffer, validateImageFile } from "./image-file.mjs";
import { encodeZeroCompressionRgba } from "./image-zero-compression.mjs";

const MAX_CANVAS_DIMENSION = 3_840;
const MAX_CANVAS_PIXELS = 8_294_400;
const MAX_CANVAS_ASPECT_RATIO = 3;
const SUPPORTED_FORMATS = new Set(["png", "jpeg", "webp"]);

export async function prepareOutpaint({
  sourceBuffer,
  canvas,
  placement,
  blendMargin = 0,
} = {}) {
  const target = normalizeCanvas(canvas);
  const source = await decodeImage(sourceBuffer, "source image");
  const offset = normalizePlacement(placement, source, target);
  assertCanvasExpandsSource(source, target, offset);
  const margin = normalizeBlendMargin(blendMargin);

  const canvasPixels = Buffer.alloc(target.width * target.height * 4);
  copyRgbaRectangle(source.rawBuffer, source.width, source.height, canvasPixels, target.width, offset);
  const canvasBuffer = await sharp(canvasPixels, {
    raw: { width: target.width, height: target.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const maskPixels = Buffer.alloc(target.width * target.height * 4);
  fillOutpaintMask(maskPixels, target, source, offset, margin);
  const maskBuffer = await sharp(maskPixels, {
    raw: { width: target.width, height: target.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    canvasBuffer,
    maskBuffer,
    source: {
      width: source.width,
      height: source.height,
      format: source.format,
    },
    canvas: target,
    placement: offset,
    blendMargin: margin,
  };
}

export async function transformOutpaintInputs({ canvasBuffer, maskBuffer, plan } = {}) {
  const transform = normalizeCanvasTransform(plan);
  if (transform.kind === "none") return { canvasBuffer, maskBuffer };
  return {
    canvasBuffer: await transformCanvasBuffer(canvasBuffer, transform, false),
    maskBuffer: await transformCanvasBuffer(maskBuffer, transform, true),
  };
}

export async function restoreOutpaintProviderCanvas(resultBuffer, plan) {
  const transform = normalizeCanvasTransform(plan);
  if (transform.kind === "none") return normalizeBuffer(resultBuffer, "outpaint result");
  let pipeline = sharp(normalizeBuffer(resultBuffer, "outpaint result"), {
    failOn: "error",
    limitInputPixels: MAX_CANVAS_PIXELS,
  }).extract({
    left: transform.offsetX,
    top: transform.offsetY,
    width: transform.scaledWidth,
    height: transform.scaledHeight,
  });
  if (transform.kind === "rescale-and-crop") {
    pipeline = pipeline.resize(transform.requestedWidth, transform.requestedHeight, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    });
  }
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

export async function restoreOutpaintSource(
  resultBuffer,
  sourceBuffer,
  placement,
  outputFormatOrOptions = {},
  outputOptions = {},
) {
  const result = await decodeImage(resultBuffer, "outpaint result");
  const source = await decodeImage(sourceBuffer, "source image");
  const target = normalizeCanvas({ width: result.width, height: result.height });
  const offset = normalizePlacement(placement, source, target);
  assertCanvasExpandsSource(source, target, offset);

  const output = normalizeOutputOptions(outputFormatOrOptions, outputOptions, result.format);
  const restoredPixels = Buffer.from(result.rawBuffer);
  const margin = normalizeBlendMargin(output.blendMargin ?? 0);
  if (margin === 0) {
    copyRgbaRectangle(source.rawBuffer, source.width, source.height, restoredPixels, target.width, offset);
  } else {
    blendSourceRectangle(source.rawBuffer, source, restoredPixels, target, offset, margin);
  }
  const buffer = await encodeRgbaOutput(restoredPixels, target, output);
  await validateImageFile(buffer, {
    allowedFormats: [output.format],
    maxWidth: MAX_CANVAS_DIMENSION,
    maxHeight: MAX_CANVAS_DIMENSION,
    maxPixels: MAX_CANVAS_PIXELS,
  });
  return buffer;
}

export async function restoreMaskedEditSource({
  resultBuffer,
  sourceBuffer,
  maskBuffer,
  featherPixels = 0,
  outputFormatOrOptions = {},
  outputOptions = {},
} = {}) {
  const result = await decodeImage(resultBuffer, "edit result");
  const source = await decodeImage(sourceBuffer, "source image");
  const mask = await decodeImage(maskBuffer, "edit mask");
  if (source.width !== mask.width || source.height !== mask.height) {
    throw invalidOutpaint("edit mask dimensions must match the source image");
  }
  const feather = normalizeMaskFeather(featherPixels);
  const target = { width: result.width, height: result.height };
  const sourcePixels = source.width === target.width && source.height === target.height
    ? source.rawBuffer
    : await resizeRawRgba(source.rawBuffer, source, target, sharp.kernel.lanczos3);
  const maskPixels = mask.width === target.width && mask.height === target.height
    ? mask.rawBuffer
    : await resizeRawRgba(mask.rawBuffer, mask, target, sharp.kernel.nearest);
  const alpha = await maskAlpha(maskPixels, target, feather);
  const composed = Buffer.from(result.rawBuffer);
  blendRgbaByAlpha(sourcePixels, composed, alpha);
  const output = normalizeOutputOptions(outputFormatOrOptions, outputOptions, result.format);
  const buffer = await encodeRgbaOutput(composed, target, output);
  await validateImageFile(buffer, {
    allowedFormats: [output.format],
    maxWidth: MAX_CANVAS_DIMENSION,
    maxHeight: MAX_CANVAS_DIMENSION,
    maxPixels: MAX_CANVAS_PIXELS,
  });
  return {
    buffer,
    sourceResized: source.width !== target.width || source.height !== target.height,
    featherPixels: feather,
  };
}

async function decodeImage(input, label) {
  const buffer = normalizeBuffer(input, label);
  let inspected;
  try {
    inspected = inspectImageBuffer(buffer, {
      allowedFormats: [...SUPPORTED_FORMATS],
      maxWidth: MAX_CANVAS_DIMENSION,
      maxHeight: MAX_CANVAS_DIMENSION,
      maxPixels: MAX_CANVAS_PIXELS,
    });
  } catch (error) {
    throw invalidOutpaint(`${label} could not be decoded`, error);
  }
  let metadata;
  try {
    metadata = await sharp(buffer, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_CANVAS_PIXELS,
    }).metadata();
  } catch (error) {
    throw invalidOutpaint(`${label} could not be decoded`, error);
  }

  const format = normalizeFormat(metadata.format);
  if (!SUPPORTED_FORMATS.has(format)) {
    throw invalidOutpaint(`${label} must be PNG, JPEG, or WebP`);
  }
  if (format !== inspected.format) throw invalidOutpaint(`${label} format metadata is inconsistent`);
  if ((metadata.pages ?? 1) !== 1) {
    throw invalidOutpaint(`${label} must contain exactly one frame`);
  }

  try {
    const decoded = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_CANVAS_PIXELS,
    })
      .autoOrient()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assertImageDimensions(decoded.info.width, decoded.info.height, label);
    return {
      format,
      width: decoded.info.width,
      height: decoded.info.height,
      rawBuffer: decoded.data,
    };
  } catch (error) {
    if (error?.code === "INVALID_OUTPAINT") throw error;
    throw invalidOutpaint(`${label} could not be fully decoded`, error);
  }
}

function normalizeBuffer(input, label) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw invalidOutpaint(`${label} must be a Buffer or Uint8Array`);
  }
  if (!input.byteLength) throw invalidOutpaint(`${label} is empty`);
  return Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function normalizeCanvas(canvas) {
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) {
    throw invalidOutpaint("canvas must specify width and height");
  }
  assertImageDimensions(canvas.width, canvas.height, "canvas");
  if (canvas.width / canvas.height > MAX_CANVAS_ASPECT_RATIO
    || canvas.height / canvas.width > MAX_CANVAS_ASPECT_RATIO) {
    throw invalidOutpaint(`canvas aspect ratio cannot exceed ${MAX_CANVAS_ASPECT_RATIO}:1`);
  }
  return { width: canvas.width, height: canvas.height };
}

function assertImageDimensions(width, height, label) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw invalidOutpaint(`${label} dimensions must be positive integers`);
  }
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) {
    throw invalidOutpaint(`${label} dimensions exceed the ${MAX_CANVAS_DIMENSION}px limit`);
  }
  if (width * height > MAX_CANVAS_PIXELS) {
    throw invalidOutpaint(`${label} exceeds the ${MAX_CANVAS_PIXELS}-pixel limit`);
  }
}

function normalizePlacement(placement, source, canvas) {
  if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
    throw invalidOutpaint("placement must specify x and y");
  }
  const { x, y } = placement;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw invalidOutpaint("placement coordinates must be non-negative integers");
  }
  if (x + source.width > canvas.width || y + source.height > canvas.height) {
    throw invalidOutpaint("source image placement exceeds the canvas bounds");
  }
  return { x, y };
}

function assertCanvasExpandsSource(source, canvas, placement) {
  const coversCanvas = placement.x === 0
    && placement.y === 0
    && source.width === canvas.width
    && source.height === canvas.height;
  if (coversCanvas) throw invalidOutpaint("outpaint canvas must extend beyond the source image");
}

function copyRgbaRectangle(source, sourceWidth, sourceHeight, destination, destinationWidth, placement) {
  const sourceStride = sourceWidth * 4;
  const destinationStride = destinationWidth * 4;
  for (let row = 0; row < sourceHeight; row += 1) {
    const sourceStart = row * sourceStride;
    const destinationStart = ((placement.y + row) * destinationStride) + (placement.x * 4);
    source.copy(destination, destinationStart, sourceStart, sourceStart + sourceStride);
  }
}

function fillRgbaRectangle(destination, destinationWidth, width, height, placement, value) {
  const stride = destinationWidth * 4;
  for (let row = 0; row < height; row += 1) {
    const start = ((placement.y + row) * stride) + (placement.x * 4);
    destination.fill(value, start, start + (width * 4));
  }
}

function fillOutpaintMask(destination, canvas, source, placement, blendMargin) {
  const destinationStride = canvas.width * 4;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = outpaintPreservationAlpha(x, y, source, canvas, placement, blendMargin);
      const index = ((placement.y + y) * destinationStride) + ((placement.x + x) * 4);
      destination[index] = 255;
      destination[index + 1] = 255;
      destination[index + 2] = 255;
      destination[index + 3] = alpha;
    }
  }
}

function blendSourceRectangle(sourcePixels, source, destination, canvas, placement, blendMargin) {
  const sourceStride = source.width * 4;
  const destinationStride = canvas.width * 4;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = outpaintPreservationAlpha(x, y, source, canvas, placement, blendMargin);
      const sourceIndex = (y * sourceStride) + (x * 4);
      const destinationIndex = ((placement.y + y) * destinationStride) + ((placement.x + x) * 4);
      blendPixel(sourcePixels, sourceIndex, destination, destinationIndex, alpha);
    }
  }
}

function outpaintPreservationAlpha(x, y, source, canvas, placement, blendMargin) {
  if (blendMargin === 0) return 255;
  const distances = [];
  if (placement.x > 0) distances.push(x);
  if (placement.y > 0) distances.push(y);
  if (placement.x + source.width < canvas.width) distances.push(source.width - 1 - x);
  if (placement.y + source.height < canvas.height) distances.push(source.height - 1 - y);
  if (!distances.length) return 255;
  const distance = Math.min(...distances);
  if (distance >= blendMargin) return 255;
  const progress = Math.max(0, distance) / blendMargin;
  return Math.round((0.5 - (0.5 * Math.cos(Math.PI * progress))) * 255);
}

function blendRgbaByAlpha(source, destination, alpha) {
  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    blendPixel(source, pixel * 4, destination, pixel * 4, alpha[pixel]);
  }
}

function blendPixel(source, sourceIndex, destination, destinationIndex, alpha) {
  if (alpha <= 0) return;
  if (alpha >= 255) {
    source.copy(destination, destinationIndex, sourceIndex, sourceIndex + 4);
    return;
  }
  const inverse = 255 - alpha;
  for (let channel = 0; channel < 4; channel += 1) {
    destination[destinationIndex + channel] = Math.round(
      ((source[sourceIndex + channel] * alpha) + (destination[destinationIndex + channel] * inverse)) / 255,
    );
  }
}

async function maskAlpha(maskPixels, target, featherPixels) {
  let pipeline = sharp(maskPixels, {
    raw: { width: target.width, height: target.height, channels: 4 },
  }).extractChannel(3);
  if (featherPixels > 0) pipeline = pipeline.blur(Math.max(0.3, featherPixels / 2));
  return pipeline.raw().toBuffer();
}

async function resizeRawRgba(pixels, source, target, kernel) {
  return sharp(pixels, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .resize(target.width, target.height, { fit: "fill", kernel })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

async function transformCanvasBuffer(buffer, transform, mask) {
  let pipeline = sharp(normalizeBuffer(buffer, mask ? "outpaint mask" : "outpaint canvas"), {
    failOn: "error",
    limitInputPixels: MAX_CANVAS_PIXELS,
  });
  if (transform.kind === "rescale-and-crop") {
    pipeline = pipeline.resize(transform.scaledWidth, transform.scaledHeight, {
      fit: "fill",
      kernel: mask ? sharp.kernel.nearest : sharp.kernel.lanczos3,
    });
  }
  const right = transform.providerWidth - transform.scaledWidth - transform.offsetX;
  const bottom = transform.providerHeight - transform.scaledHeight - transform.offsetY;
  if (transform.offsetX || transform.offsetY || right || bottom) {
    pipeline = pipeline.extend({
      left: transform.offsetX,
      top: transform.offsetY,
      right,
      bottom,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

function normalizeCanvasTransform(plan) {
  const kind = String(plan?.transform?.kind || "none");
  if (!new Set(["none", "pad-and-crop", "rescale-and-crop"]).has(kind)) {
    throw invalidOutpaint("outpaint canvas transform is invalid");
  }
  const requested = normalizeCanvas(plan?.requested);
  const provider = normalizeCanvas(plan?.provider);
  const transform = plan?.transform || {};
  const offsetX = transform.offsetX;
  const offsetY = transform.offsetY;
  const scaledWidth = transform.scaledWidth;
  const scaledHeight = transform.scaledHeight;
  if (
    !Number.isSafeInteger(offsetX) || offsetX < 0
    || !Number.isSafeInteger(offsetY) || offsetY < 0
    || !Number.isSafeInteger(scaledWidth) || scaledWidth < 1
    || !Number.isSafeInteger(scaledHeight) || scaledHeight < 1
    || offsetX + scaledWidth > provider.width
    || offsetY + scaledHeight > provider.height
  ) throw invalidOutpaint("outpaint canvas transform bounds are invalid");
  if (kind !== "rescale-and-crop" && (scaledWidth !== requested.width || scaledHeight !== requested.height)) {
    throw invalidOutpaint("outpaint padding transform must preserve logical dimensions");
  }
  return {
    kind,
    requestedWidth: requested.width,
    requestedHeight: requested.height,
    providerWidth: provider.width,
    providerHeight: provider.height,
    offsetX,
    offsetY,
    scaledWidth,
    scaledHeight,
  };
}

async function encodeRgbaOutput(pixels, target, output) {
  if (output.zeroCompression) {
    let encodedPixels = pixels;
    if (output.format === "jpeg") {
      encodedPixels = await sharp(pixels, {
        raw: { width: target.width, height: target.height, channels: 4 },
      })
        .flatten({ background: output.background })
        .ensureAlpha()
        .raw()
        .toBuffer();
    }
    try {
      return await encodeZeroCompressionRgba({
        data: encodedPixels,
        width: target.width,
        height: target.height,
        format: output.format,
      });
    } catch (error) {
      throw outputEncodingFailed(output.format, error);
    }
  }
  let pipeline = sharp(pixels, {
    raw: { width: target.width, height: target.height, channels: 4 },
  });
  if (output.format === "png") return pipeline.png({ compressionLevel: output.compressionLevel }).toBuffer();
  if (output.format === "jpeg") {
    return pipeline.flatten({ background: output.background }).jpeg({ quality: output.quality }).toBuffer();
  }
  return pipeline.webp({ quality: output.quality }).toBuffer();
}

function normalizeOutputOptions(formatOrOptions, extraOptions, fallbackFormat) {
  let supplied;
  if (typeof formatOrOptions === "string") {
    supplied = { ...normalizePlainObject(extraOptions, "output options"), format: formatOrOptions };
  } else {
    supplied = normalizePlainObject(formatOrOptions, "output options");
  }

  const format = normalizeFormat(supplied.format ?? supplied.outputFormat ?? fallbackFormat);
  if (!SUPPORTED_FORMATS.has(format)) throw invalidOutpaint("output format must be png, jpeg, or webp");
  const outputCompression = supplied.outputCompression
    ?? (format === "png" ? undefined : supplied.compression);
  if (outputCompression !== undefined) {
    if (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
      throw invalidOutpaint("outputCompression must be an integer from 0 to 100");
    }
    if (outputCompression !== 0 && format === "png") {
      throw unsupportedOutputCompression(format, outputCompression);
    }
  }
  if (supplied.quality === 0) throw unsupportedOutputCompression(format, supplied.quality);
  const zeroCompression = format !== "png" && outputCompression === 0;
  const quality = supplied.quality
    ?? (format === "png" ? 90 : outputCompression ?? supplied.compression)
    ?? 90;
  if (!Number.isInteger(quality) || quality < (zeroCompression ? 0 : 1) || quality > 100) {
    throw invalidOutpaint("output quality must be an integer from 1 to 100");
  }
  const compressionLevel = supplied.compressionLevel
    ?? (format === "png" ? outputCompression ?? supplied.compression : undefined)
    ?? 9;
  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    throw invalidOutpaint("PNG compression must be an integer from 0 to 9");
  }
  return {
    format,
    quality,
    compressionLevel,
    zeroCompression,
    background: supplied.background ?? { r: 255, g: 255, b: 255 },
    blendMargin: supplied.blendMargin,
  };
}

function normalizeBlendMargin(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 512) {
    throw invalidOutpaint("blendMargin must be an integer from 0 to 512");
  }
  return value;
}

function normalizeMaskFeather(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 128) {
    throw invalidOutpaint("mask feather must be an integer from 0 to 128");
  }
  return value;
}

function normalizePlainObject(value, label) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalidOutpaint(`${label} must be an object`);
  }
  return value;
}

function normalizeFormat(format) {
  const normalized = String(format ?? "").trim().toLowerCase();
  return normalized === "jpg" ? "jpeg" : normalized;
}

function invalidOutpaint(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "INVALID_OUTPAINT";
  return error;
}

function unsupportedOutputCompression(format, outputCompression) {
  const error = invalidOutpaint(`outputCompression ${outputCompression} is not supported for ${format}`);
  error.reason = "OUTPUT_COMPRESSION_UNSUPPORTED";
  error.outputFormat = format;
  error.outputCompression = outputCompression;
  return error;
}

function outputEncodingFailed(format, cause) {
  const error = invalidOutpaint(`outputCompression 0 could not be encoded as ${format}`, cause);
  error.reason = "OUTPUT_ENCODING_FAILED";
  error.outputFormat = format;
  error.outputCompression = 0;
  return error;
}
