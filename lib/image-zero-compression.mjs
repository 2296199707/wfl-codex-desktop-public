import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MAX_DIMENSION = 3_840;
const MAX_PIXELS = 8_294_400;
const FORMATS = new Set(["jpeg", "webp"]);

let jpegEncoderPromise = null;
let webpEncoderPromise = null;

export async function encodeZeroCompressionRgba({ data, width, height, format } = {}) {
  const normalized = normalizeInput({ data, width, height, format });
  try {
    const encode = await encoderFor(normalized.format);
    const encoded = await encode({
      data: new Uint8ClampedArray(
        normalized.data.buffer,
        normalized.data.byteOffset,
        normalized.data.byteLength,
      ),
      width: normalized.width,
      height: normalized.height,
    }, { quality: 0 });
    const result = Buffer.from(new Uint8Array(encoded));
    if (!result.length) throw new Error("encoder returned an empty image");
    return result;
  } catch (cause) {
    if (cause?.code === "INVALID_ZERO_COMPRESSION_INPUT") throw cause;
    throw codecError(normalized.format, cause);
  }
}

function normalizeInput({ data, width, height, format }) {
  if (!FORMATS.has(format)) throw invalidInput("format must be jpeg or webp");
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > MAX_DIMENSION
    || height > MAX_DIMENSION
    || width * height > MAX_PIXELS
  ) throw invalidInput("image dimensions are outside the supported range");
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw invalidInput("image pixels must be a Buffer or Uint8Array");
  }
  const expectedBytes = width * height * 4;
  if (data.byteLength !== expectedBytes) throw invalidInput("image pixels must contain RGBA data");
  return {
    data: Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    width,
    height,
    format,
  };
}

function encoderFor(format) {
  if (format === "jpeg") {
    jpegEncoderPromise ||= initializeJpegEncoder();
    return jpegEncoderPromise;
  }
  webpEncoderPromise ||= initializeWebpEncoder();
  return webpEncoderPromise;
}

async function initializeJpegEncoder() {
  const [{ default: encode, init }, wasmModule] = await Promise.all([
    import("@jsquash/jpeg/encode.js"),
    compilePackageWasm("@jsquash/jpeg", "codec/enc/mozjpeg_enc.wasm"),
  ]);
  await init(wasmModule);
  return encode;
}

async function initializeWebpEncoder() {
  const encoder = await import("@jsquash/webp/encode.js");
  let wasmModule;
  try {
    wasmModule = await compilePackageWasm("@jsquash/webp", "codec/enc/webp_enc_simd.wasm");
  } catch {
    wasmModule = await compilePackageWasm("@jsquash/webp", "codec/enc/webp_enc.wasm");
  }
  await encoder.init(wasmModule);
  return encoder.default;
}

async function compilePackageWasm(packageName, relativePath) {
  const packageDirectory = path.dirname(require.resolve(`${packageName}/package.json`));
  const bytes = await fs.readFile(path.join(packageDirectory, relativePath));
  return WebAssembly.compile(bytes);
}

function invalidInput(message) {
  return Object.assign(new TypeError(message), {
    code: "INVALID_ZERO_COMPRESSION_INPUT",
    statusCode: 400,
    retryable: false,
  });
}

function codecError(format, cause) {
  return Object.assign(
    new Error(`could not encode ${format} with outputCompression 0`, { cause }),
    {
      code: "IMAGE_ZERO_COMPRESSION_FAILED",
      statusCode: 500,
      retryable: false,
      outputFormat: format,
      outputCompression: 0,
    },
  );
}
