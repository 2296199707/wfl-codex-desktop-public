import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMapImageBoundary,
  planMapImageProviderCanvas,
  snapMapImageBoundarySide,
} from "../public/map-editor/map-image-boundary.js";

const customLimits = {
  maxWidth: 3840,
  maxHeight: 3840,
  dimensionMultiple: 16,
  maxAspectRatio: 3,
  minPixels: 1,
  maxPixels: 8_294_400,
};

test("uses one signed boundary model for inward crop and outward expansion", () => {
  const plan = normalizeMapImageBoundary({
    top: -10,
    right: 20,
    bottom: 0,
    left: -5,
  }, { width: 100, height: 80 });
  assert.deepEqual(plan.crop, { top: 10, right: 0, bottom: 0, left: 5 });
  assert.deepEqual(plan.outpaint, { top: 0, right: 20, bottom: 0, left: 0 });
  assert.deepEqual(plan.cropped, { width: 95, height: 70 });
  assert.deepEqual(plan.target, { width: 115, height: 70 });
  assert.equal(plan.hasCrop, true);
  assert.equal(plan.hasOutpaint, true);
  assert.throws(
    () => normalizeMapImageBoundary({ left: -60, right: -40 }, { width: 100, height: 80 }),
    /不能移除整张|至少为/u,
  );
});

test("converts map guide coordinates into source-local boundary snapping", () => {
  const source = { width: 100, height: 80 };
  assert.equal(snapMapImageBoundarySide(-18, "left", source, [20], 3), -20);
  assert.equal(snapMapImageBoundarySide(19, "right", source, [120], 3), 20);
  assert.equal(snapMapImageBoundarySide(-9, "top", source, [10], 2), -10);
  assert.equal(snapMapImageBoundarySide(11, "bottom", source, [92], 2), 12);
  assert.equal(snapMapImageBoundarySide(5, "right", source, [120], 3), 5);
});

test("previews exact, reject, and explicit provider canvas policies", () => {
  const exactBoundary = normalizeMapImageBoundary({ right: 12 }, { width: 100, height: 80 });
  const exact = planMapImageProviderCanvas(
    exactBoundary,
    { customSize: true, sizes: [] },
    customLimits,
    "reject",
  );
  assert.equal(exact.supported, true);
  assert.deepEqual(exact.provider, { width: 112, height: 80 });

  const fixedBoundary = normalizeMapImageBoundary({ right: 28, bottom: 28 }, { width: 100, height: 100 });
  const rejected = planMapImageProviderCanvas(
    fixedBoundary,
    { customSize: false, sizes: ["256x256"] },
    null,
    "reject",
  );
  assert.equal(rejected.supported, false);
  assert.deepEqual(rejected.supportedSizes, ["256x256"]);

  const padded = planMapImageProviderCanvas(
    fixedBoundary,
    { customSize: false, sizes: ["256x256"] },
    null,
    "pad-and-crop",
  );
  assert.equal(padded.supported, true);
  assert.deepEqual(padded.provider, { width: 256, height: 256 });
  assert.deepEqual(padded.postprocess, ["pad-right:128", "pad-bottom:128", "crop-provider:0,0,128,128"]);
});
