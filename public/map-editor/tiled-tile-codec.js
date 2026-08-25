const BASE64_ENCODING = "base64";
const COMPRESSION_FORMATS = Object.freeze({
  gzip: "gzip",
  zlib: "deflate",
  zstd: "zstd",
});

export class TiledTileCodecError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "TiledTileCodecError";
    this.code = code;
  }
}

export async function decodeTiledTileData(document, options = {}) {
  if (!isRecord(document) || !Array.isArray(document.layers)) {
    throw codecError("invalid-map", "Tiled 地图缺少可解码的图层");
  }
  const stats = { layers: 0, blocks: 0, cells: 0, encodedBytes: 0 };
  for (const layer of tiledLayers(document.layers)) {
    const decoded = await decodeLayer(layer, options, stats);
    if (decoded !== layer) Object.assign(layer, decoded);
  }
  return stats;
}

export async function encodeTiledTileData(document, options = {}) {
  if (!isRecord(document) || !Array.isArray(document.layers)) {
    throw codecError("invalid-map", "Tiled 地图缺少可编码的图层");
  }
  const stats = { layers: 0, blocks: 0, cells: 0, encodedBytes: 0 };
  for (const layer of tiledLayers(document.layers)) {
    await encodeLayer(layer, options, stats);
  }
  return stats;
}

export async function decodeTiledTileLayer(layer, options = {}) {
  if (!isRecord(layer) || layer.type !== "tilelayer") return layer;
  return decodeLayer(layer, options, { layers: 0, blocks: 0, cells: 0, encodedBytes: 0 });
}

async function decodeLayer(layer, options, stats) {
  const encodedData = typeof layer.data === "string";
  const encodedChunks = Array.isArray(layer.chunks)
    && layer.chunks.some((chunk) => typeof chunk?.data === "string");
  if (!encodedData && !encodedChunks) return layer;
  requireBase64Encoding(layer);
  const decoded = { ...layer };
  stats.layers += 1;
  if (encodedData) {
    const cells = expectedCells(layer.width, layer.height, "瓦片层");
    const result = await decodeBlock(layer.data, layer.compression, cells, options);
    decoded.data = result.data;
    addStats(stats, result, cells);
  }
  if (encodedChunks) {
    decoded.chunks = [];
    for (const [index, chunk] of layer.chunks.entries()) {
      if (typeof chunk?.data !== "string") {
        decoded.chunks.push(chunk);
        continue;
      }
      const cells = expectedCells(chunk.width, chunk.height, `瓦片分块 ${index + 1}`, { positive: true });
      const result = await decodeBlock(chunk.data, layer.compression, cells, options);
      decoded.chunks.push({ ...chunk, data: result.data });
      addStats(stats, result, cells);
    }
  }
  return decoded;
}

async function encodeLayer(layer, options, stats) {
  if (!isRecord(layer) || layer.type !== "tilelayer" || layer.encoding !== BASE64_ENCODING) return;
  let encoded = false;
  if (Array.isArray(layer.data)) {
    const cells = expectedCells(layer.width, layer.height, "瓦片层");
    const result = await encodeBlock(layer.data, layer.compression, cells, options);
    layer.data = result.data;
    addStats(stats, result, cells);
    encoded = true;
  }
  if (Array.isArray(layer.chunks)) {
    for (const [index, chunk] of layer.chunks.entries()) {
      if (!Array.isArray(chunk?.data)) continue;
      const cells = expectedCells(chunk.width, chunk.height, `瓦片分块 ${index + 1}`, { positive: true });
      const result = await encodeBlock(chunk.data, layer.compression, cells, options);
      chunk.data = result.data;
      addStats(stats, result, cells);
      encoded = true;
    }
  }
  if (encoded) stats.layers += 1;
}

async function decodeBlock(source, compression, cells, options) {
  throwIfAborted(options.signal);
  let bytes = base64ToBytes(source);
  const encodedBytes = bytes.byteLength;
  if (compression) {
    bytes = await transformBytes(bytes, compression, "decompress", {
      maximumBytes: cells * 4,
      signal: options.signal,
    });
  }
  const expectedBytes = cells * 4;
  if (bytes.byteLength !== expectedBytes) {
    throw codecError(
      "tile-data-size-mismatch",
      `Tiled 瓦片数据解码为 ${bytes.byteLength} 字节，预期 ${expectedBytes} 字节`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Array(cells);
  for (let index = 0; index < cells; index += 1) data[index] = view.getUint32(index * 4, true);
  return { data, encodedBytes };
}

async function encodeBlock(data, compression, cells, options) {
  if (data.length !== cells) {
    throw codecError("tile-data-size-mismatch", `Tiled 瓦片数据包含 ${data.length} 项，预期 ${cells} 项`);
  }
  let bytes;
  try {
    bytes = new Uint8Array(cells * 4);
  } catch (cause) {
    throw codecError("tile-data-too-large", "Tiled 瓦片数据超过当前浏览器可编码范围", { cause });
  }
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < cells; index += 1) {
    const value = Number(data[index]);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw codecError("invalid-gid", `Tiled 瓦片数据第 ${index + 1} 项不是有效 GID`);
    }
    view.setUint32(index * 4, value, true);
  }
  throwIfAborted(options.signal);
  if (compression) bytes = await transformBytes(bytes, compression, "compress", { signal: options.signal });
  const encoded = bytesToBase64(bytes);
  return { data: encoded, encodedBytes: bytes.byteLength };
}

async function transformBytes(source, compression, direction, options = {}) {
  const format = COMPRESSION_FORMATS[compression];
  const Constructor = direction === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (!format || typeof Constructor !== "function") {
    throw codecError("unsupported-compression", `当前环境不支持 Tiled ${compression} 瓦片数据${direction === "compress" ? "压缩" : "解压"}`);
  }
  let transform;
  try {
    transform = new Constructor(format);
  } catch (cause) {
    throw codecError("unsupported-compression", `当前环境不支持 Tiled ${compression} 瓦片数据${direction === "compress" ? "压缩" : "解压"}`, { cause });
  }
  const reader = new Blob([source]).stream().pipeThrough(transform).getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (options.maximumBytes != null && total > options.maximumBytes) {
        await reader.cancel().catch(() => {});
        throw codecError("tile-data-size-mismatch", "Tiled 压缩瓦片数据解压后超过声明图层大小");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TiledTileCodecError || error?.code === "ABORT_ERR") throw error;
    throw codecError("invalid-compressed-tile-data", `无法${direction === "compress" ? "压缩" : "解压"} Tiled ${compression} 瓦片数据`, { cause: error });
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function base64ToBytes(value) {
  const source = String(value).replace(/\s+/gu, "");
  if (source.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(source)) {
    throw codecError("invalid-base64", "Tiled Base64 瓦片数据不正确");
  }
  const padded = source.padEnd(Math.ceil(source.length / 4) * 4, "=");
  const padding = padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0;
  let bytes;
  try {
    bytes = new Uint8Array(padded.length / 4 * 3 - padding);
  } catch (cause) {
    throw codecError("tile-data-too-large", "Tiled Base64 瓦片数据超过当前浏览器可解码范围", { cause });
  }
  let targetOffset = 0;
  const chunkCharacters = 32_768;
  try {
    for (let offset = 0; offset < padded.length; offset += chunkCharacters) {
      const binary = atob(padded.slice(offset, Math.min(padded.length, offset + chunkCharacters)));
      for (let index = 0; index < binary.length; index += 1) bytes[targetOffset++] = binary.charCodeAt(index);
    }
  } catch (cause) {
    throw codecError("invalid-base64", "Tiled Base64 瓦片数据不正确", { cause });
  }
  return bytes;
}

function bytesToBase64(bytes) {
  const chunks = [];
  const chunkBytes = 24_576;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
    let binary = "";
    for (let index = 0; index < chunk.byteLength; index += 1) binary += String.fromCharCode(chunk[index]);
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}

function expectedCells(widthValue, heightValue, label, options = {}) {
  const width = Number(widthValue);
  const height = Number(heightValue);
  const minimum = options.positive ? 1 : 0;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < minimum || height < minimum) {
    throw codecError("invalid-tile-dimensions", `${label}尺寸不正确`);
  }
  const cells = width * height;
  if (!Number.isSafeInteger(cells) || cells > Math.floor(0xffff_ffff / 4)) {
    throw codecError("tile-data-too-large", `${label}瓦片数量超过当前浏览器可处理范围`);
  }
  return cells;
}

function requireBase64Encoding(layer) {
  if (layer.encoding !== BASE64_ENCODING) {
    throw codecError("unsupported-encoding", `Tiled 字符串瓦片数据必须使用 ${BASE64_ENCODING} 编码`);
  }
}

function addStats(stats, result, cells) {
  stats.blocks += 1;
  stats.cells += cells;
  stats.encodedBytes += result.encodedBytes;
}

function* tiledLayers(layers) {
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (!isRecord(layer)) continue;
    yield layer;
    if (Array.isArray(layer.layers)) yield* tiledLayers(layer.layers);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error("Tiled 瓦片数据编解码已取消"), { name: "AbortError", code: "ABORT_ERR" });
}

function codecError(code, message, options = {}) {
  return new TiledTileCodecError(code, message, options);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
