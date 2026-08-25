import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { inspectImageBuffer, validateImageFile } from "../lib/image-file.mjs";

test("inspects structurally valid PNG, JPEG, and WebP images", () => {
  const fixtures = [
    [pngFixture(320, 240), { format: "png", mediaType: "image/png", width: 320, height: 240 }],
    [jpegFixture(640, 360), { format: "jpeg", mediaType: "image/jpeg", width: 640, height: 360 }],
    [webpFixture(800, 600), { format: "webp", mediaType: "image/webp", width: 800, height: 600 }],
  ];
  for (const [image, expected] of fixtures) {
    assert.deepEqual(inspectImageBuffer(image), { ...expected, size: image.length });
  }
});

test("accepts Uint8Array input and normalizes jpg in the format allowlist", () => {
  const jpeg = jpegFixture(16, 12);
  const input = new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  assert.equal(inspectImageBuffer(input, { allowedFormats: ["jpg"] }).format, "jpeg");
  assert.throws(() => inspectImageBuffer(pngFixture(1, 1), { allowedFormats: ["jpeg"] }), /not allowed/);
});

test("fully decodes every pixel of valid PNG, JPEG, and WebP images", async () => {
  const image = sharp({
    create: { width: 12, height: 8, channels: 4, background: { r: 31, g: 97, b: 173, alpha: 0.75 } },
  });
  const fixtures = await Promise.all([
    image.clone().png().toBuffer(),
    image.clone().jpeg().toBuffer(),
    image.clone().webp().toBuffer(),
  ]);

  for (const buffer of fixtures) {
    const structural = inspectImageBuffer(buffer);
    assert.deepEqual(await validateImageFile(buffer), structural);
  }
});

test("rejects PNG, JPEG, and WebP containers whose pixels cannot be fully decoded", async () => {
  const invalidPixelData = [
    pngFixture(4, 4, Buffer.from([0])),
    jpegFixture(4, 4),
    webpFixture(4, 4),
  ];

  for (const buffer of invalidPixelData) {
    assert.doesNotThrow(() => inspectImageBuffer(buffer));
    await assert.rejects(
      validateImageFile(buffer),
      (error) => error.code === "INVALID_IMAGE" && /decoded|pixel/i.test(error.message),
    );
  }
});

test("rejects signatures without a complete and consistent image structure", () => {
  const fakePng = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64)]);
  const fakeJpeg = Buffer.from("ffd800000000ffd9", "hex");
  const fakeWebp = Buffer.concat([
    Buffer.from("RIFF"),
    uint32le(12),
    Buffer.from("WEBP"),
    Buffer.from("JUNK"),
    uint32le(0),
  ]);
  for (const image of [fakePng, fakeJpeg, fakeWebp]) {
    assert.throws(() => inspectImageBuffer(image), (error) => error.code === "INVALID_IMAGE");
  }
});

test("rejects truncated PNG chunks, JPEG scans, and WebP chunks", () => {
  const png = pngFixture(20, 10);
  const jpeg = jpegFixture(20, 10);
  const webp = webpFixture(20, 10);
  assert.throws(() => inspectImageBuffer(png.subarray(0, -1)), /truncated|incomplete/);
  assert.throws(() => inspectImageBuffer(jpeg.subarray(0, -1)), /truncated|missing EOI/);
  assert.throws(() => inspectImageBuffer(webp.subarray(0, -1)), /RIFF size|truncated/);
});

test("rejects a PNG with a forged chunk checksum", () => {
  const png = pngFixture(20, 10);
  png[20] ^= 0xff;
  assert.throws(() => inspectImageBuffer(png), /checksum/);
});

test("rejects zero, excessive, and excessive-pixel dimensions", () => {
  assert.throws(() => inspectImageBuffer(jpegFixture(0, 10)), /positive integers/);
  assert.throws(() => inspectImageBuffer(jpegFixture(16_385, 1)), /dimensions exceed/);
  assert.throws(() => inspectImageBuffer(webpFixture(16_383, 16_383)), /pixel count/);
  assert.throws(() => inspectImageBuffer(pngFixture(100, 10), { maxWidth: 99 }), /dimensions exceed/);
  assert.throws(() => inspectImageBuffer(webpFixture(100, 100), { maxPixels: 9_999 }), /pixel count/);
  assert.throws(() => inspectImageBuffer(webpFixture(16_383, 1), { maxWidth: 16_382 }), /dimensions exceed/);
});

test("rejects oversized files before parsing and invalid option limits", () => {
  const png = pngFixture(1, 1);
  assert.throws(() => inspectImageBuffer(png, { maxBytes: png.length - 1 }), /byte limit/);
  assert.throws(() => inspectImageBuffer(png, { maxPixels: 0 }), (error) => error.code === "INVALID_IMAGE_OPTION");
  assert.throws(() => inspectImageBuffer("not bytes"), /Buffer or Uint8Array/);
});

function pngFixture(width, height, pixelData = null) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowLength = 1 + (Math.max(width, 1) * 4);
  const raw = pixelData ?? Buffer.alloc(rowLength * Math.max(height, 1));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const checksumInput = Buffer.concat([name, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(checksumInput), 8 + data.length);
  return chunk;
}

function jpegFixture(width, height) {
  const frame = Buffer.alloc(17);
  frame.writeUInt16BE(17, 0);
  frame[2] = 8;
  frame.writeUInt16BE(height, 3);
  frame.writeUInt16BE(width, 5);
  frame[7] = 3;
  for (let component = 0; component < 3; component += 1) {
    frame[8 + (component * 3)] = component + 1;
    frame[9 + (component * 3)] = 0x11;
  }
  const scan = Buffer.from([0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
    frame,
    Buffer.from([0xff, 0xda]),
    scan,
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
  ]);
}

function webpFixture(width, height) {
  const payload = Buffer.alloc(11);
  payload[0] = 0x30;
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  const chunk = Buffer.concat([Buffer.from("VP8 "), uint32le(payload.length), payload, Buffer.alloc(payload.length & 1)]);
  return Buffer.concat([Buffer.from("RIFF"), uint32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}

function uint32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
