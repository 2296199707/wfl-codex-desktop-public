import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { MapImageJobStore } from "../lib/map-image-job-store.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const identity = Object.freeze({
  userId: "user-1",
  browserSessionId: "browser-session-1",
  editorInstanceId: "map-editor-window-0001",
});

async function fixture(run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-image-jobs-"));
  const projectPath = path.join(root, "project");
  await fs.mkdir(projectPath, { recursive: true });
  const store = await new MapImageJobStore({
    temporaryRoot: path.join(root, "candidates"),
    runner: options.runner || (async () => ({
      files: [{ data: PNG, name: "plant.png", mediaType: "image/png", width: 1, height: 1 }],
    })),
    authorizeSession: options.authorizeSession,
    concurrency: options.concurrency,
    maxCandidateFiles: options.maxCandidateFiles,
    maxCandidateTotalBytes: options.maxCandidateTotalBytes,
    now: options.now,
    ttlMs: options.ttlMs,
  }).initialize();
  try {
    await run({ root, projectPath, store });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function input(projectPath, request = { operation: "generate-prop", prompt: "fern" }) {
  return {
    identity,
    mapContext: {
      mapSessionId: "map-session-0001",
      version: "a".repeat(64),
      projectPath,
      targetPath: path.join(projectPath, "maps", "world.tmj"),
      writable: true,
    },
    request,
  };
}

async function waitFor(predicate, message = "condition") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function rgbaPng(width, height, pixelAt) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgba = pixelAt(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = rgba[0];
      pixels[offset + 1] = rgba[1];
      pixels[offset + 2] = rgba[2];
      pixels[offset + 3] = rgba[3];
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test("runs map image jobs in FIFO order with immutable request snapshots", async () => {
  const started = [];
  const observedRequests = [];
  const releases = [];
  await fixture(async ({ projectPath, store }) => {
    const mutable = { operation: "outpaint-selection", prompt: "river", options: { blendMargin: 64 } };
    const first = store.enqueue(input(projectPath, mutable));
    mutable.prompt = "changed after enqueue";
    mutable.options.blendMargin = 0;
    const second = store.enqueue(input(projectPath, { operation: "generate-tile", prompt: "grass" }));

    await waitFor(() => started.length === 1, "first map image job");
    assert.deepEqual(started, [first.id]);
    assert.equal(first.job.request.prompt, "river");
    assert.equal(Object.hasOwn(first.job.request, "options"), false);
    assert.equal(Object.hasOwn(observedRequests[0], "options"), false);
    assert.equal(store.snapshot({ jobId: second.id, identity }).status, "queued");

    releases.shift()();
    await first.promise;
    await waitFor(() => started.length === 2, "second map image job");
    assert.deepEqual(started, [first.id, second.id]);
    releases.shift()();
    await second.promise;
  }, {
    runner: (job) => new Promise((resolve) => {
      assert.deepEqual(job.identity, identity);
      started.push(job.id);
      observedRequests.push(job.request);
      releases.push(() => resolve({ files: [{ data: PNG, name: "result.png" }] }));
    }),
    concurrency: 1,
  });
});

test("stages candidates outside the project without producing conversation attachments", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    const job = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(job.status, "succeeded");
    assert.equal(job.mapSessionId, "map-session-0001");
    assert.equal(job.mapVersion, "a".repeat(64));
    assert.equal(job.candidate.files[0].name, "plant.png");
    assert.equal(job.candidate.files[0].size, PNG.length);
    assert.equal(Object.hasOwn(job, "attachment"), false);
    assert.equal(Object.hasOwn(job.candidate.files[0], "stagedPath"), false);
    assert.deepEqual(await fs.readdir(projectPath), []);
    assert.equal(store.status().candidates, 1);
  });
});

test("reports provider-free crop candidates with local provenance", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "crop",
      sourceSize: { width: 2, height: 1 },
      sourceCrop: { top: 0, right: 0, bottom: 0, left: 1 },
      outputFormat: "png",
      n: 1,
    }));
    await admitted.promise;
    const job = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(job.request.operation, "crop");
    assert.deepEqual(job.request.sourceCrop, { top: 0, right: 0, bottom: 0, left: 1 });
    assert.deepEqual(job.request.sourceSize, { width: 2, height: 1 });
    assert.equal(job.result.operation, "crop");
    assert.equal(job.result.provider, "wfl-local");
    assert.equal(job.result.sourceConsumed, true);
    assert.equal(job.result.inputImageTokens, 0);
    assert.equal(job.publication, null);
  }, {
    runner: async () => ({
      files: [{ data: PNG, name: "crop.png" }],
      requested: {
        operation: "crop",
        sourceSize: "2x1",
        requestedCanvas: "1x1",
        outputFormat: "png",
        sourceConsumed: true,
        postprocess: ["crop:0,0,0,1"],
      },
    }),
  });
});

test("rejects unknown or weakened map asset quality targets before provider admission", async () => {
  await fixture(async ({ projectPath, store }) => {
    const invalidRequests = [
      {
        operation: "generate",
        assetKind: "unknown",
        qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "required" },
      },
      { operation: "generate", assetKind: "prop" },
      {
        operation: "generate",
        assetKind: "prop",
        qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "optional" },
      },
      {
        operation: "generate",
        assetKind: "background",
        qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "required" },
      },
      {
        operation: "generate",
        assetKind: "terrain",
        qualityTarget: {
          schemaVersion: "map-image-quality-target-v1",
          tiling: { mode: "periodic", axes: ["horizontal"] },
        },
      },
      {
        operation: "edit",
        assetKind: "tileset",
        qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "required" },
      },
      {
        operation: "generate",
        qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "required" },
      },
    ];
    for (const request of invalidRequests) {
      assert.throws(
        () => store.enqueue(input(projectPath, { ...request, prompt: "invalid target" })),
        (error) => error.code === "MAP_IMAGE_QUALITY_TARGET_INVALID",
      );
    }
    assert.equal(store.jobs.length, 0);
  });
});

test("decodes transparent plant, prop, and tileset pixels before exposing publishable candidates", async () => {
  const cases = [
    {
      assetKind: "plant",
      data: await rgbaPng(4, 4, (x, y) => (
        x === 0 || y === 0 || x === 3 || y === 3
          ? [0, 0, 0, 0]
          : [48, 148, 72, 255]
      )),
      transparentPixels: 12,
      visiblePixels: 4,
      borderFullyTransparentPixels: 12,
      minimumBorderTransparentCoverage: 0.5,
    },
    {
      assetKind: "prop",
      data: await rgbaPng(4, 4, (x, y) => (
        x === 0 || y === 0 || x === 3 || y === 3
          ? [0, 0, 0, 0]
          : [32, 128, 64, 255]
      )),
      transparentPixels: 12,
      visiblePixels: 4,
      borderFullyTransparentPixels: 12,
      minimumBorderTransparentCoverage: 0.5,
    },
    {
      assetKind: "tileset",
      data: await rgbaPng(4, 4, (x, y) => (
        x === 1 && y === 1 ? [0, 0, 0, 0] : [32, 128, 64, 255]
      )),
      transparentPixels: 1,
      visiblePixels: 15,
      borderFullyTransparentPixels: 0,
      minimumBorderTransparentCoverage: 0,
    },
  ];
  for (const asset of cases) {
    await fixture(async ({ projectPath, store }) => {
      const admitted = store.enqueue(input(projectPath, {
        operation: "generate",
        assetKind: asset.assetKind,
        qualityTarget: {
          schemaVersion: "map-image-quality-target-v1",
          alpha: "required",
        },
        prompt: asset.assetKind,
      }));
      await admitted.promise;
      const job = store.snapshot({ jobId: admitted.id, identity });
      const report = job.candidate.files[0].quality;
      assert.equal(report.schemaVersion, "map-image-quality-report-v1");
      assert.equal(report.assetKind, asset.assetKind);
      assert.equal(report.publishable, true);
      assert.deepEqual(report.checks.alpha, {
        required: true,
        mode: "transparent",
        format: "png",
        totalPixels: 16,
        transparentPixels: asset.transparentPixels,
        fullyTransparentPixels: asset.transparentPixels,
        visiblePixels: asset.visiblePixels,
        borderPixels: 12,
        borderFullyTransparentPixels: asset.borderFullyTransparentPixels,
        borderTransparentCoverage: asset.borderFullyTransparentPixels / 12,
        minimumBorderTransparentCoverage: asset.minimumBorderTransparentCoverage,
        passed: true,
      });
      assert.equal(Object.hasOwn(report.checks, "tiling"), false);
    }, { runner: async () => ({ files: [{ data: asset.data }] }) });
  }
});

test("rejects a prop whose only transparent pixel is not meaningful border background", async () => {
  const pinholeProp = await rgbaPng(4, 4, (x, y) => (
    x === 1 && y === 1 ? [0, 0, 0, 0] : [32, 128, 64, 255]
  ));
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "prop",
      qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "required" },
      prompt: "pinhole prop",
    }));
    await assert.rejects(admitted.promise, (error) => (
      error.code === "MAP_IMAGE_ALPHA_QUALITY_FAILED"
      && error.quality?.checks?.alpha?.borderTransparentCoverage === 0
      && error.quality?.checks?.alpha?.minimumBorderTransparentCoverage === 0.5
    ));
    assert.equal(store.snapshot({ jobId: admitted.id, identity }).candidate, null);
  }, { runner: async () => ({ files: [{ data: pinholeProp }] }) });
});

test("fails closed when a transparent map asset has no transparent pixels", async () => {
  const opaqueAsset = await rgbaPng(4, 4, () => [24, 96, 48, 255]);
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "prop",
      qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "required" },
      prompt: "opaque fern",
    }));
    await assert.rejects(
      admitted.promise,
      (error) => error.code === "MAP_IMAGE_ALPHA_QUALITY_FAILED"
        && error.quality?.checks?.alpha?.transparentPixels === 0,
    );
    const failed = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(failed.status, "failed");
    assert.equal(failed.candidate, null);
    assert.equal(failed.error.quality.publishable, false);
    assert.equal(failed.error.quality.checks.alpha.passed, false);
    assert.deepEqual(await fs.readdir(projectPath), []);
  }, { runner: async () => ({ files: [{ data: opaqueAsset }] }) });
});

test("publishes terrain only after both periodic edge pairs pass decoded-pixel QC", async () => {
  const seamlessTerrain = await rgbaPng(5, 5, (x, y) => [
    40 + ((x % 4) * 2),
    90 + ((y % 4) * 2),
    55,
    255,
  ]);
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "terrain",
      qualityTarget: {
        schemaVersion: "map-image-quality-target-v1",
        tiling: { mode: "periodic", axes: ["horizontal", "vertical"] },
      },
      prompt: "periodic moss ground",
    }));
    await admitted.promise;
    const completed = store.snapshot({ jobId: admitted.id, identity });
    const report = completed.candidate.files[0].quality;
    assert.equal(report.publishable, true);
    assert.equal(report.checks.alpha.required, true);
    assert.equal(report.checks.alpha.mode, "opaque");
    assert.equal(report.checks.alpha.transparentPixels, 0);
    assert.equal(report.checks.alpha.fullyTransparentPixels, 0);
    assert.equal(report.checks.tiling.mode, "periodic");
    assert.deepEqual(report.checks.tiling.axes, ["horizontal", "vertical"]);
    assert.equal(report.checks.tiling.horizontal.edgePair, "left-right");
    assert.equal(report.checks.tiling.horizontal.meanAbsoluteError, 0);
    assert.equal(report.checks.tiling.horizontal.visibleCoverage, 1);
    assert.equal(report.checks.tiling.vertical.edgePair, "top-bottom");
    assert.equal(report.checks.tiling.vertical.meanAbsoluteError, 0);
    assert.equal(report.checks.tiling.passed, true);

    const published = await store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/terrain/moss.png" }],
    });
    assert.equal(published.job.status, "published");
    assert.deepEqual(
      await fs.readFile(path.join(projectPath, "assets/generated/terrain/moss.png")),
      seamlessTerrain,
    );
  }, { runner: async () => ({ files: [{ data: seamlessTerrain }] }) });
});

test("accepts an opaque full background without imposing terrain seam checks", async () => {
  const background = await rgbaPng(5, 4, (x, y) => [32 + x * 7, 64 + y * 9, 96, 255]);
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "background",
      qualityTarget: { schemaVersion: "map-image-quality-target-v1", alpha: "opaque" },
      prompt: "fixed battle background",
    }));
    await admitted.promise;
    const report = store.snapshot({ jobId: admitted.id, identity }).candidate.files[0].quality;
    assert.equal(report.assetKind, "background");
    assert.equal(report.publishable, true);
    assert.equal(report.checks.alpha.mode, "opaque");
    assert.equal(report.checks.alpha.transparentPixels, 0);
    assert.equal(Object.hasOwn(report.checks, "tiling"), false);
  }, { runner: async () => ({ files: [{ data: background }] }) });
});

test("rejects periodic terrain with an internal transparent hole even when all edges match", async () => {
  const terrainWithHole = await rgbaPng(5, 5, (x, y) => (
    x === 2 && y === 2 ? [0, 0, 0, 0] : [48, 96, 64, 255]
  ));
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "terrain",
      qualityTarget: {
        schemaVersion: "map-image-quality-target-v1",
        tiling: { mode: "periodic", axes: ["horizontal", "vertical"] },
      },
      prompt: "ground with transparent hole",
    }));
    await assert.rejects(admitted.promise, (error) => (
      error.code === "MAP_IMAGE_ALPHA_QUALITY_FAILED"
      && error.quality?.checks?.alpha?.mode === "opaque"
      && error.quality?.checks?.alpha?.transparentPixels === 1
      && error.quality?.checks?.tiling?.passed === true
    ));
    const failed = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(failed.candidate, null);
    assert.equal(failed.error.quality.checks.alpha.passed, false);
    assert.equal(failed.error.quality.publishable, false);
  }, { runner: async () => ({ files: [{ data: terrainWithHole }] }) });
});

test("rejects a terrain candidate with mismatched periodic edges and returns structured QC", async () => {
  const seamedTerrain = await rgbaPng(5, 5, (x) => (
    x === 0 ? [220, 20, 20, 255] : x === 4 ? [20, 20, 220, 255] : [64, 96, 48, 255]
  ));
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "terrain",
      qualityTarget: {
        schemaVersion: "map-image-quality-target-v1",
        tiling: { mode: "periodic", axes: ["horizontal", "vertical"] },
      },
      prompt: "seamed ground",
    }));
    await assert.rejects(
      admitted.promise,
      (error) => error.code === "MAP_IMAGE_SEAM_QUALITY_FAILED"
        && error.quality?.checks?.tiling?.horizontal?.passed === false,
    );
    const failed = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(failed.candidate, null);
    assert.equal(failed.error.quality.checks.alpha.passed, true);
    assert.ok(failed.error.quality.checks.tiling.horizontal.meanAbsoluteError > 16);
    assert.equal(failed.error.quality.checks.tiling.horizontal.visibleCoverage, 1);
    assert.equal(failed.error.quality.checks.tiling.vertical.passed, true);
    assert.equal(failed.error.quality.publishable, false);
    assert.deepEqual(await fs.readdir(projectPath), []);
  }, { runner: async () => ({ files: [{ data: seamedTerrain }] }) });
});

test("publication fails closed if a required pixel quality report is absent", async () => {
  const seamlessTerrain = await rgbaPng(3, 3, () => [48, 96, 64, 255]);
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "generate",
      assetKind: "terrain",
      qualityTarget: {
        schemaVersion: "map-image-quality-target-v1",
        tiling: { mode: "periodic", axes: ["horizontal", "vertical"] },
      },
      prompt: "periodic grass",
    }));
    await admitted.promise;
    const internal = store.jobs.find((job) => job.id === admitted.id);
    internal.candidate.files[0].quality = null;
    await assert.rejects(store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/terrain/grass.png" }],
    }), (error) => error.code === "MAP_IMAGE_QUALITY_UNVERIFIED");
    assert.equal(await fs.stat(path.join(projectPath, "assets")).catch(() => null), null);
  }, { runner: async () => ({ files: [{ data: seamlessTerrain }] }) });
});

test("keeps request and provider provenance on candidates and explicit publication", async () => {
  const providerProfileRevision = "a".repeat(32);
  const configurationRevision = "b".repeat(32);
  await fixture(async ({ projectPath, store }) => {
    const request = { operation: "generate", prompt: "fern", size: "1024x1024" };
    const admitted = store.enqueue(input(projectPath, request));
    await admitted.promise;
    const job = store.snapshot({ jobId: admitted.id, identity });
    assert.match(job.requestHash, /^[a-f0-9]{64}$/u);
    assert.equal(job.result.requestHash, job.requestHash);
    assert.equal(job.result.requested.model, "gpt-image-2");
    assert.equal(job.result.requested.providerProfileRevision, providerProfileRevision);
    assert.equal(job.result.requested.configurationRevision, configurationRevision);

    const published = await store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/fern.png" }],
    });
    assert.equal(published.job.publication.provenance.requestHash, job.requestHash);
    assert.equal(published.job.publication.provenance.model, "gpt-image-2");
    assert.equal(published.job.publication.provenance.providerProfileRevision, providerProfileRevision);
  }, {
    runner: async () => ({
      files: [{ data: PNG, name: "fern.png" }],
      providerRequestId: "req-provenance-1",
      requested: {
        operation: "generate",
        model: "gpt-image-2",
        providerProfileRevision,
        configurationRevision,
      },
    }),
  });
});

test("keeps private execution context out of public job snapshots", async () => {
  let observedContext = null;
  await fixture(async ({ projectPath, store }) => {
    const value = input(projectPath);
    value.executionContext = {
      authSession: {
        id: "private-browser-session",
        userId: identity.userId,
        source: "primary",
        expiresAt: Date.now() + 60_000,
      },
      imageApiSnapshot: {
        apiKey: "private-image-provider-secret",
        model: "gpt-image-2",
      },
      selectionTarget: {
        // Early builds used the target schema on this wrapper too. Public
        // sanitization must prefer the nested authoritative target.
        schema: "wfl.map-selection-image-target.v1",
        operation: "outpaint",
        target: {
          schema: "wfl.map-selection-image-target.v1",
          purpose: "layer-image",
          map: {
          version: "a".repeat(64), editorStateId: 7, orientation: "orthogonal", infinite: false,
          tileSize: { width: 16, height: 16 },
          },
          layer: { id: 2, type: "tilelayer", name: "Ground", path: [2] },
          selection: {
            tile: { space: "layer", x: 1, y: 2, width: 3, height: 4 },
            mapTile: { space: "map", x: 1, y: 2, width: 3, height: 4 },
            world: { x: 16, y: 32, width: 48, height: 64 },
          },
          expansion: {
            unit: "world",
            tile: null,
            world: { top: 0, right: 16, bottom: 0, left: 0, privateNote: "do-not-return" },
          },
          target: {
            tile: null,
            mapTile: null,
            world: { x: 16, y: 32, width: 64, height: 64 },
            sourceOffset: { x: 0, y: 0 },
          },
          policies: { maskMode: "strict", preserveSource: "exact", privateNote: "do-not-return" },
          logicalCanvas: { width: 64, height: 64 },
        },
        policies: { preserveSource: "seamless", alignmentPolicy: "pad-and-crop", blendMargin: 16 },
        privateNote: "do-not-return",
      },
    };
    const admitted = store.enqueue(value);
    assert.equal(Object.hasOwn(admitted.job, "executionContext"), false);
    assert.deepEqual(admitted.job.selectionTarget.target.world, { x: 16, y: 32, width: 64, height: 64 });
    await admitted.promise;
    const snapshot = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(Object.hasOwn(snapshot, "executionContext"), false);
    assert.deepEqual(snapshot.selectionTarget.expansion.world, { top: 0, right: 16, bottom: 0, left: 0 });
    assert.deepEqual(snapshot.selectionTarget.policies, {
      maskMode: "strict", preserveSource: "seamless", alignmentPolicy: "pad-and-crop", blendMargin: 16,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /private-image-provider-secret|do-not-return/u);
    assert.equal(observedContext.authSession.id, "private-browser-session");
  }, {
    runner: async (job) => {
      observedContext = job.executionContext;
      return { files: [{ data: PNG }] };
    },
  });
});

test("allow-lists public requests and redacts private runner failure details", async () => {
  await fixture(async ({ projectPath, store }) => {
    const value = input(projectPath, {
      operation: "generate",
      prompt: "fern",
      size: "1024x1024",
      apiKey: "private-map-api-key",
      token: "private-map-token",
      absolutePath: "/tmp/private-map-source.png",
      outpaint: { top: 1, right: 0, bottom: 0, left: 0, secret: "nested-secret" },
    });
    const admitted = store.enqueue(value);
    assert.doesNotMatch(JSON.stringify(admitted.job), /private-map|nested-secret|absolutePath|apiKey|token/u);
    await assert.rejects(admitted.promise);
    const snapshot = store.snapshot({ jobId: admitted.id, identity });
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.error.code, "IMAGE_PROVIDER_ERROR");
    assert.doesNotMatch(JSON.stringify(snapshot), /private-map|nested-secret|\/tmp\/|top-secret/u);
    assert.match(snapshot.error.message, /已隐藏/u);
    assert.equal(Object.hasOwn(snapshot.error, "quality"), false);
  }, {
    runner: async (job) => {
      assert.equal(Object.hasOwn(job.request, "apiKey"), false);
      assert.deepEqual(job.request.outpaint, { top: 1, right: 0, bottom: 0, left: 0 });
      const error = Object.assign(
        new Error("provider failed at /tmp/private-map-candidate.png token=top-secret"),
        {
          code: "IMAGE_PROVIDER_ERROR",
          quality: { privateNote: "/tmp/private-quality.json" },
        },
      );
      throw error;
    },
  });
});

test("preserves safe structured provider diagnostics on a failed map candidate", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath, {
      operation: "outpaint",
      prompt: "extend",
      sourcePaths: ["assets/source.png"],
      size: "2512x944",
    }));
    await assert.rejects(admitted.promise);
    const snapshot = store.snapshot({ jobId: admitted.id, identity });
    assert.deepEqual(snapshot.error, {
      code: "IMAGE_SIZE_MISMATCH",
      message: "供应商不支持该画布尺寸",
      statusCode: 502,
      retryable: false,
      stage: "provider",
      operation: "outpaint",
      reason: "provider_size_unsupported",
      model: "gpt-image-2",
      requestedSize: "2512x944",
      providerSize: "1536x1024",
      sourceSize: "1672x941",
      providerRequestId: "req_map_123",
      providerStatusCode: 502,
      requestedWidth: 2512,
      requestedHeight: 944,
      actualWidth: 1536,
      actualHeight: 1024,
      supportedSizes: ["1536x1024"],
      preserveSource: "exact",
      alignmentPolicy: "reject",
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /api[_-]?key|secret|\/srv\/|providerPayload|rawResponse/iu);
  }, {
    runner: async () => {
      throw Object.assign(new Error("供应商不支持该画布尺寸"), {
        code: "IMAGE_SIZE_MISMATCH",
        statusCode: 502,
        retryable: false,
        stage: "provider",
        operation: "outpaint",
        reason: "provider_size_unsupported",
        model: "gpt-image-2",
        requestedSize: "2512x944",
        providerSize: "1536x1024",
        sourceSize: "1672x941",
        providerRequestId: "req_map_123",
        providerStatusCode: 502,
        requestedWidth: 2512,
        requestedHeight: 944,
        actualWidth: 1536,
        actualHeight: 1024,
        supportedSizes: ["1536x1024", "/srv/private.png", "not-a-size"],
        preserveSource: "exact",
        alignmentPolicy: "reject",
        secret: "must-not-leak",
      });
    },
  });
});

test("uses current manual admission limits for newly submitted jobs", async () => {
  let maxJobs = 1;
  const releases = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfl-map-image-limits-"));
  const projectPath = path.join(root, "project");
  await fs.mkdir(projectPath, { recursive: true });
  const store = await new MapImageJobStore({
    temporaryRoot: path.join(root, "candidates"),
    limits: () => ({ maxJobs, concurrency: maxJobs }),
    runner: () => new Promise((resolve) => releases.push(() => resolve({ files: [{ data: PNG }] }))),
  }).initialize();
  try {
    const first = store.enqueue(input(projectPath));
    assert.throws(() => store.enqueue(input(projectPath)), (error) => error.code === "MAP_IMAGE_QUEUE_FULL");
    maxJobs = 2;
    const second = store.enqueue(input(projectPath));
    await waitFor(() => releases.length === 2, "dynamic map image admissions");
    releases.splice(0).forEach((release) => release());
    await Promise.all([first.promise, second.promise]);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("publishes a candidate only after explicit confirmation and current map authorization", async () => {
  const authorizations = [];
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    const common = {
      jobId: admitted.id,
      identity,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/plants/fern.png" }],
    };
    await assert.rejects(
      store.publish(common),
      (error) => error.code === "MAP_IMAGE_CONFIRMATION_REQUIRED" && error.statusCode === 400,
    );
    assert.equal(await fs.stat(path.join(projectPath, "assets")).catch(() => null), null);

    const result = await store.publish({ ...common, confirmation: admitted.id });
    assert.equal(result.job.status, "published");
    assert.equal(result.published[0].relativePath, "assets/generated/plants/fern.png");
    assert.deepEqual(await fs.readFile(path.join(projectPath, result.published[0].relativePath)), PNG);
    assert.equal(authorizations.length, 2);
    assert.equal(authorizations[0].mapContext.mapSessionId, "map-session-0001");
    assert.equal(Object.hasOwn(result, "attachment"), false);
  }, { authorizeSession: async (context) => authorizations.push(context) });
});

test("publishes image, external TSJ, and composite TMJ in one atomic transaction", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    const result = await store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/bundle/fern.png" }],
      companions: [
        {
          type: "tileset-atlas",
          sourceIndex: 0,
          path: "assets/generated/bundle/fern.tsj",
          name: "Fern atlas",
          tileWidth: 1,
          tileHeight: 1,
          margin: 0,
          spacing: 0,
        },
        {
          type: "composite-map",
          sourceIndex: 0,
          path: "assets/generated/bundle/fern.tmj",
          name: "Fern composite",
          tileWidth: 1,
          tileHeight: 1,
        },
      ],
    });
    assert.equal(result.published.length, 3);
    assert.deepEqual(result.published.map((entry) => entry.artifactType), ["image", "tileset", "composite"]);
    assert.equal(result.published[0].relativePath, "assets/generated/bundle/fern.png");
    assert.equal(result.published[1].sourceIndex, 0);
    assert.deepEqual(result.published[1].dependencies, ["assets/generated/bundle/fern.png"]);
    assert.equal(result.published[1].tileCount, 1);
    assert.equal(result.published[2].layerCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /stagedPath|sourcePath|map-image-candidates|\/tmp\//u);

    const tileset = JSON.parse(await fs.readFile(
      path.join(projectPath, "assets/generated/bundle/fern.tsj"),
      "utf8",
    ));
    assert.equal(tileset.type, "tileset");
    assert.equal(tileset.image, "fern.png");
    assert.equal(tileset.imagewidth, 1);
    assert.equal(tileset.tilecount, 1);
    const composite = JSON.parse(await fs.readFile(
      path.join(projectPath, "assets/generated/bundle/fern.tmj"),
      "utf8",
    ));
    assert.equal(composite.type, "map");
    assert.equal(composite.layers[0].type, "imagelayer");
    assert.equal(composite.layers[0].image, "fern.png");
    assert.deepEqual(await fs.readFile(path.join(projectPath, "assets/generated/bundle/fern.png")), PNG);
  });
});

test("rolls back the whole map asset bundle when a companion destination exists", async () => {
  await fixture(async ({ projectPath, store }) => {
    const existingPath = path.join(projectPath, "assets/generated/bundle/fern.tsj");
    await fs.mkdir(path.dirname(existingPath), { recursive: true });
    await fs.writeFile(existingPath, "existing tileset");
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    await assert.rejects(store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/bundle/fern.png" }],
      companions: [{
        type: "tileset-atlas",
        sourceIndex: 0,
        path: "assets/generated/bundle/fern.tsj",
        name: "Fern atlas",
        tileWidth: 1,
        tileHeight: 1,
        margin: 0,
        spacing: 0,
      }],
    }), (error) => error.code === "MAP_IMAGE_DESTINATION_EXISTS");
    assert.equal(await fs.stat(path.join(projectPath, "assets/generated/bundle/fern.png")).catch(() => null), null);
    assert.equal(await fs.readFile(existingPath, "utf8"), "existing tileset");
    assert.equal(store.snapshot({ jobId: admitted.id, identity }).status, "succeeded");
  });
});

test("rejects companion atlas grids that do not exactly cover the candidate", async () => {
  const twoByOne = await rgbaPng(2, 1, () => [64, 96, 48, 255]);
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    await assert.rejects(store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/generated/bundle/ground.png" }],
      companions: [{
        type: "tileset-atlas",
        sourceIndex: 0,
        path: "assets/generated/bundle/ground.tsj",
        name: "Ground",
        tileWidth: 2,
        tileHeight: 2,
        margin: 0,
        spacing: 0,
      }],
    }), (error) => error.code === "MAP_IMAGE_TILESET_ALIGNMENT" && error.statusCode === 422);
    assert.deepEqual(await fs.readdir(projectPath), []);
  }, { runner: async () => ({ files: [{ data: twoByOne }] }) });
});

test("rejects stale versions, cross-window access, and path escapes", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    const publication = {
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "b".repeat(64),
      destinations: [{ index: 0, path: "assets/fern.png" }],
    };
    await assert.rejects(store.publish(publication), (error) => error.code === "MAP_IMAGE_VERSION_CONFLICT");
    assert.throws(
      () => store.snapshot({ jobId: admitted.id, identity: { ...identity, editorInstanceId: "map-editor-window-0002" } }),
      (error) => error.code === "MAP_IMAGE_JOB_NOT_FOUND",
    );
    await assert.rejects(
      store.publish({ ...publication, mapVersion: "a".repeat(64), destinations: [{ index: 0, path: "../escape.png" }] }),
      (error) => error.code === "MAP_IMAGE_DESTINATION_INVALID",
    );
    assert.equal(await fs.stat(path.join(projectPath, "assets")).catch(() => null), null);
  });
});

test("does not allow read-only map sessions to enqueue image work", async () => {
  await fixture(async ({ projectPath, store }) => {
    const value = input(projectPath);
    value.mapContext.writable = false;
    assert.throws(() => store.enqueue(value), (error) => error.code === "MAP_IMAGE_READ_ONLY");
  });
});

test("revalidates the bound map session before starting provider work", async () => {
  let ran = false;
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await assert.rejects(admitted.promise, (error) => error.code === "map-version-conflict");
    assert.equal(ran, false);
    assert.equal(store.snapshot({ jobId: admitted.id, identity }).status, "failed");
  }, {
    authorizeSession: async () => {
      const error = new Error("地图版本已变化");
      error.code = "map-version-conflict";
      throw error;
    },
    runner: async () => {
      ran = true;
      return { files: [{ data: Buffer.from("must-not-run") }] };
    },
  });
});

test("does not silently overwrite an existing project asset", async () => {
  await fixture(async ({ projectPath, store }) => {
    const existing = path.join(projectPath, "assets", "plant.png");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(existing, "original");
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    await assert.rejects(store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/plant.png" }],
    }), (error) => error.code === "MAP_IMAGE_DESTINATION_EXISTS" && /发布目标已存在/u.test(error.message));
    assert.equal(await fs.readFile(existing, "utf8"), "original");
  });
});

test("opens candidate previews by identity without exposing their staged path", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    const opened = await store.openCandidateFile({
      jobId: admitted.id,
      identity,
      mapVersion: "a".repeat(64),
      index: 0,
    });
    try {
      assert.deepEqual(await opened.handle.readFile(), PNG);
      assert.equal(opened.metadata.mediaType, "image/png");
      assert.equal(Object.hasOwn(opened.metadata, "stagedPath"), false);
    } finally {
      await opened.handle.close();
    }
    await assert.rejects(store.openCandidateFile({
      jobId: admitted.id,
      identity: { ...identity, editorInstanceId: "map-editor-window-0002" },
      mapVersion: "a".repeat(64),
      index: 0,
    }), (error) => error.code === "MAP_IMAGE_JOB_NOT_FOUND");
  });
});

test("rejects invalid candidate bytes and mismatched provider metadata", async () => {
  await fixture(async ({ projectPath, store }) => {
    const invalid = store.enqueue(input(projectPath));
    await assert.rejects(invalid.promise, (error) => error.code === "MAP_IMAGE_INVALID_RESULT");
  }, { runner: async () => ({ files: [{ data: Buffer.from("not an image") }] }) });

  await fixture(async ({ projectPath, store }) => {
    const mismatch = store.enqueue(input(projectPath));
    await assert.rejects(mismatch.promise, (error) => error.code === "MAP_IMAGE_METADATA_MISMATCH");
  }, { runner: async () => ({ files: [{ data: PNG, width: 99, height: 1 }] }) });
});

test("rolls back the whole candidate batch when one destination conflicts", async () => {
  await fixture(async ({ projectPath, store }) => {
    const existingPath = path.join(projectPath, "assets", "second.png");
    await fs.mkdir(path.dirname(existingPath), { recursive: true });
    await fs.writeFile(existingPath, "existing");
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    await assert.rejects(store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [
        { index: 0, path: "assets/first.png" },
        { index: 1, path: "assets/second.png" },
      ],
    }), (error) => error.code === "MAP_IMAGE_DESTINATION_EXISTS");
    assert.equal(await fs.stat(path.join(projectPath, "assets", "first.png")).catch(() => null), null);
    assert.equal(await fs.readFile(existingPath, "utf8"), "existing");
  }, { runner: async () => ({ files: [{ data: PNG }, { data: PNG }] }) });
});

test("rejects symlinked publish parents and never writes outside the project", async () => {
  await fixture(async ({ root, projectPath, store }) => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(projectPath, "assets"));
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    await assert.rejects(store.publish({
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/escape.png" }],
    }), (error) => error.code === "MAP_IMAGE_UNSAFE_DESTINATION" && error.statusCode === 403);
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test("coalesces concurrent publish confirmations for the same destination batch", async () => {
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await admitted.promise;
    const publication = {
      jobId: admitted.id,
      identity,
      confirmation: admitted.id,
      mapVersion: "a".repeat(64),
      destinations: [{ index: 0, path: "assets/concurrent.png" }],
    };
    const [first, second] = await Promise.all([store.publish(publication), store.publish(publication)]);
    assert.deepEqual(first.published, second.published);
    assert.deepEqual(await fs.readFile(path.join(projectPath, "assets", "concurrent.png")), PNG);
  });
});

test("bounds candidate count/bytes and disposes the worker result after staging", async () => {
  let disposed = 0;
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue(input(projectPath));
    await assert.rejects(admitted.promise, (error) => error.code === "MAP_IMAGE_TOO_MANY_FILES");
    assert.equal(disposed, 1);
  }, {
    maxCandidateFiles: 1,
    runner: async () => ({
      files: [{ data: PNG }, { data: PNG }],
      dispose: () => { disposed += 1; },
    }),
  });
});

test("filters job listings by the bound map session", async () => {
  await fixture(async ({ projectPath, store }) => {
    const first = store.enqueue(input(projectPath));
    const secondInput = input(projectPath);
    secondInput.mapContext.mapSessionId = "map-session-0002";
    const second = store.enqueue(secondInput);
    await Promise.all([first.promise, second.promise]);
    assert.deepEqual(store.list({ identity, mapSessionId: "map-session-0001" }).map((job) => job.id), [first.id]);
    assert.deepEqual(store.list({ identity, mapSessionId: "map-session-0002" }).map((job) => job.id), [second.id]);
  });
});

test("logout cancels queued and running image jobs only for the exact browser login", async () => {
  const otherIdentity = { ...identity, browserSessionId: "browser-session-2" };
  const started = [];
  await fixture(async ({ projectPath, store }) => {
    const running = store.enqueue(input(projectPath, { operation: "generate", prompt: "running" }));
    const queued = store.enqueue(input(projectPath, { operation: "generate", prompt: "queued" }));
    const otherInput = input(projectPath, { operation: "generate", prompt: "other login" });
    otherInput.identity = otherIdentity;
    const survivor = store.enqueue(otherInput);
    const runningRejected = assert.rejects(
      running.promise,
      (error) => error.code === "MAP_IMAGE_CANCELED",
    );
    const queuedRejected = assert.rejects(
      queued.promise,
      (error) => error.code === "MAP_IMAGE_CANCELED",
    );

    await waitFor(() => started.length === 1, "running image job");
    assert.deepEqual(await store.cancelForBrowserSession(identity), { canceled: 2 });
    await Promise.all([runningRejected, queuedRejected]);
    await survivor.promise;

    assert.equal(store.snapshot({ jobId: running.id, identity }).status, "canceled");
    assert.equal(store.snapshot({ jobId: queued.id, identity }).status, "canceled");
    assert.equal(store.snapshot({ jobId: survivor.id, identity: otherIdentity }).status, "succeeded");
    assert.deepEqual(started.map((entry) => entry.prompt), ["running", "other login"]);
  }, {
    concurrency: 1,
    runner: (job, { signal }) => new Promise((resolve, reject) => {
      started.push({ prompt: job.request.prompt, resolve });
      if (job.request.prompt === "other login") {
        resolve({ files: [{ data: PNG }] });
        return;
      }
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { code: "MAP_IMAGE_CANCELED" }));
      }, { once: true });
    }),
  });
});

test("revoking an account cancels image jobs across all of its browser logins", async () => {
  const secondIdentity = { ...identity, browserSessionId: "browser-session-2" };
  const survivorIdentity = { ...identity, userId: "user-2", browserSessionId: "browser-session-3" };
  const started = [];
  await fixture(async ({ projectPath, store }) => {
    const first = store.enqueue(input(projectPath, { operation: "generate", prompt: "first login" }));
    const secondInput = input(projectPath, { operation: "generate", prompt: "second login" });
    secondInput.identity = secondIdentity;
    const second = store.enqueue(secondInput);
    const survivorInput = input(projectPath, { operation: "generate", prompt: "other user" });
    survivorInput.identity = survivorIdentity;
    const survivor = store.enqueue(survivorInput);
    const firstRejected = assert.rejects(first.promise, (error) => error.code === "MAP_IMAGE_CANCELED");
    const secondRejected = assert.rejects(second.promise, (error) => error.code === "MAP_IMAGE_CANCELED");

    await waitFor(() => started.length === 1, "first account image job");
    assert.deepEqual(await store.cancelForUser({ userId: identity.userId }), { canceled: 2 });
    await Promise.all([firstRejected, secondRejected]);
    await survivor.promise;
    assert.equal(store.snapshot({ jobId: survivor.id, identity: survivorIdentity }).status, "succeeded");
    assert.deepEqual(started, ["first login", "other user"]);
  }, {
    concurrency: 1,
    runner: (job, { signal }) => new Promise((resolve, reject) => {
      started.push(job.request.prompt);
      if (job.identity.userId === survivorIdentity.userId) {
        resolve({ files: [{ data: PNG }] });
        return;
      }
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), {
        code: "MAP_IMAGE_CANCELED",
      })), { once: true });
    }),
  });
});

test("releases retained input leases when a queued job is canceled", async () => {
  let finalized = 0;
  let releaseFirst;
  await fixture(async ({ projectPath, store }) => {
    const first = store.enqueue({
      ...input(projectPath),
      onFinalized: () => { finalized += 1; },
    });
    const queued = store.enqueue({
      ...input(projectPath, { operation: "generate", prompt: "queued" }),
      onFinalized: () => { finalized += 1; },
    });
    await store.cancel({ jobId: queued.id, identity });
    await assert.rejects(queued.promise, (error) => error.code === "MAP_IMAGE_CANCELED");
    releaseFirst();
    await first.promise;
    await waitFor(() => finalized === 2, "queued lease finalizer");
    assert.equal(store.snapshot({ jobId: queued.id, identity }).status, "canceled");
  }, {
    concurrency: 1,
    runner: () => new Promise((resolve) => {
      releaseFirst = () => resolve({ files: [{ data: PNG }] });
    }),
  });
});

test("releases retained input leases when a candidate is explicitly discarded", async () => {
  let finalized = 0;
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue({
      ...input(projectPath),
      onFinalized: () => { finalized += 1; },
    });
    await admitted.promise;
    assert.equal(finalized, 1, "normal completion finalizes once");
    // A completed job has already released its lease; discard remains
    // idempotent and must not invoke the callback a second time.
    store.discard({ jobId: admitted.id, identity });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(finalized, 1);
  });
});

test("expires stale candidates and invokes the finalizer", async () => {
  let clock = 1_000;
  let finalized = 0;
  await fixture(async ({ projectPath, store }) => {
    const admitted = store.enqueue({
      ...input(projectPath),
      onFinalized: () => { finalized += 1; },
    });
    await admitted.promise;
    // Completion already runs the finalizer. Calling prune on an old
    // candidate must remain idempotent and remove the staged directory.
    clock += 2_000;
    store.prune();
    assert.equal(finalized, 1);
    assert.equal(store.snapshot({ jobId: admitted.id, identity }).status, "expired");
  }, { now: () => clock, ttlMs: 1_000 });
});
