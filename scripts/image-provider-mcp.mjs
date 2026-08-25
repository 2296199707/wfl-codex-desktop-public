#!/usr/bin/env node
import net from "node:net";

const PROTOCOL_VERSION = "2025-06-18";
const SOCKET_CONNECT_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const MAX_IMAGE_PROMPT_CHARACTERS = 32_000;
const CAPABILITY_POLL_INTERVAL_MS = 2_000;
const SAFE_IMAGE_ERROR_VALUES = new Set([
  "allowed", "blocked", "critical", "harassment", "harassment/threatening", "hate", "hate/threatening",
  "high", "illicit", "illicit/violent", "input", "low", "medium", "output", "safe", "self-harm",
  "self-harm/instructions", "self-harm/intent", "sexual", "sexual/minors", "unknown", "unsafe",
  "very_high", "very_low", "violence", "violence/graphic",
]);
const IMAGE_ROLLBACK_OPERATIONS = new Set([
  "close-temporary",
  "remove-output",
  "remove-temporary",
  "sync-directory",
  "verify-output-removal",
]);
const TOOL_OPERATIONS = new Map([
  ["generate_image", "generate"],
  ["edit_image", "edit"],
  ["outpaint_image", "outpaint"],
]);

const socketPath = parseSocketPath(process.argv.slice(2));
let buffer = "";
let initialized = false;
let capabilityFingerprint = null;
let capabilityPoll = null;
let capabilityPollRunning = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handleLine(line);
    newline = buffer.indexOf("\n");
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "notifications/initialized") {
      initialized = true;
      startCapabilityPolling();
    }
    return;
  }
  try {
    if (message.method === "initialize") {
      const capabilities = await requestImageCapabilities().catch(() => null);
      capabilityFingerprint = capabilities ? fingerprintCapabilities(capabilities) : null;
      writeResult(message.id, {
        protocolVersion: supportedProtocolVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: "wfl-image-provider",
          title: "WFL 图片供应商",
          version: "2.0.0",
        },
        instructions: imageProviderInstructions(capabilities),
      });
      startCapabilityPolling();
      return;
    }
    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }
    if (message.method === "tools/list") {
      const capabilities = await requestImageCapabilities();
      capabilityFingerprint = fingerprintCapabilities(capabilities);
      writeResult(message.id, { tools: imageToolDefinitions(capabilities) });
      return;
    }
    if (message.method === "tools/call") {
      const operation = TOOL_OPERATIONS.get(message.params?.name);
      if (!operation) {
        writeResult(message.id, toolError({ code: "UNKNOWN_IMAGE_TOOL", message: "未知的图片供应商工具" }));
        return;
      }
      const capabilities = await requestImageCapabilities();
      if (!capabilities.enabled || !capabilities.operations.includes(operation)) {
        throw toolRequestError("IMAGE_OPERATION_UNAVAILABLE", "当前图片供应商未启用这个操作");
      }
      const input = validateToolArguments(operation, message.params?.arguments, capabilities);
      const result = await requestImageOperation(operation, input);
      writeResult(message.id, {
        content: [{ type: "text", text: formatResult(operation, result) }],
        structuredContent: result,
        isError: false,
      });
      return;
    }
    writeError(message.id, -32601, "Method not found");
  } catch (error) {
    if (message.method === "tools/call") writeResult(message.id, toolError(error));
    else writeError(message.id, -32603, String(error?.message || "Internal error").slice(0, 2_000));
  }
}

function startCapabilityPolling() {
  if (capabilityPoll) return;
  capabilityPoll = setInterval(() => void pollImageCapabilities(), CAPABILITY_POLL_INTERVAL_MS);
  capabilityPoll.unref?.();
}

async function pollImageCapabilities() {
  if (!initialized || capabilityPollRunning) return;
  capabilityPollRunning = true;
  try {
    const capabilities = await requestImageCapabilities();
    const nextFingerprint = fingerprintCapabilities(capabilities);
    if (capabilityFingerprint !== null && nextFingerprint !== capabilityFingerprint) {
      capabilityFingerprint = nextFingerprint;
      writeNotification("notifications/tools/list_changed", {});
      return;
    }
    capabilityFingerprint = nextFingerprint;
  } catch {
    // A temporary control-socket failure does not mutate the advertised tool
    // list. The next successful poll compares against the last known state.
  } finally {
    capabilityPollRunning = false;
  }
}

function fingerprintCapabilities(capabilities) {
  return JSON.stringify(capabilities);
}

function imageProviderInstructions(capabilities) {
  const operations = capabilities?.enabled ? capabilities.operations : [];
  const labels = operations.map((operation) => ({
    generate: "生成",
    edit: "参考图编辑",
    outpaint: "扩图",
  }[operation])).filter(Boolean);
  const scope = labels.length ? labels.join("、") : "当前未启用图片操作";
  return `当前可用能力：${scope}。所有图片输入和输出都必须使用工程路径；普通生成不会读取提示词中提到的图片路径；每次调用严格使用显式参数，不会自动重试、改尺寸或降低画质。MCP 表面不提供流式局部图片。`;
}

function imageToolDefinitions(capabilities) {
  if (!capabilities.enabled) return [];
  const tools = [];
  if (capabilities.operations.includes("generate")) tools.push(
    {
      name: "generate_image",
      title: "生成项目图片",
      description: "按显式参数从零生成一张或多张图片并保存到当前工程。这个工具不会读取提示词中提到的现有图片；编辑或扩图必须分别使用 edit_image 或 outpaint_image。不会自动重试、切换模型、改变尺寸或降低画质。",
      inputSchema: objectSchema(commonProperties(capabilities, "generate"), ["prompt", "project"]),
    },
  );
  if (capabilities.operations.includes("edit")) {
    const common = commonProperties(capabilities, "edit");
    const editProperties = {
      ...common,
      sourcePaths: {
        type: "array",
        minItems: 1,
        maxItems: capabilities.limits.maxInputImages,
        items: relativePathSchema("工程内源图片相对路径。"),
        description: `按顺序使用的工程内参考图片，最多 ${capabilities.limits.maxInputImages} 张。`,
      },
    };
    if (capabilities.features.mask) {
      editProperties.maskPath = relativePathSchema("可选的工程内蒙版相对路径；必须与第一张源图同格式、同尺寸并包含 alpha 通道。透明区域表示需要编辑。");
      editProperties.maskMode = enumSchema(
        ["strict", "soft"],
        "蒙版行为。strict 由 WFL 在供应商返回后恢复不透明区域，保证 PNG 输出的蒙版外像素不变；soft 使用供应商的提示性蒙版行为。默认 strict。",
      );
      editProperties.maskFeather = {
        type: "integer",
        minimum: 0,
        maximum: 128,
        description: "strict 模式下服务端合成边缘羽化像素，默认 0。",
      };
    }
    tools.push(
    {
      name: "edit_image",
      title: "编辑项目图片",
      description: "使用一张或多张工程内参考图进行编辑，可选用工程内蒙版。蒙版是供应商的提示性约束；选择 strict 时由 WFL 做确定性像素恢复。只接受路径，不接受 URL、Base64 或文件 ID。",
      inputSchema: objectSchema(editProperties, ["prompt", "project", "sourcePaths"]),
    },
    );
  }
  if (capabilities.operations.includes("outpaint")) tools.push(
    {
      name: "outpaint_image",
      title: "扩展项目图片",
      description: "向工程内图片的指定边缘扩图并保存结果。原图区域由服务端保留，不接受外部图片引用。",
      inputSchema: objectSchema({
        ...commonProperties(capabilities, "outpaint", { includeSize: false }),
        sourcePath: relativePathSchema("需要扩展的工程内源图片相对路径。"),
        expand: {
          type: "object",
          additionalProperties: false,
          properties: {
            top: pixelSchema("向上扩展的像素数。"),
            right: pixelSchema("向右扩展的像素数。"),
            bottom: pixelSchema("向下扩展的像素数。"),
            left: pixelSchema("向左扩展的像素数。"),
          },
          required: ["top", "right", "bottom", "left"],
          description: "四边扩展像素；至少一边必须大于 0。",
        },
        preserveSource: enumSchema(
          ["exact", "seamless"],
          "原图保留模式。exact 像素级恢复全部原图；seamless 允许接缝内侧过渡区参与生成并羽化合成。默认 exact。",
        ),
        blendMargin: {
          type: "integer",
          minimum: 1,
          maximum: 512,
          description: "seamless 模式的接缝过渡宽度，默认 64 像素。",
        },
        alignmentPolicy: enumSchema(
          ["reject", "pad-and-crop", "rescale-and-crop"],
          "逻辑画布不被供应商尺寸支持时的显式处理策略。默认 reject；系统绝不自动切换策略。",
        ),
      }, ["prompt", "project", "sourcePath", "expand"]),
    },
  );
  return tools;
}

function commonProperties(capabilities, operation, { includeSize = true } = {}) {
  const properties = {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: capabilities.limits.maxPromptCharacters,
      description: "完整、具体的图片描述，包括风格、主体、构图和用途。",
    },
    project: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      pattern: "^/",
      description: "当前工程的绝对路径，通常就是本轮任务的 cwd。",
    },
    outputPath: relativePathSchema("可选的工程内输出相对路径；多结果会由服务端生成互不覆盖的路径。"),
    n: {
      type: "integer",
      minimum: 1,
      maximum: capabilities.limits.maxOutputs,
      description: "输出图片数量；所有结果都会返回。",
    },
  };
  if (includeSize) properties.size = sizeSchema(capabilities, operation);
  if (capabilities.options.qualities.length) {
    properties.quality = enumSchema(capabilities.options.qualities, "输出质量。");
  }
  if (capabilities.options.outputFormats.length) {
    properties.outputFormat = enumSchema(capabilities.options.outputFormats, "输出格式。");
  }
  if (capabilities.options.outputFormats.some((format) => format === "jpeg" || format === "webp")) {
    properties.outputCompression = {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "JPEG/WebP 输出压缩质量，0-100。",
    };
  }
  if (capabilities.options.backgrounds.length) {
    properties.background = enumSchema(capabilities.options.backgrounds, "输出背景。");
  }
  if (capabilities.options.moderations.length) {
    properties.moderation = enumSchema(capabilities.options.moderations, "内容审核档位。");
  }
  return properties;
}

function sizeSchema(capabilities, operation) {
  const limits = capabilities.limits;
  const operationCapability = capabilities.operationCapabilities[operation] || {
    customSize: limits.fixedSizes.length === 0,
    sizes: limits.fixedSizes,
  };
  if (!operationCapability.customSize) {
    return enumSchema(operationCapability.sizes, `当前供应商 ${operation} 操作支持的输出尺寸。`);
  }
  return {
    type: "string",
    pattern: limits.size.allowAuto
      ? "^(auto|[1-9][0-9]{0,3}x[1-9][0-9]{0,3})$"
      : "^[1-9][0-9]{0,3}x[1-9][0-9]{0,3}$",
    description: `明确的输出尺寸 WIDTHxHEIGHT，或预设允许时使用 auto。常用已验证尺寸：${operationCapability.sizes.join(", ") || "未配置"}；其他尺寸仍须满足管理员冻结的限制。`,
  };
}

function objectSchema(properties, required) {
  return { type: "object", additionalProperties: false, properties, required };
}

function relativePathSchema(description) {
  return {
    type: "string",
    minLength: 1,
    maxLength: 1024,
    pattern: "^(?!/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
    description,
  };
}

function enumSchema(values, description) {
  return { type: "string", enum: values, description };
}

function pixelSchema(description) {
  return { type: "integer", minimum: 0, maximum: 3840, description };
}

function validateToolArguments(operation, value, capabilities) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw toolRequestError("INVALID_IMAGE_TOOL_ARGUMENTS", "图片工具参数必须是对象");
  }
  const definition = imageToolDefinitions(capabilities)
    .find((tool) => TOOL_OPERATIONS.get(tool.name) === operation);
  if (!definition) throw toolRequestError("IMAGE_OPERATION_UNAVAILABLE", "当前图片供应商未启用这个操作");
  const allowed = new Set(Object.keys(definition.inputSchema.properties));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw toolRequestError("INVALID_IMAGE_TOOL_ARGUMENTS", `图片工具不接受参数 ${key}`);
  }
  boundedString(value.prompt, "图片描述", 1, capabilities.limits.maxPromptCharacters);
  absoluteProjectPath(value.project);
  if (value.outputPath !== undefined) relativeProjectPath(value.outputPath, "图片输出路径");
  validateCommonControls(value, capabilities, operation);

  if (operation === "generate" && looksLikeSourceImageRequest(value.prompt)) {
    throw toolRequestError(
      "IMAGE_SOURCE_REQUIRED",
      "普通生成工具不会读取提示词中提到的工程图片；请使用 edit_image 或 outpaint_image 并显式传入源图片路径",
    );
  }

  if (operation === "edit") {
    const maximum = capabilities.limits.maxInputImages;
    if (!Array.isArray(value.sourcePaths) || value.sourcePaths.length < 1 || value.sourcePaths.length > maximum) {
      throw toolRequestError("INVALID_IMAGE_SOURCE", `编辑操作需要 1-${maximum} 个工程内源图片路径`);
    }
    for (const sourcePath of value.sourcePaths) relativeProjectPath(sourcePath, "源图片路径");
    if (value.maskPath !== undefined) relativeProjectPath(value.maskPath, "蒙版路径");
    optionalEnum(value.maskMode, ["strict", "soft"], "蒙版模式");
    optionalInteger(value.maskFeather, 0, 128, "蒙版羽化像素");
    if (!value.maskPath && (value.maskMode !== undefined || value.maskFeather !== undefined)) {
      throw toolRequestError("INVALID_IMAGE_MASK", "蒙版模式和羽化参数必须同时指定蒙版图片");
    }
    if (value.maskFeather !== undefined && value.maskMode === "soft") {
      throw toolRequestError("INVALID_IMAGE_MASK", "软蒙版模式不接受服务端羽化参数");
    }
  }
  if (operation === "outpaint") {
    relativeProjectPath(value.sourcePath, "扩图源图片路径");
    validateExpansion(value.expand);
    optionalEnum(value.preserveSource, ["exact", "seamless"], "原图保留模式");
    optionalInteger(value.blendMargin, 1, 512, "无缝扩图过渡宽度");
    optionalEnum(
      value.alignmentPolicy,
      ["reject", "pad-and-crop", "rescale-and-crop"],
      "扩图尺寸对齐策略",
    );
    if (value.blendMargin !== undefined && value.preserveSource !== "seamless") {
      throw toolRequestError("INVALID_OUTPAINT", "只有无缝扩图模式可以指定过渡宽度");
    }
  }
  return structuredClone(value, { transfer: [] });
}

function validateCommonControls(value, capabilities, operation) {
  if (value.size !== undefined) validateRequestedSize(value.size, capabilities, operation);
  optionalEnum(value.quality, capabilities.options.qualities, "图片质量");
  optionalEnum(value.outputFormat, capabilities.options.outputFormats, "输出格式");
  optionalInteger(value.outputCompression, 0, 100, "输出压缩率");
  optionalEnum(value.background, capabilities.options.backgrounds, "图片背景");
  if (value.background === "transparent" && value.outputFormat === "jpeg") {
    throw toolRequestError("INVALID_IMAGE_BACKGROUND", "透明背景只支持 PNG 或 WebP 输出");
  }
  optionalEnum(value.moderation, capabilities.options.moderations, "审核档位");
  optionalInteger(value.n, 1, capabilities.limits.maxOutputs, "输出数量");
}

function validateRequestedSize(value, capabilities, operation) {
  const limits = capabilities.limits;
  if (operation === "outpaint") {
    throw toolRequestError("INVALID_IMAGE_TOOL_ARGUMENTS", "扩图尺寸由扩展边距决定");
  }
  const normalized = String(value || "");
  const operationCapability = capabilities.operationCapabilities[operation] || {
    customSize: limits.fixedSizes.length === 0,
    sizes: limits.fixedSizes,
  };
  if (operationCapability.sizes.includes(normalized)) return;
  if (!operationCapability.customSize) {
    const error = toolRequestError(
      "IMAGE_PROVIDER_SIZE_UNSUPPORTED",
      `当前供应商的 ${operation} 操作不支持尺寸 ${normalized}；支持尺寸：${operationCapability.sizes.join(", ") || "无"}`,
    );
    error.stage = "local_prepare";
    error.operation = operation;
    error.requestedSize = normalized;
    error.supportedSizes = operationCapability.sizes;
    error.reason = "provider_size_unsupported";
    error.retryable = false;
    throw error;
  }
  if (normalized === "auto" && limits.size.allowAuto) return;
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(normalized);
  if (!match) throw toolRequestError("INVALID_IMAGE_SIZE", "图片尺寸必须是 auto 或 WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (
    width > limits.size.maxWidth
    || height > limits.size.maxHeight
    || width % limits.size.dimensionMultiple !== 0
    || height % limits.size.dimensionMultiple !== 0
    || Math.max(width / height, height / width) > limits.size.maxAspectRatio
    || pixels < limits.size.minPixels
    || pixels > limits.size.maxPixels
  ) {
    throw toolRequestError("INVALID_IMAGE_SIZE", "图片尺寸不符合当前管理员预设限制");
  }
}

function looksLikeSourceImageRequest(prompt) {
  const text = String(prompt || "");
  const mentionsImagePath = /(?:^|[\s'"“”‘’(（])(?:\.?\.?\/)?[^\s'"“”‘’()（）]{1,240}\.(?:png|jpe?g|webp)(?:$|[\s'"“”‘’),，。；;）])/iu.test(text);
  const requestsSourceOperation = /(?:扩图|扩展(?:这|该|原)?图|补全(?:这|该|原)?图|编辑(?:这|该|原)?图|修改(?:这|该|原)?图|根据.{0,20}(?:图片|图像|图)|参考图|蒙版|outpaint|inpaint|edit\s+(?:this|the)?\s*image|based\s+on\s+(?:this|the)?\s*image|source(?:path|\s+image)|mask(?:path|\s+image))/iu.test(text);
  return mentionsImagePath && requestsSourceOperation;
}

function validateExpansion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw toolRequestError("INVALID_OUTPAINT_EXPANSION", "扩图必须指定四边扩展像素");
  }
  const sides = ["top", "right", "bottom", "left"];
  if (Object.keys(value).some((key) => !sides.includes(key)) || sides.some((side) => !Object.hasOwn(value, side))) {
    throw toolRequestError("INVALID_OUTPAINT_EXPANSION", "扩图参数必须完整指定 top、right、bottom、left");
  }
  for (const side of sides) optionalInteger(value[side], 0, 3_840, "扩图边距", true);
  if (sides.every((side) => value[side] === 0)) {
    throw toolRequestError("INVALID_OUTPAINT_EXPANSION", "至少需要扩展一侧");
  }
}

function absoluteProjectPath(value) {
  boundedString(value, "工程路径", 1, 4_096);
  if (!value.startsWith("/") || /[\u0000\r\n]/.test(value)) {
    throw toolRequestError("INVALID_PROJECT_PATH", "工程路径必须是绝对路径");
  }
}

function relativeProjectPath(value, label) {
  boundedString(value, label, 1, 1_024);
  if (
    value.includes("\\")
    || /[\u0000\r\n]/.test(value)
    || value.startsWith("/")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) throw toolRequestError("INVALID_PROJECT_FILE_PATH", `${label}必须是工程内相对路径`);
  const segments = value.replace(/^\.\//, "").split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw toolRequestError("INVALID_PROJECT_FILE_PATH", `${label}必须是工程内相对路径`);
  }
}

function boundedString(value, label, minimum, maximum) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw toolRequestError("INVALID_IMAGE_TOOL_ARGUMENTS", `${label}长度无效`);
  }
}

function optionalEnum(value, allowed, label) {
  if (value !== undefined && !allowed.includes(value)) {
    throw toolRequestError("INVALID_IMAGE_TOOL_ARGUMENTS", `${label}无效`);
  }
}

function optionalInteger(value, minimum, maximum, label, required = false) {
  if (value === undefined && !required) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw toolRequestError("INVALID_IMAGE_TOOL_ARGUMENTS", `${label}必须是 ${minimum}-${maximum} 的整数`);
  }
}

function requestImageCapabilities() {
  return requestImageService({ version: 2, action: "capabilities" })
    .then(normalizeImageCapabilities);
}

function requestImageOperation(operation, input) {
  return requestImageService({ version: 2, action: "execute", operation, ...input });
}

function requestImageService(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS);
    let responseBuffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("connect", () => {
      // Queue wait and execution time are controlled by the frozen server-side
      // Worker settings; do not impose a second hidden timeout in the MCP shim.
      socket.setTimeout(0);
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      responseBuffer += chunk;
      if (Buffer.byteLength(responseBuffer) > RESPONSE_LIMIT_BYTES) {
        finish(toolRequestError("IMAGE_TOOL_RESPONSE_TOO_LARGE", "图片工具响应过大"));
        return;
      }
      const newline = responseBuffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(responseBuffer.slice(0, newline));
      } catch {
        finish(toolRequestError("INVALID_IMAGE_TOOL_RESPONSE", "图片工具返回了无效响应"));
        return;
      }
      if (!response?.ok) finish(normalizeServiceError(response?.error));
      else finish(null, response.result);
    });
    socket.on("timeout", () => finish(toolRequestError("IMAGE_TOOL_TIMEOUT", "图片供应商工具调用超时")));
    socket.on("error", () => finish(toolRequestError("IMAGE_TOOL_UNAVAILABLE", "WFL 图片供应商服务当前不可用")));
    socket.on("end", () => {
      if (!settled) finish(toolRequestError("IMAGE_TOOL_DISCONNECTED", "WFL 图片供应商服务提前断开"));
    });
  });
}

function normalizeImageCapabilities(value) {
  const input = plainObject(value);
  const features = plainObject(input.features);
  const limits = plainObject(input.limits);
  const size = plainObject(limits.size);
  const options = plainObject(input.options);
  const operations = stringEnumList(input.operations, ["generate", "edit", "outpaint"]);
  const fixedSizes = stringEnumList(limits.fixedSizes, null, 64).filter(validImageSizeName);
  const operationCapabilities = normalizeOperationCapabilities(
    input.operationCapabilities,
    operations,
    fixedSizes,
    Boolean(limits.size),
  );
  return {
    enabled: input.enabled === true,
    operations,
    features: {
      mask: features.mask === true,
      multiInput: features.multiInput === true,
      streaming: false,
      partialImages: false,
      strictMask: operations.includes("edit") && features.mask === true,
      seamlessOutpaint: operations.includes("outpaint"),
    },
    operationCapabilities,
    limits: {
      maxPromptCharacters: boundedCapabilityInteger(
        limits.maxPromptCharacters,
        1,
        MAX_IMAGE_PROMPT_CHARACTERS,
        4_000,
      ),
      maxInputImages: boundedCapabilityInteger(limits.maxInputImages, 0, 100, 0),
      maxOutputs: boundedCapabilityInteger(limits.maxOutputs, 1, 100, 1),
      fixedSizes,
      size: {
        allowAuto: size.allowAuto === true,
        maxWidth: boundedCapabilityInteger(size.maxWidth, 1, 16_384, 3_840),
        maxHeight: boundedCapabilityInteger(size.maxHeight, 1, 16_384, 3_840),
        dimensionMultiple: boundedCapabilityInteger(size.dimensionMultiple, 1, 1_024, 16),
        maxAspectRatio: boundedCapabilityNumber(size.maxAspectRatio, 1, 100, 3),
        minPixels: boundedCapabilityInteger(size.minPixels, 1, 256_000_000, 655_360),
        maxPixels: boundedCapabilityInteger(size.maxPixels, 1, 256_000_000, 8_294_400),
      },
    },
    options: {
      qualities: stringEnumList(options.qualities, ["auto", "low", "medium", "high"]),
      outputFormats: stringEnumList(options.outputFormats, ["png", "jpeg", "webp"]),
      // Keep the MCP schema in lockstep with the provider-store capability
      // contract.  Transparent output is required by map/sprite workflows;
      // generation-only providers still advertise only their configured
      // `opaque` value because this list is filtered against the service
      // response rather than adding capabilities on its own.
      backgrounds: stringEnumList(options.backgrounds, ["auto", "opaque", "transparent"]),
      moderations: stringEnumList(options.moderations, ["auto", "low"]),
    },
  };
}

function normalizeOperationCapabilities(value, operations, fixedSizes, hasCustomLimits) {
  const source = plainObject(value);
  const fallback = {
    customSize: fixedSizes.length === 0 && hasCustomLimits,
    sizes: fixedSizes,
  };
  return Object.fromEntries(["generate", "edit", "outpaint"].map((operation) => {
    const entry = plainObject(source[operation]);
    const sizes = Array.isArray(entry.sizes)
      ? stringEnumList(entry.sizes, null, 64).filter(validImageSizeName)
      : [...fallback.sizes];
    const customSize = Object.hasOwn(entry, "customSize")
      ? entry.customSize === true
      : fallback.customSize;
    return [operation, {
      customSize: operations.includes(operation) && customSize,
      sizes: operations.includes(operation) ? sizes : [],
    }];
  }));
}

function validImageSizeName(value) {
  return /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringEnumList(value, allowed = null, maximum = 16) {
  if (!Array.isArray(value)) return [];
  const entries = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))]
    .slice(0, maximum);
  return allowed ? entries.filter((entry) => allowed.includes(entry)) : entries;
}

function boundedCapabilityInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function boundedCapabilityNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function formatResult(operation, result) {
  const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
  if (outputs.length) {
    const labels = { generate: "生成", edit: "编辑", outpaint: "扩图" };
    const requested = plainObject(result?.requested);
    const usage = plainObject(result?.usage);
    const effectiveOperation = requested.operation || operation;
    const lines = [
      `图片${labels[operation]}完成，共 ${outputs.length} 个结果：`,
      `供应商：${requested.provider || result?.provider || "wfl"}`,
      `操作：${effectiveOperation}`,
      requested.model ? `模型：${requested.model}` : null,
      typeof requested.sourceConsumed === "boolean"
        ? `源图：${requested.sourceConsumed ? "已读取" : "未读取"}`
        : null,
      Number.isSafeInteger(usage.inputImageTokens)
        ? `输入图像 Tokens：${usage.inputImageTokens}`
        : null,
      requested.requestedCanvas || requested.size
        ? `最终画布：${requested.requestedCanvas || requested.size}`
        : null,
      requested.providerSize && requested.providerSize !== (requested.requestedCanvas || requested.size)
        ? `供应商画布：${requested.providerSize}`
        : null,
    ].filter(Boolean);
    outputs.forEach((output, index) => {
      const actual = output?.actual && typeof output.actual === "object" ? output.actual : output;
      const location = output?.relativePath || output?.path || output?.attachment?.relativePath || "未提供路径";
      const dimensions = Number.isInteger(actual?.width) && Number.isInteger(actual?.height)
        ? `${actual.width}x${actual.height}`
        : null;
      const format = actual?.format || output?.format || null;
      const bytes = Number.isSafeInteger(actual?.size ?? output?.size) ? `${actual?.size ?? output.size} bytes` : null;
      lines.push(`${index + 1}. ${location}${[dimensions, format, bytes].filter(Boolean).length ? ` (${[dimensions, format, bytes].filter(Boolean).join(", ")})` : ""}`);
    });
    if (Array.isArray(requested.postprocess) && requested.postprocess.length) {
      lines.push(`后处理：${requested.postprocess.join("；")}`);
    }
    if (result.providerRequestId) lines.push(`供应商请求 ID：${result.providerRequestId}`);
    return lines.join("\n");
  }
  if (result?.attachment) {
    return [
      `图片已生成：${result.attachment.relativePath || result.attachment.path}`,
      result.size || result.model ? `尺寸：${result.size || "未知"}；模型：${result.model || "未知"}` : null,
      result.revisedPrompt ? `修订描述：${result.revisedPrompt}` : null,
    ].filter(Boolean).join("\n");
  }
  return "图片操作已完成。";
}

function normalizeServiceError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return toolRequestError("IMAGE_TOOL_FAILED", String(value || "图片操作失败").slice(0, 2_000));
  }
  const error = toolRequestError(normalizeErrorCode(value.code), String(value.message || "图片操作失败").slice(0, 2_000));
  const type = safeErrorIdentifier(value.type, 100);
  if (type) error.type = type;
  if (Number.isInteger(value.status)) error.status = value.status;
  if (typeof value.requestId === "string" && value.requestId.trim()) error.requestId = value.requestId.trim().slice(0, 200);
  error.retryable = value.retryable === true;
  if (Number.isInteger(value.providerStatusCode) && value.providerStatusCode >= 400 && value.providerStatusCode <= 599) {
    error.providerStatusCode = value.providerStatusCode;
  }
  error.moderationDetails = sanitizeImageErrorDetails(value.moderationDetails);
  const partialOutputs = sanitizeImagePartialOutputs(value.partialOutputs);
  const rollbackFailures = sanitizeImageRollbackFailures(value.rollbackFailures);
  if (partialOutputs.length) error.partialOutputs = partialOutputs;
  if (rollbackFailures.length) error.rollbackFailures = rollbackFailures;
  Object.assign(error, sanitizeImageErrorDiagnostics(value));
  return error;
}

function toolRequestError(code, message) {
  const error = new Error(message);
  error.code = normalizeErrorCode(code);
  error.retryable = false;
  return error;
}

function toolError(value) {
  const error = value instanceof Error ? value : normalizeServiceError(value);
  const partialOutputs = sanitizeImagePartialOutputs(error.partialOutputs);
  const rollbackFailures = sanitizeImageRollbackFailures(error.rollbackFailures);
  const diagnostics = sanitizeImageErrorDiagnostics(error);
  const structured = {
    code: normalizeErrorCode(error.code),
    ...(error.type ? { type: error.type } : {}),
    message: String(error.message || "图片操作失败").slice(0, 2_000),
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    ...(error.requestId ? { requestId: String(error.requestId).slice(0, 200) } : {}),
    ...(Number.isInteger(error.providerStatusCode) ? { providerStatusCode: error.providerStatusCode } : {}),
    ...(error.moderationDetails ? { moderationDetails: error.moderationDetails } : {}),
    ...(partialOutputs.length ? { partialOutputs } : {}),
    ...(rollbackFailures.length ? { rollbackFailures } : {}),
    ...diagnostics,
    retryable: error.retryable === true,
  };
  return {
    content: [{ type: "text", text: `${structured.code}: ${structured.message}` }],
    structuredContent: { error: structured },
    isError: true,
  };
}

function sanitizeImagePartialOutputs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry) => {
    const index = Number(entry?.index);
    const filename = safeImageRollbackFilename(entry?.filename);
    return Number.isSafeInteger(index) && index >= 0 && index < 10 && filename
      ? [{ index, filename }]
      : [];
  });
}

function sanitizeImageRollbackFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry) => {
    const operation = IMAGE_ROLLBACK_OPERATIONS.has(entry?.operation) ? entry.operation : null;
    if (!operation) return [];
    const output = { operation };
    const index = Number(entry?.index);
    const filename = safeImageRollbackFilename(entry?.filename);
    if (Number.isSafeInteger(index) && index >= 0 && index < 10) output.index = index;
    if (filename) output.filename = filename;
    output.code = typeof entry?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(entry.code)
      ? entry.code
      : "IMAGE_ROLLBACK_FAILED";
    return [output];
  });
}

function safeImageRollbackFilename(value) {
  const filename = typeof value === "string" ? value : "";
  return filename
    && filename.length <= 255
    && !/[\\/\u0000-\u001f\u007f]/.test(filename)
    ? filename
    : null;
}

function normalizeErrorCode(value) {
  const code = String(value || "IMAGE_TOOL_FAILED").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "IMAGE_TOOL_FAILED";
}

function safeErrorIdentifier(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function sanitizeImageErrorDiagnostics(value) {
  const output = {};
  for (const field of ["stage", "operation", "reason"]) {
    const text = safeErrorIdentifier(value?.[field], 100);
    if (text) output[field] = text;
  }
  const model = typeof value?.model === "string" ? value.model.trim().slice(0, 200) : "";
  if (model && !/[\u0000-\u001f\u007f]/u.test(model)) output.model = model;
  for (const field of ["requestedSize", "providerSize", "sourceSize"]) {
    const text = typeof value?.[field] === "string" ? value[field].trim() : "";
    if (/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(text)) output[field] = text;
  }
  if (["strict", "soft"].includes(value?.maskMode)) output.maskMode = value.maskMode;
  if (["exact", "seamless"].includes(value?.preserveSource)) output.preserveSource = value.preserveSource;
  if (["reject", "pad-and-crop", "rescale-and-crop"].includes(value?.alignmentPolicy)) {
    output.alignmentPolicy = value.alignmentPolicy;
  }
  if (typeof value?.customSize === "boolean") output.customSize = value.customSize;
  if (Array.isArray(value?.supportedSizes)) {
    output.supportedSizes = [...new Set(value.supportedSizes
      .map((entry) => String(entry || "").trim())
      .filter(validImageSizeName))]
      .slice(0, 64);
  }
  return output;
}

function sanitizeImageErrorDetails(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (depth === 0) return null;
    const entries = value.slice(0, 20).flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const normalized = entry.trim().toLowerCase();
      return normalized.length <= 64
        && /^[a-z0-9_/-]+$/.test(normalized)
        && SAFE_IMAGE_ERROR_VALUES.has(normalized)
        ? [normalized]
        : [];
    });
    return entries.length ? entries : null;
  }
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) continue;
    if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
      output[key] = entry;
    } else if (typeof entry === "string") {
      const normalized = entry.trim().toLowerCase();
      if (SAFE_IMAGE_ERROR_VALUES.has(normalized)) output[key] = normalized;
    } else {
      const nested = sanitizeImageErrorDetails(entry, depth + 1);
      if (nested && Object.keys(nested).length) output[key] = nested;
    }
  }
  return Object.keys(output).length ? output : null;
}

function supportedProtocolVersion(value) {
  return ["2024-11-05", "2025-03-26", PROTOCOL_VERSION].includes(value)
    ? value
    : PROTOCOL_VERSION;
}

function parseSocketPath(args) {
  const index = args.indexOf("--socket");
  const value = index === -1 ? "" : String(args[index + 1] || "");
  if (!value.startsWith("/") || value.length > 4_096 || /[\u0000\r\n]/.test(value)) {
    process.stderr.write("WFL image provider MCP requires an absolute --socket path\n");
    process.exit(2);
  }
  return value;
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
