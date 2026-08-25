import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  assertProjectRelativePath,
  authorizeImagePartialPreviewUrl,
  buildImageExecutePayload,
  createImageStudioNonce,
  formatImageBytes,
  normalizeImageStudioCapabilities,
  readImageEventStream,
} from "../public/image-studio.js";

const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/image-studio.css", import.meta.url), "utf8");
const studioSource = await fs.readFile(new URL("../public/image-studio.js", import.meta.url), "utf8");
const requestIdentity = Object.freeze({
  windowId: "a".repeat(64),
  operationId: "b".repeat(64),
});

const capabilities = normalizeImageStudioCapabilities({
  enabled: true,
  presetId: "openai-gpt-image-2",
  operations: ["generate", "edit", "outpaint"],
  features: {
    mask: true,
    multiInput: true,
    streaming: true,
    inputFidelity: false,
    strictMask: true,
    seamlessOutpaint: true,
  },
  operationCapabilities: {
    generate: { customSize: true, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
    edit: { customSize: false, sizes: ["1024x1024", "1536x1024"] },
    outpaint: { customSize: false, sizes: ["1536x1024"] },
  },
  defaults: {
    size: "1024x1024",
    quality: "high",
    outputFormat: "webp",
    outputCompression: 82,
    background: "auto",
    moderation: "auto",
    n: 2,
    partialImages: 1,
  },
  limits: {
    maxPromptCharacters: 32_000,
    maxInputImages: 16,
    maxOutputs: 10,
    maxPartialImages: 3,
    fixedSizes: [],
    size: {
      allowAuto: true,
      maxWidth: 3840,
      maxHeight: 3840,
      dimensionMultiple: 16,
      maxAspectRatio: 3,
      minPixels: 655360,
      maxPixels: 8294400,
    },
  },
  options: {
    qualities: ["auto", "low", "medium", "high"],
    outputFormats: ["png", "jpeg", "webp"],
    backgrounds: ["auto", "opaque"],
    moderations: ["auto", "low"],
    inputFidelities: [],
  },
});

test("Image Studio is a separate lazy-loaded responsive surface", async () => {
  assert.match(html, /id="imageStudioButton"/);
  assert.match(html, /id="resourceImageStudioButton"/);
  assert.match(app, /import\(`\.\/image-studio\.js\?v=/);
  assert.match(app, /resourceImageStudioButton\.addEventListener\("click", openResourceImageStudio\)/);
  assert.match(app, /initialSourcePath: sourcePath/);
  assert.match(app, /function openResourceImageStudio\(\)/);
  assert.match(app, /elements\.imageGenerationButton\.addEventListener\("click", toggleImageGenerationMode\)/);
  assert.match(app, /X-Codex-Desktop-Action/);
  assert.match(css, /\.image-studio-form/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /width: 100vw; height: 100dvh/);
  assert.match(studioSource, /id="imageStudioCancelButton"/);
  assert.match(studioSource, /assertProjectRelativePath\(initialPath, "源图片路径"\)/);
  assert.match(studioSource, /initialInputBlocked/);
  assert.match(studioSource, /未启用文件编辑能力/);
  assert.match(studioSource, /initialPrompt/);
  assert.match(studioSource, /initialDestination/);
  assert.match(studioSource, /const windowId = createImageStudioNonce\(\)/);
  assert.match(studioSource, /const operationId = createImageStudioNonce\(\)/);
  assert.doesNotMatch(studioSource, /localStorage|sessionStorage/);
});

test("Image Studio uses an explicit result context and never offers visual-review images to chat", () => {
  assert.match(app, /context: "conversation"/);
  assert.match(app, /function attachImageStudioOutput\(output, policy\)/);
  assert.match(app, /policy\?\.allowConversationAttachment !== true/);
  assert.match(app, /imageOutputConversationAttachment\(output, policy\.scope, \{ userSelected: true \}\)/u);
  assert.match(studioSource, /imageContextPolicy\(options\.context\);\s*if \(!studioInstance\)/u);
  assert.match(studioSource, /imageContextPolicy\(options\.context\)/);
  assert.match(studioSource, /policy\.actionLabel/);
  assert.match(studioSource, /policy\.scope === "visual-review"/);
  assert.match(studioSource, /policy\.scope/);
  assert.match(studioSource, /onAttachError/);
  assert.match(studioSource, /dataset\.imageContext = policy\.scope/);
});

test("per-page and per-operation nonces authorize only the matching partial preview URL", () => {
  const deterministicCrypto = {
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  };
  assert.equal(createImageStudioNonce(deterministicCrypto), "ab".repeat(32));
  assert.throws(() => createImageStudioNonce({}), /安全的图片窗口标识/);

  const token = "A".repeat(43);
  assert.equal(
    authorizeImagePartialPreviewUrl(`/api/images/v2/partial/${token}`, requestIdentity),
    `/api/images/v2/partial/${token}?windowId=${requestIdentity.windowId}&operationId=${requestIdentity.operationId}`,
  );
  assert.equal(authorizeImagePartialPreviewUrl("https://example.com/steal", requestIdentity), "");
  assert.equal(authorizeImagePartialPreviewUrl("/api/images/v2/partial/not-a-token", requestIdentity), "");
  assert.throws(
    () => authorizeImagePartialPreviewUrl(`/api/images/v2/partial/${token}`, { ...requestIdentity, windowId: "legacy" }),
    /窗口标识无效/,
  );
});

test("capabilities are explicit and do not infer operations from a preset or model", () => {
  assert.equal(capabilities.enabled, true);
  assert.deepEqual(capabilities.operations, ["generate", "edit", "outpaint"]);
  assert.equal(capabilities.features.streaming, true);
  assert.equal(capabilities.features.inputFidelity, false);
  assert.equal(capabilities.features.strictMask, true);
  assert.equal(capabilities.features.seamlessOutpaint, true);
  assert.deepEqual(capabilities.operationCapabilities.edit, {
    customSize: false,
    sizes: ["1024x1024", "1536x1024"],
  });
  assert.equal(capabilities.defaults.inputFidelity, "");
  assert.equal(capabilities.limits.maxPromptCharacters, 32_000);
  assert.deepEqual(capabilities.options.outputFormats, ["png", "jpeg", "webp"]);
  assert.deepEqual(capabilities.options.backgrounds, ["auto", "opaque"]);
  assert.deepEqual(capabilities.options.inputFidelities, []);
  const disabled = normalizeImageStudioCapabilities({ presetId: "openai-gpt-image-2" });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.operations, []);
});

test("gpt-image-2 edit payload retains supported controls and omits input fidelity", () => {
  const payload = buildImageExecutePayload({
    ...requestIdentity,
    operation: "edit",
    project: "/srv/projects/demo",
    prompt: "replace the cloudy sky",
    sourcePaths: ["art/source.png", "art/reference.webp"],
    maskPath: "art/mask.png",
    maskMode: "strict",
    maskFeather: 32,
    destination: "generated-images/sky",
    size: "1024x1024",
    quality: "high",
    outputFormat: "webp",
    outputCompression: 82,
    background: "opaque",
    moderation: "low",
    inputFidelity: "high",
    n: 2,
    stream: true,
    partialImages: 2,
  }, capabilities);
  assert.deepEqual(payload, {
    ...requestIdentity,
    operation: "edit",
    project: "/srv/projects/demo",
    prompt: "replace the cloudy sky",
    size: "1024x1024",
    quality: "high",
    outputFormat: "webp",
    outputCompression: 82,
    background: "opaque",
    moderation: "low",
    n: 2,
    stream: true,
    partialImages: 2,
    sourcePaths: ["art/source.png", "art/reference.webp"],
    maskPath: "art/mask.png",
    maskMode: "strict",
    maskFeather: 32,
    destination: "generated-images/sky",
  });
  assert.equal(Object.hasOwn(payload, "inputFidelity"), false);
  assert.equal(Object.hasOwn(payload, "overwrite"), false);
});

test("outpaint sends four sides and deliberately omits size", () => {
  const payload = buildImageExecutePayload({
    ...requestIdentity,
    operation: "outpaint",
    project: "/srv/projects/demo",
    prompt: "continue the forest",
    sourcePaths: ["art/source.png"],
    size: "1024x1024",
    quality: "high",
    outputFormat: "png",
    outputCompression: 100,
    background: "opaque",
    moderation: "auto",
    inputFidelity: "high",
    n: 1,
    stream: false,
    outpaint: { top: 0, right: 512, bottom: 0, left: 256 },
    preserveSource: "seamless",
    blendMargin: 64,
    alignmentPolicy: "pad-and-crop",
  }, capabilities);
  assert.deepEqual(payload.outpaint, { top: 0, right: 512, bottom: 0, left: 256 });
  assert.equal(payload.preserveSource, "seamless");
  assert.equal(payload.blendMargin, 64);
  assert.equal(payload.alignmentPolicy, "pad-and-crop");
  assert.equal(Object.hasOwn(payload, "size"), false);
  assert.equal(Object.hasOwn(payload, "outputCompression"), false);
  assert.equal(Object.hasOwn(payload, "inputFidelity"), false);
});

test("operation-specific fixed sizes reject unsupported edit sizes without fallback", () => {
  assert.throws(() => buildImageExecutePayload({
    ...requestIdentity,
    operation: "edit",
    project: "/srv/projects/demo",
    prompt: "repaint the sky",
    sourcePaths: ["art/source.png"],
    size: "2048x2048",
    quality: "high",
    outputFormat: "png",
    background: "opaque",
    moderation: "auto",
    n: 1,
    stream: false,
  }, capabilities), /edit 操作不支持/);
});

test("invalid paths and numeric settings fail instead of being silently replaced", () => {
  for (const path of ["/etc/passwd", "../secret.png", "art/../secret.png", "art\\secret.png", "art//source.png"]) {
    assert.throws(() => assertProjectRelativePath(path), /相对路径/);
  }
  assert.throws(() => buildImageExecutePayload({
    ...requestIdentity,
    operation: "generate",
    project: "/srv/projects/demo",
    prompt: "forest",
    size: "1024x1024",
    quality: "high",
    outputFormat: "webp",
    outputCompression: 140,
    background: "opaque",
    moderation: "auto",
    n: 1,
    stream: false,
  }, capabilities), /输出压缩质量/);
  assert.throws(() => buildImageExecutePayload({
    ...requestIdentity,
    operation: "generate",
    project: "/srv/projects/demo",
    prompt: "x".repeat(32_001),
    size: "1024x1024",
    quality: "high",
    outputFormat: "png",
    background: "opaque",
    moderation: "auto",
    n: 1,
    stream: false,
  }, capabilities), /不能超过 32000/);
  assert.throws(() => buildImageExecutePayload({
    ...requestIdentity,
    operation: "outpaint",
    project: "/srv/projects/demo",
    prompt: "continue the forest",
    sourcePaths: ["art/source.png", "art/reference.png"],
    outputFormat: "png",
    quality: "high",
    background: "opaque",
    moderation: "auto",
    n: 1,
    stream: false,
    outpaint: { top: 0, right: 16, bottom: 0, left: 0 },
  }, capabilities), /只能使用一张/);
  assert.throws(() => buildImageExecutePayload({
    ...requestIdentity,
    windowId: "shared-window",
    operation: "generate",
    project: "/srv/projects/demo",
    prompt: "forest",
    size: "1024x1024",
    quality: "high",
    outputFormat: "png",
    background: "opaque",
    moderation: "auto",
    n: 1,
    stream: false,
  }, capabilities), /窗口标识无效/);
});

test("result byte labels use inspected byte counts", () => {
  assert.equal(formatImageBytes(900), "900 B");
  assert.equal(formatImageBytes(1536), "1.5 KiB");
  assert.equal(formatImageBytes(2 * 1024 * 1024), "2.0 MiB");
});

test("stream parser accepts named partial and completed SSE events", async () => {
  const response = new Response([
    "event: partial\r\n",
    "data: {\"index\":0,\"dataUrl\":\"data:image/png;base64,AA==\"}\r\n\r\n",
    "event: completed\r\n",
    "data: {\"outputs\":[{\"path\":\"/srv/demo/result.png\"}]}\r\n\r\n",
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  const events = [];
  const result = await readImageEventStream(response, (event) => {
    events.push(event);
    return event.type === "completed" ? event : null;
  });
  assert.deepEqual(events.map((event) => event.type), ["partial", "completed"]);
  assert.equal(result.outputs[0].path, "/srv/demo/result.png");
});
