import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { planImageProviderCanvas } from "../lib/image-canvas-plan.mjs";
import {
  prepareOutpaint,
  restoreMaskedEditSource,
  restoreOutpaintProviderCanvas,
  restoreOutpaintSource,
  transformOutpaintInputs,
} from "../lib/image-outpaint.mjs";

test("builds a four-sided transparent canvas and an inverse-alpha edit mask", async () => {
  const source = await rgbaImage(2, 2, [
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 128,
  ]);
  const prepared = await prepareOutpaint({
    sourceBuffer: source,
    canvas: { width: 6, height: 5 },
    placement: { x: 2, y: 1 },
    blendMargin: 0,
  });

  assert.deepEqual(prepared.source, { width: 2, height: 2, format: "png" });
  assert.deepEqual(prepared.canvas, { width: 6, height: 5 });
  assert.deepEqual(prepared.placement, { x: 2, y: 1 });

  const canvas = await rawRgba(prepared.canvasBuffer);
  assert.deepEqual(pixel(canvas, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(canvas, 2, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(canvas, 3, 1), [0, 255, 0, 255]);
  assert.deepEqual(pixel(canvas, 2, 2), [0, 0, 255, 255]);
  assert.deepEqual(pixel(canvas, 3, 2), [255, 255, 0, 128]);
  assert.deepEqual(pixel(canvas, 5, 4), [0, 0, 0, 0]);

  const mask = await rawRgba(prepared.maskBuffer);
  assert.equal(pixel(mask, 0, 0)[3], 0, "extension is editable");
  assert.deepEqual(pixel(mask, 2, 1), [255, 255, 255, 255]);
  assert.equal(pixel(mask, 3, 2)[3], 255, "source rectangle is protected");
  assert.equal(pixel(mask, 5, 4)[3], 0, "opposite extension is editable");
});

test("fully decodes supported PNG, JPEG, and WebP source images", async () => {
  const png = await rgbaImage(4, 4, new Array(4 * 4 * 4).fill(128));
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();

  for (const [sourceBuffer, format] of [[png, "png"], [jpeg, "jpeg"], [webp, "webp"]]) {
    const result = await prepareOutpaint({
      sourceBuffer,
      canvas: { width: 6, height: 6 },
      placement: { x: 1, y: 1 },
    });
    assert.equal(result.source.format, format);
    assert.deepEqual(result.source, { width: 4, height: 4, format });
  }

  await assert.rejects(
    prepareOutpaint({
      sourceBuffer: png.subarray(0, png.length - 8),
      canvas: { width: 6, height: 6 },
      placement: { x: 1, y: 1 },
    }),
    (error) => error.code === "INVALID_OUTPAINT" && /decode/.test(error.message),
  );

  const animatedWebp = Buffer.from(
    "UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMAAAANABAJ0BKgIAAgACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAQAAAQAAZAAAAFZQOCAsAAAAlAEAnQEqAgACAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=",
    "base64",
  );
  await assert.rejects(
    prepareOutpaint({
      sourceBuffer: animatedWebp,
      canvas: { width: 4, height: 4 },
      placement: { x: 1, y: 1 },
    }),
    /exactly one frame/,
  );
});

test("rejects invalid placement, no-op canvases, invalid blending, and official-limit violations", async () => {
  const source = await rgbaImage(2, 2, new Array(16).fill(255));
  const base = { sourceBuffer: source, canvas: { width: 4, height: 4 }, placement: { x: 1, y: 1 } };

  await assert.rejects(prepareOutpaint({ ...base, placement: { x: 3, y: 1 } }), /canvas bounds/);
  await assert.rejects(prepareOutpaint({ ...base, placement: { x: -1, y: 1 } }), /non-negative/);
  await assert.rejects(prepareOutpaint({ ...base, canvas: { width: 2, height: 2 }, placement: { x: 0, y: 0 } }), /must extend/);
  await assert.rejects(prepareOutpaint({ ...base, blendMargin: 513 }), /0 to 512/);
  await assert.rejects(prepareOutpaint({ ...base, canvas: { width: 3_841, height: 3_840 } }), /3840px/);
  await assert.rejects(prepareOutpaint({ ...base, canvas: { width: 3_840, height: 2_161 } }), /8294400-pixel/);
  await assert.rejects(prepareOutpaint({ ...base, canvas: { width: 13, height: 4 } }), /aspect ratio/);
});

test("seamless outpaint exposes and feathers only the expanded source edges", async () => {
  const source = await solidImage(4, 3, { r: 255, g: 0, b: 0, alpha: 1 });
  const prepared = await prepareOutpaint({
    sourceBuffer: source,
    canvas: { width: 6, height: 3 },
    placement: { x: 2, y: 0 },
    blendMargin: 2,
  });
  const mask = await rawRgba(prepared.maskBuffer);
  assert.equal(pixel(mask, 2, 1)[3], 0, "source seam is editable");
  assert.ok(pixel(mask, 3, 1)[3] >= 127 && pixel(mask, 3, 1)[3] <= 128);
  assert.equal(pixel(mask, 4, 1)[3], 255, "source core remains protected");

  const generated = await solidImage(6, 3, { r: 0, g: 0, b: 255, alpha: 1 });
  const restored = await restoreOutpaintSource(
    generated,
    source,
    { x: 2, y: 0 },
    { format: "png", blendMargin: 2 },
  );
  const output = await rawRgba(restored);
  assert.deepEqual(pixel(output, 2, 1), [0, 0, 255, 255]);
  assert.ok(pixel(output, 3, 1)[0] >= 127 && pixel(output, 3, 1)[0] <= 128);
  assert.ok(pixel(output, 3, 1)[2] >= 127 && pixel(output, 3, 1)[2] <= 128);
  assert.deepEqual(pixel(output, 4, 1), [255, 0, 0, 255]);
});

test("strict edit restores the opaque mask region after a provider changes every pixel", async () => {
  const source = await rgbaImage(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]);
  const generated = await rgbaImage(2, 1, [0, 0, 255, 255, 0, 0, 255, 255]);
  const mask = await rgbaImage(2, 1, [255, 255, 255, 255, 255, 255, 255, 0]);
  const restored = await restoreMaskedEditSource({
    resultBuffer: generated,
    sourceBuffer: source,
    maskBuffer: mask,
    featherPixels: 0,
    outputFormatOrOptions: { format: "png", compressionLevel: 9 },
  });
  const output = await rawRgba(restored.buffer);
  assert.deepEqual(pixel(output, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(output, 1, 0), [0, 0, 255, 255]);
  assert.equal(restored.sourceResized, false);
});

test("explicit canvas policies pad or rescale and restore the requested logical dimensions", async () => {
  const limits = {
    maxWidth: 3840,
    maxHeight: 3840,
    dimensionMultiple: 16,
    maxAspectRatio: 3,
    minPixels: 1,
    maxPixels: 8_294_400,
  };
  const custom = { customSize: true, sizes: [] };
  const padded = planImageProviderCanvas({
    requested: { width: 31, height: 17 },
    capability: custom,
    limits,
    alignmentPolicy: "pad-and-crop",
  });
  assert.deepEqual(padded.provider, { width: 32, height: 32 });
  assert.equal(padded.postprocess.filter((entry) => entry.startsWith("crop-provider:")).length, 1);
  const canvas = await solidImage(31, 17, { r: 12, g: 34, b: 56, alpha: 1 });
  const mask = await solidImage(31, 17, { r: 255, g: 255, b: 255, alpha: 1 });
  const transformed = await transformOutpaintInputs({ canvasBuffer: canvas, maskBuffer: mask, plan: padded });
  assert.deepEqual(await imageSummary(transformed.canvasBuffer), { format: "png", width: 32, height: 32, pages: 1 });
  const restored = await restoreOutpaintProviderCanvas(transformed.canvasBuffer, padded);
  assert.deepEqual(await imageSummary(restored), { format: "png", width: 31, height: 17, pages: 1 });

  const rescaled = planImageProviderCanvas({
    requested: { width: 31, height: 17 },
    capability: { customSize: false, sizes: ["64x64"] },
    limits,
    alignmentPolicy: "rescale-and-crop",
  });
  assert.deepEqual(rescaled.provider, { width: 64, height: 64 });
  assert.equal(rescaled.postprocess.filter((entry) => entry.startsWith("crop-provider:")).length, 1);
  await assert.rejects(
    Promise.resolve().then(() => planImageProviderCanvas({
      requested: { width: 31, height: 17 },
      capability: { customSize: false, sizes: ["64x64"] },
      limits,
      alignmentPolicy: "reject",
    })),
    (error) => error.code === "IMAGE_PROVIDER_SIZE_UNSUPPORTED" && error.retryable === false,
  );
});

test("restores the exact source pixels over the generated result and encodes each target format", async () => {
  const sourcePixels = [
    255, 0, 0, 255,
    0, 255, 0, 128,
    0, 0, 255, 255,
    255, 255, 0, 255,
  ];
  const source = await rgbaImage(2, 2, sourcePixels);
  const generated = await rgbaImage(6, 5, new Array(6 * 5).fill([17, 34, 51, 255]).flat());
  const restored = await restoreOutpaintSource(
    generated,
    source,
    { x: 2, y: 1 },
    { format: "png", compression: 6 },
  );
  const output = await rawRgba(restored);
  const decodedSource = await rawRgba(source);

  assert.deepEqual(pixel(output, 0, 0), [17, 34, 51, 255]);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      assert.deepEqual(pixel(output, x + 2, y + 1), pixel(decodedSource, x, y));
    }
  }

  const jpeg = await restoreOutpaintSource(generated, source, { x: 2, y: 1 }, "jpeg", { quality: 85 });
  const webp = await restoreOutpaintSource(generated, source, { x: 2, y: 1 }, { format: "webp", compression: 85 });
  assert.deepEqual(await imageSummary(jpeg), { format: "jpeg", width: 6, height: 5, pages: 1 });
  assert.deepEqual(await imageSummary(webp), { format: "webp", width: 6, height: 5, pages: 1 });
});

test("encodes explicit JPEG and WebP outputCompression zero without changing the requested endpoint", async () => {
  const source = await solidImage(16, 16, { r: 245, g: 245, b: 245, alpha: 1 });
  const generated = await solidImage(32, 24, { r: 8, g: 8, b: 8, alpha: 1 });
  const zeroOutputs = new Map();

  await Promise.all(["jpeg", "webp"].map(async (format) => {
    const restored = await restoreOutpaintSource(
      generated,
      source,
      { x: 8, y: 4 },
      { format, outputCompression: 0 },
    );
    zeroOutputs.set(format, restored);
    assert.deepEqual(await imageSummary(restored), { format, width: 32, height: 24, pages: 1 });
    const decoded = await rawRgba(restored);
    assert.ok(pixel(decoded, 16, 12).slice(0, 3).every((channel) => channel > 200));
    assert.ok(pixel(decoded, 2, 2).slice(0, 3).every((channel) => channel < 60));
  }));

  const webpQualityOne = await restoreOutpaintSource(
    generated,
    source,
    { x: 8, y: 4 },
    { format: "webp", outputCompression: 1 },
  );
  assert.notDeepEqual(zeroOutputs.get("webp"), webpQualityOne);

  const png = await restoreOutpaintSource(
    generated,
    source,
    { x: 1, y: 1 },
    { format: "png", outputCompression: 0 },
  );
  assert.deepEqual(await imageSummary(png), { format: "png", width: 32, height: 24, pages: 1 });
});

async function rgbaImage(width, height, values) {
  return sharp(Buffer.from(values), { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function solidImage(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

async function rawRgba(buffer) {
  const decoded = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function pixel(image, x, y) {
  const offset = ((y * image.width) + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

async function imageSummary(buffer) {
  const metadata = await sharp(buffer).metadata();
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    pages: metadata.pages ?? 1,
  };
}
