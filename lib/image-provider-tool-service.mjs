import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { normalizeImageProviderParameters } from "./image-provider-parameters.mjs";

const REQUEST_LIMIT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_IMAGE_PROMPT_CHARACTERS = 32_000;
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
const V2_COMMON_KEYS = new Set([
  "version", "action", "operation", "prompt", "project", "outputPath", "size",
  "quality", "outputFormat", "outputCompression", "background", "moderation", "n",
  "inputFidelity", "providerParameters",
]);
const V2_OPERATION_KEYS = {
  generate: V2_COMMON_KEYS,
  edit: new Set([...V2_COMMON_KEYS, "sourcePaths", "maskPath", "maskMode", "maskFeather"]),
  outpaint: new Set([
    ...V2_COMMON_KEYS,
    "sourcePath",
    "expand",
    "preserveSource",
    "blendMargin",
    "alignmentPolicy",
  ]),
};

export class ImageProviderToolService {
  constructor({
    directory,
    userId,
    uid = null,
    gid = null,
    generate = null,
    execute = null,
    capabilities = null,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  }) {
    if (typeof generate !== "function" && typeof execute !== "function") {
      throw new Error("Image provider tool handler is required");
    }
    this.directory = path.resolve(directory);
    this.userId = String(userId || "");
    this.uid = Number.isInteger(uid) ? uid : null;
    this.gid = Number.isInteger(gid) ? gid : null;
    this.generate = typeof generate === "function" ? generate : null;
    this.executeV2 = typeof execute === "function" ? execute : null;
    this.capabilities = typeof capabilities === "function" ? capabilities : null;
    this.requestTimeoutMs = Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : REQUEST_TIMEOUT_MS;
    this.server = null;
    this.sockets = new Set();
    const identity = crypto
      .createHash("sha256")
      .update(`${this.userId}\0${process.pid}\0${crypto.randomUUID()}`)
      .digest("hex")
      .slice(0, 24);
    // Keep the Unix socket pathname below sockaddr_un's 107-byte limit. The
    // runtime directory is already user/release scoped, so a short random
    // filename is sufficient for collision resistance here.
    this.socketPath = path.join(this.directory, `im-${identity}.sock`);
  }

  async start() {
    if (this.server) return this.socketPath;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o711 });
    const directoryStat = await fs.lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Image provider tool socket directory is unsafe");
    }
    await fs.chmod(this.directory, 0o711);

    const server = net.createServer((socket) => this.handleSocket(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      await fs.chmod(this.socketPath, 0o600);
      if (this.uid !== null && this.gid !== null) {
        await fs.chown(this.socketPath, this.uid, this.gid);
      }
      return this.socketPath;
    } catch (error) {
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      await fs.unlink(this.socketPath).catch(() => {});
      throw error;
    }
  }

  handleSocket(socket) {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(this.requestTimeoutMs);
    const controller = new AbortController();
    let buffer = "";
    let accepted = false;
    let finished = false;
    const abort = () => {
      if (!finished && !controller.signal.aborted) controller.abort();
    };
    const close = () => {
      this.sockets.delete(socket);
      if (!socket.destroyed) socket.destroy();
    };
    const finish = (operation) => {
      if (finished) return;
      finished = true;
      void operation().finally(close);
    };
    socket.on("close", () => {
      abort();
      this.sockets.delete(socket);
    });
    socket.on("error", () => {
      abort();
      close();
    });
    socket.on("timeout", () => {
      abort();
      finish(() => this.respond(socket, {
        version: 2,
        ok: false,
        error: {
          code: "IMAGE_TOOL_TIMEOUT",
          message: "图片供应商工具调用超时",
          status: 504,
          retryable: false,
        },
      }));
    });
    socket.on("data", (chunk) => {
      if (accepted || finished) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT_BYTES) {
        accepted = true;
        finish(() => this.respond(socket, {
          version: 2,
          ok: false,
          error: {
            code: "IMAGE_TOOL_REQUEST_TOO_LARGE",
            message: "图片工具请求过大",
            status: 413,
            retryable: false,
          },
        }));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      accepted = true;
      // The framing timeout protects an idle local client before it submits a
      // request. Once admitted, queue wait and execution are governed by the
      // frozen administrator settings and the Worker cgroup timeout.
      socket.setTimeout(0);
      const line = buffer.slice(0, newline).trim();
      const version = requestVersion(line);
      void this.execute(line, { signal: controller.signal })
        .then((result) => finish(() => this.respond(socket, version === 2
          ? { version: 2, ok: true, result }
          : { ok: true, result })))
        .catch((error) => finish(() => this.respond(socket, errorResponse(error, version))));
    });
  }

  async execute(line, { signal = null } = {}) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error("图片工具请求不是有效 JSON");
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw protocolError("INVALID_IMAGE_TOOL_REQUEST", "图片工具请求无效", 400);
    }
    if (request.version === 1 && request.action === "generate") {
      if (!this.generate) {
        throw protocolError("IMAGE_OPERATION_UNAVAILABLE", "当前图片服务不支持旧版生成协议", 409);
      }
      return this.generate({
        prompt: request.prompt,
        project: request.project,
        outputPath: request.outputPath,
      }, { signal });
    }
    if (request.version === 2 && request.action === "execute") {
      let capabilities = null;
      if (this.capabilities) {
        try {
          capabilities = await this.capabilities();
        } catch {
          capabilities = null;
        }
      }
      const input = normalizeV2Request(request, capabilities);
      if (this.executeV2) return this.executeV2(input, { signal });
      throw protocolError("IMAGE_OPERATION_UNAVAILABLE", "当前图片供应商未启用这个操作", 409);
    }
    if (request.version === 2 && request.action === "capabilities") {
      if (Object.keys(request).some((key) => !["version", "action"].includes(key))) {
        throw protocolError("INVALID_IMAGE_TOOL_REQUEST", "图片能力请求包含无效参数", 400);
      }
      if (!this.capabilities) {
        throw protocolError("IMAGE_CAPABILITIES_UNAVAILABLE", "当前图片供应商没有能力描述", 409);
      }
      return this.capabilities();
    }
    throw protocolError("INVALID_IMAGE_TOOL_REQUEST", "图片工具请求无效", 400);
  }

  async respond(socket, value) {
    if (socket.destroyed || !socket.writable) return;
    const payload = `${JSON.stringify(value)}\n`;
    await new Promise((resolve) => socket.end(payload, resolve));
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    }
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function boundedErrorMessage(error) {
  const message = String(error?.message || "图片生成失败").trim();
  return (message || "图片生成失败").slice(0, 2_000);
}

function requestVersion(line) {
  try {
    return JSON.parse(line)?.version === 2 ? 2 : 1;
  } catch {
    return 1;
  }
}

function errorResponse(error, version) {
  if (version !== 2) return { ok: false, error: boundedErrorMessage(error) };
  const status = boundedInteger(error?.statusCode ?? error?.status, 400, 599);
  const requestId = boundedOptionalString(error?.requestId ?? error?.providerRequestId, 200);
  const type = boundedIdentifier(error?.type, 100);
  const providerStatusCode = boundedInteger(error?.providerStatusCode, 400, 599);
  const moderationDetails = sanitizeImageErrorDetails(error?.moderationDetails);
  const partialOutputs = sanitizeImagePartialOutputs(error?.partialOutputs);
  const rollbackFailures = sanitizeImageRollbackFailures(error?.rollbackFailures);
  const diagnostics = sanitizeImageErrorDiagnostics(error);
  return {
    version: 2,
    ok: false,
    error: {
      code: normalizeErrorCode(error?.code),
      ...(type ? { type } : {}),
      message: boundedErrorMessage(error),
      ...(status ? { status } : {}),
      ...(requestId ? { requestId } : {}),
      ...(providerStatusCode ? { providerStatusCode } : {}),
      ...(moderationDetails ? { moderationDetails } : {}),
      ...(partialOutputs.length ? { partialOutputs } : {}),
      ...(rollbackFailures.length ? { rollbackFailures } : {}),
      ...diagnostics,
      retryable: error?.retryable === true,
    },
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

function normalizeV2Request(request, capabilities = null) {
  const operation = String(request.operation || "");
  if (!["generate", "edit", "outpaint"].includes(operation)) {
    throw protocolError("INVALID_IMAGE_OPERATION", "不支持的图片操作", 400);
  }
  for (const key of Object.keys(request)) {
    if (!V2_OPERATION_KEYS[operation].has(key)) {
      throw protocolError("INVALID_IMAGE_TOOL_REQUEST", `图片工具不接受参数 ${key}`, 400);
    }
  }
  assertAbsoluteProjectPath(request.project);
  assertBoundedString(request.prompt, "图片描述", 1, MAX_IMAGE_PROMPT_CHARACTERS);
  assertOptionalRelativePath(request.outputPath, "图片输出路径");
  const requestMode = ["managed", "partial", "passthrough"].includes(capabilities?.requestMode)
    ? capabilities.requestMode
    : "managed";
  validateV2Controls(request, requestMode);
  try {
    normalizeImageProviderParameters(request.providerParameters);
  } catch (error) {
    throw protocolError("INVALID_IMAGE_PROVIDER_PARAMETERS", error.message, 400);
  }
  if (requestMode === "managed" && Object.keys(request.providerParameters || {}).length) {
    throw protocolError("INVALID_IMAGE_PROVIDER_PARAMETERS", "标准管理模式不接受供应商原生参数", 400);
  }

  if (operation === "generate") {
    if (request.sourcePaths !== undefined || request.sourcePath !== undefined || request.maskPath !== undefined || request.expand !== undefined) {
      throw protocolError("INVALID_IMAGE_TOOL_REQUEST", "生成操作不能包含源图片或扩图参数", 400);
    }
  } else if (operation === "edit") {
    if (!Array.isArray(request.sourcePaths) || request.sourcePaths.length < 1 || request.sourcePaths.length > 16) {
      throw protocolError("INVALID_IMAGE_SOURCE", "编辑操作需要 1-16 个工程内源图片路径", 400);
    }
    for (const sourcePath of request.sourcePaths) assertRelativePath(sourcePath, "源图片路径");
    assertOptionalRelativePath(request.maskPath, "蒙版路径");
    optionalEnum(request.maskMode, ["strict", "soft"], "蒙版模式");
    optionalInteger(request.maskFeather, 0, 128, "蒙版羽化像素");
    if (!request.maskPath && (request.maskMode !== undefined || request.maskFeather !== undefined)) {
      throw protocolError("INVALID_IMAGE_MASK", "蒙版模式和羽化参数必须同时指定蒙版图片", 400);
    }
    if (request.maskFeather !== undefined && request.maskMode === "soft") {
      throw protocolError("INVALID_IMAGE_MASK", "软蒙版模式不接受服务端羽化参数", 400);
    }
    if (request.sourcePath !== undefined || request.expand !== undefined) {
      throw protocolError("INVALID_IMAGE_TOOL_REQUEST", "编辑操作包含了无效参数", 400);
    }
  } else {
    assertRelativePath(request.sourcePath, "扩图源图片路径");
    if (request.sourcePaths !== undefined || request.maskPath !== undefined) {
      throw protocolError("INVALID_IMAGE_TOOL_REQUEST", "扩图操作包含了无效参数", 400);
    }
    normalizeExpansion(request.expand);
    optionalEnum(request.preserveSource, ["exact", "seamless"], "原图保留模式");
    optionalInteger(request.blendMargin, 1, 512, "无缝扩图过渡宽度");
    optionalEnum(
      request.alignmentPolicy,
      ["reject", "pad-and-crop", "rescale-and-crop"],
      "扩图尺寸对齐策略",
    );
    if (request.blendMargin !== undefined && request.preserveSource !== "seamless") {
      throw protocolError("INVALID_OUTPAINT", "只有无缝扩图模式可以指定过渡宽度", 400);
    }
  }
  const { version: _version, action: _action, ...input } = request;
  return structuredClone(input, { transfer: [] });
}

function validateV2Controls(request, requestMode = "managed") {
  if (requestMode === "managed") {
    if (request.size !== undefined && !/^(?:auto|[1-9]\d{0,3}x[1-9]\d{0,3})$/.test(request.size)) {
      throw protocolError("INVALID_IMAGE_SIZE", "图片尺寸必须是 auto 或 WIDTHxHEIGHT", 400);
    }
    optionalEnum(request.quality, ["auto", "low", "medium", "high"], "图片质量");
    optionalEnum(request.outputFormat, ["png", "jpeg", "webp"], "输出格式");
    optionalInteger(request.outputCompression, 0, 100, "输出压缩率");
    optionalEnum(request.background, ["auto", "opaque"], "图片背景");
    optionalEnum(request.moderation, ["auto", "low"], "审核档位");
    optionalInteger(request.n, 1, 10, "输出数量");
    return;
  }
  optionalProviderString(request.size, "图片尺寸");
  optionalProviderString(request.quality, "图片质量");
  optionalProviderString(request.outputFormat, "输出格式");
  optionalProviderInteger(request.outputCompression, "输出压缩率");
  optionalProviderString(request.background, "图片背景");
  optionalProviderString(request.moderation, "审核档位");
  optionalProviderString(request.inputFidelity, "输入保真度");
  optionalInteger(request.n, 1, 100, "输出数量");
}

function optionalProviderString(value, label) {
  if (value !== undefined && (typeof value !== "string" || value.length > 256 || !value.trim())) {
    throw protocolError("INVALID_IMAGE_TOOL_REQUEST", `${label}格式无效`, 400);
  }
}

function optionalProviderInteger(value, label) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw protocolError("INVALID_IMAGE_TOOL_REQUEST", `${label}格式无效`, 400);
  }
}

function assertAbsoluteProjectPath(value) {
  assertBoundedString(value, "工程路径", 1, 4_096);
  if (!path.isAbsolute(value) || /[\u0000\r\n]/.test(value)) {
    throw protocolError("INVALID_PROJECT_PATH", "工程路径必须是绝对路径", 400);
  }
}

function assertOptionalRelativePath(value, label) {
  if (value !== undefined) assertRelativePath(value, label);
}

function assertRelativePath(value, label) {
  assertBoundedString(value, label, 1, 1_024);
  if (
    value.includes("\\")
    || /[\u0000\r\n]/.test(value)
    || path.posix.isAbsolute(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) throw protocolError("INVALID_PROJECT_FILE_PATH", `${label}必须是工程内相对路径`, 400);
  const segments = value.replace(/^\.\//, "").split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw protocolError("INVALID_PROJECT_FILE_PATH", `${label}必须是工程内相对路径`, 400);
  }
}

function normalizeExpansion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("INVALID_OUTPAINT_EXPANSION", "扩图必须指定四边扩展像素", 400);
  }
  const sides = ["top", "right", "bottom", "left"];
  if (Object.keys(value).some((key) => !sides.includes(key))) {
    throw protocolError("INVALID_OUTPAINT_EXPANSION", "扩图参数只能包含四边扩展像素", 400);
  }
  let total = 0;
  for (const side of sides) {
    const pixels = value[side];
    if (!Number.isInteger(pixels) || pixels < 0 || pixels > 3_840) {
      throw protocolError("INVALID_OUTPAINT_EXPANSION", "扩图边距必须是 0-3840 的整数", 400);
    }
    total += pixels;
  }
  if (total === 0) throw protocolError("INVALID_OUTPAINT_EXPANSION", "至少需要扩展一侧", 400);
}

function assertBoundedString(value, label, minimum, maximum) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw protocolError("INVALID_IMAGE_TOOL_REQUEST", `${label}长度无效`, 400);
  }
}

function optionalEnum(value, allowed, label) {
  if (value !== undefined && !allowed.includes(value)) {
    throw protocolError("INVALID_IMAGE_TOOL_REQUEST", `${label}无效`, 400);
  }
}

function optionalInteger(value, minimum, maximum, label) {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
    throw protocolError("INVALID_IMAGE_TOOL_REQUEST", `${label}必须是 ${minimum}-${maximum} 的整数`, 400);
  }
}

function protocolError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeErrorCode(value) {
  const code = String(value || "IMAGE_TOOL_FAILED").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "IMAGE_TOOL_FAILED";
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function boundedOptionalString(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maximum) : null;
}

function boundedIdentifier(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function sanitizeImageErrorDiagnostics(error) {
  const output = {};
  for (const field of ["stage", "operation", "reason"]) {
    const value = boundedIdentifier(error?.[field], 100);
    if (value) output[field] = value;
  }
  const model = boundedOptionalString(error?.model, 200);
  if (model && !/[\u0000-\u001f\u007f]/u.test(model)) output.model = model;
  for (const field of ["requestedSize", "providerSize", "sourceSize"]) {
    const value = boundedOptionalString(error?.[field], 32);
    if (value && /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value)) output[field] = value;
  }
  if (["strict", "soft"].includes(error?.maskMode)) output.maskMode = error.maskMode;
  if (["exact", "seamless"].includes(error?.preserveSource)) output.preserveSource = error.preserveSource;
  if (["reject", "pad-and-crop", "rescale-and-crop"].includes(error?.alignmentPolicy)) {
    output.alignmentPolicy = error.alignmentPolicy;
  }
  if (typeof error?.customSize === "boolean") output.customSize = error.customSize;
  if (Array.isArray(error?.supportedSizes)) {
    output.supportedSizes = [...new Set(error.supportedSizes
      .map((value) => boundedOptionalString(value, 32))
      .filter((value) => /^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/u.test(value || "")))]
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
