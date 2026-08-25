import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  buildMapImageEditRequest,
  buildMapImageCandidateRequest,
  buildMapImageCropRequest,
  buildMapImageOutpaintRequest,
  buildMapImagePublicationRequest,
  mapImageAssetPreset,
  mapImageJobIsActive,
  mapImageOperationAvailability,
  normalizeMapImageCandidateConfig,
  normalizeMapImagePublishPath,
  suggestedMapImageCompanionPath,
  suggestedMapImagePublishPath,
} from "../public/map-editor/map-image-candidates.js";

function config(overrides = {}) {
  return normalizeMapImageCandidateConfig({
    capabilities: {
      enabled: true,
      operations: ["generate", "edit", "outpaint"],
      features: { strictMask: true, seamlessOutpaint: true, localCrop: true },
      operationCapabilities: { generate: { customSize: false, sizes: ["1024x1024", "1536x1024"] } },
      defaults: { size: "1024x1024", quality: "auto", moderation: "auto" },
      limits: { maxPromptCharacters: 4000 },
      options: {
        sizes: ["1024x1024", "1536x1024"], qualities: ["auto", "high"],
        outputFormats: ["png", "webp"], backgrounds: ["transparent", "opaque"],
        moderations: ["auto", "low"],
      },
      ...(overrides.capabilities || {}),
    },
    worker: { enabled: true, accepting: true, preset: "balanced", ...(overrides.worker || {}) },
  });
}

test("builds candidate-only transparent plant, prop, and tileset requests", () => {
  const normalized = config();
  const plant = buildMapImageCandidateRequest({
    kind: "plant", prompt: "Hand-painted fern matching the forest map", size: "1024x1024", quality: "high",
  }, normalized);
  assert.equal(plant.assetKind, "plant");
  assert.equal(plant.background, "transparent");
  assert.match(plant.prompt, /clear ground-contact anchor/u);
  const prop = buildMapImageCandidateRequest({
    kind: "prop", prompt: "Hand-painted fern matching the forest map", size: "1024x1024", quality: "high",
  }, normalized);
  assert.equal(prop.operation, "generate");
  assert.equal(prop.background, "transparent");
  assert.equal(prop.assetKind, "prop");
  assert.deepEqual(prop.qualityTarget, {
    schemaVersion: "map-image-quality-target-v1",
    alpha: "required",
  });
  assert.equal(prop.outputFormat, "png");
  assert.equal(prop.stream, false);
  assert.equal(prop.n, 1);
  assert.match(prop.prompt, /Reusable isolated 2D game map prop/u);
  const tileset = buildMapImageCandidateRequest({
    kind: "tileset", prompt: "Mossy dungeon floor tiles", size: "1536x1024", quality: "auto",
  }, normalized);
  assert.match(tileset.prompt, /tileset atlas/u);
  assert.equal(tileset.assetKind, "tileset");
  assert.deepEqual(tileset.qualityTarget, {
    schemaVersion: "map-image-quality-target-v1",
    alpha: "required",
  });
});

test("builds an explicit opaque periodic terrain target separately from tileset atlases", () => {
  const terrain = buildMapImageCandidateRequest({
    kind: "terrain", prompt: "Top-down mossy forest ground", size: "1024x1024", quality: "high",
  }, config());
  assert.equal(terrain.assetKind, "terrain");
  assert.equal(terrain.background, "opaque");
  assert.match(terrain.prompt, /periodic tiling target on both horizontal and vertical axes/u);
  assert.deepEqual(terrain.qualityTarget, {
    schemaVersion: "map-image-quality-target-v1",
    tiling: { mode: "periodic", axes: ["horizontal", "vertical"] },
  });
  assert.equal(
    suggestedMapImagePublishPath("terrain", new Date("2026-08-10T03:04:05Z")),
    "assets/generated/terrain/terrain-20260810-030405.png",
  );
  assert.throws(
    () => buildMapImageCandidateRequest({
      kind: "terrain", prompt: "ground", size: "1024x1024",
    }, config({ capabilities: { options: {
      sizes: ["1024x1024"], qualities: ["auto"], outputFormats: ["png"],
      backgrounds: ["transparent"], moderations: ["auto"],
    } } })),
    /不透明 PNG/u,
  );
});

test("builds a full opaque background without weakening it into a tile or transparent asset", () => {
  const background = buildMapImageCandidateRequest({
    kind: "background", prompt: "Fixed forest battle scene", size: "1536x1024", quality: "high",
  }, config());
  assert.equal(background.assetKind, "background");
  assert.equal(background.background, "opaque");
  assert.match(background.prompt, /Complete opaque full-bleed 2D game scene background/u);
  assert.match(background.prompt, /collision and interactive runtime objects remain separate map data/u);
  assert.deepEqual(background.qualityTarget, {
    schemaVersion: "map-image-quality-target-v1",
    alpha: "opaque",
  });
  assert.equal(
    suggestedMapImagePublishPath("background", new Date("2026-08-10T03:04:05Z")),
    "assets/generated/backgrounds/background-20260810-030405.png",
  );
});

test("map editor exposes segmented operations and all explicit map asset presets", async () => {
  const [html, source] = await Promise.all([
    fs.readFile(new URL("../public/map-editor.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/map-editor/map-editor.js", import.meta.url), "utf8"),
  ]);
  for (const [value, label] of [
    ["plant", "透明植物"], ["prop", "透明地图物件"], ["tileset", "瓦片集图集"],
    ["terrain", "无缝地块"], ["background", "完整背景"],
  ]) assert.match(html, new RegExp(`<option value="${value}">${label}<\\/option>`, "u"));
  assert.match(html, /id="mapImageOperation"[\s\S]*?type="radio"[\s\S]*?value="generate"[\s\S]*?value="edit"[\s\S]*?value="outpaint"/u);
  assert.match(source, /function currentMapImageOperation\(\)/u);
  assert.match(source, /不会自动切换操作/u);
  assert.doesNotMatch(source, /elements\.mapImageOperation\.value = "generate"/u);
  assert.match(source, /\["plant", "prop", "tileset", "terrain", "background"\]\.includes\(job\?\.request\?\.assetKind\)/u);
  assert.match(source, /return mapImageAssetPreset\(kind\)\.label/u);
  assert.match(source, /elements\.mapImageKind\.addEventListener\("change", \(\) =>/u);
});

test("reports each operation capability independently without fallback", () => {
  const generationOnly = config({ capabilities: { operations: ["generate"] } });
  assert.deepEqual(mapImageOperationAvailability(generationOnly, "generate", { kind: "plant" }), {
    enabled: true,
    reason: "",
  });
  assert.match(mapImageOperationAvailability(generationOnly, "edit").reason, /未启用编辑/u);
  assert.match(mapImageOperationAvailability(generationOnly, "outpaint").reason, /未启用扩图/u);

  const opaqueOnly = config({ capabilities: { options: {
    sizes: ["1024x1024"], qualities: ["auto"], outputFormats: ["png"],
    backgrounds: ["opaque"], moderations: ["auto"],
  } } });
  assert.equal(mapImageOperationAvailability(opaqueOnly, "generate", { kind: "background" }).enabled, true);
  assert.match(mapImageOperationAvailability(opaqueOnly, "generate", { kind: "plant" }).reason, /透明 PNG/u);
  assert.equal(mapImageAssetPreset("terrain").background, "opaque");
  assert.throws(() => mapImageAssetPreset("actor"), /类型无效/u);
});

test("admits only the asset kinds supported by explicit PNG background capabilities", () => {
  assert.equal(config().ready, true);
  assert.match(config({ worker: { accepting: false } }).reason, /暂停/u);
  assert.match(config({ capabilities: { options: { outputFormats: ["jpeg"], backgrounds: ["opaque"] } } }).reason, /PNG/u);
  const opaqueOnly = config({ capabilities: { options: {
    sizes: ["1024x1024"], qualities: ["auto"], outputFormats: ["png"],
    backgrounds: ["opaque"], moderations: ["auto"],
  } } });
  assert.equal(opaqueOnly.ready, true);
  assert.equal(buildMapImageCandidateRequest({
    kind: "terrain", prompt: "ground", size: "1024x1024",
  }, opaqueOnly).background, "opaque");
  assert.throws(
    () => buildMapImageCandidateRequest({ kind: "prop", prompt: "fern", size: "1024x1024" }, opaqueOnly),
    /透明 PNG/u,
  );
  assert.match(config({ capabilities: { options: {
    sizes: ["1024x1024"], qualities: ["auto"], outputFormats: ["png"],
    backgrounds: ["auto"], moderations: ["auto"],
  } } }).reason, /透明或不透明背景/u);
  assert.throws(
    () => buildMapImageCandidateRequest({ kind: "prop", prompt: "fern", size: "800x800" }, config()),
    /尺寸/u,
  );
});

test("validates explicit publish paths and creates non-publishing suggestions", () => {
  assert.equal(normalizeMapImagePublishPath("assets/generated/props/fern.png", "png"), "assets/generated/props/fern.png");
  for (const value of ["/tmp/fern.png", "../fern.png", "assets//fern.png", "assets/fern.jpg", "assets\\fern.png"]) {
    assert.throws(() => normalizeMapImagePublishPath(value, "png"));
  }
  assert.equal(
    suggestedMapImagePublishPath("tileset", new Date("2026-08-10T03:04:05Z")),
    "assets/generated/tilesets/tileset-20260810-030405.png",
  );
  assert.equal(
    suggestedMapImagePublishPath("outpaint", new Date("2026-08-10T03:04:05Z")),
    "assets/generated/outpaint/outpaint-20260810-030405.png",
  );
});

test("builds explicit image, PNG plus TSJ, and composite publication requests", () => {
  const file = { index: 2, format: "png" };
  assert.deepEqual(buildMapImagePublicationRequest({
    file,
    imagePath: "assets/generated/props/fern.png",
  }), {
    destinations: [{ index: 2, path: "assets/generated/props/fern.png" }],
    companions: [],
  });
  assert.equal(
    suggestedMapImageCompanionPath("assets/generated/tilesets/moss.png", "tileset-atlas"),
    "assets/generated/tilesets/moss.tsj",
  );
  const tileset = buildMapImagePublicationRequest({
    file,
    imagePath: "assets/generated/tilesets/moss.png",
    mode: "tileset-atlas",
    companionPath: "assets/generated/tilesets/moss.tsj",
    name: "Moss",
    tileWidth: 32,
    tileHeight: 16,
    margin: 1,
    spacing: 2,
  });
  assert.deepEqual(tileset.companions, [{
    type: "tileset-atlas",
    sourceIndex: 2,
    path: "assets/generated/tilesets/moss.tsj",
    name: "Moss",
    tileWidth: 32,
    tileHeight: 16,
    margin: 1,
    spacing: 2,
  }]);
  const composite = buildMapImagePublicationRequest({
    file,
    imagePath: "assets/generated/props/fern.png",
    mode: "composite-map",
    companionPath: "assets/generated/props/fern.tmj",
    name: "Fern group",
    tileWidth: 16,
    tileHeight: 16,
  });
  assert.equal(composite.companions[0].type, "composite-map");
  assert.equal(composite.companions[0].path, "assets/generated/props/fern.tmj");
  assert.throws(() => buildMapImagePublicationRequest({
    file,
    imagePath: "assets/generated/props/fern.png",
    mode: "tileset-atlas",
    companionPath: "assets/generated/props/fern.tmj",
    tileWidth: 16,
    tileHeight: 16,
  }), /\.tsj/u);
});

test("polling treats queue, worker, and publication as active", () => {
  for (const status of ["queued", "running", "publishing"]) assert.equal(mapImageJobIsActive({ status }), true);
  for (const status of ["succeeded", "published", "failed", "expired", "canceled"]) assert.equal(mapImageJobIsActive({ status }), false);
});

test("builds authorized edit and outpaint requests without accepting free-text paths", () => {
  const normalized = config({ capabilities: {
    operationCapabilities: {
      generate: { customSize: false, sizes: ["1024x1024", "1536x1024"] },
      edit: { customSize: false, sizes: ["1024x1024"] },
      outpaint: { customSize: false, sizes: ["1536x1024"] },
    },
  } });
  const edit = buildMapImageEditRequest({
    prompt: "Replace the selected moss with matching clean HD grass",
    sourcePaths: ["assets/maps/moss.png"],
    maskPath: "assets/maps/moss-mask.png",
    maskMode: "strict",
    maskFeather: 12,
    size: "1024x1024",
    quality: "high",
  }, normalized, {
    authorizedSourcePaths: ["assets/maps/moss.png"],
    authorizedMaskPaths: ["assets/maps/moss-mask.png"],
  });
  assert.equal(edit.operation, "edit");
  assert.deepEqual(edit.sourcePaths, ["assets/maps/moss.png"]);
  assert.equal(edit.maskPath, "assets/maps/moss-mask.png");
  assert.equal(edit.maskFeather, 12);
  assert.equal(edit.outputFormat, "png");
  assert.equal(edit.background, "transparent");

  const outpaint = buildMapImageOutpaintRequest({
    prompt: "Continue the forest edge with matching lighting",
    sourcePaths: ["assets/maps/moss.png"],
    outpaint: { left: 128, right: 0, top: 0, bottom: 64 },
    preserveSource: "seamless",
    blendMargin: 64,
    alignmentPolicy: "pad-and-crop",
    quality: "auto",
  }, normalized, { authorizedSourcePaths: ["assets/maps/moss.png"] });
  assert.equal(outpaint.operation, "outpaint");
  assert.deepEqual(outpaint.outpaint, { left: 128, right: 0, top: 0, bottom: 64 });
  assert.equal(outpaint.preserveSource, "seamless");
  assert.equal(outpaint.blendMargin, 64);
  assert.equal(outpaint.size, undefined);

  assert.throws(
    () => buildMapImageEditRequest({ prompt: "x", sourcePaths: ["assets/maps/other.png"], size: "1024x1024" }, normalized, {
      authorizedSourcePaths: ["assets/maps/moss.png"],
    }),
    /已授权/u,
  );
  assert.throws(
    () => buildMapImageOutpaintRequest({ prompt: "x", sourcePaths: ["assets/maps/moss.png", "assets/maps/other.png"], outpaint: { right: 1 } }, normalized, {
      authorizedSourcePaths: ["assets/maps/moss.png", "assets/maps/other.png"],
    }),
    /一张/u,
  );
});

test("builds temporary-input requests without leaking source or mask paths", () => {
  const normalized = config({ capabilities: {
    operationCapabilities: {
      generate: { customSize: false, sizes: ["1024x1024"] },
      edit: { customSize: false, sizes: ["1024x1024"] },
      outpaint: { customSize: false, sizes: ["1024x1024"] },
    },
  } });
  const edit = buildMapImageEditRequest({
    prompt: "repair selected pixels",
    maskMode: "strict",
    size: "1024x1024",
  }, normalized, { temporaryInputCount: 1, hasTemporaryMask: true });
  assert.equal(edit.operation, "edit");
  assert.equal(Object.hasOwn(edit, "sourcePaths"), false);
  assert.equal(Object.hasOwn(edit, "maskPath"), false);
  assert.equal(edit.maskMode, "strict");

  const outpaint = buildMapImageOutpaintRequest({
    prompt: "continue the selected edge",
    outpaint: { top: 0, right: 64, bottom: 0, left: 0 },
    sourceCrop: { top: 8, right: 0, bottom: 0, left: 4 },
    preserveSource: "exact",
    alignmentPolicy: "reject",
  }, normalized, { temporaryInputCount: 1 });
  assert.equal(outpaint.operation, "outpaint");
  assert.equal(Object.hasOwn(outpaint, "sourcePaths"), false);
  assert.deepEqual(outpaint.sourceCrop, { top: 8, right: 0, bottom: 0, left: 4 });
  assert.throws(
    () => buildMapImageOutpaintRequest({
      prompt: "crop then extend",
      sourcePaths: ["assets/maps/moss.png"],
      sourceCrop: { left: 4 },
      outpaint: { right: 8 },
    }, normalized, { authorizedSourcePaths: ["assets/maps/moss.png"] }),
    /临时源图/u,
  );
});

test("builds a provider-free pure crop request only from one temporary PNG", () => {
  const crop = buildMapImageCropRequest({
    sourceSize: { width: 32, height: 16 },
    sourceCrop: { top: 0, right: 0, bottom: 0, left: 4 },
  }, { temporaryInputCount: 1 });
  assert.deepEqual(crop, {
    operation: "crop",
    sourceSize: { width: 32, height: 16 },
    sourceCrop: { top: 0, right: 0, bottom: 0, left: 4 },
    outputFormat: "png",
    n: 1,
  });
  assert.equal(Object.hasOwn(crop, "prompt"), false);
  assert.equal(Object.hasOwn(crop, "sourcePaths"), false);
  assert.throws(() => buildMapImageCropRequest({
    sourceSize: { width: 32, height: 16 },
    sourceCrop: { left: 32 },
  }, { temporaryInputCount: 1 }), /至少需要保留/u);
  assert.throws(() => buildMapImageCropRequest({
    sourceSize: { width: 32, height: 16 },
    sourceCrop: { left: 4 },
  }, { temporaryInputCount: 0 }), /临时源图/u);
  assert.equal(
    suggestedMapImagePublishPath("crop", new Date("2026-08-10T03:04:05Z")),
    "assets/generated/crops/crop-20260810-030405.png",
  );
});
