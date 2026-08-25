import fs from "node:fs/promises";
import sharp from "sharp";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 16_384;
const DEFAULT_MAX_PIXELS = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);
const FORMAT_MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[index] = value >>> 0;
}

export function inspectImageBuffer(input, options = {}) {
  if (!(input instanceof Uint8Array)) throw invalidImage("Image input must be a Buffer or Uint8Array");
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const limits = normalizeOptions(options);
  if (!buffer.length) throw invalidImage("Image data is empty");
  if (buffer.length > limits.maxBytes) throw invalidImage("Image file exceeds the byte limit");

  const format = detectFormat(buffer);
  if (!format) throw invalidImage("Unsupported or invalid image signature");
  if (!limits.allowedFormats.has(format)) throw invalidImage(`Image format ${format} is not allowed`);

  const dimensions = format === "png"
    ? inspectPng(buffer)
    : format === "jpeg"
      ? inspectJpeg(buffer)
      : inspectWebp(buffer);
  validateDimensions(dimensions.width, dimensions.height, limits);
  return {
    format,
    mediaType: FORMAT_MEDIA_TYPES[format],
    width: dimensions.width,
    height: dimensions.height,
    size: buffer.length,
  };
}

export async function inspectDecodedImageBuffer(input, options = {}) {
  const inspected = inspectImageBuffer(input, options);
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const limits = normalizeOptions(options);

  try {
    const image = sharp(buffer, {
      animated: true,
      failOn: "warning",
      limitInputPixels: limits.maxPixels,
    });
    const metadata = await image.metadata();
    const decodedFormat = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (decodedFormat !== inspected.format) throw invalidImage("Decoded image format is inconsistent");
    if ((metadata.pages ?? 1) !== 1) throw invalidImage("Image must contain exactly one frame");
    if (metadata.width !== inspected.width || metadata.height !== inspected.height) {
      throw invalidImage("Decoded image dimensions are inconsistent");
    }

    const decoded = await image.clone().raw().toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== inspected.width
      || decoded.info.height !== inspected.height
      || !Number.isSafeInteger(decoded.info.channels)
      || decoded.info.channels < 1
      || decoded.data.length !== inspected.width * inspected.height * decoded.info.channels
    ) throw invalidImage("Decoded pixel data is incomplete");
  } catch (error) {
    if (error?.code === "INVALID_IMAGE") throw error;
    throw invalidImage("Image pixel data could not be fully decoded", error);
  }
  return inspected;
}

/**
 * Validate an image directly from a server-owned file without first loading
 * the encoded bytes into the main process. This is used by map resource
 * transactions where a candidate may be much larger than the normal request
 * body limit. The caller has already established that the path is inside a
 * controlled directory; sharp still performs the full decode and pixel-size
 * checks so a forged header or truncated payload cannot pass publication.
 */
export async function inspectDecodedImageFile(filename, options = {}) {
  if (typeof filename !== "string" || !filename || filename.includes("\0")) {
    throw invalidImage("Image filename is invalid");
  }
  const limits = normalizeOptions(options);
  let stat;
  try {
    stat = await fs.lstat(filename);
  } catch (error) {
    throw invalidImage("Image file could not be read", error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw invalidImage("Image file is empty or not a regular file");
  if (stat.size > limits.maxBytes) throw invalidImage("Image file exceeds the byte limit");
  let image;
  try {
    image = sharp(filename, {
      animated: true,
      failOn: "warning",
      limitInputPixels: limits.maxPixels,
    });
    const metadata = await image.metadata();
    const decodedFormat = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (!FORMAT_MEDIA_TYPES[decodedFormat] || !limits.allowedFormats.has(decodedFormat)) {
      throw invalidImage("Image format is not allowed");
    }
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    validateDimensions(width, height, limits);
    if ((metadata.pages ?? 1) !== 1) throw invalidImage("Image must contain exactly one frame");
    const decoded = await image.clone().raw().toBuffer({ resolveWithObject: true });
    const after = await fs.lstat(filename);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw invalidImage("Image file changed during decode");
    }
    if (
      decoded.info.width !== width
      || decoded.info.height !== height
      || !Number.isSafeInteger(decoded.info.channels)
      || decoded.info.channels < 1
      || decoded.data.length !== width * height * decoded.info.channels
    ) throw invalidImage("Decoded pixel data is incomplete");
    return {
      format: decodedFormat,
      mediaType: FORMAT_MEDIA_TYPES[decodedFormat],
      width,
      height,
      size: stat.size,
    };
  } catch (error) {
    if (error?.code === "INVALID_IMAGE") throw error;
    throw invalidImage("Image pixel data could not be fully decoded", error);
  }
}

export const validateImageFile = inspectDecodedImageBuffer;

function detectFormat(buffer) {
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "png";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "webp";
  return null;
}

function inspectPng(buffer) {
  if (buffer.length < 45) throw invalidImage("PNG data is truncated");
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = null;
  let bitDepth = null;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw invalidImage("PNG chunk header is truncated");
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > buffer.length) throw invalidImage("PNG chunk is truncated");
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const type = buffer.subarray(typeStart, dataStart).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalidImage("PNG contains an invalid chunk type");
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (pngCrc32(buffer, typeStart, dataEnd) !== expectedCrc) throw invalidImage("PNG chunk checksum is invalid");
    if (!sawHeader && type !== "IHDR") throw invalidImage("PNG IHDR must be the first chunk");
    if (sawEnd) throw invalidImage("PNG contains data after IEND");

    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw invalidImage("PNG IHDR is invalid");
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      if (!validPngBitDepth(bitDepth, colorType) || compression !== 0 || filter !== 0 || interlace > 1) {
        throw invalidImage("PNG IHDR uses unsupported values");
      }
      sawHeader = true;
    } else if (type === "PLTE") {
      if (sawPalette || sawImageData || colorType === 0 || colorType === 4 || !length || length % 3 !== 0 || length > 768) {
        throw invalidImage("PNG palette is invalid");
      }
      if (colorType === 3 && length / 3 > (1 << bitDepth)) throw invalidImage("PNG palette exceeds its bit depth");
      sawPalette = true;
    } else if (type === "IDAT") {
      if (!sawHeader || imageDataEnded || (colorType === 3 && !sawPalette) || !length) {
        throw invalidImage("PNG image data is invalid");
      }
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData) throw invalidImage("PNG IEND is invalid");
      sawEnd = true;
    } else {
      if (sawImageData) imageDataEnded = true;
      if ((buffer[typeStart] & 0x20) === 0) throw invalidImage(`PNG contains unknown critical chunk ${type}`);
    }

    if (type !== "IDAT" && sawImageData && type !== "IEND") imageDataEnded = true;
    offset = chunkEnd;
    if (sawEnd) break;
  }

  if (!sawHeader || !sawImageData || !sawEnd || offset !== buffer.length) throw invalidImage("PNG structure is incomplete");
  return { width, height };
}

function inspectJpeg(buffer) {
  if (buffer.length < 14) throw invalidImage("JPEG data is truncated");
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw invalidImage("JPEG marker is invalid");
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) throw invalidImage("JPEG marker is truncated");
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8) throw invalidImage("JPEG marker is invalid");
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== buffer.length) throw invalidImage("JPEG EOI is invalid");
      return { width, height };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) throw invalidImage("JPEG segment length is truncated");
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw invalidImage("JPEG segment is truncated");
    const dataStart = offset + 2;
    const segmentEnd = offset + length;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 11) throw invalidImage("JPEG frame header is truncated");
      const frameHeight = buffer.readUInt16BE(dataStart + 1);
      const frameWidth = buffer.readUInt16BE(dataStart + 3);
      const components = buffer[dataStart + 5];
      if (!components || length !== 8 + (3 * components)) throw invalidImage("JPEG frame header is invalid");
      if (sawFrame && (width !== frameWidth || height !== frameHeight)) throw invalidImage("JPEG frame dimensions conflict");
      width = frameWidth;
      height = frameHeight;
      sawFrame = true;
    }

    offset = segmentEnd;
    if (marker !== 0xda) continue;
    if (!sawFrame || length < 8) throw invalidImage("JPEG scan header is invalid");
    const components = buffer[dataStart];
    if (!components || length !== 6 + (2 * components)) throw invalidImage("JPEG scan header is invalid");
    sawScan = true;
    const scanStart = offset;
    offset = findJpegScanMarker(buffer, offset);
    if (offset === scanStart) throw invalidImage("JPEG scan is empty");
  }
  throw invalidImage("JPEG is missing EOI");
}

function findJpegScanMarker(buffer, offset) {
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerStart = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) throw invalidImage("JPEG scan data is truncated");
    const marker = buffer[offset];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerStart;
  }
  throw invalidImage("JPEG scan data is truncated");
}

function inspectWebp(buffer) {
  if (buffer.length < 20) throw invalidImage("WebP data is truncated");
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize < 12 || riffSize + 8 !== buffer.length) throw invalidImage("WebP RIFF size is invalid");
  let offset = 12;
  let width = 0;
  let height = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let extendedFlags = 0;
  let sawExtendedHeader = false;
  let sawImage = false;
  let sawAnimationFrame = false;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw invalidImage("WebP chunk header is truncated");
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > buffer.length) throw invalidImage("WebP chunk is truncated");

    if (type === "VP8X") {
      if (offset !== 12 || sawExtendedHeader || length !== 10) throw invalidImage("WebP VP8X header is invalid");
      extendedFlags = buffer[dataStart];
      if ((extendedFlags & 0xc1) !== 0 || buffer[dataStart + 1] || buffer[dataStart + 2] || buffer[dataStart + 3]) {
        throw invalidImage("WebP VP8X reserved bits are invalid");
      }
      canvasWidth = readUInt24LE(buffer, dataStart + 4) + 1;
      canvasHeight = readUInt24LE(buffer, dataStart + 7) + 1;
      width = canvasWidth;
      height = canvasHeight;
      sawExtendedHeader = true;
    } else if (type === "VP8 ") {
      const dimensions = inspectVp8Chunk(buffer, dataStart, length);
      if (sawImage || sawAnimationFrame) throw invalidImage("WebP contains multiple primary images");
      width ||= dimensions.width;
      height ||= dimensions.height;
      if (sawExtendedHeader && (dimensions.width !== canvasWidth || dimensions.height !== canvasHeight)) {
        throw invalidImage("WebP image dimensions do not match its canvas");
      }
      sawImage = true;
    } else if (type === "VP8L") {
      const dimensions = inspectVp8lChunk(buffer, dataStart, length);
      if (sawImage || sawAnimationFrame) throw invalidImage("WebP contains multiple primary images");
      width ||= dimensions.width;
      height ||= dimensions.height;
      if (sawExtendedHeader && (dimensions.width !== canvasWidth || dimensions.height !== canvasHeight)) {
        throw invalidImage("WebP image dimensions do not match its canvas");
      }
      sawImage = true;
    } else if (type === "ANMF") {
      if (!sawExtendedHeader || (extendedFlags & 0x02) === 0 || length < 16) {
        throw invalidImage("WebP animation frame is invalid");
      }
      const frameX = readUInt24LE(buffer, dataStart) * 2;
      const frameY = readUInt24LE(buffer, dataStart + 3) * 2;
      const frameWidth = readUInt24LE(buffer, dataStart + 6) + 1;
      const frameHeight = readUInt24LE(buffer, dataStart + 9) + 1;
      if (frameX + frameWidth > canvasWidth || frameY + frameHeight > canvasHeight) {
        throw invalidImage("WebP animation frame exceeds its canvas");
      }
      inspectWebpFramePayload(buffer, dataStart + 16, dataEnd, frameWidth, frameHeight);
      sawAnimationFrame = true;
    }
    offset = chunkEnd;
  }

  if (
    offset !== buffer.length
    || (!sawImage && !sawAnimationFrame)
    || ((extendedFlags & 0x02) !== 0 && !sawAnimationFrame)
    || !width
    || !height
  ) {
    throw invalidImage("WebP structure is incomplete");
  }
  return { width, height };
}

function inspectVp8Chunk(buffer, offset, length) {
  if (length < 10 || (buffer[offset] & 1) !== 0) throw invalidImage("WebP VP8 key frame is invalid");
  if (buffer[offset + 3] !== 0x9d || buffer[offset + 4] !== 0x01 || buffer[offset + 5] !== 0x2a) {
    throw invalidImage("WebP VP8 frame signature is invalid");
  }
  const frameTag = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  const firstPartitionLength = frameTag >>> 5;
  if (!firstPartitionLength || 10 + firstPartitionLength > length) throw invalidImage("WebP VP8 frame is truncated");
  return {
    width: buffer.readUInt16LE(offset + 6) & 0x3fff,
    height: buffer.readUInt16LE(offset + 8) & 0x3fff,
  };
}

function inspectVp8lChunk(buffer, offset, length) {
  if (length < 6 || buffer[offset] !== 0x2f) throw invalidImage("WebP VP8L frame signature is invalid");
  const bits = buffer.readUInt32LE(offset + 1);
  if ((bits >>> 29) !== 0) throw invalidImage("WebP VP8L version is unsupported");
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

function inspectWebpFramePayload(buffer, start, end, expectedWidth, expectedHeight) {
  let offset = start;
  let sawAlpha = false;
  let sawImage = false;
  while (offset < end) {
    if (offset + 8 > end) throw invalidImage("WebP animation frame chunk is truncated");
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > end) throw invalidImage("WebP animation frame chunk is truncated");
    if (type === "ALPH") {
      if (sawAlpha || sawImage || !length) throw invalidImage("WebP animation alpha chunk is invalid");
      sawAlpha = true;
    } else if (type === "VP8 " || type === "VP8L") {
      if (sawImage) throw invalidImage("WebP animation frame contains multiple images");
      const dimensions = type === "VP8 "
        ? inspectVp8Chunk(buffer, dataStart, length)
        : inspectVp8lChunk(buffer, dataStart, length);
      if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
        throw invalidImage("WebP animation image dimensions do not match its frame");
      }
      sawImage = true;
    } else {
      throw invalidImage(`WebP animation frame contains invalid chunk ${type}`);
    }
    offset = chunkEnd;
  }
  if (!sawImage || offset !== end) throw invalidImage("WebP animation frame is incomplete");
}

function normalizeOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw invalidOption("options must be an object");
  return {
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
    maxWidth: positiveInteger(options.maxWidth, DEFAULT_MAX_DIMENSION, "maxWidth"),
    maxHeight: positiveInteger(options.maxHeight, DEFAULT_MAX_DIMENSION, "maxHeight"),
    maxPixels: positiveInteger(options.maxPixels, DEFAULT_MAX_PIXELS, "maxPixels"),
    allowedFormats: normalizeAllowedFormats(options.allowedFormats),
  };
}

function normalizeAllowedFormats(value) {
  if (value === undefined) return new Set(Object.keys(FORMAT_MEDIA_TYPES));
  if (!Array.isArray(value) && !(value instanceof Set)) throw invalidOption("allowedFormats must be an array or Set");
  const formats = new Set();
  for (const entry of value) {
    const format = String(entry || "").trim().toLowerCase();
    formats.add(format === "jpg" ? "jpeg" : format);
  }
  if (!formats.size || [...formats].some((format) => !FORMAT_MEDIA_TYPES[format])) {
    throw invalidOption("allowedFormats contains an unsupported format");
  }
  return formats;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidOption(`${name} must be a positive safe integer`);
  return value;
}

function validateDimensions(width, height, limits) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw invalidImage("Image dimensions must be positive integers");
  }
  if (width > limits.maxWidth || height > limits.maxHeight) throw invalidImage("Image dimensions exceed the configured limit");
  if (width * height > limits.maxPixels) throw invalidImage("Image pixel count exceeds the configured limit");
}

function validPngBitDepth(bitDepth, colorType) {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return false;
}

function pngCrc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC_TABLE[(crc ^ buffer[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function invalidImage(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "INVALID_IMAGE" });
}

function invalidOption(message) {
  return Object.assign(new TypeError(message), { code: "INVALID_IMAGE_OPTION" });
}
