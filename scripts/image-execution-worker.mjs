import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { planImageProviderCanvas } from "../lib/image-canvas-plan.mjs";
import { validateImageFile } from "../lib/image-file.mjs";
import {
  prepareOutpaint,
  restoreMaskedEditSource,
  restoreOutpaintProviderCanvas,
  restoreOutpaintSource,
  transformOutpaintInputs,
} from "../lib/image-outpaint.mjs";
import { requestProviderImages, requestProviderImagesStream } from "../lib/openai-image.mjs";
import { normalizeImageProviderParameters } from "../lib/image-provider-parameters.mjs";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_CONTROL_LINE_BYTES = 64 * 1024;
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const OPERATIONS = new Set(["generate", "edit", "outpaint"]);
const COMPATIBILITY_PROBES = new Set([
  "generate-standard",
  "edit-standard",
  "edit-mask",
  "outpaint-standard",
  "outpaint-custom",
]);

let requestId = null;
let privateApi = null;
try {
  const envelope = await readRequest();
  requestId = envelope.id;
  const task = await normalizeTask(envelope);
  privateApi = task.imageApi;
  await emitMessage({ protocolVersion: 1, id: requestId, type: "started" });
  const result = await (task.kind === "compatibility-probe" ? executeCompatibilityProbe : executeTask)(task, (event) => emitMessage({
    protocolVersion: 1,
    id: requestId,
    ...event,
  }));
  await emitMessage({
    protocolVersion: 1,
    id: requestId,
    type: "completed",
    result,
  });
} catch (error) {
  if (requestId) {
    await emitMessage({
      protocolVersion: 1,
      id: requestId,
      type: "error",
      error: publicError(error),
    }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (privateApi) privateApi.apiKey = "";
}

async function executeTask(task, emit) {
  await emit({ type: "phase", phase: "preparing" });
  const providerRequest = task.request.providerRequest || {};
  const loaded = await loadInputs(task);
  let providerSources = loaded.sources.map(providerFile);
  let providerMask = loaded.mask ? providerFile(loaded.mask) : null;
  let outpaint = null;
  let providerSize = task.request.size;
  if (task.request.operation === "outpaint") {
    const source = loaded.sources[0];
    const expansion = task.request.outpaint;
    const canvas = {
      width: source.orientedWidth + expansion.left + expansion.right,
      height: source.orientedHeight + expansion.top + expansion.bottom,
    };
    try {
      const canvasPlan = planImageProviderCanvas({
        requested: canvas,
        capability: task.imageApi.operationCapabilities.outpaint,
        limits: task.imageApi.size,
        alignmentPolicy: task.request.alignmentPolicy,
      });
      const prepared = await prepareOutpaint({
        sourceBuffer: source.data,
        canvas,
        placement: { x: expansion.left, y: expansion.top },
        blendMargin: task.request.blendMargin,
      });
      const transformed = await transformOutpaintInputs({
        canvasBuffer: prepared.canvasBuffer,
        maskBuffer: prepared.maskBuffer,
        plan: canvasPlan,
      });
      outpaint = { ...prepared, ...transformed, canvasPlan };
    } catch (error) {
      if (error?.code === "IMAGE_PROVIDER_SIZE_UNSUPPORTED") {
        error.operation = "outpaint";
        error.model = task.imageApi.model;
        error.sourceSize = `${source.orientedWidth}x${source.orientedHeight}`;
        throw error;
      }
      throw workerError(400, "INVALID_OUTPAINT", "扩图画布或源图片无效", error, {
        stage: "local_prepare",
        operation: "outpaint",
        sourceSize: `${source.orientedWidth}x${source.orientedHeight}`,
        requestedSize: `${canvas.width}x${canvas.height}`,
      });
    }
    providerSources = [{
      data: outpaint.canvasBuffer,
      filename: "outpaint-canvas.png",
      mediaType: "image/png",
    }];
    providerMask = {
      data: outpaint.maskBuffer,
      filename: "outpaint-mask.png",
      mediaType: "image/png",
    };
    providerSize = `${outpaint.canvasPlan.provider.width}x${outpaint.canvasPlan.provider.height}`;
  }

  const providerOptions = {
    baseUrl: task.imageApi.baseUrl,
    apiKey: task.imageApi.apiKey,
    operation: task.request.operation,
    sources: providerSources,
    mask: providerMask,
    multipartImageField: task.imageApi.multipartImageField,
    model: task.imageApi.model,
    prompt: task.request.prompt,
    user: task.request.user,
    n: providerRequest.n,
    size: task.request.operation === "outpaint" ? providerSize : providerRequest.size,
    quality: providerRequest.quality,
    outputFormat: providerRequest.outputFormat,
    outputCompression: providerRequest.outputCompression,
    background: providerRequest.background,
    moderation: providerRequest.moderation,
    inputFidelity: providerRequest.inputFidelity,
    stream: providerRequest.stream,
    providerParameters: task.request.providerParameters,
    requestMode: task.request.requestMode,
    timeoutMs: task.imageApi.timeoutMs,
    maxInputBytesPerImage: task.imageApi.maxInputBytesPerImage,
    maxOutputBytesPerImage: task.imageApi.maxOutputBytesPerImage,
    maxResponseBytes: task.imageApi.maxResponseBytes,
  };

  await emit({ type: "phase", phase: "provider" });
  const finalFiles = [];
  let usage = null;
  let providerRequestId = null;
  let emittedUsage = false;
  const emitUsage = async (providerUsage, requestIdentifier) => {
    if (!providerUsage || emittedUsage) return;
    usage = providerUsage;
    providerRequestId = requestIdentifier || providerRequestId;
    emittedUsage = true;
    await emit({ type: "usage", usage: providerUsage, providerRequestId });
  };
  let executionStage = "provider";
  try {
    if (task.request.stream) {
      let partialSequence = 0;
      for await (const event of requestProviderImagesStream({
        ...providerOptions,
        partialImages: providerRequest.partialImages,
      })) {
        executionStage = "provider";
        providerRequestId = event.providerRequestId || providerRequestId;
        if (event.output) {
          executionStage = "postprocess";
          const prepared = await prepareOutput(
            event.output,
            task,
            loaded.sources[0],
            loaded.mask,
            outpaint,
            providerSize,
          );
          partialSequence += 1;
          const file = await writeOutputFile(
            task.outputDirectory,
            `partial-${String(partialSequence).padStart(2, "0")}.${extensionFor(prepared.format)}`,
            prepared,
          );
          await emit({
            type: "partial",
            index: event.partialImageIndex,
            file,
            providerRequestId: event.providerRequestId || null,
          });
          event.output.image = null;
          executionStage = "provider";
        }
        if (event.outputs) {
          await emitUsage(event.usage, event.providerRequestId);
          await emit({ type: "phase", phase: "postprocessing" });
          executionStage = "postprocess";
          for (const output of event.outputs) {
            const prepared = await prepareOutput(
              output,
              task,
              loaded.sources[0],
              loaded.mask,
              outpaint,
              providerSize,
            );
            const index = finalFiles.length + 1;
            finalFiles.push(await writeOutputFile(
              task.outputDirectory,
              `output-${String(index).padStart(2, "0")}.${extensionFor(prepared.format)}`,
              prepared,
            ));
            output.image = null;
          }
          executionStage = "provider";
        }
      }
    } else {
      const generated = await requestProviderImages(providerOptions);
      providerRequestId = generated.providerRequestId;
      await emitUsage(generated.usage, generated.providerRequestId);
      await emit({ type: "phase", phase: "postprocessing" });
      executionStage = "postprocess";
      for (const output of generated.outputs) {
        const prepared = await prepareOutput(
          output,
          task,
          loaded.sources[0],
          loaded.mask,
          outpaint,
          providerSize,
        );
        const index = finalFiles.length + 1;
        finalFiles.push(await writeOutputFile(
          task.outputDirectory,
          `output-${String(index).padStart(2, "0")}.${extensionFor(prepared.format)}`,
          prepared,
        ));
        output.image = null;
      }
    }
  } catch (error) {
    await emitUsage(error?.providerUsage, error?.providerRequestId);
    throw attachExecutionContext(error, task, loaded.sources[0], outpaint, providerSize, executionStage);
  }
  if (finalFiles.length !== task.request.n) {
    throw workerError(502, "IMAGE_OUTPUT_COUNT_MISMATCH", "图片供应商返回的图片数量与请求不符", null, {
      requestedCount: task.request.n,
      actualCount: finalFiles.length,
    });
  }
  await emit({ type: "phase", phase: "committing" });
  const requestedSize = outpaint
    ? `${outpaint.canvas.width}x${outpaint.canvas.height}`
    : task.request.size;
  return {
    files: finalFiles,
    usage,
    providerRequestId,
    requested: {
      operation: task.request.operation,
      model: task.imageApi.model,
      providerProfileRevision: task.imageApi.providerProfileRevision,
      configurationRevision: task.imageApi.configurationRevision,
      n: task.request.n,
      size: requestedSize,
      quality: task.request.quality,
      outputFormat: task.request.outputFormat,
      outputCompression: task.request.outputCompression,
      background: task.request.background,
      moderation: task.request.moderation,
      partialImages: task.request.partialImages,
      stream: task.request.stream,
      providerSize,
      sourceSize: loaded.sources[0]
        ? `${loaded.sources[0].orientedWidth}x${loaded.sources[0].orientedHeight}`
        : null,
      sourceConsumed: task.request.operation !== "generate",
      maskMode: task.request.maskMode,
      maskFeather: task.request.maskFeather,
      preserveSource: task.request.preserveSource,
      blendMargin: task.request.blendMargin,
      alignmentPolicy: task.request.alignmentPolicy,
      requestedCanvas: requestedSize,
      postprocess: outpaint?.canvasPlan?.postprocess || [],
    },
  };
}

async function executeCompatibilityProbe(task, emit) {
  await emit({ type: "phase", phase: "preparing" });
  const source = await probeFixture(1_024, 1_024, { r: 72, g: 96, b: 128, alpha: 1 });
  const mask = await probeMaskFixture(1_024, 1_024);
  const tests = [];
  const usage = [];
  for (const spec of task.probe.tests) {
    await emit({ type: "phase", phase: "provider" });
    const startedAt = Date.now();
    let providerResult = null;
    try {
      const inputs = await probeInputs(spec, source, mask);
      const options = {
        baseUrl: task.imageApi.baseUrl,
        apiKey: task.imageApi.apiKey,
        operation: spec.operation,
        sources: inputs.sources,
        mask: inputs.mask,
        multipartImageField: task.imageApi.multipartImageField,
        model: task.imageApi.model,
        prompt: `WFL compatibility probe: ${spec.id}`,
        user: task.probe.user,
        n: 1,
        size: spec.size,
        quality: task.probe.quality,
        outputFormat: "png",
        background: "opaque",
        moderation: "auto",
        timeoutMs: task.imageApi.timeoutMs,
        maxInputBytesPerImage: task.imageApi.maxInputBytesPerImage,
        maxOutputBytesPerImage: task.imageApi.maxOutputBytesPerImage,
        maxResponseBytes: task.imageApi.maxResponseBytes,
      };
      providerResult = await requestProviderImages(options);
      const providerUsage = providerResult.usage;
      if (providerUsage) {
        usage.push(providerUsage);
        await emit({
          type: "usage",
          usage: providerUsage,
          providerRequestId: providerResult.providerRequestId,
          operation: spec.operation,
          probeId: spec.id,
        });
      }
      const output = providerResult.outputs?.[0];
      if (!output?.image) throw workerError(502, "IMAGE_OUTPUT_COUNT_MISMATCH", "兼容性探测没有返回图片");
      const inspected = await validateImageFile(output.image, {
        allowedFormats: ["png"],
        maxBytes: task.imageApi.maxOutputBytesPerImage,
      });
      if (inspected.width !== spec.expectedWidth || inspected.height !== spec.expectedHeight) {
        throw workerError(502, "IMAGE_SIZE_MISMATCH", "兼容性探测返回尺寸与请求不符", null, {
          requestedWidth: spec.expectedWidth,
          requestedHeight: spec.expectedHeight,
          actualWidth: inspected.width,
          actualHeight: inspected.height,
        });
      }
      tests.push({
        id: spec.id,
        operation: spec.operation,
        requestedSize: spec.size,
        expectedSize: `${spec.expectedWidth}x${spec.expectedHeight}`,
        customSize: spec.customSize,
        mask: Boolean(inputs.mask),
        ok: true,
        durationMs: Math.max(0, Date.now() - startedAt),
        providerRequestId: providerResult.providerRequestId,
        usage: providerUsage,
      });
    } catch (error) {
      const providerUsage = error?.providerUsage;
      if (providerUsage) {
        usage.push(providerUsage);
        await emit({
          type: "usage",
          usage: providerUsage,
          providerRequestId: error?.providerRequestId,
          operation: spec.operation,
          probeId: spec.id,
        });
      }
      const diagnostic = publicError(error);
      tests.push({
        id: spec.id,
        operation: spec.operation,
        requestedSize: spec.size,
        expectedSize: `${spec.expectedWidth}x${spec.expectedHeight}`,
        customSize: spec.customSize,
        mask: spec.id === "edit-mask",
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        providerRequestId: diagnostic.providerRequestId || diagnostic.requestId || null,
        error: {
          code: diagnostic.code,
          message: diagnostic.message,
          reason: diagnostic.reason || null,
          providerStatusCode: diagnostic.providerStatusCode || null,
          retryable: diagnostic.retryable,
        },
        usage: providerUsage || null,
      });
    } finally {
      if (providerResult?.outputs) {
        for (const output of providerResult.outputs) output.image = null;
      }
    }
  }
  await emit({ type: "phase", phase: "postprocessing" });
  const report = buildCompatibilityProbeReport(task, tests, usage);
  await emit({ type: "phase", phase: "committing" });
  return {
    files: [],
    usage: sumProbeUsage(usage),
    providerRequestId: tests.find((entry) => entry.providerRequestId)?.providerRequestId || null,
    requested: {
      kind: "compatibility-probe",
      model: task.imageApi.model,
      probeReport: report,
    },
  };
}

function normalizeCompatibilityProbe(value, imageApi) {
  if (!isRecord(value) || !Array.isArray(value.tests) || value.tests.length < 1 || value.tests.length > 5) {
    throw workerError(400, "INVALID_IMAGE_COMPATIBILITY_PROBE", "兼容性探测项目无效");
  }
  const operations = new Set(imageApi.operations);
  const tests = [...new Set(value.tests.map(String))].map((id) => {
    if (!COMPATIBILITY_PROBES.has(id)) throw workerError(400, "INVALID_IMAGE_COMPATIBILITY_PROBE", "不支持的兼容性探测项目");
    if (id.startsWith("generate") && !operations.has("generate")) throw workerError(409, "IMAGE_OPERATION_UNAVAILABLE", "供应商未启用生成操作");
    if (id.startsWith("edit") && !operations.has("edit")) throw workerError(409, "IMAGE_OPERATION_UNAVAILABLE", "供应商未启用编辑操作");
    if (id === "edit-mask" && imageApi.mask !== true) throw workerError(409, "IMAGE_OPERATION_UNAVAILABLE", "供应商未启用蒙版能力");
    if (id.startsWith("outpaint") && !operations.has("outpaint")) throw workerError(409, "IMAGE_OPERATION_UNAVAILABLE", "供应商未启用扩图操作");
    return id;
  });
  return {
    tests: tests.map(probeSpec),
    quality: ["low", "medium", "high", "auto"].includes(value.quality) ? value.quality : "low",
    user: normalizeProviderUser(value.user),
  };
}

function probeSpec(id) {
  return {
    id,
    operation: id.startsWith("generate") ? "generate" : id.startsWith("edit") ? "edit" : "outpaint",
    size: id === "outpaint-custom" ? "1040x1024" : id.startsWith("outpaint") ? "1536x1024" : "1024x1024",
    expectedWidth: id === "outpaint-custom" ? 1_040 : id.startsWith("outpaint") ? 1_536 : 1_024,
    expectedHeight: 1_024,
    customSize: id === "outpaint-custom",
  };
}

async function probeInputs(spec, source, mask) {
  if (spec.operation === "generate") return { sources: [], mask: null };
  if (spec.id === "edit-mask") return {
    sources: [probeProviderFile(source, "probe-source.png")],
    mask: probeProviderFile(mask, "probe-mask.png"),
  };
  if (spec.operation === "edit") return { sources: [probeProviderFile(source, "probe-source.png")], mask: null };
  const canvasPixels = Buffer.alloc(spec.expectedWidth * spec.expectedHeight * 4, 0);
  const sourcePixels = Buffer.from(source.raw);
  for (let row = 0; row < 1_024; row += 1) {
    sourcePixels.copy(canvasPixels, row * spec.expectedWidth * 4, row * 1_024 * 4, (row + 1) * 1_024 * 4);
  }
  return {
    sources: [{
      data: await encodeProbeRgba(canvasPixels, spec.expectedWidth, spec.expectedHeight),
      filename: "probe-canvas.png",
      mediaType: "image/png",
    }],
    mask: {
      data: await encodeProbeMask(spec.expectedWidth, spec.expectedHeight, 1_024),
      filename: "probe-mask.png",
      mediaType: "image/png",
    },
  };
}

function probeProviderFile(record, filename) {
  return { data: record.data, filename, mediaType: "image/png" };
}

async function probeFixture(width, height, background) {
  const data = await sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
  const decoded = await sharp(data).ensureAlpha().raw().toBuffer();
  return { data, raw: decoded, width, height };
}

async function probeMaskFixture(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = Math.floor(height / 4); y < Math.floor(height * 3 / 4); y += 1) {
    for (let x = Math.floor(width / 4); x < Math.floor(width * 3 / 4); x += 1) pixels[(y * width + x) * 4 + 3] = 0;
  }
  return { data: await encodeProbeRgba(pixels, width, height), raw: pixels, width, height };
}

function encodeProbeRgba(pixels, width, height) {
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

function encodeProbeMask(width, height, sourceWidth) {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = sourceWidth; x < width; x += 1) pixels[(y * width + x) * 4 + 3] = 0;
  }
  return encodeProbeRgba(pixels, width, height);
}

function buildCompatibilityProbeReport(task, tests, usage) {
  const successful = new Set(tests.filter((entry) => entry.ok).map((entry) => entry.id));
  const recommendations = {
    mask: successful.has("edit-mask"),
    edit: successful.has("edit-standard"),
    outpaint: successful.has("outpaint-standard"),
    outpaintCustomSize: successful.has("outpaint-custom"),
    note: "这是管理员显式探测结果，只提供建议；不会自动修改供应商能力声明。",
  };
  return {
    kind: "wfl-image-compatibility-probe",
    generatedAt: new Date().toISOString(),
    model: task.imageApi.model,
    tests,
    recommendations,
    usage: sumProbeUsage(usage),
  };
}

function sumProbeUsage(values) {
  const keys = ["inputTokens", "inputTextTokens", "inputImageTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  if (!values.some((value) => value && typeof value === "object")) return null;
  return Object.fromEntries(keys.map((key) => [key, values.reduce((total, value) => total + (Number.isSafeInteger(value?.[key]) ? value[key] : 0), 0)]));
}

async function normalizeTask(envelope) {
  if (
    envelope?.protocolVersion !== 1
    || !/^[a-f0-9]{36}$/u.test(envelope?.id || "")
    || !isRecord(envelope?.payload)
  ) throw workerError(400, "INVALID_IMAGE_WORKER_REQUEST", "图片 Worker 请求无效");
  const taskDirectory = await secureDirectory(envelope.taskDirectory, null);
  if (path.basename(taskDirectory) !== envelope.id || taskDirectory === path.parse(taskDirectory).root) {
    throw workerError(400, "INVALID_IMAGE_TASK_DIRECTORY", "图片任务目录与任务编号不匹配");
  }
  const inputDirectory = await secureDirectory(envelope.inputDirectory, taskDirectory);
  const outputDirectory = await secureDirectory(envelope.outputDirectory, taskDirectory);
  if (
    inputDirectory !== path.join(taskDirectory, "input")
    || outputDirectory !== path.join(taskDirectory, "output")
  ) throw workerError(400, "INVALID_IMAGE_TASK_DIRECTORY", "图片输入或输出目录不是任务的固定子目录");
  const payload = envelope.payload;
  if (payload.kind === "compatibility-probe") {
    const imageApi = normalizeImageApi(payload.imageApi);
    return {
      kind: "compatibility-probe",
      taskDirectory,
      inputDirectory,
      outputDirectory,
      imageApi,
      probe: normalizeCompatibilityProbe(payload.probe, imageApi),
    };
  }
  const imageApi = normalizeImageApi(payload.imageApi);
  const request = normalizeRequest(payload.request, imageApi);
  const sources = normalizeSourceRecords(payload.sources, request.operation, inputDirectory);
  const mask = payload.mask == null ? null : normalizeSourceRecord(payload.mask, inputDirectory);
  if (request.operation === "generate" && (sources.length || mask)) {
    throw workerError(400, "INVALID_IMAGE_SOURCE", "生成操作不能包含源图片或蒙版");
  }
  if (request.operation !== "edit" && mask) {
    throw workerError(400, "INVALID_IMAGE_MASK", "只有编辑操作可以指定外部蒙版");
  }
  if (request.maskMode === "strict" && !mask) {
    throw workerError(400, "INVALID_IMAGE_MASK", "严格蒙版模式必须指定蒙版图片");
  }
  return { kind: "execute", taskDirectory, inputDirectory, outputDirectory, imageApi, request, sources, mask };
}

function normalizeImageApi(value) {
  if (!isRecord(value)) throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片供应商配置无效");
  const apiKey = boundedString(value.apiKey, 1, 16_384, "图片供应商密钥");
  const baseUrl = boundedString(value.baseUrl, 1, 4_096, "图片供应商地址");
  const model = boundedString(value.model, 1, 200, "图片模型");
  const limits = isRecord(value.limits) ? value.limits : value;
  const transport = isRecord(value.transport) ? value.transport : value;
  return {
    apiKey,
    baseUrl,
    model,
    requestMode: ["managed", "partial", "passthrough"].includes(value.requestMode)
      ? value.requestMode
      : "managed",
    providerProfileRevision: optionalRevision(value.providerProfileRevision),
    configurationRevision: optionalRevision(value.configurationRevision),
    multipartImageField: ["image", "image[]"].includes(transport.multipartImageField)
      ? transport.multipartImageField
      : "image[]",
    maxInputBytesPerImage: positiveInteger(limits.maxInputBytesPerImage, 20 * 1024 * 1024),
    maxInputBytesTotal: positiveInteger(limits.maxInputBytesTotal, 80 * 1024 * 1024),
    maxOutputBytesPerImage: positiveInteger(limits.maxOutputBytesPerImage, 20 * 1024 * 1024),
    maxResponseBytes: positiveInteger(limits.maxResponseBytes, 128 * 1024 * 1024),
    timeoutMs: positiveInteger(limits.timeoutMs, 10 * 60_000),
    inputFormats: normalizeFormats(value.capabilities?.inputFormats, ["png", "jpeg", "webp"]),
    fixedSizes: normalizeFixedSizes(limits.fixedSizes),
    size: normalizeSizeLimits(limits.size),
    operationCapabilities: normalizeOperationCapabilities(
      value.operationCapabilities,
      normalizeFixedSizes(limits.fixedSizes),
      normalizeSizeLimits(limits.size),
    ),
    operations: normalizeProviderOperations(value.capabilities?.operations),
    mask: value.capabilities?.mask === true,
  };
}

function normalizeRequest(value, imageApi) {
  if (!isRecord(value)) throw workerError(400, "INVALID_IMAGE_REQUEST", "图片请求无效");
  const operation = String(value.operation || "");
  if (!OPERATIONS.has(operation)) throw workerError(400, "INVALID_IMAGE_OPERATION", "不支持的图片操作");
  const outputFormat = String(value.outputFormat || "");
  if (!OUTPUT_FORMATS.has(outputFormat)) throw workerError(400, "INVALID_IMAGE_FORMAT", "图片输出格式无效");
  const n = boundedInteger(value.n, 1, imageApi.requestMode === "passthrough" ? 100 : 10, "图片输出数量");
  const stream = value.stream === true;
  const size = operation === "outpaint" ? null : normalizeSize(value.size);
  if (operation !== "outpaint" && imageApi.requestMode === "managed") {
    assertOperationSizeSupported(size, operation, imageApi);
  }
  const maskMode = operation === "edit"
    ? enumValue(value.maskMode ?? "soft", ["strict", "soft"], "蒙版模式")
    : null;
  const request = {
    operation,
    requestMode: imageApi.requestMode,
    prompt: boundedString(value.prompt, 1, 32_000, "图片描述"),
    user: normalizeProviderUser(value.user),
    n,
    size,
    quality: optionalString(value.quality, 100),
    outputFormat,
    outputCompression: boundedInteger(value.outputCompression ?? 100, 0, 100, "图片压缩率"),
    background: optionalString(value.background, 100),
    moderation: optionalString(value.moderation, 100),
    inputFidelity: optionalString(value.inputFidelity, 100),
    stream,
    partialImages: stream ? boundedInteger(value.partialImages ?? 0, 0, 3, "局部预览数量") : 0,
    outpaint: operation === "outpaint" ? normalizeExpansion(value.outpaint) : null,
    maskMode,
    maskFeather: maskMode === "strict"
      ? boundedInteger(value.maskFeather ?? 0, 0, 128, "蒙版羽化像素")
      : 0,
    preserveSource: operation === "outpaint"
      ? enumValue(value.preserveSource ?? "exact", ["exact", "seamless"], "原图保留模式")
      : null,
    blendMargin: 0,
    alignmentPolicy: operation === "outpaint"
      ? enumValue(
        value.alignmentPolicy ?? "reject",
        ["reject", "pad-and-crop", "rescale-and-crop"],
        "扩图尺寸对齐策略",
      )
      : null,
    providerParameters: normalizeImageProviderParameters(value.providerParameters),
    providerRequest: isRecord(value.providerRequest)
      ? structuredClone(value.providerRequest)
      : {
          n,
          size,
          quality: optionalString(value.quality, 100),
          outputFormat,
          outputCompression: value.outputFormat === "png" ? undefined : boundedInteger(value.outputCompression ?? 100, 0, 100, "图片压缩率"),
          background: optionalString(value.background, 100),
          moderation: optionalString(value.moderation, 100),
          inputFidelity: optionalString(value.inputFidelity, 100),
          stream: stream ? true : undefined,
          partialImages: stream ? boundedInteger(value.partialImages ?? 0, 0, 3, "局部预览数量") : undefined,
        },
    outputFormatSpecified: value.outputFormatSpecified === true,
  };
  if (request.operation === "outpaint" && request.preserveSource === "seamless") {
    request.blendMargin = boundedInteger(value.blendMargin ?? 64, 1, 512, "无缝扩图过渡宽度");
  }
  if (imageApi.maxOutputBytesPerImage * n > Number.MAX_SAFE_INTEGER) {
    throw workerError(400, "INVALID_IMAGE_REQUEST", "图片输出预算无效");
  }
  return request;
}

function normalizeSourceRecords(value, operation, inputDirectory) {
  if (operation === "generate") return value == null ? [] : assertEmptyArray(value);
  if (!Array.isArray(value)) throw workerError(400, "INVALID_IMAGE_SOURCE", "图片源文件清单无效");
  const maximum = operation === "outpaint" ? 1 : 16;
  if (value.length < 1 || value.length > maximum) {
    throw workerError(400, "INVALID_IMAGE_SOURCE", "图片源文件数量无效");
  }
  return value.map((record) => normalizeSourceRecord(record, inputDirectory));
}

function normalizeSourceRecord(value, inputDirectory) {
  if (!isRecord(value)) throw workerError(400, "INVALID_IMAGE_SOURCE", "图片源文件记录无效");
  const filename = boundedString(value.filename || path.basename(value.path || ""), 1, 255, "图片源文件名");
  const sourcePath = absolutePath(value.path);
  if (!isPathInside(inputDirectory, sourcePath)) {
    throw workerError(403, "IMAGE_SOURCE_OUTSIDE_TASK", "图片源文件必须位于当前任务目录");
  }
  return {
    path: sourcePath,
    filename,
    mediaType: optionalString(value.mediaType, 100),
    size: optionalNonNegativeInteger(value.size),
    dev: optionalIdentity(value.dev),
    ino: optionalIdentity(value.ino),
  };
}

async function loadInputs(task) {
  let totalBytes = 0;
  const load = async (record, label) => {
    const opened = await readSecureFile(record, task.imageApi.maxInputBytesPerImage, label, task.inputDirectory);
    totalBytes += opened.data.length;
    if (totalBytes > task.imageApi.maxInputBytesTotal) {
      throw workerError(413, "IMAGE_INPUTS_TOO_LARGE", "输入图片总大小超过管理员设置的限制");
    }
    let inspected;
    let metadata;
    try {
      inspected = await validateImageFile(opened.data, {
        maxBytes: task.imageApi.maxInputBytesPerImage,
        allowedFormats: task.imageApi.inputFormats,
      });
      const pipeline = sharp(opened.data, {
        animated: true,
        failOn: "error",
        limitInputPixels: 64 * 1024 * 1024,
      });
      metadata = await pipeline.metadata();
    } catch (error) {
      throw workerError(415, "INVALID_IMAGE_SOURCE", `${label}不是可完整解码的受支持图片`, error);
    }
    if ((metadata.pages ?? 1) !== 1 || metadata.format !== inspected.format) {
      throw workerError(415, "INVALID_IMAGE_SOURCE", `${label}必须是格式一致的单帧图片`);
    }
    if (record.mediaType && record.mediaType !== inspected.mediaType) {
      throw workerError(415, "IMAGE_SOURCE_FORMAT_MISMATCH", `${label}的媒体类型不一致`);
    }
    return {
      ...record,
      data: opened.data,
      ...inspected,
      hasAlpha: metadata.hasAlpha === true,
      orientation: metadata.orientation || 1,
      orientedWidth: metadata.autoOrient?.width
        || ([5, 6, 7, 8].includes(metadata.orientation) ? inspected.height : inspected.width),
      orientedHeight: metadata.autoOrient?.height
        || ([5, 6, 7, 8].includes(metadata.orientation) ? inspected.width : inspected.height),
    };
  };
  const sources = [];
  for (const record of task.sources) sources.push(await load(record, "源图片"));
  const mask = task.mask ? await load(task.mask, "蒙版") : null;
  if (mask) {
    const first = sources[0];
    if (
      mask.format !== first.format
      || mask.width !== first.width
      || mask.height !== first.height
      || mask.hasAlpha !== true
    ) throw workerError(400, "INVALID_IMAGE_MASK", "蒙版必须与第一张源图格式和尺寸相同，并包含 alpha 通道");
  }
  return { sources, mask };
}

async function readSecureFile(record, maxBytes, label, inputDirectory) {
  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (process.platform === "linux" ? (fsConstants.O_NOFOLLOW || 0) : 0);
    handle = await fs.open(record.path, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) throw workerError(400, "INVALID_IMAGE_SOURCE", `${label}必须是普通文件`);
    const actualPath = process.platform === "linux"
      ? await fs.realpath(`/proc/self/fd/${handle.fd}`)
      : await fs.realpath(record.path);
    if (actualPath !== record.path || !isPathInside(inputDirectory, actualPath)) {
      throw workerError(403, "IMAGE_SOURCE_OUTSIDE_TASK", `${label}路径已被重定向`);
    }
    if (stat.size > maxBytes) throw workerError(413, "IMAGE_SOURCE_TOO_LARGE", `${label}超过单图大小限制`);
    if (record.size != null && stat.size !== record.size) throw changedSourceError(label);
    if (record.dev != null && String(stat.dev) !== record.dev) throw changedSourceError(label);
    if (record.ino != null && String(stat.ino) !== record.ino) throw changedSourceError(label);
    const data = await readBounded(handle, maxBytes);
    return { data, stat };
  } catch (error) {
    if (error?.code === "ELOOP") throw workerError(403, "IMAGE_SOURCE_SYMLINK", `${label}不能是符号链接`, error);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function prepareOutput(output, task, source, mask, outpaint, providerSize) {
  let data;
  const outputFormat = task.request.requestMode === "managed"
    ? task.request.outputFormat
    : output.format;
  try {
    if (outpaint) {
      const logicalResult = await restoreOutpaintProviderCanvas(output.image, outpaint.canvasPlan);
        data = await restoreOutpaintSource(logicalResult, source.data, outpaint.placement, {
          format: outputFormat,
          blendMargin: task.request.blendMargin,
          ...(outputFormat === "png"
            ? { compressionLevel: 9 }
            : { outputCompression: task.request.outputCompression }),
        });
    } else if (task.request.operation === "edit" && task.request.maskMode === "strict" && mask) {
      const restored = await restoreMaskedEditSource({
        resultBuffer: output.image,
        sourceBuffer: source.data,
        maskBuffer: mask.data,
        featherPixels: task.request.maskFeather,
        outputFormatOrOptions: {
          format: outputFormat,
          ...(outputFormat === "png"
            ? { compressionLevel: 9 }
            : { outputCompression: task.request.outputCompression }),
        },
      });
      data = restored.buffer;
    } else {
      data = output.image;
    }
  } catch (error) {
    if (error?.reason === "OUTPUT_ENCODING_FAILED") {
      throw workerError(502, "IMAGE_OUTPUT_ENCODING_FAILED", "扩图结果无法按请求的压缩率编码", error, {
        outputFormat: error.outputFormat,
        outputCompression: error.outputCompression,
      });
    }
    throw workerError(502, "INVALID_IMAGE_OUTPUT", "图片结果无法完成请求的确定性后处理", error, {
      stage: "postprocess",
      operation: task.request.operation,
      maskMode: task.request.maskMode,
      preserveSource: task.request.preserveSource,
    });
  }
  let inspected;
  try {
    inspected = await validateImageFile(data, {
      allowedFormats: task.request.requestMode === "managed" ? [task.request.outputFormat] : [...OUTPUT_FORMATS],
      maxBytes: task.imageApi.maxOutputBytesPerImage,
    });
    const metadata = await sharp(data, {
      animated: true,
      failOn: "error",
      limitInputPixels: 64 * 1024 * 1024,
    }).metadata();
    if ((metadata.pages ?? 1) !== 1 || metadata.format !== inspected.format) throw new Error("format mismatch");
  } catch (error) {
    throw workerError(502, "INVALID_IMAGE_OUTPUT", "图片供应商返回了无法完整解码的图片", error);
  }
  return { data, ...inspected, revisedPrompt: optionalString(output.revisedPrompt, 4_000) };
}

function attachExecutionContext(error, task, source, outpaint, providerSize, stage) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return error;
  if (!error.stage) error.stage = stage === "postprocess" ? "postprocess" : "provider";
  if (!error.operation) error.operation = task.request.operation;
  if (!error.model) error.model = task.imageApi.model;
  if (!error.requestedSize) {
    error.requestedSize = outpaint
      ? `${outpaint.canvas.width}x${outpaint.canvas.height}`
      : task.request.size;
  }
  if (!error.providerSize) error.providerSize = providerSize;
  if (!error.sourceSize && source) error.sourceSize = `${source.orientedWidth}x${source.orientedHeight}`;
  if (!error.reason) {
    if (error.stage !== "provider") error.reason = "local_postprocess_failed";
    else if (/moderation/iu.test(String(error.code || ""))) error.reason = "provider_moderation_blocked";
    else if ([
      "IMAGE_SIZE_MISMATCH",
      "IMAGE_OUTPUT_FORMAT_MISMATCH",
      "IMAGE_OUTPUT_COUNT_MISMATCH",
      "INVALID_IMAGE_OUTPUT",
    ].includes(error.code)) error.reason = "provider_output_mismatch";
    else if (error.providerStatusCode >= 500 || error.retryable === true) error.reason = "provider_transient";
    else if (error.code === "IMAGE_OPERATION_UNAVAILABLE") error.reason = "provider_operation_unsupported";
    else error.reason = "provider_invalid_parameter";
  }
  return error;
}

async function writeOutputFile(outputDirectory, filename, output) {
  const destination = path.join(outputDirectory, filename);
  const handle = await fs.open(destination, "wx", 0o600);
  try {
    await handle.writeFile(output.data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    path: filename,
    size: output.size,
    sha256: crypto.createHash("sha256").update(output.data).digest("hex"),
    width: output.width,
    height: output.height,
    format: output.format,
    mediaType: output.mediaType,
    revisedPrompt: output.revisedPrompt,
  };
}

function providerFile(record) {
  return { data: record.data, filename: record.filename, mediaType: record.mediaType };
}

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw workerError(413, "IMAGE_WORKER_REQUEST_TOO_LARGE", "图片 Worker 请求超过 IPC 上限");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks, total).toString("utf8");
  if (!raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1) {
    throw workerError(400, "INVALID_IMAGE_WORKER_REQUEST", "图片 Worker 必须接收一条 JSON 请求");
  }
  try {
    return JSON.parse(raw.slice(0, -1));
  } catch (error) {
    throw workerError(400, "INVALID_IMAGE_WORKER_REQUEST", "图片 Worker 请求不是有效 JSON", error);
  }
}

async function emitMessage(value) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_CONTROL_LINE_BYTES) {
    throw workerError(500, "IMAGE_WORKER_CONTROL_LIMIT", "图片 Worker 控制消息超过上限");
  }
  if (!process.stdout.write(encoded)) await once(process.stdout, "drain");
}

async function secureDirectory(value, parent) {
  const resolved = absolutePath(value);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw workerError(400, "INVALID_IMAGE_TASK_DIRECTORY", "图片任务目录无效");
  const real = await fs.realpath(resolved);
  if (parent && !isPathInside(parent, real)) throw workerError(400, "INVALID_IMAGE_TASK_DIRECTORY", "图片输出目录越界");
  return real;
}

async function readBounded(handle, maximum) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maximum - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > maximum) throw workerError(413, "IMAGE_SOURCE_TOO_LARGE", "图片源文件超过大小限制");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function normalizeSize(value) {
  const size = String(value || "");
  if (size === "auto" || /^(?:[1-9]\d{0,3})x(?:[1-9]\d{0,3})$/u.test(size)) return size;
  throw workerError(400, "INVALID_IMAGE_SIZE", "图片尺寸无效");
}

function normalizeExpansion(value) {
  if (!isRecord(value)) throw workerError(400, "INVALID_OUTPAINT_EXPANSION", "扩图边距无效");
  const result = {};
  let total = 0;
  for (const side of ["top", "right", "bottom", "left"]) {
    result[side] = boundedInteger(value[side] ?? 0, 0, 3_840, "扩图边距");
    total += result[side];
  }
  if (!total) throw workerError(400, "INVALID_OUTPAINT_EXPANSION", "扩图至少需要扩展一侧");
  return result;
}

function enumValue(value, allowed, label) {
  const normalized = String(value || "");
  if (!allowed.includes(normalized)) {
    throw workerError(400, "INVALID_IMAGE_REQUEST", `${label}无效`);
  }
  return normalized;
}

function normalizeFormats(value, fallback) {
  if (!Array.isArray(value) || !value.length) return fallback;
  const formats = [...new Set(value.map(String))];
  if (formats.some((format) => !OUTPUT_FORMATS.has(format))) {
    throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片输入格式配置无效");
  }
  return formats;
}

function normalizeProviderOperations(value) {
  if (!Array.isArray(value) || !value.length) {
    throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片供应商操作能力配置无效");
  }
  const operations = [...new Set(value.map(String))];
  if (operations.some((operation) => !OPERATIONS.has(operation))) {
    throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片供应商操作能力配置无效");
  }
  return operations;
}

function normalizeFixedSizes(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !/^\d{1,5}x\d{1,5}$/u.test(entry))) {
    throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片固定尺寸配置无效");
  }
  return [...new Set(value)];
}

function normalizeOperationCapabilities(value, fixedSizes, sizeLimits) {
  const source = isRecord(value) ? value : {};
  const fallback = {
    customSize: fixedSizes.length === 0 && Boolean(sizeLimits),
    sizes: fixedSizes,
  };
  return Object.fromEntries([...OPERATIONS].map((operation) => {
    const entry = isRecord(source[operation]) ? source[operation] : fallback;
    const sizes = normalizeFixedSizes(entry.sizes ?? fallback.sizes);
    const customSize = entry.customSize === true;
    if (!customSize && !sizes.length) {
      throw workerError(400, "INVALID_IMAGE_PROVIDER", `${operation} 图片操作没有可用尺寸`);
    }
    return [operation, { customSize, sizes }];
  }));
}

function assertOperationSizeSupported(size, operation, imageApi) {
  const capability = imageApi.operationCapabilities[operation];
  if (capability.sizes.includes(size)) return;
  if (capability.customSize !== true) {
    throw workerError(400, "IMAGE_PROVIDER_SIZE_UNSUPPORTED", `当前供应商的 ${operation} 操作不支持尺寸 ${size}`, null, {
      stage: "local_prepare",
      operation,
      requestedSize: size,
      supportedSizes: capability.sizes,
      customSize: capability.customSize === true,
      reason: "provider_size_unsupported",
    });
  }
  if (size === "auto") {
    if (!imageApi.size?.allowAuto) throw workerError(400, "INVALID_IMAGE_SIZE", "当前图片预设不支持自动尺寸");
    return;
  }
  const [width, height] = size.split("x").map(Number);
  assertDimensionsWithinLimits(width, height, imageApi.size, false);
}

function normalizeSizeLimits(value) {
  if (value == null) return null;
  if (!isRecord(value)) throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片尺寸限制无效");
  const limits = {
    allowAuto: value.allowAuto === true,
    maxWidth: boundedInteger(value.maxWidth, 1, 100_000, "最大图片宽度"),
    maxHeight: boundedInteger(value.maxHeight, 1, 100_000, "最大图片高度"),
    dimensionMultiple: boundedInteger(value.dimensionMultiple, 1, 10_000, "图片边长倍数"),
    maxAspectRatio: Number(value.maxAspectRatio),
    minPixels: boundedInteger(value.minPixels, 1, Number.MAX_SAFE_INTEGER, "最小图片像素"),
    maxPixels: boundedInteger(value.maxPixels, 1, Number.MAX_SAFE_INTEGER, "最大图片像素"),
  };
  if (!Number.isFinite(limits.maxAspectRatio) || limits.maxAspectRatio < 1 || limits.maxAspectRatio > 100) {
    throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片最大宽高比无效");
  }
  if (limits.minPixels > limits.maxPixels) throw workerError(400, "INVALID_IMAGE_PROVIDER", "图片像素限制无效");
  return limits;
}

function assertDimensionsWithinLimits(width, height, limits, providerOutput) {
  const pixels = width * height;
  if (
    !limits
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > limits.maxWidth
    || height > limits.maxHeight
    || width % limits.dimensionMultiple !== 0
    || height % limits.dimensionMultiple !== 0
    || Math.max(width / height, height / width) > limits.maxAspectRatio
    || !Number.isSafeInteger(pixels)
    || pixels < limits.minPixels
    || pixels > limits.maxPixels
  ) throw workerError(
    providerOutput ? 502 : 400,
    providerOutput ? "IMAGE_SIZE_MISMATCH" : "INVALID_IMAGE_SIZE",
    providerOutput
      ? "图片供应商返回的图片尺寸不符合冻结的管理员限制"
      : "图片尺寸不符合冻结的管理员限制",
    null,
    providerOutput ? { actualWidth: width, actualHeight: height } : null,
  );
  return { width, height };
}

function publicError(error) {
  const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 502;
  const code = safeIdentifier(error?.code, 100) || "IMAGE_WORKER_FAILED";
  const result = {
    statusCode,
    code,
    message: optionalString(error?.message, 1_000) || "图片 Worker 执行失败",
    retryable: error?.retryable === true,
    providerRequestId: safeIdentifier(error?.providerRequestId ?? error?.requestId, 200),
    requestId: safeIdentifier(error?.requestId ?? error?.providerRequestId, 200),
  };
  const type = safeIdentifier(error?.type, 200);
  if (type) result.type = type;
  for (const field of ["stage", "operation", "reason"]) {
    const value = safeIdentifier(error?.[field], 100);
    if (value) result[field] = value;
  }
  const model = optionalString(error?.model, 200);
  if (model && !/[\u0000-\u001f\u007f]/u.test(model)) result.model = model;
  for (const field of ["requestedSize", "providerSize", "sourceSize"]) {
    const value = optionalString(error?.[field], 32);
    if (value && /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value)) result[field] = value;
  }
  if (["strict", "soft"].includes(error?.maskMode)) result.maskMode = error.maskMode;
  if (["exact", "seamless"].includes(error?.preserveSource)) result.preserveSource = error.preserveSource;
  if (["reject", "pad-and-crop", "rescale-and-crop"].includes(error?.alignmentPolicy)) {
    result.alignmentPolicy = error.alignmentPolicy;
  }
  if (typeof error?.customSize === "boolean") result.customSize = error.customSize;
  if (Array.isArray(error?.supportedSizes)) {
    result.supportedSizes = [...new Set(error.supportedSizes
      .map((value) => optionalString(value, 32))
      .filter((value) => /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value || "")))]
      .slice(0, 64);
  }
  for (const field of ["requestedFormat", "actualFormat", "outputFormat"]) {
    if (OUTPUT_FORMATS.has(error?.[field])) result[field] = error[field];
  }
  if (Number.isSafeInteger(error?.providerStatusCode) && error.providerStatusCode >= 400 && error.providerStatusCode <= 599) {
    result.providerStatusCode = error.providerStatusCode;
  }
  for (const field of ["requestedWidth", "requestedHeight", "actualWidth", "actualHeight"]) {
    if (Number.isSafeInteger(error?.[field]) && error[field] >= 1 && error[field] <= 100_000) {
      result[field] = error[field];
    }
  }
  for (const field of ["requestedCount", "actualCount"]) {
    if (Number.isSafeInteger(error?.[field]) && error[field] >= 0 && error[field] <= 10_000) {
      result[field] = error[field];
    }
  }
  if (Number.isSafeInteger(error?.outputCompression) && error.outputCompression >= 0 && error.outputCompression <= 100) {
    result.outputCompression = error.outputCompression;
  }
  if (error?.moderationDetails && typeof error.moderationDetails === "object") {
    result.moderationDetails = sanitizeStructuredDetails(error.moderationDetails);
  }
  return result;
}

function changedSourceError(label) {
  return workerError(409, "IMAGE_SOURCE_CHANGED", `${label}在排队后发生变化`);
}

function workerError(statusCode, code, message, cause = null, details = null) {
  return Object.assign(
    new Error(message, cause ? { cause } : undefined),
    { statusCode, code, retryable: false },
    details || {},
  );
}

function absolutePath(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 4_096 || !path.isAbsolute(text) || /[\u0000\r\n]/u.test(text)) {
    throw workerError(400, "INVALID_IMAGE_PATH", "图片 Worker 文件路径无效");
  }
  return path.resolve(text);
}

function boundedString(value, minimum, maximum, label) {
  const text = typeof value === "string" ? value : "";
  if (text.trim().length < minimum || text.length > maximum) {
    throw workerError(400, "INVALID_IMAGE_WORKER_REQUEST", `${label}无效`);
  }
  return text;
}

function optionalString(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maximum) : null;
}

function optionalRevision(value) {
  const text = optionalString(value, 64);
  return text && /^[a-f0-9]{32,64}$/u.test(text) ? text : null;
}

function normalizeProviderUser(value) {
  if (value == null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || !/^[\x20-\x7e]+$/u.test(value)
  ) throw workerError(400, "INVALID_IMAGE_USER", "图片供应商用户标识无效");
  return value;
}

function safeIdentifier(value, maximum) {
  const text = optionalString(value, maximum);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}

function sanitizeStructuredDetails(value, depth = 0) {
  if (depth > 4) return null;
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => sanitizeStructuredDetails(entry, depth + 1));
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(key) || /(?:key|token|secret|authorization|prompt|url)/iu.test(key)) continue;
    result[key] = sanitizeStructuredDetails(entry, depth + 1);
  }
  return result;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw workerError(400, "INVALID_IMAGE_WORKER_REQUEST", `${label}无效`);
  }
  return value;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function optionalNonNegativeInteger(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw workerError(400, "INVALID_IMAGE_SOURCE", "图片源文件大小无效");
  return value;
}

function optionalIdentity(value) {
  if (value == null) return null;
  const text = String(value);
  if (!/^\d{1,30}$/u.test(text)) throw workerError(400, "INVALID_IMAGE_SOURCE", "图片源文件身份无效");
  return text;
}

function assertEmptyArray(value) {
  if (!Array.isArray(value) || value.length) throw workerError(400, "INVALID_IMAGE_SOURCE", "生成操作不能包含源图片");
  return [];
}

function extensionFor(format) {
  return format === "jpeg" ? "jpg" : format;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
