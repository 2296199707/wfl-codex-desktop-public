import { inspectImageBuffer } from "./image-file.mjs";
import { normalizeImageProviderParameters } from "./image-provider-parameters.mjs";

const DEFAULT_RESPONSE_LIMIT_BYTES = 128 * 1024 * 1024;
const DEFAULT_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const OPERATIONS = new Set(["generate", "edit", "outpaint"]);
const MULTIPART_IMAGE_FIELDS = new Set(["image", "image[]"]);
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const SAFE_MODERATION_ENUMS = new Set([
  "allowed", "blocked", "critical", "harassment", "harassment/threatening", "hate", "hate/threatening",
  "high", "illicit", "illicit/violent", "low", "medium", "safe", "self-harm", "self-harm/instructions",
  "self-harm/intent", "sexual", "sexual/minors", "unsafe", "very_high", "very_low", "violence",
  "violence/graphic",
]);

export async function generateProviderImage(options) {
  const result = await requestProviderImages({ ...options, operation: "generate", n: options?.n ?? 1 });
  const output = result.outputs[0];
  if (output.format !== "png") {
    throw imageError(502, "图片供应商返回的图片格式与请求不符", "IMAGE_FORMAT_MISMATCH");
  }
  return {
    image: output.image,
    revisedPrompt: output.revisedPrompt,
    usage: result.usage,
  };
}

export async function requestProviderImages(options = {}) {
  const config = normalizeProviderOptions(options, false);
  const abort = createAbortContext(config.timeoutMs, config.signal);

  try {
    assertRequestActive(abort);
    const request = config.operation === "generate"
      ? generationRequest(config.apiKey, config.requested, config.providerParameters, abort.controller.signal)
      : editRequest({
        apiKey: config.apiKey,
        requested: config.requested,
        sources: config.sources,
        mask: config.mask,
        multipartImageField: config.multipartImageField,
        maxInputBytesPerImage: config.maxInputBytesPerImage,
        providerParameters: config.providerParameters,
        signal: abort.controller.signal,
      });
    const response = await config.fetchImpl(config.endpoint, request);
    assertRequestActive(abort);
    const providerRequestId = safeRequestId(response.headers?.get?.("x-request-id"), config.apiKey);
    abort.providerRequestId = providerRequestId;
    const raw = await readBoundedBody(response, config.maxResponseBytes);
    const payload = parsePayload(raw);
    if (!response.ok) throw imageApiError(response.status, payload, providerRequestId, config.apiKey);

    const usage = normalizeUsage(payload.usage);
    let outputs;
    try {
      const entries = Array.isArray(payload?.data) ? payload.data : [];
      if (!entries.length) throw imageError(502, "图片供应商没有返回可保存的图片", "IMAGE_OUTPUT_MISSING");
      outputs = entries.map((entry) => normalizeOutput(entry, config));
    } catch (error) {
      throw attachProviderAccounting(error, usage, providerRequestId);
    }
    return {
      outputs,
      requested: config.requested,
      usage,
      providerRequestId,
    };
  } catch (error) {
    throw normalizedRequestError(error, abort);
  } finally {
    abort.cleanup();
  }
}

export async function* requestProviderImagesStream(options = {}) {
  const config = normalizeProviderOptions(options, true);
  const abort = createAbortContext(config.timeoutMs, config.signal);
  let sawCompleted = false;

  try {
    assertRequestActive(abort);
    const request = config.operation === "generate"
      ? generationRequest(config.apiKey, config.requested, config.providerParameters, abort.controller.signal)
      : editRequest({
        apiKey: config.apiKey,
        requested: config.requested,
        sources: config.sources,
        mask: config.mask,
        multipartImageField: config.multipartImageField,
        maxInputBytesPerImage: config.maxInputBytesPerImage,
        providerParameters: config.providerParameters,
        signal: abort.controller.signal,
      });
    const response = await config.fetchImpl(config.endpoint, request);
    assertRequestActive(abort);
    const providerRequestId = safeRequestId(response.headers?.get?.("x-request-id"), config.apiKey);
    abort.providerRequestId = providerRequestId;
    if (!response.ok) {
      const raw = await readBoundedBody(response, config.maxResponseBytes);
      throw imageApiError(response.status, parsePayload(raw), providerRequestId, config.apiKey);
    }
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.startsWith("text/event-stream")) {
      throw imageError(502, "图片供应商没有返回事件流", "INVALID_IMAGE_PROVIDER_STREAM");
    }

    const prefix = config.operation === "generate" ? "image_generation" : "image_edit";
    for await (const event of parseSseEvents(response.body, config.maxResponseBytes)) {
      assertRequestActive(abort);
      if (event.done) break;
      const payload = event.payload;
      if (payload.type != null && typeof payload.type !== "string") {
        throw imageError(502, "图片供应商事件类型无效", "INVALID_IMAGE_PROVIDER_STREAM");
      }
      const eventType = typeof payload?.type === "string" ? payload.type : event.eventType;
      if (event.eventType && payload?.type && event.eventType !== payload.type) {
        throw imageError(502, "图片供应商事件类型不一致", "INVALID_IMAGE_PROVIDER_STREAM");
      }
      if (eventType === "error") throw imageStreamError(payload, providerRequestId, config.apiKey);
      if (eventType === `${prefix}.partial_image`) {
        const partialImageIndex = optionalSafeInteger(payload.partial_image_index, "局部图片序号");
        yield {
          type: eventType,
          operation: config.operation,
          partialImageIndex,
          output: normalizeOutput(payload, config),
          requested: config.requested,
          usage: null,
          providerRequestId,
        };
        continue;
      }
      if (eventType === `${prefix}.completed`) {
        const usage = normalizeUsage(payload.usage);
        let outputs;
        try {
          const entries = streamOutputEntries(payload);
          if (!entries.length) {
            throw imageError(502, "图片供应商完成事件没有图片", "IMAGE_OUTPUT_MISSING");
          }
          outputs = entries.map((entry) => normalizeOutput(entry, config));
        } catch (error) {
          throw attachProviderAccounting(error, usage, providerRequestId);
        }
        sawCompleted = true;
        yield {
          type: eventType,
          operation: config.operation,
          outputs,
          requested: config.requested,
          usage,
          providerRequestId,
        };
        continue;
      }
      throw imageError(502, "图片供应商返回了未知事件", "INVALID_IMAGE_PROVIDER_STREAM");
    }
    if (!sawCompleted) throw imageError(502, "图片供应商事件流未完成", "INCOMPLETE_IMAGE_PROVIDER_STREAM");
  } catch (error) {
    throw normalizedRequestError(error, abort);
  } finally {
    abort.cleanup(true);
  }
}

function normalizeProviderOptions(options, streaming) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw imageError(400, "图片供应商请求参数无效", "INVALID_IMAGE_REQUEST");
  }
  const operation = options.operation ?? "generate";
  if (!OPERATIONS.has(operation)) throw imageError(400, "不支持的图片操作", "INVALID_IMAGE_OPERATION");
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") throw imageError(500, "图片供应商请求器无效", "INVALID_IMAGE_CLIENT");
  const requestMode = ["managed", "partial", "passthrough"].includes(options.requestMode)
    ? options.requestMode
    : "managed";
  const enforceProviderOutput = requestMode === "managed" && options.enforceProviderOutput !== false;
  if (enforceProviderOutput) parseExpectedSize(options.size);
  const expectedFormat = enforceProviderOutput ? normalizeExpectedFormat(options.outputFormat) : null;
  if (enforceProviderOutput && options.background === "transparent" && expectedFormat === "jpeg") {
    throw imageError(400, "透明背景只支持 PNG 或 WebP 输出", "INVALID_IMAGE_BACKGROUND");
  }
  const user = normalizeUser(options.user);
  const partialImages = streaming ? normalizePartialImages(options.partialImages, requestMode) : null;
  const providerParameters = normalizeImageProviderParameters(options.providerParameters);
  const requested = compactObject({
    operation,
    model: options.model,
    prompt: options.prompt,
    user,
    n: options.n,
    size: options.size,
    quality: options.quality,
    outputFormat: enforceProviderOutput ? expectedFormat : options.outputFormat,
    outputCompression: options.outputCompression,
    background: options.background,
    moderation: options.moderation,
    inputFidelity: options.inputFidelity,
    stream: streaming ? true : null,
    partialImages,
  });
  return {
    apiKey: options.apiKey,
    operation,
    sources: options.sources,
    mask: options.mask,
    multipartImageField: options.multipartImageField ?? "image[]",
    fetchImpl,
    signal: normalizeExternalSignal(options.signal),
    timeoutMs: normalizeTimeout(options.timeoutMs),
    maxInputBytesPerImage: positiveByteLimit(
      options.maxInputBytesPerImage,
      DEFAULT_IMAGE_LIMIT_BYTES,
      "maxInputBytesPerImage",
    ),
    maxOutputBytesPerImage: positiveByteLimit(
      options.maxOutputBytesPerImage,
      DEFAULT_IMAGE_LIMIT_BYTES,
      "maxOutputBytesPerImage",
    ),
    maxResponseBytes: positiveByteLimit(options.maxResponseBytes, DEFAULT_RESPONSE_LIMIT_BYTES, "maxResponseBytes"),
    expectedFormat,
    requested,
    providerParameters,
    requestMode,
    enforceProviderOutput,
    endpoint: imageEndpoint(options.baseUrl, operation === "generate" ? "generations" : "edits"),
  };
}

function createAbortContext(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const context = {
    controller,
    cause: null,
    providerRequestId: null,
    cleanup: null,
  };
  const abortWith = (cause) => {
    if (!context.cause) context.cause = cause;
    if (!controller.signal.aborted) controller.abort();
  };
  const onExternalAbort = () => abortWith("cancelled");
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = context.cause
    ? null
    : setTimeout(() => abortWith("timeout"), timeoutMs);
  context.cleanup = (cancelUpstream = false) => {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (cancelUpstream && !controller.signal.aborted) controller.abort();
  };
  return context;
}

function normalizedRequestError(error, abort) {
  if (abort?.cause === "timeout") {
    return imageError(504, "图片供应商请求超时，请稍后重试", "IMAGE_PROVIDER_TIMEOUT", {
      retryable: true,
      providerRequestId: abort.providerRequestId,
    });
  }
  if (abort?.cause === "cancelled" || error?.name === "AbortError") {
    return imageError(499, "图片供应商请求已取消", "IMAGE_PROVIDER_CANCELLED", {
      retryable: false,
      providerRequestId: abort?.providerRequestId ?? null,
    });
  }
  if (!Number.isInteger(error?.statusCode)) {
    return imageError(502, "无法连接图片供应商", "IMAGE_PROVIDER_UNREACHABLE", {
      retryable: true,
      providerRequestId: abort?.providerRequestId ?? null,
    });
  }
  return error;
}

function assertRequestActive(abort) {
  if (abort?.cause) throw normalizedRequestError(null, abort);
}

function normalizeExternalSignal(value) {
  if (value == null) return null;
  if (
    typeof value !== "object"
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function"
  ) throw imageError(400, "图片取消信号无效", "INVALID_ABORT_SIGNAL");
  return value;
}

function normalizePartialImages(value, requestMode = "managed") {
  if (value == null) return null;
  const maximum = requestMode === "managed" ? 3 : 100;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw imageError(400, `流式局部图片数量必须为 0-${maximum}`, "INVALID_PARTIAL_IMAGE_COUNT");
  }
  return value;
}

function normalizeUser(value) {
  if (value == null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || !/^[\x20-\x7e]+$/.test(value)
  ) throw imageError(400, "图片供应商用户标识无效", "INVALID_IMAGE_USER");
  return value;
}

function positiveByteLimit(value, fallback, name) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw imageError(400, `${name} 必须为正整数`, "INVALID_IMAGE_BYTE_LIMIT");
  }
  return value;
}

function generationRequest(apiKey, requested, rawProviderParameters, signal) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(providerParameters(requested, rawProviderParameters)),
    signal,
  };
}

function editRequest({
  apiKey,
  requested,
  sources,
  mask,
  multipartImageField,
  maxInputBytesPerImage,
  providerParameters: rawProviderParameters,
  signal,
}) {
  if (!MULTIPART_IMAGE_FIELDS.has(multipartImageField)) {
    throw imageError(400, "图片供应商 multipart 图片字段无效", "INVALID_MULTIPART_IMAGE_FIELD");
  }
  if (!Array.isArray(sources) || !sources.length) {
    throw imageError(400, "编辑或扩图至少需要一张源图片", "IMAGE_SOURCE_REQUIRED");
  }
  const form = new FormData();
  for (const [name, value] of Object.entries(providerParameters(requested, rawProviderParameters))) {
    form.append(name, formValue(value));
  }
  for (const source of sources) {
    appendImagePart(form, multipartImageField, source, "source.png", maxInputBytesPerImage);
  }
  if (mask != null) appendImagePart(form, "mask", mask, "mask.png", maxInputBytesPerImage);
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  };
}

function appendImagePart(form, field, input, fallbackFilename, maxInputBytesPerImage) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !(input.data instanceof Uint8Array)) {
    throw imageError(400, "输入图片数据无效", "INVALID_IMAGE_SOURCE");
  }
  let inspected;
  try {
    inspected = inspectImageBuffer(input.data, { maxBytes: maxInputBytesPerImage });
  } catch {
    throw imageError(400, "输入图片数据无效", "INVALID_IMAGE_SOURCE");
  }
  const declaredMediaType = cleanMediaType(input.mediaType);
  if (declaredMediaType && declaredMediaType !== inspected.mediaType) {
    throw imageError(400, "输入图片格式与媒体类型不符", "IMAGE_SOURCE_FORMAT_MISMATCH");
  }
  const extension = inspected.format === "jpeg" ? "jpg" : inspected.format;
  const filename = safeFilename(input.filename, `${fallbackFilename.replace(/\.[^.]*$/, "")}.${extension}`);
  const bytes = Buffer.isBuffer(input.data)
    ? input.data
    : Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  form.append(field, new File([bytes], filename, { type: inspected.mediaType }));
}

function providerParameters(requested, rawProviderParameters = {}) {
  const result = { ...rawProviderParameters };
  const assign = (name, value, aliases = [name]) => {
    if (value === undefined || value === null) return;
    for (const alias of aliases) {
      if (alias !== name) delete result[alias];
    }
    result[name] = value;
  };
  // The configured model, prompt, and tracking user are WFL-owned routing
  // fields. Provider-native parameters can add fields, but cannot replace
  // those values or the stored credential/endpoint.
  if (requested.model !== undefined && requested.model !== null) result.model = requested.model;
  if (requested.prompt !== undefined && requested.prompt !== null) result.prompt = requested.prompt;
  if (requested.user !== undefined && requested.user !== null) result.user = requested.user;
  assign("n", requested.n);
  assign("size", requested.size);
  assign("quality", requested.quality);
  assign("output_format", requested.outputFormat, ["output_format", "outputFormat"]);
  assign("output_compression", requested.outputCompression, ["output_compression", "outputCompression"]);
  assign("background", requested.background);
  assign("moderation", requested.moderation);
  assign("input_fidelity", requested.inputFidelity, ["input_fidelity", "inputFidelity"]);
  assign("stream", requested.stream);
  assign("partial_images", requested.partialImages, ["partial_images", "partialImages"]);
  return result;
}

function formValue(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

function normalizeOutput(entry, { expectedFormat, maxOutputBytesPerImage }) {
  const encoded = entry?.b64_json;
  const maxEncodedImageLength = Math.ceil(maxOutputBytesPerImage * 4 / 3) + 8;
  if (
    typeof encoded !== "string"
    || !encoded.length
    || encoded.length > maxEncodedImageLength
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw imageError(502, "图片供应商返回了无效图片数据", "INVALID_IMAGE_OUTPUT");
  }
  const image = Buffer.from(encoded, "base64");
  let details;
  try {
    details = inspectImageBuffer(image, { maxBytes: maxOutputBytesPerImage, allowedFormats: [...OUTPUT_FORMATS] });
  } catch {
    throw imageError(502, "图片供应商返回的图片无效或过大", "INVALID_IMAGE_OUTPUT");
  }
  if (expectedFormat && details.format !== expectedFormat) {
    throw imageError(502, "图片供应商返回的图片格式与请求不符", "IMAGE_FORMAT_MISMATCH", {
      requestedFormat: expectedFormat,
      actualFormat: details.format,
    });
  }
  return {
    image,
    revisedPrompt: cleanText(entry?.revised_prompt, 4_000),
    width: details.width,
    height: details.height,
    format: details.format,
    mediaType: details.mediaType,
    size: details.size,
  };
}

function imageEndpoint(baseUrl, resource) {
  let url;
  try {
    url = new URL(String(baseUrl || "").trim());
  } catch {
    throw imageError(500, "图片供应商地址无效", "INVALID_IMAGE_PROVIDER_URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) throw imageError(500, "图片供应商地址无效", "INVALID_IMAGE_PROVIDER_URL");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/images/${resource}`;
  return url.href;
}

async function* parseSseEvents(body, limit) {
  if (!body) throw imageError(502, "图片供应商事件流为空", "INVALID_IMAGE_PROVIDER_STREAM");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let total = 0;
  try {
    for await (const chunk of body) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > limit) {
        throw imageError(502, "图片供应商响应过大", "IMAGE_PROVIDER_RESPONSE_TOO_LARGE");
      }
      pending += decoder.decode(bytes, { stream: true });
      while (true) {
        const boundary = findSseBoundary(pending);
        if (!boundary) break;
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary.length);
        const event = parseSseFrame(frame);
        if (event) yield event;
      }
    }
    pending += decoder.decode();
  } catch (error) {
    if (Number.isInteger(error?.statusCode) || error?.name === "AbortError") throw error;
    throw imageError(502, "图片供应商事件流编码无效", "INVALID_IMAGE_PROVIDER_STREAM");
  }
  if (pending) {
    const event = parseSseFrame(pending);
    if (event) yield event;
  }
}

function findSseBoundary(value) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseSseFrame(frame) {
  let eventType = null;
  const data = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") {
      if (!value || eventType !== null) {
        throw imageError(502, "图片供应商事件类型无效", "INVALID_IMAGE_PROVIDER_STREAM");
      }
      eventType = value;
    } else if (field === "id") {
      if (value.includes("\0")) throw imageError(502, "图片供应商事件 ID 无效", "INVALID_IMAGE_PROVIDER_STREAM");
    } else if (field === "retry") {
      if (!/^\d+$/.test(value)) throw imageError(502, "图片供应商事件重试字段无效", "INVALID_IMAGE_PROVIDER_STREAM");
    } else {
      throw imageError(502, "图片供应商事件字段无效", "INVALID_IMAGE_PROVIDER_STREAM");
    }
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  if (raw === "[DONE]") return { done: true, eventType: null, payload: null };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw imageError(502, "图片供应商事件数据无效", "INVALID_IMAGE_PROVIDER_STREAM");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw imageError(502, "图片供应商事件数据无效", "INVALID_IMAGE_PROVIDER_STREAM");
  }
  return { done: false, eventType, payload };
}

function streamOutputEntries(payload) {
  if (Array.isArray(payload?.data)) {
    if (payload.data.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
      throw imageError(502, "图片供应商完成事件数据无效", "INVALID_IMAGE_PROVIDER_STREAM");
    }
    return payload.data;
  }
  return typeof payload?.b64_json === "string" ? [payload] : [];
}

function imageStreamError(payload, providerRequestId, apiKey) {
  const upstream = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error
    : payload;
  const rawStatus = upstream?.status_code ?? upstream?.status ?? payload?.status_code ?? payload?.status;
  const providerStatusCode = Number.isSafeInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : 502;
  const error = imageApiError(providerStatusCode, { error: upstream }, providerRequestId, apiKey);
  if (typeof upstream?.retryable === "boolean") error.retryable = upstream.retryable;
  return error;
}

function optionalSafeInteger(value, label) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw imageError(502, `${label}无效`, "INVALID_IMAGE_PROVIDER_STREAM");
  }
  return value;
}

async function readBoundedBody(response, limit) {
  const chunks = [];
  let total = 0;
  if (!response.body) return "";
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw imageError(502, "图片供应商响应过大", "IMAGE_PROVIDER_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw imageError(502, "图片供应商返回了无效响应", "INVALID_IMAGE_PROVIDER_RESPONSE");
  }
}

function imageApiError(providerStatusCode, payload, providerRequestId, apiKey) {
  const upstream = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error
    : {};
  let statusCode = 502;
  let message = "图片供应商暂时不可用";
  if (providerStatusCode === 401 || providerStatusCode === 403) {
    message = "图片供应商密钥无效或无图片权限";
  } else if (providerStatusCode === 408 || providerStatusCode === 429) {
    statusCode = providerStatusCode;
    message = providerStatusCode === 429 ? "图片供应商请求过多或额度不足" : "图片供应商请求超时";
  } else if (providerStatusCode >= 400 && providerStatusCode < 500) {
    statusCode = 400;
    message = "图片供应商未接受请求参数";
  }
  const retryable = providerStatusCode === 408 || providerStatusCode === 429 || providerStatusCode >= 500;
  return imageError(statusCode, message, safeIdentifier(upstream.code, apiKey) || "IMAGE_PROVIDER_ERROR", {
    type: safeIdentifier(upstream.type, apiKey),
    moderationDetails: sanitizeModerationDetails(upstream.moderation_details ?? upstream.moderationDetails),
    retryable,
    providerStatusCode,
    providerRequestId,
  });
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputTextTokens = safeInteger(value.input_tokens_details?.text_tokens);
  const inputImageTokens = safeInteger(value.input_tokens_details?.image_tokens);
  const inputTokens = safeInteger(value.input_tokens) ?? (
    inputTextTokens !== null || inputImageTokens !== null ? (inputTextTokens || 0) + (inputImageTokens || 0) : null
  );
  const outputTokens = safeInteger(value.output_tokens);
  const totalTokens = safeInteger(value.total_tokens) ?? (
    inputTokens !== null || outputTokens !== null ? (inputTokens || 0) + (outputTokens || 0) : null
  );
  if (
    inputTokens === null
    && inputTextTokens === null
    && inputImageTokens === null
    && outputTokens === null
    && totalTokens === null
  ) return null;
  return {
    inputTokens: inputTokens || 0,
    inputTextTokens: inputTextTokens || 0,
    inputImageTokens: inputImageTokens || 0,
    cachedInputTokens: 0,
    outputTokens: outputTokens || 0,
    reasoningOutputTokens: 0,
    totalTokens: totalTokens || 0,
  };
}

function attachProviderAccounting(error, providerUsage, providerRequestId) {
  if (!providerUsage || !error || (typeof error !== "object" && typeof error !== "function")) return error;
  error.providerUsage = providerUsage;
  error.providerRequestId = providerRequestId;
  return error;
}

function parseExpectedSize(value) {
  if (value == null || value === "auto") return null;
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(String(value));
  if (!match) throw imageError(400, "图片尺寸参数无效", "INVALID_IMAGE_SIZE");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) throw imageError(400, "图片尺寸参数无效", "INVALID_IMAGE_SIZE");
  return { width, height };
}

function normalizeExpectedFormat(value) {
  if (value == null) return null;
  const format = String(value).trim().toLowerCase();
  const normalized = format === "jpg" ? "jpeg" : format;
  if (!OUTPUT_FORMATS.has(normalized)) throw imageError(400, "图片输出格式参数无效", "INVALID_IMAGE_FORMAT");
  return normalized;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function normalizeTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 180_000;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function cleanText(value, limit) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, limit) : null;
}

function cleanMediaType(value) {
  const mediaType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!mediaType) return null;
  return mediaType === "image/jpg" ? "image/jpeg" : mediaType;
}

function safeFilename(value, fallback) {
  const filename = typeof value === "string" ? value.trim() : "";
  if (!filename || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === "." || filename === "..") {
    return fallback;
  }
  return filename;
}

function safeRequestId(value, sensitiveValue) {
  const requestId = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,200}$/.test(requestId) && !containsSensitiveValue(requestId, sensitiveValue)
    ? requestId
    : null;
}

function safeIdentifier(value, sensitiveValue) {
  const identifier = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,100}$/.test(identifier) && !containsSensitiveValue(identifier, sensitiveValue)
    ? identifier
    : null;
}

function containsSensitiveValue(value, sensitiveValue) {
  const sensitive = typeof sensitiveValue === "string" ? sensitiveValue.trim() : "";
  return sensitive.length >= 4 && value.includes(sensitive);
}

function sanitizeModerationDetails(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (depth === 0) return null;
    const entries = value.slice(0, 20).flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const normalized = entry.trim().toLowerCase();
      return normalized.length <= 64
        && /^[a-z0-9_/-]+$/.test(normalized)
        && SAFE_MODERATION_ENUMS.has(normalized)
        ? [normalized]
        : [];
    });
    return entries.length ? entries : null;
  }
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) continue;
    if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) output[key] = entry;
    else if (typeof entry === "string") {
      const normalized = entry.trim().toLowerCase();
      if (SAFE_MODERATION_ENUMS.has(normalized)) output[key] = normalized;
    } else {
      const nested = sanitizeModerationDetails(entry, depth + 1);
      if (nested && Object.keys(nested).length) output[key] = nested;
    }
  }
  return Object.keys(output).length ? output : null;
}

function imageError(statusCode, message, code = "IMAGE_PROVIDER_ERROR", details = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...details });
}
