const DEFAULT_MAX_CELLS = 1_000_000;
const BUCKET_SIZE = 64;

export function findTiledFillRegion(request) {
  const blocks = normalizeBlocks(request?.blocks);
  const startX = safeInteger(request?.x, "x");
  const startY = safeInteger(request?.y, "y");
  const replacement = tiledGid(request?.replacement, "replacement");
  const maxCells = positiveInteger(request?.maxCells ?? DEFAULT_MAX_CELLS, "maxCells");
  const index = spatialIndex(blocks);
  const initial = addressAt(blocks, index, startX, startY);
  if (!initial) throw fillError("tile-outside-layer", "填充起点位于可编辑图层范围外");
  const target = blocks[initial.blockIndex].data[initial.localIndex] >>> 0;
  if (target === replacement) {
    return emptyResult(target, replacement);
  }

  const visited = new Array(blocks.length);
  let stack = new Int32Array(Math.min(maxCells, 4096) * 2);
  let stackSize = 0;
  let result = new Int32Array(Math.min(maxCells, 4096) * 2);
  let resultSize = 0;
  const bounds = { minX: startX, minY: startY, maxX: startX, maxY: startY };

  const push = (address) => {
    if (!address) return;
    const block = blocks[address.blockIndex];
    if ((block.data[address.localIndex] >>> 0) !== target) return;
    const marks = visited[address.blockIndex] || (visited[address.blockIndex] = new Uint8Array(block.data.length));
    if (marks[address.localIndex]) return;
    if (resultSize + stackSize >= maxCells) {
      throw fillError("fill-capacity", `连续区域超过手动上限 ${maxCells} 格，请缩小区域或调整地图结构`);
    }
    marks[address.localIndex] = 1;
    if ((stackSize + 1) * 2 > stack.length) stack = growPairs(stack, maxCells);
    stack[stackSize * 2] = address.blockIndex;
    stack[stackSize * 2 + 1] = address.localIndex;
    stackSize += 1;
  };

  push(initial);
  while (stackSize > 0) {
    stackSize -= 1;
    const blockIndex = stack[stackSize * 2];
    const localIndex = stack[stackSize * 2 + 1];
    const block = blocks[blockIndex];
    const localX = localIndex % block.width;
    const localY = Math.floor(localIndex / block.width);
    const x = block.x + localX;
    const y = block.y + localY;
    if ((resultSize + 1) * 2 > result.length) result = growPairs(result, maxCells);
    result[resultSize * 2] = blockIndex;
    result[resultSize * 2 + 1] = localIndex;
    resultSize += 1;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    push(addressAt(blocks, index, x - 1, y));
    push(addressAt(blocks, index, x + 1, y));
    push(addressAt(blocks, index, x, y - 1));
    push(addressAt(blocks, index, x, y + 1));
  }

  return {
    addresses: result.slice(0, resultSize * 2),
    target,
    replacement,
    count: resultSize,
    bounds: Object.freeze({ ...bounds }),
  };
}

/** Apply a compact fill to a structured-cloned Tiled document inside a Worker. */
export function applyTiledFillResultToSnapshot(document, layerId, result) {
  const layer = findLayerById(document?.layers, layerId);
  if (!layer || layer.type !== "tilelayer") {
    throw fillError("invalid-fill-layer", `找不到填充目标图层 ${layerId}`);
  }
  if (!result || !(result.addresses instanceof Int32Array) || result.addresses.length !== result.count * 2) {
    throw fillError("invalid-fill-result", "填充结果格式无效");
  }
  const replacement = tiledGid(result.replacement, "replacement");
  const target = tiledGid(result.target, "target");
  const descriptors = result.blocks;
  if (!Array.isArray(descriptors) || !descriptors.length) {
    throw fillError("invalid-fill-result", "填充结果缺少瓦片块定位信息");
  }
  const blocks = descriptors.map((descriptor, index) => {
    let block = null;
    if (descriptor?.kind === "data" && Array.isArray(layer.data)) {
      block = layer;
    } else if (descriptor?.kind === "chunk" && Array.isArray(layer.chunks)) {
      const matches = layer.chunks.filter((chunk) => chunk.x === descriptor.x && chunk.y === descriptor.y);
      if (matches.length === 1) [block] = matches;
    }
    const blockX = Number(descriptor?.kind === "chunk" ? block?.x : block?.startx ?? 0);
    const blockY = Number(descriptor?.kind === "chunk" ? block?.y : block?.starty ?? 0);
    if (
      !block
      || blockX !== descriptor.x
      || blockY !== descriptor.y
      || Number(block.width) !== descriptor.width
      || Number(block.height) !== descriptor.height
      || !Array.isArray(block.data)
      || block.data.length !== descriptor.width * descriptor.height
    ) throw fillError("invalid-fill-result", `填充块 ${index + 1} 与地图快照不一致`);
    return block;
  });
  const visited = blocks.map((block) => new Uint8Array(block.data.length));
  for (let index = 0; index < result.addresses.length; index += 2) {
    const blockIndex = result.addresses[index];
    const localIndex = result.addresses[index + 1];
    const block = blocks[blockIndex];
    if (!block || localIndex < 0 || localIndex >= block.data.length || visited[blockIndex][localIndex]) {
      throw fillError("invalid-fill-result", "填充结果包含无效或重复的瓦片地址");
    }
    visited[blockIndex][localIndex] = 1;
    if ((Number(block.data[localIndex]) >>> 0) !== target) {
      throw fillError("invalid-fill-result", "填充结果与地图快照内容不一致");
    }
  }
  for (let index = 0; index < result.addresses.length; index += 2) {
    blocks[result.addresses[index]].data[result.addresses[index + 1]] = replacement;
  }
  return document;
}

function normalizeBlocks(value) {
  if (!Array.isArray(value) || !value.length) throw fillError("invalid-fill-layer", "瓦片层没有可填充数据");
  return value.map((source, blockIndex) => {
    const x = safeInteger(source?.x, `blocks[${blockIndex}].x`);
    const y = safeInteger(source?.y, `blocks[${blockIndex}].y`);
    const width = positiveInteger(source?.width, `blocks[${blockIndex}].width`);
    const height = positiveInteger(source?.height, `blocks[${blockIndex}].height`);
    const cells = width * height;
    if (!Number.isSafeInteger(cells) || cells > 0x3fff_ffff) {
      throw fillError("invalid-fill-layer", "瓦片块尺寸超过浏览器安全范围");
    }
    const data = source?.data instanceof Uint32Array
      ? source.data
      : Uint32Array.from(source?.data || [], (entry) => tiledGid(entry, "tile gid"));
    if (data.length !== cells) throw fillError("invalid-fill-layer", "瓦片块数据长度与尺寸不一致");
    return { x, y, width, height, data };
  });
}

function findLayerById(layers, layerId) {
  if (!Array.isArray(layers)) return null;
  for (const layer of layers) {
    if (layer?.id === layerId) return layer;
    const nested = findLayerById(layer?.layers, layerId);
    if (nested) return nested;
  }
  return null;
}

function spatialIndex(blocks) {
  const buckets = new Map();
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const left = Math.floor(block.x / BUCKET_SIZE);
    const right = Math.floor((block.x + block.width - 1) / BUCKET_SIZE);
    const top = Math.floor(block.y / BUCKET_SIZE);
    const bottom = Math.floor((block.y + block.height - 1) / BUCKET_SIZE);
    for (let bucketY = top; bucketY <= bottom; bucketY += 1) {
      for (let bucketX = left; bucketX <= right; bucketX += 1) {
        const key = `${bucketX},${bucketY}`;
        const entries = buckets.get(key) || [];
        entries.push(blockIndex);
        buckets.set(key, entries);
      }
    }
  }
  return buckets;
}

function addressAt(blocks, buckets, x, y) {
  const candidates = buckets.get(`${Math.floor(x / BUCKET_SIZE)},${Math.floor(y / BUCKET_SIZE)}`) || [];
  let match = null;
  for (const blockIndex of candidates) {
    const block = blocks[blockIndex];
    if (x < block.x || y < block.y || x >= block.x + block.width || y >= block.y + block.height) continue;
    if (match) throw fillError("invalid-fill-layer", "无限地图瓦片块发生重叠，不能安全填充");
    match = {
      blockIndex,
      localIndex: (y - block.y) * block.width + x - block.x,
    };
  }
  return match;
}

function growPairs(source, maximumPairs) {
  const currentPairs = source.length / 2;
  const nextPairs = Math.min(maximumPairs, Math.max(currentPairs + 1, currentPairs * 2));
  const result = new Int32Array(nextPairs * 2);
  result.set(source);
  return result;
}

function emptyResult(target, replacement) {
  return {
    addresses: new Int32Array(0),
    target,
    replacement,
    count: 0,
    bounds: null,
  };
}

function tiledGid(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw fillError("invalid-fill-request", `${label} 必须是有效的 Tiled GID`);
  }
  return number >>> 0;
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw fillError("invalid-fill-request", `${label} 必须是安全整数`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw fillError("invalid-fill-request", `${label} 必须是正整数`);
  }
  return number;
}

function fillError(code, message) {
  const error = new Error(message);
  error.name = "TiledFillError";
  error.code = code;
  return error;
}
