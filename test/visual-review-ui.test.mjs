import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  VISUAL_REVIEW_LIMITS,
  analyzeImagePixels,
  formatVisualReviewSummary,
} from "../public/visual-review.js";

const [appSource, htmlSource, packageSource] = await Promise.all([
  fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../lib/package-source.mjs", import.meta.url), "utf8"),
]);

test("resource preview exposes an explicit visual-review scope without chat attachment", () => {
  assert.match(htmlSource, /id="resourceVisualReviewButton"/u);
  assert.match(appSource, /context:\s*"visual-review"/u);
  assert.match(appSource, /openVisualReview\(/u);
  assert.match(appSource, /resourceVisualReviewButton\.hidden\s*=\s*!isImage/u);
  const reviewFunction = appSource.slice(
    appSource.indexOf("async function openResourceVisualReview"),
    appSource.indexOf("function attachImageStudioOutput"),
  );
  assert.doesNotMatch(reviewFunction, /state\.attachments|localImage|sendMessage|turn\/start/u);
  assert.match(packageSource, /public\/visual-review\.js/u);
  assert.match(packageSource, /public\/visual-review\.css/u);
});

test("local visual review returns bounded, sanitized alpha findings", () => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let index = 0; index < 16; index += 1) {
    const offset = index * 4;
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
  }
  // Add a bright semi-transparent fringe along the top edge.
  for (let x = 0; x < 4; x += 1) pixels[(x * 4) + 3] = 96;
  const report = analyzeImagePixels({
    width: 4,
    height: 4,
    pixels,
    mediaType: "image/png",
    byteLength: 128,
    name: "assets/tree.png",
  });
  assert.equal(report.context, "visual-review");
  assert.equal(report.width, 4);
  assert.equal(report.height, 4);
  assert.equal(report.bytes, 128);
  assert.ok(report.issues.some((issue) => issue.code === "alpha-fringe"));
  assert.doesNotMatch(JSON.stringify(report), /assets\/tree\.png|data:image|base64|\/srv\//u);
  assert.ok(formatVisualReviewSummary(report).includes("不会自动加入对话"));
  assert.ok(formatVisualReviewSummary(report).length <= VISUAL_REVIEW_LIMITS.maxReportCharacters);
});

test("local visual review rejects oversized pixel dimensions before sampling", () => {
  assert.throws(() => analyzeImagePixels({
    width: 1,
    height: 1,
    sourceWidth: VISUAL_REVIEW_LIMITS.maxPixels + 1,
    sourceHeight: 1,
    pixels: new Uint8ClampedArray(4),
  }), (error) => error.code === "VISUAL_REVIEW_PIXELS");
});
