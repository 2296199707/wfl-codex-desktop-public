import assert from "node:assert/strict";
import test from "node:test";
import {
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
} from "node:zlib";
import { TiledEditDocument } from "../public/map-editor/tiled-edit-document.js";
import {
  decodeTiledTileData,
  decodeTiledTileLayer,
  encodeTiledTileData,
  TiledTileCodecError,
} from "../public/map-editor/tiled-tile-codec.js";

test("round-trips uncompressed Base64 tile data and preserves unknown fields", async () => {
  const gids = [0, 1, 2, 0x8000_0001, 0x4000_0002, 0x2000_0001, 3, 0];
  const document = finiteMap({
    data: `\n${encodeGids(gids).replace(/(.{12})/gu, "$1\n")}\n`,
    encoding: "base64",
    futureLayerField: { enabled: true },
  });

  const decodedStats = await decodeTiledTileData(document);
  assert.deepEqual(document.layers[0].data, gids);
  assert.equal(document.layers[0].encoding, "base64");
  assert.deepEqual(document.layers[0].futureLayerField, { enabled: true });
  assert.deepEqual(decodedStats, { layers: 1, blocks: 1, cells: 8, encodedBytes: 32 });

  const encodedStats = await encodeTiledTileData(document);
  assert.deepEqual(decodeGids(document.layers[0].data), gids);
  assert.equal(document.layers[0].encoding, "base64");
  assert.deepEqual(document.layers[0].futureLayerField, { enabled: true });
  assert.deepEqual(encodedStats, { layers: 1, blocks: 1, cells: 8, encodedBytes: 32 });
});

for (const compression of ["zlib", "gzip"]) {
  test(`edits ${compression} tile data and re-encodes only the exported copy`, async () => {
    const gids = [1, 1, 2, 2, 0, 0, 1, 2];
    const document = finiteMap({
      compression,
      data: encodeGids(gids, compression),
      encoding: "base64",
    });

    await decodeTiledTileData(document);
    const editor = new TiledEditDocument(document);
    const stroke = editor.beginTileStroke(1);
    stroke.set(1, 0, 7);
    assert.equal(stroke.commit(), true);

    const exported = editor.exportDocument();
    await encodeTiledTileData(exported);
    assert.equal(typeof exported.layers[0].data, "string");
    assert.equal(exported.layers[0].compression, compression);
    assert.deepEqual(decodeGids(exported.layers[0].data, compression), [1, 7, 2, 2, 0, 0, 1, 2]);
    assert.deepEqual(editor.layerById(1).data, [1, 7, 2, 2, 0, 0, 1, 2]);
  });
}

test("decodes nested infinite chunks and encodes newly created chunks with the layer format", async () => {
  const layer = {
    chunks: [{
      data: encodeGids([1, 2, 3, 4], "gzip"),
      futureChunkField: "kept",
      height: 2,
      width: 2,
      x: -2,
      y: -1,
    }],
    compression: "gzip",
    encoding: "base64",
    id: 7,
    name: "World",
    type: "tilelayer",
  };
  const document = infiniteMap(layer);
  const encodedBytes = Buffer.from(layer.chunks[0].data, "base64").byteLength;

  const stats = await decodeTiledTileData(document);
  assert.deepEqual(stats, { layers: 1, blocks: 1, cells: 4, encodedBytes });
  const decodedLayer = document.layers[0].layers[0];
  assert.deepEqual(decodedLayer.chunks[0].data, [1, 2, 3, 4]);
  assert.equal(decodedLayer.chunks[0].futureChunkField, "kept");

  const editor = new TiledEditDocument(document, { chunkWidth: 2, chunkHeight: 2 });
  const stroke = editor.beginTileStroke(7);
  stroke.set(-1, 0, 8);
  stroke.set(3, 3, 9);
  stroke.commit();
  const exported = editor.exportDocument();
  await encodeTiledTileData(exported);
  const chunks = exported.layers[0].layers[0].chunks;
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => typeof chunk.data === "string"));
  assert.deepEqual(decodeGids(chunks.find((chunk) => chunk.x === -2).data, "gzip"), [1, 2, 3, 8]);
  assert.deepEqual(decodeGids(chunks.find((chunk) => chunk.x === 2).data, "gzip"), [0, 0, 0, 9]);
  assert.equal(chunks.find((chunk) => chunk.x === -2).futureChunkField, "kept");
});

test("supports empty finite Base64 data", async () => {
  const document = finiteMap({ data: "", encoding: "base64", height: 0, width: 0 });
  await decodeTiledTileData(document);
  assert.deepEqual(document.layers[0].data, []);
  await encodeTiledTileData(document);
  assert.equal(document.layers[0].data, "");
});

test("decodes a single layer without mutating the encoded source", async () => {
  const source = finiteMap({ data: encodeGids(Array(8).fill(3), "zlib"), encoding: "base64", compression: "zlib" }).layers[0];
  const decoded = await decodeTiledTileLayer(source);
  assert.notEqual(decoded, source);
  assert.equal(typeof source.data, "string");
  assert.deepEqual(decoded.data, Array(8).fill(3));
});

test("rejects malformed, mismatched, and excessive decoded data", async () => {
  await assertCodecError(
    decodeTiledTileData(finiteMap({ data: "not base64!", encoding: "base64" })),
    "invalid-base64",
  );
  await assertCodecError(
    decodeTiledTileData(finiteMap({ data: encodeGids([1]), encoding: "base64" })),
    "tile-data-size-mismatch",
  );
  await assertCodecError(
    decodeTiledTileData(finiteMap({ data: Buffer.from("not zlib").toString("base64"), encoding: "base64", compression: "zlib" })),
    "invalid-compressed-tile-data",
  );
  await assertCodecError(
    decodeTiledTileData(finiteMap({ data: encodeGids(Array(16).fill(1), "zlib"), encoding: "base64", compression: "zlib", width: 1, height: 1 })),
    "tile-data-size-mismatch",
  );
  await assertCodecError(
    decodeTiledTileData(finiteMap({ data: encodeGids(Array(8).fill(1)), encoding: "csv" })),
    "unsupported-encoding",
  );
});

test("rejects invalid GIDs and honors cancellation", async () => {
  await assertCodecError(
    encodeTiledTileData(finiteMap({ data: [0, 1, 2, 3, 4, 5, 6, 0x1_0000_0000], encoding: "base64" })),
    "invalid-gid",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decodeTiledTileData(finiteMap({ data: encodeGids(Array(8).fill(1)), encoding: "base64" }), { signal: controller.signal }),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  );
});

test("reports zstd as unsupported when the runtime has no native stream", {
  skip: supportsCompression("zstd") ? "runtime provides native zstd streams" : false,
}, async () => {
  await assertCodecError(
    decodeTiledTileData(finiteMap({ data: encodeGids(Array(8).fill(1)), encoding: "base64", compression: "zstd" })),
    "unsupported-compression",
  );
});

function finiteMap(layerChanges = {}) {
  return {
    height: 2,
    infinite: false,
    layers: [{
      data: Array(8).fill(0),
      height: 2,
      id: 1,
      name: "Ground",
      type: "tilelayer",
      width: 4,
      ...layerChanges,
    }],
    tileheight: 16,
    tilewidth: 16,
    type: "map",
    width: 4,
  };
}

function infiniteMap(layer) {
  return {
    height: 0,
    infinite: true,
    layers: [{ id: 6, layers: [layer], name: "Area", type: "group" }],
    tileheight: 16,
    tilewidth: 16,
    type: "map",
    width: 0,
  };
}

function encodeGids(gids, compression = null) {
  const bytes = Buffer.alloc(gids.length * 4);
  for (let index = 0; index < gids.length; index += 1) bytes.writeUInt32LE(gids[index] >>> 0, index * 4);
  const payload = compression === "zlib"
    ? deflateSync(bytes)
    : compression === "gzip"
      ? gzipSync(bytes)
      : bytes;
  return payload.toString("base64");
}

function decodeGids(source, compression = null) {
  const encoded = Buffer.from(source, "base64");
  const bytes = compression === "zlib"
    ? inflateSync(encoded)
    : compression === "gzip"
      ? gunzipSync(encoded)
      : encoded;
  return Array.from({ length: bytes.byteLength / 4 }, (_, index) => bytes.readUInt32LE(index * 4));
}

async function assertCodecError(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof TiledTileCodecError && error.code === code,
  );
}

function supportsCompression(format) {
  try {
    new DecompressionStream(format);
    new CompressionStream(format);
    return true;
  } catch {
    return false;
  }
}
